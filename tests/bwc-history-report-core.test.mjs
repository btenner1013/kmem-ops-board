import test from "node:test";
import assert from "node:assert/strict";

import { buildBwcTimeline, calculateBwcStatistics } from "../bwc-history-core.js";
import {
  buildBwcReportModel,
  buildBwcReportSevereEpisodes,
  resolveBwcReportRange,
  summarizeBwcReportBasis,
  summarizeBwcReportCalendar,
  summarizeBwcReportHourly,
} from "../bwc-history-report-core.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function stateRun(state, startMs, endMs, overrides = {}) {
  const evidenceEnd = Math.max(startMs, endMs - 30 * 60 * 1000);
  return {
    kind: "STATE",
    state,
    rawAhasRisk: state,
    startZ: iso(startMs),
    firstObservedZ: iso(startMs),
    lastObservedZ: iso(evidenceEnd),
    firstRecordedZ: iso(startMs),
    lastRecordedZ: iso(evidenceEnd),
    confirmationCount: 2,
    startReason: "STATE_CHANGE",
    source: "USAHAS",
    basis: "NEXRAD",
    basisClass: "OBSERVED_OPERATIONAL",
    ...overrides,
  };
}

function gap(startMs, endMs) {
  return { kind: "UNKNOWN", startZ: iso(startMs), endZ: iso(endMs), reason: "COVERAGE_GAP", source: "USAHAS", confirmationCount: 0 };
}

function archive(runs, overrides = {}) {
  return {
    schemaVersion: 1,
    station: "KMEM",
    product: "USAHAS_AHAS_RISK",
    sourceArea: { type: "ICAO", name: "MEMPHIS INTL" },
    sourceTimestampField: "DateTime",
    retentionDays: 365,
    continuityMinutes: 90,
    collectionStartedZ: runs.length ? runs[0].startZ : null,
    archiveUpdatedZ: runs.length ? runs[runs.length - 1].lastRecordedZ || runs[runs.length - 1].endZ : null,
    runs,
    ...overrides,
  };
}

function sevenDayFixture({ includePrevious = false } = {}) {
  const start = Date.parse("2026-08-24T05:00:00Z");
  const at = (hours) => start + hours * HOUR;
  const runs = [
    stateRun("LOW", at(0), at(66), { startReason: "ARCHIVE_START" }),
    stateRun("SEVERE", at(66), at(68)),
    stateRun("SEVERE", at(68), at(70), { startReason: "BASIS_CHANGE", basis: "SOAR", basisClass: "MODEL_OPERATIONAL" }),
    gap(at(70), at(74)),
    stateRun("MODERATE", at(74), at(110), { startReason: "STATE_AFTER_GAP", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL" }),
    stateRun("SEVERE", at(110), at(113)),
    gap(at(113), at(118)),
    stateRun("MODERATE", at(118), at(156), { startReason: "STATE_AFTER_GAP", basis: "NEXBAM", basisClass: "MODEL_OPERATIONAL" }),
    stateRun("SEVERE", at(156), at(168)),
  ];
  if (includePrevious) {
    runs.unshift(stateRun("LOW", at(-168), at(0), { startReason: "ARCHIVE_START" }));
  }
  return { start, end: at(168), value: archive(runs, { collectionStartedZ: iso(includePrevious ? at(-168) : at(0)), archiveUpdatedZ: iso(at(168)) }) };
}

test("custom report dates are inclusive, America/Chicago-aware, and DST-exact", () => {
  const spring = resolveBwcReportRange({ key: "custom", startDate: "2026-03-08", endDate: "2026-03-08" }, "2026-03-10T00:00:00Z");
  assert.equal(spring.ok, true);
  assert.equal(spring.startMs, Date.parse("2026-03-08T06:00:00Z"));
  assert.equal(spring.endMs, Date.parse("2026-03-09T05:00:00Z"));
  assert.equal(spring.durationMs, 23 * HOUR);

  const fall = resolveBwcReportRange({ key: "custom", startDate: "2026-11-01", endDate: "2026-11-01" }, "2026-11-03T00:00:00Z");
  assert.equal(fall.durationMs, 25 * HOUR);
  assert.equal(fall.startMs, Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(fall.endMs, Date.parse("2026-11-02T06:00:00Z"));
});

test("custom future end is clipped to the frozen cutoff and disclosed", () => {
  const range = resolveBwcReportRange({ key: "custom", startDate: "2026-08-30", endDate: "2026-09-02" }, "2026-08-31T16:15:00Z");
  assert.equal(range.ok, true);
  assert.equal(range.endMs, Date.parse("2026-08-31T16:15:00Z"));
  assert.equal(range.futureClipped, true);
  assert.ok(range.requestedEndMs > range.endMs);
});

test("report distribution uses explicit known and full-period denominators", () => {
  const fixture = sevenDayFixture();
  const report = buildBwcReportModel(fixture.value, { selection: { key: "7d" }, cutoff: fixture.end, preparedAt: fixture.end });
  assert.equal(report.ok, true);
  assert.equal(report.coverage.elapsedMs, 168 * HOUR);
  assert.equal(report.coverage.knownMs, 159 * HOUR);
  assert.equal(report.coverage.unknownMs, 9 * HOUR);
  assert.ok(Math.abs(report.coverage.coveragePercent - 94.642857) < .00001);
  const values = Object.fromEntries(report.riskDistribution.map((row) => [row.state, row]));
  assert.equal(values.LOW.durationMs, 66 * HOUR);
  assert.equal(values.MODERATE.durationMs, 74 * HOUR);
  assert.equal(values.SEVERE.durationMs, 19 * HOUR);
  assert.equal(values.UNKNOWN.durationMs, 9 * HOUR);
  assert.ok(Math.abs(values.SEVERE.knownPercent - (19 / 159) * 100) < 1e-9);
  assert.ok(Math.abs(values.SEVERE.fullPeriodPercent - (19 / 168) * 100) < 1e-9);
  assert.equal(values.UNKNOWN.knownPercent, null);
  assert.equal(report.riskDistribution.reduce((sum, row) => sum + row.durationMs, 0), report.coverage.elapsedMs);
});

test("report calculations agree with the existing full-window statistics", () => {
  const fixture = sevenDayFixture();
  const timeline = buildBwcTimeline(fixture.value, { startMs: fixture.start, endMs: fixture.end }, fixture.end);
  const stats = calculateBwcStatistics(timeline);
  const report = buildBwcReportModel(fixture.value, { selection: { key: "7d" }, cutoff: fixture.end });
  assert.deepEqual(Object.fromEntries(report.riskDistribution.map((row) => [row.state, row.durationMs])), stats.durationsMs);
  assert.equal(report.severe.episodeCount, stats.severeEpisodes);
  assert.equal(report.changeCount, stats.changeCount);
});

test("confirmations and basis-only changes do not inflate severe episodes", () => {
  const fixture = sevenDayFixture();
  const report = buildBwcReportModel(fixture.value, { selection: { key: "7d" }, cutoff: fixture.end });
  assert.equal(report.severe.episodeCount, 3);
  assert.equal(report.severe.verifiedEpisodeCount, 3);
  assert.equal(report.severe.longest.durationMs, 12 * HOUR);
  assert.ok(report.severe.episodes.some((episode) => episode.parts.length === 2 && episode.durationMs === 4 * HOUR));
});

test("unknown gaps bound and split severe episodes", () => {
  const start = Date.parse("2026-08-30T05:00:00Z");
  const runs = [stateRun("SEVERE", start, start + 2 * HOUR, { startReason: "ARCHIVE_START" }), gap(start + 2 * HOUR, start + 3 * HOUR), stateRun("SEVERE", start + 3 * HOUR, start + 5 * HOUR, { startReason: "STATE_AFTER_GAP" })];
  const timeline = buildBwcTimeline(archive(runs), { startMs: start, endMs: start + 5 * HOUR }, start + 5 * HOUR);
  const episodes = buildBwcReportSevereEpisodes(timeline, start + 5 * HOUR);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].gapBoundedEnd, true);
  assert.equal(episodes[1].gapBoundedStart, true);
  assert.equal(episodes[1].ongoing, true);
});

test("range-clipped and ongoing severe intervals remain explicitly flagged", () => {
  const start = Date.parse("2026-08-30T05:00:00Z");
  const run = stateRun("SEVERE", start - HOUR, start + 5 * HOUR, { startReason: "ARCHIVE_START" });
  const timeline = buildBwcTimeline(archive([run]), { startMs: start, endMs: start + 4 * HOUR }, start + 4 * HOUR);
  const [episode] = buildBwcReportSevereEpisodes(timeline, start + 4 * HOUR);
  assert.equal(episode.rangeClippedStart, true);
  assert.equal(episode.ongoing, true);
});

test("episode flags inspect authoritative evidence on both sides of report boundaries", () => {
  const start = Date.parse("2026-08-30T05:00:00Z");
  const split = start + 2 * HOUR;
  const end = split + 2 * HOUR;
  const basisPayload = archive([
    stateRun("SEVERE", start, split, { startReason: "ARCHIVE_START" }),
    stateRun("SEVERE", split, end + HOUR, { startReason: "BASIS_CHANGE", basis: "SOAR", basisClass: "MODEL_OPERATIONAL" }),
  ]);
  const basisTimeline = buildBwcTimeline(basisPayload, { startMs: split, endMs: end }, end);
  const [continued] = buildBwcReportSevereEpisodes(basisTimeline, end);
  assert.equal(continued.rangeClippedStart, true);
  assert.equal(continued.ongoing, true);

  const transitionPayload = archive([
    stateRun("SEVERE", start, end, { startReason: "ARCHIVE_START" }),
    stateRun("LOW", end, end + HOUR),
  ]);
  const transitionTimeline = buildBwcTimeline(transitionPayload, { startMs: start, endMs: end }, end);
  const [endedAtCutoff] = buildBwcReportSevereEpisodes(transitionTimeline, end);
  assert.equal(endedAtCutoff.rangeClippedEnd, false);
  assert.equal(endedAtCutoff.ongoing, false);
  assert.equal(endedAtCutoff.gapBoundedEnd, false);

  const gapPayload = archive([
    stateRun("SEVERE", start, end, { startReason: "ARCHIVE_START" }),
    gap(end, end + HOUR),
  ]);
  const gapTimeline = buildBwcTimeline(gapPayload, { startMs: start, endMs: end }, end);
  const [gapEnded] = buildBwcReportSevereEpisodes(gapTimeline, end);
  assert.equal(gapEnded.rangeClippedEnd, false);
  assert.equal(gapEnded.ongoing, false);
  assert.equal(gapEnded.gapBoundedEnd, true);
});

test("whole-period episode total is not the sum of cross-midnight daily intersections", () => {
  const start = Date.parse("2026-08-31T04:30:00Z"); // 23:30 CDT
  const end = start + HOUR;
  const timeline = buildBwcTimeline(archive([stateRun("SEVERE", start, end, { startReason: "ARCHIVE_START" })]), { startMs: start, endMs: end }, end);
  const episodes = buildBwcReportSevereEpisodes(timeline, end);
  const calendar = summarizeBwcReportCalendar(timeline, episodes);
  assert.equal(episodes.length, 1);
  assert.equal(calendar.daily.length, 2);
  assert.equal(calendar.daily.reduce((sum, day) => sum + day.severeEpisodes, 0), 2);
});

test("hourly splitting preserves all duration and exposes spring-forward no-hour", () => {
  const start = Date.parse("2026-03-08T06:00:00Z");
  const end = Date.parse("2026-03-09T05:00:00Z");
  const timeline = buildBwcTimeline(archive([stateRun("LOW", start, end, { startReason: "ARCHIVE_START" })]), { startMs: start, endMs: end }, end);
  const hourly = summarizeBwcReportHourly(timeline);
  assert.equal(hourly.totalMs, 23 * HOUR);
  assert.equal(hourly.hours[2].elapsedMs, 0);
  assert.equal(hourly.hours[2].severePercentOfKnown, null);
  assert.equal(hourly.hours.reduce((sum, row) => sum + row.elapsedMs, 0), end - start);
});

test("fall-back repeated hour contributes two elapsed hours but one local date", () => {
  const start = Date.parse("2026-11-01T05:00:00Z");
  const end = Date.parse("2026-11-02T06:00:00Z");
  const timeline = buildBwcTimeline(archive([stateRun("MODERATE", start, end, { startReason: "ARCHIVE_START" })]), { startMs: start, endMs: end }, end);
  const hourly = summarizeBwcReportHourly(timeline);
  assert.equal(hourly.totalMs, 25 * HOUR);
  assert.equal(hourly.hours[1].elapsedMs, 2 * HOUR);
  assert.equal(hourly.hours[1].contributingDates, 1);
});

test("source/basis duration totals reconcile to known coverage without changing risk", () => {
  const fixture = sevenDayFixture();
  const timeline = buildBwcTimeline(fixture.value, { startMs: fixture.start, endMs: fixture.end }, fixture.end);
  const basis = summarizeBwcReportBasis(timeline);
  assert.equal(basis.reduce((sum, item) => sum + item.durationMs, 0), 159 * HOUR);
  assert.ok(basis.some((item) => item.basis === "NEXRAD" && item.basisClass === "OBSERVED_OPERATIONAL"));
  assert.ok(basis.some((item) => item.basis === "SOAR" && item.basisClass === "MODEL_OPERATIONAL"));
  assert.ok(basis.some((item) => item.basis === "NEXBAM" && item.basisClass === "MODEL_OPERATIONAL"));
});

test("no-data report is wholly UNKNOWN and never claims a known-time risk percentage", () => {
  const cutoff = Date.parse("2026-08-31T05:00:00Z");
  const report = buildBwcReportModel(archive([]), { selection: { key: "7d" }, cutoff });
  assert.equal(report.ok, true);
  assert.equal(report.coverage.coveragePercent, 0);
  assert.equal(report.coverage.unknownMs, 7 * DAY);
  for (const row of report.riskDistribution.filter((item) => item.state !== "UNKNOWN")) assert.equal(row.knownPercent, null);
  assert.match(report.findings.join(" "), /No represented LOW, MODERATE, or SEVERE/);
});

test("one-year selection with a short archive remains explicitly partial", () => {
  const cutoff = Date.parse("2026-08-31T05:00:00Z");
  const start = cutoff - 4 * DAY;
  const report = buildBwcReportModel(archive([stateRun("LOW", start, cutoff, { startReason: "ARCHIVE_START" })]), { selection: { key: "365d" }, cutoff });
  assert.equal(report.coverage.knownMs, 4 * DAY);
  assert.equal(report.coverage.unknownMs, 361 * DAY);
  assert.equal(report.coverage.partial, true);
  assert.equal(report.reportCalendar.daily.length, 365);
  assert.ok(report.reportCalendar.monthly.some((month) => month.unknownMs > 0));
});

test("archive availability uses the earliest retained run rather than collection start metadata", () => {
  const cutoff = Date.parse("2026-09-01T05:00:00Z");
  const start = cutoff - DAY;
  const payload = archive([stateRun("LOW", start, cutoff, { startReason: "RETENTION_CARRY_IN" })], {
    collectionStartedZ: iso(start - 200 * DAY),
  });
  const report = buildBwcReportModel(payload, { selection: { key: "24h" }, cutoff });
  assert.equal(report.archiveStartMs, start);
  assert.equal(report.coverage.partial, false);
});

test("monthly completeness distinguishes rolling partial months from a full DST month", () => {
  const cutoff = Date.parse("2026-09-14T17:00:00Z");
  const rollingStart = cutoff - 30 * DAY;
  const rolling = buildBwcReportModel(
    archive([stateRun("LOW", rollingStart, cutoff, { startReason: "ARCHIVE_START" })]),
    { selection: { key: "30d" }, cutoff },
  );
  assert.ok(rolling.reportCalendar.monthly.length >= 2);
  assert.ok(rolling.reportCalendar.monthly.every((month) => month.completeness === "PARTIAL"));

  const marchStart = Date.parse("2026-03-01T06:00:00Z");
  const aprilStart = Date.parse("2026-04-01T05:00:00Z");
  const fullMonth = buildBwcReportModel(
    archive([stateRun("MODERATE", marchStart, aprilStart, { startReason: "ARCHIVE_START" })]),
    {
      selection: { key: "custom", startDate: "2026-03-01", endDate: "2026-03-31" },
      cutoff: "2026-04-02T05:00:00Z",
    },
  );
  assert.equal(fullMonth.reportCalendar.monthly.length, 1);
  assert.equal(fullMonth.reportCalendar.monthly[0].elapsedMs, 743 * HOUR);
  assert.equal(fullMonth.reportCalendar.monthly[0].calendarWindowComplete, true);
  assert.equal(fullMonth.reportCalendar.monthly[0].completeness, "COMPLETE");
});

test("preceding equal-duration comparison discloses both coverage and percentage points", () => {
  const fixture = sevenDayFixture({ includePrevious: true });
  const report = buildBwcReportModel(fixture.value, { selection: { key: "7d" }, cutoff: fixture.end, includeComparison: true });
  assert.equal(report.comparison.status, "LIMITED_COVERAGE");
  assert.equal(report.comparison.current.coverage.coveragePercent < 100, true);
  assert.equal(report.comparison.previous.coverage.coveragePercent, 100);
  assert.ok(Math.abs(report.comparison.severeKnownPercentagePointChange - (19 / 159) * 100) < 1e-9);
  assert.ok(Math.abs(report.comparison.severeFullPeriodPercentagePointChange - (19 / 168) * 100) < 1e-9);
});

test("preceding comparison reports unavailable instead of manufacturing missing history", () => {
  const fixture = sevenDayFixture();
  const report = buildBwcReportModel(fixture.value, { selection: { key: "7d" }, cutoff: fixture.end, includeComparison: true });
  assert.equal(report.comparison.status, "UNAVAILABLE");
  assert.match(report.comparison.reason, /NO KNOWN COVERAGE/);
});

test("daily/monthly report rows retain pre-archive UNKNOWN in their own denominators", () => {
  const cutoff = Date.parse("2026-09-01T05:00:00Z");
  const start = cutoff - DAY;
  const payload = archive([stateRun("LOW", start, cutoff, { startReason: "ARCHIVE_START" })], { collectionStartedZ: iso(start) });
  const report = buildBwcReportModel(payload, { selection: { key: "7d" }, cutoff });
  assert.equal(report.reportCalendar.daily.reduce((sum, row) => sum + row.elapsedMs, 0), 7 * DAY);
  assert.equal(report.reportCalendar.daily.reduce((sum, row) => sum + row.unknownMs, 0), 6 * DAY);
  assert.equal(report.reportCalendar.monthly.reduce((sum, row) => sum + row.elapsedMs, 0), 7 * DAY);
});
