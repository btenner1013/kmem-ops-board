import {
  FIELD_PATHS,
  buildFplMessage,
  createBlankFlightPlan,
  getFieldValue,
  hasWorkingData,
  setFieldValue,
  validateFlightPlan,
  validateRoute
} from "./flight-plan-core.js";
import { extractDd1801Pdf } from "./flight-plan-pdf.js";

const FIELD_LABELS = {
  "item7.aircraftIdentification": "Item 7 — Aircraft identification",
  "item8.flightRules": "Item 8 — Flight rules",
  "item8.typeOfFlight": "Item 8 — Type of flight",
  "item9.number": "Item 9 — Number",
  "item9.aircraftType": "Item 9 — Type of aircraft",
  "item9.wakeCategory": "Item 9 — Wake turbulence category",
  "item10.equipment": "Item 10a — Equipment",
  "item10.surveillance": "Item 10b — Surveillance",
  "item13.departure": "Item 13 — Departure aerodrome",
  "item13.time": "Item 13 — Time",
  "item15.speed": "Item 15 — Cruising speed",
  "item15.level": "Item 15 — Level",
  "item15.route": "Item 15 — Route",
  "item16.destination": "Item 16 — Destination",
  "item16.totalEet": "Item 16 — Total EET",
  "item16.alternate": "Item 16 — Alternate",
  "item16.secondAlternate": "Item 16 — Second alternate",
  "item18.otherInformation": "Item 18 — Other information",
  "item19.endurance": "Item 19 — Endurance / fuel",
  "item19.personsOnBoard": "Item 19 — Persons on board",
  "item19.emergencyRadio.frequency1215": "Item 19 — Emergency radio 121.5 MHz",
  "item19.emergencyRadio.frequency243": "Item 19 — Emergency radio 243.0 MHz",
  "item19.emergencyRadio.frequency500": "Item 19 — Emergency radio 500 kHz",
  "item19.emergencyRadio.frequency8364": "Item 19 — Emergency radio 8364 kHz",
  "item19.survivalEquipment.polar": "Item 19 — Type of equipment: Polar",
  "item19.survivalEquipment.desert": "Item 19 — Type of equipment: Desert",
  "item19.survivalEquipment.maritime": "Item 19 — Type of equipment: Maritime",
  "item19.survivalEquipment.jungle": "Item 19 — Type of equipment: Jungle",
  "item19.survivalEquipment.global": "Item 19 — Type of equipment: Global",
  "item19.lifeJackets.carried": "Item 19 — Jackets",
  "item19.lifeJackets.lights": "Item 19 — Life-jacket light",
  "item19.lifeJackets.fluorescein": "Item 19 — Life-jacket fluorescein",
  "item19.radioFrequencies": "Item 19 — Radio frequency",
  "item19.dinghies.carried": "Item 19 — Dinghies",
  "item19.dinghies.cover": "Item 19 — Dinghy cover",
  "item19.dinghies.number": "Item 19 — Dinghy number",
  "item19.dinghies.capacity": "Item 19 — Dinghy capacity",
  "item19.dinghies.color": "Item 19 — Dinghy color",
  "item19.remarks": "Item 19 — RMK / remarks",
  "item19.aircraftSerial": "Item 19 — Aircraft serial number",
  "item19.aircraftType": "Item 19 — Aircraft type"
};

const dom = {
  landingScreen: document.querySelector("#landingScreen"),
  landingUploadButton: document.querySelector("#landingUploadButton"),
  landingManualButton: document.querySelector("#landingManualButton"),
  uploadScreen: document.querySelector("#uploadScreen"),
  uploadBackButton: document.querySelector("#uploadBackButton"),
  choosePdfButton: document.querySelector("#choosePdfButton"),
  retryUploadButton: document.querySelector("#retryUploadButton"),
  failureManualButton: document.querySelector("#failureManualButton"),
  pdfFileInput: document.querySelector("#pdfFileInput"),
  uploadProgress: document.querySelector("#uploadProgress"),
  uploadProgressLabel: document.querySelector("#uploadProgressLabel"),
  uploadStatus: document.querySelector("#uploadStatus"),
  uploadFailureActions: document.querySelector("#uploadFailureActions"),
  workspace: document.querySelector("#workspace"),
  workspaceTitle: document.querySelector("#workspaceTitle"),
  modeDescription: document.querySelector("#modeDescription"),
  workspaceUploadButton: document.querySelector("#workspaceUploadButton"),
  workspaceManualButton: document.querySelector("#workspaceManualButton"),
  workspaceFileStatus: document.querySelector("#workspaceFileStatus"),
  importReview: document.querySelector("#importReview"),
  importSourceBadge: document.querySelector("#importSourceBadge"),
  importSummary: document.querySelector("#importSummary"),
  importFlags: document.querySelector("#importFlags"),
  form: document.querySelector("#flightPlanForm"),
  firstField: document.querySelector("#aircraftIdentification"),
  route: document.querySelector("#route"),
  validateRouteButton: document.querySelector("#validateRouteButton"),
  undoRouteButton: document.querySelector("#undoRouteButton"),
  routeStatus: document.querySelector("#routeStatus"),
  rejectionResponse: document.querySelector("#rejectionResponse"),
  structuralStatus: document.querySelector("#structuralStatus"),
  structuralStatusBadge: document.querySelector("#structuralStatusBadge"),
  structuralStatusDetails: document.querySelector("#structuralStatusDetails"),
  generateButton: document.querySelector("#generateButton"),
  resetButton: document.querySelector("#resetButton"),
  outputPanel: document.querySelector("#outputPanel"),
  outputFreshness: document.querySelector("#outputFreshness"),
  fplOutput: document.querySelector("#fplOutput"),
  copyButton: document.querySelector("#copyButton"),
  editButton: document.querySelector("#editButton"),
  outputResetButton: document.querySelector("#outputResetButton"),
  copyStatus: document.querySelector("#copyStatus")
};

const state = {
  mode: null,
  plan: createBlankFlightPlan(),
  importedFileName: "",
  importResult: null,
  routeUndoSnapshot: null,
  generatedFpl: "",
  generatedPlanSnapshot: "",
  uploadBusy: false
};

function fieldLabel(path) {
  return FIELD_LABELS[path] || path;
}

function hasCurrentData() {
  return hasWorkingData(state.plan)
    || Boolean(dom.rejectionResponse.value.trim())
    || Boolean(state.generatedFpl)
    || Boolean(state.importResult);
}

function confirmDestructive(message) {
  return !hasCurrentData() || window.confirm(message);
}

function blankWorkingState() {
  state.plan = createBlankFlightPlan();
  state.importedFileName = "";
  state.importResult = null;
  state.routeUndoSnapshot = null;
  state.generatedFpl = "";
  state.generatedPlanSnapshot = "";
  dom.rejectionResponse.value = "";
  dom.routeStatus.textContent = "";
  dom.routeStatus.className = "route-status";
  dom.undoRouteButton.disabled = true;
  dom.structuralStatus.hidden = true;
  dom.structuralStatusBadge.textContent = "";
  dom.structuralStatusBadge.className = "status-badge";
  dom.structuralStatusDetails.replaceChildren();
  dom.outputPanel.hidden = true;
  dom.fplOutput.textContent = "";
  dom.outputFreshness.textContent = "CURRENT";
  dom.outputFreshness.classList.remove("stale");
  dom.copyButton.disabled = true;
  dom.copyStatus.textContent = "";
  dom.workspaceFileStatus.textContent = "";
  dom.workspaceTitle.textContent = "";
  dom.modeDescription.textContent = "";
  dom.importReview.hidden = true;
  dom.importSourceBadge.textContent = "";
  dom.importSummary.replaceChildren();
  dom.importFlags.replaceChildren();
  dom.pdfFileInput.value = "";
  dom.uploadProgress.hidden = true;
  dom.uploadProgressLabel.textContent = "";
  dom.uploadStatus.textContent = "";
  dom.uploadStatus.className = "upload-status";
  dom.uploadFailureActions.hidden = true;
  state.uploadBusy = false;
  dom.choosePdfButton.disabled = false;
  dom.retryUploadButton.disabled = false;
  dom.failureManualButton.disabled = false;
  dom.uploadBackButton.disabled = false;
  renderPlan();
}

function showOnly(screen) {
  dom.landingScreen.hidden = screen !== "landing";
  dom.uploadScreen.hidden = screen !== "upload";
  dom.workspace.hidden = screen !== "workspace";
}

function showLanding() {
  state.mode = null;
  showOnly("landing");
  dom.landingUploadButton.focus();
}

function showUploadScreen({ openPicker = false } = {}) {
  showOnly("upload");
  dom.uploadStatus.textContent = "";
  dom.uploadStatus.className = "upload-status";
  dom.uploadFailureActions.hidden = true;
  dom.uploadProgress.hidden = true;
  if (openPicker) {
    window.setTimeout(() => dom.pdfFileInput.click(), 0);
  } else {
    dom.choosePdfButton.focus();
  }
}

function startManualEntry() {
  const message = "Start a brand-new blank Manual Entry? This clears the current imported or entered flight-plan data, generated FPL, route undo, and rejection response.";
  if (!confirmDestructive(message)) return;

  blankWorkingState();
  state.mode = "manual";
  dom.workspaceTitle.textContent = "MANUAL DD1801 ENTRY";
  dom.modeDescription.textContent = "Brand-new manual plan — every operational field started blank.";
  dom.importReview.hidden = true;
  showOnly("workspace");
  dom.firstField.focus();
}

function requestPdfSelection() {
  if (state.uploadBusy) return;
  dom.workspaceFileStatus.textContent = "";
  dom.pdfFileInput.value = "";
  dom.pdfFileInput.click();
}

function beginUploadWorkflow() {
  if (hasCurrentData()) {
    requestPdfSelection();
    return;
  }

  state.mode = "upload";
  showUploadScreen({ openPicker: true });
}

function renderPlan() {
  for (const control of dom.form.querySelectorAll("[data-path]")) {
    const value = getFieldValue(state.plan, control.dataset.path);
    if (control.type === "checkbox") {
      control.checked = value === true;
    } else {
      control.value = value == null ? "" : String(value);
    }
  }
}

function readControl(control) {
  return control.type === "checkbox" ? control.checked : control.value;
}

function normalizedPlanSnapshot() {
  return JSON.stringify(state.plan);
}

function updateOutputFreshness() {
  if (!state.generatedFpl) {
    dom.copyButton.disabled = true;
    return;
  }
  const isStale = normalizedPlanSnapshot() !== state.generatedPlanSnapshot;
  dom.outputFreshness.textContent = isStale ? "REGENERATE AFTER EDITS" : "CURRENT";
  dom.outputFreshness.classList.toggle("stale", isStale);
  dom.copyButton.disabled = isStale;
}

function markPlanEdited() {
  dom.structuralStatus.hidden = true;
  updateOutputFreshness();
}

function writeControlToState(control) {
  setFieldValue(state.plan, control.dataset.path, readControl(control));
  markPlanEdited();
}

function setUploadBusy(isBusy, fileName = "") {
  state.uploadBusy = isBusy;
  dom.uploadProgress.hidden = !isBusy;
  dom.choosePdfButton.disabled = isBusy;
  dom.retryUploadButton.disabled = isBusy;
  dom.failureManualButton.disabled = isBusy;
  dom.uploadBackButton.disabled = isBusy;
  dom.uploadProgressLabel.textContent = fileName
    ? `Reading ${fileName}...`
    : "Reading electronic PDF...";
}

function isPdf(file) {
  return file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name));
}

async function handlePdfSelection(file) {
  if (!file) return;

  if (!isPdf(file)) {
    dom.pdfFileInput.value = "";
    if (!dom.workspace.hidden) {
      dom.workspaceFileStatus.textContent = "File not selected: choose an electronic PDF. The current working plan was preserved.";
      dom.workspaceUploadButton.focus();
    } else {
      showUploadScreen();
      showUploadFailure("Choose an electronic PDF file. Other file types are not supported.");
    }
    return;
  }

  if (hasCurrentData()) {
    const replace = window.confirm("Import this DD1801 and replace the current working plan? This clears all current fields, generated output, route undo, and rejection text.");
    if (!replace) {
      dom.pdfFileInput.value = "";
      dom.workspaceFileStatus.textContent = "Import canceled. The current working plan was preserved.";
      return;
    }
  }

  blankWorkingState();
  state.mode = "upload";
  showOnly("upload");
  dom.uploadStatus.textContent = "";
  dom.uploadStatus.className = "upload-status";
  dom.uploadFailureActions.hidden = true;
  setUploadBusy(true, file.name);

  try {
    const result = await extractDd1801Pdf(file);
    state.plan = result.data;
    state.importedFileName = file.name;
    state.importResult = result;
    state.mode = "upload";
    state.routeUndoSnapshot = null;
    renderPlan();
    renderImportReview(result);
    dom.workspaceTitle.textContent = "IMPORTED DD1801 REVIEW";
    dom.modeDescription.textContent = `${file.name} — extracted locally; all mapped fields remain editable.`;
    showOnly("workspace");
    dom.importReview.hidden = false;
    dom.importReview.focus?.();
    dom.workspace.scrollIntoView({ block: "start" });
  } catch (error) {
    showUploadFailure(error instanceof Error ? error.message : "Automatic extraction was unsuccessful.");
  } finally {
    setUploadBusy(false);
    dom.pdfFileInput.value = "";
  }
}

function showUploadFailure(message) {
  dom.uploadStatus.textContent = `Automatic extraction unsuccessful: ${message} No values were invented or added. Choose another electronic PDF or use Manual Entry.`;
  dom.uploadStatus.className = "upload-status is-error";
  dom.uploadFailureActions.hidden = false;
  dom.uploadStatus.focus?.();
}

function renderImportReview(result) {
  const sourceText = {
    acroform: "ACROFORM",
    text: "TEXT LAYER",
    "acroform+text": "ACROFORM + TEXT"
  }[result.source] || String(result.source || "ELECTRONIC PDF").toUpperCase();
  const pageText = Number.isFinite(result.pageCount)
    ? ` · ${result.pageCount} PAGE${result.pageCount === 1 ? "" : "S"}`
    : "";
  dom.importSourceBadge.textContent = `${sourceText}${pageText}`;

  const extracted = uniquePaths(result.extractedFields);
  const reliableBlank = uniquePaths(result.reliableBlankFields);
  const unreliable = uniquePaths(result.unreliableFields);
  const accountedFor = new Set([...extracted, ...reliableBlank, ...unreliable]);
  const notExtracted = FIELD_PATHS.filter(path => !accountedFor.has(path));

  dom.importSummary.replaceChildren();
  const table = document.createElement("table");
  table.className = "summary-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["Mapped field", "Extracted value"]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.append(th);
  }
  thead.append(headerRow);
  const tbody = document.createElement("tbody");

  if (extracted.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 2;
    cell.textContent = "No populated values were mapped. Review all flagged fields.";
    row.append(cell);
    tbody.append(row);
  } else {
    for (const path of extracted) {
      const row = document.createElement("tr");
      const fieldCell = document.createElement("td");
      const valueCell = document.createElement("td");
      fieldCell.textContent = fieldLabel(path);
      valueCell.className = "summary-value";
      valueCell.textContent = displayExtractedValue(getFieldValue(result.data, path));
      row.append(fieldCell, valueCell);
      tbody.append(row);
    }
  }
  table.append(thead, tbody);
  dom.importSummary.append(table);

  dom.importFlags.replaceChildren();
  appendFlagCard("LOCATED BUT BLANK", reliableBlank, "These fields were located in the electronic form and read as blank.");
  appendFlagCard("UNRELIABLE — REVIEW REQUIRED", unreliable, "The importer could not map these fields confidently.", true);
  appendFlagCard("NOT EXTRACTED", notExtracted, "No reliable value was extracted for these fields.", true);
  appendWarningCard(result.warnings);
}

function uniquePaths(value) {
  const order = new Map(FIELD_PATHS.map((path, index) => [path, index]));
  return [...new Set(Array.isArray(value) ? value.filter(path => typeof path === "string") : [])]
    .sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function displayExtractedValue(value) {
  if (typeof value === "boolean") return value ? "CHECKED" : "NOT CHECKED";
  if (value === null || value === undefined || value === "") return "[BLANK]";
  return String(value);
}

function appendFlagCard(title, paths, emptyText, warning = false) {
  if (!paths.length) return;
  const card = document.createElement("section");
  card.className = `flag-card${warning ? " warning" : ""}`;
  const heading = document.createElement("h4");
  heading.textContent = title;
  const list = document.createElement("ul");
  for (const path of paths) {
    const item = document.createElement("li");
    item.textContent = fieldLabel(path);
    list.append(item);
  }
  card.append(heading, list);
  if (!paths.length) {
    const copy = document.createElement("p");
    copy.textContent = emptyText;
    card.append(copy);
  }
  dom.importFlags.append(card);
}

function appendWarningCard(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  const card = document.createElement("section");
  card.className = "flag-card warning";
  const heading = document.createElement("h4");
  heading.textContent = "IMPORT WARNINGS";
  const list = document.createElement("ul");
  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = String(warning);
    list.append(item);
  }
  card.append(heading, list);
  dom.importFlags.append(card);
}

function handleRouteValidation() {
  const originalRoute = String(getFieldValue(state.plan, "item15.route") || "");
  const result = validateRoute(originalRoute);

  if (result.changed) {
    state.routeUndoSnapshot = originalRoute;
    dom.undoRouteButton.disabled = false;
    setFieldValue(state.plan, "item15.route", result.route);
    dom.route.value = result.route;
    markPlanEdited();
  }

  dom.undoRouteButton.disabled = state.routeUndoSnapshot === null;

  const messages = [];
  if (result.changed) {
    messages.push(`Inserted ${result.insertedCount} conservative DCT separator${result.insertedCount === 1 ? "" : "s"}.`);
  } else {
    messages.push("No confident DCT insertion was identified; the route was left unchanged.");
  }
  if (Array.isArray(result.warnings)) messages.push(...result.warnings);
  dom.routeStatus.textContent = messages.join(" ");
  dom.routeStatus.className = `route-status ${result.warnings?.length ? "is-warning" : "is-ok"}`;
}

function undoRouteValidation() {
  if (state.routeUndoSnapshot === null) return;
  const exactSnapshot = state.routeUndoSnapshot;
  state.routeUndoSnapshot = null;
  setFieldValue(state.plan, "item15.route", exactSnapshot);
  dom.route.value = exactSnapshot;
  dom.undoRouteButton.disabled = true;
  dom.routeStatus.textContent = "Restored the exact route text from immediately before the last modifying validation.";
  dom.routeStatus.className = "route-status is-ok";
  markPlanEdited();
  dom.route.focus();
}

function renderStructuralStatus(validation) {
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const status = errors.length
    ? "ERROR"
    : warnings.length
      ? "WARNING"
      : "LOCAL CHECKS PASSED";
  const tone = errors.length ? "error" : warnings.length ? "warning" : "passed";

  dom.structuralStatus.hidden = false;
  dom.structuralStatus.className = `structural-status is-${tone}`;
  dom.structuralStatusBadge.className = `status-badge ${tone}`;
  dom.structuralStatusBadge.textContent = status;
  dom.structuralStatusDetails.replaceChildren();

  if (!errors.length && !warnings.length) {
    const copy = document.createElement("p");
    copy.textContent = "Required fields and basic ICAO message structure passed local checks. This is not an airspace, RAD, IFPS, or EUROCONTROL validation.";
    dom.structuralStatusDetails.append(copy);
    return;
  }

  if (errors.length) appendStatusGroup("Correct before generation", errors);
  if (warnings.length) appendStatusGroup("Review recommended", warnings);
}

function appendStatusGroup(title, messages) {
  const group = document.createElement("div");
  group.className = "status-group";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.className = "status-list";
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = String(message);
    list.append(item);
  }
  group.append(heading, list);
  dom.structuralStatusDetails.append(group);
}

function generateFpl() {
  const validation = validateFlightPlan(state.plan);
  renderStructuralStatus(validation);

  if (validation.errors?.length) {
    dom.structuralStatus.scrollIntoView({ behavior: "smooth", block: "center" });
    dom.structuralStatus.focus?.();
    return;
  }

  const result = buildFplMessage(state.plan);
  renderStructuralStatus(result.validation || validation);
  if (!result.message) return;

  state.generatedFpl = result.message;
  state.generatedPlanSnapshot = normalizedPlanSnapshot();
  dom.fplOutput.textContent = result.message;
  dom.outputPanel.hidden = false;
  dom.copyStatus.textContent = "";
  updateOutputFreshness();
  dom.outputPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  dom.fplOutput.focus({ preventScroll: true });
}

async function copyFpl() {
  if (!state.generatedFpl) return;
  if (normalizedPlanSnapshot() !== state.generatedPlanSnapshot) {
    dom.copyStatus.textContent = "Regenerate the FPL after edits before copying.";
    updateOutputFreshness();
    return;
  }
  try {
    await navigator.clipboard.writeText(state.generatedFpl);
    dom.copyStatus.textContent = "Copied the exact generated FPL message.";
  } catch {
    const copyArea = document.createElement("textarea");
    copyArea.value = state.generatedFpl;
    copyArea.setAttribute("readonly", "");
    copyArea.className = "visually-hidden";
    document.body.append(copyArea);
    copyArea.select();
    const copied = document.execCommand("copy");
    copyArea.remove();
    dom.copyStatus.textContent = copied
      ? "Copied the exact generated FPL message."
      : "Copy was blocked by the browser. Select the generated message and copy it manually.";
  }
}

function editPlan() {
  dom.firstField.scrollIntoView({ behavior: "smooth", block: "center" });
  dom.firstField.focus({ preventScroll: true });
}

function resetPlan() {
  const message = "Clear this working flight plan? This removes Items 7–19, imported-file state, generated FPL, route undo, local validation messages, and the rejection response.";
  if (!confirmDestructive(message)) return;
  blankWorkingState();
  showLanding();
}

dom.form.addEventListener("input", event => {
  const control = event.target.closest("[data-path]");
  if (!control) return;
  writeControlToState(control);
});

dom.form.addEventListener("change", event => {
  const control = event.target.closest("[data-path]");
  if (!control) return;
  writeControlToState(control);
});

dom.landingUploadButton.addEventListener("click", beginUploadWorkflow);
dom.landingManualButton.addEventListener("click", startManualEntry);
dom.choosePdfButton.addEventListener("click", requestPdfSelection);
dom.retryUploadButton.addEventListener("click", requestPdfSelection);
dom.workspaceUploadButton.addEventListener("click", requestPdfSelection);
dom.workspaceManualButton.addEventListener("click", startManualEntry);
dom.failureManualButton.addEventListener("click", startManualEntry);
dom.uploadBackButton.addEventListener("click", () => {
  if (state.uploadBusy) return;
  blankWorkingState();
  showLanding();
});
dom.pdfFileInput.addEventListener("change", () => handlePdfSelection(dom.pdfFileInput.files?.[0]));
dom.validateRouteButton.addEventListener("click", handleRouteValidation);
dom.undoRouteButton.addEventListener("click", undoRouteValidation);
dom.generateButton.addEventListener("click", generateFpl);
dom.copyButton.addEventListener("click", copyFpl);
dom.editButton.addEventListener("click", editPlan);
dom.resetButton.addEventListener("click", resetPlan);
dom.outputResetButton.addEventListener("click", resetPlan);
window.addEventListener("beforeunload", event => {
  if (!hasCurrentData()) return;
  event.preventDefault();
  event.returnValue = "";
});

renderPlan();
dom.copyButton.disabled = true;
showOnly("landing");
