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

/** A RegExp for `name` as a whole word, in any script. Flags gain "u". */
export function wordRe(name, flags = "i") {
  const n = String(name || "");
  const f = flags.includes("u") ? flags : flags + "u";
  if (NO_SPACE_SCRIPTS.test(n)) return new RegExp(escName(n), f);
  // Marks (\p{M}) count as part of a word: Devanagari and Arabic vowel signs.
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escName(n)}(?![\\p{L}\\p{N}\\p{M}_])`, f);
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
