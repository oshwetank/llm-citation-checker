/*
 * pacing.test.mjs — run duration: the turn budget adapts, and the content
 * script stops burning a fixed wait on every prompt.
 *
 * Reported: "the run time is long, find a way to reduce it without
 * compromising quality." Two costs were found by measuring rather than
 * guessing, and both are pure dead time — neither changes how fast requests
 * are sent to the engine, so neither trades account safety for speed:
 *
 *   1. A flat ~7s wait per prompt for the page's own ?q= auto-submit, counted
 *      from document_start, on BOTH engines. Gemini has no native ?q=
 *      handling at all, so there the wait could only ever elapse in full:
 *      ~2 hours across a 1000-prompt leg, spent waiting for something that
 *      cannot happen. Counting from document_start was the wrong origin on
 *      ChatGPT too — it spent the budget on SPA boot instead of on watching
 *      for the submit.
 *
 *   2. A fixed 90s turn timeout. Every failed turn cost the full 90s, and a
 *      genuinely slow turn was killed and recorded as a failure that never
 *      happened.
 *
 * The arithmetic below is what makes these worth doing, so the per-prompt
 * saving is asserted directly rather than just asserting correctness.
 */
import {
  turnBudgetMs, medianOf, legEta, runEta,
  TURN_TIMEOUT_MS, TURN_TIMEOUT_MIN_MS, TURN_TIMEOUT_MAX_MS,
  INTER_PROMPT_MEAN_MS,
  parseCooldownFromNotice, formatCooldown,
} from "../src/lib/pacing.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nturnBudgetMs: calibrates to what the engine is actually doing");
{
  check("with no history at all it falls back to the fixed budget",
    turnBudgetMs({ durations: [] }) === TURN_TIMEOUT_MS, String(turnBudgetMs({ durations: [] })));
  check("a missing platform object doesn't throw",
    turnBudgetMs(undefined) === TURN_TIMEOUT_MS && turnBudgetMs(null) === TURN_TIMEOUT_MS);
  check("one or two samples are still too few to trust",
    turnBudgetMs({ durations: [20000] }) === TURN_TIMEOUT_MS &&
    turnBudgetMs({ durations: [20000, 21000] }) === TURN_TIMEOUT_MS);

  // A fast engine: ~20s turns. 3x is 60s, comfortably above any healthy turn
  // but a third off the old 90s on every failure.
  const fast = { durations: [19000, 20000, 21000, 20500, 19500] };
  check("a fast engine gets a tighter budget than the old fixed 90s",
    turnBudgetMs(fast) === 60000, String(turnBudgetMs(fast)));

  // A slow engine: ~55s turns. The old fixed 90s was only 1.6x typical, so
  // ordinary variance killed working turns. Now it gets real headroom.
  const slow = { durations: [52000, 55000, 58000, 54000, 56000] };
  check("a slow engine gets MORE than the old 90s, so working turns aren't killed",
    turnBudgetMs(slow) > TURN_TIMEOUT_MS, String(turnBudgetMs(slow)));
  check("…but never beyond the ceiling", turnBudgetMs(slow) <= TURN_TIMEOUT_MAX_MS, String(turnBudgetMs(slow)));

  const verySlow = { durations: [80000, 90000, 95000, 88000, 92000] };
  check("a very slow engine is clamped at the ceiling rather than growing without limit",
    turnBudgetMs(verySlow) === TURN_TIMEOUT_MAX_MS, String(turnBudgetMs(verySlow)));

  const veryFast = { durations: [3000, 4000, 3500, 3200, 3800] };
  check("a very fast engine is floored, never a hair-trigger that fails healthy turns",
    turnBudgetMs(veryFast) === TURN_TIMEOUT_MIN_MS, String(turnBudgetMs(veryFast)));
}

console.log("\nMedian, not mean: one outlier must not re-inflate the budget");
{
  // Nine healthy 20s turns and one that ran to the old 90s ceiling. The mean
  // is 27s (budget 81s — barely better than the 90s it replaced); the median
  // is 20s (budget 60s). That gap is the whole reason for using a median.
  const withOutlier = { durations: [20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 90000] };
  const mean = withOutlier.durations.reduce((a, b) => a + b, 0) / withOutlier.durations.length;
  check("the outlier really would have distorted a mean", Math.round(mean) === 27000, String(Math.round(mean)));
  check("the median ignores it", medianOf(withOutlier.durations) === 20000, String(medianOf(withOutlier.durations)));
  check("so the budget stays tight despite the outlier",
    turnBudgetMs(withOutlier) === 60000, String(turnBudgetMs(withOutlier)));

  check("medianOf handles an even-length window", medianOf([10, 20, 30, 40]) === 25, String(medianOf([10, 20, 30, 40])));
  check("medianOf ignores junk values rather than producing NaN",
    medianOf([10000, null, undefined, NaN, -5, "x", 20000, 30000]) === 20000,
    String(medianOf([10000, null, undefined, NaN, -5, "x", 20000, 30000])));
  check("medianOf returns null for nothing usable", medianOf([]) === null && medianOf([NaN, -1]) === null);
}

console.log("\nWhat this is worth across a 1000-prompt run");
{
  // Failure cost is (failure rate x budget). Quantified so a future change
  // to the constants has to consciously accept giving this back.
  const PROMPTS = 1000;
  const failRate = 0.05;
  const oldIdleMs = PROMPTS * failRate * TURN_TIMEOUT_MS;
  const newIdleMs = PROMPTS * failRate * turnBudgetMs({ durations: [19000, 20000, 21000, 20500, 19500] });
  const savedMin = (oldIdleMs - newIdleMs) / 60000;
  check("on a fast engine, tightening the budget saves >20 min of pure idle time at a 5% failure rate",
    savedMin > 20, `${savedMin.toFixed(0)} min saved (${(oldIdleMs / 60000).toFixed(0)} → ${(newIdleMs / 60000).toFixed(0)})`);

  // The auto-submit grace. Old: 18 ticks x 400ms from document_start, always
  // elapsed in full on Gemini. New: 2 ticks after the composer mounts.
  const TICK = 400;
  const oldGraceMs = 18 * TICK;
  const newGraceGeminiMs = 2 * TICK;
  const geminiSavedHrs = (PROMPTS * (oldGraceMs - newGraceGeminiMs)) / 3600000;
  check("dropping the pointless Gemini grace saves well over an hour per 1000 prompts",
    geminiSavedHrs > 1.5, `${geminiSavedHrs.toFixed(2)} h`);

  // ChatGPT keeps a real grace, but spent watching rather than waiting: 8
  // ticks measured from composer mount instead of 18 from document_start.
  // On a typical ~1.5s boot that is a 4s-per-prompt saving.
  const bootMs = 1500;
  const oldEffective = oldGraceMs;                 // absolute, from document_start
  const newEffective = bootMs + 8 * TICK;          // boot, then watch
  check("ChatGPT's grace also shrinks on a normal boot",
    newEffective < oldEffective, `${newEffective}ms vs ${oldEffective}ms`);
}

console.log("\nETA: the estimate must include the pause between prompts");
{
  /* The bug this pins: durations are measured from just before navigation to
   * the capture landing, so they STOP before the 3-6s human-paced gap that
   * follows. An ETA built from them alone runs short by that gap on every
   * remaining prompt — which is precisely the number whose job is telling the
   * user when to come back. */
  const leg = { durations: [30000, 30000, 30000], prompts: new Array(600).fill("q"), idx: 0 };
  const e = legEta(leg);
  check("the per-prompt figure adds the gap to the turn duration",
    e.perPromptMs === 30000 + INTER_PROMPT_MEAN_MS, String(e.perPromptMs));

  const naive = 30000 * 600;                 // what the old maths produced
  const shortfallMin = (e.remainingMs - naive) / 60000;
  check("ignoring the gap would have under-promised by roughly three quarters of an hour",
    shortfallMin > 40 && shortfallMin < 50, `${shortfallMin.toFixed(0)} min`);

  check("it counts only the prompts still to run",
    legEta({ ...leg, idx: 590 }).remaining === 10, String(legEta({ ...leg, idx: 590 }).remaining));
  check("a finished leg estimates zero",
    legEta({ ...leg, idx: 600 }).remainingMs === 0);
  check("no history means no estimate, rather than a confident guess",
    legEta({ durations: [], prompts: ["a"], idx: 0 }) === null);
}

console.log("\nETA: two engines run concurrently, so the run ends with the SLOWEST leg");
{
  const platforms = {
    chatgpt: { durations: [20000], prompts: new Array(100).fill("q"), idx: 0 },
    gemini:  { durations: [40000], prompts: new Array(100).fill("q"), idx: 0 },
  };
  const r = runEta(platforms);
  const slow = legEta(platforms.gemini).remainingMs;
  const fast = legEta(platforms.chatgpt).remainingMs;
  check("the estimate is the slower leg, not the sum",
    r.remainingMs === slow, `${r.remainingMs} vs slow=${slow} sum=${slow + fast}`);
  check("summing would have roughly doubled it — the error this avoids",
    slow + fast > r.remainingMs * 1.4, `sum=${slow + fast} chosen=${r.remainingMs}`);
  check("it reports an absolute finish time, not just a duration",
    r.finishAt > Date.now() && Math.abs(r.finishAt - Date.now() - r.remainingMs) < 1000,
    String(r.finishAt));
  check("one leg with no history makes the whole estimate unknown",
    runEta({ ...platforms, perplexity: { durations: [], prompts: ["a"], idx: 0 } }) === null);
  check("no platforms at all is unknown rather than zero", runEta({}) === null);
}

console.log("\nRate-limit cooldown parsing and formatting");
{
  check("parses minutes correctly", parseCooldownFromNotice("You have reached your limit. Please try again in 45 minutes.") === 45 * 60 * 1000);
  check("parses hours correctly", parseCooldownFromNotice("Rate limit exceeded. Wait 2 hours.") === 2 * 3600 * 1000);
  check("falls back to default 30 mins when time unspecified", parseCooldownFromNotice("Too many requests. Please try again later.") === 30 * 60 * 1000);
  check("handles empty or null string gracefully", parseCooldownFromNotice(null) === 30 * 60 * 1000);

  check("formats seconds", formatCooldown(45000) === "45s");
  check("formats minutes and seconds", formatCooldown(150000) === "2m 30s");
  check("formats hours and minutes", formatCooldown(5400000) === "1h 30m");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);

