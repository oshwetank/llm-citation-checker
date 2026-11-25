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
import { wordRe } from "./textMatch.js";

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
  // AI Mode's bullet labels (1.0.5): "**User Sentiment:**", "**Rating:**".
  "user", "sentiment", "rating", "ratings",
  // A chooser's field labels and how a product is made, not who makes it
  // (1.0.6, ChatGPT's gift-pen answer: "**Occasion**", "Personalised Parker
  // Jotter" read as brands).
  "occasion", "recipient", "gender", "age", "colour", "color", "size", "material",
  "quantity", "purpose", "preference", "preferences", "personalised", "personalized",
  "customised", "customized", "custom", "engraved", "monogrammed", "handmade",
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
  // Verbs and fillers that open a bullet or a bold lead ("**Buy the OnePlus
  // …**", "**Choose the realme …**", "**ANC:** Up to 55dB"); reported as
  // brands in a ChatGPT answer (0.62.1).
  "buy", "choose", "save", "get", "go", "skip", "avoid", "opt", "prefer", "stretch",
  // Labels of ChatGPT's follow-up question form ("**3. Preferred area**",
  // 16 Nov 2026) and the card bullets' opening adjectives.
  "preferred", "preference", "excellent", "strong", "useful", "powerful", "consistent",
  "spend", "pay", "look", "check", "try", "use", "want", "need", "up", "to", "with",
  "without", "under", "around", "about", "only", "both", "either", "here", "there",
  "then", "yes", "no", "not", "it", "its", "they", "you", "we",
  // Honorifics (1.0.2): "Dr. Sanket Sheth is an MDS Endodontist" made "Dr" a
  // brand in a dental-clinic answer (live run, 22 Nov 2026).
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr",
  // Live run of 23 Nov 2026 (530 CRM and running-shoe questions): the kind
  // of software asked about, written as an acronym ("CRM" was a brand in 38
  // answers); sentence openers and the word after a bold label ("However",
  // "Widely", "Popular"); and plan tiers ("**Basic**, **Professional**").
  "crm", "crms", "erp", "ats", "cms", "lms", "hrms", "saas",
  "however", "moreover", "additionally", "alternatively", "overall", "ultimately", "meanwhile",
  "widely", "popular", "traditional", "hybrid",
  "basic", "starter", "professional", "enterprise", "essentials", "ultimate",
  // Labels a "**Word:**" bullet opens with.
  "watch-out", "watch-outs", "watchout", "watchouts", "strengths", "weaknesses", "trade-off", "trade-offs",
  "tradeoff", "tradeoffs", "important", "caveat", "caveats", "limitations", "drawbacks", "downsides", "upsides",
  // Price bands in cost tables (stress run): "Standard", "Economy", "Estimated".
  "standard", "economy", "estimated", "approximate", "luxury", "mid-range", "midrange", "high-end",
]);

// Spec terms that read like names in a table cell or after a bullet label:
// ratings (IP55, IPX4), feature acronyms (AI, ANC, ENC), "Dual-driver"-style
// counts. Shapes, not industry nouns, so they hold for any vertical.
const SPEC_TOKEN = /^(?:ip[x\d]\d|ipx|ai|anc|enc|enx|tws|usb|bt|nfc|hdr|oled|amoled|lcd|led|[2-6]g|wi-?fi|(?:single|dual|triple|quad|multi|hybrid)-[a-z]+)$/i;

// A contraction or possessive of a noise word is noise too (1.0.0): "What's"
// (a follow-up question's label) and "Here's" reached a brand list.
const isNoise = (w) => !w || NOISE.has(w.toLowerCase()) || NOISE.has(w.toLowerCase().replace(/['’](?:s|re|ll|d|ve)$/, "")) || SPEC_TOKEN.test(w);

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

// A header cell that says, in so many words, "this column IS the name" —
// checked before falling back to position. Reported: a table led with a
// USE-CASE column ("Best For: Optical Zoom / Versatile Triple Camera / …")
// and put the real product name in column 2 ("Phone: Nothing Phone (3a)
// Pro"). Column 0 isn't a rank cell there (it's prose, not a bare number),
// so the old rank-or-first-column rule confidently picked the wrong column
// on every row, and the real names never got a candidate at all. The header
// row already names its own contents in the vast majority of tables an LLM
// generates (across verticals: "Product", "Broker", "Fund" all show up, but
// "Phone"/"Product"/"Model"/"Item"/"Device"/"Name"/"Brand"/"Pick" alone
// already cover most comparison tables regardless of topic) — a much
// stronger signal than guessing from position when it's present, and
// harmless when it isn't (falls straight back to the old rule below).
const NAME_HEADER_RE = /^(phones?|products?|items?|models?|devices?|names?|brands?|picks?|winners?|recommendations?|options?|choices?|hotels?|hostels?|resorts?|homestays?|stays?|propert(?:y|ies)|accommodations?|lodg(?:e|es|ings?)|places?|restaurants?|cafes?|venues?|stores?|shops?|showrooms?|dealers?|sellers?|retailers?|merchants?|compan(?:y|ies)|providers?|vendors?|apps?|tools?|services?|platforms?|software|schools?|colleges?|universit(?:y|ies)|institutes?|courses?|clinics?|hospitals?|doctors?|banks?|cards?|brokers?|funds?|insurers?|plans?|policies|cars?|bikes?|scooters?|laptops?|airlines?|operators?|agenc(?:y|ies)|websites?|sites?|lenders?|institutions?|programs?|programmes?|insurance companies|product lines?)$/i;
const cleanHeaderCell = (s) => String(s || "").replace(/[*_`]/g, "").trim();
// "Hotel / Stay", "Hotel name", "Property (area)": the header names its
// column when any one of its words does.
const headerNamesColumn = (h) => {
  const c = cleanHeaderCell(h).replace(/\([^)]*\)/g, " ");
  if (NAME_HEADER_RE.test(c)) return true;
  return c.split(/\s*(?:\/|&|\bor\b|,)\s*|\s+name\b/i).map((x) => x.trim()).filter(Boolean).some((x) => NAME_HEADER_RE.test(x));
};
// Columns that are about something else (where, how much, why). Reported on
// a hotel table: with no header the code knew, the AREA column (the town's
// neighbourhoods and its main road) won the prose vote over the hotel names
// and every neighbourhood was reported as a brand. Such a column is never the names.
const NOT_NAME_HEADER_RE = /\b(areas?|locations?|localit(?:y|ies)|neighbou?rhoods?|address(?:es)?|cit(?:y|ies)|regions?|distance|near|price|prices|pricing|rates?|cost|costs|fees?|tariff|budget|ratings?|reviews?|stars?|why|reason|notes?|highlights?|amenities|features?|pros|cons|best for|good for|ideal for|verdict|type|kind|category|specs?|size|duration|timings?|hours|contact|phone|website|link|book(?:ing)?|nutrients?|nutrition|ingredients?|factors?|criteria|criterion|aspects?|parameters?|metrics?|attributes?|tips?|steps?|benefits?|risks?|signs?|symptoms?|uses?|purpose|goals?|what to)\b/i;

// A table cell's name: ChatGPT writes some names as entity markers
// (entity["turn0business4","Hotel Pinecrest"]), whose name is what the
// prose repeats.
function cellName(cell) {
  const m = String(cell || "").match(/\u{E200}entity\u{E202}\[\s*"[^"]*"\s*,\s*"([^"]+)"/u);
  return cleanHeaderCell(m ? m[1] : cell);
}

// Returns the first-column text of every DATA row (header/separator rows
// excluded) in every real table found in `text`. Previously this signal was
// a single regex hunting for "**bold** text between two pipes" anywhere in
// the answer — which had two real gaps: it required the first-column name to
// be bold (a table where the model didn't bold the product names produced
// zero candidates from that entire table), and it had no concept of a row or
// a table boundary, so it couldn't tell a genuine table apart from any two
// unrelated lines that each happened to contain a pipe character.
export function parseMarkdownTables(text) {
  return parseTableCells(text).map((c) => c.text);
}

// The same walk, keeping WHY each cell was chosen. A cell from a column the
// table's own header named ("Phone", "Product") is the subject by
// construction; a cell picked by POSITION is only a guess, and on a
// use-case-led table that guess lands on a descriptor ("Optical Zoom").
// detectBrands holds the two to different standards — see namedInProse.
function parseTableCells(text) {
  const out = [];
  if (!text) return out;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes("|")) {
      const headerCells = splitTableRow(lines[i]);
      if (headerCells.length >= 2) {
        const sepCells = splitTableRow(lines[i + 1]);
        if (sepCells.length === headerCells.length && sepCells.every((c) => SEPARATOR_CELL.test(c))) {
          // Which column holds the names? The header is the best answer when
          // it says so. Failing that, ask the ANSWER: the column whose cells
          // the prose goes on to write as names is the subject column, and a
          // use-case or spec column never is. Only when neither the header nor
          // the prose settles it does position decide, exactly as before.
          const rows = [];
          for (let k = i + 2; k < lines.length && lines[k].trim() && lines[k].includes("|"); k++) {
            rows.push(splitTableRow(lines[k]));
          }
          let nameColIdx = headerCells.findIndex((h) => headerNamesColumn(h));
          if (nameColIdx === -1) {
            let bestScore = 0;
            for (let c = 0; c < headerCells.length; c++) {
              if (NOT_NAME_HEADER_RE.test(cleanHeaderCell(headerCells[c]))) continue;
              let score = 0;
              for (const cells of rows) {
                const cell = cellName(cells[c] || "");
                if (cell && namedInProse(text, cell)) score++;
              }
              if (score > bestScore) { bestScore = score; nameColIdx = c; }
            }
          }
          // 1.0.0: a "Nutrient (per 100g) | What to aim for" table led to
          // Sugar, Sodium and Ingredients as brands: with no name column, the
          // position rule took column 0 anyway. When the header itself says
          // column 0 is a property, the table names nothing.
          const skipTable = nameColIdx === -1 && NOT_NAME_HEADER_RE.test(cleanHeaderCell(headerCells[0]));
          let j = i + 2;
          while (!skipTable && j < lines.length && lines[j].trim() && lines[j].includes("|")) {
            const cells = splitTableRow(lines[j]);
            let target;
            if (nameColIdx !== -1 && cells[nameColIdx]) {
              target = cells[nameColIdx];
            } else {
              const isRank = /^[\u{1F947}\u{1F948}\u{1F949}\d#\s.-]+$/u.test(cells[0]);
              target = isRank && cells[1] ? cells[1] : cells[0];
            }
            if (target) out.push({ text: target, headed: true });
            j++;
          }
          if (skipTable) while (j < lines.length && lines[j].trim() && lines[j].includes("|")) j++;
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
          out.push({ text: target, headed: false });
        }
      }
    }
  }
  return out;
}

/* A describing word in front of the maker's name ("Personalised Parker
 * Jotter", "Engraved Cross Bailey") is how the product is made, not who
 * makes it: dropped, so the name starts at the maker (1.0.6). */
const LEAD_DESCRIPTOR = /^(?:personali[sz]ed|customi[sz]ed|custom(?:-made)?|engraved|monogrammed|handmade|hand-made|luxury|genuine|authentic|original)\s+(?=[A-Z0-9])/i;
export function dropLeadDescriptor(name) {
  const s = String(name || "").trim();
  const t = s.replace(LEAD_DESCRIPTOR, "");
  return t && t !== s ? t : s;
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
  // Unless the part before is the label ("Best for Variety & Families —
  // HelloFresh:", Gemini, live run of 22 Nov 2026): then the name is after.
  if (/\s+[—–|]\s+/.test(s)) {
    const parts = s.split(/\s+[—–|]\s+/);
    s = (/^(?:best|top|most|ideal|great|good|our|my|budget|premium|cheapest|runner|honou?rable|pick|choice|editor|winner|overall|for)\b/i.test(parts[0]) && parts.length > 1
      ? parts[parts.length - 1] : parts[0]).replace(/:\s*$/, "").trim();
    // A dash inside brackets: "Streak (Free Plan — Gmail)" left "Streak
    // (Free Plan" (1.0.7). The unclosed bracket goes.
    s = s.replace(/\s*\([^)]*$/, "").trim();
  }
  else if (/\s*→\s*/.test(s)) s = s.split(/\s*→\s*/).pop().trim();
  // "**TaxDome:** Widely used by…" — the colon ends the bold, so the name is
  // before it. Taking the part after the last colon left nothing, and every
  // bullet in Gemini's commonest layout ("* **Name:** description") was lost
  // (live run, 23 Nov 2026: TaxDome, HubSpot CRM, Zoho CRM missed). Only a
  // name-shaped label counts: "**Key features:**" is still a label.
  else if (/^[^:]+:\s*$/.test(s)) {
    const before = s.replace(/:\s*$/, "").trim();
    const halves = before.split(/\s+(?:&|and)\s+/);
    const named = looksLikeProperName(before) || (halves.length === 2 && halves.every((h) => h.split(/\s+/).length >= 2 && looksLikeProperName(h)));
    s = named && !isNoise(before) && !isNoise(before.split(/\s+/)[0]) ? before : "";
  }
  else if (s.includes(":")) s = s.split(":").pop().trim();
  // Strip leading list numbering left over from heading matches ("1. Vivo V70").
  s = s.replace(/^\d+[.)]\s*/, "").trim();
  // A label's closing full stop is not part of the name (1.0.7: AI Mode's
  // "**WhatsApp Business API.**" was a brand with its dot). An abbreviation's
  // own dot stays ("Inc.", "Co.", "U.S.").
  if (/\.$/.test(s) && !/(?:^|\s)(?:Inc|Co|Ltd|Corp|Bros|Pvt|Jr|Sr|St|No|Mfg|Intl)\.$/.test(s) && !/(?:^|[\s.])\p{L}\.$/u.test(s)) s = s.slice(0, -1).trim();
  // Advice, not a name: "**Avoid HubSpot or Salesforce**" (Gemini, 1.0.7
  // live test) gave the brand "Avoid HubSpot". The verb goes; the names stay.
  s = s.replace(/^(?:Avoid|Skip|Choose|Pick|Consider|Try|Use|Prefer|Go with|Opt for|Start with|Stick with|Look at|Shortlist)\s+(?=\p{Lu})/u, "");
  s = dropLeadDescriptor(s);
  // A qualifier in brackets after the name ("Britannia NutriChoice Digestive
  // (High Fibre or similar variants)") pushed the whole label over the length
  // cap and the brand was lost (1.0.0). A model's own brackets stay: they
  // are short and hold no spaces-separated sentence ("Phone (3a)").
  s = s.replace(/\s*\((?=[^)]*\s)[^)]{12,}\)\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  // A plan or edition in brackets after the name, from a table cell
  // ("**Pipedrive** *(Growth)*", "**Zoho CRM** *(Professional)*", Gemini,
  // 1.0.7 live test) kept the name from ever matching the text. A model's
  // own brackets hold a digit and stay: "Phone (3a)".
  // Only a plan's or an edition's words, or who makes it ("by Ikiru
  // People"): a label's own brackets ("Plastic Emulsion (Standard Finish)",
  // "Suction Power (Pa)") kept it from matching, and must go on doing so.
  s = s.replace(/^(.*\S)\s*\(((?:free|pro|plus|premium|standard|professional|enterprise|growth|starter|basic|business|essentials|teams?|advanced|ultimate|lite|personal|core|scale|elite|unlimited|startup|nonprofit|paid|smart crm|sales hub|free crm)(?:\s+(?:plan|plans|tier|edition|version|trial))?|(?:by|from)\s+\p{Lu}[\p{L} &.-]{1,30})\)$/iu, "$1").trim();
  // A question is a label, never a name: ChatGPT's follow-up form ("**3.
  // Expected monthly visitors?**") made "Expected" a brand (22 Nov 2026).
  if (!s || s.endsWith(":") || /\?\s*$/.test(s) || s.length > 40) return "";
  // A list, not a name (1.0.7 corpus check): "Wood, Metal & Trim",
  // "Bathrooms, Basements & Water", and the cut-off ends of one ("WATI,
  // AiSensy,", "GPU VRAM &").
  if (/[,&]\s*$/.test(s) || /,[^,]*(?:\s&\s|\sand\s)/.test(s)) return "";
  return s;
}

export function structuralCandidates(answerText) {
  const out = [];
  if (!answerText) return out;

  parseTableCells(answerText).forEach(({ text: raw, headed }) => {
    const s = cleanCandidateText(raw);
    if (s) out.push({ text: s, source: headed ? "table" : "table-guess" });
  });

  // Bold text at the START of a line, tolerating any combination of heading
  // hashes, list bullets and numbering.
  // Up to 90 characters inside the bold: a label with a bracketed qualifier
  // runs long, and cleanCandidateText strips the qualifier and caps the rest.
  const lineLeadBold = /(?:^|\n)[ \t]*#{0,6}[ \t]*(?:\d+[.)][ \t]*)?[-*•]?[ \t]*\*\*([^*\n]{2,90})\*\*/g;
  // Plain (unbolded) headings: "### Zerodha"
  const heading = /(?:^|\n)#{2,6}[ \t]*([^\n#*]{2,60})/g;

  // Which section each heading sits in: headings of the same level under the
  // same parent are siblings, a list of things (1.0.0, see detectBrands).
  const headingLines = [];
  { let at = 0; for (const line of answerText.split("\n")) { const h = line.match(/^(#{1,6})\s/); if (h) headingLines.push({ at, level: h[1].length }); at += line.length + 1; } }
  const groupOf = (idx) => {
    const me = headingLines.find((h) => h.at <= idx && idx <= h.at + 8) || null;
    if (!me) return null;
    let parent = -1;
    for (const h of headingLines) { if (h.at >= me.at) break; if (h.level < me.level) parent = h.at; }
    return `${me.level}@${parent}`;
  };

  // Bold labels that open a line and end in ":" or "." (1.0.7, live test of
  // 25 Nov 2026): "**Limitation:**" (ChatGPT, under every pick), "**Lead
  // Scoring:**", "**Indian Ecosystem Readiness:**" (Gemini's feature list),
  // "**Trade-off.**", "**Why it wins.**" (AI Mode, under every pick) and
  // "**Team features for 10 people**:" (Grok) were all brands. What the
  // answer says outside such labels is what can vouch for a name.
  const labelSpan = /(?:^|\n)[ \t]*#{0,6}[ \t]*(?:\d+[.)][ \t]*)?[-*•]?[ \t]*\*\*([^*\n]{2,90})\*\*[ \t]*:?/g;
  const labelCount = new Map();
  const outsideLabels = answerText.replace(labelSpan, (all, inner) => {
    if (/[:.]\s*$/.test(inner) || /:$/.test(all)) { const k = cleanCandidateText(inner).toLowerCase(); if (k) labelCount.set(k, (labelCount.get(k) || 0) + 1); }
    return all.startsWith("\n") ? "\n" : "";
  });
  // Written elsewhere as a name: whole words, the same capitals.
  const namedOutside = (name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u").test(outsideLabels);
  // A phrase naming a quality or an activity, not a maker; used only with
  // an ordinary first word (below), so "PayPal Invoicing" and "Tata
  // Housing" are not caught (corpus check, 1.0.7).
  const ABSTRACT_TAIL = /(?:ness|ity|ities|tion|tions|sion|sions|ment|ments|ing|ship|ism)$/i;

  for (const { re, source } of [
    { re: lineLeadBold, source: "heading" },
    { re: heading, source: "section" },
  ]) {
    let m;
    while ((m = re.exec(answerText))) {
      const s = cleanCandidateText(m[1]);
      if (!s) continue;
      const lead = m[0].replace(/^\n/, "");
      // A bold label opening a list item ("- **Cremica High Bran Biscuits**:
      // fibre-rich…") is that item's subject; a bold heading line is not.
      const src = source === "heading" && !/#/.test(lead) && /^[ \t]*(?:\d+[.)]|[-*•])/.test(lead) ? "bullet" : source;
      const next = answerText.slice(m.index + m[0].length, m.index + m[0].length + 3);
      const colonLabel = source === "heading" && (/:\s*$/.test(m[1]) || /^[ \t]?:/.test(next));
      const dotLabel = source === "heading" && /\.\s*$/.test(m[1]) && /^[ \t]+\S/.test(next);
      if ((colonLabel || dotLabel) && !namedOutside(s)) {
        // "**Trade-off.** It is priced higher…": a sentence-style label.
        if (dotLabel) continue;
        const words = s.split(/\s+/);
        if ((labelCount.get(s.toLowerCase()) || 0) >= 2) continue;
        // A feature, not a maker: its first word is one the answer also
        // writes as an ordinary word ("lead", "data", "mobile"), and so is
        // its last, or the last names a quality. "Voyager Infinity",
        // "PayPal Invoicing" and "Tata Housing" open on a name. Not a list
        // of names ("Google Workspace / Airtable / Notion").
        const lowIn = (w) => new RegExp(`(?<![\\p{L}])${escapeRegExp(w.toLowerCase())}(?![\\p{L}])`, "u").test(answerText);
        const last = words[words.length - 1];
        if (words.length >= 2 && !/\//.test(s) && lowIn(words[0].replace(/,$/, "")) && (lowIn(last) || ABSTRACT_TAIL.test(last))) continue;
      }
      // A "**Label:**" whose every word the answer also writes in lower case
      // is a section label ("**Sales & Marketing:**", "**Key Features:**"),
      // not a name: "TaxDome", "Karbon" and "HubSpot" never are.
      if (colonLabel || dotLabel) {
        const ws = s.split(/\s+/).filter((w) => !/^(?:&|and|of|for|the)$/i.test(w));
        const low = answerText.toLowerCase() !== answerText ? answerText : "";
        if (ws.length && ws.every((w) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(w.toLowerCase())}(?![\\p{L}])`, "u").test(low))) continue;
      }
      const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
      const group = source === "section" || /#/.test(lead) ? groupOf(at) : null;
      // Two names in one label: "* **HubSpot CRM & Zoho CRM:** Popular
      // options…" (Gemini, live run of 23 Nov 2026) is two picks. Only when
      // each side is a name of two words or more: "Marks & Spencer" and
      // "Barnes & Noble" are one brand.
      const pair = s.split(/\s+(?:&|and)\s+/);
      // "HubSpot or Salesforce" (what's left of "Avoid HubSpot or
      // Salesforce", 1.0.7): "or" never joins one brand's name.
      const either = s.split(/\s+or\s+/);
      if (either.length === 2 && either.every((p) => /^[\p{L}\p{N}.'’ -]+$/u.test(p) && p.split(/\s+/).length <= 3 && looksLikeProperName(p))) {
        for (const p of either) out.push({ text: p, source: src, group });
        continue;
      }
      if (pair.length === 2 && pair.every((p) => !/,/.test(p) && p.split(/\s+/).length >= 2 && looksLikeProperName(p))) {
        for (const p of pair) out.push({ text: p, source: src, group });
        continue;
      }
      out.push({ text: s, source: src, group });
    }
  }

  // Names an answer lists as examples (1.0.0): "(e.g., Britannia NutriChoice
  // Oats Milk & Almond, Sunfeast Farmlite Oats & Almonds, Unibic Oats
  // Digestive)". Each item that starts with a capital is a product or brand
  // named on purpose.
  // Only "e.g.": "cities like Bangalore" and "such as Mumbai" name places.
  const exampleList = /\be\.g\.,?\s+([^().;\n]{3,240})/gi;
  let em;
  while ((em = exampleList.exec(answerText))) {
    for (const item of em[1].split(/,\s*|\s+or\s+|\s+and\s+(?=[A-Z])/)) {
      const it = item.replace(/[*_`]/g, "").trim();
      if (!/^[A-Z]/.test(it) || it.split(/\s+/).length > 6) continue;
      const s = cleanCandidateText(it);
      if (s) out.push({ text: s, source: "example", group: null });
    }
  }

  // Names in bold inside a heading, after its label (1.0.2): "### 1. Best
  // Overall for Indian Real Estate Workflows: **Sell.Do** (or **TeleCRM**)",
  // "### 3. Best for Simplicity: **Pipedrive**" (Gemini, live run of 22 Nov
  // 2026). The heading pattern stops at the first "*", so these were never
  // read, and an answer whose picks are all named this way listed none of
  // them. A bold span that IS the whole heading ("### **For Family Baths:
  // Storage Water Heaters**") is the heading itself, read above as before.
  {
    let at = 0;
    for (const line of answerText.split("\n")) {
      if (/^\s*#{1,6}\s/.test(line)) {
        const plain = line.replace(/^\s*#{1,6}\s*/, "").trim();
        const spans = [...plain.matchAll(/\*\*([^*\n]{2,60})\*\*/g)];
        const whole = spans.length === 1 && spans[0][0] === plain;
        if (!whole) for (const m of spans) {
          if (m.index === 0) continue; // a leading bold label is read above
          // Named on purpose, like an "e.g." item: the label before it says
          // what it is, so it needn't be written again underneath.
          const s = cleanCandidateText(m[1]);
          if (s) out.push({ text: s, source: "example", group: null });
        }
      }
      at += line.length + 1;
    }
  }

  // A list of bold names in a sentence (1.0.2): "such as **Imperial College
  // Business School**, **IE Business School**, … and **Carnegie Mellon
  // (Tepper)**", "(such as **Manipal**, **Amity**, **Sikkim Manipal**)"
  // (Gemini, live run of 22 Nov 2026: the answer's brand list was
  // "Business"). Two or more bold spans joined by nothing but commas, "and"
  // and "or", each written as a name; bold emphasis ("**worth it**") is
  // lowercase, and bold terms with words between them ("**BOM** tracking,
  // **MRP**") are not a list.
  for (const m of answerText.matchAll(/\*\*[^*\n]{2,60}\*\*(?:(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)\*\*[^*\n]{2,60}\*\*)+/g)) {
    const items = [...m[0].matchAll(/\*\*([^*\n]{2,60})\*\*/g)].map((x) => x[1].trim());
    const nameLike = (it) => /^(?:\p{Lu}|\p{Ll}+\p{Lu})/u.test(it) && !/[:.!?]$/.test(it) && it.split(/\s+/).length <= 6 &&
      // "**Step 2** and **Under 15000**" are steps and prices, not names.
      !/^(?:Step|Option|Scenario|Tip|Day|Week|Phase|Part|Level|Round|Plan|Tier|Rule|Point|Method|Way|Top|Under|Over|Below|Above|Best|Rs|INR|USD|Price|Around|About|Up to|From)\b/i.test(it) &&
      it.replace(/\s*\([^)]*\)/g, "").split(/\s+/).every((w, i) => i === 0 || /^(?:\p{Lu}|\p{N}|of|de|la|&|and|for|the)/u.test(w));
    if (items.length < 2 || !items.every(nameLike)) continue;
    for (const it of items) { const s = cleanCandidateText(it.replace(/\s*\([^)]*\)\s*$/, "")); if (s) out.push({ text: s, source: "example", group: null }); }
  }

  // A name the answer bolds again and again (1.0.2): "**HelloFresh** leads…",
  // "Pick **HelloFresh** if…" (Gemini, live run of 22 Nov 2026) named four
  // meal kits this way and the list found none. Bolded twice or more, written
  // as a name, a few words at most; bold emphasis is lowercase.
  {
    const seen = new Map();
    for (const m of answerText.matchAll(/\*\*([^*\n]{2,40})\*\*/g)) {
      const it = m[1].trim();
      if (!/^(?:\p{Lu}|\p{Ll}+\p{Lu})/u.test(it) || /[:.!?,]$/.test(it) || /\d/.test(it) || it.split(/\s+/).length > 3) continue;
      if (!it.split(/\s+/).every((w, i) => i === 0 || /^(?:\p{Lu}|of|de|&)/u.test(w))) continue;
      // A group, not a name: "**Public Sector Banks**" heads a table's rows,
      // and the answer says "banks" in its own words.
      const last = it.split(/\s+/).pop();
      if (/s$/.test(last) && last.length > 3 && new RegExp(`(?<![\\p{L}])${escapeRegExp(last.toLowerCase())}(?![\\p{L}])`, "u").test(answerText)) continue;
      seen.set(it, (seen.get(it) || 0) + 1);
    }
    for (const [it, n] of seen) if (n >= 2) { const s = cleanCandidateText(it); if (s) out.push({ text: s, source: "example", group: null }); }
  }

  // A bold list of names: "**Jira, Linear, ClickUp, Asana, and monday.com**
  // consistently rank…" (Grok, live run of 22 Nov 2026) was one long phrase,
  // and Jira, named only there, was missed.
  for (const m of answerText.matchAll(/\*\*([^*\n]{5,200})\*\*/g)) {
    const items = m[1].split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
    if (items.length < 3) continue;
    if (!items.every((it) => /^(?:\p{Lu}|\p{Ll}+[\p{Lu}.])/u.test(it) && it.split(/\s+/).length <= 3)) continue;
    for (const it of items) { const s = cleanCandidateText(it); if (s) out.push({ text: s, source: "example", group: null }); }
  }

  // Makers an answer lists in a sentence (1.0.2): "you can get some very good
  // options from ASICS, Brooks, New Balance, Adidas and Puma" (ChatGPT, live
  // run of 22 Nov 2026) named five brands and the list found two. Only after
  // a word that says what follows is a set of makers or picks ("brands",
  // "options from", "insurers such as"), and only a list of three or more
  // capitalised names: "cities such as Pune and Delhi" names places, and
  // never says "brands".
  // The noun may come a few words before the list, and the list may follow
  // "include" or "are": "Top luxury wedding-hotel picks in Jaipur include The
  // Leela Palace Jaipur, Fairmont Jaipur, JW Marriott Jaipur Resort & Spa,
  // and Oberoi Rajvilas" (Perplexity, same run) gave no brands at all.
  const makerList = /\b(?:brands?|makers?|manufacturers?|companies|labels|players|providers|insurers|lenders|banks|vendors|options|models|picks|alternatives|choices|names|hotels|venues|resorts|restaurants|clinics|hospitals|schools|colleges|universities|agencies|firms|platforms|apps|tools)\b[^.;:\n]{0,40}?\s+(?:like|such as|including|include|includes|are|from|e\.g\.,?|:)\s+([^.;:\n()]{5,300})/gi;
  let ml;
  while ((ml = makerList.exec(answerText))) {
    const items = ml[1].replace(/[*_`]/g, "").split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
    // The list ends where the names do: "…Adidas and Puma that suit flat feet".
    // Up to three words, or up to six when every word is capitalised ("JW
    // Marriott Jaipur Resort & Spa").
    const names = [];
    for (const it of items) {
      const w = it.split(/\s+/);
      const join = (x) => /^(?:of|de|la|&)$/.test(x);
      if (!/^(?:\p{Lu}|\p{Ll}+\p{Lu})/u.test(it) || w.slice(1).some((x) => /^\p{Ll}/u.test(x) && !join(x))) break;
      if (w.length > 6 || (w.length > 3 && !w.every((x) => /^\p{Lu}/u.test(x) || join(x)))) break;
      names.push(it);
    }
    if (names.length < 3) continue;
    for (const n of names) { const s = cleanCandidateText(n); if (s) out.push({ text: s, source: "example", group: null }); }
  }

  // Paragraph leads (e.g. "POCO F7 delivers...", "Realme P4 Power 5G packs...")
  // A bold opening sentence too (1.0.7): Grok's "**Zoho CRM is the best
  // overall choice…**" named its pick only there and in a heading, and the
  // brand list missed it.
  const paraLead = /(?:^|\n\n)(?:\*\*)?(?:The\s+)?([A-Z][A-Za-z0-9&.\-]+(?:\s+[A-Za-z0-9&.\-]+){1,3})\s+(?:is|delivers|packs|offers|features|combines|stands out|provides|brings|runs|comes)\b/g;
  let pm;
  while ((pm = paraLead.exec(answerText))) {
    const s = cleanCandidateText(pm[1]);
    if (s && !isNoise(s)) out.push({ text: s, source: "heading" });
  }

  return out;
}

/**
 * Products named in bold inside a sentence (1.0.0): "Devices like the
 * **Realme P4 Power** and **Redmi Note 17 Pro Max** pack…". Read last, by
 * detectBrands, and only to ADD makers the other passes missed: as a
 * structural candidate it also switched off the prose pass, and an answer
 * whose brands came from prose lost Google, Xiaomi and Leica.
 */
export function boldProductNames(answerText) {
  if (!answerText) return [];
  // Only a line's first bold was read, so both were missed in the owner's
  // Gemini answer of 15 Nov 2026. A model number is required: bold words alone
  // are as often emphasis ("**incredible battery life**") as names.
  const out = [];
  const boldProduct = /\*\*((?:[A-Z]|i[A-Z])[^*\n]{1,60})\*\*/g;
  let bm;
  while ((bm = boldProduct.exec(answerText))) {
    const it = bm[1].trim();
    // Inside a sentence only: structuralCandidates reads a line's first bold.
    const before = answerText.slice(answerText.lastIndexOf("\n", bm.index) + 1, bm.index);
    if (!/[A-Za-z0-9]/.test(before.replace(/^[ \t]*#{0,6}[ \t]*(?:\d+[.)][ \t]*)?[-*•]?[ \t]*/, ""))) continue;
    // "Galaxy M34 / F15 5G": alternatives, the second without its maker.
    if (/\//.test(it)) continue;
    const words = it.split(/\s+/);
    if (words.length > 6 || /[:.!?]$/.test(it) || !words.slice(1).some((w) => /^[A-Za-z]*\d[A-Za-z0-9]*$/.test(w))) continue;
    if (/^(?:Step|Option|Scenario|Tip|Day|Week|Phase|Part|Level|Round|Plan|Tier|Rule|Point|Method|Way|Top|Under|Over|Below|Above|Best|Rs|INR|USD|Price)\b/i.test(it)) continue;
    const s = cleanCandidateText(it);
    if (s && !isNoise(s)) out.push(s);
  }
  return out;
}

/* ---------- 4. cited domains ---------- */
export const MARKETPLACE_DOMAINS = new Set([
  "amazon.com", "amazon.in", "amazon.co.uk", "amazon.ae", "amazon.de", "amazon.ca",
  "flipkart.com", "myntra.com", "meesho.com", "snapdeal.com", "shopclues.com",
  "ebay.com", "ebay.in", "walmart.com", "aliexpress.com", "alibaba.com", "etsy.com",
  "jiomart.com", "olx.in", "olx.com", "quikr.com",
  "indiamart.com", "tradeindia.com", "exportersindia.com", "justdial.com",
  "dhgate.com", "made-in-china.com", "wish.com", "rakuten.com",
  // Marketplaces in other markets (0.69.0): the tool is used everywhere.
  "amazon.fr", "amazon.it", "amazon.es", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.be", "amazon.co.jp",
  "amazon.com.au", "amazon.com.br", "amazon.com.mx", "amazon.sg", "amazon.sa", "amazon.eg", "amazon.com.tr",
  "ebay.co.uk", "ebay.de", "ebay.fr", "ebay.it", "ebay.es", "ebay.com.au", "ebay.ca",
  "mercadolibre.com", "mercadolibre.com.mx", "mercadolibre.com.ar", "mercadolibre.com.co", "mercadolibre.cl",
  "mercadolivre.com.br", "rakuten.co.jp", "rakuten.fr", "rakuten.de", "allegro.pl", "bol.com", "zalando.com",
  "zalando.de", "zalando.fr", "otto.de", "cdiscount.com", "kaufland.de", "coupang.com", "shopee.com",
  "shopee.co.id", "shopee.com.my", "shopee.ph", "shopee.sg", "shopee.co.th", "shopee.vn", "shopee.com.br",
  "lazada.com", "lazada.co.id", "lazada.com.my", "lazada.com.ph", "lazada.sg", "lazada.co.th", "lazada.vn",
  "tokopedia.com", "bukalapak.com", "noon.com", "jumia.com", "jumia.com.ng", "jumia.co.ke", "takealot.com",
  "temu.com", "shein.com", "trendyol.com", "hepsiburada.com", "ozon.ru", "wildberries.ru", "avito.ru",
  "marktplaats.nl", "leboncoin.fr", "wallapop.com", "gumtree.com", "craigslist.org", "kijiji.ca",
  "trademe.co.nz", "catch.com.au", "qoo10.com", "mercari.com", "yahoo.co.jp", "daraz.pk", "daraz.com.bd",
  // Quick-commerce and grocery apps (1.0.0): "Listed around ₹66 on Zepto"
  // made the app a brand in a biscuit answer.
  "zepto.com", "zeptonow.com", "blinkit.com", "swiggy.com", "bigbasket.com", "dmart.in", "tatacliq.com",
  "1mg.com", "pharmeasy.in", "firstcry.com", "ajio.com", "instacart.com", "ocado.com", "tesco.com",
  "carrefour.com", "costco.com", "target.com",
]);

// Publishers, news outlets, tech portals, aggregators, price comparison sites, and social platforms that
// produce citations or host discussions, NOT product brands being reviewed.
export const EDITORIAL_DOMAINS = new Set([
  "digit.in", "gadgets01.com", "91mobiles.com", "gsmarena.com", "techradar.com",
  "theverge.com", "tomsguide.com", "cnet.com", "androidauthority.com", "androidcentral.com",
  "smartprix.com", "mysmartprice.com", "bgr.in", "gadgets360.com", "gizmochina.com",
  "beebom.com", "youtube.com", "etnownews.com", "hindustantimes.com", "indiatoday.in",
  "timesofindia.com", "indianexpress.com", "livemint.com", "moneycontrol.com",
  "reddit.com", "quora.com", "medium.com", "wikipedia.org", "x.com", "twitter.com",
  "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "tiktok.com",
  "cashkr.com", "reviehub.in", "priceoye.pk", "godigit.com", "godigit.in", "winnerwinnerchickendinner.com",
  // "Best phone under X" listicle/comparison sites, reached via Perplexity's
  // [[cite:URL]] inline markers (see perplexity.js's stripCiteMarkersForDetection
  // for the deeper structural fix — that bug alone was enough to make ANY
  // cited domain self-match, so this list is defense-in-depth, not the fix).
  "mobileburn.com", "bhalophone.com", "goalmoneytrack.com",
  // International news, reviews and buying guides (0.69.0).
  "nytimes.com", "wsj.com", "washingtonpost.com", "bbc.com", "bbc.co.uk", "theguardian.com", "reuters.com",
  "apnews.com", "bloomberg.com", "ft.com", "economist.com", "forbes.com", "businessinsider.com", "cnbc.com",
  "techcrunch.com", "wired.com", "engadget.com", "arstechnica.com", "zdnet.com", "pcmag.com", "pcworld.com",
  "macworld.com", "9to5mac.com", "9to5google.com", "macrumors.com", "digitaltrends.com", "trustedreviews.com",
  "expertreviews.co.uk", "which.co.uk", "consumerreports.org", "rtings.com", "wirecutter.com", "nerdwallet.com",
  "bankrate.com", "investopedia.com", "healthline.com", "webmd.com", "mayoclinic.org", "goodhousekeeping.com",
  "g2.com", "capterra.com", "trustradius.com", "getapp.com", "softwareadvice.com", "clutch.co", "producthunt.com",
  "trustpilot.com", "yelp.com", "tripadvisor.com", "lemonde.fr", "lefigaro.fr", "spiegel.de", "chip.de",
  "computerbild.de", "heise.de", "elpais.com", "xataka.com", "tecmundo.com.br", "tudocelular.com", "globo.com",
  "uol.com.br", "infobae.com", "nikkei.com", "itmedia.co.jp", "kakaku.com", "impress.co.jp", "sina.com.cn",
  "sohu.com", "163.com", "chosun.com", "aljazeera.com", "alarabiya.net", "scmp.com", "straitstimes.com",
  "smh.com.au", "abc.net.au", "cbc.ca", "news.com.au", "ndtv.com", "thehindu.com", "economictimes.indiatimes.com",
  "gizmodo.com", "security.org", "tomsguide.com", "theverge.com", "lifehacker.com", "pcgamer.com",
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
  "says?|said|reports?|reported|notes?|noted|lists?|listed|rates?|rated|ranks?|ranked|reviews?|reviewed|claims?|writes?|wrote|tested|recommends?|suggests?|estimates?|observes?" +
  // A publisher quoted about the brands (1.0.2): "CNET and AARP note…",
  // "Taste of Home likes its bold flavors", "The Kitchn praises…", "AARP gave
  // it a lower taste score" (Gemini, live run of 22 Nov 2026).
  "|likes?|liked|praises?|praised|gave|gives?|calls?|called|found|finds?|highlights?|highlighted|points? out|warns?|warned|scored?";
// "CNET and AARP note…": the first of two publishers is quoted too.
const ATTRIB_AFTER_RE = new RegExp(
  `^[,;:]?\\s*(?:(?:and|&)\\s+(?:The\\s+)?\\p{Lu}[\\p{L}’'.]*(?:\\s+\\p{Lu}[\\p{L}’'.]*){0,3}\\s+)?(?:(?:also|now|currently|recently|already|still|further|however)\\s+|\\w+ly\\s+){0,2}(?:${ATTRIB_VERBS})\\b`,
  "iu"
);
// Possessive attribution: "Gadgets 360's review put it third".
const ATTRIB_POSSESSIVE_RE = /^['’]s\s+(review|report|test|testing|analysis|round-?up|verdict|listing)\b/i;
// …and the second of two after "per": "per CNET and The Kitchn".
const ATTRIB_BEFORE_RE = /\b(?:according to|per|via|source:?)\s+(?:(?:The\s+)?\p{Lu}[\p{L}’'.]*(?:\s+\p{Lu}[\p{L}’'.]*){0,3}\s+(?:and|&)\s+)?$/iu;

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
  /^(amazon|flipkart|myntra|meesho|snapdeal|shopclues|ebay|walmart|aliexpress|alibaba|etsy|jiomart|olx|quikr|indiamart|tradeindia|exportersindia|justdial|dhgate|wish|rakuten|mercado ?libre|mercado ?livre|allegro|bol\.com|zalando|otto|cdiscount|coupang|shopee|lazada|tokopedia|noon|jumia|takealot|temu|shein|trendyol|ozon|wildberries|kaufland|daraz|qoo10|zepto|blinkit|grofers|instamart|swiggy instamart|bigbasket|big basket|dmart|tata ?cliq|tata 1mg|1mg|pharmeasy|firstcry|ajio|instacart|ocado|tesco|carrefour|costco|target)\b/i;
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
  const all = dropLeadDescriptor(title).split(/\s+/);
  // "Tots & Moms Millet Cookies", "Marks and Spencer Oat Bars": a maker's
  // name joined by "&" or "and" is one name (1.0.0).
  if (all.length >= 3 && /^(&|and)$/i.test(all[1]) && /^[A-Z]/.test(all[2]) && /^[A-Z]/.test(all[0])) {
    return [all[0], "&", all[2]].join(" ").replace(/[^\w&.'’\s-]/g, "");
  }
  const first = all[0] || "";
  // Apostrophes stay (1.0.0): "Mo's" read as "Mos" and "McVitie's" as
  // "McVities", a second row beside the brand's real one.
  const clean = first.replace(/[^\w&.'’\-]/g, "").replace(/^['’]+|['’]+$/g, "");
  if (!clean || !/^[A-Za-z]/.test(clean) || isNoise(clean)) return "";
  return clean;
}

/*
 * The maker of a product named in THIS answer (1.0.2). vendorFromProductName
 * takes the first word, which is right for "Vivo V70" and wrong for every
 * maker whose name is more than one word: the owner's-style live run of 22
 * Nov 2026 (151 prompts, four engines) reported "Follow" for Follow Up Boss,
 * "Royal" for Royal Canin, "Red" for Red Tape, and lost New Balance entirely
 * ("New" is a noise word, so the vendor came back empty).
 *
 * What tells them apart is how the answer itself writes the first word. A
 * one-word maker stands on its own somewhere ("Samsung's", "from Vivo",
 * "Galaxy" after it in one place and "A56" in another); the first word of a
 * longer name never does: every "Royal" is followed by "Canin". So the name
 * grows by the next word while the answer never uses the shorter form without
 * it, the next word is capitalised and carries no digit, and it isn't a plan
 * or edition word ("Pro", "Plus"). Two words at most, or three when the
 * middle one is a short joining word ("Follow Up Boss", "Bank of America").
 */
const COMMON_NAME_WORDS = new Set([
  "red", "blue", "black", "white", "green", "yellow", "orange", "pink", "purple", "brown", "grey", "gray", "golden", "gold", "silver",
  "royal", "real", "simple", "smart", "wise", "true", "pure", "fresh", "happy", "lucky", "big", "little", "old", "young", "first",
  "general", "united", "national", "global", "american", "british", "indian", "modern", "urban", "natural", "bright", "clear",
  "star", "sun", "sky", "ocean", "rock", "iron", "stone", "home", "house", "follow", "click", "open", "free", "fair", "good",
  "great", "grand", "high", "next", "north", "south", "east", "west", "super", "magic", "living", "life", "health", "care", "mind",
]);
const EDITION_WORDS = new Set(["pro", "plus", "max", "ultra", "mini", "lite", "premium", "standard", "basic", "starter", "essentials", "enterprise", "business", "team", "teams", "personal", "home", "edition", "series", "neo", "prime", "elite", "advanced"]);
export function vendorInAnswer(text, title) {
  title = dropLeadDescriptor(title);
  const words = String(title || "").trim().split(/\s+/);
  let vendor = vendorFromProductName(title);
  // A noise first word ("New") gives no vendor; it may still begin the name.
  const startsName = vendor || (words.length > 1 && /^[A-Z][a-z]+$/.test(words[0]) && /^[A-Z]/.test(words[1]) ? words[0] : "");
  if (!startsName || !text || startsName !== words[0].replace(/[^\w&.'’\-]/g, "")) return vendor;
  // Only a first word that is ALSO an ordinary word needs the next one to be
  // a name: "Royal", "Red", "New", "Follow", "Real". "Skechers Arch Fit",
  // "Nike Structure 25" and "Zoho CRM" are their maker plus a model, however
  // rarely the answer writes the maker alone; growing them split one brand's
  // mentions across its models. Ordinary means: written in lowercase in this
  // answer, a noise word, or one of the everyday words maker names are built
  // from (colours, qualities) — language, not an industry list.
  const first = words[0].replace(/[^\p{L}]/gu, "");
  // A maker written in its own casing ("adidas", "boAt") is never an
  // ordinary word, and its lowercase form is the name itself.
  if (!/^\p{Lu}\p{Ll}/u.test(first)) return vendor;
  const ordinary = isNoise(first) || COMMON_NAME_WORDS.has(first.toLowerCase()) ||
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(first.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(text);
  if (!ordinary) return vendor;
  const nameWord = (w) => !!w && /^[A-Z][\p{L}'’&.-]*$/u.test(w) && !/\d/.test(w) && !EDITION_WORDS.has(w.toLowerCase());
  const standsAlone = (prefix, next) => {
    // "Follow-up" is a different word, not "Follow" on its own.
    const re = new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(prefix)}(?![\\p{L}\\p{N}-])(\\s+(\\S+))?`, "gu");
    for (const m of text.matchAll(re)) {
      // "Follow Up Boss." and "Follow Up Boss," still continue the name.
      const after = (m[2] || "").replace(/[*_`]/g, "").replace(/^[("'“‘]+|[^\p{L}\p{N}&'’-]+$/gu, "");
      if (after !== next) return true;
    }
    return false;
  };
  // A short middle word: "of", "&", "Up", "Max".
  const joiner = (w) => /^(?:of|de|la|and|&|[A-Z][a-z]{0,2})$/.test(w || "");
  const short = joiner(words[1]);
  const max = short ? 3 : 2;
  let k = 1;
  while (k < words.length && k < max && (nameWord(words[k]) || (k === 1 && short))) {
    if (standsAlone(words.slice(0, k).join(" "), words[k])) break;
    k++;
  }
  if (k === 1) return vendor;
  // "Follow Up" can't end on a joining word: grow through it or not at all.
  if (k === 2 && short) return vendor;
  const name = words.slice(0, k).join(" ").replace(/[^\w&.'’\s-]/g, "");
  // Named once, the longer reading is a guess either way: "Noise Airwave Max
  // XR" in one table row is the maker Noise (brands-common-words). An answer
  // that is about Red Tape or Royal Canin writes the name more than once.
  const times = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "gu"))].length;
  // A colour or quality word is never a maker alone, though ("Red").
  if (times < 2 && !COMMON_NAME_WORDS.has(first.toLowerCase()) && vendor) return vendor;
  return isNoise(name) ? vendor : name;
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
  // Kinds of organisation heading a group of rows (1.0.2): "**Public Sector
  // Banks**" read as the brand "Public Sector" (live run, 22 Nov 2026).
  "banks", "lenders", "insurers", "companies", "firms", "schools", "colleges", "universities",
  "hospitals", "clinics", "agencies", "providers", "funds", "brokers", "carriers", "airlines",
  // …and what a heading is about: "### Indicative Home Loan Interest Rates".
  "rates", "prices", "fees", "costs", "charges", "deals", "offers", "tips", "steps",
  // Software and sportswear headings (live run, 23 Nov 2026): "**Traditional
  // sales & relationship CRMs**" became the brand "Traditional".
  "crms", "systems", "solutions", "suites", "vendors", "integrations", "plans", "tiers",
  "trainers", "runners", "boots", "socks", "shorts", "jackets", "tights", "vests", "sandals", "bras", "caps",
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
  // Reported: "August" reached a brand list. A month/day name is bolded or
  // heads a line constantly in a listicle-style answer ("**August 2026
  // Update**", "### August Deals", a table's date column), which is exactly
  // the shape a real one-word brand heading has. Same fix as the spec-noun
  // set above — a calendar word is never a brand on its own.
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "yesterday", "tomorrow", "update", "updates", "updated",
  // Reported alongside the Grok citation-marker fix: "Setup" (from
  // "**Setup**: 200MP main...", the same spec-sheet-row-label shape as
  // Battery/Charging above) reached a real answer's brand list.
  "setup", "hardware",
  // Reported on a ChatGPT card answer (0.60.1): "Around" (its bold price
  // line, "**Around ₹34,999**") and "Triple" ("Triple rear cameras: …", a
  // bullet's first word) reached the brand list. Price qualifiers and camera
  // counts head a line the way a one-word brand does.
  "around", "about", "approx", "approximately", "under", "from", "starting", "only", "just", "upto",
  "single", "dual", "triple", "quad", "penta",
]);
export function looksLikeProperName(phrase) {
  const words = String(phrase || "").trim().split(/\s+/);
  if (!words.length || words.length > 3) return false;
  if (/\d/.test(phrase)) return false;
  // A describing compound ("Community-Focused", "Design-Forward",
  // "Client-Facing", "Entry-Level") makes a phrase a heading (Gemini's
  // section titles, live run of 22 Nov 2026). Makers joined by a hyphen
  // ("Coca-Cola", "Rolls-Royce", "Mercedes-Benz") end in a name instead.
  if (words.some((w) => /-(?:\p{L}+(?:ed|ing)|forward|level|friendly|first|based|free|only|ready|proof|centric|heavy|focused|oriented)$/iu.test(w.replace(/[^\p{L}-]/gu, "")))) return false;
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

/* ---------- 5. prompt context ---------- */
/*
 * Reported: "if the layout of the answer changes the tool is not able to tell
 * the exact brand" — Brand Mentions came back as "Optical Zoom", "Versatile
 * Triple Camera", "Balanced All-Rounder" (a comparison table's use-case
 * column) instead of the phones the prompt actually asked about.
 *
 * Fixing the column choice (parseTableCells) fixes THAT table. It does not fix
 * the general case, because every layout invents a new place to hide a
 * descriptor: a use-case column today, a "Why it's great" column tomorrow, a
 * bolded benefit label after that. What has to hold regardless of layout is a
 * property of the LANGUAGE, not of the markup:
 *
 *   A brand is a proper noun. An answer that is about one writes it as a name
 *   in its own prose — capitalised, mid-sentence, outside any table cell or
 *   heading. A descriptor never earns that: it appears only inside the
 *   structure that generated it, or lowercase in running text.
 *
 * Verified against the reported capture: "Optical Zoom" occurs three times —
 * "with optical zoom, high-resolution sensors" (lowercase prose), the table
 * cell, and the bold bullet label "**Optical zoom matters**". Not one is the
 * name-cased prose reference every real brand in the same answer has
 * ("Phones like the Nothing Phone (3a) Pro and Motorola Edge 60 Pro include…",
 * "The Redmi Note 15 Pro's 200MP sensor…").
 *
 * The prompt supplies the second half: the words the QUESTION was phrased in
 * are the category being asked about, never the answer to it. "Camera Phone"
 * is what the user asked for; it is not a brand, however the answer formats it.
 */

// Words that carry no subject information in a question ("best X under Y").
// English question/qualifier vocabulary only — no industry nouns, so this
// stays vertical-neutral like the rest of the file.
const PROMPT_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "of", "to", "in", "on", "at",
  "for", "with", "and", "or", "vs", "versus", "than", "then", "that", "this",
  "under", "over", "above", "below", "between", "within", "around", "about",
  "best", "top", "good", "great", "better", "greatest", "finest", "ideal",
  "cheap", "cheapest", "affordable", "budget", "premium", "value", "worth",
  "which", "what", "who", "whom", "whose", "where", "when", "why", "how",
  "should", "could", "would", "can", "do", "does", "did", "i", "me", "my", "we",
  "our", "you", "your", "us", "give", "show", "tell", "list", "find", "suggest",
  "recommend", "recommendations", "compare", "buy", "buying", "get", "need",
  "want", "looking", "help", "please", "right", "now", "currently", "available",
  "india", "indian", "usa", "us", "uk", "global", "market", "money", "rs", "inr",
  // Currencies and markets anywhere (0.69.0): "Best laptops in Brazil" must
  // not make "Brazil" a brand. Country names come from Intl below.
  "dollar", "dollars", "euro", "euros", "pound", "pounds", "yen", "yuan", "rupee", "rupees", "real", "reais",
  "peso", "pesos", "won", "dirham", "dirhams", "riyal", "riyals", "franc", "francs", "krona", "kronor",
  "krone", "lira", "rand", "naira", "ringgit", "rupiah", "baht", "dong", "zloty", "usd", "eur", "gbp",
  "europe", "european", "asia", "asian", "africa", "african", "america", "american", "latam", "emea", "apac",
  "worldwide", "international", "nationwide", "local", "online", "near",
]);
// Every country's English name ("Brazil", "United Kingdom", "Côte d’Ivoire"),
// one word or the whole name, from the browser's own list.
try {
  const dn = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) for (const b of A) {
    const n = dn.of(a + b);
    if (n) PROMPT_STOPWORDS.add(n.toLowerCase());
  }
} catch (_) { /* no Intl region names: the fixed words above still apply */ }

/**
 * The subject words a prompt was phrased in, minus question scaffolding and
 * bare numbers. "best camera phone under 30000" -> {"camera","phone"}.
 */
export function promptContextTokens(prompt) {
  const out = new Set();
  for (const raw of String(prompt || "").toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.trim();
    if (!w || w.length < 2) continue;
    if (/^\d+$/.test(w)) continue;            // "30000", "2026"
    if (PROMPT_STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

const isStructuralLine = (trimmed) =>
  !trimmed || trimmed.startsWith("|") || /^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed);

// The bolded label a bullet or paragraph can open with ("- **Optical zoom
// matters**: Phones like…"). Inside it, a phrase is still a label; after it,
// the line is ordinary prose.
//
// The trailing separator is what makes it a label rather than emphasis. A
// sentence is perfectly entitled to bold its own subject — "**Zerodha** is the
// largest broker." is prose about Zerodha, not a "Zerodha:" heading — and
// treating that as a label discarded the one real brand such an answer had.
const LEADING_LABEL_RE = /^\s*(?:[-*•+]\s*|\d+[.)]\s*)?\*\*[^*\n]+\*\*\s*[:—–-]/;

/** True when the answer contains running prose at all (not only tables/headings). */
export function hasProseLines(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (isStructuralLine(trimmed)) continue;
    const afterLabel = trimmed.replace(LEADING_LABEL_RE, "").replace(/^[:\s]+/, "");
    if (afterLabel.length >= 20) return true;
  }
  return false;
}

/**
 * True when `name` appears in the answer's running prose, written the way a
 * NAME is written — outside table rows, heading lines and leading bold labels,
 * with the capitalisation the candidate itself carries.
 *
 * This is the layout-independent half of the context gate: "Nothing",
 * "Motorola" and "Redmi" clear it from the same capture in which "Optical
 * Zoom" and "Balanced All-Rounder" cannot.
 */
export function namedInProse(text, name) {
  const t = String(text || "");
  const n = String(name || "").trim();
  if (!t || !n) return false;
  const wanted = n.split(/\s+/);
  const re = wordRe(n, "gi");
  let m;
  while ((m = re.exec(t))) {
    const lineStart = t.lastIndexOf("\n", Math.max(0, m.index - 1)) + 1;
    let lineEnd = t.indexOf("\n", m.index);
    if (lineEnd === -1) lineEnd = t.length;
    const line = t.slice(lineStart, lineEnd);
    if (isStructuralLine(line.trim())) continue;
    const label = line.match(LEADING_LABEL_RE);
    if (label && m.index < lineStart + label[0].length) continue;
    // Every sentence capitalises its first word, so that position proves
    // nothing: "- Strong daylight detail and punchy colours" was corroborating
    // "Strong" as a brand off a "Strong alternatives under ₹80,000" heading.
    // Bold is the exception — an author who bolds a word mid-answer is marking
    // it as a name ("**Zerodha** is the largest broker.").
    const beforeRaw = line.slice(0, m.index - lineStart);
    const boldOpen = /\*\*\s*$/.test(beforeRaw);
    const beforeText = beforeRaw
      .replace(/^\s*(?:[-*•+]\s+|\d+[.)]\s+)?/, "")
      .replace(/[*_`>\s]+$/, "");
    if (!boldOpen && (!beforeText || /[.!?:;]$/.test(beforeText))) continue;
    // Written as a name: wherever the candidate capitalises a word, the
    // occurrence must too. "optical zoom" and "Optical zoom" both fail
    // against "Optical Zoom"; "Nothing Phone" passes against "Nothing".
    const got = t.slice(m.index, m.index + n.length).split(/\s+/);
    const casedLikeName = wanted.every((w, i) => {
      if (!/^[A-Za-z]/.test(w)) return true;
      if (!/^[A-Z]/.test(w)) return true;
      return /^[A-Z]/.test(got[i] || "");
    });
    if (casedLikeName) return true;
  }
  return false;
}

/* ---------- 3c. names the prose itself writes ---------- */
/*
 * Structure-only detection has a mirror-image failure to the descriptor one:
 * an answer whose brands live purely in PROSE reported nothing at all. Both
 * of these — extremely common shapes — came back empty before this tier:
 *
 *   - **Best Optical Zoom**: the Nothing Phone (3a) Pro has a 3x periscope.
 *   ### Optical Zoom
 *   The Nothing Phone (3a) Pro leads.
 *
 * The only candidates structure could see there were the labels themselves
 * ("Best Optical Zoom"), which the context gate correctly rejects — leaving
 * zero. So prose has to be a source in its own right, not merely corroboration.
 *
 * Precision comes from two requirements, not from a word list: a run of
 * capitalised tokens is a candidate when it carries a MODEL DESIGNATION
 * ("Motorola Edge 60 Pro", "Nothing Phone (3a) Pro" — the signature of
 * brand + model), or when the answer comes back to it AGAIN. A one-off
 * capitalised pair with neither — "(Night Sight, HDR+)", "Prices Fluctuate" —
 * is a feature or a phrase, and stays out.
 *
 * Sentence-initial runs are skipped: every sentence capitalises its first
 * word, so that position carries no evidence of a proper noun.
 */
const PROSE_CONNECTORS = new Set(["of", "and", "&", "for", "the", "de", "la", "by"]);

// A real camelCase brand turns over within a character or two ("boAt",
// "iPhone", "eBay"); a long lowercase prefix before the hump is two words the
// flattening glued together ("pickboAt", "StrengthsBest").
const isGluedArtifact = (phrase) =>
  String(phrase).split(/\s+/).some((w) => /[a-z][A-Z]/.test(w) && !/^[a-z]{1,2}[A-Z]/.test(w));

/**
 * Shapes this tier refuses outright. It reads raw text with no structure to
 * lean on, and each of these showed up as a "brand" on the repo's own
 * flattened-DOM fixture: a glue artifact, a short all-caps acronym (a spec or
 * feature far more often than a company — ANC, OIS, HDR), and a bare
 * geography/market qualifier ("India") that every answer repeats and none
 * means as a brand.
 */
export function isPlausibleProseName(phrase) {
  const p2 = String(phrase || "").trim();
  if (!p2) return false;
  if (isGluedArtifact(p2)) return false;
  if (/^[A-Z0-9]{2,4}$/.test(p2)) return false;
  if (PROMPT_STOPWORDS.has(p2.toLowerCase())) return false;
  return true;
}

/*
 * What the engine read, as evidence for a name written only once (1.0.2).
 * Perplexity's short answers (live run, 22 Nov 2026: 66 of 151 answers, two or
 * three sentences, no list, no bold) name each pick once, often first in its
 * sentence — "Groww is likely the easiest app…; if you want … Zerodha" — and
 * the once-and-not-first rule above left all of them with no brands. A name
 * that is also a page's site (groww.in) or written in a page's title is a name
 * the engine found out there, which is evidence of its own and needs no word
 * list. So is a name's own shape: a capital inside the word (HelloFresh,
 * BambooHR) is not how English capitalises a sentence's first word.
 */
function proseSupport(sources) {
  const sites = new Set(), titles = [], snippets = [];
  for (const s of sources || []) {
    const host = String((s && (s.domain || s.url)) || "").replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").toLowerCase();
    const label = host.split(".")[0];
    if (label && label.length >= 3) sites.add(label.replace(/[^a-z0-9]/g, ""));
    if (s && s.title) titles.push(String(s.title));
    if (s && s.snippet) snippets.push(String(s.snippet));
  }
  return { sites, titles, snippets };
}
// Written as a name inside a sentence of a page the engine read: capitalised
// after a lowercase word or a comma ("apps like Groww and Zerodha"), where
// English capitalises only names. A snippet is prose, unlike a title.
const snippetBacked = (phrase, support) => {
  if (!support || !support.snippets.length) return false;
  // Not where it only opens a longer name ("Down" of "Down to Earth").
  const re = new RegExp(`(?<=[\\p{Ll}\\p{N},;:)]\\s+)${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])(?!\\s+(?:to|of|and|&|de|la|the|for|on)\\s+\\p{Lu})`, "u");
  return support.snippets.some((t) => re.test(t));
};
// A CamelCase word in a title: Title Case never writes "HelloFresh".
const camelInTitle = (phrase, support) => !!support && /\p{Ll}\p{Lu}/u.test(phrase) &&
  support.titles.some((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "u").test(t));
const squash = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
// A page's site with this name: "Groww" ↔ groww.in, "HelloFresh" ↔
// hellofresh.com. Any name, however written.
const siteBacked = (phrase, support) => {
  const sq = squash(phrase);
  return !!support && sq.length >= 2 && support.sites.has(sq);
};
// Written, capitals and all, in a page's title. Titles are Title Case, so a
// single word there proves nothing ("Best Himalayan Treks"); a name of two
// or more words written the same way does ("Tata Nexon Review").
const titleBacked = (phrase, support) => {
  if (!support || !/\s/.test(phrase)) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "u");
  return support.titles.some((t) => re.test(t));
};

export function proseNameCandidates(text, sources = null, prompt = "") {
  const support = sources ? proseSupport(sources) : null;
  // With sources or a question to weigh a name against (1.0.2), "and" and a
  // comma separate names instead of joining them: "Hawkins and Prestige",
  // "Michelin, Continental, Bridgestone" are lists of picks, read whole they
  // were one name the answer never wrote. Without them, the original reading.
  const smart = !!(sources || prompt);
  const promptWords = new Set(String(prompt || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const seen = new Map(); // lower -> { text, count, hasDigit, initial, bold, listed, place }
  const note = (phrase, initial = false, bold = false) => {
    const key = phrase.toLowerCase();
    const prev = seen.get(key);
    if (prev) { prev.count += 1; if (!initial) prev.initial = false; if (bold) prev.bold = true; return prev; }
    const c = { text: phrase, count: 1, hasDigit: /\d/.test(phrase), initial, bold, listed: false, place: false };
    seen.set(key, c);
    return c;
  };

  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (isStructuralLine(trimmed)) continue;
    // Everything before/inside a leading bold label is a label, not prose.
    const label = trimmed.match(LEADING_LABEL_RE);
    const region = label ? trimmed.slice(label[0].length) : trimmed;

    const tokens = [...region.matchAll(/\S+/g)].map((m) => ({ raw: m[0], at: m.index }));
    let run = [];
    let runStart = -1;
    let runEnd = -1;
    let runBold = false;
    const lineRuns = []; // { c, start, end } in order, for lists
    const flush = () => {
      if (run.length) {
        // Trim connectors off both ends: a run may open on the sentence's own
        // "The" ("The Motorola Edge 60 Pro lasts longest") and close on an
        // "and" ("Nothing Phone and ...").
        while (run.length && PROSE_CONNECTORS.has(run[run.length - 1].replace(/[^\w&]/g, "").toLowerCase())) run.pop();
        let trimmedLead = false;
        while (run.length && PROSE_CONNECTORS.has(run[0].replace(/[^\w&]/g, "").toLowerCase())) { run.shift(); trimmedLead = true; }
        const before = region.slice(0, runStart).trimEnd();
        // Dropping a leading "The" means what follows is no longer the
        // sentence's first word — it is a name the sentence is about.
        const sentenceInitial = !trimmedLead && (!before || /[.!?:;]$/.test(before));
        const phrase = run.join(" ").replace(/[.,;:!?]+$/, "").trim();
        // A model designation is evidence wherever it sits; position only
        // matters for a run that has nothing else going for it.
        // A sentence's first words are noted too, marked: they count only
        // with evidence of their own (see proseSupport).
        // "In India, Hawkins…": a run opening on a preposition is where or
        // when the sentence is set, not a name.
        if (phrase && smart && /^(?:In|At|On|From|Near|Across|Within|Under|Over|During|After|Before|Since|Across|Throughout|Outside)\s/.test(phrase)) { run = []; runStart = -1; runEnd = -1; runBold = false; return; }
        if (phrase) {
          const c = note(phrase, sentenceInitial && !/\d/.test(phrase), runBold === true);
          lineRuns.push({ c, start: runStart, end: runEnd });
          // "in Gurgaon", "across Pune": a place the sentence is set in.
          // So is a list "in cities such as Pune, Delhi and Mumbai".
          if (/(?:^|\s)(?:in|at|near|across|around|within|outside)(?:\s+[\p{Ll}-]+){0,3}?(?:\s+(?:such as|like|including|e\.g\.,?))?$/iu.test(before) &&
            /(?:^|\s)(?:in|at|near|across|around|within|outside)$|(?:such as|like|including|e\.g\.,?)$/i.test(before)) c.place = true;
          // Put forward as the answer: "Jio is often the strongest starting
          // point", "Pampers Pure Protection is a good first option". English
          // grammar, not a vocabulary: the same words the noise list holds.
          if (smart && /^\s+(?:is|are|remains|stays|looks|seems)\s+(?:\w+\s+){0,2}?(?:the|a|an|another|one|your|our)\s+[^.;]{0,60}?\b(?:pick|picks|choice|choices|option|options|starting point|bet|buy|alternative|contender|winner|recommendation|fit|value)\b/i.test(region.slice(runEnd, runEnd + 140))) c.framed = true;
        }
      }
      run = [];
      runStart = -1;
      runEnd = -1;
      runBold = false;
    };

    for (const tok of tokens) {
      // Bold marks are emphasis, not part of the word: "the **Tata Nexon**
      // is…" is a name in a sentence (1.0.2). A possessive is not part of it
      // either ("Wirecutter’s top pick").
      const bolded = /\*\*/.test(tok.raw);
      const bare = tok.raw.replace(/^[("'‘“*_]+/, "").replace(/[).,;:!?"'’”*_]+$/, "").replace(/['’]s$/, "");
      if (bolded && /^\*\*/.test(tok.raw.replace(/^[("'‘“]+/, "")) && run.length) flush();
      // A capitalised token, or a camelCase brand that opens lowercase
      // ("boAt Rockerz 512", "iPhone 15") — without the second form the run
      // started one token late and reported the product line ("Rockerz")
      // instead of the maker.
      const isName = bare.length > 1 &&
        (/^[A-Z][A-Za-z0-9&'’.-]*$/.test(bare) || /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(bare));
      // A parenthesised or bare model designation continues a run it follows
      // ("Nothing Phone (3a) Pro", "Realme 15 Pro").
      const isDesignation = run.length > 0 && /^[A-Za-z]*\d[A-Za-z0-9]*$/.test(bare);
      const isConnector = run.length > 0 && PROSE_CONNECTORS.has(bare.toLowerCase()) && !(smart && bare.toLowerCase() === "and");
      if (isName || isDesignation || isConnector) {
        if (!run.length) runStart = tok.at;
        run.push(bare);
        runEnd = tok.at + Math.max(0, tok.raw.indexOf(bare)) + bare.length;
        // Bold is evidence only when it is exactly the name: "**Tata
        // Nexon**", not "**EPA-registered repellent containing…**".
        const closes = bolded && /\*\*[).,;:!?"'’”]*$/.test(tok.raw);
        if (bolded && run.length === 1 && /^[("'‘“]*\*\*/.test(tok.raw)) runBold = "open";
        if (closes) runBold = runBold === "open";
        // A bold name ends where its bold does ("**Tata Nexon** Kia" is two),
        // and, read smartly, at a comma ("Michelin, Continental").
        if (run.length >= (smart ? 7 : 5) || closes || (smart && /[,;]["'’”)*]*$/.test(tok.raw))) flush();
        continue;
      }
      flush();
      // A sentence ending inside the line resets what counts as initial.
      if (/[.!?]$/.test(tok.raw)) runStart = -1;
    }
    flush();
    // Names in a list: two or more joined by commas, "and", "or" ("Daikin
    // and LG", "Michelin, Continental and Bridgestone"). A list is what an
    // answer compares, so each is a name; a list set "in" somewhere is places.
    if (smart) {
      for (let i = 0; i + 1 < lineRuns.length; i++) {
        const a = lineRuns[i], b = lineRuns[i + 1];
        const gap = region.slice(a.end, b.start);
        if (!/^[)"'’”*]*\s*(?:,|;|,?\s+(?:and|or|&|vs\.?|versus)\s+|\s+\/\s+)\s*(?:the\s+)?$/i.test(gap)) continue;
        a.c.listed = b.c.listed = true;
        if (a.c.place || b.c.place) a.c.place = b.c.place = true;
      }
    }
  }

  // Evidence a name needs (1.0.2). A model designation, or being written
  // twice, as before; or the engine's own pages: a site of that name, or a
  // title naming it (see siteBacked/titleBacked); or bold in a sentence, the
  // answer setting the name apart. A sentence's first word has only the last
  // three to go on, since every sentence capitalises its first word. Shapes
  // the flattening of a page makes ("StrengthsBest", glued) and short
  // acronyms ("ANC") need a site, or to recur. A single word of the question
  // ("Chennai" in "…grocery delivery in Chennai") is what was asked about,
  // not an answer to it, unless the answer returns to it.
  // A name in a list, or written as a name in a page's snippet, is evidence
  // too (see snippetBacked). A place ("in Gurgaon") is not a brand.
  const LABEL_HEAD = /^(?:Step|Option|Scenario|Tip|Day|Week|Phase|Part|Level|Round|Plan|Tier|Rule|Point|Method|Way|Top|Under|Over|Below|Above|Best|Rs|INR|USD|Price|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Q[1-4]|FY|H[12])\b/;
  const evidence = (c) => {
    if (c.place && !siteBacked(c.text, support)) return false;
    // "**Step 2**", "**November 2026**": a label or a date, as boldProductNames refuses.
    if (LABEL_HEAD.test(c.text)) return false;
    // "**Common** issues": a generic word, bold or not (the curated sets).
    if (!/\s/.test(c.text) && (GENERIC_SPEC_NOUNS.has(c.text.toLowerCase()) || CATEGORY_PLURAL_NOUNS.has(c.text.toLowerCase()))) return false;
    const site = siteBacked(c.text, support);
    const glued = isGluedArtifact(c.text), acronym = /^[A-Z0-9&]{2,4}$/.test(c.text) || /^(?:[A-Z]\.){1,3}[A-Z]?\.?$/.test(c.text);
    const single = !/\s/.test(c.text);
    if (single && promptWords.has(c.text.toLowerCase())) return c.count >= 2 && !c.initial;
    if (acronym) return site || c.count >= 2;
    if (glued) return site || c.count >= 2 || c.listed || c.framed || camelInTitle(c.text, support) || snippetBacked(c.text, support) || (!c.initial && c.hasDigit);
    if (site || titleBacked(c.text, support) || c.bold || c.listed || c.framed || snippetBacked(c.text, support)) return true;
    return !c.initial && (c.hasDigit || c.count >= 2);
  };
  if (support || prompt) {
    return [...seen.values()]
      .filter(evidence)
      .map((c) => c.text)
      .filter((p) => !PROMPT_STOPWORDS.has(p.toLowerCase()));
  }

  // A model designation is proof on its own; anything else has to recur.
  // Then three shapes are refused outright, because this tier reads raw text
  // with no structure to lean on and each of them showed up as a "brand" on
  // the repo's own flattened-DOM fixture:
  //   - a glued-word artifact of flattening ("StrengthsBest"),
  //   - a short all-caps acronym, which is a spec or feature far more often
  //     than a company ("ANC", "OIS", "HDR"),
  //   - a bare geography or market qualifier ("India"), which every answer
  //     repeats and no answer means as a brand.
  // Without sources or a question (the original contract, kept for callers
  // that pass text alone): a designation, or written twice not first.
  return [...seen.values()]
    .filter((c) => !c.initial && (c.hasDigit || c.count >= 2))
    .map((c) => c.text)
    .filter(isPlausibleProseName);
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
  // Laptop parts named like makers in a gaming-laptop answer (live run, 22
  // Nov 2026): "RTX" and "Ryzen" reached the brand list beside Lenovo and HP.
  "rtx", "gtx", "ryzen", "xeon", "threadripper",
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

// A cited site's name counts as a mention only where the answer writes it as
// a name: "Booking.com" or "Booking", not "the current booking listings";
// "Hotels.com", not "budget hotels". Any capital letter will do ("boAt").
function writtenAsName(text, h) {
  const word = text.slice(h.start, h.end);
  if (/[A-Z0-9]/.test(word) || /[^\x00-\x7F]/.test(word)) return true;
  return /^\.(com|in|co|net|org|io|ai|app)\b/i.test(text.slice(h.end, h.end + 6));
}

// Places people stay, eat, shop or are treated at. A name with one of these
// in it is kept whole; the word alone is only the category.
const VENUE_WORD_RE = /\b(hotels?|hostels?|inns?|guest ?houses?|resorts?|home ?stays?|lodges?|motels?|villas?|cottages?|camps?|retreats?|residency|suites|b&b|bnb|cafes?|café|restaurants?|dhaba|bakery|bistro|pub|clinics?|hospitals?|schools?|colleges?|academy|institute|salon|spa|gym|studio|stores?|mart|showroom|jewell?ers?|pharmacy)\b/i;
const GENERIC_VENUE_RE = /^(the\s+)?(hotels?|hostels?|inns?|guest ?houses?|resorts?|home ?stays?|lodges?|motels?|cafes?|restaurants?|clinics?|hospitals?|stores?|stays?)$/i;

// Markdown links keep their text: "**[Hotel Summit 9](https://…)**" is the
// name Hotel Summit 9 in bold, not a 120-character label with a URL in it.
const unlinkMarkdown = (s) => String(s || "").replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]*\)/g, "$1");

/*
 * Common words (1.0.0). A brand is a name, and an answer writes a name the
 * same way every time. A word the answer ALSO writes in lowercase, as an
 * ordinary word ("low in sugar", "a ragi or oats biscuit"), is that ordinary
 * word wherever it heads a cell or a bullet: the owner's biscuit answers had
 * Sugar, Ragi, Oats and Whole-wheat as brands this way. No word list: the
 * answer itself says which words are common.
 */
/** `name`, case as written, somewhere in a sentence other than its first word. */
function namedMidSentence(text, name) {
  const re = wordRe(name, "gu");
  let m;
  while ((m = re.exec(text))) {
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
    const line = text.slice(lineStart, text.indexOf("\n", m.index) === -1 ? text.length : text.indexOf("\n", m.index));
    if (/^\s*(#|\|)/.test(line)) continue;
    const before = text.slice(lineStart, m.index).replace(/^\s*(?:[-*•+]|\d+[.)])?\s*/, "").replace(/[*_`"“(\[]+$/g, "").trimEnd();
    if (before && !/[.!?:]$/.test(before)) return true;
  }
  return false;
}
function lowercaseIn(text, word) {
  const w = String(word || "");
  if (!w || w === w.toLowerCase()) return false;
  return wordRe(w.toLowerCase(), "gu").test(text);
}
// The same for a describing word at the end of a product's name, with its
// singular or plural: "Digestive Biscuits" when the answer says "digestive
// biscuits can contain…", "Cookies" when it says "a cookie option".
function describesIn(text, word) {
  const w = String(word || "").replace(/[^\p{L}\p{N}'’-]/gu, "");
  if (!w || /\d/.test(w)) return false;
  const lw = w.toLowerCase();
  const forms = new Set([lw, lw + "s", lw.replace(/s$/, ""), lw.replace(/ies$/, "y"), lw.replace(/es$/, "")]);
  for (const f of forms) if (f.length >= 3 && wordRe(f, "gu").test(text)) return true;
  return false;
}
/** "Cremica High Bran Biscuits" -> "Cremica", "Mo's Bakery Ragi Cookies" -> "Mo's Bakery". */
export function trimDescriptors(text, phrase, shared = null) {
  const words = String(phrase || "").trim().split(/\s+/);
  const isShared = (w) => !!shared && shared.has(w.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, ""));
  while (words.length > 1 && (describesIn(text, words[words.length - 1]) || isShared(words[words.length - 1]))) words.pop();
  return words.join(" ");
}
// Words that two or more of the answer's item names share after their first
// word ("Ragi", "Digestive" in "Patanjali Ragi Digestive Cookies" and "Mo's
// Bakery Ragi Cookies") describe the product, not whose it is.
function sharedTailWords(phrases) {
  // word -> the different first words it follows. "Google Sheets" written
  // twice is one item, not two items sharing "Sheets".
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, "");
  const heads = new Map();
  for (const p of new Set(phrases)) {
    const all = String(p).trim().split(/\s+/).map(norm).filter(Boolean);
    for (const w of new Set(all.slice(1))) {
      if (!heads.has(w)) heads.set(w, new Set());
      heads.get(w).add(all[0]);
    }
  }
  return new Set([...heads].filter(([, h]) => h.size >= 2).map(([w]) => w));
}

export function detectBrands(answerText, plainText, ctx = {}) {
  // Citation markers ([[cite:https://…]]) are addresses, not answer text: a
  // site's name inside one read as the answer naming it (1.0.0).
  const noCites = (t) => String(t).replace(/\[\[cite:[^\]]*\]\]/g, "");
  answerText = answerText ? unlinkMarkdown(noCites(answerText)) : answerText;
  plainText = plainText ? unlinkMarkdown(noCites(plainText)) : plainText;
  const text = plainText || answerText || "";
  if (!text) return { brands: [], entities: [] };

  const { entities: markerEntities, productNames } = parseMarkers(answerText || "");
  const candidates = new Map(); // lowerName -> { name, category, description }
  // Makers read off a model name ("adidas Supernova Solution 3"): written in
  // lowercase on purpose, so the lowercase-fragment rule below spares them.
  const modelMakers = new Set();
  // A product's maker as this answer writes it: "Royal Canin", not "Royal".
  const vendorIn =(title) => vendorInAnswer(text.replace(/[*_`]/g, ""), String(title || "").replace(/[*_`]/g, ""));

  // What the question was about, and whether the answer even has prose to
  // corroborate a name against (a pure table has none — see the section above).
  const promptTokens = promptContextTokens(ctx.prompt);
  const proseExists = hasProseLines(text);
  // A phrase built only from the words the PROMPT was phrased in, at least one
  // of which is a generic category noun, is the thing being asked about, not an
  // answer to it: "Camera Phone" for "best camera phone under 30000". A brand
  // the prompt happens to name ("best Motorola phone" -> "Motorola") carries no
  // generic word and is never caught by this.
  const isPromptEcho = (name) => {
    if (!promptTokens.size) return false;
    // A word written in capitals is an acronym, not the plural noun it
    // spells: "TVS" (the scooter maker) is not "tvs" (televisions), and was
    // dropped from every electric-scooter answer (live run, 22 Nov 2026).
    if (String(name).split(/\s+/).some((w) => /^\p{Lu}{2,}$/u.test(w.replace(/[^\p{L}]/gu, "")))) return false;
    const words = String(name).toLowerCase().split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
    if (!words.length) return false;
    let sawGeneric = false;
    for (const w of words) {
      const generic = GENERIC_SPEC_NOUNS.has(w) || CATEGORY_PLURAL_NOUNS.has(w);
      if (generic) sawGeneric = true;
      if (!generic && !promptTokens.has(w) && !NOISE.has(w)) return false;
    }
    return sawGeneric;
  };

  const MAX_LEN = { structural: 40, default: 60, trusted: 120 };
  const addCand = (name, category, description, trust = "default", shownOnly = false, weak = false, needsProse = false, group = null) => {
    const n = String(name || "").trim().replace(/[*_`]/g, "");
    const cap = MAX_LEN[trust] ?? MAX_LEN.default;
    if (!n || n.length < 2 || n.length > cap) return;
    // A name starting with a filler word ("New Arrivals", "Best Overall") is
    // a label — unless the answer only ever writes that word as the start of
    // this name: "New Balance" (1.0.2).
    // A name a listing gave whole ("The Root Canal Studio", a place card) is
    // trusted as written, "The" and all.
    if (isNoise(n) || (trust !== "trusted" && isNoise(n.split(/\s+/)[0]) && vendorIn(n) !== n)) return;
    if (trust !== "trusted" && isComponentOrChip(n)) return;
    // A name read off the answer's layout is written as a name: "near",
    // "hotels" and "the jetty" are table fragments, not brands.
    if (trust === "structural" && /^[a-z][a-z\s'’.-]*$/.test(n) && !modelMakers.has(n)) return;
    // "Hotel" on its own is the category, never the business.
    if (trust !== "trusted" && GENERIC_VENUE_RE.test(n)) return;
    const k = n.toLowerCase();
    const prev = candidates.get(k);
    const keepWhole = trust === "trusted";
    if (!prev) candidates.set(k, { name: n, category: category || null, description: description || null, keepWhole, shownOnly, weak, needsProse, groups: group ? new Set([group]) : new Set() });
    else {
      // A cited site that matches a name the text already gave ("adidas"
      // from a list item, adidas.co.in among the sources) backs that name;
      // it must not turn it into a site name, which is matched as a squashed
      // label written in capitals and lost "adidas" (live run, 22 Nov 2026).
      if (category === "cited_domain" && !prev.category) { prev.domainBacked = true; return; }
      if (group) (prev.groups = prev.groups || new Set()).add(group);
      if (keepWhole) prev.keepWhole = true;
      if (shownOnly) prev.shownOnly = true;
      if (!weak) prev.weak = false;
      // Corroboration relaxes the bar: a name a marker, product card or
      // header-named table column also vouches for no longer has to prove
      // itself in prose.
      if (!needsProse) prev.needsProse = false;
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
  productNames.forEach((p) => addCand(vendorIn(p), "product_vendor", null, "default", true));
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
    // A seller written as a website ("boat-lifestyle.com + others") is a
    // shop's address, not a brand (1.0.0): it never became "boat-lifestyle.com"
    // beside the real "boAt".
    const merchantName = p.merchant ? String(p.merchant).split(/[+,]/)[0].trim() : "";
    const merchantIsSite = /^[\w-]+(?:\.[\w-]+)+$/.test(merchantName);
    if (p.brand) addCand(p.brand, "product_vendor", null, "default", true);
    else if (merchantName && !merchantIsSite && !isMarketplaceName(merchantName)) {
      addCand(merchantName, "product_vendor");
    } else {
      // A card titled like a listing ("Cloud Based Manufacturing ERP
      // Software", "Erp Next Software For…": Gemini, live run of 22 Nov
      // 2026) starts with a describing word, not its maker: skip a first word
      // the answer writes in lowercase, or in other capitals ("ERP").
      const v = vendorIn(p.name);
      const first = String(v || "").split(/\s+/)[0];
      const otherCase = first && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(first)}(?![\\p{L}\\p{N}])`, "iu").test(text) &&
        ![...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(first)}(?![\\p{L}\\p{N}])`, "giu"))].some((m) => m[0] === first);
      if (!(v && !/\s/.test(v) && (lowercaseIn(text, v) || otherCase))) addCand(v, "product_vendor", null, "default", true);
    }
    // The product's own name starts with its maker ("boAt Rockerz 551", "JBL
    // Tune 520BT", "realme TechLife Studio H1"), whoever sells it (1.0.0):
    // before, a card with a seller named only the seller.
    // Only a name with a model number in it ("Rockerz 551", "Tune 520BT",
    // "Studio H1"): "Modern Gold Drape Bar Necklace" starts with an
    // adjective, and its maker is the seller above. The same rule the
    // structural candidates below use.
    if (!p.brand && p.name && /\d/.test(p.name)) addCand(vendorIn(p.name), "product_vendor", null, "default", true);
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
  const fromModel = new Set();
  const groupByText = new Map();
  const structural = structuralCandidates(answerText || "");
  for (const c of structural) if (c.group && !groupByText.has(c.text)) groupByText.set(c.text, c.group);
  const groupOf = (t) => groupByText.get(t) || null;
  const shared = sharedTailWords(structural.filter((c) => c.source === "section" || c.source === "bullet").map((c) => c.text));
  structural.forEach(({ text: s, source }) => {
    // A heading sometimes names two alternatives at once ("Google Sheets / Excel",
    // "GIMP / Photoshop") — treat each side of " / " as its own candidate instead
    // of evaluating the joined phrase as one (wrong) name.
    // A table cell or list item naming alternatives with "or" is the same
    // ("Real Geeks or Sierra Interactive", "Lofty or BoldTrail (kvCORE)",
    // live run of 22 Nov 2026): read whole, it reported "Real". Only between
    // two capitalised names, so "Black or White" in a heading is split too,
    // but "phones or tablets" never reaches here as a name.
    const alt = / \/ | or (?=[A-Z])/;
    const parts = alt.test(s) ? s.split(/ \/ | or (?=[A-Z])/).map((p) => cleanCandidateText(p.replace(/\s*\([^)]*\)\s*$/, "")) || p.trim()).filter(Boolean) : [s];
    for (const part of parts) {
      // Gemini bolds its section headings ("### **For Family Baths: Storage
      // Water Heaters**"), so bold-vs-plain does not separate a name from a
      // section label. Both heading kinds are therefore weak; a table's first
      // column stays strong, since that column IS the subject by construction.
      const weak = source === "section" || source === "heading" || source === "bullet";
      // Only headings and bold labels have to prove themselves. Table cells
      // do not: which COLUMN they came from is already decided on evidence
      // (see parseTableCells), and gating the cells as well cost real brands
      // in every table whose products the prose never re-narrates. Nor does
      // a list item's own bold subject (1.0.0): "- **Cremica High Bran
      // Biscuits**: fibre-rich…" is about Cremica even if the prose never
      // says the name again. Spec labels in that shape ("**Battery**: …")
      // are common words the answer also writes in lowercase, and go there.
      const needsProse = source === "section" || source === "heading";
      // "Privacy/Security", "Features/riders": two ordinary words joined by a
      // slash label a list item (live run, 22 Nov 2026); a name with a slash
      // in it ("AC/DC") is written in capitals.
      if (source !== "table" && source !== "table-guess" && /^\p{Lu}\p{Ll}+\/\p{L}\p{Ll}+$/u.test(part)) continue;
      const group = source === "section" ? groupOf(s) : null;
      if (looksLikeProperName(part)) {
        // A product named in a heading or list item is reported as its maker
        // when the rest is describing words: "McVitie's Digestive Biscuits"
        // in an answer that says "digestive biscuits" is McVitie's.
        // Only words other item names share are trimmed off a heading that
        // already reads as a name: "Google Sheets" stays whole although the
        // answer says "sheets"; "McVitie's Digestive" loses "Digestive" when
        // another pick is a "… Digestive Cookies" too.
        const trimmed = source === "example" ? trimDescriptors(answerText || text, part, shared)
          : (source === "section" || source === "bullet") ? trimDescriptors("", part, shared) : part;
        addCand(trimmed, null, null, "structural", false, weak, needsProse, group);
        continue;
      }
      // A cell under a name header written wholly as a name ("Bank of
      // Maharashtra", "Central Bank of India", "State Bank of India (SBI)":
      // Gemini's "Lender" column, live run of 22 Nov 2026) is that name, not
      // its first word.
      if (source === "table") {
        const whole = part.replace(/\s*\(\p{Lu}{2,}\)\s*$/u, "").trim();
        const w = whole.split(/\s+/);
        // An organisation's name, not a product's: it joins words ("of",
        // "&") or ends in what it is ("Bank", "Finance"). "Noise Airwave Max
        // XR" and "Royal Canin Labrador Puppy" are a maker plus a model.
        const org = w.slice(1).some((x) => /^(?:of|de|la|and|&|for)$/.test(x)) ||
          /^(?:Banks?|Finance|Financial|Insurance|Assurance|Capital|Securities|Housing|University|College|Institute|School|Academy|Hospitals?|Clinic|Healthcare|Group|Holdings|Limited|Ltd|Inc|Corp|Corporation|Company|Co|Bancorp|Trust|Fund|Credit|Union|Motors|Airlines?|Airways|Telecom|Communications)$/.test(w[w.length - 1]);
        if (org && w.length >= 2 && w.length <= 6 && !/\d/.test(whole) && w.every((x, i) => /^\p{Lu}/u.test(x) || (i > 0 && /^(?:of|de|la|and|&|for|the)$/.test(x)))) {
          addCand(whole, null, null, "structural", false, weak, needsProse, group);
          continue;
        }
      }
      // A venue is named whole: "Trekkers Hostel 12" and "Hotel Summit 9"
      // are businesses, not the maker "Trekkers" plus a model number.
      // Not a sentence-case label that happens to hold a venue word: "Clinic
      // locations" headed a list in a live run (22 Nov 2026).
      if (VENUE_WORD_RE.test(part) && /[A-Z]/.test(part) && !/^\p{Lu}\p{Ll}*(?:\s+\p{Ll}[\p{Ll}'’-]*)+$/u.test(part.trim())) { addCand(part, null, null, "structural", false, weak, needsProse, group); continue; }
      const hasDigit = /\d/.test(part);
      const words = part.trim().split(/\s+/);
      // A long product label ("Patanjali Ragi Digestive Cookies") is its
      // maker plus words the answer uses as ordinary words: trimmed of those,
      // what is left is the brand (1.0.0). A sentence-case phrase ("Homemade
      // atta, ragi, or oats biscuit") is a description, not a name.
      const lastWord = words[words.length - 1].replace(/[^\w]/g, "").toLowerCase();
      if (!hasDigit && words.length > 1 && /^[A-Z]/.test(words[0]) && !CATEGORY_PLURAL_NOUNS.has(lastWord)) {
        const sentenceCase = words.slice(1).every((w) => /^[a-z,.'’&-]+$/.test(w));
        // Two words count too when it's a list item's label: "Team features",
        // "Practical advice" and "Entry-level alternative" were reported as
        // the brands Team, Practical and Entry-level (live run, 22 Nov 2026).
        // A table's first column can be conditions, not names (1.0.2): "If
        // you are | What to buy" rows "Lactose intolerance", "Strict vegan"
        // were reported as the brands Lactose and Strict (live run, 22 Nov
        // 2026). A name in a table is written as one: "Whey Isolate", not
        // "Whey isolate".
        if (sentenceCase && (words.length >= 3 || source === "bullet" || source === "heading" || source === "section" || source === "table" || source === "table-guess")) continue;
        if (source !== "table" && source !== "table-guess") {
          const trimmed = trimDescriptors(answerText || text, part, shared);
          if (trimmed !== part && looksLikeProperName(trimmed)) { addCand(trimmed, null, null, "structural", false, weak, needsProse, group); continue; }
          // Only a list item's subject falls back to its first word. A
          // section heading that isn't a name once trimmed is a category
          // ("Millet & Zero-Refined-Sugar Options"), never a brand.
          if (source === "bullet" || source === "example") { addCand(vendorIn(part), null, null, "structural", false, weak, needsProse, group); continue; }
        }
      }
      // vendorFromProductName only makes sense on a multi-word phrase — it
      // extracts the LEADING token of a longer name ("Vivo V70" → "Vivo"). On
      // a single bare token it just returns that token unchanged, which isn't
      // "vendor extraction" at all — it's accepting the word as-is. That's how
      // a stray slash-separated fragment like "CS2" (from "For Valorant / CS2
      // / BGMI → Kreo Harpy") used to read as a brand: it has a digit, so the
      // digit-fallback fired, but there was nothing to extract a vendor FROM.
      const multiWord = part.trim().split(/\s+/).length > 1;
      // "Budget-friendly", "Entry-level": a describing word, not a name.
      if (!multiWord && /^\p{Lu}\p{Ll}+-\p{Ll}+$/u.test(part.trim())) continue;
      // One word that opens on its number ("91springboard", "1mg",
      // "7Eleven") is a name written that way, not a model with no maker:
      // read for its maker, it came out empty (1.0.2, live run 22 Nov 2026).
      if (!multiWord && /^\d+\p{L}{3,}[\p{L}\p{N}]*$/u.test(part.trim())) { addCand(part.trim(), null, null, "structural", false, weak, needsProse, group); continue; }
      // …and one that ends on it, as a list item's subject: "**Bitrix24 (Free
      // Plan)**" (1.0.7: its plan in brackets now goes, and the bare word
      // was dropped as a model with no maker). Four letters or more first:
      // "K13", "X200" and "CS2" are still model fragments.
      if (!multiWord && (source === "bullet" || source === "heading" || source === "section") && /^\p{Lu}\p{L}{3,}\d{1,3}$/u.test(part.trim())) { addCand(part.trim(), null, null, "structural", false, weak, needsProse, group); continue; }
      if (source === "table" || source === "table-guess" || (hasDigit && multiWord)) {
        // A maker followed by a model number ("Noise Buds VS104") is a name
        // even when the answer also uses the word ("noise cancellation").
        // So is one followed by more capitalised words ("Noise Airwave Max
        // XR"); "Oats biscuit" is a description and gets no such pass.
        const titled = multiWord && part.trim().split(/\s+/).slice(1).some((w) => /^[A-Z]/.test(w));
        if (multiWord && (hasDigit || titled)) fromModel.add(String(vendorIn(part)).toLowerCase());
        // "adidas Supernova Solution 3", "boAt Rockerz 551" (live run, 22 Nov
        // 2026: adidas was missing from every answer that named it this way).
        // Only one word of three letters or more, and only before a model
        // with a number in it.
        const maker = vendorIn(part);
        if (hasDigit && multiWord && /^[a-z]+$/.test(maker) && maker.length >= 3 && !isNoise(maker) && /\d/.test(part.split(/\s+/).slice(1).join(" "))) modelMakers.add(maker);
        addCand(maker, null, null, "structural", false, weak, needsProse);
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
    if (!candidates.has(headKey) || headKey === k) continue;
    // "Bank of Maharashtra", "Bank of India": a name joined by "of" is one
    // name, never its first word (1.0.2).
    // "by" joins one too: "Wallet by BudgetBakers" is the app's whole name,
    // and a closing "**For detailed budgeting: Wallet.**" must not shorten
    // it (1.0.7, behaviour.test).
    if (/\s(?:of|de|la|&|by)\s/i.test(v.name)) { if (!candidates.get(headKey).keepWhole) candidates.delete(headKey); continue; }
    // Unless the head is only ever the start of this name (1.0.2): "Red"
    // from one table cell must not swallow "Red Tape" when the answer never
    // writes "Red" without "Tape". Then the head goes, the name stays.
    if (vendorIn(v.name).toLowerCase() === v.name.toLowerCase().replace(/[^\w&.'’\s-]/g, "") && !candidates.get(headKey).keepWhole) { candidates.delete(headKey); continue; }
    candidates.delete(k);
  }

  // The other way round (1.0.2): a one-word guess that only ever starts a
  // longer name the capture itself vouches for (a place listing, a marker)
  // is that name's first word, not a brand: "Hi", "Om" and "Bombay" beside
  // the listed clinics "Hi Tech Dental Clinic Bandra", "Om Datta Dental
  // Clinic", "Bombay Dental Specialties" (live run, 22 Nov 2026).
  {
    const plain = text.replace(/[*_`]/g, "");
    for (const [k, v] of [...candidates]) {
      if (v.keepWhole || (v.category !== null && v.category !== "product_vendor") || /\s/.test(v.name)) continue;
      const longer = [...candidates.values()].some((o) => o.keepWhole && o.name.toLowerCase().startsWith(k + " "));
      if (!longer) continue;
      const alone = [...plain.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v.name)}(?![\\p{L}\\p{N}])(\\s+(\\S+))?`, "gu"))]
        .some((m) => !m[2] || !/^\p{Lu}/u.test(m[2]));
      if (!alone) candidates.delete(k);
    }
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
  const pendingHeads = [];
  const scoreCandidates = (list) => {
  for (const cand of list) {
    // ---- prompt-context gates (see "5. prompt context" above) ----
    // Only text-derived candidates are held to these. A name asserted by
    // structured data — an entity marker, a product card, a place listing, a
    // cited domain, the user's own tracked list — has a category set and is
    // exempt: those are facts about the capture, not readings of its layout.
    if (cand.category === null && !cand.domainBacked) {
      // A brand that is also a word ("Noise" next to "noise cancellation")
      // is still written as a name somewhere in the prose; "Sugar" never is.
      // No word has a digit in it: "91springboard", written lowercase as the
      // company writes itself, is a name (1.0.2; it headed a table row and
      // was dropped from a coworking answer, live run of 22 Nov 2026).
      if (!fromModel.has(cand.name.toLowerCase()) && !/\d/.test(cand.name) && lowercaseIn(text, cand.name) && !namedMidSentence(text, cand.name)) continue;
      if (cand.needsProse && proseExists && !namedInProse(text, cand.name) && !(cand.groups && cand.groups.size)) continue;
      if (isPromptEcho(cand.name)) continue;
    }
    // A domain-derived candidate is a squashed label ("hdfcbank"), so it is
    // matched against word runs rather than verbatim — see matchCompressedLabel.
    const isDomain = cand.category === "cited_domain";
    const hits = isDomain
      ? matchCompressedLabel(text, cand.name).filter(
          (h) => !claimed.some(([cs, ce]) => h.start >= cs && h.end <= ce)
        ).filter((h) => writtenAsName(text, h))
      : [...text.matchAll(wordRe(cand.name, "gi"))]
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
    if (cand.weak && hits.length < 2 && !hits.some((h) => !inHeadingLine(text, h.start))) {
      // Kept back, not dropped, when it heads a section with siblings: see
      // the list rule after scoring.
      if (hits.length && cand.groups && cand.groups.size) pendingHeads.push({ cand, hits });
      continue;
    }
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
  };
  scoreCandidates(ordered);

  // A list of things (1.0.0). "### McVitie's Digestive Biscuits", "###
  // Patanjali Ragi Digestive Cookies", "### Mo's Bakery Ragi Cookies": three
  // sibling headings, each a name, each written once. One heading alone is a
  // section label; two or more sibling headings that all read as names are
  // the answer's list of picks, and each is kept.
  if (pendingHeads.length) {
    const byGroup = new Map();
    for (const p of pendingHeads) for (const g of p.cand.groups) {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    const kept = new Set();
    for (const list of byGroup.values()) {
      const named = results.filter((r) => r.groups && [...r.groups].some((g) => byGroup.get(g) === list)).length;
      if (list.length + named < 2) continue;
      for (const { cand, hits } of list) {
        if (kept.has(cand)) continue;
        const free = hits.filter((h) => !claimed.some(([cs, ce]) => h.start >= cs && h.end <= ce));
        if (!free.length) continue;
        kept.add(cand);
        free.forEach((h) => claimed.push([h.start, h.end]));
        results.push({ brand: cand.name, count: free.length, firstIndex: free[0].start, category: cand.category, description: cand.description, passages: [text.slice(Math.max(0, free[0].start - 110), free[0].start + 110).replace(/\s+/g, " ").trim()] });
      }
    }
  }

  // Prose fallback (see "3c. names the prose itself writes"). Deliberately a
  // SECOND pass, not a peer tier: run alongside the others it injects long
  // capitalised runs that win the longest-first claim and starve the real
  // candidates — measured, on this repo's own fixtures, as model fragments
  // ("Nord", "Pixel", "K13") displacing the brands and a six-brand table
  // collapsing to one. Reached only when every other signal produced nothing,
  // it can turn "no brands at all" into the right ones and can disturb
  // nothing that already worked: `claimed` is still empty here, because a
  // claim is only recorded for a candidate that made it into `results`.
  if (!results.length) {
    const proseCands = new Map();
    for (const raw of proseNameCandidates(answerText || "", ctx.sources || [], ctx.prompt || "")) {
      const cleaned = cleanCandidateText(raw);
      if (!cleaned) continue;
      // A name the prose writes without a model number is kept as written
      // (1.0.2): cut to its first word, "Rahul de Cunha Pictures" was "Rahul"
      // and "Parag Parikh Flexi Cap" was "Parag". A longer one keeps its two
      // leading names ("Brooke Bond Red Label Natural" → "Brooke Bond"); one
      // with a model number is still read for its maker ("Motorola Edge 60").
      const w = cleaned.split(/\s+/);
      const part = looksLikeProperName(cleaned) ? cleaned
        : /\d/.test(cleaned) ? vendorIn(cleaned)
        : w.length <= 4 ? cleaned
        : /^\p{Lu}/u.test(w[1] || "") ? w.slice(0, 2).join(" ")
        : vendorIn(cleaned);
      const n = String(part || "").trim().replace(/[*_`]/g, "");
      if (!n || n.length < 2 || n.length > MAX_LEN.structural) continue;
      if (isNoise(n) || isNoise(n.split(/\s+/)[0])) continue;
      if (isComponentOrChip(n) || isMarketplaceName(n)) continue;
      // Re-checked AFTER the head reduction: "India Rockerz 512" survives the
      // phrase-level test and then collapses to the bare qualifier "India".
      // A name kept as the candidate pass vetted it is not re-judged by shape.
      if (n !== cleaned && !isPlausibleProseName(n)) continue;
      if (isPromptEcho(n)) continue;
      const k = n.toLowerCase();
      // Only rejected candidates exist when this runs (results is empty): a
      // label structure turned down ("Pampers Pure Protection is a good first
      // option:") can still be a name the prose has evidence for (1.0.2).
      if (proseCands.has(k)) continue;
      proseCands.set(k, { name: n, category: null, description: null, keepWhole: false, shownOnly: false, weak: false, needsProse: false });
    }
    if (proseCands.size) {
      // Same head-collapse the primary tiers get: "Motorola Edge" must not be
      // reported next to "Motorola".
      for (const [k, v] of [...proseCands]) {
        const words = v.name.split(/\s+/);
        if (words.length < 2) continue;
        const headKey = words[0].toLowerCase();
        if (proseCands.has(headKey) && headKey !== k) proseCands.delete(k);
      }
      scoreCandidates([...proseCands.values()].sort((a, b) => b.name.length - a.name.length));
    }
  }

  // Makers of products named in bold mid-sentence that nothing above found
  // (see boldProductNames). Added only; never replaces or removes a brand.
  for (const name of boldProductNames(answerText || "")) {
    const vendor = vendorIn(name);
    // The same exclusions the other passes make: chips, shops, and dates
    // ("**November 2026**").
    if (!vendor || isNoise(vendor) || isComponentOrChip(name) || isComponentOrChip(vendor) || isMarketplaceName(vendor)) continue;
    if (/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|q[1-4]|fy|h[12])$/i.test(vendor)) continue;
    const key = vendor.toLowerCase();
    if (results.some((r) => { const b = r.brand.toLowerCase(); return b === key || b.startsWith(key + " ") || key.startsWith(b + " ") || name.toLowerCase().startsWith(b + " "); })) continue;
    const hits = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(vendor)}(?![\\p{L}\\p{N}])`, "gu"))];
    if (!hits.length) continue;
    const at = hits[0].index;
    results.push({ brand: vendor, count: hits.length, firstIndex: at, category: null, description: null, passages: [text.slice(Math.max(0, at - 110), at + 110).replace(/\s+/g, " ").trim()] });
  }

  // Names bolded side by side in one sentence (1.0.2): "Strong options
  // include **Refine Labs** for demand generation, **Directive Consulting**
  // for enterprise…", "use **Babbel** for structured lessons and **Busuu**
  // for conversation". A live run of 22 Nov 2026 kept one of each such list
  // and lost the rest. One bold phrase can be emphasis; two or more
  // name-shaped ones in a sentence are the answer's list of picks. Labels
  // ("**Price:**"), dates, spec terms and the generic nouns stay out.
  {
    const NAME_SHAPE = /^[\p{Lu}\d][\p{L}\p{N}&'’.+-]*(?:\s+(?:[\p{Lu}\d&][\p{L}\p{N}&'’.+-]*|of|and|&|de|la|the|for|von|van))*$/u;
    const LABEL_START = /^(?:Step|Option|Scenario|Tip|Day|Week|Phase|Part|Level|Round|Plan|Tier|Rule|Point|Method|Way|Top|Under|Over|Below|Above|Best|Rs|INR|USD|Price|Pricing|Note|Why|How|What|Which|Pros|Cons|Verdict|Summary|Bottom|Key|Quick|Final|Overall|Budget|Premium|Value|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/;
    const nameish = (s) => NAME_SHAPE.test(s) && s.split(/\s+/).length <= 5 && s.length <= 45 && !LABEL_START.test(s) &&
      !isNoise(s) && (!isNoise(s.split(/\s+/)[0]) || /^The\s+\S/.test(s)) && !isComponentOrChip(s) && !isMarketplaceName(s) &&
      !(!/\s/.test(s) && (GENERIC_SPEC_NOUNS.has(s.toLowerCase()) || CATEGORY_PLURAL_NOUNS.has(s.toLowerCase()))) &&
      !/^[A-Z0-9]{2,4}$/.test(s) && !isPromptEcho(s);
    const have = (n) => results.some((r) => { const b = r.brand.toLowerCase(), k = n.toLowerCase(); return b === k || k.startsWith(b + " ") || b.startsWith(k + " "); });
    // Prose only: a table's bold cells and a heading's are layout, read by
    // the structure pass ("**Low Light**" in a "Best for" column is a use).
    const prose = String(answerText || "").split("\n").filter((l) => !/^\s*(?:\||#{1,6}\s)/.test(l)).join("\n");
    for (const sentence of prose.split(/(?<=[.!?])\s+|\n/)) {
      // A label is not one of the names: "- **Native Portal APIs.** Ensure
      // lead sync from **99acres**, **MagicBricks**…" (AI Mode, 1.0.7).
      const bolds = [...sentence.matchAll(/\*\*([^*\n]{2,60}?)\*\*(?!\s*[:：])/g)]
        .filter((m) => !/[.:]\s*$/.test(m[1]))
        .map((m) => m[1].trim().replace(/[.,;]+$/, ""));
      const names = [...new Set(bolds.filter(nameish))];
      // Two with one already found among them, or three or more.
      if (names.length < 2 || (names.length < 3 && !names.some(have))) continue;
      for (const n of names) {
        // Bolded whole while the list holds only its start ("Asit" for
        // "**Asit Mehta & Associates**"): the bold is the name.
        // Only an organisation's name ("& Associates", "… Consulting"); a
        // product's ("Royal Canin Labrador Puppy") keeps its maker.
        const orgName = /\s&\s|&$/.test(n) || /\s(?:Associates|Partners|Counsellors|Advocates|Solicitors|Consultants|Consulting|Services|Hospitals?|Clinics?|College|University|School|Institute|Academy|Labs?|Studios?|Digital|Media|Group|Agency|Foundation|Trust)$/.test(n);
        const shorter = orgName && results.find((r) => n.toLowerCase().startsWith(r.brand.toLowerCase() + " ") && !r.category);
        if (shorter && !results.some((r) => r.brand.toLowerCase() === n.toLowerCase())) { shorter.brand = n; continue; }
        if (have(n)) continue;
        const hits = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, "gu"))];
        if (!hits.length) continue;
        const at = hits[0].index;
        results.push({ brand: n, count: hits.length, firstIndex: at, category: null, description: null, passages: [text.slice(Math.max(0, at - 110), at + 110).replace(/\s+/g, " ").trim()] });
      }
    }
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

  // Half a name made whole (1.0.2). In a live run of 22 Nov 2026 the answers
  // wrote "Capital One", "Wells Fargo", "IIM Ahmedabad", "Tata AIA", "Asit
  // Mehta & Associates" every time and the brand list said "Capital",
  // "Wells", "IIM", "Tata", "Asit Mehta &". When every mention goes on with
  // the same capitalised word, that word is part of the name if the name
  // ends on "&", the word says what kind of organisation it is, or the
  // engine's own pages write the longer name (a site "capitalone.com", a
  // title "Wells Fargo Active Cash"). A word followed by a model number is a
  // product line ("ASUS TUF A15"), and the maker stays the brand.
  {
    const ORG_WORD = /^(?:Associates|Partners|Counsellors|Advocates|Solicitors|Consultants|Hospitals?|Clinics?|College|University|School|Institute|Academy|Palace|Hotels?|Resorts?|Digital|Media|Group|Bank|Insurance|Finance|Capital|Securities|Labs?|Studios?|Technologies|Foundation|Trust|Center|Centre)$/;
    const sites = new Set((ctx.sources || []).map((s) => String((s && (s.domain || s.url)) || "").replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").split(".")[0].toLowerCase()));
    const titles = (ctx.sources || []).map((s) => String((s && s.title) || ""));
    const STOPW = /^(?:The|And|Or|For|In|On|At|With|Is|Are|By|To|Of|A|An|It|If|But|vs|Vs|VS|Pro|Plus|Max|Ultra|Mini|Lite)$/;
    for (const r of results) {
      for (let step = 0; step < 2; step++) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(r.brand)}(?![\\p{L}\\p{N}])(?:\\*\\*)?[ \\t]+([\\p{Lu}][\\p{L}&’'.-]*)((?:[ \\t]+\\S+){0,3})`, "gu");
        const all = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(r.brand)}(?![\\p{L}\\p{N}])`, "gu"))].length;
        const hits = [...text.matchAll(re)];
        if (!all || hits.length !== all) break;
        const next = hits[0][1].replace(/[.’']+$/, "");
        if (!next || STOPW.test(next) || isNoise(next) || /\d/.test(next) || !hits.every((m) => m[1].replace(/[.’']+$/, "") === next)) break;
        // A model number within the next few words ("Noise Airwave Max XR
        // 120"), or a product-line word written in CamelCase ("realme
        // TechLife", "Wakefit ShapeSense"): the maker stays the brand.
        const after = (m) => text.slice(m.index + m[0].length - (m[2] || "").length, m.index + m[0].length - (m[2] || "").length + 60)
          .replace(/[*_`]/g, " ").trim().split(/\s+/).slice(0, 3);
        if (hits.some((m) => after(m).some((w) => /^[A-Za-z-]*\d/.test(w)))) break;
        if (/\p{Ll}\p{Lu}/u.test(next) || /^\p{Lu}{2,}$/u.test(next)) break;
        const longer = `${r.brand} ${next}`;
        const sq = longer.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        // A one-word brand that is also an ordinary word ("Capital", "Wells",
        // "Blue"): written in lowercase somewhere in the answer or what the
        // engine sent, and never on its own here, it is the first word of
        // the name. The next word is not one of the question's.
        // …and only where the name ends there ("Blue Dart covers…"): one that
        // goes on ("Noise Airwave Max XR") is a product of that maker.
        const endsThere = hits.every((m) => !/^\s*\p{Lu}/u.test(text.slice(m.index + m[0].length - (m[2] || "").length).replace(/^[*_`]+/, "")));
        const ordinary = !/\s/.test(r.brand) && /^\p{Lu}\p{Ll}+$/u.test(r.brand) && hits.length >= 1 && endsThere &&
          !promptTokens.has(next.toLowerCase()) &&
          new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(r.brand.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(
            [text, ...titles, ...(ctx.sources || []).map((s) => String((s && s.snippet) || ""))].join("\n"));
        // (A page title is no evidence here: review titles name products —
        // "Kovo Weave review" — as often as companies.) A name the user
        // tracks is theirs as written, never lengthened.
        const backed = /&$/.test(r.brand) || ORG_WORD.test(next) || sites.has(sq) || ordinary;
        const tracked = (ctx.tracked || []).some((t) => String(t.name || "").trim().toLowerCase() === r.brand.toLowerCase());
        if (!backed || tracked || results.some((o) => o !== r && o.brand.toLowerCase() === longer.toLowerCase())) break;
        r.brand = longer;
      }
    }
  }

  // Last tidy-up of the names (1.0.2, all from a live run of 22 Nov 2026).
  {
    // A map listing's title as its owner keyed it: "Jeff's Corporate Catering
    // & Wedding Catering | Top Catering service for All Events | …", "SIEC
    // Study Abroad, Overseas Education Consultant in New Delhi", "Uptown Rent
    // a Car - Luxury Cars for Rent in Dubai". The name is the first part.
    const listingName = (n) => {
      let s = String(n);
      if (/\s\|\s?|\s?\|\s/.test(s)) s = s.split(/\s*\|\s*/)[0];
      if (s.length > 30) {
        const m = /^(.{3,}?)\s*[-–—]\s+(.+)$/.exec(s) || /^(.{3,}?),\s+(.+)$/.exec(s) || /^(.{3,}?):\s+(.+)$/.exec(s);
        if (m && (/\b(?:in|near|for|at)\s+\p{Lu}/u.test(m[2]) || /,/.test(m[2]) || /\b(?:service|services|consultants?|clinic|company|agency|rental|catering|centre|center|specialist|search|advisory)s?\b/i.test(m[2]) || /^\p{Lu}[\p{L}\s]{2,24}$/u.test(m[2]))) s = m[1];
        // "…Consultants in Delhi", "…School (Arabian Ranches)": where it is.
        s = s.replace(/\s+\([^)]{2,40}\)$/, "").replace(/\s+in\s+\p{Lu}[\p{L}.]+(?:\s+\p{Lu}[\p{L}.]+)?$/u, "");
      }
      return s.replace(/;.*$/, "").trim() || n;
    };
    for (const r of results) {
      const clean = listingName(r.brand);
      if (clean !== r.brand && clean.length >= 2 && !results.some((o) => o !== r && o.brand.toLowerCase() === clean.toLowerCase())) r.brand = clean;
    }
    // One word of the question is what was asked about ("Seoul", "Dubai",
    // "Insurance", "MBA" for "online MBA programs"), not an answer to it —
    // unless the question compares names ("Zerodha vs Groww").
    // Only a word the question sets the scene with ("…in Seoul", "…for
    // WordPress blogs", "…integrates with Shopify"): "best Motorola phone"
    // asks about Motorola, and it stays.
    const prompt = String(ctx.prompt || "").toLowerCase();
    const compares = /\b(?:vs\.?|versus|or|compare[ds]?|better than|between)\b/.test(prompt);
    if (!compares) {
      for (let i = results.length - 1; i >= 0; i--) {
        const b = results[i].brand;
        if (/\s/.test(b) || (ctx.tracked || []).some((t) => String(t.name || "").toLowerCase() === b.toLowerCase())) continue;
        // Read off text or a card's title ("Vitamin" of "Vitamin D3 2000 IU",
        // "Learn" of "Learn Spanish…"); a place or a model-marked entity is
        // a fact about the capture and stays.
        if (results[i].category && !/^(?:cited_domain|product_vendor)$/.test(results[i].category)) continue;
        if (new RegExp(`\\b(?:in|at|near|for|with|from|around|across)\\s+(?:the\\s+)?${escapeRegExp(b.toLowerCase())}\\b`).test(prompt)) { results.splice(i, 1); continue; }
        // The question's own category word, which the answer also writes
        // as a plain word ("Insurance" / "pet insurance", "Solar" / "solar
        // panels"). A brand the question names ("Motorola") never is.
        if (promptTokens.has(b.toLowerCase()) && lowercaseIn(text, b)) results.splice(i, 1);
      }
    }
    // A fragment of a sentence, not a name: "approximately £18/month for…".
    for (let i = results.length - 1; i >= 0; i--) if (/^\p{Ll}{4,}\s/u.test(results[i].brand) && (!results[i].category || results[i].category === "product_vendor")) results.splice(i, 1);
    // An abbreviation the answer spells out ("cash-on-delivery (COD)",
    // "Return to Origin (RTO)") is a term, not a brand: a live campaign of
    // 22 Nov 2026 offered "COD" as a competitor to add.
    for (let i = results.length - 1; i >= 0; i--) {
      const b = results[i].brand;
      if (!/^\p{Lu}{2,6}$/u.test(b) || results[i].category === "place") continue;
      const re = new RegExp(`((?:[\\p{L}]+[\\s-]+){1,6})\\(${escapeRegExp(b)}s?\\)`, "giu");
      const spelled = [...text.matchAll(re)].some((m) => {
        const words = m[1].trim().split(/[\s-]+/).filter((w) => !/^(?:of|on|to|the|and|for|a|an|&)$/i.test(w));
        return words.slice(-b.length).map((w) => w[0].toUpperCase()).join("") === b.toUpperCase();
      });
      if (spelled) results.splice(i, 1);
    }
    // Two names joined by "&" ("DTDC & Delhivery", a Gemini table cell in a
    // live campaign of 22 Nov 2026) are two brands when the answer also
    // writes each one on its own; "Johnson & Johnson" and "Marks & Spencer"
    // never do, and stay whole.
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      const m = /^(.{2,40}?)\s+&\s+(.{2,40})$/.exec(r.brand);
      if (!m || r.category === "place" || r.keepWhole) continue;
      const sides = [m[1].trim(), m[2].trim()];
      if (sides[0].toLowerCase() === sides[1].toLowerCase()) continue;
      const alone = (s) => {
        const all = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}(?![\\p{L}\\p{N}])`, "gu"))].length;
        const joined = [...text.matchAll(new RegExp(escapeRegExp(r.brand), "gu"))].length;
        return all - joined;
      };
      const counts = sides.map(alone);
      if (counts.some((c) => c < 1)) continue;
      results.splice(i, 1);
      for (const [j, s] of sides.entries()) {
        const have = results.find((o) => o.brand.toLowerCase() === s.toLowerCase());
        // Its own mentions plus the joined ones.
        const n = counts[j] + r.count;
        if (have) { have.count = Math.max(have.count, n); continue; }
        const at = text.search(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}(?![\\p{L}\\p{N}])`, "u"));
        results.push({ brand: s, count: n, firstIndex: at >= 0 ? at : r.firstIndex, category: null, description: null, passages: r.passages });
      }
    }
  }

  // A brand's short name counts as the brand (1.0.2). A Perplexity answer
  // named "BHIVE" four times and "BHIVE Workspace" once, in its table, and
  // reported BHIVE named once, fourth: it was named first. Only a short name
  // shaped like a name of its own ("BHIVE", "WeWork", "M3M") and no other
  // brand here starts with ("Tata" of "Tata Nexon" and "Tata Curvv" is not).
  for (const r of results) {
    const words = r.brand.split(/\s+/);
    if (words.length < 2) continue;
    const head = words[0];
    if (!(/^\p{Lu}{3,}$/u.test(head) || /\p{Ll}\p{Lu}/u.test(head) || /\d/.test(head)) || isNoise(head)) continue;
    if (results.some((o) => o !== r && (o.brand === head || o.brand.split(/\s+/)[0] === head))) continue;
    const headHits = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(head)}(?![\\p{L}\\p{N}])`, "gu"))].map((m) => m.index);
    const fullAt = new Set([...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(r.brand)}(?![\\p{L}\\p{N}])`, "giu"))].map((m) => m.index));
    const extra = headHits.filter((i) => !fullAt.has(i));
    if (!extra.length) continue;
    r.count += extra.length;
    if (extra[0] < r.firstIndex) {
      r.firstIndex = extra[0];
      const p = text.slice(Math.max(0, extra[0] - 110), extra[0] + 110).replace(/\s+/g, " ").trim();
      if (!r.passages.includes(p)) r.passages.unshift(p);
    }
  }

  // Names listed beside a found brand (1.0.4): "I can estimate the total cost
  // for Asian Paints, Berger and Nerolac" kept Asian Paints and lost the
  // other two (stress run, 23 Nov 2026). The list rule for short answers only
  // runs when nothing else was found; a list that holds one brand already is
  // a list of brands. Split on commas, "and", "or" — never "&", so "Marks &
  // Spencer" stays one name — and each name passes the same checks.
  {
    const have = new Set(results.map((r) => r.brand.toLowerCase()));
    const NAME = "[A-Z][\\p{L}0-9.'’-]*(?: [A-Z][\\p{L}0-9.'’-]*){0,2}";
    // "A, B and C", and "A vs B vs C" ("compare Asian Paints vs Berger vs Nerolac").
    const LIST = new RegExp(`${NAME}(?:(?:, | vs\\.? )${NAME})*,? (?:and|or|vs\\.?) ${NAME}`, "gu");
    const flat = text.replace(/\*\*/g, "");
    for (const m of flat.matchAll(LIST)) {
      const items = m[0].split(/, (?:and |or )?| (?:and|or|vs\.?) /).map((s) => s.trim().replace(/[.'’]+$/, "")).filter(Boolean);
      // A sentence's opening word ("For Asian Paints, …"), not a word a
      // region shares with a brand ("Asian").
      const OPENERS = /^(?:in|at|on|for|to|with|by|from|the|a|an|of|near|under|over|across|between|like|including|both|either)$/i;
      while (items.length && items[0].includes(" ") && (isNoise(items[0].split(" ")[0]) || OPENERS.test(items[0].split(" ")[0]))) items[0] = items[0].split(" ").slice(1).join(" ");
      if (items.length < 2 || !items.some((it) => have.has(it.toLowerCase()))) continue;
      for (const it of items) {
        const k = it.toLowerCase();
        if (!it || have.has(k) || isNoise(it) || isNoise(it.split(" ")[0]) || PROMPT_STOPWORDS.has(k) || promptTokens.has(k) || !looksLikeProperName(it)) continue;
        const hits = [...flat.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(it)}(?![\\p{L}\\p{N}])`, "gu"))].map((x) => x.index);
        if (!hits.length) continue;
        have.add(k);
        const at = text.indexOf(it);
        results.push({ brand: it, count: hits.length, firstIndex: at >= 0 ? at : hits[0], category: null, description: null, passages: [flat.slice(Math.max(0, hits[0] - 110), hits[0] + 110).replace(/\s+/g, " ").trim()], relation: null });
      }
    }
  }

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
