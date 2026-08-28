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

export function rangeHours(value) {
  const match = LOOKUP_RANGES.find((item) => item.value === String(value));
  return match ? match.hours : undefined;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizedRaw(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function dedupeReports(reports) {
  const seen = new Set();
  const unique = [];

  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || typeof report !== "object") continue;
    const date = asDate(report.timestamp);
    const raw = normalizedRaw(report.raw);
    if (!date || !raw) continue;
    const key = [
      String(report.product || "").toUpperCase(),
      normalizeIcao(report.station),
      date.toISOString(),
      String(report.letter || "").toUpperCase(),
      String(report.variant || "").toUpperCase(),
      raw,
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
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
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
    `^(?:TAF\\s+)?(?:(AMD|COR)\\s+)?(${escapeRegExp(station)})\\s+(\\d{6}Z)\\s+(\\d{4}\\/\\d{4})(?=\\s|$)`,
    "i",
  ).exec(flattened);
  if (!header) return raw;

  const rawVariant = String(header[1] || "").toUpperCase();
  const suppliedVariant = String(fallbackVariant || "").trim().toUpperCase();
  const variant = rawVariant || (/^(?:AMD|COR)$/.test(suppliedVariant) ? suppliedVariant : "");
  const firstLine = ["TAF", variant, station, header[3].toUpperCase(), header[4]].filter(Boolean);
  const lines = [firstLine];
  let currentLine = firstLine;
  const bodyTokens = flattened.slice(header[0].length).trim().split(/\s+/).filter(Boolean);

  for (const token of bodyTokens) {
    const upper = token.toUpperCase();
    const startsGroup = /^(?:FM\d{6}|TEMPO|BECMG|PROB\d{2})$/.test(upper);
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

export function parseNwsTafProduct(product, indexItem, requestedStation) {
  const station = normalizeIcao(requestedStation);
  const text = String(typeof product === "string" ? product : product?.productText || "").replace(/\r\n?/g, "\n");
  const timestamp = asDate(indexItem?.issuanceTime || product?.issuanceTime);
  if (!timestamp || !text || !isValidIcao(station)) return null;

  const marker = new RegExp(
    `(?:\\bTAF(?:\\s+(?:AMD|COR))?\\s+)?${escapeRegExp(station)}\\s+\\d{6}Z\\b`,
    "i",
  );
  const match = marker.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index);
  const end = tail.indexOf("=");
  const raw = (end >= 0 ? tail.slice(0, end + 1) : tail).trim();
  if (!new RegExp(`\\b${escapeRegExp(station)}\\s+\\d{6}Z\\b`, "i").test(raw)) return null;
  const rawVariant = normalizedRaw(raw).match(/^TAF\s+(AMD|COR)\s+/i)?.[1]?.toUpperCase() || "";
  const variant = rawVariant || (indexItem?.is_amendment ? "AMD" : "");

  return {
    product: "TAF",
    station,
    timestamp: timestamp.toISOString(),
    raw,
    displayText: normalizeTafDisplay(raw, station, variant),
    source: "Iowa Environmental Mesonet / NWS text archive",
    variant,
  };
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
  const queryHours = hours === null ? 48 : hours;
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
  if (!selected.length) return { reports: [], failures: 0 };

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
  return { reports, failures };
}

async function fetchKmemAtis({ station, now, fetchImpl, baseUrl, signal }) {
  if (station !== "KMEM") {
    const payload = await fetchJson(fetchImpl, `${ATIS_INFO_URL}/${encodeURIComponent(station)}`, signal);
    const reports = parseAtisInfoResponse(payload, station, now);
    return reports.length
      ? { reports }
      : { reports: [], unavailable: true, detail: "No current browser-accessible D-ATIS was returned for this airport." };
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

    const response = await fetchTafCandidates({ station, hours, now: nowDate, fetchImpl, signal });
    let reports = filterAndSortReports(response.reports, hours, nowDate);
    if (hours === null) reports = reports.slice(0, 1);
    const detail = response.failures
      ? "One issued-TAF record was unavailable; valid records from the remaining requests are shown."
      : "";
    return reports.length
      ? result("success", "", detail, reports, { partialFailures: response.failures })
      : result("empty", "NO REPORTS FOUND", "No valid issued TAF products matched the selected UTC window.");
  } catch (error) {
    if (error?.name === "AbortError") return result("error", "SOURCE UNAVAILABLE", "The lookup request was cancelled or timed out.");
    return result("error", "SOURCE UNAVAILABLE", "The selected provider could not be reached. The Ops Board remains unchanged.");
  }
}
