/*
 * brands.js — industry-agnostic brand & entity detection.
 *
 * The tool must work for phones, finance, jewellery, SaaS, travel — anything —
 * WITHOUT the user configuring a word list. So detection never relies on a
 * hardcoded vocabulary. Candidates come from four self-describing signals, in
 * order of trust:
 *
 *   1. ENTITY MARKERS — ChatGPT annotates answers with
 *      <PUA>entity<PUA>["company","Zerodha","Indian stock broker"]<PUA>.
 *      The model has already done the NER, with a category and description, for
 *      whatever industry the answer is about. Highest-confidence source.
 *   2. PRODUCT MARKERS — <PUA>product<PUA>["turn0product1","OnePlus Nord 5",…].
 *      The vendor name is the leading token(s) of the product title.
 *   3. STRUCTURE — names in bold list headers and the first column of markdown
 *      tables. Works on any topic because it keys off formatting, not words.
 *   4. CITED DOMAINS — zerodha.com → "Zerodha". Domains are inherently
 *      industry-agnostic and cover brands the answer cites but doesn't bold.
 *
 * The user's own brand/competitor list (with URLs) is NOT used for detection —
 * only to label what was detected as `own` / `competitor`, so share-of-voice can
 * be reported. Detection stays automatic.
 */

const PUA_OPEN = String.fromCodePoint(0xe200);
const PUA_MID = String.fromCodePoint(0xe202);
const PUA_CLOSE = String.fromCodePoint(0xe201);

export const MARKER_RE = new RegExp(
  PUA_OPEN + "([a-z_]+)" + PUA_MID + "([\\s\\S]*?)" + PUA_CLOSE,
  "g"
);

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Generic stop-words: formatting/adjective noise that shows up as a "name" in
// any vertical. Deliberately contains no industry nouns.
const NOISE = new Set([
  "the", "a", "an", "and", "or", "for", "if", "our", "my", "your", "this", "that",
  "best", "top", "good", "great", "better", "ideal", "overall", "budget", "value",
  "premium", "cheap", "affordable", "recommended", "recommendation", "pick", "picks",
  "choice", "option", "options", "alternative", "alternatives", "note", "key", "why",
  "pros", "cons", "verdict", "summary", "conclusion", "app", "apps", "tool", "tools",
  "platform", "service", "brand", "company", "product", "products", "model", "models",
  "pro", "plus", "max", "ultra", "mini", "lite", "series", "edition", "new", "latest",
  // Discourse/heading words that start prose sections in any language-model answer.
  // These are English connectives, not industry terms, so they stay vertical-neutral.
  "other", "others", "quick", "more", "additional", "extra", "final", "finally",
  "honorable", "notable", "runner", "runners", "bonus", "also", "similar", "related",
  "comparison", "compare", "quickly", "specs", "features", "price", "pricing", "cost",
  "how", "what", "when", "where", "who", "which", "should", "consider", "considerations",
]);

const isNoise = (w) => !w || NOISE.has(w.toLowerCase());

// entity[] markers come in (at least) two shapes:
//   ["company","Zerodha","Indian stock broker"]        — category + name + description
//   ["turn1business1","Manubhai Jewellers - Flagship"]  — a ref id + name (local/business results)
// The first element is a ref id, not a real category, whenever it matches the
// site's turnNkindM id pattern — map the "kind" infix to something readable
// instead of showing the raw id as a category badge.
const ID_KIND_LABELS = {
  business: "Local Business",
  product: "Product",
  search: "Web Source",
  news: "News",
  reddit: "Reddit",
  academia: "Academic",
  shopping: "Shopping",
  image: "Image",
  video: "Video",
  finance: "Finance",
  weather: "Weather",
  sports: "Sports",
};
function categoryFromMarker(first) {
  if (typeof first !== "string" || !first.trim()) return null;
  const idMatch = first.match(/^turn\d+([a-z]+)\d*$/i);
  if (idMatch) return ID_KIND_LABELS[idMatch[1].toLowerCase()] || titleCase(idMatch[1]);
  return titleCase(first.trim());
}

/* ---------- 1 + 2. structured markers the model emits ---------- */
// Returns { entities:[{name,category,description}], productNames:[string] }
export function parseMarkers(answerText) {
  const entities = [];
  const productNames = [];
  if (!answerText) return { entities, productNames };

  const re = new RegExp(MARKER_RE.source, "g");
  let m;
  while ((m = re.exec(answerText))) {
    const kind = m[1];
    const body = m[2];
    let parsed = null;
    try {
      parsed = JSON.parse(body); // usually a JSON array; "products" (bulk) is an object
    } catch (_) {
      /* not parseable — skip */
    }

    // "products" (plural) is a BULK marker distinct from the singular "product"
    // marker: <E200>products<E202>{"selections":[["turn0product3","Samsung Galaxy
    // Watch8"],...]}<E201>. It carries the model's FULL considered product list —
    // often a superset of what's named in bold headings/tables — and, unlike the
    // singular marker, is a JSON OBJECT, not an array.
    if (kind === "products") {
      const selections = parsed && Array.isArray(parsed.selections) ? parsed.selections : [];
      for (const sel of selections) {
        const name = Array.isArray(sel) ? sel.find((v) => typeof v === "string" && !/^turn\d/.test(v)) : null;
        if (name && name.trim()) productNames.push(name.trim());
      }
      continue;
    }

    const arr = parsed;
    if (!Array.isArray(arr)) continue;

    if (kind === "entity") {
      // Either ["category","Name","description"] or ["turn1business1","Name"].
      // Whichever slot holds a real string that ISN'T an id is the name.
      const [first, second, third] = arr;
      const name = typeof second === "string" && second.trim() ? second : typeof first === "string" ? first : null;
      if (typeof name === "string" && name.trim() && name !== first) {
        entities.push({
          name: name.trim(),
          category: categoryFromMarker(first) || "Entity",
          description: typeof third === "string" ? third.trim() : null,
        });
      } else if (typeof first === "string" && first.trim() && !/^turn\d/.test(first)) {
        // Single-element-ish form with no id prefix at all.
        entities.push({ name: first.trim(), category: "Entity", description: null });
      }
    } else if (kind === "product") {
      // ["turn0product1","OnePlus Nord CE6 5G",{...}]
      const name = arr.find((v) => typeof v === "string" && !/^turn\d/.test(v));
      if (name && name.trim()) productNames.push(name.trim());
    }
  }
  return { entities, productNames };
}

/* ---------- 3. structural candidates (bold headers, table rows) ---------- */
export function structuralCandidates(answerText) {
  const out = [];
  if (!answerText) return out;

  // Bold text at the START of a line, tolerating any combination of heading
  // hashes, list bullets and numbering. Covers every layout the models use:
  //   "1. **Zerodha** — ...", "- **Acme Corp**", "### 1. **Vivo V70** — ...",
  //   "## **Groww**"
  const lineLeadBold = /(?:^|\n)[ \t]*#{0,6}[ \t]*(?:\d+[.)][ \t]*)?[-*•]?[ \t]*\*\*([^*\n]{2,40})\*\*/g;
  // Bold at the start of a markdown table cell: "| **Zerodha** | ..."
  const tableCell = /\|\s*\*\*([^*|\n]{2,40})\*\*\s*\|/g;
  // Plain (unbolded) headings: "### Zerodha"
  const heading = /(?:^|\n)#{2,6}[ \t]*([^\n#*]{2,60})/g;

  for (const re of [lineLeadBold, tableCell, heading]) {
    let m;
    while ((m = re.exec(answerText))) {
      let raw = m[1].replace(/[*_`]/g, "").trim();
      // Strip a leading rank medal/emoji/symbol run ("🥇 Best Overall: iQOO Neo
      // 10", "🥈 Realme GT 7"). Left in place it counts as a "word", which wrecks
      // both the ≤3-word proper-name check and the leading-token vendor fallback.
      raw = raw.replace(/^[^\w]+/u, "").trim();
      // Headings often carry a trailing qualifier separated by an em-dash/pipe
      // ("Vivo V70 — Best Overall") — keep the part BEFORE it. A colon usually
      // runs the other way ("Best Overall: iQOO Neo 10") — keep the part AFTER
      // the LAST colon, since that's where the actual name sits.
      if (/\s+[—–|]\s+/.test(raw)) raw = raw.split(/\s+[—–|]\s+/)[0].trim();
      else if (raw.includes(":")) raw = raw.split(":").pop().trim();
      // Strip leading list numbering left over from heading matches ("1. Vivo V70").
      raw = raw.replace(/^\d+[.)]\s*/, "").trim();
      if (!raw || raw.endsWith(":")) continue;
      if (raw.length > 40) continue;
      out.push(raw);
    }
  }
  return out;
}

/* ---------- 4. cited domains ---------- */
// Pure horizontal marketplaces and B2B listing directories: platforms that
// host OTHER companies' products/listings across every vertical, rather than
// making anything themselves. A source citing amazon.in or dir.indiamart.com
// is telling you where the answer's information came from, not naming a
// brand being evaluated — so these never become brand candidates no matter
// how their name is written in the prose. Deliberately narrow and global:
// each entry is unambiguous in EVERY industry, unlike a vertical-specific
// retailer (Croma, Reliance Digital, Nykaa) which this project keeps out of
// the core detector on purpose — see ui/panel.js's Search Funnel vocabulary.
const MARKETPLACE_DOMAINS = new Set([
  "amazon.com", "amazon.in", "amazon.co.uk", "amazon.ae", "amazon.de", "amazon.ca",
  "flipkart.com", "myntra.com", "meesho.com", "snapdeal.com", "shopclues.com",
  "ebay.com", "ebay.in", "walmart.com", "aliexpress.com", "alibaba.com", "etsy.com",
  "jiomart.com", "olx.in", "olx.com", "quikr.com",
  "indiamart.com", "tradeindia.com", "exportersindia.com", "justdial.com",
  "dhgate.com", "made-in-china.com", "wish.com", "rakuten.com",
]);

function isMarketplaceDomain(domain) {
  const host = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  for (const d of MARKETPLACE_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

// Same platforms as MARKETPLACE_DOMAINS, matched by bare name instead of
// hostname — for the merchant FIELD on a product card, which is a plain
// string ("Amazon.in", "PNG Jewellers", "Mia by Tanishq"), not a URL. Only
// the leading word is checked, since that's what identifies the seller.
const MARKETPLACE_NAME_RE =
  /^(amazon|flipkart|myntra|meesho|snapdeal|shopclues|ebay|walmart|aliexpress|alibaba|etsy|jiomart|olx|quikr|indiamart|tradeindia|exportersindia|justdial|dhgate|wish|rakuten)\b/i;
function isMarketplaceName(name) {
  return MARKETPLACE_NAME_RE.test(String(name || "").trim());
}

// Second-level registry labels that are never themselves the brand:
// "example.co.uk", "woolworths.com.au", "dbs.com.sg", "toyota.co.jp".
// Everything NOT in this set is treated as a public suffix, so the label
// immediately before it is the registrable name. That way the list stays
// tiny and closed, instead of needing an entry for every TLD that exists.
const SLD_REGISTRY = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "gc"]);

// zerodha.com → "Zerodha"; gadgets.beebom.com → "Beebom"; siemens.de → "Siemens".
//
// This used to work off an allow-list of suffixes to skip, which failed two ways
// in production: any ccTLD not on the list ("siemens.de", "loreal.fr",
// "nestle.ch") returned null and lost the brand entirely, and any modern generic
// TLD not on the list became the "brand" itself — "cred.club" reported a company
// called "Club", "acme.store" → "Store", "props.realty" → "Realty". Keying off a
// closed set of second-level REGISTRY labels instead is correct for both.
export function brandFromDomain(domain) {
  if (!domain) return null;
  const host = String(domain).trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null; // a bare host with no dot has no registrable label
  let i = parts.length - 2;
  if (i > 0 && SLD_REGISTRY.has(parts[i])) i -= 1;
  const label = parts[i];
  if (!label || label.length < 3 || /^\d+$/.test(label)) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Find where a compressed domain label appears in prose as separate words.
//
// Domain labels squash a brand's words together — "hdfcbank.com" for a company
// written "HDFC Bank", "ultratechcement.com" for "UltraTech Cement",
// "siemens-healthineers.com" for "Siemens Healthineers". Matching the label
// verbatim with \bhdfcbank\b therefore never fires, so on platforms with no
// entity markers (Gemini) whole industries — lending, cement, healthcare, real
// estate — detected ZERO brands despite citing those companies' own sites.
//
// Scanning word runs and comparing their letters-and-digits concatenation is
// exact (no fuzzy matching, so no false positives) and carries no vocabulary,
// so it stays industry- and language-neutral. Returns the real spans, letting
// the caller display the brand the way the answer actually writes it ("HDFC
// Bank", "PhonePe") rather than the mangled "Hdfcbank" / "Phonepe".
const MAX_LABEL_WORDS = 4;
export function matchCompressedLabel(text, label) {
  const target = String(label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (target.length < 3 || !text) return [];
  const tokens = [...String(text).matchAll(/[A-Za-z0-9&]+/g)].map((m) => ({
    w: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!target.startsWith(tokens[i].w)) continue; // cheap reject
    let acc = "";
    for (let j = i; j < tokens.length && j - i < MAX_LABEL_WORDS; j++) {
      acc += tokens[j].w;
      if (acc.length > target.length || !target.startsWith(acc)) break;
      if (acc === target) {
        out.push({ start: tokens[i].start, end: tokens[j].end });
        i = j; // don't start another run inside this match
        break;
      }
    }
  }
  return out;
}

/* ---------- name shaping ---------- */
// The vendor is the leading token of a product title:
//   "OnePlus Nord CE6 5G" → "OnePlus";  "Samsung Galaxy S25" → "Samsung".
// Multi-word brands ("Angel One") arrive via entity markers, which keep their
// full name, so taking one token here doesn't lose them.
export function vendorFromProductName(title) {
  const first = String(title || "").trim().split(/\s+/)[0] || "";
  const clean = first.replace(/[^\w&.\-]/g, "");
  if (!clean || !/^[A-Za-z]/.test(clean) || isNoise(clean)) return "";
  return clean;
}

// A phrase that reads like a proper name ("Angel One", "Blue Tokai") rather than
// prose ("Other great choices"). Brand names are title-cased; sentence fragments
// have lowercase words after the first. Digits usually mean it's a model/product.
// A curated set of common product/category nouns that signal "this heading is a
// CATEGORY, not a brand" when they're the last word ("Contemporary Gold
// Necklaces", "Chunky Statement Rings"). Deliberately NOT "any word ending in
// s" — that blanket rule rejected real company names like "BudgetBakers",
// "Motors", "Brothers", which happen to end in s too.
const CATEGORY_PLURAL_NOUNS = new Set([
  "necklaces", "rings", "bracelets", "earrings", "pendants", "bangles", "chains",
  "watches", "phones", "smartphones", "laptops", "tablets", "cameras", "tvs",
  "speakers", "headphones", "earbuds", "shoes", "sneakers", "bags", "wallets",
  "options", "picks", "choices", "alternatives", "recommendations", "products",
  "accessories", "gadgets", "apps", "platforms", "tools", "services", "stores",
  "brands", "perfumes", "fragrances", "colognes", "necklaces", "sarees", "kurtas",
  "jewellers", "jewelers", "shops", "restaurants", "cafes", "hotels",
]);
// True when a phrase's LAST word marks it as a category rather than a brand
// ("Contemporary Gold Necklaces", "Chunky Statement Rings"). Split out of
// looksLikeProperName so the structural-candidate fallback below can run the
// same check on phrases too long to be a whole proper name.
function endsInCategoryNoun(phrase) {
  const words = String(phrase || "").trim().split(/\s+/);
  if (words.length < 2) return false;
  const last = words[words.length - 1].replace(/[^\w]/g, "").toLowerCase();
  return CATEGORY_PLURAL_NOUNS.has(last);
}

// Whether the words AFTER the first one still read as a name rather than
// prose — "Britannia The Original Bourbon" (The/Original/Bourbon all
// capitalized) vs "Camera quality (day & night)" (quality/day/night all
// lowercase, an aspect heading, not a brand). Word 0 is deliberately not
// checked here: a stylized brand like "iQOO" doesn't start with an
// uppercase letter, so requiring it too would reject the very brand names
// this exists to catch. Used by the long-phrase structural fallback below,
// which can't apply looksLikeProperName's word-0 test or its ≤3-word cap.
function restReadsAsName(phrase) {
  const words = String(phrase || "").trim().split(/\s+/);
  const CONNECTORS = new Set(["of", "and", "&", "for", "de", "la", "by", "the"]);
  return words.slice(1).every((w) => {
    const c = w.replace(/[^\w&]/g, "");
    if (!c) return true; // pure punctuation token ("(day" stripped to "day" elsewhere; guard anyway)
    if (CONNECTORS.has(c.toLowerCase())) return true;
    return /^[A-Z0-9]/.test(c);
  });
}

export function looksLikeProperName(phrase) {
  const words = String(phrase || "").trim().split(/\s+/);
  if (!words.length || words.length > 3) return false;
  if (/\d/.test(phrase)) return false;
  if (endsInCategoryNoun(phrase)) return false;
  const CONNECTORS = new Set(["of", "and", "&", "for", "de", "la", "by"]);
  return words.every((w, i) => {
    const c = w.replace(/[^\w&]/g, "");
    if (!c) return false;
    if (i > 0 && CONNECTORS.has(c.toLowerCase())) return true;
    return /^[A-Z0-9]/.test(c);
  });
}

/* ---------- main entry ---------- */
/**
 * Detect brands automatically and count real prose mentions.
 * @param {string} answerText   reconstructed answer (may contain PUA markers)
 * @param {string} plainText    same text with markers stripped (for counting)
 * @param {object} ctx          { products, sources, tracked }
 *   tracked: [{ name, url, relation:"own"|"competitor" }] — labels only.
 */
export function detectBrands(answerText, plainText, ctx = {}) {
  const text = plainText || answerText || "";
  if (!text) return { brands: [], entities: [] };

  const { entities: markerEntities, productNames } = parseMarkers(answerText || "");
  const candidates = new Map(); // lowerName -> { name, category, description }
  // The length cap guards against freeform text (a bold sentence, a table cell)
  // being mistaken for a name. Sources the model has ALREADY identified as a
  // named entity — entity markers and local-business listings — are exempt from
  // the tight cap, because business names legitimately run long with location
  // qualifiers ("Malabar Gold and Diamonds - Andheri West - Mumbai" is 51 chars).
  const MAX_LEN = { structural: 40, default: 60, trusted: 120 };
  const addCand = (name, category, description, trust = "default", shownOnly = false) => {
    const n = String(name || "").trim().replace(/[*_`]/g, "");
    const cap = MAX_LEN[trust] ?? MAX_LEN.default;
    if (!n || n.length < 2 || n.length > cap) return;
    if (isNoise(n) || isNoise(n.split(/\s+/)[0])) return;
    const k = n.toLowerCase();
    const prev = candidates.get(k);
    // "trusted" candidates (entity markers, place listings) came from structured
    // data that already asserts this IS one name — never split them into their
    // head word later, however many words they run.
    const keepWhole = trust === "trusted";
    if (!prev) candidates.set(k, { name: n, category: category || null, description: description || null, keepWhole, shownOnly });
    else {
      if (keepWhole) prev.keepWhole = true;
      if (shownOnly) prev.shownOnly = true;
      if (!prev.category && category) {
        prev.category = category;
        prev.description = prev.description || description || null;
      }
    }
  };

  // 1. model-annotated entities (best signal, any industry — trusted, long names OK)
  markerEntities.forEach((e) => addCand(e.name, e.category, e.description, "trusted", true));
  // 2. product vendors. Prefer the explicit brand/merchant field when the payload
  // has one — in many verticals the product NAME doesn't start with the brand
  // ("Modern Radiance Gold Necklace" by Tanishq), so the leading token would be a
  // descriptor. Only fall back to the name's head when no brand is given.
  // `shownOnly=true`: these came from a product card ChatGPT rendered (including
  // the bulk "products{selections}" carousel marker, which we strip from the
  // visible text for readability) — that IS a real citation event even when the
  // model never narrates the product's name in prose. Without this flag such
  // products silently vanish (0 text hits → dropped) despite being shown to the user.
  productNames.forEach((p) => addCand(vendorFromProductName(p), "product_vendor", null, "default", true));
  (ctx.products || []).forEach((p) => {
    // shownOnly only for the product's actual BRAND (manufacturer) — a
    // marketplace that merely sells it (Amazon, Flipkart) isn't the brand
    // being evaluated, and giving it the same 0-count fallback would clutter
    // Brand Mentions with the platform instead of the maker.
    //
    // When `brand` is empty the `merchant` field is still checked, but ONLY
    // when it isn't itself a marketplace — most merchants in real payloads
    // are legitimate, specific sellers ("PNG Jewellers", "Mia by Tanishq",
    // "Quirksmith") that are frequently the ONLY brand signal a product
    // card carries, and skipping them entirely regressed to a strictly
    // worse guess (the product title's leading adjective — "Modern Gold
    // Drape Bar Necklace" as a product with no brand field produced the
    // fake brand "Modern" once the merchant fallback was removed outright).
    // A marketplace merchant ("Amazon.in") is excluded the same way a
    // marketplace CITED DOMAIN is below, so "available on Amazon" can't
    // turn the platform into a reported competitor.
    if (p.brand) addCand(p.brand, "product_vendor", null, "default", true);
    else if (p.merchant && !isMarketplaceName(p.merchant)) {
      addCand(String(p.merchant).split(/[+,]/)[0].trim(), "product_vendor");
    } else {
      addCand(vendorFromProductName(p.name), "product_vendor", null, "default", true);
    }
  });
  // Local/place answers: the businesses themselves are the brands (structured
  // listing data, not a text guess — trusted, long names OK, and "shown" by definition).
  (ctx.places || []).forEach((pl) => addCand(pl.name, "place", null, "trusted", true));
  // 3. structure. Keep a phrase whole when it reads like a proper name
  // ("Angel One", "Third Wave Coffee"). Otherwise fall back to its leading
  // token — the signature of brand+product, whether that's a model number
  // ("Vivo V70" → "Vivo") or a longer product line with no digit at all
  // ("Britannia The Original Bourbon" → "Britannia", "Sunfeast Dark Fantasy
  // Bourbon" → "Sunfeast"). The digit check used to gate this fallback
  // entirely, so any 4-plus-word bold heading with no digit — a completely
  // ordinary shape for a table of brand names — was silently dropped: the
  // exact failure that took Britannia and Sunfeast out of Brand Mentions on
  // a real capture while lower-billed competitors it happened to name in
  // 2-3 words survived. A digit-free phrase that isn't a proper name is
  // still dropped when it reads as a CATEGORY ("Contemporary Gold
  // Necklaces") rather than a brand+product line — same rule
  // looksLikeProperName uses for short phrases, reused here so long ones
  // get it too. This is the least reliable signal, so it gets the tightest
  // length cap (enforced by structuralCandidates itself, 40 chars).
  structuralCandidates(answerText || "").forEach((s) => {
    // A heading sometimes names two alternatives at once ("Google Sheets / Excel",
    // "GIMP / Photoshop") — treat each side of " / " as its own candidate instead
    // of evaluating the joined phrase as one (wrong) name.
    const parts = / \/ /.test(s) ? s.split(/ \/ /).map((p) => p.trim()).filter(Boolean) : [s];
    for (const part of parts) {
      if (looksLikeProperName(part)) { addCand(part, null, null, "structural"); continue; }
      // Long-phrase fallback needs BOTH: not a category heading, and every
      // word past the first still reads as part of a name. Category alone
      // isn't enough — "Camera quality (day & night)" and "diamond bridal
      // jewellery" end in no listed category noun at all, they're just
      // ordinary prose, which restReadsAsName is what actually catches.
      if (!endsInCategoryNoun(part) && restReadsAsName(part)) {
        addCand(vendorFromProductName(part), null, null, "structural");
      }
    }
  });
  // 4. cited domains. A cited source is where an answer got its information —
  // not automatically a brand being evaluated. Horizontal marketplaces and B2B
  // listing directories (Amazon, Flipkart, IndiaMART, eBay…) turn up as sources
  // constantly, in every vertical, simply because they host product listings —
  // and when their name also appears in the prose ("available on Amazon"),
  // domain-derived detection reported the PLATFORM as a mentioned brand
  // alongside the real competitors the answer was actually comparing. Unlike
  // the vertical-specific retailer lists this project has deliberately avoided
  // elsewhere (Croma, Reliance Digital — see ui/panel.js), these are pure
  // horizontal platforms with no manufactured product of their own in ANY
  // industry, so excluding them by domain is a structural fact, not an
  // industry-specific guess.
  (ctx.sources || []).forEach((s) => {
    if (isMarketplaceDomain(s.domain)) return;
    addCand(brandFromDomain(s.domain), "cited_domain");
  });
  // The user's tracked brands are added as candidates too so their share of voice
  // is reported even at zero — but they are NOT what makes detection work. The
  // user typed this exact name, so trust it whole regardless of word count.
  (ctx.tracked || []).forEach((t) => addCand(t.name, "tracked", null, "trusted"));

  // Collapse a multi-word candidate into its head when the head is itself a
  // candidate: "Google Pixel" + "Google" would otherwise be reported as two
  // separate brands (plus "Pixel"), splitting one brand's share of voice. Never
  // collapse a `keepWhole` candidate — those came from structured data
  // (entity markers, place listings, the user's own list) that already asserts
  // this IS one name, e.g. "Angel One" must not become "Angel".
  for (const [k, v] of [...candidates]) {
    if (v.keepWhole) continue;
    const words = v.name.split(/\s+/);
    if (words.length < 2) continue;
    const headKey = words[0].toLowerCase();
    if (candidates.has(headKey) && headKey !== k) candidates.delete(k);
  }

  // Count mentions in the plain text, longest-first so "Angel One" wins over
  // "Angel" and a name isn't double-counted inside a longer one.
  const ordered = [...candidates.values()].sort((a, b) => b.name.length - a.name.length);
  const claimed = [];
  const results = [];
  for (const cand of ordered) {
    // A domain-derived candidate is a squashed label ("hdfcbank"), so it is
    // matched against word runs rather than verbatim — see matchCompressedLabel.
    const isDomain = cand.category === "cited_domain";
    const hits = isDomain
      ? matchCompressedLabel(text, cand.name).filter(
          (h) => !claimed.some(([cs, ce]) => h.start >= cs && h.end <= ce)
        )
      : [...text.matchAll(new RegExp(`\\b${escapeRegExp(cand.name)}\\b`, "gi"))]
          .map((m) => ({ start: m.index, end: m.index + cand.name.length }))
          .filter((h) => !claimed.some(([cs, ce]) => h.start >= cs && h.end <= ce));
    // Prefer how the answer itself writes the name ("HDFC Bank", "PhonePe")
    // over the mangled title-cased domain label ("Hdfcbank", "Phonepe").
    const displayName = isDomain && hits.length
      ? text.slice(hits[0].start, hits[0].end).replace(/\s+/g, " ").trim()
      : cand.name;
    if (!hits.length) {
      // `shownOnly` candidates (product cards, place listings) are real citation
      // events even when the model's PROSE never names them — e.g. a 6-item
      // product carousel where only 4 get narrated. Report them with count=0 and
      // an honest passage instead of silently dropping them, which is what made
      // them look "missing" before this existed.
      if (cand.shownOnly) {
        results.push({
          brand: cand.name,
          count: 0,
          firstIndex: Number.MAX_SAFE_INTEGER, // sort after narrated brands
          category: cand.category,
          description: cand.description,
          passages: ["Shown in results but not directly named in the written answer."],
        });
      }
      continue;
    }
    hits.forEach((h) => claimed.push([h.start, h.end]));
    const first = hits[0].start;
    results.push({
      brand: displayName,
      count: hits.length,
      firstIndex: first,
      category: cand.category,
      description: cand.description,
      passages: [text.slice(Math.max(0, first - 110), first + 110).replace(/\s+/g, " ").trim()],
    });
  }

  // Renaming a domain candidate to how the answer writes it can collide with a
  // candidate that already had that exact name (e.g. structure found "HDFC Bank"
  // and hdfcbank.com resolved to the same words). Merge rather than report the
  // same company twice with a split share of voice.
  const merged = new Map();
  for (const r of results) {
    const k = r.brand.toLowerCase();
    const prev = merged.get(k);
    if (!prev) { merged.set(k, r); continue; }
    prev.count += r.count;
    prev.firstIndex = Math.min(prev.firstIndex, r.firstIndex);
    prev.category = prev.category || r.category;
    prev.description = prev.description || r.description;
    for (const p of r.passages) if (!prev.passages.includes(p)) prev.passages.push(p);
  }
  results.length = 0;
  results.push(...merged.values());

  // Label against the user's tracked list (own / competitor) — presentation only.
  const tracked = (ctx.tracked || []).map((t) => ({
    ...t,
    key: String(t.name || "").trim().toLowerCase(),
    host: hostOf(t.url),
  }));
  results.forEach((r) => {
    const t = tracked.find((x) => x.key && x.key === r.brand.toLowerCase());
    r.relation = t ? t.relation : null;
  });

  results.sort((a, b) => a.firstIndex - b.firstIndex);

  // Entities returned for display: model-provided ones keep their real category.
  const entities = [];
  const seenE = new Set();
  const pushE = (text2, category) => {
    const k = (category || "") + "|" + String(text2).toLowerCase();
    if (text2 && !seenE.has(k)) {
      seenE.add(k);
      entities.push({ text: text2, category });
    }
  };
  markerEntities.forEach((e) => pushE(e.name, titleCase(e.category)));
  (ctx.products || []).forEach((p) => {
    pushE(p.name, "Product");
    if (p.merchant) pushE(p.merchant, "Retailer");
  });
  results.filter((r) => !r.category || r.category === "cited_domain").forEach((r) => pushE(r.brand, "Brand"));

  return { brands: results, entities };
}

export function hostOf(url) {
  if (!url) return null;
  try {
    const u = String(url).match(/^https?:\/\//i) ? String(url) : "https://" + url;
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch (_) {
    return null;
  }
}

function titleCase(s) {
  return String(s || "entity")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
