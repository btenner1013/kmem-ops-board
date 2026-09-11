import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MAX_PPR_SNAPSHOT_RECORDS,
  PPR_OPERATION,
  PPR_REQUIRED_FIELDS,
  PPR_STATUS,
  PprCsvError,
  buildRimSlideLines,
  estimatedScopeFromNotes,
  formatPprDate,
  formatPprTime,
  formatRimSlideLine,
  isMeaningfulDisplayValue,
  mapPprHeaders,
  normalizePprOperation,
  parseCsvRows,
  parsePprSnapshotCsv,
  redactSensitiveFreeText,
} from "../ppr-snapshot-core.js";

const HEADERS = [
  "Email Status",
  "Julian",
  "Sequence",
  "Callsign",
  "Aircraft Type",
  "Request Type",
  "Origin",
  "Destination",
  "Arrival Date (L)",
  "Arrival Time (L)",
  "Arrival Time (z)",
  "Departure Date (L)",
  "Departure Time (L)",
  "Departure Time (z)",
  "Acft Homestation",
  "Tail/Reg Number(s)",
  "VIP Code",
  "Fuel:",
  "Trans:",
  "Pax:",
  "Special Requirements:",
  "Explosives Declared",
  "Explosive Details",
  "Other HAZMAT Details",
  "Notes:",
  "Requester Email",
  "SharePoint ID",
  "Created By",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

function record(overrides = {}) {
  const values = {
    "Email Status": "Approved - Email Sent",
    Julian: "255",
    Sequence: "007",
    Callsign: "TEST123",
    "Aircraft Type": "C17",
    "Request Type": "ARRIVAL",
    Origin: "KAAA",
    Destination: "KBBB",
    "Arrival Date (L)": "09/12/2026",
    "Arrival Time (L)": "8:15 AM",
    "Arrival Time (z)": "1315Z",
    "Departure Date (L)": "09/12/2026",
    "Departure Time (L)": "10:30 AM",
    "Departure Time (z)": "1530Z",
    "Acft Homestation": "KAAA",
    "Tail/Reg Number(s)": "00-0000",
    "VIP Code": "TEST",
    "Fuel:": "SYNTHETIC FUEL REQUEST",
    "Trans:": "TEST TRANSPORT",
    "Pax:": "12",
    "Special Requirements:": "SYNTHETIC SUPPORT",
    "Explosives Declared": "False",
    "Explosive Details": "",
    "Other HAZMAT Details": "",
    "Notes:": "Synthetic fixture only",
    "Requester Email": "private.person@example.test",
    "SharePoint ID": "SP-SECRET-42",
    "Created By": "Private Requester",
    ...overrides,
  };
  return HEADERS.map((header) => values[header] ?? "");
}

function fixture(rows, headers = HEADERS) {
  return [csvRow(headers), ...rows.map(csvRow)].join("\r\n");
}

test("CSV parser handles BOM, CRLF, commas, escaped quotes, and embedded newlines", () => {
  const rows = parseCsvRows('\uFEFFAlpha,Beta\r\n1,"two, values"\r\n2,"line one\r\nline ""two"""\r\n');
  assert.deepEqual(rows, [
    ["Alpha", "Beta"],
    ["1", "two, values"],
    ["2", 'line one\nline "two"'],
  ]);
});

test("CSV parser rejects empty, non-text, and malformed input with sanitized locations", () => {
  assert.throws(() => parseCsvRows(""), (error) => error instanceof PprCsvError && error.code === "EMPTY_CSV");
  assert.throws(
    () => parseCsvRows(new Uint8Array()),
    (error) => error instanceof PprCsvError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => parseCsvRows('A,B\n1,"unterminated'),
    (error) =>
      error instanceof PprCsvError &&
      error.code === "MALFORMED_CSV" &&
      error.details.row === 2 &&
      error.details.column === 2 &&
      !JSON.stringify(error).includes("unterminated"),
  );
});

test("header mapping tolerates case, punctuation, aliases, and harmless extra columns", () => {
  const headers = HEADERS.map((header) => ` ${header.toUpperCase()} `);
  headers[headers.indexOf(" CALLSIGN ")] = " Call Sign ";
  headers.push("Unrecognized Workflow Secret");
  const mapping = mapPprHeaders(headers);

  assert.deepEqual(mapping.missingRequired, []);
  assert.equal(mapping.duplicateFields.length, 0);
  assert.equal(Object.hasOwn(mapping.indices, "callsign"), true);
  assert.equal(mapping.recognizedHeaders.some(({ header }) => header === "Unrecognized Workflow Secret"), false);
  assert.equal(PPR_REQUIRED_FIELDS.includes("Arrival Time (L)"), true);
});

test("missing and duplicate required columns fail clearly without echoing unknown headers", () => {
  const missingHeaders = HEADERS.filter((header) => header !== "Callsign");
  assert.throws(
    () => parsePprSnapshotCsv(fixture([record()], missingHeaders)),
    (error) =>
      error instanceof PprCsvError &&
      error.code === "MISSING_REQUIRED_COLUMNS" &&
      error.details.missingFields.includes("Callsign") &&
      !error.message.includes("Requester Email"),
  );

  const duplicateHeaders = [...HEADERS, "Call Sign"];
  assert.throws(
    () => parsePprSnapshotCsv(fixture([record()], duplicateHeaders)),
    (error) => error instanceof PprCsvError && error.code === "DUPLICATE_COLUMNS",
  );
});

test("only approved and cancelled/denied rows are included", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({ Sequence: "001", "Email Status": "In Coordination" }),
      record({ Sequence: "002", "Email Status": "Approved - Email Sent" }),
      record({ Sequence: "003", "Email Status": "Cancelled / Denied" }),
      record({ Sequence: "004", "Email Status": "Draft" }),
    ]),
  );

  assert.equal(parsed.sourceRowCount, 4);
  assert.equal(parsed.includedCount, 2);
  assert.equal(parsed.excludedCount, 2);
  assert.deepEqual(
    parsed.records.map(({ status, sequence }) => [status, sequence]),
    [
      [PPR_STATUS.APPROVED, "002"],
      [PPR_STATUS.CANCELLED, "003"],
    ],
  );
});

test("approved rows sort before cancelled rows and each status sorts by actual local arrival", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({ Sequence: "006", "Email Status": "Cancelled / Denied", "Arrival Date (L)": "09/01/2026" }),
      record({ Sequence: "003", "Arrival Date (L)": "10/02/2026", "Arrival Time (L)": "9:00 AM" }),
      record({ Sequence: "002", "Arrival Date (L)": "9/12/2026", "Arrival Time (L)": "14:30" }),
      record({ Sequence: "001", "Arrival Date (L)": "09/12/2026", "Arrival Time (L)": "8:15 AM" }),
      record({ Sequence: "005", "Email Status": "Cancelled / Denied", "Arrival Date (L)": "08/31/2026" }),
      record({ Sequence: "004", "Arrival Date (L)": "Sep 12, 2026", "Arrival Time (L)": "12:05 PM" }),
    ]),
  );

  assert.deepEqual(
    parsed.records.map(({ sequence }) => sequence),
    ["001", "004", "002", "003", "005", "006"],
  );
  assert.ok(parsed.records.every(({ arrival }) => Number.isFinite(arrival.sortKey)));
});

test("invalid arrival times sort after valid arrivals without fabricating a timestamp", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({ Sequence: "002", "Arrival Time (L)": "UNKNOWN" }),
      record({ Sequence: "001", "Arrival Time (L)": "0815" }),
    ]),
  );
  assert.deepEqual(
    parsed.records.map(({ sequence }) => sequence),
    ["001", "002"],
  );
  assert.equal(parsed.records[1].arrival.sortKey, null);
});

test("compact date and time helpers normalize supported source forms without inventing missing data", () => {
  assert.equal(formatPprDate("09/12/2026"), "12 SEP");
  assert.equal(formatPprDate("2026-09-12T08:15:00"), "12 SEP");
  assert.equal(formatPprDate("Sep 9, 2026", { includeYear: true }), "09 SEP 2026");
  assert.equal(formatPprDate("UNKNOWN"), "UNKNOWN");
  assert.equal(formatPprDate("N/A"), "");

  assert.equal(formatPprTime("8:15 AM", "L"), "0815L");
  assert.equal(formatPprTime("1:05 PM", "l"), "1305L");
  assert.equal(formatPprTime("1315Z", "Z"), "1315Z");
  assert.equal(formatPprTime("24:00", "L"), "2400L");
  assert.equal(formatPprTime("0.5", "Z"), "1200Z");
  assert.equal(formatPprTime("UNKNOWN", "L"), "UNKNOWN");
  assert.equal(formatPprTime("FALSE", "Z"), "");
});

test("request types normalize to exactly the four RIM operation labels", () => {
  assert.equal(normalizePprOperation("Arrival"), PPR_OPERATION.INBOUND);
  assert.equal(normalizePprOperation("Inbound Only"), PPR_OPERATION.INBOUND);
  assert.equal(normalizePprOperation("Departure"), PPR_OPERATION.OUTBOUND);
  assert.equal(normalizePprOperation("Outbound Only"), PPR_OPERATION.OUTBOUND);
  assert.equal(normalizePprOperation("TURN"), PPR_OPERATION.INBOUND_OUTBOUND);
  assert.equal(normalizePprOperation("inbound and outbound"), PPR_OPERATION.INBOUND_OUTBOUND);
  assert.equal(normalizePprOperation("Arrival / Departure"), PPR_OPERATION.INBOUND_OUTBOUND);
  assert.equal(normalizePprOperation("outbound + inbound"), PPR_OPERATION.OUTBOUND_INBOUND);
  assert.equal(normalizePprOperation("Departure then Arrival"), PPR_OPERATION.OUTBOUND_INBOUND);
  assert.equal(normalizePprOperation("unrecognized synthetic operation"), "");
  assert.deepEqual(Object.values(PPR_OPERATION), [
    "INBOUND",
    "OUTBOUND",
    "INBOUND + OUTBOUND",
    "OUTBOUND + INBOUND",
  ]);
});

test("RIM lines use exact movement-specific location and timing order", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({
        Sequence: "001",
        Callsign: "TESTIN",
        "Request Type": "Inbound Only",
        Origin: "KADW",
        Destination: "KMEM",
        "Arrival Date (L)": "09/12/2026",
        "Arrival Time (L)": "10:30 PM",
        "Arrival Time (z)": "0330Z",
      }),
      record({
        Sequence: "002",
        Callsign: "TESTOUT",
        "Request Type": "Outbound Only",
        Origin: "KMEM",
        Destination: "KSUU",
        "Departure Date (L)": "09/19/2026",
        "Departure Time (L)": "4:30 PM",
        "Departure Time (z)": "2130Z",
      }),
      record({
        Sequence: "003",
        Callsign: "TESTTURN",
        "Request Type": "Inbound + Outbound",
        Origin: "KCHS",
        Destination: "KSKF",
        "Arrival Date (L)": "09/15/2026",
        "Arrival Time (L)": "8:30 AM",
        "Arrival Time (z)": "1330Z",
        "Departure Date (L)": "09/15/2026",
        "Departure Time (L)": "11:00 AM",
        "Departure Time (z)": "1600Z",
      }),
      record({
        Sequence: "004",
        Callsign: "TESTROUND",
        "Request Type": "Outbound + Inbound",
        Origin: "KADW",
        Destination: "KSKF",
        "Departure Date (L)": "09/20/2026",
        "Departure Time (L)": "9:00 AM",
        "Departure Time (z)": "1400Z",
        "Arrival Date (L)": "09/20/2026",
        "Arrival Time (L)": "5:30 PM",
        "Arrival Time (z)": "2230Z",
      }),
    ]),
  ).records;

  const bySequence = new Map(parsed.map((entry) => [entry.sequence, formatRimSlideLine(entry)]));
  assert.equal(
    bySequence.get("001"),
    "PPR 255-001 · TESTIN · INBOUND · ORIG KADW · ARR 12 SEP 2230L / 0330Z",
  );
  assert.equal(
    bySequence.get("002"),
    "PPR 255-002 · TESTOUT · OUTBOUND · DEST KSUU · DEP 19 SEP 1630L / 2130Z",
  );
  assert.equal(
    bySequence.get("003"),
    "PPR 255-003 · TESTTURN · INBOUND + OUTBOUND · ORIG KCHS · DEST KSKF · ARR 15 SEP 0830L / 1330Z · DEP 15 SEP 1100L / 1600Z",
  );
  assert.equal(
    bySequence.get("004"),
    "PPR 255-004 · TESTROUND · OUTBOUND + INBOUND · DEST KSKF · ORIG KADW · DEP 20 SEP 0900L / 1400Z · ARR 20 SEP 1730L / 2230Z",
  );
});

test("RIM line generation is approved-only, chronological, KMEM-free, and support-detail-free", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({
        Sequence: "003",
        Callsign: "TESTLATE",
        "Request Type": "Arrival",
        Origin: "KBBB",
        Destination: "KMEM",
        "Arrival Date (L)": "09/13/2026",
        "Notes:": "Synthetic note must not copy",
      }),
      record({
        Sequence: "001",
        Callsign: "TESTCOORD",
        "Email Status": "In Coordination",
        Origin: "KCCC",
      }),
      record({
        Sequence: "004",
        Callsign: "TESTCANCEL",
        "Email Status": "Cancelled / Denied",
        Origin: "KDDD",
      }),
      record({
        Sequence: "002",
        Callsign: "TESTEARLY",
        "Request Type": "Departure",
        Origin: "KMEM",
        Destination: "KAAA",
        "Arrival Date (L)": "09/11/2026",
        "Departure Date (L)": "09/11/2026",
        "Fuel:": "SYNTHETIC SECRET FUEL",
        "Trans:": "SYNTHETIC SECRET TRANSPORT",
        "Pax:": "99",
        "Special Requirements:": "SYNTHETIC SECRET SUPPORT",
        "Explosives Declared": "YES",
        "Explosive Details": "SYNTHETIC SECRET HAZMAT",
        "Notes:": "Synthetic secret note",
      }),
    ]),
  ).records;
  const reversed = [...parsed].reverse();
  const lines = buildRimSlideLines(reversed);
  const text = lines.join("\n");

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^PPR 255-002 · TESTEARLY · OUTBOUND · DEST KAAA · DEP 11 SEP /);
  assert.match(lines[1], /^PPR 255-003 · TESTLATE · INBOUND · ORIG KBBB · ARR 13 SEP /);
  assert.doesNotMatch(text, /TESTCOORD|TESTCANCEL|KMEM/);
  assert.doesNotMatch(text, /FUEL|TRANSPORT|PAX|SUPPORT|HAZMAT|secret note/i);
  assert.equal(formatRimSlideLine(parsed.find(({ status }) => status === PPR_STATUS.CANCELLED)), "");
  assert.equal(reversed[0].status, PPR_STATUS.CANCELLED, "the caller's array order must remain unchanged");
});

test("empty-value rules remove optional values and entire absent HAZMAT content", () => {
  for (const emptyValue of ["", " ", "null", "False", "FALSE", "NONE", "N/A", "0"]) {
    assert.equal(isMeaningfulDisplayValue(emptyValue), false, `${JSON.stringify(emptyValue)} should be empty`);
  }
  assert.equal(isMeaningfulDisplayValue("10"), true);
  assert.equal(isMeaningfulDisplayValue("Not required"), true);

  const parsed = parsePprSnapshotCsv(
    fixture([
      record({
        "Fuel:": "0",
        "Trans:": "NONE",
        "Pax:": "False",
        "Special Requirements:": "N/A",
        "Explosives Declared": "No",
        "Explosive Details": "null",
        "Other HAZMAT Details": "FALSE",
        "Notes:": "",
      }),
    ]),
  ).records[0];

  assert.equal(parsed.fuel, "");
  assert.equal(parsed.transportation, "");
  assert.equal(parsed.passengers, "");
  assert.equal(parsed.specialRequirements, "");
  assert.equal(parsed.hazmat, "");
  assert.equal(parsed.notes, "");
});

test("empty-value rules also suppress non-meaningful required display cells", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([record({ Callsign: "NONE", "VIP Code": "0", "Arrival Time (z)": "FALSE" })]),
  ).records[0];
  assert.equal(parsed.callsign, "");
  assert.equal(parsed.vipCode, "");
  assert.equal(parsed.arrival.timeZulu, "");
});

test("HAZMAT output is composed exclusively from the three approved fields", () => {
  const parsed = parsePprSnapshotCsv(
    fixture([
      record({
        "Explosives Declared": "Yes",
        "Explosive Details": "Class 1 synthetic item",
        "Other HAZMAT Details": "Battery declaration",
        "Special Requirements:": "Do not reinterpret as HAZMAT",
      }),
    ]),
  ).records[0];

  assert.equal(
    parsed.hazmat,
    "EXPLOSIVES DECLARED: Yes · EXPLOSIVE DETAILS: Class 1 synthetic item · OTHER HAZMAT: Battery declaration",
  );
  assert.doesNotMatch(parsed.hazmat, /reinterpret/i);
});

test("ESTIMATED is case-insensitive and is attached only when the note establishes a scope", () => {
  assert.equal(estimatedScopeFromNotes("Arrival time is ESTIMATED."), "arrival");
  assert.equal(estimatedScopeFromNotes("estimated departure due to crew timing"), "departure");
  assert.equal(estimatedScopeFromNotes("ETA and ETD estimated"), "both");
  assert.equal(estimatedScopeFromNotes("Timing estimated; awaiting confirmation"), "neutral");
  assert.equal(estimatedScopeFromNotes("Confirmed times"), null);

  const parsed = parsePprSnapshotCsv(
    fixture([record({ "Notes:": "Estimated arrival; retain this note." })]),
  ).records[0];
  assert.equal(parsed.estimatedScope, "arrival");
  assert.equal(parsed.notes, "Estimated arrival; retain this note.");
});

test("allowed free-text fields redact contact, fiscal, and internal identifiers", () => {
  assert.equal(
    redactSensitiveFreeText("Contact: Synthetic Person; gate TEST"),
    "[CONTACT INFORMATION REDACTED]; gate TEST",
  );
  assert.equal(redactSensitiveFreeText("POC Synthetic Person"), "[CONTACT INFORMATION REDACTED]");
  assert.equal(redactSensitiveFreeText("DSN 555-1234"), "[PHONE REDACTED]");
  assert.equal(redactSensitiveFreeText("Fund cite TEST-1234"), "[FISCAL INFORMATION REDACTED]");

  const parsed = parsePprSnapshotCsv(
    fixture([
      record({
        "Special Requirements:": "Call 901-555-0101; approved by Synthetic Person",
        "Other HAZMAT Details": "Routing ID: SYNTH-SECRET",
        "Notes:": "Contact: Synthetic Person arrival estimated; gate TEST; person@example.test",
      }),
    ]),
  ).records[0];
  const serialized = JSON.stringify(parsed);
  assert.equal(parsed.estimatedScope, "arrival");
  assert.doesNotMatch(serialized, /Synthetic Person|901-555-0101|SYNTH-SECRET|person@example\.test/i);
  assert.match(parsed.notes, /CONTACT INFORMATION REDACTED/);
  assert.match(parsed.notes, /EMAIL REDACTED/);
});

test("displayable record count is bounded before browser rendering", () => {
  const rows = Array.from({ length: MAX_PPR_SNAPSHOT_RECORDS + 1 }, (_, index) =>
    record({ Sequence: String(index + 1).padStart(4, "0") }),
  );
  assert.throws(
    () => parsePprSnapshotCsv(fixture(rows)),
    (error) => error instanceof PprCsvError && error.code === "TOO_MANY_SNAPSHOT_RECORDS",
  );
});

test("normalized record contains only the explicit display allowlist", () => {
  const parsed = parsePprSnapshotCsv(fixture([record()])).records[0];
  const serialized = JSON.stringify(parsed);

  assert.deepEqual(Object.keys(parsed), [
    "sourceRowNumber",
    "status",
    "statusLabel",
    "pprNumber",
    "julian",
    "sequence",
    "callsign",
    "aircraftType",
    "requestType",
    "origin",
    "destination",
    "arrival",
    "departure",
    "homeStation",
    "tailNumbers",
    "vipCode",
    "fuel",
    "transportation",
    "passengers",
    "specialRequirements",
    "hazmat",
    "notes",
    "estimatedScope",
  ]);
  assert.doesNotMatch(serialized, /private\.person@example\.test/i);
  assert.doesNotMatch(serialized, /SP-SECRET-42/i);
  assert.doesNotMatch(serialized, /Private Requester/i);
});

test("core module has no browser network, storage, persistence, or file APIs", async () => {
  const source = await readFile(new URL("../ppr-snapshot-core.js", import.meta.url), "utf8");
  for (const forbidden of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /WebSocket/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /caches\s*\./,
    /serviceWorker/,
    /showOpenFilePicker/,
    /showSaveFilePicker/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("committed browser-QA fixture is wholly synthetic and preserves filtering", async () => {
  const csv = await readFile(
    new URL("./fixtures/ppr-snapshot/synthetic-ppr-snapshot.csv", import.meta.url),
    "utf8",
  );
  const parsed = parsePprSnapshotCsv(csv);
  assert.equal(parsed.sourceRowCount, 6);
  assert.equal(parsed.includedCount, 5);
  assert.equal(parsed.excludedCount, 1);
  assert.ok(parsed.records.every(({ callsign }) => /^TEST\d{3}$/.test(callsign)));
  assert.ok(parsed.records.every(({ tailNumbers }) => /^00-000\d$/.test(tailNumbers)));
  assert.ok(parsed.records.every(({ origin, destination }) => /^K[A-L]{3}$/.test(origin) && /^K[A-L]{3}$/.test(destination)));
  assert.doesNotMatch(JSON.stringify(parsed.records), /@example\.test|SYNTH-00[1-6]|Synthetic User/);
});
