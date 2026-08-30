import {
  buildBwcTimeline,
  buildStepPaths,
  calculateBwcAge,
  calculateBwcStatistics,
  describeArchiveAvailability,
  findLastConfirmedChange,
  formatBwcMemphisTime,
  formatBwcZuluTime,
  getBwcRange,
  normalizeBwcHistory,
} from "./bwc-history-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RANGE_KEYS = new Set(["24h", "7d", "30d", "90d", "365d"]);
const STATE_NAMES = ["LOW", "MODERATE", "SEVERE", "UNKNOWN"];
const DEFAULT_RANGE = "24h";
let lastLiveAgeRenderKey = null;

function clearChildren(element) {
  while (element?.firstChild) element.removeChild(element.firstChild);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function safeFormat(formatter, value, fallback = "TIME UNKNOWN") {
  try {
    const formatted = formatter(value);
    return formatted && formatted !== "INVALID" ? String(formatted) : fallback;
  } catch {
    return fallback;
  }
}

function appendTextRow(doc, parent, label, value, className = "") {
  const row = doc.createElement("div");
  row.className = className;
  const term = doc.createElement("span");
  term.className = "bwc-history-row-label";
  term.textContent = label;
  const detail = doc.createElement("strong");
  detail.className = "bwc-history-row-value";
  detail.textContent = value;
  row.append(term, detail);
  parent.appendChild(row);
  return row;
}

function setStatus(element, headline, detail = "", tone = "normal") {
  if (!element) return;
  element.className = `bwc-history-status bwc-history-status-${tone}`;
  clearChildren(element);
  const heading = element.ownerDocument.createElement("strong");
  heading.textContent = headline;
  element.appendChild(heading);
  if (detail) {
    const explanation = element.ownerDocument.createElement("span");
    explanation.textContent = detail;
    element.appendChild(explanation);
  }
}

function focusableElements(panel) {
  return [...panel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute?.("aria-hidden") !== "true");
}

export function applyBwcHistoryDialogState(
  elements,
  open,
  scheduleFocus = (callback) => callback(),
) {
  const { overlay, body, focusTarget, returnFocus } = elements || {};
  if (!overlay) return;
  overlay.hidden = !open;
  overlay.setAttribute("aria-hidden", open ? "false" : "true");
  body?.classList?.toggle("bwc-history-open", open);
  const target = open ? focusTarget : returnFocus;
  if (target?.focus) scheduleFocus(() => target.focus());
}

export function createBwcHistoryLoader({
  fetchImpl = globalThis.fetch,
  baseUrl = typeof document !== "undefined" ? document.baseURI : "http://localhost/",
  normalize = normalizeBwcHistory,
} = {}) {
  let requestPromise = null;

  async function request() {
    if (typeof fetchImpl !== "function") throw new Error("History fetch is unavailable");
    const url = new URL("./bwc_history.json", baseUrl || "http://localhost/");
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      throw new Error(`BWC history request failed: ${error?.message || "network error"}`);
    }
    if (!response?.ok) throw new Error(`BWC history request failed: HTTP ${response?.status || "ERROR"}`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("BWC history response is not valid JSON");
    }

    const normalized = normalize(payload);
    if (!normalized?.ok) {
      throw new Error(normalized?.error?.message || normalized?.error || "BWC history schema is invalid");
    }
    return normalized.value;
  }

  return {
    load() {
      if (!requestPromise) requestPromise = request();
      return requestPromise;
    },
    get started() {
      return Boolean(requestPromise);
    },
  };
}

export function formatCurrentBwc(weather) {
  const rawState = String(weather?.bwc || "PENDING").trim().toUpperCase();
  const state = rawState || "PENDING";
  const lastKnown = Boolean(weather?.lastKnownGoodUsed?.ahas);
  const basis = String(weather?.bwcBasedOn || "").trim().toUpperCase();
  const updatedZ = String(weather?.bwcUpdatedZ || "").trim();
  const zulu = updatedZ ? safeFormat(formatBwcZuluTime, updatedZ, "") : "";
  const details = [];
  if (zulu) details.push(zulu);
  if (basis && !["NO DATA", "N/A", "--"].includes(basis)) details.push(`BASIS ${basis}`);
  if (!weather) details.push("LIVE BWC UNAVAILABLE");
  return {
    heading: lastKnown ? "CURRENT (LAST KNOWN)" : "CURRENT",
    state,
    detail: details.join(" · ") || "SOURCE TIME UNAVAILABLE",
    lastKnown,
    basis,
    updatedZ,
  };
}

export function findTimelineSegmentAt(segments, timestampMs) {
  const target = Number(timestampMs);
  if (!Number.isFinite(target) || !Array.isArray(segments)) return null;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    const start = finiteNumber(segment?.startMs, NaN);
    const end = finiteNumber(segment?.endMs, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (target < start) high = middle - 1;
    else if (target >= end) low = middle + 1;
    else return segment;
  }
  return null;
}

function currentBoardNowMs(view) {
  try {
    if (typeof view?.getBoardNowMs === "function") {
      const boardNow = Number(view.getBoardNowMs());
      if (Number.isFinite(boardNow)) return boardNow;
    }
    if (typeof view?.getBoardNow === "function") {
      const boardNow = view.getBoardNow();
      const parsed = boardNow instanceof Date ? boardNow.getTime() : Number(boardNow);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // The history panel is supplemental; fall back to the device clock.
  }
  return Date.now();
}

export function updateLiveBwcAge(
  doc = document,
  view = doc?.defaultView || globalThis,
  force = false,
) {
  const ageElement = doc?.getElementById?.("bwcAge");
  if (!ageElement) return { ok: false, minutes: null, reason: "MISSING_ELEMENT" };
  const weather = view?.kmemWeatherData;
  let result;
  try {
    result = calculateBwcAge(weather?.bwcUpdatedZ, currentBoardNowMs(view));
  } catch {
    result = { ok: false, minutes: null, reason: "AGE_CALCULATION_FAILED" };
  }
  const lastKnown = Boolean(weather?.lastKnownGoodUsed?.ahas);
  const validMinutes = result?.ok && Number.isFinite(Number(result.minutes));
  const minutes = validMinutes ? Math.max(0, Math.floor(Number(result.minutes))) : null;
  const stale = validMinutes && minutes > 90;
  const renderKey = validMinutes
    ? `valid:${minutes}:${lastKnown}:${stale}`
    : `invalid:${String(result?.reason || "INVALID")}`;
  if (!force && renderKey === lastLiveAgeRenderKey) return result;
  lastLiveAgeRenderKey = renderKey;

  ageElement.classList?.toggle("bwc-age-last-known", lastKnown);
  ageElement.classList?.toggle("bwc-age-stale", stale);
  if (validMinutes) {
    ageElement.textContent = `${minutes} MIN AGO${lastKnown ? " · LAST KNOWN" : ""}`;
    ageElement.hidden = false;
    ageElement.removeAttribute?.("title");
  } else {
    ageElement.textContent = "";
    ageElement.hidden = true;
    if (String(result?.reason || "").toUpperCase().includes("FUTURE")) {
      ageElement.setAttribute?.("title", "AHAS source time is more than two minutes ahead of board time");
    } else {
      ageElement.removeAttribute?.("title");
    }
  }
  return result;
}

function renderCurrent(doc, element, weather) {
  if (!element) return;
  const current = formatCurrentBwc(weather);
  clearChildren(element);
  element.className = `bwc-history-summary-card bwc-history-current bwc-history-state-${current.state.toLowerCase()}`;
  const heading = doc.createElement("span");
  heading.className = "bwc-history-summary-label";
  heading.textContent = current.heading;
  const state = doc.createElement("strong");
  state.className = "bwc-history-summary-value";
  state.textContent = current.state;
  const detail = doc.createElement("span");
  detail.className = "bwc-history-summary-detail";
  detail.textContent = current.detail;
  element.append(heading, state, detail);
}

function transitionTime(transition) {
  for (const field of ["atMs", "startMs", "timestampMs", "timeMs"]) {
    const value = Number(transition?.[field]);
    if (Number.isFinite(value)) return value;
  }
  for (const field of ["atZ", "startZ", "timestampZ", "sourceObservedZ"]) {
    const value = parseTime(transition?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function renderLastChange(doc, element, timeline) {
  if (!element) return;
  clearChildren(element);
  element.className = "bwc-history-summary-card bwc-history-last-change";
  const heading = doc.createElement("span");
  heading.className = "bwc-history-summary-label";
  heading.textContent = "LAST CHANGE";
  const transition = findLastConfirmedChange(timeline);
  const timestampMs = transitionTime(transition);
  const postGap = [...(timeline?.segments || [])].reverse().find((segment) => (
    segment.kind === "STATE"
    && ["STATE_AFTER_GAP", "COVERAGE_RESUMED"].includes(String(segment.startReason || "").toUpperCase())
  ));
  const postGapMs = finiteNumber(postGap?.sourceRunStartMs ?? postGap?.startMs, NaN);
  const value = doc.createElement("strong");
  value.className = "bwc-history-summary-value";
  const detail = doc.createElement("span");
  detail.className = "bwc-history-summary-detail";

  if (postGap && Number.isFinite(postGapMs) && (!Number.isFinite(timestampMs) || postGapMs > timestampMs)) {
    value.textContent = `${String(postGap.state || "STATE").toUpperCase()} FIRST OBSERVED`;
    detail.textContent = [
      safeFormat(formatBwcZuluTime, postGapMs),
      safeFormat(formatBwcMemphisTime, postGapMs, "LOCAL TIME UNKNOWN"),
      "AFTER DATA GAP",
    ].join(" · ");
  } else if (!transition || !Number.isFinite(timestampMs)) {
    value.textContent = "UNKNOWN";
    detail.textContent = "BEFORE ARCHIVE OR NO CONFIRMED CHANGE";
  } else {
    const state = String(transition.toState || transition.state || "").toUpperCase();
    value.textContent = state || "CONFIRMED";
    detail.textContent = [
      safeFormat(formatBwcZuluTime, timestampMs),
      safeFormat(formatBwcMemphisTime, timestampMs, "LOCAL TIME UNKNOWN"),
    ].join(" · ");
  }
  element.append(heading, value, detail);
}

function renderStatistics(doc, element, statistics) {
  if (!element) return;
  clearChildren(element);
  const percentages = statistics?.percentages || {};
  for (const state of STATE_NAMES) {
    const percent = finiteNumber(percentages[state], 0);
    appendTextRow(
      doc,
      element,
      state,
      `${percent.toFixed(1)}%`,
      `bwc-history-stat-row bwc-history-stat-${state.toLowerCase()}`,
    );
  }
  appendTextRow(
    doc,
    element,
    "BWC CHANGES",
    String(Math.max(0, finiteNumber(statistics?.changeCount, 0))),
    "bwc-history-stat-row bwc-history-stat-summary",
  );
  appendTextRow(
    doc,
    element,
    "SEVERE EPISODES",
    String(Math.max(0, finiteNumber(statistics?.severeEpisodes, 0))),
    "bwc-history-stat-row bwc-history-stat-summary",
  );
}

export function availabilityLines(description, history, statistics) {
  if (!Array.isArray(history?.runs) || history.runs.length === 0) {
    return ["BWC ARCHIVE", "Awaiting first valid live USAHAS result"];
  }
  if (typeof description === "string") return ["BWC ARCHIVE", description];
  const heading = description?.heading || description?.label || description?.title || "BWC ARCHIVE";
  const pieces = [];
  for (const value of [description?.detail, description?.coverage, description?.range]) {
    if (value) pieces.push(String(value));
  }
  if (!description?.detail && String(description?.status || "").toUpperCase() === "PARTIAL") {
    if (Number.isFinite(Number(description?.collectedDays))) {
      pieces.push(`${Number(description.collectedDays).toFixed(1)} days collected`);
    }
    if (Number.isFinite(Number(description?.coveragePercent))) {
      pieces.push(`${Number(description.coveragePercent).toFixed(1)}% known coverage`);
    }
  }
  if (!pieces.length && Number.isFinite(Number(statistics?.coveragePercent))) {
    pieces.push(`${Number(statistics.coveragePercent).toFixed(1)}% known coverage`);
  }
  return [String(heading), pieces.join(" · ") || "Archive coverage available"];
}

export function historyFailureArchiveMessage(error) {
  const message = String(error?.message || error || "");
  if (/HTTP\s+404\b/i.test(message)) {
    return "Awaiting first valid live USAHAS result (archive file not published yet)";
  }
  return "BWC HISTORY UNAVAILABLE";
}

function renderAvailability(doc, element, history, statistics, nowMs) {
  if (!element) return;
  clearChildren(element);
  let description = null;
  try {
    description = describeArchiveAvailability(history, nowMs);
  } catch {
    description = null;
  }
  const [headingText, detailText] = availabilityLines(description, history, statistics);
  const heading = doc.createElement("strong");
  heading.textContent = headingText;
  const detail = doc.createElement("span");
  detail.textContent = detailText;
  element.append(heading, detail);
}

function renderLegend(doc, element) {
  if (!element || element.childElementCount) return;
  const items = [
    ["LOW", "low"],
    ["MODERATE", "moderate"],
    ["SEVERE", "severe"],
    ["UNKNOWN / UNCOLLECTED", "unknown"],
  ];
  const list = doc.createElement("div");
  list.className = "bwc-history-legend-items";
  for (const [label, tone] of items) {
    const item = doc.createElement("span");
    item.className = "bwc-history-legend-item";
    const swatch = doc.createElement("i");
    swatch.className = `bwc-history-legend-swatch bwc-history-legend-${tone}`;
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, doc.createTextNode(label));
    list.appendChild(item);
  }
  const basis = doc.createElement("p");
  basis.textContent = "SOURCE: USAHAS · NEXRAD = OBSERVED-BACKED · SOAR/NEXBAM = MODEL-BACKED";
  element.append(list, basis);
}

function createSvgElement(doc, name, attributes = {}) {
  const element = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function axisLabel(timestampMs, durationMs) {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return "--";
  if (durationMs <= 48 * 60 * 60 * 1000) {
    return `${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
  }
  if (durationMs <= 90 * 24 * 60 * 60 * 1000) {
    const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
    return `${String(date.getUTCDate()).padStart(2, "0")} ${month}`;
  }
  return date.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }).toUpperCase();
}

function basisDescription(segment) {
  const basis = String(segment?.basis || "UNKNOWN").toUpperCase();
  const basisClass = String(segment?.basisClass || "").toUpperCase();
  let classification = "basis not reported";
  if (basisClass.includes("OBSERVED") || basis === "NEXRAD") classification = "observed-backed";
  else if (basisClass.includes("MODEL") || basis === "SOAR" || basis === "NEXBAM") classification = "model-backed";
  return `${basis} — ${classification}`;
}

function showChartTooltip(doc, tooltip, container, event, segment, timestampMs) {
  if (!tooltip || !container || !segment) return;
  clearChildren(tooltip);
  const heading = doc.createElement("strong");
  const time = Number.isFinite(Number(timestampMs)) ? Number(timestampMs) : finiteNumber(segment.startMs, NaN);
  if (segment.kind === "STATE") {
    heading.textContent = `AHAS RISK: ${String(segment.state || "UNKNOWN").toUpperCase()}`;
    const zulu = doc.createElement("span");
    zulu.textContent = safeFormat(formatBwcZuluTime, time);
    const local = doc.createElement("span");
    local.textContent = safeFormat(formatBwcMemphisTime, time, "LOCAL TIME UNKNOWN");
    const source = doc.createElement("span");
    source.textContent = "Source: USAHAS";
    const basis = doc.createElement("span");
    basis.textContent = `Basis: ${basisDescription(segment)}`;
    tooltip.append(heading, zulu, local, source, basis);
  } else {
    heading.textContent = "COVERAGE: UNKNOWN";
    const zulu = doc.createElement("span");
    zulu.textContent = safeFormat(formatBwcZuluTime, time);
    const reason = doc.createElement("span");
    reason.textContent = String(segment.reason || "NO CONFIRMED USAHAS OBSERVATION").replaceAll("_", " ");
    tooltip.append(heading, zulu, reason);
  }
  tooltip.hidden = false;

  const containerRect = container.getBoundingClientRect?.() || { left: 0, top: 0, width: 0 };
  const x = finiteNumber(event?.clientX, containerRect.left + containerRect.width / 2) - containerRect.left;
  const y = finiteNumber(event?.clientY, containerRect.top) - containerRect.top;
  const tooltipWidth = tooltip.offsetWidth || 230;
  const clampedX = Math.max(8, Math.min(x + 12, Math.max(8, containerRect.width - tooltipWidth - 8)));
  tooltip.style.left = `${clampedX}px`;
  tooltip.style.top = `${Math.max(8, y - 12)}px`;
}

function chartPlot(stepLayout, dimensions) {
  if (stepLayout?.plot) return stepLayout.plot;
  const { width, height, padding } = dimensions;
  const left = padding.left;
  const right = width - padding.right;
  const top = padding.top;
  const bottom = height - padding.bottom;
  const plotHeight = bottom - top;
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: plotHeight,
    yByState: {
      SEVERE: top,
      MODERATE: top + plotHeight / 2,
      LOW: bottom,
    },
  };
}

function setEmptyChart(doc, container, message) {
  if (!container) return;
  clearChildren(container);
  const empty = doc.createElement("div");
  empty.className = "bwc-history-chart-empty";
  empty.textContent = message;
  container.appendChild(empty);
}

export function renderBwcHistoryChart(doc, container, tooltip, timeline) {
  if (!container || !timeline?.range) return null;
  clearChildren(container);
  if (tooltip) {
    tooltip.hidden = true;
    container.appendChild(tooltip);
  }

  const measuredWidth = finiteNumber(container.clientWidth, 0);
  const width = Math.max(320, Math.round(measuredWidth || 820));
  const compact = width < 620;
  const height = compact ? 230 : 286;
  const padding = { left: compact ? 48 : 58, right: 14, top: 18, bottom: 34 };
  const dimensions = { width, height, padding };
  let stepLayout;
  try {
    stepLayout = buildStepPaths(timeline, dimensions);
  } catch {
    setEmptyChart(doc, container, "BWC HISTORY CHART UNAVAILABLE");
    return null;
  }
  if (!stepLayout?.ok) {
    setEmptyChart(doc, container, "BWC HISTORY CHART UNAVAILABLE");
    return null;
  }
  const plot = chartPlot(stepLayout, dimensions);
  const svg = createSvgElement(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "USAHAS AHAS risk step chart with LOW, MODERATE, SEVERE, and unknown coverage",
    preserveAspectRatio: "xMidYMid meet",
  });
  svg.classList.add("bwc-history-svg");

  const defs = createSvgElement(doc, "defs");
  const pattern = createSvgElement(doc, "pattern", {
    id: "bwcHistoryUnknownHatch",
    width: 8,
    height: 8,
    patternUnits: "userSpaceOnUse",
    patternTransform: "rotate(35)",
  });
  pattern.appendChild(createSvgElement(doc, "line", {
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 8,
    class: "bwc-history-unknown-hatch-line",
  }));
  defs.appendChild(pattern);
  svg.appendChild(defs);

  const background = createSvgElement(doc, "rect", {
    x: plot.left,
    y: plot.top,
    width: plot.width,
    height: plot.height,
    class: "bwc-history-plot-background",
  });
  svg.appendChild(background);

  for (const state of ["SEVERE", "MODERATE", "LOW"]) {
    const y = finiteNumber(plot.yByState?.[state], state === "SEVERE" ? plot.top : state === "LOW" ? plot.bottom : plot.top + plot.height / 2);
    svg.appendChild(createSvgElement(doc, "line", {
      x1: plot.left,
      x2: plot.right,
      y1: y,
      y2: y,
      class: "bwc-history-grid-line",
    }));
    const label = createSvgElement(doc, "text", {
      x: plot.left - 7,
      y: y + 4,
      "text-anchor": "end",
      class: `bwc-history-axis-label bwc-history-axis-${state.toLowerCase()}`,
    });
    label.textContent = compact && state === "MODERATE" ? "MOD" : state;
    svg.appendChild(label);
  }

  for (const band of stepLayout?.unknownBands || []) {
    svg.appendChild(createSvgElement(doc, "rect", {
      x: finiteNumber(band.x, plot.left),
      y: plot.top,
      width: Math.max(0, finiteNumber(band.width, 0)),
      height: plot.height,
      class: "bwc-history-unknown-band",
    }));
  }

  for (const pathData of stepLayout?.paths || []) {
    if (!pathData?.d) continue;
    svg.appendChild(createSvgElement(doc, "path", {
      d: pathData.d,
      class: `bwc-history-step bwc-history-step-${String(pathData.state || "unknown").toLowerCase()}`,
      "vector-effect": "non-scaling-stroke",
    }));
  }

  const rangeStart = finiteNumber(timeline.range.startMs, NaN);
  const rangeEnd = finiteNumber(timeline.range.endMs, NaN);
  const durationMs = rangeEnd - rangeStart;
  const tickCount = compact ? 3 : 5;
  if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && durationMs > 0) {
    for (let index = 0; index < tickCount; index += 1) {
      const ratio = index / (tickCount - 1);
      const x = plot.left + ratio * plot.width;
      const timestamp = rangeStart + ratio * durationMs;
      svg.appendChild(createSvgElement(doc, "line", {
        x1: x,
        x2: x,
        y1: plot.bottom,
        y2: plot.bottom + 5,
        class: "bwc-history-tick",
      }));
      const tick = createSvgElement(doc, "text", {
        x,
        y: plot.bottom + 21,
        "text-anchor": index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle",
        class: "bwc-history-axis-label bwc-history-time-label",
      });
      tick.textContent = axisLabel(timestamp, durationMs);
      svg.appendChild(tick);
    }
  }

  const interaction = createSvgElement(doc, "rect", {
    x: plot.left,
    y: Math.max(0, plot.top - 10),
    width: plot.width,
    height: plot.height + 20,
    class: "bwc-history-hit-area",
    tabindex: 0,
    "aria-label": "Inspect BWC history chart",
  });
  svg.appendChild(interaction);
  container.insertBefore(svg, tooltip || null);

  let pinned = false;
  let lastSegment = null;
  function inspect(event, shouldPin = false) {
    if (!(durationMs > 0)) return;
    const rect = svg.getBoundingClientRect?.();
    if (!rect?.width) return;
    const svgX = (finiteNumber(event?.clientX, rect.left) - rect.left) * width / rect.width;
    const ratio = Math.max(0, Math.min(1, (svgX - plot.left) / plot.width));
    const timestampMs = rangeStart + ratio * durationMs;
    const segment = findTimelineSegmentAt(timeline.segments, Math.min(timestampMs, rangeEnd - 1));
    if (!segment) return;
    lastSegment = segment;
    if (shouldPin) pinned = true;
    showChartTooltip(doc, tooltip, container, event, segment, timestampMs);
  }
  interaction.addEventListener("pointermove", (event) => inspect(event));
  interaction.addEventListener("pointerleave", () => {
    if (!pinned && tooltip) tooltip.hidden = true;
  });
  interaction.addEventListener("click", (event) => inspect(event, true));
  interaction.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      pinned = false;
      if (tooltip) tooltip.hidden = true;
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const segment = lastSegment || timeline.segments?.find((item) => item.kind === "STATE") || timeline.segments?.[0];
    if (!segment) return;
    pinned = true;
    const midpoint = (finiteNumber(segment.startMs) + finiteNumber(segment.endMs)) / 2;
    showChartTooltip(doc, tooltip, container, null, segment, midpoint);
  });
  return svg;
}

function staleArchive(history, nowMs) {
  if (!history?.runs?.length) return false;
  const evidenceTimes = history.runs
    .map((run) => finiteNumber(run?.lastRecordedMs, parseTime(run?.lastRecordedZ)))
    .filter(Number.isFinite);
  const latestEvidenceMs = evidenceTimes.length
    ? Math.max(...evidenceTimes)
    : parseTime(history.archiveUpdatedZ);
  if (!Number.isFinite(latestEvidenceMs)) return true;
  const horizonMs = Math.max(1, finiteNumber(history.continuityMinutes, 90)) * 60 * 1000;
  return nowMs - latestEvidenceMs > horizonMs;
}

function updateRangeButtons(buttons, rangeKey) {
  for (const button of buttons) {
    const selected = button.dataset.bwcRange === rangeKey;
    button.classList.toggle("bwc-history-range-active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

export function initializeBwcHistory(doc = document) {
  const overlay = doc.getElementById("bwcHistoryOverlay");
  const panel = doc.getElementById("bwcHistoryPanel");
  const closeButton = doc.getElementById("bwcHistoryCloseButton");
  const status = doc.getElementById("bwcHistoryStatus");
  const chart = doc.getElementById("bwcHistoryChart");
  const tooltip = doc.getElementById("bwcHistoryTooltip");
  const current = doc.getElementById("bwcHistoryCurrent");
  const lastChange = doc.getElementById("bwcHistoryLastChange");
  const stats = doc.getElementById("bwcHistoryStats");
  const archive = doc.getElementById("bwcHistoryArchive");
  const legend = doc.getElementById("bwcHistoryLegend");
  const rangeButtons = [...doc.querySelectorAll("[data-bwc-range]")];
  if (!overlay || !panel || !closeButton || !status || !chart || !current || !lastChange || !stats || !archive || !legend || !rangeButtons.length) return null;

  const view = doc.defaultView || window;
  const loader = createBwcHistoryLoader({
    fetchImpl: view.fetch?.bind(view),
    baseUrl: doc.baseURI,
  });
  let returnFocus = null;
  let activeRange = DEFAULT_RANGE;
  let history = null;
  let loadError = null;
  let renderFrame = 0;

  renderLegend(doc, legend);
  updateRangeButtons(rangeButtons, activeRange);

  function clearHistoryPresentation(message) {
    setEmptyChart(doc, chart, message);
    clearChildren(lastChange);
    appendTextRow(doc, lastChange, "LAST CHANGE", "UNKNOWN", "bwc-history-unavailable-row");
    clearChildren(stats);
    appendTextRow(doc, stats, "COVERAGE", "UNAVAILABLE", "bwc-history-unavailable-row");
    clearChildren(archive);
    const heading = doc.createElement("strong");
    heading.textContent = "BWC ARCHIVE";
    const detail = doc.createElement("span");
    detail.textContent = message;
    archive.append(heading, detail);
  }

  function render() {
    renderCurrent(doc, current, view.kmemWeatherData);
    if (!history) {
      if (loadError) clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    const nowMs = currentBoardNowMs(view);
    let range;
    let timelineResult;
    try {
      range = getBwcRange(activeRange, nowMs);
      timelineResult = buildBwcTimeline(history, range, nowMs);
    } catch (error) {
      loadError = error;
      setStatus(status, "BWC HISTORY UNAVAILABLE", "History calculations could not be completed.", "error");
      clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    const timeline = timelineResult?.ok === false ? null : timelineResult?.value || timelineResult;
    if (!timeline?.range || !Array.isArray(timeline?.segments)) {
      loadError = new Error(timelineResult?.error || "Invalid history timeline");
      setStatus(status, "BWC HISTORY UNAVAILABLE", "History data is malformed or unsupported.", "error");
      clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    const statistics = calculateBwcStatistics(timeline);
    if (staleArchive(history, nowMs)) {
      setStatus(status, "BWC HISTORY UNAVAILABLE", "The archive is stale; preserved historical coverage is shown below.", "error");
    } else if (!history.runs?.length) {
      setStatus(status, "AWAITING LIVE DATA", "The archive begins with the first valid direct USAHAS result.", "warning");
    } else {
      setStatus(status, "BWC HISTORY READY", `${String(activeRange).toUpperCase()} rolling UTC view`, "success");
    }
    renderBwcHistoryChart(doc, chart, tooltip, timeline);
    renderLastChange(doc, lastChange, timeline);
    renderStatistics(doc, stats, statistics);
    renderAvailability(doc, archive, history, statistics, nowMs);
  }

  function refreshCurrent() {
    renderCurrent(doc, current, view.kmemWeatherData);
  }

  // The normal weather loader calls this after replacing kmemWeatherData so an
  // already-open modal stays current without refetching history or adding a timer.
  view.kmemRefreshBwcHistoryCurrent = refreshCurrent;

  async function ensureHistory() {
    setStatus(status, "LOADING...", "Loading the supplemental BWC archive.", "loading");
    renderCurrent(doc, current, view.kmemWeatherData);
    try {
      history = await loader.load();
      loadError = null;
      if (!overlay.hidden) render();
    } catch (error) {
      loadError = error;
      if (!overlay.hidden) {
        setStatus(status, "BWC HISTORY UNAVAILABLE", error?.message || "The supplemental archive could not be loaded.", "error");
        clearHistoryPresentation(historyFailureArchiveMessage(error));
      }
    }
  }

  function open(opener) {
    returnFocus = opener || doc.activeElement;
    renderCurrent(doc, current, view.kmemWeatherData);
    applyBwcHistoryDialogState(
      { overlay, body: doc.body, focusTarget: closeButton, returnFocus },
      true,
      (callback) => (view.requestAnimationFrame || ((next) => next()))(callback),
    );
    if (history) render();
    else if (loadError) {
      setStatus(status, "BWC HISTORY UNAVAILABLE", loadError?.message || "The supplemental archive could not be loaded.", "error");
      clearHistoryPresentation(historyFailureArchiveMessage(loadError));
    } else ensureHistory();
  }

  function close() {
    if (renderFrame && view.cancelAnimationFrame) view.cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    applyBwcHistoryDialogState(
      { overlay, body: doc.body, focusTarget: closeButton, returnFocus },
      false,
    );
  }

  doc.addEventListener("click", (event) => {
    const opener = event.target.closest?.("#bwcHistoryButton");
    if (!opener) return;
    event.preventDefault();
    open(opener);
  });
  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(panel);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  for (const rangeButton of rangeButtons) {
    rangeButton.addEventListener("click", () => {
      const nextRange = rangeButton.dataset.bwcRange;
      if (!RANGE_KEYS.has(nextRange) || nextRange === activeRange) return;
      activeRange = nextRange;
      updateRangeButtons(rangeButtons, activeRange);
      if (history) render();
    });
  }
  view.addEventListener?.("resize", () => {
    if (overlay.hidden || !history) return;
    if (renderFrame && view.cancelAnimationFrame) view.cancelAnimationFrame(renderFrame);
    const schedule = view.requestAnimationFrame || ((callback) => { callback(); return 0; });
    renderFrame = schedule(() => {
      renderFrame = 0;
      render();
    });
  });

  return {
    open,
    close,
    render,
    refreshCurrent,
    get activeRange() { return activeRange; },
    get historyLoaded() { return Boolean(history); },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.kmemUpdateBwcAge = (force = false) => updateLiveBwcAge(document, window, force);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initializeBwcHistory(document);
      window.kmemUpdateBwcAge?.(true);
    });
  } else {
    initializeBwcHistory(document);
    window.kmemUpdateBwcAge?.(true);
  }
}
