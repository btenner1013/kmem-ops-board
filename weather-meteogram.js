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
  temp: { top: 122, bottom: 292 },
  wind: { top: 292, bottom: 374 },
  pressure: { top: 374, bottom: 452 },
  clouds: { top: 452, bottom: 564 },
  visibility: { top: 564, bottom: 638 },
  rain: { top: 638, bottom: 700 },
  snow: { top: 700, bottom: 762 },
});

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

function normalizedMeteogramSettings(settings = {}, model = {}) {
  const requestedTimeMode = String(settings.timeMode || "LOCAL").toUpperCase() === "Z" ? "Z" : "LOCAL";
  return {
    timeMode: requestedTimeMode === "LOCAL" && !model.timeZone ? "Z" : requestedTimeMode,
    temperatureUnit: String(settings.temperatureUnit || "F").toUpperCase() === "C" ? "C" : "F",
    windUnit: String(settings.windUnit || "KT").toUpperCase() === "MPH" ? "MPH" : "KT",
  };
}

function pathSegments(points, observations, maximumGapMs = 2.5 * 60 * 60 * 1000) {
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

export function meteogramDimensions(timelineOrCount, viewportWidth) {
  const safeViewportWidth = Math.max(320, Number(viewportWidth) || 1100);
  const labelWidth = safeViewportWidth < 600 ? 118 : 142;
  const timeline = Array.isArray(timelineOrCount) ? timelineOrCount : [];
  const observationCount = timeline.length || Math.max(0, Number(timelineOrCount) || 0);
  const parsedTimes = timeline.map((item) => Date.parse(timelineTime(item)));
  const validTimes = parsedTimes.filter(Number.isFinite);
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
    rowLabel({ ...rows.weather, icon: "☁", title: "WEATHER", unit: hasForecast ? "OBS + TAF" : "OBSERVED CODE" }),
    rowLabel({ ...rows.temp, icon: "◉", title: "TEMP / DEW", unit: `PAIRED · °${settings.temperatureUnit}` }),
    rowLabel({ ...rows.wind, icon: "↗", title: "WIND", unit: `DOWNWIND ARROW · ${settings.windUnit}` }),
    rowLabel({ ...rows.pressure, icon: "◌", title: "PRESSURE", unit: "IN HG" }),
    rowLabel({ ...rows.clouds, icon: "☁", title: "CLOUDS / CIG", unit: "FT AGL" }),
    rowLabel({ ...rows.visibility, icon: "◉", title: "VISIBILITY", unit: "SM / REPORTED" }),
    rowLabel({ ...rows.rain, icon: "◒", title: "RAIN / LWE", unit: "IN · IF REPORTED" }),
    rowLabel({ ...rows.snow, icon: "✣", title: "SNOW", unit: "OBS / DEPTH" }),
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

function rainDisplay(observation) {
  const precip = observation.precipitation;
  const becomingRain = (observation.becoming || []).some((entry) => entry.conditions?.weatherCodes?.some((code) => /RA|DZ/.test(code)));
  if (becomingRain) return "BECMG WX";
  if (precip.conditionalRainForecast) return "TEMPO / PROB";
  if (precip.rainForecast) return "TAF WX";
  if (precip.rainObserved && precip.liquidTrace) return "T";
  if (precip.rainObserved && precip.liquidEquivalentIn !== null) return `${precip.liquidEquivalentIn.toFixed(2)}\"`;
  if (precip.rainObserved) return "OBS";
  if (precip.liquidTrace) return "LWE T";
  if (precip.liquidEquivalentIn !== null) return `LWE ${precip.liquidEquivalentIn.toFixed(2)}\"`;
  return "—";
}

function snowDisplay(observation) {
  const precip = observation.precipitation;
  const becomingSnow = (observation.becoming || []).some((entry) => entry.conditions?.weatherCodes?.some((code) => /SN|SG|PL|GS/.test(code)));
  if (becomingSnow) return "BECMG WX";
  if (precip.conditionalSnowForecast) return "TEMPO / PROB";
  if (precip.snowForecast) return "TAF WX";
  if (precip.snowDepthIn !== null) return `DEPTH ${precip.snowDepthIn}\"`;
  return precip.snowObserved ? "OBS" : "—";
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
  const base = [
    `${isForecast(observation) ? "TAF FORECAST" : observation.reportType} ${time.date} ${time.time} ${time.zone}`,
    `Temperature ${formatTemperature(observation.temperatureC, settings.temperatureUnit)} / Dew point ${formatTemperature(observation.dewPointC, settings.temperatureUnit)}`,
    `Wind ${direction} ${formatWind(observation.windSpeedKt, settings.windUnit)} ${settings.windUnit}${observation.windGustKt === null ? "" : ` gust ${formatWind(observation.windGustKt, settings.windUnit)}`}`,
    `Visibility ${observation.visibilityDisplay}`,
    `Clouds ${observation.clouds.display}`,
    observation.weatherCodes.length ? `Weather ${observation.weatherCodes.join(" ")}` : "Weather code not reported",
  ];
  if (isForecast(observation)) {
    base.push(`TAF group ${observation.tafSourceToken || "INITIAL"}`);
    if (observation.becoming?.length) base.push(`Transition ${observation.becoming.map((entry) => entry.sourceToken).join(", ")}`);
    if (forecastOverlays(observation).length) base.push(`Forecast overlays ${conditionalSummary(observation, settings)}`);
    base.push("TAF does not provide dew point or precipitation amounts");
  }
  base.push(`Source ${observation.source || (isForecast(observation) ? "Current TAF" : "METAR/SPECI")}`);
  return base.join(" · ");
}

export function buildMeteogramAccessibleTableMarkup(model, settings = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  if (!timeline.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const rows = timeline.map((observation) => {
    const time = formatMeteogramTime(timelineTime(observation), {
      mode: normalizedSettings.timeMode,
      station: model.station,
    });
    const windSpeed = formatWind(observation.windSpeedKt, normalizedSettings.windUnit);
    const wind = observation.windSpeedKt === 0
      ? `CALM 0 ${normalizedSettings.windUnit}`
      : `${windDirectionLabel(observation)} ${windSpeed} ${normalizedSettings.windUnit}${observation.windGustKt === null || observation.windGustKt === undefined ? "" : ` G${formatWind(observation.windGustKt, normalizedSettings.windUnit)}`}`;
    const type = isForecast(observation)
      ? `TAF forecast · prevailing ${observation.tafSourceToken || "INITIAL"}`
      : observation.reportType;
    const overlays = conditionalSummary(observation, normalizedSettings);
    const temperature = formatTemperature(observation.temperatureC, normalizedSettings.temperatureUnit);
    const temperatureSemantics = isForecast(observation) && observation.temperatureKind
      ? `${observation.temperatureKind.startsWith("Maximum") ? "TX" : "TN"} ${temperature} · ${observation.temperatureKind}`
      : temperature;
    const provenance = [
      `Source ${observation.source || (isForecast(observation) ? "Current TAF" : "METAR/SPECI")}`,
      overlays ? `Non-prevailing/transition ${overlays}` : "",
      isForecast(observation) ? "TAF dew point and precipitation amounts not reported" : "Exact retained observation",
    ].filter(Boolean).join(" · ");
    return `<tr>
      <th scope="row">${escapeMarkup(`${time.date} ${time.time} ${time.zone}`)}</th>
      <td>${escapeMarkup(type)}</td>
      <td>${escapeMarkup(`${weatherColumnLabel(observation)} · ${observation.weather?.label || "—"}`)}</td>
      <td>${escapeMarkup(temperatureSemantics)}</td>
      <td>${escapeMarkup(formatTemperature(observation.dewPointC, normalizedSettings.temperatureUnit))}</td>
      <td>${escapeMarkup(wind)}</td>
      <td>${escapeMarkup(observation.pressureInHg === null || observation.pressureInHg === undefined ? "—" : `${fixed(observation.pressureInHg, 2)} inHg`)}</td>
      <td>${escapeMarkup(`${observation.clouds?.display || "—"} · ${ceilingLabel(observation.clouds)}`)}</td>
      <td>${escapeMarkup(observation.visibilityDisplay || "—")}</td>
      <td>${escapeMarkup(rainDisplay(observation))}</td>
      <td>${escapeMarkup(snowDisplay(observation))}</td>
      <td>${escapeMarkup(provenance)}</td>
    </tr>`;
  }).join("");
  return `<table class="aviation-meteogram-data-table">
    <caption>${escapeMarkup(`${model.station} meteogram text data; ${normalizedSettings.timeMode === "Z" ? "UTC/Z" : "station local"} time, degrees ${normalizedSettings.temperatureUnit}, wind in ${normalizedSettings.windUnit}`)}</caption>
    <thead><tr>
      <th scope="col">Time</th><th scope="col">Type</th><th scope="col">Weather</th>
      <th scope="col">Temperature °${normalizedSettings.temperatureUnit}</th><th scope="col">Dew point °${normalizedSettings.temperatureUnit}</th>
      <th scope="col">Wind ${normalizedSettings.windUnit}</th><th scope="col">Pressure</th>
      <th scope="col">Clouds / ceiling</th><th scope="col">Visibility</th><th scope="col">Rain / LWE</th>
      <th scope="col">Snow / depth</th><th scope="col">Source / forecast semantics</th>
    </tr></thead><tbody>${rows}</tbody>
  </table>`;
}

export function buildMeteogramSvgMarkup(model, settings = {}, { viewportWidth = 1100 } = {}) {
  const timeline = Array.isArray(model?.timeline) && model.timeline.length
    ? model.timeline
    : Array.isArray(model?.observations) ? model.observations : [];
  if (!timeline.length) return "";
  const normalizedSettings = normalizedMeteogramSettings(settings, model);
  const dimensions = meteogramDimensions(timeline, viewportWidth);
  const { labelWidth, columnWidth, width, height, xPositions, cellBounds } = dimensions;
  const rows = METEOGRAM_ROWS;
  const xAt = (index) => xPositions[index];
  const cellWidthAt = (index) => Math.max(0, cellBounds[index].right - cellBounds[index].left);
  const visualLabelMask = meteogramVisualLabelMask(timeline, xPositions);
  const observedCount = timeline.findIndex(isForecast) < 0 ? timeline.length : timeline.findIndex(isForecast);
  const hasForecast = observedCount < timeline.length;
  const dividerX = hasForecast
    ? dimensions.xForTime(model.dividerZ || timeline[observedCount]?.validZ)
    : width;

  const temperatureValues = timeline.flatMap((observation) => [
    convertTemperature(observation.temperatureC, normalizedSettings.temperatureUnit),
    convertTemperature(observation.dewPointC, normalizedSettings.temperatureUnit),
  ]).filter(Number.isFinite);
  const temperatureRange = usableRange(temperatureValues, { minimumSpan: normalizedSettings.temperatureUnit === "F" ? 8 : 5, padding: 0.12 });
  const tempTop = rows.temp.top + 62;
  const tempBottom = rows.temp.bottom - 17;
  const tempPoints = timeline.map((observation, index) => {
    const value = convertTemperature(observation.temperatureC, normalizedSettings.temperatureUnit);
    const y = scaledY(value, temperatureRange, tempTop, tempBottom);
    return y === null ? null : { x: xAt(index), y };
  });
  const dewPoints = timeline.map((observation, index) => {
    const value = convertTemperature(observation.dewPointC, normalizedSettings.temperatureUnit);
    const y = scaledY(value, temperatureRange, tempTop, tempBottom);
    return y === null ? null : { x: xAt(index), y };
  });

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
      <text x="0" y="${atDivider ? 34 : 22}">${escapeMarkup(time.time)}</text>
      <text class="aviation-meteogram-time-zone" x="0" y="${atDivider ? 49 : 39}">${escapeMarkup(showDate ? `${time.date} ${time.zone}` : time.zone)}</text>` : ""}
    </g>`;
  }).join("");

  const weatherMarkup = timeline.map((observation, index) => {
    const bounds = cellBounds[index];
    return `<g class="aviation-meteogram-observation${isForecast(observation) ? " aviation-meteogram-forecast-column" : ""}" transform="translate(${xAt(index).toFixed(1)} 0)">
    <title>${escapeMarkup(columnTitle(observation, normalizedSettings))}</title>
    <rect class="aviation-meteogram-column-hover" x="${(bounds.left - xAt(index)).toFixed(1)}" y="0" width="${cellWidthAt(index).toFixed(1)}" height="${height}"/>
    ${visualLabelMask[index] ? `${isForecast(observation) ? `<text class="aviation-meteogram-forecast-tag" x="0" y="65">${observation.becoming?.length ? "BECMG" : "TAF"}</text>` : ""}
    <text class="aviation-meteogram-weather-icon" x="0" y="88">${escapeMarkup(weatherColumnIcon(observation))}</text>
    <text class="aviation-meteogram-weather-code" x="0" y="109">${escapeMarkup(weatherColumnLabel(observation))}</text>` : ""}
  </g>`;
  }).join("");

  const temperatureValuesMarkup = timeline.map((observation, index) => visualLabelMask[index] ? `<text class="aviation-meteogram-temp-pair${isForecast(observation) ? " aviation-meteogram-temp-pair-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.temp.top + 31}">
    <tspan class="aviation-meteogram-temp-value">${escapeMarkup(isForecast(observation) && observation.temperatureKind ? `${observation.temperatureKind.startsWith("Maximum") ? "TX " : "TN "}${formatTemperature(observation.temperatureC, normalizedSettings.temperatureUnit)}` : formatTemperature(observation.temperatureC, normalizedSettings.temperatureUnit))}</tspan>
    <tspan class="aviation-meteogram-pair-separator"> / </tspan>
    <tspan class="aviation-meteogram-dew-value">${escapeMarkup(formatTemperature(observation.dewPointC, normalizedSettings.temperatureUnit))}</tspan>
  </text>` : "").join("");

  const windMarkup = timeline.map((observation, index) => {
    const x = xAt(index);
    const direction = windDirectionLabel(observation);
    const rotation = observation.windDirectionDeg === null ? 0 : observation.windDirectionDeg + 180;
    const speed = formatWind(observation.windSpeedKt, normalizedSettings.windUnit);
    const gust = observation.windGustKt === null ? "" : `G${formatWind(observation.windGustKt, normalizedSettings.windUnit)}`;
    const directional = observation.windDirectionDeg !== null
      && !observation.windVariable
      && Number(observation.windSpeedKt) > 0;
    const conditionalWind = forecastOverlays(observation).flatMap((entry) => {
      const value = entry.conditions || {};
      if (value.windSpeedKt === null || value.windSpeedKt === undefined) return [];
      return [`${visualConditionalTypeLabel(entry)} ${windDirectionLabel(value)} ${formatWind(value.windSpeedKt, normalizedSettings.windUnit)}${value.windGustKt === null || value.windGustKt === undefined ? "" : ` G${formatWind(value.windGustKt, normalizedSettings.windUnit)}`}`];
    }).join(" · ");
    return `<g class="aviation-meteogram-wind${isForecast(observation) ? " aviation-meteogram-wind-forecast" : ""}${visualLabelMask[index] ? "" : " aviation-meteogram-label-suppressed"}" transform="translate(${x.toFixed(1)} 0)">
      ${visualLabelMask[index] ? `
      ${directional ? `<text class="aviation-meteogram-wind-arrow" x="0" y="${rows.wind.top + 29}" transform="rotate(${rotation} 0 ${rows.wind.top + 23})">↑</text>` : ""}
      <text class="aviation-meteogram-wind-heading" x="0" y="${rows.wind.top + 53}">${escapeMarkup(direction)} ${escapeMarkup(speed)}</text>
      <text class="aviation-meteogram-wind-gust" x="0" y="${rows.wind.top + 71}">${escapeMarkup(gust)}</text>
      ${conditionalWind ? `<text class="aviation-meteogram-conditional-value" x="0" y="${rows.wind.bottom - 4}">${escapeMarkup(conditionalWind)}</text>` : ""}` : ""}
    </g>`;
  }).join("");

  const pressureValuesMarkup = timeline.map((observation, index) => visualLabelMask[index] ? `<text class="aviation-meteogram-pressure-value${isForecast(observation) ? " aviation-meteogram-value-forecast" : ""}" x="${xAt(index).toFixed(1)}" y="${rows.pressure.top + 23}">${escapeMarkup(observation.pressureInHg === null ? "—" : fixed(observation.pressureInHg, 2))}</text>` : "").join("");

  const cloudMarkup = timeline.map((observation, index) => {
    const x = xAt(index);
    const ceiling = observation.clouds.ceilingFt;
    const ceilingRatio = ceiling === null ? 0 : clamp(Math.log10(Math.max(100, ceiling) / 100) / 2.2, 0.06, 1);
    const barHeight = ceiling === null ? 0 : (rows.clouds.bottom - rows.clouds.top - 34) * (1 - ceilingRatio * 0.72);
    const barY = rows.clouds.bottom - barHeight;
    const ceilingText = ceilingLabel(observation.clouds);
    const conditionalCloud = forecastOverlays(observation).flatMap((entry) => entry.conditions?.clouds
      ? [`${visualConditionalTypeLabel(entry)} ${cloudColumnLabel({ clouds: entry.conditions.clouds })} ${ceilingLabel(entry.conditions.clouds)}`]
      : []).join(" · ");
    const barWidth = Math.min(columnWidth, cellWidthAt(index)) * 0.68;
    return `<g class="aviation-meteogram-cloud${isForecast(observation) ? " aviation-meteogram-cloud-forecast" : ""}" transform="translate(${x.toFixed(1)} 0)">
      ${ceiling === null ? "" : `<rect class="aviation-meteogram-ceiling-column" x="${(-barWidth / 2).toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"/>`}
      ${visualLabelMask[index] ? `<text class="aviation-meteogram-cloud-layers" x="0" y="${rows.clouds.top + 29}">${escapeMarkup(cloudColumnLabel(observation))}</text>
      ${conditionalCloud ? `<text class="aviation-meteogram-conditional-value" x="0" y="${rows.clouds.top + 47}">${escapeMarkup(conditionalCloud)}</text>` : ""}
      <text class="aviation-meteogram-ceiling-value" x="0" y="${rows.clouds.bottom - 12}">${escapeMarkup(ceilingText)}</text>` : ""}
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

  const precipitationMarkup = timeline.map((observation, index) => {
    const x = xAt(index);
    const rain = rainDisplay(observation);
    const snow = snowDisplay(observation);
    const amount = observation.precipitation.liquidEquivalentIn;
    const rainHeight = isForecast(observation) ? 0 : amount === null ? (observation.precipitation.rainObserved ? 9 : 0) : clamp(amount * 190, 3, 32);
    const rainBarWidth = Math.min(columnWidth, cellWidthAt(index)) * 0.54;
    return `<g class="aviation-meteogram-precip${isForecast(observation) ? " aviation-meteogram-precip-forecast" : ""}" transform="translate(${x.toFixed(1)} 0)">
      ${rainHeight ? `<rect class="aviation-meteogram-rain-bar" x="${(-rainBarWidth / 2).toFixed(1)}" y="${(rows.rain.bottom - 7 - rainHeight).toFixed(1)}" width="${rainBarWidth.toFixed(1)}" height="${rainHeight.toFixed(1)}"/>` : ""}
      ${visualLabelMask[index] ? `<text class="aviation-meteogram-rain-value" x="0" y="${rows.rain.top + 25}">${escapeMarkup(rain)}</text>
      <text class="aviation-meteogram-snow-value" x="0" y="${rows.snow.top + 36}">${escapeMarkup(snow)}</text>` : ""}
    </g>`;
  }).join("");

  const labelMarkup = rowLabelsMarkup(normalizedSettings, hasForecast);
  const observedPoints = (points) => points.map((point, index) => isForecast(timeline[index]) ? null : point);
  const forecastPoints = (points) => points.map((point, index) => isForecast(timeline[index]) ? point : null);
  const forecastTemperatureMarkers = timeline.map((observation, index) => {
    const point = tempPoints[index];
    return isForecast(observation) && point
      ? `<circle class="aviation-meteogram-temp-forecast-marker" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4"><title>${escapeMarkup(observation.temperatureKind || "TAF temperature extreme")}</title></circle>`
      : "";
  }).join("");
  const forecastRegion = hasForecast
    ? `<rect class="aviation-meteogram-forecast-background" x="${dividerX.toFixed(1)}" y="0" width="${Math.max(0, width - dividerX).toFixed(1)}" height="${height}"/>
      <line class="aviation-meteogram-now-divider" x1="${dividerX.toFixed(1)}" y1="0" x2="${dividerX.toFixed(1)}" y2="${height}"/>
      <g class="aviation-meteogram-now-label" transform="translate(${dividerX.toFixed(1)} 0)">
        <rect x="-54" y="2" width="108" height="16" rx="3"/>
        <text x="0" y="13">NOW / FORECAST</text>
      </g>`
    : "";

  return `<svg class="aviation-meteogram-svg" xmlns="${SVG_NS}" width="${width.toFixed(1)}" height="${height}" viewBox="0 0 ${width.toFixed(1)} ${height}" role="img" aria-labelledby="aviationMeteogramSvgTitle aviationMeteogramSvgDescription">
    <title id="aviationMeteogramSvgTitle">${escapeMarkup(model.station)} aviation weather meteogram</title>
    <desc id="aviationMeteogramSvgDescription">One shared time-proportional timeline of exact METAR and SPECI observations${hasForecast ? " followed by the current TAF forecast after a NOW divider" : ""}. Temperature and dew point share one scale and paired value row. Missing values are not inferred.</desc>
    <rect class="aviation-meteogram-background" width="${width.toFixed(1)}" height="${height}"/>
    ${forecastRegion}
    <rect class="aviation-meteogram-label-background" width="${labelWidth}" height="${height}"/>
    ${horizontalLines}${verticalLines}
    <line class="aviation-meteogram-label-divider" x1="${labelWidth}" y1="0" x2="${labelWidth}" y2="${height}"/>
    ${weatherMarkup}${timeMarkup}
    ${spreadMarkup(tempPoints, dewPoints, timeline)}
    ${pathMarkup(observedPoints(tempPoints), "aviation-meteogram-temp-line", timeline)}
    ${pathMarkup(forecastPoints(tempPoints), "aviation-meteogram-temp-line aviation-meteogram-line-forecast", timeline)}
    ${pathMarkup(observedPoints(dewPoints), "aviation-meteogram-dew-line", timeline)}
    ${temperatureValuesMarkup}${forecastTemperatureMarkers}${windMarkup}
    ${pathMarkup(observedPoints(pressurePoints), "aviation-meteogram-pressure-line", timeline)}
    ${pathMarkup(forecastPoints(pressurePoints), "aviation-meteogram-pressure-line aviation-meteogram-line-forecast", timeline)}
    ${pressureValuesMarkup}${cloudMarkup}
    ${pathMarkup(observedPoints(visibilityPoints), "aviation-meteogram-visibility-line", timeline)}
    ${pathMarkup(forecastPoints(visibilityPoints), "aviation-meteogram-visibility-line aviation-meteogram-line-forecast", timeline)}
    ${visibilityValuesMarkup}${precipitationMarkup}${labelMarkup}
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
  now = new Date(),
  doc = container?.ownerDocument || document,
  view = doc?.defaultView || window,
  initialViewState = null,
} = {}) {
  if (!container || !doc) return null;
  const model = buildMeteogramModel(reports, { station, tafReports, now });
  if (!model.observations.length) return null;

  const defaultSettings = {
    timeMode: model.timeZone ? "LOCAL" : "Z",
    temperatureUnit: "F",
    windUnit: "KT",
  };
  const settings = normalizedMeteogramSettings({
    ...defaultSettings,
    ...(initialViewState?.settings || {}),
  }, model);
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
  subtitle.textContent = model.forecasts.length
    ? "UNIFIED WEATHER TIMELINE · EXACT METAR / SPECI HISTORY + CURRENT TAF FORECAST"
    : model.taf?.warning
      ? "UNIFIED OBSERVED WEATHER TIMELINE · METAR / SPECI · CURRENT TAF NOT SAFELY PLOTTED"
      : "UNIFIED OBSERVED WEATHER TIMELINE · METAR / SPECI · CURRENT TAF UNAVAILABLE";
  identity.append(title, subtitle);

  const controls = doc.createElement("div");
  controls.className = "aviation-meteogram-controls";
  controls.append(
    createToggleGroup(doc, "Meteogram time display", "timeMode", [
      { value: "LOCAL", label: "LOCAL" }, { value: "Z", label: "Z" },
    ]),
    createToggleGroup(doc, "Meteogram temperature unit", "temperatureUnit", [
      { value: "F", label: "°F" }, { value: "C", label: "°C" },
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
  range.textContent = `${rangeLabel} · ${model.observations.length} exact observed ${model.observations.length === 1 ? "bucket" : "buckets"}${model.forecasts.length ? ` · ${model.forecasts.length} current-TAF forecast buckets` : ""}`;
  const legend = doc.createElement("span");
  legend.innerHTML = '<i class="aviation-meteogram-key aviation-meteogram-key-observed"></i>OBSERVED <i class="aviation-meteogram-key aviation-meteogram-key-forecast"></i>TAF FORECAST <i class="aviation-meteogram-key aviation-meteogram-key-temp"></i>TEMP <i class="aviation-meteogram-key aviation-meteogram-key-dew"></i>DEW';
  context.append(range, legend);

  const scroller = doc.createElement("div");
  scroller.className = "aviation-meteogram-scroll";
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", `${model.station} meteogram shared timeline; horizontally scroll for observed history and current TAF forecast`);

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
    ? "OBSERVED = EXACT METAR/SPECI · FORECAST = CURRENT TAF · NOW DIVIDER · TEMPO/PROB REMAIN CONDITIONAL · MISSING VALUES SHOWN AS —"
    : "OBSERVED REPORTS ONLY · STRAIGHT CONNECTORS · GAPS OVER 2.5 HR DISCONNECTED · MISSING VALUES SHOWN AS —";
  const precip = doc.createElement("span");
  precip.textContent = model.forecasts.length
    ? "TAF HAS NO DEW POINT OR PRECIP AMOUNTS · TX/TN ARE EXACT EXTREMA ONLY · OBS LWE/DEPTH ARE NOT FORECAST AMOUNTS"
    : "LWE = REPORTED LIQUID-WATER EQUIVALENT; SNOW DEPTH IS NOT NEW SNOWFALL";
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
    const dimensions = meteogramDimensions(model.timeline, viewportWidth);
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
