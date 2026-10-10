/*
 * text-sanitize.test.mjs — guards sanitizeText() against the bug a user
 * screenshot caught: markdown links (and their truncated remnants) leaking
 * verbatim into brand-mention quote cards. Gemini's shopping-carousel
 * answer text wraps every product name in a markdown link to an internal
 * googleusercontent.com/shopping_content/... URL, and since quote passages
 * are short slices of a longer answer (~230 chars, see the note in
 * adapters/chatgpt.js), that link routinely gets cut mid-way rather than
 * arriving whole — so every truncation stage needs its own case here, not
 * just the complete-link one.
 */
import { sanitizeText, trimLabel } from "../src/lib/text-sanitize.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
};

console.log("\nsanitizeText: markdown links — the real bug (screenshot capture)");
{
  const out = sanitizeText(
    "0,000: ### Top High-End Fast Charging Options ... The [Realme Narzo Power 5G] (http://googleusercontent.com/shopping_content/1_card_link) offers 68W"
  );
  check("label kept, URL and brackets gone", out.includes("Realme Narzo Power 5G"), out);
  check("no raw URL left", !out.includes("http"), out);
  check("no stray brackets/parens", !/[[\]()]/.test(out), out);
  check("### heading marker gone, not just a single #", !out.includes("#"), out);
}

console.log("\nsanitizeText: link truncated after the label, mid-URL (no closing paren)");
{
  const out = sanitizeText(
    "The Motorola Edge 70 Fusion offers 68W TurboPower charging with a 7000 mAh batter...(http://googleusercontent.com/shopping_content/2_card)"
  );
  check("prose kept intact up to the truncation", out.startsWith("The Motorola Edge 70 Fusion offers 68W TurboPower charging with a 7000 mAh batter"), out);
  check("no raw URL leaked", !out.includes("http"), out);
  check("no dangling open paren left as the last character", !out.endsWith("("), out);
}

console.log("\nsanitizeText: link truncated with a bare '(http' fragment, no label bracket at all");
{
  const out = sanitizeText("Balanced everyday performance. The Tecno Pova Curve 2 5G (http://googleusercontent.com/shopping_content/5_");
  check("prose kept, dangling '(http...' fragment removed", out === "Balanced everyday performance. The Tecno Pova Curve 2 5G", out);
}

console.log("\nsanitizeText: truncated even earlier — right after the label's closing ']', no '(' at all");
{
  // This is the exact shape from card #4 ('OPPO K14 5G') in the reported screenshot.
  const out = sanitizeText("rved AMOLED screen, and an 8000 mAh battery. The [OPPO K14 5G]");
  check("bracket label kept, brackets themselves stripped", out === "rved AMOLED screen, and an 8000 mAh battery. The OPPO K14 5G", out);
}

console.log("\nsanitizeText: a complete markdown link mid-sentence (not at the truncation boundary)");
{
  const out = sanitizeText(
    "Balanced Everyday Performance & Battery Options http://googleusercontent.com/shopping_content/4_card The [Tecno Pova Curve 2 5G](http://googleusercontent.com/shopping_content/5_link..."
  );
  check("both links resolved to just their labels", out === "Balanced Everyday Performance & Battery Options The Tecno Pova Curve 2 5G", out);
}

console.log("\nsanitizeText: does not over-match — legitimate content survives");
{
  check("a real mid-sentence bracket note is left alone", sanitizeText("Something [Sponsored] appears mid sentence and continues normally") === "Something [Sponsored] appears mid sentence and continues normally");
  check("a single '#' before a word (hashtag-shaped) is still stripped, unchanged behavior", sanitizeText("#YOLO trending phones 2026") === "trending phones 2026");
  check("'C#' is not mistaken for a heading (single #, no run of 2+)", sanitizeText("A genuine C# developer tool review") === "A genuine C# developer tool review");
  check("markdown bold/italic/table noise still stripped as before", sanitizeText("**bold** text | with | pipes --- and a #hexcolorlike ref") === "bold text with pipes and a ref");
}

console.log("\nsanitizeText: degrades safely on empty/null input");
{
  check("null -> empty string, no throw", sanitizeText(null) === "");
  check("undefined -> empty string, no throw", sanitizeText(undefined) === "");
  check("empty string -> empty string", sanitizeText("") === "");
}

console.log("\nsanitizeText: ChatGPT cite markers — text after a complete marker survives");
{
  // ChatGPT wraps a citation as OPEN (U+E200) + "cite" + MID (U+E202) + body
  // + CLOSE (U+E201), see cleanPassage in adapters/chatgpt.js. The old single
  // pattern matched OPEN…MID, then took the CLOSE as a fresh opener and ate the
  // rest of the line — so "Kovo Air" below vanished, and extractBrandModels()
  // in ui/panel.js never saw any model named after a citation.
  const OPEN = "", CLOSE = "", MID = "";
  const one = `${OPEN}cite${MID}turn0search1${CLOSE}`;
  const many = `${OPEN}cite${MID}turn0search1${MID}turn0news4${CLOSE}`;

  const out = sanitizeText(`Zentra Lite is the best value ${one} for most people. Kovo Air is lighter.`);
  check("text after a complete cite marker survives",
    out === "Zentra Lite is the best value for most people. Kovo Air is lighter.", out);

  const out2 = sanitizeText(`Pick Zentra Lite ${many} or Kovo Air ${one} if weight matters.`);
  check("multi-ref markers and two markers on one line both strip cleanly",
    out2 === "Pick Zentra Lite or Kovo Air if weight matters.", out2);

  const out3 = sanitizeText(`Zentra Lite wins ${OPEN}cite${MID}turn0search1${MID}turn0search2`);
  check("a truncated, unclosed marker at the end is still removed",
    out3 === "Zentra Lite wins", out3);

  const out4 = sanitizeText(`search1${CLOSE} and Kovo Air is lighter.`);
  check("a lone CLOSE (slice began mid-marker) is dropped without eating the line",
    out4 === "search1 and Kovo Air is lighter.", out4);

  check("no private-use characters survive",
    ![out, out2, out3, out4].some((s) => /[-]/.test(s)));
}

console.log("\ntrimLabel: a chip label must not run into the next table column");
{
  // The reported case, from a real capture. sanitizeText() replaces markdown
  // pipes with spaces (it has to — they would show in every excerpt), so a
  // capture that runs to end of line picks up the price column behind it.
  check("the price column is dropped",
    trimLabel("Video & Long-Term Reliability Approx. ₹35,000") === "Video & Long-Term Reliability",
    trimLabel("Video & Long-Term Reliability Approx. ₹35,000"));
  check("a bare currency column is dropped",
    trimLabel("Portrait Photography & Selfies ₹28,999") === "Portrait Photography & Selfies",
    trimLabel("Portrait Photography & Selfies ₹28,999"));
  check("so is a rating column",
    trimLabel("Battery Life 4.5 / 5") === "Battery Life", trimLabel("Battery Life 4.5 / 5"));
  check("and a 'from ₹' lead-in",
    trimLabel("Clean Software from ₹19,999") === "Clean Software", trimLabel("Clean Software from ₹19,999"));

  // A label cut mid-phrase ends on a connective, which says less than nothing.
  check("a dangling connective is removed",
    trimLabel("Camera and") === "Camera", trimLabel("Camera and"));
  check("trailing punctuation is removed",
    trimLabel("Price & Value —") === "Price & Value", trimLabel("Price & Value —"));

  check("a long phrase is capped, not truncated mid-word",
    trimLabel("one two three four five six seven") === "one two three four five",
    trimLabel("one two three four five six seven"));
  check("the cap is adjustable", trimLabel("one two three", 2) === "one two");

  check("a genuine label is left alone",
    trimLabel("Price & Value") === "Price & Value", trimLabel("Price & Value"));
  check("whitespace is collapsed",
    trimLabel("  Trust  &   Reputation  ") === "Trust & Reputation", trimLabel("  Trust  &   Reputation  "));

  // Nothing sensible left means no chip, rather than an empty one.
  check("a stub returns empty", trimLabel("of") === "", `"${trimLabel("of")}"`);
  check("punctuation only returns empty", trimLabel("—") === "", `"${trimLabel("—")}"`);
  check("null returns empty", trimLabel(null) === "");
  check("undefined returns empty", trimLabel() === "");
  check("a price on its own returns empty", trimLabel("₹35,000") === "", `"${trimLabel("₹35,000")}"`);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
