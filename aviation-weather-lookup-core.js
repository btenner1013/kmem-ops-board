export const LOOKUP_RANGES = Object.freeze([
  { value: "recent", label: "Most recent", hours: null },
  { value: "1", label: "Past 1 hour", hours: 1 },
  { value: "2", label: "Past 2 hours", hours: 2 },
  { value: "3", label: "Past 3 hours", hours: 3 },
  { value: "6", label: "Past 6 hours", hours: 6 },
  { value: "12", label: "Past 12 hours", hours: 12 },
  { value: "24", label: "Past 24 hours", hours: 24 },
  { value: "48", label: "Past 48 hours", hours: 48 },
  { value: "96", label: "Past 96 hours", hours: 96 },
]);

const IEM_METAR_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const IEM_API_URL = "https://mesonet.agron.iastate.edu";
const ATIS_INFO_URL = "https://atis.info/api";
const ATIS_CURRENT_LIMIT_MINUTES = 60;
const ATIS_HISTORY_SCHEMA_VERSION = 1;
const TAF_CURRENT_SCHEMA_VERSION = 1;
const TAF_CURRENT_SOURCE_POLICY = "NOAA_AWC_COMPLETE_CURRENT_CACHE";

// Exact overrides cover common airports in countries whose ICAO prefix spans
// several time zones. Prefix rules are used only where the prefix has one
// dependable civil timezone. Unknown stations deliberately remain UTC-only.
const STATION_TIMEZONE_OVERRIDES = Object.freeze({
  KMEM: "America/Chicago", KVOK: "America/Chicago", KJFK: "America/New_York",
  KLGA: "America/New_York", KEWR: "America/New_York", KBOS: "America/New_York",
  KIAD: "America/New_York", KDCA: "America/New_York", KATL: "America/New_York",
  KMIA: "America/New_York", KORD: "America/Chicago", KMDW: "America/Chicago",
  KDFW: "America/Chicago", KIAH: "America/Chicago", KDEN: "America/Denver",
  KPHX: "America/Phoenix", KLAX: "America/Los_Angeles", KSFO: "America/Los_Angeles",
  KSEA: "America/Los_Angeles", KPDX: "America/Los_Angeles", PANC: "America/Anchorage",
  PHNL: "Pacific/Honolulu", CYYZ: "America/Toronto", CYUL: "America/Toronto",
  CYVR: "America/Vancouver", CYYC: "America/Edmonton", CYWG: "America/Winnipeg",
  YSSY: "Australia/Sydney", YMML: "Australia/Melbourne", YBBN: "Australia/Brisbane",
  YPAD: "Australia/Adelaide", YPPH: "Australia/Perth", NZCH: "Pacific/Auckland",
  NZAA: "Pacific/Auckland", NZWN: "Pacific/Auckland", LPAZ: "Atlantic/Azores",
  GCRR: "Atlantic/Canary", GCLP: "Atlantic/Canary", SAEZ: "America/Argentina/Buenos_Aires",
  SBGR: "America/Sao_Paulo", SCEL: "America/Santiago", SEQM: "America/Guayaquil",
  SPJC: "America/Lima", SKBO: "America/Bogota", MMUN: "America/Cancun",
  MMMX: "America/Mexico_City", RJTT: "Asia/Tokyo", VHHH: "Asia/Hong_Kong",
  WSSS: "Asia/Singapore", VIDP: "Asia/Kolkata", VABB: "Asia/Kolkata",
  OMAA: "Asia/Dubai", OMDB: "Asia/Dubai", FAOR: "Africa/Johannesburg",
});

const ICAO_PREFIX_TIMEZONES = Object.freeze({
  // Europe and the North Atlantic.
  BI: "Atlantic/Reykjavik", EB: "Europe/Brussels", ED: "Europe/Berlin",
  EE: "Europe/Tallinn", EF: "Europe/Helsinki", EG: "Europe/London",
  EH: "Europe/Amsterdam", EK: "Europe/Copenhagen", EN: "Europe/Oslo",
  EP: "Europe/Warsaw", ES: "Europe/Stockholm", EV: "Europe/Riga",
  EY: "Europe/Vilnius", LC: "Asia/Nicosia", LD: "Europe/Zagreb",
  LE: "Europe/Madrid", LF: "Europe/Paris", LG: "Europe/Athens",
  LH: "Europe/Budapest", LI: "Europe/Rome", LJ: "Europe/Ljubljana",
  LK: "Europe/Prague", LL: "Asia/Jerusalem", LO: "Europe/Vienna",
  LR: "Europe/Bucharest", LS: "Europe/Zurich", LZ: "Europe/Bratislava",
  // Countries/regions with a dependable single civil timezone for the prefix.
  HE: "Africa/Cairo", HK: "Africa/Nairobi", HL: "Africa/Tripoli",
  HR: "Africa/Kigali", HU: "Africa/Kampala", OB: "Asia/Bahrain",
  OE: "Asia/Riyadh", OJ: "Asia/Amman", OK: "Asia/Kuwait",
  OL: "Asia/Beirut", OM: "Asia/Dubai", OT: "Asia/Qatar",
  RK: "Asia/Seoul", RJ: "Asia/Tokyo", RO: "Asia/Tokyo",
  VT: "Asia/Bangkok", VV: "Asia/Ho_Chi_Minh", WB: "Asia/Kuching",
  WM: "Asia/Kuala_Lumpur", WS: "Asia/Singapore", ZB: "Asia/Shanghai",
  ZG: "Asia/Shanghai", ZH: "Asia/Shanghai", ZL: "Asia/Shanghai",
  ZP: "Asia/Shanghai", ZS: "Asia/Shanghai", ZU: "Asia/Shanghai",
  ZW: "Asia/Shanghai", ZY: "Asia/Shanghai", FA: "Africa/Johannesburg",
  FB: "Africa/Gaborone", FV: "Africa/Harare", FW: "Africa/Blantyre",
  FX: "Africa/Maseru", MD: "America/Santo_Domingo",
  MK: "America/Jamaica", MP: "America/Panama", MR: "America/Costa_Rica",
  MS: "America/El_Salvador", MT: "America/Port-au-Prince", MU: "America/Havana",
  MW: "America/Belize", MY: "America/Nassau", SA: "America/Argentina/Buenos_Aires",
  SK: "America/Bogota", SP: "America/Lima", SV: "America/Caracas",
});

const ATIS_PHONETIC = Object.freeze({
  A: "ALFA", B: "BRAVO", C: "CHARLIE", D: "DELTA", E: "ECHO", F: "FOXTROT",
  G: "GOLF", H: "HOTEL", I: "INDIA", J: "JULIETT", K: "KILO", L: "LIMA",
  M: "MIKE", N: "NOVEMBER", O: "OSCAR", P: "PAPA", Q: "QUEBEC", R: "ROMEO",
  S: "SIERRA", T: "TANGO", U: "UNIFORM", V: "VICTOR", W: "WHISKEY",
  X: "X-RAY", Y: "YANKEE", Z: "ZULU",
});

export function normalizeIcao(value) {
  return String(value || "").trim().toUpperCase();
}

export function isValidIcao(value) {
  return /^[A-Z]{4}$/.test(normalizeIcao(value));
}

export function resolveStationTimeZone(value) {
  const station = normalizeIcao(value);
  if (!isValidIcao(station)) return null;
  const candidate = STATION_TIMEZONE_OVERRIDES[station]
    || ICAO_PREFIX_TIMEZONES[station.slice(0, 2)]
    || null;
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch (_error) {
    return null;
  }
}

function dateParts(value, options = {}) {
  const date = asDate(value);
  if (!date) return null;
  const timeZone = options.timeZone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  } catch (_error) {
    return null;
  }
}

function formatUtcDateTime(value) {
  const parts = dateParts(value, { timeZone: "UTC" });
  if (!parts) return "";
  return `${parts.day} ${parts.month.toUpperCase()} ${parts.year} ${parts.hour}${parts.minute}Z`;
}

export function formatStationLocalTime(value, stationValue, { includeYear = true } = {}) {
  const timeZone = resolveStationTimeZone(stationValue);
  if (!timeZone) return "LOCAL TIME UNAVAILABLE";
  const parts = dateParts(value, { timeZone });
  if (!parts) return "LOCAL TIME UNAVAILABLE";
  const year = includeYear ? ` ${parts.year}` : "";
  return `${parts.day} ${parts.month.toUpperCase()}${year} ${parts.hour}${parts.minute}L`;
}

export function rangeHours(value) {
  const match = LOOKUP_RANGES.find((item) => item.value === String(value));
  return match ? match.hours : undefined;
}

function asDate(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizedRaw(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const WEATHER_DESCRIPTORS = Object.freeze({
  MI: "shallow", PR: "partial", BC: "patches", DR: "low drifting",
  BL: "blowing", SH: "showers", TS: "thunderstorm", FZ: "freezing",
});

const WEATHER_PHENOMENA = Object.freeze({
  DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains",
  IC: "ice crystals", PL: "ice pellets", GR: "hail", GS: "small hail/snow pellets",
  UP: "unknown precipitation", BR: "mist", FG: "fog", FU: "smoke",
  VA: "volcanic ash", DU: "widespread dust", SA: "sand", HZ: "haze",
  PY: "spray", PO: "dust/sand whirls", SQ: "squalls", FC: "funnel cloud/tornado/waterspout",
  SS: "sandstorm", DS: "duststorm",
});

function signedTemperature(value) {
  const match = String(value || "").match(/^(M)?(\d{2})$/);
  return match ? (match[1] ? -Number(match[2]) : Number(match[2])) : null;
}

function decodeWindToken(token) {
  const match = String(token || "").toUpperCase().match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/);
  if (!match) return null;
  const speed = Number(match[2]);
  const gust = match[3] ? Number(match[3]) : null;
  const unit = match[4] === "KT" ? "kt" : "m/s";
  if (match[1] === "000" && speed === 0 && !gust) return "Calm";
  const direction = match[1] === "VRB" ? "Variable" : `${Number(match[1])}° true`;
  return `${direction} at ${speed} ${unit}${gust === null ? "" : `, gusting ${gust} ${unit}`}`;
}

function decodeVisibilityToken(tokens, index) {
  const token = String(tokens[index] || "").toUpperCase();
  if (token === "CAVOK") return { consumed: 1, value: "10 km or greater; no significant weather or cloud below 5,000 ft" };
  if (token === "9999") return { consumed: 1, value: "10 km or greater" };
  if (/^\d{4}$/.test(token)) return { consumed: 1, value: `${Number(token)} metres` };
  const statute = token.match(/^(P|M)?(\d+(?:\/\d+)?)SM$/);
  if (statute) {
    const prefix = statute[1] === "P" ? "Greater than " : statute[1] === "M" ? "Less than " : "";
    return { consumed: 1, value: `${prefix}${statute[2]} statute mile${statute[2] === "1" ? "" : "s"}` };
  }
  if (/^\d+$/.test(token) && /^\d+\/\d+SM$/.test(String(tokens[index + 1] || "").toUpperCase())) {
    return { consumed: 2, value: `${token} ${String(tokens[index + 1]).slice(0, -2)} statute miles` };
  }
  return null;
}

function decodeWeatherToken(tokenValue) {
  const token = String(tokenValue || "").toUpperCase();
  const match = token.match(/^(-|\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)?$/);
  if (!match || (!match[2] && !match[3]) || (!match[3] && match[2] !== "TS")) return null;
  const parts = [];
  if (match[1] === "-") parts.push("Light");
  if (match[1] === "+") parts.push("Heavy");
  if (match[1] === "VC") parts.push("In the vicinity:");
  if (match[2]) parts.push(WEATHER_DESCRIPTORS[match[2]]);
  const phenomena = String(match[3] || "").match(/.{2}/g) || [];
  parts.push(...phenomena.map((code) => WEATHER_PHENOMENA[code]).filter(Boolean));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function decodeSkyToken(tokenValue) {
  const token = String(tokenValue || "").toUpperCase();
  if (token === "SKC") return "Sky clear";
  if (token === "CLR") return "Clear below reporting threshold";
  if (token === "NSC") return "No significant cloud";
  if (token === "NCD") return "No cloud detected";
  const match = token.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)?(CB|TCU)?$/);
  if (!match) return null;
  const amount = {
    FEW: "Few", SCT: "Scattered", BKN: "Broken", OVC: "Overcast", VV: "Vertical visibility",
  }[match[1]];
  const height = match[2] && match[2] !== "///" ? ` at ${Number(match[2]) * 100} ft` : " at unknown height";
  const cloud = match[3] === "CB" ? "; cumulonimbus" : match[3] === "TCU" ? "; towering cumulus" : "";
  return `${amount}${height}${cloud}`;
}

function decodePressureToken(tokenValue) {
  const token = String(tokenValue || "").toUpperCase();
  const altimeter = token.match(/^A(\d{4})$/);
  if (altimeter) return { label: "Altimeter", value: `${(Number(altimeter[1]) / 100).toFixed(2)} inHg` };
  const qnh = token.match(/^Q(\d{4})$/);
  if (qnh) return { label: "QNH", value: `${Number(qnh[1])} hPa` };
  const military = token.match(/^QNH(\d{4})INS$/);
  if (military) return { label: "QNH", value: `${(Number(military[1]) / 100).toFixed(2)} inHg` };
  return null;
}

function decodeRvrToken(tokenValue) {
  const token = String(tokenValue || "").toUpperCase();
  const match = token.match(/^R(\d{2}[LCR]?)\/([MP]?\d{4})(?:V([MP]?\d{4}))?(FT)?(?:\/[UDN])?$/);
  if (!match) return null;
  const unit = match[4] ? "ft" : "m";
  const render = (value) => `${value.startsWith("M") ? "less than " : value.startsWith("P") ? "greater than " : ""}${Number(value.replace(/^[MP]/, ""))} ${unit}`;
  return `Runway ${match[1]}: ${render(match[2])}${match[3] ? ` varying to ${render(match[3])}` : ""}`;
}

function decodeConditionTokens(tokens) {
  const decoded = { winds: [], visibility: [], rvr: [], weather: [], sky: [], pressure: [], flags: [], undecoded: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "").toUpperCase();
    if (!token || token === "=") continue;
    const wind = decodeWindToken(token);
    if (wind) {
      decoded.winds.push(wind);
      continue;
    }
    const variableDirection = token.match(/^(\d{3})V(\d{3})$/);
    if (variableDirection) {
      decoded.winds.push(`Direction varying from ${Number(variableDirection[1])}° to ${Number(variableDirection[2])}° true`);
      continue;
    }
    const visibility = decodeVisibilityToken(tokens, index);
    if (visibility) {
      decoded.visibility.push(visibility.value);
      index += visibility.consumed - 1;
      continue;
    }
    const rvr = decodeRvrToken(token);
    if (rvr) {
      decoded.rvr.push(rvr);
      continue;
    }
    const weather = decodeWeatherToken(token);
    if (weather) {
      decoded.weather.push(weather);
      continue;
    }
    const sky = decodeSkyToken(token);
    if (sky) {
      decoded.sky.push(sky);
      continue;
    }
    const pressure = decodePressureToken(token);
    if (pressure) {
      decoded.pressure.push(pressure);
      continue;
    }
    if (token === "AUTO") decoded.flags.push("AUTO — fully automated report");
    else if (token === "COR") decoded.flags.push("COR — corrected report");
    else if (token === "NOSIG") decoded.flags.push("No significant change expected");
    else if (token === "NSW") decoded.flags.push("No significant weather");
    else decoded.undecoded.push(String(tokens[index]));
  }
  return decoded;
}

function resolveDayTime(day, hour, minute, anchorValue, { notBefore = null } = {}) {
  const anchor = asDate(anchorValue);
  if (!anchor || !Number.isInteger(day) || day < 1 || day > 31 || hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  const candidates = [];
  for (let monthOffset = -1; monthOffset <= 1; monthOffset += 1) {
    const candidate = new Date(Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() + monthOffset,
      day,
      hour,
      minute,
    ));
    if (candidate.getUTCDate() !== (hour === 24 ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + monthOffset, day + 1)).getUTCDate() : day)) {
      continue;
    }
    candidates.push(candidate);
  }
  const floor = asDate(notBefore);
  const eligible = floor ? candidates.filter((candidate) => candidate >= floor) : candidates;
  const pool = eligible.length ? eligible : candidates;
  pool.sort((left, right) => Math.abs(left - anchor) - Math.abs(right - anchor));
  return pool[0] || null;
}

function reportInput(value, options = {}) {
  const isObject = value && typeof value === "object" && !(value instanceof Date);
  const raw = isObject ? String(value.raw ?? "") : String(value ?? "");
  return {
    raw,
    station: normalizeIcao(options.station || (isObject ? value.station ?? "" : "")),
    timestamp: asDate(options.timestamp || (isObject ? value.timestamp ?? null : null)),
    product: String(options.product || (isObject ? value.product ?? "" : "")).toUpperCase(),
    variant: String(options.variant || (isObject ? value.variant ?? "" : "")).toUpperCase(),
    referenceTime: asDate(options.referenceTime || options.now || new Date()),
  };
}

function appendConditionLines(lines, conditions) {
  const groups = [
    ["Wind", conditions.winds], ["Visibility", conditions.visibility],
    ["RVR", conditions.rvr], ["Present Weather", conditions.weather],
    ["Sky", conditions.sky],
  ];
  for (const [label, values] of groups) {
    for (const value of values) lines.push({ label, value });
  }
  for (const pressure of conditions.pressure) lines.push(pressure);
  for (const flag of conditions.flags) lines.push({ label: "Qualifier", value: flag });
}

function decodeRemarks(tokens) {
  const remarks = [];
  const undecoded = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const original = String(tokens[index] || "");
    const token = original.toUpperCase();
    if (token === "AO1") remarks.push({ code: original, meaning: "Automated station without precipitation discriminator" });
    else if (token === "AO2") remarks.push({ code: original, meaning: "Automated station with precipitation discriminator" });
    else if (/^SLP\d{3}$/.test(token)) {
      const tenths = Number(token.slice(3));
      const pressure = tenths < 500 ? 1000 + tenths / 10 : 900 + tenths / 10;
      remarks.push({ code: original, meaning: `Sea-level pressure ${pressure.toFixed(1)} hPa` });
    } else if (/^T[01]\d{3}[01]\d{3}$/.test(token)) {
      const temperature = (token[1] === "1" ? -1 : 1) * Number(token.slice(2, 5)) / 10;
      const dewPoint = (token[5] === "1" ? -1 : 1) * Number(token.slice(6, 9)) / 10;
      remarks.push({ code: original, meaning: `Precise temperature ${temperature.toFixed(1)}°C / dew point ${dewPoint.toFixed(1)}°C` });
    } else if (/^P\d{4}$/.test(token)) remarks.push({ code: original, meaning: `${(Number(token.slice(1)) / 100).toFixed(2)} in precipitation in the past hour` });
    else if (/^6\d{4}$/.test(token)) remarks.push({ code: original, meaning: `${(Number(token.slice(1)) / 100).toFixed(2)} in precipitation in the past 3 or 6 hours` });
    else if (/^7\d{4}$/.test(token)) remarks.push({ code: original, meaning: `${(Number(token.slice(1)) / 100).toFixed(2)} in precipitation in the past 24 hours` });
    else if (token === "PRESRR") remarks.push({ code: original, meaning: "Pressure rising rapidly" });
    else if (token === "PRESFR") remarks.push({ code: original, meaning: "Pressure falling rapidly" });
    else if (token === "PK" && String(tokens[index + 1] || "").toUpperCase() === "WND" && tokens[index + 2]) {
      remarks.push({ code: `${original} ${tokens[index + 1]} ${tokens[index + 2]}`, meaning: "Peak wind" });
      index += 2;
    } else if (token === "WSHFT" && tokens[index + 1]) {
      remarks.push({ code: `${original} ${tokens[index + 1]}`, meaning: "Wind shift time" });
      index += 1;
    } else if (token === "VIS" && tokens[index + 1]) {
      const tail = [tokens[index + 1]];
      if (tokens[index + 2] && /^(?:[NSEW]{1,2}|RWY\d{2}[LCR]?)$/i.test(tokens[index + 2])) tail.push(tokens[index + 2]);
      remarks.push({ code: `${original} ${tail.join(" ")}`, meaning: "Supplemental visibility observation" });
      index += tail.length;
    } else if (token === "$") remarks.push({ code: original, meaning: "Maintenance indicator" });
    else undecoded.push(original);
  }
  return { remarks, undecoded };
}

export function decodeMetarReport(value, options = {}) {
  const input = reportInput(value, options);
  const flat = normalizedRaw(input.raw);
  const header = flat.match(/^(?:(METAR|SPECI)\s+)?(?:(COR)\s+)?([A-Z]{4})\s+(\d{6}Z)\b/i);
  if (!header) {
    return {
      product: input.product || "METAR", station: input.station, title: input.product || "METAR",
      raw: input.raw, lines: [], sections: [], remarks: [], undecoded: flat ? [flat] : [],
    };
  }
  const product = String(header[1] || input.product || "METAR").toUpperCase() === "SPECI" ? "SPECI" : "METAR";
  const station = normalizeIcao(header[3]);
  const observationToken = header[4].toUpperCase();
  const tokenParts = observationToken.match(/^(\d{2})(\d{2})(\d{2})Z$/);
  const timestamp = input.timestamp || resolveDayTime(
    Number(tokenParts[1]), Number(tokenParts[2]), Number(tokenParts[3]), input.referenceTime,
  );
  const remainder = flat.slice(header[0].length).trim().split(/\s+/).filter(Boolean);
  const remarkIndex = remainder.findIndex((token) => token.toUpperCase() === "RMK");
  const bodyTokens = remarkIndex >= 0 ? remainder.slice(0, remarkIndex) : remainder;
  const remarkTokens = remarkIndex >= 0 ? remainder.slice(remarkIndex + 1) : [];
  if (header[2]) bodyTokens.unshift(header[2]);

  let temperature = null;
  let dewPoint = null;
  const conditionTokens = [];
  for (const token of bodyTokens) {
    const temperatures = String(token).toUpperCase().match(/^(M?\d{2})\/(M?\d{2}|\/\/|XX)$/);
    if (temperatures) {
      temperature = signedTemperature(temperatures[1]);
      dewPoint = signedTemperature(temperatures[2]);
    } else conditionTokens.push(token);
  }
  const conditions = decodeConditionTokens(conditionTokens);
  const remarkResult = decodeRemarks(remarkTokens);
  const overviewLines = [
    { label: "Observation", value: timestamp ? formatUtcDateTime(timestamp) : observationToken },
    { label: "Station Local", value: timestamp ? formatStationLocalTime(timestamp, station) : "LOCAL TIME UNAVAILABLE" },
  ];
  const conditionLines = [];
  appendConditionLines(conditionLines, conditions);
  if (temperature !== null) conditionLines.push({ label: "Temperature", value: `${temperature}°C` });
  if (dewPoint !== null) conditionLines.push({ label: "Dew Point", value: `${dewPoint}°C` });
  const remarkLines = remarkResult.remarks.map((remark) => ({
    label: remark.code === "$" ? "Maintenance Indicator" : remark.code,
    value: remark.meaning,
  }));
  const sections = [
    { heading: "Report", lines: overviewLines },
    { heading: "Conditions", lines: conditionLines },
    ...(remarkLines.length ? [{ heading: "Remarks", lines: remarkLines }] : []),
  ];
  const lines = sections.flatMap((section) => section.lines);

  return {
    product,
    station,
    title: `${product} — ${station}`,
    raw: input.raw,
    observationUtc: timestamp ? timestamp.toISOString() : "",
    observationLocal: timestamp ? formatStationLocalTime(timestamp, station) : "LOCAL TIME UNAVAILABLE",
    timeZone: resolveStationTimeZone(station),
    conditions,
    temperatureC: temperature,
    dewPointC: dewPoint,
    remarks: remarkResult.remarks,
    lines,
    sections,
    undecoded: [...conditions.undecoded, ...remarkResult.undecoded],
  };
}

export function dedupeReports(reports) {
  const seen = new Set();
  const unique = [];

  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || typeof report !== "object") continue;
    const date = asDate(report.timestamp);
    const raw = normalizedRaw(report.raw);
    if (!date || !raw) continue;
    const product = String(report.product || "").toUpperCase();
    let identityRaw = raw;
    if (product === "METAR") identityRaw = identityRaw.replace(/^METAR\s+/i, "");
    if (product === "TAF") identityRaw = identityRaw.replace(/\s*=\s*$/, "").trim();
    const key = [
      product,
      normalizeIcao(report.station),
      date.toISOString(),
      String(report.letter || "").toUpperCase(),
      String(report.variant || "").toUpperCase(),
      identityRaw,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...report, timestamp: date.toISOString(), raw: String(report.raw).trim() });
  }

  return unique;
}

export function filterAndSortReports(reports, hours, now = new Date()) {
  const nowDate = asDate(now);
  if (!nowDate) return [];
  const cutoff = hours === null || hours === undefined
    ? Number.NEGATIVE_INFINITY
    : nowDate.getTime() - (Number(hours) * 60 * 60 * 1000);

  return dedupeReports(reports)
    .filter((report) => {
      const time = Date.parse(report.timestamp);
      return Number.isFinite(time) && time >= cutoff && time <= nowDate.getTime();
    })
    .sort((a, b) => {
      const timeOrder = Date.parse(b.timestamp) - Date.parse(a.timestamp);
      if (timeOrder) return timeOrder;
      if (String(a.product || "").toUpperCase() === "TAF" && String(b.product || "").toUpperCase() === "TAF") {
        const variantRank = (report) => ({ COR: 2, AMD: 1 }[String(report.variant || "").toUpperCase()] || 0);
        const variantOrder = variantRank(b) - variantRank(a);
        if (variantOrder) return variantOrder;
        const rawOrder = normalizedRaw(a.raw).localeCompare(normalizedRaw(b.raw));
        if (rawOrder) return rawOrder;
        return String(a.source || "").localeCompare(String(b.source || ""));
      }
      return 0;
    });
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < String(text || "").length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => String(value).trim()));
}

function metarStation(raw) {
  const match = normalizedRaw(raw).match(/^(?:(?:METAR|SPECI)\s+)?([A-Z]{4})\s+\d{6}Z\b/i);
  return match ? match[1].toUpperCase() : "";
}

function metarProduct(raw) {
  return /^SPECI\b/i.test(normalizedRaw(raw)) ? "SPECI" : "METAR";
}

export function parseIemMetarCsv(text, requestedStation) {
  const station = normalizeIcao(requestedStation);
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows[0].map((value) => String(value).trim().toLowerCase());
  const validIndex = headers.indexOf("valid");
  const metarIndex = headers.indexOf("metar");
  if (validIndex < 0 || metarIndex < 0) return [];

  const reports = [];
  for (const row of rows.slice(1)) {
    const raw = String(row[metarIndex] || "").trim();
    const reportStation = metarStation(raw);
    const validText = String(row[validIndex] || "").trim();
    const timestamp = asDate(validText.includes("T") ? validText : `${validText.replace(" ", "T")}Z`);
    if (!raw || !timestamp || reportStation !== station) continue;
    reports.push({
      product: metarProduct(raw),
      station,
      timestamp: timestamp.toISOString(),
      raw,
      source: "Iowa Environmental Mesonet",
    });
  }
  return reports;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTafDisplay(rawValue, requestedStation, fallbackVariant = "") {
  const raw = String(rawValue || "").trim();
  const station = normalizeIcao(requestedStation);
  if (!raw || !isValidIcao(station)) return raw;

  const flattened = normalizedRaw(raw);
  const header = new RegExp(
    `^(?:TAF\\s+)?(?:(AMD|COR)\\s+)?(${escapeRegExp(station)})\\s+(?:(\\d{6}Z)\\s+)?(\\d{4}\\/\\d{4})(?=\\s|$)`,
    "i",
  ).exec(flattened);
  if (!header) return raw;

  const rawVariant = String(header[1] || "").toUpperCase();
  const suppliedVariant = String(fallbackVariant || "").trim().toUpperCase();
  const variant = rawVariant || (/^(?:AMD|COR)$/.test(suppliedVariant) ? suppliedVariant : "");
  const firstLine = ["TAF", variant, station, header[3]?.toUpperCase(), header[4]].filter(Boolean);
  const lines = [firstLine];
  let currentLine = firstLine;
  const bodyTokens = flattened.slice(header[0].length).trim().split(/\s+/).filter(Boolean);

  for (const token of bodyTokens) {
    const upper = token.toUpperCase();
    const startsTemperatureLine = /^TXM?\d{2}\/\d{4}Z$/.test(upper)
      || (/^TNM?\d{2}\/\d{4}Z$/.test(upper) && !/^TXM?\d{2}\/\d{4}Z$/.test(String(currentLine[0] || "").toUpperCase()));
    const startsGroup = /^(?:FM\d{6}|TEMPO|BECMG|PROB\d{2})$/.test(upper) || startsTemperatureLine;
    const nestedProbabilityTempo = upper === "TEMPO"
      && /^PROB\d{2}$/.test(String(currentLine[0] || "").toUpperCase())
      && currentLine.length === 1;
    if (startsGroup && !nestedProbabilityTempo) {
      currentLine = [];
      lines.push(currentLine);
    }
    currentLine.push(token);
  }

  return lines
    .filter((line) => line.length)
    .map((line, index) => `${index ? "    " : ""}${line.join(" ")}`)
    .join("\n")
    .replace(/\s+=\s*$/, "=");
}

function parseTafWindow(token, anchor, notBefore = null) {
  const match = String(token || "").toUpperCase().match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/);
  if (!match) return null;
  const start = resolveDayTime(Number(match[1]), Number(match[2]), 0, anchor, { notBefore });
  if (!start) return null;
  const end = resolveDayTime(Number(match[3]), Number(match[4]), 0, start, {
    notBefore: new Date(start.getTime() + 60 * 1000),
  });
  return end ? { start, end } : null;
}

function tafPeriodLabels(start, end, station) {
  if (!start && !end) return { utc: "", local: "" };
  const utc = end ? `${formatUtcDateTime(start)} through ${formatUtcDateTime(end)}` : formatUtcDateTime(start);
  const local = end
    ? `${formatStationLocalTime(start, station)} through ${formatStationLocalTime(end, station)}`
    : formatStationLocalTime(start, station);
  return { utc, local };
}

function parseTafTemperatureToken(token, issueTime, validityStart, station) {
  const match = String(token || "").toUpperCase().match(/^(TX|TN)(M?\d{2})\/(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const value = signedTemperature(match[2]);
  const timestamp = resolveDayTime(
    Number(match[3]), Number(match[4]), 0, issueTime,
    { notBefore: validityStart ? new Date(validityStart.getTime() - 60 * 60 * 1000) : null },
  );
  return {
    type: match[1] === "TX" ? "Maximum temperature" : "Minimum temperature",
    valueC: value,
    timestampUtc: timestamp ? timestamp.toISOString() : "",
    timestampLabel: timestamp ? formatUtcDateTime(timestamp) : `${match[3]}${match[4]}Z`,
    localLabel: timestamp ? formatStationLocalTime(timestamp, station) : "LOCAL TIME UNAVAILABLE",
    raw: String(token),
  };
}

export function decodeTafReport(value, options = {}) {
  const input = reportInput(value, options);
  const flat = normalizedRaw(input.raw).replace(/=$/, " =").trim();
  const header = flat.match(/^(?:TAF\s+)?(?:(AMD|COR)\s+)?([A-Z]{4})\s+(?:(\d{6}Z)\s+)?(\d{4}\/\d{4})\b/i);
  if (!header) {
    return {
      product: "TAF", station: input.station, variant: input.variant,
      title: `TAF${input.station ? ` — ${input.station}` : ""}`, raw: input.raw,
      lines: [], sections: [], blocks: [], temperatures: [], undecoded: flat ? [flat] : [],
    };
  }

  const station = normalizeIcao(header[2]);
  const variant = String(header[1] || input.variant || "").toUpperCase();
  const issueParts = header[3]?.match(/^(\d{2})(\d{2})(\d{2})Z$/);
  const issueTime = input.timestamp || (issueParts ? resolveDayTime(
    Number(issueParts[1]), Number(issueParts[2]), Number(issueParts[3]), input.referenceTime,
  ) : null);
  const validity = parseTafWindow(
    header[4],
    issueTime || input.referenceTime,
    issueTime ? new Date(issueTime.getTime() - 12 * 60 * 60 * 1000) : null,
  );
  const tokens = flat.slice(header[0].length).trim().split(/\s+/).filter((token) => token && token !== "=");
  const blocks = [];
  const temperatures = [];
  let current = {
    type: "INITIAL",
    sourceToken: "INITIAL",
    start: validity?.start || null,
    end: validity?.end || null,
    tokens: [],
  };

  const finishCurrent = () => {
    const conditions = decodeConditionTokens(current.tokens);
    const labels = tafPeriodLabels(current.start, current.end, station);
    blocks.push({
      type: current.type,
      sourceToken: current.sourceToken,
      startUtc: current.start ? current.start.toISOString() : "",
      endUtc: current.end ? current.end.toISOString() : "",
      utcLabel: labels.utc,
      localLabel: labels.local,
      conditions,
      undecoded: conditions.undecoded,
    });
  };

  const trimLastPrevailingBlockAt = (nextStart) => {
    if (!nextStart) return;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (!["INITIAL", "FROM"].includes(block.type)) continue;
      const blockStart = asDate(block.startUtc);
      const blockEnd = asDate(block.endUtc);
      if (!blockStart || nextStart <= blockStart || (blockEnd && nextStart >= blockEnd)) return;
      const labels = tafPeriodLabels(blockStart, nextStart, station);
      block.endUtc = nextStart.toISOString();
      block.utcLabel = labels.utc;
      block.localLabel = labels.local;
      return;
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const original = tokens[index];
    const token = original.toUpperCase();
    const temperature = parseTafTemperatureToken(original, issueTime || input.referenceTime, validity?.start, station);
    if (temperature) {
      temperatures.push(temperature);
      continue;
    }
    const fm = token.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    if (fm) {
      const start = resolveDayTime(
        Number(fm[1]), Number(fm[2]), Number(fm[3]),
        validity?.start || issueTime || input.referenceTime,
        { notBefore: validity?.start || issueTime },
      );
      finishCurrent();
      trimLastPrevailingBlockAt(start);
      current = { type: "FROM", sourceToken: token, start, end: validity?.end || null, tokens: [] };
      continue;
    }
    if (["BECMG", "TEMPO"].includes(token)) {
      const window = parseTafWindow(tokens[index + 1], validity?.start || issueTime || input.referenceTime, validity?.start);
      if (window) {
        finishCurrent();
        current = {
          type: token === "BECMG" ? "BECOMING" : "TEMPORARY",
          sourceToken: `${token} ${tokens[index + 1]}`,
          start: window.start,
          end: window.end,
          tokens: [],
        };
        index += 1;
        continue;
      }
    }
    if (/^PROB(?:30|40)$/.test(token)) {
      const hasTempo = String(tokens[index + 1] || "").toUpperCase() === "TEMPO";
      const windowIndex = index + (hasTempo ? 2 : 1);
      const window = parseTafWindow(tokens[windowIndex], validity?.start || issueTime || input.referenceTime, validity?.start);
      if (window) {
        finishCurrent();
        current = {
          type: hasTempo ? `${token} TEMPORARY` : token,
          sourceToken: [token, hasTempo ? "TEMPO" : "", tokens[windowIndex]].filter(Boolean).join(" "),
          start: window.start,
          end: window.end,
          tokens: [],
        };
        index = windowIndex;
        continue;
      }
    }
    current.tokens.push(original);
  }
  finishCurrent();

  const validityLabels = validity ? tafPeriodLabels(validity.start, validity.end, station) : { utc: header[4], local: "LOCAL TIME UNAVAILABLE" };
  const reportLines = [
    { label: "Issued", value: issueTime ? formatUtcDateTime(issueTime) : header[3] || "ISSUE TIME UNAVAILABLE" },
    { label: "Station Local", value: issueTime ? formatStationLocalTime(issueTime, station) : "LOCAL TIME UNAVAILABLE" },
    { label: "Valid", value: validityLabels.utc },
    { label: "Valid Local", value: validityLabels.local },
  ];
  const sections = [{ heading: "Report", lines: reportLines }];
  for (const block of blocks) {
    const blockLines = [{ label: "UTC", value: block.utcLabel || block.sourceToken }];
    if (block.localLabel) blockLines.push({ label: "Station Local", value: block.localLabel });
    appendConditionLines(blockLines, block.conditions);
    sections.push({ heading: block.type, lines: blockLines });
  }
  const temperatureLines = [];
  for (const temperature of temperatures) {
    temperatureLines.push({
      label: temperature.type,
      value: `${temperature.valueC}°C at ${temperature.timestampLabel}; ${temperature.localLabel}`,
    });
  }
  if (temperatureLines.length) sections.push({ heading: "Temperatures", lines: temperatureLines });
  const lines = sections.flatMap((section) => section.lines);

  return {
    product: "TAF",
    station,
    variant,
    title: `TAF${variant ? ` ${variant}` : ""} — ${station}`,
    raw: input.raw,
    issuanceUtc: issueTime ? issueTime.toISOString() : "",
    issuanceLocal: issueTime ? formatStationLocalTime(issueTime, station) : "LOCAL TIME UNAVAILABLE",
    timeZone: resolveStationTimeZone(station),
    validity: validity ? {
      startUtc: validity.start.toISOString(),
      endUtc: validity.end.toISOString(),
      utcLabel: validityLabels.utc,
      localLabel: validityLabels.local,
    } : null,
    blocks,
    temperatures,
    lines,
    sections,
    undecoded: blocks.flatMap((block) => block.undecoded),
  };
}

export function parseTafTextProduct(product, requestedStation, metadata = {}) {
  const station = normalizeIcao(requestedStation);
  const text = String(
    typeof product === "string"
      ? product
      : product?.productText || product?.rawTAF || product?.rawText || product?.raw || "",
  ).replace(/\r\n?/g, "\n");
  if (!text || !isValidIcao(station)) return null;

  const marker = new RegExp(
    `(?:\\bTAF(?:\\s+(?:AMD|COR))?\\s+)?${escapeRegExp(station)}\\s+(?:\\d{6}Z\\s+)?\\d{4}\\/\\d{4}\\b`,
    "i",
  );
  const match = marker.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index);
  const end = tail.indexOf("=");
  const raw = (end >= 0 ? tail.slice(0, end + 1) : tail).trim();
  if (!new RegExp(`\\b${escapeRegExp(station)}\\s+(?:\\d{6}Z\\s+)?\\d{4}\\/\\d{4}\\b`, "i").test(raw)) return null;
  const rawVariant = normalizedRaw(raw).match(/^TAF\s+(AMD|COR)\s+/i)?.[1]?.toUpperCase() || "";
  const suppliedVariant = String(metadata?.variant || "").toUpperCase();
  const variant = rawVariant
    || (metadata?.is_amendment ? "AMD" : "")
    || (/^(?:AMD|COR)$/.test(suppliedVariant) ? suppliedVariant : "");
  const rawHeader = normalizedRaw(raw).match(new RegExp(
    `\\b${escapeRegExp(station)}\\s+(?:(\\d{6})Z\\s+)?(\\d{4}\\/\\d{4})\\b`,
    "i",
  ));
  const headerTime = rawHeader?.[1];
  const timestamp = asDate(
    metadata?.issuanceTime
      || product?.issuanceTime
      || product?.issueTime
      || product?.bulletinTime
      || product?.reportTime,
  ) || (headerTime ? resolveDayTime(
    Number(headerTime.slice(0, 2)),
    Number(headerTime.slice(2, 4)),
    Number(headerTime.slice(4, 6)),
    metadata?.referenceTime || metadata?.now || new Date(),
  ) : null);
  if (!timestamp) return null;
  const validity = parseTafWindow(
    rawHeader?.[2],
    timestamp,
    new Date(timestamp.getTime() - 12 * 60 * 60 * 1000),
  );
  if (!validity) return null;

  return {
    product: "TAF",
    station,
    timestamp: timestamp.toISOString(),
    validTimeFrom: validity.start.toISOString(),
    validTimeTo: validity.end.toISOString(),
    raw,
    displayText: normalizeTafDisplay(raw, station, variant),
    source: String(metadata?.source || product?.source || "TAF text product"),
    variant,
  };
}

export function parseNwsTafProduct(product, indexItem, requestedStation) {
  return parseTafTextProduct(product, requestedStation, {
    issuanceTime: indexItem?.issuanceTime || product?.issuanceTime,
    is_amendment: indexItem?.is_amendment,
    source: "Iowa Environmental Mesonet / NWS text archive",
  });
}

function resolveAtisTime(timeValue, anchorValue, now = new Date()) {
  const match = String(timeValue || "").match(/\b(\d{2})(\d{2})(?:Z)?\b/);
  const anchor = asDate(anchorValue) || asDate(now);
  const nowDate = asDate(now);
  if (!match || !anchor || !nowDate) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  const candidates = [-1, 0, 1].map((dayOffset) => new Date(Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate() + dayOffset,
    hour,
    minute,
  ))).filter((candidate) => candidate.getTime() <= nowDate.getTime() + 15 * 60 * 1000);
  candidates.sort((a, b) => Math.abs(anchor.getTime() - a.getTime()) - Math.abs(anchor.getTime() - b.getTime()));
  return candidates[0] || null;
}

export function parseAtisInfoResponse(payload, requestedStation, now = new Date()) {
  const station = normalizeIcao(requestedStation);
  const entries = Array.isArray(payload) ? payload : payload && typeof payload === "object" ? [payload] : [];
  const reports = [];

  for (const entry of entries) {
    if (normalizeIcao(entry?.airport) !== station) continue;
    const raw = String(entry?.datis || entry?.atis || entry?.text || "").trim();
    const letter = String(entry?.code || "").trim().toUpperCase();
    const headerTime = String(entry?.time || raw.match(/\b(\d{4})Z\b/)?.[1] || "");
    const timestamp = resolveAtisTime(headerTime, entry?.updatedAt, now);
    const ageMinutes = timestamp ? (asDate(now).getTime() - timestamp.getTime()) / 60000 : Number.POSITIVE_INFINITY;
    if (!timestamp || ageMinutes < -15 || ageMinutes > ATIS_CURRENT_LIMIT_MINUTES) continue;
    if (!/^[A-Z]$/.test(letter) || raw.length < 30 || !/\b(?:ATIS|INFO(?:RMATION)?)\b/i.test(raw)) continue;
    reports.push({
      product: "ATIS",
      station,
      timestamp: timestamp.toISOString(),
      letter,
      variant: String(entry?.type || "combined").trim().toUpperCase(),
      raw,
      source: "ATIS.info",
    });
  }
  return dedupeReports(reports);
}

function normalizedArchiveVariant(value, inferred = "") {
  const variant = String(inferred || value || "").trim().toUpperCase();
  if (["ARR", "ARRIVAL", "ARRIVALS"].includes(variant)) return "ARR";
  if (["DEP", "DEPARTURE", "DEPARTURES"].includes(variant)) return "DEP";
  if (["", "ATIS", "BOTH", "COMBINED", "COMBINATION"].includes(variant)) return "COMBINED";
  return "OTHER";
}

function archivedAtisHeader(raw, station) {
  const alias = /^K[A-Z]{3}$/.test(station) ? station.slice(1) : station;
  const stationPattern = [...new Set([station, alias])].map(escapeRegExp).join("|");
  const match = normalizedRaw(raw).match(new RegExp(
    `\\b(?:${stationPattern})\\s+(?:(ARR(?:IVAL)?|DEP(?:ARTURE)?)\\s+)?ATIS\\s+INFO(?:RMATION)?\\s+([A-Z])\\D{0,12}(\\d{4})Z\\b`,
    "i",
  ));
  if (!match) return null;
  return {
    variant: match[1] ? normalizedArchiveVariant("", match[1]) : "",
    letter: match[2].toUpperCase(),
    time: match[3],
  };
}

function archivedAtisBodyUsable(raw, letter) {
  const text = normalizedRaw(raw).toUpperCase();
  const handoffLetters = [...text.matchAll(/\bADVS?\s+YOU\s+HAVE\s+(?:INFO|INFORMATION)\s+([A-Z])\b/g)];
  if (handoffLetters.length && handoffLetters.at(-1)[1] !== letter) return false;
  const weatherSignals = [
    /\b(?:\d{3}|VRB)\d{2}(?:G\d{2})?KT\b/,
    /\b(?:P?\d+(?:\s+\d+\/\d+)?|\d+\/\d+)SM\b/,
    /\bA\d{4}\b/,
    /\b(?:SKC|CLR|FEW|SCT|BKN|OVC|VV)\d{3}\b/,
    /\bM?\d{2}\/M?\d{2}\b/,
  ].filter((pattern) => pattern.test(text)).length;
  const hasOperations = /\b(?:APCH|APPROACH|LANDING|DEPARTING|DEPG|RWY|RY)\b/.test(text);
  return weatherSignals >= 2 || (weatherSignals >= 1 && hasOperations);
}

export function parseAtisHistoryPayload(payload, requestedStation) {
  const station = normalizeIcao(requestedStation);
  const archiveStarted = asDate(payload?.archiveStartedZ);
  if (
    station !== "KMEM"
    || Number(payload?.schemaVersion) !== ATIS_HISTORY_SCHEMA_VERSION
    || normalizeIcao(payload?.station) !== station
    || !archiveStarted
    || !Array.isArray(payload?.records)
  ) {
    return { valid: false, archiveStartedZ: "", reports: [] };
  }

  const reports = [];
  for (const record of payload.records) {
    const raw = String(record?.raw || "").trim();
    const timestamp = asDate(record?.observedZ);
    const letter = String(record?.letter || "").trim().toUpperCase();
    const header = archivedAtisHeader(raw, station);
    if (
      normalizeIcao(record?.station) !== station
      || !timestamp
      || raw.length < 40
      || !/^[A-Z]$/.test(letter)
      || !header
      || header.letter !== letter
      || header.time !== timestamp.toISOString().slice(11, 16).replace(":", "")
      || !archivedAtisBodyUsable(raw, letter)
    ) continue;

    reports.push({
      product: "ATIS",
      station,
      timestamp: timestamp.toISOString(),
      letter,
      letterName: ATIS_PHONETIC[letter] || letter,
      variant: normalizedArchiveVariant(record?.variant, header.variant),
      raw,
      source: "KMEM local D-ATIS archive",
    });
  }

  return {
    valid: true,
    archiveStartedZ: archiveStarted.toISOString(),
    reports: dedupeReports(reports),
  };
}

function reportFromOperationalMetar(data, station) {
  const raw = String(data?.metar || "").trim();
  const timestamp = asDate(data?.metarObservedZ);
  if (!timestamp || metarStation(raw) !== station) return null;
  return {
    product: metarProduct(raw),
    station,
    timestamp: timestamp.toISOString(),
    raw,
    source: "KMEM operational feed",
  };
}

function iemStationIdentifier(icao) {
  return /^K[A-Z]{3}$/.test(icao) ? icao.slice(1) : icao;
}

export function buildIemMetarUrl(station, hours, now = new Date()) {
  const nowDate = asDate(now);
  const lookbackHours = Math.max(1, Math.min(96, Number(hours) || 6));
  const start = new Date(nowDate.getTime() - (lookbackHours * 60 * 60 * 1000));
  const end = new Date(nowDate.getTime() + 60 * 1000);
  const url = new URL(IEM_METAR_URL);
  url.searchParams.set("station", iemStationIdentifier(normalizeIcao(station)));
  url.searchParams.set("data", "metar");
  url.searchParams.set("sts", start.toISOString());
  url.searchParams.set("ets", end.toISOString());
  url.searchParams.set("tz", "Etc/UTC");
  url.searchParams.set("format", "onlycomma");
  url.searchParams.set("latlon", "no");
  url.searchParams.set("elev", "no");
  url.searchParams.set("missing", "empty");
  url.searchParams.set("trace", "empty");
  url.searchParams.set("direct", "no");
  url.searchParams.append("report_type", "3");
  url.searchParams.append("report_type", "4");
  return url.toString();
}

async function fetchText(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal,
    headers: { Accept: "text/plain,text/csv,*/*" },
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || "ERROR"}`);
  return response.text();
}

async function fetchJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/ld+json,application/geo+json,application/json" },
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || "ERROR"}`);
  return response.json();
}

function operationalWeatherUrl(baseUrl, now) {
  const url = new URL("./weather.json", baseUrl);
  url.searchParams.set("lookup", String(asDate(now).getTime()));
  return url.toString();
}

function atisHistoryUrl(baseUrl, now) {
  const url = new URL("./atis_history.json", baseUrl);
  url.searchParams.set("lookup", String(asDate(now).getTime()));
  return url.toString();
}

function archiveAvailabilityDetail(archiveStartedZ) {
  const date = asDate(archiveStartedZ);
  if (!date) return "LOCAL D-ATIS ARCHIVE";
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getUTCMonth()];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
  return `LOCAL D-ATIS ARCHIVE — AVAILABLE SINCE ${day} ${month} ${date.getUTCFullYear()} ${time}`;
}

async function fetchMetarCandidates({ station, hours, now, fetchImpl, baseUrl, signal }) {
  const tasks = [
    fetchText(fetchImpl, buildIemMetarUrl(station, hours, now), signal)
      .then((text) => parseIemMetarCsv(text, station)),
  ];

  if (station === "KMEM") {
    tasks.push(
      fetchJson(fetchImpl, operationalWeatherUrl(baseUrl, now), signal)
        .then((data) => {
          const report = reportFromOperationalMetar(data, station);
          return report ? [report] : [];
        }),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const reports = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  const failures = settled.filter((item) => item.status === "rejected").length;
  if (!reports.length && failures === settled.length) throw new Error("All METAR sources failed");
  return { reports, failures };
}

async function fetchTafCandidates({ station, hours, now, fetchImpl, signal }) {
  const nowDate = asDate(now);
  const queryHours = hours === null ? 48 : 96;
  const indexUrl = new URL("/api/1/nws/taf_overview.json", IEM_API_URL);
  indexUrl.searchParams.set("station", station);
  indexUrl.searchParams.set("sts", new Date(nowDate.getTime() - queryHours * 60 * 60 * 1000).toISOString());
  indexUrl.searchParams.set("ets", new Date(nowDate.getTime() + 60 * 1000).toISOString());
  const index = await fetchJson(fetchImpl, indexUrl, signal);
  const entries = Array.isArray(index?.data) ? index.data : [];
  const seenProducts = new Set();
  const candidates = entries
    .filter((item) => normalizeIcao(item?.station) === station)
    .filter((item) => {
      const identity = String(item?.product_id || item?.text_href || "");
      if (!identity || seenProducts.has(identity)) return false;
      seenProducts.add(identity);
      return true;
    })
    .map((item) => ({ ...item, issuanceTime: item.utc_issued, parsedTime: asDate(item.utc_issued) }))
    .filter((item) => item.parsedTime && item.parsedTime.getTime() <= nowDate.getTime())
    .sort((a, b) => b.parsedTime.getTime() - a.parsedTime.getTime());

  const filtered = hours === null
    ? candidates
    : candidates.filter((item) => item.parsedTime.getTime() >= nowDate.getTime() - hours * 60 * 60 * 1000);
  const selected = filtered;
  if (!selected.length) return { reports: [], failures: 0, historyAvailable: candidates.length > 0 };

  const reports = [];
  let failures = 0;
  let attempted = 0;
  for (let indexOffset = 0; indexOffset < selected.length; indexOffset += 6) {
    const batch = selected.slice(indexOffset, indexOffset + 6);
    const batchResults = await Promise.allSettled(batch.map(async (item) => {
      const detailUrl = new URL(String(item.text_href || ""), IEM_API_URL).toString();
      const detail = await fetchText(fetchImpl, detailUrl, signal);
      return parseNwsTafProduct(detail, item, station);
    }));
    attempted += batchResults.length;
    failures += batchResults.filter((item) => item.status === "rejected").length;
    reports.push(...batchResults.flatMap((item) => item.status === "fulfilled" && item.value ? [item.value] : []));
    if (hours === null && reports.length) break;
  }
  if (!reports.length && failures === attempted) throw new Error("All TAF detail requests failed");
  return { reports, failures, historyAvailable: candidates.length > 0 };
}

function normalizeCurrentTafProviderReports(payload, station, now) {
  const hasEnvelope = payload && typeof payload === "object" && !Array.isArray(payload) && "reports" in payload;
  if (hasEnvelope && (
    Number(payload.schemaVersion) !== TAF_CURRENT_SCHEMA_VERSION
    || payload.sourcePolicy !== TAF_CURRENT_SOURCE_POLICY
    || !Array.isArray(payload.reports)
  )) {
    throw new Error("Current TAF snapshot schema is not supported");
  }
  const values = Array.isArray(payload) ? payload : hasEnvelope ? payload.reports : payload ? [payload] : [];
  const nowDate = asDate(now);
  let invalidRecords = 0;
  const reports = values.flatMap((candidate) => {
    const candidateStation = normalizeIcao(candidate?.station);
    if (candidateStation && candidateStation !== station) return [];
    const issueTime = asDate(candidate?.issueTime || candidate?.timestamp || candidate?.issuanceTime);
    const validFrom = asDate(candidate?.validTimeFrom);
    const validTo = asDate(candidate?.validTimeTo);
    if (!candidateStation || !issueTime || !validFrom || !validTo || !nowDate || validTo <= validFrom || issueTime > validTo) {
      invalidRecords += 1;
      return [];
    }
    if (issueTime > nowDate || validTo <= nowDate) return [];
    const parsed = parseTafTextProduct(candidate, station, {
      issuanceTime: issueTime,
      variant: candidate?.variant,
      source: candidate?.source || "NOAA AWC current snapshot",
      referenceTime: now,
    });
    if (!parsed) {
      invalidRecords += 1;
      return [];
    }
    if (
      asDate(parsed.validTimeFrom)?.getTime() !== validFrom.getTime()
      || asDate(parsed.validTimeTo)?.getTime() !== validTo.getTime()
    ) {
      invalidRecords += 1;
      return [];
    }
    const headerIssue = normalizedRaw(parsed.raw).match(new RegExp(`\\b${escapeRegExp(station)}\\s+(\\d{6})Z\\b`, "i"))?.[1];
    const expectedIssue = `${issueTime.toISOString().slice(8, 10)}${issueTime.toISOString().slice(11, 16).replace(":", "")}`;
    if (headerIssue && headerIssue !== expectedIssue) {
      invalidRecords += 1;
      return [];
    }
    return [{
      ...parsed,
      validTimeFrom: validFrom.toISOString(),
      validTimeTo: validTo.toISOString(),
      currentTafProvider: true,
    }];
  });
  return { reports, failures: invalidRecords ? 1 : 0 };
}

function currentTafReportActive(report, now) {
  const nowDate = asDate(now);
  const issued = asDate(report?.timestamp);
  const validFrom = asDate(report?.validTimeFrom);
  const validTo = asDate(report?.validTimeTo);
  return Boolean(
    nowDate
    && issued
    && validFrom
    && validTo
    && issued <= nowDate
    && validFrom < validTo
    && issued <= validTo
    && validTo > nowDate
  );
}

async function fetchCurrentTafCandidates(args, currentTafProvider) {
  const tasks = [
    fetchTafCandidates({ ...args, hours: null })
      .then((value) => ({
        kind: "IEM",
        ...value,
        reports: value.reports.filter((report) => currentTafReportActive(report, args.now)),
      })),
  ];
  if (typeof currentTafProvider === "function") {
    tasks.push(Promise.resolve().then(async () => {
      const payload = await currentTafProvider({
        station: args.station,
        now: args.now,
        signal: args.signal,
        parseTafTextProduct,
      });
      return { kind: "CURRENT", ...normalizeCurrentTafProviderReports(payload, args.station, args.now) };
    }));
  }

  const settled = await Promise.allSettled(tasks);
  if (settled.every((item) => item.status === "rejected")) throw new Error("All current TAF sources failed");
  const fulfilled = settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []);
  return {
    reports: fulfilled.flatMap((item) => item.reports || []),
    failures: settled.filter((item) => item.status === "rejected").length
      + fulfilled.reduce((total, item) => total + Number(item.failures || 0), 0),
    historyAvailable: fulfilled.find((item) => item.kind === "IEM")?.historyAvailable === true,
  };
}

async function fetchKmemAtis({ station, now, fetchImpl, baseUrl, signal }) {
  if (station !== "KMEM") {
    const response = await fetchImpl(`${ATIS_INFO_URL}/${encodeURIComponent(station)}`, {
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" },
    });
    if (response?.status === 404) {
      return {
        reports: [],
        unavailable: true,
        notParticipating: true,
        detail: `No participating current D-ATIS source returned a broadcast for ${station}.`,
      };
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status || "ERROR"}`);
    const payload = await response.json();
    const reports = parseAtisInfoResponse(payload, station, now);
    return reports.length
      ? { reports }
      : {
        reports: [],
        unavailable: true,
        notParticipating: true,
        detail: `No participating current D-ATIS source returned a broadcast for ${station}.`,
      };
  }
  const data = await fetchJson(fetchImpl, operationalWeatherUrl(baseUrl, now), signal);
  const raw = String(data?.atisText || "").trim();
  const timestamp = asDate(data?.atisObservedZ);
  const letter = String(data?.atisLetter || "").trim().toUpperCase();
  const ageMinutes = timestamp ? (asDate(now).getTime() - timestamp.getTime()) / 60000 : Number.POSITIVE_INFINITY;
  if (
    !raw ||
    !timestamp ||
    ageMinutes < -15 ||
    ageMinutes > ATIS_CURRENT_LIMIT_MINUTES ||
    data?.atisSourceIsCurrent !== true ||
    !/^[A-Z]$/.test(letter)
  ) {
    return {
      reports: [],
      unavailable: true,
      detail: "The operational KMEM ATIS is unavailable or suppressed by its existing freshness gate.",
    };
  }
  return {
    reports: [{
      product: "ATIS",
      station,
      timestamp: timestamp.toISOString(),
      letter,
      raw,
      source: String(data.atisSelectedSource || "KMEM operational feed"),
    }],
  };
}

function result(state, headline, detail = "", reports = [], extra = {}) {
  return { state, headline, detail, reports, ...extra };
}

export async function lookupAviationWeather({
  station: stationValue = "KMEM",
  product: productValue = "ATIS",
  range: rangeValue = "recent",
  now = new Date(),
  fetchImpl = fetch,
  currentTafProvider = null,
  baseUrl = "http://localhost/",
  signal,
} = {}) {
  const station = normalizeIcao(stationValue);
  const product = String(productValue || "").trim().toUpperCase();
  const hours = rangeHours(rangeValue);
  const nowDate = asDate(now);

  if (!isValidIcao(station)) return result("invalid", "INVALID ICAO", "Enter a four-letter ICAO identifier.");
  if (!nowDate || hours === undefined || !["ATIS", "METAR", "TAF"].includes(product)) {
    return result("error", "SOURCE UNAVAILABLE", "The lookup request is not valid.");
  }

  try {
    if (product === "ATIS") {
      if (hours !== null) {
        if (station !== "KMEM") {
          return result(
            "unsupported",
            "HISTORICAL ATIS UNAVAILABLE",
            "The configured reliable browser-accessible ATIS sources do not provide a genuine broadcast archive for this airport.",
          );
        }
        let archive;
        try {
          const payload = await fetchJson(fetchImpl, atisHistoryUrl(baseUrl, nowDate), signal);
          archive = parseAtisHistoryPayload(payload, station);
        } catch (_error) {
          return result(
            "unsupported",
            "HISTORICAL ATIS UNAVAILABLE",
            "The local KMEM D-ATIS archive could not be loaded.",
          );
        }
        if (!archive.valid) {
          return result(
            "unsupported",
            "HISTORICAL ATIS UNAVAILABLE",
            "The local KMEM D-ATIS archive is missing or malformed.",
          );
        }
        const reports = filterAndSortReports(archive.reports, hours, nowDate);
        const availability = archiveAvailabilityDetail(archive.archiveStartedZ);
        return reports.length
          ? result("success", "", availability, reports)
          : result(
            "empty",
            "NO REPORTS FOUND",
            `${availability}. Only reports genuinely observed after that time can appear; this does not imply that no earlier broadcasts existed.`,
          );
      }
      const response = await fetchKmemAtis({ station, now: nowDate, fetchImpl, baseUrl, signal });
      if (response.notParticipating) {
        return result("unsupported", `ATIS NOT AVAILABLE FOR ${station}`, response.detail);
      }
      if (response.unavailable) return result("unavailable", "SOURCE UNAVAILABLE", response.detail);
      const reports = filterAndSortReports(response.reports, null, nowDate);
      return reports.length
        ? result("success", "", "", reports)
        : result("empty", "NO REPORTS FOUND", "No valid current ATIS report was returned.");
    }

    if (product === "METAR") {
      const response = await fetchMetarCandidates({
        station,
        hours: hours === null ? 6 : hours,
        now: nowDate,
        fetchImpl,
        baseUrl,
        signal,
      });
      let reports = filterAndSortReports(response.reports, hours, nowDate);
      if (hours === null) reports = reports.slice(0, 1);
      const detail = response.failures
        ? "One METAR source was unavailable; showing valid reports from the remaining source."
        : "";
      return reports.length
        ? result("success", "", detail, reports, { partialFailures: response.failures })
        : result("empty", "NO REPORTS FOUND", "No valid METAR reports matched the selected UTC window.");
    }

    const response = hours === null
      ? await fetchCurrentTafCandidates({ station, now: nowDate, fetchImpl, signal }, currentTafProvider)
      : await fetchTafCandidates({ station, hours, now: nowDate, fetchImpl, signal });
    let reports = filterAndSortReports(response.reports, hours, nowDate);
    if (hours === null) reports = reports.slice(0, 1);
    const detail = response.failures
      ? "One issued-TAF record was unavailable; valid records from the remaining requests are shown."
      : "";
    if (reports.length) {
      return result("success", "", detail, reports, {
        partialFailures: response.failures,
        usedCurrentFallback: hours === null && reports[0]?.currentTafProvider === true,
      });
    }
    if (hours !== null && response.historyAvailable === false) {
      return result(
        "unsupported",
        "TAF HISTORY UNAVAILABLE FOR THIS STATION",
        "The configured archive returned no genuine previous TAF issuances for this airport. Current TAF availability is independent.",
      );
    }
    return result("empty", "NO REPORTS FOUND", "No valid issued TAF products matched the selected UTC window.");
  } catch (error) {
    if (error?.name === "AbortError") return result("error", "SOURCE UNAVAILABLE", "The lookup request was cancelled or timed out.");
    return result("error", "SOURCE UNAVAILABLE", "The selected provider could not be reached. The Ops Board remains unchanged.");
  }
}
