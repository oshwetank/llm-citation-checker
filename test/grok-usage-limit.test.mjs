/*
 * grok-usage-limit.test.mjs — Grok's free-tier limit is a refusal, not an
 * answer "from memory" (1.0.2).
 *
 * A live run on 22 Nov 2026 reached Grok's free-tier limit after ten prompts.
 * Every later turn was stored twice as an empty answer: the gateway copy
 * already said usage_limit_reached, but the /load-responses copy carries the
 * same thing as streamErrors[].usageLimitReached and was read as an ordinary
 * empty answer. Analyze called both "From memory" — Grok, which had searched
 * on every answered turn, looked as if it had stopped searching.
 *
 * The payload below is written for this test in /load-responses' shape.
 */
import { adapt } from "../src/adapters/grok.js";
import { usageLimitOf } from "../src/lib/geo.js";
import { answerKind } from "../src/lib/analyzeView.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const empty = { message: "", query: "", webSearchResults: [], citedWebSearchResults: [], steps: [] };
const limited = JSON.stringify({
  responses: [
    { ...empty, responseId: "u1", sender: "human", message: "best payroll software for startups" },
    {
      ...empty, responseId: "a1", sender: "assistant", model: "grok-3",
      streamErrors: [{ message: "You've reached your usage limit. Please try again later.", usageLimitReached: { midTurn: false }, severity: "STREAM_ERROR_SEVERITY_NORMAL" }],
    },
  ],
});

console.log("\nthe limit in the REST copy");
{
  const r = await adapt({ captureId: "t1", raw: limited, reqBody: null, capturedAt: 1, pageUrl: "https://grok.com/c/x" });
  check("no answer text", !r.answerText, JSON.stringify(r.answerText));
  check("Grok's refusal is recorded as a usage limit", usageLimitOf(r) === "usage_limit_reached", JSON.stringify(r.platformSpecific.gatewayError));
  const k = answerKind(r);
  check("Analyze calls it no answer, not from memory", k.id === "noanswer" && k.limit === true, JSON.stringify(k));
}

console.log("\nan answer with an error after it keeps its answer");
{
  const raw = JSON.stringify({ responses: [
    { ...empty, responseId: "u1", sender: "human", message: "best vpn" },
    { ...empty, responseId: "a1", sender: "assistant", message: "Proton VPN and Mullvad are the strongest picks.", streamErrors: [{ message: "network hiccup" }] },
  ] });
  const r = await adapt({ captureId: "t2", raw, reqBody: null, capturedAt: 1, pageUrl: "https://grok.com/c/y" });
  check("not a limit", !usageLimitOf(r), JSON.stringify(r.platformSpecific.gatewayError));
  check("still an answer from memory (it didn't search)", answerKind(r).id === "memory", answerKind(r).id);
}

console.log("\nan empty answer without a limit");
{
  const k = answerKind({ answerChars: 0, answerText: "", sources: [], searched: false, platformSpecific: {} });
  check("is no answer, without the limit", k.id === "noanswer" && !k.limit, JSON.stringify(k));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
