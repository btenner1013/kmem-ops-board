/**
 * Dependency-free flight-plan data, local checks, route formatting, and FPL
 * generation. This module deliberately contains no browser or persistence state.
 */

export const FIELD_PATHS = Object.freeze([
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
  "item19.radioFrequencies",
  "item19.remarks",
  "item19.aircraftSerial",
  "item19.aircraftType",
]);

const FIELD_PATH_SET = new Set(FIELD_PATHS);

/** Return a new, completely blank flight-plan model. */
export function createBlankFlightPlan() {
  return {
    item7: {
      aircraftIdentification: "",
    },
    item8: {
      flightRules: "",
      typeOfFlight: "",
    },
    item9: {
      number: "",
      aircraftType: "",
      wakeCategory: "",
    },
    item10: {
      equipment: "",
      surveillance: "",
    },
    item13: {
      departure: "",
      time: "",
    },
    item15: {
      speed: "",
      level: "",
      route: "",
    },
    item16: {
      destination: "",
      totalEet: "",
      alternate: "",
      secondAlternate: "",
    },
    item18: {
      otherInformation: "",
    },
    item19: {
      endurance: "",
      personsOnBoard: "",
      emergencyRadio: {
        frequency1215: false,
        frequency243: false,
        frequency500: false,
        frequency8364: false,
        other: "",
      },
      survivalEquipment: {
        polar: false,
        desert: false,
        maritime: false,
        jungle: false,
        global: false,
      },
      lifeJackets: {
        carried: false,
        lights: false,
        fluorescein: false,
        uhf: false,
        vhf: false,
      },
      dinghies: {
        carried: false,
        number: "",
        capacity: "",
        cover: false,
        color: "",
      },
      radioFrequencies: "",
      remarks: "",
      aircraftSerial: "",
      aircraftType: "",
    },
  };
}

/** Read a scalar field by one of the exported dot-separated paths. */
export function getFieldValue(model, path) {
  if (!model || typeof path !== "string" || !FIELD_PATH_SET.has(path)) {
    return undefined;
  }

  let current = model;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Mutate a model field by path and return the same model for convenient chaining.
 * Restricting writes to known operational leaves prevents accidental shape drift.
 */
export function setFieldValue(model, path, value) {
  if (!model || typeof model !== "object") {
    throw new TypeError("A flight-plan model object is required.");
  }
  if (!FIELD_PATH_SET.has(path)) {
    throw new RangeError(`Unknown flight-plan field path: ${String(path)}`);
  }

  const segments = path.split(".");
  const leaf = segments.pop();
  let current = model;
  for (const segment of segments) {
    if (!current[segment] || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[leaf] = value;
  return model;
}

/** True when any operational leaf contains non-whitespace text or a true flag. */
export function hasWorkingData(model) {
  return FIELD_PATHS.some((path) => {
    const value = getFieldValue(model, path);
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    return value !== undefined && value !== null && value !== "";
  });
}

const SPEED_PATTERN = /^(?:N\d{4}|K\d{4}|M\d{3})$/;
const LEVEL_PATTERN = /^(?:F\d{3}|A\d{3}|S\d{4}|M\d{4}|VFR)$/;
const SPEED_LEVEL_PATTERN = /^(?:N\d{4}|K\d{4}|M\d{3})(?:F\d{3}|A\d{3}|S\d{4}|M\d{4})$/;
const COORDINATE_PATTERN = /^(?:\d{2}[NS]\d{3}[EW]|\d{4}[NS]\d{5}[EW]|[A-Z]{2,3}\d{6})$/;
const AIRWAY_PATTERN = /^(?:[A-Z]{1,2}\d{1,4}[A-Z]?|NAT[A-Z])$/;
const PROCEDURE_PATTERN = /^(?:SID|STAR|[A-Z]{3,6}\d[A-Z]?)$/;
const PROCEDURE_TRANSITION_PATTERN = /^(?=.*\d)[A-Z0-9]{2,7}\.[A-Z0-9]{2,7}$/;
const POINT_PATTERN = /^[A-Z]{2,5}$/;
const ROUTE_MODIFIER_PATTERN = /^(?:IFR|VFR|OAT|GAT|C|T|CRZ|CLB|DES|RW\d{2}[LCR]?)$/;

/**
 * Classify one Item 15 token without changing it. Categories are intentionally
 * broad: the formatter only treats `point` and `coordinate` as point-like.
 */
export function classifyRouteToken(token) {
  if (typeof token !== "string" || token.trim() === "") {
    return "empty";
  }

  const normalized = token.trim().toUpperCase();
  if (normalized === "DCT") {
    return "dct";
  }
  if (SPEED_PATTERN.test(normalized) || LEVEL_PATTERN.test(normalized) || SPEED_LEVEL_PATTERN.test(normalized)) {
    return "modifier";
  }
  if (ROUTE_MODIFIER_PATTERN.test(normalized)) {
    return "modifier";
  }
  if (AIRWAY_PATTERN.test(normalized)) {
    return "airway";
  }
  if (PROCEDURE_PATTERN.test(normalized) || PROCEDURE_TRANSITION_PATTERN.test(normalized)) {
    return "procedure";
  }
  if (COORDINATE_PATTERN.test(normalized)) {
    return "coordinate";
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0 && slashIndex === normalized.lastIndexOf("/")) {
    const pointPart = normalized.slice(0, slashIndex);
    const modifierPart = normalized.slice(slashIndex + 1);
    const modifierIsRecognized =
      SPEED_PATTERN.test(modifierPart) ||
      LEVEL_PATTERN.test(modifierPart) ||
      SPEED_LEVEL_PATTERN.test(modifierPart);
    if (modifierIsRecognized) {
      if (COORDINATE_PATTERN.test(pointPart)) {
        return "coordinate";
      }
      if (POINT_PATTERN.test(pointPart)) {
        return "point";
      }
    }
  }

  if (POINT_PATTERN.test(normalized)) {
    return "point";
  }
  return "unknown";
}

function isPointLike(category) {
  return category === "point" || category === "coordinate";
}

function isBoundaryProcedureEnvelope(classified, pairIndex) {
  // Import-time cleanup expands dotted electronic-DD1801 procedure notation
  // such as SID.TRANSITION and TRANSITION.STAR into separate visible tokens.
  // Preserve the one point-to-point leg immediately inside a leading SID or
  // trailing STAR envelope instead of guessing that it requires DCT.
  const protectsLeadingProcedure =
    pairIndex === 1 && classified[0] === "procedure";
  const protectsTrailingProcedure =
    pairIndex === classified.length - 3 &&
    classified[classified.length - 1] === "procedure";
  return protectsLeadingProcedure || protectsTrailingProcedure;
}

/**
 * Conservatively insert DCT only between two confidently point-like tokens.
 * Original characters and whitespace remain byte-for-byte present; each change
 * consists solely of a new ` DCT` immediately before the existing separator.
 */
export function validateRoute(route) {
  const source = typeof route === "string" ? route : route == null ? "" : String(route);
  const matches = [...source.matchAll(/\S+/g)];
  const warnings = [];
  const warnedTokens = new Set();

  const classified = matches.map((match) => {
    const category = classifyRouteToken(match[0]);
    if (category === "unknown" && !warnedTokens.has(match[0])) {
      warnedTokens.add(match[0]);
      warnings.push(`Unrecognized route token "${match[0]}" was left unchanged.`);
    }
    return category;
  });

  if (matches.length < 2) {
    return { route: source, changed: false, insertedCount: 0, warnings };
  }

  let formatted = source.slice(0, matches[0].index);
  let insertedCount = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    formatted += match[0];

    if (index === matches.length - 1) {
      formatted += source.slice(match.index + match[0].length);
      break;
    }

    const nextMatch = matches[index + 1];
    if (
      isPointLike(classified[index]) &&
      isPointLike(classified[index + 1]) &&
      !isBoundaryProcedureEnvelope(classified, index)
    ) {
      formatted += " DCT";
      insertedCount += 1;
    }
    formatted += source.slice(match.index + match[0].length, nextMatch.index);
  }

  return {
    route: formatted,
    changed: insertedCount > 0,
    insertedCount,
    warnings,
  };
}

function textAt(model, path) {
  const value = getFieldValue(model, path);
  return value === undefined || value === null ? "" : String(value).trim();
}

function addRequired(errors, value, label) {
  if (value === "") {
    errors.push(`${label} is required.`);
    return false;
  }
  return true;
}

function addFormatError(errors, value, pattern, message) {
  if (value !== "" && !pattern.test(value)) {
    errors.push(message);
  }
}

/** Perform local syntax checks only; this is not operational route validation. */
export function validateFlightPlan(model) {
  const errors = [];
  const warnings = [];

  const aircraftIdentification = textAt(model, "item7.aircraftIdentification");
  const flightRules = textAt(model, "item8.flightRules");
  const typeOfFlight = textAt(model, "item8.typeOfFlight");
  const number = textAt(model, "item9.number");
  const aircraftType = textAt(model, "item9.aircraftType");
  const wakeCategory = textAt(model, "item9.wakeCategory");
  const equipment = textAt(model, "item10.equipment");
  const surveillance = textAt(model, "item10.surveillance");
  const departure = textAt(model, "item13.departure");
  const departureTime = textAt(model, "item13.time");
  const speed = textAt(model, "item15.speed");
  const level = textAt(model, "item15.level");
  const route = textAt(model, "item15.route");
  const destination = textAt(model, "item16.destination");
  const totalEet = textAt(model, "item16.totalEet");
  const alternate = textAt(model, "item16.alternate");
  const secondAlternate = textAt(model, "item16.secondAlternate");
  const otherInformation = textAt(model, "item18.otherInformation");

  if (addRequired(errors, aircraftIdentification, "Item 7 aircraft identification")) {
    addFormatError(
      errors,
      aircraftIdentification,
      /^[A-Z0-9]{1,7}$/,
      "Item 7 aircraft identification must contain 1-7 uppercase letters or digits.",
    );
  }

  if (addRequired(errors, flightRules, "Item 8 flight rules")) {
    addFormatError(errors, flightRules, /^[IVYZ]$/, "Item 8 flight rules must be I, V, Y, or Z.");
  }
  if (addRequired(errors, typeOfFlight, "Item 8 type of flight")) {
    addFormatError(errors, typeOfFlight, /^[SNGMX]$/, "Item 8 type of flight must be S, N, G, M, or X.");
  }

  addFormatError(errors, number, /^(?:[2-9]|[1-9]\d)$/, "Item 9 number of aircraft must be from 2 through 99, or blank for one aircraft.");
  if (addRequired(errors, aircraftType, "Item 9 aircraft type")) {
    addFormatError(errors, aircraftType, /^[A-Z0-9]{2,4}$/, "Item 9 aircraft type must contain 2-4 uppercase letters or digits.");
  }
  if (addRequired(errors, wakeCategory, "Item 9 wake turbulence category")) {
    addFormatError(errors, wakeCategory, /^[LMHJ]$/, "Item 9 wake turbulence category must be L, M, H, or J.");
  }

  if (addRequired(errors, equipment, "Item 10a equipment")) {
    addFormatError(errors, equipment, /^[A-Z0-9]+$/, "Item 10a equipment must contain only uppercase letters and digits, without a slash.");
    if (equipment.length > 1 && equipment.includes("N")) {
      errors.push("Item 10a equipment code N must be used by itself.");
    }
  }
  if (addRequired(errors, surveillance, "Item 10b surveillance")) {
    addFormatError(errors, surveillance, /^[A-Z0-9]+$/, "Item 10b surveillance must contain only uppercase letters and digits, without a slash.");
    if (surveillance.length > 1 && surveillance.includes("N")) {
      errors.push("Item 10b surveillance code N must be used by itself.");
    }
  }

  if (addRequired(errors, departure, "Item 13 departure aerodrome")) {
    addFormatError(errors, departure, /^[A-Z]{4}$/, "Item 13 departure aerodrome must be a four-letter ICAO designator.");
  }
  if (addRequired(errors, departureTime, "Item 13 time")) {
    addFormatError(errors, departureTime, /^(?:[01]\d|2[0-3])[0-5]\d$/, "Item 13 time must be a valid HHMM time from 0000 through 2359.");
  }

  if (addRequired(errors, speed, "Item 15 cruising speed")) {
    addFormatError(errors, speed, /^(?:N\d{4}|K\d{4}|M\d{3})$/, "Item 15 cruising speed must use Ndddd, Kdddd, or Mddd syntax.");
  }
  if (addRequired(errors, level, "Item 15 level")) {
    addFormatError(errors, level, /^(?:F\d{3}|A\d{3}|S\d{4}|M\d{4}|VFR)$/, "Item 15 level must use Fddd, Addd, Sdddd, Mdddd, or VFR syntax.");
  }
  if (addRequired(errors, route, "Item 15 route")) {
    if (!/^[A-Z0-9/.\s]+$/.test(route)) {
      errors.push("Item 15 route contains characters outside the supported uppercase ATS route syntax.");
    }
    const routeCheck = validateRoute(route);
    warnings.push(...routeCheck.warnings.map((warning) => `Item 15: ${warning}`));
    if (routeCheck.insertedCount > 0) {
      warnings.push(
        `Item 15 route has ${routeCheck.insertedCount} consecutive point pair${routeCheck.insertedCount === 1 ? "" : "s"} that may need DCT; use VALIDATE ROUTE to review.`,
      );
    }
  }

  if (addRequired(errors, destination, "Item 16 destination aerodrome")) {
    addFormatError(errors, destination, /^[A-Z]{4}$/, "Item 16 destination aerodrome must be a four-letter ICAO designator.");
  }
  if (addRequired(errors, totalEet, "Item 16 total EET")) {
    addFormatError(errors, totalEet, /^\d{2}[0-5]\d$/, "Item 16 total EET must use HHMM syntax with minutes from 00 through 59.");
  }
  addFormatError(errors, alternate, /^[A-Z]{4}$/, "Item 16 alternate aerodrome must be a four-letter ICAO designator.");
  addFormatError(errors, secondAlternate, /^[A-Z]{4}$/, "Item 16 second alternate aerodrome must be a four-letter ICAO designator.");
  if (secondAlternate !== "" && alternate === "") {
    errors.push("Item 16 alternate aerodrome is required when a second alternate is entered.");
  }

  if (addRequired(errors, otherInformation, "Item 18 other information")) {
    if (!/^[A-Z0-9\s/.,'+:]+$/.test(otherInformation)) {
      errors.push("Item 18 contains characters outside the supported uppercase ATS message syntax.");
    }
    if (otherInformation !== "0" && !/(?:^|\s)[A-Z]{2,5}\/[A-Z0-9]/.test(otherInformation)) {
      warnings.push("Item 18 is not 0 and does not begin with a recognizable indicator/value group; review it before use.");
    }
  }

  const passed = errors.length === 0;
  const status = !passed ? "ERROR" : warnings.length > 0 ? "WARNING" : "LOCAL CHECKS PASSED";
  return { errors, warnings, passed, status };
}

function compactWhitespace(value) {
  return value.trim().replace(/\s+/g, " ");
}

/** Build a transmitted FPL message. Item 19 is intentionally never appended. */
export function buildFplMessage(model) {
  const validation = validateFlightPlan(model);
  if (!validation.passed) {
    return { message: "", validation };
  }

  const aircraftIdentification = textAt(model, "item7.aircraftIdentification");
  const flightRules = textAt(model, "item8.flightRules");
  const typeOfFlight = textAt(model, "item8.typeOfFlight");
  const number = textAt(model, "item9.number");
  const aircraftType = textAt(model, "item9.aircraftType");
  const wakeCategory = textAt(model, "item9.wakeCategory");
  const equipment = textAt(model, "item10.equipment");
  const surveillance = textAt(model, "item10.surveillance");
  const departure = textAt(model, "item13.departure");
  const departureTime = textAt(model, "item13.time");
  const speed = textAt(model, "item15.speed");
  const level = textAt(model, "item15.level");
  const route = compactWhitespace(textAt(model, "item15.route"));
  const destination = textAt(model, "item16.destination");
  const totalEet = textAt(model, "item16.totalEet");
  const alternate = textAt(model, "item16.alternate");
  const secondAlternate = textAt(model, "item16.secondAlternate");
  const otherInformation = compactWhitespace(textAt(model, "item18.otherInformation"));

  const item16Suffix = [alternate, secondAlternate].filter(Boolean).join(" ");
  const lines = [
    `(FPL-${aircraftIdentification}-${flightRules}${typeOfFlight}`,
    `-${number}${aircraftType}/${wakeCategory}-${equipment}/${surveillance}`,
    `-${departure}${departureTime}`,
    `-${speed}${level} ${route}`,
    `-${destination}${totalEet}${item16Suffix ? ` ${item16Suffix}` : ""}`,
    `-${otherInformation})`,
  ];

  return { message: lines.join("\n"), validation };
}
