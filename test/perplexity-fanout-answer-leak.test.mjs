/*
 * perplexity-fanout-answer-leak.test.mjs — a follow-up real capture
 * ("best camera phone under 80000") went beyond what
 * perplexity-clock-contamination.test.mjs already guards:
 *
 *   1. The clock/duration UI badge glued onto the END of an otherwise-real
 *      query string with NO separator at all —
 *      "best camera phone under 8000023:47" ("80000" + "23:47", no space,
 *      no middle-dot). The existing looksLikeClock check only matches a
 *      row that IS a clock reading start-to-end, so it never fires here;
 *      rejecting the whole row would also throw away the real query text
 *      before the glued suffix.
 *   2. The answer's own rendered content leaked in as fake sub-queries: a
 *      "##" heading and several markdown-table cells (a product name, a
 *      price, a spec list) — content that lives in what the engine WROTE,
 *      not anything it searched for.
 *
 * Fixed in harvestPerplexitySteps (content-iso.js) by (1) stripping a
 * trailing clock/duration suffix off each candidate row before the other
 * checks run, and (2) taking the rendered answerText as an optional second
 * argument and rejecting any candidate that is itself a verbatim substring
 * of the answer.
 *
 * Extracted by source-string matching, the same technique
 * perplexity-clock-contamination.test.mjs uses — a full DOM-fixture test
 * would need real captured markup for the glued-clock/leaked-heading rows,
 * which was never captured (only the resulting query_plan JSON was).
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

console.log("\nperplexity-fanout-answer-leak: harvestPerplexitySteps takes the rendered answer as a cross-check");

check("harvestPerplexitySteps() accepts an optional answerText param",
  /const harvestPerplexitySteps = \(doc, answerText = ""\) => \{/.test(src));
check("it normalizes the answer once, up front",
  /const normAnswer = norm\(answerText\)\.toLowerCase\(\);/.test(src));
check("the harvester is called with the live answerText, not just doc",
  /queryPlan = harvestPerplexitySteps\(document, answerText\);/.test(src));

console.log("\nperplexity-fanout-answer-leak: a clock/duration badge glued onto a real query is stripped, not thrown away");

const stripLit = (src.match(/let t = item\.text\.replace\((\/.*\/i)[,)]/) || [])[1];
check("the trailing-clock-strip regex literal was found", !!stripLit);

if (stripLit) {
  const re = new RegExp(stripLit.slice(1, stripLit.lastIndexOf("/")), stripLit.slice(stripLit.lastIndexOf("/") + 1));
  const strip = (s) => s.replace(re, "").trim();
  // The real bad row from the follow-up capture: "80000" + "23:47" glued
  // with no separator at all.
  check('"best camera phone under 8000023:47" strips down to the real query',
    strip("best camera phone under 8000023:47") === "best camera phone under 80000",
    strip("best camera phone under 8000023:47"));
  // The already-fixed, separated forms must keep working too.
  check('"21:51 · 1s" (a bare clock reading, already handled) still strips to empty',
    strip("21:51 · 1s") === "", strip("21:51 · 1s"));
  // A real query that just happens to end in digits must survive untouched.
  check('"Samsung Galaxy S24 review 2026" is untouched (no trailing clock shape)',
    strip("Samsung Galaxy S24 review 2026") === "Samsung Galaxy S24 review 2026");
}

console.log("\nperplexity-fanout-answer-leak: text that verbatim-matches the rendered answer is rejected");

check("candidates >= 6 chars that are a substring of the answer are dropped",
  /if \(normAnswer && t\.length >= 6 && normAnswer\.includes\(t\.toLowerCase\(\)\)\) continue;/.test(src));

// Exercise the actual substring-membership logic the fix relies on, the
// same way the source line does it, against the real leaked shapes.
{
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const answer = norm(
    "## Top camera phones under ₹80,000\n\n" +
    "| Phone | Why it's great | Price |\n" +
    "| --- | --- | --- |\n" +
    "| OnePlus 12 (16GB+512GB) | Great low-light camera | ~69,998 |\n"
  ).toLowerCase();

  const leaked = [
    "Top camera phones under ₹80,000",
    "OnePlus 12 (16GB+512GB)",
    "~69,998",
  ];
  for (const t of leaked) {
    check(`leaked answer content "${t}" is recognized as a verbatim substring of the answer`,
      t.length >= 6 && answer.includes(norm(t).toLowerCase()));
  }
  // A real sub-query the engine actually ran must NOT collide with the
  // answer's own prose.
  check('a real sub-query ("best camera phone under 80000 reviews 2026") is not flagged',
    !answer.includes(norm("best camera phone under 80000 reviews 2026").toLowerCase()));
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
