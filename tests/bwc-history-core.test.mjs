import test from "node:test";
import assert from "node:assert/strict";

import {
  BWC_CSV_COLUMNS,
  BWC_HISTORY_SCHEMA_VERSION,
  BWC_MIN_VISIBLE_DURATION_MS,
  BWC_RANGE_DURATIONS_MS,
  BWC_RANGES,
  BWC_UTC_TICK_INTERVALS_MS,
  buildBwcTimeline,
  buildBwcCsvExport,
  buildBwcCsvRows,
  buildStepPaths,
  calculateBwcAge,
  calculateBwcStatistics,
  calculateBwcPeakState,
  countSevereEpisodes,
  createBwcTimeDomain,
  describeArchiveAvailability,
  findLastConfirmedChange,
  formatBwcUtcTickLabel,
  formatBwcMemphisTime,
  formatBwcMemphisIsoTime,
  formatBwcDuration,
  formatBwcZuluTime,
  getBwcRange,
  normalizeBwcHistory,
  panBwcTimeDomain,
  parseAhasUtcTimestamp,
  resetBwcTimeDomain,
  selectBwcObservationMarkers,
  selectBwcUtcTicks,
  serializeBwcCsv,
  splitBwcIntervalsByLocalDay,
  summarizeBwcDaily,
  summarizeBwcHistory,
  summarizeBwcMonthly,
  summarizeBwcSeasonal,
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
  const microsecondFirst = parseAhasUtcTimestamp("2026-08-30T02:30:00.123456Z");
  const microsecondSecond = parseAhasUtcTimestamp("2026-08-30T02:30:00.123789Z");
  assert.ok(microsecondFirst > expected);
  assert.ok(microsecondSecond > microsecondFirst);
  assert.ok(Math.abs((microsecondSecond - microsecondFirst) - 0.333) < 0.001);
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

test("optional exact observation ledgers normalize without inventing missing confirmations", () => {
  const complete = normalizeBwcHistory(history([
    stateRun("MODERATE", "2026-08-30T09:00:00Z", "2026-08-30T09:24:00Z", {
      confirmationCount: 3,
      observationsZ: [
        "2026-08-30T09:00:00Z",
        "2026-08-30T09:12:00Z",
        "2026-08-30T09:24:00Z",
      ],
    }),
  ]));
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.value.runs[0].observationsZ, [
    "2026-08-30T09:00:00.000Z",
    "2026-08-30T09:12:00.000Z",
    "2026-08-30T09:24:00.000Z",
  ]);
  assert.equal(complete.value.runs[0].observationsComplete, true);

  const partial = normalizeBwcHistory(history([
    stateRun("SEVERE", "2026-08-30T10:00:00Z", "2026-08-30T10:48:00Z", {
      confirmationCount: 5,
      observationsZ: [
        "2026-08-30T10:00:00Z",
        "2026-08-30T10:30:00Z",
        "2026-08-30T10:48:00Z",
      ],
    }),
  ]));
  assert.equal(partial.ok, true, "a truthful partial ledger remains readable after future appends");
  assert.equal(partial.value.runs[0].observationTimesMs.length, 3);
  assert.equal(partial.value.runs[0].confirmationCount, 5);
  assert.equal(partial.value.runs[0].observationsComplete, false);
  assert.equal(buildBwcTimeline(partial.value, customRange(
    "2026-08-30T09:00:00Z",
    "2026-08-30T12:00:00Z",
  )).ok, true, "normalized partial ledgers can be normalized again by timeline construction");

  const legacy = normalizeBwcHistory(history([
    stateRun("LOW", "2026-08-30T11:00:00Z", "2026-08-30T11:36:00Z", {
      confirmationCount: 4,
    }),
  ]));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.runs[0].observationsZ, undefined);
  assert.deepEqual(legacy.value.runs[0].observationTimesMs, [
    Date.parse("2026-08-30T11:00:00Z"),
    Date.parse("2026-08-30T11:36:00Z"),
  ]);
  assert.equal(legacy.value.runs[0].observationsComplete, false);

  const historicalCount = normalizeBwcHistory(history([
    stateRun("LOW", "2026-08-30T12:00:00Z", "2026-08-30T12:24:00Z", {
      confirmationCount: 1,
      observationsZ: ["2026-08-30T12:00:00Z", "2026-08-30T12:24:00Z"],
    }),
  ]));
  assert.equal(historicalCount.ok, true, "legacy aggregate counts do not invalidate two exact endpoints");
  assert.equal(historicalCount.value.runs[0].confirmationCount, 1);
  assert.deepEqual(historicalCount.value.runs[0].observationsZ, [
    "2026-08-30T12:00:00.000Z",
    "2026-08-30T12:24:00.000Z",
  ]);
  assert.equal(historicalCount.value.runs[0].observationsComplete, false);
});

test("microsecond observations preserve exact ordering, canonical identity, and marker geometry time", () => {
  const first = "2026-08-30T12:00:00.123456Z";
  const second = "2026-08-30T12:00:00.123789Z";
  const normalized = normalizeBwcHistory(history([
    stateRun("SEVERE", first, second, {
      confirmationCount: 2,
      observationsZ: [first, second],
    }),
  ]));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.runs[0].startZ, first);
  assert.deepEqual(normalized.value.runs[0].observationsZ, [first, second]);
  assert.ok(normalized.value.runs[0].observationTimesMs[1] > normalized.value.runs[0].observationTimesMs[0]);

  const timeline = buildBwcTimeline(
    normalized.value,
    customRange("2026-08-30T11:59:59Z", "2026-08-30T12:00:01Z"),
  );
  const selected = selectBwcObservationMarkers(timeline);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.markers.map((marker) => marker.timeZ), [first, second]);
  assert.ok(selected.markers[1].timeMs > selected.markers[0].timeMs);
});

test("exact observation ledgers reject invalid evidence but allow an empty aged-out retention carry-in", () => {
  const base = stateRun("LOW", "2026-08-30T09:00:00Z", "2026-08-30T09:24:00Z", {
    confirmationCount: 2,
  });
  for (const observationsZ of [
    null,
    ["2026-08-30T09:00:00Z", "2026-08-30T09:00:00Z"],
    ["2026-08-30T09:06:00Z", "2026-08-30T09:24:00Z"],
    [],
  ]) {
    assert.equal(
      normalizeBwcHistory(history([{ ...base, observationsZ }])).error.code,
      "INVALID_OBSERVATIONS",
    );
  }

  const carryIn = normalizeBwcHistory(history([
    stateRun("LOW", "2026-08-30T10:00:00Z", "2026-08-30T09:30:00Z", {
      firstObservedZ: "2026-08-30T09:00:00Z",
      firstRecordedZ: "2026-08-30T09:01:00Z",
      lastRecordedZ: "2026-08-30T09:31:00Z",
      confirmationCount: 4,
      observationsZ: [],
      startReason: "RETENTION_CARRY_IN",
    }),
  ], { collectionStartedZ: "2026-08-30T09:01:00Z" }));
  assert.equal(carryIn.ok, true);
  assert.deepEqual(carryIn.value.runs[0].observationsZ, []);
  assert.deepEqual(carryIn.value.runs[0].observationTimesMs, []);

  const impossibleAgedOutCarryIn = normalizeBwcHistory(history([
    stateRun("LOW", "2026-08-30T10:00:00Z", "2026-08-30T09:30:00Z", {
      firstObservedZ: "2026-08-30T09:00:00Z",
      confirmationCount: 4,
      observationsZ: ["2026-08-30T10:12:00Z"],
      startReason: "RETENTION_CARRY_IN",
    }),
  ]));
  assert.equal(impossibleAgedOutCarryIn.ok, false);
  assert.equal(impossibleAgedOutCarryIn.error.code, "INVALID_OBSERVATIONS");

  const invalidEmptyCarryIn = normalizeBwcHistory(history([
    stateRun("LOW", "2026-08-30T10:00:00Z", "2026-08-30T10:12:00Z", {
      firstObservedZ: "2026-08-30T09:00:00Z",
      confirmationCount: 4,
      observationsZ: [],
      startReason: "RETENTION_CARRY_IN",
    }),
  ]));
  assert.equal(invalidEmptyCarryIn.ok, false);
  assert.equal(invalidEmptyCarryIn.error.code, "INVALID_OBSERVATIONS");

  const crossingCutoff = normalizeBwcHistory(history([
    stateRun("MODERATE", "2026-08-30T10:00:00Z", "2026-08-30T10:24:00Z", {
      firstObservedZ: "2026-08-30T09:30:00Z",
      firstRecordedZ: "2026-08-30T09:31:00Z",
      lastRecordedZ: "2026-08-30T10:25:00Z",
      confirmationCount: 5,
      observationsZ: ["2026-08-30T10:12:00Z", "2026-08-30T10:24:00Z"],
      startReason: "RETENTION_CARRY_IN",
    }),
  ], { collectionStartedZ: "2026-08-30T09:31:00Z" }));
  assert.equal(crossingCutoff.ok, true);
  assert.deepEqual(crossingCutoff.value.runs[0].observationsZ, [
    "2026-08-30T10:12:00.000Z",
    "2026-08-30T10:24:00.000Z",
  ]);
  assert.equal(crossingCutoff.value.runs[0].observationsComplete, false);
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

test("six-minute severe replay preserves exact geometry, duration, analytics, and CSV truth", () => {
  const payload = history([
    stateRun("MODERATE", "2026-08-30T09:00:00Z", "2026-08-30T09:00:00Z", { startReason: "ARCHIVE_START" }),
    stateRun("SEVERE", "2026-08-30T09:38:00Z"),
    stateRun("MODERATE", "2026-08-30T09:44:00Z"),
  ], { collectionStartedZ: "2026-08-30T09:00:00Z" });
  const timeline = buildBwcTimeline(
    payload,
    customRange("2026-08-30T09:00:00Z", "2026-08-30T11:00:00Z"),
  );
  assert.equal(timeline.ok, true);
  assert.deepEqual(timeline.segments.map((segment) => [segment.state, segment.startZ, segment.endZ]), [
    ["MODERATE", "2026-08-30T09:00:00.000Z", "2026-08-30T09:38:00.000Z"],
    ["SEVERE", "2026-08-30T09:38:00.000Z", "2026-08-30T09:44:00.000Z"],
    ["MODERATE", "2026-08-30T09:44:00.000Z", "2026-08-30T11:00:00.000Z"],
  ]);
  const severe = timeline.segments[1];
  assert.equal(severe.endMs - severe.startMs, 6 * 60_000);

  const chart = buildStepPaths(timeline, {
    width: 820,
    height: 286,
    padding: { left: 84, right: 14, top: 18, bottom: 34 },
  });
  assert.equal(chart.ok, true);
  assert.deepEqual(chart.paths.map((path) => path.d), [
    "M 84 135 H 312.633",
    "M 312.633 135 V 18 H 348.733",
    "M 348.733 18 V 135 H 806",
  ]);
  assert.deepEqual(chart.transitions.map((transition) => [
    transition.atZ,
    transition.fromState,
    transition.toState,
    transition.confirmed,
  ]), [
    ["2026-08-30T09:38:00.000Z", "MODERATE", "SEVERE", true],
    ["2026-08-30T09:44:00.000Z", "SEVERE", "MODERATE", true],
  ]);

  const statistics = calculateBwcStatistics(timeline);
  assert.equal(statistics.durationsMs.SEVERE, 6 * 60_000);
  assert.equal(statistics.durationsMs.MODERATE, 114 * 60_000);
  assert.equal(statistics.durationsMs.UNKNOWN, 0);
  assert.equal(statistics.percentages.SEVERE, 5);
  assert.equal(statistics.percentages.MODERATE, 95);
  assert.equal(statistics.coveragePercent, 100);
  assert.equal(statistics.changeCount, 2);
  assert.equal(statistics.severeEpisodes, 1);
  assert.equal(statistics.lastConfirmedChange.atZ, "2026-08-30T09:44:00.000Z");
  assert.equal(formatBwcDuration(statistics.durationsMs.SEVERE), "6 MIN");

  const csv = buildBwcCsvRows(timeline);
  const severeInterval = csv.rows.find((row) => row.record_type === "STATE" && row.state === "SEVERE");
  assert.equal(severeInterval.start_utc, "2026-08-30T09:38:00.000Z");
  assert.equal(severeInterval.end_utc, "2026-08-30T09:44:00.000Z");
  assert.equal(severeInterval.duration_minutes, "6");
  assert.equal(csv.rows.filter((row) => row.record_type === "OBSERVATION").length, 3);
});

test("sub-minute and long severe events retain their actual widths and statistics", () => {
  function replay(secondStartZ, secondEndZ) {
    const payload = history([
      stateRun("MODERATE", "2026-08-30T09:00:00Z", "2026-08-30T09:00:00Z", { startReason: "ARCHIVE_START" }),
      stateRun("SEVERE", secondStartZ),
      stateRun("MODERATE", secondEndZ),
    ], { collectionStartedZ: "2026-08-30T09:00:00Z" });
    return buildBwcTimeline(payload, customRange("2026-08-30T09:00:00Z", "2026-08-30T11:00:00Z"));
  }

  const subMinute = replay("2026-08-30T09:38:00Z", "2026-08-30T09:38:30Z");
  const subMinuteStats = calculateBwcStatistics(subMinute);
  assert.equal(subMinuteStats.durationsMs.SEVERE, 30_000);
  assert.equal(formatBwcDuration(subMinuteStats.durationsMs.SEVERE), "<1 MIN");
  assert.equal(subMinuteStats.changeCount, 2);
  assert.equal(subMinuteStats.severeEpisodes, 1);
  const subMinuteChart = buildStepPaths(subMinute, {
    width: 820, height: 286, padding: { left: 84, right: 14, top: 18, bottom: 34 },
  });
  const subMinutePath = subMinuteChart.paths.find((path) => path.state === "SEVERE");
  const [, subStart, subEnd] = subMinutePath.d.match(/^M ([\d.]+) [\d.]+(?: V [\d.]+)? H ([\d.]+)$/) || [];
  assert.ok(Number(subEnd) > Number(subStart), "a real sub-minute episode keeps a nonzero proportional width");

  const long = replay("2026-08-30T09:30:00Z", "2026-08-30T10:30:00Z");
  const longStats = calculateBwcStatistics(long);
  assert.equal(longStats.durationsMs.SEVERE, 60 * 60_000);
  assert.equal(longStats.percentages.SEVERE, 50);
  assert.equal(longStats.changeCount, 2);
  const longChart = buildStepPaths(long, {
    width: 820, height: 286, padding: { left: 84, right: 14, top: 18, bottom: 34 },
  });
  const longPath = longChart.paths.find((path) => path.state === "SEVERE");
  const [, longStart, longEnd] = longPath.d.match(/^M ([\d.]+) [\d.]+(?: V [\d.]+)? H ([\d.]+)$/) || [];
  assert.ok(Math.abs((Number(longEnd) - Number(longStart)) - 361) < 0.001, "one hour occupies exactly half the two-hour plot");
});

test("timeline and chart APIs fail closed on malformed inputs", () => {
  assert.equal(buildBwcTimeline({ schemaVersion: 99 }, "24h").error.code, "UNSUPPORTED_SCHEMA");
  assert.equal(buildBwcTimeline(history(), "made-up").error.code, "INVALID_RANGE");
  assert.equal(calculateBwcStatistics({}).error.code, "INVALID_TIMELINE");
  assert.equal(buildStepPaths({}, {}).error.code, "INVALID_TIMELINE");
  const timeline = buildBwcTimeline(history(), customRange("2026-08-30T08:00:00Z", "2026-08-30T09:00:00Z"));
  assert.equal(buildStepPaths(timeline, { width: 20, height: 20, padding: { left: 15, right: 15 } }).error.code, "INVALID_DIMENSIONS");
});

test("observation markers preserve every exact in-range state timestamp and never decorate gaps", () => {
  const payload = history([
    stateRun("LOW", "2026-08-30T08:00:00Z", "2026-08-30T08:24:00Z", {
      confirmationCount: 3,
      observationsZ: [
        "2026-08-30T08:00:00Z",
        "2026-08-30T08:12:00Z",
        "2026-08-30T08:24:00Z",
      ],
    }),
    unknownRun("2026-08-30T09:54:00Z", "2026-08-30T10:30:00Z", {
      reason: "COVERAGE_GAP",
      firstObservedZ: "",
      lastObservedZ: "",
      firstRecordedZ: "",
      lastRecordedZ: "",
      confirmationCount: 0,
    }),
    stateRun("SEVERE", "2026-08-30T10:30:00Z", "2026-08-30T10:42:00Z", {
      confirmationCount: 2,
      observationsZ: ["2026-08-30T10:30:00Z", "2026-08-30T10:42:00Z"],
      startReason: "STATE_AFTER_GAP",
    }),
    stateRun("MODERATE", "2026-08-30T11:00:00Z", "2026-08-30T11:36:00Z", {
      confirmationCount: 4,
    }),
  ]);
  const timeline = buildBwcTimeline(
    payload,
    customRange("2026-08-30T07:30:00Z", "2026-08-30T12:00:00Z"),
  );
  const selected = selectBwcObservationMarkers(timeline);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.markers.map((marker) => [marker.state, marker.timeZ]), [
    ["LOW", "2026-08-30T08:00:00.000Z"],
    ["LOW", "2026-08-30T08:12:00.000Z"],
    ["LOW", "2026-08-30T08:24:00.000Z"],
    ["SEVERE", "2026-08-30T10:30:00.000Z"],
    ["SEVERE", "2026-08-30T10:42:00.000Z"],
    ["MODERATE", "2026-08-30T11:00:00.000Z"],
    ["MODERATE", "2026-08-30T11:36:00.000Z"],
  ]);
  assert.equal(selected.markers.some((marker) => marker.kind === "UNKNOWN"), false);
  assert.equal(
    selected.markers.filter((marker) => marker.state === "MODERATE").length,
    2,
    "legacy confirmationCount does not create guessed intermediate points",
  );
});

test("dense observation selection is deterministic and does not sample exact evidence", () => {
  const startMs = Date.parse("2026-08-30T00:00:00Z");
  const observationsZ = Array.from({ length: 240 }, (_value, index) => (
    new Date(startMs + index * 60_000).toISOString()
  ));
  const payload = history([
    stateRun("MODERATE", observationsZ[0], observationsZ.at(-1), {
      confirmationCount: observationsZ.length,
      observationsZ,
    }),
  ]);
  const timeline = buildBwcTimeline(
    payload,
    customRange("2026-08-30T00:00:00Z", "2026-08-30T04:00:00Z"),
  );
  const selected = selectBwcObservationMarkers(timeline);
  assert.equal(selected.ok, true);
  assert.equal(selected.markers.length, observationsZ.length);
  assert.deepEqual(
    selected.markers.map((marker) => marker.timeZ),
    observationsZ.map((value) => new Date(value).toISOString()),
  );
});

test("annual observation ledgers normalize once and binary-select exact inclusive ranges", () => {
  const count = 52_560;
  const intervalMs = 10 * 60_000;
  const startMs = Date.parse("2025-08-30T00:00:00Z");
  const observationsZ = Array.from({ length: count }, (_value, index) => (
    new Date(startMs + index * intervalMs).toISOString()
  ));
  const payload = history([
    stateRun("MODERATE", observationsZ[0], observationsZ.at(-1), {
      confirmationCount: observationsZ.length,
      observationsZ,
      basis: "NEXBAM",
      basisClass: "MODEL_OPERATIONAL",
    }),
  ], {
    collectionStartedZ: observationsZ[0],
    archiveUpdatedZ: observationsZ.at(-1),
  });

  const normalized = normalizeBwcHistory(payload);
  assert.equal(normalized.ok, true);
  assert.equal(Object.isFrozen(normalized.value), true);
  assert.equal(Object.isFrozen(normalized.value.sourceArea), true);
  assert.equal(Object.isFrozen(normalized.value.runs), true);
  assert.equal(Object.isFrozen(normalized.value.runs[0]), true);
  assert.equal(Object.isFrozen(normalized.value.runs[0].observationsZ), true);
  assert.equal(Object.isFrozen(normalized.value.runs[0].observationTimesMs), true);
  assert.throws(() => { normalized.value.station = "KATL"; }, TypeError);
  assert.throws(() => { normalized.value.runs[0].observationTimesMs[0] = 0; }, TypeError);
  assert.strictEqual(
    normalizeBwcHistory(normalized.value).value,
    normalized.value,
    "validated numeric ledgers are reused by identity",
  );

  const firstIndex = 10_000;
  const lastIndex = 14_320;
  const timeline = buildBwcTimeline(
    normalized.value,
    customRange(observationsZ[firstIndex], observationsZ[lastIndex]),
  );
  assert.strictEqual(timeline.history, normalized.value);
  const selected = selectBwcObservationMarkers(timeline);
  assert.equal(selected.ok, true);
  assert.equal(selected.markers.length, lastIndex - firstIndex + 1);
  assert.equal(selected.markers[0].timeZ, observationsZ[firstIndex]);
  assert.equal(selected.markers.at(-1).timeZ, observationsZ[lastIndex]);
  const selectedAgain = selectBwcObservationMarkers(timeline);
  assert.strictEqual(selectedAgain.markers[0], selected.markers[0], "the cached marker index reuses evidence objects");
  assert.notStrictEqual(selectedAgain.markers, selected.markers, "each range result owns its slice array");
  assert.equal(Object.isFrozen(selected.markers[0]), true);
  assert.throws(() => { selected.markers[0].timeMs = 0; }, TypeError);

  const rawMutation = structuredClone(payload);
  assert.equal(normalizeBwcHistory(rawMutation).ok, true);
  rawMutation.station = "KATL";
  assert.equal(
    normalizeBwcHistory(rawMutation).ok,
    false,
    "the same raw caller object is revalidated rather than cached",
  );
});

test("exact observation markers remain available in every supported rolling range", () => {
  const now = "2026-08-30T12:00:00Z";
  const payload = history([
    stateRun("LOW", "2026-08-30T00:00:00Z", "2026-08-30T06:00:00Z", {
      confirmationCount: 2,
      observationsZ: ["2026-08-30T00:00:00Z", "2026-08-30T06:00:00Z"],
    }),
  ]);
  for (const rangeKey of ["24h", "7d", "30d", "90d", "365d"]) {
    const selected = selectBwcObservationMarkers(buildBwcTimeline(payload, rangeKey, now));
    assert.equal(selected.ok, true, rangeKey);
    assert.deepEqual(selected.markers.map((marker) => marker.timeZ), [
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T06:00:00.000Z",
    ], rangeKey);
  }
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

test("Memphis local-day splitting uses true 23-hour spring and 25-hour fall DST days", () => {
  const springTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-03-08T06:00:00Z", "2026-03-09T03:30:00Z", {
      confirmationCount: 2,
    }),
  ]), customRange("2026-03-08T06:00:00Z", "2026-03-09T05:00:00Z"));
  const spring = splitBwcIntervalsByLocalDay(springTimeline);
  assert.equal(spring.ok, true);
  assert.equal(spring.days.length, 1);
  assert.equal(spring.days[0].key, "2026-03-08");
  assert.equal(spring.days[0].startMs, Date.parse("2026-03-08T06:00:00Z"));
  assert.equal(spring.days[0].endMs, Date.parse("2026-03-09T05:00:00Z"));
  assert.equal(spring.days[0].calendarDurationMs, 23 * HOUR_MS);

  const fallTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-11-01T05:00:00Z", "2026-11-02T04:30:00Z", {
      confirmationCount: 2,
    }),
  ]), customRange("2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z"));
  const fall = summarizeBwcDaily(fallTimeline);
  assert.equal(fall.ok, true);
  assert.equal(fall.summaries.length, 1);
  assert.equal(fall.summaries[0].calendarDurationMs, 25 * HOUR_MS);
  assert.equal(fall.summaries[0].representedMs, 25 * HOUR_MS);
  assert.equal(fall.summaries[0].representedDays, 1);
  assert.equal(fall.summaries[0].percentages.LOW, 100);
});

test("daily summaries preserve durations, UNKNOWN, peak, changes, episodes, and exact observations", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T05:00:00Z", "2026-08-30T05:30:00Z", { confirmationCount: 2 }),
    stateRun("MODERATE", "2026-08-30T07:00:00Z", "2026-08-30T07:30:00Z", { confirmationCount: 2 }),
    unknownRun("2026-08-30T09:00:00Z", "2026-08-30T10:00:00Z"),
    stateRun("SEVERE", "2026-08-30T10:00:00Z", "2026-08-30T10:30:00Z", {
      confirmationCount: 2,
      startReason: "STATE_AFTER_GAP",
    }),
    stateRun("LOW", "2026-08-30T12:00:00Z", "2026-08-31T03:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-31T05:00:00Z"));
  const daily = summarizeBwcDaily(timeline);
  assert.equal(daily.ok, true);
  assert.equal(daily.timeZone, "America/Chicago");
  assert.equal(daily.summaries.length, 1);
  const summary = daily.summaries[0];
  assert.equal(summary.key, "2026-08-30");
  assert.equal(summary.durationsMs.LOW, 19 * HOUR_MS);
  assert.equal(summary.durationsMs.MODERATE, 2 * HOUR_MS);
  assert.equal(summary.durationsMs.SEVERE, 2 * HOUR_MS);
  assert.equal(summary.durationsMs.UNKNOWN, HOUR_MS);
  assert.equal(summary.knownCoverageMs, 23 * HOUR_MS);
  assert.equal(summary.coveragePercent, (23 / 24) * 100);
  assert.ok(Math.abs(Object.values(summary.percentages).reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
  assert.equal(summary.peakState, "SEVERE");
  assert.equal(summary.changeCount, 2);
  assert.equal(summary.severeEpisodes, 1);
  assert.equal(summary.observationCount, 8);
  assert.equal(summary.calendarWindowComplete, true);
  assert.equal(summary.isPartial, true, "represented UNKNOWN prevents a complete-data claim");
  assert.equal(formatBwcDuration(summary.durationsMs.SEVERE), "2 HR");
});

test("daily peak ranks known states and remains UNKNOWN for an entirely unknown day", () => {
  assert.equal(calculateBwcPeakState({ LOW: 1, MODERATE: 0, SEVERE: 0 }), "LOW");
  assert.equal(calculateBwcPeakState({ LOW: 10, MODERATE: 1, SEVERE: 0 }), "MODERATE");
  assert.equal(calculateBwcPeakState({ LOW: 10, MODERATE: 10, SEVERE: 1 }), "SEVERE");
  assert.equal(calculateBwcPeakState({ LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 99 }), "UNKNOWN");
  assert.equal(formatBwcDuration(30_000), "<1 MIN");
  assert.equal(formatBwcDuration((2 * 60 + 24) * 60_000), "2 HR 24 MIN");

  const allUnknown = summarizeBwcDaily(buildBwcTimeline(history([
    unknownRun("2026-08-30T05:00:00Z", "2026-08-31T05:00:00Z"),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-31T05:00:00Z"))).summaries[0];
  assert.equal(allUnknown.peakState, "UNKNOWN");
  assert.equal(allUnknown.durationsMs.UNKNOWN, 24 * HOUR_MS);
  assert.equal(allUnknown.coveragePercent, 0);
  assert.equal(allUnknown.percentages.UNKNOWN, 100);
  assert.equal(allUnknown.observationCount, 0);
});

test("summary representation excludes BEFORE_ARCHIVE but retains later unknown coverage", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T17:00:00Z", "2026-08-30T17:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-31T05:00:00Z"));
  const summary = summarizeBwcDaily(timeline).summaries[0];
  assert.equal(summary.representedStartMs, Date.parse("2026-08-30T17:00:00Z"));
  assert.equal(summary.representedEndMs, Date.parse("2026-08-31T05:00:00Z"));
  assert.equal(summary.representedMs, 12 * HOUR_MS);
  assert.equal(summary.representedDays, 0.5);
  assert.equal(summary.durationsMs.LOW, 2 * HOUR_MS);
  assert.equal(summary.durationsMs.UNKNOWN, 10 * HOUR_MS);
  assert.equal(summary.coveragePercent, (2 / 12) * 100);
  assert.equal(summary.calendarWindowComplete, false);
  assert.equal(summary.isPartial, true);
});

test("summary representation begins exactly at collection start when a leading segment straddles it", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T18:00:00Z", "2026-08-30T18:30:00Z", { confirmationCount: 2 }),
  ], { collectionStartedZ: "2026-08-30T17:00:00Z" }), customRange(
    "2026-08-30T05:00:00Z",
    "2026-08-31T05:00:00Z",
  ));
  const summary = summarizeBwcDaily(timeline).summaries[0];
  assert.equal(summary.representedStartMs, Date.parse("2026-08-30T17:00:00Z"));
  assert.equal(summary.representedEndMs, Date.parse("2026-08-31T05:00:00Z"));
  assert.equal(summary.representedMs, 12 * HOUR_MS);
  assert.equal(summary.durationsMs.LOW, 2 * HOUR_MS);
  assert.equal(summary.durationsMs.UNKNOWN, 10 * HOUR_MS);
  assert.equal(summary.percentages.UNKNOWN, (10 / 12) * 100);
});

test("a confirmed transition on selected-range and local-midnight boundary belongs to the new day", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T04:00:00Z", "2026-08-30T04:00:00Z"),
    stateRun("MODERATE", "2026-08-30T05:00:00Z", "2026-08-30T07:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-30T09:00:00Z"));
  const summary = summarizeBwcDaily(timeline).summaries[0];
  assert.equal(summary.key, "2026-08-30");
  assert.equal(summary.changeCount, 1);
  assert.equal(summary.peakState, "MODERATE");
  assert.equal(summary.observationCount, 2);
});

test("monthly summaries use Memphis month boundaries and duration-based severe days and percentages", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-31T05:00:00Z", "2026-09-01T03:30:00Z", { confirmationCount: 2 }),
    stateRun("SEVERE", "2026-09-01T05:00:00Z", "2026-09-02T03:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-08-31T05:00:00Z", "2026-09-02T05:00:00Z"));
  const monthly = summarizeBwcMonthly(timeline);
  assert.equal(monthly.ok, true);
  assert.deepEqual(monthly.summaries.map((summary) => summary.key), ["2026-08", "2026-09"]);
  const august = monthly.summaries[0];
  const september = monthly.summaries[1];
  assert.equal(august.durationsMs.LOW, 24 * HOUR_MS);
  assert.equal(august.peakState, "LOW");
  assert.equal(august.severeDays, 0);
  assert.equal(august.representedDays, 1);
  assert.equal(august.isPartial, true);
  assert.equal(september.durationsMs.SEVERE, 24 * HOUR_MS);
  assert.equal(september.percentages.SEVERE, 100);
  assert.equal(september.peakState, "SEVERE");
  assert.equal(september.severeDays, 1);
  assert.equal(september.severeEpisodes, 1);
  assert.equal(september.changeCount, 1);
  assert.equal(september.observationCount, 2);
  assert.equal(september.representedDays, 1);
});

test("local leap day and year boundaries produce distinct daily and monthly buckets", () => {
  const leapTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2028-02-28T06:00:00Z", "2028-03-01T04:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2028-02-28T06:00:00Z", "2028-03-01T06:00:00Z"));
  assert.deepEqual(summarizeBwcDaily(leapTimeline).summaries.map((summary) => summary.key), [
    "2028-02-28", "2028-02-29",
  ]);
  const february = summarizeBwcMonthly(leapTimeline).summaries[0];
  assert.equal(february.key, "2028-02");
  assert.equal(february.representedDays, 2);
  assert.equal(february.durationsMs.LOW, 48 * HOUR_MS);

  const yearTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-12-31T06:00:00Z", "2027-01-01T04:30:00Z", { confirmationCount: 2 }),
    stateRun("MODERATE", "2027-01-01T06:00:00Z", "2027-01-02T04:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-12-31T06:00:00Z", "2027-01-02T06:00:00Z"));
  assert.deepEqual(summarizeBwcMonthly(yearTimeline).summaries.map((summary) => summary.key), [
    "2026-12", "2027-01",
  ]);
});

test("meteorological seasons group DJF across years and MAM/JJA/SON with honest completeness", () => {
  const startZ = "2025-12-01T06:00:00Z";
  const endZ = "2026-12-01T06:00:00Z";
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", startZ, "2026-12-01T04:30:00Z", { confirmationCount: 52560 }),
  ]), customRange(startZ, endZ));
  const seasonal = summarizeBwcSeasonal(timeline);
  assert.equal(seasonal.ok, true);
  assert.deepEqual(seasonal.summaries.map((summary) => summary.label), [
    "WINTER 2025\u201326", "SPRING 2026", "SUMMER 2026", "FALL 2026",
  ]);
  const winter = seasonal.summaries[0];
  assert.deepEqual(winter.monthKeys, ["2025-12", "2026-01", "2026-02"]);
  assert.equal(winter.startZ, "2025-12-01T06:00:00.000Z");
  assert.equal(winter.endZ, "2026-03-01T06:00:00.000Z");
  assert.equal(winter.peakState, "LOW");
  assert.equal(winter.coveragePercent, 100);
  assert.equal(winter.isComplete, true);
  assert.equal(seasonal.summaries.every((summary) => summary.isComplete), true);
  assert.equal(seasonal.summaries.reduce((sum, summary) => sum + summary.representedDays, 0), 365);

  const partial = summarizeBwcSeasonal(buildBwcTimeline(history([
    stateRun("SEVERE", "2026-07-15T05:00:00Z", "2026-07-16T03:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-07-15T05:00:00Z", "2026-07-16T05:00:00Z"))).summaries[0];
  assert.equal(partial.label, "SUMMER 2026");
  assert.equal(partial.representedDays, 1);
  assert.equal(partial.severeDays, 1);
  assert.equal(partial.isPartial, true);
  assert.equal(partial.calendarWindowComplete, false);
});

test("combined summary computes daily, monthly, and seasonal views from one selected timeline", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("MODERATE", "2026-08-30T05:00:00Z", "2026-08-31T03:30:00Z", { confirmationCount: 2 }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-31T05:00:00Z"));
  const summary = summarizeBwcHistory(timeline);
  assert.equal(summary.ok, true);
  assert.equal(summary.timeZone, "America/Chicago");
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.monthly.length, 1);
  assert.equal(summary.seasonal.length, 1);
  assert.equal(summary.daily[0].peakState, "MODERATE");
});

test("CSV rows preserve selected STATE/UNKNOWN intervals and exact retained observations only", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T05:00:00Z", "2026-08-30T06:00:00Z", {
      confirmationCount: 5,
      basis: "NEXBAM",
      basisClass: "MODEL_OPERATIONAL",
    }),
    unknownRun("2026-08-30T07:30:00Z", "2026-08-30T08:00:00Z"),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-30T08:00:00Z"));
  const csv = buildBwcCsvRows(timeline);
  assert.equal(csv.ok, true);
  assert.deepEqual(csv.columns, BWC_CSV_COLUMNS);
  assert.deepEqual(csv.rows.map((row) => row.record_type), [
    "STATE", "OBSERVATION", "OBSERVATION", "UNKNOWN",
  ]);
  const observations = csv.rows.filter((row) => row.record_type === "OBSERVATION");
  assert.deepEqual(observations.map((row) => row.observation_utc), [
    "2026-08-30T05:00:00.000Z", "2026-08-30T06:00:00.000Z",
  ]);
  assert.equal(observations.length, 2, "legacy confirmationCount does not generate three missing timestamps");
  assert.equal(observations[0].observation_local, "2026-08-30T00:00:00.000-05:00");
  const state = csv.rows.find((row) => row.record_type === "STATE");
  assert.equal(state.start_utc, "2026-08-30T05:00:00.000Z");
  assert.equal(state.end_utc, "2026-08-30T07:30:00.000Z");
  assert.equal(state.duration_minutes, "150");
  assert.equal(state.basis, "NEXBAM");
  const unknown = csv.rows.find((row) => row.record_type === "UNKNOWN");
  assert.equal(unknown.state, "UNKNOWN");
  assert.equal(unknown.known_coverage, "UNKNOWN");
  assert.equal(unknown.notes, "SOURCE_NO_DATA");
  assert.equal(csv.rows.some((row) => "host" in row || "lease" in row || "heartbeat" in row), false);
});

test("CSV exact evidence is half-open and an empty retention carry-in ledger exports no observations", () => {
  const endBoundaryTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T05:00:00Z", "2026-08-30T08:00:00Z", {
      confirmationCount: 2,
      observationsZ: ["2026-08-30T05:00:00Z", "2026-08-30T08:00:00Z"],
      hiddenHostMetadata: "DO_NOT_EXPORT",
    }),
  ], { hostStatus: "PRIMARY_SECRET" }), customRange("2026-08-30T05:00:00Z", "2026-08-30T08:00:00Z"));
  const boundaryRows = buildBwcCsvRows(endBoundaryTimeline).rows;
  assert.deepEqual(boundaryRows.filter((row) => row.record_type === "OBSERVATION")
    .map((row) => row.observation_utc), ["2026-08-30T05:00:00.000Z"]);
  const boundaryContent = serializeBwcCsv(BWC_CSV_COLUMNS, boundaryRows);
  assert.equal(boundaryContent.includes("DO_NOT_EXPORT"), false);
  assert.equal(boundaryContent.includes("PRIMARY_SECRET"), false);
  assert.equal(boundaryContent.includes("hiddenHostMetadata"), false);

  const carryInTimeline = buildBwcTimeline(history([
    stateRun("LOW", "2026-08-30T05:00:00Z", "2026-08-30T04:30:00Z", {
      startReason: "RETENTION_CARRY_IN",
      firstObservedZ: "2026-08-29T04:30:00Z",
      firstRecordedZ: "2026-08-29T04:31:00Z",
      lastRecordedZ: "2026-08-30T04:31:00Z",
      confirmationCount: 144,
      observationsZ: [],
    }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-30T06:00:00Z"));
  assert.equal(carryInTimeline.ok, true);
  assert.equal(
    buildBwcCsvRows(carryInTimeline).rows.filter((row) => row.record_type === "OBSERVATION").length,
    0,
  );

  const continuedTimeline = buildBwcTimeline(history([
    stateRun("MODERATE", "2026-08-30T04:00:00Z", "2026-08-30T06:00:00Z", {
      confirmationCount: 2,
    }),
  ]), customRange("2026-08-30T05:00:00Z", "2026-08-30T07:00:00Z"));
  const continuedState = buildBwcCsvRows(continuedTimeline).rows
    .find((row) => row.record_type === "STATE");
  assert.equal(continuedState.start_utc, "2026-08-30T05:00:00.000Z");
  assert.equal(continuedState.start_reason, "STATE_CHANGE");
  assert.equal(continuedState.notes, "CONTINUATION_FROM_BEFORE_SELECTED_RANGE");
});

test("CSV serialization quotes Excel fields and blocks formula injection without altering ISO timestamps", () => {
  const columns = ["value", "note"];
  const content = serializeBwcCsv(columns, [
    { value: "=2+2", note: "comma, newline\nquoted \"text\"" },
    { value: "  @SUM(A1:A2)", note: "+cmd" },
    { value: "2026-08-30T05:00:00.000Z", note: "safe" },
  ]);
  assert.match(content, /"'=2\+2"/);
  assert.match(content, /"'  @SUM\(A1:A2\)"/);
  assert.match(content, /"'\+cmd"/);
  assert.match(content, /"comma, newline\nquoted ""text"""/);
  assert.match(content, /2026-08-30T05:00:00\.000Z/);
  assert.equal(content.includes("\r\n"), true);
});

test("CSV export uses BOM, useful selected-range filename, and unambiguous repeated local timestamps", () => {
  const timeline = buildBwcTimeline(history([
    stateRun("MODERATE", "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", {
      confirmationCount: 2,
      observationsZ: ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"],
    }),
  ]), { ...customRange("2026-11-01T06:00:00Z", "2026-11-02T06:00:00Z"), key: "24h", label: "24 HR" });
  assert.equal(formatBwcMemphisIsoTime("2026-11-01T06:30:00Z"), "2026-11-01T01:30:00.000-05:00");
  assert.equal(formatBwcMemphisIsoTime("2026-11-01T07:30:00Z"), "2026-11-01T01:30:00.000-06:00");
  const exported = buildBwcCsvExport(timeline);
  assert.equal(exported.ok, true);
  assert.equal(exported.filename, "KMEM_BWC_HISTORY_2026-11-02_24HR.csv");
  assert.equal(exported.mimeType, "text/csv;charset=utf-8");
  assert.equal(exported.content.startsWith("\uFEFFrecord_type,"), true);
  assert.equal(exported.content.includes("2026-11-01T01:30:00.000-05:00"), true);
  assert.equal(exported.content.includes("2026-11-01T01:30:00.000-06:00"), true);
  assert.equal(formatBwcMemphisIsoTime("2026-11-01T06:30:00.123456Z"), "2026-11-01T01:30:00.123456-05:00");
});

test("annual summary remains practical with 52,560 exact observations", () => {
  const count = 52_560;
  const startMs = Date.parse("2025-08-30T05:00:00Z");
  const endMs = startMs + 365 * DAY_MS;
  const observationsZ = Array.from({ length: count }, (_value, index) => (
    new Date(startMs + index * 10 * 60_000).toISOString()
  ));
  const timeline = buildBwcTimeline(history([
    stateRun("LOW", observationsZ[0], observationsZ.at(-1), {
      confirmationCount: count,
      observationsZ,
    }),
  ], {
    collectionStartedZ: observationsZ[0],
    archiveUpdatedZ: observationsZ.at(-1),
  }), customRange(new Date(startMs).toISOString(), new Date(endMs).toISOString()));
  const started = performance.now();
  const summary = summarizeBwcHistory(timeline);
  const elapsedMs = performance.now() - started;
  assert.equal(summary.ok, true);
  assert.equal(summary.daily.length, 365);
  assert.equal(summary.daily.reduce((sum, day) => sum + day.observationCount, 0), count);
  assert.equal(summary.daily.reduce((sum, day) => sum + day.representedDays, 0), 365);
  assert.ok(elapsedMs < 5000, `annual summaries took ${elapsedMs.toFixed(0)} ms`);
});
