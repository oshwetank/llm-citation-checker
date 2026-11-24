/*
 * passages.test.mjs — searching inside answers (1.0.5, Stage 3 of
 * ASK-ARCHITECTURE.md): passages, ranking, typos, other scripts, the
 * meaning ranking and its fusion with keywords. A stand-in embedder plays
 * the model.
 * Run: node test/passages.test.mjs
 */
import { splitPassages, terms, buildIndex, keywordHits, search, byAnswer, queryTerms } from "../src/lib/passages.js";
import { rankByMeaning, meanPool, textHash, dot } from "../src/lib/meaning.js";
import { searchAnswers } from "../src/lib/answerSearch.js";
import { askPlanned } from "../src/lib/assistant.js";
import { data } from "./fixtures/ask-data.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};

const recs = [
  { captureId: "a", platform: "chatgpt", capturedAt: 1, userPrompt: "best phone", answerText: "## Top picks\n\n- **Zento Pulse**: the best battery life, two days on one charge.\n- **Kovo X**: great camera.\n\n| Phone | Warranty |\n|---|---|\n| Zento Pulse | 2 years |\n\nBoth are good value." },
  { captureId: "b", platform: "gemini", capturedAt: 2, userPrompt: "phone for travel", answerText: "For travel, the Kovo X lasts a long time between charges and its batteries are replaceable." },
  { captureId: "c", platform: "perplexity", capturedAt: 3, userPrompt: "फ़ोन", answerText: "ज़ेंटो पल्स की बैटरी सबसे अच्छी है। यह दो दिन चलती है।" },
  { captureId: "d", platform: "chatgpt", capturedAt: 4, userPrompt: "x", answerText: "Nothing relevant here at all." },
];

console.log("\nPassages and words");
{
  const ps = splitPassages(recs[0].answerText);
  check("list items, table rows and paragraphs are separate passages", ps.some((p) => /^Zento Pulse: the best battery/.test(p)) && ps.some((p) => /Zento Pulse 2 years/.test(p)) && ps.includes("Both are good value."), JSON.stringify(ps));
  check("table rules and headings' marks are dropped", !ps.some((p) => /^[-|: ]+$/.test(p) || p.startsWith("#")), JSON.stringify(ps));
  check("plurals and -ing stem to one word", terms("batteries charging")[0] === "battery" && terms("batteries charging")[1] === "charg", JSON.stringify(terms("batteries charging")));
  check("Hindi is cut into words", terms("बैटरी सबसे अच्छी").length === 3, JSON.stringify(terms("बैटरी सबसे अच्छी")));
}

console.log("\nKeyword search: every word, ranked, typos tolerated");
{
  const idx = buildIndex(recs);
  const k = keywordHits(idx, "battery");
  check("\"battery\" finds \"battery\" and \"batteries\"", new Set(k.hits.map((h) => h.doc.captureId)).size === 2, JSON.stringify(k.hits.map((h) => h.doc.captureId)));
  check("every word must be in the passage", keywordHits(idx, "battery warranty").hits.length === 0);
  const t = keywordHits(idx, "batery");
  check("a typo is read as the nearest real word, and said", t.hits.length > 0 && t.fixed[0] && t.fixed[0].to === "battery", JSON.stringify(t.fixed));
  check("a word that's nowhere and like nothing: no hits", keywordHits(idx, "zzqx").hits.length === 0);
  check("in Hindi too", keywordHits(idx, "बैटरी").hits.some((h) => h.doc.captureId === "c"));
  check("query words are the same terms", queryTerms(idx, "Batteries").some((q) => q.term === "battery"));
  const hits = searchAnswers(recs, "batery life");
  check("the Dashboard search finds it despite the typo, with the passage as snippet", hits.length === 1 && hits[0].captureId === "a" && /battery life/.test(hits[0].snippet), JSON.stringify(hits));
}

console.log("\nMeaning: a stand-in embedder (words that mean the same share a vector)");
{
  // Each "concept" is a dimension; a text's vector is the concepts it mentions.
  const CONCEPTS = [/battery|charge|lasts|बैटरी/i, /camera|photo/i, /warranty|guarantee/i, /travel|trip/i];
  const vec = (t) => { const v = new Float32Array(CONCEPTS.length + 1); CONCEPTS.forEach((re, i) => { if (re.test(t)) v[i] = 1; }); v[CONCEPTS.length] = 0.1; let n = Math.hypot(...v); return v.map((x) => x / n); };
  const store = new Map();
  let embedded = 0;
  const io = { embed: async (texts) => { embedded += texts.length; return texts.map(vec); }, get: async (id) => store.get(id) || null, put: async (id, r) => { store.set(id, r); }, min: 0.5 };
  const idx = buildIndex(recs);
  const docs = idx.docs.map((d) => ({ id: d.id, text: d.text }));
  const r1 = await rankByMeaning(docs, "long-lasting charge", io);
  check("\"long-lasting charge\" finds the battery passages, in any language", r1.ids.length >= 2 && r1.ids.some((id) => id.startsWith("c#")) && r1.ids.some((id) => id.startsWith("a#")), JSON.stringify(r1.ids));
  check("and not the unrelated ones", !r1.ids.some((id) => id.startsWith("d#")));
  const before = embedded;
  await rankByMeaning(docs, "battery", io);
  check("each passage is embedded once (only the question the second time)", embedded - before === 1, String(embedded - before));
  store.set(docs[0].id, { h: "old", v: vec("camera") });
  const r3 = await rankByMeaning(docs, "battery", io);
  check("a passage whose text changed is embedded again", r3.embedded === 1, String(r3.embedded));
  const capped = await rankByMeaning(docs.map((d) => ({ ...d, id: `n${d.id}` })), "battery", { ...io, cap: 2 });
  check("a cap on how many are embedded per search", capped.embedded === 2 && capped.skipped === docs.length - 2, JSON.stringify(capped));
  const fused = await search(idx, "long-lasting charge", { vector: { rank: async () => r1.ids }, all: true });
  check("fused with keywords, the meaning hits come back though no word matched", byAnswer(fused.hits).length >= 2, JSON.stringify(fused.hits.map((h) => h.doc.id)));
  check("pooling averages the unmasked tokens and scales to length 1", Math.abs(Math.hypot(...meanPool(new Float32Array([1, 0, 0, 1, 9, 9]), 2, [1, 1, 0], 3, 0)) - 1) < 1e-6);
  check("a stable text hash", textHash("abc") === textHash("abc") && textHash("abc") !== textHash("abd"));
  check("dot of a unit vector with itself is 1", Math.abs(dot(vec("battery"), vec("battery")) - 1) < 1e-6);
}

console.log("\nAsk: wording questions use the passages, inside the scope");
{
  const r = await askPlanned({ question: "Show me answers that mention battery", data });
  check("questions are searched too: the battery prompts are found", r.by === "template" && /answers? found/.test(r.answer) && /battery/i.test(r.answer), r.answer.slice(0, 300));
  const typo = await askPlanned({ question: "Show me answers that mention batery", data });
  check("a typo still finds them, and says how it read it", /battery/i.test(typo.answer) && /batery → battery/.test(typo.lookups[0]), typo.lookups[0].slice(0, 300));
  let asked = null;
  const m = await askPlanned({ question: "Which answers talk about long-lasting charge?", data, meaning: async (q, docs) => { asked = { q, n: docs.length }; return docs.filter((d) => /good choice/.test(d.text)).map((d) => d.id).slice(0, 3); } });
  check("with the meaning model on, it is asked with the whole question and the passages in scope", asked && /long-lasting charge/.test(asked.q) && asked.n > 0, JSON.stringify(asked));
  check("and its hits come back though no word matched", m.result === undefined && /found/.test(m.answer), m.answer.slice(0, 200));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
