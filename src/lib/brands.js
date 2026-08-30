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

/* ---------- 3a. real markdown tables (line-based, not regex-guessed) ---------- */
// Split one row of a markdown table into its cells. GFM allows an optional
// leading/trailing pipe, and "\|" inside a cell doesn't end it — walked by
// hand rather than `line.split("|")` so an escaped pipe in a cell ("Bed \|
// Breakfast") doesn't fracture the row into the wrong number of columns.
export function splitTableRow(line) {
  const cells = [];
  let cur = "";
  let s = String(line || "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

// A GFM separator cell is a run of dashes with optional leading/trailing
// colons ("---", ":---", "---:", ":---:") — this exact shape is what makes
// the row above it a table HEADER, not any line that merely contains a `|`.
// Detecting the separator row is the whole trick: it's a format LLMs never
// produce by accident in prose, so keying off it (rather than counting words
// or checking for bold text) is what makes table detection correct
// regardless of how the model happens to phrase or bold the actual cells.
const SEPARATOR_CELL = /^:?-+:?$/;

// Returns the first-column text of every DATA row (header/separator rows
// excluded) in every real table found in `text`. Previously this signal was
// a single regex hunting for "**bold** text between two pipes" anywhere in
// the answer — which had two real gaps: it required the first-column name to
// be bold (a table where the model didn't bold the product names produced
// zero candidates from that entire table), and it had no concept of a row or
// a table boundary, so it couldn't tell a genuine table apart from any two
// unrelated lines that each happened to contain a pipe character.
export function parseMarkdownTables(text) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes("|")) {
      const headerCells = splitTableRow(lines[i]);
      if (headerCells.length >= 2) {
        const sepCells = splitTableRow(lines[i + 1]);
        if (sepCells.length === headerCells.length && sepCells.every((c) => SEPARATOR_CELL.test(c))) {
          let j = i + 2;
          while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
            const cells = splitTableRow(lines[j]);
            const isRank = /^[\u{1F947}\u{1F948}\u{1F949}\d#\s.-]+$/u.test(cells[0]);
            const target = isRank && cells[1] ? cells[1] : cells[0];
            if (target) out.push(target);
            j++;
          }
          i = j - 1;
          continue;
        }
      }
    }

    // Tab-delimited (TSV) tables
    if (lines[i].includes("\t")) {
      const parts = lines[i].split("\t").map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const isRank = /^[\u{1F947}\u{1F948}\u{1F949}\d#\s.-]+$/u.test(parts[0]);
        const target = isRank && parts[1] ? parts[1] : parts[0];
        if (target && !/^(rank|phone|product|item|model|name|brand|device|header)$/i.test(target)) {
          out.push(target);
        }
      }
    }
  }
  return out;
}

/* ---------- 3b. bold/heading candidates ---------- */
// Cleans one raw candidate string (from either a table cell or a heading)
// into the name detectBrands() should actually consider. Shared so table and
// heading candidates get identical treatment once they're both plain text.
function cleanCandidateText(raw) {
  let s = String(raw || "").replace(/[*_`]/g, "").trim();
  // Strip a leading rank medal/emoji/symbol run ("🥇 Best Overall: iQOO Neo
  // 10", "🥈 Realme GT 7"). Left in place it counts as a "word", which wrecks
  // both the ≤3-word proper-name check and the leading-token vendor fallback.
  s = s.replace(/^[^\w]+/u, "").trim();
  // Headings often carry a trailing qualifier separated by an em-dash/pipe
  // ("Vivo V70 — Best Overall") — keep the part BEFORE it, since the name
  // leads there. An arrow or a colon runs the other way — "condition →
  // recommendation" ("For Valorant/CS2/BGMI → Kreo Harpy") and "label: name"
  // ("Best Overall: iQOO Neo 10") both put the actual name AFTER — keep the
  // part after the LAST arrow/colon.
  if (/\s+[—–|]\s+/.test(s)) s = s.split(/\s+[—–|]\s+/)[0].trim();
  else if (/\s*→\s*/.test(s)) s = s.split(/\s*→\s*/).pop().trim();
  else if (s.includes(":")) s = s.split(":").pop().trim();
  // Strip leading list numbering left over from heading matches ("1. Vivo V70").
  s = s.replace(/^\d+[.)]\s*/, "").trim();
  if (!s || s.endsWith(":") || s.length > 40) return "";
  return s;
}

export function structuralCandidates(answerText) {
  const out = [];
  if (!answerText) return out;

  parseMarkdownTables(answerText).forEach((raw) => {
    const s = cleanCandidateText(raw);
    if (s) out.push({ text: s, source: "table" });
  });

  // Bold text at the START of a line, tolerating any combination of heading
  // hashes, list bullets and numbering.
  const lineLeadBold = /(?:^|\n)[ \t]*#{0,6}[ \t]*(?:\d+[.)][ \t]*)?[-*•]?[ \t]*\*\*([^*\n]{2,40})\*\*/g;
  // Plain (unbolded) headings: "### Zerodha"
  const heading = /(?:^|\n)#{2,6}[ \t]*([^\n#*]{2,60})/g;

  for (const { re, source } of [
    { re: lineLeadBold, source: "heading" },
    { re: heading, source: "section" },
  ]) {
    let m;
    while ((m = re.exec(answerText))) {
      const s = cleanCandidateText(m[1]);
      if (s) out.push({ text: s, source });
    }
  }

  // Paragraph leads (e.g. "POCO F7 delivers...", "Realme P4 Power 5G packs...")
  const paraLead = /(?:^|\n\n)(?:The\s+)?([A-Z][A-Za-z0-9&.\-]+(?:\s+[A-Za-z0-9&.\-]+){1,3})\s+(?:is|delivers|packs|offers|features|combines|stands out|provides|brings|runs|comes)\b/g;
  let pm;
  while ((pm = paraLead.exec(answerText))) {
    const s = cleanCandidateText(pm[1]);
    if (s && !isNoise(s)) out.push({ text: s, source: "heading" });
  }

  return out;
}

/* ---------- 4. cited domains ---------- */
const MARKETPLACE_DOMAINS = new Set([
  "amazon.com", "amazon.in", "amazon.co.uk", "amazon.ae", "amazon.de", "amazon.ca",
  "flipkart.com", "myntra.com", "meesho.com", "snapdeal.com", "shopclues.com",
  "ebay.com", "ebay.in", "walmart.com", "aliexpress.com", "alibaba.com", "etsy.com",
  "jiomart.com", "olx.in", "olx.com", "quikr.com",
  "indiamart.com", "tradeindia.com", "exportersindia.com", "justdial.com",
  "dhgate.com", "made-in-china.com", "wish.com", "rakuten.com",
]);

// Publishers, news outlets, tech portals, aggregators, price comparison sites, and social platforms that
// produce citations or host discussions, NOT product brands being reviewed.
const EDITORIAL_DOMAINS = new Set([
  "digit.in", "gadgets01.com", "91mobiles.com", "gsmarena.com", "techradar.com",
  "theverge.com", "tomsguide.com", "cnet.com", "androidauthority.com", "androidcentral.com",
  "smartprix.com", "mysmartprice.com", "bgr.in", "gadgets360.com", "gizmochina.com",
  "beebom.com", "youtube.com", "etnownews.com", "hindustantimes.com", "indiatoday.in",
  "timesofindia.com", "indianexpress.com", "livemint.com", "moneycontrol.com",
  "reddit.com", "quora.com", "medium.com", "wikipedia.org", "x.com", "twitter.com",
  "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "tiktok.com",
  "cashkr.com", "reviehub.in", "priceoye.pk", "godigit.com", "godigit.in", "winnerwinnerchickendinner.com"
]);

function isMarketplaceDomain(domain) {
  const host = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  for (const d of MARKETPLACE_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  for (const d of EDITORIAL_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  if (/^(blog|news|reviews?|pricing|prices?|compare|deals?|coupon|cashback|wiki|forum|community|support|help|faq|docs)\./i.test(host)) return true;
  return false;
}

// Reporting verbs that mark a name as the SOURCE of a claim rather than its
// SUBJECT: "Gadgets 360 currently lists it around ₹49,850", "91mobiles rated
// it 8.5/10", "according to Smartprix". A review site, publisher or aggregator
// gets cited constantly and is then named in the prose this way — which made
// it indistinguishable from a real brand once cited-domain matching learned to
// span words ("gadgets360" -> "Gadgets 360"). The brands being COMPARED are
// never introduced like this; they're the thing the sentence is about.
//
// This is a closed set of ordinary English reporting verbs, not industry
// vocabulary, so it stays vertical-neutral — and it only ever gates the
// weakest signal (a cited domain). A name that also arrived via an entity
// marker, a product card, a table row or a heading is never touched by it.
// The verb must be what the NAME itself does — at most a couple of adverbs
// may sit between. An earlier version allowed any 40 characters before the
// verb, which read "DLF is the largest listed developer" as an attribution
// because "listed" appeared somewhere downstream: there, "listed" is an
// adjective describing DLF, not DLF reporting something. Verbs that commonly
// double as adjectives or nouns out of this position (found, puts, calls,
// prices) are left out entirely rather than guarded.
const ATTRIB_VERBS =
  "says?|said|reports?|reported|notes?|noted|lists?|listed|rates?|rated|ranks?|ranked|reviews?|reviewed|claims?|writes?|wrote|tested|recommends?|suggests?|estimates?|observes?";
const ATTRIB_AFTER_RE = new RegExp(
  `^[,;:]?\\s*(?:(?:also|now|currently|recently|already|still|further|however)\\s+|\\w+ly\\s+){0,2}(?:${ATTRIB_VERBS})\\b`,
  "i"
);
// Possessive attribution: "Gadgets 360's review put it third".
const ATTRIB_POSSESSIVE_RE = /^['’]s\s+(review|report|test|testing|analysis|round-?up|verdict|listing)\b/i;
const ATTRIB_BEFORE_RE = /\b(according to|per|via|source:?)\s+$/i;

// True when EVERY occurrence of this name reads as an attribution.
function alwaysAttributed(text, hits) {
  if (!hits.length) return false;
  return hits.every((h) => {
    const after = text.slice(h.end, h.end + 60);
    const before = text.slice(Math.max(0, h.start - 20), h.start);
    return ATTRIB_AFTER_RE.test(after) || ATTRIB_POSSESSIVE_RE.test(after) || ATTRIB_BEFORE_RE.test(before);
  });
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
// A single bold word at the start of a line reads exactly like a one-word
// brand ("**Nothing**", "**OnePlus**") — but a spec-sheet-style answer bolds
// its ROW LABELS the same way ("**Battery**: 5000mAh...", "**Charging**:
// 68W..."), and the corroboration check below (a weak candidate needs a
// second, non-heading mention) doesn't catch these: the answer almost always
// refers back to its own spec ("...this large battery lasts all day"),
// which reads as exactly the corroboration a real brand would earn. Reported
// live: Battery, USB, Charging, Display and Common all reached a real
// campaign's competitor list this way. Curated, not "any dictionary word" —
// a real one-word brand ("Sony", "Nothing", "Oppo") must stay eligible.
const GENERIC_SPEC_NOUNS = new Set([
  "battery", "charging", "display", "screen", "camera", "cameras", "storage",
  "memory", "performance", "design", "software", "security", "connectivity",
  "audio", "sound", "speaker", "processor", "chipset", "network", "durability",
  "build", "price", "pricing", "value", "warranty", "specifications", "specs",
  "features", "highlights", "overview", "summary", "verdict", "conclusion",
  "pros", "cons", "comparison", "availability", "usb", "wifi", "bluetooth",
  "gps", "sim", "esim", "resolution", "refresh", "biometrics", "durability",
  "common", "faq", "faqs", "troubleshooting", "notes", "disclaimer", "sources",
]);
export function looksLikeProperName(phrase) {
  const words = String(phrase || "").trim().split(/\s+/);
  if (!words.length || words.length > 3) return false;
  if (/\d/.test(phrase)) return false;
  // A multi-word phrase ending in a category noun is a heading, not a brand.
  if (words.length > 1) {
    const last = words[words.length - 1].replace(/[^\w]/g, "").toLowerCase();
    if (CATEGORY_PLURAL_NOUNS.has(last)) return false;
  } else if (GENERIC_SPEC_NOUNS.has(words[0].replace(/[^\w]/g, "").toLowerCase())) {
    return false;
  }
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
const COMPONENT_CHIPS = new Set([
  "snapdragon", "dimensity", "exynos", "tensor", "helio", "bionic", "cortex", "kryo",
  "mali", "adreno", "geforce", "radeon", "supercomputing", "antutu", "geekbench",
  "qualcomm", "mediatek", "arm", "tsmc", "intel", "amd", "nvidia", "oled", "amoled",
  "retina", "gorilla", "battery", "processor", "chipset", "soc", "display", "camera",
  "refresh", "charging", "cooling", "storage", "durability", "thermal", "performance",
  "ram", "rom", "fps", "hz", "mah", "watt", "approx", "price", "verdict", "final",
  "cooling fan", "active cooling"
]);

function isComponentOrChip(name) {
  if (!name) return true;
  const lower = String(name).trim().toLowerCase();
  const first = lower.split(/\s+/)[0];
  if (COMPONENT_CHIPS.has(first) || COMPONENT_CHIPS.has(lower)) return true;
  if (/^(snapdragon|dimensity|exynos|tensor|helio|qualcomm|mediatek|antutu)\b/i.test(lower)) return true;
  return false;
}

function isEditorialOrReviewDomain(domain) {
  const host = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  if (isMarketplaceDomain(host)) return true;
  for (const d of EDITORIAL_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return true;
  }
  if (/^(blog|news|reviews?|pricing|prices?|compare|deals?|coupon|cashback|wiki|forum|community|support|help|faq|docs)\./i.test(host)) return true;
  return false;
}

export function detectBrands(answerText, plainText, ctx = {}) {
  const text = plainText || answerText || "";
  if (!text) return { brands: [], entities: [] };

  const { entities: markerEntities, productNames } = parseMarkers(answerText || "");
  const candidates = new Map(); // lowerName -> { name, category, description }

  const MAX_LEN = { structural: 40, default: 60, trusted: 120 };
  const addCand = (name, category, description, trust = "default", shownOnly = false, weak = false) => {
    const n = String(name || "").trim().replace(/[*_`]/g, "");
    const cap = MAX_LEN[trust] ?? MAX_LEN.default;
    if (!n || n.length < 2 || n.length > cap) return;
    if (isNoise(n) || isNoise(n.split(/\s+/)[0])) return;
    if (trust !== "trusted" && isComponentOrChip(n)) return;
    const k = n.toLowerCase();
    const prev = candidates.get(k);
    const keepWhole = trust === "trusted";
    if (!prev) candidates.set(k, { name: n, category: category || null, description: description || null, keepWhole, shownOnly, weak });
    else {
      if (keepWhole) prev.keepWhole = true;
      if (shownOnly) prev.shownOnly = true;
      if (!weak) prev.weak = false;
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
    // card carries. A marketplace merchant ("Amazon.in") is excluded the
    // same way a marketplace CITED DOMAIN is below, so "available on
    // Amazon" can't turn the platform into a reported competitor.
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
  // ("Angel One", "Third Wave Coffee"). Otherwise only fall back to its leading
  // token when the phrase carries a model number ("Vivo V70" → "Vivo"), which is
  // the signature of brand+model. A digit-free phrase that isn't a proper name is
  // a category heading ("Contemporary Gold Necklaces") and is dropped. This is
  // the least reliable signal, so it gets the tightest length cap.
  //
  // A table's first column is exempt from that "is dropped" fate: coming from
  // a real parsed table row already means this IS a comparison table's
  // product/brand cell (formatting-based signal, not a words-based guess —
  // see the file header). A 4+-word, digit-free product+model name in that
  // position ("daWg
  // Slay 25" is fine, but "Zebronics Transformer M Plus" has no digit and 4
  // words) used to satisfy neither looksLikeProperName's ≤3-word cap nor the
  // digit-fallback below, and vanish from the brand list entirely despite
  // being right there in row 1 of the table. Table cells always get the
  // vendor-fallback instead of being dropped.
  structuralCandidates(answerText || "").forEach(({ text: s, source }) => {
    // A heading sometimes names two alternatives at once ("Google Sheets / Excel",
    // "GIMP / Photoshop") — treat each side of " / " as its own candidate instead
    // of evaluating the joined phrase as one (wrong) name.
    const parts = / \/ /.test(s) ? s.split(/ \/ /).map((p) => p.trim()).filter(Boolean) : [s];
    for (const part of parts) {
      // Gemini bolds its section headings ("### **For Family Baths: Storage
      // Water Heaters**"), so bold-vs-plain does not separate a name from a
      // section label. Both heading kinds are therefore weak; a table's first
      // column stays strong, since that column IS the subject by construction.
      const weak = source === "section" || source === "heading";
      if (looksLikeProperName(part)) { addCand(part, null, null, "structural", false, weak); continue; }
      const hasDigit = /\d/.test(part);
      // vendorFromProductName only makes sense on a multi-word phrase — it
      // extracts the LEADING token of a longer name ("Vivo V70" → "Vivo"). On
      // a single bare token it just returns that token unchanged, which isn't
      // "vendor extraction" at all — it's accepting the word as-is. That's how
      // a stray slash-separated fragment like "CS2" (from "For Valorant / CS2
      // / BGMI → Kreo Harpy") used to read as a brand: it has a digit, so the
      // digit-fallback fired, but there was nothing to extract a vendor FROM.
      const multiWord = part.trim().split(/\s+/).length > 1;
      if (source === "table" || (hasDigit && multiWord)) {
        addCand(vendorFromProductName(part), null, null, "structural", false, weak);
      }
    }
  });
  // 4. cited domains. A cited source is where an answer got its information —
  // not automatically a brand being evaluated. Horizontal marketplaces and B2B
  // listing directories (Amazon, Flipkart, IndiaMART, eBay…) turn up as sources
  // constantly, in every vertical, simply because they host product listings —
  // and when their name also appears in the prose ("available on Amazon"),
  // domain-derived detection reported the PLATFORM as a mentioned brand
  // alongside the real competitors the answer was actually comparing.
  (ctx.sources || []).forEach((s) => {
    if (isEditorialOrReviewDomain(s.domain)) return;
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

  // Same collapse, for the HYPHENATED form a brand's own domain often takes.
  // A company's site is regularly brand + suffix — boat-lifestyle.com,
  // samsung-india.com, nike-store.com — so brandFromDomain() yields
  // "Boat-lifestyle" while the answer's prose says "boAt". Those are one
  // company, but they were reported as two brands with the mentions split
  // between them, which is exactly the number a share-of-voice tool must not
  // get wrong. Seen live: "boAt x8" and "boat-lifestyle x12" listed as
  // separate brands for the same answer.
  //
  // Keyed on the HYPHEN specifically rather than any prefix match, because a
  // bare prefix test would happily merge unrelated companies that merely
  // start alike ("apple" into "applebees"). A hyphen in a registrable domain
  // label is a real word boundary the registrant chose, so the leading
  // segment matching a brand we already detected is strong evidence, not a
  // coincidence.
  for (const [k, v] of [...candidates]) {
    if (v.keepWhole || v.category !== "cited_domain") continue;
    if (!v.name.includes("-")) continue;
    const headKey = v.name.split("-")[0].toLowerCase();
    if (headKey.length >= 3 && candidates.has(headKey) && headKey !== k) candidates.delete(k);
  }

  // Character offsets that fall on a markdown heading line. A name that only
  // ever occurs inside a heading is labelling that section; a brand the answer
  // is actually about gets written about underneath its own heading.
  const headingSpans = [];
  {
    let at = 0;
    for (const line of text.split("\n")) {
      if (/^\s*#{1,6}\s/.test(line)) headingSpans.push([at, at + line.length]);
      at += line.length + 1;
    }
  }
  const inHeadingLine = (_t, idx) => headingSpans.some(([a, b]) => idx >= a && idx <= b);

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
    // A cited domain whose every mention reads as an attribution is the
    // SOURCE of a claim, not a brand being compared — a review site or
    // aggregator ("Gadgets 360 currently lists it at ₹49,850", "91mobiles
    // rated it 8.5/10"). Drop it rather than report the publisher next to
    // the phones it was writing about. Only the domain signal is gated:
    // anything corroborated by an entity marker, product card, table row or
    // heading has a non-"cited_domain" category and never reaches this.
    if (isDomain && alwaysAttributed(text, hits)) continue;
    // A section heading that is never referred to again in the prose is a
    // section label, not a company. A real brand introduced by a heading gets
    // written about underneath it, so it clears this easily.
    // A name that occurs exactly once, and only on a heading line, is
    // labelling that section ("Storage Water Heaters", "Selection Guidelines",
    // "Next Steps", "Summary & Recommendation" all reached Brand Mentions on
    // real captures). Being written about underneath its own heading clears
    // this, and so does being named twice — a product line the answer heads
    // several sections with ("Ocean Man") is a real detection, not a label.
    if (cand.weak && hits.length < 2 && !hits.some((h) => !inHeadingLine(text, h.start))) continue;
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
