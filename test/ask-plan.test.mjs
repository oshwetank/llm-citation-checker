/*
 * ask-plan.test.mjs — Ask on one data foundation, Stage 1 (1.0.5;
 * ASK-ARCHITECTURE.md): the catalog, the rule plan, the scope rules, the
 * executor's numbers against the boards', and the template replies.
 *
 * Made-up brands only. Two campaigns share a brand on purpose ("Zento India"
 * and "Zento US"), the case where the old Ask silently picked one.
 * Run: node test/ask-plan.test.mjs
 */
import { buildCatalog, lookup, HISTORY_ID } from "../src/lib/askCatalog.js";
import { rulePlan, resolveScope, datesIn, validPlan } from "../src/lib/askPlan.js";
import { execute, NOT_RECORDED } from "../src/lib/askExecute.js";
import { scopeOf, templateReply } from "../src/lib/askReply.js";
import { askPlanned } from "../src/lib/assistant.js";
import { campaignInsights } from "../src/lib/insights.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};

import { DAY, NOW, profiles, runs, records, data } from "./fixtures/ask-data.mjs";
const catalog = buildCatalog(data);
const plan = (q, o = {}) => { const r = rulePlan(q, catalog, { now: NOW }); return resolveScope(r.plan, r.matches, catalog, { question: q, ...o }); };

console.log("\nThe catalog: every name, and My questions");
{
  check("three campaigns and My questions", catalog.collections.length === 4 && catalog.byId.has(HISTORY_ID), catalog.collections.map((c) => c.name).join(", "));
  check("tags per campaign", catalog.byId.get("pIN").tags.includes("battery") && catalog.byId.get("pIN").tags.includes("camera"));
  check("a brand knows every campaign it appears in", [...catalog.brands.get("zento").collections].sort().join() === [HISTORY_ID, "pIN", "pUS"].sort().join(), [...catalog.brands.get("zento").collections].join());
  const m = lookup("how is kovo doing on gpt and bard?", catalog);
  check("engine nicknames: GPT is ChatGPT, Bard is Gemini", m.some((x) => x.kind === "engine" && x.id === "chatgpt") && m.some((x) => x.kind === "engine" && x.id === "gemini"), JSON.stringify(m));
  check("a typo still finds the brand", lookup("is lumorra beating pexa?", catalog).some((x) => x.kind === "brand" && x.name === "Lumora"));
  check("short engine names never fuzz into words", !lookup("which group of phones", catalog).some((x) => x.kind === "engine"));
}

console.log("\nThe rule plan");
{
  const { plan: p } = rulePlan("Is Kovo beating us in the battery prompts since October?", catalog, { now: NOW });
  check("a comparison, own brand plus Kovo", p.intent === "compare" && p.subject.own && p.subject.brands.includes("Kovo"), JSON.stringify(p.subject));
  check("the tag", p.scope.tags.includes("battery"), JSON.stringify(p.scope.tags));
  check("since October: all runs from 1 Oct", p.scope.runs === "all" && new Date(p.scope.dates.from).getMonth() === 9, JSON.stringify(p.scope.dates));
  check("clicks are not recorded", rulePlan("How many clicks did ChatGPT send us?", catalog).plan.intent === "not_recorded");
  check("a definition", rulePlan("What does share of voice mean?", catalog).plan.intent === "define");
  check("last 7 days", Math.round((NOW - datesIn("answers from the last 7 days", NOW).from) / DAY) === 7);
  check("by engine", rulePlan("Zento visibility by engine", catalog).plan.by === "engine");
}

console.log("\nWhich campaign: named, open, asked back, never a silent guess");
{
  const a = plan("How is Zento India doing on Gemini?");
  check("named wins", a.plan.scope.collections.join() === "pIN" && !a.askBack, JSON.stringify(a.plan.scope));
  const b = plan("How visible are we?");
  check("two close campaigns: asks back instead of guessing", !!b.askBack && b.askBack.choices.some((c) => c.label === "Zento India") && b.askBack.choices.some((c) => c.label === "Zento US"), JSON.stringify(b.askBack));
  check("and offers all of them", b.askBack.choices.some((c) => /All campaigns|Both/.test(c.label) && c.collections.length >= 2));
  const c = plan("How visible are we?", { context: { collectionId: "pUS" } });
  check("the campaign open on the page wins", c.plan.scope.collections.join() === "pUS" && !c.askBack, JSON.stringify(c));
  const d = plan("How is Kovo doing?");
  check("a rival tracked by two campaigns: both, one row each", d.plan.scope.collections.sort().join() === "pIN,pUS" && d.plan.by === "collection", JSON.stringify(d.plan.scope));
  const e = plan("How is Lumora doing?");
  check("the brand of only one campaign doesn't need asking", !e.askBack && e.plan.scope.collections.includes("pHM"), JSON.stringify(e));
  const f = plan("How visible is my brand in my latest campaign?");
  check("\"latest campaign\" picks the most recent", f.plan.scope.collections.join() === "pIN" && !f.askBack, JSON.stringify(f.plan.scope));
  const g = plan("Show me answers about warranty");
  check("wording questions reach My questions too", !g.askBack || g.askBack.choices.some((x) => x.collections.includes(HISTORY_ID)), JSON.stringify(g));
}

console.log("\nFollow-ups keep the scope and change what they name");
{
  const first = plan("How is Zento India doing?");
  const next = plan("and on Gemini?", { previous: first.plan });
  check("same campaign and intent, engine swapped", next.plan.scope.collections.join() === "pIN" && next.plan.scope.engines.join() === "gemini" && next.plan.inherited, JSON.stringify(next.plan.scope));
}

console.log("\nPrompts by tag, else by wording, and said so");
{
  const t = plan("How do we do in the battery prompts in Zento India?");
  check("a tag called battery", t.plan.scope.tags.join() === "battery", JSON.stringify(t.plan.scope));
  const w = plan("How do we do in travel prompts in Zento India?");
  check("no tag: prompts whose wording matches", w.plan.scope.prompts.join() === "in3" && w.plan.promptsByWording, JSON.stringify(w.plan.scope));
}

console.log("\nThe executor's numbers are the boards' numbers");
{
  const p = plan("How is Zento India doing?").plan;
  const ex = execute(p, data);
  const board = campaignInsights({ records, profile: profiles[0], runs });
  const mine = ex.parts[0].data.brands.find((b) => b.brand === "Zento");
  const theirs = board.overview.find((b) => b.brand === "Zento");
  check("same visibility, share of voice and position as the board", mine && theirs && mine.visibility === theirs.visibility && mine.shareOfVoice === theirs.shareOfVoice && mine.avgPosition === theirs.avgPosition, JSON.stringify([mine, theirs]));
  check("from the latest finished run", ex.parts[0].coverage.run === new Date(runs[1].startedAt).toISOString().slice(0, 10), ex.parts[0].coverage.run);
  check("coverage: answers used and the turn with no answer", ex.parts[0].coverage.answers === 5 && ex.parts[0].coverage.noAnswer === 1, JSON.stringify(ex.parts[0].coverage));
  const g = execute(plan("How is Zento India doing on Gemini?").plan, data);
  const boardG = campaignInsights({ records, profile: profiles[0], runs, engines: ["gemini"] });
  check("one engine: same as the board filtered to it", g.parts[0].data.brands.find((b) => b.brand === "Zento").visibility === boardG.overview.find((b) => b.brand === "Zento").visibility);
  const tr = execute(plan("Zento trend over time in Zento India").plan, data);
  check("a trend is run by run", tr.parts[0].data.trend[0].runs.length === 2, JSON.stringify(tr.parts[0].data.trend));
}

console.log("\nReplies: the scope shown, numbers from the results only");
{
  const p = plan("How is Zento India doing on Gemini?").plan;
  const ex = execute(p, data);
  const s = scopeOf(p, ex, catalog);
  check("the scope line names campaign, run, engine and answers", /Zento India/.test(s.text) && /latest run/.test(s.text) && /Gemini/.test(s.text) && /answers/.test(s.text), s.text);
  check("as chips", s.chips.map((c) => c.kind).join() === "collection,runs,engines", JSON.stringify(s.chips.map((c) => c.kind)));
  const t = templateReply(p, ex);
  check("a template reply with the numbers", /Zento/.test(t) && /%/.test(t), t);
  check("clicks: what the tool records instead", execute({ intent: "not_recorded", scope: { collections: [] } }, data).result.text === NOT_RECORDED);
  check("an edited plan is checked against the catalog", validPlan(p, catalog) && !validPlan({ ...p, scope: { ...p.scope, collections: ["nope"] } }, catalog));
}

console.log("\nAsk end to end");
{
  const off = await askPlanned({ question: "How is Zento India doing?", data });
  check("with the AI off, a template answer and its scope", off.by === "template" && /Zento/.test(off.answer) && off.scope && /Zento India/.test(off.scope.text), JSON.stringify(off).slice(0, 300));
  check("every number in it is from the results", off.unverified.length === 0, off.unverified.join(","));
  check("links to the answers behind it", off.refs.length > 0);
  const back = await askPlanned({ question: "How visible are we?", data });
  check("ambiguous: it asks back", back.by === "ask-back" && back.askBack.choices.length >= 2, JSON.stringify(back.askBack));
  const chosen = await askPlanned({ question: "How visible are we?", data, plan: { ...back.plan, scope: { ...back.plan.scope, collections: back.askBack.choices[0].collections } } });
  check("a choice answers with that campaign", chosen.by === "template" && chosen.scope.text.startsWith(back.askBack.choices[0].label), chosen.scope && chosen.scope.text);
  const model = await askPlanned({ question: "How is Zento India doing?", data, generate: async ({ messages }) => ({ text: /Results: /.test(messages[1].content) ? "Zento was named in 60% of answers, and 87% of the time first." : "" }) });
  check("with a model, it writes from the results and a made-up number is flagged", model.by === "model" && model.unverified.includes("87") && !model.unverified.includes("60"), JSON.stringify(model.unverified));
  const nr = await askPlanned({ question: "How much traffic did Gemini send us?", data });
  check("traffic: not recorded, explained", nr.answer === NOT_RECORDED, nr.answer);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
