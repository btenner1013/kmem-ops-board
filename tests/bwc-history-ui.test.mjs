import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BWC_SHORT_EVENT_MAX_WIDTH_PX,
  applyBwcHistoryDialogState,
  availabilityLines,
  buildBwcObservationTracePaths,
  bwcPlotPointerRatio,
  createBwcHistoryLoader,
  downloadBwcCsv,
  findTimelineSegmentAt,
  formatCurrentBwc,
  historyFailureArchiveMessage,
  initializeBwcHistory,
  renderBwcHistoryChart,
  renderBwcSummaryTable,
  selectBwcShortEventMarkers,
  updateBwcSummaryModeButtons,
  updateLiveBwcAge,
} from "../bwc-history.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const historyCss = readFileSync(new URL("../bwc-history.css", import.meta.url), "utf8");
const historyJs = readFileSync(new URL("../bwc-history.js", import.meta.url), "utf8");
const EXPECTED_BWC_AXIS_GUTTER_WIDTH = 84;
const EXPECTED_BWC_AXIS_LABEL_X = 74;

function liveStampFormatter() {
  const source = indexHtml.match(/function formatAhasBwcDateTime\(value\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "live BWC timestamp formatter must exist");
  return Function(`"use strict"; ${source}; return formatAhasBwcDateTime;`)();
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    event.defaultPrevented ||= false;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    event.stopPropagation ||= () => {};
    for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
    return !event.defaultPrevented;
  }
}

class FakeNode extends FakeEventTarget {
  constructor(ownerDocument, tagName = "") {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this._className = "";
    this._text = "";
    this.classList = {
      add: (...names) => this.setClasses([...this.classes(), ...names]),
      remove: (...names) => this.setClasses([...this.classes()].filter((name) => !names.includes(name))),
      contains: (name) => this.classes().has(name),
      toggle: (name, force) => {
        const classes = this.classes();
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.setClasses(classes);
        return enabled;
      },
    };
  }

  classes() {
    return new Set(this._className.split(/\s+/).filter(Boolean));
  }

  setClasses(names) {
    this._className = [...new Set(names)].filter(Boolean).join(" ");
    this.attributes.set("class", this._className);
  }

  get className() { return this._className; }
  set className(value) { this.setClasses(String(value || "").split(/\s+/)); }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((child) => child instanceof FakeNode && child.tagName); }
  get childElementCount() { return this.children.length; }
  get textContent() {
    return this.childNodes.length
      ? this.childNodes.map((child) => child.textContent).join("")
      : this._text;
  }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this._text = String(value ?? "");
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    const child = typeof node === "string" ? this.ownerDocument.createTextNode(node) : node;
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    this._text = "";
    return child;
  }

  insertBefore(node, reference) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    const index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === "class") this._className = stringValue;
    if (name === "id") this.id = stringValue;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }

  matches(selector) {
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (node.matches?.(selector)) return node;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (child.matches(selector)) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  getBoundingClientRect() {
    if (this.tagName === "SVG") {
      const [, , width = 820, height = 286] = String(this.getAttribute("viewBox") || "0 0 820 286")
        .split(/\s+/).map(Number);
      return { left: 0, top: 0, width, height, right: width, bottom: height };
    }
    if (this.classList.contains("bwc-history-hit-area")) {
      const left = Number(this.getAttribute("x"));
      const top = Number(this.getAttribute("y"));
      const width = Number(this.getAttribute("width"));
      const height = Number(this.getAttribute("height"));
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    const width = this.clientWidth || 820;
    const height = this.clientHeight || 286;
    return { left: 0, top: 0, width, height, right: width, bottom: height };
  }

  setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
  releasePointerCapture(pointerId) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() {
    this.ownerDocument.lastClicked = this;
    this.dispatchEvent({ type: "click" });
  }
}

class FakeDocument extends FakeEventTarget {
  constructor(view) {
    super();
    this.defaultView = view;
    this.baseURI = "https://example.test/board/index.html";
    this.elements = new Map();
    this.rangeButtons = [];
    this.summaryButtons = [];
    this.lastClicked = null;
    this.body = new FakeNode(this, "body");
    this.activeElement = this.body;
  }

  createElement(tagName) { return new FakeNode(this, tagName); }
  createElementNS(_namespace, tagName) { return new FakeNode(this, tagName); }
  createTextNode(value) {
    const node = new FakeNode(this);
    node.textContent = value;
    return node;
  }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelectorAll(selector) {
    if (selector === "[data-bwc-range]") return this.rangeButtons;
    if (selector === "[data-bwc-summary-mode]") return this.summaryButtons;
    return [];
  }
  register(id, tagName = "div") {
    const element = this.createElement(tagName);
    element.setAttribute("id", id);
    this.elements.set(id, element);
    return element;
  }
}

function behavioralBwcFixture() {
  const nowMs = Date.parse("2026-08-30T15:00:00Z");
  const archive = {
    schemaVersion: 1,
    station: "KMEM",
    product: "USAHAS_AHAS_RISK",
    sourceArea: { type: "ICAO", name: "MEMPHIS INTL" },
    sourceTimestampField: "DateTime",
    retentionDays: 365,
    continuityMinutes: 90,
    collectionStartedZ: "2026-07-31T15:00:00Z",
    archiveUpdatedZ: "2026-08-30T15:00:00Z",
    runs: [{
      kind: "STATE",
      state: "MODERATE",
      rawAhasRisk: "MODERATE",
      startZ: "2026-07-31T15:00:00Z",
      firstObservedZ: "2026-07-31T15:00:00Z",
      lastObservedZ: "2026-08-30T15:00:00Z",
      firstRecordedZ: "2026-07-31T15:00:00Z",
      lastRecordedZ: "2026-08-30T15:00:00Z",
      confirmationCount: 120,
      startReason: "ARCHIVE_START",
      source: "USAHAS",
      basis: "NEXBAM",
      basisClass: "MODEL_OPERATIONAL",
    }],
  };
  const view = new FakeEventTarget();
  view.kmemWeatherData = {
    bwc: "MODERATE",
    bwcUpdatedZ: "2026-08-30T15:00:00Z",
    bwcBasedOn: "NEXBAM",
  };
  view.getBoardNowMs = () => nowMs;
  view.requestAnimationFrame = (callback) => { callback(); return 1; };
  view.cancelAnimationFrame = () => {};
  view.setTimeout = (callback) => { callback(); return 1; };
  view.Blob = class FakeBlob {
    constructor(parts, options) { this.parts = parts; this.type = options?.type; }
  };
  view.createdObjectUrls = [];
  view.revokedObjectUrls = [];
  view.URL = {
    createObjectURL(blob) {
      view.createdObjectUrls.push(blob);
      return `blob:fake-${view.createdObjectUrls.length}`;
    },
    revokeObjectURL(url) { view.revokedObjectUrls.push(url); },
  };
  view.fetchCount = 0;
  view.fetch = async () => {
    view.fetchCount += 1;
    return { ok: true, async json() { return archive; } };
  };

  const doc = new FakeDocument(view);
  for (const id of [
    "bwcHistoryOverlay", "bwcHistoryPanel", "bwcHistoryCloseButton", "bwcHistoryStatus",
    "bwcHistoryChart", "bwcHistoryTooltip", "bwcHistoryCurrent", "bwcHistoryLastChange",
    "bwcHistoryStats", "bwcHistoryArchive", "bwcHistoryLegend", "bwcHistoryZoomOut",
    "bwcHistoryZoomIn", "bwcHistoryZoomReset", "bwcHistoryZoomStatus", "bwcHistoryExportCsv",
    "bwcHistorySummaryContent", "bwcHistorySummaryContext", "bwcHistoryExportStatus",
  ]) doc.register(id, id.includes("Button") || id.includes("Zoom") && id !== "bwcHistoryZoomStatus" || id === "bwcHistoryExportCsv" ? "button" : "div");
  doc.getElementById("bwcHistoryOverlay").hidden = true;
  doc.getElementById("bwcHistoryTooltip").hidden = true;
  doc.getElementById("bwcHistoryChart").clientWidth = 820;
  doc.getElementById("bwcHistoryChart").clientHeight = 286;
  doc.getElementById("bwcHistoryTooltip").offsetWidth = 230;
  doc.getElementById("bwcHistoryTooltip").offsetHeight = 96;
  doc.getElementById("bwcHistoryExportCsv").disabled = true;
  for (const range of ["24h", "7d"]) {
    const button = doc.createElement("button");
    button.dataset.bwcRange = range;
    doc.rangeButtons.push(button);
  }
  for (const mode of ["daily", "monthly", "seasonal"]) {
    const button = doc.createElement("button");
    button.dataset.bwcSummaryMode = mode;
    button.className = "bwc-history-summary-tab";
    doc.summaryButtons.push(button);
  }
  return { archive, doc, nowMs, view };
}

function expectedZuluTime(timestampMs) {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const date = new Date(timestampMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`;
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
    "bwcHistoryZoomOut",
    "bwcHistoryZoomIn",
    "bwcHistoryZoomReset",
    "bwcHistoryZoomStatus",
    "bwcHistoryCurrent",
    "bwcHistoryLastChange",
    "bwcHistoryStats",
    "bwcHistoryArchive",
    "bwcHistoryLegend",
    "bwcHistoryAnalysis",
    "bwcHistoryExportCsv",
    "bwcHistorySummaryDaily",
    "bwcHistorySummaryMonthly",
    "bwcHistorySummarySeasonal",
    "bwcHistorySummaryContext",
    "bwcHistoryExportStatus",
    "bwcHistorySummaryContent",
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
});

test("archive summary controls are compact native buttons with accessible selected state", () => {
  assert.match(indexHtml, /id="bwcHistoryAnalysis"[^>]*aria-labelledby="bwcHistoryAnalysisHeading"/);
  assert.match(indexHtml, /id="bwcHistoryAnalysisHeading"[^>]*>RETAINED ARCHIVE SUMMARY</);
  assert.match(indexHtml, /id="bwcHistoryExportCsv"[^>]*type="button"[^>]*disabled>EXPORT CSV</);
  assert.match(indexHtml, /id="bwcHistoryExportCsv"[^>]*aria-describedby="bwcHistorySummaryContext bwcHistoryExportStatus"/);
  assert.match(indexHtml, /class="bwc-history-summary-tabs" role="group" aria-label="BWC history summary period"/);
  for (const [mode, selected] of [["daily", "true"], ["monthly", "false"], ["seasonal", "false"]]) {
    assert.match(indexHtml, new RegExp(`data-bwc-summary-mode="${mode}"[^>]*aria-pressed="${selected}"[^>]*aria-controls="bwcHistorySummaryContent"`));
  }
  assert.match(indexHtml, /id="bwcHistorySummaryContent"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(indexHtml, /AMERICA\/CHICAGO · EXACT RETAINED OBSERVATIONS ONLY/);
});

test("summary renderer exposes truthful metrics in semantic daily, monthly, and seasonal tables", () => {
  const doc = new FakeDocument(new FakeEventTarget());
  const content = doc.createElement("div");
  const context = doc.createElement("span");
  const base = {
    representedStartMs: 100,
    representedEndMs: 200,
    representedMs: 86_400_000,
    representedDays: 1,
    isComplete: false,
    durationsMs: { LOW: 21_600_000, MODERATE: 21_600_000, SEVERE: 10_800_000, UNKNOWN: 32_400_000 },
    percentages: { LOW: 8.7, MODERATE: 4.3, SEVERE: 6.5, UNKNOWN: 80.4 },
    coveragePercent: 19.6,
    peakState: "SEVERE",
    changeCount: 3,
    severeEpisodes: 1,
    observationCount: 7,
    severeDays: 1,
  };
  const summary = {
    ok: true,
    daily: [{ ...base, key: "2026-08-30", label: "30 AUG 2026" }],
    monthly: [{ ...base, representedDays: 63.4, key: "2026-08", label: "AUG 2026" }],
    seasonal: [{ ...base, representedDays: 63.4, key: "SUMMER-2026", label: "SUMMER 2026" }],
  };
  for (const [mode, label] of [["daily", "30 AUG 2026"], ["monthly", "AUG 2026"], ["seasonal", "SUMMER 2026"]]) {
    assert.equal(renderBwcSummaryTable(doc, content, context, summary, mode, "24 HR"), true);
    const table = content.querySelector(`.bwc-history-summary-table-${mode}`);
    assert.ok(table);
    assert.match(table.textContent, new RegExp(label));
    assert.match(table.textContent, /SEVERE/);
    assert.match(table.textContent, /PARTIAL/);
    assert.match(table.textContent, /80\.5%/, "display rounding keeps the four state percentages at exactly 100.0%");
    assert.match(table.textContent, /19\.6%/);
    if (mode !== "daily") assert.match(table.textContent, /63\.4 DAYS · PARTIAL/);
    assert.match(context.textContent, /24 HR SELECTED/);
    assert.match(context.textContent, /AMERICA\/CHICAGO/);
  }
  const buttons = ["daily", "monthly", "seasonal"].map((mode) => {
    const button = doc.createElement("button");
    button.dataset.bwcSummaryMode = mode;
    return button;
  });
  assert.equal(updateBwcSummaryModeButtons(buttons, "monthly"), "monthly");
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-pressed")), ["false", "true", "false"]);
  assert.equal(buttons[1].classList.contains("bwc-history-summary-tab-active"), true);
});

test("CSV download helper creates one local blob download and revokes it", () => {
  const { doc, view } = behavioralBwcFixture();
  const result = downloadBwcCsv(doc, view, {
    content: "\ufeffrecord_type,state\r\nSTATE,LOW\r\n",
    filename: "KMEM_BWC_HISTORY_2026-08-30_24HR.csv",
    mimeType: "text/csv;charset=utf-8",
  });
  assert.equal(result.ok, true);
  assert.equal(view.createdObjectUrls.length, 1);
  assert.equal(view.createdObjectUrls[0].parts[0], "\ufeffrecord_type,state\r\nSTATE,LOW\r\n");
  assert.equal(view.createdObjectUrls[0].type, "text/csv;charset=utf-8");
  assert.equal(view.revokedObjectUrls.length, 1);
  assert.equal(doc.lastClicked.tagName, "A");
  assert.equal(doc.lastClicked.download, "KMEM_BWC_HISTORY_2026-08-30_24HR.csv");
  assert.equal(doc.lastClicked.href, "blob:fake-1");
  assert.equal(doc.lastClicked.parentNode, null);
});

test("time-axis controls are compact native buttons with explicit chart relationships", () => {
  assert.match(indexHtml, /class="bwc-history-zoom-controls" role="group" aria-label="BWC history time-axis zoom"/);
  for (const id of ["bwcHistoryZoomOut", "bwcHistoryZoomIn", "bwcHistoryZoomReset"]) {
    assert.match(indexHtml, new RegExp(`id="${id}"[^>]*type="button"[^>]*aria-controls="bwcHistoryChart"[^>]*disabled`));
  }
  assert.match(indexHtml, /id="bwcHistoryZoomOut"[^>]*aria-label="Zoom out BWC history time axis"/);
  assert.match(indexHtml, /id="bwcHistoryZoomIn"[^>]*aria-label="Zoom in BWC history time axis"/);
  assert.match(indexHtml, /id="bwcHistoryZoomStatus"[^>]*>FULL RANGE</);
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

test("controller events drive the visible viewport while preserving the selected master range", async () => {
  const { doc, view } = behavioralBwcFixture();
  const controller = initializeBwcHistory(doc);
  assert.ok(controller, "the complete fake view should initialize the real controller");
  assert.equal(controller.historyLoaded, false, "history remains lazy until the dialog opens");

  const opener = doc.createElement("button");
  controller.open(opener);
  for (let turn = 0; turn < 8 && !controller.historyLoaded; turn += 1) await Promise.resolve();
  assert.equal(controller.historyLoaded, true, "opening loads and renders the normalized archive response");

  const chart = doc.getElementById("bwcHistoryChart");
  const tooltip = doc.getElementById("bwcHistoryTooltip");
  const stats = doc.getElementById("bwcHistoryStats");
  const zoomIn = doc.getElementById("bwcHistoryZoomIn");
  const zoomOut = doc.getElementById("bwcHistoryZoomOut");
  const zoomReset = doc.getElementById("bwcHistoryZoomReset");
  const exportButton = doc.getElementById("bwcHistoryExportCsv");
  const summaryContent = doc.getElementById("bwcHistorySummaryContent");
  const summaryContext = doc.getElementById("bwcHistorySummaryContext");
  const initial = controller.timeDomain;
  const initialStatistics = stats.textContent;
  assert.equal(initial.ok, true);
  assert.equal(initial.isFullRange, true);
  assert.equal(initial.durationMs, 24 * 60 * 60 * 1000);
  assert.equal(Number(chart.dataset.bwcMasterEndMs) - Number(chart.dataset.bwcMasterStartMs), initial.durationMs);
  assert.equal(Number(chart.dataset.bwcVisibleDurationMs), initial.durationMs);
  assert.equal(exportButton.disabled, false, "loaded selected-range data enables user-clicked CSV export");
  assert.ok(summaryContent.querySelector(".bwc-history-summary-table-daily"));
  assert.match(summaryContext.textContent, /24 HR SELECTED/);
  assert.equal(controller.summaryMode, "daily");
  assert.equal(view.fetchCount, 1);

  const chartBeforeSummaryMode = chart.querySelector(".bwc-history-svg");
  const domainBeforeSummaryMode = controller.timeDomain;
  const statsBeforeSummaryMode = stats.textContent;
  const monthlySummaryButton = doc.summaryButtons.find((button) => button.dataset.bwcSummaryMode === "monthly");
  monthlySummaryButton.dispatchEvent({ type: "click" });
  assert.equal(controller.summaryMode, "monthly");
  assert.equal(monthlySummaryButton.getAttribute("aria-pressed"), "true");
  assert.ok(summaryContent.querySelector(".bwc-history-summary-table-monthly"));
  assert.strictEqual(chart.querySelector(".bwc-history-svg"), chartBeforeSummaryMode, "summary mode does not recreate the chart");
  assert.strictEqual(controller.timeDomain, domainBeforeSummaryMode, "summary mode does not alter zoom/pan state");
  assert.equal(stats.textContent, statsBeforeSummaryMode, "existing duration statistics remain unchanged");

  exportButton.dispatchEvent({ type: "click" });
  assert.equal(view.fetchCount, 1, "CSV export reuses the loaded archive without another request");
  assert.equal(view.createdObjectUrls.length, 1);
  assert.equal(doc.lastClicked.download, "KMEM_BWC_HISTORY_2026-08-30_24HR.csv");
  assert.match(view.createdObjectUrls[0].parts[0], /^\ufeffrecord_type,/);

  const summaryTableBeforeResize = summaryContent.querySelector(".bwc-history-summary-table-monthly");
  view.dispatchEvent({ type: "resize" });
  assert.strictEqual(
    summaryContent.querySelector(".bwc-history-summary-table-monthly"),
    summaryTableBeforeResize,
    "responsive chart redraw keeps the cached selected-range summary table",
  );

  const firstHitArea = chart.querySelector(".bwc-history-hit-area");
  const firstPlotRect = firstHitArea.getBoundingClientRect();
  const anchorRatio = 0.25;
  const anchorBefore = initial.startMs + initial.durationMs * anchorRatio;
  const wheel = {
    type: "wheel",
    clientX: firstPlotRect.left + firstPlotRect.width * anchorRatio,
    deltaY: -100,
    deltaMode: 0,
  };
  chart.dispatchEvent(wheel);
  const wheelDomain = controller.timeDomain;
  assert.equal(wheel.defaultPrevented, true, "cursor wheel zoom prevents page/modal scrolling");
  assert.equal(wheelDomain.durationMs, initial.durationMs / 1.25);
  assert.ok(
    Math.abs(wheelDomain.startMs + wheelDomain.durationMs * anchorRatio - anchorBefore) < 1,
    "wheel zoom keeps the UTC instant below the cursor anchored",
  );
  assert.equal(Number(chart.dataset.bwcMasterStartMs), initial.masterStartMs);
  assert.equal(Number(chart.dataset.bwcMasterEndMs), initial.masterEndMs);
  assert.equal(stats.textContent, initialStatistics, "viewport-only zoom does not recalculate master-range statistics");

  const tooltipRatio = 0.4;
  const tooltipHitArea = chart.querySelector(".bwc-history-hit-area");
  const tooltipRect = tooltipHitArea.getBoundingClientRect();
  tooltipHitArea.dispatchEvent({
    type: "pointermove",
    clientX: tooltipRect.left + tooltipRect.width * tooltipRatio,
    clientY: 120,
  });
  assert.equal(tooltip.hidden, true, "chart background and step context do not expose observation metadata");

  const panHitArea = chart.querySelector(".bwc-history-hit-area");
  const panRect = panHitArea.getBoundingClientRect();
  const pointerStartX = panRect.left + panRect.width / 2;
  chart.dispatchEvent({
    type: "pointerdown",
    target: panHitArea,
    pointerId: 17,
    pointerType: "mouse",
    button: 0,
    isPrimary: true,
    clientX: pointerStartX,
  });
  const drag = {
    type: "pointermove",
    target: panHitArea,
    pointerId: 17,
    clientX: pointerStartX + 20,
  };
  chart.dispatchEvent(drag);
  const panned = controller.timeDomain;
  assert.equal(drag.defaultPrevented, true);
  assert.ok(panned.startMs < wheelDomain.startMs, "dragging right pans the UTC viewport toward earlier history");
  assert.ok(Math.abs(
    panned.startMs - (wheelDomain.startMs - (20 / panRect.width) * wheelDomain.durationMs),
  ) < 1);
  chart.dispatchEvent({ type: "pointerup", pointerId: 17 });
  assert.ok(Number(chart.dataset.bwcSuppressClickUntil) > Date.now());

  const beforeButtonZoom = controller.timeDomain;
  zoomIn.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.durationMs, beforeButtonZoom.durationMs / 2);
  zoomOut.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.durationMs, beforeButtonZoom.durationMs);

  let zoomClicks = 0;
  while (!zoomIn.disabled && zoomClicks < 20) {
    zoomIn.dispatchEvent({ type: "click" });
    zoomClicks += 1;
  }
  assert.ok(zoomClicks < 20, "zoom-in control reaches a finite minimum");
  assert.equal(controller.timeDomain.durationMs, 30 * 60 * 1000);
  assert.equal(zoomIn.disabled, true);
  zoomOut.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.durationMs, 60 * 60 * 1000);
  zoomReset.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.isFullRange, true);
  assert.equal(controller.timeDomain.durationMs, 24 * 60 * 60 * 1000);

  const sevenDayButton = doc.rangeButtons.find((button) => button.dataset.bwcRange === "7d");
  sevenDayButton.dispatchEvent({ type: "click" });
  assert.equal(controller.activeRange, "7d");
  assert.equal(controller.summaryMode, "monthly", "range changes preserve the selected summary mode");
  assert.match(summaryContext.textContent, /7 DAYS SELECTED/);
  assert.match(exportButton.getAttribute("aria-label"), /selected 7 DAYS/);
  assert.ok(summaryContent.querySelector(".bwc-history-summary-table-monthly"));
  assert.equal(controller.timeDomain.isFullRange, true);
  assert.equal(controller.timeDomain.durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(Number(chart.dataset.bwcMasterEndMs) - Number(chart.dataset.bwcMasterStartMs), controller.timeDomain.durationMs);
  zoomIn.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.isFullRange, false);
  sevenDayButton.dispatchEvent({ type: "click" });
  assert.equal(controller.timeDomain.isFullRange, true, "even the active master-range button resets its viewport");
  assert.equal(controller.timeDomain.durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(stats.textContent, initialStatistics, "master summaries remain independent of viewport interactions");
});

test("wheel and pointer pan coalesce annual-safe viewport redraws to one animation frame", async () => {
  const { doc, view } = behavioralBwcFixture();
  let nextFrame = 1;
  const frames = new Map();
  view.requestAnimationFrame = (callback) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.set(id, callback);
    return id;
  };
  view.cancelAnimationFrame = (id) => { frames.delete(id); };
  function flushFrames() {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [_id, callback] of pending) callback();
    return pending.length;
  }

  const controller = initializeBwcHistory(doc);
  controller.open(doc.createElement("button"));
  for (let turn = 0; turn < 8 && !controller.historyLoaded; turn += 1) await Promise.resolve();
  flushFrames(); // deferred focus from dialog opening

  const chart = doc.getElementById("bwcHistoryChart");
  const initialSvg = chart.querySelector(".bwc-history-svg");
  const hitArea = chart.querySelector(".bwc-history-hit-area");
  const rect = hitArea.getBoundingClientRect();
  for (let index = 0; index < 100; index += 1) {
    chart.dispatchEvent({
      type: "wheel",
      clientX: rect.left + rect.width / 2,
      deltaY: -1,
      deltaMode: 0,
    });
  }
  assert.equal(frames.size, 1, "100 wheel events queue one viewport redraw");
  assert.strictEqual(chart.querySelector(".bwc-history-svg"), initialSvg, "DOM waits for the queued frame");
  assert.equal(controller.timeDomain.durationMs, 30 * 60 * 1000, "all wheel deltas accumulate before redraw");
  assert.equal(flushFrames(), 1);
  assert.notStrictEqual(chart.querySelector(".bwc-history-svg"), initialSvg);

  const panSvg = chart.querySelector(".bwc-history-svg");
  const panHitArea = chart.querySelector(".bwc-history-hit-area");
  const panRect = panHitArea.getBoundingClientRect();
  const startX = panRect.left + panRect.width / 2;
  chart.dispatchEvent({
    type: "pointerdown", target: panHitArea, pointerId: 41, pointerType: "mouse",
    button: 0, isPrimary: true, clientX: startX,
  });
  const beforePan = controller.timeDomain.startMs;
  for (let index = 1; index <= 100; index += 1) {
    chart.dispatchEvent({
      type: "pointermove", target: panHitArea, pointerId: 41, clientX: startX + index,
    });
  }
  assert.equal(frames.size, 1, "100 pointer moves queue one viewport redraw");
  assert.ok(controller.timeDomain.startMs < beforePan, "all horizontal pan deltas accumulate before redraw");
  assert.strictEqual(chart.querySelector(".bwc-history-svg"), panSvg);
  assert.equal(flushFrames(), 1);
  assert.notStrictEqual(chart.querySelector(".bwc-history-svg"), panSvg);
  chart.dispatchEvent({ type: "pointerup", pointerId: 41 });

  const closeRect = chart.querySelector(".bwc-history-hit-area").getBoundingClientRect();
  chart.dispatchEvent({
    type: "wheel", clientX: closeRect.left + closeRect.width / 2, deltaY: 100, deltaMode: 0,
  });
  assert.equal(frames.size, 1);
  controller.close();
  assert.equal(frames.size, 0, "closing cancels a pending viewport redraw");
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

test("heartbeat trace connects exact observations diagonally, changes color, and breaks across UNKNOWN", () => {
  const observations = [
    { kind: "STATE", state: "LOW", timeMs: 100 },
    { kind: "STATE", state: "MODERATE", timeMs: 200 },
    { kind: "STATE", state: "SEVERE", timeMs: 400 },
    { kind: "STATE", state: "LOW", timeMs: 500 },
  ];
  const timeline = {
    segments: [
      { kind: "STATE", state: "LOW", startMs: 100, endMs: 200 },
      { kind: "STATE", state: "MODERATE", startMs: 200, endMs: 250 },
      { kind: "UNKNOWN", startMs: 250, endMs: 400 },
      { kind: "STATE", state: "SEVERE", startMs: 400, endMs: 500 },
    ],
  };
  const trace = buildBwcObservationTracePaths(observations, timeline, {
    xForTime: (timeMs) => timeMs,
    yByState: { LOW: 200, MODERATE: 100, SEVERE: 0 },
  });

  assert.equal(trace.ok, true);
  assert.equal(trace.segmentCount, 2, "the UNKNOWN interval is never bridged");
  assert.equal(trace.outlineD, "M 100 200 L 200 100 M 400 0 L 500 200");
  assert.doesNotMatch(trace.outlineD, /\b[HV]\b/, "the visible trace has no squared step commands");
  const byState = Object.fromEntries(trace.paths.map((path) => [path.state, path.d]));
  assert.equal(byState.LOW, "M 100 200 L 150 150 M 450 100 L 500 200");
  assert.equal(byState.MODERATE, "M 150 150 L 200 100");
  assert.equal(byState.SEVERE, "M 400 0 L 450 100");
  assert.equal(trace.paths.length, 3, "color-coded geometry stays batched by categorical state");
});

test("short BWC events remain exact while the visible graph stays one heartbeat trace", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const dayStart = Date.parse("2026-08-30T00:00:00Z");
  const dayEnd = Date.parse("2026-08-31T00:00:00Z");
  const moderateStart = Date.parse("2026-08-30T09:00:00Z");
  const severeStart = Date.parse("2026-08-30T09:38:00Z");
  const severeEnd = Date.parse("2026-08-30T09:44:00Z");
  const moderateEnd = Date.parse("2026-08-30T11:00:00Z");
  const runs = [
    { state: "MODERATE", timeMs: moderateStart, basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL" },
    { state: "SEVERE", timeMs: severeStart, basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL" },
    { state: "MODERATE", timeMs: severeEnd, basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL" },
  ].map((run) => ({
    kind: "STATE",
    state: run.state,
    startMs: run.timeMs,
    firstObservedMs: run.timeMs,
    lastObservedMs: run.timeMs,
    observationsZ: [new Date(run.timeMs).toISOString()],
    observationTimesMs: [run.timeMs],
    observationsComplete: true,
    confirmationCount: 1,
    startReason: "STATE_CHANGE",
    source: "USAHAS",
    basis: run.basis,
    basisClass: run.basisClass,
  }));
  const segments = [
    { ...runs[0], startMs: moderateStart, endMs: severeStart },
    { ...runs[1], startMs: severeStart, endMs: severeEnd },
    { ...runs[2], startMs: severeEnd, endMs: moderateEnd },
  ];
  const overview = {
    range: { startMs: dayStart, endMs: dayEnd, durationMs: dayEnd - dayStart },
    history: { runs },
    segments,
  };
  const plotWidth = 820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14;
  const expectedOverviewWidth = plotWidth * (6 / (24 * 60));
  const selected = selectBwcShortEventMarkers(overview, { plotWidth });
  assert.equal(BWC_SHORT_EVENT_MAX_WIDTH_PX, 4);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].state, "SEVERE");
  assert.equal(selected[0].durationMs, 6 * 60_000);
  assert.equal(selected[0].timeMs, Date.parse("2026-08-30T09:41:00Z"));
  assert.ok(Math.abs(selected[0].widthPx - expectedOverviewWidth) < 0.001);

  const chart = doc.createElement("div");
  chart.clientWidth = 820;
  chart.clientHeight = 286;
  const tooltip = doc.createElement("div");
  tooltip.hidden = true;
  tooltip.offsetWidth = 230;
  tooltip.offsetHeight = 118;
  const svg = renderBwcHistoryChart(doc, chart, tooltip, overview, { masterDurationMs: 24 * 60 * 60_000 });
  const outline = svg.querySelector(".bwc-history-trace-outline");
  assert.ok(outline, "one outlined heartbeat visually joins the exact retained points");
  assert.equal(Number(outline.getAttribute("data-bwc-trace-segment-count")), 2);
  assert.match(outline.getAttribute("d"), /^M [\d.]+ 135 L [\d.]+ 18 M [\d.]+ 18 L [\d.]+ 135$/);
  assert.doesNotMatch(outline.getAttribute("d"), /\b[HV]\b/);
  assert.ok(svg.querySelector(".bwc-history-trace-moderate"));
  assert.ok(svg.querySelector(".bwc-history-trace-severe"));
  assert.equal(svg.querySelectorAll(".bwc-history-step").length, 0);
  assert.equal(svg.querySelectorAll(".bwc-history-transition").length, 0);
  assert.equal(svg.querySelectorAll(".bwc-history-short-event-marker").length, 0);
  assert.equal(svg.querySelectorAll(".bwc-history-observation-marker").length, 3, "the trace does not fabricate an observation");

  const eventCenterX = EXPECTED_BWC_AXIS_GUTTER_WIDTH
    + ((selected[0].timeMs - dayStart) / (dayEnd - dayStart)) * plotWidth;
  const hitArea = svg.querySelector(".bwc-history-hit-area");
  hitArea.dispatchEvent({
    type: "pointermove", pointerType: "mouse", clientX: eventCenterX, clientY: 18,
  });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children.length, 6);
  assert.equal(tooltip.children[0].textContent, "AHAS RISK EVENT: SEVERE");
  assert.match(tooltip.children[1].textContent, /0938Z.*0944Z/);
  assert.match(tooltip.children[2].textContent, /CDT|CST/);
  assert.equal(tooltip.children[3].textContent, "Duration: 6 MIN");
  assert.equal(tooltip.children[4].textContent, "Source: USAHAS");
  assert.equal(tooltip.children[5].textContent, "Basis: NEXRAD — observed-backed");

  const eventFocus = svg.querySelector(".bwc-history-event-focus-target");
  assert.ok(eventFocus);
  assert.equal(eventFocus.getAttribute("tabindex"), "0");
  assert.equal(eventFocus.getAttribute("data-bwc-event-kind"), "short-event");
  assert.match(eventFocus.getAttribute("aria-label"), /SEVERE.*0938Z.*0944Z.*Duration 6 MIN/);
  eventFocus.dispatchEvent({ type: "focus" });
  assert.equal(tooltip.hidden, false);
  let eventEscapeStopped = false;
  eventFocus.dispatchEvent({
    type: "keydown", key: "Escape",
    stopPropagation() { eventEscapeStopped = true; },
  });
  assert.equal(tooltip.hidden, true);
  assert.equal(eventEscapeStopped, true);
  hitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 71,
    clientX: eventCenterX, clientY: 18,
  });
  hitArea.dispatchEvent({ type: "click", clientX: eventCenterX, clientY: 18 });
  assert.equal(tooltip.hidden, false, "tapping the compact event cue exposes the same exact interval");
  assert.equal(tooltip.children[3].textContent, "Duration: 6 MIN");

  const zoomed = {
    ...overview,
    range: { startMs: moderateStart, endMs: moderateEnd, durationMs: moderateEnd - moderateStart },
  };
  const zoomedSelected = selectBwcShortEventMarkers(zoomed, { plotWidth });
  assert.equal(zoomedSelected.length, 0, "the exact short interval needs no separate metadata cue after it becomes readable");
  const zoomedChart = doc.createElement("div");
  zoomedChart.clientWidth = 820;
  const zoomedSvg = renderBwcHistoryChart(doc, zoomedChart, doc.createElement("div"), zoomed, {
    masterDurationMs: 24 * 60 * 60_000,
  });
  const zoomedTrace = zoomedSvg.querySelector(".bwc-history-trace-outline");
  assert.ok(zoomedTrace);
  assert.equal(Number(zoomedTrace.getAttribute("data-bwc-trace-segment-count")), 2);
  assert.equal(zoomedSvg.querySelectorAll(".bwc-history-short-event-marker").length, 0);
  assert.equal(zoomedSvg.querySelectorAll(".bwc-history-change-marker").length, 0,
    "the heartbeat is not duplicated by a persistent midpoint diamond");
  assert.ok(Number(zoomedSvg.querySelector(".bwc-history-observation-marker").getAttribute("r"))
    > Number(svg.querySelector(".bwc-history-observation-marker").getAttribute("r")),
  "deep zoom makes exact observations more prominent without changing their timestamps");

  const sixHour = {
    ...overview,
    range: {
      startMs: Date.parse("2026-08-30T07:00:00Z"),
      endMs: Date.parse("2026-08-30T13:00:00Z"),
      durationMs: 6 * 60 * 60_000,
    },
  };
  const sixHourChart = doc.createElement("div");
  sixHourChart.clientWidth = 390;
  const sixHourSvg = renderBwcHistoryChart(doc, sixHourChart, doc.createElement("div"), sixHour, {
    masterDurationMs: 24 * 60 * 60_000,
  });
  assert.equal(sixHourSvg.querySelectorAll(".bwc-history-short-event-marker").length, 0,
    "a six-minute event is already visible in the point-to-point trace at physical six-hour zoom");
  assert.equal(sixHourSvg.querySelectorAll(".bwc-history-change-marker").length, 0);
  assert.equal(sixHourSvg.querySelectorAll(".bwc-history-transition").length, 0,
    "barcode-style vertical transition stems are not rendered");
  assert.equal(Number(sixHourSvg.querySelector(".bwc-history-trace-outline").getAttribute("data-bwc-trace-segment-count")), 2);
  assert.ok(Number(sixHourSvg.querySelector(".bwc-history-observation-marker").getAttribute("r")) <= 1.3,
    "routine dots remain subordinate at the physical six-hour zoom");

  const subMinute = {
    ...overview,
    segments: [{ ...runs[1], startMs: severeStart, endMs: severeStart + 30_000 }],
  };
  const longEvent = {
    ...overview,
    segments: [{ ...runs[1], startMs: severeStart, endMs: severeStart + 60 * 60_000 }],
  };
  assert.equal(selectBwcShortEventMarkers(subMinute, { plotWidth })[0].durationMs, 30_000);
  assert.equal(selectBwcShortEventMarkers(longEvent, { plotWidth }).length, 0);
});

test("same-state basis splits remain one truthful visual episode", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const rangeStart = Date.parse("2026-08-30T09:00:00Z");
  const rangeEnd = Date.parse("2026-08-31T09:00:00Z");
  const eventStart = Date.parse("2026-08-30T12:00:00Z");
  const basisChange = eventStart + 3 * 60_000;
  const eventEnd = eventStart + 6 * 60_000;
  const timeline = {
    range: { startMs: rangeStart, endMs: rangeEnd, durationMs: rangeEnd - rangeStart },
    history: { runs: [] },
    segments: [
      {
        kind: "STATE", state: "MODERATE", startMs: eventStart, endMs: basisChange,
        source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
        startReason: "STATE_CHANGE",
      },
      {
        kind: "STATE", state: "MODERATE", startMs: basisChange, endMs: eventEnd,
        source: "USAHAS", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL",
        startReason: "BASIS_CHANGE",
      },
    ],
  };
  const plotWidth = 820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14;
  const events = selectBwcShortEventMarkers(timeline, { plotWidth });
  assert.equal(events.length, 1, "a provenance-only split must not become two BWC events");
  assert.equal(events[0].startMs, eventStart);
  assert.equal(events[0].endMs, eventEnd);
  assert.equal(events[0].durationMs, 6 * 60_000);
  assert.equal(events[0].basisDetails.length, 2);

  const chart = doc.createElement("div");
  chart.clientWidth = 820;
  const tooltip = doc.createElement("div");
  tooltip.hidden = true;
  const svg = renderBwcHistoryChart(doc, chart, tooltip, timeline);
  assert.equal(svg.querySelectorAll(".bwc-history-short-event-marker").length, 0,
    "basis metadata stays accessible without adding a visible glyph to the heartbeat");
  const eventFocus = svg.querySelector(".bwc-history-event-focus-target");
  eventFocus.dispatchEvent({ type: "focus" });
  assert.equal(tooltip.children[5].textContent,
    "Basis: NEXRAD — observed-backed · NEXBAM — model-backed");
  assert.match(eventFocus.getAttribute("aria-label"), /NEXRAD — observed-backed.*NEXBAM — model-backed/);
});

test("dense event and change evidence stays exact without redundant change diamonds", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const rangeStart = Date.parse("2026-08-30T00:00:00Z");
  const rangeEnd = rangeStart + 24 * 60 * 60_000;
  const makeTimeline = (segmentMinutes, segmentCount) => ({
    range: { startMs: rangeStart, endMs: rangeEnd, durationMs: rangeEnd - rangeStart },
    history: { runs: [] },
    segments: Array.from({ length: segmentCount }, (_value, index) => ({
      kind: "STATE",
      state: ["LOW", "MODERATE", "SEVERE"][index % 3],
      startMs: rangeStart + index * segmentMinutes * 60_000,
      endMs: Math.min(rangeEnd, rangeStart + (index + 1) * segmentMinutes * 60_000),
      source: "USAHAS",
      basis: index % 2 ? "NEXBAM" : "NEXRAD",
      basisClass: index % 2 ? "MODEL_OPERATIONAL" : "OBSERVED_OPERATIONAL",
      startReason: index ? "STATE_CHANGE" : "INITIAL",
    })).filter((segment) => segment.endMs > segment.startMs),
  });

  const denseTimeline = makeTimeline(6, 240);
  const plotWidth = 820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14;
  const denseEvents = selectBwcShortEventMarkers(denseTimeline, { plotWidth });
  assert.equal(denseEvents.length, 238, "every fully visible six-minute episode is retained");
  const denseChart = doc.createElement("div");
  denseChart.clientWidth = 820;
  const denseSvg = renderBwcHistoryChart(doc, denseChart, doc.createElement("div"), denseTimeline);
  const eventPaths = denseSvg.querySelectorAll(".bwc-history-short-event-marker");
  assert.equal(eventPaths.length, 0, "dense short events add no visible glyphs over the heartbeat");
  assert.equal(denseSvg.querySelectorAll(".bwc-history-event-focus-target").length, 1);

  const transitionTimeline = makeTimeline(60, 24);
  const transitionChart = doc.createElement("div");
  transitionChart.clientWidth = 820;
  const transitionSvg = renderBwcHistoryChart(doc, transitionChart, doc.createElement("div"), transitionTimeline);
  assert.equal(transitionSvg.querySelectorAll(".bwc-history-short-event-marker").length, 0);
  assert.equal(transitionSvg.querySelectorAll(".bwc-history-change-marker").length, 0,
    "the exact connectors are not double-encoded as midpoint diamonds");
  assert.equal(transitionSvg.querySelectorAll(".bwc-history-transition").length, 0,
    "state changes do not add full-height barcode stems");
  const eventFocus = transitionSvg.querySelector(".bwc-history-event-focus-target");
  assert.ok(eventFocus, "state changes remain keyboard reachable without always-on diamonds");
  assert.match(eventFocus.getAttribute("aria-label"), /BWC state change/);
});

test("exact SVG dots alone own observation-detail tooltips while event markers use interval metadata", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const chart = doc.createElement("div");
  chart.clientWidth = 820;
  chart.clientHeight = 286;
  const tooltip = doc.createElement("div");
  tooltip.hidden = true;
  tooltip.offsetWidth = 230;
  tooltip.offsetHeight = 96;
  const rangeStart = Date.parse("2026-08-30T12:00:00Z");
  const rangeEnd = Date.parse("2026-08-30T14:00:00Z");
  const lowTimes = [
    Date.parse("2026-08-30T12:15:00Z"),
    Date.parse("2026-08-30T12:30:00Z"),
  ];
  const severeTimes = [
    Date.parse("2026-08-30T13:00:00Z"),
    Date.parse("2026-08-30T13:15:00Z"),
  ];
  const timeline = {
    range: { startMs: rangeStart, endMs: rangeEnd, durationMs: rangeEnd - rangeStart },
    history: { runs: [
      {
        kind: "STATE", state: "LOW", firstObservedMs: lowTimes[0], lastObservedMs: lowTimes[1],
        observationsZ: lowTimes.map((timeMs) => new Date(timeMs).toISOString()),
        observationTimesMs: lowTimes, observationsComplete: true, confirmationCount: 2,
        source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
      },
      {
        kind: "STATE", state: "SEVERE", firstObservedMs: severeTimes[0], lastObservedMs: severeTimes[1],
        observationsZ: severeTimes.map((timeMs) => new Date(timeMs).toISOString()),
        observationTimesMs: severeTimes, observationsComplete: true, confirmationCount: 2,
        source: "USAHAS", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL",
      },
    ] },
    segments: [
      {
        kind: "STATE", state: "LOW", startMs: rangeStart, endMs: severeTimes[0],
        source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
      },
      {
        kind: "STATE", state: "SEVERE", startMs: severeTimes[0], endMs: rangeEnd,
        source: "USAHAS", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL",
      },
    ],
  };

  const svg = renderBwcHistoryChart(doc, chart, tooltip, timeline);
  const markers = svg.querySelectorAll(".bwc-history-observation-marker");
  assert.equal(markers.length, 4);
  const first = markers[0];
  const plotLeft = EXPECTED_BWC_AXIS_GUTTER_WIDTH;
  const plotWidth = 820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14;
  const expectedX = plotLeft + ((lowTimes[0] - rangeStart) / (rangeEnd - rangeStart)) * plotWidth;
  assert.equal(Number(first.getAttribute("cx")), expectedX);
  assert.equal(Number(first.getAttribute("cy")), 286 - 34, "LOW marker sits exactly on the categorical LOW level");
  assert.equal(first.getAttribute("data-bwc-observation-ms"), String(lowTimes[0]));
  assert.equal(first.getAttribute("vector-effect"), "non-scaling-stroke");

  const hitArea = svg.querySelector(".bwc-history-hit-area");
  hitArea.dispatchEvent({
    type: "pointermove",
    pointerType: "mouse",
    clientX: Number(first.getAttribute("cx")) + 2,
    clientY: Number(first.getAttribute("cy")) - 2,
  });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children.length, 5, "the detailed tooltip contains only exact observation fields");
  assert.equal(tooltip.children[0].textContent, "AHAS RISK: LOW");
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(lowTimes[0]));
  assert.match(tooltip.children[2].textContent, /CDT|CST/);
  assert.equal(tooltip.children[3].textContent, "Source: USAHAS");
  assert.equal(tooltip.children[4].textContent, "Basis: NEXRAD — observed-backed");
  assert.doesNotMatch(tooltip.textContent, /Observation \d+ of|Exact retained|COVERAGE: UNKNOWN/);
  assert.ok(Number.parseFloat(tooltip.style.left) >= 8);
  assert.ok(Number.parseFloat(tooltip.style.top) >= 8);
  assert.ok(Number.parseFloat(tooltip.style.left) + tooltip.offsetWidth <= chart.clientWidth - 8);
  assert.ok(Number.parseFloat(tooltip.style.top) + tooltip.offsetHeight <= chart.clientHeight - 8);
  const highlight = svg.querySelector(".bwc-history-evidence-highlight");
  assert.equal(highlight.getAttribute("visibility"), "visible");
  assert.equal(highlight.getAttribute("data-bwc-highlight-kind"), "observation");
  assert.ok(Number(highlight.getAttribute("r")) > Number(first.getAttribute("r")), "hover enlarges only the selected exact dot");

  const plateauInspectionMs = Date.parse("2026-08-30T12:45:00Z");
  hitArea.dispatchEvent({
    type: "pointermove",
    pointerType: "mouse",
    clientX: plotLeft + ((plateauInspectionMs - rangeStart) / (rangeEnd - rangeStart)) * plotWidth,
    clientY: Number(first.getAttribute("cy")),
  });
  assert.equal(tooltip.hidden, true, "hovering a horizontal step plateau does not show the detailed tooltip");

  hitArea.dispatchEvent({
    type: "pointermove",
    pointerType: "mouse",
    clientX: plotLeft + plotWidth * 0.6,
    clientY: 120,
  });
  assert.equal(tooltip.hidden, true, "hovering blank chart space does not show the detailed tooltip");
  assert.equal(highlight.getAttribute("visibility"), "hidden");

  const transitionX = plotLeft + ((severeTimes[0] - rangeStart) / (rangeEnd - rangeStart)) * plotWidth;
  hitArea.dispatchEvent({
    type: "pointermove",
    pointerType: "mouse",
    clientX: transitionX,
    clientY: (18 + (286 - 34)) / 2,
  });
  assert.equal(tooltip.hidden, false, "the distinct midpoint cue exposes state-change evidence");
  assert.equal(tooltip.children[0].textContent, "LOW → SEVERE");
  assert.equal(highlight.getAttribute("data-bwc-highlight-kind"), "transition");

  hitArea.dispatchEvent({
    type: "pointermove",
    pointerType: "mouse",
    clientX: transitionX,
    clientY: 18,
  });
  assert.equal(tooltip.children[0].textContent, "AHAS RISK: SEVERE",
    "the exact destination dot remains the sole owner of observation detail");
  assert.equal(highlight.getAttribute("data-bwc-highlight-kind"), "observation");

  hitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 31,
    clientX: transitionX, clientY: (18 + (286 - 34)) / 2,
  });
  hitArea.dispatchEvent({
    type: "click", clientX: transitionX, clientY: (18 + (286 - 34)) / 2,
  });
  assert.equal(tooltip.children[0].textContent, "LOW → SEVERE",
    "tap reaches the same visible transition cue rather than an invisible halo");

  hitArea.dispatchEvent({ type: "keydown", key: "Enter" });
  assert.equal(tooltip.hidden, true, "the chart navigation surface cannot fabricate a keyboard observation");
  hitArea.dispatchEvent({ type: "keydown", key: " " });
  assert.equal(tooltip.hidden, true);

  const focusTarget = svg.querySelector(".bwc-history-observation-focus-target");
  assert.ok(focusTarget, "one bounded focus proxy exposes exact dots to keyboard users");
  assert.equal(focusTarget.getAttribute("tabindex"), "0");
  assert.equal(focusTarget.getAttribute("role"), "button");
  assert.equal(focusTarget.getAttribute("data-bwc-observation-ms"), String(lowTimes[0]));
  focusTarget.dispatchEvent({ type: "focus" });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(lowTimes[0]), "focus shows the exact retained dot time");
  focusTarget.dispatchEvent({ type: "keydown", key: "ArrowRight" });
  assert.equal(focusTarget.getAttribute("data-bwc-observation-ms"), String(lowTimes[1]));
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(lowTimes[1]));
  focusTarget.dispatchEvent({ type: "keydown", key: "End" });
  assert.equal(focusTarget.getAttribute("data-bwc-observation-ms"), String(severeTimes[1]));
  assert.equal(tooltip.children[0].textContent, "AHAS RISK: SEVERE");
  focusTarget.dispatchEvent({ type: "keydown", key: "Home" });
  assert.equal(focusTarget.getAttribute("data-bwc-observation-ms"), String(lowTimes[0]));
  let focusEscapeStopped = false;
  const focusEscape = {
    type: "keydown", key: "Escape",
    stopPropagation() { focusEscapeStopped = true; },
  };
  focusTarget.dispatchEvent(focusEscape);
  assert.equal(tooltip.hidden, true, "Escape dismisses a keyboard tooltip");
  assert.equal(focusEscape.defaultPrevented, true);
  assert.equal(focusEscapeStopped, true, "the first Escape does not bubble through and close the modal");
  let secondFocusEscapeStopped = false;
  const secondFocusEscape = {
    type: "keydown", key: "Escape",
    stopPropagation() { secondFocusEscapeStopped = true; },
  };
  focusTarget.dispatchEvent(secondFocusEscape);
  assert.equal(secondFocusEscape.defaultPrevented, false);
  assert.equal(secondFocusEscapeStopped, false, "a second Escape remains available to close the modal");
  focusTarget.dispatchEvent({ type: "focus" });
  focusTarget.dispatchEvent({ type: "blur" });
  assert.equal(tooltip.hidden, true, "blur dismisses a keyboard tooltip");

  const tapX = Number(first.getAttribute("cx"));
  const tapY = Number(first.getAttribute("cy"));
  hitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 7, clientX: tapX, clientY: tapY,
  });
  hitArea.dispatchEvent({ type: "click", clientX: tapX, clientY: tapY });
  assert.equal(tooltip.hidden, false, "tapping an exact dot shows its detailed tooltip");
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(lowTimes[0]));

  let hitEscapeStopped = false;
  const hitEscape = {
    type: "keydown", key: "Escape",
    stopPropagation() { hitEscapeStopped = true; },
  };
  hitArea.dispatchEvent(hitEscape);
  assert.equal(tooltip.hidden, true);
  assert.equal(hitEscape.defaultPrevented, true);
  assert.equal(hitEscapeStopped, true, "chart navigation Escape dismisses a pinned dot tooltip before modal close");
  const secondHitEscape = { type: "keydown", key: "Escape" };
  hitArea.dispatchEvent(secondHitEscape);
  assert.equal(secondHitEscape.defaultPrevented, false, "the next chart-navigation Escape can reach modal close logic");

  hitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 9, clientX: tapX, clientY: tapY,
  });
  hitArea.dispatchEvent({ type: "click", clientX: tapX, clientY: tapY });
  assert.equal(tooltip.hidden, false);

  hitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 8, clientX: plotLeft + plotWidth * 0.8, clientY: 120,
  });
  hitArea.dispatchEvent({ type: "click", clientX: plotLeft + plotWidth * 0.8, clientY: 120 });
  assert.equal(tooltip.hidden, true, "tapping blank chart space dismisses rather than fabricates metadata");
  assert.equal(svg.children.at(-1).className, "bwc-history-event-focus-target", "state changes have one bounded event focus proxy");
  assert.equal(svg.children.at(-2), focusTarget, "the exact-observation focus proxy stays above the pointer hit surface");
  assert.equal(svg.children.at(-3), hitArea);
  const changeFocus = svg.children.at(-1);
  changeFocus.dispatchEvent({ type: "focus" });
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children[0].textContent, "LOW → SEVERE");
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(severeTimes[0]));
});

test("UNKNOWN coverage bands never expose an observation tooltip without a retained dot", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const chart = doc.createElement("div");
  chart.clientWidth = 820;
  chart.clientHeight = 286;
  const tooltip = doc.createElement("div");
  tooltip.hidden = true;
  const rangeStart = Date.parse("2026-08-30T12:00:00Z");
  const gapStart = Date.parse("2026-08-30T12:30:00Z");
  const gapEnd = Date.parse("2026-08-30T13:30:00Z");
  const rangeEnd = Date.parse("2026-08-30T14:00:00Z");
  const observationTime = Date.parse("2026-08-30T12:15:00Z");
  const svg = renderBwcHistoryChart(doc, chart, tooltip, {
    range: { startMs: rangeStart, endMs: rangeEnd, durationMs: rangeEnd - rangeStart },
    history: { runs: [{
      kind: "STATE", state: "LOW", firstObservedMs: observationTime, lastObservedMs: observationTime,
      observationsZ: [new Date(observationTime).toISOString()], observationTimesMs: [observationTime],
      observationsComplete: true, confirmationCount: 1, source: "USAHAS",
      basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
    }] },
    segments: [
      { kind: "STATE", state: "LOW", startMs: rangeStart, endMs: gapStart, source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL" },
      { kind: "UNKNOWN", startMs: gapStart, endMs: gapEnd, reason: "FRESHNESS_GAP" },
      { kind: "STATE", state: "LOW", startMs: gapEnd, endMs: rangeEnd, source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL" },
    ],
  });
  assert.equal(svg.querySelectorAll(".bwc-history-unknown-band").length, 1);
  const marker = svg.querySelector(".bwc-history-observation-marker");
  const hitArea = svg.querySelector(".bwc-history-hit-area");
  hitArea.dispatchEvent({
    type: "pointermove", pointerType: "mouse",
    clientX: Number(marker.getAttribute("cx")), clientY: Number(marker.getAttribute("cy")),
  });
  assert.equal(tooltip.hidden, false);
  const plotLeft = EXPECTED_BWC_AXIS_GUTTER_WIDTH;
  const plotWidth = 820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14;
  const gapMiddle = (gapStart + gapEnd) / 2;
  hitArea.dispatchEvent({
    type: "pointermove", pointerType: "mouse",
    clientX: plotLeft + ((gapMiddle - rangeStart) / (rangeEnd - rangeStart)) * plotWidth,
    clientY: 120,
  });
  assert.equal(tooltip.hidden, true);
  assert.doesNotMatch(tooltip.textContent, /COVERAGE: UNKNOWN|FRESHNESS GAP/);
});

test("categorical Y-axis keeps a protected invariant gutter and full labels at every chart width", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const startMs = Date.parse("2026-08-30T12:00:00Z");
  const endMs = Date.parse("2026-08-30T14:00:00Z");
  const timeline = {
    range: { startMs, endMs, durationMs: endMs - startMs },
    history: { runs: [] },
    segments: [{
      kind: "STATE", state: "LOW", startMs, endMs, source: "USAHAS",
      basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
    }],
  };

  function renderAtWidth(width) {
    const chart = doc.createElement("div");
    chart.clientWidth = width;
    return renderBwcHistoryChart(doc, chart, doc.createElement("div"), timeline);
  }

  for (const svg of [renderAtWidth(820), renderAtWidth(360), renderAtWidth(253)]) {
    const axis = svg.querySelector(".bwc-history-y-axis");
    assert.ok(axis, "the categorical labels have an explicit protected axis group");
    const plot = svg.querySelector(".bwc-history-plot-background");
    const hitArea = svg.querySelector(".bwc-history-hit-area");
    const labels = axis.querySelectorAll(".bwc-history-axis-label");
    const gridLines = svg.querySelectorAll(".bwc-history-grid-line");

    assert.equal(Number(axis.dataset.bwcAxisGutterWidth), EXPECTED_BWC_AXIS_GUTTER_WIDTH);
    assert.equal(Number(axis.dataset.bwcAxisLabelX), EXPECTED_BWC_AXIS_LABEL_X);
    assert.equal(Number(plot.getAttribute("x")), EXPECTED_BWC_AXIS_GUTTER_WIDTH);
    assert.equal(Number(hitArea.getAttribute("x")), EXPECTED_BWC_AXIS_GUTTER_WIDTH);
    assert.deepEqual(labels.map((label) => label.textContent), ["SEVERE", "MODERATE", "LOW"]);
    assert.ok(labels.every((label) => Number(label.getAttribute("x")) === EXPECTED_BWC_AXIS_LABEL_X));
    assert.ok(labels.every((label) => label.getAttribute("text-anchor") === "end"));
    assert.ok(gridLines.every((line) => Number(line.getAttribute("x1")) === EXPECTED_BWC_AXIS_GUTTER_WIDTH));
  }
});

test("marker geometry remains UTC-anchored across viewport ranges and dense compact rendering keeps every point", () => {
  const view = new FakeEventTarget();
  const doc = new FakeDocument(view);
  const observationTime = Date.parse("2026-08-30T13:00:00Z");
  function renderRange(startZ, endZ, width = 820) {
    const chart = doc.createElement("div");
    chart.clientWidth = width;
    const tooltip = doc.createElement("div");
    const startMs = Date.parse(startZ);
    const endMs = Date.parse(endZ);
    const timeline = {
      range: { startMs, endMs, durationMs: endMs - startMs },
      history: { runs: [{
        kind: "STATE", state: "MODERATE", firstObservedMs: observationTime, lastObservedMs: observationTime,
        observationsZ: [new Date(observationTime).toISOString()], observationTimesMs: [observationTime],
        observationsComplete: true, confirmationCount: 1, source: "USAHAS",
        basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
      }] },
      segments: [{
        kind: "STATE", state: "MODERATE", startMs, endMs, source: "USAHAS",
        basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
      }],
    };
    return renderBwcHistoryChart(doc, chart, tooltip, timeline)
      .querySelector(".bwc-history-observation-marker");
  }
  const full = renderRange("2026-08-30T12:00:00Z", "2026-08-30T14:00:00Z");
  const zoomed = renderRange("2026-08-30T12:00:00Z", "2026-08-30T13:30:00Z");
  const panned = renderRange("2026-08-30T12:30:00Z", "2026-08-30T14:00:00Z");
  assert.equal(Number(full.getAttribute("cx")), EXPECTED_BWC_AXIS_GUTTER_WIDTH + 0.5 * (820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14));
  assert.ok(Math.abs(Number(zoomed.getAttribute("cx"))
    - (EXPECTED_BWC_AXIS_GUTTER_WIDTH + (2 / 3) * (820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14))) < 0.001);
  assert.ok(Math.abs(Number(panned.getAttribute("cx"))
    - (EXPECTED_BWC_AXIS_GUTTER_WIDTH + (1 / 3) * (820 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14))) < 0.001);

  const denseStart = Date.parse("2025-08-30T00:00:00Z");
  const denseEnd = Date.parse("2026-08-30T00:00:00Z");
  const denseTimes = Array.from({ length: 52_560 }, (_value, index) => (
    denseStart + index * 10 * 60_000
  ));
  const compactChart = doc.createElement("div");
  compactChart.clientWidth = 360;
  const compactTooltip = doc.createElement("div");
  const compactSvg = renderBwcHistoryChart(doc, compactChart, compactTooltip, {
    range: { startMs: denseStart, endMs: denseEnd, durationMs: denseEnd - denseStart },
    history: { runs: [{
      kind: "STATE", state: "MODERATE", firstObservedMs: denseTimes[0], lastObservedMs: denseTimes.at(-1),
      observationsZ: denseTimes.map((timeMs) => new Date(timeMs).toISOString()),
      observationTimesMs: denseTimes, observationsComplete: true, confirmationCount: denseTimes.length,
      source: "USAHAS", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL",
    }] },
    segments: [{
      kind: "STATE", state: "MODERATE", startMs: denseStart, endMs: denseEnd,
      source: "USAHAS", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL",
    }],
  });
  const denseMarkers = compactSvg.querySelectorAll(".bwc-history-observation-marker");
  const denseCircles = denseMarkers.filter((marker) => marker.tagName === "CIRCLE");
  const denseBatches = denseMarkers.filter((marker) => marker.tagName === "PATH");
  const colorBatch = denseBatches.find((marker) => marker.dataset.bwcObservationLayer === "color");
  const outlineBatch = denseBatches.find((marker) => marker.dataset.bwcObservationLayer === "outline");
  assert.equal(denseCircles.length, 0, "annual views do not create one DOM node per observation");
  assert.equal(denseBatches.length, 2, "one-state annual evidence uses one outline and one color path");
  assert.equal(Number(colorBatch.dataset.bwcObservationCount), denseTimes.length);
  assert.equal((colorBatch.getAttribute("d").match(/\bM /g) || []).length, denseTimes.length);
  assert.equal((colorBatch.getAttribute("d").match(/ h 0\b/g) || []).length, denseTimes.length);
  assert.equal(colorBatch.getAttribute("stroke-width"), "1.4", "annual dots stay exact but visually subdued");
  assert.equal(outlineBatch.getAttribute("stroke-width"), "2");
  assert.equal(compactSvg.querySelectorAll(".bwc-history-trace").length, 1,
    "annual heartbeat keeps state-color trace DOM bounded");
  assert.equal(compactSvg.querySelectorAll(".bwc-history-trace-outline").length, 1,
    "annual heartbeat uses one shared contrast outline");
  assert.equal(Number(compactSvg.querySelector(".bwc-history-trace-outline")
    .getAttribute("data-bwc-trace-segment-count")), denseTimes.length - 1);
  const denseXs = [...colorBatch.getAttribute("d").matchAll(/\bM ([\d.]+) [\d.]+ h 0/g)]
    .map((match) => Number(match[1]));
  assert.equal(denseXs.length, denseTimes.length);
  assert.ok(denseXs.every((x) => x >= EXPECTED_BWC_AXIS_GUTTER_WIDTH && x <= 346),
    "batched compact markers remain inside the SVG plot without introducing layout width");
  const denseTargetIndex = Math.floor(denseTimes.length / 2);
  const denseTargetX = EXPECTED_BWC_AXIS_GUTTER_WIDTH
    + ((denseTimes[denseTargetIndex] - denseStart) / (denseEnd - denseStart))
      * (360 - EXPECTED_BWC_AXIS_GUTTER_WIDTH - 14);
  const denseTargetY = (18 + (230 - 34)) / 2;
  const denseHitArea = compactSvg.querySelector(".bwc-history-hit-area");
  denseHitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 21,
    clientX: denseTargetX, clientY: denseTargetY,
  });
  denseHitArea.dispatchEvent({ type: "click", clientX: denseTargetX, clientY: denseTargetY });
  assert.equal(compactTooltip.hidden, false, "dense exact-dot tap inspection remains usable");
  assert.equal(compactTooltip.children[1].textContent, expectedZuluTime(denseTimes[denseTargetIndex]));
  const denseFocusTargets = compactSvg.querySelectorAll(".bwc-history-observation-focus-target");
  assert.equal(denseFocusTargets.length, 1, "annual views add one focus node, not one node per observation");
  denseFocusTargets[0].dispatchEvent({ type: "focus" });
  denseFocusTargets[0].dispatchEvent({ type: "keydown", key: "End" });
  assert.equal(denseFocusTargets[0].getAttribute("data-bwc-observation-ms"), String(denseTimes.at(-1)));
  assert.equal(compactTooltip.children[1].textContent, expectedZuluTime(denseTimes.at(-1)));

  denseHitArea.dispatchEvent({
    type: "pointerdown", pointerType: "touch", pointerId: 22, clientX: 200, clientY: 30,
  });
  denseHitArea.dispatchEvent({ type: "click", clientX: 200, clientY: 30 });
  assert.equal(compactTooltip.hidden, true, "dense blank space has no observation tooltip");
});

test("plot-relative pointer ratios exclude the Y-axis gutter and clamp to the visible plot", () => {
  const chart = {
    querySelector(selector) {
      assert.equal(selector, ".bwc-history-hit-area");
      return { getBoundingClientRect() { return { left: 140, width: 600 }; } };
    },
  };
  assert.equal(bwcPlotPointerRatio(chart, { clientX: 140 }), 0);
  assert.equal(bwcPlotPointerRatio(chart, { clientX: 290 }), 0.25);
  assert.equal(bwcPlotPointerRatio(chart, { clientX: 740 }), 1);
  assert.equal(bwcPlotPointerRatio(chart, { clientX: 900 }), 1);
  assert.equal(bwcPlotPointerRatio(null, { clientX: 200 }), null);
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

test("viewport interactions zoom, pan, reset, and keep summaries on the master range", () => {
  assert.match(historyJs, /addEventListener\("wheel",[\s\S]*\{ passive: false \}\)/);
  assert.match(historyJs, /event\.preventDefault\(\)[\s\S]*zoomViewport\(factor, anchor, true\)/);
  assert.match(historyJs, /bwcPlotPointerRatio\(chart, event\)/);
  assert.match(historyJs, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(historyJs, /addEventListener\("pointercancel", endPan\)/);
  assert.match(historyJs, /addEventListener\("lostpointercapture", endPan\)/);
  assert.match(historyJs, /panViewport\(-\(deltaX \/ panSession\.plotWidth\) \* timeDomain\.durationMs, true\)/);
  assert.match(historyJs, /viewportRenderQueued[\s\S]*requestAnimationFrame/);
  assert.match(historyJs, /zoomResetButton\.addEventListener\("click", resetViewport\)/);
  assert.match(historyJs, /timeDomain = null;[\s\S]*render\(true\)/);
  assert.match(historyJs, /calculateBwcStatistics\(masterTimeline\)/);
  assert.match(historyJs, /renderLastChange\(doc, lastChange, masterTimeline\)/);
  assert.match(historyJs, /renderChartViewport\(nowMs\)/);
});

test("chart rendering is dependency-free SVG with exact-state and bounded evidence interaction", () => {
  assert.match(historyJs, /createElementNS\(SVG_NS, name\)/);
  assert.match(historyJs, /createSvgElement\(doc, "svg"/);
  assert.match(historyJs, /createSvgElement\(doc, "path"/);
  assert.match(historyJs, /bwc-history-unknown-band/);
  assert.match(historyJs, /selectBwcUtcTicks\(timeline\.range/);
  assert.match(historyJs, /selectBwcShortEventMarkers\(timeline/);
  assert.match(historyJs, /buildBwcObservationTracePaths\(observations, timeline/);
  assert.match(historyJs, /bwc-history-trace-outline/);
  assert.match(historyJs, /bwc-history-trace-/);
  assert.doesNotMatch(historyJs, /class:\s*"bwc-history-transition"/);
  assert.doesNotMatch(historyJs, /class:\s*`bwc-history-step/);
  assert.doesNotMatch(historyJs, /class:\s*`bwc-history-short-event-marker/);
  assert.doesNotMatch(historyJs, /bwc-history-change-marker/);
  assert.match(historyJs, /selectBwcObservationMarkers\(timeline\)/);
  assert.match(historyJs, /createSvgElement\(doc, "circle"/);
  assert.match(historyJs, /bwc-history-observation-marker/);
  assert.match(historyJs, /bwc-history-observation-focus-target/);
  assert.match(historyJs, /bwc-history-event-focus-target/);
  assert.match(historyJs, /`M \$\{svgCoordinate\(x1\)\} \$\{svgCoordinate\(fromY\)\} L \$\{svgCoordinate\(x2\)\} \$\{svgCoordinate\(toY\)\}`/);
  assert.match(historyJs, /addEventListener\("pointermove"/);
  assert.match(historyJs, /addEventListener\("click"/);
  assert.doesNotMatch(historyJs, /const timelineSegment = findTimelineSegmentAt/);
  assert.doesNotMatch(historyJs, /Exact retained observation timestamp|Observation \$\{/);
  assert.match(historyJs, /America\/Chicago|formatBwcMemphisTime/);
  assert.doesNotMatch(historyJs, /(?:from\s+["']d3|\bnew\s+Chart\s*\(|from\s+["']chart\.js|highcharts|plotly)/i);
});

test("modal styling stays fixed, internally scrollable, touch friendly, and responsive", () => {
  assert.match(historyCss, /\.bwc-history-overlay\{[\s\S]*position:fixed/);
  assert.match(historyCss, /\.bwc-history-body\{[\s\S]*overflow:auto/);
  assert.match(historyCss, /touch-action:manipulation/);
  assert.match(historyCss, /\.bwc-history-chart\{[\s\S]*touch-action:pan-y/);
  assert.match(historyCss, /\.bwc-history-zoom-button\{[\s\S]*min-width:34px[\s\S]*min-height:30px/);
  assert.match(historyCss, /@media \(max-width:700px\)\{[\s\S]*\.bwc-history-zoom-button\{min-width:42px;min-height:42px/);
  assert.match(historyCss, /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{[\s\S]*\.bwc-history-zoom-button\{min-width:38px;min-height:38px/);
  assert.match(historyCss, /overflow-x:hidden/);
  assert.match(historyCss, /@media \(max-width:700px\)/);
  assert.match(historyCss, /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)/);
  assert.match(historyCss, /@media \(max-width:700px\)\{[\s\S]*?\.bwc-history-panel\{\s*width:100%;/);
  assert.match(historyCss, /@media \(max-width:950px\) and \(max-height:520px\) and \(orientation:landscape\)\{[\s\S]*?\.bwc-history-panel\{width:100%;/);
  assert.match(historyCss, /@media \(max-width:700px\) and \(orientation:landscape\)/);
  assert.match(historyCss, /\.bwc-history-range-strip\{[\s\S]*overflow-x:auto/);
  assert.match(historyCss, /\.bwc-history-chart\{[\s\S]*min-width:0/);
  assert.match(historyCss, /\.bwc-history-observation-marker\{[\s\S]*pointer-events:none/);
  assert.match(historyCss, /\.bwc-history-observation-focus-target\{[\s\S]*pointer-events:none/);
  assert.match(historyCss, /\.bwc-history-event-focus-target\{[\s\S]*pointer-events:none/);
  assert.match(historyCss, /\.bwc-history-trace-outline,[\s\S]*\.bwc-history-trace\{[\s\S]*stroke-linecap:round;[\s\S]*stroke-linejoin:round/);
  assert.match(historyCss, /\.bwc-history-trace\{stroke-width:3\.4;opacity:\.98\}/);
  assert.match(historyCss, /\.bwc-history-trace-low\{stroke:#42e36f\}/);
  assert.match(historyCss, /\.bwc-history-trace-moderate\{stroke:#ffd34d\}/);
  assert.match(historyCss, /\.bwc-history-trace-severe\{stroke:#ff4d55\}/);
  assert.doesNotMatch(historyCss, /\.bwc-history-(?:step|transition|short-event-marker)(?:\{|[-])/);
  assert.match(historyCss, /\.bwc-history-observation-marker\{[\s\S]*opacity:\.72/);
  assert.match(historyCss, /\.bwc-history-detail-zoom \.bwc-history-observation-marker\{opacity:\.9\}/);
  assert.match(historyCss, /\.bwc-history-time-grid-line\{stroke:rgba\(207,224,216,\.07\)/);
  assert.match(historyCss, /\.bwc-history-analysis\{[\s\S]*min-width:0;[\s\S]*max-width:100%/);
  assert.match(historyCss, /\.bwc-history-summary-content\{[\s\S]*max-width:calc\(100% - 18px\);[\s\S]*overflow:auto/);
  assert.match(historyCss, /\.bwc-history-summary-table\{[\s\S]*min-width:800px/);
  assert.match(historyCss, /\.bwc-history-summary-table thead th\{position:sticky;top:0;z-index:1\}/);
  assert.doesNotMatch(historyCss, /\.bwc-history-summary-table th\{\s*position:sticky/);
  assert.match(historyCss, /@media \(max-width:700px\)\{[\s\S]*\.bwc-history-export-button,\.bwc-history-summary-tab\{min-height:42px/);
  assert.match(historyCss, /body\.getac-preset \.bwc-history-export-button,[\s\S]*min-height:40px/);
  assert.doesNotMatch(historyCss, /bwc-history-(?:analysis|summary|export)[^{]*\{[^}]*100vw/);
  assert.doesNotMatch(historyCss, /width:\s*\d{4,}px/);
});

test("BWC history assets are included as modules without changing aviation lookup", () => {
  assert.match(indexHtml, /<link rel="stylesheet" href="\.\/bwc-history\.css"\s*\/?>/);
  assert.match(indexHtml, /<script type="module" src="\.\/bwc-history\.js"><\/script>/);
  assert.doesNotMatch(historyJs, /aviationWeather|lookupAviationWeather/);
});
