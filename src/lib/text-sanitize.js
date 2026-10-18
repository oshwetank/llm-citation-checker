/*
 * text-sanitize.js — sanitizeText(), the cleanup pass every short excerpt
 * shown to the user goes through (brand-mention quote cards, model-name
 * extraction, CSV cells, cluster fallback text). Extracted from ui/panel.js
 * into its own dependency-free module — it's pure string logic with no DOM
 * or chrome.* dependency, and panel.js itself can't be imported by a Node
 * test (it touches `document`/`chrome` at load time), so this was
 * previously untestable outside a live browser. That mattered here: a real
 * bug (markdown links leaking verbatim into brand-mention cards) shipped
 * and went unnoticed until a user screenshot caught it.
 */
import { PRICE_RE } from "./money.js";

function sanitizeText(t) {
  if (!t) return "";
  let text = String(t);
  text = text.replace(/[\uE200-\uE202]?products\{[^}]*\}[\uE200-\uE202]?/gi, ""); // Remove products carousel tokens
  text = text.replace(/products\{"selections":\[[^\]]*\]\}/gi, ""); // Remove selections JSON
  text = text.replace(/entity\[[^\]]*\]/gi, ""); // Remove internal ChatGPT SSE entity annotations
  text = text.replace(/image_group\{[^}]*\}/gi, ""); // Remove JSON leaks
  // PUA cite markers: OPEN U+E200 + kind + (MID U+E202 + body)+ + CLOSE U+E201
  // (see cleanPassage in adapters/chatgpt.js). Complete sequences go first, as
  // a whole. A single pattern used to match OPEN\u2026MID, then take the CLOSE as a
  // new opener and eat the rest of the line \u2014 every word after a citation was
  // lost, including model names extractBrandModels() looks for.
  text = text.replace(/\uE200[^\uE201]*\uE201/g, "");
  // Truncated, unclosed fragments (the slice ended mid-marker). Only OPEN or
  // MID starts one, and only CLOSE may end one: ending on MID left the next
  // body ("turn0search1") behind as visible text.
  text = text.replace(/[\uE200\uE202][^\uE200-\uE202\n]*\uE201?/g, "");
  // A lone CLOSE (the slice began mid-marker) goes on its own.
  text = text.replace(/\uE201/g, "");
  // Markdown links — [Realme Narzo Power 5G](http://googleusercontent.com/shopping_content/1_card...)
  // leaked straight into brand-mention quote cards verbatim. Gemini's shopping-
  // carousel answer text embeds these internal, meaningless-to-the-reader
  // stable links around every product name; keep the visible label (it's
  // usually the brand/model already shown as the card title, redundant but
  // harmless), drop the URL.
  //
  // Passages arrive here as short slices of a much longer answer (see the
  // ~230-char SLICES note on cleanPassage in adapters/chatgpt.js), so a link
  // this long routinely gets sliced mid-URL, before its closing ")" ever
  // shows up — the naive "complete link" pattern below leaves that case
  // untouched, so a dangling "[Label](https://not-fini" survives to the
  // screen. These two run FIRST, most specific (has a label) before least
  // (bare "(https://..." with no label at all, e.g. "...battery...(http:").
  text = text.replace(/\[([^\]]*)\]\s*\(https?:\/\/\S*$/g, "$1");
  text = text.replace(/\(https?:\/\/\S*$/g, "");
  // Truncated one step earlier still: the slice ends right after the closing
  // "]", before "(" ever appears — "...The [OPPO K14 5G]" with nothing after
  // it. Only at the END of the string, so a legitimate "[Sponsored]"-style
  // bracket note in the middle of real prose is left alone.
  text = text.replace(/\[([^\]]*)\]$/g, "$1");
  // A complete link — tolerates a space before "(", seen in practice when
  // the link survives a line-wrap in the source text.
  text = text.replace(/\[([^\]]+)\]\s*\([^)]*\)/g, "$1");
  // Any bare URL left over (not part of a markdown link) — a raw tracking/
  // internal link adds nothing inside a short excerpt and only clutters it.
  text = text.replace(/https?:\/\/\S+/gi, "");
  // Cleanup: URL-stripping above can leave an orphaned empty "()" or a lone
  // trailing "(" with nothing after it — tidy those rather than leaving a
  // stray bracket as the last thing the reader sees.
  text = text.replace(/\(\s*\)/g, "");
  text = text.replace(/\(\s*$/, "");
  text = text.replace(/\*\*/g, ""); // Strip markdown bold asterisks
  text = text.replace(/\*/g, ""); // Strip italic asterisks
  text = text.replace(/\|/g, " "); // Replace table pipes with space
  text = text.replace(/\-{2,}/g, " "); // Remove markdown table dash dividers
  // Heading marks. Two patterns, kept separate on purpose: `##`+ (2 or more
  // hashes in a row) is unambiguously a markdown heading — nothing legitimate
  // ever repeats '#' — so it's stripped outright, unlike a single '#' which
  // could start a real hashtag or color hex and is only stripped when
  // immediately followed by hex/word chars (the line below, unchanged).
  text = text.replace(/#{2,}/g, "");
  text = text.replace(/#(?:[a-f0-9]{3,6}|[a-z0-9_-]+)/gi, ""); // Remove markdown header hashes
  text = text.replace(/Phone\s+Best\s+For|Phone\s+Approx\.?\s+Price|Best\s+For\s+Approx\.?\s+Price/gi, ""); // Remove table headers
  return text.replace(/\s+/g, " ").trim();
}

/*
 * Make a raw fragment safe to show as a chip label.
 *
 * The "Cited for" chips are captured out of numbered-list headers, and
 * sanitizeText() has already replaced markdown table pipes with spaces by the
 * time they are read — so a row like
 *
 *     | Samsung Galaxy S25 FE | Video & Long-Term Reliability | Approx. ₹35,000 |
 *
 * arrives as one line and a capture that runs to end-of-line swallows the next
 * column: the chip read "Video & Long-Term Reliability Approx". The pipes
 * cannot be kept (they would show in every excerpt), so the label is bounded
 * here instead — at the first sign of a following column, then by word count.
 *
 * Returns "" when nothing sensible survives, which callers treat as "no label"
 * rather than rendering an empty chip.
 */
function trimLabel(raw, maxWords = 5) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // The next table column usually announces itself: a price, a rating, a
  // date, or the word that introduces one.
  s = s.split(/\s+(?:approx\.?|from|starting|price|rs\.?|inr|usd)\b/i)[0];
  { const m = PRICE_RE.exec(s); if (m) s = s.slice(0, m.index); }
  s = s.split(/[₹$€£¥₩]/)[0];
  s = s.split(/\s+\d[\d,.]*\s*(?:%|★|\/\s*\d)/)[0];

  const words = s.split(" ").filter(Boolean).slice(0, maxWords);
  // A label ending on a connective was cut mid-phrase; the dangling word says
  // less than nothing.
  while (words.length && /^(?:and|or|for|with|the|a|an|of|in|to|at|by|approx\.?|vs\.?|plus|&)$/i.test(words[words.length - 1])) {
    words.pop();
  }
  s = words.join(" ").replace(/[\s,;:.\-–—&/]+$/, "").trim();
  return s.length < 3 ? "" : s;
}

export { sanitizeText, trimLabel };
