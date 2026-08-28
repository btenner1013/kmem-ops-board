import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyLookupDialogState } from "../aviation-weather-lookup.js";

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
