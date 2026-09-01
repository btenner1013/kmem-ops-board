import {
  buildMeteogramModel,
  convertTemperature,
  convertWindSpeed,
  formatMeteogramTime,
  formatTemperature,
  formatWind,
} from "./weather-meteogram-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const METEOGRAM_ROWS = Object.freeze({
  time: { top: 0, bottom: 54 },
  weather: { top: 54, bottom: 122 },
  temperature: { top: 122, bottom: 170 },
  dewPoint: { top: 170, bottom: 218 },
  tempLine: { top: 218, bottom: 292 },
  dewLine: { top: 292, bottom: 366 },
  wind: { top: 366, bottom: 464 },
  pressure: { top: 464, bottom: 542 },
  clouds: { top: 542, bottom: 742 },
  visibility: { top: 742, bottom: 816 },
  precip: { top: 816, bottom: 886 },
  snow: { top: 886, bottom: 956 },
});

const MAX_CONNECTOR_GAP_MS = 2.5 * 60 * 60 * 1000;
const CLOUD_LAYER_THICKNESS = 9;

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

function rowLabel({ top, bottom, icon, title, unit }) {
  const middle = (top + bottom) / 2;
  return `<g class="aviation-meteogram-row-label">
    <text class="aviation-meteogram-row-icon" x="15" y="${(middle - 2).toFixed(1)}">${escapeMarkup(icon)}</text>
    <text class="aviation-meteogram-row-title" x="45" y="${(middle - 6).toFixed(1)}">${escapeMarkup(title)}</text>
    <text class="aviation-meteogram-row-unit" x="45" y="${(middle + 13).toFixed(1)}">${escapeMarkup(unit)}</text>
  </g>`;
}

export function meteogramDimensions(timelineOrCount, viewportWidth, { extraTimes = [] } = {}) {
  const safeViewportWidth = Math.max(320, Number(viewportWidth) || 1100);
  const labelWidth = safeViewportWidth < 600 ? 132 : 154;
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
    ? (safeViewportWidth - labelWidth - minimumPixelsPerHour) / spanHours
    : minimumPixelsPerHour;
  const pixelsPerHour = clamp(Math.max(fillPixelsPerHour, densityPixelsPerHour), minimumPixelsPerHour, 200);
  const columnWidth = clamp(pixelsPerHour, minimumPixelsPerHour, 118);
  const timeScale = pixelsPerHour / (60 * 60 * 1000);
  const timelineWidth = spanHours * pixelsPerHour;
  const width = Math.max(safeViewportWidth, labelWidth + columnWidth + timelineWidth);
  const xForTime = (value) => {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(timestamp)) return labelWidth + columnWidth / 2;
    return clamp(labelWidth + columnWidth / 2 + (timestamp - firstTime) * timeScale, labelWidth, width);
  };
  const xPositions = observationCount === 1 && !timeline.length
    ? [labelWidth + (width - labelWidth) / 2]
    : Array.from({ length: observationCount }, (_, index) => {
      if (!timeline.length) return labelWidth + columnWidth / 2 + index * columnWidth;
      const timestamp = parsedTimes[index];
      return Number.isFinite(timestamp)
        ? xForTime(new Date(timestamp))
        : labelWidth + columnWidth / 2 + index * columnWidth;
    });
  const cellBounds = xPositions.map((x, index) => ({
    left: index ? (xPositions[index - 1] + x) / 2 : labelWidth,
    right: index + 1 < xPositions.length ? (x + xPositions[index + 1]) / 2 : width,
  }));
  return {
    viewportWidth: safeViewportWidth,
    labelWidth,
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

function rowLabelsMarkup(settings, hasForecast = false) {
  const rows = METEOGRAM_ROWS;
  return [
    rowLabel({ ...rows.time, icon: "◷", title: "TIME", unit: settings.timeMode === "Z" ? "UTC / Z" : "STATION LOCAL" }),
    rowLabel({ ...rows.weather, icon: "☁", title: "WEATHER", unit: hasForecast ? "OBS + FORECAST" : "OBSERVED CODE" }),
    rowLabel({ ...rows.temperature, icon: "T", title: "TEMPERATURE", unit: `°${settings.temperatureUnit}` }),
    rowLabel({ ...rows.dewPoint, icon: "D", title: "DEW POINT", unit: `°${settings.temperatureUnit}` }),
    rowLabel({ ...rows.tempLine, icon: "↗", title: "TEMP LINE", unit: `SHARED °${settings.temperatureUnit} SCALE` }),
    rowLabel({ ...rows.dewLine, icon: "↗", title: "DEW POINT LINE", unit: `SHARED °${settings.temperatureUnit} SCALE` }),
    rowLabel({ ...rows.wind, icon: "↗", title: "WIND", unit: `DOWNWIND ARROW · ${settings.windUnit}` }),
    rowLabel({ ...rows.pressure, icon: "◌", title: "PRESSURE", unit: "IN HG" }),
    rowLabel({ ...rows.clouds, icon: "☁", title: "CLOUDS / CIG", unit: "FT AGL" }),
    rowLabel({ ...rows.visibility, icon: "◉", title: "VISIBILITY", unit: "SM / REPORTED" }),
    rowLabel({ ...rows.precip, icon: "◒", title: "PRECIP (IN)", unit: "INTERVAL TOTAL" }),
    rowLabel({ ...rows.snow, icon: "✣", title: "SNOW (IN)", unit: "FCST / OBS DEPTH Δ" }),
  ].join("");
}

function stickyLabelsMarkup(settings, dimensions, hasForecast = false) {
  const horizontalLines = Object.values(METEOGRAM_ROWS).map((row) => `<line class="aviation-meteogram-grid-line" x1="0" y1="${row.bottom}" x2="${dimensions.labelWidth}" y2="${row.bottom}"/>`).join("");
  return `<svg class="aviation-meteogram-sticky-labels" xmlns="${SVG_NS}" width="${dimensions.labelWidth}" height="${dimensions.height}" viewBox="0 0 ${dimensions.labelWidth} ${dimensions.height}" aria-hidden="true">
    <rect class="aviation-meteogram-label-background" width="${dimensions.labelWidth}" height="${dimensions.height}"/>
    ${horizontalLines}
    <line class="aviation-meteogram-label-divider" x1="${dimensions.labelWidth - 1}" y1="0" x2="${dimensions.labelWidth - 1}" y2="${dimensions.height}"/>
    ${rowLabelsMarkup(settings, hasForecast)}
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
  if (observation.clouds.clear) return "CLR";
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

function cloudColumnLabel(observation) {
  if (observation.clouds.cavok) return "CAVOK";
  if (observation.clouds.clear) return "CLR";
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
  ].flatMap((interval) => [interval.validStartZ, interval.validEndZ]).filter(Boolean);
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
    `Wind ${direction} ${formatWind(observation.windSpeedKt, settings.windUnit)} ${settings.windUnit}${observation.windGustKt === null ? "" : ` gust ${formatWind(observation.windGustKt, settings.windUnit)}`}`,
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
    const wind = observation.windSpeedKt === 0
      ? "CALM"
      : `${windDirectionLabel(observation)} ${windSpeed} ${normalizedSettings.windUnit}${observation.windGustKt === null || observation.windGustKt === undefined ? "" : ` G${formatWind(observation.windGustKt, normalizedSettings.windUnit)}`}`;
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
      <td>${escapeMarkup(`${observation.clouds?.display || "—"} · ${ceilingLabel(observation.clouds)}`)}</td>
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

export function meteogramTemperatureGeometry(model, settings = {}, dimensions = null) {
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
  const range = usableRange(values, {
    minimumSpan: normalizedSettings.temperatureUnit === "F" ? 8 : 5,
    padding: 0.12,
  });
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

function cloudScaleDefinition(timeline) {
  const reportedHeights = timeline.flatMap(cloudLayersForObservation)
    .filter((layer) => layer.heightFt !== null && layer.heightFt !== undefined && layer.heightFt !== "")
    .map((layer) => Number(layer.heightFt))
    .filter((height) => Number.isFinite(height) && height >= 0);
  const highest = Math.max(10000, ...reportedHeights);
  const maximumFt = Math.max(10000, Math.ceil(highest / 5000) * 5000);
  const ticks = [500, 1000, 2000, 3000, 5000, 10000];
  for (let value = 15000; value <= maximumFt; value += 5000) ticks.push(value);
  return { maximumFt, ticks: ticks.filter((value) => value <= maximumFt) };
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

export function buildMeteogramSvgMarkup(model, settings = {}, { viewportWidth = 1100 } = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  if (!timeline.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const dimensions = meteogramDimensions(timeline, viewportWidth, { extraTimes: intervalExtraTimes(model) });
  const { labelWidth, columnWidth, width, height, xPositions, cellBounds } = dimensions;
  const rows = METEOGRAM_ROWS;
  const xAt = (index) => xPositions[index];
  const cellWidthAt = (index) => Math.max(0, cellBounds[index].right - cellBounds[index].left);
  const visualLabelMask = meteogramVisualLabelMask(timeline, xPositions);
  const observedCount = timeline.findIndex(isForecast) < 0 ? timeline.length : timeline.findIndex(isForecast);
  const hasForecast = observedCount < timeline.length;
  const forecastSources = meteogramForecastSourceState(model);
  const dividerX = hasForecast
    ? dimensions.xForTime(model.dividerZ || timeline[observedCount]?.validZ)
    : width;

  const temperatureGeometry = meteogramTemperatureGeometry(model, normalizedSettings, dimensions);
  const tempPoints = temperatureGeometry.temperaturePoints;
  const dewPoints = temperatureGeometry.dewPointPoints;

  const pressureRange = usableRange(timeline.map((observation) => observation.pressureInHg), { minimumSpan: 0.08, padding: 0.18 });
  const pressurePoints = timeline.map((observation, index) => {
    const y = scaledY(observation.pressureInHg, pressureRange, rows.pressure.top + 34, rows.pressure.bottom - 12);
    return y === null ? null : { x: xAt(index), y };
  });

  const visibilityRange = usableRange(timeline.map((observation) => observation.visibilitySm), { minimumSpan: 3, padding: 0.05 });
  visibilityRange.minimum = Math.min(0, visibilityRange.minimum);
  const visibilityPoints = timeline.map((observation, index) => {
    const y = scaledY(observation.visibilitySm, visibilityRange, rows.visibility.top + 35, rows.visibility.bottom - 11);
    return y === null ? null : { x: xAt(index), y };
  });

  const horizontalLines = Object.values(rows).map((row) => `<line class="aviation-meteogram-grid-line" x1="0" y1="${row.bottom}" x2="${width}" y2="${row.bottom}"/>`).join("");
  const verticalLines = timeline.map((_, index) => {
    const x = xAt(index);
    return `<line class="aviation-meteogram-time-line" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}"/>`;
  }).join("") + `<line class="aviation-meteogram-time-line" x1="${width.toFixed(1)}" y1="0" x2="${width.toFixed(1)}" y2="${height}"/>`;

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

  const weatherMarkup = timeline.map((observation, index) => {
    const bounds = cellBounds[index];
    return `<g class="aviation-meteogram-observation${isForecast(observation) ? " aviation-meteogram-forecast-column" : ""}" transform="translate(${xAt(index).toFixed(1)} 0)">
    <title>${escapeMarkup(columnTitle(observation, normalizedSettings))}</title>
    <rect class="aviation-meteogram-column-hover" x="${(bounds.left - xAt(index)).toFixed(1)}" y="0" width="${cellWidthAt(index).toFixed(1)}" height="${height}"/>
    ${visualLabelMask[index] ? `${isForecast(observation) ? `<text class="aviation-meteogram-forecast-tag" x="0" y="65">${observation.becoming?.length ? "BECMG" : escapeMarkup(forecastBucketSourceLabel(observation))}</text>` : ""}
    <text class="aviation-meteogram-weather-icon" x="0" y="88">${escapeMarkup(weatherColumnIcon(observation))}</text>
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

  const pressureValuesMarkup = timeline.map((observation, index) => visualLabelMask[index] ? `<text class="aviation-meteogram-pressure-value${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.pressure.top + 23}">${escapeMarkup(observation.pressureInHg === null ? "—" : fixed(observation.pressureInHg, 2))}</text>` : "").join("");

  const cloudScale = cloudScaleDefinition(timeline);
  const cloudTickMarkup = cloudScale.ticks.map((tick) => {
    const y = meteogramCloudBaseY(tick, cloudScale.maximumFt);
    return `<g class="aviation-meteogram-cloud-altitude-tick">
      <line x1="${labelWidth}" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}"/>
      <text x="${labelWidth + 4}" y="${(y - 2).toFixed(1)}">${escapeMarkup(tick.toLocaleString("en-US"))} FT</text>
    </g>`;
  }).join("");
  const cloudMarkup = timeline.map((observation, index) => {
    const x = xAt(index);
    const ceilingText = ceilingLabel(observation.clouds);
    const layers = cloudLayersForObservation(observation);
    const knownLayers = layers.filter((layer) => layer.heightFt !== null && layer.heightFt !== undefined && layer.heightFt !== "" && Number.isFinite(Number(layer.heightFt)));
    const unknownLayers = layers.filter((layer) => layer.heightFt === null || layer.heightFt === undefined || layer.heightFt === "" || !Number.isFinite(Number(layer.heightFt)));
    const layerWidth = Math.min(columnWidth, cellWidthAt(index)) * 0.72;
    const layersMarkup = knownLayers.map((layer) => {
      const baseY = meteogramCloudBaseY(layer.heightFt, cloudScale.maximumFt);
      const raw = layer.raw || `${layer.cover}${String(Math.round(layer.heightFt / 100)).padStart(3, "0")}${layer.convective || ""}`;
      const isCeiling = ["BKN", "OVC", "VV"].includes(layer.cover) && Number(layer.ceilingFt) === Number(layer.heightFt);
      const className = `aviation-meteogram-cloud-layer aviation-meteogram-cloud-layer-${String(layer.cover || "UNK").toUpperCase()}${isCeiling ? " aviation-meteogram-cloud-layer-ceiling" : ""}${layer.conditional ? " aviation-meteogram-cloud-layer-conditional" : ""}`;
      const width = layer.conditional ? layerWidth * 0.82 : layerWidth;
      return `<g class="${className}" data-base-ft="${Number(layer.heightFt)}">
        <title>${escapeMarkup(`${layer.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${raw} base ${Number(layer.heightFt).toLocaleString("en-US")} FT AGL${isCeiling ? " · CEILING" : ""} · cloud top not reported`)}</title>
        <rect x="${(-width / 2).toFixed(1)}" y="${(baseY - CLOUD_LAYER_THICKNESS).toFixed(1)}" width="${width.toFixed(1)}" height="${CLOUD_LAYER_THICKNESS}" rx="3"/>
        <line class="aviation-meteogram-cloud-base-line" x1="${(-width / 2).toFixed(1)}" y1="${baseY.toFixed(1)}" x2="${(width / 2).toFixed(1)}" y2="${baseY.toFixed(1)}"/>
        ${visualLabelMask[index] ? `<text class="aviation-meteogram-cloud-layer-label" x="0" y="${clamp(baseY - CLOUD_LAYER_THICKNESS - 3, rows.clouds.top + 11, rows.clouds.bottom - 31).toFixed(1)}">${escapeMarkup(`${layer.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${raw}`)}</text>` : ""}
      </g>`;
    }).join("");
    const unknownMarkup = visualLabelMask[index] && unknownLayers.length
      ? `<text class="aviation-meteogram-cloud-unknown" x="0" y="${rows.clouds.top + 14}">${escapeMarkup(unknownLayers.map((layer) => `${layer.conditionalLabel ? `${layer.conditionalLabel} ` : ""}${layer.raw || `${layer.cover}///`}`).join(" · "))} BASE UNKNOWN</text>`
      : "";
    return `<g class="aviation-meteogram-cloud${isForecast(observation) ? " aviation-meteogram-cloud-forecast" : ""}" transform="translate(${x.toFixed(1)} 0)">
      ${layersMarkup}${unknownMarkup}
      ${visualLabelMask[index] ? `<text class="aviation-meteogram-ceiling-value" x="0" y="${rows.clouds.bottom - 8}">${escapeMarkup(ceilingText)}</text>` : ""}
    </g>`;
  }).join("");

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
    const maximum = Math.max(0.01, ...intervals.map((interval) => interval.amountIn || 0));
    return intervals.map((interval) => {
      const endX = interval.validEndZ ? dimensions.xForTime(interval.validEndZ) : null;
      const startX = interval.validStartZ ? dimensions.xForTime(interval.validStartZ) : null;
      if (!Number.isFinite(endX)) return "";
      const amount = finiteAmount(interval.amountIn);
      const centerX = Number.isFinite(startX) ? (startX + endX) / 2 : endX;
      const width = Number.isFinite(startX) ? Math.max(1, endX - startX) : 0;
      const barBottom = row.bottom - 7;
      const barHeight = amount === null || amount === 0 ? 0 : clamp((amount / maximum) * (row.bottom - row.top - 30), 3, row.bottom - row.top - 30);
      const classes = `aviation-meteogram-interval aviation-meteogram-${type.toLowerCase()}-interval${interval.kind === "FORECAST" ? " aviation-meteogram-interval-forecast" : " aviation-meteogram-interval-observed"}`;
      const value = interval.trace ? "T" : amountDisplay(amount, { compact: true });
      const typeMeaning = type === "SNOW"
        ? interval.kind === "FORECAST" ? "FORECAST SNOWFALL" : "SNOW DEPTH INCREASE DURING PAST HOUR"
        : "PRECIP";
      const validity = interval.validStartZ && interval.validEndZ
        ? compactIntervalLabel(interval.validStartZ, interval.validEndZ, model.station)
        : "START UNAVAILABLE";
      return `<g class="${classes}" data-valid-start="${escapeMarkup(interval.validStartZ || "")}" data-valid-end="${escapeMarkup(interval.validEndZ || "")}" data-amount-in="${amount === null ? "" : amount}">
        <title>${escapeMarkup(`${typeMeaning} ${interval.trace ? "TRACE" : `${amountDisplay(amount)} IN`} · ${validity} · ${interval.source || interval.sourceToken || "reported source"}`)}</title>
        ${barHeight && width ? `<rect class="aviation-meteogram-interval-bar" x="${startX.toFixed(1)}" y="${(barBottom - barHeight).toFixed(1)}" width="${width.toFixed(1)}" height="${barHeight.toFixed(1)}"/>` : amount === 0 && width ? `<line class="aviation-meteogram-interval-zero" x1="${startX.toFixed(1)}" y1="${barBottom}" x2="${endX.toFixed(1)}" y2="${barBottom}"/>` : ""}
        <text class="aviation-meteogram-interval-value" x="${centerX.toFixed(1)}" y="${row.top + 19}">${escapeMarkup(value)}</text>
      </g>`;
    }).join("");
  };
  const precipitationMarkup = intervalBarsMarkup(precipitationIntervals, rows.precip, "PRECIP");
  const snowfallMarkup = intervalBarsMarkup(snowfallIntervals, rows.snow, "SNOW");
  const snowDepthMarkup = timeline.map((observation, index) => {
    const depth = finiteAmount(observation.precipitation?.snowDepthIn);
    return !isForecast(observation) && depth !== null && visualLabelMask[index]
      ? `<text class="aviation-meteogram-snow-depth" x="${xAt(index).toFixed(1)}" y="${rows.snow.bottom - 7}">DEPTH ${escapeMarkup(amountDisplay(depth))} IN</text>`
      : "";
  }).join("");

  const labelMarkup = rowLabelsMarkup(normalizedSettings, hasForecast);
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
  const forecastRegion = hasForecast
    ? `<rect class="aviation-meteogram-forecast-background" x="${dividerX.toFixed(1)}" y="0" width="${Math.max(0, width - dividerX).toFixed(1)}" height="${height}"/>
      <line class="aviation-meteogram-now-divider" x1="${dividerX.toFixed(1)}" y1="0" x2="${dividerX.toFixed(1)}" y2="${height}"/>
      <g class="aviation-meteogram-now-label" transform="translate(${dividerX.toFixed(1)} 0)">
        <rect x="-54" y="2" width="108" height="16" rx="3"/>
        <text x="0" y="13">NOW / FORECAST</text>
      </g>`
    : "";

  const definitions = `<defs>
    <clipPath id="aviationMeteogramWindClip"><rect x="${labelWidth}" y="${rows.wind.top}" width="${Math.max(0, width - labelWidth)}" height="${rows.wind.bottom - rows.wind.top}"/></clipPath>
    <pattern id="aviationMeteogramCloudFew" width="12" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="4" r="1.2"/></pattern>
    <pattern id="aviationMeteogramCloudScattered" width="8" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r="1.5"/><circle cx="7" cy="6" r="1"/></pattern>
    <pattern id="aviationMeteogramCloudBroken" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="4" height="4" rx="1"/></pattern>
    <pattern id="aviationMeteogramCloudVertical" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6"/></pattern>
  </defs>`;

  return `<svg class="aviation-meteogram-svg" xmlns="${SVG_NS}" width="${width.toFixed(1)}" height="${height}" viewBox="0 0 ${width.toFixed(1)} ${height}" role="img" aria-labelledby="aviationMeteogramSvgTitle aviationMeteogramSvgDescription">
    <title id="aviationMeteogramSvgTitle">${escapeMarkup(model.station)} aviation weather meteogram</title>
    <desc id="aviationMeteogramSvgDescription">One shared time-proportional timeline of exact METAR and SPECI observations${forecastSources.hasTaf && forecastSources.hasNws ? " followed by current TAF aviation fields and separately sourced NWS grid supplemental values after a NOW divider" : forecastSources.hasTaf ? " followed by current TAF aviation fields after a NOW divider" : forecastSources.hasNws ? " followed by NWS grid supplemental forecast values after a NOW divider; no current TAF aviation fields are represented" : ""}. Temperature and dew point numeric values use separate rows. Their separate adjacent line rows use one identical vertical domain, so physical separation represents temperature-dew-point spread. Forecast precipitation and snowfall amounts retain exact six-hour valid intervals in inches; observed SNINCR values are labeled as one-hour snow-depth increase. Missing values are not inferred.</desc>
    ${definitions}
    <rect class="aviation-meteogram-background" width="${width.toFixed(1)}" height="${height}"/>
    ${forecastRegion}
    <rect class="aviation-meteogram-label-background" width="${labelWidth}" height="${height}"/>
    ${horizontalLines}${verticalLines}
    <line class="aviation-meteogram-label-divider" x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}"/>
    ${weatherMarkup}${timeMarkup}
    ${spreadMarkup(tempPoints, dewPoints, timeline)}
    <g class="aviation-meteogram-temp-line-row" data-domain-min="${temperatureGeometry.range.minimum}" data-domain-max="${temperatureGeometry.range.maximum}" aria-label="Temperature trend line using shared temperature and dew-point scale">${trendSeriesMarkup(tempPoints, timeline, "aviation-meteogram-temp-line")}</g>
    <g class="aviation-meteogram-dew-line-row" data-domain-min="${temperatureGeometry.range.minimum}" data-domain-max="${temperatureGeometry.range.maximum}" aria-label="Dew-point trend line using shared temperature and dew-point scale">${trendSeriesMarkup(dewPoints, timeline, "aviation-meteogram-dew-line")}</g>
    <g class="aviation-meteogram-temperature-row">${temperatureValuesMarkup}</g>
    <g class="aviation-meteogram-dew-point-row">${dewPointValuesMarkup}</g>
    ${forecastTemperatureMarkers}
    <g class="aviation-meteogram-wind-row" clip-path="url(#aviationMeteogramWindClip)">${windMarkup}</g>
    ${pathMarkup(observedPoints(pressurePoints), "aviation-meteogram-pressure-line", timeline)}
    ${pathMarkup(forecastPoints(pressurePoints), "aviation-meteogram-pressure-line aviation-meteogram-line-forecast", timeline)}
    ${pressureValuesMarkup}${cloudTickMarkup}${cloudMarkup}
    ${pathMarkup(observedPoints(visibilityPoints), "aviation-meteogram-visibility-line", timeline)}
    ${pathMarkup(forecastPoints(visibilityPoints), "aviation-meteogram-visibility-line aviation-meteogram-line-forecast", timeline)}
    ${visibilityValuesMarkup}${precipitationMarkup}${snowfallMarkup}${snowDepthMarkup}${labelMarkup}
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
  container.appendChild(section);

  const restoredScrollLeft = Number(initialViewState?.scrollLeft);
  const hasRestoredScroll = Number.isFinite(restoredScrollLeft);
  const restoredDataTableScrollLeft = Number(initialViewState?.dataTableScrollLeft);
  const hasRestoredDataTableScroll = Number.isFinite(restoredDataTableScrollLeft);
  const restoredFocusKey = String(initialViewState?.focusKey || "");
  let firstDraw = true;
  let frame = 0;
  function updateToggleState() {
    for (const button of controls.querySelectorAll("[data-meteogram-setting]")) {
      const selected = settings[button.dataset.meteogramSetting] === button.dataset.meteogramValue;
      button.classList.toggle("aviation-meteogram-toggle-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }
  function draw() {
    const previousScrollLeft = scroller.scrollLeft;
    const viewportWidth = Math.max(320, scroller.clientWidth || container.clientWidth || 1100);
    const dimensions = meteogramDimensions(model.timeline, viewportWidth, { extraTimes: intervalExtraTimes(model) });
    const displaySettings = normalizedMeteogramSettings(settings, model);
    const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth });
    scroller.innerHTML = `<div class="aviation-meteogram-stage" style="width:${dimensions.width}px;height:${dimensions.height}px">${svg}${stickyLabelsMarkup(displaySettings, dimensions, model.forecasts.length > 0)}</div>`;
    dataTableScroller.innerHTML = buildMeteogramAccessibleTableMarkup(model, settings);
    updateToggleState();
    if (firstDraw) {
      firstDraw = false;
      view.requestAnimationFrame?.(() => {
        const divider = dimensions.xForTime(model.dividerZ || model.forecasts[0]?.validZ);
        const visibleTimelineWidth = Math.max(0, scroller.clientWidth - dimensions.labelWidth);
        const desiredDividerPosition = dimensions.labelWidth + visibleTimelineWidth * 0.38;
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
  }
  function scheduleDraw() {
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

  const ResizeObserverCtor = view.ResizeObserver;
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleDraw) : null;
  resizeObserver?.observe(scroller);
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
    destroy() {
      resizeObserver?.disconnect();
      if (frame) view.cancelAnimationFrame?.(frame);
    },
  };
}
