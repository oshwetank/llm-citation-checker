/*
 * netlog.js — the network recorder's entries, grouped for the diagnostic
 * report (0.62.0).
 *
 * Gemini, Perplexity and Grok change the requests that carry an answer, and
 * when they do the extension sees nothing: the answer arrives on a path the
 * capture patterns don't match. With "Debug capture" on, content-main.js logs
 * every request an engine page makes (fetch, XHR, WebSocket, EventSource),
 * already stripped to host, a path with ids masked, the query's key names and
 * the key names of a response's first 2 KB. This groups those entries so the
 * report shows, per engine, which calls the page made and which of them were
 * captured: an unmatched streaming call with answer-like keys is the one a
 * pattern has to learn.
 *
 * maskPath and keyShape are the same rules content-main.js applies before an
 * entry leaves the page; they live here too so the rules are unit-tested and
 * so entries are masked again on the way in, in case an older page script
 * sent them unmasked.
 */

export const NETLOG_MAX = 3000;

// Query keys whose values name the call rather than carry anything of the
// user's (0.62.1): Gemini's batchexecute "rpcids", WebChannel's "TYPE"…
// Same list in content-main.js (NET_VALUE_KEYS); the unit test checks.
export const NET_VALUE_KEYS = /^(?:rpcids|rt|TYPE|VER|CI|source-path-kind)$/;

const ID_SEG = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|\d{4,}|[A-Za-z0-9_-]{20,})$/i;

/** A path with ids and anything prompt-like masked: ":id" for ids, ":text" for long or wordy segments. */
export function maskPath(pathname) {
  return String(pathname || "/").split("/").map((seg) => {
    if (!seg) return seg;
    let s = seg;
    try { s = decodeURIComponent(seg); } catch (_) { /* keep raw */ }
    // A prompt can land in a path as a slug ("best-camera-phones-under-…").
    // A uuid first (its dashes would read as a slug), then slugs, then ids.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ":id";
    if (s.length > 40 || /\s/.test(s) || (s.match(/-/g) || []).length >= 3) return ":text";
    if (ID_SEG.test(s) || (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 10)) return ":id";
    return s;
  }).join("/").slice(0, 200);
}

/** The query's key names, never its values. */
export function queryKeys(search) {
  const keys = new Set();
  try { new URLSearchParams(search || "").forEach((_, k) => { if (/^[\w.[\]-]{1,40}$/.test(k)) keys.add(k); }); } catch (_) { /* none */ }
  return [...keys].sort().slice(0, 20);
}

/**
 * What a response's first bytes look like, without any of their values: its
 * form (json, sse, xssi-prefixed, socket.io, text) and up to 40 key names.
 */
export function keyShape(text) {
  const head = String(text || "").slice(0, 2048);
  if (!head.trim()) return null;
  const t = head.trimStart();
  const form = /^\)\]\}'/.test(t) ? "xssi" : /^(?:data|event|id):/m.test(t) ? "sse" : /^4\d/.test(t) ? "socket.io" : /^[[{]/.test(t) ? "json" : "text";
  const keys = [];
  const re = /"([A-Za-z_$][\w$-]{0,40})"\s*:/g;
  let m;
  while ((m = re.exec(head)) && keys.length < 40) if (!keys.includes(m[1])) keys.push(m[1]);
  return { form, keys };
}

/** One entry as stored: only these fields, each bounded. */
export function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);
  const shape = e.shape && typeof e.shape === "object"
    ? { form: String(e.shape.form || "").slice(0, 12), keys: (Array.isArray(e.shape.keys) ? e.shape.keys : []).filter((k) => /^[A-Za-z_$][\w$-]{0,40}$/.test(k)).slice(0, 40) }
    : null;
  return {
    t: num(e.t) || Date.now(),
    page: String(e.page || "").slice(0, 80),
    kind: String(e.kind || "fetch").slice(0, 12),
    method: String(e.method || "GET").toUpperCase().slice(0, 8),
    host: String(e.host || "").slice(0, 120),
    path: maskPath(e.path),
    q: (Array.isArray(e.q) ? e.q : []).filter((k) => /^[\w.[\]-]{1,40}$/.test(k)).slice(0, 20),
    qv: Object.fromEntries(Object.entries(e.qv && typeof e.qv === "object" ? e.qv : {}).filter(([k, v]) => NET_VALUE_KEYS.test(k) && typeof v === "string" && /^[\w.,:-]{1,60}$/.test(v))),
    status: num(e.status),
    type: String(e.type || "").split(";")[0].trim().slice(0, 60),
    size: num(e.size),
    ms: num(e.ms),
    matched: !!e.matched,
    frames: num(e.frames),
    shape,
  };
}

/** Appends to a ring, oldest dropped first. */
export function appendRing(ring, entries, max = NETLOG_MAX) {
  const out = (ring || []).concat((entries || []).map(cleanEntry).filter(Boolean));
  return out.length > max ? out.slice(out.length - max) : out;
}

const fmtSize = (n) => (n == null ? "?" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Entries grouped by engine page → host + path pattern, busiest first, with
 * how many were captured, their kinds, methods, statuses, content types,
 * size range and the key names seen.
 */
export function groupNetlog(entries) {
  const engines = new Map();
  for (const e of entries || []) {
    const page = e.page || "?";
    if (!engines.has(page)) engines.set(page, new Map());
    const rows = engines.get(page);
    const qvs = Object.entries(e.qv || {}).sort().map(([k, v]) => `${k}=${v}`).join("&");
    const key = `${e.host}${e.path}?${qvs}`;
    if (!rows.has(key)) rows.set(key, { host: e.host, path: e.path, qvs, count: 0, matched: 0, kinds: new Set(), methods: new Set(), statuses: new Set(), types: new Set(), q: new Set(), min: null, max: null, forms: new Set(), keys: new Set(), last: 0 });
    const r = rows.get(key);
    r.count++;
    if (e.matched) r.matched++;
    r.kinds.add(e.kind); r.methods.add(e.method);
    if (e.status != null) r.statuses.add(e.status);
    if (e.type) r.types.add(e.type);
    (e.q || []).forEach((k) => r.q.add(k));
    if (e.size != null) { r.min = r.min == null ? e.size : Math.min(r.min, e.size); r.max = r.max == null ? e.size : Math.max(r.max, e.size); }
    if (e.shape) { r.forms.add(e.shape.form); (e.shape.keys || []).forEach((k) => { if (r.keys.size < 40) r.keys.add(k); }); }
    r.last = Math.max(r.last, e.t || 0);
  }
  return [...engines].map(([page, rows]) => ({
    page,
    total: [...rows.values()].reduce((n, r) => n + r.count, 0),
    rows: [...rows.values()].sort((a, b) => b.count - a.count || b.last - a.last).map((r) => ({
      host: r.host, path: r.path, qvs: r.qvs, count: r.count, matched: r.matched,
      kinds: [...r.kinds], methods: [...r.methods], statuses: [...r.statuses].sort(), types: [...r.types], q: [...r.q].sort(),
      size: r.min == null ? null : r.min === r.max ? fmtSize(r.min) : `${fmtSize(r.min)}–${fmtSize(r.max)}`,
      forms: [...r.forms], keys: [...r.keys],
    })),
  })).sort((a, b) => b.total - a.total);
}

/** The report's lines for the grouped table. */
export function netlogReportLines(entries, { maxRows = 40 } = {}) {
  const lines = [];
  const groups = groupNetlog(entries);
  lines.push(`Network seen on engine pages (Debug capture; ${entries.length} requests, newest ${NETLOG_MAX} kept)`);
  if (!groups.length) {
    lines.push("  Nothing recorded. Turn on Debug capture in Settings, reload the engine tab and ask a prompt.");
    return lines;
  }
  for (const g of groups) {
    lines.push(`  ${g.page} · ${g.total} requests`);
    g.rows.slice(0, maxRows).forEach((r) => {
      const bits = [
        `${r.count}×`,
        r.matched ? `captured ${r.matched}` : "not captured",
        r.kinds.join("/"),
        r.methods.join("/"),
        r.statuses.length ? `status ${r.statuses.join(",")}` : "",
        r.types.join(", "),
        r.size ? r.size : "",
      ].filter(Boolean);
      const keys = r.q.map((k) => (r.qvs && new RegExp(`(^|&)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`).test(r.qvs) ? r.qvs.split("&").find((x) => x.startsWith(`${k}=`)) : k));
      lines.push(`    ${r.host}${r.path}${keys.length ? `?${keys.join("&")}` : ""} · ${bits.join(" · ")}`);
      if (r.keys.length || r.forms.length) lines.push(`        starts as ${r.forms.join("/") || "?"}${r.keys.length ? `, keys: ${r.keys.join(", ")}` : ""}`);
    });
    if (g.rows.length > maxRows) lines.push(`    … ${g.rows.length - maxRows} more paths`);
  }
  return lines;
}
