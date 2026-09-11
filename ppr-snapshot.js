import {
  buildRimSlideLines,
  formatPprDate,
  formatPprTime,
  parsePprSnapshotCsv
} from "./ppr-snapshot-core.js";

const DISPLAY_FIELDS = Object.freeze([
  "status",
  "pprNumber",
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
  "estimatedScope"
]);
const MAX_CSV_BYTES = 20 * 1024 * 1024;

const dom = {
  importView: document.querySelector("#importView"),
  loadedView: document.querySelector("#loadedView"),
  dropZone: document.querySelector("#csvDropZone"),
  chooseButton: document.querySelector("#chooseCsvButton"),
  fileInput: document.querySelector("#pprCsvInput"),
  importStatus: document.querySelector("#importStatus"),
  snapshotButton: document.querySelector("#snapshotModeButton"),
  loadAnotherButton: document.querySelector("#loadAnotherButton"),
  clearButton: document.querySelector("#clearPprButton"),
  cards: document.querySelector("#pprCards"),
  emptySnapshot: document.querySelector("#emptySnapshot"),
  rimSection: document.querySelector("#rimSection"),
  rimLines: document.querySelector("#rimLines"),
  copyRimButton: document.querySelector("#copyRimLinesButton"),
  copyRimStatus: document.querySelector("#copyRimStatus")
};

const session = {
  records: [],
  rimText: "",
  busy: false,
  loadEpoch: 0
};

function textElement(tagName, className, value) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function joinVisible(values, separator) {
  return values.filter(hasText).map(value => String(value).trim()).join(separator);
}

function timingText(timing) {
  const date = formatPprDate(timing?.dateLocal);
  const local = formatPprTime(timing?.timeLocal, "L");
  const zulu = formatPprTime(timing?.timeZulu, "Z");
  return joinVisible([date, joinVisible([local, zulu], " / ")], " · ");
}

function estimatedBadge() {
  return textElement("span", "estimated-badge", "ESTIMATED");
}

function renderTimingLine(title, timing, showEstimated) {
  const value = timingText(timing);
  if (!value) return null;
  const line = document.createElement("p");
  line.className = "timing-line";
  line.append(
    textElement("span", "timing-label", `${title}:`),
    textElement("span", "timing-value", value)
  );
  if (showEstimated) line.append(estimatedBadge());
  return line;
}

function appendDetail(container, label, value, { className = "" } = {}) {
  if (!hasText(value)) return;
  container.append(
    textElement("p", `detail-line${className ? ` ${className}` : ""}`, `${label}: ${value}`)
  );
}

function appendCombinedDetails(container, items) {
  const parts = items
    .filter(([, value]) => hasText(value))
    .map(([label, value]) => `${label}: ${String(value).trim()}`);
  if (parts.length) container.append(textElement("p", "detail-line", parts.join(" · ")));
}

function renderPprCard(record) {
  const cancelled = String(record.status || "").toLowerCase().includes("cancel");
  const article = document.createElement("article");
  article.className = `ppr-entry ${cancelled ? "is-cancelled" : "is-approved"}`;
  article.setAttribute(
    "aria-label",
    `${cancelled ? "Cancelled or denied" : "Approved"} PPR ${record.pprNumber || "number unavailable"}`
  );

  const status = document.createElement("header");
  status.className = "ppr-status-line";
  const dot = textElement("span", "status-dot", cancelled ? "🔴" : "🟢");
  dot.setAttribute("aria-hidden", "true");
  status.append(
    dot,
    textElement("span", "status-label", cancelled ? "CANCELLED" : "APPROVED")
  );
  if (hasText(record.pprNumber)) {
    status.append(textElement("span", "ppr-number", `· PPR ${record.pprNumber}`));
  }

  const body = document.createElement("div");
  body.className = "ppr-entry-body";
  const identity = joinVisible([record.callsign, record.aircraftType, record.requestType], " · ");
  if (identity) body.append(textElement("p", "identity-line", identity));

  const route = joinVisible([record.origin, record.destination], " → ");
  if (route) body.append(textElement("p", "route-line", route));

  const scope = record.estimatedScope;
  const arrivalTiming = renderTimingLine("ARR", record.arrival, scope === "arrival" || scope === "both");
  const departureTiming = renderTimingLine("DEP", record.departure, scope === "departure" || scope === "both");
  if (arrivalTiming) body.append(arrivalTiming);
  if (departureTiming) body.append(departureTiming);
  if (scope === "neutral") {
    const neutral = estimatedBadge();
    neutral.classList.add("neutral-estimate");
    body.append(neutral);
  }

  const details = document.createElement("div");
  details.className = "detail-lines";
  if (!cancelled) {
    appendCombinedDetails(details, [
      ["HOME", record.homeStation],
      ["TAIL", record.tailNumbers]
    ]);
    appendDetail(details, "VIP", record.vipCode);
    appendDetail(details, "FUEL", record.fuel);
    appendDetail(details, "TRANS", record.transportation);
    appendDetail(details, "PAX", record.passengers);
    appendDetail(details, "SPECIAL", record.specialRequirements);
    appendDetail(details, "HAZMAT", record.hazmat);
  }
  appendDetail(details, "NOTES", record.notes, { className: "notes-line" });
  if (details.childElementCount) body.append(details);

  article.append(status, body);
  return article;
}

function renderRecords(records) {
  const stagedCards = document.createElement("div");
  const allowedRecords = [];
  for (const record of records) {
    // Render only named allowlist fields. Unknown source columns never reach this loop.
    const allowedRecord = Object.create(null);
    for (const field of DISPLAY_FIELDS) allowedRecord[field] = record[field];
    allowedRecords.push(allowedRecord);
    stagedCards.append(renderPprCard(allowedRecord));
  }
  dom.cards.replaceChildren(...stagedCards.children);

  const rimLines = buildRimSlideLines(allowedRecords);
  session.rimText = rimLines.join("\n");
  dom.rimLines.replaceChildren(...rimLines.map(line => textElement("p", "rim-line", line)));
  dom.rimSection.hidden = rimLines.length === 0;
  dom.copyRimButton.disabled = rimLines.length === 0;
  dom.copyRimStatus.textContent = "";

  const isEmpty = records.length === 0;
  dom.emptySnapshot.hidden = !isEmpty;
  dom.snapshotButton.disabled = isEmpty;
}

function leaveSnapshotMode() {
  document.body.classList.remove("is-snapshot-mode");
}

async function enterSnapshotMode() {
  if (!session.records.length) return;
  document.body.classList.add("is-snapshot-mode");
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // The clean page mode still works when the browser denies Fullscreen API access.
  }
}

function releasePprSession({ showImport = true } = {}) {
  session.loadEpoch += 1;
  leaveSnapshotMode();
  session.records = [];
  session.rimText = "";
  session.busy = false;
  dom.cards.replaceChildren();
  dom.rimLines.replaceChildren();
  dom.rimSection.hidden = true;
  dom.copyRimButton.disabled = true;
  dom.copyRimStatus.textContent = "";
  dom.emptySnapshot.hidden = true;
  dom.snapshotButton.disabled = true;
  dom.fileInput.value = "";
  dom.dropZone.classList.remove("is-drag-over", "is-busy");
  dom.dropZone.setAttribute("aria-busy", "false");
  dom.chooseButton.disabled = false;
  dom.importStatus.textContent = "";
  if (showImport) {
    dom.loadedView.hidden = true;
    dom.importView.hidden = false;
  }
}

function setBusy(busy) {
  session.busy = busy;
  dom.dropZone.classList.toggle("is-busy", busy);
  dom.dropZone.setAttribute("aria-busy", String(busy));
  dom.chooseButton.disabled = busy;
  dom.importStatus.textContent = busy ? "Reading the selected CSV locally…" : "";
}

function isCsvFile(file) {
  if (!file) return false;
  // Browser/OS MIME labels for CSV files are inconsistent; validate the file
  // name here and validate its actual structure in the parser.
  return /\.csv$/i.test(String(file.name || "").trim());
}

async function loadCsvFile(file) {
  if (session.busy) return;
  if (!isCsvFile(file)) {
    dom.importStatus.textContent = "Select one CSV file exported from the PPR SharePoint list.";
    dom.fileInput.value = "";
    return;
  }
  if (Number.isFinite(file.size) && file.size > MAX_CSV_BYTES) {
    dom.importStatus.textContent = "The selected CSV is too large for this local snapshot tool (20 MB maximum).";
    dom.fileInput.value = "";
    return;
  }

  releasePprSession({ showImport: true });
  const loadEpoch = session.loadEpoch;
  setBusy(true);
  let localCsvText = null;
  try {
    localCsvText = await file.text();
    if (loadEpoch !== session.loadEpoch) return;
    const snapshot = parsePprSnapshotCsv(localCsvText);
    if (loadEpoch !== session.loadEpoch) return;
    session.records = snapshot.records;
    renderRecords(session.records);
    dom.importView.hidden = true;
    dom.loadedView.hidden = false;
    dom.snapshotButton.focus();
  } catch (error) {
    if (loadEpoch !== session.loadEpoch) return;
    const message = error instanceof Error
      ? error.message
      : "The CSV could not be read. No PPR data was retained.";
    releasePprSession({ showImport: true });
    dom.importStatus.textContent = message;
  } finally {
    localCsvText = null;
    if (loadEpoch !== session.loadEpoch) return;
    session.busy = false;
    dom.fileInput.value = "";
    dom.dropZone.classList.remove("is-busy", "is-drag-over");
    dom.dropZone.setAttribute("aria-busy", "false");
    dom.chooseButton.disabled = false;
  }
}

function openFilePicker() {
  if (session.busy) return;
  dom.fileInput.value = "";
  dom.fileInput.click();
}

dom.chooseButton.addEventListener("click", event => {
  event.stopPropagation();
  openFilePicker();
});
dom.dropZone.addEventListener("click", event => {
  if (event.target === dom.chooseButton) return;
  openFilePicker();
});
dom.dropZone.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openFilePicker();
});
dom.fileInput.addEventListener("change", () => {
  const files = Array.from(dom.fileInput.files || []);
  if (files.length !== 1) {
    dom.importStatus.textContent = files.length > 1
      ? "Select one CSV at a time."
      : "";
    dom.fileInput.value = "";
    return;
  }
  void loadCsvFile(files[0]);
});

for (const eventName of ["dragenter", "dragover"]) {
  dom.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    if (!session.busy) dom.dropZone.classList.add("is-drag-over");
  });
}
dom.dropZone.addEventListener("dragleave", event => {
  event.preventDefault();
  if (event.relatedTarget instanceof Node && dom.dropZone.contains(event.relatedTarget)) return;
  dom.dropZone.classList.remove("is-drag-over");
});
dom.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  dom.dropZone.classList.remove("is-drag-over");
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length !== 1) {
    dom.importStatus.textContent = "Drop one CSV at a time.";
    return;
  }
  void loadCsvFile(files[0]);
});

dom.snapshotButton.addEventListener("click", () => void enterSnapshotMode());
dom.copyRimButton.addEventListener("click", async () => {
  if (!session.rimText) return;
  try {
    await navigator.clipboard.writeText(session.rimText);
    dom.copyRimStatus.textContent = "RIM lines copied.";
  } catch {
    dom.copyRimStatus.textContent = "Copy was unavailable. Select the RIM lines and copy them manually.";
  }
});
dom.loadAnotherButton.addEventListener("click", () => {
  releasePprSession();
  dom.chooseButton.focus();
});
dom.clearButton.addEventListener("click", () => {
  releasePprSession();
  dom.chooseButton.focus();
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) leaveSnapshotMode();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") leaveSnapshotMode();
});
window.addEventListener("pagehide", () => releasePprSession({ showImport: false }));
window.addEventListener("beforeunload", () => releasePprSession({ showImport: false }));
window.addEventListener("pageshow", event => {
  if (event.persisted) releasePprSession({ showImport: true });
});

releasePprSession({ showImport: true });
