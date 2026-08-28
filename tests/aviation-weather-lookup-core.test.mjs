import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOOKUP_RANGES,
  buildIemMetarUrl,
  decodeMetarReport,
  decodeTafReport,
  dedupeReports,
  filterAndSortReports,
  formatStationLocalTime,
  isValidIcao,
  lookupAviationWeather,
  normalizeTafDisplay,
  normalizeIcao,
  parseAtisInfoResponse,
  parseAtisHistoryPayload,
  parseIemMetarCsv,
  parseNwsTafProduct,
  parseTafTextProduct,
  rangeHours,
  resolveStationTimeZone,
} from "../aviation-weather-lookup-core.js";

const NOW = new Date("2026-08-27T12:00:00Z");
const fixtureUrl = (name) => new URL(`./fixtures/aviation-weather/${name}`, import.meta.url);
const metarCsv = readFileSync(fixtureUrl("iem-metar.csv"), "utf8");
const interleavedMetarCsv = readFileSync(fixtureUrl("iem-metar-interleaved.csv"), "utf8");
const tafIndex = JSON.parse(readFileSync(fixtureUrl("iem-taf-index.json"), "utf8"));
const tafDetails = JSON.parse(readFileSync(fixtureUrl("iem-taf-details.json"), "utf8"));
const tafDisplayProducts = JSON.parse(readFileSync(fixtureUrl("taf-display-products.json"), "utf8"));
const kvokTaf = JSON.parse(readFileSync(fixtureUrl("kvok-taf.json"), "utf8"));
const atisInfo = JSON.parse(readFileSync(fixtureUrl("atis-info.json"), "utf8"));
const currentTafSnapshot = (reports) => ({
  schemaVersion: 1,
  sourcePolicy: "NOAA_AWC_COMPLETE_CURRENT_CACHE",
  reports,
});
const kvokCurrentTafRecord = (overrides = {}) => ({
  station: "KVOK",
  issueTime: kvokTaf.issuanceTime,
  validTimeFrom: "2026-08-27T17:00:00Z",
  validTimeTo: "2026-08-28T23:00:00Z",
  variant: "",
  raw: kvokTaf.raw,
  ...overrides,
});
const atisHistory = {
  schemaVersion: 1,
  station: "KMEM",
  retentionHours: 96,
  archiveStartedZ: "2026-08-26T09:05:00Z",
  records: [
    {
      station: "KMEM",
      observedZ: "2026-08-27T11:30:00Z",
      letter: "C",
      variant: "COMBINED",
      raw: "MEM ATIS INFO C 1130Z. 22008KT 10SM SCT050 A2998. VISUAL APCH RY 27. ADVS YOU HAVE INFO C.",
    },
    {
      station: "KMEM",
      observedZ: "2026-08-27T10:30:00Z",
      letter: "B",
      variant: "ARR",
      raw: "MEM ARR ATIS INFO B 1030Z. 21007KT 10SM SCT060 A2999. LANDING RY 27. ADVS YOU HAVE INFO B.",
    },
    {
      station: "KMEM",
      observedZ: "2026-08-27T10:30:00Z",
      letter: "O",
      variant: "DEP",
      raw: "MEM DEP ATIS INFO O 1030Z. 21007KT 10SM SCT060 A2999. DEPG RY 27. ADVS YOU HAVE INFO O.",
    },
  ],
};

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
    async text() { return JSON.stringify(value); },
  };
}

function textResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(value); },
    async text() { return value; },
  };
}

test("ICAO input is trimmed, uppercased, and validated", () => {
  assert.equal(normalizeIcao("  kmem \n"), "KMEM");
  assert.equal(isValidIcao("kmem"), true);
  assert.equal(isValidIcao("MEM"), false);
  assert.equal(isValidIcao("K1EM"), false);
  assert.equal(isValidIcao("K MEM"), false);
  for (const station of ["KMEM", "KVOK", "KJFK", "EGLL", "LROP"]) {
    assert.equal(normalizeIcao(`  ${station.toLowerCase()}  `), station);
    assert.equal(isValidIcao(station), true);
  }
});

test("station timezone resolution uses exact overrides and conservative country-prefix coverage", () => {
  assert.equal(resolveStationTimeZone("KMEM"), "America/Chicago");
  assert.equal(resolveStationTimeZone("KVOK"), "America/Chicago");
  assert.equal(resolveStationTimeZone("KJFK"), "America/New_York");
  assert.equal(resolveStationTimeZone("EGLL"), "Europe/London");
  assert.equal(resolveStationTimeZone("LROP"), "Europe/Bucharest");
  assert.equal(resolveStationTimeZone("LFPG"), "Europe/Paris");
  assert.equal(resolveStationTimeZone("ZZZZ"), null);
});

test("station-local formatting handles DST, standard time, and the prior local calendar date", () => {
  assert.equal(formatStationLocalTime("2026-08-28T00:55:00Z", "KVOK"), "27 AUG 2026 1955L");
  assert.equal(formatStationLocalTime("2026-01-28T00:55:00Z", "KJFK"), "27 JAN 2026 1955L");
  assert.equal(formatStationLocalTime("2026-08-28T00:55:00Z", "KJFK"), "27 AUG 2026 2055L");
  assert.equal(formatStationLocalTime("2026-01-15T12:00:00Z", "EGLL"), "15 JAN 2026 1200L");
  assert.equal(formatStationLocalTime("2026-08-15T12:00:00Z", "EGLL"), "15 AUG 2026 1300L");
  assert.equal(formatStationLocalTime("2026-01-15T12:00:00Z", "LROP"), "15 JAN 2026 1400L");
  assert.equal(formatStationLocalTime("2026-08-15T12:00:00Z", "LROP"), "15 AUG 2026 1500L");
  assert.equal(formatStationLocalTime("2026-08-15T12:00:00Z", "ZZZZ"), "LOCAL TIME UNAVAILABLE");
});

test("all requested time ranges map to the intended UTC windows", () => {
  assert.deepEqual(
    LOOKUP_RANGES.map(({ label }) => label),
    [
      "Most recent",
      "Past 1 hour",
      "Past 2 hours",
      "Past 3 hours",
      "Past 6 hours",
      "Past 12 hours",
      "Past 24 hours",
      "Past 48 hours",
      "Past 96 hours",
    ],
  );
  assert.equal(rangeHours("recent"), null);
  assert.equal(rangeHours("96"), 96);
  assert.equal(rangeHours("bogus"), undefined);
});

test("IEM METAR request uses one UTC archive query with routine and special reports", () => {
  const url = new URL(buildIemMetarUrl("KMEM", 96, NOW));
  assert.equal(url.hostname, "mesonet.agron.iastate.edu");
  assert.equal(url.searchParams.get("station"), "MEM");
  assert.equal(url.searchParams.get("tz"), "Etc/UTC");
  assert.equal(url.searchParams.get("sts"), "2026-08-23T12:00:00.000Z");
  assert.equal(url.searchParams.get("ets"), "2026-08-27T12:01:00.000Z");
  assert.deepEqual(url.searchParams.getAll("report_type"), ["3", "4"]);

  assert.equal(new URL(buildIemMetarUrl("KVOK", 6, NOW)).searchParams.get("station"), "VOK");
  assert.equal(new URL(buildIemMetarUrl("egll", 6, NOW)).searchParams.get("station"), "EGLL");
  assert.equal(new URL(buildIemMetarUrl(" LROP ", 6, NOW)).searchParams.get("station"), "LROP");
});

test("METAR parsing accepts arbitrary four-letter ICAOs without a K-prefix assumption", () => {
  const csv = [
    "station,valid,metar",
    "EGLL,2026-08-27 11:50,EGLL 271150Z 26008KT 9999 FEW030 19/12 Q1017",
    "LROP,2026-08-27 11:30,LROP 271130Z 09006KT CAVOK 27/14 Q1013",
  ].join("\n");
  const egll = parseIemMetarCsv(csv, "egll");
  const lrop = parseIemMetarCsv(csv, "LROP");
  assert.equal(egll.length, 1);
  assert.equal(egll[0].station, "EGLL");
  assert.equal(lrop.length, 1);
  assert.equal(lrop[0].station, "LROP");
});

test("IEM raw METAR rows use UTC observation time and ignore malformed records", () => {
  const reports = parseIemMetarCsv(metarCsv, "KMEM");
  assert.equal(reports.length, 6);
  assert.equal(reports.at(-1).timestamp, "2026-08-27T11:54:00.000Z");
  assert.equal(reports[0].product, "METAR");
  assert.equal(reports.at(-1).product, "SPECI");
  assert.match(reports.at(-1).raw, /^SPECI KMEM 271154Z/);
  assert.ok(reports.every((report) => report.station === "KMEM"));
});

test("routine METARs and SPECIs retain raw text, explicit labels, and interleaved UTC order", () => {
  const parsed = parseIemMetarCsv(interleavedMetarCsv, "KMEM");
  assert.deepEqual(parsed.map((report) => report.product), ["METAR", "SPECI", "METAR"]);
  assert.match(parsed[1].raw, /^SPECI KMEM 271120Z/);

  const reports = filterAndSortReports(parsed, 3, NOW);
  assert.deepEqual(
    reports.map((report) => [report.product, report.timestamp]),
    [
      ["METAR", "2026-08-27T11:54:00.000Z"],
      ["SPECI", "2026-08-27T11:20:00.000Z"],
      ["METAR", "2026-08-27T10:54:00.000Z"],
    ],
  );
  assert.equal(reports.length, 3);
  assert.equal(reports[1].raw, "SPECI KMEM 271120Z 23012G20KT 4SM TSRA BKN030CB 29/20 A2996 RMK AO2");
});

test("provider-independent METAR dedupe ignores only the optional METAR prefix", () => {
  const timestamp = "2026-08-27T11:54:00Z";
  const body = "KMEM 271154Z 23008KT 10SM SCT050 30/19 A2996 RMK AO2";
  const reports = dedupeReports([
    { product: "METAR", station: "KMEM", timestamp, raw: `METAR ${body}`, source: "provider one" },
    { product: "METAR", station: "KMEM", timestamp, raw: body, source: "provider two" },
    { product: "SPECI", station: "KMEM", timestamp, raw: `SPECI ${body}`, source: "special provider" },
  ]);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((report) => report.product), ["METAR", "SPECI"]);
  assert.equal(reports[0].raw, `METAR ${body}`);
});

test("METAR decoder preserves raw data and decodes the KVOK calm-wind regression deterministically", () => {
  const raw = "METAR KVOK 280055Z AUTO 00000KT 10SM CLR 20/15 A3000 RMK AO2 SLP160 T02000152 $";
  const decoded = decodeMetarReport({
    product: "METAR",
    station: "KVOK",
    timestamp: "2026-08-28T00:55:00Z",
    raw,
  });
  assert.equal(decoded.raw, raw);
  assert.equal(decoded.title, "METAR — KVOK");
  assert.equal(decoded.observationUtc, "2026-08-28T00:55:00.000Z");
  assert.equal(decoded.observationLocal, "27 AUG 2026 1955L");
  assert.equal(decoded.conditions.winds[0], "Calm");
  assert.equal(decoded.conditions.visibility[0], "10 statute miles");
  assert.equal(decoded.conditions.sky[0], "Clear below reporting threshold");
  assert.deepEqual(decoded.conditions.pressure[0], { label: "Altimeter", value: "30.00 inHg" });
  assert.equal(decoded.temperatureC, 20);
  assert.equal(decoded.dewPointC, 15);
  assert.match(decoded.remarks.find((item) => item.code === "AO2").meaning, /precipitation discriminator/i);
  assert.equal(decoded.remarks.find((item) => item.code === "SLP160").meaning, "Sea-level pressure 1016.0 hPa");
  assert.match(decoded.remarks.find((item) => item.code === "T02000152").meaning, /20\.0°C \/ dew point 15\.2°C/);
  assert.equal(decoded.remarks.find((item) => item.code === "$").meaning, "Maintenance indicator");
  assert.deepEqual(decoded.undecoded, []);
  assert.ok(decoded.sections.every((section) => Array.isArray(section.lines)));
});

test("SPECI decoder tolerates mixed recognized and unknown groups without guessing", () => {
  const raw = "SPECI KJFK 271730Z 18012G22KT 140V220 1 1/2SM R04/2400FT VCTS +TSRA BKN020CB OVC080 M02/M05 Q1013 RMK AO1 PK WND 18030/1720 WSHFT 1715 PRESFR VIS 2 NE MYSTERY";
  const decoded = decodeMetarReport(raw, { referenceTime: "2026-08-27T18:00:00Z" });
  assert.equal(decoded.product, "SPECI");
  assert.equal(decoded.station, "KJFK");
  assert.match(decoded.conditions.winds[0], /180° true at 12 kt, gusting 22 kt/);
  assert.match(decoded.conditions.winds[1], /140° to 220°/);
  assert.equal(decoded.conditions.visibility[0], "1 1/2 statute miles");
  assert.match(decoded.conditions.rvr[0], /Runway 04: 2400 ft/);
  assert.ok(decoded.conditions.weather.some((value) => /vicinity.*thunderstorm/i.test(value)));
  assert.ok(decoded.conditions.weather.some((value) => /Heavy thunderstorm rain/i.test(value)));
  assert.match(decoded.conditions.sky[0], /Broken at 2000 ft; cumulonimbus/);
  assert.equal(decoded.temperatureC, -2);
  assert.equal(decoded.dewPointC, -5);
  assert.deepEqual(decoded.conditions.pressure[0], { label: "QNH", value: "1013 hPa" });
  assert.ok(decoded.remarks.some((item) => item.code === "PK WND 18030/1720"));
  assert.ok(decoded.remarks.some((item) => item.code === "WSHFT 1715"));
  assert.ok(decoded.remarks.some((item) => item.code === "PRESFR"));
  assert.ok(decoded.remarks.some((item) => item.code === "VIS 2 NE"));
  assert.deepEqual(decoded.undecoded, ["MYSTERY"]);
  assert.equal(decoded.raw, raw);
});

test("historical filtering is inclusive, newest-first, and enforces the 96-hour cutoff", () => {
  const reports = parseIemMetarCsv(metarCsv, "KMEM");
  const threeHours = filterAndSortReports(reports, 3, NOW);
  assert.deepEqual(
    threeHours.map((report) => report.timestamp),
    ["2026-08-27T11:54:00.000Z", "2026-08-27T10:54:00.000Z", "2026-08-27T09:00:00.000Z"],
  );
  const ninetySixHours = filterAndSortReports(reports, 96, NOW);
  assert.ok(ninetySixHours.some((report) => report.timestamp === "2026-08-23T12:00:00.000Z"));
  assert.ok(!ninetySixHours.some((report) => report.timestamp === "2026-08-23T11:59:00.000Z"));
  assert.equal(ninetySixHours.filter((report) => report.timestamp === "2026-08-27T11:54:00.000Z").length, 1);
  assert.ok(ninetySixHours.some((report) => report.product === "METAR"));
  assert.ok(ninetySixHours.some((report) => report.product === "SPECI"));
});

test("malformed and future report timestamps cannot displace valid reports", () => {
  const reports = filterAndSortReports([
    { product: "METAR", station: "KMEM", timestamp: "bad", raw: "BAD" },
    { product: "METAR", station: "KMEM", timestamp: "2026-08-27T12:01:00Z", raw: "FUTURE" },
    { product: "METAR", station: "KMEM", timestamp: "2026-08-27T11:54:00Z", raw: "VALID" },
  ], 1, NOW);
  assert.deepEqual(reports.map((report) => report.raw), ["VALID"]);
});

test("ATIS duplicates are removed without collapsing distinct arrival and departure broadcasts", () => {
  const reports = parseAtisInfoResponse(atisInfo, "KATL", NOW);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.map((report) => report.variant).sort(), ["ARR", "DEP"]);
  assert.deepEqual(reports.map((report) => report.letter).sort(), ["B", "O"]);
  assert.equal(dedupeReports([...reports, ...reports]).length, 2);
});

test("ATIS time resolution handles UTC midnight rollover and rejects stale broadcasts", () => {
  const payload = [{
    airport: "KATL",
    type: "combined",
    code: "A",
    datis: "ATL ATIS INFO A 2355Z. 18005KT 10SM CLR A3001. ADVS YOU HAVE INFO A.",
    time: "2355",
    updatedAt: "2026-08-28T00:03:00Z",
  }];
  assert.equal(parseAtisInfoResponse(payload, "KATL", new Date("2026-08-28T00:05:00Z"))[0].timestamp, "2026-08-27T23:55:00.000Z");
  assert.equal(parseAtisInfoResponse(payload, "KATL", new Date("2026-08-28T01:10:00Z")).length, 0);
});

test("TAF parsing uses actual issuance time rather than forecast valid time", () => {
  const item = tafIndex.data.find((entry) => entry.product_id === "taf-newest-valid");
  const report = parseNwsTafProduct(tafDetails[item.text_href], { ...item, issuanceTime: item.utc_issued }, "KMEM");
  assert.equal(report.timestamp, "2026-08-27T11:30:00.000Z");
  assert.equal(report.variant, "AMD");
  assert.match(report.raw, /TAF AMD\s+KMEM 271130Z/);
});

test("TAF display copies canonicalize normal, AMD, and COR headers without changing raw source", () => {
  const cases = [
    {
      name: "normal",
      variant: "",
      expected: [
        "TAF KMEM 272329Z 2800/2906 36008KT P6SM FEW060 BKN250",
        "    FM280100 05004KT P6SM SCT250",
        "    TEMPO 2812/2814 3SM TSRA BKN025CB",
        "    PROB30 TEMPO 2814/2816 1SM +TSRA OVC015CB=",
      ].join("\n"),
    },
    {
      name: "amendment",
      variant: "AMD",
      expected: [
        "TAF AMD KMEM 272052Z 2721/2824 36008KT P6SM SCT080",
        "    FM280000 05004KT P6SM SCT250",
        "    BECMG 2814/2816 02008KT P6SM FEW060=",
      ].join("\n"),
    },
    {
      name: "correction",
      variant: "COR",
      expected: [
        "TAF COR KMEM 272100Z 2721/2824 01006KT P6SM SCT060",
        "    PROB40 2808/2812 2SM TSRA BKN020CB=",
      ].join("\n"),
    },
  ];

  for (const item of cases) {
    const source = tafDisplayProducts[item.name];
    const report = parseNwsTafProduct(
      source,
      { issuanceTime: "2026-08-27T11:30:00Z", is_amendment: item.variant === "AMD" },
      "KMEM",
    );
    assert.ok(report, `${item.name} TAF should parse`);
    assert.equal(report.raw, source, `${item.name} raw source should remain intact`);
    assert.equal(report.displayText, item.expected);
    assert.equal(report.variant, item.variant);
    assert.equal(normalizeTafDisplay(report.raw, "KMEM", report.variant), item.expected);
    assert.ok(report.displayText.endsWith("="), `${item.name} display should retain its terminator`);
  }
});

test("KVOK military-style TAF parses generically, formats cleanly, and preserves every coded construct", () => {
  const report = parseTafTextProduct(kvokTaf.bulletin, " kvok ", {
    issuanceTime: kvokTaf.issuanceTime,
    source: "Deterministic KVOK fixture",
  });
  assert.ok(report);
  assert.equal(report.station, "KVOK");
  assert.equal(report.timestamp, "2026-08-27T17:00:00.000Z");
  assert.equal(report.raw, kvokTaf.raw);
  assert.equal(report.source, "Deterministic KVOK fixture");
  assert.deepEqual(report.displayText.split("\n"), [
    "TAF KVOK 271700Z 2717/2823 VRB06KT 9999 FEW030 QNH3001INS",
    "    BECMG 2800/2801 VRB06KT 9999 BKN060 QNH3000INS",
    "    TX23/2719Z TN12/2811Z",
  ]);
  for (const token of [
    "VRB06KT", "9999", "FEW030", "QNH3001INS", "BECMG 2800/2801",
    "BKN060", "QNH3000INS", "TX23/2719Z", "TN12/2811Z",
  ]) assert.match(report.raw, new RegExp(token.replace("/", "\\/")));
  assert.equal(
    parseTafTextProduct("TAF KVOK 271700Z VRB06KT 9999 FEW030", "KVOK", { issuanceTime: kvokTaf.issuanceTime }),
    null,
    "a header without an overall validity period is not a usable TAF",
  );
});

test("official military validity-only TAF headers use authoritative metadata issue time", async () => {
  const raw = "TAF AMD KNIP 2717/2823 18010KT 9999 FEW030 QNH3001INS BECMG 2800/2801 20008KT 9999 BKN060 QNH3000INS TX28/2719Z TN18/2811Z";
  const issueTime = "2026-08-27T17:00:00Z";
  const report = parseTafTextProduct(raw, "KNIP", { issuanceTime: issueTime, source: "Military fixture" });
  assert.ok(report);
  assert.equal(report.timestamp, "2026-08-27T17:00:00.000Z");
  assert.equal(report.validTimeFrom, "2026-08-27T17:00:00.000Z");
  assert.equal(report.validTimeTo, "2026-08-28T23:00:00.000Z");
  assert.equal(report.variant, "AMD");
  assert.equal(report.raw, raw);
  assert.deepEqual(report.displayText.split("\n"), [
    "TAF AMD KNIP 2717/2823 18010KT 9999 FEW030 QNH3001INS",
    "    BECMG 2800/2801 20008KT 9999 BKN060 QNH3000INS",
    "    TX28/2719Z TN18/2811Z",
  ]);
  const decoded = decodeTafReport(report);
  assert.equal(decoded.issuanceUtc, "2026-08-27T17:00:00.000Z");
  assert.equal(decoded.validity.endUtc, "2026-08-28T23:00:00.000Z");

  const current = await lookupAviationWeather({
    station: "KNIP",
    product: "TAF",
    range: "recent",
    now: new Date("2026-08-27T18:00:00Z"),
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async () => currentTafSnapshot([{
      station: "KNIP",
      issueTime,
      validTimeFrom: "2026-08-27T17:00:00Z",
      validTimeTo: "2026-08-28T23:00:00Z",
      variant: "AMD",
      raw,
    }]),
  });
  assert.equal(current.state, "success");
  assert.equal(current.reports[0].station, "KNIP");
  assert.equal(current.reports[0].variant, "AMD");
});

test("TAF decoder produces chronological blocks, station-local equivalents, temperatures, and unknown groups", () => {
  const raw = `${kvokTaf.raw} MYSTERY`;
  const decoded = decodeTafReport({
    station: "KVOK",
    timestamp: kvokTaf.issuanceTime,
    raw,
  });
  assert.equal(decoded.raw, raw);
  assert.equal(decoded.title, "TAF — KVOK");
  assert.equal(decoded.issuanceUtc, "2026-08-27T17:00:00.000Z");
  assert.equal(decoded.issuanceLocal, "27 AUG 2026 1200L");
  assert.deepEqual(decoded.validity, {
    startUtc: "2026-08-27T17:00:00.000Z",
    endUtc: "2026-08-28T23:00:00.000Z",
    utcLabel: "27 AUG 2026 1700Z through 28 AUG 2026 2300Z",
    localLabel: "27 AUG 2026 1200L through 28 AUG 2026 1800L",
  });
  assert.deepEqual(decoded.blocks.map((block) => block.type), ["INITIAL", "BECOMING"]);
  assert.equal(decoded.blocks[0].conditions.winds[0], "Variable at 6 kt");
  assert.equal(decoded.blocks[0].conditions.visibility[0], "10 km or greater");
  assert.equal(decoded.blocks[0].conditions.sky[0], "Few at 3000 ft");
  assert.deepEqual(decoded.blocks[0].conditions.pressure[0], { label: "QNH", value: "30.01 inHg" });
  assert.equal(decoded.blocks[1].sourceToken, "BECMG 2800/2801");
  assert.equal(decoded.blocks[1].startUtc, "2026-08-28T00:00:00.000Z");
  assert.equal(decoded.blocks[1].endUtc, "2026-08-28T01:00:00.000Z");
  assert.match(decoded.blocks[1].localLabel, /27 AUG 2026 1900L through 27 AUG 2026 2000L/);
  assert.deepEqual(decoded.temperatures.map((item) => [item.type, item.valueC, item.timestampUtc]), [
    ["Maximum temperature", 23, "2026-08-27T19:00:00.000Z"],
    ["Minimum temperature", 12, "2026-08-28T11:00:00.000Z"],
  ]);
  assert.deepEqual(decoded.undecoded, ["MYSTERY"]);
  assert.ok(decoded.sections.some((section) => section.heading === "BECOMING"));
});

test("TAF decoder recognizes FM, TEMPO, PROB30/40, AMD, and COR without altering raw", () => {
  const amd = tafDisplayProducts.amendment;
  const amdDecoded = decodeTafReport(amd, { referenceTime: "2026-08-27T21:00:00Z" });
  assert.equal(amdDecoded.variant, "AMD");
  assert.ok(amdDecoded.blocks.some((block) => block.type === "FROM"));
  assert.ok(amdDecoded.blocks.some((block) => block.type === "BECOMING"));
  assert.equal(amdDecoded.blocks.find((block) => block.type === "INITIAL").endUtc, "2026-08-28T00:00:00.000Z");
  assert.equal(amdDecoded.raw, amd);

  const normal = tafDisplayProducts.normal;
  const normalDecoded = decodeTafReport(normal, { referenceTime: "2026-08-27T23:30:00Z" });
  assert.ok(normalDecoded.blocks.some((block) => block.type === "TEMPORARY"));
  assert.ok(normalDecoded.blocks.some((block) => block.type === "PROB30 TEMPORARY"));
  assert.equal(normalDecoded.blocks.find((block) => block.type === "INITIAL").endUtc, "2026-08-28T01:00:00.000Z");
  assert.equal(normalDecoded.raw, normal);

  const cor = tafDisplayProducts.correction;
  const corDecoded = decodeTafReport(cor, { referenceTime: "2026-08-27T21:00:00Z" });
  assert.equal(corDecoded.variant, "COR");
  assert.ok(corDecoded.blocks.some((block) => block.type === "PROB40"));
  assert.equal(corDecoded.raw, cor);

  const multipleFm = "TAF KMEM 272300Z 2800/2906 36008KT P6SM SCT060 FM280100 05004KT P6SM SCT250 FM281600 02008KT P6SM FEW060=";
  const multipleDecoded = decodeTafReport(multipleFm, { referenceTime: "2026-08-27T23:05:00Z" });
  const prevailing = multipleDecoded.blocks.filter((block) => ["INITIAL", "FROM"].includes(block.type));
  assert.deepEqual(prevailing.map((block) => block.endUtc), [
    "2026-08-28T01:00:00.000Z",
    "2026-08-28T16:00:00.000Z",
    "2026-08-29T06:00:00.000Z",
  ]);
});

test("invalid ICAO and non-KMEM historical ATIS return truthful states without requesting a provider", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not run"); };
  const invalid = await lookupAviationWeather({ station: "MEM", product: "METAR", fetchImpl, now: NOW });
  const history = await lookupAviationWeather({ station: "KATL", product: "ATIS", range: "96", fetchImpl, now: NOW });
  assert.equal(invalid.headline, "INVALID ICAO");
  assert.equal(history.headline, "HISTORICAL ATIS UNAVAILABLE");
  assert.equal(calls, 0);
});

test("KMEM historical ATIS parses valid archive records and preserves distinct ARR and DEP reports", () => {
  const payload = structuredClone(atisHistory);
  payload.records.push({
    station: "KMEM",
    observedZ: "2026-08-27T11:45:00Z",
    letter: "D",
    variant: "COMBINED",
    raw: "MEM ATIS INFO D 1145Z. CORRUPT ARCHIVED BODY WITHOUT USABLE WEATHER DATA. ADVS YOU HAVE INFO D.",
  });
  const parsed = parseAtisHistoryPayload(payload, "KMEM");
  assert.equal(parsed.valid, true);
  assert.equal(parsed.archiveStartedZ, "2026-08-26T09:05:00.000Z");
  assert.equal(parsed.reports.length, 3);
  assert.deepEqual(parsed.reports.map((report) => report.letterName), ["CHARLIE", "BRAVO", "OSCAR"]);
  assert.deepEqual(parsed.reports.slice(1).map((report) => report.variant), ["ARR", "DEP"]);
  assert.ok(parsed.reports.every((report) => report.source === "KMEM local D-ATIS archive"));
});

test("KMEM historical ATIS is newest-first and discloses the truthful partial archive start", async () => {
  const calls = [];
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    range: "2",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return jsonResponse(atisHistory);
    },
  });
  assert.equal(response.state, "success");
  assert.deepEqual(response.reports.map((report) => report.timestamp), [
    "2026-08-27T11:30:00.000Z",
    "2026-08-27T10:30:00.000Z",
    "2026-08-27T10:30:00.000Z",
  ]);
  assert.match(response.detail, /LOCAL D-ATIS ARCHIVE — AVAILABLE SINCE 26 AUG 2026 09:05Z/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /atis_history\.json\?lookup=/);
});

test("empty partial KMEM archive windows do not imply there were no earlier broadcasts", async () => {
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    range: "1",
    now: new Date("2026-08-27T12:31:00Z"),
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse(atisHistory),
  });
  assert.equal(response.state, "empty");
  assert.equal(response.headline, "NO REPORTS FOUND");
  assert.match(response.detail, /Only reports genuinely observed after that time can appear/);
  assert.match(response.detail, /does not imply that no earlier broadcasts existed/);
});

test("missing or malformed KMEM history remains truthfully unavailable", async () => {
  const malformed = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    range: "96",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse({ schemaVersion: 1, station: "KMEM", records: [] }),
  });
  assert.equal(malformed.state, "unsupported");
  assert.equal(malformed.headline, "HISTORICAL ATIS UNAVAILABLE");

  const missing = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    range: "96",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse({}, 404),
  });
  assert.equal(missing.state, "unsupported");
  assert.equal(missing.headline, "HISTORICAL ATIS UNAVAILABLE");
});

test("KMEM current ATIS reads the operational selection and honors its existing freshness flag", async () => {
  const currentData = {
    atisText: "MEM ATIS INFO C 1130Z. 22008KT 10SM SCT050 A2998. ADVS YOU HAVE INFO C.",
    atisObservedZ: "2026-08-27T11:30:00Z",
    atisLetter: "C",
    atisSourceIsCurrent: true,
    atisSelectedSource: "ATIS_INFO_API+ATIS_RELAY",
  };
  const current = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse(currentData),
  });
  assert.equal(current.state, "success");
  assert.equal(current.reports[0].letter, "C");

  const suppressed = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse({ ...currentData, atisSourceIsCurrent: false }),
  });
  assert.equal(suppressed.state, "unavailable");

  const stale = await lookupAviationWeather({
    station: "KMEM",
    product: "ATIS",
    now: new Date("2026-08-27T12:31:00Z"),
    baseUrl: "https://example.test/board/",
    fetchImpl: async () => jsonResponse(currentData),
  });
  assert.equal(stale.state, "unavailable");
});

test("non-KMEM current ATIS preserves same-time arrival and departure products", async () => {
  const response = await lookupAviationWeather({
    station: "KATL",
    product: "ATIS",
    now: NOW,
    fetchImpl: async () => jsonResponse(atisInfo),
  });
  assert.equal(response.state, "success");
  assert.equal(response.reports.length, 2);
});

test("a nonparticipating airport gets a clean ATIS-unavailable state rather than a provider error", async () => {
  for (const providerResponse of [jsonResponse([]), jsonResponse({ error: "No results found" }, 404)]) {
    const response = await lookupAviationWeather({
      station: "KVOK",
      product: "ATIS",
      now: NOW,
      fetchImpl: async () => providerResponse,
    });
    assert.equal(response.state, "unsupported");
    assert.equal(response.headline, "ATIS NOT AVAILABLE FOR KVOK");
    assert.match(response.detail, /No participating current D-ATIS source/);
  }

  const providerFailure = await lookupAviationWeather({
    station: "KVOK",
    product: "ATIS",
    now: NOW,
    fetchImpl: async () => jsonResponse({ error: "upstream failure" }, 503),
  });
  assert.equal(providerFailure.state, "error");
  assert.equal(providerFailure.headline, "SOURCE UNAVAILABLE");
});

test("one failed METAR provider is isolated when the KMEM operational feed is valid", async () => {
  const calls = [];
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "METAR",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("request/asos.py")) throw new Error("IEM timeout");
      return jsonResponse({
        metar: "KMEM 271154Z 23008G15KT 10SM BKN060 30/19 A2996 RMK AO2",
        metarObservedZ: "2026-08-27T11:54:00Z",
      });
    },
  });
  assert.equal(response.state, "success");
  assert.equal(response.partialFailures, 1);
  assert.equal(response.reports[0].product, "METAR");
  assert.equal(response.reports[0].source, "KMEM operational feed");
  assert.equal(calls.length, 2);
});

test("KMEM operational special observation is explicitly labeled SPECI", async () => {
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "METAR",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async (input) => {
      if (String(input).includes("request/asos.py")) throw new Error("IEM timeout");
      return jsonResponse({
        metar: "SPECI KMEM 271158Z 23012G20KT 4SM TSRA BKN030CB 29/20 A2996 RMK AO2",
        metarObservedZ: "2026-08-27T11:58:00Z",
      });
    },
  });
  assert.equal(response.state, "success");
  assert.equal(response.reports[0].product, "SPECI");
  assert.match(response.reports[0].raw, /^SPECI KMEM 271158Z/);
});

test("Most recent METAR selects the newest observation across archive and operational candidates", async () => {
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "METAR",
    range: "recent",
    now: NOW,
    baseUrl: "https://example.test/board/",
    fetchImpl: async (input) => String(input).includes("request/asos.py")
      ? textResponse(metarCsv)
      : jsonResponse({
        metar: "KMEM 271130Z 22008KT 10SM SCT050 29/18 A2998 RMK AO2",
        metarObservedZ: "2026-08-27T11:30:00Z",
      }),
  });
  assert.equal(response.state, "success");
  assert.equal(response.reports.length, 1);
  assert.equal(response.reports[0].timestamp, "2026-08-27T11:54:00.000Z");
  assert.equal(response.reports[0].product, "SPECI");
  assert.equal(response.reports[0].source, "Iowa Environmental Mesonet");
});

test("TAF history ignores malformed data, isolates a detail failure, and includes the 96-hour boundary", async () => {
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "TAF",
    range: "96",
    now: NOW,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("taf_overview.json")) return jsonResponse(tafIndex);
      if (url.pathname.endsWith("taf-provider-failure")) throw new Error("detail timeout");
      return textResponse(tafDetails[url.pathname] || "NOT A VALID TAF");
    },
  });
  assert.equal(response.state, "success");
  assert.equal(response.partialFailures, 1);
  assert.deepEqual(
    response.reports.map((report) => report.timestamp),
    ["2026-08-27T11:30:00.000Z", "2026-08-23T12:00:00.000Z"],
  );
});

test("current TAF fallback is independent of archive coverage while history reports truthful unavailability", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  let currentProviderCalls = 0;
  const current = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async ({ station }) => {
      currentProviderCalls += 1;
      assert.equal(station, "KVOK");
      return currentTafSnapshot([kvokCurrentTafRecord({
        source: "Injected current-only provider",
      })]);
    },
  });
  assert.equal(current.state, "success");
  assert.equal(current.usedCurrentFallback, true);
  assert.equal(current.reports[0].station, "KVOK");
  assert.equal(current.reports[0].raw, kvokTaf.raw);
  assert.equal(current.reports[0].source, "Injected current-only provider");
  assert.equal(currentProviderCalls, 1);

  const history = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "96",
    now,
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async () => {
      currentProviderCalls += 1;
      return [{ raw: kvokTaf.raw, timestamp: kvokTaf.issuanceTime }];
    },
  });
  assert.equal(history.state, "unsupported");
  assert.equal(history.headline, "TAF HISTORY UNAVAILABLE FOR THIS STATION");
  assert.match(history.detail, /Current TAF availability is independent/);
  assert.equal(currentProviderCalls, 1, "historical lookup must not call a current-only provider");
});

test("a current-only TAF provider remains usable when the archive provider times out", async () => {
  const response = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now: new Date("2026-08-27T18:00:00Z"),
    fetchImpl: async () => { throw new Error("IEM timeout"); },
    currentTafProvider: async () => kvokCurrentTafRecord({
      source: "Current-only provider",
    }),
  });
  assert.equal(response.state, "success");
  assert.equal(response.usedCurrentFallback, true);
  assert.equal(response.partialFailures, 1);
  assert.equal(response.reports[0].station, "KVOK");
});

test("Most Recent TAF checks IEM and the current snapshot concurrently and selects the freshest valid issuance", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  let releaseIem;
  let currentProviderCalls = 0;
  const providerStarted = new Promise((resolve) => { releaseIem = resolve; });
  const iemEntry = {
    station: "KVOK",
    product_id: "kvok-older-iem",
    utc_issued: "2026-08-27T16:00:00Z",
    text_href: "/api/1/nwstext/kvok-older-iem",
  };
  const response = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("taf_overview.json")) {
        await providerStarted;
        return jsonResponse({ data: [iemEntry] });
      }
      return textResponse("TAF KVOK 271600Z 2716/2822 VRB05KT 9999 FEW030 QNH3002INS");
    },
    currentTafProvider: async () => {
      currentProviderCalls += 1;
      releaseIem();
      return currentTafSnapshot([kvokCurrentTafRecord()]);
    },
  });
  assert.equal(currentProviderCalls, 1);
  assert.equal(response.state, "success");
  assert.equal(response.reports[0].timestamp, "2026-08-27T17:00:00.000Z");
  assert.equal(response.reports[0].source, "NOAA AWC current snapshot");
  assert.equal(response.usedCurrentFallback, true);
});

test("equal-time current TAF ties prefer COR over AMD over routine, then deterministic body order", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  const entry = {
    station: "KVOK",
    product_id: "kvok-equal-time",
    utc_issued: kvokTaf.issuanceTime,
    text_href: "/api/1/nwstext/kvok-equal-time",
  };
  const lookupWith = (iemRaw, snapshotRaw, snapshotVariant) => lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [entry] })
      : textResponse(iemRaw),
    currentTafProvider: async () => currentTafSnapshot([kvokCurrentTafRecord({
      variant: snapshotVariant,
      raw: snapshotRaw,
    })]),
  });

  const amendment = await lookupWith(
    "TAF KVOK 271700Z 2717/2823 VRB05KT 9999 FEW030 QNH3002INS=",
    "TAF AMD KVOK 271700Z 2717/2823 VRB06KT 9999 BKN040 QNH3001INS=",
    "AMD",
  );
  assert.equal(amendment.reports[0].variant, "AMD");
  assert.equal(amendment.usedCurrentFallback, true);

  const correction = await lookupWith(
    "TAF COR KVOK 271700Z 2717/2823 VRB07KT 9999 SCT030 QNH3000INS=",
    "TAF AMD KVOK 271700Z 2717/2823 VRB06KT 9999 BKN040 QNH3001INS=",
    "AMD",
  );
  assert.equal(correction.reports[0].variant, "COR");
  assert.equal(correction.usedCurrentFallback, false);

  const deterministicRoutineOrder = filterAndSortReports([
    { product: "TAF", station: "KVOK", timestamp: kvokTaf.issuanceTime, raw: "TAF KVOK 271700Z 2717/2823 VRB06KT 9999 SCT040" },
    { product: "TAF", station: "KVOK", timestamp: kvokTaf.issuanceTime, raw: "TAF KVOK 271700Z 2717/2823 VRB06KT 9999 BKN040" },
  ], null, now);
  assert.match(deterministicRoutineOrder[0].raw, /BKN040$/);
});

test("a newer IEM TAF beats an older snapshot while an equal provider copy dedupes", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  let currentProviderCalls = 0;
  const iemEntry = {
    station: "KVOK",
    product_id: "kvok-newer-iem",
    utc_issued: "2026-08-27T17:30:00Z",
    text_href: "/api/1/nwstext/kvok-newer-iem",
  };
  const response = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [iemEntry] })
      : textResponse("TAF KVOK 271730Z 2717/2823 VRB07KT 9999 SCT035 QNH3000INS="),
    currentTafProvider: async () => {
      currentProviderCalls += 1;
      return currentTafSnapshot([kvokCurrentTafRecord()]);
    },
  });
  assert.equal(currentProviderCalls, 1);
  assert.equal(response.reports[0].timestamp, "2026-08-27T17:30:00.000Z");
  assert.equal(response.usedCurrentFallback, false);

  const equalCopies = dedupeReports([
    { product: "TAF", station: "KVOK", timestamp: kvokTaf.issuanceTime, variant: "", raw: `${kvokTaf.raw}=` },
    { product: "TAF", station: "KVOK", timestamp: kvokTaf.issuanceTime, variant: "", raw: kvokTaf.raw },
  ]);
  assert.equal(equalCopies.length, 1);

  const equalEntry = {
    station: "KVOK",
    product_id: "kvok-equal-iem",
    utc_issued: kvokTaf.issuanceTime,
    text_href: "/api/1/nwstext/kvok-equal-iem",
  };
  let equalProviderCalls = 0;
  const equalResponse = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [equalEntry] })
      : textResponse(`${kvokTaf.bulletin}=`),
    currentTafProvider: async () => {
      equalProviderCalls += 1;
      return currentTafSnapshot([kvokCurrentTafRecord()]);
    },
  });
  assert.equal(equalProviderCalls, 1);
  assert.equal(equalResponse.state, "success");
  assert.equal(equalResponse.reports.length, 1);
  assert.equal(equalResponse.reports[0].source, "Iowa Environmental Mesonet / NWS text archive");
});

test("expired or malformed current TAF snapshots cannot displace a valid IEM report", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  const expired = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async () => currentTafSnapshot([kvokCurrentTafRecord({
      validTimeFrom: "2026-08-26T17:00:00Z",
      validTimeTo: "2026-08-27T17:59:00Z",
    })]),
  });
  assert.equal(expired.state, "empty");
  assert.equal(expired.headline, "NO REPORTS FOUND");

  const corruptEnvelope = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async () => currentTafSnapshot([kvokCurrentTafRecord({
      issueTime: "2026-08-26T17:00:00Z",
      validTimeFrom: "2026-08-26T17:00:00Z",
      validTimeTo: "2026-08-28T23:00:00Z",
      raw: "TAF KVOK 261700Z 2617/2717 VRB05KT 9999 FEW030 QNH3002INS=",
    })]),
  });
  assert.equal(corruptEnvelope.state, "empty");
  assert.equal(corruptEnvelope.reports.length, 0, "envelope dates cannot extend the raw TAF validity");

  const wrongStation = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async () => jsonResponse({ data: [] }),
    currentTafProvider: async () => currentTafSnapshot([kvokCurrentTafRecord({ station: "KJFK" })]),
  });
  assert.equal(wrongStation.state, "empty");
  assert.equal(wrongStation.reports.length, 0);

  const expiredIemEntry = {
    station: "KVOK",
    product_id: "kvok-expired-iem",
    utc_issued: "2026-08-26T17:00:00Z",
    text_href: "/api/1/nwstext/kvok-expired-iem",
  };
  const expiredIem = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [expiredIemEntry] })
      : textResponse("TAF KVOK 261700Z 2617/2717 VRB05KT 9999 FEW030 QNH3002INS="),
  });
  assert.equal(expiredIem.state, "empty");
  assert.equal(expiredIem.reports.length, 0);

  const iemEntry = {
    station: "KVOK",
    product_id: "kvok-valid-iem",
    utc_issued: kvokTaf.issuanceTime,
    text_href: "/api/1/nwstext/kvok-valid-iem",
  };
  const malformedSnapshot = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [iemEntry] })
      : textResponse(kvokTaf.bulletin),
    currentTafProvider: async () => ({ schemaVersion: 2, sourcePolicy: "WRONG", reports: [] }),
  });
  assert.equal(malformedSnapshot.state, "success");
  assert.equal(malformedSnapshot.partialFailures, 1);
  assert.equal(malformedSnapshot.reports[0].source, "Iowa Environmental Mesonet / NWS text archive");
});

test("current TAF source failures remain isolated in either direction", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  const iemEntry = {
    station: "KVOK",
    product_id: "kvok-valid-iem",
    utc_issued: kvokTaf.issuanceTime,
    text_href: "/api/1/nwstext/kvok-valid-iem",
  };
  const response = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "recent",
    now,
    fetchImpl: async (input) => new URL(String(input)).pathname.endsWith("taf_overview.json")
      ? jsonResponse({ data: [iemEntry] })
      : textResponse(kvokTaf.bulletin),
    currentTafProvider: async () => { throw new Error("snapshot unavailable"); },
  });
  assert.equal(response.state, "success");
  assert.equal(response.partialFailures, 1);
  assert.equal(response.reports[0].source, "Iowa Environmental Mesonet / NWS text archive");
});

test("a station with archive entries but none in the selected window remains an empty history result", async () => {
  const now = new Date("2026-08-27T18:00:00Z");
  let overviewUrl = null;
  const oldEntry = {
    station: "KVOK",
    product_id: "kvok-old",
    utc_issued: "2026-08-27T12:00:00Z",
    text_href: "/api/1/nwstext/kvok-old",
  };
  const response = await lookupAviationWeather({
    station: "KVOK",
    product: "TAF",
    range: "1",
    now,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("taf_overview.json")) {
        overviewUrl = url;
        return jsonResponse({ data: [oldEntry] });
      }
      return textResponse(kvokTaf.bulletin);
    },
  });
  assert.equal(response.state, "empty");
  assert.equal(response.headline, "NO REPORTS FOUND");
  assert.equal(
    now.getTime() - Date.parse(overviewUrl.searchParams.get("sts")),
    96 * 60 * 60 * 1000,
    "short history selections must inspect the full 96-hour archive before declaring coverage unavailable",
  );
});

test("Most recent TAF continues past a malformed first batch to the newest valid issuance", async () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({
    station: "KMEM",
    product_id: `taf-${index + 1}`,
    utc_issued: new Date(NOW.getTime() - (index + 1) * 60 * 1000).toISOString(),
    is_amendment: false,
    text_href: `/api/1/nwstext/taf-${index + 1}`,
  }));
  const response = await lookupAviationWeather({
    station: "KMEM",
    product: "TAF",
    range: "recent",
    now: NOW,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("taf_overview.json")) return jsonResponse({ data: entries });
      if (!url.pathname.endsWith("taf-7")) return textResponse("MALFORMED TAF BODY");
      return textResponse("FTUS44 KMEG 271153\nTAFMEM\nTAF\nKMEM 271153Z 2712/2818 22008KT P6SM SCT050=");
    },
  });
  assert.equal(response.state, "success");
  assert.equal(response.reports.length, 1);
  assert.equal(response.reports[0].timestamp, entries[6].utc_issued);
});

test("a provider outage produces an isolated lookup error state", async () => {
  const response = await lookupAviationWeather({
    station: "KJFK",
    product: "TAF",
    range: "24",
    now: NOW,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(response.state, "error");
  assert.equal(response.headline, "SOURCE UNAVAILABLE");
});
