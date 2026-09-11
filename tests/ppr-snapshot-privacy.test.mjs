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
  "#snapshotModeButton",
  "#loadAnotherButton",
  "#clearPprButton",
  "#pprCards",
  "#emptySnapshot",
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

let moduleInstance = 0;

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function withRuntime(run) {
  const privacyHits = [];
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

  const sensitiveNavigatorProperties = new Set(["sendBeacon", "serviceWorker", "storage", "clipboard"]);
  install("navigator", {
    value: new Proxy(Object.create(null), {
      get(_target, property) {
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
    await run({ document, window, elements: document.elements, privacyHits });
  } finally {
    for (const [name, descriptor] of [...savedDescriptors.entries()].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("runtime import renders only allowed synthetic data and CLEAR releases the session", async () => {
  await withRuntime(async ({ elements, privacyHits }) => {
    const csv = syntheticCsv({
      "Notes:": "Synthetic arrival estimated. Email private.notes@example.test or call (555) 123-4567.",
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
    assert.match(rendered, /KAAA.*KBBB/);
    assert.match(rendered, /APPROVED/);
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
    assert.deepEqual(privacyHits, []);

    elements.get("#clearPprButton").click();
    assert.equal(elements.get("#pprCards").childElementCount, 0);
    assert.equal(elements.get("#pprCards").textContent, "");
    assert.equal(elements.get("#loadedView").hidden, true);
    assert.equal(elements.get("#importView").hidden, false);
    assert.equal(elements.get("#snapshotModeButton").disabled, true);
    assert.equal(elements.get("#pprCsvInput").value, "");
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
