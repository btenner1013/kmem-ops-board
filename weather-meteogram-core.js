import {
  decodeTafReport,
  isValidIcao,
  normalizeIcao,
  resolveStationTimeZone,
} from "./aviation-weather-lookup-core.js";

export const METEOGRAM_DEFAULT_RANGE = "24";
export const METEOGRAM_ALLOWED_RANGES = Object.freeze(new Set(["1", "2", "3", "6", "12", "24", "48", "96"]));

const MPH_PER_KNOT = 1.150779448;
const HPA_PER_INHG = 33.8638866667;
const KNOTS_PER_METRE_PER_SECOND = 1.943844492;
const METRES_PER_STATUTE_MILE = 1609.344;
const METEOGRAM_MAX_FORECAST_HOURS = 36;
const METEOGRAM_MIN_SAMPLE_SPACING_MS = 30 * 60 * 1000;

function normalizedRaw(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signedTemperature(token) {
  const value = String(token || "").toUpperCase();
  if (!/^M?\d{2}$/.test(value)) return null;
  const magnitude = Number(value.replace(/^M/, ""));
  return value.startsWith("M") ? -magnitude : magnitude;
}

function fractionValue(value) {
  const match = String(value || "").match(/^(\d+)\/(\d+)$/);
  if (!match || Number(match[2]) === 0) return null;
  return Number(match[1]) / Number(match[2]);
}

function parseVisibility(rawBody, windMatch) {
  const start = windMatch ? windMatch.index + windMatch[0].length : 0;
  const tail = rawBody.slice(start);
  if (/(?:^|\s)CAVOK(?=\s|$)/i.test(tail)) {
    return {
      valueSm: 10000 / METRES_PER_STATUTE_MILE,
      qualifier: "≥",
      display: "≥10 KM",
      cavok: true,
    };
  }
  let match = tail.match(/\bP(\d+(?:\.\d+)?)SM\b/i);
  if (match) return { valueSm: Number(match[1]), qualifier: ">", display: `>${match[1]} SM` };
  match = tail.match(/\bM(\d+\/\d+)SM\b/i);
  if (match) {
    const value = fractionValue(match[1]);
    return { valueSm: value, qualifier: "<", display: value === null ? "—" : `<${match[1]} SM` };
  }
  match = tail.match(/\b(\d+)\s+(\d+\/\d+)SM\b/i);
  if (match) {
    const fraction = fractionValue(match[2]);
    const value = fraction === null ? null : Number(match[1]) + fraction;
    return { valueSm: value, qualifier: "", display: value === null ? "—" : `${match[1]} ${match[2]} SM` };
  }
  match = tail.match(/\b(\d+\/\d+)SM\b/i);
  if (match) {
    const value = fractionValue(match[1]);
    return { valueSm: value, qualifier: "", display: value === null ? "—" : `${match[1]} SM` };
  }
  match = tail.match(/\b(\d+(?:\.\d+)?)SM\b/i);
  if (match) return { valueSm: Number(match[1]), qualifier: "", display: `${match[1]} SM` };

  // International reports commonly use four-digit prevailing visibility in metres.
  match = tail.match(/(?:^|\s)(9999|\d{4})(?=\s|$)/);
  if (match) {
    const metres = Number(match[1]);
    const valueSm = match[1] === "9999" ? 10000 / METRES_PER_STATUTE_MILE : metres / METRES_PER_STATUTE_MILE;
    return {
      valueSm,
      qualifier: match[1] === "9999" ? "≥" : "",
      display: match[1] === "9999" ? "≥10 KM" : `${metres} M`,
    };
  }
  return { valueSm: null, qualifier: "", display: "—", cavok: false };
}

function parseClouds(rawBody) {
  const layers = [];
  const pattern = /\b(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?(?=\s|$)/g;
  for (const match of rawBody.matchAll(pattern)) {
    const heightFt = match[2] === "///" ? null : Number(match[2]) * 100;
    layers.push({
      cover: match[1],
      heightFt,
      convective: match[3] || "",
      raw: match[0],
    });
  }
  const clear = /\b(?:CLR|SKC|NSC|NCD)\b/.test(rawBody);
  const cavok = /(?:^|\s)CAVOK(?=\s|$)/.test(rawBody);
  const ceilingCandidates = layers
    .filter((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && layer.heightFt !== null)
    .map((layer) => layer.heightFt);
  return {
    layers,
    clear,
    cavok,
    ceilingFt: ceilingCandidates.length ? Math.min(...ceilingCandidates) : null,
    display: layers.length ? layers.map((layer) => layer.raw).join(" · ") : clear ? "CLR" : cavok ? "CAVOK" : "—",
  };
}

function parseWeatherCodes(rawBody) {
  const codes = [];
  const tokenPattern = /^(?:(?:\+|-)?TS|VC(?:TS|SH)|(?:\+|-|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){1,3})$/;
  for (const token of rawBody.split(/\s+/)) {
    const code = String(token || "").toUpperCase();
    if (!tokenPattern.test(code)) continue;
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function weatherPresentation(codes, clouds) {
  const joined = codes.join(" ");
  if (/TS/.test(joined)) return { icon: "⚡", label: /RA/.test(joined) ? "THUNDER + RAIN" : "THUNDER" };
  if (/SN|SG|PL/.test(joined)) return { icon: "❄", label: "WINTRY PRECIP" };
  if (/RA|DZ/.test(joined)) return { icon: "☂", label: "RAIN" };
  if (/VCSH/.test(joined)) return { icon: "☂", label: "VICINITY SHOWERS" };
  if (/FG|BR/.test(joined)) return { icon: "≋", label: /FG/.test(joined) ? "FOG" : "MIST" };
  if (/HZ|FU|DU|SA/.test(joined)) return { icon: "◫", label: "OBSCURATION" };
  if (clouds.cavok) return { icon: "◒", label: "CAVOK" };
  if (clouds.clear) return { icon: "☀", label: "CLEAR" };
  if (clouds.layers.some((layer) => ["BKN", "OVC", "VV"].includes(layer.cover))) return { icon: "☁", label: "CLOUDY" };
  if (clouds.layers.length) return { icon: "◒", label: "PARTLY CLOUDY" };
  return { icon: "·", label: "NO WX CODE" };
}

function decodedWeatherCode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  let prefix = "";
  if (text.startsWith("light ")) prefix = "-";
  else if (text.startsWith("heavy ")) prefix = "+";
  else if (text.startsWith("in the vicinity:")) prefix = "VC";
  const descriptor = [
    ["thunderstorm", "TS"], ["showers", "SH"], ["freezing", "FZ"],
    ["blowing", "BL"], ["low drifting", "DR"], ["patches", "BC"],
    ["partial", "PR"], ["shallow", "MI"],
  ].find(([phrase]) => text.includes(phrase))?.[1] || "";
  let remaining = text;
  const phenomena = [];
  for (const [phrase, code] of [
    ["small hail/snow pellets", "GS"], ["funnel cloud/tornado/waterspout", "FC"],
    ["unknown precipitation", "UP"], ["widespread dust", "DU"],
    ["dust/sand whirls", "PO"], ["volcanic ash", "VA"],
    ["snow grains", "SG"], ["ice crystals", "IC"], ["ice pellets", "PL"],
    ["sandstorm", "SS"], ["duststorm", "DS"], ["drizzle", "DZ"],
    ["rain", "RA"], ["snow", "SN"], ["hail", "GR"], ["mist", "BR"],
    ["fog", "FG"], ["smoke", "FU"], ["sand", "SA"], ["haze", "HZ"],
    ["spray", "PY"], ["squalls", "SQ"],
  ]) {
    if (!remaining.includes(phrase)) continue;
    phenomena.push(code);
    remaining = remaining.replaceAll(phrase, " ");
  }
  const code = `${prefix}${descriptor}${phenomena.join("")}`;
  return code || text.toUpperCase().replace(/\s+/g, " ");
}

function parsedDecodedWind(values) {
  const text = String(Array.isArray(values) ? values.at(-1) || "" : "");
  if (!text) return null;
  if (/^Calm$/i.test(text)) {
    return { windDirectionDeg: 0, windVariable: false, windSpeedKt: 0, windGustKt: null };
  }
  const match = text.match(/^(Variable|(\d+)° true) at (\d+(?:\.\d+)?) (kt|m\/s)(?:, gusting (\d+(?:\.\d+)?) \4)?$/i);
  if (!match) return null;
  const factor = match[4].toLowerCase() === "m/s" ? KNOTS_PER_METRE_PER_SECOND : 1;
  return {
    windDirectionDeg: match[2] ? Number(match[2]) : null,
    windVariable: /^Variable$/i.test(match[1]),
    windSpeedKt: Number(match[3]) * factor,
    windGustKt: match[5] ? Number(match[5]) * factor : null,
  };
}

function mixedFraction(value) {
  const text = String(value || "").trim();
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed && Number(mixed[3])) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction && Number(fraction[2])) return Number(fraction[1]) / Number(fraction[2]);
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parsedDecodedVisibility(values) {
  const text = String(Array.isArray(values) ? values.at(-1) || "" : "");
  if (!text) return null;
  if (/^10 km or greater/i.test(text)) {
    return {
      visibilitySm: 10000 / METRES_PER_STATUTE_MILE,
      visibilityQualifier: "≥",
      visibilityDisplay: "≥10 KM",
      cavok: /no significant weather or cloud/i.test(text),
    };
  }
  const metres = text.match(/^(\d+(?:\.\d+)?) metres$/i);
  if (metres) {
    return {
      visibilitySm: Number(metres[1]) / METRES_PER_STATUTE_MILE,
      visibilityQualifier: "",
      visibilityDisplay: `${metres[1]} M`,
      cavok: false,
    };
  }
  const statute = text.match(/^(Greater than |Less than )?(.+?) statute mile(?:s)?$/i);
  if (!statute) return null;
  const value = mixedFraction(statute[2]);
  if (value === null) return null;
  const qualifier = /^Greater/i.test(statute[1] || "") ? ">" : /^Less/i.test(statute[1] || "") ? "<" : "";
  return {
    visibilitySm: value,
    visibilityQualifier: qualifier,
    visibilityDisplay: `${qualifier}${statute[2]} SM`,
    cavok: false,
  };
}

function parsedDecodedClouds(values, cavok = false) {
  const source = Array.isArray(values) ? values : [];
  const clear = source.some((value) => /^(?:Sky clear|Clear below|No significant cloud|No cloud detected)/i.test(value));
  const coverMap = {
    Few: "FEW", Scattered: "SCT", Broken: "BKN", Overcast: "OVC", "Vertical visibility": "VV",
  };
  const layers = source.flatMap((value) => {
    const match = String(value).match(/^(Few|Scattered|Broken|Overcast|Vertical visibility) at (?:(\d+) ft|(unknown height))(?:; (cumulonimbus|towering cumulus))?$/i);
    if (!match) return [];
    const cover = coverMap[Object.keys(coverMap).find((key) => key.toLowerCase() === match[1].toLowerCase())];
    const heightFt = match[2] ? Number(match[2]) : null;
    const convective = match[4]?.toLowerCase() === "cumulonimbus" ? "CB" : match[4] ? "TCU" : "";
    return [{
      cover,
      heightFt,
      convective,
      raw: `${cover}${heightFt === null ? "///" : String(Math.round(heightFt / 100)).padStart(3, "0")}${convective}`,
    }];
  });
  const ceilingCandidates = layers
    .filter((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && layer.heightFt !== null)
    .map((layer) => layer.heightFt);
  return {
    layers,
    clear,
    cavok,
    ceilingFt: ceilingCandidates.length ? Math.min(...ceilingCandidates) : null,
    display: layers.length ? layers.map((layer) => layer.raw).join(" · ") : clear ? "CLR" : cavok ? "CAVOK" : "—",
  };
}

function parsedDecodedPressure(values) {
  const entry = Array.isArray(values) ? values.at(-1) : null;
  const text = String(entry?.value || "");
  const inches = text.match(/(\d+(?:\.\d+)?) inHg/i);
  if (inches) {
    const pressureInHg = Number(inches[1]);
    return { pressureInHg, pressureHpa: pressureInHg * HPA_PER_INHG };
  }
  const hpa = text.match(/(\d+(?:\.\d+)?) hPa/i);
  if (!hpa) return null;
  const pressureHpa = Number(hpa[1]);
  return { pressureHpa, pressureInHg: pressureHpa / HPA_PER_INHG };
}

function forecastConditionPatch(conditions, { prevailing = false } = {}) {
  const source = conditions && typeof conditions === "object" ? conditions : {};
  const patch = {};
  const wind = parsedDecodedWind(source.winds);
  if (wind) Object.assign(patch, wind);
  const visibility = parsedDecodedVisibility(source.visibility);
  if (visibility) Object.assign(patch, visibility);
  if ((Array.isArray(source.sky) && source.sky.length) || visibility?.cavok) {
    patch.clouds = parsedDecodedClouds(source.sky, visibility?.cavok === true);
  }
  const hasNoSignificantWeather = (source.flags || []).some((flag) => /No significant weather/i.test(flag)) || visibility?.cavok;
  if ((Array.isArray(source.weather) && source.weather.length) || hasNoSignificantWeather || prevailing) {
    patch.weatherCodes = hasNoSignificantWeather
      ? []
      : (source.weather || []).map(decodedWeatherCode).filter(Boolean);
  }
  const pressure = parsedDecodedPressure(source.pressure);
  if (pressure) Object.assign(patch, pressure);
  return patch;
}

function blankForecastState() {
  return {
    temperatureC: null,
    dewPointC: null,
    windDirectionDeg: null,
    windVariable: false,
    windSpeedKt: null,
    windGustKt: null,
    pressureInHg: null,
    pressureHpa: null,
    visibilitySm: null,
    visibilityQualifier: "",
    visibilityDisplay: "—",
    clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
    weatherCodes: [],
  };
}

function applyForecastPatch(state, patch, { replace = false } = {}) {
  const next = replace ? blankForecastState() : { ...state };
  return Object.assign(next, patch);
}

function ceilToUtcHour(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getUTCMinutes() || date.getUTCSeconds() || date.getUTCMilliseconds()) {
    date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
  } else date.setUTCMinutes(0, 0, 0);
  return date;
}

function timeInside(value, start, end) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= start.getTime() && timestamp < end.getTime();
}

function forecastBucketState(decoded, timestamp) {
  const instant = new Date(timestamp);
  const events = [];
  decoded.blocks.forEach((block, index) => {
    const start = new Date(block.startUtc);
    const end = new Date(block.endUtc);
    if (["INITIAL", "FROM"].includes(block.type) && Number.isFinite(start.getTime())) {
      events.push({ at: start, order: index, replace: true, patch: forecastConditionPatch(block.conditions, { prevailing: true }), sourceToken: block.sourceToken });
    } else if (block.type === "BECOMING" && Number.isFinite(end.getTime())) {
      events.push({ at: end, order: index, replace: false, patch: forecastConditionPatch(block.conditions), sourceToken: block.sourceToken });
    }
  });
  events.sort((left, right) => left.at - right.at || left.order - right.order);
  let state = blankForecastState();
  let sourceToken = "INITIAL";
  for (const event of events) {
    if (event.at > instant) break;
    state = applyForecastPatch(state, event.patch, { replace: event.replace });
    sourceToken = event.sourceToken;
  }
  return { state, sourceToken };
}

function conditionalForecasts(decoded, timestamp) {
  return decoded.blocks.flatMap((block) => {
    if (["INITIAL", "FROM", "BECOMING"].includes(block.type)) return [];
    const start = new Date(block.startUtc);
    const end = new Date(block.endUtc);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || !timeInside(timestamp, start, end)) return [];
    return [{
      type: block.type,
      sourceToken: block.sourceToken,
      conditions: forecastConditionPatch(block.conditions),
    }];
  });
}

function becomingForecasts(decoded, timestamp) {
  return decoded.blocks.flatMap((block) => {
    if (block.type !== "BECOMING") return [];
    const start = new Date(block.startUtc);
    const end = new Date(block.endUtc);
    return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && timeInside(timestamp, start, end)
      ? [{
        type: block.type,
        sourceToken: block.sourceToken,
        conditions: forecastConditionPatch(block.conditions),
      }]
      : [];
  });
}

export function buildTafForecastBuckets(tafReport, {
  station: stationValue,
  now = new Date(),
  latestObservedZ = null,
} = {}) {
  const station = normalizeIcao(stationValue || tafReport?.station);
  const nowDate = new Date(now);
  if (!isValidIcao(station) || !Number.isFinite(nowDate.getTime()) || !tafReport) return { buckets: [], taf: null };
  const decoded = decodeTafReport(tafReport, {
    station,
    timestamp: tafReport.timestamp || tafReport.issueTime || tafReport.issuanceTime,
    variant: tafReport.variant,
    referenceTime: nowDate,
  });
  const validStart = new Date(decoded.validity?.startUtc);
  const validEnd = new Date(decoded.validity?.endUtc);
  const issuance = new Date(decoded.issuanceUtc);
  if (![validStart, validEnd, issuance].every((date) => Number.isFinite(date.getTime())) || validEnd <= nowDate || issuance > nowDate) {
    return { buckets: [], taf: null };
  }
  const forecastStart = new Date(Math.max(nowDate.getTime(), validStart.getTime()));
  const naturalEnd = validEnd;
  const maximumEnd = new Date(nowDate.getTime() + METEOGRAM_MAX_FORECAST_HOURS * 60 * 60 * 1000);
  const forecastEnd = new Date(Math.min(naturalEnd.getTime(), maximumEnd.getTime()));
  if (forecastEnd <= forecastStart) return { buckets: [], taf: null };
  const tafMetadata = {
    issuanceZ: decoded.issuanceUtc,
    validityStartZ: decoded.validity.startUtc,
    validityEndZ: decoded.validity.endUtc,
    variant: decoded.variant,
    source: tafReport.source || "Current TAF",
    truncated: naturalEnd > forecastEnd,
    forecastEndZ: forecastEnd.toISOString(),
  };
  const noForecastToken = normalizedRaw(decoded.raw).match(/(?:^|\s)(CNL|NIL)(?=\s|$)/i)?.[1]?.toUpperCase();
  if (noForecastToken) {
    return {
      buckets: [],
      taf: {
        ...tafMetadata,
        warning: noForecastToken === "CNL"
          ? "Current TAF is cancelled; no forecast projection is shown."
          : "Current TAF reports NIL; no forecast projection is shown.",
      },
    };
  }
  const unsafeTimingTokens = [...new Set(decoded.undecoded.filter((token) => (
    /^(?:INTER|PROB30|PROB40|TEMPO|BECMG|FM\d{6}|\d{4}\/\d{4})$/i.test(String(token))
  )))];
  if (unsafeTimingTokens.length) {
    return {
      buckets: [],
      taf: {
        ...tafMetadata,
        warning: `Forecast omitted because timing group ${unsafeTimingTokens.join(" ")} is not safely decoded.`,
      },
    };
  }

  const timestamps = new Set();
  const exactBoundaries = new Set();
  const firstHour = ceilToUtcHour(forecastStart);
  for (let cursor = firstHour; cursor && cursor < forecastEnd; cursor = new Date(cursor.getTime() + 60 * 60 * 1000)) {
    if (cursor.getTime() - forecastStart.getTime() >= METEOGRAM_MIN_SAMPLE_SPACING_MS) {
      timestamps.add(cursor.toISOString());
    }
  }
  for (const block of decoded.blocks) {
    for (const boundary of [block.startUtc, block.type === "BECOMING" ? block.endUtc : null]) {
      const date = new Date(boundary);
      if (Number.isFinite(date.getTime()) && date >= forecastStart && date < forecastEnd) {
        exactBoundaries.add(date.toISOString());
        timestamps.add(date.toISOString());
      }
    }
  }
  for (const temperature of decoded.temperatures) {
    const date = new Date(temperature.timestampUtc);
    if (Number.isFinite(date.getTime()) && date >= forecastStart && date < forecastEnd) {
      exactBoundaries.add(date.toISOString());
      timestamps.add(date.toISOString());
    }
  }
  const forecastStartIso = forecastStart.toISOString();
  const latestObservedTime = Date.parse(latestObservedZ);
  const recentObservation = Number.isFinite(latestObservedTime)
    && forecastStart.getTime() >= latestObservedTime
    && forecastStart.getTime() - latestObservedTime < METEOGRAM_MIN_SAMPLE_SPACING_MS;
  const activeOverlay = conditionalForecasts(decoded, forecastStart).length > 0
    || becomingForecasts(decoded, forecastStart).length > 0;
  const nextExactBoundary = [...exactBoundaries]
    .map((value) => Date.parse(value))
    .filter((value) => value > forecastStart.getTime())
    .sort((left, right) => left - right)[0];
  const nearExactBoundary = Number.isFinite(nextExactBoundary)
    && nextExactBoundary - forecastStart.getTime() < METEOGRAM_MIN_SAMPLE_SPACING_MS;
  if (
    exactBoundaries.has(forecastStartIso)
    || activeOverlay
    || (!recentObservation && !nearExactBoundary)
    || timestamps.size === 0
  ) {
    timestamps.add(forecastStartIso);
  }

  const buckets = [...timestamps].sort().map((validZ) => {
    const { state, sourceToken } = forecastBucketState(decoded, validZ);
    const temperatureExtrema = decoded.temperatures.filter((temperature) => temperature.timestampUtc === validZ);
    const exactTemperature = temperatureExtrema[0] || null;
    const conditional = conditionalForecasts(decoded, validZ);
    const becoming = becomingForecasts(decoded, validZ);
    const weatherCodes = [...state.weatherCodes];
    const precipitation = {
      rainObserved: false,
      snowObserved: false,
      rainForecast: weatherCodes.some((code) => /RA|DZ/.test(code)),
      snowForecast: weatherCodes.some((code) => /SN|SG|PL|GS/.test(code)),
      conditionalRainForecast: conditional.some((entry) => entry.conditions.weatherCodes?.some((code) => /RA|DZ/.test(code))),
      conditionalSnowForecast: conditional.some((entry) => entry.conditions.weatherCodes?.some((code) => /SN|SG|PL|GS/.test(code))),
      liquidEquivalentIn: null,
      liquidTrace: false,
      snowDepthIn: null,
    };
    const value = {
      ...state,
      station,
      kind: "FORECAST",
      observedZ: validZ,
      validZ,
      reportType: "TAF",
      raw: decoded.raw,
      source: tafReport.source || "Current TAF",
      tafIssuanceZ: decoded.issuanceUtc,
      tafSourceToken: sourceToken,
      exactBoundary: exactBoundaries.has(validZ) || validZ === forecastStartIso,
      temperatureC: exactTemperature?.valueC ?? null,
      temperatureKind: exactTemperature?.type || "",
      temperatureExtrema,
      dewPointC: null,
      conditional,
      becoming,
      weatherCodes,
      precipitation,
    };
    value.weather = weatherPresentation(weatherCodes, value.clouds);
    return value;
  });

  return {
    buckets,
    taf: tafMetadata,
  };
}

function parsePrecipitation(raw, weatherCodes) {
  const rainObserved = weatherCodes.some((code) => /RA|DZ/.test(code));
  const snowObserved = weatherCodes.some((code) => /SN|SG|PL|GS/.test(code));
  const hourly = normalizedRaw(raw).match(/\bP(\d{4})\b/);
  const liquidEquivalentIn = hourly ? Number(hourly[1]) / 100 : null;
  const liquidTrace = Boolean(hourly && hourly[1] === "0000");
  const snowDepth = normalizedRaw(raw).match(/\b4\/(\d{3})\b/);
  return {
    rainObserved,
    snowObserved,
    liquidEquivalentIn,
    liquidTrace,
    snowDepthIn: snowDepth ? Number(snowDepth[1]) : null,
  };
}

function observationSignature(value) {
  return JSON.stringify([
    value.temperatureC, value.dewPointC, value.windDirectionDeg, value.windVariable,
    value.windSpeedKt, value.windGustKt, value.pressureInHg, value.visibilitySm,
    value.clouds.display, value.weatherCodes, value.precipitation,
  ]);
}

function completenessScore(value) {
  const scalar = [
    value.temperatureC, value.dewPointC, value.windSpeedKt, value.pressureInHg,
    value.visibilitySm,
  ].filter((item) => item !== null).length;
  return scalar
    + (value.windDirectionDeg !== null || value.windVariable ? 1 : 0)
    + (value.clouds.layers.length || value.clouds.clear ? 1 : 0)
    + (value.weatherCodes.length ? 1 : 0)
    + (value.reportType === "SPECI" ? 0.25 : 0);
}

function observationPreference(value) {
  return [
    /\bCOR\b/.test(value.raw) ? 2 : value.reportType === "SPECI" ? 1 : 0,
    value.completeness,
  ];
}

function preferredObservation(first, second) {
  const firstPreference = observationPreference(first);
  const secondPreference = observationPreference(second);
  if (secondPreference[0] !== firstPreference[0]) {
    return secondPreference[0] > firstPreference[0] ? second : first;
  }
  return secondPreference[1] > firstPreference[1] ? second : first;
}

export function parseMeteogramObservation(report) {
  const station = normalizeIcao(report?.station);
  const observed = new Date(report?.timestamp);
  const raw = normalizedRaw(report?.raw);
  if (!isValidIcao(station) || !Number.isFinite(observed.getTime()) || !raw) return null;

  const rawBody = raw.split(/\s+RMK\b/i)[0];
  const windMatch = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/.exec(rawBody);
  const windFactor = windMatch?.[4] === "MPS" ? KNOTS_PER_METRE_PER_SECOND : 1;
  const temperatureMatch = /\b(M?\d{2}|\/\/)\/(M?\d{2}|\/\/)\b/.exec(rawBody);
  const altimeter = /\bA(\d{4})\b/.exec(rawBody);
  const qnh = /\bQ(\d{4})\b/.exec(rawBody);
  const clouds = parseClouds(rawBody);
  const weatherCodes = parseWeatherCodes(rawBody);
  const pressureInHg = altimeter
    ? Number(altimeter[1]) / 100
    : qnh ? Number(qnh[1]) / HPA_PER_INHG : null;
  const pressureHpa = qnh ? Number(qnh[1]) : pressureInHg === null ? null : pressureInHg * HPA_PER_INHG;
  const visibility = parseVisibility(rawBody, windMatch);
  const reportType = String(report?.product || (/^SPECI\b/i.test(raw) ? "SPECI" : "METAR")).toUpperCase() === "SPECI"
    ? "SPECI"
    : "METAR";

  const value = {
    station,
    observedZ: observed.toISOString(),
    reportType,
    raw,
    source: String(report?.source || "METAR/SPECI source"),
    temperatureC: temperatureMatch ? signedTemperature(temperatureMatch[1]) : null,
    dewPointC: temperatureMatch ? signedTemperature(temperatureMatch[2]) : null,
    windDirectionDeg: windMatch && windMatch[1] !== "VRB" ? Number(windMatch[1]) : null,
    windVariable: Boolean(windMatch && windMatch[1] === "VRB"),
    windSpeedKt: windMatch ? Number(windMatch[2]) * windFactor : null,
    windGustKt: windMatch?.[3] ? Number(windMatch[3]) * windFactor : null,
    pressureInHg,
    pressureHpa,
    visibilitySm: visibility.valueSm,
    visibilityQualifier: visibility.qualifier,
    visibilityDisplay: visibility.display,
    clouds,
    weatherCodes,
    precipitation: parsePrecipitation(raw, weatherCodes),
    revised: false,
  };
  value.weather = weatherPresentation(weatherCodes, clouds);
  value.signature = observationSignature(value);
  value.completeness = completenessScore(value);
  return value;
}

export function buildMeteogramModel(reports, { station: stationValue, tafReports = [], now = new Date() } = {}) {
  const station = normalizeIcao(stationValue || reports?.[0]?.station);
  if (!isValidIcao(station)) return { station: "", observations: [], timeZone: null };

  const byTime = new Map();
  for (const report of Array.isArray(reports) ? reports : []) {
    const parsed = parseMeteogramObservation(report);
    if (!parsed || parsed.station !== station) continue;
    const existing = byTime.get(parsed.observedZ);
    if (!existing) {
      byTime.set(parsed.observedZ, parsed);
      continue;
    }
    if (existing.signature === parsed.signature) continue;
    const preferred = preferredObservation(existing, parsed);
    byTime.set(parsed.observedZ, { ...preferred, revised: true });
  }

  const observations = [...byTime.values()]
    .sort((a, b) => Date.parse(a.observedZ) - Date.parse(b.observedZ))
    .map((observation) => ({ ...observation, kind: "OBSERVED" }));
  const tafResult = buildTafForecastBuckets(Array.isArray(tafReports) ? tafReports[0] : null, {
    station,
    now,
    latestObservedZ: observations.at(-1)?.observedZ || null,
  });
  const forecasts = tafResult.buckets;
  return {
    station,
    timeZone: resolveStationTimeZone(station),
    observations,
    forecasts,
    timeline: [...observations, ...forecasts],
    dividerZ: forecasts.length ? new Date(now).toISOString() : null,
    taf: tafResult.taf,
    startZ: observations[0]?.observedZ || null,
    endZ: forecasts.at(-1)?.validZ || observations.at(-1)?.observedZ || null,
    observedSources: [...new Set(observations.map((observation) => observation.source).filter(Boolean))],
    revisedBuckets: observations.filter((observation) => observation.revised).length,
  };
}

export function meteogramLookupRequest({ station, range } = {}) {
  const normalizedRange = String(range || "") === "recent" ? METEOGRAM_DEFAULT_RANGE : String(range || "");
  return {
    station: normalizeIcao(station),
    product: "METAR",
    range: METEOGRAM_ALLOWED_RANGES.has(normalizedRange) ? normalizedRange : METEOGRAM_DEFAULT_RANGE,
  };
}

export function convertTemperature(valueC, unit = "F") {
  const value = finiteNumber(valueC);
  if (value === null) return null;
  return String(unit).toUpperCase() === "C" ? value : (value * 9 / 5) + 32;
}

export function convertWindSpeed(valueKt, unit = "KT") {
  const value = finiteNumber(valueKt);
  if (value === null) return null;
  return String(unit).toUpperCase() === "MPH" ? value * MPH_PER_KNOT : value;
}

export function formatMeteogramTime(value, { mode = "LOCAL", station = "KMEM" } = {}) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { time: "—", date: "", zone: "" };
  const requestedMode = String(mode).toUpperCase() === "Z" ? "Z" : "LOCAL";
  const resolvedZone = requestedMode === "Z" ? "UTC" : resolveStationTimeZone(station);
  const timeZone = resolvedZone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    time: `${parts.hour}:${parts.minute}`,
    date: `${parts.day} ${String(parts.month || "").toUpperCase()}`,
    zone: requestedMode === "Z" || !resolvedZone ? "Z" : String(parts.timeZoneName || "LOCAL").toUpperCase(),
  };
}

export function formatTemperature(valueC, unit = "F") {
  const value = convertTemperature(valueC, unit);
  return value === null ? "—" : `${Math.round(value)}°`;
}

export function formatWind(valueKt, unit = "KT") {
  const value = convertWindSpeed(valueKt, unit);
  return value === null ? "—" : String(Math.round(value));
}
