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
  assert.match(bwcSource, /age\.id="bwcAge"/);
  assert.match(bwcSource, /window\.kmemUpdateBwcAge\?\.\(true\)/);
  assert.doesNotMatch(indexHtml, /\.bwc-stamp\{ display:none !important; \}/);
  assert.match(indexHtml, /\.bwc-age/);
});
