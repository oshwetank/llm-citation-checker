/*
 * brand-detail.test.mjs — the per-response comparisons behind the brand
 * drill-down.
 *
 * Reported: "when I click on any brand I don't get to know much about that
 * competition's visibility, I don't get data to analyse it. I need deep
 * information of competition as well."
 *
 * The aggregate metrics can't answer the question a competitor actually
 * raises. "Samsung: 64% visibility, 17% share of voice" is on the table
 * already; what you want to know is which answers let them in and kept you
 * out, and when you both appear, who gets named first. Both of those need the
 * PAIRING between brands within a response, which computeMetrics throws away
 * by design — it reduces each brand to its own column.
 *
 * So these two functions exist, and this file pins their arithmetic.
 */
import { headToHead, brandSourceDomains } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const TRACKED = [
  { name: "Acme", url: "acme.com", isOwn: true },
  { name: "Globex", url: "globex.com" },
];

/** A response whose answer text names brands in the given order. */
let seq = 0;
const rec = (order, sources = []) => ({
  captureId: `c${++seq}`,
  capturedAt: 1000 + seq,
  platform: "chatgpt",
  answerText: order.length ? `Consider ${order.join(", then ")} for this.` : "Nothing relevant here.",
  brandMentions: order.map((b, i) => ({ brand: b, count: 1, firstIndex: 9 + i * 20 })),
  sources,
});

console.log("\nwho gets in, and who gets named first");
{
  const records = [
    rec(["Acme", "Globex"]),      // both, Acme first
    rec(["Acme", "Globex"]),      // both, Acme first
    rec(["Globex", "Acme"]),      // both, Globex first
    rec(["Globex"]),              // them only — the actionable one
    rec(["Globex"]),
    rec(["Acme"]),                // us only
    rec([]),                      // neither
  ];
  const h = headToHead(records, TRACKED, "Globex", "Acme");

  check("every response is accounted for", h.responses === 7, String(h.responses));
  check("responses where both appear", h.both === 3, String(h.both));
  check("responses where only THEY appear — the gap worth acting on",
    h.aOnly === 2, String(h.aOnly));
  check("responses where only we appear", h.bOnly === 1, String(h.bOnly));
  check("responses where neither appears", h.neither === 1, String(h.neither));
  check("of the three shared, they led once", h.aheadA === 1, String(h.aheadA));
  check("and we led twice", h.aheadB === 2, String(h.aheadB));
  check("the four buckets partition the responses",
    h.both + h.aOnly + h.bOnly + h.neither === h.responses);
  check("and the ordering splits the shared ones",
    h.aheadA + h.aheadB + h.bothUnranked === h.both);
}

console.log("\na brand present without a position is not scored as a loss");
{
  // A carousel appearance: the detector found it, but it has no offset in the
  // prose, so there is no "who came first" to decide. Counting that as a loss
  // for either side would be inventing a result.
  const carousel = {
    captureId: "cx", capturedAt: 1, platform: "chatgpt",
    answerText: "Acme is worth a look.",
    brandMentions: [
      { brand: "Acme", count: 1, firstIndex: 0 },
      { brand: "Globex", count: 0, firstIndex: Number.MAX_SAFE_INTEGER },
    ],
    sources: [],
  };
  const h = headToHead([carousel], TRACKED, "Globex", "Acme");
  check("both count as present", h.both === 1, String(h.both));
  check("neither is credited with leading", h.aheadA === 0 && h.aheadB === 0,
    `${h.aheadA}/${h.aheadB}`);
  check("it is recorded as unranked instead", h.bothUnranked === 1, String(h.bothUnranked));
}

console.log("\nhead-to-head is symmetric");
{
  const records = [rec(["Acme", "Globex"]), rec(["Globex"]), rec(["Acme"])];
  const ab = headToHead(records, TRACKED, "Globex", "Acme");
  const ba = headToHead(records, TRACKED, "Acme", "Globex");
  check("swapping the pair swaps the columns",
    ab.aOnly === ba.bOnly && ab.bOnly === ba.aOnly && ab.aheadA === ba.aheadB,
    `${ab.aOnly}/${ab.bOnly} vs ${ba.aOnly}/${ba.bOnly}`);
  check("and leaves the shared count alone", ab.both === ba.both);
}

console.log("\ndegenerate pairs return an empty result rather than nonsense");
{
  const records = [rec(["Acme", "Globex"])];
  check("a brand against itself", headToHead(records, TRACKED, "Acme", "Acme").both === 0);
  check("an empty name", headToHead(records, TRACKED, "", "Acme").responses === 0);
  check("no records", headToHead(null, TRACKED, "Globex", "Acme").responses === 0);
}

console.log("\nthe sources cited in answers that name a brand");
{
  const src = (domain, outcome = "cited") => ({ domain, url: `https://${domain}/x${++seq}`, outcome });
  const records = [
    rec(["Globex"], [src("review.com"), src("review.com"), src("blog.com")]),
    rec(["Globex"], [src("review.com")]),
    rec(["Globex"], [src("blog.com", "fetched")]),
    // Acme-only: must not contribute to Globex's sources at all.
    rec(["Acme"], [src("elsewhere.com"), src("elsewhere.com")]),
  ];
  const doms = brandSourceDomains(records, TRACKED, "Globex");

  check("only answers naming the brand contribute",
    !doms.some((d) => d.domain === "elsewhere.com"), doms.map((d) => d.domain).join(", "));
  check("ranked by how many of those answers cited it",
    doms[0].domain === "review.com", doms.map((d) => d.domain).join(", "));
  check("citations count every occurrence", doms[0].citations === 3, String(doms[0].citations));
  check("cited responses count answers, not occurrences",
    doms[0].citedResponses === 2, String(doms[0].citedResponses));
  // The denominator is the answers MENTIONING the brand (3), not all four.
  check("visibility is over the answers that mention the brand",
    Math.round(doms[0].visibility) === 67, String(doms[0].visibility));
  check("a read-only appearance is not a citation",
    !doms.some((d) => d.domain === "blog.com" && d.citations === 0)
    && doms.find((d) => d.domain === "blog.com").citations === 1,
    JSON.stringify(doms.find((d) => d.domain === "blog.com")));
}

console.log("\nsource list stays bounded and safe");
{
  const many = [rec(["Globex"], Array.from({ length: 30 }, (_, i) =>
    ({ domain: `d${i}.com`, url: `https://d${i}.com/a`, outcome: "cited" })))];
  check("the limit is respected", brandSourceDomains(many, TRACKED, "Globex", 5).length === 5);
  check("a brand that never appears has no sources",
    brandSourceDomains(many, TRACKED, "Acme").length === 0);
  check("no records", brandSourceDomains(null, TRACKED, "Globex").length === 0);
  check("an empty name", brandSourceDomains(many, TRACKED, "").length === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
