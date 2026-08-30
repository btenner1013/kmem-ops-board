import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyBwcHistoryDialogState,
  availabilityLines,
  createBwcHistoryLoader,
  findTimelineSegmentAt,
  formatCurrentBwc,
  historyFailureArchiveMessage,
  updateLiveBwcAge,
} from "../bwc-history.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const historyCss = readFileSync(new URL("../bwc-history.css", import.meta.url), "utf8");
const historyJs = readFileSync(new URL("../bwc-history.js", import.meta.url), "utf8");

function liveStampFormatter() {
  const source = indexHtml.match(/function formatAhasBwcDateTime\(value\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "live BWC timestamp formatter must exist");
  return Function(`"use strict"; ${source}; return formatAhasBwcDateTime;`)();
}

test("the eagle quick link keeps the approved order and accessible name", () => {
  assert.match(indexHtml, /bwcHistory\.id="bwcHistoryButton"/);
  assert.match(indexHtml, /bwcHistory\.type="button"/);
  assert.match(indexHtml, /bwcHistory\.title="BWC History"/);
  assert.match(indexHtml, /setAttribute\("aria-label","BWC History"\)/);
  assert.match(indexHtml, /bwcHistory\.textContent="🦅"/u);
  assert.match(
    indexHtml,
    /appendChild\(hazard\);\s*wrap\.appendChild\(bwcHistory\);\s*wrap\.appendChild\(aviationWeather\);\s*wrap\.appendChild\(flightPlan\);\s*wrap\.appendChild\(display\)/,
  );
});

test("the BWC history panel exposes the agreed accessible modal contract", () => {
  assert.match(indexHtml, /id="bwcHistoryOverlay"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(indexHtml, /id="bwcHistoryPanel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="bwcHistoryTitle"/);
  assert.match(indexHtml, /id="bwcHistoryTitle"[^>]*>🦅 BWC HISTORY</u);
  assert.match(indexHtml, /USAHAS AHAS RISK — NOT OFFICIAL AIRFIELD BWC/);
  assert.match(indexHtml, /id="bwcHistoryCloseButton"[^>]*type="button"[^>]*aria-label="Close BWC History"/);
  for (const range of ["24h", "7d", "30d", "90d", "365d"]) {
    assert.match(indexHtml, new RegExp(`data-bwc-range="${range}"`));
  }
  for (const id of [
    "bwcHistoryStatus",
    "bwcHistoryChart",
    "bwcHistoryTooltip",
    "bwcHistoryCurrent",
    "bwcHistoryLastChange",
    "bwcHistoryStats",
    "bwcHistoryArchive",
    "bwcHistoryLegend",
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
});

test("dialog visibility opens, locks body scroll, closes, and restores focus", () => {
  const attributes = new Map();
  const toggles = [];
  let closeFocus = 0;
  let openerFocus = 0;
  const overlay = {
    hidden: true,
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const body = { classList: { toggle(name, value) { toggles.push([name, value]); } } };
  const focusTarget = { focus() { closeFocus += 1; } };
  const returnFocus = { focus() { openerFocus += 1; } };

  applyBwcHistoryDialogState({ overlay, body, focusTarget, returnFocus }, true);
  assert.equal(overlay.hidden, false);
  assert.equal(attributes.get("aria-hidden"), "false");
  assert.equal(closeFocus, 1);

  applyBwcHistoryDialogState({ overlay, body, focusTarget, returnFocus }, false);
  assert.equal(overlay.hidden, true);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(openerFocus, 1);
  assert.deepEqual(toggles, [["bwc-history-open", true], ["bwc-history-open", false]]);
});

test("history loader is lazy, validates once, and caches successful range reuse", async () => {
  let fetchCount = 0;
  let requestUrl = "";
  let requestOptions = null;
  const normalized = { schemaVersion: 1, station: "KMEM", runs: [] };
  const loader = createBwcHistoryLoader({
    baseUrl: "https://example.test/board/index.html",
    normalize: (payload) => payload.schemaVersion === 1
      ? { ok: true, value: normalized }
      : { ok: false, error: "unsupported" },
    fetchImpl: async (url, options) => {
      fetchCount += 1;
      requestUrl = url;
      requestOptions = options;
      return { ok: true, async json() { return { schemaVersion: 1, runs: [] }; } };
    },
  });

  assert.equal(fetchCount, 0, "creating the controller must not fetch history");
  const first = await loader.load();
  const second = await loader.load();
  assert.equal(first, normalized);
  assert.equal(second, normalized);
  assert.equal(fetchCount, 1, "all range views reuse the same page-session promise");
  assert.equal(new URL(requestUrl).pathname, "/board/bwc_history.json");
  assert.equal(requestOptions.cache, "no-store");
  assert.equal(requestOptions.headers.Accept, "application/json");
});

test("history loader caches an unavailable result and reports HTTP/schema failures", async () => {
  let fetchCount = 0;
  const loader = createBwcHistoryLoader({
    baseUrl: "https://example.test/",
    normalize: () => ({ ok: false, error: "Unsupported BWC history schema" }),
    fetchImpl: async () => {
      fetchCount += 1;
      return { ok: true, async json() { return { schemaVersion: 99 }; } };
    },
  });
  await assert.rejects(loader.load(), /Unsupported BWC history schema/);
  await assert.rejects(loader.load(), /Unsupported BWC history schema/);
  assert.equal(fetchCount, 1);

  const missing = createBwcHistoryLoader({
    fetchImpl: async () => ({ ok: false, status: 404 }),
    normalize: () => ({ ok: true, value: {} }),
  });
  await assert.rejects(missing.load(), /HTTP 404/);
  assert.match(historyFailureArchiveMessage(new Error("BWC history request failed: HTTP 404")), /Awaiting first valid live USAHAS result/);
  assert.equal(historyFailureArchiveMessage(new Error("network error")), "BWC HISTORY UNAVAILABLE");
});

test("CURRENT formatting uses only live weather data and marks last-known values", () => {
  const live = formatCurrentBwc({
    bwc: "SEVERE",
    bwcUpdatedZ: "2026-08-30 02:30:00.000",
    bwcBasedOn: "NEXRAD",
    lastKnownGoodUsed: { ahas: true },
  });
  assert.equal(live.state, "SEVERE");
  assert.equal(live.lastKnown, true);
  assert.match(live.heading, /CURRENT \(LAST KNOWN\)/);
  assert.match(live.detail, /NEXRAD/);

  const missing = formatCurrentBwc(null);
  assert.equal(missing.state, "PENDING");
  assert.equal(missing.heading, "CURRENT");
  assert.match(missing.detail, /LIVE BWC UNAVAILABLE/);
});

test("partial archive availability does not duplicate collected days or coverage", () => {
  const lines = availabilityLines({
    status: "PARTIAL",
    label: "BWC ARCHIVE",
    detail: "Available since 30 AUG 2026 0230Z · 1.0 days collected · 96.8% known coverage",
    collectedDays: 1,
    coveragePercent: 96.8,
  }, { runs: [{}] }, { coveragePercent: 96.8 });

  assert.equal(lines[0], "BWC ARCHIVE");
  assert.equal((lines[1].match(/days collected/g) || []).length, 1);
  assert.equal((lines[1].match(/known coverage/g) || []).length, 1);
});

test("live age updates from bwcUpdatedZ without fetching and preserves invalid states", () => {
  const classes = new Map();
  const attributes = new Map();
  const age = {
    hidden: true,
    textContent: "",
    classList: { toggle(name, enabled) { classes.set(name, enabled); } },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const doc = { getElementById(id) { return id === "bwcAge" ? age : null; } };
  const view = {
    kmemWeatherData: {
      bwc: "SEVERE",
      bwcUpdatedZ: "2026-08-30 02:30:00.000",
      lastKnownGoodUsed: { ahas: true },
    },
    getBoardNowMs() { return Date.parse("2026-08-30T02:41:59Z"); },
  };

  const result = updateLiveBwcAge(doc, view, true);
  assert.equal(result.ok, true);
  assert.equal(result.minutes, 11);
  assert.equal(age.hidden, false);
  assert.equal(age.textContent, "11 MIN AGO · LAST KNOWN");
  assert.equal(classes.get("bwc-age-last-known"), true);

  view.kmemWeatherData.bwcUpdatedZ = "2026-08-30 02:50:00.000";
  const future = updateLiveBwcAge(doc, view, true);
  assert.equal(future.ok, false);
  assert.equal(age.hidden, true);
  assert.equal(age.textContent, "");
  assert.match(attributes.get("title"), /more than two minutes ahead/);
});

test("live BWC source stamp preserves usable UTC values and omits malformed timestamps", () => {
  const format = liveStampFormatter();
  assert.equal(format("2026-08-30 02:30:00.000"), "30 AUG 0230Z");
  assert.equal(format("2028-02-29T23:59:59Z"), "29 FEB 2359Z");
  for (const malformed of ["2026-13-99 25:61:00", "2026-02-29 02:30:00", "bad", "--", ""]) {
    assert.equal(format(malformed), "", malformed);
  }
});

test("timeline lookup is deterministic at boundaries and across gaps", () => {
  const segments = [
    { kind: "STATE", state: "LOW", startMs: 100, endMs: 200 },
    { kind: "UNKNOWN", startMs: 200, endMs: 300 },
    { kind: "STATE", state: "SEVERE", startMs: 300, endMs: 400 },
  ];
  assert.equal(findTimelineSegmentAt(segments, 100)?.state, "LOW");
  assert.equal(findTimelineSegmentAt(segments, 199)?.state, "LOW");
  assert.equal(findTimelineSegmentAt(segments, 200)?.kind, "UNKNOWN");
  assert.equal(findTimelineSegmentAt(segments, 299)?.kind, "UNKNOWN");
  assert.equal(findTimelineSegmentAt(segments, 300)?.state, "SEVERE");
  assert.equal(findTimelineSegmentAt(segments, 400), null);
});

test("controller source provides open/close/backdrop/Escape/focus trap and cached range switches", () => {
  assert.match(historyJs, /closest\?\.\("#bwcHistoryButton"\)/);
  assert.match(historyJs, /closeButton\.addEventListener\("click", close\)/);
  assert.match(historyJs, /event\.target === overlay/);
  assert.match(historyJs, /event\.key === "Escape"/);
  assert.match(historyJs, /event\.key !== "Tab"/);
  assert.match(historyJs, /focusableElements\(panel\)/);
  assert.match(historyJs, /rangeButton\.addEventListener\("click"/);
  assert.match(historyJs, /loader\.load\(\)/);
  assert.match(historyJs, /view\.kmemRefreshBwcHistoryCurrent = refreshCurrent/);
  assert.match(indexHtml, /updateDetails\(data\);\s*window\.kmemRefreshBwcHistoryCurrent\?\.\(\)/);
  assert.doesNotMatch(historyJs, /setInterval\s*\(/);
  assert.doesNotMatch(historyJs, /location\.(?:href|assign|replace)/);
  assert.match(historyJs, /STATE_AFTER_GAP/);
  assert.match(historyJs, /FIRST OBSERVED/);
  assert.match(historyJs, /AFTER DATA GAP/);
  assert.match(historyJs, /staleArchive\(history, nowMs\)[\s\S]*"BWC HISTORY UNAVAILABLE"/);
});

test("chart rendering is dependency-free SVG with unknown gaps and pointer/tap inspection", () => {
  assert.match(historyJs, /createElementNS\(SVG_NS, name\)/);
  assert.match(historyJs, /createSvgElement\(doc, "svg"/);
  assert.match(historyJs, /createSvgElement\(doc, "path"/);
  assert.match(historyJs, /bwc-history-unknown-band/);
  assert.match(historyJs, /addEventListener\("pointermove"/);
  assert.match(historyJs, /addEventListener\("click"/);
  assert.match(historyJs, /America\/Chicago|formatBwcMemphisTime/);
  assert.doesNotMatch(historyJs, /(?:from\s+["']d3|\bnew\s+Chart\s*\(|from\s+["']chart\.js|highcharts|plotly)/i);
});

test("modal styling stays fixed, internally scrollable, touch friendly, and responsive", () => {
  assert.match(historyCss, /\.bwc-history-overlay\{[\s\S]*position:fixed/);
  assert.match(historyCss, /\.bwc-history-body\{[\s\S]*overflow:auto/);
  assert.match(historyCss, /touch-action:manipulation/);
  assert.match(historyCss, /overflow-x:hidden/);
  assert.match(historyCss, /@media \(max-width:700px\)/);
  assert.match(historyCss, /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(historyCss, /@media \(max-width:700px\) and \(orientation:landscape\)/);
  assert.match(historyCss, /\.bwc-history-range-strip\{[\s\S]*overflow-x:auto/);
  assert.match(historyCss, /\.bwc-history-chart\{[\s\S]*min-width:0/);
  assert.doesNotMatch(historyCss, /width:\s*\d{4,}px/);
});

test("BWC history assets are included as modules without changing aviation lookup", () => {
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/bwc-history\.css"\s*\/?>/);
  assert.match(indexHtml, /<script type="module" src="\.\/bwc-history\.js"><\/script>/);
  assert.doesNotMatch(historyJs, /aviationWeather|lookupAviationWeather/);
});
