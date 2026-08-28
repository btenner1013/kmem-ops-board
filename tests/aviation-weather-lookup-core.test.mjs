import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LOOKUP_RANGES,
  buildIemMetarUrl,
  dedupeReports,
  filterAndSortReports,
  isValidIcao,
  lookupAviationWeather,
  normalizeIcao,
  parseAtisInfoResponse,
  parseIemMetarCsv,
  parseNwsTafProduct,
  rangeHours,
} from "../aviation-weather-lookup-core.js";

const NOW = new Date("2026-08-27T12:00:00Z");
const fixtureUrl = (name) => new URL(`./fixtures/aviation-weather/${name}`, import.meta.url);
const metarCsv = readFileSync(fixtureUrl("iem-metar.csv"), "utf8");
const tafIndex = JSON.parse(readFileSync(fixtureUrl("iem-taf-index.json"), "utf8"));
const tafDetails = JSON.parse(readFileSync(fixtureUrl("iem-taf-details.json"), "utf8"));
const atisInfo = JSON.parse(readFileSync(fixtureUrl("atis-info.json"), "utf8"));

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
});

test("IEM raw METAR rows use UTC observation time and ignore malformed records", () => {
  const reports = parseIemMetarCsv(metarCsv, "KMEM");
  assert.equal(reports.length, 6);
  assert.equal(reports.at(-1).timestamp, "2026-08-27T11:54:00.000Z");
  assert.match(reports.at(-1).raw, /^SPECI KMEM 271154Z/);
  assert.ok(reports.every((report) => report.station === "KMEM"));
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

test("invalid ICAO and historical ATIS return truthful states without requesting a provider", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not run"); };
  const invalid = await lookupAviationWeather({ station: "MEM", product: "METAR", fetchImpl, now: NOW });
  const history = await lookupAviationWeather({ station: "KMEM", product: "ATIS", range: "96", fetchImpl, now: NOW });
  assert.equal(invalid.headline, "INVALID ICAO");
  assert.equal(history.headline, "HISTORICAL ATIS UNAVAILABLE");
  assert.equal(calls, 0);
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
  assert.equal(response.reports[0].source, "KMEM operational feed");
  assert.equal(calls.length, 2);
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
