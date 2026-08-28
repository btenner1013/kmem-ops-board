import assert from "node:assert/strict";
import test from "node:test";

import {
  AISR_FIELD_DEFINITIONS,
  C17_MIL_IFR_PRESET,
  formatAisrSummary,
  normalizeAisrPlan,
  serializeAisrTransferPayload,
} from "../flight-plan-aisr.js";
import {
  buildFplMessage,
  createBlankFlightPlan,
  setFieldValue,
} from "../flight-plan-core.js";

const ELVIS63_FPL = `(FPL-ELVIS63-IM
-C17/H-SDE1E2FGHIJ5RTUWXYZ/B1D1L
-LROP0800
-N0442F340 SOKRU DCT OXDOC/N0423F340 DCT IRLOX/N0443F340 DCT MEGIK DCT ROMIS DCT LOKVU DCT LALUK DCT KOSIX L986 POVEL DCT MAXUN DCT RENEQ DCT TOWTE/N0432F260 DCT ASLIB
-EGPK0331 EGUN
-STS/MARSA STATE PBN/A1B1C1D1L1O1S1 NAV/RNP10 RNAV1 RNAV5 RNVD1E2A1 DAT/1FANS CPDLCX SUR/EUADSBX DOF/260901 REG/10189A SEL/EQLM CODE/AE10B8 RVR/800 OPR/DOD PER/D)`;

function makeElvisPlan() {
  const plan = createBlankFlightPlan();
  const values = {
    "item7.aircraftIdentification": "ELVIS63",
    "item8.flightRules": "I",
    "item8.typeOfFlight": "M",
    "item9.aircraftType": "C17",
    "item9.wakeCategory": "H",
    "item10.equipment": "SDE1E2FGHIJ5RTUWXYZ",
    "item10.surveillance": "B1D1L",
    "item13.departure": "LROP",
    "item13.time": "0800",
    "item15.speed": "N0442",
    "item15.level": "F340",
    "item15.route": "SOKRU DCT OXDOC/N0423F340 DCT IRLOX/N0443F340 DCT MEGIK DCT ROMIS DCT LOKVU DCT LALUK DCT KOSIX L986 POVEL DCT MAXUN DCT RENEQ DCT TOWTE/N0432F260 DCT ASLIB",
    "item16.destination": "EGPK",
    "item16.totalEet": "0331",
    "item16.alternate": "EGUN",
    "item18.otherInformation": "STS/MARSA STATE PBN/A1B1C1D1L1O1S1 NAV/RNP10 RNAV1 RNAV5 RNVD1E2A1 DAT/1FANS CPDLCX SUR/EUADSBX DOF/260901 REG/10189A SEL/EQLM CODE/AE10B8 RVR/800 OPR/DOD PER/D",
  };
  for (const [path, value] of Object.entries(values)) setFieldValue(plan, path, value);
  return plan;
}

function fieldsByKey(normalized) {
  return Object.fromEntries(normalized.fields.map(field => [field.key, field]));
}

test("C-17 MIL IFR preset contains only the approved normal defaults", () => {
  assert.deepEqual(C17_MIL_IFR_PRESET, {
    name: "C-17 MIL IFR",
    messageType: "FPL",
    flightRules: "I",
    typeOfFlight: "M",
    aircraftType: "C17",
    wakeCategory: "H",
  });
  assert.equal("equipment" in C17_MIL_IFR_PRESET, false);
  assert.equal("field18" in C17_MIL_IFR_PRESET, false);
});

test("deterministic ELVIS63 fixture maps into the normalized AISR model", () => {
  const plan = makeElvisPlan();
  const normalized = normalizeAisrPlan(plan);
  const fields = fieldsByKey(normalized);

  assert.equal(buildFplMessage(plan).message, ELVIS63_FPL);
  assert.equal(fields.messageType.value, "FPL");
  assert.equal(fields.messageType.source, "C-17 PRESET");
  assert.equal(fields.aircraftIdentification.value, "ELVIS63");
  assert.equal(fields.flightRules.value, "I");
  assert.equal(fields.typeOfFlight.value, "M");
  assert.equal(fields.aircraftType.value, "C17");
  assert.equal(fields.wakeCategory.value, "H");
  assert.equal(fields.equipment.value, "SDE1E2FGHIJ5RTUWXYZ");
  assert.equal(fields.surveillance.value, "B1D1L");
  assert.equal(fields.departure.value, "LROP");
  assert.equal(fields.departureTime.value, "0800");
  assert.equal(fields.speed.value, "N0442");
  assert.equal(fields.level.value, "F340");
  assert.equal(fields.route.value, plan.item15.route);
  assert.equal(fields.destination.value, "EGPK");
  assert.equal(fields.totalEet.value, "0331");
  assert.equal(fields.alternate1.value, "EGUN");
  assert.equal(fields.alternate2.status, "MANUAL REQUIRED");
  assert.equal(fields.field18.value, plan.item18.otherInformation);
  assert.equal(fields.homeStationOrganization.value, "DOD");
  assert.equal(fields.homeStationOrganization.source, "FLIGHT PLAN");
  assert.equal(normalized.warnings.length, 0);
});

test("normal source C17, IFR, military, and heavy values do not produce preset warnings", () => {
  const normalized = normalizeAisrPlan(makeElvisPlan());
  const fields = fieldsByKey(normalized);
  for (const key of ["flightRules", "typeOfFlight", "aircraftType", "wakeCategory"]) {
    assert.equal(fields[key].source, "FLIGHT PLAN");
    assert.equal(fields[key].status, "READY");
    assert.equal(fields[key].warning, "");
  }
});

test("explicit VFR source wins over IFR preset and produces the required warning", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item8.flightRules", "V");
  const field = fieldsByKey(normalizeAisrPlan(plan)).flightRules;
  assert.equal(field.value, "V");
  assert.equal(field.source, "FLIGHT PLAN");
  assert.equal(field.status, "CONFLICT");
  assert.equal(field.warning, "FLIGHT RULES DIFFER FROM C-17 MIL IFR PRESET — SOURCE VALUE RETAINED");
});

test("non-military, non-C17, and non-heavy source values remain authoritative", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item8.typeOfFlight", "G");
  setFieldValue(plan, "item9.aircraftType", "B738");
  setFieldValue(plan, "item9.wakeCategory", "M");
  const fields = fieldsByKey(normalizeAisrPlan(plan));
  for (const [key, expected] of [["typeOfFlight", "G"], ["aircraftType", "B738"], ["wakeCategory", "M"]]) {
    assert.equal(fields[key].value, expected);
    assert.equal(fields[key].source, "FLIGHT PLAN");
    assert.equal(fields[key].status, "CONFLICT");
    assert.match(fields[key].warning, /C-17 MIL IFR PRESET/);
  }
});

test("missing eligible values use preset but an invalid source is retained", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item8.flightRules", "");
  setFieldValue(plan, "item8.typeOfFlight", "");
  setFieldValue(plan, "item9.aircraftType", "");
  setFieldValue(plan, "item9.wakeCategory", "Q");
  const fields = fieldsByKey(normalizeAisrPlan(plan));
  assert.deepEqual(
    [fields.flightRules.value, fields.typeOfFlight.value, fields.aircraftType.value],
    ["I", "M", "C17"],
  );
  for (const key of ["flightRules", "typeOfFlight", "aircraftType"]) {
    assert.equal(fields[key].source, "C-17 PRESET");
    assert.equal(fields[key].status, "READY");
  }
  assert.equal(fields.wakeCategory.value, "Q");
  assert.equal(fields.wakeCategory.source, "FLIGHT PLAN");
  assert.equal(fields.wakeCategory.status, "INVALID");
});

test("Field 10 and Field 18 always use source and never receive blind fallbacks", () => {
  const source = fieldsByKey(normalizeAisrPlan(makeElvisPlan()));
  assert.equal(source.equipment.source, "FLIGHT PLAN");
  assert.equal(source.surveillance.source, "FLIGHT PLAN");
  assert.equal(source.field18.source, "FLIGHT PLAN");

  const blank = makeElvisPlan();
  setFieldValue(blank, "item10.equipment", "");
  setFieldValue(blank, "item10.surveillance", "");
  setFieldValue(blank, "item18.otherInformation", "");
  const missing = fieldsByKey(normalizeAisrPlan(blank));
  for (const key of ["equipment", "surveillance", "field18"]) {
    assert.equal(missing[key].value, "");
    assert.equal(missing[key].source, "NOT FOUND");
    assert.equal(missing[key].status, "MANUAL REQUIRED");
  }
});

test("AISR field validation stays aligned with existing flight-plan syntax", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item7.aircraftIdentification", "A");
  setFieldValue(plan, "item10.equipment", "NB1");
  setFieldValue(plan, "item10.surveillance", "N1");
  setFieldValue(plan, "item18.otherInformation", "RMK/UNSUPPORTED?");
  const fields = fieldsByKey(normalizeAisrPlan(plan));

  assert.equal(fields.aircraftIdentification.status, "READY");
  assert.equal(fields.equipment.status, "INVALID");
  assert.equal(fields.surveillance.status, "INVALID");
  assert.equal(fields.field18.status, "INVALID");
  assert.equal(fields.equipment.value, "NB1");
  assert.equal(fields.field18.value, "RMK/UNSUPPORTED?");
});

test("route and Field 18 preserve internal text exactly", () => {
  const plan = makeElvisPlan();
  const route = "  SOKRU  DCT\nOXDOC/N0423F340  ";
  const field18 = "  STS/MARSA STATE  RMK/KEEP  DOUBLE SPACE  ";
  setFieldValue(plan, "item15.route", route);
  setFieldValue(plan, "item18.otherInformation", field18);
  const fields = fieldsByKey(normalizeAisrPlan(plan));
  assert.equal(fields.route.value, route.trim());
  assert.equal(fields.field18.value, field18.trim());
  assert.match(fields.remarks.value, /KEEP  DOUBLE SPACE/);
});

test("unreliable imported values remain visible and require conflict review", () => {
  const plan = makeElvisPlan();
  const normalized = normalizeAisrPlan(plan, {
    importResult: { unreliableFields: ["item10.surveillance"] },
  });
  const surveillance = fieldsByKey(normalized).surveillance;
  assert.equal(surveillance.value, "B1D1L");
  assert.equal(surveillance.source, "FLIGHT PLAN");
  assert.equal(surveillance.status, "CONFLICT");
  assert.match(surveillance.warning, /NOT EXTRACTED RELIABLY/);
});

test("blank unreliable imports never make a C-17 preset look source-confirmed", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item8.flightRules", "");
  const options = { importResult: { unreliableFields: ["item8.flightRules"] } };
  const imported = fieldsByKey(normalizeAisrPlan(plan, options)).flightRules;

  assert.equal(imported.value, "I");
  assert.equal(imported.source, "C-17 PRESET");
  assert.equal(imported.status, "MANUAL REQUIRED");
  assert.match(imported.warning, /NOT EXTRACTED RELIABLY.*PRESET SHOWN FOR MANUAL REVIEW/);

  const corrected = fieldsByKey(normalizeAisrPlan(plan, {
    ...options,
    manuallyEditedPaths: ["item8.flightRules"],
  })).flightRules;
  assert.equal(corrected.status, "READY");
  assert.equal(corrected.warning, "");
});

test("derived supplementary values honor import reliability and manual corrections", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item19.emergencyRadio.frequency1215", true);
  const options = {
    importResult: { unreliableFields: ["item19.emergencyRadio.frequency1215"] },
  };
  const imported = fieldsByKey(normalizeAisrPlan(plan, options)).emergencyRadio;
  assert.equal(imported.value, "121.5 MHZ");
  assert.equal(imported.source, "FLIGHT PLAN");
  assert.equal(imported.status, "CONFLICT");
  assert.match(imported.warning, /NOT EXTRACTED RELIABLY/);

  const corrected = fieldsByKey(normalizeAisrPlan(plan, {
    ...options,
    manuallyEditedPaths: ["item19.emergencyRadio.frequency1215"],
  })).emergencyRadio;
  assert.equal(corrected.status, "READY");
  assert.equal(corrected.warning, "");
});

test("supplementary fields map only when reliable working-plan data exists", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item19.endurance", "0604");
  setFieldValue(plan, "item19.personsOnBoard", "004");
  setFieldValue(plan, "item19.emergencyRadio.frequency1215", true);
  setFieldValue(plan, "item19.emergencyRadio.frequency243", true);
  setFieldValue(plan, "item19.survivalEquipment.global", true);
  setFieldValue(plan, "item19.lifeJackets.carried", true);
  setFieldValue(plan, "item19.lifeJackets.lights", true);
  setFieldValue(plan, "item19.dinghies.carried", true);
  setFieldValue(plan, "item19.dinghies.number", "03");
  setFieldValue(plan, "item19.dinghies.capacity", "138");
  setFieldValue(plan, "item19.dinghies.color", "ORANGE");
  setFieldValue(plan, "item19.remarks", "SYNTHETIC TEST");
  setFieldValue(plan, "item19.aircraftSerial", "01-0189");
  setFieldValue(plan, "item19.aircraftType", "C17");
  const fields = fieldsByKey(normalizeAisrPlan(plan));

  assert.equal(fields.endurance.value, "0604");
  assert.equal(fields.personsOnBoard.value, "004");
  assert.equal(fields.emergencyRadio.value, "121.5 MHZ, 243.0 MHZ");
  assert.equal(fields.survivalEquipment.value, "GLOBAL");
  assert.equal(fields.lifeJackets.value, "CARRIED, LIGHTS");
  assert.match(fields.dinghies.value, /CARRIED.*NUMBER 03.*CAPACITY 138.*COLOR ORANGE/);
  assert.equal(fields.remarks.value, "SYNTHETIC TEST");
  assert.equal(fields.aircraftSerialNumbers.value, "01-0189");
  assert.equal(fields.aircraftTypesInFlight.value, "C17");
  assert.equal(fields.pilotInCommand.status, "MANUAL REQUIRED");
});

test("readiness summary counts provenance and unresolved review states", () => {
  const normalized = normalizeAisrPlan(makeElvisPlan());
  assert.equal(normalized.summary.total, AISR_FIELD_DEFINITIONS.length);
  assert.equal(normalized.summary.fromPreset, 1);
  assert.equal(normalized.summary.fromFlightPlan, 17);
  assert.ok(normalized.summary.manualRequired > 0);
  assert.equal(normalized.summary.conflicts, 0);
  assert.equal(normalized.summary.invalid, 0);
  assert.equal(normalized.summary.structuralErrors, 0);
  assert.equal(normalized.summary.structuralWarnings, 0);
  assert.equal(normalized.overallStatus, "AISR REVIEW REQUIRED");
});

test("existing structural validation is surfaced in AISR review and transfer data", () => {
  const plan = makeElvisPlan();
  setFieldValue(plan, "item9.number", "1");
  setFieldValue(plan, "item16.alternate", "");
  setFieldValue(plan, "item16.secondAlternate", "EGUN");
  const normalized = normalizeAisrPlan(plan);

  assert.equal(normalized.structuralValidation.passed, false);
  assert.equal(normalized.summary.structuralErrors, 2);
  assert.match(normalized.warnings.join("\n"), /FLIGHT PLAN VALIDATION ERROR/);
  assert.match(normalized.warnings.join("\n"), /number of aircraft/);
  assert.match(normalized.warnings.join("\n"), /second alternate/);
  assert.equal(normalized.overallStatus, "AISR REVIEW REQUIRED");

  const humanSummary = formatAisrSummary(normalized);
  assert.match(humanSummary, /REVIEW WARNINGS:/);
  assert.match(humanSummary, /number of aircraft/);
  assert.match(humanSummary, /second alternate/);

  const payload = JSON.parse(serializeAisrTransferPayload(normalized));
  assert.equal(payload.structuralValidation.passed, false);
  assert.equal(payload.structuralValidation.errors.length, 2);
});

test("human copy summary is AISR-oriented and keeps manual-review warnings", () => {
  const normalized = normalizeAisrPlan(makeElvisPlan());
  const summary = formatAisrSummary(normalized);
  assert.match(summary, /^AISR ASSISTANT\nPRESET: C-17 MIL IFR/m);
  assert.match(summary, /AIRCRAFT IDENTIFICATION: ELVIS63/);
  assert.match(summary, /FIELD 10 — EQUIPMENT: SDE1E2FGHIJ5RTUWXYZ/);
  assert.match(summary, /PILOT IN COMMAND: MANUAL REQUIRED/);
  assert.match(summary, /USER MUST REVIEW AND MANUALLY FILE/);
});

test("autofill transfer payload is versioned, whitelisted, populate-only, and nonfiling", () => {
  const normalized = normalizeAisrPlan(makeElvisPlan());
  const payloadText = serializeAisrTransferPayload(normalized);
  const payload = JSON.parse(payloadText);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.target, "AISR");
  assert.equal(payload.mode, "POPULATE_ONLY");
  assert.equal(payload.filingAllowed, false);
  assert.deepEqual(payload.selectorMapping, { verified: false, profile: null });
  assert.equal(payload.structuralValidation.passed, true);
  assert.equal(payload.fields.aircraftIdentification.value, "ELVIS63");
  assert.equal(payload.fields.route.value, makeElvisPlan().item15.route);
  assert.equal(payload.fields.field18.value, makeElvisPlan().item18.otherInformation);
  assert.equal("password" in payload, false);
  assert.equal("credentials" in payload, false);
  assert.equal("cookies" in payload, false);
  assert.equal("token" in payload, false);
  assert.equal("submit" in payload, false);
  assert.equal("file" in payload, false);
});

test("core implementation contains no fixture hard-code, persistence, network, or filing path", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../flight-plan-aisr.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /ELVIS63|10189A|SOKRU/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|WebSocket|postMessage\(|\.submit\(|requestSubmit\(/);
});
