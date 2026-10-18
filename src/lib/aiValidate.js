/*
 * aiValidate.js — every claim the built-in AI makes is checked here before
 * it is kept (0.70.0). A 2B model on a laptop is far smaller than the
 * engines it reads, so it is used to label and check, never trusted to
 * invent: a quote must be in the answer, codes must be real codes, a name
 * must be written in the text, and positions are never taken from it.
 * Whatever fails is dropped and listed in `dropped`, so the check is
 * auditable.
 */
import { textHas } from "./textMatch.js";
import { THEMES } from "./campaignView.js";

export const INTENTS = [...THEMES.map((t) => t[0]), "other"];
export const AUDIENCES = ["consumer", "business", "public_sector", "mixed"];
export const FUNNEL = ["awareness", "consideration", "decision", "post_purchase"];
export const SCOPES = ["local", "national", "regional", "global"];
export const ENTITY_TYPES = ["brand", "product", "retailer", "publisher", "institution", "place", "person", "other"];
export const STANCES = ["recommended", "positive", "neutral", "negative", "advised_against", "mentioned"];

const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s ]+/g, " ")
  .replace(/[“”«»„]/g, "\"").replace(/[‘’‚]/g, "'").replace(/[–—]/g, "-").trim();

/** The sentence (or line) of `text` that holds `quote`, or "". */
export function sentenceOf(text, quote) {
  const t = norm(text).replace(/\*\*|__|`/g, "");
  const q = norm(quote).replace(/\*\*|__|`/g, "").replace(/^["'\s.…]+|["'\s.…]+$/g, "");
  const i = t.indexOf(q);
  if (i < 0) return "";
  const before = t.slice(0, i), after = t.slice(i + q.length);
  const a = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n"), before.lastIndexOf("! "), before.lastIndexOf("? "), before.lastIndexOf("। "), before.lastIndexOf("。"));
  const m = after.search(/[.!?。।](\s|$)|\n/);
  return t.slice(a < 0 ? 0 : a + 1, i + q.length + (m < 0 ? after.length : m + 1)).trim();
}

/** Is `quote` (a few words to a sentence) really in `text`? */
export function quoteIn(text, quote) {
  const q = norm(quote).replace(/\*\*|__|`/g, "").replace(/^["'\s.…]+|["'\s.…]+$/g, "");
  if (q.length < 2 || q.length > 400) return false;
  const t = norm(text).replace(/\*\*|__|`/g, "");
  if (t.includes(q)) return true;
  // A quote that skips markdown or a line break still counts if every
  // piece is there in order.
  const parts = q.split(/\s*(?:…|\.\.\.)\s*/).filter((p) => p.length >= 2);
  if (parts.length < 2) return false;
  let at = 0;
  for (const p of parts) { const i = t.indexOf(p, at); if (i < 0) return false; at = i + p.length; }
  return true;
}

let CURRENCIES = null;
export function validCurrency(c) {
  const code = String(c || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try { CURRENCIES = CURRENCIES || new Set(Intl.supportedValuesOf("currency")); } catch (_) { CURRENCIES = new Set(); }
  return CURRENCIES.size === 0 || CURRENCIES.has(code) ? code : null;
}
export function validCountry(cc) {
  const code = String(cc || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  try {
    // ZZ ("Unknown Region"), XA/XB (pseudo-locales) and QM–QZ are not countries.
    if (/^(ZZ|X[A-Z]|Q[M-Z]|AA)$/.test(code)) return null;
    const n = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code);
    return n ? code : null;
  } catch (_) { return code; }
}
export function validLang(l) {
  const raw = String(l || "").trim().replace(/_/g, "-");
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(raw)) return null;
  try {
    const [canon] = Intl.getCanonicalLocales(raw);
    const base = canon.split("-")[0];
    const n = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(base);
    return n ? canon : null;
  } catch (_) { return null; }
}
const oneOf = (v, list) => { const s = String(v || "").toLowerCase().trim().replace(/[\s-]+/g, "_"); return list.includes(s) ? s : null; };
const clean = (s, max = 80) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t && t.length <= max ? t : null; };

/**
 * Task (a): what the answer is — language, market, intent, audience, topics.
 * Codes must be valid; market evidence must be words from the answer or the
 * prompt. A market with no evidence is kept only as a guess (`evidence: []`)
 * when it agrees with the currency found in the text.
 */
export function validateAnswerFacts(raw, { text, prompt, currencies = [] } = {}) {
  const dropped = [];
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const lang = validLang(r.lang || r.language);
  if (lang) out.lang = lang; else if (r.lang || r.language) dropped.push({ field: "lang", value: r.lang || r.language, why: "not a language code" });
  const m = r.market && typeof r.market === "object" ? r.market : {};
  const country = validCountry(m.country);
  const currency = validCurrency(m.currency);
  const scope = oneOf(m.scope, SCOPES);
  const evidence = (Array.isArray(m.evidence) ? m.evidence : []).map((e) => clean(e, 60)).filter(Boolean)
    .filter((e) => quoteIn(text, e) || quoteIn(prompt || "", e));
  const badEvidence = (Array.isArray(m.evidence) ? m.evidence : []).length - evidence.length;
  if (badEvidence > 0) dropped.push({ field: "market.evidence", value: badEvidence, why: "words not in the answer or prompt" });
  if (m.country && !country) dropped.push({ field: "market.country", value: m.country, why: "not a country code" });
  if (m.currency && !currency) dropped.push({ field: "market.currency", value: m.currency, why: "not a currency code" });
  const currencyOk = currency && (currencies.length === 0 || currencies.includes(currency));
  if (currency && !currencyOk) dropped.push({ field: "market.currency", value: currency, why: "no price in that currency in the answer" });
  if (country || currencyOk || scope) {
    out.market = { country: country || null, currency: currencyOk ? currency : null, scope: scope || (country ? "national" : null), evidence };
    if (country && !evidence.length && !currencyOk) { out.market.country = null; dropped.push({ field: "market.country", value: country, why: "no evidence in the text" }); }
  }
  const intent = oneOf(r.intent, INTENTS);
  if (intent) out.intent = intent; else if (r.intent) dropped.push({ field: "intent", value: r.intent, why: "not a known intent" });
  const funnel = oneOf(r.funnel || r.stage, FUNNEL);
  if (funnel) out.funnel = funnel;
  const audience = oneOf(r.audience, AUDIENCES);
  if (audience) out.audience = audience;
  const vertical = clean(r.vertical || r.industry, 48);
  if (vertical) out.vertical = vertical;
  const t = r.topics && typeof r.topics === "object" ? r.topics : {};
  const en = (Array.isArray(t.en) ? t.en : Array.isArray(r.topics) ? r.topics : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 6);
  const orig = (Array.isArray(t.orig || t.original) ? (t.orig || t.original) : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 6);
  if (en.length || orig.length) out.topics = { en, orig };
  return { value: out, dropped };
}

/**
 * Task (b): the brands the rules found, labelled. Only names in `candidates`
 * are kept (the model can't add names here), and a stance needs a quote
 * that is in the answer and names the brand.
 */
export function validateEntities(raw, { text, candidates = [] } = {}) {
  const dropped = [];
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.entities) ? raw.entities : [];
  const byLower = new Map(candidates.map((c) => [String(c).toLowerCase(), c]));
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const name = byLower.get(String(e.name || "").toLowerCase().trim());
    if (!name) { dropped.push({ field: "entity", value: e.name, why: "not one of the names found in the answer" }); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    const item = { name, type: oneOf(e.type, ENTITY_TYPES) || "other" };
    const owner = clean(e.owner || e.parent, 60);
    if (owner && owner.toLowerCase() !== name.toLowerCase()) item.owner = owner;
    const stance = oneOf(e.stance, STANCES);
    const quote = clean(e.quote, 300);
    if (stance && stance !== "mentioned") {
      // The quote must be in the answer, in a sentence that names the brand
      // ("…, pero no la recomiendo" is about the brand named before it).
      const sent = quote && quoteIn(text, quote) ? (sentenceOf(text, quote) || quote) : "";
      if (sent && (textHas(sent, name) || sent.includes(name.toLowerCase()))) {
        item.stance = stance; item.quote = quote;
      } else {
        dropped.push({ field: "entity.stance", value: `${name}: ${stance}`, why: "its quote is not in the answer, or not in a sentence that names it" });
        item.stance = "mentioned";
      }
    } else item.stance = "mentioned";
    out.push(item);
  }
  return { value: out, dropped };
}

/**
 * Task (c): names the rules missed. Each must be written in the answer as a
 * whole word, not already known, with a quote from the answer that has it.
 */
export function validateMissed(raw, { text, known = [], isPlausible = () => true } = {}) {
  const dropped = [];
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.missed) ? raw.missed : raw && Array.isArray(raw.names) ? raw.names : [];
  const knownLower = new Set(known.map((k) => String(k).toLowerCase()));
  const out = [];
  for (const e of list) {
    const name = clean(typeof e === "string" ? e : e && e.name, 60);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (knownLower.has(lower) || out.some((o) => o.name.toLowerCase() === lower)) continue;
    if (!textHas(text, name)) { dropped.push({ field: "missed", value: name, why: "not written in the answer" }); continue; }
    if (!isPlausible(name)) { dropped.push({ field: "missed", value: name, why: "a common word, place or currency, not a name" }); continue; }
    const quote = clean(e && e.quote, 300);
    if (!quote || !quoteIn(text, quote) || !textHas(quote, name)) { dropped.push({ field: "missed", value: name, why: "no quote from the answer that has it" }); continue; }
    out.push({ name, type: oneOf(e.type, ENTITY_TYPES) || "brand", quote });
  }
  return { value: out.slice(0, 15), dropped };
}
