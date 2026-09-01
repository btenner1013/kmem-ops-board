import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lookupAviationWeather } from "../aviation-weather-lookup-core.js";
import { meteogramLookupRequest } from "../weather-meteogram-core.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lookupJs = readFileSync(new URL("../aviation-weather-lookup.js", import.meta.url), "utf8");
const lookupCss = readFileSync(new URL("../aviation-weather-lookup.css", import.meta.url), "utf8");
const meteogramJs = readFileSync(new URL("../weather-meteogram.js", import.meta.url), "utf8");
const meteogramCore = readFileSync(new URL("../weather-meteogram-core.js", import.meta.url), "utf8");
const meteogramCss = readFileSync(new URL("../weather-meteogram.css", import.meta.url), "utf8");

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
      /import \{ meteogramLookupRequest \} from "\.\/weather-meteogram-core\.js";/,
      `const { meteogramLookupRequest } = globalThis["${dependencyKey}"];`,
    )
    .replace(
      /import \{ renderAviationMeteogram \} from "\.\/weather-meteogram\.js";/,
      `const { renderAviationMeteogram } = globalThis["${dependencyKey}"];`,
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
  for (const title of ["WEATHER", "TEMP / DEW", "WIND", "PRESSURE", "CLOUDS / CIG", "VISIBILITY", "RAIN / LWE", "SNOW"]) {
    assert.match(meteogramJs, new RegExp(`title: "${title.replace("/", "\\/")}"`));
  }
  assert.match(meteogramJs, /aviation-meteogram-temp-pair/);
  assert.match(meteogramJs, /aviation-meteogram-temp-line/);
  assert.match(meteogramJs, /aviation-meteogram-dew-line/);
  assert.match(meteogramJs, /aviation-meteogram-temp-spread/);
  assert.match(meteogramJs, /aviation-meteogram-time-line/);
  assert.match(meteogramJs, /time-proportional timeline/);
  assert.match(meteogramJs, /spanHours \* pixelsPerHour/);
  assert.doesNotMatch(meteogramJs, /barb/i);
  assert.match(meteogramJs, /DOWNWIND ARROW/);
});

test("current TAF forecast is visibly separated and never presented as observed precision", () => {
  assert.match(meteogramJs, /NOW \/ FORECAST/);
  assert.match(meteogramJs, /aviation-meteogram-forecast-background/);
  assert.match(meteogramJs, /TEMPO\/PROB REMAIN CONDITIONAL/);
  assert.match(meteogramJs, /TAF HAS NO DEW POINT OR PRECIP AMOUNTS/);
  assert.match(meteogramCore, /block\.type === "BECOMING"[\s\S]*at: end/);
  assert.match(meteogramCore, /\["INITIAL", "FROM", "BECOMING"\]\.includes\(block\.type\)/);
  assert.match(meteogramCore, /liquidEquivalentIn: null/);
  assert.match(meteogramCore, /dewPointC: null/);
  assert.match(meteogramJs, /conditionalWind/);
  assert.match(meteogramJs, /conditionalCloud/);
  assert.match(meteogramJs, /conditionalVisibility/);
  assert.doesNotMatch(meteogramCore, /dewPointC:\s*state|liquidEquivalentIn:\s*\d/);
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
});

test("truthful missing, precipitation, source, and gap language is visible", () => {
  assert.match(meteogramJs, /UNIFIED WEATHER TIMELINE · EXACT METAR \/ SPECI HISTORY \+ CURRENT TAF FORECAST/);
  assert.match(meteogramJs, /CURRENT TAF UNAVAILABLE/);
  assert.match(meteogramJs, /MISSING VALUES SHOWN AS —/);
  assert.match(meteogramJs, /GAPS OVER 2\.5 HR DISCONNECTED/);
  assert.match(meteogramJs, /OBS LWE\/DEPTH ARE NOT FORECAST AMOUNTS/);
  assert.match(meteogramJs, /TX\/TN ARE EXACT EXTREMA ONLY/);
  assert.match(meteogramCore, /const liquidEquivalentIn = hourly \? Number\(hourly\[1\]\) \/ 100 : null/);
  assert.doesNotMatch(meteogramCore, /interpolat/i);
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
  for (const heading of ["Time", "Type", "Temperature", "Dew point", "Wind", "Clouds / ceiling", "Source / forecast semantics"]) {
    assert.match(meteogramJs, new RegExp(`>${heading.replace("/", "\\/")}`));
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

test("the meteogram remains isolated from BWC and updater ownership logic", () => {
  const combined = [meteogramCore, meteogramJs, meteogramCss].join("\n");
  assert.doesNotMatch(combined, /bwc|PRIMARY|BACKUP|lease|failover|heartbeat/i);
  assert.doesNotMatch(lookupJs, /weather[_-]history\.json/i);
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/weather-meteogram\.css">/);
  assert.doesNotMatch(indexHtml, /<script[^>]+weather-meteogram\.js/);
});
