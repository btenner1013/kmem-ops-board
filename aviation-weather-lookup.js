import {
  LOOKUP_RANGES,
  lookupAviationWeather,
  normalizeIcao,
} from "./aviation-weather-lookup-core.js";

const PRODUCT_NAMES = new Set(["ATIS", "METAR", "TAF"]);
const LOOKUP_TIMEOUT_MS = 30000;

export function applyLookupDialogState(elements, open, scheduleFocus = (callback) => callback()) {
  const { overlay, body, focusTarget, returnFocus } = elements || {};
  if (!overlay) return;
  overlay.hidden = !open;
  overlay.setAttribute("aria-hidden", open ? "false" : "true");
  body?.classList?.toggle("aviation-lookup-open", open);
  const target = open ? focusTarget : returnFocus;
  if (target?.focus) scheduleFocus(() => target.focus());
}

function formatZulu(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`
    : "TIME UNKNOWN";
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

function renderResultCards(container, reports) {
  clearChildren(container);
  for (const report of reports) {
    const card = document.createElement("article");
    card.className = "aviation-lookup-result";

    const meta = document.createElement("div");
    meta.className = "aviation-lookup-result-meta";
    const identity = document.createElement("strong");
    identity.textContent = formatReportIdentity(report);
    const time = document.createElement("span");
    time.textContent = formatZulu(report.timestamp);
    meta.append(identity, time);

    const raw = document.createElement("pre");
    raw.className = "aviation-lookup-raw";
    raw.textContent = report.displayText || report.raw;

    const source = document.createElement("div");
    source.className = "aviation-lookup-source";
    source.textContent = `SOURCE: ${report.source || "UNKNOWN"}`;

    card.append(meta, raw, source);
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
  const form = doc.getElementById("aviationWeatherLookupForm");
  const stationInput = doc.getElementById("aviationWeatherLookupStation");
  const rangeSelect = doc.getElementById("aviationWeatherLookupRange");
  const submitButton = doc.getElementById("aviationWeatherLookupSubmit");
  const status = doc.getElementById("aviationWeatherLookupStatus");
  const results = doc.getElementById("aviationWeatherLookupResults");
  const productButtons = [...doc.querySelectorAll("[data-aviation-product]")];
  if (!overlay || !panel || !closeButton || !form || !stationInput || !rangeSelect || !submitButton || !status || !results) return null;

  let product = "ATIS";
  let returnFocus = null;
  let requestNumber = 0;
  let activeController = null;

  function setProduct(nextProduct) {
    const normalized = String(nextProduct || "").toUpperCase();
    if (!PRODUCT_NAMES.has(normalized)) return;
    product = normalized;
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
    applyLookupDialogState(
      { overlay, body: doc.body, focusTarget: stationInput, returnFocus },
      false,
    );
  }

  async function runLookup() {
    const station = normalizeIcao(stationInput.value);
    stationInput.value = station;
    requestNumber += 1;
    const currentRequest = requestNumber;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

    submitButton.disabled = true;
    setStatus(status, "LOADING...", "", "loading");
    clearChildren(results);

    const response = await lookupAviationWeather({
      station,
      product,
      range: rangeSelect.value,
      now: new Date(),
      fetchImpl: window.fetch.bind(window),
      baseUrl: doc.baseURI,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (currentRequest !== requestNumber) return;
    if (activeController === controller) activeController = null;
    submitButton.disabled = false;

    if (response.state === "success") {
      const count = response.reports.length;
      setStatus(
        status,
        `${count} ${count === 1 ? "REPORT" : "REPORTS"}`,
        response.detail,
        response.partialFailures ? "warning" : "success",
      );
      renderResultCards(results, response.reports);
      return;
    }

    const tone = response.state === "invalid" || response.state === "error" || response.state === "unavailable"
      ? "error"
      : "warning";
    setStatus(status, response.headline, response.detail, tone);
  }

  function open(opener) {
    returnFocus = opener || doc.activeElement;
    setProduct("ATIS");
    stationInput.value = "KMEM";
    rangeSelect.value = "recent";
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runLookup();
  });
  stationInput.addEventListener("input", () => {
    stationInput.value = stationInput.value.toUpperCase();
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
