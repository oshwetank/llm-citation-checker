/*
 * perplexity-steps.test.mjs — fan-out harvested from Perplexity's expanded
 * steps panel, tested against real captured markup.
 *
 * Fan-out is the set of searches an engine actually ran for one prompt.
 * Perplexity reported 0 for every capture, because nothing ever looked at
 * the steps UI and its network payload (which would carry query_plan) never
 * arrives.
 *
 * The first attempt at this shipped three INVENTED selectors and a label
 * regex that could not match the real button ("Finished2 steps" — no space,
 * so /^finished\b/ fails between "d" and "2"). It was a silent no-op on
 * every live page, and its tests passed because they were built from the
 * same guess as the code. That is the failure mode this file exists to
 * prevent: everything below runs against
 * test/fixtures/perplexity-steps-expanded.html, assembled from a user's
 * DevTools capture of a real expanded panel.
 *
 * What that capture showed each step contains:
 *   - a nested disclosure button carrying the step NAME
 *   - sub-query rows: the actual query or URL that step ran
 *   - result rows: <a rel="noopener" target="_blank"> with a title in
 *     .text-secondary and a domain label in .text-tertiary
 *
 * The harvester walks that structure in DOCUMENT ORDER rather than matching
 * class names, because the only stable landmarks are semantic ones (a
 * disclosure button, an anchor) — Perplexity's Tailwind classes have
 * already churned under this project more than once.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "./helpers/mini-dom.mjs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./fixtures/perplexity-steps-expanded.html", import.meta.url), "utf8");

function extractArrow(name, arg) {
  const start = src.indexOf(`const ${name} = (${arg}) => {`);
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", src.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
  }
  return null;
}

const labelLit = (src.match(/const PPLX_STEP_LABEL_RE = (\/.*\/[a-z]*);/) || [])[1];
// answerText is now an optional second param (the fan-out/answer-content
// cross-check — see perplexity-fanout-answer-leak.test.mjs) — extractArrow
// needs the exact literal signature to find the function.
const stepsBody = extractArrow("harvestPerplexitySteps", 'doc, answerText = ""');
check("PPLX_STEP_LABEL_RE found", !!labelLit);
check("harvestPerplexitySteps() found", !!stepsBody);

let harvest = null;
if (labelLit && stepsBody) {
  const re = new RegExp(labelLit.slice(1, labelLit.lastIndexOf("/")), labelLit.slice(labelLit.lastIndexOf("/") + 1));
  harvest = new Function("PPLX_STEP_LABEL_RE", `return (doc, answerText = "") => ${stepsBody};`)(re);
}

console.log("\nperplexity-steps: fan-out extracted from the real expanded panel");

let plan = [];
if (harvest) {
  const doc = parseHTML(html);
  plan = harvest(doc);

  check("fan-out is no longer zero", plan.length > 0, `got ${plan.length}`);
  check("both real steps are represented", new Set(plan.map((p) => p.step)).size === 2, JSON.stringify(plan.map((p) => p.step)));

  const names = [...new Set(plan.map((p) => p.step))];
  check('step name "Searching the web" is captured', names.includes("Searching the web"), names.join(" | "));
  check('step name "Checking headphone reviews" is captured', names.includes("Checking headphone reviews"), names.join(" | "));

  const queries = plan.map((p) => p.query);
  check("the real sub-query is captured, not just the step name",
    queries.includes("Best headphone under 4000"), queries.join(" | "));
  check("a step that fetched URLs records those URLs as its queries",
    queries.some((q) => q.startsWith("https://savedelete.com")) && queries.some((q) => q.startsWith("https://etadviser.com")),
    queries.join(" | "));

  const step1 = plan.find((p) => p.query === "Best headphone under 4000");
  check("step 1 carries its own retrieved results", !!step1 && step1.results.length === 3, step1 && String(step1.results.length));
  check("results carry real URLs",
    !!step1 && step1.results.every((r) => /^https:\/\//.test(r.url)),
    step1 && JSON.stringify(step1.results.map((r) => r.url)));
  check("results carry their titles",
    !!step1 && step1.results.some((r) => /Ultimate Buying Guide/.test(r.name)),
    step1 && JSON.stringify(step1.results.map((r) => r.name)));
  check("Perplexity's trusted-domain marker survives onto the result",
    !!step1 && step1.results.some((r) => r.trusted === true),
    step1 && JSON.stringify(step1.results.map((r) => r.trusted)));

  // Chrome must never be reported as a query the engine ran.
  check('"+7 more" is not reported as a sub-query', !queries.some((q) => /more$/i.test(q)), queries.join(" | "));
  check('"Finished"/"2 steps" is not reported as a sub-query',
    !queries.some((q) => /^finished$/i.test(q) || /^\d+ steps?$/i.test(q)), queries.join(" | "));
}

console.log("\nperplexity-steps: the label regex matches the REAL button");

if (labelLit) {
  const re = new RegExp(labelLit.slice(1, labelLit.lastIndexOf("/")), labelLit.slice(labelLit.lastIndexOf("/") + 1));
  // The exact string the live button renders, with no space between label
  // and count. The first version of this regex used \b and could not match.
  check('matches "finished2 steps" (the real concatenated label)', re.test("finished2 steps"));
  check('matches "finished 2 steps"', re.test("finished 2 steps"));
  check('rejects "share"', !re.test("share"));
  check('rejects "copy query"', !re.test("copy query"));
}

console.log("\nperplexity-steps: it survives pages without a steps panel");

if (harvest) {
  const plain = parseHTML('<div><p>An answer with no steps panel at all.</p></div>');
  check("a page with no steps yields no fan-out, and does not throw", harvest(plain).length === 0);

  const thrower = { querySelectorAll: () => { throw new Error("boom"); } };
  let threw = null;
  try { harvest(thrower); } catch (e) { threw = e; }
  check("a throwing document is swallowed, never costing the capture", !threw, threw && threw.message);
}

console.log("\nperplexity-steps: end-to-end through the adapter");

if (plan.length) {
  const raw = JSON.stringify({
    query: "Best headphone under 4000",
    text: "## Top Picks\n**boAt Rockerz 512 ANC** leads.",
    status: "COMPLETED",
    harvestSource: "dom",
    query_plan: plan,
  });
  const rec = await adapt({ captureId: "steps-1", raw, reqBody: null, capturedAt: Date.now(), pageUrl: "https://www.perplexity.ai" });

  check("the record reports fan-out", rec.fanout.search.length === plan.length, `got ${rec.fanout.search.length}`);
  check("the record reports it searched", rec.searched === true);
  // The headline outcome: retrieved sources the answer never cited.
  const domains = [...new Set(rec.sources.map((s) => s.domain))];
  check("step results become sources on the record", rec.sources.length >= 4, `got ${rec.sources.length}`);
  check("including ones reachable ONLY via the steps panel (pricekeeda, etadviser)",
    domains.some((d) => /pricekeeda/.test(d)) && domains.some((d) => /etadviser/.test(d)),
    domains.join(", "));
  check("each source is attributed to the sub-query that surfaced it",
    rec.sources.every((s) => s.platformSpecific && typeof s.platformSpecific.queryPlanQuery === "string"),
    JSON.stringify(rec.sources.map((s) => s.platformSpecific && s.platformSpecific.queryPlanQuery)));
}

console.log("\nperplexity-steps: wiring");

{
  check("the harvester calls harvestPerplexitySteps", /queryPlan\s*=\s*harvestPerplexitySteps\(document,\s*answerText\)/.test(src));
  check("step results are added to sources", /for \(const r of st\.results \|\| \[\]\)/.test(src));
  check("query_plan is emitted only when non-empty",
    /query_plan:\s*queryPlan\.length\s*\?\s*queryPlan\s*:\s*undefined/.test(src));
  check("no invented step selectors remain",
    !src.includes("PPLX_STEP_SELECTORS"),
    "the guessed selector list should be gone now that real markup is known");
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
