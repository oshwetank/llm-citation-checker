/*
 * funnel-omitted.js — "the engine retrieved this and then didn't write it".
 *
 * Extracted out of ui/panel.js's renderAnalyze() because this is real
 * analysis, not rendering, and every bug it has ever had was a logic bug that
 * no test could reach while it lived inside a DOM-building function:
 *
 *   - it reported brands as OMITTED that the answer plainly mentioned,
 *     because it compared brand names by exact string while the optional AI
 *     tier (src/lib/ai-brands.js) renames "Vivo" -> "vivo X200 FE" in place;
 *   - it emitted "models" like "X200 FE with us to Ud" and "13s. We" by
 *     grabbing capitalised words out of source headlines.
 *
 * Both are covered by test/funnel-omitted.test.mjs now.
 *
 * The comparison is always: what the ANSWER narrated, versus what the SOURCE
 * titles/snippets contained. A brand only counts as mentioned if the model
 * actually wrote about it — a count=0 "shown in a carousel, never named"
 * entry is precisely the case this module exists to surface.
 */

import { matchCompressedLabel, vendorFromProductName, escapeRegExp } from "./brands.js";

// Sub-brands that belong to a parent. Additive only: an unknown name is
// simply used as-is, so this never gates detection for an unlisted vertical.
export const SUB_BRAND_PARENT = {
  "google pixel": "Google", "pixel": "Google", "galaxy": "Samsung", "iphone": "Apple",
  "ipad": "Apple", "macbook": "Apple", "surface": "Microsoft", "rog": "Asus",
  "tuf": "Asus", "vivobook": "Asus", "ideapad": "Lenovo", "thinkpad": "Lenovo",
  "victus": "HP", "pavilion": "HP", "inspiron": "Dell", "alienware": "Dell",
  "legion": "Lenovo", "predator": "Acer",
};

export const canonicalBrand = (name) =>
  SUB_BRAND_PARENT[String(name || "").toLowerCase()] || name;

const brandKey = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Do two names refer to the same company? Compared at WORD granularity, so
 * one being a prefix of the other counts ("vivo X200 FE" ≡ "Vivo").
 *
 * This is the fix for the inverted card: with an exact-string comparison, a
 * capture where Chrome's on-device AI tier had upgraded every brand to its
 * full product name listed all five mentioned brands as omitted.
 */
export function sameBrand(a, b) {
  const A = brandKey(a).split(" ").filter(Boolean);
  const B = brandKey(b).split(" ").filter(Boolean);
  if (!A.length || !B.length) return false;
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) return false;
  return true;
}

/**
 * The vocabulary used to scan source snippets.
 *
 * Deliberately NOT built from source domains or retailers: tested against
 * real captures, those surfaced publishers ("Gadgets360", "Smartprix") and
 * sellers ("Flipkart") as omitted brands. What remains comes from what the
 * automatic detector already found in this capture, so it carries no
 * industry vocabulary of its own.
 */
export function buildBrandVocabulary(rec) {
  const vocab = new Map(); // normalized key -> display name
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const add = (name) => {
    const t = String(name || "").trim().replace(/[*_`]/g, "");
    if (t.length < 3 || t.length > 60) return;
    const k = norm(t);
    if (k.length >= 3 && !vocab.has(k)) vocab.set(k, t);
  };

  (rec.brandMentions || []).forEach((b) => add(b.brand));
  (rec.products || []).forEach((p) => add(p.brand || vendorFromProductName(p.name)));
  (rec.places || []).forEach((p) => add(p.name));
  (rec.entities || []).forEach((e) => {
    if (/brand|company|organization|vendor|place|business/i.test(e.category || "")) add(e.text);
  });

  // Names the ENGINE ITSELF typed into its fan-out queries.
  //
  // Without this the card could only ever flag a brand the answer already
  // knew about, so a competitor the engine explicitly searched for and then
  // never wrote about — the single most actionable finding available — was
  // invisible. On the reported capture the engine searched "...Vivo X200 FE
  // Xiaomi 15 Pixel 9" and wrote about everything except Xiaomi.
  //
  // Two filters keep this precise. A token must be purely alphabetic, which
  // drops model designations ("X200") that would otherwise be reported as
  // brands; and it must actually appear in at least one retrieved source,
  // which drops a term the engine guessed at but found nothing for.
  const srcBlob = (rec.sources || []).map((s) => `${s.title || ""} ${s.snippet || ""}`).join(" \n ");
  const queries = [
    ...((rec.fanout && rec.fanout.search) || []),
    ...((rec.fanout && rec.fanout.shopping) || []),
    ...((rec.fanout && rec.fanout.image) || []),
  ].map((q) => (q && q.query) || "");
  for (const q of queries) {
    for (const tok of String(q).split(/\s+/)) {
      const t = tok.replace(/^[^\w]+|[^\w]+$/g, "");
      if (t.length < 3) continue;
      if (!/^[A-Z][A-Za-z]*$/.test(t)) continue; // capitalised, letters only
      if (QUERY_STOP.has(t.toLowerCase())) continue;
      if (!new RegExp(`\\b${escapeRegExp(t)}\\b`, "i").test(srcBlob)) continue;
      add(t);
    }
  }

  return vocab;
}

// Ordinary query scaffolding and the handful of geographies that show up in
// commerce prompts. English/query vocabulary, not industry vocabulary, so it
// stays vertical-neutral — a term that slips through still has to be
// corroborated by a real source before it can be reported.
const QUERY_STOP = new Set([
  "best", "top", "under", "over", "cheap", "cheapest", "budget", "new", "newest",
  "latest", "review", "reviews", "compare", "comparison", "guide", "list", "price",
  "prices", "buy", "near", "for", "the", "and", "with", "vs", "online", "offline",
  "today", "now", "good", "great", "recommended", "phone", "phones", "camera",
  "india", "indian", "usa", "america", "american", "uk", "britain", "europe",
  "china", "chinese", "japan", "japanese", "global", "world", "worldwide",
]);

/** Which vocabulary entries appear in one source's title/snippet. */
export function extractBrandsFromText(text, vocab) {
  if (!text || !vocab || !vocab.size) return [];
  const found = [];
  vocab.forEach((display) => {
    const verbatim = new RegExp(`\\b${escapeRegExp(display)}\\b`, "i").test(text);
    if (verbatim || matchCompressedLabel(text, display).length) found.push({ brand: display });
  });
  return found;
}

// Words that mean a source headline has moved on from the model designation
// into marketing/boilerplate, plus spec units that are never model names.
const MODEL_STOP = new Set([
  "review", "reviews", "price", "prices", "specs", "spec", "best", "top", "vs", "vs.",
  "full", "latest", "news", "buy", "online", "india", "deal", "deals", "compare",
  "comparison", "phone", "phones", "camera", "launch", "launched", "update", "offer",
  "sale", "gb", "mb", "tb", "mp", "mah", "hz", "rs", "inr", "usd", "the", "and", "with",
  "youtube", "amazon", "flipkart", "features", "test", "under", "in", "for", "we", "it",
  "ram", "rom", "new", "here", "which", "is", "makes", "made", "comparing", "vs",
  "why", "how", "what", "this", "that", "our", "your", "its", "you", "us", "to",
]);

// Model-suffix words that legitimately continue a designation: "Reno 15 Pro",
// "Galaxy S25 Ultra". Anything else in Title case ("New", "Which", "Makes")
// is the headline resuming prose.
const MODEL_SUFFIX = new Set([
  "pro", "max", "ultra", "plus", "lite", "mini", "air", "neo", "note", "edge",
  "fold", "flip", "se", "fe", "gt", "xl", "turbo", "power", "prime", "active",
]);

// A spec value, not a model: "16GB", "256GB", "5000mAh", "108MP", "120W".
const SPEC_VALUE_RE = /^\d+(gb|mb|tb|mp|mah|w|k|hz)$/i;

// Bare capacity numbers ("X200 FE 512"). Ordinary model numbers ("Pixel 9",
// "Reno 14") are kept — only the standard storage/RAM tiers are rejected.
const CAPACITY_NUMBERS = new Set(["64", "128", "256", "512", "1024"]);

/**
 * Model designations following a brand name in one source's text.
 *
 * The previous version took up to five capitalised words after the brand and
 * on a real capture produced twenty-one chips per brand, among them "X200 FE
 * with us to Ud", "X200 FE Review - YouT" and "13s. We". A model name has a
 * recognisable shape, so it is required to have one: a short run of
 * capitalised/numeric tokens that, joined, mixes letters and digits.
 */
export function modelAfterBrand(srcText, brand, otherBrands = null) {
  const out = new Set();
  if (!srcText || !brand) return [];
  const re = new RegExp(`\\b${escapeRegExp(brand)}\\s+([^\\n]{1,40})`, "gi");
  let m;
  let guard = 0;
  while ((m = re.exec(srcText)) !== null && guard++ < 20) {
    if (m.index === re.lastIndex) re.lastIndex++;
    const kept = [];
    for (const t0 of m[1].split(/\s+/)) {
      const t = t0.replace(/^[^\w]+|[^\w]+$/g, "");
      if (!t) break;
      if (MODEL_STOP.has(t.toLowerCase())) break;
      if (SPEC_VALUE_RE.test(t)) break;
      // A continuing model token is capitalised or numeric; an all-lowercase
      // word means the headline moved on to prose.
      if (!/^[A-Z0-9]/.test(t)) break;
      // Past the first token, ordinary Title-case words are the headline
      // resuming ("X200 FE New", "X200T Which Is", "13s We've"). A genuine
      // continuation carries a digit, is an initialism, or is a known model
      // suffix. Without this the run swallowed the rest of the sentence.
      if (kept.length > 0 &&
          !/\d/.test(t) &&
          !/^[A-Z0-9]+$/.test(t) &&
          !MODEL_SUFFIX.has(t.toLowerCase())) break;
      // A different brand's name ends this model — comparison headlines put
      // two side by side ("OnePlus 13s vs POCO F7"), which otherwise produced
      // the cross-brand mashup "13s POCO F7".
      if (otherBrands && otherBrands.has(t.toLowerCase())) break;
      // A long initialism mid-run is another product name the headline is
      // comparing against ("OnePlus 13s vs POCO F7"), not part of this model.
      // Short ones (FE, GT, XL) and known suffixes are genuine continuations.
      if (kept.length > 0 && /^[A-Z]{4,}$/.test(t) && !MODEL_SUFFIX.has(t.toLowerCase())) break;
      if (kept.length > 0 && CAPACITY_NUMBERS.has(t)) break;
      kept.push(t);
      if (kept.length === 3) break;
    }
    // The first token carries the designation's identity, so it must contain
    // a letter: a run starting on a bare number is a fragment of a longer
    // name ("9 Pro" out of "Pixel 9 Pro"), not a model in its own right.
    if (kept.length && !/[A-Za-z]/.test(kept[0])) kept.length = 0;
    const name = kept.join(" ").trim();
    // A real designation mixes letters and digits ("X200 FE", "13s", "10a").
    // Pure words ("Makes Premium") are headline fragments; pure numbers
    // ("612") are spec values, not models.
    if (name.length >= 2 && name.length <= 20 && /[A-Za-z]/.test(name) && /\d/.test(name)) {
      out.add(name);
    }
  }
  return [...out];
}

// Every single-word brand name in the vocabulary except the one being
// scanned — used to stop a model run at the next brand in a comparison title.
function otherBrandTokens(vocab, self) {
  const out = new Set();
  const selfLower = String(self || "").toLowerCase();
  vocab.forEach((display) => {
    const d = String(display).toLowerCase();
    if (d === selfLower) return;
    const first = d.split(/\s+/)[0];
    if (first && first.length >= 3) out.add(first);
  });
  return out;
}

/**
 * @returns {{ omittedBrands: Array, omittedModels: Array }}
 *   omittedBrands: [{ brand, sourceIdxs:number[], models:[{brand,model,sourceIdxs:number[]}] }]
 *   omittedModels: [{ brand, omittedModels:[...] }]  (brand WAS mentioned, some models weren't)
 */
export function computeSearchFunnel(rec, { maxModelsPerBrand = 5 } = {}) {
  const empty = { omittedBrands: [], omittedModels: [] };
  if (!rec || !rec.sources || !rec.sources.length) return empty;

  const mentionedNames = (rec.brandMentions || [])
    .filter((b) => b.count > 0)
    .map((b) => canonicalBrand(b.brand));
  const isMentioned = (name) => mentionedNames.some((m) => sameBrand(m, name));

  const brandCanonical = new Map(); // lower -> display
  const brandSourceIdxs = new Map(); // lower -> Set(idx)
  const modelEntries = new Map(); // "brand||model" -> { brand, model, sourceIdxs:Set }

  // Scanned PER SOURCE rather than over one concatenated blob, so a match can
  // never bleed across the boundary between two unrelated sources' text.
  const vocab = buildBrandVocabulary(rec);
  rec.sources.forEach((s, idx) => {
    const srcText = `${s.title || ""} ${s.snippet || ""}`;
    extractBrandsFromText(srcText, vocab).forEach((sb) => {
      const canonical = canonicalBrand(sb.brand);
      const key = canonical.toLowerCase();
      brandCanonical.set(key, canonical);
      if (!brandSourceIdxs.has(key)) brandSourceIdxs.set(key, new Set());
      brandSourceIdxs.get(key).add(idx);

      modelAfterBrand(srcText, sb.brand, otherBrandTokens(vocab, sb.brand)).forEach((model) => {
        const mKey = `${key}||${model.toLowerCase()}`;
        if (!modelEntries.has(mKey)) modelEntries.set(mKey, { brand: canonical, model, sourceIdxs: new Set() });
        modelEntries.get(mKey).sourceIdxs.add(idx);
      });
    });
  });

  const omittedBrands = [];
  const omittedModels = [];
  const ansTextLower = (rec.answerText || "").toLowerCase();


  // "Retrieved but not written" means exactly that: if the name occurs
  // anywhere in the answer, it was written. Two real false positives came from
  // skipping this check. A ChatGPT cement answer discussed OPC and PPC at
  // length — they are cement TYPE codes, and the engine had put them in its
  // fan-out query — so both were reported as brands the model dropped. And a
  // product shown only in a carousel ("Racold") was already listed in Brand
  // Mentions as "Shown, not named", then listed AGAIN here as omitted; one
  // finding should appear in one place.
  const inAnswer = (name) => ansTextLower.includes(String(name).toLowerCase());

  brandCanonical.forEach((canonical, key) => {
    const models = [...modelEntries.values()]
      .filter((m) => m.brand.toLowerCase() === key)
      .slice(0, maxModelsPerBrand)
      .map((m) => ({ ...m, sourceIdxs: [...m.sourceIdxs] }));
    if (!isMentioned(canonical)) {
      if (!inAnswer(canonical)) {
        omittedBrands.push({ brand: canonical, sourceIdxs: [...brandSourceIdxs.get(key)], models });
      }
    } else {
      const unmentioned = models.filter((m) => !ansTextLower.includes(m.model.toLowerCase()));
      if (unmentioned.length) omittedModels.push({ brand: canonical, omittedModels: unmentioned });
    }
  });

  // The more sources named it, the more conspicuous its absence.
  omittedBrands.sort((a, b) => b.sourceIdxs.length - a.sourceIdxs.length);
  return { omittedBrands, omittedModels };
}
