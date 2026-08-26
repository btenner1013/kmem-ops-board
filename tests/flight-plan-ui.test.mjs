import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIELD_PATHS } from "../flight-plan-core.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const toolHtml = readFileSync(new URL("../flight-plan.html", import.meta.url), "utf8");
const toolCss = readFileSync(new URL("../flight-plan.css", import.meta.url), "utf8");
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

test("desktop form follows the DD1801 row hierarchy and stacks on phones", () => {
  assert.match(toolHtml, /<div class="dd1801-layout">/);
  for (const item of [7, 8, 9, 10, 13, 15, 16, 18, 19]) {
    assert.match(toolHtml, new RegExp(`class="[^"]*item${item}-section[^"]*"`));
  }
  assert.match(
    toolCss,
    /grid-template-areas:\s*"item7 item8"\s*"item9 item10"\s*"item13 item13"\s*"item15 item15"\s*"item16 item16"\s*"item18 item18"\s*"item19 item19"/,
  );
  assert.match(
    toolCss,
    /@media \(max-width: 680px\)[\s\S]*grid-template-areas:\s*"item7"\s*"item8"\s*"item9"\s*"item10"\s*"item13"\s*"item15"\s*"item16"\s*"item18"\s*"item19"/,
  );
});

test("Item 15 presents speed, level, and route in one DD1801 row", () => {
  const item15Start = toolHtml.indexOf('<fieldset class="dd-section route-section item15-section">');
  const item15End = toolHtml.indexOf("</fieldset>", item15Start);
  const item15Html = toolHtml.slice(item15Start, item15End);

  assert.match(item15Html, /class="field-grid item15-layout"/);
  assert.ok(item15Html.indexOf('id="cruisingSpeed"') < item15Html.indexOf('id="level"'));
  assert.ok(item15Html.indexOf('id="level"') < item15Html.indexOf('id="route"'));
});

test("Item 19 preserves the authoritative DD1801 row order without UX cards", () => {
  const item19Start = toolHtml.indexOf('<fieldset class="dd-section item19-section">');
  const item19End = toolHtml.indexOf("</fieldset>", item19Start);
  const item19Html = toolHtml.slice(item19Start, item19End);
  const item19UiPaths = [...item19Html.matchAll(/data-path="(item19\.[^"]+)"/g)]
    .map(match => match[1]);
  const item19ModelPaths = FIELD_PATHS.filter(path => path.startsWith("item19."));

  assert.equal(item19UiPaths.length, item19ModelPaths.length);
  assert.deepEqual([...new Set(item19UiPaths)].sort(), [...item19ModelPaths].sort());
  assert.doesNotMatch(item19Html, /supplement-(?:grid|card)/);
  assert.doesNotMatch(item19Html, />\s*(?:Carried|UHF|VHF|OTHER)\s*</i);
  assert.doesNotMatch(toolCss, /\.supplement-card\b/);
  assert.doesNotMatch(
    appJs,
    /Life-jacket (?:UHF|VHF)|Other emergency radio|Life jackets carried|Dinghies carried/,
  );
  const summaryBand = item19Html.indexOf('class="item19-band item19-summary-row"');
  const equipmentBand = item19Html.indexOf('class="item19-band item19-equipment-band"');
  const dinghyBand = item19Html.indexOf('class="item19-band item19-dinghy-band"');
  const lowerBand = item19Html.indexOf('class="item19-band item19-lower-band"');
  assert.ok(summaryBand < equipmentBand && equipmentBand < dinghyBand && dinghyBand < lowerBand);
  assert.match(
    item19Html,
    /class="item19-band item19-summary-row"[\s\S]*ENDURANCE \/ FUEL[\s\S]*PERSONS ON BOARD[\s\S]*EMERGENCY AND SURVIVAL EQUIPMENT[\s\S]*class="item19-band item19-equipment-band"/,
  );
  assert.match(
    item19Html,
    /class="item19-band item19-equipment-band"[\s\S]*TYPE OF EQUIPMENT[\s\S]*LIFE JACKETS[\s\S]*RADIO FREQUENCY[\s\S]*class="item19-band item19-dinghy-band"/,
  );
  assert.match(
    item19Html,
    /class="item19-band item19-dinghy-band"[\s\S]*DINGHIES[\s\S]*COVER \/ COLOR[\s\S]*NUMBER \/ CAPACITY[\s\S]*RMK\/[\s\S]*class="item19-band item19-lower-band"/,
  );
  assert.match(
    item19Html,
    /class="item19-band item19-lower-band"[\s\S]*REMARKS[\s\S]*AIRCRAFT SERIAL NUMBERS AND TYPE OF AIRCRAFT IN FLIGHT/,
  );

  for (const label of [
    "TYPE OF EQUIPMENT",
    "JACKETS",
    "LIGHT",
    "FLUORESCEIN",
    "RADIO FREQUENCY",
    "DINGHIES",
    "COVER",
    "NUMBER",
    "CAPACITY",
    "COLOR",
    "RMK/",
    "REMARKS",
    "AIRCRAFT SERIAL NUMBER",
    "AIRCRAFT TYPE",
  ]) {
    assert.match(item19Html, new RegExp(`>${label.replace("/", "\\/")}<`));
  }

  assert.match(
    toolCss,
    /\.item19-summary-row\s*{[\s\S]*grid-template-columns:\s*minmax\(0, 23fr\) minmax\(0, 24fr\) minmax\(0, 53fr\)/,
  );
  assert.match(
    toolCss,
    /\.item19-equipment-band\s*{[\s\S]*grid-template-columns:\s*minmax\(0, 42fr\) minmax\(0, 30fr\) minmax\(0, 28fr\)/,
  );
  assert.match(
    toolCss,
    /\.item19-dinghy-band\s*{[\s\S]*grid-template-columns:\s*minmax\(0, 18fr\) minmax\(0, 35fr\) minmax\(0, 34fr\) minmax\(0, 13fr\)/,
  );
  assert.match(
    toolCss,
    /\.item19-lower-band\s*{[\s\S]*grid-template-columns:\s*minmax\(0, 60fr\) minmax\(0, 40fr\)/,
  );
  assert.match(
    toolCss,
    /@media \(max-width: 760px\)[\s\S]*\.item19-summary-row,[\s\S]*\.item19-equipment-band,[\s\S]*\.item19-dinghy-band,[\s\S]*\.item19-lower-band[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/,
  );
});

test("Item 10a and 10b are separate blank controls", () => {
  assert.equal((toolHtml.match(/data-path="item10\.equipment"/g) || []).length, 1);
  assert.equal((toolHtml.match(/data-path="item10\.surveillance"/g) || []).length, 1);
  assert.doesNotMatch(
    toolHtml,
    /data-path="item10\.(?:equipment|surveillance)"[^>]*\svalue="[^"]+"/,
  );
  assert.match(toolHtml, /generator inserts exactly one slash/i);
  assert.match(
    toolHtml,
    /data-path="item10\.equipment"[\s\S]*<span class="item10-divider" aria-hidden="true">\/<\/span>[\s\S]*data-path="item10\.surveillance"/,
  );
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
