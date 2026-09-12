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

function point(observedZ, reportType, tokens, weatherCodes, visibilitySm, {
  windDirectionDeg = 220,
  windSpeedKt = 18,
  windGustKt = 30,
  pressureInHg = 29.78,
  liquidEquivalentIn = null,
  liquidInterval = null,
} = {}) {
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
    windDirectionDeg,
    windVariable: false,
    windSpeedKt,
    windGustKt,
    pressureInHg,
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
      liquidEquivalentIn,
      liquidTrace: false,
      liquidInterval,
      precipitationNotAvailable: liquidEquivalentIn === null,
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
  "2026-09-11T21:42:00.000Z",
  "2026-09-11T21:52:00.000Z",
  "2026-09-11T22:03:00.000Z",
  "2026-09-11T22:09:00.000Z",
  "2026-09-11T22:18:00.000Z",
]);

export function denseThunderstormMeteogramFixture() {
  const observations = [
    point("2026-09-11T11:30:00.000Z", "METAR", ["SCT090", "BKN120"], [], 10),
    point("2026-09-11T20:30:00.000Z", "METAR", ["SCT040", "BKN060"], ["-RA"], 6),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[0], "SPECI", ["SCT030CB", "BKN050", "OVC100"], ["TSRA"], 2.5, { windDirectionDeg: 210, windSpeedKt: 18, windGustKt: 30, pressureInHg: 29.78, liquidEquivalentIn: 0.12, liquidInterval: "12 MIN" }),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[1], "SPECI", ["FEW017", "SCT025", "BKN030CB", "OVC085"], ["TSRA"], 1, { windDirectionDeg: 220, windSpeedKt: 23, windGustKt: 38, pressureInHg: 29.74, liquidEquivalentIn: 0.20, liquidInterval: "10 MIN" }),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[2], "SPECI", ["SCT012", "BKN016CB", "OVC040"], ["+TSRA"], 0.5, { windDirectionDeg: 240, windSpeedKt: 32, windGustKt: 52, pressureInHg: 29.70, liquidEquivalentIn: 0.42, liquidInterval: "11 MIN" }),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[3], "SPECI", ["FEW008", "BKN011CB", "OVC028"], ["TSRA"], 1, { windDirectionDeg: 250, windSpeedKt: 28, windGustKt: 44, pressureInHg: 29.72, liquidEquivalentIn: 0.24, liquidInterval: "6 MIN" }),
    point(DENSE_THUNDERSTORM_TARGET_TIMES[4], "SPECI", ["SCT023", "BKN035", "OVC070"], ["VCTS"], 3, { windDirectionDeg: 230, windSpeedKt: 19, windGustKt: 31, pressureInHg: 29.76, liquidEquivalentIn: 0.08, liquidInterval: "9 MIN" }),
    point("2026-09-11T22:48:00.000Z", "METAR", ["SCT070", "BKN110"], ["-RA"], 6),
    point("2026-09-12T11:30:00.000Z", "METAR", ["SCT090", "BKN120"], [], 10),
  ];
  const observedPrecipitationIntervals = DENSE_THUNDERSTORM_TARGET_TIMES.map((validEndZ, index) => ({
    kind: "OBSERVED",
    validStartZ: index ? DENSE_THUNDERSTORM_TARGET_TIMES[index - 1] : "2026-09-11T21:30:00.000Z",
    validEndZ,
    amountIn: [0.12, 0.20, 0.42, 0.24, 0.08][index],
    trace: false,
    source: "Synthetic dense-thunderstorm renderer fixture",
    sourceToken: "SYNTHETIC",
  }));
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
    observedPrecipitationIntervals,
    observedSnowDepthIncreaseIntervals: [],
    forecastPrecipitationIntervals: [],
    forecastSnowfallIntervals: [],
    revisedBuckets: 0,
  };
}
