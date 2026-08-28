import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../flight-plan.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../flight-plan-app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../flight-plan.css", import.meta.url), "utf8");
const core = readFileSync(new URL("../flight-plan-aisr.js", import.meta.url), "utf8");
const probe = readFileSync(new URL("../aisr-dom-probe.js", import.meta.url), "utf8");

test("AISR Assistant is obvious but unavailable until a working plan exists", () => {
  assert.match(html, /id="landingAisrButton"[^>]*disabled[^>]*>AISR ASSISTANT<\/button>/);
  const workspaceActions = html.match(/<div class="workspace-actions"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(workspaceActions, /id="aisrAssistantButton"[^>]*disabled[^>]*>AISR ASSISTANT<\/button>/);
  assert.ok(workspaceActions.indexOf("aisrAssistantButton") < workspaceActions.indexOf("workspaceUploadButton"));
  assert.match(app, /function updateAisrAvailability\(\)[\s\S]*?aisrAssistantButton\.disabled = !hasWorkingData\(state\.plan\)/);
  assert.match(app, /function markPlanEdited\(\)[\s\S]*?updateAisrAvailability\(\)[\s\S]*?renderAisrReview\(\)/);
});

test("focused AISR review panel exposes mapping, provenance, readiness, and close behavior", () => {
  const panel = html.match(/<section id="aisrAssistantPanel"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(panel, /aria-labelledby="aisrAssistantTitle"[^>]*hidden/);
  assert.match(panel, /AISR review \/ mapping/i);
  for (const heading of ["AISR FIELD", "VALUE", "SOURCE", "STATUS", "COPY"]) {
    assert.match(panel, new RegExp(`>${heading}<`));
  }
  assert.match(panel, /C-17 MIL IFR PRESET/);
  assert.match(panel, /FPL · I — IFR · M — Military · C17 · H — Heavy/);
  assert.match(app, /function openAisrAssistant\(\)[\s\S]*?renderAisrReview\(\)[\s\S]*?aisrAssistantPanel\.hidden = false/);
  assert.match(app, /function closeAisrAssistant\(\)[\s\S]*?aisrAssistantPanel\.hidden = true[\s\S]*?aisrAssistantButton\.focus\(\)/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /normalizeAisrPlan\(state\.plan, \{[\s\S]*?importResult: state\.importResult,[\s\S]*?manuallyEditedPaths: state\.manuallyEditedPaths/);
  assert.match(app, /from flight plan.*from C-17 preset.*manual.*conflict.*invalid field.*validation error.*validation warning/s);
  assert.match(app, /manuallyEditedPaths\.add\(control\.dataset\.path\)/);
  assert.match(app, /const hasInvalid = summary\.invalid > 0 \|\| summary\.structuralErrors > 0/);
});

test("AISR review provides per-field and bulk copy controls without a filing action", () => {
  for (const id of [
    "copyAisrRouteButton",
    "copyAisrField10Button",
    "copyAisrField18Button",
    "copyAisrDataButton",
    "copyAisrPayloadButton",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /copyButton\.setAttribute\("aria-label", `Copy AISR \$\{field\.label\}`\)/);
  assert.match(app, /formatAisrSummary\(state\.aisrReview\)/);
  assert.match(app, /serializeAisrTransferPayload\(state\.aisrReview\)/);
  assert.match(app, /`\$\{equipment\}\/\$\{surveillance\}`/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(?:FILE|SCHEDULE\s*\/\s*FILE|SUBMIT)\s*<\/button>/i);
  assert.doesNotMatch(app, /\.submit\(|requestSubmit\(|auto.?fil/i);
});

test("AISR autofill status is explicit and selector guesses are absent", () => {
  assert.match(html, /AISR DOM NOT YET VERIFIED — AUTOFILL NOT CLAIMED/);
  assert.match(html, /href="\.\/aisr-dom-probe\.js"/);
  assert.match(html, /populate-only/i);
  assert.match(core, /filingAllowed/);
  assert.doesNotMatch(core, /querySelector|getElementById|\bselector\s*:/i);
});

test("read-only AISR DOM probe gathers metadata but never field contents or session data", () => {
  for (const metadata of [
    "label[for]",
    "input, select, textarea, button",
    "getAttribute(\"name\")",
    "getAttribute(\"type\")",
    "querySelectorAll(\"option\")",
    "getAttribute(\"value\")",
    "controlIndexes",
  ]) {
    assert.ok(probe.includes(metadata), `probe must include ${metadata}`);
  }
  assert.doesNotMatch(probe, /document\.cookie|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|\.submit\(|requestSubmit\(|\.click\(/);
  assert.doesNotMatch(probe, /control\.value|input\.value|textarea\.value|selectedOptions/);
  assert.match(probe, /does not read user-entered[\s\S]*credentials[\s\S]*tokens[\s\S]*sessions/i);
});

test("AISR integration remains local and nonpersistent", () => {
  const combined = `${html}\n${app}\n${core}\n${probe}`;
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|postMessage\(/);
  assert.doesNotMatch(app, /fetch\(/);
  assert.doesNotMatch(html, /<form[^>]+action=/);
  assert.match(html, /The user must review AISR and manually file/);
  assert.match(css, /\.aisr-panel\s*{/);
  assert.match(css, /\.aisr-review-table\s*{/);
  assert.match(css, /\.aisr-status\.is-conflict\s*{/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.aisr-copy-actions/);
});
