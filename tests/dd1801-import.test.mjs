import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CORE_IMPORT_FIELDS,
  extractDd1801Pdf,
  hasReliableDd1801AcroCoverage,
  mapAcroFormFields,
  parseDd1801TextPages,
} from "../flight-plan-pdf.js";
import { buildFplMessage, setFieldValue, validateRoute } from "../flight-plan-core.js";

// The vendored browser build expects this browser geometry primitive at module
// initialization. Text extraction never renders, so an identity-capable shim is
// sufficient for the opt-in Node integration test.
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

function minimalAcroFormPdf(fieldName, value) {
  const escapePdfString = (text) => String(text).replace(/([\\()])/g, "\\$1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Annots [4 0 R] /Contents 6 0 R >>",
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${escapePdfString(fieldName)}) /V (${escapePdfString(value)}) /Rect [20 700 220 730] /P 3 0 R >>`,
    "<< /Fields [4 0 R] /NeedAppearances true >>",
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

test("positioned DD1801 text maps exact values and splits wrapped Item 10 once", () => {
  const items = [
    ...supportedTemplateAnchors(),
    textItem("SYNTH42", 200, 639.2),
    textItem("I", 414.3, 639.2, 6.3),
    textItem("M", 514.8, 639.2, 6.3),
    textItem("2", 70, 615.2, 6.3),
    textItem("C17", 157.6, 615.2, 25),
    textItem("H", 366.3, 615.2, 6.3),
    // Item 10 deliberately wraps across three lines like the supplied sample.
    textItem("DE1E2FGHIJ5RS", 438.5, 609.2, 93.6),
    textItem("TUWXYZ", 438.5, 598, 43.2),
    textItem("/", 488.9, 598, 7.2),
    textItem("B1D1", 503.3, 598, 28.8),
    textItem("L", 438.5, 586.7, 7.2),
    textItem("EGPK", 97.6, 591.2, 50),
    textItem("0335", 256.6, 591.2, 50),
    textItem("N0444", 42.5, 564.2, 56),
    textItem("F350", 143.8, 564.2, 48),
    textItem("SUDB1L.SUDBY", 256.3, 564.2, 86.4),
    textItem("DCS", 349.9, 564.2, 21.6),
    textItem("L612", 378.7, 564.2, 28.8),
    textItem("BARTN", 414.7, 564.2, 36),
    textItem("LAMSO", 24.5, 546.2, 36),
    textItem("PETIK", 67.7, 546.2, 36),
    textItem("PAM", 110.9, 546.2, 21.6),
    textItem("L620", 139.7, 546.2, 28.8),
    textItem("OMELO", 175.7, 546.2, 36),
    textItem("LROP", 98.9, 422.5, 50),
    textItem("0308", 213.8, 422.5, 50),
    textItem("LRCK", 344.9, 422.5, 50),
    textItem("LBSF", 485, 422.5, 50),
    textItem("STS/MARSA", 40.3, 396.2, 64.8),
    textItem("PBN/A1B1", 112.3, 396.2, 57.6),
    textItem("DOF/260831", 24.5, 378.2, 72),
    textItem("OPR/DOD", 103.7, 378.2, 50.4),
    textItem("0 6 0 4", 69.5, 217.7, 38.1),
    textItem("0 0 4", 190, 217.7, 29.7),
    textItem("CERISE", 146, 157.7, 43.2),
    textItem("03", 219.6, 157.7, 14.7),
    textItem("/", 234.5, 157, 3.3),
    textItem("138", 238.4, 157.7, 22.2),
    textItem("SUPPLEMENTARY TEST", 25, 124, 140),
    textItem("01-0189", 386.8, 124, 50.4),
    textItem("C17", 386.8, 90.2, 21.6),
  ];

  const result = parseDd1801TextPages([{ width: 612, height: 792, items }]);

  assert.equal(result.source, "text");
  assert.equal(result.pageCount, 1);
  assert.equal(result.data.item7.aircraftIdentification, "SYNTH42");
  assert.deepEqual(result.data.item8, { flightRules: "I", typeOfFlight: "M" });
  assert.deepEqual(result.data.item9, { number: "2", aircraftType: "C17", wakeCategory: "H" });
  assert.deepEqual(result.data.item10, {
    equipment: "DE1E2FGHIJ5RSTUWXYZ",
    surveillance: "B1D1L",
  });
  assert.deepEqual(result.data.item13, { departure: "EGPK", time: "0335" });
  assert.equal(result.data.item15.speed, "N0444");
  assert.equal(result.data.item15.level, "F350");
  assert.equal(
    result.data.item15.route,
    "SUDB1L SUDBY DCS L612 BARTN LAMSO PETIK PAM L620 OMELO",
  );
  assert.deepEqual(result.data.item16, {
    destination: "LROP",
    totalEet: "0308",
    alternate: "LRCK",
    secondAlternate: "LBSF",
  });
  assert.equal(
    result.data.item18.otherInformation,
    "STS/MARSA PBN/A1B1 DOF/260831 OPR/DOD",
  );
  assert.equal(result.data.item19.endurance, "0604");
  assert.equal(result.data.item19.personsOnBoard, "004");
  assert.equal(result.data.item19.dinghies.number, "03");
  assert.equal(result.data.item19.dinghies.capacity, "138");
  assert.equal(result.data.item19.dinghies.color, "CERISE");
  assert.equal(result.data.item19.remarks, "SUPPLEMENTARY TEST");
  assert.equal(result.data.item19.aircraftSerial, "01-0189");
  assert.equal(result.data.item19.aircraftType, "C17");
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
    textItem("SYNTH42", 200, 639.2),
    textItem("I", 414.3, 639.2, 6.3),
    textItem("M", 514.8, 639.2, 6.3),
    textItem("C17", 157.6, 615.2, 25),
    textItem("H", 366.3, 615.2, 6.3),
    textItem("S/B1/X", 438.5, 609.2, 43.2),
    textItem("EGPK", 97.6, 591.2, 50),
    textItem("0335", 256.6, 591.2, 50),
    textItem("N0444", 42.5, 564.2, 56),
    textItem("F350", 143.8, 564.2, 48),
    textItem("ABC", 256.3, 564.2, 21.6),
    textItem("DCT", 285.1, 564.2, 21.6),
    textItem("DEF", 313.9, 564.2, 21.6),
    textItem("LROP", 98.9, 422.5, 50),
    textItem("0308", 213.8, 422.5, 50),
    textItem("PBN/A1", 40.3, 396.2, 43.2),
    textItem("B1", 83.5, 396.2, 14.4),
    textItem(" DOF/260831", 97.9, 396.2, 79.2),
    textItem("NAV/RNP10 ", 40.3, 378.2, 72),
    textItem("RNAV1", 112.3, 378.2, 36),
    textItem("SUR/EUADSBX", 40.3, 360.2, 79.2),
    textItem(" ", 119.5, 360.2, 7.2),
    textItem("OPR/DOD", 126.7, 360.2, 50.4),
  ];

  const result = parseDd1801TextPages([{ width: 612, height: 792, items }]);
  assert.equal(
    result.data.item18.otherInformation,
    "PBN/A1B1 DOF/260831 NAV/RNP10 RNAV1 SUR/EUADSBX OPR/DOD",
  );
  assert.equal(result.data.item10.surveillance, "B1/X");
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(result.unreliableFields.includes("item10.surveillance"));
});

test("AcroForm mapping recognizes semantic names and keeps Item 10a/10b separate", () => {
  const result = mapAcroFormFields({
    "Aircraft Identification": [{ value: "FORM42" }],
    "Item 10": [{ value: "DE1E2FGHIJ5RSTUWXYZ/B1D1L" }],
    "Departure Aerodrome": [{ value: "EGPK" }],
    "Item 19 Dinghy Cover": [{ value: "Yes" }],
  });

  assert.equal(result.data.item7.aircraftIdentification, "FORM42");
  assert.equal(result.data.item10.equipment, "DE1E2FGHIJ5RSTUWXYZ");
  assert.equal(result.data.item10.surveillance, "B1D1L");
  assert.equal(result.data.item13.departure, "EGPK");
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
    Route: [{ value: "  SUDB1L.SUDBY\t DCS   L612 BARTN TOSVI.TOSV1E  " }],
    "Other Information": [{ value: "RMK/KEEP.THIS  SPACING" }],
  });

  assert.equal(
    result.data.item15.route,
    "SUDB1L SUDBY DCS L612 BARTN TOSVI TOSV1E",
  );
  assert.equal(result.data.item18.otherInformation, "RMK/KEEP.THIS  SPACING");
});

test("blank duplicate Item 10 widgets cannot erase a populated combined value", () => {
  const result = mapAcroFormFields({
    "Item 10": [{ value: "DE1E2FGHIJ5RSTUWXYZ/B1D1L" }],
    "Item 10a": [{ value: "" }],
    "Item 10b": [{ value: "" }],
  });

  assert.equal(result.data.item10.equipment, "DE1E2FGHIJ5RSTUWXYZ");
  assert.equal(result.data.item10.surveillance, "B1D1L");
  assert.ok(result.extractedFields.includes("item10.equipment"));
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(!result.reliableBlankFields.includes("item10.equipment"));
  assert.ok(!result.reliableBlankFields.includes("item10.surveillance"));
});

test("a multi-slash AcroForm Item 10 value is retained and flagged for review", () => {
  const result = mapAcroFormFields({ "Item 10": [{ value: "S/B1/X" }] });
  assert.equal(result.data.item10.equipment, "S");
  assert.equal(result.data.item10.surveillance, "B1/X");
  assert.ok(result.extractedFields.includes("item10.surveillance"));
  assert.ok(result.unreliableFields.includes("item10.surveillance"));
  assert.ok(result.warnings.some((warning) => /more than one slash/i.test(warning)));
});

test("AcroForm-only acceptance requires meaningful DD1801 field coverage", () => {
  const generic = mapAcroFormFields({ Route: [{ value: "ABC DEF" }] });
  assert.equal(hasReliableDd1801AcroCoverage(generic), false);

  const dd1801 = mapAcroFormFields({
    "Aircraft Identification": [{ value: "FORM42" }],
    "Flight Rules": [{ value: "I" }],
    "Type of Flight": [{ value: "M" }],
    "Aircraft Type": [{ value: "C17" }],
    "Item 10": [{ value: "S/B1" }],
    "Departure Aerodrome": [{ value: "EGPK" }],
  });
  assert.equal(hasReliableDd1801AcroCoverage(dd1801), true);
});

test("an unrelated one-field AcroForm PDF is rejected instead of treated as DD1801", async () => {
  await assert.rejects(
    () => extractDd1801Pdf(minimalAcroFormPdf("Route", "ABC DEF")),
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

const realPdfPath = process.env.DD1801_TEST_PDF;
test(
  "provided flattened electronic DD1801 maps exact operational sample values",
  { skip: realPdfPath ? false : "set DD1801_TEST_PDF to opt in; the operational PDF is not copied" },
  async () => {
    const result = await extractDd1801Pdf(new Uint8Array(await readFile(realPdfPath)));

    assert.equal(result.source, "text");
    assert.equal(result.pageCount, 1);
    assert.equal(result.data.item7.aircraftIdentification, "ELVIS63");
    assert.deepEqual(result.data.item8, { flightRules: "I", typeOfFlight: "M" });
    assert.deepEqual(result.data.item9, { number: "", aircraftType: "C17", wakeCategory: "H" });
    assert.deepEqual(result.data.item10, {
      equipment: "DE1E2FGHIJ5RSTUWXYZ",
      surveillance: "B1D1L",
    });
    assert.deepEqual(result.data.item13, { departure: "EGPK", time: "0335" });
    assert.equal(result.data.item15.speed, "N0444");
    assert.equal(result.data.item15.level, "F350");
    assert.equal(
      result.data.item15.route,
      "SUDB1L SUDBY DCS L612 BARTN MCT M16 DOLAS LAMSO PETIK PAM L620 OMELO PEPIK BERVA ERGOM TEGRI TOSVI TOSV1E",
    );
    assert.deepEqual(result.data.item16, {
      destination: "LROP",
      totalEet: "0308",
      alternate: "LRCK",
      secondAlternate: "",
    });
    assert.equal(
      result.data.item18.otherInformation,
      "STS/MARSA STATE PBN/A1B1C1D1L1O1S1 NAV/RNP10 RNAV1 RNAV5 RNVD1E2A1 DAT/1FANS CPDLCX SUR/EUADSBX DOF/260831 REG/10189A EET/EGTT0007 EHAA0046 EDVV0105 EDUU0123 LKAA0141 LZBB0204 LHCC0216 LRBB0233 SEL/EQLM CODE/AE10B8 RVR/800 OPR/DOD PER/D",
    );
    assert.equal(result.data.item19.endurance, "0604");
    assert.equal(result.data.item19.personsOnBoard, "004");
    assert.equal(result.data.item19.dinghies.number, "03");
    assert.equal(result.data.item19.dinghies.capacity, "138");
    assert.equal(result.data.item19.dinghies.color, "CERISE");
    assert.equal(result.data.item19.aircraftSerial, "01-0189");
    assert.equal(result.data.item19.aircraftType, "C17");
    assert.ok(result.reliableBlankFields.includes("item9.number"));
    assert.ok(result.reliableBlankFields.includes("item16.secondAlternate"));
    assert.ok(result.unreliableFields.includes("item19.radioFrequencies"));
    assert.ok(result.unreliableFields.includes("item19.survivalEquipment.global"));
    assert.ok(result.unreliableFields.includes("item19.lifeJackets.fluorescein"));
    assert.ok(result.unreliableFields.includes("item19.dinghies.carried"));
    assert.ok(!result.unreliableFields.includes("item19.lifeJackets.uhf"));
    assert.ok(!result.unreliableFields.includes("item19.lifeJackets.vhf"));

    const routeValidation = validateRoute(result.data.item15.route);
    assert.equal(
      routeValidation.route,
      "SUDB1L SUDBY DCS L612 BARTN DCT MCT M16 DOLAS DCT LAMSO DCT PETIK DCT PAM L620 OMELO DCT PEPIK DCT BERVA DCT ERGOM DCT TEGRI TOSVI TOSV1E",
    );
    setFieldValue(result.data, "item15.route", routeValidation.route);
    assert.match(
      buildFplMessage(result.data).message,
      /\n-N0444F350 SUDB1L SUDBY DCS L612 BARTN DCT MCT M16 DOLAS DCT LAMSO DCT PETIK DCT PAM L620 OMELO DCT PEPIK DCT BERVA DCT ERGOM DCT TEGRI TOSVI TOSV1E\n/,
    );
  },
);
