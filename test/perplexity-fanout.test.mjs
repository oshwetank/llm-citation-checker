/*
 * perplexity-fanout.test.mjs — the sub-query (fan-out) path works end to end,
 * so that when real step markup lands, only the selector has to change.
 *
 * Fan-out is the set of searches an engine actually ran for one prompt, and
 * it's core GEO data: it's where "best gaming phone under 50000" is revealed
 * to have become four separate searches, and which of them surfaced which
 * source. Perplexity has ALWAYS reported 0 here.
 *
 * The cause was never the adapter. extractFanout() already accepts
 * query_plan / sub_queries / related_queries / queries, and extractSources()
 * already stamps `queryPlanQuery` onto each source inside a query_plan
 * entry. Those were dead paths purely because the DOM harvester never
 * supplied the field, and Perplexity's network payload — which would have
 * carried it — never arrives (of the 20 fields the adapter can read, only
 * query/text/web_results ever do).
 *
 * This file covers everything EXCEPT the one unknown: which element holds a
 * step's query text, which needs a real DevTools capture of the expanded
 * steps panel. Splitting it this way means the selector is the only thing
 * left to change, and these tests already prove the rest carries it.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

function extractArrow(name, arg) {
  const start = src.indexOf(`const ${name} = (${arg}) => {`);
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", src.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return null;
}

console.log("\nperplexity-fanout: the adapter carries a supplied query_plan through to the record");

// The half that is fully determined today: given the field, does a real
// record come out with fan-out populated? This is what makes the eventual
// selector change a one-liner rather than a new feature.
{
  const raw = JSON.stringify({
    query: "best gaming phone under 50000 with good battery",
    text: "## Top Picks\n**iQOO 15R** leads on battery.",
    status: "COMPLETED",
    harvestSource: "dom",
    query_plan: [
      { query: "best gaming phone under 50000 India 2026", results: [{ url: "https://a.example/1", name: "A" }] },
      { query: "iQOO 15R battery life review", results: [{ url: "https://b.example/2", name: "B" }] },
      { query: "snapdragon 8 gen 5 efficiency", results: [] },
    ],
  });

  const rec = await adapt({ captureId: "fan-1", raw, reqBody: null, capturedAt: Date.now(), pageUrl: "https://www.perplexity.ai" });

  check("fan-out is no longer zero", rec.fanout.search.length === 3, `got ${rec.fanout.search.length}`);
  check("each sub-query is carried verbatim", rec.fanout.search[1].query === "iQOO 15R battery life review", rec.fanout.search[1] && rec.fanout.search[1].query);
  check("the record is marked as having searched", rec.searched === true);
  // The richer half of query_plan: per-step results become sources, each
  // attributed back to the sub-query that surfaced it. That attribution is
  // the part a GEO tool actually wants.
  check("per-step results become sources", rec.sources.length === 2, `got ${rec.sources.length}`);
  const a = rec.sources.find((s) => s.url === "https://a.example/1");
  check("each source is attributed to the sub-query that surfaced it",
    !!a && a.platformSpecific && a.platformSpecific.queryPlanQuery === "best gaming phone under 50000 India 2026",
    a && a.platformSpecific && a.platformSpecific.queryPlanQuery);
}

// A capture with no steps must look exactly as it does today — this feature
// is additive and must never invent a fan-out that wasn't observed.
{
  const raw = JSON.stringify({
    query: "best paint for bathrooms",
    text: "Acrylic latex is best.",
    status: "COMPLETED",
    harvestSource: "dom",
  });
  const rec = await adapt({ captureId: "fan-2", raw, reqBody: null, capturedAt: Date.now(), pageUrl: "https://www.perplexity.ai" });
  check("no steps -> fan-out stays empty, nothing invented", rec.fanout.search.length === 0);
}

// NOTE: the step-EXTRACTION assertions that used to live here drove a
// harvestPerplexitySteps() built on three INVENTED selectors, against a stub
// shaped like those same guesses — so they passed while the real code matched
// nothing on a live page. Real captured markup has since replaced the guess,
// and extraction is now covered in test/perplexity-steps.test.mjs against a
// real expanded-steps panel. What remains here is the adapter path: the half
// that was always correct, kept isolated from the DOM layer.

console.log("\nperplexity-fanout: wiring");

{
  check("the steps disclosure is expanded alongside Sources",
    /PPLX_EXPAND_LABEL_RE\.test\(t\)/.test(src),
    "the steps panel must be opened or its content is never in the DOM to read");
  check("the harvester calls harvestPerplexitySteps", /queryPlan\s*=\s*harvestPerplexitySteps\(document,\s*answerText\)/.test(src));
  check("query_plan is emitted in the captured payload", /query_plan:\s*queryPlan\.length\s*\?\s*queryPlan\s*:\s*undefined/.test(src));
  // The label net must actually match what Perplexity writes on that button.
  const m = src.match(/const PPLX_STEP_LABEL_RE = (\/.*\/[a-z]*);/);
  check("PPLX_STEP_LABEL_RE is present", !!m);
  if (m) {
    const re = new RegExp(m[1].slice(1, m[1].lastIndexOf("/")), m[1].slice(m[1].lastIndexOf("/") + 1));
    check('it matches "finished 1 step" (the label seen in a real screenshot)', re.test("finished 1 step"));
    check('it matches "searched the web"', re.test("searched the web"));
    check('it does NOT match unrelated buttons', !re.test("share") && !re.test("copy"));
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
