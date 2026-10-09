/*
 * cited-domains.test.mjs — the ranking behind the Analyze tab's Cited Domains
 * card. The table it replaced sorted by raw URL count, so a site fetched three
 * times and never used outranked the one the answer actually cited.
 */
import { summarizeDomains } from "../src/lib/cited-domains.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nsummarizeDomains: a citation outranks any number of fetches");
{
  const sources = [
    { domain: "bulkreviews.example", url: "https://bulkreviews.example/a", outcome: "fetched" },
    { domain: "bulkreviews.example", url: "https://bulkreviews.example/b", outcome: "fetched", type: "news" },
    { domain: "bulkreviews.example", url: "https://bulkreviews.example/c", outcome: "fetched" },
    { domain: "zentra-guide.example", url: "https://zentra-guide.example/x", outcome: "cited" },
    { domain: "kovo-blog.example", url: "https://kovo-blog.example/1", outcome: "fetched" },
    { domain: "kovo-blog.example", url: "https://kovo-blog.example/2", outcome: "cited" },
  ];
  const out = summarizeDomains(sources);
  check("domains ranked cited-first, then by total URLs",
    out.map((d) => d.domain).join(",") === "kovo-blog.example,zentra-guide.example,bulkreviews.example",
    out.map((d) => d.domain).join(","));
  check("counts split by outcome", out[0].cited === 1 && out[0].fetched === 1 && out[0].total === 2,
    JSON.stringify(out[0]));
  check("news counted", out[2].news === 1, out[2].news);
  check("a domain's cited URL is listed before its fetched ones",
    sources[out[0].sourceIdxs[0]].outcome === "cited", out[0].sourceIdxs.join(","));
}

console.log("\nsummarizeDomains: missing domain falls back to the URL's host");
{
  const out = summarizeDomains([
    { url: "https://www.zentra-guide.example/p", outcome: "cited" },
    { url: "not a url", outcome: "fetched" },
    null,
  ]);
  check("host used, www. dropped", out.length === 1 && out[0].domain === "zentra-guide.example",
    JSON.stringify(out));
  check("empty input is an empty list", summarizeDomains(undefined).length === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
