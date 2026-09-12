function layer(raw) {
  const match = String(raw).match(/^(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?$/);
  if (!match) throw new Error(`Invalid synthetic cloud token: ${raw}`);
  return {
    cover: match[1],
    heightFt: Number(match[2]) * 100,
    convective: match[3] || "",
    raw,
  };
}

function cloudState(tokens) {
  const layers = tokens.map(layer);
  const ceilingLayers = layers.filter(({ cover }) => ["BKN", "OVC", "VV"].includes(cover));
  return {
    layers,
    clear: false,
    cavok: false,
    ceilingFt: ceilingLayers.length ? Math.min(...ceilingLayers.map(({ heightFt }) => heightFt)) : null,
    display: tokens.join(" · "),
  };
}

function point(observedZ, reportType, tokens, weatherCodes, visibilitySm) {
  const clouds = cloudState(tokens);
  return {
    station: "KMEM",
    observedZ,
    validZ: null,
    kind: "OBSERVED",
    reportType,
    raw: `${reportType} KMEM SYNTHETIC ${weatherCodes.join(" ")} ${tokens.join(" ")}`,
    source: "Synthetic dense-thunderstorm renderer fixture",
    temperatureC: 24,
    dewPointC: 22,
    windDirectionDeg: 220,
    windVariable: false,
    windSpeedKt: 18,
    windGustKt: 30,
    pressureInHg: 29.78,
    pressureReference: "ALTIMETER",
    visibilitySm,
    visibilityQualifier: "",
    visibilityDisplay: `${visibilitySm} SM`,
    clouds,
    weatherCodes,
    weather: { icon: weatherCodes.some((code) => code.includes("TS")) ? "⚡" : "☁", label: weatherCodes.join(" ") || "CLOUD" },
    precipitation: {
      rainObserved: weatherCodes.some((code) => /RA|DZ/.test(code)),
      snowObserved: false,
      rainForecast: false,
      snowForecast: false,
      conditionalRainForecast: false,
      conditionalSnowForecast: false,
      liquidEquivalentIn: null,
      liquidTrace: false,
      liquidInterval: null,
      precipitationNotAvailable: true,
      snowDepthIncreaseIn: null,
      snowDepthIncreaseInterval: null,
      snowDepthIn: null,
    },
    conditional: [],
    becoming: [],
    temperatureExtrema: [],
    fieldProvenance: { temperature: null, dewPoint: null, pressure: null },
  };
}

export const DENSE_THUNDERSTORM_TARGET_TIMES = Object.freeze([
  "2026-09-11T21:52:00.000Z",
  "2026-09-11T22:09:00.000Z",
  "2026-09-11T22:28:00.000Z",
]);

export function denseThunderstormMeteogramFixture() {
  const observations = [
    point("2026-09-11T11:30:00.000Z", "METAR", ["SCT090", "BKN120"], [], 10),
    point("2026-09-11T21:30:00.000Z", "METAR", ["SCT040", "BKN060"], ["-RA"], 6),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[0], "SPECI", ["SCT030CB", "BKN050", "OVC100"], ["TSRA"], 2.5),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[1], "SPECI", ["FEW017", "SCT025", "BKN030CB", "OVC085"], ["TSRA"], 1),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[2], "SPECI", ["SCT055", "BKN085", "OVC095"], ["VCTS"], 4),
    point("2026-09-11T22:48:00.000Z", "METAR", ["SCT070", "BKN110"], ["-RA"], 6),
    point("2026-09-12T11:30:00.000Z", "METAR", ["SCT090", "BKN120"], [], 10),
  ];
  return {
    station: "KMEM",
    timeZone: "America/Chicago",
    observations,
    forecasts: [],
    timeline: observations,
    dividerZ: null,
    taf: null,
    supplemental: null,
    pressureForecast: null,
    observedSources: ["Synthetic dense-thunderstorm renderer fixture"],
    observedPrecipitationIntervals: [],
    observedSnowDepthIncreaseIntervals: [],
    forecastPrecipitationIntervals: [],
    forecastSnowfallIntervals: [],
    revisedBuckets: 0,
  };
}
