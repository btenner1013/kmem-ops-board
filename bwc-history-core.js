export const BWC_HISTORY_SCHEMA_VERSION = 1;

export const BWC_STATES = Object.freeze(["LOW", "MODERATE", "SEVERE"]);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_CONTINUITY_MINUTES = 90;
const MEMPHIS_TIME_ZONE = "America/Chicago";
const MONTHS = Object.freeze([
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
]);

export const BWC_RANGE_DURATIONS_MS = Object.freeze({
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
  "365d": 365 * DAY_MS,
});

export const BWC_RANGES = Object.freeze([
  Object.freeze({ key: "24h", label: "24 HR", durationMs: BWC_RANGE_DURATIONS_MS["24h"] }),
  Object.freeze({ key: "7d", label: "7 DAYS", durationMs: BWC_RANGE_DURATIONS_MS["7d"] }),
  Object.freeze({ key: "30d", label: "30 DAYS", durationMs: BWC_RANGE_DURATIONS_MS["30d"] }),
  Object.freeze({ key: "90d", label: "90 DAYS", durationMs: BWC_RANGE_DURATIONS_MS["90d"] }),
  Object.freeze({ key: "365d", label: "1 YEAR", durationMs: BWC_RANGE_DURATIONS_MS["365d"] }),
]);

export const BWC_MIN_VISIBLE_DURATION_MS = 30 * MINUTE_MS;

export const BWC_UTC_TICK_INTERVALS_MS = Object.freeze([
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS,
  10 * DAY_MS,
  14 * DAY_MS,
  30 * DAY_MS,
  60 * DAY_MS,
  90 * DAY_MS,
  120 * DAY_MS,
  180 * DAY_MS,
  365 * DAY_MS,
]);

const RANGE_ALIASES = Object.freeze({
  "24": "24h",
  "24h": "24h",
  "24hr": "24h",
  "7": "7d",
  "7d": "7d",
  "7days": "7d",
  "30": "30d",
  "30d": "30d",
  "30days": "30d",
  "90": "90d",
  "90d": "90d",
  "90days": "90d",
  "365": "365d",
  "365d": "365d",
  "1y": "365d",
  "1year": "365d",
});

const NON_CHANGE_START_REASONS = new Set([
  "ARCHIVE_START",
  "ARCHIVE_RECOVERY",
  "COVERAGE_RESUMED",
  "RETENTION_CARRY_IN",
  "STATE_AFTER_GAP",
]);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function canonicalIso(ms) {
  return new Date(ms).toISOString();
}

function resultError(code, message, path = "") {
  return { ok: false, error: { code, message, path } };
}

function finiteEpoch(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseAhasUtcTimestamp(value);
  return null;
}

/**
 * Parse a USAHAS DateTime or canonical archive timestamp as UTC.
 * Bare USAHAS values are intentionally UTC; non-zero offsets are rejected.
 */
export function parseAhasUtcTimestamp(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)?$/i.exec(text);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] || "").padEnd(3, "0").slice(0, 3) || 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
      || hour > 23 || minute > 59 || second > 59) return null;

  // setUTCFullYear avoids Date.UTC's special handling of years 00 through 99.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
      || date.getUTCHours() !== hour
      || date.getUTCMinutes() !== minute
      || date.getUTCSeconds() !== second
      || date.getUTCMilliseconds() !== millisecond) return null;
  return date.getTime();
}

/**
 * Return whole-minute age. Slight future skew is clamped; material future
 * values are invalid for age display but do not imply that the state is bad.
 */
export function calculateBwcAge(sourceTimestamp, nowValue = Date.now(), options = {}) {
  if (sourceTimestamp === null || sourceTimestamp === undefined || sourceTimestamp === "") {
    return { ok: false, minutes: null, reason: "MISSING_TIMESTAMP" };
  }
  const sourceMs = finiteEpoch(sourceTimestamp);
  if (sourceMs === null) return { ok: false, minutes: null, reason: "INVALID_TIMESTAMP" };
  const nowMs = finiteEpoch(nowValue);
  if (nowMs === null) return { ok: false, minutes: null, reason: "INVALID_NOW" };

  const toleranceMinutes = Number.isFinite(options.futureToleranceMinutes)
    ? Math.max(0, Number(options.futureToleranceMinutes))
    : 2;
  const deltaMs = nowMs - sourceMs;
  if (deltaMs < 0) {
    if (-deltaMs <= toleranceMinutes * MINUTE_MS) {
      return { ok: true, minutes: 0, sourceMs, nowMs, isFutureClamped: true, isFuture: true };
    }
    return {
      ok: false,
      minutes: null,
      sourceMs,
      nowMs,
      reason: "FUTURE_TIMESTAMP",
      futureByMs: -deltaMs,
    };
  }
  return {
    ok: true,
    minutes: Math.floor(deltaMs / MINUTE_MS),
    sourceMs,
    nowMs,
    isFutureClamped: false,
    isFuture: false,
  };
}

export function getBwcRange(rangeKey = "24h", nowValue = Date.now()) {
  const nowMs = finiteEpoch(nowValue);
  if (nowMs === null) return null;
  const compact = String(rangeKey || "24h").trim().toLowerCase().replace(/[\s_-]+/g, "");
  const key = RANGE_ALIASES[compact] || null;
  if (!key) return null;
  const durationMs = BWC_RANGE_DURATIONS_MS[key];
  const definition = BWC_RANGES.find((item) => item.key === key);
  return {
    key,
    label: definition.label,
    startMs: nowMs - durationMs,
    endMs: nowMs,
    durationMs,
  };
}

function timeRangeBounds(value, prefix = "") {
  if (!value || typeof value !== "object") return null;
  const capitalized = prefix ? `${prefix[0].toUpperCase()}${prefix.slice(1)}` : "";
  const nested = prefix && value[prefix] && typeof value[prefix] === "object" ? value[prefix] : null;
  const startRaw = nested?.startMs
    ?? nested?.startZ
    ?? value[`${prefix}StartMs`]
    ?? value[`${prefix}StartZ`]
    ?? value[`${capitalized}StartMs`]
    ?? value[`${capitalized}StartZ`]
    ?? (!prefix ? value.startMs ?? value.startZ : undefined);
  const endRaw = nested?.endMs
    ?? nested?.endZ
    ?? value[`${prefix}EndMs`]
    ?? value[`${prefix}EndZ`]
    ?? value[`${capitalized}EndMs`]
    ?? value[`${capitalized}EndZ`]
    ?? (!prefix ? value.endMs ?? value.endZ : undefined);
  const startMs = finiteEpoch(startRaw);
  const endMs = finiteEpoch(endRaw);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return { startMs, endMs, durationMs: endMs - startMs };
}

function normalizedTimeDomain(masterBounds, visibleBounds, minVisibleDurationMs) {
  const masterDurationMs = masterBounds.durationMs;
  const effectiveMinimumMs = Math.min(masterDurationMs, minVisibleDurationMs);
  const requestedDurationMs = visibleBounds.endMs - visibleBounds.startMs;
  const durationMs = Math.min(masterDurationMs, Math.max(effectiveMinimumMs, requestedDurationMs));
  const requestedCenterMs = visibleBounds.startMs + requestedDurationMs / 2;
  let startMs = requestedCenterMs - durationMs / 2;
  let endMs = startMs + durationMs;
  if (startMs < masterBounds.startMs) {
    startMs = masterBounds.startMs;
    endMs = startMs + durationMs;
  }
  if (endMs > masterBounds.endMs) {
    endMs = masterBounds.endMs;
    startMs = endMs - durationMs;
  }

  const epsilon = 0.001;
  const isFullRange = durationMs >= masterDurationMs - epsilon;
  const isAtMinimumDuration = durationMs <= effectiveMinimumMs + epsilon;
  return {
    ok: true,
    master: {
      startMs: masterBounds.startMs,
      endMs: masterBounds.endMs,
      durationMs: masterDurationMs,
    },
    visible: { startMs, endMs, durationMs },
    masterStartMs: masterBounds.startMs,
    masterEndMs: masterBounds.endMs,
    masterDurationMs,
    visibleStartMs: startMs,
    visibleEndMs: endMs,
    startMs,
    endMs,
    durationMs,
    minVisibleDurationMs: effectiveMinimumMs,
    isFullRange,
    isAtMinimumDuration,
    canZoomIn: !isAtMinimumDuration,
    canZoomOut: !isFullRange,
    canPanBackward: startMs > masterBounds.startMs + epsilon,
    canPanForward: endMs < masterBounds.endMs - epsilon,
  };
}

/**
 * Normalize a master UTC range and an optional visible subrange. The visible
 * domain is expanded to at least 30 minutes and translated inside the master
 * range without mutating either input object.
 */
export function createBwcTimeDomain(masterRange, visibleRange = null, options = {}) {
  if (masterRange?.ok === false) return masterRange;
  const masterBounds = timeRangeBounds(masterRange, "master") || timeRangeBounds(masterRange);
  if (!masterBounds) return resultError("INVALID_MASTER_DOMAIN", "Master time domain is invalid", "masterRange");
  const visibleBounds = visibleRange
    ? timeRangeBounds(visibleRange, "visible") || timeRangeBounds(visibleRange)
    : timeRangeBounds(masterRange, "visible") || timeRangeBounds(masterRange) || masterBounds;
  if (!visibleBounds) return resultError("INVALID_VISIBLE_DOMAIN", "Visible time domain is invalid", "visibleRange");
  const requestedMinimumMs = options.minVisibleDurationMs
    ?? masterRange.minVisibleDurationMs
    ?? BWC_MIN_VISIBLE_DURATION_MS;
  const minVisibleDurationMs = Number(requestedMinimumMs);
  if (!Number.isFinite(minVisibleDurationMs) || minVisibleDurationMs <= 0) {
    return resultError("INVALID_MINIMUM_DURATION", "Minimum visible duration must be positive", "minVisibleDurationMs");
  }
  return normalizedTimeDomain(masterBounds, visibleBounds, minVisibleDurationMs);
}

function coerceBwcTimeDomain(domain) {
  if (domain?.ok === false) return domain;
  const masterBounds = timeRangeBounds(domain, "master") || timeRangeBounds(domain);
  const visibleBounds = timeRangeBounds(domain, "visible") || timeRangeBounds(domain);
  if (!masterBounds || !visibleBounds) {
    return resultError("INVALID_TIME_DOMAIN", "A normalized BWC time domain is required");
  }
  return createBwcTimeDomain(masterBounds, visibleBounds, {
    minVisibleDurationMs: domain.minVisibleDurationMs ?? BWC_MIN_VISIBLE_DURATION_MS,
  });
}

function zoomAnchor(domain, anchor) {
  if (anchor === undefined || anchor === null) {
    return { ratio: 0.5, timeMs: domain.startMs + domain.durationMs / 2 };
  }
  if (typeof anchor === "object" && !(anchor instanceof Date)) {
    const ratioValue = Number(anchor.ratio);
    if (Number.isFinite(ratioValue)) {
      const ratio = Math.max(0, Math.min(1, ratioValue));
      return { ratio, timeMs: domain.startMs + domain.durationMs * ratio };
    }
    anchor = anchor.timeMs ?? anchor.timeZ ?? anchor.timestampMs ?? anchor.timestampZ;
  }
  if (typeof anchor === "number" && Number.isFinite(anchor) && anchor >= 0 && anchor <= 1) {
    return { ratio: anchor, timeMs: domain.startMs + domain.durationMs * anchor };
  }
  const anchorMs = finiteEpoch(anchor);
  if (anchorMs === null) return null;
  const clampedTimeMs = Math.max(domain.startMs, Math.min(domain.endMs, anchorMs));
  return {
    ratio: domain.durationMs > 0 ? (clampedTimeMs - domain.startMs) / domain.durationMs : 0.5,
    timeMs: clampedTimeMs,
  };
}

/**
 * Zoom a visible domain. factor > 1 zooms in; factor < 1 zooms out. A ratio,
 * epoch timestamp, or {ratio|timeMs} anchor keeps the cursor position stable
 * until a master-domain boundary or zoom limit is reached.
 */
export function zoomBwcTimeDomain(domainValue, factor, anchor = 0.5) {
  const domain = coerceBwcTimeDomain(domainValue);
  if (!domain.ok) return domain;
  const zoomFactor = Number(factor);
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return resultError("INVALID_ZOOM_FACTOR", "Zoom factor must be greater than zero", "factor");
  }
  const resolvedAnchor = zoomAnchor(domain, anchor);
  if (!resolvedAnchor) return resultError("INVALID_ZOOM_ANCHOR", "Zoom anchor is invalid", "anchor");
  const targetDurationMs = Math.min(
    domain.masterDurationMs,
    Math.max(domain.minVisibleDurationMs, domain.durationMs / zoomFactor),
  );
  const requestedStartMs = resolvedAnchor.timeMs - resolvedAnchor.ratio * targetDurationMs;
  return normalizedTimeDomain(
    domain.master,
    { startMs: requestedStartMs, endMs: requestedStartMs + targetDurationMs, durationMs: targetDurationMs },
    domain.minVisibleDurationMs,
  );
}

/** Positive delta moves the visible window toward later UTC time. */
export function panBwcTimeDomain(domainValue, deltaMs) {
  const domain = coerceBwcTimeDomain(domainValue);
  if (!domain.ok) return domain;
  const delta = Number(deltaMs);
  if (!Number.isFinite(delta)) return resultError("INVALID_PAN_DELTA", "Pan delta must be finite", "deltaMs");
  return normalizedTimeDomain(
    domain.master,
    {
      startMs: domain.startMs + delta,
      endMs: domain.endMs + delta,
      durationMs: domain.durationMs,
    },
    domain.minVisibleDurationMs,
  );
}

/** Restore the complete master range. */
export function resetBwcTimeDomain(domainValue) {
  const domain = coerceBwcTimeDomain(domainValue);
  if (!domain.ok) return domain;
  return normalizedTimeDomain(domain.master, domain.master, domain.minVisibleDurationMs);
}

/** Format one adaptive chart tick in UTC without local-time/DST influence. */
export function formatBwcUtcTickLabel(value, visibleDurationMs) {
  const ms = finiteEpoch(value);
  const durationMs = Number(visibleDurationMs);
  if (ms === null || !Number.isFinite(durationMs) || durationMs <= 0) return "";
  const date = new Date(ms);
  const day = pad2(date.getUTCDate());
  const month = MONTHS[date.getUTCMonth()];
  const hourMinute = `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}Z`;
  if (durationMs <= 6 * HOUR_MS) return hourMinute;
  if (durationMs <= 48 * HOUR_MS) return `${day} ${month} ${hourMinute}`;
  if (durationMs <= 90 * DAY_MS) return `${day} ${month}`;
  return `${month} ${date.getUTCFullYear()}`;
}

/**
 * Select epoch-aligned UTC ticks for the visible domain. The nearest standard
 * interval to the requested density is used, keeping labels deterministic.
 */
export function selectBwcUtcTicks(domainOrRange, options = {}) {
  const visibleBounds = timeRangeBounds(domainOrRange, "visible") || timeRangeBounds(domainOrRange);
  if (!visibleBounds) return resultError("INVALID_TICK_DOMAIN", "Tick time domain is invalid");
  const width = Number(options.width);
  const minSpacingPx = Number(options.minSpacingPx);
  let targetCount = Number(options.targetCount);
  let spacingConstrained = false;
  if ((!Number.isFinite(targetCount) || targetCount < 2)
      && Number.isFinite(width) && width > 0 && Number.isFinite(minSpacingPx) && minSpacingPx > 0) {
    targetCount = Math.floor(width / minSpacingPx) + 1;
    spacingConstrained = true;
  }
  if (!Number.isFinite(targetCount) || targetCount < 2) targetCount = 5;
  targetCount = Math.max(2, Math.min(20, Math.floor(targetCount)));

  const desiredIntervalMs = visibleBounds.durationMs / Math.max(1, targetCount - 1);
  const largestTickIntervalMs = BWC_UTC_TICK_INTERVALS_MS[BWC_UTC_TICK_INTERVALS_MS.length - 1];
  let intervalMs = largestTickIntervalMs;
  if (spacingConstrained) {
    intervalMs = BWC_UTC_TICK_INTERVALS_MS.find((candidate) => candidate >= desiredIntervalMs)
      ?? largestTickIntervalMs;
  } else {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of BWC_UTC_TICK_INTERVALS_MS) {
      const distance = Math.abs(Math.log(candidate / desiredIntervalMs));
      if (distance < bestDistance || (distance === bestDistance && candidate > intervalMs)) {
        intervalMs = candidate;
        bestDistance = distance;
      }
    }
  }

  const ticks = [];
  const firstTickMs = Math.ceil(visibleBounds.startMs / intervalMs) * intervalMs;
  for (let timeMs = firstTickMs; timeMs <= visibleBounds.endMs && ticks.length < 1000; timeMs += intervalMs) {
    ticks.push({
      timeMs,
      timeZ: canonicalIso(timeMs),
      label: formatBwcUtcTickLabel(timeMs, visibleBounds.durationMs),
    });
  }
  return {
    ok: true,
    startMs: visibleBounds.startMs,
    endMs: visibleBounds.endMs,
    durationMs: visibleBounds.durationMs,
    targetCount,
    intervalMs,
    ticks,
  };
}

function normalizeBasisClass(value, basis) {
  const explicit = String(value || "").trim().toUpperCase();
  if (explicit) return explicit;
  const normalizedBasis = String(basis || "").trim().toUpperCase();
  if (normalizedBasis === "NEXRAD") return "OBSERVED_OPERATIONAL";
  if (normalizedBasis === "SOAR" || normalizedBasis === "NEXBAM" || normalizedBasis === "BAM") {
    return "MODEL_OPERATIONAL";
  }
  return "UNKNOWN_OPERATIONAL";
}

function normalizeStateRun(run, index, continuityMinutes) {
  const path = `runs[${index}]`;
  const state = String(run.state || "").trim().toUpperCase();
  if (!BWC_STATES.includes(state)) {
    return resultError("INVALID_STATE", `${path}.state must be LOW, MODERATE, or SEVERE`, `${path}.state`);
  }

  const startRaw = run.startZ ?? run.effectiveStartZ ?? run.firstObservedZ;
  const firstRaw = run.firstObservedZ ?? startRaw;
  const lastRaw = run.lastObservedZ ?? firstRaw;
  const startMs = parseAhasUtcTimestamp(startRaw);
  const firstObservedMs = parseAhasUtcTimestamp(firstRaw);
  const lastObservedMs = parseAhasUtcTimestamp(lastRaw);
  if (startMs === null) return resultError("INVALID_TIMESTAMP", `${path}.startZ is invalid`, `${path}.startZ`);
  if (firstObservedMs === null) {
    return resultError("INVALID_TIMESTAMP", `${path}.firstObservedZ is invalid`, `${path}.firstObservedZ`);
  }
  if (lastObservedMs === null) {
    return resultError("INVALID_TIMESTAMP", `${path}.lastObservedZ is invalid`, `${path}.lastObservedZ`);
  }
  if (lastObservedMs < firstObservedMs) {
    return resultError("INVALID_INTERVAL", `${path} observation timestamps are reversed`, path);
  }
  const startReason = String(run.startReason || "STATE_CHANGE").trim().toUpperCase();
  if (startMs > lastObservedMs) {
    const continuityEndMs = lastObservedMs + continuityMinutes * MINUTE_MS;
    if (startReason !== "RETENTION_CARRY_IN" || startMs > continuityEndMs) {
      return resultError("INVALID_INTERVAL", `${path}.startZ exceeds usable observation coverage`, path);
    }
  }

  const confirmationCount = run.confirmationCount === undefined ? 1 : Number(run.confirmationCount);
  if (!Number.isInteger(confirmationCount) || confirmationCount < 1) {
    return resultError("INVALID_CONFIRMATION_COUNT", `${path}.confirmationCount must be a positive integer`, `${path}.confirmationCount`);
  }

  const basis = String(run.basis || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
  const normalized = {
    kind: "STATE",
    state,
    rawAhasRisk: String(run.rawAhasRisk || state).trim().toUpperCase(),
    startZ: canonicalIso(startMs),
    firstObservedZ: canonicalIso(firstObservedMs),
    lastObservedZ: canonicalIso(lastObservedMs),
    startMs,
    firstObservedMs,
    lastObservedMs,
    confirmationCount,
    startReason,
    source: String(run.source || "USAHAS").trim().toUpperCase(),
    basis,
    basisClass: normalizeBasisClass(run.basisClass, basis),
    recordedVia: String(run.recordedVia || "LIVE_POLL").trim().toUpperCase(),
  };
  if (run.originalStartReason) {
    normalized.originalStartReason = String(run.originalStartReason).trim().toUpperCase();
  }

  for (const key of ["firstRecordedZ", "lastRecordedZ"]) {
    if (run[key] === undefined || run[key] === null || run[key] === "") continue;
    const ms = parseAhasUtcTimestamp(run[key]);
    if (ms === null) return resultError("INVALID_TIMESTAMP", `${path}.${key} is invalid`, `${path}.${key}`);
    normalized[key] = canonicalIso(ms);
    normalized[key.replace("Z", "Ms")] = ms;
  }
  return { ok: true, value: normalized };
}

function normalizeUnknownRun(run, index) {
  const path = `runs[${index}]`;
  const reason = String(run.reason || "").trim().toUpperCase();
  if (reason !== "COVERAGE_GAP" && reason !== "SOURCE_NO_DATA") {
    return resultError("INVALID_UNKNOWN_REASON", `${path}.reason is unsupported`, `${path}.reason`);
  }
  const startMs = parseAhasUtcTimestamp(run.startZ);
  const hasEnd = run.endZ !== undefined && run.endZ !== null && run.endZ !== "";
  const endMs = hasEnd ? parseAhasUtcTimestamp(run.endZ) : null;
  if (startMs === null) return resultError("INVALID_TIMESTAMP", `${path}.startZ is invalid`, `${path}.startZ`);
  if (hasEnd && endMs === null) return resultError("INVALID_TIMESTAMP", `${path}.endZ is invalid`, `${path}.endZ`);
  if (endMs !== null && endMs <= startMs) {
    return resultError("INVALID_INTERVAL", `${path}.endZ must follow startZ`, path);
  }
  const evidenceKeys = ["firstObservedZ", "lastObservedZ", "firstRecordedZ", "lastRecordedZ"];
  const confirmationCount = run.confirmationCount === undefined
    ? (reason === "COVERAGE_GAP" ? 0 : 1)
    : Number(run.confirmationCount);
  const normalized = {
    kind: "UNKNOWN",
    startZ: canonicalIso(startMs),
    endZ: endMs === null ? "" : canonicalIso(endMs),
    startMs,
    endMs,
    reason,
    source: String(run.source || "USAHAS").trim().toUpperCase(),
    confirmationCount,
    carryIn: Boolean(run.carryIn),
  };
  if (!Number.isInteger(confirmationCount) || confirmationCount < 0) {
    return resultError("INVALID_CONFIRMATION_COUNT", `${path}.confirmationCount must be a non-negative integer`, `${path}.confirmationCount`);
  }
  for (const key of evidenceKeys) {
    if (run[key] === undefined || run[key] === null || run[key] === "") {
      normalized[key] = "";
      normalized[key.replace("Z", "Ms")] = null;
      continue;
    }
    const ms = parseAhasUtcTimestamp(run[key]);
    if (ms === null) return resultError("INVALID_TIMESTAMP", `${path}.${key} is invalid`, `${path}.${key}`);
    normalized[key] = canonicalIso(ms);
    normalized[key.replace("Z", "Ms")] = ms;
  }
  const evidencePresent = evidenceKeys.map((key) => normalized[key] !== "");
  if (reason === "COVERAGE_GAP") {
    if (confirmationCount !== 0 || evidencePresent.some(Boolean)) {
      return resultError("INVALID_UNKNOWN_EVIDENCE", `${path} synthetic coverage gap must not claim observation evidence`, path);
    }
  } else if (confirmationCount < 1 || evidencePresent.some((present) => !present)) {
    return resultError("INVALID_UNKNOWN_EVIDENCE", `${path} source NO DATA requires complete observation evidence`, path);
  }
  if (normalized.firstObservedMs !== null && normalized.firstObservedMs > normalized.lastObservedMs) {
    return resultError("INVALID_INTERVAL", `${path} observation timestamps are reversed`, path);
  }
  if (normalized.firstRecordedMs !== null && normalized.firstRecordedMs > normalized.lastRecordedMs) {
    return resultError("INVALID_INTERVAL", `${path} recorded timestamps are reversed`, path);
  }
  return { ok: true, value: normalized };
}

/** Validate and normalize schema-v1 history without mutating its input. */
export function normalizeBwcHistory(payload) {
  if (payload && payload.ok === true && payload.value) payload = payload.value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return resultError("INVALID_PAYLOAD", "BWC history must be an object");
  }
  if (payload.schemaVersion !== BWC_HISTORY_SCHEMA_VERSION) {
    return resultError(
      "UNSUPPORTED_SCHEMA",
      `Expected schemaVersion ${BWC_HISTORY_SCHEMA_VERSION}`,
      "schemaVersion",
    );
  }
  const station = String(payload.station || "").trim().toUpperCase();
  if (station !== "KMEM") {
    return resultError("INVALID_STATION", "station must be KMEM", "station");
  }
  const product = String(payload.product || "").trim().toUpperCase();
  if (product !== "USAHAS_AHAS_RISK") {
    return resultError("INVALID_PRODUCT", "product must be USAHAS_AHAS_RISK", "product");
  }
  const sourceArea = payload.sourceArea;
  if (!sourceArea || typeof sourceArea !== "object" || Array.isArray(sourceArea)
      || String(sourceArea.type || "").trim().toUpperCase() !== "ICAO"
      || String(sourceArea.name || "").trim().toUpperCase() !== "MEMPHIS INTL") {
    return resultError("INVALID_SOURCE_AREA", "sourceArea must identify MEMPHIS INTL by ICAO", "sourceArea");
  }
  if (payload.sourceTimestampField !== "DateTime") {
    return resultError("INVALID_TIMESTAMP_FIELD", "sourceTimestampField must be DateTime", "sourceTimestampField");
  }

  const retentionDays = Number(payload.retentionDays);
  if (retentionDays !== 365) {
    return resultError("INVALID_RETENTION", "retentionDays must be 365", "retentionDays");
  }
  const continuityMinutes = payload.continuityMinutes === undefined
    ? DEFAULT_CONTINUITY_MINUTES
    : Number(payload.continuityMinutes);
  if (continuityMinutes !== DEFAULT_CONTINUITY_MINUTES) {
    return resultError("INVALID_CONTINUITY", "continuityMinutes must be 90", "continuityMinutes");
  }
  if (!Array.isArray(payload.runs)) return resultError("INVALID_RUNS", "runs must be an array", "runs");

  const collectionRaw = payload.collectionStartedZ ?? payload.archiveStartedZ;
  const collectionStartedMs = collectionRaw === undefined || collectionRaw === null || collectionRaw === ""
    ? null
    : parseAhasUtcTimestamp(collectionRaw);
  if (collectionRaw && collectionStartedMs === null) {
    return resultError("INVALID_TIMESTAMP", "collectionStartedZ is invalid", "collectionStartedZ");
  }
  const archiveUpdatedRaw = payload.archiveUpdatedZ ?? null;
  const archiveUpdatedMs = archiveUpdatedRaw ? parseAhasUtcTimestamp(archiveUpdatedRaw) : null;
  if (archiveUpdatedRaw && archiveUpdatedMs === null) {
    return resultError("INVALID_TIMESTAMP", "archiveUpdatedZ is invalid", "archiveUpdatedZ");
  }

  const runs = [];
  for (let index = 0; index < payload.runs.length; index += 1) {
    const run = payload.runs[index];
    if (!run || typeof run !== "object" || Array.isArray(run)) {
      return resultError("INVALID_RUN", `runs[${index}] must be an object`, `runs[${index}]`);
    }
    const kind = String(run.kind || "").trim().toUpperCase();
    const normalized = kind === "STATE"
      ? normalizeStateRun(run, index, continuityMinutes)
      : kind === "UNKNOWN"
        ? normalizeUnknownRun(run, index)
        : resultError("INVALID_KIND", `runs[${index}].kind must be STATE or UNKNOWN`, `runs[${index}].kind`);
    if (!normalized.ok) return normalized;
    runs.push(normalized.value);
  }
  runs.sort((left, right) => left.startMs - right.startMs || (left.kind === "UNKNOWN" ? -1 : 1));
  for (let index = 1; index < runs.length; index += 1) {
    if (runs[index].startMs === runs[index - 1].startMs) {
      return resultError("AMBIGUOUS_RUNS", "Two runs begin at the same timestamp", `runs[${index}]`);
    }
    if (runs[index - 1].kind === "UNKNOWN"
        && runs[index - 1].endMs !== null
        && runs[index - 1].endMs > runs[index].startMs) {
      return resultError("OVERLAPPING_RUNS", "An UNKNOWN run overlaps the next run", `runs[${index - 1}]`);
    }
  }

  const derivedCollectionMs = collectionStartedMs ?? (runs.length ? runs[0].startMs : null);
  return {
    ok: true,
    value: {
      schemaVersion: BWC_HISTORY_SCHEMA_VERSION,
      station,
      product,
      sourceTimestampField: "DateTime",
      sourceArea: { type: "ICAO", name: "MEMPHIS INTL" },
      retentionDays,
      continuityMinutes,
      collectionStartedZ: derivedCollectionMs === null ? null : canonicalIso(derivedCollectionMs),
      collectionStartedMs: derivedCollectionMs,
      archiveUpdatedZ: archiveUpdatedMs === null ? null : canonicalIso(archiveUpdatedMs),
      archiveUpdatedMs,
      runs,
    },
  };
}

function resolveRange(range, nowValue) {
  if (range && typeof range === "object") {
    const startMs = finiteEpoch(range.startMs ?? range.startZ);
    const endMs = finiteEpoch(range.endMs ?? range.endZ);
    if (startMs === null || endMs === null || endMs <= startMs) return null;
    return {
      key: range.key || "custom",
      label: range.label || "CUSTOM",
      startMs,
      endMs,
      durationMs: endMs - startMs,
    };
  }
  return getBwcRange(range || "24h", nowValue);
}

function appendTimelineSegment(segments, segment) {
  if (!(segment.endMs > segment.startMs)) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.kind === "UNKNOWN" && segment.kind === "UNKNOWN"
      && Math.abs(previous.endMs - segment.startMs) < 1) {
    previous.endMs = segment.endMs;
    previous.endZ = canonicalIso(segment.endMs);
    if (previous.reason !== segment.reason) previous.reason = "UNKNOWN_COVERAGE";
    return;
  }
  segments.push(segment);
}

function unknownSegment(startMs, endMs, reason) {
  return {
    kind: "UNKNOWN",
    startMs,
    endMs,
    startZ: canonicalIso(startMs),
    endZ: canonicalIso(endMs),
    reason,
  };
}

/** Build a complete, non-overlapping selected-window timeline. */
export function buildBwcTimeline(historyPayload, range = "24h", nowValue = Date.now()) {
  const normalized = normalizeBwcHistory(historyPayload);
  if (!normalized.ok) return normalized;
  const selectedRange = resolveRange(range, nowValue);
  if (!selectedRange) return resultError("INVALID_RANGE", "The selected range is invalid", "range");

  const history = normalized.value;
  const entries = history.runs;
  const continuityMs = history.continuityMinutes * MINUTE_MS;
  const intervals = [];
  for (let index = 0; index < entries.length; index += 1) {
    const run = entries[index];
    const nextStartMs = entries[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    if (run.kind === "UNKNOWN") {
      const openEndMs = run.endMs === null ? selectedRange.endMs : run.endMs;
      intervals.push({ ...run, endMs: Math.min(openEndMs, nextStartMs) });
      continue;
    }
    const naturalEndMs = run.lastObservedMs + continuityMs;
    const explicitEndMs = run.endMs ?? Number.POSITIVE_INFINITY;
    intervals.push({ ...run, endMs: Math.min(naturalEndMs, explicitEndMs, nextStartMs) });
  }

  const segments = [];
  let cursor = selectedRange.startMs;
  for (const interval of intervals) {
    if (interval.endMs <= selectedRange.startMs || interval.startMs >= selectedRange.endMs) continue;
    const rawStart = Math.max(interval.startMs, selectedRange.startMs);
    const rawEnd = Math.min(interval.endMs, selectedRange.endMs);
    if (rawEnd <= cursor) continue;
    if (rawStart > cursor) {
      const beforeArchive = history.collectionStartedMs !== null && cursor < history.collectionStartedMs;
      appendTimelineSegment(
        segments,
        unknownSegment(cursor, rawStart, beforeArchive ? "BEFORE_ARCHIVE" : "COVERAGE_GAP"),
      );
    }
    const segmentStart = Math.max(rawStart, cursor);
    if (rawEnd <= segmentStart) continue;
    if (interval.kind === "UNKNOWN") {
      appendTimelineSegment(segments, unknownSegment(segmentStart, rawEnd, interval.reason));
    } else {
      appendTimelineSegment(segments, {
        ...interval,
        startMs: segmentStart,
        endMs: rawEnd,
        startZ: canonicalIso(segmentStart),
        endZ: canonicalIso(rawEnd),
        sourceRunStartMs: interval.startMs,
        sourceRunStartZ: canonicalIso(interval.startMs),
        clippedAtRangeStart: segmentStart > interval.startMs,
      });
    }
    cursor = rawEnd;
    if (cursor >= selectedRange.endMs) break;
  }
  if (cursor < selectedRange.endMs) {
    const beforeArchive = history.collectionStartedMs !== null && cursor < history.collectionStartedMs;
    appendTimelineSegment(
      segments,
      unknownSegment(
        cursor,
        selectedRange.endMs,
        beforeArchive ? "BEFORE_ARCHIVE" : (entries.length ? "NO_RECENT_OBSERVATION" : "ARCHIVE_EMPTY"),
      ),
    );
  }

  const knownCoverageMs = segments
    .filter((segment) => segment.kind === "STATE")
    .reduce((sum, segment) => sum + (segment.endMs - segment.startMs), 0);
  const unknownMs = selectedRange.durationMs - knownCoverageMs;
  return {
    ok: true,
    history,
    range: selectedRange,
    segments,
    knownCoverageMs,
    coverageMs: knownCoverageMs,
    unknownMs,
  };
}

function isConfirmedTransition(previous, current) {
  return previous?.kind === "STATE"
    && current?.kind === "STATE"
    && previous.endMs === current.startMs
    && previous.state !== current.state
    && !NON_CHANGE_START_REASONS.has(current.startReason);
}

export function findLastConfirmedChange(timeline) {
  const segments = timeline?.segments || [];
  let latest = null;
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!isConfirmedTransition(previous, current)) continue;
    latest = {
      atMs: current.startMs,
      atZ: canonicalIso(current.startMs),
      fromState: previous.state,
      toState: current.state,
      basis: current.basis,
      basisClass: current.basisClass,
    };
  }
  return latest;
}

export function countSevereEpisodes(timeline) {
  const segments = timeline?.segments || [];
  let count = 0;
  let inSevereEpisode = false;
  for (const segment of segments) {
    if (segment.kind !== "STATE") {
      inSevereEpisode = false;
      continue;
    }
    if (segment.state === "SEVERE") {
      if (!inSevereEpisode) count += 1;
      inSevereEpisode = true;
    } else {
      inSevereEpisode = false;
    }
  }
  return count;
}

export function calculateBwcStatistics(timeline) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline is required");
  }
  const durationsMs = { LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 0 };
  for (const segment of timeline.segments) {
    const duration = Math.max(0, segment.endMs - segment.startMs);
    if (segment.kind === "STATE" && BWC_STATES.includes(segment.state)) durationsMs[segment.state] += duration;
    else durationsMs.UNKNOWN += duration;
  }
  const windowMs = timeline.range.durationMs;
  const percentages = {};
  for (const key of [...BWC_STATES, "UNKNOWN"]) {
    percentages[key] = windowMs > 0 ? (durationsMs[key] / windowMs) * 100 : 0;
  }
  const knownCoverageMs = durationsMs.LOW + durationsMs.MODERATE + durationsMs.SEVERE;
  let changeCount = 0;
  for (let index = 1; index < timeline.segments.length; index += 1) {
    if (isConfirmedTransition(timeline.segments[index - 1], timeline.segments[index])) changeCount += 1;
  }
  return {
    ok: true,
    windowMs,
    durationsMs,
    percentages,
    knownCoverageMs,
    unknownMs: durationsMs.UNKNOWN,
    coveragePercent: windowMs > 0 ? (knownCoverageMs / windowMs) * 100 : 0,
    changeCount,
    severeEpisodes: countSevereEpisodes(timeline),
    lastConfirmedChange: findLastConfirmedChange(timeline),
  };
}

export function formatBwcZuluTime(value) {
  const ms = finiteEpoch(value);
  if (ms === null) return "";
  const date = new Date(ms);
  return `${pad2(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} `
    + `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}Z`;
}

export function formatBwcMemphisTime(value) {
  const ms = finiteEpoch(value);
  if (ms === null) return "";
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: MEMPHIS_TIME_ZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(new Date(ms)).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    return `${parts.day} ${String(parts.month).toUpperCase()} ${parts.year} `
      + `${parts.hour}${parts.minute}L ${parts.timeZoneName}`;
  } catch (_error) {
    return "";
  }
}

export function describeArchiveAvailability(historyPayload, nowValue = Date.now()) {
  const normalized = normalizeBwcHistory(historyPayload);
  if (!normalized.ok) return normalized;
  const nowMs = finiteEpoch(nowValue);
  if (nowMs === null) return resultError("INVALID_NOW", "now is invalid");
  const history = normalized.value;
  if (!history.runs.length || history.collectionStartedMs === null) {
    return {
      ok: true,
      status: "AWAITING_FIRST_OBSERVATION",
      label: "BWC ARCHIVE",
      detail: "Awaiting first valid live USAHAS result",
      availableStartMs: null,
      coveragePercent: 0,
    };
  }

  const retentionRange = getBwcRange("365d", nowMs);
  // The updater receipt time is provenance metadata.  Availability begins at
  // the oldest retained coverage boundary, which is sourced from USAHAS and
  // may precede receipt by a few minutes.
  const availableStartMs = history.runs[0].startMs;
  const fullWindow = availableStartMs <= retentionRange.startMs;
  const coverageRange = fullWindow
    ? retentionRange
    : {
        key: "available",
        label: "AVAILABLE",
        startMs: availableStartMs,
        endMs: nowMs,
        durationMs: Math.max(1, nowMs - availableStartMs),
      };
  const timeline = buildBwcTimeline(history, coverageRange, nowMs);
  if (!timeline.ok) return timeline;
  const stats = calculateBwcStatistics(timeline);
  const completeCoverage = fullWindow && stats.unknownMs === 0;
  const status = completeCoverage ? "FULL" : fullWindow ? "FULL_WITH_GAPS" : "PARTIAL";
  const collectedDays = Math.max(0, (nowMs - availableStartMs) / DAY_MS);
  const fullRangeText = `${formatBwcZuluTime(retentionRange.startMs)} – ${formatBwcZuluTime(nowMs)}`;
  return {
    ok: true,
    status,
    label: "BWC ARCHIVE",
    detail: completeCoverage
      ? `${fullRangeText} · 365 days available`
      : fullWindow
        ? `365-day window · ${stats.coveragePercent.toFixed(1)}% known coverage`
        : `Available since ${formatBwcZuluTime(availableStartMs)} · `
          + `${collectedDays.toFixed(1)} days collected · ${stats.coveragePercent.toFixed(1)}% known coverage`,
    availableStartMs,
    availableStartZ: canonicalIso(availableStartMs),
    collectedDays,
    fullWindow,
    coveragePercent: stats.coveragePercent,
    hasGaps: stats.unknownMs > 0,
  };
}

function finiteDimension(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function svgNumber(value) {
  return Number(value.toFixed(3)).toString();
}

/** Create H/V-only state paths, gap bands, and exact transition positions. */
export function buildStepPaths(timeline, options = {}) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline is required");
  }
  const width = finiteDimension(options.width, 800);
  const height = finiteDimension(options.height, 280);
  if (width <= 0 || height <= 0) return resultError("INVALID_DIMENSIONS", "Chart dimensions must be positive");
  const suppliedPadding = options.padding && typeof options.padding === "object" ? options.padding : {};
  const padding = {
    left: finiteDimension(suppliedPadding.left ?? options.paddingLeft, 48),
    right: finiteDimension(suppliedPadding.right ?? options.paddingRight, 12),
    top: finiteDimension(suppliedPadding.top ?? options.paddingTop, 12),
    bottom: finiteDimension(suppliedPadding.bottom ?? options.paddingBottom, 30),
  };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) {
    return resultError("INVALID_DIMENSIONS", "Chart padding leaves no drawing area");
  }

  const range = timeline.range;
  const xFor = (ms) => padding.left + ((ms - range.startMs) / range.durationMs) * innerWidth;
  const yByState = {
    SEVERE: padding.top,
    MODERATE: padding.top + innerHeight / 2,
    LOW: padding.top + innerHeight,
  };
  const paths = [];
  const transitions = [];
  const unknownBands = [];
  const segments = timeline.segments;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const x1 = xFor(segment.startMs);
    const x2 = xFor(segment.endMs);
    if (segment.kind === "UNKNOWN") {
      unknownBands.push({
        x: x1,
        width: Math.max(0, x2 - x1),
        startMs: segment.startMs,
        endMs: segment.endMs,
        reason: segment.reason,
      });
      continue;
    }
    const y = yByState[segment.state];
    const previous = segments[index - 1];
    const connected = previous?.kind === "STATE" && previous.endMs === segment.startMs;
    let d = `M ${svgNumber(x1)} ${svgNumber(y)}`;
    if (connected && previous.state !== segment.state) {
      const priorY = yByState[previous.state];
      d = `M ${svgNumber(x1)} ${svgNumber(priorY)} V ${svgNumber(y)}`;
      transitions.push({
        x: x1,
        startMs: segment.startMs,
        atMs: segment.startMs,
        atZ: canonicalIso(segment.startMs),
        fromState: previous.state,
        toState: segment.state,
        state: segment.state,
        basis: segment.basis,
        basisClass: segment.basisClass,
        startReason: segment.startReason,
      });
    }
    d += ` H ${svgNumber(x2)}`;
    paths.push({
      state: segment.state,
      d,
      startMs: segment.startMs,
      endMs: segment.endMs,
      basis: segment.basis,
      basisClass: segment.basisClass,
      startReason: segment.startReason,
      segment,
    });
  }
  return {
    ok: true,
    width,
    height,
    padding,
    plot: {
      x: padding.left,
      y: padding.top,
      left: padding.left,
      right: padding.left + innerWidth,
      top: padding.top,
      bottom: padding.top + innerHeight,
      width: innerWidth,
      height: innerHeight,
      yByState,
    },
    yByState,
    paths,
    transitions,
    unknownBands,
  };
}

// The UI uses ES-module imports. The guarded namespace also lets legacy inline
// board code consume the same age/parser implementation once this module loads.
if (typeof window !== "undefined") {
  window.BwcHistoryCore = Object.freeze({
    BWC_HISTORY_SCHEMA_VERSION,
    BWC_STATES,
    BWC_RANGE_DURATIONS_MS,
    BWC_RANGES,
    BWC_MIN_VISIBLE_DURATION_MS,
    BWC_UTC_TICK_INTERVALS_MS,
    parseAhasUtcTimestamp,
    calculateBwcAge,
    getBwcRange,
    createBwcTimeDomain,
    zoomBwcTimeDomain,
    panBwcTimeDomain,
    resetBwcTimeDomain,
    formatBwcUtcTickLabel,
    selectBwcUtcTicks,
    normalizeBwcHistory,
    buildBwcTimeline,
    calculateBwcStatistics,
    findLastConfirmedChange,
    countSevereEpisodes,
    describeArchiveAvailability,
    formatBwcZuluTime,
    formatBwcMemphisTime,
    buildStepPaths,
  });
}
