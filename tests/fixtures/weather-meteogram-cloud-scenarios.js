import { buildMeteogramSvgMarkup, meteogramRowLabelLayout } from "../../weather-meteogram.js";

function cloudState(tokens) {
  const layers = tokens.map((token) => {
    const match = token.match(/^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU)?$/);
    if (!match) throw new Error(`Invalid deterministic cloud token ${token}`);
    return {
      cover: match[1],
      heightFt: match[2] === "///" ? null : Number(match[2]) * 100,
      convective: match[3] || "",
      raw: token,
    };
  });
  const ceilings = layers.filter((layer) => ["BKN", "OVC", "VV"].includes(layer.cover) && Number.isFinite(layer.heightFt));
  return {
    layers,
    clear: false,
    cavok: false,
    ceilingFt: ceilings.length ? Math.min(...ceilings.map((layer) => layer.heightFt)) : null,
    display: tokens.join(" · "),
  };
}

function point(index, { clouds = cloudState(["FEW050"]), weatherCodes = [] } = {}) {
  const observedZ = new Date(Date.parse("2026-09-01T12:00:00Z") + index * 3 * 60 * 60 * 1000).toISOString();
  return {
    station: "KMEM", observedZ, validZ: null, kind: "OBSERVED", reportType: "METAR",
    raw: `METAR KMEM SCENARIO ${clouds.display} ${weatherCodes.join(" ")}`,
    source: "Deterministic visual fixture", temperatureC: 24, dewPointC: 18,
    windDirectionDeg: 240, windVariable: false, windSpeedKt: 12, windGustKt: null,
    pressureInHg: 30, visibilitySm: 10, visibilityQualifier: "", visibilityDisplay: "10 SM",
    clouds, weatherCodes,
    weather: { icon: weatherCodes.some((code) => code.includes("TS")) ? "⚡" : weatherCodes.some((code) => /SN/.test(code)) ? "❄" : weatherCodes.some((code) => /RA|DZ/.test(code)) ? "☂" : "☁", label: weatherCodes.join(" ") || "CLOUD" },
    precipitation: { rainObserved: /RA|DZ/.test(weatherCodes.join(" ")), snowObserved: /SN|SG|PL|GS/.test(weatherCodes.join(" ")), liquidEquivalentIn: null, liquidTrace: false, snowDepthIncreaseIn: null, snowDepthIn: null },
    conditional: [], becoming: [], temperatureExtrema: [], fieldProvenance: { temperature: null, dewPoint: null },
  };
}

function model(points) {
  return {
    station: "KMEM", timeZone: "America/Chicago", observations: points, forecasts: [], timeline: points,
    dividerZ: null, taf: null, supplemental: null, observedSources: ["Deterministic visual fixture"],
    observedPrecipitationIntervals: [], observedSnowDepthIncreaseIntervals: [], forecastPrecipitationIntervals: [], forecastSnowfallIntervals: [], revisedBuckets: 0,
  };
}

const scenarios = [
  {
    id: "coverage-comparison",
    title: "FEW050 · SCT050 · BKN050 · OVC050 · VV005",
    note: "Identical comparison domain: sparse FEW, separated SCT groups, mostly-continuous BKN with breaks, uninterrupted OVC, and a low obscuration/wisp VV scene.",
    points: ["FEW050", "SCT050", "BKN050", "OVC050", "VV005"].map((token, index) => point(index, { clouds: cloudState([token]) })),
  },
  {
    id: "multilayer",
    title: "FEW065 + BKN085",
    note: "Two independently anchored layers; CIG remains the exact BKN 8,500 FT base.",
    points: [point(0, { clouds: cloudState(["FEW065", "BKN085"]) })],
  },
  {
    id: "convective",
    title: "SCT025TCU · BKN030CB · BKN030CB TSRA",
    note: "TCU and CB are symbolic vertical morphology rooted at reported bases. Lightning appears only in the TSRA column.",
    points: [
      point(0, { clouds: cloudState(["SCT025TCU"]) }),
      point(1, { clouds: cloudState(["BKN030CB"]) }),
      point(2, { clouds: cloudState(["BKN030CB"]), weatherCodes: ["TSRA"] }),
    ],
  },
  {
    id: "rain-intensity",
    title: "BKN030 -RA · BKN030 RA · BKN030 +RA",
    note: "Qualitative light/moderate/heavy density only; no rate or producing layer is inferred.",
    points: ["-RA", "RA", "+RA"].map((code, index) => point(index, { clouds: cloudState(["BKN030"]), weatherCodes: [code] })),
  },
  {
    id: "snow-freezing",
    title: "OVC008 +SN · OVC005 FZRA",
    note: "Heavy snow density and freezing-rain glaze accents remain qualitative; no amount is implied.",
    points: [
      point(0, { clouds: cloudState(["OVC008"]), weatherCodes: ["+SN"] }),
      point(1, { clouds: cloudState(["OVC005"]), weatherCodes: ["FZRA"] }),
    ],
  },
  {
    id: "vertical-visibility",
    title: "VV002 FG",
    note: "Vertical visibility is an obscuration veil with rising wisps plus separate fog bands—not an overcast deck.",
    points: [point(0, { clouds: cloudState(["VV002"]), weatherCodes: ["FG"] })],
  },
];

const gallery = document.getElementById("scenarioGallery");
for (const scenario of scenarios) {
  const article = document.createElement("article");
  article.id = scenario.id;
  const scenarioModel = model(scenario.points);
  const labelLayout = meteogramRowLabelLayout({ timeMode: "Z", temperatureUnit: "C", windUnit: "KT" }, 1240, { hasForecast: false });
  const svg = buildMeteogramSvgMarkup(scenarioModel, { timeMode: "Z", temperatureUnit: "C", windUnit: "KT" }, { viewportWidth: 1240, labelLayout, pixelsPerHour: 60, idPrefix: `scenario${scenario.id.replace(/[^a-z0-9]/gi, "")}` });
  article.innerHTML = `<h2>${scenario.title}</h2><div class="scenario-window"><div class="aviation-meteogram-stage" style="width:1240px">${svg}</div></div><p class="scenario-note">${scenario.note}</p>`;
  gallery.appendChild(article);
}
