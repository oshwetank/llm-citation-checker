/*
 * nanoEngine.js — Chrome's own built-in AI (Gemini Nano, the Prompt API) as
 * an engine for the checks and for Ask (0.74.0).
 *
 * Where Chrome has it, it is the fastest choice: it runs on the graphics
 * chip, Chrome downloads and manages it (nothing for us to download), and it
 * can hold a reply to a JSON schema, so no output is spent on prose or
 * broken JSON. It takes the same {messages, maxTokens, schema, tools} as the
 * Qwen engine (lib/llmEngine.js), so lib/aiCheck.js and lib/assistant.js
 * don't know which one answered.
 *
 * Chrome only; every call is guarded, and "not there" is just "use the
 * other engine". The surface is resolved the way lib/nano.js does it.
 */
const TIMEOUT_MS = 90 * 1000;

export function languageModel(g = globalThis) {
  if (typeof g.LanguageModel !== "undefined") return g.LanguageModel;
  if (g.chrome && g.chrome.languageModel) return g.chrome.languageModel;
  return null;
}

/** "available" | "downloadable" | "downloading" | "unavailable" */
export async function nanoAvailability(g = globalThis) {
  try {
    const lm = languageModel(g);
    if (!lm || typeof lm.availability !== "function") return "unavailable";
    const a = await lm.availability();
    if (a === "readily") return "available";
    if (a === "after-download") return "downloadable";
    if (a === "no") return "unavailable";
    return String(a || "unavailable");
  } catch (_) { return "unavailable"; }
}

/**
 * Ask Chrome to fetch its model (it is shared by every site and extension).
 * Resolves when it is ready; progress 0–1 goes to onProgress.
 */
export async function nanoDownload({ onProgress } = {}, g = globalThis) {
  const lm = languageModel(g);
  if (!lm) throw new Error("Chrome's built-in AI isn't in this browser.");
  const s = await lm.create({
    monitor(m) { try { m.addEventListener("downloadprogress", (e) => onProgress && onProgress(Number(e.loaded) || 0)); } catch (_) { /* older surface */ } },
  });
  try { s.destroy && s.destroy(); } catch (_) { /* gone */ }
  return { ok: true };
}

// Tools (Ask) written into the instructions: the Prompt API has no tool
// parameter, so the model is told the tools and the reply shape that
// lib/assistant.js already reads (<tool_call>{"name","arguments"}</tool_call>).
export function toolText(tools) {
  if (!tools || !tools.length) return "";
  const lines = tools.map((t) => {
    const f = t.function || t;
    const params = Object.entries((f.parameters && f.parameters.properties) || {}).map(([k, v]) => `${k}${(f.parameters.required || []).includes(k) ? "" : "?"}: ${v.type || "string"}${v.enum ? ` (${v.enum.join("|")})` : ""}`).join(", ");
    return `- ${f.name}(${params}): ${f.description}`;
  });
  return [
    "",
    "You can look things up with these tools:",
    ...lines,
    "To use one, reply with only: <tool_call>{\"name\": \"tool_name\", \"arguments\": {…}}</tool_call> (several such lines for several tools). You will get the results back. When you have what you need, reply with the answer itself, no tool_call.",
  ].join("\n");
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Chrome's built-in AI took too long (${what})`)), ms); })]).finally(() => clearTimeout(t));
}

// One base session per system prompt, cloned for each reply so the system
// prompt is processed once, not on every call.
const bases = new Map();
async function baseFor(lm, system) {
  if (bases.has(system)) return bases.get(system);
  const p = lm.create({ initialPrompts: system ? [{ role: "system", content: system }] : [] });
  bases.set(system, p);
  p.catch(() => bases.delete(system));
  if (bases.size > 4) { const [k, v] = bases.entries().next().value; bases.delete(k); v.then((s) => s.destroy && s.destroy()).catch(() => {}); }
  return p;
}

// Is this a whole JSON value yet? (outside strings, every bracket closed)
function jsonClosed(t) {
  let depth = 0, inStr = false, esc = false, began = false;
  for (const ch of t) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") inStr = true;
    else if (ch === "{" || ch === "[") { depth++; began = true; }
    else if (ch === "}" || ch === "]") { depth--; if (began && depth === 0) return true; }
  }
  return false;
}

/*
 * A reply read as it streams (1.0.0). The owner's computer ran out of the
 * 90 s on all four answers, and what the model had written by then was
 * thrown away. Read as it comes, the reply stops being read when the JSON
 * closes or passes its budget, and on time running out what arrived is kept
 * (aiCheck.parseJson closes a cut-off reply).
 */
async function promptCapped(session, input, opts, capChars, limitMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  let acc = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, limitMs);
  try {
    const stream = session.promptStreaming(input, { ...opts, signal: ctl.signal });
    const reader = stream.getReader ? stream.getReader() : null;
    const next = reader ? () => reader.read() : (() => { const it = stream[Symbol.asyncIterator](); return () => it.next(); })();
    for (;;) {
      const { value, done } = await next();
      if (done) break;
      const c = String(value || "");
      // Older Chrome streams the whole text so far; newer, each new piece.
      acc = acc && c.length > acc.length && c.startsWith(acc) ? c : acc + c;
      if (acc.length >= capChars || jsonClosed(acc)) { ctl.abort(); break; }
    }
  } catch (e) {
    if (!acc) throw timedOut ? new Error("Chrome's built-in AI took too long (replying)") : e;
  } finally { clearTimeout(timer); }
  return acc;
}

/**
 * One reply.
 * @param {{messages: {role: string, content: string}[], maxTokens?: number, schema?: object, tools?: object[]}} o
 */
export async function nanoGenerate(o, g = globalThis) {
  const lm = languageModel(g);
  if (!lm) throw new Error("Chrome's built-in AI isn't in this browser.");
  const msgs = (o.messages || []).map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.role === "tool" ? `Tool result:\n${m.content}` : String(m.content || "") }));
  let system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  if (o.tools) system += toolText(o.tools);
  const rest = msgs.filter((m) => m.role !== "system");
  const last = rest.pop();
  const t0 = Date.now();
  const base = await withTimeout(baseFor(lm, system), TIMEOUT_MS, "starting");
  const session = typeof base.clone === "function" ? await base.clone() : base;
  try {
    // Earlier turns (Ask's conversation, tool results) go in as history.
    if (rest.length && typeof session.append === "function") await session.append(rest);
    else if (rest.length) last.content = rest.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") + `\n\nUSER: ${last.content}`;
    const opts = {};
    if (o.schema && !o.tools) { opts.responseConstraint = o.schema; opts.omitResponseConstraintInput = true; }
    const input = last ? last.content : "";
    const capChars = o.maxTokens ? Math.max(600, o.maxTokens * 5) : 0;
    const once = (op) => (capChars && typeof session.promptStreaming === "function"
      ? promptCapped(session, input, op, capChars, o.timeoutMs || TIMEOUT_MS)
      : withTimeout(session.prompt(input, op), o.timeoutMs || TIMEOUT_MS, "replying"));
    let text;
    try { text = await once(opts); } catch (e) {
      // A Chrome that can't hold to this shape (a keyword it doesn't know)
      // still answers without it; the reply is checked the same way after.
      if (!opts.responseConstraint || /took too long/.test(String(e && e.message))) throw e;
      text = await once({});
    }
    return { text: String(text || ""), ms: Date.now() - t0 };
  } finally {
    if (session !== base) { try { session.destroy && session.destroy(); } catch (_) { /* gone */ } }
  }
}

/** Forget the cached sessions (tests; or Chrome's model changed). */
export function nanoReset() {
  for (const p of bases.values()) p.then((s) => s.destroy && s.destroy()).catch(() => {});
  bases.clear();
}
