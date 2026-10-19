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

/** The translation of an English UI string, or the string itself. */
export function tr(s) {
  if (typeof s !== "string" || lang === "en") return s;
  const hit = dict[s];
  if (hit != null) return hit;
  // "Label:" / " · Label" keep their punctuation around a known label.
  const m = /^(\s*(?:·\s*)?)(.*?)(\s*[:…]?\s*)$/.exec(s);
  if (m && m[2] !== s && dict[m[2]] != null) return m[1] + dict[m[2]] + m[3];
  return s;
}

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
