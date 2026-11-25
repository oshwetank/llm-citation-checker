/*
 * brands-descriptors.test.mjs — a describing word before the maker's name,
 * and a chooser's field labels, are not brands (1.0.6).
 *
 * Reported from a ChatGPT answer to "best pen for gift" (24 Nov 2026): the
 * brands were "Parker, Waterman, Cross, Sheaffer, Personalised Parker
 * Jotter, Occasion, Personalised Parker". "Personalised" is how the pen is
 * made; "**Occasion**" is a field in the answer's gift chooser.
 * Run: node test/brands-descriptors.test.mjs
 */
import { detectBrands, vendorFromProductName, dropLeadDescriptor } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const names = (text, prompt = "best pen for gift") =>
  detectBrands(text, text, { prompt }).brands.filter((b) => b.count > 0).map((b) => b.brand);

console.log("\nA describing word is dropped from the front of a name");
check("Personalised Parker Jotter → Parker Jotter", dropLeadDescriptor("Personalised Parker Jotter") === "Parker Jotter");
check("Personalized (US spelling) too", dropLeadDescriptor("Personalized Cross Bailey") === "Cross Bailey");
check("Engraved Montblanc → Montblanc", dropLeadDescriptor("Engraved Montblanc Meisterstück") === "Montblanc Meisterstück");
check("a name that is only the word stays as it is", dropLeadDescriptor("Custom") === "Custom");
check("a brand that merely starts the same is left alone", dropLeadDescriptor("Originals Store") === "Originals Store");
check("the maker of a personalised product is the maker", vendorFromProductName("Personalised Parker Jotter") === "Parker", vendorFromProductName("Personalised Parker Jotter"));

console.log("\nThe gift-pen answer");
{
  const text = [
    "For gifting, I'd recommend a ballpoint or rollerball pen.",
    "",
    "## Best pens for gifting in India",
    "",
    "### Personalised Parker Jotter",
    "",
    "**₹884**",
    "",
    "Best affordable personalised gift. Stainless steel, engraved with the recipient's name.",
    "",
    "### Waterman Hemisphere",
    "",
    "A classic choice from Waterman.",
    "",
    "### Cross Bailey",
    "",
    "| Budget | Best choice |",
    "|---|---|",
    "| Under ₹500 | Parker Jotter Gold Trim |",
    "| Under ₹1,000 | Personalised Parker Jotter |",
    "| Under ₹2,000 | Sheaffer Sentinel |",
    "",
    "## Let me help you choose the perfect one",
    "",
    "What is your budget?",
    "",
    "**Who are you gifting it to?**",
    "",
    "**Occasion**",
    "",
    "[Find the best pen for me]",
  ].join("\n");
  const b = names(text);
  check("no brand starts with Personalised", !b.some((x) => /^personali[sz]ed/i.test(x)), JSON.stringify(b));
  check("\"Occasion\" is not a brand", !b.includes("Occasion"), JSON.stringify(b));
  check("Parker is still found", b.some((x) => /^Parker/.test(x)), JSON.stringify(b));
  check("Waterman and Cross are still found", b.some((x) => /^Waterman/.test(x)) && b.some((x) => /^Cross/.test(x)), JSON.stringify(b));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
