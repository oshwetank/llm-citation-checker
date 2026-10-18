/*
 * campaign-view.test.mjs — the 0.64.0 campaign board's sections
 * (src/lib/campaignView.js) and the logo marks (src/lib/logos.js). On 0.62.2
 * neither module exists, so this file fails at import.
 *
 * A made-up campaign: Zento (zento.in) against Kovo and Lumi, three prompts
 * on ChatGPT, Perplexity and Grok. Grok hit its usage limit; ChatGPT typed one
 * prompt twice; one answer carries an ad and a site: search. Domains are
 * public sites; brands, prompts and pages are invented.
 */
import { campaignView, pageTypeOf, promptText, themeOf, themeIdOf } from "../src/lib/campaignView.js";
import { brandSlug, siteSlug, letterBadge, markSvg } from "../src/lib/logos.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const T = 1_800_000_000_000;
const profile = { id: "p1", brand: { name: "Zento", url: "https://zento.in" }, competitors: [{ name: "Kovo", url: "https://kovo.com" }, { name: "Lumi" }], engines: ["chatgpt", "perplexity", "grok"] };
const brands = [{ name: "Zento", url: "https://zento.in", isOwn: true }, { name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }];
const prompts = [
  { id: "q1", text: "best headphones under 4000", tags: [] },
  { id: "q2", text: "headphones with the best battery life", tags: [] },
  { id: "q3", text: "best mic for calls", tags: [] },
];
let t = 0;
const m = (brand, count, firstIndex, passages = []) => ({ brand, count, firstIndex, passages });
const src = (url, outcome = "cited", ps = {}) => ({ url, domain: new URL(url).hostname, title: new URL(url).hostname, outcome, snippet: "A snippet.", platformSpecific: ps });
const rec = (platform, promptId, extra) => ({
  captureId: `${platform}-${promptId}`, platform, capturedAt: T + 1000 * t++,
  geo: { profileId: "p1", runId: "r1", promptId, tags: [] }, searched: true,
  userPrompt: prompts.find((p) => p.id === promptId).text, answerText: "", answerChars: 300,
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], places: [], images: [], ads: [], ...extra,
});
const q = (query) => ({ query });

const recs = [
  rec("chatgpt", "q1", {
    userPrompt: "best headphones under 4000best headphones under 4000",
    answerText: "Zento Pulse is the pick. Kovo Air is close.",
    brandMentions: [m("Zento", 3, 10, ["Zento Pulse is the pick for long commutes."]), m("Kovo", 1, 80, ["Kovo Air is close behind."])],
    sources: [
      src("https://zento.in/pulse", "cited", { markerIds: ["turn0search0"], pubDate: (T - 10 * 864e5) / 1000, resultSource: "search" }),
      src("https://smartprix.com/best-headphones-under-4000", "cited", { markerIds: ["turn0search4"], resultSource: "news" }),
      src("https://reddit.com/r/headphones/x", "fetched"),
    ],
    products: [{ name: "Zento Pulse" }, { name: "Kovo Air" }],
    fanout: { search: [q("best headphones under 4000 india 2026"), q("zento pulse review site:reddit.com -site:quora.com")], shopping: [], image: [] },
    ads: [{ advertiser: "Kovo", targetDomain: "kovo.com", title: "Kovo Air" }],
  }),
  rec("perplexity", "q1", {
    brandMentions: [m("Kovo", 2, 5), m("Zento", 1, 60)],
    sources: [src("https://smartprix.com/best-headphones-under-4000"), src("https://91mobiles.com/x")],
    fanout: { search: [q("headphones under 4000")], shopping: [], image: [] },
  }),
  rec("grok", "q1", {
    answerChars: 0, platformSpecific: { transport: "gateway", gatewayError: "usage_limit_reached" },
    fanout: { search: [q("best headphones 4000 site:91mobiles.com")], shopping: [], image: [] },
  }),
  rec("chatgpt", "q2", { brandMentions: [m("Kovo", 2, 4), m("Lumi", 1, 20)], sources: [src("https://rtings.com/headphones/reviews/kovo-air")] }),
  rec("perplexity", "q2", { brandMentions: [m("Zento", 1, 3)], sources: [src("https://rtings.com/headphones/reviews/kovo-air"), src("https://zento.in/battery")] }),
  rec("chatgpt", "q3", { searched: false, brandMentions: [m("Lumi", 1, 1)] }),
];

const v = campaignView(recs, { profile, brands, prompts });

console.log("\nOverview: the five numbers, with the engine split");
{
  const k = Object.fromEntries(v.overview.kpis.map((x) => [x.id, x]));
  eq("share of voice over the answers that came back", k.sov.value, 41.7);
  eq("visibility", k.vis.value, 60);
  eq("average position", k.pos.value, 1.3);
  eq("mentions", k.mentions.value, 5);
  eq("responses: answered of sent", [k.responses.value, k.responses.of], [5, 6]);
  eq("rank among the brands", [k.sov.rank, k.sov.of], [1, 3]);
  eq("ChatGPT's share of voice in the split", k.sov.split.find((s) => s.engine === "chatgpt").value, 37.5);
  eq("Grok has no value, not a zero", k.sov.split.find((s) => s.engine === "grok").value, null);
  const g = v.overview.engines.find((e) => e.id === "grok");
  eq("Grok: sent, answered, stopped by its limit", [g.sent, g.answered, g.limited], [1, 0, 1]);
  const c = v.overview.engines.find((e) => e.id === "chatgpt");
  eq("ChatGPT searches, pages read and cited", [c.searches, c.read, c.cited], [2, 4, 3]);
}

console.log("\nBrands");
{
  eq("leaderboard order and named-first counts", v.brands.all.map((b) => [b.name, b.firsts]), [["Zento", 2], ["Kovo", 2], ["Lumi", 1]]);
  eq("grid row for Kovo: all, ChatGPT, Perplexity, Grok", v.brands.grid.find((r) => r.name === "Kovo").cells, [66.7, 50, null]);
}

console.log("\nPrompts");
{
  const p1 = v.prompts.find((p) => p.id === "q1");
  eq("a doubled prompt reads as asked", p1.text, "best headphones under 4000");
  eq("q1 cells: place on each engine", p1.cells.map((c) => c && (c.answered ? c.pos : c.limit ? "limit" : "none")), [1, 2, "limit"]);
  eq("q1 visibility and position over the answers", [p1.visibility, p1.avgPos], [100, 1.5]);
  eq("q1's top Zento product card", p1.topProduct, "Zento Pulse");
  const p2 = v.prompts.find((p) => p.id === "q2");
  eq("q2: absent on ChatGPT, first on Perplexity", [p2.cells[0].pos, p2.cells[1].pos, p2.visibility], [null, 1, 50]);
  eq("topics from the prompts' words when there are no tags", v.prompts.map((p) => [p.id, p.topic]).sort(), [["q1", "Price, cost & value"], ["q2", "Best, top & reviews"], ["q3", "For a person or use"]]);
}

console.log("\nCitations: every cited page, in detail");
{
  const c = v.citations;
  eq("cited pages counted, not pages read", c.total, 7);
  eq("own site", c.ownSite, 2);
  eq("same site cited by both engines for the same prompt", c.bothEngines, 4);
  const z = c.rows.find((r) => r.url === "https://zento.in/pulse");
  eq("place in the answer's citations", [z.n, z.of, z.read], [1, 2, 3]);
  eq("ChatGPT's search result rank and lane", [z.rank, c.rows.find((r) => r.domain === "smartprix.com" && r.engine === "chatgpt").rank, c.rows.find((r) => r.domain === "smartprix.com" && r.engine === "chatgpt").lane], [1, 5, "news"]);
  eq("the answer's context: your place, who came first", [z.ownPlace, z.first], [1, "Zento"]);
  eq("published date kept in ms", z.published, T - 10 * 864e5);
  eq("Perplexity sends no rank", c.rows.find((r) => r.engine === "perplexity").rank, null);
  eq("the same page cited across the run", c.rows.find((r) => r.domain === "smartprix.com").times, 2);
  eq("freshness bands", c.freshness.map((f) => f.n), [1, 0, 0, 0, 0, 6]);
  eq("kinds of page", Object.fromEntries(c.pageTypes.map((x) => [x.label, x.n])), { "Article": 3, "List of picks": 2, "Review": 2 });
  check("no page is linked to a brand", c.rows.every((r) => !("brand" in r) && !("brands" in r)));
}

console.log("\nSearches and site:");
{
  const s = v.searches;
  eq("searches per engine", s.byEngine.map((x) => [x.engine, x.n]), [["chatgpt", 2], ["perplexity", 1], ["grok", 1]]);
  eq("site: searches, the sites and the excluded ones", s.site.rows.map((r) => [r.engine, r.include, r.exclude]), [["chatgpt", ["reddit.com"], ["quora.com"]], ["grok", ["91mobiles.com"], []]]);
  eq("a scoped site later cited, checked only when there was an answer", s.site.rows.map((r) => r.laterCited), [[], null]);
  eq("own site never targeted", s.site.ownTargeted, false);
  eq("brands named inside the searches", s.brands, [{ name: "Zento", isOwn: true, n: 1 }]);
  eq("ChatGPT: share of searches using site:", s.byEngine[0].traits.find((x) => x.id === "site").pct, 50);
}

console.log("\nAds");
{
  eq("answers with an ad, of ChatGPT answers", [v.ads.withAd, v.ads.answers], [1, 3]);
  eq("advertiser is a tracked rival", v.ads.advertisers.map((a) => [a.name, a.isRival, a.isOwn]), [["Kovo", true, false]]);
  eq("advertiser named in the answer, site not cited", [v.ads.named, v.ads.cited], [1, 0]);
}

console.log("\nYou vs rival");
{
  const k = v.compare.Kovo;
  eq("named together, alone, neither", k.together, { answers: 5, both: 2, onlyMe: 1, onlyThem: 1, neither: 1, meFirst: 1, themFirst: 1 });
  eq("cards and named-first", [k.me.cards, k.them.cards, k.me.firsts, k.them.firsts], [1, 1, 2, 2]);
  eq("per prompt: places on ChatGPT for q1", k.prompts.find((p) => p.id === "q1").cells[0], { me: 1, them: 2, captureId: "chatgpt-q1" });
  eq("a quote from the answer", k.quotes.them[0].text, "Kovo Air is close behind.");
  eq("rivals listed by share of voice", v.rivals, ["Kovo", "Lumi"]);
}

console.log("\nSignals and data quality");
{
  eq("engines agree on who comes first", [v.signals.agreement.same, v.signals.agreement.of], [0, 2]);
  eq("gaps: answers without you that name two or more rivals", v.signals.gaps.map((g) => g.id), ["q2"]);
  eq("quality: doubled prompts and the usage limit", v.signals.quality.map((x) => [x.engine, x.missing, x.limited, x.doubled]), [["chatgpt", 0, 0, 1], ["perplexity", 0, 0, 0], ["grok", 1, 1, 0]]);
  eq("topics: own share against the strongest rival", v.topics.map((x) => [x.topic, x.own.sov, x.rival.name, x.rival.sov]), [["Price, cost & value", 57.1, "Kovo", 42.9], ["Best, top & reviews", 25, "Kovo", 50], ["For a person or use", 0, "Lumi", 100]]);
}

console.log("\nHelpers");
{
  eq("page types from the address", ["https://a.com/", "https://a.com/x-vs-y", "https://a.com/dp/B01", "https://a.com/news/x", "https://a.com/reviews/zento", "https://a.com/best-phones"].map(pageTypeOf), ["Homepage", "Comparison", "Product page", "News", "Review", "List of picks"]);
  eq("promptText leaves a normal prompt alone", promptText("abab"), "ab");
  // Intents that fit any brand, B2B and public sector included, in several languages (0.69.0).
  const T = [
    ["Zento vs Kovo payroll software", "Comparisons & alternatives"],
    ["alternatives to Lumi CRM", "Comparisons & alternatives"],
    ["dentist near me open now", "Local & near me"],
    ["how much does SOC 2 audit cost", "Price, cost & value"],
    ["is Kovo Bank safe and regulated", "Trust, safety & compliance"],
    ["Zento careers and salary", "Jobs & careers"],
    ["how to renew a passport", "How-to & information"],
    ["accounting software for small business", "For a person or use"],
    ["best cloud hosting providers", "Best, top & reviews"],
    ["mejor banco digital en México", "Best, top & reviews"],
    ["melhor plano de saúde para família", "For a person or use"],
    ["Lumi ou Kovo : comparatif", "Comparisons & alternatives"],
    ["सबसे अच्छा लैपटॉप", "Best, top & reviews"],
    ["おすすめのノートパソコン", "Best, top & reviews"],
    ["weather", "Other"],
  ];
  eq("intent topics for any kind of brand and language", T.map(([q]) => themeOf(q)), T.map(([, t]) => t));
  eq("topic ids", [themeIdOf("Zento vs Kovo"), themeIdOf("weather")], ["comparison", "other"]);
  eq("page types for shops in any market", ["https://shop.example/products/kettle", "https://m.example/item/123", "https://a.example/lumi-kettle-price", "https://b.example/press-releases/x"].map(pageTypeOf), ["Product page", "Product page", "Product page", "News"]);
}

console.log("\nLogos");
{
  eq("brand marks by name", [brandSlug("Motorola"), brandSlug("OnePlus"), brandSlug("Zento")], ["motorola", "oneplus", null]);
  eq("site marks by domain", [siteSlug("www.samsung.com"), siteSlug("motorola.in"), siteSlug("m.youtube.com"), siteSlug("smartprix.com")], ["samsung", "motorola", "youtube", null]);
  eq("letter badges skip a 'gadgets.' prefix and keep digits", [letterBadge("gadgets.beebom.com").letter, letterBadge("91mobiles.com").letter], ["B", "91"]);
  eq("the same site always gets the same colour", letterBadge("smartprix.com").bg, letterBadge("smartprix.com").bg);
  check("a mark draws on the brand's colour", markSvg({ slug: "motorola" }).includes('fill="#E1140A"'));
  check("no mark gives a letter badge", markSvg({ text: "smartprix.com" }).includes(">S</text>"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
