import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";


const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");


function sourceBetween(startMarker, endMarker) {
  const start = indexHtml.indexOf(startMarker);
  const end = indexHtml.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return indexHtml.slice(start, end);
}


const context = vm.createContext({
  minutesSince: () => null,
  parseAtisTime: () => null,
  isBadText: (value, badWords) => {
    const text = String(value || "").toUpperCase();
    return !text.trim() || badWords.some(word => text.includes(word));
  },
});
vm.runInContext(
  `${sourceBetween("function atisFeedState", "function updateSourceHealth")}` +
    "globalThis.atisFeedState=atisFeedState;",
  context,
);

const ATIS_NOW_MS = Date.parse("2026-09-08T22:00:00Z");
const atisDisplayContext = vm.createContext({
  getBoardNowMs: () => ATIS_NOW_MS,
  parseUpdatedZ: (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  },
  isBadText: (value, badWords) => {
    const text = String(value || "").toUpperCase();
    return !text.trim() || badWords.some((word) => text.includes(word));
  },
});
vm.runInContext(
  `${sourceBetween("function atisPhoneticForLetter", "function setClosedRunwayDisplay")}` +
    "globalThis.atisDisplayState=atisDisplayState;" +
    "globalThis.atisRunwayDisplayState=atisRunwayDisplayState;" +
    "globalThis.atisFlowDisplayState=atisFlowDisplayState;" +
    "globalThis.atisCatchupNeeded=atisCatchupNeeded;",
  atisDisplayContext,
);

function retainedAtisFixture(ageMinutes, overrides = {}) {
  const observed = new Date(ATIS_NOW_MS - ageMinutes * 60_000);
  const hhmm = `${String(observed.getUTCHours()).padStart(2, "0")}${String(observed.getUTCMinutes()).padStart(2, "0")}`;
  return {
    atisText: `MEM ATIS INFO G ${hhmm}Z. 29004KT 10SM SCT065 38/18 A3004. ADVS YOU HAVE INFO G`,
    atisObservedZ: observed.toISOString(),
    atisReportIdentity: `G:${hhmm}Z`,
    atisAgeMinutes: ageMinutes,
    atisReportedLetter: "G",
    ...overrides,
  };
}

const NOTAM_NOW_MS = Date.parse("2026-08-28T12:00:00Z");
const notamContext = vm.createContext({
  getBoardNowMs: () => NOTAM_NOW_MS,
});
vm.runInContext(
  sourceBetween("function parseUpdatedZ", "function isWeatherStale") + "\n" +
    sourceBetween("function notamFeedState", "function updateSourceHealth") + "\n" +
    sourceBetween("function parseCaoDate", "function normalizeNotamTimeText") + "\n" +
    "globalThis.notamFeedState=notamFeedState;" +
    "globalThis.setCaoStatusDisplay=setCaoStatusDisplay;",
  notamContext,
);


function statusAt(age, overrides = {}) {
  return context.atisFeedState(
    {
      atisAgeMinutes: age,
      atisFetchStatus: "OK",
      atisReportedLetter: "A",
      ...overrides,
    },
    "MEM ATIS INFO A 1154Z. 09005KT 10SM SCT250 25/20 A3000.",
  );
}

function notamStatusAt(ageMinutes, overrides = {}) {
  const updated = Number.isFinite(ageMinutes)
    ? new Date(NOTAM_NOW_MS - ageMinutes * 60_000).toISOString()
    : "";
  return notamContext.notamFeedState(
    {
      milNotamUpdatedZ: updated,
      milNotamFetchStatus: "OK",
      milNotamRawStatus: "Success",
      ...overrides,
    },
    NOTAM_NOW_MS,
  );
}


test("ATIS footer status uses the existing 60- and 90-minute boundaries", () => {
  assert.deepEqual({ ...statusAt(59) }, { status: "OK", detail: "", age: 59 });
  assert.deepEqual({ ...statusAt(60) }, { status: "WARN", detail: "60M", age: 60 });
  assert.deepEqual({ ...statusAt(89) }, { status: "WARN", detail: "89M", age: 89 });
  assert.deepEqual({ ...statusAt(90) }, { status: "STALE", detail: "90M", age: 90 });
  assert.deepEqual({ ...statusAt(91) }, { status: "STALE", detail: "91M", age: 91 });
});


test("ATIS footer reports unavailable for missing timestamp or unusable report", () => {
  assert.deepEqual(
    { ...statusAt(null, { atisFetchStatus: "SOURCE_TIME_UNKNOWN" }) },
    { status: "UNAVAILABLE", detail: "", age: null },
  );
  assert.deepEqual(
    {
      ...context.atisFeedState(
        {
          atisAgeMinutes: null,
          atisFetchStatus: "FAILED_NO_LAST_GOOD",
          atisReportedLetter: "--",
        },
        "D-ATIS unavailable",
      ),
    },
    { status: "UNAVAILABLE", detail: "", age: null },
  );
});

test("NOTAM freshness uses exact 30- and 60-minute boundaries", () => {
  assert.deepEqual({ ...notamStatusAt(0) }, { status: "OK", detail: "", age: 0 });
  assert.deepEqual({ ...notamStatusAt(30) }, { status: "OK", detail: "", age: 30 });
  assert.deepEqual(
    { ...notamStatusAt(30 + 1 / 60) },
    { status: "WARN", detail: "31M", age: 31 },
  );
  assert.deepEqual({ ...notamStatusAt(60) }, { status: "WARN", detail: "60M", age: 60 });
  assert.deepEqual(
    { ...notamStatusAt(60 + 1 / 60) },
    { status: "STALE", detail: "61M", age: 61 },
  );
});

test("NOTAM fetch failures take precedence over cached success and timestamps", () => {
  for (const fetchStatus of ["SCRIPT_FAILED", "TIMEOUT", "ERROR", "NO_OUTPUT_JSON", "NO-OUTPUT", "NO OUTPUT"]) {
    const result = notamStatusAt(5, { milNotamFetchStatus: fetchStatus });
    assert.equal(result.status, "ERROR", fetchStatus);
    assert.equal(result.detail, fetchStatus);
  }

  const rawError = notamStatusAt(5, { milNotamRawStatus: "Source Error" });
  assert.equal(rawError.status, "ERROR");
  assert.equal(rawError.detail, "SOURCE ERROR");

  const rawNoOutput = notamStatusAt(5, { milNotamRawStatus: "NO_OUTPUT_JSON" });
  assert.equal(rawNoOutput.status, "ERROR");
  assert.equal(rawNoOutput.detail, "NO_OUTPUT_JSON");
});

test("NOTAM non-current and unprovable states are unavailable", () => {
  for (const fetchStatus of ["NO_DATA", "NO_CREDENTIALS", "NO_NMS_SCRIPT"]) {
    const result = notamStatusAt(5, { milNotamFetchStatus: fetchStatus });
    assert.equal(result.status, "UNAVAILABLE", fetchStatus);
    assert.equal(result.detail, fetchStatus);
  }

  assert.deepEqual(
    {
      ...notamContext.notamFeedState(
        { milNotamFetchStatus: "OK", milNotamRawStatus: "Success" },
        NOTAM_NOW_MS,
      ),
    },
    { status: "UNAVAILABLE", detail: "TIME UNKNOWN", age: null },
  );
  assert.equal(
    notamStatusAt(5, { milNotamRawStatus: "NO_PREVIOUS_DATA" }).status,
    "UNAVAILABLE",
  );
  assert.equal(
    notamStatusAt(5, { milNotamRawStatus: "UNKNOWN" }).status,
    "UNAVAILABLE",
  );
  assert.equal(
    notamContext.notamFeedState(
      {
        milNotamUpdatedZ: "not-a-time",
        milNotamFetchStatus: "OK",
        milNotamRawStatus: "Success",
      },
      NOTAM_NOW_MS,
    ).status,
    "UNAVAILABLE",
  );
  assert.deepEqual(
    {
      ...notamContext.notamFeedState(
        {
          milNotamUpdatedZ: new Date(NOTAM_NOW_MS + 1_000).toISOString(),
          milNotamFetchStatus: "OK",
          milNotamRawStatus: "Success",
        },
        NOTAM_NOW_MS,
      ),
    },
    { status: "UNAVAILABLE", detail: "FUTURE TIME", age: null },
  );
});

test("NOTAM CAO uses the shared state and distinct five-state classes", () => {
  function renderCao(ageMinutes, fetchStatus = "OK", rawStatus = "Success") {
    const added = [];
    const cao = {
      className: "",
      textContent: "",
      title: "",
      classList: { add: value => added.push(value) },
    };
    const updated = new Date(NOTAM_NOW_MS - ageMinutes * 60_000).toISOString();
    notamContext.setCaoStatusDisplay(cao, updated, fetchStatus, rawStatus);
    return { cao, added };
  }

  assert.deepEqual(renderCao(30).added, ["mil-notam-cao-ok"]);
  assert.deepEqual(renderCao(31).added, ["mil-notam-cao-warn"]);
  assert.deepEqual(renderCao(61).added, ["mil-notam-cao-stale"]);
  assert.deepEqual(renderCao(5, "TIMEOUT").added, ["mil-notam-cao-bad"]);

  const unavailable = renderCao(5, "NO_CREDENTIALS");
  assert.deepEqual(unavailable.added, ["mil-notam-cao-unavailable"]);
  assert.match(unavailable.cao.textContent, /^CAO \d{4}Z$/);
  assert.match(unavailable.cao.title, /NOTAM FEED UNAVAILABLE NO_CREDENTIALS/);
  assert.match(indexHtml, /\.mil-notam-cao-unavailable\{ color:#9fb0c0 !important;/);
});

test("NOTAM footer and CAO share one classifier without borrowing weather freshness", () => {
  const footerSource = sourceBetween("function updateSourceHealth", "function parseCaoDate");
  const caoSource = sourceBetween("function setCaoStatusDisplay", "function normalizeNotamTimeText");
  const displaySource = sourceBetween("function setMilNotamsDisplay", "function measureMilNotamScroll");

  assert.match(
    footerSource,
    /const notamFeed=notamFeedState\(data\);\s*addPart\("NOTAMS",notamFeed\.status,notamFeed\.detail\)/,
  );
  assert.match(caoSource, /const feed=notamFeedState\(\{/);
  assert.match(displaySource, /const updated=data\.milNotamUpdatedZ\|\|"--";/);
  assert.doesNotMatch(displaySource, /milNotamUpdatedZ\|\|data\.allFeedsUpdatedZ/);
  assert.match(
    displaySource,
    /filterInactiveNotamRecords\(data\.milNotams,inactiveNumbers\)/,
  );
  assert.match(
    displaySource,
    /filterInactiveNotamRecords\(data\.runwayClosureNotams,inactiveNumbers\)/,
  );
});

test("unknown runway state is amber and does not use the flashing closure class", () => {
  assert.match(indexHtml, /\.closed-unknown\{color:var\(--warning\)\}/);
  assert.match(
    sourceBetween("function setClosedRunwayDisplay", "function formatAhasBwcDateTime"),
    /closed==="UNKNOWN"[\s\S]*classList\.add\("closed-unknown"\)[\s\S]*textContent="UNKNOWN"/,
  );
});

test("live BWC keeps source time visible and delegates age updates to the board clock", () => {
  const clockSource = sourceBetween("function updateClock()", "function fitClockPanels");
  const bwcSource = sourceBetween("function setBwcDisplay", "function setLightningDisplay");

  assert.match(clockSource, /window\.kmemUpdateBwcAge\?\.\(\)/);
  assert.match(bwcSource, /className="bwc-stamp-source"/);
  assert.match(indexHtml, /id="bwc"[^>]*>PENDING<\/div>\s*<div id="bwcAge" class="bwc-age bwc-stamp-pending" hidden><\/div>/);
  assert.match(bwcSource, /getElementById\("bwcAge"\)/);
  assert.doesNotMatch(bwcSource, /stamp\.append\(source,age\)/);
  assert.match(bwcSource, /stamp\.append\(source\)/);
  assert.match(bwcSource, /window\.kmemUpdateBwcAge\?\.\(true\)/);
  assert.doesNotMatch(indexHtml, /\.bwc-stamp\{ display:none !important; \}/);
  assert.match(indexHtml, /\.bwc-age\{display:block;[^}]*font-size:clamp\(/);
  assert.match(indexHtml, /\.bwc-age\{[^}]*white-space:normal;[^}]*overflow:visible;[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(indexHtml, /\.bwc-age\{[^}]*white-space:nowrap;[^}]*overflow:hidden/);
  assert.match(indexHtml, /\.ops-box\.bwc-ops-box\{min-height:[^}]*!important/);
});

test("main board keeps a validated last-reported ATIS visible across warning and stale boundaries", () => {
  assert.deepEqual(
    { ...atisDisplayContext.atisDisplayState(retainedAtisFixture(59, {
      atisLetter: "G",
      atisSourceIsCurrent: true,
      atisFetchStatus: "OK",
    })) },
    { display: "GOLF", mode: "current", cue: "", ageLabel: "59 MIN OLD" },
  );

  const warned = atisDisplayContext.atisDisplayState(retainedAtisFixture(60, {
    atisLetter: "--",
    atisDisplay: "--",
    atisReportedPhonetic: "GOLF",
    atisSourceIsCurrent: false,
    atisFetchStatus: "WARN_SOURCE",
  }));
  assert.deepEqual(
    { ...warned },
    {
      display: "GOLF",
      mode: "last-reported",
      cue: "LAST REPORTED · NOT OPERATIONAL-CURRENT · 60 MIN OLD",
      ageLabel: "60 MIN OLD",
    },
  );

  const stale = atisDisplayContext.atisDisplayState(retainedAtisFixture(180, {
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "STALE_SOURCE",
  }));
  assert.deepEqual(
    { ...stale },
    {
      display: "GOLF",
      mode: "last-reported-stale",
      cue: "LAST REPORTED · NOT OPERATIONAL-CURRENT · STALE · 3H OLD",
      ageLabel: "3H OLD",
    },
  );
});

test("main board does not fabricate ATIS when no validated report is retained", () => {
  assert.deepEqual(
    { ...atisDisplayContext.atisDisplayState({
      atisLetter: "--",
      atisReportedLetter: "--",
      atisSourceIsCurrent: false,
      atisFetchStatus: "FAILED_NO_LAST_GOOD",
      atisAgeMinutes: null,
    }) },
    { display: "--", mode: "unavailable", cue: "", ageLabel: "AGE UNKNOWN" },
  );
  assert.match(indexHtml, /cue\.className="atis-letter-status"/);
  assert.match(indexHtml, /Operational ATIS fields remain suppressed/);
});

test("main board fails closed for inconsistent retained ATIS identity, timestamp, and current flags", () => {
  const unavailable = { display: "--", mode: "unavailable", cue: "", ageLabel: "AGE UNKNOWN" };
  for (const data of [
    retainedAtisFixture(20, { atisText: "D-ATIS unavailable", atisLetter: "G", atisSourceIsCurrent: true, atisFetchStatus: "OK" }),
    retainedAtisFixture(20, { atisObservedZ: "", atisLetter: "G", atisSourceIsCurrent: true, atisFetchStatus: "OK" }),
    retainedAtisFixture(20, { atisReportedLetter: "H", atisLetter: "H", atisSourceIsCurrent: true, atisFetchStatus: "OK" }),
    retainedAtisFixture(20, { atisLetter: "G", atisSourceIsCurrent: true, atisFetchStatus: "FAILED_NO_LAST_GOOD" }),
  ]) {
    assert.deepEqual({ ...atisDisplayContext.atisDisplayState(data) }, unavailable);
  }

  assert.equal(
    atisDisplayContext.atisDisplayState(retainedAtisFixture(180, {
      atisLetter: "G",
      atisSourceIsCurrent: true,
      atisFetchStatus: "OK",
    })).mode,
    "last-reported-stale",
    "an inconsistent current flag cannot bypass the 60-minute gate",
  );
  assert.match(indexHtml, /presentationSignature===signature\)return/);
  assert.match(indexHtml, /role="status" aria-live="polite" aria-atomic="true"/);
});

test("validated last-reported Lima keeps its runway evidence visible without promoting operational fields", () => {
  const lima = retainedAtisFixture(67, {
    atisText: "MEM ATIS INFO L 2053Z. 15010KT 10SM CLR 32/21 A3008. SIMUL VISUAL APCHS IN USE RY 18L, 18R. DEPG RWYS 18C. ADVS YOU HAVE INFO L",
    atisObservedZ: "2026-09-08T20:53:00Z",
    atisReportIdentity: "L:2053Z",
    atisReportedLetter: "L",
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "WARN_SOURCE",
    arrRunways: "--",
    depRunways: "--",
    atisReportedArrRunways: "18L / 18R",
    atisReportedDepRunways: "18C",
    atisReportedFlow: "SOUTH ↓",
  });

  assert.deepEqual(
    { ...atisDisplayContext.atisRunwayDisplayState(lima, "arrRunways", "atisReportedArrRunways") },
    {
      value: "18L / 18R",
      mode: "last-reported",
      cue: "LIMA · LAST RPTD · NOT CURRENT",
      atis: "LIMA",
    },
  );
  assert.deepEqual(
    { ...atisDisplayContext.atisRunwayDisplayState(lima, "depRunways", "atisReportedDepRunways") },
    {
      value: "18C",
      mode: "last-reported",
      cue: "LIMA · LAST RPTD · NOT CURRENT",
      atis: "LIMA",
    },
  );

  const updateSource = sourceBetween("function updateDetails", "function fitRawWeatherFontSize");
  assert.match(updateSource, /setAtisRunwayDisplay\("arrRwy",data,"arrRunways","atisReportedArrRunways","arrival"\)/);
  assert.match(updateSource, /setAtisRunwayDisplay\("depRwy",data,"depRunways","atisReportedDepRunways","departure"\)/);
  assert.match(updateSource, /setClosedRunwayDisplay\(data\.closedRunways\)/);
  assert.match(updateSource, /setAtisFlowDisplay\(data\)/);
  assert.match(indexHtml, /\.atis-runway-display\{overflow:visible;text-overflow:clip;overflow-wrap:normal\}/);
  assert.match(indexHtml, /\.atis-runway-cue\{[^}]*white-space:normal;[^}]*text-wrap:balance/);
});

test("FLOW retains validated last-reported ATIS context without becoming operational-current", () => {
  const current = retainedAtisFixture(59, {
    atisLetter: "G",
    atisSourceIsCurrent: true,
    atisFetchStatus: "OK",
    flow: "NORTH ↑",
    atisReportedFlow: "SOUTH ↓",
  });
  assert.deepEqual(
    { ...atisDisplayContext.atisFlowDisplayState(current) },
    { value: "NORTH ↑", mode: "current", cue: "", atis: "GOLF" },
    "a current ATIS uses only the operational flow field",
  );

  const warned = retainedAtisFixture(67, {
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "WARN_SOURCE",
    flow: "--",
    atisReportedFlow: "SOUTH ↓",
  });
  assert.deepEqual(
    { ...atisDisplayContext.atisFlowDisplayState(warned) },
    {
      value: "SOUTH ↓",
      mode: "last-reported",
      cue: "GOLF · LAST RPTD · NOT CURRENT",
      atis: "GOLF",
    },
  );

  const stale = retainedAtisFixture(180, {
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "STALE_SOURCE",
    flow: "--",
    atisReportedFlow: "MIXED",
  });
  assert.deepEqual(
    { ...atisDisplayContext.atisFlowDisplayState(stale) },
    {
      value: "MIXED",
      mode: "last-reported-stale",
      cue: "GOLF · LAST RPTD · NOT CURRENT",
      atis: "GOLF",
    },
  );
});

test("FLOW fails closed when retained ATIS evidence or the reported flow is invalid", () => {
  const invalidFixtures = [
    retainedAtisFixture(67, { atisObservedZ: "", atisReportedFlow: "SOUTH ↓" }),
    retainedAtisFixture(67, { atisReportedLetter: "H", atisReportedFlow: "SOUTH ↓" }),
    retainedAtisFixture(67, { atisFetchStatus: "FAILED_NO_LAST_GOOD", atisReportedFlow: "SOUTH ↓" }),
    retainedAtisFixture(67, { atisFetchStatus: "SOURCE_TIME_UNKNOWN", atisReportedFlow: "SOUTH ↓" }),
    retainedAtisFixture(67, { atisReportedFlow: "--" }),
    retainedAtisFixture(67, { atisReportedFlow: "SOUTHBOUND" }),
    retainedAtisFixture(67, { atisReportedFlow: "SOUTH ↑" }),
  ];
  for (const fixture of invalidFixtures) {
    assert.deepEqual(
      { ...atisDisplayContext.atisFlowDisplayState(fixture) },
      { value: "--", mode: "unavailable", cue: "", atis: fixture.atisReportedFlow === "--" || /SOUTHBOUND|SOUTH ↑/.test(fixture.atisReportedFlow || "") ? "GOLF" : "--" },
    );
  }

  assert.match(indexHtml, /id="flow" class="ops-value atis-flow-display" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(indexHtml, /\.atis-flow-cue\{[^}]*white-space:normal;[^}]*text-wrap:balance/);
  assert.match(indexHtml, /flow && !flow\.dataset\.presentationSignature && !flow\.querySelector\("\.flow-arrow"\)/);
});

test("current Mike wins runway display while stale or malformed retained evidence fails closed", () => {
  const mike = retainedAtisFixture(12, {
    atisText: "MEM ATIS INFO M 2148Z. 15010KT 10SM CLR 32/21 A3008. SIMUL VISUAL APCHS IN USE RY 18L, 18R. DEPG RWYS 18C. ADVS YOU HAVE INFO M",
    atisObservedZ: "2026-09-08T21:48:00Z",
    atisReportIdentity: "M:2148Z",
    atisReportedLetter: "M",
    atisLetter: "M",
    atisSourceIsCurrent: true,
    atisFetchStatus: "OK",
    arrRunways: "18L / 18R",
    depRunways: "18C",
    atisReportedArrRunways: "27",
    atisReportedDepRunways: "27",
  });
  assert.deepEqual(
    { ...atisDisplayContext.atisRunwayDisplayState(mike, "arrRunways", "atisReportedArrRunways") },
    { value: "18L / 18R", mode: "current", cue: "", atis: "MIKE" },
  );

  const stale = retainedAtisFixture(180, {
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "STALE_SOURCE",
    atisReportedArrRunways: "18L / 18R",
  });
  assert.equal(
    atisDisplayContext.atisRunwayDisplayState(stale, "arrRunways", "atisReportedArrRunways").mode,
    "last-reported-stale",
  );

  for (const invalid of [
    retainedAtisFixture(67, { atisObservedZ: "", atisReportedArrRunways: "18L / 18R" }),
    retainedAtisFixture(67, { atisReportedLetter: "H", atisReportedArrRunways: "18L / 18R" }),
    retainedAtisFixture(67, { atisFetchStatus: "FAILED_NO_LAST_GOOD", atisReportedArrRunways: "18L / 18R" }),
    retainedAtisFixture(67, { atisReportedArrRunways: "--" }),
    retainedAtisFixture(67, { atisReportedArrRunways: "RUNWAY EIGHTEEN LEFT" }),
  ]) {
    const state = atisDisplayContext.atisRunwayDisplayState(invalid, "arrRunways", "atisReportedArrRunways");
    assert.equal(state.value, "--");
    assert.equal(state.mode, "unavailable");
    assert.equal(state.cue, "");
  }
});

test("ATIS catch-up polling starts near the freshness boundary without changing the full-board cadence", () => {
  assert.equal(atisDisplayContext.atisCatchupNeeded(retainedAtisFixture(49, {
    atisLetter: "G",
    atisSourceIsCurrent: true,
    atisFetchStatus: "OK",
  })), false);
  assert.equal(atisDisplayContext.atisCatchupNeeded(retainedAtisFixture(50, {
    atisLetter: "G",
    atisSourceIsCurrent: true,
    atisFetchStatus: "OK",
  })), true);
  assert.equal(atisDisplayContext.atisCatchupNeeded(retainedAtisFixture(67, {
    atisLetter: "--",
    atisSourceIsCurrent: false,
    atisFetchStatus: "WARN_SOURCE",
  })), true);
  assert.match(indexHtml, /const WEATHER_REFRESH_SECONDS=300;/);
  assert.match(indexHtml, /const ATIS_CATCHUP_SECONDS=60;/);
  assert.match(indexHtml, /const WEATHER_FETCH_TIMEOUT_MS=15000;/);
  assert.match(indexHtml, /loadWeatherJson\(\{resetCountdown:false\}\)/);
  assert.match(indexHtml, /if\(resetCountdown\)refreshRemaining=WEATHER_REFRESH_SECONDS/);
  assert.match(indexHtml, /if\(refreshRemaining<=0&&!weatherFetchResetsCountdown\)fullRefreshPending=true/);
  assert.match(indexHtml, /if\(fullRefreshPending\)\{[\s\S]*queueMicrotask\(refreshActiveData\)/);
  assert.match(indexHtml, /setTimeout\(\(\)=>controller\.abort\(\),WEATHER_FETCH_TIMEOUT_MS\)/);
  assert.match(indexHtml, /cue\.setAttribute\("aria-hidden","true"\)/);
  assert.match(indexHtml, /const signature=\[state\.mode,state\.display,description\]\.join\("\|"\)/);
});
