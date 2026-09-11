import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  SYNTHETIC_DD1801,
  SYNTHETIC_DD1801_FIXTURE_ID,
} from "./fixtures/dd1801-approved-synthetic.mjs";

const DD1801_TEST_FILES = Object.freeze([
  "./dd1801-import.test.mjs",
  "./flight-plan-core.test.mjs",
  "./flight-plan-aisr.test.mjs",
]);
const RETIRED_EXTERNAL_FIXTURE_HOOK = ["DD1801", "TEST", "PDF"].join("_");

test("approved DD1801 fixture is explicitly synthetic and deterministic", () => {
  assert.equal(SYNTHETIC_DD1801_FIXTURE_ID, "KMEM-DD1801-SYNTHETIC-V1");
  assert.deepEqual(
    {
      aircraftIdentification: SYNTHETIC_DD1801.aircraftIdentification,
      registrationToken: SYNTHETIC_DD1801.otherInformation.match(/\bREG\/([^\s]+)/)?.[1],
      departure: SYNTHETIC_DD1801.departure,
      destination: SYNTHETIC_DD1801.destination,
      route: SYNTHETIC_DD1801.route,
      aircraftSerial: SYNTHETIC_DD1801.aircraftSerial,
    },
    {
      aircraftIdentification: "LAB731",
      registrationToken: "TEST731",
      departure: "ZZZA",
      destination: "ZZZB",
      route: "SIM1A MOCKA ALPHA Q42 BRAVO DCT CHARL T7 DELTA TRIAL SIM2B",
      aircraftSerial: "SIM-0001",
    },
  );
  assert.match(SYNTHETIC_DD1801.remarks, /WHOLLY SYNTHETIC/);
});

test("DD1801 tests use the approved in-memory fixture and no external operational fixture hook", async () => {
  const fixtureEntries = await readdir(new URL("./fixtures/", import.meta.url), {
    recursive: true,
    withFileTypes: true,
  });
  const dd1801FixtureFiles = fixtureEntries
    .filter((entry) => entry.isFile() && /dd1801/i.test(entry.name))
    .map((entry) => entry.name);
  assert.deepEqual(dd1801FixtureFiles, ["dd1801-approved-synthetic.mjs"]);

  for (const relativePath of DD1801_TEST_FILES) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /dd1801-approved-synthetic\.mjs/);
    assert.equal(source.includes(RETIRED_EXTERNAL_FIXTURE_HOOK), false);
    assert.doesNotMatch(source, /process\.env\s*\[?\s*["']DD1801/i);
  }

  const importTest = await readFile(new URL("./dd1801-import.test.mjs", import.meta.url), "utf8");
  assert.match(importTest, /in-memory synthetic AcroForm PDF/i);
  assert.doesNotMatch(importTest, /readFile\s*\(|readFileSync\s*\(/);
});
