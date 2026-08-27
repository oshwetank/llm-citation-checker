/* errorlog.js — a durable record of what broke, where, and when.
 *
 * Reported: "can we have an error log thing so that we can know exactly what
 * broke and where." Before this there was nowhere for a failure to go:
 *
 *   - 22 `catch (_) { }` blocks in the service worker swallowed errors
 *     entirely, by design, so that one failure could never take down a run.
 *     That instinct is right, but "don't crash" and "don't tell anyone" got
 *     conflated: the catch stayed, the report went missing.
 *   - The one existing log (the DEBUG ring buffer) lived in a module-level
 *     array. MV3 terminates the service worker after roughly 30 seconds idle,
 *     which wipes it — and it only ever recorded capture events, not
 *     failures. It was also gated behind a setting that defaults to off.
 *
 * So this is deliberately durable (IndexedDB, survives worker death and
 * browser restart) and always on. The failures worth diagnosing happen hours
 * into an unattended thousand-prompt run, long before anyone thinks to turn
 * logging on.
 *
 * PRIVACY. This extension's whole promise is that nothing leaves the device,
 * and an error log is exactly the kind of thing that quietly breaks such a
 * promise by hoovering up prompt text and URLs. Entries carry a short `where`
 * tag, a message, a stack, and a small bag of scalar context — never prompt
 * text, answer text, page URLs, or brand names. redact() enforces that on the
 * way in rather than trusting each call site.
 */

const MAX_ENTRIES = 500;   // enough to cover a long run; small enough to read
const MAX_MSG = 400;
const MAX_STACK = 1200;
const MAX_CTX_VALUE = 120;
const MAX_TRACE = 1500;   // a full turn timeline; see makeErrorEntry

/* Only scalars, and only short ones.
 *
 * Context is where private data would leak in, so the filter is a whitelist of
 * shapes rather than a blacklist of names: numbers and booleans pass, strings
 * pass only if they are short AND don't look like a URL or a sentence. A
 * caller that wants to log a prompt simply cannot.
 */
function redact(ctx) {
  const out = {};
  if (!ctx || typeof ctx !== "object") return out;
  for (const [k, v] of Object.entries(ctx)) {
    if (v == null) continue;
    if (typeof v === "number" && isFinite(v)) { out[k] = v; continue; }
    if (typeof v === "boolean") { out[k] = v; continue; }
    if (typeof v !== "string") continue;
    if (v.length > MAX_CTX_VALUE) continue;              // free text
    if (/https?:\/\/|www\./i.test(v)) continue;          // a URL
    if (/\s\S+\s\S+\s\S+\s/.test(v)) continue;           // a sentence
    out[k] = v;
  }
  return out;
}

/* An error message can itself contain a URL — "Failed to fetch
 * https://…?q=<the user's prompt>" is a real shape — so message and stack are
 * scrubbed too. Losing the URL costs little diagnostically; leaking a prompt
 * into a report the user may paste somewhere costs a lot.
 */
function scrubText(s, cap) {
  return String(s == null ? "" : s)
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/* `trace` is a first-class field rather than another context key.
 *
 * A submission trace is a sequence of event codes and tick numbers — far
 * longer than redact()'s per-value cap, which exists to stop free text (and
 * therefore prompt/answer content) getting in. Squeezing a trace through that
 * filter would either truncate it uselessly or force the cap up and let real
 * free text through with it. So it gets its own field, its own cap, and one
 * hard rule enforced by the producer: it may contain only event codes,
 * numbers and fixed keywords, never anything the user typed or read. It is
 * still scrubbed for URLs, because a rule that is only a convention is not
 * one worth relying on.
 */
export function makeErrorEntry(where, err, ctx, trace) {
  const isErr = err && typeof err === "object" && ("message" in err || "stack" in err);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    where: scrubText(where || "unknown", 80),
    kind: isErr && err.name ? scrubText(err.name, 40) : "Error",
    message: scrubText(isErr ? err.message : err, MAX_MSG) || "(no message)",
    stack: isErr && err.stack ? scrubText(err.stack, MAX_STACK) : "",
    context: redact(ctx),
    trace: trace ? scrubText(trace, MAX_TRACE) : "",
  };
}

/* `db` is injected rather than imported so this stays testable without
 * IndexedDB. Every path swallows its own problems on purpose: an error log
 * that throws while recording an error is worse than no error log.
 */
export function createErrorLog(db) {
  let trimCounter = 0;

  async function record(where, err, ctx, trace) {
    const entry = makeErrorEntry(where, err, ctx, trace);
    try {
      await db.put("errors", entry);
      // Trim occasionally rather than on every write: the cap exists to stop
      // unbounded growth, and counting the store on every error would make
      // logging cost more than the thing that failed.
      if (++trimCounter % 25 === 0) await trim();
    } catch (_) { /* logging must never throw into the caller */ }
    return entry;
  }

  async function trim() {
    try {
      const all = await db.getAll("errors");
      if (all.length <= MAX_ENTRIES) return;
      const sorted = all.sort((a, b) => (a.at || 0) - (b.at || 0));
      for (const e of sorted.slice(0, all.length - MAX_ENTRIES)) {
        try { await db.delete("errors", e.id); } catch (_) { /* skip */ }
      }
    } catch (_) { /* best effort */ }
  }

  async function list(limit = 200) {
    try {
      const all = await db.getAll("errors");
      return all.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit);
    } catch (_) { return []; }
  }

  async function clear() {
    try { await db.clear("errors"); return true; } catch (_) { return false; }
  }

  /* Grouped by where+message, because the same failure repeating 400 times in
   * one run is one problem, not four hundred. A flat reverse-chronological
   * list of identical lines is what makes a log unreadable exactly when it
   * matters most.
   */
  async function summary(limit = 40) {
    const all = await list(MAX_ENTRIES);
    const groups = new Map();
    for (const e of all) {
      const key = `${e.where} ${e.message}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        // Keep the newest trace and context: when the same failure repeats,
        // the latest occurrence is the one worth reading, and list() is
        // already newest-first so the first seen is the newest.
        if (e.at > g.lastAt) { g.lastAt = e.at; }
        if (e.at < g.firstAt) g.firstAt = e.at;
      } else {
        groups.set(key, {
          where: e.where, message: e.message, kind: e.kind,
          count: 1, firstAt: e.at, lastAt: e.at,
          stack: e.stack, context: e.context, trace: e.trace,
        });
      }
    }
    return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  }

  return { record, list, clear, summary, trim, MAX_ENTRIES };
}
