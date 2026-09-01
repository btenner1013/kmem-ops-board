import { formatMeteogramTime } from "./weather-meteogram-core.js";
import {
  buildMeteogramSvgMarkup,
  meteogramRowLabelLayout,
  meteogramSelectedRangeScales,
} from "./weather-meteogram.js";

const HOUR_MS = 60 * 60 * 1000;
const PRINT_PAGE_HOURS = 12;
const PRINT_VIEWBOX_WIDTH = 1540;
const PRINT_INTERVAL_KEYS = Object.freeze([
  "observedPrecipitationIntervals",
  "observedSnowDepthIncreaseIntervals",
  "forecastPrecipitationIntervals",
  "forecastSnowfallIntervals",
]);

function escapeMarkup(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function finiteTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return check.getUTCFullYear() === parts.year
    && check.getUTCMonth() + 1 === parts.month
    && check.getUTCDate() === parts.day
    ? parts
    : null;
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

function nextDateText(value) {
  const parts = parseDate(value);
  if (!parts) return "";
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return next.toISOString().slice(0, 10);
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function sameWallTime(left, right) {
  return ["year", "month", "day", "hour", "minute"].every((key) => left[key] === right[key]);
}

export function meteogramWallTimeToUtc({ date, time = "00:00", timeZone, disambiguation = "earlier" } = {}) {
  const dateParts = parseDate(date);
  const timeParts = parseTime(time);
  if (!dateParts || !timeParts || !timeZone) return { ok: false, error: "Enter a valid date and time." };
  const target = { ...dateParts, ...timeParts };
  const naive = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * HOUR_MS;
    const parts = zonedParts(sample, timeZone);
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - sample);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => sameWallTime(zonedParts(candidate, timeZone), target))
    .sort((left, right) => left - right);
  if (!candidates.length) {
    return { ok: false, error: `${date} ${time} does not exist in ${timeZone} because of a clock change.` };
  }
  const timestamp = disambiguation === "later" ? candidates.at(-1) : candidates[0];
  return {
    ok: true,
    timestamp,
    valueZ: iso(timestamp),
    ambiguous: candidates.length > 1,
    candidates: candidates.map(iso),
  };
}

export function meteogramCalendarDayRange({ date, timeMode = "Z", timeZone = "America/Chicago" } = {}) {
  const dateParts = parseDate(date);
  if (!dateParts) return { ok: false, error: "Choose a valid calendar date." };
  const nextDate = nextDateText(date);
  if (String(timeMode).toUpperCase() === "Z") {
    const start = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day);
    const next = parseDate(nextDate);
    const end = Date.UTC(next.year, next.month - 1, next.day);
    return { ok: true, startZ: iso(start), endZ: iso(end), durationHours: (end - start) / HOUR_MS, warnings: [] };
  }
  const start = meteogramWallTimeToUtc({ date, time: "00:00", timeZone, disambiguation: "earlier" });
  const end = meteogramWallTimeToUtc({ date: nextDate, time: "00:00", timeZone, disambiguation: "later" });
  if (!start.ok || !end.ok) return { ok: false, error: start.error || end.error };
  return {
    ok: true,
    startZ: start.valueZ,
    endZ: end.valueZ,
    durationHours: (end.timestamp - start.timestamp) / HOUR_MS,
    warnings: [],
  };
}

export function meteogramCustomRange({
  startDate,
  startTime,
  endDate,
  endTime,
  timeMode = "Z",
  timeZone = "America/Chicago",
} = {}) {
  let start;
  let end;
  const warnings = [];
  if (String(timeMode).toUpperCase() === "Z") {
    const startDateParts = parseDate(startDate);
    const endDateParts = parseDate(endDate);
    const startTimeParts = parseTime(startTime);
    const endTimeParts = parseTime(endTime);
    if (!startDateParts || !endDateParts || !startTimeParts || !endTimeParts) {
      return { ok: false, error: "Enter valid start and end dates and times." };
    }
    start = Date.UTC(startDateParts.year, startDateParts.month - 1, startDateParts.day, startTimeParts.hour, startTimeParts.minute);
    end = Date.UTC(endDateParts.year, endDateParts.month - 1, endDateParts.day, endTimeParts.hour, endTimeParts.minute);
  } else {
    const startResult = meteogramWallTimeToUtc({ date: startDate, time: startTime, timeZone, disambiguation: "earlier" });
    const endResult = meteogramWallTimeToUtc({ date: endDate, time: endTime, timeZone, disambiguation: "later" });
    if (!startResult.ok || !endResult.ok) return { ok: false, error: startResult.error || endResult.error };
    start = startResult.timestamp;
    end = endResult.timestamp;
    if (startResult.ambiguous) warnings.push("Ambiguous local START uses the first occurrence.");
    if (endResult.ambiguous) warnings.push("Ambiguous local END uses the second occurrence.");
  }
  if (end <= start) return { ok: false, error: "End must be later than start." };
  return { ok: true, startZ: iso(start), endZ: iso(end), durationHours: (end - start) / HOUR_MS, warnings };
}

export function meteogramPrintCoverage(model = {}) {
  const times = [];
  for (const item of model.timeline || []) {
    const timestamp = finiteTimestamp(item?.validZ || item?.observedZ);
    if (timestamp !== null) times.push(timestamp);
  }
  for (const key of PRINT_INTERVAL_KEYS) {
    for (const interval of model[key] || []) {
      const start = finiteTimestamp(interval?.validStartZ);
      const end = finiteTimestamp(interval?.validEndZ);
      if (start !== null) times.push(start);
      if (end !== null) times.push(end);
    }
  }
  const modelStart = finiteTimestamp(model.startZ);
  const modelEnd = finiteTimestamp(model.endZ);
  if (modelStart !== null) times.push(modelStart);
  if (modelEnd !== null) times.push(modelEnd);
  return times.length
    ? { available: true, startZ: iso(Math.min(...times)), endZ: iso(Math.max(...times)) }
    : { available: false, startZ: null, endZ: null };
}

export function resolveMeteogramPrintRange({ choice = "current", model = {}, settings = {}, values = {}, visibleRange = null } = {}) {
  const coverage = meteogramPrintCoverage(model);
  if (!coverage.available) return { ok: false, error: "No meteogram data is available to print." };
  const timeMode = String(settings.timeMode || "Z").toUpperCase() === "LOCAL" ? "LOCAL" : "Z";
  const timeZone = model.timeZone || null;
  if (timeMode === "LOCAL" && !timeZone) return { ok: false, error: "Station local time is unavailable; switch the meteogram to Z before printing." };
  let requested;
  if (choice === "calendar") {
    requested = meteogramCalendarDayRange({ date: values.calendarDate, timeMode, timeZone });
  } else if (choice === "custom") {
    requested = meteogramCustomRange({
      startDate: values.startDate,
      startTime: values.startTime,
      endDate: values.endDate,
      endTime: values.endTime,
      timeMode,
      timeZone,
    });
  } else if (choice === "visible") {
    const start = finiteTimestamp(visibleRange?.startZ);
    const end = finiteTimestamp(visibleRange?.endZ);
    requested = start !== null && end !== null && end > start
      ? { ok: true, startZ: iso(start), endZ: iso(end), warnings: [] }
      : { ok: false, error: "The current visible timeline window is unavailable." };
  } else {
    requested = { ok: true, startZ: coverage.startZ, endZ: coverage.endZ, warnings: [] };
  }
  if (!requested.ok) return requested;
  const coverageStart = finiteTimestamp(coverage.startZ);
  const coverageEnd = finiteTimestamp(coverage.endZ);
  const singleObservationCoverage = coverageStart === coverageEnd;
  if (singleObservationCoverage && choice === "current") {
    requested = {
      ...requested,
      startZ: iso(coverageStart - HOUR_MS / 2),
      endZ: iso(coverageEnd + HOUR_MS / 2),
    };
  }
  const requestedStart = finiteTimestamp(requested.startZ);
  const requestedEnd = finiteTimestamp(requested.endZ);
  if (singleObservationCoverage) {
    const requestedRightEdgeIsInclusive = choice === "current" || choice === "custom";
    const observationIsRequested = coverageStart >= requestedStart
      && (coverageStart < requestedEnd || (requestedRightEdgeIsInclusive && coverageStart === requestedEnd));
    if (!observationIsRequested) {
      return { ok: false, error: "The requested range does not overlap the loaded meteogram coverage." };
    }
    const start = Math.max(requestedStart, coverageStart - HOUR_MS / 2);
    const end = Math.min(requestedEnd, coverageEnd + HOUR_MS / 2);
    const warnings = [...(requested.warnings || []), "Only one exact observation is loaded; it is centered in a limited print window and no surrounding data is implied."];
    return {
      ok: true,
      choice,
      timeMode,
      timeZone,
      requestedStartZ: requested.startZ,
      requestedEndZ: requested.endZ,
      startZ: iso(start),
      endZ: iso(end),
      durationHours: (end - start) / HOUR_MS,
      clipped: true,
      singleObservation: true,
      includeEnd: requestedRightEdgeIsInclusive || end < requestedEnd,
      warnings,
      coverage,
    };
  }
  const start = Math.max(requestedStart, coverageStart);
  const end = Math.min(requestedEnd, coverageEnd);
  if (!(end > start)) return { ok: false, error: "The requested range does not overlap the loaded meteogram coverage." };
  const clipped = start !== requestedStart || end !== requestedEnd;
  // Calendar-day and visible-window ranges are half-open at their requested
  // right edge.  When the right edge was clipped to the last loaded sample,
  // retain that exact sample so truthful partial coverage is not discarded.
  // Current/custom ranges retain an exact report at their explicit end.
  const includeEnd = choice === "current" || choice === "custom" || end < requestedEnd;
  const warnings = [...(requested.warnings || [])];
  if (clipped) warnings.push("Requested range was clipped to the loaded meteogram coverage; unavailable time was not fabricated.");
  return {
    ok: true,
    choice,
    timeMode,
    timeZone,
    requestedStartZ: requested.startZ,
    requestedEndZ: requested.endZ,
    startZ: iso(start),
    endZ: iso(end),
    durationHours: (end - start) / HOUR_MS,
    clipped,
    includeEnd,
    warnings,
    coverage,
  };
}

export function paginateMeteogramPrintRange(range = {}, { maximumHours = PRINT_PAGE_HOURS } = {}) {
  const start = finiteTimestamp(range.startZ);
  const end = finiteTimestamp(range.endZ);
  const maximumMs = Math.max(1, Number(maximumHours) || PRINT_PAGE_HOURS) * HOUR_MS;
  if (start === null || end === null || end <= start) return [];
  const pages = [];
  for (let pageStart = start; pageStart < end; pageStart += maximumMs) {
    const pageEnd = Math.min(end, pageStart + maximumMs);
    pages.push({
      startZ: iso(pageStart),
      endZ: iso(pageEnd),
      durationHours: (pageEnd - pageStart) / HOUR_MS,
      includeEnd: Boolean(range.includeEnd && pageEnd === end),
    });
  }
  return pages;
}

function timelineTimestamp(item) {
  return finiteTimestamp(item?.validZ || item?.observedZ);
}

function intervalForPage(interval, start, end) {
  const intervalStart = finiteTimestamp(interval?.validStartZ);
  const intervalEnd = finiteTimestamp(interval?.validEndZ);
  if (intervalStart === null || intervalEnd === null || intervalEnd <= start || intervalStart >= end) return null;
  return {
    ...interval,
    sourceValidStartZ: interval.sourceValidStartZ || interval.validStartZ,
    sourceValidEndZ: interval.sourceValidEndZ || interval.validEndZ,
    printRenderStartZ: iso(Math.max(intervalStart, start)),
    printRenderEndZ: iso(Math.min(intervalEnd, end)),
    printClipped: intervalStart < start || intervalEnd > end,
  };
}

export function sliceMeteogramModelForPrint(model = {}, pageRange = {}) {
  const start = finiteTimestamp(pageRange.startZ);
  const end = finiteTimestamp(pageRange.endZ);
  if (start === null || end === null || end <= start) return { ...model, observations: [], forecasts: [], timeline: [] };
  const includes = (item) => {
    const timestamp = timelineTimestamp(item);
    return timestamp !== null && timestamp >= start && (timestamp < end || (pageRange.includeEnd && timestamp === end));
  };
  const observations = (model.observations || []).filter(includes);
  const forecasts = (model.forecasts || []).filter(includes);
  const sliced = {
    ...model,
    observations,
    forecasts,
    timeline: [...observations, ...forecasts].sort((left, right) => timelineTimestamp(left) - timelineTimestamp(right)),
    startZ: pageRange.startZ,
    endZ: pageRange.endZ,
    observedSources: [...new Set(observations.map((item) => item.source).filter(Boolean))],
  };
  for (const key of PRINT_INTERVAL_KEYS) {
    sliced[key] = (model[key] || []).map((interval) => intervalForPage(interval, start, end)).filter(Boolean);
  }
  return sliced;
}

function endpointText(value, settings, station) {
  const formatted = formatMeteogramTime(value, { mode: settings.timeMode, station });
  return settings.timeMode === "LOCAL"
    ? `${formatted.date} ${formatted.time} ${formatted.zone}`
    : `${formatted.date} ${formatted.time}Z`;
}

export function buildMeteogramPrintPlan({ model = {}, settings = {}, range, rangeLabel = "Current meteogram range" } = {}) {
  if (!range?.ok) return { ok: false, error: range?.error || "Choose a valid print range." };
  const normalizedSettings = {
    timeMode: String(settings.timeMode || "Z").toUpperCase() === "LOCAL" ? "LOCAL" : "Z",
    temperatureUnit: String(settings.temperatureUnit || "C").toUpperCase() === "F" ? "F" : "C",
    windUnit: String(settings.windUnit || "KT").toUpperCase() === "MPH" ? "MPH" : "KT",
  };
  const selectedModel = sliceMeteogramModelForPrint(model, {
    startZ: range.startZ,
    endZ: range.endZ,
    includeEnd: Boolean(range.includeEnd),
  });
  const scaleOverrides = meteogramSelectedRangeScales(selectedModel, normalizedSettings);
  const pageRanges = paginateMeteogramPrintRange(range);
  const selectedHasForecast = selectedModel.forecasts.length > 0
    || selectedModel.forecastPrecipitationIntervals.length > 0
    || selectedModel.forecastSnowfallIntervals.length > 0;
  const labelLayout = meteogramRowLabelLayout(normalizedSettings, PRINT_VIEWBOX_WIDTH, {
    hasForecast: selectedHasForecast,
    compact: false,
  });
  const pages = pageRanges.map((pageRange, index) => {
    const pageModel = sliceMeteogramModelForPrint(model, pageRange);
    const pixelsPerHour = Math.max(72, Math.min(200, (PRINT_VIEWBOX_WIDTH - labelLayout.width - 100) / Math.max(1, pageRange.durationHours)));
    const hasIntervals = PRINT_INTERVAL_KEYS.some((key) => pageModel[key]?.length);
    const svg = pageModel.timeline.length || hasIntervals
      ? buildMeteogramSvgMarkup(pageModel, normalizedSettings, {
        viewportWidth: PRINT_VIEWBOX_WIDTH,
        labelLayout,
        timeBounds: pageRange,
        scaleOverrides,
        idPrefix: `aviationMeteogramPrintPage${index + 1}`,
        pixelsPerHour,
        printMode: true,
      })
      : "";
    return {
      ...pageRange,
      pageNumber: index + 1,
      pageCount: pageRanges.length,
      model: pageModel,
      svg,
      intervalLabel: `${endpointText(pageRange.startZ, normalizedSettings, model.station)} – ${endpointText(pageRange.endZ, normalizedSettings, model.station)}`,
    };
  });
  return {
    ok: true,
    station: model.station || "KMEM",
    settings: normalizedSettings,
    range,
    rangeLabel,
    scaleOverrides,
    pages,
    coverageText: range.singleObservation
      ? `ONE EXACT OBSERVATION AVAILABLE AT ${endpointText(range.coverage.startZ, normalizedSettings, model.station)} · SURROUNDING PRINT SPACE CONTAINS NO IMPLIED DATA`
      : range.clipped
      ? `AVAILABLE COVERAGE ${endpointText(range.startZ, normalizedSettings, model.station)} – ${endpointText(range.endZ, normalizedSettings, model.station)} · REQUEST CLIPPED; NO DATA FABRICATED`
      : `AVAILABLE COVERAGE MATCHES SELECTED PRINT RANGE`,
  };
}

export function buildMeteogramPrintPagesMarkup(plan = {}) {
  if (!plan.ok) return "";
  const units = `${plan.settings.timeMode} · °${plan.settings.temperatureUnit} · ${plan.settings.windUnit}`;
  return plan.pages.map((page) => `<article class="aviation-meteogram-print-page" data-print-page="${page.pageNumber}" data-page-start-z="${escapeMarkup(page.startZ)}" data-page-end-z="${escapeMarkup(page.endZ)}" data-wind-maximum-kt="${plan.scaleOverrides.windMaximumKt}" data-cloud-maximum-ft="${plan.scaleOverrides.cloudMaximumFt}" data-pressure-min="${plan.scaleOverrides.pressureRange.minimum}" data-pressure-max="${plan.scaleOverrides.pressureRange.maximum}" data-visibility-min="${plan.scaleOverrides.visibilityRange.minimum}" data-visibility-max="${plan.scaleOverrides.visibilityRange.maximum}" data-precip-maximum-in="${plan.scaleOverrides.precipMaximumIn}" data-snow-maximum-in="${plan.scaleOverrides.snowMaximumIn}">
    <header class="aviation-meteogram-print-page-header">
      <div><h1>${escapeMarkup(plan.station)} AVIATION METEOGRAM</h1><p>${escapeMarkup(page.intervalLabel)}</p></div>
      <div class="aviation-meteogram-print-page-meta"><strong>${escapeMarkup(units)}</strong><span>PAGE ${page.pageNumber} OF ${page.pageCount}</span><span>FOR REFERENCE ONLY</span></div>
    </header>
    <div class="aviation-meteogram-print-page-context"><span>${escapeMarkup(plan.rangeLabel)}</span><span>OBSERVED — SOLID/STRONG · FORECAST — SHADED/REDUCED · SUSTAINED SOLID · GUST DASHED</span></div>
    <p class="aviation-meteogram-print-coverage">${escapeMarkup(plan.coverageText)}</p>
    <p class="aviation-meteogram-print-interval-note">† PRECIP/SNOW AMOUNT IS THE FULL UNSPLIT SOURCE-INTERVAL TOTAL; A BAR CONTINUED ACROSS A PAGE EDGE IS NOT A SECOND TOTAL.</p>
    <div class="aviation-meteogram-print-chart">${page.svg || `<div class="aviation-meteogram-print-no-data">NO DATA IN THIS INTERVAL</div>`}</div>
  </article>`).join("");
}

function inputPartsForInstant(value, timeMode, timeZone) {
  const timestamp = finiteTimestamp(value);
  if (timestamp === null) return { date: "", time: "" };
  if (String(timeMode).toUpperCase() === "Z") {
    const text = iso(timestamp);
    return { date: text.slice(0, 10), time: text.slice(11, 16) };
  }
  const parts = zonedParts(timestamp, timeZone);
  return {
    date: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
  };
}

export function meteogramPrintDefaultValues(printState = {}) {
  const coverage = meteogramPrintCoverage(printState.model || {});
  const settings = printState.settings || { timeMode: "Z" };
  const timeZone = printState.model?.timeZone || "America/Chicago";
  const anchor = printState.model?.dividerZ || coverage.endZ;
  const calendar = inputPartsForInstant(anchor, settings.timeMode, timeZone);
  const start = inputPartsForInstant(coverage.startZ, settings.timeMode, timeZone);
  const end = inputPartsForInstant(coverage.endZ, settings.timeMode, timeZone);
  return {
    calendarDate: calendar.date,
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
  };
}
