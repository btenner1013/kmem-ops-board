import { getFieldValue, validateFlightPlan } from "./flight-plan-core.js";

export const C17_MIL_IFR_PRESET = Object.freeze({
  name: "C-17 MIL IFR",
  messageType: "FPL",
  flightRules: "I",
  typeOfFlight: "M",
  aircraftType: "C17",
  wakeCategory: "H",
});

export const AISR_FIELD_DEFINITIONS = Object.freeze([
  { key: "messageType", label: "MESSAGE TYPE", presetKey: "messageType" },
  { key: "aircraftIdentification", label: "AIRCRAFT IDENTIFICATION", path: "item7.aircraftIdentification" },
  { key: "flightRules", label: "FLIGHT RULES", path: "item8.flightRules", presetKey: "flightRules" },
  { key: "typeOfFlight", label: "TYPE OF FLIGHT", path: "item8.typeOfFlight", presetKey: "typeOfFlight" },
  { key: "aircraftType", label: "TYPE OF AIRCRAFT", path: "item9.aircraftType", presetKey: "aircraftType" },
  { key: "wakeCategory", label: "WAKE TURBULENCE CATEGORY", path: "item9.wakeCategory", presetKey: "wakeCategory" },
  { key: "equipment", label: "FIELD 10 — EQUIPMENT", path: "item10.equipment" },
  { key: "surveillance", label: "FIELD 10 — SURVEILLANCE", path: "item10.surveillance" },
  { key: "departure", label: "DEPARTURE AERODROME", path: "item13.departure" },
  { key: "departureTime", label: "TIME", path: "item13.time" },
  { key: "speed", label: "CRUISING SPEED", path: "item15.speed" },
  { key: "level", label: "LEVEL", path: "item15.level" },
  { key: "route", label: "ROUTE", path: "item15.route" },
  { key: "destination", label: "DESTINATION AERODROME", path: "item16.destination" },
  { key: "totalEet", label: "TOTAL EET", path: "item16.totalEet" },
  { key: "alternate1", label: "ALTN AERODROME", path: "item16.alternate" },
  { key: "alternate2", label: "2ND ALTN AERODROME", path: "item16.secondAlternate" },
  { key: "field18", label: "FIELD 18 / OTHER INFORMATION", path: "item18.otherInformation" },
  { key: "endurance", label: "ENDURANCE", path: "item19.endurance" },
  { key: "personsOnBoard", label: "PERSONS ON BOARD", path: "item19.personsOnBoard" },
  { key: "emergencyRadio", label: "EMERGENCY RADIO", derived: true },
  { key: "survivalEquipment", label: "SURVIVAL EQUIPMENT", derived: true },
  { key: "lifeJackets", label: "LIFE JACKETS", derived: true },
  { key: "dinghies", label: "DINGHIES", derived: true },
  { key: "remarks", label: "REMARKS", derived: true },
  { key: "aircraftSerialNumbers", label: "AIRCRAFT SERIAL NUMBER(S)", path: "item19.aircraftSerial" },
  { key: "aircraftTypesInFlight", label: "AIRCRAFT TYPE(S) IN FLIGHT", path: "item19.aircraftType" },
  { key: "pilotInCommand", label: "PILOT IN COMMAND", derived: true },
  { key: "homeStationOrganization", label: "AIRCRAFT HOME STATION / ORGANIZATION", derived: true },
]);

const VALIDATORS = Object.freeze({
  messageType: value => value === "FPL",
  aircraftIdentification: value => /^[A-Z0-9]{1,7}$/.test(value),
  flightRules: value => /^[IVYZ]$/.test(value),
  typeOfFlight: value => /^[SNGMX]$/.test(value),
  aircraftType: value => /^[A-Z0-9]{2,4}$/.test(value),
  wakeCategory: value => /^[LMHJ]$/.test(value),
  equipment: value => /^[A-Z0-9]+$/.test(value) && !(value.length > 1 && value.includes("N")),
  surveillance: value => /^[A-Z0-9]+$/.test(value) && !(value.length > 1 && value.includes("N")),
  departure: value => /^(?:[A-Z]{4}|ZZZZ)$/.test(value),
  departureTime: value => /^(?:[01]\d|2[0-3])[0-5]\d$/.test(value),
  speed: value => /^(?:N\d{4}|K\d{4}|M\d{3})$/.test(value),
  level: value => /^(?:F\d{3}|A\d{3}|S\d{4}|M\d{4}|VFR)$/.test(value),
  route: value => /^[A-Z0-9/.\s]+$/.test(value),
  destination: value => /^(?:[A-Z]{4}|ZZZZ)$/.test(value),
  totalEet: value => /^\d{2}[0-5]\d$/.test(value),
  alternate1: value => /^(?:[A-Z]{4}|ZZZZ)$/.test(value),
  alternate2: value => /^(?:[A-Z]{4}|ZZZZ)$/.test(value),
  field18: value => /^[A-Z0-9\s/.,'+:]+$/.test(value),
  endurance: value => /^\d{2}[0-5]\d$/.test(value),
  personsOnBoard: value => /^(?:\d{1,3}|TBN)$/.test(value),
});

const PRESET_WARNING_LABELS = Object.freeze({
  flightRules: "FLIGHT RULES",
  typeOfFlight: "TYPE OF FLIGHT",
  aircraftType: "AIRCRAFT TYPE",
  wakeCategory: "WAKE CATEGORY",
});

function textValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "YES";
  return String(value).trim();
}

function canonicalPresetValue(key, value) {
  const text = textValue(value).toUpperCase();
  return key === "aircraftType" ? text.replace(/[^A-Z0-9]/g, "") : text;
}

function validateValue(key, value) {
  const validator = VALIDATORS[key];
  return typeof validator !== "function" || validator(value);
}

function unreliablePathSet(importResult, manuallyEditedPaths) {
  const edited = new Set(manuallyEditedPaths || []);
  return new Set(
    (Array.isArray(importResult?.unreliableFields) ? importResult.unreliableFields : [])
      .filter(path => !edited.has(path)),
  );
}

function sourceField(definition, plan, unreliablePaths) {
  const value = textValue(getFieldValue(plan, definition.path));
  const unreliable = unreliablePaths.has(definition.path);
  return { value, unreliable };
}

function warningForUnreliable(label) {
  return `${label} WAS NOT EXTRACTED RELIABLY — MANUAL REVIEW REQUIRED`;
}

function resolveField(definition, plan, unreliablePaths) {
  const presetValue = definition.presetKey
    ? textValue(C17_MIL_IFR_PRESET[definition.presetKey])
    : "";
  const source = definition.path
    ? sourceField(definition, plan, unreliablePaths)
    : { value: "", unreliable: false };

  if (source.value) {
    if (!validateValue(definition.key, source.value)) {
      return {
        value: source.value,
        copyValue: source.value,
        source: "FLIGHT PLAN",
        status: "INVALID",
        warning: `${definition.label} HAS AN INVALID OR UNSUPPORTED VALUE — SOURCE RETAINED`,
      };
    }

    if (presetValue && canonicalPresetValue(definition.key, source.value) !== canonicalPresetValue(definition.key, presetValue)) {
      const warningLabel = PRESET_WARNING_LABELS[definition.key] || definition.label;
      return {
        value: source.value,
        copyValue: source.value,
        source: "FLIGHT PLAN",
        status: "CONFLICT",
        warning: `${warningLabel} ${definition.key === "flightRules" ? "DIFFER" : "DIFFERS"} FROM C-17 MIL IFR PRESET — SOURCE VALUE RETAINED`,
      };
    }

    if (source.unreliable) {
      return {
        value: source.value,
        copyValue: source.value,
        source: "FLIGHT PLAN",
        status: "CONFLICT",
        warning: warningForUnreliable(definition.label),
      };
    }

    return {
      value: source.value,
      copyValue: source.value,
      source: "FLIGHT PLAN",
      status: "READY",
      warning: "",
    };
  }

  if (source.unreliable) {
    return {
      value: presetValue,
      copyValue: presetValue,
      source: presetValue ? "C-17 PRESET" : "NOT FOUND",
      status: "MANUAL REQUIRED",
      warning: presetValue
        ? `${definition.label} WAS NOT EXTRACTED RELIABLY — C-17 PRESET SHOWN FOR MANUAL REVIEW`
        : warningForUnreliable(definition.label),
    };
  }

  if (presetValue) {
    return {
      value: presetValue,
      copyValue: presetValue,
      source: "C-17 PRESET",
      status: "READY",
      warning: "",
    };
  }

  return {
    value: "",
    copyValue: "",
    source: "NOT FOUND",
    status: "MANUAL REQUIRED",
    warning: "",
  };
}

function checkedLabels(plan, entries) {
  return entries
    .filter(entry => getFieldValue(plan, entry.path) === true)
    .map(entry => entry.label);
}

function derivedValue(key, plan) {
  if (key === "emergencyRadio") {
    const values = checkedLabels(plan, [
      { path: "item19.emergencyRadio.frequency1215", label: "121.5 MHZ" },
      { path: "item19.emergencyRadio.frequency243", label: "243.0 MHZ" },
      { path: "item19.emergencyRadio.frequency500", label: "500 KHZ" },
      { path: "item19.emergencyRadio.frequency8364", label: "8364 KHZ" },
    ]);
    const other = textValue(getFieldValue(plan, "item19.radioFrequencies"));
    if (other) values.push(other);
    return values.join(", ");
  }

  if (key === "survivalEquipment") {
    return checkedLabels(plan, [
      { path: "item19.survivalEquipment.polar", label: "POLAR" },
      { path: "item19.survivalEquipment.desert", label: "DESERT" },
      { path: "item19.survivalEquipment.maritime", label: "MARITIME" },
      { path: "item19.survivalEquipment.jungle", label: "JUNGLE" },
      { path: "item19.survivalEquipment.global", label: "GLOBAL" },
    ]).join(", ");
  }

  if (key === "lifeJackets") {
    return checkedLabels(plan, [
      { path: "item19.lifeJackets.carried", label: "CARRIED" },
      { path: "item19.lifeJackets.lights", label: "LIGHTS" },
      { path: "item19.lifeJackets.fluorescein", label: "FLUORESCEIN" },
    ]).join(", ");
  }

  if (key === "dinghies") {
    const values = checkedLabels(plan, [
      { path: "item19.dinghies.carried", label: "CARRIED" },
      { path: "item19.dinghies.cover", label: "COVER" },
    ]);
    for (const [path, label] of [
      ["item19.dinghies.number", "NUMBER"],
      ["item19.dinghies.capacity", "CAPACITY"],
      ["item19.dinghies.color", "COLOR"],
    ]) {
      const value = textValue(getFieldValue(plan, path));
      if (value) values.push(`${label} ${value}`);
    }
    return values.join(" · ");
  }

  if (key === "remarks") {
    const item19Remarks = textValue(getFieldValue(plan, "item19.remarks"));
    return item19Remarks || extractField18Indicator(textValue(getFieldValue(plan, "item18.otherInformation")), "RMK");
  }

  if (key === "homeStationOrganization") {
    return extractField18Indicator(textValue(getFieldValue(plan, "item18.otherInformation")), "OPR");
  }

  return "";
}

function extractField18Indicator(field18, indicator) {
  if (!field18) return "";
  const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = field18.match(new RegExp(`(?:^|\\s)${escaped}/(.+?)(?=\\s+[A-Z0-9]{1,8}/|$)`, "i"));
  return textValue(match?.[1]);
}

function derivedSourcePaths(key, plan) {
  if (key === "emergencyRadio") {
    return [
      "item19.emergencyRadio.frequency1215",
      "item19.emergencyRadio.frequency243",
      "item19.emergencyRadio.frequency500",
      "item19.emergencyRadio.frequency8364",
      "item19.radioFrequencies",
    ];
  }
  if (key === "survivalEquipment") {
    return [
      "item19.survivalEquipment.polar",
      "item19.survivalEquipment.desert",
      "item19.survivalEquipment.maritime",
      "item19.survivalEquipment.jungle",
      "item19.survivalEquipment.global",
    ];
  }
  if (key === "lifeJackets") {
    return [
      "item19.lifeJackets.carried",
      "item19.lifeJackets.lights",
      "item19.lifeJackets.fluorescein",
    ];
  }
  if (key === "dinghies") {
    return [
      "item19.dinghies.carried",
      "item19.dinghies.cover",
      "item19.dinghies.number",
      "item19.dinghies.capacity",
      "item19.dinghies.color",
    ];
  }
  if (key === "remarks") {
    return textValue(getFieldValue(plan, "item19.remarks"))
      ? ["item19.remarks"]
      : ["item19.remarks", "item18.otherInformation"];
  }
  if (key === "homeStationOrganization") return ["item18.otherInformation"];
  return [];
}

function resolveDerivedField(definition, plan, unreliablePaths) {
  const value = derivedValue(definition.key, plan);
  const unreliable = derivedSourcePaths(definition.key, plan)
    .some(path => unreliablePaths.has(path));
  return {
    value,
    copyValue: value,
    source: value ? "FLIGHT PLAN" : "NOT FOUND",
    status: value ? (unreliable ? "CONFLICT" : "READY") : "MANUAL REQUIRED",
    warning: unreliable ? warningForUnreliable(definition.label) : "",
  };
}

function summarize(fields, structuralValidation) {
  return {
    total: fields.length,
    ready: fields.filter(field => field.status === "READY").length,
    fromFlightPlan: fields.filter(field => field.source === "FLIGHT PLAN").length,
    fromPreset: fields.filter(field => field.source === "C-17 PRESET").length,
    manualRequired: fields.filter(field => field.status === "MANUAL REQUIRED").length,
    conflicts: fields.filter(field => field.status === "CONFLICT").length,
    invalid: fields.filter(field => field.status === "INVALID").length,
    structuralErrors: structuralValidation.errors.length,
    structuralWarnings: structuralValidation.warnings.length,
  };
}

export function normalizeAisrPlan(plan, { importResult = null, manuallyEditedPaths = [] } = {}) {
  const unreliablePaths = unreliablePathSet(importResult, manuallyEditedPaths);
  const fields = AISR_FIELD_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    ...(definition.derived
      ? resolveDerivedField(definition, plan, unreliablePaths)
      : resolveField(definition, plan, unreliablePaths)),
  }));
  const structuralValidation = validateFlightPlan(plan);
  const summary = summarize(fields, structuralValidation);
  const warnings = [
    ...fields.map(field => field.warning).filter(Boolean),
    ...structuralValidation.errors.map(error => `FLIGHT PLAN VALIDATION ERROR — ${error}`),
    ...structuralValidation.warnings.map(warning => `FLIGHT PLAN VALIDATION WARNING — ${warning}`),
  ];
  const reviewRequired = summary.manualRequired > 0
    || summary.conflicts > 0
    || summary.invalid > 0
    || summary.structuralErrors > 0
    || summary.structuralWarnings > 0;

  return {
    schemaVersion: 1,
    presetName: C17_MIL_IFR_PRESET.name,
    fields,
    summary,
    overallStatus: reviewRequired ? "AISR REVIEW REQUIRED" : "AISR READY",
    warnings,
    structuralValidation,
  };
}

export function formatAisrSummary(normalized) {
  if (!normalized || !Array.isArray(normalized.fields)) {
    throw new TypeError("A normalized AISR review is required.");
  }

  const lines = [
    "AISR ASSISTANT",
    `PRESET: ${normalized.presetName}`,
    `STATUS: ${normalized.overallStatus}`,
    "",
  ];
  for (const field of normalized.fields) {
    lines.push(`${field.label}: ${field.value || "MANUAL REQUIRED"}`);
    lines.push(`  SOURCE: ${field.source} · STATUS: ${field.status}`);
    if (field.warning) lines.push(`  WARNING: ${field.warning}`);
  }
  const fieldWarnings = new Set(normalized.fields.map(field => field.warning).filter(Boolean));
  const additionalWarnings = (normalized.warnings || []).filter(warning => !fieldWarnings.has(warning));
  if (additionalWarnings.length) {
    lines.push("", "REVIEW WARNINGS:");
    for (const warning of additionalWarnings) lines.push(`- ${warning}`);
  }
  lines.push("", "AISR POPULATE-ONLY REVIEW DATA — USER MUST REVIEW AND MANUALLY FILE");
  return lines.join("\n");
}

export function serializeAisrTransferPayload(normalized) {
  if (!normalized || !Array.isArray(normalized.fields)) {
    throw new TypeError("A normalized AISR review is required.");
  }

  const fields = Object.fromEntries(normalized.fields.map(field => [field.key, {
    value: field.copyValue || "",
    source: field.source,
    status: field.status,
  }]));
  return JSON.stringify({
    schemaVersion: 1,
    target: "AISR",
    mode: "POPULATE_ONLY",
    filingAllowed: false,
    selectorMapping: {
      verified: false,
      profile: null,
    },
    presetName: normalized.presetName,
    overallStatus: normalized.overallStatus,
    reviewRequired: normalized.overallStatus !== "AISR READY",
    warnings: [...normalized.warnings],
    structuralValidation: {
      passed: normalized.structuralValidation?.passed === true,
      status: normalized.structuralValidation?.status || "UNKNOWN",
      errors: [...(normalized.structuralValidation?.errors || [])],
      warnings: [...(normalized.structuralValidation?.warnings || [])],
    },
    fields,
  }, null, 2);
}
