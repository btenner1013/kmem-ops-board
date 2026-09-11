import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_IMPORT_FIELDS,
  extractDd1801Pdf,
  hasReliableDd1801AcroCoverage,
  mapAcroFormFields,
  parseDd1801TextPages,
} from "../flight-plan-pdf.js";
import { buildFplMessage } from "../flight-plan-core.js";
import {
  SYNTHETIC_DD1801,
  SYNTHETIC_DD1801_FPL,
} from "./fixtures/dd1801-approved-synthetic.mjs";

// The vendored browser build expects this browser geometry primitive at module
// initialization. Text extraction never renders, so an identity-capable shim is
// sufficient for the in-memory synthetic integration test.
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init = [1, 0, 0, 1, 0, 0]) {
      const values = Array.isArray(init) || ArrayBuffer.isView(init) ? init : [1, 0, 0, 1, 0, 0];
      [this.a, this.b, this.c, this.d, this.e, this.f] = values;
    }
  };
}

function textItem(str, x, y, width = Math.max(6, String(str).length * 7.2), height = 12) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height };
}

function supportedTemplateAnchors() {
  return [
    textItem("AIRCRAFT IDENTIFICATION", 207.5, 652, 109.8, 8.3),
    textItem("DEPARTURE AERODROME", 85.4, 604, 107.3, 8.3),
    textItem("CRUISING SPEED", 42.6, 580, 70.6, 8.3),
    textItem("OTHER INFORMATION", 42.6, 411.2, 88.8, 8.3),
    textItem("SUPPLEMENTARY INFORMATION", 238.7, 244, 132.6, 8.3),
    textItem("DD Form 1801, MAY 87", 25.3, 25, 113.2, 10.5),
    textItem("DOD INTERNATIONAL FLIGHT PLAN", 400.3, 25, 183.4, 10.5),
  ];
}

function acroFormPdf(fieldEntries) {
  const escapePdfString = (text) => String(text).replace(/([\\()])/g, "\\$1");
  const entries = Array.from(fieldEntries || []);
  const firstWidgetObject = 4;
  const acroFormObject = firstWidgetObject + entries.length;
  const contentObject = acroFormObject + 1;
  const widgetReferences = entries.map((_entry, index) => `${firstWidgetObject + index} 0 R`);
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm ${acroFormObject} 0 R >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Annots [${widgetReferences.join(" ")}] /Contents ${contentObject} 0 R >>`,
    ...entries.map(([fieldName, value], index) =>
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${escapePdfString(fieldName)}) /V (${escapePdfString(value)}) /Rect [20 ${700 - index * 12} 220 ${710 - index * 12}] /P 3 0 R >>`,
    ),
    `<< /Fields [${widgetReferences.join(" ")}] /NeedAppearances true >>`,
    "<< /Length 0 >>\nstream\n\nendstream",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "ascii"));
}

function minimalAcroFormPdf(fieldName, value) {
  return acroFormPdf([[fieldName, value]]);
}

test("positioned DD1801 text maps the approved synthetic values and splits wrapped Item 10 once", () => {
  const items = [
    ...supportedTemplateAnchors(),
    textItem(SYNTHETIC_DD1801.aircraftIdentification, 200, 639.2),
    textItem(SYNTHETIC_DD1801.flightRules, 414.3, 639.2, 6.3),
    textItem(SYNTHETIC_DD1801.typeOfFlight, 514.8, 639.2, 6.3),
    textItem("3", 70, 615.2, 6.3),
    textItem(SYNTHETIC_DD1801.aircraftType, 157.6, 615.2, 25),
    textItem(SYNTHETIC_DD1801.wakeCategory, 366.3, 615.2, 6.3),
    // Item 10 deliberately wraps across three lines in this synthetic layout.
    textItem("SFGH", 438.5, 609.2, 28.8),
    textItem("IRWY", 438.5, 598, 28.8),
    textItem("/", 488.9, 598, 7.2),
    textItem("C", 503.3, 598, 7.2),
    textItem("2", 438.5, 586.7, 7.2),
    textItem(SYNTHETIC_DD1801.departure, 97.6, 591.2, 50),
    textItem(SYNTHETIC_DD1801.departureTime, 256.6, 591.2, 50),
    textItem(SYNTHETIC_DD1801.speed, 42.5, 564.2, 56),
    textItem(SYNTHETIC_DD1801.level, 143.8, 564.2, 48),
    textItem("SIM1A.MOCKA", 256.3, 564.2, 79.2),
    textItem("ALPHA", 342.7, 564.2, 36),
    textItem("Q42", 385.9, 564.2, 21.6),
    textItem("BRAVO", 414.7, 564.2, 36),
    textItem("DCT", 24.5, 546.2, 21.6),
    textItem("CHARL", 53.3, 546.2, 36),
    textItem("T7", 96.5, 546.2, 14.4),
    textItem("DELTA", 118.1, 546.2, 36),
    textItem("TRIAL.SIM2B", 161.3, 546.2, 79.2),
    textItem(SYNTHETIC_DD1801.destination, 98.9, 422.5, 50),
    textItem(SYNTHETIC_DD1801.totalEet, 213.8, 422.5, 50),
    textItem(SYNTHETIC_DD1801.alternate, 344.9, 422.5, 50),
    textItem("ZZZD", 485, 422.5, 50),
    textItem("PBN/A1B1", 40.3, 396.2, 57.6),
    textItem("DOF/300101", 105.1, 396.2, 72),
    textItem("REG/TEST731", 24.5, 378.2, 79.2),
    textItem("OPR/TEST", 110.9, 378.2, 57.6),
    textItem("PER/C", 175.7, 378.2, 36),
    textItem("0 4 1 5", 69.5, 217.7, 38.1),
    textItem("0 0 7", 190, 217.7, 29.7),
    textItem(SYNTHETIC_DD1801.dinghyColor, 146, 157.7, 36),
    textItem(SYNTHETIC_DD1801.dinghyNumber, 219.6, 157.7, 14.7),
    textItem("/", 234.5, 157, 3.3),
    textItem(SYNTHETIC_DD1801.dinghyCapacity, 238.4, 157.7, 22.2),
    textItem(SYNTHETIC_DD1801.remarks, 25, 124, 210),
    textItem(SYNTHETIC_DD1801.aircraftSerial, 386.8, 124, 57.6),
    textItem(SYNTHETIC_DD1801.aircraftType, 386.8, 90.2, 21.6),
  ];

  const result = parseDd1801TextPages([{ width: 612, height: 792, items }]);

  assert.equal(result.source, "text");
  assert.equal(result.pageCount, 1);
  assert.equal(result.data.item7.aircraftIdentification, SYNTHETIC_DD1801.aircraftIdentification);
  assert.deepEqual(result.data.item8, { flightRules: "I", typeOfFlight: "M" });
  assert.deepEqual(result.data.item9, { number: "3", aircraftType: "C17", wakeCategory: "H" });
  assert.deepEqual(result.data.item10, {
    equipment: SYNTHETIC_DD1801.equipment,
    surveillance: SYNTHETIC_DD1801.surveillance,
  });
  assert.deepEqual(result.data.item13, {
    departure: SYNTHETIC_DD1801.departure,
    time: SYNTHETIC_DD1801.departureTime,
  });
  assert.equal(result.data.item15.speed, SYNTHETIC_DD1801.speed);
  assert.equal(result.data.item15.level, SYNTHETIC_DD1801.level);
  assert.equal(result.data.item15.route, SYNTHETIC_DD1801.route);
  assert.deepEqual(result.data.item16, {
    destination: SYNTHETIC_DD1801.destination,
    totalEet: SYNTHETIC_DD1801.totalEet,
    alternate: SYNTHETIC_DD1801.alternate,
    secondAlternate: "ZZZD",
  });
  assert.equal(result.data.item18.otherInformation, SYNTHETIC_DD1801.otherInformation);
  assert.equal(result.data.item19.endurance, SYNTHETIC_DD1801.endurance);
  assert.equal(result.data.item19.personsOnBoard, SYNTHETIC_DD1801.personsOnBoard);
  assert.equal(result.data.item19.dinghies.number, SYNTHETIC_DD1801.dinghyNumber);
  assert.equal(result.data.item19.dinghies.capacity, SYNTHETIC_DD1801.dinghyCapacity);
  assert.equal(result.data.item19.dinghies.color, SYNTHETIC_DD1801.dinghyColor);
  assert.equal(result.data.item19.remarks, SYNTHETIC_DD1801.remarks);
  assert.equal(result.data.item19.aircraftSerial, SYNTHETIC_DD1801.aircraftSerial);
  assert.equal(result.data.item19.aircraftType, SYNTHETIC_DD1801.aircraftType);
  assert.ok(result.unreliableFields.includes("item19.emergencyRadio.frequency1215"));
  assert.ok(result.unreliableFields.includes("item19.survivalEquipment.polar"));
  assert.ok(result.unreliableFields.includes("item19.lifeJackets.carried"));
  assert.ok(result.unreliableFields.includes("item19.dinghies.cover"));
  assert.ok(!result.unreliableFields.includes("item19.lifeJackets.uhf"));
  assert.ok(!result.unreliableFields.includes("item19.lifeJackets.vhf"));
});

test("adjacent text runs are rejoined without splitting one Item 18 token", () => {
  const items = [
    ...supportedTemplateAnchors(),
    textItem(SYNTHETIC_DD1801.aircraftIdentification, 200, 639.2),
    textItem("I", 414.3, 639.2, 6.3),
    textItem("M", 514.8, 639.2, 6.3),
    textItem("C17", 157.6, 615.2, 25),
    textItem("H", 366.3, 615.2, 6.3),
    textItem("S/C2/X", 438.5, 609.2, 43.2),
    textItem(SYNTHETIC_DD1801.departure, 97.6, 591.2, 50),
    textItem(SYNTHETIC_DD1801.departureTime, 256.6, 591.2, 50),
    textItem(SYNTHETIC_DD1801.speed, 42.5, 564.2, 56),
    textItem(SYNTHETIC_DD1801.level, 143.8, 564.2, 48),
    textItem("MOCKA", 256.3, 564.2, 36),
    textItem("DCT", 285.1, 564.2, 21.6),
    textItem("BRAVO", 313.9, 564.2, 36),
    textItem(SYNTHETIC_DD1801.destination, 98.9, 422.5, 50),
    textItem(SYNTHETIC_DD1801.totalEet, 213.8, 422.5, 50),
    textItem("PBN/A1", 40.3, 396.2, 43.2),
    textItem("B1", 83.5, 396.2, 14.4),
    textItem(" DOF/300101", 97.9, 396.2, 79.2),
    textItem("REG/TEST", 40.3, 378.2, 57.6),
    textItem("731 ", 97.9, 378.2, 28.8),
    textItem("OPR/TEST", 40.3, 360.2, 57.6),
    textItem(" ", 97.9, 360.2, 7.2),
    textItem("PER/C", 105.1, 360.2, 36),
  ];

  const result = parseDd1801TextPages([{ width: 612, height: 792, items }]);
  assert.equal(
    result.data.item18.otherInformation,
    SYNTHETIC_DD1801.otherInformation,
  );
  assert.equal(result.data.item10.surveillance, "C2/X");
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(result.unreliableFields.includes("item10.surveillance"));
});

test("AcroForm mapping recognizes semantic names and keeps Item 10a/10b separate", () => {
  const result = mapAcroFormFields({
    "Aircraft Identification": [{ value: SYNTHETIC_DD1801.aircraftIdentification }],
    "Item 10": [{ value: `${SYNTHETIC_DD1801.equipment}/${SYNTHETIC_DD1801.surveillance}` }],
    "Departure Aerodrome": [{ value: SYNTHETIC_DD1801.departure }],
    "Item 19 Dinghy Cover": [{ value: "Yes" }],
  });

  assert.equal(result.data.item7.aircraftIdentification, SYNTHETIC_DD1801.aircraftIdentification);
  assert.equal(result.data.item10.equipment, SYNTHETIC_DD1801.equipment);
  assert.equal(result.data.item10.surveillance, SYNTHETIC_DD1801.surveillance);
  assert.equal(result.data.item13.departure, SYNTHETIC_DD1801.departure);
  assert.equal(result.data.item19.dinghies.cover, true);
});

test("Item 19 AcroForm mapping keeps paper labels and ignores obsolete jacket fields", () => {
  const result = mapAcroFormFields({
    "Item 19 Life Jackets": [{ value: "Yes" }],
    "Item 19 Jacket Lights": [{ value: "Yes" }],
    "Item 19 Jacket Fluorescein": [{ value: "Yes" }],
    "Item 19 Dinghies": [{ value: "Yes" }],
    "Emergency Radio Other": [{ value: "123.45" }],
    "Item 19 Jacket UHF": [{ value: "Yes" }],
    "Item 19 Jacket VHF": [{ value: "Yes" }],
  });

  assert.equal(result.data.item19.lifeJackets.carried, true);
  assert.equal(result.data.item19.lifeJackets.lights, true);
  assert.equal(result.data.item19.lifeJackets.fluorescein, true);
  assert.equal(result.data.item19.dinghies.carried, true);
  assert.equal(result.data.item19.radioFrequencies, "123.45");

  for (const obsoletePath of [
    "item19.emergencyRadio.other",
    "item19.lifeJackets.uhf",
    "item19.lifeJackets.vhf",
  ]) {
    assert.ok(!CORE_IMPORT_FIELDS.includes(obsoletePath));
    assert.ok(!result.extractedFields.includes(obsoletePath));
    assert.ok(!result.unreliableFields.includes(obsoletePath));
  }
});

test("AcroForm import normalizes periods and whitespace only in Item 15 route", () => {
  const result = mapAcroFormFields({
    Route: [{ value: `  ${SYNTHETIC_DD1801.dottedRoute.replaceAll(" ", "\t  ")}  ` }],
    "Other Information": [{ value: "RMK/KEEP.THIS  SPACING" }],
  });

  assert.equal(result.data.item15.route, SYNTHETIC_DD1801.route);
  assert.equal(result.data.item18.otherInformation, "RMK/KEEP.THIS  SPACING");
});

test("blank duplicate Item 10 widgets cannot erase a populated combined value", () => {
  const result = mapAcroFormFields({
    "Item 10": [{ value: `${SYNTHETIC_DD1801.equipment}/${SYNTHETIC_DD1801.surveillance}` }],
    "Item 10a": [{ value: "" }],
    "Item 10b": [{ value: "" }],
  });

  assert.equal(result.data.item10.equipment, SYNTHETIC_DD1801.equipment);
  assert.equal(result.data.item10.surveillance, SYNTHETIC_DD1801.surveillance);
  assert.ok(result.extractedFields.includes("item10.equipment"));
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(!result.reliableBlankFields.includes("item10.equipment"));
  assert.ok(!result.reliableBlankFields.includes("item10.surveillance"));
});

test("a multi-slash AcroForm Item 10 value is retained and flagged for review", () => {
  const result = mapAcroFormFields({ "Item 10": [{ value: "S/C2/X" }] });
  assert.equal(result.data.item10.equipment, "S");
  assert.equal(result.data.item10.surveillance, "C2/X");
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(result.unreliableFields.includes("item10.surveillance"));
  assert.ok(result.warnings.some((warning) => /more than one slash/i.test(warning)));
});

test("AcroForm-only acceptance requires meaningful DD1801 field coverage", () => {
  const generic = mapAcroFormFields({ Route: [{ value: "ABC DEF" }] });
  assert.equal(hasReliableDd1801AcroCoverage(generic), false);

  const dd1801 = mapAcroFormFields({
    "Aircraft Identification": [{ value: SYNTHETIC_DD1801.aircraftIdentification }],
    "Flight Rules": [{ value: "I" }],
    "Type of Flight": [{ value: "M" }],
    "Aircraft Type": [{ value: "C17" }],
    "Item 10": [{ value: `S/${SYNTHETIC_DD1801.surveillance}` }],
    "Departure Aerodrome": [{ value: SYNTHETIC_DD1801.departure }],
  });
  assert.equal(hasReliableDd1801AcroCoverage(dd1801), true);
});

test("an unrelated one-field AcroForm PDF is rejected instead of treated as DD1801", async () => {
  await assert.rejects(
    () => extractDd1801Pdf(minimalAcroFormPdf("Route", "MOCKA BRAVO")),
    /No reliably identified DD1801 AcroForm.*Manual entry is required/i,
  );
});

test("positioned parser fails clearly when DD1801 anchors are not reliable", () => {
  assert.throws(
    () =>
      parseDd1801TextPages([
        { width: 612, height: 792, items: [textItem("unrelated PDF", 20, 700)] },
      ]),
    /does not match the supported DD Form 1801 template.*Manual entry is required/i,
  );
});

test("in-memory synthetic AcroForm PDF exercises PDF.js without an external document", async () => {
  const result = await extractDd1801Pdf(acroFormPdf([
    ["Aircraft Identification", SYNTHETIC_DD1801.aircraftIdentification],
    ["Flight Rules", SYNTHETIC_DD1801.flightRules],
    ["Type of Flight", SYNTHETIC_DD1801.typeOfFlight],
    ["Type of Aircraft", SYNTHETIC_DD1801.aircraftType],
    ["Wake Category", SYNTHETIC_DD1801.wakeCategory],
    ["Item 10", `${SYNTHETIC_DD1801.equipment}/${SYNTHETIC_DD1801.surveillance}`],
    ["Departure Aerodrome", SYNTHETIC_DD1801.departure],
    ["Departure Time", SYNTHETIC_DD1801.departureTime],
    ["Cruising Speed", SYNTHETIC_DD1801.speed],
    ["Level", SYNTHETIC_DD1801.level],
    ["Route", SYNTHETIC_DD1801.dottedRoute],
    ["Destination Aerodrome", SYNTHETIC_DD1801.destination],
    ["Total EET", SYNTHETIC_DD1801.totalEet],
    ["Alternate Aerodrome", SYNTHETIC_DD1801.alternate],
    ["Other Information", SYNTHETIC_DD1801.otherInformation],
  ]));

  assert.equal(result.source, "acroform");
  assert.equal(result.pageCount, 1);
  assert.equal(result.data.item7.aircraftIdentification, SYNTHETIC_DD1801.aircraftIdentification);
  assert.deepEqual(result.data.item8, { flightRules: "I", typeOfFlight: "M" });
  assert.deepEqual(result.data.item9, { number: "", aircraftType: "C17", wakeCategory: "H" });
  assert.deepEqual(result.data.item10, {
    equipment: SYNTHETIC_DD1801.equipment,
    surveillance: SYNTHETIC_DD1801.surveillance,
  });
  assert.deepEqual(result.data.item13, {
    departure: SYNTHETIC_DD1801.departure,
    time: SYNTHETIC_DD1801.departureTime,
  });
  assert.equal(result.data.item15.speed, SYNTHETIC_DD1801.speed);
  assert.equal(result.data.item15.level, SYNTHETIC_DD1801.level);
  assert.equal(result.data.item15.route, SYNTHETIC_DD1801.route);
  assert.deepEqual(result.data.item16, {
    destination: SYNTHETIC_DD1801.destination,
    totalEet: SYNTHETIC_DD1801.totalEet,
    alternate: SYNTHETIC_DD1801.alternate,
    secondAlternate: "",
  });
  assert.equal(result.data.item18.otherInformation, SYNTHETIC_DD1801.otherInformation);
  assert.equal(buildFplMessage(result.data).message, SYNTHETIC_DD1801_FPL);
});
