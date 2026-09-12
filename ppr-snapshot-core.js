/**
 * Dependency-free, browser-safe PPR CSV parsing and normalization.
 *
 * This module deliberately has no DOM, network, storage, file-system, or
 * persistence APIs. Callers provide CSV text already read from a local file;
 * only the explicit display allowlist below is returned.
 */

export class PprCsvError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PprCsvError";
    this.code = code;
    this.details = details;
  }
}

export const PPR_STATUS = Object.freeze({
  APPROVED: "approved",
  CANCELLED: "cancelled",
});

export const MAX_PPR_SOURCE_ROWS = 10_000;
export const MAX_PPR_SNAPSHOT_RECORDS = 1_000;

const FIELD_DEFINITIONS = Object.freeze([
  { key: "status", label: "Email Status", required: true, aliases: ["Email Status"] },
  { key: "julian", label: "Julian", required: true, aliases: ["Julian", "Julian Date", "PPR Julian"] },
  {
    key: "sequence",
    label: "Sequence",
    required: true,
    aliases: ["Sequence", "Sequence Number", "PPR Sequence"],
  },
  { key: "callsign", label: "Callsign", required: true, aliases: ["Callsign", "Call Sign"] },
  {
    key: "aircraftType",
    label: "Aircraft Type",
    required: true,
    aliases: ["Aircraft Type", "Acft Type"],
  },
  {
    key: "requestType",
    label: "Request Type",
    required: true,
    aliases: ["Request Type", "Type of Request"],
  },
  { key: "origin", label: "Origin", required: true, aliases: ["Origin"] },
  { key: "destination", label: "Destination", required: true, aliases: ["Destination"] },
  {
    key: "arrivalDateLocal",
    label: "Arrival Date (L)",
    required: true,
    aliases: ["Arrival Date (L)", "Arrival Date Local", "Local Arrival Date"],
  },
  {
    key: "arrivalTimeLocal",
    label: "Arrival Time (L)",
    required: true,
    aliases: ["Arrival Time (L)", "Arrival Time Local", "Local Arrival Time"],
  },
  {
    key: "arrivalTimeZulu",
    label: "Arrival Time (z)",
    required: true,
    aliases: ["Arrival Time (z)", "Arrival Time Z", "Arrival Time Zulu", "Zulu Arrival Time"],
  },
  {
    key: "departureDateLocal",
    label: "Departure Date (L)",
    required: true,
    aliases: ["Departure Date (L)", "Departure Date Local", "Local Departure Date"],
  },
  {
    key: "departureTimeLocal",
    label: "Departure Time (L)",
    required: true,
    aliases: ["Departure Time (L)", "Departure Time Local", "Local Departure Time"],
  },
  {
    key: "departureTimeZulu",
    label: "Departure Time (z)",
    required: true,
    aliases: ["Departure Time (z)", "Departure Time Z", "Departure Time Zulu", "Zulu Departure Time"],
  },
  {
    key: "homeStation",
    label: "Acft Homestation",
    required: true,
    aliases: ["Acft Homestation", "Aircraft Homestation", "Home Station"],
  },
  {
    key: "tailNumbers",
    label: "Tail/Reg Number(s)",
    required: true,
    aliases: ["Tail/Reg Number(s)", "Tail Reg Number(s)", "Tail/Reg Number", "Tail Numbers", "Tail Number"],
  },
  { key: "vipCode", label: "VIP Code", required: true, aliases: ["VIP Code", "VIP"] },
  { key: "fuel", label: "Fuel", required: false, aliases: ["Fuel", "Fuel:"] },
  {
    key: "transportation",
    label: "Trans",
    required: false,
    aliases: ["Trans", "Trans:", "Transportation", "Transportation Requirements"],
  },
  { key: "passengers", label: "Pax", required: false, aliases: ["Pax", "Pax:", "Passengers"] },
  {
    key: "specialRequirements",
    label: "Special Requirements",
    required: false,
    aliases: ["Special Requirements", "Special Requirements:"],
  },
  {
    key: "explosivesDeclared",
    label: "Explosives Declared",
    required: false,
    aliases: ["Explosives Declared"],
  },
  {
    key: "explosiveDetails",
    label: "Explosive Details",
    required: false,
    aliases: ["Explosive Details"],
  },
  {
    key: "otherHazmatDetails",
    label: "Other HAZMAT Details",
    required: false,
    aliases: ["Other HAZMAT Details", "Other Hazmat Details"],
  },
  { key: "notes", label: "Notes", required: false, aliases: ["Notes", "Notes:"] },
]);

export const PPR_REQUIRED_FIELDS = Object.freeze(
  FIELD_DEFINITIONS.filter((field) => field.required).map((field) => field.label),
);

const MONTH_INDEX = Object.freeze({
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
});

const MONTH_ABBREVIATIONS = Object.freeze([
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
]);

export const PPR_OPERATION = Object.freeze({
  INBOUND: "INBOUND ONLY",
  OUTBOUND: "OUTBOUND ONLY",
  INBOUND_OUTBOUND: "INBOUND + OUTBOUND",
  OUTBOUND_INBOUND: "OUTBOUND + INBOUND",
});

const OPERATION_ALIASES = new Map([
  ["ARRIVAL", PPR_OPERATION.INBOUND],
  ["ARRIVAL ONLY", PPR_OPERATION.INBOUND],
  ["INBOUND", PPR_OPERATION.INBOUND],
  ["INBOUND ONLY", PPR_OPERATION.INBOUND],
  ["INBOUND-ONLY", PPR_OPERATION.INBOUND],
  ["DEPARTURE", PPR_OPERATION.OUTBOUND],
  ["DEPARTURE ONLY", PPR_OPERATION.OUTBOUND],
  ["OUTBOUND", PPR_OPERATION.OUTBOUND],
  ["OUTBOUND ONLY", PPR_OPERATION.OUTBOUND],
  ["OUTBOUND-ONLY", PPR_OPERATION.OUTBOUND],
  ["ARRIVAL + DEPARTURE", PPR_OPERATION.INBOUND_OUTBOUND],
  ["INBOUND + OUTBOUND", PPR_OPERATION.INBOUND_OUTBOUND],
  ["INBOUND + DEPARTURE", PPR_OPERATION.INBOUND_OUTBOUND],
  ["ARRIVAL + OUTBOUND", PPR_OPERATION.INBOUND_OUTBOUND],
  ["TURN", PPR_OPERATION.INBOUND_OUTBOUND],
  ["TURNAROUND", PPR_OPERATION.INBOUND_OUTBOUND],
  ["DEPARTURE + ARRIVAL", PPR_OPERATION.OUTBOUND_INBOUND],
  ["OUTBOUND + INBOUND", PPR_OPERATION.OUTBOUND_INBOUND],
  ["OUTBOUND + ARRIVAL", PPR_OPERATION.OUTBOUND_INBOUND],
  ["DEPARTURE + INBOUND", PPR_OPERATION.OUTBOUND_INBOUND],
]);

function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

const ALIAS_TO_FIELD = (() => {
  const aliases = new Map();
  for (const definition of FIELD_DEFINITIONS) {
    for (const alias of definition.aliases) {
      aliases.set(normalizeHeader(alias), definition.key);
    }
  }
  return aliases;
})();

function csvLocation(rowIndex, columnIndex) {
  return {
    row: rowIndex + 1,
    column: columnIndex + 1,
  };
}

/** Parse RFC-4180-style CSV text without retaining or returning the raw input. */
export function parseCsvRows(csvText) {
  if (typeof csvText !== "string") {
    throw new PprCsvError("INVALID_INPUT", "PPR CSV input must be text.");
  }
  if (csvText.trim() === "") {
    throw new PprCsvError("EMPTY_CSV", "The selected CSV is empty.");
  }

  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let rowIndex = 0;
  let columnIndex = 0;

  const finishField = () => {
    row.push(field);
    field = "";
    quoteClosed = false;
    columnIndex += 1;
  };

  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
    rowIndex += 1;
    columnIndex = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else if (character === "\r") {
        if (text[index + 1] === "\n") {
          index += 1;
        }
        field += "\n";
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed) {
      if (character === ",") {
        finishField();
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && text[index + 1] === "\n") {
          index += 1;
        }
        finishRow();
      } else if (character !== " " && character !== "\t") {
        throw new PprCsvError(
          "MALFORMED_CSV",
          "The selected CSV has characters after a closing quote.",
          csvLocation(rowIndex, columnIndex),
        );
      }
      continue;
    }

    if (character === ",") {
      finishField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      finishRow();
    } else if (character === '"') {
      if (field.length !== 0) {
        throw new PprCsvError(
          "MALFORMED_CSV",
          "The selected CSV has an unexpected quote in an unquoted field.",
          csvLocation(rowIndex, columnIndex),
        );
      }
      inQuotes = true;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new PprCsvError(
      "MALFORMED_CSV",
      "The selected CSV has an unterminated quoted field.",
      csvLocation(rowIndex, columnIndex),
    );
  }

  if (field.length > 0 || row.length > 0 || quoteClosed) {
    finishRow();
  }

  while (rows.length > 0 && rows.at(-1).every((value) => value.trim() === "")) {
    rows.pop();
  }
  if (rows.length === 0) {
    throw new PprCsvError("EMPTY_CSV", "The selected CSV is empty.");
  }
  return rows;
}

/** Map only known SharePoint columns; unknown columns are deliberately ignored. */
export function mapPprHeaders(headers) {
  if (!Array.isArray(headers)) {
    throw new PprCsvError("INVALID_HEADERS", "PPR CSV headers must be an array.");
  }

  const indices = Object.create(null);
  const recognizedHeaders = [];
  const duplicateFields = [];

  headers.forEach((header, index) => {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(header));
    if (!field) {
      return;
    }
    if (Object.hasOwn(indices, field)) {
      duplicateFields.push(field);
      return;
    }
    indices[field] = index;
    recognizedHeaders.push({ field, index, header: String(header ?? "").trim() });
  });

  const missingRequired = FIELD_DEFINITIONS.filter(
    (definition) => definition.required && !Object.hasOwn(indices, definition.key),
  ).map((definition) => definition.label);

  return { indices, missingRequired, recognizedHeaders, duplicateFields };
}

function cleanCell(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

/** True when a value should be shown under the prompt's empty-value rules. */
export function isMeaningfulDisplayValue(value) {
  const normalized = cleanCell(value);
  return normalized !== "" && !/^(?:null|false|none|n\s*\/\s*a|0)$/i.test(normalized);
}

function statusFromValue(value) {
  const normalized = cleanCell(value)
    .toLocaleLowerCase("en-US")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ");

  if (normalized === "approved - email sent") {
    return PPR_STATUS.APPROVED;
  }
  if (normalized === "cancelled / denied" || normalized === "canceled / denied") {
    return PPR_STATUS.CANCELLED;
  }
  return null;
}

function expandYear(yearText) {
  const year = Number(yearText);
  if (!Number.isInteger(year)) {
    return null;
  }
  if (yearText.length === 2) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }
  return year;
}

function validDateParts(year, monthIndex, day) {
  if (![year, monthIndex, day].every(Number.isInteger) || year < 1900 || year > 2200) {
    return null;
  }
  const instant = new Date(Date.UTC(year, monthIndex, day));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== monthIndex ||
    instant.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, monthIndex, day };
}

function parseDateParts(value) {
  const text = cleanCell(value).replace(/\u00a0/g, " ");
  if (!text) {
    return null;
  }

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (match) {
    return validDateParts(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})(?:\s+.*)?$/.exec(text);
  if (match) {
    return validDateParts(expandYear(match[3]), Number(match[1]) - 1, Number(match[2]));
  }

  match = /^([A-Za-z]+)\s+(\d{1,2})(?:,)?\s+(\d{4})(?:\s+.*)?$/.exec(text);
  if (match) {
    const monthIndex = MONTH_INDEX[match[1].toLocaleLowerCase("en-US")];
    return validDateParts(Number(match[3]), monthIndex, Number(match[2]));
  }

  match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+.*)?$/.exec(text);
  if (match) {
    const monthIndex = MONTH_INDEX[match[2].toLocaleLowerCase("en-US")];
    return validDateParts(Number(match[3]), monthIndex, Number(match[1]));
  }
  return null;
}

function parseTimeMinutes(value) {
  const original = cleanCell(value).replace(/\u00a0/g, " ");
  if (!original) {
    return null;
  }

  if (/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(original) && original.includes(".")) {
    const fraction = Number(original);
    if (Number.isFinite(fraction) && fraction >= 0 && fraction < 1) {
      return Math.round(fraction * 24 * 60) % (24 * 60);
    }
  }

  const text = original
    .toLocaleUpperCase("en-US")
    .replace(/\s+(?:LOCAL|CDT|CST)$/i, "")
    .replace(/\s*[LZ]$/i, "")
    .trim();
  const meridiemMatch = /\s*(AM|PM)$/.exec(text);
  const meridiem = meridiemMatch?.[1] ?? null;
  const clock = meridiem ? text.slice(0, meridiemMatch.index).trim() : text;

  let hour;
  let minute;
  const colonMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clock);
  const compactMatch = /^(\d{1,2})(\d{2})$/.exec(clock);
  if (colonMatch) {
    hour = Number(colonMatch[1]);
    minute = Number(colonMatch[2]);
  } else if (compactMatch) {
    hour = Number(compactMatch[1]);
    minute = Number(compactMatch[2]);
  } else if (meridiem && /^\d{1,2}$/.test(clock)) {
    hour = Number(clock);
    minute = 0;
  } else {
    return null;
  }

  if (minute < 0 || minute > 59) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour %= 12;
    if (meridiem === "PM") {
      hour += 12;
    }
  } else if (hour === 24 && minute === 0) {
    return 24 * 60;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return hour * 60 + minute;
}

/** Format an accepted local date as the compact operational display date. */
export function formatPprDate(value, { includeYear = false } = {}) {
  const clean = meaningfulOrEmpty(value);
  if (!clean) return "";
  const parts = parseDateParts(clean);
  if (!parts) return clean;
  const compact = `${String(parts.day).padStart(2, "0")} ${MONTH_ABBREVIATIONS[parts.monthIndex]}`;
  return includeYear ? `${compact} ${parts.year}` : compact;
}

/** Format an accepted clock value as four digits with an optional L/Z suffix. */
export function formatPprTime(value, suffix = "") {
  const clean = meaningfulOrEmpty(value);
  if (!clean) return "";
  const minutes = parseTimeMinutes(clean);
  if (minutes === null) return clean;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const marker = /^[lz]$/i.test(String(suffix ?? "").trim())
    ? String(suffix).trim().toLocaleUpperCase("en-US")
    : "";
  return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}${marker}`;
}

/** Map known source request-type wording to one of the four approved operation labels. */
export function normalizePprOperation(value) {
  const clean = meaningfulOrEmpty(value);
  if (!clean) return "";
  const normalized = clean
    .normalize("NFKC")
    .toLocaleUpperCase("en-US")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\b(INBOUND|OUTBOUND|ARRIVAL|DEPARTURE)\s*-\s*(INBOUND|OUTBOUND|ARRIVAL|DEPARTURE)\b/g, "$1 + $2")
    .replace(/\s*(?:\/|\+|&|→|->)\s*/g, " + ")
    .replace(/\s+\b(?:AND|THEN)\b\s+/g, " + ")
    .replace(/\s+/g, " ")
    .trim();
  return OPERATION_ALIASES.get(normalized) ?? "";
}

function sortKeyForLocalDateTime(dateValue, timeValue) {
  const date = parseDateParts(dateValue);
  const minutes = parseTimeMinutes(timeValue);
  if (!date || minutes === null) {
    return null;
  }
  return Date.UTC(date.year, date.monthIndex, date.day) + minutes * 60_000;
}

/** Locate an ESTIMATED note without guessing which movement it modifies. */
export function estimatedScopeFromNotes(notes) {
  const text = cleanCell(notes).toLocaleLowerCase("en-US");
  if (!/\bestimated\b/.test(text)) {
    return null;
  }

  const clauses = text.split(/[.;\n]+/);
  let arrival = false;
  let departure = false;
  for (const clause of clauses) {
    if (!/\bestimated\b/.test(clause)) {
      continue;
    }
    arrival ||= /\b(?:arriv(?:al|e|ing)?|eta)\b/.test(clause);
    departure ||= /\b(?:depart(?:ure|ing)?|etd)\b/.test(clause);
  }
  if (arrival && departure) {
    return "both";
  }
  if (arrival) {
    return "arrival";
  }
  if (departure) {
    return "departure";
  }
  return "neutral";
}

function meaningfulOrEmpty(value) {
  const clean = cleanCell(value);
  return isMeaningfulDisplayValue(clean) ? clean : "";
}

/** Remove obvious contact/routing identities from otherwise allowed free text. */
export function redactSensitiveFreeText(value) {
  const clean = meaningfulOrEmpty(value);
  if (!clean) return "";
  return clean
    .replace(
      /\b(?:requester|requestor|requested\s+by|point\s+of\s+contact|poc|contact(?:\s+name)?|created\s+by|modified\s+by|approved\s+by)\b\s*(?::|=|-)?\s*[^;\n]*/gi,
      "[CONTACT INFORMATION REDACTED]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL REDACTED]")
    .replace(
      /(?:\+?1[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?/gi,
      "[PHONE REDACTED]",
    )
    .replace(/\bDSN\s*[:=-]?\s*\d{3}[-\s.]?\d{4}\b/gi, "[PHONE REDACTED]")
    .replace(/\b\d{3}[-.]\d{4}\b/g, "[PHONE REDACTED]")
    .replace(
      /\b(?:fund(?:ing)?\s+(?:cite|citation|code)|fiscal\s+(?:code|data)|cost\s+center|line\s+of\s+accounting|loa)\b\s*(?::|=|-)?\s*[^;\n]*/gi,
      "[FISCAL INFORMATION REDACTED]",
    )
    .replace(
      /\b(?:routing\s+(?:identity|identifier|id)|workflow\s+(?:identity|identifier|id)|sharepoint\s+(?:identity|identifier|id))\b\s*(?::|=|-)?\s*[^;\n]*/gi,
      "[INTERNAL IDENTIFIER REDACTED]",
    )
    .trim();
}

function meaningfulHazmatValue(value) {
  const clean = redactSensitiveFreeText(value);
  return clean && !/^(?:no|not\s+declared)$/i.test(clean) ? clean : "";
}

function composeHazmat(read) {
  const declared = meaningfulHazmatValue(read("explosivesDeclared"));
  const explosiveDetails = meaningfulHazmatValue(read("explosiveDetails"));
  const otherDetails = meaningfulHazmatValue(read("otherHazmatDetails"));
  const parts = [];
  if (declared && !/^(?:yes|true)$/i.test(declared)) parts.push(declared);
  if (explosiveDetails) {
    parts.push(explosiveDetails);
  }
  if (otherDetails) {
    parts.push(otherDetails);
  }
  if (declared && parts.length === 0) parts.push("EXPLOSIVES DECLARED");
  return parts.join(" · ");
}

function buildRecord(row, rowNumber, indices, status) {
  const read = (field) => {
    const index = indices[field];
    return index === undefined ? "" : cleanCell(row[index]);
  };
  const display = (field) => redactSensitiveFreeText(read(field));
  const julian = display("julian");
  const sequence = display("sequence");
  const originalNotes = read("notes");
  const notes = redactSensitiveFreeText(originalNotes);
  const arrivalDateLocal = display("arrivalDateLocal");
  const arrivalTimeLocal = display("arrivalTimeLocal");
  const departureDateLocal = display("departureDateLocal");
  const departureTimeLocal = display("departureTimeLocal");

  return {
    sourceRowNumber: rowNumber,
    status,
    statusLabel: status === PPR_STATUS.APPROVED ? "APPROVED - EMAIL SENT" : "CANCELLED / DENIED",
    pprNumber: [julian, sequence].filter(Boolean).join("-"),
    julian,
    sequence,
    callsign: display("callsign"),
    aircraftType: display("aircraftType"),
    requestType: normalizePprOperation(display("requestType")),
    origin: display("origin"),
    destination: display("destination"),
    arrival: {
      dateLocal: arrivalDateLocal,
      timeLocal: arrivalTimeLocal,
      timeZulu: display("arrivalTimeZulu"),
      sortKey: sortKeyForLocalDateTime(arrivalDateLocal, arrivalTimeLocal),
    },
    departure: {
      dateLocal: departureDateLocal,
      timeLocal: departureTimeLocal,
      timeZulu: display("departureTimeZulu"),
      sortKey: sortKeyForLocalDateTime(departureDateLocal, departureTimeLocal),
    },
    homeStation: display("homeStation"),
    tailNumbers: display("tailNumbers"),
    vipCode: display("vipCode"),
    fuel: redactSensitiveFreeText(read("fuel")),
    transportation: redactSensitiveFreeText(read("transportation")),
    passengers: meaningfulOrEmpty(read("passengers")),
    specialRequirements: redactSensitiveFreeText(read("specialRequirements")),
    hazmat: composeHazmat(read),
    notes,
    estimatedScope: estimatedScopeFromNotes(originalNotes),
  };
}

function compareNullableNumber(left, right) {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function compareRecords(left, right) {
  const statusDifference =
    (left.status === PPR_STATUS.APPROVED ? 0 : 1) - (right.status === PPR_STATUS.APPROVED ? 0 : 1);
  if (statusDifference !== 0) {
    return statusDifference;
  }

  const arrivalDifference = compareNullableNumber(left.arrival.sortKey, right.arrival.sortKey);
  if (arrivalDifference !== 0) {
    return arrivalDifference;
  }
  return left.sourceRowNumber - right.sourceRowNumber;
}

function externalLocation(value) {
  const location = meaningfulOrEmpty(value);
  return location && location.toLocaleUpperCase("en-US") !== "KMEM" ? location : "";
}

function compactRoute(parts) {
  const route = [];
  for (const part of parts) {
    const location = meaningfulOrEmpty(part);
    if (!location || route.at(-1)?.toLocaleUpperCase("en-US") === location.toLocaleUpperCase("en-US")) {
      continue;
    }
    route.push(location);
  }
  return route.length >= 2 ? route.join(" → ") : "";
}

/** Build the concise KMEM-centered route appropriate to the record's operation. */
export function formatPprRoute(record) {
  if (!record) return "";
  const operation = normalizePprOperation(record.requestType);
  const origin = externalLocation(record.origin);
  const destination = externalLocation(record.destination);

  if (operation === PPR_OPERATION.INBOUND) {
    return origin ? compactRoute([origin, "KMEM"]) : "";
  }
  if (operation === PPR_OPERATION.OUTBOUND) {
    return destination ? compactRoute(["KMEM", destination]) : "";
  }
  if (operation === PPR_OPERATION.INBOUND_OUTBOUND) {
    return compactRoute([origin, "KMEM", destination]);
  }
  if (operation === PPR_OPERATION.OUTBOUND_INBOUND) {
    if (origin && destination && origin.toLocaleUpperCase("en-US") !== destination.toLocaleUpperCase("en-US")) {
      return `${compactRoute(["KMEM", destination])} · ${compactRoute([origin, "KMEM"])}`;
    }
    return compactRoute(["KMEM", destination || origin, "KMEM"]);
  }

  return "";
}

function formatTimingValue(timing, { rim = false } = {}) {
  const date = formatPprDate(timing?.dateLocal);
  const local = formatPprTime(timing?.timeLocal, "L");
  const zulu = formatPprTime(timing?.timeZulu, "Z");
  const clocks = [local, zulu].filter(Boolean).join(" / ");
  return [date, clocks].filter(Boolean).join(rim ? " " : " · ");
}

function estimatedMovement(record) {
  return record?.estimatedScope ?? null;
}

function formatSnapshotTiming(label, timing, estimated) {
  const value = formatTimingValue(timing);
  if (!value) return "";
  return `${label}: ${value}${estimated ? " · ESTIMATED" : ""}`;
}

function formatRimTiming(label, timing, estimated) {
  const value = formatTimingValue(timing, { rim: true });
  if (!value) return "";
  return `${label} ${value}${estimated ? " · ESTIMATED" : ""}`;
}

function recordIdentity(record) {
  return [
    meaningfulOrEmpty(record?.callsign),
    meaningfulOrEmpty(record?.aircraftType),
    normalizePprOperation(record?.requestType),
  ].filter(Boolean).join(" · ");
}

function mattermostValue(value) {
  return meaningfulOrEmpty(value)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .trim();
}

function mattermostLine(value) {
  return mattermostValue(value);
}

/** Build one compact, copy-ready main snapshot entry from allowlisted fields. */
export function formatPprSnapshotEntry(record) {
  if (!record || ![PPR_STATUS.APPROVED, PPR_STATUS.CANCELLED].includes(record.status)) return "";
  const cancelled = record.status === PPR_STATUS.CANCELLED;
  const pprNumber = meaningfulOrEmpty(record.pprNumber);
  const estimate = estimatedMovement(record);
  const lines = [
    `${cancelled ? "🔴 CANCELLED" : "🟢 APPROVED"}${pprNumber ? ` · PPR ${pprNumber}` : ""}`,
    recordIdentity(record),
    formatPprRoute(record),
    formatSnapshotTiming("ARR", record.arrival, estimate === "arrival" || estimate === "both"),
    formatSnapshotTiming("DEP", record.departure, estimate === "departure" || estimate === "both"),
  ];
  if (estimate === "neutral") lines.push("ESTIMATED");

  if (!cancelled) {
    const homeTail = [
      meaningfulOrEmpty(record.homeStation) ? `HOME: ${meaningfulOrEmpty(record.homeStation)}` : "",
      meaningfulOrEmpty(record.tailNumbers) ? `TAIL: ${meaningfulOrEmpty(record.tailNumbers)}` : "",
    ].filter(Boolean).join(" · ");
    lines.push(
      homeTail,
      meaningfulOrEmpty(record.vipCode) ? `VIP: ${meaningfulOrEmpty(record.vipCode)}` : "",
      meaningfulOrEmpty(record.fuel) ? `FUEL: ${meaningfulOrEmpty(record.fuel)}` : "",
      meaningfulOrEmpty(record.transportation) ? `TRANS: ${meaningfulOrEmpty(record.transportation)}` : "",
      meaningfulOrEmpty(record.passengers) ? `PAX: ${meaningfulOrEmpty(record.passengers)}` : "",
      meaningfulOrEmpty(record.specialRequirements) ? `SPECIAL: ${meaningfulOrEmpty(record.specialRequirements)}` : "",
      meaningfulOrEmpty(record.hazmat) ? `HAZMAT: ${meaningfulOrEmpty(record.hazmat)}` : "",
    );
  }
  if (meaningfulOrEmpty(record.notes)) lines.push(`NOTES: ${meaningfulOrEmpty(record.notes)}`);
  return lines.filter(Boolean).join("\n");
}

/** Return the sorted main snapshot as plain text with one blank line between entries. */
export function buildPprSnapshotText(records) {
  if (!Array.isArray(records)) return "";
  return records
    .filter((record) => [PPR_STATUS.APPROVED, PPR_STATUS.CANCELLED].includes(record?.status))
    .sort(compareRecords)
    .map(formatPprSnapshotEntry)
    .filter(Boolean)
    .join("\n\n");
}

/** Build one Mattermost-ready entry without deriving whitespace from rendered DOM. */
export function formatPprMattermostEntry(record) {
  if (!record || ![PPR_STATUS.APPROVED, PPR_STATUS.CANCELLED].includes(record.status)) return "";
  const cancelled = record.status === PPR_STATUS.CANCELLED;
  const pprNumber = mattermostValue(record.pprNumber);
  const estimate = estimatedMovement(record);
  const lines = [
    `${cancelled ? "🔴 CANCELLED" : "🟢 APPROVED"}${pprNumber ? ` · PPR ${pprNumber}` : ""}`,
    mattermostLine(recordIdentity(record)),
    mattermostLine(formatPprRoute(record)),
    mattermostLine(formatSnapshotTiming("ARR", record.arrival, estimate === "arrival" || estimate === "both")),
    mattermostLine(formatSnapshotTiming("DEP", record.departure, estimate === "departure" || estimate === "both")),
  ];
  if (estimate === "neutral") lines.push("ESTIMATED");

  if (!cancelled) {
    const homeTail = [
      mattermostValue(record.homeStation) ? `HOME: ${mattermostValue(record.homeStation)}` : "",
      mattermostValue(record.tailNumbers) ? `TAIL: ${mattermostValue(record.tailNumbers)}` : "",
    ].filter(Boolean).join(" · ");
    lines.push(
      homeTail,
      mattermostValue(record.vipCode) ? `VIP: ${mattermostValue(record.vipCode)}` : "",
      mattermostValue(record.fuel) ? `FUEL: ${mattermostValue(record.fuel)}` : "",
      mattermostValue(record.transportation) ? `TRANS: ${mattermostValue(record.transportation)}` : "",
      mattermostValue(record.passengers) ? `PAX: ${mattermostValue(record.passengers)}` : "",
      mattermostValue(record.specialRequirements) ? `SPECIAL: ${mattermostValue(record.specialRequirements)}` : "",
      mattermostValue(record.hazmat) ? `HAZMAT: ${mattermostValue(record.hazmat)}` : "",
    );
  }
  if (mattermostValue(record.notes)) lines.push(`NOTES: ${mattermostValue(record.notes)}`);
  return lines.map(mattermostLine).filter(Boolean).join("\n");
}

/** Return compact Mattermost text with exactly one blank line between sorted entries. */
export function buildPprMattermostText(records) {
  if (!Array.isArray(records)) return "";
  return records
    .filter((record) => [PPR_STATUS.APPROVED, PPR_STATUS.CANCELLED].includes(record?.status))
    .sort(compareRecords)
    .map(formatPprMattermostEntry)
    .filter(Boolean)
    .join("\n\n");
}

/** Build one approved RIM slide line from display-allowlisted record fields only. */
export function formatRimSlideLine(record) {
  if (!record || record.status !== PPR_STATUS.APPROVED) return "";
  const pprNumber = meaningfulOrEmpty(record.pprNumber);
  const callsign = meaningfulOrEmpty(record.callsign);
  const operation = normalizePprOperation(record.requestType);

  const estimate = estimatedMovement(record);
  const segments = [
    pprNumber ? `PPR ${pprNumber}` : "",
    callsign,
    operation,
    formatPprRoute(record),
    formatRimTiming("ARR", record.arrival, estimate === "arrival" || estimate === "both"),
    formatRimTiming("DEP", record.departure, estimate === "departure" || estimate === "both"),
    estimate === "neutral" ? "ESTIMATED" : "",
  ];
  return segments.filter(Boolean).join(" · ");
}

/** Return approved-only RIM lines in the same chronological order as the main snapshot. */
export function buildRimSlideLines(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record?.status === PPR_STATUS.APPROVED)
    .sort(compareRecords)
    .map(formatRimSlideLine)
    .filter(Boolean);
}

/**
 * Parse, validate, filter, normalize, and sort a PPR SharePoint CSV.
 * The return value contains display-allowlisted fields only; raw rows, unknown
 * columns, and the input text are never returned.
 */
export function parsePprSnapshotCsv(csvText) {
  const rows = parseCsvRows(csvText);
  const headerRowIndex = rows.findIndex((row) => row.some((value) => value.trim() !== ""));
  if (headerRowIndex < 0) {
    throw new PprCsvError("EMPTY_CSV", "The selected CSV is empty.");
  }

  const { indices, missingRequired, duplicateFields } = mapPprHeaders(rows[headerRowIndex]);
  if (duplicateFields.length > 0) {
    throw new PprCsvError(
      "DUPLICATE_COLUMNS",
      "The selected CSV has duplicate recognized PPR columns.",
      { fields: [...new Set(duplicateFields)] },
    );
  }
  if (missingRequired.length > 0) {
    throw new PprCsvError(
      "MISSING_REQUIRED_COLUMNS",
      `The selected CSV is missing required PPR columns: ${missingRequired.join(", ")}.`,
      { missingFields: missingRequired },
    );
  }

  const dataRows = rows.slice(headerRowIndex + 1).filter((row) => row.some((value) => value.trim() !== ""));
  if (dataRows.length > MAX_PPR_SOURCE_ROWS) {
    throw new PprCsvError(
      "TOO_MANY_SOURCE_ROWS",
      `The selected CSV contains more than ${MAX_PPR_SOURCE_ROWS.toLocaleString("en-US")} data rows.`,
    );
  }
  const records = [];
  let excludedCount = 0;

  dataRows.forEach((row, index) => {
    const status = statusFromValue(row[indices.status]);
    if (!status) {
      excludedCount += 1;
      return;
    }
    records.push(buildRecord(row, headerRowIndex + index + 2, indices, status));
    if (records.length > MAX_PPR_SNAPSHOT_RECORDS) {
      throw new PprCsvError(
        "TOO_MANY_SNAPSHOT_RECORDS",
        `The selected CSV contains more than ${MAX_PPR_SNAPSHOT_RECORDS.toLocaleString("en-US")} displayable PPR records.`,
      );
    }
  });

  records.sort(compareRecords);
  return {
    records,
    sourceRowCount: dataRows.length,
    includedCount: records.length,
    excludedCount,
  };
}
