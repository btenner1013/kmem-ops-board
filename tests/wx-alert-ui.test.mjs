import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} exists`);
  return source.slice(start, end);
}
function makeElement() {
  return {
    className: '', innerHTML: '', textContent: '', title: '',
    classList: { add(...names) { this.owner.className += ` ${names.join(' ')}`; } },
  };
}
function setup() {
  const elements = Object.fromEntries(['wxTrendBox', 'tafTrendLabel', 'tafTrend'].map(id => [id, makeElement()]));
  for (const element of Object.values(elements)) element.classList.owner = element;
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    wxAlertDisplayHtml: value => String(value),
  });
  vm.runInContext(functionSource('wxAlertSegmentHtml') + '\n' + functionSource('setTafTrend'), context);
  return { elements, render: data => context.setTafTrend(data) };
}
const rain = { code: '-RA', displayText: '🌧️ -RA ATIS', sources: ['ATIS', 'METAR'], displayTone: 'blue', flash: false, pulse: false };
const forecast = { code: '-TSRA', displayText: '⛈️ -TSRA PSBL 04 NOV 00-04Z', sources: ['TAF'], tafWindow: '04 NOV 00-04Z', displayTone: 'yellow', flash: false, pulse: true };
const payload = (primary = rain, secondary = forecast) => ({ wxAlertVisible: true, wxPrimaryAlert: primary, wxSecondaryAlert: secondary, wxAlertTone: primary.displayTone, wxAlertFlash: primary.flash, wxAlertPulse: primary.pulse });

test('current and possible weather stay in one existing card, current first', () => {
  const { elements, render } = setup();
  render(payload());
  const trend = elements.tafTrend;
  assert.equal(elements.tafTrendLabel.textContent, 'WX ALERT');
  assert.ok(trend.innerHTML.indexOf('-RA ATIS') < trend.innerHTML.indexOf('-TSRA PSBL'));
  assert.match(trend.innerHTML, /04 NOV 00-04Z/);
  assert.match(trend.className, /wx-alert-pair/);
  assert.equal((source.match(/id="wxTrendBox"/g) || []).length, 1);
});

test('each segment retains its own tone and animation, never the container', () => {
  const { elements, render } = setup();
  render(payload({ ...rain, code: 'TSRA', displayText: '⛈️ TSRA OBS', displayTone: 'red', flash: true }));
  assert.match(elements.tafTrend.innerHTML, /class="wx-alert-segment alert-red alert-flash"/);
  assert.match(elements.tafTrend.innerHTML, /class="wx-alert-segment alert-yellow alert-pulse"/);
  assert.doesNotMatch(elements.tafTrend.className, /alert-red|alert-flash|alert-pulse/);
});

test('same hazard code is abbreviated once without losing possible timing', () => {
  const { elements, render } = setup();
  render(payload(rain, { ...forecast, code: '-RA', displayText: '🌧️ -RA PSBL 04 NOV 00-04Z' }));
  assert.equal((elements.tafTrend.innerHTML.match(/-RA/g) || []).length, 1);
  assert.match(elements.tafTrend.innerHTML, /PSBL 04 NOV 00-04Z/);
});

test('distinct intensity is not deduplicated', () => {
  const { elements, render } = setup();
  render(payload(rain, { ...forecast, code: '+RA', displayText: '🌧️ +RA PSBL 04 NOV 00-04Z' }));
  assert.match(elements.tafTrend.innerHTML, /-RA ATIS/);
  assert.match(elements.tafTrend.innerHTML, /\+RA PSBL/);
});

test('METAR-only source stays METAR even with a retained stale ATIS', () => {
  const { elements, render } = setup();
  const observed = { ...rain, displayText: '🌧️ -RA METAR', sources: ['METAR'] };
  for (const secondary of [forecast, null]) {
    render({ ...payload(observed, secondary), atisText: 'MEM ATIS INFO A 1200Z. 5SM -RA', atisSourceIsCurrent: false, atisFetchStatus: 'STALE' });
    assert.match(elements.tafTrend.innerHTML, /-RA METAR/);
    assert.doesNotMatch(elements.tafTrend.innerHTML, /ATIS|NOW/);
  }
});

test('no current observation means forecast only, never fabricated NOW', () => {
  const { elements, render } = setup();
  render(payload(forecast, null));
  assert.match(elements.tafTrend.innerHTML, /-TSRA PSBL 04 NOV 00-04Z/);
  assert.doesNotMatch(elements.tafTrend.innerHTML, /OBS|ATIS|NOW|wx-alert-separator/);
  assert.doesNotMatch(elements.tafTrend.className, /wx-alert-pair/);
});

test('repeated updates remove obsolete forecast, color and paired layout', () => {
  const { elements, render } = setup();
  render(payload());
  render(payload(rain, null));
  assert.doesNotMatch(elements.tafTrend.innerHTML, /PSBL|alert-yellow|wx-alert-separator/);
  assert.doesNotMatch(elements.tafTrend.className, /wx-alert-pair/);
  render({ wxAlertVisible: false });
  assert.equal(elements.tafTrend.textContent, 'NONE');
  assert.match(elements.tafTrend.className, /alert-none/);
});

test('structured source text is escaped and tone classes are allowlisted', () => {
  const { elements, render } = setup();
  render(payload({ ...rain, displayText: '<img src=x onerror=bad()> & OBS', displayTone: 'red" onclick="bad()' }, null));
  assert.doesNotMatch(elements.tafTrend.innerHTML, /<img|onclick=/);
  assert.match(elements.tafTrend.innerHTML, /&lt;img/);
  assert.match(elements.tafTrend.innerHTML, /alert-yellow/);
});

test('legacy unstructured payload keeps its existing fallback', () => {
  const { elements, render } = setup();
  render({ wxAlertVisible: true, wxAlertText: '-RA OBS', wxAlertTone: 'blue' });
  assert.equal(elements.tafTrend.innerHTML, '-RA OBS');
  assert.match(elements.tafTrend.className, /alert-blue/);
});
