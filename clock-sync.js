/* KMEM display-only HTTP time estimate. No OS changes and no saved correction.
 * Ported from the airfield clock's clockSync.ts. Served as a classic script so
 * existing inline board consumers and the optional localhost display keep working.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KmemClockSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";
// HTTP Date is a whole-second, unauthenticated-as-a-time-source estimate, not NTP.
// Use fresh, low-latency, advancing responses only. Never persist an offset across reloads.
const CLOCK_LIMITS = {
    verifyIntervalMs: 5 * 60_000,
    holdoverMs: 20 * 60_000,
    maxRoundTripMs: 1500,
    requestTimeoutMs: 2500,
    sampleGapMs: 1100,
    maxCorrectionMs: 5 * 60_000,
    maxSampleSpreadMs: 1000,
    wallJumpMs: 1000,
    requestWallJumpMs: 100,
    resumeGapMs: 5000,
};
const readClock = () => ({ wallMs: Date.now(), monoMs: performance.now() });
function boundaryDelay(nowMs) { return 1000 - ((nowMs % 1000 + 1000) % 1000) + 25; }
function median(values) {
    const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
    return n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : 0;
}
function validateHttpSample(response, start, end) {
    if (!response.ok || response.redirected)
        return { error: "HTTP ERROR" };
    const rtt = end.monoMs - start.monoMs;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > CLOCK_LIMITS.maxRoundTripMs)
        return { error: "SLOW RESPONSE" };
    if (Math.abs(end.wallMs - start.wallMs - rtt) > CLOCK_LIMITS.requestWallJumpMs)
        return { error: "SYSTEM TIME CHANGED" };
    const date = response.headers.get("date")?.trim();
    const serverDateMs = date ? Date.parse(date) : NaN;
    if (!date || !Number.isFinite(serverDateMs) || new Date(serverDateMs).toUTCString() !== date)
        return { error: "INVALID DATE" };
    const age = response.headers.get("age");
    // GitHub's edge regenerates Date even for HIT objects with nonzero Age. Age is the
    // cached object's age, not the age of that regenerated Date; adding it would create
    // a false clock skew. Treat these as candidates only: chooseTimeEstimate requires
    // advancing Date values consistent with elapsed monotonic time before applying any.
    // Frozen cached Date headers therefore cannot discipline the display.
    if (age !== null && (!/^\d+$/.test(age.trim()) || !Number.isSafeInteger(Number(age))))
        return { error: "INVALID CACHE METADATA" };
    // Center the server's one-second Date bucket and the measured request interval. Path
    // asymmetry and server timestamp placement are uncertain, so expose the estimate's error.
    const uncertaintyMs = 500 + rtt / 2;
    return { sample: { offsetMs: serverDateMs + 500 - (start.wallMs + rtt / 2), roundTripMs: rtt, uncertaintyMs, serverDateMs, received: end } };
}
async function sampleHttpTime(options = {}) {
    const controller = new AbortController(), read = options.read ?? readClock;
    if (options.signal?.aborted)
        return { error: "CANCELLED" };
    let timer;
    let stop = () => { };
    const interrupted = new Promise(resolve => {
        stop = () => { controller.abort(); resolve({ error: "CANCELLED" }); };
        options.signal?.addEventListener("abort", stop, { once: true });
        timer = setTimeout(() => { controller.abort(); resolve({ error: "SLOW RESPONSE" }); }, options.timeoutMs ?? CLOCK_LIMITS.requestTimeoutMs);
    });
    const request = (async () => {
        const start = read();
        try {
            // HEAD bypasses GET-only offline caches. Pages uses a same-origin URL; local
            // displays use the public Pages endpoint, never their own Windows Date header.
            const response = await (options.fetcher ?? fetch)(`${options.url ?? "./"}${(options.url ?? "./").includes("?") ? "&" : "?"}clockcheck=${start.monoMs}_${Math.random().toString(36).slice(2)}`, {
                method: "HEAD", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
                // Cross-origin Pages checks must stay simple HEAD requests (no preflight).
                ...(options.crossOrigin ? {} : { headers: { "Cache-Control": "no-cache, no-store, max-age=0", Pragma: "no-cache" } }),
            });
            return validateHttpSample(response, start, read());
        }
        catch {
            return { error: controller.signal.aborted ? "CANCELLED" : "NETWORK UNAVAILABLE" };
        }
    })();
    try {
        return await Promise.race([request, interrupted]);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
    }
}
// At least two consistent samples, spanning distinct server seconds, must agree. A single
// outlier may be excluded; repeated frozen Date headers or divergent clocks cannot set time.
function chooseTimeEstimate(samples) {
    const chronological = [...samples].sort((a, b) => a.received.monoMs - b.received.monoMs);
    // Each request may be internally sound even when Windows changed between requests.
    // Reject the entire batch instead of accidentally treating two sides of that jump as consensus.
    if (chronological.some((s, i) => i > 0 && Math.abs((s.received.wallMs - chronological[i - 1].received.wallMs) - (s.received.monoMs - chronological[i - 1].received.monoMs)) > CLOCK_LIMITS.requestWallJumpMs))
        return null;
    const valid = chronological.filter(s => Number.isFinite(s.offsetMs) && Math.abs(s.offsetMs) <= CLOCK_LIMITS.maxCorrectionMs);
    let best = [];
    for (const first of valid) {
        const group = valid.filter(s => s.offsetMs >= first.offsetMs && s.offsetMs - first.offsetMs <= CLOCK_LIMITS.maxSampleSpreadMs);
        const datesAdvance = group.length > 1 && group[group.length - 1].serverDateMs > group[0].serverDateMs && group.every((s, i) => i === 0 || s.serverDateMs >= group[i - 1].serverDateMs);
        if (group.length < 2 || !datesAdvance)
            continue;
        if (group.length > best.length || (group.length === best.length && spread(group) < spread(best)))
            best = group;
    }
    if (best.length < 2)
        return null;
    const latest = best.reduce((a, b) => a.received.monoMs > b.received.monoMs ? a : b);
    const offsetMs = median(best.map(s => s.offsetMs));
    return { ...latest, offsetMs, roundTripMs: Math.min(...best.map(s => s.roundTripMs)), uncertaintyMs: Math.max(...best.map(s => s.uncertaintyMs + Math.abs(s.offsetMs - offsetMs))), samples: best.length };
}
function spread(samples) { return samples.length ? Math.max(...samples.map(s => s.offsetMs)) - Math.min(...samples.map(s => s.offsetMs)) : Infinity; }
function waitForSample(ms, signal) {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}
class ClockDiscipline {
    estimate = null;
    previous = null;
    lastCheckedUtc = null;
    state = "CHECK";
    detail = "CHECKING NETWORK";
    accept(estimate, now) {
        const elapsed = now.monoMs - estimate.received.monoMs;
        if (elapsed < 0 || elapsed > CLOCK_LIMITS.holdoverMs || Math.abs(now.wallMs - estimate.received.wallMs - elapsed) > CLOCK_LIMITS.requestWallJumpMs) {
            this.failed(true, "SYSTEM TIME CHANGED");
            return false;
        }
        this.estimate = estimate;
        this.previous = now;
        this.lastCheckedUtc = estimate.received.wallMs + estimate.offsetMs;
        this.state = "OK";
        this.detail = "HTTP ESTIMATE";
        return true;
    }
    failed(online, detail) { this.state = online ? "WARNING" : "OFFLINE"; this.detail = detail; }
    read(now) {
        let recheck = false;
        if (this.previous) {
            const wallElapsed = now.wallMs - this.previous.wallMs, monoElapsed = now.monoMs - this.previous.monoMs;
            const jumped = monoElapsed < 0 || Math.abs(wallElapsed - monoElapsed) > CLOCK_LIMITS.wallJumpMs;
            recheck = jumped || Math.max(wallElapsed, monoElapsed) > CLOCK_LIMITS.resumeGapMs;
            if (jumped) {
                this.estimate = null;
                this.state = "CHECK";
                this.detail = "SYSTEM TIME CHANGED";
            }
        }
        this.previous = now;
        const age = this.estimate ? now.monoMs - this.estimate.received.monoMs : Infinity;
        if (this.estimate && (age < 0 || age >= CLOCK_LIMITS.holdoverMs)) {
            this.estimate = null;
            this.state = this.state === "OFFLINE" ? "OFFLINE" : "STALE";
            this.detail = "CORRECTION EXPIRED";
            recheck = true;
        }
        const estimate = this.estimate;
        // Re-read an absolute anchor, never increment a second counter. A delayed tick catches
        // up immediately. A wall-clock change cannot accidentally apply the old offset twice.
        const nowMs = estimate ? estimate.received.wallMs + estimate.offsetMs + age : now.wallMs;
        return { nowMs, recheck, status: {
                source: estimate ? this.state === "OK" ? "GITHUB HTTP" : "HTTP HOLDOVER" : "SYSTEM CLOCK",
                networkSource: "GITHUB EDGE DATE", lastCheckedUtc: this.lastCheckedUtc,
                estimatedOffsetMs: estimate ? nowMs - now.wallMs : null,
                roundTripMs: estimate?.roundTripMs ?? null,
                uncertaintyMs: estimate ? estimate.uncertaintyMs + age * 0.0001 : null, // allow 100 ppm holdover drift
                state: this.state, detail: this.detail,
            } };
    }
}
function formatClockStatus(status) {
    const prefix = `SRC ${status.source}`;
    if (status.source === "PREVIEW")
        return `${prefix} · ${status.detail}`;
    if (status.source === "SYSTEM CLOCK")
        return `${prefix} · ${status.state === "CHECK" ? status.detail : `NETWORK ${status.state}: ${status.detail}`}`;
    const offset = status.estimatedOffsetMs ?? 0;
    const correction = `${offset >= 0 ? "+" : "-"}${(Math.abs(offset) / 1000).toFixed(1)}S`;
    const error = status.uncertaintyMs === null ? "" : ` · EST ±${(status.uncertaintyMs / 1000).toFixed(1)}S`;
    const last = status.lastCheckedUtc === null ? "" : ` · ${new Date(status.lastCheckedUtc).toISOString().slice(11, 16).replace(":", "")}Z`;
    return `${prefix} · ${status.source === "HTTP HOLDOVER" ? `${status.state} · ` : ""}CORR ${correction}${error}${last}`;
}

const PAGES_TIME_URL = "https://btenner1013.github.io/kmem-ops-board/";
function timeEndpoint(location) {
    // A local web server's Date follows that same PC. It is never an independent
    // clock check. Cross-origin Date must be readable or validation falls back.
    const sameOrigin = location?.protocol === "https:" && location?.hostname === "btenner1013.github.io";
    return { url: sameOrigin ? "./" : PAGES_TIME_URL, crossOrigin: !sameOrigin };
}

function createClock(options = {}) {
    const host = options.window ?? window;
    const doc = options.document ?? document;
    const nav = options.navigator ?? navigator;
    const read = options.read ?? readClock;
    const sample = options.sample ?? sampleHttpTime;
    const wait = options.wait ?? waitForSample;
    const endpoint = timeEndpoint(options.location ?? host.location);
    let discipline = new ClockDiscipline();
    let session = null;
    const current = () => {
        const value = discipline.read(read());
        if (value.recheck && session) void session.verify();
        return value;
    };
    const start = () => {
        if (session) return;
        // A new page lifecycle never inherits a possibly stale correction.
        discipline = new ClockDiscipline();
        const controller = new AbortController();
        const state = { stopped: false, inFlight: false, pending: false, timer: 0, interval: 0, verify: null, stop: null };
        const publish = () => {
            if (state.stopped) return null;
            const value = discipline.read(read());
            options.onTick?.(value);
            return value;
        };
        const verify = async () => {
            if (state.stopped) return;
            if (state.inFlight) { state.pending = true; return; }
            if (nav.onLine === false) { discipline.failed(false, "NETWORK UNAVAILABLE"); publish(); return; }
            state.inFlight = true;
            const samples = [];
            let failure = "NO CONSISTENT FRESH SAMPLES";
            try {
                for (let i = 0; i < 3 && !controller.signal.aborted; i++) {
                    if (i) await wait(CLOCK_LIMITS.sampleGapMs, controller.signal);
                    if (controller.signal.aborted) break;
                    const result = await sample({ ...endpoint, signal: controller.signal, read, fetcher: options.fetcher });
                    if (result.sample) samples.push(result.sample);
                    else failure = result.error;
                }
                if (state.stopped) return;
                const estimate = chooseTimeEstimate(samples);
                if (estimate) {
                    discipline.accept(estimate, read());
                    if (nav.onLine === false) discipline.failed(false, "NETWORK UNAVAILABLE");
                } else {
                    discipline.failed(nav.onLine !== false, samples.length ? "NO CONSISTENT FRESH SAMPLES" : failure);
                }
                host.clearTimeout(state.timer);
                tick();
            } finally {
                state.inFlight = false;
                if (state.pending && !state.stopped) { state.pending = false; void verify(); }
            }
        };
        const tick = () => {
            if (state.stopped) return;
            const value = publish();
            if (value?.recheck) void verify();
            state.timer = host.setTimeout(tick, boundaryDelay(value?.nowMs ?? read().wallMs));
        };
        const refresh = () => { host.clearTimeout(state.timer); tick(); void verify(); };
        const onVisibility = () => { if (doc.visibilityState === "visible") refresh(); };
        const onOffline = () => { discipline.failed(false, "NETWORK UNAVAILABLE"); publish(); };
        state.verify = verify;
        state.stop = () => {
            state.stopped = true;
            controller.abort();
            host.clearTimeout(state.timer);
            host.clearInterval(state.interval);
            doc.removeEventListener("visibilitychange", onVisibility);
            host.removeEventListener("focus", refresh);
            host.removeEventListener("online", refresh);
            host.removeEventListener("offline", onOffline);
        };
        session = state;
        tick();
        void verify();
        state.interval = host.setInterval(() => void verify(), CLOCK_LIMITS.verifyIntervalMs);
        doc.addEventListener("visibilitychange", onVisibility);
        host.addEventListener("focus", refresh);
        host.addEventListener("online", refresh);
        host.addEventListener("offline", onOffline);
    };
    const stop = () => { session?.stop(); session = null; };
    return { start, stop, read: current, now: () => current().nowMs, verify: () => session?.verify() };
}

return { CLOCK_LIMITS, PAGES_TIME_URL, readClock, boundaryDelay, median, validateHttpSample,
    sampleHttpTime, chooseTimeEstimate, waitForSample, ClockDiscipline, formatClockStatus,
    timeEndpoint, createClock };
});
