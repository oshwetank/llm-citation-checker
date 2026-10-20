/*
 * What "Continue in…" sends to another AI (src/lib/contextPack.js, 0.76.0).
 * Run: node test/context-pack.test.mjs
 */
import { buildPack, campaignParts, answerParts, askParts, ENGINES, TASKS } from "../src/lib/contextPack.js";
import { campaignInsights } from "../src/lib/insights.js";
import { GLOSSARY } from "../src/lib/glossary.js";
import { profile, runs, records, Q2 } from "./helpers/campaign-fixture.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

const I = campaignInsights({ records, profile, runs });
const parts = campaignParts(I);
console.log("a campaign's pack");
const p = buildPack({ engine: "chatgpt", task: "brief", question: "How do we win the gym prompt?", parts });
check("says what CitoSkeleton is and what it doesn't capture", /CitoSkeleton, a browser extension/.test(p.text) && /does not capture clicks, traffic/.test(p.text));
check("defines the measures, from the glossary", p.text.includes(GLOSSARY.visibility.formula) && p.text.includes(GLOSSARY.shareOfVoice.what));
check("the data: brands table, change since last run, missing prompts, source gaps", /\| Zento \(mine\) \| 40%/.test(p.text) && /\| Zento \| -60/.test(p.text) && p.text.includes(`"${Q2}" — named:`) && /gadgets360\.com/.test(p.text), p.text.slice(0, 1500));
check("the request: the task, the question, how to answer", p.text.includes(TASKS.brief.ask) && /My question: How do we win the gym prompt\?/.test(p.text) && /don't invent any/.test(p.text));
check("the request comes last", p.text.lastIndexOf("## What I need from you") > p.text.lastIndexOf("## The data"));
check("fits ChatGPT's budget, nothing left out", p.chars <= ENGINES.chatgpt.budget && p.dropped.length === 0);
check("no capture ids or internal keys", !/c\d+\b|profileId|captureId/.test(p.text));

console.log("\nsized per engine");
const big = [...parts, { title: "Bulk", text: "x ".repeat(30000) }];
const small = buildPack({ engine: "perplexity", parts: big });
check("Perplexity's smaller budget is kept", small.chars <= ENGINES.perplexity.budget, String(small.chars));
check("the least important parts go first, and the pack says which", small.dropped[0] === "Bulk" && /Left out to fit this message: .*Bulk/.test(small.text));
check("the first part (which campaign) always stays", small.text.includes(`Campaign "${profile.name}"`));
check("the same data fits whole in Claude", !buildPack({ engine: "claude", parts }).dropped.length);
const tiny = buildPack({ engine: "perplexity", parts: [{ title: "Huge first", text: "y".repeat(40000) }] });
check("even a single huge part is cut to fit", tiny.chars <= ENGINES.perplexity.budget + 10, String(tiny.chars));

console.log("\nan answer's pack and Ask's");
const rec = { platform: "perplexity", capturedAt: Date.UTC(2026, 9, 18), userPrompt: "best earbuds for the gym", answerText: "Kovo Air leads, then Lumi.", brandMentions: [{ brand: "Lumi", count: 1, firstIndex: 18 }, { brand: "Kovo", count: 2, firstIndex: 0 }], sources: [{ url: "https://gadgets360.example/x", outcome: "cited", title: "Best gym earbuds" }, { url: "https://other.example/y", outcome: "read" }], fanout: { search: ["gym earbuds 2026"] } };
const a = buildPack({ engine: "gemini", task: "rival", parts: answerParts(rec, { ownBrand: "Zento" }) });
check("the prompt, engine and date", /Perplexity, 2026-10-18: "best earbuds for the gym"/.test(a.text) && /My brand: Zento/.test(a.text));
check("brands in the order the answer names them", /\| 1 \| Kovo \| 2 \|[\s\S]*\| 2 \| Lumi \| 1 \|/.test(a.text));
check("cited, read, searches and the answer itself", /Best gym earbuds — https:\/\/gadgets360\.example\/x/.test(a.text) && /other\.example/.test(a.text) && /"gym earbuds 2026"/.test(a.text) && a.text.includes("Kovo Air leads, then Lumi."));
const k = buildPack({ engine: "claude", task: "custom", question: "Where does Kovo beat us?", parts: askParts({ question: "Where does Kovo beat us?", answer: "Kovo is first in 2 answers.", steps: [{ tool: "rival_wins" }], results: [{ rivals: [{ brand: "Kovo", namedFirst: 2 }] }] }) });
check("Ask's question, reply and lookups", /What I asked CitoSkeleton's assistant/.test(k.text) && /Looked up: rival_wins/.test(k.text) && /"namedFirst": 2/.test(k.text));
check("a custom task adds no canned request", !k.text.includes(TASKS.explain.ask) && /My question: Where does Kovo beat us\?/.test(k.text));
check("five engines, each with an https address", Object.keys(ENGINES).join() === "chatgpt,claude,gemini,perplexity,grok" && Object.values(ENGINES).every((e) => e.url.startsWith("https://")));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
