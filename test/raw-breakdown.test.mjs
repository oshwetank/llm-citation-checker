/*
 * The raw payload breakdown (src/lib/rawBreakdown.js, 0.60.1).
 * Run: node test/raw-breakdown.test.mjs
 *
 * Researchers asked for the engine's raw response under the prompt,
 * structured, for any kind of answer. No schema can be assumed, so this runs
 * the breakdown over every fixture in the repo (four engines, five framings)
 * and over made-up payloads in shapes no engine sends today, and checks that
 * nothing throws, that ChatGPT's thousands of deltas fold into a few fields,
 * that the sections hold what their names say, and that what no rule knows is
 * listed with samples rather than dropped. The on-device labeller is checked
 * against a fake model: it may only label fields it was asked about.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rawBreakdown, parseRaw, sectionOf } from "../src/lib/rawBreakdown.js";
import { labelRawFieldsWithNano } from "../src/lib/nano.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const field = (b, sec, re) => (b.sections.find((s) => s.id === sec) || { fields: [] }).fields.find((f) => re.test(f.path));
const allFields = (b) => b.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.id })));

console.log("every fixture");
for (const name of readdirSync(FIX).filter((f) => /\.(txt|html|json)$/.test(f))) {
  let b = null, err = null;
  const t0 = Date.now();
  try { b = rawBreakdown(readFileSync(join(FIX, name), "utf8")); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  check(`${name}: read as ${b ? b.format : "?"} into ${b ? b.fieldCount : 0} fields`, b && b.fieldCount > 0 && b.sections.length > 0, err ? err.stack : "");
  if (b) check(`${name}: within the field cap and quick (${ms}ms)`, b.fieldCount <= 1500 && ms < 5000);
}

console.log("ChatGPT: deltas fold into fields");
{
  const raw = readFileSync(join(FIX, "chatgpt-genui-cards.txt"), "utf8");
  const b = rawBreakdown(raw, { reqBody: '{"action":"next","model":"auto","messages":[{"content":{"parts":["best camera phone under 30000"]}}]}' });
  check("framing is server-sent events", b.format === "sse");
  const parts = field(b, "answer", /^message\.content\.parts\.\[\]$/);
  check("every append to the answer is one field with a count", parts && parts.count > 50 && parts.ops.includes("append"), JSON.stringify(parts && { count: parts.count, ops: parts.ops }));
  check("a patch to message metadata lands on the same path as the header's", !!field(b, "layout", /^message\.metadata\.genui_components\.\[\]\.component_resolution_id$/));
  check("component ids in a path become {id}", !!field(b, "shopping", /componentResults\.\{id\}\.state\.images\.\[\]\.content_url$/));
  check("searches the engine ran are under Searches", !!field(b, "searches", /queries/));
  check("search results' addresses are under Sources", (field(b, "sources", /search_result_groups\.\[\]\.entries\.\[\]\.url$/) || {}).samples?.[0]?.startsWith("https://"));
  check("message roles are under Messages and stream", !!field(b, "stream", /message\.author\.role$/));
  check("object types are counted", b.objectTypes.some((t) => t.type === "search_result" && t.count === 4), JSON.stringify(b.objectTypes.slice(0, 6)));
  check("the request is broken down too", (b.sections.find((s) => s.id === "request") || { fields: [] }).fields.some((f) => /model/.test(f.path)));
  check("[DONE] is kept as text, not lost", allFields(b).some((f) => f.path === "(text)" && f.samples.includes("[DONE]")));
}

console.log("Gemini: positional arrays and JSON inside strings");
{
  const b = rawBreakdown(readFileSync(join(FIX, "gemini-streamgenerate.txt"), "utf8"));
  check("framing is length-prefixed batches", /batched/.test(b.format), b.format);
  check("JSON inside strings is opened", allFields(b).some((f) => f.path.includes("⟨json⟩")));
  check("slots keep their numbers", allFields(b).some((f) => /\[2\]\.⟨json⟩\.\[4\]/.test(f.path)));
  check("the answer text is found by what it holds", b.sections.find((s) => s.id === "answer")?.fields.some((f) => /Vivo V70/.test(f.longest || f.samples.join(" "))));
  check("always-empty slots are counted, not listed", b.sections.reduce((n, s) => n + s.emptyFields, 0) > 10);
}

console.log("Perplexity and HTML");
{
  const b = rawBreakdown(readFileSync(join(FIX, "perplexity-cameraPhoneCiteMarkers.txt"), "utf8"));
  check("a JSON document reads as JSON", b.format === "JSON");
  const h = rawBreakdown(readFileSync(join(FIX, "perplexity-answer-dom.html"), "utf8"));
  check("an HTML page is one HTML field, not parsed as data", h.format === "HTML" && h.fieldCount === 1);
}

console.log("shapes no engine sends today");
{
  const future = JSON.stringify({ zq: { blorp: [{ wib: "a", wob: 2 }, { wib: "b", wob: 3 }] }, citations: [{ url: "https://x.example/a" }], frobnicate: "lorem" });
  const b = rawBreakdown(future);
  const other = b.sections.find((s) => s.id === "other");
  check("unknown fields are listed under Not recognised", other && other.fields.some((f) => f.path === "zq.blorp.[].wib"), JSON.stringify(other && other.fields.map((f) => f.path)));
  check("with samples", other && other.fields.find((f) => f.path === "zq.blorp.[].wib").samples.join() === "a,b");
  check("known names still sort", !!field(b, "sources", /^citations\.\[\]\.url$/));
  const lines = '{"a":1}\n{"a":2,"text":"Hello there, this is a long answer with **bold** words in it."}\n';
  const j = rawBreakdown(lines);
  check("JSON lines read line by line", j.format === "JSON lines" && j.frames === 2);
  check("garbage doesn't throw", rawBreakdown("\u0000\u0001 not json {").fieldCount === 1);
  check("empty doesn't throw", rawBreakdown("").fieldCount === 0);
  const many = JSON.stringify(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])));
  const capped = rawBreakdown(many, { maxPaths: 10 });
  check("a field cap is kept and said", capped.fieldCount === 10 && capped.truncated);
  check("a price is shopping, an address is a source, by value", sectionOf("[3]", ["₹24,990"]) === "shopping" && sectionOf("[4]", ["https://a.example/p"]) === "sources");
  check("images under a layout component are images", sectionOf("message.metadata.model_dil_v2.appData.opGenui.componentResults.{id}.state.images.[].url") === "shopping");
  check("parseRaw skips the export's # header lines", parseRaw("# url: x\n# reqBody: {}\n\n{\"a\":1}").format === "JSON");
}

console.log("nothing cut off (0.60.2)");
{
  // Reported: "the raw payload breakdown queries are getting truncated".
  // 0.60.1 kept three values per field, each cut at 140 characters.
  const long = "best foldable phone for multitasking with the most powerful processor available in India this year, with split screen, floating windows, app pairs, a large inner display, long battery life and at least seven years of updates";
  const queries = [long, "q2", "q3", "q4", "q5"];
  const b = rawBreakdown(JSON.stringify({ search_model_queries: { queries } }));
  const f = field(b, "searches", /queries/);
  check("every query is kept", f && f.samples.length === 5 && f.distinct === 5, JSON.stringify(f && f.samples));
  check("a long query is kept whole", f && f.samples[0] === long);
  const sse = ["data: " + JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "Hello " }), "data: " + JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "there, " }), "data: " + JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "world." })].join("\n\n");
  const j = field(rawBreakdown(sse), "answer", /parts/);
  check("streamed pieces are put back together", j && j.joined === "Hello there, world.", JSON.stringify(j));
}

console.log("on-device labels");
{
  const fields = [{ path: "zq.blorp.[].wib", sample: "a" }, { path: "[2].⟨json⟩.[4]", sample: "If you want" }];
  globalThis.LanguageModel = {
    availability: async () => "available",
    create: async () => ({
      prompt: async () => JSON.stringify({ labels: [
        { path: "zq.blorp.[].wib", section: "stream", label: "item code" },
        { path: "[2].⟨json⟩.[4]", section: "answer", label: "answer text so far" },
        { path: "made.up.path", section: "answer", label: "invented" },
        { path: "zq.blorp.[].wib", section: "nonsense", label: "dup" },
      ] }),
      destroy() {},
    }),
  };
  const labels = await labelRawFieldsWithNano(fields, "Gemini");
  check("labels only the fields it was asked about, in known sections", JSON.stringify(labels) === JSON.stringify([
    { path: "zq.blorp.[].wib", section: "stream", label: "item code" },
    { path: "[2].⟨json⟩.[4]", section: "answer", label: "answer text so far" },
  ]), JSON.stringify(labels));
  globalThis.LanguageModel = { availability: async () => "available", create: async () => ({ prompt: async () => "not json", destroy() {} }) };
  check("a reply that isn't JSON gives no labels", (await labelRawFieldsWithNano(fields)) === null);
  delete globalThis.LanguageModel;
  check("no model, no labels", (await labelRawFieldsWithNano(fields)) === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
