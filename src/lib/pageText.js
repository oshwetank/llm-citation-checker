/*
 * pageText.js — the cited pages, read (0.62.0).
 *
 * Reported: "Which sources name which brands" was unreliable. It decided
 * whether a page names a brand from the result's title and snippet alone,
 * a line or two the engine chose to show, so a page that compares five
 * phones could read as naming one. With "Read the cited pages" on, the
 * extension fetches the pages an answer cited (nothing else), keeps their
 * readable text on this computer, and matches the brands against all of it.
 *
 * This file is the part with no browser APIs: which URLs to read, whether
 * what came back is a real page or a wall, and which brands the text names
 * (with a count and the words around the first mention). The fetching, the
 * offscreen document that runs Mozilla Readability and the hidden-tab
 * fallback are in background.js and ui/offscreen.js.
 */
import { wordRe } from "./textMatch.js";
import { buildBrandVocabulary, extractBrandsFromText } from "./funnel-omitted.js";

export const MAX_PAGES = 15;
export const PAGE_TTL_MS = 7 * 86400000;
export const MIN_WORDS = 150;

/** The cited pages of a record, once each, in the order the answer cited them. */
export function citedUrls(rec, max = MAX_PAGES) {
  const seen = new Set();
  const out = [];
  for (const s of (rec && rec.sources) || []) {
    if (s.outcome !== "cited" || !/^https?:\/\//i.test(s.url || "")) continue;
    const key = s.url.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

export const wordCount = (t) => (String(t || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

// The pages anti-bot services put in front of a site, and the shells that
// only fill in with JavaScript. Their text is about the wall, not the page.
const WALL_RE = /\b(just a moment|checking your browser|verify you are (a )?human|are you a robot|attention required|access denied|request blocked|enable javascript|please turn javascript on|captcha|unusual traffic|cf-chl|ddos protection)\b/i;

/** "ok", or why the text isn't the page: "blocked" (a wall) or "thin" (too little to be the page). */
export function pageVerdict({ title = "", text = "" } = {}) {
  const head = `${title} ${String(text).slice(0, 2000)}`;
  if (WALL_RE.test(head) && wordCount(text) < 400) return "blocked";
  if (wordCount(text) < MIN_WORDS) return "thin";
  return "ok";
}

/**
 * The brands a page's text names, from the same vocabulary as the answer's
 * brand matrix (its named brands, product makers, places, search terms).
 * @returns {{ brand: string, count: number, context: string }[]}
 */
export function pageBrands(text, rec) {
  const t = String(text || "");
  if (!t) return [];
  const vocab = buildBrandVocabulary(rec || {});
  if (!vocab.size) return [];
  return extractBrandsFromText(t, vocab).map(({ brand }) => {
    const re = wordRe(brand, "gi");
    const hits = [...t.matchAll(re)];
    const at = hits.length ? hits[0].index : -1;
    const context = at >= 0 ? t.slice(Math.max(0, at - 80), at + brand.length + 80).replace(/\s+/g, " ").trim() : "";
    return { brand, count: hits.length || 1, context };
  }).sort((a, b) => b.count - a.count);
}

/** What the record keeps about one page (the text itself stays in the pages store). */
export function pageSummary(row, rec) {
  if (!row) return null;
  const base = { status: row.status, method: row.method || null, words: row.words || 0, fetchedAt: row.fetchedAt || null, title: row.title || null, httpStatus: row.httpStatus || null };
  return row.status === "ok" ? { ...base, brands: pageBrands(row.text || "", rec) } : base;
}
