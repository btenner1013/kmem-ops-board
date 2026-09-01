import {
  LOOKUP_RANGES,
  decodeMetarReport,
  decodeTafReport,
  formatStationLocalTime,
  isValidIcao,
  lookupAviationWeather,
  normalizeIcao,
} from "./aviation-weather-lookup-core.js";
import { meteogramLookupRequest } from "./weather-meteogram-core.js";
import { renderAviationMeteogram } from "./weather-meteogram.js";

const PRODUCT_NAMES = new Set(["ATIS", "METAR", "TAF", "METEOGRAM"]);
const LOOKUP_TIMEOUT_MS = 30000;
const METEOGRAM_REFRESH_MS = 5 * 60 * 1000;
const TAF_SNAPSHOT_SCHEMA_VERSION = 1;
const TAF_SNAPSHOT_SOURCE_POLICY = "NOAA_AWC_COMPLETE_CURRENT_CACHE";
const ATIS_GURU_REFERENCE_BASE_URL = "https://atis.guru/atis/";
const ATIS_GURU_REFERENCE_LABEL = "ATIS.guru reference ↗";
const ATIS_GURU_REFERENCE_WARNING = "External reference only — currentness not validated";
const ATIS_GURU_REFERENCE_STATES = new Set(["unsupported", "unavailable", "empty", "error"]);

export function applyLookupDialogState(elements, open, scheduleFocus = (callback) => callback()) {
  const { overlay, body, focusTarget, returnFocus } = elements || {};
  if (!overlay) return;
  overlay.hidden = !open;
  overlay.setAttribute("aria-hidden", open ? "false" : "true");
  body?.classList?.toggle("aviation-lookup-open", open);
  const target = open ? focusTarget : returnFocus;
  if (target?.focus) scheduleFocus(() => target.focus());
}

export function formatZulu(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(8, 10)}${date.toISOString().slice(11, 16).replace(":", "")}Z`
    : "TIME UNKNOWN";
}

export function getAtisGuruReference({ station, product, range, response } = {}) {
  const icao = normalizeIcao(station);
  const reports = Array.isArray(response?.reports) ? response.reports : [];
  if (
    !isValidIcao(icao)
    || icao === "KMEM"
    || String(product || "").trim().toUpperCase() !== "ATIS"
    || String(range || "") !== "recent"
    || !ATIS_GURU_REFERENCE_STATES.has(response?.state)
    || reports.length
  ) {
    return null;
  }
  return {
    href: `${ATIS_GURU_REFERENCE_BASE_URL}${icao}`,
    label: ATIS_GURU_REFERENCE_LABEL,
    warning: ATIS_GURU_REFERENCE_WARNING,
    target: "_blank",
    rel: "noopener noreferrer",
  };
}

export function renderAtisGuruReference(container, reference) {
  if (!container || !reference) return null;
  const ownerDocument = container.ownerDocument || document;
  const block = ownerDocument.createElement("div");
  block.className = "aviation-lookup-external-reference";

  const link = ownerDocument.createElement("a");
  link.textContent = reference.label;
  link.setAttribute("href", reference.href);
  link.setAttribute("target", reference.target);
  link.setAttribute("rel", reference.rel);

  const warning = ownerDocument.createElement("span");
  warning.textContent = reference.warning;
  block.append(link, warning);
  container.appendChild(block);
  return block;
}

function clearChildren(element) {
  while (element?.firstChild) element.removeChild(element.firstChild);
}

export function formatReportIdentity(report) {
  const product = String(report?.product || "").trim().toUpperCase();
  const station = String(report?.station || "").trim().toUpperCase();
  const rawVariant = String(report?.variant || "").trim().toUpperCase();
  const isLocalAtisArchive = report?.source === "KMEM local D-ATIS archive";
  const hideGenericArchiveVariant = isLocalAtisArchive && ["COMBINED", "OTHER"].includes(rawVariant);
  const variant = rawVariant && !hideGenericArchiveVariant ? ` ${rawVariant}` : "";
  const rawLetter = String(report?.letterName || report?.letter || "").trim().toUpperCase();
  const letter = rawLetter ? ` INFO ${rawLetter}` : "";
  return `${product}${variant} ${station}${letter}`.trim();
}

function appendDecodedReport(container, decoded) {
  const heading = document.createElement("div");
  heading.className = "aviation-lookup-decoded-heading";
  heading.textContent = decoded?.title || "DECODED REPORT";

  const disclaimer = document.createElement("div");
  disclaimer.className = "aviation-lookup-decoded-disclaimer";
  disclaimer.textContent = "DECODED — FOR REFERENCE ONLY";
  container.append(heading, disclaimer);

  for (const section of Array.isArray(decoded?.sections) ? decoded.sections : []) {
    const block = document.createElement("section");
    block.className = "aviation-lookup-decoded-section";
    const title = document.createElement("h3");
    title.textContent = section.heading || "DETAILS";
    const list = document.createElement("dl");
    for (const line of Array.isArray(section.lines) ? section.lines : []) {
      const term = document.createElement("dt");
      term.textContent = String(line?.label || "DETAIL");
      const detail = document.createElement("dd");
      detail.textContent = String(line?.value || "UNKNOWN");
      list.append(term, detail);
    }
    block.append(title, list);
    container.appendChild(block);
  }

  const undecoded = Array.isArray(decoded?.undecoded) ? decoded.undecoded.filter(Boolean) : [];
  if (undecoded.length) {
    const unknown = document.createElement("section");
    unknown.className = "aviation-lookup-decoded-section aviation-lookup-undecoded";
    const title = document.createElement("h3");
    title.textContent = "UNDECODED";
    const value = document.createElement("p");
    value.textContent = undecoded.map((token) => `[${token}]`).join(" ");
    unknown.append(title, value);
    container.appendChild(unknown);
  }
}

export async function fetchCurrentTafSnapshot({
  station,
  now = new Date(),
  signal,
  fetchImpl = fetch,
  baseUrl = "http://localhost/",
} = {}) {
  const requestedStation = normalizeIcao(station);
  const url = new URL("./taf_current.json", baseUrl);
  url.searchParams.set("lookup", String(new Date(now).getTime()));
  const response = await fetchImpl(url.toString(), {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status || "ERROR"}`);
  const payload = await response.json();
  if (
    payload?.schemaVersion !== TAF_SNAPSHOT_SCHEMA_VERSION
    || payload?.sourcePolicy !== TAF_SNAPSHOT_SOURCE_POLICY
    || !Array.isArray(payload?.reports)
  ) {
    throw new Error("Current TAF snapshot schema is invalid");
  }
  return payload.reports
    .filter((report) => normalizeIcao(report?.station) === requestedStation)
    .map((report) => ({
      ...report,
      timestamp: report.issueTime,
      issuanceTime: report.issueTime,
      source: "NOAA Aviation Weather Center current TAF cache",
    }));
}

export function toggleDecodedReport(toggle, panel) {
  if (!toggle || !panel) return false;
  const expanded = toggle.getAttribute("aria-expanded") !== "true";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.textContent = expanded ? "HIDE DECODED" : "DECODE";
  panel.hidden = !expanded;
  return expanded;
}

function decodedReport(report) {
  const product = String(report?.product || "").toUpperCase();
  const options = {
    station: report?.station,
    timestamp: report?.timestamp,
    variant: report?.variant,
    referenceTime: report?.timestamp,
  };
  if (product === "METAR" || product === "SPECI") return decodeMetarReport(report, options);
  if (product === "TAF") return decodeTafReport(report, options);
  return null;
}

export function renderResultCards(container, reports) {
  clearChildren(container);
  for (const report of reports) {
    const card = document.createElement("article");
    card.className = "aviation-lookup-result";

    const meta = document.createElement("div");
    meta.className = "aviation-lookup-result-meta";
    const identity = document.createElement("strong");
    identity.textContent = formatReportIdentity(report);
    const timeStack = document.createElement("span");
    timeStack.className = "aviation-lookup-result-times";
    const zulu = document.createElement("span");
    zulu.className = "aviation-lookup-result-zulu";
    zulu.textContent = formatZulu(report.timestamp);
    const local = document.createElement("span");
    local.className = "aviation-lookup-result-local";
    const localTime = formatStationLocalTime(report.timestamp, report.station, { includeYear: false });
    local.textContent = localTime === "LOCAL TIME UNAVAILABLE" ? localTime : `LOCAL: ${localTime}`;
    timeStack.append(zulu, local);
    meta.append(identity, timeStack);

    const rawLabel = document.createElement("div");
    rawLabel.className = "aviation-lookup-raw-label";
    rawLabel.textContent = "RAW";

    const raw = document.createElement("pre");
    raw.className = "aviation-lookup-raw";
    raw.textContent = report.displayText || report.raw;

    card.append(meta, rawLabel, raw);

    const decoded = decodedReport(report);
    if (decoded) {
      const controls = document.createElement("div");
      controls.className = "aviation-lookup-result-controls";
      const toggle = document.createElement("button");
      toggle.className = "aviation-lookup-decode-toggle";
      toggle.type = "button";
      toggle.textContent = "DECODE";
      toggle.setAttribute("aria-expanded", "false");
      const decodePanel = document.createElement("div");
      decodePanel.className = "aviation-lookup-decoded";
      decodePanel.hidden = true;
      appendDecodedReport(decodePanel, decoded);
      toggle.addEventListener("click", () => {
        toggleDecodedReport(toggle, decodePanel);
      });
      controls.appendChild(toggle);
      card.append(controls, decodePanel);
    }
    container.appendChild(card);
  }
}

function setStatus(statusElement, headline, detail = "", tone = "normal") {
  statusElement.className = `aviation-lookup-status aviation-lookup-status-${tone}`;
  statusElement.textContent = "";
  const heading = document.createElement("strong");
  heading.textContent = headline;
  statusElement.appendChild(heading);
  if (detail) {
    const explanation = document.createElement("span");
    explanation.textContent = detail;
    statusElement.appendChild(explanation);
  }
}

function focusableElements(panel) {
  return [...panel.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.offsetParent !== null);
}

export function initializeAviationWeatherLookup(doc = document) {
  const overlay = doc.getElementById("aviationWeatherLookupOverlay");
  const panel = doc.getElementById("aviationWeatherLookupPanel");
  const closeButton = doc.getElementById("aviationWeatherLookupClose");
  const printButton = doc.getElementById("aviationWeatherLookupPrint");
  const form = doc.getElementById("aviationWeatherLookupForm");
  const stationInput = doc.getElementById("aviationWeatherLookupStation");
  const rangeSelect = doc.getElementById("aviationWeatherLookupRange");
  const submitButton = doc.getElementById("aviationWeatherLookupSubmit");
  const status = doc.getElementById("aviationWeatherLookupStatus");
  const results = doc.getElementById("aviationWeatherLookupResults");
  const printSummary = doc.getElementById("aviationWeatherLookupPrintSummary");
  const productButtons = [...doc.querySelectorAll("[data-aviation-product]")];
  if (!overlay || !panel || !closeButton || !printButton || !form || !stationInput || !rangeSelect || !submitButton || !status || !results || !printSummary) return null;

  let product = "ATIS";
  const rangeByProduct = new Map([[product, rangeSelect.value]]);
  let returnFocus = null;
  let requestNumber = 0;
  let activeController = null;
  let activeMeteogram = null;
  let meteogramRefreshTimer = 0;
  let currentReports = [];
  const view = doc.defaultView || window;

  function disposeMeteogram() {
    activeMeteogram?.destroy?.();
    activeMeteogram = null;
  }

  function stopMeteogramRefresh() {
    if (!meteogramRefreshTimer) return;
    view.clearTimeout(meteogramRefreshTimer);
    meteogramRefreshTimer = 0;
  }

  function scheduleMeteogramRefresh() {
    stopMeteogramRefresh();
    if (overlay.hidden || product !== "METEOGRAM" || !isValidIcao(stationInput.value)) return;
    meteogramRefreshTimer = view.setTimeout(async () => {
      meteogramRefreshTimer = 0;
      if (overlay.hidden || product !== "METEOGRAM") return;
      await runLookup({ preserveMeteogramView: true });
    }, METEOGRAM_REFRESH_MS);
  }

  function clearResultState(headline = "READY", detail = "") {
    stopMeteogramRefresh();
    requestNumber += 1;
    activeController?.abort();
    activeController = null;
    disposeMeteogram();
    currentReports = [];
    printButton.disabled = true;
    clearChildren(results);
    setStatus(status, headline, detail);
  }

  function updatePrintSummary() {
    const rangeLabel = rangeSelect.options?.[rangeSelect.selectedIndex]?.textContent || rangeSelect.value;
    const now = new Date();
    printSummary.textContent = "";
    for (const [label, value] of [
      ["AIRPORT", normalizeIcao(stationInput.value)],
      ["PRODUCT", product],
      ["RANGE", rangeLabel],
      ["GENERATED", `${now.toISOString().slice(0, 16).replace("T", " ")}Z`],
    ]) {
      const row = doc.createElement("div");
      const term = doc.createElement("strong");
      term.textContent = `${label}: `;
      row.append(term, doc.createTextNode(value));
      printSummary.appendChild(row);
    }
  }

  function setProduct(nextProduct) {
    const normalized = String(nextProduct || "").toUpperCase();
    if (!PRODUCT_NAMES.has(normalized)) return;
    stopMeteogramRefresh();
    if (normalized !== product) {
      const outgoingRange = rangeSelect.value;
      rangeByProduct.set(product, outgoingRange);
      product = normalized;
      rangeSelect.value = rangeByProduct.get(normalized)
        || (normalized === "METEOGRAM" && outgoingRange === "recent" ? "24" : outgoingRange);
      rangeByProduct.set(normalized, rangeSelect.value);
    }
    panel.classList.toggle("aviation-lookup-panel-meteogram", normalized === "METEOGRAM");
    for (const button of productButtons) {
      const selected = button.dataset.aviationProduct === normalized;
      button.classList.toggle("aviation-lookup-product-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }

  function close() {
    requestNumber += 1;
    activeController?.abort();
    activeController = null;
    stopMeteogramRefresh();
    disposeMeteogram();
    applyLookupDialogState(
      { overlay, body: doc.body, focusTarget: stationInput, returnFocus },
      false,
    );
  }

  async function runLookup(options = {}) {
    const preservedMeteogramView = options?.preserveMeteogramView
      ? activeMeteogram?.getViewState?.() || null
      : null;
    stopMeteogramRefresh();
    if (product === "METEOGRAM" && rangeSelect.value === "recent") rangeSelect.value = "24";
    rangeByProduct.set(product, rangeSelect.value);
    const station = normalizeIcao(stationInput.value);
    stationInput.value = station;
    const meteogramRequest = product === "METEOGRAM"
      ? meteogramLookupRequest({ station, range: rangeSelect.value })
      : null;
    requestNumber += 1;
    const currentRequest = requestNumber;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

    submitButton.disabled = true;
    printButton.disabled = true;
    currentReports = [];
    disposeMeteogram();
    setStatus(status, "LOADING...", "", "loading");
    clearChildren(results);

    const lookupNow = new Date();
    const lookupOptions = {
      station: meteogramRequest?.station || station,
      product: meteogramRequest?.product || product,
      range: meteogramRequest?.range || rangeSelect.value,
      now: lookupNow,
      fetchImpl: view.fetch.bind(view),
      currentTafProvider: (providerRequest) => fetchCurrentTafSnapshot({
        ...providerRequest,
        fetchImpl: view.fetch.bind(view),
        baseUrl: doc.baseURI,
      }),
      baseUrl: doc.baseURI,
      signal: controller.signal,
    };
    const responsePromise = lookupAviationWeather(lookupOptions);
    const tafResponsePromise = product === "METEOGRAM"
      ? lookupAviationWeather({ ...lookupOptions, product: "TAF", range: "recent" })
      : Promise.resolve(null);
    const [response, tafResponse] = await Promise.all([responsePromise, tafResponsePromise]);
    clearTimeout(timeout);
    if (currentRequest !== requestNumber) return;
    if (activeController === controller) activeController = null;
    submitButton.disabled = false;
    scheduleMeteogramRefresh();

    if (response.state === "success") {
      const count = response.reports.length;
      if (product === "METEOGRAM") {
        const rangeLabel = rangeSelect.options?.[rangeSelect.selectedIndex]?.textContent || `Past ${meteogramRequest.range} hours`;
        activeMeteogram = renderAviationMeteogram(results, response.reports, {
          station,
          rangeLabel,
          tafReports: tafResponse?.state === "success" ? tafResponse.reports : [],
          now: lookupNow,
          doc,
          view,
          initialViewState: preservedMeteogramView,
        });
        if (!activeMeteogram) {
          setStatus(status, "INSUFFICIENT HISTORY", "No complete METAR/SPECI observations could be plotted.", "warning");
          return;
        }
        setStatus(
          status,
          `${activeMeteogram.model.observations.length} OBS · ${activeMeteogram.model.forecasts.length} TAF FCST`,
          [
            response.detail,
            tafResponse?.detail,
            activeMeteogram.model.forecasts.length
              ? "The future side is rebuilt from the current valid TAF; TEMPO/PROB remain conditional and uncoded values stay missing."
              : activeMeteogram.model.taf?.warning
                || "Current TAF unavailable; exact METAR/SPECI history remains displayed without a forecast projection.",
          ].filter(Boolean).join(" "),
          response.partialFailures || tafResponse?.partialFailures || !activeMeteogram.model.forecasts.length ? "warning" : "success",
        );
        currentReports = [...response.reports, ...(tafResponse?.state === "success" ? tafResponse.reports : [])];
        printButton.disabled = false;
        return;
      }
      setStatus(
        status,
        `${count} ${count === 1 ? "REPORT" : "REPORTS"}`,
        response.detail,
        response.partialFailures ? "warning" : "success",
      );
      currentReports = response.reports;
      printButton.disabled = false;
      renderResultCards(results, response.reports);
      return;
    }

    const tone = response.state === "invalid" || response.state === "error" || response.state === "unavailable"
      ? "error"
      : "warning";
    setStatus(status, response.headline, response.detail, tone);
    const externalReference = getAtisGuruReference({
      station,
      product,
      range: rangeSelect.value,
      response,
    });
    if (externalReference) renderAtisGuruReference(results, externalReference);
  }

  function open(opener) {
    returnFocus = opener || doc.activeElement;
    setProduct("ATIS");
    stationInput.value = "KMEM";
    rangeSelect.value = "recent";
    printButton.disabled = true;
    applyLookupDialogState(
      { overlay, body: doc.body, focusTarget: stationInput, returnFocus },
      true,
      (callback) => window.requestAnimationFrame(callback),
    );
    runLookup();
  }

  doc.addEventListener("click", (event) => {
    const opener = event.target.closest?.("#aviationWeatherLookupButton");
    if (!opener) return;
    event.preventDefault();
    open(opener);
  });

  closeButton.addEventListener("click", close);
  printButton.addEventListener("click", () => {
    if (!currentReports.length) return;
    updatePrintSummary();
    doc.body.classList.add("aviation-lookup-printing");
    view.print();
  });
  view.addEventListener("afterprint", () => {
    doc.body.classList.remove("aviation-lookup-printing");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runLookup();
  });
  stationInput.addEventListener("input", () => {
    stationInput.value = stationInput.value.toUpperCase();
    clearResultState("READY", "Press Enter or LOOK UP for the new airport.");
  });
  stationInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runLookup();
  });
  rangeSelect.addEventListener("change", runLookup);
  for (const button of productButtons) {
    button.addEventListener("click", () => {
      setProduct(button.dataset.aviationProduct);
      runLookup();
    });
  }

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(panel);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  setProduct("ATIS");
  return { open, close, runLookup, setProduct, ranges: LOOKUP_RANGES };
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initializeAviationWeatherLookup(document));
  } else {
    initializeAviationWeatherLookup(document);
  }
}
