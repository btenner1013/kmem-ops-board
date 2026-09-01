import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMeteogramModel,
  buildTafForecastBuckets,
  convertTemperature,
  convertWindSpeed,
  formatMeteogramTime,
  formatTemperature,
  formatWind,
  meteogramLookupRequest,
  parseNwsGridForecast,
  parseMeteogramObservation,
} from "../weather-meteogram-core.js";
import {
  buildMeteogramAccessibleTableMarkup,
  buildMeteogramSvgMarkup,
  meteogramDimensions,
  meteogramVisualLabelMask,
} from "../weather-meteogram.js";

function report({
  timestamp = "2026-08-31T23:54:00Z",
  raw = "METAR KMEM 312354Z 24012G22KT 2SM -TSRA BKN015CB OVC040 24/22 A2988 RMK AO2 P0018 4/003",
  product = "METAR",
} = {}) {
  return { station: "KMEM", timestamp, raw, product };
}

function tafReport({
  timestamp = "2026-09-01T02:00:00Z",
  raw = "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 FM010430 22012G20KT 5SM -RA BKN020 TEMPO 0106/0109 2SM TSRA BKN008CB PROB30 0110/0112 1SM +TSRA OVC005CB BECMG 0112/0114 30008KT P6SM NSW SCT060 TX31/0119Z TN18/0111Z",
} = {}) {
  return {
    station: "KMEM",
    timestamp,
    product: "TAF",
    validTimeFrom: "2026-09-01T03:00:00Z",
    validTimeTo: "2026-09-02T06:00:00Z",
    raw,
    source: "Current TAF fixture",
  };
}

function nwsGridForecast({
  temperature = [
    { validTime: "2026-09-01T03:00:00+00:00/PT2H", value: 25 },
    { validTime: "2026-09-01T06:00:00+00:00/PT3H", value: 27 },
    { validTime: "2026-09-01T09:00:00+00:00/PT12H", value: 28 },
  ],
  dewpoint = [
    { validTime: "2026-09-01T03:00:00+00:00/PT4H", value: 20 },
    { validTime: "2026-09-01T07:00:00+00:00/PT14H", value: 19 },
  ],
  quantitativePrecipitation = [
    { validTime: "2026-09-01T03:00:00+00:00/PT3H", value: 12.7 },
    { validTime: "2026-09-01T06:00:00+00:00/PT6H", value: 25.4 },
    { validTime: "2026-09-01T12:00:00+00:00/PT6H", value: 0 },
  ],
  snowfallAmount = [
    { validTime: "2026-09-01T06:00:00+00:00/PT6H", value: 2.54 },
  ],
  temperatureUnit = "wmoUnit:degC",
  dewpointUnit = "wmoUnit:degC",
  precipitationUnit = "wmoUnit:mm",
  snowfallUnit = "wmoUnit:mm",
  validTimes = "2026-09-01T02:00:00+00:00/P2D",
} = {}) {
  return {
    sourceUrl: "https://api.weather.gov/gridpoints/MEG/45,62",
    pointUrl: "https://api.weather.gov/points/35.0424,-89.9767",
    stationUrl: "https://api.weather.gov/stations/KMEM",
    fetchedZ: "2026-09-01T03:16:00Z",
    point: { latitude: 35.0424, longitude: -89.9767 },
    payload: {
      id: "https://api.weather.gov/gridpoints/MEG/45,62",
      type: "Feature",
      properties: {
        gridId: "MEG",
        gridX: 45,
        gridY: 62,
        updateTime: "2026-09-01T02:05:40-05:00",
        validTimes,
        temperature: { uom: temperatureUnit, values: temperature },
        dewpoint: { uom: dewpointUnit, values: dewpoint },
        quantitativePrecipitation: { uom: precipitationUnit, values: quantitativePrecipitation },
        snowfallAmount: { uom: snowfallUnit, values: snowfallAmount },
        probabilityOfPrecipitation: {
          uom: "wmoUnit:percent",
          values: [{ validTime: "2026-09-01T06:00:00+00:00/PT6H", value: 90 }],
        },
      },
    },
  };
}

test("structured METAR parsing preserves exact observed fields and precipitation semantics", () => {
  const parsed = parseMeteogramObservation(report());
  assert.equal(parsed.station, "KMEM");
  assert.equal(parsed.source, "METAR/SPECI source");
  assert.equal(parsed.observedZ, "2026-08-31T23:54:00.000Z");
  assert.equal(parsed.temperatureC, 24);
  assert.equal(parsed.dewPointC, 22);
  assert.equal(parsed.windDirectionDeg, 240);
  assert.equal(parsed.windVariable, false);
  assert.equal(parsed.windSpeedKt, 12);
  assert.equal(parsed.windGustKt, 22);
  assert.equal(parsed.pressureInHg, 29.88);
  assert.equal(parsed.visibilitySm, 2);
  assert.equal(parsed.visibilityDisplay, "2 SM");
  assert.deepEqual(parsed.clouds.layers.map(({ cover, heightFt, convective }) => ({ cover, heightFt, convective })), [
    { cover: "BKN", heightFt: 1500, convective: "CB" },
    { cover: "OVC", heightFt: 4000, convective: "" },
  ]);
  assert.equal(parsed.clouds.ceilingFt, 1500);
  assert.deepEqual(parsed.weatherCodes, ["-TSRA"]);
  assert.equal(parsed.weather.icon, "⚡");
  assert.equal(parsed.precipitation.rainObserved, true);
  assert.equal(parsed.precipitation.liquidEquivalentIn, 0.18);
  assert.equal(parsed.precipitation.snowDepthIn, 3);
});

test("international QNH, metric visibility, variable wind, negative temperature, and clear sky remain truthful", () => {
  const parsed = parseMeteogramObservation({
    station: "EGLL",
    timestamp: "2026-09-01T00:20:00Z",
    product: "METAR",
    raw: "METAR EGLL 010020Z VRB03KT 9999 SKC M02/M05 Q1018 NOSIG",
  });
  assert.equal(parsed.windVariable, true);
  assert.equal(parsed.windDirectionDeg, null);
  assert.equal(parsed.windSpeedKt, 3);
  assert.equal(parsed.temperatureC, -2);
  assert.equal(parsed.dewPointC, -5);
  assert.equal(parsed.visibilityQualifier, "≥");
  assert.equal(parsed.visibilityDisplay, "≥10 KM");
  assert.equal(parsed.clouds.clear, true);
  assert.equal(parsed.clouds.display, "SKC", "the exact clear/no-significant-cloud token is retained for visual semantics");
  assert.ok(Math.abs(parsed.pressureHpa - 1018) < 0.001);
  assert.ok(Math.abs(parsed.pressureInHg - 30.061) < 0.01);
  for (const token of ["CLR", "NSC", "NCD"]) {
    const clear = parseMeteogramObservation({
      station: "EGLL", timestamp: "2026-09-01T00:20:00Z", product: "METAR",
      raw: `METAR EGLL 010020Z 00000KT 9999 ${token} 10/05 Q1018`,
    });
    assert.equal(clear.clouds.clear, true);
    assert.equal(clear.clouds.display, token);
  }
});

test("decoded TAF clear, no-significant-cloud, and no-cloud-detected tokens remain exact", () => {
  for (const token of ["SKC", "CLR", "NSC", "NCD"]) {
    const result = buildTafForecastBuckets(tafReport({
      raw: `TAF KMEM 010200Z 0103/0206 18008KT 9999 ${token}`,
    }), {
      station: "KMEM",
      now: new Date("2026-09-01T03:15:00Z"),
    });
    assert.ok(result.buckets.length > 0);
    assert.equal(result.buckets[0].clouds.clear, true);
    assert.equal(result.buckets[0].clouds.cavok, false);
    assert.equal(result.buckets[0].clouds.display, token);
  }
});

test("observed MPS winds and standalone, vicinity, and freezing weather codes remain exact", () => {
  const mps = parseMeteogramObservation({
    station: "UUEE",
    timestamp: "2026-09-01T00:30:00Z",
    product: "METAR",
    raw: "METAR UUEE 010030Z 24005G08MPS 4000 VCTS FZFG BKN010 M02/M03 Q1012",
  });
  assert.ok(Math.abs(mps.windSpeedKt - 5 * 1.943844492) < 0.000001);
  assert.ok(Math.abs(mps.windGustKt - 8 * 1.943844492) < 0.000001);
  assert.deepEqual(mps.weatherCodes, ["VCTS", "FZFG"]);
  assert.equal(mps.weather.label, "THUNDER");

  for (const [code, expectedLabel] of [["TS", "THUNDER"], ["VCSH", "VICINITY SHOWERS"], ["FZFG", "FOG"]]) {
    const parsed = parseMeteogramObservation({
      station: "EGLL",
      timestamp: "2026-09-01T00:40:00Z",
      product: "METAR",
      raw: `METAR EGLL 010040Z 22008KT 6000 ${code} SCT020 18/14 Q1016`,
    });
    assert.deepEqual(parsed.weatherCodes, [code]);
    assert.equal(parsed.weather.label, expectedLabel);
  }
});

test("observed CAVOK retains its visibility bound and cloud semantics", () => {
  const parsed = parseMeteogramObservation({
    station: "EGLL",
    timestamp: "2026-09-01T01:20:00Z",
    product: "METAR",
    raw: "METAR EGLL 010120Z 23008KT CAVOK 18/12 Q1019",
  });
  assert.equal(parsed.visibilityQualifier, "≥");
  assert.equal(parsed.visibilityDisplay, "≥10 KM");
  assert.ok(parsed.visibilitySm > 6);
  assert.equal(parsed.clouds.cavok, true);
  assert.equal(parsed.clouds.clear, false);
  assert.equal(parsed.clouds.display, "CAVOK");
  assert.equal(parsed.weather.label, "CAVOK");
  const model = buildMeteogramModel([{
    station: "EGLL",
    timestamp: "2026-09-01T01:20:00Z",
    product: "METAR",
    raw: "METAR EGLL 010120Z 23008KT CAVOK 18/12 Q1019",
  }], { station: "EGLL" });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  assert.match(svg, /NO CIG &lt;5K/);
  assert.match(svg, /≥10 KM/);
  assert.match(table, /CAVOK · NO CIG &lt;5K/);
  assert.doesNotMatch(svg, /CAVOK &lt;5K/);
});

test("cancelled and NIL TAFs fail closed without blank future buckets", () => {
  for (const [token, warning] of [["CNL", /cancelled/i], ["NIL", /reports NIL/i]]) {
    const result = buildTafForecastBuckets(tafReport({
      raw: `TAF AMD KMEM 010200Z 0103/0206 ${token}`,
    }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
    assert.equal(result.buckets.length, 0);
    assert.match(result.taf.warning, warning);
  }
});

test("unknown ceiling height remains unknown instead of becoming NO CIG", () => {
  const parsed = parseMeteogramObservation(report({
    raw: "METAR KMEM 010054Z 18008KT 6SM BR BKN/// OVC040 22/21 A2994",
    timestamp: "2026-09-01T00:54:00Z",
  }));
  assert.equal(parsed.clouds.layers[0].cover, "BKN");
  assert.equal(parsed.clouds.layers[0].heightFt, null);
  assert.equal(parsed.clouds.ceilingFt, 4000, "a later known ceiling remains measurable");

  const unknownOnly = buildMeteogramModel([report({
    raw: "METAR KMEM 010054Z 18008KT 6SM BR VV/// 22/21 A2994",
    timestamp: "2026-09-01T00:54:00Z",
  })], { station: "KMEM" });
  const svg = buildMeteogramSvgMarkup(unknownOnly, { timeMode: "Z" });
  assert.match(svg, /CIG UNK/);
  assert.doesNotMatch(svg, />NO CIG</);

  const tafUnknown = buildTafForecastBuckets(tafReport({
    raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM BKN///",
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.equal(tafUnknown.buckets[0].clouds.layers[0].cover, "BKN");
  assert.equal(tafUnknown.buckets[0].clouds.layers[0].heightFt, null);
  const tafModel = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport({ raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM BKN///" })],
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.match(buildMeteogramSvgMarkup(tafModel, { timeMode: "Z" }), /CIG UNK/);
});

test("bounded visibility qualifiers and missing fields are not promoted to exact or zero values", () => {
  const below = parseMeteogramObservation(report({
    raw: "SPECI KMEM 312359Z 00000KT M1/4SM FG VV002 18/18 A3000 RMK AO2 P0000",
    product: "SPECI",
    timestamp: "2026-08-31T23:59:00Z",
  }));
  assert.equal(below.visibilityQualifier, "<");
  assert.equal(below.visibilitySm, 0.25);
  assert.equal(below.precipitation.liquidTrace, true);
  assert.equal(below.precipitation.liquidEquivalentIn, null, "trace is not promoted to a numeric zero");

  const missing = parseMeteogramObservation(report({
    raw: "METAR KMEM 010054Z AUTO /////KT //// // ////// A//// RMK AO2",
    timestamp: "2026-09-01T00:54:00Z",
  }));
  assert.equal(missing.temperatureC, null);
  assert.equal(missing.dewPointC, null);
  assert.equal(missing.windSpeedKt, null);
  assert.equal(missing.pressureInHg, null);
  assert.equal(missing.visibilitySm, null);
  assert.equal(missing.precipitation.rainObserved, false);
  assert.equal(missing.precipitation.snowObserved, false);
  assert.equal(missing.precipitation.liquidEquivalentIn, null);
});

test("model is chronological and collapses exact duplicates plus same-time revisions to one bucket", () => {
  const routine = report({
    timestamp: "2026-08-31T23:54:00Z",
    raw: "METAR KMEM 312354Z 24012KT 10SM SCT050 24/18 A2998",
  });
  const exactDuplicate = { ...routine, raw: routine.raw.replace(/^METAR /, "") };
  const corrected = report({
    timestamp: "2026-08-31T23:54:00Z",
    raw: "METAR COR KMEM 312354Z 24014G20KT 8SM BKN040 23/19 A2997",
  });
  const later = report({
    timestamp: "2026-09-01T00:54:00Z",
    raw: "SPECI KMEM 010054Z 25018G28KT 5SM TSRA BKN025CB 22/20 A2995",
    product: "SPECI",
  });
  const model = buildMeteogramModel([later, routine, exactDuplicate, corrected], { station: "KMEM" });
  assert.equal(model.observations.length, 2);
  assert.deepEqual(model.observations.map((item) => item.observedZ), [
    "2026-08-31T23:54:00.000Z",
    "2026-09-01T00:54:00.000Z",
  ]);
  assert.equal(model.observations[0].windSpeedKt, 14, "corrected same-time observation wins");
  assert.equal(model.observations[0].revised, true);
  assert.equal(model.revisedBuckets, 1);
});

test("current TAF forecast uses exact validity and FM timing without extending past the product", () => {
  const result = buildTafForecastBuckets(tafReport(), {
    station: "KMEM",
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.equal(result.taf.issuanceZ, "2026-09-01T02:00:00.000Z");
  assert.equal(result.taf.validityEndZ, "2026-09-02T06:00:00.000Z");
  assert.equal(result.buckets[0].validZ, "2026-09-01T03:15:00.000Z", "exact NOW forecast boundary is retained");
  assert.ok(result.buckets.some((bucket) => bucket.validZ === "2026-09-01T04:30:00.000Z"), "exact FM minute is not rounded");
  assert.ok(result.buckets.every((bucket) => Date.parse(bucket.validZ) < Date.parse(result.taf.validityEndZ)));
  const beforeFm = result.buckets.find((bucket) => bucket.validZ === "2026-09-01T04:00:00.000Z");
  const atFm = result.buckets.find((bucket) => bucket.validZ === "2026-09-01T04:30:00.000Z");
  assert.equal(beforeFm.windDirectionDeg, 180);
  assert.equal(atFm.windDirectionDeg, 220);
  assert.equal(atFm.windGustKt, 20);
  assert.equal(atFm.visibilitySm, 5);
  assert.equal(atFm.clouds.ceilingFt, 2000);
  assert.equal(atFm.precipitation.rainForecast, true);
});

test("near-NOW duplicate forecast samples are suppressed while exact TAF boundaries remain", () => {
  const now = new Date("2026-09-01T03:57:00Z");
  const steady = buildTafForecastBuckets(tafReport({
    raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050",
  }), { station: "KMEM", now });
  assert.equal(steady.buckets[0].validZ, "2026-09-01T03:57:00.000Z");
  assert.equal(steady.buckets.some((bucket) => bucket.validZ === "2026-09-01T04:00:00.000Z"), false);

  const exactFm = buildTafForecastBuckets(tafReport({
    raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 FM010400 24012KT 4SM -RA BKN020",
  }), { station: "KMEM", now });
  assert.equal(exactFm.buckets.some((bucket) => bucket.validZ === "2026-09-01T04:00:00.000Z"), true, "a real FM boundary is never dropped");
  assert.equal(exactFm.buckets.some((bucket) => bucket.validZ === "2026-09-01T03:57:00.000Z"), false, "a near-identical NOW bucket yields to the exact boundary three minutes later");

  const recentObservedModel = buildMeteogramModel([report({ timestamp: "2026-09-01T03:54:00Z" })], {
    station: "KMEM",
    tafReports: [tafReport({ raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050" })],
    now: new Date("2026-09-01T04:02:00Z"),
  });
  assert.equal(recentObservedModel.dividerZ, "2026-09-01T04:02:00.000Z");
  assert.equal(recentObservedModel.forecasts[0].validZ, "2026-09-01T05:00:00.000Z", "recent exact observation prevents a colliding duplicate NOW forecast column");

  const activeTempoModel = buildMeteogramModel([report({ timestamp: "2026-09-01T03:54:00Z" })], {
    station: "KMEM",
    tafReports: [tafReport({ raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 TEMPO 0104/0105 2SM TSRA BKN008CB" })],
    now: new Date("2026-09-01T04:02:00Z"),
  });
  assert.equal(activeTempoModel.forecasts[0].validZ, "2026-09-01T04:02:00.000Z", "an active conditional hazard always remains visible at NOW");
});

test("BECMG merges only at its end while TEMPO and PROB remain conditional overlays", () => {
  const { buckets } = buildTafForecastBuckets(tafReport(), {
    station: "KMEM",
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const tempo = buckets.find((bucket) => bucket.validZ === "2026-09-01T06:00:00.000Z");
  assert.equal(tempo.windDirectionDeg, 220, "prevailing FM wind remains primary during TEMPO");
  assert.deepEqual(tempo.conditional.map((entry) => entry.type), ["TEMPORARY"]);
  assert.equal(tempo.conditional[0].conditions.visibilitySm, 2);
  assert.ok(tempo.conditional[0].conditions.weatherCodes.includes("TSRA"));

  const probability = buckets.find((bucket) => bucket.validZ === "2026-09-01T10:00:00.000Z");
  assert.deepEqual(probability.conditional.map((entry) => entry.type), ["PROB30"]);
  assert.equal(probability.visibilitySm, 5, "PROB30 visibility never replaces prevailing visibility");

  const becoming = buckets.find((bucket) => bucket.validZ === "2026-09-01T12:00:00.000Z");
  const afterBecoming = buckets.find((bucket) => bucket.validZ === "2026-09-01T14:00:00.000Z");
  assert.equal(becoming.windDirectionDeg, 220);
  assert.deepEqual(becoming.becoming.map((entry) => entry.type), ["BECOMING"]);
  assert.equal(afterBecoming.windDirectionDeg, 300);
  assert.equal(afterBecoming.visibilityQualifier, ">");
  assert.equal(afterBecoming.clouds.layers[0].cover, "SCT");
});

test("TAF TX/TN are exact event markers and missing dew, pressure, and precip amounts are never inferred", () => {
  const { buckets } = buildTafForecastBuckets(tafReport(), {
    station: "KMEM",
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const maximum = buckets.find((bucket) => bucket.validZ === "2026-09-01T19:00:00.000Z");
  const minimum = buckets.find((bucket) => bucket.validZ === "2026-09-01T11:00:00.000Z");
  const ordinary = buckets.find((bucket) => bucket.validZ === "2026-09-01T18:00:00.000Z");
  assert.equal(maximum.temperatureC, 31);
  assert.equal(maximum.temperatureKind, "Maximum temperature");
  assert.equal(minimum.temperatureC, 18);
  assert.equal(minimum.temperatureKind, "Minimum temperature");
  assert.equal(ordinary.temperatureC, null);
  assert.ok(buckets.every((bucket) => bucket.dewPointC === null));
  assert.ok(buckets.every((bucket) => bucket.pressureInHg === null));
  assert.ok(buckets.every((bucket) => bucket.precipitation.liquidEquivalentIn === null));
  assert.ok(buckets.every((bucket) => bucket.precipitation.snowDepthIn === null));
});

test("meteogram model keeps observed and forecast data separate around an exact divider", () => {
  const model = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport()],
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.equal(model.observations.length, 1);
  assert.ok(model.forecasts.length > 1);
  assert.equal(model.timeline.length, model.observations.length + model.forecasts.length);
  assert.equal(model.timeline[0].kind, "OBSERVED");
  assert.equal(model.timeline[1].kind, "FORECAST");
  assert.equal(model.dividerZ, "2026-09-01T03:15:00.000Z");
});

test("a newer current TAF rebuild replaces the future rather than appending stale forecast state", () => {
  const options = { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") };
  const earlier = buildMeteogramModel([report()], {
    ...options,
    tafReports: [tafReport({ raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050" })],
  });
  const newer = buildMeteogramModel([report()], {
    ...options,
    tafReports: [tafReport({
      timestamp: "2026-09-01T03:00:00Z",
      raw: "TAF AMD KMEM 010300Z 0103/0206 30014G24KT 3SM -RA BKN012",
    })],
  });
  assert.ok(earlier.forecasts.every((bucket) => bucket.windDirectionDeg === 180));
  assert.ok(newer.forecasts.every((bucket) => bucket.windDirectionDeg === 300));
  assert.ok(newer.forecasts.every((bucket) => bucket.tafIssuanceZ === "2026-09-01T03:00:00.000Z"));
  assert.equal(newer.forecasts.some((bucket) => bucket.windDirectionDeg === 180), false);
});

test("expired TAF creates no future projection or divider", () => {
  const model = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport({
      timestamp: "2026-08-31T10:00:00Z",
      raw: "TAF KMEM 311000Z 3111/3123 18008KT P6SM CLR",
    })],
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.deepEqual(model.forecasts, []);
  assert.equal(model.dividerZ, null);
});

test("unsupported international timing constructs fail closed instead of becoming prevailing", () => {
  const result = buildTafForecastBuckets(tafReport({
    raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 PROB40 INTER 0106/0109 2SM TSRA BKN008CB",
  }), {
    station: "KMEM",
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.deepEqual(result.buckets, []);
  assert.match(result.taf.warning, /Forecast omitted.*INTER/);
});

test("meteogram lookup is an alias over the existing METAR history request", () => {
  assert.deepEqual(meteogramLookupRequest({ station: " kmem ", range: "recent" }), {
    station: "KMEM", product: "METAR", range: "24",
  });
  assert.deepEqual(meteogramLookupRequest({ station: "egll", range: "48" }), {
    station: "EGLL", product: "METAR", range: "48",
  });
  assert.equal(meteogramLookupRequest({ station: "KMEM", range: "bogus" }).range, "24");
});

test("temperature and wind unit conversions preserve null and update formatting", () => {
  assert.equal(convertTemperature(0, "F"), 32);
  assert.equal(convertTemperature(20, "C"), 20);
  assert.equal(convertTemperature(null, "F"), null);
  assert.ok(Math.abs(convertWindSpeed(10, "MPH") - 11.50779448) < 0.0001);
  assert.equal(convertWindSpeed(10, "KT"), 10);
  assert.equal(convertWindSpeed(null, "MPH"), null);
  assert.equal(formatTemperature(20, "F"), "68°");
  assert.equal(formatTemperature(null, "C"), "—");
  assert.equal(formatWind(12, "MPH"), "14");
  assert.equal(formatWind(null, "KT"), "—");
});

test("LOCAL and Z time formatting uses the station zone and distinguishes the repeated DST hour", () => {
  const first = formatMeteogramTime("2026-11-01T06:30:00Z", { mode: "LOCAL", station: "KMEM" });
  const second = formatMeteogramTime("2026-11-01T07:30:00Z", { mode: "LOCAL", station: "KMEM" });
  const zulu = formatMeteogramTime("2026-11-01T07:30:00Z", { mode: "Z", station: "KMEM" });
  assert.equal(first.time, "01:30");
  assert.equal(second.time, "01:30");
  assert.equal(first.zone, "CDT");
  assert.equal(second.zone, "CST");
  assert.deepEqual(zulu, { time: "07:30", date: "01 NOV", zone: "Z" });
  assert.equal(formatMeteogramTime("2026-11-01T07:30:00Z", { mode: "LOCAL", station: "KZZZ" }).zone, "Z");
});

test("timeline geometry is proportional to exact observation and TAF times", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-08-31T22:00:00Z", raw: "METAR KMEM 312200Z 18005KT 10SM CLR 30/18 A3000" }),
    report({ timestamp: "2026-08-31T22:10:00Z", raw: "SPECI KMEM 312210Z 19006KT 8SM SCT050 29/19 A2999", product: "SPECI" }),
    report({ timestamp: "2026-08-31T23:10:00Z", raw: "METAR KMEM 312310Z 20007KT 6SM BKN040 28/20 A2998" }),
  ], { station: "KMEM" });
  const dimensions = meteogramDimensions(model.timeline, 900);
  const firstGap = dimensions.xPositions[1] - dimensions.xPositions[0];
  const secondGap = dimensions.xPositions[2] - dimensions.xPositions[1];
  assert.ok(Math.abs(secondGap / firstGap - 6) < 0.001, "a 60-minute gap is six times a 10-minute gap");
});

test("one SVG binds all bands to one time grid and visibly pairs temperature with dew point", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-08-31T22:54:00Z", raw: "METAR KMEM 312254Z 21008KT 10SM SCT060 29/19 A3001" }),
    report({ timestamp: "2026-08-31T23:54:00Z", raw: "METAR KMEM 312354Z 22010G18KT 8SM -RA BKN045 27/21 A2999 RMK P0002" }),
    report({ timestamp: "2026-09-01T00:54:00Z", raw: "SPECI KMEM 010054Z 24014G24KT 4SM TSRA BKN020CB 24/22 A2996", product: "SPECI" }),
  ], { station: "KMEM" });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z", temperatureUnit: "F", windUnit: "KT" }, { viewportWidth: 1200 });
  assert.match(svg, /^<svg class="aviation-meteogram-svg"/);
  assert.equal((svg.match(/<svg\b/g) || []).length, 1, "one cohesive chart surface");
  assert.equal((svg.match(/aviation-meteogram-time-line/g) || []).length, 4, "one shared vertical time grid");
  assert.match(svg, /class="aviation-meteogram-temperature-row"[\s\S]*aviation-meteogram-temperature-value/);
  assert.match(svg, /class="aviation-meteogram-dew-point-row"[\s\S]*aviation-meteogram-dew-point-value/);
  assert.ok(
    svg.indexOf('class="aviation-meteogram-temperature-row"') < svg.indexOf('class="aviation-meteogram-dew-point-row"'),
    "temperature and dew point remain distinct, ordered numeric rows",
  );
  assert.match(svg, /class="aviation-meteogram-temp-line"/);
  assert.match(svg, /class="aviation-meteogram-dew-line"/);
  assert.match(svg, /class="aviation-meteogram-temp-spread"/);
  assert.match(svg, /DOWNWIND ARROW · KT/);
  assert.doesNotMatch(svg, /wind barb/i);
  assert.match(svg, /OBSERVED REPORTS|exact METAR/i);
});

test("forecast SVG has a distinct NOW divider and conditional TAF styling without joining observed trends", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-09-01T01:54:00Z", raw: "METAR KMEM 010154Z 18007KT P6SM CLR 26/20 A3000" }),
    report({ timestamp: "2026-09-01T02:54:00Z", raw: "METAR KMEM 010254Z 19008KT P6SM SCT050 25/20 A2999" }),
  ], {
    station: "KMEM",
    tafReports: [tafReport()],
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1000 });
  assert.match(svg, /aviation-meteogram-forecast-background/);
  assert.match(svg, /aviation-meteogram-now-divider/);
  assert.match(svg, /NOW \/ FORECAST/);
  assert.match(svg, /aviation-meteogram-forecast-column/);
  assert.match(svg, /P30|TEMPO/);
  assert.match(svg, /TMP 2 SM/, "conditional visibility is shown without replacing prevailing visibility");
  assert.match(svg, /TMP BKN008CB/, "the conditional cloud group retains its exact TAF layer token");
  assert.match(
    svg,
    /aviation-meteogram-cloud-layer-BKN[^\"]*aviation-meteogram-cloud-layer-ceiling[^\"]*aviation-meteogram-cloud-layer-conditional"[^>]*data-base-ft="800"[^>]*data-base-y="797\.2"/,
    "the conditional BKN layer is a ceiling anchored at its actual 800-foot base",
  );
  assert.match(svg, /BECMG 300° 8/, "BECMG target wind is shown during the transition window");
  assert.match(svg, /aviation-meteogram-line-forecast/);
  assert.match(svg, /Dew point unavailable; TAF does not provide hourly dew point/);
  assert.match(svg, /PRECIP \(IN\)[\s\S]*INTERVAL TOTAL/, "missing TAF amount remains in a separately truthful quantitative row");
  assert.equal((svg.match(/aviation-meteogram-temp-forecast-marker/g) || []).length, 2, "only exact TX/TN events become forecast temperature markers");
});

test("simultaneous TAF overlays keep each weather hazard attached to its own group", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-09-01T11:54:00Z", raw: "METAR KMEM 011154Z 18008KT P6SM SCT050 25/20 A3000" }),
  ], {
    station: "KMEM",
    tafReports: [tafReport({
      raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 BECMG 0112/0114 30008KT TEMPO 0112/0116 2SM TSRA BKN008CB",
    })],
    now: new Date("2026-09-01T12:30:00Z"),
  });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1000 });
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  assert.match(svg, /TMP TSRA/);
  assert.doesNotMatch(svg, /BECMG TSRA/);
  assert.match(table, /BECMG: wind 300° 8 KT/);
  assert.match(table, /TEMPO: visibility 2 SM, clouds BKN008CB; ceiling 800 FT, weather TSRA/);
  const dimensions = meteogramDimensions(model.timeline, 1000);
  const mask = meteogramVisualLabelMask(model.timeline, dimensions.xPositions);
  const simultaneousIndexes = model.timeline
    .map((entry, index) => ((entry.becoming?.length || 0) + (entry.conditional?.length || 0) > 1 ? index : -1))
    .filter((index) => index >= 0);
  assert.ok(simultaneousIndexes.length > 1);
  assert.ok(simultaneousIndexes.some((index) => mask[index]), "at least one simultaneous-overlay label remains visible");
  assert.ok(simultaneousIndexes.some((index) => !mask[index]), "wide repeated overlay labels are thinned instead of overlapping each hourly column");
});

test("near-NOW retained TAF evidence suppresses colliding visual labels but preserves exact geometry and table rows", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-09-01T03:54:00Z", raw: "METAR KMEM 010354Z 18008KT P6SM SCT050 25/20 A3000" }),
  ], {
    station: "KMEM",
    tafReports: [tafReport({
      raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 TEMPO 0103/0105 2SM TSRA BKN008CB",
    })],
    now: new Date("2026-09-01T04:02:00Z"),
  });
  assert.equal(model.timeline[1].validZ, "2026-09-01T04:02:00.000Z", "active TEMPO keeps the exact NOW bucket");
  const dimensions = meteogramDimensions(model.timeline, 1000);
  assert.ok(dimensions.xPositions[1] - dimensions.xPositions[0] < 56, "the evidence points are genuinely too close for two full label columns");
  const mask = meteogramVisualLabelMask(model.timeline, dimensions.xPositions);
  assert.deepEqual(mask.slice(0, 2), [false, true], "the active TAF overlay wins the close-label collision deterministically");
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1000 });
  const table = buildMeteogramAccessibleTableMarkup(model, { timeMode: "Z" });
  assert.match(svg, /aviation-meteogram-label-suppressed/);
  assert.match(svg, /TMP TSRA/);
  assert.match(svg, /METAR 01 SEP 0354Z/, "suppressed visual columns retain exact hover title evidence");
  assert.match(svg, />01 SEP UTC</, "the first surviving visual time label retains its date and UTC basis");
  assert.equal((table.match(/<tr>/g) || []).length, model.timeline.length + 1, "the text table retains every exact bucket");
});

test("an exact FM boundary wins a close visual-label collision with the latest observation", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-09-01T03:54:00Z", raw: "METAR KMEM 010354Z 18008KT P6SM SCT050 25/20 A3000" }),
  ], {
    station: "KMEM",
    tafReports: [tafReport({
      raw: "TAF KMEM 010200Z 0103/0206 18008KT P6SM SCT050 FM010400 25018G28KT 2SM TSRA BKN008CB",
    })],
    now: new Date("2026-09-01T03:56:00Z"),
  });
  assert.equal(model.timeline[1].validZ, "2026-09-01T04:00:00.000Z");
  assert.equal(model.timeline[1].exactBoundary, true);
  const dimensions = meteogramDimensions(model.timeline, 1000);
  const mask = meteogramVisualLabelMask(model.timeline, dimensions.xPositions);
  assert.deepEqual(mask.slice(0, 2), [false, true]);
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" }, { viewportWidth: 1000 });
  assert.match(svg, />TSRA</);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>250°</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>18 KT</);
  assert.match(svg, /BKN008CB · BROKEN CLOUD BASE 800 FT AGL · CUMULONIMBUS REPORTED · CLOUD TOP NOT REPORTED · CEILING/, "the exact FM ceiling layer retains its base and token");
});

test("calm and variable winds never imply a directional arrow", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-08-31T22:00:00Z", raw: "METAR KMEM 312200Z 00000KT 10SM CLR 30/18 A3000" }),
    report({ timestamp: "2026-08-31T23:00:00Z", raw: "METAR KMEM 312300Z VRB04KT 10SM CLR 29/18 A2999" }),
    report({ timestamp: "2026-09-01T00:00:00Z", raw: "METAR KMEM 010000Z 24008KT 10SM CLR 28/18 A2998" }),
  ], { station: "KMEM" });
  const svg = buildMeteogramSvgMarkup(model, { timeMode: "Z" });
  assert.equal((svg.match(/class="aviation-meteogram-wind-arrow"/g) || []).length, 1);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>VRB</);
  assert.match(svg, /aviation-meteogram-wind-speed[^>]*>4 KT</);
  assert.match(svg, /aviation-meteogram-wind-heading[^>]*>CALM</);
  assert.doesNotMatch(svg, /CALM<\/text>[\s\S]{0,120}aviation-meteogram-wind-speed/, "calm has no invented speed line");
});

test("text data table exposes every time bucket and updates displayed units and forecast semantics", () => {
  const model = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport()],
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const table = buildMeteogramAccessibleTableMarkup(model, {
    timeMode: "Z",
    temperatureUnit: "C",
    windUnit: "MPH",
  });
  assert.match(table, /^<table class="aviation-meteogram-data-table">/);
  assert.match(table, /Temperature °C/);
  assert.match(table, /Wind MPH/);
  assert.equal((table.match(/<tr>/g) || []).length, model.timeline.length + 1, "header plus one row per exact timeline bucket");
  assert.match(table, /TAF forecast/);
  assert.match(table, /Non-prevailing\/transition TEMPO:.*visibility 2 SM.*ceiling 800 FT/);
  assert.match(table, /Aviation fields from current TAF/);
  assert.doesNotMatch(table, /supplemental fields identify NWS grid provenance/i);
  assert.match(table, /Exact retained observation/);
  assert.match(table, /TX .*Maximum temperature/);
  assert.match(table, /TN .*Minimum temperature/);
});

test("trend connectors break across long observation gaps instead of fabricating continuity", () => {
  const model = buildMeteogramModel([
    report({ timestamp: "2026-08-31T18:54:00Z", raw: "METAR KMEM 311854Z 18005KT 10SM CLR 30/18 A3000" }),
    report({ timestamp: "2026-08-31T19:54:00Z", raw: "METAR KMEM 311954Z 19006KT 10SM SCT050 31/19 A2999" }),
    report({ timestamp: "2026-09-01T00:54:00Z", raw: "METAR KMEM 010054Z 22008KT 10SM BKN060 26/20 A2997" }),
  ], { station: "KMEM" });
  const svg = buildMeteogramSvgMarkup(model, {}, { viewportWidth: 900 });
  assert.equal((svg.match(/class="aviation-meteogram-temp-line"/g) || []).length, 2);
  assert.equal((svg.match(/class="aviation-meteogram-dew-line"/g) || []).length, 2);
});

test("official NWS grid fields retain units, valid intervals, provenance, and exact inch conversions", () => {
  const parsed = parseNwsGridForecast(nwsGridForecast(), {
    station: "KMEM",
    now: new Date("2026-09-01T03:15:00Z"),
  });
  assert.ok(parsed);
  assert.equal(parsed.product, "NWS_GRID");
  assert.equal(parsed.source, "NOAA/NWS forecast grid");
  assert.equal(parsed.sourceUrl, "https://api.weather.gov/gridpoints/MEG/45,62");
  assert.equal(parsed.updateZ, "2026-09-01T07:05:40.000Z");
  assert.deepEqual(parsed.grid, {
    id: "MEG", x: 45, y: 62, latitude: 35.0424, longitude: -89.9767,
  });
  assert.deepEqual(parsed.temperatureIntervals[0], {
    validStartZ: "2026-09-01T03:00:00.000Z",
    validEndZ: "2026-09-01T05:00:00.000Z",
    valueC: 25,
    product: "NWS_GRID",
    source: "NOAA/NWS forecast grid",
    sourceUrl: "https://api.weather.gov/gridpoints/MEG/45,62",
    updateZ: "2026-09-01T07:05:40.000Z",
    grid: parsed.grid,
  });
  assert.deepEqual(parsed.quantitativePrecipitationIntervals.map((entry) => ({
    start: entry.validStartZ, end: entry.validEndZ, mm: entry.amountMm, inches: entry.amountIn,
  })), [
    { start: "2026-09-01T06:00:00.000Z", end: "2026-09-01T12:00:00.000Z", mm: 25.4, inches: 1 },
    { start: "2026-09-01T12:00:00.000Z", end: "2026-09-01T18:00:00.000Z", mm: 0, inches: 0 },
  ], "the straddling-now total is dropped and future source totals remain unsplit");
  assert.equal(parsed.snowfallAmountIntervals[0].amountMm, 2.54);
  assert.ok(Math.abs(parsed.snowfallAmountIntervals[0].amountIn - 0.1) < 1e-12);
  assert.equal("probabilityOfPrecipitationIntervals" in parsed, false, "PoP is never treated as an amount");
});

test("NWS RLE temperature and dew point merge at valid samples without filling gaps", () => {
  const model = buildMeteogramModel([report({
    timestamp: "2026-09-01T02:54:00Z",
    raw: "METAR KMEM 010254Z 18005KT 10SM CLR 24/18 A3000",
  })], {
    station: "KMEM",
    supplementalForecast: nwsGridForecast(),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const atNow = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T03:15:00.000Z");
  const atFour = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T04:00:00.000Z");
  const inGap = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T05:00:00.000Z");
  const afterGap = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T06:00:00.000Z");
  assert.equal(atNow.temperatureC, 25, "a state interval that began before NOW remains valid at NOW");
  assert.equal(atNow.dewPointC, 20);
  assert.equal(atFour.temperatureC, 25, "explicit PT2H RLE validity may repeat the same value");
  assert.equal(inGap.temperatureC, null, "no linearly interpolated value is invented in a source gap");
  assert.equal(inGap.dewPointC, 20);
  assert.equal(afterGap.temperatureC, 27);
  assert.equal(atNow.reportType, "NWS GRID");
  assert.equal(atNow.fieldProvenance.temperature.product, "NWS_GRID");
  assert.equal(model.dividerZ, "2026-09-01T03:15:00.000Z");
  assert.equal(model.taf, null);
  assert.equal(model.forecastPrecipitationIntervals[0].amountIn, 1);
  assert.ok(model.forecasts.every((bucket) => Date.parse(bucket.validZ) <= Date.parse(model.dividerZ) + 36 * 60 * 60 * 1000));

  const allFieldsGap = buildMeteogramModel([], {
    station: "KMEM",
    supplementalForecast: nwsGridForecast({
      temperature: [
        { validTime: "2026-09-01T03:00:00Z/PT2H", value: 25 },
        { validTime: "2026-09-01T06:00:00Z/PT2H", value: 27 },
      ],
      dewpoint: [
        { validTime: "2026-09-01T03:00:00Z/PT2H", value: 20 },
        { validTime: "2026-09-01T06:00:00Z/PT2H", value: 19 },
      ],
      quantitativePrecipitation: [],
      snowfallAmount: [],
    }),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const explicitGapBoundary = allFieldsGap.forecasts.find((bucket) => bucket.validZ === "2026-09-01T05:00:00.000Z");
  assert.ok(explicitGapBoundary, "the explicit RLE end remains a boundary bucket even when every field is missing there");
  assert.equal(explicitGapBoundary.temperatureC, null);
  assert.equal(explicitGapBoundary.dewPointC, null);
});

test("NWS hourly temperature remains scalar while same-time TAF TX/TN stay separate annotations", () => {
  const model = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport()],
    supplementalForecast: nwsGridForecast(),
    now: new Date("2026-09-01T03:15:00Z"),
  });
  const maximum = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T19:00:00.000Z");
  const minimum = model.forecasts.find((bucket) => bucket.validZ === "2026-09-01T11:00:00.000Z");
  assert.equal(maximum.temperatureC, 28, "NWS hourly temperature remains the plotted/numeric scalar");
  assert.equal(maximum.temperatureKind, "Maximum temperature");
  assert.equal(maximum.temperatureExtrema[0].valueC, 31);
  assert.equal(maximum.fieldProvenance.temperature.product, "NWS_GRID");
  assert.equal(maximum.temperatureExtremaProvenance.product, "TAF");
  assert.equal(minimum.temperatureC, 28);
  assert.equal(minimum.temperatureKind, "Minimum temperature");
  assert.equal(minimum.temperatureExtrema[0].valueC, 18);

  const missingHourlyScalar = buildMeteogramModel([report()], {
    station: "KMEM",
    tafReports: [tafReport()],
    supplementalForecast: nwsGridForecast({
      temperature: [{ validTime: "2026-09-01T03:00:00Z/PT2H", value: 25 }],
      dewpoint: [],
    }),
    now: new Date("2026-09-01T03:15:00Z"),
  }).forecasts.find((bucket) => bucket.validZ === "2026-09-01T19:00:00.000Z");
  assert.equal(missingHourlyScalar.temperatureC, null, "TAF TX stays an annotation when the hourly NWS scalar is unavailable");
  assert.equal(missingHourlyScalar.temperatureExtrema[0].valueC, 31);
  assert.equal(missingHourlyScalar.temperatureExtremaProvenance.product, "TAF");
});

test("NWS grid parameters fail closed on units, invalid values, overlaps, and the 36-hour boundary", () => {
  const wrongUnits = parseNwsGridForecast(nwsGridForecast({
    temperatureUnit: "wmoUnit:degF",
    precipitationUnit: "wmoUnit:percent",
    snowfallUnit: "wmoUnit:cm",
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(wrongUnits.temperatureIntervals, []);
  assert.deepEqual(wrongUnits.quantitativePrecipitationIntervals, []);
  assert.deepEqual(wrongUnits.snowfallAmountIntervals, []);
  assert.ok(wrongUnits.dewPointIntervals.length > 0, "one bad parameter does not fabricate or erase another valid field");

  const invalidAmounts = parseNwsGridForecast(nwsGridForecast({
    quantitativePrecipitation: [
      { validTime: "2026-09-01T06:00:00Z/PT3H", value: null },
      { validTime: "2026-09-01T09:00:00Z/PT3H", value: -1 },
      { validTime: "2026-09-01T12:00:00Z/PT0H", value: 10 },
    ],
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(invalidAmounts.quantitativePrecipitationIntervals, []);

  const nullAndStringValues = parseNwsGridForecast(nwsGridForecast({
    temperature: [
      { validTime: "2026-09-01T03:00:00Z/PT1H", value: null },
      { validTime: "2026-09-01T04:00:00Z/PT1H", value: "25" },
    ],
    quantitativePrecipitation: [
      { validTime: "2026-09-01T06:00:00Z/PT3H", value: null },
      { validTime: "2026-09-01T09:00:00Z/PT3H", value: "25.4" },
    ],
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(nullAndStringValues.temperatureIntervals, [], "null or non-numeric JSON values never become state scalars");
  assert.deepEqual(nullAndStringValues.quantitativePrecipitationIntervals, [], "null or non-numeric JSON values never become zero/QPF");

  const overlapping = parseNwsGridForecast(nwsGridForecast({
    quantitativePrecipitation: [
      { validTime: "2026-09-01T06:00:00Z/PT6H", value: 2 },
      { validTime: "2026-09-01T06:00:00Z/PT6H", value: 3 },
    ],
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(overlapping.quantitativePrecipitationIntervals, [], "overlapping totals cannot both be rendered as independent QPF");

  const beyondCap = parseNwsGridForecast(nwsGridForecast({
    quantitativePrecipitation: [
      { validTime: "2026-09-02T12:00:00Z/PT6H", value: 25.4 },
    ],
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(beyondCap.quantitativePrecipitationIntervals, [], "an amount interval is dropped rather than clipped at the display cap");
  for (const validTime of ["2026-09-01T06:00:00Z/PT3H", "2026-09-01T06:00:00Z/PT12H", "2026-09-01T07:00:00Z/PT6H"]) {
    const irregularCadence = parseNwsGridForecast(nwsGridForecast({
      quantitativePrecipitation: [{ validTime, value: 25.4 }],
    }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
    assert.deepEqual(irregularCadence.quantitativePrecipitationIntervals, [], `${validTime} is not an aligned official six-hour amount interval`);
  }
  const outsideGlobalTail = parseNwsGridForecast(nwsGridForecast({
    validTimes: "2026-09-01T02:00:00Z/P1D",
    quantitativePrecipitation: [
      { validTime: "2026-09-01T06:00:00Z/PT6H", value: 2.54 },
      { validTime: "2026-09-02T06:00:00Z/PT6H", value: 25.4 },
    ],
  }), { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") });
  assert.deepEqual(outsideGlobalTail.quantitativePrecipitationIntervals.map((entry) => entry.amountIn), [0.1], "an out-of-validity tail is omitted without erasing an earlier valid total");
  assert.equal(parseNwsGridForecast({
    ...nwsGridForecast(), sourceUrl: "https://example.com/not-official",
  }, { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") }), null);
  assert.equal(parseNwsGridForecast({
    ...nwsGridForecast(),
    payload: {
      ...nwsGridForecast().payload,
      properties: { ...nwsGridForecast().payload.properties, gridX: 46 },
    },
  }, { station: "KMEM", now: new Date("2026-09-01T03:15:00Z") }), null, "payload grid identity must match the discovered endpoint");
});

test("observed Prrrr, SNINCR, and depth semantics remain distinct and corrections retain richer amounts", () => {
  const trace = parseMeteogramObservation(report({
    timestamp: "2026-09-01T00:54:00Z",
    raw: "METAR KMEM 010054Z 18005KT 10SM -RA BKN030 22/20 A3000 RMK AO2 P0000 60020 70050 SNINCR 2/005 4/003",
  }));
  assert.equal(trace.precipitation.liquidTrace, true);
  assert.equal(trace.precipitation.liquidEquivalentIn, null);
  assert.equal(trace.precipitation.liquidInterval.validStartZ, null);
  assert.equal(trace.precipitation.liquidInterval.validEndZ, "2026-09-01T00:54:00.000Z");
  assert.equal(trace.precipitation.snowDepthIncreaseIn, 2);
  assert.deepEqual(trace.precipitation.snowDepthIncreaseInterval, {
    validStartZ: "2026-08-31T23:54:00.000Z",
    validEndZ: "2026-09-01T00:54:00.000Z",
    sourceToken: "SNINCR 2/005",
    semantics: "PRECEDING_ONE_HOUR",
  });
  assert.equal(trace.precipitation.snowDepthIn, 3, "4/sss remains depth and overrides the SNINCR depth value");

  const model = buildMeteogramModel([
    report({ timestamp: "2026-08-31T22:54:00Z", raw: "METAR KMEM 312254Z 18005KT 10SM CLR 27/18 A3000" }),
    report({ timestamp: "2026-08-31T23:10:00Z", product: "SPECI", raw: "SPECI KMEM 312310Z 18005KT 5SM -RA BKN030 26/19 A2999 RMK P0002" }),
    report({ timestamp: "2026-08-31T23:30:00Z", product: "SPECI", raw: "SPECI KMEM 312330Z 18005KT 3SM RA BKN020 25/20 A2998 RMK P0005" }),
    report({ timestamp: "2026-08-31T23:54:00Z", raw: "METAR KMEM 312354Z 18005KT 2SM RA BKN015 24/21 A2997 RMK P0008" }),
    report({ timestamp: "2026-09-01T00:10:00Z", product: "SPECI", raw: "SPECI KMEM 010010Z 18005KT 2SM RA BKN010 23/21 A2996 RMK P0003" }),
    report({ timestamp: "2026-09-01T00:30:00Z", product: "SPECI", raw: "SPECI KMEM 010030Z 18005KT 1SM +RA BKN008 23/22 A2995 RMK P0007" }),
  ], { station: "KMEM" });
  assert.deepEqual(model.observedPrecipitationIntervals.map((entry) => ({
    start: entry.validStartZ, end: entry.validEndZ, amount: entry.amountIn, type: entry.reportType,
  })), [
    { start: "2026-08-31T22:54:00.000Z", end: "2026-08-31T23:54:00.000Z", amount: 0.08, type: "METAR" },
    { start: "2026-08-31T23:54:00.000Z", end: "2026-09-01T00:30:00.000Z", amount: 0.07, type: "SPECI" },
  ], "the closing routine total wins, then only the latest open-interval SPECI remains");
  assert.equal(model.observations.length, 6, "every exact report remains available to the timeline/table");

  const revised = buildMeteogramModel([
    report({ timestamp: "2026-09-01T00:54:00Z", raw: "METAR KMEM 010054Z 18005KT 10SM CLR 23/18 A3000" }),
    report({ timestamp: "2026-09-01T00:54:00Z", raw: "METAR KMEM 010054Z 18005KT 10SM CLR 23/18 A3000 RMK P0012" }),
  ], { station: "KMEM" });
  assert.equal(revised.observations.length, 1);
  assert.equal(revised.observations[0].precipitation.liquidEquivalentIn, 0.12);
  assert.equal(revised.observations[0].revised, true);

  const unavailable = parseMeteogramObservation(report({
    timestamp: "2026-09-01T01:54:00Z",
    raw: "METAR KMEM 010154Z 18005KT 10SM CLR 23/18 A3000 RMK AO2 PNO P0099",
  }));
  assert.equal(unavailable.precipitation.precipitationNotAvailable, true);
  assert.equal(unavailable.precipitation.liquidEquivalentIn, null, "PNO overrides a contradictory Prrrr group");
  assert.equal(unavailable.precipitation.liquidInterval, null);

  const missingRoutine = buildMeteogramModel([
    report({ timestamp: "2026-08-31T22:54:00Z", raw: "METAR KMEM 312254Z 18005KT 10SM CLR 27/18 A3000" }),
    report({ timestamp: "2026-09-01T00:54:00Z", raw: "METAR KMEM 010054Z 18005KT 10SM CLR 23/18 A3000 RMK P0012" }),
  ], { station: "KMEM" });
  assert.equal(missingRoutine.observations[1].precipitation.liquidInterval.validStartZ, null);
  assert.equal(missingRoutine.observations[1].precipitation.liquidInterval.semantics, "START_UNAVAILABLE");
  assert.equal(missingRoutine.observedPrecipitationIntervals[0].amountIn, 0.12, "the reported amount is preserved without inventing an interval start");
  assert.equal(missingRoutine.observedPrecipitationIntervals[0].validStartZ, null);
});
