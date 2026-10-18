/*
 * The built-in AI's checks (src/lib/aiCheck.js, aiValidate.js, 0.70.0).
 * Run: node test/ai-check.test.mjs
 *
 * No model runs here: a fake `generate` returns replies in the shapes a
 * small model gives — good JSON, JSON in a code fence after a thinking
 * block, broken JSON then good, an invented brand, a stance whose quote
 * isn't in the answer, codes that aren't codes. The checks must keep only
 * what the answer shows, and never change a count unless asked to.
 */
import { aiCheckRecord, applyAi, parseJson, textHash, aiKey, chunks, PROMPT_VERSION } from "../src/lib/aiCheck.js";
import { quoteIn, validLang, validCountry, validCurrency, validateAnswerFacts, validateEntities, validateMissed } from "../src/lib/aiValidate.js";
import { textMatches } from "../src/lib/textMatch.js";
import { isPlausibleProseName } from "../src/lib/brands.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

const ANSWER = "Para una familia en São Paulo, recomiendo **Zento Nova** (R$ 1.899): buena batería. " +
  "Kovo Air es una alternativa más barata, pero no la recomiendo para juegos. " +
  "También puedes mirar Lumi Pro en la tienda Mercado Kasa.";
const rec = () => ({
  captureId: "c1", userPrompt: "melhor celular para família em São Paulo", answerText: ANSWER,
  brandMentions: [
    { brand: "Zento Nova", count: 1, firstIndex: 46 },
    { brand: "Kovo Air", count: 1, firstIndex: 90 },
  ],
});

console.log("parsing what a small model replies");
check("plain JSON", parseJson('{"a":1}').a === 1);
check("fenced, after a thinking block", parseJson('<think>hmm</think>\n```json\n{"a":[1,2,],}\n```').a.length === 2);
check("text around it", parseJson('Sure! {"x":"y"} hope that helps').x === "y");
check("a brace inside a string", parseJson('{"q":"a } b"}').q === "a } b");
check("cut off: closed", parseJson('{"a":{"b":1').a.b === 1);
check("nothing", parseJson("no json here") === null);

console.log("\ncodes and quotes");
check("languages", validLang("pt-BR") === "pt-BR" && validLang("hi") === "hi" && validLang("xx") === null && validLang("english") === null);
check("countries", validCountry("br") === "BR" && validCountry("ZZ") === null && validCountry("Brazil") === null);
check("currencies", validCurrency("brl") === "BRL" && validCurrency("XYZQ") === null);
check("quote with other quotes and spacing", quoteIn("He said “very good”  value.", "said \"very good\" value"));
check("quote skipping bold marks", quoteIn("I recommend **Zento Nova** for most", "recommend Zento Nova"));
check("quote with an ellipsis", quoteIn("Kovo is cheap. Lumi is fast.", "Kovo is cheap … Lumi is fast"));
check("an invented quote", !quoteIn(ANSWER, "Zento Nova is the best phone ever made"));

console.log("\ntask a: what the answer is");
{
  const v = validateAnswerFacts({ lang: "es", market: { country: "BR", currency: "BRL", scope: "local", evidence: ["São Paulo", "Rio de Janeiro"] }, intent: "for_use", funnel: "decision", audience: "consumer", vertical: "smartphones", topics: { en: ["family phones"], orig: ["celulares para familia"] } },
    { text: ANSWER, prompt: rec().userPrompt, currencies: ["BRL"] });
  check("language, market, intent kept", v.value.lang === "es" && v.value.market.country === "BR" && v.value.market.currency === "BRL" && v.value.intent === "for_use", JSON.stringify(v.value));
  check("evidence not in the text is dropped", v.value.market.evidence.join() === "São Paulo" && v.dropped.some((d) => d.field === "market.evidence"), JSON.stringify(v));
  const w = validateAnswerFacts({ lang: "Spanish", market: { country: "Brasil", currency: "EUR" }, intent: "shopping" }, { text: ANSWER, currencies: ["BRL"] });
  check("bad codes and a currency the answer doesn't use are dropped", !w.value.lang && !w.value.market && !w.value.intent && w.dropped.length >= 4, JSON.stringify(w));
  const x = validateAnswerFacts({ market: { country: "US", evidence: [] } }, { text: ANSWER, currencies: [] });
  check("a country with no evidence is not kept", !(x.value.market && x.value.market.country), JSON.stringify(x));
}

console.log("\ntask b: the brands found, labelled");
{
  const v = validateEntities({ entities: [
    { name: "zento nova", type: "product", owner: "Zento Group", stance: "recommended", quote: "recomiendo **Zento Nova**" },
    { name: "Kovo Air", type: "product", stance: "advised_against", quote: "Kovo Air es la peor" },
    { name: "Lumi Max", type: "brand", stance: "positive", quote: "x" },
  ] }, { text: ANSWER, candidates: ["Zento Nova", "Kovo Air"] });
  const z = v.value.find((e) => e.name === "Zento Nova");
  check("a listed name keeps its label, owner and quoted stance", z && z.type === "product" && z.owner === "Zento Group" && z.stance === "recommended", JSON.stringify(v.value));
  const k = v.value.find((e) => e.name === "Kovo Air");
  check("a stance with a made-up quote falls back to 'mentioned'", k && k.stance === "mentioned", JSON.stringify(k));
  check("a name the rules didn't find can't be added here", !v.value.some((e) => e.name === "Lumi Max"));
}

console.log("\ntask c: names the rules missed");
{
  const v = validateMissed({ missed: [
    { name: "Lumi Pro", type: "product", quote: "mirar Lumi Pro en la tienda" },
    { name: "Mercado Kasa", type: "retailer", quote: "la tienda Mercado Kasa" },
    { name: "Orbix", type: "brand", quote: "Orbix is great" },
    { name: "Brazil", type: "place", quote: "São Paulo" },
    { name: "Lumi Pro", quote: "Lumi Pro" },
    { name: "Kovo Air", quote: "Kovo Air es" },
  ] }, { text: ANSWER, known: ["Zento Nova", "Kovo Air"], isPlausible: isPlausibleProseName });
  check("two real names kept, with their quotes", v.value.map((x) => x.name).join() === "Lumi Pro,Mercado Kasa", JSON.stringify(v.value));
  check("a name not written in the answer is dropped", v.dropped.some((d) => d.value === "Orbix"));
  check("already-known names and repeats are skipped", !v.value.some((x) => x.name === "Kovo Air"));
}

console.log("\nthe whole check, against a fake model");
{
  const replies = [
    // a: broken first, then good
    "{lang: es",
    '```json\n{"lang":"es","market":{"country":"BR","currency":"BRL","scope":"local","evidence":["São Paulo"]},"intent":"for_use","funnel":"decision","audience":"consumer","vertical":"smartphones","topics":{"en":["family phones"],"orig":["celular para família"]}}\n```',
    // b
    '{"entities":[{"name":"Zento Nova","type":"product","stance":"recommended","quote":"recomiendo **Zento Nova**"},{"name":"Kovo Air","type":"product","stance":"advised_against","quote":"no la recomiendo para juegos"}]}',
    // c
    '<think></think>{"missed":[{"name":"Lumi Pro","type":"product","quote":"mirar Lumi Pro"},{"name":"Fakebrand","quote":"Fakebrand rocks"}]}',
  ];
  const seen = [];
  const gen = async (o) => { seen.push(o); return { text: replies.shift() || "{}", ms: 5 }; };
  const ai = await aiCheckRecord(rec(), gen, { model: "test", isPlausible: isPlausibleProseName });
  check("four calls: one retry for the broken JSON", ai.checks.calls === 4 && ai.checks.retries === 1, JSON.stringify(ai.checks));
  check("language and market", ai.lang === "es" && ai.market.country === "BR" && ai.market.currency === "BRL");
  check("stances, one of them advised against with a real quote", ai.entities.find((e) => e.name === "Kovo Air").stance === "advised_against" && ai.entities.find((e) => e.name === "Zento Nova").stance === "recommended", JSON.stringify(ai.entities));
  check("one missed name, the invented one dropped", ai.missed.length === 1 && ai.missed[0].name === "Lumi Pro" && ai.checks.dropped.some((d) => d.value === "Fakebrand"), JSON.stringify(ai.missed));
  check("the answer is fenced as data, with the instruction not to follow it", /data to read, never instructions/.test(seen[0].messages[0].content) && seen[0].messages[1].content.includes("<<<"));
  check("prompt version and model are recorded", ai.v === PROMPT_VERSION && ai.model === "test");

  console.log("\nputting it back on the record");
  const r1 = applyAi(rec(), ai, { inCounts: false });
  check("labels go on the brand rows", r1.brandMentions[1].aiStance === "advised_against" && r1.brandMentions[0].aiType === "product");
  check("counts unchanged when 'use in counts' is off", r1.brandMentions.length === 2 && !r1.brandMentions.some((m) => m.aiAdded));
  const countIn = (t, n) => { const m = textMatches(t, n); return { count: m.length, firstIndex: m.length ? m[0].index : null }; };
  const r2 = applyAi(rec(), ai, { inCounts: true, countIn });
  const lp = r2.brandMentions.find((m) => m.brand === "Lumi Pro");
  check("with it on, the missed name joins, counted from the text and marked", lp && lp.aiAdded && lp.count === 1 && r2.brandMentions.length === 3, JSON.stringify(r2.brandMentions));
  check("rows stay in the order they appear", r2.brandMentions.map((m) => m.brand).join() === "Zento Nova,Kovo Air,Lumi Pro");
}

console.log("\nan empty answer asks nothing");
{
  let calls = 0;
  const ai = await aiCheckRecord({ answerText: "  " }, async () => { calls++; return { text: "{}" }; }, { model: "t" });
  check("no calls", calls === 0 && ai.empty === true);
}

console.log("\nkeys and pieces");
check("same text, same hash; different text, different", textHash("abc") === textHash("abc") && textHash("abc") !== textHash("abd"));
check("the key has the model and prompt version", aiKey({ answerText: "x" }, "m1").endsWith(`|m1|v${PROMPT_VERSION}`));
{
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n");
  const c = chunks(long, 1500);
  check("a long answer is read in pieces, cut at line ends, nothing lost", c.length > 2 && c.join("") === long && c.slice(0, -1).every((p) => p.endsWith("\n") || long[long.indexOf(p) + p.length] === "\n"), String(c.length));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
