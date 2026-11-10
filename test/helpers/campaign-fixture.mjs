/*
 * A made-up campaign for tests (0.75.0): Zento against Kovo and Lumi, two
 * runs, earbuds prompts. test/insights.test.mjs works its numbers out by
 * hand; Ask's tools and the training generator are checked against it.
 */
export const T = Date.UTC(2026, 9, 18);
const D = 864e5;
const m = (brand, firstIndex) => ({ brand, count: 1, firstIndex });
const cited = (...ds) => ds.map((d) => ({ domain: d, url: `https://${d}/p`, outcome: "cited" }));
let n = 0;
const rec = (runId, platform, promptId, prompt, tags, brands, sources, extra = {}) => ({
  captureId: `c${++n}`, platform, userPrompt: prompt, answerText: "Some answer text.", brandMentions: brands, sources,
  geo: { profileId: "p1", runId, promptId, tags }, runId, capturedAt: T - (runId === "r1" ? 8 : 1) * D, ...extra,
});
export const profile = { id: "p1", name: "Earbuds India", brand: { name: "Zento", url: "https://zento.example" }, competitors: [{ name: "Kovo" }, { name: "Lumi" }] };
export const runs = [{ id: "r1", profileId: "p1", startedAt: T - 8 * D, status: "done" }, { id: "r2", profileId: "p1", startedAt: T - D, status: "done" }];
export const Q1 = "best wireless earbuds", Q2 = "earbuds for the gym", Q3 = "noise cancelling earbuds under 5000";
export const records = [
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

