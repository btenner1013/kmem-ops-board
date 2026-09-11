import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const toolHtml = readFileSync(new URL("../ppr-snapshot.html", import.meta.url), "utf8");
const toolCss = readFileSync(new URL("../ppr-snapshot.css", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../ppr-snapshot.js", import.meta.url), "utf8");

test("calendar quick link opens the dedicated PPR Snapshot page", () => {
  assert.match(indexHtml, /const PPR_SNAPSHOT_URL="\.\/ppr-snapshot\.html"/);
  assert.match(indexHtml, /pprSnapshot\.href=PPR_SNAPSHOT_URL/);
  assert.match(indexHtml, /pprSnapshot\.rel="noopener"/);
  assert.match(indexHtml, /pprSnapshot\.title="PPR Snapshot"/);
  assert.match(indexHtml, /pprSnapshot\.setAttribute\("aria-label","Open PPR Snapshot"\)/);
  assert.match(indexHtml, /pprSnapshot\.textContent="🗓️"/u);
  assert.match(indexHtml, /wrap\.appendChild\(pprSnapshot\)/);
});

test("page enforces a same-origin static asset policy and blocks runtime connections", () => {
  const csp = toolHtml.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /worker-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(toolHtml, /name="robots" content="noindex,nofollow,noarchive"/);
  assert.doesNotMatch(toolHtml, /https?:\/\//i);
  assert.doesNotMatch(`${toolHtml}\n${appJs}`, /<form\b|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/i);
});

test("PPR data has no application persistence, cache, filesystem, or download path", () => {
  const combined = `${toolHtml}\n${appJs}`;
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|IDBDatabase|CacheStorage|caches\s*\.|serviceWorker/i);
  assert.doesNotMatch(combined, /showOpenFilePicker|showSaveFilePicker|FileSystemFileHandle|createObjectURL|download\s*=|new\s+Blob/i);
  assert.doesNotMatch(combined, /\.submit\s*\(|requestSubmit\s*\(/);
  assert.doesNotMatch(combined, /window\.print|@media\s+print/i);
  assert.match(appJs, /localCsvText = await file\.text\(\)[\s\S]*?parsePprSnapshotCsv\(localCsvText\)/);
  assert.match(appJs, /finally\s*{[\s\S]*?localCsvText = null/);
  assert.doesNotMatch(appJs, /session\.rawCsvText/);
});

test("one local CSV picker and drag-and-drop share the same in-memory loader", () => {
  const fileInput = toolHtml.match(/<input id="pprCsvInput"[^>]*>/)?.[0] ?? "";
  assert.match(fileInput, /type="file"/);
  assert.match(fileInput, /accept="\.csv,text\/csv"/);
  assert.doesNotMatch(fileInput, /\smultiple(?:\s|=|>)/);
  assert.match(appJs, /dom\.fileInput\.addEventListener\("change"[\s\S]*?loadCsvFile\(files\[0\]\)/);
  assert.match(appJs, /dom\.dropZone\.addEventListener\("drop"[\s\S]*?loadCsvFile\(files\[0\]\)/);
  assert.equal((appJs.match(/async function loadCsvFile\(/g) || []).length, 1);
});

test("rendering uses an explicit allowlist and text nodes rather than raw CSV or HTML", () => {
  assert.match(appJs, /const DISPLAY_FIELDS = Object\.freeze\(\[/);
  for (const field of [
    "status", "pprNumber", "callsign", "aircraftType", "requestType", "origin", "destination",
    "arrival", "departure", "homeStation", "tailNumbers", "vipCode", "fuel", "transportation",
    "passengers", "specialRequirements", "hazmat", "notes", "estimatedScope",
  ]) assert.match(appJs, new RegExp(`"${field}"`));
  assert.match(appJs, /element\.textContent = String\(value \?\? ""\)/);
  assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(appJs, /textContent\s*=\s*localCsvText|append\([^\n]*localCsvText/);
  assert.doesNotMatch(appJs, /Object\.(?:entries|keys|values)\(record\)/);
});

test("clear and navigation release raw text, normalized records, card DOM, and file input", () => {
  const clearBody = appJs.slice(
    appJs.indexOf("function releasePprSession"),
    appJs.indexOf("function setBusy"),
  );
  assert.match(clearBody, /session\.records = \[\]/);
  assert.match(clearBody, /session\.loadEpoch \+= 1/);
  assert.match(clearBody, /dom\.cards\.replaceChildren\(\)/);
  assert.match(clearBody, /dom\.fileInput\.value = ""/);
  assert.match(appJs, /dom\.clearButton\.addEventListener\("click"[\s\S]*?releasePprSession\(\)/);
  assert.match(appJs, /dom\.loadAnotherButton\.addEventListener\("click"[\s\S]*?releasePprSession\(\)/);
  assert.match(appJs, /window\.addEventListener\("pagehide"[\s\S]*?releasePprSession/);
  assert.match(appJs, /window\.addEventListener\("beforeunload"[\s\S]*?releasePprSession/);
  assert.match(appJs, /window\.addEventListener\("pageshow"[\s\S]*?event\.persisted[\s\S]*?releasePprSession/);
  assert.match(appJs.trimEnd(), /releasePprSession\(\{ showImport: true \}\);$/);
  assert.match(appJs, /const loadEpoch = session\.loadEpoch[\s\S]*?await file\.text\(\)[\s\S]*?loadEpoch !== session\.loadEpoch/);
});

test("card rendering is staged off-DOM and failures clear the visible snapshot", () => {
  assert.match(appJs, /const stagedCards = document\.createElement\("div"\)/);
  assert.match(appJs, /stagedCards\.append\(renderPprCard\(allowedRecord\)\)/);
  assert.match(appJs, /dom\.cards\.replaceChildren\(\.\.\.stagedCards\.children\)/);
  assert.match(
    appJs,
    /catch \(error\)[\s\S]*?releasePprSession\(\{ showImport: true \}\)[\s\S]*?dom\.importStatus\.textContent = message/,
  );
});

test("screenshot mode exposes only the white board heading and rendered cards", () => {
  const snapshotHtml = toolHtml.match(/<section id="snapshotBoard"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(toolHtml, /id="snapshotTitle">CURRENT PPR SNAPSHOT</);
  assert.match(toolHtml, /id="pprCards" class="ppr-card-grid"/);
  assert.match(toolHtml, /id="snapshotModeButton"[^>]*>SCREENSHOT VIEW</);
  assert.match(appJs, /document\.body\.classList\.add\("is-snapshot-mode"\)/);
  assert.match(toolCss, /body\.is-snapshot-mode \.tool-header,[\s\S]*body\.is-snapshot-mode \.session-controls\s*{[\s\S]*display:\s*none !important/);
  assert.match(toolCss, /body\.is-snapshot-mode \.snapshot-board\s*{[\s\S]*min-height:\s*100vh/);
  assert.match(toolCss, /--paper:\s*#ffffff/);
  assert.doesNotMatch(snapshotHtml, /EXPORT|DOWNLOAD|GENERATED AT|ROW COUNT|FILE NAME|PRIVACY/i);
});

test("approved and cancelled cards use explicit text plus distinct accessible styling", () => {
  assert.match(appJs, /cancelled \? "CANCELLED \/ DENIED" : "APPROVED - EMAIL SENT"/);
  assert.match(appJs, /is-cancelled" : "is-approved/);
  assert.match(toolCss, /\.ppr-card\.is-approved\s*{[\s\S]*--status-color:\s*var\(--ops-green\)/);
  assert.match(toolCss, /\.ppr-card\.is-cancelled\s*{[\s\S]*--status-color:\s*var\(--cancel-red\)/);
  assert.match(appJs, /aria-label[\s\S]*Cancelled or denied[\s\S]*Approved/);
});

test("responsive board uses two desktop columns, one mobile column, and prevents page overflow", () => {
  assert.match(toolCss, /\.ppr-card-grid\s*{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(toolCss, /@media \(max-width: 720px\)[\s\S]*\.ppr-card-grid,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(toolCss, /html,[\s\S]*body\s*{[\s\S]*overflow-x:\s*hidden/);
  assert.match(toolCss, /\.ppr-card\s*{[\s\S]*min-width:\s*0[\s\S]*overflow:\s*hidden/);
  assert.match(toolCss, /overflow-wrap:\s*anywhere/);
});
