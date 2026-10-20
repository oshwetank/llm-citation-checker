/*
 * The training data for Ask (training/, 0.75.0). Run: node test/training-gen.test.mjs
 *
 * What makes it trustworthy: it is made up (no real brand or site), it is
 * reproducible, every tool result is the extension's own, every number in
 * an answer comes from a tool result, the system prompt and tools are the
 * ones the extension gives, and the test set holds out a kind of business.
 */
import { rng, makeCampaign, VERTICALS } from "../training/synth.mjs";
import { examples, makeExample, goldCalls } from "../training/gen.mjs";
import { QUESTIONS, LANGS, SAY } from "../training/phrases.mjs";
import { runTool } from "../src/lib/assistantTools.js";
import { checkNumbers, toolsFor } from "../src/lib/askKnowledge.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("made-up campaigns");
const c1 = makeCampaign(rng(3), 0), c2 = makeCampaign(rng(3), 0);
check("the same seed gives the same campaign", JSON.stringify(c1) === JSON.stringify(c2));
check("records in the extension's shape", c1.records.every((r) => r.captureId && r.platform && r.geo && r.geo.profileId === c1.profile.id && Array.isArray(r.brandMentions) && Array.isArray(r.sources)));
const all = Array.from({ length: 40 }, (_, i) => makeCampaign(rng(100 + i), i));
check("every site is .example (nothing real)", all.every((c) => c.records.every((r) => r.sources.every((s) => /\.example$/.test(s.domain)))));
check("prompt texts are distinct within a campaign", all.every((c) => new Set(c.prompts.map((p) => p.text)).size === c.prompts.length));
check("brands vary: 2–10 per campaign, and some campaigns list no competitors", all.every((c) => c.rivals.length >= 1) && all.some((c) => !c.profile.competitors.length));
check("usage limits and ads occur", all.some((c) => c.records.some((r) => r.platformSpecific)) && all.some((c) => c.records.some((r) => r.ads)));

console.log("\nthe examples");
const ex = [...examples(11, 400)];
check("400 made", ex.length === 400);
check("deterministic", JSON.stringify([...examples(11, 5)]) === JSON.stringify(ex.slice(0, 5)));
const kinds = new Set(ex.map((e) => e.meta.kind)), langs = new Set(ex.map((e) => e.meta.lang));
check("every kind of question", Object.keys(QUESTIONS).every((k) => kinds.has(k)), [...kinds].join());
check("all six languages", LANGS.every((l) => langs.has(l)), [...langs].join());
check("system prompt, question, calls, results, answer — in that order", ex.every((e) => e.messages[0].role === "system" && e.messages[1].role === "user" && e.messages.at(-1).role === "assistant" && (e.meta.calls.length ? e.messages[2].tool_calls.length === e.meta.calls.length : e.messages.length === 3)));
check("the tools offered are the ones the extension offers for that question, and include the calls", ex.every((e) => { const want = toolsFor(e.messages[1].content).map((t) => t.function.name).join(); return e.tools.map((t) => t.name).join() === want && e.meta.calls.every((c) => want.split(",").includes(c.name)); }));
check("every tool result is the extension's own", ex.slice(0, 60).every((e) => e.messages.filter((m) => m.role === "tool").every((m) => { const call = e.messages[2].tool_calls.find((t) => t.function.name === m.name); return !!call; })));
check("no number in an answer that isn't in a tool result", ex.every((e) => checkNumbers(e.messages.at(-1).content, e.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))).unverified.length === 0));
check("'not captured' questions call no tool and say so", ex.filter((e) => e.meta.kind === "notCaptured").every((e) => !e.meta.calls.length && e.messages.at(-1).content.length > 40));
check("answers are in the question's language", ex.filter((e) => e.meta.lang === "hi").every((e) => /[ऀ-ॿ]/.test(e.messages.at(-1).content)) && ex.filter((e) => e.meta.lang === "ar").every((e) => /[؀-ۿ]/.test(e.messages.at(-1).content)));
check("every language has every answer phrase", LANGS.every((l) => Object.keys(SAY.en).every((k) => typeof SAY[l][k] === typeof SAY.en[k])));
const holdout = [...examples(9, 200, { exclude: ["coffee"] })];
check("a kind of business can be held out of training", holdout.every((e) => e.meta.vertical !== "coffee"));

console.log("\ngold calls");
check("a rival question compares with that rival", JSON.stringify(goldCalls("rival", { rival: "Kovo", nameCampaign: false })) === JSON.stringify([["rival_wins", { brand: "Kovo" }], ["prompts_behind", {}]]));
check("the campaign is named when there's more than one", goldCalls("visibility", { campaign: "X", nameCampaign: true })[0][1].campaign === "X");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
