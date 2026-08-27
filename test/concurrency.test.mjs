/*
 * concurrency.test.mjs — the arithmetic behind running more than one tab per
 * engine: how the prompt list is split, and how a restarted worker figures
 * out which of a shard's prompts actually completed.
 *
 * Requested (after the earlier ChatGPT/run-accounting fixes): a way to cut
 * the ~11h/1000-prompt wall time. The user chose 2 tabs per engine, offset
 * starts, over a bigger number (faster but more conspicuous automated
 * activity on one account) or a configurable-default-off setting.
 *
 * This file is deliberately narrow: it tests the two PURE functions the
 * concurrency feature is built on, in isolation from chrome.tabs, the
 * service worker, and real network. That is the only part of this feature a
 * test in this sandbox can exercise directly — creating real Chrome tabs and
 * driving actual ChatGPT/Gemini pages requires the live browser test in
 * prompt-submit/full-audit, which covers the wiring instead of the math.
 *
 * Both functions matter more than their size suggests. shardPrompts()
 * getting the split wrong either starves a tab (an empty shard silently
 * opens a useless tab) or drops prompts (an off-by-one in the boundary
 * between shards loses or duplicates one). countCompletedForLeg() getting
 * it wrong reintroduces exactly the "14/12 captured" bug this session
 * already fixed once — a restart reconciling one tab's progress against a
 * count that includes ANOTHER tab's completions.
 */
import { shardPrompts, CONCURRENT_TABS_PER_ENGINE, LEG_START_STAGGER_MS } from "../src/lib/pacing.js";
import { countCompletedForLeg, hasSignal } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nshardPrompts: the decided default is 2 tabs per engine");
{
  check("the shipped concurrency level is 2, matching what was decided",
    CONCURRENT_TABS_PER_ENGINE === 2, String(CONCURRENT_TABS_PER_ENGINE));
  check("tabs start staggered, not simultaneously", LEG_START_STAGGER_MS > 0, String(LEG_START_STAGGER_MS));
}

console.log("\nshardPrompts: splits without losing or duplicating a single prompt");
{
  const prompts = Array.from({ length: 1000 }, (_, i) => `prompt ${i}`);
  const legs = shardPrompts(prompts, 2);
  check("exactly 2 shards for 2 tabs", legs.length === 2, String(legs.length));
  const rebuilt = legs.flatMap((l) => l.prompts);
  check("concatenating the shards back together reproduces the original list exactly",
    JSON.stringify(rebuilt) === JSON.stringify(prompts), `lengths: ${rebuilt.length} vs ${prompts.length}`);
  check("no prompt appears in more than one shard",
    new Set(rebuilt).size === prompts.length, `${new Set(rebuilt).size} distinct of ${prompts.length}`);
  check("an even split is exactly even", legs[0].prompts.length === 500 && legs[1].prompts.length === 500,
    `${legs[0].prompts.length} / ${legs[1].prompts.length}`);
}

console.log("\nshardPrompts: an uneven count front-loads the remainder, never starves a shard");
{
  const legs7 = shardPrompts(["a", "b", "c", "d", "e", "f", "g"], 2);
  check("7 prompts over 2 tabs is 4 and 3, not 3 and 4 or an uneven surprise",
    legs7[0].prompts.length === 4 && legs7[1].prompts.length === 3,
    `${legs7[0].prompts.length} / ${legs7[1].prompts.length}`);
  check("shard 0 gets prompts a-d in order", JSON.stringify(legs7[0].prompts) === JSON.stringify(["a", "b", "c", "d"]));
  check("shard 1 gets e-g in order", JSON.stringify(legs7[1].prompts) === JSON.stringify(["e", "f", "g"]));

  // Fewer prompts than tabs: one shard is legitimately empty. The empty one
  // must still carry a correct startOffset (equal to the list length) rather
  // than an undefined/garbage value, since a caller that forgets to filter
  // empty shards would otherwise mis-place it.
  const legs1 = shardPrompts(["only"], 2);
  check("1 prompt over 2 tabs gives one real shard and one legitimately empty shard",
    legs1[0].prompts.length === 1 && legs1[1].prompts.length === 0,
    `${legs1[0].prompts.length} / ${legs1[1].prompts.length}`);
  check("the empty shard's startOffset is still correct", legs1[1].startOffset === 1, String(legs1[1].startOffset));

  check("zero prompts produces only empty shards, never throws", shardPrompts([], 2).every((l) => l.prompts.length === 0));
}

console.log("\nshardPrompts: startOffset is what maps a leg-local index back to the ORIGINAL list");
{
  // This is the number that lines a capture up with the right tracked
  // prompt's provenance in a GEO campaign (background.js's raw-conversation
  // handler: originalIdx = leg.startOffset + leg.idx). Getting this wrong
  // doesn't fail loudly — it silently attributes a response to the wrong
  // tracked prompt, corrupting that prompt's mention-rate math.
  const prompts = Array.from({ length: 11 }, (_, i) => `p${i}`);
  const legs = shardPrompts(prompts, 3);
  check("shard offsets are contiguous and non-overlapping",
    legs[0].startOffset === 0 && legs[1].startOffset === legs[0].prompts.length &&
    legs[2].startOffset === legs[0].prompts.length + legs[1].prompts.length,
    legs.map((l) => l.startOffset).join(","));
  // For every shard, prompts[startOffset + i] must equal that shard's own
  // prompts[i] — the exact lookup background.js performs.
  for (const leg of legs) {
    leg.prompts.forEach((text, i) => {
      check(`prompts[startOffset(${leg.startOffset}) + ${i}] resolves to this shard's own prompt`,
        prompts[leg.startOffset + i] === text, `got "${prompts[leg.startOffset + i]}", want "${text}"`);
    });
  }
}

console.log("\nshardPrompts: concurrency of 1 degrades to today's single-tab behaviour");
{
  const legs = shardPrompts(["a", "b", "c"], 1);
  check("one shard holding everything", legs.length === 1 && legs[0].prompts.length === 3);
}

console.log("\ncountCompletedForLeg: reconciles ONE tab's own shard, not the whole platform");
{
  // The scenario this exists for: two tabs on chatgpt, one runId. Tab A's
  // shard is prompts 1-4, tab B's is prompts 5-7. Both have captures stored.
  // Reconciling tab A against a platform-wide count would include tab B's
  // completions and push tab A's idx past prompts it never actually asked.
  const RUN = "run-1";
  const legA = ["q1", "q2", "q3", "q4"];
  const legB = ["q5", "q6", "q7"];
  const records = [
    ...legA.slice(0, 3).map((q, i) => ({ runId: RUN, platform: "chatgpt", userPrompt: q, answerChars: 500 })),
    ...legB.map((q, i) => ({ runId: RUN, platform: "chatgpt", userPrompt: q, answerChars: 500 })),
  ];
  check("tab A's shard reconciles to 3 (its own 3 captured), not 6 (both shards' total)",
    countCompletedForLeg(records, RUN, "chatgpt", legA) === 3,
    String(countCompletedForLeg(records, RUN, "chatgpt", legA)));
  check("tab B's shard reconciles to its own 3", countCompletedForLeg(records, RUN, "chatgpt", legB) === 3,
    String(countCompletedForLeg(records, RUN, "chatgpt", legB)));

  // The exact regression this whole feature must not reintroduce: a
  // platform-wide count applied to one shard would read as "6 of 4 done",
  // impossible, and (worse) would advance that shard's idx past its own
  // prompt list length.
  const wholePlatform = records.filter((r) => r.platform === "chatgpt" && hasSignal(r)).length;
  check("sanity: the whole-platform total really is 6, so using it for shard A would overcount",
    wholePlatform === 6, String(wholePlatform));
}

console.log("\ncountCompletedForLeg: only counts captures that belong to THIS run, platform, and shard");
{
  const legPrompts = ["only mine"];
  const records = [
    { runId: "run-1", platform: "chatgpt", userPrompt: "only mine", answerChars: 400 },
    { runId: "run-2", platform: "chatgpt", userPrompt: "only mine", answerChars: 400 }, // different run
    { runId: "run-1", platform: "gemini", userPrompt: "only mine", answerChars: 400 },  // different engine
    { runId: "run-1", platform: "chatgpt", userPrompt: "not in this shard", answerChars: 400 },
  ];
  check("a different runId is excluded", countCompletedForLeg(records, "run-1", "chatgpt", legPrompts) === 1,
    String(countCompletedForLeg(records, "run-1", "chatgpt", legPrompts)));
  check("a different platform is excluded — same assertion holds engine-scoped",
    countCompletedForLeg(records, "run-1", "gemini", legPrompts) === 1,
    String(countCompletedForLeg(records, "run-1", "gemini", legPrompts)));
  check("a prompt not in this shard never counts toward it, even same run+platform",
    countCompletedForLeg(records, "run-1", "chatgpt", ["only mine"]) === 1);
}

console.log("\ncountCompletedForLeg: signal-less race-loser captures don't count, same as the platform-wide version");
{
  // hasSignal() (lib/geo.js) treats a non-empty userPrompt as signal on its
  // own — it means a real request went out, independent of whether the
  // response carried anything back yet. A genuine race-loser capture has
  // NEITHER: an empty prompt (the losing side of a concurrent-request race
  // that resolved before the real one) and nothing else either.
  const legPrompts = [""];
  const records = [{ runId: "run-1", platform: "chatgpt", userPrompt: "" }];
  check("a capture with no prompt and no other content is not counted as completed",
    countCompletedForLeg(records, "run-1", "chatgpt", legPrompts) === 0,
    String(countCompletedForLeg(records, "run-1", "chatgpt", legPrompts)));

  // Confirms the OTHER half of hasSignal's contract, since a leg's own
  // reconciliation must honour it exactly the same way the platform-wide
  // version does: a userPrompt alone — with no answer content at all yet —
  // is real signal, not a race-loser, and should count.
  const legPrompts2 = ["asked but no answer fields yet"];
  const records2 = [{ runId: "run-1", platform: "chatgpt", userPrompt: "asked but no answer fields yet" }];
  check("a userPrompt alone (no answerChars/sources) still counts as real signal, per hasSignal",
    countCompletedForLeg(records2, "run-1", "chatgpt", legPrompts2) === 1,
    String(countCompletedForLeg(records2, "run-1", "chatgpt", legPrompts2)));
}

console.log("\ncountCompletedForLeg: edge cases that must degrade safely, never throw or over-count");
{
  check("no runId counts nothing", countCompletedForLeg([{ runId: "x", platform: "chatgpt", userPrompt: "a", answerChars: 1 }], null, "chatgpt", ["a"]) === 0);
  check("an empty shard counts nothing (nothing to reconcile against)",
    countCompletedForLeg([{ runId: "r", platform: "chatgpt", userPrompt: "a", answerChars: 1 }], "r", "chatgpt", []) === 0);
  check("no records at all counts nothing, doesn't throw", countCompletedForLeg([], "r", "chatgpt", ["a"]) === 0);
  check("undefined records doesn't throw", countCompletedForLeg(undefined, "r", "chatgpt", ["a"]) === 0);

  // A duplicate prompt text appearing twice in one shard is deduped, not
  // double-counted — matches the documented behaviour: a shard's own list is
  // what the tab was ASKED, and asking twice should count once here (the
  // live per-turn advance logic paces actual repeats, not this recovery path).
  const dup = [
    { runId: "r", platform: "chatgpt", userPrompt: "same prompt", answerChars: 1 },
    { runId: "r", platform: "chatgpt", userPrompt: "same prompt", answerChars: 1 },
  ];
  check("a duplicate prompt text in one shard counts once, not twice",
    countCompletedForLeg(dup, "r", "chatgpt", ["same prompt", "same prompt"]) === 1,
    String(countCompletedForLeg(dup, "r", "chatgpt", ["same prompt", "same prompt"])));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
