/*
 * i18n.js — the interface in the reader's language (0.71.0).
 *
 * Dictionaries (ui/i18n/<lang>.json) map the English text to its
 * translation, so the English stays the source and nothing breaks when a
 * phrase has no translation yet: it shows in English. The static page is
 * translated once (translatePage), and every plain string the panel draws
 * goes through tr() in its element helper, so labels, headings and buttons
 * follow without each call site changing. Sentences built from numbers and
 * names stay English until they get keys of their own.
 *
 * The language follows the browser's, or Settings → Language. Right-to-left
 * languages set dir="rtl" (theme-boot.js does it before the first paint);
 * the stylesheet uses logical properties, so the layout mirrors.
 *
 * Translations are drafts for a native speaker's review (see HANDOFF.md).
 */
export const LANGS = [
  ["en", "English"], ["es", "Español"], ["pt-BR", "Português (Brasil)"], ["fr", "Français"], ["hi", "हिन्दी"], ["ar", "العربية"],
];
export const RTL = new Set(["ar", "he", "fa", "ur"]);
export const LANG_KEY = "cito-lang";

/** The supported language for a preference list ("pt-PT" → "pt-BR", "es-419" → "es"). */
export function pickLang(prefs) {
  const have = LANGS.map(([c]) => c);
  for (const p of prefs || []) {
    if (!p) continue;
    const exact = have.find((c) => c.toLowerCase() === String(p).toLowerCase());
    if (exact) return exact;
    const base = String(p).toLowerCase().split("-")[0];
    const byBase = have.find((c) => c.toLowerCase().split("-")[0] === base);
    if (byBase) return byBase;
  }
  return "en";
}

export function chosenLang(storage = globalThis.localStorage, nav = globalThis.navigator) {
  let pref = "auto";
  try { pref = (storage && storage.getItem(LANG_KEY)) || "auto"; } catch (_) { /* storage off */ }
  if (pref !== "auto") return pickLang([pref]);
  let ui = null;
  try { ui = globalThis.chrome && chrome.i18n && chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : null; } catch (_) { /* not an extension page */ }
  return pickLang([ui, ...((nav && nav.languages) || []), nav && nav.language]);
}

let lang = "en";
let dict = {};

/** Load the dictionary for `code` (from the extension, or a given object in tests). */
export async function loadLang(code, given) {
  lang = code || "en";
  dict = {};
  if (given) { dict = given; return; }
  if (lang === "en") return;
  try {
    const url = globalThis.chrome && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(`ui/i18n/${lang}.json`) : new URL(`./i18n/${lang}.json`, import.meta.url).href;
    const r = await fetch(url);
    if (r.ok) dict = await r.json();
  } catch (_) { /* English it is */ }
}

export const uiLang = () => lang;
export const isRtl = (code = lang) => RTL.has(String(code).split("-")[0]);

/*
 * Sentences built from numbers and names (0.84.2).
 *
 * The dictionaries are keyed by the exact English text, so anything the
 * panel builds in code never matched: "3 of 6", "Asked Perplexity",
 * "Cited · 2", "1 prompts captured in the last 7 days". In the 10 Nov 2026
 * audit that left the Arabic Dashboard half in English, and a sweep of every
 * screen found about 480 such strings. Rewriting each call site would touch
 * hundreds of lines, so the lookup learns the shapes instead:
 *
 *   - every number becomes "#"        "3 of 6"            → key "# of #"
 *   - an engine's name becomes        "Asked Perplexity"  → key "Asked {engine}"
 *     "{engine}"
 *   - parts joined by " · " are       "Cited · 2"         → "Cited" and "2",
 *     looked up one by one                                   each on its own
 *
 * The numbers and the name go back into the translation in the order they
 * came ("#" by "#"); a translation that needs them in another order writes
 * "#1", "#2". patternKey is exported so the tool that finds missing strings
 * (and the test) makes the same keys.
 */
const ENGINE_NAMES = /\b(?:ChatGPT|Gemini|Perplexity|Grok|Claude)\b/;
const NUMBER = /\d[\d,.]*\d|\d/g;
export function patternKey(s) {
  const nums = [];
  let engine = null;
  let key = String(s).replace(ENGINE_NAMES, (m) => { engine = m; return "{engine}"; });
  key = key.replace(NUMBER, (m) => { nums.push(m); return "#"; });
  return { key, nums, engine };
}
function fill(template, nums, engine) {
  let i = 0;
  return template
    .replace(/#(\d)?/g, (_, n) => (n ? nums[Number(n) - 1] : nums[i++]) ?? "#")
    .replace("{engine}", engine ?? "{engine}");
}

/** The translation of an English UI string, or the string itself. */
export function tr(s) {
  if (typeof s !== "string" || lang === "en") return s;
  const hit = dict[s];
  if (hit != null) return hit;
  // "Label:" / " · Label" keep their punctuation around a known label.
  const m = /^(\s*(?:·\s*)?)(.*?)(\s*[:…]?\s*)$/.exec(s);
  if (m && m[2] !== s && dict[m[2]] != null) return m[1] + dict[m[2]] + m[3];
  // A sentence with numbers or an engine's name in it.
  const core = m ? m[2] : s;
  const { key, nums, engine } = patternKey(core);
  if (key !== core && typeof dict[key] === "string") return (m ? m[1] : "") + fill(dict[key], nums, engine) + (m ? m[3] : "");
  // "A · B · C": each part on its own. A part that is itself unknown stays
  // English, so a half-known line is half translated rather than not at all.
  if (s.includes(" · ")) {
    const parts = s.split(" · ");
    const out = parts.map((p) => (p.includes(" · ") ? p : tr(p)));
    if (out.some((p, i) => p !== parts[i])) return out.join(" · ");
  }
  return s;
}

/*
 * A sentence with names in it (0.84.3): fmt("Show {brand} in the answer",
 * { brand }) and fmt("{n} prompts", { n }, "{n} prompt").
 *
 * The key is the template, so a name never has to be guessed out of a
 * finished sentence. tr() could have learned "Show * in the answer" from the
 * text alone, but it also sees what the user typed and what the engines
 * wrote, and a prompt such as "Compare iPhone with Samsung" would have been
 * translated as if it were a label. Here the call site says which parts are
 * names. A value that is a number is written in the language's style; a
 * third argument is the singular, used when the language calls the count
 * "one" (which also puts right the English "1 prompts").
 */
export function fmt(template, vars = {}, one = null) {
  const n = typeof vars.n === "number" ? vars.n : null;
  let t = template;
  if (one && n != null) { try { if (new Intl.PluralRules(lang).select(n) === "one") t = one; } catch (_) { if (n === 1) t = one; } }
  const out = lang !== "en" && typeof dict[t] === "string" ? dict[t] : t;
  return out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (typeof vars[k] === "number" ? fmtNum(vars[k]) : String(vars[k] ?? "")) : m));
}

/** The locale dates are written in: the chosen language, or the browser's for English. */
export const dateLocale = () => (lang === "en" ? undefined : lang);

/** A count with the right plural for the language: tp(3, "brand", "brands"). */
export function tp(n, one, other) {
  const cat = new Intl.PluralRules(lang).select(n);
  const forms = dict[`${other}|plural`];
  const word = forms && typeof forms === "object" ? (forms[cat] || forms.other) : (cat === "one" ? tr(one) : tr(other));
  return `${fmtNum(n)} ${word}`;
}

export const fmtNum = (n, opts) => { try { return new Intl.NumberFormat(lang, opts).format(n); } catch (_) { return String(n); } };
export const fmtDate = (t, opts = { dateStyle: "medium" }) => { try { return new Intl.DateTimeFormat(lang, opts).format(new Date(t)); } catch (_) { return new Date(t).toDateString(); } };

const ATTRS = ["placeholder", "title", "aria-label"];
/** Translate the static page: text-only elements, and placeholder/title/aria-label. */
export function translatePage(root = document) {
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  if (lang === "en") return;
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue;
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t || !/[A-Za-z]/.test(t)) continue;
    const out = tr(t);
    if (out !== t) n.nodeValue = raw.replace(raw.trim(), out);
  }
  (root.querySelectorAll ? root : document).querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach((el) => {
    for (const a of ATTRS) if (el.hasAttribute(a)) { const v = el.getAttribute(a); const out = tr(v); if (out !== v) el.setAttribute(a, out); }
  });
}
