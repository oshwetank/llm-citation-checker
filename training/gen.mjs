#!/usr/bin/env node
/*
 * gen.mjs — training and test data for Ask (0.75.0).
 *
 *   node training/gen.mjs --out training/data --train 20000 --test 1000 --seed 7
 *
 * Each example is one conversation in the chat format Qwen's template takes
 * (system, user, assistant tool calls, tool results, assistant answer), plus
 * the tool list offered. How it's made, so it can be trusted:
 *   - a made-up campaign (training/synth.mjs) with runs and answers;
 *   - a question of one kind (a playbook in src/lib/askKnowledge.js), in one
 *     of six languages, with that campaign's brands and prompts in it;
 *   - the system prompt and tools the extension itself would give for that
 *     question (systemFor / toolsFor), so training matches use;
 *   - the tool calls a good answer needs, run by the extension's own code
 *     (runTool), so every tool result is exactly what the user would get;
 *   - an answer written from those results by the wording in phrases.mjs,
 *     complete for its kind, in the question's language, with no number
 *     that isn't in a tool result (checked by checkNumbers, and the example
 *     dropped if not).
 * Some questions ask for what isn't captured (clicks, rankings): those
 * teach the model to say so instead of calling a tool or guessing.
 * The test set uses a different seed and holds out one kind of business, so
 * a score on it says something about campaigns the model hasn't seen.
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { rng, makeCampaign, VERTICALS } from "./synth.mjs";
import { QUESTIONS, LANGS, SAY, TERMS, NOT_CAPTURED_WHAT } from "./phrases.mjs";
import { runTool } from "../src/lib/assistantTools.js";
import { systemFor, toolsFor, checkNumbers } from "../src/lib/askKnowledge.js";

const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
const LANG_WEIGHTS = { en: 0.4, es: 0.12, pt: 0.12, fr: 0.12, hi: 0.12, ar: 0.12 };
const KINDS = Object.keys(QUESTIONS);
// How often each kind is asked: the analysis questions most; definitions and
// "not captured" enough to learn them.
const KIND_WEIGHTS = { visibility: 12, rival: 11, gaps: 11, drop: 11, sources: 10, topics: 8, engines: 8, content: 10, products: 5, searches: 4, ads: 3, glossary: 3, notCaptured: 4 };
function pickKind(r) {
  const total = Object.values(KIND_WEIGHTS).reduce((a, b) => a + b, 0);
  let x = r.next() * total;
  for (const k of KINDS) { x -= KIND_WEIGHTS[k] || 0; if (x <= 0) return k; }
  return "visibility";
}

function pickLang(r) {
  let x = r.next();
  for (const l of LANGS) { x -= LANG_WEIGHTS[l]; if (x <= 0) return l; }
  return "en";
}
const fill = (t, slots) => t.replace(/\{(\w+)\}/g, (_, k) => slots[k] ?? "");
const engines = (xs) => xs.map((e) => ENGINE_LABEL[e] || e).join(", ");

/** The calls a complete answer of this kind makes. */
export function goldCalls(kind, ctx) {
  const c = ctx.nameCampaign ? { campaign: ctx.campaign } : {};
  switch (kind) {
    case "visibility": return [["campaign_overview", c]];
    case "rival": return [["rival_wins", { ...c, brand: ctx.rival }], ["prompts_behind", c]];
    case "gaps": return [["prompts_where_absent", c], ["prompts_behind", c]];
    case "drop": return [["campaign_overview", c], ["data_quality", c], ["prompts_where_absent", c]];
    case "sources": return [["source_gaps", c], ["own_site_share", c]];
    case "topics": return [["topic_breakdown", c]];
    case "engines": return [["engine_compare", c], ["engine_disagreement", c]];
    case "products": return [["products_named", c]];
    case "searches": return [["fanout_searches", c]];
    case "ads": return [["ads_seen", c]];
    case "content": return [["prompts_where_absent", c], ["source_gaps", c], ["topic_breakdown", c]];
    case "glossary": return [["glossary", { term: ctx.term }]];
    case "notCaptured": return [];
    default: return [];
  }
}

/** The answer, from the tool results, in the question's language. */
export function goldAnswer(kind, lang, res, ctx) {
  const S = SAY[lang];
  const out = [];
  const R = (name) => (res.find((x) => x.name === name) || {}).result || null;
  const intro = (x) => (x && x.run ? S.run(x.run, x.answers, engines(x.engines || [])) + ":" : "");
  if (kind === "notCaptured") return S.notCaptured(ctx.what);
  if (kind === "glossary") { const g = R("glossary"); return g ? S.term(g.term, g.what, g.formula) : ""; }
  if (kind === "visibility" || kind === "drop") {
    const o = R("campaign_overview");
    const me = o.brands.find((b) => b.yours);
    const ch = (o.changeSincePrevious || []).find((b) => b.yours);
    out.push(intro(o), S.vis(me.brand, me.visibility, me.shareOfVoice, me.avgPosition), S.change(ch ? ch.visibility : null));
    const lead = o.brands.filter((b) => !b.yours).sort((a, b) => b.visibility - a.visibility)[0];
    if (lead && lead.visibility > me.visibility) out.push(S.leader(lead.brand, lead.visibility));
    for (const e of o.byEngine || []) { const b = e.brands.find((x) => x.brand === me.brand); if (b) out.push(S.engine(ENGINE_LABEL[e.engine], e.answers, b.visibility)); }
    if (kind === "drop") {
      const q = R("data_quality");
      const short = (q.engines || []).filter((e) => e.withAnswer < e.captured);
      for (const e of short) out.push(S.quality(ENGINE_LABEL[e.engine], e.captured, e.withAnswer, e.usageLimit));
      if (short.length) out.push(S.missingData);
      const a = R("prompts_where_absent");
      out.push(S.absent(a.count, a.of));
      for (const p of a.prompts.slice(0, 3)) out.push(`- ${S.item(p.prompt, p.rivalsNamed)}`);
    }
  }
  if (kind === "rival") {
    const w = R("rival_wins");
    out.push(intro(w));
    const row = (w.rivals || [])[0];
    out.push(row ? S.rival(row.brand, row.namedFirst, row.inAnswersWithoutYou, row.aheadOfYou) : S.behind(0));
    const b = R("prompts_behind");
    out.push(S.behind(b.count));
    for (const p of b.prompts.slice(0, 3)) out.push(`- “${p.prompt}”`);
  }
  if (kind === "gaps" || kind === "content") {
    const a = R("prompts_where_absent");
    out.push(intro(a), S.absent(a.count, a.of));
    for (const p of a.prompts.slice(0, 5)) out.push(`- ${S.item(p.prompt, p.rivalsNamed)}`);
    if (kind === "gaps") { const b = R("prompts_behind"); out.push(S.behind(b.count)); }
  }
  if (kind === "sources" || kind === "content") {
    const g = R("source_gaps");
    out.push(S.gapsIntro(g.sites.length));
    for (const s of g.sites.slice(0, 6)) out.push(`- ${S.site(s.site, s.kind, s.answersCitingWithRivalsOnly)}`);
    if (kind === "sources") { const o = R("own_site_share"); out.push(S.own(o.yourSiteShare, o.yourSiteCitations, o.citations)); }
  }
  if (kind === "topics" || kind === "content") {
    const t = R("topic_breakdown");
    if (kind === "topics") out.push(intro(t));
    const rows = [...t.topics].sort((a, b) => a.yourVisibility - b.yourVisibility);
    for (const x of (kind === "content" ? rows.slice(0, 2) : rows.slice(0, 6))) out.push(`- ${S.topic(x.topic, x.yourVisibility, x.answers, x.mostOftenFirst)}`);
    if (kind === "content") {
      const a = R("prompts_where_absent"), g = R("source_gaps");
      out.push(S.suggest);
      for (const p of a.prompts.slice(0, 2)) out.push(`- ${S.sugPrompt(p.prompt, p.rivalsNamed.slice(0, 2))}`);
      for (const s of g.sites.slice(0, 2)) out.push(`- ${S.sugSite(s.site)}`);
      if (rows[0]) out.push(`- ${S.sugTopic(rows[0].topic)}`);
    }
  }
  if (kind === "engines") {
    const e = R("engine_compare");
    out.push(intro(e));
    for (const x of e.engines) { const me = x.brands.find((b) => b.yours); if (me) out.push(S.engine(ENGINE_LABEL[x.engine], x.answers, me.visibility)); }
    const d = R("engine_disagreement");
    if (d.of) out.push(S.disagree(d.count, d.of));
  }
  if (kind === "products") {
    const p = R("products_named");
    out.push(intro(p), S.cards(p.answersWithCards, p.byBrand.slice(0, 4).map((b) => S.cardRow(b.brand, b.cards, b.firstCards)).join("; ")));
  }
  if (kind === "searches") { const s = R("fanout_searches"); out.push(intro(s), S.searches(s.total, s.perAnswer, s.namingYou)); }
  if (kind === "ads") { const a = R("ads_seen"); out.push(S.ads(a.answersWithAds, a.advertisers.map((x) => `${x.advertiser} (${x.n})`).join(", ")), S.adsNote); }
  return out.filter(Boolean).join("\n");
}

const toQwenCalls = (calls) => calls.map(([name, args]) => ({ type: "function", function: { name, arguments: args } }));

/** One example, or null when it can't be made complete and checked. */
export function makeExample(r, camp, { kind = pickKind(r), lang = pickLang(r), campaigns = [camp.profile.name] } = {}) {
  // The glossary's definitions exist in English only so far: a definition
  // question in another language would teach a mixed-language answer.
  if (kind === "glossary") lang = "en";
  const qs = QUESTIONS[kind][lang] || QUESTIONS[kind].en;
  const term = r.pick(TERMS[lang] || TERMS.en);
  const what = r.pick(NOT_CAPTURED_WHAT[lang] || NOT_CAPTURED_WHAT.en);
  const ctx = { campaign: camp.profile.name, brand: camp.own, rival: r.pick(camp.rivals), term, what, nameCampaign: campaigns.length > 1 || r.chance(0.3) };
  const template = r.pick(qs);
  if (template.includes("{campaign}")) ctx.nameCampaign = true;
  const question = fill(template, ctx);
  const calls = goldCalls(kind, ctx);
  const data = { records: camp.records, profiles: [camp.profile], runs: camp.runs };
  const res = [];
  for (const [name, args] of calls) {
    const t = runTool(name, args, data);
    if (!t.ok) return null;
    res.push({ name, args, result: t.result });
  }
  const answer = goldAnswer(kind, lang, res, ctx);
  if (!answer) return null;
  const nums = checkNumbers(answer, res.map((x) => x.result));
  if (nums.unverified.length) return null; // never teach a number the tools didn't give
  const tools = toolsFor(question).map((t) => t.function);
  if (calls.some(([n]) => !tools.some((t) => t.name === n))) return null; // the extension wouldn't offer it
  const messages = [
    { role: "system", content: systemFor(question, { campaigns }) },
    { role: "user", content: question },
  ];
  if (calls.length) {
    messages.push({ role: "assistant", content: "", tool_calls: toQwenCalls(calls) });
    for (const x of res) messages.push({ role: "tool", name: x.name, content: JSON.stringify(x.result).slice(0, 6000) });
  }
  messages.push({ role: "assistant", content: answer });
  return { messages, tools, meta: { kind, lang, vertical: camp.vertical.id, campaign: camp.seed || null, calls: calls.map(([n, a]) => ({ name: n, args: a })) } };
}

export const campSeed = (seed, ci) => (seed * 100003 + ci * 7919) >>> 0;

/** Make n examples from a seed; `exclude`/`only` choose kinds of business. */
export function* examples(seed, n, { exclude = [], only = null } = {}) {
  const r = rng(seed);
  let made = 0, tries = 0, ci = 0;
  let camp = null;
  while (made < n && tries < n * 5) {
    tries++;
    if (!camp || r.chance(0.12)) {
      // Each campaign from its own seed, so an evaluation can rebuild it.
      do { camp = makeCampaign(rng(campSeed(seed, ci)), ci); camp.seed = [seed, ci]; ci++; } while ((only && camp.vertical.id !== only) || exclude.includes(camp.vertical.id));
    }
    const ex = makeExample(r, camp);
    if (ex) { made++; yield ex; }
  }
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => (a.startsWith("--") ? [a.slice(2), xs[i + 1] && !xs[i + 1].startsWith("--") ? xs[i + 1] : true] : null)).filter(Boolean));
  const out = args.out || "training/data";
  const nTrain = Number(args.train || 20000), nTest = Number(args.test || 1000), seed = Number(args.seed || 7);
  const holdout = args.holdout || "coffee";
  if (!VERTICALS.some((v) => v.id === holdout)) throw new Error(`no kind of business "${holdout}"`);
  mkdirSync(out, { recursive: true });
  const write = (file, it) => new Promise((done) => {
    const w = createWriteStream(path.join(out, file));
    let k = 0;
    const stats = {};
    for (const ex of it) { w.write(JSON.stringify(ex) + "\n"); k++; const key = `${ex.meta.kind}/${ex.meta.lang}`; stats[key] = (stats[key] || 0) + 1; }
    w.end(() => done({ k, stats }));
  });
  (async () => {
    const tr = await write("train.jsonl", examples(seed, nTrain, { exclude: [holdout] }));
    const te = await write("test.jsonl", examples(seed + 1000, nTest));
    writeFileSync(path.join(out, "README.txt"), `Made by training/gen.mjs --seed ${seed}: ${tr.k} training and ${te.k} test conversations. Test campaigns come from a different seed and include "${holdout}", a kind of business the training set never has. Everything is made up.\n`);
    console.log(`train ${tr.k}, test ${te.k} → ${out}`);
  })();
}
if (import.meta.url === `file://${process.argv[1]}`) main();
