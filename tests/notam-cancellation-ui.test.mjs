import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";


const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");


function sourceBetween(startMarker, endMarker) {
  const start = indexHtml.indexOf(startMarker);
  const end = indexHtml.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return indexHtml.slice(start, end);
}


const cancellationHelpers = sourceBetween(
  "function notamNumberFromItem",
  "function collectPotentialNotamItems",
);
const listNormalizer = sourceBetween(
  "function normalizeNotamList",
  "function notamFullTextFromItem",
);
const context = vm.createContext({});
vm.runInContext(
  `${cancellationHelpers}\n${listNormalizer}\n` +
    "globalThis.collectTargets=collectInactiveNotamTargets;" +
    "globalThis.filterRecords=filterInactiveNotamRecords;" +
    "globalThis.isCancellation=isNotamCancellation;" +
    "globalThis.isReplacement=isNotamReplacement;" +
    "globalThis.replacementTarget=notamReplacementTarget;",
  context,
);


test("provided board sample hides two NOTAMC messages and keeps three operational MIL records", () => {
  const sample = {
    milNotams: [
      { number: "M0033/26", text: "M0033/26 NOTAMC M0032/26 A) KMEM" },
      { number: "M0034/26", text: "MIL RAMP UHF/VHF RADIO COMMS INOP" },
      { number: "M0024/26", text: "MIL RAMP ARFF STATUS YELLOW" },
      { number: "M0021/26", text: "MIL RAMP DSN LINES INOP" },
      { number: "M0031/26", text: "M0031/26 NOTAMC M0030/26 A) KMEM" },
    ],
  };
  const targets = context.collectTargets(sample);
  const filtered = context.filterRecords(sample.milNotams, targets);

  assert.deepEqual(Array.from(targets).sort(), ["M0030/26", "M0032/26"]);
  assert.deepEqual(
    Array.from(filtered, item => item.number),
    ["M0034/26", "M0024/26", "M0021/26"],
  );
});


test("display filter applies a cancellation before hiding it in either record order", () => {
  const cancel = { number: "M0031/26", text: "M0031/26 NOTAMC M0030/26 A) KMEM" };
  const target = { number: "M0030/26", text: "MIL RAMP COMMS INOP" };
  const keep = { number: "M0024/26", text: "MIL RAMP ARFF STATUS YELLOW" };

  for (const records of [[target, keep, cancel], [cancel, keep, target]]) {
    const targets = context.collectTargets({ milNotams: records });
    const filtered = context.filterRecords(records, targets);
    assert.deepEqual(Array.from(filtered, item => item.number), ["M0024/26"]);
  }
});


test("NOTAMR remains visible and suppresses the superseded NOTAM", () => {
  const original = {
    number: "M0100/26",
    text: "M0100/26 MIL RAMP COMMS INOP",
  };
  const replacement = {
    number: "M0101/26",
    text: "M0101/26 NOTAMR M0100/26 MIL RAMP COMMS RESTORED UHF ONLY",
  };
  const unrelated = {
    number: "M0200/26",
    text: "M0200/26 MIL RAMP ARFF STATUS GREEN",
  };

  assert.equal(context.isCancellation(replacement), false);
  assert.equal(context.isReplacement(replacement), true);
  assert.equal(context.replacementTarget(replacement), "M0100/26");
  assert.deepEqual(
    Array.from(context.filterRecords([original, replacement, unrelated]), item => item.number),
    ["M0101/26", "M0200/26"],
  );
});


test("replacement and cancellation chains preserve only latest active and unrelated records", () => {
  const original = { number: "M0100/26", text: "M0100/26 MIL RAMP COMMS INOP" };
  const replacement = {
    number: "M0101/26",
    text: "M0101/26 NOTAMR M0100/26 MIL RAMP COMMS RESTORED UHF ONLY",
  };
  const second = {
    number: "M0102/26",
    text: "M0102/26 NOTAMR M0101/26 MIL RAMP COMMS FULLY RESTORED",
  };
  const cancellation = {
    number: "M0103/26",
    text: "M0103/26 NOTAMC M0102/26 A) KMEM",
  };
  const unrelated = { number: "M0200/26", text: "M0200/26 MIL RAMP ARFF STATUS GREEN" };

  assert.deepEqual(
    Array.from(
      context.filterRecords([original, replacement, second, unrelated]),
      item => item.number,
    ),
    ["M0102/26", "M0200/26"],
  );
  assert.deepEqual(
    Array.from(
      context.filterRecords([unrelated, cancellation, second, replacement, original]),
      item => item.number,
    ),
    ["M0200/26"],
  );
});


test("local domestic NOTAMC removes its MM/NNN target", () => {
  const records = [
    { number: "08/368", text: "RWY 18C CLSD" },
    { number: "08/370", text: "RWY 18L CLSD" },
    { number: "08/369", text: "08/369 NOTAMC 08/368 A) KMEM" },
  ];
  const targets = context.collectTargets({ runwayClosureNotams: records });

  assert.deepEqual(Array.from(targets), ["08/368"]);
  assert.deepEqual(
    Array.from(context.filterRecords(records, targets), item => item.number),
    ["08/370"],
  );
});
