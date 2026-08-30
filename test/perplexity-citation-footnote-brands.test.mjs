/*
 * perplexity-citation-footnote-brands.test.mjs — cited-source domains never
 * get reported as "brand mentions" just because Perplexity's own citation
 * footnote happens to render their bare label inline in the plain-text
 * answer.
 *
 * Real bug, reproduced from a real user capture (fixtures/perplexity-
 * keyPaintCharacteristics.txt, "Key Paint Characteristics"): Perplexity
 * writes each inline citation as the cited source's bare domain label
 * sitting alone on its own line right after the cited sentence
 * ("...easy to clean.\nthespruce\n+3\n\n"). detectBrands()'s structural
 * heuristics have no way to distinguish that from a genuine one-word brand
 * mention on its own line ("Nothing", "Oppo" are real examples elsewhere in
 * this codebase's fixtures) — so five of the answer's five cited sources
 * (jaquar, familyhandyman, compositepaint, talkofthehouse, paintdeck) were
 * all reported as "brands", alongside the real ones actually being compared
 * (Benjamin Moore, Asian Paints, Berger, Dulux). The fix strips this
 * footnote shape out of the answer text — via a known source-domain match,
 * or the "+N" sibling-count line Perplexity itself renders after a
 * citation — before brand detection ever runs.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(new URL("./fixtures/perplexity-keyPaintCharacteristics.txt", import.meta.url), "utf8");
const json = raw.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();

console.log("\nperplexity-citation-footnote-brands: cited-source footnotes are not brand mentions");

const rec = await adapt({
  captureId: "test-paint",
  raw: json,
  reqBody: null,
  capturedAt: Date.now(),
  pageUrl: "https://www.perplexity.ai",
});

const brandNames = rec.brandMentions.map((b) => b.brand.toLowerCase());

// The regression itself: every cited-source domain that showed up as a false
// "brand" in the real bug report must be gone.
for (const falsePositive of ["jaquar", "familyhandyman", "compositepaint", "talkofthehouse", "paintdeck"]) {
  check(`"${falsePositive}" (a cited source, not a brand) is not in brandMentions`, !brandNames.includes(falsePositive), `brandMentions: ${brandNames.join(", ")}`);
}

// Sources themselves must be completely unaffected by the footnote cleanup —
// this fix touches brand detection and display text, never the sources list.
check(
  "all 5 real sources are still present, unaffected",
  rec.sources.length === 5,
  `got ${rec.sources.length}: ${rec.sources.map((s) => s.domain).join(", ")}`
);
for (const domain of ["compositepaint.com", "talkofthehouse.com", "jaquar.com", "paintdeck.co", "familyhandyman.com"]) {
  check(`source ${domain} is present`, rec.sources.some((s) => s.domain === domain));
}

// The bare footnote tokens must be gone from the displayed answer text too
// (not just from brand detection) — they're rendering artifacts, not prose.
for (const token of ["jaquar", "thespruce", "domino", "bathfitter"]) {
  const re = new RegExp(`\\n${token}\\n`, "i");
  check(`bare footnote line "${token}" is stripped from answerText`, !re.test(rec.answerText));
}
check("no dangling \"+N\" sibling-count markers remain in answerText", !/\n\+\d+\n/.test(rec.answerText));

// Real prose must survive completely untouched — this is the guard against
// the fix being too aggressive. Genuine sentences containing these same
// words as substrings, or the source names as part of real discussion
// text, must not be affected.
check("real prose sentence survives", /100% acrylic latex paint with mold\/mildew resistance/.test(rec.answerText));
check("a real table row survives", /Semi-\s*\ngloss/.test(rec.answerText.replace(/\r/g, "")) || /Semi-/.test(rec.answerText));

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
