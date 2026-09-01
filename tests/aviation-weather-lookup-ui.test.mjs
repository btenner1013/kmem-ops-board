import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  lookupAviationWeather,
} from "../aviation-weather-lookup-core.js";

import {
  applyLookupDialogState,
  fetchCurrentTafSnapshot,
  fetchNwsMeteogramSupplement,
  formatReportIdentity,
  formatZulu,
  getAtisGuruReference,
  renderAtisGuruReference,
  toggleDecodedReport,
} from "../aviation-weather-lookup.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lookupCss = readFileSync(new URL("../aviation-weather-lookup.css", import.meta.url), "utf8");
const lookupJs = readFileSync(new URL("../aviation-weather-lookup.js", import.meta.url), "utf8");

const atisUnavailable = (station) => ({
  state: "unsupported",
  headline: `ATIS NOT AVAILABLE FOR ${station}`,
  detail: `No participating current D-ATIS source returned a broadcast for ${station}.`,
  reports: [],
});

function fakeElement(tagName) {
  const attributes = new Map();
  return {
    tagName: String(tagName).toUpperCase(),
    className: "",
    textContent: "",
    children: [],
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
  };
}

test("the board creates the exact Aviation Weather Lookup quick-link button", () => {
  assert.match(indexHtml, /aviationWeather\.id="aviationWeatherLookupButton"/);
  assert.match(indexHtml, /aviationWeather\.title="Aviation Weather Lookup"/);
  assert.match(indexHtml, /setAttribute\("aria-label","Aviation Weather Lookup"\)/);
  assert.match(indexHtml, /aviationWeather\.textContent="🌤️"/u);
  assert.match(indexHtml, /appendChild\(hazard\);\s*wrap\.appendChild\(bwcHistory\);\s*wrap\.appendChild\(aviationWeather\);\s*wrap\.appendChild\(flightPlan\)/);
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

test("KMEM meteogram supplement discovers and fetches the exact official NWS grid endpoint", async () => {
  const calls = [];
  const controller = new AbortController();
  const gridPayload = {
    id: "https://api.weather.gov/gridpoints/MEG/45,62",
    type: "Feature",
    properties: {
      gridId: "MEG",
      gridX: 45,
      gridY: 62,
      updateTime: "2026-08-28T00:00:00Z",
      validTimes: "2026-08-28T00:00:00Z/P2D",
      temperature: { uom: "wmoUnit:degC", values: [] },
      dewpoint: { uom: "wmoUnit:degC", values: [] },
      quantitativePrecipitation: { uom: "wmoUnit:mm", values: [] },
      snowfallAmount: { uom: "wmoUnit:mm", values: [] },
    },
  };
  const supplement = await fetchNwsMeteogramSupplement({
    station: " kmem ",
    signal: controller.signal,
    fetchedAt: () => new Date("2026-08-28T01:02:03Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return {
          ok: true,
          async json() {
            return { properties: { forecastGridData: "https://api.weather.gov/gridpoints/MEG/45,62" } };
          },
        };
      }
      return { ok: true, async json() { return gridPayload; } };
    },
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://api.weather.gov/points/35.0424,-89.9767",
    "https://api.weather.gov/gridpoints/MEG/45,62",
  ]);
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.deepEqual(options.headers, { Accept: "application/geo+json" });
  }
  assert.equal(supplement.payload, gridPayload);
  assert.equal(supplement.sourceUrl, "https://api.weather.gov/gridpoints/MEG/45,62");
  assert.equal(supplement.pointUrl, "https://api.weather.gov/points/35.0424,-89.9767");
  assert.equal(supplement.stationUrl, "https://api.weather.gov/stations/KMEM");
  assert.equal(supplement.fetchedZ, "2026-08-28T01:02:03.000Z");
  assert.deepEqual(supplement.point, { latitude: 35.0424, longitude: -89.9767 });
});

test("NWS supplement is KMEM-only and rejects untrusted endpoints and malformed grid payloads", async () => {
  let fetchCount = 0;
  assert.equal(await fetchNwsMeteogramSupplement({
    station: "KATL",
    fetchImpl: async () => { fetchCount += 1; },
  }), null);
  assert.equal(fetchCount, 0);

  await assert.rejects(
    () => fetchNwsMeteogramSupplement({
      station: "KMEM",
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /NWS point HTTP 503/,
  );

  let httpCall = 0;
  await assert.rejects(
    () => fetchNwsMeteogramSupplement({
      station: "KMEM",
      fetchImpl: async () => {
        httpCall += 1;
        return httpCall === 1
          ? { ok: true, async json() { return { properties: { forecastGridData: "https://api.weather.gov/gridpoints/MEG/45,62" } }; } }
          : { ok: false, status: 429 };
      },
    }),
    /NWS grid HTTP 429/,
  );

  for (const forecastGridData of [
    "http://api.weather.gov/gridpoints/MEG/45,62",
    "https://evil.example/gridpoints/MEG/45,62",
    "https://api.weather.gov/gridpoints/MEG/45,62?redirect=1",
    "https://api.weather.gov/alerts/active",
    null,
  ]) {
    await assert.rejects(
      () => fetchNwsMeteogramSupplement({
        station: "KMEM",
        fetchImpl: async () => ({
          ok: true,
          async json() { return { properties: { forecastGridData } }; },
        }),
      }),
      /invalid forecastGridData URL/,
    );
  }

  let call = 0;
  await assert.rejects(
    () => fetchNwsMeteogramSupplement({
      station: "KMEM",
      fetchImpl: async () => {
        call += 1;
        return call === 1
          ? { ok: true, async json() { return { properties: { forecastGridData: "https://api.weather.gov/gridpoints/MEG/45,62" } }; } }
          : { ok: true, async json() { return { properties: [] }; } };
      },
    }),
    /response is malformed/,
  );

  let identityCall = 0;
  await assert.rejects(
    () => fetchNwsMeteogramSupplement({
      station: "KMEM",
      fetchedAt: () => new Date("2026-08-28T01:02:03Z"),
      fetchImpl: async () => {
        identityCall += 1;
        return identityCall === 1
          ? { ok: true, async json() { return { properties: { forecastGridData: "https://api.weather.gov/gridpoints/MEG/45,62" } }; } }
          : {
            ok: true,
            async json() {
              return {
                id: "https://api.weather.gov/gridpoints/MEG/45,62",
                type: "Feature",
                properties: {
                  gridId: "MEG", gridX: 46, gridY: 62,
                  updateTime: "2026-08-28T00:00:00Z",
                  validTimes: "2026-08-28T00:00:00Z/P2D",
                },
              };
            },
          };
      },
    }),
    /failed identity, validity, or field validation/,
  );
});

test("NWS supplement propagates aborts at the fetch boundary for controller-level fail-closed handling", async () => {
  const controller = new AbortController();
  const request = fetchNwsMeteogramSupplement({
    station: "KMEM",
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("meteogram controller isolates and replaces the optional NWS supplement without changing other products", () => {
  assert.match(
    lookupJs,
    /const supplementalForecastPromise = product === "METEOGRAM" && station === "KMEM"[\s\S]*fetchNwsMeteogramSupplement\([\s\S]*?\)\.catch\(\(\) => null\)[\s\S]*: Promise\.resolve\(null\)/,
  );
  assert.match(lookupJs, /Promise\.all\(\[[\s\S]*responsePromise,[\s\S]*tafResponsePromise,[\s\S]*supplementalForecastPromise/);
  assert.match(lookupJs, /renderAviationMeteogram\([\s\S]*tafReports:[\s\S]*supplementalForecast,/);
  assert.match(lookupJs, /NWS supplemental grid forecast available\./);
  assert.match(lookupJs, /NWS supplemental grid forecast unavailable; unsupported values remain missing\./);
  assert.match(lookupJs, /normalizedSupplementAvailable = forecastSources\.hasNws/);
  assert.match(lookupJs, /meteogramForecastSourceState\(activeMeteogram\.model\)/);
  assert.match(lookupJs, /runLookup\(\{ preserveMeteogramView: true \}\)/);
  assert.equal((lookupJs.match(/fetchNwsMeteogramSupplement\(/g) || []).length, 2);
});

test("the panel defaults to KMEM, ATIS, and Most recent", () => {
  const stationField = indexHtml.match(/<input id="aviationWeatherLookupStation"[^>]*>/)?.[0] || "";
  assert.match(stationField, /value="KMEM"/);
  assert.doesNotMatch(stationField, /maxlength=/);
  assert.match(indexHtml, /data-aviation-product="ATIS"[^>]*aria-pressed="true"/);
  assert.match(indexHtml, /<option value="recent" selected>Most recent<\/option>/);
});

test("valid non-KMEM current ATIS misses offer only the exact external reference metadata", () => {
  const lfpg = getAtisGuruReference({
    station: " lfpg ",
    product: "ATIS",
    range: "recent",
    response: atisUnavailable("LFPG"),
  });
  assert.deepEqual(lfpg, {
    href: "https://atis.guru/atis/LFPG",
    label: "ATIS.guru reference ↗",
    warning: "External reference only — currentness not validated",
    target: "_blank",
    rel: "noopener noreferrer",
  });

  const egll = getAtisGuruReference({
    station: "EGLL",
    product: "ATIS",
    range: "recent",
    response: atisUnavailable("EGLL"),
  });
  assert.equal(egll.href, "https://atis.guru/atis/EGLL");
  assert.deepEqual(Object.keys(egll), ["href", "label", "warning", "target", "rel"]);
});

test("current ATIS.info success suppresses the external reference", async () => {
  const calls = [];
  const success = await lookupAviationWeather({
    station: "LFPG",
    product: "ATIS",
    range: "recent",
    now: new Date("2026-08-27T12:00:00Z"),
    fetchImpl: async (input) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            airport: "LFPG",
            type: "ARR",
            code: "A",
            time: "1150",
            updatedAt: "2026-08-27T11:50:00Z",
            datis: "LFPG ARR ATIS A 1150Z. EXPECT ILS APPROACH. QNH 1018. ADVISE ON INITIAL CONTACT YOU HAVE A.",
          }];
        },
      };
    },
  });
  assert.equal(success.state, "success");
  assert.deepEqual(calls, ["https://atis.info/api/LFPG"]);
  assert.equal(getAtisGuruReference({ station: "LFPG", product: "ATIS", range: "recent", response: success }), null);
});

test("external reference is suppressed for invalid input, KMEM, history, METAR, and TAF", () => {
  assert.equal(getAtisGuruReference({ station: "LFP1", product: "ATIS", range: "recent", response: atisUnavailable("LFP1") }), null);
  assert.equal(getAtisGuruReference({ station: "KMEM", product: "ATIS", range: "recent", response: atisUnavailable("KMEM") }), null);
  assert.equal(getAtisGuruReference({ station: "LFPG", product: "ATIS", range: "96", response: atisUnavailable("LFPG") }), null);
  assert.equal(getAtisGuruReference({ station: "LFPG", product: "METAR", range: "recent", response: atisUnavailable("LFPG") }), null);
  assert.equal(getAtisGuruReference({ station: "LFPG", product: "TAF", range: "recent", response: atisUnavailable("LFPG") }), null);
  assert.equal(
    getAtisGuruReference({ station: "LFPG", product: "ATIS", range: "recent", response: { ...atisUnavailable("LFPG"), state: "error" } })?.href,
    "https://atis.guru/atis/LFPG",
  );
});

test("external reference renders a user-clicked safe link with its warning immediately adjacent", () => {
  const ownerDocument = { createElement: fakeElement };
  const container = fakeElement("div");
  container.ownerDocument = ownerDocument;
  const reference = getAtisGuruReference({
    station: "LFPG",
    product: "ATIS",
    range: "recent",
    response: atisUnavailable("LFPG"),
  });
  const block = renderAtisGuruReference(container, reference);
  assert.equal(container.children[0], block);
  assert.equal(block.className, "aviation-lookup-external-reference");
  assert.equal(block.children.length, 2);
  const [link, warning] = block.children;
  assert.equal(link.tagName, "A");
  assert.equal(link.textContent, "ATIS.guru reference ↗");
  assert.equal(link.getAttribute("href"), "https://atis.guru/atis/LFPG");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(warning.tagName, "SPAN");
  assert.equal(warning.textContent, "External reference only — currentness not validated");
  assert.match(lookupJs, /block\.append\(link, warning\)/);
  assert.doesNotMatch(lookupJs, /fetch\([^)]*atis\.guru/i);
  assert.doesNotMatch(lookupJs, /prefetch|<iframe|createElement\("iframe"\)/i);
});

test("the product and range selectors contain every requested choice", () => {
  for (const product of ["ATIS", "METAR", "TAF", "METEOGRAM"]) {
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

test("METEOGRAM keeps its full intrinsic-width label without shortening or ellipsis", () => {
  assert.match(
    indexHtml,
    /<button[^>]*data-aviation-product="METEOGRAM"[^>]*>METEOGRAM<\/button>/,
  );
  assert.doesNotMatch(indexHtml, /aviation-lookup-product-(?:long|short)/);
  assert.match(
    lookupCss,
    /\.aviation-lookup-products\{[\s\S]*?grid-template-columns:repeat\(4,minmax\(max-content,1fr\)\)/,
  );
  assert.match(
    lookupCss,
    /\.aviation-lookup-product\{[\s\S]*?min-width:max-content;[\s\S]*?overflow:visible;[\s\S]*?white-space:nowrap;[\s\S]*?text-overflow:clip;/,
  );
  assert.doesNotMatch(lookupCss, /text-overflow:ellipsis/);
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
  assert.match(lookupCss, /@media \(max-width:768px\)/);
  assert.match(lookupCss, /\.aviation-lookup-external-reference\{[\s\S]*flex-wrap:wrap/);
  assert.match(lookupCss, /@media \(max-width:768px\)\{[\s\S]*\.aviation-lookup-external-reference\{align-items:flex-start;flex-direction:column/);
  assert.match(
    lookupCss,
    /@media \(min-width:769px\) and \(max-width:1050px\)\{[\s\S]*?grid-template-areas:\s*"station products"\s*"range submit";[\s\S]*?grid-template-columns:minmax\(120px,\.32fr\) minmax\(390px,1fr\)/,
  );
  assert.match(
    lookupCss,
    /@media \(max-width:768px\)\{[\s\S]*?grid-template-areas:\s*"products products"\s*"station range"\s*"submit submit";[\s\S]*?grid-template-columns:1fr 1fr;[\s\S]*?\.aviation-lookup-products\{grid-template-columns:repeat\(2,minmax\(max-content,1fr\)\)\}/,
  );
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(lookupCss, /@media \(max-width:768px\)\{[\s\S]*?\.aviation-lookup-panel\{\s*width:100%;/);
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{[\s\S]*?\.aviation-lookup-panel\{width:100%;/);
  assert.doesNotMatch(lookupCss, /overflow-x:\s*hidden/);
  assert.doesNotMatch(lookupCss, /aviation-lookup-results:empty/);
  assert.match(indexHtml, /<script type="module" src="\.\/aviation-weather-lookup\.js"><\/script>/);
});

test("responsive board widths exclude the vertical scrollbar gutter", () => {
  assert.match(indexHtml, /\.board\{\s*height:100vh;\s*width:100%;/);
  assert.match(
    indexHtml,
    /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{\s*html,body\{ width:100% !important; max-width:100% !important;/,
  );
  assert.match(
    indexHtml,
    /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{\s*html,body\{[^}]*width:100% !important; max-width:100% !important;[^}]*\}\s*\.board\{[^}]*width:100% !important; max-width:100% !important;/,
  );
  assert.match(
    indexHtml,
    /\/\* Phone-first compact board\.[\s\S]*?html,body\{\s*width:100% !important;\s*max-width:100% !important;[\s\S]*?\.board\{[\s\S]*?width:100% !important;\s*max-width:100% !important;/,
  );
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

test("meteogram printing opens a dedicated accessible range setup with every supported choice", () => {
  assert.match(
    indexHtml,
    /id="aviationMeteogramPrintSetup"[^>]*hidden[^>]*aria-hidden="true"/,
  );
  assert.match(
    indexHtml,
    /id="aviationMeteogramPrintPanel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="aviationMeteogramPrintTitle"/,
  );
  assert.match(indexHtml, /id="aviationMeteogramPrintTitle">PRINT METEOGRAM</);
  for (const [value, label] of [
    ["current", "CURRENT METEOGRAM RANGE"],
    ["calendar", "CALENDAR DAY"],
    ["custom", "CUSTOM RANGE"],
    ["visible", "CURRENT VISIBLE WINDOW"],
  ]) {
    assert.match(
      indexHtml,
      new RegExp(`name="meteogramPrintRange" value="${value}"[^>]*> ${label}`),
    );
  }
  assert.match(indexHtml, /id="aviationMeteogramPrintCalendarDate" type="date"/);
  assert.match(indexHtml, /id="aviationMeteogramPrintStartDate" type="date"/);
  assert.match(indexHtml, /id="aviationMeteogramPrintStartTime" type="time"/);
  assert.match(indexHtml, /id="aviationMeteogramPrintEndDate" type="date"/);
  assert.match(indexHtml, /id="aviationMeteogramPrintEndTime" type="time"/);
  assert.match(indexHtml, /id="aviationMeteogramPrintSubmit"[^>]*type="submit">CONTINUE TO PRINT<\/button>/);
  assert.match(indexHtml, /id="aviationMeteogramPrintPages"[^>]*hidden/);
});

test("meteogram print preparation is isolated while ATIS, METAR, and TAF retain direct printing", () => {
  assert.match(
    lookupJs,
    /printButton\.addEventListener\("click", \(\) => \{[\s\S]*?if \(product === "METEOGRAM" && openMeteogramPrintSetup\(\)\) return;[\s\S]*?updatePrintSummary\(\);[\s\S]*?classList\.add\("aviation-lookup-printing"\);[\s\S]*?view\.print\(\);/,
  );
  assert.match(
    lookupJs,
    /meteogramPrintForm\.addEventListener\("submit",[\s\S]*?buildMeteogramPrintPagesMarkup\(plan\)[\s\S]*?classList\.add\("aviation-meteogram-printing"\)[\s\S]*?view\.print\(\)/,
  );
  assert.match(lookupCss, /@page meteogram\{size:letter landscape/);
  assert.match(
    lookupCss,
    /body\.aviation-meteogram-printing \.aviation-lookup-panel,[\s\S]*?\.aviation-meteogram-print-setup\{display:none!important\}/,
  );
  assert.match(
    lookupCss,
    /body\.aviation-meteogram-printing \.aviation-meteogram-print-pages\{[\s\S]*?display:block!important/,
  );
});

test("changing ICAO clears stale result state while Enter still runs lookup", () => {
  assert.match(lookupJs, /stationInput\.addEventListener\("input",[\s\S]*clearResultState\("READY"/);
  assert.match(lookupJs, /stationInput\.addEventListener\("keydown",[\s\S]*event\.key !== "Enter"[\s\S]*runLookup\(\)/);
});
