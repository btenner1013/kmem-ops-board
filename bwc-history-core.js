export const BWC_HISTORY_SCHEMA_VERSION = 1;

export const BWC_STATES = Object.freeze(["LOW", "MODERATE", "SEVERE"]);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_CONTINUITY_MINUTES = 90;
const MEMPHIS_TIME_ZONE = "America/Chicago";
export const BWC_SUMMARY_TIME_ZONE = MEMPHIS_TIME_ZONE;
const NORMALIZED_BWC_HISTORIES = new WeakSet();
const BWC_OBSERVATION_INDEXES = new WeakMap();
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

export const BWC_CSV_COLUMNS = Object.freeze([
  "record_type",
  "state",
  "start_utc",
  "end_utc",
  "duration_minutes",
  "source",
  "basis",
  "basis_class",
  "start_reason",
  "observation_utc",
  "observation_local",
  "known_coverage",
  "notes",
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
  const numericMs = Number(ms);
  if (!Number.isFinite(numericMs)) return "";
  let wholeMs = Math.floor(numericMs);
  let remainingMicroseconds = Math.round((numericMs - wholeMs) * 1000);
  if (remainingMicroseconds >= 1000) {
    wholeMs += 1;
    remainingMicroseconds = 0;
  }
  const millisecondsIso = new Date(wholeMs).toISOString();
  if (remainingMicroseconds === 0) return millisecondsIso;
  return `${millisecondsIso.slice(0, -1)}${String(remainingMicroseconds).padStart(3, "0")}Z`;
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
  const microsecond = Number((match[7] || "").padEnd(6, "0") || 0);
  const millisecond = Math.floor(microsecond / 1000);
  const subMillisecond = (microsecond % 1000) / 1000;
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
  return date.getTime() + subMillisecond;
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

function normalizeObservationTimestamps(
  run,
  path,
  firstObservedMs,
  lastObservedMs,
  confirmationCount,
  startReason,
  startMs,
) {
  const supplied = run.observationsZ !== undefined;
  if (!supplied) {
    const observationTimesMs = firstObservedMs === lastObservedMs
      ? [firstObservedMs]
      : [firstObservedMs, lastObservedMs];
    return {
      ok: true,
      value: {
        observationTimesMs,
        observationsComplete: confirmationCount === observationTimesMs.length,
      },
    };
  }
  if (!Array.isArray(run.observationsZ)) {
    return resultError(
      "INVALID_OBSERVATIONS",
      `${path}.observationsZ must be an array when supplied`,
      `${path}.observationsZ`,
    );
  }
  if (run.observationsZ.length === 0) {
    if (startReason !== "RETENTION_CARRY_IN" || lastObservedMs >= startMs) {
      return resultError(
        "INVALID_OBSERVATIONS",
        `${path}.observationsZ may be empty only when all retention carry-in observations precede startZ`,
        `${path}.observationsZ`,
      );
    }
    return {
      ok: true,
      value: {
        observationsZ: [],
        observationTimesMs: [],
        observationsComplete: false,
      },
    };
  }

  const observationTimesMs = [];
  for (let index = 0; index < run.observationsZ.length; index += 1) {
    const timestampMs = parseAhasUtcTimestamp(run.observationsZ[index]);
    if (timestampMs === null) {
      return resultError(
        "INVALID_TIMESTAMP",
        `${path}.observationsZ[${index}] is invalid`,
        `${path}.observationsZ[${index}]`,
      );
    }
    if (index > 0 && timestampMs <= observationTimesMs[index - 1]) {
      return resultError(
        "INVALID_OBSERVATIONS",
        `${path}.observationsZ must be strictly chronological with no duplicates`,
        `${path}.observationsZ[${index}]`,
      );
    }
    observationTimesMs.push(timestampMs);
  }
  const retentionCarryIn = startReason === "RETENTION_CARRY_IN";
  const invalidCarryInEvidence = retentionCarryIn && (
    lastObservedMs < startMs
    || observationTimesMs.some((timestampMs) => timestampMs < startMs || timestampMs > lastObservedMs)
    || observationTimesMs[observationTimesMs.length - 1] !== lastObservedMs
  );
  const invalidNormalEvidence = !retentionCarryIn && (
    observationTimesMs[0] !== firstObservedMs
    || observationTimesMs[observationTimesMs.length - 1] !== lastObservedMs
  );
  if (invalidCarryInEvidence || invalidNormalEvidence) {
    return resultError(
      "INVALID_OBSERVATIONS",
      retentionCarryIn
        ? `${path}.observationsZ must contain retained observations from startZ through lastObservedZ`
        : `${path}.observationsZ endpoints must match firstObservedZ and lastObservedZ`,
      `${path}.observationsZ`,
    );
  }
  return {
    ok: true,
    value: {
      observationsZ: observationTimesMs.map(canonicalIso),
      observationTimesMs,
      observationsComplete: observationTimesMs.length === confirmationCount,
    },
  };
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

  const observations = normalizeObservationTimestamps(
    run,
    path,
    firstObservedMs,
    lastObservedMs,
    confirmationCount,
    startReason,
    startMs,
  );
  if (!observations.ok) return observations;

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
    ...observations.value,
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
  // Values produced here contain validated numeric timestamp ledgers. Brand
  // those exact objects in memory so repeated viewport renders do not parse a
  // full year of immutable source timestamps again. Raw caller objects are
  // never cached and therefore continue to be validated on every call.
  if (NORMALIZED_BWC_HISTORIES.has(payload)) return { ok: true, value: payload };
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
  const value = {
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
  };
  for (const run of runs) {
    if (Array.isArray(run.observationsZ)) Object.freeze(run.observationsZ);
    if (Array.isArray(run.observationTimesMs)) Object.freeze(run.observationTimesMs);
    Object.freeze(run);
  }
  Object.freeze(runs);
  Object.freeze(value.sourceArea);
  Object.freeze(value);
  NORMALIZED_BWC_HISTORIES.add(value);
  return { ok: true, value };
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

function observationMarkerIndex(history) {
  const cached = BWC_OBSERVATION_INDEXES.get(history);
  if (cached) return cached;

  const all = [];
  for (const run of history.runs) {
    if (run?.kind !== "STATE" || !BWC_STATES.includes(run.state)) continue;
    const hasObservationLedger = Array.isArray(run.observationsZ);
    const exactTimes = hasObservationLedger
      ? (Array.isArray(run.observationTimesMs) ? run.observationTimesMs : [])
      : [run.firstObservedMs, run.lastObservedMs].filter((value, index, values) => (
          Number.isFinite(value) && values.indexOf(value) === index
        ));
    for (let index = 0; index < exactTimes.length; index += 1) {
      const timeMs = Number(exactTimes[index]);
      if (!Number.isFinite(timeMs)) continue;
      let recordedMs = null;
      if (timeMs === run.firstObservedMs && Number.isFinite(run.firstRecordedMs)) {
        recordedMs = run.firstRecordedMs;
      } else if (timeMs === run.lastObservedMs && Number.isFinite(run.lastRecordedMs)) {
        recordedMs = run.lastRecordedMs;
      }
      all.push(Object.freeze({
        kind: "STATE",
        state: run.state,
        timeMs,
        timeZ: canonicalIso(timeMs),
        recordedMs,
        recordedZ: recordedMs === null ? "" : canonicalIso(recordedMs),
        source: run.source,
        basis: run.basis,
        basisClass: run.basisClass,
        recordedVia: run.recordedVia,
        startReason: run.startReason,
        confirmationCount: run.confirmationCount,
        observationIndex: index,
        observationsComplete: Boolean(run.observationsComplete),
      }));
    }
  }
  all.sort((left, right) => left.timeMs - right.timeMs);
  Object.freeze(all);
  const index = Object.freeze({ all });
  BWC_OBSERVATION_INDEXES.set(history, index);
  return index;
}

function lowerObservationBound(markers, targetMs, afterEqual = false) {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (markers[middle].timeMs < targetMs
        || (afterEqual && markers[middle].timeMs === targetMs)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Select exact, retained STATE observation evidence for the visible UTC range. */
export function selectBwcObservationMarkers(timeline) {
  if (!timeline?.range || !Array.isArray(timeline?.history?.runs)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline with normalized history is required");
  }
  const startMs = finiteEpoch(timeline.range.startMs ?? timeline.range.startZ);
  const endMs = finiteEpoch(timeline.range.endMs ?? timeline.range.endZ);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return resultError("INVALID_RANGE", "The BWC marker range is invalid", "range");
  }

  const all = observationMarkerIndex(timeline.history).all;
  const first = lowerObservationBound(all, startMs);
  const afterLast = lowerObservationBound(all, endMs, true);
  const markers = all.slice(first, afterLast);
  return { ok: true, markers };
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

const MEMPHIS_CALENDAR_FORMATTER = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
  timeZone: MEMPHIS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function memphisCalendarParts(value) {
  const ms = finiteEpoch(value);
  if (ms === null) return null;
  try {
    const parts = Object.fromEntries(MEMPHIS_CALENDAR_FORMATTER.formatToParts(new Date(ms))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]));
    if (![parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second]
      .every(Number.isFinite)) return null;
    return parts;
  } catch (_error) {
    return null;
  }
}

function calendarDateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function localDateKeyForValue(value) {
  const parts = memphisCalendarParts(value);
  return parts ? calendarDateKey(parts) : "";
}

function shiftedCalendarDate(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Resolve an America/Chicago local midnight to its exact UTC epoch. */
function memphisMidnightMs(parts) {
  const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let candidateMs = desiredAsUtc;
  // Offsets can change with DST. Iterating the formatted wall-clock delta is
  // deterministic and avoids assuming either CST, CDT, or a 24-hour day.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const rendered = memphisCalendarParts(candidateMs);
    if (!rendered) return null;
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    const adjustmentMs = desiredAsUtc - renderedAsUtc;
    candidateMs += adjustmentMs;
    if (adjustmentMs === 0) break;
  }
  const verified = memphisCalendarParts(candidateMs);
  if (!verified
      || verified.year !== parts.year
      || verified.month !== parts.month
      || verified.day !== parts.day
      || verified.hour !== 0
      || verified.minute !== 0
      || verified.second !== 0) return null;
  return candidateMs;
}

function localDayBounds(value) {
  const parts = memphisCalendarParts(value);
  if (!parts) return null;
  const date = { year: parts.year, month: parts.month, day: parts.day };
  const nextDate = shiftedCalendarDate(date, 1);
  const startMs = memphisMidnightMs(date);
  const endMs = memphisMidnightMs(nextDate);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    key: calendarDateKey(date),
    year: date.year,
    month: date.month,
    day: date.day,
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

function validSummaryTimeline(timeline) {
  return Boolean(timeline?.range && Array.isArray(timeline.segments)
    && Array.isArray(timeline?.history?.runs));
}

/**
 * Split the already truthful selected timeline at America/Chicago calendar
 * midnights. DST spring days therefore contain 23 hours and fall days 25.
 */
export function splitBwcIntervalsByLocalDay(timeline) {
  if (!validSummaryTimeline(timeline)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline is required");
  }
  const daysByKey = new Map();
  for (let segmentIndex = 0; segmentIndex < timeline.segments.length; segmentIndex += 1) {
    const segment = timeline.segments[segmentIndex];
    // A rolling range can begin before collection existed. That leading span
    // describes availability, not retained archive representation. Once the
    // archive has begun, later UNKNOWN coverage remains represented and is
    // intentionally included in every denominator.
    if (segment.kind === "UNKNOWN" && segment.reason === "ARCHIVE_EMPTY") continue;
    let cursorMs = Math.max(segment.startMs, timeline.range.startMs);
    const segmentEndMs = Math.min(segment.endMs, timeline.range.endMs);
    if (segment.kind === "UNKNOWN" && segment.reason === "BEFORE_ARCHIVE") {
      const collectionStartedMs = finiteEpoch(timeline.history.collectionStartedMs);
      if (collectionStartedMs === null || collectionStartedMs >= segmentEndMs) continue;
      // A timeline segment can straddle the collection boundary when the first
      // retained run starts later. Only the genuinely pre-collection portion
      // is availability context; the post-collection portion is represented
      // UNKNOWN time and must remain in summary denominators.
      cursorMs = Math.max(cursorMs, collectionStartedMs);
    }
    while (cursorMs < segmentEndMs) {
      const bounds = localDayBounds(cursorMs);
      if (!bounds) return resultError("TIME_ZONE_ERROR", "Unable to resolve a Memphis calendar boundary");
      const pieceEndMs = Math.min(segmentEndMs, bounds.endMs);
      if (!(pieceEndMs > cursorMs)) {
        return resultError("TIME_ZONE_ERROR", "Memphis calendar splitting did not advance");
      }
      let day = daysByKey.get(bounds.key);
      if (!day) {
        day = {
          key: bounds.key,
          year: bounds.year,
          month: bounds.month,
          day: bounds.day,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          calendarDurationMs: bounds.durationMs,
          representedStartMs: cursorMs,
          representedEndMs: pieceEndMs,
          representedMs: 0,
          segments: [],
        };
        daysByKey.set(bounds.key, day);
      }
      day.representedStartMs = Math.min(day.representedStartMs, cursorMs);
      day.representedEndMs = Math.max(day.representedEndMs, pieceEndMs);
      day.representedMs += pieceEndMs - cursorMs;
      day.segments.push({
        ...segment,
        startMs: cursorMs,
        endMs: pieceEndMs,
        startZ: canonicalIso(cursorMs),
        endZ: canonicalIso(pieceEndMs),
        sourceSegmentIndex: segmentIndex,
      });
      cursorMs = pieceEndMs;
    }
  }
  const days = [...daysByKey.values()].sort((left, right) => left.startMs - right.startMs);
  return { ok: true, timeZone: MEMPHIS_TIME_ZONE, days };
}

/** Rank only known duration; an entirely unknown bucket has UNKNOWN peak. */
export function calculateBwcPeakState(durationsMs = {}) {
  if (Number(durationsMs.SEVERE) > 0) return "SEVERE";
  if (Number(durationsMs.MODERATE) > 0) return "MODERATE";
  if (Number(durationsMs.LOW) > 0) return "LOW";
  return "UNKNOWN";
}

/** Compact whole-minute display derived from interval duration, never counts. */
export function formatBwcDuration(durationMs) {
  const numericMs = Number(durationMs);
  if (!Number.isFinite(numericMs) || numericMs < 0) return "";
  if (numericMs > 0 && numericMs < MINUTE_MS) return "<1 MIN";
  const totalMinutes = Math.floor(numericMs / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} MIN`;
  return `${hours} HR${minutes ? ` ${minutes} MIN` : ""}`;
}

function summaryContext(timeline) {
  const split = splitBwcIntervalsByLocalDay(timeline);
  if (!split.ok) return split;
  const markerSelection = selectBwcObservationMarkers(timeline);
  if (!markerSelection.ok) return markerSelection;

  const observationCountsByDay = new Map();
  for (const observation of markerSelection.markers) {
    if (observation.timeMs < timeline.range.startMs || observation.timeMs >= timeline.range.endMs) continue;
    const key = localDateKeyForValue(observation.timeMs);
    if (key) observationCountsByDay.set(key, (observationCountsByDay.get(key) || 0) + 1);
  }

  // Derive changes from the normalized global run ledger, not the clipped
  // timeline. This keeps a real transition exactly on the selected-range or
  // local-day boundary assigned to the new half-open bucket.
  const changes = [];
  const runs = timeline.history.runs;
  const continuityMs = timeline.history.continuityMinutes * MINUTE_MS;
  for (let index = 1; index < runs.length; index += 1) {
    const previous = runs[index - 1];
    const current = runs[index];
    if (previous.kind !== "STATE" || current.kind !== "STATE"
        || previous.state === current.state
        || NON_CHANGE_START_REASONS.has(current.startReason)
        || previous.lastObservedMs + continuityMs < current.startMs) continue;
    if (current.startMs >= timeline.range.startMs && current.startMs < timeline.range.endMs) {
      changes.push(current.startMs);
    }
  }
  const changeCountsByDay = new Map();
  for (const timeMs of changes) {
    const key = localDateKeyForValue(timeMs);
    if (key) changeCountsByDay.set(key, (changeCountsByDay.get(key) || 0) + 1);
  }

  const severeEpisodes = [];
  let activeEpisode = null;
  for (const segment of timeline.segments) {
    const severe = segment.kind === "STATE" && segment.state === "SEVERE";
    if (severe && activeEpisode && activeEpisode.endMs === segment.startMs) {
      activeEpisode.endMs = segment.endMs;
    } else if (severe) {
      activeEpisode = { startMs: segment.startMs, endMs: segment.endMs };
      severeEpisodes.push(activeEpisode);
    } else {
      activeEpisode = null;
    }
  }
  return {
    ok: true,
    timeZone: MEMPHIS_TIME_ZONE,
    days: split.days,
    observations: markerSelection.markers,
    observationCountsByDay,
    changes,
    changeCountsByDay,
    severeEpisodes,
  };
}

function periodMetrics(period, context, representedDays) {
  const durationsMs = { LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 0 };
  for (const segment of period.segments) {
    const durationMs = Math.max(0, segment.endMs - segment.startMs);
    if (segment.kind === "STATE" && BWC_STATES.includes(segment.state)) {
      durationsMs[segment.state] += durationMs;
    } else {
      durationsMs.UNKNOWN += durationMs;
    }
  }
  const representedMs = Object.values(durationsMs).reduce((sum, durationMs) => sum + durationMs, 0);
  const percentages = {};
  for (const state of [...BWC_STATES, "UNKNOWN"]) {
    percentages[state] = representedMs > 0 ? (durationsMs[state] / representedMs) * 100 : 0;
  }
  const knownCoverageMs = durationsMs.LOW + durationsMs.MODERATE + durationsMs.SEVERE;
  const observationCount = [...period.dayKeys]
    .reduce((sum, key) => sum + (context.observationCountsByDay.get(key) || 0), 0);
  const changeCount = [...period.dayKeys]
    .reduce((sum, key) => sum + (context.changeCountsByDay.get(key) || 0), 0);
  const severeEpisodes = context.severeEpisodes.filter((episode) => (
    episode.endMs > period.representedStartMs
      && episode.startMs < period.representedEndMs
      && period.days.some((day) => episode.endMs > day.representedStartMs
        && episode.startMs < day.representedEndMs)
  )).length;
  const calendarWindowComplete = period.representedStartMs === period.startMs
    && period.representedEndMs === period.endMs;
  return {
    ...period.metadata,
    startMs: period.startMs,
    endMs: period.endMs,
    startZ: canonicalIso(period.startMs),
    endZ: canonicalIso(period.endMs),
    calendarDurationMs: period.endMs - period.startMs,
    representedStartMs: period.representedStartMs,
    representedEndMs: period.representedEndMs,
    representedStartZ: canonicalIso(period.representedStartMs),
    representedEndZ: canonicalIso(period.representedEndMs),
    representedMs,
    representedDays,
    calendarWindowComplete,
    isComplete: calendarWindowComplete && durationsMs.UNKNOWN === 0,
    isPartial: !calendarWindowComplete || durationsMs.UNKNOWN > 0,
    durationsMs,
    percentages,
    knownCoverageMs,
    unknownMs: durationsMs.UNKNOWN,
    coveragePercent: representedMs > 0 ? (knownCoverageMs / representedMs) * 100 : 0,
    peakState: calculateBwcPeakState(durationsMs),
    changeCount,
    severeEpisodes,
    observationCount,
  };
}

function dayPeriod(day) {
  return {
    metadata: {
      type: "DAY",
      key: day.key,
      label: `${pad2(day.day)} ${MONTHS[day.month - 1]} ${day.year}`,
      year: day.year,
      month: day.month,
      day: day.day,
      dayCount: 1,
    },
    startMs: day.startMs,
    endMs: day.endMs,
    representedStartMs: day.representedStartMs,
    representedEndMs: day.representedEndMs,
    segments: day.segments,
    days: [day],
    dayKeys: new Set([day.key]),
  };
}

function localMonthBounds(year, month) {
  const startMs = memphisMidnightMs({ year, month, day: 1 });
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const endMs = memphisMidnightMs({ ...next, day: 1 });
  return { startMs, endMs };
}

function seasonForDate(year, month) {
  if (month === 12 || month <= 2) {
    // Winter's numeric `year` is its Jan/Feb year for stable sorting/keying;
    // the visible label below includes both calendar years explicitly.
    const seasonYear = month === 12 ? year + 1 : year;
    return { name: "WINTER", year: seasonYear, startYear: seasonYear - 1, startMonth: 12, endYear: seasonYear, endMonth: 3 };
  }
  if (month <= 5) return { name: "SPRING", year, startYear: year, startMonth: 3, endYear: year, endMonth: 6 };
  if (month <= 8) return { name: "SUMMER", year, startYear: year, startMonth: 6, endYear: year, endMonth: 9 };
  return { name: "FALL", year, startYear: year, startMonth: 9, endYear: year, endMonth: 12 };
}

function groupedPeriods(days, groupKey, metadataForGroup, boundsForGroup) {
  const groups = new Map();
  for (const day of days) {
    const key = groupKey(day);
    let group = groups.get(key);
    if (!group) {
      const metadata = metadataForGroup(day, key);
      const bounds = boundsForGroup(metadata);
      group = {
        metadata,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        representedStartMs: day.representedStartMs,
        representedEndMs: day.representedEndMs,
        segments: [],
        days: [],
        dayKeys: new Set(),
      };
      groups.set(key, group);
    }
    group.representedStartMs = Math.min(group.representedStartMs, day.representedStartMs);
    group.representedEndMs = Math.max(group.representedEndMs, day.representedEndMs);
    group.segments.push(...day.segments);
    group.days.push(day);
    group.dayKeys.add(day.key);
  }
  return [...groups.values()].sort((left, right) => left.startMs - right.startMs);
}

function summarizeDailyFromContext(context) {
  return context.days.map((day) => periodMetrics(
    dayPeriod(day),
    context,
    day.representedMs / day.calendarDurationMs,
  ));
}

function summarizeMonthlyFromContext(context) {
  const periods = groupedPeriods(
    context.days,
    (day) => `${day.year}-${pad2(day.month)}`,
    (day, key) => ({
      type: "MONTH",
      key,
      label: `${MONTHS[day.month - 1]} ${day.year}`,
      year: day.year,
      month: day.month,
    }),
    (metadata) => localMonthBounds(metadata.year, metadata.month),
  );
  return periods.map((period) => {
    const representedDays = period.days.reduce(
      (sum, day) => sum + day.representedMs / day.calendarDurationMs,
      0,
    );
    const summary = periodMetrics(period, context, representedDays);
    summary.dayCount = period.days.length;
    summary.severeDays = period.days.filter((day) => day.segments.some((segment) => (
      segment.kind === "STATE" && segment.state === "SEVERE" && segment.endMs > segment.startMs
    ))).length;
    return summary;
  });
}

function summarizeSeasonalFromContext(context) {
  const periods = groupedPeriods(
    context.days,
    (day) => {
      const season = seasonForDate(day.year, day.month);
      return `${season.name}-${season.year}`;
    },
    (day, key) => {
      const season = seasonForDate(day.year, day.month);
      const label = season.name === "WINTER"
        ? `WINTER ${season.startYear}\u2013${String(season.year).slice(-2)}`
        : `${season.name} ${season.year}`;
      return {
        type: "SEASON",
        key,
        label,
        season: season.name,
        year: season.year,
        startYear: season.startYear,
        startMonth: season.startMonth,
        endYear: season.endYear,
        endMonth: season.endMonth,
      };
    },
    (metadata) => ({
      startMs: memphisMidnightMs({ year: metadata.startYear, month: metadata.startMonth, day: 1 }),
      endMs: memphisMidnightMs({ year: metadata.endYear, month: metadata.endMonth, day: 1 }),
    }),
  );
  return periods.map((period) => {
    const representedDays = period.days.reduce(
      (sum, day) => sum + day.representedMs / day.calendarDurationMs,
      0,
    );
    const summary = periodMetrics(period, context, representedDays);
    summary.dayCount = period.days.length;
    summary.severeDays = period.days.filter((day) => day.segments.some((segment) => (
      segment.kind === "STATE" && segment.state === "SEVERE" && segment.endMs > segment.startMs
    ))).length;
    summary.monthKeys = [...new Set(period.days.map((day) => `${day.year}-${pad2(day.month)}`))];
    return summary;
  });
}

export function summarizeBwcDaily(timeline) {
  const context = summaryContext(timeline);
  if (!context.ok) return context;
  return { ok: true, timeZone: MEMPHIS_TIME_ZONE, summaries: summarizeDailyFromContext(context) };
}

export function summarizeBwcMonthly(timeline) {
  const context = summaryContext(timeline);
  if (!context.ok) return context;
  return { ok: true, timeZone: MEMPHIS_TIME_ZONE, summaries: summarizeMonthlyFromContext(context) };
}

export function summarizeBwcSeasonal(timeline) {
  const context = summaryContext(timeline);
  if (!context.ok) return context;
  return { ok: true, timeZone: MEMPHIS_TIME_ZONE, summaries: summarizeSeasonalFromContext(context) };
}

/** Build every summary once so callers can cache per selected range/archive. */
export function summarizeBwcHistory(timeline) {
  const context = summaryContext(timeline);
  if (!context.ok) return context;
  return {
    ok: true,
    timeZone: MEMPHIS_TIME_ZONE,
    daily: summarizeDailyFromContext(context),
    monthly: summarizeMonthlyFromContext(context),
    seasonal: summarizeSeasonalFromContext(context),
  };
}

/** ISO local timestamp with numeric offset; fall-back repeated hours stay unambiguous. */
export function formatBwcMemphisIsoTime(value) {
  const ms = finiteEpoch(value);
  const parts = memphisCalendarParts(ms);
  if (ms === null || !parts) return "";
  const wholeSecondMs = Math.floor(ms / 1000) * 1000;
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offsetMinutes = Math.round((wallClockAsUtc - wholeSecondMs) / MINUTE_MS);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const fractionalSecond = /\.(\d+)Z$/.exec(canonicalIso(ms))?.[1] || "000";
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`
    + `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}.${fractionalSecond}`
    + `${sign}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
}

function csvDurationMinutes(durationMs) {
  const minutes = Math.max(0, Number(durationMs) / MINUTE_MS);
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** Build selected-window interval rows plus only retained exact observation rows. */
export function buildBwcCsvRows(timeline) {
  if (!validSummaryTimeline(timeline)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline is required");
  }
  const selected = selectBwcObservationMarkers(timeline);
  if (!selected.ok) return selected;
  const ordered = [];
  for (const segment of timeline.segments) {
    const known = segment.kind === "STATE" && BWC_STATES.includes(segment.state);
    ordered.push({
      sortMs: segment.startMs,
      order: known ? 0 : 1,
      row: {
        record_type: known ? "STATE" : "UNKNOWN",
        state: known ? segment.state : "UNKNOWN",
        start_utc: canonicalIso(segment.startMs),
        end_utc: canonicalIso(segment.endMs),
        duration_minutes: csvDurationMinutes(segment.endMs - segment.startMs),
        source: segment.source || "",
        basis: known ? segment.basis || "" : "",
        basis_class: known ? segment.basisClass || "" : "",
        start_reason: known ? segment.startReason || "" : "",
        observation_utc: "",
        observation_local: "",
        known_coverage: known ? "KNOWN" : "UNKNOWN",
        notes: known
          ? (segment.clippedAtRangeStart ? "CONTINUATION_FROM_BEFORE_SELECTED_RANGE" : "")
          : segment.reason || "UNKNOWN_COVERAGE",
      },
    });
  }
  for (const observation of selected.markers) {
    if (observation.timeMs < timeline.range.startMs || observation.timeMs >= timeline.range.endMs) continue;
    ordered.push({
      sortMs: observation.timeMs,
      order: 2,
      row: {
        record_type: "OBSERVATION",
        state: observation.state,
        start_utc: "",
        end_utc: "",
        duration_minutes: "",
        source: observation.source || "",
        basis: observation.basis || "",
        basis_class: observation.basisClass || "",
        start_reason: observation.startReason || "",
        observation_utc: canonicalIso(observation.timeMs),
        observation_local: formatBwcMemphisIsoTime(observation.timeMs),
        known_coverage: "KNOWN",
        notes: "EXACT_RETAINED_OBSERVATION",
      },
    });
  }
  ordered.sort((left, right) => left.sortMs - right.sortMs || left.order - right.order);
  return { ok: true, columns: BWC_CSV_COLUMNS, rows: ordered.map((entry) => entry.row) };
}

function protectedCsvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  let formulaProtected = false;
  if (/^\s*[=+\-@]/.test(text)) {
    text = `'${text}`;
    formulaProtected = true;
  }
  if (formulaProtected || /[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Serialize with CRLF for Excel, correct quoting, and formula protection. */
export function serializeBwcCsv(columns, rows) {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return "";
  return [
    columns.map(protectedCsvCell).join(","),
    ...rows.map((row) => columns.map((column) => protectedCsvCell(row?.[column])).join(",")),
  ].join("\r\n");
}

function csvRangeToken(timeline, requestedLabel) {
  const knownTokens = {
    "24h": "24HR",
    "7d": "7DAYS",
    "30d": "30DAYS",
    "90d": "90DAYS",
    "365d": "1YEAR",
  };
  const raw = requestedLabel || knownTokens[timeline?.range?.key] || timeline?.range?.label || "SELECTED";
  return String(raw).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 24) || "SELECTED";
}

export function buildBwcCsvExport(timeline, options = {}) {
  const built = buildBwcCsvRows(timeline);
  if (!built.ok) return built;
  const requestedDateMs = finiteEpoch(options.dateValue);
  const dateMs = requestedDateMs ?? finiteEpoch(timeline?.range?.endMs ?? timeline?.range?.endZ);
  if (dateMs === null) return resultError("INVALID_EXPORT_DATE", "The CSV export date is invalid");
  const filename = `KMEM_BWC_HISTORY_${new Date(dateMs).toISOString().slice(0, 10)}_`
    + `${csvRangeToken(timeline, options.rangeLabel)}.csv`;
  return {
    ok: true,
    filename,
    mimeType: "text/csv;charset=utf-8",
    columns: built.columns,
    rows: built.rows,
    content: `\uFEFF${serializeBwcCsv(built.columns, built.rows)}`,
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
        source: segment.source,
        basis: segment.basis,
        basisClass: segment.basisClass,
        startReason: segment.startReason,
        confirmed: isConfirmedTransition(previous, segment),
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
    selectBwcObservationMarkers,
    calculateBwcStatistics,
    findLastConfirmedChange,
    countSevereEpisodes,
    describeArchiveAvailability,
    formatBwcZuluTime,
    formatBwcMemphisTime,
    buildStepPaths,
  });
}
