/*
 * campaign-board.test.mjs — a campaign's results as the canvas lays them out
 * (0.50.0). src/lib/campaignBoard.js works out every section of the board
 * for one brand ("viewing as"); on 0.49.0 the module doesn't exist, so this
 * file fails at import.
 *
 * A made-up campaign: brand Zento (zento.in) against Kovo and Lumi, three
 * prompts, two runs on ChatGPT, Gemini and Perplexity. Domains are public
 * sites; brands, prompts and pages are invented.
 */
import { campaignBoard, cardIsBrand, brandDetail, promptsInScope } from "../src/lib/campaignBoard.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const profile = { id: "p1", name: "Budget headphones", brand: { name: "Zento", url: "https://zento.in" }, competitors: [{ name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }], engines: ["chatgpt", "gemini", "perplexity"] };
const brands = [
  { name: "Zento", url: "https://zento.in", isOwn: true },
  { name: "Kovo", url: "https://kovo.com" },
  { name: "Lumi", url: "" },
];
const prompts = [
  { id: "q1", text: "best headphones under 4000", tags: ["buying"], active: true },
  { id: "q2", text: "zento vs kovo battery life", tags: ["comparison", "battery"], active: true },
  { id: "q3", text: "headphones with the best mic for calls", tags: ["calls"], active: true },
];
const runs = [{ id: "r2", startedAt: 2000 }, { id: "r1", startedAt: 1000 }];

let n = 0;
const m = (brand, count, firstIndex, passages = []) => ({ brand, count, firstIndex, passages });
const src = (domain, outcome = "cited", title = domain) => ({ url: `https://${domain}/${++n}`, domain, title, outcome, snippet: "" });
const rec = (runId, platform, promptId, extra) => ({
  captureId: `${runId}-${platform}-${promptId}`, platform, capturedAt: (runId === "r2" ? 2000 : 1000) + n++,
  geo: { profileId: "p1", runId, promptId, tags: prompts.find((p) => p.id === promptId).tags },
  searched: true, userPrompt: prompts.find((p) => p.id === promptId).text, answerText: "",
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], places: [], images: [], ...extra,
});

// Run 2 (latest): Zento first on ChatGPT and Perplexity for q1, cited on ChatGPT.
const r2 = [
  rec("r2", "chatgpt", "q1", {
    brandMentions: [m("Zento", 3, 10, ["The Zento Pulse is best for long commutes, with great battery life."]), m("Kovo", 1, 80)],
    sources: [src("zento.in"), src("smartprix.com", "cited", "Zento Pulse vs Kovo Air"), src("reddit.com", "fetched")],
    products: [{ name: "Zento Pulse", merchant: "Amazon.in + others" }, { name: "Kovo Air", merchant: "Flipkart" }, { name: "Zento Mini", merchant: "zento.in" }],
    fanout: { search: [{ query: "best headphones under 4000 india 2026" }, { query: "zento pulse review reddit" }], shopping: [], image: [] },
  }),
  rec("r2", "gemini", "q1", {
    brandMentions: [m("Kovo", 2, 5, ["Kovo Air is known for comfort."]), m("Zento", 1, 60)],
    sources: [src("91mobiles.com"), src("kovo.com")],
    products: [{ name: "Kovo Air", merchant: "Croma" }],
  }),
  rec("r2", "perplexity", "q1", {
    brandMentions: [m("Zento", 2, 3), m("Lumi", 1, 50)],
    sources: [src("smartprix.com")],
    fanout: { search: [{ query: "best headphones under 4000 india 2026" }], shopping: [], image: [] },
  }),
  rec("r2", "chatgpt", "q2", { brandMentions: [m("Kovo", 2, 4), m("Zento", 2, 30)], sources: [src("rtings.com")] }),
  rec("r2", "gemini", "q2", { brandMentions: [m("Kovo", 1, 2)], sources: [src("rtings.com", "cited", "Kovo Air review")] }),
  rec("r2", "chatgpt", "q3", { searched: false, brandMentions: [m("Lumi", 1, 1)] }),
];
// Run 1: Zento named less.
const r1 = [
  rec("r1", "chatgpt", "q1", { brandMentions: [m("Kovo", 1, 2), m("Zento", 1, 40)], sources: [src("smartprix.com")] }),
  rec("r1", "gemini", "q1", { brandMentions: [m("Kovo", 1, 2)] }),
  rec("r1", "chatgpt", "q2", { brandMentions: [m("Kovo", 1, 2)] }),
];
const all = [...r2, ...r1];

console.log("\nKPIs for the brand viewed, with the change since the run before");
const b = campaignBoard(r2, { profile, brands, viewAs: "Zento", prompts, runs, runId: "r2", all });
{
  const t = Object.fromEntries(b.focus.mentions.map((x) => [x.label, x]));
  check("visibility: named in 4 of 6 answers", t.Visibility.value === "67%" && /4 of 6/.test(t.Visibility.sub), JSON.stringify(t.Visibility));
  check("the change since run 1 is worked out", b.previousLabel === "run 1" && /▲ \d+ pts since run 1/.test(t.Visibility.delta.text) && t.Visibility.delta.tone === 1, JSON.stringify(t.Visibility.delta));
  check("citations of zento.in", t.Citations.value === "1" && /zento\.in/.test(t.Citations.sub), JSON.stringify(t.Citations));
  const p = Object.fromEntries(b.focus.products.map((x) => [x.label, x]));
  check("product cards: 2 of the 4 cards are Zento's", p["Card share"].value === "50%" && p["Your cards"].value === "2", JSON.stringify([p["Card share"], p["Your cards"]]));
  check("own store offered on 1 of Zento's 2 cards", p["Own store offered"].value === "1 of 2", JSON.stringify(p["Own store offered"]));
  check("views that don't apply are marked", b.available.products && !b.available.local, JSON.stringify(b.available));
  check("cardIsBrand needs the brand as a whole word", cardIsBrand({ name: "Zento Pulse" }, "Zento") && !cardIsBrand({ name: "Zentopia X" }, "Zento"));
}

console.log("\nBy kind of answer, and products");
{
  const k = Object.fromEntries(b.byKind.map((x) => [x.id, x]));
  check("shopping answers counted", k.shopping.answers === 2 && k.all.answers === 6, `${k.shopping.answers}/${k.all.answers}`);
  check("an answer from memory has no 'site cited' figure", k.memory.answers === 1 && k.memory.cited === null);
  const top = b.products.rows[0];
  check("product cards across the campaign, most shown first", top.name === "Kovo Air" && top.shown === 2 && top.engines.join() === "chatgpt,gemini", JSON.stringify(top));
  check("where Zento's cards send buyers", b.products.destinations.map((d) => d.name).join() === "Amazon.in,zento.in" && b.products.destinations[1].own, JSON.stringify(b.products.destinations));
}

console.log("\nBrands, engines, runs, topics");
{
  check("every tracked brand compared, yours first", b.brandRows[0].name === "Zento" && b.brandRows.length === 3, b.brandRows.map((r) => r.name).join());
  const e = Object.fromEntries(b.byEngine.map((x) => [x.id, x]));
  check("by engine: Zento on every ChatGPT answer", Math.round(e.chatgpt.visibility) === 67 && e.perplexity.visibility === 100, JSON.stringify(b.byEngine));
  check("data collected", b.collected.answers === 6 && b.collected.searched === 5 && b.collected.searches === 3, JSON.stringify(b.collected));
  const z = b.acrossRuns.rows.find((r) => r.name === "Zento");
  check("visibility across runs, oldest first, with the change", b.acrossRuns.runs.map((r) => r.label).join() === "Run 1,Run 2" && z.cells.join() === "33,67" && z.delta === 34, JSON.stringify(z));
  const heatZ = b.heat.rows.find((r) => r.name === "Zento");
  check("each brand on each engine", b.heat.engines.map((x) => x.id).join() === "chatgpt,gemini,perplexity" && heatZ.cells.join() === "67,50,100", JSON.stringify(heatZ));
  const calls = b.topics.find((t) => t.tag === "calls");
  check("by topic: the weakest gap first, against the strongest rival", b.topics[0].tag === "calls" && calls.rival === "Lumi" && calls.gap === -100, JSON.stringify(b.topics));
}

console.log("\nWhat they're recommended for, sites, searches");
{
  const z = b.recommend.find((r) => r.name === "Zento");
  check("what the engines recommend Zento for", z && z.aspects.some((a) => a.label === "Long commutes"), JSON.stringify(b.recommend));
  const kinds = Object.fromEntries(b.siteKinds.rows.map((r) => [r.label, r]));
  check("kinds of sites cited", kinds["Your site"].n === 1 && kinds["Rival brand sites"].n === 1 && b.siteKinds.total === 7, JSON.stringify(b.siteKinds));
  check("sites that cite rivals but never mention Zento", b.gapSites.map((g) => g.site).join() === "rtings.com" && b.gapSites[0].rivals.join() === "Kovo", JSON.stringify(b.gapSites));
  check("a site whose page mentions Zento is not a gap", !b.gapSites.some((g) => g.site === "smartprix.com"));
  check("searches the engines ran", b.searches.total === 3 && Math.round(b.searches.year) === 67 && Math.round(b.searches.reddit) === 33, JSON.stringify(b.searches));
  const q = b.searches.top[0];
  check("the most-run search, and who led when it ran", q.text === "best headphones under 4000 india 2026" && q.n === 2 && q.lead === "Zento", JSON.stringify(q));
}

console.log("\nPrompt by prompt");
{
  const p = b.prompts.rows;
  check("one row per tracked prompt", p.length === 3, p.length);
  check("where Zento came on each engine (#1, #2, #1)", p[0].cells.map((c) => c && c.pos).join() === "1,2,1", JSON.stringify(p[0].cells));
  check("and which answers cited zento.in", p[0].cells[0].cited && p[0].citedYou === 1);
  check("not named shows as 0", p[1].cells[1].pos === 0, JSON.stringify(p[1].cells));
  check("an engine with no answer is empty", p[2].cells[1] === null);
  check("rows say first / lower / not named", p.map((r) => r.status).join() === "first,lower,not", p.map((r) => r.status).join());
  check("earlier runs are kept", p[0].history.length === 1 && p[0].history[0].label === "Run 1", JSON.stringify(p[0].history));
}

console.log("\nViewing as a competitor");
{
  const k = campaignBoard(r2, { profile, brands, viewAs: "Kovo", prompts, runs, runId: "r2", all });
  check("the board is about Kovo", k.view.name === "Kovo" && k.prompts.rows[0].cells.map((c) => c && c.pos).join() === "2,1,0", JSON.stringify(k.prompts.rows[0].cells));
  check("its own site is kovo.com", k.asSource.domain === "kovo.com" && k.asSource.citations === 1, JSON.stringify(k.asSource));
}

console.log("\nLimited to one engine");
{
  // The board lists the campaign's engines even before they answer, so a
  // missing one shows; but with the engine filter on ChatGPT, a Gemini row of
  // zeros in "by engine" and an empty Gemini column in the prompt grid only
  // say "nothing here" about an engine you asked not to see.
  const only = r2.filter((r) => r.platform === "chatgpt");
  const c = campaignBoard(only, { profile, brands, viewAs: "Zento", prompts, runs, runId: "r2", all: all.filter((r) => r.platform === "chatgpt"), engineFilter: ["chatgpt"] });
  check("only that engine's row and column", c.engines.map((e) => e.id).join() === "chatgpt" && c.byEngine.length === 1 && c.prompts.rows.every((p) => p.cells.length === 1),
    JSON.stringify({ engines: c.engines, byEngine: c.byEngine.length }));
  const none = campaignBoard(only, { profile, brands, viewAs: "Zento", prompts, runs, runId: "r2", all });
  check("without the filter, an engine with no answers still shows", none.engines.length === 3, none.engines.map((e) => e.id).join());
}

console.log("\nScoped by tag");
{
  // The background selects answers by tag; the prompt grid has to follow, or
  // a "calls" filter shows one answer's numbers over all three prompts.
  const calls = r2.filter((r) => r.geo.tags.includes("calls"));
  const t = campaignBoard(calls, { profile, brands, viewAs: "Zento", prompts, runs, runId: "r2", all: all.filter((r) => r.geo.tags.includes("calls")), tags: ["calls"] });
  check("the prompt grid keeps only the tagged prompts", t.prompts.rows.map((p) => p.id).join() === "q3", t.prompts.rows.map((p) => p.id).join());
  // A prompt retagged after its run still shows with the answers it got.
  const retagged = [{ ...prompts[0], tags: ["renamed"] }, prompts[1], prompts[2]];
  check("a prompt retagged since the run stays with its answers",
    promptsInScope(retagged, ["buying"], all.filter((r) => r.geo.tags.includes("buying"))).map((p) => p.id).join() === "q1");
  check("no tags, every prompt", promptsInScope(prompts, [], []).length === 3);
}

console.log("\nA competitor against you (the brand detail)");
{
  const d = brandDetail(r2, { profile, brands, them: "Kovo", you: "Zento", prompts });
  const k = Object.fromEntries(d.kpis.map((x) => [x.label, x]));
  check("headline numbers side by side, with who is ahead", Math.round(k.Visibility.them) === 67 && Math.round(k.Visibility.you) === 67 && k["Avg position"].better === "them" && k["Share of voice"].better === "you", JSON.stringify(k));
  check("head to head: both named in 3, Kovo first in 2", d.h2h.both === 3 && d.h2h.firstThem === 2 && d.h2h.firstYou === 1 && d.h2h.themOnly === 1 && d.h2h.youOnly === 1, JSON.stringify(d.h2h));
  const g = d.byEngine.find((e) => e.id === "gemini");
  check("on each engine", g.them.visibility === 100 && g.you.visibility === 50, JSON.stringify(g));
  check("which sites cite one and not the other", d.sites.some((s) => s.site === "rtings.com" && s.verdict === "only Kovo") && d.sites.some((s) => s.site === "zento.in" && s.verdict === "only Zento"), JSON.stringify(d.sites));
  check("prompt by prompt, who came first", d.prompts.rows[0].cells.map((c) => c && c.winner).join() === "you,them,you" && d.prompts.rows[1].cells.map((c) => c && c.winner).join() === "them,them,", JSON.stringify(d.prompts.rows.map((r) => r.cells.map((c) => c && c.winner))));
  check("no detail for a brand against itself", brandDetail(r2, { profile, brands, them: "Zento", you: "Zento", prompts }) === null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
