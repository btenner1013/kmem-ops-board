import test from "node:test";
import assert from "node:assert/strict";

import {
  BWC_HISTORY_SCHEMA_VERSION,
  BWC_MIN_VISIBLE_DURATION_MS,
  BWC_RANGE_DURATIONS_MS,
  BWC_RANGES,
  BWC_UTC_TICK_INTERVALS_MS,
  buildBwcTimeline,
  buildStepPaths,
  calculateBwcAge,
  calculateBwcStatistics,
  countSevereEpisodes,
  createBwcTimeDomain,
  describeArchiveAvailability,
  findLastConfirmedChange,
  formatBwcUtcTickLabel,
  formatBwcMemphisTime,
  formatBwcZuluTime,
  getBwcRange,
  normalizeBwcHistory,
  panBwcTimeDomain,
  parseAhasUtcTimestamp,
  resetBwcTimeDomain,
  selectBwcUtcTicks,
  zoomBwcTimeDomain,
} from "../bwc-history-core.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function stateRun(state, startZ, lastObservedZ = startZ, overrides = {}) {
  return {
    kind: "STATE",
    state,
    rawAhasRisk: state,
    startZ,
    firstObservedZ: startZ,
    lastObservedZ,
    firstRecordedZ: startZ,
    lastRecordedZ: lastObservedZ,
    confirmationCount: 1,
    startReason: "STATE_CHANGE",
    source: "USAHAS",
    basis: "NEXRAD",
    basisClass: "OBSERVED_OPERATIONAL",
    ...overrides,
  };
}

function unknownRun(startZ, endZ, overrides = {}) {
  return {
    kind: "UNKNOWN",
    startZ,
    endZ,
    reason: "SOURCE_NO_DATA",
    source: "USAHAS",
    firstObservedZ: startZ,
    lastObservedZ: startZ,
    firstRecordedZ: startZ,
    lastRecordedZ: startZ,
    confirmationCount: 1,
    ...overrides,
  };
}

function history(runs = [], overrides = {}) {
  return {
    schemaVersion: 1,
    station: "KMEM",
    product: "USAHAS_AHAS_RISK",
    sourceArea: { type: "ICAO", name: "MEMPHIS INTL" },
    sourceTimestampField: "DateTime",
    retentionDays: 365,
    continuityMinutes: 90,
    collectionStartedZ: runs[0]?.startZ || null,
    archiveUpdatedZ: runs.length ? "2026-08-30T13:00:00Z" : null,
    runs,
    ...overrides,
  };
}

function customRange(startZ, endZ) {
  return { startZ, endZ, key: "test", label: "TEST" };
}

test("strict AHAS parser treats bare timestamps as UTC and accepts canonical UTC forms", () => {
  const expected = Date.parse("2026-08-30T02:30:00.123Z");
  assert.equal(parseAhasUtcTimestamp("2026-08-30 02:30:00.123"), expected);
  assert.equal(parseAhasUtcTimestamp("2026-08-30T02:30:00.123Z"), expected);
  assert.equal(parseAhasUtcTimestamp("2026-08-30T02:30:00.123000+00:00"), expected);
  assert.equal(parseAhasUtcTimestamp(" 2026-08-30 02:30:00.123 "), expected);
});

test("strict AHAS parser rejects rollover, incomplete, local-offset, and non-string values", () => {
  for (const value of [
    "2026-02-29 02:30:00.000",
    "2026-13-01 02:30:00.000",
    "2026-08-30 24:00:00.000",
    "2026-08-30 02:60:00.000",
    "2026-08-30 02:30:60.000",
    "2026-08-30 02:30",
    "2026-08-30T02:30:00-05:00",
    "not a date",
    "",
    null,
    1788057000000,
  ]) assert.equal(parseAhasUtcTimestamp(value), null, String(value));
  assert.equal(
    parseAhasUtcTimestamp("2028-02-29 23:59:59.999"),
    Date.parse("2028-02-29T23:59:59.999Z"),
  );
});

test("age floors elapsed minutes and naturally crosses hour/day/month/year boundaries", () => {
  const age = calculateBwcAge("2025-12-31 23:59:45.000", "2026-01-01T00:01:44.999Z");
  assert.equal(age.ok, true);
  assert.equal(age.minutes, 1);
  assert.equal(age.isFutureClamped, false);
  assert.equal(calculateBwcAge("2026-08-30 02:30:00.000", "2026-08-30T02:31:00Z").minutes, 1);
});

test("age advances from the source time without a reload or generation-time input", () => {
  const source = "2026-08-30 02:30:00.000";
  assert.equal(calculateBwcAge(source, "2026-08-30T02:35:59.999Z").minutes, 5);
  assert.equal(calculateBwcAge(source, "2026-08-30T02:36:00.000Z").minutes, 6);
  assert.equal(calculateBwcAge(source, "2026-08-30T03:35:00.000Z").minutes, 65);
});

test("age clamps future skew through exactly two minutes and suppresses a larger future value", () => {
  const now = "2026-08-30T02:30:00Z";
  const exactBoundary = calculateBwcAge("2026-08-30 02:32:00.000", now);
  assert.deepEqual(
    { ok: exactBoundary.ok, minutes: exactBoundary.minutes, clamped: exactBoundary.isFutureClamped },
    { ok: true, minutes: 0, clamped: true },
  );
  const tooFar = calculateBwcAge("2026-08-30 02:32:00.001", now);
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.minutes, null);
  assert.equal(tooFar.reason, "FUTURE_TIMESTAMP");
  assert.equal(tooFar.futureByMs, 120001);
});

test("age reports missing, malformed, and invalid-now inputs without inventing an age", () => {
  assert.equal(calculateBwcAge("", Date.now()).reason, "MISSING_TIMESTAMP");
  assert.equal(calculateBwcAge("--", Date.now()).reason, "INVALID_TIMESTAMP");
  assert.equal(calculateBwcAge("2026-08-30 02:30:00.000", "bad now").reason, "INVALID_NOW");
});

test("all rolling ranges are exact UTC durations ending at the supplied now", () => {
  const now = "2026-08-30T12:00:00Z";
  const expected = {
    "24h": DAY_MS,
    "7d": 7 * DAY_MS,
    "30d": 30 * DAY_MS,
    "90d": 90 * DAY_MS,
    "365d": 365 * DAY_MS,
  };
  assert.equal(BWC_RANGES.length, 5);
  assert.deepEqual(BWC_RANGE_DURATIONS_MS, expected);
  for (const [key, durationMs] of Object.entries(expected)) {
    const range = getBwcRange(key, now);
    assert.equal(range.durationMs, durationMs);
    assert.equal(range.endMs, Date.parse(now));
    assert.equal(range.endMs - range.startMs, durationMs);
  }
  assert.equal(getBwcRange("1 YEAR", now).key, "365d");
  assert.equal(getBwcRange("bogus", now), null);
});

test("schema-v1 normalization canonicalizes, sorts, classifies basis, and leaves input untouched", () => {
  const input = history([
    stateRun("SEVERE", "2026-08-30 11:00:00.000", undefined, {
      basis: "SOAR",
      basisClass: "",
    }),
    stateRun("LOW", "2026-08-30 09:00:00.000"),
  ], { collectionStartedZ: "2026-08-30 09:00:00.000" });
  const before = structuredClone(input);
  const result = normalizeBwcHistory(input);
  assert.equal(result.ok, true);
  assert.equal(result.value.schemaVersion, BWC_HISTORY_SCHEMA_VERSION);
  assert.equal(result.value.runs[0].state, "LOW");
  assert.equal(result.value.runs[1].basisClass, "MODEL_OPERATIONAL");
  assert.equal(result.value.runs[0].startZ, "2026-08-30T09:00:00.000Z");
  assert.deepEqual(input, before);
});

test("schema validation rejects unsupported schemas, NONE-as-data, bad intervals, and ambiguous starts", () => {
  assert.equal(normalizeBwcHistory(history([], { schemaVersion: 2 })).error.code, "UNSUPPORTED_SCHEMA");
  assert.equal(normalizeBwcHistory(history([], { station: "KJFK" })).error.code, "INVALID_STATION");
  assert.equal(normalizeBwcHistory(history([], { product: "OTHER_PRODUCT" })).error.code, "INVALID_PRODUCT");
  assert.equal(normalizeBwcHistory(history([], { sourceArea: { type: "ICAO", name: "OTHER" } })).error.code, "INVALID_SOURCE_AREA");
  assert.equal(normalizeBwcHistory(history([], { retentionDays: 30 })).error.code, "INVALID_RETENTION");
  assert.equal(normalizeBwcHistory(history([], { continuityMinutes: 9000 })).error.code, "INVALID_CONTINUITY");
  assert.equal(
    normalizeBwcHistory(history([stateRun("NONE", "2026-08-30T09:00:00Z")])).error.code,
    "INVALID_STATE",
  );
  assert.equal(
    normalizeBwcHistory(history([unknownRun("2026-08-30T10:00:00Z", "2026-08-30T09:00:00Z")])).error.code,
    "INVALID_INTERVAL",
  );
  assert.equal(
    normalizeBwcHistory(history([
      stateRun("LOW", "2026-08-30T09:00:00Z"),
      stateRun("MODERATE", "2026-08-30T09:00:00Z"),
    ])).error.code,
    "AMBIGUOUS_RUNS",
  );
});

test("backend-shaped evidence-free coverage gaps normalize without fabricating confirmations", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T08:00:00Z", "2026-08-30T08:30:00Z"),
    unknownRun("2026-08-30T10:00:00Z", "2026-08-30T11:00:00Z", {
      reason: "COVERAGE_GAP",
      firstObservedZ: "",
      lastObservedZ: "",
      firstRecordedZ: "",
      lastRecordedZ: "",
      confirmationCount: 0,
    }),
    stateRun("MODERATE", "2026-08-30T11:00:00Z", undefined, {
      startReason: "STATE_AFTER_GAP",
    }),
  ]);

  const normalized = normalizeBwcHistory(payload);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.runs[1].reason, "COVERAGE_GAP");
  assert.equal(normalized.value.runs[1].confirmationCount, 0);
  assert.equal(normalized.value.runs[1].firstObservedZ, "");

  const invalidNoData = normalizeBwcHistory(history([
    unknownRun("2026-08-30T10:00:00Z", "", {
      firstObservedZ: "",
      lastObservedZ: "",
      firstRecordedZ: "",
      lastRecordedZ: "",
      confirmationCount: 0,
    }),
  ]));
  assert.equal(invalidNoData.ok, false);
  assert.equal(invalidNoData.error.code, "INVALID_UNKNOWN_EVIDENCE");
});

test("retention carry-in may begin after its last real observation within the continuity horizon", () => {
  const cutoff = "2025-08-30T03:00:00Z";
  const observed = "2025-08-30T02:30:00Z";
  const payload = history([
    stateRun("LOW", cutoff, observed, {
      firstObservedZ: observed,
      firstRecordedZ: "2025-08-30T02:31:00Z",
      lastRecordedZ: "2025-08-30T02:31:00Z",
      startReason: "RETENTION_CARRY_IN",
      originalStartReason: "ARCHIVE_START",
    }),
  ], { collectionStartedZ: "2025-08-30T02:31:00Z" });

  const normalized = normalizeBwcHistory(payload);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.runs[0].startZ, "2025-08-30T03:00:00.000Z");
  assert.equal(normalized.value.runs[0].lastObservedZ, "2025-08-30T02:30:00.000Z");

  const beyondHorizon = structuredClone(payload);
  beyondHorizon.runs[0].startZ = "2025-08-30T04:00:00.001Z";
  assert.equal(normalizeBwcHistory(beyondHorizon).error.code, "INVALID_INTERVAL");
});

test("an open UNKNOWN run is valid and extends through the selected window", () => {
  const payload = history([
    unknownRun("2026-08-30T10:00:00Z", "", {
      firstObservedZ: "2026-08-30T10:00:00Z",
      lastObservedZ: "2026-08-30T11:00:00Z",
      carryIn: true,
    }),
  ]);
  const normalized = normalizeBwcHistory(payload);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.runs[0].endZ, "");
  assert.equal(normalized.value.runs[0].carryIn, true);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T10:00:00Z", "2026-08-30T12:00:00Z"));
  assert.equal(timeline.ok, true);
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.segments[0].kind, "UNKNOWN");
  assert.equal(timeline.unknownMs, 2 * HOUR_MS);
});

test("timeline uses the 90-minute freshness horizon and fills uncovered time as UNKNOWN", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T08:00:00Z", "2026-08-30T08:30:00Z", {
      startReason: "ARCHIVE_START",
      confirmationCount: 6,
    }),
  ]);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T08:00:00Z", "2026-08-30T11:00:00Z"));
  assert.equal(timeline.ok, true);
  assert.deepEqual(timeline.segments.map((segment) => [segment.kind, segment.startZ, segment.endZ]), [
    ["STATE", "2026-08-30T08:00:00.000Z", "2026-08-30T10:00:00.000Z"],
    ["UNKNOWN", "2026-08-30T10:00:00.000Z", "2026-08-30T11:00:00.000Z"],
  ]);
});

test("timeline carries a verified predecessor across the selected start", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T07:00:00Z", "2026-08-30T08:30:00Z", {
      startReason: "ARCHIVE_START",
    }),
    stateRun("MODERATE", "2026-08-30T09:00:00Z", "2026-08-30T09:30:00Z"),
  ]);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T08:00:00Z", "2026-08-30T10:00:00Z"));
  assert.deepEqual(timeline.segments.map((segment) => [segment.kind, segment.state]), [
    ["STATE", "LOW"],
    ["STATE", "MODERATE"],
  ]);
  assert.equal(timeline.segments[0].clippedAtRangeStart, true);
  assert.equal(timeline.segments[0].startZ, "2026-08-30T08:00:00.000Z");
});

test("statistics use elapsed duration, include UNKNOWN, and exclude basis splits and post-gap states from changes", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T08:00:00Z", "2026-08-30T08:30:00Z", {
      startReason: "ARCHIVE_START",
    }),
    stateRun("LOW", "2026-08-30T09:00:00Z", "2026-08-30T09:30:00Z", {
      startReason: "BASIS_CHANGE",
      basis: "NEXBAM",
      basisClass: "MODEL_OPERATIONAL",
    }),
    stateRun("MODERATE", "2026-08-30T10:00:00Z", "2026-08-30T10:30:00Z"),
    unknownRun("2026-08-30T11:00:00Z", "2026-08-30T11:20:00Z"),
    stateRun("SEVERE", "2026-08-30T11:30:00Z", "2026-08-30T11:30:00Z", {
      startReason: "STATE_AFTER_GAP",
    }),
  ]);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T08:00:00Z", "2026-08-30T13:00:00Z"));
  const stats = calculateBwcStatistics(timeline);
  assert.equal(stats.ok, true);
  assert.deepEqual(stats.durationsMs, {
    LOW: 2 * HOUR_MS,
    MODERATE: HOUR_MS,
    SEVERE: 1.5 * HOUR_MS,
    UNKNOWN: 0.5 * HOUR_MS,
  });
  assert.deepEqual(stats.percentages, { LOW: 40, MODERATE: 20, SEVERE: 30, UNKNOWN: 10 });
  assert.equal(stats.coveragePercent, 90);
  assert.equal(stats.changeCount, 1);
  assert.equal(stats.severeEpisodes, 1);
  assert.deepEqual(findLastConfirmedChange(timeline), {
    atMs: Date.parse("2026-08-30T10:00:00Z"),
    atZ: "2026-08-30T10:00:00.000Z",
    fromState: "LOW",
    toState: "MODERATE",
    basis: "NEXRAD",
    basisClass: "OBSERVED_OPERATIONAL",
  });
});

test("same-state confirmations are not changes while severe episodes split across unknown gaps", () => {
  const payload = history([
    stateRun("SEVERE", "2026-08-30T08:00:00Z", "2026-08-30T08:30:00Z", { startReason: "ARCHIVE_START" }),
    stateRun("SEVERE", "2026-08-30T09:00:00Z", "2026-08-30T09:30:00Z", {
      startReason: "BASIS_CHANGE",
      basis: "SOAR",
      basisClass: "MODEL_OPERATIONAL",
    }),
    unknownRun("2026-08-30T10:00:00Z", "2026-08-30T10:15:00Z"),
    stateRun("SEVERE", "2026-08-30T10:30:00Z", "2026-08-30T10:30:00Z", {
      startReason: "STATE_AFTER_GAP",
    }),
  ]);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T08:00:00Z", "2026-08-30T12:00:00Z"));
  assert.equal(countSevereEpisodes(timeline), 2);
  assert.equal(calculateBwcStatistics(timeline).changeCount, 0);
  assert.equal(findLastConfirmedChange(timeline), null);
});

test("archive availability distinguishes awaiting, partial, exact full, and full-with-gap windows", () => {
  const now = "2026-08-30T12:00:00Z";
  const awaiting = describeArchiveAvailability(history([], { collectionStartedZ: null }), now);
  assert.equal(awaiting.status, "AWAITING_FIRST_OBSERVATION");

  const partial = describeArchiveAvailability(history([
    stateRun("LOW", "2026-08-29T12:00:00Z", "2026-08-30T12:00:00Z", { startReason: "ARCHIVE_START" }),
  ], { collectionStartedZ: "2026-08-29T12:05:00Z" }), now);
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.availableStartZ, "2026-08-29T12:00:00.000Z");
  assert.match(partial.detail, /^Available since /);
  assert.match(partial.detail, /1\.0 days collected · 100\.0% known coverage$/);

  const cutoff = "2025-08-30T12:00:00Z";
  const full = describeArchiveAvailability(history([
    stateRun("LOW", cutoff, now, { startReason: "RETENTION_CARRY_IN", confirmationCount: 52560 }),
  ], { collectionStartedZ: cutoff }), now);
  assert.equal(full.status, "FULL");
  assert.match(full.detail, /30 AUG 2025 1200Z – 30 AUG 2026 1200Z · 365 days available$/);

  const oneMillisecondLate = "2025-08-30T12:00:00.001Z";
  const nearlyFull = describeArchiveAvailability(history([
    stateRun("LOW", oneMillisecondLate, now, { startReason: "RETENTION_CARRY_IN" }),
  ], { collectionStartedZ: oneMillisecondLate }), now);
  assert.equal(nearlyFull.status, "PARTIAL");

  const withGap = describeArchiveAvailability(history([
    stateRun("LOW", cutoff, "2026-08-30T08:00:00Z", { startReason: "RETENTION_CARRY_IN" }),
    unknownRun("2026-08-30T09:30:00Z", "2026-08-30T10:00:00Z"),
    stateRun("LOW", "2026-08-30T10:00:00Z", now, { startReason: "COVERAGE_RESUMED" }),
  ], { collectionStartedZ: cutoff }), now);
  assert.equal(withGap.status, "FULL_WITH_GAPS");
  assert.equal(withGap.hasGaps, true);
  assert.match(withGap.detail, /known coverage/);
});

test("Zulu and Memphis formatters preserve exact time across spring DST transition", () => {
  assert.equal(formatBwcZuluTime("2026-03-08T07:30:00Z"), "08 MAR 2026 0730Z");
  assert.equal(formatBwcMemphisTime("2026-03-08T07:30:00Z"), "08 MAR 2026 0130L CST");
  assert.equal(formatBwcMemphisTime("2026-03-08T08:30:00Z"), "08 MAR 2026 0330L CDT");
});

test("Memphis formatter distinguishes both repeated fall-back local times", () => {
  assert.equal(formatBwcMemphisTime("2026-11-01T06:30:00Z"), "01 NOV 2026 0130L CDT");
  assert.equal(formatBwcMemphisTime("2026-11-01T07:30:00Z"), "01 NOV 2026 0130L CST");
  assert.equal(formatBwcMemphisTime("bad"), "");
});

test("step chart emits only horizontal/vertical state paths and breaks them across gaps", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T08:00:00Z", "2026-08-30T08:30:00Z", { startReason: "ARCHIVE_START" }),
    stateRun("MODERATE", "2026-08-30T09:00:00Z", "2026-08-30T09:30:00Z"),
    unknownRun("2026-08-30T10:00:00Z", "2026-08-30T10:30:00Z"),
    stateRun("SEVERE", "2026-08-30T10:30:00Z", "2026-08-30T10:30:00Z", {
      startReason: "STATE_AFTER_GAP",
    }),
  ]);
  const timeline = buildBwcTimeline(payload, customRange("2026-08-30T08:00:00Z", "2026-08-30T12:00:00Z"));
  const chart = buildStepPaths(timeline, {
    width: 800,
    height: 280,
    padding: { left: 54, right: 14, top: 14, bottom: 34 },
  });
  assert.equal(chart.ok, true);
  assert.deepEqual(chart.plot, {
    x: 54,
    y: 14,
    left: 54,
    right: 786,
    top: 14,
    bottom: 246,
    width: 732,
    height: 232,
    yByState: chart.yByState,
  });
  assert.equal(chart.unknownBands.length, 1);
  assert.equal(chart.transitions.length, 1);
  assert.equal(chart.transitions[0].fromState, "LOW");
  assert.equal(chart.transitions[0].toState, "MODERATE");
  for (const path of chart.paths) {
    assert.match(path.d, /^M [-\d.]+ [-\d.]+(?: V [-\d.]+)? H [-\d.]+$/);
    assert.doesNotMatch(path.d, /[LCQSTAZ]/);
  }
  const severePath = chart.paths.find((path) => path.state === "SEVERE");
  assert.doesNotMatch(severePath.d, / V /, "post-gap state must not draw a vertical transition");
});

test("timeline and chart APIs fail closed on malformed inputs", () => {
  assert.equal(buildBwcTimeline({ schemaVersion: 99 }, "24h").error.code, "UNSUPPORTED_SCHEMA");
  assert.equal(buildBwcTimeline(history(), "made-up").error.code, "INVALID_RANGE");
  assert.equal(calculateBwcStatistics({}).error.code, "INVALID_TIMELINE");
  assert.equal(buildStepPaths({}, {}).error.code, "INVALID_TIMELINE");
  const timeline = buildBwcTimeline(history(), customRange("2026-08-30T08:00:00Z", "2026-08-30T09:00:00Z"));
  assert.equal(buildStepPaths(timeline, { width: 20, height: 20, padding: { left: 15, right: 15 } }).error.code, "INVALID_DIMENSIONS");
});

test("time-domain creation preserves a master range and enforces the 30-minute visible minimum", () => {
  const master = {
    startMs: Date.parse("2026-08-30T00:00:00Z"),
    endMs: Date.parse("2026-08-31T00:00:00Z"),
  };
  const masterBefore = structuredClone(master);
  const full = createBwcTimeDomain(master);
  assert.equal(full.ok, true);
  assert.equal(full.durationMs, 24 * HOUR_MS);
  assert.equal(full.minVisibleDurationMs, BWC_MIN_VISIBLE_DURATION_MS);
  assert.equal(full.isFullRange, true);
  assert.equal(full.canZoomOut, false);
  assert.equal(full.canZoomIn, true);

  const short = createBwcTimeDomain(master, {
    startMs: Date.parse("2026-08-30T04:00:00Z"),
    endMs: Date.parse("2026-08-30T04:10:00Z"),
  });
  assert.equal(short.durationMs, 30 * 60 * 1000);
  assert.equal(short.startMs, Date.parse("2026-08-30T03:50:00Z"));
  assert.equal(short.endMs, Date.parse("2026-08-30T04:20:00Z"));
  assert.equal(short.isAtMinimumDuration, true);
  assert.equal(short.canZoomIn, false);
  assert.deepEqual(master, masterBefore, "domain normalization must not mutate caller state");
});

test("time-domain creation translates out-of-bounds windows and handles a master shorter than 30 minutes", () => {
  const master = customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
  const before = createBwcTimeDomain(master, customRange("2026-08-29T23:00:00Z", "2026-08-30T01:00:00Z"));
  assert.equal(before.startMs, Date.parse("2026-08-30T00:00:00Z"));
  assert.equal(before.endMs, Date.parse("2026-08-30T02:00:00Z"));
  const after = createBwcTimeDomain(master, customRange("2026-08-30T23:00:00Z", "2026-08-31T02:00:00Z"));
  assert.equal(after.startMs, Date.parse("2026-08-30T21:00:00Z"));
  assert.equal(after.endMs, Date.parse("2026-08-31T00:00:00Z"));

  const tinyMaster = createBwcTimeDomain(customRange("2026-08-30T12:00:00Z", "2026-08-30T12:20:00Z"));
  assert.equal(tinyMaster.durationMs, 20 * 60 * 1000);
  assert.equal(tinyMaster.minVisibleDurationMs, 20 * 60 * 1000);
  assert.equal(tinyMaster.isFullRange, true);
  assert.equal(tinyMaster.isAtMinimumDuration, true);
});

test("zoom keeps the center or cursor anchor stable and uses factor greater than one to zoom in", () => {
  const master = customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
  const full = createBwcTimeDomain(master);
  const centered = zoomBwcTimeDomain(full, 2);
  assert.equal(centered.startMs, Date.parse("2026-08-30T06:00:00Z"));
  assert.equal(centered.endMs, Date.parse("2026-08-30T18:00:00Z"));

  const quarter = zoomBwcTimeDomain(full, 2, { ratio: 0.25 });
  assert.equal(quarter.startMs, Date.parse("2026-08-30T03:00:00Z"));
  assert.equal(quarter.endMs, Date.parse("2026-08-30T15:00:00Z"));

  const cursorMs = Date.parse("2026-08-30T18:00:00Z");
  const cursorCentered = zoomBwcTimeDomain(full, 2, { timeMs: cursorMs });
  assert.equal(cursorCentered.startMs, Date.parse("2026-08-30T09:00:00Z"));
  assert.equal(cursorCentered.endMs, Date.parse("2026-08-30T21:00:00Z"));
  assert.equal((cursorMs - cursorCentered.startMs) / cursorCentered.durationMs, 0.75);
});

test("zoom clamps at 30 minutes, full range, and master boundaries", () => {
  const master = customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
  const full = createBwcTimeDomain(master);
  const maximumZoom = zoomBwcTimeDomain(full, 10_000);
  assert.equal(maximumZoom.durationMs, 30 * 60 * 1000);
  assert.equal(maximumZoom.startMs, Date.parse("2026-08-30T11:45:00Z"));
  assert.equal(maximumZoom.endMs, Date.parse("2026-08-30T12:15:00Z"));
  assert.equal(maximumZoom.canZoomIn, false);
  assert.deepEqual(zoomBwcTimeDomain(maximumZoom, 2).visible, maximumZoom.visible);

  const fullyOut = zoomBwcTimeDomain(maximumZoom, 0.00001);
  assert.equal(fullyOut.isFullRange, true);
  assert.equal(fullyOut.startMs, full.startMs);
  assert.equal(fullyOut.endMs, full.endMs);

  const atLeft = createBwcTimeDomain(master, customRange("2026-08-30T00:00:00Z", "2026-08-30T06:00:00Z"));
  const leftAnchoredOut = zoomBwcTimeDomain(atLeft, 0.5, 0);
  assert.equal(leftAnchoredOut.startMs, full.startMs);
  assert.equal(leftAnchoredOut.endMs, Date.parse("2026-08-30T12:00:00Z"));
});

test("horizontal pan preserves duration and clamps independently at both master boundaries", () => {
  const master = customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
  const initial = createBwcTimeDomain(master, customRange("2026-08-30T06:00:00Z", "2026-08-30T18:00:00Z"));
  const initialBefore = structuredClone(initial);
  const later = panBwcTimeDomain(initial, 2 * HOUR_MS);
  assert.equal(later.startMs, Date.parse("2026-08-30T08:00:00Z"));
  assert.equal(later.endMs, Date.parse("2026-08-30T20:00:00Z"));
  assert.equal(later.durationMs, initial.durationMs);
  const rightClamp = panBwcTimeDomain(initial, 100 * HOUR_MS);
  assert.equal(rightClamp.startMs, Date.parse("2026-08-30T12:00:00Z"));
  assert.equal(rightClamp.endMs, Date.parse("2026-08-31T00:00:00Z"));
  assert.equal(rightClamp.canPanForward, false);
  const leftClamp = panBwcTimeDomain(initial, -100 * HOUR_MS);
  assert.equal(leftClamp.startMs, Date.parse("2026-08-30T00:00:00Z"));
  assert.equal(leftClamp.endMs, Date.parse("2026-08-30T12:00:00Z"));
  assert.equal(leftClamp.canPanBackward, false);
  assert.deepEqual(initial, initialBefore, "pan must not mutate the previous domain");
});

test("reset restores the full master range without changing minimum zoom policy", () => {
  const master = customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
  const zoomed = zoomBwcTimeDomain(createBwcTimeDomain(master), 8, 0.75);
  const reset = resetBwcTimeDomain(zoomed);
  assert.equal(reset.startMs, Date.parse("2026-08-30T00:00:00Z"));
  assert.equal(reset.endMs, Date.parse("2026-08-31T00:00:00Z"));
  assert.equal(reset.durationMs, 24 * HOUR_MS);
  assert.equal(reset.minVisibleDurationMs, 30 * 60 * 1000);
  assert.equal(reset.isFullRange, true);
});

test("time-domain primitives reject invalid master, visible, zoom, pan, and anchor inputs", () => {
  assert.equal(createBwcTimeDomain({}).error.code, "INVALID_MASTER_DOMAIN");
  assert.equal(
    createBwcTimeDomain(customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z"), {}).error.code,
    "INVALID_VISIBLE_DOMAIN",
  );
  const domain = createBwcTimeDomain(customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z"));
  assert.equal(zoomBwcTimeDomain(domain, 0).error.code, "INVALID_ZOOM_FACTOR");
  assert.equal(zoomBwcTimeDomain(domain, 2, "not a time").error.code, "INVALID_ZOOM_ANCHOR");
  assert.equal(panBwcTimeDomain(domain, Number.NaN).error.code, "INVALID_PAN_DELTA");
  assert.equal(resetBwcTimeDomain({}).error.code, "INVALID_TIME_DOMAIN");
});

test("adaptive UTC ticks select standard intervals and deterministic labels from visible duration", () => {
  const thirtyMinutes = customRange("2026-08-30T02:30:00Z", "2026-08-30T03:00:00Z");
  const closeTicks = selectBwcUtcTicks(thirtyMinutes, { targetCount: 7 });
  assert.equal(closeTicks.ok, true);
  assert.equal(closeTicks.intervalMs, 5 * 60 * 1000);
  assert.deepEqual(closeTicks.ticks.map((tick) => tick.label), [
    "0230Z", "0235Z", "0240Z", "0245Z", "0250Z", "0255Z", "0300Z",
  ]);

  const dayTicks = selectBwcUtcTicks(customRange("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z"), { targetCount: 5 });
  assert.equal(dayTicks.intervalMs, 6 * HOUR_MS);
  assert.equal(dayTicks.ticks[1].label, "30 AUG 0600Z");

  const weekTicks = selectBwcUtcTicks(customRange("2026-08-30T00:00:00Z", "2026-09-06T00:00:00Z"), { targetCount: 5 });
  assert.equal(weekTicks.intervalMs, 2 * DAY_MS);
  assert.match(weekTicks.ticks[0].label, /^\d{2} [A-Z]{3}$/);

  const yearTicks = selectBwcUtcTicks(customRange("2025-08-30T00:00:00Z", "2026-08-30T00:00:00Z"), { targetCount: 5 });
  assert.equal(yearTicks.intervalMs, 90 * DAY_MS);
  assert.match(yearTicks.ticks[0].label, /^[A-Z]{3} \d{4}$/);
  assert.equal(BWC_UTC_TICK_INTERVALS_MS.includes(yearTicks.intervalMs), true);
});

test("pixel-constrained UTC ticks honor minimum spacing and remain epoch-aligned inside the domain", () => {
  const range = customRange("2026-08-01T05:17:00Z", "2026-08-31T05:17:00Z");
  const selected = selectBwcUtcTicks(range, { width: 400, minSpacingPx: 100 });
  assert.equal(selected.targetCount, 5);
  assert.equal(selected.intervalMs, 10 * DAY_MS);
  assert.ok(selected.ticks.length >= 2);
  for (const tick of selected.ticks) {
    assert.ok(tick.timeMs >= Date.parse(range.startZ));
    assert.ok(tick.timeMs <= Date.parse(range.endZ));
    assert.equal(tick.timeMs % selected.intervalMs, 0);
    assert.equal(tick.timeZ, new Date(tick.timeMs).toISOString());
  }
  assert.equal(formatBwcUtcTickLabel("2026-08-30T02:30:00Z", 6 * HOUR_MS), "0230Z");
  assert.equal(formatBwcUtcTickLabel("2026-08-30T02:30:00Z", 24 * HOUR_MS), "30 AUG 0230Z");
  assert.equal(formatBwcUtcTickLabel("2026-08-30T02:30:00Z", 30 * DAY_MS), "30 AUG");
  assert.equal(formatBwcUtcTickLabel("2026-08-30T02:30:00Z", 365 * DAY_MS), "AUG 2026");
});
