/*
 * captureHealth.js — the capture check (0.73.1).
 *
 * "If the basic working of the tool is not there everything else is scrap":
 * a question asked on an engine and never captured left no trace anywhere,
 * so neither the owner nor anyone helping could tell which step failed. This
 * keeps, per engine, the last few things that happened on the way from the
 * page to the store — a conversation request seen, an event stream it didn't
 * recognise, a capture stored, a capture dropped and why — and turns them,
 * with what each open engine tab says about itself, into a report.
 *
 * Only addresses with ids masked, content types, counts, times and reasons.
 * Never a prompt, an answer or a query value.
 */

export const ENGINES = ["chatgpt", "gemini", "perplexity", "grok"];
const KEEP = 8;

export function emptyHealth() {
  return Object.fromEntries(ENGINES.map((e) => [e, { conv: null, stored: null, unknown: [], drops: [] }]));
}

const push = (list, row) => [row, ...list.filter((r) => !(r.reason === row.reason && r.path === row.path && r.ev === row.ev))].slice(0, KEEP);

/**
 * One event in. Returns a new state.
 * @param {object} state
 * @param {string} engine
 * @param {{kind: "conv"|"unknown"|"stored"|"drop", at?: number, path?: string, method?: string, ctype?: string, ev?: string, reason?: string, captureId?: string}} e
 */
export function noteHealth(state, engine, e) {
  const s = state && typeof state === "object" ? { ...emptyHealth(), ...state } : emptyHealth();
  if (!ENGINES.includes(engine) || !e) return s;
  const cur = { conv: null, stored: null, unknown: [], drops: [], ...(s[engine] || {}) };
  const at = e.at || Date.now();
  if (e.kind === "conv") cur.conv = { at, path: e.path || "", method: e.method || "", status: e.status || 0 };
  else if (e.kind === "unknown") cur.unknown = push(cur.unknown, { at, ev: e.ev || "stream-unknown", path: e.path || "", method: e.method || "", ctype: e.ctype || "" });
  else if (e.kind === "stored") cur.stored = { at, captureId: e.captureId || "" };
  else if (e.kind === "drop") cur.drops = push(cur.drops, { at, reason: e.reason || "unknown", path: e.path || "" });
  return { ...s, [engine]: cur };
}

const REASON = {
  paused: "Capture is paused (the switch at the top). Turn it back on.",
  "too-large": "The answer was bigger than the size limit in Settings → Data.",
  empty: "The extension got the reply but found no prompt, answer or sources in it — the engine may have changed how it sends answers.",
  "no-marker": "The page's link to the extension was lost. Refresh the tab.",
  "marker-mismatch": "The page's link to the extension was lost. Refresh the tab.",
  error: "Reading the reply failed (see the error log).",
  noise: "The request was not an answer (autocomplete, sign-in, notifications).",
};
export const reasonText = (r) => REASON[r] || r;

/**
 * What to tell the owner for one engine, from its record and its open tabs.
 * @returns {{engine: string, status: "ok"|"warn"|"bad"|"idle", line: string}}
 */
export function verdict(engine, h, tabs = [], { paused = false } = {}) {
  const rec = h || {};
  const open = tabs.filter((t) => t.engine === engine);
  const dead = open.filter((t) => !t.alive);
  const lastDrop = (rec.drops || [])[0];
  const stored = rec.stored && rec.stored.at;
  const conv = rec.conv && rec.conv.at;
  if (paused) return { engine, status: "bad", line: REASON.paused };
  if (dead.length) return { engine, status: "bad", line: `${dead.length === 1 ? "An open tab is" : `${dead.length} open tabs are`} cut off from the extension (it was reloaded or turned off and on). Refresh ${dead.length === 1 ? "it" : "them"}.` };
  if (open.some((t) => t.alive && !t.marker)) return { engine, status: "bad", line: REASON["no-marker"] };
  if (lastDrop && (!stored || lastDrop.at > stored)) return { engine, status: "bad", line: `Last answer not saved: ${reasonText(lastDrop.reason)}` };
  if (conv && (!stored || conv > stored + 60000)) return { engine, status: "warn", line: "A question went out but no answer has been saved since. If this stays, copy the report and send it." };
  const unknown = (rec.unknown || []).filter((u) => u.ev === "stream-unknown");
  if (!stored && unknown.length) return { engine, status: "warn", line: `Saw ${unknown.length} reply stream${unknown.length === 1 ? "" : "s"} it doesn't recognise, and no answer saved yet.` };
  if (stored) return { engine, status: "ok", line: "Capturing. Last answer saved " + ago(stored) + "." };
  return { engine, status: "idle", line: open.length ? "Tab open and connected. Ask a question there, then check again." : "No tab open. Open the engine, ask a question, then check again." };
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The plain-text report the owner copies and sends. */
export function healthReport({ version, health, tabs = [], paused = false, counts = {}, retentionMax = null, at = Date.now() }) {
  const t = (x) => (x ? new Date(x).toISOString().replace(/\.\d+Z$/, "Z") : "—");
  const lines = [`CitoSkeleton capture check · v${version || "?"} · ${t(at)}`, `paused: ${paused ? "yes" : "no"} · stored: ${counts.derived ?? "?"} answers (${counts.manual ?? "?"} asked by hand) · keep: ${retentionMax ?? "?"}`];
  for (const e of ENGINES) {
    const h = (health || {})[e] || {};
    const v = verdict(e, h, tabs, { paused });
    lines.push("", `## ${e} — ${v.status}: ${v.line}`);
    for (const tab of tabs.filter((x) => x.engine === e)) {
      lines.push(`tab ${tab.url || ""}: ${tab.alive ? "connected" : "NOT connected"}${tab.alive ? ` · marker ${tab.marker ? "ok" : "MISSING"} · requests seen ${tab.conv || 0} · handed over ${tab.forwarded || 0} · send failures ${tab.sendFailed || 0}${tab.mismatched ? ` · dropped for marker ${tab.mismatched}` : ""} · open ${Math.round((tab.ageMs || 0) / 60000)} min` : ""}`);
      if (tab.lastError) lines.push(`  last error: ${tab.lastError}`);
    }
    lines.push(`last conversation request: ${h.conv ? `${h.conv.method} ${h.conv.path} (${h.conv.status || "?"}) at ${t(h.conv.at)}` : "none"}`);
    lines.push(`last answer saved: ${h.stored ? t(h.stored.at) : "none"}`);
    for (const d of h.drops || []) lines.push(`dropped: ${d.reason}${d.path ? ` ${d.path}` : ""} at ${t(d.at)}`);
    for (const u of h.unknown || []) lines.push(`${u.ev === "stream-taken" ? "stream taken (unfamiliar address)" : "stream not recognised"}: ${u.method} ${u.path} [${u.ctype}] at ${t(u.at)}`);
  }
  return lines.join("\n");
}
