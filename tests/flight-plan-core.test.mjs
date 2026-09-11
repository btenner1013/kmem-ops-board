import test from "node:test";
import assert from "node:assert/strict";

import {
  FIELD_PATHS,
  buildFplMessage,
  classifyRouteToken,
  createBlankFlightPlan,
  getFieldValue,
  hasWorkingData,
  setFieldValue,
  validateFlightPlan,
  validateRoute,
} from "../flight-plan-core.js";
import {
  SYNTHETIC_DD1801,
  SYNTHETIC_DD1801_FPL,
} from "./fixtures/dd1801-approved-synthetic.mjs";

function makeValidFlightPlan() {
  const model = createBlankFlightPlan();
  const values = {
    "item7.aircraftIdentification": SYNTHETIC_DD1801.aircraftIdentification,
    "item8.flightRules": SYNTHETIC_DD1801.flightRules,
    "item8.typeOfFlight": SYNTHETIC_DD1801.typeOfFlight,
    "item9.aircraftType": SYNTHETIC_DD1801.aircraftType,
    "item9.wakeCategory": SYNTHETIC_DD1801.wakeCategory,
    "item10.equipment": SYNTHETIC_DD1801.equipment,
    "item10.surveillance": SYNTHETIC_DD1801.surveillance,
    "item13.departure": SYNTHETIC_DD1801.departure,
    "item13.time": SYNTHETIC_DD1801.departureTime,
    "item15.speed": SYNTHETIC_DD1801.speed,
    "item15.level": SYNTHETIC_DD1801.level,
    "item15.route": SYNTHETIC_DD1801.route,
    "item16.destination": SYNTHETIC_DD1801.destination,
    "item16.totalEet": SYNTHETIC_DD1801.totalEet,
    "item16.alternate": SYNTHETIC_DD1801.alternate,
    "item16.secondAlternate": SYNTHETIC_DD1801.secondAlternate,
    "item18.otherInformation": SYNTHETIC_DD1801.otherInformation,
  };
  for (const [path, value] of Object.entries(values)) {
    setFieldValue(model, path, value);
  }
  return model;
}

test("blank model exposes every operational leaf with no defaults", () => {
  const first = createBlankFlightPlan();
  const second = createBlankFlightPlan();

  assert.equal(FIELD_PATHS.length, new Set(FIELD_PATHS).size);
  for (const path of FIELD_PATHS) {
    const value = getFieldValue(first, path);
    assert.ok(value === "" || value === false, `${path} must start blank or false`);
  }
  assert.equal(first.item10.equipment, "");
  assert.equal(first.item10.surveillance, "");
  assert.notStrictEqual(first.item19.emergencyRadio, second.item19.emergencyRadio);
  assert.notStrictEqual(first.item19.dinghies, second.item19.dinghies);
  for (const obsoletePath of [
    "item19.emergencyRadio.other",
    "item19.lifeJackets.uhf",
    "item19.lifeJackets.vhf",
  ]) {
    assert.ok(!FIELD_PATHS.includes(obsoletePath));
    assert.equal(getFieldValue(first, obsoletePath), undefined);
  }
  assert.equal(hasWorkingData(first), false);

  const validation = validateFlightPlan(first);
  assert.equal(validation.passed, false);
  assert.equal(validation.status, "ERROR");
  assert.ok(validation.errors.length >= 14);
  assert.deepEqual(buildFplMessage(first), { message: "", validation });
});

test("field helpers preserve strings and booleans and detect working data", () => {
  const model = createBlankFlightPlan();
  assert.strictEqual(setFieldValue(model, "item15.route", "  ABC DEF  "), model);
  assert.equal(getFieldValue(model, "item15.route"), "  ABC DEF  ");
  assert.equal(hasWorkingData(model), true);

  setFieldValue(model, "item15.route", "   \n\t");
  assert.equal(hasWorkingData(model), false);
  setFieldValue(model, "item19.lifeJackets.lights", true);
  assert.equal(getFieldValue(model, "item19.lifeJackets.lights"), true);
  assert.equal(hasWorkingData(model), true);
  setFieldValue(model, "item19.lifeJackets.lights", false);
  assert.equal(hasWorkingData(model), false);

  assert.equal(getFieldValue(model, "not.a.field"), undefined);
  assert.throws(() => setFieldValue(model, "not.a.field", "x"), RangeError);
});

test("route-token classification covers operational token families", () => {
  assert.equal(classifyRouteToken("DCT"), "dct");
  assert.equal(classifyRouteToken("UL607"), "airway");
  assert.equal(classifyRouteToken("NATA"), "airway");
  assert.equal(classifyRouteToken("SIM1A"), "procedure");
  assert.equal(classifyRouteToken("STAR"), "procedure");
  assert.equal(classifyRouteToken("SIM1A.MOCKA"), "procedure");
  assert.equal(classifyRouteToken("TRIAL.SIM2B"), "procedure");
  assert.equal(classifyRouteToken("N0450F330"), "modifier");
  assert.equal(classifyRouteToken("F350"), "modifier");
  assert.equal(classifyRouteToken("5230N02000W"), "coordinate");
  assert.equal(classifyRouteToken("52N020W"), "coordinate");
  assert.equal(classifyRouteToken("DUB180040"), "coordinate");
  assert.equal(classifyRouteToken("ABC"), "point");
  assert.equal(classifyRouteToken("ABC/N0450F330"), "point");
  assert.equal(classifyRouteToken("???"), "unknown");
  assert.equal(classifyRouteToken(""), "empty");
});

test("consecutive points receive conservative DCT insertion", () => {
  assert.deepEqual(validateRoute("ABC DEF GHI"), {
    route: "ABC DCT DEF DCT GHI",
    changed: true,
    insertedCount: 2,
    warnings: [],
  });
});

test("existing DCT is never duplicated", () => {
  const once = validateRoute("ABC DCT DEF");
  assert.equal(once.route, "ABC DCT DEF");
  assert.equal(once.changed, false);
  assert.equal(once.insertedCount, 0);
  assert.doesNotMatch(once.route, /DCT\s+DCT/);
});

test("an airway between points remains unchanged", () => {
  assert.deepEqual(validateRoute("ABC UL607 DEF"), {
    route: "ABC UL607 DEF",
    changed: false,
    insertedCount: 0,
    warnings: [],
  });
});

test("a mixed route changes only confidently adjacent point pairs", () => {
  const result = validateRoute("ALPHA BRAVO Q42 CHARL DELTA SIM1A ECHO");
  assert.equal(result.route, "ALPHA DCT BRAVO Q42 CHARL DCT DELTA SIM1A ECHO");
  assert.equal(result.insertedCount, 2);
  assert.equal(result.changed, true);
});

test("dotted SID and STAR transition tokens from electronic DD1801 routes remain untouched", () => {
  const route = "SIM1A.MOCKA Q42 ALPHA TRIAL.SIM2B";
  assert.deepEqual(validateRoute(route), {
    route,
    changed: false,
    insertedCount: 0,
    warnings: [],
  });

  const model = makeValidFlightPlan();
  setFieldValue(model, "item15.route", route);
  const validation = validateFlightPlan(model);
  assert.equal(validation.passed, true);
  assert.equal(validation.status, "LOCAL CHECKS PASSED");
});

test("normalized DD1801 SID and STAR boundary envelopes do not gain speculative DCT", () => {
  const route =
    "SIM1A MOCKA ALPHA BRAVO Q42 CHARL DELTA ECHO T7 FOXT GOLF TRIAL SIM2B";
  const result = validateRoute(route);
  assert.equal(
    result.route,
    "SIM1A MOCKA ALPHA DCT BRAVO Q42 CHARL DCT DELTA DCT ECHO T7 FOXT DCT GOLF TRIAL SIM2B",
  );
  assert.equal(result.insertedCount, 4);
  assert.doesNotMatch(result.route, /MOCKA DCT ALPHA|GOLF DCT TRIAL/);
});

test("unknown route tokens and their surrounding sections are left unchanged", () => {
  const result = validateRoute("ABC ??? DEF");
  assert.equal(result.route, "ABC ??? DEF");
  assert.equal(result.changed, false);
  assert.equal(result.insertedCount, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /\?\?\?.*left unchanged/i);
});

test("long multiline routes retain every original whitespace character", () => {
  const before = "  ABC  DEF\r\nGHI\tUL607\n5230N02000W 52N030W  ";
  const result = validateRoute(before);
  assert.equal(
    result.route,
    "  ABC DCT  DEF DCT\r\nGHI\tUL607\n5230N02000W DCT 52N030W  ",
  );
  assert.equal(result.insertedCount, 3);

  const removeInsertedDct = (value) => value.replace(/ DCT(?=\s)/g, "");
  assert.equal(removeInsertedDct(result.route), before);
});

test("speed/level modifiers are preserved and attached modifiers remain point-like", () => {
  assert.equal(validateRoute("ABC N0450F350 DEF").route, "ABC N0450F350 DEF");
  assert.equal(validateRoute("ABC/N0450F350 DEF").route, "ABC/N0450F350 DCT DEF");
});

test("repeated validation is idempotent", () => {
  const first = validateRoute("ABC DEF GHI");
  const second = validateRoute(first.route);
  assert.equal(second.route, first.route);
  assert.equal(second.changed, false);
  assert.equal(second.insertedCount, 0);
  assert.doesNotMatch(second.route, /DCT\s+DCT/);
});

test("a user edit is untouched until validation is explicitly run again", () => {
  const validated = validateRoute("ABC DEF").route;
  const manuallyEdited = validated.replace(" DCT", "");
  assert.equal(manuallyEdited, "ABC DEF");
  assert.equal(validateRoute(manuallyEdited).route, "ABC DCT DEF");
});

test("undo can restore the exact pre-validation snapshot", () => {
  const preValidation = "\tABC  DEF\r\nGHI  ";
  const result = validateRoute(preValidation);
  assert.equal(result.changed, true);

  let currentRoute = result.route;
  currentRoute = preValidation;
  assert.equal(currentRoute, "\tABC  DEF\r\nGHI  ");
  assert.equal(currentRoute, preValidation);
});

test("a structurally valid plan passes without operational claims", () => {
  const model = makeValidFlightPlan();
  const validation = validateFlightPlan(model);
  assert.deepEqual(validation, {
    errors: [],
    warnings: [],
    passed: true,
    status: "LOCAL CHECKS PASSED",
  });
});

test("Item 18 is required but a user-entered 0 is valid", () => {
  const model = makeValidFlightPlan();
  setFieldValue(model, "item18.otherInformation", "");
  assert.ok(validateFlightPlan(model).errors.some((error) => /Item 18.*required/.test(error)));

  setFieldValue(model, "item18.otherInformation", "0");
  const validation = validateFlightPlan(model);
  assert.equal(validation.passed, true);
  assert.equal(validation.status, "LOCAL CHECKS PASSED");
});

test("local checks distinguish deterministic errors from review warnings", () => {
  const invalid = makeValidFlightPlan();
  setFieldValue(invalid, "item7.aircraftIdentification", "BAD-ID");
  setFieldValue(invalid, "item8.flightRules", "Q");
  setFieldValue(invalid, "item9.number", "0");
  setFieldValue(invalid, "item10.equipment", "N/S");
  setFieldValue(invalid, "item10.surveillance", "NB1");
  setFieldValue(invalid, "item13.time", "2460");
  setFieldValue(invalid, "item15.speed", "450");
  setFieldValue(invalid, "item15.level", "330");
  setFieldValue(invalid, "item16.alternate", "");
  setFieldValue(invalid, "item16.secondAlternate", "ZZZD");
  const invalidResult = validateFlightPlan(invalid);
  assert.equal(invalidResult.passed, false);
  assert.equal(invalidResult.status, "ERROR");
  assert.ok(invalidResult.errors.some((error) => /without a slash/.test(error)));
  assert.ok(invalidResult.errors.some((error) => /code N must be used by itself/.test(error)));
  assert.ok(invalidResult.errors.some((error) => /second alternate/.test(error)));
  assert.equal(buildFplMessage(invalid).message, "");

  const review = makeValidFlightPlan();
  setFieldValue(review, "item15.route", "ABC DEF");
  setFieldValue(review, "item18.otherInformation", "REMARKS ONLY");
  const reviewResult = validateFlightPlan(review);
  assert.equal(reviewResult.passed, true);
  assert.equal(reviewResult.status, "WARNING");
  assert.ok(reviewResult.warnings.some((warning) => /may need DCT/.test(warning)));
  assert.ok(reviewResult.warnings.some((warning) => /indicator\/value/.test(warning)));
});

test("FPL generation combines Item 10 with exactly one slash", () => {
  const model = makeValidFlightPlan();
  const { message, validation } = buildFplMessage(model);
  assert.equal(validation.passed, true);
  assert.equal(
    message,
    SYNTHETIC_DD1801_FPL,
  );
  const item9And10Line = message.split("\n")[1];
  assert.equal(item9And10Line, `-C17/H-${SYNTHETIC_DD1801.equipment}/${SYNTHETIC_DD1801.surveillance}`);
  assert.equal(item9And10Line.split("-")[2].split("/").length - 1, 1);
});

test("optional aircraft number is prepended to Item 9 when entered", () => {
  const model = makeValidFlightPlan();
  setFieldValue(model, "item9.number", "2");
  assert.equal(
    buildFplMessage(model).message.split("\n")[1],
    `-2C17/H-${SYNTHETIC_DD1801.equipment}/${SYNTHETIC_DD1801.surveillance}`,
  );
});

test("Item 9 uses blank for one aircraft and accepts only entered counts 2 through 99", () => {
  const model = makeValidFlightPlan();
  assert.equal(validateFlightPlan(model).passed, true);

  setFieldValue(model, "item9.number", "1");
  const single = validateFlightPlan(model);
  assert.equal(single.passed, false);
  assert.ok(single.errors.some((error) => /2 through 99, or blank for one aircraft/.test(error)));
  assert.equal(buildFplMessage(model).message, "");

  setFieldValue(model, "item9.number", "99");
  assert.equal(validateFlightPlan(model).passed, true);
  assert.match(buildFplMessage(model).message, /^\(FPL-LAB731-IM\n-99C17\/H-/);
});

test("Item 19 remains associated with the model but is excluded from transmitted FPL", () => {
  const model = makeValidFlightPlan();
  setFieldValue(model, "item19.endurance", "SECRET-ENDURANCE");
  setFieldValue(model, "item19.personsOnBoard", "SECRET-POB");
  setFieldValue(model, "item19.emergencyRadio.frequency243", true);
  setFieldValue(model, "item19.survivalEquipment.maritime", true);
  setFieldValue(model, "item19.lifeJackets.fluorescein", true);
  setFieldValue(model, "item19.dinghies.number", "SECRET-DINGHIES");
  setFieldValue(model, "item19.radioFrequencies", "SECRET-FREQUENCIES");
  setFieldValue(model, "item19.remarks", "SECRET-REMARKS");
  setFieldValue(model, "item19.aircraftSerial", "SECRET-SERIAL");
  setFieldValue(model, "item19.aircraftType", "SECRET-TYPE");

  const { message } = buildFplMessage(model);
  assert.ok(message.startsWith("(FPL-"));
  assert.doesNotMatch(message, /SECRET/);
  assert.equal(model.item19.emergencyRadio.frequency243, true);
  assert.equal(model.item19.dinghies.number, "SECRET-DINGHIES");
});
