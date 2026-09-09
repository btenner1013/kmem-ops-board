import {
  HOST_HEALTH_RANGES,
  buildHostHealthTimeline,
  calculateHostHealthMetrics,
  createHostHealthTimeDomain,
  deriveHostHealthCurrent,
  formatHostHealthDuration,
  formatHostHealthTime,
  getHostHealthRange,
  normalizeHostHealthHistory,
  panHostHealthTimeDomain,
  resetHostHealthTimeDomain,
  selectHostHealthTicks,
  zoomHostHealthTimeDomain,
} from "./host-health-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_RANGE = "24h";
const RANGE_KEYS = new Set(HOST_HEALTH_RANGES.map((range) => range.key));
const TIME_BASES = new Set(["Z", "LOCAL"]);
const HEALTH_ICONS = Object.freeze({
  HEALTHY: "🟢", CONTINUOUS: "🟢", DELAYED: "🟡", STALE: "🟡", GAP: "🔴", ERROR: "🔴", UNAVAILABLE: "🔴", UNKNOWN: "⚪",
});
const TRACK_STATE_LABELS = Object.freeze({
  HEALTHY: "HEALTHY", CONTINUOUS: "CONTINUOUS", DELAYED: "DELAYED", STALE: "STALE", GAP: "GAP", ERROR: "ERROR", UNAVAILABLE: "UNAVAILABLE",
  PRIMARY: "PRIMARY", BACKUP: "BACKUP", UNKNOWN: "UNKNOWN",
});

function clear(node) {
  while (node?.firstChild) node.removeChild(node.firstChild);
}

function appendText(doc, parent, tag, text, className = "") {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function svgNode(doc, tag, attrs = {}, text = null) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text !== null) node.textContent = text;
  return node;
}

function currentNowMs(view) {
  const boardNow = Number(view?.getBoardNowMs?.());
  return Number.isFinite(boardNow) ? boardNow : Date.now();
}

function safeAge(minutes) {
  return Number.isFinite(minutes) ? `${Math.floor(minutes)} MIN AGO` : "AGE UNKNOWN";
}

function readableTelemetry(value, fallback = "UNKNOWN") {
  const text = String(value || "").trim();
  return text ? text.replaceAll("_", " ") : fallback;
}

export function hostHealthStatePresentation(state) {
  const normalized = String(state || "UNKNOWN").toUpperCase();
  return {
    state: TRACK_STATE_LABELS[normalized] || normalized,
    icon: HEALTH_ICONS[normalized] || "⚪",
    className: `host-health-state-${normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  };
}

export function hostHealthChartInteractionMode(domain) {
  if (!domain?.ok) return "disabled";
  return domain.isFullRange ? "native-scroll" : "domain-pan";
}

export function applyHostHealthDialogState({ overlay, body, focusTarget, returnFocus }, open, schedule = (callback) => callback()) {
  if (!overlay || !body) return false;
  overlay.hidden = !open;
  overlay.setAttribute("aria-hidden", open ? "false" : "true");
  body.classList.toggle("host-health-dialog-open", open);
  if (open) schedule(() => focusTarget?.focus?.());
  else returnFocus?.focus?.();
  return true;
}

async function fetchJson(fetchImpl, url) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");
  const response = await fetchImpl(url, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || "ERROR"}`);
  return response.json();
}

/** Three independent reads: a missing archive never suppresses live cards. */
export function createHostHealthLoader({ fetchImpl = globalThis.fetch, baseUrl = globalThis.location?.href || "http://localhost/" } = {}) {
  const urls = {
    history: new URL("./host_health_history.json", baseUrl),
    hostStatus: new URL("./host_status.json", baseUrl),
    lease: new URL("./updater_lease.json", baseUrl),
  };
  return {
    async load() {
      const nonce = String(Date.now());
      for (const url of Object.values(urls)) url.searchParams.set("_", nonce);
      const [historyResult, hostResult, leaseResult] = await Promise.allSettled([
        fetchJson(fetchImpl, urls.history.href),
        fetchJson(fetchImpl, urls.hostStatus.href),
        fetchJson(fetchImpl, urls.lease.href),
      ]);
      let history = null;
      let historyError = null;
      if (historyResult.status === "fulfilled") {
        try {
          const normalized = normalizeHostHealthHistory(historyResult.value);
          if (normalized.ok) history = normalized.value;
          else historyError = new Error(normalized.error.message);
        } catch (error) {
          historyError = error;
        }
      } else historyError = historyResult.reason;
      return {
        history,
        historyError,
        hostStatus: hostResult.status === "fulfilled" ? hostResult.value : null,
        hostStatusError: hostResult.status === "rejected" ? hostResult.reason : null,
        lease: leaseResult.status === "fulfilled" ? leaseResult.value : null,
        leaseError: leaseResult.status === "rejected" ? leaseResult.reason : null,
      };
    },
  };
}

function renderValueRow(doc, parent, label, value, valueClass = "") {
  const row = doc.createElement("div");
  row.className = "host-health-value-row";
  appendText(doc, row, "span", label, "host-health-value-label");
  appendText(doc, row, "span", value || "UNKNOWN", `host-health-value ${valueClass}`.trim());
  parent.appendChild(row);
}

function renderStateHeading(doc, parent, label, state) {
  const presentation = hostHealthStatePresentation(state);
  const heading = doc.createElement("div");
  heading.className = "host-health-card-heading";
  appendText(doc, heading, "strong", label, "host-health-card-title");
  appendText(doc, heading, "span", `${presentation.icon} ${presentation.state}`, `host-health-state ${presentation.className}`);
  parent.appendChild(heading);
}

function renderPublisherCard(doc, parent, current, basis) {
  clear(parent);
  parent.className = `host-health-card host-health-publisher-card host-health-publisher-${current.publisher.toLowerCase()}`;
  appendText(doc, parent, "span", "ACTIVE PUBLISHER", "host-health-eyebrow");
  appendText(doc, parent, "strong", current.publisher, "host-health-publisher-name");
  renderValueRow(doc, parent, "SINCE", current.publisherSinceUtc ? formatHostHealthTime(current.publisherSinceUtc, basis) : "UNKNOWN");
  renderValueRow(doc, parent, "LAST SUCCESSFUL BOARD PUBLISH", current.lastSuccessfulPublishUtc
    ? `${formatHostHealthTime(current.lastSuccessfulPublishUtc, basis)} · ${safeAge(current.publishAgeMinutes)}` : "UNKNOWN");
  renderValueRow(doc, parent, "LAST FAILOVER / HANDOFF", current.latestPublisherTransition
    ? `${current.latestPublisherTransition.eventType.replaceAll("_", " ")} · ${formatHostHealthTime(current.latestPublisherTransition.timestampMs, basis)}`
    : "NO RECORDED EVENT");
  if (current.takeoverReason) renderValueRow(doc, parent,
    current.publisher === "BACKUP" ? "OBSERVED TAKEOVER REASON" : "PUBLISHER BASIS", readableTelemetry(current.takeoverReason));
  if (current.publisher === "BACKUP" && current.takeoverReason && !current.rootCauseKnown) {
    renderValueRow(doc, parent, "MACHINE ROOT CAUSE", "NOT ESTABLISHED");
  }
}

function renderDeliveryCard(doc, parent, current, basis) {
  clear(parent);
  parent.className = "host-health-card host-health-delivery-card";
  renderStateHeading(doc, parent, "BOARD DELIVERY", current.boardDelivery);
  renderValueRow(doc, parent, "CURRENT PUBLISHER", current.publisher);
  renderValueRow(doc, parent, "LAST PUBLISH", current.lastSuccessfulPublishUtc
    ? `${formatHostHealthTime(current.lastSuccessfulPublishUtc, basis)} · ${safeAge(current.publishAgeMinutes)}` : "UNKNOWN");
  if (current.boardDeliveryReason) renderValueRow(doc, parent, "REASON", readableTelemetry(current.boardDeliveryReason));
}

function renderHostCard(doc, parent, host, basis) {
  clear(parent);
  parent.className = `host-health-card host-health-host-card host-health-host-${host.role.toLowerCase()}`;
  renderStateHeading(doc, parent, host.role, host.health);
  appendText(doc, parent, "span", host.roleState, "host-health-role-state");
  renderValueRow(doc, parent, "LAST HEARTBEAT", host.heartbeatUtc
    ? `${formatHostHealthTime(host.heartbeatUtc, basis)} · ${safeAge(host.heartbeatAgeMinutes)}` : "UNKNOWN");
  renderValueRow(doc, parent, "LAST SUCCESSFUL UPDATE", host.lastSuccessfulUpdateUtc ? formatHostHealthTime(host.lastSuccessfulUpdateUtc, basis) : "UNKNOWN");
  renderValueRow(doc, parent, "LAST SUCCESSFUL PUSH", host.lastSuccessfulPushUtc ? formatHostHealthTime(host.lastSuccessfulPushUtc, basis) : "UNKNOWN");
  renderValueRow(doc, parent, "SOURCE SHA", host.sourceSha ? host.sourceSha.slice(0, 12) : "UNKNOWN", "host-health-mono");
  renderValueRow(doc, parent, "TASK", host.taskStatus || "UNKNOWN");
  renderValueRow(doc, parent, "HEALTH REASON", readableTelemetry(host.reason, host.observed ? "NO REASON REPORTED" : "HOST NOT OBSERVED"));
  renderValueRow(doc, parent, "LAST ERROR", readableTelemetry(host.lastError, "NONE REPORTED"));
}

function renderLeaseCard(doc, parent, current, basis) {
  clear(parent);
  const lease = current.lease;
  renderStateHeading(doc, parent, "LEASE", lease.state);
  const activeOwner = lease.activeOwner === null
    ? (["RELEASED", "EXPIRED"].includes(lease.state) ? "NONE (LEASE RELEASED)" : "NONE")
    : lease.activeOwner || lease.owner;
  renderValueRow(doc, parent, "ACTIVE OWNER", activeOwner);
  renderValueRow(doc, parent, "LAST OWNER", lease.lastOwner || "UNKNOWN");
  renderValueRow(doc, parent, "ACQUIRED", lease.acquiredUtc ? formatHostHealthTime(lease.acquiredUtc, basis) : "UNKNOWN");
  renderValueRow(doc, parent, "EXPIRES", lease.expiresUtc ? formatHostHealthTime(lease.expiresUtc, basis) : "UNKNOWN");
  if (lease.releasedUtc) renderValueRow(doc, parent, "RELEASED", formatHostHealthTime(lease.releasedUtc, basis));
}

function xForTime(ms, range, plotX, plotWidth) {
  return plotX + ((ms - range.startMs) / range.durationMs) * plotWidth;
}

export const HOST_HEALTH_EVENT_LOG_LIMIT = 200;
const HOST_HEALTH_DENSE_INTERVAL_LIMIT = 600;
const HOST_HEALTH_DENSE_EVENT_LIMIT = 200;

export function selectHostHealthEventLogItems(events, limit = HOST_HEALTH_EVENT_LOG_LIMIT) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safeLimit = Math.max(1, Math.floor(Number(limit) || HOST_HEALTH_EVENT_LOG_LIMIT));
  const sorted = [...safeEvents].sort((left, right) => right.timestampMs - left.timestampMs);
  return { items: sorted.slice(0, safeLimit), total: sorted.length, limited: sorted.length > safeLimit };
}

function tooltipLines(item, basis) {
  if (item.eventType) return [
    ["EVENT", item.eventType],
    ["HOST", item.host],
    ["UTC", formatHostHealthTime(item.timestampMs, "Z")],
    ["LOCAL", formatHostHealthTime(item.timestampMs, "LOCAL")],
    ["REASON", item.reason],
    ["SOURCE TIME", item.sourceTimestampType],
    ["TIMESTAMP CERTAINTY", item.timestampCertainty],
    ["PUBLISHER", item.publisher],
    ["LEASE OWNER", item.leaseOwner],
    ["SOURCE SHA", item.sourceSha || "NOT RECORDED"],
  ];
  return [
    ["STATE", item.state],
    ["HOST / TRACK", item.host !== "UNKNOWN" ? item.host : item.track],
    ["START UTC", formatHostHealthTime(item.startMs, "Z")],
    ["END UTC", formatHostHealthTime(item.endMs, "Z")],
    ["START LOCAL", formatHostHealthTime(item.startMs, "LOCAL")],
    ["END LOCAL", formatHostHealthTime(item.endMs, "LOCAL")],
    ["DURATION", formatHostHealthDuration(item.endMs - item.startMs)],
    ["REASON", item.reason],
    ["SOURCE TIME", item.sourceTimestampType],
    ["TIMESTAMP CERTAINTY", item.timestampCertainty],
    ["PUBLISHER", item.publisher],
    ["LEASE OWNER", item.leaseOwner],
    ["SOURCE SHA", item.sourceSha || "NOT RECORDED"],
    ["DISPLAY BASIS", basis],
  ];
}

function showTooltip(doc, tooltip, item, basis, event) {
  if (!tooltip) return;
  clear(tooltip);
  for (const [label, value] of tooltipLines(item, basis)) renderValueRow(doc, tooltip, label, value);
  tooltip.hidden = false;
  const host = tooltip.parentNode?.getBoundingClientRect?.();
  if (host && Number.isFinite(event?.clientX)) {
    const left = Math.max(8, Math.min(host.width - Math.min(300, host.width) - 8, event.clientX - host.left + 12));
    const top = Math.max(8, Math.min(host.height - 150, (event.clientY || host.top) - host.top + 12));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
}

const SUMMARY_STATE_ORDER = Object.freeze({
  PRIMARY_HEALTH: ["HEALTHY", "DELAYED", "STALE", "ERROR", "UNAVAILABLE", "UNKNOWN"],
  BACKUP_HEALTH: ["HEALTHY", "DELAYED", "STALE", "ERROR", "UNAVAILABLE", "UNKNOWN"],
  PUBLISHER: ["PRIMARY", "BACKUP", "UNKNOWN"],
  BOARD_DELIVERY: ["CONTINUOUS", "DELAYED", "GAP", "UNKNOWN"],
});

function summaryAriaLabel(summary, track) {
  const values = summary.tracks?.[track]?.durationsSeconds || {};
  const states = (SUMMARY_STATE_ORDER[track] || Object.keys(values))
    .filter((state) => Number(values[state]) > 0)
    .map((state) => `${state.replaceAll("_", " ")} ${formatHostHealthDuration(Number(values[state]) * 1000)}`);
  return `${summary.dateUtc} UTC daily aggregate, ${track.replaceAll("_", " ")}: ${states.join(", ") || "NO KNOWN COVERAGE"}. Intra-day order is not retained.`;
}

function renderDailySummaryPaths(doc, svg, timeline, track, y, plotX, plotWidth) {
  const summaries = Array.isArray(timeline.dailySummaries) ? timeline.dailySummaries : [];
  if (!summaries.length) return;
  const states = SUMMARY_STATE_ORDER[track.key] || [];
  const paths = new Map(states.map((state) => [state, []]));
  for (const summary of summaries) {
    const values = summary.tracks?.[track.key]?.durationsSeconds || {};
    const denominator = Math.max(1, summary.coverageSeconds,
      Object.values(values).reduce((sum, seconds) => sum + Number(seconds || 0), 0));
    const x = xForTime(summary.coverageStartMs ?? summary.dayStartMs, timeline.range, plotX, plotWidth);
    const endX = xForTime(summary.coverageEndMs ?? summary.dayEndMs, timeline.range, plotX, plotWidth);
    let topOffset = 0;
    for (const state of states) {
      const seconds = Math.max(0, Number(values[state]) || 0);
      if (!seconds) continue;
      const height = 20 * seconds / denominator;
      const topY = y + 6 + topOffset;
      paths.get(state).push(`M ${x} ${topY} H ${Math.max(x + 0.5, endX)} V ${topY + height} H ${x} Z`);
      topOffset += height;
    }
  }
  for (const [state, commands] of paths) {
    if (!commands.length) continue;
    svg.appendChild(svgNode(doc, "path", {
      class: `host-health-summary-segment host-health-interval-${state.toLowerCase()}`,
      d: commands.join(" "), "aria-hidden": "true",
    }));
  }
  // One semantic group per track keeps a 365-day archive accessible without
  // creating hundreds of keyboard stops. Descendants disclose exact totals.
  const accessible = svgNode(doc, "g", {
    class: "host-health-summary-accessibility", role: "img",
    "aria-label": `${track.label} has ${summaries.length} UTC daily aggregate summaries; intra-day order is not retained`,
  });
  for (const summary of summaries) accessible.appendChild(svgNode(doc, "desc", {}, summaryAriaLabel(summary, track.key)));
  svg.appendChild(accessible);
}

/** Render the shared four-track timeline using exact proportional UTC geometry. */
export function renderHostHealthChart(doc, container, tooltip, timelineValue, { basis = "Z" } = {}) {
  const timeline = timelineValue?.value || timelineValue;
  clear(container);
  if (tooltip) container.appendChild(tooltip);
  if (!timeline?.range || !Array.isArray(timeline.tracks)) {
    appendText(doc, container, "div", "HOST HEALTH HISTORY UNAVAILABLE", "host-health-empty");
    return null;
  }
  const width = 960;
  const height = 286;
  const plotX = 132;
  const plotWidth = width - plotX - 16;
  const top = 30;
  const trackHeight = 38;
  const intervalCount = timeline.tracks.reduce((sum, track) => sum + track.intervals.length, 0);
  const eventCount = timeline.events.length;
  const denseMode = timeline.range.durationMs > 24 * 60 * 60 * 1000
    && (intervalCount > HOST_HEALTH_DENSE_INTERVAL_LIMIT || eventCount > HOST_HEALTH_DENSE_EVENT_LIMIT);
  const svg = svgNode(doc, "svg", {
    class: "host-health-svg", viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": `Host Health timeline shown in ${basis === "LOCAL" ? "Memphis local time" : "Zulu time"}`,
  });
  const background = svgNode(doc, "rect", { class: "host-health-plot-background", x: plotX, y: top - 8, width: plotWidth, height: trackHeight * 4 + 16 });
  svg.appendChild(background);

  const ticks = selectHostHealthTicks(timeline.range, 7);
  for (const tick of ticks) {
    const x = xForTime(tick, timeline.range, plotX, plotWidth);
    svg.appendChild(svgNode(doc, "line", { class: "host-health-grid-line", x1: x, x2: x, y1: top - 8, y2: top + trackHeight * 4 + 8 }));
    svg.appendChild(svgNode(doc, "text", { class: "host-health-tick", x, y: top + trackHeight * 4 + 30, "text-anchor": "middle" }, formatHostHealthTime(tick, basis, { compact: true })));
  }

  timeline.tracks.forEach((track, trackIndex) => {
    const y = top + trackIndex * trackHeight;
    svg.appendChild(svgNode(doc, "text", { class: "host-health-track-label", x: plotX - 10, y: y + 19, "text-anchor": "end" }, track.label));
    svg.appendChild(svgNode(doc, "line", { class: "host-health-track-baseline", x1: plotX, x2: plotX + plotWidth, y1: y + 26, y2: y + 26 }));
    renderDailySummaryPaths(doc, svg, timeline, track, y, plotX, plotWidth);
    if (denseMode) {
      const intervalsByState = new Map();
      for (const interval of track.intervals) {
        const entries = intervalsByState.get(interval.state) || [];
        entries.push(interval);
        intervalsByState.set(interval.state, entries);
      }
      for (const [state, stateIntervals] of intervalsByState) {
        const d = stateIntervals.map((interval) => {
          const x = xForTime(interval.startMs, timeline.range, plotX, plotWidth);
          const endX = xForTime(interval.endMs, timeline.range, plotX, plotWidth);
          return `M ${x} ${y + 6} H ${Math.max(x + 1, endX)} V ${y + 26} H ${x} Z`;
        }).join(" ");
        svg.appendChild(svgNode(doc, "path", {
          class: `host-health-interval host-health-interval-${state.toLowerCase()} host-health-interval-density`,
          d, "aria-hidden": "true",
        }));
      }
      return;
    }
    for (const interval of track.intervals) {
      const x = xForTime(interval.startMs, timeline.range, plotX, plotWidth);
      const endX = xForTime(interval.endMs, timeline.range, plotX, plotWidth);
      const rect = svgNode(doc, "rect", {
        class: `host-health-interval host-health-interval-${interval.state.toLowerCase()}`,
        x, y: y + 6, width: Math.max(1, endX - x), height: 20, rx: 3,
        tabindex: "0", role: "img",
        "aria-label": `${track.label} ${interval.state}, ${formatHostHealthTime(interval.startMs, basis)} through ${formatHostHealthTime(interval.endMs, basis)}`,
      });
      const reveal = (event) => showTooltip(doc, tooltip, interval, basis, event);
      rect.addEventListener("pointerenter", reveal);
      rect.addEventListener("pointerdown", reveal);
      rect.addEventListener("focus", reveal);
      rect.addEventListener("pointerleave", () => { if (tooltip) tooltip.hidden = true; });
      rect.addEventListener("blur", () => { if (tooltip) tooltip.hidden = true; });
      svg.appendChild(rect);
    }
  });

  for (const eventItem of denseMode ? [] : timeline.events) {
    const x = xForTime(eventItem.timestampMs, timeline.range, plotX, plotWidth);
    const group = svgNode(doc, "g", {
      class: "host-health-event", tabindex: "0", role: "img",
      "aria-label": `${eventItem.eventType} ${formatHostHealthTime(eventItem.timestampMs, basis)}`,
    });
    group.appendChild(svgNode(doc, "line", { x1: x, x2: x, y1: top - 13, y2: top + trackHeight * 4 + 8 }));
    group.appendChild(svgNode(doc, "path", { d: `M ${x - 5} ${top - 14} L ${x + 5} ${top - 14} L ${x} ${top - 4} Z` }));
    const reveal = (event) => showTooltip(doc, tooltip, eventItem, basis, event);
    group.addEventListener("pointerenter", reveal);
    group.addEventListener("pointerdown", reveal);
    group.addEventListener("focus", reveal);
    group.addEventListener("pointerleave", () => { if (tooltip) tooltip.hidden = true; });
    group.addEventListener("blur", () => { if (tooltip) tooltip.hidden = true; });
    svg.appendChild(group);
  }
  container.appendChild(svg);
  if (denseMode) {
    appendText(doc, container, "p",
      `TIMELINE DENSITY MODE · ${intervalCount} INTERVALS · ${eventCount} EVENT MARKERS SUPPRESSED · METRICS USE ALL RETAINED DATA`,
      "host-health-density-note");
  }
  if (timeline.dailySummaries?.length) {
    appendText(doc, container, "p",
      `DAILY AGGREGATE HISTORY · ${timeline.dailySummaries.length} UTC DAY${timeline.dailySummaries.length === 1 ? "" : "S"} · STACKED COLORS SHOW DAILY STATE DURATION, NOT INTRA-DAY ORDER`,
      "host-health-summary-note");
  }
  if (timeline.summaryBoundaryDaysExcluded) {
    appendText(doc, container, "p",
      `${timeline.summaryBoundaryDaysExcluded} PARTIAL UTC SUMMARY DAY${timeline.summaryBoundaryDaysExcluded === 1 ? "" : "S"} OMITTED AT THE SELECTED RANGE EDGE · DAILY TOTALS ARE NOT PRORATED`,
      "host-health-summary-note host-health-warning-copy");
  }
  if (timeline.summaryOverlapDaysExcluded) {
    appendText(doc, container, "p",
      `${timeline.summaryOverlapDaysExcluded} MALFORMED OVERLAPPING SUMMARY DAY${timeline.summaryOverlapDaysExcluded === 1 ? "" : "S"} OMITTED`,
      "host-health-summary-note host-health-warning-copy");
  }
  if (timeline.retentionBoundaryGap) {
    appendText(doc, container, "p",
      `RETENTION-EDGE COVERAGE UNAVAILABLE · ${formatHostHealthTime(timeline.retentionBoundaryGap.startMs, basis)}–${formatHostHealthTime(timeline.retentionBoundaryGap.endMs, basis)} · ${timeline.retentionBoundaryGap.reason.replaceAll("_", " ")}`,
      "host-health-summary-note host-health-warning-copy");
  }
  return svg;
}

function percentText(metric) {
  return metric?.percent === null || metric?.percent === undefined ? "INSUFFICIENT DATA" : `${metric.percent.toFixed(1)}%`;
}

function renderMetrics(doc, parent, metrics, rangeLabel) {
  clear(parent);
  appendText(doc, parent, "h3", `${rangeLabel} RELIABILITY`, "host-health-section-heading");
  const grid = doc.createElement("div");
  grid.className = "host-health-metrics-grid";
  const items = [
    ["PRIMARY AVAILABILITY", percentText(metrics.primaryAvailability)],
    ["BACKUP AVAILABILITY", percentText(metrics.backupAvailability)],
    ["BOARD PUBLISH COVERAGE", percentText(metrics.boardPublishingCoverage)],
    ["FAILOVERS", String(metrics.failovers)],
    ["SUCCESSFUL HANDOFFS", String(metrics.successfulHandoffs)],
    ["FAILED / INCOMPLETE HANDOFFS", metrics.failedHandoffsKnown ? String(metrics.failedHandoffs) : "NOT MEASURED"],
    ["LONGEST BOARD UPDATE GAP", metrics.longestBoardGapKnown === false
      ? "NOT MEASURED FOR SUMMARIZED DAYS" : formatHostHealthDuration(metrics.longestBoardGapMs)],
    ["TIME RUNNING ON BACKUP", formatHostHealthDuration(metrics.timeRunningOnBackupMs)],
  ];
  for (const [label, value] of items) renderValueRow(doc, grid, label, value);
  parent.appendChild(grid);
  if (metrics.aggregateHistoryUsed) appendText(doc, parent, "p",
    `${metrics.summarizedDays} UTC DAILY SUMMAR${metrics.summarizedDays === 1 ? "Y" : "IES"} INCLUDED · EXACT STATE SECONDS PRESERVED; INTRA-DAY ORDER NOT RETAINED`,
    "host-health-summary-note");
  appendText(doc, parent, "p", metrics.partialHistory
    ? "PARTIAL HISTORY · PERCENTAGES USE KNOWN COVERAGE ONLY"
    : "COMPLETE KNOWN COVERAGE FOR SELECTED RANGE", "host-health-coverage-note");
}

function renderEvents(doc, parent, events, basis) {
  clear(parent);
  const heading = appendText(doc, parent, "h3", "EVENT LOG", "host-health-section-heading");
  heading.id ||= "hostHealthEventHeading";
  if (!events.length) {
    appendText(doc, parent, "p", "NO RECORDED TRANSITIONS IN SELECTED RANGE", "host-health-empty-copy");
    return;
  }
  const selection = selectHostHealthEventLogItems(events);
  if (selection.limited) {
    appendText(doc, parent, "p", `SHOWING NEWEST ${selection.items.length} OF ${selection.total} RETAINED EVENTS`, "host-health-density-note");
  }
  const list = doc.createElement("ol");
  list.className = "host-health-event-list";
  for (const event of selection.items) {
    const item = doc.createElement("li");
    item.className = "host-health-event-item";
    appendText(doc, item, "time", formatHostHealthTime(event.timestampMs, basis), "host-health-event-time").setAttribute("datetime", event.timestampUtc);
    appendText(doc, item, "strong", event.eventType.replaceAll("_", " "), "host-health-event-name");
    appendText(doc, item, "span", readableTelemetry(event.reason), "host-health-event-reason");
    if (event.inferred) appendText(doc, item, "span", "INFERRED / FIRST OBSERVED", "host-health-event-inferred");
    list.appendChild(item);
  }
  parent.appendChild(list);
}

function updateSelectionButtons(buttons, dataKey, selected, activeClass) {
  for (const button of buttons) {
    const active = button.dataset[dataKey] === selected;
    button.classList.toggle(activeClass, active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function focusableElements(panel) {
  return [...panel.querySelectorAll("button:not([disabled]),[href],[tabindex]:not([tabindex='-1'])")].filter((item) => !item.hidden);
}

export function initializeHostHealth(doc = document) {
  const overlay = doc.getElementById("hostHealthOverlay");
  const panel = doc.getElementById("hostHealthPanel");
  const closeButton = doc.getElementById("hostHealthCloseButton");
  const status = doc.getElementById("hostHealthStatus");
  const publisherCard = doc.getElementById("hostHealthActivePublisher");
  const deliveryCard = doc.getElementById("hostHealthBoardDelivery");
  const primaryCard = doc.getElementById("hostHealthPrimary");
  const backupCard = doc.getElementById("hostHealthBackup");
  const leaseCard = doc.getElementById("hostHealthLease");
  const chart = doc.getElementById("hostHealthChart");
  const tooltip = doc.getElementById("hostHealthTooltip");
  const zoomOut = doc.getElementById("hostHealthZoomOut");
  const zoomIn = doc.getElementById("hostHealthZoomIn");
  const zoomReset = doc.getElementById("hostHealthZoomReset");
  const zoomStatus = doc.getElementById("hostHealthZoomStatus");
  const metrics = doc.getElementById("hostHealthMetrics");
  const events = doc.getElementById("hostHealthEvents");
  const archive = doc.getElementById("hostHealthArchive");
  const rangeButtons = [...doc.querySelectorAll("[data-host-health-range]")];
  const timeButtons = [...doc.querySelectorAll("[data-host-health-time]")];
  if (!overlay || !panel || !closeButton || !status || !publisherCard || !deliveryCard || !primaryCard || !backupCard
      || !leaseCard || !chart || !zoomOut || !zoomIn || !zoomReset || !zoomStatus || !metrics || !events || !archive
      || !rangeButtons.length || !timeButtons.length) return null;

  const view = doc.defaultView || window;
  const loader = createHostHealthLoader({ fetchImpl: view.fetch?.bind(view), baseUrl: doc.baseURI });
  let returnFocus = null;
  let activeRange = DEFAULT_RANGE;
  let basis = "Z";
  let loaded = null;
  let masterTimeline = null;
  let timeDomain = null;
  let currentSnapshot = null;
  let pan = null;
  let displayTimer = null;
  let telemetryTimer = null;
  let loadInFlight = null;
  let pendingLoad = null;
  let modalSession = 0;

  function setStatus(state, detail = "") {
    const stateClass = String(state || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    status.className = `host-health-status host-health-status-${stateClass}`;
    status.textContent = detail ? `${state} · ${detail}` : state;
  }

  function updateZoomControls() {
    const ready = Boolean(timeDomain?.ok);
    zoomIn.disabled = !ready || !timeDomain.canZoomIn;
    zoomOut.disabled = !ready || !timeDomain.canZoomOut;
    zoomReset.disabled = !ready || timeDomain.isFullRange;
    const interactionMode = hostHealthChartInteractionMode(timeDomain);
    chart.dataset.hostHealthInteraction = interactionMode;
    chart.classList.toggle("host-health-chart-zoomed", interactionMode === "domain-pan");
    if (interactionMode === "domain-pan") chart.scrollLeft = 0;
    zoomStatus.textContent = !ready || timeDomain.isFullRange ? "FULL RANGE" : formatHostHealthDuration(timeDomain.durationMs) + " WINDOW";
  }

  function renderTimelineViewport() {
    if (!loaded?.history || !timeDomain?.ok) {
      clear(chart);
      if (tooltip) chart.appendChild(tooltip);
      appendText(doc, chart, "div", "HOST HEALTH HISTORY UNAVAILABLE · LIVE STATUS REMAINS AVAILABLE", "host-health-empty");
      updateZoomControls();
      return;
    }
    const timelineResult = buildHostHealthTimeline(loaded.history, {
      startMs: timeDomain.startMs,
      endMs: timeDomain.endMs,
    }, currentNowMs(view), { currentEvidence: currentSnapshot });
    renderHostHealthChart(doc, chart, tooltip, timelineResult, { basis });
    updateZoomControls();
  }

  function render(resetDomain = false) {
    const nowMs = currentNowMs(view);
    const fallbackHistory = loaded?.history || normalizeHostHealthHistory({ schemaVersion: 1 }).value;
    const current = deriveHostHealthCurrent(fallbackHistory, loaded?.hostStatus || {}, loaded?.lease || {}, nowMs);
    currentSnapshot = current;
    renderPublisherCard(doc, publisherCard, current, basis);
    renderDeliveryCard(doc, deliveryCard, current, basis);
    renderHostCard(doc, primaryCard, current.hosts.PRIMARY, basis);
    renderHostCard(doc, backupCard, current.hosts.BACKUP, basis);
    renderLeaseCard(doc, leaseCard, current, basis);

    clear(archive);
    appendText(doc, archive, "strong", "HISTORY AVAILABLE SINCE");
    appendText(doc, archive, "span", loaded?.history?.archiveStartedUtc
      ? formatHostHealthTime(loaded.history.archiveStartedUtc, basis) : "ARCHIVE NOT AVAILABLE");
    if (loaded?.historyError) appendText(doc, archive, "span", "ARCHIVE LOAD FAILED · LIVE STATUS SHOWN", "host-health-warning-copy");

    if (loaded?.history) {
      const masterRange = getHostHealthRange(activeRange, nowMs);
      const masterResult = buildHostHealthTimeline(loaded.history, masterRange, nowMs, { currentEvidence: current });
      masterTimeline = masterResult.ok ? masterResult.value : null;
      if (masterTimeline?.liveEvidenceNewer) appendText(doc, archive, "span",
        `ARCHIVE THROUGH ${formatHostHealthTime(masterTimeline.coverageEndMs, basis)} · CURRENT CARDS USE NEWER LIVE STATUS`,
        "host-health-warning-copy");
      if (resetDomain || !timeDomain?.ok || timeDomain.isFullRange) timeDomain = createHostHealthTimeDomain(masterRange);
      const metricResult = calculateHostHealthMetrics(masterTimeline);
      if (metricResult.ok) renderMetrics(doc, metrics, metricResult.value, masterRange.label);
      else clear(metrics);
      renderEvents(doc, events, masterTimeline?.events || [], basis);
      renderTimelineViewport();
    } else {
      masterTimeline = null;
      timeDomain = null;
      clear(metrics);
      appendText(doc, metrics, "p", "RELIABILITY METRICS REQUIRE THE HISTORY ARCHIVE", "host-health-empty-copy");
      clear(events);
      appendText(doc, events, "p", "EVENT HISTORY UNAVAILABLE", "host-health-empty-copy");
      renderTimelineViewport();
    }
    const failures = [loaded?.hostStatusError && "LIVE HOST", loaded?.leaseError && "LEASE", loaded?.historyError && "HISTORY"].filter(Boolean);
    setStatus(failures.length ? "PARTIAL TELEMETRY" : "HOST HEALTH READY", failures.length ? `${failures.join(" / ")} UNAVAILABLE` : "READ ONLY");
  }

  function retainLastGoodTelemetry(previous, next) {
    if (!previous) return next;
    return {
      history: next.history || previous.history,
      historyError: next.historyError,
      hostStatus: next.hostStatus || previous.hostStatus,
      hostStatusError: next.hostStatusError,
      lease: next.lease || previous.lease,
      leaseError: next.leaseError,
    };
  }

  async function load({ resetDomain = true, announce = true, session = modalSession } = {}) {
    if (loadInFlight) {
      pendingLoad = { resetDomain: pendingLoad?.resetDomain || resetDomain, announce, session };
      return loadInFlight;
    }
    if (announce) setStatus("LOADING", "READ-ONLY TELEMETRY");
    const request = (async () => {
      let next;
      try {
        next = await loader.load();
      } catch (error) {
        // Defensive only: loader normally isolates all three failures itself.
        next = { history: null, historyError: error, hostStatus: null, hostStatusError: error, lease: null, leaseError: error };
      }
      // Closing (or reopening) invalidates an old request. Its late response
      // cannot replace the telemetry for the current modal session.
      if (overlay.hidden || session !== modalSession) return null;
      loaded = retainLastGoodTelemetry(loaded, next);
      render(resetDomain);
      return loaded;
    })();
    loadInFlight = request;
    try {
      return await request;
    } finally {
      if (loadInFlight === request) loadInFlight = null;
      const queued = pendingLoad;
      pendingLoad = null;
      if (queued && !overlay.hidden && queued.session === modalSession) void load(queued);
    }
  }

  function open(opener) {
    modalSession += 1;
    const session = modalSession;
    returnFocus = opener || doc.activeElement;
    applyHostHealthDialogState({ overlay, body: doc.body, focusTarget: closeButton, returnFocus }, true,
      (callback) => (view.requestAnimationFrame || ((next) => next()))(callback));
    if (displayTimer === null && typeof view.setInterval === "function") {
      displayTimer = view.setInterval(() => {
        if (!overlay.hidden && loaded) render(false);
      }, 30_000);
    }
    if (telemetryTimer === null && typeof view.setInterval === "function") {
      telemetryTimer = view.setInterval(() => {
        if (!overlay.hidden) void load({ resetDomain: false, announce: false, session });
      }, 60_000);
    }
    void load({ resetDomain: true, announce: true, session });
  }

  function close() {
    modalSession += 1;
    if (displayTimer !== null && typeof view.clearInterval === "function") view.clearInterval(displayTimer);
    if (telemetryTimer !== null && typeof view.clearInterval === "function") view.clearInterval(telemetryTimer);
    displayTimer = null;
    telemetryTimer = null;
    pendingLoad = null;
    pan = null;
    chart.classList.remove("host-health-panning");
    applyHostHealthDialogState({ overlay, body: doc.body, focusTarget: closeButton, returnFocus }, false);
  }

  function applyDomain(next) {
    if (!next?.ok) return false;
    timeDomain = next;
    if (tooltip) tooltip.hidden = true;
    renderTimelineViewport();
    return true;
  }

  // Toolbar zoom keeps the newest evidence in view. Pointer-wheel zoom still
  // honors the user's exact cursor anchor within the proportional timeline.
  zoomIn.addEventListener("click", () => applyDomain(zoomHostHealthTimeDomain(timeDomain, 2, 1)));
  zoomOut.addEventListener("click", () => applyDomain(zoomHostHealthTimeDomain(timeDomain, 0.5, 1)));
  zoomReset.addEventListener("click", () => applyDomain(resetHostHealthTimeDomain(timeDomain)));
  chart.addEventListener("wheel", (event) => {
    if (!timeDomain?.ok || event.deltaY === 0) return;
    const rect = chart.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5;
    event.preventDefault();
    applyDomain(zoomHostHealthTimeDomain(timeDomain, event.deltaY < 0 ? 1.25 : 0.8, ratio));
  }, { passive: false });
  chart.addEventListener("pointerdown", (event) => {
    if (!timeDomain?.ok || timeDomain.isFullRange || event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    pan = { pointerId: event.pointerId, x: event.clientX, width: chart.getBoundingClientRect().width };
    chart.setPointerCapture?.(event.pointerId);
  });
  chart.addEventListener("pointermove", (event) => {
    if (!pan || pan.pointerId !== event.pointerId || !(pan.width > 0)) return;
    const delta = event.clientX - pan.x;
    if (Math.abs(delta) < 2) return;
    pan.x = event.clientX;
    chart.classList.add("host-health-panning");
    event.preventDefault();
    applyDomain(panHostHealthTimeDomain(timeDomain, -(delta / pan.width) * timeDomain.durationMs));
  });
  function endPan(event) {
    if (!pan || (event?.pointerId !== undefined && event.pointerId !== pan.pointerId)) return;
    try { chart.releasePointerCapture?.(pan.pointerId); } catch { /* already released */ }
    pan = null;
    chart.classList.remove("host-health-panning");
  }
  chart.addEventListener("pointerup", endPan);
  chart.addEventListener("pointercancel", endPan);
  chart.addEventListener("lostpointercapture", endPan);

  for (const button of rangeButtons) button.addEventListener("click", () => {
    if (!RANGE_KEYS.has(button.dataset.hostHealthRange)) return;
    activeRange = button.dataset.hostHealthRange;
    timeDomain = null;
    updateSelectionButtons(rangeButtons, "hostHealthRange", activeRange, "host-health-option-active");
    if (loaded) render(true);
  });
  for (const button of timeButtons) button.addEventListener("click", () => {
    const next = String(button.dataset.hostHealthTime || "").toUpperCase();
    if (!TIME_BASES.has(next)) return;
    basis = next;
    updateSelectionButtons(timeButtons, "hostHealthTime", basis, "host-health-option-active");
    if (loaded) render(false);
  });
  doc.addEventListener("click", (event) => {
    const opener = event.target.closest?.("#hostHealthButton");
    if (!opener) return;
    event.preventDefault();
    open(opener);
  });
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(panel);
    if (!focusable.length) return;
    if (event.shiftKey && doc.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && doc.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  });
  updateSelectionButtons(rangeButtons, "hostHealthRange", activeRange, "host-health-option-active");
  updateSelectionButtons(timeButtons, "hostHealthTime", basis, "host-health-option-active");
  updateZoomControls();
  return {
    open, close, load, render,
    get activeRange() { return activeRange; },
    get timeBasis() { return basis; },
    get timeDomain() { return timeDomain; },
    get loaded() { return loaded; },
  };
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => initializeHostHealth(document));
  else initializeHostHealth(document);
}
