/*
 * campaign-dash.test.mjs — the campaign dashboard (1.0.6): the background's
 * rows (dashRecords), the numbers the page shows (dashModel), the sections
 * that need more runs than a campaign has, and the template's values.
 * On 1.0.5 src/lib/campaignDash.js doesn't exist, so this fails at import.
 */
import { readFileSync } from "node:fs";
import { records, profile, runs } from "./helpers/campaign-fixture.mjs";
import { effectiveTrackedBrands, computeMetrics } from "../src/lib/geo.js";
import { dashRecords, dashSearch, dashModel, DASH_PAGE_IDS, DASH_DEFAULTS } from "../src/lib/campaignDash.js";
import { DASH_TEMPLATE } from "../ui/campaignDashTemplate.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const act = { set() {}, toast() {}, openCapture() {} };
const model = (data, st) => dashModel(JSON.parse(JSON.stringify(data)), Object.assign(DASH_DEFAULTS(), st), act);

const mine = records.filter((r) => r.geo && r.geo.profileId === "p1");
const brands = effectiveTrackedBrands(profile, mine);
const prompts = [...new Set(mine.map((r) => r.geo.promptId))].map((id) => { const r = mine.find((x) => x.geo.promptId === id); return { id, text: r.userPrompt, tags: r.geo.tags }; });
const data = dashRecords(mine, { brands, prompts, runs, engines: ["chatgpt", "perplexity", "grok"] });

console.log("rows");
check("a usage-limited answer is left out", data.recs.length === mine.length - 1 && !data.recs.some((r) => r.e === "grok"), data.recs.length);
check("runs in order, numbered from the first", data.runs.map((r) => r.id).join() === "r1,r2");
const c1 = data.recs.find((r) => r.id === "c1");
check("brands in the order the answer names them", c1.brands.map((b) => b.id + "#" + b.rank).join() === "zento#1,kovo#2", JSON.stringify(c1.brands));
check("cited sources keep their order and outcome", c1.sources.map((s) => s.d + (s.cited ? "" : "?")).join() === "rtings.com,zento.example");
check("searches and product cards come along", c1.queries.length === 2 && c1.products.length === 2 && c1.kind === "shopping");
check("a card is its brand's when its name starts with the brand", c1.products[0].brand === "zento" && c1.products[1].brand === "kovo");

console.log("numbers");
const r2 = mine.filter((r) => r.geo.runId === "r2" && r.platform !== "grok");
const want = computeMetrics(r2, profile, brands).brands.find((b) => b.name === "Zento");
const ov = model(data, { page: "overview" });
check("Visibility matches computeMetrics on the newest answers", ov.kpis[0].value === Math.round(want.visibility) + "%", ov.kpis[0].value + " vs " + want.visibility);
check("Share of voice matches computeMetrics", ov.kpis[1].value === Math.round(want.shareOfVoice) + "%", ov.kpis[1].value + " vs " + want.shareOfVoice);
check("compared with the run before", ov.cmpLabel === "Run 1" && ov.kpis[0].d.c !== "none");
check("comparing a run with itself compares nothing", model(data, { page: "overview", run: "0", cmp: "0" }).cmpLabel === "Nothing");
check("all runs have no period before them", model(data, { page: "overview", run: "all" }).cmpLabel === "Nothing");
const lb = ov.lb.rows;
check("share of voice adds up to 100%", Math.abs(lb.reduce((a, x) => a + parseFloat(x.sov), 0) - 100) < 1.5);
check("a brand logo is a path, not the row's change", lb.every((x) => typeof x.d === "string"));

console.log("one run");
const one = { ...data, runs: data.runs.slice(0, 1), recs: data.recs.filter((r) => r.run === 0) };
const o1 = model(one, { page: "overview" });
check("every over-time chart and comparison waits for 2 runs", ["trend", "moved", "history", "prices", "changes", "cmp", "newth"].every((k) => o1.lock[k].on));
check("no ▲▼ with nothing to compare", o1.kpis.every((k) => k.d.c === "none"));
check("the lock says how many runs and how many more", /2 runs\. It has 1 run so far: run it once more\./.test(o1.lock.trend.msg), o1.lock.trend.msg);
check("Run vs run is greyed in the menu", o1.nav[3].items.find((x) => x.label === "Run vs run").lk === true);
check("Last 4 runs waits for 5 runs", o1.runOpts[1].lk === "locked");
check("two runs open the charts, the flip rate still waits for 3", !ov.lock.trend.on && ov.lock.flips.on);

console.log("every page");
const big = (() => {
  // Six runs, three engines, four prompts, three brands with sites: enough rows for every page.
  const b = [{ name: "Zento", url: "https://zento.example", isOwn: true }, { name: "Kovo", url: "https://kovo.example" }, { name: "Lumi" }];
  const ps = [["best earbuds", ["Budget"]], ["earbuds for the gym", ["Sport"]], ["Zento vs Kovo", ["Budget", "Compare"]], ["earbuds near me", []]].map(([text, tags], i) => ({ id: "q" + i, text, tags }));
  const rs = Array.from({ length: 6 }, (_, i) => ({ id: "r" + i, startedAt: Date.UTC(2026, 9, 1 + i * 6) }));
  const recs = [];
  let k = 0;
  rs.forEach((run, ri) => ps.forEach((p, pi) => ["chatgpt", "perplexity", "gemini"].forEach((e, ei) => {
    const order = [b[(ri + pi + ei) % 3], b[(ri + pi + ei + 1) % 3]];
    const text = `${order[0].name} is the pick. ${order[1].name} is close behind.`;
    recs.push({ captureId: "x" + ++k, platform: e, userPrompt: p.text, answerText: text, answerChars: text.length, searched: true,
      brandMentions: order.map((x) => ({ brand: x.name, count: 1, firstIndex: text.indexOf(x.name) })),
      sources: [{ domain: "rtings.com", url: "https://rtings.com/best", title: "Best earbuds", outcome: "cited", platformSpecific: { pubDate: Date.UTC(2026, 6, 1) } }, { domain: "reddit.com", url: "https://www.reddit.com/r/headphones/comments/1/x", title: "Which earbuds", outcome: ri % 2 ? "cited" : "fetched" }, { domain: "zento.example", url: "https://zento.example/p/pulse", title: "Zento Pulse", outcome: pi % 2 ? "cited" : "fetched" }, { domain: "youtube.com", url: "https://youtube.com/watch?v=1", title: "Earbuds tested", outcome: "cited" }],
      products: e !== "perplexity" ? [{ name: order[0].name + " Pulse", price: "₹" + (2999 + ri * 100), merchant: "Flipkart" }, { name: order[1].name + " Air", price: "₹3,499", merchant: "zento.example" }] : [],
      places: pi === 3 ? [{ name: order[0].name + " Store", rating: 4.2, website: "https://zento.example" }] : [],
      fanout: e === "gemini" ? {} : { search: [p.text + " 2026", p.text + " reddit", "site:rtings.com " + p.text, order[0].name + " review"] },
      ads: e === "chatgpt" && pi === 0 ? [{ advertiser: "Kovo", targetDomain: "kovo.example" }] : [],
      images: [{ title: order[0].name + " Pulse", source: "zento.example" }, { title: "x", source: "rtings.com" }, { title: "y", source: "gstatic.com" }],
      geo: { profileId: "p1", runId: run.id, promptId: p.id, tags: p.tags }, capturedAt: run.startedAt + 1000 });
  })));
  return dashRecords(recs, { brands: b, prompts: ps, runs: rs, engines: ["chatgpt", "perplexity", "gemini"] });
})();
check("six runs, every answer kept", big.runs.length === 6 && big.recs.length === 72, big.recs.length);
check("page dates become ages, subreddits and videos are read from the address", big.recs[0].sources[0].age > 0 && big.recs[0].sources[1].sub === "r/headphones" && big.recs[0].sources[3].yt);
const STATES = [{}, { run: "all" }, { run: "last4" }, { run: "2" }, { cmp: "0" }, { cmp: "none" }, { gran: "week" }, { engines: ["gemini"] }, { tags: ["Sport"] }, { kinds: ["shopping"] }, { view: "kovo" }, { drawer: 1 }, { q: "Zento" }, { tab: { cit: "sections", sd: "urls", cm: "yt", th: "new", chg: "first", surf: "local", exc: "only", prf: "missing" } }];
let thrown = [], nan = [];
for (const ds of [data, one, big]) for (const page of DASH_PAGE_IDS) for (const st of STATES) {
  try {
    const R = model(ds, { page, ...st });
    const txt = JSON.stringify(R, (k, v) => (typeof v === "function" ? undefined : v));
    if (/NaN|Infinity|undefined%|\[object Object\]/.test(txt)) nan.push(page + " " + JSON.stringify(st));
  } catch (e) { thrown.push(page + " " + JSON.stringify(st) + ": " + e.message); }
}
check("every page, at 1, 2 and 6 runs and under every filter, works out", !thrown.length, thrown.slice(0, 3).join(" | "));
check("and shows no NaN, Infinity or object text", !nan.length, nan.slice(0, 3).join(" | "));
const surf = model(big, { page: "surfaces" });
check("ads: the advertiser is matched to a tracked brand", surf.sf.ads[0] && surf.sf.ads[0].name === "Kovo" && surf.sf.ads[0].role === "Tracked rival");
check("images from an engine's own image host are left out", !model(big, { page: "surfaces", tab: { surf: "images" } }).sf.hosts.some((h) => /gstatic/.test(h.name)));
const intent = model(big, { page: "intent" });
check("search intents add up to 100% and Gemini is said not to publish", Math.abs(intent.qi.rows.reduce((a, r) => a + parseFloat(r.share), 0) - 100) < 1.5 && intent.qi.engines.find((e) => e.label === "Gemini").nopub);
check("site: searches are their own intent", intent.qi.rows.some((r) => r.label === "Site-restricted"));
const ex = model(big, { page: "exclusive", engines: ["chatgpt"] });
check("one engine on Engine-only sites says so", ex.ex.one === true);

console.log("answer search");
const hits = dashSearch(mine, "answer");
check("a phrase is found with the words around it", hits.length > 0 && hits[0].hit.toLowerCase() === "answer" && typeof hits[0].pre === "string");
check("an empty search finds nothing", dashSearch(mine, "  ").length === 0);

console.log("template");
const loops = new Set([...DASH_TEMPLATE.matchAll(/<sc-for[^>]*\bas="(\w+)"/g)].map((m) => m[1]).concat(["$index", "true", "false"]));
const roots = new Set([...DASH_TEMPLATE.matchAll(/\{\{\s*([\w$]+)/g)].map((m) => m[1]).filter((r) => !loops.has(r)));
const provided = new Set();
for (const page of DASH_PAGE_IDS) Object.keys(model(big, { page, drawer: 0 })).forEach((k) => provided.add(k));
const missing = [...roots].filter((r) => !provided.has(r));
check("every value the template reads is worked out", !missing.length, missing.join(", "));
const code = ["ui/campaignDash.js", "ui/dcRender.js"].map((f) => readFileSync(new URL("../" + f, import.meta.url), "utf8")).join("\n");
check("values are written as text, never as HTML", !/innerHTML|insertAdjacentHTML|outerHTML\s*=/.test(code));

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log("\nall passed");
