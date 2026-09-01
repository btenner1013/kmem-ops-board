import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lookupAviationWeather } from "../aviation-weather-lookup-core.js";
import { buildMeteogramModel, meteogramLookupRequest } from "../weather-meteogram-core.js";
import { meteogramSolarEvents, meteogramSolarPhase } from "../weather-meteogram-solar.js";
import {
  buildMeteogramAccessibleTableMarkup,
  buildMeteogramSvgMarkup,
  meteogramCloudBaseY,
  meteogramCloudColumnLabelMask,
  meteogramCloudLabelLayout,
  meteogramCloudTickLayout,
  meteogramDimensions,
  meteogramForecastSourceState,
  meteogramSubtitleText,
  meteogramTemperatureGeometry,
  meteogramWeatherVisualCategory,
  meteogramWindArrowRotation,
} from "../weather-meteogram.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lookupJs = readFileSync(new URL("../aviation-weather-lookup.js", import.meta.url), "utf8");
const lookupCss = readFileSync(new URL("../aviation-weather-lookup.css", import.meta.url), "utf8");
const meteogramJs = readFileSync(new URL("../weather-meteogram.js", import.meta.url), "utf8");
const meteogramCore = readFileSync(new URL("../weather-meteogram-core.js", import.meta.url), "utf8");
const meteogramCss = readFileSync(new URL("../weather-meteogram.css", import.meta.url), "utf8");
const meteogramSolarJs = readFileSync(new URL("../weather-meteogram-solar.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName = "div", ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.offsetParent = {};
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    if (this._textContent === "" && this.children) this.children.length = 0;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      preventDefault() {},
      ...values,
    };
    return (this.listeners.get(type) || []).map((listener) => listener(event));
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeClock {
  constructor() {
    this.nextId = 1;
    this.entries = new Map();
    this.cleared = [];
  }

  setTimeout(callback, milliseconds) {
    const id = this.nextId++;
    this.entries.set(id, { callback, milliseconds });
    return id;
  }

  clearTimeout(id) {
    if (this.entries.delete(id)) this.cleared.push(id);
  }

  fire(id) {
    const entry = this.entries.get(id);
    assert.ok(entry, `timer ${id} should still be scheduled`);
    this.entries.delete(id);
    return entry.callback();
  }

  activeIds() {
    return [...this.entries.keys()];
  }
}

function createLookupDom(clock) {
  const elements = new Map();
  const documentListeners = new Map();
  const viewListeners = new Map();
  const doc = {
    baseURI: "https://example.test/board/index.html",
    activeElement: null,
    createElement(tagName) {
      return new FakeElement(tagName, doc);
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      return selector === "[data-aviation-product]" ? productButtons : [];
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    dispatch(type, values = {}) {
      const event = { type, target: null, preventDefault() {}, ...values };
      return (documentListeners.get(type) || []).map((listener) => listener(event));
    },
  };

  for (const id of [
    "aviationWeatherLookupOverlay",
    "aviationWeatherLookupPanel",
    "aviationWeatherLookupClose",
    "aviationWeatherLookupPrint",
    "aviationWeatherLookupForm",
    "aviationWeatherLookupStation",
    "aviationWeatherLookupRange",
    "aviationWeatherLookupSubmit",
    "aviationWeatherLookupStatus",
    "aviationWeatherLookupResults",
    "aviationWeatherLookupPrintSummary",
  ]) {
    const element = new FakeElement(id.includes("Form") ? "form" : "div", doc);
    element.id = id;
    elements.set(id, element);
  }

  const overlay = elements.get("aviationWeatherLookupOverlay");
  overlay.hidden = true;
  const panel = elements.get("aviationWeatherLookupPanel");
  panel.querySelectorAll = () => [];
  const stationInput = elements.get("aviationWeatherLookupStation");
  stationInput.value = "KMEM";
  const rangeSelect = elements.get("aviationWeatherLookupRange");
  rangeSelect.options = [
    { value: "recent", textContent: "Most recent" },
    { value: "24", textContent: "Past 24 hours" },
  ];
  let selectedRange = "recent";
  Object.defineProperty(rangeSelect, "value", {
    get() { return selectedRange; },
    set(value) { selectedRange = String(value); },
  });
  Object.defineProperty(rangeSelect, "selectedIndex", {
    get() {
      const index = rangeSelect.options.findIndex((option) => option.value === selectedRange);
      return index < 0 ? 0 : index;
    },
  });

  const productButtons = ["ATIS", "METAR", "TAF", "METEOGRAM"].map((name) => {
    const button = new FakeElement("button", doc);
    button.dataset.aviationProduct = name;
    return button;
  });
  const body = new FakeElement("body", doc);
  doc.body = body;
  doc.defaultView = {
    fetch: async () => { throw new Error("unexpected direct fetch"); },
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    addEventListener(type, listener) {
      const listeners = viewListeners.get(type) || [];
      listeners.push(listener);
      viewListeners.set(type, listeners);
    },
    print() {},
  };
  return { doc, elements, productButtons, overlay, stationInput, rangeSelect };
}

let controllerModuleSequence = 0;

async function loadLookupController({ doc, lookupAviationWeather: lookup, renderAviationMeteogram: render }) {
  const dependencyKey = `__meteogramControllerDeps${controllerModuleSequence++}`;
  globalThis[dependencyKey] = {
    core: {
      LOOKUP_RANGES: ["recent", "24"],
      decodeMetarReport: () => null,
      decodeTafReport: () => null,
      formatStationLocalTime: () => "LOCAL TIME UNAVAILABLE",
      isValidIcao: (value) => /^[A-Z]{4}$/.test(String(value || "")),
      lookupAviationWeather: lookup,
      normalizeIcao: (value) => String(value || "").trim().toUpperCase(),
    },
    meteogramLookupRequest: ({ station, range }) => ({
      station: String(station || "").trim().toUpperCase(),
      product: "METAR",
      range: range === "recent" ? "24" : String(range),
    }),
    parseNwsGridForecast: () => null,
    meteogramForecastSourceState,
    renderAviationMeteogram: render,
    document: doc,
    window: doc.defaultView,
  };

  let source = lookupJs
    .replace(
      /import \{[\s\S]*?\} from "\.\/aviation-weather-lookup-core\.js";/,
      `const { LOOKUP_RANGES, decodeMetarReport, decodeTafReport, formatStationLocalTime, isValidIcao, lookupAviationWeather, normalizeIcao } = globalThis["${dependencyKey}"].core;`,
    )
    .replace(
      /import \{ meteogramLookupRequest, parseNwsGridForecast \} from "\.\/weather-meteogram-core\.js";/,
      `const { meteogramLookupRequest, parseNwsGridForecast } = globalThis["${dependencyKey}"];`,
    )
    .replace(
      /import \{ meteogramForecastSourceState, renderAviationMeteogram \} from "\.\/weather-meteogram\.js";/,
      `const { meteogramForecastSourceState, renderAviationMeteogram } = globalThis["${dependencyKey}"];`,
    )
    .replace(
      /\nif \(typeof document !== "undefined"\) \{[\s\S]*\}\s*$/,
      "",
    );
  source = `const { document, window } = globalThis["${dependencyKey}"];\n${source}`;
  source += `\n//# sourceURL=aviation-weather-lookup-controller-test-${controllerModuleSequence}.js`;
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${controllerModuleSequence}`);
  } finally {
    delete globalThis[dependencyKey];
  }
}

function createDeferredLookupHarness() {
  const calls = [];
  return {
    calls,
    lookup(options) {
      const task = deferred();
      calls.push({ options, task });
      return task.promise;
    },
  };
}

function successResponse(product) {
  return {
    state: "success",
    detail: "",
    reports: [{
      station: "KMEM",
      product,
      timestamp: "2026-08-31T18:00:00Z",
      raw: `${product} KMEM TEST`,
    }],
  };
}

function meteogramReport({
  timestamp = "2026-09-01T02:54:00Z",
  raw = "METAR KMEM 010254Z 24012G19KT 10SM FEW020 SCT045 BKN080 30/12 A3000 RMK AO2",
  product = "METAR",
} = {}) {
  return { station: "KMEM", timestamp, raw, product, source: "Deterministic METAR fixture" };
}

function nwsGridEnvelope() {
  return {
    sourceUrl: "https://api.weather.gov/gridpoints/MEG/45,63",
    pointUrl: "https://api.weather.gov/points/35.05644,-89.98634",
    stationUrl: "https://api.weather.gov/stations/KMEM",
    fetchedZ: "2026-09-01T03:16:00Z",
    point: { latitude: 35.05644, longitude: -89.98634 },
    payload: {
      id: "https://api.weather.gov/gridpoints/MEG/45,63",
      type: "Feature",
      properties: {
        gridId: "MEG",
        gridX: 45,
        gridY: 63,
        updateTime: "2026-09-01T03:05:00Z",
        validTimes: "2026-09-01T03:00:00Z/P2D",
        temperature: { uom: "wmoUnit:degC", values: [
          { validTime: "2026-09-01T03:00:00Z/PT5H", value: 21 },
          { validTime: "2026-09-01T08:00:00Z/PT13H", value: 24 },
        ] },
        dewpoint: { uom: "wmoUnit:degC", values: [
          { validTime: "2026-09-01T03:00:00Z/PT5H", value: 20 },
          { validTime: "2026-09-01T08:00:00Z/PT13H", value: 17 },
        ] },
        quantitativePrecipitation: { uom: "wmoUnit:mm", values: [
          { validTime: "2026-09-01T06:00:00Z/PT6H", value: 25.4 },
          { validTime: "2026-09-01T12:00:00Z/PT6H", value: 0 },
        ] },
        snowfallAmount: { uom: "wmoUnit:mm", values: [
          { validTime: "2026-09-01T06:00:00Z/PT6H", value: 2.54 },
        ] },
        probabilityOfPrecipitation: { uom: "wmoUnit:percent", values: [
          { validTime: "2026-09-01T06:00:00Z/PT6H", value: 90 },
        ] },
      },
    },
  };
}

function manualMeteogramPoint(overrides = {}) {
  return {
    station: "KMEM",
    observedZ: "2026-09-01T00:00:00.000Z",
    validZ: null,
    kind: "OBSERVED",
    reportType: "METAR",
    raw: "METAR KMEM TEST",
    source: "Manual fixture",
    temperatureC: 25,
    dewPointC: 18,
    windDirectionDeg: 240,
    windVariable: false,
    windSpeedKt: 12,
    windGustKt: null,
    pressureInHg: 30,
    visibilitySm: 10,
    visibilityQualifier: "",
    visibilityDisplay: "10 SM",
    clouds: { layers: [], clear: true, cavok: false, ceilingFt: null, display: "CLR" },
    weatherCodes: [],
    weather: { icon: "·", label: "NO WX CODE" },
    precipitation: {
      rainObserved: false, snowObserved: false, rainForecast: false, snowForecast: false,
      conditionalRainForecast: false, conditionalSnowForecast: false,
      liquidEquivalentIn: null, liquidTrace: false, liquidInterval: null,
      precipitationNotAvailable: false, snowDepthIncreaseIn: null, snowDepthIncreaseInterval: null, snowDepthIn: null,
    },
    conditional: [],
    becoming: [],
    temperatureExtrema: [],
    fieldProvenance: { temperature: null, dewPoint: null },
    ...overrides,
  };
}

function manualMeteogramModel(timeline, overrides = {}) {
  const observations = timeline.filter((entry) => entry.kind !== "FORECAST");
  const forecasts = timeline.filter((entry) => entry.kind === "FORECAST");
  return {
    station: "KMEM",
    timeZone: "America/Chicago",
    observations,
    forecasts,
    timeline,
    dividerZ: forecasts[0]?.validZ || null,
    taf: null,
    supplemental: null,
    observedSources: ["Manual fixture"],
    observedPrecipitationIntervals: [],
    observedSnowDepthIncreaseIntervals: [],
    forecastPrecipitationIntervals: [],
    forecastSnowfallIntervals: [],
    revisedBuckets: 0,
    ...overrides,
  };
}

function renderedSolarGeometry(svg) {
  return [...svg.matchAll(/data-solar-event="(sunrise|sunset)" data-event-z="([^"]+)" data-event-local-date="([^"]+)" data-event-x="([^"]+)"/g)]
    .map((match) => ({ type: match[1], timestamp: match[2], localDate: match[3], x: Number(match[4]) }));
}

test("meteogram is a fourth product inside the existing Aviation Weather Lookup modal", () => {
  assert.match(indexHtml, /id="aviationWeatherLookupPanel"[\s\S]*data-aviation-product="ATIS"[\s\S]*data-aviation-product="METAR"[\s\S]*data-aviation-product="TAF"[\s\S]*data-aviation-product="METEOGRAM"/);
  assert.match(indexHtml, /data-aviation-product="METEOGRAM"[^>]*aria-label="Aviation meteogram weather history"/);
  assert.match(indexHtml, /aviation-lookup-product-long">METEOGRAM<[\s\S]*aviation-lookup-product-short"[^>]*>METEO</);
  assert.doesNotMatch(indexHtml, /id="(?:weather|aviation)MeteogramOverlay"/i);
  assert.doesNotMatch(indexHtml, /id="(?:weather|aviation)MeteogramButton"/i);
  assert.equal((indexHtml.match(/aviationWeather\.id="aviationWeatherLookupButton"/g) || []).length, 1);
  assert.match(indexHtml, /appendChild\(hazard\);\s*wrap\.appendChild\(bwcHistory\);\s*wrap\.appendChild\(aviationWeather\);\s*wrap\.appendChild\(flightPlan\)/);
});

test("ATIS remains the default and meteogram selection widens only the shared panel", () => {
  assert.match(indexHtml, /data-aviation-product="ATIS"[^>]*aria-pressed="true"/);
  assert.match(lookupJs, /const PRODUCT_NAMES = new Set\(\["ATIS", "METAR", "TAF", "METEOGRAM"\]\)/);
  assert.match(lookupJs, /panel\.classList\.toggle\("aviation-lookup-panel-meteogram", normalized === "METEOGRAM"\)/);
  assert.match(lookupJs, /function open\([\s\S]*setProduct\("ATIS"\)/);
  assert.match(lookupCss, /\.aviation-lookup-panel-meteogram\{[\s\S]*width:min\(1680px,calc\(100vw - 24px\)\)/);
  assert.match(lookupCss, /\.aviation-lookup-panel\{[\s\S]*width:min\(820px,calc\(100vw - 32px\)\)/);
});

test("each product restores its own range so leaving meteogram returns ATIS to current", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  const dom = createLookupDom(clock);
  const module = await loadLookupController({
    doc: dom.doc,
    lookupAviationWeather: lookupHarness.lookup,
    renderAviationMeteogram: () => null,
  });
  const controller = module.initializeAviationWeatherLookup(dom.doc);
  dom.overlay.hidden = false;
  assert.equal(dom.rangeSelect.value, "recent");
  controller.setProduct("METEOGRAM");
  assert.equal(dom.rangeSelect.value, "24");
  controller.setProduct("ATIS");
  assert.equal(dom.rangeSelect.value, "recent", "the operational ATIS range is restored after leaving meteogram");
  const lookup = controller.runLookup();
  assert.equal(lookupHarness.calls.length, 1);
  assert.equal(lookupHarness.calls[0].options.product, "ATIS");
  assert.equal(lookupHarness.calls[0].options.range, "recent");
  lookupHarness.calls[0].task.resolve({ state: "unavailable", headline: "ATIS UNAVAILABLE", detail: "fixture", reports: [] });
  await lookup;
});

test("meteogram aliases to the established METAR history pipeline without a new endpoint", async () => {
  const request = meteogramLookupRequest({ station: "EGLL", range: "6" });
  const calls = [];
  const response = await lookupAviationWeather({
    ...request,
    now: new Date("2026-08-31T12:00:00Z"),
    fetchImpl: async (input) => {
      calls.push(String(input));
      return {
        ok: true,
        async text() {
          return "station,valid,metar\nLHR,2026-08-31 11:50,METAR EGLL 311150Z 24012KT 9999 BKN025 20/14 Q1018";
        },
      };
    },
  });
  assert.equal(response.state, "success");
  assert.equal(response.reports.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/mesonet\.agron\.iastate\.edu\/cgi-bin\/request\/asos\.py\?/);
  assert.doesNotMatch(calls.join(" "), /weather[_-]history|meteogram|atis\.guru/i);
  assert.match(lookupJs, /meteogramLookupRequest\(\{ station, range: rangeSelect\.value \}\)/);
  assert.match(lookupJs, /product: meteogramRequest\?\.product \|\| product/);
});

test("meteogram concurrently reuses the existing current TAF path and refreshes only while active", () => {
  assert.match(lookupJs, /const responsePromise = lookupAviationWeather\(lookupOptions\)/);
  assert.match(lookupJs, /product === "METEOGRAM"[\s\S]*lookupAviationWeather\(\{ \.\.\.lookupOptions, product: "TAF", range: "recent" \}\)/);
  assert.match(lookupJs, /tafReports: tafResponse\?\.state === "success" \? tafResponse\.reports : \[\]/);
  assert.match(lookupJs, /const METEOGRAM_REFRESH_MS = 5 \* 60 \* 1000/);
  assert.match(lookupJs, /if \(overlay\.hidden \|\| product !== "METEOGRAM"\) return;[\s\S]*await runLookup\(\{ preserveMeteogramView: true \}\)/);
  assert.match(lookupJs, /stopMeteogramRefresh\(\);[\s\S]*applyLookupDialogState/);
  assert.doesNotMatch(lookupJs, /weather[_-]forecast\.json|meteogram[_-](?:api|history)\.json/i);
});

test("meteogram refresh timer is singular, replaceable, and cancelled by product change or close", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  const dom = createLookupDom(clock);
  const module = await loadLookupController({
    doc: dom.doc,
    lookupAviationWeather: lookupHarness.lookup,
    renderAviationMeteogram: () => null,
  });
  const controller = module.initializeAviationWeatherLookup(dom.doc);
  dom.overlay.hidden = false;

  controller.setProduct("METEOGRAM");
  assert.equal(clock.activeIds().length, 0, "selection alone does not arm a refresh before a successful lookup");
  const firstLookup = controller.runLookup();
  lookupHarness.calls[0].task.resolve(successResponse("METAR"));
  lookupHarness.calls[1].task.resolve(successResponse("TAF"));
  await firstLookup;
  const [firstTimer] = clock.activeIds();
  assert.ok(firstTimer);
  assert.equal(clock.entries.get(firstTimer).milliseconds, 5 * 60 * 1000);

  const replacementLookup = controller.runLookup();
  assert.equal(clock.activeIds().length, 0, "a manual lookup cancels the old deadline while it is active");
  lookupHarness.calls[2].task.resolve(successResponse("METAR"));
  lookupHarness.calls[3].task.resolve(successResponse("TAF"));
  await replacementLookup;
  const [replacementTimer] = clock.activeIds();
  assert.ok(replacementTimer);
  assert.notEqual(replacementTimer, firstTimer);
  assert.deepEqual(clock.cleared, [firstTimer]);
  assert.equal(clock.activeIds().length, 1);

  controller.setProduct("METAR");
  assert.equal(clock.activeIds().length, 0);
  assert.deepEqual(clock.cleared, [firstTimer, replacementTimer]);

  controller.setProduct("METEOGRAM");
  assert.equal(clock.activeIds().length, 0);
  const closingLookup = controller.runLookup();
  lookupHarness.calls[4].task.resolve(successResponse("METAR"));
  lookupHarness.calls[5].task.resolve(successResponse("TAF"));
  await closingLookup;
  assert.equal(clock.activeIds().length, 1);
  controller.close();
  assert.equal(dom.overlay.hidden, true);
  assert.equal(clock.activeIds().length, 0);
  assert.equal(lookupHarness.calls.length, 6);
});

test("periodic meteogram refresh does not overlap and rearms only after both observed and TAF lookups settle", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  const renders = [];
  const preservedViewState = {
    settings: { timeMode: "Z", temperatureUnit: "C", windUnit: "MPH" },
    scrollLeft: 417,
    dataTableOpen: true,
    dataTableScrollLeft: 233,
    focusKey: "toggle:temperatureUnit:C",
  };
  const dom = createLookupDom(clock);
  const module = await loadLookupController({
    doc: dom.doc,
    lookupAviationWeather: lookupHarness.lookup,
    renderAviationMeteogram(_container, reports, options) {
      renders.push({ reports, options });
      return {
        model: {
          observations: reports,
          forecasts: options.tafReports,
          taf: {},
        },
        getViewState() { return preservedViewState; },
        destroy() {},
      };
    },
  });
  const controller = module.initializeAviationWeatherLookup(dom.doc);
  dom.overlay.hidden = false;
  controller.setProduct("METEOGRAM");

  const initialLookup = controller.runLookup();
  lookupHarness.calls[0].task.resolve(successResponse("METAR"));
  lookupHarness.calls[1].task.resolve(successResponse("TAF"));
  await initialLookup;
  assert.equal(clock.activeIds().length, 1);

  const firstRefresh = Promise.resolve(clock.fire(clock.activeIds()[0]));
  assert.equal(lookupHarness.calls.length, 4);
  assert.deepEqual(lookupHarness.calls.slice(2).map((call) => call.options.product), ["METAR", "TAF"]);
  assert.equal(clock.activeIds().length, 0, "no second interval is armed during an in-flight refresh");

  await Promise.resolve();
  assert.equal(lookupHarness.calls.length, 4, "an unresolved refresh cannot start another cycle");
  lookupHarness.calls[2].task.resolve(successResponse("METAR"));
  lookupHarness.calls[3].task.resolve(successResponse("TAF"));
  await firstRefresh;
  assert.equal(renders.length, 2);
  assert.deepEqual(renders[1].options.initialViewState, preservedViewState, "automatic TAF refresh preserves units, both horizontal positions, disclosure state, and focused control identity");
  assert.equal(clock.activeIds().length, 1, "the next refresh is scheduled from completion");

  const secondRefresh = Promise.resolve(clock.fire(clock.activeIds()[0]));
  assert.equal(lookupHarness.calls.length, 6);
  assert.equal(clock.activeIds().length, 0);
  const secondSignal = lookupHarness.calls[4].options.signal;
  controller.close();
  assert.equal(secondSignal.aborted, true);
  lookupHarness.calls[4].task.resolve(successResponse("METAR"));
  lookupHarness.calls[5].task.resolve(successResponse("TAF"));
  await secondRefresh;
  assert.equal(renders.length, 2, "a refresh completed after close cannot replace the UI");
  assert.equal(clock.activeIds().length, 0, "a refresh completed after close cannot rearm itself");
});

test("station edits abort stale meteogram work and only an explicit new lookup renders the edited ICAO", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  const renders = [];
  const dom = createLookupDom(clock);
  const module = await loadLookupController({
    doc: dom.doc,
    lookupAviationWeather: lookupHarness.lookup,
    renderAviationMeteogram(_container, reports, options) {
      renders.push({ reports, options });
      return {
        model: { observations: reports, forecasts: options.tafReports, taf: {} },
        destroy() {},
      };
    },
  });
  const controller = module.initializeAviationWeatherLookup(dom.doc);
  dom.overlay.hidden = false;
  controller.setProduct("METEOGRAM");

  const staleLookup = controller.runLookup();
  assert.equal(lookupHarness.calls.length, 2);
  const staleSignal = lookupHarness.calls[0].options.signal;
  dom.stationInput.value = "katl";
  dom.stationInput.dispatch("input");
  assert.equal(dom.stationInput.value, "KATL");
  assert.equal(staleSignal.aborted, true);
  assert.equal(lookupHarness.calls.length, 2, "typing does not immediately fetch the edited station");
  assert.equal(clock.activeIds().length, 0, "editing an ICAO leaves no stale automatic-refresh deadline");
  assert.match(dom.elements.get("aviationWeatherLookupStatus").children[0].textContent, /READY/);

  lookupHarness.calls[0].task.resolve(successResponse("METAR"));
  lookupHarness.calls[1].task.resolve(successResponse("TAF"));
  await staleLookup;
  assert.equal(renders.length, 0, "stale results are discarded after a station edit");

  const explicitLookup = controller.runLookup();
  assert.equal(lookupHarness.calls.length, 4);
  assert.deepEqual(lookupHarness.calls.slice(2).map((call) => call.options.station), ["KATL", "KATL"]);
  lookupHarness.calls[2].task.resolve(successResponse("METAR"));
  lookupHarness.calls[3].task.resolve(successResponse("TAF"));
  await explicitLookup;
  assert.equal(renders.length, 1);
  assert.equal(renders[0].options.station, "KATL");
  assert.equal(clock.activeIds().length, 1);
  dom.stationInput.value = "kmem";
  dom.stationInput.dispatch("input");
  assert.equal(clock.activeIds().length, 0, "the next station edit cancels the completed lookup's refresh");
  controller.close();
});

test("switching away aborts meteogram work and time/unit control clicks do not refetch", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  let renderCount = 0;
  const dom = createLookupDom(clock);
  const module = await loadLookupController({
    doc: dom.doc,
    lookupAviationWeather: lookupHarness.lookup,
    renderAviationMeteogram(_container, reports, options) {
      renderCount += 1;
      return {
        model: { observations: reports, forecasts: options.tafReports, taf: {} },
        destroy() {},
      };
    },
  });
  const controller = module.initializeAviationWeatherLookup(dom.doc);
  dom.overlay.hidden = false;
  controller.setProduct("METEOGRAM");
  const meteogramLookup = controller.runLookup();
  assert.equal(clock.activeIds().length, 0);
  const meteogramSignal = lookupHarness.calls[0].options.signal;

  controller.setProduct("METAR");
  const metarLookup = controller.runLookup();
  assert.equal(meteogramSignal.aborted, true);
  assert.equal(clock.activeIds().length, 0);
  lookupHarness.calls[0].task.resolve(successResponse("METAR"));
  lookupHarness.calls[1].task.resolve(successResponse("TAF"));
  lookupHarness.calls[2].task.resolve(successResponse("METAR"));
  await Promise.all([meteogramLookup, metarLookup]);
  assert.equal(renderCount, 0, "superseded meteogram work cannot render after a product switch");

  controller.setProduct("METEOGRAM");
  const currentLookup = controller.runLookup();
  lookupHarness.calls[3].task.resolve(successResponse("METAR"));
  lookupHarness.calls[4].task.resolve(successResponse("TAF"));
  await currentLookup;
  assert.equal(renderCount, 1);
  const networkCount = lookupHarness.calls.length;
  const timerIds = clock.activeIds();

  for (const [setting, value] of [["timeMode", "Z"], ["temperatureUnit", "C"], ["windUnit", "MPH"]]) {
    dom.doc.dispatch("click", {
      target: {
        dataset: { meteogramSetting: setting, meteogramValue: value },
        closest() { return null; },
      },
    });
  }
  await Promise.resolve();
  assert.equal(lookupHarness.calls.length, networkCount, "display-only toggles never invoke the lookup controller");
  assert.deepEqual(clock.activeIds(), timerIds, "display-only toggles do not reschedule forecast refresh");
  controller.close();
});

test("meteogram renderer uses one shared timeline and includes every requested observed band", () => {
  assert.match(meteogramJs, /<svg class="aviation-meteogram-svg"/);
  for (const title of ["WEATHER", "TEMPERATURE", "DEW POINT", "TEMP LINE", "DEW POINT LINE", "WIND", "PRESSURE", "CLOUDS / CIG", "VISIBILITY", "PRECIP (IN)", "SNOW (IN)"]) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(meteogramJs, new RegExp(`title: "${escapedTitle}"`));
  }
  assert.match(meteogramJs, /aviation-meteogram-temperature-row/);
  assert.match(meteogramJs, /aviation-meteogram-dew-point-row/);
  assert.match(meteogramJs, /aviation-meteogram-temp-line-row/);
  assert.match(meteogramJs, /aviation-meteogram-dew-line-row/);
  assert.match(meteogramJs, /aviation-meteogram-temp-line/);
  assert.match(meteogramJs, /aviation-meteogram-dew-line/);
  assert.match(meteogramJs, /aviation-meteogram-temp-spread/);
  assert.match(meteogramJs, /aviation-meteogram-time-line/);
  assert.match(meteogramJs, /time-proportional timeline/);
  assert.match(meteogramJs, /spanHours \* pixelsPerHour/);
  assert.doesNotMatch(meteogramJs, /wind[-_ ]barb|aviation-meteogram-wind-barb/i);
  assert.match(meteogramJs, /DOWNWIND ARROW/);
});

test("current TAF forecast is visibly separated and never presented as observed precision", () => {
  assert.match(meteogramJs, /NOW \/ FORECAST/);
  assert.match(meteogramJs, /aviation-meteogram-forecast-background/);
  assert.match(meteogramJs, /TEMPO\/PROB REMAIN CONDITIONAL/);
  assert.match(meteogramJs, /TEMP\/DP\/QPF\/SNOW = NWS GRID/);
  assert.match(meteogramCore, /block\.type === "BECOMING"[\s\S]*at: end/);
  assert.match(meteogramCore, /\["INITIAL", "FROM", "BECOMING"\]\.includes\(block\.type\)/);
  assert.match(meteogramCore, /forecastPrecipitationIntervals/);
  assert.match(meteogramCore, /fieldProvenance/);
  assert.match(meteogramJs, /conditionalWind/);
  assert.match(meteogramJs, /cloudLayersForObservation/);
  assert.match(meteogramJs, /conditionalVisibility/);
  assert.doesNotMatch(meteogramCore, /probabilityOfPrecipitationIntervals/);
});

test("NWS-only forecast buckets and TAF-unavailable states never masquerade as current TAF", () => {
  for (const token of ["CNL", "NIL", "INTER 0103/0106 18008KT P6SM SCT050"]) {
    const model = buildMeteogramModel([meteogramReport()], {
      station: "KMEM",
      tafReports: [{
        station: "KMEM",
        timestamp: "2026-09-01T02:00:00Z",
        product: "TAF",
        raw: `TAF AMD KMEM 010200Z 0103/0206 ${token}`,
        source: "Current TAF fixture",
      }],
      supplementalForecast: nwsGridEnvelope(),
      now: new Date("2026-09-01T03:15:00Z"),
    });
    assert.deepEqual(meteogramForecastSourceState(model), { hasTaf: false, hasNws: true, label: "NWS GRID" });
    assert.ok(model.taf?.warning, `${token} should retain the unsafe/unusable TAF warning`);
    assert.match(meteogramSubtitleText(model), /CURRENT TAF AVIATION FIELDS UNAVAILABLE OR NOT SAFELY PLOTTED/);
    const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
    const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
    assert.match(svg, /aviation-meteogram-forecast-tag[^>]*>NWS GRID<\/text>/);
    assert.doesNotMatch(svg, /aviation-meteogram-forecast-tag[^>]*>TAF<\/text>/);
    assert.match(table, /NWS GRID forecast/);
    assert.match(table, /No current TAF aviation fields are represented in this bucket/);
    assert.doesNotMatch(table, /TAF forecast/);
  }

  const shortTafModel = buildMeteogramModel([meteogramReport()], {
    station: "KMEM",
    tafReports: [{
      station: "KMEM", timestamp: "2026-09-01T02:00:00Z", product: "TAF",
      raw: "TAF KMEM 010200Z 0103/0106 18008KT P6SM SCT050",
      source: "Current TAF fixture",
    }],
    supplementalForecast: nwsGridEnvelope(),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.deepEqual(meteogramForecastSourceState(shortTafModel), { hasTaf: true, hasNws: true, label: "TAF / NWS" });
  const nwsTail = shortTafModel.forecasts.find((bucket) => bucket.validZ === "2026-09-01T08:00:00.000Z");
  assert.equal(nwsTail.supplementalOnly, true);
  assert.equal(nwsTail.tafIssuanceZ, null);
  assert.match(buildMeteogramAccessibleTableMarkup(shortTafModel, { timeMode: "Z" }), /NWS GRID forecast/);
});

test("LOCAL/Z, F/C, and KT/MPH toggles rerender live without another lookup", () => {
  for (const contract of [
    ["timeMode", "LOCAL"], ["timeMode", "Z"],
    ["temperatureUnit", "F"], ["temperatureUnit", "C"],
    ["windUnit", "KT"], ["windUnit", "MPH"],
  ]) {
    assert.match(meteogramJs, new RegExp(`value: "${contract[1]}"`));
  }
  assert.match(meteogramJs, /controls\.addEventListener\("click"[\s\S]*settings\[setting\] = button\.dataset\.meteogramValue;[\s\S]*draw\(\)/);
  assert.doesNotMatch(meteogramJs, /fetch\s*\(/);
  assert.match(meteogramJs, /setAttribute\("aria-pressed", selected \? "true" : "false"\)/);
  assert.match(meteogramJs, /const defaultSettings = \{\s*timeMode: "Z",\s*temperatureUnit: "C",\s*windUnit: "KT"/);
});

test("truthful missing, precipitation, source, and gap language is visible", () => {
  assert.match(meteogramJs, /UNIFIED WEATHER TIMELINE · EXACT METAR \/ SPECI HISTORY \+ CURRENT TAF/);
  assert.match(meteogramJs, /CURRENT TAF UNAVAILABLE/);
  assert.match(meteogramJs, /MISSING VALUES SHOWN AS —/);
  assert.match(meteogramJs, /GAPS OVER 2\.5 HR DISCONNECTED/);
  assert.match(meteogramJs, /POP IS NOT AMOUNT/);
  assert.match(meteogramJs, /TX\/TN ARE SEPARATE TAF EXTREMA/);
  assert.match(meteogramCore, /liquidTrace/);
  assert.match(meteogramCore, /intervalContaining/);
});

test("responsive layout keeps minimum chart width inside its own scroller", () => {
  assert.match(meteogramCss, /\.aviation-meteogram\{[\s\S]*min-width:0;[\s\S]*overflow:hidden/);
  assert.match(meteogramCss, /\.aviation-meteogram-scroll\{[\s\S]*max-width:100%;[\s\S]*min-width:0;[\s\S]*overflow-x:auto/);
  assert.match(lookupCss, /\.aviation-lookup-panel-meteogram \.aviation-lookup-results\{[\s\S]*min-width:0/);
  assert.match(lookupCss, /@media \(max-width:768px\)\{[\s\S]*\.aviation-lookup-products\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:950px\)\{[\s\S]*\.aviation-lookup-product-short\{display:inline\}/);
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(meteogramCss, /@media \(max-width:768px\)\{[\s\S]*\.aviation-meteogram-toggle\{min-height:40px/);
  assert.match(meteogramCss, /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(meteogramCss, /\.aviation-meteogram-stage\{[\s\S]*position:relative/);
  assert.match(meteogramCss, /\.aviation-meteogram-sticky-labels\{[\s\S]*position:sticky;[\s\S]*left:0/);
  assert.match(meteogramCss, /overscroll-behavior-x:contain/);
  assert.match(meteogramCss, /overscroll-behavior-y:auto/);
  assert.match(meteogramCss, /touch-action:pan-x pan-y/);
  assert.doesNotMatch(meteogramCss, /touch-action:pan-x;/);
  assert.doesNotMatch(meteogramCss, /overflow-x:hidden/);
  assert.doesNotMatch(meteogramCss, /width:\s*100vw/);
});

test("keyboard and screen-reader users have a live unit-aware text data table", () => {
  assert.match(meteogramJs, /doc\.createElement\("details"\)/);
  assert.match(meteogramJs, /dataSummary\.textContent = "TEXT DATA TABLE"/);
  assert.match(meteogramJs, /buildMeteogramAccessibleTableMarkup\(model, settings\)/);
  assert.match(meteogramJs, /<caption>/);
  for (const heading of ["Time", "Type", "Temperature", "Dew point", "Wind", "Clouds / ceiling", "PRECIP (IN)", "SNOW (IN)", "Source / valid-interval semantics"]) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(meteogramJs, new RegExp(`>${escapedHeading}`));
  }
  assert.match(meteogramCss, /\.aviation-meteogram-data-scroll\{[\s\S]*max-width:100%;[\s\S]*overflow:auto/);
  assert.match(meteogramJs, /dataTableScroller\.tabIndex = 0/);
  assert.match(meteogramJs, /dataTableScroller\.setAttribute\("role", "region"\)/);
  assert.match(meteogramJs, /dataTableScroller\.setAttribute\("aria-label", `\$\{model\.station\} meteogram text data table/);
  assert.match(meteogramCss, /\.aviation-meteogram-data-scroll:focus-visible/);
  assert.match(meteogramJs, /getViewState\(\)[\s\S]*settings: \{ \.\.\.settings \}[\s\S]*scrollLeft: scroller\.scrollLeft[\s\S]*dataTableOpen[\s\S]*dataTableScrollLeft[\s\S]*focusKey/);
  assert.match(meteogramJs, /restoredFocusKey === "timeline"[\s\S]*restoredFocusKey === "table-summary"[\s\S]*restoredFocusKey === "table-scroll"[\s\S]*restoredFocusKey\.startsWith\("toggle:"\)[\s\S]*focusTarget\?\.focus/);
  assert.match(lookupJs, /runLookup\(\{ preserveMeteogramView: true \}\)/);
});

test("default meteogram presentation is Zulu, Celsius, and knots with four exact temperature/dew rows", () => {
  const model = manualMeteogramModel([manualMeteogramPoint({ temperatureC: 0, dewPointC: -5 })]);
  const svg = buildMeteogramSvgMarkup(model);
  assert.match(svg, />0000Z</);
  assert.match(svg, /aviation-meteogram-temperature-value[^>]*>0°</);
  assert.doesNotMatch(svg, /aviation-meteogram-temperature-value[^>]*>32°</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>12 KT</);
  const orderedLabels = [">TEMPERATURE<", ">DEW POINT<", ">TEMP LINE<", ">DEW POINT LINE<"];
  let previous = -1;
  for (const label of orderedLabels) {
    const index = svg.indexOf(label);
    assert.ok(index > previous, `${label} follows the prior exact row label`);
    previous = index;
  }
  assert.match(svg, /class="aviation-meteogram-temperature-row"/);
  assert.match(svg, /class="aviation-meteogram-dew-point-row"/);
  assert.match(svg, /class="aviation-meteogram-temp-line-row"/);
  assert.match(svg, /class="aviation-meteogram-dew-line-row"/);
  assert.doesNotMatch(svg, /temp-pair|pair-separator/);
});

test("separate temp and dew trend rows use one affine domain and preserve spread through unit conversion", () => {
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-01T00:00:00Z", temperatureC: 30, dewPointC: 12 }),
    manualMeteogramPoint({ observedZ: "2026-09-01T01:00:00Z", temperatureC: 21, dewPointC: 20 }),
  ];
  const model = manualMeteogramModel(timeline);
  const dimensions = meteogramDimensions(timeline, 1000);
  const c = meteogramTemperatureGeometry(model, { temperatureUnit: "C" }, dimensions);
  const f = meteogramTemperatureGeometry(model, { temperatureUnit: "F" }, dimensions);
  const wide = Math.abs(c.temperaturePoints[0].y - c.dewPointPoints[0].y);
  const narrow = Math.abs(c.temperaturePoints[1].y - c.dewPointPoints[1].y);
  assert.ok(wide > narrow * 17.99 && wide < narrow * 18.01, "18°C spread is eighteen times the 1°C spread");
  for (let index = 0; index < timeline.length; index += 1) {
    assert.ok(Math.abs(c.temperaturePoints[index].y - f.temperaturePoints[index].y) < 1e-9);
    assert.ok(Math.abs(c.dewPointPoints[index].y - f.dewPointPoints[index].y) < 1e-9);
  }
  const svg = buildMeteogramSvgMarkup(model, { temperatureUnit: "C", timeMode: "Z" });
  const domains = [...svg.matchAll(/data-domain-min="([^"]+)" data-domain-max="([^"]+)"/g)];
  assert.equal(domains.length, 2);
  assert.deepEqual(domains[0].slice(1), domains[1].slice(1), "both semantic line rows publish the identical domain");
});

test("temperature and dew trends cross NOW only with adjacent valid recent values and never bridge missing data", () => {
  const observed = manualMeteogramPoint({ observedZ: "2026-09-01T02:54:00Z", temperatureC: 24, dewPointC: 18 });
  const forecast = manualMeteogramPoint({
    kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-01T03:15:00Z", validZ: "2026-09-01T03:15:00Z",
    temperatureC: 25, dewPointC: 19,
  });
  const continuous = buildMeteogramSvgMarkup(manualMeteogramModel([observed, forecast]), { timeMode: "Z" });
  assert.equal((continuous.match(/aviation-meteogram-line-seam/g) || []).length, 2);
  assert.match(continuous, /aviation-meteogram-temp-line aviation-meteogram-line-forecast/);
  assert.match(continuous, /aviation-meteogram-dew-line aviation-meteogram-line-forecast/);

  const missingDew = buildMeteogramSvgMarkup(manualMeteogramModel([
    observed, { ...forecast, dewPointC: null },
  ]), { timeMode: "Z" });
  assert.equal((missingDew.match(/aviation-meteogram-line-seam/g) || []).length, 1);

  const stale = buildMeteogramSvgMarkup(manualMeteogramModel([
    observed, { ...forecast, observedZ: "2026-09-01T06:00:00Z", validZ: "2026-09-01T06:00:00Z" },
  ]), { timeMode: "Z" });
  assert.equal((stale.match(/aviation-meteogram-line-seam/g) || []).length, 0);
});

test("wind arrows use normalized downwind semantics and fixed row containment for directional, calm, and VRB blocks", () => {
  assert.equal(meteogramWindArrowRotation(0), 180);
  assert.equal(meteogramWindArrowRotation(90), 270);
  assert.equal(meteogramWindArrowRotation(180), 0);
  assert.equal(meteogramWindArrowRotation(240), 60);
  assert.equal(meteogramWindArrowRotation(359), 179);
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-01T00:00:00Z", windDirectionDeg: 0, windSpeedKt: 0 }),
    manualMeteogramPoint({ observedZ: "2026-09-01T01:00:00Z", windDirectionDeg: null, windVariable: true, windSpeedKt: 4 }),
    manualMeteogramPoint({ observedZ: "2026-09-01T02:00:00Z", windDirectionDeg: 240, windSpeedKt: 12, windGustKt: 19 }),
  ];
  const svg = buildMeteogramSvgMarkup(manualMeteogramModel(timeline), { windUnit: "KT", timeMode: "Z" }, { viewportWidth: 1200 });
  assert.match(svg, /clipPath id="aviationMeteogramWindClip"/);
  assert.match(svg, /class="aviation-meteogram-wind-row" clip-path="url\(#aviationMeteogramWindClip\)"/);
  assert.equal((svg.match(/class="aviation-meteogram-wind-arrow"/g) || []).length, 1);
  assert.match(svg, /rotate\(60\)/);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>CALM</);
  assert.doesNotMatch(svg, />CALM 0|>CALM<[^]*?aviation-meteogram-wind-speed[^>]*>0 KT/);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>VRB</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>4 KT</);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>240°</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>12 KT</);
  assert.match(svg, /aviation-meteogram-wind-gust[^>]*>G19</);
});

test("cloud field positions every reported base, distinguishes coverage and VV, and emphasizes only the true ceiling", () => {
  assert.ok(meteogramCloudBaseY(500, 10000) > meteogramCloudBaseY(5000, 10000));
  assert.ok(meteogramCloudBaseY(5000, 10000) > meteogramCloudBaseY(10000, 10000));
  assert.equal(meteogramCloudBaseY(null, 10000), null);
  const clouds = {
    layers: [
      { cover: "FEW", heightFt: 2000, convective: "", raw: "FEW020" },
      { cover: "SCT", heightFt: 4500, convective: "", raw: "SCT045" },
      { cover: "BKN", heightFt: 8000, convective: "", raw: "BKN080" },
      { cover: "OVC", heightFt: 10000, convective: "", raw: "OVC100" },
      { cover: "VV", heightFt: null, convective: "", raw: "VV///" },
    ],
    clear: false, cavok: false, ceilingFt: 8000,
    display: "FEW020 · SCT045 · BKN080 · OVC100 · VV///",
  };
  const svg = buildMeteogramSvgMarkup(manualMeteogramModel([
    manualMeteogramPoint({ clouds }),
  ]), { timeMode: "Z" });
  for (const token of ["FEW020", "SCT045", "BKN080", "OVC100", "VV///"]) assert.match(svg, new RegExp(token.replace("/", "\\/")));
  for (const cover of ["FEW", "SCT", "BKN", "OVC"]) {
    assert.match(svg, new RegExp(`cloud-layer-${cover}`));
    assert.match(svg, new RegExp(`data-cloud-form="${cover}"`));
  }
  assert.match(svg, /cloud-unknown[^>]*[\s\S]*VV\/\/\/ BASE UNKNOWN/);
  assert.equal((svg.match(/aviation-meteogram-cloud-layer-ceiling/g) || []).length, 1, "only BKN080 is the known lowest ceiling");
  assert.match(svg, /data-base-ft="2000"/);
  assert.match(svg, /data-base-ft="10000"/);
  assert.match(svg, /data-cloud-label="BKN080"/);
  assert.match(svg, />CIG 8,000 FT</);
  assert.match(svg, /cloud top not reported/);
  assert.doesNotMatch(svg, /data-top-ft/);
  assert.doesNotMatch(svg, /<pattern\b|id="aviationMeteogramCloud(?:Few|Scattered|Broken|Vertical)"/, "legacy patterned cloud blocks are gone");

  const verticalVisibility = buildMeteogramSvgMarkup(manualMeteogramModel([
    manualMeteogramPoint({
      clouds: {
        layers: [{ cover: "VV", heightFt: 500, convective: "", raw: "VV005" }],
        clear: false, cavok: false, ceilingFt: 500, display: "VV005",
      },
    }),
  ]), { timeMode: "Z" });
  assert.match(verticalVisibility, /data-cloud-form="VV"/);
  assert.match(verticalVisibility, /aviation-meteogram-cloud-vv-veil/);
  assert.match(verticalVisibility, /data-cloud-label="VV005"/);
  assert.match(verticalVisibility, />CIG 500 FT</);

  const clear = buildMeteogramSvgMarkup(manualMeteogramModel([
    manualMeteogramPoint(),
  ]), { timeMode: "Z" });
  assert.doesNotMatch(clear, /data-cloud-form=/, "CLR/SKC produces no fabricated cloud layer");
  const table = buildMeteogramAccessibleTableMarkup(manualMeteogramModel([
    manualMeteogramPoint({ clouds }),
  ]), { timeMode: "Z" });
  for (const token of ["FEW020", "SCT045", "BKN080", "OVC100", "VV///"]) assert.match(table, new RegExp(token.replace("/", "\\/")));
});

test("cloud label collision priority keeps the ceiling and hides labels only, never underlying layers", () => {
  const layers = [
    { cover: "FEW", heightFt: 2200, raw: "FEW022", ceilingFt: 2500 },
    { cover: "SCT", heightFt: 2400, raw: "SCT024", ceilingFt: 2500 },
    { cover: "BKN", heightFt: 2500, raw: "BKN025", ceilingFt: 2500 },
    { cover: "OVC", heightFt: 8000, raw: "OVC080", ceilingFt: 2500 },
  ];
  const layout = meteogramCloudLabelLayout(layers, 10000, { minimumGapPx: 18 });
  assert.equal(layout[2].visible, true, "the actual ceiling label wins a tight collision");
  assert.equal(layout[2].isCeiling, true);
  assert.equal(layout[0].visible, false);
  assert.equal(layout[1].visible, false);
  assert.equal(layout[3].visible, true, "a separated higher layer remains labeled");
  assert.ok(layout.filter((entry) => entry.visible).every((entry) => entry.y > 542 && entry.y < 762));

  const clouds = { layers: layers.map(({ ceilingFt: _ceilingFt, ...layer }) => layer), clear: false, cavok: false, ceilingFt: 2500, display: "FEW022 · SCT024 · BKN025 · OVC080" };
  const model = manualMeteogramModel([manualMeteogramPoint({ clouds })]);
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
  assert.equal((svg.match(/data-cloud-form=/g) || []).length, 4, "every exact layer remains rendered despite label suppression");
  assert.match(svg, /data-cloud-label="BKN025"/);
  assert.match(svg, />CIG 2,500 FT</);
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  for (const token of ["FEW022", "SCT024", "BKN025", "OVC080"]) assert.match(table, new RegExp(token));

  const adjacentColumns = [
    manualMeteogramPoint({ clouds: { layers: [{ cover: "SCT", heightFt: 2500, raw: "SCT025" }], clear: false, cavok: false, ceilingFt: null, display: "SCT025" } }),
    manualMeteogramPoint({ clouds: { layers: [{ cover: "BKN", heightFt: 2500, raw: "BKN025" }], clear: false, cavok: false, ceilingFt: 2500, display: "BKN025" } }),
  ];
  assert.deepEqual(meteogramCloudColumnLabelMask(adjacentColumns, [200, 270]), [false, true], "the actual ceiling wins a cross-column collision");
  const subHourlyColumns = [adjacentColumns[0], adjacentColumns[1], adjacentColumns[0]];
  assert.deepEqual(meteogramCloudColumnLabelMask(subHourlyColumns, [200, 240, 280]), [false, true, false], "sub-hourly cloud labels remain collision-free");
  const multipleUnknownBases = manualMeteogramPoint({
    clouds: {
      layers: [
        { cover: "VV", heightFt: null, raw: "VV///" },
        { cover: "BKN", heightFt: null, raw: "BKN///", conditional: true, conditionalLabel: "TMP" },
      ],
      clear: false, cavok: false, ceilingFt: null, display: "VV/// · BKN///",
    },
  });
  assert.deepEqual(meteogramCloudColumnLabelMask([multipleUnknownBases, adjacentColumns[0]], [200, 300]), [true, false], "joined unknown-base text participates in cross-column collision sizing");

  const tickLayout = meteogramCloudTickLayout([500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000], 25000);
  const visibleTicks = tickLayout.filter((entry) => entry.visible);
  assert.ok(visibleTicks.length < tickLayout.length, "the expanded altitude scale suppresses colliding text labels");
  for (let index = 1; index < visibleTicks.length; index += 1) {
    assert.ok(Math.abs(visibleTicks[index].y - visibleTicks[index - 1].y) >= 13);
  }
});

test("KMEM solar calculations are deterministic, DST-aware, and fail closed for other stations", () => {
  assert.equal(meteogramSolarPhase("2026-09-01T18:00:00Z"), "day");
  assert.equal(meteogramSolarPhase("2026-09-01T06:00:00Z"), "night");
  assert.equal(meteogramSolarPhase("not-a-time"), null);
  assert.equal(meteogramSolarPhase("2026-09-01T18:00:00Z", { station: "KATL" }), null);

  const september = meteogramSolarEvents("2026-08-31T23:54:00Z", "2026-09-02T06:00:00Z");
  assert.deepEqual(september.map(({ type, timestamp, localDate }) => ({ type, timestamp, localDate })), [
    { type: "sunset", timestamp: "2026-09-01T00:27:49.000Z", localDate: "2026-08-31" },
    { type: "sunrise", timestamp: "2026-09-01T11:32:40.000Z", localDate: "2026-09-01" },
    { type: "sunset", timestamp: "2026-09-02T00:26:27.000Z", localDate: "2026-09-01" },
  ]);
  assert.equal(meteogramSolarPhase(september[0].timestamp), "night", "sunset is the first nighttime instant");
  assert.equal(meteogramSolarPhase(september[1].timestamp), "day", "sunrise is the first daylight instant");

  const dstStart = meteogramSolarEvents("2026-03-08T05:00:00Z", "2026-03-09T05:00:00Z");
  assert.deepEqual(dstStart.map((event) => event.timestamp), ["2026-03-08T12:19:58.000Z", "2026-03-09T00:01:45.000Z"]);
  const dstEnd = meteogramSolarEvents("2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z");
  assert.deepEqual(dstEnd.map((event) => event.timestamp), ["2026-11-01T12:21:03.000Z", "2026-11-01T23:05:23.000Z"]);
  assert.deepEqual(meteogramSolarEvents("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", { station: "EGLL" }), []);
  assert.doesNotMatch(meteogramSolarJs, /fetch\s*\(/, "solar calculations stay browser-local with no request");
});

test("explicit clear observed and forecast buckets use vector sun/moon symbols independent of label mode", () => {
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-01T06:00:00Z" }),
    manualMeteogramPoint({ observedZ: "2026-09-01T18:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-02T06:00:00Z", validZ: "2026-09-02T06:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-02T18:00:00Z", validZ: "2026-09-02T18:00:00Z" }),
  ];
  const model = manualMeteogramModel(timeline);
  const zulu = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1200 });
  const local = buildMeteogramSvgMarkup(model, { timeMode: "LOCAL" }, { viewportWidth: 1200 });

  assert.equal((zulu.match(/data-weather-symbol="sun"/g) || []).length, 2);
  assert.equal((zulu.match(/data-weather-symbol="moon"/g) || []).length, 2);
  assert.equal((zulu.match(/data-solar-phase="day"/g) || []).length, 2);
  assert.equal((zulu.match(/data-solar-phase="night"/g) || []).length, 2);
  assert.match(zulu, /aviation-meteogram-forecast-column[\s\S]*?data-weather-symbol="moon"/);
  assert.match(zulu, /aviation-meteogram-forecast-column[\s\S]*?data-weather-symbol="sun"/);
  assert.doesNotMatch(zulu, />☀</, "explicit clear sky no longer depends on a platform emoji glyph");
  assert.deepEqual(
    [...zulu.matchAll(/data-solar-phase="(day|night)"/g)].map((match) => match[1]),
    [...local.matchAll(/data-solar-phase="(day|night)"/g)].map((match) => match[1]),
    "LOCAL/Z affects labels only, never daylight classification",
  );
  assert.deepEqual(renderedSolarGeometry(zulu), renderedSolarGeometry(local), "LOCAL/Z leaves solar event instants and x geometry unchanged");
});

test("sunrise and sunset markers use exact shared timeline geometry across multiple days", () => {
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-01T06:00:00Z" }),
    manualMeteogramPoint({ observedZ: "2026-09-01T18:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", validZ: "2026-09-02T06:00:00Z", observedZ: "2026-09-02T06:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", validZ: "2026-09-02T18:00:00Z", observedZ: "2026-09-02T18:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", validZ: "2026-09-03T06:00:00Z", observedZ: "2026-09-03T06:00:00Z" }),
  ];
  const model = manualMeteogramModel(timeline);
  const dimensions = meteogramDimensions(timeline, 1200);
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1200 });
  const geometry = renderedSolarGeometry(svg);
  assert.equal(geometry.length, 4, "two sunrise and two sunset events fall in this 48-hour domain");
  assert.deepEqual(geometry.map((event) => event.type), ["sunrise", "sunset", "sunrise", "sunset"]);
  for (const event of geometry) {
    assert.ok(Math.abs(event.x - dimensions.xForTime(event.timestamp)) <= 0.1, `${event.type} aligns to xForTime`);
  }
  assert.equal((svg.match(/data-solar-label=/g) || []).length, 4);
  assert.ok(svg.indexOf("data-solar-event=") < svg.indexOf("aviation-meteogram-observation"), "solar reference lines render behind weather and meteorological data");
  assert.ok(svg.indexOf("data-solar-label=") < svg.indexOf("aviation-meteogram-now-divider"), "NOW remains visually above solar labels");
  assert.match(svg, /SUNRISE/);
  assert.match(svg, /SUNSET/);
});

test("CAVOK and non-clear weather retain their existing symbols while unsupported stations omit KMEM solar truth", () => {
  const cavok = manualMeteogramPoint({
    clouds: { layers: [], clear: false, cavok: true, ceilingFt: null, display: "CAVOK" },
    weather: { icon: "◒", label: "CAVOK" },
  });
  const rain = manualMeteogramPoint({
    observedZ: "2026-09-01T01:00:00Z",
    clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
    weatherCodes: ["-RA"],
    weather: { icon: "☂", label: "RAIN" },
  });
  const svg = buildMeteogramSvgMarkup(manualMeteogramModel([cavok, rain]), { timeMode: "Z" });
  assert.match(svg, />◒<\/text>/);
  assert.match(svg, />☂<\/text>/);
  assert.doesNotMatch(svg, /data-weather-symbol=/);

  const unsupportedModel = manualMeteogramModel([manualMeteogramPoint()], { station: "KATL", timeZone: "America/New_York" });
  const unsupported = buildMeteogramSvgMarkup(unsupportedModel, { timeMode: "Z" });
  assert.doesNotMatch(unsupported, /data-solar-event=|data-weather-symbol=/);
  assert.match(unsupported, />·<\/text>/, "unsupported stations retain their existing explicit-clear glyph path");
});

test("observed and forecast weather symbols receive restrained semantic colors without changing weather codes", () => {
  const fixtures = [
    ["clear", manualMeteogramPoint()],
    ["cloud", manualMeteogramPoint({ clouds: { layers: [{ cover: "SCT", heightFt: 3000, raw: "SCT030" }], clear: false, cavok: false, ceilingFt: null, display: "SCT030" } })],
    ["rain", manualMeteogramPoint({ weatherCodes: ["-RA"] })],
    ["showers", manualMeteogramPoint({ weatherCodes: ["VCSH"] })],
    ["snow", manualMeteogramPoint({ weatherCodes: ["SN"] })],
    ["thunder", manualMeteogramPoint({ weatherCodes: ["TSRA"] })],
    ["significant", manualMeteogramPoint({ weatherCodes: ["SQ"] })],
    ["ice", manualMeteogramPoint({ weatherCodes: ["FZRA"] })],
    ["fog", manualMeteogramPoint({ weatherCodes: ["BR"] })],
    ["obscuration", manualMeteogramPoint({ weatherCodes: ["HZ"] })],
  ];
  for (const [category, point] of fixtures) {
    assert.equal(meteogramWeatherVisualCategory(point), category);
    assert.equal(meteogramWeatherVisualCategory({ ...point, kind: "FORECAST" }), category, `${category} uses the same forecast color category`);
    assert.match(meteogramCss, new RegExp(`\\.aviation-meteogram-weather-${category}\\{fill:`));
  }

  const observed = manualMeteogramPoint({
    observedZ: "2026-09-01T00:00:00Z", weatherCodes: ["TSRA"], weather: { icon: "⚡", label: "THUNDERSTORM RAIN" },
  });
  const forecast = manualMeteogramPoint({
    kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-01T03:00:00Z", validZ: "2026-09-01T03:00:00Z",
    weatherCodes: ["SN"], weather: { icon: "❄", label: "SNOW" },
  });
  const svg = buildMeteogramSvgMarkup(manualMeteogramModel([observed, forecast]), { timeMode: "Z" }, { viewportWidth: 1200 });
  assert.match(svg, /aviation-meteogram-weather-thunder" data-weather-category="thunder"/);
  assert.match(svg, /aviation-meteogram-forecast-column[\s\S]*aviation-meteogram-weather-snow" data-weather-category="snow"/);
  assert.match(svg, />TSRA</);
  assert.match(svg, />SN</);
  assert.match(meteogramCss, /\.aviation-meteogram-forecast-column \.aviation-meteogram-weather-icon\{opacity:\.78\}/);
});

test("QPF and snowfall render once across exact source intervals in inches and remain unchanged by temperature units", () => {
  const model = buildMeteogramModel([meteogramReport()], {
    station: "KMEM",
    supplementalForecast: nwsGridEnvelope(),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z", temperatureUnit: "C" }, { viewportWidth: 1200 });
  assert.match(svg, /height="924" viewBox="0 0 [\d.]+ 924"/);
  assert.match(svg, /id="aviationMeteogramCloudClip"><rect[^>]*y="542"[^>]*height="220"/);
  assert.match(svg, /id="aviationMeteogramPrecipClip"><rect[^>]*y="836"[^>]*height="44"/);
  assert.match(svg, /id="aviationMeteogramSnowClip"><rect[^>]*y="880"[^>]*height="44"/);
  assert.equal((svg.match(/aviation-meteogram-precip-interval aviation-meteogram-interval-forecast/g) || []).length, 2, "two 6-hour totals are not replicated into hourly buckets");
  assert.equal((svg.match(/aviation-meteogram-snow-interval aviation-meteogram-interval-forecast/g) || []).length, 1);
  assert.match(svg, /data-valid-start="2026-09-01T06:00:00\.000Z" data-valid-end="2026-09-01T12:00:00\.000Z" data-amount-in="1"/);
  assert.match(svg, /data-amount-in="0"/);
  assert.match(svg, /FORECAST SNOWFALL 0\.10 IN/);
  assert.match(svg, /aviation-meteogram-interval-zero/);
  const dimensions = meteogramDimensions(model.timeline, 1200, {
    extraTimes: [...model.forecastPrecipitationIntervals, ...model.forecastSnowfallIntervals].flatMap((interval) => [interval.validStartZ, interval.validEndZ]),
  });
  const qpf = svg.match(/aviation-meteogram-precip-interval aviation-meteogram-interval-forecast[\s\S]*?<rect class="aviation-meteogram-interval-bar" x="([\d.]+)"[^>]*width="([\d.]+)"/);
  assert.ok(qpf);
  assert.ok(Math.abs(Number(qpf[2]) - (dimensions.xForTime("2026-09-01T12:00:00Z") - dimensions.xForTime("2026-09-01T06:00:00Z"))) < 0.2);
  let compactBarCount = 0;
  for (const [type, top, bottom] of [["precip", 836, 880], ["snow", 880, 924]]) {
    const pattern = new RegExp(`<g class="aviation-meteogram-interval aviation-meteogram-${type}-interval(?:(?!<\\/g>)[\\s\\S])*?<rect class="aviation-meteogram-interval-bar" x="[\\d.]+" y="([\\d.]+)" width="[\\d.]+" height="([\\d.]+)"`, "g");
    for (const [, yText, heightText] of svg.matchAll(pattern)) {
      compactBarCount += 1;
      const y = Number(yText);
      const barHeight = Number(heightText);
      assert.ok(y >= top && y + barHeight <= bottom, `${type} bar stays inside its compact row`);
      assert.ok(barHeight <= 14, `${type} bar uses the compact 14px maximum`);
    }
  }
  assert.ok(compactBarCount >= 2);
  const tableC = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z", temperatureUnit: "C" });
  const tableF = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z", temperatureUnit: "F" });
  for (const table of [tableC, tableF]) {
    assert.match(table, />PRECIP \(IN\)</);
    assert.match(table, />SNOW \(IN\)</);
    assert.match(table, /1\.00 IN/);
    assert.match(table, /0\.10 IN/);
    assert.match(table, /0600Z–1200Z/);
    assert.match(table, /TOTAL LIQUID EQUIVALENT; NOT POP/);
  }

  const tinyAmountModel = manualMeteogramModel([manualMeteogramPoint()], {
    forecastPrecipitationIntervals: [{
      validStartZ: "2026-09-01T06:00:00.000Z",
      validEndZ: "2026-09-01T12:00:00.000Z",
      amountIn: 0.1 / 25.4,
      source: "NWS tiny-total fixture",
    }],
  });
  assert.match(buildMeteogramSvgMarkup(tinyAmountModel, { timeMode: "Z" }), /&lt;0\.01 IN/, "a positive sub-hundredth-inch amount never renders as zero");
});

test("trace and snow depth stay distinct from quantitative bars while weather occurrence alone remains unavailable", () => {
  const reports = [
    meteogramReport({ timestamp: "2026-08-31T23:54:00Z", raw: "METAR KMEM 312354Z 00000KT 10SM CLR 20/18 A3000 RMK AO2" }),
    meteogramReport({ timestamp: "2026-09-01T00:54:00Z", raw: "METAR KMEM 010054Z 00000KT 4SM -RASN BKN020 19/18 A2999 RMK AO2 P0000 4/003" }),
  ];
  const model = buildMeteogramModel(reports, { station: "KMEM", now: new Date("2026-09-01T01:00:00Z") });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
  const traceGroup = svg.match(/<g class="aviation-meteogram-interval aviation-meteogram-precip-interval aviation-meteogram-interval-observed"[\s\S]*?<\/g>/)?.[0] || "";
  assert.match(traceGroup, />T</);
  assert.doesNotMatch(traceGroup, /aviation-meteogram-interval-bar/);
  assert.doesNotMatch(svg, /aviation-meteogram-snow-interval/, "SN and 4\/sss do not fabricate new snowfall");
  assert.match(svg, /DEPTH 3\.00 IN/);
  const occurrenceOnly = manualMeteogramPoint({
    weatherCodes: ["-RA"], weather: { icon: "☂", label: "RAIN" },
    precipitation: { ...manualMeteogramPoint().precipitation, rainObserved: true },
  });
  const occurrenceSvg = buildMeteogramSvgMarkup(manualMeteogramModel([occurrenceOnly]), { timeMode: "Z" });
  assert.doesNotMatch(occurrenceSvg, /aviation-meteogram-precip-interval/);

  const snowIncreaseModel = buildMeteogramModel([
    meteogramReport({
      timestamp: "2026-09-01T01:54:00Z",
      raw: "METAR KMEM 010154Z 00000KT 2SM SN BKN010 M01/M02 A2995 RMK AO2 SNINCR 2/005",
    }),
  ], { station: "KMEM", now: new Date("2026-09-01T02:00:00Z") });
  const snowIncreaseSvg = buildMeteogramSvgMarkup(snowIncreaseModel, { timeMode: "Z" });
  const snowIncreaseTable = buildMeteogramAccessibleTableMarkup(snowIncreaseModel, { timeMode: "Z" });
  assert.match(snowIncreaseSvg, /SNOW DEPTH INCREASE DURING PAST HOUR 2\.00 IN/);
  assert.match(snowIncreaseTable, /SNOW DEPTH INCREASE DURING PAST HOUR/);
  assert.doesNotMatch(snowIncreaseSvg, /EXACT NEW-SNOW|NEW SNOW/i);
});

test("meteogram dimensions remain finite and internally scrollable at every required viewport", () => {
  const timeline = Array.from({ length: 25 }, (_, index) => manualMeteogramPoint({
    observedZ: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
  }));
  for (const viewport of [1920, 1366, 1280, 844, 390, 320]) {
    const dimensions = meteogramDimensions(timeline, viewport);
    assert.ok(Number.isFinite(dimensions.width) && dimensions.width >= viewport);
    assert.equal(dimensions.height, 924);
    assert.ok(dimensions.xPositions.every((x) => x >= dimensions.labelWidth && x <= dimensions.width));
    if (viewport <= 844) assert.ok(dimensions.width > viewport, "dense mobile/tablet timeline scrolls inside its region");
  }
});

test("the meteogram remains isolated from BWC and updater ownership logic", () => {
  const combined = [meteogramCore, meteogramJs, meteogramSolarJs, meteogramCss].join("\n");
  assert.doesNotMatch(combined, /bwc|PRIMARY|BACKUP|lease|failover|heartbeat/i);
  assert.doesNotMatch(lookupJs, /weather[_-]history\.json/i);
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/weather-meteogram\.css">/);
  assert.doesNotMatch(indexHtml, /<script[^>]+weather-meteogram\.js/);
});
