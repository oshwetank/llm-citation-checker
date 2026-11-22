/*
 * perplexity-block-stream.test.mjs — Perplexity's live answer stream is read.
 *
 * A real v0.42 run logged every /rest/sse/perplexity_ask response as
 * unreadable (keys backend_uuid, context_uuid, uuid, frontend_context_uuid,
 * frontend_uuid, display_model…): 150-430 KB answer streams, captured and then
 * dropped as 0-signal, so Perplexity results came only from the slower DOM
 * harvest. The answer now lives in a `blocks` array — markdown_block chunks,
 * or a workflow_block patched by diff_blocks — with sources in
 * web_result_block, and the request body carries the prompt as query_str.
 *
 * The streams below are SYNTHETIC, in the shapes a maintained client of the
 * same endpoint parses (henrique-coder/perplexity-webui-scraper,
 * core/parser.py and core/payload.py). No real Perplexity conversation is
 * copied into this repository. The legacy-format fixtures keep their own
 * tests; one is re-read here to show they still parse the old way.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "best budget phone for photography in india";
const R1 = { name: "Budget camera phones tested", url: "https://reviews.example/budget-camera", snippet: "We tested ten phones" };
const R2 = { name: "Moto camera review", url: "https://mobiles.example/moto-review", snippet: "Colour science" };
const R3 = { name: "Phones on sale", url: "https://shop.example/phones", snippet: "Deals" };
const reqBody = JSON.stringify({ params: { version: "2.18", language: "en-US" }, query_str: PROMPT });

const ids = { backend_uuid: "b-1", context_uuid: "c-1", uuid: "u-1", frontend_context_uuid: "fc-1", frontend_uuid: "f-1" };
const event = (fields) => `event: message\ndata: ${JSON.stringify({ ...ids, display_model: "turbo", ...fields })}\n`;

console.log("\nmarkdown_block chunks, placed by offset");
{
  const raw = [
    event({ blocks: [{ intended_usage: "web_results", web_result_block: { progress: "DONE", web_results: [R1, R2, R3] } }] }),
    event({ blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["The Pixel 9a ", "is the pick"], chunk_starting_offset: 0 } }] }),
    event({ blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: [" for photos [1],", " with Moto close behind [2]."], chunk_starting_offset: 2 } }] }),
    event({ text_completed: true, final_sse_message: true, blocks: [{ intended_usage: "pro_search_steps", plan_block: { steps: [{ step_type: "SEARCH_WEB", search_web_content: { queries: [{ engine: "web", query: "budget camera phone india 2026" }] } }] } }] }),
  ].join("\n");
  const r = await adapt({ captureId: "m1", raw, reqBody, capturedAt: 1, pageUrl: "https://www.perplexity.ai/search/x" });
  check("the prompt is read from query_str", r.userPrompt === PROMPT, r.userPrompt);
  check("the answer is the chunks in order", /^The Pixel 9a is the pick for photos/.test(r.answerText) && /Moto close behind/.test(r.answerText), r.answerText);
  check("[1] becomes a citation of the first result", r.answerText.includes(`[[cite:${R1.url}]]`), r.answerText);
  check("[2] becomes a citation of the second", r.answerText.includes(`[[cite:${R2.url}]]`), r.answerText);
  const byUrl = new Map(r.sources.map((s) => [s.url, s]));
  check("every result is a source", byUrl.size === 3, [...byUrl.keys()].join(" "));
  check("cited results are cited", byUrl.get(R1.url)?.outcome === "cited" && byUrl.get(R2.url)?.outcome === "cited");
  check("an uncited result is fetched", byUrl.get(R3.url)?.outcome === "fetched", byUrl.get(R3.url)?.outcome);
  check("source titles come from the result names", byUrl.get(R1.url)?.title === R1.name, byUrl.get(R1.url)?.title);
  check("the search query is fan-out", r.fanout.search.some((q) => q.query === "budget camera phone india 2026"), JSON.stringify(r.fanout.search));
  check("the model is the stream's display_model", r.model === "turbo", r.model);
  check("it has signal, so it is stored rather than dropped as 0-signal", r.answerChars > 0);
  check("marked as a complete block stream", r.platformSpecific.transport === "blocks" && r.platformSpecific.streamFinal === true,
    JSON.stringify({ t: r.platformSpecific.transport, f: r.platformSpecific.streamFinal }));
}

console.log("\nchunks rewritten at an earlier offset, and a restart at offset 0");
{
  const raw = [
    event({ blocks: [{ markdown_block: { chunks: ["draft one"], chunk_starting_offset: 0 } }] }),
    event({ blocks: [{ markdown_block: { chunks: ["Final ", "answer"], chunk_starting_offset: 0 } }] }),
    event({ blocks: [{ markdown_block: { chunks: [" text."], chunk_starting_offset: 2 } }] }),
    event({ blocks: [{ markdown_block: { chunks: ["ANSWER"], chunk_starting_offset: 1 } }] }),
  ].join("\n");
  const r = await adapt({ captureId: "m2", raw, reqBody, capturedAt: 1 });
  check("offset 0 starts over and later offsets overwrite in place", r.answerText === "Final ANSWER text.", JSON.stringify(r.answerText));
}

console.log("\nmarkdown_block's answer field, when longer than the chunks so far");
{
  const raw = [
    event({ blocks: [{ markdown_block: { chunks: ["Partial"], chunk_starting_offset: 0 } }] }),
    event({ final_sse_message: true, blocks: [{ markdown_block: { answer: "Partial answer, completed in full." } }] }),
  ].join("\n");
  const r = await adapt({ captureId: "m3", raw, reqBody, capturedAt: 1 });
  check("the longer text wins", r.answerText === "Partial answer, completed in full.", JSON.stringify(r.answerText));
}

console.log("\nworkflow_block patched by diff_blocks");
{
  const workflow = { steps: [{ items: [{ payload: { text_payload: { text: "", chunks: [] } } }] }] };
  const raw = [
    event({ blocks: [{ workflow_block: workflow }] }),
    event({ blocks: [{ diff_block: { patches: [{ op: "add", path: "/steps/0/items/0/payload/text_payload/chunks/-", value: "Workflow " }] } }] }),
    event({ blocks: [{ diff_block: { patches: [{ op: "add", path: "/steps/0/items/0/payload/text_payload/chunks/-", value: "answer [3]." }] } }] }),
    event({ final_sse_message: true, blocks: [{ web_result_block: { web_results: [R1, R2, R3] } }] }),
  ].join("\n");
  const r = await adapt({ captureId: "w1", raw, reqBody, capturedAt: 1 });
  check("the patched workflow text is the answer", r.answerText.startsWith("Workflow answer"), JSON.stringify(r.answerText));
  check("its citation resolves against the results", r.answerText.includes(`[[cite:${R3.url}]]`), r.answerText);
}

console.log("\nA marker with no matching result is left as written");
{
  const raw = [
    event({ blocks: [{ web_result_block: { web_results: [R1] } }] }),
    event({ blocks: [{ markdown_block: { chunks: ["One source [1], a stray [7]."], chunk_starting_offset: 0 } }] }),
  ].join("\n");
  const r = await adapt({ captureId: "s1", raw, reqBody, capturedAt: 1 });
  check("resolvable markers convert, unresolvable ones stay", r.answerText === `One source [[cite:${R1.url}]], a stray [7].`, r.answerText);
}

console.log("\nThe legacy format still reads the old way");
{
  const fixture = readFileSync(new URL("./fixtures/perplexity-cameraPhoneCiteMarkers.txt", import.meta.url), "utf8");
  const body = fixture.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  const req = (fixture.match(/^# reqBody: (.*)$/m) || [])[1] || null;
  const r = await adapt({ captureId: "l1", raw: body, reqBody: req, capturedAt: 1 });
  check("a legacy capture still yields its answer", r.answerChars > 100, r.answerChars);
  check("and is marked legacy", r.platformSpecific.transport === "legacy", r.platformSpecific.transport);
}

console.log("\nevery snippet a page came with (1.0.2)");
{
  // Live run, 22 Nov 2026: the cited economictimes page came first with a
  // snippet naming BHIVE, last with one that didn't; only the last was kept.
  const U = "https://economictimes.example/bhive-largest-coworking";
  const ev = (o) => `event: message\ndata: ${JSON.stringify({ query_str: "top coworking spaces in Bangalore", ...o })}\n\n`;
  const raw =
    ev({ blocks: [{ intended_usage: "web_results", web_result_block: { web_results: [{ name: "BHIVE opens the largest space", url: U, snippet: "BHIVE Workspace has opened the world's largest coworking space for startups." }] } }] }) +
    ev({ final_sse_message: true, status: "COMPLETED", blocks: [
      { intended_usage: "ask_text", markdown_block: { answer: "BHIVE Workspace is the largest option.[1]" } },
      { intended_usage: "web_results", web_result_block: { web_results: [{ name: "BHIVE opens the largest space", url: U, snippet: "The facility was inaugurated by the Chief Minister." }] } },
    ] });
  const rec = await adapt({ captureId: "s", raw, reqBody: JSON.stringify({ query_str: "top coworking spaces in Bangalore" }), pageUrl: "https://www.perplexity.ai/search/x", capturedAt: 1 });
  const s = rec.sources.find((x) => x.url === U) || {};
  check("the last snippet is still first", /^The facility was inaugurated/.test(s.snippet || ""), s.snippet);
  check("and the earlier one, naming the brand, is kept", /BHIVE Workspace has opened/.test(s.snippet || ""), s.snippet);
}

console.log("\na page's date and trust badge, as the stream sends them (1.0.2)");
{
  const U = "https://reviews.example/coworking";
  const raw = `event: message\ndata: ${JSON.stringify({ query_str: "top coworking spaces", final_sse_message: true, status: "COMPLETED", blocks: [
    { intended_usage: "ask_text", markdown_block: { answer: "Hivebase is the pick.[1]" } },
    { intended_usage: "web_results", web_result_block: { web_results: [{ name: "Coworking review", url: U, snippet: "Hivebase…", timestamp: "2026-10-22T00:00:00", trust: { level: 1, name: "trusted", type_of_trust: "trusted" } }] } },
  ] })}\n\n`;
  const rec = await adapt({ captureId: "d", raw, reqBody: JSON.stringify({ query_str: "top coworking spaces" }), pageUrl: "https://www.perplexity.ai/search/x", capturedAt: 1 });
  const ps = (rec.sources.find((s) => s.url === U) || {}).platformSpecific || {};
  check("its date", ps.pubDate === Date.parse("2026-10-22T00:00:00Z"), JSON.stringify(ps));
  check("its trusted badge", ps.trusted === true, JSON.stringify(ps));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
