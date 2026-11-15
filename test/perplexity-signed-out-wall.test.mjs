/*
 * perplexity-signed-out-wall.test.mjs — Perplexity's "sign up" wall is a
 * limit, not an answer.
 *
 * In the owner's private-window campaign of 15 Nov 2026, 133 of 139
 * Perplexity turns were stored as answers that only said "Sign up and repeat
 * your request." (in the account's language). Their shape: no answer block, the
 * text in one workflow step, no search results, no searches. Real answers in the
 * same run used the same workflow block but carried results. The streams here
 * are SYNTHETIC copies of that shape. No real conversation is stored.
 */
import { adapt } from "../src/adapters/perplexity.js";
import { usageLimitOf } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "best phone with ir blaster";
const reqBody = JSON.stringify({ params: { language: "en-GB" }, query_str: PROMPT });
const ids = { backend_uuid: "b-1", context_uuid: "c-1", uuid: "u-1", frontend_context_uuid: "fc-1", frontend_uuid: "f-1" };
const event = (fields) => `event: message\ndata: ${JSON.stringify({ ...ids, display_model: "turbo", query_str: PROMPT, ...fields })}\n`;
const workflow = (text) => ({ intended_usage: "workflow_root", workflow_block: { status: "WORKFLOW_COMPLETED", steps: [{ status: "WORKFLOW_COMPLETED", title: "", items: [{ id: "i1", type: "WORKFLOW_ITEM_TEXT", payload: { text_payload: { text, chunks: [text], variant: "answer" } }, variant: "answer" }] }] } });
const LOGIN = { upsell_information: { upsell_type: "LOGIN", cta: "SIGN_UP_OR_LOGIN" } };
const run = (raw) => adapt({ captureId: "t", raw, reqBody, pageUrl: "https://www.perplexity.ai/rest/sse/perplexity_ask", capturedAt: Date.now() });

for (const wall of ["Sign up and repeat your request.", "Daftar dan ulangi permintaan Anda.", "Iscriviti e ripeti la richiesta."]) {
  console.log(`\nthe wall: ${wall}`);
  const r = await run([
    event({ blocks: [workflow(wall)] }),
    event({ text_completed: true, final: true, final_sse_message: true, status: "COMPLETED", blocks: [workflow(wall)], ...LOGIN }),
    "event: end_of_stream\ndata: {}\n",
  ].join("\n"));
  check("is a usage limit", !!usageLimitOf(r), JSON.stringify(r.platformSpecific.gatewayError));
  check("has no answer text", r.answerChars === 0 && r.answerText === "", r.answerText);
  check("keeps what Perplexity said", r.platformSpecific.refusal === wall);
}

console.log("\na real answer through the same workflow block, with sources and the LOGIN upsell");
{
  const text = "For a balanced all-rounder under ₹20,000, consider the Samsung Galaxy A17 5G.";
  const R1 = { name: "Phones under 20000", url: "https://reviews.example/under-20k", snippet: "tested" };
  const r = await run([
    event({ blocks: [{ intended_usage: "web_results", web_result_block: { web_results: [R1] } }] }),
    event({ text_completed: true, final: true, final_sse_message: true, blocks: [workflow(text), { intended_usage: "web_results", web_result_block: { web_results: [R1] } }], ...LOGIN }),
  ].join("\n"));
  check("is not a limit", !usageLimitOf(r), r.platformSpecific.gatewayError);
  check("keeps the answer", r.answerText.includes("Samsung Galaxy A17"), r.answerText);
}

console.log("\na stream still running is not judged");
{
  const r = await run(event({ blocks: [workflow("Sign up and repeat your request.")] }));
  check("not a limit before the final event", !usageLimitOf(r));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
