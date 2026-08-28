import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyLookupDialogState,
  fetchCurrentTafSnapshot,
  formatReportIdentity,
  formatZulu,
  toggleDecodedReport,
} from "../aviation-weather-lookup.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lookupCss = readFileSync(new URL("../aviation-weather-lookup.css", import.meta.url), "utf8");
const lookupJs = readFileSync(new URL("../aviation-weather-lookup.js", import.meta.url), "utf8");

test("the board creates the exact Aviation Weather Lookup quick-link button", () => {
  assert.match(indexHtml, /aviationWeather\.id="aviationWeatherLookupButton"/);
  assert.match(indexHtml, /aviationWeather\.title="Aviation Weather Lookup"/);
  assert.match(indexHtml, /setAttribute\("aria-label","Aviation Weather Lookup"\)/);
  assert.match(indexHtml, /aviationWeather\.textContent="🌤️"/u);
  assert.match(indexHtml, /appendChild\(hazard\);\s*wrap\.appendChild\(aviationWeather\);\s*wrap\.appendChild\(flightPlan\)/);
});

test("the lookup panel has accessible dialog and close contracts", () => {
  assert.match(indexHtml, /id="aviationWeatherLookupOverlay"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(indexHtml, /id="aviationWeatherLookupPanel"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(indexHtml, /id="aviationWeatherLookupTitle"[^>]*>AVIATION WEATHER LOOKUP</);
  assert.match(indexHtml, /id="aviationWeatherLookupClose"[^>]*type="button"[^>]*aria-label="Close Aviation Weather Lookup"/);
  assert.match(lookupJs, /event\.key === "Escape"/);
  assert.match(lookupJs, /closest\?\.\("#aviationWeatherLookupButton"\)/);
  assert.match(lookupJs, /closeButton\.addEventListener\("click", close\)/);
  assert.match(lookupJs, /form\.addEventListener\("submit",[\s\S]*?runLookup\(\)/);
  assert.match(lookupJs, /stationInput\.addEventListener\("keydown",[\s\S]*?event\.key !== "Enter"[\s\S]*?runLookup\(\)/);
});

test("lookup exposes print and decoder controls without a separate SPECI product", () => {
  assert.match(indexHtml, /id="aviationWeatherLookupPrint"[^>]*>PRINT<\/button>/);
  assert.match(indexHtml, /id="aviationWeatherLookupPrintSummary"/);
  assert.doesNotMatch(indexHtml, /data-aviation-product="SPECI"/);
  assert.match(lookupJs, /toggle\.textContent = "DECODE"/);
  assert.match(lookupJs, /DECODED — FOR REFERENCE ONLY/);
  assert.match(lookupJs, /classList\.add\("aviation-lookup-printing"\)/);
  assert.match(lookupJs, /addEventListener\("afterprint"/);
});

test("decoder control expands and collapses without replacing the raw report", () => {
  const attributes = new Map([["aria-expanded", "false"]]);
  const toggle = {
    textContent: "DECODE",
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const panel = { hidden: true };

  assert.equal(toggleDecodedReport(toggle, panel), true);
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(toggle.textContent, "HIDE DECODED");
  assert.equal(panel.hidden, false);
  assert.equal(toggleDecodedReport(toggle, panel), false);
  assert.equal(attributes.get("aria-expanded"), "false");
  assert.equal(toggle.textContent, "DECODE");
  assert.equal(panel.hidden, true);
  assert.match(lookupJs, /card\.append\(meta, rawLabel, raw\)[\s\S]*card\.append\(controls, decodePanel\)/);
});

test("same-origin current TAF snapshot is schema-checked, cache-busted, and station-filtered", async () => {
  let requestUrl = "";
  let requestOptions = null;
  const reports = await fetchCurrentTafSnapshot({
    station: " kvok ",
    now: new Date("2026-08-28T01:30:00Z"),
    baseUrl: "https://example.test/board/index.html",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return {
        ok: true,
        async json() {
          return {
            schemaVersion: 1,
            sourcePolicy: "NOAA_AWC_COMPLETE_CURRENT_CACHE",
            reports: [
              { station: "KVOK", issueTime: "2026-08-28T01:00:00Z", validTimeFrom: "2026-08-28T01:00:00Z", validTimeTo: "2026-08-29T07:00:00Z", raw: "TAF KVOK 280100Z 2801/2907 VRB06KT 9999 FEW060" },
              { station: "KMEM", issueTime: "2026-08-27T23:29:00Z", raw: "TAF KMEM 272329Z 2800/2906 36008KT P6SM" },
            ],
          };
        },
      };
    },
  });

  const parsedUrl = new URL(requestUrl);
  assert.equal(parsedUrl.pathname, "/board/taf_current.json");
  assert.equal(parsedUrl.searchParams.get("lookup"), String(Date.parse("2026-08-28T01:30:00Z")));
  assert.equal(requestOptions.cache, "no-store");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].station, "KVOK");
  assert.equal(reports[0].timestamp, "2026-08-28T01:00:00Z");
  assert.match(reports[0].source, /Aviation Weather Center/);
  assert.match(lookupJs, /currentTafProvider:[\s\S]*fetchCurrentTafSnapshot/);

  await assert.rejects(
    () => fetchCurrentTafSnapshot({
      station: "KVOK",
      fetchImpl: async () => ({ ok: true, async json() { return { schemaVersion: 99, reports: [] }; } }),
    }),
    /schema is invalid/,
  );
});

test("the panel defaults to KMEM, ATIS, and Most recent", () => {
  const stationField = indexHtml.match(/<input id="aviationWeatherLookupStation"[^>]*>/)?.[0] || "";
  assert.match(stationField, /value="KMEM"/);
  assert.doesNotMatch(stationField, /maxlength=/);
  assert.match(indexHtml, /data-aviation-product="ATIS"[^>]*aria-pressed="true"/);
  assert.match(indexHtml, /<option value="recent" selected>Most recent<\/option>/);
});

test("the product and range selectors contain every requested choice", () => {
  for (const product of ["ATIS", "METAR", "TAF"]) {
    assert.match(indexHtml, new RegExp(`data-aviation-product="${product}"`));
  }
  for (const [value, label] of [
    ["recent", "Most recent"],
    ["1", "Past 1 hour"],
    ["2", "Past 2 hours"],
    ["3", "Past 3 hours"],
    ["6", "Past 6 hours"],
    ["12", "Past 12 hours"],
    ["24", "Past 24 hours"],
    ["48", "Past 48 hours"],
    ["96", "Past 96 hours"],
  ]) {
    assert.match(indexHtml, new RegExp(`<option value="${value}"(?: selected)?>${label}</option>`));
  }
});

test("result-card identities distinguish routine METARs, SPECIs, and TAF variants", () => {
  assert.equal(formatReportIdentity({ product: "METAR", station: "KMEM" }), "METAR KMEM");
  assert.equal(formatReportIdentity({ product: "SPECI", station: "KMEM" }), "SPECI KMEM");
  assert.equal(formatReportIdentity({ product: "TAF", variant: "AMD", station: "KMEM" }), "TAF AMD KMEM");
  assert.equal(
    formatReportIdentity({
      product: "ATIS",
      variant: "COMBINED",
      station: "KMEM",
      letter: "S",
      letterName: "SIERRA",
      source: "KMEM local D-ATIS archive",
    }),
    "ATIS KMEM INFO SIERRA",
  );
  assert.equal(
    formatReportIdentity({
      product: "ATIS",
      variant: "ARR",
      station: "KMEM",
      letter: "S",
      letterName: "SIERRA",
      source: "KMEM local D-ATIS archive",
    }),
    "ATIS ARR KMEM INFO SIERRA",
  );
  assert.equal(
    formatReportIdentity({ product: "ATIS", variant: "COMBINED", station: "KATL", letter: "B" }),
    "ATIS COMBINED KATL INFO B",
  );
  assert.match(lookupJs, /raw\.textContent = report\.displayText \|\| report\.raw/);
  assert.equal(formatZulu("2026-08-28T00:55:00Z"), "280055Z");
});

test("result cards keep providers internal and show UTC plus station-local time", () => {
  assert.doesNotMatch(lookupJs, /SOURCE:/);
  assert.doesNotMatch(lookupJs, /aviation-lookup-source/);
  assert.doesNotMatch(lookupCss, /aviation-lookup-source/);
  assert.match(lookupJs, /formatStationLocalTime\(report\.timestamp, report\.station/);
  assert.match(lookupJs, /localTime === "LOCAL TIME UNAVAILABLE" \? localTime : `LOCAL: \$\{localTime\}`/);
  assert.match(lookupJs, /aviation-lookup-result-zulu/);
  assert.match(lookupJs, /aviation-lookup-result-local/);
});

test("dialog visibility helper opens, closes, and restores focus", () => {
  const attributes = new Map();
  const toggles = [];
  let inputFocus = 0;
  let openerFocus = 0;
  const overlay = {
    hidden: true,
    setAttribute(name, value) { attributes.set(name, value); },
  };
  const body = { classList: { toggle(name, value) { toggles.push([name, value]); } } };
  const focusTarget = { focus() { inputFocus += 1; } };
  const returnFocus = { focus() { openerFocus += 1; } };

  applyLookupDialogState({ overlay, body, focusTarget, returnFocus }, true);
  assert.equal(overlay.hidden, false);
  assert.equal(attributes.get("aria-hidden"), "false");
  assert.equal(inputFocus, 1);

  applyLookupDialogState({ overlay, body, focusTarget, returnFocus }, false);
  assert.equal(overlay.hidden, true);
  assert.equal(attributes.get("aria-hidden"), "true");
  assert.equal(openerFocus, 1);
  assert.deepEqual(toggles, [["aviation-lookup-open", true], ["aviation-lookup-open", false]]);
});

test("lookup styling is fixed, internally scrollable, and responsive", () => {
  assert.match(lookupCss, /\.aviation-lookup-overlay\{[\s\S]*position:fixed/);
  assert.match(lookupCss, /\.aviation-lookup-results\{[\s\S]*overflow:auto/);
  assert.match(lookupCss, /@media \(max-width:700px\)/);
  assert.match(lookupCss, /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.doesNotMatch(lookupCss, /aviation-lookup-results:empty/);
  assert.match(indexHtml, /<script type="module" src="\.\/aviation-weather-lookup\.js"><\/script>/);
});

test("print layout is black-and-white lookup-only output", () => {
  assert.match(lookupCss, /@media print/);
  assert.match(lookupCss, /body\.aviation-lookup-printing> :not\(#aviationWeatherLookupOverlay\)\{display:none!important\}/);
  assert.match(lookupCss, /background:#fff!important/);
  assert.match(lookupCss, /color:#000!important/);
  assert.match(lookupCss, /break-inside:avoid-page/);
  assert.match(lookupCss, /aviation-lookup-result-controls\{display:none!important\}/);
  assert.doesNotMatch(lookupCss, /@media print[\s\S]*#radarImg/);
});

test("changing ICAO clears stale result state while Enter still runs lookup", () => {
  assert.match(lookupJs, /stationInput\.addEventListener\("input",[\s\S]*clearResultState\("READY"/);
  assert.match(lookupJs, /stationInput\.addEventListener\("keydown",[\s\S]*event\.key !== "Enter"[\s\S]*runLookup\(\)/);
});
