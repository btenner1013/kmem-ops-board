export const HOST_HEALTH_SCHEMA_VERSION = 1;
export const HOST_HEALTH_TIME_ZONE = "America/Chicago";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const HOST_HEALTH_RETENTION_DAYS = 365;
export const HOST_HEALTH_MIN_VISIBLE_MS = 30 * MINUTE_MS;
export const HOST_HEALTH_RANGES = Object.freeze([
  Object.freeze({ key: "24h", label: "24 HR", durationMs: DAY_MS }),
  Object.freeze({ key: "7d", label: "7 DAYS", durationMs: 7 * DAY_MS }),
  Object.freeze({ key: "30d", label: "30 DAYS", durationMs: 30 * DAY_MS }),
  Object.freeze({ key: "90d", label: "90 DAYS", durationMs: 90 * DAY_MS }),
  Object.freeze({ key: "365d", label: "1 YEAR", durationMs: 365 * DAY_MS }),
]);

export const HOST_HEALTH_TRACKS = Object.freeze([
  Object.freeze({ key: "PRIMARY_HEALTH", label: "PRIMARY", type: "health" }),
  Object.freeze({ key: "BACKUP_HEALTH", label: "BACKUP", type: "health" }),
  Object.freeze({ key: "PUBLISHER", label: "PUBLISHER", type: "publisher" }),
  Object.freeze({ key: "BOARD_DELIVERY", label: "BOARD DELIVERY", type: "delivery" }),
]);

export const HOST_HEALTH_STATES = Object.freeze(["HEALTHY", "DELAYED", "STALE", "ERROR", "UNAVAILABLE", "UNKNOWN"]);
export const HOST_HEALTH_DEFAULT_THRESHOLDS_MINUTES = Object.freeze({ delayedAfter: 15, staleAfter: 25 });

const RANGE_ALIASES = Object.freeze({
  "24": "24h", "24h": "24h", "24hr": "24h",
  "7": "7d", "7d": "7d", "7days": "7d",
  "30": "30d", "30d": "30d", "30days": "30d",
  "90": "90d", "90d": "90d", "90days": "90d",
  "365": "365d", "365d": "365d", "1y": "365d", "1year": "365d",
});

const TRACK_ALIASES = Object.freeze({
  PRIMARY: "PRIMARY_HEALTH",
  PRIMARY_HEALTH: "PRIMARY_HEALTH",
  PRIMARYHEALTH: "PRIMARY_HEALTH",
  BACKUP: "BACKUP_HEALTH",
  BACKUP_HEALTH: "BACKUP_HEALTH",
  BACKUPHEALTH: "BACKUP_HEALTH",
  PUBLISHER: "PUBLISHER",
  ACTIVE_PUBLISHER: "PUBLISHER",
  ACTIVEPUBLISHER: "PUBLISHER",
  BOARD: "BOARD_DELIVERY",
  BOARD_DELIVERY: "BOARD_DELIVERY",
  BOARDDELIVERY: "BOARD_DELIVERY",
});

const HEALTH_ALIASES = Object.freeze({
  OK: "HEALTHY", CURRENT: "HEALTHY", CONTINUOUS: "HEALTHY", HEALTHY: "HEALTHY",
  WARN: "DELAYED", WARNING: "DELAYED", DELAYED: "DELAYED",
  NO_HEARTBEAT: "STALE", STALE: "STALE",
  FAILED: "ERROR", FAILURE: "ERROR", ERROR: "ERROR", SCRIPT_FAILED: "ERROR",
  OFFLINE: "UNAVAILABLE", UNREACHABLE: "UNAVAILABLE", UNAVAILABLE: "UNAVAILABLE",
  NONE: "UNKNOWN", NO_DATA: "UNKNOWN", UNKNOWN: "UNKNOWN", UNOBSERVED: "UNKNOWN",
});

const PUBLISHER_ALIASES = Object.freeze({ PRIMARY: "PRIMARY", BACKUP: "BACKUP", NONE: "UNKNOWN", UNKNOWN: "UNKNOWN" });

function resultError(code, message, path = "") {
  return { ok: false, error: { code, message, path } };
}

function firstValue(source, keys, fallback = null) {
  if (!source || typeof source !== "object") return fallback;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return fallback;
}

function textValue(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function canonicalUpper(value) {
  return textValue(value).toUpperCase().replace(/[\s-]+/g, "_");
}

export function parseHostHealthUtc(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const checked = new Date(value).getTime();
    return Number.isFinite(checked) ? checked : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/(?:Z|[+-]00:00)$/i.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function canonicalIso(value) {
  const ms = parseHostHealthUtc(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function canonicalRole(value) {
  const normalized = canonicalUpper(value);
  return normalized === "PRIMARY" || normalized === "BACKUP" ? normalized : "UNKNOWN";
}

export function normalizeHostHealthState(value) {
  return HEALTH_ALIASES[canonicalUpper(value)] || "UNKNOWN";
}

function normalizeTrack(value) {
  return TRACK_ALIASES[canonicalUpper(value)] || null;
}

function normalizeTrackState(track, value) {
  if (track === "PUBLISHER") return PUBLISHER_ALIASES[canonicalUpper(value)] || "UNKNOWN";
  if (track === "BOARD_DELIVERY") return normalizeBoardDeliveryState(value);
  return normalizeHostHealthState(value);
}

function normalizeBoardDeliveryState(value) {
  const state = canonicalUpper(value);
  if (["CONTINUOUS", "HEALTHY", "OK", "CURRENT"].includes(state)) return "CONTINUOUS";
  if (["DELAYED", "WARN", "WARNING"].includes(state)) return "DELAYED";
  if (["GAP", "STALE", "ERROR", "UNAVAILABLE", "FAILED"].includes(state)) return "GAP";
  return "UNKNOWN";
}

function boardStateToHealth(value) {
  const state = normalizeBoardDeliveryState(value);
  return state === "CONTINUOUS" ? "HEALTHY" : state === "DELAYED" ? "DELAYED" : state === "GAP" ? "STALE" : "UNKNOWN";
}

function normalizeReason(value) {
  const text = textValue(value);
  return text || "NO REASON REPORTED";
}

function timestampProvenanceIsInferred(explicit, basis, certainty) {
  if (explicit === true) return true;
  const provenance = `${canonicalUpper(basis)} ${canonicalUpper(certainty)}`;
  return provenance.includes("FIRST_OBSERVED") || provenance.includes("DERIVED") || provenance.includes("INFERRED");
}

function normalizeHostSnapshot(value, expectedRole) {
  const source = value && typeof value === "object" ? value : {};
  const role = expectedRole || canonicalRole(firstValue(source, ["host", "role", "name"]));
  const health = normalizeHostHealthState(firstValue(source, ["health", "healthState", "state", "status", "updateStatus"]));
  const roleState = canonicalUpper(firstValue(source, ["roleState", "publisherState", "mode"], "UNKNOWN")) || "UNKNOWN";
  const heartbeatUtc = canonicalIso(firstValue(source, ["lastHeartbeatUtc", "heartbeatUtc", "heartbeatZ", "lastHeartbeatZ"]));
  const lastSuccessfulUpdateUtc = canonicalIso(firstValue(source, [
    "lastSuccessfulUpdateUtc", "lastUpdateUtc", "lastUpdaterSuccessUtc", "lastSuccessfulUpdaterRunUtc", "updaterSuccessUtc", "lastSuccessfulRunUtc",
  ]));
  const lastSuccessfulPushUtc = canonicalIso(firstValue(source, [
    "lastSuccessfulPushUtc", "lastPushUtc", "pushUtc", "lastPublishUtc", "lastSuccessfulPublishUtc",
  ]));
  return {
    role,
    health,
    roleState,
    heartbeatUtc,
    lastSuccessfulUpdateUtc,
    lastSuccessfulPushUtc,
    sourceSha: textValue(firstValue(source, ["sourceSha", "lastKnownSourceSha", "runningSha", "runningCodeSha", "sha", "originMainSha"])) || null,
    taskStatus: canonicalUpper(firstValue(source, ["taskStatus", "scheduledTaskState", "taskState"], "UNKNOWN")) || "UNKNOWN",
    lastError: textValue(firstValue(source, ["lastError", "error"])) || null,
    reason: textValue(firstValue(source, ["reason", "healthReason", "detail"])) || null,
    heartbeatAgeMinutes: source.heartbeatAgeMinutes !== null && source.heartbeatAgeMinutes !== undefined && source.heartbeatAgeMinutes !== ""
      && Number.isFinite(Number(source.heartbeatAgeMinutes)) ? Math.max(0, Number(source.heartbeatAgeMinutes)) : null,
    observed: source.observed !== undefined
      ? Boolean(source.observed)
      : roleState.includes("NOT_OBSERVED")
        ? false
        : Boolean(heartbeatUtc || lastSuccessfulUpdateUtc || lastSuccessfulPushUtc || health !== "UNKNOWN"),
    evidenceAvailable: Boolean(heartbeatUtc || lastSuccessfulUpdateUtc || lastSuccessfulPushUtc || health !== "UNKNOWN"),
  };
}

function flatIntervals(rawIntervals) {
  if (Array.isArray(rawIntervals)) return rawIntervals;
  if (!rawIntervals || typeof rawIntervals !== "object") return [];
  const flattened = [];
  for (const [track, values] of Object.entries(rawIntervals)) {
    if (!Array.isArray(values)) continue;
    for (const item of values) flattened.push({ track, ...item });
  }
  return flattened;
}

function normalizeInterval(value, index) {
  if (!value || typeof value !== "object") return null;
  const track = normalizeTrack(firstValue(value, ["track", "trackType", "series", "host"]));
  if (!track) return null;
  const startMs = parseHostHealthUtc(firstValue(value, ["startUtc", "startZ", "startedUtc", "firstObservedUtc", "start"]));
  const endRaw = firstValue(value, ["endUtc", "endZ", "endedUtc", "lastObservedUtc", "end"]);
  const endMs = endRaw === null || endRaw === undefined || endRaw === "" ? null : parseHostHealthUtc(endRaw);
  if (startMs === null || (endRaw !== null && endRaw !== undefined && endRaw !== "" && endMs === null)) return null;
  if (endMs !== null && endMs <= startMs) return null;
  const state = normalizeTrackState(track, firstValue(value, ["state", "health", "publisher", "value", "status"]));
  const explicitPublisher = canonicalRole(firstValue(value, ["publisher", "leaseOwner", "owner"]));
  const sourceTimestampType = textValue(firstValue(value, ["sourceTimestampType", "timestampSource", "sourceType", "startTimestampBasis"])) || "FIRST_OBSERVED";
  const timestampCertainty = textValue(firstValue(value, ["timestampCertainty", "startTimestampCertainty"])) || "OBSERVED";
  return {
    id: textValue(value.id) || `interval-${index}`,
    track,
    host: track === "PRIMARY_HEALTH" ? "PRIMARY" : track === "BACKUP_HEALTH" ? "BACKUP" : canonicalRole(value.host),
    state,
    startMs,
    endMs,
    startUtc: new Date(startMs).toISOString(),
    endUtc: endMs === null ? null : new Date(endMs).toISOString(),
    reason: normalizeReason(firstValue(value, ["reason", "detail", "cause"])),
    sourceTimestampType,
    timestampCertainty,
    inferred: timestampProvenanceIsInferred(Boolean(firstValue(value, ["inferred", "isInferred"], false)), sourceTimestampType, timestampCertainty),
    publisher: track === "PUBLISHER" && explicitPublisher === "UNKNOWN" ? canonicalRole(state) : explicitPublisher,
    leaseOwner: canonicalRole(firstValue(value, ["leaseOwner", "owner"])),
    sourceSha: textValue(firstValue(value, ["sourceSha", "sha", "runningSha"])) || null,
  };
}

function normalizeEvent(value, index) {
  if (!value || typeof value !== "object") return null;
  const timestampMs = parseHostHealthUtc(firstValue(value, ["timestampUtc", "timeUtc", "occurredUtc", "startUtc", "timestamp", "time"]));
  if (timestampMs === null) return null;
  const eventType = canonicalUpper(firstValue(value, ["eventType", "type", "event", "state"], "UNKNOWN")) || "UNKNOWN";
  const sourceTimestampType = textValue(firstValue(value, ["sourceTimestampType", "timestampSource", "sourceType", "timestampBasis"])) || "FIRST_OBSERVED";
  const timestampCertainty = textValue(firstValue(value, ["timestampCertainty"])) || "OBSERVED";
  return {
    id: textValue(value.id) || `event-${index}`,
    eventType,
    host: canonicalRole(value.host),
    timestampMs,
    timestampUtc: new Date(timestampMs).toISOString(),
    reason: normalizeReason(firstValue(value, ["reason", "detail", "cause"])),
    publisher: canonicalRole(firstValue(value, ["publisher", "leaseOwner", "owner"])),
    leaseOwner: canonicalRole(firstValue(value, ["leaseOwner", "owner"])),
    sourceTimestampType,
    timestampCertainty,
    inferred: timestampProvenanceIsInferred(Boolean(firstValue(value, ["inferred", "isInferred"], false)), sourceTimestampType, timestampCertainty),
    includedInDailySummary: Boolean(firstValue(value, ["includedInDailySummary"], false)),
    sourceSha: textValue(firstValue(value, ["sourceSha", "sha", "runningSha"])) || null,
  };
}

const DAILY_SUMMARY_TRACK_KEYS = Object.freeze({
  PRIMARY: "PRIMARY_HEALTH",
  PRIMARY_HEALTH: "PRIMARY_HEALTH",
  BACKUP: "BACKUP_HEALTH",
  BACKUP_HEALTH: "BACKUP_HEALTH",
  PUBLISHER: "PUBLISHER",
  BOARD_DELIVERY: "BOARD_DELIVERY",
});

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeDailySummaryTrack(value, track) {
  const source = value && typeof value === "object" ? value : {};
  const rawDurations = source.durationsSeconds && typeof source.durationsSeconds === "object"
    ? source.durationsSeconds : {};
  const durationsSeconds = {};
  for (const [rawState, rawSeconds] of Object.entries(rawDurations)) {
    const seconds = finiteNonnegative(rawSeconds);
    if (seconds === null) continue;
    const state = normalizeTrackState(track, rawState);
    durationsSeconds[state] = (durationsSeconds[state] || 0) + seconds;
  }
  const durationTotalSeconds = Object.values(durationsSeconds).reduce((sum, seconds) => sum + seconds, 0);
  const observedSeconds = finiteNonnegative(source.observedSeconds);
  const knownSeconds = finiteNonnegative(source.knownSeconds);
  return {
    track,
    durationsSeconds,
    durationTotalSeconds,
    observedSeconds: observedSeconds ?? durationTotalSeconds,
    knownSeconds: knownSeconds ?? Object.entries(durationsSeconds)
      .reduce((sum, [state, seconds]) => sum + (state === "UNKNOWN" ? 0 : seconds), 0),
  };
}

function normalizeDailySummary(value, index) {
  if (!value || typeof value !== "object") return null;
  const dayStartMs = parseHostHealthUtc(firstValue(value, ["dayStartUtc", "startUtc"]));
  const dayEndMs = parseHostHealthUtc(firstValue(value, ["dayEndUtc", "endUtc"]));
  if (dayStartMs === null || dayEndMs === null || dayEndMs <= dayStartMs) return null;
  const dayDurationSeconds = (dayEndMs - dayStartMs) / 1000;
  // A summary describes one bounded UTC-day slice. Reject impossible totals
  // instead of allowing corrupt optional telemetry to distort reliability.
  if (dayDurationSeconds > DAY_MS / 1000 + 1) return null;
  const sourceTracks = value.tracks && typeof value.tracks === "object" ? value.tracks : {};
  const tracks = {};
  for (const [sourceKey, track] of Object.entries(DAILY_SUMMARY_TRACK_KEYS)) {
    const sourceTrack = sourceTracks[sourceKey];
    if (sourceTrack && !tracks[track]) tracks[track] = normalizeDailySummaryTrack(sourceTrack, track);
  }
  for (const track of HOST_HEALTH_TRACKS) tracks[track.key] ||= normalizeDailySummaryTrack({}, track.key);
  if (Object.values(tracks).some((track) => track.durationTotalSeconds > dayDurationSeconds + 1)) return null;
  const eventCounts = {};
  for (const [rawType, rawCount] of Object.entries(value.eventCounts && typeof value.eventCounts === "object" ? value.eventCounts : {})) {
    const count = finiteNonnegative(rawCount);
    const eventType = canonicalUpper(rawType);
    if (!eventType || count === null) continue;
    eventCounts[eventType] = (eventCounts[eventType] || 0) + Math.floor(count);
  }
  const coverageSeconds = finiteNonnegative(value.coverageSeconds) ?? dayDurationSeconds;
  const knownCoverageSeconds = finiteNonnegative(value.knownCoverageSeconds);
  const coverageStartMs = parseHostHealthUtc(value.coverageStartUtc) ?? dayStartMs;
  const coverageEndMs = parseHostHealthUtc(value.coverageEndUtc) ?? dayEndMs;
  if (coverageStartMs < dayStartMs || coverageEndMs > dayEndMs || coverageEndMs <= coverageStartMs) return null;
  const aggregation = value.aggregation && typeof value.aggregation === "object" ? value.aggregation : {};
  const dateUtc = /^\d{4}-\d{2}-\d{2}$/.test(textValue(value.dateUtc))
    ? textValue(value.dateUtc) : new Date(dayStartMs).toISOString().slice(0, 10);
  return {
    id: textValue(value.id) || `daily-summary-${dateUtc}-${index}`,
    dateUtc,
    dayStartMs,
    dayEndMs,
    dayStartUtc: new Date(dayStartMs).toISOString(),
    dayEndUtc: new Date(dayEndMs).toISOString(),
    coverageStartMs,
    coverageEndMs,
    coverageStartUtc: new Date(coverageStartMs).toISOString(),
    coverageEndUtc: new Date(coverageEndMs).toISOString(),
    coverageSeconds: Math.min(dayDurationSeconds, coverageSeconds),
    knownCoverageSeconds: Math.min(dayDurationSeconds, knownCoverageSeconds ?? coverageSeconds),
    partialCoverage: Boolean(value.partialCoverage) || coverageSeconds < dayDurationSeconds,
    tracks,
    eventCounts,
    sourceIntervalCount: Math.max(0, Math.floor(finiteNonnegative(value.sourceIntervalCount) ?? 0)),
    sourceEventCount: Math.max(0, Math.floor(finiteNonnegative(value.sourceEventCount) ?? 0)),
    aggregation: {
      timeBasis: textValue(aggregation.timeBasis, "UTC"),
      timestampBasis: textValue(aggregation.timestampBasis, "EXACT_INTERVAL_BOUNDARIES_SPLIT_AT_UTC_DAY"),
      provenance: textValue(aggregation.provenance, "DERIVED_FROM_EXACT_INTERVALS_AND_EVENTS"),
    },
  };
}

function normalizeRetentionBoundaryGap(value) {
  if (!value || typeof value !== "object") return null;
  const startMs = parseHostHealthUtc(value.startUtc);
  const endMs = parseHostHealthUtc(value.endUtc);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    startMs,
    endMs,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
    reason: normalizeReason(value.reason),
    sourceTimestampType: textValue(firstValue(value, ["timestampBasis", "sourceTimestampType"])) || "ROLLING_RETENTION_BOUNDARY",
    timestampCertainty: textValue(value.timestampCertainty) || "EXPLICITLY_UNAVAILABLE",
  };
}

function normalizeLease(source) {
  const value = source && typeof source === "object" ? source : {};
  const state = canonicalUpper(firstValue(value, ["state", "status"], "UNKNOWN")) || "UNKNOWN";
  const hasExplicitActiveOwner = Object.prototype.hasOwnProperty.call(value, "activeOwner");
  const explicitActiveOwner = canonicalRole(value.activeOwner);
  const legacyOwner = canonicalRole(firstValue(value, ["owner", "leaseOwner", "host"]));
  const activeOwner = ["RELEASED", "EXPIRED"].includes(state) ? null
    : hasExplicitActiveOwner && value.activeOwner === null ? null
    : explicitActiveOwner !== "UNKNOWN"
    ? explicitActiveOwner
    : ["ACQUIRED", "ACTIVE", "HELD"].includes(state) ? legacyOwner : "UNKNOWN";
  return {
    state,
    owner: activeOwner ?? "UNKNOWN",
    activeOwner,
    lastOwner: canonicalRole(firstValue(value, ["lastOwner"], legacyOwner)),
    acquiredUtc: canonicalIso(firstValue(value, ["acquiredUtc", "leaseAcquiredUtc", "startUtc"])),
    expiresUtc: canonicalIso(firstValue(value, ["expiresUtc", "leaseExpiresUtc", "expiryUtc"])),
    releasedUtc: canonicalIso(firstValue(value, ["releasedUtc", "leaseReleasedUtc", "endUtc"])),
    leaseId: textValue(firstValue(value, ["leaseId", "id"])) || null,
    observedUtc: canonicalIso(firstValue(value, ["observedUtc", "updatedUtc"])),
  };
}

function leaseEvidenceMs(lease) {
  return Math.max(
    parseHostHealthUtc(lease?.observedUtc) ?? Number.NEGATIVE_INFINITY,
    parseHostHealthUtc(lease?.releasedUtc) ?? Number.NEGATIVE_INFINITY,
    parseHostHealthUtc(lease?.acquiredUtc) ?? Number.NEGATIVE_INFINITY,
  );
}

function leaseForDisplay(source, nowMs) {
  const lease = normalizeLease(source);
  const expiresMs = parseHostHealthUtc(lease.expiresUtc);
  if (["ACTIVE", "ACQUIRED", "HELD"].includes(lease.state)
      && expiresMs !== null && Number.isFinite(nowMs) && expiresMs < nowMs) {
    return { ...lease, state: "EXPIRED", owner: "UNKNOWN", activeOwner: null };
  }
  return lease;
}

function normalizeCurrent(source) {
  const value = source && typeof source === "object" ? source : {};
  const publisherValue = value.publisher && typeof value.publisher === "object" ? value.publisher : {};
  const deliveryValue = firstValue(value, ["boardDelivery", "boardDeliveryState", "delivery", "deliveryState"]);
  return {
    publisher: canonicalRole(firstValue(publisherValue, ["role", "publisher", "activeRole"], firstValue(value, ["publisher", "activePublisher", "activeRole"]))),
    publisherSinceUtc: canonicalIso(firstValue(publisherValue, ["sinceUtc", "publisherSinceUtc", "activeSinceUtc"], firstValue(value, ["publisherSinceUtc", "activeSinceUtc", "sinceUtc"]))),
    publisherSinceTimestampBasis: textValue(firstValue(publisherValue, ["sinceTimestampBasis", "timestampBasis"])) || null,
    boardDelivery: normalizeBoardDeliveryState(typeof deliveryValue === "object"
      ? firstValue(deliveryValue, ["state", "health", "status"])
      : deliveryValue),
    boardDeliveryReason: deliveryValue && typeof deliveryValue === "object" ? textValue(firstValue(deliveryValue, ["reason", "detail"])) || null : null,
    boardDeliveryAgeMinutes: deliveryValue && typeof deliveryValue === "object" && Number.isFinite(Number(deliveryValue.ageMinutes))
      ? Math.max(0, Number(deliveryValue.ageMinutes)) : null,
    lastSuccessfulPublishUtc: canonicalIso(firstValue(publisherValue, [
      "lastSuccessfulPublishUtc", "lastPublishUtc", "lastSuccessfulPushUtc",
    ], firstValue(value, [
      "lastSuccessfulPublishUtc", "lastPublishUtc", "boardLastPublishUtc", "publishUtc",
    ])) ?? (typeof deliveryValue === "object" ? firstValue(deliveryValue, ["lastPublishUtc", "lastSuccessfulPublishUtc"]) : null)),
    takeoverReason: textValue(firstValue(publisherValue, ["reason", "takeoverReason"], firstValue(value, ["takeoverReason", "publisherReason", "reason"]))) || null,
    rootCauseKnown: Boolean(firstValue(publisherValue, ["rootCauseKnown"], false)),
    lease: normalizeLease(firstValue(value, ["lease"], {})),
  };
}

/**
 * Normalize the generated archive without mutating it. Invalid individual
 * rows are ignored so telemetry corruption cannot affect the operational UI.
 */
export function normalizeHostHealthHistory(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return resultError("INVALID_ARCHIVE", "Host Health archive must be an object");
  }
  const schemaVersion = Number(input.schemaVersion ?? HOST_HEALTH_SCHEMA_VERSION);
  if (schemaVersion !== HOST_HEALTH_SCHEMA_VERSION) {
    return resultError("UNSUPPORTED_SCHEMA", `Unsupported Host Health schema version ${schemaVersion}`, "schemaVersion");
  }
  const intervals = flatIntervals(input.intervals)
    .map(normalizeInterval)
    .filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs || left.track.localeCompare(right.track));
  const events = (Array.isArray(input.events) ? input.events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.eventType.localeCompare(right.eventType));
  const dailySummaries = (Array.isArray(input.dailySummaries) ? input.dailySummaries : [])
    .map(normalizeDailySummary)
    .filter(Boolean)
    .sort((left, right) => left.dayStartMs - right.dayStartMs);
  const hostsSource = input.hosts && typeof input.hosts === "object" ? input.hosts : {};
  const archiveStartedUtc = canonicalIso(firstValue(input, ["archiveStartedUtc", "collectionStartedUtc", "historyStartedUtc", "archiveStartUtc"]));
  const coverageStartUtc = canonicalIso(firstValue(input, ["coverageStartUtc", "knownCoverageStartUtc"], archiveStartedUtc));
  const updatedUtc = canonicalIso(firstValue(input, ["updatedUtc", "archiveUpdatedUtc", "generatedUtc"]));
  return {
    ok: true,
    value: {
      schemaVersion,
      retentionDays: Math.min(HOST_HEALTH_RETENTION_DAYS, Math.max(1, Number(input.retentionDays) || HOST_HEALTH_RETENTION_DAYS)),
      archiveStartedUtc,
      archiveStartedMs: parseHostHealthUtc(archiveStartedUtc),
      coverageStartUtc,
      coverageStartMs: parseHostHealthUtc(coverageStartUtc),
      updatedUtc,
      updatedMs: parseHostHealthUtc(updatedUtc),
      partialHistory: Boolean(input.partialHistory) || coverageStartUtc === null,
      exactHistoryDays: Math.max(0, Math.floor(finiteNonnegative(input.exactHistoryDays) ?? 0)),
      exactHistoryStartUtc: canonicalIso(input.exactHistoryStartUtc),
      exactHistoryStartMs: parseHostHealthUtc(input.exactHistoryStartUtc),
      summarizedThroughUtc: canonicalIso(input.summarizedThroughUtc),
      summarizedThroughMs: parseHostHealthUtc(input.summarizedThroughUtc),
      summaryCoverageStartUtc: canonicalIso(input.summaryCoverageStartUtc),
      summaryCoverageStartMs: parseHostHealthUtc(input.summaryCoverageStartUtc),
      retentionBoundaryGap: normalizeRetentionBoundaryGap(input.retentionBoundaryGap),
      storagePolicy: input.storagePolicy && typeof input.storagePolicy === "object" && !Array.isArray(input.storagePolicy)
        ? {
          mode: textValue(input.storagePolicy.mode) || null,
          exactHistoryDays: Math.max(0, Math.floor(finiteNonnegative(input.storagePolicy.exactHistoryDays) ?? 0)),
          aggregateTimeBasis: textValue(input.storagePolicy.aggregateTimeBasis) || null,
          criticalEventTypesRetainedExact: Array.isArray(input.storagePolicy.criticalEventTypesRetainedExact)
            ? input.storagePolicy.criticalEventTypesRetainedExact.map(canonicalUpper).filter(Boolean) : [],
          criticalEventsAlsoCountedInDailySummaries: Boolean(input.storagePolicy.criticalEventsAlsoCountedInDailySummaries),
        }
        : null,
      thresholds: {
        healthyMinutes: Number(input.thresholds?.healthyMinutes) || HOST_HEALTH_DEFAULT_THRESHOLDS_MINUTES.delayedAfter,
        failoverMinutes: Number(input.thresholds?.failoverMinutes) || HOST_HEALTH_DEFAULT_THRESHOLDS_MINUTES.staleAfter,
        boardGapMinutes: Number(input.thresholds?.boardGapMinutes) || 30,
      },
      hosts: {
        PRIMARY: normalizeHostSnapshot(hostsSource.PRIMARY || hostsSource.primary, "PRIMARY"),
        BACKUP: normalizeHostSnapshot(hostsSource.BACKUP || hostsSource.backup, "BACKUP"),
      },
      current: normalizeCurrent(input.current),
      intervals,
      events,
      dailySummaries,
    },
  };
}

function ageMinutes(timestamp, nowMs) {
  const sourceMs = parseHostHealthUtc(timestamp);
  if (sourceMs === null || !Number.isFinite(nowMs) || sourceMs > nowMs + 2 * MINUTE_MS) return null;
  return Math.max(0, (nowMs - sourceMs) / MINUTE_MS);
}

function classifyAge(age, thresholds) {
  if (!Number.isFinite(age)) return "UNKNOWN";
  if (age <= thresholds.delayedAfter) return "HEALTHY";
  if (age <= thresholds.staleAfter) return "DELAYED";
  return "STALE";
}

const HEALTH_SEVERITY = Object.freeze({ UNKNOWN: 0, HEALTHY: 1, DELAYED: 2, STALE: 3, ERROR: 4, UNAVAILABLE: 4 });

function worseHealth(explicitState, ageState) {
  const explicit = normalizeHostHealthState(explicitState);
  const aged = normalizeHostHealthState(ageState);
  if (aged === "UNKNOWN") return explicit;
  if (explicit === "UNKNOWN") return aged;
  return HEALTH_SEVERITY[aged] > HEALTH_SEVERITY[explicit] ? aged : explicit;
}

function latestUtc(...values) {
  let latestMs = null;
  for (const value of values) {
    const ms = parseHostHealthUtc(value);
    if (ms !== null && (latestMs === null || ms > latestMs)) latestMs = ms;
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
}

function mergeObservedHost(currentHost, fallbackStatus, expectedRole, nowMs, thresholds) {
  const archiveHost = normalizeHostSnapshot(currentHost, expectedRole);
  const statusRole = canonicalRole(fallbackStatus?.activeRole);
  const statusHost = statusRole === expectedRole ? normalizeHostSnapshot({
    ...fallbackStatus,
    roleState: "ACTIVE PUBLISHER",
    observed: true,
  }, expectedRole) : normalizeHostSnapshot({}, expectedRole);
  const archiveHeartbeatMs = parseHostHealthUtc(archiveHost.heartbeatUtc);
  const statusHeartbeatMs = parseHostHealthUtc(statusHost.heartbeatUtc);
  const statusIsCurrent = statusRole === expectedRole && statusHeartbeatMs !== null
    && (archiveHeartbeatMs === null || statusHeartbeatMs >= archiveHeartbeatMs);
  const observed = statusIsCurrent ? true : archiveHost.observed;
  const heartbeatUtc = statusIsCurrent ? statusHost.heartbeatUtc : archiveHost.heartbeatUtc;
  const explicitHealth = statusIsCurrent && statusHost.health !== "UNKNOWN" ? statusHost.health : archiveHost.health;
  const heartbeatAgeMinutes = ageMinutes(heartbeatUtc, nowMs) ?? archiveHost.heartbeatAgeMinutes ?? statusHost.heartbeatAgeMinutes;
  const ageHealth = classifyAge(heartbeatAgeMinutes, thresholds);
  const health = !observed ? "UNKNOWN" : worseHealth(explicitHealth, ageHealth);
  return {
    ...statusHost,
    ...archiveHost,
    role: expectedRole,
    observed,
    heartbeatUtc,
    lastSuccessfulUpdateUtc: latestUtc(archiveHost.lastSuccessfulUpdateUtc, statusHost.lastSuccessfulUpdateUtc),
    lastSuccessfulPushUtc: latestUtc(archiveHost.lastSuccessfulPushUtc, statusHost.lastSuccessfulPushUtc),
    sourceSha: statusIsCurrent ? statusHost.sourceSha || archiveHost.sourceSha : archiveHost.sourceSha,
    taskStatus: statusIsCurrent ? statusHost.taskStatus : archiveHost.taskStatus,
    lastError: statusIsCurrent ? statusHost.lastError : archiveHost.lastError,
    health,
    reason: health !== explicitHealth && ageHealth === health
      ? `HEARTBEAT AGE ${Math.floor(heartbeatAgeMinutes)} MINUTES`
      : statusIsCurrent ? statusHost.reason || archiveHost.reason : archiveHost.reason,
    heartbeatAgeMinutes,
  };
}

/** Current display state from archive plus the two generated live snapshots. */
export function deriveHostHealthCurrent(historyValue, hostStatus = {}, leaseStatus = {}, nowValue = Date.now()) {
  const normalized = historyValue?.ok === true ? historyValue : normalizeHostHealthHistory(historyValue || {});
  const history = normalized.ok ? normalized.value : normalizeHostHealthHistory({ schemaVersion: 1 }).value;
  const nowMs = parseHostHealthUtc(nowValue instanceof Date ? nowValue : typeof nowValue === "number" ? nowValue : String(nowValue));
  const effectiveNow = nowMs ?? Date.now();
  const configured = historyValue?.thresholds || history?.thresholds || {};
  const thresholds = {
    delayedAfter: Number(configured.delayedAfter ?? configured.delayedMinutes ?? configured.healthyMinutes) || HOST_HEALTH_DEFAULT_THRESHOLDS_MINUTES.delayedAfter,
    staleAfter: Number(configured.staleAfter ?? configured.staleMinutes ?? configured.failoverMinutes) || HOST_HEALTH_DEFAULT_THRESHOLDS_MINUTES.staleAfter,
  };
  const boardThresholds = {
    delayedAfter: Number(configured.boardHealthyMinutes ?? configured.healthyMinutes) || 15,
    staleAfter: Number(configured.boardGapMinutes) || 30,
  };
  const liveRole = canonicalRole(hostStatus?.activeRole);
  const liveHeartbeatUtc = canonicalIso(hostStatus?.heartbeatUtc);
  const liveHeartbeatMs = parseHostHealthUtc(liveHeartbeatUtc);
  const newestArchiveHeartbeatMs = Math.max(
    parseHostHealthUtc(history.hosts.PRIMARY.heartbeatUtc) ?? Number.NEGATIVE_INFINITY,
    parseHostHealthUtc(history.hosts.BACKUP.heartbeatUtc) ?? Number.NEGATIVE_INFINITY,
  );
  const liveStatusIsCurrent = liveRole !== "UNKNOWN" && liveHeartbeatMs !== null
    && ageMinutes(liveHeartbeatUtc, effectiveNow) !== null
    && (history.current.publisher === "UNKNOWN" || liveHeartbeatMs >= newestArchiveHeartbeatMs);
  const publisher = liveStatusIsCurrent ? liveRole : history.current.publisher !== "UNKNOWN"
    ? history.current.publisher : liveRole;
  const primary = mergeObservedHost(history.hosts.PRIMARY, hostStatus, "PRIMARY", effectiveNow, thresholds);
  const backup = mergeObservedHost(history.hosts.BACKUP, hostStatus, "BACKUP", effectiveNow, thresholds);
  if (liveStatusIsCurrent && publisher === "PRIMARY") {
    // A single active-publisher status document proves PRIMARY is current but
    // does not observe its now-inactive BACKUP peer. Retain BACKUP timestamps
    // as evidence without converting their age into a health assertion.
    backup.observed = false;
    backup.health = "UNKNOWN";
    backup.reason = "INACTIVE_HOST_HEALTH_NOT_OBSERVED";
  }
  primary.roleState = publisher === "PRIMARY" ? "ACTIVE PUBLISHER"
    : publisher === "BACKUP" ? "PREFERRED HOST · NOT PUBLISHING"
    : primary.observed ? "PREFERRED HOST · PUBLISHER UNKNOWN" : "PREFERRED HOST · NOT OBSERVED";
  backup.roleState = publisher === "BACKUP" ? "ACTIVE PUBLISHER"
    : backup.observed && backup.health === "HEALTHY" ? "HEALTHY STANDBY"
    : backup.observed ? "STANDBY · LAST OBSERVED" : "STANDBY · NOT CURRENTLY OBSERVED";
  const archiveLease = normalizeLease(history.current.lease);
  const liveLease = leaseStatus && typeof leaseStatus === "object" && Object.keys(leaseStatus).length > 0
    ? normalizeLease(leaseStatus) : null;
  const archiveLeaseEvidenceMs = leaseEvidenceMs(archiveLease);
  const liveLeaseEvidenceMs = leaseEvidenceMs(liveLease);
  // These three resources are fetched independently and can briefly straddle
  // two GitHub Pages deployments. Never let an older lease snapshot replace
  // newer evidence already retained in the archive.
  const leaseSource = liveLease && liveLeaseEvidenceMs !== Number.NEGATIVE_INFINITY
    && liveLeaseEvidenceMs >= archiveLeaseEvidenceMs ? liveLease : archiveLease;
  const lease = leaseForDisplay(leaseSource, effectiveNow);
  const publisherHost = publisher === "PRIMARY" ? primary : publisher === "BACKUP" ? backup : null;
  const archivedPublishUtc = history.current.lastSuccessfulPublishUtc;
  const liveSuccessfulUpdateUtc = liveStatusIsCurrent
    ? canonicalIso(firstValue(hostStatus, ["lastSuccessfulUpdateUtc"])) : null;
  const archivedPublishMs = parseHostHealthUtc(archivedPublishUtc);
  const liveSuccessfulUpdateMs = parseHostHealthUtc(liveSuccessfulUpdateUtc);
  const livePublishIsNewer = liveStatusIsCurrent && liveSuccessfulUpdateMs !== null
    && (archivedPublishMs === null || liveSuccessfulUpdateMs > archivedPublishMs);
  const publishUtc = livePublishIsNewer
    ? liveSuccessfulUpdateUtc
    : archivedPublishUtc || (liveStatusIsCurrent ? liveSuccessfulUpdateUtc : null)
      || publisherHost?.lastSuccessfulUpdateUtc || null;
  const publishAge = ageMinutes(publishUtc, effectiveNow);
  const explicitDelivery = history.current.boardDelivery;
  const agedDelivery = classifyAge(publishAge, boardThresholds);
  // A newer successful live updater run is affirmative recovery evidence. It
  // must be allowed to clear a stale archived GAP when the optional telemetry
  // archive missed a cycle. Without newer live evidence, age may only worsen
  // the last archived delivery assertion.
  const boardDeliveryHealth = livePublishIsNewer
    ? normalizeHostHealthState(agedDelivery)
    : worseHealth(boardStateToHealth(explicitDelivery), agedDelivery);
  const boardDelivery = boardDeliveryHealth === "HEALTHY" ? "CONTINUOUS"
    : boardDeliveryHealth === "DELAYED" ? "DELAYED"
    : boardDeliveryHealth === "UNKNOWN" ? "UNKNOWN" : "GAP";
  const latestPublisherTransition = [...history.events]
    .filter((event) => event.timestampMs <= effectiveNow
      && ["BACKUP_TAKEOVER", "PRIMARY_HANDOFF", "PRIMARY_HANDOFF_COMPLETE"].includes(event.eventType))
    .sort((left, right) => right.timestampMs - left.timestampMs)[0] || null;
  return {
    nowMs: effectiveNow,
    liveStatusIsCurrent,
    currentEvidenceUtc: liveStatusIsCurrent ? liveHeartbeatUtc : null,
    publisher,
    publisherSinceUtc: liveStatusIsCurrent && liveRole !== history.current.publisher ? liveHeartbeatUtc : history.current.publisherSinceUtc,
    publisherSinceTimestampBasis: liveStatusIsCurrent && liveRole !== history.current.publisher
      ? "FIRST_OBSERVED_LIVE_HOST_STATUS" : history.current.publisherSinceTimestampBasis,
    takeoverReason: liveStatusIsCurrent && liveRole !== history.current.publisher
      ? "PUBLISHER CHANGE FIRST OBSERVED IN LIVE HOST STATUS" : history.current.takeoverReason,
    rootCauseKnown: liveStatusIsCurrent && liveRole !== history.current.publisher ? false : history.current.rootCauseKnown,
    boardDelivery,
    boardDeliveryHealth,
    boardDeliveryReason: livePublishIsNewer
      ? `LIVE SUCCESSFUL UPDATE IS ${Math.floor(publishAge)} MINUTES OLD`
      : boardDelivery !== explicitDelivery && boardDeliveryHealth === agedDelivery
      ? `LAST SUCCESSFUL PUBLISH IS ${Math.floor(publishAge)} MINUTES OLD`
      : history.current.boardDeliveryReason,
    lastSuccessfulPublishUtc: publishUtc,
    publishAgeMinutes: publishAge,
    latestPublisherTransition,
    lease,
    hosts: { PRIMARY: primary, BACKUP: backup },
  };
}

export function getHostHealthRange(rangeKey = "24h", nowValue = Date.now()) {
  const compact = textValue(rangeKey, "24h").toLowerCase().replace(/[\s_-]+/g, "");
  const key = RANGE_ALIASES[compact];
  const endMs = parseHostHealthUtc(nowValue instanceof Date ? nowValue : typeof nowValue === "number" ? nowValue : String(nowValue));
  if (!key || endMs === null) return null;
  const definition = HOST_HEALTH_RANGES.find((item) => item.key === key);
  return { ...definition, startMs: endMs - definition.durationMs, endMs };
}

function validBounds(value) {
  const startMs = Number(value?.startMs ?? value?.visibleStartMs);
  const endMs = Number(value?.endMs ?? value?.visibleEndMs);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : null;
}

function normalizedDomain(master, visible, minVisibleMs = HOST_HEALTH_MIN_VISIBLE_MS) {
  const masterBounds = validBounds(master);
  const requested = validBounds(visible) || masterBounds;
  if (!masterBounds || !requested) return resultError("INVALID_DOMAIN", "Invalid Host Health time domain");
  const masterDurationMs = masterBounds.endMs - masterBounds.startMs;
  const minimum = Math.min(masterDurationMs, Math.max(1, Number(minVisibleMs) || HOST_HEALTH_MIN_VISIBLE_MS));
  const durationMs = Math.min(masterDurationMs, Math.max(minimum, requested.endMs - requested.startMs));
  let startMs = requested.startMs;
  let endMs = startMs + durationMs;
  if (startMs < masterBounds.startMs) { startMs = masterBounds.startMs; endMs = startMs + durationMs; }
  if (endMs > masterBounds.endMs) { endMs = masterBounds.endMs; startMs = endMs - durationMs; }
  const full = durationMs >= masterDurationMs - 0.5;
  return {
    ok: true,
    masterStartMs: masterBounds.startMs,
    masterEndMs: masterBounds.endMs,
    masterDurationMs,
    startMs,
    endMs,
    durationMs,
    minVisibleMs: minimum,
    isFullRange: full,
    canZoomIn: durationMs > minimum + 0.5,
    canZoomOut: !full,
  };
}

export function createHostHealthTimeDomain(master, visible = null, options = {}) {
  return normalizedDomain(master, visible || master, options.minVisibleMs);
}

export function zoomHostHealthTimeDomain(domain, factor, anchor = 0.5) {
  if (!domain?.ok) return resultError("INVALID_DOMAIN", "A normalized Host Health domain is required");
  const numericFactor = Number(factor);
  const ratio = Math.max(0, Math.min(1, Number(anchor)));
  if (!(numericFactor > 0) || !Number.isFinite(ratio)) return resultError("INVALID_ZOOM", "Invalid zoom request");
  const durationMs = Math.min(domain.masterDurationMs, Math.max(domain.minVisibleMs, domain.durationMs / numericFactor));
  const anchorMs = domain.startMs + domain.durationMs * ratio;
  const startMs = anchorMs - durationMs * ratio;
  return normalizedDomain(
    { startMs: domain.masterStartMs, endMs: domain.masterEndMs },
    { startMs, endMs: startMs + durationMs },
    domain.minVisibleMs,
  );
}

export function panHostHealthTimeDomain(domain, deltaMs) {
  if (!domain?.ok || !Number.isFinite(Number(deltaMs))) return resultError("INVALID_PAN", "Invalid pan request");
  return normalizedDomain(
    { startMs: domain.masterStartMs, endMs: domain.masterEndMs },
    { startMs: domain.startMs + Number(deltaMs), endMs: domain.endMs + Number(deltaMs) },
    domain.minVisibleMs,
  );
}

export function resetHostHealthTimeDomain(domain) {
  if (!domain?.ok) return resultError("INVALID_DOMAIN", "A normalized Host Health domain is required");
  return normalizedDomain(
    { startMs: domain.masterStartMs, endMs: domain.masterEndMs },
    { startMs: domain.masterStartMs, endMs: domain.masterEndMs },
    domain.minVisibleMs,
  );
}

function clippedIntervals(history, range) {
  return history.intervals.flatMap((interval) => {
    const endMs = interval.endMs ?? range.endMs;
    const startMs = Math.max(range.startMs, interval.startMs);
    const clippedEnd = Math.min(range.endMs, endMs);
    return clippedEnd > startMs ? [{ ...interval, startMs, endMs: clippedEnd, durationMs: clippedEnd - startMs }] : [];
  });
}

function addPublisherContext(intervals) {
  const publisherIntervals = intervals.filter((interval) => interval.track === "PUBLISHER" && interval.state !== "UNKNOWN");
  return intervals.flatMap((interval) => {
    if (interval.track !== "BOARD_DELIVERY" || interval.publisher !== "UNKNOWN") return [interval];
    const overlaps = publisherIntervals.filter((candidate) => candidate.startMs < interval.endMs && candidate.endMs > interval.startMs);
    if (!overlaps.length) return [interval];
    const boundaries = [...new Set([
      interval.startMs,
      interval.endMs,
      ...overlaps.flatMap((candidate) => [
        Math.max(interval.startMs, candidate.startMs),
        Math.min(interval.endMs, candidate.endMs),
      ]),
    ])].sort((left, right) => left - right);
    return boundaries.slice(0, -1).map((startMs, index) => {
      const endMs = boundaries[index + 1];
      const publisher = overlaps.find((candidate) => candidate.startMs <= startMs && candidate.endMs >= endMs);
      return {
        ...interval,
        id: `${interval.id}-publisher-context-${index}`,
        startMs,
        endMs,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        durationMs: endMs - startMs,
        publisher: publisher?.state || "UNKNOWN",
      };
    });
  });
}

function summariesForRange(history, range, exactIntervals) {
  const included = [];
  let excludedBoundaryCount = 0;
  let excludedOverlapCount = 0;
  for (const summary of history.dailySummaries || []) {
    const summaryStartMs = summary.coverageStartMs ?? summary.dayStartMs;
    const summaryEndMs = summary.coverageEndMs ?? summary.dayEndMs;
    if (summaryEndMs <= range.startMs || summaryStartMs >= range.endMs) continue;
    // Daily aggregate state durations cannot be truthfully apportioned into an
    // arbitrary fraction of a day. Keep a clipped edge explicitly unknown.
    if (summaryStartMs < range.startMs || summaryEndMs > range.endMs) {
      excludedBoundaryCount += 1;
      continue;
    }
    // The writer guarantees exact and summarized history do not overlap. This
    // defensive check fails closed if a malformed/mixed-version archive does.
    const overlapsExact = exactIntervals.some((interval) => {
      const endMs = interval.endMs ?? range.endMs;
      return interval.startMs < summary.dayEndMs && endMs > summary.dayStartMs;
    });
    if (overlapsExact) {
      excludedOverlapCount += 1;
      continue;
    }
    included.push(summary);
  }
  return { included, excludedBoundaryCount, excludedOverlapCount };
}

const THRESHOLD_CROSSING_MS = 1000;

function splitOpenIntervalAtThresholds(interval, transitions, rangeEndMs) {
  if (interval.endMs !== null || !transitions.length) return { intervals: [interval], events: [] };
  const ordered = transitions
    .filter((item) => Number.isFinite(item.atMs) && item.atMs > interval.startMs && item.atMs <= rangeEndMs)
    .sort((left, right) => left.atMs - right.atMs);
  if (!ordered.length) return { intervals: [interval], events: [] };
  const intervals = [];
  const events = [];
  let startMs = interval.startMs;
  let state = interval.state;
  let reason = interval.reason;
  let sourceTimestampType = interval.sourceTimestampType;
  let timestampCertainty = interval.timestampCertainty;
  let inferred = interval.inferred;
  for (const transition of ordered) {
    const currentHealth = interval.track === "BOARD_DELIVERY"
      ? boardStateToHealth(state) : normalizeHostHealthState(state);
    if ((HEALTH_SEVERITY[normalizeHostHealthState(transition.healthState)] || 0)
        <= (HEALTH_SEVERITY[currentHealth] || 0)) continue;
    intervals.push({
      ...interval, id: `${interval.id}-until-${transition.eventType.toLowerCase()}`,
      state, startMs, endMs: transition.atMs,
      startUtc: new Date(startMs).toISOString(), endUtc: new Date(transition.atMs).toISOString(),
      reason, sourceTimestampType, timestampCertainty, inferred,
    });
    startMs = transition.atMs;
    state = transition.state;
    reason = transition.reason;
    sourceTimestampType = transition.sourceTimestampType;
    timestampCertainty = transition.timestampCertainty;
    inferred = true;
    events.push({
      id: `derived-${transition.eventType.toLowerCase()}-${transition.atMs}`,
      eventType: transition.eventType,
      host: interval.host,
      timestampMs: transition.atMs,
      timestampUtc: new Date(transition.atMs).toISOString(),
      reason, publisher: transition.publisher || interval.publisher,
      leaseOwner: "UNKNOWN", sourceTimestampType, timestampCertainty,
      inferred: true, sourceSha: interval.sourceSha,
    });
  }
  intervals.push({
    ...interval, id: `${interval.id}-derived-current`, state, startMs, endMs: null,
    startUtc: new Date(startMs).toISOString(), endUtc: null,
    reason, sourceTimestampType, timestampCertainty, inferred,
  });
  return { intervals, events };
}

function projectOpenIntervalAging(history, rangeEndMs) {
  const intervals = [];
  const events = [];
  const activeRole = history.current.publisher;
  const activeTrack = activeRole === "PRIMARY" ? "PRIMARY_HEALTH"
    : activeRole === "BACKUP" ? "BACKUP_HEALTH" : null;
  const hostSnapshot = activeRole === "PRIMARY" ? history.hosts.PRIMARY
    : activeRole === "BACKUP" ? history.hosts.BACKUP : null;
  const heartbeatMs = parseHostHealthUtc(hostSnapshot?.heartbeatUtc);
  const publishMs = parseHostHealthUtc(history.current.lastSuccessfulPublishUtc);
  const hostTransitions = heartbeatMs === null || !hostSnapshot?.observed ? [] : [
    {
      atMs: heartbeatMs + history.thresholds.healthyMinutes * MINUTE_MS + THRESHOLD_CROSSING_MS,
      state: "DELAYED", healthState: "DELAYED", eventType: `${activeRole}_DELAYED`,
      reason: "HEARTBEAT_EXCEEDED_HEALTHY_THRESHOLD", sourceTimestampType: "HEALTHY_THRESHOLD_DERIVED",
      timestampCertainty: "DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD", publisher: activeRole,
    },
    {
      atMs: heartbeatMs + history.thresholds.failoverMinutes * MINUTE_MS + THRESHOLD_CROSSING_MS,
      state: "STALE", healthState: "STALE", eventType: `${activeRole}_STALE`,
      reason: "HEARTBEAT_EXCEEDED_FAILOVER_THRESHOLD", sourceTimestampType: "FAILOVER_THRESHOLD_DERIVED",
      timestampCertainty: "DERIVED_FROM_HEARTBEAT_AND_CONFIGURED_THRESHOLD", publisher: activeRole,
    },
  ];
  const boardTransitions = publishMs === null ? [] : [
    {
      atMs: publishMs + history.thresholds.healthyMinutes * MINUTE_MS + THRESHOLD_CROSSING_MS,
      state: "DELAYED", healthState: "DELAYED", eventType: "BOARD_DELAYED",
      reason: "BOARD_PUBLISH_DELAYED", sourceTimestampType: "BOARD_PUBLISH_DELAY_THRESHOLD_DERIVED",
      timestampCertainty: "DERIVED_FROM_PUBLISH_TIMESTAMPS_AND_THRESHOLD", publisher: activeRole,
    },
    {
      atMs: publishMs + history.thresholds.boardGapMinutes * MINUTE_MS + THRESHOLD_CROSSING_MS,
      state: "GAP", healthState: "STALE", eventType: "BOARD_PUBLISH_GAP",
      reason: "BOARD_PUBLISH_EXCEEDED_GAP_THRESHOLD", sourceTimestampType: "BOARD_PUBLISH_GAP_THRESHOLD_DERIVED",
      timestampCertainty: "DERIVED_FROM_PUBLISH_TIMESTAMPS_AND_THRESHOLD", publisher: activeRole,
    },
  ];
  for (const interval of history.intervals) {
    const transitions = interval.track === activeTrack ? hostTransitions
      : interval.track === "BOARD_DELIVERY" ? boardTransitions : [];
    const projected = splitOpenIntervalAtThresholds(interval, transitions, rangeEndMs);
    intervals.push(...projected.intervals);
    events.push(...projected.events);
  }
  return { intervals, events };
}

/** Build four truthful tracks for one visible range. Missing coverage stays empty/unknown. */
export function buildHostHealthTimeline(historyValue, rangeValue, nowValue = Date.now(), options = {}) {
  const normalized = historyValue?.ok === true ? historyValue : normalizeHostHealthHistory(historyValue);
  if (!normalized?.ok) return normalized || resultError("INVALID_ARCHIVE", "Host Health archive is unavailable");
  const nowMs = parseHostHealthUtc(nowValue instanceof Date ? nowValue : typeof nowValue === "number" ? nowValue : String(nowValue));
  const range = validBounds(rangeValue) || getHostHealthRange(rangeValue?.key || rangeValue || "24h", nowMs ?? Date.now());
  if (!range) return resultError("INVALID_RANGE", "Host Health range is invalid");
  const actualRange = { ...range, durationMs: range.endMs - range.startMs };
  const liveEvidenceMs = options.currentEvidence?.liveStatusIsCurrent
    ? parseHostHealthUtc(options.currentEvidence.currentEvidenceUtc) : null;
  const archiveUpdatedMs = normalized.value.updatedMs;
  const liveEvidenceNewer = liveEvidenceMs !== null && archiveUpdatedMs !== null && liveEvidenceMs > archiveUpdatedMs;
  // If the optional archive missed a cycle while live status advanced, do not
  // fabricate continuity or a handoff between those sources. End archival
  // intervals at its own timestamp and leave the newer span explicitly blank;
  // current cards remain driven by the newer live snapshot.
  const projected = liveEvidenceNewer
    ? {
      intervals: normalized.value.intervals.map((interval) => interval.endMs === null
        ? { ...interval, endMs: archiveUpdatedMs, endUtc: new Date(archiveUpdatedMs).toISOString() }
        : interval),
      events: [],
    }
    : projectOpenIntervalAging(normalized.value, actualRange.endMs);
  const intervals = addPublisherContext(clippedIntervals({ intervals: projected.intervals }, actualRange));
  const summarySelection = summariesForRange(normalized.value, actualRange, projected.intervals);
  const retentionBoundaryGap = normalized.value.retentionBoundaryGap
    && normalized.value.retentionBoundaryGap.startMs < actualRange.endMs
    && normalized.value.retentionBoundaryGap.endMs > actualRange.startMs
    ? normalized.value.retentionBoundaryGap : null;
  const eventKeys = new Set(normalized.value.events.map((event) => `${event.eventType}|${event.timestampMs}`));
  const events = [...normalized.value.events, ...projected.events.filter((event) => !eventKeys.has(`${event.eventType}|${event.timestampMs}`))]
    .filter((event) => event.timestampMs >= actualRange.startMs && event.timestampMs <= actualRange.endMs)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.eventType.localeCompare(right.eventType));
  return {
    ok: true,
    value: {
      range: actualRange,
      archiveStartedMs: normalized.value.archiveStartedMs,
      coverageStartMs: normalized.value.coverageStartMs,
      coverageEndMs: liveEvidenceNewer ? archiveUpdatedMs : actualRange.endMs,
      liveEvidenceNewer,
      partialHistory: liveEvidenceNewer || normalized.value.partialHistory
        || normalized.value.coverageStartMs === null || normalized.value.coverageStartMs > actualRange.startMs
        || summarySelection.excludedBoundaryCount > 0 || summarySelection.excludedOverlapCount > 0
        || summarySelection.included.some((summary) => summary.partialCoverage) || retentionBoundaryGap !== null,
      exactHistoryStartMs: normalized.value.exactHistoryStartMs,
      summarizedThroughMs: normalized.value.summarizedThroughMs,
      dailySummaries: summarySelection.included,
      summaryBoundaryDaysExcluded: summarySelection.excludedBoundaryCount,
      summaryOverlapDaysExcluded: summarySelection.excludedOverlapCount,
      retentionBoundaryGap,
      tracks: HOST_HEALTH_TRACKS.map((track) => ({ ...track, intervals: intervals.filter((item) => item.track === track.key) })),
      intervals,
      events,
    },
  };
}

function sumDurations(intervals, predicate = () => true) {
  return intervals.reduce((sum, interval) => sum + (predicate(interval) ? interval.durationMs : 0), 0);
}

function percent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

/** Selected-range reliability metrics. Percentages use known intervals only. */
export function calculateHostHealthMetrics(timelineValue) {
  const timeline = timelineValue?.value || timelineValue;
  if (!timeline?.range || !Array.isArray(timeline.intervals)) return resultError("INVALID_TIMELINE", "Host Health timeline is invalid");
  const byTrack = (track) => timeline.intervals.filter((item) => item.track === track);
  const summaries = Array.isArray(timeline.dailySummaries) ? timeline.dailySummaries : [];
  const summarySeconds = (track, predicate = () => true) => summaries.reduce((total, summary) => {
    const durations = summary.tracks?.[track]?.durationsSeconds || {};
    return total + Object.entries(durations).reduce((sum, [state, seconds]) => sum + (predicate(state) ? seconds : 0), 0);
  }, 0);
  const availability = (track) => {
    const values = byTrack(track);
    const known = sumDurations(values, (item) => item.state !== "UNKNOWN")
      + summarySeconds(track, (state) => state !== "UNKNOWN") * 1000;
    const healthy = sumDurations(values, (item) => item.state === "HEALTHY")
      + summarySeconds(track, (state) => state === "HEALTHY") * 1000;
    return { knownMs: known, healthyMs: healthy, percent: percent(healthy, known) };
  };
  const boardValues = byTrack("BOARD_DELIVERY");
  const boardKnown = sumDurations(boardValues, (item) => item.state !== "UNKNOWN")
    + summarySeconds("BOARD_DELIVERY", (state) => state !== "UNKNOWN") * 1000;
  const boardHealthy = sumDurations(boardValues, (item) => item.state === "CONTINUOUS")
    + summarySeconds("BOARD_DELIVERY", (state) => state === "CONTINUOUS") * 1000;
  const gaps = boardValues.filter((item) => item.state === "GAP");
  const summaryEventCounts = {};
  for (const summary of summaries) {
    for (const [eventType, count] of Object.entries(summary.eventCounts || {})) {
      summaryEventCounts[eventType] = (summaryEventCounts[eventType] || 0) + count;
    }
  }
  const summaryContains = (event) => summaries.some((summary) => event.timestampMs >= summary.dayStartMs && event.timestampMs < summary.dayEndMs);
  const exactEventCounts = {};
  for (const event of timeline.events) {
    if (event.includedInDailySummary && summaryContains(event)) continue;
    exactEventCounts[event.eventType] = (exactEventCounts[event.eventType] || 0) + 1;
  }
  const eventCount = (eventType) => (summaryEventCounts[eventType] || 0) + (exactEventCounts[eventType] || 0);
  const allEventTypes = new Set([...Object.keys(summaryEventCounts), ...Object.keys(exactEventCounts)]);
  const failedHandoffCount = [...allEventTypes]
    .filter((type) => type.includes("HANDOFF") && (type.includes("FAIL") || type.includes("INCOMPLETE")))
    .reduce((sum, type) => sum + eventCount(type), 0);
  const summarizedBoardGapMs = summarySeconds("BOARD_DELIVERY", (state) => state === "GAP") * 1000;
  const knownCoverageByTrack = HOST_HEALTH_TRACKS.map((track) => {
    const exact = sumDurations(byTrack(track.key), (item) => item.state !== "UNKNOWN");
    return exact + summarySeconds(track.key, (state) => state !== "UNKNOWN") * 1000;
  });
  return {
    ok: true,
    value: {
      primaryAvailability: availability("PRIMARY_HEALTH"),
      backupAvailability: availability("BACKUP_HEALTH"),
      boardPublishingCoverage: { knownMs: boardKnown, healthyMs: boardHealthy, percent: percent(boardHealthy, boardKnown) },
      knownCoverageMs: Math.max(...knownCoverageByTrack, 0),
      selectedDurationMs: timeline.range.durationMs,
      partialHistory: Boolean(timeline.partialHistory),
      aggregateHistoryUsed: summaries.length > 0,
      summarizedDays: summaries.length,
      failovers: eventCount("BACKUP_TAKEOVER"),
      successfulHandoffs: eventCount("PRIMARY_HANDOFF") + eventCount("PRIMARY_HANDOFF_COMPLETE"),
      failedHandoffs: failedHandoffCount || null,
      failedHandoffsKnown: failedHandoffCount > 0,
      longestBoardGapMs: summarizedBoardGapMs > 0
        ? null : gaps.reduce((longest, item) => Math.max(longest, item.durationMs), 0),
      longestBoardGapKnown: summarizedBoardGapMs === 0,
      timeRunningOnBackupMs: sumDurations(byTrack("PUBLISHER"), (item) => item.state === "BACKUP")
        + summarySeconds("PUBLISHER", (state) => state === "BACKUP") * 1000,
    },
  };
}

const TICK_INTERVALS = Object.freeze([
  5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS,
  6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS,
]);

export function selectHostHealthTicks(range, targetCount = 6) {
  const bounds = validBounds(range);
  if (!bounds) return [];
  const durationMs = bounds.endMs - bounds.startMs;
  const desired = durationMs / Math.max(1, Number(targetCount) - 1);
  const intervalMs = TICK_INTERVALS.find((candidate) => candidate >= desired) || TICK_INTERVALS.at(-1);
  const ticks = [];
  for (let ms = Math.ceil(bounds.startMs / intervalMs) * intervalMs; ms <= bounds.endMs; ms += intervalMs) ticks.push(ms);
  return ticks;
}

function formatter(timeZone, options) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, ...options });
}

export function formatHostHealthTime(value, basis = "Z", options = {}) {
  const ms = parseHostHealthUtc(value);
  if (ms === null) return "UNKNOWN";
  const normalizedBasis = canonicalUpper(basis) === "LOCAL" ? "LOCAL" : "Z";
  const date = new Date(ms);
  if (normalizedBasis === "Z") {
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][date.getUTCMonth()];
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    return options.compact ? `${hh}${mm}Z` : `${day} ${month} ${date.getUTCFullYear()} ${hh}${mm}Z`;
  }
  const parts = formatter(HOST_HEALTH_TIME_ZONE, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  const compact = `${part("hour")}${part("minute")}L ${part("timeZoneName")}`.toUpperCase();
  return options.compact ? compact : `${part("day")} ${part("month").toUpperCase()} ${part("year")} ${compact}`;
}

export function formatHostHealthDuration(durationMs) {
  const totalMinutes = Math.max(0, Math.round(Number(durationMs) / MINUTE_MS));
  if (!Number.isFinite(totalMinutes)) return "UNKNOWN";
  if (totalMinutes < 60) return `${totalMinutes} MIN`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes ? `${hours} HR ${minutes} MIN` : `${hours} HR`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} DAY ${remainingHours} HR` : `${days} DAY`;
}
