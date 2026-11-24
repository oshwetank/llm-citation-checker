/*
 * aimode-pacing.test.mjs — Google AI Mode's pace (1.0.5): one tab, a minute
 * or two between questions, at most 30 an hour; the other engines keep
 * their few seconds.
 * Run: node test/aimode-pacing.test.mjs
 */
import { nextGapMs, tabsForEngine, CAREFUL_HOURLY_CAP, INTER_PROMPT_MIN_MS, INTER_PROMPT_MAX_MS } from "../src/lib/pacing.js";
const C = { careful: true };

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const NOW = 10_000_000_000;
const MIN = 60_000;

console.log("\nThe default pace (the owner's choice): AI Mode like the others");
check("AI Mode in two tabs, a few seconds apart, no hourly cap", tabsForEngine("aimode") === 2 && nextGapMs("aimode", [], NOW, 0) === INTER_PROMPT_MIN_MS && nextGapMs("aimode", Array(60).fill(NOW - 1000), NOW, 0) === INTER_PROMPT_MIN_MS);
check("ChatGPT in two tabs too", tabsForEngine("chatgpt") === 2);
console.log("\nCareful pace (Settings)");
check("AI Mode and ChatGPT in one tab", tabsForEngine("aimode", C) === 1 && tabsForEngine("chatgpt", C) === 1 && tabsForEngine("gemini", C) === 2);
check("a minute to two between AI Mode questions", nextGapMs("aimode", [], NOW, 0, C) === MIN && nextGapMs("aimode", [], NOW, 1, C) === 2 * MIN);
check("the chat engines keep their few seconds", nextGapMs("gemini", [], NOW, 0) === INTER_PROMPT_MIN_MS && nextGapMs("chatgpt", [], NOW, 1) === INTER_PROMPT_MAX_MS);
const sent = Array.from({ length: CAREFUL_HOURLY_CAP.aimode }, (_, i) => NOW - 50 * MIN + i * 1000);
const wait = nextGapMs("aimode", sent, NOW, 0, C);
check("at 30 in the hour, it waits until the oldest is an hour old", wait === 10 * MIN, `${Math.round(wait / MIN)} min`);
check("sends older than an hour don't count", nextGapMs("aimode", sent.map((t) => t - 2 * 60 * MIN), NOW, 0, C) === MIN);
check("the cap is only for AI Mode", nextGapMs("gemini", sent, NOW, 0, C) === INTER_PROMPT_MIN_MS);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
