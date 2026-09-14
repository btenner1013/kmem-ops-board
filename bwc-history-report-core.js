import {
  BWC_STATES,
  BWC_SUMMARY_TIME_ZONE,
  buildBwcTimeline,
  calculateBwcStatistics,
  countSevereEpisodes,
  formatBwcDuration,
  formatBwcMemphisTime,
  formatBwcZuluTime,
  getBwcRange,
  selectBwcObservationMarkers,
  summarizeBwcHistory,
} from "./bwc-history-core.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const BWC_REPORT_DEFAULT_RANGE = "7d";
export const BWC_REPORT_RANGE_KEYS = Object.freeze(["24h", "7d", "30d", "90d", "365d", "custom"]);
export const BWC_REPORT_RANGE_LABELS = Object.freeze({
  "24h": "24 HR",
  "7d": "7 DAYS",
  "30d": "30 DAYS",
  "90d": "90 DAYS",
  "365d": "1 YEAR",
  custom: "CUSTOM DATES",
});

const MEMPHIS_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
  timeZone: BWC_SUMMARY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function finiteEpoch(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resultError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } };
}

function percent(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function localParts(value) {
  const ms = finiteEpoch(value);
  if (ms === null) return null;
  try {
    const parts = Object.fromEntries(MEMPHIS_PARTS_FORMATTER.formatToParts(new Date(ms))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]));
    return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].every(Number.isFinite)
      ? parts
      : null;
  } catch {
    return null;
  }
}

function dateKey(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (probe.getUTCFullYear() !== parts.year || probe.getUTCMonth() + 1 !== parts.month || probe.getUTCDate() !== parts.day) return null;
  return parts;
}

function shiftCalendarDate(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Resolve an America/Chicago midnight without assuming CST, CDT, or a 24-hour day. */
export function resolveBwcReportLocalMidnight(value) {
  const wanted = typeof value === "string" ? parseCalendarDate(value) : value;
  if (!wanted) return null;
  const wantedAsUtc = Date.UTC(wanted.year, wanted.month - 1, wanted.day);
  let candidate = wantedAsUtc;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const rendered = localParts(candidate);
    if (!rendered) return null;
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    const adjustment = wantedAsUtc - renderedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const verified = localParts(candidate);
  if (!verified || verified.year !== wanted.year || verified.month !== wanted.month || verified.day !== wanted.day
      || verified.hour !== 0 || verified.minute !== 0 || verified.second !== 0) return null;
  return candidate;
}

/** Resolve a frozen report range. Presets are rolling; custom dates are inclusive local calendar dates. */
export function resolveBwcReportRange(selection = {}, cutoffValue = Date.now()) {
  const cutoffMs = finiteEpoch(cutoffValue);
  if (cutoffMs === null) return resultError("INVALID_CUTOFF", "The report calculation cutoff is invalid.");
  const key = BWC_REPORT_RANGE_KEYS.includes(selection.key) ? selection.key : BWC_REPORT_DEFAULT_RANGE;
  if (key !== "custom") {
    const range = getBwcRange(key, cutoffMs);
    if (!range) return resultError("INVALID_RANGE", "The selected report range is invalid.");
    return {
      ok: true,
      key,
      label: BWC_REPORT_RANGE_LABELS[key],
      timeZone: BWC_SUMMARY_TIME_ZONE,
      requestedStartMs: range.startMs,
      requestedEndMs: range.endMs,
      startMs: range.startMs,
      endMs: range.endMs,
      durationMs: range.durationMs,
      cutoffMs,
      futureClipped: false,
    };
  }

  const startDate = parseCalendarDate(selection.startDate);
  const endDate = parseCalendarDate(selection.endDate);
  if (!startDate || !endDate) return resultError("INVALID_CUSTOM_DATES", "Choose valid start and end dates.");
  const requestedStartMs = resolveBwcReportLocalMidnight(startDate);
  const requestedEndMs = resolveBwcReportLocalMidnight(shiftCalendarDate(endDate, 1));
  if (requestedStartMs === null || requestedEndMs === null || requestedEndMs <= requestedStartMs) {
    return resultError("INVALID_CUSTOM_RANGE", "The custom end date must be on or after the start date.");
  }
  const endMs = Math.min(requestedEndMs, cutoffMs);
  if (endMs <= requestedStartMs) {
    return resultError("FUTURE_RANGE", "The selected custom dates contain no elapsed time at the report cutoff.");
  }
  return {
    ok: true,
    key,
    label: BWC_REPORT_RANGE_LABELS[key],
    timeZone: BWC_SUMMARY_TIME_ZONE,
    requestedStartMs,
    requestedEndMs,
    requestedStartDate: String(selection.startDate),
    requestedEndDate: String(selection.endDate),
    startMs: requestedStartMs,
    endMs,
    durationMs: endMs - requestedStartMs,
    cutoffMs,
    futureClipped: endMs < requestedEndMs,
  };
}

function riskDistribution(statistics) {
  const rows = [];
  for (const state of [...BWC_STATES, "UNKNOWN"]) {
    const durationMs = statistics.durationsMs[state] || 0;
    rows.push({
      state,
      durationMs,
      knownPercent: state === "UNKNOWN" ? null : percent(durationMs, statistics.knownCoverageMs),
      fullPeriodPercent: percent(durationMs, statistics.windowMs),
    });
  }
  return rows;
}

function collectSevereEpisodes(segments) {
  const episodes = [];
  let active = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isSevere = segment.kind === "STATE" && segment.state === "SEVERE";
    if (isSevere && active && active.endMs === segment.startMs) {
      active.endMs = segment.endMs;
      active.parts.push(segment);
      active.lastIndex = index;
      continue;
    }
    if (!isSevere) {
      active = null;
      continue;
    }
    active = { startMs: segment.startMs, endMs: segment.endMs, parts: [segment], firstIndex: index, lastIndex: index };
    episodes.push(active);
  }
  return episodes;
}

/** Episode extraction mirrors countSevereEpisodes and inspects boundary evidence outside the selected range. */
export function buildBwcReportSevereEpisodes(timeline, cutoffValue = timeline?.range?.endMs) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) return [];
  const cutoffMs = finiteEpoch(cutoffValue) ?? timeline.range.endMs;
  const firstRetainedMs = timeline.history?.runs?.length
    ? Math.min(...timeline.history.runs.map((run) => run.startMs).filter(Number.isFinite))
    : timeline.range.startMs;
  const contextStartMs = Math.min(timeline.range.startMs, Number.isFinite(firstRetainedMs) ? firstRetainedMs : timeline.range.startMs);
  const contextEndMs = timeline.range.endMs + 1;
  const contextual = buildBwcTimeline(timeline.history, {
    key: "report-episode-context",
    label: "REPORT EPISODE CONTEXT",
    startMs: contextStartMs,
    endMs: contextEndMs,
    durationMs: contextEndMs - contextStartMs,
  }, cutoffMs);
  const contextTimeline = contextual?.ok === false ? timeline : contextual?.value || contextual;
  const contextSegments = Array.isArray(contextTimeline?.segments) ? contextTimeline.segments : timeline.segments;
  return collectSevereEpisodes(contextSegments)
    .filter((episode) => episode.endMs > timeline.range.startMs && episode.startMs < timeline.range.endMs)
    .map((episode) => {
      const previous = contextSegments[episode.firstIndex - 1] || null;
      const next = contextSegments[episode.lastIndex + 1] || null;
      const startMs = Math.max(episode.startMs, timeline.range.startMs);
      const endMs = Math.min(episode.endMs, timeline.range.endMs);
      const ongoing = endMs === timeline.range.endMs
        && timeline.range.endMs >= cutoffMs
        && episode.endMs > cutoffMs;
      return {
        ...episode,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        parts: episode.parts
          .filter((part) => part.endMs > startMs && part.startMs < endMs)
          .map((part) => ({ ...part, startMs: Math.max(part.startMs, startMs), endMs: Math.min(part.endMs, endMs) })),
        rangeClippedStart: episode.startMs < timeline.range.startMs,
        rangeClippedEnd: episode.endMs > timeline.range.endMs && !ongoing,
        ongoing,
        gapBoundedStart: episode.startMs >= timeline.range.startMs && previous?.kind === "UNKNOWN",
        gapBoundedEnd: episode.endMs <= timeline.range.endMs && next?.kind === "UNKNOWN",
        startZ: new Date(startMs).toISOString(),
        endZ: new Date(endMs).toISOString(),
      };
    });
}

/** Split duration at real UTC hour boundaries, then assign each piece to its Memphis wall-clock hour. */
export function summarizeBwcReportHourly(timeline) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) {
    return resultError("INVALID_TIMELINE", "A built BWC timeline is required.");
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}00–${String((hour + 1) % 24).padStart(2, "0")}00L`,
    elapsedMs: 0,
    durationsMs: { LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 0 },
    contributingDateKeys: new Set(),
  }));
  for (const segment of timeline.segments) {
    let cursor = Math.max(segment.startMs, timeline.range.startMs);
    const end = Math.min(segment.endMs, timeline.range.endMs);
    while (cursor < end) {
      const nextUtcHour = (Math.floor(cursor / HOUR_MS) + 1) * HOUR_MS;
      const pieceEnd = Math.min(end, nextUtcHour);
      if (!(pieceEnd > cursor)) return resultError("TIME_SPLIT_ERROR", "Hourly report splitting did not advance.");
      const parts = localParts(cursor);
      if (!parts) return resultError("TIME_ZONE_ERROR", "Unable to resolve an America/Chicago clock hour.");
      const bucket = hours[parts.hour];
      const durationMs = pieceEnd - cursor;
      const state = segment.kind === "STATE" && BWC_STATES.includes(segment.state) ? segment.state : "UNKNOWN";
      bucket.elapsedMs += durationMs;
      bucket.durationsMs[state] += durationMs;
      if (state !== "UNKNOWN") bucket.contributingDateKeys.add(dateKey(parts));
      cursor = pieceEnd;
    }
  }
  for (const bucket of hours) {
    bucket.knownCoverageMs = BWC_STATES.reduce((sum, state) => sum + bucket.durationsMs[state], 0);
    bucket.unknownMs = bucket.durationsMs.UNKNOWN;
    bucket.coveragePercent = percent(bucket.knownCoverageMs, bucket.elapsedMs);
    bucket.severePercentOfKnown = percent(bucket.durationsMs.SEVERE, bucket.knownCoverageMs);
    bucket.contributingDates = bucket.contributingDateKeys.size;
    delete bucket.contributingDateKeys;
  }
  const totalMs = hours.reduce((sum, bucket) => sum + bucket.elapsedMs, 0);
  return { ok: true, timeZone: BWC_SUMMARY_TIME_ZONE, totalMs, hours };
}

export function summarizeBwcReportBasis(timeline) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) return [];
  const groups = new Map();
  for (const segment of timeline.segments) {
    if (segment.kind !== "STATE" || !BWC_STATES.includes(segment.state)) continue;
    const source = String(segment.source || "UNSPECIFIED").trim() || "UNSPECIFIED";
    const basis = String(segment.basis || "UNSPECIFIED").trim() || "UNSPECIFIED";
    const basisClass = String(segment.basisClass || "UNSPECIFIED").trim() || "UNSPECIFIED";
    const key = `${source}\u0000${basis}\u0000${basisClass}`;
    const current = groups.get(key) || { source, basis, basisClass, durationMs: 0 };
    current.durationMs += segment.endMs - segment.startMs;
    groups.set(key, current);
  }
  const knownMs = [...groups.values()].reduce((sum, item) => sum + item.durationMs, 0);
  return [...groups.values()]
    .map((item) => ({ ...item, knownSharePercent: percent(item.durationMs, knownMs) }))
    .sort((left, right) => right.durationMs - left.durationMs || left.basis.localeCompare(right.basis));
}

function latestObservation(timeline) {
  const selected = selectBwcObservationMarkers(timeline);
  if (!selected?.ok || !selected.markers.length) return null;
  return selected.markers
    .filter((marker) => marker.timeMs >= timeline.range.startMs && marker.timeMs < timeline.range.endMs)
    .reduce((latest, marker) => !latest || marker.timeMs > latest.timeMs ? marker : latest, null);
}

function calendarLabel(parts) {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${String(parts.day).padStart(2, "0")} ${months[parts.month - 1]} ${parts.year}`;
}

/** Report detail keeps every selected elapsed minute, including pre-archive UNKNOWN. */
export function summarizeBwcReportCalendar(timeline, episodes = buildBwcReportSevereEpisodes(timeline)) {
  if (!timeline?.range || !Array.isArray(timeline.segments)) return resultError("INVALID_TIMELINE", "A built BWC timeline is required.");
  const byDay = new Map();
  for (const segment of timeline.segments) {
    let cursor = Math.max(segment.startMs, timeline.range.startMs);
    const end = Math.min(segment.endMs, timeline.range.endMs);
    while (cursor < end) {
      const parts = localParts(cursor);
      if (!parts) return resultError("TIME_ZONE_ERROR", "Unable to resolve an America/Chicago calendar day.");
      const dayStartMs = resolveBwcReportLocalMidnight(parts);
      const nextDayMs = resolveBwcReportLocalMidnight(shiftCalendarDate(parts, 1));
      const pieceEnd = Math.min(end, nextDayMs);
      if (dayStartMs === null || nextDayMs === null || !(pieceEnd > cursor)) {
        return resultError("TIME_SPLIT_ERROR", "Daily report splitting did not advance.");
      }
      const key = dateKey(parts);
      let day = byDay.get(key);
      if (!day) {
        day = {
          type: "DAY",
          key,
          label: calendarLabel(parts),
          year: parts.year,
          month: parts.month,
          day: parts.day,
          calendarStartMs: dayStartMs,
          calendarEndMs: nextDayMs,
          calendarDurationMs: nextDayMs - dayStartMs,
          selectedStartMs: cursor,
          selectedEndMs: pieceEnd,
          elapsedMs: 0,
          durationsMs: { LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 0 },
        };
        byDay.set(key, day);
      }
      const durationMs = pieceEnd - cursor;
      const state = segment.kind === "STATE" && BWC_STATES.includes(segment.state) ? segment.state : "UNKNOWN";
      day.durationsMs[state] += durationMs;
      day.elapsedMs += durationMs;
      day.selectedStartMs = Math.min(day.selectedStartMs, cursor);
      day.selectedEndMs = Math.max(day.selectedEndMs, pieceEnd);
      cursor = pieceEnd;
    }
  }
  const daily = [...byDay.values()].sort((left, right) => left.calendarStartMs - right.calendarStartMs);
  for (const day of daily) {
    day.knownCoverageMs = BWC_STATES.reduce((sum, state) => sum + day.durationsMs[state], 0);
    day.unknownMs = day.durationsMs.UNKNOWN;
    day.coveragePercent = percent(day.knownCoverageMs, day.elapsedMs);
    day.severePercentOfKnown = percent(day.durationsMs.SEVERE, day.knownCoverageMs);
    day.severeEpisodes = episodes.filter((episode) => episode.endMs > day.selectedStartMs && episode.startMs < day.selectedEndMs).length;
    day.calendarWindowComplete = day.selectedStartMs === day.calendarStartMs && day.selectedEndMs === day.calendarEndMs;
    day.completeness = day.calendarWindowComplete && day.unknownMs === 0 ? "COMPLETE" : "PARTIAL";
  }

  const byMonth = new Map();
  for (const day of daily) {
    const key = `${day.year}-${String(day.month).padStart(2, "0")}`;
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    let month = byMonth.get(key);
    if (!month) {
      const calendarStartMs = resolveBwcReportLocalMidnight({ year: day.year, month: day.month, day: 1 });
      const followingMonth = day.month === 12
        ? { year: day.year + 1, month: 1, day: 1 }
        : { year: day.year, month: day.month + 1, day: 1 };
      const calendarEndMs = resolveBwcReportLocalMidnight(followingMonth);
      month = {
        type: "MONTH",
        key,
        label: `${months[day.month - 1]} ${day.year}`,
        elapsedMs: 0,
        calendarStartMs,
        calendarEndMs,
        calendarDurationMs: calendarEndMs - calendarStartMs,
        selectedCalendarDays: 0,
        knownDates: 0,
        durationsMs: { LOW: 0, MODERATE: 0, SEVERE: 0, UNKNOWN: 0 },
        selectedStartMs: day.selectedStartMs,
        selectedEndMs: day.selectedEndMs,
      };
      byMonth.set(key, month);
    }
    month.elapsedMs += day.elapsedMs;
    month.selectedCalendarDays += 1;
    if (day.knownCoverageMs > 0) month.knownDates += 1;
    month.selectedStartMs = Math.min(month.selectedStartMs, day.selectedStartMs);
    month.selectedEndMs = Math.max(month.selectedEndMs, day.selectedEndMs);
    for (const state of [...BWC_STATES, "UNKNOWN"]) month.durationsMs[state] += day.durationsMs[state];
  }
  const monthly = [...byMonth.values()].sort((left, right) => left.selectedStartMs - right.selectedStartMs);
  for (const month of monthly) {
    month.knownCoverageMs = BWC_STATES.reduce((sum, state) => sum + month.durationsMs[state], 0);
    month.unknownMs = month.durationsMs.UNKNOWN;
    month.coveragePercent = percent(month.knownCoverageMs, month.elapsedMs);
    month.severePercentOfKnown = percent(month.durationsMs.SEVERE, month.knownCoverageMs);
    month.severeEpisodes = episodes.filter((episode) => episode.endMs > month.selectedStartMs && episode.startMs < month.selectedEndMs).length;
    month.calendarWindowComplete = month.selectedStartMs === month.calendarStartMs && month.selectedEndMs === month.calendarEndMs;
    month.completeness = month.calendarWindowComplete && month.unknownMs === 0 ? "COMPLETE" : "PARTIAL";
  }
  return { ok: true, timeZone: BWC_SUMMARY_TIME_ZONE, daily, monthly };
}

function reportFindings(model) {
  const findings = [];
  if (model.coverage.coveragePercent < 99.95) {
    findings.push(`Known risk coverage was ${model.coverage.coveragePercent.toFixed(1)}% of the selected elapsed period; ${formatBwcDuration(model.coverage.unknownMs)} was unknown or uncollected.`);
  }
  if (!(model.coverage.knownMs > 0)) {
    findings.push("No represented LOW, MODERATE, or SEVERE duration is available in this selected period.");
    return findings.slice(0, 3);
  }
  const severe = model.riskDistribution.find((item) => item.state === "SEVERE");
  findings.push(`SEVERE represented ${formatBwcDuration(severe.durationMs)}, or ${severe.knownPercent.toFixed(1)}% of known covered time.`);
  findings.push(`SEVERE appeared on ${model.severe.daysWithSevere} of ${model.coverage.datesWithKnownCoverage} local dates contributing known coverage.`);
  if (model.severe.longest) {
    const qualifier = [
      model.severe.longest.rangeClippedStart || model.severe.longest.rangeClippedEnd ? "range-clipped" : "",
      model.severe.longest.ongoing ? "ongoing at cutoff" : "",
      model.severe.longest.gapBoundedStart || model.severe.longest.gapBoundedEnd ? "gap-bounded" : "",
    ].filter(Boolean).join(", ");
    findings.push(`Longest represented SEVERE interval: ${formatBwcDuration(model.severe.longest.durationMs)}${qualifier ? ` (${qualifier})` : ""}.`);
  }
  return findings.slice(0, 3);
}

function buildSnapshot(timeline, range, preparedAtMs, includeAppendix) {
  const statistics = calculateBwcStatistics(timeline);
  if (!statistics.ok) return statistics;
  const summaries = summarizeBwcHistory(timeline);
  if (!summaries.ok) return summaries;
  const hourly = summarizeBwcReportHourly(timeline);
  if (!hourly.ok) return hourly;
  const episodes = buildBwcReportSevereEpisodes(timeline, range.cutoffMs);
  const longest = episodes.reduce((winner, episode) => !winner || episode.durationMs > winner.durationMs ? episode : winner, null);
  const calendar = summarizeBwcReportCalendar(timeline, episodes);
  if (!calendar.ok) return calendar;
  const datesWithKnownCoverage = calendar.daily.filter((day) => day.knownCoverageMs > 0).length;
  const daysWithSevere = calendar.daily.filter((day) => day.durationsMs.SEVERE > 0).length;
  const basis = summarizeBwcReportBasis(timeline);
  const newestObservation = latestObservation(timeline);
  const detailMode = range.durationMs <= 7 * DAY_MS ? "daily" : "monthly";
  const model = {
    ok: true,
    station: timeline.history.station || "KMEM",
    product: timeline.history.product || "USAHAS_AHAS_RISK",
    range,
    preparedAtMs,
    preparedAtZ: new Date(preparedAtMs).toISOString(),
    archiveStartMs: timeline.history.runs?.length ? timeline.history.runs[0].startMs : null,
    archiveUpdatedMs: timeline.history.archiveUpdatedMs,
    latestObservation: newestObservation,
    continuityMinutes: timeline.history.continuityMinutes,
    coverage: {
      elapsedMs: statistics.windowMs,
      knownMs: statistics.knownCoverageMs,
      unknownMs: statistics.unknownMs,
      coveragePercent: statistics.coveragePercent,
      datesWithKnownCoverage,
      partial: statistics.unknownMs > 0 || (timeline.history.runs?.length && timeline.history.runs[0].startMs > range.startMs),
    },
    riskDistribution: riskDistribution(statistics),
    severe: {
      durationMs: statistics.durationsMs.SEVERE,
      episodeCount: episodes.length,
      verifiedEpisodeCount: countSevereEpisodes(timeline),
      daysWithSevere,
      episodes,
      longest,
    },
    changeCount: statistics.changeCount,
    hourly: hourly.hours,
    hourlyTotalMs: hourly.totalMs,
    basis,
    summaries,
    reportCalendar: calendar,
    detailMode,
    detailRows: detailMode === "daily" ? calendar.daily : calendar.monthly,
    appendixRows: includeAppendix ? calendar.daily : [],
    timelineSegments: range.durationMs <= DAY_MS ? timeline.segments.map((segment) => ({
      kind: segment.kind,
      state: segment.kind === "STATE" ? segment.state : "UNKNOWN",
      reason: segment.reason || "",
      startMs: segment.startMs,
      endMs: segment.endMs,
    })) : [],
  };
  model.findings = reportFindings(model);
  return model;
}

function comparisonFor(historyPayload, currentModel, preparedAtMs) {
  const durationMs = currentModel.range.durationMs;
  const range = {
    key: "comparison",
    label: "PRECEDING EQUAL-DURATION PERIOD",
    startMs: currentModel.range.startMs - durationMs,
    endMs: currentModel.range.startMs,
    durationMs,
    cutoffMs: currentModel.range.startMs,
    timeZone: BWC_SUMMARY_TIME_ZONE,
    futureClipped: false,
  };
  const built = buildBwcTimeline(historyPayload, range, preparedAtMs);
  const timeline = built?.ok === false ? null : built?.value || built;
  if (!timeline?.range) return { status: "UNAVAILABLE", reason: "PRECEDING PERIOD COULD NOT BE CALCULATED" };
  const previous = buildSnapshot(timeline, range, preparedAtMs, false);
  if (!previous.ok || !(previous.coverage.knownMs > 0)) {
    return { status: "UNAVAILABLE", reason: "NO KNOWN COVERAGE IN THE PRECEDING PERIOD", previous: previous.ok ? previous : null };
  }
  const currentSevere = currentModel.riskDistribution.find((row) => row.state === "SEVERE");
  const previousSevere = previous.riskDistribution.find((row) => row.state === "SEVERE");
  const limited = currentModel.coverage.coveragePercent < 99.95 || previous.coverage.coveragePercent < 99.95;
  return {
    status: limited ? "LIMITED_COVERAGE" : "AVAILABLE",
    current: currentModel,
    previous,
    severeKnownPercentagePointChange: currentSevere.knownPercent === null || previousSevere.knownPercent === null
      ? null
      : currentSevere.knownPercent - previousSevere.knownPercent,
    severeFullPeriodPercentagePointChange: currentSevere.fullPeriodPercent - previousSevere.fullPeriodPercent,
  };
}

/** Build a frozen, testable report model from the same timeline engine as the live BWC view. */
export function buildBwcReportModel(historyPayload, options = {}) {
  const preparedAtMs = finiteEpoch(options.preparedAt ?? options.cutoff ?? Date.now());
  if (preparedAtMs === null) return resultError("INVALID_PREPARATION_TIME", "The report preparation time is invalid.");
  const range = resolveBwcReportRange(options.selection || { key: BWC_REPORT_DEFAULT_RANGE }, options.cutoff ?? preparedAtMs);
  if (!range.ok) return range;
  const built = buildBwcTimeline(historyPayload, {
    key: range.key,
    label: range.label,
    startMs: range.startMs,
    endMs: range.endMs,
    durationMs: range.durationMs,
  }, range.cutoffMs);
  const timeline = built?.ok === false ? null : built?.value || built;
  if (!timeline?.range || !Array.isArray(timeline.segments)) {
    return resultError("REPORT_TIMELINE_UNAVAILABLE", "The selected BWC report timeline could not be calculated.");
  }
  const model = buildSnapshot(timeline, range, preparedAtMs, Boolean(options.includeAppendix));
  if (!model.ok) return model;
  model.includeComparison = Boolean(options.includeComparison);
  model.includeAppendix = Boolean(options.includeAppendix);
  model.comparison = model.includeComparison ? comparisonFor(historyPayload, model, preparedAtMs) : null;
  return model;
}

export function formatBwcReportBoundary(value) {
  const ms = finiteEpoch(value);
  if (ms === null) return { local: "UNAVAILABLE", zulu: "UNAVAILABLE" };
  return { local: formatBwcMemphisTime(ms), zulu: formatBwcZuluTime(ms) };
}
