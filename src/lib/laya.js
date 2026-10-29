/*
 * laya.js — labels from Laya, a decision model, instead of a language model
 * writing JSON (0.83.0).
 *
 * The owner chose it (26 Oct) for the labels only: what an answer asks
 * (intent), its stage, who it's for, its market's reach, and for each brand
 * what it is and how the answer treats it. Laya reads the answer once per
 * question and gives a probability for each option, in a single pass of an
 * encoder (mmBERT-base, 22 layers): no text is generated, so nothing has to
 * be parsed or can be invented. Ask still uses a language model.
 *
 * The sequence each question becomes is ported line for line from the
 * model's own reference, rl_common.build_sequence and render_options in
 * convaiinnovations/laya (Apache-2.0), and rl_agent_api.system_one for how
 * an answer is read off the logits; test/laya.test.mjs checks it against the
 * Python on fixtures (test/tools/laya-ref.py).
 *
 * The multilingual checkpoint ships uncalibrated (temperature 1), so a
 * label is kept only above the thresholds below, and the rest are listed as
 * unsure. Pure: the tokenizer and the model run are passed in.
 */
import { INTENTS, AUDIENCES, FUNNEL, SCOPES, ENTITY_TYPES, STANCES } from "./aiValidate.js";
import { parsePrices } from "./money.js";

export const QTYPES = { choice: 0, score: 1, noul: 2 };
export const LAYA_VERSION = 1;
// Kept only when the top option has at least this probability and the
// answer distribution is at least this sure (1 − normalised entropy).
// Uncalibrated: measured on the owner's data before being trusted further.
export const MIN_P = 0.55;
export const MIN_CONFIDENCE = 0.3;
const MAX_BRANDS = 10;
const ANSWER_CHARS = 6000;

/* ---------- the reference, ported ---------- */

// Python's json.dumps(state, ensure_ascii=False): ", " and ": " between
// items, non-ASCII kept as is. JSON.stringify agrees on the escapes.
export function serializeState(state) {
  if (typeof state === "string") return state;
  const dump = (v) => {
    if (v === null || v === undefined) return "null";
    if (Array.isArray(v)) return `[${v.map(dump).join(", ")}]`;
    if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${dump(x)}`).join(", ")}}`;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v); // only strings are sent; ints agree with Python
    return JSON.stringify(String(v));
  };
  return dump(state);
}

/** Option texts in label order. A yes/no is always [false, true]. */
export function renderOptions(q) {
  const crit = q.crit;
  if (q.t === "choice") return Object.entries(crit).map(([k, v]) => (v ? `${k}: ${v}` : k));
  if (q.t === "score") return crit.map((c, i) => `level ${i}: ${c}`);
  const c = crit || {};
  return [`false: ${c.false || "no, the statement does not hold"}`, `true: ${c.true || "yes, the statement holds"}`];
}

/**
 * [CLS] <type> question: <ins> [SEP] [MASK] opt0 [MASK] opt1 … [SEP] state [SEP]
 * @param {{encode: (s: string) => number[], cls: number, sep: number, mask: number, maskToken: string}} tok
 * @returns {{ids: number[], markers: number[]}}
 */
export function buildSequence(tok, state, q, { maxLen = 1024, headMaxLen = 256, optionOrder = null, truncateLeft = false } = {}) {
  const mt = tok.maskToken;
  const strip = (s) => String(s).split(mt).join(" ");
  const opts = renderOptions(q);
  const order = optionOrder || opts.map((_, i) => i);
  const ins = strip(q.ins);
  let head = tok.encode(`${q.t} question: ${ins}`);
  let optIds = order.map((i) => [tok.mask, ...tok.encode(` ${strip(opts[i])}`).slice(0, 48)]);
  const sum = (a) => a.reduce((n, o) => n + o.length, 0);
  let budget = headMaxLen - sum(optIds);
  if (budget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    budget = headMaxLen - sum(optIds);
  }
  head = head.slice(0, Math.max(8, budget));
  let ids = [tok.cls, ...head, tok.sep];
  const markers = [];
  for (const o of optIds) { markers.push(ids.length); ids.push(...o); }
  ids.push(tok.sep);
  const room = Math.max(0, maxLen - ids.length - 1);
  let st = tok.encode(strip(serializeState(state)));
  st = truncateLeft ? (room ? st.slice(-room) : []) : st.slice(0, room);
  ids = [...ids, ...st, tok.sep];
  return { ids: ids.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
}

/** Jev's confidence: 1 − entropy / log(k). */
export function confidenceOf(p) {
  const k = p.length;
  if (k < 2) return 1;
  const ent = -p.reduce((s, x) => s + x * Math.log(Math.min(1, Math.max(x, 1e-12))), 0);
  return 1 - ent / Math.log(k);
}

/** The answer to one question from its logits, as system_one reads it. */
export function answerOf(logits, q, temperature = 1) {
  const z = Array.from(logits, (x) => x / temperature);
  const top = Math.max(...z);
  const e = z.map((x) => Math.exp(x - top));
  const s = e.reduce((a, b) => a + b, 0);
  const p = e.map((x) => x / s);
  if (q.t === "noul") return { type: "noul", noul: p[1], p };
  if (q.t === "score") return { type: "score", score: p.reduce((a, x, i) => a + i * x, 0), p, confidence: confidenceOf(p) };
  const keys = Object.keys(q.crit);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return { type: "choice", choice: keys[best], p: p[best], probabilities: Object.fromEntries(keys.map((k, i) => [k, p[i]])), confidence: confidenceOf(p) };
}

/* ---------- what CitoSkeleton asks ---------- */

// One line per option: Laya reads them like the question.
const INTENT_TEXT = {
  comparison: "comparing options or looking for alternatives",
  local: "looking for something nearby or in a place",
  price_value: "about price, cost, deals or value for money",
  trust: "about safety, trust, reliability or compliance",
  careers: "about jobs, hiring, salaries or careers",
  howto: "how to do something, or what something is",
  for_use: "the best fit for a particular person or use",
  best_top: "asking for the best or top choices, or reviews",
  other: "none of these",
};
const FUNNEL_TEXT = {
  awareness: "learning about the topic, not choosing yet",
  consideration: "weighing a few options",
  decision: "ready to pick or buy one",
  post_purchase: "already has it: using, fixing or complaining",
};
const AUDIENCE_TEXT = {
  consumer: "a person buying for themselves or their home",
  business: "a company or a professional",
  public_sector: "a government body, school or public service",
  mixed: "people and companies alike",
};
const SCOPE_TEXT = {
  local: "one city or area",
  national: "one country",
  regional: "a few countries or a region",
  global: "anywhere in the world",
};
const TYPE_TEXT = {
  brand: "a company or brand",
  product: "a product or model",
  retailer: "a shop or marketplace that sells things",
  publisher: "a website, magazine or reviewer",
  institution: "a public body, school or organisation",
  place: "a place",
  person: "a person",
  other: "something else",
};
const STANCE_TEXT = {
  recommended: "recommended, or put first",
  positive: "spoken of well",
  neutral: "described without praise or criticism",
  negative: "criticised",
  advised_against: "the reader is told to avoid it",
  mentioned: "only named in passing",
};
const pick = (keys, text) => Object.fromEntries(keys.map((k) => [k, text[k] || null]));

/** The questions for one answer: four about it, two per brand. */
export function layaQuestions(rec) {
  const answer = String(rec.answerText || "").slice(0, ANSWER_CHARS);
  const state = { prompt: String(rec.userPrompt || ""), answer };
  const qs = [
    { id: "intent", t: "choice", ins: "What does the person's prompt ask for?", crit: pick(INTENTS, INTENT_TEXT), state },
    { id: "funnel", t: "choice", ins: "How far along is the person who asked, in choosing?", crit: pick(FUNNEL, FUNNEL_TEXT), state },
    { id: "audience", t: "choice", ins: "Who is the answer written for?", crit: pick(AUDIENCES, AUDIENCE_TEXT), state },
    { id: "scope", t: "choice", ins: "Where does the answer apply?", crit: pick(SCOPES, SCOPE_TEXT), state },
  ];
  const brands = [...(rec.brandMentions || [])].filter((m) => m && m.brand)
    .sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15)).slice(0, MAX_BRANDS);
  for (const m of brands) {
    const passages = (m.passages || []).filter(Boolean).slice(0, 3);
    const bstate = { name: m.brand, prompt: state.prompt, passages: passages.length ? passages : [answer.slice(0, 1200)] };
    qs.push({ id: `type:${m.brand}`, brand: m.brand, field: "type", t: "choice", ins: `In the answer, what is "${m.brand}"?`, crit: pick(ENTITY_TYPES, TYPE_TEXT), state: bstate });
    qs.push({ id: `stance:${m.brand}`, brand: m.brand, field: "stance", t: "choice", ins: `How does the answer treat "${m.brand}"?`, crit: pick(STANCES, STANCE_TEXT), state: bstate, passages });
  }
  return qs;
}

const sure = (a) => a && a.p >= MIN_P && a.confidence >= MIN_CONFIDENCE;

/**
 * Label one answer.
 * @param {object} rec a derived record
 * @param {(items: {ids: number[], markers: number[], qtype: number}[]) => Promise<{logits: number[][], ms?: number}>} run
 * @param {{tok, model?: string, maxLen?: number, headMaxLen?: number, temperature?: number[]}} opts
 */
export async function layaCheckRecord(rec, run, opts = {}) {
  const text = String(rec.answerText || "");
  const checks = { calls: 0, ms: 0, questions: 0, unsure: [], dropped: [] };
  const out = { v: LAYA_VERSION, source: "laya", model: opts.model || "Laya", at: Date.now() };
  if (!text.trim()) return { ...out, empty: true, checks };
  const qs = layaQuestions(rec);
  const items = [];
  for (const q of qs) {
    const seq = buildSequence(opts.tok, q.state, q, { maxLen: opts.maxLen || 1024, headMaxLen: opts.headMaxLen || 256 });
    // Options that didn't fit would be a different question: skipped.
    if (seq.markers.length !== renderOptions(q).length) { checks.dropped.push({ what: q.id, why: "options did not fit" }); continue; }
    items.push({ q, ...seq, qtype: QTYPES[q.t] });
  }
  const r = await run(items.map(({ ids, markers, qtype }) => ({ ids, markers, qtype })));
  checks.calls++;
  checks.ms += (r && r.ms) || 0;
  checks.questions = items.length;
  const temps = opts.temperature || [1, 1, 1];
  const entities = new Map();
  items.forEach((it, i) => {
    const a = answerOf(r.logits[i].slice(0, it.markers.length), it.q, temps[it.qtype] || 1);
    const label = { value: a.choice, p: round(a.p), confidence: round(a.confidence) };
    if (!sure(a)) { checks.unsure.push({ what: it.q.id, ...label }); return; }
    if (!it.q.brand) {
      if (it.q.id === "scope") out.market = { country: null, currency: null, scope: a.choice, evidence: [] };
      else out[it.q.id] = a.choice;
      (out.labels = out.labels || {})[it.q.id] = label;
      return;
    }
    const e = entities.get(it.q.brand) || { name: it.q.brand };
    e[it.q.field] = a.choice;
    e[`${it.q.field}P`] = label.p;
    // The quote is the answer's own text where the rules found the brand
    // (their passages have the spacing folded, so they are found again
    // here); Laya picks the label, never the words.
    if (it.q.field === "stance" && a.choice !== "mentioned") {
      const quote = (it.q.passages || []).map((p) => spanIn(text, p)).find(Boolean);
      if (quote) e.quote = quote;
    }
    entities.set(it.q.brand, e);
  });
  // Facts the rules already know exactly, beside Laya's labels.
  if (rec.answerLang) out.lang = rec.answerLang;
  const currencies = [...new Set(parsePrices(text).map((p) => p.currency).filter(Boolean))];
  if (currencies.length === 1) out.market = { ...(out.market || { country: null, scope: null, evidence: [] }), currency: currencies[0] };
  // A brand appears only with a label Laya was sure of; an unsure one is
  // left unlabelled rather than called "other" or "mentioned".
  out.entities = [...entities.values()].filter((e) => e.type || e.stance);
  out.missed = [];
  out.checks = checks;
  return out;
}
const round = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Where a passage sits in the answer, as the answer writes it: its words in
 * order with any spacing between them. The first 30 words are enough to
 * place it. Null when it isn't there.
 */
export function spanIn(text, passage) {
  const words = String(passage || "").trim().split(/\s+/).filter(Boolean).slice(0, 30);
  if (!words.length) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(words.map(esc).join("\\s+"), "u").exec(String(text || ""));
  return m ? m[0] : null;
}
