/*
 * ai-check-finishes.test.mjs — Chrome's built-in AI check finishes, and can
 * correct the brand list (1.0.0).
 *
 * The owner's log, 13 Nov 2026: "[ai-check] Chrome's built-in AI took too
 * long (replying)" on all four answers, so no answer was ever checked. A
 * small model held to a JSON shape with no limit on its lists can keep
 * adding items until the 90 s run out, and what it had written was thrown
 * away. Now the shape is bounded, the reply is read as it streams and stops
 * when the JSON closes, a reply cut off by time is still read, and a Chrome
 * that refuses the bounded shape is asked again without it.
 *
 * And the check can now say a rule-found name is not a name ("Sugar") and
 * which brand a product is sold under; with "Let the AI correct brands in
 * counts" on, those rows leave the counts or join their brand.
 */
import { parseJson, checkSchema, checkPrompt, applyAi } from "../src/lib/aiCheck.js";
import { validateEntities, ENTITY_TYPES } from "../src/lib/aiValidate.js";
import { nanoGenerate, nanoReset } from "../src/lib/nanoEngine.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\na reply cut off part way is still read");
{
  const cut = '{"lang":"en","entities":[{"name":"Britannia","type":"brand","stance":"recommended","quote":"Good everyday choice"},{"name":"Sugar","type":"not_a_name","stance":"mentioned","quote":"low in su';
  const j = parseJson(cut);
  check("the complete items are kept", j && Array.isArray(j.entities) && j.entities[0].name === "Britannia" && j.entities[0].quote === "Good everyday choice", JSON.stringify(j));
  check("and the cut item up to its last whole field, never a half-written one", j && j.entities.every((e) => e.quote !== "low in su"), JSON.stringify(j));
  check("a whole reply reads as before", parseJson('{"a":[1,2]}').a.length === 2);
  check("nothing usable is still nothing", parseJson("I cannot help") === null);
}

console.log("\nthe reply's shape has limits");
{
  const sc = checkSchema(true, 3);
  check("names: no more items than names asked about", sc.properties.entities.maxItems === 3);
  check("missed names: at most 8", sc.properties.missed.maxItems === 8);
  check("quotes have a length limit", sc.properties.entities.items.properties.quote.maxLength > 0);
  check("not_a_name is a type the model may give", ENTITY_TYPES.includes("not_a_name") && sc.properties.entities.items.properties.type.enum.includes("not_a_name"));
  const msgs = checkPrompt({ userPrompt: "best biscuit for chai" }, "text", ["Sugar"], ["Sugar"], true);
  check("the prompt says what isn't a name", /not names/i.test(msgs[0].content) && /not_a_name/.test(msgs[1].content));
}

console.log("\nChrome's model, read as it streams");
const fake = (behaviour) => {
  globalThis.LanguageModel = {
    availability: async () => "available",
    create: async () => {
      const mk = () => ({
        clone: async () => mk(),
        append: async () => {},
        prompt: async () => behaviour.prompt(),
        promptStreaming: (input, opts) => behaviour.stream(opts),
        destroy: () => {},
      });
      return mk();
    },
  };
  nanoReset();
};
const streamOf = (pieces, { gapMs = 5, forever = false } = {}) => (opts) => {
  let i = 0;
  return new ReadableStream({
    async pull(ctl) {
      if (opts && opts.signal && opts.signal.aborted) { ctl.close(); return; }
      await new Promise((r) => setTimeout(r, gapMs));
      if (i < pieces.length) ctl.enqueue(pieces[i++]);
      else if (forever) ctl.enqueue(", ");
      else ctl.close();
    },
  });
};
{
  let pulledAfter = 0;
  fake({ stream: (opts) => { const s = streamOf(['{"entities":[', '{"name":"Britannia"}', "]}", "   ", "   "], { forever: true })(opts); return s; } });
  const t0 = Date.now();
  const r = await nanoGenerate({ messages: [{ role: "user", content: "x" }], maxTokens: 400, schema: { type: "object" } });
  check("stops when the JSON closes, not when the model stops", parseJson(r.text) && parseJson(r.text).entities[0].name === "Britannia" && Date.now() - t0 < 2000, r.text);
  void pulledAfter;
}
{
  fake({ stream: streamOf(['{"entities":[{"name":"Cremica","type":"brand"},', '{"name":"Sunf'], { gapMs: 30, forever: true }) });
  const r = await nanoGenerate({ messages: [{ role: "user", content: "x" }], maxTokens: 400, timeoutMs: 600 });
  const j = parseJson(r.text);
  check("on time running out, what arrived is kept and read", j && j.entities && j.entities[0].name === "Cremica", r.text.slice(0, 80));
}
{
  let calls = 0;
  fake({ stream: (opts) => { calls++; if (opts && opts.responseConstraint) throw new Error("NotSupportedError: maxItems"); return streamOf(['{"ok":true}'])(opts); } });
  const r = await nanoGenerate({ messages: [{ role: "user", content: "x" }], maxTokens: 100, schema: { type: "object", maxItems: 1 } });
  check("a Chrome that refuses the shape is asked again without it", calls === 2 && /ok/.test(r.text), `${calls} ${r.text}`);
}
{
  fake({ prompt: async () => '{"plain":1}', stream: null });
  globalThis.LanguageModel.create = async () => ({ clone: async () => ({ prompt: async () => '{"plain":1}', destroy() {} }), destroy() {} });
  nanoReset();
  const r = await nanoGenerate({ messages: [{ role: "user", content: "x" }], maxTokens: 100 });
  check("a Chrome with no streaming still answers", /plain/.test(r.text), r.text);
}

console.log("\nthe AI corrects the brand list, when allowed");
const text = "For chai, **Britannia NutriChoice** is good. Look for low sugar.\n\n| Nutrient | Aim |\n|---|---|\n| Sugar | low |";
const rec = () => ({
  answerText: text,
  brandMentions: [
    { brand: "Britannia NutriChoice", count: 1, firstIndex: 10 },
    { brand: "Britannia", count: 2, firstIndex: 5 },
    { brand: "Sugar", count: 2, firstIndex: 60 },
  ],
});
const ents = validateEntities({ entities: [
  { name: "Britannia NutriChoice", type: "product", brand: "Britannia", stance: "recommended", quote: "**Britannia NutriChoice** is good" },
  { name: "Sugar", type: "not_a_name", stance: "mentioned", quote: "low sugar" },
  { name: "Britannia", type: "brand", brand: "Unilever Biscuits", stance: "mentioned", quote: "" },
] }, { text, candidates: ["Britannia NutriChoice", "Britannia", "Sugar"] });
check("the brand a product is sold under is kept when the answer writes it", ents.value.find((e) => e.name === "Britannia NutriChoice").brand === "Britannia");
check("a brand the answer never writes is left out", !ents.value.find((e) => e.name === "Britannia").brand && ents.dropped.some((d) => d.field === "entity.brand"));
const ai = { entities: ents.value, missed: [] };
{
  const r = applyAi(rec(), ai, { inCounts: false });
  check("without the setting: labels only, every row stays", r.brandMentions.length === 3 && r.brandMentions.find((m) => m.brand === "Sugar").aiType === "not_a_name");
}
{
  const r = applyAi(rec(), ai, { inCounts: true, countIn: () => null });
  const names = r.brandMentions.map((m) => m.brand);
  check("with it: Sugar leaves the counts", !names.includes("Sugar"), names.join(", "));
  const b = r.brandMentions.find((m) => m.brand === "Britannia");
  check("and the product joins its brand, counts added", names.length === 1 && b && b.count === 3 && (b.aiProducts || []).includes("Britannia NutriChoice"), JSON.stringify(r.brandMentions));
  check("what was taken out is kept on the record, with why", (r.aiRemoved || []).some((x) => x.brand === "Sugar" && x.why === "not_a_name") && r.aiRemoved.some((x) => x.why === "merged"), JSON.stringify(r.aiRemoved));
}
{
  const r = rec();
  r.brandMentions[2].relation = "own";
  const out = applyAi(r, ai, { inCounts: true, countIn: () => null });
  check("a brand you track is never taken out", out.brandMentions.some((m) => m.brand === "Sugar"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
