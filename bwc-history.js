import {
  buildBwcTimeline,
  buildBwcCsvExport,
  buildStepPaths,
  calculateBwcAge,
  calculateBwcStatistics,
  createBwcTimeDomain,
  describeArchiveAvailability,
  findLastConfirmedChange,
  formatBwcMemphisTime,
  formatBwcDuration,
  formatBwcZuluTime,
  getBwcRange,
  normalizeBwcHistory,
  panBwcTimeDomain,
  resetBwcTimeDomain,
  selectBwcObservationMarkers,
  selectBwcUtcTicks,
  summarizeBwcHistory,
  zoomBwcTimeDomain,
} from "./bwc-history-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RANGE_KEYS = new Set(["24h", "7d", "30d", "90d", "365d"]);
const SUMMARY_MODES = new Set(["daily", "monthly", "seasonal"]);
const RANGE_EXPORT_LABELS = Object.freeze({
  "24h": "24HR",
  "7d": "7DAYS",
  "30d": "30DAYS",
  "90d": "90DAYS",
  "365d": "1YEAR",
});
const RANGE_UI_LABELS = Object.freeze({
  "24h": "24 HR",
  "7d": "7 DAYS",
  "30d": "30 DAYS",
  "90d": "90 DAYS",
  "365d": "1 YEAR",
});
const STATE_NAMES = ["LOW", "MODERATE", "SEVERE", "UNKNOWN"];
const DEFAULT_RANGE = "24h";
const SPARSE_OBSERVATION_MARKER_LIMIT = 500;
export const BWC_SHORT_EVENT_MAX_WIDTH_PX = 8;
// Keep full categorical labels inside the root SVG viewport at every width.
// This semantic gutter also reserves enough room for UNKNOWN if it is added.
const BWC_CATEGORY_AXIS_GUTTER_WIDTH = 84;
const BWC_CATEGORY_AXIS_LABEL_X = 74;
let lastLiveAgeRenderKey = null;

/**
 * Select truthful STATE intervals that are too narrow to read at the current
 * rendered scale. The returned marker is an emphasis cue only: its center is
 * derived from the exact interval and the underlying plateau is never widened.
 */
export function selectBwcShortEventMarkers(timeline, {
  plotWidth = 0,
  displayScaleX = 1,
  maxWidthPx = BWC_SHORT_EVENT_MAX_WIDTH_PX,
} = {}) {
  const startMs = Number(timeline?.range?.startMs);
  const endMs = Number(timeline?.range?.endMs);
  const durationMs = endMs - startMs;
  const svgPlotWidth = Number(plotWidth);
  const scaleX = Number(displayScaleX);
  const thresholdPx = Number(maxWidthPx);
  if (!Array.isArray(timeline?.segments)
      || !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || !(durationMs > 0)
      || !(svgPlotWidth > 0)
      || !(scaleX > 0)
      || !(thresholdPx > 0)) return [];

  // Storage runs may split only because provenance/basis changed while the
  // categorical state stayed the same. Build visual state episodes first so
  // those backend boundaries never masquerade as new BWC events.
  const episodes = [];
  for (const segment of timeline.segments) {
    if (segment?.kind !== "STATE") continue;
    const segmentStartMs = Number(segment.startMs);
    const segmentEndMs = Number(segment.endMs);
    if (!Number.isFinite(segmentStartMs) || !Number.isFinite(segmentEndMs) || !(segmentEndMs > segmentStartMs)) continue;
    const previous = episodes[episodes.length - 1];
    if (previous && previous.state === segment.state && previous.endMs === segmentStartMs) {
      previous.endMs = segmentEndMs;
      previous.parts.push(segment);
    } else {
      episodes.push({
        state: segment.state,
        startMs: segmentStartMs,
        endMs: segmentEndMs,
        clippedAtRangeStart: Boolean(segment.clippedAtRangeStart),
        parts: [segment],
      });
    }
  }

  const markers = [];
  for (const episode of episodes) {
    // A viewport-edge sliver does not prove that the underlying event is
    // short, so only fully visible intervals receive this emphasis marker.
    if (!(episode.startMs > startMs && episode.endMs < endMs) || episode.clippedAtRangeStart) continue;
    const intervalDurationMs = episode.endMs - episode.startMs;
    const widthPx = (intervalDurationMs / durationMs) * svgPlotWidth * scaleX;
    if (!(widthPx > 0 && widthPx < thresholdPx)) continue;
    const sources = [...new Set(episode.parts.map((part) => String(part.source || "USAHAS").trim().toUpperCase()))];
    const basisDetails = [];
    const seenBasis = new Set();
    for (const part of episode.parts) {
      const key = `${String(part.basis || "UNKNOWN").toUpperCase()}|${String(part.basisClass || "").toUpperCase()}`;
      if (seenBasis.has(key)) continue;
      seenBasis.add(key);
      basisDetails.push({ basis: part.basis, basisClass: part.basisClass });
    }
    markers.push({
      evidenceKind: "short-event",
      kind: "STATE",
      state: episode.state,
      startMs: episode.startMs,
      endMs: episode.endMs,
      durationMs: intervalDurationMs,
      timeMs: episode.startMs + intervalDurationMs / 2,
      widthPx,
      source: sources.join(" / "),
      basis: basisDetails.length === 1 ? basisDetails[0].basis : "MULTIPLE",
      basisClass: basisDetails.length === 1 ? basisDetails[0].basisClass : "MIXED",
      basisDetails,
      startReason: episode.parts[0]?.startReason,
      segments: episode.parts,
    });
  }
  return markers;
}

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

function summaryModeTitle(mode) {
  if (mode === "monthly") return "Monthly";
  if (mode === "seasonal") return "Seasonal";
  return "Daily";
}

function summaryList(summary, mode) {
  const value = summary?.[mode];
  const rows = Array.isArray(value) ? value : value?.summaries;
  return Array.isArray(rows)
    ? [...rows].sort((left, right) => finiteNumber(right?.representedStartMs ?? right?.startMs, 0)
        - finiteNumber(left?.representedStartMs ?? left?.startMs, 0))
    : [];
}

function percentageText(value) {
  return `${Math.max(0, Math.min(100, finiteNumber(value, 0))).toFixed(1)}%`;
}

function representedText(bucket) {
  const days = Math.max(0, finiteNumber(bucket?.representedDays, finiteNumber(bucket?.representedMs, 0) / 86_400_000));
  const effectivelyWhole = Math.abs(days - Math.round(days)) < 0.0005;
  const precision = days > 0 && days < 0.1 ? 2 : effectivelyWhole ? 0 : 1;
  const dayLabel = Math.abs(days - 1) < 0.05 ? "DAY" : "DAYS";
  const completeness = bucket?.isComplete ? "COMPLETE" : "PARTIAL";
  return `${days.toFixed(precision)} ${dayLabel} · ${completeness}`;
}

function displayedStatePercentages(bucket) {
  const raw = STATE_NAMES.map((state, index) => ({
    state,
    index,
    units: Math.max(0, finiteNumber(bucket?.percentages?.[state], 0)) * 10,
  }));
  const totalRaw = raw.reduce((sum, item) => sum + item.units, 0);
  if (!(totalRaw > 0)) return Object.fromEntries(STATE_NAMES.map((state) => [state, state === "UNKNOWN" ? 100 : 0]));
  const scaled = raw.map((item) => ({ ...item, units: item.units * 1000 / totalRaw }));
  const allocated = scaled.map((item) => Math.floor(item.units));
  let remaining = 1000 - allocated.reduce((sum, units) => sum + units, 0);
  const order = [...scaled].sort((left, right) => (
    (right.units - Math.floor(right.units)) - (left.units - Math.floor(left.units))
    || left.index - right.index
  ));
  for (let index = 0; index < remaining; index += 1) allocated[order[index % order.length].index] += 1;
  return Object.fromEntries(STATE_NAMES.map((state, index) => [state, allocated[index] / 10]));
}

function stateDurationText(bucket, state, displayPercentages) {
  const duration = finiteNumber(bucket?.durationsMs?.[state], 0);
  return `${formatBwcDuration(duration)} · ${percentageText(displayPercentages?.[state])}`;
}

function appendSummaryCell(doc, row, value, { header = false, className = "" } = {}) {
  const cell = doc.createElement(header ? "th" : "td");
  if (header) cell.setAttribute("scope", "row");
  if (className) cell.className = className;
  cell.textContent = String(value ?? "");
  row.appendChild(cell);
  return cell;
}

function summaryColumns(mode) {
  const common = ["PEAK", "REPRESENTED", "LOW", "MODERATE", "SEVERE", "UNKNOWN", "KNOWN", "CHANGES", "SEVERE EP."];
  if (mode === "daily") return ["DATE", ...common, "EXACT OBS."];
  return [mode === "seasonal" ? "SEASON" : "MONTH", ...common, "SEVERE DAYS", "EXACT OBS."];
}

function appendSummaryBucket(doc, tbody, bucket, mode) {
  const row = doc.createElement("tr");
  const peak = String(bucket?.peakState || "UNKNOWN").toUpperCase();
  appendSummaryCell(doc, row, bucket?.label || bucket?.key || "UNKNOWN", { header: true });
  appendSummaryCell(doc, row, peak, { className: `bwc-history-summary-peak-${peak.toLowerCase()}` });
  appendSummaryCell(doc, row, representedText(bucket), {
    className: bucket?.isComplete ? "bwc-history-summary-complete" : "bwc-history-summary-partial",
  });
  const displayPercentages = displayedStatePercentages(bucket);
  for (const state of STATE_NAMES) appendSummaryCell(doc, row, stateDurationText(bucket, state, displayPercentages));
  appendSummaryCell(doc, row, percentageText(bucket?.coveragePercent));
  appendSummaryCell(doc, row, Math.max(0, finiteNumber(bucket?.changeCount, 0)));
  appendSummaryCell(doc, row, Math.max(0, finiteNumber(bucket?.severeEpisodes, 0)));
  if (mode !== "daily") appendSummaryCell(doc, row, Math.max(0, finiteNumber(bucket?.severeDays, 0)));
  appendSummaryCell(doc, row, Math.max(0, finiteNumber(bucket?.observationCount, 0)));
  tbody.appendChild(row);
}

export function renderBwcSummaryTable(doc, content, context, summary, mode = "daily", rangeLabel = "SELECTED RANGE") {
  if (!content) return false;
  const normalizedMode = SUMMARY_MODES.has(mode) ? mode : "daily";
  const rows = summaryList(summary, normalizedMode);
  clearChildren(content);
  content.setAttribute("aria-label", `${summaryModeTitle(normalizedMode)} BWC history summary table`);
  if (context) {
    const unit = normalizedMode === "daily" ? "LOCAL DAYS" : normalizedMode === "monthly" ? "LOCAL MONTHS" : "METEOROLOGICAL SEASONS";
    context.textContent = `${rangeLabel} SELECTED · ${rows.length} ${unit} · AMERICA/CHICAGO · EXACT RETAINED OBSERVATIONS ONLY`;
  }
  if (!summary?.ok || !rows.length) {
    const empty = doc.createElement("div");
    empty.className = "bwc-history-summary-empty";
    empty.textContent = "NO RETAINED BWC ARCHIVE DATA IN THIS SELECTED RANGE";
    content.appendChild(empty);
    return false;
  }
  const table = doc.createElement("table");
  table.className = `bwc-history-summary-table bwc-history-summary-table-${normalizedMode}`;
  const caption = doc.createElement("caption");
  caption.className = "bwc-history-summary-caption";
  caption.textContent = `${summaryModeTitle(normalizedMode)} BWC summary using Memphis local calendar boundaries`;
  const thead = doc.createElement("thead");
  const headerRow = doc.createElement("tr");
  for (const label of summaryColumns(normalizedMode)) {
    const heading = doc.createElement("th");
    heading.setAttribute("scope", "col");
    heading.textContent = label;
    headerRow.appendChild(heading);
  }
  thead.appendChild(headerRow);
  const tbody = doc.createElement("tbody");
  for (const bucket of rows) appendSummaryBucket(doc, tbody, bucket, normalizedMode);
  table.append(caption, thead, tbody);
  content.appendChild(table);
  return true;
}

export function updateBwcSummaryModeButtons(buttons, mode) {
  const activeMode = SUMMARY_MODES.has(mode) ? mode : "daily";
  for (const button of buttons || []) {
    const selected = button?.dataset?.bwcSummaryMode === activeMode;
    button?.classList?.toggle("bwc-history-summary-tab-active", selected);
    button?.setAttribute?.("aria-pressed", String(selected));
  }
  return activeMode;
}

export function downloadBwcCsv(doc, view, exportResult) {
  const content = String(exportResult?.content || "");
  const filename = String(exportResult?.filename || "");
  const BlobConstructor = view?.Blob;
  const urlApi = view?.URL;
  if (!doc?.body || !content || !filename || typeof BlobConstructor !== "function"
      || typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function") {
    return { ok: false, error: "CSV download is unavailable in this browser" };
  }
  let objectUrl = "";
  let link = null;
  try {
    const blob = new BlobConstructor([content], { type: exportResult?.mimeType || "text/csv;charset=utf-8" });
    objectUrl = urlApi.createObjectURL(blob);
    link = doc.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    doc.body.appendChild(link);
    link.click();
  } catch (error) {
    if (link?.parentNode) link.parentNode.removeChild(link);
    if (objectUrl) urlApi.revokeObjectURL(objectUrl);
    return { ok: false, error: error?.message || "CSV download failed" };
  }
  if (link?.parentNode) link.parentNode.removeChild(link);
  const revoke = () => urlApi.revokeObjectURL(objectUrl);
  if (typeof view?.setTimeout === "function") view.setTimeout(revoke, 0);
  else revoke();
  return { ok: true, filename };
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

function basisDescription(segment) {
  const basis = String(segment?.basis || "UNKNOWN").toUpperCase();
  const basisClass = String(segment?.basisClass || "").toUpperCase();
  let classification = "basis not reported";
  if (basisClass.includes("OBSERVED") || basis === "NEXRAD") classification = "observed-backed";
  else if (basisClass.includes("MODEL") || basis === "SOAR" || basis === "NEXBAM") classification = "model-backed";
  return `${basis} — ${classification}`;
}

function evidenceBasisDescription(evidence) {
  const details = Array.isArray(evidence?.basisDetails) ? evidence.basisDetails : [];
  if (!details.length) return basisDescription(evidence);
  return [...new Set(details.map(basisDescription))].join(" · ");
}

function positionChartTooltip(tooltip, container, event) {
  const containerRect = container.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const x = finiteNumber(event?.clientX, containerRect.left + containerRect.width / 2) - containerRect.left;
  const y = finiteNumber(event?.clientY, containerRect.top) - containerRect.top;
  const tooltipWidth = tooltip.offsetWidth || 230;
  const tooltipHeight = tooltip.offsetHeight || 96;
  const clampedX = Math.max(8, Math.min(x + 12, Math.max(8, containerRect.width - tooltipWidth - 8)));
  const clampedY = Math.max(8, Math.min(y - 12, Math.max(8, finiteNumber(containerRect.height, 0) - tooltipHeight - 8)));
  tooltip.style.left = `${clampedX}px`;
  tooltip.style.top = `${clampedY}px`;
}

function showChartTooltip(doc, tooltip, container, event, observation) {
  const time = Number(observation?.timeMs);
  if (!tooltip || !container || observation?.kind !== "STATE" || !Number.isFinite(time)) {
    if (tooltip) tooltip.hidden = true;
    return false;
  }
  clearChildren(tooltip);
  const heading = doc.createElement("strong");
  heading.textContent = `AHAS RISK: ${String(observation.state || "UNKNOWN").toUpperCase()}`;
  const zulu = doc.createElement("span");
  zulu.textContent = safeFormat(formatBwcZuluTime, time);
  const local = doc.createElement("span");
  local.textContent = safeFormat(formatBwcMemphisTime, time, "LOCAL TIME UNKNOWN");
  const source = doc.createElement("span");
  source.textContent = `Source: ${String(observation.source || "USAHAS").trim().toUpperCase()}`;
  const basis = doc.createElement("span");
  basis.textContent = `Basis: ${basisDescription(observation)}`;
  tooltip.append(heading, zulu, local, source, basis);
  tooltip.hidden = false;
  positionChartTooltip(tooltip, container, event);
  return true;
}

function showBwcEventTooltip(doc, tooltip, container, event, evidence) {
  if (!tooltip || !container || !evidence || !Number.isFinite(Number(evidence.timeMs))) {
    if (tooltip) tooltip.hidden = true;
    return false;
  }
  clearChildren(tooltip);
  const heading = doc.createElement("strong");
  if (evidence.evidenceKind === "short-event") {
    heading.textContent = `AHAS RISK EVENT: ${String(evidence.state || "UNKNOWN").toUpperCase()}`;
    const zulu = doc.createElement("span");
    zulu.textContent = `UTC: ${safeFormat(formatBwcZuluTime, evidence.startMs)} – ${safeFormat(formatBwcZuluTime, evidence.endMs)}`;
    const local = doc.createElement("span");
    local.textContent = `Local: ${safeFormat(formatBwcMemphisTime, evidence.startMs, "LOCAL TIME UNKNOWN")} – ${safeFormat(formatBwcMemphisTime, evidence.endMs, "LOCAL TIME UNKNOWN")}`;
    const duration = doc.createElement("span");
    duration.textContent = `Duration: ${formatBwcDuration(evidence.durationMs) || "UNKNOWN"}`;
    const source = doc.createElement("span");
    source.textContent = `Source: ${String(evidence.source || "USAHAS").trim().toUpperCase()}`;
    const basis = doc.createElement("span");
    basis.textContent = `Basis: ${evidenceBasisDescription(evidence)}`;
    tooltip.append(heading, zulu, local, duration, source, basis);
  } else if (evidence.evidenceKind === "transition") {
    heading.textContent = `${String(evidence.fromState || "UNKNOWN").toUpperCase()} → ${String(evidence.toState || "UNKNOWN").toUpperCase()}`;
    const zulu = doc.createElement("span");
    zulu.textContent = safeFormat(formatBwcZuluTime, evidence.timeMs);
    const local = doc.createElement("span");
    local.textContent = safeFormat(formatBwcMemphisTime, evidence.timeMs, "LOCAL TIME UNKNOWN");
    const source = doc.createElement("span");
    source.textContent = `Source: ${String(evidence.source || "USAHAS").trim().toUpperCase()}`;
    const basis = doc.createElement("span");
    basis.textContent = `Basis: ${basisDescription(evidence)}`;
    tooltip.append(heading, zulu, local, source, basis);
  } else {
    tooltip.hidden = true;
    return false;
  }
  tooltip.hidden = false;
  positionChartTooltip(tooltip, container, event);
  return true;
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

function svgCoordinate(value) {
  return Number(finiteNumber(value, 0).toFixed(3)).toString();
}

function observationMarkerPath(observations, xForTime, y) {
  const commands = new Array(observations.length);
  const yCoordinate = svgCoordinate(y);
  for (let index = 0; index < observations.length; index += 1) {
    // A zero-length subpath with a round linecap is a circle centered exactly
    // at its moveto coordinate. This retains every dot while bounding SVG DOM.
    commands[index] = `M ${svgCoordinate(xForTime(observations[index].timeMs))} ${yCoordinate} h 0`;
  }
  return commands.join(" ");
}

function diamondMarkerPath(evidenceItems, xForTime, yForEvidence, radius) {
  const commands = [];
  for (const evidence of evidenceItems) {
    const x = xForTime(evidence.timeMs);
    const y = yForEvidence(evidence);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    commands.push(
      `M ${svgCoordinate(x)} ${svgCoordinate(y - radius)}`,
      `L ${svgCoordinate(x + radius)} ${svgCoordinate(y)}`,
      `L ${svgCoordinate(x)} ${svgCoordinate(y + radius)}`,
      `L ${svgCoordinate(x - radius)} ${svgCoordinate(y)} Z`,
    );
  }
  return commands.join(" ");
}

function mergeSortedEvidence(leftItems, rightItems) {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftItems.length || rightIndex < rightItems.length) {
    const left = leftItems[leftIndex];
    const right = rightItems[rightIndex];
    if (!right || (left && left.timeMs <= right.timeMs)) {
      merged.push(left);
      leftIndex += 1;
    } else {
      merged.push(right);
      rightIndex += 1;
    }
  }
  return merged;
}

export function renderBwcHistoryChart(doc, container, tooltip, timeline, options = {}) {
  if (!container || !timeline?.range) return null;
  clearChildren(container);
  if (tooltip) {
    tooltip.hidden = true;
    tooltip.setAttribute?.("role", "tooltip");
    container.appendChild(tooltip);
  }

  const measuredWidth = finiteNumber(container.clientWidth, 0);
  const width = Math.max(320, Math.round(measuredWidth || 820));
  const displayScaleX = measuredWidth > 0 ? measuredWidth / width : 1;
  const compact = width < 620;
  const height = compact ? 230 : 286;
  const padding = { left: BWC_CATEGORY_AXIS_GUTTER_WIDTH, right: 14, top: 18, bottom: 34 };
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
  const visibleDurationMs = finiteNumber(timeline.range.durationMs, 0);
  const masterDurationMs = Math.max(visibleDurationMs, finiteNumber(options.masterDurationMs, visibleDurationMs));
  const zoomFactor = visibleDurationMs > 0 ? masterDurationMs / visibleDurationMs : 1;
  const svg = createSvgElement(doc, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "group",
    "aria-label": "USAHAS AHAS risk step chart with exact observation markers and LOW, MODERATE, SEVERE, and unknown coverage",
    preserveAspectRatio: "xMidYMid meet",
    "data-bwc-zoom-factor": svgCoordinate(zoomFactor),
  });
  svg.classList.add("bwc-history-svg");
  if (zoomFactor >= 8) svg.classList.add("bwc-history-detail-zoom");

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

  const categoryAxis = createSvgElement(doc, "g", {
    class: "bwc-history-y-axis",
    "data-bwc-axis-gutter-width": BWC_CATEGORY_AXIS_GUTTER_WIDTH,
    "data-bwc-axis-label-x": BWC_CATEGORY_AXIS_LABEL_X,
  });
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
      x: BWC_CATEGORY_AXIS_LABEL_X,
      y: y + 4,
      "text-anchor": "end",
      class: `bwc-history-axis-label bwc-history-axis-${state.toLowerCase()}`,
    });
    label.textContent = state;
    categoryAxis.appendChild(label);
  }
  svg.appendChild(categoryAxis);

  for (const band of stepLayout?.unknownBands || []) {
    svg.appendChild(createSvgElement(doc, "rect", {
      x: finiteNumber(band.x, plot.left),
      y: plot.top,
      width: Math.max(0, finiteNumber(band.width, 0)),
      height: plot.height,
      class: "bwc-history-unknown-band",
    }));
  }

  const rangeStart = finiteNumber(timeline.range.startMs, NaN);
  const rangeEnd = finiteNumber(timeline.range.endMs, NaN);
  const durationMs = rangeEnd - rangeStart;
  const xForTime = (timeMs) => plot.left + ((timeMs - rangeStart) / durationMs) * plot.width;
  const markerResult = selectBwcObservationMarkers(timeline);
  const observations = markerResult?.ok ? markerResult.markers : [];
  const shortEvents = selectBwcShortEventMarkers(timeline, {
    plotWidth: plot.width,
    displayScaleX,
  });
  const shortEventBoundaries = new Set(shortEvents.flatMap((event) => [event.startMs, event.endMs]));
  const baseMarkerRadius = observations.length > 10_000
    ? 0.7
    : observations.length > 2_000
      ? 0.85
      : observations.length > 500
        ? 1.05
        : compact ? 1.7 : 1.9;
  const markerZoomBoost = zoomFactor >= 32 ? 1.35 : zoomFactor >= 8 ? 0.9 : zoomFactor >= 2 ? 0.4 : 0;
  const markerRadius = (baseMarkerRadius + markerZoomBoost) / Math.max(0.75, displayScaleX);
  const tickResult = Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && durationMs > 0
    ? selectBwcUtcTicks(timeline.range, {
        width: plot.width,
        minSpacingPx: compact ? 94 : 112,
      })
    : null;
  const ticks = tickResult?.ok ? tickResult.ticks : [];
  for (const tickData of ticks) {
    const x = xForTime(tickData.timeMs);
    svg.appendChild(createSvgElement(doc, "line", {
      x1: x,
      x2: x,
      y1: plot.top,
      y2: plot.bottom,
      class: "bwc-history-time-grid-line",
    }));
  }
  const confirmedTransitions = (stepLayout?.transitions || [])
    .filter((transition) => transition.confirmed && !shortEventBoundaries.has(transition.atMs))
    .map((transition) => {
      const fromY = plot.yByState?.[transition.fromState];
      const toY = plot.yByState?.[transition.toState];
      return {
        ...transition,
        evidenceKind: "transition",
        kind: "STATE_CHANGE",
        timeMs: transition.atMs,
        state: transition.toState,
        markerY: Number.isFinite(fromY) && Number.isFinite(toY) ? (fromY + toY) / 2 : toY,
      };
    });
  const yForEvidence = (evidence) => evidence?.evidenceKind === "transition"
    ? evidence.markerY
    : plot.yByState?.[evidence?.state];

  // Draw horizontal plateaus separately from thinner vertical changes. This
  // preserves the exact H/V step geometry while keeping short real states
  // legible instead of turning their corners into heavy blocks.
  for (const pathData of stepLayout?.paths || []) {
    const segment = pathData?.segment;
    const y = plot.yByState?.[pathData?.state];
    if (!segment || !Number.isFinite(y) || !(durationMs > 0)) continue;
    const x1 = xForTime(segment.startMs);
    const x2 = xForTime(segment.endMs);
    svg.appendChild(createSvgElement(doc, "path", {
      d: `M ${svgCoordinate(x1)} ${svgCoordinate(y)} H ${svgCoordinate(x2)}`,
      class: `bwc-history-step bwc-history-step-${String(pathData.state || "unknown").toLowerCase()}`,
      "data-bwc-segment-start-ms": segment.startMs,
      "data-bwc-segment-end-ms": segment.endMs,
      "data-bwc-segment-duration-ms": segment.endMs - segment.startMs,
      "data-bwc-segment-width-px": svgCoordinate((x2 - x1) * displayScaleX),
      "vector-effect": "non-scaling-stroke",
    }));
  }

  for (const transition of stepLayout?.transitions || []) {
    const fromY = plot.yByState?.[transition?.fromState];
    const toY = plot.yByState?.[transition?.toState];
    if (!Number.isFinite(fromY) || !Number.isFinite(toY) || !(durationMs > 0)) continue;
    const x = xForTime(transition.atMs);
    svg.appendChild(createSvgElement(doc, "line", {
      x1: x,
      x2: x,
      y1: fromY,
      y2: toY,
      class: "bwc-history-transition",
      "data-bwc-transition-ms": transition.atMs,
      "data-bwc-transition-from": transition.fromState,
      "data-bwc-transition-to": transition.toState,
      "vector-effect": "non-scaling-stroke",
    }));
  }

  const renderedObservations = { LOW: [], MODERATE: [], SEVERE: [] };

  if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && durationMs > 0) {
    for (const tickData of ticks) {
      const ratio = (tickData.timeMs - rangeStart) / durationMs;
      const x = plot.left + ratio * plot.width;
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
        "text-anchor": ratio < 0.055 ? "start" : ratio > 0.945 ? "end" : "middle",
        class: "bwc-history-axis-label bwc-history-time-label",
      });
      tick.textContent = tickData.label;
      svg.appendChild(tick);
    }
  }

  // Keep exact evidence above the step and grid strokes. Sparse views retain
  // one visible circle node per observation. Dense views keep the same
  // exact centers but batch their round-capped subpaths by state, preventing a
  // full annual ledger from creating tens of thousands of SVG DOM elements.
  // Pointer hit testing stays on one transparent interaction surface and one
  // movable focus proxy exposes the exact observations to keyboard users.
  if (durationMs > 0) {
    for (const observation of observations) {
      const y = plot.yByState?.[observation?.state];
      if (!Number.isFinite(y)) continue;
      renderedObservations[observation.state].push(observation);
    }

    if (observations.length <= SPARSE_OBSERVATION_MARKER_LIMIT) {
      for (const observation of observations) {
        const y = plot.yByState?.[observation?.state];
        if (!Number.isFinite(y)) continue;
        const marker = createSvgElement(doc, "circle", {
          cx: svgCoordinate(xForTime(observation.timeMs)),
          cy: svgCoordinate(y),
          r: svgCoordinate(markerRadius),
          class: `bwc-history-observation-marker bwc-history-observation-${String(observation.state || "unknown").toLowerCase()}`,
          "data-bwc-observation-ms": observation.timeMs,
          "data-bwc-observation-radius": svgCoordinate(markerRadius),
          "vector-effect": "non-scaling-stroke",
          "aria-hidden": "true",
        });
        svg.appendChild(marker);
      }
    } else {
      for (const state of ["LOW", "MODERATE", "SEVERE"]) {
        const stateObservations = renderedObservations[state];
        const y = plot.yByState?.[state];
        if (!stateObservations.length || !Number.isFinite(y)) continue;
        const pathData = observationMarkerPath(stateObservations, xForTime, y);
        svg.appendChild(createSvgElement(doc, "path", {
          d: pathData,
          class: "bwc-history-observation-marker bwc-history-observation-marker-batch bwc-history-observation-outline",
          "data-bwc-observation-layer": "outline",
          "stroke-width": svgCoordinate(markerRadius * 2 + 0.9),
          "vector-effect": "non-scaling-stroke",
          "aria-hidden": "true",
        }));
        svg.appendChild(createSvgElement(doc, "path", {
          d: pathData,
          class: `bwc-history-observation-marker bwc-history-observation-marker-batch bwc-history-observation-${state.toLowerCase()}`,
          "data-bwc-observation-layer": "color",
          "data-bwc-observation-count": stateObservations.length,
          "stroke-width": svgCoordinate(markerRadius * 2),
          "vector-effect": "non-scaling-stroke",
          "aria-hidden": "true",
        }));
      }
    }
  }

  // Keep every exact event cue while bounding the event-marker DOM to one
  // compound path per state. Dense 90-day/year views therefore do not turn
  // thousands of truthful events into thousands of SVG elements.
  const shortMarkerDisplayRadius = shortEvents.length > 60 ? 2.25 : shortEvents.length > 24 ? 3 : 5;
  const shortMarkerRadius = shortMarkerDisplayRadius / Math.max(0.75, displayScaleX);
  const shortEventsByState = { LOW: [], MODERATE: [], SEVERE: [] };
  for (const event of shortEvents) {
    if (shortEventsByState[event.state]) shortEventsByState[event.state].push(event);
  }
  for (const state of ["LOW", "MODERATE", "SEVERE"]) {
    const stateEvents = shortEventsByState[state];
    if (!stateEvents.length) continue;
    const attributes = {
      d: diamondMarkerPath(stateEvents, xForTime, yForEvidence, shortMarkerRadius),
      class: `bwc-history-short-event-marker bwc-history-short-event-${state.toLowerCase()}`,
      "data-bwc-event-count": stateEvents.length,
      "data-bwc-event-radius": svgCoordinate(shortMarkerRadius),
      "vector-effect": "non-scaling-stroke",
      "aria-hidden": "true",
    };
    if (stateEvents.length === 1) {
      const [event] = stateEvents;
      attributes["data-bwc-event-start-ms"] = event.startMs;
      attributes["data-bwc-event-end-ms"] = event.endMs;
      attributes["data-bwc-event-duration-ms"] = event.durationMs;
      attributes["data-bwc-event-center-ms"] = event.timeMs;
      attributes["data-bwc-event-width-px"] = svgCoordinate(event.widthPx);
    }
    svg.appendChild(createSvgElement(doc, "path", attributes));
  }

  const changeMarkerRadius = 3.75 / Math.max(0.75, displayScaleX);
  const changesByState = { LOW: [], MODERATE: [], SEVERE: [] };
  for (const transition of confirmedTransitions) {
    if (changesByState[transition.toState]) changesByState[transition.toState].push(transition);
  }
  for (const state of ["LOW", "MODERATE", "SEVERE"]) {
    const stateChanges = changesByState[state];
    if (!stateChanges.length) continue;
    svg.appendChild(createSvgElement(doc, "path", {
      d: diamondMarkerPath(stateChanges, xForTime, yForEvidence, changeMarkerRadius),
      class: `bwc-history-change-marker bwc-history-change-${state.toLowerCase()}`,
      "data-bwc-change-count": stateChanges.length,
      "data-bwc-change-radius": svgCoordinate(changeMarkerRadius),
      "vector-effect": "non-scaling-stroke",
      "aria-hidden": "true",
    }));
  }

  const eventTargets = mergeSortedEvidence(shortEvents, confirmedTransitions);
  const activeHighlight = observations.length || eventTargets.length ? createSvgElement(doc, "circle", {
    r: svgCoordinate(markerRadius + 2.5),
    class: "bwc-history-evidence-highlight",
    visibility: "hidden",
    "vector-effect": "non-scaling-stroke",
    "aria-hidden": "true",
  }) : null;
  if (activeHighlight) svg.appendChild(activeHighlight);

  const interaction = createSvgElement(doc, "rect", {
    x: plot.left,
    y: Math.max(0, plot.top - 10),
    width: plot.width,
    height: plot.height + 20,
    class: "bwc-history-hit-area",
    tabindex: 0,
    "aria-label": "BWC history chart navigation; use the mouse wheel to zoom and drag or use the arrow keys to pan when zoomed",
  });
  svg.appendChild(interaction);

  const focusTarget = observations.length ? createSvgElement(doc, "circle", {
    r: svgCoordinate(markerRadius + 3.5),
    class: "bwc-history-observation-focus-target",
    tabindex: 0,
    role: "button",
    "aria-roledescription": "BWC observation marker",
    "aria-keyshortcuts": "ArrowLeft ArrowRight Home End Enter Space Escape",
    "vector-effect": "non-scaling-stroke",
  }) : null;
  if (focusTarget && tooltip?.getAttribute?.("id")) {
    focusTarget.setAttribute("aria-controls", tooltip.getAttribute("id"));
  }
  if (focusTarget) svg.appendChild(focusTarget);
  const eventFocusTarget = eventTargets.length ? createSvgElement(doc, "circle", {
    r: svgCoordinate(shortMarkerRadius + 3),
    class: "bwc-history-event-focus-target",
    tabindex: 0,
    role: "button",
    "aria-roledescription": "BWC event marker",
    "aria-keyshortcuts": "ArrowLeft ArrowRight Home End Enter Space Escape",
    "vector-effect": "non-scaling-stroke",
  }) : null;
  if (eventFocusTarget && tooltip?.getAttribute?.("id")) {
    eventFocusTarget.setAttribute("aria-controls", tooltip.getAttribute("id"));
  }
  if (eventFocusTarget) svg.appendChild(eventFocusTarget);
  container.insertBefore(svg, tooltip || null);

  let pinned = false;
  let focusIndex = 0;
  let eventFocusIndex = 0;
  let lastPointerType = "mouse";
  function hideTooltip() {
    pinned = false;
    if (tooltip) tooltip.hidden = true;
    activeHighlight?.setAttribute("visibility", "hidden");
  }
  function observationLabel(observation, index) {
    return [
      `BWC observation ${index + 1} of ${observations.length}`,
      String(observation?.state || "UNKNOWN").toUpperCase(),
      safeFormat(formatBwcZuluTime, observation?.timeMs),
      safeFormat(formatBwcMemphisTime, observation?.timeMs, "LOCAL TIME UNKNOWN"),
      `Source ${String(observation?.source || "USAHAS").trim().toUpperCase()}`,
      `Basis ${basisDescription(observation)}`,
      "Use Left and Right Arrow keys for adjacent observations",
    ].join("; ");
  }
  function eventLabel(evidence, index) {
    if (evidence?.evidenceKind === "short-event") {
      return [
        `Short BWC event ${index + 1} of ${eventTargets.length}`,
        String(evidence.state || "UNKNOWN").toUpperCase(),
        `${safeFormat(formatBwcZuluTime, evidence.startMs)} through ${safeFormat(formatBwcZuluTime, evidence.endMs)}`,
        `Duration ${formatBwcDuration(evidence.durationMs) || "unknown"}`,
        `Source ${String(evidence.source || "USAHAS").trim().toUpperCase()}`,
        `Basis ${evidenceBasisDescription(evidence)}`,
        "Use Left and Right Arrow keys for adjacent event markers",
      ].join("; ");
    }
    return [
      `BWC state change ${index + 1} of ${eventTargets.length}`,
      `${String(evidence?.fromState || "UNKNOWN").toUpperCase()} to ${String(evidence?.toState || "UNKNOWN").toUpperCase()}`,
      safeFormat(formatBwcZuluTime, evidence?.timeMs),
      safeFormat(formatBwcMemphisTime, evidence?.timeMs, "LOCAL TIME UNKNOWN"),
      `Source ${String(evidence?.source || "USAHAS").trim().toUpperCase()}`,
      `Basis ${basisDescription(evidence)}`,
      "Use Left and Right Arrow keys for adjacent event markers",
    ].join("; ");
  }
  function updateFocusTarget(index) {
    if (!focusTarget || !observations.length) return null;
    focusIndex = Math.max(0, Math.min(observations.length - 1, index));
    const observation = observations[focusIndex];
    const y = plot.yByState?.[observation?.state];
    if (!Number.isFinite(y)) return null;
    focusTarget.setAttribute("cx", svgCoordinate(xForTime(observation.timeMs)));
    focusTarget.setAttribute("cy", svgCoordinate(y));
    focusTarget.setAttribute("data-bwc-observation-ms", observation.timeMs);
    focusTarget.setAttribute("data-bwc-observation-index", focusIndex);
    focusTarget.setAttribute("aria-label", observationLabel(observation, focusIndex));
    return observation;
  }
  function updateEventFocusTarget(index) {
    if (!eventFocusTarget || !eventTargets.length) return null;
    eventFocusIndex = Math.max(0, Math.min(eventTargets.length - 1, index));
    const evidence = eventTargets[eventFocusIndex];
    const y = yForEvidence(evidence);
    if (!Number.isFinite(y)) return null;
    eventFocusTarget.setAttribute("cx", svgCoordinate(xForTime(evidence.timeMs)));
    eventFocusTarget.setAttribute("cy", svgCoordinate(y));
    eventFocusTarget.setAttribute("data-bwc-event-kind", evidence.evidenceKind);
    eventFocusTarget.setAttribute("data-bwc-event-index", eventFocusIndex);
    eventFocusTarget.setAttribute("data-bwc-event-ms", evidence.timeMs);
    eventFocusTarget.setAttribute("aria-roledescription", evidence.evidenceKind === "short-event"
      ? "BWC short-duration event marker"
      : "BWC state-change marker");
    eventFocusTarget.setAttribute("aria-label", eventLabel(evidence, eventFocusIndex));
    return evidence;
  }
  function eventAtEvidence(evidence) {
    const rect = svg.getBoundingClientRect?.();
    const y = yForEvidence(evidence);
    if (!rect?.width || !rect?.height || !Number.isFinite(y)) return null;
    return {
      clientX: rect.left + xForTime(evidence.timeMs) * rect.width / width,
      clientY: rect.top + y * rect.height / height,
    };
  }
  function showHighlight(evidence) {
    const y = yForEvidence(evidence);
    if (!activeHighlight || !Number.isFinite(y) || !Number.isFinite(Number(evidence?.timeMs))) return;
    activeHighlight.setAttribute("cx", svgCoordinate(xForTime(evidence.timeMs)));
    activeHighlight.setAttribute("cy", svgCoordinate(y));
    activeHighlight.setAttribute("r", svgCoordinate(evidence.evidenceKind === "short-event"
      ? shortMarkerRadius + 2
      : evidence.evidenceKind === "transition"
        ? 5.25 / Math.max(0.75, displayScaleX)
        : markerRadius + 2.5));
    activeHighlight.setAttribute("data-bwc-highlight-kind", evidence.evidenceKind || "observation");
    activeHighlight.setAttribute("class", `bwc-history-evidence-highlight bwc-history-highlight-${String(evidence.state || "unknown").toLowerCase()}`);
    activeHighlight.setAttribute("visibility", "visible");
  }
  function showObservation(observation, event = null, shouldPin = false) {
    if (!observation) {
      hideTooltip();
      return false;
    }
    if (shouldPin) pinned = true;
    showHighlight({ ...observation, evidenceKind: "observation" });
    return showChartTooltip(
      doc,
      tooltip,
      container,
      event || eventAtEvidence(observation),
      observation,
    );
  }
  function showEvent(evidence, event = null, shouldPin = false) {
    if (!evidence) {
      hideTooltip();
      return false;
    }
    if (shouldPin) pinned = true;
    showHighlight(evidence);
    return showBwcEventTooltip(
      doc,
      tooltip,
      container,
      event || eventAtEvidence(evidence),
      evidence,
    );
  }
  function nearestObservation(event, rect, pointerType = event?.pointerType) {
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !rect?.width || !rect?.height) return null;
    const svgX = (clientX - rect.left) * width / rect.width;
    const svgY = (clientY - rect.top) * height / rect.height;
    const targetTimeMs = rangeStart + Math.max(0, Math.min(1, (svgX - plot.left) / plot.width)) * durationMs;
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;
    const thresholdPx = pointerType === "touch"
      ? 22
      : pointerType === "pen"
        ? 14
        : Math.max(4, markerRadius * Math.min(scaleX, scaleY) + 1.5);
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const state of ["LOW", "MODERATE", "SEVERE"]) {
      const stateMarkers = renderedObservations[state];
      let low = 0;
      let high = stateMarkers.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (stateMarkers[middle].timeMs < targetTimeMs) low = middle + 1;
        else high = middle;
      }
      for (const index of [low - 1, low]) {
        const observation = stateMarkers[index];
        if (!observation) continue;
        const markerX = xForTime(observation.timeMs);
        const markerY = plot.yByState?.[observation.state];
        const distance = Math.hypot(
          (markerX - svgX) * scaleX,
          (markerY - svgY) * scaleY,
        );
        if (distance <= thresholdPx && distance < nearestDistance) {
          nearest = observation;
          nearestDistance = distance;
        }
      }
    }
    return nearest ? { evidence: nearest, distancePx: nearestDistance } : null;
  }
  function nearestEvent(event, rect, pointerType = event?.pointerType) {
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !rect?.width || !rect?.height) return null;
    const svgX = (clientX - rect.left) * width / rect.width;
    const svgY = (clientY - rect.top) * height / rect.height;
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;
    const thresholdPx = pointerType === "touch" ? 22 : pointerType === "pen" ? 14 : 7;
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const targetTimeMs = rangeStart + Math.max(0, Math.min(1, (svgX - plot.left) / plot.width)) * durationMs;
    let low = 0;
    let high = eventTargets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (eventTargets[middle].timeMs < targetTimeMs) low = middle + 1;
      else high = middle;
    }
    // Only the nearest chronological candidates can fall inside the fixed
    // pointer radius. Inspect a small bounded neighborhood instead of scanning
    // an annual event ledger on every pointer move.
    const firstCandidate = Math.max(0, low - 4);
    const lastCandidate = Math.min(eventTargets.length, low + 4);
    for (let index = firstCandidate; index < lastCandidate; index += 1) {
      const evidence = eventTargets[index];
      const markerY = yForEvidence(evidence);
      if (!Number.isFinite(markerY)) continue;
      const markerX = xForTime(evidence.timeMs);
      const distance = Math.hypot((markerX - svgX) * scaleX, (markerY - svgY) * scaleY);
      if (distance <= thresholdPx && distance < nearestDistance) {
        nearest = evidence;
        nearestDistance = distance;
      }
    }
    return nearest ? { evidence: nearest, distancePx: nearestDistance } : null;
  }
  function inspect(event, shouldPin = false, pointerType = event?.pointerType) {
    if (!(durationMs > 0)) return;
    if (container.classList?.contains("bwc-history-panning")) {
      hideTooltip();
      return;
    }
    const rect = svg.getBoundingClientRect?.();
    if (!rect?.width) return;
    const observationMatch = nearestObservation(event, rect, pointerType);
    const eventMatch = nearestEvent(event, rect, pointerType);
    const match = eventMatch && (!observationMatch || eventMatch.distancePx < observationMatch.distancePx)
      ? eventMatch
      : observationMatch;
    if (!match) {
      hideTooltip();
      return;
    }
    if (match.evidence.evidenceKind === "short-event" || match.evidence.evidenceKind === "transition") {
      showEvent(match.evidence, event, shouldPin);
    } else {
      showObservation(match.evidence, event, shouldPin);
    }
  }
  interaction.addEventListener("pointerdown", (event) => {
    lastPointerType = event.pointerType || "mouse";
  });
  interaction.addEventListener("pointermove", (event) => {
    const pointerType = event.pointerType || "mouse";
    lastPointerType = pointerType;
    if (pointerType === "touch") return;
    pinned = false;
    inspect(event, false, pointerType);
  });
  interaction.addEventListener("pointerleave", () => {
    if (!pinned) hideTooltip();
  });
  interaction.addEventListener("click", (event) => {
    const suppressUntil = finiteNumber(container.dataset?.bwcSuppressClickUntil, 0);
    if (Date.now() < suppressUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    inspect(event, true, event.pointerType || lastPointerType);
  });
  interaction.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const tooltipWasVisible = Boolean(tooltip && !tooltip.hidden);
      hideTooltip();
      if (tooltipWasVisible) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    hideTooltip();
  });
  if (focusTarget) {
    updateFocusTarget(0);
    focusTarget.addEventListener("focus", () => {
      const observation = updateFocusTarget(focusIndex);
      showObservation(observation, null, true);
    });
    focusTarget.addEventListener("blur", hideTooltip);
    focusTarget.addEventListener("keydown", (event) => {
      let nextIndex = focusIndex;
      if (event.key === "ArrowLeft") nextIndex -= 1;
      else if (event.key === "ArrowRight") nextIndex += 1;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = observations.length - 1;
      else if (event.key === "Escape") {
        const tooltipWasVisible = Boolean(tooltip && !tooltip.hidden);
        hideTooltip();
        if (tooltipWasVisible) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showObservation(observations[focusIndex], null, true);
        return;
      } else return;
      event.preventDefault();
      const observation = updateFocusTarget(nextIndex);
      showObservation(observation, null, true);
    });
  }
  if (eventFocusTarget) {
    updateEventFocusTarget(0);
    eventFocusTarget.addEventListener("focus", () => {
      const evidence = updateEventFocusTarget(eventFocusIndex);
      showEvent(evidence, null, true);
    });
    eventFocusTarget.addEventListener("blur", hideTooltip);
    eventFocusTarget.addEventListener("keydown", (event) => {
      let nextIndex = eventFocusIndex;
      if (event.key === "ArrowLeft") nextIndex -= 1;
      else if (event.key === "ArrowRight") nextIndex += 1;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = eventTargets.length - 1;
      else if (event.key === "Escape") {
        const tooltipWasVisible = Boolean(tooltip && !tooltip.hidden);
        hideTooltip();
        if (tooltipWasVisible) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showEvent(eventTargets[eventFocusIndex], null, true);
        return;
      } else return;
      event.preventDefault();
      const evidence = updateEventFocusTarget(nextIndex);
      showEvent(evidence, null, true);
    });
  }
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

export function bwcPlotPointerRatio(chart, event) {
  const hitArea = chart?.querySelector?.(".bwc-history-hit-area");
  const rect = hitArea?.getBoundingClientRect?.();
  const clientX = Number(event?.clientX);
  if (!rect || !Number.isFinite(rect.left) || !(rect.width > 0) || !Number.isFinite(clientX)) return null;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function viewportDurationLabel(durationMs) {
  const minutes = Math.max(1, Math.round(finiteNumber(durationMs, 0) / 60000));
  if (minutes < 60) return `${minutes} MIN WINDOW`;
  const hours = minutes / 60;
  if (hours < 48) return `${Number(hours.toFixed(hours < 10 && !Number.isInteger(hours) ? 1 : 0))} HR WINDOW`;
  const days = hours / 24;
  return `${Number(days.toFixed(days < 10 && !Number.isInteger(days) ? 1 : 0))} DAY WINDOW`;
}

function sameVisibleDomain(left, right) {
  return Boolean(left && right
    && Math.abs(finiteNumber(left.startMs, NaN) - finiteNumber(right.startMs, NaN)) < 0.5
    && Math.abs(finiteNumber(left.endMs, NaN) - finiteNumber(right.endMs, NaN)) < 0.5);
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
  const zoomOutButton = doc.getElementById("bwcHistoryZoomOut");
  const zoomInButton = doc.getElementById("bwcHistoryZoomIn");
  const zoomResetButton = doc.getElementById("bwcHistoryZoomReset");
  const zoomStatus = doc.getElementById("bwcHistoryZoomStatus");
  const exportButton = doc.getElementById("bwcHistoryExportCsv");
  const summaryContent = doc.getElementById("bwcHistorySummaryContent");
  const summaryContext = doc.getElementById("bwcHistorySummaryContext");
  const exportStatus = doc.getElementById("bwcHistoryExportStatus");
  const rangeButtons = [...doc.querySelectorAll("[data-bwc-range]")];
  const summaryButtons = [...doc.querySelectorAll("[data-bwc-summary-mode]")];
  if (!overlay || !panel || !closeButton || !status || !chart || !current || !lastChange || !stats || !archive || !legend
      || !zoomOutButton || !zoomInButton || !zoomResetButton || !zoomStatus || !exportButton || !summaryContent
      || !summaryContext || !exportStatus || !rangeButtons.length || !summaryButtons.length) return null;

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
  let viewportRenderFrame = 0;
  let viewportRenderQueued = false;
  let masterRange = null;
  let timeDomain = null;
  let viewportRangeKey = null;
  let panSession = null;
  let summaryMode = "daily";
  let selectedTimeline = null;
  let selectedSummary = null;

  renderLegend(doc, legend);
  updateRangeButtons(rangeButtons, activeRange);
  updateBwcSummaryModeButtons(summaryButtons, summaryMode);

  function updateSummaryPresentation() {
    const rangeLabel = RANGE_UI_LABELS[activeRange] || String(activeRange).toUpperCase();
    exportButton.disabled = !selectedTimeline || !selectedSummary?.ok;
    exportButton.setAttribute("aria-label", `Export selected ${rangeLabel} BWC history as CSV`);
    renderBwcSummaryTable(doc, summaryContent, summaryContext, selectedSummary, summaryMode, rangeLabel);
  }

  function updateViewportControls() {
    const ready = Boolean(history && timeDomain?.ok);
    zoomInButton.disabled = !ready || !timeDomain.canZoomIn;
    zoomOutButton.disabled = !ready || !timeDomain.canZoomOut;
    zoomResetButton.disabled = !ready || timeDomain.isFullRange;
    chart.classList.toggle("bwc-history-chart-zoomed", ready && !timeDomain.isFullRange);
    for (const key of ["bwcVisibleStartMs", "bwcVisibleEndMs", "bwcVisibleDurationMs", "bwcMasterStartMs", "bwcMasterEndMs"]) {
      if (!ready) delete chart.dataset[key];
    }
    if (ready) {
      chart.dataset.bwcVisibleStartMs = String(timeDomain.startMs);
      chart.dataset.bwcVisibleEndMs = String(timeDomain.endMs);
      chart.dataset.bwcVisibleDurationMs = String(timeDomain.durationMs);
      chart.dataset.bwcMasterStartMs = String(timeDomain.masterStartMs);
      chart.dataset.bwcMasterEndMs = String(timeDomain.masterEndMs);
    }
    if (!ready || timeDomain.isFullRange) {
      zoomStatus.textContent = "FULL RANGE";
      zoomStatus.removeAttribute("title");
      return;
    }
    zoomStatus.textContent = viewportDurationLabel(timeDomain.durationMs);
    zoomStatus.setAttribute(
      "title",
      `${safeFormat(formatBwcZuluTime, timeDomain.startMs)} – ${safeFormat(formatBwcZuluTime, timeDomain.endMs)}`,
    );
  }

  function hideChartTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function buildTimeline(range, nowMs) {
    const result = buildBwcTimeline(history, range, nowMs);
    return result?.ok === false ? null : result?.value || result;
  }

  function renderChartViewport(nowMs = currentBoardNowMs(view)) {
    if (!history || !timeDomain?.ok) return false;
    const timeline = buildTimeline({
      key: activeRange,
      label: String(activeRange).toUpperCase(),
      startMs: timeDomain.startMs,
      endMs: timeDomain.endMs,
      durationMs: timeDomain.durationMs,
    }, nowMs);
    if (!timeline?.range || !Array.isArray(timeline.segments)) {
      setEmptyChart(doc, chart, "BWC HISTORY CHART UNAVAILABLE");
      updateViewportControls();
      return false;
    }
    renderBwcHistoryChart(doc, chart, tooltip, timeline, {
      masterDurationMs: timeDomain.masterEndMs - timeDomain.masterStartMs,
    });
    updateViewportControls();
    return true;
  }

  function cancelScheduledViewportRender() {
    if (viewportRenderFrame && view.cancelAnimationFrame) {
      view.cancelAnimationFrame(viewportRenderFrame);
    }
    viewportRenderFrame = 0;
    viewportRenderQueued = false;
  }

  function scheduleViewportRender() {
    if (viewportRenderQueued) return true;
    viewportRenderQueued = true;
    const schedule = view.requestAnimationFrame || ((callback) => { callback(); return 0; });
    const frame = schedule(() => {
      viewportRenderQueued = false;
      viewportRenderFrame = 0;
      if (!overlay.hidden) renderChartViewport();
    });
    // A synchronous test/fallback scheduler may have already run the callback.
    if (viewportRenderQueued) viewportRenderFrame = frame;
    return true;
  }

  function applyViewport(nextDomain, deferRender = false) {
    if (!nextDomain?.ok || sameVisibleDomain(timeDomain, nextDomain)) return false;
    timeDomain = nextDomain;
    hideChartTooltip();
    updateViewportControls();
    if (deferRender) return scheduleViewportRender();
    cancelScheduledViewportRender();
    return renderChartViewport();
  }

  function resetViewport() {
    if (!timeDomain?.ok) return false;
    return applyViewport(resetBwcTimeDomain(timeDomain));
  }

  function zoomViewport(factor, anchor = 0.5, deferRender = false) {
    if (!timeDomain?.ok) return false;
    return applyViewport(zoomBwcTimeDomain(timeDomain, factor, anchor), deferRender);
  }

  function panViewport(deltaMs, deferRender = false) {
    if (!timeDomain?.ok || timeDomain.isFullRange) return false;
    return applyViewport(panBwcTimeDomain(timeDomain, deltaMs), deferRender);
  }

  updateViewportControls();

  function clearHistoryPresentation(message) {
    masterRange = null;
    timeDomain = null;
    viewportRangeKey = null;
    selectedTimeline = null;
    selectedSummary = null;
    hideChartTooltip();
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
    exportButton.disabled = true;
    exportStatus.textContent = "";
    updateSummaryPresentation();
    updateViewportControls();
  }

  function render(resetDomain = false) {
    cancelScheduledViewportRender();
    renderCurrent(doc, current, view.kmemWeatherData);
    if (!history) {
      if (loadError) clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    const nowMs = currentBoardNowMs(view);
    let masterTimeline;
    try {
      const nextMasterRange = getBwcRange(activeRange, nowMs);
      if (resetDomain || viewportRangeKey !== activeRange || !timeDomain?.ok) {
        timeDomain = createBwcTimeDomain(nextMasterRange);
      } else if (masterRange?.startMs !== nextMasterRange.startMs || masterRange?.endMs !== nextMasterRange.endMs) {
        const previousAtLatestEdge = !timeDomain.canPanForward;
        const endShiftMs = nextMasterRange.endMs - finiteNumber(masterRange?.endMs, nextMasterRange.endMs);
        const preservedVisible = timeDomain.isFullRange
          ? nextMasterRange
          : {
              startMs: timeDomain.startMs + (previousAtLatestEdge ? endShiftMs : 0),
              endMs: timeDomain.endMs + (previousAtLatestEdge ? endShiftMs : 0),
            };
        timeDomain = createBwcTimeDomain(nextMasterRange, preservedVisible);
      }
      if (!timeDomain?.ok) throw new Error(timeDomain?.error?.message || "Invalid BWC chart time domain");
      masterRange = nextMasterRange;
      viewportRangeKey = activeRange;
      masterTimeline = buildTimeline(masterRange, nowMs);
    } catch (error) {
      loadError = error;
      setStatus(status, "BWC HISTORY UNAVAILABLE", "History calculations could not be completed.", "error");
      clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    if (!masterTimeline?.range || !Array.isArray(masterTimeline?.segments)) {
      loadError = new Error("Invalid history timeline");
      setStatus(status, "BWC HISTORY UNAVAILABLE", "History data is malformed or unsupported.", "error");
      clearHistoryPresentation("BWC HISTORY UNAVAILABLE");
      return;
    }
    // Summary/statistics semantics remain tied to the selected master range;
    // only the chart and tooltip consume the zoomed visible range.
    const statistics = calculateBwcStatistics(masterTimeline);
    selectedTimeline = masterTimeline;
    try {
      selectedSummary = summarizeBwcHistory(masterTimeline);
    } catch {
      selectedSummary = null;
    }
    if (staleArchive(history, nowMs)) {
      setStatus(status, "BWC HISTORY UNAVAILABLE", "The archive is stale; preserved historical coverage is shown below.", "error");
    } else if (!history.runs?.length) {
      setStatus(status, "AWAITING LIVE DATA", "The archive begins with the first valid direct USAHAS result.", "warning");
    } else {
      setStatus(status, "BWC HISTORY READY", `${String(activeRange).toUpperCase()} rolling UTC view`, "success");
    }
    renderChartViewport(nowMs);
    renderLastChange(doc, lastChange, masterTimeline);
    renderStatistics(doc, stats, statistics);
    renderAvailability(doc, archive, history, statistics, nowMs);
    exportStatus.textContent = "";
    updateSummaryPresentation();
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
    cancelScheduledViewportRender();
    if (panSession) {
      try { chart.releasePointerCapture?.(panSession.pointerId); } catch { /* capture may already be released */ }
      panSession = null;
      chart.classList.remove("bwc-history-panning");
    }
    applyBwcHistoryDialogState(
      { overlay, body: doc.body, focusTarget: closeButton, returnFocus },
      false,
    );
  }

  zoomOutButton.addEventListener("click", () => zoomViewport(0.5));
  zoomInButton.addEventListener("click", () => zoomViewport(2));
  zoomResetButton.addEventListener("click", resetViewport);

  exportButton.addEventListener("click", () => {
    if (!selectedTimeline || exportButton.disabled) return;
    let exportResult;
    try {
      exportResult = buildBwcCsvExport(selectedTimeline, {
        rangeLabel: RANGE_EXPORT_LABELS[activeRange] || String(activeRange).toUpperCase(),
        dateValue: currentBoardNowMs(view),
      });
    } catch {
      exportResult = null;
    }
    if (!exportResult?.ok) {
      exportStatus.textContent = "CSV EXPORT UNAVAILABLE";
      return;
    }
    const downloaded = downloadBwcCsv(doc, view, exportResult);
    exportStatus.textContent = downloaded.ok
      ? `DOWNLOADED ${downloaded.filename}`
      : "CSV EXPORT UNAVAILABLE";
  });

  chart.addEventListener("wheel", (event) => {
    if (!history || !timeDomain?.ok || event.deltaY === 0) return;
    const anchor = bwcPlotPointerRatio(chart, event);
    if (anchor === null) return;
    event.preventDefault();
    hideChartTooltip();
    const deltaPixels = Math.abs(event.deltaY) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1);
    const strength = Math.max(0.2, Math.min(2, deltaPixels / 100));
    const factor = Math.pow(1.25, event.deltaY < 0 ? strength : -strength);
    zoomViewport(factor, anchor, true);
  }, { passive: false });

  chart.addEventListener("pointerdown", (event) => {
    if (!history || !timeDomain?.ok || timeDomain.isFullRange || event.isPrimary === false) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const hitArea = event.target.closest?.(".bwc-history-hit-area");
    const rect = hitArea?.getBoundingClientRect?.();
    if (!hitArea || !(rect?.width > 0)) return;
    panSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      plotWidth: rect.width,
      moved: false,
    };
    chart.setPointerCapture?.(event.pointerId);
  });

  chart.addEventListener("pointermove", (event) => {
    if (!panSession || event.pointerId !== panSession.pointerId || !timeDomain?.ok) return;
    const totalX = event.clientX - panSession.startX;
    if (!panSession.moved && Math.abs(totalX) < 3) return;
    const deltaX = panSession.moved ? event.clientX - panSession.lastX : totalX;
    panSession.moved = true;
    panSession.lastX = event.clientX;
    chart.classList.add("bwc-history-panning");
    hideChartTooltip();
    event.preventDefault();
    panViewport(-(deltaX / panSession.plotWidth) * timeDomain.durationMs, true);
  });

  function endPan(event) {
    if (!panSession || (event?.pointerId !== undefined && event.pointerId !== panSession.pointerId)) return;
    const finished = panSession;
    panSession = null;
    if (finished.moved) chart.dataset.bwcSuppressClickUntil = String(Date.now() + 400);
    chart.classList.remove("bwc-history-panning");
    try { chart.releasePointerCapture?.(finished.pointerId); } catch { /* capture may already be released */ }
  }

  chart.addEventListener("pointerup", endPan);
  chart.addEventListener("pointercancel", endPan);
  chart.addEventListener("lostpointercapture", endPan);
  chart.addEventListener("keydown", (event) => {
    if (!event.target.closest?.(".bwc-history-hit-area") || !timeDomain?.ok || timeDomain.isFullRange) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    panViewport(direction * timeDomain.durationMs * 0.1);
  });

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
      if (!RANGE_KEYS.has(nextRange)) return;
      activeRange = nextRange;
      masterRange = null;
      timeDomain = null;
      viewportRangeKey = null;
      updateRangeButtons(rangeButtons, activeRange);
      if (history) render(true);
    });
  }
  for (const summaryButton of summaryButtons) {
    summaryButton.addEventListener("click", () => {
      const nextMode = summaryButton.dataset.bwcSummaryMode;
      if (!SUMMARY_MODES.has(nextMode)) return;
      summaryMode = updateBwcSummaryModeButtons(summaryButtons, nextMode);
      exportStatus.textContent = "";
      updateSummaryPresentation();
    });
  }
  view.addEventListener?.("resize", () => {
    if (overlay.hidden || !history) return;
    cancelScheduledViewportRender();
    if (renderFrame && view.cancelAnimationFrame) view.cancelAnimationFrame(renderFrame);
    const schedule = view.requestAnimationFrame || ((callback) => { callback(); return 0; });
    renderFrame = schedule(() => {
      renderFrame = 0;
      // Resize changes chart geometry, not the selected archive range. Keep
      // the cached master-range summary/export intact and redraw only the
      // visible chart viewport.
      renderChartViewport();
    });
  });

  return {
    open,
    close,
    render,
    refreshCurrent,
    zoomIn: (anchor = 0.5) => zoomViewport(2, anchor),
    zoomOut: (anchor = 0.5) => zoomViewport(0.5, anchor),
    pan: panViewport,
    resetViewport,
    get activeRange() { return activeRange; },
    get summaryMode() { return summaryMode; },
    get timeDomain() { return timeDomain; },
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
