import test from "node:test";
import assert from "node:assert/strict";

const HEADERS = [
  "Email Status",
  "Julian",
  "Sequence",
  "Callsign",
  "Aircraft Type",
  "Request Type",
  "Origin",
  "Destination",
  "Arrival Date (L)",
  "Arrival Time (L)",
  "Arrival Time (z)",
  "Departure Date (L)",
  "Departure Time (L)",
  "Departure Time (z)",
  "Acft Homestation",
  "Tail/Reg Number(s)",
  "VIP Code",
  "Fuel:",
  "Trans:",
  "Pax:",
  "Special Requirements:",
  "Explosives Declared",
  "Explosive Details",
  "Other HAZMAT Details",
  "Notes:",
  "Requester Email",
  "SharePoint ID",
  "Created By",
];

const SELECTORS = [
  "#importView",
  "#loadedView",
  "#csvDropZone",
  "#chooseCsvButton",
  "#pprCsvInput",
  "#importStatus",
  "#copyMattermostButton",
  "#copyMattermostStatus",
  "#snapshotModeButton",
  "#loadAnotherButton",
  "#clearPprButton",
  "#pprCards",
  "#emptySnapshot",
  "#rimSection",
  "#rimLines",
  "#copyRimLinesButton",
  "#copyRimStatus",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function syntheticCsv(overrides = {}) {
  const values = {
    "Email Status": "Approved - Email Sent",
    Julian: "255",
    Sequence: "001",
    Callsign: "TEST123",
    "Aircraft Type": "C17",
    "Request Type": "ARRIVAL",
    Origin: "KAAA",
    Destination: "KBBB",
    "Arrival Date (L)": "09/12/2026",
    "Arrival Time (L)": "8:15 AM",
    "Arrival Time (z)": "1315Z",
    "Departure Date (L)": "09/12/2026",
    "Departure Time (L)": "10:30 AM",
    "Departure Time (z)": "1530Z",
    "Acft Homestation": "KAAA",
    "Tail/Reg Number(s)": "00-0000",
    "VIP Code": "TEST",
    "Fuel:": "SYNTHETIC FUEL",
    "Trans:": "TEST TRANSPORT",
    "Pax:": "12",
    "Special Requirements:": "SYNTHETIC SUPPORT",
    "Explosives Declared": "False",
    "Explosive Details": "",
    "Other HAZMAT Details": "",
    "Notes:": "Synthetic fixture only",
    "Requester Email": "private.person@example.test",
    "SharePoint ID": "SP-SECRET-42",
    "Created By": "Private Requester",
    ...overrides,
  };
  return [HEADERS.map(csvCell).join(","), HEADERS.map((header) => csvCell(values[header])).join(",")].join("\r\n");
}

function syntheticCsvRows(rows) {
  const header = HEADERS.map(csvCell).join(",");
  const dataRows = rows.map((overrides) => syntheticCsv(overrides).slice(header.length + 2));
  return [header, ...dataRows].join("\r\n");
}

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...properties,
    };
    for (const listener of this.#listeners.get(type) ?? []) listener.call(this, event);
    return event;
  }
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
  }

  #tokens() {
    return new Set(String(this.owner.className || "").split(/\s+/).filter(Boolean));
  }

  #write(tokens) {
    this.owner.className = [...tokens].join(" ");
  }

  add(...names) {
    const tokens = this.#tokens();
    for (const name of names) tokens.add(name);
    this.#write(tokens);
  }

  remove(...names) {
    const tokens = this.#tokens();
    for (const name of names) tokens.delete(name);
    this.#write(tokens);
  }

  toggle(name, force) {
    const tokens = this.#tokens();
    const shouldAdd = force === undefined ? !tokens.has(name) : Boolean(force);
    if (shouldAdd) tokens.add(name);
    else tokens.delete(name);
    this.#write(tokens);
    return shouldAdd;
  }

  contains(name) {
    return this.#tokens().has(name);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName = "div") {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.files = [];
    this.focused = false;
    this._textContent = "";
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.replaceChildren();
  }

  get childElementCount() {
    return this.children.length;
  }

  append(...children) {
    for (const child of children) {
      if (!(child instanceof FakeElement)) throw new TypeError("Fake DOM accepts elements only");
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    if (children.length) this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.dispatch("click");
  }
}

class FakeDocument extends FakeEventTarget {
  constructor(privacyHits) {
    super();
    this.body = new FakeElement("body");
    this.documentElement = new FakeElement("html");
    this.fullscreenElement = null;
    this.elements = new Map(SELECTORS.map((selector) => [selector, new FakeElement()]));
    this.elements.get("#loadedView").hidden = true;
    this.elements.get("#emptySnapshot").hidden = true;
    for (const element of this.elements.values()) this.body.append(element);
    Object.defineProperty(this, "cookie", {
      configurable: true,
      get() {
        privacyHits.push("document.cookie:get");
        return "";
      },
      set() {
        privacyHits.push("document.cookie:set");
      },
    });
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

class FakeWindow extends FakeEventTarget {}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function elementsWithClass(element, className) {
  return [element, ...descendants(element)].filter((candidate) => candidate.classList.contains(className));
}

let moduleInstance = 0;

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function withRuntime(run) {
  const privacyHits = [];
  const clipboardWrites = [];
  const document = new FakeDocument(privacyHits);
  const window = new FakeWindow();
  const savedDescriptors = new Map();

  function install(name, descriptor) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
  }

  function called(label) {
    return new Proxy(function forbiddenApi() {}, {
      apply() {
        privacyHits.push(`${label}:call`);
        return undefined;
      },
      construct() {
        privacyHits.push(`${label}:construct`);
        return Object.create(null);
      },
    });
  }

  function sensitiveGlobal(name) {
    install(name, {
      get() {
        privacyHits.push(`${name}:get`);
        return new Proxy(Object.create(null), {
          get(_target, property) {
            privacyHits.push(`${name}.${String(property)}:get`);
            return called(`${name}.${String(property)}`);
          },
          set(_target, property) {
            privacyHits.push(`${name}.${String(property)}:set`);
            return true;
          },
        });
      },
    });
  }

  install("document", { value: document, writable: true });
  install("window", { value: window, writable: true });
  install("Node", { value: FakeElement, writable: true });
  for (const name of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "BroadcastChannel",
    "Worker",
    "SharedWorker",
    "FileSystemFileHandle",
    "showOpenFilePicker",
    "showSaveFilePicker",
  ]) install(name, { value: called(name), writable: true });
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) sensitiveGlobal(name);

  const sensitiveNavigatorProperties = new Set(["sendBeacon", "serviceWorker", "storage"]);
  const clipboard = Object.freeze({
    async writeText(value) {
      clipboardWrites.push(String(value));
    },
  });
  install("navigator", {
    value: new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === "clipboard") return clipboard;
        if (sensitiveNavigatorProperties.has(property)) {
          privacyHits.push(`navigator.${String(property)}:get`);
          return called(`navigator.${String(property)}`);
        }
        return undefined;
      },
    }),
    writable: true,
  });

  const originalConsole = globalThis.console;
  install("console", {
    value: new Proxy(originalConsole, {
      get(target, property, receiver) {
        if (["log", "info", "warn", "error", "debug"].includes(property)) {
          return (..._args) => privacyHits.push(`console.${String(property)}:call`);
        }
        return Reflect.get(target, property, receiver);
      },
    }),
    writable: true,
  });

  try {
    moduleInstance += 1;
    await import(new URL(`../ppr-snapshot.js?privacy-runtime=${moduleInstance}`, import.meta.url).href);
    await run({ document, window, elements: document.elements, privacyHits, clipboardWrites });
  } finally {
    for (const [name, descriptor] of [...savedDescriptors.entries()].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("runtime import renders only allowed synthetic data and CLEAR releases the session", async () => {
  await withRuntime(async ({ elements, privacyHits, clipboardWrites }) => {
    const csv = syntheticCsv({
      "Notes:": "Synthetic arrival estimated. Email private.notes@example.test or call (555) 123-4567.",
      "Explosives Declared": "Yes",
      "Explosive Details": "SYNTHETIC HAZMAT",
    });
    const fileInput = elements.get("#pprCsvInput");
    fileInput.value = "C:\\fakepath\\synthetic-ppr.csv";
    fileInput.files = [{
      name: "synthetic-ppr.csv",
      type: "application/octet-stream",
      size: Buffer.byteLength(csv),
      text: async () => csv,
    }];

    fileInput.dispatch("change");
    await settle();

    const rendered = elements.get("#pprCards").textContent;
    assert.match(rendered, /TEST123/);
    assert.match(rendered, /TEST123.*C17.*INBOUND ONLY/s);
    assert.match(rendered, /KAAA.*KMEM/s);
    assert.match(rendered, /🟢\s*APPROVED\s*·\s*PPR 255-001/u);
    assert.match(rendered, /ARR:\s*12 SEP\s*·\s*0815L\s*\/\s*1315Z\s*ESTIMATED/i);
    assert.match(rendered, /DEP:\s*12 SEP\s*·\s*1030L\s*\/\s*1530Z/i);
    assert.match(rendered, /HOME:\s*KAAA/i);
    assert.match(rendered, /TAIL:\s*00-0000/i);
    assert.match(rendered, /VIP:\s*TEST/i);
    assert.match(rendered, /FUEL:\s*SYNTHETIC FUEL/i);
    assert.match(rendered, /TRANS:\s*TEST TRANSPORT/i);
    assert.match(rendered, /PAX:\s*12/i);
    assert.match(rendered, /SPECIAL:\s*SYNTHETIC SUPPORT/i);
    assert.match(rendered, /HAZMAT:.*SYNTHETIC HAZMAT/i);
    assert.doesNotMatch(rendered, /private\.person@example\.test/i);
    assert.doesNotMatch(rendered, /private\.notes@example\.test/i);
    assert.doesNotMatch(rendered, /\(555\) 123-4567/);
    assert.doesNotMatch(rendered, /SP-SECRET-42/i);
    assert.doesNotMatch(rendered, /Private Requester/i);
    assert.doesNotMatch(rendered, /Requester Email/i);
    assert.match(rendered, /\[EMAIL REDACTED\]/);
    assert.match(rendered, /\[PHONE REDACTED\]/);
    assert.equal(elements.get("#pprCsvInput").value, "");
    assert.equal(elements.get("#importView").hidden, true);
    assert.equal(elements.get("#loadedView").hidden, false);
    assert.deepEqual(clipboardWrites, []);
    assert.deepEqual(privacyHits, []);

    elements.get("#copyMattermostButton").click();
    await settle();
    assert.equal(clipboardWrites.length, 1);
    assert.match(clipboardWrites[0], /^🟢 APPROVED · PPR 255-001/u);
    assert.match(clipboardWrites[0], /TEST123 · C17 · INBOUND ONLY/);
    assert.match(clipboardWrites[0], /KAAA → KMEM/);
    assert.doesNotMatch(clipboardWrites[0], /private\.person|SP-SECRET|Private Requester/i);
    assert.match(elements.get("#copyMattermostStatus").textContent, /copy ready/i);

    elements.get("#clearPprButton").click();
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#rimLines").childElementCount, 0);
    assert.equal(elements.get("#copyRimLinesButton").disabled, true);
    assert.equal(elements.get("#copyMattermostButton").disabled, true);
    assert.equal(elements.get("#pprCards").textContent, "");
    assert.equal(elements.get("#rimLines").textContent, "");
    assert.equal(elements.get("#copyRimStatus").textContent, "");
    assert.equal(elements.get("#copyMattermostStatus").textContent, "");
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.equal(elements.get("#importView").hidden, false);
    assert.equal(elements.get("#snapshotModeButton").disabled, true);
    assert.equal(elements.get("#pprCsvInput").value, "");
    assert.equal(clipboardWrites.length, 1);
    assert.deepEqual(privacyHits, []);
  });
});

test("an unscoped estimated note renders and copies one neutral timing-block indicator", async () => {
  await withRuntime(async ({ elements, privacyHits, clipboardWrites }) => {
    const csv = syntheticCsv({ "Notes:": "Timing is ESTIMATED; awaiting confirmation" });
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-neutral-estimate.csv",
      type: "text/csv",
      size: Buffer.byteLength(csv),
      text: async () => csv,
    }];

    fileInput.dispatch("change");
    await settle();

    const renderedEntry = elementsWithClass(elements.get("#pprCards"), "ppr-entry")[0];
    const timingLines = elementsWithClass(renderedEntry, "timing-line");
    const neutralBadges = elementsWithClass(renderedEntry, "neutral-estimate");
    assert.equal(neutralBadges.length, 1);
    assert.equal(neutralBadges[0].textContent, "ESTIMATED");
    assert.ok(timingLines.every((line) => !/ESTIMATED/.test(line.textContent)));

    elements.get("#copyMattermostButton").click();
    await settle();
    assert.equal(clipboardWrites.length, 1);
    assert.match(clipboardWrites[0], /DEP: 12 SEP · 1030L \/ 1530Z\nESTIMATED\nHOME:/);
    assert.equal(clipboardWrites[0].split("\n").filter((line) => line === "ESTIMATED").length, 1);
    assert.deepEqual(privacyHits, []);
  });
});

test("an approved record with no recognized operation still renders a RIM line", async () => {
  await withRuntime(async ({ elements, privacyHits }) => {
    const csv = syntheticCsv({
      Callsign: "TESTNOOP",
      "Request Type": "unrecognized synthetic operation",
      Origin: "KAAA",
      Destination: "KMEM",
    });
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-missing-operation.csv",
      type: "text/csv",
      size: Buffer.byteLength(csv),
      text: async () => csv,
    }];

    fileInput.dispatch("change");
    await settle();

    const rimLines = elementsWithClass(elements.get("#rimLines"), "rim-line");
    assert.equal(rimLines.length, 1);
    assert.equal(
      rimLines[0].textContent,
      "PPR 255-001 · TESTNOOP · ARR 12 SEP 0815L / 1315Z · DEP 12 SEP 1030L / 1530Z",
    );
    assert.equal(elements.get("#rimSection").hidden, false);
    assert.equal(elements.get("#copyRimLinesButton").disabled, false);
    assert.deepEqual(privacyHits, []);
  });
});

test("cancelled entries stay lean and RIM copy contains only chronologically sorted approved lines", async () => {
  await withRuntime(async ({ elements, privacyHits, clipboardWrites }) => {
    const csv = syntheticCsvRows([
      {
        "Email Status": "Approved - Email Sent",
        Sequence: "002",
        Callsign: "TEST123",
        "Request Type": "ARRIVAL",
        Origin: "KAAA",
        Destination: "KMEM",
        "Arrival Date (L)": "09/12/2026",
        "Arrival Time (L)": "8:15 AM",
        "Arrival Time (z)": "1315Z",
        "Departure Date (L)": "",
        "Departure Time (L)": "",
        "Departure Time (z)": "",
        "Fuel:": "INBOUND SYNTHETIC FUEL",
      },
      {
        "Email Status": "Approved - Email Sent",
        Sequence: "001",
        Callsign: "TEST456",
        "Request Type": "DEPARTURE",
        Origin: "KMEM",
        Destination: "KBBB",
        "Arrival Date (L)": "09/11/2026",
        "Arrival Time (L)": "7:00 AM",
        "Arrival Time (z)": "1200Z",
        "Departure Date (L)": "09/11/2026",
        "Departure Time (L)": "9:30 AM",
        "Departure Time (z)": "1430Z",
        "Fuel:": "OUTBOUND SYNTHETIC FUEL",
      },
      {
        "Email Status": "Cancelled / Denied",
        Sequence: "003",
        Callsign: "TEST789",
        "Request Type": "ARRIVAL",
        Origin: "KCCC",
        Destination: "KMEM",
        "Arrival Date (L)": "09/10/2026",
        "Arrival Time (L)": "6:45 AM",
        "Arrival Time (z)": "1145Z",
        "Departure Date (L)": "09/10/2026",
        "Departure Time (L)": "8:00 AM",
        "Departure Time (z)": "1300Z",
        "Acft Homestation": "KZZZ",
        "Tail/Reg Number(s)": "00-9999",
        "VIP Code": "X",
        "Fuel:": "CANCELLED SECRET FUEL",
        "Trans:": "CANCELLED SECRET TRANS",
        "Pax:": "99",
        "Special Requirements:": "CANCELLED SECRET SPECIAL",
        "Explosives Declared": "Yes",
        "Explosive Details": "CANCELLED SECRET HAZMAT",
        "Notes:": "Synthetic mission cancelled.",
      },
      {
        "Email Status": "In Coordination",
        Sequence: "004",
        Callsign: "TEST000",
        Origin: "KDDD",
        Destination: "KMEM",
        "Notes:": "This coordination row must not render.",
      },
    ]);
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-rim-scenarios.csv",
      type: "text/csv",
      size: Buffer.byteLength(csv),
      text: async () => csv,
    }];

    fileInput.dispatch("change");
    await settle();

    const entries = elementsWithClass(elements.get("#pprCards"), "ppr-entry");
    assert.equal(entries.length, 3);
    const cancelled = entries.find((entry) => entry.classList.contains("is-cancelled"));
    assert.ok(cancelled);
    assert.match(cancelled.textContent, /🔴\s*CANCELLED\s*·\s*PPR 255-003/u);
    assert.match(cancelled.textContent, /TEST789.*C17.*INBOUND ONLY/s);
    assert.match(cancelled.textContent, /KCCC.*KMEM/s);
    assert.match(cancelled.textContent, /ARR:\s*10 SEP\s*·\s*0645L\s*\/\s*1145Z/i);
    assert.match(cancelled.textContent, /DEP:\s*10 SEP\s*·\s*0800L\s*\/\s*1300Z/i);
    assert.match(cancelled.textContent, /NOTES:\s*Synthetic mission cancelled\./i);
    for (const suppressed of [
      "HOME:", "HOME STATION:", "TAIL:", "VIP:", "FUEL:", "TRANS:", "PAX:",
      "SPECIAL:", "HAZMAT:", "KZZZ", "00-9999", "CANCELLED SECRET",
    ]) assert.doesNotMatch(cancelled.textContent, new RegExp(suppressed, "i"));

    const approvedText = entries
      .filter((entry) => entry.classList.contains("is-approved"))
      .map((entry) => entry.textContent)
      .join("\n");
    assert.match(approvedText, /🟢\s*APPROVED/u);
    assert.match(approvedText, /INBOUND SYNTHETIC FUEL/);
    assert.match(approvedText, /OUTBOUND SYNTHETIC FUEL/);
    assert.doesNotMatch(elements.get("#pprCards").textContent, /TEST000|coordination row/i);

    const expectedRimLines = [
      "PPR 255-001 · TEST456 · OUTBOUND ONLY · KMEM → KBBB · ARR 11 SEP 0700L / 1200Z · DEP 11 SEP 0930L / 1430Z",
      "PPR 255-002 · TEST123 · INBOUND ONLY · KAAA → KMEM · ARR 12 SEP 0815L / 1315Z",
    ];
    const rimLineElements = elementsWithClass(elements.get("#rimLines"), "rim-line");
    assert.deepEqual(rimLineElements.map((line) => line.textContent), expectedRimLines);
    const renderedRim = rimLineElements.map((line) => line.textContent).join("\n");
    assert.doesNotMatch(renderedRim, /TEST789|TEST000|CANCELLED|COORDINATION/i);
    assert.doesNotMatch(renderedRim, /HOME|TAIL|VIP|FUEL|TRANS|PAX|SPECIAL|HAZMAT|NOTES|SYNTHETIC FUEL/i);
    assert.deepEqual(clipboardWrites, []);

    elements.get("#copyMattermostButton").click();
    await settle();
    assert.equal(clipboardWrites.length, 1);
    assert.match(clipboardWrites[0], /^🟢 APPROVED · PPR 255-001/u);
    assert.match(clipboardWrites[0], /\n\n🟢 APPROVED · PPR 255-002/u);
    assert.match(clipboardWrites[0], /\n\n🔴 CANCELLED · PPR 255-003/u);
    assert.doesNotMatch(clipboardWrites[0], /CANCELLED SECRET|TEST000|coordination row/i);
    assert.match(elements.get("#copyMattermostStatus").textContent, /copy ready/i);

    elements.get("#copyRimLinesButton").click();
    await settle();
    assert.deepEqual(clipboardWrites, [clipboardWrites[0], expectedRimLines.join("\n")]);
    assert.match(elements.get("#copyRimStatus").textContent, /copied/i);
    assert.doesNotMatch(clipboardWrites[1], /RIM SLIDE LINES/);
    assert.deepEqual(privacyHits, []);
  });
});

test("page lifecycle invalidates an in-flight local read and a fresh load starts empty", async () => {
  let resolveText;
  const deferredText = new Promise((resolve) => { resolveText = resolve; });

  await withRuntime(async ({ window, elements, privacyHits }) => {
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-deferred.csv",
      type: "text/csv",
      size: 1024,
      text: () => deferredText,
    }];
    fileInput.dispatch("change");
    assert.match(elements.get("#importStatus").textContent, /Reading the selected CSV locally/);

    window.dispatch("pagehide");
    resolveText(syntheticCsv());
    await settle();

    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.equal(elements.get("#snapshotModeButton").disabled, true);

    window.dispatch("pageshow", { persisted: true });
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#rimLines").childElementCount, 0);
    assert.equal(elements.get("#importView").hidden, false);
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.deepEqual(privacyHits, []);
  });

  await withRuntime(async ({ elements, privacyHits }) => {
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#importView").hidden, false);
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.equal(elements.get("#pprCsvInput").value, "");
    assert.deepEqual(privacyHits, []);
  });
});

test("oversized and malformed inputs are rejected without retaining or echoing data", async () => {
  await withRuntime(async ({ elements, privacyHits }) => {
    let textCalls = 0;
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-oversized.csv",
      type: "text/csv",
      size: (20 * 1024 * 1024) + 1,
      text: async () => {
        textCalls += 1;
        return syntheticCsv();
      },
    }];
    fileInput.dispatch("change");
    await settle();

    assert.equal(textCalls, 0);
    assert.match(elements.get("#importStatus").textContent, /20 MB maximum/);
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#pprCsvInput").value, "");
    assert.deepEqual(privacyHits, []);
  });

  await withRuntime(async ({ elements, privacyHits }) => {
    const secret = "PRIVATE-PAYLOAD-MUST-NOT-ECHO";
    const malformed = `${HEADERS.join(",")}\r\nApproved - Email Sent,255,001,"${secret}`;
    const fileInput = elements.get("#pprCsvInput");
    fileInput.files = [{
      name: "synthetic-malformed.csv",
      type: "text/csv",
      size: Buffer.byteLength(malformed),
      text: async () => malformed,
    }];
    fileInput.dispatch("change");
    await settle();

    assert.match(elements.get("#importStatus").textContent, /unterminated quoted field/i);
    assert.doesNotMatch(elements.get("#importStatus").textContent, new RegExp(secret));
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.equal(elements.get("#pprCsvInput").value, "");
    assert.deepEqual(privacyHits, []);
  });
});
