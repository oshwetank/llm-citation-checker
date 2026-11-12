/*
 * The interface in other languages (ui/i18n.js, 0.71.0). Run: node test/i18n.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickLang, chosenLang, loadLang, tr, tp, isRtl, LANGS, uiLang, patternKey } from "../ui/i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("picking the language");
check("exact", pickLang(["fr"]) === "fr");
check("a region falls back to its language", pickLang(["es-419"]) === "es" && pickLang(["pt-PT"]) === "pt-BR" && pickLang(["ar-EG"]) === "ar", [pickLang(["es-419"]), pickLang(["pt-PT"]), pickLang(["ar-EG"])].join());
check("the first supported in the list", pickLang(["ja", "de", "hi-IN"]) === "hi");
check("nothing supported: English", pickLang(["ja", "zh"]) === "en" && pickLang([]) === "en");
check("a saved choice wins over the browser", chosenLang({ getItem: () => "ar" }, { languages: ["fr"] }) === "ar");
check("'auto' follows the browser", chosenLang({ getItem: () => "auto" }, { languages: ["pt-BR", "en"] }) === "pt-BR");
check("right to left", isRtl("ar") && isRtl("ar-EG") && !isRtl("hi") && !isRtl("en"));

console.log("\nevery dictionary");
const dir = path.join(ROOT, "ui/i18n");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
check("one per language except English", files.map((f) => f.replace(/\.json$/, "")).sort().join() === LANGS.map(([c]) => c).filter((c) => c !== "en").sort().join(), files.join());
const dicts = Object.fromEntries(files.map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(dir, f), "utf8"))]));
const keys = Object.keys(dicts.es).sort().join("\n");
for (const [code, d] of Object.entries(dicts)) {
  check(`${code}: the same keys as the others`, Object.keys(d).sort().join("\n") === keys);
  const empty = Object.entries(d).filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
  check(`${code}: no empty translation`, empty.length === 0, empty.slice(0, 5).join(" | "));
  const engines = Object.entries(d).filter(([k, v]) => /ChatGPT|Gemini|Perplexity|Grok/.test(k) && !["ChatGPT", "Gemini", "Perplexity", "Grok"].every((e) => !k.includes(e) || v.includes(e)));
  check(`${code}: engine names kept as they are`, engines.length === 0, engines.slice(0, 3).map(([k, v]) => `${k} → ${v}`).join(" | "));
}
// Sentences built from numbers and names (0.84.2). A translation has to hand
// back every number its key holds: "#" for each in order, or "#1", "#2" when
// the language puts them the other way round (Hindi: "6 में से 3").
for (const [code, d] of Object.entries(dicts)) {
  const wrong = Object.entries(d).filter(([k, v]) => {
    if (typeof v !== "string") return false;
    const want = (k.match(/#/g) || []).length;
    const slots = [...v.matchAll(/#(\d)?/g)].map((m) => m[1]);
    if (!want && !slots.length) return false;
    if (slots.some(Boolean)) return !(slots.every(Boolean) && [...slots].map(Number).sort().join() === Array.from({ length: want }, (_, i) => i + 1).join());
    return slots.length !== want;
  }).map(([k]) => k);
  check(`${code}: every number in a sentence has its place in the translation`, wrong.length === 0, wrong.slice(0, 3).join(" | "));
  const noEngine = Object.entries(d).filter(([k, v]) => k.includes("{engine}") !== String(v).includes("{engine}")).map(([k]) => k);
  check(`${code}: and so does the engine's name`, noEngine.length === 0, noEngine.slice(0, 3).join(" | "));
}
check("the sentences the audit found in English are there (# of #, Asked {engine}, the Dashboard's count…)", ["# of #", "Asked {engine}", "# pages read", "prompts captured in the last # days", "When you asked", "Delete everything captured", "# of # required items done", "The answer, as {engine} showed it", "Metric glossary", "Search your prompts, the answers, and what the engines searched for"].every((k) => k in dicts.es), "");
check("about 1,000 phrases each, up from 623", Object.keys(dicts.ar).length >= 1000, String(Object.keys(dicts.ar).length));
check("Arabic is in Arabic script, Hindi in Devanagari", /[؀-ۿ]/.test(dicts.ar.Settings) && /[ऀ-ॿ]/.test(dicts.hi.Settings), dicts.ar.Settings + " " + dicts.hi.Settings);

console.log("\ntranslating");
await loadLang("es", { Settings: "Configuración", Brands: "Marcas", "Share of voice": "Cuota de voz" });
check("a known label", tr("Settings") === "Configuración" && uiLang() === "es");
check("an unknown string stays English", tr("Zento Nova 8") === "Zento Nova 8");
check("punctuation around a known label is kept", tr("Brands:") === "Marcas:" && tr(" · Brands") === " · Marcas", JSON.stringify([tr("Brands:"), tr(" · Brands")]));
check("not a string: unchanged", tr(42) === 42 && tr(null) === null);
check("numbers in the language's style", tp(1234, "brand", "brands").startsWith("1234") || tp(1234, "brand", "brands").startsWith("1.234"), tp(1234, "brand", "brands"));

console.log("\nsentences built from numbers and names (0.84.2)");
// The 10 Nov 2026 audit: the Arabic Dashboard read "1 prompts captured in the
// last 7 days", "3 of 6" and "Asked Perplexity" in English, because the
// dictionary only ever matched a whole, fixed string.
check("the key: numbers become #, the engine {engine}", JSON.stringify(patternKey("Asked Perplexity 3 of 1,200 times")) === JSON.stringify({ key: "Asked {engine} # of # times", nums: ["3", "1,200"], engine: "Perplexity" }), JSON.stringify(patternKey("Asked Perplexity 3 of 1,200 times")));
await loadLang("es", { "# of #": "# de #", "Asked {engine}": "Preguntado a {engine}", Cited: "Citado", "# cited": "# citadas", "# pages read": "# páginas leídas", "Version #": "Versión #" });
check("numbers go back in order", tr("3 of 6") === "3 de 6" && tr("1,200 of 2,000") === "1,200 de 2,000", tr("3 of 6"));
check("a version is one number", tr("Version 0.84.2") === "Versión 0.84.2", tr("Version 0.84.2"));
check("the engine's name goes back as it was", tr("Asked Perplexity") === "Preguntado a Perplexity" && tr("Asked ChatGPT") === "Preguntado a ChatGPT");
check("parts joined by · are each translated", tr("6 pages read · 3 cited") === "6 páginas leídas · 3 citadas" && tr("Cited · 2") === "Citado · 2", tr("6 pages read · 3 cited"));
check("an unknown part stays, the known one doesn't", tr("Zento Nova 8 · 3 cited") === "Zento Nova 8 · 3 citadas", tr("Zento Nova 8 · 3 cited"));
check("punctuation and spaces around it are kept", tr(" · 3 of 6:") === " · 3 de 6:", JSON.stringify(tr(" · 3 of 6:")));
check("a sentence nobody translated stays English", tr("7 wonders of 2 worlds") === "7 wonders of 2 worlds");
await loadLang("hi", { "# of #": "#2 में से #1", "# of # sentences (#%)": "#2 में से #1 वाक्य (#3%)" });
check("a language that turns the numbers round says so with #1, #2", tr("3 of 6") === "6 में से 3" && tr("3 of 6 sentences (50%)") === "6 में से 3 वाक्य (50%)", tr("3 of 6 sentences (50%)"));
for (const code of ["es", "pt-BR", "fr", "hi", "ar"]) {
  await loadLang(code, dicts[code]);
  const out = [tr("3 of 6"), tr("Asked Perplexity"), tr("6 pages read · 3 cited"), tr("prompts captured in the last 7 days"), tr("2 of 5 required items done")];
  check(`${code}: the real dictionary translates them`, out.every((o) => !/\b(of|Asked|read|cited|captured|required)\b/.test(o)) && out[0].includes("3") && out[0].includes("6") && out[1].includes("Perplexity"), out.join(" | "));
}
await loadLang("en");
check("English: nothing changes", tr("Settings") === "Settings");

console.log("\nthe store listing in every language");
for (const d of readdirSync(path.join(ROOT, "_locales"))) {
  const m = JSON.parse(readFileSync(path.join(ROOT, "_locales", d, "messages.json"), "utf8"));
  check(`_locales/${d}: name and a description under 132 characters`, m.appName && m.appName.message === "CitoSkeleton" && m.appDesc && m.appDesc.message.length <= 132, m.appDesc && m.appDesc.message.length);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
