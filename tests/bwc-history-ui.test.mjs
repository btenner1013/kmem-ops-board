import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyBwcHistoryDialogState,
  availabilityLines,
  bwcPlotPointerRatio,
  createBwcHistoryLoader,
  findTimelineSegmentAt,
  formatCurrentBwc,
  historyFailureArchiveMessage,
  initializeBwcHistory,
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
}

class FakeDocument extends FakeEventTarget {
  constructor(view) {
    super();
    this.defaultView = view;
    this.baseURI = "https://example.test/board/index.html";
    this.elements = new Map();
    this.rangeButtons = [];
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
  querySelectorAll(selector) { return selector === "[data-bwc-range]" ? this.rangeButtons : []; }
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
  view.fetch = async () => ({ ok: true, async json() { return archive; } });

  const doc = new FakeDocument(view);
  for (const id of [
    "bwcHistoryOverlay", "bwcHistoryPanel", "bwcHistoryCloseButton", "bwcHistoryStatus",
    "bwcHistoryChart", "bwcHistoryTooltip", "bwcHistoryCurrent", "bwcHistoryLastChange",
    "bwcHistoryStats", "bwcHistoryArchive", "bwcHistoryLegend", "bwcHistoryZoomOut",
    "bwcHistoryZoomIn", "bwcHistoryZoomReset", "bwcHistoryZoomStatus",
  ]) doc.register(id, id.includes("Button") || id.includes("Zoom") && id !== "bwcHistoryZoomStatus" ? "button" : "div");
  doc.getElementById("bwcHistoryOverlay").hidden = true;
  doc.getElementById("bwcHistoryTooltip").hidden = true;
  doc.getElementById("bwcHistoryChart").clientWidth = 820;
  doc.getElementById("bwcHistoryChart").clientHeight = 286;
  doc.getElementById("bwcHistoryTooltip").offsetWidth = 230;
  doc.getElementById("bwcHistoryTooltip").offsetHeight = 96;
  for (const range of ["24h", "7d"]) {
    const button = doc.createElement("button");
    button.dataset.bwcRange = range;
    doc.rangeButtons.push(button);
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
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`));
  }
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
  const { doc } = behavioralBwcFixture();
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
  const initial = controller.timeDomain;
  const initialStatistics = stats.textContent;
  assert.equal(initial.ok, true);
  assert.equal(initial.isFullRange, true);
  assert.equal(initial.durationMs, 24 * 60 * 60 * 1000);
  assert.equal(Number(chart.dataset.bwcMasterEndMs) - Number(chart.dataset.bwcMasterStartMs), initial.durationMs);
  assert.equal(Number(chart.dataset.bwcVisibleDurationMs), initial.durationMs);

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
  const inspectedMs = wheelDomain.startMs + wheelDomain.durationMs * tooltipRatio;
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.children[0].textContent, "AHAS RISK: MODERATE");
  assert.equal(tooltip.children[1].textContent, expectedZuluTime(inspectedMs));
  assert.match(tooltip.textContent, /NEXBAM — model-backed/);

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
  assert.match(historyJs, /event\.preventDefault\(\)[\s\S]*zoomViewport\(factor, anchor\)/);
  assert.match(historyJs, /bwcPlotPointerRatio\(chart, event\)/);
  assert.match(historyJs, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(historyJs, /addEventListener\("pointercancel", endPan\)/);
  assert.match(historyJs, /addEventListener\("lostpointercapture", endPan\)/);
  assert.match(historyJs, /panViewport\(-\(deltaX \/ panSession\.plotWidth\) \* timeDomain\.durationMs\)/);
  assert.match(historyJs, /zoomResetButton\.addEventListener\("click", resetViewport\)/);
  assert.match(historyJs, /timeDomain = null;[\s\S]*render\(true\)/);
  assert.match(historyJs, /calculateBwcStatistics\(masterTimeline\)/);
  assert.match(historyJs, /renderLastChange\(doc, lastChange, masterTimeline\)/);
  assert.match(historyJs, /renderChartViewport\(nowMs\)/);
});

test("chart rendering is dependency-free SVG with unknown gaps and pointer/tap inspection", () => {
  assert.match(historyJs, /createElementNS\(SVG_NS, name\)/);
  assert.match(historyJs, /createSvgElement\(doc, "svg"/);
  assert.match(historyJs, /createSvgElement\(doc, "path"/);
  assert.match(historyJs, /bwc-history-unknown-band/);
  assert.match(historyJs, /selectBwcUtcTicks\(timeline\.range/);
  assert.match(historyJs, /bwc-history-transition/);
  assert.match(historyJs, /`M \$\{svgCoordinate\(x1\)\} \$\{svgCoordinate\(y\)\} H \$\{svgCoordinate\(x2\)\}`/);
  assert.match(historyJs, /addEventListener\("pointermove"/);
  assert.match(historyJs, /addEventListener\("click"/);
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
