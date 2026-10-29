/*
 * laya.test.mjs — Laya's sequences and answers (0.83.0).
 *
 * buildSequence against the model's own Python reference (rl_common.py,
 * run by test/tools/laya-fixtures.py into test/fixtures/laya-ref.json, with
 * every string's token ids recorded so both sides see the same tokens);
 * answerOf against rl_agent_api.system_one; the labels CitoSkeleton keeps.
 */
import { readFileSync } from "node:fs";
import { buildSequence, renderOptions, serializeState, answerOf, confidenceOf, layaQuestions, layaCheckRecord, MIN_P } from "../src/lib/laya.js";
import { applyAi } from "../src/lib/aiCheck.js";
import { INTENTS, STANCES } from "../src/lib/aiValidate.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const REF = JSON.parse(readFileSync(new URL("./fixtures/laya-ref.json", import.meta.url), "utf8"));
const refTok = {
  ...REF.special,
  maskToken: "[MASK]",
  encode: (s) => { if (!(s in REF.encodings)) throw new Error(`not in the reference: ${JSON.stringify(s)}`); return REF.encodings[s]; },
};

console.log("\nthe same sequences as the Python reference");
for (const c of REF.cases) {
  const opts = renderOptions(c.q);
  const got = buildSequence(refTok, c.state, c.q, { maxLen: c.maxLen, headMaxLen: c.headMaxLen, optionOrder: c.optionOrder, truncateLeft: c.truncateLeft });
  check(c.label, JSON.stringify(opts) === JSON.stringify(c.options) && JSON.stringify(got.ids) === JSON.stringify(c.ids) && JSON.stringify(got.markers) === JSON.stringify(c.markers),
    `ids ${got.ids.length} vs ${c.ids.length}, markers ${got.markers} vs ${c.markers}`);
}
check("states serialised as Python's json.dumps", serializeState({ a: "x", b: ["y", "Größe"], c: null }) === "{\"a\": \"x\", \"b\": [\"y\", \"Größe\"], \"c\": null}");

console.log("\nreading an answer off the logits, as system_one does");
const q = { t: "choice", crit: { a: null, b: null, c: null } };
const a = answerOf([2, 0, 0], q);
const e = [Math.exp(2), 1, 1], s = e[0] + e[1] + e[2];
check("softmax over the options", Math.abs(a.p - e[0] / s) < 1e-9 && a.choice === "a");
const ent = -[e[0] / s, 1 / s, 1 / s].reduce((n, p) => n + p * Math.log(p), 0);
check("confidence = 1 − entropy / log k", Math.abs(a.confidence - (1 - ent / Math.log(3))) < 1e-9);
check("flat is not confident", confidenceOf([0.25, 0.25, 0.25, 0.25]) < 1e-9);
check("a temperature softens it", answerOf([2, 0, 0], q, 2).p < a.p);
check("yes/no reads p[true]", Math.abs(answerOf([0, 0], { t: "noul" }).noul - 0.5) < 1e-9);
check("a score is the expected level", Math.abs(answerOf([0, 0, 0], { t: "score", crit: ["x", "y", "z"] }).score - 1) < 1e-9);

console.log("\nwhat CitoSkeleton asks");
const rec = {
  captureId: "c1", userPrompt: "best lamp for reading", answerText: "Zento is the top pick. Kovo is good too. Avoid Lumora.", answerLang: "en",
  brandMentions: [
    { brand: "Kovo", count: 1, firstIndex: 24, passages: ["Kovo is good too."] },
    { brand: "Zento", count: 1, firstIndex: 0, passages: ["Zento is the top pick."] },
  ],
};
const qs = layaQuestions(rec);
check("four about the answer, two per brand", qs.length === 4 + 2 * 2 && qs.slice(0, 4).map((x) => x.id).join() === "intent,funnel,audience,scope");
check("over CitoSkeleton's own labels", Object.keys(qs[0].crit).join() === INTENTS.join() && Object.keys(qs.find((x) => x.id === "stance:Zento").crit).join() === STANCES.join());
check("brands in the order they appear", qs[4].brand === "Zento");
check("each option explained in a line", Object.values(qs[0].crit).every(Boolean));

console.log("\nlabels kept only when sure");
// A stand-in run: the first option wins for most questions, flat for scope,
// a near tie for Kovo's stance.
const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+/gu) || [];
const vocab = new Map();
const tok = { cls: 2, sep: 1, mask: 4, maskToken: "[MASK]", encode: (s) => words(s).map((w) => { if (!vocab.has(w)) vocab.set(w, 10 + vocab.size); return vocab.get(w); }) };
let seen = null;
const run = async (items) => {
  seen = items;
  return {
    ms: 42,
    logits: items.map((it, i) => {
      const id = qs[i].id;
      if (id === "scope") return it.markers.map(() => 0);
      if (id === "stance:Kovo") return it.markers.map((_, k) => (k === 1 ? 1.0 : k === 2 ? 0.9 : 0));
      if (id === "intent") return it.markers.map((_, k) => (INTENTS[k] === "best_top" ? 8 : 0));
      return it.markers.map((_, k) => (k === 0 ? 8 : 0));
    }),
  };
};
const ai = await layaCheckRecord(rec, run, { tok, model: "Laya multilingual" });
check("one batch for the whole answer", ai.checks.calls === 1 && seen.length === qs.length && ai.checks.ms === 42);
check("each sequence starts [CLS] and ends [SEP], one marker per option", seen.every((it) => it.ids[0] === 2 && it.ids.at(-1) === 1) && seen[0].markers.length === INTENTS.length);
check("question type sent", seen.every((it) => it.qtype === 0));
check("sure labels kept", ai.source === "laya" && ai.intent === "best_top" && ai.funnel === "awareness" && ai.audience === "consumer");
check("with how sure", ai.labels.intent.p > MIN_P && ai.labels.intent.confidence > 0.3);
check("a flat answer is left out, and listed as unsure", !ai.market || !ai.market.scope);
check("…as unsure", ai.checks.unsure.some((u) => u.what === "scope") && ai.checks.unsure.some((u) => u.what === "stance:Kovo"));
const z = ai.entities.find((x) => x.name === "Zento");
check("a brand's type and stance", z && z.type === "brand" && z.stance === "recommended");
check("the quote is the rules' own passage, verbatim from the answer", z.quote === "Zento is the top pick." && rec.answerText.includes(z.quote));
const k = ai.entities.find((x) => x.name === "Kovo");
check("an unsure stance stays unlabelled", k && k.type === "brand" && !k.stance);
check("language from the record", ai.lang === "en");
check("no names invented", ai.missed.length === 0);

console.log("\nit plugs into what the board already reads");
const copy = JSON.parse(JSON.stringify(rec));
applyAi(copy, ai);
check("brand rows get the labels", copy.brandMentions.find((m) => m.brand === "Zento").aiStance === "recommended" && copy.brandMentions.find((m) => m.brand === "Zento").aiType === "brand");
check("counts unchanged", copy.brandMentions.length === 2);
check("an empty answer asks nothing", (await layaCheckRecord({ ...rec, answerText: "" }, run, { tok })).empty === true);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
