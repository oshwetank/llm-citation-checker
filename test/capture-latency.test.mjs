/*
 * capture-latency.test.mjs — a capture must be derivable without waiting on
 * the optional on-device AI tier.
 *
 * Reported: "I ran a prompt, read the whole answer, then checked the tool and
 * the prompt data was not there — it came after 20 sec."
 *
 * Cause: the adapters called detectBrandsAI(), so adapt() — and therefore
 * storeCapture(), the database write, and the panel notification — could not
 * finish until Chrome's on-device model had run an inference over up to 6000
 * characters. On a machine where that model is available (this user's, proved
 * by brand names arriving upgraded to full product names) that is tens of
 * seconds AFTER the answer has already finished rendering.
 *
 * The fix must not change the RESULT, only when it lands: the deterministic
 * detector's output is stored and shown immediately, and the AI pass upgrades
 * the stored record afterwards. Both halves are asserted here.
 *
 * A slow Tier B extractor stands in for the on-device model: Tier A is
 * unreachable in Node by construction, and registerTierB() reaches the exact
 * same merge path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { adapt as adaptChatGpt } from "../src/adapters/chatgpt.js";
import { registerTierB, enrichBrandsWithAI } from "../src/lib/ai-brands.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const SLOW_MS = 1500;
let tierBCalls = 0;
registerTierB(async (text) => {
  tierBCalls++;
  await new Promise((r) => setTimeout(r, SLOW_MS));
  // A fuller form of a name the structural detector already found, which is
  // exactly what the real tier does ("Vivo" -> "vivo X200 FE").
  return /OnePlus/i.test(text) ? ["OnePlus Nord CE6 5G"] : ["Nothing Phone 3"];
});

const raw = readFileSync(path.join(FIX, "chatgpt-search-40k.txt"), "utf8");

console.log("\nderiving a capture never waits on the AI tier");
{
  const t0 = Date.now();
  const rec = await adaptChatGpt({
    captureId: "lat1", raw, capturedAt: Date.now(), pageUrl: "https://chatgpt.com/",
  });
  const elapsed = Date.now() - t0;

  check("adapt() produced brands", (rec.brandMentions || []).length > 0, String((rec.brandMentions || []).length));
  check(`adapt() finished well inside the AI tier's ${SLOW_MS}ms`, elapsed < SLOW_MS, `${elapsed}ms`);
  check("the AI tier was not called during adapt()", tierBCalls === 0, `calls=${tierBCalls}`);
}

console.log("\nthe AI tier still runs, and still improves the same result");
{
  const rec = await adaptChatGpt({
    captureId: "lat2", raw, capturedAt: Date.now(), pageUrl: "https://chatgpt.com/",
  });
  const before = rec.brandMentions.map((b) => b.brand);
  const improved = await enrichBrandsWithAI(rec.brandMentions, rec.answerText);

  check("the AI tier was called by the enrichment step", tierBCalls === 1, `calls=${tierBCalls}`);
  check("enrichment returned an improved list", Array.isArray(improved) && improved.length > 0);
  check("it upgraded a name in place rather than duplicating it",
    improved.length === before.length, `${before.length} -> ${improved && improved.length}`);
  check("the fuller name is present after enrichment",
    improved.some((b) => /Nord CE6 5G|Nothing Phone 3/i.test(b.brand)),
    improved.map((b) => b.brand).join(", "));
  // The point of the whole design: nothing is lost by storing first.
  check("no brand the detector found was dropped",
    before.every((n) => improved.some((b) => b.brand === n || b.brand.startsWith(n))),
    improved.map((b) => b.brand).join(", "));
}

console.log("\nenrichment declines safely when there is nothing to work with");
{
  check("empty text returns null", (await enrichBrandsWithAI([], "")) === null);
  check("whitespace-only text returns null", (await enrichBrandsWithAI([], "   ")) === null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
