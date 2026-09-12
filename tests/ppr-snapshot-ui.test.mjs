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
  assert.doesNotMatch(combined, /SharePoint|generated at|file name|download|export/i);
  assert.match(appJs, /localCsvText = await file\.text\(\)[\s\S]*?parsePprSnapshotCsv\(localCsvText\)/);
  assert.match(appJs, /finally\s*{[\s\S]*?localCsvText = null/);
  assert.doesNotMatch(appJs, /session\.rawCsvText/);
  assert.match(appJs, /session\.snapshotText = buildPprSnapshotText\(allowedRecords\)/);
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
  assert.match(clearBody, /session\.snapshotText = ""/);
  assert.match(clearBody, /session\.rimText = ""/);
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

test("entry rendering is staged off-DOM and failures clear the visible snapshot", () => {
  assert.match(appJs, /const stagedCards = document\.createElement\("div"\)/);
  assert.match(appJs, /stagedCards\.append\(renderPprCard\(allowedRecord\)\)/);
  assert.match(appJs, /dom\.cards\.replaceChildren\(\.\.\.stagedCards\.children\)/);
  assert.match(
    appJs,
    /catch \(error\)[\s\S]*?releasePprSession\(\{ showImport: true \}\)[\s\S]*?dom\.importStatus\.textContent = message/,
  );
});

test("screenshot mode exposes only the white board heading and rendered entries", () => {
  const snapshotHtml = toolHtml.match(/<section id="snapshotBoard"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(toolHtml, /id="snapshotTitle">CURRENT PPR SNAPSHOT</);
  assert.match(toolHtml, /id="pprCards" class="ppr-entry-grid"/);
  assert.match(toolHtml, /id="rimSection" class="rim-section"/);
  assert.match(toolHtml, /id="rimLines" class="rim-lines"/);
  assert.match(toolHtml, /id="snapshotModeButton"[^>]*>SCREENSHOT VIEW</);
  assert.match(appJs, /document\.body\.classList\.add\("is-snapshot-mode"\)/);
  assert.match(toolCss, /body\.is-snapshot-mode \.tool-header,[\s\S]*body\.is-snapshot-mode \.session-controls,[\s\S]*body\.is-snapshot-mode \.rim-section\s*{[\s\S]*display:\s*none !important/);
  assert.match(toolCss, /body\.is-snapshot-mode \.snapshot-board\s*{[\s\S]*min-height:\s*100vh/);
  assert.match(toolCss, /--paper:\s*#ffffff/);
  assert.doesNotMatch(snapshotHtml, /RIM SLIDE LINES|COPY|EXPORT|DOWNLOAD|GENERATED AT|ROW COUNT|FILE NAME|PRIVACY/i);
});

test("main snapshot has one explicit plain-text copy control outside screenshot mode", () => {
  assert.match(toolHtml, /id="copySnapshotButton"[^>]*>COPY SNAPSHOT</);
  assert.match(toolHtml, /id="copySnapshotStatus"[^>]*aria-live="polite"/);
  assert.match(appJs, /buildPprSnapshotText\(allowedRecords\)/);
  assert.match(appJs, /navigator\.clipboard\.writeText\(session\.snapshotText\)/);
  assert.match(toolCss, /body\.is-snapshot-mode \.session-controls[\s\S]*display:\s*none !important/);
});

test("approved and cancelled entries use compact dot-plus-text status lines", () => {
  assert.match(appJs, /cancelled \? "🔴" : "🟢"/u);
  assert.match(appJs, /cancelled \? "CANCELLED" : "APPROVED"/);
  assert.match(appJs, /article\.className = `ppr-entry \$\{cancelled \? "is-cancelled" : "is-approved"\}`/);
  assert.match(appJs, /"span", "status-dot"/);
  assert.match(toolCss, /\.ppr-entry\.is-approved \.status-label\s*{[\s\S]*color:\s*var\(--ops-green-dark\)/);
  assert.match(toolCss, /\.ppr-entry\.is-cancelled \.status-label\s*{[\s\S]*color:\s*var\(--cancel-red-dark\)/);
  assert.match(appJs, /aria-label[\s\S]*Cancelled or denied[\s\S]*Approved/);
});

test("snapshot entries are plain copy-sheet rows rather than dashboard cards", () => {
  const entryRule = toolCss.match(/\.ppr-entry\s*{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(entryRule, /min-width:\s*0/);
  assert.match(entryRule, /padding:[^;]+/);
  assert.match(entryRule, /border-bottom:\s*1px solid/);
  assert.doesNotMatch(entryRule, /border-left|border-radius|box-shadow|background:\s*var\(--(?:ops-green|cancel-red)-soft\)/);
  assert.doesNotMatch(toolCss, /\.timing-block\s*{[\s\S]*?(?:border|background):/);
  assert.doesNotMatch(toolCss, /\.card-status\s*{[\s\S]*background:/);
});

test("RIM section is approved-only plain text with one explicit copy control", () => {
  const rimHtml = toolHtml.match(/<section id="rimSection"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(rimHtml, />RIM SLIDE LINES</);
  assert.match(rimHtml, /id="rimLines"/);
  assert.match(rimHtml, /id="copyRimLinesButton"[^>]*>COPY RIM LINES</);
  assert.match(rimHtml, /id="copyRimStatus"[^>]*aria-live="polite"/);
  assert.match(appJs, /buildRimSlideLines\(allowedRecords\)/);
  assert.match(appJs, /navigator\.clipboard\.writeText\(session\.rimText\)/);
  assert.doesNotMatch(rimHtml, /DOWNLOAD|EXPORT/i);
  assert.match(toolCss, /\.rim-lines\s*{[\s\S]*min-width:\s*0/);
  const rimLineRule = toolCss.match(/\.rim-line\s*{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(rimLineRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rimLineRule, /border-radius|box-shadow|background:/);
});

test("snapshot uses one compact monospaced column and protects long text from overflow", () => {
  assert.match(toolCss, /:root\s*{[\s\S]*font-family:\s*ui-monospace/);
  assert.match(toolCss, /\.ppr-entry-grid\s*{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.doesNotMatch(toolCss, /grid-template-columns:\s*repeat\(2/);
  assert.match(toolCss, /html,[\s\S]*body\s*{[\s\S]*overflow-x:\s*hidden/);
  assert.match(toolCss, /\.ppr-entry\s*{[\s\S]*min-width:\s*0/);
  assert.match(toolCss, /\.notes-line\s*{[\s\S]*margin-top:/);
  assert.match(toolCss, /\.rim-line\s*{[\s\S]*overflow-wrap:\s*anywhere/);
});
