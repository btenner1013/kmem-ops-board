import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";


const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const fixedNow = Date.parse("2026-08-28T04:00:00Z");


function sourceBetween(startMarker, endMarker) {
  const start = indexHtml.indexOf(startMarker);
  const end = indexHtml.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return indexHtml.slice(start, end);
}


const context = vm.createContext({
  getBoardNowMs: () => fixedNow,
  parseUpdatedZ: value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  },
});
vm.runInContext(
  sourceBetween("function hostHeartbeatState", "function updateSourceHealth") +
    "globalThis.hostHeartbeatState=hostHeartbeatState;" +
    "globalThis.renderHostHealth=renderHostHealth;",
  context,
);


function timestampMinutesAgo(minutes, extraSeconds = 0) {
  return new Date(fixedNow - minutes * 60000 - extraSeconds * 1000).toISOString();
}


function stateAt(minutes, overrides = {}, extraSeconds = 0) {
  return {
    ...context.hostHeartbeatState(
      {
        activeRole: "PRIMARY",
        heartbeatUtc: timestampMinutesAgo(minutes, extraSeconds),
        codeSyncStatus: "CURRENT",
        ...overrides,
      },
      fixedNow,
    ),
  };
}


function renderHost(data) {
  const classes = [];
  const element = {
    className: "",
    textContent: "",
    title: "",
    classList: { add: value => classes.push(value) },
  };
  context.document = {
    getElementById: id => id === "hostHealth" ? element : null,
  };
  context.renderHostHealth(data);
  return { element, classes };
}


test("host heartbeat uses exact 15- and 25-minute boundaries", () => {
  assert.equal(stateAt(0).status, "OK");
  assert.equal(stateAt(15).status, "OK");

  const delayed16 = stateAt(15, {}, 1);
  assert.equal(delayed16.status, "DELAYED");
  assert.equal(delayed16.detail, "16M");
  assert.equal(stateAt(25).status, "DELAYED");

  const missing26 = stateAt(25, {}, 1);
  assert.equal(missing26.status, "NO_HEARTBEAT");
  assert.equal(missing26.detail, "26M");
  assert.equal(stateAt(60).status, "NO_HEARTBEAT");
});


test("host heartbeat handles missing, malformed, and future timestamps safely", () => {
  for (const heartbeatUtc of [null, "", "not-a-time", "2026-08-28T04:01:00Z"]) {
    const state = {
      ...context.hostHeartbeatState({ activeRole: "PRIMARY", heartbeatUtc }, fixedNow),
    };
    assert.equal(state.status, "NO_HEARTBEAT");
    assert.equal(state.age, null);
  }
});


test("host heartbeat accepts only generic PRIMARY and BACKUP roles", () => {
  assert.equal(stateAt(5).role, "PRIMARY");
  assert.equal(stateAt(5, { activeRole: "BACKUP" }).role, "BACKUP");

  for (const activeRole of [null, "", "NONE", "DESKTOP-123", "PRIMARY-LAPTOP"]) {
    const state = stateAt(5, { activeRole });
    assert.equal(state.status, "NO_HEARTBEAT", String(activeRole));
    assert.equal(state.role, "NONE", String(activeRole));
    assert.equal(state.reason, "INVALID_ROLE", String(activeRole));
  }

  const rendered = renderHost({
    activeRole: "DESKTOP-123",
    heartbeatUtc: timestampMinutesAgo(5),
    codeSyncStatus: "CURRENT",
  });
  assert.equal(rendered.element.textContent, "HOST NO HEARTBEAT");
  assert.deepEqual(rendered.classes, ["host-no-heartbeat"]);
});


test("recent blocked code sync is distinct from feed and heartbeat age", () => {
  assert.equal(
    stateAt(5, { codeSyncStatus: "BLOCKED_DIRTY_WORKTREE" }).status,
    "CODE_SYNC_BLOCKED",
  );
  assert.equal(
    stateAt(26, { codeSyncStatus: "BLOCKED_DIRTY_WORKTREE" }).status,
    "NO_HEARTBEAT",
  );
});


test("host status fetch remains supplemental to weather and feed state", () => {
  assert.match(indexHtml, /id="hostHealth"/);
  assert.match(
    sourceBetween("async function refreshActiveData", "updateClock();"),
    /Promise\.allSettled\(\[loadWeatherJson\(\),loadHostStatus\(\)\]\)/,
  );
  assert.doesNotMatch(
    sourceBetween("function updateSourceHealth", "function parseCaoDate"),
    /hostHeartbeat|host_status/i,
  );
  assert.match(indexHtml, /const WEATHER_REFRESH_SECONDS=300;/);
});


test("desktop and Getac footer grids preserve intrinsic edge content", () => {
  assert.match(
    indexHtml,
    /<div class="footer-left"><span id="hostHealth"[^>]*>HOST NO HEARTBEAT<\/span><span class="feed-sep">\|<\/span><span class="data-updated-compact">DATA UPDATED:/,
  );
  assert.match(
    indexHtml,
    /\.footer\{\s*display:grid;\s*grid-template-columns:max-content minmax\(0,1fr\) max-content;/,
  );
  assert.match(
    indexHtml,
    /body\.getac-preset \.footer\{[^}]*grid-template-columns:max-content minmax\(0,1fr\) max-content !important;/,
  );
});
