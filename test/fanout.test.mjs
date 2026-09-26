/*
 * fanout.test.mjs — covers src/lib/fanout.js: operator parsing (site: above
 * all, since that is the operator ChatGPT actually leans on), intent
 * classification, and the whole-capture rollup including the
 * scoped-but-not-cited cross-check.
 */
import { parseQueryOperators, classifyQuery, analyzeFanout, breadthVerdict, titleMatchesQueries } from "../src/lib/fanout.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nparseQueryOperators: site: scoping");
{
  const r = parseQueryOperators("best budget phone site:reddit.com");
  check("domain captured", r.siteIncludes.join() === "reddit.com", JSON.stringify(r.siteIncludes));
  check("operator stripped from the searched words", r.bare === "best budget phone", JSON.stringify(r.bare));
}
{
  const r = parseQueryOperators("review site:www.gadgets360.com/mobiles");
  check("www. and path trimmed to the bare domain", r.siteIncludes.join() === "gadgets360.com", JSON.stringify(r.siteIncludes));
}
{
  const r = parseQueryOperators("phones -site:spammy.example.com site:trusted.org");
  check("include captured", r.siteIncludes.join() === "trusted.org", JSON.stringify(r.siteIncludes));
  check("exclusion kept separate, not counted as an include", r.siteExcludes.join() === "spammy.example.com", JSON.stringify(r.siteExcludes));
}
{
  const r = parseQueryOperators("moto g45 site:flipkart.com site:amazon.in site:flipkart.com");
  check("multiple domains, de-duplicated", r.siteIncludes.length === 2, JSON.stringify(r.siteIncludes));
}

console.log("\nparseQueryOperators: other operators");
{
  const r = parseQueryOperators('"exact model name" battery life filetype:pdf after:2026-01-01');
  check("quoted phrase captured", r.phrases.join() === "exact model name", JSON.stringify(r.phrases));
  check("filetype captured", r.filetypes.join() === "pdf", JSON.stringify(r.filetypes));
  check("date filter captured", r.dateFilters.join() === "after:2026-01-01", JSON.stringify(r.dateFilters));
  check("bare text is just the real search words", r.bare === "battery life", JSON.stringify(r.bare));
}
{
  // A site: inside quotes is text, not an operator — the quote pass runs first.
  const r = parseQueryOperators('"site:example.com" guide');
  check("site: inside a quoted phrase is not treated as an operator", r.siteIncludes.length === 0, JSON.stringify(r.siteIncludes));
  check("it is kept as the phrase text", r.phrases.join() === "site:example.com", JSON.stringify(r.phrases));
}
{
  check("uppercase OR detected", parseQueryOperators("redmi OR realme").hasOr === true);
  check("the ordinary word 'or' is not an operator", parseQueryOperators("cheap or expensive phones").hasOr === false);
}
{
  const r = parseQueryOperators("plain query with no operators at all");
  check("no false positives on a plain query",
    r.siteIncludes.length === 0 && r.phrases.length === 0 && !r.hasOr && r.filetypes.length === 0,
    JSON.stringify(r));
}

console.log("\nclassifyQuery: intent labels");
{
  check("comparison", classifyQuery("iphone 17 vs galaxy s26").labels.includes("comparison"));
  check("commercial", classifyQuery("best phones under 12000").labels.includes("commercial"));
  check("pricing (₹ amount)", classifyQuery("moto g45 price ₹12,000").labels.includes("pricing"));
  check("specs", classifyQuery("redmi 15c battery mah and chipset").labels.includes("specs"));
  check("howto", classifyQuery("how to transfer data to a new android").labels.includes("howto"));
  check("definition", classifyQuery("what is an amoled display").labels.includes("definition"));
  check("review", classifyQuery("moto g45 user reviews and complaints").labels.includes("review"));
  check("temporal year flagged", classifyQuery("best phones India 2026").temporal === true);
  check("no year, not temporal", classifyQuery("best phones India").temporal === false);
  check("a query can carry several labels",
    classifyQuery("best budget phone price comparison 2026").labels.length >= 2,
    JSON.stringify(classifyQuery("best budget phone price comparison 2026").labels));
}

console.log("\nanalyzeFanout: whole-capture rollup");
{
  const queries = [
    { query: "best phones under ₹12000 India 2026" },
    { query: "moto g45 review site:reddit.com" },
    { query: "redmi 15c specs site:gadgets360.com" },
    { query: "moto g45 vs redmi 15c site:reddit.com" },
  ];
  // gadgets360 made it into the answer; reddit did not.
  const sources = [{ domain: "gadgets360.com", url: "https://www.gadgets360.com/x" }];
  const a = analyzeFanout(queries, sources);

  check("counts every query", a.count === 4, a.count);
  check("reddit.com scoped twice", a.scopedDomains.find((d) => d.domain === "reddit.com")?.count === 2, JSON.stringify(a.scopedDomains));
  check("gadgets360 marked cited", a.scopedDomains.find((d) => d.domain === "gadgets360.com")?.cited === true, JSON.stringify(a.scopedDomains));
  check("reddit marked NOT cited", a.scopedDomains.find((d) => d.domain === "reddit.com")?.cited === false, JSON.stringify(a.scopedDomains));
  check("scopedNotCited lists exactly reddit.com", a.scopedNotCited.join() === "reddit.com", JSON.stringify(a.scopedNotCited));
  check("site: counted in the operator tally", a.operators.find((o) => o.key === "site:")?.count === 3, JSON.stringify(a.operators));
  check("intents rolled up", a.intents.some((i) => i.key === "comparison") && a.intents.some((i) => i.key === "commercial"), JSON.stringify(a.intents));
  check("avgWords computed", a.avgWords > 0, a.avgWords);
  check("temporal query counted once", a.temporalCount === 1, a.temporalCount);
  check("per-query detail returned for each", a.perQuery.length === 4, a.perQuery.length);
}

console.log("\nanalyzeFanout: accepts plain strings and degrades safely");
{
  check("plain string array works", analyzeFanout(["best phone site:x.com"]).scopedDomains.length === 1);
  const empty = analyzeFanout([], []);
  check("empty input -> count 0, no throw", empty.count === 0, JSON.stringify(empty.count));
  check("empty input -> 'none' band", empty.benchmark.band === "none", JSON.stringify(empty.benchmark));
  check("null input -> no throw", analyzeFanout(null).count === 0);
  check("junk entries ignored", analyzeFanout([null, 42, {}, { query: "" }, { query: "ok site:a.com" }]).count === 1);
}

console.log("\nbreadthVerdict: reads against the published benchmark");
{
  check("0 -> none", breadthVerdict(0).band === "none");
  check("1 -> narrow", breadthVerdict(1).band === "narrow");
  check("8 -> typical (the study's most common bucket)", breadthVerdict(8).band === "typical");
  check("20 -> broad", breadthVerdict(20).band === "broad");
}

console.log("\ntitleMatchesQueries: does a read-but-uncited page's title echo what was searched");
{
  // 0.45.2 compared raw words, so "shoe" never met "shoes" and every page
  // using the other form was flagged; a shared filler word ("best") counted
  // as a match; and a site: operator's domain could match a title.
  const q = ["best running shoes for flat feet", { query: "luxury watches under 5000" }];
  check("singular title vs plural query", titleMatchesQueries("Running Shoe Picks", q) === true);
  check("plural -es form (watches / watch)", titleMatchesQueries("How to pick a watch", q) === true);
  check("nothing in common", titleMatchesQueries("Our company history", q) === false);
  check("sharing only a filler word is not a match",
    titleMatchesQueries("Best deals of 2026", ["best budget phone 2026"]) === false);
  check("a site: operator's domain is not what was searched for",
    titleMatchesQueries("Reddit - Dive into anything", ["phone deals site:reddit.com"]) === false);
  check("punctuation doesn't hide a word",
    titleMatchesQueries("Flat-feet: a runner's guide", q) === true);
  check("non-Latin scripts compare too",
    titleMatchesQueries("फोन की समीक्षा", ["सबसे अच्छा फोन"]) === true);
  check("no searches → no verdict", titleMatchesQueries("Anything", []) === null);
  check("no title → no verdict", titleMatchesQueries("", q) === null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
