/*
 * textMatch.js — finding a name in a text, in any script (0.70.0).
 *
 * JavaScript's \b only knows ASCII letters, so `\bソニー\b` or `\bनोकिया\b`
 * never matches and every non-Latin brand name was silently dropped (the
 * AI merge, mention counts, page matching all used \b). Here a name's edges
 * are any letter or digit in any script, and names written in scripts that
 * don't put spaces between words (Chinese, Japanese, Thai, Lao, Khmer,
 * Burmese) are matched as they are written, without edges.
 */
const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// An apostrophe is written either way ("McVitie's", "McVitie’s"): one engine's
// product card and its own prose disagreed, and the brand counted 0 (1.0.0).
const escName = (s) => esc(s).replace(/['’‘]/g, "['’‘]");

// Built once per name and flags (1.0.7): a campaign board asked for the same
// few names hundreds of thousands of times, and a 795-answer campaign took
// 10 s to open (live test of 25 Nov 2026). A pattern without "g" or "y"
// keeps no state, so it is shared; one with them is handed out as a copy,
// since its lastIndex moves.
const RE_CACHE = new Map();
const RE_CACHE_MAX = 5000;
/** A RegExp for `name` as a whole word, in any script. Flags gain "u". */
export function wordRe(name, flags = "i") {
  const n = String(name || "");
  const f = flags.includes("u") ? flags : flags + "u";
  const k = f + "\u0000" + n;
  let re = RE_CACHE.get(k);
  if (!re) {
    // Marks (\p{M}) count as part of a word: Devanagari and Arabic vowel signs.
    re = NO_SPACE_SCRIPTS.test(n)
      ? new RegExp(escName(n), f)
      : new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escName(n)}(?![\\p{L}\\p{N}\\p{M}_])`, f);
    if (RE_CACHE.size >= RE_CACHE_MAX) RE_CACHE.clear();
    RE_CACHE.set(k, re);
  }
  return /[gy]/.test(f) ? new RegExp(re) : re;
}

/** Does `text` contain `name` as a whole word? */
export function textHas(text, name) {
  if (!name) return false;
  return wordRe(name, "i").test(String(text || ""));
}

/** Every place `name` occurs, as match objects (index, [0]). */
export function textMatches(text, name) {
  if (!name) return [];
  return [...String(text || "").matchAll(wordRe(name, "gi"))];
}
