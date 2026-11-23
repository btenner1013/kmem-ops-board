/* Static Pages relay for the optional loopback kiosk. No board data or credentials. */
"use strict";
const kioskOrigins = new Set(["http://localhost:8765", "http://127.0.0.1:8765", "http://[::1]:8765"]);
window.addEventListener("message", async event => {
  if (window.parent === window || event.source !== window.parent || !kioskOrigins.has(event.origin)) return;
  const data = event.data;
  if (data?.type !== "kmem-clock-request" || typeof data.id !== "string" || data.id.length > 100) return;
  let result = { ok: false, date: null, age: null };
  try {
    const response = await fetch("./?clockrelay=" + encodeURIComponent(data.id), {
      method: "HEAD", cache: "no-store", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(1800),
    });
    result = { ok: response.ok && !response.redirected, date: response.headers.get("date"), age: response.headers.get("age") };
  } catch {}
  window.parent.postMessage({ type: "kmem-clock-response", id: data.id, ...result }, event.origin);
});
