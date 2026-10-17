/*
 * pdf-report.test.mjs — the PDF reports' numbers (0.53.0).
 * Run: node test/pdf-report.test.mjs
 *
 * campaignReport() (a campaign's run, up to seven pages) and answerReport()
 * (one answer, two pages) on a synthetic campaign: three made-up brands,
 * three prompts, two runs. Every value checked here was worked out by hand
 * from the records below; the comments say how.
 */
import { campaignReport, REPORT_PAGES } from "../src/lib/campaignReport.js";
import { answerReport } from "../src/lib/answerReport.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const profile = { id: "p1", name: "Budget headphones", brand: { name: "Zento", url: "https://zento.in" }, competitors: [{ name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }] };
const brands = [{ name: "Zento", url: "https://zento.in", isOwn: true }, { name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }];
const prompts = [
  { id: "q1", text: "best headphones under 4000", tags: ["buying"], createdAt: 1 },
  { id: "q2", text: "zento vs kovo battery life", tags: ["comparison", "battery"], createdAt: 2 },
  { id: "q3", text: "headphones with the best mic for calls", tags: ["calls"], createdAt: 3 },
];
const runs = [{ id: "r2", profileId: "p1", startedAt: Date.UTC(2026, 8, 26) }, { id: "r1", profileId: "p1", startedAt: Date.UTC(2026, 8, 19) }];
let n = 0;
const m = (brand, count, firstIndex, passages = []) => ({ brand, count, firstIndex, passages });
const src = (domain, outcome = "cited", title = domain) => ({ url: `https://${domain}/${++n}`, domain, title, outcome, snippet: "" });
const rec = (runId, platform, promptId, extra) => ({
  captureId: `${runId}-${platform}-${promptId}`, platform, capturedAt: (runId === "r2" ? runs[0].startedAt : runs[1].startedAt) + n++,
  geo: { profileId: "p1", runId, promptId, tags: prompts.find((p) => p.id === promptId).tags },
  searched: true, userPrompt: prompts.find((p) => p.id === promptId).text, answerText: "",
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], images: [], ...extra,
});
// Run 2. Zento is named in answers 1–4 (4 of 6) and first in 1 and 3.
const r2 = [
  rec("r2", "chatgpt", "q1", {
    answerText: "The Zento Pulse is best for long commutes, with great battery life. Kovo Air is cheaper.",
    brandMentions: [m("Zento", 3, 10, ["The Zento Pulse is best for long commutes, with great battery life."]), m("Kovo", 1, 80)],
    sources: [src("zento.in"), src("smartprix.com", "cited", "Zento Pulse vs Kovo Air"), src("reddit.com", "fetched")],
    products: [{ name: "Zento Pulse", merchant: "Amazon.in + others", price: "₹3,499" }, { name: "Kovo Air", merchant: "Flipkart" }, { name: "Zento Mini", merchant: "zento.in" }],
    fanout: { search: [{ query: "best headphones under 4000 india 2026" }, { query: "zento pulse review reddit" }], shopping: [], image: [] },
  }),
  rec("r2", "gemini", "q1", { brandMentions: [m("Kovo", 2, 5), m("Zento", 1, 60)], sources: [src("91mobiles.com"), src("kovo.com")], products: [{ name: "Kovo Air", merchant: "Croma" }] }),
  rec("r2", "perplexity", "q1", { brandMentions: [m("Zento", 2, 3), m("Lumi", 1, 50)], sources: [src("smartprix.com")], fanout: { search: [{ query: "best headphones under 4000 india 2026" }], shopping: [], image: [] } }),
  rec("r2", "chatgpt", "q2", { brandMentions: [m("Kovo", 2, 4), m("Zento", 2, 30)], sources: [src("rtings.com")] }),
  rec("r2", "gemini", "q2", { brandMentions: [m("Kovo", 1, 2)], sources: [src("rtings.com", "cited", "Kovo Air review")] }),
  rec("r2", "chatgpt", "q3", { searched: false, brandMentions: [m("Lumi", 1, 1)] }),
];
// Run 1. Zento is named once (1 of 3), and never first.
const r1 = [
  rec("r1", "chatgpt", "q1", { brandMentions: [m("Kovo", 1, 2), m("Zento", 1, 40)], sources: [src("smartprix.com")] }),
  rec("r1", "gemini", "q1", { brandMentions: [m("Kovo", 1, 2)] }),
  rec("r1", "chatgpt", "q2", { brandMentions: [m("Kovo", 1, 2)] }),
];
const bundle = (over = {}) => ({ profile, prompts, runs, records: [...r2, ...r1], brands, generatedAt: Date.UTC(2026, 9, 3), ...over });
const page = (r, key) => r.pages.find((p) => p.key === key);

console.log("campaignReport: the latest run, compared with the one before");
const R = campaignReport(bundle());
check("it reports on the latest run, run 2 of 2", R.ok && R.run.label === "Run 2" && R.run.of === 2 && R.run.previous === "run 1", JSON.stringify(R.run));
check("all seven pages, in order", eq(R.pages.map((p) => p.key), REPORT_PAGES.map(([k]) => k)), R.pages.map((p) => p.key).join(","));
check("the lede names the engines and the prompts", R.lede === "How ChatGPT, Gemini and Perplexity answered 3 prompts in run 2, and where Zento showed up.", R.lede);
{
  const k = Object.fromEntries(page(R, "summary").kpis.map((t) => [t.label, t]));
  check("visibility: named in 4 of 6 answers, up 33 points from 1 of 3", k["Zento visibility"].value === "67%" && k["Zento visibility"].delta.text === "▲ 33 pts vs run 1" && k["Zento visibility"].delta.tone === 1, JSON.stringify(k["Zento visibility"]));
  check("named first: 2 of 6 answers, up from none", k["Named first"].value === "33%" && k["Named first"].sub === "2 of 6 answers" && k["Named first"].delta.text === "▲ 33 pts vs run 1", JSON.stringify(k["Named first"]));
  check("source visibility: zento.in cited in 1 of 6", k["Source visibility"].value === "17%", JSON.stringify(k["Source visibility"]));
  check("card share: 2 of 4 cards are Zento's", k["Product card share"].value === "50%", JSON.stringify(k["Product card share"]));
  check("searched the web: 5 of 6 (the memory answer didn't)", k["Answers searched the web"].value === "83%" && k["Answers searched the web"].sub === "5 of 6 answers");
}
{
  const f = page(R, "summary").findings;
  check("finding 1: a tie with Kovo is called a tie, not a lead", f[0] === "Zento was named in 67% of run 2 answers, up 33 points from run 1, level with Kovo.", f[0]);
  check("finding 2: Kovo came first or alone in 3 answers (2 ahead + 1 alone)", f[1] === "Kovo is the closest rival (67% visibility). It came before Zento, or was named without it, in 3 of 6 answers.", f[1]);
  check("finding 3: strongest and weakest engine", f[2] === "Strongest engine for Zento: Perplexity (100%). Weakest: Gemini (50%).", f[2]);
  check("finding 4: own site cited, and rtings.com cites only Kovo", f[3] === "zento.in was cited in 17% of answers. 1 independent site cited rivals but never Zento.", f[3]);
  check("finding 5: card share and its own store", f[4] === "Zento holds 50% of product cards; its own store is listed on 1 of its 2 cards.", f[4]);
}
{
  const b = page(R, "brands");
  const kovo = b.h2h.find((x) => x.name === "Kovo");
  check("head to head with Kovo: ahead 1, behind 2, only you 1, only Kovo 1, neither 1", eq([kovo.ahead, kovo.behind, kovo.onlyYou, kovo.onlyThem, kovo.neither], [1, 2, 1, 1, 1]), JSON.stringify(kovo));
  const z = b.scorecard.find((x) => x.name === "Zento");
  check("scorecard: Zento named first twice, one own-site citation, half the cards", z.namedFirst === 2 && z.ownCitations === 1 && z.cardShare === 50, JSON.stringify(z));
  const lumi = b.backing.find((x) => x.name === "Lumi");
  check("backing: Lumi's mention in the answer that never searched is from memory", lumi.memory === 1 && lumi.answers === 2, JSON.stringify(lumi));
}
{
  const p = page(R, "prompts");
  check("prompt IDs match the workbook's (by when each prompt was added)", eq(p.rows.map((r) => r.id), ["P01", "P02", "P03"]));
  const p1 = p.rows[0];
  check("P01: first on ChatGPT and Perplexity, second on Gemini; three engines name Zento, two more than run 1", eq(p1.cells.map((c) => c.pos), [1, 2, 1]) && p1.naming === 3 && p1.change === 2, JSON.stringify(p1));
  check("missing: P02 on Gemini, where Kovo was named first", p.missing.some((x) => x.id === "P02" && x.engine === "Gemini" && x.firstInstead === "Kovo"), JSON.stringify(p.missing));
  check("never first: P02, named on 1 of the 2 engines that answered", eq(p.neverFirst.map((x) => [x.id, x.naming, x.asked]), [["P02", 1, 2]]), JSON.stringify(p.neverFirst));
}
{
  const s = page(R, "sources");
  check("sources: 8 pages read, 7 cited", s.read === 8 && s.citedTotal === 7, `${s.read} / ${s.citedTotal}`);
  check("the kinds add up to every page read", s.kinds.reduce((a, k) => a + k.read, 0) === 8);
  check("rtings.com is marked rivals only: cited twice, never naming Zento", s.sites.find((x) => x.site === "rtings.com").rivalsOnly === true);
}
{
  const pr = page(R, "products");
  check("Zento's cards send buyers to Amazon.in and to zento.in, its own store", eq(pr.destinations.map((d) => [d.name, d.pct, d.own]), [["Amazon.in", 50, false], ["zento.in", 50, true]]), JSON.stringify(pr.destinations));
  check("kinds of answer: 2 shopping, 3 informational, 1 from memory", eq(pr.kinds.map((k) => [k.label, k.answers]), [["Shopping", 2], ["Informational", 3], ["From memory", 1]]), JSON.stringify(pr.kinds.map((k) => [k.label, k.answers])));
}
{
  const s = page(R, "searches");
  check("Gemini searched without showing its searches, and says so", s.perEngine.find((e) => e.engine === "Gemini").hidden === true);
  check("the search two engines ran is the most repeated", s.top[0].text === "best headphones under 4000 india 2026" && s.top[0].times === 2 && s.top[0].engines === "ChatGPT, Perplexity", JSON.stringify(s.top[0]));
}
{
  // 0.59.0: the last page is "Method". Until then it opened with four lines
  // of advice ("Get onto rtings.com.", "Watch Gemini."); the owner asked for
  // the data without the advice.
  const a = page(R, "method");
  check("the last page is the method, with no advice on it", !!a && a.title === "Method" && !("actions" in a), a && JSON.stringify(Object.keys(a)));
  check("it keeps how the numbers are measured", Array.isArray(a.definitions) && a.definitions.length > 3);
  check("the runs table has both runs, run 2 marked as the one reported", eq(a.runs.map((r) => [r.label, r.answers, Math.round(r.visibility), r.current]), [["Run 1", 3, 33, false], ["Run 2", 6, 67, true]]), JSON.stringify(a.runs.map((r) => [r.label, r.answers, Math.round(r.visibility), r.current])));
}

console.log("campaignReport: choices");
{
  const one = campaignReport(bundle({ runId: "r1" }));
  check("run 1 has nothing before it: no changes on any tile", one.run.label === "Run 1" && one.run.previous === null && page(one, "summary").kpis.every((k) => k.delta === null));
  check("and the prompt page has no change column", page(one, "prompts").hasPrevious === false);
  check("a finding says who was named most when it wasn't Zento", page(one, "summary").findings[0] === "Zento was named in 33% of run 1 answers; Kovo was named most (100%).", page(one, "summary").findings[0]);
  const some = campaignReport(bundle({ sections: ["prompts", "method"] }));
  check("left-out pages are left out; the summary always stays", eq(some.pages.map((p) => p.key), ["summary", "prompts", "method"]));
  const old = campaignReport(bundle({ sections: ["prompts", "actions"] }));
  check("a link from before 0.59.0 asking for 'actions' gets the method page", eq(old.pages.map((p) => p.key), ["summary", "prompts", "method"]));
  const gpt = campaignReport(bundle({ records: [...r2, ...r1].filter((r) => r.platform === "chatgpt"), engines: ["chatgpt"] }));
  check("one engine: only its column", eq(page(gpt, "prompts").engines, ["ChatGPT"]), JSON.stringify(page(gpt, "prompts").engines));
  const none = campaignReport(bundle({ records: [] }));
  check("no answers: an error, not an empty report", none.ok === false && /no answers/.test(none.error), JSON.stringify(none));
}

console.log("answerReport");
{
  const A = answerReport(r2[0], { previous: r1[0], profiles: [profile] });
  check("chips: a shopping answer that searched, read 3 pages and showed 3 cards", eq(A.chips.map((c) => c.text), ["Shopping answer", "Searched the web · 2 searches", "3 pages read · 2 cited", "3 product cards", "No map", "No images"]), JSON.stringify(A.chips.map((c) => c.text)));
  const k = Object.fromEntries(A.kpis.map((t) => [t.label, t]));
  check("two brands named, Zento first", k["Brands named"].value === "2" && k["Brands named"].sub === "Zento named first");
  check("2 of 3 pages cited, 1 read only", k["Pages cited"].value === "2 of 3" && k["Pages cited"].sub === "1 read only");
  check("Zento #1, up from 2nd in run 1's answer", k["Zento position"].value === "#1" && /up from 2nd/.test(k["Zento position"].sub), k["Zento position"].sub);
  check("product cards: Zento's two, and where each sends buyers", eq(A.products.map((p) => [p.name, p.isYou, p.sendsTo]), [["Zento Pulse", true, "Amazon.in"], ["Kovo Air", false, "Flipkart"], ["Zento Mini", true, "zento.in"]]), JSON.stringify(A.products.map((p) => [p.name, p.isYou, p.sendsTo])));
  check("Zento is backed by an independent page (smartprix.com names it)", A.brands[0].name === "Zento" && A.brands[0].backing.verdict === "independent", JSON.stringify(A.brands[0]));
  check("what Zento was picked for comes from its passage", /commutes/i.test(A.brands[0].pickedFor), A.brands[0].pickedFor);
  check("since last time: Zento moved up", A.changes && A.changes.items.some((c) => c.text === "Zento moved up from 2nd to 1st"), JSON.stringify(A.changes));
  check("every page opened, cited first", eq(A.opened.map((p) => [p.domain, p.cited]), [["zento.in", true], ["smartprix.com", true], ["reddit.com", false]]), JSON.stringify(A.opened.map((p) => [p.domain, p.cited])));
  check("the answer's text is in the report", A.answer.hasText && A.answer.html.includes("Zento Pulse"));
  const first = answerReport(r2[5], { previous: null, profiles: [profile] });
  // "…named first with nothing it cited behind it — easy to lose next time"
  // was still on the answer report in 0.60.1: a forecast, not a reading.
  const bare = answerReport({ ...r2[0], sources: [] }, { previous: null, profiles: [profile] });
  check("a brand named with no cited page behind it is said plainly", /^Zento was named first with no cited page behind it\.$/.test(bare.brandNote), bare.brandNote);
  const words = JSON.stringify([A.brandNote, first.brandNote, bare.brandNote, A.chips, first.chips]);
  check("no advice or forecasts on the answer report", !/easy to lose|next time|you should|consider|make sure|worth (?:targeting|pursuing)/i.test(words), words.slice(0, 200));
  check("an answer from memory: no search, no pages, and nothing to compare with", first.chips[1].text === "From memory · no search" && first.changes === null && first.opened.length === 0, JSON.stringify(first.chips));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
