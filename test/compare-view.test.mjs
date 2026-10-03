/*
 * compare-view.test.mjs — one prompt, several engines, side by side (0.48.0).
 *
 * The owner moved Compare out of the top menu and into Analyze: "it's now
 * integrated into the analyze section only". The full tab shows engine tabs
 * when the same prompt has answers from more than one engine, and a "Compare
 * all" view built by src/lib/compareView.js. On 0.47.0 that module doesn't
 * exist, so this file fails at import.
 *
 * Every brand, page and prompt is made up; the domains are public sites.
 */
import { answersToPrompt, compareView } from "../src/lib/compareView.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const T = Date.UTC(2026, 9, 2, 9, 0);
const src = (domain, outcome = "cited") => ({ url: `https://${domain}/x`, domain, title: domain, outcome });
const m = (brand, count, firstIndex) => ({ brand, count, firstIndex, passages: [] });
const q = (...xs) => xs.map((query) => ({ query }));
const ans = (platform, at, extra) => ({
  captureId: `${platform}-${at}`, platform, capturedAt: T + at, userPrompt: "Best wireless headphones under 3000", searched: true,
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], places: [], images: [], ...extra,
});

const chatgpt = ans("chatgpt", 0, {
  brandMentions: [m("Zento", 3, 1), m("Kovo", 2, 50), m("Lumi", 1, 90)],
  fanout: { search: q("best wireless headphones under 3000", "Zento Pulse review"), shopping: q("wireless headphones"), image: [] },
  sources: [src("smartprix.com"), src("zento.in"), src("reddit.com", "fetched")],
  products: [{ name: "Zento Pulse" }],
});
const gemini = ans("gemini", 60, {
  brandMentions: [m("Kovo", 2, 3), m("Zento", 1, 40)],
  sources: [src("smartprix.com"), src("91mobiles.com")],
});
const perplexity = ans("perplexity", 120, {
  brandMentions: [m("Zento", 2, 2), m("Arvo", 1, 60)],
  fanout: { search: q("best wireless headphones under 3000 india", "Arvo One battery"), shopping: [], image: [] },
  sources: [src("smartprix.com"), src("reddit.com")],
});
const grok = ans("grok", 180, { searched: false, brandMentions: [m("Kovo", 1, 5)] });
const olderGemini = ans("gemini", -86400000, { brandMentions: [m("Brio", 1, 1)] });
const otherPrompt = ans("grok", 200, { userPrompt: "best speakers", brandMentions: [m("Ozo", 1, 1)] });
const campaign = ans("perplexity", 300, { geo: { profileId: "p1", promptId: "q1", runId: "r1" } });

console.log("\nanswersToPrompt: one answer per engine to the same prompt");
{
  const set = answersToPrompt(chatgpt, [chatgpt, gemini, olderGemini, perplexity, grok, otherPrompt, campaign]);
  check("four engines, in a fixed order", set.map((r) => r.platform).join() === "chatgpt,gemini,perplexity,grok", set.map((r) => r.platform).join());
  check("each engine's latest answer", set.find((r) => r.platform === "gemini").captureId === gemini.captureId);
  check("a different prompt and campaign answers stay out", !set.some((r) => r.captureId === otherPrompt.captureId || r.captureId === campaign.captureId));
  check("the answer on screen represents its own engine", answersToPrompt(olderGemini, [gemini, chatgpt]).find((r) => r.platform === "gemini").captureId === olderGemini.captureId);
  const runMate = { ...campaign, captureId: "c2", platform: "chatgpt", geo: { profileId: "p1", promptId: "q1", runId: "r1" } };
  const otherRun = { ...campaign, captureId: "c3", platform: "gemini", geo: { profileId: "p1", promptId: "q1", runId: "r0" } };
  const runSet = answersToPrompt(campaign, [runMate, otherRun, chatgpt]);
  check("a campaign answer compares within its own run", runSet.map((r) => r.captureId).sort().join() === ["c2", campaign.captureId].sort().join(), runSet.map((r) => r.captureId).join());
}

console.log("\ncompareView: each engine in numbers");
const v = compareView([chatgpt, gemini, perplexity, grok], { own: { name: "Zento" } });
{
  const by = Object.fromEntries(v.engines.map((e) => [e.id, e]));
  check("who each engine named first", by.chatgpt.first === "Zento" && by.gemini.first === "Kovo" && by.perplexity.first === "Zento" && by.grok.first === "Kovo");
  check("pages read and cited", by.chatgpt.read === 3 && by.chatgpt.cited === 2, `${by.chatgpt.read}/${by.chatgpt.cited}`);
  check("searches counted across lanes", by.chatgpt.searches === 3, by.chatgpt.searches);
  check("an engine that searched without publishing says so", by.gemini.searches === "not published", by.gemini.searches);
  check("an engine that didn't search says none", by.grok.searches === "none", by.grok.searches);
  check("what each answer had beyond text", by.chatgpt.had.join() === "product cards", by.chatgpt.had.join());
}

console.log("\nWhere each brand came");
{
  const row = Object.fromEntries(v.brandGrid.map((b) => [b.name, b]));
  check("every brand any engine named", v.brandGrid.map((b) => b.name).sort().join() === "Arvo,Kovo,Lumi,Zento", v.brandGrid.map((b) => b.name).join());
  check("its place in each answer (null where not named)", JSON.stringify(row.Zento.cells) === "[1,2,1,null]", JSON.stringify(row.Zento.cells));
  check("named-by counts, most-named first", v.brandGrid[0].namedBy >= v.brandGrid[1].namedBy && row.Kovo.namedBy === 3 && row.Zento.namedBy === 3);
  check("your brand is marked", row.Zento.isYou && !row.Kovo.isYou);
}

console.log("\nWhich sites each engine used");
{
  const row = Object.fromEntries(v.siteGrid.map((s) => [s.domain, s]));
  check("a site cited by three engines leads", v.siteGrid[0].domain === "smartprix.com" && row["smartprix.com"].citedBy === 3);
  check("read but not cited is told apart from cited", row["reddit.com"].cells[0] === "read" && row["reddit.com"].cells[2] === "cited");
  check("an engine that didn't use a site has no mark", row["91mobiles.com"].cells[0] === null);
}

console.log("\nSearches each engine ran");
{
  const c = v.searchRows.find((r) => r.id === "chatgpt");
  check("a search another engine also ran is marked", c.queries[0].shared === true, JSON.stringify(c.queries[0]));
  check("a search only this engine ran is not", c.queries[1].shared === false, JSON.stringify(c.queries[1]));
}

console.log("\nHow the answers differ, in sentences");
{
  const d = Object.fromEntries(v.diffs.map((x) => [x.k, x.v]));
  check("who came first", d["Who came first"] === "ChatGPT and Perplexity named Zento first; Gemini and Grok named Kovo first.", d["Who came first"]);
  check("agreement and single-engine brands", /No brand was named by all 4\./.test(d.Agreement) && /Lumi \(ChatGPT\)/.test(d.Agreement) && /Arvo \(Perplexity\)/.test(d.Agreement), d.Agreement);
  check("shared sources", /smartprix\.com \(3\)/.test(d.Sources), d.Sources);
  check("searching, and the engine that didn't publish", /ChatGPT searched most \(3\); Perplexity least \(2\)\. Gemini searched without publishing what for\./.test(d.Searching), d.Searching);
  check("an answer from memory", d["From memory"] === "Grok answered without searching the web.", d["From memory"]);
  check("your brand's line", d.Zento === "Named by 3 of 4; first in 2.", d.Zento);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
