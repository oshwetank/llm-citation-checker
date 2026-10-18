/*
 * Names found in any script (src/lib/textMatch.js, 0.70.0).
 * Run: node test/text-has.test.mjs
 *
 * Reported in the plan review: every name check used JavaScript's \b, which
 * only knows ASCII letters, so a brand written "ソニー" or "नोकिया" was
 * never matched and the AI merge always threw it away.
 */
import { textHas, textMatches, wordRe } from "../src/lib/textMatch.js";
import { detectBrandsAI, registerTierB } from "../src/lib/ai-brands.js";
import { brandPresence } from "../src/lib/geo.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("whole words in any script");
check("Japanese katakana inside a sentence", textHas("ゼントのスマホとコヴォのイヤホン", "コヴォ"));
check("Chinese", textHas("我推荐泽诺手机和科沃耳机", "科沃"));
check("Devanagari with vowel signs", textHas("सबसे अच्छा फ़ोन ज़ेंटो नोवा है", "ज़ेंटो"));
check("Devanagari: not inside a longer word", !textHas("ज़ेंटोवाला", "ज़ेंटो"));
check("Arabic", textHas("أفضل هاتف هو زينتو نوفا", "زينتو"));
check("Thai", textHas("โทรศัพท์เซนโตดีที่สุด", "เซนโต"));
check("Cyrillic, case-insensitive", textHas("Лучший телефон — ЗЕНТО Нова", "Зенто"));
check("Latin with accents", textHas("Le meilleur est Lumière Café.", "Lumière"));
check("Latin: not inside a longer word", !textHas("Zentoplex is new", "Zento"));
check("Latin: an accented letter is a letter", !textHas("Zentoé", "Zento"));
check("punctuation is an edge", textHas("(Zento)", "Zento") && textHas("Zento's", "Zento"));
check("counts every match", textMatches("Kovo, kovo and KOVO", "Kovo").length === 3);
check("names with regex characters", textHas("Try C++ Tools today", "C++ Tools"));
check("unicode flag added", wordRe("x", "g").flags.includes("u"));

console.log("the AI merge keeps non-Latin names it can verify");
{
  const answer = "おすすめはゼントとコヴォです。コヴォは音質が良い。";
  registerTierB(async () => ["コヴォ", "ありえない"]);
  const r = await detectBrandsAI(answer, answer, {});
  const k = r.brands.find((b) => b.brand === "コヴォ");
  check("コヴォ added with its two mentions", k && k.count === 2, JSON.stringify(r.brands));
  check("a name not in the text is still refused", !r.brands.some((b) => b.brand === "ありえない"));
  registerTierB(null);
}

console.log("tracked brands are found in non-Latin answers");
{
  const [p] = brandPresence({ answerText: "सबसे अच्छा फ़ोन ज़ेंटो नोवा है। ज़ेंटो सस्ता है।", brandMentions: [], sources: [] }, [{ name: "ज़ेंटो" }]);
  check("Devanagari brand present, with a key", p.present && p.key === "ज़ेंटो" && p.firstIndex > 0, JSON.stringify(p));
  const [q] = brandPresence({ answerText: "ソニーとゼントの比較", brandMentions: [{ brand: "ゼント", count: 1, firstIndex: 4 }], sources: [] }, [{ name: "ゼント" }]);
  check("a detected Japanese mention is matched to the tracked brand", q.present && q.mentions === 1, JSON.stringify(q));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
