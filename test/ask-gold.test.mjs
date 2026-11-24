/*
 * ask-gold.test.mjs — Ask's rule pass measured on the gold set (1.0.5,
 * ASK-ARCHITECTURE.md §7). Deterministic: no model.
 *
 * Every question marked as one the rules should get (rules !== false) must
 * get its expected intent, scope and ask-back exactly; the rest are counted
 * and listed (they are the model pass's job), so a change that helps or
 * hurts shows up as a number.
 * Run: node test/ask-gold.test.mjs
 */
import { buildCatalog } from "../src/lib/askCatalog.js";
import { rulePlan, resolveScope } from "../src/lib/askPlan.js";
import { data, NOW } from "./fixtures/ask-data.mjs";
import { GOLD } from "./fixtures/ask-gold.mjs";

const catalog = buildCatalog(data);
const sorted = (a) => [...(a || [])].sort().join(",");

/** What one gold question got wrong, as a list of field names. */
export function grade(g) {
  const r = rulePlan(g.q, catalog, { now: NOW });
  const res = resolveScope(r.plan, r.matches, catalog, { question: g.q, context: g.context ? { collectionId: g.context } : {} });
  const p = res.plan;
  const miss = [];
  if (g.askBack !== undefined && !!res.askBack !== g.askBack) miss.push(`askBack=${!!res.askBack}`);
  if (g.intent && p.intent !== g.intent) miss.push(`intent=${p.intent}`);
  if (g.collections && !res.askBack && sorted(p.scope.collections) !== sorted(g.collections)) miss.push(`collections=${sorted(p.scope.collections)}`);
  if (g.collections && res.askBack) miss.push("asked back");
  if (g.engines && sorted(p.scope.engines) !== sorted(g.engines)) miss.push(`engines=${sorted(p.scope.engines)}`);
  if (g.tags && sorted(p.scope.tags) !== sorted(g.tags)) miss.push(`tags=${sorted(p.scope.tags)}`);
  return miss;
}

let failures = 0;
const ruleSet = GOLD.filter((g) => g.rules !== false);
const hard = GOLD.filter((g) => g.rules === false);
console.log(`\nThe rule pass on ${ruleSet.length} questions it must get right`);
for (const g of ruleSet) {
  const miss = grade(g);
  if (miss.length) { failures++; console.log(`  ✗ ${g.q}${g.context ? ` [from ${g.context}]` : ""}  ${miss.join("; ")}`); }
}
if (!failures) console.log(`  ✓ all ${ruleSet.length}`);
const hardMiss = hard.map((g) => ({ g, miss: grade(g) })).filter((x) => x.miss.length);
console.log(`\nHarder wording (for the model pass): rules alone get ${hard.length - hardMiss.length} of ${hard.length}`);
for (const { g, miss } of hardMiss) console.log(`  · ${g.q}  ${miss.join("; ")}`);
const langs = GOLD.filter((g) => /[^\x00-\x7F]/.test(g.q) && g.rules !== false);
console.log(`\n${langs.length} of the must-get questions are in Spanish, Portuguese, French, Hindi or Arabic.`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
