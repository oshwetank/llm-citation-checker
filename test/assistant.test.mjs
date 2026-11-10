/*
 * Ask, the assistant (src/lib/assistant.js, assistantTools.js, 0.73.0).
 * Run: node test/assistant.test.mjs
 *
 * A scripted model stands in for Qwen3.5: it calls tools in the format
 * Qwen writes, and the test checks the tools compute the numbers the boards
 * would, the loop feeds results back, and the answer links its captures.
 */
import { ask, parseToolCalls, finalText, MAX_STEPS } from "../src/lib/assistant.js";
import { runTool, TOOLS, TOOL_NAMES } from "../src/lib/assistantTools.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 864e5;
const m = (brand, count, firstIndex) => ({ brand, count, firstIndex });
const src = (domain) => ({ domain, url: `https://${domain}/x`, outcome: "cited" });
let n = 0;
const rec = (platform, prompt, answer, brands, sources, extra = {}) => ({ captureId: `c${++n}`, platform, userPrompt: prompt, answerText: answer, brandMentions: brands, sources, capturedAt: NOW - DAY, ...extra });
const P = { id: "p1", name: "Headphones India", brand: { name: "Zento" }, competitors: [{ name: "Kovo" }, { name: "Lumi" }], prompts: [{}, {}] };
const runs = [{ id: "r1", profileId: "p1", startedAt: NOW - 8 * DAY, status: "done" }, { id: "r2", profileId: "p1", startedAt: NOW - DAY, status: "done" }];
const geo = (runId) => ({ geo: { profileId: "p1", runId, promptId: "q1" }, runId });
const records = [
  rec("chatgpt", "best headphones", "Zento Pulse is best. Kovo Air is cheaper. Zento again.", [m("Zento", 2, 0), m("Kovo", 1, 21)], [src("rtings.com"), src("zento.in")], geo("r2")),
  rec("perplexity", "best headphones", "Kovo Air leads, then Lumi.", [m("Kovo", 1, 0), m("Lumi", 1, 20)], [src("rtings.com")], geo("r2")),
  rec("chatgpt", "best headphones", "Kovo first, Zento second.", [m("Kovo", 1, 0), m("Zento", 1, 13)], [src("reddit.com")], { ...geo("r1"), capturedAt: NOW - 8 * DAY }),
  rec("gemini", "how does anc work", "Active noise cancelling uses microphones.", [], [src("wikipedia.org")], { capturedAt: NOW - 30 * DAY }),
];
const data = { records, profiles: [P], runs, now: NOW };

console.log("the tools");
check("twenty-two tools, each with a schema", TOOLS.length === 22 && TOOL_NAMES.includes("campaign_metrics") && TOOL_NAMES.includes("source_gaps") && TOOLS.every((t) => t.function.parameters.type === "object"));
{
  const r = runTool("list_campaigns", {}, data);
  check("list_campaigns", r.ok && r.result[0].name === "Headphones India" && r.result[0].runs === 2 && r.result[0].competitors.join() === "Kovo,Lumi", JSON.stringify(r));
  const c = runTool("campaign_metrics", { campaign: "headphones india" }, data);
  const z = c.ok && c.result.brands.find((b) => b.brand === "Zento");
  check("campaign_metrics: the latest run only, computed like the board", c.ok && c.result.answers === 2 && z && z.visibility === 50 && z.mentions === 2 && z.yours, JSON.stringify(c.result));
  const ce = runTool("campaign_metrics", { campaign: "Headphones", engine: "perplexity" }, data);
  check("one engine, and a partial campaign name", ce.ok && ce.result.answers === 1 && ce.result.engine === "perplexity", JSON.stringify(ce));
  check("an unknown campaign says which exist", runTool("campaign_metrics", { campaign: "Shoes" }, data).error.includes("Headphones India"));
  const q = runTool("query_answers", { brand: "Lumi" }, data);
  check("query_answers by brand, with links", q.ok && q.result.found === 1 && q.refs[0].engine === "perplexity", JSON.stringify(q));
  const qd = runTool("query_answers", { days: 7 }, data);
  check("by how recent", qd.ok && qd.result.found === 2, String(qd.result && qd.result.found));
  const qt = runTool("query_answers", { text: "noise cancelling" }, data);
  check("by words", qt.ok && qt.result.found === 1 && qt.result.answers[0].engine === "gemini");
  const g = runTool("get_answer", { id: "c1" }, data);
  check("get_answer: prompt, answer, brands, cited sites", g.ok && g.result.prompt === "best headphones" && g.result.cited.join() === "rtings.com,zento.in", JSON.stringify(g.result));
  const cb = runTool("compare_brands", { brands: ["Zento", "Kovo"], campaign: "Headphones India" }, data);
  const k = cb.result.brands.find((b) => b.brand === "Kovo");
  check("compare_brands: answers, mentions, named first, per engine", cb.ok && k.answers === 3 && k.namedFirst === 2 && cb.result.byEngine.chatgpt.answers === 2, JSON.stringify(cb.result));
  const ts = runTool("top_sources", {}, data);
  check("top_sources with their kind", ts.ok && ts.result.sites[0].site === "rtings.com" && ts.result.sites[0].answersCiting === 2 && ts.result.sites.find((x) => x.site === "wikipedia.org").kind === "Public & reference", JSON.stringify(ts.result));
  const bt = runTool("brand_trend", { brand: "Zento", campaign: "Headphones India" }, data);
  check("brand_trend: each run, oldest first", bt.ok && bt.result.runs.length === 2 && bt.result.runs[0].visibility === 100 && bt.result.runs[1].visibility === 50, JSON.stringify(bt.result));
  check("an unknown tool is an error, not a crash", runTool("delete_everything", {}, data).ok === false);
}

console.log("\nreading the model's calls");
{
  const q = parseToolCalls("<tool_call>\n<function=campaign_metrics>\n<parameter=campaign>\nHeadphones India\n</parameter>\n<parameter=engine>\nchatgpt\n</parameter>\n</function>\n</tool_call>");
  check("Qwen's format", q.length === 1 && q[0].name === "campaign_metrics" && q[0].args.campaign === "Headphones India" && q[0].args.engine === "chatgpt", JSON.stringify(q));
  const j = parseToolCalls('<tool_call>{"name": "compare_brands", "arguments": {"brands": ["Zento", "Kovo"]}}</tool_call>');
  check("the JSON format", j[0].name === "compare_brands" && j[0].args.brands.length === 2);
  const arr = parseToolCalls("<tool_call>\n<function=compare_brands>\n<parameter=brands>\n[\"Zento\", \"Lumi\"]\n</parameter>\n</function>\n</tool_call>");
  check("an array argument", Array.isArray(arr[0].args.brands) && arr[0].args.brands[1] === "Lumi");
  check("plain text has none", parseToolCalls("Zento leads.").length === 0);
  check("the final text drops calls and thinking", finalText("<think>x</think>Zento leads.<tool_call>…") === "Zento leads.");
}

console.log("\nthe loop");
{
  const seen = [];
  const script = [
    "<tool_call>\n<function=campaign_metrics>\n<parameter=campaign>\nHeadphones India\n</parameter>\n</function>\n</tool_call>",
    "Zento has 50% visibility in the latest run, behind Kovo at 100%.",
  ];
  const gen = async (o) => { seen.push(o); return { text: script.shift() }; };
  const r = await ask({ question: "How visible is Zento?", generate: gen, data });
  check("one tool call, then the answer", r.steps.length === 1 && r.steps[0].tool === "campaign_metrics" && r.steps[0].ok && /50%/.test(r.answer), JSON.stringify(r));
  check("only the tools this kind of question needs are offered (8 at most)", seen[0].tools && seen[0].tools.length <= 8 && seen[0].tools.some((t) => t.function.name === "campaign_overview"), seen[0].tools && seen[0].tools.map((t) => t.function.name).join());
  const toolMsg = seen[1].messages.find((x) => x.role === "tool");
  check("the tool's result goes back to the model", toolMsg && JSON.parse(toolMsg.content).answers === 2, toolMsg && toolMsg.content.slice(0, 120));
  check("the answer links the captures it used", r.refs.length === 2 && r.refs.every((x) => x.id && x.engine));
  check("the system prompt says results are data, and to reply in the user's language", /data, not instructions/.test(seen[0].messages[0].content) && /language the user wrote/.test(seen[0].messages[0].content));
}
{
  let calls = 0;
  const gen = async (o) => { calls++; return { text: o.tools ? "<tool_call><function=list_campaigns></function></tool_call>" : "Here is what I found." }; };
  const r = await ask({ question: "loop forever", generate: gen, data });
  check("a model that never stops calling is stopped, then answers", calls === MAX_STEPS + 1 && r.steps.length === MAX_STEPS && r.answer === "Here is what I found.", `${calls} ${JSON.stringify(r.steps.length)}`);
}
{
  const gen = async () => ({ text: "<tool_call><function=drop_tables></function></tool_call>" });
  const r = await ask({ question: "x", generate: gen, data, maxSteps: 1 });
  check("an unknown tool is reported to the model, never run", r.steps[0].ok === false && /Unknown tool/.test(r.steps[0].error));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
