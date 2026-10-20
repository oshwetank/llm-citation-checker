/*
 * What a campaign's answers show, worked out in code (src/lib/insights.js,
 * 0.74.0). Run: node test/insights.test.mjs
 *
 * A made-up campaign (Zento against Kovo and Lumi), two runs, numbers worked
 * out by hand below. The same findings feed Ask's tools, the board and the
 * hand-off, so they are pinned exactly.
 */
import { campaignInsights, brandTrend } from "../src/lib/insights.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const T = Date.UTC(2026, 9, 18);
const D = 864e5;
const m = (brand, firstIndex) => ({ brand, count: 1, firstIndex });
const cited = (...ds) => ds.map((d) => ({ domain: d, url: `https://${d}/p`, outcome: "cited" }));
let n = 0;
const rec = (runId, platform, promptId, prompt, tags, brands, sources, extra = {}) => ({
  captureId: `c${++n}`, platform, userPrompt: prompt, answerText: "Some answer text.", brandMentions: brands, sources,
  geo: { profileId: "p1", runId, promptId, tags }, runId, capturedAt: T - (runId === "r1" ? 8 : 1) * D, ...extra,
});
const profile = { id: "p1", name: "Earbuds India", brand: { name: "Zento", url: "https://zento.example" }, competitors: [{ name: "Kovo" }, { name: "Lumi" }] };
const runs = [{ id: "r1", profileId: "p1", startedAt: T - 8 * D, status: "done" }, { id: "r2", profileId: "p1", startedAt: T - D, status: "done" }];
const Q1 = "best wireless earbuds", Q2 = "earbuds for the gym", Q3 = "noise cancelling earbuds under 5000";
const records = [
  rec("r2", "chatgpt", "q1", Q1, ["Earbuds", "Budget"], [m("Zento", 0), m("Kovo", 30)], cited("rtings.com", "zento.example"),
    { products: [{ name: "Zento Pulse 2" }, { name: "Kovo Air" }], fanout: { search: ["best earbuds 2026", "Zento Pulse 2 review"] }, ads: [{ advertiser: "Kovo" }] }),
  rec("r2", "perplexity", "q1", Q1, ["Earbuds", "Budget"], [m("Kovo", 0), m("Lumi", 20)], cited("rtings.com", "techradar.com")),
  rec("r2", "chatgpt", "q2", Q2, ["Sport"], [m("Kovo", 0), m("Lumi", 15)], cited("gadgets360.com")),
  rec("r2", "perplexity", "q2", Q2, ["Sport"], [m("Lumi", 0), m("Kovo", 10)], cited("gadgets360.com")),
  rec("r2", "chatgpt", "q3", Q3, ["Earbuds"], [m("Lumi", 0), m("Zento", 40)], cited("reddit.com")),
  rec("r2", "grok", "q3", Q3, ["Earbuds"], [], [], { answerText: "", platformSpecific: { gatewayError: "usage_limit_reached" } }),
  rec("r1", "chatgpt", "q1", Q1, ["Earbuds"], [m("Zento", 0)], cited("rtings.com")),
  rec("r1", "perplexity", "q1", Q1, ["Earbuds"], [m("Zento", 0), m("Kovo", 10)], cited("rtings.com")),
  // Another campaign's answer, never counted here.
  { captureId: "other", platform: "chatgpt", userPrompt: Q1, answerText: "x", brandMentions: [m("Zento", 0)], sources: [], geo: { profileId: "p2", runId: "rx" }, runId: "rx" },
];

const I = campaignInsights({ records, profile, runs });
console.log("the run");
check("the latest finished run, its answered prompts only", I.run.id === "r2" && I.run.answers === 5 && I.previousRun.id === "r1", JSON.stringify({ run: I.run, prev: I.previousRun }));
const z = I.overview.find((b) => b.brand === "Zento");
check("your visibility: 2 of 5 answers = 40%", z.yours && z.visibility === 40, JSON.stringify(z));
check("down 60 points since the last run (100%)", I.changes.find((c) => c.brand === "Zento").visibility === -60);
check("per engine", I.byEngine.map((e) => `${e.engine}:${e.answers}`).join() === "chatgpt:3,perplexity:2");

console.log("\nprompts");
check("missing: the gym prompt, where both rivals appear and you don't", I.absent.length === 1 && I.absent[0].prompt === Q2 && I.absent[0].rivalsNamed.sort().join() === "Kovo,Lumi", JSON.stringify(I.absent));
check("behind: the noise-cancelling prompt, where Lumi is named before you", I.behind.length === 1 && I.behind[0].prompt === Q3);
check("engines disagree on who comes first in two prompts", I.disagreements.length === 2 && I.disagreements[0].first.chatgpt === "Zento" && I.disagreements[0].first.perplexity === "Kovo", JSON.stringify(I.disagreements));

console.log("\nrivals");
const k = I.rivalWins.find((r) => r.brand === "Kovo"), l = I.rivalWins.find((r) => r.brand === "Lumi");
check("Kovo: named first twice, in three answers without you, never ahead of you", k.namedFirst === 2 && k.inAnswersWithoutYou === 3 && k.aheadOfYou === 0, JSON.stringify(k));
check("Lumi: named first twice, three without you, once ahead of you", l.namedFirst === 2 && l.inAnswersWithoutYou === 3 && l.aheadOfYou === 1, JSON.stringify(l));

console.log("\nsources");
check("sites cited for rivals but never where you're named: gadgets360 (2), techradar (1)", I.sources.gaps.map((g) => `${g.site}:${g.withRivalsOnly}`).join() === "gadgets360.com:2,techradar.com:1", JSON.stringify(I.sources.gaps.map((g) => g.site)));
check("your own site: 1 of 7 citations = 14.3%", I.sources.ownSiteCitations === 1 && I.sources.citations === 7 && I.sources.ownSiteShare === 14.3, JSON.stringify(I.sources));
check("your site is never a gap, and is labelled yours", !I.sources.gaps.some((g) => g.site === "zento.example") && I.sources.top.find((s) => s.site === "zento.example").kind === "Your site");

console.log("\ntopics, cards, searches, ads, data");
check("topics by primary tag: Earbuds 3 answers, you in 66.7%; Sport 0%", I.topics.map((t) => `${t.topic}:${t.answers}:${t.yourVisibility}`).join() === "Earbuds:3:66.7,Sport:2:0", JSON.stringify(I.topics));
check("product cards: one answer, Zento first", I.products.answersWithCards === 1 && I.products.byBrand.find((b) => b.brand === "Zento").firstCards === 1);
check("searches: 2, one naming you", I.searches.total === 2 && I.searches.namingYou === 1);
check("ads: Kovo, once", I.ads.answersWithAds === 1 && I.ads.advertisers[0].advertiser === "Kovo");
check("Grok hit its usage limit: captured, no answer", I.quality.find((q) => q.engine === "grok").usageLimit === 1 && I.quality.find((q) => q.engine === "grok").withAnswer === 0);
check("every finding links its answers", I.absent[0].ids.length === 2 && I.refs.size >= 5 && I.refs.get(I.absent[0].ids[0]).engine);
check("another campaign's answer is never counted", !I.refs.has("other"));

console.log("\nonly some engines");
const P = campaignInsights({ records, profile, runs, engines: ["perplexity"] });
check("Perplexity alone: 2 answers, you in none", P.run.answers === 2 && P.overview.find((b) => b.brand === "Zento").visibility === 0);

console.log("\ntrend");
const t = brandTrend({ records, profile, runs, brand: "Zento" });
check("oldest first: 100% then 40%", t.map((x) => x.visibility).join() === "100,40", JSON.stringify(t));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
