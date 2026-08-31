/*
 * nano-stance.test.mjs — per-brand stance from the on-device model.
 *
 * Share of voice counts every mention identically, so "the Rockerz 512 is the
 * best pick" and "avoid the Rockerz 512, it overheats" score the same. For a
 * tool that exists to report how AI engines talk about a brand, those are
 * close to opposite findings. Keywords can't reliably tell them apart —
 * the sentiment usually sits in a clause some distance from the name — which
 * makes it a genuine fit for the on-device model.
 *
 * What this file pins down is the SAFETY contract, because that is where an
 * optional AI tier does damage if it's wrong:
 *
 *   - Gemini Nano is hardware-gated and absent on many machines. Everything
 *     here must degrade to "no stance" rather than a guess.
 *   - `stance: null` means NOT ASSESSED. It must never be rendered or stored
 *     as "neutral" — "we didn't look" and "we looked and it was neutral" are
 *     different claims, and only the first is true without the model.
 *   - The stance pass annotates brands that already exist. It must never be
 *     able to add, remove or rename one, so a bad verdict can't reshape the
 *     brand list.
 *
 * The model itself cannot run here (no GPU in CI, and see nano.js's header),
 * so these drive the real exported functions with the model unavailable —
 * which is precisely the path most users are on.
 */
import { readFileSync } from "node:fs";
import { enrichBrandStance } from "../src/lib/ai-brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const BRANDS = [
  { brand: "boAt", count: 3, passages: ["boAt Rockerz 512 is the best pick"] },
  { brand: "Sony", count: 2, passages: ["Sony WH-CH520 is balanced"] },
];
const TEXT = "The boAt Rockerz 512 is the best pick. Avoid the Sony WH-CH520 at this price.";

console.log("\nnano-stance: degrades safely when the model is unavailable");

{
  // No LanguageModel global exists in Node, so this is the real
  // no-model path — the one most users are on.
  const out = await enrichBrandStance(BRANDS, TEXT, "best headphones");
  check("returns null rather than inventing verdicts", out === null, JSON.stringify(out));
}

{
  const out = await enrichBrandStance([], TEXT, "q");
  check("no brands -> null, no throw", out === null);
}
{
  const out = await enrichBrandStance(BRANDS, "", "q");
  check("no text -> null, no throw", out === null);
}
{
  const out = await enrichBrandStance(null, null, null);
  check("all-null input -> null, no throw", out === null);
}

console.log("\nnano-stance: the contract the caller depends on");

{
  const src = readFileSync(new URL("../src/lib/ai-brands.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function enrichBrandStance"));

  check("it only annotates — never pushes or splices the brand list",
    !/\.push\(|\.splice\(|\.filter\(/.test(body.slice(0, body.indexOf("\n}"))),
    "the stance pass must not be able to change which brands exist");
  check("it returns a NEW array rather than mutating the caller's",
    /list\.map\(/.test(body), "must not mutate the brands passed in");
  check("every failure path returns null", /catch \(_\) \{\s*return null;/.test(body));
  check("it is gated on the model actually being available", /isNanoAvailable\(\)/.test(body));
}

{
  const nano = readFileSync(new URL("../src/lib/nano.js", import.meta.url), "utf8");
  const fn = nano.slice(nano.indexOf("export async function classifyBrandStanceWithNano"));

  // The model must not be able to introduce a brand through this path.
  check("verdicts are accepted only for brands we asked about",
    /names\.some\(\(n\) => n\.toLowerCase\(\) === key\)/.test(fn),
    "a verdict for an unrequested brand must be discarded");
  check("only the three allowed verdicts are accepted",
    /new Set\(\["recommended", "mentioned", "negative"\]\)/.test(fn));
  check("output is schema-constrained", /responseConstraint: STANCE_SCHEMA/.test(fn));
  check("the call is timeout-bounded like the other Nano paths",
    (fn.match(/withTimeout\(/g) || []).length >= 2);
  check("the session is always destroyed", /session\?\.destroy\?\.\(\)/.test(fn));
  check("the prompt forbids using outside knowledge about the brand",
    /do not use outside knowledge/i.test(nano));
  check('it is told to answer "mentioned" when unsure, not to guess',
    /when in doubt, answer/i.test(nano));
}

console.log("\nnano-stance: wiring, and what the UI is allowed to claim");

{
  const bg = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../ui/panel.js", import.meta.url), "utf8");

  check("the background runs the stance pass", /enrichBrandStance\(/.test(bg));
  check("stance failure cannot discard the brand-name enrichment",
    /const finalBrands = withStance \|\| improved;/.test(bg),
    "a null stance result must fall back to the improved list, not to nothing");
  check("the record is only rewritten when something was produced",
    /if \(!finalBrands\) return;/.test(bg));

  // The honesty property: absence of a verdict is not a neutral verdict.
  check("the UI renders a chip ONLY for an explicit recommended/negative verdict",
    /b\.stance === "recommended" \|\| b\.stance === "negative"/.test(panel),
    "null/mentioned must render nothing at all");
  check("there is no chip that would present 'not assessed' as neutral",
    !/stance-mentioned|stance-neutral|stance-null/.test(panel));
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
