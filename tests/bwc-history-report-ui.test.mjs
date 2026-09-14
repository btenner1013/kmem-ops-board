import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildBwcReportModel } from "../bwc-history-report-core.js";
import { buildBwcReportHtml, initializeBwcHistoryReport } from "../bwc-history-report.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const reportCss = readFileSync(new URL("../bwc-history-report.css", import.meta.url), "utf8");

function emptyArchive() {
  return {
    schemaVersion: 1,
    station: "KMEM",
    product: "USAHAS_AHAS_RISK",
    sourceArea: { type: "ICAO", name: "MEMPHIS INTL" },
    sourceTimestampField: "DateTime",
    retentionDays: 365,
    continuityMinutes: 90,
    collectionStartedZ: null,
    archiveUpdatedZ: null,
    runs: [],
  };
}

function shortSyntheticArchive(cutoff) {
  const start = cutoff - 7 * 24 * 60 * 60 * 1000;
  const last = cutoff - 60 * 1000;
  return {
    ...emptyArchive(),
    collectionStartedZ: new Date(start).toISOString(),
    archiveUpdatedZ: new Date(last).toISOString(),
    runs: [{
      kind: "STATE", state: "MODERATE", rawAhasRisk: "MODERATE",
      startZ: new Date(start).toISOString(), firstObservedZ: new Date(start).toISOString(),
      lastObservedZ: new Date(last).toISOString(), firstRecordedZ: new Date(start).toISOString(),
      lastRecordedZ: new Date(last).toISOString(), confirmationCount: 2,
      startReason: "ARCHIVE_START", source: "USAHAS", basis: "NEXRAD", basisClass: "OBSERVED_OPERATIONAL",
    }],
  };
}

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) {
    event.target ||= this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
  }
}

class FakeElement extends Events {
  constructor(doc, tag = "div") {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.attributes = new Map();
    this.children = [];
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    if (selector !== "button,input") return [];
    return this.ownerDocument.controls.filter((item) => item.tagName === "BUTTON" || item.tagName === "INPUT");
  }
}

class FakeDocument extends Events {
  constructor(view) {
    super();
    this.defaultView = view;
    this.elements = new Map();
    this.controls = [];
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
  }
  register(id, tag = "div") {
    const element = new FakeElement(this, tag);
    element.id = id;
    this.elements.set(id, element);
    if (tag === "button" || tag === "input") this.controls.push(element);
    return element;
  }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelectorAll(selector) {
    if (selector === "[name='bwcReportRange']") return this.rangeInputs;
    return [];
  }
}

function controllerFixture() {
  const view = new Events();
  view.printCount = 0;
  view.print = () => { view.printCount += 1; };
  view.requestAnimationFrame = (callback) => { callback(); return 1; };
  const doc = new FakeDocument(view);
  const tags = {
    bwcHistoryPrintReport: "button", bwcReportSetupClose: "button", bwcReportSetupForm: "form",
    bwcReportStartDate: "input", bwcReportEndDate: "input", bwcReportSetupCancel: "button",
    bwcReportPreviewBack: "button", bwcReportPreviewPrint: "button",
  };
  for (const id of [
    "bwcHistoryPrintReport", "bwcReportSetupOverlay", "bwcReportSetupPanel", "bwcReportSetupClose", "bwcReportSetupForm",
    "bwcReportCustomFields", "bwcReportStartDate", "bwcReportEndDate", "bwcReportRangePreview", "bwcReportSetupStatus",
    "bwcReportSetupCancel", "bwcReportPreview", "bwcReportPreviewBack", "bwcReportPreviewPrint", "bwcReportPages", "bwcHistoryPanel",
    "bwcReportComparison", "bwcReportAppendix",
  ]) doc.register(id, tags[id] || (id === "bwcReportComparison" || id === "bwcReportAppendix" ? "input" : "div"));
  doc.getElementById("bwcReportSetupOverlay").hidden = true;
  doc.getElementById("bwcReportPreview").hidden = true;
  doc.rangeInputs = ["24h", "7d", "30d", "90d", "365d", "custom"].map((value) => {
    const input = doc.register(`range-${value}`, "input");
    input.value = value;
    input.checked = value === "7d";
    return input;
  });
  const now = Date.parse("2026-08-31T15:00:00Z");
  const liveState = { range: "24h", zoomStart: 111, zoomEnd: 222, scrollTop: 333 };
  const controller = initializeBwcHistoryReport(doc, { getHistory: emptyArchive, getNowMs: () => now });
  return { controller, doc, view, liveState, now };
}

test("BWC header exposes a dedicated disabled-until-ready print report action", () => {
  assert.match(indexHtml, /id="bwcHistoryPrintReport"[^>]*disabled[^>]*>🖨️ PRINT REPORT</u);
  assert.match(indexHtml, /id="bwcReportSetupPanel"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(indexHtml, /name="bwcReportRange" value="7d" checked/);
  for (const value of ["24h", "7d", "30d", "90d", "365d", "custom"]) {
    assert.match(indexHtml, new RegExp(`name="bwcReportRange" value="${value}"`));
  }
  assert.match(indexHtml, /START DATE · AMERICA\/CHICAGO/);
  assert.match(indexHtml, /FINAL DATE · AMERICA\/CHICAGO/);
  assert.match(indexHtml, /COMPARE PRECEDING EQUAL PERIOD/);
  assert.match(indexHtml, /INCLUDE DAILY DETAIL APPENDIX/);
});

test("report stylesheet isolates a white Letter-landscape native-print view", () => {
  assert.match(reportCss, /@page\{size:letter landscape;margin:/);
  assert.match(reportCss, /body\.bwc-report-printing>\*:not\(#bwcReportPreview\)\{display:none!important\}/);
  assert.match(reportCss, /background:#fff!important/);
  assert.match(reportCss, /thead\{display:table-header-group\}/);
  assert.match(reportCss, /break-inside:avoid-page/);
  assert.match(reportCss, /bwc-report-page:last-child\{break-after:auto/);
});

test("print report HTML contains two denominators, explicit unknown, hourly coverage, and methodology", () => {
  const cutoff = Date.parse("2026-08-31T15:00:00Z");
  const model = buildBwcReportModel(emptyArchive(), { selection: { key: "7d" }, cutoff, preparedAt: cutoff });
  const html = buildBwcReportHtml(model);
  assert.match(html, /KMEM BIRD-ACTIVITY RISK REVIEW/);
  assert.match(html, /% OF KNOWN COVERED TIME/);
  assert.match(html, /% OF FULL SELECTED ELAPSED PERIOD/);
  assert.match(html, /UNKNOWN/);
  assert.match(html, /TIME-OF-DAY ANALYSIS/);
  assert.match(html, /SEV \/ KNOWN/);
  assert.match(html, /DATES/);
  assert.match(html, /configured 90-minute continuity\/carry-forward limit/);
  assert.match(html, /does not estimate bird counts, strike probability/);
  assert.equal((html.match(/data-bwc-report-page=/g) || []).length, 2);
  assert.doesNotMatch(html, /safe flying window/i);
});

test("long reports reuse seasonal summaries without claiming an unsupported pattern", () => {
  const cutoff = Date.parse("2026-08-31T15:00:00Z");
  const model = buildBwcReportModel(shortSyntheticArchive(cutoff), { selection: { key: "365d" }, cutoff, preparedAt: cutoff });
  const html = buildBwcReportHtml(model);
  assert.match(html, /SEASONAL SUMMARY/);
  assert.match(html, /SUMMER 2026/);
  assert.match(html, /NO SEASONAL PATTERN IS CLAIMED/);
  assert.match(html, /PARTIAL/);
  assert.match(html, /OBSERVED_<wbr>OPERATIONAL/);
  assert.doesNotMatch(buildBwcReportHtml(buildBwcReportModel(emptyArchive(), { selection: { key: "7d" }, cutoff, preparedAt: cutoff })), /SEASONAL SUMMARY/);
});

test("setup stays independent from live BWC range/zoom and defaults to seven days", () => {
  const { controller, doc, liveState } = controllerFixture();
  assert.ok(controller);
  assert.equal(doc.getElementById("bwcHistoryPrintReport").disabled, true);
  controller.setHistoryAvailable(true);
  assert.equal(doc.getElementById("bwcHistoryPrintReport").disabled, false);
  assert.equal(controller.openSetup(), true);
  assert.equal(doc.getElementById("bwcReportSetupOverlay").hidden, false);
  assert.equal(doc.rangeInputs.find((input) => input.checked).value, "7d");
  assert.match(doc.getElementById("bwcReportRangePreview").textContent, /7 DAYS/);
  assert.deepEqual(liveState, { range: "24h", zoomStart: 111, zoomEnd: 222, scrollTop: 333 });
});

test("preview freezes one model, invokes native print, and close restores live state", () => {
  const { controller, doc, view, liveState, now } = controllerFixture();
  controller.setHistoryAvailable(true);
  controller.openSetup();
  doc.getElementById("bwcReportSetupForm").dispatchEvent({ type: "submit" });
  assert.ok(controller.frozenModel);
  assert.equal(controller.frozenModel.preparedAtMs, now);
  assert.equal(controller.frozenModel.range.durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(doc.getElementById("bwcReportPreview").hidden, false);
  assert.match(doc.getElementById("bwcReportPages").innerHTML, /BIRD-ACTIVITY RISK REVIEW/);
  controller.printReport();
  assert.equal(view.printCount, 1);
  assert.equal(doc.body.classList.contains("bwc-report-printing"), true);
  view.dispatchEvent({ type: "afterprint" });
  assert.equal(doc.body.classList.contains("bwc-report-printing"), false);
  assert.ok(controller.frozenModel, "afterprint returns to the same frozen preview");
  controller.closePreview();
  assert.equal(controller.frozenModel, null);
  assert.equal(doc.getElementById("bwcReportPreview").hidden, true);
  assert.deepEqual(liveState, { range: "24h", zoomStart: 111, zoomEnd: 222, scrollTop: 333 });
  assert.equal(doc.getElementById("bwcHistoryPanel").inert, false);
});

test("browser-menu or keyboard printing isolates an open frozen report", () => {
  const { controller, doc, view } = controllerFixture();
  controller.setHistoryAvailable(true);
  controller.openSetup();
  doc.getElementById("bwcReportSetupForm").dispatchEvent({ type: "submit" });
  assert.equal(doc.body.classList.contains("bwc-report-printing"), false);
  doc.getElementById("bwcReportPreview").scrollTop = 91;
  doc.getElementById("bwcReportPreview").scrollLeft = 117;
  view.dispatchEvent({ type: "beforeprint" });
  assert.equal(doc.body.classList.contains("bwc-report-printing"), true);
  assert.equal(doc.getElementById("bwcReportPreview").scrollTop, 0);
  assert.equal(doc.getElementById("bwcReportPreview").scrollLeft, 0);
  view.dispatchEvent({ type: "beforeprint" });
  view.dispatchEvent({ type: "afterprint" });
  assert.equal(doc.body.classList.contains("bwc-report-printing"), false);
  assert.equal(doc.getElementById("bwcReportPreview").scrollTop, 91);
  assert.equal(doc.getElementById("bwcReportPreview").scrollLeft, 117);
  controller.closePreview();
  view.dispatchEvent({ type: "beforeprint" });
  assert.equal(doc.body.classList.contains("bwc-report-printing"), false);
});

test("setup cancel performs no calculation or live-state mutation", () => {
  const { controller, doc, liveState } = controllerFixture();
  controller.setHistoryAvailable(true);
  controller.openSetup();
  controller.closeSetup();
  assert.equal(doc.getElementById("bwcReportSetupOverlay").hidden, true);
  assert.equal(controller.frozenModel, null);
  assert.deepEqual(liveState, { range: "24h", zoomStart: 111, zoomEnd: 222, scrollTop: 333 });
});

test("future-clipped custom range is disclosed before preview", () => {
  const { controller, doc } = controllerFixture();
  controller.setHistoryAvailable(true);
  controller.openSetup();
  for (const input of doc.rangeInputs) input.checked = input.value === "custom";
  doc.getElementById("bwcReportStartDate").value = "2026-08-30";
  doc.getElementById("bwcReportEndDate").value = "2026-09-03";
  const resolved = controller.updateRangePreview();
  assert.equal(resolved.futureClipped, true);
  assert.match(doc.getElementById("bwcReportRangePreview").textContent, /FUTURE\/UNELAPSED TIME CLIPPED/);
});
