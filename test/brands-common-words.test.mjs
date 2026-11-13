/*
 * brands-common-words.test.mjs — brands found the way a reader would find
 * them, on the owner's four answers of 13 Nov 2026 (1.0.0).
 *
 * The same question ("best biscuit for morning chai, which is also healthy")
 * on four engines. What the brand list said before:
 *   ChatGPT     Sugar, Saturated, Dietary, Sodium, Ingredients (a "Nutrient |
 *               What to aim for" table) and no Patanjali, whose name is only
 *               in its own heading;
 *   Perplexity  Whole-wheat, Ragi, Oats, Homemade (an "Option" table of
 *               kinds of biscuit; the answer names no brand at all);
 *   Grok        nothing but website names, though it names Britannia,
 *               Cremica, Sunfeast and Unibic in its list and its "e.g.";
 *   Gemini      McVitie's counted 0: its card says McVitie’s, its prose
 *               McVitie's.
 * Rules, not a word list (see lib/brands.js): a word the answer also writes
 * in lowercase is an ordinary word; a table whose first column the header
 * calls a property names nothing; sibling headings that read as names are a
 * list of picks; a list item's bold subject and an "e.g." item are names.
 */
import { readFileSync } from "node:fs";
import * as B from "../src/lib/brands.js";
const { detectBrands, vendorFromProductName } = B;
// Read off the module so this file still runs (and fails) on the old rules.
const trimDescriptors = B.trimDescriptors || ((_t, p) => p);
import { textHas } from "../src/lib/textMatch.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const fx = JSON.parse(readFileSync(new URL("./fixtures/biscuit-answers-2026-11.json", import.meta.url), "utf8"));
const brandsOf = (e) => detectBrands(fx[e].answerText, fx[e].answerText, { sources: fx[e].sources, prompt: fx[e].prompt }).brands.map((b) => b.brand);
const NOT_BRANDS = /^(sugar|saturated|dietary|sodium|ingredients|whole-wheat|ragi|oats|homemade|millet)$/i;

console.log("\nChatGPT: a nutrient table and three product headings");
{
  const b = brandsOf("chatgpt");
  check("no nutrient or table label is a brand", !b.some((x) => NOT_BRANDS.test(x)), b.join(", "));
  check("McVitie's", b.some((x) => /^McVitie's/.test(x)), b.join(", "));
  check("Patanjali, named only in its own heading", b.some((x) => /^Patanjali/.test(x)), b.join(", "));
  check("Mo's Bakery", b.some((x) => /^Mo's/.test(x)), b.join(", "));
}

console.log("\nPerplexity: kinds of biscuit, no brand");
{
  const b = brandsOf("perplexity");
  check("no kind of biscuit is a brand", !b.some((x) => NOT_BRANDS.test(x)), b.join(", "));
  check("no news site read out of a citation address", !b.some((x) => /gaonconnection|anandabazar|indiatoday/i.test(x)), b.join(", "));
}

console.log("\nGrok: bold list items and an e.g. list");
{
  const b = brandsOf("grok");
  for (const want of ["Britannia", "Cremica", "Sunfeast", "Unibic"]) check(want, b.some((x) => x.startsWith(want)), b.join(", "));
  check("no news site read out of a citation address", !b.some((x) => /ndtv|timesnow|business-standard|cookwithmanali/i.test(x)), b.join(", "));
  check("no kind of biscuit", !b.some((x) => NOT_BRANDS.test(x)), b.join(", "));
}

console.log("\nthe pieces");
check("an apostrophe matches either way (McVitie’s / McVitie's)", textHas("Try McVitie's Digestive", "McVitie’s") && textHas("Try McVitie’s", "McVitie's"));
check("a maker's name keeps its apostrophe", vendorFromProductName("Mo's Bakery Ragi Cookies") === "Mo's", vendorFromProductName("Mo's Bakery Ragi Cookies"));
check("a maker joined by & is one name", vendorFromProductName("Tots & Moms Millet & Jaggery Cookies") === "Tots & Moms", vendorFromProductName("Tots & Moms Millet & Jaggery Cookies"));
check("describing words trimmed off a product label", trimDescriptors("high bran, more fibre than other biscuits", "Cremica High Bran Biscuits") === "Cremica");
{
  // A brand that is also a word stays a brand when written as a name.
  const t = "| Model | Price |\n|---|---|\n| Noise Airwave Max XR | 3,499 |\n| Sony WF-C700N | 7,990 |\n\nStrong noise cancellation on both.";
  const b = detectBrands(t, t, {}).brands.map((x) => x.brand);
  check("Noise, a brand that is also a word, is kept", b.includes("Noise"), b.join(", "));
}
{
  const t = "### Google Sheets / Excel\n\nBuild your own sheets.\n\n**For free tracking: Google Sheets.**";
  const b = detectBrands(t, t, {}).brands.map((x) => x.brand);
  check("Google Sheets stays whole although the answer says sheets", b.includes("Google Sheets"), b.join(", "));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
