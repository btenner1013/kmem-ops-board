import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_HEALTH_RANGES,
  buildHostHealthTimeline,
  calculateHostHealthMetrics,
  createHostHealthTimeDomain,
  deriveHostHealthCurrent,
  formatHostHealthDuration,
  formatHostHealthTime,
  getHostHealthRange,
  normalizeHostHealthHistory,
  panHostHealthTimeDomain,
  parseHostHealthUtc,
  resetHostHealthTimeDomain,
  selectHostHealthTicks,
  zoomHostHealthTimeDomain,
} from "../host-health-core.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = "2026-09-09T10:00:00Z";

function interval(track, state, startUtc, endUtc, extra = {}) {
  return { track, state, startUtc, endUtc, reason: `${state} OBSERVED`, ...extra };
}

function event(eventType, timestampUtc, extra = {}) {
  return { eventType, timestampUtc, reason: `${eventType} OBSERVED`, ...extra };
}

function exactArchive(overrides = {}) {
  return {
    schemaVersion: 1,
    retentionDays: 365,
    archiveStartedUtc: "2026-09-08T10:00:00Z",
    coverageStartUtc: "2026-09-08T10:00:00Z",
    updatedUtc: NOW,
    partialHistory: true,
    thresholds: { healthyMinutes: 15, failoverMinutes: 25 },
    hosts: {
      PRIMARY: {
        role: "PRIMARY", healthState: "STALE", roleState: "STANDBY", reason: "HEARTBEAT STALE",
        heartbeatAgeMinutes: 118, lastHeartbeatUtc: "2026-09-09T08:02:00Z",
        lastSuccessfulUpdaterRunUtc: "2026-09-09T07:55:00Z", lastSuccessfulPushUtc: "2026-09-09T07:55:00Z",
        lastKnownSourceSha: "1111111111111111111111111111111111111111", taskState: "UNKNOWN", lastError: null,
      },
      BACKUP: {
        role: "BACKUP", healthState: "HEALTHY", roleState: "ACTIVE_PUBLISHER", reason: "PUBLISHING",
        heartbeatAgeMinutes: 1, lastHeartbeatUtc: "2026-09-09T09:59:00Z",
        lastSuccessfulUpdaterRunUtc: "2026-09-09T09:59:00Z", lastSuccessfulPushUtc: "2026-09-09T09:59:00Z",
        lastKnownSourceSha: "2222222222222222222222222222222222222222", taskState: "READY", lastError: null,
      },
    },
    current: {
      publisher: {
        role: "BACKUP", sinceUtc: "2026-09-09T08:14:00Z", sinceTimestampBasis: "LEASE_ACQUIRED",
        lastSuccessfulPublishUtc: "2026-09-09T09:59:00Z", lastSuccessfulPushUtc: "2026-09-09T09:59:00Z",
        reason: "PRIMARY HEARTBEAT STALE", rootCauseKnown: false,
      },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:59:00Z", publisher: "BACKUP", ageMinutes: 1, reason: "CURRENT" },
      lease: { state: "RELEASED", activeOwner: null, lastOwner: "BACKUP", acquiredUtc: "2026-09-09T09:57:00Z", releasedUtc: "2026-09-09T09:59:00Z", observedUtc: NOW },
    },
    intervals: [
      interval("PRIMARY_HEALTH", "HEALTHY", "2026-09-08T10:00:00Z", "2026-09-09T08:02:00Z", { host: "PRIMARY" }),
      interval("PRIMARY_HEALTH", "STALE", "2026-09-09T08:02:00Z", null, { host: "PRIMARY" }),
      interval("BACKUP_HEALTH", "HEALTHY", "2026-09-08T10:00:00Z", null, { host: "BACKUP" }),
      interval("PUBLISHER", "PRIMARY", "2026-09-08T10:00:00Z", "2026-09-09T08:14:00Z", { publisher: "PRIMARY" }),
      interval("PUBLISHER", "BACKUP", "2026-09-09T08:14:00Z", null, { publisher: "BACKUP" }),
      interval("BOARD_DELIVERY", "CONTINUOUS", "2026-09-08T10:00:00Z", null),
    ],
    events: [
      event("PRIMARY_HEARTBEAT_STALE", "2026-09-09T08:02:00Z", { host: "PRIMARY" }),
      event("BACKUP_TAKEOVER", "2026-09-09T08:14:00Z", { host: "BACKUP", publisher: "BACKUP" }),
    ],
    ...overrides,
  };
}

test("exact backend schema normalizes current publisher, delivery, hosts, and released lease truthfully", () => {
  const input = exactArchive();
  const before = structuredClone(input);
  const result = normalizeHostHealthHistory(input);
  assert.equal(result.ok, true);
  assert.equal(result.value.current.publisher, "BACKUP");
  assert.equal(result.value.current.publisherSinceUtc, "2026-09-09T08:14:00.000Z");
  assert.equal(result.value.current.boardDelivery, "CONTINUOUS");
  assert.equal(result.value.current.rootCauseKnown, false);
  assert.equal(result.value.hosts.PRIMARY.lastSuccessfulUpdateUtc, "2026-09-09T07:55:00.000Z");
  assert.equal(result.value.hosts.PRIMARY.sourceSha, "1111111111111111111111111111111111111111");
  assert.equal(result.value.current.lease.activeOwner, null, "released lease has no active owner");
  assert.equal(result.value.current.lease.lastOwner, "BACKUP");
  assert.deepEqual(input, before);
});

test("current state separates role from health and keeps board healthy during expected BACKUP takeover", () => {
  const current = deriveHostHealthCurrent(exactArchive(), {}, {}, NOW);
  assert.equal(current.publisher, "BACKUP");
  assert.equal(current.hosts.PRIMARY.health, "STALE");
  assert.equal(current.hosts.PRIMARY.roleState, "PREFERRED HOST · NOT PUBLISHING");
  assert.equal(current.hosts.BACKUP.health, "HEALTHY");
  assert.equal(current.hosts.BACKUP.roleState, "ACTIVE PUBLISHER");
  assert.equal(current.boardDelivery, "CONTINUOUS");
  assert.equal(current.rootCauseKnown, false);
  assert.equal(current.takeoverReason, "PRIMARY HEARTBEAT STALE");
  assert.equal(current.latestPublisherTransition.eventType, "BACKUP_TAKEOVER");
  assert.equal(current.latestPublisherTransition.timestampUtc, "2026-09-09T08:14:00.000Z");
});

test("inactive unobserved standby is UNKNOWN, never aged or painted unhealthy", () => {
  const archive = exactArchive({
    hosts: {
      PRIMARY: exactArchive().hosts.PRIMARY,
      BACKUP: { role: "BACKUP", healthState: "UNKNOWN", roleState: "STANDBY", taskState: "UNKNOWN" },
    },
    current: {
      ...exactArchive().current,
      publisher: { role: "PRIMARY", sinceUtc: "2026-09-09T09:00:00Z", reason: "PRIMARY ACTIVE", rootCauseKnown: true },
    },
  });
  const current = deriveHostHealthCurrent(archive, { activeRole: "PRIMARY", heartbeatUtc: "2026-09-09T09:59:00Z" }, {}, NOW);
  assert.equal(current.hosts.PRIMARY.health, "STALE", "archive's explicit health remains authoritative");
  assert.equal(current.hosts.BACKUP.health, "UNKNOWN");
  assert.equal(current.hosts.BACKUP.heartbeatAgeMinutes, null);
  assert.equal(current.hosts.BACKUP.roleState, "STANDBY · NOT CURRENTLY OBSERVED");
});

test("former BACKUP timestamps remain visible evidence but do not age an unobserved standby red", () => {
  const archive = exactArchive({
    hosts: {
      PRIMARY: {
        ...exactArchive().hosts.PRIMARY,
        healthState: "HEALTHY", roleState: "ACTIVE_PUBLISHER", lastHeartbeatUtc: "2026-09-09T09:59:00Z",
      },
      BACKUP: {
        ...exactArchive().hosts.BACKUP,
        healthState: "UNKNOWN", roleState: "STANDBY_NOT_OBSERVED", reason: "INACTIVE_HOST_HEALTH_NOT_OBSERVED",
        lastHeartbeatUtc: "2026-09-08T12:00:00Z", heartbeatAgeMinutes: 1320,
      },
    },
    current: {
      publisher: { role: "PRIMARY", sinceUtc: "2026-09-09T09:00:00Z", reason: "PRIMARY ACTIVE", rootCauseKnown: true },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:59:00Z", ageMinutes: 1 },
      lease: { state: "RELEASED", activeOwner: null, lastOwner: "PRIMARY" },
    },
  });
  const current = deriveHostHealthCurrent(archive, {}, {}, NOW);
  assert.equal(current.hosts.BACKUP.health, "UNKNOWN");
  assert.equal(current.hosts.BACKUP.observed, false);
  assert.equal(current.hosts.BACKUP.heartbeatUtc, "2026-09-08T12:00:00.000Z", "retained evidence remains displayable");
  assert.equal(current.hosts.BACKUP.roleState, "STANDBY · NOT CURRENTLY OBSERVED");
});

test("live fallback classifies observed active host at healthy, delayed, and stale boundaries", () => {
  const empty = { schemaVersion: 1 };
  const state = (minutes) => deriveHostHealthCurrent(empty, {
    activeRole: "PRIMARY", heartbeatUtc: new Date(Date.parse(NOW) - minutes * MINUTE).toISOString(),
    lastSuccessfulPushUtc: new Date(Date.parse(NOW) - minutes * MINUTE).toISOString(),
  }, {}, NOW).hosts.PRIMARY.health;
  assert.equal(state(15), "HEALTHY");
  assert.equal(state(16), "DELAYED");
  assert.equal(state(25), "DELAYED");
  assert.equal(state(26), "STALE");
  const stateSeconds = (minutes, seconds) => deriveHostHealthCurrent(empty, {
    activeRole: "PRIMARY", heartbeatUtc: new Date(Date.parse(NOW) - minutes * MINUTE - seconds * 1000).toISOString(),
    lastSuccessfulUpdateUtc: NOW,
  }, {}, NOW).hosts.PRIMARY.health;
  assert.equal(stateSeconds(15, 1), "DELAYED", "15:01 crosses the exact healthy threshold");
  assert.equal(stateSeconds(25, 1), "STALE", "25:01 crosses the exact failover threshold");
});

test("a once-healthy archive snapshot ages to stale when no newer heartbeat or publish arrives", () => {
  const snapshot = exactArchive({
    hosts: {
      PRIMARY: {
        ...exactArchive().hosts.PRIMARY,
        healthState: "HEALTHY",
        lastHeartbeatUtc: "2026-09-09T09:55:00Z",
        heartbeatAgeMinutes: 5,
      },
      BACKUP: { role: "BACKUP", healthState: "UNKNOWN", roleState: "STANDBY", taskState: "UNKNOWN" },
    },
    current: {
      publisher: {
        role: "PRIMARY", sinceUtc: "2026-09-09T09:00:00Z", lastSuccessfulPublishUtc: "2026-09-09T09:55:00Z",
        reason: "PRIMARY ACTIVE", rootCauseKnown: true,
      },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:55:00Z", ageMinutes: 5, reason: "CURRENT" },
      lease: { state: "RELEASED", activeOwner: null, lastOwner: "PRIMARY" },
    },
  });
  const current = deriveHostHealthCurrent(snapshot, {}, {}, "2026-09-09T10:35:00Z");
  assert.equal(current.hosts.PRIMARY.heartbeatAgeMinutes, 40);
  assert.equal(current.hosts.PRIMARY.health, "STALE");
  assert.equal(current.hosts.BACKUP.health, "UNKNOWN");
  assert.equal(current.publishAgeMinutes, 40);
  assert.equal(current.boardDelivery, "GAP");
});

test("board delivery ages CONTINUOUS through 15 minutes, DELAYED through 30, then GAP", () => {
  const stateAt = (minutes) => {
    const sourceUtc = new Date(Date.parse(NOW) - minutes * MINUTE).toISOString();
    const archive = exactArchive({
      thresholds: { healthyMinutes: 15, failoverMinutes: 25, boardGapMinutes: 30 },
      current: {
        ...exactArchive().current,
        publisher: { ...exactArchive().current.publisher, lastSuccessfulPublishUtc: sourceUtc },
        boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: sourceUtc, ageMinutes: minutes, reason: "CURRENT" },
      },
    });
    return deriveHostHealthCurrent(archive, {}, {}, NOW).boardDelivery;
  };
  assert.equal(stateAt(15), "CONTINUOUS");
  assert.equal(stateAt(16), "DELAYED");
  assert.equal(stateAt(30), "DELAYED");
  assert.equal(stateAt(31), "GAP");
  const atThirtyOneSeconds = exactArchive({
    thresholds: { healthyMinutes: 15, failoverMinutes: 25, boardGapMinutes: 30 },
    current: {
      ...exactArchive().current,
      publisher: { ...exactArchive().current.publisher, lastSuccessfulPublishUtc: "2026-09-09T09:29:59Z" },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:29:59Z", reason: "CURRENT" },
    },
  });
  assert.equal(deriveHostHealthCurrent(atThirtyOneSeconds, {}, {}, NOW).boardDelivery, "GAP", "30:01 crosses the exact gap threshold");
});

test("fresh status-only error push cannot mask a stale successful board update", () => {
  const current = deriveHostHealthCurrent({ schemaVersion: 1 }, {
    activeRole: "BACKUP",
    heartbeatUtc: "2026-09-09T09:59:00Z",
    lastSuccessfulUpdateUtc: "2026-09-09T09:20:00Z",
    lastSuccessfulPushUtc: "2026-09-09T09:59:00Z",
    updateStatus: "ERROR",
    lastError: "WEATHER UPDATE FAILED",
  }, { state: "RELEASED", owner: "BACKUP" }, NOW);
  assert.equal(current.hosts.BACKUP.health, "ERROR");
  assert.equal(current.lastSuccessfulPublishUtc, "2026-09-09T09:20:00.000Z");
  assert.equal(current.publishAgeMinutes, 40);
  assert.equal(current.boardDelivery, "GAP");
});

test("newer live PRIMARY status and live released lease override a stale archive that still says BACKUP", () => {
  const staleArchive = exactArchive({ updatedUtc: "2026-09-09T09:30:00Z" });
  const current = deriveHostHealthCurrent(staleArchive, {
    activeRole: "PRIMARY",
    heartbeatUtc: "2026-09-09T10:00:00Z",
    lastSuccessfulUpdateUtc: "2026-09-09T10:00:00Z",
    lastSuccessfulPushUtc: "2026-09-09T10:00:00Z",
    updateStatus: "OK",
    runningSha: "3333333333333333333333333333333333333333",
  }, {
    state: "RELEASED", owner: "PRIMARY", acquiredUtc: "2026-09-09T09:59:00Z", releasedUtc: "2026-09-09T10:00:00Z",
  }, NOW);
  assert.equal(current.publisher, "PRIMARY");
  assert.equal(current.publisherSinceTimestampBasis, "FIRST_OBSERVED_LIVE_HOST_STATUS");
  assert.equal(current.rootCauseKnown, false);
  assert.equal(current.hosts.PRIMARY.health, "HEALTHY");
  assert.equal(current.hosts.BACKUP.health, "UNKNOWN");
  assert.equal(current.hosts.BACKUP.heartbeatUtc, "2026-09-09T09:59:00.000Z", "historical BACKUP evidence remains visible");
  assert.equal(current.lease.state, "RELEASED");
  assert.equal(current.lease.activeOwner, null);
  assert.equal(current.lease.lastOwner, "PRIMARY");
});

test("an older independently fetched lease cannot replace newer archive evidence", () => {
  const archive = exactArchive({
    updatedUtc: "2026-09-09T09:59:00Z",
    current: {
      ...exactArchive().current,
      lease: {
        state: "RELEASED", activeOwner: null, lastOwner: "PRIMARY",
        acquiredUtc: "2026-09-09T09:58:00Z", releasedUtc: "2026-09-09T09:59:00Z",
        observedUtc: "2026-09-09T09:59:00Z",
      },
    },
  });
  const current = deriveHostHealthCurrent(archive, {}, {
    state: "RELEASED", owner: "BACKUP",
    acquiredUtc: "2026-09-09T09:40:00Z", releasedUtc: "2026-09-09T09:41:00Z",
  }, NOW);
  assert.equal(current.lease.state, "RELEASED");
  assert.equal(current.lease.lastOwner, "PRIMARY");
  assert.equal(current.lease.releasedUtc, "2026-09-09T09:59:00.000Z");
});

test("display-only lease aging expires an ACTIVE lease strictly after its published expiry", () => {
  const activeAtBoundary = deriveHostHealthCurrent({ schemaVersion: 1 }, {}, {
    state: "ACTIVE", owner: "BACKUP", acquiredUtc: "2026-09-09T09:40:00Z",
    expiresUtc: NOW,
  }, NOW).lease;
  assert.equal(activeAtBoundary.state, "ACTIVE");
  assert.equal(activeAtBoundary.activeOwner, "BACKUP");

  const expired = deriveHostHealthCurrent({ schemaVersion: 1 }, {}, {
    state: "ACTIVE", owner: "BACKUP", acquiredUtc: "2026-09-09T09:40:00Z",
    expiresUtc: "2026-09-09T09:59:59Z",
  }, NOW).lease;
  assert.equal(expired.state, "EXPIRED");
  assert.equal(expired.activeOwner, null);
  assert.equal(expired.lastOwner, "BACKUP");
  assert.equal(expired.expiresUtc, "2026-09-09T09:59:59.000Z");
});

test("a newer live successful update clears a stale archived board GAP", () => {
  const staleArchive = exactArchive({
    current: {
      ...exactArchive().current,
      publisher: { ...exactArchive().current.publisher, lastSuccessfulPublishUtc: "2026-09-09T09:20:00Z" },
      boardDelivery: { state: "GAP", lastSuccessfulPublishUtc: "2026-09-09T09:20:00Z", reason: "ARCHIVED PUBLISH GAP" },
    },
  });
  const current = deriveHostHealthCurrent(staleArchive, {
    activeRole: "BACKUP",
    heartbeatUtc: "2026-09-09T09:59:30Z",
    lastSuccessfulUpdateUtc: "2026-09-09T09:59:00Z",
    lastSuccessfulPushUtc: "2026-09-09T09:59:30Z",
    updateStatus: "OK",
  }, {}, NOW);
  assert.equal(current.lastSuccessfulPublishUtc, "2026-09-09T09:59:00.000Z");
  assert.equal(current.publishAgeMinutes, 1);
  assert.equal(current.boardDelivery, "CONTINUOUS");
  assert.match(current.boardDeliveryReason, /LIVE SUCCESSFUL UPDATE/);
});

test("both explicitly stale hosts remain stale and board delivery can independently be unavailable", () => {
  const archive = exactArchive({
    hosts: {
      PRIMARY: { ...exactArchive().hosts.PRIMARY, healthState: "STALE" },
      BACKUP: { ...exactArchive().hosts.BACKUP, healthState: "STALE" },
    },
    current: { ...exactArchive().current, boardDelivery: { state: "GAP", reason: "PUBLISH GAP" } },
  });
  const current = deriveHostHealthCurrent(archive, {}, {}, NOW);
  assert.equal(current.hosts.PRIMARY.health, "STALE");
  assert.equal(current.hosts.BACKUP.health, "STALE");
  assert.equal(current.boardDelivery, "GAP");
});

test("all five requested ranges are exact rolling UTC windows capped at 365 days", () => {
  assert.deepEqual(HOST_HEALTH_RANGES.map((item) => item.key), ["24h", "7d", "30d", "90d", "365d"]);
  assert.equal(getHostHealthRange("24 HR", NOW).durationMs, DAY);
  assert.equal(getHostHealthRange("1 YEAR", NOW).durationMs, 365 * DAY);
  assert.equal(getHostHealthRange("bogus", NOW), null);
});

test("timeline clips intervals exactly and leaves pre-archive time unmanufactured", () => {
  const range = getHostHealthRange("7d", NOW);
  const result = buildHostHealthTimeline(exactArchive(), range, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value.partialHistory, true);
  assert.ok(result.value.intervals.every((item) => item.startMs >= Date.parse("2026-09-08T10:00:00Z")));
  assert.equal(result.value.tracks.length, 4);
  assert.deepEqual(result.value.tracks.map((track) => track.label), ["PRIMARY", "BACKUP", "PUBLISHER", "BOARD DELIVERY"]);
});

test("UTC daily summaries extend long-range metrics without duplicating retained critical events", () => {
  const daily = {
    dateUtc: "2026-09-06",
    dayStartUtc: "2026-09-06T00:00:00Z",
    dayEndUtc: "2026-09-07T00:00:00Z",
    coverageSeconds: 86_400,
    knownCoverageSeconds: 86_400,
    partialCoverage: false,
    tracks: {
      PRIMARY: { durationsSeconds: { HEALTHY: 43_200, DELAYED: 43_200 }, observedSeconds: 86_400, knownSeconds: 86_400 },
      BACKUP: { durationsSeconds: { UNKNOWN: 86_400 }, observedSeconds: 0, knownSeconds: 0 },
      PUBLISHER: { durationsSeconds: { PRIMARY: 82_800, BACKUP: 3_600 }, observedSeconds: 86_400, knownSeconds: 86_400 },
      BOARD_DELIVERY: { durationsSeconds: { CONTINUOUS: 82_800, GAP: 3_600 }, observedSeconds: 86_400, knownSeconds: 86_400 },
    },
    eventCounts: { BACKUP_TAKEOVER: 1, PRIMARY_HANDOFF: 1 },
    sourceIntervalCount: 9,
    sourceEventCount: 2,
    aggregation: {
      timeBasis: "UTC",
      timestampBasis: "EXACT_INTERVAL_BOUNDARIES_SPLIT_AT_UTC_DAY",
      provenance: "DERIVED_FROM_EXACT_INTERVALS_AND_EVENTS",
    },
  };
  const archive = {
    schemaVersion: 1,
    archiveStartedUtc: "2026-09-06T00:00:00Z",
    coverageStartUtc: "2026-09-06T00:00:00Z",
    updatedUtc: "2026-09-09T00:00:00Z",
    exactHistoryDays: 2,
    exactHistoryStartUtc: "2026-09-07T00:00:00Z",
    summarizedThroughUtc: "2026-09-07T00:00:00Z",
    summaryCoverageStartUtc: "2026-09-06T00:00:00Z",
    storagePolicy: {
      mode: "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES",
      exactHistoryDays: 2,
      aggregateTimeBasis: "UTC",
      criticalEventTypesRetainedExact: ["BACKUP_TAKEOVER", "PRIMARY_HANDOFF"],
      criticalEventsAlsoCountedInDailySummaries: true,
    },
    dailySummaries: [daily],
    intervals: [],
    events: [
      { ...event("BACKUP_TAKEOVER", "2026-09-06T12:00:00Z"), includedInDailySummary: true },
      { ...event("PRIMARY_HANDOFF", "2026-09-06T13:00:00Z"), includedInDailySummary: true },
    ],
  };
  const normalized = normalizeHostHealthHistory(archive);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.dailySummaries.length, 1);
  assert.equal(normalized.value.dailySummaries[0].tracks.PRIMARY_HEALTH.durationsSeconds.HEALTHY, 43_200);
  assert.equal(normalized.value.storagePolicy.mode, "EXACT_RECENT_WITH_UTC_DAILY_AGGREGATES");
  assert.equal(normalized.value.storagePolicy.exactHistoryDays, 2);
  assert.equal(normalized.value.storagePolicy.criticalEventsAlsoCountedInDailySummaries, true);
  assert.equal(normalized.value.summaryCoverageStartUtc, "2026-09-06T00:00:00.000Z");
  assert.equal(normalized.value.events[0].includedInDailySummary, true);

  const range = { startMs: Date.parse("2026-09-06T00:00:00Z"), endMs: Date.parse("2026-09-07T00:00:00Z") };
  const timeline = buildHostHealthTimeline(normalized, range, "2026-09-09T00:00:00Z").value;
  assert.equal(timeline.dailySummaries.length, 1);
  assert.equal(timeline.intervals.length, 0, "daily totals are not fabricated into exact intervals");
  const metrics = calculateHostHealthMetrics(timeline).value;
  assert.equal(metrics.primaryAvailability.percent, 50);
  assert.equal(metrics.backupAvailability.percent, null);
  assert.ok(Math.abs(metrics.boardPublishingCoverage.percent - 95.8333333333) < 0.001);
  assert.equal(metrics.timeRunningOnBackupMs, HOUR);
  assert.equal(metrics.failovers, 1, "retained critical event is not double counted with daily eventCounts");
  assert.equal(metrics.successfulHandoffs, 1);
  assert.equal(metrics.longestBoardGapMs, null, "aggregate seconds cannot prove one continuous longest gap");
  assert.equal(metrics.longestBoardGapKnown, false);
  assert.equal(metrics.aggregateHistoryUsed, true);
});

test("explicit dropped retention-edge coverage remains a disclosed unknown span", () => {
  const archive = {
    schemaVersion: 1,
    archiveStartedUtc: "2025-09-09T00:00:00Z",
    coverageStartUtc: "2025-09-10T00:00:00Z",
    retentionBoundaryGap: {
      startUtc: "2025-09-09T10:00:00Z",
      endUtc: "2025-09-10T00:00:00Z",
      reason: "PARTIAL_UTC_DAY_DROPPED_AFTER_DAILY_AGGREGATION",
      timestampBasis: "ROLLING_RETENTION_BOUNDARY_TO_NEXT_RETAINED_COVERAGE",
      timestampCertainty: "EXPLICITLY_UNAVAILABLE_AFTER_AGGREGATION",
    },
  };
  const normalized = normalizeHostHealthHistory(archive);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.retentionBoundaryGap.startUtc, "2025-09-09T10:00:00.000Z");
  const timeline = buildHostHealthTimeline(normalized, {
    startMs: Date.parse("2025-09-09T00:00:00Z"), endMs: Date.parse("2025-09-11T00:00:00Z"),
  }, NOW).value;
  assert.equal(timeline.retentionBoundaryGap.reason, "PARTIAL_UTC_DAY_DROPPED_AFTER_DAILY_AGGREGATION");
  assert.equal(timeline.partialHistory, true);
  assert.equal(timeline.intervals.length, 0, "unavailable retention coverage is never painted as a state");
});

test("part-day summary edges and malformed exact/aggregate overlap fail closed", () => {
  const summary = {
    dateUtc: "2026-09-06", dayStartUtc: "2026-09-06T00:00:00Z", dayEndUtc: "2026-09-07T00:00:00Z",
    tracks: { PRIMARY: { durationsSeconds: { HEALTHY: 86_400 } } },
  };
  const partialRange = buildHostHealthTimeline({ schemaVersion: 1, dailySummaries: [summary] }, {
    startMs: Date.parse("2026-09-06T12:00:00Z"), endMs: Date.parse("2026-09-07T00:00:00Z"),
  }, NOW).value;
  assert.equal(partialRange.dailySummaries.length, 0);
  assert.equal(partialRange.summaryBoundaryDaysExcluded, 1);
  assert.equal(partialRange.partialHistory, true);

  const overlap = buildHostHealthTimeline({
    schemaVersion: 1,
    dailySummaries: [summary],
    intervals: [interval("PRIMARY", "HEALTHY", "2026-09-06T23:00:00Z", "2026-09-07T01:00:00Z")],
  }, { startMs: Date.parse("2026-09-06T00:00:00Z"), endMs: Date.parse("2026-09-07T02:00:00Z") }, NOW).value;
  assert.equal(overlap.dailySummaries.length, 0);
  assert.equal(overlap.summaryOverlapDaysExcluded, 1);
  assert.equal(overlap.partialHistory, true);
});

test("open intervals end at selected range end without creating heartbeat rows or duplicate events", () => {
  const result = buildHostHealthTimeline(exactArchive(), getHostHealthRange("24h", NOW), NOW).value;
  const openPrimary = result.intervals.find((item) => item.track === "PRIMARY_HEALTH" && item.state === "STALE");
  assert.equal(openPrimary.endMs, Date.parse(NOW));
  assert.equal(result.events.filter((item) => item.eventType === "BACKUP_TAKEOVER").length, 1);
  assert.equal(result.intervals.filter((item) => item.track === "BACKUP_HEALTH").length, 1);
});

test("frozen open publisher and delivery intervals split at exact derived outage thresholds", () => {
  const frozen = exactArchive({
    updatedUtc: "2026-09-09T09:55:00Z",
    hosts: {
      PRIMARY: {
        ...exactArchive().hosts.PRIMARY, healthState: "HEALTHY", roleState: "ACTIVE_PUBLISHER",
        lastHeartbeatUtc: "2026-09-09T09:55:00Z", heartbeatAgeMinutes: 0,
      },
      BACKUP: {
        ...exactArchive().hosts.BACKUP, healthState: "UNKNOWN", roleState: "STANDBY_NOT_OBSERVED",
        reason: "INACTIVE_HOST_HEALTH_NOT_OBSERVED", lastHeartbeatUtc: "2026-09-08T12:00:00Z",
      },
    },
    current: {
      publisher: {
        role: "PRIMARY", sinceUtc: "2026-09-09T09:50:00Z", lastSuccessfulPublishUtc: "2026-09-09T09:55:00Z",
        reason: "PREFERRED_PRIMARY_PUBLISHING", rootCauseKnown: true,
      },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:55:00Z", reason: "BOARD_PUBLISH_CURRENT" },
      lease: { state: "RELEASED", activeOwner: null, lastOwner: "PRIMARY" },
    },
    intervals: [
      interval("PRIMARY", "HEALTHY", "2026-09-09T09:50:00Z", null, { host: "PRIMARY" }),
      interval("BACKUP", "UNKNOWN", "2026-09-09T09:50:00Z", null, { host: "BACKUP" }),
      interval("PUBLISHER", "PRIMARY", "2026-09-09T09:50:00Z", null, { publisher: "PRIMARY" }),
      interval("BOARD_DELIVERY", "CONTINUOUS", "2026-09-09T09:50:00Z", null),
    ],
    events: [],
  });
  const timeline = buildHostHealthTimeline(frozen, getHostHealthRange("24h", "2026-09-09T10:35:00Z"), "2026-09-09T10:35:00Z").value;
  const primary = timeline.tracks.find((track) => track.key === "PRIMARY_HEALTH").intervals;
  const backup = timeline.tracks.find((track) => track.key === "BACKUP_HEALTH").intervals;
  const board = timeline.tracks.find((track) => track.key === "BOARD_DELIVERY").intervals;
  assert.deepEqual(primary.map((item) => item.state), ["HEALTHY", "DELAYED", "STALE"]);
  assert.equal(primary[1].startMs, Date.parse("2026-09-09T10:10:01Z"));
  assert.equal(primary[2].startMs, Date.parse("2026-09-09T10:20:01Z"));
  assert.deepEqual(board.map((item) => item.state), ["CONTINUOUS", "DELAYED", "GAP"]);
  assert.equal(board[1].startMs, Date.parse("2026-09-09T10:10:01Z"));
  assert.equal(board[2].startMs, Date.parse("2026-09-09T10:25:01Z"));
  assert.deepEqual(backup.map((item) => item.state), ["UNKNOWN"], "inactive standby is not aged from retained evidence");
  assert.ok(timeline.events.some((item) => item.eventType === "PRIMARY_STALE" && item.inferred));
  assert.ok(timeline.events.some((item) => item.eventType === "BOARD_PUBLISH_GAP" && item.inferred));
  const metrics = calculateHostHealthMetrics(timeline).value;
  assert.ok(metrics.primaryAvailability.percent < 100);
  assert.ok(metrics.boardPublishingCoverage.percent < 100);
  assert.equal(metrics.longestBoardGapMs, 9 * MINUTE + 59 * 1000);
  assert.equal(metrics.failedHandoffs, null);
  assert.equal(metrics.failedHandoffsKnown, false);
});

test("newer live role evidence conservatively ends stale archive tracks without fabricating a handoff", () => {
  const stale = exactArchive({
    updatedUtc: "2026-09-09T09:00:00Z",
    hosts: {
      PRIMARY: { ...exactArchive().hosts.PRIMARY, healthState: "HEALTHY", roleState: "ACTIVE_PUBLISHER", lastHeartbeatUtc: "2026-09-09T09:00:00Z" },
      BACKUP: { role: "BACKUP", healthState: "UNKNOWN", roleState: "STANDBY_NOT_OBSERVED", taskState: "UNKNOWN" },
    },
    current: {
      publisher: { role: "PRIMARY", sinceUtc: "2026-09-09T08:00:00Z", lastSuccessfulPublishUtc: "2026-09-09T09:00:00Z" },
      boardDelivery: { state: "CONTINUOUS", lastSuccessfulPublishUtc: "2026-09-09T09:00:00Z" },
      lease: { state: "RELEASED", activeOwner: null, lastOwner: "PRIMARY" },
    },
    intervals: [
      interval("PRIMARY", "HEALTHY", "2026-09-09T08:00:00Z", null, { host: "PRIMARY" }),
      interval("BACKUP", "UNKNOWN", "2026-09-09T08:00:00Z", null, { host: "BACKUP" }),
      interval("PUBLISHER", "PRIMARY", "2026-09-09T08:00:00Z", null, { publisher: "PRIMARY" }),
      interval("BOARD_DELIVERY", "CONTINUOUS", "2026-09-09T08:00:00Z", null),
    ],
    events: [],
  });
  const liveCurrent = deriveHostHealthCurrent(stale, {
    activeRole: "BACKUP", heartbeatUtc: "2026-09-09T09:59:00Z",
    lastSuccessfulUpdateUtc: "2026-09-09T09:59:00Z", updateStatus: "OK",
  }, { state: "RELEASED", owner: "BACKUP", releasedUtc: "2026-09-09T09:59:00Z" }, NOW);
  assert.equal(liveCurrent.publisher, "BACKUP");
  assert.equal(liveCurrent.boardDelivery, "CONTINUOUS");
  const timeline = buildHostHealthTimeline(stale, getHostHealthRange("24h", NOW), NOW, { currentEvidence: liveCurrent }).value;
  assert.equal(timeline.liveEvidenceNewer, true);
  assert.equal(timeline.coverageEndMs, Date.parse("2026-09-09T09:00:00Z"));
  assert.equal(timeline.partialHistory, true);
  assert.ok(timeline.intervals.every((item) => item.endMs <= timeline.coverageEndMs));
  assert.equal(timeline.events.some((item) => item.inferred && item.timestampMs > timeline.coverageEndMs), false);
  assert.equal(calculateHostHealthMetrics(timeline).value.timeRunningOnBackupMs, 0,
    "unknown post-archive span is not relabeled as BACKUP history");
});

test("selected-range metrics use one shared interval archive and known-duration denominators", () => {
  const timeline = buildHostHealthTimeline(exactArchive(), getHostHealthRange("24h", NOW), NOW).value;
  const result = calculateHostHealthMetrics(timeline);
  assert.equal(result.ok, true);
  assert.equal(result.value.backupAvailability.percent, 100);
  assert.equal(result.value.boardPublishingCoverage.percent, 100);
  assert.equal(result.value.failovers, 1);
  assert.equal(result.value.successfulHandoffs, 0);
  assert.equal(result.value.timeRunningOnBackupMs, (1 * HOUR + 46 * MINUTE));
  assert.equal(result.value.partialHistory, true, "backend-declared partial history is never presented as complete");
});

test("board publish gap and recovery produce truthful longest-gap and event counts", () => {
  const archive = exactArchive({
    intervals: [
      interval("BOARD_DELIVERY", "CONTINUOUS", "2026-09-09T00:00:00Z", "2026-09-09T03:00:00Z"),
      interval("BOARD_DELIVERY", "GAP", "2026-09-09T03:00:00Z", "2026-09-09T03:17:00Z"),
      interval("BOARD_DELIVERY", "CONTINUOUS", "2026-09-09T03:17:00Z", null),
    ],
    events: [event("BOARD_PUBLISH_GAP", "2026-09-09T03:00:00Z"), event("BOARD_PUBLISH_RECOVERED", "2026-09-09T03:17:00Z")],
  });
  const timeline = buildHostHealthTimeline(archive, getHostHealthRange("24h", NOW), NOW).value;
  const metrics = calculateHostHealthMetrics(timeline).value;
  assert.equal(metrics.longestBoardGapMs, 17 * MINUTE);
  assert.ok(metrics.boardPublishingCoverage.percent < 100);
  assert.deepEqual(timeline.events.map((item) => item.eventType), ["BOARD_PUBLISH_GAP", "BOARD_PUBLISH_RECOVERED"]);
});

test("PRIMARY recovery and successful handoff remain distinct meaningful events", () => {
  const archive = exactArchive({ events: [
    event("PRIMARY_RECOVERED", "2026-09-09T09:30:00Z", { host: "PRIMARY" }),
    event("PRIMARY_HANDOFF", "2026-09-09T09:40:00Z", { host: "PRIMARY", publisher: "PRIMARY" }),
  ] });
  const timeline = buildHostHealthTimeline(archive, getHostHealthRange("24h", NOW), NOW).value;
  assert.deepEqual(timeline.events.map((item) => item.eventType), ["PRIMARY_RECOVERED", "PRIMARY_HANDOFF"]);
  assert.equal(calculateHostHealthMetrics(timeline).value.successfulHandoffs, 1);
});

test("zoom, wheel-equivalent zoom-out, pan, and reset preserve the master domain", () => {
  const master = getHostHealthRange("7d", NOW);
  const initial = createHostHealthTimeDomain(master);
  const zoomed = zoomHostHealthTimeDomain(initial, 2, 0.25);
  assert.equal(zoomed.durationMs, master.durationMs / 2);
  const panned = panHostHealthTimeDomain(zoomed, HOUR);
  assert.equal(panned.durationMs, zoomed.durationMs);
  const outward = zoomHostHealthTimeDomain(zoomed, 0.8, 0.5);
  assert.ok(outward.durationMs > zoomed.durationMs);
  const reset = resetHostHealthTimeDomain(panned);
  assert.equal(reset.isFullRange, true);
  assert.equal(reset.startMs, master.startMs);
  assert.equal(reset.endMs, master.endMs);
});

test("tick selection is UTC proportional and bounded", () => {
  const range = getHostHealthRange("24h", NOW);
  const ticks = selectHostHealthTicks(range, 7);
  assert.ok(ticks.length >= 4 && ticks.length <= 8);
  assert.ok(ticks.every((tick) => tick >= range.startMs && tick <= range.endMs));
  assert.ok(ticks.slice(1).every((tick, index) => tick - ticks[index] === ticks[1] - ticks[0]));
});

test("UTC parser rejects local/bare values and accepts canonical UTC without fabricated timezone", () => {
  assert.equal(parseHostHealthUtc("2026-09-09T10:00:00Z"), Date.parse(NOW));
  assert.equal(parseHostHealthUtc("2026-09-09 10:00:00"), null);
  assert.equal(parseHostHealthUtc("not a date"), null);
  assert.equal(parseHostHealthUtc(1e300), null);
  assert.doesNotThrow(() => normalizeHostHealthHistory({ schemaVersion: 1, updatedUtc: 1e300 }));
});

test("LOCAL display uses America/Chicago and follows both DST transitions", () => {
  assert.match(formatHostHealthTime("2026-03-08T07:30:00Z", "LOCAL"), /01(?:30)?L CST/);
  assert.match(formatHostHealthTime("2026-03-08T08:30:00Z", "LOCAL"), /03(?:30)?L CDT/);
  const beforeFall = formatHostHealthTime("2026-11-01T06:30:00Z", "LOCAL");
  const afterFall = formatHostHealthTime("2026-11-01T07:30:00Z", "LOCAL");
  assert.match(beforeFall, /CDT/);
  assert.match(afterFall, /CST/);
  assert.equal(formatHostHealthTime(NOW, "Z", { compact: true }), "1000Z");
});

test("duration formatting remains compact for gaps, handoffs, and long BACKUP runs", () => {
  assert.equal(formatHostHealthDuration(17 * MINUTE), "17 MIN");
  assert.equal(formatHostHealthDuration(6 * HOUR + 42 * MINUTE), "6 HR 42 MIN");
  assert.equal(formatHostHealthDuration(2 * DAY + HOUR), "2 DAY 1 HR");
});

test("malformed archive fails closed while malformed rows are isolated from otherwise valid telemetry", () => {
  assert.equal(normalizeHostHealthHistory(null).ok, false);
  assert.equal(normalizeHostHealthHistory({ schemaVersion: 999 }).ok, false);
  const result = normalizeHostHealthHistory({ schemaVersion: 1, intervals: [{ track: "BOGUS", startUtc: NOW }], events: [{ eventType: "X", timestampUtc: "bad" }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.intervals.length, 0);
  assert.equal(result.value.events.length, 0);
});

test("persisted first-observed and threshold-derived event provenance remains visibly inferred", () => {
  const result = normalizeHostHealthHistory({
    schemaVersion: 1,
    events: [
      { eventType: "ACTIVE_BACKUP", timestampUtc: NOW, timestampBasis: "FIRST_OBSERVED", timestampCertainty: "FIRST_OBSERVED" },
      { eventType: "PRIMARY_STALE", timestampUtc: "2026-09-09T09:59:00Z", timestampBasis: "FAILOVER_THRESHOLD_DERIVED", timestampCertainty: "DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD" },
      { eventType: "BACKUP_TAKEOVER", timestampUtc: "2026-09-09T09:58:00Z", timestampBasis: "LEASE_ACQUIRED_UTC", timestampCertainty: "EXACT_SOURCE_TIMESTAMP" },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.events.find((event) => event.eventType === "ACTIVE_BACKUP").inferred, true);
  assert.equal(result.value.events.find((event) => event.eventType === "PRIMARY_STALE").inferred, true);
  assert.equal(result.value.events.find((event) => event.eventType === "BACKUP_TAKEOVER").inferred, false);
});
