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

test("unknown runway state is amber and does not use the flashing closure class", () => {
  assert.match(indexHtml, /\.closed-unknown\{color:var\(--warning\)\}/);
  assert.match(
    sourceBetween("function setClosedRunwayDisplay", "function formatAhasBwcDateTime"),
    /closed==="UNKNOWN"[\s\S]*classList\.add\("closed-unknown"\)[\s\S]*textContent="UNKNOWN"/,
  );
});
