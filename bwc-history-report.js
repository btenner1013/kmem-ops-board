import {
  BWC_REPORT_DEFAULT_RANGE,
  BWC_REPORT_RANGE_KEYS,
  BWC_REPORT_RANGE_LABELS,
  buildBwcReportModel,
  formatBwcReportBoundary,
  resolveBwcReportRange,
} from "./bwc-history-report-core.js";
import { formatBwcDuration } from "./bwc-history-core.js";

const STATES = ["LOW", "MODERATE", "SEVERE", "UNKNOWN"];
const STATE_COLORS = Object.freeze({ LOW: "#2e8b57", MODERATE: "#b27a00", SEVERE: "#c62828", UNKNOWN: "#717171" });

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function breakableCode(value) {
  return escapeHtml(value).replace(/_/g, "_<wbr>");
}

function numberPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}%` : "—";
}

function duration(value) {
  return formatBwcDuration(value) || "—";
}

function shortDuration(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
}

function boundaryLines(value) {
  const formatted = formatBwcReportBoundary(value);
  return `<span>${escapeHtml(formatted.local)}</span><span>${escapeHtml(formatted.zulu)}</span>`;
}

function episodeFlags(episode) {
  return [
    episode.rangeClippedStart || episode.rangeClippedEnd ? "RANGE-CLIPPED" : "",
    episode.ongoing ? "ONGOING AT CUTOFF" : "",
    episode.gapBoundedStart || episode.gapBoundedEnd ? "GAP-BOUNDED" : "",
  ].filter(Boolean);
}

function riskDistributionSvg(model) {
  let x = 1;
  const parts = [];
  for (const row of model.riskDistribution) {
    const width = Math.max(0, Math.min(798 - x, 7.98 * (row.fullPeriodPercent || 0)));
    if (!(width > 0)) continue;
    const fill = row.state === "UNKNOWN" ? "url(#bwcReportUnknownPattern)" : STATE_COLORS[row.state];
    parts.push(`<rect x="${x.toFixed(2)}" y="16" width="${width.toFixed(2)}" height="38" fill="${fill}" stroke="#222" stroke-width="1"/>`);
    if (width >= 78) parts.push(`<text x="${(x + width / 2).toFixed(2)}" y="40" text-anchor="middle">${escapeHtml(row.state)} ${numberPercent(row.fullPeriodPercent)}</text>`);
    x += width;
  }
  return `<svg class="bwc-report-distribution-chart" viewBox="0 0 800 70" role="img" aria-label="Time-weighted BWC distribution across the full selected elapsed period">
    <defs><pattern id="bwcReportUnknownPattern" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#fff"/><line x1="0" y1="0" x2="0" y2="8" stroke="#666" stroke-width="3"/></pattern></defs>
    <rect x="1" y="16" width="798" height="38" fill="#fff" stroke="#222" stroke-width="1.5"/>${parts.join("")}
  </svg>`;
}

function timelineSvg(model) {
  if (!model.timelineSegments.length) return "";
  const start = model.range.startMs;
  const span = model.range.durationMs;
  const pieces = model.timelineSegments.map((segment) => {
    const x = 1 + ((segment.startMs - start) / span) * 898;
    const width = Math.max(.5, ((segment.endMs - segment.startMs) / span) * 898);
    const fill = segment.state === "UNKNOWN" ? "url(#bwcReportTimelineUnknown)" : STATE_COLORS[segment.state];
    return `<rect x="${x.toFixed(2)}" y="24" width="${width.toFixed(2)}" height="38" fill="${fill}" stroke="#222" stroke-width=".7"><title>${escapeHtml(segment.state)} · ${escapeHtml(duration(segment.endMs - segment.startMs))}</title></rect>`;
  }).join("");
  return `<figure class="bwc-report-figure bwc-report-timeline-figure"><figcaption>24-HOUR CATEGORICAL HISTORY · EXACT UTC GEOMETRY</figcaption><svg viewBox="0 0 900 84" role="img" aria-label="24-hour categorical BWC timeline">
    <defs><pattern id="bwcReportTimelineUnknown" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#fff"/><line x1="0" y1="0" x2="0" y2="8" stroke="#666" stroke-width="3"/></pattern></defs>
    ${pieces}<text x="1" y="78">${escapeHtml(formatBwcReportBoundary(start).zulu)}</text><text x="899" y="78" text-anchor="end">${escapeHtml(formatBwcReportBoundary(model.range.endMs).zulu)}</text>
  </svg></figure>`;
}

function periodDistributionSvg(model) {
  if (model.timelineSegments.length || !model.detailRows.length) return "";
  const rows = model.detailRows.slice(-13);
  const rowPitch = 15;
  const height = 20 + rows.length * rowPitch;
  const markup = rows.map((row, index) => {
    let x = 145;
    const y = 5 + index * rowPitch;
    const parts = [];
    for (const state of STATES) {
      const width = row.elapsedMs > 0 ? (row.durationsMs[state] / row.elapsedMs) * 720 : 0;
      if (width > 0) {
        parts.push(`<rect x="${x.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="10" fill="${state === "UNKNOWN" ? "url(#bwcReportPeriodUnknown)" : STATE_COLORS[state]}" stroke="#333" stroke-width=".4"/>`);
        x += width;
      }
    }
    return `<text x="138" y="${y + 8}" text-anchor="end">${escapeHtml(row.label)}</text>${parts.join("")}`;
  }).join("");
  return `<figure class="bwc-report-figure bwc-report-period-figure"><figcaption>${escapeHtml(model.detailMode.toUpperCase())} DISTRIBUTION · FULL SELECTED-PERIOD DENOMINATOR</figcaption><svg viewBox="0 0 880 ${height}" role="img" aria-label="${escapeHtml(model.detailMode)} BWC duration distribution">
    <defs><pattern id="bwcReportPeriodUnknown" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#fff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#666" stroke-width="2.5"/></pattern></defs>${markup}
  </svg></figure>`;
}

function hourlySvg(model) {
  const plotTop = 14;
  const plotHeight = 92;
  const barWidth = 26;
  const gap = 8;
  const left = 38;
  const rows = [];
  for (const bucket of model.hourly) {
    const x = left + bucket.hour * (barWidth + gap);
    if (!(bucket.elapsedMs > 0)) {
      rows.push(`<rect x="${x}" y="${plotTop}" width="${barWidth}" height="${plotHeight}" fill="#fff" stroke="#777" stroke-dasharray="3 2"/><path d="M${x + 5},${plotTop + 9} L${x + barWidth - 5},${plotTop + plotHeight - 9} M${x + barWidth - 5},${plotTop + 9} L${x + 5},${plotTop + plotHeight - 9}" stroke="#777"/>`);
    } else {
      let y = plotTop + plotHeight;
      for (const state of ["LOW", "MODERATE", "SEVERE", "UNKNOWN"]) {
        const height = (bucket.durationsMs[state] / bucket.elapsedMs) * plotHeight;
        if (!(height > 0)) continue;
        y -= height;
        rows.push(`<rect x="${x}" y="${y.toFixed(2)}" width="${barWidth}" height="${height.toFixed(2)}" fill="${state === "UNKNOWN" ? "url(#bwcReportHourlyUnknown)" : STATE_COLORS[state]}" stroke="#222" stroke-width=".5"><title>${escapeHtml(bucket.label)} · ${escapeHtml(state)} ${escapeHtml(duration(bucket.durationsMs[state]))}</title></rect>`);
      }
    }
    if (bucket.hour % 2 === 0) rows.push(`<text x="${x + barWidth / 2}" y="122" text-anchor="middle">${String(bucket.hour).padStart(2, "0")}</text>`);
  }
  return `<figure class="bwc-report-figure bwc-report-hourly-figure"><figcaption>LOCAL CLOCK-HOUR PROFILE · TIME-WEIGHTED DURATION</figcaption><svg viewBox="0 0 870 132" role="img" aria-label="Time-weighted BWC profile by America/Chicago local clock hour">
    <defs><pattern id="bwcReportHourlyUnknown" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#fff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#666" stroke-width="2.5"/></pattern></defs>
    <line x1="32" y1="${plotTop + plotHeight}" x2="855" y2="${plotTop + plotHeight}" stroke="#222"/>${rows.join("")}<text x="855" y="122" text-anchor="end">LOCAL HOUR</text>
  </svg></figure>`;
}

function hourTable(hours, label) {
  return `<table class="bwc-report-table bwc-report-hour-table"><caption>${escapeHtml(label)}</caption><thead><tr><th>START L</th><th>LOW</th><th>MOD</th><th>SEV</th><th>KNOWN</th><th>UNKNOWN</th><th>SEV / KNOWN</th><th>DATES</th></tr></thead><tbody>${hours.map((bucket) => `<tr class="${bucket.elapsedMs ? "" : "bwc-report-no-data"}"><th>${String(bucket.hour).padStart(2, "0")}</th><td>${bucket.elapsedMs ? escapeHtml(shortDuration(bucket.durationsMs.LOW)) : "—"}</td><td>${bucket.elapsedMs ? escapeHtml(shortDuration(bucket.durationsMs.MODERATE)) : "—"}</td><td>${bucket.elapsedMs ? escapeHtml(shortDuration(bucket.durationsMs.SEVERE)) : "—"}</td><td>${bucket.elapsedMs ? escapeHtml(numberPercent(bucket.coveragePercent, 0)) : "NO DATA"}</td><td>${bucket.elapsedMs ? escapeHtml(shortDuration(bucket.unknownMs)) : "—"}</td><td>${escapeHtml(numberPercent(bucket.severePercentOfKnown))}</td><td>${bucket.contributingDates || "—"}</td></tr>`).join("")}</tbody></table>`;
}

function detailTable(model, rows = model.detailRows, caption = "") {
  const periodLabel = model.detailMode === "daily" ? "DATE" : "MONTH";
  const formatDuration = model.detailMode === "monthly" ? shortDuration : duration;
  return `<table class="bwc-report-table bwc-report-detail-table"><caption>${escapeHtml(caption || `${model.detailMode.toUpperCase()} DETAIL · SELECTED ELAPSED TIME`)}</caption><thead><tr><th>${periodLabel}</th><th>LOW</th><th>MODERATE</th><th>SEVERE</th><th>SEV / KNOWN</th><th>EPISODES*</th><th>COVERAGE</th><th>STATUS</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(formatDuration(row.durationsMs.LOW))}</td><td>${escapeHtml(formatDuration(row.durationsMs.MODERATE))}</td><td>${escapeHtml(formatDuration(row.durationsMs.SEVERE))}</td><td>${escapeHtml(numberPercent(row.severePercentOfKnown))}</td><td>${row.severeEpisodes}</td><td>${escapeHtml(numberPercent(row.coveragePercent))}</td><td class="bwc-report-${row.completeness.toLowerCase()}">${escapeHtml(row.completeness)}</td></tr>`).join("") || `<tr><td colspan="8">NO SELECTED-PERIOD DETAIL AVAILABLE</td></tr>`}</tbody></table>`;
}

function basisTable(model) {
  return `<table class="bwc-report-table bwc-report-basis-table"><caption>SOURCE / BASIS MIX · KNOWN RISK TIME</caption><thead><tr><th>SOURCE</th><th>BASIS</th><th>CLASS</th><th>DURATION</th><th>KNOWN SHARE</th></tr></thead><tbody>${model.basis.map((item) => `<tr><td>${escapeHtml(item.source)}</td><td>${escapeHtml(item.basis)}</td><td>${breakableCode(item.basisClass)}</td><td>${escapeHtml(duration(item.durationMs))}</td><td>${escapeHtml(numberPercent(item.knownSharePercent))}</td></tr>`).join("") || `<tr><td colspan="5">NO KNOWN SOURCE/BASIS TIME IN SELECTED PERIOD</td></tr>`}</tbody></table>`;
}

function comparisonBlock(comparison) {
  if (!comparison) return "";
  if (comparison.status === "UNAVAILABLE") {
    return `<section class="bwc-report-block bwc-report-comparison"><h2>PRECEDING-PERIOD COMPARISON</h2><p class="bwc-report-warning">COMPARISON UNAVAILABLE · ${escapeHtml(comparison.reason)}</p></section>`;
  }
  const currentSevere = comparison.current.riskDistribution.find((row) => row.state === "SEVERE");
  const previousSevere = comparison.previous.riskDistribution.find((row) => row.state === "SEVERE");
  return `<section class="bwc-report-block bwc-report-comparison"><h2>PRECEDING EQUAL-DURATION COMPARISON</h2>${comparison.status === "LIMITED_COVERAGE" ? `<p class="bwc-report-warning">LIMITED COVERAGE · INTERPRET DIFFERENCES CAUTIOUSLY</p>` : ""}<table class="bwc-report-table"><thead><tr><th>PERIOD</th><th>COVERAGE</th><th>SEV / KNOWN</th><th>SEV / FULL</th><th>SOURCE MIX</th></tr></thead><tbody><tr><th>CURRENT</th><td>${numberPercent(comparison.current.coverage.coveragePercent)}</td><td>${numberPercent(currentSevere.knownPercent)}</td><td>${numberPercent(currentSevere.fullPeriodPercent)}</td><td>${escapeHtml(comparison.current.basis.map((item) => `${item.basis} ${numberPercent(item.knownSharePercent, 0)}`).join(" · ") || "—")}</td></tr><tr><th>PRECEDING</th><td>${numberPercent(comparison.previous.coverage.coveragePercent)}</td><td>${numberPercent(previousSevere.knownPercent)}</td><td>${numberPercent(previousSevere.fullPeriodPercent)}</td><td>${escapeHtml(comparison.previous.basis.map((item) => `${item.basis} ${numberPercent(item.knownSharePercent, 0)}`).join(" · ") || "—")}</td></tr><tr><th>CHANGE</th><td>—</td><td>${Number.isFinite(comparison.severeKnownPercentagePointChange) ? `${comparison.severeKnownPercentagePointChange >= 0 ? "+" : ""}${comparison.severeKnownPercentagePointChange.toFixed(1)} pp` : "—"}</td><td>${Number.isFinite(comparison.severeFullPeriodPercentagePointChange) ? `${comparison.severeFullPeriodPercentagePointChange >= 0 ? "+" : ""}${comparison.severeFullPeriodPercentagePointChange.toFixed(1)} pp` : "—"}</td><td>DESCRIPTIVE ONLY</td></tr></tbody></table></section>`;
}

function seasonalBlock(model) {
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  if (!(model?.range?.durationMs >= ninetyDaysMs)) return "";
  const rows = Array.isArray(model.summaries?.seasonal) ? model.summaries.seasonal : [];
  if (!rows.length) {
    return `<section class="bwc-report-block bwc-report-seasonal"><h2>SEASONAL SUMMARY</h2><p class="bwc-report-warning">UNAVAILABLE · NO RETAINED SEASONAL INTERVAL IS REPRESENTED IN THIS RANGE.</p></section>`;
  }
  const completeSeasons = rows.filter((row) => row.calendarWindowComplete && row.coveragePercent >= 99.95).length;
  return `<section class="bwc-report-block bwc-report-seasonal"><h2>SEASONAL SUMMARY</h2><p class="bwc-report-definition">Selected-period season slices; percentages are time-weighted retained duration.</p><table class="bwc-report-table bwc-report-seasonal-table"><thead><tr><th>SEASON</th><th>ELAPSED IN RANGE</th><th>SEVERE</th><th>SEV / KNOWN</th><th>COVERAGE</th><th>STATUS</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(duration(row.representedMs))}</td><td>${escapeHtml(duration(row.durationsMs.SEVERE))}</td><td>${escapeHtml(numberPercent(row.knownCoverageMs > 0 ? (row.durationsMs.SEVERE / row.knownCoverageMs) * 100 : null))}</td><td>${escapeHtml(numberPercent(row.coveragePercent))}</td><td class="bwc-report-${row.isComplete ? "complete" : "partial"}">${row.isComplete ? "COMPLETE" : "PARTIAL"}</td></tr>`).join("")}</tbody></table><p class="bwc-report-table-note">${completeSeasons >= 2 ? "DESCRIPTIVE RETAINED HISTORY ONLY; NO FORECAST OR CAUSAL CLAIM IS MADE." : "LIMITED BASIS FOR SEASONAL COMPARISON · FEWER THAN TWO COMPLETE, FULLY COVERED SEASONS; NO SEASONAL PATTERN IS CLAIMED."}</p></section>`;
}

function methodBlock(model) {
  return `<section class="bwc-report-block bwc-report-method"><h2>METHOD AND LIMITATIONS</h2><p>Statistics are time-weighted from retained USAHAS source timestamps. A state is represented only through the archive’s configured ${escapeHtml(model.continuityMinutes)}-minute continuity/carry-forward limit; longer gaps are UNKNOWN. Confirmations do not create new episodes, and adjacent SEVERE intervals remain one episode across source/basis-only changes.</p><p>Durations represent retained category coverage, not uninterrupted direct observation. Basis names/classes are reproduced as stored; model-backed values are not described as live radar. This report does not estimate bird counts, strike probability, exposure, causal effects, or a future safe operating window.</p></section>`;
}

function reportHeader(model, compact = false) {
  const latest = model.latestObservation ? boundaryLines(model.latestObservation.timeMs) : "<span>NO RETAINED OBSERVATION INCLUDED</span>";
  return `<header class="bwc-report-page-header ${compact ? "bwc-report-page-header-compact" : ""}"><div><p class="bwc-report-kicker">KMEM · DECISION-SUPPORT REPORT</p><h1>KMEM BIRD-ACTIVITY RISK REVIEW</h1><p>Retained USAHAS AHAS history — not official airfield BWC</p></div>${compact ? "" : `<dl class="bwc-report-identity"><div><dt>SELECTED PERIOD START</dt><dd>${boundaryLines(model.range.startMs)}</dd></div><div><dt>ACTUAL REPORT CUTOFF / END</dt><dd>${boundaryLines(model.range.endMs)}</dd></div><div><dt>ARCHIVE AVAILABLE SINCE</dt><dd>${model.archiveStartMs === null ? "<span>NO RETAINED ARCHIVE START</span>" : boundaryLines(model.archiveStartMs)}</dd></div><div><dt>LATEST SOURCE OBSERVATION INCLUDED</dt><dd>${latest}</dd></div><div><dt>REPORT PREPARED</dt><dd>${boundaryLines(model.preparedAtMs)}</dd></div><div><dt>TIME ZONE / RANGE</dt><dd><span>AMERICA/CHICAGO</span><span>${escapeHtml(model.range.label)}${model.range.futureClipped ? " · FUTURE TIME CLIPPED" : ""}</span></dd></div></dl>`}</header>`;
}

function pageFooter(page, total) {
  return `<footer class="bwc-report-page-footer"><span>USAHAS AHAS HISTORY · NOT OFFICIAL AIRFIELD BWC</span><span>PAGE ${page} OF ${total}</span></footer>`;
}

function pageOne(model) {
  const severe = model.severe.longest;
  const coverageClass = model.coverage.coveragePercent >= 99.95 ? "complete" : model.coverage.knownMs > 0 ? "partial" : "unavailable";
  const comparison = comparisonBlock(model.comparison);
  return `${reportHeader(model)}${model.range.futureClipped ? `<p class="bwc-report-cutoff-warning">REQUESTED CUSTOM END EXTENDED INTO UNELAPSED TIME. REPORT ENDS AT THE FROZEN PREPARATION CUTOFF SHOWN ABOVE.</p>` : ""}
  <section class="bwc-report-summary-grid"><article class="bwc-report-block bwc-report-coverage bwc-report-coverage-${coverageClass}"><h2>DATA COVERAGE</h2><div class="bwc-report-metric-row"><div><span>SELECTED ELAPSED</span><strong>${escapeHtml(duration(model.coverage.elapsedMs))}</strong></div><div><span>KNOWN / REPRESENTED</span><strong>${escapeHtml(duration(model.coverage.knownMs))}</strong></div><div><span>UNKNOWN / UNCOLLECTED</span><strong>${escapeHtml(duration(model.coverage.unknownMs))}</strong></div><div><span>COVERAGE</span><strong>${numberPercent(model.coverage.coveragePercent)}</strong></div></div>${model.coverage.partial ? `<p class="bwc-report-warning">PARTIAL HISTORY / UNKNOWN TIME IS INCLUDED IN THE FULL-PERIOD DENOMINATOR.</p>` : `<p class="bwc-report-ok">COMPLETE COVERAGE FOR THE SELECTED ELAPSED PERIOD.</p>`}</article>
  <article class="bwc-report-block bwc-report-severe"><h2>SEVERE SUMMARY</h2><div class="bwc-report-metric-row"><div><span>REPRESENTED DURATION</span><strong>${escapeHtml(duration(model.severe.durationMs))}</strong></div><div><span>PERIOD EPISODES</span><strong>${model.severe.episodeCount}</strong></div><div><span>LOCAL DAYS WITH SEVERE</span><strong>${model.severe.daysWithSevere}</strong></div><div><span>LONGEST IN RANGE</span><strong>${severe ? escapeHtml(duration(severe.durationMs)) : "—"}</strong></div></div>${severe ? `<div class="bwc-report-longest"><span>${boundaryLines(severe.startMs)}</span><b>→</b><span>${boundaryLines(severe.endMs)}</span>${episodeFlags(severe).map((flag) => `<em>${escapeHtml(flag)}</em>`).join("")}</div>` : `<p>NO REPRESENTED SEVERE INTERVAL IN THIS RANGE.</p>`}</article></section>
  <section class="bwc-report-block bwc-report-risk"><h2>RISK DISTRIBUTION</h2><p class="bwc-report-definition">Time-weighted retained category duration. UNKNOWN is never shown as LOW.</p>${riskDistributionSvg(model)}<table class="bwc-report-table"><thead><tr><th>STATE</th><th>DURATION</th><th>% OF KNOWN COVERED TIME</th><th>% OF FULL SELECTED ELAPSED PERIOD</th></tr></thead><tbody>${model.riskDistribution.map((row) => `<tr><th class="bwc-report-state-${row.state.toLowerCase()}">${escapeHtml(row.state)}</th><td>${escapeHtml(duration(row.durationMs))}</td><td>${numberPercent(row.knownPercent)}</td><td>${numberPercent(row.fullPeriodPercent)}</td></tr>`).join("")}</tbody></table></section>
  <section class="bwc-report-block bwc-report-findings"><h2>BRIEFING FINDINGS</h2><ol>${model.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("") || "<li>No represented findings are available for this period.</li>"}</ol></section><div class="bwc-report-page-one-bottom ${comparison ? "bwc-report-page-one-bottom-has-comparison" : ""}">${comparison}<section class="bwc-report-block">${basisTable(model)}</section></div>`;
}

function pageTwo(model) {
  const seasonal = seasonalBlock(model);
  return `${reportHeader(model, true)}<div class="bwc-report-page-two-grid ${seasonal ? "bwc-report-page-two-grid-long" : ""}"><section class="bwc-report-block bwc-report-hourly"><h2>TIME-OF-DAY ANALYSIS</h2><p class="bwc-report-definition">Actual elapsed duration grouped by America/Chicago local clock hour. Repeated DST hours retain both elapsed occurrences; nonexistent hours remain unavailable.</p>${hourlySvg(model)}<div class="bwc-report-hour-tables">${hourTable(model.hourly.slice(0, 12), "0000–1200 LOCAL")}${hourTable(model.hourly.slice(12), "1200–2400 LOCAL")}</div></section><section class="bwc-report-block bwc-report-period-detail"><h2>${model.detailMode === "daily" ? "DAILY" : "MONTHLY"} DETAIL</h2>${timelineSvg(model)}${periodDistributionSvg(model)}${detailTable(model)}<p class="bwc-report-table-note">* Period episode counts show intersections; the whole-report episode total is calculated once and is not the sum of these rows.</p></section></div><div class="bwc-report-page-two-bottom ${seasonal ? "bwc-report-page-two-bottom-has-seasonal" : ""}">${seasonal}${methodBlock(model)}</div>`;
}

function appendixPages(model) {
  if (!model.includeAppendix || !model.appendixRows.length) return [];
  const chunks = [];
  for (let index = 0; index < model.appendixRows.length; index += 24) chunks.push(model.appendixRows.slice(index, index + 24));
  return chunks.map((rows, index) => `${reportHeader(model, true)}<section class="bwc-report-block bwc-report-appendix"><h2>DETAIL APPENDIX · DAILY INTERVAL SUMMARY ${chunks.length > 1 ? `${index + 1} OF ${chunks.length}` : ""}</h2>${detailTable({ ...model, detailMode: "daily" }, rows, "DAILY DETAIL · FULL SELECTED-PERIOD DENOMINATOR")}</section>`);
}

/** Build the exact DOM source used by both on-screen preview and native print. */
export function buildBwcReportHtml(model) {
  if (!model?.ok) return "";
  const bodies = [pageOne(model), pageTwo(model), ...appendixPages(model)];
  return bodies.map((body, index) => `<article class="bwc-report-page" data-bwc-report-page="${index + 1}">${body}${pageFooter(index + 1, bodies.length)}</article>`).join("");
}

function localDateValue(value) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(value)).filter((part) => part.type !== "literal");
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return "";
  }
}

function shiftedIsoDate(dateText, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) return dateText;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)).toISOString().slice(0, 10);
}

function focusable(container) {
  return [...container.querySelectorAll("button,input")].filter((node) => !node.disabled && !node.hidden);
}

function trapDialogFocus(event, container) {
  if (event.key !== "Tab") return;
  const items = focusable(container);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && container.ownerDocument.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && container.ownerDocument.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function initializeBwcHistoryReport(doc = document, options = {}) {
  const ids = [
    "bwcHistoryPrintReport", "bwcReportSetupOverlay", "bwcReportSetupPanel", "bwcReportSetupClose", "bwcReportSetupForm",
    "bwcReportCustomFields", "bwcReportStartDate", "bwcReportEndDate", "bwcReportRangePreview", "bwcReportSetupStatus",
    "bwcReportSetupCancel", "bwcReportPreview", "bwcReportPreviewBack", "bwcReportPreviewPrint", "bwcReportPages",
    "bwcHistoryPanel",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, doc.getElementById(id)]));
  if (ids.some((id) => !elements[id])) return null;
  const view = doc.defaultView || window;
  const rangeInputs = [...doc.querySelectorAll("[name='bwcReportRange']")];
  const comparisonInput = doc.getElementById("bwcReportComparison");
  const appendixInput = doc.getElementById("bwcReportAppendix");
  if (!rangeInputs.length || !comparisonInput || !appendixInput) return null;
  let historyAvailable = false;
  let frozenModel = null;
  let printScrollState = null;

  function getNowMs() {
    const value = options.getNowMs?.() ?? view.getBoardNowMs?.() ?? Date.now();
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  }

  function selection() {
    const key = rangeInputs.find((input) => input.checked)?.value || BWC_REPORT_DEFAULT_RANGE;
    return { key, startDate: elements.bwcReportStartDate.value, endDate: elements.bwcReportEndDate.value };
  }

  function setParentInert(value) {
    elements.bwcHistoryPanel.inert = Boolean(value);
    if (value) elements.bwcHistoryPanel.setAttribute("aria-hidden", "true");
    else elements.bwcHistoryPanel.removeAttribute("aria-hidden");
  }

  function updateRangePreview(cutoffMs = getNowMs()) {
    const selected = selection();
    const custom = selected.key === "custom";
    elements.bwcReportCustomFields.hidden = !custom;
    const resolved = resolveBwcReportRange(selected, cutoffMs);
    if (!resolved.ok) {
      elements.bwcReportRangePreview.textContent = resolved.error.message;
      elements.bwcReportSetupStatus.textContent = resolved.error.message;
      return resolved;
    }
    const start = formatBwcReportBoundary(resolved.startMs);
    const end = formatBwcReportBoundary(resolved.endMs);
    elements.bwcReportRangePreview.textContent = `${resolved.label} · ${start.local} / ${start.zulu} → ${end.local} / ${end.zulu}${resolved.futureClipped ? " · FUTURE/UNELAPSED TIME CLIPPED AT CUTOFF" : ""}`;
    elements.bwcReportSetupStatus.textContent = "";
    return resolved;
  }

  function resetSetup() {
    for (const input of rangeInputs) input.checked = input.value === BWC_REPORT_DEFAULT_RANGE;
    comparisonInput.checked = false;
    appendixInput.checked = false;
    const today = localDateValue(getNowMs());
    elements.bwcReportEndDate.value = today;
    elements.bwcReportStartDate.value = shiftedIsoDate(today, -6);
    updateRangePreview();
  }

  function openSetup() {
    if (!historyAvailable) return false;
    resetSetup();
    elements.bwcReportSetupOverlay.hidden = false;
    elements.bwcReportSetupOverlay.setAttribute("aria-hidden", "false");
    doc.body.classList.add("bwc-report-setup-open");
    setParentInert(true);
    (view.requestAnimationFrame || ((callback) => callback()))(() => elements.bwcReportSetupClose.focus());
    return true;
  }

  function closeSetup(returnFocus = true) {
    elements.bwcReportSetupOverlay.hidden = true;
    elements.bwcReportSetupOverlay.setAttribute("aria-hidden", "true");
    doc.body.classList.remove("bwc-report-setup-open");
    if (elements.bwcReportPreview.hidden) setParentInert(false);
    if (returnFocus) elements.bwcHistoryPrintReport.focus();
  }

  function showPreview(model) {
    frozenModel = model;
    elements.bwcReportPages.innerHTML = buildBwcReportHtml(model);
    elements.bwcReportSetupOverlay.hidden = true;
    elements.bwcReportSetupOverlay.setAttribute("aria-hidden", "true");
    elements.bwcReportPreview.hidden = false;
    elements.bwcReportPreview.setAttribute("aria-hidden", "false");
    doc.body.classList.remove("bwc-report-setup-open");
    doc.body.classList.add("bwc-report-preview-open");
    setParentInert(true);
    elements.bwcReportPreview.scrollTop = 0;
    elements.bwcReportPreview.scrollLeft = 0;
    elements.bwcReportPreviewBack.focus();
  }

  function closePreview() {
    doc.body.classList.remove("bwc-report-printing", "bwc-report-preview-open");
    elements.bwcReportPreview.hidden = true;
    elements.bwcReportPreview.setAttribute("aria-hidden", "true");
    elements.bwcReportPages.innerHTML = "";
    frozenModel = null;
    printScrollState = null;
    setParentInert(false);
    elements.bwcHistoryPrintReport.focus();
  }

  function printReport() {
    if (!beginPrint()) return false;
    view.print?.();
    return true;
  }

  function beginPrint() {
    if (!frozenModel || elements.bwcReportPreview.hidden) return false;
    if (!printScrollState) {
      printScrollState = {
        top: Number(elements.bwcReportPreview.scrollTop) || 0,
        left: Number(elements.bwcReportPreview.scrollLeft) || 0,
      };
    }
    elements.bwcReportPreview.scrollTop = 0;
    elements.bwcReportPreview.scrollLeft = 0;
    doc.body.classList.add("bwc-report-printing");
    return true;
  }

  function endPrint() {
    doc.body.classList.remove("bwc-report-printing");
    if (!printScrollState || elements.bwcReportPreview.hidden) {
      printScrollState = null;
      return;
    }
    const restore = printScrollState;
    printScrollState = null;
    (view.requestAnimationFrame || ((callback) => callback()))(() => {
      elements.bwcReportPreview.scrollTop = restore.top;
      elements.bwcReportPreview.scrollLeft = restore.left;
    });
  }

  function closeAll() {
    closeSetup(false);
    if (!elements.bwcReportPreview.hidden) closePreview();
    doc.body.classList.remove("bwc-report-printing", "bwc-report-preview-open", "bwc-report-setup-open");
    setParentInert(false);
  }

  elements.bwcHistoryPrintReport.addEventListener("click", openSetup);
  elements.bwcReportSetupClose.addEventListener("click", () => closeSetup());
  elements.bwcReportSetupCancel.addEventListener("click", () => closeSetup());
  for (const input of [...rangeInputs, elements.bwcReportStartDate, elements.bwcReportEndDate]) {
    input.addEventListener("change", () => updateRangePreview());
  }
  elements.bwcReportSetupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const cutoffMs = getNowMs();
    const resolved = updateRangePreview(cutoffMs);
    if (!resolved.ok) return;
    const history = options.getHistory?.();
    if (!history) {
      elements.bwcReportSetupStatus.textContent = "BWC HISTORY IS NOT AVAILABLE FOR REPORTING.";
      return;
    }
    const model = buildBwcReportModel(history, {
      selection: selection(),
      cutoff: cutoffMs,
      preparedAt: cutoffMs,
      includeComparison: comparisonInput.checked,
      includeAppendix: appendixInput.checked,
    });
    if (!model.ok) {
      elements.bwcReportSetupStatus.textContent = model.error?.message || "REPORT PREVIEW IS UNAVAILABLE.";
      return;
    }
    showPreview(model);
  });
  elements.bwcReportPreviewBack.addEventListener("click", closePreview);
  elements.bwcReportPreviewPrint.addEventListener("click", printReport);
  elements.bwcReportSetupOverlay.addEventListener("click", (event) => {
    if (event.target === elements.bwcReportSetupOverlay) closeSetup();
  });
  elements.bwcReportSetupOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeSetup(); return; }
    trapDialogFocus(event, elements.bwcReportSetupPanel);
  });
  elements.bwcReportPreview.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closePreview(); return; }
    trapDialogFocus(event, elements.bwcReportPreview);
  });
  view.addEventListener?.("beforeprint", beginPrint);
  view.addEventListener?.("afterprint", endPrint);

  function setHistoryAvailable(value) {
    historyAvailable = Boolean(value);
    elements.bwcHistoryPrintReport.disabled = !historyAvailable;
  }

  setHistoryAvailable(false);
  return {
    openSetup,
    closeSetup,
    closePreview,
    closeAll,
    printReport,
    setHistoryAvailable,
    updateRangePreview,
    get frozenModel() { return frozenModel; },
  };
}

export { BWC_REPORT_RANGE_KEYS, BWC_REPORT_RANGE_LABELS };
