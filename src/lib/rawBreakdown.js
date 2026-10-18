/*
 * rawBreakdown.js — the engine's raw response, laid out field by field (0.60.1).
 *
 * Researchers asked to read the raw payload under the prompt instead of a
 * download of a multi-megabyte stream. The hard part is that no schema can
 * be assumed: ChatGPT changed its stream twice in 2026 (the v1 delta
 * encoding, then generative-UI layout code), Gemini sends positional arrays
 * with JSON inside strings, Grok and Perplexity send whole JSON documents,
 * and which fields appear depends on the prompt (a shopping answer, a map,
 * an ad). So this never looks for known fields first. It:
 *
 *   1. reads the payload in whatever framing it has (server-sent events,
 *      Google's length-prefixed batches, JSON, JSON lines, HTML, text) into
 *      frames, decoding JSON that sits inside strings;
 *   2. turns every value into a path (ids in keys become {id}, array indexes
 *      become [], ChatGPT's patch ops are folded onto the path they patch), so
 *      a thousand deltas to one field read as one field with a count;
 *   3. sorts each path into a section by the most specific name it carries
 *      ("images" beats "componentResults", "url" alone says little), then by
 *      what its values look like (a web address, a price, long prose);
 *   4. leaves what it can't place in "Not recognised", with samples, so a
 *      new field shows up rather than being dropped or guessed at.
 *
 * Nothing here is an interpretation of the answer; it only says where the
 * engine put what. Field names can be labelled by the on-device model on
 * request (nano.js labelRawFields) — those labels are shown as guesses.
 */
import { PRICE_RE } from "./money.js";

const MAX_VALUE = 20000;   // one value, in full up to this
const MAX_SAMPLES = 50;    // distinct values kept per field
const MAX_JOINED = 200000; // streamed text put back together

export const SECTIONS = [
  { id: "request", label: "What was sent", note: "the request the page made" },
  { id: "answer", label: "Answer text", note: "the words of the answer and its markup" },
  { id: "model", label: "Model and settings", note: "model, experiments, account and client state" },
  { id: "stream", label: "Messages and stream", note: "message headers, roles, status, stream markers" },
  { id: "searches", label: "Searches", note: "queries the engine ran" },
  { id: "sources", label: "Sources and citations", note: "pages, links, references, citation spans" },
  { id: "shopping", label: "Products, places and images", note: "product listings, stores, prices, places, pictures" },
  { id: "ads", label: "Ads", note: "sponsored units" },
  { id: "layout", label: "Layout and components", note: "how the page draws the answer" },
  { id: "other", label: "Not recognised", note: "fields no rule here knows; samples shown so nothing is hidden" },
];

// Name rules, most specific first. Each is tried against one path segment.
const RULES = [
  ["ads", /^(ads?|ad_?units?|advertis\w*|sponsor\w*|promoted\w*)$/i],
  ["searches", /^(search_?queries|search_model_queries|queries|query|q|search_?terms?|fanout\w*|rewritten_?quer\w*|keywords?)$/i],
  ["shopping", /(^|_)(products?|merchants?|offers?|price\w*|rating|num_?reviews|reviews?|images?|image_urls|thumbnails?|thumbnail_url|content_url|places?|local_business|business\w*|address|phone\w*|hours|latitude|longitude|coordinates|map\w*|entity_data|shopping\w*|stores?|sellers?)$/i],
  ["sources", /(^|_)(search_results?|search_result_groups?|sources?|sources_footnote|citations?|cites?|cited\w*|content_references|refs?|ref_ids?|ref_type|ref_index|ref_id|attribution|snippet|pub_date|safe_urls|grounding\w*|web_?results|webpage_?urls|websearchresults|citedwebsearchresults|ragresults|links?|urls?|domain|favicon\w*)$/i],
  ["layout", /^(genui\w*|model_dil\w*|dil|componentresults|components?|tree_range|requiredcomponents|appdata|opgenui|render\w*|layout\w*|widgets?|card\w*|genui_attributes|recoverydiagnostics)$/i],
  ["answer", /^(parts|text|markdown|content|answer\w*|response_?text|final_?text|token|delta|chunks?|thoughts?|summary|message_?text)$/i],
  ["model", /(^|_)(model\w*|slug|default_model_slug|experiment\w*|ab_test\w*|plan_?type|cluster\w*|ste|server_ste_metadata|feature\w*|settings?|config\w*|locale|timezone\w*|client_contextual_info|useragent|limits_progress|is_\w+|warmup\w*|conduit\w*|ttfvt\w*)$/i],
  ["stream", /^(message|messages|author|role|name|channel|recipient|status|end_turn|create_time|update_time|weight|message_id|conversation_id|parent_message_id|parent_id|marker|message_marker|resume\w*|stream\w*|event|events|turn\w*|request_id|message_type|finish_reason|stop\w*|id|ids|o|p|c)$/i],
];
// Names that say too little on their own: "url" under "images" is an image.
const GENERIC = /^(\[\d*\]|\{id\}|url|title|name|value|type|id|ids|text|data|state|items?|v|metadata|status|entries|results?|label|description|payload|extraparams|action_payload|click_action|⟨json⟩|\d+)$/i;

const ID_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z]+_[0-9a-f]{8,}|\d{6,}|[A-Za-z0-9_-]{24,})$/;

/** Split a captured payload into frames of parsed values. */
export function parseRaw(raw) {
  const text = String(raw == null ? "" : raw).replace(/^﻿/, "");
  const body = text.split(/\r?\n/).filter((l) => !/^# /.test(l)).join("\n");
  const trimmed = body.trim();
  const frames = [];
  let format = "text";
  const tryJson = (s) => { try { return { ok: true, v: JSON.parse(s) }; } catch (_) { return { ok: false }; } };

  if (/^(?:event|data):/m.test(trimmed)) {
    format = "sse";
    let event = null;
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) { if (!line.trim()) event = null; continue; }
      const d = line.slice(5).trim();
      if (!d) continue;
      const j = tryJson(d);
      frames.push(j.ok ? { event, value: j.v } : { event, text: d });
    }
  } else if (/^\)\]\}'/.test(trimmed)) {
    format = "batched JSON (length-prefixed)";
    for (const line of trimmed.replace(/^\)\]\}'/, "").split(/\r?\n/)) {
      const l = line.trim();
      if (!l || /^\d+$/.test(l)) continue;
      const j = tryJson(l);
      frames.push(j.ok ? { value: j.v } : { text: l });
    }
  } else if (/^[[{]/.test(trimmed) && tryJson(trimmed).ok) {
    format = "JSON";
    frames.push({ value: JSON.parse(trimmed) });
  } else if (/^[[{]/.test(trimmed) && trimmed.split(/\r?\n/).filter(Boolean).every((l) => tryJson(l.trim()).ok)) {
    format = "JSON lines";
    for (const l of trimmed.split(/\r?\n/)) if (l.trim()) frames.push({ value: JSON.parse(l) });
  } else if (/^</.test(trimmed)) {
    format = "HTML";
    frames.push({ text: trimmed });
  } else if (trimmed) {
    frames.push({ text: trimmed });
  }
  return { format, frames, bytes: text.length };
}

const normSeg = (k) => (typeof k === "number" || /^\d+$/.test(k) && Number(k) > 999 ? "[]" : ID_KEY.test(k) ? "{id}" : k);
const patchPath = (p) => String(p).split("/").filter(Boolean).map((s) => (/^\d+$/.test(s) ? "[]" : normSeg(s)));
const isOp = (o) => o && typeof o === "object" && !Array.isArray(o) && "v" in o && Object.keys(o).every((k) => k === "p" || k === "o" || k === "v" || k === "c");
const looksJson = (s) => s.length > 1 && ((s[0] === "[" && s[s.length - 1] === "]") || (s[0] === "{" && s[s.length - 1] === "}"));

function classifyByValue(samples) {
  const s = samples.find((x) => typeof x === "string") || "";
  if (/^https?:\/\/\S+\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)|^https?:\/\/[^/]*(?:images\.openai\.com|gstatic\.com|googleusercontent\.com)\//i.test(s)) return "shopping";
  if (/^https?:\/\//i.test(s)) return "sources";
  if (s.length < 40 && PRICE_RE.test(s) && PRICE_RE.exec(s).index === 0) return "shopping";
  // Prose: long, or markdown, or several sentences' worth of words.
  if (samples.some((x) => typeof x === "string" && /[a-z]{2,}\s+[a-z]{2,}/i.test(x) && (x.length > 160 || /\*\*|^#{1,4} |\n/.test(x)))) return "answer";
  // Conversation, response and choice ids (Gemini's c_…, r_…, rc_…).
  if (/^(?:c|r|rc)_[0-9a-f]{8,}$/.test(s) || s === "wrb.fr") return "stream";
  return null;
}

/** The section a path belongs to: its most specific telling name, then its values. */
export function sectionOf(path, samples = []) {
  if (path === "(appended text)") return "answer";
  const segs = path.split(".");
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (!s || GENERIC.test(s)) continue;
    for (const [sec, re] of RULES) if (re.test(s)) return sec;
  }
  const byValue = classifyByValue(samples);
  if (byValue) return byValue;
  const leaf = segs[segs.length - 1] || "";
  if (/^(url|link)$/i.test(leaf)) return "sources";
  if (/^(title|name)$/i.test(leaf)) return "stream";
  return "other";
}

/**
 * @param {string} raw            the stored payload (as `get-raw` returns it)
 * @param {{ reqBody?: string, maxPaths?: number }} [opts]
 */
export function rawBreakdown(raw, opts = {}) {
  const maxPaths = opts.maxPaths || 1500;
  const parsed = parseRaw(raw);
  const paths = new Map();
  const types = new Map();
  let truncated = false;

  const note = (path, value, op, frame) => {
    let p = paths.get(path);
    if (!p) {
      if (paths.size >= maxPaths) { truncated = true; return; }
      p = { path, count: 0, kinds: new Set(), ops: new Set(), samples: [], distinct: new Set(), chars: 0, firstFrame: frame, longest: "", joined: "", empty: true };
      paths.set(path, p);
    }
    p.count++;
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    p.kinds.add(kind);
    if (op) p.ops.add(op);
    if (typeof value === "string") {
      p.chars += value.length;
      // Engines that resend the whole answer so far (Gemini) only show what
      // a field is in its longest value; the first ones are a few words.
      if (value.length > p.longest.length) p.longest = value.slice(0, MAX_VALUE);
      // Text streamed in pieces (ChatGPT's appends) reads whole only when
      // the pieces are put back together.
      if (op === "append" && p.joined.length < MAX_JOINED) p.joined += value;
    }
    if (!(value === null || value === "" || (Array.isArray(value) && !value.length) || (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length))) p.empty = false;
    // Every distinct value, in full (up to a cap), not the first three cut
    // at 140 characters: reported, the searches in the breakdown were cut
    // off, and a field with five queries showed three.
    if (kind !== "object" && kind !== "array" && value !== "") {
      const key = typeof value === "string" ? value.slice(0, 300) : String(value);
      if (!p.distinct.has(key) && p.distinct.size < 1000) {
        p.distinct.add(key);
        if (p.samples.length < MAX_SAMPLES) p.samples.push(typeof value === "string" && value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) + "…" : value);
      }
    }
  };

  const walk = (v, segs, op, frame, depth) => {
    if (depth > 40) return;
    if (isOp(v)) {
      // No "p": a bare string is text appended to the message being written;
      // anything else (a message header) is a value at the top.
      const base = typeof v.p === "string" ? patchPath(v.p) : typeof v.v === "string" ? ["(appended text)"] : segs;
      walk(v.v, base, v.o || (typeof v.p === "string" ? "set" : "append"), frame, depth + 1);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length && v.every(isOp)) { v.forEach((x) => walk(x, segs, op, frame, depth + 1)); return; }
      if (!v.length) note(segs.concat("[]").join(".") || "(root)", v, op, frame);
      // A list (every item the same kind) reads as one field, "[]". A tuple
      // (mixed kinds, as in Gemini's positional arrays) keeps its slot
      // numbers, which is how those payloads are read: slot 4 of slot 2.
      const kinds = new Set(v.map((x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x)));
      const tuple = kinds.size > 1 && v.length <= 64;
      v.forEach((x, i) => walk(x, segs.concat(tuple ? `[${i}]` : "[]"), op, frame, depth + 1));
      return;
    }
    if (v && typeof v === "object") {
      if (typeof v.type === "string" && v.type.length < 60) {
        const t = types.get(v.type) || { type: v.type, count: 0, at: segs.join(".") || "(root)" };
        t.count++;
        types.set(v.type, t);
      }
      const keys = Object.keys(v);
      if (!keys.length) note(segs.join(".") || "(root)", v, op, frame);
      for (const k of keys) walk(v[k], segs.concat(normSeg(k)), op, frame, depth + 1);
      return;
    }
    if (typeof v === "string" && looksJson(v.trim())) {
      try { walk(JSON.parse(v.trim()), segs.concat("⟨json⟩"), op, frame, depth + 1); return; } catch (_) { /* plain text */ }
    }
    note(segs.join(".") || "(root)", v, op, frame);
  };

  parsed.frames.forEach((f, i) => {
    if ("value" in f) walk(f.value, [], null, i, 0);
    else note(f.event ? `(event ${f.event} text)` : parsed.format === "HTML" ? "(html)" : "(text)", f.text, null, i);
  });

  const sections = SECTIONS.map((s) => ({ ...s, fields: [] }));
  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const p of paths.values()) {
    const sec = byId.get(sectionOf(p.path, p.longest ? [p.longest, ...p.samples] : p.samples)) || byId.get("other");
    const longest = p.longest && !p.samples.includes(p.longest) ? p.longest : null;
    const joined = p.joined && p.joined.length > p.longest.length ? p.joined : null;
    // Slots that never held anything are counted, not listed: Gemini sends
    // dozens of always-null positions in every frame.
    if (p.empty) { sec.emptyFields = (sec.emptyFields || 0) + 1; continue; }
    sec.fields.push({ path: p.path, count: p.count, kinds: [...p.kinds], ops: [...p.ops], samples: p.samples, distinct: p.distinct.size, longest, joined, chars: p.chars, firstFrame: p.firstFrame });
  }
  if (opts.reqBody) {
    const req = rawBreakdown(String(opts.reqBody), { maxPaths: 300 });
    byId.get("request").fields = req.sections.flatMap((s) => s.fields).map((f) => ({ ...f, path: f.path }));
  }
  for (const s of sections) s.emptyFields = s.emptyFields || 0;
  for (const s of sections) s.fields.sort((a, b) => a.firstFrame - b.firstFrame || a.path.localeCompare(b.path));

  const events = new Map();
  parsed.frames.forEach((f) => { if (f.event) events.set(f.event, (events.get(f.event) || 0) + 1); });
  return {
    format: parsed.format,
    bytes: parsed.bytes,
    frames: parsed.frames.length,
    events: [...events].map(([event, count]) => ({ event, count })),
    objectTypes: [...types.values()].sort((a, b) => b.count - a.count),
    fieldCount: paths.size,
    truncated,
    sections: sections.filter((s) => s.fields.length || s.emptyFields),
  };
}
