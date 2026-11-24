/*
 * passages.js — searching inside answers (1.0.5, Stage 3 of
 * ASK-ARCHITECTURE.md §4.7).
 *
 * Each answer is split into passages (a paragraph, a list item, a table
 * row), each tagged with its capture, campaign, run, prompt, engine and date.
 * Keyword search is BM25 over words cut by Intl.Segmenter, so Hindi,
 * Arabic and the rest are split properly, with accents folded, a light
 * English stem (plurals, -ing, -ed) and typo tolerance: a word that appears
 * nowhere is matched to the closest word that does. Every word of the query
 * must be in a passage (as the Dashboard always required); ranking puts the
 * best passages first. When the optional "search by meaning" model is on,
 * its ranking is merged with the keyword one by Reciprocal Rank Fusion
 * (k = 60), so "long-lasting charge" finds "battery". Filters (the scope)
 * apply before ranking, so other campaigns' passages never compete.
 *
 * No imports beyond the sanitiser: the service worker loads it.
 */
import { sanitizeText } from "./text-sanitize.js";

const K1 = 1.2, B = 0.75, RRF_K = 60;
const MAX_PASSAGE = 700;

/** Answer text without citation markers, markdown links or extra spaces, keeping line breaks. */
export function plainText(text) {
  const s = String(text || "").replace(/[^]*/g, "").replace(/\[\[cite:[^\]]*\]\]/g, "");
  // Line by line: the sanitiser folds line breaks, and they mark passages.
  return s.split(/\r?\n/).map((l) => (l.trim() ? sanitizeText(l).replace(/[ \t]+/g, " ") : "")).join("\n");
}

/** An answer as passages: paragraphs, list items and table rows; long ones cut at sentences. */
export function splitPassages(text) {
  const out = [];
  const push = (t) => {
    const s = t.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/, "").replace(/\|/g, " ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (s.length < 3 || /^[-:\s]+$/.test(s)) return;
    if (s.length <= MAX_PASSAGE) { out.push(s); return; }
    let cur = "";
    for (const sent of s.split(/(?<=[.!?।؟])\s+/)) {
      if (cur && (cur + " " + sent).length > MAX_PASSAGE) { out.push(cur); cur = sent; } else cur = cur ? `${cur} ${sent}` : sent;
    }
    if (cur) out.push(cur.slice(0, MAX_PASSAGE * 2));
  };
  let para = [];
  const flush = () => { if (para.length) { push(para.join(" ")); para = []; } };
  for (const line of plainText(text).split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*•]|\d+[.)])\s+|^\s*\|/.test(line) || /^#{1,6}\s/.test(line)) { flush(); push(line); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

let segmenter = null;
try { segmenter = new Intl.Segmenter(undefined, { granularity: "word" }); } catch (_) { segmenter = null; }
const STOP = new Set("the a an and or of in on for to is are was were be it its this that with as at by from about which what how who do does did i you we they he she my our your their me us them not no but if so than then there here can will would should could".split(" "));
const fold = (w) => w.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
/** A light stem for Latin-script words: plurals, -ing, -ed. */
export function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (/[^s]s$/.test(w) && !/(us|is|ss)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
/** A text's search terms. */
export function terms(text, { keepStop = false } = {}) {
  const out = [];
  const s = String(text || "");
  const words = segmenter ? [...segmenter.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment) : s.split(/[^\p{L}\p{N}]+/u);
  for (const w of words) {
    const f = fold(w);
    if (!f || (!keepStop && STOP.has(f))) continue;
    out.push(stem(f));
  }
  return out;
}

/**
 * The index for a set of stored records.
 * @param {object[]} records
 * @param {(r: object) => object} [meta] extra fields per passage (collection, run…)
 */
export function buildIndex(records, meta = () => ({})) {
  const docs = [];
  const df = new Map();
  let total = 0;
  for (const r of records || []) {
    if (!r || !r.answerText) continue;
    // The question too, marked: Ask searches it ("what did I ask about…");
    // the Dashboard's Answers search leaves it out (it searches prompts itself).
    const ps = splitPassages(r.answerText);
    if (r.userPrompt) ps.push({ prompt: true, text: String(r.userPrompt).replace(/s+/g, " ").trim().slice(0, MAX_PASSAGE) });
    ps.forEach((p, i) => {
      const text = typeof p === "string" ? p : p.text;
      const isPrompt = typeof p !== "string";
      const ts = terms(text);
      if (!ts.length) return;
      const tf = new Map();
      for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      total += ts.length;
      docs.push({ id: `${r.captureId}#${isPrompt ? "q" : i}`, captureId: r.captureId, i, text, isPrompt, len: ts.length, tf, engine: r.platform, at: r.capturedAt || 0, prompt: r.userPrompt || "", ...meta(r) });
    });
  }
  return { docs, df, avgLen: docs.length ? total / docs.length : 1, vocab: [...df.keys()], vectors: null };
}

// The cached index for the stored records: rebuilt when they change.
let cache = { sig: null, index: null };
/** An index for these records, reused while they are the same set. */
export function indexFor(records, meta) {
  const sig = `${(records || []).length}:${(records || []).reduce((m, r) => Math.max(m, r.capturedAt || 0, r.reprocessedAt || 0), 0)}`;
  if (cache.sig !== sig) cache = { sig, index: buildIndex(records, meta) };
  return cache.index;
}

const trigrams = (s) => { const t = ` ${s} `; const o = new Set(); for (let i = 0; i < t.length - 2; i++) o.add(t.slice(i, i + 3)); return o; };
function closest(word, vocab) {
  if (word.length < 4) return null;
  const A = trigrams(word);
  let best = null, bs = 0;
  for (const v of vocab) {
    if (Math.abs(v.length - word.length) > 2) continue;
    const Bv = trigrams(v);
    let n = 0; for (const x of A) if (Bv.has(x)) n++;
    const s = n / (A.size + Bv.size - n);
    if (s > bs) { bs = s; best = v; }
  }
  return bs >= 0.45 ? best : null;
}

/** The query as index terms, typos mapped to the nearest real word. */
export function queryTerms(index, query) {
  const out = [];
  for (const t of new Set(terms(query))) {
    if (index.df.has(t)) { out.push({ term: t, from: t }); continue; }
    const c = closest(t, index.vocab);
    out.push({ term: c, from: t, fixed: !!c });
  }
  return out;
}

/**
 * Search passages.
 * @param {object} index  from buildIndex
 * @param {string} query
 * @param {{filter?: (doc: object) => boolean, limit?: number, vector?: {rank: (docs: object[]) => Promise<string[]>|string[]}|null, all?: boolean}} o
 *   all: every query word must be in the passage (default true).
 * @returns {Promise<{hits: {doc: object, score: number}[], fixed: {from: string, to: string}[]}>}
 */
export async function search(index, query, { filter = null, limit = 20, vector = null, all = true } = {}) {
  const pool = filter ? index.docs.filter(filter) : index.docs;
  const { hits: keyword, fixed } = keywordHits(index, query, { pool, all });
  if (!vector) return { hits: keyword.slice(0, limit), fixed };
  // Meaning: the model's ranking of the same pool, fused by rank.
  let ranked = [];
  try { ranked = await vector.rank(pool, query); } catch (_) { ranked = []; }
  const score = new Map();
  keyword.slice(0, 200).forEach((h, i) => score.set(h.doc.id, (score.get(h.doc.id) || 0) + 1 / (RRF_K + i + 1)));
  ranked.slice(0, 200).forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (RRF_K + i + 1)));
  const byId = new Map(pool.map((d) => [d.id, d]));
  const hits = [...score.entries()].map(([id, s]) => ({ doc: byId.get(id), score: s })).filter((h) => h.doc).sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), fixed };
}

/** Keyword (BM25) hits, best first; synchronous. */
export function keywordHits(index, query, { pool = index.docs, all = true } = {}) {
  const qs = queryTerms(index, query);
  const fixed = qs.filter((x) => x.fixed).map((x) => ({ from: x.from, to: x.term }));
  const want = qs.filter((x) => x.term).map((x) => x.term);
  const missing = qs.some((x) => !x.term);
  const N = index.docs.length || 1;
  const keyword = [];
  if (want.length && !(all && missing)) {
    for (const d of pool) {
      let s = 0, hit = 0;
      for (const t of want) {
        const f = d.tf.get(t);
        if (!f) continue;
        hit++;
        const idf = Math.log(1 + (N - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
        s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / index.avgLen));
      }
      if (hit && (!all || hit === want.length)) keyword.push({ doc: d, score: s });
    }
    keyword.sort((a, b) => b.score - a.score || b.doc.at - a.doc.at);
  }
  return { hits: keyword, fixed };
}

/** The best passage per answer, in rank order. */
export function byAnswer(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) { if (seen.has(h.doc.captureId)) continue; seen.add(h.doc.captureId); out.push(h); }
  return out;
}
