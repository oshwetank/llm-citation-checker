/*
 * aiBench.js — "Test this computer", and which AI engine answers (0.74.0).
 *
 * The owner: one processor thread with the small model is "bad for output
 * quality and speed — find a better solution". So the engine isn't guessed
 * from hardware alone: each one available here checks the same made-up
 * answer, and the fastest that gets it right is used. Chrome's own built-in
 * AI is preferred until a test says otherwise, because it runs on the
 * graphics chip and costs no download of ours.
 */

// A made-up answer (Zento/Kovo/Lumora): three brands the rules found, one
// they missed, in English, priced in euros.
export const BENCH_RECORD = {
  captureId: "bench",
  userPrompt: "Which robot vacuum should I buy for a small flat in Berlin?",
  answerText: [
    "For a small flat, I'd recommend the **Zento Glide 3**: it is quiet, maps rooms well and costs about €299.",
    "The Kovo S2 is cheaper at €219 but its app is unreliable, so I would not recommend it if you want scheduling.",
    "Lumora Mini is a solid middle option. If you can stretch your budget, the Brisa Pro from Brisa Home is worth a look too.",
  ].join("\n\n"),
  brandMentions: [{ brand: "Zento Glide 3" }, { brand: "Kovo S2" }, { brand: "Lumora Mini" }],
};

/** Did the engine read the bench answer well enough to be trusted? */
export function benchVerdict(ai, ms) {
  const ents = (ai && ai.entities) || [];
  const missed = ((ai && ai.missed) || []).map((m) => m.name.toLowerCase());
  const found = {
    lang: !!(ai && ai.lang && /^en/i.test(ai.lang)),
    entities: ents.length,
    zentoRecommended: ents.some((e) => /zento/i.test(e.name) && /recommend|positive/.test(e.stance)),
    kovoAgainst: ents.some((e) => /kovo/i.test(e.name) && /against|negative/.test(e.stance)),
    brisa: missed.some((n) => n.includes("brisa")),
  };
  const score = [found.lang, found.entities >= 2, found.zentoRecommended, found.kovoAgainst, found.brisa].filter(Boolean).length;
  return { ok: score >= 3, score, of: 5, ms: Math.round(ms), calls: ai && ai.checks ? ai.checks.calls : null, found };
}

/**
 * The engine to use: "nano", "qwen" or null.
 * @param {{choice: "auto"|"nano"|"qwen", nano: string, qwen: boolean, bench: object|null}} o
 */
export function chooseEngine({ choice = "auto", nano = "unavailable", qwen = false, bench = null } = {}) {
  const nanoHere = nano === "available";
  if (choice === "nano") return nanoHere ? "nano" : null;
  if (choice === "qwen") return qwen ? "qwen" : null;
  const b = bench || {};
  // A test that ran and failed rules an engine out; one that didn't run doesn't.
  const nanoOk = nanoHere && !(b.nano && b.nano.ok === false && b.nano.score != null);
  const qwenOk = qwen && !(b.qwen && b.qwen.ok === false && b.qwen.score != null);
  if (nanoOk && qwenOk) {
    if (b.nano && b.nano.ok && b.qwen && b.qwen.ok) return b.qwen.ms < b.nano.ms ? "qwen" : "nano";
    return "nano";
  }
  if (nanoOk) return "nano";
  if (qwenOk) return "qwen";
  // Both failed their tests: still answer, with the better-scoring one.
  if (nanoHere && qwen) return ((b.qwen && b.qwen.score) || 0) > ((b.nano && b.nano.score) || 0) ? "qwen" : "nano";
  return nanoHere ? "nano" : qwen ? "qwen" : null;
}
