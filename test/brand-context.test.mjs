/*
 * brand-context.test.mjs — Brand Mentions follow the PROMPT's subject, not the
 * answer's layout.
 *
 * Reported: "fix the mention logic so that even if the answer format changes
 * and multiple brands appear, the mention brands will only appear based on the
 * context of the prompt." The capture behind it ("best camera phone under
 * 30000") reported "Optical Zoom", "Versatile Triple Camera",
 * "High-Resolution Still Photos" and "Balanced All-Rounder" — a comparison
 * table's use-case column — and not one of the five phone brands sitting in
 * the next column over.
 *
 * Choosing the right table column fixes that one table. It cannot fix the
 * general case, because every layout invents a new hiding place for a
 * descriptor. So detection leans on two things that hold whatever the markup
 * does, both of which this file pins down:
 *
 *   1. A brand is a proper noun: the answer writes it as a NAME in its own
 *      prose — capitalised, not sentence-initial, outside table cells,
 *      headings and bold labels. A descriptor never earns that.
 *   2. The words the QUESTION was phrased in are the category being asked
 *      about, never an answer to it. "Camera Phone" is not a brand.
 *
 * Every layout below is the SAME prompt and the SAME five phones, formatted
 * six different ways. All six must agree.
 */
import {
  detectBrands, promptContextTokens, namedInProse, hasProseLines,
  proseNameCandidates, isPlausibleProseName, parseMarkdownTables,
} from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "best camera phone under 30000";
const brandsOf = (text, prompt = PROMPT) =>
  detectBrands(text, text, { prompt }).brands.map((b) => b.brand);

console.log("\nbrand-context: promptContextTokens keeps the subject, drops the scaffolding");
{
  const t = promptContextTokens(PROMPT);
  check("subject words survive", t.has("camera") && t.has("phone"), [...t].join(","));
  check('"best" and "under" are scaffolding, not subject', !t.has("best") && !t.has("under"), [...t].join(","));
  check("a bare number is not a subject word", !t.has("30000"), [...t].join(","));
  check("an empty prompt yields nothing rather than throwing", promptContextTokens("").size === 0);
  check("a null prompt is safe", promptContextTokens(null).size === 0);
}

console.log("\nbrand-context: namedInProse separates a name from a descriptor");
{
  // The exact shapes from the reported capture.
  const real = "Phones like the Nothing Phone (3a) Pro and Motorola Edge 60 Pro include 3x telephoto lenses.";
  check("a name written mid-sentence in prose is evidence", namedInProse(real, "Nothing"));
  check("so is a second one in the same sentence", namedInProse(real, "Motorola"));

  const descriptor =
    "The best camera phones are led by models with optical zoom, high-resolution sensors.\n" +
    "| **Optical Zoom** | **Nothing Phone (3a) Pro** |\n" +
    "- **Optical zoom matters**: Phones like the Nothing Phone (3a) Pro lead.";
  check('"Optical Zoom" is never written as a name (lowercase prose, a table cell, a bold label)',
    !namedInProse(descriptor, "Optical Zoom"));
  check("the real brand in that same text still is", namedInProse(descriptor, "Nothing"));

  check("a table cell alone is not prose evidence",
    !namedInProse("| Balanced All-Rounder | Motorola Edge 70 Fusion |", "Balanced All-Rounder"));
  check("a heading alone is not prose evidence",
    !namedInProse("## Balanced All-Rounder\n", "Balanced All-Rounder"));
  // Sentence-initial capitalisation is what every sentence does.
  check("a sentence-initial word is not evidence",
    !namedInProse("- Strong daylight detail and punchy colours.", "Strong"));
  check("but a bolded subject is ('**Zerodha** is the largest broker.')",
    namedInProse("**Zerodha** is the largest broker.", "Zerodha"));
}

console.log("\nbrand-context: hasProseLines tells a prose answer from a bare table");
{
  check("a table-only answer has no prose to corroborate against",
    !hasProseLines("| Mouse | Price |\n|---|---|\n| Zebronics Transformer M Plus | 500 |"));
  check("a heading-only answer likewise", !hasProseLines("## Top Picks\n### Runner-up\n"));
  check("a real paragraph counts as prose",
    hasProseLines("The best camera phones under 30000 are led by models with optical zoom."));
}

console.log("\nbrand-context: the same five phones, six different layouts, one answer");
{
  const layouts = {
    "use-case table WITH a name header":
      "| Best For | Phone | Price |\n| --- | --- | --- |\n" +
      "| **Optical Zoom** | **Nothing Phone (3a) Pro** | ₹26,999 |\n" +
      "| **Low Light** | **Motorola Edge 60 Pro** | ₹28,999 |\n\n" +
      "Phones like the Nothing Phone (3a) Pro and Motorola Edge 60 Pro lead.",
    "use-case table with NO name header":
      "| Category | Recommendation | Notes |\n| --- | --- | --- |\n" +
      "| **Optical Zoom** | **Nothing Phone (3a) Pro** | tele |\n" +
      "| **Low Light** | **Motorola Edge 60 Pro** | bright |\n\n" +
      "The Nothing Phone (3a) Pro and Motorola Edge 60 Pro both shine.",
    "bolded benefit labels, no table":
      "## Top Camera Phones\n\n" +
      "- **Best Optical Zoom**: the Nothing Phone (3a) Pro has a 3x periscope.\n" +
      "- **Best Low Light**: the Motorola Edge 60 Pro wins after dark.",
    "a heading per benefit":
      "### Optical Zoom\nThe Nothing Phone (3a) Pro leads.\n### Battery Life\nThe Motorola Edge 60 Pro lasts longest.",
    "pure prose":
      "For zoom, the Nothing Phone (3a) Pro is the pick. Low light goes to the Motorola Edge 60 Pro.",
    "numbered list":
      "1. **Nothing Phone (3a) Pro** — best optical zoom\n2. **Motorola Edge 60 Pro** — best low light",
  };
  for (const [name, text] of Object.entries(layouts)) {
    const got = brandsOf(text);
    check(`${name}: the real brands are reported`,
      got.includes("Nothing") && got.includes("Motorola"), got.join(", ") || "(none)");
    check(`${name}: no use-case label is reported as a brand`,
      !got.some((b) => /optical zoom|low light|battery life|camera phone|best for|recommendation/i.test(b)),
      got.join(", "));
  }
}

console.log("\nbrand-context: the prompt's own words are never brands");
{
  const echo =
    "## Best Camera Phone Picks\n\n" +
    "The Camera Phone category is crowded. The Nothing Phone (3a) Pro leads it.";
  const got = brandsOf(echo);
  check('"Camera Phone" (the question restated) is not a brand', !got.some((b) => /^camera phone$/i.test(b)), got.join(", "));
  check("the real brand alongside it is", got.includes("Nothing"), got.join(", "));

  // A brand the PROMPT names must still be reported — that is the whole point
  // of tracking share of voice for your own brand.
  const named = "The Motorola Edge 60 Pro is the best Motorola phone under 30000 right now.";
  check("a brand named in the prompt is still detected",
    brandsOf(named, "best Motorola phone under 30000").includes("Motorola"),
    brandsOf(named, "best Motorola phone under 30000").join(", "));
}

console.log("\nbrand-context: a table's name column is chosen on evidence, not position");
{
  const useCaseLed =
    "| Category | Recommendation |\n| --- | --- |\n" +
    "| Optical Zoom | Nothing Phone (3a) Pro |\n\n" +
    "The Nothing Phone (3a) Pro leads on zoom.";
  check("the column the prose writes as a name wins over column 1",
    JSON.stringify(parseMarkdownTables(useCaseLed)) === JSON.stringify(["Nothing Phone (3a) Pro"]),
    JSON.stringify(parseMarkdownTables(useCaseLed)));

  // With nothing to go on, position still decides — the long-standing default.
  const noEvidence = "| Mouse | Price |\n|---|---:|\n| Zebronics Transformer M Plus | ₹500 |";
  check("with no header hint and no prose, column 1 is still used",
    JSON.stringify(parseMarkdownTables(noEvidence)) === JSON.stringify(["Zebronics Transformer M Plus"]),
    JSON.stringify(parseMarkdownTables(noEvidence)));
}

console.log("\nbrand-context: the prose tier refuses the shapes that are not names");
{
  const feature = "The Google Pixel 7a offers computational photography (Night Sight, HDR+) despite older hardware.";
  const got = brandsOf(feature);
  check('a one-off feature pair ("Night Sight") is not a brand', !got.some((b) => /night sight|hdr/i.test(b)), got.join(", "));
  check("the real brand in the same sentence is", got.includes("Google"), got.join(", "));

  check("a glued flattening artifact is refused", !isPlausibleProseName("StrengthsBest"));
  check("so is a long lowercase prefix before the hump", !isPlausibleProseName("pickboAt"));
  check("a real camelCase brand is kept", isPlausibleProseName("boAt") && isPlausibleProseName("iPhone"));
  check("a short all-caps acronym is refused", !isPlausibleProseName("ANC") && !isPlausibleProseName("OIS"));
  check("a bare geography qualifier is refused", !isPlausibleProseName("India"));

  // Recurrence or a model designation — one of the two is required.
  check("a name carrying a model designation qualifies on its own",
    proseNameCandidates("Buy the Motorola Edge 60 Pro today.").some((c) => /Motorola/.test(c)));
  check("a one-off capitalised pair with neither does not",
    !proseNameCandidates("It has Night Sight built in.").some((c) => /Night Sight/.test(c)));
}

console.log("\nbrand-context: degenerate input never throws");
{
  check("empty text", detectBrands("", "", { prompt: PROMPT }).brands.length === 0);
  check("no prompt at all still detects", brandsOf("The Motorola Edge 60 Pro leads.", undefined).includes("Motorola"));
  check("null-ish args are safe", namedInProse(null, null) === false && proseNameCandidates(null).length === 0);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
