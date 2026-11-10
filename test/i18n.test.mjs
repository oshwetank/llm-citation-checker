/*
 * The interface in other languages (ui/i18n.js, 0.71.0). Run: node test/i18n.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickLang, chosenLang, loadLang, tr, tp, isRtl, LANGS, uiLang } from "../ui/i18n.js";

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
check("Arabic is in Arabic script, Hindi in Devanagari", /[؀-ۿ]/.test(dicts.ar.Settings) && /[ऀ-ॿ]/.test(dicts.hi.Settings), dicts.ar.Settings + " " + dicts.hi.Settings);

console.log("\ntranslating");
await loadLang("es", { Settings: "Configuración", Brands: "Marcas", "Share of voice": "Cuota de voz" });
check("a known label", tr("Settings") === "Configuración" && uiLang() === "es");
check("an unknown string stays English", tr("Zento Nova 8") === "Zento Nova 8");
check("punctuation around a known label is kept", tr("Brands:") === "Marcas:" && tr(" · Brands") === " · Marcas", JSON.stringify([tr("Brands:"), tr(" · Brands")]));
check("not a string: unchanged", tr(42) === 42 && tr(null) === null);
check("numbers in the language's style", tp(1234, "brand", "brands").startsWith("1234") || tp(1234, "brand", "brands").startsWith("1.234"), tp(1234, "brand", "brands"));
await loadLang("en");
check("English: nothing changes", tr("Settings") === "Settings");

console.log("\nthe store listing in every language");
for (const d of readdirSync(path.join(ROOT, "_locales"))) {
  const m = JSON.parse(readFileSync(path.join(ROOT, "_locales", d, "messages.json"), "utf8"));
  check(`_locales/${d}: name and a description under 132 characters`, m.appName && m.appName.message === "CitoSkeleton" && m.appDesc && m.appDesc.message.length <= 132, m.appDesc && m.appDesc.message.length);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
