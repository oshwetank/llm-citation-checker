/*
 * chatgpt-hourly-limit.test.mjs — ChatGPT's hourly cap is a limit, not an
 * empty answer (1.0.4).
 *
 * Stress run of 23 Nov 2026: once the account hit its cap, ChatGPT answered
 * the send with plain JSON, {"detail":"You've reached our limit of messages
 * per hour. Please try again later."}. It was stored as an empty answer and
 * 22 turns counted as done. Marked as a limit, the run pauses ChatGPT and
 * asks those prompts again after the cooldown.
 * Run: node test/chatgpt-hourly-limit.test.mjs
 */
import { adapt, limitDetailOf } from "../src/adapters/chatgpt.js";
import { usageLimitOf } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const reqBody = JSON.stringify({ action: "next", messages: [{ author: { role: "user" }, content: { content_type: "text", parts: ["Best paint for damp walls"] } }] });

console.log("\nThe hourly cap reply");
{
  const raw = JSON.stringify({ detail: "You've reached our limit of messages per hour. Please try again later." });
  check("is read as a limit", /limit of messages per hour/.test(limitDetailOf(raw) || ""));
  const rec = await adapt({ url: "https://chatgpt.com/backend-api/f/conversation", raw, reqBody, capturedAt: Date.now() });
  check("the record has no answer", rec && !(rec.answerText || "").trim(), JSON.stringify(rec && rec.answerText));
  check("and says the engine hit its limit, so the run pauses", !!usageLimitOf(rec), JSON.stringify(rec && rec.platformSpecific && rec.platformSpecific.gatewayError));
}

console.log("\nNot every JSON reply is a limit");
{
  check("an ordinary error is not", limitDetailOf(JSON.stringify({ detail: "Conversation not found" })) === null);
  check("a stream is not", limitDetailOf("data: {\"v\":\"hi\"}\n\n") === null);
  check("text that isn't JSON is not", limitDetailOf("You've reached our limit") === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
