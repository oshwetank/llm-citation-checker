/*
 * ai-brands.test.mjs — guards the safety property ai-brands.js is built
 * around: an AI tier may only ADD names Tier C (brands.js) missed, or
 * UPGRADE a truncated name to its full form — it may never remove or
 * override anything Tier C already found, and it may never trust a
 * reported name that doesn't actually appear in the text. Tier A (Gemini
 * Nano) is unreachable in this Node test environment by construction
 * (there's no `LanguageModel` global here) — these tests exercise the
 * merge logic itself via registerTierB() with a mock, which reaches the
 * exact same mergeAiNames() code path Tier A would.
 */
import { detectBrandsAI, registerTierB } from "../src/lib/ai-brands.js";
import { isNanoAvailable } from "../src/lib/nano.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
};

console.log("\nisNanoAvailable: safely false with no LanguageModel global (this Node env, and any unsupported device)");
{
  const available = await isNanoAvailable();
  check("returns false, doesn't throw", available === false);
}

console.log("\ndetectBrandsAI: no AI tier registered — identical to a plain detectBrands() call");
{
  registerTierB(null);
  const answer = "**Zerodha** is the largest broker.";
  const r = await detectBrandsAI(answer, answer, {});
  check("Zerodha found via Tier C alone", r.brands.some((b) => b.brand === "Zerodha"), JSON.stringify(r.brands));
}

console.log("\ndetectBrandsAI: Tier B finds a brand Tier C's structural scan never looks for (plain prose, no heading/table)");
{
  const answer = "If you're shopping in this category, Angel Broking is worth a look for its low fees.";
  registerTierB(async () => ["Angel Broking"]);
  const r = await detectBrandsAI(answer, answer, {});
  const found = r.brands.find((b) => b.brand === "Angel Broking");
  check("new AI-only brand added", !!found, JSON.stringify(r.brands));
  check("added with a real count from the actual text", found && found.count === 1, found && found.count);
  registerTierB(null);
}

console.log("\ndetectBrandsAI: Tier B upgrades a truncated name to its full form (the real 'Ant' -> 'Ant Esports' case)");
{
  const answer = "| Product | Price | Best for |\n|---|---|---|\n| **Ant Esports GM100 V2** | ₹300–400 | Cheapest decent option |\n";
  const before = await detectBrandsAI(answer, answer, {}); // Tier C alone, for comparison
  registerTierB(async () => ["Ant Esports"]);
  const after = await detectBrandsAI(answer, answer, {});
  check("Tier C alone truncates to 'Ant'", before.brands.some((b) => b.brand === "Ant"), JSON.stringify(before.brands));
  check("Tier B upgrades it to the full 'Ant Esports'", after.brands.some((b) => b.brand === "Ant Esports"), JSON.stringify(after.brands));
  check("no leftover truncated 'Ant' entry after the upgrade", !after.brands.some((b) => b.brand === "Ant"), JSON.stringify(after.brands));
  check("the same number of brand entries — an upgrade, not an addition", after.brands.length === before.brands.length, `${before.brands.length} -> ${after.brands.length}`);
  registerTierB(null);
}

console.log("\ndetectBrandsAI: a name the AI reports that ISN'T actually in the text is not trusted blindly");
{
  const answer = "**EvoFox Blaze Ultra** is the best pick.";
  registerTierB(async () => ["EvoFox Blaze Ultra", "Totally Invented Brand"]);
  const r = await detectBrandsAI(answer, answer, {});
  check("the real brand is present", r.brands.some((b) => b.brand === "EvoFox Blaze Ultra"), JSON.stringify(r.brands));
  check("the hallucinated brand is NOT present", !r.brands.some((b) => b.brand === "Totally Invented Brand"), JSON.stringify(r.brands));
  registerTierB(null);
}

console.log("\ndetectBrandsAI: Tier B throwing is swallowed — falls back to Tier C, never crashes the caller");
{
  const answer = "**Zerodha** is the largest broker.";
  registerTierB(async () => { throw new Error("simulated Tier B failure"); });
  const r = await detectBrandsAI(answer, answer, {});
  check("still returns Tier C's result despite the throw", r.brands.some((b) => b.brand === "Zerodha"), JSON.stringify(r.brands));
  registerTierB(null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
