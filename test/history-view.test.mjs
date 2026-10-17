/*
 * history-view.test.mjs — the Dashboard as a record of what you asked (0.49.0).
 *
 * The owner's feedback on the old Dashboard: it "must not be brand-centric";
 * it "is a record of prompts, search is central". src/lib/historyView.js
 * turns captures into one row per prompt and works out every filter the
 * canvas's Dashboard has. On 0.48.0 the module doesn't exist, so this file
 * fails at import.
 *
 * Every prompt, brand and page is made up; the domains are public sites.
 */
import {
  historyRows, historyView, isTaskPrompt, searchTokens, highlightRuns, groupRows, dayDiff, weekStart,
} from "../src/lib/historyView.js";
import { normPrompt } from "../src/lib/analyzeView.js";
import { answerSnippet, searchAnswers } from "../src/lib/answerSearch.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

// Friday 2 October 2026, noon, local time; times below are relative to it.
const NOW = new Date(2026, 9, 2, 12, 0).getTime();
const at = (daysAgo, hour = 10) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); };
let n = 0;
const cap = (platform, prompt, when, extra = {}) => ({
  captureId: `c${++n}`, platform, userPrompt: prompt, capturedAt: when, searched: true,
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], places: [], images: [], ...extra,
});
const q = (...xs) => xs.map((query) => ({ query }));
const src = (domain, outcome = "cited") => ({ url: `https://${domain}/x`, domain, title: domain, outcome });
const m = (brand, count = 1) => ({ brand, count, firstIndex: 1, passages: [] });

const HEAD = "Best headphones under 4000";
const records = [
  // asked on three engines in a campaign run today, and on ChatGPT twice before
  cap("chatgpt", HEAD, at(0, 9), { geo: { profileId: "p1", runId: "r2", promptId: "q1" }, fanout: { search: q("best headphones under 4000 india", "Zento Pulse review"), shopping: q("wireless headphones"), image: [] }, sources: [src("smartprix.com"), src("reddit.com", "fetched")], brandMentions: [m("Zento", 3), m("Kovo")], products: [{ name: "Zento Pulse" }, { name: "Kovo Air" }] }),
  cap("gemini", HEAD, at(0, 9), { geo: { profileId: "p1", runId: "r2", promptId: "q1" }, sources: [src("91mobiles.com")], brandMentions: [m("Kovo"), m("Lumi")] }),
  cap("perplexity", HEAD + ".", at(0, 9), { geo: { profileId: "p1", runId: "r2", promptId: "q1" }, fanout: { search: q("headphones under 4000 reddit"), shopping: [], image: [] }, sources: [src("reddit.com")], brandMentions: [m("Zento")] }),
  cap("chatgpt", "best headphones under 4000", at(7, 9), { geo: { profileId: "p1", runId: "r1", promptId: "q1" } }),
  cap("chatgpt", "best  headphones under 4000", at(14, 9)),
  // ad-hoc, single engine
  cap("perplexity", "how does active noise cancellation work", at(0, 11), { fanout: { search: q("how does anc work", "feedforward vs feedback ANC"), shopping: [], image: [] }, sources: [src("rtings.com"), src("wikipedia.org")] }),
  cap("gemini", "best cafe to work from in Indiranagar", at(1, 18), { places: [{ name: "Cafe One" }, { name: "Cafe Two" }], sources: [src("zomato.com")] }),
  cap("chatgpt", "is Zento a good brand for headphones?", at(1, 10), { searched: false, brandMentions: [m("Zento", 2)] }),
  cap("chatgpt", "write a polite follow-up email to a client about an unpaid invoice", at(3, 20), { searched: false }),
  cap("chatgpt", "linen shirt outfit ideas for men", at(4, 16), { images: [{ url: "a" }, { url: "b" }, { url: "c" }, { url: "d" }], sources: [src("myntra.com")] }),
  cap("grok", "gaming headphones under 3000", at(17, 11), { fanout: { search: q("best gaming headphones under 3000"), shopping: [], image: [] }, products: [{ name: "Ozo G1" }], brandMentions: [m("Ozo")] }),
  cap("perplexity", "open-ear headphones for cycling", at(51, 7), { products: [{ name: "Arvo Open" }] }),
];
const profiles = [{ id: "p1", name: "Budget headphones" }];

console.log("\nhistoryRows: one row per prompt");
const rows = historyRows(records, { profiles });
const row = (t) => rows.find((r) => r.key === normPrompt(t));
{
  check("prompts that differ only in case, spacing or a full stop are one row", rows.length === 8 && row(HEAD).captures === 5, rows.map((r) => r.text).join(" | "));
  const h = row(HEAD);
  check("newest first", rows[0].key === "how does active noise cancellation work", rows[0].text);
  check("the engines that answered it, in a fixed order", h.engines.join() === "chatgpt,gemini,perplexity", h.engines.join());
  check("asked = times on the engine asked most (a 3-engine run counts once)", h.asked === 3, h.asked);
  check("every answer counted", h.captures === 5, h.captures);
  check("searches, pages and brands from each engine's latest answer", h.searches === 4 && h.pages === 4 && h.brands === 3, `${h.searches}/${h.pages}/${h.brands}`);
  check("product cards counted", h.products === 2, h.products);
  check("the campaign it came from, by name", h.campaign === "Budget headphones" && h.fromCampaign, h.campaign);
  check("the searches the engines ran, without repeats", h.fan.length === 4 && h.fan[2].lane === "shopping", JSON.stringify(h.fan));
  check("an ad-hoc prompt has no campaign", row("how does active noise cancellation work").campaign === "");
}

console.log("\nKind of answer");
{
  check("product cards make it shopping (the richest engine wins)", row(HEAD).kind === "shopping");
  check("a map makes it local", row("best cafe to work from in Indiranagar").kind === "local");
  check("enough images make it image-led", row("linen shirt outfit ideas for men").kind === "images");
  check("searched, no cards: informational", row("how does active noise cancellation work").kind === "info");
  check("no search, brands named: from memory", row("is Zento a good brand for headphones?").kind === "memory");
  check("no search, no brands, asks for work: a task", row("write a polite follow-up email to a client about an unpaid invoice").kind === "task");
  check("a question that starts like a task but searched is not a task", !isTaskPrompt("write me a list of the best phones", { searched: true }));
  check("a question about something is not a task", !isTaskPrompt("what is the best way to clean headphones"));
}

const ALL = { prompts: true, answers: true, fan: true };
const base = { query: "", scope: ALL, period: "all", engines: {}, kinds: {}, week: null };

console.log("\nPeriods");
{
  const v = (period) => historyView(rows, { ...base, period }, { now: NOW }).list.map((r) => r.key);
  check("today", v("today").length === 2, v("today").join(" | "));
  check("yesterday", v("yesterday").length === 2, v("yesterday").join(" | "));
  check("last 3 days = today and the two before", v("3d").length === 4, v("3d").length);
  check("7 days", v("7d").length === 6, v("7d").length);
  check("30 days leaves out the 51-day-old prompt", v("30d").length === 7 && !v("30d").includes("open-ear headphones for cycling"), v("30d").length);
  check("all time", v("all").length === 8, v("all").length);
}

console.log("\nSearch: prompts, answers and the engines' searches");
{
  const hits = new Map([["c8", "…Zento is a good value brand…"]]);
  const v = historyView(rows, { ...base, query: "headphone" }, { now: NOW, answerHits: hits });
  check("every word is matched in the prompt, plural or not", v.list.length === 4, v.list.map((r) => r.text).join(" | "));
  const anc = historyView(rows, { ...base, query: "feedforward" }, { now: NOW });
  check("a word only the engine searched for finds the prompt", anc.list.length === 1 && anc.list[0].hitFan && /feedforward/.test(anc.list[0].hitFan.text), JSON.stringify(anc.list.map((r) => r.hitFan)));
  const ans = historyView(rows, { ...base, query: "value brand" }, { now: NOW, answerHits: hits });
  check("a match in the answer text finds it, with the snippet", ans.list.length === 1 && ans.list[0].hitAnswer.snippet.includes("value brand"), JSON.stringify(ans.list.map((r) => r.hitAnswer)));
  const off = historyView(rows, { ...base, query: "feedforward", scope: { prompts: true, answers: true, fan: false } }, { now: NOW });
  check("switching off a scope stops looking there", off.list.length === 0, off.list.length);
  check("tokens drop a plural s", searchTokens("Headphones under").join() === "headphone,under");
  const runs = highlightRuns("Best Headphones under 4000", searchTokens("headphones"));
  check("highlighting marks each match", runs.filter((x) => x.hit).map((x) => x.t).join() === "Headphone", JSON.stringify(runs));
}

console.log("\nEngines, toggles and kinds");
{
  const g = historyView(rows, { ...base, engines: { chatgpt: false, gemini: true, perplexity: false, grok: false } }, { now: NOW });
  check("an engine switched off hides prompts only it answered", g.list.length === 2 && g.list.every((r) => r.engines.includes("gemini")), g.list.map((r) => r.text).join(" | "));
  check("engine counts don't depend on the engine filter", g.engineCounts.chatgpt === 4 && g.engineCounts.gemini === 2, JSON.stringify(g.engineCounts));
  const rep = historyView(rows, { ...base, repeat: true }, { now: NOW });
  check("asked more than once", rep.list.length === 1 && rep.list[0].key === normPrompt(HEAD), rep.list.length);
  const camp = historyView(rows, { ...base, campaign: true }, { now: NOW });
  check("from a campaign", camp.list.length === 1, camp.list.length);
  const k = historyView(rows, { ...base, kinds: { shopping: true } }, { now: NOW });
  check("a kind of answer picked", k.list.length === 3 && k.list.every((r) => r.kind === "shopping"), k.list.length);
  check("kind counts are taken before the kind filter", k.kindCounts.local === 1 && k.kindCounts.task === 1, JSON.stringify(k.kindCounts));
}

console.log("\nWeeks, totals, groups and sort");
{
  const v = historyView(rows, base, { now: NOW });
  check("eight weeks, this one last", v.weeks.length === 8 && v.weeks[7].label === "This week", v.weeks.map((w) => w.label).join());
  // Friday 2 Oct: Monday 28 Sep to today holds six of the prompts.
  check("this week's prompts", v.weeks[7].n === 6 && dayDiff(NOW, v.weeks[7].start) === 4, JSON.stringify(v.weeks.map((w) => w.n)));
  const wk = historyView(rows, { ...base, week: v.weeks[5].start }, { now: NOW });
  check("a week picked on the chart narrows the list", wk.list.every((r) => weekStart(r.latestAt) === v.weeks[5].start) && wk.list.length === v.weeks[5].n, wk.list.length);
  check("totals: prompts, answers, engines", v.totals.prompts === 8 && v.totals.answers === 12 && v.totals.engines === 4, JSON.stringify(v.totals));
  const g = groupRows(v.list, NOW);
  check("grouped Today, Yesterday, then earlier", g[0].label === "Today" && g[1].label === "Yesterday" && g[0].rows.length === 2, g.map((x) => `${x.label}:${x.rows.length}`).join(" "));
  check("older prompts are grouped by month", g.some((x) => x.label === "August"), g.map((x) => x.label).join());
  const s = historyView(rows, { ...base, sort: "asked" }, { now: NOW });
  check("sort by asked most often", s.list[0].key === normPrompt(HEAD) && s.groups.length === 1, s.list[0].text);
}

console.log("\nSearches the engines ran");
{
  const v = historyView(rows, base, { now: NOW });
  const f = v.fan.find((x) => x.text === "best headphones under 4000 india");
  check("each search once, with the prompt it ran for", f && f.n === 1 && f.from[0] === HEAD, JSON.stringify(f));
  check("all the searches of the listed prompts", v.fan.length === 7, v.fan.length);
  const s = historyView(rows, { ...base, query: "reddit" }, { now: NOW });
  check("searching narrows them to the matching searches", s.fan.length === 1 && s.fan[0].text === "headphones under 4000 reddit", s.fan.map((x) => x.text).join(" | "));
}

console.log("\nSearching inside answers (done in the background)");
{
  const text = "If your budget is under 4000, the **Zento Pulse** is the best value \uE200cite\uE202turn0search1\uE201 for most people. "
    + "Kovo Air is a close second [[cite:https://smartprix.com/x]] with longer battery life, and Lumi One is the budget pick for students who want bass.";
  const s1 = answerSnippet(text, "value pulse");
  check("a snippet when every word is there, in any order", !!s1 && /Zento Pulse is the best value/.test(s1), s1);
  check("citation markers and markdown are cleaned out of it", !!s1 && !/[\uE200-\uE202]|\*\*|\[\[cite/.test(s1), s1);
  check("null when a word is missing", answerSnippet(text, "value tripod") === null);
  const s2 = answerSnippet(text, "students");
  check("a match deep in a long answer gets an ellipsis before it", !!s2 && s2.startsWith("…") && /students/.test(s2), s2);
  const hits = searchAnswers([
    { captureId: "a", capturedAt: 1, answerText: text },
    { captureId: "b", capturedAt: 2, answerText: "Nothing about it here." },
    { captureId: "c", capturedAt: 3 },
  ], "kovo battery");
  check("only answers holding every word come back", hits.length === 1 && hits[0].captureId === "a", JSON.stringify(hits));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
