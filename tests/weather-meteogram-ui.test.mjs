import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lookupAviationWeather } from "../aviation-weather-lookup-core.js";
import { fetchGfsMeteogramPressureForecast } from "../aviation-weather-lookup.js";
import { buildMeteogramModel, meteogramLookupRequest } from "../weather-meteogram-core.js";
import { meteogramSolarEvents, meteogramSolarPhase } from "../weather-meteogram-solar.js";
import {
  buildMeteogramAccessibleTableMarkup,
  buildMeteogramStickyLabelsMarkup,
  buildMeteogramStickyTimeRulerMarkup,
  buildMeteogramSvgMarkup,
  METEOGRAM_CLOUD_AXIS_WIDTH,
  METEOGRAM_DATA_AXIS_WIDTH,
  meteogramCloudBaseY,
  meteogramCloudBucketLayout,
  meteogramCloudColumnLabelMask,
  meteogramCloudFormDefinition,
  meteogramCloudLabelLayout,
  meteogramCloudScaleDefinition,
  meteogramCloudTickLayout,
  meteogramDimensions,
  meteogramForecastSourceState,
  meteogramGustLabelMask,
  meteogramLightningGeometry,
  meteogramMobileNavigationAnchor,
  meteogramMobileNavigationScrollLeft,
  meteogramRowLabelDescriptors,
  meteogramRowLabelLayout,
  meteogramSelectedRangeScales,
  meteogramSubtitleText,
  meteogramTemperatureGeometry,
  meteogramWeatherVisualCategory,
  meteogramWeatherSceneDefinition,
  meteogramWindArrowRotation,
  meteogramWindSpeedGeometry,
} from "../weather-meteogram.js";
import {
  buildMeteogramPrintPagesMarkup,
  buildMeteogramPrintPlan,
  meteogramCalendarDayRange,
  meteogramCustomRange,
  meteogramPrintCoverage,
  paginateMeteogramPrintRange,
  resolveMeteogramPrintRange,
  sliceMeteogramModelForPrint,
} from "../weather-meteogram-print.js";
import {
  DENSE_THUNDERSTORM_TARGET_TIMES,
  denseThunderstormMeteogramFixture,
} from "./fixtures/weather-meteogram-dense-thunderstorm.mjs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lookupJs = readFileSync(new URL("../aviation-weather-lookup.js", import.meta.url), "utf8");
const lookupCss = readFileSync(new URL("../aviation-weather-lookup.css", import.meta.url), "utf8");
const meteogramJs = readFileSync(new URL("../weather-meteogram.js", import.meta.url), "utf8");
const meteogramCore = readFileSync(new URL("../weather-meteogram-core.js", import.meta.url), "utf8");
const meteogramCss = readFileSync(new URL("../weather-meteogram.css", import.meta.url), "utf8");
const meteogramSolarJs = readFileSync(new URL("../weather-meteogram-solar.js", import.meta.url), "utf8");
const meteogramPrintJs = readFileSync(new URL("../weather-meteogram-print.js", import.meta.url), "utf8");

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
    buildMeteogramPrintPagesMarkup,
    buildMeteogramPrintPlan,
    paginateMeteogramPrintRange,
    meteogramPrintDefaultValues: () => ({
      calendarDate: "2026-09-01",
      startDate: "2026-09-01",
      startTime: "00:00",
      endDate: "2026-09-02",
      endTime: "00:00",
    }),
    resolveMeteogramPrintRange: () => ({ ok: false, error: "Print fixture unavailable." }),
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
      /import \{[\s\S]*?\} from "\.\/weather-meteogram-print\.js";/,
      `const { buildMeteogramPrintPagesMarkup, buildMeteogramPrintPlan, meteogramPrintDefaultValues, paginateMeteogramPrintRange, resolveMeteogramPrintRange } = globalThis["${dependencyKey}"];`,
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

function gfsPressurePayload({
  times = ["2026-09-01T04:00", "2026-09-01T05:00", "2026-09-01T06:00"],
  pressures = [1013.8, null, 1012.4],
} = {}) {
  return {
    latitude: 35,
    longitude: -90,
    generationtime_ms: 0.12,
    utc_offset_seconds: 0,
    timezone: "GMT",
    timezone_abbreviation: "GMT",
    elevation: 86,
    hourly_units: { time: "iso8601", pressure_msl: "hPa" },
    hourly: { time: times, pressure_msl: pressures },
  };
}

function gfsPressureEnvelope({ times, pressures } = {}) {
  return {
    product: "OPEN_METEO_GFS_MSLP",
    station: "KMEM",
    source: "NOAA GFS / HRRR via Open-Meteo",
    sourceUrl: "https://api.open-meteo.com/v1/gfs?latitude=35.0424&longitude=-89.9767&hourly=pressure_msl&forecast_hours=48&timezone=UTC&models=gfs_seamless",
    fetchedZ: "2026-09-01T03:16:00.000Z",
    point: { latitude: 35.0424, longitude: -89.9767 },
    model: "gfs_seamless",
    payload: gfsPressurePayload({ times, pressures }),
  };
}

function manualGfsPressurePoint({
  validZ,
  validEndZ,
  pressureInHg,
  source = "NOAA GFS / HRRR via Open-Meteo",
} = {}) {
  const pressure = pressureInHg === null || pressureInHg === undefined
    ? null
    : {
      product: "OPEN_METEO_GFS_MSLP",
      source,
      sourceUrl: "https://api.open-meteo.com/v1/gfs?hourly=pressure_msl&models=gfs_seamless&timezone=UTC",
      fetchedZ: "2026-09-01T03:16:00.000Z",
      updateZ: null,
      model: "gfs_seamless",
      validStartZ: validZ,
      validEndZ,
      pressureReference: "MSLP",
      sampleSemantics: "INSTANTANEOUS",
    };
  return manualMeteogramPoint({
    observedZ: validZ,
    validZ,
    kind: "FORECAST",
    reportType: "GFS MSLP",
    source,
    raw: "",
    tafIssuanceZ: null,
    pressureOnly: true,
    pressureInHg,
    pressureReference: pressure ? "MSLP" : null,
    temperatureC: null,
    dewPointC: null,
    windDirectionDeg: null,
    windSpeedKt: null,
    visibilitySm: null,
    visibilityDisplay: "—",
    clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
    weather: { icon: "·", label: "AVIATION WX UNAVAILABLE" },
    fieldProvenance: { temperature: null, dewPoint: null, pressure },
  });
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
    pressureReference: "ALTIMETER",
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
    fieldProvenance: { temperature: null, dewPoint: null, pressure: null },
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
    pressureForecast: null,
    observedSources: ["Manual fixture"],
    observedPrecipitationIntervals: [],
    observedSnowDepthIncreaseIntervals: [],
    forecastPrecipitationIntervals: [],
    forecastSnowfallIntervals: [],
    revisedBuckets: 0,
    ...overrides,
  };
}

function printMeteogramModel({
  startZ = "2026-09-01T00:00:00Z",
  hours = 96,
  stepHours = 3,
} = {}) {
  const start = Date.parse(startZ);
  const timeline = [];
  for (let hour = 0; hour <= hours; hour += stepHours) {
    const timestamp = new Date(start + hour * 60 * 60 * 1000).toISOString();
    const forecast = hour > 12;
    timeline.push(manualMeteogramPoint({
      observedZ: timestamp,
      validZ: forecast ? timestamp : null,
      kind: forecast ? "FORECAST" : "OBSERVED",
      reportType: forecast ? "TAF" : "METAR",
      tafIssuanceZ: forecast ? new Date(start + 12 * 60 * 60 * 1000).toISOString() : null,
      source: forecast ? "Current TAF fixture" : "Retained METAR fixture",
      temperatureC: 20 + Math.sin(hour / 6) * 4,
      dewPointC: 14 + Math.sin(hour / 7) * 2,
      windSpeedKt: hour === 60 ? 45 : 18,
      windGustKt: hour === 18 ? 50 : hour === 60 ? 80 : null,
      clouds: hour === 30
        ? { layers: [{ cover: "BKN", heightFt: 25000, raw: "BKN250" }], clear: false, cavok: false, ceilingFt: 25000, display: "BKN250" }
        : manualMeteogramPoint().clouds,
    }));
  }
  return manualMeteogramModel(timeline, {
    startZ: timeline[0].observedZ,
    endZ: timeline.at(-1).validZ || timeline.at(-1).observedZ,
  });
}

function renderedSolarGeometry(svg) {
  return [...svg.matchAll(/data-solar-event="(sunrise|sunset)" data-event-z="([^"]+)" data-event-local-date="([^"]+)" data-event-x="([^"]+)"/g)]
    .map((match) => ({ type: match[1], timestamp: match[2], localDate: match[3], x: Number(match[4]) }));
}

test("meteogram is a fourth product inside the existing Aviation Weather Lookup modal", () => {
  assert.match(indexHtml, /id="aviationWeatherLookupPanel"[\s\S]*data-aviation-product="ATIS"[\s\S]*data-aviation-product="METAR"[\s\S]*data-aviation-product="TAF"[\s\S]*data-aviation-product="METEOGRAM"/);
  assert.match(indexHtml, /data-aviation-product="METEOGRAM"[^>]*aria-label="Aviation meteogram weather history"/);
  assert.match(indexHtml, /data-aviation-product="METEOGRAM"[^>]*>METEOGRAM<\/button>/);
  assert.doesNotMatch(indexHtml, /aviation-lookup-product-(?:long|short)|>METEO</);
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

test("predictive-pressure fetch uses the bounded KMEM NOAA GFS MSLP request and returns a provenance envelope", async () => {
  const payload = gfsPressurePayload();
  const calls = [];
  const signal = { aborted: false };
  const result = await fetchGfsMeteogramPressureForecast({
    station: "kmem",
    signal,
    fetchedAt: () => new Date("2026-09-01T03:16:00Z"),
    fetchImpl: async (input, options) => {
      calls.push({ input: String(input), options });
      return { ok: true, status: 200, async json() { return payload; } };
    },
  });

  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].input);
  assert.equal(requestUrl.origin, "https://api.open-meteo.com");
  assert.equal(requestUrl.pathname, "/v1/gfs");
  assert.equal(requestUrl.searchParams.get("latitude"), "35.0424");
  assert.equal(requestUrl.searchParams.get("longitude"), "-89.9767");
  assert.equal(requestUrl.searchParams.get("hourly"), "pressure_msl");
  assert.equal(requestUrl.searchParams.get("forecast_hours"), "48");
  assert.equal(requestUrl.searchParams.get("timezone"), "UTC");
  assert.equal(requestUrl.searchParams.get("models"), "gfs_seamless");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.deepEqual(result, {
    product: "OPEN_METEO_GFS_MSLP",
    station: "KMEM",
    source: "NOAA GFS / HRRR via Open-Meteo",
    sourceUrl: calls[0].input,
    fetchedZ: "2026-09-01T03:16:00.000Z",
    point: { latitude: 35.0424, longitude: -89.9767 },
    model: "gfs_seamless",
    payload,
  });
});

test("predictive-pressure fetch is KMEM-only and rejects HTTP or malformed responses", async () => {
  let calls = 0;
  assert.equal(await fetchGfsMeteogramPressureForecast({
    station: "KATL",
    fetchImpl: async () => { calls += 1; },
  }), null);
  assert.equal(calls, 0, "an unsupported station cannot contact the KMEM-specific model point");

  await assert.rejects(fetchGfsMeteogramPressureForecast({
    station: "KMEM",
    fetchImpl: async () => ({ ok: false, status: 503 }),
  }), /GFS pressure HTTP 503/);
  await assert.rejects(fetchGfsMeteogramPressureForecast({
    station: "KMEM",
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return []; } }),
  }), /GFS pressure response is malformed/);
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

test("predictive-pressure provider failure is nonfatal to the observed and TAF meteogram", async () => {
  const clock = new FakeClock();
  const lookupHarness = createDeferredLookupHarness();
  const dom = createLookupDom(clock);
  const directRequests = [];
  dom.doc.defaultView.fetch = async (input) => {
    const url = String(input);
    directRequests.push(url);
    if (url.startsWith("https://api.open-meteo.com/v1/gfs?")) {
      throw new Error("deterministic pressure provider outage");
    }
    throw new Error("deterministic supplemental provider outage");
  };
  const renders = [];
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
  const request = controller.runLookup();
  lookupHarness.calls[0].task.resolve(successResponse("METAR"));
  lookupHarness.calls[1].task.resolve(successResponse("TAF"));
  await request;

  assert.ok(directRequests.some((url) => url.startsWith("https://api.open-meteo.com/v1/gfs?")));
  assert.equal(renders.length, 1, "pressure failure cannot suppress the rest of the meteogram");
  assert.equal(renders[0].options.pressureForecast, null);
  assert.equal(renders[0].reports[0].product, "METAR");
  assert.equal(renders[0].options.tafReports[0].product, "TAF");
  controller.close();
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
  assert.match(meteogramJs, /<svg class="aviation-meteogram-svg\$\{printMode/);
  for (const title of ["WEATHER", "TEMPERATURE", "DEW POINT", "TEMP LINE", "DEW POINT LINE", "WIND", "WIND SPEED / GUST", "PRESSURE", "CLOUDS / CIG", "VISIBILITY", "PRECIP (IN)", "SNOW (IN)"]) {
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
    assert.deepEqual(meteogramForecastSourceState(model), {
      hasTaf: false,
      hasNws: true,
      hasGfsPressure: false,
      label: "NWS GRID",
    });
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
  assert.deepEqual(meteogramForecastSourceState(shortTafModel), {
    hasTaf: true,
    hasNws: true,
    hasGfsPressure: false,
    label: "TAF / NWS",
  });
  const nwsTail = shortTafModel.forecasts.find((bucket) => bucket.validZ === "2026-09-01T08:00:00.000Z");
  assert.equal(nwsTail.supplementalOnly, true);
  assert.equal(nwsTail.tafIssuanceZ, null);
  assert.match(buildMeteogramAccessibleTableMarkup(shortTafModel, { timeMode: "Z" }), /NWS GRID forecast/);
});

test("forecast MSLP is a separate dashed pressure series with exact provenance, truthful gaps, and no altimeter seam", () => {
  const timeline = [
    manualMeteogramPoint({
      observedZ: "2026-09-01T02:54:00.000Z",
      pressureInHg: 30,
      pressureReference: "ALTIMETER",
    }),
    manualGfsPressurePoint({
      validZ: "2026-09-01T04:00:00.000Z",
      validEndZ: "2026-09-01T05:00:00.000Z",
      pressureInHg: 29.94,
    }),
    manualGfsPressurePoint({
      validZ: "2026-09-01T05:00:00.000Z",
      validEndZ: "2026-09-01T06:00:00.000Z",
      pressureInHg: 29.91,
    }),
    manualGfsPressurePoint({
      validZ: "2026-09-01T06:00:00.000Z",
      validEndZ: "2026-09-01T07:00:00.000Z",
      pressureInHg: null,
    }),
    manualGfsPressurePoint({
      validZ: "2026-09-01T07:00:00.000Z",
      validEndZ: "2026-09-01T08:00:00.000Z",
      pressureInHg: 29.88,
    }),
    manualGfsPressurePoint({
      validZ: "2026-09-01T08:00:00.000Z",
      validEndZ: "2026-09-01T09:00:00.000Z",
      pressureInHg: 29.86,
    }),
  ];
  const model = manualMeteogramModel(timeline, {
    pressureForecast: {
      product: "OPEN_METEO_GFS_MSLP",
      source: "NOAA GFS / HRRR via Open-Meteo",
      sourceUrl: "https://api.open-meteo.com/v1/gfs?hourly=pressure_msl",
      model: "gfs_seamless",
      fetchedZ: "2026-09-01T03:16:00.000Z",
    },
  });
  assert.deepEqual(meteogramForecastSourceState(model), {
    hasTaf: false,
    hasNws: false,
    hasGfsPressure: true,
    label: "NOAA MSLP",
  });
  assert.match(meteogramSubtitleText(model), /NOAA GFS \/ HRRR MSLP GUIDANCE/);

  const labelLayout = meteogramRowLabelLayout(
    { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" },
    1200,
    { hasForecast: true, hasGfsPressure: true },
  );
  assert.equal(labelLayout.rows.find(({ key }) => key === "pressure").unit, "OBS ALTIMETER · FCST MSLP · IN HG");
  const dimensions = meteogramDimensions(timeline, 1200, { labelWidth: labelLayout.width });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1200, labelLayout });
  assert.match(svg, /aria-label="OBS ALTIMETER · FCST MSLP · IN HG"/);
  assert.match(svg, /aviation-meteogram-pressure-reference[^>]*>FCST MSLP<\/text>/);
  assert.match(meteogramCss, /\.aviation-meteogram-line-forecast\{stroke-dasharray:5 4;opacity:\.72\}/);

  const pressurePaths = [...svg.matchAll(/<path class="aviation-meteogram-pressure-line( aviation-meteogram-line-forecast)?" d="([^"]+)"\/>/g)]
    .map((match) => ({ forecast: Boolean(match[1]), d: match[2] }));
  assert.equal(pressurePaths.filter(({ forecast }) => !forecast).length, 1, "observed altimeter remains its own series");
  const forecastPaths = pressurePaths.filter(({ forecast }) => forecast);
  assert.equal(forecastPaths.length, 2, "the null source hour splits the predictive pressure path");
  const expectedForecastXs = [1, 2, 4, 5].map((index) => dimensions.xPositions[index].toFixed(1));
  for (const x of expectedForecastXs) {
    assert.ok(forecastPaths.some(({ d }) => new RegExp(`(?:M|L)${x.replace(".", "\\.")} `).test(d)), `forecast pressure reuses shared x=${x}`);
  }
  const missingX = dimensions.xPositions[3].toFixed(1);
  assert.ok(forecastPaths.every(({ d }) => !new RegExp(`(?:M|L)${missingX.replace(".", "\\.")} `).test(d)), "missing MSLP is not plotted or interpolated");
  assert.doesNotMatch(svg, /aviation-meteogram-pressure-line[^"<]*aviation-meteogram-line-seam/, "different pressure references never connect across NOW");
  const dividerX = Number(svg.match(/aviation-meteogram-now-divider" x1="([\d.]+)"/)?.[1]);
  assert.ok(Math.abs(dividerX - dimensions.xForTime(timeline[1].validZ)) <= 0.1, "MSLP uses the same NOW/timeline mapping as every other row");

  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  assert.match(svg, /Pressure 29\.94 inHg · NOAA GFS \/ HRRR MEAN SEA-LEVEL PRESSURE \(MSLP\) · NOT AN ALTIMETER SETTING/);
  assert.match(svg, /Pressure source NOAA GFS \/ HRRR via Open-Meteo · model gfs_seamless · valid/);
  assert.match(table, /29\.94 inHg · NOAA GFS \/ HRRR MEAN SEA-LEVEL PRESSURE \(MSLP\) · NOT AN ALTIMETER SETTING/);
  assert.match(table, /Pressure source NOAA GFS \/ HRRR via Open-Meteo · model gfs_seamless · valid 0400Z–0500Z/);
  assert.match(table, /NOAA MSLP forecast/);
  assert.match(table, /01 SEP 0600Z[\s\S]*?<td>—<\/td>/, "the accessible pressure cell also exposes the missing source hour");
  assert.match(svg, /Dew point unavailable; no hourly dew-point source is represented in this forecast bucket/);
  assert.doesNotMatch(svg, /Dew point unavailable; TAF does not provide hourly dew point/);
  assert.match(meteogramJs, /WEATHER DATA BY OPEN-METEO\.COM/, "the required provider attribution remains visible with predictive pressure");
  assert.match(meteogramJs, /attribution\.href = "https:\/\/open-meteo\.com\/"/);
  assert.match(meteogramJs, /MODEL CYCLE NOT EXPOSED BY SOURCE/, "fetch time is not mislabeled as the unavailable model-cycle time");

  const scales = meteogramSelectedRangeScales(model, { timeMode: "Z" });
  assert.ok(scales.pressureRange.maximum - scales.pressureRange.minimum >= 0.30, "mixed altimeter/MSLP display cannot exaggerate tiny changes");
});

test("TAF QNH and NOAA MSLP never share a path and overridden model samples do not claim plotted MSLP", () => {
  const tafBase = {
    station: "KMEM",
    timestamp: "2026-09-01T02:00:00Z",
    product: "TAF",
    validTimeFrom: "2026-09-01T03:00:00Z",
    source: "Deterministic TAF fixture",
  };
  const mixedModel = buildMeteogramModel([meteogramReport()], {
    station: "KMEM",
    tafReports: [{
      ...tafBase,
      validTimeTo: "2026-09-01T05:00:00Z",
      raw: "TAF KMEM 010200Z 0103/0105 18008KT P6SM SCT050 QNH3001INS",
    }],
    pressureForecast: gfsPressureEnvelope({
      times: ["2026-09-01T04:00", "2026-09-01T05:00", "2026-09-01T06:00"],
      pressures: [1013.8, 1012.8, 1011.8],
    }),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const qnhBucket = mixedModel.forecasts.find((bucket) => bucket.validZ === "2026-09-01T04:00:00.000Z");
  const mslpBucket = mixedModel.forecasts.find((bucket) => bucket.validZ === "2026-09-01T05:00:00.000Z");
  assert.equal(qnhBucket.pressureReference, "QNH");
  assert.equal(qnhBucket.fieldProvenance.pressure.product, "TAF");
  assert.equal(qnhBucket.pressureForecastValue.product, "OPEN_METEO_GFS_MSLP", "the unused sample remains diagnostic only");
  assert.equal(mslpBucket.pressureReference, "MSLP");
  const mixedLabelLayout = meteogramRowLabelLayout({ timeMode: "Z" }, 1200, { hasForecast: true, hasGfsPressure: true });
  const mixedDimensions = meteogramDimensions(mixedModel.timeline, 1200, { labelWidth: mixedLabelLayout.width });
  const mixedSvg = buildMeteogramSvgMarkup(mixedModel, { timeMode: "Z" }, { viewportWidth: 1200, labelLayout: mixedLabelLayout });
  const forecastPressurePaths = [...mixedSvg.matchAll(/<path class="aviation-meteogram-pressure-line aviation-meteogram-line-forecast" d="([^"]+)"\/>/g)]
    .map((match) => match[1]);
  assert.equal(forecastPressurePaths.length, 2, "a pressure-reference change starts a new forecast path");
  const qnhX = mixedDimensions.xPositions[mixedModel.timeline.indexOf(qnhBucket)].toFixed(1);
  const mslpX = mixedDimensions.xPositions[mixedModel.timeline.indexOf(mslpBucket)].toFixed(1);
  const containsX = (path, value) => new RegExp(`(?:M|L)${value.replace(".", "\\.")} `).test(path);
  assert.ok(forecastPressurePaths.every((path) => !(containsX(path, qnhX) && containsX(path, mslpX))), "neither path crosses the QNH/MSLP boundary");
  const qnhTable = buildMeteogramAccessibleTableMarkup(mixedModel, { timeMode: "Z" });
  const qnhRow = qnhTable.match(/<tr>[\s\S]*?<th scope="row">01 SEP 0400Z<\/th>[\s\S]*?<\/tr>/)?.[0] || "";
  assert.match(qnhRow, /30\.01 inHg · QNH/);
  assert.doesNotMatch(qnhRow, /NOAA MSLP forecast/, "an overridden model sample is not presented as the plotted source");

  const qnhOnlyModel = buildMeteogramModel([meteogramReport()], {
    station: "KMEM",
    tafReports: [{
      ...tafBase,
      validTimeTo: "2026-09-01T07:00:00Z",
      raw: "TAF KMEM 010200Z 0103/0107 18008KT P6SM SCT050 QNH3001INS",
    }],
    pressureForecast: gfsPressureEnvelope({
      times: ["2026-09-01T04:00", "2026-09-01T05:00", "2026-09-01T06:00"],
      pressures: [1013.8, 1012.8, 1011.8],
    }),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.equal(meteogramForecastSourceState(qnhOnlyModel).hasGfsPressure, false, "unused NOAA samples do not make live state claim MSLP is plotted");
  const range = resolveMeteogramPrintRange({ choice: "current", model: qnhOnlyModel, settings: { timeMode: "Z" } });
  const plan = buildMeteogramPrintPlan({ model: qnhOnlyModel, settings: { timeMode: "Z" }, range });
  assert.equal(plan.hasGfsPressure, false, "print uses the same actual-plotted-source classification as live rendering");
  assert.doesNotMatch(plan.pages.map((page) => page.svg).join(""), /FCST MSLP/);
  assert.doesNotMatch(buildMeteogramPrintPagesMarkup(plan), /aviation-meteogram-print-pressure-source/);
});

test("a null NOAA MSLP hour inside a real TAF bucket breaks pressure and discloses the gap", () => {
  const model = buildMeteogramModel([meteogramReport()], {
    station: "KMEM",
    tafReports: [{
      station: "KMEM",
      timestamp: "2026-09-01T02:00:00Z",
      product: "TAF",
      validTimeFrom: "2026-09-01T03:00:00Z",
      validTimeTo: "2026-09-01T07:00:00Z",
      raw: "TAF KMEM 010200Z 0103/0107 18008KT P6SM SCT050",
      source: "Deterministic TAF fixture",
    }],
    pressureForecast: gfsPressureEnvelope({
      times: ["2026-09-01T04:00", "2026-09-01T05:00", "2026-09-01T06:00"],
      pressures: [1013.8, null, 1011.8],
    }),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const gap = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T05:00:00.000Z");
  assert.ok(gap.tafIssuanceZ);
  assert.equal(gap.pressureOnly, undefined);
  assert.equal(gap.pressureForecastExpected, true);
  assert.equal(gap.pressureForecastValue, null);
  assert.equal(gap.pressureInHg, null);
  const labelLayout = meteogramRowLabelLayout({ timeMode: "Z" }, 1200, { hasForecast: true, hasGfsPressure: true });
  const dimensions = meteogramDimensions(model.timeline, 1200, { labelWidth: labelLayout.width });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1200, labelLayout });
  const missingX = dimensions.xPositions[model.timeline.indexOf(gap)].toFixed(1);
  const pressurePaths = [...svg.matchAll(/<path class="aviation-meteogram-pressure-line aviation-meteogram-line-forecast" d="([^"]+)"\/>/g)]
    .map((match) => match[1]);
  assert.ok(pressurePaths.every((path) => !new RegExp(`(?:M|L)${missingX.replace(".", "\\.")} `).test(path)), "the combined-bucket null hour is not plotted or bridged");
  assert.match(svg, /NOAA model MSLP is missing at this exact valid time; no pressure was inferred/);
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  const gapRow = table.match(/<tr>[\s\S]*?<th scope="row">01 SEP 0500Z<\/th>[\s\S]*?<\/tr>/)?.[0] || "";
  assert.match(gapRow, /NOAA model MSLP is missing at this exact valid time; no pressure was inferred/);
});

test("multi-page predictive-pressure print uses one selected-range pressure domain on every page", () => {
  const start = Date.parse("2026-09-01T00:00:00Z");
  const timeline = [manualMeteogramPoint({ observedZ: new Date(start).toISOString(), pressureInHg: 30.02 })];
  for (let hour = 1; hour <= 24; hour += 1) {
    const validZ = new Date(start + hour * 60 * 60_000).toISOString();
    timeline.push(manualGfsPressurePoint({
      validZ,
      validEndZ: new Date(start + (hour + 1) * 60 * 60_000).toISOString(),
      pressureInHg: hour === 12 ? null : 29.96 - hour * 0.004,
    }));
  }
  const model = manualMeteogramModel(timeline, {
    startZ: timeline[0].observedZ,
    endZ: timeline.at(-1).validZ,
    pressureForecast: {
      product: "OPEN_METEO_GFS_MSLP",
      source: "NOAA GFS / HRRR via Open-Meteo",
      model: "gfs_seamless",
      fetchedZ: "2026-09-01T00:05:00.000Z",
    },
  });
  const range = resolveMeteogramPrintRange({ choice: "current", model, settings: { timeMode: "Z" } });
  const plan = buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range });
  assert.equal(plan.ok, true);
  assert.equal(plan.pages.length, 2);
  assert.ok(plan.scaleOverrides.pressureRange.maximum - plan.scaleOverrides.pressureRange.minimum >= 0.30);
  const markup = buildMeteogramPrintPagesMarkup(plan);
  for (const [attribute, value] of [
    ["data-pressure-min", plan.scaleOverrides.pressureRange.minimum],
    ["data-pressure-max", plan.scaleOverrides.pressureRange.maximum],
  ]) {
    const escapedValue = String(value).replace(".", "\\.");
    assert.equal((markup.match(new RegExp(`${attribute}="${escapedValue}"`, "g")) || []).length, 2, `${attribute} repeats unchanged on both pages`);
  }
  assert.ok(plan.pages.every((page) => page.svg.includes("OBS ALTIMETER · FCST MSLP · IN HG")), "each page repeats the truthful pressure reference label");
  assert.equal(plan.hasGfsPressure, true);
  assert.equal((markup.match(/class="aviation-meteogram-print-pressure-source"/g) || []).length, 2, "every predictive-pressure print page repeats source and reference truth");
  assert.equal((markup.match(/href="https:\/\/open-meteo\.com\/"/g) || []).length, 2, "every page repeats the Open-Meteo attribution link");
  assert.match(markup, /MEAN SEA-LEVEL PRESSURE \(MSLP\)[\s\S]*NOT AN ALTIMETER SETTING/);
  assert.match(lookupCss, /\.aviation-meteogram-print-pressure-source\{[^}]*font-weight:900/);
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
  assert.match(lookupCss, /\.aviation-lookup-form\{[\s\S]*grid-template-columns:minmax\(110px,135px\) minmax\(max-content,1fr\) minmax\(145px,180px\) max-content/);
  assert.match(lookupCss, /\.aviation-lookup-products\{[\s\S]*grid-template-columns:repeat\(4,minmax\(max-content,1fr\)\)/);
  assert.match(lookupCss, /\.aviation-lookup-product\{[\s\S]*min-width:max-content;[\s\S]*white-space:nowrap/);
  assert.match(lookupCss, /@media \(max-width:768px\)\{[\s\S]*\.aviation-lookup-products\{grid-template-columns:repeat\(2,minmax\(max-content,1fr\)\)/);
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:1050px\)\{[\s\S]*grid-template-areas:[\s\S]*"station products"[\s\S]*"range submit"/);
  assert.match(lookupCss, /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(meteogramCss, /@media \(max-width:768px\)\{[\s\S]*\.aviation-meteogram-toggle\{min-height:44px/);
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

test("meteogram PRINT opens a dedicated range setup and leaves other product printing intact", () => {
  assert.match(indexHtml, /id="aviationMeteogramPrintSetup"[\s\S]*>PRINT METEOGRAM</);
  for (const [choice, label] of [
    ["current", "CURRENT METEOGRAM RANGE"],
    ["calendar", "CALENDAR DAY"],
    ["custom", "CUSTOM RANGE"],
    ["visible", "CURRENT VISIBLE WINDOW"],
  ]) {
    assert.match(indexHtml, new RegExp(`name="meteogramPrintRange" value="${choice}"[^>]*> ${label}`));
  }
  for (const id of [
    "aviationMeteogramPrintCalendarDate",
    "aviationMeteogramPrintStartDate",
    "aviationMeteogramPrintStartTime",
    "aviationMeteogramPrintEndDate",
    "aviationMeteogramPrintEndTime",
    "aviationMeteogramPrintPages",
  ]) assert.match(indexHtml, new RegExp(`id="${id}"`));
  assert.match(lookupJs, /product === "METEOGRAM" && openMeteogramPrintSetup\(\)/);
  assert.match(lookupJs, /meteogramPrintPages\.innerHTML = buildMeteogramPrintPagesMarkup\(plan\)/);
  assert.match(lookupJs, /doc\.body\.classList\.add\("aviation-meteogram-printing"\)/);
  assert.match(lookupJs, /doc\.body\.classList\.add\("aviation-lookup-printing"\)/, "ATIS/METAR/TAF keep their established print path");
  assert.match(lookupCss, /@page meteogram\{size:letter landscape;margin:\.28in\}/);
  assert.match(lookupCss, /\.aviation-meteogram-print-page\{[\s\S]*page:meteogram;[\s\S]*break-after:page/);
  assert.match(lookupCss, /body\.aviation-meteogram-printing\{overflow:visible!important\}/);
  assert.match(lookupCss, /\.aviation-meteogram-print-setup\{[\s\S]*z-index:20;/, "the setup stays above sticky chart labels and tooltips");
  assert.match(lookupCss, /\.aviation-meteogram-print-fields\[hidden\]\{display:none!important\}/, "only fields for the selected print range remain visible");
  assert.match(lookupCss, /\.aviation-meteogram-print-page\{[\s\S]*break-inside:avoid-page;[\s\S]*page-break-inside:avoid/);
  assert.match(lookupCss, /\.aviation-meteogram-print-chart svg\{[\s\S]*max-height:6\.75in!important/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-background\{fill:#fff!important\}/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-wind-gust-line\{stroke:#111!important;stroke-dasharray:4 4!important\}/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-wind-gust-whisker,[\s\S]*\.aviation-meteogram-wind-gust-cap\{stroke:#111!important;opacity:1!important\}/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-wind-gust-label\{fill:#111!important;stroke:#fff!important;opacity:1!important\}/);
  assert.doesNotMatch(meteogramPrintJs, /window\.print|document\.|querySelector|cloneNode/, "the print model stays DOM-independent");

  const previewBody = lookupJs.match(/function refreshMeteogramPrintSetup\(\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  function closeMeteogramPrintSetup/)?.[1] || "";
  assert.match(previewBody, /currentMeteogramPrintRange\(\)/);
  assert.match(previewBody, /paginateMeteogramPrintRange\(range\)/);
  assert.doesNotMatch(previewBody, /buildMeteogramPrintPlan/, "typing in setup does not rebuild every print SVG");
  assert.match(lookupJs, /panel\.inert = true;[\s\S]*panel\.setAttribute\("aria-hidden", "true"\);[\s\S]*meteogramPrintSetup\.hidden = false/);
  assert.match(lookupJs, /view\.addEventListener\("afterprint",[\s\S]*focusTarget\?\.focus\?\.\(\)/);
});

test("calendar-day print boundaries are exact in Z and DST-aware in America/Chicago", () => {
  const zulu = meteogramCalendarDayRange({ date: "2026-09-01", timeMode: "Z" });
  assert.deepEqual(zulu, {
    ok: true,
    startZ: "2026-09-01T00:00:00.000Z",
    endZ: "2026-09-02T00:00:00.000Z",
    durationHours: 24,
    warnings: [],
  });

  const spring = meteogramCalendarDayRange({ date: "2026-03-08", timeMode: "LOCAL", timeZone: "America/Chicago" });
  assert.equal(spring.ok, true);
  assert.equal(spring.startZ, "2026-03-08T06:00:00.000Z");
  assert.equal(spring.endZ, "2026-03-09T05:00:00.000Z");
  assert.equal(spring.durationHours, 23);

  const fall = meteogramCalendarDayRange({ date: "2026-11-01", timeMode: "LOCAL", timeZone: "America/Chicago" });
  assert.equal(fall.ok, true);
  assert.equal(fall.startZ, "2026-11-01T05:00:00.000Z");
  assert.equal(fall.endZ, "2026-11-02T06:00:00.000Z");
  assert.equal(fall.durationHours, 25);
});

test("custom print ranges validate chronology and real local clock transitions", () => {
  const sixHours = meteogramCustomRange({
    startDate: "2026-09-01", startTime: "12:00",
    endDate: "2026-09-01", endTime: "18:00",
    timeMode: "Z",
  });
  assert.equal(sixHours.ok, true);
  assert.equal(sixHours.durationHours, 6);
  assert.equal(sixHours.startZ, "2026-09-01T12:00:00.000Z");
  assert.equal(sixHours.endZ, "2026-09-01T18:00:00.000Z");

  assert.match(meteogramCustomRange({
    startDate: "2026-09-02", startTime: "00:00",
    endDate: "2026-09-01", endTime: "23:59",
    timeMode: "Z",
  }).error, /End must be later/);

  assert.match(meteogramCustomRange({
    startDate: "2026-03-08", startTime: "02:30",
    endDate: "2026-03-08", endTime: "04:00",
    timeMode: "LOCAL", timeZone: "America/Chicago",
  }).error, /does not exist.*clock change/);

  const repeatedHour = meteogramCustomRange({
    startDate: "2026-11-01", startTime: "01:30",
    endDate: "2026-11-01", endTime: "01:45",
    timeMode: "LOCAL", timeZone: "America/Chicago",
  });
  assert.equal(repeatedHour.ok, true);
  assert.equal(repeatedHour.durationHours, 1.25);
  assert.equal(repeatedHour.warnings.length, 2, "ambiguous start/end policy is disclosed");
});

test("print pagination uses readable twelve-hour slices for 6, 12, 24, 36, and 96 hours", () => {
  const start = Date.parse("2026-09-01T00:00:00Z");
  const pagesFor = (hours) => paginateMeteogramPrintRange({
    startZ: new Date(start).toISOString(),
    endZ: new Date(start + hours * 60 * 60 * 1000).toISOString(),
  });
  for (const [hours, expectedPages] of [[6, 1], [12, 1], [24, 2], [36, 3], [96, 8]]) {
    const pages = pagesFor(hours);
    assert.equal(pages.length, expectedPages, `${hours} hours uses ${expectedPages} readable page(s)`);
    assert.ok(pages.every((page) => page.durationHours > 0 && page.durationHours <= 12));
    assert.ok(pages.every((page) => page.includeEnd === false), "half-open ranges never duplicate a boundary report");
  }
  const inclusivePages = paginateMeteogramPrintRange({
    startZ: new Date(start).toISOString(),
    endZ: new Date(start + 24 * 60 * 60 * 1000).toISOString(),
    includeEnd: true,
  });
  assert.equal(inclusivePages.at(-1).includeEnd, true, "an explicitly inclusive source range retains its final loaded sample");
  assert.ok(inclusivePages.slice(0, -1).every((page) => page.includeEnd === false), "interior page seams remain half-open");
});

test("calendar-day printing excludes the following midnight while retaining the last in-day report", () => {
  const dayStart = Date.parse("2026-09-01T00:00:00Z");
  const pointAt = (offsetMs) => {
    const timestamp = new Date(dayStart + offsetMs).toISOString();
    return manualMeteogramPoint({ observedZ: timestamp });
  };
  const model = manualMeteogramModel([
    pointAt(0),
    pointAt(23 * 60 * 60 * 1000 + 59 * 60 * 1000),
    pointAt(24 * 60 * 60 * 1000),
  ]);
  const range = resolveMeteogramPrintRange({
    choice: "calendar",
    model,
    settings: { timeMode: "Z" },
    values: { calendarDate: "2026-09-01" },
  });
  assert.equal(range.ok, true);
  assert.equal(range.endZ, "2026-09-02T00:00:00.000Z");
  assert.equal(range.includeEnd, false, "a calendar day is [0000, next 0000)");
  const plan = buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range });
  const printedTimes = plan.pages.flatMap((page) => page.model.timeline.map((item) => item.observedZ));
  assert.ok(printedTimes.includes("2026-09-01T23:59:00.000Z"));
  assert.ok(!printedTimes.includes("2026-09-02T00:00:00.000Z"), "next day's midnight is not printed on the selected calendar day");

  const nextMidnightOnly = manualMeteogramModel([pointAt(24 * 60 * 60 * 1000)]);
  const nextMidnightRange = resolveMeteogramPrintRange({
    choice: "calendar",
    model: nextMidnightOnly,
    settings: { timeMode: "Z" },
    values: { calendarDate: "2026-09-01" },
  });
  assert.equal(nextMidnightRange.ok, false, "a lone next-midnight observation cannot become prior-day coverage");
  assert.match(nextMidnightRange.error, /does not overlap/);
});

test("print range resolution clips truthfully to loaded coverage and rejects non-overlap", () => {
  const model = printMeteogramModel({ hours: 24 });
  assert.deepEqual(meteogramPrintCoverage(model), {
    available: true,
    startZ: "2026-09-01T00:00:00.000Z",
    endZ: "2026-09-02T00:00:00.000Z",
  });
  const clipped = resolveMeteogramPrintRange({
    choice: "custom",
    model,
    settings: { timeMode: "Z" },
    values: {
      startDate: "2026-08-31", startTime: "18:00",
      endDate: "2026-09-02", endTime: "06:00",
    },
  });
  assert.equal(clipped.ok, true);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.startZ, "2026-09-01T00:00:00.000Z");
  assert.equal(clipped.endZ, "2026-09-02T00:00:00.000Z");
  assert.match(clipped.warnings.join(" "), /clipped.*unavailable time was not fabricated/i);

  const noOverlap = resolveMeteogramPrintRange({
    choice: "calendar",
    model,
    settings: { timeMode: "Z" },
    values: { calendarDate: "2026-09-03" },
  });
  assert.equal(noOverlap.ok, false);
  assert.match(noOverlap.error, /does not overlap/);

  const pages = paginateMeteogramPrintRange(clipped);
  const first = sliceMeteogramModelForPrint(model, pages[0]);
  const second = sliceMeteogramModelForPrint(model, pages[1]);
  const seam = "2026-09-01T12:00:00.000Z";
  assert.equal(first.timeline.filter((item) => (item.validZ || item.observedZ) === seam).length, 0);
  assert.equal(second.timeline.filter((item) => (item.validZ || item.observedZ) === seam).length, 1, "a page seam never duplicates an exact report");

  const visible = resolveMeteogramPrintRange({
    choice: "visible",
    model,
    settings: { timeMode: "Z" },
    visibleRange: { startZ: "2026-09-01T03:17:00Z", endZ: "2026-09-01T08:43:00Z" },
  });
  assert.equal(visible.ok, true);
  assert.equal(visible.startZ, "2026-09-01T03:17:00.000Z");
  assert.equal(visible.endZ, "2026-09-01T08:43:00.000Z");
  assert.equal(visible.durationHours, 5 + 26 / 60, "visible printing preserves exact time coordinates instead of rounding to columns");
  const printStateBody = meteogramJs.match(/getPrintState\(\) \{([\s\S]*?)\r?\n    \},\r?\n    destroy\(\)/)?.[1] || "";
  assert.match(printStateBody, /pixelsPerHour/);
  assert.match(printStateBody, /inverseTime/);
  assert.doesNotMatch(printStateBody, /columnIndex|Math\.round\(/);
});

test("a lone exact observation prints in a disclosed limited window without implying surrounding data", () => {
  const model = manualMeteogramModel([manualMeteogramPoint()]);
  const range = resolveMeteogramPrintRange({ choice: "current", model, settings: { timeMode: "Z" } });
  assert.equal(range.ok, true);
  assert.equal(range.durationHours, 1);
  assert.equal(range.singleObservation, true);
  assert.match(range.warnings.join(" "), /one exact observation.*no surrounding data is implied/i);
  const plan = buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range });
  assert.equal(plan.ok, true);
  assert.equal(plan.pages.length, 1);
  assert.match(plan.pages[0].svg, /aviation-meteogram-observation/);
  assert.match(plan.coverageText, /ONE EXACT OBSERVATION AVAILABLE.*NO IMPLIED DATA/);
});

test("print page seams preserve unsplit precip truth and expose separate clipped render bounds", () => {
  const model = printMeteogramModel({ hours: 24 });
  model.forecastPrecipitationIntervals = [{
    validStartZ: "2026-09-01T06:00:00.000Z",
    validEndZ: "2026-09-01T18:00:00.000Z",
    amountIn: 1.2,
    kind: "FORECAST",
    source: "NWS exact interval fixture",
  }];
  const range = resolveMeteogramPrintRange({ choice: "current", model, settings: { timeMode: "Z" } });
  const plan = buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range });
  assert.equal(plan.pages.length, 2);
  const [first, second] = plan.pages;
  for (const page of [first, second]) {
    assert.match(page.svg, /data-valid-start="2026-09-01T06:00:00\.000Z" data-valid-end="2026-09-01T18:00:00\.000Z"/);
    assert.match(page.svg, /data-amount-in="1\.2"/);
    assert.match(page.svg, /aviation-meteogram-interval-print-clipped/);
    assert.match(page.svg, />1\.20†<\/text>/);
    assert.match(page.svg, /AMOUNT REMAINS THE FULL UNSPLIT SOURCE INTERVAL TOTAL/);
  }
  assert.match(first.svg, /data-render-start="2026-09-01T06:00:00\.000Z" data-render-end="2026-09-01T12:00:00\.000Z"/);
  assert.match(second.svg, /data-render-start="2026-09-01T12:00:00\.000Z" data-render-end="2026-09-01T18:00:00\.000Z"/);
  const markup = buildMeteogramPrintPagesMarkup(plan);
  assert.equal((markup.match(/FULL UNSPLIT SOURCE-INTERVAL TOTAL/g) || []).length, 2, "each standalone page repeats the interval-total disclosure");
});

test("an interval-only print page renders truthful amount geometry instead of NO DATA", () => {
  const model = manualMeteogramModel([], {
    forecastPrecipitationIntervals: [{
      validStartZ: "2026-09-01T06:00:00.000Z",
      validEndZ: "2026-09-01T12:00:00.000Z",
      amountIn: 0.25,
      kind: "FORECAST",
      source: "NWS interval-only fixture",
    }],
  });
  const range = resolveMeteogramPrintRange({ choice: "current", model, settings: { timeMode: "Z" } });
  const plan = buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range });
  assert.equal(plan.ok, true);
  assert.equal(plan.pages.length, 1);
  assert.match(plan.pages[0].svg, /aviation-meteogram-precip-interval/);
  assert.match(plan.pages[0].svg, /data-amount-in="0\.25"/);
  assert.doesNotMatch(buildMeteogramPrintPagesMarkup(plan), /NO DATA IN THIS INTERVAL/);
});

test("dedicated print pages repeat labels and share selected-range scales without fit-to-page compression", () => {
  const model = printMeteogramModel({ hours: 96 });
  const range = resolveMeteogramPrintRange({ choice: "current", model, settings: { timeMode: "Z" } });
  const plan = buildMeteogramPrintPlan({
    model,
    settings: { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" },
    range,
    rangeLabel: "Past 96 hours",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.pages.length, 8);
  assert.equal(plan.scaleOverrides.windMaximumKt, 100, "G80 selects the shared 0–100 KT print domain");
  assert.equal(plan.scaleOverrides.cloudMaximumFt, 25000);
  assert.ok(plan.pages.every((page) => page.svg.includes('data-domain-max-kt="100"')));
  assert.ok(plan.pages.every((page) => page.svg.includes(`data-cloud-axis-width="${METEOGRAM_CLOUD_AXIS_WIDTH}"`)));
  assert.equal(new Set(plan.pages.map((page) => page.svg.match(/id="(aviationMeteogramPrintPage\d+)SvgTitle"/)?.[1])).size, 8, "SVG IDs are unique per print page");

  const markup = buildMeteogramPrintPagesMarkup(plan);
  assert.equal((markup.match(/class="aviation-meteogram-print-page"/g) || []).length, 8);
  assert.equal((markup.match(/AVIATION METEOGRAM<\/h1>/g) || []).length, 8);
  assert.equal((markup.match(/FOR REFERENCE ONLY/g) || []).length, 8);
  assert.equal((markup.match(/>WIND SPEED \/ GUST</g) || []).length, 8, "row labels repeat on every page");
  assert.equal((markup.match(/data-wind-maximum-kt="100"/g) || []).length, 8);
  assert.equal((markup.match(/data-cloud-maximum-ft="25000"/g) || []).length, 8);
  for (const [attribute, value] of [
    ["data-pressure-min", plan.scaleOverrides.pressureRange.minimum],
    ["data-pressure-max", plan.scaleOverrides.pressureRange.maximum],
    ["data-visibility-min", plan.scaleOverrides.visibilityRange.minimum],
    ["data-visibility-max", plan.scaleOverrides.visibilityRange.maximum],
    ["data-precip-maximum-in", plan.scaleOverrides.precipMaximumIn],
    ["data-snow-maximum-in", plan.scaleOverrides.snowMaximumIn],
  ]) {
    assert.equal((markup.match(new RegExp(`${attribute}="${String(value).replace(".", "\\.")}"`, "g")) || []).length, 8, `${attribute} repeats the selected-range scale on every page`);
  }
  assert.match(markup, /PAGE 1 OF 8/);
  assert.match(markup, /PAGE 8 OF 8/);
  assert.doesNotMatch(markup, /aviation-meteogram-scroll|aviation-meteogram-toggle|tabindex="0"|aria-describedby=/, "print pages contain no live scrollbars or interactive chart controls");

  for (const [hours, expectedPages] of [[6, 1], [24, 2], [36, 3]]) {
    const endZ = new Date(Date.parse(model.startZ) + hours * 60 * 60 * 1000).toISOString();
    const customRange = {
      ...range,
      startZ: model.startZ,
      endZ,
      durationHours: hours,
    };
    assert.equal(buildMeteogramPrintPlan({ model, settings: { timeMode: "Z" }, range: customRange }).pages.length, expectedPages);
  }
});

test("light print theme overrides direct SVG colors that would disappear on white paper", () => {
  for (const selector of [
    ".aviation-meteogram-time text",
    ".aviation-meteogram-time .aviation-meteogram-time-zone",
    ".aviation-meteogram-forecast-tag",
    ".aviation-meteogram-wind-gust",
    ".aviation-meteogram-conditional-value",
  ]) {
    assert.match(meteogramCss, new RegExp(`body\\.aviation-meteogram-printing ${selector.replaceAll(".", "\\.")}`));
  }
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-weather-icon\{[\s\S]*fill:#111!important;[\s\S]*filter:none!important;[\s\S]*opacity:1!important/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-clear-sun-disc\{[\s\S]*fill:#fff!important;[\s\S]*stroke:#111!important/);
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-clear-moon-crescent\{fill:#666!important;filter:none!important\}/);
  for (const selector of [
    ".aviation-meteogram-axis-gutter-background",
    ".aviation-meteogram-cloud-tower",
    ".aviation-meteogram-cloud-anvil",
    ".aviation-meteogram-cloud-vv-veil-fill",
    ".aviation-meteogram-cloud-vv-band",
    ".aviation-meteogram-cloud-layer-label-tag",
    ".aviation-meteogram-cloud-label-leader",
    ".aviation-meteogram-atmosphere-precip line",
    ".aviation-meteogram-atmosphere-snow path",
    ".aviation-meteogram-atmosphere-pellets circle",
    ".aviation-meteogram-atmosphere-obscuration path",
    ".aviation-meteogram-atmosphere-freezing path",
    ".aviation-meteogram-atmosphere-lightning",
  ]) {
    assert.match(meteogramCss, new RegExp(`body\\.aviation-meteogram-printing ${selector.replaceAll(".", "\\.")}`), `${selector} has an explicit light-print treatment`);
  }
  assert.match(meteogramCss, /aviation-meteogram-atmosphere-lightning\{fill:#111!important;stroke:#111!important;filter:none!important\}/);
});

test("row-label content is centralized and follows every live display toggle", () => {
  const zulu = meteogramRowLabelDescriptors({ timeMode: "Z", temperatureUnit: "C", windUnit: "KT" }, true);
  assert.deepEqual(zulu.map(({ key, title, unit }) => [key, title, unit]), [
    ["time", "TIME", "UTC / Z"],
    ["weather", "WEATHER", "OBS + FORECAST"],
    ["temperature", "TEMPERATURE", "°C"],
    ["dewPoint", "DEW POINT", "°C"],
    ["tempLine", "TEMP LINE", "SHARED °C SCALE"],
    ["dewLine", "DEW POINT LINE", "SHARED °C SCALE"],
    ["wind", "WIND", "DOWNWIND ARROW · KT"],
    ["windSpeed", "WIND SPEED / GUST", "SOLID SUSTAINED · GUST WHISKER · KT"],
    ["pressure", "PRESSURE", "ALTIMETER · IN HG"],
    ["clouds", "CLOUDS / CIG", "FT AGL"],
    ["visibility", "VISIBILITY", "SM / REPORTED"],
    ["precip", "PRECIP (IN)", "INTERVAL TOTAL"],
    ["snow", "SNOW (IN)", "FCST / OBS DEPTH Δ"],
  ]);
  const local = meteogramRowLabelDescriptors({ timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" }, false);
  assert.equal(local.find(({ key }) => key === "time").unit, "STATION LOCAL");
  assert.equal(local.find(({ key }) => key === "weather").unit, "OBSERVED CODE");
  assert.equal(local.find(({ key }) => key === "tempLine").unit, "SHARED °F SCALE");
  assert.equal(local.find(({ key }) => key === "wind").unit, "DOWNWIND ARROW · MPH");
  assert.equal(local.find(({ key }) => key === "windSpeed").unit, "SOLID SUSTAINED · GUST WHISKER · MPH");
});

test("row-label width follows measured visible content with bounded wrapping instead of clipping", () => {
  assert.equal(meteogramDimensions(1, 320).labelWidth, 132, "omitting a measured width preserves the compact helper default");
  assert.equal(meteogramDimensions(1, 1200).labelWidth, 154, "omitting a measured width preserves the desktop helper default");
  const measuredWidths = new Map([
    ["DOWNWIND ARROW · KT", 122.056],
    ["DOWNWIND ARROW · MPH", 130.4],
  ]);
  const desktopMeasure = (text, kind) => measuredWidths.get(text) ?? String(text).length * (kind === "title" ? 7 : 4);
  const knots = meteogramRowLabelLayout({ timeMode: "Z", temperatureUnit: "C", windUnit: "KT" }, 1280, {
    hasForecast: true,
    compact: false,
    measureText: desktopMeasure,
  });
  const mph = meteogramRowLabelLayout({ timeMode: "Z", temperatureUnit: "C", windUnit: "MPH" }, 1280, {
    hasForecast: true,
    compact: false,
    measureText: desktopMeasure,
  });
  assert.equal(knots.width, 207, "the longer gust-whisker legend and physical-font safety padding participate in measured width");
  assert.equal(knots.minimumWidth, 154);
  assert.equal(knots.maximumWidth, 280);
  assert.equal(mph.width, knots.width, "the shared column reserves the widest live toggle variant so unit changes cannot move the timeline");
  assert.ok(knots.rows.every((row) => row.titleLines.length === 1 && row.unitLines.length === 1));

  const narrowMeasure = (text) => String(text).length * 7.5;
  const narrow = meteogramRowLabelLayout({ timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" }, 320, {
    hasForecast: true,
    compact: true,
    measureText: narrowMeasure,
  });
  assert.equal(narrow.minimumWidth, 112);
  assert.equal(narrow.maximumWidth, 112);
  assert.equal(narrow.width, 112, "compact text-only labels reserve most of the phone for actual timeline data");
  assert.equal(narrow.textX, 9);
  assert.equal(narrow.rightPadding, 7);
  assert.ok(narrow.rows.every((row) => row.showIcon === false), "decorative row icons yield to readable phone data width");
  const wind = narrow.rows.find(({ key }) => key === "wind");
  assert.ok(wind.unitLines.length > 1, "the overlong wind subtitle wraps at the viewport clamp");
  assert.equal(wind.unitLines.join(" "), "DOWNWIND ARROW · MPH");
  const windSpeed = narrow.rows.find(({ key }) => key === "windSpeed");
  assert.ok(windSpeed.titleLines.length > 1, "the new row title wraps instead of clipping");
  assert.ok(windSpeed.unitLines.length > 1, "the sustained/gust text legend wraps instead of clipping");
  assert.equal(windSpeed.titleLines.join(" "), "WIND SPEED / GUST");
  assert.equal(windSpeed.unitLines.join(" "), "SOLID SUSTAINED · GUST WHISKER · MPH");
  for (const row of narrow.rows) {
    for (const line of [...row.titleLines, ...row.unitLines]) {
      assert.ok(narrowMeasure(line) <= narrow.maximumTextWidth, `${row.key} line remains inside the shared label viewport`);
      assert.doesNotMatch(line, /…|\.\.\./, "labels are never ellipsized");
    }
    if (row.titleLines.length > 1 || row.unitLines.length > 1) {
      const requiredHeight = row.titleLines.length * 12 + 8 + row.unitLines.length * 10;
      assert.ok(requiredHeight <= row.bottom - row.top, `${row.key} wrapped text remains vertically contained by its matching data row`);
    }
  }
});

test("display toggles keep one shared header width and leave time, solar, NOW, and cloud geometry unchanged", () => {
  const timeline = [
    manualMeteogramPoint({
      observedZ: "2026-09-01T12:00:00Z",
      clouds: { layers: [{ cover: "BKN", heightFt: 7000, raw: "BKN070" }], clear: false, cavok: false, ceilingFt: 7000, display: "BKN070" },
    }),
    manualMeteogramPoint({
      kind: "FORECAST",
      reportType: "TAF",
      observedZ: "2026-09-01T18:00:00Z",
      validZ: "2026-09-01T18:00:00Z",
      tafIssuanceZ: "2026-09-01T11:00:00Z",
      clouds: { layers: [{ cover: "SCT", heightFt: 11000, raw: "SCT110" }], clear: false, cavok: false, ceilingFt: null, display: "SCT110" },
    }),
  ];
  const model = manualMeteogramModel(timeline);
  const variants = [
    { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" },
    { timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" },
  ];
  const renderings = variants.map((settings) => {
    const labelLayout = meteogramRowLabelLayout(settings, 1280, { hasForecast: true });
    const dimensions = meteogramDimensions(timeline, 1280, { labelWidth: labelLayout.width });
    const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth: 1280, labelLayout });
    return {
      labelWidth: labelLayout.width,
      pixelsPerHour: dimensions.pixelsPerHour,
      relativeX: dimensions.xPositions.map((x) => Number((x - dimensions.plotLeft).toFixed(4))),
      nowX: Number(svg.match(/aviation-meteogram-now-divider" x1="([\d.]+)"/)?.[1]) - dimensions.plotLeft,
      solar: renderedSolarGeometry(svg).map(({ x, ...event }) => ({ ...event, x: Number((x - dimensions.plotLeft).toFixed(4)) })),
      cloudX: [...svg.matchAll(/data-cloud-time-x="([\d.]+)"/g)].map((match) => Number((Number(match[1]) - dimensions.plotLeft).toFixed(4))),
      cloudBaseY: [...svg.matchAll(/data-base-y="([\d.]+)"/g)].map((match) => Number(match[1])),
    };
  });
  assert.deepEqual(renderings[1], renderings[0], "format-only toggles cannot resize or remap the shared proportional timeline");
});

test("main and sticky SVG layers consume one dynamic width and identical row geometry", () => {
  const model = manualMeteogramModel([
    manualMeteogramPoint({ observedZ: "2026-09-01T00:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", observedZ: "2026-09-01T03:00:00Z", validZ: "2026-09-01T03:00:00Z" }),
  ]);
  const measureText = (text) => String(text).length * 7.5;
  const settings = { timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" };
  const labelLayout = meteogramRowLabelLayout(settings, 320, {
    hasForecast: true,
    compact: true,
    measureText,
  });
  const dimensions = meteogramDimensions(model.timeline, 320, { labelWidth: labelLayout.width });
  assert.equal(dimensions.axisWidth, METEOGRAM_DATA_AXIS_WIDTH);
  assert.equal(dimensions.plotLeft, labelLayout.width + METEOGRAM_DATA_AXIS_WIDTH);
  const main = buildMeteogramSvgMarkup(model, settings, { viewportWidth: 320, labelLayout });
  const windSpeedGeometry = meteogramWindSpeedGeometry(model, settings, dimensions);
  const cloudScale = meteogramCloudScaleDefinition(model.timeline);
  const sticky = buildMeteogramStickyLabelsMarkup(settings, dimensions, true, labelLayout, windSpeedGeometry, cloudScale);
  for (const markup of [main, sticky]) {
    assert.match(markup, new RegExp(`data-label-width="${labelLayout.width}"`));
    assert.match(markup, new RegExp(`<rect class="aviation-meteogram-label-background" width="${labelLayout.width}"`));
    assert.match(markup, /data-row-key="wind"[^>]*data-row-top="366"[^>]*data-row-bottom="464"[^>]*data-row-wrapped="true"/);
    assert.match(markup, /aria-label="DOWNWIND ARROW · MPH" data-line-count="[2-9]"/);
    assert.doesNotMatch(markup, /DOWNWIND ARROW · MPH<\/text>/, "wrapped text is emitted as complete tspans");
    assert.match(markup, /data-row-key="windSpeed"[^>]*data-row-top="464"[^>]*data-row-bottom="538"[^>]*data-row-wrapped="true"/);
    assert.match(markup, /aria-label="WIND SPEED \/ GUST" data-line-count="[2-9]"/);
    assert.match(markup, /aria-label="SOLID SUSTAINED · GUST WHISKER · MPH" data-line-count="[2-9]"/);
  }
  assert.match(main, new RegExp(`id="aviationMeteogramWindClip"><rect x="${dimensions.plotLeft}"`));
  assert.match(main, new RegExp(`class="aviation-meteogram-description-divider" x1="${labelLayout.width}"`));
  assert.match(main, new RegExp(`class="aviation-meteogram-label-divider" x1="${dimensions.plotLeft}"`));
  assert.match(sticky, new RegExp(`viewBox="0 0 ${dimensions.plotLeft} 998"`));
  assert.match(sticky, /class="aviation-meteogram-wind-axis-sticky"/);
  assert.match(sticky, />0 MPH<\/text>/);
  assert.match(sticky, new RegExp(`class="aviation-meteogram-cloud-axis aviation-meteogram-cloud-axis-sticky"[\\s\\S]*data-axis-start="${labelLayout.width}"[\\s\\S]*data-axis-end="${labelLayout.width + METEOGRAM_CLOUD_AXIS_WIDTH}"`));
  assert.match(sticky, />10,000 FT<\/text>/);
  assert.match(sticky, new RegExp(`class="aviation-meteogram-description-divider" x1="${labelLayout.width}"`));
  assert.match(sticky, new RegExp(`class="aviation-meteogram-label-divider" x1="${dimensions.plotLeft - 1}"`));
  const rowGeometry = (markup) => [...markup.matchAll(/data-row-key="([^"]+)" data-row-top="([^"]+)" data-row-bottom="([^"]+)"/g)]
    .map((match) => match.slice(1));
  assert.deepEqual(rowGeometry(main), rowGeometry(sticky), "all duplicated labels keep exact vertical boundaries");
});

test("dynamic row-label measurement redraws for responsive and font lifecycle without affecting page geometry", () => {
  assert.match(meteogramJs, /createMeteogramRowLabelMeasurer\(doc\)/);
  assert.match(meteogramJs, /getComputedTextLength/);
  assert.match(meteogramJs, /getBBox\?\.\(\)\.width/);
  assert.match(meteogramJs, /Math\.max\(\.\.\.widths\)/);
  assert.match(meteogramJs, /meteogramRowLabelLayout\(displaySettings, availableWidth,[\s\S]*measureText: labelMeasurer\.measureText/);
  assert.match(meteogramJs, /buildMeteogramSvgMarkup\(model, settings, \{ viewportWidth, labelLayout \}\)/);
  assert.match(meteogramJs, /buildMeteogramStickyLabelsMarkup\(displaySettings, dimensions, model\.forecasts\.length > 0, labelLayout, windSpeedGeometry, cloudScale, forecastSources\.hasGfsPressure\)/);
  assert.match(meteogramJs, /new ResizeObserverCtor\(scheduleDraw\)/);
  assert.match(meteogramJs, /addEventListener\?\.\("orientationchange", scheduleDraw\)/);
  assert.match(meteogramJs, /addEventListener\?\.\("fullscreenchange", scheduleDraw\)/);
  assert.match(meteogramJs, /removeEventListener\?\.\("orientationchange", scheduleDraw\)/);
  assert.match(meteogramJs, /removeEventListener\?\.\("fullscreenchange", scheduleDraw\)/);
  assert.match(meteogramJs, /doc\.fonts\?\.ready[\s\S]*scheduleDraw/);
  const measurerRule = meteogramCss.match(/\.aviation-meteogram-label-measurer\{[\s\S]*?\}/)?.[0] || "";
  assert.match(measurerRule, /position:fixed/);
  assert.match(measurerRule, /width:1px/);
  assert.match(measurerRule, /visibility:hidden/);
  assert.match(measurerRule, /overflow:hidden/);
  assert.doesNotMatch(measurerRule, /display:none/);
  assert.match(meteogramCss, /\.aviation-meteogram-sticky-labels\{[\s\S]*overflow:hidden/);
  assert.doesNotMatch(meteogramCss, /\.aviation-meteogram-row-(?:title|unit)[^{]*\{[^}]*text-overflow\s*:\s*ellipsis/i);
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
  const table = buildMeteogramAccessibleTableMarkup(manualMeteogramModel(timeline), { windUnit: "KT", timeMode: "Z" });
  assert.match(svg, /clipPath id="aviationMeteogramWindClip"/);
  assert.match(svg, /class="aviation-meteogram-wind-row" clip-path="url\(#aviationMeteogramWindClip\)"/);
  assert.equal((svg.match(/class="aviation-meteogram-wind-arrow"/g) || []).length, 1);
  assert.match(svg, /rotate\(60\)/);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>CALM</);
  assert.doesNotMatch(svg, />CALM 0|>CALM<[^]*?aviation-meteogram-wind-speed[^>]*>0 KT/);
  assert.match(table, /Direction VRB · Sustained 4 KT · Gust —/, "collision suppression may hide decorative dense labels but preserves exact VRB data");
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>240°</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>12 KT</);
  assert.match(svg, /aviation-meteogram-wind-gust[^>]*>G19</);
});

test("gusts render as truthful whiskers and caps with connections only across adjacent gust buckets", () => {
  const atHour = (hour, overrides = {}) => manualMeteogramPoint({
    observedZ: new Date(Date.parse("2026-09-01T00:00:00Z") + hour * 60 * 60_000).toISOString(),
    windSpeedKt: 8,
    ...overrides,
  });
  const render = (timeline, settings = { windUnit: "KT", timeMode: "Z" }, viewportWidth = 1200) =>
    buildMeteogramSvgMarkup(manualMeteogramModel(timeline), settings, { viewportWidth });

  const noGust = render([atHour(0), atHour(1, { windSpeedKt: 10 })]);
  assert.match(noGust, /aviation-meteogram-wind-sustained-line/);
  assert.equal((noGust.match(/aviation-meteogram-wind-sustained-marker/g) || []).length, 2);
  assert.doesNotMatch(noGust, /aviation-meteogram-wind-gust-(?:whisker|cap|label|line)/,
    "a missing gust produces no gust geometry or annotation");

  const isolatedTimeline = [atHour(0, { windGustKt: 15 })];
  const isolatedModel = manualMeteogramModel(isolatedTimeline);
  const isolatedGeometry = meteogramWindSpeedGeometry(isolatedModel, { windUnit: "KT" });
  const isolatedKt = render(isolatedTimeline);
  const isolatedMph = render(isolatedTimeline, { windUnit: "MPH", timeMode: "Z" });
  assert.equal((isolatedKt.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 1);
  assert.equal((isolatedKt.match(/aviation-meteogram-wind-gust-cap/g) || []).length, 1);
  assert.equal((isolatedKt.match(/aviation-meteogram-wind-gust-label/g) || []).length, 1);
  assert.match(isolatedKt, new RegExp(
    `class="aviation-meteogram-wind-gust-whisker" data-sustained-kt="8" data-gust-kt="15" x1="0" y1="${isolatedGeometry.sustainedPoints[0].y.toFixed(1)}" x2="0" y2="${isolatedGeometry.gustPoints[0].y.toFixed(1)}"`,
  ));
  assert.match(isolatedKt, new RegExp(
    `class="aviation-meteogram-wind-gust-marker aviation-meteogram-wind-gust-cap" data-gust-kt="15" x1="-4.5" y1="${isolatedGeometry.gustPoints[0].y.toFixed(1)}" x2="4.5" y2="${isolatedGeometry.gustPoints[0].y.toFixed(1)}"`,
  ));
  assert.match(isolatedKt, /aviation-meteogram-wind-gust-label[^>]*>G15<\/text>/);
  assert.match(isolatedMph, /aviation-meteogram-wind-gust-label[^>]*>G17<\/text>/);
  const whiskerCoordinates = (markup) => markup.match(/wind-gust-whisker[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/)?.slice(1);
  assert.deepEqual(whiskerCoordinates(isolatedMph), whiskerCoordinates(isolatedKt),
    "KT/MPH changes values and labels without moving truthful geometry");
  assert.doesNotMatch(isolatedKt, /<path class="aviation-meteogram-wind-gust-line/,
    "one isolated gust does not create a connection path");

  const adjacent = render([
    atHour(0, { windSpeedKt: 8, windGustKt: 15 }),
    atHour(1, { windSpeedKt: 10, windGustKt: 18 }),
  ]);
  assert.equal((adjacent.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 2);
  assert.equal((adjacent.match(/aviation-meteogram-wind-gust-cap/g) || []).length, 2);
  assert.match(adjacent, /<path class="aviation-meteogram-wind-gust-line" d="M[^" ]+ [^" ]+ L[^" ]+ [^" ]+"/,
    "adjacent gust-bearing buckets receive one subtle dashed connection");

  const adjacentForecast = render([
    atHour(0, {
      kind: "FORECAST", reportType: "TAF", validZ: "2026-09-01T00:00:00Z",
      tafIssuanceZ: "2026-08-31T23:00:00Z", windSpeedKt: 12, windGustKt: 20,
    }),
    atHour(1, {
      kind: "FORECAST", reportType: "TAF", validZ: "2026-09-01T01:00:00Z",
      tafIssuanceZ: "2026-08-31T23:00:00Z", windSpeedKt: 14, windGustKt: 22,
    }),
  ]);
  assert.match(adjacentForecast, /<path class="aviation-meteogram-wind-gust-line aviation-meteogram-line-forecast"[^>]* L/,
    "adjacent TAF gusts retain the established forecast distinction");
  assert.equal((adjacentForecast.match(/aviation-meteogram-wind-speed-sample-forecast/g) || []).length, 2);

  const missingMiddle = render([
    atHour(0, { windGustKt: 15 }),
    atHour(1, { windGustKt: null }),
    atHour(2, { windGustKt: 20 }),
  ]);
  assert.equal((missingMiddle.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 2);
  assert.equal((missingMiddle.match(/aviation-meteogram-wind-gust-cap/g) || []).length, 2);
  assert.doesNotMatch(missingMiddle, /<path class="aviation-meteogram-wind-gust-line/,
    "gust connections never bridge a missing report");

  const gustWithoutSustained = render([atHour(0, { windSpeedKt: null, windGustKt: 15 })]);
  assert.doesNotMatch(gustWithoutSustained, /aviation-meteogram-wind-gust-whisker/,
    "a missing sustained value cannot acquire a fabricated whisker baseline");
  assert.equal((gustWithoutSustained.match(/aviation-meteogram-wind-gust-cap/g) || []).length, 1,
    "the real gust remains visible and accessible");

  const special = render([
    atHour(0, { windDirectionDeg: 0, windSpeedKt: 0, windGustKt: 9 }),
    atHour(1, { windDirectionDeg: null, windVariable: true, windSpeedKt: 11, windGustKt: 18 }),
  ]);
  assert.equal((special.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 2,
    "CALM/VRB direction presentation does not alter actual speed/gust geometry");

  const denseTimeline = Array.from({ length: 12 }, (_value, index) => manualMeteogramPoint({
    observedZ: new Date(Date.parse("2026-09-01T00:00:00Z") + index * 5 * 60_000).toISOString(),
    windSpeedKt: 8 + index % 3,
    windGustKt: 15 + index % 4,
  }));
  const denseModel = manualMeteogramModel(denseTimeline);
  const denseDimensions = meteogramDimensions(denseTimeline, 390);
  const denseGeometry = meteogramWindSpeedGeometry(denseModel, { windUnit: "KT" }, denseDimensions);
  const denseMask = meteogramGustLabelMask(denseGeometry.gustPoints);
  const visibleXs = denseGeometry.gustPoints.filter((_point, index) => denseMask[index]).map((point) => point.x);
  assert.ok(visibleXs.length > 0 && visibleXs.length < denseTimeline.length, "dense gust labels are selectively reduced");
  assert.ok(visibleXs.every((x, index) => index === 0 || x - visibleXs[index - 1] >= 34));
  const dense = render(denseTimeline, { windUnit: "KT", timeMode: "Z" }, 390);
  assert.equal((dense.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, denseTimeline.length);
  assert.equal((dense.match(/aviation-meteogram-wind-gust-cap/g) || []).length, denseTimeline.length);
  assert.equal((dense.match(/aviation-meteogram-wind-gust-label/g) || []).length, visibleXs.length,
    "only decorative labels yield; every gust whisker and cap remains");
  for (const viewportWidth of [390, 844, 1280, 1366, 1920]) {
    const responsive = render(isolatedTimeline, { windUnit: "KT", timeMode: "Z" }, viewportWidth);
    assert.equal((responsive.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 1);
    assert.equal((responsive.match(/aviation-meteogram-wind-gust-cap/g) || []).length, 1);
    assert.doesNotMatch(responsive, /(?:NaN|Infinity)/);
  }
});

test("wind speed and gust share one truthful zero-based scale across observed and current-TAF buckets", () => {
  const timeline = [
    manualMeteogramPoint({
      observedZ: "2026-09-01T00:00:00Z", windDirectionDeg: 240, windSpeedKt: 12, windGustKt: 20,
    }),
    manualMeteogramPoint({
      observedZ: "2026-09-01T01:00:00Z", windDirectionDeg: 0, windSpeedKt: 0, windGustKt: null,
    }),
    manualMeteogramPoint({
      observedZ: "2026-09-01T02:00:00Z", windDirectionDeg: null, windVariable: true, windSpeedKt: 18, windGustKt: 19,
    }),
    manualMeteogramPoint({
      observedZ: "2026-09-01T05:00:00Z", windDirectionDeg: null, windSpeedKt: null, windGustKt: null,
    }),
    manualMeteogramPoint({
      kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-01T06:00:00Z", validZ: "2026-09-01T06:00:00Z",
      tafIssuanceZ: "2026-09-01T03:00:00Z", windDirectionDeg: 170, windSpeedKt: 14, windGustKt: 24,
    }),
    manualMeteogramPoint({
      kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-01T07:00:00Z", validZ: "2026-09-01T07:00:00Z",
      tafIssuanceZ: "2026-09-01T03:00:00Z", windDirectionDeg: 180, windSpeedKt: 16, windGustKt: null,
    }),
    manualMeteogramPoint({
      kind: "FORECAST", reportType: "FORECAST", observedZ: "2026-09-01T08:00:00Z", validZ: "2026-09-01T08:00:00Z",
      tafIssuanceZ: null, supplementalOnly: true, windDirectionDeg: 190, windSpeedKt: 99, windGustKt: 100,
    }),
  ];
  const model = manualMeteogramModel(timeline);
  const labelLayout = meteogramRowLabelLayout({ windUnit: "KT" }, 1200, { hasForecast: true });
  const dimensions = meteogramDimensions(timeline, 1200, { labelWidth: labelLayout.width });
  const knots = meteogramWindSpeedGeometry(model, { windUnit: "KT" }, dimensions);
  const mph = meteogramWindSpeedGeometry(model, { windUnit: "MPH" }, dimensions);

  assert.equal(knots.range.minimum, 0);
  assert.ok(knots.range.maximum > 24, "the shared scale leaves headroom above the real maximum gust");
  assert.ok(knots.range.maximum >= 10, "light winds never receive an exaggerated narrow domain");
  assert.equal(knots.sustainedPoints[1].valueKt, 0, "CALM remains a real zero-speed point");
  assert.equal(knots.sustainedPoints[1].y, knots.bottom);
  assert.equal(knots.sustainedPoints[2].valueKt, 18, "VRB retains its reported speed");
  assert.equal(knots.sustainedPoints[3], null, "missing sustained wind remains a path gap");
  assert.equal(knots.gustPoints[1], null, "missing gust is never copied from sustained wind");
  assert.equal(knots.gustPoints[5], null, "a forecast bucket without a gust stays missing");
  assert.equal(knots.sustainedPoints[6], null, "NWS-only wind cannot masquerade as current TAF wind");
  assert.equal(knots.gustPoints[6], null);
  assert.ok(knots.gustPoints[0].y < knots.sustainedPoints[0].y, "G20 sits above 12 KT sustained");
  const wideSpread = Math.abs(knots.gustPoints[0].y - knots.sustainedPoints[0].y);
  const narrowSpread = Math.abs(knots.gustPoints[2].y - knots.sustainedPoints[2].y);
  assert.ok(wideSpread > narrowSpread * 7.99 && wideSpread < narrowSpread * 8.01, "actual gust spread controls physical separation");

  for (let index = 0; index < timeline.length; index += 1) {
    for (const field of ["sustainedPoints", "gustPoints"]) {
      if (!knots[field][index]) continue;
      assert.equal(knots[field][index].x, dimensions.xPositions[index], "wind series reuses the shared exact x coordinate");
      assert.equal(mph[field][index].x, knots[field][index].x);
      assert.ok(Math.abs(mph[field][index].y - knots[field][index].y) < 1e-9, "KT/MPH changes labels and values, not geometry");
      assert.ok(Math.abs(mph[field][index].value - knots[field][index].valueKt * 1.150779448) < 1e-6);
    }
  }
  assert.equal(mph.range.maximum, knots.range.maximum, "both units retain one canonical knot domain");
  assert.ok(knots.ticks.every((tick) => tick.label.endsWith(" KT")));
  assert.ok(mph.ticks.every((tick) => tick.label.endsWith(" MPH")));
  assert.equal(knots.ticks[0].value, 0);
  assert.equal(mph.ticks[0].value, 0);

  const svg = buildMeteogramSvgMarkup(model, { windUnit: "KT", timeMode: "Z" }, { viewportWidth: 1200, labelLayout });
  assert.ok(svg.indexOf("aviation-meteogram-wind-row") < svg.indexOf("aviation-meteogram-wind-speed-row"));
  assert.ok(svg.indexOf("aviation-meteogram-wind-speed-row") < svg.indexOf("aviation-meteogram-pressure-line"));
  assert.match(svg, /id="aviationMeteogramWindSpeedClip"[^>]*[\s\S]*?y="464"[^>]*height="74"/);
  assert.match(svg, /aviation-meteogram-wind-sustained-line/);
  assert.match(svg, /aviation-meteogram-wind-sustained-line aviation-meteogram-line-forecast/);
  assert.equal((svg.match(/aviation-meteogram-wind-gust-marker/g) || []).length, 3, "only three actual gust values create markers");
  assert.equal((svg.match(/aviation-meteogram-wind-gust-whisker/g) || []).length, 3, "each actual gust is visibly tied to its sustained value");
  assert.equal((svg.match(/aviation-meteogram-wind-gust-label/g) || []).length, 3, "spaced gusts retain intuitive G labels");
  assert.doesNotMatch(svg, /data-gust-kt="(?:0|12|14|16|18|99|100)"/, "no missing or non-TAF gust is fabricated");
  const gustPaths = [...svg.matchAll(/<path class="aviation-meteogram-wind-gust-line(?: aviation-meteogram-line-forecast)?" d="([^"]+)"/g)];
  assert.equal(gustPaths.length, 0, "isolated gusts use whiskers and caps without meaningless one-point connection paths");
  const dividerX = Number(svg.match(/aviation-meteogram-now-divider" x1="([\d.]+)"/)?.[1]);
  assert.ok(Math.abs(dividerX - dimensions.xForTime("2026-09-01T06:00:00Z")) <= 0.1, "NOW uses the same x mapping as the new row");
});

test("wind auto-scale expands safely for G25, G50, and G80 and remains exact in KT/MPH", () => {
  for (const [gustKt, expectedMaximumKt] of [[25, 30], [50, 60], [80, 100]]) {
    const point = manualMeteogramPoint({ windDirectionDeg: 240, windSpeedKt: 18, windGustKt: gustKt });
    const model = manualMeteogramModel([point]);
    const dimensions = meteogramDimensions(model.timeline, 1000);
    const knots = meteogramWindSpeedGeometry(model, { windUnit: "KT" }, dimensions);
    const mph = meteogramWindSpeedGeometry(model, { windUnit: "MPH" }, dimensions);
    assert.equal(knots.range.minimum, 0);
    assert.equal(knots.range.maximum, expectedMaximumKt, `G${gustKt} uses a rounded domain with headroom`);
    assert.ok(knots.range.maximum > gustKt);
    assert.ok(knots.gustPoints[0].y > knots.top, `G${gustKt} is not clipped at the top edge`);
    assert.ok(knots.gustPoints[0].y < knots.bottom);
    assert.equal(mph.range.maximum, knots.range.maximum, "MPH retains the canonical knot domain");
    assert.ok(Math.abs(mph.gustPoints[0].y - knots.gustPoints[0].y) < 1e-9, "unit conversion preserves graph geometry");
    assert.ok(Math.abs(mph.gustPoints[0].value - gustKt * 1.150779448) < 1e-6);
    assert.ok(knots.ticks.every((tick) => tick.y >= knots.top && tick.y <= knots.bottom));
    assert.ok(mph.ticks.every((tick) => tick.y >= mph.top && tick.y <= mph.bottom));

    const svgKt = buildMeteogramSvgMarkup(model, { windUnit: "KT", timeMode: "Z" });
    const svgMph = buildMeteogramSvgMarkup(model, { windUnit: "MPH", timeMode: "Z" });
    const tableKt = buildMeteogramAccessibleTableMarkup(model, { windUnit: "KT", timeMode: "Z" });
    const tableMph = buildMeteogramAccessibleTableMarkup(model, { windUnit: "MPH", timeMode: "Z" });
    assert.match(svgKt, new RegExp(`data-domain-max-kt="${expectedMaximumKt}"`));
    assert.match(svgKt, new RegExp(`GUST: ${gustKt} KT`));
    assert.match(svgKt, new RegExp(`wind-gust-cap" data-gust-kt="${gustKt}"[^>]*y1="${knots.gustPoints[0].y.toFixed(1)}"[^>]*y2="${knots.gustPoints[0].y.toFixed(1)}"`));
    assert.match(svgKt, new RegExp(`wind-gust-label" data-gust-label-kt="${gustKt}"[^>]*>G${gustKt}<`));
    assert.match(svgMph, new RegExp(`GUST: ${Math.round(gustKt * 1.150779448)} MPH`));
    assert.match(svgMph, new RegExp(`wind-gust-label" data-gust-label-kt="${gustKt}"[^>]*>G${Math.round(gustKt * 1.150779448)}<`));
    assert.match(tableKt, new RegExp(`Gust ${gustKt} KT`));
    assert.match(tableMph, new RegExp(`Gust ${Math.round(gustKt * 1.150779448)} MPH`));
  }

  const strongSustained = manualMeteogramModel([
    manualMeteogramPoint({ windSpeedKt: 45, windGustKt: 70 }),
  ]);
  assert.equal(meteogramWindSpeedGeometry(strongSustained, { windUnit: "KT" }).range.maximum, 80);
});

test("wind speed/gust tooltip, tap/focus behavior, styles, and accessible table expose exact source data", () => {
  const observed = manualMeteogramPoint({
    observedZ: "2026-09-01T14:54:00Z", reportType: "SPECI", windDirectionDeg: 360, windSpeedKt: 3, windGustKt: null,
  });
  const forecast = manualMeteogramPoint({
    kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-02T03:00:00Z", validZ: "2026-09-02T03:00:00Z",
    tafIssuanceZ: "2026-09-01T14:00:00Z", windDirectionDeg: 170, windSpeedKt: 4, windGustKt: 12,
  });
  const model = manualMeteogramModel([observed, forecast]);
  const knots = buildMeteogramSvgMarkup(model, { windUnit: "KT", timeMode: "Z" });
  const mph = buildMeteogramSvgMarkup(model, { windUnit: "MPH", timeMode: "Z" });
  const local = buildMeteogramSvgMarkup(model, { windUnit: "KT", timeMode: "LOCAL" });
  const tableKnots = buildMeteogramAccessibleTableMarkup(model, { windUnit: "KT", timeMode: "Z" });
  const tableMph = buildMeteogramAccessibleTableMarkup(model, { windUnit: "MPH", timeMode: "Z" });

  assert.match(knots, /data-wind-tooltip="01 SEP 2026 · 1454Z&#10;WIND: 360° 3 KT&#10;GUST: —&#10;SOURCE: SPECI"/);
  assert.match(knots, /data-wind-tooltip="02 SEP 2026 · 0300Z&#10;WIND: 170° 4 KT&#10;GUST: 12 KT&#10;SOURCE: TAF"/);
  assert.match(mph, /WIND: 360° 3 MPH&#10;GUST: —/);
  assert.match(mph, /WIND: 170° 5 MPH&#10;GUST: 14 MPH/);
  assert.match(local, /data-wind-tooltip="01 SEP 2026 · 09:54 CDT&#10;WIND: 360° 3 KT&#10;GUST: —&#10;SOURCE: SPECI"/);
  assert.match(knots, /data-wind-speed-sample="0"[^>]*tabindex="0" role="img"[^>]*aria-describedby="aviationMeteogramWindTooltip"/);
  assert.match(meteogramJs, /scroller\.addEventListener\("pointerover"[\s\S]*showWindTooltip/);
  assert.match(meteogramJs, /scroller\.addEventListener\("focusin"[\s\S]*showWindTooltip/);
  assert.match(meteogramJs, /scroller\.addEventListener\("click"[\s\S]*showWindTooltip\(sample, \{ pin: true \}\)/);
  assert.match(meteogramJs, /event\.key === "Escape"/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-sustained-line\{[\s\S]*stroke:#32d8eb;[\s\S]*stroke-width:2\.5/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-gust-line\{[\s\S]*stroke:#ffbf32;[\s\S]*stroke-dasharray:3 4/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-gust-whisker\{[\s\S]*stroke:#c58d28;[\s\S]*stroke-width:1\.15/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-gust-cap\{[\s\S]*stroke:#ffbf32;[\s\S]*stroke-width:2\.4/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-gust-label\{[\s\S]*fill:#ffd36b;[\s\S]*paint-order:stroke/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-speed-sample-forecast \.aviation-meteogram-wind-gust-whisker,[\s\S]*opacity:\.62/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-sustained-line\.aviation-meteogram-line-forecast\{[\s\S]*stroke-dasharray:none;[\s\S]*opacity:\.6/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-gust-line\.aviation-meteogram-line-forecast\{[\s\S]*stroke-dasharray:7 4 2 4/);
  assert.match(meteogramCss, /\.aviation-meteogram-wind-tooltip\{[\s\S]*position:absolute[\s\S]*overflow-wrap:anywhere/);
  assert.match(tableKnots, /Direction 360° · Sustained 3 KT · Gust —/);
  assert.match(tableKnots, /Direction 170° · Sustained 4 KT · Gust 12 KT/);
  assert.match(tableMph, /Direction 360° · Sustained 3 MPH · Gust —/);
  assert.match(tableMph, /Direction 170° · Sustained 5 MPH · Gust 14 MPH/);
  assert.match(meteogramJs, /doc\.activeElement === activeWindTooltipSample[\s\S]*showWindTooltip\(activeWindTooltipSample/);
});

test("persistent selected-basis time ruler reuses exact timeline geometry and hides from print", () => {
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-01T23:00:00Z" }),
    manualMeteogramPoint({ observedZ: "2026-09-02T00:00:00Z" }),
    manualMeteogramPoint({ kind: "FORECAST", reportType: "TAF", observedZ: "2026-09-02T01:00:00Z", validZ: "2026-09-02T01:00:00Z", tafIssuanceZ: "2026-09-01T22:00:00Z" }),
  ];
  const model = manualMeteogramModel(timeline);
  const labelLayout = meteogramRowLabelLayout({ timeMode: "Z", temperatureUnit: "C", windUnit: "KT" }, 1000, { hasForecast: true });
  const dimensions = meteogramDimensions(timeline, 1000, { labelWidth: labelLayout.width });
  const zulu = buildMeteogramStickyTimeRulerMarkup(model, { timeMode: "Z" }, dimensions);
  const local = buildMeteogramStickyTimeRulerMarkup(model, { timeMode: "LOCAL" }, dimensions);
  assert.match(zulu, /data-time-basis="Z"/);
  assert.match(zulu, />TIME<\/strong><span>UTC \/ Z<\/span>/);
  assert.match(zulu, />2300Z<|>0000Z</);
  assert.doesNotMatch(zulu, /data-time-basis="LOCAL"|\d{4}L/);
  assert.match(local, /data-time-basis="LOCAL"/);
  assert.match(local, />1800L<|>1900L</);
  assert.match(local, /CDT/);
  for (const [index, x] of dimensions.xPositions.entries()) {
    assert.match(zulu, new RegExp(`data-time-x="${x.toFixed(1)}" data-time-z="${timeline[index].validZ || timeline[index].observedZ}"`));
  }
  const main = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1000, labelLayout });
  const mainDivider = Number(main.match(/aviation-meteogram-now-divider" x1="([\d.]+)"/)?.[1]);
  const rulerDivider = Number(zulu.match(/data-now-x="([\d.]+)"/)?.[1]);
  assert.ok(Math.abs(mainDivider - rulerDivider) <= 0.1);
  assert.match(meteogramJs, /originalTimeRowBottom <= resultsRect\.top \+ 1/);
  assert.match(meteogramJs, /translateX\(\$\{\-\(Number\(scroller\.scrollLeft/);
  assert.match(meteogramCss, /\.aviation-meteogram-sticky-time-ruler\{[\s\S]*position:sticky;[\s\S]*top:0/);
  assert.match(meteogramCss, /aviation-meteogram-printing \.aviation-meteogram-sticky-time-ruler\{display:none!important\}/);
});

test("cloud morphology, convective development, and weather overlays remain semantically distinct and truthful", () => {
  const forms = Object.fromEntries(["FEW", "SCT", "BKN", "OVC", "VV"].map((cover) => [cover, meteogramCloudFormDefinition({ cover })]));
  assert.equal(forms.FEW.morphology, "sparse-isolated-puffs");
  assert.equal(forms.SCT.morphology, "scattered-groups-with-openings");
  assert.equal(forms.BKN.morphology, "mostly-continuous-broken-deck");
  assert.equal(forms.OVC.morphology, "continuous-unbroken-deck");
  assert.equal(forms.VV.morphology, "vertical-visibility-obscuration");
  assert.deepEqual(
    [forms.FEW.silhouette, forms.SCT.silhouette, forms.BKN.silhouette, forms.OVC.silhouette, forms.VV.silhouette],
    ["isolated-clusters", "separated-cloud-groups", "broad-broken-deck", "continuous-overcast-deck", "obscuration-veil"],
  );
  assert.ok(forms.FEW.occupiedRatio < forms.SCT.occupiedRatio && forms.SCT.occupiedRatio < forms.BKN.occupiedRatio && forms.BKN.occupiedRatio < forms.OVC.occupiedRatio);
  assert.deepEqual([forms.FEW.gapCount, forms.SCT.gapCount, forms.BKN.gapCount, forms.OVC.gapCount], [1, 2, 1, 0]);
  assert.equal(forms.BKN.continuousBase, false, "BKN has one deliberate opening");
  assert.equal(forms.OVC.continuousBase, true, "OVC is an uninterrupted deck");
  assert.equal(forms.VV.paths.length, 0, "VV uses an obscuration veil, never an ordinary puffy cloud body");
  assert.equal(forms.BKN.paths.length, 2, "BKN is two broad masses around one narrow opening, not detached puff icons");
  assert.ok(forms.SCT.coverage < forms.BKN.coverage && forms.BKN.coverage <= forms.OVC.coverage, "coverage grows from scattered to broken to overcast");
  assert.ok(forms.BKN.coverage <= 1 && forms.OVC.coverage <= 1 && forms.VV.coverage <= 1, "broad scenes stay inside their discrete timestamp cell");
  assert.notDeepEqual(forms.BKN.paths, forms.FEW.paths, "BKN is its own mostly-continuous morphology, not widened FEW art");
  assert.notDeepEqual(forms.BKN.paths, forms.SCT.paths, "BKN does not reuse scattered-cloud art");

  const cloudPoint = (raw, weatherCodes = [], observedZ = "2026-09-01T00:00:00.000Z") => {
    const match = raw.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    const layer = { cover: match[1], heightFt: Number(match[2]) * 100, convective: match[3] || "", raw };
    return manualMeteogramPoint({
      observedZ,
      clouds: { layers: [layer], clear: false, cavok: false, ceilingFt: ["BKN", "OVC", "VV"].includes(layer.cover) ? layer.heightFt : null, display: raw },
      weatherCodes,
    });
  };
  const comparison = ["FEW050", "SCT050", "BKN050", "OVC050", "VV005"].map((raw, index) => (
    cloudPoint(raw, [], new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 60 * 60 * 1000).toISOString())
  ));
  const comparisonSvg = buildMeteogramSvgMarkup(manualMeteogramModel(comparison), { timeMode: "Z" });
  for (const definition of Object.values(forms)) assert.match(comparisonSvg, new RegExp(`data-cloud-morphology="${definition.morphology}"`));
  assert.match(comparisonSvg, /data-cloud-silhouette="broad-broken-deck" data-cloud-occupied-ratio="0.91" data-cloud-gap-count="1"/);
  assert.match(comparisonSvg, /data-cloud-silhouette="continuous-overcast-deck" data-cloud-occupied-ratio="1" data-cloud-gap-count="0" data-cloud-continuous-base="true"/);
  assert.match(comparisonSvg, /data-cloud-silhouette="obscuration-veil"[\s\S]*data-cloud-body-count="0"/);
  assert.match(comparisonSvg, /aviation-meteogram-cloud-vv-wisps/);
  assert.doesNotMatch(comparisonSvg, /data-top-ft/);

  const convective = [
    cloudPoint("SCT025TCU", [], "2026-09-01T00:00:00.000Z"),
    cloudPoint("BKN030CB", [], "2026-09-01T01:00:00.000Z"),
    cloudPoint("BKN030CB", ["TSRA"], "2026-09-01T02:00:00.000Z"),
  ];
  const convectiveSvg = buildMeteogramSvgMarkup(manualMeteogramModel(convective), { timeMode: "Z" });
  assert.match(convectiveSvg, /aviation-meteogram-cloud-development-TCU/);
  assert.match(convectiveSvg, /aviation-meteogram-cloud-development-CB/);
  assert.match(convectiveSvg, /aviation-meteogram-cloud-anvil/);
  assert.equal((convectiveSvg.match(/data-weather-lightning="reported-thunder"/g) || []).length, 1, "CB alone never fabricates lightning; TSRA adds it once");
  const convectiveScale = meteogramCloudScaleDefinition(convective).maximumFt;
  const expectedCbBaseY = meteogramCloudBaseY(3000, convectiveScale);
  const lightning = meteogramLightningGeometry(convective[2], convectiveScale);
  assert.equal(lightning.anchor, "reported-convective-base");
  assert.equal(lightning.anchorToken, "BKN030CB");
  assert.equal(lightning.placement, "emanates-from-base");
  assert.equal(lightning.baseFt, 3000);
  assert.equal(lightning.baseY, expectedCbBaseY, "lightning uses the exact reported CB base geometry");
  assert.equal(lightning.startY, lightning.baseY, "the bolt begins on, rather than floating away from, the reported cloud base");
  assert.equal(lightning.tipY, lightning.baseY + 13);
  const convectiveLightningPath = convectiveSvg.match(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/)?.[0] || "";
  assert.match(convectiveLightningPath, /data-lightning-anchor="reported-convective-base"/);
  assert.match(convectiveLightningPath, /data-lightning-anchor-token="BKN030CB"/);
  assert.match(convectiveLightningPath, /data-lightning-placement="emanates-from-base"/);
  assert.match(convectiveLightningPath, new RegExp(`data-lightning-start-y="${lightning.startY.toFixed(1).replace(".", "\\.")}"`));
  assert.match(convectiveLightningPath, new RegExp(`data-lightning-tip-y="${lightning.tipY.toFixed(1).replace(".", "\\.")}"`));
  assert.match(convectiveLightningPath, /data-lightning-base-ft="3000"/);
  assert.match(convectiveLightningPath, new RegExp(`data-lightning-base-y="${expectedCbBaseY.toFixed(1).replace(".", "\\.")}"`));
  assert.match(convectiveSvg, new RegExp(`d="M[^ ]+ ${lightning.startY.toFixed(1).replace(".", "\\.")}l-4 7h3l-2 6 8-9h-3l3-4Z"`), "rendered bolt path uses the restrained compact thunder-badge geometry");
  assert.doesNotMatch(buildMeteogramSvgMarkup(manualMeteogramModel([cloudPoint("SCT025TCU")]), { timeMode: "Z" }), /data-weather-lightning=/, "TCU alone never fabricates lightning");
  assert.doesNotMatch(buildMeteogramSvgMarkup(manualMeteogramModel([cloudPoint("BKN030CB")]), { timeMode: "Z" }), /data-weather-lightning=/, "CB alone never fabricates lightning");
  const genericThunderSvg = buildMeteogramSvgMarkup(manualMeteogramModel([cloudPoint("BKN030", ["TSRA"])]), { timeMode: "Z" });
  assert.match(genericThunderSvg, /data-lightning-anchor="reported-cloud-base"/);
  assert.match(genericThunderSvg, /data-lightning-base-ft="3000"/, "thunder without an explicit convective layer falls back to the lowest reported cloud base");
  const lightningIndex = convectiveSvg.indexOf("data-weather-lightning=\"reported-thunder\"");
  const cbMarkerIndex = convectiveSvg.indexOf("data-cloud-base-marker=\"BKN030CB\"");
  const cbLabelIndex = convectiveSvg.indexOf("data-cloud-label=\"BKN030CB\"");
  const cloudAxisIndex = convectiveSvg.indexOf("aviation-meteogram-cloud-axis");
  assert.ok(lightningIndex >= 0 && cbMarkerIndex >= 0 && cbLabelIndex >= 0, "lightning and its CB annotations are all rendered");
  assert.ok(Math.max(lightningIndex, cbMarkerIndex, cbLabelIndex) < cloudAxisIndex, "the protected cloud axis remains the final cloud-row overlay");
  assert.match(convectiveSvg, /CUMULONIMBUS REPORTED[\s\S]*CLOUD TOP NOT REPORTED/);

  for (const [code, density] of [["-RA", 1], ["RA", 2], ["+RA", 3]]) {
    const scene = meteogramWeatherSceneDefinition(cloudPoint("BKN030", [code]));
    assert.equal(scene.density, density);
    assert.equal(scene.rain, true);
  }
  const scenes = [
    ["SHRA", /aviation-meteogram-atmosphere-showers/],
    ["VCSH", /aviation-meteogram-atmosphere-vicinity/],
    ["FZRA", /aviation-meteogram-atmosphere-freezing/],
    ["+SN", /data-weather-snow-density="3"/],
    ["PL", /aviation-meteogram-atmosphere-ice-pellets/],
    ["GR", /aviation-meteogram-atmosphere-hail/],
    ["GS", /aviation-meteogram-atmosphere-small-hail/],
    ["FG", /aviation-meteogram-atmosphere-fog/],
    ["BR", /aviation-meteogram-atmosphere-mist/],
    ["HZ", /aviation-meteogram-atmosphere-haze/],
  ];
  for (const [code, expected] of scenes) {
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel([cloudPoint(code === "FG" ? "VV002" : "BKN030", [code])]), { timeMode: "Z" });
    assert.match(svg, expected, `${code} gets its truthful qualitative overlay`);
    assert.match(svg, /no precipitation amount or producing cloud layer is inferred/i);
  }
  const accessible = buildMeteogramAccessibleTableMarkup(manualMeteogramModel([cloudPoint("BKN030CB", ["TSRA"])]), { timeMode: "Z" });
  assert.match(accessible, /BROKEN CLOUD BASE 3,000 FT AGL · CUMULONIMBUS REPORTED · CLOUD TOP NOT REPORTED/);
});

test("one thunder marker starts at the lowest applicable convective or reported cloud base", () => {
  const clouds = {
    layers: [
      { cover: "SCT", heightFt: 3000, convective: "CB", raw: "SCT030CB" },
      { cover: "FEW", heightFt: 1800, convective: "TCU", raw: "FEW018TCU" },
      { cover: "BKN", heightFt: 5000, convective: "", raw: "BKN050" },
    ],
    clear: false,
    cavok: false,
    ceilingFt: 5000,
    display: "SCT030CB · FEW018TCU · BKN050",
  };
  const storm = manualMeteogramPoint({ clouds, weatherCodes: ["TS", "VCTS", "+TSRA"] });
  const geometry = meteogramLightningGeometry(storm, 10000);
  assert.equal(geometry.anchor, "reported-convective-base");
  assert.equal(geometry.anchorToken, "FEW018TCU");
  assert.equal(geometry.baseFt, 1800);
  assert.equal(geometry.startY, meteogramCloudBaseY(1800, 10000));
  assert.equal(geometry.tipY - geometry.startY, 13);
  const denseLayout = meteogramCloudBucketLayout(clouds.layers.map((layer) => ({ ...layer, ceilingFt: 5000 })), 10000, {
    columnX: 30,
    plotLeft: 0,
    plotRight: 60,
  });
  assert.deepEqual(denseLayout.visibleIndexes, [1, 2], "dense cells keep the lowest convective base alongside the ceiling-driving layer");
  assert.equal(denseLayout.summary?.text, "+1");

  const svg = buildMeteogramSvgMarkup(manualMeteogramModel([storm]), { timeMode: "Z" }, { viewportWidth: 390 });
  assert.equal((svg.match(/data-weather-lightning="reported-thunder"/g) || []).length, 1, "multiple thunder codes still yield one bolt");
  assert.match(svg, /data-lightning-anchor-token="FEW018TCU"/);
  assert.match(svg, new RegExp(`data-lightning-start-y="${geometry.startY.toFixed(1).replace(".", "\\.")}"`));

  const fallbackClouds = {
    ...clouds,
    layers: clouds.layers.map(({ convective: _convective, ...layer }) => ({ ...layer, raw: layer.raw.replace(/(?:CB|TCU)$/, "") })),
  };
  const fallback = meteogramLightningGeometry(manualMeteogramPoint({ clouds: fallbackClouds, weatherCodes: ["TSRA"] }), 10000);
  assert.equal(fallback.anchor, "reported-cloud-base");
  assert.equal(fallback.anchorToken, "FEW018");
  assert.equal(fallback.baseFt, 1800);
  assert.equal(fallback.startY, fallback.baseY);

  const noBase = meteogramLightningGeometry(manualMeteogramPoint({
    clouds: { layers: [{ cover: "BKN", heightFt: null, convective: "CB", raw: "BKN///CB" }], clear: false, cavok: false, ceilingFt: null, display: "BKN///CB" },
    weatherCodes: ["VCTS"],
  }), 10000);
  assert.equal(noBase.anchor, "generic-atmosphere");
  assert.equal(noBase.baseFt, null);
  assert.equal(noBase.baseY, null);

  const quietSvg = buildMeteogramSvgMarkup(manualMeteogramModel([manualMeteogramPoint({ clouds, weatherCodes: [] })]), { timeMode: "Z" });
  assert.doesNotMatch(quietSvg, /data-weather-lightning=/, "CB and TCU without thunder never create lightning");
});

test("live PROB30 TSRA bolts remain compact and collision-free beside BKN050CB labels on the 25,000-foot cloud scale", () => {
  const tafRaw = "TAF KMEM 091722Z 0918/1024 19006KT P6SM SCT060 BKN070 FM100100 18006KT P6SM SKC FM101600 23008KT P6SM FEW050 FM102100 34007KT P6SM BKN060 PROB30 1021/1024 5SM -TSRA BKN050CB";
  const model = buildMeteogramModel([
    meteogramReport({
      timestamp: "2026-09-09T17:54:00Z",
      raw: "METAR KMEM 091754Z 18006KT P6SM FEW250 30/20 A3000",
    }),
  ], {
    station: "KMEM",
    tafReports: [{
      station: "KMEM",
      timestamp: "2026-09-09T17:22:00Z",
      product: "TAF",
      raw: tafRaw,
      source: "Exact live PROB30 regression fixture",
    }],
    now: new Date("2026-09-09T18:05:00Z"),
  });
  const settings = { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" };
  const viewportWidth = 1000;
  const labelLayout = meteogramRowLabelLayout(settings, viewportWidth, { hasForecast: true });
  const dimensions = meteogramDimensions(model.timeline, viewportWidth, { labelWidth: labelLayout.width });
  const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth, labelLayout });
  const cloudScale = meteogramCloudScaleDefinition(model.timeline);
  assert.equal(model.taf.issuanceZ, "2026-09-09T17:22:00.000Z");
  assert.equal(cloudScale.maximumFt, 25000);

  const numberAttribute = (markup, name) => Number(markup.match(new RegExp(`${name}="(-?[\\d.]+)"`))?.[1]);
  const clipMatch = svg.match(/<clipPath id="aviationMeteogramCloudArtworkClip"><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"\/><\/clipPath>/);
  assert.ok(clipMatch, "the cloud artwork clip is present");
  const cloudClip = {
    left: Number(clipMatch[1]),
    top: Number(clipMatch[2]),
    right: Number(clipMatch[1]) + Number(clipMatch[3]),
    bottom: Number(clipMatch[2]) + Number(clipMatch[4]),
  };

  const labelTags = [...svg.matchAll(/<rect class="aviation-meteogram-cloud-layer-label-tag[^"]*" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>/g)].map((match) => {
    const groupStart = svg.lastIndexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text', match.index);
    const groupTag = svg.slice(groupStart, svg.indexOf(">", groupStart) + 1);
    return {
      timeX: numberAttribute(groupTag, "data-cloud-time-x"),
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[1]) + Number(match[3]),
      bottom: Number(match[2]) + Number(match[4]),
    };
  });
  assert.ok(labelTags.length, "the rendered cloud layer labels expose their actual collision geometry");

  const lightningPaths = [...svg.matchAll(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/g)].map((match) => {
    const groupStart = svg.lastIndexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-artwork', match.index);
    const groupTag = svg.slice(groupStart, svg.indexOf(">", groupStart) + 1);
    const phenomenonStart = svg.lastIndexOf('<g class="aviation-meteogram-atmosphere-phenomenon', match.index);
    const phenomenonTag = svg.slice(phenomenonStart, svg.indexOf(">", phenomenonStart) + 1);
    const artX = numberAttribute(groupTag, "data-cloud-art-x");
    const translate = match[0].match(/\btransform="translate\((-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\)"/);
    const translateX = Number(translate?.[1] || 0);
    const translateY = Number(translate?.[2] || 0);
    const startY = numberAttribute(match[0], "data-lightning-start-y") + translateY;
    const tipY = numberAttribute(match[0], "data-lightning-tip-y") + translateY;
    const localLeft = numberAttribute(match[0], "data-lightning-left");
    const localRight = numberAttribute(match[0], "data-lightning-right");
    return {
      timeX: numberAttribute(groupTag, "data-cloud-time-x"),
      phenomenonTag,
      anchor: match[0].match(/data-lightning-anchor="([^"]+)"/)?.[1],
      placement: match[0].match(/data-lightning-placement="([^"]+)"/)?.[1],
      offsetX: numberAttribute(match[0], "data-lightning-offset-x"),
      baseFt: numberAttribute(match[0], "data-lightning-base-ft"),
      baseY: numberAttribute(match[0], "data-lightning-base-y") + translateY,
      pathHeight: numberAttribute(match[0], "data-lightning-path-height"),
      left: artX + translateX + localLeft,
      right: artX + translateX + localRight,
      top: startY,
      bottom: tipY,
    };
  });

  assert.equal(lightningPaths.length, 3, "the half-open 21-24Z PROB30 interval renders exactly three hourly bolts");
  const expectedTimes = [
    "2026-09-10T21:00:00.000Z",
    "2026-09-10T22:00:00.000Z",
    "2026-09-10T23:00:00.000Z",
  ];
  const renderedTimes = lightningPaths.map(({ timeX }) => {
    const index = dimensions.xPositions.findIndex((x) => Math.abs(x - timeX) < 0.11);
    assert.notEqual(index, -1, `lightning x=${timeX} belongs to an exact timeline bucket`);
    return model.timeline[index].validZ || model.timeline[index].observedZ;
  });
  assert.deepEqual(renderedTimes, expectedTimes);

  const expectedBaseY = meteogramCloudBaseY(5000, 25000);
  for (const [index, bolt] of lightningPaths.entries()) {
    const label = `${expectedTimes[index].slice(11, 13)}Z bolt`;
    assert.match(bolt.phenomenonTag, /aviation-meteogram-atmosphere-conditional/);
    assert.match(bolt.phenomenonTag, /data-weather-code="-TSRA"/);
    assert.match(bolt.phenomenonTag, /data-weather-provenance="P30"/);
    assert.equal(bolt.anchor, "reported-convective-base", `${label} remains tied to the reported CB layer`);
    assert.equal(bolt.placement, "emanates-from-base", `${label} begins at the reported convective base while horizontal packing clears its label`);
    assert.equal(bolt.baseFt, 5000);
    assert.ok(Math.abs(bolt.baseY - expectedBaseY) < 0.11);
    assert.ok(Math.abs(bolt.top - bolt.baseY) < 0.11, `${label} starts exactly on the reported CB base`);
    assert.ok(Number.isFinite(bolt.offsetX), `${label} exposes its collision-aware horizontal placement`);
    assert.equal(bolt.pathHeight, 13, `${label} uses the restrained thunder badge that fits above the CIG summary`);

    const sameColumnTags = labelTags.filter((tag) => Math.abs(tag.timeX - bolt.timeX) < 0.11);
    assert.ok(sameColumnTags.length, `${label} exercises the opaque P30 BKN050CB label from production`);
    for (const tag of sameColumnTags) {
      assert.ok(
        bolt.bottom <= tag.top || bolt.top >= tag.bottom || bolt.right <= tag.left || bolt.left >= tag.right,
        `${label} recognizable body ${JSON.stringify(bolt)} must not intersect same-column cloud-label tag ${JSON.stringify(tag)}`,
      );
    }
    assert.ok(bolt.left >= cloudClip.left && bolt.right <= cloudClip.right, `${label} remains horizontally inside the artwork clip`);
    assert.ok(bolt.top >= cloudClip.top && bolt.bottom <= cloudClip.bottom, `${label} remains vertically inside the artwork clip`);
  }

  assert.doesNotMatch(
    meteogramCss,
    /\.aviation-meteogram-atmosphere-conditional\s*\{[^}]*\bopacity\s*:\s*(?:0?\.)?[0-9]+/,
    "conditional probability must not reduce opacity on the parent that contains lightning",
  );
  assert.match(
    meteogramCss,
    /\.aviation-meteogram-atmosphere-conditional\s*>?\s*:not\(\.aviation-meteogram-atmosphere-lightning\)\s*\{[^}]*\bopacity\s*:\s*(?:0?\.)[0-9]+/,
    "non-lightning conditional weather artwork retains a reduced-opacity treatment",
  );
});

test("low-base convective and reported-cloud fallback bolts remain measurable, connected, and truthful at 10,000- and 25,000-foot scales", () => {
  const layer = (raw) => {
    const match = raw.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    assert.ok(match, `valid deterministic cloud token ${raw}`);
    return { cover: match[1], heightFt: Number(match[2]) * 100, convective: match[3] || "", raw };
  };
  const point = (raw, weatherCodes, observedZ) => {
    const cloudLayer = layer(raw);
    return manualMeteogramPoint({
      observedZ,
      raw: `METAR KMEM TEST ${weatherCodes.join(" ")} ${raw}`,
      clouds: {
        layers: [cloudLayer],
        clear: false,
        cavok: false,
        ceilingFt: ["BKN", "OVC", "VV"].includes(cloudLayer.cover) ? cloudLayer.heightFt : null,
        display: raw,
      },
      weatherCodes,
    });
  };
  const numberAttribute = (markup, name) => {
    const match = markup.match(new RegExp(`${name}="(-?[\\d.]+)"`));
    return match ? Number(match[1]) : null;
  };
  const render = ({ raw, code, force25k = false, viewportWidth }) => {
    const timeline = [point(raw, [code], "2026-09-01T00:00:00.000Z")];
    if (force25k) timeline.push(point("FEW250", [], "2026-09-01T01:00:00.000Z"));
    const model = manualMeteogramModel(timeline);
    const settings = { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" };
    const labelLayout = meteogramRowLabelLayout(settings, viewportWidth, { hasForecast: false });
    const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth, labelLayout });
    const maximumFt = meteogramCloudScaleDefinition(timeline).maximumFt;
    const pathMatch = svg.match(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/);
    assert.ok(pathMatch, `${raw} ${code} renders one explicit-thunder lightning bolt`);
    assert.equal((svg.match(/data-weather-lightning="reported-thunder"/g) || []).length, 1);
    const path = pathMatch[0];
    const artworkGroupStart = svg.lastIndexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-artwork', pathMatch.index);
    const artworkGroup = svg.slice(artworkGroupStart, svg.indexOf(">", artworkGroupStart) + 1);
    const timeX = numberAttribute(artworkGroup, "data-cloud-time-x");
    const artX = numberAttribute(artworkGroup, "data-cloud-art-x");
    const bolt = {
      anchor: path.match(/data-lightning-anchor="([^"]+)"/)?.[1],
      placement: path.match(/data-lightning-placement="([^"]+)"/)?.[1],
      baseFt: numberAttribute(path, "data-lightning-base-ft"),
      baseY: numberAttribute(path, "data-lightning-base-y"),
      left: artX + numberAttribute(path, "data-lightning-left"),
      right: artX + numberAttribute(path, "data-lightning-right"),
      top: numberAttribute(path, "data-lightning-start-y"),
      bottom: numberAttribute(path, "data-lightning-tip-y"),
      height: numberAttribute(path, "data-lightning-path-height"),
    };
    const tags = [...svg.matchAll(/<rect class="aviation-meteogram-cloud-layer-label-tag[^"]*" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>/g)].flatMap((match) => {
      const textGroupStart = svg.lastIndexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text', match.index);
      const textGroup = svg.slice(textGroupStart, svg.indexOf(">", textGroupStart) + 1);
      if (Math.abs(numberAttribute(textGroup, "data-cloud-time-x") - timeX) > 0.11) return [];
      return [{
        left: Number(match[1]),
        top: Number(match[2]),
        right: Number(match[1]) + Number(match[3]),
        bottom: Number(match[2]) + Number(match[4]),
      }];
    });
    const clipMatch = svg.match(/<clipPath id="aviationMeteogramCloudArtworkClip"><rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"\/><\/clipPath>/);
    assert.ok(clipMatch);
    const clip = {
      left: Number(clipMatch[1]),
      top: Number(clipMatch[2]),
      right: Number(clipMatch[1]) + Number(clipMatch[3]),
      bottom: Number(clipMatch[2]) + Number(clipMatch[4]),
    };
    return { svg, maximumFt, path, bolt, tags, clip };
  };
  const doesNotIntersect = (left, right) => (
    left.bottom <= right.top || left.top >= right.bottom || left.right <= right.left || left.left >= right.right
  );
  const assertVisible = (scenario, label) => {
    assert.equal(scenario.bolt.height, 13, `${label} retains a recognizable restrained thunder badge`);
    assert.equal(scenario.bolt.bottom - scenario.bolt.top, scenario.bolt.height, `${label} exposes truthful vertical geometry`);
    assert.ok(scenario.bolt.left < scenario.bolt.right && scenario.bolt.top < scenario.bolt.bottom, `${label} has nonzero geometry`);
    assert.ok(scenario.bolt.left >= scenario.clip.left && scenario.bolt.right <= scenario.clip.right, `${label} remains inside the cloud artwork clip horizontally`);
    assert.ok(scenario.bolt.top >= scenario.clip.top && scenario.bolt.bottom <= scenario.clip.bottom, `${label} remains inside the cloud artwork clip vertically`);
    assert.ok(scenario.tags.length, `${label} includes a same-column opaque cloud label collision obstacle`);
    for (const tag of scenario.tags) assert.ok(doesNotIntersect(scenario.bolt, tag), `${label} bolt must not be masked by label ${JSON.stringify(tag)}`);
  };

  for (const fixture of [
    { force25k: false, viewportWidth: 390, expectedMaximumFt: 10000 },
    { force25k: true, viewportWidth: 1000, expectedMaximumFt: 25000 },
  ]) {
    const lowCb = render({ raw: "BKN005CB", code: "TSRA", ...fixture });
    const label = `BKN005CB TSRA on ${fixture.expectedMaximumFt / 1000}K scale at ${fixture.viewportWidth}px`;
    assert.equal(lowCb.maximumFt, fixture.expectedMaximumFt);
    assert.equal(lowCb.bolt.anchor, "reported-convective-base");
    assert.equal(lowCb.bolt.baseFt, 500);
    assert.ok(Math.abs(lowCb.bolt.baseY - meteogramCloudBaseY(500, fixture.expectedMaximumFt)) < 0.11);
    assert.ok(Math.abs(lowCb.bolt.top - lowCb.bolt.baseY) < 0.11, `${label} visibly starts on the reported CB base`);
    assertVisible(lowCb, label);

    for (const code of ["TS", "VCTS"]) {
      const generic = render({ raw: "BKN030", code, ...fixture });
      const genericLabel = `BKN030 ${code} on ${fixture.expectedMaximumFt / 1000}K scale at ${fixture.viewportWidth}px`;
      assert.equal(generic.maximumFt, fixture.expectedMaximumFt);
      assert.equal(generic.bolt.anchor, "reported-cloud-base", `${genericLabel} uses the lowest reported layer when no CB/TCU base exists`);
      assert.equal(generic.bolt.baseFt, 3000);
      assert.ok(Math.abs(generic.bolt.baseY - meteogramCloudBaseY(3000, fixture.expectedMaximumFt)) < 0.11);
      assert.ok(Math.abs(generic.bolt.top - generic.bolt.baseY) < 0.11);
      if (code === "VCTS") assert.match(generic.svg, /aviation-meteogram-atmosphere-vicinity/);
      assertVisible(generic, genericLabel);
    }
  }

  for (const maximumFixture of [
    [manualMeteogramPoint({
      clouds: { layers: [layer("BKN005CB")], clear: false, cavok: false, ceilingFt: 500, display: "BKN005CB" },
      weatherCodes: [],
    })],
    [
      manualMeteogramPoint({
        clouds: { layers: [layer("BKN005CB")], clear: false, cavok: false, ceilingFt: 500, display: "BKN005CB" },
        weatherCodes: [],
      }),
      point("FEW250", [], "2026-09-01T01:00:00.000Z"),
    ],
  ]) {
    assert.doesNotMatch(
      buildMeteogramSvgMarkup(manualMeteogramModel(maximumFixture), { timeMode: "Z" }),
      /data-weather-lightning=/,
      "CB morphology without an explicit TS/VCTS/TSRA code never fabricates lightning",
    );
  }
});

test("mixed, vicinity, and conditional weather retain independent intensity and provenance", () => {
  const weatherPoint = ({ weatherCodes, conditional = [], raw = "BKN030", kind = "OBSERVED" }) => {
    const match = raw.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    const layer = { cover: match[1], heightFt: Number(match[2]) * 100, convective: match[3] || "", raw };
    return manualMeteogramPoint({
      kind,
      reportType: kind === "FORECAST" ? "TAF" : "METAR",
      observedZ: kind === "FORECAST" ? null : "2026-09-01T00:00:00.000Z",
      validZ: kind === "FORECAST" ? "2026-09-01T01:00:00.000Z" : null,
      tafIssuanceZ: kind === "FORECAST" ? "2026-08-31T22:00:00.000Z" : null,
      clouds: { layers: [layer], clear: false, cavok: false, ceilingFt: ["BKN", "OVC", "VV"].includes(layer.cover) ? layer.heightFt : null, display: raw },
      weatherCodes,
      conditional,
    });
  };
  const phenomenonTag = (svg, code) => {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return svg.match(new RegExp(`<g class="([^"]*aviation-meteogram-atmosphere-phenomenon[^"]*)" data-weather-code="${escaped}"[^>]*>`));
  };

  const mixedPoint = weatherPoint({ weatherCodes: ["-RA", "BR"] });
  const mixedScene = meteogramWeatherSceneDefinition(mixedPoint);
  assert.equal(mixedScene.phenomena.find(({ code }) => code === "-RA").density, 1, "mist cannot promote light rain to moderate density");
  assert.equal(mixedScene.phenomena.find(({ code }) => code === "BR").density, 2);
  const mixedSvg = buildMeteogramSvgMarkup(manualMeteogramModel([mixedPoint]), { timeMode: "Z" });
  assert.match(mixedSvg, /data-weather-code="-RA" data-weather-density="1" data-weather-provenance="PREVAILING"/);
  assert.match(mixedSvg, /data-weather-rain-density="1"/);

  const vicinityPoint = weatherPoint({ weatherCodes: ["RA", "VCTS"] });
  const vicinitySvg = buildMeteogramSvgMarkup(manualMeteogramModel([vicinityPoint]), { timeMode: "Z" });
  const rainTag = phenomenonTag(vicinitySvg, "RA");
  const thunderTag = phenomenonTag(vicinitySvg, "VCTS");
  assert.ok(rainTag && !rainTag[1].includes("aviation-meteogram-atmosphere-vicinity"), "station rain remains centered");
  assert.ok(thunderTag && thunderTag[1].includes("aviation-meteogram-atmosphere-vicinity"), "only vicinity thunder is displaced");

  const multiThunderPoint = weatherPoint({
    kind: "FORECAST",
    raw: "BKN030CB",
    weatherCodes: ["TS", "VCTS"],
    conditional: [{
      type: "PROB30",
      conditions: {
        clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
        weatherCodes: ["+TSRA"],
        visibilitySm: 2,
        visibilityDisplay: "2 SM",
      },
    }],
  });
  const multiThunderSvg = buildMeteogramSvgMarkup(manualMeteogramModel([multiThunderPoint]), { timeMode: "Z" });
  assert.equal(
    (multiThunderSvg.match(/data-weather-lightning="reported-thunder"/g) || []).length,
    1,
    "multiple prevailing and conditional thunder codes still produce only one restrained lightning marker in the bucket",
  );
  assert.match(multiThunderSvg, /data-weather-code="TS"/);
  assert.match(multiThunderSvg, /data-weather-code="VCTS"/);
  assert.match(multiThunderSvg, /data-weather-code="\+TSRA"/);

  const conditionalPoint = weatherPoint({
    kind: "FORECAST",
    weatherCodes: ["-RA"],
    conditional: [{
      type: "TEMPORARY",
      conditions: {
        clouds: {
          layers: [{ cover: "BKN", heightFt: 1000, raw: "BKN010" }],
          clear: false,
          cavok: false,
          ceilingFt: 1000,
          display: "BKN010",
        },
        weatherCodes: ["+SN"],
        visibilitySm: 2,
        visibilityDisplay: "2 SM",
      },
    }],
  });
  const conditionalScene = meteogramWeatherSceneDefinition(conditionalPoint);
  const prevailingRain = conditionalScene.phenomena.find(({ code, conditional }) => code === "-RA" && !conditional);
  const tempoSnow = conditionalScene.phenomena.find(({ code, conditional }) => code === "+SN" && conditional);
  assert.deepEqual({ density: prevailingRain.density, provenance: prevailingRain.provenance }, { density: 1, provenance: "PREVAILING" });
  assert.deepEqual({ density: tempoSnow.density, provenance: tempoSnow.provenance }, { density: 3, provenance: "TEMPO" });
  const conditionalSvg = buildMeteogramSvgMarkup(manualMeteogramModel([conditionalPoint]), { timeMode: "Z" });
  assert.match(conditionalSvg, /data-weather-code="-RA" data-weather-density="1" data-weather-provenance="PREVAILING"/);
  assert.match(conditionalSvg, /aviation-meteogram-atmosphere-conditional" data-weather-code="\+SN" data-weather-density="3" data-weather-provenance="TEMPO"/);
  assert.match(conditionalSvg, /PREVAILING: LIGHT RAIN; TEMPO: HEAVY SNOW/);
  assert.match(conditionalSvg, /TMP&#10;BKN010 — BASE 1,000 FT AGL · TOP NOT REPORTED&#10;CEILING: CIG 1,000 FT&#10;WEATHER: \+SN&#10;VIS: 2 SM/, "tap detail preserves the conditional ceiling, weather, visibility, and provenance rather than labeling them prevailing");

  for (const [code, classes] of [
    ["FZDZ", ["aviation-meteogram-atmosphere-drizzle", "aviation-meteogram-atmosphere-freezing"]],
    ["SHSN", ["aviation-meteogram-atmosphere-showers", "aviation-meteogram-atmosphere-snow"]],
    ["VCTS", ["aviation-meteogram-atmosphere-vicinity", "data-weather-lightning=\"reported-thunder\""]],
    ["+TSRA", ["data-weather-rain-density=\"3\"", "data-weather-lightning=\"reported-thunder\""]],
    ["-RADZ", ["aviation-meteogram-atmosphere-rain", "aviation-meteogram-atmosphere-drizzle", "data-weather-rain-density=\"1\"", "data-weather-drizzle-density=\"1\""]],
    ["PLGS", ["aviation-meteogram-atmosphere-ice-pellets", "aviation-meteogram-atmosphere-small-hail"]],
  ]) {
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel([weatherPoint({ weatherCodes: [code], raw: code.includes("TS") ? "BKN030CB" : "OVC008" })]), { timeMode: "Z" });
    for (const expected of classes) assert.ok(svg.includes(expected), `${code} includes ${expected}`);
  }
  const blowingSnowSvg = buildMeteogramSvgMarkup(manualMeteogramModel([weatherPoint({ weatherCodes: ["BLSN"], raw: "OVC008" })]), { timeMode: "Z" });
  assert.doesNotMatch(blowingSnowSvg, /aviation-meteogram-atmosphere-snow/, "blowing snow is not fabricated as ordinary falling flakes");
  assert.match(blowingSnowSvg, /BLOWING SNOW/);
});

test("precipitation and obscuration occupy a protected lower-atmosphere zone beneath low decks", () => {
  const point = (raw, weatherCode) => {
    const match = raw.match(/^(OVC|VV)(\d{3})$/);
    const layer = { cover: match[1], heightFt: Number(match[2]) * 100, convective: "", raw };
    return manualMeteogramPoint({
      clouds: { layers: [layer], clear: false, cavok: false, ceilingFt: layer.heightFt, display: raw },
      weatherCodes: [weatherCode],
    });
  };
  for (const [raw, code] of [["OVC008", "+SN"], ["OVC005", "FZRA"], ["VV002", "FG"]]) {
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel([point(raw, code)]), { timeMode: "Z" });
    const top = Number(svg.match(/data-weather-zone-top="([\d.]+)"/)?.[1]);
    const bottom = Number(svg.match(/data-weather-zone-bottom="([\d.]+)"/)?.[1]);
    const base = meteogramCloudBaseY(Number(raw.slice(3)) * 100, 10000);
    assert.ok(Number.isFinite(top) && Number.isFinite(bottom));
    assert.ok(top > base, `${raw} ${code} decorative weather begins below the low reported base`);
    assert.ok(bottom > top, "the lower-atmosphere zone has positive height");
    assert.match(svg, /no precipitation amount or producing cloud layer is inferred/i);
  }
  for (const [code, density] of [["-SN", 1], ["SN", 2], ["+SN", 3]]) {
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel([point("OVC008", code)]), { timeMode: "Z" });
    assert.match(svg, new RegExp(`data-weather-snow-density="${density}"`));
  }
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
  assert.match(svg, /data-cloud-token="VV\/\/\/" data-cloud-base="UNKNOWN"/, "an unknown-base layer is labeled in a truthful non-altitude lane");
  assert.match(svg, /data-cloud-label="VV\/\/\/" data-cloud-base="UNKNOWN"/, "the unknown-base token remains visible without an invented Y anchor");
  assert.match(svg, /VV\/\/\/ — BASE UNKNOWN/, "tap/focus detail retains the exact unknown-base token");
  assert.doesNotMatch(svg, /VV000/, "a missing cloud base can never be coerced to zero feet");
  assert.equal((svg.match(/data-cloud-token="BKN080"[^>]*aviation-meteogram-cloud-layer-ceiling|aviation-meteogram-cloud-layer-ceiling[^>]*data-cloud-token="BKN080"/g) || []).length, 2, "BKN080 remains the known lowest ceiling in art and operational text");
  assert.match(svg, /data-base-ft="2000"/);
  assert.match(svg, /data-base-ft="10000"/);
  assert.match(svg, /data-cloud-label="BKN080"/);
  assert.match(svg, />CIG 8,000 FT</);
  for (const layer of clouds.layers.filter(({ heightFt }) => Number.isFinite(heightFt))) {
    const expectedY = meteogramCloudBaseY(layer.heightFt, 10000).toFixed(1);
    const token = layer.raw;
    assert.match(svg, new RegExp(`data-cloud-token="${token}" data-base-ft="${layer.heightFt}" data-base-y="${expectedY}"`), `${token} group carries its exact base geometry`);
    assert.match(svg, new RegExp(`data-cloud-art-base-y="${expectedY}"`), `${token} artwork origin is a reported-base origin`);
    assert.match(svg, new RegExp(`data-cloud-base-marker="${token}" data-marker-y="${expectedY}"[^>]*y1="${expectedY}"[^>]*y2="${expectedY}"`), `${token} marker lies exactly on baseY`);
    assert.match(svg, new RegExp(`data-cloud-label="${token}" data-label-anchor-y="${expectedY}"`), `${token} label anchor lies exactly on baseY`);
  }
  const labelWidth = Number(svg.match(/data-label-width="([\d.]+)"/)?.[1]);
  const axisBoundary = labelWidth + METEOGRAM_CLOUD_AXIS_WIDTH;
  assert.match(svg, new RegExp(`id="aviationMeteogramCloudArtworkClip"><rect x="${axisBoundary}"`));
  assert.match(svg, new RegExp(`id="aviationMeteogramCloudTextClip"><rect x="${axisBoundary}"`));
  assert.match(svg, new RegExp(`class="aviation-meteogram-cloud-axis"[\\s\\S]*data-axis-start="${labelWidth}"[\\s\\S]*data-axis-end="${axisBoundary}"`));
  assert.ok(svg.indexOf("aviation-meteogram-cloud-artwork-row") < svg.lastIndexOf("class=\"aviation-meteogram-cloud-axis\""), "the protected altitude axis paints above decorative cloud artwork");
  const firstCloudTimeX = Number(svg.match(/data-cloud-time-x="([\d.]+)"/)?.[1]);
  const firstCloudGeometry = svg.match(/data-cloud-time-x="([\d.]+)" data-cloud-art-x="([\d.]+)" data-cloud-art-offset-x="([\d.-]+)"/);
  const firstCloudArtX = Number(firstCloudGeometry?.[2]);
  const firstCloudArtOffsetX = Number(firstCloudGeometry?.[3]);
  assert.match(meteogramJs, /const leftArtworkRoom = Math\.max\(0, \(x - cloudAxisBoundary\) \* 2\)/, "edge artwork measures available room against the protected altitude gutter");
  assert.match(meteogramJs, /const rightArtworkRoom = Math\.max\(0, \(width - x\) \* 2\)/, "edge artwork also measures the right data boundary");
  assert.match(meteogramJs, /const bucketArtworkRoom = Math\.max\(0, Math\.min\(\(x - labelCellLeft\) \* 2, \(labelCellRight - x\) \* 2\)\)/, "artwork measures the smaller real half-cell around an exact timestamp");
  assert.match(meteogramJs, /const availableWidth = Math\.max\(0, Math\.min\(nominalWidth, leftArtworkRoom, rightArtworkRoom, bucketArtworkRoom\)\)/, "edge artwork shrinks locally instead of moving its time coordinate");
  assert.match(meteogramJs, /const artX = x;/, "decorative cloud art remains centered on the exact proportional time coordinate");
  assert.match(meteogramJs, /const markerHalfWidth = labelVisible[\s\S]*Math\.max\(7, Math\.min\(13, availableWidth \* 0\.16\)\)/, "the exact-base marker remains a short operational reference instead of becoming a false deck");
  assert.ok(Number.isFinite(firstCloudTimeX), "the exact observation time anchor remains explicit and unchanged");
  assert.equal(firstCloudArtX, firstCloudTimeX, "the first decorative cloud remains on its exact data time");
  assert.equal(firstCloudArtOffsetX, 0, "edge handling never introduces a visible time offset");
  assert.match(svg, /cloud top not reported/i);
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

  const ceilingRules = [...meteogramCss.matchAll(/\.aviation-meteogram-cloud-layer-ceiling[^{}]*\{[^}]*\}/g)].map((match) => match[0]).join("\n");
  assert.doesNotMatch(ceilingRules, /#ffbf32|#ffd36b|yellow|amber/i, "BKN/OVC/VV ceiling artwork has no warning-color override");
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-body\{[\s\S]*stroke:rgba\(215,237,240,\.42\)/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-base-line,[\s\S]*\.aviation-meteogram-cloud-label-leader\{stroke:#92e6ed/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-layer-label-tag\{[\s\S]*fill:rgba\(3,9,10,\.94\)/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-layer-label-ceiling\{fill:#9ce9ee/);
  assert.match(meteogramCss, /\.aviation-meteogram-ceiling-value\{fill:#72e7ef/);
  for (const [cover, heightFt] of [["BKN", 7000], ["OVC", 8500], ["VV", 1200]]) {
    const raw = `${cover}${String(heightFt / 100).padStart(3, "0")}`;
    const ceilingSvg = buildMeteogramSvgMarkup(manualMeteogramModel([manualMeteogramPoint({
      clouds: {
        layers: [{ cover, heightFt, convective: "", raw }],
        clear: false, cavok: false, ceilingFt: heightFt, display: raw,
      },
    })]), { timeMode: "Z" });
    assert.match(ceilingSvg, new RegExp(`cloud-layer-${cover} aviation-meteogram-cloud-layer-ceiling`));
    assert.match(ceilingSvg, new RegExp(`>CIG ${heightFt.toLocaleString("en-US")} FT<`));
    assert.doesNotMatch(ceilingSvg, /#ffbf32|#ffd36b|yellow|amber/i, `${cover} ceiling artwork carries no warning color`);
  }

  const highCloudModel = manualMeteogramModel([manualMeteogramPoint({
    clouds: {
      layers: [{ cover: "BKN", heightFt: 30000, convective: "", raw: "BKN300" }],
      clear: false, cavok: false, ceilingFt: 30000, display: "BKN300",
    },
  })]);
  const highCloudScale = meteogramCloudScaleDefinition(highCloudModel.timeline);
  assert.equal(highCloudScale.maximumFt, 30000);
  assert.ok(highCloudScale.ticks.includes(30000));
  const highCloudSvg = buildMeteogramSvgMarkup(highCloudModel, { timeMode: "Z" });
  assert.match(highCloudSvg, />30,000 FT<\/text>/, "the protected axis remains explicit at a 30,000 FT domain");
  assert.match(highCloudSvg, />CIG 30,000 FT<\/text>/);

  for (const token of ["CLR", "SKC", "NSC", "NCD", "CAVOK"]) {
    const cloudState = {
      layers: [],
      clear: token !== "CAVOK",
      cavok: token === "CAVOK",
      ceilingFt: null,
      display: token,
    };
    const clearSvg = buildMeteogramSvgMarkup(manualMeteogramModel([
      manualMeteogramPoint({ clouds: cloudState }),
    ]), { timeMode: "Z" });
    assert.doesNotMatch(clearSvg, /data-cloud-form=|aviation-meteogram-open-sky-disc|aviation-meteogram-open-sky-rays|aviation-meteogram-cavok-ring|aviation-meteogram-cavok-horizon/, `${token} creates no altitude-positioned cloud artwork`);
    assert.match(clearSvg, new RegExp(`data-sky-status="${token}"`), `${token} remains exact in accessible cloud metadata`);
    if (token === "NSC") assert.match(clearSvg, />NSC · NO SIG CLOUD</);
    else if (token === "NCD") assert.match(clearSvg, />NCD · NO CLOUD DETECTED</);
    else if (token === "CAVOK") assert.match(clearSvg, />CAVOK · NO CIG &lt;5K</);
    else assert.match(clearSvg, />NO CIG</);
  }
  const table = buildMeteogramAccessibleTableMarkup(manualMeteogramModel([
    manualMeteogramPoint({ clouds }),
  ]), { timeMode: "Z" });
  for (const token of ["FEW020", "SCT045", "BKN080", "OVC100", "VV///"]) assert.match(table, new RegExp(token.replace("/", "\\/")));
});

test("close cloud layers use exact-base horizontal callouts without drifting or hiding layer tokens", () => {
  const layers = [
    { cover: "FEW", heightFt: 2200, raw: "FEW022", ceilingFt: 2500 },
    { cover: "SCT", heightFt: 2400, raw: "SCT024", ceilingFt: 2500 },
    { cover: "BKN", heightFt: 2500, raw: "BKN025", ceilingFt: 2500 },
    { cover: "OVC", heightFt: 8000, raw: "OVC080", ceilingFt: 2500 },
  ];
  const layout = meteogramCloudLabelLayout(layers, 10000, {
    minimumGapPx: 18,
    columnX: 300,
    plotLeft: 100,
    plotRight: 800,
  });
  assert.equal(layout[2].visible, true, "the actual ceiling label wins a tight collision");
  assert.equal(layout[2].isCeiling, true);
  assert.ok(layout.every((entry) => entry.visible), "every exact layer keeps an operational token");
  for (const [index, layer] of layers.entries()) {
    const exactBaseY = meteogramCloudBaseY(layer.heightFt, 10000);
    assert.equal(layout[index].baseY, exactBaseY);
    assert.equal(layout[index].y, exactBaseY);
    assert.equal(layout[index].labelY, exactBaseY);
    assert.equal(layout[index].leaderTargetY, exactBaseY);
  }
  assert.equal(new Set(layout.slice(0, 3).map(({ labelX }) => labelX)).size, 3, "close bases use separate horizontal lanes");
  assert.ok(layout.slice(0, 3).every(({ lane }) => Number.isFinite(lane)), "each close layer has a deterministic callout lane assignment");

  for (const plotRight of [320, 390]) {
    const narrowPlotLeft = plotRight === 320 ? 226 : 260;
    const narrowLayout = meteogramCloudLabelLayout(layers.slice(0, 3), 10000, {
      minimumGapPx: 18,
      columnX: (narrowPlotLeft + plotRight) / 2,
      plotLeft: narrowPlotLeft,
      plotRight,
    });
    const safeLeft = narrowPlotLeft + 4;
    const safeRight = plotRight - 4;
    assert.ok(narrowLayout.every((entry) => entry.visible), `${plotRight}px keeps the three explicitly requested callouts visible`);
    assert.equal(narrowLayout[2].stacked, false, `${plotRight}px keeps the ceiling token on its exact base when space permits`);
    for (const entry of narrowLayout) {
      assert.ok(entry.labelX - entry.tagWidth / 2 >= safeLeft - 0.01, `${plotRight}px tag stays right of the protected axis`);
      assert.ok(entry.labelX + entry.tagWidth / 2 <= safeRight + 0.01, `${plotRight}px tag stays inside the SVG`);
      assert.equal(entry.leaderTargetY, entry.baseY, `${plotRight}px displaced label leader terminates at exact baseY`);
    }
  }

  const clouds = { layers: layers.map(({ ceilingFt: _ceilingFt, ...layer }) => layer), clear: false, cavok: false, ceilingFt: 2500, display: "FEW022 · SCT024 · BKN025 · OVC080" };
  const model = manualMeteogramModel([manualMeteogramPoint({ clouds })]);
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
  assert.equal((svg.match(/data-cloud-form=/g) || []).length, 4, "every exact layer remains rendered");
  for (const layer of layers) {
    const expectedY = meteogramCloudBaseY(layer.heightFt, 10000).toFixed(1);
    assert.match(svg, new RegExp(`data-cloud-base-marker="${layer.raw}" data-marker-y="${expectedY}"`));
    assert.match(svg, new RegExp(`data-cloud-label="${layer.raw}" data-label-anchor-y="${expectedY}"`));
  }
  assert.match(svg, />CIG 2,500 FT</);
  const narrowSvg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 320 });
  assert.ok((narrowSvg.match(/aviation-meteogram-cloud-label-leader/g) || []).length >= 2, "narrow stacked tokens visibly connect displaced tags to their bases");
  for (const layer of layers) {
    const exactBaseY = meteogramCloudBaseY(layer.heightFt, 10000).toFixed(1);
    const anchorMarkup = narrowSvg.match(new RegExp(`(<g class="[^"]*aviation-meteogram-cloud-anchor" data-cloud-token="${layer.raw}"[\\s\\S]*?</g>)`))?.[1] || "";
    assert.ok(anchorMarkup, `${layer.raw} narrow anchor exists`);
    const labelAnchorY = Number(anchorMarkup.match(/data-label-anchor-y="([\d.]+)"/)?.[1]);
    if (Math.abs(labelAnchorY - Number(exactBaseY)) > 1) {
      assert.match(anchorMarkup, new RegExp(`data-leader-target-y="${exactBaseY}"[^>]*y1="${exactBaseY}"`), `${layer.raw} displaced callout leader begins at exact baseY`);
    } else {
      assert.ok(Math.abs(labelAnchorY - Number(exactBaseY)) <= 1, `${layer.raw} undisplaced tag remains within one pixel of exact baseY`);
    }
  }
  assert.match(meteogramJs, /Math\.abs\(labelX - artX\) > 2 \|\| Math\.abs\(labelY - baseY\) > 1/, "a vertically displaced callout cannot lose its leader");
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  for (const token of ["FEW022", "SCT024", "BKN025", "OVC080"]) assert.match(table, new RegExp(token));

  const adjacentColumns = [
    manualMeteogramPoint({ clouds: { layers: [{ cover: "SCT", heightFt: 2500, raw: "SCT025" }], clear: false, cavok: false, ceilingFt: null, display: "SCT025" } }),
    manualMeteogramPoint({ clouds: { layers: [{ cover: "BKN", heightFt: 2500, raw: "BKN025" }], clear: false, cavok: false, ceilingFt: 2500, display: "BKN025" } }),
  ];
  assert.deepEqual(meteogramCloudColumnLabelMask(adjacentColumns, [200, 270]), [false, true], "the actual ceiling wins the non-base summary mask");
  const subHourlyColumns = [adjacentColumns[0], adjacentColumns[1], adjacentColumns[0]];
  assert.deepEqual(meteogramCloudColumnLabelMask(subHourlyColumns, [200, 240, 280]), [false, true, false], "sub-hourly CIG and unknown-base summaries remain collision-free");
  const adjacentSvg = buildMeteogramSvgMarkup(manualMeteogramModel(adjacentColumns), { timeMode: "Z" });
  for (const token of ["SCT025", "BKN025"]) {
    assert.match(adjacentSvg, new RegExp(`data-cloud-label="${token}"`), `${token} remains visible even when adjacent summaries are masked`);
    assert.match(adjacentSvg, new RegExp(`data-cloud-token="${token}"[^>]*data-cloud-label-visible="true"`), `${token} is never hidden by cross-column density`);
  }
  const repeatedConditional = Array.from({ length: 3 }, (_, index) => manualMeteogramPoint({
    observedZ: null,
    validZ: new Date(Date.parse("2026-09-01T00:00:00Z") + index * 60 * 60 * 1000).toISOString(),
    kind: "FORECAST",
    reportType: "TAF",
    source: "TAF",
    clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
    conditional: [{
      type: "TEMPORARY",
      conditions: {
        clouds: {
          layers: [{ cover: "BKN", heightFt: 2500, raw: "BKN025" }],
          clear: false,
          cavok: false,
          ceilingFt: 2500,
          display: "BKN025",
        },
      },
    }],
  }));
  const repeatedSvg = buildMeteogramSvgMarkup(manualMeteogramModel(repeatedConditional), { timeMode: "Z" }, { viewportWidth: 320 });
  const repeatedTags = [...repeatedSvg.matchAll(/<rect class="aviation-meteogram-cloud-layer-label-tag[^"]*" x="([\d.]+)"[^>]*width="([\d.]+)"/g)]
    .map((match) => ({ left: Number(match[1]), right: Number(match[1]) + Number(match[2]) }))
    .sort((left, right) => left.left - right.left);
  assert.equal(repeatedTags.length, 3, "every repeated conditional layer keeps its visible tag");
  assert.equal((repeatedSvg.match(/>BKN025<\/text>/g) || []).length, 3, "compact cells keep the exact conditional cloud token legible");
  assert.equal((repeatedSvg.match(/TMP(?:&#10;|\n)BKN025/g) || []).length >= 3, true, "tap/focus detail retains the conditional provenance omitted from compact chart tags");
  for (let index = 1; index < repeatedTags.length; index += 1) {
    assert.ok(repeatedTags[index - 1].right <= repeatedTags[index].left, "per-cell containment prevents adjacent conditional tags from overlapping");
  }
  assert.match(meteogramJs, /plotLeft: labelCellLeft,[\s\S]*plotRight: labelCellRight/, "known-layer callouts are solved inside their proportional timestamp cells");
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

test("dense thunderstorm SPECI buckets prioritize ceilings and convection without overlap or data loss", () => {
  const model = denseThunderstormMeteogramFixture();
  const settings = { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" };
  const viewportWidth = 390;
  const labelLayout = meteogramRowLabelLayout(settings, viewportWidth, { hasForecast: false, compact: true });
  const dimensions = meteogramDimensions(model.timeline, viewportWidth, { labelWidth: labelLayout.width });
  const cloudScale = meteogramCloudScaleDefinition(model.timeline);
  const targetIndexes = DENSE_THUNDERSTORM_TARGET_TIMES.map((timeZ) => (
    model.timeline.findIndex(({ observedZ }) => observedZ === timeZ)
  ));
  assert.ok(targetIndexes.every((index) => index > 0 && index < model.timeline.length - 1));

  const expectedVisible = [
    ["SCT030CB", "BKN050"],
    ["BKN030CB"],
    ["SCT055", "BKN085"],
  ];
  const expectedModes = ["COMPACT", "MINIMAL", "COMPACT"];
  const expectedCollapsed = [1, 3, 1];
  const doesNotIntersect = (left, right) => (
    left.bottom <= right.top || left.top >= right.bottom || left.right <= right.left || left.left >= right.right
  );
  const layoutBoxes = (layout) => [
    ...layout.layerLayout.flatMap((entry) => entry.visible ? [{
      left: entry.labelX - entry.tagWidth / 2,
      right: entry.labelX + entry.tagWidth / 2,
      top: entry.labelY - 7,
      bottom: entry.labelY + 7,
    }] : []),
    ...(layout.summary ? [layout.summary.box] : []),
  ];

  targetIndexes.forEach((timelineIndex, targetIndex) => {
    const point = model.timeline[timelineIndex];
    const bounds = dimensions.cellBounds[timelineIndex];
    const layers = point.clouds.layers.map((layer) => ({ ...layer, ceilingFt: point.clouds.ceilingFt }));
    const layout = meteogramCloudBucketLayout(layers, cloudScale.maximumFt, {
      columnX: dimensions.xPositions[timelineIndex],
      plotLeft: bounds.left,
      plotRight: bounds.right,
      indicatorLayerToken: meteogramLightningGeometry(point, cloudScale.maximumFt).anchorToken || "",
    });
    const visibleTokens = layout.visibleIndexes.map((index) => layers[index].raw);
    assert.equal(layout.mode, expectedModes[targetIndex], `${point.observedZ} selects its rendering mode from real proportional width`);
    assert.deepEqual(visibleTokens, expectedVisible[targetIndex], `${point.observedZ} retains ceiling/convection before secondary layers`);
    assert.equal(layout.collapsedCount, expectedCollapsed[targetIndex]);
    assert.equal(layout.summary?.text || null, expectedCollapsed[targetIndex] ? `+${expectedCollapsed[targetIndex]}` : null);
    const ceilingIndex = layers.findIndex((layer) => layer.raw === expectedVisible[targetIndex].find((token) => (
      ["BKN", "OVC", "VV"].includes(token.slice(0, 3)) && Number(token.slice(3, 6)) * 100 === point.clouds.ceilingFt
    )));
    assert.ok(layout.layerLayout[ceilingIndex]?.visible, `${point.observedZ} never collapses the actual ceiling`);
    if (layers.some(({ convective }) => convective === "CB" || convective === "TCU")) {
      const convectiveIndex = layers.findIndex(({ convective }) => convective === "CB" || convective === "TCU");
      assert.ok(layout.layerLayout[convectiveIndex]?.visible, `${point.observedZ} keeps explicit convective morphology identifiable`);
    }
    layout.layerLayout.forEach((entry, layerIndex) => {
      if (!entry.visible) return;
      assert.equal(entry.baseY, meteogramCloudBaseY(layers[layerIndex].heightFt, cloudScale.maximumFt));
      assert.equal(entry.leaderTargetY, entry.baseY, "any displaced label leader still terminates at the exact reported base");
    });
    const boxes = layoutBoxes(layout);
    boxes.forEach((box) => {
      assert.ok(box.left >= bounds.left + 3.9 && box.right <= bounds.right - 3.9, "labels and +N remain inside their timestamp cell");
      assert.ok(box.top >= 616 && box.bottom <= 836, "cloud text stays inside CLOUDS / CIG");
    });
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        assert.ok(doesNotIntersect(boxes[left], boxes[right]), "deterministically packed cloud labels do not overlap");
      }
    }
  });

  const firstDenseX = dimensions.xPositions[targetIndexes[0]];
  const secondDenseX = dimensions.xPositions[targetIndexes[1]];
  const thirdDenseX = dimensions.xPositions[targetIndexes[2]];
  assert.ok(Math.abs((secondDenseX - firstDenseX) / (thirdDenseX - secondDenseX) - 17 / 19) < 0.001, "2152Z, 2209Z, and 2228Z retain proportional rather than equal X spacing");

  const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth, labelLayout });
  const numberAttribute = (markup, name) => Number(markup.match(new RegExp(`${name}="(-?[\\d.]+)"`))?.[1]);
  const textOpenings = [...svg.matchAll(/<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text[^>]*>/g)];
  const textSegments = new Map(textOpenings.map((match, openingIndex) => {
    const index = numberAttribute(match[0], "data-cloud-bucket-index");
    const end = textOpenings[openingIndex + 1]?.index ?? svg.indexOf('<g class="aviation-meteogram-cloud-row aviation-meteogram-cloud-detail-row"');
    return [index, { tag: match[0], body: svg.slice(match.index, end) }];
  }));
  const rectFrom = (markup) => {
    const match = markup.match(/<rect[^>]*x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>/);
    return match ? {
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[1]) + Number(match[3]),
      bottom: Number(match[2]) + Number(match[4]),
    } : null;
  };
  const renderedBoxesByIndex = new Map();
  targetIndexes.forEach((timelineIndex, targetIndex) => {
    const segment = textSegments.get(timelineIndex);
    const bounds = dimensions.cellBounds[timelineIndex];
    assert.ok(segment, `rendered cloud text cell ${timelineIndex} exists`);
    assert.match(segment.tag, new RegExp(`data-cloud-density-mode="${expectedModes[targetIndex]}"`));
    assert.match(segment.tag, new RegExp(`data-cloud-time-z="${DENSE_THUNDERSTORM_TARGET_TIMES[targetIndex].replaceAll(".", "\\.")}"`));
    assert.match(segment.tag, /clip-path="url\(#aviationMeteogramCloudBucket\d+Clip\)"/);
    for (const token of expectedVisible[targetIndex]) assert.match(segment.body, new RegExp(`data-cloud-label="${token}"`));
    if (expectedCollapsed[targetIndex]) assert.match(segment.body, new RegExp(`data-cloud-summary="\\+${expectedCollapsed[targetIndex]}"`));
    else assert.doesNotMatch(segment.body, /data-cloud-summary=/);
    const point = model.timeline[timelineIndex];
    assert.match(segment.body, new RegExp(`data-ceiling-ft="${point.clouds.ceilingFt}"`));
    assert.match(segment.body, new RegExp(`data-ceiling-label="CIG ${point.clouds.ceilingFt.toLocaleString("en-US")} FT"`));
    assert.match(segment.body, new RegExp(`>${point.clouds.ceilingFt / 1000}K<`), "dense numeric ceiling repeats only its compact bottom value");
    assert.doesNotMatch(segment.body, />CIG (?:\d|\?)/, "dense cells do not repeat a boxed CIG prefix");

    const boxes = [];
    for (const match of segment.body.matchAll(/<rect class="aviation-meteogram-cloud-layer-label-tag[^>]*\/>/g)) boxes.push(rectFrom(match[0]));
    const summaryGroup = segment.body.match(/<g class="aviation-meteogram-cloud-layer-summary"[\s\S]*?<\/g>/)?.[0];
    const ceilingGroup = segment.body.match(/<g class="aviation-meteogram-ceiling-summary[^"]*"[\s\S]*?<\/g>/)?.[0];
    if (summaryGroup) boxes.push(rectFrom(summaryGroup));
    const ceilingRect = ceilingGroup ? rectFrom(ceilingGroup) : null;
    if (ceilingRect) boxes.push(ceilingRect);
    assert.match(ceilingGroup || "", /data-ceiling-mode="VALUE"/);
    assert.doesNotMatch(ceilingGroup || "", /<rect\b/, "dense ceiling values are unboxed");
    assert.ok(boxes.every(Boolean));
    boxes.forEach((box) => {
      assert.ok(box.left >= bounds.left - 0.11 && box.right <= bounds.right + 0.11, "rendered tags respect hard bucket boundaries");
      assert.ok(box.top >= 616 && box.bottom <= 836, "rendered tags respect the CLOUDS / CIG row boundary");
    });
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        assert.ok(doesNotIntersect(boxes[left], boxes[right]), "rendered labels, +N, and CIG tag do not collide");
      }
    }
    renderedBoxesByIndex.set(timelineIndex, boxes);
  });

  const lightningByBucket = new Map();
  for (const match of svg.matchAll(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/g)) {
    const bucketStart = svg.lastIndexOf('<g class="aviation-meteogram-cloud-bucket-art"', match.index);
    const bucketTag = svg.slice(bucketStart, svg.indexOf(">", bucketStart) + 1);
    const timelineIndex = numberAttribute(bucketTag, "data-cloud-bucket-index");
    const box = {
      left: dimensions.xPositions[timelineIndex] + numberAttribute(match[0], "data-lightning-left"),
      right: dimensions.xPositions[timelineIndex] + numberAttribute(match[0], "data-lightning-right"),
      top: numberAttribute(match[0], "data-lightning-start-y"),
      bottom: numberAttribute(match[0], "data-lightning-tip-y"),
    };
    const existing = lightningByBucket.get(timelineIndex) || [];
    existing.push(box);
    lightningByBucket.set(timelineIndex, existing);
  }
  assert.equal([...lightningByBucket.values()].flat().length, 3, "the three thunder-coded buckets render one restrained marker each");
  targetIndexes.forEach((timelineIndex) => {
    const bolts = lightningByBucket.get(timelineIndex) || [];
    assert.equal(bolts.length, 1, "a timestamp bucket never receives multiple lightning markers");
    const bounds = dimensions.cellBounds[timelineIndex];
    assert.ok(bolts[0].left >= bounds.left && bolts[0].right <= bounds.right, "the compact thunder marker stays inside its time cell");
    const point = model.timeline[timelineIndex];
    const convectiveBases = point.clouds.layers.filter(({ convective, heightFt }) => ["CB", "TCU"].includes(convective) && Number.isFinite(heightFt)).map(({ heightFt }) => heightFt);
    const reportedBases = point.clouds.layers.filter(({ heightFt }) => Number.isFinite(heightFt)).map(({ heightFt }) => heightFt);
    const expectedAnchorFt = Math.min(...(convectiveBases.length ? convectiveBases : reportedBases));
    const expectedAnchorY = meteogramCloudBaseY(expectedAnchorFt, cloudScale.maximumFt);
    assert.ok(Math.abs(bolts[0].top - expectedAnchorY) < 0.11, "the bolt visibly starts at the lowest applicable reported cloud base");
    assert.ok(bolts[0].top >= 616 && bolts[0].bottom <= 836, "the compact thunder marker stays inside CLOUDS / CIG");
    for (const obstacle of renderedBoxesByIndex.get(timelineIndex)) {
      assert.ok(doesNotIntersect(bolts[0], obstacle), "the thunder marker does not cover a layer, +N, or CIG label");
    }
  });

  const markerCount = model.timeline.reduce((count, point) => count + point.clouds.layers.length, 0);
  assert.equal((svg.match(/data-cloud-base-marker=/g) || []).length, markerCount, "every source layer retains its exact base marker even when its text/art collapses");
  targetIndexes.forEach((timelineIndex) => {
    const detailStart = svg.indexOf(`<g class="aviation-meteogram-cloud-detail-sample" data-cloud-detail-sample="${timelineIndex}"`);
    const detailTag = svg.slice(detailStart, svg.indexOf(">", detailStart) + 1);
    assert.ok(detailStart >= 0);
    for (const { raw } of model.timeline[timelineIndex].clouds.layers) assert.match(detailTag, new RegExp(raw), `${raw} remains available to hover, focus, and tap`);
    for (const code of model.timeline[timelineIndex].weatherCodes) assert.match(detailTag, new RegExp(code));
    assert.match(detailTag, new RegExp(`VIS: ${model.timeline[timelineIndex].visibilityDisplay}`));
    assert.match(detailTag, /tabindex="0" role="img"/);
  });
  const table = buildMeteogramAccessibleTableMarkup(model, settings);
  for (const point of model.timeline) for (const { raw } of point.clouds.layers) assert.match(table, new RegExp(raw));
  assert.match(meteogramJs, /scroller\.addEventListener\("pointerover"[\s\S]*showCloudTooltip/);
  assert.match(meteogramJs, /scroller\.addEventListener\("focusin"[\s\S]*showCloudTooltip/);
  assert.match(meteogramJs, /scroller\.addEventListener\("click"[\s\S]*showCloudTooltip\(cloudSample, \{ pin: true \}\)/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-detail-hit\{[\s\S]*pointer-events:all/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-tooltip\{[\s\S]*max-height:min\(320px,calc\(100dvh - 32px\)\)[\s\S]*overflow-y:auto/);
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-tooltip\.is-pinned\{[\s\S]*pointer-events:auto/, "a mobile tap pins a scrollable detail surface instead of silently clipping its tail");
  assert.match(meteogramJs, /tooltip\.classList\?\.toggle\("is-pinned", pin\)/);
  assert.match(meteogramJs, /id="aviationMeteogramCloudTooltip"[^>]*tabindex="0"/, "the pinned detail surface can receive keyboard focus for overflow scrolling");
  assert.match(meteogramJs, /\["Enter", " "\]\.includes\(event\.key\)[\s\S]*showCloudTooltip\(cloudSample, \{ pin: true \}\)/, "Enter or Space pins complete cloud detail");
  assert.match(meteogramJs, /\["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"\][\s\S]*cloudTooltip\.scrollTop/, "keyboard users can scroll a pinned overflowing detail surface without leaving its time bucket");
  assert.match(meteogramJs, /returnTarget\?\.focus\?\.\(\{ preventScroll: true \}\)/, "Escape restores focus to the originating time bucket");
  assert.match(meteogramCss, /\.aviation-meteogram-cloud-tooltip:focus-visible\{[\s\S]*outline:/);

  for (const responsiveWidth of [390, 414, 844, 1024, 1280, 1366, 1920]) {
    const responsiveLabels = meteogramRowLabelLayout(settings, responsiveWidth, { hasForecast: false, compact: responsiveWidth <= 768 });
    const responsiveDimensions = meteogramDimensions(model.timeline, responsiveWidth, { labelWidth: responsiveLabels.width });
    const responsiveSvg = buildMeteogramSvgMarkup(model, settings, { viewportWidth: responsiveWidth, labelLayout: responsiveLabels });
    assert.ok(responsiveDimensions.width >= responsiveWidth && Number.isFinite(responsiveDimensions.width));
    assert.equal((responsiveSvg.match(/data-cloud-base-marker=/g) || []).length, markerCount, `${responsiveWidth}px retains every exact source base`);
    assert.equal((responsiveSvg.match(/data-weather-lightning="reported-thunder"/g) || []).length, 3, `${responsiveWidth}px retains one marker for each thunder-coded bucket`);
    targetIndexes.forEach((timelineIndex) => {
      const artStart = responsiveSvg.indexOf(`<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="${timelineIndex}"`);
      const artEnd = responsiveSvg.indexOf(`<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="${timelineIndex + 1}"`, artStart);
      const artBucket = responsiveSvg.slice(artStart, artEnd < 0 ? responsiveSvg.length : artEnd);
      const bolt = artBucket.match(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/)?.[0] || "";
      assert.ok(bolt, `${responsiveWidth}px storm bucket ${timelineIndex} retains its compact thunder marker`);
      const point = model.timeline[timelineIndex];
      const convective = point.clouds.layers.filter(({ convective, heightFt }) => ["CB", "TCU"].includes(convective) && Number.isFinite(heightFt));
      const applicable = convective.length ? convective : point.clouds.layers.filter(({ heightFt }) => Number.isFinite(heightFt));
      const baseFt = Math.min(...applicable.map(({ heightFt }) => heightFt));
      const baseY = meteogramCloudBaseY(baseFt, cloudScale.maximumFt);
      assert.ok(Math.abs(numberAttribute(bolt, "data-lightning-start-y") - baseY) < 0.11, `${responsiveWidth}px bolt starts on its selected base`);
      assert.ok(Math.abs(numberAttribute(bolt, "data-lightning-base-y") - baseY) < 0.11);
      const bounds = responsiveDimensions.cellBounds[timelineIndex];
      const timeX = responsiveDimensions.xPositions[timelineIndex];
      assert.ok(timeX + numberAttribute(bolt, "data-lightning-left") >= bounds.left - 0.11);
      assert.ok(timeX + numberAttribute(bolt, "data-lightning-right") <= bounds.right + 0.11, `${responsiveWidth}px bolt stays inside the right cell edge`);
    });
    assert.doesNotMatch(responsiveSvg, /NaN|Infinity/);
  }
});

test("asymmetric five-minute SPECI cells shrink cloud and thunder art around the exact timestamp", () => {
  const cloud = (raw, ceilingFt = null) => {
    const match = raw.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
    const item = { cover: match[1], heightFt: Number(match[2]) * 100, convective: match[3] || "", raw };
    return { layers: [item], clear: false, cavok: false, ceilingFt, display: raw };
  };
  const timeline = [
    manualMeteogramPoint({ observedZ: "2026-09-11T20:00:00.000Z", clouds: cloud("BKN060", 6000) }),
    manualMeteogramPoint({
      observedZ: "2026-09-11T21:00:00.000Z",
      reportType: "SPECI",
      clouds: cloud("BKN030CB", 3000),
      weatherCodes: ["TSRA"],
      weather: { icon: "⚡", label: "THUNDERSTORM RAIN" },
    }),
    manualMeteogramPoint({ observedZ: "2026-09-11T21:05:00.000Z", reportType: "SPECI", clouds: cloud("SCT040") }),
  ];
  const model = manualMeteogramModel(timeline);
  const settings = { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" };
  const viewportWidth = 390;
  const labelLayout = meteogramRowLabelLayout(settings, viewportWidth, { hasForecast: false, compact: true });
  const dimensions = meteogramDimensions(timeline, viewportWidth, { labelWidth: labelLayout.width });
  const svg = buildMeteogramSvgMarkup(model, settings, { viewportWidth, labelLayout });
  const bounds = dimensions.cellBounds[1];
  const exactX = dimensions.xPositions[1];
  const symmetricRoom = Math.min(exactX - bounds.left, bounds.right - exactX) * 2;
  const bucketTag = svg.match(/<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="1"[^>]*>/)?.[0] || "";
  const numberAttribute = (markup, name) => Number(markup.match(new RegExp(`${name}="(-?[\\d.]+)"`))?.[1]);
  assert.ok(bucketTag);
  assert.ok(numberAttribute(bucketTag, "data-cloud-art-available-width") <= symmetricRoom + 0.11, "decorative art is sized to the narrow half of an asymmetric cell");
  assert.match(bucketTag, /clip-path="url\(#aviationMeteogramCloudBucket1Clip\)"/);
  const bucketStart = svg.indexOf(bucketTag);
  const bucketEnd = svg.indexOf('<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="2"', bucketStart);
  const bucketBody = svg.slice(bucketStart, bucketEnd);
  const bolt = bucketBody.match(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/)?.[0] || "";
  assert.ok(bolt, "the five-minute cell still has room for one restrained thunder marker");
  assert.equal((bucketBody.match(/data-weather-lightning="reported-thunder"/g) || []).length, 1);
  const boltLeft = exactX + numberAttribute(bolt, "data-lightning-left");
  const boltRight = exactX + numberAttribute(bolt, "data-lightning-right");
  assert.ok(boltLeft >= bounds.left - 0.11 && boltRight <= bounds.right + 0.11, "the bolt cannot be clipped into the next SPECI cell");
  assert.match(svg, /data-cloud-bucket-index="1"[^>]*data-cloud-time-z="2026-09-11T21:00:00.000Z"/);
  assert.match(svg, /data-cloud-label="BKN030CB"/);
  assert.match(svg, /data-ceiling-label="CIG 3,000 FT" data-ceiling-ft="3000"/);
  assert.match(svg, /data-weather-category="thunder"/);

  const vicinityTimeline = [
    timeline[0],
    manualMeteogramPoint({
      observedZ: "2026-09-11T21:00:00.000Z",
      reportType: "SPECI",
      clouds: { layers: [], clear: false, cavok: false, ceilingFt: null, display: "—" },
      weatherCodes: ["VCTS"],
      weather: { icon: "⚡", label: "THUNDERSTORM IN THE VICINITY" },
    }),
    timeline[2],
  ];
  const vicinitySvg = buildMeteogramSvgMarkup(manualMeteogramModel(vicinityTimeline), settings, { viewportWidth, labelLayout });
  const vicinityBucketStart = vicinitySvg.indexOf('<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="1"');
  const vicinityBucketEnd = vicinitySvg.indexOf('<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="2"', vicinityBucketStart);
  const vicinityBolt = vicinitySvg.slice(vicinityBucketStart, vicinityBucketEnd)
    .match(/<path class="aviation-meteogram-atmosphere-lightning"[^>]*\/>/)?.[0] || "";
  assert.ok(vicinityBolt, "VCTS retains one compact vicinity-thunder marker without fabricating a CB layer");
  assert.ok(exactX + numberAttribute(vicinityBolt, "data-lightning-left") >= bounds.left - 0.11);
  assert.ok(exactX + numberAttribute(vicinityBolt, "data-lightning-right") <= bounds.right + 0.11, "a right-shifted VCTS marker clamps back inside an asymmetric cell even with no label obstacle");
  assert.doesNotMatch(vicinitySvg.slice(vicinityBucketStart, vicinityBucketEnd), /data-cloud-development="CB"/);
});

test("three consecutive five-minute SPECI buckets retain ceiling, convection, and compact detail", () => {
  const layers = [
    { cover: "FEW", heightFt: 1700, raw: "FEW017" },
    { cover: "SCT", heightFt: 3000, convective: "CB", raw: "SCT030CB" },
    { cover: "BKN", heightFt: 5000, raw: "BKN050" },
    { cover: "OVC", heightFt: 10000, raw: "OVC100" },
  ];
  const timeline = ["20:55", "21:00", "21:05"].map((clock) => manualMeteogramPoint({
    observedZ: `2026-09-11T${clock}:00.000Z`,
    reportType: "SPECI",
    clouds: { layers, clear: false, cavok: false, ceilingFt: 5000, display: "FEW017 · SCT030CB · BKN050 · OVC100" },
    weatherCodes: ["TSRA"],
    visibilitySm: 2.5,
    visibilityDisplay: "2 1/2 SM",
    weather: { icon: "⚡", label: "THUNDERSTORM RAIN" },
  }));
  for (const viewportWidth of [320, 390]) {
    const settings = { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" };
    const labelLayout = meteogramRowLabelLayout(settings, viewportWidth, { hasForecast: false, compact: true });
    const dimensions = meteogramDimensions(timeline, viewportWidth, { labelWidth: labelLayout.width });
    const middleBounds = dimensions.cellBounds[1];
    assert.ok(middleBounds.right - middleBounds.left >= 26 && middleBounds.right - middleBounds.left < 28, `${viewportWidth}px provides a bounded readable cell for a true five-minute interval`);
    const prioritizedLayers = layers.map((layer) => ({ ...layer, ceilingFt: 5000 }));
    const layout = meteogramCloudBucketLayout(prioritizedLayers, 10000, {
      columnX: dimensions.xPositions[1],
      plotLeft: middleBounds.left,
      plotRight: middleBounds.right,
    });
    assert.equal(layout.mode, "MINIMAL");
    assert.deepEqual(layout.visibleIndexes.map((index) => layers[index].raw), ["SCT030CB", "BKN050"], "the compact cell retains the CB and the actual ceiling before FEW/upper OVC");
    assert.equal(layout.collapsedCount, 2);
    assert.equal(layout.summary?.text, "+2");
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel(timeline), settings, { viewportWidth, labelLayout });
    const start = svg.indexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text" data-cloud-bucket-index="1"');
    const end = svg.indexOf('<g class="aviation-meteogram-cloud aviation-meteogram-cloud-text" data-cloud-bucket-index="2"', start);
    const textBucket = svg.slice(start, end);
    assert.match(textBucket, /data-cloud-label="SCT030CB"/);
    assert.match(textBucket, /data-cloud-label="BKN050"/);
    assert.match(textBucket, /data-cloud-summary="\+2"/);
    assert.match(textBucket, /data-ceiling-label="CIG 5,000 FT" data-ceiling-ft="5000"/);
    const artStart = svg.indexOf('<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="1"');
    const artEnd = svg.indexOf('<g class="aviation-meteogram-cloud-bucket-art" data-cloud-bucket-index="2"', artStart);
    const artBucket = svg.slice(artStart, artEnd);
    assert.equal((artBucket.match(/data-weather-lightning="reported-thunder"/g) || []).length, 1);
    assert.equal((artBucket.match(/data-cloud-development="CB"/g) || []).length >= 1, true);
    const detailStart = svg.indexOf('<g class="aviation-meteogram-cloud-detail-sample" data-cloud-detail-sample="1"');
    const detailTag = svg.slice(detailStart, svg.indexOf(">", detailStart) + 1);
    for (const layer of layers) assert.match(detailTag, new RegExp(layer.raw));
    assert.match(detailTag, /WEATHER: TSRA/);
    assert.match(detailTag, /VIS: 2 1\/2 SM/);
  }
});

test("cloud compaction reserves a visible +N summary when full-detail label packing runs out of lanes", () => {
  const layers = [
    { cover: "FEW", heightFt: 5000, raw: "FEW050", ceilingFt: 7800 },
    { cover: "SCT", heightFt: 3300, raw: "SCT033", ceilingFt: 7800 },
    { cover: "BKN", heightFt: 9400, raw: "BKN094", ceilingFt: 7800 },
    { cover: "OVC", heightFt: 7800, raw: "OVC078", ceilingFt: 7800 },
    { cover: "FEW", heightFt: 3100, raw: "FEW031", ceilingFt: 7800 },
    { cover: "SCT", heightFt: 1400, raw: "SCT014", ceilingFt: 7800 },
  ];
  const layout = meteogramCloudBucketLayout(layers, 10000, {
    columnX: 300,
    plotLeft: 244,
    plotRight: 356,
  });
  assert.equal(layout.mode, "FULL");
  assert.ok(layout.collapsedCount > 0, "lane exhaustion collapses lower-priority labels instead of overlapping them");
  assert.ok(layout.summary, "every collapsed layer count receives an explicit +N tag");
  assert.equal(layout.summary.text, `+${layout.collapsedCount} LAYERS`);
  assert.ok(layout.layerLayout[3].visible, "the actual OVC ceiling remains visible while lower-priority labels collapse");
  assert.equal(layout.totalCollapsedCount, layout.collapsedCount);
});

test("missing cloud bases remain unknown in compact detail and never become zero-foot layers", () => {
  for (const missingBase of [null, "", Number.NaN]) {
    const point = manualMeteogramPoint({
      clouds: {
        layers: [{ cover: "BKN", heightFt: missingBase, raw: "" }],
        clear: false,
        cavok: false,
        ceilingFt: null,
        display: "BKN///",
      },
    });
    const svg = buildMeteogramSvgMarkup(manualMeteogramModel([point]), { timeMode: "Z" }, { viewportWidth: 390 });
    assert.match(svg, /BKN\/\/\/ — BASE UNKNOWN/);
    assert.match(svg, /data-ceiling-label="CIG UNKNOWN"/);
    assert.match(svg, /data-cloud-collapsed-count="0"/);
    assert.match(svg, /data-cloud-token="BKN\/\/\/" data-cloud-base="UNKNOWN"/);
    assert.match(svg, /data-cloud-label="BKN\/\/\/" data-cloud-base="UNKNOWN"/);
    assert.doesNotMatch(svg, /BKN000|data-base-ft="0"/);
  }
  for (const missingBase of [null, "", Number.NaN]) {
    const lightning = meteogramLightningGeometry({
      clouds: { layers: [{ cover: "BKN", heightFt: missingBase, convective: "CB", raw: "BKN///CB" }] },
      weatherCodes: ["TSRA"],
    });
    assert.equal(lightning.anchor, "generic-atmosphere", "unknown CB base cannot become a fabricated zero-foot lightning anchor");
    assert.equal(lightning.baseFt, null);
    assert.equal(lightning.baseY, null);
  }
});

test("unknown-base ceiling and convection outrank secondary layers in a four-minute SPECI cell", () => {
  const layers = [
    { cover: "FEW", heightFt: 5000, raw: "FEW050" },
    { cover: "SCT", heightFt: 3000, raw: "SCT030" },
    { cover: "BKN", heightFt: null, convective: "CB", raw: "BKN///CB" },
    { cover: "OVC", heightFt: 8500, ceilingFt: 8500, raw: "OVC085" },
  ];
  const layout = meteogramCloudBucketLayout(layers, 10000, {
    columnX: 210.665,
    plotLeft: 200,
    plotRight: 221.33,
  });
  assert.equal(layout.mode, "MINIMAL");
  assert.equal(layout.layerLayout[3].visible, true, "the exact reported ceiling remains first priority");
  assert.equal(layout.layerLayout[2].visible, true, "unknown-base CB remains identifiable in the second available lane");
  assert.equal(layout.layerLayout[2].unknownBase, true);
  assert.equal(layout.layerLayout[0].visible, false, "FEW yields before operationally significant layers");
  assert.equal(layout.layerLayout[1].visible, false, "SCT yields before operationally significant layers");
  assert.equal(layout.summary?.text, "+2", "the two collapsed secondary layers remain disclosed");

  const competingConvection = meteogramCloudBucketLayout([
    { cover: "OVC", heightFt: 8500, ceilingFt: 8500, raw: "OVC085" },
    { cover: "BKN", heightFt: null, convective: "TCU", raw: "BKN///TCU" },
    { cover: "BKN", heightFt: null, convective: "CB", raw: "BKN///CB" },
  ], 10000, {
    columnX: 230,
    plotLeft: 200,
    plotRight: 260,
  });
  assert.equal(competingConvection.layerLayout[0].visible, true, "the exact ceiling remains first");
  assert.equal(competingConvection.layerLayout[2].visible, true, "CB outranks TCU when only one convective lane remains");
  assert.equal(competingConvection.layerLayout[1].visible, false, "TCU collapses before CB at equal unknown-base semantics");
  assert.equal(competingConvection.summary?.text, "+1");

  const unknownCeilingFirst = meteogramCloudBucketLayout([
    { cover: "OVC", heightFt: 8500, ceilingFt: 8500, raw: "OVC085" },
    { cover: "BKN", heightFt: null, raw: "BKN///" },
    { cover: "SCT", heightFt: 3000, convective: "CB", raw: "SCT030CB" },
  ], 10000, {
    columnX: 210.665,
    plotLeft: 200,
    plotRight: 221.33,
  });
  assert.equal(unknownCeilingFirst.layerLayout[0].visible, true, "the exact ceiling remains first");
  assert.equal(unknownCeilingFirst.layerLayout[1].visible, false, "a second unknown ceiling collapses before the one compact convective indicator");
  assert.equal(unknownCeilingFirst.layerLayout[2].visible, true);

  const tiedCeilings = meteogramCloudBucketLayout([
    { cover: "BKN", heightFt: 3000, ceilingFt: 3000, raw: "BKN030" },
    { cover: "OVC", heightFt: 3000, ceilingFt: 3000, convective: "TCU", raw: "OVC030TCU" },
    { cover: "BKN", heightFt: 3000, ceilingFt: 3000, convective: "CB", raw: "BKN030CB" },
  ], 10000, {
    columnX: 230,
    plotLeft: 200,
    plotRight: 260,
  });
  assert.equal(tiedCeilings.layerLayout[2].visible, true, "CB wins a same-base ceiling tie");
  assert.equal(tiedCeilings.layerLayout[1].visible, false, "dense cells keep one compact convective/ceiling indicator instead of repeating tied layers");
  assert.equal(tiedCeilings.layerLayout[0].visible, false);
  assert.equal(tiedCeilings.summary?.text, "+2");
});

test("required multilayer and high-cloud replays keep tokens, markers, artwork, and CIG on exact bases", () => {
  const cloudsFor = (tokens) => {
    const layers = tokens.map((raw) => {
      const match = raw.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
      return { cover: match[1], heightFt: Number(match[2]) * 100, convective: match[3] || "", raw };
    });
    const ceilingLayers = layers.filter(({ cover }) => ["BKN", "OVC", "VV"].includes(cover));
    return {
      layers,
      clear: false,
      cavok: false,
      ceilingFt: ceilingLayers.length ? Math.min(...ceilingLayers.map(({ heightFt }) => heightFt)) : null,
      display: tokens.join(" · "),
    };
  };
  const scenarios = [
    { tokens: ["SCT055", "BKN070"], ceilingFt: 7000 },
    { tokens: ["FEW065", "BKN085"], ceilingFt: 8500 },
    { tokens: ["FEW060", "BKN080", "BKN100"], ceilingFt: 8000 },
    { tokens: ["FEW250", "SCT250", "SCT110"], ceilingFt: null },
  ];
  for (const scenario of scenarios) {
    const clouds = cloudsFor(scenario.tokens);
    const model = manualMeteogramModel([manualMeteogramPoint({ clouds })]);
    const scale = meteogramCloudScaleDefinition(model.timeline);
    const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
    for (const layer of clouds.layers) {
      const expectedY = meteogramCloudBaseY(layer.heightFt, scale.maximumFt).toFixed(1);
      assert.match(svg, new RegExp(`data-cloud-token="${layer.raw}" data-base-ft="${layer.heightFt}" data-base-y="${expectedY}"`));
      assert.match(svg, new RegExp(`data-cloud-base-marker="${layer.raw}" data-marker-y="${expectedY}"[^>]*y1="${expectedY}"[^>]*y2="${expectedY}"`));
      assert.match(svg, new RegExp(`data-cloud-label="${layer.raw}" data-label-anchor-y="${expectedY}"`));
      assert.match(svg, new RegExp(`data-cloud-art-base-y="${expectedY}"`));
    }
    if (scenario.ceilingFt === null) assert.match(svg, />NO CIG</);
    else assert.match(svg, new RegExp(`>CIG ${scenario.ceilingFt.toLocaleString("en-US")} FT<`));
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
  const labelLayout = meteogramRowLabelLayout({ timeMode: "Z" }, 1200, { hasForecast: true });
  const dimensions = meteogramDimensions(timeline, 1200, { labelWidth: labelLayout.width });
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
  assert.match(svg, /height="998" viewBox="0 0 [\d.]+ 998"/);
  assert.match(svg, /id="aviationMeteogramCloudArtworkClip"><rect[^>]*y="616"[^>]*height="220"/);
  assert.match(svg, /id="aviationMeteogramCloudTextClip"><rect[^>]*y="616"[^>]*height="220"/);
  assert.match(svg, /id="aviationMeteogramPrecipClip"><rect[^>]*y="910"[^>]*height="44"/);
  assert.match(svg, /id="aviationMeteogramSnowClip"><rect[^>]*y="954"[^>]*height="44"/);
  assert.equal((svg.match(/aviation-meteogram-precip-interval aviation-meteogram-interval-forecast/g) || []).length, 2, "two 6-hour totals are not replicated into hourly buckets");
  assert.equal((svg.match(/aviation-meteogram-snow-interval aviation-meteogram-interval-forecast/g) || []).length, 1);
  assert.match(svg, /data-valid-start="2026-09-01T06:00:00\.000Z" data-valid-end="2026-09-01T12:00:00\.000Z"/);
  assert.match(svg, /data-render-start="2026-09-01T06:00:00\.000Z" data-render-end="2026-09-01T12:00:00\.000Z"/);
  assert.match(svg, /data-amount-in="1"/);
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
  for (const [type, top, bottom] of [["precip", 910, 954], ["snow", 954, 998]]) {
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
  for (const viewport of [1920, 1366, 1280, 1024, 844, 768, 414, 390, 375, 320]) {
    const labelLayout = meteogramRowLabelLayout(
      { timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" },
      viewport,
      { hasForecast: true, compact: viewport <= 768 },
    );
    const dimensions = meteogramDimensions(timeline, viewport, { labelWidth: labelLayout.width });
    assert.ok(Number.isFinite(dimensions.width) && dimensions.width >= viewport);
    assert.equal(dimensions.height, 998);
    assert.equal(dimensions.labelWidth, labelLayout.width);
    assert.ok(labelLayout.width >= labelLayout.minimumWidth && labelLayout.width <= labelLayout.maximumWidth);
    assert.ok(labelLayout.width <= 280, "dynamic labels never consume beyond the bounded upper limit");
    assert.ok(dimensions.xPositions.every((x) => x >= dimensions.labelWidth && x <= dimensions.width));
    if (viewport <= 844) assert.ok(dimensions.width > viewport, "dense mobile/tablet timeline scrolls inside its region");
  }
});

test("phone label geometry preserves a meaningful live timeline viewport after real modal padding", () => {
  const timeline = Array.from({ length: 25 }, (_, index) => manualMeteogramPoint({
    observedZ: new Date(Date.UTC(2026, 8, 1, index)).toISOString(),
  }));
  for (const [outerWidth, scrollerWidth, minimumVisible] of [
    [320, 298, 128],
    [390, 368, 178],
  ]) {
    const labelLayout = meteogramRowLabelLayout(
      { timeMode: "LOCAL", temperatureUnit: "F", windUnit: "MPH" },
      scrollerWidth,
      { hasForecast: true, compact: true, measureText: (text) => String(text).length * 7.5 },
    );
    const dimensions = meteogramDimensions(timeline, Math.max(320, scrollerWidth), { labelWidth: labelLayout.width });
    const visibleTimelineWidth = scrollerWidth - dimensions.plotLeft;
    assert.ok(visibleTimelineWidth >= minimumVisible, `${outerWidth}px phone retains at least ${minimumVisible}px of live timeline`);
    assert.equal(dimensions.axisWidth, 58, "operational numeric/altitude axis remains intact");
    for (const row of labelLayout.rows) {
      for (const line of [...row.titleLines, ...row.unitLines]) {
        assert.ok(String(line).length * 7.5 <= labelLayout.maximumTextWidth, `${row.key} wraps within the compact description gutter`);
      }
      const requiredHeight = row.titleLines.length * 12 + 8 + row.unitLines.length * 10;
      assert.ok(requiredHeight <= row.bottom - row.top, `${row.key} compact label remains vertically contained`);
    }
  }
});

test("mobile timeline buttons pan one visible data window and return to the shared NOW coordinate", () => {
  const geometry = {
    currentScrollLeft: 500,
    scrollWidth: 3200,
    clientWidth: 368,
    plotLeft: 183,
    dividerX: 1400,
  };
  assert.equal(meteogramMobileNavigationScrollLeft("earlier", geometry), 315);
  assert.equal(meteogramMobileNavigationScrollLeft("later", geometry), 685);
  assert.equal(meteogramMobileNavigationScrollLeft("now", geometry), 1124.5);
  assert.equal(meteogramMobileNavigationScrollLeft("earlier", { ...geometry, currentScrollLeft: 20 }), 0);
  assert.equal(meteogramMobileNavigationScrollLeft("later", { ...geometry, currentScrollLeft: 2820 }), 2832);
  assert.equal(meteogramMobileNavigationScrollLeft("now", { ...geometry, dividerX: null }), 500);
  assert.deepEqual(
    meteogramMobileNavigationAnchor({
      dividerZ: "2026-09-01T06:00:00Z",
      observations: [{ observedZ: "2026-09-01T05:54:00Z" }],
    }),
    { label: "NOW", time: "2026-09-01T06:00:00Z" },
  );
  assert.deepEqual(
    meteogramMobileNavigationAnchor({
      dividerZ: null,
      forecasts: [],
      observations: [
        { observedZ: "2026-09-01T04:54:00Z" },
        { observedZ: "2026-09-01T05:54:00Z" },
      ],
    }),
    { label: "LATEST", time: "2026-09-01T05:54:00Z" },
    "observed-only views provide an explicit bounded LATEST jump instead of a silent NOW no-op",
  );
  assert.match(meteogramJs, /mobileNavigationHint\.textContent = "SWIPE TIMELINE ↔ OR JUMP"/);
  assert.match(meteogramJs, /\["earlier", "← EARLIER"\][\s\S]*\["now", mobileNavigationAnchor\.label\][\s\S]*\["later", "LATER →"\]/);
  assert.match(meteogramJs, /scroller\.scrollLeft = meteogramMobileNavigationScrollLeft/);
  assert.match(meteogramJs, /plotLeft: dimensions\.plotLeft/);
  assert.doesNotMatch(meteogramJs, /data-meteogram-pan[\s\S]{0,500}(?:fetch\(|draw\(\))/i, "mobile navigation changes only scroll position");
});

test("mobile meteogram controls expose touch-sized navigation without changing desktop or print layout", () => {
  assert.match(meteogramCss, /\.aviation-meteogram-mobile-nav\{display:none\}/);
  assert.match(meteogramCss, /@media \(max-width:768px\)[\s\S]*\.aviation-meteogram-mobile-nav\{[\s\S]*display:grid/);
  assert.match(meteogramCss, /\.aviation-meteogram-mobile-nav button\{[\s\S]*min-height:44px/);
  assert.match(
    meteogramCss,
    /@media \(min-width:769px\) and \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{[\s\S]*?\.aviation-meteogram-mobile-nav\{[\s\S]*?display:grid;[\s\S]*?\.aviation-meteogram-mobile-nav button\{[\s\S]*?min-height:40px/,
  );
  assert.match(meteogramCss, /body\.aviation-meteogram-printing \.aviation-meteogram-mobile-nav\{display:none!important\}/);
  assert.match(meteogramCss, /-webkit-overflow-scrolling:touch/);
  assert.doesNotMatch(meteogramCss, /\.aviation-meteogram-scroll\{[^}]*overflow-x:hidden/);
  assert.match(lookupCss, /@media \(max-width:480px\)\{[\s\S]*\.aviation-lookup-panel-meteogram \.aviation-lookup-results\{padding:4px 5px 8px\}/);
});

test("the meteogram remains isolated from BWC and updater ownership logic", () => {
  const combined = [meteogramCore, meteogramJs, meteogramSolarJs, meteogramCss].join("\n");
  assert.doesNotMatch(combined, /bwc|PRIMARY|BACKUP|lease|failover|heartbeat/i);
  assert.doesNotMatch(lookupJs, /weather[_-]history\.json/i);
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/weather-meteogram\.css">/);
  assert.doesNotMatch(indexHtml, /<script[^>]+weather-meteogram\.js/);
});
