/*
 * grounding-score.test.mjs — tests for Verbatim Grounding, Authority Split, and Intent Analytics.
 */

import {
  computeVerbatimGrounding,
  computeAuthoritySplit,
  computeDomainExclusivity,
  computeSearchIntentGraph,
} from "../src/lib/grounding-score.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
};

console.log("\n--- Verbatim Grounding Score ---");
{
  const text = "Apple iPhone 16 features an advanced A18 processor and incredible battery life. Samsung Galaxy S24 offers a vibrant AMOLED display.";
  const sources = [
    {
      url: "https://theverge.com/iphone-16",
      snippet: "The Apple iPhone 16 features an advanced A18 processor and long battery life.",
      domain: "theverge.com",
    },
    {
      url: "https://cnet.com/galaxy-s24",
      snippet: "Samsung Galaxy S24 offers a bright AMOLED display and powerful cameras.",
      domain: "cnet.com",
    },
  ];

  const res = computeVerbatimGrounding(text, sources);
  check("verbatim grounding score is high for matching text", res.score >= 80, `score=${res.score}`);
  check("claims are substantiated", res.groundedClaims === 2, `grounded=${res.groundedClaims}`);
  check("total claims detected correctly", res.totalClaims === 2);
  check("claim matches include source domain", res.claimMatches[0].sourceDomain === "theverge.com");

  // Zero sources edge case
  const emptyRes = computeVerbatimGrounding(text, []);
  check("zero sources yields 0 score", emptyRes.score === 0);
}

console.log("\n--- Social vs. Web Authority Split ---");
{
  const sources = [
    { url: "https://theverge.com/post1", domain: "theverge.com" },
    { url: "https://cnet.com/post2", domain: "cnet.com" },
    { url: "https://x.com/user/status/123", domain: "x.com", platformSpecific: { isSocialPost: true } },
  ];
  const social = [{ url: "https://x.com/user/status/123", author: "techguru" }];

  const split = computeAuthoritySplit(sources, social);
  check("social count is 1", split.socialCount === 1);
  check("web count is 2", split.webCount === 2);
  check("social percentage calculated correctly", split.socialPct === 33);
  check("web percentage calculated correctly", split.webPct === 67);
}

console.log("\n--- Domain Exclusivity ---");
{
  const records = [
    {
      platform: "chatgpt",
      sources: [{ url: "https://exclusive-chatgpt.com/1", domain: "exclusive-chatgpt.com" }, { url: "https://shared.com/1", domain: "shared.com" }],
    },
    {
      platform: "gemini",
      sources: [{ url: "https://exclusive-gemini.com/1", domain: "exclusive-gemini.com" }, { url: "https://shared.com/1", domain: "shared.com" }],
    },
  ];

  const excl = computeDomainExclusivity(records);
  check("exclusive domains found", excl.exclusiveDomains.length === 2, `exclusive=${excl.exclusiveDomains.length}`);
  check("shared domains found", excl.sharedDomains.length === 1);
  check("exclusive engine attributed properly", excl.exclusiveDomains.some((d) => d.domain === "exclusive-chatgpt.com" && d.exclusiveEngine === "chatgpt"));
}

console.log("\n--- Search Intent Graph ---");
{
  const records = [
    {
      platform: "perplexity",
      fanout: { search: ["iPhone 16 vs Galaxy S24 comparison", "best price for iPhone 16"] },
    },
    {
      platform: "grok",
      fanout: { search: ["Tesla Robotaxi technical specs battery", "Tesla user reviews reddit complaints"] },
    },
  ];

  const graph = computeSearchIntentGraph(records);
  check("comparison intent categorized", graph.comparison.count === 1);
  check("pricing intent categorized", graph.pricing.count === 1);
  check("technical intent categorized", graph.technical.count === 1);
  check("reviews intent categorized", graph.reviews.count === 1);

  // Captures store each search as { query }, not a bare string. Until 0.60.0
  // every one became "[object Object]" and all but the first were dropped as
  // duplicates.
  const stored = computeSearchIntentGraph([{ platform: "chatgpt", fanout: { search: [{ query: "Zento vs Kovo headphones" }, { query: "Zento Pulse price" }], shopping: [{ query: "Kovo Air review reddit" }] } }]);
  check("searches stored as { query } are each read and bucketed", stored.comparison.count === 1 && stored.pricing.count === 1 && stored.reviews.count === 1, JSON.stringify(Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v.count]))));
  check("with their own text", stored.comparison.queries[0].query === "Zento vs Kovo headphones");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
