import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTafReport, formatDecodedTafText } from '../aviation-weather-lookup-core.js';
const decode = (raw) => decodeTafReport(raw, { referenceTime: new Date('2026-11-18T09:00:00Z') });
test('text keeps dated local and UTC periods, gusts and probabilistic changes', () => {
  const text = formatDecodedTafText(decode('TAF KMEM 180900Z 1809/1912 36012G22KT P6SM SKC TEMPO 1810/1812 2SM -TSRA BKN020CB PROB30 1812/1814 1SM SN OVC010 FM181500 18008KT P6SM SCT040 BECMG 1900/1902 VRB03KT'));
  assert.match(text, /Wind: ↓ from N \(360° true\) at 12 kt, gusting 22 kt/);
  assert.match(text, /Wind: ↑ from S \(180° true\) at 8 kt/);
  assert.match(text, /Wind: Variable at 3 kt/);
  assert.match(text, /Local time zone: America\/Chicago/);
  assert.match(text, /UTC: .*18 NOV/);
  assert.match(text, /Temporary \(TEMPO\)/);
  assert.match(text, /30% chance/);
  assert.match(text, /Becoming/);
  assert.match(text, /⛈️ Weather: Light thunderstorm rain/);
  assert.match(text, /❄️ Weather: snow/);
  assert.match(text, /☁️ Sky: Broken at 2000 ft; cumulonimbus/);
  assert.doesNotMatch(text, /☀|🌙/);
});
test('text preserves unknown tokens and calm, no invented weather', () => {
  const text = formatDecodedTafText(decode('TAF KMEM 180900Z 1809/1912 00000KT P6SM SKC WS020/18040KT'));
  assert.match(text, /Wind: Calm/);
  assert.match(text, /Not decoded: WS020\/18040KT/);
  assert.doesNotMatch(text, /Weather:|from N/);
});
test('malformed TAF remains visible rather than fabricated forecast', () => {
  assert.match(formatDecodedTafText(decode('unreadable')), /Not decoded: unreadable/);
  assert.equal(formatDecodedTafText(null), '');
});
test('eight bearings have consistent airflow arrows', () => {
  for (const [bearing, arrow, cardinal] of [[0,'↓','N'],[45,'↙','NE'],[90,'←','E'],[135,'↖','SE'],[180,'↑','S'],[225,'↗','SW'],[270,'→','W'],[315,'↘','NW']]) {
    const token = String(bearing).padStart(3,'0');
    assert.ok(formatDecodedTafText(decode(`TAF KMEM 180900Z 1809/1912 ${token}05KT P6SM SKC`)).includes(`${arrow} from ${cardinal} (${bearing}° true)`));
  }
});

import { renderResultCards } from '../aviation-weather-lookup.js';
test('COPY TEXT writes identical message on desktop/mobile and offers selectable fallback', async () => {
  const savedDoc = globalThis.document;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const element = (tag) => ({
    tagName: tag, children: [], handlers: {}, attributes: {},
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { this.handlers[name] = fn; },
    focus() { this.focused = true; }, select() { this.selected = true; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
  });
  try {
    globalThis.document = { createElement: element };
    const container = element('div');
    renderResultCards(container, [{ product: 'TAF', station: 'KMEM', timestamp: '2026-11-18T09:00:00Z', raw: 'TAF KMEM 180900Z 1809/1912 18008KT P6SM SKC' }]);
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    const nodes = flatten(container);
    const copy = nodes.find(n => n.textContent === 'COPY TEXT');
    const fallback = nodes.find(n => n.tagName === 'textarea');
    const status = nodes.find(n => n.attributes.role === 'status');
    const shown = nodes.find(n => n.className === 'aviation-lookup-message-text').textContent;
    let copied;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
    await copy.handlers.click();
    assert.equal(copied, shown);
    assert.equal(fallback.hidden, true);
    assert.match(status.textContent, /Copied/);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('Permission denied'); } } } });
    await copy.handlers.click();
    assert.equal(fallback.value, shown);
    assert.equal(fallback.hidden, false);
    assert.deepEqual(fallback.selection, [0, shown.length]);
    assert.equal(fallback.focused, true);
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await copy.handlers.click();
    assert.equal(fallback.value, shown);
  } finally {
    globalThis.document = savedDoc;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
  }
});
