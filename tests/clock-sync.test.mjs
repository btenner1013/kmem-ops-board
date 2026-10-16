import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const clockSource = readFileSync(new URL('../clock-sync.js', import.meta.url), 'utf8');
const context = { module: { exports: {} }, Date, performance, setTimeout, clearTimeout, AbortController, fetch };
vm.runInNewContext(clockSource, context);
const sync = context.module.exports;
const { CLOCK_LIMITS, validateHttpSample, chooseTimeEstimate, ClockDiscipline, sampleHttpTime, boundaryDelay, formatClockStatus, waitForSample } = sync;
const epoch = Date.parse('2026-10-16T16:00:00Z');
const reading = (wallMs = epoch, monoMs = 1000) => ({ wallMs, monoMs });
const response = (headers = {}, status = 200) => new Response(null, { status, headers: { Date: new Date(epoch).toUTCString(), ...headers } });
const sample = (offsetMs = 28000, delta = 0) => ({ offsetMs, roundTripMs: 100, uncertaintyMs: 550, serverDateMs: epoch + delta + 28000, received: reading(epoch + delta, 1000 + delta) });
const estimate = (offsetMs = 28000) => ({ ...sample(offsetMs), samples: 3 });

// Network validation executes the production code with deterministic wall/monotonic times.
test('whole-second Date bucket and request midpoint are both included in correction', () => {
  const result = validateHttpSample(response(), reading(epoch - 28000, 100), reading(epoch - 27900, 200));
  assert.equal(result.sample.offsetMs, 28450);
  assert.equal(result.sample.uncertaintyMs, 550);
  assert.equal(result.sample.roundTripMs, 100);
});
test('object Age is never added to a regenerated edge Date; malformed Age is rejected', () => {
  for (const headers of [{ Age: '-1' }, { Age: 'NaN' }, { Age: '1.5' }, { Age: '9007199254740993' }]) {
    assert.equal(validateHttpSample(response(headers), reading(), reading(epoch + 100, 1100)).error, 'INVALID CACHE METADATA', JSON.stringify(headers));
  }
  for (const headers of [{ Age: '0', 'X-Cache': 'MISS' }, { Age: '28', 'X-Cache': 'HIT' }, { Age: '400', 'X-Cache': 'MISS, HIT' }]) {
    const result = validateHttpSample(response(headers), reading(), reading(epoch + 100, 1100));
    assert.equal(result.sample.offsetMs, 450, 'cache age must not become clock skew');
  }
});
test('frozen cached Date is rejected while a regenerated Date can produce a fresh estimate', () => {
  const frozen = [], advancing = [];
  for (const delta of [0, 1100, 2200]) {
    const start = reading(epoch + delta, 1000 + delta), end = reading(epoch + delta + 100, 1100 + delta);
    frozen.push(validateHttpSample(response({ Age: String(28 + Math.floor(delta / 1000)), 'X-Cache': 'HIT' }), start, end).sample);
    advancing.push(validateHttpSample(response({ Date: new Date(epoch + Math.floor(delta / 1000) * 1000).toUTCString(), Age: String(28 + Math.floor(delta / 1000)), 'X-Cache': 'HIT' }), start, end).sample);
  }
  assert.equal(chooseTimeEstimate(frozen), null);
  assert.equal(chooseTimeEstimate(advancing).samples, 3);
  assert.ok(Math.abs(chooseTimeEstimate(advancing).offsetMs) < 1000);
});
test('HTTP errors, redirected responses, and missing or malformed dates are rejected', () => {
  assert.equal(validateHttpSample(response({}, 503), reading(), reading(epoch + 100, 1100)).error, 'HTTP ERROR');
  assert.equal(validateHttpSample({ ok: true, redirected: true, headers: response().headers }, reading(), reading()).error, 'HTTP ERROR');
  for (const value of ['', '2026-10-16', 'Fri, 32 Oct 2026 16:00:00 GMT', 'nonsense']) assert.equal(validateHttpSample(response({ Date: value }), reading(), reading()).error, 'INVALID DATE');
  assert.equal(validateHttpSample(new Response(null), reading(), reading()).error, 'INVALID DATE');
});
test('latency is monotonic and in-request wall-clock jumps cannot produce an offset', () => {
  for (const elapsed of [-1, 1501, Infinity, NaN]) assert.equal(validateHttpSample(response(), reading(), reading(epoch + elapsed, 1000 + elapsed)).error, 'SLOW RESPONSE');
  assert.equal(validateHttpSample(response(), reading(), reading(epoch + 28100, 1100)).error, 'SYSTEM TIME CHANGED');
  assert.equal(validateHttpSample(response(), reading(), reading(epoch - 28000, 1100)).error, 'SYSTEM TIME CHANGED');
});
test('request is same-origin HEAD with no cache, credentials, or redirected time source', async () => {
  let count = 0, request;
  const result = await sampleHttpTime({ read: () => count++ ? reading(epoch + 100, 1100) : reading(), fetcher: async (url, init) => { request = { url, ...init }; return response(); } });
  assert.ok(result.sample); assert.match(request.url, /^\.\/\?clockcheck=/);
  assert.equal(request.method, 'HEAD'); assert.equal(request.cache, 'no-store'); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  assert.match(request.headers['Cache-Control'], /no-cache/);
});
test('hung requests time out even if a fetch implementation ignores abort', async () => {
  let signal;
  const result = await sampleHttpTime({ timeoutMs: 5, fetcher: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  assert.equal(result.error, 'SLOW RESPONSE'); assert.equal(signal.aborted, true);
});
test('network failure and abort have bounded explicit results', async () => {
  assert.equal((await sampleHttpTime({ fetcher: async () => { throw Error('offline'); } })).error, 'NETWORK UNAVAILABLE');
  const parent = new AbortController(); parent.abort();
  let called = false;
  assert.equal((await sampleHttpTime({ signal: parent.signal, fetcher: async () => { called = true; return response(); } })).error, 'CANCELLED');
  assert.equal(called, false);
  const live = new AbortController();
  const pending = sampleHttpTime({ signal: live.signal, fetcher: () => new Promise(() => {}) });
  live.abort(); assert.equal((await pending).error, 'CANCELLED');
  const delay = waitForSample(10000, live.signal); await delay;
});
test('two advancing consistent dates confirm correction; one or frozen dates cannot', () => {
  assert.equal(chooseTimeEstimate([]), null); assert.equal(chooseTimeEstimate([sample()]), null);
  assert.equal(chooseTimeEstimate([sample(), { ...sample(28010, 100), serverDateMs: sample().serverDateMs }]), null);
  const result = chooseTimeEstimate([sample(28000), sample(28100, 1100)]);
  assert.equal(result.samples, 2); assert.equal(result.offsetMs, 28050);
});
test('one outlier is rejected and no coherent pair means no correction', () => {
  assert.equal(chooseTimeEstimate([sample(28000), sample(28100, 1100), sample(-15000, 2200)]).offsetMs, 28050);
  assert.equal(chooseTimeEstimate([sample(28000), sample(-15000, 1100), sample(100000, 2200)]), null);
  assert.equal(chooseTimeEstimate([sample(400000), sample(400010, 1100)]), null);
  assert.equal(chooseTimeEstimate([sample(NaN), sample(Infinity, 1100)]), null);
});
test('system fallback works immediately without any network time', () => {
  const clock = new ClockDiscipline(); const first = clock.read(reading());
  assert.equal(first.nowMs, epoch); assert.equal(first.status.source, 'SYSTEM CLOCK');
  clock.failed(false, 'NETWORK UNAVAILABLE');
  assert.equal(clock.read(reading(epoch + 1000, 2000)).status.state, 'OFFLINE');
});
test('positive and negative correction both apply to an absolute anchor without cumulative tick drift', () => {
  for (const offset of [28000, -28000, 0]) {
    const clock = new ClockDiscipline(); assert.equal(clock.accept(estimate(offset), reading()), true);
    const current = clock.read(reading(epoch + 13786, 14786));
    assert.equal(current.nowMs, epoch + 13786 + offset);
    assert.equal(current.status.source, 'GITHUB HTTP'); assert.equal(current.status.state, 'OK');
    assert.equal(current.status.estimatedOffsetMs, offset); assert.equal(current.recheck, true);
  }
});
test('offline checks retain a labeled bounded holdover and then expire to system time', () => {
  const clock = new ClockDiscipline(); clock.accept(estimate(), reading()); clock.failed(false, 'NETWORK UNAVAILABLE');
  const held = clock.read(reading(epoch + 60_000, 61_000));
  assert.equal(held.nowMs, epoch + 88_000); assert.equal(held.status.source, 'HTTP HOLDOVER'); assert.equal(held.status.state, 'OFFLINE');
  assert.ok(held.status.uncertaintyMs > 550);
  const expired = clock.read(reading(epoch + CLOCK_LIMITS.holdoverMs, 1000 + CLOCK_LIMITS.holdoverMs));
  assert.equal(expired.nowMs, epoch + CLOCK_LIMITS.holdoverMs); assert.equal(expired.status.source, 'SYSTEM CLOCK'); assert.equal(expired.status.estimatedOffsetMs, null);
  assert.equal(expired.status.state, 'OFFLINE'); assert.equal(expired.status.detail, 'CORRECTION EXPIRED');
});
test('online failed checks preserve useful correction with warning and expiry remains visible', () => {
  const clock = new ClockDiscipline(); clock.accept(estimate(), reading()); clock.failed(true, 'NO CONSISTENT FRESH SAMPLES');
  const held = clock.read(reading(epoch + 1000, 2000)); assert.equal(held.status.source, 'HTTP HOLDOVER'); assert.equal(held.status.state, 'WARNING');
  const expired = clock.read(reading(epoch + CLOCK_LIMITS.holdoverMs, 1000 + CLOCK_LIMITS.holdoverMs)); assert.equal(expired.status.state, 'STALE');
  assert.match(formatClockStatus(expired.status), /CORRECTION EXPIRED/);
});
test('Windows correcting its own clock does not double-apply the prior network offset', () => {
  const clock = new ClockDiscipline(); clock.accept(estimate(), reading());
  const correctedSystem = clock.read(reading(epoch + 29000, 2000));
  assert.equal(correctedSystem.nowMs, epoch + 29000); assert.equal(correctedSystem.status.source, 'SYSTEM CLOCK'); assert.equal(correctedSystem.recheck, true);
  const later = { ...estimate(0), received: reading(epoch + 30000, 3000) };
  clock.accept(later, later.received); assert.equal(clock.read(reading(epoch + 31000, 4000)).nowMs, epoch + 31000);
});
test('sleep where performance clock pauses drops correction; sleep where it ticks catches up', () => {
  const paused = new ClockDiscipline(); paused.accept(estimate(), reading());
  const p = paused.read(reading(epoch + 60_000, 1001)); assert.equal(p.nowMs, epoch + 60_000); assert.equal(p.status.source, 'SYSTEM CLOCK'); assert.equal(p.recheck, true);
  const ticking = new ClockDiscipline(); ticking.accept(estimate(), reading());
  const t = ticking.read(reading(epoch + 60_000, 61_000)); assert.equal(t.nowMs, epoch + 88_000); assert.equal(t.recheck, true);
});
test('jump between response and applying result rejects that batch; reload has no inherited correction', () => {
  const clock = new ClockDiscipline(); assert.equal(clock.accept(estimate(), reading(epoch + 30000, 1100)), false);
  assert.equal(clock.read(reading()).status.source, 'SYSTEM CLOCK');
  assert.equal(new ClockDiscipline().read(reading()).nowMs, epoch);
});
test('tick boundary follows corrected time, including negative epoch values', () => {
  assert.equal(boundaryDelay(epoch + 28050), 975);
  assert.equal(boundaryDelay(epoch + 28000), 1025);
  assert.equal(boundaryDelay(-50), 75);
});
test('footer states correction and uncertainty without calling HTTP a precise or verified source', () => {
  const clock = new ClockDiscipline(); clock.accept(estimate(), reading());
  assert.equal(formatClockStatus(clock.read(reading()).status), 'SRC GITHUB HTTP · CORR +28.0S · EST ±0.6S · 1600Z');
  clock.failed(false, 'NETWORK UNAVAILABLE'); assert.match(formatClockStatus(clock.read(reading()).status), /SRC HTTP HOLDOVER · OFFLINE/);
  assert.doesNotMatch(formatClockStatus(clock.read(reading()).status), /WINDOWS SYSTEM|VERIFIED|NTP/);
});


test('a between-request wall jump invalidates the whole sample batch', () => {
  const one = sample(), two = sample(28050, 1100), three = sample(28100, 2200);
  two.received.wallMs += 500; three.received.wallMs += 500;
  assert.equal(chooseTimeEstimate([one, two, three]), null);
});
test('localhost and non-Pages origins never use their own HTTP Date as independent time', async () => {
  for (const location of [{ protocol: 'http:', hostname: 'localhost' }, { protocol: 'http:', hostname: '127.0.0.1' }, { protocol: 'https:', hostname: 'example.com' }, { protocol: 'file:', hostname: '' }]) {
    const endpoint = sync.timeEndpoint(location);
    assert.equal(endpoint.url, 'https://btenner1013.github.io/kmem-ops-board/');
    assert.equal(endpoint.crossOrigin, true);
  }
  const pages = sync.timeEndpoint({ protocol: 'https:', hostname: 'btenner1013.github.io' });
  assert.equal(pages.url, './'); assert.equal(pages.crossOrigin, false);
  let request, count = 0;
  const result = await sampleHttpTime({ ...sync.timeEndpoint({ hostname: 'localhost' }), read: () => count++ ? reading(epoch + 100, 1100) : reading(), fetcher: async (url, init) => { request = { url, ...init }; return response(); } });
  assert.ok(result.sample); assert.match(request.url, /^https:\/\/btenner1013\.github\.io\/kmem-ops-board\/\?clockcheck=/);
  assert.equal(request.headers, undefined, 'cross-origin HEAD must not trigger a custom-header preflight');
  assert.equal(request.credentials, 'omit');
});

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function runtimeHarness(overrideSample) {
  let now = reading(), nextId = 0, calls = 0, signal;
  const timeouts = new Map(), intervals = new Map(), events = new Map(), snapshots = [];
  const host = {
    location: { protocol: 'https:', hostname: 'btenner1013.github.io' },
    addEventListener(name, fn) { const fns = events.get(name) ?? new Set(); fns.add(fn); events.set(name, fns); },
    removeEventListener(name, fn) { const fns = events.get(name); fns?.delete(fn); if (!fns?.size) events.delete(name); },
    setTimeout(fn, ms) { timeouts.set(++nextId, { fn, ms }); return nextId; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { intervals.set(++nextId, { fn, ms }); return nextId; },
    clearInterval(id) { intervals.delete(id); },
  };
  const doc = { ...host, visibilityState: 'visible' }, nav = { onLine: true };
  const clock = sync.createClock({ window: host, document: doc, navigator: nav, read: () => now,
    onTick: value => snapshots.push(value), wait: async () => {}, sample: async options => {
      calls++; signal = options.signal;
      if (overrideSample) return overrideSample(options, { calls, now, setReading: value => { now = value; } });
      now = reading(epoch + calls * 1100, 1000 + calls * 1100);
      return { sample: { ...sample(28000, calls * 1100), received: now } };
    },
  });
  clock.start();
  return { clock, nav, doc, timeouts, intervals, events, snapshots,
    get calls() { return calls; }, get signal() { return signal; }, get latest() { return snapshots.at(-1); },
    setReading(value) { now = value; },
    emit(name) { for (const fn of events.get(name) ?? []) fn(); },
    tick() { const [id, timer] = [...timeouts][0]; timeouts.delete(id); timer.fn(); },
  };
}
test('runtime validates startup, realigns tick, checks every five minutes, and cleans up', async () => {
  const h = runtimeHarness(); await settle();
  assert.equal(h.calls, 3); assert.equal(h.latest.nowMs, epoch + 31300);
  assert.equal(h.latest.status.source, 'GITHUB HTTP'); assert.equal(h.timeouts.size, 1);
  assert.equal([...h.timeouts.values()][0].ms, boundaryDelay(h.latest.nowMs));
  assert.equal([...h.intervals.values()][0].ms, 300000);
  h.clock.start(); assert.equal(h.intervals.size, 1, 'repeated starts are idempotent');
  h.clock.stop(); assert.equal(h.signal.aborted, true); assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0); assert.equal(h.events.size, 0);
});
test('offline holdover keeps ticking and expires even without a weather fetch', async () => {
  const h = runtimeHarness(); await settle();
  h.nav.onLine = false; h.emit('offline');
  assert.equal(h.latest.status.source, 'HTTP HOLDOVER'); assert.equal(h.latest.status.state, 'OFFLINE');
  h.setReading(reading(epoch + 63300, 64300)); h.tick();
  assert.equal(h.latest.nowMs, epoch + 91300);
  h.setReading(reading(epoch + 3300 + CLOCK_LIMITS.holdoverMs, 4300 + CLOCK_LIMITS.holdoverMs)); h.tick();
  assert.equal(h.latest.status.source, 'SYSTEM CLOCK'); assert.equal(h.latest.status.state, 'OFFLINE');
  assert.equal(h.latest.nowMs, epoch + 3300 + CLOCK_LIMITS.holdoverMs);
  assert.equal(h.calls, 3); h.clock.stop();
});
test('resume, reconnect, focus, and visibility checks coalesce without duplicate timers', async () => {
  const h = runtimeHarness(); await settle();
  h.emit('focus'); h.emit('online'); h.emit('visibilitychange'); await settle();
  assert.equal(h.calls, 9, 'one active batch plus one coalesced recheck');
  assert.equal(h.timeouts.size, 1); assert.equal(h.intervals.size, 1);
  h.doc.visibilityState = 'hidden'; h.emit('visibilitychange'); await settle(); assert.equal(h.calls, 9);
  h.clock.stop();
});
test('late results after pagehide cannot update display; a new lifecycle resets correction', async () => {
  let resolve;
  const h = runtimeHarness(() => new Promise(r => { resolve = r; }));
  h.emit('focus'); h.clock.stop(); const before = h.snapshots.length;
  resolve({ sample: sample() }); await settle();
  assert.equal(h.snapshots.length, before); assert.equal(h.timeouts.size, 0);
  h.clock.start(); assert.equal(h.latest.status.source, 'SYSTEM CLOCK'); assert.equal(h.calls, 2);
  h.clock.stop();
});
test('an in-flight jump queues a fresh check instead of waiting five minutes', async () => {
  let resolveThird;
  const h = runtimeHarness((_options, { calls, now, setReading }) => {
    if (calls === 3) return new Promise(resolve => { resolveThird = resolve; });
    const delta = calls <= 2 ? calls * 1100 : 30000 + calls * 1100;
    const result = sample(calls <= 2 ? 28000 : 0, delta); setReading(result.received);
    return { sample: result };
  });
  await settle(); assert.equal(h.calls, 3);
  h.setReading(reading(epoch + 33000, 4300)); h.tick();
  resolveThird({ error: 'SYSTEM TIME CHANGED' }); await settle();
  assert.equal(h.calls, 6); assert.equal(h.timeouts.size, 1); h.clock.stop();
});
test('offline during verification cannot finish with healthy online status', async () => {
  let resolveThird;
  const h = runtimeHarness((_options, { calls, setReading }) => {
    if (calls === 3) return new Promise(resolve => { resolveThird = resolve; });
    const result = sample(28000, calls * 1100); setReading(result.received); return { sample: result };
  });
  await settle(); h.nav.onLine = false; h.emit('offline'); resolveThird({ error: 'NETWORK UNAVAILABLE' }); await settle();
  assert.equal(h.latest.status.source, 'HTTP HOLDOVER'); assert.equal(h.latest.status.state, 'OFFLINE'); h.clock.stop();
});
test('failed or CORS-hidden Date leaves runtime on an explicit system fallback', async () => {
  const h = runtimeHarness(async () => ({ error: 'INVALID DATE' })); await settle();
  assert.equal(h.latest.nowMs, epoch); assert.equal(h.latest.status.source, 'SYSTEM CLOCK');
  assert.equal(h.latest.status.state, 'WARNING'); assert.equal(h.latest.status.detail, 'INVALID DATE'); h.clock.stop();
});

const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const boardClockCode = page.slice(page.indexOf('// Keep these synchronous globals:'), page.indexOf('\nfunction fitClockPanels()'));
function displayHarness() {
  const ids = ['local', 'localDate', 'zulu', 'zuluDate', 'clockHealth'];
  const elements = Object.fromEntries(ids.map(id => [id, { textContent: '', className: '', title: '' }]));
  const events = [], intervals = new Map(); let nextId = 0;
  const window = { KmemClockSync: sync };
  const context = vm.createContext({ window, Date, document: { getElementById: id => elements[id] },
    setInterval(fn) { intervals.set(++nextId, fn); return nextId; }, clearInterval(id) { intervals.delete(id); },
    fitClockPanels() {}, setMetarAge(value) { events.push(['metar-age', value]); }, updateStaleWarning(value) { events.push(['stale', value]); },
    updateSourceHealth(data, updated) { events.push(['feeds', data, updated]); }, renderHostHealth(data) { events.push(['host', data]); },
  });
  vm.runInContext(boardClockCode, context);
  return { context, elements, window, events, intervals, render(iso, correction = 0) {
    const wall = Date.parse(iso), clock = new ClockDiscipline();
    clock.accept({ ...estimate(correction), received: reading(wall, 0) }, reading(wall, 0));
    context.updateClock(clock.read(reading(wall, 0)));
  } };
}
test('board clocks use corrected UTC/local dates across both New Year rollovers', () => {
  const h = displayHarness(); h.render('2026-12-31T23:59:40Z', 28000);
  assert.equal(h.elements.zulu.textContent, '00:00:08z'); assert.equal(h.elements.zuluDate.textContent, 'UTC Date: 2027-01-01');
  assert.equal(h.elements.local.textContent, '18:00:08'); assert.match(h.elements.localDate.textContent, /December 31, 2026/);
  h.render('2027-01-01T05:59:40Z', 28000);
  assert.equal(h.elements.local.textContent, '00:00:08'); assert.match(h.elements.localDate.textContent, /January 1, 2027/);
});
test('board local time preserves Memphis DST, leap day, and h23 midnight', () => {
  const h = displayHarness(); h.render('2026-03-08T07:59:40Z', 28000); assert.equal(h.elements.local.textContent, '03:00:08');
  h.render('2026-11-01T06:59:40Z', 28000); assert.equal(h.elements.local.textContent, '01:00:08');
  h.render('2028-02-29T06:00:00Z'); assert.equal(h.elements.local.textContent, '00:00:00'); assert.match(h.elements.localDate.textContent, /February 29, 2028/);
});
test('footer reports source/uncertainty separately and correction re-evaluates age without mutating data', () => {
  const h = displayHarness(); const data = Object.freeze({ metar: 'OBSERVATION', allFeedsUpdatedZ: '2026-10-16T15:55:00Z' });
  h.window.kmemWeatherData = data; h.window.kmemHostStatus = Object.freeze({ heartbeatUtc: '2026-10-16T15:55:00Z' });
  h.render('2026-10-16T16:00:00Z', 28000);
  assert.match(h.elements.clockHealth.textContent, /GITHUB HTTP · EST ±0.6S/); assert.equal(h.elements.clockHealth.className, 'clock-health clock-ok');
  assert.match(h.elements.clockHealth.title, /CORR \+28.0S/);
  assert.equal(h.events.filter(e => e[0] === 'stale').length, 1); assert.equal(h.events.filter(e => e[0] === 'host').length, 1);
  assert.equal(h.events.find(e => e[0] === 'feeds')[1], data);
  assert.equal(h.events.find(e => e[0] === 'feeds')[2], '2026-10-16T15:55:00Z');
  h.render('2026-10-16T16:00:00Z', 0); assert.equal(h.events.filter(e => e[0] === 'stale').length, 2);
  const sourceHealth = page.slice(page.indexOf('function updateSourceHealth('), page.indexOf('function parseCaoDate('));
  assert.doesNotMatch(sourceHealth, /clockOffset|clockToken|clockHealth/);
});
test('missing clock module still ticks system time and page lifecycle has no duplicate intervals', () => {
  const h = displayHarness(); h.window.KmemClockSync = undefined;
  h.context.startBoardClock(); h.context.startBoardClock(); assert.equal(h.intervals.size, 1);
  assert.match(h.elements.clockHealth.textContent, /CLOCK SYSTEM CLOCK · WARNING/);
  assert.match(h.elements.clockHealth.title, /module unavailable/);
  assert.match(h.elements.zulu.textContent, /^\d{2}:\d{2}:\d{2}z$/);
  h.context.stopBoardClock(); assert.equal(h.intervals.size, 0);
  h.context.startBoardClock(); assert.equal(h.intervals.size, 1); h.context.stopBoardClock();
  assert.match(page, /addEventListener\("pagehide",stopBoardClock\)/);
  assert.match(page, /addEventListener\("pageshow",startBoardClock\)/);
  assert.doesNotMatch(page, /updateClockOffsetFromResponse|clockOffsetMs|checkClockWatchdog/);
});


test('clock correction preserves weather fetch failures until a successful snapshot', () => {
  const h = displayHarness(); h.window.kmemWeatherData = Object.freeze({ metar: 'OBSERVATION', allFeedsUpdatedZ: '2026-10-16T15:55:00Z' });
  h.window.kmemWeatherFetchFailed = true;
  h.render('2026-10-16T16:00:00Z', 28000);
  h.render('2026-10-16T16:01:00Z', 28000);
  assert.equal(h.events.filter(e => e[0] === 'feeds').length, 0, 'cached feed successes must not erase weather.json BAD');
  assert.equal(h.events.filter(e => e[0] === 'stale').length, 2);
  assert.equal(h.events.filter(e => e[0] === 'metar-age').length, 2, 'visible METAR age still follows corrected time');
  h.window.kmemWeatherFetchFailed = false;
  h.render('2026-10-16T16:02:00Z', 28000);
  assert.equal(h.events.filter(e => e[0] === 'feeds').length, 1);
  const snapshotCode = page.slice(page.indexOf('function applyWeatherSnapshot('), page.indexOf('async function loadRawAtisCatchup('));
  const fetchCode = page.slice(page.indexOf('async function loadWeatherJson('), page.indexOf('async function loadHostStatus('));
  assert.match(snapshotCode, /window\.kmemWeatherFetchFailed=false/);
  assert.match(fetchCode, /catch\(e\)\{\s*window\.kmemWeatherFetchFailed=true/);
});
