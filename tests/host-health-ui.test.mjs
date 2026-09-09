import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyHostHealthDialogState,
  createHostHealthLoader,
  hostHealthChartInteractionMode,
  hostHealthFocusableElements,
  hostHealthLastSwitchPresentation,
  hostHealthOperatorEventPresentation,
  hostHealthOperatorSummary,
  hostHealthStatePresentation,
  renderHostHealthChart,
  renderOperatorHostCard,
  selectHostHealthEventLogItems,
  selectHostHealthOperatorEvents,
} from "../host-health.js";
import { buildHostHealthTimeline, getHostHealthRange } from "../host-health-core.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../host-health.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../host-health.js", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

class FakeNode {
  constructor(tagName = "") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this._text = "";
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text; }
  set textContent(value) { this.children = []; this._text = String(value ?? ""); }
  appendChild(child) { child.parentNode?.removeChild?.(child); child.parentNode = this; this.children.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(child); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); child.parentNode = null; return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, callback) { const entries = this.listeners.get(type) || []; entries.push(callback); this.listeners.set(type, entries); }
  dispatch(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback({ target: this, currentTarget: this, ...event }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 286, right: 960, bottom: 286 }; }
}

class FakeDocument {
  createElement(tagName) { return new FakeNode(tagName); }
  createElementNS(_namespace, tagName) { return new FakeNode(tagName); }
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function history() {
  return {
    schemaVersion: 1,
    archiveStartedUtc: "2026-09-08T10:00:00Z",
    coverageStartUtc: "2026-09-08T10:00:00Z",
    updatedUtc: "2026-09-09T10:00:00Z",
    intervals: [
      { track: "PRIMARY_HEALTH", host: "PRIMARY", state: "STALE", startUtc: "2026-09-09T08:02:00Z", endUtc: null, reason: "HEARTBEAT STALE" },
      { track: "BACKUP_HEALTH", host: "BACKUP", state: "HEALTHY", startUtc: "2026-09-08T10:00:00Z", endUtc: null, reason: "CURRENT" },
      { track: "PUBLISHER", state: "BACKUP", startUtc: "2026-09-09T08:14:00Z", endUtc: null, reason: "TAKEOVER", publisher: "BACKUP" },
      { track: "BOARD_DELIVERY", state: "CONTINUOUS", startUtc: "2026-09-08T10:00:00Z", endUtc: null, reason: "CONTINUOUS" },
    ],
    events: [{ eventType: "BACKUP_TAKEOVER", timestampUtc: "2026-09-09T08:14:00Z", host: "BACKUP", publisher: "BACKUP", reason: "PRIMARY HEARTBEAT STALE" }],
  };
}

test("🫀 quick link and complete accessible modal are integrated without an operational control surface", () => {
  assert.match(indexHtml, /hostHealth\.id="hostHealthButton"[\s\S]*?hostHealth\.title="Host Health"[\s\S]*?hostHealth\.textContent="🫀"/);
  for (const id of [
    "hostHealthOverlay", "hostHealthPanel", "hostHealthCloseButton", "hostHealthStatus", "hostHealthOperatorSummary",
    "hostHealthPrimarySummary", "hostHealthBackupSummary", "hostHealthLastSwitch", "hostHealthImportantEvents",
    "hostHealthHistorySection", "hostHealthTechnicalSection", "hostHealthActivePublisher",
    "hostHealthBoardDelivery", "hostHealthPrimary", "hostHealthBackup", "hostHealthLease", "hostHealthChart",
    "hostHealthTooltip", "hostHealthZoomOut", "hostHealthZoomIn", "hostHealthZoomReset", "hostHealthZoomStatus",
    "hostHealthMetrics", "hostHealthEvents", "hostHealthArchive",
  ]) assert.match(indexHtml, new RegExp(`id="${id}"`), id);
  assert.match(indexHtml, /WHO IS UPDATING THE BOARD\?/);
  assert.match(indexHtml, /READ ONLY · THIS PAGE CANNOT CHANGE PUBLISHER OR FAILOVER/);
  assert.match(indexHtml, /role="dialog" aria-modal="true"/);
  assert.doesNotMatch(indexHtml.slice(indexHtml.indexOf('id="hostHealthOverlay"'), indexHtml.indexOf('id="aviationWeatherLookupOverlay"')), /Force PRIMARY|Force BACKUP|Acquire lease|Release lease|Restart updater|Reset heartbeat/i);
});

test("default view is operator-first while history and engineering telemetry are collapsed", () => {
  assert.match(indexHtml, /<details id="hostHealthHistorySection" class="host-health-disclosure">/);
  assert.match(indexHtml, /<details id="hostHealthTechnicalSection" class="host-health-disclosure host-health-technical-disclosure">/);
  assert.doesNotMatch(indexHtml, /<details[^>]+hostHealth(?:History|Technical)Section[^>]+open/);
  const defaultSurface = indexHtml.slice(indexHtml.indexOf('id="hostHealthOperatorSummary"'), indexHtml.indexOf('id="hostHealthHistorySection"'));
  assert.match(defaultSurface, /hostHealthPrimarySummary/);
  assert.match(defaultSurface, /hostHealthBackupSummary/);
  assert.match(defaultSurface, /hostHealthLastSwitch/);
  assert.doesNotMatch(defaultSurface, /SOURCE SHA|LEASE|RELIABILITY|EVENT LOG/);
  const technicalSurface = indexHtml.slice(indexHtml.indexOf('id="hostHealthTechnicalSection"'), indexHtml.indexOf('id="aviationWeatherLookupOverlay"'));
  assert.match(technicalSurface, /hostHealthLease/);
  assert.match(technicalSurface, /hostHealthMetrics/);
  assert.match(technicalSurface, /hostHealthEvents/);
  const operatorRenderer = source.slice(source.indexOf("function renderOperatorSummary"), source.indexOf("function renderPublisherCard"));
  assert.match(operatorRenderer, /BOARD IS UP TO DATE|STANDING BY/);
  assert.doesNotMatch(operatorRenderer, /SOURCE SHA|ACTIVE OWNER|HEALTH REASON|LAST ERROR/);
  assert.match(source, /querySelectorAll\("summary,button:not\(\[disabled\]\)/);
  assert.match(source, /item\.tagName === "SUMMARY"[\s\S]*details:not\(\[open\]\)/);
});

test("plain-language operator verdict prioritizes board delivery over preferred host role", () => {
  assert.deepEqual(hostHealthOperatorSummary({ boardDelivery: "CONTINUOUS", publisher: "PRIMARY" }), {
    tone: "ok", icon: "🟢", headline: "BOARD IS UP TO DATE", publisher: "PRIMARY",
    message: "PRIMARY is updating the board. BACKUP is standing by.",
  });
  assert.deepEqual(hostHealthOperatorSummary({ boardDelivery: "CONTINUOUS", publisher: "BACKUP" }), {
    tone: "ok", icon: "🟢", headline: "BOARD IS UP TO DATE", publisher: "BACKUP",
    message: "BACKUP is keeping the board updated while PRIMARY is not publishing.",
  });
  assert.equal(hostHealthOperatorSummary({ boardDelivery: "DELAYED", publisher: "BACKUP" }).headline, "BOARD UPDATE IS RUNNING LATE");
  assert.equal(hostHealthOperatorSummary({ boardDelivery: "DELAYED", publisher: "BACKUP" }).message,
    "BACKUP is the active updater, but its latest board update is late.");
  assert.equal(hostHealthOperatorSummary({ boardDelivery: "GAP", publisher: "UNKNOWN" }).headline, "BOARD HAS NOT UPDATED RECENTLY");
  assert.equal(hostHealthOperatorSummary({ boardDelivery: "GAP", publisher: "PRIMARY" }).message,
    "No recent board update has been received. Last known publisher: PRIMARY.");
  assert.equal(hostHealthOperatorSummary({ boardDelivery: "UNKNOWN", publisher: "UNKNOWN" }).headline, "BOARD STATUS IS UNKNOWN");
});

test("important activity removes cadence chatter without hiding operational incidents", () => {
  const events = [
    ["BACKUP_DELAYED", 1], ["BACKUP_DELAY_RECOVERED", 2], ["BOARD_DELAYED", 3], ["BOARD_DELAY_RECOVERED", 4],
    ["ACTIVE_BACKUP", 5], ["LEASE_ACQUIRED", 6], ["PRIMARY_STALE", 7], ["BOARD_PUBLISH_GAP", 8],
    ["BACKUP_TAKEOVER", 9], ["BOARD_PUBLISH_RECOVERED", 10], ["PRIMARY_RECOVERED", 11], ["PRIMARY_HANDOFF", 12],
  ].map(([eventType, minute]) => ({ eventType, timestampMs: minute * 60_000 }));
  assert.deepEqual(selectHostHealthOperatorEvents(events).map((event) => event.eventType), [
    "PRIMARY_HANDOFF", "PRIMARY_RECOVERED", "BOARD_PUBLISH_RECOVERED", "BACKUP_TAKEOVER", "BOARD_PUBLISH_GAP", "PRIMARY_STALE",
  ]);
  assert.equal(selectHostHealthOperatorEvents(events, 3).length, 3);
  assert.deepEqual(hostHealthOperatorEventPresentation({ eventType: "PRIMARY_STALE" }), {
    label: "PRIMARY STOPPED CHECKING IN", description: "PRIMARY exceeded the automatic failover timeout.",
  });
});

test("important activity retains actionable host failures and dedupes a matching handoff completion", () => {
  const importantTypes = [
    "PRIMARY_ERROR", "PRIMARY_UNAVAILABLE", "BACKUP_STALE", "BACKUP_ERROR", "BACKUP_UNAVAILABLE", "BACKUP_RECOVERED",
    "PRIMARY_HANDOFF_FAILED", "PRIMARY_HANDOFF_INCOMPLETE",
  ];
  const events = importantTypes.map((eventType, index) => ({ eventType, timestampMs: (index + 1) * 60_000 }));
  events.push({ eventType: "PRIMARY_HANDOFF", timestampMs: 20 * 60_000 });
  events.push({ eventType: "PRIMARY_HANDOFF_COMPLETE", timestampMs: 21 * 60_000 });
  const selected = selectHostHealthOperatorEvents(events, 20);
  assert.ok(importantTypes.every((type) => selected.some((event) => event.eventType === type)));
  assert.ok(selected.some((event) => event.eventType === "PRIMARY_HANDOFF"));
  assert.ok(!selected.some((event) => event.eventType === "PRIMARY_HANDOFF_COMPLETE"));
  assert.equal(selectHostHealthOperatorEvents([{ eventType: "PRIMARY_HANDOFF_COMPLETE", timestampMs: 1 }])[0].eventType,
    "PRIMARY_HANDOFF_COMPLETE");
});

test("visible switch summary translates takeover and return into direct operator language", () => {
  assert.deepEqual(hostHealthLastSwitchPresentation(null), {
    label: "LAST AUTOMATIC SWITCH", lead: "No takeover or return has been recorded yet.", hasTime: false,
  });
  assert.deepEqual(hostHealthLastSwitchPresentation({ eventType: "BACKUP_TAKEOVER" }), {
    label: "BACKUP TOOK OVER AUTOMATICALLY", lead: "PRIMARY stopped checking in; BACKUP began updating at", hasTime: true,
  });
  assert.equal(hostHealthLastSwitchPresentation({ eventType: "PRIMARY_HANDOFF" }).label, "PRIMARY RESUMED AUTOMATICALLY");
});

test("unobserved inactive BACKUP is presented as standby without engineering fields or an alarming UNKNOWN label", () => {
  const doc = new FakeDocument();
  const parent = new FakeNode("section");
  renderOperatorHostCard(doc, parent, {
    role: "BACKUP", roleState: "STANDBY · NOT CURRENTLY OBSERVED", health: "UNKNOWN", observed: false,
    heartbeatUtc: "2026-09-09T11:23:00Z", heartbeatAgeMinutes: 73,
  }, { publisher: "PRIMARY" }, "Z");
  assert.match(parent.textContent, /BACKUP⚪ STANDBYSTANDING BY/);
  assert.match(parent.textContent, /CHECKED WHEN IT TAKES OVER/);
  assert.match(parent.textContent, /LAST ACTIVE UPDATE · 73 MIN AGO/);
  assert.doesNotMatch(parent.textContent, /UNKNOWN|SOURCE SHA|LEASE|TASK|LAST ERROR|HEALTH REASON/);
});

test("focus trap exposes closed disclosure summaries but not their hidden controls", () => {
  const closedDetails = {};
  const close = { hidden: false, tagName: "BUTTON", closest: () => null };
  const historySummary = { hidden: false, tagName: "SUMMARY", closest: () => closedDetails };
  const technicalSummary = { hidden: false, tagName: "SUMMARY", closest: () => closedDetails };
  const hiddenRangeButton = { hidden: false, tagName: "BUTTON", closest: () => closedDetails };
  const panel = { querySelectorAll: () => [close, historySummary, hiddenRangeButton, technicalSummary] };
  assert.deepEqual(hostHealthFocusableElements(panel), [close, historySummary, technicalSummary]);
});

test("all ranges, Z/LOCAL toggle, module, stylesheet, and dedicated test command are present", () => {
  for (const range of ["24h", "7d", "30d", "90d", "365d"]) assert.match(indexHtml, new RegExp(`data-host-health-range="${range}"`));
  assert.match(indexHtml, /data-host-health-time="Z"/);
  assert.match(indexHtml, /data-host-health-time="LOCAL"/);
  assert.match(indexHtml, /href="\.\/host-health\.css"/);
  assert.match(indexHtml, /type="module" src="\.\/host-health\.js"/);
  assert.match(packageJson.scripts["test:host-health"], /host-health-core\.test\.mjs[\s\S]*host-health-ui\.test\.mjs/);
});

test("health icon semantics are based on health, never preferred host role", () => {
  assert.deepEqual(hostHealthStatePresentation("HEALTHY"), { state: "HEALTHY", icon: "🟢", className: "host-health-state-healthy" });
  assert.equal(hostHealthStatePresentation("DELAYED").icon, "🟡");
  assert.equal(hostHealthStatePresentation("STALE").icon, "🟡");
  assert.equal(hostHealthStatePresentation("ERROR").icon, "🔴");
  assert.equal(hostHealthStatePresentation("UNKNOWN").icon, "⚪");
  assert.doesNotMatch(css, /host-primary[^}]*green|host-backup[^}]*yellow/i);
});

test("collapsed technical publisher card retains exact failover or handoff evidence", () => {
  assert.match(source, /LAST FAILOVER \/ HANDOFF/);
  assert.match(source, /latestPublisherTransition\.eventType/);
  assert.match(source, /NO RECORDED EVENT/);
});

test("dialog open/close is reversible, locks only page scrolling, and restores focus", () => {
  const classes = new Set();
  const body = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
  const overlay = new FakeNode("div");
  let focused = "";
  const focusTarget = { focus() { focused = "close"; } };
  const returnFocus = { focus() { focused = "opener"; } };
  assert.equal(applyHostHealthDialogState({ overlay, body, focusTarget, returnFocus }, true), true);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.getAttribute("aria-hidden"), "false");
  assert.equal(focused, "close");
  assert.ok(classes.has("host-health-dialog-open"));
  applyHostHealthDialogState({ overlay, body, focusTarget, returnFocus }, false);
  assert.equal(overlay.hidden, true);
  assert.equal(focused, "opener");
  assert.equal(classes.size, 0);
});

test("three telemetry resources load independently with cache bypass and history failure is isolated", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("host_health_history")) return { ok: false, status: 503 };
    if (url.includes("host_status")) return { ok: true, json: async () => ({ activeRole: "BACKUP" }) };
    return { ok: true, json: async () => ({ state: "RELEASED", owner: "BACKUP" }) };
  };
  const result = await createHostHealthLoader({ fetchImpl, baseUrl: "https://example.test/board/index.html" }).load();
  assert.equal(result.history, null);
  assert.match(result.historyError.message, /503/);
  assert.equal(result.hostStatus.activeRole, "BACKUP");
  assert.equal(result.lease.state, "RELEASED");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url.includes("?_") && call.options.cache === "no-store"));
  assert.ok(calls.every((call) => (call.options.method || "GET") === "GET"));
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname.split("/").at(-1)).sort(),
    ["host_health_history.json", "host_status.json", "updater_lease.json"]);
});

test("a throwing malformed history document cannot suppress valid live host and lease reads", async () => {
  const malformedHistory = {};
  Object.defineProperty(malformedHistory, "schemaVersion", {
    get() { throw new RangeError("malformed archive field"); },
  });
  const fetchImpl = async (url) => {
    if (url.includes("host_health_history")) return { ok: true, json: async () => malformedHistory };
    if (url.includes("host_status")) return { ok: true, json: async () => ({ activeRole: "BACKUP" }) };
    return { ok: true, json: async () => ({ state: "RELEASED", owner: "BACKUP" }) };
  };
  const result = await createHostHealthLoader({ fetchImpl, baseUrl: "https://example.test/board/index.html" }).load();
  assert.equal(result.history, null);
  assert.match(result.historyError.message, /malformed archive field/);
  assert.equal(result.hostStatus.activeRole, "BACKUP");
  assert.equal(result.lease.state, "RELEASED");
});

test("timeline renderer produces four exact tracks, semantic intervals, events, and non-button accessible focus targets", () => {
  const doc = new FakeDocument();
  const container = new FakeNode("div");
  const tooltip = new FakeNode("div");
  container.appendChild(tooltip);
  const timeline = buildHostHealthTimeline(history(), getHostHealthRange("24h", "2026-09-09T10:00:00Z"), "2026-09-09T10:00:00Z");
  const svg = renderHostHealthChart(doc, container, tooltip, timeline, { basis: "Z" });
  assert.equal(svg.tagName, "SVG");
  assert.match(svg.getAttribute("aria-label"), /Zulu time/);
  const nodes = descendants(svg);
  const trackLabels = nodes.filter((node) => node.getAttribute("class") === "host-health-track-label").map((node) => node.textContent);
  assert.deepEqual(trackLabels, ["PRIMARY", "BACKUP", "PUBLISHER", "BOARD DELIVERY"]);
  const intervals = nodes.filter((node) => node.getAttribute("class")?.startsWith("host-health-interval "));
  assert.equal(intervals.length, 5);
  assert.ok(intervals.every((node) => node.getAttribute("tabindex") === "0" && node.getAttribute("role") === "img"));
  const publisherInterval = timeline.value.tracks.find((track) => track.key === "PUBLISHER").intervals[0];
  const boardIntervals = timeline.value.tracks.find((track) => track.key === "BOARD_DELIVERY").intervals;
  assert.equal(publisherInterval.publisher, "BACKUP");
  assert.equal(boardIntervals[0].publisher, "UNKNOWN");
  assert.equal(boardIntervals.at(-1).publisher, "BACKUP");
  const events = nodes.filter((node) => node.getAttribute("class") === "host-health-event");
  assert.equal(events.length, 1);
  assert.equal(events[0].getAttribute("role"), "img");
  assert.match(events[0].getAttribute("aria-label"), /BACKUP_TAKEOVER/);
});

test("daily summaries render bounded truthful aggregate paths instead of an empty long-range timeline", () => {
  const doc = new FakeDocument();
  const container = new FakeNode("div");
  const tooltip = new FakeNode("div");
  const startMs = Date.parse("2026-09-06T00:00:00Z");
  const endMs = Date.parse("2026-09-07T00:00:00Z");
  const states = {
    PRIMARY_HEALTH: { HEALTHY: 43_200, DELAYED: 43_200 },
    BACKUP_HEALTH: { UNKNOWN: 86_400 },
    PUBLISHER: { PRIMARY: 82_800, BACKUP: 3_600 },
    BOARD_DELIVERY: { CONTINUOUS: 82_800, GAP: 3_600 },
  };
  const summary = {
    dateUtc: "2026-09-06", dayStartMs: startMs, dayEndMs: endMs, coverageSeconds: 86_400,
    tracks: Object.fromEntries(Object.entries(states).map(([track, durationsSeconds]) => [track, { durationsSeconds }])),
  };
  const tracks = ["PRIMARY_HEALTH", "BACKUP_HEALTH", "PUBLISHER", "BOARD_DELIVERY"].map((key) => ({
    key, label: key.replaceAll("_", " "), intervals: [],
  }));
  const svg = renderHostHealthChart(doc, container, tooltip, {
    range: { startMs, endMs, durationMs: endMs - startMs }, tracks, events: [], dailySummaries: [summary],
    retentionBoundaryGap: {
      startMs, endMs: startMs + 60_000, reason: "PARTIAL_UTC_DAY_DROPPED_AFTER_DAILY_AGGREGATION",
    },
  });
  const nodes = descendants(svg);
  assert.ok(nodes.some((node) => node.getAttribute("class")?.includes("host-health-summary-segment")));
  assert.equal(nodes.filter((node) => node.getAttribute("class") === "host-health-summary-accessibility").length, 4);
  assert.ok(nodes.filter((node) => node.getAttribute("class") === "host-health-summary-accessibility")
    .every((node) => node.getAttribute("role") === "img"));
  assert.match(container.textContent, /DAILY AGGREGATE HISTORY · 1 UTC DAY/);
  assert.match(container.textContent, /NOT INTRA-DAY ORDER/);
  assert.match(container.textContent, /RETENTION-EDGE COVERAGE UNAVAILABLE/);
  assert.match(container.textContent, /PARTIAL UTC DAY DROPPED/);
  assert.doesNotMatch(source, /role: "button"/);
});

test("timeline tooltip discloses exact UTC/local provenance only on a retained interval/event target", () => {
  const doc = new FakeDocument();
  const container = new FakeNode("div");
  const tooltip = new FakeNode("div");
  container.appendChild(tooltip);
  const timeline = buildHostHealthTimeline(history(), getHostHealthRange("24h", "2026-09-09T10:00:00Z"), "2026-09-09T10:00:00Z");
  const svg = renderHostHealthChart(doc, container, tooltip, timeline, { basis: "LOCAL" });
  const interval = descendants(svg).find((node) => node.getAttribute("class")?.includes("host-health-interval-stale"));
  interval.dispatch("focus");
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.textContent, /STATESTALE/);
  assert.match(tooltip.textContent, /START UTC09 SEP 2026 0802Z/);
  assert.match(tooltip.textContent, /START LOCAL09 SEP 2026 0302L CDT/);
  assert.match(tooltip.textContent, /HEARTBEAT STALE/);
  assert.match(tooltip.textContent, /TIMESTAMP CERTAINTY/);
  assert.match(tooltip.textContent, /SOURCE SHA/);
  interval.dispatch("blur");
  assert.equal(tooltip.hidden, true);
});

test("long-range rendering bounds SVG and event-log DOM while disclosing density reduction", () => {
  const doc = new FakeDocument();
  const container = new FakeNode("div");
  const tooltip = new FakeNode("div");
  const endMs = Date.parse("2026-09-09T10:00:00Z");
  const startMs = endMs - 365 * 24 * 60 * 60 * 1000;
  const denseIntervals = Array.from({ length: 700 }, (_, index) => {
    const intervalStart = startMs + index * 60_000;
    return {
      id: `dense-${index}`, track: "PRIMARY_HEALTH", host: "PRIMARY",
      state: index % 2 ? "HEALTHY" : "DELAYED", startMs: intervalStart, endMs: intervalStart + 60_000,
      publisher: "PRIMARY", leaseOwner: "UNKNOWN", reason: "DENSITY FIXTURE",
      sourceTimestampType: "PUBLISHED_HEARTBEAT_UTC", timestampCertainty: "EXACT_SOURCE_TIMESTAMP",
    };
  });
  const events = Array.from({ length: 1_000 }, (_, index) => ({
    id: `event-${index}`, eventType: "PRIMARY_HEALTHY", host: "PRIMARY",
    timestampMs: startMs + index * 60_000, timestampUtc: new Date(startMs + index * 60_000).toISOString(),
    reason: "DENSITY FIXTURE", publisher: "PRIMARY", leaseOwner: "UNKNOWN",
    sourceTimestampType: "PUBLISHED_HEARTBEAT_UTC", timestampCertainty: "EXACT_SOURCE_TIMESTAMP",
  }));
  const tracks = ["PRIMARY_HEALTH", "BACKUP_HEALTH", "PUBLISHER", "BOARD_DELIVERY"].map((key) => ({
    key, label: key.replaceAll("_", " "), intervals: key === "PRIMARY_HEALTH" ? denseIntervals : [],
  }));
  const svg = renderHostHealthChart(doc, container, tooltip, {
    range: { startMs, endMs, durationMs: endMs - startMs }, tracks, events,
  });
  assert.ok(svg);
  const nodes = descendants(svg);
  assert.ok(nodes.filter((node) => node.getAttribute("class")?.includes("host-health-interval-density")).length <= 2);
  assert.equal(nodes.filter((node) => node.getAttribute("class") === "host-health-event").length, 0);
  assert.match(container.textContent, /TIMELINE DENSITY MODE · 700 INTERVALS · 1000 EVENT MARKERS SUPPRESSED/);
  const selected = selectHostHealthEventLogItems(events);
  assert.equal(selected.items.length, 200);
  assert.equal(selected.total, 1_000);
  assert.equal(selected.limited, true);
  assert.equal(selected.items[0].id, "event-999");
  assert.match(source, /SHOWING NEWEST \$\{selection\.items\.length\} OF \$\{selection\.total\} RETAINED EVENTS/);
});

test("range/time controls rerender locally while only modal open invokes the loader", () => {
  assert.match(source, /button\.dataset\.hostHealthTime[\s\S]*basis = next;[\s\S]*render\(false\)/);
  assert.match(source, /button\.dataset\.hostHealthRange[\s\S]*render\(true\)/);
  const openBody = source.slice(source.indexOf("function open(opener)"), source.indexOf("function close()"));
  assert.match(openBody, /load\(\{ resetDomain: true, announce: true, session \}\)/);
  const timeHandler = source.slice(source.indexOf("for (const button of timeButtons)"), source.indexOf('doc.addEventListener("click"'));
  assert.doesNotMatch(timeHandler, /load\(|fetch\(/);
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*render\(false\)[\s\S]*30_000/);
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*load\(\{ resetDomain: false, announce: false, session \}\)[\s\S]*60_000/);
  assert.match(source, /clearInterval\(displayTimer\)/);
  assert.match(source, /clearInterval\(telemetryTimer\)/);
  assert.match(source, /if \(loadInFlight\)[\s\S]*pendingLoad/);
  assert.match(source, /session !== modalSession/);
  assert.match(source, /retainLastGoodTelemetry/);
  assert.match(source, /CURRENT CARDS USE NEWER LIVE STATUS/);
});

test("zoom, wheel, drag and touch pan are wired to the shared proportional time domain", () => {
  assert.match(source, /zoomHostHealthTimeDomain\(timeDomain, 2, 1\)/);
  assert.match(source, /zoomHostHealthTimeDomain\(timeDomain, 0\.5, 1\)/);
  assert.match(source, /addEventListener\("wheel"[\s\S]*preventDefault\(\)[\s\S]*zoomHostHealthTimeDomain/);
  assert.match(source, /addEventListener\("pointerdown"/);
  assert.match(source, /addEventListener\("pointermove"[\s\S]*panHostHealthTimeDomain/);
  assert.equal(hostHealthChartInteractionMode({ ok: true, isFullRange: true }), "native-scroll");
  assert.equal(hostHealthChartInteractionMode({ ok: true, isFullRange: false }), "domain-pan");
  assert.match(css, /\.host-health-chart\{[^}]*overflow-x:auto[^}]*touch-action:auto/);
  assert.match(css, /\.host-health-chart-zoomed\{[^}]*overflow-x:hidden[^}]*touch-action:pan-y/);
  assert.match(css, /\.host-health-chart-zoomed \.host-health-svg\{min-width:100%\}/);
});

test("responsive CSS contains every required narrow/display layout without document-width geometry", () => {
  assert.match(css, /width:min\(1220px,100%\)/);
  assert.match(css, /max-width:100%/);
  assert.match(css, /@media\(max-width:850px\)/);
  assert.match(css, /@media\(max-width:500px\)/);
  assert.match(css, /max-width:950px[\s\S]*max-height:520px[\s\S]*orientation:landscape/);
  assert.match(css, /\.host-health-chart\{[^}]*overflow-x:auto/);
  assert.doesNotMatch(css, /width\s*:\s*100vw/);
  assert.doesNotMatch(css, /(?:html|body|\.host-health-overlay|\.host-health-panel)\s*\{[^}]*overflow-x\s*:\s*hidden/);
  assert.match(css, /#hostHealthButton\{[^}]*padding:0[^}]*appearance:none[^}]*cursor:pointer/);
  assert.match(css, /\.host-health-host-snapshot\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:850px\)[\s\S]*\.host-health-host-snapshot\{grid-template-columns:1fr\}/);
  assert.match(css, /\.host-health-disclosure>summary::after\{content:"SHOW \+"/);
  assert.match(css, /\.host-health-disclosure>summary\{[^}]*min-height:48px[^}]*cursor:pointer/);
  assert.match(css, /\.host-health-disclosure>summary:hover,[^}]*focus-visible/);
  assert.match(css, /@media\(max-width:500px\)[\s\S]*\.host-health-operator-summary\{padding:13px 11px\}/);
  assert.match(css, /@media\(max-width:500px\)[\s\S]*\.host-health-important-item\{grid-template-columns:1fr/);
  assert.match(css, /\.host-health-body\{[^}]*overflow:auto/);
});

test("implementation is strictly telemetry-only and cannot mutate updater/failover state", () => {
  assert.match(source, /host_health_history\.json/);
  assert.match(source, /host_status\.json/);
  assert.match(source, /updater_lease\.json/);
  assert.doesNotMatch(source, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i);
  assert.doesNotMatch(source, /acquireLease|releaseLease|forceFailover|restartUpdater|update_weather_local|child_process|exec\(/i);
  assert.match(source, /fetchJson\(fetchImpl[\s\S]*cache: "no-store"/);
  assert.match(source, /telemetryTimer = view\.setInterval/);
  assert.match(source, /pendingLoad = \{[^}]*resetDomain/);
});
