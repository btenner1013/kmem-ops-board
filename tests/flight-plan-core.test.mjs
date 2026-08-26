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

function makeValidFlightPlan() {
  const model = createBlankFlightPlan();
  const values = {
    "item7.aircraftIdentification": "RCH123",
    "item8.flightRules": "I",
    "item8.typeOfFlight": "M",
    "item9.aircraftType": "C17",
    "item9.wakeCategory": "H",
    "item10.equipment": "DE1E2FGHIJ5RSTUWXYZ",
    "item10.surveillance": "B1D1L",
    "item13.departure": "EGPK",
    "item13.time": "1532",
    "item15.speed": "N0450",
    "item15.level": "F330",
    "item15.route": "ABC DCT DEF UL607 GHI",
    "item16.destination": "LROP",
    "item16.totalEet": "0315",
    "item16.alternate": "LHBP",
    "item16.secondAlternate": "LRCL",
    "item18.otherInformation": "DOF/260826 OPR/USAF",
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
  assert.equal(classifyRouteToken("ELVIS7"), "procedure");
  assert.equal(classifyRouteToken("STAR"), "procedure");
  assert.equal(classifyRouteToken("SUDB1L.SUDBY"), "procedure");
  assert.equal(classifyRouteToken("TOSVI.TOSV1E"), "procedure");
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
  const result = validateRoute("ABC DEF UL607 GHI JKL ELVIS7 MNO");
  assert.equal(result.route, "ABC DCT DEF UL607 GHI DCT JKL ELVIS7 MNO");
  assert.equal(result.insertedCount, 2);
  assert.equal(result.changed, true);
});

test("dotted SID and STAR transition tokens from electronic DD1801 routes remain untouched", () => {
  const route = "SUDB1L.SUDBY UL607 ABC TOSVI.TOSV1E";
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
    "SUDB1L SUDBY DCS L612 BARTN MCT M16 DOLAS LAMSO PETIK PAM L620 OMELO PEPIK BERVA ERGOM TEGRI TOSVI TOSV1E";
  const result = validateRoute(route);
  assert.equal(
    result.route,
    "SUDB1L SUDBY DCS L612 BARTN DCT MCT M16 DOLAS DCT LAMSO DCT PETIK DCT PAM L620 OMELO DCT PEPIK DCT BERVA DCT ERGOM DCT TEGRI TOSVI TOSV1E",
  );
  assert.equal(result.insertedCount, 8);
  assert.doesNotMatch(result.route, /SUDBY DCT DCS|TEGRI DCT TOSVI/);
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
  setFieldValue(invalid, "item16.secondAlternate", "LRCL");
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
    "(FPL-RCH123-IM\n" +
      "-C17/H-DE1E2FGHIJ5RSTUWXYZ/B1D1L\n" +
      "-EGPK1532\n" +
      "-N0450F330 ABC DCT DEF UL607 GHI\n" +
      "-LROP0315 LHBP LRCL\n" +
      "-DOF/260826 OPR/USAF)",
  );
  const item9And10Line = message.split("\n")[1];
  assert.equal(item9And10Line, "-C17/H-DE1E2FGHIJ5RSTUWXYZ/B1D1L");
  assert.equal(item9And10Line.split("-")[2].split("/").length - 1, 1);
});

test("optional aircraft number is prepended to Item 9 when entered", () => {
  const model = makeValidFlightPlan();
  setFieldValue(model, "item9.number", "2");
  assert.equal(buildFplMessage(model).message.split("\n")[1], "-2C17/H-DE1E2FGHIJ5RSTUWXYZ/B1D1L");
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
  assert.match(buildFplMessage(model).message, /^\(FPL-RCH123-IM\n-99C17\/H-/);
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
