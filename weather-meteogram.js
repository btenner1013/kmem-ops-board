import {
  buildMeteogramModel,
  convertTemperature,
  convertWindSpeed,
  formatMeteogramTime,
  formatTemperature,
  formatWind,
} from "./weather-meteogram-core.js";
import { meteogramSolarEvents, meteogramSolarPhase } from "./weather-meteogram-solar.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const METEOGRAM_ROWS = Object.freeze({
  time: { top: 0, bottom: 54 },
  weather: { top: 54, bottom: 122 },
  temperature: { top: 122, bottom: 170 },
  dewPoint: { top: 170, bottom: 218 },
  tempLine: { top: 218, bottom: 292 },
  dewLine: { top: 292, bottom: 366 },
  wind: { top: 366, bottom: 464 },
  windSpeed: { top: 464, bottom: 538 },
  pressure: { top: 538, bottom: 616 },
  clouds: { top: 616, bottom: 836 },
  visibility: { top: 836, bottom: 910 },
  precip: { top: 910, bottom: 954 },
  snow: { top: 954, bottom: 998 },
});

const MAX_CONNECTOR_GAP_MS = 2.5 * 60 * 60 * 1000;
const CLOUD_LABEL_MIN_GAP_PX = 15;
const CLOUD_VISUAL_HEIGHT_PX = Object.freeze({ FEW: 18, SCT: 24, BKN: 31, OVC: 31, VV: 38 });
const CLOUD_FORM_SCENE_WIDTH = 160;
const CLOUD_LABEL_TAG_MIN_WIDTH = 42;
const CLOUD_LABEL_TAG_MAX_WIDTH = 132;
const CLOUD_LABEL_TAG_GAP = 5;
const WEATHER_OVERLAY_ZONE_TOP = METEOGRAM_ROWS.clouds.bottom - 26;
const WEATHER_OVERLAY_ZONE_BOTTOM = METEOGRAM_ROWS.clouds.bottom - 10;
export const METEOGRAM_DATA_AXIS_WIDTH = 58;
export const METEOGRAM_CLOUD_AXIS_WIDTH = METEOGRAM_DATA_AXIS_WIDTH;
const ROW_LABEL_TEXT_X = 45;
const ROW_LABEL_RIGHT_PADDING = 18;
const ROW_LABEL_MAX_WIDTH = 280;
const ROW_LABEL_MAX_VIEWPORT_RATIO = 0.52;

function escapeMarkup(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function fixed(value, digits = 1) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function usableRange(values, { minimumSpan = 1, padding = 0.08 } = {}) {
  const valid = values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (!valid.length) return { minimum: 0, maximum: minimumSpan };
  let minimum = Math.min(...valid);
  let maximum = Math.max(...valid);
  if (maximum - minimum < minimumSpan) {
    const middle = (minimum + maximum) / 2;
    minimum = middle - minimumSpan / 2;
    maximum = middle + minimumSpan / 2;
  }
  const extra = (maximum - minimum) * padding;
  return { minimum: minimum - extra, maximum: maximum + extra };
}

function scaledY(value, range, top, bottom) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const ratio = (Number(value) - range.minimum) / (range.maximum - range.minimum || 1);
  return bottom - clamp(ratio, 0, 1) * (bottom - top);
}

function timelineTime(value) {
  return value?.validZ || value?.observedZ || "";
}

function isForecast(value) {
  return value?.kind === "FORECAST";
}

function forecastBucketHasTaf(value) {
  return isForecast(value) && Boolean(value?.tafIssuanceZ);
}

function forecastBucketHasNws(value) {
  return isForecast(value) && Boolean(
    value?.supplementalOnly
    || value?.fieldProvenance?.temperature?.product === "NWS_GRID"
    || value?.fieldProvenance?.dewPoint?.product === "NWS_GRID"
    || value?.supplementalBoundary,
  );
}

function forecastBucketSourceLabel(value) {
  const hasTaf = forecastBucketHasTaf(value);
  const hasNws = forecastBucketHasNws(value);
  if (hasTaf && hasNws) return "TAF / NWS";
  if (hasTaf) return "TAF";
  if (hasNws) return "NWS GRID";
  return "FORECAST";
}

export function meteogramForecastSourceState(model = {}) {
  const forecasts = Array.isArray(model.forecasts) ? model.forecasts : [];
  const hasTaf = forecasts.some(forecastBucketHasTaf);
  const hasNws = forecasts.some(forecastBucketHasNws)
    || [model.forecastPrecipitationIntervals, model.forecastSnowfallIntervals]
      .some((values) => Array.isArray(values) && values.length > 0);
  return {
    hasTaf,
    hasNws,
    label: hasTaf && hasNws ? "TAF / NWS" : hasTaf ? "TAF" : hasNws ? "NWS GRID" : "FORECAST",
  };
}

export function meteogramSubtitleText(model = {}) {
  const forecastSources = meteogramForecastSourceState(model);
  if (Array.isArray(model.forecasts) && model.forecasts.length) {
    if (forecastSources.hasTaf && forecastSources.hasNws) {
      return "UNIFIED WEATHER TIMELINE · EXACT METAR / SPECI HISTORY + CURRENT TAF + NWS GRID SUPPLEMENT";
    }
    if (forecastSources.hasTaf) {
      return "UNIFIED WEATHER TIMELINE · EXACT METAR / SPECI HISTORY + CURRENT TAF";
    }
    return model.taf?.warning
      ? "UNIFIED WEATHER TIMELINE · EXACT METAR / SPECI HISTORY + NWS GRID SUPPLEMENT · CURRENT TAF AVIATION FIELDS UNAVAILABLE OR NOT SAFELY PLOTTED"
      : "UNIFIED WEATHER TIMELINE · EXACT METAR / SPECI HISTORY + NWS GRID SUPPLEMENT · CURRENT TAF UNAVAILABLE";
  }
  return model.taf?.warning
    ? "UNIFIED OBSERVED WEATHER TIMELINE · METAR / SPECI · CURRENT TAF NOT SAFELY PLOTTED"
    : "UNIFIED OBSERVED WEATHER TIMELINE · METAR / SPECI · CURRENT TAF UNAVAILABLE";
}

function normalizedMeteogramSettings(settings = {}, model = {}) {
  const requestedTimeMode = String(settings.timeMode || "Z").toUpperCase() === "LOCAL" ? "LOCAL" : "Z";
  return {
    timeMode: requestedTimeMode === "LOCAL" && !model.timeZone ? "Z" : requestedTimeMode,
    temperatureUnit: String(settings.temperatureUnit || "C").toUpperCase() === "F" ? "F" : "C",
    windUnit: String(settings.windUnit || "KT").toUpperCase() === "MPH" ? "MPH" : "KT",
  };
}

function compactTimeText(time, mode) {
  const clock = String(time?.time || "—").replace(":", "");
  if (String(mode).toUpperCase() === "Z") return clock === "—" ? clock : `${clock.replace(/Z$/i, "")}Z`;
  return String(time?.time || "—");
}

function compactIntervalLabel(startZ, endZ, station = "KMEM") {
  const start = formatMeteogramTime(startZ, { mode: "Z", station });
  const end = formatMeteogramTime(endZ, { mode: "Z", station });
  const startText = compactTimeText(start, "Z");
  const endText = compactTimeText(end, "Z");
  return start.date && end.date && start.date !== end.date
    ? `${start.date} ${startText}–${end.date} ${endText}`
    : `${startText}–${endText}`;
}

export function meteogramWindArrowRotation(directionFromDeg) {
  const value = Number(directionFromDeg);
  if (!Number.isFinite(value)) return null;
  return ((value + 180) % 360 + 360) % 360;
}

function pathSegments(points, observations, maximumGapMs = MAX_CONNECTOR_GAP_MS) {
  const segments = [];
  let current = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previousTime = index ? Date.parse(timelineTime(observations[index - 1])) : null;
    const currentTime = Date.parse(timelineTime(observations[index]));
    const kindChanged = index && isForecast(observations[index - 1]) !== isForecast(observations[index]);
    const gap = index && Number.isFinite(previousTime) && Number.isFinite(currentTime)
      ? currentTime - previousTime
      : 0;
    if (!point || kindChanged || gap > maximumGapMs) {
      if (current.length) segments.push(current);
      current = point ? [point] : [];
      continue;
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

function pathMarkup(points, className, observations) {
  return pathSegments(points, observations)
    .filter((segment) => segment.length)
    .map((segment) => {
      const d = segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
      return `<path class="${className}" d="${d}"/>`;
    })
    .join("");
}

function forecastSeamMarkup(points, observations, className) {
  const firstForecast = observations.findIndex(isForecast);
  if (firstForecast <= 0) return "";
  const observedPoint = points[firstForecast - 1];
  const forecastPoint = points[firstForecast];
  if (!observedPoint || !forecastPoint) return "";
  const gap = Date.parse(timelineTime(observations[firstForecast]))
    - Date.parse(timelineTime(observations[firstForecast - 1]));
  if (!Number.isFinite(gap) || gap < 0 || gap > MAX_CONNECTOR_GAP_MS) return "";
  return `<path class="${className} aviation-meteogram-line-forecast aviation-meteogram-line-seam" d="M${observedPoint.x.toFixed(1)} ${observedPoint.y.toFixed(1)} L${forecastPoint.x.toFixed(1)} ${forecastPoint.y.toFixed(1)}"/>`;
}

function trendSeriesMarkup(points, observations, className) {
  const observed = points.map((point, index) => isForecast(observations[index]) ? null : point);
  const forecast = points.map((point, index) => isForecast(observations[index]) ? point : null);
  return [
    pathMarkup(observed, className, observations),
    forecastSeamMarkup(points, observations, className),
    pathMarkup(forecast, `${className} aviation-meteogram-line-forecast`, observations),
  ].join("");
}

function spreadMarkup(tempPoints, dewPoints, observations) {
  const polygons = [];
  for (let index = 1; index < observations.length; index += 1) {
    const gap = Date.parse(timelineTime(observations[index])) - Date.parse(timelineTime(observations[index - 1]));
    const values = [tempPoints[index - 1], tempPoints[index], dewPoints[index], dewPoints[index - 1]];
    if (isForecast(observations[index]) || isForecast(observations[index - 1]) || gap > 2.5 * 60 * 60 * 1000 || values.some((point) => !point)) continue;
    polygons.push(`<polygon class="aviation-meteogram-temp-spread" points="${values.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}"/>`);
  }
  return polygons.join("");
}

function fallbackRowLabelTextWidth(text, kind, compact) {
  const fontSize = kind === "title" ? compact ? 10 : 11 : compact ? 7.5 : 8.5;
  const letterSpacing = fontSize * (kind === "title" ? 0.025 : 0.045);
  const characters = Array.from(String(text || ""));
  return characters.length * fontSize * 0.59 + Math.max(0, characters.length - 1) * letterSpacing;
}

function wrapRowLabelText(text, maximumWidth, measureText, kind) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalized || measureText(normalized, kind) <= maximumWidth) return normalized ? [normalized] : [];
  const words = normalized.split(" ");
  if (words.length > 1) {
    const balanced = [];
    for (let index = 1; index < words.length; index += 1) {
      const first = words.slice(0, index).join(" ");
      const second = words.slice(index).join(" ");
      const firstWidth = measureText(first, kind);
      const secondWidth = measureText(second, kind);
      if (firstWidth <= maximumWidth && secondWidth <= maximumWidth) {
        balanced.push({ lines: [first, second], widest: Math.max(firstWidth, secondWidth), difference: Math.abs(firstWidth - secondWidth) });
      }
    }
    balanced.sort((left, right) => left.widest - right.widest || left.difference - right.difference);
    if (balanced.length) return balanced[0].lines;
  }
  const lines = [];
  let line = "";
  for (const word of normalized.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measureText(candidate, kind) <= maximumWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

export function meteogramRowLabelDescriptors(settings = {}, hasForecast = false) {
  const rows = METEOGRAM_ROWS;
  const timeMode = String(settings.timeMode || "Z").toUpperCase() === "LOCAL" ? "LOCAL" : "Z";
  const temperatureUnit = String(settings.temperatureUnit || "C").toUpperCase() === "F" ? "F" : "C";
  const windUnit = String(settings.windUnit || "KT").toUpperCase() === "MPH" ? "MPH" : "KT";
  return [
    { key: "time", ...rows.time, icon: "◷", title: "TIME", unit: timeMode === "Z" ? "UTC / Z" : "STATION LOCAL" },
    { key: "weather", ...rows.weather, icon: "☁", title: "WEATHER", unit: hasForecast ? "OBS + FORECAST" : "OBSERVED CODE" },
    { key: "temperature", ...rows.temperature, icon: "T", title: "TEMPERATURE", unit: `°${temperatureUnit}` },
    { key: "dewPoint", ...rows.dewPoint, icon: "D", title: "DEW POINT", unit: `°${temperatureUnit}` },
    { key: "tempLine", ...rows.tempLine, icon: "↗", title: "TEMP LINE", unit: `SHARED °${temperatureUnit} SCALE` },
    { key: "dewLine", ...rows.dewLine, icon: "↗", title: "DEW POINT LINE", unit: `SHARED °${temperatureUnit} SCALE` },
    { key: "wind", ...rows.wind, icon: "↗", title: "WIND", unit: `DOWNWIND ARROW · ${windUnit}` },
    { key: "windSpeed", ...rows.windSpeed, icon: "≈", title: "WIND SPEED / GUST", unit: `SOLID SUSTAINED · DASH GUST · ${windUnit}` },
    { key: "pressure", ...rows.pressure, icon: "◌", title: "PRESSURE", unit: "IN HG" },
    { key: "clouds", ...rows.clouds, icon: "☁", title: "CLOUDS / CIG", unit: "FT AGL" },
    { key: "visibility", ...rows.visibility, icon: "◉", title: "VISIBILITY", unit: "SM / REPORTED" },
    { key: "precip", ...rows.precip, icon: "◒", title: "PRECIP (IN)", unit: "INTERVAL TOTAL" },
    { key: "snow", ...rows.snow, icon: "✣", title: "SNOW (IN)", unit: "FCST / OBS DEPTH Δ" },
  ];
}

export function meteogramRowLabelLayout(settings = {}, availableWidth = 1100, {
  hasForecast = false,
  compact = Number(availableWidth) <= 768,
  measureText = null,
} = {}) {
  const safeAvailableWidth = Math.max(1, Number(availableWidth) || 1100);
  const minimumWidth = compact ? 140 : 154;
  const maximumWidth = Math.min(
    ROW_LABEL_MAX_WIDTH,
    Math.max(minimumWidth, 168, Math.floor(safeAvailableWidth * ROW_LABEL_MAX_VIEWPORT_RATIO)),
  );
  const requestedMeasure = typeof measureText === "function"
    ? measureText
    : (text, kind) => fallbackRowLabelTextWidth(text, kind, compact);
  const measure = (text, kind) => {
    const measured = Number(requestedMeasure(text, kind));
    return Number.isFinite(measured) && measured >= 0
      ? measured
      : fallbackRowLabelTextWidth(text, kind, compact);
  };
  const descriptors = meteogramRowLabelDescriptors(settings, hasForecast);
  const sizingTextCandidates = new Map();
  for (const timeMode of ["Z", "LOCAL"]) {
    for (const temperatureUnit of ["C", "F"]) {
      for (const windUnit of ["KT", "MPH"]) {
        for (const descriptor of meteogramRowLabelDescriptors({ timeMode, temperatureUnit, windUnit }, hasForecast)) {
          sizingTextCandidates.set(`title:${descriptor.title}`, { text: descriptor.title, kind: "title" });
          sizingTextCandidates.set(`unit:${descriptor.unit}`, { text: descriptor.unit, kind: "unit" });
        }
      }
    }
  }
  const longestTextWidth = [...sizingTextCandidates.values()].reduce((maximum, candidate) => Math.max(
    maximum,
    measure(candidate.text, candidate.kind),
  ), 0);
  const preferredWidth = Math.ceil(ROW_LABEL_TEXT_X + longestTextWidth + ROW_LABEL_RIGHT_PADDING);
  const width = clamp(preferredWidth, minimumWidth, maximumWidth);
  const maximumTextWidth = Math.max(1, width - ROW_LABEL_TEXT_X - ROW_LABEL_RIGHT_PADDING);
  const rows = descriptors.map((descriptor) => ({
    ...descriptor,
    titleLines: wrapRowLabelText(descriptor.title, maximumTextWidth, measure, "title"),
    unitLines: wrapRowLabelText(descriptor.unit, maximumTextWidth, measure, "unit"),
  }));
  return {
    width,
    minimumWidth,
    preferredWidth,
    maximumWidth,
    maximumTextWidth,
    compact,
    rows,
  };
}

function createMeteogramRowLabelMeasurer(doc) {
  if (!doc?.createElementNS) return { element: null, measureText: null };
  const element = doc.createElementNS(SVG_NS, "svg");
  element.setAttribute("class", "aviation-meteogram-svg aviation-meteogram-label-measurer");
  element.setAttribute("width", "1");
  element.setAttribute("height", "1");
  element.setAttribute("viewBox", "0 0 1 1");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  const title = doc.createElementNS(SVG_NS, "text");
  const unit = doc.createElementNS(SVG_NS, "text");
  title.setAttribute("class", "aviation-meteogram-row-title");
  unit.setAttribute("class", "aviation-meteogram-row-unit");
  element.append(title, unit);
  const nodes = { title, unit };
  const measureText = (value, kind) => {
    const node = nodes[kind === "title" ? "title" : "unit"];
    node.textContent = String(value || "");
    const advanceWidth = Number(node.getComputedTextLength?.());
    let inkWidth = NaN;
    try {
      inkWidth = Number(node.getBBox?.().width);
    } catch {
      // Detached/initializing SVG implementations may not expose an ink box yet.
    }
    const widths = [advanceWidth, inkWidth].filter((width) => Number.isFinite(width) && width > 0);
    return widths.length ? Math.max(...widths) : NaN;
  };
  return { element, measureText };
}

function rowLabel({ key, top, bottom, icon, title, unit, titleLines = [title], unitLines = [unit] }) {
  const middle = (top + bottom) / 2;
  const wrapped = titleLines.length > 1 || unitLines.length > 1;
  const titleLineHeight = 12;
  const unitLineHeight = 10;
  const wrappedBlockTop = middle - (titleLines.length * titleLineHeight + 8 + unitLines.length * unitLineHeight) / 2;
  const titleY = wrapped ? wrappedBlockTop + 10 : middle - 6;
  const unitY = wrapped ? wrappedBlockTop + titleLines.length * titleLineHeight + 15 : middle + 13;
  const titleMarkup = titleLines.length <= 1
    ? escapeMarkup(titleLines[0] || title)
    : titleLines.map((line, index) => `<tspan x="${ROW_LABEL_TEXT_X}" dy="${index ? titleLineHeight : 0}">${escapeMarkup(line)}</tspan>`).join("");
  const unitMarkup = unitLines.length <= 1
    ? escapeMarkup(unitLines[0] || unit)
    : unitLines.map((line, index) => `<tspan x="${ROW_LABEL_TEXT_X}" dy="${index ? unitLineHeight : 0}">${escapeMarkup(line)}</tspan>`).join("");
  return `<g class="aviation-meteogram-row-label" data-row-key="${key}" data-row-top="${top}" data-row-bottom="${bottom}" data-row-wrapped="${wrapped}">
    <text class="aviation-meteogram-row-icon" x="15" y="${(middle - 2).toFixed(1)}">${escapeMarkup(icon)}</text>
    <text class="aviation-meteogram-row-title" x="${ROW_LABEL_TEXT_X}" y="${titleY.toFixed(1)}" aria-label="${escapeMarkup(title)}" data-line-count="${titleLines.length}">${titleMarkup}</text>
    <text class="aviation-meteogram-row-unit" x="${ROW_LABEL_TEXT_X}" y="${unitY.toFixed(1)}" aria-label="${escapeMarkup(unit)}" data-line-count="${unitLines.length}">${unitMarkup}</text>
  </g>`;
}

export function meteogramDimensions(timelineOrCount, viewportWidth, {
  extraTimes = [],
  labelWidth: requestedLabelWidth = null,
  pixelsPerHour: requestedPixelsPerHour = null,
} = {}) {
  const safeViewportWidth = Math.max(320, Number(viewportWidth) || 1100);
  const defaultLabelWidth = safeViewportWidth < 600 ? 132 : 154;
  const hasRequestedLabelWidth = requestedLabelWidth !== null
    && requestedLabelWidth !== undefined
    && Number.isFinite(Number(requestedLabelWidth));
  const labelWidth = hasRequestedLabelWidth
    ? clamp(Number(requestedLabelWidth), 96, ROW_LABEL_MAX_WIDTH)
    : defaultLabelWidth;
  const axisWidth = METEOGRAM_DATA_AXIS_WIDTH;
  const plotLeft = labelWidth + axisWidth;
  const timeline = Array.isArray(timelineOrCount) ? timelineOrCount : [];
  const observationCount = timeline.length || Math.max(0, Number(timelineOrCount) || 0);
  const parsedTimes = timeline.map((item) => Date.parse(timelineTime(item)));
  const validTimes = [
    ...parsedTimes.filter(Number.isFinite),
    ...(Array.isArray(extraTimes) ? extraTimes.map((value) => Date.parse(value)).filter(Number.isFinite) : []),
  ];
  const firstTime = validTimes.length ? Math.min(...validTimes) : 0;
  const lastTime = validTimes.length ? Math.max(...validTimes) : Math.max(0, observationCount - 1) * 60 * 60 * 1000;
  const spanHours = Math.max(0, (lastTime - firstTime) / (60 * 60 * 1000));
  const minimumPixelsPerHour = safeViewportWidth < 600 ? 82 : 76;
  const orderedDistinctTimes = [...new Set(validTimes)].sort((left, right) => left - right);
  const minimumGapHours = orderedDistinctTimes.slice(1).reduce((minimum, value, index) => {
    const gap = (value - orderedDistinctTimes[index]) / (60 * 60 * 1000);
    return gap > 0 ? Math.min(minimum, gap) : minimum;
  }, Infinity);
  const densityPixelsPerHour = Number.isFinite(minimumGapHours) ? 64 / minimumGapHours : minimumPixelsPerHour;
  const fillPixelsPerHour = spanHours > 0
    ? (safeViewportWidth - plotLeft - minimumPixelsPerHour) / spanHours
    : minimumPixelsPerHour;
  const hasRequestedPixelsPerHour = requestedPixelsPerHour !== null
    && requestedPixelsPerHour !== undefined
    && requestedPixelsPerHour !== ""
    && Number.isFinite(Number(requestedPixelsPerHour));
  const pixelsPerHour = hasRequestedPixelsPerHour
    ? clamp(Number(requestedPixelsPerHour), 40, 200)
    : clamp(Math.max(fillPixelsPerHour, densityPixelsPerHour), minimumPixelsPerHour, 200);
  const columnWidth = clamp(pixelsPerHour, minimumPixelsPerHour, 118);
  const timeScale = pixelsPerHour / (60 * 60 * 1000);
  const timelineWidth = spanHours * pixelsPerHour;
  const width = Math.max(safeViewportWidth, plotLeft + columnWidth + timelineWidth);
  const xForTime = (value) => {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(timestamp)) return plotLeft + columnWidth / 2;
    return clamp(plotLeft + columnWidth / 2 + (timestamp - firstTime) * timeScale, plotLeft, width);
  };
  const xPositions = observationCount === 1 && !timeline.length
    ? [plotLeft + (width - plotLeft) / 2]
    : Array.from({ length: observationCount }, (_, index) => {
      if (!timeline.length) return plotLeft + columnWidth / 2 + index * columnWidth;
      const timestamp = parsedTimes[index];
      return Number.isFinite(timestamp)
        ? xForTime(new Date(timestamp))
        : plotLeft + columnWidth / 2 + index * columnWidth;
    });
  const cellBounds = xPositions.map((x, index) => ({
    left: index ? (xPositions[index - 1] + x) / 2 : plotLeft,
    right: index + 1 < xPositions.length ? (x + xPositions[index + 1]) / 2 : width,
  }));
  return {
    viewportWidth: safeViewportWidth,
    labelWidth,
    descriptionWidth: labelWidth,
    axisWidth,
    plotLeft,
    columnWidth,
    pixelsPerHour,
    firstTime,
    lastTime,
    xPositions,
    cellBounds,
    xForTime,
    width,
    height: METEOGRAM_ROWS.snow.bottom,
  };
}

function rowLabelsMarkup(settings, hasForecast = false, labelLayout = null) {
  const layout = labelLayout || meteogramRowLabelLayout(settings, 1100, { hasForecast });
  return layout.rows.map(rowLabel).join("");
}

function cloudAltitudeAxisMarkup(cloudScale, labelWidth, { sticky = false, axisWidth = METEOGRAM_DATA_AXIS_WIDTH } = {}) {
  if (!cloudScale?.ticks?.length) return "";
  const boundary = labelWidth + axisWidth;
  const ticks = meteogramCloudTickLayout(cloudScale.ticks, cloudScale.maximumFt);
  return `<g class="aviation-meteogram-cloud-axis${sticky ? " aviation-meteogram-cloud-axis-sticky" : ""}" data-axis-start="${labelWidth}" data-axis-end="${boundary}" data-axis-maximum-ft="${cloudScale.maximumFt}">
    <rect x="${labelWidth}" y="${METEOGRAM_ROWS.clouds.top}" width="${axisWidth}" height="${METEOGRAM_ROWS.clouds.bottom - METEOGRAM_ROWS.clouds.top}"/>
    ${ticks.map(({ value, y, visible }) => visible ? `<g data-cloud-axis-ft="${value}" data-cloud-axis-y="${y.toFixed(1)}">
      <line x1="${boundary - 6}" y1="${y.toFixed(1)}" x2="${boundary}" y2="${y.toFixed(1)}"/>
      <text x="${labelWidth + 4}" y="${(y - 2).toFixed(1)}">${escapeMarkup(value.toLocaleString("en-US"))} FT</text>
    </g>` : "").join("")}
  </g>`;
}

export function buildMeteogramStickyLabelsMarkup(
  settings,
  dimensions,
  hasForecast = false,
  labelLayout = null,
  windSpeedGeometry = null,
  cloudScale = null,
) {
  const stickyWidth = dimensions.plotLeft;
  const horizontalLines = Object.values(METEOGRAM_ROWS).map((row) => `<line class="aviation-meteogram-grid-line" x1="0" y1="${row.bottom}" x2="${stickyWidth}" y2="${row.bottom}"/>`).join("");
  const windAxisMarkup = windSpeedGeometry?.ticks?.length
    ? `<g class="aviation-meteogram-wind-axis-sticky" data-axis-start="${dimensions.labelWidth}" data-axis-end="${stickyWidth}">
      <rect x="${dimensions.labelWidth}" y="${METEOGRAM_ROWS.windSpeed.top}" width="${dimensions.axisWidth}" height="${METEOGRAM_ROWS.windSpeed.bottom - METEOGRAM_ROWS.windSpeed.top}"/>
      ${windSpeedGeometry.ticks.map((tick) => `<text x="${dimensions.labelWidth + 4}" y="${(tick.y - 2).toFixed(1)}">${escapeMarkup(tick.label)}</text>`).join("")}
    </g>`
    : "";
  return `<svg class="aviation-meteogram-sticky-labels" xmlns="${SVG_NS}" width="${stickyWidth}" height="${dimensions.height}" viewBox="0 0 ${stickyWidth} ${dimensions.height}" data-label-width="${dimensions.labelWidth}" data-axis-width="${dimensions.axisWidth}" data-plot-left="${stickyWidth}" aria-hidden="true">
    <rect class="aviation-meteogram-label-background" width="${dimensions.labelWidth}" height="${dimensions.height}"/>
    <rect class="aviation-meteogram-axis-gutter-background" x="${dimensions.labelWidth}" width="${dimensions.axisWidth}" height="${dimensions.height}"/>
    ${horizontalLines}
    <line class="aviation-meteogram-description-divider" x1="${dimensions.labelWidth}" y1="0" x2="${dimensions.labelWidth}" y2="${dimensions.height}"/>
    <line class="aviation-meteogram-label-divider" x1="${stickyWidth - 1}" y1="0" x2="${stickyWidth - 1}" y2="${dimensions.height}"/>
    ${rowLabelsMarkup(settings, hasForecast, labelLayout)}
    ${windAxisMarkup}
    ${cloudAltitudeAxisMarkup(cloudScale, dimensions.labelWidth, { sticky: true, axisWidth: dimensions.axisWidth })}
  </svg>`;
}

function forecastOverlays(observation) {
  return [...(observation?.becoming || []), ...(observation?.conditional || [])];
}

function visualLabelPriority(observation) {
  if (forecastOverlays(observation).length) return 500 + (observation?.exactBoundary ? 40 : 0);
  if (observation?.temperatureKind) return 450 + (observation?.exactBoundary ? 40 : 0);
  if (observation?.exactBoundary) return 400;
  return isForecast(observation) ? 200 : 300;
}

function visualLabelWidth(observation, minimumWidth) {
  const windLabels = [];
  const visibilityLabels = [];
  const cloudLabels = [];
  const weatherLabels = [];
  for (const entry of forecastOverlays(observation)) {
    const value = entry.conditions || {};
    const type = visualConditionalTypeLabel(entry);
    if (value.windSpeedKt !== null && value.windSpeedKt !== undefined) {
      windLabels.push(`${type} ${windDirectionLabel(value)} 00${value.windGustKt === null || value.windGustKt === undefined ? "" : " G00"}`);
    }
    if (value.visibilitySm !== null && value.visibilitySm !== undefined) visibilityLabels.push(`${type} ${value.visibilityDisplay || "00 SM"}`);
    if (value.clouds) cloudLabels.push(`${type} ${cloudColumnLabel({ clouds: value.clouds })} ${ceilingLabel(value.clouds)}`);
    if (value.weatherCodes?.length) weatherLabels.push(`${type} ${value.weatherCodes.join("/")}`);
  }
  const maximumCharacters = Math.max(0, ...[windLabels, visibilityLabels, cloudLabels, weatherLabels]
    .map((labels) => labels.join(" · ").length));
  return clamp(Math.max(minimumWidth, maximumCharacters * 5.2 + 12), minimumWidth, 220);
}

export function meteogramVisualLabelMask(timeline, xPositions, minimumDistance = 56) {
  const observations = Array.isArray(timeline) ? timeline : [];
  const positions = Array.isArray(xPositions) ? xPositions : [];
  const visible = observations.map(() => false);
  const candidates = observations.map((observation, index) => ({
    index,
    priority: visualLabelPriority(observation),
    x: Number(positions[index]),
    halfWidth: visualLabelWidth(observation, minimumDistance) / 2,
  })).filter((candidate) => Number.isFinite(candidate.x));
  candidates.sort((left, right) => right.priority - left.priority || right.index - left.index);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((other) => Math.abs(other.x - candidate.x) < other.halfWidth + candidate.halfWidth)) continue;
    visible[candidate.index] = true;
    selected.push(candidate);
  }
  return visible;
}

function stickyTimeText(time, mode) {
  const clock = String(time?.time || "—").replace(":", "");
  return String(mode).toUpperCase() === "Z" ? `${clock}Z` : `${clock}L`;
}

export function buildMeteogramStickyTimeRulerMarkup(model = {}, settings = {}, dimensions = null) {
  const timeline = Array.isArray(model?.timeline) ? model.timeline : [];
  if (!dimensions || !timeline.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const labelMask = meteogramVisualLabelMask(timeline, dimensions.xPositions);
  let previousDate = "";
  const ticks = timeline.map((observation, index) => {
    if (!labelMask[index]) return "";
    const time = formatMeteogramTime(timelineTime(observation), {
      mode: normalizedSettings.timeMode,
      station: model.station,
    });
    const dateChanged = !previousDate || previousDate !== time.date;
    previousDate = time.date;
    const x = dimensions.xPositions[index];
    return `<g class="aviation-meteogram-sticky-time-tick${dateChanged ? " aviation-meteogram-sticky-time-date-change" : ""}" data-time-x="${x.toFixed(1)}" data-time-z="${escapeMarkup(timelineTime(observation))}" transform="translate(${x.toFixed(1)} 0)">
      <line x1="0" y1="0" x2="0" y2="54"/>
      <text x="0" y="21">${escapeMarkup(stickyTimeText(time, normalizedSettings.timeMode))}</text>
      <text class="aviation-meteogram-sticky-time-date" x="0" y="39">${escapeMarkup(dateChanged ? `${time.date} · ${time.zone}` : time.zone)}</text>
    </g>`;
  }).join("");
  const dividerTime = model.dividerZ || model.forecasts?.[0]?.validZ;
  const dividerX = Number.isFinite(Date.parse(dividerTime)) ? dimensions.xForTime(dividerTime) : null;
  const now = dividerX === null ? "" : `<g class="aviation-meteogram-sticky-time-now" data-now-x="${dividerX.toFixed(1)}" transform="translate(${dividerX.toFixed(1)} 0)"><line x1="0" y1="0" x2="0" y2="54"/><text x="0" y="51">NOW</text></g>`;
  const solar = meteogramSolarEvents(new Date(dimensions.firstTime), new Date(dimensions.lastTime), { station: model.station })
    .map((event) => {
      const x = dimensions.xForTime(event.timestamp);
      return `<g class="aviation-meteogram-sticky-time-solar aviation-meteogram-sticky-time-solar-${event.type}" data-solar-x="${x.toFixed(1)}" transform="translate(${x.toFixed(1)} 0)"><title>${escapeMarkup(solarEventAccessibleLabel(event, model.station))}</title><path d="M-3 47H3M0 43V51"/></g>`;
    }).join("");
  const basis = normalizedSettings.timeMode === "Z" ? "UTC / Z" : "LOCAL";
  return `<div class="aviation-meteogram-sticky-time-frame" data-time-basis="${normalizedSettings.timeMode}" style="--meteogram-ruler-corner-width:${dimensions.plotLeft}px">
    <div class="aviation-meteogram-sticky-time-corner"><strong>TIME</strong><span>${basis}</span></div>
    <div class="aviation-meteogram-sticky-time-viewport">
      <div class="aviation-meteogram-sticky-time-track" style="width:${dimensions.width}px">
        <svg xmlns="${SVG_NS}" width="${dimensions.width}" height="54" viewBox="0 0 ${dimensions.width} 54" data-plot-left="${dimensions.plotLeft}" aria-hidden="true">
          <rect class="aviation-meteogram-sticky-time-background" width="${dimensions.width}" height="54"/>${ticks}${solar}${now}
        </svg>
      </div>
    </div>
  </div>`;
}

function weatherColumnLabel(observation) {
  const overlays = forecastOverlays(observation);
  if (isForecast(observation) && overlays.length) {
    const conditionalLabels = overlays.flatMap((entry) => {
      const codes = entry.conditions?.weatherCodes || [];
      return codes.length ? [`${visualConditionalTypeLabel(entry)} ${codes.join("/")}`] : [];
    });
    if (conditionalLabels.length) return conditionalLabels.join(" · ");
  }
  if (observation.weatherCodes.length) return observation.weatherCodes.join(" ");
  if (observation.clouds.cavok) return "CAVOK";
  if (observation.clouds.clear) return observation.clouds.display || "CLR";
  const covers = [...new Set(observation.clouds.layers.map((layer) => layer.cover))];
  return covers.length ? covers.join("/") : "NO WX";
}

function weatherColumnIcon(observation) {
  const conditionalCodes = forecastOverlays(observation).flatMap((entry) => entry.conditions?.weatherCodes || []);
  const joined = conditionalCodes.join(" ");
  if (/TS/.test(joined)) return "⚡";
  if (/SN|SG|PL/.test(joined)) return "❄";
  if (/RA|DZ/.test(joined)) return "☂";
  if (/FG|BR/.test(joined)) return "≋";
  return observation.weather.icon;
}

function clearWeatherIconMarkup(observation, weatherCategory, station) {
  if (weatherCategory !== "clear" || !observation?.clouds?.clear) return "";
  const phase = meteogramSolarPhase(timelineTime(observation), { station });
  if (!phase) return "";
  const symbol = phase === "day" ? "sun" : "moon";
  const sourceCode = String(observation?.clouds?.display || "CLR").toUpperCase();
  const skyMeaning = ["NSC", "NCD"].includes(sourceCode) ? `${sourceCode} / no significant cloud` : `${sourceCode} / clear sky`;
  const label = `${skyMeaning} during KMEM ${phase === "day" ? "daylight" : "nighttime"}`;
  const vector = phase === "day"
    ? `<circle class="aviation-meteogram-clear-sun-disc" cx="0" cy="0" r="6.5" aria-hidden="true"/>
       <path class="aviation-meteogram-clear-sun-rays" d="M0 -13V-10 M0 10V13 M-13 0H-10 M10 0H13 M-9.2 -9.2L-7.1 -7.1 M7.1 7.1L9.2 9.2 M9.2 -9.2L7.1 -7.1 M-7.1 7.1L-9.2 9.2" aria-hidden="true"/>`
    : `<path class="aviation-meteogram-clear-moon-crescent" d="M0 -11a11 11 0 1 0 11 11A8 8 0 0 1 0 -11Z" aria-hidden="true"/>`;
  return `<g class="aviation-meteogram-weather-icon aviation-meteogram-weather-clear aviation-meteogram-clear-icon aviation-meteogram-clear-icon-${phase}" data-weather-category="clear" data-weather-symbol="${symbol}" data-solar-phase="${phase}" transform="translate(0 83)" role="img" aria-label="${label}">
    <title>${label}</title>
    ${vector}
  </g>`;
}

function weatherIconMarkup(observation, weatherCategory, station) {
  const clearIcon = clearWeatherIconMarkup(observation, weatherCategory, station);
  if (clearIcon) return clearIcon;
  return `<text class="aviation-meteogram-weather-icon aviation-meteogram-weather-${weatherCategory}" data-weather-category="${weatherCategory}" x="0" y="88">${escapeMarkup(weatherColumnIcon(observation))}</text>`;
}

function solarEventAccessibleLabel(event, station) {
  const local = formatMeteogramTime(event.timestamp, { mode: "LOCAL", station });
  const zulu = formatMeteogramTime(event.timestamp, { mode: "Z", station });
  return `${event.type.toUpperCase()} · ${local.date} ${local.time} ${local.zone} · ${zulu.date} ${compactTimeText(zulu, "Z")}`;
}

export function meteogramWeatherVisualCategory(observation = {}) {
  const conditionalCodes = forecastOverlays(observation).flatMap((entry) => entry.conditions?.weatherCodes || []);
  const prevailingCodes = Array.isArray(observation.weatherCodes) ? observation.weatherCodes : [];
  const codes = conditionalCodes.length ? conditionalCodes : prevailingCodes;
  const joined = codes.join(" ").toUpperCase();
  if (/TS/.test(joined)) return "thunder";
  if (/SQ|FC/.test(joined)) return "significant";
  if (/FZRA|FZDZ|\bPL\b|\bIC\b|\bGR\b|\bGS\b/.test(joined)) return "ice";
  if (/SN|SG/.test(joined)) return "snow";
  if (/SH|VCSH/.test(joined)) return "showers";
  if (/RA|DZ|UP/.test(joined)) return "rain";
  if (/FG|BR/.test(joined)) return "fog";
  if (/HZ|FU|VA|DU|SA|PY|PO|SS|DS/.test(joined)) return "obscuration";
  if (observation.clouds?.cavok || observation.clouds?.clear) return "clear";
  if (Array.isArray(observation.clouds?.layers) && observation.clouds.layers.length) return "cloud";
  return "other";
}

function cloudColumnLabel(observation) {
  if (observation.clouds.cavok) return "CAVOK";
  if (observation.clouds.clear) return observation.clouds.display || "CLR";
  const covers = observation.clouds.layers.map((layer) => layer.cover);
  return covers.length ? covers.join("/") : "—";
}

function conditionalTypeLabel(entry) {
  return String(entry?.type || "CONDITIONAL")
    .replace("PROB30 TEMPORARY", "P30/TEMPO")
    .replace("PROB40 TEMPORARY", "P40/TEMPO")
    .replace("TEMPORARY", "TEMPO")
    .replace("PROB30", "P30")
    .replace("PROB40", "P40")
    .replace("BECOMING", "BECMG");
}

function visualConditionalTypeLabel(entry) {
  return conditionalTypeLabel(entry)
    .replace("P30/TEMPO", "P30/T")
    .replace("P40/TEMPO", "P40/T")
    .replace("TEMPO", "TMP");
}

function windDirectionLabel(value) {
  if (Number(value?.windSpeedKt) === 0 && value?.windSpeedKt !== null && value?.windSpeedKt !== undefined) return "CALM";
  if (value?.windVariable) return "VRB";
  if (value?.windDirectionDeg === null || value?.windDirectionDeg === undefined) return "—";
  return `${String(value.windDirectionDeg).padStart(3, "0")}°`;
}

function ceilingLabel(clouds) {
  const value = clouds && typeof clouds === "object" ? clouds : {};
  if (value.ceilingFt !== null && value.ceilingFt !== undefined) return `${Math.round(value.ceilingFt / 100)}00 FT`;
  if ((value.layers || []).some((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && layer.heightFt === null)) return "CIG UNK";
  if (value.cavok) return "NO CIG <5K";
  if (value.clear || (value.layers || []).length) return "NO CIG";
  return "—";
}

function conditionalSummary(observation, settings) {
  return forecastOverlays(observation).map((entry) => {
    const value = entry.conditions || {};
    const parts = [];
    if (value.windSpeedKt !== null && value.windSpeedKt !== undefined) {
      parts.push(`wind ${windDirectionLabel(value)} ${formatWind(value.windSpeedKt, settings.windUnit)} ${settings.windUnit}${value.windGustKt === null || value.windGustKt === undefined ? "" : ` G${formatWind(value.windGustKt, settings.windUnit)}`}`);
    }
    if (value.visibilitySm !== null && value.visibilitySm !== undefined) parts.push(`visibility ${value.visibilityDisplay || visibilityLabel(value)}`);
    if (value.clouds) parts.push(`clouds ${value.clouds.display}; ceiling ${ceilingLabel(value.clouds)}`);
    if (value.weatherCodes?.length) parts.push(`weather ${value.weatherCodes.join(" ")}`);
    return `${conditionalTypeLabel(entry)}${parts.length ? `: ${parts.join(", ")}` : ""}`;
  }).join(" · ");
}

function finiteAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function amountDisplay(value, { compact = false } = {}) {
  const amount = finiteAmount(value);
  if (amount === null) return "—";
  if (amount > 0 && Number(amount.toFixed(2)) === 0) return "<0.01";
  const text = amount.toFixed(2);
  return compact && amount > 0 && amount < 1 ? text.replace(/^0/, "") : text;
}

function normalizedInterval(interval) {
  const startZ = interval?.validStartZ || null;
  const endZ = interval?.validEndZ || null;
  const start = Date.parse(startZ);
  const end = Date.parse(endZ);
  return {
    ...interval,
    validStartZ: Number.isFinite(start) ? new Date(start).toISOString() : null,
    validEndZ: Number.isFinite(end) ? new Date(end).toISOString() : null,
    valid: Number.isFinite(start) && Number.isFinite(end) && end > start,
  };
}

function normalizedForecastIntervals(model, key) {
  const values = Array.isArray(model?.[key]) ? model[key] : [];
  return values.flatMap((entry) => {
    const interval = normalizedInterval(entry);
    const amountIn = finiteAmount(entry?.amountIn);
    return interval.valid && amountIn !== null ? [{
      ...interval,
      amountIn,
      kind: "FORECAST",
      source: entry?.source || model?.supplemental?.source || "NWS grid forecast",
      sourceUrl: entry?.sourceUrl || model?.supplemental?.sourceUrl || "",
    }] : [];
  });
}

function observedAmountIntervals(model, type) {
  const selectedKey = type === "PRECIP" ? "observedPrecipitationIntervals" : "observedSnowDepthIncreaseIntervals";
  if (Array.isArray(model?.[selectedKey])) {
    return model[selectedKey].flatMap((entry) => {
      const interval = normalizedInterval(entry);
      const trace = type === "PRECIP" && entry?.trace === true;
      const amountIn = finiteAmount(entry?.amountIn);
      if (!trace && amountIn === null) return [];
      return [{
        ...interval,
        amountIn,
        trace,
        kind: "OBSERVED",
        source: entry?.source || "METAR/SPECI",
        sourceToken: entry?.sourceToken || (type === "PRECIP" ? "Prrrr" : "SNINCR"),
        observationZ: entry?.observationZ || interval.validEndZ,
      }];
    });
  }
  return (model?.observations || []).flatMap((observation) => {
    const precip = observation?.precipitation || {};
    const intervalValue = type === "PRECIP" ? precip.liquidInterval : precip.snowDepthIncreaseInterval;
    const interval = normalizedInterval(intervalValue);
    const trace = type === "PRECIP" && precip.liquidTrace === true;
    const amountIn = finiteAmount(type === "PRECIP" ? precip.liquidEquivalentIn : precip.snowDepthIncreaseIn);
    if (!trace && amountIn === null) return [];
    return [{
      ...interval,
      validEndZ: interval.validEndZ || observation.observedZ,
      amountIn,
      trace,
      kind: "OBSERVED",
      source: observation.source || "METAR/SPECI",
      sourceToken: intervalValue?.sourceToken || (type === "PRECIP" ? "Prrrr" : "SNINCR"),
      station: observation.station,
    }];
  });
}

function exactObservedInterval(observation, type) {
  const precip = observation?.precipitation || {};
  const intervalValue = type === "PRECIP" ? precip.liquidInterval : precip.snowDepthIncreaseInterval;
  const interval = normalizedInterval(intervalValue);
  const trace = type === "PRECIP" && precip.liquidTrace === true;
  const amountIn = finiteAmount(type === "PRECIP" ? precip.liquidEquivalentIn : precip.snowDepthIncreaseIn);
  if (!trace && amountIn === null) return null;
  return {
    ...interval,
    validEndZ: interval.validEndZ || observation.observedZ,
    amountIn,
    trace,
    kind: "OBSERVED",
    source: observation.source || "METAR/SPECI",
    sourceToken: intervalValue?.sourceToken || (type === "PRECIP" ? "Prrrr" : "SNINCR"),
  };
}

function quantitativeIntervals(model, type) {
  const observed = observedAmountIntervals(model, type);
  const forecast = normalizedForecastIntervals(
    model,
    type === "PRECIP" ? "forecastPrecipitationIntervals" : "forecastSnowfallIntervals",
  );
  return [...observed, ...forecast].sort((left, right) => (
    Date.parse(left.validStartZ || left.validEndZ) - Date.parse(right.validStartZ || right.validEndZ)
  ));
}

function intervalExtraTimes(model) {
  return [
    ...quantitativeIntervals(model, "PRECIP"),
    ...quantitativeIntervals(model, "SNOW"),
  ].flatMap((interval) => [
    interval.printRenderStartZ || interval.validStartZ,
    interval.printRenderEndZ || interval.validEndZ,
  ]).filter(Boolean);
}

function intervalAccessibleValue(interval, station) {
  const amount = interval.trace ? "T" : `${amountDisplay(interval.amountIn)} IN`;
  const validity = interval.validStartZ && interval.validEndZ
    ? compactIntervalLabel(interval.validStartZ, interval.validEndZ, station)
    : interval.validEndZ
      ? `ENDING ${compactTimeText(formatMeteogramTime(interval.validEndZ, { mode: "Z", station }), "Z")} · START UNAVAILABLE`
      : "INTERVAL UNAVAILABLE";
  return `${amount} · ${validity}`;
}

function visibilityLabel(observation) {
  if (observation.visibilitySm === null) return "—";
  if (observation.visibilityDisplay.includes("KM") || observation.visibilityDisplay.includes(" M")) {
    return observation.visibilityDisplay;
  }
  const qualifier = observation.visibilityQualifier || "";
  return `${qualifier}${fixed(observation.visibilitySm, observation.visibilitySm < 3 ? 1 : 0)}`;
}

function columnTitle(observation, settings) {
  const time = formatMeteogramTime(timelineTime(observation), { mode: settings.timeMode, station: observation.station });
  const direction = windDirectionLabel(observation);
  const displayTime = settings.timeMode === "Z"
    ? `${time.date} ${compactTimeText(time, "Z")}`
    : `${time.date} ${time.time} ${time.zone}`;
  const base = [
    `${isForecast(observation) ? "FORECAST" : observation.reportType} ${displayTime}`,
    `Temperature ${formatTemperature(observation.temperatureC, settings.temperatureUnit)} / Dew point ${formatTemperature(observation.dewPointC, settings.temperatureUnit)}`,
    `Wind ${direction} ${formatWind(observation.windSpeedKt, settings.windUnit)} ${settings.windUnit} · Gust ${observation.windGustKt === null || observation.windGustKt === undefined ? "—" : `${formatWind(observation.windGustKt, settings.windUnit)} ${settings.windUnit}`}`,
    `Visibility ${observation.visibilityDisplay}`,
    `Clouds ${observation.clouds.display}`,
    observation.weatherCodes.length ? `Weather ${observation.weatherCodes.join(" ")}` : "Weather code not reported",
  ];
  if (isForecast(observation)) {
    const hasTaf = forecastBucketHasTaf(observation);
    const hasNws = forecastBucketHasNws(observation);
    base.push(`${forecastBucketSourceLabel(observation)} forecast`);
    if (hasTaf) base.push(`TAF group ${observation.tafSourceToken || "INITIAL"}`);
    if (hasTaf && observation.becoming?.length) base.push(`Transition ${observation.becoming.map((entry) => entry.sourceToken).join(", ")}`);
    if (hasTaf && forecastOverlays(observation).length) base.push(`Forecast overlays ${conditionalSummary(observation, settings)}`);
    if (observation.fieldProvenance?.temperature) base.push(`Temperature source ${observation.fieldProvenance.temperature.source}`);
    if (observation.fieldProvenance?.dewPoint) base.push(`Dew point source ${observation.fieldProvenance.dewPoint.source}`);
    if (!observation.fieldProvenance?.dewPoint) {
      base.push(hasNws
        ? "Dew point unavailable; NWS grid value is missing for this valid time"
        : "Dew point unavailable; TAF does not provide hourly dew point");
    }
    if (hasTaf && observation.temperatureExtrema?.length) {
      base.push(`Separate TAF extrema ${observation.temperatureExtrema.map((extreme) => `${extreme.type} ${formatTemperature(extreme.valueC, settings.temperatureUnit)}`).join(", ")}`);
    }
  }
  base.push(`Source ${observation.source || (isForecast(observation) ? forecastBucketSourceLabel(observation) : "METAR/SPECI")}`);
  return base.join(" · ");
}

function windSpeedTooltipText(observation, settings) {
  const timestamp = new Date(timelineTime(observation));
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const formattedTime = formatMeteogramTime(timestamp, {
    mode: settings.timeMode,
    station: observation.station,
  });
  const localMonth = months.indexOf(String(formattedTime.date || "").split(" ")[1]);
  let displayYear = timestamp.getUTCFullYear();
  if (timestamp.getUTCMonth() === 11 && localMonth === 0) displayYear += 1;
  if (timestamp.getUTCMonth() === 0 && localMonth === 11) displayYear -= 1;
  const exactTime = Number.isFinite(timestamp.getTime())
    ? `${formattedTime.date} ${displayYear} · ${settings.timeMode === "Z" ? compactTimeText(formattedTime, "Z") : `${formattedTime.time} ${formattedTime.zone}`}`
    : "TIME UNAVAILABLE";
  const speedKt = validWindSpeedKt(observation.windSpeedKt);
  const gustKt = validWindSpeedKt(observation.windGustKt);
  const direction = speedKt === 0 ? "CALM" : windDirectionLabel(observation);
  const wind = speedKt === null ? "—" : `${direction} ${formatWind(speedKt, settings.windUnit)} ${settings.windUnit}`;
  const gust = gustKt === null ? "—" : `${formatWind(gustKt, settings.windUnit)} ${settings.windUnit}`;
  const source = isForecast(observation) ? "TAF" : observation.reportType || "METAR/SPECI";
  return `${exactTime}\nWIND: ${wind}\nGUST: ${gust}\nSOURCE: ${source}`;
}

function multilineAttribute(value) {
  return escapeMarkup(value).replace(/\n/g, "&#10;");
}

export function buildMeteogramAccessibleTableMarkup(model, settings = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  if (!timeline.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const precipitationIntervals = quantitativeIntervals(model, "PRECIP");
  const snowfallIntervals = quantitativeIntervals(model, "SNOW");
  const rows = timeline.map((observation) => {
    const time = formatMeteogramTime(timelineTime(observation), {
      mode: normalizedSettings.timeMode,
      station: model.station,
    });
    const windSpeed = formatWind(observation.windSpeedKt, normalizedSettings.windUnit);
    const windDirection = observation.windSpeedKt === 0 ? "CALM" : windDirectionLabel(observation);
    const gustSpeed = observation.windGustKt === null || observation.windGustKt === undefined
      ? "—"
      : `${formatWind(observation.windGustKt, normalizedSettings.windUnit)} ${normalizedSettings.windUnit}`;
    const wind = `Direction ${windDirection} · Sustained ${windSpeed} ${normalizedSettings.windUnit} · Gust ${gustSpeed}`;
    const forecastHasTaf = forecastBucketHasTaf(observation);
    const forecastHasNws = forecastBucketHasNws(observation);
    const type = isForecast(observation)
      ? `${forecastBucketSourceLabel(observation)} forecast${forecastHasTaf ? ` · prevailing ${observation.tafSourceToken || "INITIAL"}` : ""}`
      : observation.reportType;
    const overlays = conditionalSummary(observation, normalizedSettings);
    const temperature = formatTemperature(observation.temperatureC, normalizedSettings.temperatureUnit);
    const extremaSemantics = (observation.temperatureExtrema || []).map((extreme) => (
      `${String(extreme.type || "").startsWith("Maximum") ? "TX" : "TN"} ${formatTemperature(extreme.valueC, normalizedSettings.temperatureUnit)} · ${extreme.type || "TAF temperature extreme"}`
    )).join("; ");
    const temperatureSemantics = extremaSemantics ? `${temperature} · Separate TAF extrema: ${extremaSemantics}` : temperature;
    const temperatureProvenance = observation.fieldProvenance?.temperature;
    const dewPointProvenance = observation.fieldProvenance?.dewPoint;
    const observedPrecip = !isForecast(observation) ? exactObservedInterval(observation, "PRECIP") : null;
    const observedSnowIncrease = !isForecast(observation) ? exactObservedInterval(observation, "SNOW") : null;
    const provenance = [
      `Source ${observation.source || (isForecast(observation) ? forecastBucketSourceLabel(observation) : "METAR/SPECI")}`,
      temperatureProvenance ? `Temperature ${temperatureProvenance.product === "NWS_GRID" ? "NWS grid" : "TAF"}; valid ${compactIntervalLabel(temperatureProvenance.validStartZ, temperatureProvenance.validEndZ, model.station)}` : "",
      dewPointProvenance ? `Dew point NWS grid; valid ${compactIntervalLabel(dewPointProvenance.validStartZ, dewPointProvenance.validEndZ, model.station)}` : "",
      overlays ? `Non-prevailing/transition ${overlays}` : "",
      isForecast(observation) && forecastHasTaf ? "Aviation fields from current TAF" : "",
      isForecast(observation) && forecastHasNws ? "Supplemental fields identify NWS grid provenance" : "",
      isForecast(observation) && !forecastHasTaf && forecastHasNws ? "No current TAF aviation fields are represented in this bucket" : "",
      !isForecast(observation) ? "Exact retained observation" : "",
    ].filter(Boolean).join(" · ");
    const displayedTime = normalizedSettings.timeMode === "Z"
      ? `${time.date} ${compactTimeText(time, "Z")}`
      : `${time.date} ${time.time} ${time.zone}`;
    return `<tr>
      <th scope="row">${escapeMarkup(displayedTime)}</th>
      <td>${escapeMarkup(type)}</td>
      <td>${escapeMarkup(`${weatherColumnLabel(observation)} · ${observation.weather?.label || "—"}`)}</td>
      <td>${escapeMarkup(temperatureSemantics)}</td>
      <td>${escapeMarkup(formatTemperature(observation.dewPointC, normalizedSettings.temperatureUnit))}</td>
      <td>${escapeMarkup(wind)}</td>
      <td>${escapeMarkup(observation.pressureInHg === null || observation.pressureInHg === undefined ? "—" : `${fixed(observation.pressureInHg, 2)} inHg`)}</td>
      <td>${escapeMarkup(`${observation.clouds?.display || "—"} · ${ceilingLabel(observation.clouds)} · ${cloudAccessibleText(observation.clouds)}`)}</td>
      <td>${escapeMarkup(observation.visibilityDisplay || "—")}</td>
      <td>${escapeMarkup(observedPrecip ? intervalAccessibleValue(observedPrecip, model.station) : "—")}</td>
      <td>${escapeMarkup(observedSnowIncrease ? `${intervalAccessibleValue(observedSnowIncrease, model.station)} · SNOW DEPTH INCREASE DURING PAST HOUR` : "—")}</td>
      <td>${escapeMarkup(finiteAmount(observation.precipitation?.snowDepthIn) === null ? "—" : `${amountDisplay(observation.precipitation.snowDepthIn)} IN DEPTH ON GROUND`)}</td>
      <td>${escapeMarkup(provenance)}</td>
    </tr>`;
  }).join("");
  const intervalRows = [
    ...precipitationIntervals.filter((interval) => interval.kind === "FORECAST").map((interval) => ({ ...interval, type: "PRECIP" })),
    ...snowfallIntervals.filter((interval) => interval.kind === "FORECAST").map((interval) => ({ ...interval, type: "SNOW" })),
  ].sort((left, right) => Date.parse(left.validStartZ) - Date.parse(right.validStartZ)).map((interval) => {
    const amount = `${amountDisplay(interval.amountIn)} IN`;
    const validity = compactIntervalLabel(interval.validStartZ, interval.validEndZ, model.station);
    const precipValue = interval.type === "PRECIP" ? amount : "—";
    const snowValue = interval.type === "SNOW" ? amount : "—";
    const meaning = interval.type === "PRECIP"
      ? "NWS GRID QPF · TOTAL LIQUID EQUIVALENT; NOT POP"
      : "NWS GRID FORECAST SNOWFALL AMOUNT";
    return `<tr class="aviation-meteogram-data-interval-row">
      <th scope="row">${escapeMarkup(validity)}</th><td>${escapeMarkup(`${interval.type} forecast interval`)}</td>
      <td>${escapeMarkup(meaning)}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      <td>${escapeMarkup(precipValue)}</td><td>${escapeMarkup(snowValue)}</td><td>—</td>
      <td>${escapeMarkup(`Source ${interval.source}; exact unsplit valid interval ${validity}`)}</td>
    </tr>`;
  }).join("");
  return `<table class="aviation-meteogram-data-table">
    <caption>${escapeMarkup(`${model.station} meteogram text data; ${normalizedSettings.timeMode === "Z" ? "UTC/Z" : "station local"} time, degrees ${normalizedSettings.temperatureUnit}, wind in ${normalizedSettings.windUnit}`)}</caption>
    <thead><tr>
      <th scope="col">Time</th><th scope="col">Type</th><th scope="col">Weather</th>
      <th scope="col">Temperature °${normalizedSettings.temperatureUnit}</th><th scope="col">Dew point °${normalizedSettings.temperatureUnit}</th>
      <th scope="col">Wind ${normalizedSettings.windUnit}</th><th scope="col">Pressure</th>
      <th scope="col">Clouds / ceiling</th><th scope="col">Visibility</th><th scope="col">PRECIP (IN)</th>
      <th scope="col" title="Forecast snowfall; observed SNINCR is one-hour snow-depth increase">SNOW (IN)</th><th scope="col">Snow depth (IN)</th><th scope="col">Source / valid-interval semantics</th>
    </tr></thead><tbody>${rows}${intervalRows}</tbody>
  </table>`;
}

export function meteogramTemperatureGeometry(model, settings = {}, dimensions = null, { range: requestedRange = null } = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const chartDimensions = dimensions || meteogramDimensions(timeline, 1100, {
    extraTimes: intervalExtraTimes(model),
  });
  const values = timeline.flatMap((observation) => [
    convertTemperature(observation.temperatureC, normalizedSettings.temperatureUnit),
    convertTemperature(observation.dewPointC, normalizedSettings.temperatureUnit),
    ...(observation.temperatureExtrema || []).map((extreme) => (
      convertTemperature(extreme.valueC, normalizedSettings.temperatureUnit)
    )),
  ]).filter(Number.isFinite);
  const calculatedRange = usableRange(values, {
    minimumSpan: normalizedSettings.temperatureUnit === "F" ? 8 : 5,
    padding: 0.12,
  });
  const range = requestedRange
    && Number.isFinite(Number(requestedRange.minimum))
    && Number.isFinite(Number(requestedRange.maximum))
    && Number(requestedRange.maximum) > Number(requestedRange.minimum)
    ? { minimum: Number(requestedRange.minimum), maximum: Number(requestedRange.maximum) }
    : calculatedRange;
  const top = METEOGRAM_ROWS.tempLine.top + 11;
  const bottom = METEOGRAM_ROWS.dewLine.bottom - 11;
  const pointsFor = (field) => timeline.map((observation, index) => {
    const value = convertTemperature(observation[field], normalizedSettings.temperatureUnit);
    const y = scaledY(value, range, top, bottom);
    return y === null ? null : { x: chartDimensions.xPositions[index], y, value };
  });
  return {
    unit: normalizedSettings.temperatureUnit,
    range,
    top,
    bottom,
    temperaturePoints: pointsFor("temperatureC"),
    dewPointPoints: pointsFor("dewPointC"),
  };
}

function validWindSpeedKt(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function niceWindStep(value) {
  const safeValue = Math.max(1, Number(value) || 1);
  const exponent = 10 ** Math.floor(Math.log10(safeValue));
  const fraction = safeValue / exponent;
  const niceFraction = fraction <= 1.5 ? 1 : fraction <= 3 ? 2 : fraction <= 7 ? 5 : 10;
  return niceFraction * exponent;
}

function windSpeedBucketIsPlottable(observation) {
  return !isForecast(observation) || forecastBucketHasTaf(observation);
}

export function meteogramWindSpeedGeometry(model, settings = {}, dimensions = null, { maximumKt: requestedMaximumKt = null } = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const chartDimensions = dimensions || meteogramDimensions(timeline, 1100, {
    extraTimes: intervalExtraTimes(model),
  });
  const rawValuesKt = timeline.flatMap((observation) => {
    if (!windSpeedBucketIsPlottable(observation)) return [];
    return [validWindSpeedKt(observation.windSpeedKt), validWindSpeedKt(observation.windGustKt)]
      .filter((value) => value !== null);
  });
  const maximumValueKt = rawValuesKt.length ? Math.max(...rawValuesKt) : 0;
  const requiredUpperKt = Math.max(10, maximumValueKt * 1.12);
  const stepKt = niceWindStep(requiredUpperKt / 3);
  const calculatedMaximumKt = Math.max(10, Math.ceil(requiredUpperKt / stepKt) * stepKt);
  const maximumKt = Number.isFinite(Number(requestedMaximumKt)) && Number(requestedMaximumKt) >= calculatedMaximumKt
    ? Number(requestedMaximumKt)
    : calculatedMaximumKt;
  const range = { minimum: 0, maximum: maximumKt };
  const top = METEOGRAM_ROWS.windSpeed.top + 9;
  const bottom = METEOGRAM_ROWS.windSpeed.bottom - 8;
  const pointsFor = (field) => timeline.map((observation, index) => {
    if (!windSpeedBucketIsPlottable(observation)) return null;
    const valueKt = validWindSpeedKt(observation[field]);
    if (valueKt === null) return null;
    return {
      x: chartDimensions.xPositions[index],
      y: scaledY(valueKt, range, top, bottom),
      valueKt,
      value: convertWindSpeed(valueKt, normalizedSettings.windUnit),
    };
  });
  const displayMaximum = convertWindSpeed(maximumKt, normalizedSettings.windUnit);
  const displayStep = niceWindStep(displayMaximum / 3);
  const ticks = [];
  for (let displayValue = 0; displayValue <= displayMaximum + 1e-7; displayValue += displayStep) {
    const valueKt = normalizedSettings.windUnit === "MPH"
      ? displayValue / convertWindSpeed(1, "MPH")
      : displayValue;
    ticks.push({
      value: displayValue,
      valueKt,
      y: scaledY(valueKt, range, top, bottom),
      label: `${Math.round(displayValue)} ${normalizedSettings.windUnit}`,
    });
  }
  return {
    unit: normalizedSettings.windUnit,
    range,
    displayRange: { minimum: 0, maximum: displayMaximum },
    top,
    bottom,
    ticks,
    sustainedPoints: pointsFor("windSpeedKt"),
    gustPoints: pointsFor("windGustKt"),
  };
}

function cloudLayersForObservation(observation) {
  const prevailing = (observation?.clouds?.layers || []).map((layer) => ({
    ...layer,
    conditional: false,
    conditionalLabel: "",
    ceilingFt: observation?.clouds?.ceilingFt ?? null,
  }));
  const conditional = forecastOverlays(observation).flatMap((entry) => {
    const clouds = entry.conditions?.clouds;
    return (clouds?.layers || []).map((layer) => ({
      ...layer,
      conditional: true,
      conditionalLabel: visualConditionalTypeLabel(entry),
      ceilingFt: clouds?.ceilingFt ?? null,
    }));
  });
  return [...prevailing, ...conditional];
}

export function meteogramCloudScaleDefinition(timeline, { maximumFt: requestedMaximumFt = null } = {}) {
  const reportedHeights = timeline.flatMap(cloudLayersForObservation)
    .filter((layer) => layer.heightFt !== null && layer.heightFt !== undefined && layer.heightFt !== "")
    .map((layer) => Number(layer.heightFt))
    .filter((height) => Number.isFinite(height) && height >= 0);
  const highest = Math.max(10000, ...reportedHeights);
  const calculatedMaximumFt = Math.max(10000, Math.ceil(highest / 5000) * 5000);
  const maximumFt = Number.isFinite(Number(requestedMaximumFt)) && Number(requestedMaximumFt) >= calculatedMaximumFt
    ? Number(requestedMaximumFt)
    : calculatedMaximumFt;
  const ticks = [500, 1000, 2000, 3000, 5000, 10000];
  for (let value = 15000; value <= maximumFt; value += 5000) ticks.push(value);
  return { maximumFt, ticks: ticks.filter((value) => value <= maximumFt) };
}

function validScaleRange(value) {
  return value
    && Number.isFinite(Number(value.minimum))
    && Number.isFinite(Number(value.maximum))
    && Number(value.maximum) > Number(value.minimum)
    ? { minimum: Number(value.minimum), maximum: Number(value.maximum) }
    : null;
}

export function meteogramSelectedRangeScales(model = {}, settings = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const pressureRange = usableRange(timeline.map((observation) => observation.pressureInHg), {
    minimumSpan: 0.08,
    padding: 0.18,
  });
  const visibilityRange = usableRange(timeline.map((observation) => observation.visibilitySm), {
    minimumSpan: 3,
    padding: 0.05,
  });
  visibilityRange.minimum = Math.min(0, visibilityRange.minimum);
  const intervalMaximum = (type) => Math.max(
    0.01,
    ...quantitativeIntervals(model, type).map((interval) => finiteAmount(interval.amountIn) || 0),
  );
  return {
    temperatureRange: meteogramTemperatureGeometry(model, normalizedSettings).range,
    windMaximumKt: meteogramWindSpeedGeometry(model, normalizedSettings).range.maximum,
    cloudMaximumFt: meteogramCloudScaleDefinition(timeline).maximumFt,
    pressureRange,
    visibilityRange,
    precipMaximumIn: intervalMaximum("PRECIP"),
    snowMaximumIn: intervalMaximum("SNOW"),
  };
}

export function meteogramCloudBaseY(heightFt, maximumFt = 10000) {
  if (heightFt === null || heightFt === undefined || heightFt === "") return null;
  const height = Number(heightFt);
  const maximum = Math.max(1, Number(maximumFt) || 10000);
  if (!Number.isFinite(height) || height < 0) return null;
  const top = METEOGRAM_ROWS.clouds.top + 22;
  const bottom = METEOGRAM_ROWS.clouds.bottom - 25;
  return bottom - clamp(height / maximum, 0, 1) * (bottom - top);
}

export function meteogramCloudTickLayout(ticks, maximumFt = 10000, { minimumGapPx = 13 } = {}) {
  const gap = Math.max(10, Number(minimumGapPx) || 13);
  const selected = [];
  const values = Array.isArray(ticks) ? ticks : [];
  const priority = (value) => ({ 1000: 100, 3000: 90, 5000: 80, 10000: 70, 500: 60, 2000: 50 }[value] || 40 - Number(value) / 100000);
  const decisions = new Map();
  [...values].sort((left, right) => priority(right) - priority(left) || Number(left) - Number(right)).forEach((value) => {
    const y = meteogramCloudBaseY(value, maximumFt);
    const visible = y !== null && !selected.some((otherY) => Math.abs(otherY - y) < gap);
    if (visible) selected.push(y);
    decisions.set(value, { value, y, visible });
  });
  return values.map((value) => decisions.get(value));
}

function cloudLayerIsCeiling(layer) {
  const heightFt = layer?.heightFt;
  const ceilingFt = layer?.ceilingFt;
  return ["BKN", "OVC", "VV"].includes(String(layer?.cover || "").toUpperCase())
    && heightFt !== null && heightFt !== undefined && heightFt !== ""
    && ceilingFt !== null && ceilingFt !== undefined && ceilingFt !== ""
    && Number.isFinite(Number(heightFt))
    && Number(ceilingFt) === Number(heightFt);
}

function cloudLayerToken(layer = {}) {
  const heightFt = Number(layer?.heightFt);
  const raw = layer?.raw || (Number.isFinite(heightFt)
    ? `${layer?.cover || "UNK"}${String(Math.round(heightFt / 100)).padStart(3, "0")}${layer?.convective || ""}`
    : `${layer?.cover || "UNK"}///${layer?.convective || ""}`);
  return `${layer?.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${raw}`;
}

function cloudLayerTagWidth(layer = {}) {
  return clamp(
    cloudLayerToken(layer).length * 6.2 + 14,
    CLOUD_LABEL_TAG_MIN_WIDTH,
    CLOUD_LABEL_TAG_MAX_WIDTH,
  );
}

export function meteogramCloudLabelLayout(layers, maximumFt = 10000, {
  minimumGapPx = CLOUD_LABEL_MIN_GAP_PX,
  columnX = 0,
  plotLeft = -100000,
  plotRight = 100000,
} = {}) {
  const values = Array.isArray(layers) ? layers : [];
  const layout = values.map(() => ({ visible: false, y: null, baseY: null, labelX: null, labelY: null, isCeiling: false }));
  const candidates = values.map((layer, index) => {
    const heightFt = Number(layer?.heightFt);
    const baseY = meteogramCloudBaseY(layer?.heightFt, maximumFt);
    if (!Number.isFinite(heightFt) || baseY === null) return null;
    return {
      index,
      layer,
      heightFt,
      baseY,
      isCeiling: cloudLayerIsCeiling(layer),
      conditional: Boolean(layer?.conditional),
      tagWidth: cloudLayerTagWidth(layer),
    };
  }).filter(Boolean);
  const gap = Math.max(10, Number(minimumGapPx) || CLOUD_LABEL_MIN_GAP_PX);
  const sorted = [...candidates].sort((left, right) => left.baseY - right.baseY || left.index - right.index);
  const clusters = [];
  for (const candidate of sorted) {
    const cluster = clusters.at(-1);
    if (!cluster || Math.abs(candidate.baseY - cluster.at(-1).baseY) >= gap) clusters.push([candidate]);
    else cluster.push(candidate);
  }
  for (const cluster of clusters) {
    const ordered = [...cluster].sort((left, right) => (
      Number(right.isCeiling) - Number(left.isCeiling)
      || Number(left.conditional) - Number(right.conditional)
      || left.heightFt - right.heightFt
      || left.index - right.index
    ));
    const totalWidth = ordered.reduce((sum, candidate) => sum + candidate.tagWidth, 0)
      + Math.max(0, ordered.length - 1) * CLOUD_LABEL_TAG_GAP;
    const safeLeft = Number.isFinite(Number(plotLeft)) ? Number(plotLeft) + 4 : -100000;
    const safeRight = Number.isFinite(Number(plotRight)) ? Number(plotRight) - 4 : 100000;
    const safeWidth = Math.max(0, safeRight - safeLeft);
    if (totalWidth > safeWidth) {
      const stacked = [...cluster].sort((left, right) => left.baseY - right.baseY || left.index - right.index);
      const stackGap = 17;
      const stackHeight = Math.max(0, stacked.length - 1) * stackGap;
      const clusterCenterY = stacked.reduce((sum, candidate) => sum + candidate.baseY, 0) / stacked.length;
      const stackTop = clamp(
        clusterCenterY - stackHeight / 2,
        METEOGRAM_ROWS.clouds.top + 8,
        METEOGRAM_ROWS.clouds.bottom - 20 - stackHeight,
      );
      stacked.forEach((candidate, laneIndex) => {
        const tagWidth = Math.min(candidate.tagWidth, safeWidth);
        const labelX = clamp(
          Number(columnX),
          safeLeft + tagWidth / 2,
          Math.max(safeLeft + tagWidth / 2, safeRight - tagWidth / 2),
        );
        layout[candidate.index] = {
          visible: true,
          y: stackTop + laneIndex * stackGap,
          baseY: candidate.baseY,
          labelX,
          labelY: stackTop + laneIndex * stackGap,
          tagWidth,
          naturalTagWidth: candidate.tagWidth,
          lane: laneIndex - (stacked.length - 1) / 2,
          leaderTargetX: Number(columnX),
          leaderTargetY: candidate.baseY,
          stacked: true,
          isCeiling: candidate.isCeiling,
        };
      });
      continue;
    }
    const calloutGap = 9;
    const leftCursor = Number(columnX) - calloutGap - totalWidth;
    const rightCursor = Number(columnX) + calloutGap;
    let cursor = leftCursor >= safeLeft
      ? leftCursor
      : rightCursor + totalWidth <= safeRight
        ? rightCursor
        : clamp(Number(columnX) - totalWidth / 2, safeLeft, Math.max(safeLeft, safeRight - totalWidth));
    ordered.forEach((candidate, laneIndex) => {
      const labelX = cursor + candidate.tagWidth / 2;
      cursor += candidate.tagWidth + CLOUD_LABEL_TAG_GAP;
      layout[candidate.index] = {
        visible: true,
        y: candidate.baseY,
        baseY: candidate.baseY,
        labelX,
        labelY: candidate.baseY,
        tagWidth: candidate.tagWidth,
        lane: laneIndex - (ordered.length - 1) / 2,
        leaderTargetX: Number(columnX),
        leaderTargetY: candidate.baseY,
        isCeiling: candidate.isCeiling,
      };
    });
  }
  return layout;
}

export function meteogramCloudFormDefinition(layer = {}) {
  const cover = String(layer?.cover || "SCT").toUpperCase();
  const convective = String(layer?.convective || "").toUpperCase();
  const definitions = {
    FEW: {
      morphology: "sparse-isolated-puffs",
      silhouette: "isolated-clusters",
      coverage: 0.56,
      occupiedRatio: 0.23,
      gapCount: 1,
      continuousBase: false,
      nominalHeight: 18,
      paths: [
        "M-60 0C-60-4-57-7-52-7C-50-13-42-16-36-11C-31-11-28-7-28 0Z",
        "M31 0C31-4 34-7 39-7C42-13 50-15 56-10C61-10 64-6 64 0Z",
      ],
    },
    SCT: {
      morphology: "scattered-groups-with-openings",
      silhouette: "separated-cloud-groups",
      coverage: 0.82,
      occupiedRatio: 0.55,
      gapCount: 2,
      continuousBase: false,
      nominalHeight: 24,
      paths: [
        "M-76 0C-76-6-71-10-64-9C-60-17-49-20-42-12C-35-13-30-8-30 0Z",
        "M-20 0C-20-6-15-10-8-10C-4-19 9-22 17-13C24-14 29-8 29 0Z",
        "M43 0C43-5 47-9 53-9C57-16 67-18 73-11C78-11 81-7 81 0Z",
      ],
    },
    BKN: {
      morphology: "mostly-continuous-broken-deck",
      silhouette: "broad-broken-deck",
      coverage: 0.96,
      occupiedRatio: 0.91,
      gapCount: 1,
      continuousBase: false,
      nominalHeight: 31,
      paths: [
        "M-80 0V-7C-74-13-67-14-60-12C-55-23-41-27-31-18C-22-25-8-24-1-14C3-11 5-6 5 0Z",
        "M14 0V-8C19-15 27-17 35-14C42-25 57-28 67-18C76-19 82-12 82-5V0Z",
      ],
    },
    OVC: {
      morphology: "continuous-unbroken-deck",
      silhouette: "continuous-overcast-deck",
      coverage: 1,
      occupiedRatio: 1,
      gapCount: 0,
      continuousBase: true,
      nominalHeight: 31,
      paths: [
        "M-82 0V-8C-76-14-68-15-60-13C-53-22-40-24-30-16C-21-22-7-23 2-15C12-22 26-22 35-14C45-21 59-20 67-12C75-14 82-9 82-4V0Z",
      ],
    },
    VV: {
      morphology: "vertical-visibility-obscuration",
      silhouette: "obscuration-veil",
      coverage: 0.96,
      occupiedRatio: 1,
      gapCount: 0,
      continuousBase: false,
      nominalHeight: 38,
      paths: [],
    },
  };
  const definition = definitions[cover] || definitions.SCT;
  return { cover, convective, ...definition };
}

function cloudShapeMarkup(layer, width, baseY, idPrefix = "aviationMeteogram") {
  const definition = meteogramCloudFormDefinition(layer);
  const { cover, convective, morphology, silhouette, paths } = definition;
  const baseHeight = CLOUD_VISUAL_HEIGHT_PX[cover] || CLOUD_VISUAL_HEIGHT_PX.SCT;
  const scaleX = Math.max(18, Number(width) || 18) / CLOUD_FORM_SCENE_WIDTH;
  const symbolicHeight = convective === "CB" ? 80 : convective === "TCU" ? 58 : cover === "VV" ? 42 : baseHeight;
  const availableHeadroom = Math.max(1, Number(baseY) - METEOGRAM_ROWS.clouds.top - 2);
  const headroomScale = Math.min(1, availableHeadroom / symbolicHeight);
  const scaleY = (baseHeight / Math.max(1, definition.nominalHeight || baseHeight)) * headroomScale;
  const veil = cover === "VV"
    ? `<g class="aviation-meteogram-cloud-vv-obscuration" aria-hidden="true" transform="scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)})">
        <path class="aviation-meteogram-cloud-vv-veil-fill" vector-effect="non-scaling-stroke" style="fill:url(#${idPrefix}CloudVerticalFill)" d="M-82 4V-13C-62-22-43-14-24-19C-4-25 16-15 35-20C54-24 72-17 82-11V4Z"/>
        <g class="aviation-meteogram-cloud-vv-wisps">
          <path class="aviation-meteogram-cloud-vv-veil" vector-effect="non-scaling-stroke" d="M-60-34C-67-25-51-17-59-5M-26-40C-34-29-17-21-26-7M10-37C2-26 20-18 10-4M48-32C39-22 57-14 48-3"/>
          <path class="aviation-meteogram-cloud-vv-band" vector-effect="non-scaling-stroke" d="M-82-10C-56-2-35-17-10-8C13 0 38-16 82-7"/>
        </g>
      </g>`
    : "";
  const development = convective === "TCU"
    ? `<g class="aviation-meteogram-cloud-development aviation-meteogram-cloud-development-TCU" data-cloud-development="TCU" aria-hidden="true" transform="scale(${Math.max(.48, Math.min(.9, Number(width) / 112)).toFixed(3)} ${headroomScale.toFixed(4)})">
        <path class="aviation-meteogram-cloud-tower" vector-effect="non-scaling-stroke" style="fill:url(#${idPrefix}CloudFill)" d="M-22 0C-25-12-18-18-11-20C-17-30-10-38-2-37C-4-49 7-57 17-50C27-49 31-39 27-31C36-25 34-13 27-8L30 0Z"/>
      </g>`
    : convective === "CB"
      ? `<g class="aviation-meteogram-cloud-development aviation-meteogram-cloud-development-CB" data-cloud-development="CB" aria-hidden="true" transform="scale(${Math.max(.52, Math.min(1, Number(width) / 108)).toFixed(3)} ${headroomScale.toFixed(4)})">
          <path class="aviation-meteogram-cloud-tower" vector-effect="non-scaling-stroke" style="fill:url(#${idPrefix}CloudFill)" d="M-25 0C-29-14-20-23-11-25C-18-36-9-46 2-45C0-59 13-70 26-62C37-60 42-48 36-39C46-30 42-16 33-10L37 0Z"/>
          <path class="aviation-meteogram-cloud-anvil" vector-effect="non-scaling-stroke" style="fill:url(#${idPrefix}CloudFill)" d="M-5-63C7-76 25-80 41-72C55-72 66-67 74-60C58-57 44-56 32-57C20-52 7-54-5-63Z"/>
        </g>`
      : "";
  const fillId = cover === "VV" ? `${idPrefix}CloudVerticalFill` : `${idPrefix}CloudFill`;
  return `<g class="aviation-meteogram-cloud-form aviation-meteogram-cloud-form-${cover}${convective ? ` aviation-meteogram-cloud-form-${convective}` : ""}" data-cloud-form="${cover}" data-cloud-morphology="${morphology}" data-cloud-silhouette="${silhouette}" data-cloud-occupied-ratio="${definition.occupiedRatio}" data-cloud-gap-count="${definition.gapCount}" data-cloud-continuous-base="${definition.continuousBase}" data-cloud-body-count="${paths.length}" data-cloud-art-base-y="${baseY.toFixed(1)}" data-cloud-headroom-scale="${headroomScale.toFixed(4)}"${convective ? ` data-cloud-development="${convective}"` : ""} aria-hidden="true" transform="translate(0 ${baseY.toFixed(1)})">
    <g class="aviation-meteogram-cloud-coverage" transform="scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)})">
      ${paths.map((path) => `<path class="aviation-meteogram-cloud-body${cover === "VV" ? " aviation-meteogram-cloud-vv-body" : ""}" vector-effect="non-scaling-stroke" style="fill:url(#${fillId})" d="${path}"/>`).join("")}
    </g>${veil}${development}
  </g>`;
}

function weatherCodeMeaning(code) {
  const value = String(code || "").toUpperCase();
  const intensity = value.startsWith("-") ? "LIGHT " : value.startsWith("+") ? "HEAVY " : "";
  const vicinity = value.includes("VC") ? "IN THE VICINITY: " : "";
  const meanings = [];
  if (value.includes("TS")) meanings.push("THUNDERSTORM");
  if (value.includes("SH") && !value.includes("TS")) meanings.push("SHOWERS");
  if (value.includes("FZ")) meanings.push("FREEZING");
  if (value.includes("DZ")) meanings.push("DRIZZLE");
  if (value.includes("RA")) meanings.push("RAIN");
  if (value.includes("BLSN")) meanings.push("BLOWING SNOW");
  else if (value.includes("DRSN")) meanings.push("DRIFTING SNOW");
  else if (value.includes("SN")) meanings.push("SNOW");
  if (value.includes("SG")) meanings.push("SNOW GRAINS");
  if (value.includes("PL")) meanings.push("ICE PELLETS");
  if (value.includes("GR")) meanings.push("HAIL");
  if (value.includes("GS")) meanings.push("SMALL HAIL OR SNOW PELLETS");
  if (value.includes("FG")) meanings.push("FOG");
  if (value.includes("BR")) meanings.push("MIST");
  if (value.includes("HZ")) meanings.push("HAZE");
  return `${vicinity}${intensity}${meanings.join(" AND ") || value}`.trim();
}

function weatherPhenomenonDefinition(code, { conditional = false, provenance = "PREVAILING" } = {}) {
  const value = String(code || "").toUpperCase();
  const density = value.startsWith("+") ? 3 : value.startsWith("-") ? 1 : 2;
  const windDrivenSnow = /(?:BL|DR)SN/.test(value);
  return {
    code: value,
    meaning: weatherCodeMeaning(value),
    conditional,
    provenance,
    density,
    vicinity: value.includes("VC"),
    showers: value.includes("SH"),
    thunder: value.includes("TS"),
    freezing: /FZ(?:RA|DZ)/.test(value),
    rain: value.includes("RA") || value.includes("VCSH"),
    drizzle: value.includes("DZ"),
    snow: !windDrivenSnow && /SN|SG/.test(value),
    windDrivenSnow,
    icePellets: value.includes("PL"),
    hail: value.includes("GR"),
    smallHail: value.includes("GS"),
    fog: value.includes("FG"),
    mist: value.includes("BR"),
    haze: value.includes("HZ"),
  };
}

export function meteogramWeatherSceneDefinition(observation = {}) {
  const normalizedCodes = (codes) => [...new Set((Array.isArray(codes) ? codes : [])
    .map((code) => String(code || "").toUpperCase())
    .filter(Boolean))];
  const groups = [];
  const prevailingCodes = normalizedCodes(observation.weatherCodes);
  if (prevailingCodes.length) {
    groups.push({
      provenance: "PREVAILING",
      conditional: false,
      codes: prevailingCodes,
      phenomena: prevailingCodes.map((code) => weatherPhenomenonDefinition(code)),
    });
  }
  for (const entry of forecastOverlays(observation)) {
    const codes = normalizedCodes(entry.conditions?.weatherCodes);
    if (!codes.length) continue;
    const provenance = conditionalTypeLabel(entry);
    groups.push({
      provenance,
      conditional: true,
      codes,
      phenomena: codes.map((code) => weatherPhenomenonDefinition(code, { conditional: true, provenance })),
    });
  }
  const phenomena = groups.flatMap((group) => group.phenomena);
  const codes = [...new Set(phenomena.map((phenomenon) => phenomenon.code))];
  const any = (property) => phenomena.some((phenomenon) => phenomenon[property]);
  return {
    groups,
    phenomena,
    codes,
    meanings: phenomena.map((phenomenon) => phenomenon.meaning),
    conditional: groups.some((group) => group.conditional),
    vicinity: any("vicinity"),
    showers: any("showers"),
    thunder: any("thunder"),
    freezing: any("freezing"),
    rain: any("rain"),
    drizzle: any("drizzle"),
    snow: any("snow"),
    icePellets: any("icePellets"),
    hail: any("hail"),
    smallHail: any("smallHail"),
    fog: any("fog"),
    mist: any("mist"),
    haze: any("haze"),
    density: Math.max(0, ...phenomena.map((phenomenon) => phenomenon.density)),
  };
}

function atmosphericPhenomenonMarkup(phenomenon, width) {
  const safeWidth = Math.max(20, Number(width) || 20);
  const localized = phenomenon.showers || phenomenon.vicinity;
  const span = safeWidth * (localized ? 0.44 : 0.76);
  const shift = phenomenon.vicinity ? safeWidth * 0.24 : 0;
  const count = phenomenon.density === 3 ? 9 : phenomenon.density === 1 ? 3 : 6;
  const positions = Array.from({ length: count }, (_, index) => (
    shift - span / 2 + (index + 1) * span / (count + 1)
  ));
  const liquidMarks = (type, enabled, xOffset = 0) => enabled
    ? `<g class="aviation-meteogram-atmosphere-precip aviation-meteogram-atmosphere-${type}" data-weather-${type}-density="${phenomenon.density}" aria-hidden="true">
        ${positions.map((x, index) => {
          const top = WEATHER_OVERLAY_ZONE_TOP + 1 + (index % 2) * 2;
          const length = type === "drizzle" ? 5 : 11;
          const startX = x + xOffset;
          return `<line x1="${startX.toFixed(1)}" y1="${top}" x2="${(startX - (type === "drizzle" ? 1 : 4)).toFixed(1)}" y2="${top + length}"/>`;
        }).join("")}
      </g>`
    : "";
  const rain = liquidMarks("rain", phenomenon.rain, phenomenon.drizzle ? -1.5 : 0);
  const drizzle = liquidMarks("drizzle", phenomenon.drizzle, phenomenon.rain ? 1.5 : 0);
  const snow = phenomenon.snow
    ? `<g class="aviation-meteogram-atmosphere-precip aviation-meteogram-atmosphere-snow" data-weather-snow-density="${phenomenon.density}" aria-hidden="true">
        ${positions.map((x, index) => `<path transform="translate(${x.toFixed(1)} ${WEATHER_OVERLAY_ZONE_TOP + 2 + (index % 3) * 6})" d="M-3 0H3M0-3V3M-2-2L2 2M2-2L-2 2"/>`).join("")}
      </g>`
    : "";
  const pelletCount = phenomenon.density === 3 ? 8 : phenomenon.density === 1 ? 3 : 5;
  const pelletMarks = (type, enabled, radius, xOffset = 0) => enabled
    ? `<g class="aviation-meteogram-atmosphere-pellets aviation-meteogram-atmosphere-${type}" aria-hidden="true">
        ${Array.from({ length: pelletCount }, (_, index) => {
          const x = shift - span / 2 + (index + 1) * span / (pelletCount + 1) + xOffset;
          return `<circle cx="${x.toFixed(1)}" cy="${WEATHER_OVERLAY_ZONE_TOP + 2 + (index % 2) * 9}" r="${radius}"/>`;
        }).join("")}
      </g>`
    : "";
  const pellets = [
    pelletMarks("ice-pellets", phenomenon.icePellets, 1.9, (phenomenon.hail || phenomenon.smallHail) ? -2 : 0),
    pelletMarks("hail", phenomenon.hail, 2.5, phenomenon.icePellets ? 0 : phenomenon.smallHail ? -1.5 : 0),
    pelletMarks("small-hail", phenomenon.smallHail, 1.6, (phenomenon.icePellets || phenomenon.hail) ? 2 : 0),
  ].join("");
  const obscuration = phenomenon.fog || phenomenon.mist || phenomenon.haze
    ? `<g class="aviation-meteogram-atmosphere-obscuration aviation-meteogram-atmosphere-${phenomenon.fog ? "fog" : phenomenon.mist ? "mist" : "haze"}" aria-hidden="true">
        <path d="M${(-safeWidth / 2).toFixed(1)} ${WEATHER_OVERLAY_ZONE_TOP + 2}Q${(-safeWidth / 4).toFixed(1)} ${WEATHER_OVERLAY_ZONE_TOP - 4} 0 ${WEATHER_OVERLAY_ZONE_TOP + 2}T${(safeWidth / 2).toFixed(1)} ${WEATHER_OVERLAY_ZONE_TOP + 2}"/>
        <path d="M${(-safeWidth / 2).toFixed(1)} ${WEATHER_OVERLAY_ZONE_BOTTOM - 1}Q${(-safeWidth / 4).toFixed(1)} ${WEATHER_OVERLAY_ZONE_BOTTOM - 7} 0 ${WEATHER_OVERLAY_ZONE_BOTTOM - 1}T${(safeWidth / 2).toFixed(1)} ${WEATHER_OVERLAY_ZONE_BOTTOM - 1}"/>
      </g>`
    : "";
  const ice = phenomenon.freezing
    ? `<g class="aviation-meteogram-atmosphere-freezing" aria-hidden="true"><path d="M${(shift - 16).toFixed(1)} ${WEATHER_OVERLAY_ZONE_BOTTOM - 3}l4-4 4 4-4 4Z M${(shift + 9).toFixed(1)} ${WEATHER_OVERLAY_ZONE_TOP + 3}l4-4 4 4-4 4Z"/></g>`
    : "";
  const thunder = phenomenon.thunder
    ? `<path class="aviation-meteogram-atmosphere-lightning" data-weather-lightning="reported-thunder" aria-hidden="true" d="M${(shift + 4).toFixed(1)} ${METEOGRAM_ROWS.clouds.top + 72}l-10 21h8l-5 19 18-26h-9l8-12Z"/>`
    : "";
  return `<g class="aviation-meteogram-atmosphere-phenomenon${phenomenon.vicinity ? " aviation-meteogram-atmosphere-vicinity" : ""}${phenomenon.showers ? " aviation-meteogram-atmosphere-showers" : ""}${phenomenon.conditional ? " aviation-meteogram-atmosphere-conditional" : ""}" data-weather-code="${escapeMarkup(phenomenon.code)}" data-weather-density="${phenomenon.density}" data-weather-provenance="${escapeMarkup(phenomenon.provenance)}" data-weather-zone-top="${WEATHER_OVERLAY_ZONE_TOP}" data-weather-zone-bottom="${WEATHER_OVERLAY_ZONE_BOTTOM}" aria-hidden="true">
    ${obscuration}${rain}${drizzle}${snow}${pellets}${ice}${thunder}
  </g>`;
}

function atmosphericWeatherMarkup(observation, width) {
  const scene = meteogramWeatherSceneDefinition(observation);
  if (!scene.codes.length) return "";
  const accessible = `${scene.groups.map((group) => `${group.provenance}: ${group.phenomena.map((phenomenon) => phenomenon.meaning).join(", ")}`).join("; ")} · qualitative weather illustration; no precipitation amount or producing cloud layer is inferred`;
  return `<g class="aviation-meteogram-atmosphere" data-weather-codes="${escapeMarkup(scene.codes.join(" "))}" data-weather-density="${scene.density}" role="img" aria-label="${escapeMarkup(accessible)}">
    <title>${escapeMarkup(accessible)}</title>${scene.phenomena.map((phenomenon) => atmosphericPhenomenonMarkup(phenomenon, width)).join("")}
  </g>`;
}

function skyStatusMarkup(observation, width) {
  const clouds = observation?.clouds || {};
  if (!clouds.clear && !clouds.cavok) return "";
  const rawCode = clouds.cavok ? "CAVOK" : String(clouds.display || "CLR").toUpperCase();
  const label = clouds.cavok
    ? "CAVOK reported; visibility and significant-weather criteria met, not a literal clear-sky report"
    : `${rawCode} reported; no cloud deck is inferred`;
  return `<g class="aviation-meteogram-sky-status aviation-meteogram-sky-status-${clouds.cavok ? "cavok" : "clear"}" data-sky-status="${escapeMarkup(rawCode)}" role="img" aria-label="${escapeMarkup(label)}">
    <title>${escapeMarkup(label)}</title>
  </g>`;
}

function cloudAccessibleText(clouds = {}) {
  const layerText = (clouds.layers || []).map((layer) => {
    const cover = { FEW: "FEW CLOUD", SCT: "SCATTERED CLOUD", BKN: "BROKEN CLOUD", OVC: "OVERCAST", VV: "VERTICAL VISIBILITY" }[layer.cover] || layer.cover || "CLOUD";
    const base = layer.heightFt === null || layer.heightFt === undefined
      ? "BASE NOT REPORTED"
      : `${Number(layer.heightFt).toLocaleString("en-US")} FT AGL`;
    const development = layer.convective === "CB" ? " · CUMULONIMBUS REPORTED" : layer.convective === "TCU" ? " · TOWERING CUMULUS REPORTED" : "";
    return layer.cover === "VV"
      ? `VERTICAL VISIBILITY ${base} IN OBSCURATION`
      : `${cover} BASE ${base}${development} · CLOUD TOP NOT REPORTED`;
  });
  if (layerText.length) return layerText.join("; ");
  if (clouds.cavok) return "CAVOK REPORTED; NOT INTERPRETED AS LITERAL CLEAR SKY";
  if (clouds.clear) return `${clouds.display || "CLEAR"} REPORTED; NO CLOUD DECK INFERRED`;
  return "CLOUD INFORMATION UNAVAILABLE";
}

function visualCeilingLabel(clouds) {
  const value = clouds && typeof clouds === "object" ? clouds : {};
  if (value.ceilingFt !== null && value.ceilingFt !== undefined) {
    return `CIG ${Number(value.ceilingFt).toLocaleString("en-US")} FT`;
  }
  if ((value.layers || []).some((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && layer.heightFt === null)) return "CIG UNKNOWN";
  if (value.cavok) return "CAVOK · NO CIG <5K";
  const clearToken = String(value.display || "").toUpperCase();
  if (clearToken === "NSC") return "NSC · NO SIG CLOUD";
  if (clearToken === "NCD") return "NCD · NO CLOUD DETECTED";
  if (value.clear || (value.layers || []).length) return "NO CIG";
  return "—";
}

function cloudColumnLabelWidth(observation, minimumWidth) {
  const layers = cloudLayersForObservation(observation);
  const texts = [visualCeilingLabel(observation?.clouds)];
  const unknownTexts = [];
  for (const layer of layers) {
    const unknownBase = layer.heightFt === null || layer.heightFt === undefined || layer.heightFt === "" || !Number.isFinite(Number(layer.heightFt));
    const raw = layer.raw || (unknownBase
      ? `${layer.cover || "UNK"}///`
      : `${layer.cover || "UNK"}${String(Math.round(Number(layer.heightFt) / 100)).padStart(3, "0")}${layer.convective || ""}`);
    const label = `${layer.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${raw}`;
    texts.push(`${label}${unknownBase ? " BASE UNKNOWN" : ""}`);
    if (unknownBase) unknownTexts.push(label);
  }
  if (unknownTexts.length) texts.push(`${unknownTexts.join(" · ")} BASE UNKNOWN`);
  const maximumCharacters = Math.max(0, ...texts.map((text) => String(text || "").length));
  return clamp(Math.max(minimumWidth, maximumCharacters * 6.2 + 16), minimumWidth, 380);
}

function cloudColumnLabelPriority(observation) {
  const layers = cloudLayersForObservation(observation);
  if (layers.some(cloudLayerIsCeiling)) return 1000;
  if (layers.some((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && (layer.heightFt === null || layer.heightFt === undefined))) return 950;
  const knownHeights = layers
    .filter((layer) => layer.heightFt !== null && layer.heightFt !== undefined && layer.heightFt !== "")
    .map((layer) => Number(layer.heightFt))
    .filter(Number.isFinite);
  if (knownHeights.length) return 700 - Math.min(...knownHeights) / 100000;
  return observation?.clouds?.cavok ? 400 : 300;
}

export function meteogramCloudColumnLabelMask(timeline, xPositions, minimumWidth = 56) {
  const observations = Array.isArray(timeline) ? timeline : [];
  const positions = Array.isArray(xPositions) ? xPositions : [];
  const visible = observations.map(() => false);
  const candidates = observations.map((observation, index) => ({
    index,
    priority: cloudColumnLabelPriority(observation),
    x: Number(positions[index]),
    halfWidth: cloudColumnLabelWidth(observation, minimumWidth) / 2,
  })).filter((candidate) => Number.isFinite(candidate.x));
  candidates.sort((left, right) => right.priority - left.priority || right.index - left.index);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((other) => Math.abs(other.x - candidate.x) < other.halfWidth + candidate.halfWidth)) continue;
    visible[candidate.index] = true;
    selected.push(candidate);
  }
  return visible;
}

export function buildMeteogramSvgMarkup(model, settings = {}, {
  viewportWidth = 1100,
  labelLayout: requestedLabelLayout = null,
  timeBounds = null,
  scaleOverrides = null,
  idPrefix: requestedIdPrefix = "aviationMeteogram",
  pixelsPerHour = null,
  printMode = false,
} = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  const boundedTimes = [timeBounds?.startZ, timeBounds?.endZ].filter(Boolean);
  const intervalTimes = intervalExtraTimes(model);
  if (!timeline.length && !intervalTimes.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const observedCount = timeline.findIndex(isForecast) < 0 ? timeline.length : timeline.findIndex(isForecast);
  const hasForecastIntervals = [model?.forecastPrecipitationIntervals, model?.forecastSnowfallIntervals]
    .some((values) => Array.isArray(values) && values.length > 0);
  const hasForecast = observedCount < timeline.length || hasForecastIntervals;
  const labelLayout = requestedLabelLayout || meteogramRowLabelLayout(normalizedSettings, viewportWidth, {
    hasForecast,
    compact: Number(viewportWidth) <= 768,
  });
  const dimensions = meteogramDimensions(timeline, viewportWidth, {
    extraTimes: [...intervalTimes, ...boundedTimes],
    labelWidth: labelLayout.width,
    pixelsPerHour,
  });
  const { labelWidth, axisWidth, plotLeft, columnWidth, width, height, xPositions, cellBounds } = dimensions;
  const hasValidTimelineTime = timeline.some((observation) => Number.isFinite(Date.parse(timelineTime(observation))))
    || boundedTimes.some((value) => Number.isFinite(Date.parse(value)));
  const solarEvents = hasValidTimelineTime
    ? meteogramSolarEvents(new Date(dimensions.firstTime), new Date(dimensions.lastTime), { station: model.station })
    : [];
  const rows = METEOGRAM_ROWS;
  const xAt = (index) => xPositions[index];
  const cellWidthAt = (index) => Math.max(0, cellBounds[index].right - cellBounds[index].left);
  const visualLabelMask = meteogramVisualLabelMask(timeline, xPositions);
  const forecastSources = meteogramForecastSourceState(model);
  const dividerTime = model.dividerZ || timeline[observedCount]?.validZ;
  const dividerTimestamp = Date.parse(dividerTime);
  const dividerX = hasForecast
    ? dimensions.xForTime(dividerTime)
    : width;
  const showNowDivider = hasForecast && (
    !timeBounds
    || !Number.isFinite(dividerTimestamp)
    || (dividerTimestamp >= Date.parse(timeBounds.startZ) && dividerTimestamp < Date.parse(timeBounds.endZ))
  );
  const idPrefix = String(requestedIdPrefix || "aviationMeteogram").replace(/[^A-Za-z0-9_-]/g, "") || "aviationMeteogram";

  const temperatureGeometry = meteogramTemperatureGeometry(model, normalizedSettings, dimensions, {
    range: scaleOverrides?.temperatureRange,
  });
  const tempPoints = temperatureGeometry.temperaturePoints;
  const dewPoints = temperatureGeometry.dewPointPoints;
  const windSpeedGeometry = meteogramWindSpeedGeometry(model, normalizedSettings, dimensions, {
    maximumKt: scaleOverrides?.windMaximumKt,
  });

  const pressureRange = validScaleRange(scaleOverrides?.pressureRange)
    || usableRange(timeline.map((observation) => observation.pressureInHg), { minimumSpan: 0.08, padding: 0.18 });
  const pressurePoints = timeline.map((observation, index) => {
    const y = scaledY(observation.pressureInHg, pressureRange, rows.pressure.top + 34, rows.pressure.bottom - 12);
    return y === null ? null : { x: xAt(index), y };
  });

  const visibilityRange = validScaleRange(scaleOverrides?.visibilityRange)
    || usableRange(timeline.map((observation) => observation.visibilitySm), { minimumSpan: 3, padding: 0.05 });
  if (!validScaleRange(scaleOverrides?.visibilityRange)) visibilityRange.minimum = Math.min(0, visibilityRange.minimum);
  const visibilityPoints = timeline.map((observation, index) => {
    const y = scaledY(observation.visibilitySm, visibilityRange, rows.visibility.top + 35, rows.visibility.bottom - 11);
    return y === null ? null : { x: xAt(index), y };
  });

  const horizontalLines = Object.values(rows).map((row) => `<line class="aviation-meteogram-grid-line" x1="0" y1="${row.bottom}" x2="${width}" y2="${row.bottom}"/>`).join("");
  const boundaryXs = !timeline.length && boundedTimes.length
    ? boundedTimes.map((value) => dimensions.xForTime(value))
    : [];
  const verticalLines = timeline.map((_, index) => {
    const x = xAt(index);
    return `<line class="aviation-meteogram-time-line" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}"/>`;
  }).join("") + boundaryXs.map((x) => `<line class="aviation-meteogram-time-line aviation-meteogram-time-boundary" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}"/>`).join("")
    + `<line class="aviation-meteogram-time-line" x1="${width.toFixed(1)}" y1="0" x2="${width.toFixed(1)}" y2="${height}"/>`;
  const solarLineMarkup = solarEvents.map((event) => {
    const x = dimensions.xForTime(event.timestamp);
    const title = solarEventAccessibleLabel(event, model.station);
    return `<g class="aviation-meteogram-solar-event aviation-meteogram-solar-event-${event.type}" data-solar-event="${event.type}" data-event-z="${event.timestamp}" data-event-local-date="${event.localDate}" data-event-x="${x.toFixed(1)}">
      <title>${escapeMarkup(title)}</title>
      <line class="aviation-meteogram-solar-line" x1="${x.toFixed(1)}" y1="18" x2="${x.toFixed(1)}" y2="${height}"/>
    </g>`;
  }).join("");
  const solarLabelMarkup = solarEvents.map((event) => {
    const x = dimensions.xForTime(event.timestamp);
    return `<g class="aviation-meteogram-solar-label aviation-meteogram-solar-label-${event.type}" data-solar-label="${event.type}" transform="translate(${x.toFixed(1)} 0)" aria-hidden="true">
      <rect x="-30" y="2" width="60" height="14" rx="3"/>
      <text x="0" y="12">${event.type.toUpperCase()}</text>
    </g>`;
  }).join("");

  let previousVisibleTime = null;
  const timeMarkup = timeline.map((observation, index) => {
    const time = formatMeteogramTime(timelineTime(observation), { mode: normalizedSettings.timeMode, station: model.station });
    const showDate = !previousVisibleTime || previousVisibleTime.date !== time.date;
    const atDivider = hasForecast && index === observedCount;
    if (visualLabelMask[index]) previousVisibleTime = time;
    return `<g class="aviation-meteogram-time${isForecast(observation) ? " aviation-meteogram-time-forecast" : ""}${atDivider ? " aviation-meteogram-time-at-divider" : ""}${visualLabelMask[index] ? "" : " aviation-meteogram-label-suppressed"}" transform="translate(${xAt(index).toFixed(1)} 0)">
      ${visualLabelMask[index] ? `
      <text x="0" y="${atDivider ? 34 : 22}">${escapeMarkup(compactTimeText(time, normalizedSettings.timeMode))}</text>
      <text class="aviation-meteogram-time-zone" x="0" y="${atDivider ? 49 : 39}">${escapeMarkup(showDate ? `${time.date}${normalizedSettings.timeMode === "Z" ? " UTC" : ` ${time.zone}`}` : normalizedSettings.timeMode === "Z" ? "UTC" : time.zone)}</text>` : ""}
    </g>`;
  }).join("");
  const boundaryTimeMarkup = !timeline.length
    ? boundedTimes.map((value, index) => {
      const time = formatMeteogramTime(value, { mode: normalizedSettings.timeMode, station: model.station });
      const x = dimensions.xForTime(value);
      return `<g class="aviation-meteogram-time aviation-meteogram-time-boundary-label" transform="translate(${x.toFixed(1)} 0)">
        <text x="0" y="22">${escapeMarkup(compactTimeText(time, normalizedSettings.timeMode))}</text>
        <text class="aviation-meteogram-time-zone" x="0" y="39">${escapeMarkup(`${time.date}${normalizedSettings.timeMode === "Z" ? " UTC" : ` ${time.zone}`}${index ? " END" : " START"}`)}</text>
      </g>`;
    }).join("")
    : "";

  const weatherMarkup = timeline.map((observation, index) => {
    const bounds = cellBounds[index];
    const weatherCategory = meteogramWeatherVisualCategory(observation);
    return `<g class="aviation-meteogram-observation${isForecast(observation) ? " aviation-meteogram-forecast-column" : ""}" transform="translate(${xAt(index).toFixed(1)} 0)">
    <title>${escapeMarkup(columnTitle(observation, normalizedSettings))}</title>
    <rect class="aviation-meteogram-column-hover" x="${(bounds.left - xAt(index)).toFixed(1)}" y="0" width="${cellWidthAt(index).toFixed(1)}" height="${height}"/>
    ${visualLabelMask[index] ? `${isForecast(observation) ? `<text class="aviation-meteogram-forecast-tag" x="0" y="65">${observation.becoming?.length ? "BECMG" : escapeMarkup(forecastBucketSourceLabel(observation))}</text>` : ""}
    ${weatherIconMarkup(observation, weatherCategory, model.station)}
    <text class="aviation-meteogram-weather-code" x="0" y="109">${escapeMarkup(weatherColumnLabel(observation))}</text>` : ""}
  </g>`;
  }).join("");

  const temperatureValuesMarkup = timeline.map((observation, index) => visualLabelMask[index]
    ? `<text class="aviation-meteogram-temperature-value${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.temperature.top + 29}">${escapeMarkup(formatTemperature(observation.temperatureC, normalizedSettings.temperatureUnit))}</text>`
    : "").join("");
  const dewPointValuesMarkup = timeline.map((observation, index) => visualLabelMask[index]
    ? `<text class="aviation-meteogram-dew-point-value${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.dewPoint.top + 29}">${escapeMarkup(formatTemperature(observation.dewPointC, normalizedSettings.temperatureUnit))}</text>`
    : "").join("");

  const windMarkup = timeline.map((observation, index) => {
    const x = xAt(index);
    const direction = windDirectionLabel(observation);
    const rotation = meteogramWindArrowRotation(observation.windDirectionDeg);
    const speed = formatWind(observation.windSpeedKt, normalizedSettings.windUnit);
    const gust = observation.windGustKt === null || observation.windGustKt === undefined
      ? ""
      : `G${formatWind(observation.windGustKt, normalizedSettings.windUnit)}`;
    const calm = Number(observation.windSpeedKt) === 0
      && observation.windSpeedKt !== null && observation.windSpeedKt !== undefined;
    const directional = observation.windDirectionDeg !== null
      && observation.windDirectionDeg !== undefined
      && !observation.windVariable
      && Number(observation.windSpeedKt) > 0;
    const conditionalWind = forecastOverlays(observation).flatMap((entry) => {
      const value = entry.conditions || {};
      if (value.windSpeedKt === null || value.windSpeedKt === undefined) return [];
      return [`${visualConditionalTypeLabel(entry)} ${windDirectionLabel(value)} ${formatWind(value.windSpeedKt, normalizedSettings.windUnit)} ${normalizedSettings.windUnit}${value.windGustKt === null || value.windGustKt === undefined ? "" : ` G${formatWind(value.windGustKt, normalizedSettings.windUnit)}`}`];
    }).join(" · ");
    const firstLine = calm ? "CALM" : direction;
    const speedLine = calm ? "" : `${speed} ${normalizedSettings.windUnit}`;
    return `<g class="aviation-meteogram-wind-block${isForecast(observation) ? " aviation-meteogram-wind-forecast" : ""}${visualLabelMask[index] ? "" : " aviation-meteogram-label-suppressed"}" transform="translate(${x.toFixed(1)} 0)">
      ${visualLabelMask[index] ? `
      ${directional ? `<g class="aviation-meteogram-wind-arrow" aria-hidden="true" transform="translate(-25 ${rows.wind.top + 25}) rotate(${rotation})"><path d="M0 8V-8M0-8L-4-3M0-8L4-3"/></g>` : ""}
      <text class="aviation-meteogram-wind-heading" x="${directional ? 7 : 0}" y="${rows.wind.top + 29}">${escapeMarkup(firstLine)}</text>
      ${speedLine ? `<text class="aviation-meteogram-wind-speed" x="0" y="${rows.wind.top + 51}">${escapeMarkup(speedLine)}</text>` : ""}
      ${gust ? `<text class="aviation-meteogram-wind-gust" x="0" y="${rows.wind.top + 69}">${escapeMarkup(gust)}</text>` : ""}
      ${conditionalWind ? `<text class="aviation-meteogram-conditional-value" x="0" y="${rows.wind.bottom - 6}">${escapeMarkup(conditionalWind)}</text>` : ""}` : ""}
    </g>`;
  }).join("");

  const windSpeedTickMarkup = windSpeedGeometry.ticks.map((tick) => `<g class="aviation-meteogram-wind-speed-tick" data-speed-kt="${tick.valueKt}" data-speed-display="${tick.value}">
    <line x1="${plotLeft}" y1="${tick.y.toFixed(1)}" x2="${width}" y2="${tick.y.toFixed(1)}"/>
    <text x="${labelWidth + 4}" y="${(tick.y - 2).toFixed(1)}">${escapeMarkup(tick.label)}</text>
  </g>`).join("");
  const windSpeedMarkersMarkup = timeline.map((observation, index) => {
    const sustained = windSpeedGeometry.sustainedPoints[index];
    const gust = windSpeedGeometry.gustPoints[index];
    if (!sustained && !gust) return "";
    const bounds = cellBounds[index];
    const tooltip = windSpeedTooltipText(observation, normalizedSettings);
    const forecastClass = isForecast(observation) ? " aviation-meteogram-wind-speed-sample-forecast" : " aviation-meteogram-wind-speed-sample-observed";
    return `<g class="aviation-meteogram-wind-speed-sample${forecastClass}" data-wind-speed-sample="${index}" data-tooltip-x="${xAt(index).toFixed(1)}" data-wind-tooltip="${multilineAttribute(tooltip)}"${printMode ? "" : ` tabindex="0" role="img" aria-label="${escapeMarkup(tooltip.replace(/\n/g, " · "))}" aria-describedby="${idPrefix}WindTooltip"`} transform="translate(${xAt(index).toFixed(1)} 0)">
      <title>${escapeMarkup(tooltip)}</title>
      <rect class="aviation-meteogram-wind-speed-hit" x="${(bounds.left - xAt(index)).toFixed(1)}" y="${rows.windSpeed.top}" width="${cellWidthAt(index).toFixed(1)}" height="${rows.windSpeed.bottom - rows.windSpeed.top}"/>
      ${sustained ? `<circle class="aviation-meteogram-wind-sustained-marker" data-speed-kt="${sustained.valueKt}" cx="0" cy="${sustained.y.toFixed(1)}" r="${isForecast(observation) ? "2.1" : "2.7"}"/>` : ""}
      ${gust ? `<circle class="aviation-meteogram-wind-gust-marker" data-gust-kt="${gust.valueKt}" cx="0" cy="${gust.y.toFixed(1)}" r="${isForecast(observation) ? "2.1" : "2.7"}"/>` : ""}
    </g>`;
  }).join("");
  const windSpeedSeriesMarkup = `<g class="aviation-meteogram-wind-speed-series" data-domain-min-kt="${windSpeedGeometry.range.minimum}" data-domain-max-kt="${windSpeedGeometry.range.maximum}" data-display-unit="${windSpeedGeometry.unit}" aria-label="Sustained wind solid line and gust dashed line on one zero-based ${windSpeedGeometry.unit} speed scale">
    ${windSpeedTickMarkup}
    ${trendSeriesMarkup(windSpeedGeometry.sustainedPoints, timeline, "aviation-meteogram-wind-sustained-line")}
    ${trendSeriesMarkup(windSpeedGeometry.gustPoints, timeline, "aviation-meteogram-wind-gust-line")}
    ${windSpeedMarkersMarkup}
  </g>`;

  const pressureValuesMarkup = timeline.map((observation, index) => visualLabelMask[index] ? `<text class="aviation-meteogram-pressure-value${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.pressure.top + 23}">${escapeMarkup(observation.pressureInHg === null ? "—" : fixed(observation.pressureInHg, 2))}</text>` : "").join("");

  const cloudScale = meteogramCloudScaleDefinition(timeline, {
    maximumFt: scaleOverrides?.cloudMaximumFt,
  });
  const cloudAxisBoundary = plotLeft;
  const cloudTickLayout = meteogramCloudTickLayout(cloudScale.ticks, cloudScale.maximumFt);
  const cloudTickGridMarkup = cloudTickLayout.map(({ value: tick, y }) => `<g class="aviation-meteogram-cloud-altitude-tick" data-cloud-grid-ft="${tick}">
    <line x1="${cloudAxisBoundary}" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}"/>
  </g>`).join("");
  const cloudTextPositions = timeline.map((observation, index) => {
    const labelHalfWidth = cloudColumnLabelWidth(observation, 56) / 2;
    return clamp(
      Math.max(xAt(index), cloudAxisBoundary + labelHalfWidth + 4),
      cloudAxisBoundary + labelHalfWidth + 4,
      Math.max(cloudAxisBoundary + labelHalfWidth + 4, width - labelHalfWidth - 4),
    );
  });
  const cloudColumnLabelMask = meteogramCloudColumnLabelMask(timeline, cloudTextPositions);
  const cloudArtworkMarkup = [];
  const cloudTextMarkup = [];
  timeline.forEach((observation, index) => {
    const x = xAt(index);
    const textX = cloudTextPositions[index];
    const ceilingText = visualCeilingLabel(observation.clouds);
    const layers = cloudLayersForObservation(observation);
    const knownLayers = layers.filter((layer) => layer.heightFt !== null && layer.heightFt !== undefined && layer.heightFt !== "" && Number.isFinite(Number(layer.heightFt)));
    const unknownLayers = layers.filter((layer) => layer.heightFt === null || layer.heightFt === undefined || layer.heightFt === "" || !Number.isFinite(Number(layer.heightFt)));
    const nominalWidth = Math.min(columnWidth, cellWidthAt(index)) * 0.88;
    const leftArtworkRoom = Math.max(0, (x - cloudAxisBoundary) * 2);
    const rightArtworkRoom = Math.max(0, (width - x) * 2);
    const availableWidth = Math.max(8, Math.min(nominalWidth, leftArtworkRoom, rightArtworkRoom));
    const artX = x;
    const labelCellLeft = Math.max(cloudAxisBoundary, cellBounds[index].left);
    const labelCellRight = Math.min(width, cellBounds[index].right);
    const labelLayout = meteogramCloudLabelLayout(knownLayers, cloudScale.maximumFt, {
      columnX: artX,
      plotLeft: labelCellLeft,
      plotRight: labelCellRight,
    });
    const artLayers = [];
    const textLayers = [];
    knownLayers.forEach((layer, layerIndex) => {
      const baseY = meteogramCloudBaseY(layer.heightFt, cloudScale.maximumFt);
      const raw = layer.raw || `${layer.cover}${String(Math.round(layer.heightFt / 100)).padStart(3, "0")}${layer.convective || ""}`;
      const visibleToken = cloudLayerToken(layer);
      const isCeiling = cloudLayerIsCeiling(layer);
      const className = `aviation-meteogram-cloud-layer aviation-meteogram-cloud-layer-${String(layer.cover || "UNK").toUpperCase()}${isCeiling ? " aviation-meteogram-cloud-layer-ceiling" : ""}${layer.conditional ? " aviation-meteogram-cloud-layer-conditional" : ""}`;
      const form = meteogramCloudFormDefinition(layer);
      const coverageWidth = form.coverage;
      const artWidth = availableWidth * coverageWidth * (layer.conditional ? 0.9 : 1);
      const label = labelLayout[layerIndex];
      const accessibleLayer = `${layer.conditionalLabel ? `${layer.conditionalLabel} · ` : ""}${raw} · ${cloudAccessibleText({ layers: [layer] })}${isCeiling ? " · CEILING" : ""}`;
      artLayers.push(`<g class="${className}" data-cloud-token="${escapeMarkup(raw)}" data-base-ft="${Number(layer.heightFt)}" data-base-y="${baseY.toFixed(1)}" role="img" aria-label="${escapeMarkup(accessibleLayer)}">
        <title>${escapeMarkup(accessibleLayer)}</title>
        ${cloudShapeMarkup(layer, artWidth, baseY, idPrefix)}
      </g>`);
      const markerHalfWidth = Math.max(8, Math.min(16, availableWidth * 0.18));
      const markerX1 = Math.max(cloudAxisBoundary, Math.min(x, artX - markerHalfWidth));
      const markerX2 = Math.min(width, Math.max(x, artX + markerHalfWidth));
      const labelVisible = Boolean(label?.visible);
      const labelX = Number(label?.labelX);
      const labelY = Number(label?.labelY ?? baseY);
      const tagWidth = Number(label?.tagWidth) || cloudLayerTagWidth(layer);
      const labelEdgeX = labelX < artX ? labelX + tagWidth / 2 : labelX - tagWidth / 2;
      const compressedTextLength = Number(label?.naturalTagWidth) > tagWidth ? Math.max(16, tagWidth - 8) : null;
      const leaderMarkup = labelVisible && (Math.abs(labelX - artX) > 2 || Math.abs(labelY - baseY) > 1)
        ? `<line class="aviation-meteogram-cloud-label-leader" data-leader-target-x="${artX.toFixed(1)}" data-leader-target-y="${baseY.toFixed(1)}" x1="${artX.toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${labelEdgeX.toFixed(1)}" y2="${labelY.toFixed(1)}"/>`
        : "";
      const labelMarkup = labelVisible
        ? `${leaderMarkup}<rect class="aviation-meteogram-cloud-layer-label-tag${isCeiling ? " aviation-meteogram-cloud-layer-label-tag-ceiling" : ""}" x="${(labelX - tagWidth / 2).toFixed(1)}" y="${(labelY - 7).toFixed(1)}" width="${tagWidth.toFixed(1)}" height="14" rx="2"/>
          <text class="aviation-meteogram-cloud-layer-label${isCeiling ? " aviation-meteogram-cloud-layer-label-ceiling" : ""}" data-cloud-label="${escapeMarkup(raw)}" data-label-anchor-y="${labelY.toFixed(1)}" data-cloud-callout-lane="${label.lane}" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}"${compressedTextLength ? ` textLength="${compressedTextLength.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ""} dominant-baseline="middle">${escapeMarkup(visibleToken)}</text>`
        : "";
      textLayers.push(`<g class="${className} aviation-meteogram-cloud-anchor" data-cloud-token="${escapeMarkup(raw)}" data-base-ft="${Number(layer.heightFt)}" data-base-y="${baseY.toFixed(1)}" data-cloud-label-visible="${labelVisible}">
        <line class="aviation-meteogram-cloud-base-line" data-cloud-base-marker="${escapeMarkup(raw)}" data-marker-y="${baseY.toFixed(1)}" x1="${markerX1.toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${markerX2.toFixed(1)}" y2="${baseY.toFixed(1)}"/>
        ${labelMarkup}
      </g>`);
    });
    const unknownMarkup = cloudColumnLabelMask[index] && unknownLayers.length
      ? `<text class="aviation-meteogram-cloud-unknown" x="${textX.toFixed(1)}" y="${rows.clouds.top + 16}">${escapeMarkup(unknownLayers.map((layer) => `${layer.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${layer.raw || `${layer.cover}///`}`).join(" · "))} BASE UNKNOWN</text>`
      : "";
    const forecastClass = isForecast(observation) ? " aviation-meteogram-cloud-forecast" : "";
    cloudArtworkMarkup.push(`<g class="aviation-meteogram-cloud aviation-meteogram-cloud-artwork${forecastClass}" data-cloud-time-x="${x.toFixed(1)}" data-cloud-art-x="${artX.toFixed(1)}" data-cloud-art-offset-x="${(artX - x).toFixed(1)}" transform="translate(${artX.toFixed(1)} 0)">${skyStatusMarkup(observation, availableWidth)}${artLayers.join("")}${atmosphericWeatherMarkup(observation, availableWidth)}</g>`);
    cloudTextMarkup.push(`<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text${forecastClass}" data-cloud-time-x="${x.toFixed(1)}" data-cloud-text-x="${textX.toFixed(1)}">
      ${textLayers.join("")}${unknownMarkup}
      ${cloudColumnLabelMask[index] ? `<text class="aviation-meteogram-ceiling-value" x="${textX.toFixed(1)}" y="${rows.clouds.bottom - 9}">${escapeMarkup(ceilingText)}</text>` : ""}
    </g>`);
  });

  const visibilityValuesMarkup = timeline.map((observation, index) => {
    const conditionalVisibility = forecastOverlays(observation).flatMap((entry) => {
      const value = entry.conditions || {};
      return value.visibilitySm === null || value.visibilitySm === undefined
        ? []
        : [`${visualConditionalTypeLabel(entry)} ${value.visibilityDisplay || visibilityLabel(value)}`];
    }).join(" · ");
    return `<g class="aviation-meteogram-visibility${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}${visualLabelMask[index] ? "" : " aviation-meteogram-label-suppressed"}">
      ${visualLabelMask[index] ? `
      <text class="aviation-meteogram-visibility-value" x="${xAt(index).toFixed(1)}" y="${rows.visibility.top + 24}">${escapeMarkup(visibilityLabel(observation))}</text>
      ${conditionalVisibility ? `<text class="aviation-meteogram-conditional-value" x="${xAt(index).toFixed(1)}" y="${rows.visibility.top + 46}">${escapeMarkup(conditionalVisibility)}</text>` : ""}` : ""}
    </g>`;
  }).join("");

  const precipitationIntervals = quantitativeIntervals(model, "PRECIP");
  const snowfallIntervals = quantitativeIntervals(model, "SNOW");
  const intervalBarsMarkup = (intervals, row, type) => {
    const requestedMaximum = type === "PRECIP"
      ? Number(scaleOverrides?.precipMaximumIn)
      : Number(scaleOverrides?.snowMaximumIn);
    const calculatedMaximum = Math.max(0.01, ...intervals.map((interval) => interval.amountIn || 0));
    const maximum = Number.isFinite(requestedMaximum) && requestedMaximum >= calculatedMaximum
      ? requestedMaximum
      : calculatedMaximum;
    const maximumBarHeight = Math.max(4, row.bottom - row.top - 30);
    return intervals.map((interval) => {
      const renderStartZ = interval.printRenderStartZ || interval.validStartZ;
      const renderEndZ = interval.printRenderEndZ || interval.validEndZ;
      const endX = renderEndZ ? dimensions.xForTime(renderEndZ) : null;
      const startX = renderStartZ ? dimensions.xForTime(renderStartZ) : null;
      if (!Number.isFinite(endX)) return "";
      const amount = finiteAmount(interval.amountIn);
      const centerX = Number.isFinite(startX) ? (startX + endX) / 2 : endX;
      const width = Number.isFinite(startX) ? Math.max(1, endX - startX) : 0;
      const barBottom = row.bottom - 5;
      const barHeight = amount === null || amount === 0 ? 0 : clamp((amount / maximum) * maximumBarHeight, 1.5, maximumBarHeight);
      const classes = `aviation-meteogram-interval aviation-meteogram-${type.toLowerCase()}-interval${interval.kind === "FORECAST" ? " aviation-meteogram-interval-forecast" : " aviation-meteogram-interval-observed"}${interval.printClipped ? " aviation-meteogram-interval-print-clipped" : ""}`;
      const value = interval.trace ? `T${interval.printClipped ? "†" : ""}` : `${amountDisplay(amount, { compact: true })}${interval.printClipped ? "†" : ""}`;
      const typeMeaning = type === "SNOW"
        ? interval.kind === "FORECAST" ? "FORECAST SNOWFALL" : "SNOW DEPTH INCREASE DURING PAST HOUR"
        : "PRECIP";
      const validity = interval.validStartZ && interval.validEndZ
        ? compactIntervalLabel(interval.validStartZ, interval.validEndZ, model.station)
        : "START UNAVAILABLE";
      const visibleSegment = interval.printClipped
        ? ` · VISIBLE PRINT SEGMENT ${compactIntervalLabel(renderStartZ, renderEndZ, model.station)}; AMOUNT REMAINS THE FULL UNSPLIT SOURCE INTERVAL TOTAL`
        : "";
      return `<g class="${classes}" data-valid-start="${escapeMarkup(interval.validStartZ || "")}" data-valid-end="${escapeMarkup(interval.validEndZ || "")}" data-render-start="${escapeMarkup(renderStartZ || "")}" data-render-end="${escapeMarkup(renderEndZ || "")}" data-amount-in="${amount === null ? "" : amount}">
        <title>${escapeMarkup(`${typeMeaning} ${interval.trace ? "TRACE" : `${amountDisplay(amount)} IN`} · SOURCE INTERVAL ${validity}${visibleSegment} · ${interval.source || interval.sourceToken || "reported source"}`)}</title>
        ${barHeight && width ? `<rect class="aviation-meteogram-interval-bar" x="${startX.toFixed(1)}" y="${(barBottom - barHeight).toFixed(1)}" width="${width.toFixed(1)}" height="${barHeight.toFixed(1)}"/>` : amount === 0 && width ? `<line class="aviation-meteogram-interval-zero" x1="${startX.toFixed(1)}" y1="${barBottom}" x2="${endX.toFixed(1)}" y2="${barBottom}"/>` : ""}
        <text class="aviation-meteogram-interval-value" x="${centerX.toFixed(1)}" y="${row.top + 14}">${escapeMarkup(value)}</text>
      </g>`;
    }).join("");
  };
  const precipitationMarkup = intervalBarsMarkup(precipitationIntervals, rows.precip, "PRECIP");
  const snowfallMarkup = intervalBarsMarkup(snowfallIntervals, rows.snow, "SNOW");
  const snowDepthMarkup = timeline.map((observation, index) => {
    const depth = finiteAmount(observation.precipitation?.snowDepthIn);
    return !isForecast(observation) && depth !== null && visualLabelMask[index]
      ? `<text class="aviation-meteogram-snow-depth" x="${xAt(index).toFixed(1)}" y="${rows.snow.top + 23}">DEPTH ${escapeMarkup(amountDisplay(depth))} IN</text>`
      : "";
  }).join("");

  const labelMarkup = rowLabelsMarkup(normalizedSettings, hasForecast, labelLayout);
  const observedPoints = (points) => points.map((point, index) => isForecast(timeline[index]) ? null : point);
  const forecastPoints = (points) => points.map((point, index) => isForecast(timeline[index]) ? point : null);
  const forecastTemperatureMarkers = timeline.map((observation, index) => {
    if (!isForecast(observation)) return "";
    return (observation.temperatureExtrema || []).map((extreme) => {
      const value = convertTemperature(extreme.valueC, normalizedSettings.temperatureUnit);
      const y = scaledY(value, temperatureGeometry.range, temperatureGeometry.top, temperatureGeometry.bottom);
      if (y === null) return "";
      return `<circle class="aviation-meteogram-temp-forecast-marker" cx="${xAt(index).toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${escapeMarkup(`${extreme.type || "TAF temperature extreme"} ${formatTemperature(extreme.valueC, normalizedSettings.temperatureUnit)} · exact TAF extrema, not the NWS hourly value`)}</title></circle>`;
    }).join("");
  }).join("");
  const forecastBackground = hasForecast
    ? `<rect class="aviation-meteogram-forecast-background" x="${dividerX.toFixed(1)}" y="0" width="${Math.max(0, width - dividerX).toFixed(1)}" height="${height}"/>`
    : "";
  const nowDividerMarkup = showNowDivider
    ? `<line class="aviation-meteogram-now-divider" x1="${dividerX.toFixed(1)}" y1="0" x2="${dividerX.toFixed(1)}" y2="${height}"/>
      <g class="aviation-meteogram-now-label" transform="translate(${dividerX.toFixed(1)} 0)">
        <rect x="-54" y="2" width="108" height="16" rx="3"/>
        <text x="0" y="13">NOW / FORECAST</text>
      </g>`
    : "";

  const definitions = `<defs>
    <clipPath id="${idPrefix}WindClip"><rect x="${plotLeft}" y="${rows.wind.top}" width="${Math.max(0, width - plotLeft)}" height="${rows.wind.bottom - rows.wind.top}"/></clipPath>
    <clipPath id="${idPrefix}WindSpeedClip"><rect x="${plotLeft}" y="${rows.windSpeed.top}" width="${Math.max(0, width - plotLeft)}" height="${rows.windSpeed.bottom - rows.windSpeed.top}"/></clipPath>
    <clipPath id="${idPrefix}CloudArtworkClip"><rect x="${cloudAxisBoundary}" y="${rows.clouds.top}" width="${Math.max(0, width - cloudAxisBoundary)}" height="${rows.clouds.bottom - rows.clouds.top}"/></clipPath>
    <clipPath id="${idPrefix}CloudTextClip"><rect x="${cloudAxisBoundary}" y="${rows.clouds.top}" width="${Math.max(0, width - cloudAxisBoundary)}" height="${rows.clouds.bottom - rows.clouds.top}"/></clipPath>
    <clipPath id="${idPrefix}PrecipClip"><rect x="${plotLeft}" y="${rows.precip.top}" width="${Math.max(0, width - plotLeft)}" height="${rows.precip.bottom - rows.precip.top}"/></clipPath>
    <clipPath id="${idPrefix}SnowClip"><rect x="${plotLeft}" y="${rows.snow.top}" width="${Math.max(0, width - plotLeft)}" height="${rows.snow.bottom - rows.snow.top}"/></clipPath>
    <linearGradient id="${idPrefix}CloudFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e8f1f2" stop-opacity=".16"/>
      <stop offset=".55" stop-color="#c4d6da" stop-opacity=".52"/>
      <stop offset="1" stop-color="#8eb7c1" stop-opacity=".82"/>
    </linearGradient>
    <linearGradient id="${idPrefix}CloudVerticalFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d8e7ea" stop-opacity=".14"/>
      <stop offset="1" stop-color="#86aeb8" stop-opacity=".72"/>
    </linearGradient>
  </defs>`;
  const solarDescription = String(model.station || "").toUpperCase() === "KMEM"
    ? ` For KMEM, explicit clear-sky columns use calculated daylight or nighttime sun/moon symbols. Subtle SUNRISE and SUNSET lines use KMEM coordinates and the standard apparent-horizon solar definition.${solarEvents.length ? ` Solar events in this displayed domain: ${solarEvents.map((event) => solarEventAccessibleLabel(event, model.station)).join("; ")}.` : " No sunrise or sunset falls inside this displayed domain."}`
    : "";

  return `<svg class="aviation-meteogram-svg${printMode ? " aviation-meteogram-svg-print" : ""}" xmlns="${SVG_NS}" width="${width.toFixed(1)}" height="${height}" viewBox="0 0 ${width.toFixed(1)} ${height}" data-label-width="${labelWidth}" data-axis-width="${axisWidth}" data-plot-left="${plotLeft}" data-cloud-axis-width="${METEOGRAM_CLOUD_AXIS_WIDTH}" role="img" aria-labelledby="${idPrefix}SvgTitle ${idPrefix}SvgDescription">
    <title id="${idPrefix}SvgTitle">${escapeMarkup(model.station)} aviation weather meteogram</title>
    <desc id="${idPrefix}SvgDescription">One shared time-proportional timeline of exact METAR and SPECI observations${forecastSources.hasTaf && forecastSources.hasNws ? " followed by current TAF aviation fields and separately sourced NWS grid supplemental values after a NOW divider" : forecastSources.hasTaf ? " followed by current TAF aviation fields after a NOW divider" : forecastSources.hasNws ? " followed by NWS grid supplemental forecast values after a NOW divider; no current TAF aviation fields are represented" : ""}. Temperature and dew point numeric values use separate rows. Their separate adjacent line rows use one identical vertical domain, so physical separation represents temperature-dew-point spread. Sustained wind and reported gusts use one shared zero-based speed scale; missing gusts are not inferred. Forecast precipitation and snowfall amounts retain exact six-hour valid intervals in inches; observed SNINCR values are labeled as one-hour snow-depth increase. Missing values are not inferred.${escapeMarkup(solarDescription)}</desc>
    ${definitions}
    <rect class="aviation-meteogram-background" width="${width.toFixed(1)}" height="${height}"/>
    ${forecastBackground}
    <rect class="aviation-meteogram-label-background" width="${labelWidth}" height="${height}"/>
    <rect class="aviation-meteogram-axis-gutter-background" x="${labelWidth}" width="${axisWidth}" height="${height}"/>
    ${horizontalLines}${verticalLines}${solarLineMarkup}
    <line class="aviation-meteogram-description-divider" x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}"/>
    <line class="aviation-meteogram-label-divider" x1="${plotLeft}" y1="0" x2="${plotLeft}" y2="${height}"/>
    ${weatherMarkup}${timeMarkup}${boundaryTimeMarkup}
    ${spreadMarkup(tempPoints, dewPoints, timeline)}
    <g class="aviation-meteogram-temp-line-row" data-domain-min="${temperatureGeometry.range.minimum}" data-domain-max="${temperatureGeometry.range.maximum}" aria-label="Temperature trend line using shared temperature and dew-point scale">${trendSeriesMarkup(tempPoints, timeline, "aviation-meteogram-temp-line")}</g>
    <g class="aviation-meteogram-dew-line-row" data-domain-min="${temperatureGeometry.range.minimum}" data-domain-max="${temperatureGeometry.range.maximum}" aria-label="Dew-point trend line using shared temperature and dew-point scale">${trendSeriesMarkup(dewPoints, timeline, "aviation-meteogram-dew-line")}</g>
    <g class="aviation-meteogram-temperature-row">${temperatureValuesMarkup}</g>
    <g class="aviation-meteogram-dew-point-row">${dewPointValuesMarkup}</g>
    ${forecastTemperatureMarkers}
    <g class="aviation-meteogram-wind-row" clip-path="url(#${idPrefix}WindClip)">${windMarkup}</g>
    <g class="aviation-meteogram-wind-speed-row" clip-path="url(#${idPrefix}WindSpeedClip)">${windSpeedSeriesMarkup}</g>
    ${pathMarkup(observedPoints(pressurePoints), "aviation-meteogram-pressure-line", timeline)}
    ${pathMarkup(forecastPoints(pressurePoints), "aviation-meteogram-pressure-line aviation-meteogram-line-forecast", timeline)}
    ${pressureValuesMarkup}${cloudTickGridMarkup}
    <g class="aviation-meteogram-cloud-row aviation-meteogram-cloud-artwork-row" clip-path="url(#${idPrefix}CloudArtworkClip)">${cloudArtworkMarkup.join("")}</g>
    <g class="aviation-meteogram-cloud-row aviation-meteogram-cloud-text-row" clip-path="url(#${idPrefix}CloudTextClip)">${cloudTextMarkup.join("")}</g>
    ${cloudAltitudeAxisMarkup(cloudScale, labelWidth, { axisWidth })}
    ${pathMarkup(observedPoints(visibilityPoints), "aviation-meteogram-visibility-line", timeline)}
    ${pathMarkup(forecastPoints(visibilityPoints), "aviation-meteogram-visibility-line aviation-meteogram-line-forecast", timeline)}
    ${visibilityValuesMarkup}<g class="aviation-meteogram-precip-row" clip-path="url(#${idPrefix}PrecipClip)">${precipitationMarkup}</g><g class="aviation-meteogram-snow-row" clip-path="url(#${idPrefix}SnowClip)">${snowfallMarkup}${snowDepthMarkup}</g>
    ${solarLabelMarkup}${nowDividerMarkup}${labelMarkup}
  </svg>`;
}

function createToggleGroup(doc, label, setting, values) {
  const group = doc.createElement("div");
  group.className = "aviation-meteogram-toggle-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const value of values) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "aviation-meteogram-toggle";
    button.dataset.meteogramSetting = setting;
    button.dataset.meteogramValue = value.value;
    button.textContent = value.label;
    group.appendChild(button);
  }
  return group;
}

export function renderAviationMeteogram(container, reports, {
  station = "KMEM",
  rangeLabel = "Past 24 hours",
  tafReports = [],
  supplementalForecast = null,
  now = new Date(),
  doc = container?.ownerDocument || document,
  view = doc?.defaultView || window,
  initialViewState = null,
} = {}) {
  if (!container || !doc) return null;
  const model = buildMeteogramModel(reports, { station, tafReports, supplementalForecast, now });
  if (!model.observations.length) return null;

  const defaultSettings = {
    timeMode: "Z",
    temperatureUnit: "C",
    windUnit: "KT",
  };
  const settings = normalizedMeteogramSettings({
    ...defaultSettings,
    ...(initialViewState?.settings || {}),
  }, model);
  const forecastSources = meteogramForecastSourceState(model);
  const section = doc.createElement("section");
  section.className = "aviation-meteogram";
  section.setAttribute("aria-labelledby", "aviationMeteogramTitle");
  const labelMeasurer = createMeteogramRowLabelMeasurer(doc);

  const header = doc.createElement("header");
  header.className = "aviation-meteogram-header";
  const identity = doc.createElement("div");
  const title = doc.createElement("h3");
  title.id = "aviationMeteogramTitle";
  title.textContent = `${model.station} AVIATION METEOGRAM`;
  const subtitle = doc.createElement("p");
  subtitle.textContent = meteogramSubtitleText(model);
  identity.append(title, subtitle);

  const controls = doc.createElement("div");
  controls.className = "aviation-meteogram-controls";
  controls.append(
    createToggleGroup(doc, "Meteogram time display", "timeMode", [
      { value: "Z", label: "Z" }, { value: "LOCAL", label: "LOCAL" },
    ]),
    createToggleGroup(doc, "Meteogram temperature unit", "temperatureUnit", [
      { value: "C", label: "°C" }, { value: "F", label: "°F" },
    ]),
    createToggleGroup(doc, "Meteogram wind speed unit", "windUnit", [
      { value: "KT", label: "KT" }, { value: "MPH", label: "MPH" },
    ]),
  );
  if (!model.timeZone) {
    const localToggle = controls.querySelector?.('[data-meteogram-setting="timeMode"][data-meteogram-value="LOCAL"]');
    if (localToggle) {
      localToggle.disabled = true;
      localToggle.title = "Station local time zone is unavailable; times remain in UTC/Z.";
    }
  }
  header.append(identity, controls);

  const context = doc.createElement("div");
  context.className = "aviation-meteogram-context";
  const range = doc.createElement("span");
  range.textContent = `${rangeLabel} · ${model.observations.length} exact observed ${model.observations.length === 1 ? "bucket" : "buckets"}${model.forecasts.length ? ` · ${model.forecasts.length} forecast buckets` : ""}`;
  const legend = doc.createElement("span");
  legend.innerHTML = `<i class="aviation-meteogram-key aviation-meteogram-key-observed"></i>OBSERVED <i class="aviation-meteogram-key aviation-meteogram-key-forecast"></i>FORECAST (${escapeMarkup(forecastSources.label)}) <i class="aviation-meteogram-key aviation-meteogram-key-temp"></i>TEMP <i class="aviation-meteogram-key aviation-meteogram-key-dew"></i>DEW`;
  context.append(range, legend);

  const scroller = doc.createElement("div");
  scroller.className = "aviation-meteogram-scroll";
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", `${model.station} meteogram shared timeline; horizontally scroll for observed history and ${forecastSources.label} forecast`);

  const stickyTimeRuler = doc.createElement("div");
  stickyTimeRuler.className = "aviation-meteogram-sticky-time-ruler";
  stickyTimeRuler.hidden = true;
  stickyTimeRuler.setAttribute("aria-hidden", "true");

  const dataDetails = doc.createElement("details");
  dataDetails.className = "aviation-meteogram-data-details";
  const dataSummary = doc.createElement("summary");
  dataSummary.textContent = "TEXT DATA TABLE";
  const dataTableScroller = doc.createElement("div");
  dataTableScroller.className = "aviation-meteogram-data-scroll";
  dataTableScroller.tabIndex = 0;
  dataTableScroller.setAttribute("role", "region");
  dataTableScroller.setAttribute("aria-label", `${model.station} meteogram text data table; horizontally scroll for all weather fields`);
  dataDetails.open = Boolean(initialViewState?.dataTableOpen);
  dataDetails.append(dataSummary, dataTableScroller);

  const notes = doc.createElement("footer");
  notes.className = "aviation-meteogram-notes";
  const truth = doc.createElement("span");
  truth.textContent = model.forecasts.length
    ? forecastSources.hasTaf && forecastSources.hasNws
      ? "OBSERVED = EXACT METAR/SPECI · AVIATION FIELDS = CURRENT TAF · TEMP/DP/QPF/SNOW = NWS GRID · NOW DIVIDER · TEMPO/PROB REMAIN CONDITIONAL · MISSING VALUES SHOWN AS —"
      : forecastSources.hasTaf
        ? "OBSERVED = EXACT METAR/SPECI · AVIATION FIELDS = CURRENT TAF · NOW DIVIDER · TEMPO/PROB REMAIN CONDITIONAL · MISSING VALUES SHOWN AS —"
        : "OBSERVED = EXACT METAR/SPECI · FORECAST FIELDS = NWS GRID ONLY · CURRENT TAF UNAVAILABLE OR NOT SAFELY PLOTTED · NOW DIVIDER · MISSING VALUES SHOWN AS —"
    : "OBSERVED REPORTS ONLY · STRAIGHT CONNECTORS · GAPS OVER 2.5 HR DISCONNECTED · MISSING VALUES SHOWN AS —";
  const precip = doc.createElement("span");
  precip.textContent = model.forecasts.length
    ? "PRECIP (IN) = NWS SIX-HOUR LIQUID-EQUIVALENT TOTAL · SNOW (IN) = NWS SIX-HOUR FORECAST SNOWFALL · OBS SNINCR = SNOW-DEPTH INCREASE DURING PAST HOUR · POP IS NOT AMOUNT · TX/TN ARE SEPARATE TAF EXTREMA"
    : "PRECIP (IN) = REPORTED INTERVAL LIQUID EQUIVALENT · TRACE = T · OBS SNINCR = SNOW-DEPTH INCREASE DURING PAST HOUR · TOTAL SNOW DEPTH IS SEPARATE";
  notes.append(truth, precip);
  if (model.taf) {
    const issued = formatMeteogramTime(model.taf.issuanceZ, { mode: "Z", station: model.station });
    const tafSource = doc.createElement("span");
    tafSource.textContent = `TAF ISSUED ${issued.date} ${issued.time}Z · VALID TO ${model.taf.validityEndZ.slice(0, 16).replace("T", " ")}Z · SOURCE ${model.taf.source}${model.taf.truncated ? " · DISPLAY CAPPED AT 36 HR" : ""}${model.taf.warning ? ` · ${model.taf.warning}` : ""}`;
    notes.appendChild(tafSource);
  }
  if (model.observedSources.length) {
    const observedSource = doc.createElement("span");
    observedSource.textContent = `OBS SOURCE${model.observedSources.length === 1 ? "" : "S"} ${model.observedSources.join(" + ")}`;
    notes.appendChild(observedSource);
  }
  if (model.supplemental && forecastSources.hasNws) {
    const supplementalSource = doc.createElement("span");
    supplementalSource.textContent = `SUPPLEMENTAL SOURCE ${model.supplemental.source} · NWS GRID ${model.supplemental.grid?.id || "—"}/${model.supplemental.grid?.x ?? "—"},${model.supplemental.grid?.y ?? "—"} · UPDATED ${model.supplemental.updateZ || "—"} · QPF/SNOW TOTALS REMAIN ON SOURCE INTERVALS`;
    notes.appendChild(supplementalSource);
  }
  if (model.revisedBuckets) {
    const revisions = doc.createElement("span");
    revisions.textContent = `${model.revisedBuckets} SAME-TIME REVISED BUCKET${model.revisedBuckets === 1 ? "" : "S"} COLLAPSED`;
    notes.appendChild(revisions);
  }
  section.append(header, context, scroller, dataDetails, notes);
  if (labelMeasurer.element) section.appendChild(labelMeasurer.element);
  container.append(stickyTimeRuler, section);

  const restoredScrollLeft = Number(initialViewState?.scrollLeft);
  const hasRestoredScroll = Number.isFinite(restoredScrollLeft);
  const restoredDataTableScrollLeft = Number(initialViewState?.dataTableScrollLeft);
  const hasRestoredDataTableScroll = Number.isFinite(restoredDataTableScrollLeft);
  const restoredFocusKey = String(initialViewState?.focusKey || "");
  let firstDraw = true;
  let frame = 0;
  let destroyed = false;
  let activeWindTooltipSample = null;
  let windTooltipPinned = false;
  let windTooltipScrollFrame = 0;
  let latestDimensions = null;
  function updateStickyTimeRuler() {
    const dimensions = latestDimensions;
    const stage = scroller.querySelector?.(".aviation-meteogram-stage");
    const frame = stickyTimeRuler.querySelector?.(".aviation-meteogram-sticky-time-frame");
    const track = stickyTimeRuler.querySelector?.(".aviation-meteogram-sticky-time-track");
    if (!dimensions || !stage || !frame || !track) {
      stickyTimeRuler.hidden = true;
      return;
    }
    frame.style.width = `${Math.max(0, Number(scroller.clientWidth) || Number(container.clientWidth) || dimensions.viewportWidth)}px`;
    track.style.transform = `translateX(${-(Number(scroller.scrollLeft || 0) + dimensions.plotLeft)}px)`;
    const resultsRect = container.getBoundingClientRect?.();
    const stageRect = stage.getBoundingClientRect?.();
    if (!resultsRect || !stageRect || !Number.isFinite(resultsRect.top) || !Number.isFinite(stageRect.top)) {
      stickyTimeRuler.hidden = true;
      return;
    }
    const originalTimeRowBottom = stageRect.top + METEOGRAM_ROWS.time.bottom;
    stickyTimeRuler.hidden = !(originalTimeRowBottom <= resultsRect.top + 1 && stageRect.bottom > resultsRect.top + METEOGRAM_ROWS.time.bottom);
  }
  function updateToggleState() {
    for (const button of controls.querySelectorAll("[data-meteogram-setting]")) {
      const selected = settings[button.dataset.meteogramSetting] === button.dataset.meteogramValue;
      button.classList.toggle("aviation-meteogram-toggle-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }
  function draw() {
    if (destroyed) return;
    const previousScrollLeft = scroller.scrollLeft;
    const availableWidth = scroller.clientWidth || container.clientWidth || 1100;
    const viewportWidth = Math.max(320, availableWidth);
    const displaySettings = normalizedMeteogramSettings(settings, model);
    const compact = view.matchMedia?.("(max-width: 768px)")?.matches ?? Number(view.innerWidth || availableWidth) <= 768;
    const labelLayout = meteogramRowLabelLayout(displaySettings, availableWidth, {
      hasForecast: model.forecasts.length > 0,
      compact,
      measureText: labelMeasurer.measureText,
    });
    const dimensions = meteogramDimensions(model.timeline, viewportWidth, {
      extraTimes: intervalExtraTimes(model),
      labelWidth: labelLayout.width,
    });
    latestDimensions = dimensions;
    const windSpeedGeometry = meteogramWindSpeedGeometry(model, displaySettings, dimensions);
    const cloudScale = meteogramCloudScaleDefinition(model.timeline);
    const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth, labelLayout });
    activeWindTooltipSample = null;
    windTooltipPinned = false;
    scroller.innerHTML = `<div class="aviation-meteogram-stage" style="width:${dimensions.width}px;height:${dimensions.height}px">${svg}${buildMeteogramStickyLabelsMarkup(displaySettings, dimensions, model.forecasts.length > 0, labelLayout, windSpeedGeometry, cloudScale)}<div id="aviationMeteogramWindTooltip" class="aviation-meteogram-wind-tooltip" role="tooltip" hidden></div></div>`;
    stickyTimeRuler.innerHTML = buildMeteogramStickyTimeRulerMarkup(model, displaySettings, dimensions);
    dataTableScroller.innerHTML = buildMeteogramAccessibleTableMarkup(model, settings);
    updateToggleState();
    if (firstDraw) {
      firstDraw = false;
      view.requestAnimationFrame?.(() => {
        const divider = dimensions.xForTime(model.dividerZ || model.forecasts[0]?.validZ);
        const visibleTimelineWidth = Math.max(0, scroller.clientWidth - dimensions.plotLeft);
        const desiredDividerPosition = dimensions.plotLeft + visibleTimelineWidth * 0.38;
        scroller.scrollLeft = hasRestoredScroll
          ? clamp(restoredScrollLeft, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth))
          : model.forecasts.length
            ? clamp(divider - desiredDividerPosition, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth))
            : Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        if (hasRestoredDataTableScroll) {
          dataTableScroller.scrollLeft = clamp(
            restoredDataTableScrollLeft,
            0,
            Math.max(0, dataTableScroller.scrollWidth - dataTableScroller.clientWidth),
          );
        }
        const focusTarget = restoredFocusKey === "timeline"
          ? scroller
          : restoredFocusKey === "table-summary"
            ? dataSummary
            : restoredFocusKey === "table-scroll"
              ? dataTableScroller
              : restoredFocusKey.startsWith("toggle:")
                ? controls.querySelector?.(`[data-meteogram-setting="${restoredFocusKey.split(":")[1]}"][data-meteogram-value="${restoredFocusKey.split(":")[2]}"]`)
                : null;
        focusTarget?.focus?.({ preventScroll: true });
      });
    } else {
      scroller.scrollLeft = clamp(previousScrollLeft, 0, Math.max(0, scroller.scrollWidth - scroller.clientWidth));
    }
    updateStickyTimeRuler();
  }
  function hideWindTooltip({ force = false } = {}) {
    if (windTooltipPinned && !force) return;
    const tooltip = scroller.querySelector?.(".aviation-meteogram-wind-tooltip");
    if (tooltip) tooltip.hidden = true;
    activeWindTooltipSample = null;
    if (force) windTooltipPinned = false;
  }
  function showWindTooltip(sample, { pin = false } = {}) {
    const tooltip = scroller.querySelector?.(".aviation-meteogram-wind-tooltip");
    if (!tooltip || !sample?.dataset?.windTooltip) return;
    activeWindTooltipSample = sample;
    windTooltipPinned = pin;
    tooltip.textContent = sample.dataset.windTooltip;
    tooltip.hidden = false;
    const visibleWidth = Math.max(120, Number(scroller.clientWidth) || 320);
    tooltip.style.maxWidth = `${Math.max(112, Math.min(230, visibleWidth - 16))}px`;
    const tooltipWidth = Math.min(Number(tooltip.offsetWidth) || 210, visibleWidth - 16);
    const sampleX = Number(sample.dataset.tooltipX);
    const left = clamp(
      Number.isFinite(sampleX) ? sampleX - tooltipWidth / 2 : scroller.scrollLeft + 8,
      scroller.scrollLeft + 8,
      scroller.scrollLeft + visibleWidth - tooltipWidth - 8,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${METEOGRAM_ROWS.windSpeed.top + 3}px`;
  }
  function scheduleDraw() {
    if (destroyed) return;
    if (frame) view.cancelAnimationFrame?.(frame);
    frame = view.requestAnimationFrame ? view.requestAnimationFrame(draw) : 0;
    if (!view.requestAnimationFrame) draw();
  }
  controls.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-meteogram-setting]");
    if (!button) return;
    const setting = button.dataset.meteogramSetting;
    if (!(setting in settings)) return;
    settings[setting] = button.dataset.meteogramValue;
    draw();
  });
  scroller.addEventListener("pointerover", (event) => {
    if (windTooltipPinned) return;
    const sample = event.target.closest?.("[data-wind-speed-sample]");
    if (sample) showWindTooltip(sample);
  });
  scroller.addEventListener("pointerout", (event) => {
    const sample = event.target.closest?.("[data-wind-speed-sample]");
    if (sample?.contains?.(event.relatedTarget)) return;
    hideWindTooltip();
  });
  scroller.addEventListener("focusin", (event) => {
    const sample = event.target.closest?.("[data-wind-speed-sample]");
    if (sample) showWindTooltip(sample);
  });
  scroller.addEventListener("focusout", (event) => {
    const sample = event.target.closest?.("[data-wind-speed-sample]");
    if (sample?.contains?.(event.relatedTarget)) return;
    hideWindTooltip();
  });
  scroller.addEventListener("click", (event) => {
    const sample = event.target.closest?.("[data-wind-speed-sample]");
    if (!sample) {
      hideWindTooltip({ force: true });
      return;
    }
    if (windTooltipPinned && sample === activeWindTooltipSample) {
      hideWindTooltip({ force: true });
      return;
    }
    showWindTooltip(sample, { pin: true });
  });
  scroller.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideWindTooltip({ force: true });
  });
  scroller.addEventListener("scroll", () => {
    updateStickyTimeRuler();
    if (windTooltipScrollFrame) view.cancelAnimationFrame?.(windTooltipScrollFrame);
    const settleTooltipAfterScroll = () => {
      windTooltipScrollFrame = 0;
      if (activeWindTooltipSample && doc.activeElement === activeWindTooltipSample) {
        showWindTooltip(activeWindTooltipSample, { pin: windTooltipPinned });
        return;
      }
      hideWindTooltip({ force: true });
    };
    windTooltipScrollFrame = view.requestAnimationFrame
      ? view.requestAnimationFrame(settleTooltipAfterScroll)
      : 0;
    if (!view.requestAnimationFrame) settleTooltipAfterScroll();
  }, { passive: true });
  container.addEventListener?.("scroll", updateStickyTimeRuler, { passive: true });

  const ResizeObserverCtor = view.ResizeObserver;
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleDraw) : null;
  resizeObserver?.observe(scroller);
  if (!resizeObserver) view.addEventListener?.("resize", scheduleDraw);
  view.addEventListener?.("orientationchange", scheduleDraw);
  doc.addEventListener?.("fullscreenchange", scheduleDraw);
  Promise.resolve(doc.fonts?.ready).then(() => {
    if (doc.fonts?.ready) scheduleDraw();
  });
  draw();

  return {
    model,
    settings,
    redraw: draw,
    getViewState() {
      const activeElement = doc.activeElement;
      const focusKey = activeElement === scroller
        ? "timeline"
        : activeElement === dataSummary
          ? "table-summary"
          : activeElement === dataTableScroller
            ? "table-scroll"
            : activeElement?.dataset?.meteogramSetting && activeElement?.dataset?.meteogramValue
              ? `toggle:${activeElement.dataset.meteogramSetting}:${activeElement.dataset.meteogramValue}`
              : "";
      return {
        settings: { ...settings },
        scrollLeft: scroller.scrollLeft,
        dataTableOpen: Boolean(dataDetails.open),
        dataTableScrollLeft: dataTableScroller.scrollLeft,
        focusKey,
      };
    },
    getPrintState() {
      const dimensions = latestDimensions;
      const timelineStart = Number(dimensions?.firstTime);
      const timelineScale = Number(dimensions?.pixelsPerHour) / (60 * 60 * 1000);
      const plotLeft = Number(dimensions?.plotLeft || dimensions?.labelWidth || 0);
      const firstPointX = plotLeft + Number(dimensions?.columnWidth || 0) / 2;
      const visibleStageLeft = Number(scroller.scrollLeft || 0) + plotLeft;
      const visibleStageRight = Number(scroller.scrollLeft || 0) + Number(scroller.clientWidth || 0);
      const inverseTime = (stageX) => timelineStart + (stageX - firstPointX) / timelineScale;
      const visibleStartTime = Number.isFinite(timelineStart) && Number.isFinite(timelineScale) && timelineScale > 0
        ? Math.max(timelineStart, inverseTime(visibleStageLeft))
        : NaN;
      const visibleEndTime = Number.isFinite(visibleStartTime)
        ? Math.min(Number(dimensions?.lastTime), inverseTime(visibleStageRight))
        : NaN;
      const visibleStart = Number.isFinite(visibleStartTime) ? new Date(visibleStartTime).toISOString() : null;
      const visibleEnd = Number.isFinite(visibleEndTime) ? new Date(visibleEndTime).toISOString() : null;
      return {
        model,
        settings: { ...settings },
        rangeLabel,
        visibleRange: visibleStart && visibleEnd && Date.parse(visibleEnd) > Date.parse(visibleStart)
          ? { startZ: visibleStart, endZ: visibleEnd }
          : null,
      };
    },
    destroy() {
      destroyed = true;
      resizeObserver?.disconnect();
      if (!resizeObserver) view.removeEventListener?.("resize", scheduleDraw);
      view.removeEventListener?.("orientationchange", scheduleDraw);
      doc.removeEventListener?.("fullscreenchange", scheduleDraw);
      if (frame) view.cancelAnimationFrame?.(frame);
      if (windTooltipScrollFrame) view.cancelAnimationFrame?.(windTooltipScrollFrame);
      container.removeEventListener?.("scroll", updateStickyTimeRuler);
      labelMeasurer.element?.remove?.();
      stickyTimeRuler.remove?.();
    },
  };
}
