import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const toolHtml = readFileSync(new URL("../flight-plan.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../flight-plan-app.js", import.meta.url), "utf8");

test("board preserves both existing controls and adds globe between them", () => {
  assert.match(indexHtml, /const DISPLAY_CONTROL_URL="\.\/display_control\.html"/);
  assert.match(indexHtml, /const HAZARD_CONTROL_URL="\.\/control\.html"/);
  assert.match(indexHtml, /const FLIGHT_PLAN_URL="\.\/flight-plan\.html"/);
  assert.match(indexHtml, /hazard\.textContent="⚡"/u);
  assert.match(indexHtml, /flightPlan\.textContent="🌐"/u);
  assert.match(indexHtml, /display\.textContent="⚙️"/u);

  const hazardAppend = indexHtml.indexOf("wrap.appendChild(hazard)");
  const globeAppend = indexHtml.indexOf("wrap.appendChild(flightPlan)");
  const displayAppend = indexHtml.indexOf("wrap.appendChild(display)");
  assert.ok(hazardAppend > 0 && hazardAppend < globeAppend && globeAppend < displayAppend);
  assert.match(indexHtml, /fetch\("weather\.json\?t="/);
});

test("landing page initially chooses neither workflow", () => {
  assert.match(toolHtml, /id="landingScreen"(?![^>]*\shidden)[^>]*>/);
  assert.match(toolHtml, /id="uploadScreen"[^>]*\shidden/);
  assert.match(toolHtml, /id="workspace"[^>]*\shidden/);
  assert.match(toolHtml, />UPLOAD DD1801</);
  assert.match(toolHtml, />MANUAL ENTRY</);
  assert.match(appJs, /mode:\s*null/);
  assert.match(appJs, /plan:\s*createBlankFlightPlan\(\)/);
});

test("manual form includes only operational DD1801 Items 7 through 19", () => {
  const legends = [...toolHtml.matchAll(/<legend><span>ITEM (\d+)<\/span>/g)].map(
    match => Number(match[1]),
  );
  assert.deepEqual(legends, [7, 8, 9, 10, 13, 15, 16, 18, 19]);
  assert.doesNotMatch(toolHtml, /ITEM (?:11|12|14|17)/);
  assert.doesNotMatch(toolHtml, /pilot in command|approving authority|home station|filing official/i);
});

test("Item 10a and 10b are separate blank controls", () => {
  assert.equal((toolHtml.match(/data-path="item10\.equipment"/g) || []).length, 1);
  assert.equal((toolHtml.match(/data-path="item10\.surveillance"/g) || []).length, 1);
  assert.doesNotMatch(
    toolHtml,
    /data-path="item10\.(?:equipment|surveillance)"[^>]*\svalue="[^"]+"/,
  );
  assert.match(toolHtml, /generator inserts exactly one slash/i);
});

test("route, output, rejection, and reset controls are present", () => {
  for (const id of [
    "validateRouteButton",
    "undoRouteButton",
    "generateButton",
    "copyButton",
    "editButton",
    "resetButton",
    "rejectionResponse",
  ]) {
    assert.match(toolHtml, new RegExp(`id="${id}"`));
  }
  assert.match(toolHtml, /LOCAL ROUTE FORMAT CHECK ONLY/);
  assert.match(toolHtml, /DOES NOT VERIFY AIRSPACE, RAD, IFPS, OR EUROCONTROL RESTRICTIONS/);
  assert.match(toolHtml, /Item 19 is not appended/i);
  assert.match(toolHtml, /id="copyButton"[^>]*\sdisabled/);
  assert.match(appJs, /dom\.copyButton\.disabled = isStale/);
  assert.match(appJs, /normalizedPlanSnapshot\(\) !== state\.generatedPlanSnapshot/);
});

test("destructive state is cleared and navigation receives an unload warning", () => {
  assert.match(appJs, /dom\.importSourceBadge\.textContent = ""/);
  assert.match(appJs, /dom\.importSummary\.replaceChildren\(\)/);
  assert.match(appJs, /dom\.importFlags\.replaceChildren\(\)/);
  assert.match(appJs, /dom\.structuralStatusDetails\.replaceChildren\(\)/);
  assert.match(appJs, /dom\.pdfFileInput\.value = ""/);
  assert.match(appJs, /dom\.modeDescription\.textContent = ""/);
  assert.match(appJs, /dom\.uploadProgressLabel\.textContent = ""/);
  assert.match(appJs, /dom\.uploadStatus\.textContent = ""/);
  assert.match(appJs, /window\.addEventListener\("beforeunload"/);
  assert.match(appJs, /if \(!hasCurrentData\(\)\) return/);
});

test("flight-plan code has no persistence or external submission path", () => {
  const combined = `${toolHtml}\n${appJs}`;
  assert.doesNotMatch(combined, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(combined, /<form[^>]+action=|fetch\(|XMLHttpRequest|WebSocket/);
  assert.match(toolHtml, /No PDF or flight-plan data is uploaded, transmitted, or saved/);
  assert.match(toolHtml, /OCR is not used/);
});
