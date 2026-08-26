import {
  createBlankFlightPlan,
  FIELD_PATHS,
  getFieldValue,
  setFieldValue,
} from "./flight-plan-core.js";

const NORMALIZED_PAGE = Object.freeze({ width: 612, height: 792 });

/**
 * Scalar fields that may be populated by a DD Form 1801 import.  Keeping this
 * list explicit makes the PDF/UI boundary auditable and, in particular, keeps
 * Item 10a and Item 10b separate.
 */
export const CORE_IMPORT_FIELDS = Object.freeze([
  "item7.aircraftIdentification",
  "item8.flightRules",
  "item8.typeOfFlight",
  "item9.number",
  "item9.aircraftType",
  "item9.wakeCategory",
  "item10.equipment",
  "item10.surveillance",
  "item13.departure",
  "item13.time",
  "item15.speed",
  "item15.level",
  "item15.route",
  "item16.destination",
  "item16.totalEet",
  "item16.alternate",
  "item16.secondAlternate",
  "item18.otherInformation",
  "item19.endurance",
  "item19.personsOnBoard",
  "item19.radioFrequencies",
  "item19.remarks",
  "item19.aircraftSerial",
  "item19.aircraftType",
  "item19.emergencyRadio.frequency1215",
  "item19.emergencyRadio.frequency243",
  "item19.emergencyRadio.frequency500",
  "item19.emergencyRadio.frequency8364",
  "item19.emergencyRadio.other",
  "item19.survivalEquipment.polar",
  "item19.survivalEquipment.desert",
  "item19.survivalEquipment.maritime",
  "item19.survivalEquipment.jungle",
  "item19.survivalEquipment.global",
  "item19.lifeJackets.carried",
  "item19.lifeJackets.lights",
  "item19.lifeJackets.fluorescein",
  "item19.lifeJackets.uhf",
  "item19.lifeJackets.vhf",
  "item19.dinghies.carried",
  "item19.dinghies.number",
  "item19.dinghies.capacity",
  "item19.dinghies.cover",
  "item19.dinghies.color",
]);

// This flattened DD1801 uses strike-through graphics to indicate several Item
// 19 selections.  Those graphics are not represented faithfully in the text
// layer, so V1 deliberately does not guess their state.
const GRAPHICAL_ITEM19_FIELDS = Object.freeze([
  "item19.radioFrequencies",
  "item19.emergencyRadio.frequency1215",
  "item19.emergencyRadio.frequency243",
  "item19.emergencyRadio.frequency500",
  "item19.emergencyRadio.frequency8364",
  "item19.emergencyRadio.other",
  "item19.survivalEquipment.polar",
  "item19.survivalEquipment.desert",
  "item19.survivalEquipment.maritime",
  "item19.survivalEquipment.jungle",
  "item19.survivalEquipment.global",
  "item19.lifeJackets.carried",
  "item19.lifeJackets.lights",
  "item19.lifeJackets.fluorescein",
  "item19.lifeJackets.uhf",
  "item19.lifeJackets.vhf",
  "item19.dinghies.carried",
  "item19.dinghies.cover",
]);

const TEMPLATE_ANCHORS = Object.freeze([
  { text: "AIRCRAFT IDENTIFICATION", x: 207.5, y: 652, dx: 42, dy: 18 },
  { text: "DEPARTURE AERODROME", x: 85.4, y: 604, dx: 42, dy: 18 },
  { text: "CRUISING SPEED", x: 42.6, y: 580, dx: 42, dy: 18 },
  { text: "OTHER INFORMATION", x: 42.6, y: 411.2, dx: 42, dy: 18 },
  { text: "SUPPLEMENTARY INFORMATION", x: 238.7, y: 244, dx: 55, dy: 20 },
  { text: "DD FORM 1801", x: 25.3, y: 25, dx: 42, dy: 18 },
  { text: "DOD INTERNATIONAL FLIGHT PLAN", x: 400.3, y: 25, dx: 55, dy: 18 },
]);

const TEXT_REGIONS = Object.freeze([
  {
    path: "item7.aircraftIdentification",
    boxes: [{ x1: 190, x2: 325, y1: 632, y2: 648 }],
    mode: "compact",
  },
  {
    path: "item8.flightRules",
    boxes: [{ x1: 390, x2: 480, y1: 632, y2: 648 }],
    mode: "compact",
  },
  {
    path: "item8.typeOfFlight",
    boxes: [{ x1: 485, x2: 565, y1: 632, y2: 648 }],
    mode: "compact",
  },
  {
    path: "item9.number",
    boxes: [{ x1: 45, x2: 140, y1: 607, y2: 624 }],
    mode: "compact",
  },
  {
    path: "item9.aircraftType",
    boxes: [{ x1: 140, x2: 305, y1: 607, y2: 624 }],
    mode: "compact",
  },
  {
    path: "item9.wakeCategory",
    boxes: [{ x1: 315, x2: 430, y1: 607, y2: 624 }],
    mode: "compact",
  },
  {
    path: "item13.departure",
    boxes: [{ x1: 85, x2: 210, y1: 584, y2: 599 }],
    mode: "compact",
  },
  {
    path: "item13.time",
    boxes: [{ x1: 245, x2: 315, y1: 584, y2: 599 }],
    mode: "compact",
  },
  {
    path: "item15.speed",
    boxes: [{ x1: 35, x2: 130, y1: 556, y2: 573 }],
    mode: "compact",
  },
  {
    path: "item15.level",
    boxes: [{ x1: 135, x2: 225, y1: 556, y2: 573 }],
    mode: "compact",
  },
  {
    path: "item15.route",
    boxes: [
      { x1: 230, x2: 575, y1: 554, y2: 573 },
      { x1: 20, x2: 575, y1: 444, y2: 554 },
    ],
    mode: "words",
  },
  {
    path: "item16.destination",
    boxes: [{ x1: 65, x2: 205, y1: 414, y2: 430 }],
    mode: "compact",
  },
  {
    path: "item16.totalEet",
    boxes: [{ x1: 205, x2: 285, y1: 414, y2: 430 }],
    mode: "compact",
  },
  {
    path: "item16.alternate",
    boxes: [{ x1: 325, x2: 450, y1: 414, y2: 430 }],
    mode: "compact",
  },
  {
    path: "item16.secondAlternate",
    boxes: [{ x1: 450, x2: 570, y1: 414, y2: 430 }],
    mode: "compact",
  },
  {
    path: "item18.otherInformation",
    boxes: [{ x1: 20, x2: 570, y1: 280, y2: 405 }],
    mode: "words",
  },
  {
    path: "item19.endurance",
    boxes: [{ x1: 65, x2: 125, y1: 211, y2: 226 }],
    mode: "compact",
  },
  {
    path: "item19.personsOnBoard",
    boxes: [{ x1: 185, x2: 230, y1: 211, y2: 226 }],
    mode: "compact",
  },
  {
    path: "item19.remarks",
    boxes: [{ x1: 20, x2: 380, y1: 108, y2: 145 }],
    mode: "words",
  },
  {
    path: "item19.aircraftSerial",
    boxes: [{ x1: 380, x2: 570, y1: 108, y2: 135 }],
    mode: "words",
  },
  {
    path: "item19.aircraftType",
    boxes: [{ x1: 380, x2: 570, y1: 78, y2: 108 }],
    mode: "words",
  },
  {
    path: "item19.dinghies.color",
    boxes: [{ x1: 138, x2: 205, y1: 151, y2: 169 }],
    mode: "compact",
  },
]);

const ITEM10_BOXES = Object.freeze([
  { x1: 430, x2: 570, y1: 578, y2: 624 },
]);

const DINGHY_NUMBER_CAPACITY_BOXES = Object.freeze([
  { x1: 205, x2: 275, y1: 151, y2: 169 },
]);

const COMPACT_ACRO_FIELDS = new Set([
  "item7.aircraftIdentification",
  "item8.flightRules",
  "item8.typeOfFlight",
  "item9.number",
  "item9.aircraftType",
  "item9.wakeCategory",
  "item10.equipment",
  "item10.surveillance",
  "item13.departure",
  "item13.time",
  "item15.speed",
  "item15.level",
  "item16.destination",
  "item16.totalEet",
  "item16.alternate",
  "item16.secondAlternate",
  "item19.endurance",
  "item19.personsOnBoard",
  "item19.dinghies.number",
  "item19.dinghies.capacity",
  "item19.dinghies.color",
]);

const ACROFORM_ALIASES = Object.freeze({
  "item7.aircraftIdentification": [
    "item7aircraftidentification",
    "7aircraftidentification",
    "aircraftidentification",
    "aircraftid",
  ],
  "item8.flightRules": ["item8flightrules", "8flightrules", "flightrules"],
  "item8.typeOfFlight": ["item8typeofflight", "8typeofflight", "typeofflight"],
  "item9.number": ["item9number", "9number", "aircraftnumber", "numberofaircraft"],
  "item9.aircraftType": ["item9aircrafttype", "9aircrafttype", "typeofaircraft"],
  "item9.wakeCategory": [
    "item9wakecategory",
    "item9waketurbulencecategory",
    "9wakecategory",
    "waketurbulencecategory",
    "wakecategory",
  ],
  "item10.equipment": [
    "item10a",
    "10a",
    "item10aequipment",
    "10aequipment",
    "communicationnavigationequipment",
  ],
  "item10.surveillance": [
    "item10b",
    "10b",
    "item10bsurveillance",
    "10bsurveillance",
    "surveillanceequipment",
  ],
  "item13.departure": [
    "item13departure",
    "13departure",
    "departureaerodrome",
    "departure",
  ],
  "item13.time": ["item13time", "13time", "departuretime"],
  "item15.speed": ["item15speed", "15speed", "cruisingspeed"],
  "item15.level": ["item15level", "15level", "cruisinglevel", "level"],
  "item15.route": ["item15route", "15route", "route"],
  "item16.destination": [
    "item16destination",
    "16destination",
    "destinationaerodrome",
    "destination",
  ],
  "item16.totalEet": ["item16totaleet", "16totaleet", "totaleet", "eet"],
  "item16.alternate": [
    "item16alternate",
    "16alternate",
    "alternateaerodrome",
    "firstalternate",
  ],
  "item16.secondAlternate": [
    "item16secondalternate",
    "16secondalternate",
    "secondalternateaerodrome",
    "secondalternate",
    "2ndalternateaerodrome",
  ],
  "item18.otherInformation": [
    "item18otherinformation",
    "18otherinformation",
    "otherinformation",
    "item18",
  ],
  "item19.endurance": ["item19endurance", "19endurance", "endurance", "fuelendurance"],
  "item19.personsOnBoard": [
    "item19personsonboard",
    "19personsonboard",
    "personsonboard",
    "pob",
  ],
  "item19.radioFrequencies": [
    "item19radiofrequencies",
    "19radiofrequencies",
    "radiofrequencies",
  ],
  "item19.remarks": ["item19remarks", "19remarks", "supplementaryremarks"],
  "item19.aircraftSerial": [
    "item19aircraftserial",
    "19aircraftserial",
    "aircraftserialnumber",
    "aircraftserialnumbers",
  ],
  "item19.aircraftType": [
    "item19aircrafttype",
    "19aircrafttype",
    "aircrafttypeinflight",
  ],
  "item19.emergencyRadio.frequency1215": ["item19rdo1215", "rdo1215", "radio1215"],
  "item19.emergencyRadio.frequency243": ["item19rdo243", "rdo243", "radio243"],
  "item19.emergencyRadio.frequency500": ["item19rdo500", "rdo500", "radio500"],
  "item19.emergencyRadio.frequency8364": ["item19rdo8364", "rdo8364", "radio8364"],
  "item19.emergencyRadio.other": ["item19rdoother", "rdoother", "emergencyradioother"],
  "item19.survivalEquipment.polar": ["item19survivalpolar", "survivalpolar"],
  "item19.survivalEquipment.desert": ["item19survivaldesert", "survivaldesert"],
  "item19.survivalEquipment.maritime": ["item19survivalmaritime", "survivalmaritime"],
  "item19.survivalEquipment.jungle": ["item19survivaljungle", "survivaljungle"],
  "item19.survivalEquipment.global": ["item19survivalglobal", "survivalglobal"],
  "item19.lifeJackets.carried": ["item19lifejackets", "lifejacketscarried", "lifejackets"],
  "item19.lifeJackets.lights": ["item19jacketlights", "lifejacketlights", "jacketlights"],
  "item19.lifeJackets.fluorescein": [
    "item19jacketfluorescein",
    "lifejacketfluorescein",
    "jacketfluorescein",
  ],
  "item19.lifeJackets.uhf": ["item19jacketuhf", "lifejacketuhf", "jacketuhf"],
  "item19.lifeJackets.vhf": ["item19jacketvhf", "lifejacketvhf", "jacketvhf"],
  "item19.dinghies.carried": ["item19dinghies", "dinghiescarried", "dinghies"],
  "item19.dinghies.number": ["item19dinghynumber", "dinghynumber", "numberofdinghies"],
  "item19.dinghies.capacity": [
    "item19dinghycapacity",
    "dinghycapacity",
    "capacityofdinghies",
  ],
  "item19.dinghies.cover": ["item19dinghycover", "dinghycover"],
  "item19.dinghies.color": ["item19dinghycolor", "dinghycolor", "dinghycolour"],
});

const COMBINED_ITEM10_ALIASES = new Set([
  "item10",
  "10",
  "item10equipment",
  "10equipment",
  "equipment",
  "equipmentandsurveillance",
  "item10equipmentandsurveillance",
]);

const BOOLEAN_PATHS = new Set(
  CORE_IMPORT_FIELDS.filter((path) => {
    const blank = createBlankFlightPlan();
    return typeof getFieldValue(blank, path) === "boolean";
  }),
);

const DECLARED_FIELD_PATHS = new Set(
  Array.isArray(FIELD_PATHS) ? FIELD_PATHS : Object.values(FIELD_PATHS || {}),
);

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeMatchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeAcroName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeWords(value) {
  return String(value ?? "")
    .replace(/[\u25b8\u25ba\u2192]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompact(value) {
  return String(value ?? "")
    .replace(/[\u25b8\u25ba\u2192]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeImportedItem15Route(value) {
  // Electronic DD1801 generators use periods to join procedure/transition
  // route components. The editable import deliberately presents those as ATS
  // route tokens; no other imported field receives this punctuation cleanup.
  return String(value ?? "")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPopulated(value) {
  return typeof value === "boolean" ? value : String(value ?? "").trim() !== "";
}

function splitOnce(value, delimiter = "/") {
  const index = value.indexOf(delimiter);
  if (index < 0) return [value, null];
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

function safeSet(data, path, value) {
  if (DECLARED_FIELD_PATHS.size && !DECLARED_FIELD_PATHS.has(path)) {
    throw new Error(`DD1801 mapping references an unknown core field: ${path}`);
  }
  setFieldValue(data, path, value);
}

function createPartialResult(source, pageCount = 0) {
  return {
    data: createBlankFlightPlan(),
    source,
    extractedFields: [],
    reliableBlankFields: [],
    unreliableFields: [],
    warnings: [],
    pageCount,
  };
}

function addMappedValue(result, path, value) {
  safeSet(result.data, path, value);
  if (isPopulated(value)) {
    result.extractedFields.push(path);
  } else {
    result.reliableBlankFields.push(path);
  }
}

function normalizeTextItem(item, scaleX, scaleY) {
  const transform = Array.isArray(item?.transform) ? item.transform : null;
  const x = Number.isFinite(item?.x) ? item.x : transform?.[4];
  const y = Number.isFinite(item?.y) ? item.y : transform?.[5];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    str: String(item?.str ?? ""),
    x: x * scaleX,
    y: y * scaleY,
    width: (Number.isFinite(item?.width) ? item.width : 0) * scaleX,
    height: (Number.isFinite(item?.height) ? item.height : 0) * scaleY,
  };
}

function normalizeTextPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("Automatic DD1801 extraction was unsuccessful: the PDF has no readable pages.");
  }

  return pages.map((page, index) => {
    const width = Number(page?.width ?? page?.viewport?.width ?? NORMALIZED_PAGE.width);
    const height = Number(page?.height ?? page?.viewport?.height ?? NORMALIZED_PAGE.height);
    const items = page?.items ?? page?.textContent?.items;

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Automatic DD1801 extraction was unsuccessful: page ${index + 1} has invalid dimensions.`);
    }
    if (!Array.isArray(items)) {
      throw new Error(`Automatic DD1801 extraction was unsuccessful: page ${index + 1} has no text layer.`);
    }

    const aspect = width / height;
    const expectedAspect = NORMALIZED_PAGE.width / NORMALIZED_PAGE.height;
    if (Math.abs(aspect - expectedAspect) > 0.035) {
      throw new Error(
        `Automatic DD1801 extraction was unsuccessful: page ${index + 1} is not the expected 612x792 DD1801 layout.`,
      );
    }

    const scaleX = NORMALIZED_PAGE.width / width;
    const scaleY = NORMALIZED_PAGE.height / height;
    return {
      items: items
        .map((item) => normalizeTextItem(item, scaleX, scaleY))
        .filter((item) => item && item.str !== ""),
      pageNumber: index + 1,
    };
  });
}

function findTemplatePage(pages) {
  let best = null;

  for (const page of pages) {
    const found = TEMPLATE_ANCHORS.filter((anchor) => {
      const expected = normalizeMatchText(anchor.text);
      return page.items.some((item) => {
        const actual = normalizeMatchText(item.str);
        return (
          actual.includes(expected) &&
          Math.abs(item.x - anchor.x) <= anchor.dx &&
          Math.abs(item.y - anchor.y) <= anchor.dy
        );
      });
    });
    if (!best || found.length > best.found.length) best = { page, found };
  }

  if (!best || best.found.length !== TEMPLATE_ANCHORS.length) {
    const foundTexts = new Set(best?.found.map((anchor) => anchor.text) ?? []);
    const missing = TEMPLATE_ANCHORS.filter((anchor) => !foundTexts.has(anchor.text)).map(
      (anchor) => anchor.text,
    );
    throw new Error(
      `Automatic DD1801 extraction was unsuccessful: the positioned text does not match the supported DD Form 1801 template (missing/misplaced anchors: ${missing.join(
        ", ",
      )}). Manual entry is required.`,
    );
  }

  return best.page;
}

function itemInBox(item, box) {
  const centerX = item.x + item.width / 2;
  return centerX >= box.x1 && centerX <= box.x2 && item.y >= box.y1 && item.y <= box.y2;
}

function groupItemsIntoLines(items) {
  const lines = [];
  const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);

  for (const item of ordered) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 3.5);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => line.items.sort((a, b) => a.x - b.x));
}

function joinPositionedLine(items) {
  let joined = "";
  let previous = null;
  let explicitWhitespaceBoundary = false;

  for (const item of items) {
    const rawText = item.str;
    const text = rawText.trim();
    if (!text) {
      if (/\s/.test(rawText)) explicitWhitespaceBoundary = true;
      continue;
    }
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const previousGlyphWidth = previous.str.trim()
        ? previous.width / previous.str.trim().length
        : 0;
      const currentGlyphWidth = text ? item.width / text.length : 0;
      const measuredGlyphWidths = [previousGlyphWidth, currentGlyphWidth].filter(
        (width) => Number.isFinite(width) && width > 0,
      );
      const typicalGlyphWidth = measuredGlyphWidths.length
        ? measuredGlyphWidths.reduce((sum, width) => sum + width, 0) / measuredGlyphWidths.length
        : 0;

      // Adjacent PDF text runs can be fragments of one lexical token. Preserve
      // a word boundary only when geometry shows a visible gap; unknown widths
      // default to a space so we never invent a merged token without evidence.
      const hasExplicitWhitespace =
        explicitWhitespaceBoundary || /\s$/.test(previous.str) || /^\s/.test(rawText);
      if (
        hasExplicitWhitespace ||
        typicalGlyphWidth === 0 ||
        gap > Math.max(1.5, typicalGlyphWidth * 0.25)
      ) {
        joined += " ";
      }
    }
    joined += text;
    previous = item;
    explicitWhitespaceBoundary = false;
  }

  return joined;
}

function extractBoxes(page, boxes, mode) {
  const selected = page.items.filter(
    (item) => !/[\u25b8\u25ba\u2192]/.test(item.str) && boxes.some((box) => itemInBox(item, box)),
  );
  const lines = groupItemsIntoLines(selected);
  if (mode === "compact") {
    return normalizeCompact(lines.flat().map((item) => item.str).join(""));
  }
  return normalizeWords(
    lines
      .map((line) => joinPositionedLine(line))
      .join(" "),
  );
}

/**
 * Parse positioned PDF.js text-content pages for the supported flattened
 * electronic DD1801. Coordinates are normalized to the form's native 612x792
 * point system before any field boxes are evaluated.
 */
export function parseDd1801TextPages(pages) {
  const normalizedPages = normalizeTextPages(pages);
  const page = findTemplatePage(normalizedPages);
  const result = createPartialResult("text", normalizedPages.length);

  for (const region of TEXT_REGIONS) {
    let value = extractBoxes(page, region.boxes, region.mode);
    if (region.path === "item15.route") value = normalizeImportedItem15Route(value);
    if (region.path === "item18.otherInformation") value = value.replace(/\)+$/, "").trim();
    addMappedValue(result, region.path, value);
  }

  const item10 = extractBoxes(page, ITEM10_BOXES, "compact");
  if (!item10) {
    addMappedValue(result, "item10.equipment", "");
    addMappedValue(result, "item10.surveillance", "");
  } else {
    const [equipment, surveillance] = splitOnce(item10);
    addMappedValue(result, "item10.equipment", equipment);
    if (surveillance === null) {
      result.unreliableFields.push("item10.surveillance");
      result.warnings.push(
        "Item 10 text did not contain a slash; equipment was retained, but surveillance was not populated.",
      );
    } else {
      addMappedValue(result, "item10.surveillance", surveillance);
      if (surveillance.includes("/")) {
        result.warnings.push(
          "Item 10 contained more than one slash. It was split once; review the surveillance value.",
        );
        result.unreliableFields.push("item10.surveillance");
      }
    }
  }

  const dinghyNumberCapacity = extractBoxes(page, DINGHY_NUMBER_CAPACITY_BOXES, "compact");
  if (!dinghyNumberCapacity) {
    addMappedValue(result, "item19.dinghies.number", "");
    addMappedValue(result, "item19.dinghies.capacity", "");
  } else {
    const [number, capacity] = splitOnce(dinghyNumberCapacity);
    if (capacity === null) {
      result.unreliableFields.push(
        "item19.dinghies.number",
        "item19.dinghies.capacity",
      );
      result.warnings.push(
        "Item 19 dinghy number/capacity text did not contain the expected slash and was not populated.",
      );
    } else {
      addMappedValue(result, "item19.dinghies.number", number);
      addMappedValue(result, "item19.dinghies.capacity", capacity);
    }
  }

  result.unreliableFields.push(...GRAPHICAL_ITEM19_FIELDS);
  result.warnings.push(
    "Flattened Item 19 radio, survival-equipment, life-jacket, dinghy-carried, and dinghy-cover selections are graphical and were not guessed.",
  );
  result.extractedFields = uniqueSorted(result.extractedFields);
  result.reliableBlankFields = uniqueSorted(
    result.reliableBlankFields.filter((path) => !result.extractedFields.includes(path)),
  );
  result.unreliableFields = uniqueSorted(result.unreliableFields);
  result.warnings = [...new Set(result.warnings)];
  return result;
}

function flattenAcroFields(fields) {
  if (!fields) return [];
  const entries = fields instanceof Map ? [...fields.entries()] : Object.entries(fields);
  const flattened = [];

  for (const [fallbackName, raw] of entries) {
    const widgets = Array.isArray(raw) ? raw : [raw];
    if (widgets.length === 0) flattened.push({ name: fallbackName, raw: "" });
    for (const widget of widgets) {
      const name =
        widget && typeof widget === "object"
          ? widget.fullName ?? widget.fieldName ?? widget.name ?? fallbackName
          : fallbackName;
      flattened.push({ name, raw: widget });
    }
  }
  return flattened;
}

function rawAcroValue(raw) {
  if (raw == null || typeof raw !== "object") return raw;
  for (const key of ["value", "fieldValue", "V", "checked"]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return raw[key];
  }
  return "";
}

function chooseAcroEntry(entries, aliases) {
  const aliasSet = new Set(aliases);
  const matches = entries.filter((entry) => aliasSet.has(normalizeAcroName(entry.name)));
  if (!matches.length) return null;

  // PDF.js may expose one entry per widget. Prefer an explicitly populated
  // widget over an /Off or empty sibling.
  return (
    matches.find((entry) => {
      const value = rawAcroValue(entry.raw);
      return value === true || (typeof value === "string" && value.trim() && value !== "Off");
    }) ?? matches[0]
  );
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["yes", "on", "true", "1", "checked", "selected", "x"].includes(normalized)) return true;
  if (["", "no", "off", "false", "0", "unchecked", "none"].includes(normalized)) return false;
  return null;
}

function normalizeAcroValue(path, value) {
  if (BOOLEAN_PATHS.has(path)) return coerceBoolean(value);
  const text = String(value ?? "").trim();
  if (path === "item15.route") return normalizeImportedItem15Route(text);
  return COMPACT_ACRO_FIELDS.has(path) ? normalizeCompact(text) : text;
}

/**
 * Map semantic AcroForm field names into the normalized flight-plan model.
 * Unknown/generic field names are ignored instead of being position-guessed.
 */
export function mapAcroFormFields(fields) {
  const result = createPartialResult("acroform", 0);
  const entries = flattenAcroFields(fields);

  const combinedItem10 = chooseAcroEntry(entries, COMBINED_ITEM10_ALIASES);
  if (combinedItem10) {
    const combined = normalizeCompact(rawAcroValue(combinedItem10.raw));
    if (!combined) {
      result.reliableBlankFields.push("item10.equipment", "item10.surveillance");
    } else {
      const [equipment, surveillance] = splitOnce(combined);
      addMappedValue(result, "item10.equipment", equipment);
      if (surveillance === null) {
        result.unreliableFields.push("item10.surveillance");
        result.warnings.push(
          "The AcroForm Item 10 value did not contain a slash; review surveillance manually.",
        );
      } else {
        addMappedValue(result, "item10.surveillance", surveillance);
        if (surveillance.includes("/")) {
          result.unreliableFields.push("item10.surveillance");
          result.warnings.push(
            "The AcroForm Item 10 value contained more than one slash and was split only once.",
          );
        }
      }
    }
  }

  for (const [path, aliases] of Object.entries(ACROFORM_ALIASES)) {
    const entry = chooseAcroEntry(entries, aliases);
    if (!entry) continue;
    const value = normalizeAcroValue(path, rawAcroValue(entry.raw));
    if (value === null) {
      result.unreliableFields.push(path);
      result.warnings.push(`AcroForm field ${entry.name} had an unsupported selection value.`);
      continue;
    }

    // Some generators expose Item 10 both as a combined widget and as two
    // component widgets. An empty component is not allowed to erase a value
    // already recovered from the populated combined widget.
    const existingValue = getFieldValue(result.data, path);
    if (
      (path === "item10.equipment" || path === "item10.surveillance") &&
      isPopulated(existingValue) &&
      !isPopulated(value)
    ) {
      continue;
    }
    if (
      (path === "item10.equipment" || path === "item10.surveillance") &&
      isPopulated(existingValue) &&
      isPopulated(value) &&
      String(existingValue) !== String(value)
    ) {
      result.warnings.push(
        `AcroForm ${path === "item10.equipment" ? "Item 10a" : "Item 10b"} differed from the combined Item 10 value; the populated component widget was used.`,
      );
    }
    addMappedValue(result, path, value);
  }

  if (entries.length && !result.extractedFields.length && !result.reliableBlankFields.length) {
    result.warnings.push(
      "The PDF contains form fields, but their names do not match supported DD1801 field names.",
    );
  }

  result.extractedFields = uniqueSorted(result.extractedFields);
  result.reliableBlankFields = uniqueSorted(
    result.reliableBlankFields.filter((path) => !result.extractedFields.includes(path)),
  );
  result.unreliableFields = uniqueSorted(result.unreliableFields);
  result.warnings = [...new Set(result.warnings)];
  return result;
}

async function toPdfBytes(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (input && typeof input.arrayBuffer === "function") {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new TypeError("DD1801 input must be a PDF File, Blob, ArrayBuffer, or typed array.");
}

async function loadPdfJs() {
  const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "./vendor/pdfjs/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
  }
  return pdfjs;
}

function mappedFieldSet(result) {
  return new Set([...result.extractedFields, ...result.reliableBlankFields]);
}

/**
 * Require meaningful DD1801 coverage before trusting AcroForm-only mapping.
 * Generic names such as "route" or "departure" occur in unrelated PDFs, so a
 * single alias match is not sufficient evidence that the document is DD1801.
 */
export function hasReliableDd1801AcroCoverage(result) {
  if (!result) return false;
  const known = mappedFieldSet(result);
  const itemGroups = new Set([...known].map((path) => path.split(".")[0]));
  const hasIdentityBlock =
    known.has("item7.aircraftIdentification") ||
    (known.has("item8.flightRules") && known.has("item8.typeOfFlight"));
  const hasOperationalBlock = [...known].some((path) =>
    /^(?:item13|item15|item16|item18)\./.test(path),
  );

  return known.size >= 6 && itemGroups.size >= 4 && hasIdentityBlock && hasOperationalBlock;
}

function combineResults(acro, textResult, pageCount, extraWarnings) {
  const result = createPartialResult(
    acro && textResult ? "acroform+text" : acro ? "acroform" : "text",
    pageCount,
  );

  if (textResult) {
    const textKnown = mappedFieldSet(textResult);
    const textCopyPaths = new Set([...textKnown, ...textResult.unreliableFields]);
    for (const path of textCopyPaths) {
      const value = getFieldValue(textResult.data, path);
      if (textKnown.has(path) || isPopulated(value)) safeSet(result.data, path, value);
    }
  }

  // Only populated AcroForm values override text. Empty form widgets are a
  // fallback opportunity, not permission to erase visible embedded text.
  if (acro) {
    const acroCopyPaths = new Set([...acro.extractedFields, ...acro.unreliableFields]);
    for (const path of acroCopyPaths) {
      const value = getFieldValue(acro.data, path);
      if (isPopulated(value)) safeSet(result.data, path, value);
    }
  }

  for (const path of CORE_IMPORT_FIELDS) {
    const value = getFieldValue(result.data, path);
    if (isPopulated(value)) result.extractedFields.push(path);
  }

  const reliableBlank = new Set([
    ...(textResult?.reliableBlankFields ?? []),
    ...(acro?.reliableBlankFields ?? []),
  ]);
  const unreliable = new Set([
    ...(textResult?.unreliableFields ?? []),
    ...(acro?.unreliableFields ?? []),
  ]);
  const acroKnown = acro ? mappedFieldSet(acro) : new Set();
  const acroUnreliable = new Set(acro?.unreliableFields ?? []);

  for (const path of result.extractedFields) {
    reliableBlank.delete(path);
  }
  for (const path of acroKnown) {
    if (!acroUnreliable.has(path) && acro?.extractedFields.includes(path)) {
      unreliable.delete(path);
    }
  }

  result.extractedFields = uniqueSorted(result.extractedFields);
  result.reliableBlankFields = uniqueSorted(reliableBlank);
  result.unreliableFields = uniqueSorted(unreliable);
  result.warnings = [
    ...new Set([
      ...(extraWarnings ?? []),
      ...(acro?.warnings ?? []),
      ...(textResult?.warnings ?? []),
    ]),
  ];
  return result;
}

/**
 * Extract an electronically generated DD1801 entirely in the browser.  No OCR,
 * network request, or external service is used.
 */
export async function extractDd1801Pdf(input) {
  const bytes = await toPdfBytes(input);
  if (!bytes.length) throw new Error("Automatic DD1801 extraction was unsuccessful: the PDF is empty.");

  let pdf;
  try {
    const pdfjs = await loadPdfJs();
    pdf = await pdfjs.getDocument({ data: bytes }).promise;
  } catch (error) {
    throw new Error(
      `Automatic DD1801 extraction was unsuccessful: PDF.js could not open the file (${error?.message ?? error}).`,
      { cause: error },
    );
  }

  const warnings = [];
  try {
    let fieldObjects = null;
    if (typeof pdf.getFieldObjects === "function") {
      try {
        fieldObjects = await pdf.getFieldObjects();
      } catch (error) {
        warnings.push(`AcroForm fields could not be read: ${error?.message ?? error}`);
      }
    }
    const acroAttempt = mapAcroFormFields(fieldObjects);
    const acroKnownCount = mappedFieldSet(acroAttempt).size;
    const acroUsable = hasReliableDd1801AcroCoverage(acroAttempt);
    if (acroKnownCount > 0 && !acroUsable) {
      warnings.push(
        `AcroForm mapping covered only ${acroKnownCount} supported field${acroKnownCount === 1 ? "" : "s"} without enough DD1801 structure to trust it.`,
      );
    }

    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({ width: viewport.width, height: viewport.height, items: content.items });
      if (typeof page.cleanup === "function") page.cleanup();
    }

    let textResult = null;
    let textError = null;
    try {
      textResult = parseDd1801TextPages(pages);
    } catch (error) {
      textError = error;
    }

    if (!acroUsable && !textResult) {
      throw new Error(
        `Automatic DD1801 extraction was unsuccessful. No reliably identified DD1801 AcroForm was found, and positioned embedded text was not reliable (${textError?.message ?? "no readable text layer"}). Manual entry is required.`,
        { cause: textError },
      );
    }

    if (acroUsable && !textResult && textError) {
      warnings.push(`Positioned text fallback was not used: ${textError.message}`);
    }
    if (!acroUsable && textResult) {
      warnings.push("No reliably identified DD1801 AcroForm was found; positioned embedded text was used.");
    }

    return combineResults(
      acroUsable ? acroAttempt : null,
      textResult,
      pdf.numPages,
      warnings,
    );
  } finally {
    if (pdf && typeof pdf.destroy === "function") await pdf.destroy();
  }
}
