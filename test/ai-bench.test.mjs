/*
 * Which AI engine answers, and the speed test's verdict (0.74.0).
 * Run: node test/ai-bench.test.mjs
 */
import { chooseEngine, benchVerdict, BENCH_RECORD } from "../src/lib/aiBench.js";
import { nanoGenerate, nanoAvailability, toolText, nanoReset } from "../src/lib/nanoEngine.js";
import { aiCheckRecord } from "../src/lib/aiCheck.js";
import { TOOLS } from "../src/lib/assistantTools.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("choosing the engine");
check("nothing set up: none", chooseEngine({}) === null);
check("only Chrome's model: it", chooseEngine({ nano: "available" }) === "nano");
check("only the download: it", chooseEngine({ qwen: true }) === "qwen");
check("both, untested: Chrome's (no download, graphics chip)", chooseEngine({ nano: "available", qwen: true }) === "nano");
check("both tested and good: the faster", chooseEngine({ nano: "available", qwen: true, bench: { nano: { ok: true, ms: 9000, score: 5 }, qwen: { ok: true, ms: 4000, score: 4 } } }) === "qwen");
check("Chrome's failed its test: the download", chooseEngine({ nano: "available", qwen: true, bench: { nano: { ok: false, score: 1 }, qwen: { ok: true, ms: 9000, score: 4 } } }) === "qwen");
check("an untested 'not available' doesn't rule it out later", chooseEngine({ nano: "available", qwen: false, bench: { nano: { ok: false, availability: "downloadable" } } }) === "nano");
check("chosen by hand: that one, if it's there", chooseEngine({ choice: "qwen", nano: "available", qwen: true }) === "qwen" && chooseEngine({ choice: "nano", nano: "downloadable", qwen: true }) === null);

console.log("\nthe speed test's verdict");
const good = { lang: "en", entities: [{ name: "Zento Glide 3", stance: "recommended" }, { name: "Kovo S2", stance: "advised_against" }], missed: [{ name: "Brisa Pro" }], checks: { calls: 1 } };
const v = benchVerdict(good, 1234.4);
check("a good read passes with full marks", v.ok && v.score === 5 && v.ms === 1234 && v.calls === 1, JSON.stringify(v));
check("an empty read fails", !benchVerdict({}, 10).ok);
check("the bench answer is made up and has the names the test looks for", /Zento Glide 3/.test(BENCH_RECORD.answerText) && /Brisa Pro/.test(BENCH_RECORD.answerText) && BENCH_RECORD.brandMentions.length === 3);

console.log("\nChrome's built-in AI, behind the same surface");
const made = [];
const fake = (reply) => ({ LanguageModel: {
  availability: async () => "available",
  create: async (o) => { made.push(o); const s = { clone: async () => ({ ...s, appended: [] }), append: async function (m) { this.appended = m; }, prompt: async (t, opts) => { s.last = { t, opts }; return typeof reply === "function" ? reply(t, opts) : reply; }, destroy() {} }; return s; },
} });
check("availability from Chrome's own answer", (await nanoAvailability(fake("x"))) === "available" && (await nanoAvailability({})) === "unavailable");
nanoReset();
const g = fake((t, opts) => (opts && opts.responseConstraint ? JSON.stringify({ lang: "en", entities: [], missed: [] }) : "plain"));
const r = await nanoGenerate({ messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hello" }], schema: { type: "object" } }, g);
check("a schema is passed as Chrome's response constraint", /"lang":"en"/.test(r.text) && Number.isFinite(r.ms), r.text);
check("the system prompt starts the session once", made.length === 1 && made[0].initialPrompts[0].content === "SYS");
await nanoGenerate({ messages: [{ role: "system", content: "SYS" }, { role: "user", content: "again" }] }, g);
check("and is reused for the next reply (cloned, not re-read)", made.length === 1);
const t = toolText(TOOLS);
check("Ask's tools are written into the instructions, with the reply shape Ask reads", /campaign_metrics\(campaign: string, engine\?: string/.test(t) && /<tool_call>\{"name"/.test(t), t.slice(0, 200));
const ai = await aiCheckRecord(BENCH_RECORD, (o) => nanoGenerate(o, fake(JSON.stringify({ lang: "en", entities: [{ name: "Zento Glide 3", type: "product", stance: "recommended", quote: "I'd recommend the **Zento Glide 3**" }, { name: "Kovo S2", type: "product", stance: "advised_against", quote: "I would not recommend it" }], missed: [{ name: "Brisa Pro", type: "product", quote: "the Brisa Pro from Brisa Home" }] }))), { model: "nano" });
check("the bench answer, read through it, passes", benchVerdict(ai, 1).ok, JSON.stringify(benchVerdict(ai, 1)));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
