/*
 * answerSearch.js — finding words inside captured answers (0.49.0).
 *
 * The Dashboard searches three places: the prompts, the searches the engines
 * ran, and the answers themselves. The panel only holds light capture rows
 * (no answer text), so the answers are searched in the background, which
 * reads the stored records anyway, and only the matching ids come back with
 * a short snippet around the first match. Kept free of other imports (bar
 * the sanitiser) so the service worker can load it without the UI modules.
 */
import { sanitizeText } from "./text-sanitize.js";
import { indexFor, keywordHits, byAnswer } from "./passages.js";

/** Words to look for; a trailing "s" is dropped so "headphones" finds "headphone". */
export function searchTokens(q) {
  return String(q || "").toLowerCase().split(/\s+/).filter(Boolean).map((t) => (t.length > 3 ? t.replace(/s$/, "") : t));
}

/** Every word somewhere in the text, in any order. */
export function matchesTokens(str, toks) {
  if (!toks.length) return true;
  const l = String(str || "").toLowerCase();
  return toks.every((t) => l.includes(t));
}

// Citation markers out (ChatGPT's private-use markers, Perplexity's and
// Grok's [[cite:URL]]), markdown and links out, whitespace collapsed. Whole
// ChatGPT marker sequences (U+E200 … U+E201) go first: sanitizeText's own
// marker pattern, meant for excerpts, takes a closing U+E201 as an opener and
// drops the rest of the line after it.
function plain(text) {
  const s = String(text || "").replace(/\uE200[^\uE200\uE201]*\uE201/g, "").replace(/\[\[cite:[^\]]*\]\]/g, "");
  return sanitizeText(s).replace(/\s+/g, " ").trim();
}

/**
 * A snippet of the answer around the first match, or null when the answer
 * doesn't contain every word.
 */
export function answerSnippet(answerText, query, { before = 60, after = 110 } = {}) {
  const toks = searchTokens(query);
  if (!toks.length) return null;
  const text = plain(answerText);
  if (!matchesTokens(text, toks)) return null;
  const l = text.toLowerCase();
  const at = Math.min(...toks.map((t) => l.indexOf(t)).filter((i) => i >= 0));
  let start = Math.max(0, at - before);
  let end = Math.min(text.length, at + after);
  // Whole words at both ends.
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp > -1 && sp < at) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > at) end = sp; }
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/**
 * The stored records whose answer holds every word, best first, with
 * snippets (1.0.5: ranked passage search, lib/passages.js — plurals, -ing
 * and typos tolerated; before, newest first and only exact substrings).
 */
export function searchAnswers(records, query, { limit = 300 } = {}) {
  if (!searchTokens(query).length) return [];
  const index = indexFor(records || []);
  // Exact words and plurals only: a typo read as a nearby word could claim
  // an answer holds a word it doesn't (Ask keeps typo tolerance, and says so).
  const { hits, fixed } = keywordHits(index, query, { pool: index.docs.filter((d) => !d.isPrompt), fuzzy: false });
  const text = new Map((records || []).map((x) => [x.captureId, x.answerText]));
  const out = [];
  for (const h of byAnswer(hits)) {
    const r = h.doc;
    const exact = answerSnippet(text.get(r.captureId), query);
    const t = h.doc.text;
    out.push({ captureId: r.captureId, snippet: exact || (t.length > 180 ? `${t.slice(0, 179)}…` : t), ...(fixed.length ? { fixed } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}
