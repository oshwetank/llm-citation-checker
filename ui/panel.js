/* panel.js — UI. Talks to the service worker; never touches storage directly. */

// The one exception to "never touches storage directly": exportDoc.js is a
// pure rendering module (record[] -> HTML string), no chrome.* / storage
// calls of its own — see src/lib/exportDoc.js header. Data still only ever
// arrives here via send()/hydrate() through the service worker.
import { buildExportModel, renderStandaloneHtml } from "../src/lib/exportDoc.js";
import {
  ENGINES, availableEngines, MAX_PROFILES, SENTIMENT_NOTE, TRASH_RETENTION_DAYS,
  partitionRecords, allTags, runDue, runVolume, makeProfile,
} from "../src/lib/geo.js";
import { parseCsv, parseXlsx, rowsToPrompts } from "../src/lib/xlsxLite.js";
import { matchCompressedLabel, vendorFromProductName } from "../src/lib/brands.js";

const send = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false })));

// Detect popup vs full-tab so the layout adapts (and survives browser zoom).
function applyMode() {
  const isTab = window.innerWidth > 640 || window.location.href.includes("mode=tab");
  document.documentElement.classList.toggle("tab", isTab);
  document.documentElement.classList.toggle("popup", !isTab);
  document.body.classList.toggle("tab", isTab);
  document.body.classList.toggle("popup", !isTab);
}
applyMode();
window.addEventListener("resize", applyMode);

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
  return n;
};
const esc = (s) => (s == null ? "" : String(s));

let RECORDS = [];
let PROJECTS = [];
let dashboardCampaignId = ""; // "" = no campaign selected
let dashboardGeoPrompts = []; // tracked prompts for dashboardCampaignId (tag chips only — independent of the Campaigns tab's own GEO_PROMPTS)
let dashboardSearch = ""; // filters Saved Conversations (and the ad-hoc stat grid) by prompt text
let viewingId = null; // which capture the Analyze tab shows (null = latest)
let selectedIds = new Set(); // captures ticked in the Saved Conversations table
let showEmptyCaptures = false; // reveal zero-signal rows (see hasSignal note below)
// Tracking-run captures are hidden from the ad-hoc views by default so brand
// measurements and casual browsing never contaminate each other's numbers.
let includeTrackedInAdhoc = false;
let TRACKED_COUNT = 0;
// GEO tab state
let GEO_PROFILES = [];
let TRASHED_PROFILES = []; // soft-deleted campaigns, still within the recovery window
let GEO_PROMPTS = [];
let geoActiveId = null;
let geoTagFilter = [];
let geoEngineFilter = [];
// Campaigns tab (formerly Tracking + Loader) state
let promptTagFilter = []; // tag chips selected in the prompt table sidebar
let promptOnlyUnassigned = false;
let promptSearch = "";
let campaignManageOpen = false; // collapsible setup/prompts panel once a campaign is locked
let selectedPromptIds = new Set(); // checked rows in the prompt table, for bulk pause/enable/remove
const ONBOARD_KEY = "lcfc.onboarding.campaignsDismissed";
let campaignOnboardDismissed = true; // flips to false once we've checked storage, if unset
chrome.storage.local.get(ONBOARD_KEY, (r) => { campaignOnboardDismissed = !!r[ONBOARD_KEY]; });

// A capture with no prompt AND no fan-out/sources/products/places/answer text.
// ChatGPT's client races requests in parallel (force_parallel_switch:"auto",
// auto_switcher_race_winner) and retries — a losing/interrupted request still
// hits our capture endpoint but streams almost nothing. These are legitimate
// captures (raw data is kept, nothing is discarded), just not useful to browse,
// so the list hides them by default with a toggle to reveal.
function hasSignal(r) {
  const fan = (r.fanout.search.length || 0) + (r.fanout.shopping.length || 0) + (r.fanout.image.length || 0);
  return !!(r.userPrompt || fan || r.sources.length || r.products.length || (r.places && r.places.length) || r.answerChars);
}

function fanoutRows(records) {
  const rows = [["platform", "prompt", "bucket", "query", "capturedAt"]];
  records.forEach((r) =>
    ["search", "shopping", "image"].forEach((b) =>
      (r.fanout[b] || []).forEach((q) =>
        rows.push([r.platform, r.userPrompt || "", b, q.query, new Date(r.capturedAt).toISOString()])
      )
    )
  );
  return rows;
}
// Cell values come from web page titles/snippets, which we don't control. A value
// starting with = + - @ (or a lone tab/CR) is executed as a FORMULA by Excel and
// Sheets, so prefix those with an apostrophe. Quotes are doubled and every cell is
// quoted so embedded commas/newlines can't break the row structure.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function csvOf(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}
function fanoutCsv(records) {
  return csvOf(fanoutRows(records));
}
// Every render*() function tears down and rebuilds its whole tab's DOM from
// scratch (no diffing) — the simplest, most robust option for a codebase
// this size, but a full teardown mid-scroll otherwise snaps the view back to
// the top on every filter/search change, which reads as a jarring "glitch"
// rather than a filtered update. This restores the scroll position of
// whichever container actually scrolls (the popup's capped-height
// .app-content, or the page itself in the full-tab view) around a render.
function withScrollPreserved(renderFn) {
  const scroller = document.body.classList.contains("popup") ? $(".app-content") : (document.scrollingElement || document.documentElement);
  const y = scroller ? scroller.scrollTop : 0;
  renderFn();
  if (scroller) scroller.scrollTop = y;
}

function showTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (btn) btn.classList.add("active");
  const panel = document.getElementById(name);
  if (panel) panel.classList.add("active");
}
// List records omit heavy fields (answerText, reasoning) to keep the popup fast.
// Analyze needs the full record, so hydrate just the one being viewed and cache it.
const FULL = new Map();
async function hydrate(captureId) {
  if (!captureId) return null;
  if (FULL.has(captureId)) return FULL.get(captureId);
  const r = await send({ type: "get-record", captureId });
  const rec = r.ok ? r.record : null;
  if (rec) FULL.set(captureId, rec);
  return rec;
}

async function openCapture(captureId) {
  viewingId = captureId;
  showTab("analyze");
  await hydrate(captureId);
  renderAnalyze();
}

async function load() {
  const res = await send({ type: "get-records" });
  // ISOLATION — the one place tracking data is separated from browsing data.
  // Everything downstream (Analyze, Dashboard, Compare, every export, the
  // drill-downs) reads RECORDS, so filtering here means a brand-tracking run
  // can never inflate the ad-hoc Dashboard's counts or pollute the Compare
  // prompt list. Tracking responses are reached only through the Tracking tab,
  // which asks the service worker for computed metrics instead. Do not add a
  // second filter downstream; add it here or it will drift.
  const all = res.ok ? res.records : [];
  const parts = partitionRecords(all);
  RECORDS = includeTrackedInAdhoc ? all : parts.adhoc;
  TRACKED_COUNT = parts.tracked.length;
  const pr = await send({ type: "project-list" });
  PROJECTS = pr.ok ? pr.projects : [];
  await loadGeo(); // populates GEO_PROFILES/GEO_PROMPTS so Dashboard can show campaign performance
  // Pre-hydrate whichever capture Analyze is about to show.
  const showing = viewingId || (RECORDS[0] && RECORDS[0].captureId);
  await hydrate(showing);
  renderAnalyze();
  renderDashboard();
  const s = await send({ type: "stats" });
  const st = $("#status");
  if (st) st.textContent = s.ok ? `${s.derived} captures stored` : "";
  renderStorageInfo(s);
  // After PROJECTS is populated, so the project picker can be filled.
  refreshComparePickers();
  renderCompare();
}

function renderStorageInfo(s) {
  const box = $("#storageInfo");
  if (!box) return;
  if (!s || !s.ok) { box.textContent = ""; return; }
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
  box.textContent = s.usage
    ? `Storage: ${mb(s.usage.usedBytes)} used of ~${mb(s.usage.quotaBytes)} available · ${s.raw} raw / ${s.derived} derived captures`
    : `${s.raw} raw / ${s.derived} derived captures`;
}

function projectName(id) {
  const p = PROJECTS.find((x) => x.id === id);
  return p ? p.name : null;
}

function downloadData(filename, content) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeText(t) {
  if (!t) return "";
  let text = String(t);
  text = text.replace(/[\uE200-\uE202]?products\{[^}]*\}[\uE200-\uE202]?/gi, ""); // Remove products carousel tokens
  text = text.replace(/products\{"selections":\[[^\]]*\]\}/gi, ""); // Remove selections JSON
  text = text.replace(/entity\[[^\]]*\]/gi, ""); // Remove internal ChatGPT SSE entity annotations
  text = text.replace(/image_group\{[^}]*\}/gi, ""); // Remove JSON leaks
  text = text.replace(/[\uE200-\uE202][^\uE200-\uE202\n]*[\uE200-\uE202]?/g, ""); // Remove PUA cite markers
  text = text.replace(/\*\*/g, ""); // Strip markdown bold asterisks
  text = text.replace(/\*/g, ""); // Strip italic asterisks
  text = text.replace(/\|/g, " "); // Replace table pipes with space
  text = text.replace(/\-{2,}/g, " "); // Remove markdown table dash dividers
  text = text.replace(/#(?:[a-f0-9]{3,6}|[a-z0-9_-]+)/gi, ""); // Remove markdown header hashes
  text = text.replace(/Phone\s+Best\s+For|Phone\s+Approx\.?\s+Price|Best\s+For\s+Approx\.?\s+Price/gi, ""); // Remove table headers
  return text.replace(/\s+/g, " ").trim();
}

function cleanPassage(p) {
  if (!p) return "";
  let text = sanitizeText(p);
  if (text.length > 180) {
    text = text.slice(0, 180) + "…";
  }
  return text;
}

function escapeRegExp(s) {
  return (s || "").replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

// Rejects table scaffolding and listicle boilerplate captured instead of a real
// "Best for …" category. It used to reject any text containing "price" or
// "phone", which threw away legitimate categories in both directions — a phone
// answer could not have a phone category, and "price transparency" was dropped
// in every vertical. The tests below are about shape and filler, not subject.
function isGenericHeaderOrNoise(str) {
  if (!str) return true;
  const s = String(str).trim();
  if (s.length < 3 || s.length > 60) return true;
  if (/^[\s\-—–|:.]+$/.test(s)) return true; // a separator row, not a category
  if (/-{4,}|\|{2,}/.test(s)) return true; // markdown table scaffolding
  // Fragments that restate the listicle rather than naming a use case.
  if (/^(you can buy|right now|approx\.?|approximately|overall|today|in \d{4})\b/i.test(s)) return true;
  return false;
}

function extractBrandModels(brandName, products, rawText) {
  const models = new Set();
  const lowerBrand = brandName.toLowerCase();
  
  // 1. Check products list first
  for (const p of products || []) {
    if (p.name && p.name.toLowerCase().includes(lowerBrand)) {
      let m = sanitizeText(p.name).replace(new RegExp(`^${escapeRegExp(brandName)}\\s*`, "i"), "").trim();
      if (m && m.length > 1 && m.length < 50) models.add(m);
    }
  }
  
  // 2. Extract model phrases following brand name in sanitized text
  const clean = sanitizeText(rawText);
  if (clean) {
    const escaped = escapeRegExp(brandName);
    const lineRegex = new RegExp(`\\b${escaped}\\s+([A-Za-z0-9\\-\\(\\)]+(?:\\s+[A-Za-z0-9\\-\\+\\(\\)]+){0,4})`, "gi");
    let match;
    while ((match = lineRegex.exec(clean)) !== null) {
      let phrase = match[1].trim();
      const words = phrase.split(/\s+/);
      const modelWords = [];
      for (const w of words) {
        // A model name is a proper noun or a part number — "Nord CE6 5G",
        // "Galaxy S25 Ultra", "OPC 53 Grade". An all-lowercase word is ordinary
        // prose, so the name ended at the previous word.
        //
        // Without this the regex just swallowed the next five words of the
        // sentence, which only looked acceptable on phone answers because model
        // names happen to follow the brand there. In other verticals it
        // produced flatly wrong output — "HDFC Bank" was credited with a model
        // called "offers personal loans at competitive", "Apollo Hospitals"
        // with "runs cardiac centres nationwide" — and it leaked on phones too
        // ("Galaxy S25 Ultra leads").
        if (!/^[A-Z]/.test(w) && !/\d/.test(w)) break;
        modelWords.push(w);
      }
      let modelName = modelWords.join(" ").trim();
      modelName = modelName.replace(/[\(\)]/g, " ").replace(/\s+/g, " ").trim();
      if (modelName && modelName.length > 1 && modelName.length < 45) {
        models.add(modelName);
      }
    }
  }
  
  return Array.from(models).slice(0, 5);
}

function extractRankAndCategory(brandName, passage, text) {
  const fullText = sanitizeText((text || "") + "\n" + (passage || ""));
  const escapedBrand = escapeRegExp(brandName);
  
  let rank = null;
  let category = null;

  // 1. Match numbered list header: e.g. "1. OnePlus 13 (Best Overall)" or "1. OnePlus 13 - Overall flagship value"
  const listRegex = new RegExp(
    `(?:^|\\n)\\s*(\\d+)\\.\\s+.*?\\b${escapedBrand}\\b.*?(?:[\\(–\\-—:]\\s*([^\\n\\)]+))?`,
    "i"
  );
  const listMatch = fullText.match(listRegex);
  if (listMatch) {
    rank = `#${listMatch[1]}`;
    if (listMatch[2]) {
      const candidate = listMatch[2].trim();
      if (!isGenericHeaderOrNoise(candidate)) {
        category = candidate;
      }
    }
  }

  // 2. Match summary callout: e.g. "Best for: Gaming, photography..." or "Best overall: OnePlus 13"
  if (!category) {
    const summaryRegex = new RegExp(
      `(?:Best\\s+for|Best\\s+overall|Best\\s+camera|Best\\s+gaming|Best\\s+compact)[\\s:]+.*?\\b${escapedBrand}\\b|(?:^|\\n)\\s*Best\\s+for:\\s*([^\\n.,]+)`,
      "i"
    );
    const summaryMatch = fullText.match(summaryRegex);
    if (summaryMatch && summaryMatch[1] && !isGenericHeaderOrNoise(summaryMatch[1])) {
      category = summaryMatch[1].trim();
    }
  }

  return { rank, category };
}

// Takes the brand's OWN passages (b.passages — each already a tight, correctly
// scoped ±110-char window around one real mention, computed by the adapter/
// src/lib/brands.js) instead of re-deriving a window from the full answer
// text. The previous version re-scanned a fresh 350-char slice of raw text
// and cut it off at the next hardcoded smartphone-brand name it could find —
// in dense side-by-side comparisons (several brands named within a couple of
// sentences of each other, e.g. a TV shootout) that cutoff landed almost
// immediately, so real aspects a few words later were silently missed. Using
// the passage(s) already scoped to THIS brand's own mentions avoids that
// failure mode entirely, and scanning every passage (not just the first)
// catches aspects raised at a brand's later mentions too.
//
// Aspects come from two places, in order of trust:
//
//  1. What the answer SAYS it rates the brand for — "best for <x>", "known for
//     <x>", "stands out for <x>". The label is lifted from the sentence, so it
//     works in any vertical without knowing a single industry word ("low
//     processing fees", "same-day delivery", "crack resistance").
//  2. A curated dimension map, as a fallback for answers that describe a brand
//     without ever labelling why. This used to be phone specs ONLY — camera,
//     battery, display, chipset — so a cement or lending answer either got
//     nothing or, worse, got "Performance" off the word "speed" and "Design"
//     off "premium". The map now spans the dimensions any category gets
//     compared on, and the phone-specific triggers only fire on words that
//     genuinely mean a phone spec.
const ASPECT_DIMENSIONS = [
  ["Price & Value", /\b(price|pricing|cost|affordable|budget|value for money|cheaper|expensive|premium pricing|discount|emi)\b/],
  ["Fees & Rates", /\b(interest rate|interest rates|apr|processing fee|processing fees|brokerage|commission|charges|no annual fee|expense ratio)\b/],
  ["Quality", /\b(quality|grade|purity|strength|finish|craftsmanship|ingredients|material|materials)\b/],
  ["Durability", /\b(durability|durable|long[- ]lasting|weather resistant|crack resistan|warranty|wear and tear)\b/],
  ["Service & Support", /\b(customer (?:service|support|care)|after[- ]sales|helpline|turnaround time|claim settlement|onboarding)\b/],
  ["Availability", /\b(availability|widely available|in stock|distribution network|dealer network|branches|nationwide|delivery time)\b/],
  ["Trust & Reputation", /\b(trusted|reputation|reliable|legacy|established|market leader|credibility|certified|regulated|iso )\b/],
  ["Safety", /\b(safety|safe for|side effects|clinically|dermatologically|non[- ]toxic|fda|hypoallergenic)\b/],
  ["Sustainability", /\b(sustainab|eco[- ]friendly|recycl|carbon|green building|organic|cruelty[- ]free)\b/],
  ["Camera", /\b(camera|cameras|megapixel|telephoto|portrait mode|hasselblad|optical zoom)\b/],
  ["Battery", /\b(battery|mah|fast charging|wireless charging|battery backup)\b/],
  ["Display", /\b(display|screen|amoled|oled|refresh rate|120hz|ltpo|hdr|dolby vision)\b/],
  ["Performance", /\b(processor|chipset|snapdragon|dimensity|benchmark|ram|cpu|gpu|thermal throttl)\b/],
  ["Software", /\b(software update|os update|years of updates|user interface|bloatware|ecosystem)\b/],
];

// "Best for gaming and photography" → "gaming and photography". Bounded to a
// short noun phrase so a whole sentence never becomes a chip.
const ASPECT_PHRASE_RE =
  /\b(?:best|ideal|great|good|preferred|recommended|popular|known|noted|praised|valued|stands out)\s+(?:choice\s+)?for\s+(?:its\s+)?([a-z][a-z0-9 &/,'-]{2,40}?)(?=[.,;:!?)]|\band\b\s+(?:it|they|the)\b|$)/gi;
const ASPECT_PHRASE_STOP = /^(the|a|an|you|those|them|it|this|that|these|him|her|us|people|users|customers|anyone|everyone|most|some|many)\b/i;

function extractBrandAspects(passages) {
  const raw = sanitizeText((passages || []).join(" "));
  if (!raw) return [];
  const text = raw.toLowerCase();

  const aspects = [];
  const seen = new Set();
  const push = (label) => {
    const k = label.toLowerCase();
    if (!seen.has(k)) { seen.add(k); aspects.push(label); }
  };

  // 1. aspects the answer states outright
  let m;
  ASPECT_PHRASE_RE.lastIndex = 0;
  while ((m = ASPECT_PHRASE_RE.exec(raw))) {
    const phrase = m[1].trim().replace(/\s+/g, " ").replace(/[,'-]+$/, "");
    if (phrase.length < 3 || ASPECT_PHRASE_STOP.test(phrase)) continue;
    if (phrase.split(/\s+/).length > 5) continue;
    push(phrase.charAt(0).toUpperCase() + phrase.slice(1));
    if (aspects.length >= 3) return aspects;
  }

  // 2. fall back to the dimension map
  for (const [label, re] of ASPECT_DIMENSIONS) {
    if (re.test(text)) push(label);
    if (aspects.length >= 3) break;
  }

  return aspects.slice(0, 3);
}

// The vocabulary the Search-Funnel card scans source snippets with.
//
// This used to be a hardcoded list of 20 phone/laptop makers, which meant the
// whole "Evaluated vs. Omitted" card silently found nothing outside consumer
// electronics — lending, cement, healthcare, beverages and every other vertical
// got an empty card that looked like "nothing was omitted" rather than "this
// never ran". The names now come from what the automatic detector already found
// in THIS capture (src/lib/brands.js — entity markers, product/place data and
// cited domains), so it carries no industry vocabulary of its own.
//
// Two things are deliberately NOT in this vocabulary, because tested against
// real captures both filled the card with confident nonsense:
//   - source domains. Most retrieved sources are publishers, so domain-derived
//     names surfaced "Gadgets360" and "Smartprix" as omitted BRANDS. Requiring
//     another domain to name them too was not enough to separate a brand being
//     written about from the site writing about it.
//   - retailers/merchants. A seller that stocks the product ("Flipkart",
//     "Reliance Digital + others") is not one of the brands being evaluated —
//     src/lib/brands.js draws the same line for the same reason.
// What remains is precise: the card stays silent rather than inventing an
// omission, and it still catches the case that matters most — a product the
// model was SHOWN (carousel/place data) and chose not to narrate.
function buildBrandVocabulary(rec) {
  const vocab = new Map(); // normalized key -> display name
  // "Angel One" and the angelone.in label are one company; keying on
  // letters-and-digits only keeps them from being reported as two, one of
  // which then looks "omitted" purely because of the space.
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

  return vocab;
}

// Which vocabulary entries actually appear in one source's title/snippet.
// Matching goes through matchCompressedLabel so a squashed name still lines up
// with how the snippet writes it ("hdfcbank" ↔ "HDFC Bank").
function extractBrandsFromText(text, vocab) {
  if (!text || !vocab || !vocab.size) return [];
  const found = [];
  vocab.forEach((display) => {
    const verbatim = new RegExp(`\\b${escapeRegExp(display)}\\b`, "i").test(text);
    if (verbatim || matchCompressedLabel(text, display).length) found.push({ brand: display });
  });
  return found;
}

function openDomainModal(domainName, rec) {
  const existing = document.getElementById("domain-modal-backdrop");
  if (existing) existing.remove();

  const domainSources = rec.sources.filter((s) => s.domain === domainName);
  const citedCount = domainSources.filter((s) => s.outcome === "cited").length;
  const fetchedCount = domainSources.filter((s) => s.outcome === "fetched").length;
  const newsCount = domainSources.filter((s) => s.type === "news").length;

  const backdrop = el("div", { id: "domain-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content" });

  const header = el("div", { className: "modal-header" });
  header.append(
    el("div", { style: "display:flex;align-items:center;gap:8px;" },
      el("h3", { style: "margin:0;font-size:15px;color:var(--fg-primary);" }, domainName),
      el("span", { className: "tag cited" }, `${domainSources.length} URLs`)
    )
  );

  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  closeBtn.onclick = () => backdrop.remove();
  header.append(closeBtn);
  modal.append(header);

  const body = el("div", { className: "modal-body" });

  const statsRow = el("div", { className: "modal-stats-row" },
    el("span", { className: "chip active" }, `Cited: ${citedCount}`),
    el("span", { className: "chip" }, `Fetched: ${fetchedCount}`),
    el("span", { className: "chip" }, `News: ${newsCount}`)
  );
  body.append(statsRow);

  const ul = el("ul", { className: "srclist", style: "margin-top:12px;" });
  domainSources.forEach((s, idx) => {
    const li = el("li", { className: "src-item" });
    const h = el("div", { className: "src-header" });
    h.append(el("span", { className: "url-rank-badge" }, `#${idx + 1}`));
    h.append(el("span", { className: `tag ${s.outcome}` }, s.outcome));
    if (s.type === "news") h.append(el("span", { className: "tag news" }, "news"));
    
    const a = el("a", { href: s.url, target: "_blank", rel: "noreferrer", className: "src-title" }, s.title || s.url);
    h.append(a);
    li.append(h);

    if (s.snippet) {
      const snip = el("div", { className: "url-snippet-box" }, s.snippet.trim());
      snip.append(el("span", { className: "char-badge" }, `[${s.snippet.length}c]`));
      li.append(snip);
    }
    ul.append(li);
  });
  body.append(ul);

  const footer = el("div", { className: "modal-footer" },
    el("button", { className: "btn sm ghost", onclick: () => downloadData(`domain_${domainName}.json`, JSON.stringify(domainSources, null, 2)) }, "Export Domain JSON"),
    el("button", { className: "btn sm primary", onclick: () => backdrop.remove() }, "Done")
  );
  body.append(footer);

  modal.append(body);
  backdrop.append(modal);
  document.body.append(backdrop);
}

function openProductModal(product, rec) {
  const existing = document.getElementById("product-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "product-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content" });

  const header = el("div", { className: "modal-header" },
    el("h3", {}, `📦 ${product.name}`),
    el("button", { className: "modal-close", onclick: () => backdrop.remove() }, "×")
  );

  const body = el("div", { className: "modal-body" });

  // Price & Merchant Breakdown
  const priceInfo = el("div", { className: "card", style: "margin-bottom: 12px; background: rgba(255,255,255,0.75);" },
    el("div", { style: "font-weight: 600; font-size: 14px; color: var(--accent);" }, product.price || "Price specified in response text"),
    el("div", { className: "muted", style: "font-size: 12px; margin-top: 4px;" }, `E-Commerce Merchant: ${product.merchant || "Multiple E-Commerce Retailers"}`),
    el("div", { className: "muted", style: "font-size: 11px; margin-top: 2px;" }, `Rating Source: ${product.rating ? product.rating + " ★ rating aggregated from store metadata & search snippets" : "Rating derived from user evaluation in response"}`)
  );
  body.append(priceInfo);

  // Mentioned Passages & Sources for this Product
  const firstKeyword = (product.name || "").split(/\s+/)[0];
  const matchingSources = (rec.sources || []).filter(s => 
    (s.title || "").toLowerCase().includes(firstKeyword.toLowerCase()) ||
    (s.snippet || "").toLowerCase().includes(firstKeyword.toLowerCase())
  );

  if (matchingSources.length) {
    const srcHeader = el("h4", { style: "margin: 12px 0 6px; font-size: 12px;" }, `Contributing E-Commerce & Web Sources (${matchingSources.length}):`);
    body.append(srcHeader);

    const srcList = el("ul", { className: "srclist" });
    matchingSources.forEach(s => {
      const li = el("li", { className: "src-item" });
      const h = el("div", { className: "src-header" },
        el("span", { className: `tag ${s.outcome}` }, s.outcome),
        el("a", { href: s.url, target: "_blank", rel: "noreferrer", style: "font-weight: 600; font-size: 12px; text-decoration: none; color: var(--accent);" }, s.domain || s.url)
      );
      li.append(h);
      if (s.title) li.append(el("div", { style: "font-size: 11px; font-weight: 500; margin-top: 4px;" }, s.title));
      if (s.snippet) li.append(el("div", { className: "brand-quote", style: "margin-top: 4px;" }, `"${cleanPassage(s.snippet)}"`));
      srcList.append(li);
    });
    body.append(srcList);
  } else {
    body.append(el("div", { className: "muted", style: "font-size: 11px;" }, "Product mentioned directly in ChatGPT's answer text. No external store domain was directly linked."));
  }

  modal.append(header, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove();
  };
}

function scrollToCard(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("card-highlight");
  setTimeout(() => target.classList.remove("card-highlight"), 1800);
}

function showToast(text) {
  const old = $(".app-toast");
  if (old) old.remove();

  const toast = el("div", { className: "app-toast" },
    el("div", { className: "toast-dot" }),
    el("span", {}, text)
  );
  document.body.append(toast);
  
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Listen for captured items broadcasted from background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "new-capture") {
    load();
    showToast("New LLM citation captured!");
  }
});

/* ---------- Analyze (most recent capture) ---------- */
function renderAnalyze() {
  try {
    const root = $("#analyze");
    root.textContent = "";
    // A specifically-requested, already-hydrated capture (viewingId) wins
    // outright — even a TRACKED one not present in the ad-hoc RECORDS list
    // (e.g. opened via Prompt Performance's "click a prompt" link). Without
    // this, RECORDS.find() below would silently miss it (tracked captures
    // are deliberately excluded from RECORDS — see the isolation note in
    // load()) and fall back to RECORDS[0], opening the wrong, most-recent
    // AD-HOC capture instead of the one actually clicked.
    let rec = viewingId ? FULL.get(viewingId) : null;
    if (!rec) {
      // Prefer the hydrated full record (carries answerText, which drives brand rank,
      // "cited for" aspects and hero-product detection). Falls back to the light row.
      const light = viewingId ? RECORDS.find((r) => r.captureId === viewingId) || RECORDS[0] : RECORDS[0];
      rec = light ? FULL.get(light.captureId) || light : null;
    }
    if (!rec) {
      root.append(
        el("div", { className: "empty" },
          "No captures yet. Open ChatGPT or Gemini in a tab, run a prompt, then reopen this panel.")
      );
      return;
    }

  // banner when viewing an earlier capture (not the latest)
  if (rec.captureId !== (RECORDS[0] && RECORDS[0].captureId)) {
    const idx = RECORDS.findIndex((r) => r.captureId === rec.captureId);
    const banner = el("div", { className: "viewing" });
    banner.append(el("span", {}, `Viewing capture ${idx + 1} of ${RECORDS.length} (${new Date(rec.capturedAt).toLocaleString()})`));
    const latest = el("button", { className: "linkbtn" }, "Go to latest →");
    latest.onclick = () => { viewingId = null; renderAnalyze(); };
    banner.append(latest);
    root.append(banner);
  }

  const fanCount =
    rec.fanout.search.length + rec.fanout.shopping.length + rec.fanout.image.length;
  const newsCount = rec.sources.filter((s) => s.type === "news").length;
  const citedN = rec.sources.filter((s) => s.outcome === "cited").length;
  const fetchedN = rec.sources.filter((s) => s.outcome === "fetched").length;

  // Split Layout Grid
  const grid = el("div", { className: "analyze-grid" });
  
  // Column 1: Sidebar Cards (General, Technical, Global Stats, Brand Mentions, Summary)
  const sidebar = el("div", { className: "analyze-sidebar" });
  
  // 1. General Information Card
  const meta = el("div", { className: "card", id: "card-general" }, el("h3", {}, "General Information"));
  const kv = el("dl", { className: "kv" });
  const addKv = (k, v) => { kv.append(el("dt", {}, k), el("dd", {}, v)); };
  addKv("User prompt", esc(rec.userPrompt) || "—");
  if (rec.generatedTitle) addKv("Generated Title", esc(rec.generatedTitle));
  addKv("Searched", rec.searched ? "Yes" : "No");
  addKv("Fan-out", String(fanCount));
  addKv("Sources", `${rec.sources.length} (${citedN} cited / ${fetchedN} fetched)`);
  addKv("Captured", new Date(rec.capturedAt).toLocaleString());
  meta.append(kv);
  
  // Carousel Indicators Box
  const carouselBox = el("div", { className: "chips", style: "margin-top:10px;" });
  const car = rec.carousels || {};
  carouselBox.append(
    el("span", { className: `chip ${car.products ? "active" : ""}` }, `Products: ${car.products ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.images ? "active" : ""}` }, `Images: ${car.images ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.news ? "active" : ""}` }, `News: ${car.news ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.map ? "active" : ""}` }, `Map: ${car.map ? "YES" : "NO"}`)
  );
  meta.append(carouselBox);

  const saveRow = el("div", { className: "chips", style: "margin-top:10px; gap:6px;" });
  const saveHtmlBtn = el("button", { className: "btn sm ghost", style: "flex:1" }, "💾 Save as HTML");
  saveHtmlBtn.onclick = () => exportRecordsAsHtml([rec]);
  const savePdfBtn = el("button", { className: "btn sm ghost", style: "flex:1" }, "🖨️ Save as PDF");
  savePdfBtn.onclick = () => exportRecordsAsPdf([rec]);
  saveRow.append(saveHtmlBtn, savePdfBtn);
  meta.append(saveRow);

  const rawBtn = el("button", { className: "btn sm ghost", style: "margin-top:6px; width: 100%;" }, "Download raw payload");
  rawBtn.onclick = () => downloadRaw(rec.captureId, "analyze");
  meta.append(rawBtn);
  sidebar.append(meta);

  // 2. Technical Information Card (RESONEO parity)
  const ps = rec.platformSpecific || {};
  const techCard = el("div", { className: "card", id: "card-technical" }, el("h3", {}, "Technical Information"));
  const techKv = el("dl", { className: "kv" });
  const addTechKv = (k, v) => { if (v) techKv.append(el("dt", {}, k), el("dd", {}, String(v))); };
  addTechKv("Author", ps.author || (rec.searched ? "tool:web" : "assistant"));
  const tools = {
    "chatgpt": "ChatGPT Web Search Engine (SonicBrowserTool)",
    "gemini": "Google Search Tool (Gemini)",
    "perplexity": "Perplexity Search Engine",
    "claude": "Claude Search Tool",
    "grok": "Grok X Search Engine"
  };
  addTechKv("Tool Name", rec.searched ? (tools[rec.platform] || "Web Search Tool") : "—");
  
  const modelDefault = rec.platform === "gemini" ? "gemini-1.5-pro" : "gpt-4o";
  addTechKv("Model", rec.model || modelDefault);
  addTechKv("Plan Type", ps.planType || "free");
  if (ps.clusterRegion) addTechKv("Cluster Region", ps.clusterRegion);
  addTechKv("Turn Use Case", rec.turnUseCase || "shopping");
  if (ps.ttfvtMs) addTechKv("TTFVT", `${(ps.ttfvtMs / 1000).toFixed(2)}s`);
  if (ps.wordCount) addTechKv("Response Word Count", `${ps.wordCount} words`);
  if (ps.abExperiment) addTechKv("AB Test", ps.abExperiment);
  
  const refStr = Object.entries(rec.referenceTypes || {})
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  if (refStr) addTechKv("Ref Types", refStr);
  techCard.append(techKv);
  sidebar.append(techCard);

  // 3. Global Statistics Card
  const uniqueDomains = new Set(rec.sources.map((s) => s.domain).filter(Boolean)).size;
  const uniqueUrls = new Set(rec.sources.map((s) => s.url).filter(Boolean)).size;
  const avUrlsPerFan = fanCount > 0 ? (uniqueUrls / fanCount).toFixed(1) : String(uniqueUrls);
  const ratio = rec.sources.length > 0 ? (citedN / rec.sources.length).toFixed(2) : "0.00";
  const diversity = uniqueUrls > 0 ? ((uniqueDomains / uniqueUrls) * 100).toFixed(1) + "%" : "0%";

  const globCard = el("div", { className: "card", id: "card-global-stats" }, el("h3", {}, "Global Statistics"));
  const globGrid = el("div", { className: "stat-row-grid" },
    el("div", { className: "stat-box" }, el("div", { className: "num" }, String(uniqueDomains)), el("div", { className: "lbl" }, "Domains")),
    el("div", { className: "stat-box" }, el("div", { className: "num" }, String(uniqueUrls)), el("div", { className: "lbl" }, "URLs")),
    el("div", { className: "stat-box" }, el("div", { className: "num" }, avUrlsPerFan), el("div", { className: "lbl" }, "URLs / Fan-out")),
    el("div", { className: "stat-box" }, el("div", { className: "num" }, ratio), el("div", { className: "lbl" }, "Cited Ratio")),
    el("div", { className: "stat-box" }, el("div", { className: "num" }, diversity), el("div", { className: "lbl" }, "Domain Diversity"))
  );
  globCard.append(globGrid);
  sidebar.append(globCard);

  // 4. Brand Mentions (with model extraction, ranking, and aspect context)
  if (rec.brandMentions && rec.brandMentions.length) {
    const ALIAS_MAP = {
      "google pixel": "Google",
      "pixel": "Google",
      "galaxy": "Samsung",
      "iphone": "Apple",
      "ipad": "Apple",
      "macbook": "Apple",
      "surface": "Microsoft",
      "rog": "Asus",
      "tuf": "Asus",
      "vivobook": "Asus",
      "ideapad": "Lenovo",
      "thinkpad": "Lenovo",
      "victus": "HP",
      "pavilion": "HP",
      "inspiron": "Dell",
      "alienware": "Dell",
      "legion": "Lenovo",
      "predator": "Acer"
    };

    // Generic words the detector could mistake for a brand — deliberately NOT a
    // place for real brand names. "sony" used to be listed here, which silently
    // dropped every genuine Sony mention (TVs, cameras, audio...) from this
    // card for every industry, permanently — a correctness bug, not a filter.
    const NOISE_BRAND_WORDS = new Set([
      "battery", "software", "camera", "cameras", "display", "performance", "design",
      "overall", "budget", "value", "rating", "phone", "phones", "mobile", "mobiles",
      "recommendation", "recommendations", "processor", "chipset", "storage", "memory",
      "charging", "screen", "gaming", "price", "pros", "cons", "specs", "life",
      "option", "options", "pick", "picks", "android", "ios", "best"
    ]);

    const normalizedBrands = new Map();
    rec.brandMentions.forEach((b) => {
      const lower = (b.brand || "").toLowerCase().trim();
      if (NOISE_BRAND_WORDS.has(lower)) return;
      const canonical = ALIAS_MAP[lower] || b.brand;
      const key = canonical.toLowerCase();
      if (!normalizedBrands.has(key)) {
        normalizedBrands.set(key, { ...b, brand: canonical, passages: [...(b.passages || [])] });
      } else {
        const existing = normalizedBrands.get(key);
        existing.count += b.count;
        if (b.passages && b.passages.length) existing.passages.push(...b.passages);
      }
    });

    const cleanMentions = Array.from(normalizedBrands.values());
    const bc = el("div", { className: "card", id: "card-brand-mentions" }, el("h3", {}, `Brand Mentions (${cleanMentions.length})`));
    const list = el("div", { className: "brand-list" });
    
    cleanMentions.forEach((b) => {
      const item = el("div", { className: "brand-item" });
      const head = el("div", { className: "brand-head" });
      
      const { rank, category } = extractRankAndCategory(b.brand, (b.passages || []).join(" "), rec.answerText || "");
      const brandTitle = el("span", { className: "brand-name" });
      if (rank) {
        brandTitle.append(el("span", { className: "tag rank-tag", style: "margin-right:6px;" }, rank), " ");
      }
      brandTitle.append(b.brand);
      // Label the user's own brand / tracked competitors so share of voice is
      // readable at a glance. Detection itself is automatic and unaffected.
      if (b.relation === "own") {
        brandTitle.append(" ", el("span", { className: "tag cited", title: "Your brand" }, "YOU"));
      } else if (b.relation === "competitor") {
        brandTitle.append(" ", el("span", { className: "tag fetched", title: "Tracked competitor" }, "COMP"));
      }

      // count=0 means "shown in a product/place card, but the model never named
      // it in prose" — a real, useful GEO signal (distinct from actual absence),
      // so it gets its own badge instead of a confusing "×0".
      head.append(
        brandTitle,
        b.count > 0
          ? el("span", { className: "tag mentioned" }, `×${b.count}`)
          : el("span", { className: "tag fetched", title: "Appeared in a product/place card but was not named in the written answer" }, "Shown, not named")
      );
      item.append(head);

      // Extract specific models
      const models = extractBrandModels(b.brand, rec.products, rec.answerText || b.passages[0] || "");
      if (models.length) {
        const modelRow = el("div", { className: "brand-models-row" });
        modelRow.append(el("span", { className: "brand-label" }, "Models:"));
        models.forEach((m) => {
          modelRow.append(el("span", { className: "tag model-tag" }, m));
        });
        item.append(modelRow);
      }

      // Extract cited aspects / intent around this brand — skip for count=0
      // entries, whose "passage" is a synthetic note, not real narration.
      if (b.count > 0) {
        const aspects = extractBrandAspects(b.passages);
        const aspectRow = el("div", { className: "brand-aspects-row" });
        aspectRow.append(el("span", { className: "brand-label" }, "Cited for:"));

        if (category) {
          aspectRow.append(el("span", { className: "tag aspect-tag highlight-aspect" }, category));
        }
        aspects.forEach((asp) => {
          if (!category || !category.toLowerCase().includes(asp.toLowerCase())) {
            aspectRow.append(el("span", { className: "tag aspect-tag" }, asp));
          }
        });
        item.append(aspectRow);
      }

      // A count=0 "shown, not named" passage is our own synthetic note, not real
      // conversation text — a "jump to this passage" link for it would point at
      // text that doesn't exist on the page, so skip the quote block entirely.
      const cleaned = b.count > 0 ? cleanPassage(b.passages[0]) : null;
      if (cleaned) {
        // Deep-link back into the source conversation. `pageUrl` is the field the
        // schema actually carries (there is no `rec.url`), so this used to be a
        // dead link that rendered as clickable but did nothing.
        const textTarget = encodeURIComponent(cleaned.slice(0, 50).trim());
        const quoteUrl = rec.pageUrl ? `${rec.pageUrl}#:~:text=${textTarget}` : null;
        
        const quoteDiv = el("a", {
          className: "brand-quote",
          style: `display: block; text-decoration: none; color: inherit;${quoteUrl ? " cursor: pointer;" : ""}`,
          ...(quoteUrl
            ? { href: quoteUrl, target: "_blank", rel: "noreferrer", title: "Jump to this passage in the conversation" }
            : {}),
        }, quoteUrl ? `"${cleaned}" ↗` : `"${cleaned}"`);
        
        item.append(quoteDiv);
      }
      list.append(item);
    });
    bc.append(list);
    sidebar.append(bc);
  }

  // 4b. Evaluated vs. Omitted (Search Funnel Analysis)
  if (rec.sources && rec.sources.length) {
    const ALIAS_MAP_OMIT = {
      "google pixel": "Google", "pixel": "Google", "galaxy": "Samsung", "iphone": "Apple",
      "ipad": "Apple", "macbook": "Apple", "surface": "Microsoft", "rog": "Asus",
      "tuf": "Asus", "vivobook": "Asus", "ideapad": "Lenovo", "thinkpad": "Lenovo",
      "victus": "HP", "pavilion": "HP", "inspiron": "Dell", "alienware": "Dell",
      "legion": "Lenovo", "predator": "Acer"
    };
    // Words that mean a "model" match actually ran on past the model name into
    // ordinary sentence text — reject anywhere in the candidate, not just a
    // leading word, since a phrase like "Bravia 8 so you do" only fails a
    // leading-word check.
    const FILLER_RE = /\b(so|you|do|the|is|was|are|an|and|but|that|this|which|who|how|why|what|its|it's|from|has|have|will|can|could|would|were)\b/i;

    // Only brands the answer actually NARRATED count as mentioned. A count=0
    // entry is one the model was shown (product carousel, place listing) and
    // never wrote about — the single most useful thing this card can surface,
    // so treating it as "mentioned" would hide exactly the wrong case.
    const mentionedBrandKeys = new Set(
      (rec.brandMentions || [])
        .filter((b) => b.count > 0)
        .map((b) => (ALIAS_MAP_OMIT[b.brand.toLowerCase()] || b.brand).toLowerCase())
    );
    const brandCanonical = new Map(); // lower -> display name
    const brandSourceIdxs = new Map(); // lower -> Set(source index)
    const modelEntries = new Map(); // "brand||model" -> { brand, model, sourceIdxs: Set }

    // Extracted PER SOURCE (title+snippet of one source at a time) rather than
    // one giant blob of every source concatenated — a regex match could
    // previously bleed across the boundary between two unrelated sources'
    // text, which is what produced garbled "model names" that were actually
    // fragments of the next source's sentence.
    const brandVocab = buildBrandVocabulary(rec);
    rec.sources.forEach((s, idx) => {
      const srcText = `${s.title || ""} ${s.snippet || ""}`;
      extractBrandsFromText(srcText, brandVocab).forEach((sb) => {
        const canonical = ALIAS_MAP_OMIT[sb.brand.toLowerCase()] || sb.brand;
        const key = canonical.toLowerCase();
        brandCanonical.set(key, canonical);
        if (!brandSourceIdxs.has(key)) brandSourceIdxs.set(key, new Set());
        brandSourceIdxs.get(key).add(idx);

        const modelRe = new RegExp(`\\b${escapeRegExp(sb.brand)}\\s+([A-Z0-9][a-zA-Z0-9\\-\\.\\s]{1,20})`, "gi");
        let mm; let loopCap = 0;
        while ((mm = modelRe.exec(srcText)) !== null && loopCap++ < 20) {
          if (mm.index === modelRe.lastIndex) modelRe.lastIndex++;
          const candidate = mm[1].trim().split(/[\n,;:\(\)]/)[0].trim();
          if (candidate.length < 2 || candidate.length > 24) continue;
          if (FILLER_RE.test(candidate)) continue;
          if (/^(and|or|with|for|in|under|laptop|phone|price|spec|review)/i.test(candidate)) continue;
          const mKey = `${key}||${candidate.toLowerCase()}`;
          if (!modelEntries.has(mKey)) modelEntries.set(mKey, { brand: canonical, model: candidate, sourceIdxs: new Set() });
          modelEntries.get(mKey).sourceIdxs.add(idx);
        }
      });
    });

    const omittedBrandsList = [];
    const omittedModelsList = [];
    const ansTextLower = (rec.answerText || "").toLowerCase();

    brandCanonical.forEach((canonical, key) => {
      const modelsForBrand = [...modelEntries.values()].filter((m) => m.brand.toLowerCase() === key);
      if (!mentionedBrandKeys.has(key)) {
        omittedBrandsList.push({ brand: canonical, sourceIdxs: [...brandSourceIdxs.get(key)], models: modelsForBrand });
      } else {
        const unmentioned = modelsForBrand.filter((m) => !ansTextLower.includes(m.model.toLowerCase()));
        if (unmentioned.length) omittedModelsList.push({ brand: canonical, omittedModels: unmentioned });
      }
    });

    if (omittedBrandsList.length || omittedModelsList.length) {
      const omitCard = el("div", { className: "card", id: "card-omitted-analysis" },
        el("div", { className: "card-header" },
          el("h3", {}, "Evaluated vs. Omitted (Search Funnel)"),
          el("span", { className: "tag fetched", style: "font-size: 10px;" }, "From Search Snippets")
        ),
        el("div", { className: "muted", style: "font-size: 11px; margin-bottom: 10px; line-height: 1.4;" },
          "Brands and models evaluated in ChatGPT's raw search snippets that were dropped in its final written answer. Click a chip to see which sources it came from."
        )
      );

      // Clicking a brand/model chip reveals the sources whose title/snippet
      // actually contained it — the evidence behind the chip, not just an
      // asserted count, and a real answer to "which sources contributed to
      // this visibility."
      const sourceChip = (label, sourceIdxs, style) => {
        const wrap = el("div", {});
        const chip = el("button", { className: "tag model-tag", style: `cursor:pointer;${style || ""}` }, label);
        const list = el("div", { className: "omit-source-list", style: "display:none" });
        sourceIdxs.forEach((idx) => {
          const s = rec.sources[idx];
          if (!s) return;
          list.append(el("a", { href: s.url, target: "_blank", rel: "noreferrer", className: "omit-source-link" }, s.title || s.domain || s.url));
        });
        chip.onclick = () => { list.style.display = list.style.display === "none" ? "flex" : "none"; };
        wrap.append(chip, list);
        return wrap;
      };

      const omitList = el("div", { className: "brand-list" });

      omittedBrandsList.forEach(ob => {
        const item = el("div", { className: "brand-item", style: "border-left: 3px solid #ef4444;" });
        const head = el("div", { className: "brand-head" },
          el("span", { className: "brand-name", style: "color: #b91c1c;" }, `❌ ${ob.brand}`),
          el("span", { className: "tag danger" }, "Omitted Brand")
        );
        item.append(head);
        item.append(sourceChip(`Seen in ${ob.sourceIdxs.length} source${ob.sourceIdxs.length === 1 ? "" : "s"}`, ob.sourceIdxs));

        if (ob.models.length) {
          const modRow = el("div", { className: "brand-models-row", style: "margin-top: 4px; flex-wrap:wrap;" },
            el("span", { className: "brand-label" }, "Models in Search:"));
          ob.models.forEach((m) => modRow.append(sourceChip(m.model, [...m.sourceIdxs])));
          item.append(modRow);
        }
        omitList.append(item);
      });

      omittedModelsList.forEach(om => {
        const item = el("div", { className: "brand-item", style: "border-left: 3px solid #f59e0b;" });
        const head = el("div", { className: "brand-head" },
          el("span", { className: "brand-name" }, `⚠️ ${om.brand}`),
          el("span", { className: "tag fetched" }, "Omitted Models")
        );
        item.append(head);

        const modRow = el("div", { className: "brand-models-row", style: "margin-top: 4px; flex-wrap:wrap;" },
          el("span", { className: "brand-label" }, "Ignored Models:"));
        om.omittedModels.forEach((m) => modRow.append(sourceChip(m.model, [...m.sourceIdxs], "background: #fef3c7; color: #b45309;")));
        item.append(modRow);
        omitList.append(item);
      });

      omitCard.append(omitList);
      sidebar.append(omitCard);
    }
  }

  // 5. Clickable Summary Card in Sidebar
  {
    const rows = [
      ["Cited (sidebar top)", citedN, "card-sources"],
      ["Fetched (more)", fetchedN, "card-sources"],
      ["News", newsCount, "card-sources"],
      ["Products", rec.products.length, "card-products"],
      ["Images", rec.images.length, "card-images"],
      ["Entities", rec.entities.length, "card-entities"],
      ["Brand mentions", rec.brandMentions.length, "card-brand-mentions"],
    ].filter((r) => r[1] > 0);
    
    if (rows.length) {
      const summaryCard = el("div", { className: "card", id: "card-summary" }, el("h3", {}, "Summary by Type"));
      const t = el("table", { className: "summary-table" });
      t.append(el("tr", {}, el("th", {}, "Link type"), el("th", { className: "num" }, "Count")));
      rows.forEach(([k, v, targetId]) => {
        const tr = el("tr", { className: "summary-row", title: `Click to jump to ${k}` });
        tr.append(el("td", {}, k), el("td", { className: "num" }, String(v)));
        tr.onclick = () => scrollToCard(targetId);
        t.append(tr);
      });
      // Total Row
      const totalRow = el("tr", { style: "font-weight:700; border-top:1px solid var(--border);" },
        el("td", {}, "TOTAL"),
        el("td", { className: "num" }, String(rec.sources.length))
      );
      t.append(totalRow);
      summaryCard.append(t);
      sidebar.append(summaryCard);
    }
  }

  // Column 2: Main Area (Fan-outs, Top Domains, Top URLs, Places, Products)
  const mainCol = el("div", { className: "analyze-main" });

  // 1. Query Fan-Out queries card
  //
  // An empty card used to be hidden outright, which reads as "this answer ran
  // no searches" — misleading on Gemini, which runs them but never publishes
  // the sub-queries (see extractFanout in src/adapters/gemini.js). Say which
  // of the two it is rather than showing nothing.
  if (!fanCount && rec.searched && rec.platform === "gemini") {
    mainCol.append(el("div", { className: "card", id: "card-fanout" },
      el("div", { className: "card-header" },
        el("h3", {}, "Query Fan-Out"),
        el("span", { className: "tag" }, "not exposed by Gemini")
      ),
      el("p", { className: "muted", style: "margin:0" },
        "This answer did search the web, but Gemini does not publish the sub-queries it ran, " +
        "so there is nothing to report here. ChatGPT captures do show them. This is a platform " +
        "limitation, not a failed capture.")
    ));
  }
  if (fanCount) {
    const fc = el("div", { className: "card", id: "card-fanout" },
      el("div", { className: "card-header" },
        el("h3", {}, "Query Fan-Out"),
        el("span", { className: "tag cited" }, `${rec.model || rec.platform || "unknown model"}`)
      )
    );
    let qIdx = 1;
    for (const [bucket, arr] of Object.entries(rec.fanout)) {
      if (!arr.length) continue;
      fc.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, bucket));
      const chips = el("div", { className: "chips" });
      arr.forEach((q) => {
        chips.append(el("span", { className: "chip" }, `${qIdx++}. ${q.query}`));
      });
      fc.append(chips);
    }

    if (rec.products && rec.products.length) {
      fc.append(el("div", { className: "muted", style: "margin-top:10px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, "Shopping Carousel Products"));
      const pChips = el("div", { className: "chips" });
      rec.products.forEach((p, idx) => {
        const renderTag = (p.renderAs || "block").toUpperCase();
        if (renderTag === "HERO") {
          pChips.append(el("span", {
            className: "chip active",
            style: "background: #f59e0b; color: #fff; font-weight: 600; border: 1px solid #d97706; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
          }, `⭐ HERO PICK: ${p.name}`));
        } else {
          pChips.append(el("span", { className: "chip" }, `${idx + 1}. BLOCK · ${p.name}`));
        }
      });
      fc.append(pChips);
    }
    mainCol.append(fc);
  }

  // 2. Top Domains Card
  if (rec.sources.length) {
    const domCount = new Map();
    const domTypes = new Map();
    rec.sources.forEach((s) => {
      if (!s.domain) return;
      domCount.set(s.domain, (domCount.get(s.domain) || 0) + 1);
      const set = domTypes.get(s.domain) || new Set();
      set.add(s.outcome);
      if (s.type === "news") set.add("news");
      domTypes.set(s.domain, set);
    });

    const topDomHead = el("div", { className: "card-header" }, el("h3", {}, `Top Domains (${domCount.size})`));
    const topDomCard = el("div", { className: "card", id: "card-top-domains" }, topDomHead);
    const dt = el("table", {});
    dt.append(el("tr", {}, el("th", {}, "Domain"), el("th", {}, "Type"), el("th", { className: "num" }, "URLs")));
    
    [...domCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([d, count]) => {
      const tagGroup = el("div", { className: "type-tag-group" });
      [...(domTypes.get(d) || [])].forEach((typ) =>
        tagGroup.append(el("span", { className: `tag ${typ === "news" ? "news" : typ}` }, typ))
      );
      const tagCell = el("td", {}, tagGroup);
      
      const domLink = el("button", { className: "linkbtn td-domain-btn", title: `Click for detailed URLs under ${d}` }, d);
      domLink.onclick = () => openDomainModal(d, rec);

      dt.append(el("tr", {}, el("td", { className: "td-domain" }, domLink), tagCell, el("td", { className: "num" }, String(count))));
    });
    topDomCard.append(dt);
    mainCol.append(topDomCard);
  }

  // 3. Top URLs Card (Merged list with Rank, Snippets & Char Counts)
  if (rec.sources.length) {
    const sc = el("div", { className: "card", id: "card-sources" }, el("h3", {}, `Top URLs / Captured Sources (${rec.sources.length})`));
    sc.append(el("p", { className: "muted small", style: "margin:-4px 0 10px" },
      "Snippets are what ChatGPT's search returned for each page, not necessarily the exact sentence that justified a citation — click one to try jumping to that text on the source page itself."));

    // Filter Pills
    const filterBar = el("div", { className: "filter-bar" });
    let activeSrcFilter = "all";
    const renderSrcList = () => {
      ul.textContent = "";
      const filtered = rec.sources.filter((s) => {
        if (activeSrcFilter === "all") return true;
        if (activeSrcFilter === "cited") return s.outcome === "cited";
        if (activeSrcFilter === "fetched") return s.outcome === "fetched";
        if (activeSrcFilter === "news") return s.type === "news";
        return true;
      });

      const order = { cited: 0, fetched: 1, mentioned: 2, unknown: 3 };
      [...filtered].sort((a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9)).forEach((s, idx) => {
        const li = el("li", { className: "src-item" });
        const header = el("div", { className: "src-header" });
        
        header.append(el("span", { className: "url-rank-badge" }, `#${idx + 1}`));
        header.append(el("span", { className: `tag ${s.outcome}` }, s.outcome));
        
        if (s.type === "news") {
          header.append(el("span", { className: "tag news" }, "news"));
        }
        
        const titleLink = el("a", { href: s.url, target: "_blank", rel: "noreferrer", className: "src-title" }, s.title || s.url);
        header.append(titleLink);
        li.append(header);
        
        const snippetText = s.snippet ? s.snippet.trim() : null;
        if (snippetText) {
          const snipBox = el("div", { className: "url-snippet-box" });
          // Text-fragment deep link: jumps to where this exact text appears
          // on the SOURCE page (not the ChatGPT conversation) if the browser
          // can find it verbatim — quietly does nothing if it can't, rather
          // than erroring, since this snippet is what ChatGPT's search
          // returned for the page and isn't guaranteed to be present
          // word-for-word (see the card's note above).
          const textTarget = encodeURIComponent(snippetText.slice(0, 120).trim());
          const fragUrl = s.url ? `${s.url}#:~:text=${textTarget}` : null;
          if (fragUrl) {
            snipBox.append(el("a", {
              href: fragUrl, target: "_blank", rel: "noreferrer", className: "url-snippet-link",
              title: "Try to jump to this text on the source page",
            }, snippetText));
          } else {
            snipBox.append(snippetText);
          }
          snipBox.append(el("span", { className: "char-badge" }, `[${snippetText.length}c]`));
          li.append(snipBox);
        }

        const d = s.platformSpecific && s.platformSpecific.pubDate;
        const dMs = d ? (d > 1e12 ? d : d * 1000) : null; // auto-detect seconds vs milliseconds
        const dateStr = dMs ? new Date(dMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
        const rs = s.platformSpecific && s.platformSpecific.resultSource;
        
        const meta = el("div", { className: "src-meta" });
        meta.append(el("span", { className: "src-domain" }, s.domain || "—"));
        if (dateStr) {
          meta.append(el("span", { className: "src-dot" }, "·"), el("span", {}, dateStr));
        }
        if (rs) {
          meta.append(el("span", { className: "src-dot" }, "·"), el("span", {}, `src: ${rs}`));
        }
        li.append(meta);
        
        ul.append(li);
      });
    };

    const filters = [
      { id: "all", label: `All (${rec.sources.length})` },
      { id: "cited", label: `Cited (${citedN})` },
      { id: "fetched", label: `Fetched (${fetchedN})` },
      { id: "news", label: `News (${newsCount})` },
    ];

    filters.forEach((f) => {
      const p = el("button", { className: `filter-pill ${f.id === "all" ? "active" : ""}` }, f.label);
      p.onclick = () => {
        filterBar.querySelectorAll(".filter-pill").forEach((b) => b.classList.remove("active"));
        p.classList.add("active");
        activeSrcFilter = f.id;
        renderSrcList();
      };
      filterBar.append(p);
    });

    sc.append(filterBar);
    const ul = el("ul", { className: "srclist" });
    sc.append(ul);
    renderSrcList();
    mainCol.append(sc);
  }

  // Places list card
  if (rec.places && rec.places.length) {
    const plc = el("div", { className: "card", id: "card-places" }, el("h3", {}, `Places (${rec.places.length})`));
    const ul = el("ul", { className: "itemlist" });
    rec.places.forEach((p) => {
      const li = el("li", {});
      const head = el("div", { className: "item-head" });
      head.append(el("span", { className: "item-name" }, p.name || "—"));
      if (p.rating != null) {
        const label = p.reviews ? `${p.rating} ★ (${p.reviews.toLocaleString()})` : `${p.rating} ★`;
        head.append(el("span", { className: "tag cited" }, label));
      }
      li.append(head);
      const meta = [p.category, p.priceRange].filter(Boolean).join("  ·  ");
      if (meta) li.append(el("div", { className: "dom" }, meta));
      if (p.address) li.append(el("div", { className: "muted item-sub" }, p.address));
      if (p.hours) li.append(el("div", { className: "muted item-sub" }, `🕒 ${p.hours}`));
      // Contact/verification row: exactly the "is this business represented
      // correctly?" signals a GEO audit cares about — phone, website, map listing.
      const links = el("div", { className: "chips", style: "margin-top:4px" });
      if (p.isOpen != null) links.append(el("span", { className: `tag ${p.isOpen ? "cited" : "fetched"}` }, p.isOpen ? "Open now" : "Closed now"));
      if (p.phone) links.append(el("span", { className: "chip" }, `📞 ${p.phone}`));
      if (p.website) links.append(el("a", { className: "chip", href: p.website, target: "_blank", rel: "noreferrer" }, "🌐 Website"));
      if (p.mapsUrl) links.append(el("a", { className: "chip", href: p.mapsUrl, target: "_blank", rel: "noreferrer" }, "📍 Maps"));
      if (links.childNodes.length) li.append(links);
      ul.append(li);
    });
    plc.append(ul);
    mainCol.append(plc);
  }

  // Products list card
  const allProducts = [...(rec.products || [])];

  // Flag a hero pick when the answer text calls one out by name — but ONLY on
  // a product that's already in the captured shopping data. This used to
  // fabricate a brand-new product (invented price/merchant/rating) whenever
  // the regex match didn't line up with a real product, e.g. matching a
  // stray word like "camera" out of "camera quality is your #1 priority" and
  // presenting it as a ₹44,999 "Official Brand Store" pick that was never in
  // the actual response. An export must never show data the model didn't
  // actually provide, so a miss here just means no hero badge — never a
  // synthesized product.
  if (rec.answerText && /best overall|#1 recommendation|my #1|my pick/i.test(rec.answerText)) {
    const heroMatch = rec.answerText.match(/(?:best overall|#1 recommendation|my #1|my pick)[:\s\-]*\s*\*?\*?([A-Za-z0-9][a-zA-Z0-9\s\-]{2,40})\*?\*?/i);
    if (heroMatch && heroMatch[1]) {
      const heroWords = heroMatch[1].trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      // Require a real product name to share at least two meaningful words
      // with the matched phrase (not just one generic word like "camera" or
      // "phone") before trusting the match.
      const existingHero = allProducts.find((p) => {
        if (!p.name) return false;
        const nameWords = p.name.toLowerCase().split(/\s+/);
        const overlap = heroWords.filter((w) => nameWords.some((nw) => nw.includes(w) || w.includes(nw)));
        return overlap.length >= Math.min(2, heroWords.length);
      });
      if (existingHero) existingHero.isHero = true;
    }
  }

  if (allProducts.length) {
    const pc = el("div", { className: "card", id: "card-products" }, el("h3", {}, `Products (${allProducts.length})`));
    const ul = el("ul", { className: "itemlist" });
    allProducts.forEach((p) => {
      const isHero = !!p.isHero;
      const li = el("li", {
        className: `product-item-card ${isHero ? "hero-product-card" : ""}`,
        style: `cursor: pointer; transition: all 0.2s ease; ${isHero ? "border: 1.5px solid #f59e0b; background: rgba(254,243,199,0.4);" : ""}`,
        title: "Click for merchant details, rating sources, and citation breakdown",
        onclick: () => openProductModal(p, rec)
      });

      const head = el("div", { className: "item-head" });
      const nameSpan = el("span", { className: "item-name", style: "font-weight: 600;" });
      if (isHero) {
        nameSpan.append(el("span", { className: "tag rank-tag", style: "background: #fef3c7; color: #b45309; border: 1px solid #fde68a; margin-right: 6px;" }, "⭐ HERO PICK"));
      }
      nameSpan.append(p.name || "—");
      head.append(nameSpan);

      if (p.rating != null) head.append(el("span", { className: "tag cited" }, `${p.rating} ★`));
      li.append(head);

      const meta = [p.price, p.merchant].filter(Boolean).join("  ·  ");
      if (meta) li.append(el("div", { className: "dom", style: "margin-top: 4px; font-size: 11px; color: var(--fg-muted);" }, `${meta}  ·  Click for e-commerce sources ↗`));
      ul.append(li);
    });
    pc.append(ul);
    mainCol.append(pc);
  }

  // Model reasoning trace
  if (rec.platformSpecific && rec.platformSpecific.reasoning) {
    const rc = el("div", { className: "card", id: "card-reasoning" }, el("h3", {}, "Model reasoning (thinking trace)"));
    rc.append(el("div", { className: "muted", style: "white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px;font-family:'JetBrains Mono',monospace;background:var(--bg-subtle);padding:8px 12px;border-radius:6px;border:1px solid var(--border);" }, rec.platformSpecific.reasoning));
    mainCol.append(rc);
  }

  // Entities card
  if (rec.entities && rec.entities.length) {
    const ec = el("div", { className: "card", id: "card-entities" }, el("h3", {}, `Entities (${rec.entities.length})`));
    const byCat = {};
    rec.entities.forEach((e) => (byCat[e.category] = byCat[e.category] || []).push(e.text));
    Object.entries(byCat).forEach(([cat, list]) => {
      ec.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:600;font-size:11px;" }, cat));
      const chips = el("div", { className: "chips" });
      list.forEach((t) => chips.append(el("span", { className: "chip" }, t)));
      ec.append(chips);
    });
    mainCol.append(ec);
  }

  // Carousel images card
  if (rec.images && rec.images.length) {
    const ic = el("div", { className: "card", id: "card-images" }, el("h3", {}, `Images (${rec.images.length})`));
    const grid = el("div", { className: "imggrid" });
    rec.images.forEach((im) => {
      const fig = el("a", { href: im.url, target: "_blank", rel: "noreferrer", className: "imgcell" });
      fig.append(el("img", { src: im.url, alt: im.title || "", loading: "lazy" }));
      if (im.title) fig.append(el("div", { className: "imgcap" }, im.title));
      grid.append(fig);
    });
    ic.append(grid);
    mainCol.append(ic);
  }

  // Append columns to layout grid
  grid.append(sidebar, mainCol);
  root.append(grid);
  } catch (err) {
    console.error("renderAnalyze failed:", err);
    const root = $("#analyze");
    if (root) {
      root.textContent = "";
      root.append(
        el("div", { className: "card warn-box", style: "margin: 20px; color: #b91c1c;" },
          el("h3", {}, "Render Warning"),
          el("p", {}, `Could not render capture details: ${err.message}`),
          el("p", { className: "muted", style: "font-size: 11px;" }, "Try selecting another capture from the Dashboard.")
        )
      );
    }
  }
}


let dashboardModelFilter = ""; 
let dashboardTimeFilter = "";
let customStartTime = 0;
let customEndTime = 0;
let currentFilteredRecs = [];
let dashboardDrill = null; // which Performance Overview metric is expanded

/* Detail view behind each Performance Overview metric. Always built from the
 * already-filtered records, so the project / model / timeframe selections apply
 * here too rather than silently showing everything. */
function renderDrilldown(recs) {
  if (!dashboardDrill) return null;

  const card = el("div", { className: "drilldown" });
  const titles = {
    captures: "Every capture",
    searched: "Captures that triggered a web search",
    fanout: "Every fan-out query the model issued",
    domains: "Every domain seen",
    cited: "Sources the model actually cited",
    fetched: "Sources fetched but not cited",
  };
  const headRow = el("div", { className: "card-header" }, el("h3", {}, titles[dashboardDrill] || "Details"));
  const close = el("button", { className: "linkbtn" }, "close ✕");
  close.onclick = () => { dashboardDrill = null; renderDashboard(); };
  headRow.append(close);
  card.append(headRow);

  const tableWrap = (rows, headers, exportName) => {
    if (!rows.length) {
      card.append(el("div", { className: "empty" }, "Nothing here for the current filters."));
      return;
    }
    const bar = el("div", { className: "dlbar" });
    bar.append(el("span", { className: "muted" }, `${rows.length} row${rows.length === 1 ? "" : "s"}`));
    const dl = el("button", { className: "btn sm ghost" }, "⬇ CSV");
    dl.onclick = () => download(`citoskeleton-${exportName}-${Date.now()}.csv`, csvOf([headers, ...rows]), "text/csv");
    bar.append(dl);
    card.append(bar);

    const wrap = el("div", { className: "drill-scroll" });
    const t = el("table", { className: "drill-table" });
    // Right-align ONLY genuinely numeric cells. This used to be
    // `i === 0 ? "" : "num"` — i.e. every column but the first — which
    // right-aligned text columns like "Original prompt"/"Platform" and made
    // the table read as ragged nonsense. Testing `typeof` instead of a column
    // index also can't drift when a column is added or reordered.
    const isNum = (c) => typeof c === "number";
    t.append(el("tr", {}, ...headers.map((h, i) =>
      el("th", { className: rows.length && isNum(rows[0][i]) ? "num" : "" }, h))));
    rows.slice(0, 500).forEach((r) =>
      t.append(el("tr", {}, ...r.map((c) => el("td", { className: isNum(c) ? "num" : "" }, String(c))))));
    wrap.append(t);
    card.append(wrap);
    if (rows.length > 500) card.append(el("div", { className: "muted" }, `Showing first 500 of ${rows.length} — export the CSV for all.`));
  };

  const when = (t) => new Date(t).toLocaleString();

  if (dashboardDrill === "captures" || dashboardDrill === "searched") {
    const list = dashboardDrill === "searched" ? recs.filter((r) => r.searched) : recs;
    const rows = list.map((r) => [
      r.userPrompt || "(no prompt)",
      r.platform || "",
      r.model || "",
      when(r.capturedAt),
      (r.fanout.search.length + r.fanout.shopping.length + r.fanout.image.length),
      r.sources.length,
      r.sources.filter((s) => s.outcome === "cited").length,
      (r.brandMentions || []).length,
    ]);
    tableWrap(rows, ["Prompt", "Platform", "Model", "Captured", "Fan-out", "Sources", "Cited", "Brands"], "captures");
  }

  if (dashboardDrill === "fanout") {
    const rows = [];
    recs.forEach((r) => {
      ["search", "shopping", "image"].forEach((bucket) => {
        (r.fanout[bucket] || []).forEach((q) => rows.push([q.query, bucket, r.userPrompt || "", r.platform || "", when(r.capturedAt)]));
      });
    });
    tableWrap(rows, ["Fan-out query", "Type", "Original prompt", "Platform", "Captured"], "fanout-queries");
  }

  if (dashboardDrill === "domains" || dashboardDrill === "cited" || dashboardDrill === "fetched") {
    // Domain-level rollup. For cited/fetched we scope to that outcome so the
    // numbers reconcile with the metric that was clicked.
    const want = dashboardDrill === "domains" ? null : dashboardDrill;
    const agg = new Map();
    recs.forEach((r) => {
      (r.sources || []).forEach((s) => {
        if (!s.domain) return;
        if (want && s.outcome !== want) return;
        const cur = agg.get(s.domain) || { cited: 0, fetched: 0, prompts: new Set(), sample: "" };
        if (s.outcome === "cited") cur.cited++;
        else cur.fetched++;
        if (r.userPrompt) cur.prompts.add(r.userPrompt);
        if (!cur.sample && s.url) cur.sample = s.url;
        agg.set(s.domain, cur);
      });
    });
    const rows = [...agg.entries()]
      .map(([domain, v]) => [domain, v.cited, v.fetched, v.cited + v.fetched, v.prompts.size, v.sample])
      .sort((a, b) => b[3] - a[3]);
    tableWrap(rows, ["Domain", "Cited", "Fetched", "Total", "Prompts", "Example URL"], `${dashboardDrill}-domains`);
  }

  return card;
}

/* ---------- Dashboard (aggregates across all captures) ---------- */
function renderDashboard() { withScrollPreserved(renderDashboardImpl); }
function renderDashboardImpl() {
  const root = $("#dashboard");
  root.textContent = "";

  const now = Date.now();
  let timeLimit = dashboardTimeFilter === "1h" ? now - 3600000 :
                  dashboardTimeFilter === "24h" ? now - 86400000 :
                  dashboardTimeFilter === "7d" ? now - 604800000 : 0;

  const recs = RECORDS.filter((r) => {
    if (dashboardSearch && !(r.userPrompt || "").toLowerCase().includes(dashboardSearch.toLowerCase())) return false;
    if (dashboardModelFilter && r.platform !== dashboardModelFilter) return false;
    if (dashboardTimeFilter === "custom") {
      if (customStartTime && r.capturedAt < customStartTime) return false;
      if (customEndTime && r.capturedAt > customEndTime) return false;
    } else if (timeLimit && r.capturedAt < timeLimit) {
      return false;
    }
    return true;
  });
  currentFilteredRecs = recs;
  if (!recs.length && !RECORDS.length && !GEO_PROFILES.length) {
    root.append(el("div", { className: "empty" }, "No data captured yet. Open ChatGPT or Gemini in a tab and run a query."));
    return;
  }

  let fanTotal = 0, searched = 0, citedTotal = 0, fetchedTotal = 0;
  const domainCount = new Map();
  const domainTypes = new Map();
  const termCount = new Map();
  recs.forEach((r) => {
    if (r.searched) searched++;
    ["search", "shopping", "image"].forEach((b) =>
      (r.fanout[b] || []).forEach((q) => {
        fanTotal++;
        q.query.toLowerCase().split(/\s+/).forEach((w) => {
          if (w.length > 2) termCount.set(w, (termCount.get(w) || 0) + 1);
        });
      })
    );
    r.sources.forEach((s) => {
      if (s.outcome === "cited") citedTotal++;
      else if (s.outcome === "fetched") fetchedTotal++;
      if (s.domain) {
        domainCount.set(s.domain, (domainCount.get(s.domain) || 0) + 1);
        const set = domainTypes.get(s.domain) || new Set();
        set.add(s.outcome);
        if (s.type === "news") set.add("news");
        domainTypes.set(s.domain, set);
      }
    });
  });

  // Top Metric KPI Grid Card
  const overviewCard = el("div", { className: "card" });
  const ovHeader = el("div", { className: "card-header" }, el("h3", {}, "Performance Overview"));
  
  const filterRow = el("div", { className: "header-brand", style: "display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;" });

  // 0. Search — filters captures by prompt text (affects the stat grid,
  // drilldown, and Saved Conversations list below, same as the other filters).
  const searchInp = el("input", { id: "dashboardSearch", type: "text", placeholder: "🔍 Search prompts…", value: dashboardSearch, className: "filter", style: "min-width:140px" });
  searchInp.oninput = () => {
    dashboardSearch = searchInp.value;
    const cursor = searchInp.selectionStart;
    renderDashboard();
    const next = $("#dashboardSearch");
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  filterRow.append(searchInp);

  // 1. Timeframe Filter Container
  const timeContainer = el("div", { style: "display: flex; gap: 8px; align-items: center;" });
  
  const timeSel = el("select", { className: "filter" });
  const timeOpts = [
    { v: "", l: "All Time" },
    { v: "1h", l: "Last Hour" },
    { v: "24h", l: "Last 24 Hours" },
    { v: "7d", l: "Last 7 Days" },
    { v: "custom", l: "Custom..." }
  ];
  timeOpts.forEach(o => {
    const opt = el("option", { value: o.v }, o.l);
    if (o.v === dashboardTimeFilter) opt.selected = true;
    timeSel.append(opt);
  });
  timeSel.onchange = () => { dashboardTimeFilter = timeSel.value; renderDashboard(); };
  timeContainer.append(timeSel);

  if (dashboardTimeFilter === "custom") {
    const startInp = el("input", { type: "datetime-local", className: "filter", style: "width: 140px; padding: 2px 6px;" });
    if (customStartTime) {
      const d = new Date(customStartTime);
      startInp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }
    startInp.onchange = (e) => { customStartTime = e.target.value ? new Date(e.target.value).getTime() : 0; renderDashboard(); };
    
    const endInp = el("input", { type: "datetime-local", className: "filter", style: "width: 140px; padding: 2px 6px;" });
    if (customEndTime) {
      const d = new Date(customEndTime);
      endInp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }
    endInp.onchange = (e) => { customEndTime = e.target.value ? new Date(e.target.value).getTime() : 0; renderDashboard(); };

    timeContainer.append(el("span", { className: "muted" }, "from"), startInp, el("span", { className: "muted" }, "to"), endInp);
  }
  
  filterRow.append(timeContainer);

  // 2. Model Filter
  const modelSel = el("select", { className: "filter" });
  const modelOpts = [
    { v: "", l: "All Models" },
    { v: "chatgpt", l: "ChatGPT" },
    { v: "gemini", l: "Gemini" }
  ];
  modelOpts.forEach(o => {
    const opt = el("option", { value: o.v }, o.l);
    if (o.v === dashboardModelFilter) opt.selected = true;
    modelSel.append(opt);
  });
  modelSel.onchange = () => { dashboardModelFilter = modelSel.value; renderDashboard(); };
  filterRow.append(modelSel);

  // 3. Campaign Filter — picks which campaign's performance shows below.
  // Nothing selected means no campaign section is shown at all (see the
  // "No campaign selected" note further down), rather than silently
  // defaulting to one.
  if (GEO_PROFILES.length) {
    const sel = el("select", { className: "filter" });
    sel.append(el("option", { value: "" }, "No campaign selected"));
    GEO_PROFILES.forEach((p) => {
      const o = el("option", { value: p.id }, p.name || "Untitled");
      if (p.id === dashboardCampaignId) o.selected = true;
      sel.append(o);
    });
    sel.onchange = async () => {
      dashboardCampaignId = sel.value;
      expandedPromptRuns = new Set();
      geoTagFilter = [];
      if (dashboardCampaignId) {
        const qs = await send({ type: "geo-prompt-list", profileId: dashboardCampaignId });
        dashboardGeoPrompts = qs.ok ? qs.prompts : [];
      } else {
        dashboardGeoPrompts = [];
      }
      renderDashboard();
    };
    filterRow.append(sel);
  }

  ovHeader.append(filterRow);
  overviewCard.append(ovHeader);
  // Always in the DOM — this is what used to disappear once a campaign was
  // selected, taking the only way to change or clear the selection with it.
  root.append(overviewCard);

  const selectedCampaign = dashboardCampaignId ? GEO_PROFILES.find((p) => p.id === dashboardCampaignId) : null;
  // Same timeframe the ad-hoc filters above use — campaign performance used
  // to have its OWN separate "Last 7/30/90 days" dropdown, which was a second,
  // inconsistent time filter instead of reusing this one.
  const geoSince = dashboardTimeFilter === "custom" ? (customStartTime || undefined) : (timeLimit || undefined);
  const geoUntil = dashboardTimeFilter === "custom" ? (customEndTime || undefined) : undefined;

  if (!selectedCampaign) {
    // Every metric is clickable and opens a detail view built from the SAME
    // filtered `recs`, so the model / timeframe filters above always apply
    // to the drill-down too. Only shown when no campaign is selected — once
    // one is, this and the campaign KPIs below merge into a single section
    // (see refreshGeoMetrics) instead of two disconnected cards.
    const stats = el("div", { className: "statgrid" });
    const stat = (n, l, key) => {
      const node = el(
        "div",
        { className: `stat clickable-stat${dashboardDrill === key ? " stat-active" : ""}`, title: `Click to break down: ${l}` },
        el("div", { className: "n" }, String(n)),
        el("div", { className: "l" }, l)
      );
      node.onclick = () => {
        dashboardDrill = dashboardDrill === key ? null : key;
        renderDashboard();
      };
      return node;
    };
    stats.append(
      stat(recs.length, "Captures", "captures"),
      stat(searched, "With search", "searched"),
      stat(fanTotal, "Fan-out queries", "fanout"),
      stat(domainCount.size, "Unique domains", "domains"),
      stat(citedTotal, "Cited", "cited"),
      stat(fetchedTotal, "Fetched", "fetched")
    );
    overviewCard.append(stats);
    const drill = renderDrilldown(recs);
    if (drill) overviewCard.append(drill);

    if (GEO_PROFILES.length) {
      root.append(el("div", { className: "empty" }, "No campaign selected — pick one above to see its performance."));
    }
  } else {
    // A campaign is selected: merge its own captures/fan-out/domain overview
    // together with its brand KPIs into the one card refreshGeoMetrics builds,
    // instead of showing the generic ad-hoc overview above it.
    const gc = el("div", { className: "card", id: "geoMetrics" });
    gc.append(el("div", { className: "card-header" }, el("h3", {}, "Campaign Performance")), el("div", { className: "muted small" }, "loading…"));
    root.append(gc);
    refreshGeoMetrics(selectedCampaign, dashboardGeoPrompts, geoSince, geoUntil);

    const pp = el("div", { className: "card", id: "geoPromptTable" });
    pp.append(el("div", { className: "card-header" }, el("h3", {}, "Prompt Performance")), el("div", { className: "muted small" }, "loading…"));
    root.append(pp);
    refreshPromptPerformance(selectedCampaign, dashboardGeoPrompts, geoSince, geoUntil);
  }

  // Saved Conversations + Top Domains are ad-hoc-only (per the isolation rule
  // in geo.js — tracked runs never mix into this data), so they don't apply
  // once a campaign is selected. Prompt Performance + the domain/URL toggle
  // above replace them for that view instead of showing an empty/irrelevant
  // ad-hoc list underneath a campaign's data.
  if (selectedCampaign) return;

  // Split Grid Container
  const grid = el("div", { className: "dashboard-grid" });

  // Main Column: Saved Conversations Card
  const savedCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Saved Conversations")));
  const emptyCount = recs.filter((r) => !hasSignal(r)).length;
  const visibleRecs = showEmptyCaptures ? recs : recs.filter(hasSignal);
  if (emptyCount) {
    const note = el("div", { className: "muted", style: "margin-bottom:8px; font-size:11px;" });
    const toggle = el("button", { className: "linkbtn" }, showEmptyCaptures ? "hide them" : "show them");
    toggle.onclick = () => { showEmptyCaptures = !showEmptyCaptures; renderDashboard(); };
    note.append(
      `${emptyCount} capture${emptyCount === 1 ? "" : "s"} with no prompt/fan-out/sources hidden — `,
      toggle
    );
    savedCard.append(note);
  }

  // Unified Download Toolbar
  const bar = el("div", { className: "dlbar" });
  const sel = () => (selectedIds.size ? visibleRecs.filter((r) => selectedIds.has(r.captureId)) : visibleRecs);
  const lbl = el("span", { className: "muted" });
  const updLbl = () => (lbl.textContent = selectedIds.size ? `${selectedIds.size} Selected` : `All ${visibleRecs.length}`);
  updLbl();
  
  // Trimmed to the formats people actually reach for: a spreadsheet (Excel),
  // structured data for further analysis (CSV), a readable document (HTML),
  // and the raw underlying data for bulk-selected conversations (JSON) — vs.
  // the previous 6-option list where Fan-outs TXT and Print/PDF saw little
  // use. Print/PDF is still available per-conversation from the Analyze tab.
  const dlPicker = el("select", { className: "btn sm ghost dl-picker", style: "border: 1px solid #10b981; color: #10b981; appearance: auto;" });
  const optDefault = el("option", { value: "" }, "Export ▾");
  const optExcel = el("option", { value: "excel" }, "Excel (.xls)");
  const optCsv = el("option", { value: "csv" }, "Detailed CSV");
  const optHtml = el("option", { value: "html" }, "Conversations (HTML)");
  const optJson = el("option", { value: "json" }, "Bulk raw data (JSON)");
  dlPicker.append(optDefault, optExcel, optCsv, optHtml, optJson);

  dlPicker.onchange = async () => {
    const val = dlPicker.value;
    if (!val) return;
    dlPicker.value = ""; // reset
    if (val === "json") download(`citoskeleton-selected-${Date.now()}.json`, JSON.stringify(sel(), null, 2), "application/json");
    else if (val === "excel" || val === "csv") downloadDetailedFormat(sel(), val);
    else if (val === "html") await exportRecordsAsHtml(sel());
  };

  const deleteSelected = el("button", { className: "btn sm danger", style: selectedIds.size ? "margin-left: auto;" : "display:none;" }, `🗑 Delete Selected`);
  deleteSelected.onclick = async () => {
    if (!confirm(`Delete the ${selectedIds.size} selected conversation(s)?`)) return;
    for (const id of selectedIds) {
      await send({ type: "delete-record", captureId: id });
      FULL.delete(id);
    }
    selectedIds.clear();
    load();
  };

  const deleteAll = el("button", { className: "btn sm danger ghost", style: selectedIds.size ? "" : "margin-left: auto;" }, "🗑 Delete All");
  deleteAll.onclick = async () => {
    if (!confirm("Delete all captured conversations? This action cannot be undone.")) return;
    await send({ type: "clear-all" });
    FULL.clear();
    viewingId = null;
    load();
  };

  const clearSel = el("button", { className: "linkbtn", style: selectedIds.size ? "" : "display:none;" }, "clear selection");
  clearSel.onclick = () => { selectedIds.clear(); renderDashboard(); };
  
  const rightGroup = el("div", { style: "display: flex; gap: 8px; margin-left: auto; align-items: center;" });
  rightGroup.append(dlPicker, deleteSelected, deleteAll);

  bar.append(lbl, clearSel, rightGroup);
  savedCard.append(bar);

  const listHeader = el("div", { className: "capture-list-header" });
  const head = el("input", { type: "checkbox", title: "Select all shown" });
  head.checked = visibleRecs.length > 0 && visibleRecs.slice(0, 100).every((r) => selectedIds.has(r.captureId));
  head.onchange = () => {
    visibleRecs.slice(0, 100).forEach((r) => (head.checked ? selectedIds.add(r.captureId) : selectedIds.delete(r.captureId)));
    renderDashboard();
  };
  const selectAllLabel = el("label", { className: "chk", style: "margin: 0;" }, head, "Select all shown");
  listHeader.append(selectAllLabel);
  savedCard.append(listHeader);

  const ul = el("ul", { className: "capture-list" });
  const grouped = new Map();
  visibleRecs.slice(0, 100).forEach((r) => {
    const d = new Date(r.capturedAt).toLocaleDateString();
    const p = (r.userPrompt || "(No prompt)").toLowerCase().trim();
    const key = d + "|" + p;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  });

  Array.from(grouped.values()).forEach((cluster) => {
    cluster.sort((a,b) => a.capturedAt - b.capturedAt);
    let activeIdx = 0;
    
    const card = el("li", { className: "capture-item", style: "flex-direction: column; align-items: stretch; gap: 8px; cursor: default;" });
    
    const renderClusterContent = () => {
      card.textContent = "";
      const activeRecord = cluster[activeIdx];
      const fan = activeRecord.fanout.search.length + activeRecord.fanout.shopping.length + activeRecord.fanout.image.length;
      
      const rawB = el("button", { title: "Download raw payload" }, "Raw");
      rawB.onclick = (e) => { e.stopPropagation(); downloadRaw(activeRecord.captureId, (activeRecord.userPrompt || "capture").slice(0, 24).replace(/\W+/g, "_")); };
      
      const del = el("button", { className: "del-btn", title: "Delete capture" }, "Delete");
      del.onclick = async (e) => {
         e.stopPropagation();
         await send({ type: "delete-record", captureId: activeRecord.captureId });
         load();
      };

      const promptDiv = el("div", { className: "capture-prompt", title: "Open this capture", style: "cursor: pointer; font-weight: 500;" }, activeRecord.userPrompt || "(No prompt text)");
      promptDiv.onclick = () => openCapture(activeRecord.captureId);
      
      const cb = el("input", { type: "checkbox" });
      cb.checked = cluster.every(r => selectedIds.has(r.captureId));
      cb.onchange = (e) => { 
        cluster.forEach(r => {
           if (e.target.checked) selectedIds.add(r.captureId);
           else selectedIds.delete(r.captureId);
        });
        updLbl(); 
        if (typeof mchk !== 'undefined') mchk.checked = false; 
        renderClusterContent(); 
      };

      const metaRow = el("div", { className: "capture-meta", style: "margin-top: 4px;" },
        el("label", { className: "capture-select" }, cb),
        el("span", { className: "capture-date" }, new Date(activeRecord.capturedAt).toLocaleString()),
        el("span", { className: "tag cited" }, `${fan} fan-out`),
        el("span", { className: "tag fetched" }, `${activeRecord.sources.length} src`),
        el("div", { className: "row-actions", style: "margin-left: auto;" }, rawB, del)
      );

      let tabsRow = null;
      if (cluster.length > 1) {
        tabsRow = el("div", { style: "display:flex; align-items: center; gap: 8px; margin-top: 6px; margin-bottom: 4px; flex-wrap: wrap;" });
        
        // Group cluster items by platform
        const byPlatform = {};
        cluster.forEach(r => {
          const p = r.platform || "chatgpt";
          if (!byPlatform[p]) byPlatform[p] = [];
          byPlatform[p].push(r);
        });

        let currentPlat = activeRecord.platform || "chatgpt";
        if (!byPlatform[currentPlat]) currentPlat = Object.keys(byPlatform)[0];

        // Platform Selector Pills
        Object.keys(byPlatform).forEach(plat => {
          const count = byPlatform[plat].length;
          const label = `${plat.charAt(0).toUpperCase() + plat.slice(1)} (${count})`;
          const isSelected = plat === currentPlat;
          
          const btn = el("button", {
            className: `btn sm ${isSelected ? "primary" : "ghost"}`,
            style: "padding: 2px 8px; font-size: 11px; text-transform: capitalize;"
          }, label);
          
          btn.onclick = (e) => {
            e.stopPropagation();
            const firstRec = byPlatform[plat][0];
            activeIdx = cluster.indexOf(firstRec);
            renderClusterContent();
          };
          tabsRow.append(btn);
        });

        // Time Dropdown for current platform if > 1 run
        const platRuns = byPlatform[currentPlat] || [];
        if (platRuns.length > 1) {
          const timeSel = el("select", { className: "filter", style: "padding: 1px 6px; font-size: 11px; height: 24px;" });
          platRuns.forEach(r => {
            const timeStr = new Date(r.capturedAt).toLocaleTimeString("en-GB");
            const opt = el("option", { value: r.captureId }, `Run @ ${timeStr}`);
            if (r.captureId === activeRecord.captureId) opt.selected = true;
            timeSel.append(opt);
          });
          timeSel.onchange = (e) => {
            e.stopPropagation();
            const targetId = timeSel.value;
            const targetIdx = cluster.findIndex(r => r.captureId === targetId);
            if (targetIdx !== -1) {
              activeIdx = targetIdx;
              renderClusterContent();
            }
          };
          tabsRow.append(timeSel);
        }
      }

      card.append(promptDiv);
      if (tabsRow) card.append(tabsRow);
      card.append(metaRow);
    };

    renderClusterContent();
    ul.append(card);
  });
  savedCard.append(ul);
  grid.append(savedCard);

  // Sidebar Column: Top Domains Card
  const topDomains = [...domainCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topDomains.length) {
    // Card list, not a 3-column table: in the narrow sidebar the "Types" column
    // (up to 3 badges) pushed the table wider than its card, squashing long
    // domains like gadgetsnow.indiatimes.com into an unreadable column.
    const sideCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Top Domains")));
    const ul = el("ul", { className: "itemlist" });
    topDomains.forEach(([d, n]) => {
      const li = el("li", {});
      const head = el("div", { className: "item-head" });
      head.append(
        el("span", { className: "item-name domain-name" }, d),
        el("span", { className: "muted", style: "white-space:nowrap" }, `${n} src`)
      );
      li.append(head);
      const tagGroup = el("div", { className: "type-tag-group" });
      [...(domainTypes.get(d) || [])].forEach((typ) =>
        tagGroup.append(el("span", { className: `tag ${typ === "news" ? "news" : typ}` }, typ))
      );
      if (tagGroup.childNodes.length) li.append(tagGroup);
      ul.append(li);
    });
    sideCard.append(ul);
    grid.append(sideCard);
  }

  root.append(grid);
}

/* ---------- exports ---------- */
function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Save conversation" — HTML download. `records` are LIGHT rows (from
// RECORDS/visibleRecs), so each one is hydrated to its full record (with
// answerText) via the same cache used by the Analyze tab before rendering —
// a light record would silently produce an empty answer body otherwise.
async function exportRecordsAsHtml(records) {
  if (!records.length) return;
  const full = [];
  for (const r of records) {
    const rec = await hydrate(r.captureId);
    if (rec) full.push(rec);
  }
  if (!full.length) {
    alert("Couldn't load the selected conversation(s) — try again.");
    return;
  }
  const models = full.map(buildExportModel);
  const docTitle = full.length === 1 ? models[0].prompt : `${full.length} conversations`;
  const html = renderStandaloneHtml(models, { docTitle });
  const name = full.length === 1
    ? `citoskeleton-conversation-${full[0].captureId.slice(0, 8)}.html`
    : `citoskeleton-conversations-${full.length}-${Date.now()}.html`;
  download(name, html, "text/html");
}

// "Print / Save as PDF" — opens ui/export.html in a new tab, which fetches
// its own full records via captureId (see ui/export.js); no need to hydrate
// here. Bulk-composes into one document with a table of contents.
function exportRecordsAsPdf(records) {
  if (!records.length) return;
  if (records.length > 30 && !confirm(`Open a print-ready document for all ${records.length} selected conversations? This can take a moment to load.`)) {
    return;
  }
  const ids = records.map((r) => r.captureId).join(",");
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/export.html?ids=${encodeURIComponent(ids)}`) });
}
function sanitizeXML(s) {
  return String(s || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function downloadDetailedFormat(records, format) {
  if (format === "csv") {
    let output = `CitoSkeleton Audit Log,,,,,,,,,,\n"Prompt-level tracking of ChatGPT search behaviour, cited vs. fetched sources, and query fan-out",,,,,,,,,,\n,,,,,,,,,,\n#,Date,Time,Platform,User Prompt,Search Used,Cited Sources,Cited Count,Fetched Sources,Fetched Count,Total Sources,Fan-Out Query\n`;
    records.forEach((r, i) => {
      const d = new Date(r.capturedAt);
      const dateStr = d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-');
      const timeStr = d.toLocaleTimeString("en-GB");
      const cited = r.sources.filter(s => s.outcome === "cited").map(s => s.domain).join("; ");
      const fetched = r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").map(s => s.domain).join("; ");
      const fan = [...(r.fanout.search||[]), ...(r.fanout.shopping||[]), ...(r.fanout.image||[])].map(f => f.query).join(" | ");
      const row = [i + 1, dateStr, timeStr, r.platform || "chatgpt", `"${(r.userPrompt || "").replace(/"/g, '""')}"`, r.searched ? "Yes" : "No", `"${cited}"`, r.sources.filter(s => s.outcome === "cited").length, `"${fetched}"`, r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").length, r.sources.length, `"${fan.replace(/"/g, '""')}"`];
      output += row.join(",") + "\n";
    });
    download(`citoskeleton-audit-${Date.now()}.csv`, output, "text/csv");
    return;
  }
  
  if (format !== "excel") return;

  // Aggregations
  const totalPrompts = records.length;
  const uniquePromptsMap = new Map();
  let searchedCount = 0;
  let totalCited = 0;
  let totalFetched = 0;
  let minTime = Infinity;
  let maxTime = 0;

  const domainStats = new Map();

  records.forEach(r => {
    if (r.searched) searchedCount++;
    if (r.capturedAt < minTime) minTime = r.capturedAt;
    if (r.capturedAt > maxTime) maxTime = r.capturedAt;

    const p = (r.userPrompt || "(No prompt)").toLowerCase().trim();
    if (!uniquePromptsMap.has(p)) uniquePromptsMap.set(p, { orig: r.userPrompt || "(No prompt)", runs: 0, cited: 0, fetched: 0, total: 0 });
    const pStat = uniquePromptsMap.get(p);
    pStat.runs++;

    r.sources.forEach(s => {
      pStat.total++;
      if (!domainStats.has(s.domain)) domainStats.set(s.domain, { cited: 0, fetched: 0, total: 0 });
      const dStat = domainStats.get(s.domain);
      dStat.total++;
      
      if (s.outcome === "cited") {
        totalCited++;
        pStat.cited++;
        dStat.cited++;
      } else {
        totalFetched++;
        pStat.fetched++;
        dStat.fetched++;
      }
    });
  });

  const uniqueDomainsCount = domainStats.size;
  const totalMentions = totalCited + totalFetched;
  const searchRate = totalPrompts ? ((searchedCount / totalPrompts) * 100).toFixed(1) + "%" : "0%";
  const avgCited = totalPrompts ? (totalCited / totalPrompts).toFixed(1) : "0.0";
  const avgFetched = totalPrompts ? (totalFetched / totalPrompts).toFixed(1) : "0.0";
  const avgTotal = totalPrompts ? (totalMentions / totalPrompts).toFixed(1) : "0.0";

  let mostCited = "", mostCitedCount = 0;
  let mostFetched = "", mostFetchedCount = 0;
  for (const [dom, st] of domainStats.entries()) {
    if (st.cited > mostCitedCount) { mostCitedCount = st.cited; mostCited = dom; }
    if (st.fetched > mostFetchedCount) { mostFetchedCount = st.fetched; mostFetched = dom; }
  }

  const fmtDate = (ts) => {
    if (!ts || ts === Infinity) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-') + " " + d.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit"});
  };

  const pad = (n) => n.toString().padStart(2, '0');
  let durationStr = "0:00:00";
  if (maxTime > minTime) {
    const diff = maxTime - minTime;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    durationStr = `${h}:${pad(m)}:${pad(s)}`;
  }

  // XML Builder
  let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="14"/></Style>
  <Style ss:ID="sHeader"><Font ss:Bold="1"/><Interior ss:Color="#E2EFDA" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sPlatform"><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sFanout"><Interior ss:Color="#BDD7EE" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sPct"><NumberFormat ss:Format="0.0%"/></Style>
  <Style ss:ID="sFloat"><NumberFormat ss:Format="0.0"/></Style>
 </Styles>
`;

  // SHEET 1: Summary
  xml += ` <Worksheet ss:Name="Summary">
  <Table>
   <Column ss:Width="170"/><Column ss:Width="90"/><Column ss:Width="30"/><Column ss:Width="250"/><Column ss:Width="70"/><Column ss:Width="70"/><Column ss:Width="70"/><Column ss:Width="70"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">GEO Citation Audit  |  Summary</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Session-level rollup of search behaviour.</Data></Cell></Row>
   <Row></Row>
   <Row>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">SESSION METRICS</Data></Cell>
    <Cell ss:StyleID="sHeader"></Cell>
    <Cell></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">PROMPT RUN FREQUENCY</Data></Cell>
   </Row>
   <Row>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Metric</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Value</Data></Cell>
    <Cell></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">User Prompt</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Times Run</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Cited</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Fetched</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Total</Data></Cell>
   </Row>
`;

  const smList = [
    ["Total prompts logged", totalPrompts, "Number"],
    ["Unique prompts tested", uniquePromptsMap.size, "Number"],
    ["Prompts with search enabled", searchedCount, "Number"],
    ["Search usage rate", searchRate, "String"],
    ["Unique domains observed", uniqueDomainsCount, "Number"],
    ["Total source mentions", totalMentions, "Number"],
    ["Avg. cited sources / prompt", avgCited, "Number"],
    ["Avg. fetched sources / prompt", avgFetched, "Number"],
    ["Avg. total sources / prompt", avgTotal, "Number"],
    ["Most cited domain", mostCited, "String"],
    ["Most fetched domain", mostFetched, "String"],
    ["Session start", fmtDate(minTime), "String"],
    ["Session end", fmtDate(maxTime), "String"],
    ["Session duration", durationStr, "String"]
  ];

  const promptsArr = Array.from(uniquePromptsMap.values()).sort((a,b) => b.runs - a.runs);
  
  const maxRows = Math.max(smList.length, promptsArr.length);
  for (let i = 0; i < maxRows; i++) {
    xml += `   <Row>\n`;
    if (i < smList.length) {
      xml += `    <Cell><Data ss:Type="String">${sanitizeXML(smList[i][0])}</Data></Cell>\n    <Cell><Data ss:Type="${smList[i][2]}">${sanitizeXML(smList[i][1])}</Data></Cell>\n`;
    } else {
      xml += `    <Cell></Cell>\n    <Cell></Cell>\n`;
    }
    
    xml += `    <Cell></Cell>\n`;
    
    if (i < promptsArr.length) {
      const p = promptsArr[i];
      xml += `    <Cell><Data ss:Type="String">${sanitizeXML(p.orig)}</Data></Cell>\n    <Cell><Data ss:Type="Number">${p.runs}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.cited/p.runs).toFixed(1)}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.fetched/p.runs).toFixed(1)}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.total/p.runs).toFixed(1)}</Data></Cell>\n`;
    }
    xml += `   </Row>\n`;
  }
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 2: Audit Log
  xml += ` <Worksheet ss:Name="Audit Log">
  <Table>
   <Column ss:Width="30"/><Column ss:Width="80"/><Column ss:Width="60"/><Column ss:Width="80"/>
   <Column ss:Width="250"/><Column ss:Width="60"/><Column ss:Width="250"/><Column ss:Width="50"/>
   <Column ss:Width="250"/><Column ss:Width="50"/><Column ss:Width="50"/><Column ss:Width="250"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">GEO Citation Audit  |  Audit Log</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Prompt-level tracking of search behaviour</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">#</Data></Cell>
    <Cell><Data ss:Type="String">Date</Data></Cell>
    <Cell><Data ss:Type="String">Time</Data></Cell>
    <Cell><Data ss:Type="String">Platform</Data></Cell>
    <Cell><Data ss:Type="String">User Prompt</Data></Cell>
    <Cell><Data ss:Type="String">Search Used</Data></Cell>
    <Cell><Data ss:Type="String">Cited Sources</Data></Cell>
    <Cell><Data ss:Type="String">Cited Count</Data></Cell>
    <Cell><Data ss:Type="String">Fetched Sources</Data></Cell>
    <Cell><Data ss:Type="String">Fetched Count</Data></Cell>
    <Cell><Data ss:Type="String">Total Sources</Data></Cell>
    <Cell><Data ss:Type="String">Fan-Out Query</Data></Cell>
   </Row>
`;
  records.forEach((r, i) => {
    const d = new Date(r.capturedAt);
    const dateStr = d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-');
    const timeStr = d.toLocaleTimeString("en-GB");
    const cited = r.sources.filter(s => s.outcome === "cited").map(s => s.domain).join("; ");
    const fetched = r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").map(s => s.domain).join("; ");
    const fan = [...(r.fanout.search||[]), ...(r.fanout.shopping||[]), ...(r.fanout.image||[])].map(f => f.query).join(" | ");
    
    xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${dateStr}</Data></Cell>
    <Cell><Data ss:Type="String">${timeStr}</Data></Cell>
    <Cell><Data ss:Type="String">${r.platform || "chatgpt"}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(r.userPrompt)}</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">${r.searched ? "Yes" : "No"}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(cited)}</Data></Cell>
    <Cell><Data ss:Type="Number">${r.sources.filter(s => s.outcome === "cited").length}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(fetched)}</Data></Cell>
    <Cell><Data ss:Type="Number">${r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").length}</Data></Cell>
    <Cell ss:StyleID="sPlatform"><Data ss:Type="Number">${r.sources.length}</Data></Cell>
    <Cell ss:StyleID="sFanout"><Data ss:Type="String">${sanitizeXML(fan)}</Data></Cell>
   </Row>\n`;
  });
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 3: Source Analysis
  xml += ` <Worksheet ss:Name="Source Analysis">
  <Table>
   <Column ss:Width="40"/><Column ss:Width="180"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="100"/><Column ss:Width="90"/><Column ss:Width="90"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">GEO Citation Audit  |  Source Analysis</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Domain-level frequency across every cited and fetched source</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">Rank</Data></Cell>
    <Cell><Data ss:Type="String">Domain</Data></Cell>
    <Cell><Data ss:Type="String">Times Cited</Data></Cell>
    <Cell><Data ss:Type="String">Times Fetched</Data></Cell>
    <Cell><Data ss:Type="String">Total Appearances</Data></Cell>
    <Cell><Data ss:Type="String">Share of Cited</Data></Cell>
    <Cell><Data ss:Type="String">Share of All</Data></Cell>
   </Row>
`;
  const domainArr = Array.from(domainStats.entries()).map(([domain, stats]) => ({ domain, ...stats }));
  domainArr.sort((a, b) => b.total - a.total);
  
  domainArr.forEach((d, i) => {
    const shareCited = totalCited > 0 ? (d.cited / totalCited) : 0;
    const shareAll = totalMentions > 0 ? (d.total / totalMentions) : 0;
    xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(d.domain)}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.cited}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.fetched}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.total}</Data></Cell>
    <Cell ss:StyleID="sPct"><Data ss:Type="Number">${shareCited}</Data></Cell>
    <Cell ss:StyleID="sPct"><Data ss:Type="Number">${shareAll}</Data></Cell>
   </Row>\n`;
  });
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 4: Domain Data
  xml += ` <Worksheet ss:Name="Domain Data">
  <Table>
   <Column ss:Width="60"/><Column ss:Width="80"/><Column ss:Width="200"/><Column ss:Width="250"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">GEO Citation Audit  |  Domain Data</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Raw extract — one row per domain appearance.</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">Prompt #</Data></Cell>
    <Cell><Data ss:Type="String">Type</Data></Cell>
    <Cell><Data ss:Type="String">Domain</Data></Cell>
    <Cell><Data ss:Type="String">User Prompt</Data></Cell>
   </Row>
`;
  records.forEach((r, i) => {
    r.sources.forEach(s => {
      xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${s.outcome === "news" ? "Fetched" : s.outcome.charAt(0).toUpperCase() + s.outcome.slice(1)}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(s.domain)}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(r.userPrompt)}</Data></Cell>
   </Row>\n`;
    });
  });
  xml += `  </Table>\n </Worksheet>\n`;

  /* ---- Generic sheet builder for the remaining detail tables ----
   * Everything the extension extracts should be in the workbook, one row per
   * item, each row carrying the prompt + timestamp so any sheet can be pivoted
   * or filtered on its own without cross-referencing another tab.
   */
  const addSheet = (name, subtitle, widths, headers, rows) => {
    xml += ` <Worksheet ss:Name="${sanitizeXML(name)}">\n  <Table>\n`;
    widths.forEach((w) => (xml += `   <Column ss:Width="${w}"/>`));
    xml += `\n   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">GEO Citation Audit  |  ${sanitizeXML(name)}</Data></Cell></Row>\n`;
    xml += `   <Row><Cell><Data ss:Type="String">${sanitizeXML(subtitle)}</Data></Cell></Row>\n   <Row></Row>\n`;
    xml += `   <Row ss:StyleID="sHeader">\n`;
    headers.forEach((h) => (xml += `    <Cell><Data ss:Type="String">${sanitizeXML(h)}</Data></Cell>\n`));
    xml += `   </Row>\n`;
    if (!rows.length) {
      xml += `   <Row><Cell><Data ss:Type="String">No data of this type in the selected captures.</Data></Cell></Row>\n`;
    }
    rows.forEach((row) => {
      xml += `   <Row>\n`;
      row.forEach((cell) => {
        const isNum = typeof cell === "number" && Number.isFinite(cell);
        xml += `    <Cell><Data ss:Type="${isNum ? "Number" : "String"}">${isNum ? cell : sanitizeXML(cell)}</Data></Cell>\n`;
      });
      xml += `   </Row>\n`;
    });
    xml += `  </Table>\n </Worksheet>\n`;
  };

  const stamp = (r) => new Date(r.capturedAt).toLocaleString("en-GB");

  // Full source detail — the Domain Data sheet only carries the domain, which
  // loses the actual page that was cited.
  const sourceRows = [];
  records.forEach((r, i) => {
    (r.sources || []).forEach((s) => {
      sourceRows.push([
        i + 1, r.userPrompt || "", stamp(r), s.outcome || "", s.type || "",
        s.domain || "", s.title || "", s.url || "",
        (s.platformSpecific && s.platformSpecific.resultSource) || "",
        (s.snippet || "").slice(0, 400),
      ]);
    });
  });
  addSheet("Sources (full)", "Every cited and fetched source with its page title, URL and snippet.",
    [60, 200, 120, 70, 70, 140, 240, 300, 90, 400],
    ["Prompt #", "Prompt", "Captured", "Outcome", "Type", "Domain", "Page title", "URL", "Retrieval", "Snippet"],
    sourceRows);

  // Fan-out queries, one row each.
  const fanRows = [];
  records.forEach((r, i) => {
    ["search", "shopping", "image"].forEach((bucket) => {
      (r.fanout[bucket] || []).forEach((q) => fanRows.push([i + 1, r.userPrompt || "", stamp(r), bucket, q.query || ""]));
    });
  });
  addSheet("Fan-Out Queries", "Each sub-query the model issued behind the original prompt.",
    [60, 200, 120, 80, 320], ["Prompt #", "Prompt", "Captured", "Type", "Fan-out query"], fanRows);

  // Brand mentions — count 0 means shown in a card but never named in prose.
  const brandRows = [];
  records.forEach((r, i) => {
    (r.brandMentions || []).forEach((b) => {
      brandRows.push([
        i + 1, r.userPrompt || "", stamp(r), b.brand || "", b.category || "",
        b.relation || "", typeof b.count === "number" ? b.count : 0,
        (b.count || 0) === 0 ? "Shown, not named" : "Named in answer",
        (b.passages && b.passages[0] ? b.passages[0] : "").slice(0, 400),
      ]);
    });
  });
  addSheet("Brand Mentions", "Brands the model named, how often, and the surrounding sentence.",
    [60, 200, 120, 180, 110, 90, 60, 130, 400],
    ["Prompt #", "Prompt", "Captured", "Brand", "Category", "Relation", "Mentions", "Status", "Context"],
    brandRows);

  // Products.
  const productRows = [];
  records.forEach((r, i) => {
    (r.products || []).forEach((p) => {
      productRows.push([
        i + 1, r.userPrompt || "", stamp(r), p.name || "", p.brand || "",
        p.price || "", p.merchant || "",
        typeof p.rating === "number" ? p.rating : "", typeof p.reviews === "number" ? p.reviews : "",
      ]);
    });
  });
  addSheet("Products", "Product cards the model surfaced, with price, merchant and rating.",
    [60, 200, 120, 240, 120, 90, 160, 60, 80],
    ["Prompt #", "Prompt", "Captured", "Product", "Brand", "Price", "Merchant", "Rating", "Reviews"],
    productRows);

  // Local businesses.
  const placeRows = [];
  records.forEach((r, i) => {
    (r.places || []).forEach((p) => {
      placeRows.push([
        i + 1, r.userPrompt || "", stamp(r), p.name || "", p.category || "",
        typeof p.rating === "number" ? p.rating : "", typeof p.reviews === "number" ? p.reviews : "",
        p.phone || "", p.address || "", p.website || "", p.hours || "", p.mapsUrl || "",
      ]);
    });
  });
  addSheet("Local Businesses", "Business listings ChatGPT/Gemini returned, with contact and rating data.",
    [60, 200, 120, 220, 120, 60, 80, 120, 320, 240, 260, 260],
    ["Prompt #", "Prompt", "Captured", "Business", "Category", "Rating", "Reviews", "Phone", "Address", "Website", "Hours", "Maps link"],
    placeRows);

  // Entities.
  const entityRows = [];
  records.forEach((r, i) => {
    (r.entities || []).forEach((e) => entityRows.push([i + 1, r.userPrompt || "", stamp(r), e.text || "", e.category || ""]));
  });
  addSheet("Entities", "Named entities detected in each answer, with their category.",
    [60, 200, 120, 220, 130], ["Prompt #", "Prompt", "Captured", "Entity", "Category"], entityRows);

  // Full answer text, so the workbook is self-contained for reading back.
  const answerRows = records.map((r, i) => [
    i + 1, r.userPrompt || "", stamp(r), r.platform || "", r.model || "",
    r.generatedTitle || "", r.answerChars || 0, (r.answerText || "").slice(0, 30000),
  ]);
  addSheet("Answers", "The full answer text behind every capture.",
    [60, 200, 120, 80, 90, 200, 70, 600],
    ["Prompt #", "Prompt", "Captured", "Platform", "Model", "Conversation title", "Chars", "Answer text"],
    answerRows);

  xml += `</Workbook>`;
  download(`citoskeleton-audit-${Date.now()}.xls`, xml, "application/vnd.ms-excel");
}

async function downloadRaw(captureId, label) {
  const r = await send({ type: "get-raw", captureId });
  if (!r.ok || r.raw == null) { alert("No raw payload stored for this capture."); return; }
  const header =
    `# CitoSkeleton raw capture ${captureId}\n` +
    `# url: ${r.meta?.url || ""}\n` +
    `# reqBody: ${r.meta?.reqBody || ""}\n\n`;
  download(`citoskeleton-raw-${label || captureId}.txt`, header + r.raw, "text/plain");
}
function toCsv(records) {
  const rows = [["capturedAt", "platform", "model", "prompt", "searched", "fanoutCount", "sourceCount"]];
  records.forEach((r) => {
    const fan = r.fanout.search.length + r.fanout.shopping.length + r.fanout.image.length;
    rows.push([
      new Date(r.capturedAt).toISOString(), r.platform, r.model || "",
      r.userPrompt || "", r.searched, fan, r.sources.length,
    ]);
  });
  return csvOf(rows); // csvCell handles quoting + formula-injection escaping
}

/* ==================================================================
 * GEO brand tracking — the "tool under the tool".
 *
 * Deliberately separate from the ad-hoc capture views: a fixed brand set +
 * prompt set + engine set, re-run on a cadence, so the numbers are comparable
 * over time. Its responses never enter RECORDS (see the isolation note in
 * load()), and its metrics are computed in the service worker (see the
 * "geo-metrics" handler) because Position needs the full answer text.
 * ================================================================== */

const geoActive = () => GEO_PROFILES.find((p) => p.id === geoActiveId) || GEO_PROFILES[0] || null;
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(Number(n) >= 10 ? 0 : 1)}%`);
const fmtPos = (n) => (n == null ? "—" : `#${Number(n).toFixed(1)}`);

async function loadGeo() {
  const pr = await send({ type: "geo-profile-list", includeDeleted: true });
  const all = pr.ok ? pr.profiles : [];
  GEO_PROFILES = all.filter((p) => !p.deletedAt);
  TRASHED_PROFILES = all.filter((p) => p.deletedAt);
  if (!geoActiveId || !GEO_PROFILES.some((p) => p.id === geoActiveId)) geoActiveId = GEO_PROFILES[0]?.id || null;
  const active = geoActive();
  GEO_PROMPTS = [];
  if (active) {
    const qs = await send({ type: "geo-prompt-list", profileId: active.id });
    if (qs.ok) GEO_PROMPTS = qs.prompts;
  }
  selectedPromptIds = new Set();
  renderCampaigns();
}

/* ---------- Campaigns tab (setup + prompts + LLMs + run, formerly
   Tracking + Loader) ---------- */

function renderCampaigns() { withScrollPreserved(renderCampaignsImpl); }
function renderCampaignsImpl() {
  const root = $("#loader");
  if (!root) return;
  root.textContent = "";
  const profile = geoActive();

  const bar = el("div", { className: "card" });
  const barHead = el("div", { className: "card-header" }, el("h3", {}, "Campaigns"));
  barHead.append(el("span", { className: "muted small" }, `${GEO_PROFILES.length} of ${MAX_PROFILES} used`));
  bar.append(barHead);

  const switcher = el("div", { className: "geo-switcher" });
  GEO_PROFILES.forEach((p) => {
    const b = el("button", { className: `geo-chip${p.id === geoActiveId ? " active" : ""}` }, p.name || "Untitled");
    if (p.locked) b.append(el("span", { className: "lock" }, " 🔒"));
    b.onclick = () => { geoActiveId = p.id; campaignManageOpen = false; loadGeo(); };
    switcher.append(b);
  });
  if (GEO_PROFILES.length < MAX_PROFILES) {
    const add = el("button", { className: "geo-chip add" }, "+ New campaign");
    add.onclick = async () => {
      const r = await send({ type: "geo-profile-save", profile: makeProfile({ name: `Campaign ${GEO_PROFILES.length + 1}` }) });
      if (r.ok) { geoActiveId = r.profile.id; campaignManageOpen = false; loadGeo(); } else alert(r.error);
    };
    switcher.append(add);
  }
  bar.append(switcher);
  root.append(bar);

  if (TRASHED_PROFILES.length) root.append(renderTrashedCampaigns());

  if (!profile) {
    root.append(renderCampaignEmptyState());
    return;
  }

  if (!profile.locked) {
    if (!campaignOnboardDismissed) root.append(renderOnboardingBanner());
    root.append(renderCampaignSetup(profile, false));
  } else {
    root.append(renderCampaignSummary(profile));
    if (campaignManageOpen) root.append(renderCampaignSetup(profile, true));
    root.append(renderRunCard(profile));
  }
}

function renderTrashedCampaigns() {
  const box = el("div", { className: "card" });
  box.append(el("div", { className: "card-header" }, el("h3", {}, `🗑 Recently deleted (${TRASHED_PROFILES.length})`)));
  const list = el("div", { className: "itemlist" });
  TRASHED_PROFILES.forEach((p) => {
    const daysLeft = Math.max(0, Math.ceil((p.deletedAt + TRASH_RETENTION_DAYS * 86400000 - Date.now()) / 86400000));
    const row = el("div", { className: "item" });
    const head = el("div", { className: "item-head" });
    head.append(el("span", { className: "item-name" }, p.name || "Untitled"));
    const restoreBtn = el("button", { className: "linkbtn" }, "↩ restore");
    restoreBtn.onclick = async () => {
      const r = await send({ type: "geo-profile-restore", id: p.id });
      if (r.ok) { geoActiveId = p.id; loadGeo(); } else alert(r.error);
    };
    const purgeBtn = el("button", { className: "linkbtn danger" }, "delete forever");
    purgeBtn.onclick = async () => {
      if (!confirm(`Permanently delete "${p.name || "this campaign"}"?\n\nThis cannot be undone — its prompts go with it (captured responses are kept).`)) return;
      const r = await send({ type: "geo-profile-delete", id: p.id });
      if (r.ok) loadGeo(); else alert(r.error);
    };
    head.append(restoreBtn, purgeBtn);
    row.append(head);
    row.append(el("div", { className: "muted item-sub" },
      daysLeft > 0 ? `Auto-deletes in ${daysLeft} day${daysLeft === 1 ? "" : "s"} unless restored.` : "Auto-deleting soon unless restored."));
    list.append(row);
  });
  box.append(list);
  return box;
}

function renderCampaignEmptyState() {
  const box = el("div", { className: "card onboard-card" });
  box.append(el("div", { className: "card-header" }, el("h3", {}, "Start your first campaign")));
  box.append(el("p", { className: "muted" },
    "A campaign tracks how your brand and competitors show up across LLM answers, for a fixed set of prompts. Set it up once, then lock it in so every run stays comparable."));
  const steps = el("ol", { className: "onboard-steps" });
  [
    "Name the campaign and set your brand + competitors",
    "Upload a CSV/Excel of prompts (or type them) and tag them",
    "Choose which LLMs to track",
    "Lock the campaign to start measuring",
  ].forEach((s) => steps.append(el("li", {}, s)));
  box.append(steps);
  const cta = el("button", { className: "btn primary" }, "+ Create your first campaign");
  cta.onclick = async () => {
    const r = await send({ type: "geo-profile-save", profile: makeProfile({ name: "My first campaign" }) });
    if (r.ok) { geoActiveId = r.profile.id; loadGeo(); } else alert(r.error);
  };
  box.append(el("div", { className: "ft-actions" }, cta));
  return box;
}

function renderOnboardingBanner() {
  const box = el("div", { className: "warn-box onboard-banner" });
  box.append(el("div", {},
    el("b", {}, "Setting up a campaign — "),
    "add prompts (upload a CSV/Excel or type them), tag them so you can filter later, pick which LLMs to track, then lock the campaign. Locking freezes the setup so your results stay comparable run over run."));
  const dismiss = el("button", { className: "linkbtn" }, "Got it, don't show this again");
  dismiss.onclick = () => {
    campaignOnboardDismissed = true;
    chrome.storage.local.set({ [ONBOARD_KEY]: true });
    renderCampaigns();
  };
  box.append(dismiss);
  return box;
}

// Soft-delete: recoverable from "Recently deleted" for TRASH_RETENTION_DAYS.
function trashCampaign(profile) {
  return async () => {
    if (!confirm(`Delete "${profile.name || "this campaign"}"?\n\nIt moves to Recently deleted and can be restored for ${TRASH_RETENTION_DAYS} days, after which it's purged automatically.`)) return;
    const r = await send({ type: "geo-profile-trash", id: profile.id });
    if (r.ok) { geoActiveId = null; loadGeo(); } else alert(r.error);
  };
}

/** Setup card: name/brand/competitors/LLMs + the embedded prompt manager.
 *  Used both for the unlocked wizard and the locked "Manage" panel (dis=true). */
function renderCampaignSetup(profile, dis) {
  const card = el("div", { className: "card" });
  const head = el("div", { className: "card-header" }, el("h3", {}, dis ? "Manage campaign" : "Set up your campaign"));
  if (!dis) {
    const delBtn = el("button", { className: "btn sm ghost danger" }, "🗑 Delete campaign");
    delBtn.onclick = trashCampaign(profile);
    const lockBtn = el("button", { className: "btn sm primary" }, "🔒 Lock & start tracking");
    lockBtn.onclick = async () => {
      if (!GEO_PROMPTS.length) return alert("Add at least one prompt before locking.");
      if (!(profile.engines || []).length) return alert("Choose at least one LLM to track before locking.");
      if (!confirm("Lock this campaign?\n\nLocking freezes the brand set, competitors, prompts and LLMs so your trend data stays comparable day to day. You can unlock any time.")) return;
      const r = await send({ type: "geo-profile-save", profile: { ...profile, locked: true }, unlockOverride: true });
      if (r.ok) loadGeo(); else alert(r.error);
    };
    head.append(delBtn, lockBtn);
  } else {
    const unlockBtn = el("button", { className: "btn sm ghost" }, "🔓 Unlock to edit");
    unlockBtn.onclick = async () => {
      if (!confirm("Unlock and allow edits?\n\nChanging the brand set, prompts or LLMs changes what the metrics are measured against — numbers before and after this point are NOT directly comparable.")) return;
      const r = await send({ type: "geo-profile-save", profile: { ...profile, locked: false }, unlockOverride: true });
      if (r.ok) loadGeo(); else alert(r.error);
    };
    head.append(unlockBtn);
  }
  card.append(head);

  const nameIn = el("input", { type: "text", value: profile.name || "", placeholder: "Campaign name", disabled: dis });
  const brandIn = el("input", { type: "text", value: profile.brand?.name || "", placeholder: "Your brand name", disabled: dis });
  const urlIn = el("input", { type: "text", value: profile.brand?.url || "", placeholder: "yourbrand.com", disabled: dis });
  card.append(el("div", { className: "proj-row" }, nameIn));
  card.append(el("label", { className: "muted", style: "display:block;margin-top:8px" }, "Your brand"));
  card.append(el("div", { className: "proj-row" }, brandIn, urlIn));

  // Competitors: a repeatable name+url row per competitor, rather than a
  // freeform "name, url per line" textarea — less error-prone to fill in and
  // to read back.
  card.append(el("label", { className: "muted", style: "display:block;margin-top:14px" }, "Competitors"));
  const compWrap = el("div", { className: "competitor-rows" });
  const addCompetitorRow = (name = "", url = "") => {
    const row = el("div", { className: "proj-row competitor-row" });
    row.append(
      el("input", { type: "text", placeholder: "Competitor name", value: name, disabled: dis, className: "comp-name" }),
      el("input", { type: "text", placeholder: "competitor.com", value: url, disabled: dis, className: "comp-url" }),
    );
    if (!dis) {
      const rm = el("button", { className: "btn sm ghost danger", title: "Remove competitor" }, "✕");
      rm.onclick = () => row.remove();
      row.append(rm);
    }
    compWrap.append(row);
  };
  (profile.competitors || []).forEach((c) => addCompetitorRow(c.name, c.url));
  if (dis && !(profile.competitors || []).length) compWrap.append(el("div", { className: "muted small" }, "No competitors added."));
  card.append(compWrap);
  if (!dis) {
    const addCompBtn = el("button", { className: "btn sm ghost", style: "margin-top:8px" }, "➕ Add competitor");
    addCompBtn.onclick = () => addCompetitorRow();
    card.append(addCompBtn);
  }

  // LLMs to track: an icon-forward selectable grid instead of plain checkboxes.
  card.append(el("label", { className: "muted", style: "display:block;margin-top:16px" }, "LLMs to track"));
  const engCount = el("div", { className: "muted small", style: "margin-top:6px" });
  const engGrid = el("div", { className: "llm-grid" });
  ENGINES.forEach((e) => {
    const selected = (profile.engines || []).includes(e.id);
    const pillDisabled = dis || !e.available;
    const pill = el("div", {
      className: `llm-pill${selected ? " selected" : ""}${pillDisabled ? " disabled" : ""}`,
      role: "checkbox", "aria-checked": String(selected), tabIndex: pillDisabled ? -1 : 0,
    });
    pill.dataset.value = e.id;
    pill.append(el("span", { className: "llm-icon" }, ENGINE_ICONS[e.id] || "🔷"));
    pill.append(el("span", { className: "llm-label" }, e.label));
    // Unavailable engines are shown disabled rather than hidden: the roadmap
    // stays visible, and a metric can never silently under-count because a
    // pill looked selectable but drove nothing.
    if (!e.available) pill.append(el("span", { className: "soon" }, e.note || "coming soon"));
    else pill.append(el("span", { className: "llm-check" }, "✓"));
    if (!pillDisabled) {
      const toggle = () => {
        pill.classList.toggle("selected");
        pill.setAttribute("aria-checked", String(pill.classList.contains("selected")));
        engCount.textContent = `${engGrid.querySelectorAll(".llm-pill.selected").length} of ${ENGINES.length} selected`;
      };
      pill.onclick = toggle;
      pill.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } };
    }
    engGrid.append(pill);
  });
  engCount.textContent = `${(profile.engines || []).length} of ${ENGINES.length} selected`;
  card.append(engGrid, engCount);

  if (!dis) {
    const save = el("button", { className: "btn sm" }, "💾 Save details");
    save.onclick = async () => {
      const competitors = [...compWrap.querySelectorAll(".competitor-row")]
        .map((row) => ({ name: row.querySelector(".comp-name").value.trim(), url: row.querySelector(".comp-url").value.trim() }))
        .filter((c) => c.name);
      const engines = [...engGrid.querySelectorAll(".llm-pill.selected")].map((p) => p.dataset.value);
      const r = await send({
        type: "geo-profile-save",
        profile: { ...profile, name: nameIn.value.trim() || profile.name, brand: { name: brandIn.value.trim(), url: urlIn.value.trim() }, competitors, engines },
      });
      if (r.ok) loadGeo(); else alert(r.error);
    };
    card.append(el("div", { className: "ft-actions", style: "margin-top:10px" }, save));
  }

  card.append(el("div", { className: "wizard-divider" }));
  card.append(renderPromptManager(profile, dis));
  return card;
}

const ENGINE_ICONS = { chatgpt: "💬", gemini: "✦", perplexity: "🔍", claude: "✳️", grok: "🤖" };

// After a bulk add, tell the user what got skipped as a duplicate (and why)
// rather than silently dropping it — only speaks up when there's something
// to report.
function reportAddResult(r) {
  if (!r.duplicates || !r.duplicates.length) return;
  const preview = r.duplicates.slice(0, 5).map((t) => `• ${t}`).join("\n");
  const more = r.duplicates.length > 5 ? `\n…and ${r.duplicates.length - 5} more` : "";
  alert(`Added ${r.added} prompt${r.added === 1 ? "" : "s"}. Skipped ${r.duplicates.length} duplicate${r.duplicates.length === 1 ? "" : "s"} already in this campaign:\n${preview}${more}`);
}

/** The prompts table: CSV/Excel upload (primary), manual entry (fallback),
 *  search, tag-filter sidebar (with per-tag rename/delete), "only unassigned"
 *  toggle, inline tag editing, and bulk select for pause/remove. */
function renderPromptManager(profile, dis) {
  const wrap = el("div", { className: "prompt-manager" });
  wrap.append(el("div", { className: "card-header", style: "margin-top:0" },
    el("h3", {}, "Prompts"),
    el("span", { className: "muted small" }, `${GEO_PROMPTS.filter((p) => p.active !== false).length} active of ${GEO_PROMPTS.length}`)));

  if (!dis) {
    const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.xlsx", style: "display:none" });
    const uploadBtn = el("button", { className: "btn sm" }, "⬆ Upload prompts (CSV/Excel)");
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const rows = /\.xlsx$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
        const prompts = rowsToPrompts(rows);
        if (!prompts.length) { alert("No prompts found in that file — make sure column A has your prompts."); return; }
        const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: profile.id, rows: prompts });
        fileInput.value = "";
        if (r.ok) { reportAddResult(r); loadGeo(); } else alert(r.error);
      } catch (err) {
        alert(`Couldn't read that file: ${err.message}`);
      }
    };
    wrap.append(el("div", { className: "proj-row" },
      uploadBtn,
      el("span", { className: "muted small" }, "Column A = prompt, column B = tags (comma-separated)"),
      fileInput));

    const manualToggle = el("button", { className: "linkbtn" }, "or type prompts manually");
    const manualBox = el("div", { style: "display:none; margin-top:8px" });
    const ta = el("textarea", {
      rows: 4,
      placeholder: "One prompt per line — add tags after a comma…\nbest trading app in India, finance, beginner\nbest broker for beginners, finance",
    });
    const addBtn = el("button", { className: "btn sm" }, "➕ Add prompts");
    addBtn.onclick = async () => {
      const rows = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const parts = line.split(",");
        const text = (parts.shift() || "").trim();
        const tags = parts.map((t) => t.trim()).filter(Boolean);
        return { text, tags };
      }).filter((r) => r.text);
      if (!rows.length) return;
      const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: profile.id, rows });
      if (r.ok) { ta.value = ""; reportAddResult(r); loadGeo(); } else alert(r.error);
    };
    manualBox.append(ta, el("div", { className: "proj-row", style: "margin-top:6px" }, addBtn));
    manualToggle.onclick = () => { manualBox.style.display = manualBox.style.display === "none" ? "block" : "none"; };
    wrap.append(manualToggle, manualBox);
  }

  if (!GEO_PROMPTS.length) {
    wrap.append(el("div", { className: "empty" }, "No prompts yet — upload a CSV/Excel or add them manually above."));
    return wrap;
  }

  const toolbar = el("div", { className: "prompt-toolbar" });
  const search = el("input", { type: "text", placeholder: "🔍 Search prompts…", value: promptSearch, className: "prompt-search" });
  search.oninput = () => {
    promptSearch = search.value;
    // renderCampaigns() tears down and rebuilds the whole tab (this codebase's
    // render pattern everywhere), which would otherwise steal focus from this
    // box after every keystroke — restore it and the cursor position.
    const cursor = search.selectionStart;
    renderCampaigns();
    const next = $(".prompt-search");
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  toolbar.append(search);
  if (!dis) {
    const unassignedInput = el("input", { type: "checkbox", checked: promptOnlyUnassigned });
    unassignedInput.onchange = (e) => { promptOnlyUnassigned = e.target.checked; renderCampaigns(); };
    toolbar.append(el("label", { className: "chk" }, unassignedInput, " Only unassigned"));
  }
  wrap.append(toolbar);

  const tags = allTags(GEO_PROMPTS);
  const filtered = GEO_PROMPTS.filter((p) => {
    if (promptSearch && !p.text.toLowerCase().includes(promptSearch.toLowerCase())) return false;
    if (promptOnlyUnassigned && (p.tags || []).length) return false;
    if (promptTagFilter.length && !promptTagFilter.some((t) => (p.tags || []).includes(t))) return false;
    return true;
  });

  const body = el("div", { className: "prompt-table-layout" });
  if (tags.length) {
    const sidebar = el("div", { className: "tag-sidebar" });
    sidebar.append(el("div", { className: "muted small", style: "margin-bottom:6px" }, "Tags"));
    const allChip = el("button", { className: `tag clickable${promptTagFilter.length ? "" : " on"}` }, "All");
    allChip.onclick = () => { promptTagFilter = []; renderCampaigns(); };
    sidebar.append(allChip);
    // A rounded "pill" chip (the style everywhere else in this app, e.g. the
    // "All" button above) reads fine for a short word but wraps into an ugly
    // multi-line blob for a real tag like "Consumer Electronics &
    // Smartphones" in a narrow sidebar — a plain full-width list row, like
    // any sidebar filter list, wraps normally and leaves room for the
    // rename/delete icons without fighting the label for space.
    const list = el("div", { className: "tag-sidebar-list" });
    tags.forEach((t) => {
      const on = promptTagFilter.includes(t);
      const chipRow = el("div", { className: `tag-sidebar-row${on ? " on" : ""}` });
      const label = el("button", { className: "tag-sidebar-label" }, t);
      label.onclick = () => { promptTagFilter = on ? promptTagFilter.filter((x) => x !== t) : [...promptTagFilter, t]; renderCampaigns(); };
      chipRow.append(label);
      if (!dis) {
        const icons = el("div", { className: "tag-icons" });
        const renameBtn = el("button", { className: "tag-icon-btn", title: `Rename tag "${t}"` }, "✎");
        renameBtn.onclick = async () => {
          const next = window.prompt(`Rename tag "${t}" to:`, t);
          if (!next || !next.trim() || next.trim() === t) return;
          const r = await send({ type: "geo-tag-rename", profileId: profile.id, oldTag: t, newTag: next.trim() });
          if (r.ok) { promptTagFilter = promptTagFilter.map((x) => (x === t ? next.trim() : x)); loadGeo(); } else alert(r.error);
        };
        const delBtn = el("button", { className: "tag-icon-btn danger", title: `Delete tag "${t}"` }, "✕");
        delBtn.onclick = async () => {
          const affected = GEO_PROMPTS.filter((p) => (p.tags || []).includes(t)).length;
          if (!confirm(`Delete the tag "${t}"?\n\nThis removes it from ${affected} prompt(s) — the prompts themselves are kept, they just lose this tag.`)) return;
          const r = await send({ type: "geo-tag-delete", profileId: profile.id, tag: t });
          if (r.ok) { promptTagFilter = promptTagFilter.filter((x) => x !== t); loadGeo(); } else alert(r.error);
        };
        icons.append(renameBtn, delBtn);
        chipRow.append(icons);
      }
      list.append(chipRow);
    });
    sidebar.append(list);
    body.append(sidebar);
  }

  if (!dis) {
    // Bulk actions replace the old always-visible per-row pause/remove
    // buttons — select what you want to act on, then act on all of it at
    // once, instead of clicking pause/remove one row at a time.
    const bulkBar = el("div", { className: "prompt-bulk-bar" });
    const selAllCb = el("input", { type: "checkbox" });
    selAllCb.checked = filtered.length > 0 && filtered.every((p) => selectedPromptIds.has(p.id));
    selAllCb.onchange = () => {
      filtered.forEach((p) => (selAllCb.checked ? selectedPromptIds.add(p.id) : selectedPromptIds.delete(p.id)));
      renderCampaigns();
    };
    bulkBar.append(el("label", { className: "chk" }, selAllCb, ` Select all (${filtered.length})`));
    if (selectedPromptIds.size) {
      bulkBar.append(el("span", { className: "muted small" }, `${selectedPromptIds.size} selected`));
      const actOn = async (fn) => { for (const id of selectedPromptIds) await fn(id); loadGeo(); };
      const pauseBtn = el("button", { className: "btn sm ghost" }, "⏸ Pause selected");
      pauseBtn.onclick = () => actOn(async (id) => {
        const p = GEO_PROMPTS.find((x) => x.id === id);
        if (p && p.active !== false) await send({ type: "geo-prompt-save", prompt: { ...p, active: false } });
      });
      const enableBtn = el("button", { className: "btn sm ghost" }, "▶ Enable selected");
      enableBtn.onclick = () => actOn(async (id) => {
        const p = GEO_PROMPTS.find((x) => x.id === id);
        if (p && p.active === false) await send({ type: "geo-prompt-save", prompt: { ...p, active: true } });
      });
      const removeBtn = el("button", { className: "btn sm danger" }, "🗑 Remove selected");
      removeBtn.onclick = async () => {
        if (!confirm(`Remove ${selectedPromptIds.size} selected prompt(s)? Responses already captured for them are kept.`)) return;
        await actOn((id) => send({ type: "geo-prompt-delete", id }));
      };
      bulkBar.append(pauseBtn, enableBtn, removeBtn);
    }
    wrap.append(bulkBar);
  }

  const headerCells = [];
  if (!dis) headerCells.push(el("th", { style: "width:24px" }, ""));
  headerCells.push(el("th", {}, "Prompt"), el("th", {}, "Tags"));
  const table = el("table", { className: "prompt-table" }, el("tr", {}, ...headerCells));

  filtered.forEach((p) => {
    const cells = [];
    if (!dis) {
      const cb = el("input", { type: "checkbox", checked: selectedPromptIds.has(p.id) });
      cb.onchange = () => {
        if (cb.checked) selectedPromptIds.add(p.id); else selectedPromptIds.delete(p.id);
        renderCampaigns();
      };
      cells.push(el("td", { className: "prompt-check" }, cb));
    }
    const promptCell = el("td", { className: "prompt-cell" });
    if (p.active === false) promptCell.append(el("span", { className: "tag fetched", style: "margin-right:6px" }, "⏸ paused"));
    promptCell.append(p.text);
    cells.push(promptCell);
    const tagWrap = el("div", { className: "tagline" });
    (p.tags || []).forEach((t) => tagWrap.append(el("span", { className: "tag" }, t)));
    if (!dis) {
      const ti = el("input", { type: "text", className: "taginput", placeholder: "+ tag" });
      ti.onkeydown = async (ev) => {
        if (ev.key !== "Enter" || !ti.value.trim()) return;
        const newTags = [...new Set([...(p.tags || []), ...ti.value.split(",").map((s) => s.trim()).filter(Boolean)])];
        await send({ type: "geo-prompt-save", prompt: { ...p, tags: newTags } });
        loadGeo();
      };
      tagWrap.append(ti);
    }
    cells.push(el("td", {}, tagWrap));
    table.append(el("tr", { className: p.active === false ? "inactive-row" : "" }, ...cells));
  });

  body.append(el("div", { className: "prompt-table-scroll" }, table));
  wrap.append(body);
  if (promptSearch || promptTagFilter.length || promptOnlyUnassigned) {
    wrap.append(el("div", { className: "muted small", style: "margin-top:6px" }, `Showing ${filtered.length} of ${GEO_PROMPTS.length} prompts.`));
  }
  return wrap;
}

function renderCampaignSummary(profile) {
  const card = el("div", { className: "card campaign-summary" });
  const delBtn = el("button", { className: "btn sm ghost danger" }, "🗑 Delete");
  delBtn.onclick = trashCampaign(profile);
  card.append(el("div", { className: "card-header" }, el("h3", {}, profile.name || "Campaign"), el("span", { className: "muted small" }, "🔒 locked"), delBtn));
  const meta = el("div", { className: "campaign-meta" });
  const engLabels = ENGINES.filter((e) => (profile.engines || []).includes(e.id)).map((e) => e.label);
  meta.append(
    el("span", {}, `Brand: ${profile.brand?.name || "—"}`),
    el("span", {}, `${GEO_PROMPTS.filter((p) => p.active !== false).length} active prompts`),
    el("span", {}, `LLMs: ${engLabels.join(", ") || "—"}`),
    el("span", {}, `Last run: ${profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleDateString() : "never"}`),
  );
  card.append(meta);
  const toggle = el("button", { className: "linkbtn" }, campaignManageOpen ? "Hide setup & prompts" : "Manage setup & prompts");
  toggle.onclick = () => { campaignManageOpen = !campaignManageOpen; renderCampaigns(); };
  card.append(el("div", { style: "margin-top:8px" }, toggle));
  return card;
}

function renderRunCard(profile) {
  const rc = el("div", { className: "card" });
  rc.append(el("div", { className: "card-header" }, el("h3", {}, "Run")));
  const vol = runVolume(GEO_PROMPTS, profile.engines || []);
  const due = runDue(profile);

  if (due && vol.submissions) {
    rc.append(el("div", { className: "geo-due" },
      `Today's run hasn't happened yet — last run ${profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleDateString() : "never"}.`));
  }
  rc.append(el("p", { className: "muted" },
    `This run will submit ${vol.submissions} prompt${vol.submissions === 1 ? "" : "s"} (${vol.prompts} prompt${vol.prompts === 1 ? "" : "s"} × ${vol.engines} engine${vol.engines === 1 ? "" : "s"}) through your logged-in accounts, paced with human-like gaps.`));
  if (vol.submissions > 60) {
    rc.append(el("div", { className: "warn-box" },
      el("span", {}, `${vol.submissions} automated submissions in one run is a lot of activity on one account. Consider splitting your prompts across campaigns or pausing some, and keep an eye on the run rather than leaving it unattended.`)));
  }
  const runBtn = el("button", { className: "btn primary" }, "▶ Start run");
  runBtn.onclick = async () => {
    if (!confirm(`Run tracking now?\n\n${vol.submissions} submissions (${vol.prompts} prompts × ${vol.engines} engines) will be sent through your logged-in ChatGPT/Gemini sessions at a human pace.`)) return;
    const r = await send({ type: "geo-run-start", profileId: profile.id });
    if (!r.ok) { alert(r.error); return; }
    loadGeo();
  };
  const pauseBtn = el("button", { className: "btn ghost" }, "⏸ Pause");
  pauseBtn.onclick = async () => renderLoaderStatus(await send({ type: "loader-pause" }));
  const resumeBtn = el("button", { className: "btn ghost" }, "▶ Resume");
  resumeBtn.onclick = async () => renderLoaderStatus(await send({ type: "loader-resume" }));
  const stopBtn = el("button", { className: "btn danger" }, "■ Stop");
  stopBtn.onclick = async () => renderLoaderStatus(await send({ type: "loader-stop" }));
  rc.append(el("div", { className: "ft-actions" }, runBtn, pauseBtn, resumeBtn, stopBtn));
  rc.append(el("div", { id: "loaderStatus", className: "status-msg" }));
  return rc;
}

/* ---------- Campaign performance metrics (rendered from the Dashboard) ---------- */

async function refreshGeoMetrics(profile, prompts = [], since, until) {
  const mc = $("#geoMetrics");
  if (!mc || !profile) return;

  const r = await send({
    type: "geo-metrics",
    profileId: profile.id,
    tags: geoTagFilter,
    engines: geoEngineFilter,
    since, until,
  });
  mc.textContent = "";
  const head = el("div", { className: "card-header" }, el("h3", {}, `Campaign Performance — ${profile.name || "Untitled"}`));
  mc.append(head);

  if (!r.ok) { mc.append(el("div", { className: "empty" }, r.error || "Couldn't load metrics.")); return; }
  const m = r.metrics;

  // Timeframe is the same filter as the rest of the Dashboard (see
  // renderDashboardImpl) — no separate "Last 7/30/90 days" selector here
  // anymore, so there's only ever one time filter to reason about.
  const filters = el("div", { className: "proj-row" });
  const eng = el("select", { className: "filter" });
  eng.append(el("option", { value: "" }, "All engines"));
  availableEngines().forEach((e) => eng.append(el("option", { value: e.id, selected: geoEngineFilter[0] === e.id }, e.label)));
  eng.onchange = () => { geoEngineFilter = eng.value ? [eng.value] : []; refreshGeoMetrics(profile, prompts, since, until); refreshPromptPerformance(profile, prompts, since, until); };
  filters.append(eng);
  mc.append(filters);

  const tags = allTags(prompts);
  if (tags.length) {
    const tw = el("div", { className: "tagline", style: "margin-top:8px" });
    tw.append(el("span", { className: "muted small" }, "Tags: "));
    tags.forEach((t) => {
      const on = geoTagFilter.includes(t);
      const chip = el("button", { className: `tag clickable${on ? " on" : ""}` }, t);
      chip.onclick = () => {
        geoTagFilter = on ? geoTagFilter.filter((x) => x !== t) : [...geoTagFilter, t];
        refreshGeoMetrics(profile, prompts, since, until);
        refreshPromptPerformance(profile, prompts, since, until);
      };
      tw.append(chip);
    });
    if (geoTagFilter.length) {
      const clr = el("button", { className: "linkbtn" }, "clear");
      clr.onclick = () => {
        geoTagFilter = [];
        refreshGeoMetrics(profile, prompts, since, until);
        refreshPromptPerformance(profile, prompts, since, until);
      };
      tw.append(clr);
    }
    mc.append(tw);
  }

  // Overview row — the same shape of aggregate as the ad-hoc "Performance
  // Overview" (captures / with-search / fan-out / domains / cited / fetched),
  // but for this campaign's tracked responses specifically. Folding it in
  // here is what "merges" the two sections once a campaign is selected.
  if (r.overview) {
    const ov = r.overview;
    const ovStats = el("div", { className: "statgrid", style: "margin-top:10px" });
    [[ov.captures, "Captures"], [ov.searched, "With search"], [ov.fanTotal, "Fan-out queries"],
     [ov.domainCount, "Unique domains"], [ov.citedTotal, "Cited"], [ov.fetchedTotal, "Fetched"]].forEach(([n, l]) =>
      ovStats.append(el("div", { className: "stat" }, el("div", { className: "n" }, String(n)), el("div", { className: "l" }, l))));
    mc.append(ovStats);
  }

  if (!m.totalResponses) {
    mc.append(el("div", { className: "empty", style: "margin-top:10px" },
      "No tracked responses yet for these filters. Head to the Campaigns tab to start a run."));
    return;
  }

  /* KPI row */
  const own = m.own;
  const kpis = el("div", { className: "geo-kpis" });
  const kpi = (label, value, sub) => {
    const b = el("div", { className: "geo-kpi" });
    b.append(el("div", { className: "k-label" }, label));
    b.append(el("div", { className: "k-value" }, value));
    if (sub) b.append(el("div", { className: "k-sub muted" }, sub));
    return b;
  };
  kpis.append(
    kpi("Share of Voice", fmtPct(own?.shareOfVoice), `${own?.mentions || 0} of ${m.mentionPool} tracked mentions`),
    kpi("Brand Visibility", fmtPct(own?.visibility), `${own?.responsesPresent || 0} of ${m.totalResponses} responses`),
    kpi("Mentions", String(own?.mentions ?? 0), "times named in answers"),
    kpi("Source Visibility", fmtPct(own?.sourceVisibility), `your domain in ${own?.sourceResponses || 0} responses`),
    kpi("Citations", String(own?.citations ?? 0), "responses citing your domain"),
    kpi("Avg position", fmtPos(own?.avgPosition), "rank among tracked brands"),
  );
  mc.append(kpis);

  /* competitor table */
  const wrap = el("div", { className: "drill-scroll", style: "margin-top:14px" });
  const t = el("table", { className: "drill-table" });
  t.append(el("tr", {},
    el("th", {}, "Brand"),
    el("th", { className: "num" }, "Visibility"),
    el("th", { className: "num" }, "Share of Voice"),
    el("th", { className: "num" }, "Mentions"),
    el("th", { className: "num" }, "Avg position"),
    el("th", { className: "num" }, "Citations"),
    el("th", { className: "num" }, "Source vis.")));
  m.brands.forEach((b) => {
    const tr = el("tr", { className: b.isOwn ? "own-brand" : "" });
    tr.append(el("td", {}, b.isOwn ? `${b.name} (you)` : b.name));
    tr.append(el("td", { className: "num" }, fmtPct(b.visibility)));
    tr.append(el("td", { className: "num" }, fmtPct(b.shareOfVoice)));
    tr.append(el("td", { className: "num" }, String(b.mentions)));
    tr.append(el("td", { className: "num" }, fmtPos(b.avgPosition)));
    tr.append(el("td", { className: "num" }, String(b.citations)));
    tr.append(el("td", { className: "num" }, fmtPct(b.sourceVisibility)));
    t.append(tr);
  });
  wrap.append(t);
  mc.append(wrap);

  /* honest gap, stated in the UI rather than left for the user to discover */
  mc.append(el("div", { className: "geo-note muted small" }, `Sentiment: not measured. ${SENTIMENT_NOTE}`));

  const dl = el("button", { className: "btn sm ghost", style: "margin-top:10px" }, "⬇ Export metrics CSV");
  dl.onclick = () => {
    const rows = [["Brand", "Is own", "Visibility %", "Share of Voice %", "Mentions", "Avg position", "Citations", "Source visibility %", "Responses present", "Total responses"]];
    m.brands.forEach((b) => rows.push([b.name, b.isOwn ? "yes" : "no", b.visibility.toFixed(2), b.shareOfVoice.toFixed(2), b.mentions, b.avgPosition == null ? "" : b.avgPosition.toFixed(2), b.citations, b.sourceVisibility.toFixed(2), b.responsesPresent, m.totalResponses]));
    download(`citoskeleton-tracking-${profile.name.replace(/\W+/g, "-")}-${Date.now()}.csv`, csvOf(rows), "text/csv");
  };
  mc.append(dl);
}

// Per-run detail toggle state, keyed by promptId — which prompts' run
// history is expanded beyond just the latest run.
let expandedPromptRuns = new Set();
let sourceViewMode = "domain"; // "domain" | "url"

const yesNo = (b) => (b ? "✓" : "✕");
const posLabel = (n) => (n == null ? "—" : `#${n}`);

/** Replaces Saved Conversations once a campaign is selected: prompts grouped
 *  with their own-brand mention/position/citation per run (merging reruns
 *  of the same prompt instead of listing every response separately), plus a
 *  domain/URL source breakdown for the same filtered response set. */
async function refreshPromptPerformance(profile, prompts, since, until) {
  const root = $("#geoPromptTable");
  if (!root || !profile) return;

  const r = await send({
    type: "geo-prompt-performance",
    profileId: profile.id,
    tags: geoTagFilter,
    engines: geoEngineFilter,
    since, until,
  });
  root.textContent = "";
  root.append(el("div", { className: "card-header" }, el("h3", {}, "Prompt Performance")));

  if (!r.ok) { root.append(el("div", { className: "empty" }, r.error || "Couldn't load prompt performance.")); return; }
  if (!r.hasBrand) {
    root.append(el("div", { className: "empty" }, "Set your brand name on this campaign (Campaigns tab) to see per-prompt mention/citation results."));
    return;
  }

  const filteredPrompts = geoTagFilter.length
    ? prompts.filter((p) => geoTagFilter.some((t) => (p.tags || []).includes(t)))
    : prompts;

  if (!filteredPrompts.length) {
    root.append(el("div", { className: "empty" }, "No prompts match the current filters."));
  } else {
    // One column per tracked engine (not a single ambiguous "latest run")
    // so it's clear whether a brand showed up on ChatGPT vs. Gemini rather
    // than one merged result that could be from either.
    const engineIds = (profile.engines && profile.engines.length) ? profile.engines : [];
    const engineLabel = (id) => ENGINES.find((e) => e.id === id)?.label || id;

    const buildEngineCell = (run) => {
      if (!run) return el("td", { className: "muted small" }, "—");
      return el("td", {}, el("div", { className: "platform-result" },
        el("span", {}, `${yesNo(run.mentioned)} ${posLabel(run.position)}`),
        el("span", { className: "muted small" }, `Domain cited ${yesNo(run.cited)}`),
      ));
    };

    const headerCells = [el("th", {}, "Prompt")];
    engineIds.forEach((id) => headerCells.push(el("th", {}, `${ENGINE_ICONS[id] || "🔷"} ${engineLabel(id)}`)));
    headerCells.push(el("th", {}, "Time"), el("th", { style: "width:90px" }, ""));
    const table = el("table", { className: "prompt-perf-table" }, el("tr", {}, ...headerCells));

    filteredPrompts.forEach((p) => {
      const runs = (r.prompts && r.prompts[p.id]) || [];
      // Clicking a prompt opens its most recent capture in Analyze so the
      // full answer/sources/fan-out can be studied there instead of just
      // the summarized mention/position/citation flags here.
      const promptLink = el("a", { href: "#", className: "prompt-link" }, p.text);
      promptLink.onclick = (ev) => {
        ev.preventDefault();
        if (runs[0]) openCapture(runs[0].captureId);
      };
      const promptCell = el("td", { className: "prompt-cell" }, promptLink);
      const tagWrap = el("div", { className: "tagline" });
      (p.tags || []).forEach((t) => tagWrap.append(el("span", { className: "tag" }, t)));
      if (tagWrap.childNodes.length) promptCell.append(tagWrap);

      const cells = [promptCell];
      if (!runs.length) {
        engineIds.forEach(() => cells.push(el("td", { className: "muted small" }, "—")));
        cells.push(el("td", { className: "muted small" }, "No runs yet"), el("td", {}));
        table.append(el("tr", {}, ...cells));
        return;
      }

      engineIds.forEach((id) => cells.push(buildEngineCell(runs.find((run) => run.platform === id) || null)));
      cells.push(el("td", {}, new Date(runs[0].capturedAt).toLocaleString()));

      const expandCell = el("td", {});
      if (runs.length > 1) {
        const expanded = expandedPromptRuns.has(p.id);
        const toggle = el("button", { className: "linkbtn" }, expanded ? "hide" : `${runs.length - 1} earlier`);
        toggle.onclick = () => {
          if (expanded) expandedPromptRuns.delete(p.id); else expandedPromptRuns.add(p.id);
          refreshPromptPerformance(profile, prompts, since, until);
        };
        expandCell.append(toggle);
      }
      cells.push(expandCell);
      table.append(el("tr", {}, ...cells));

      if (runs.length > 1 && expandedPromptRuns.has(p.id)) {
        runs.slice(1).forEach((run) => {
          const subCells = [el("td", {})];
          engineIds.forEach((id) => subCells.push(run.platform === id ? buildEngineCell(run) : el("td", {})));
          subCells.push(el("td", { className: "muted small" }, new Date(run.capturedAt).toLocaleString()), el("td", {}));
          table.append(el("tr", { className: "prompt-perf-subrow" }, ...subCells));
        });
      }
    });
    root.append(el("div", { className: "prompt-table-scroll" }, table));
  }

  // --- source domains, aggregated from this same filtered response set ---
  const byDomain = new Map();
  const byUrl = new Map();
  const bump = (map, key, outcome) => {
    if (!key) return;
    const row = map.get(key) || { citations: 0, fetched: 0 };
    if (outcome === "cited") row.citations++;
    else if (outcome === "fetched") row.fetched++;
    map.set(key, row);
  };
  Object.values(r.prompts || {}).forEach((runs) => runs.forEach((run) => (run.sources || []).forEach((s) => {
    bump(byDomain, s.domain, s.outcome);
    bump(byUrl, s.url, s.outcome);
  })));

  root.append(el("div", { className: "wizard-divider" }));
  const srcHead = el("div", { className: "card-header", style: "margin-top:0" }, el("h3", {}, "Source Domains"));
  const modeToggle = el("div", { className: "filter-bar" });
  [["domain", "Domains"], ["url", "URLs"]].forEach(([v, l]) => {
    const pill = el("button", { className: `filter-pill${sourceViewMode === v ? " active" : ""}` }, l);
    pill.onclick = () => { sourceViewMode = v; refreshPromptPerformance(profile, prompts, since, until); };
    modeToggle.append(pill);
  });
  srcHead.append(modeToggle);
  root.append(srcHead);

  const activeMap = sourceViewMode === "domain" ? byDomain : byUrl;
  if (!activeMap.size) {
    root.append(el("div", { className: "empty" }, "No sources captured yet for these filters."));
  } else {
    const srcTable = el("table", { className: "drill-table" });
    srcTable.append(el("tr", {}, el("th", {}, sourceViewMode === "domain" ? "Domain" : "URL"), el("th", { className: "num" }, "Citations"), el("th", { className: "num" }, "Fetched")));
    [...activeMap.entries()].sort((a, b) => b[1].citations - a[1].citations || b[1].fetched - a[1].fetched).slice(0, 50).forEach(([key, row]) => {
      // URLs are clickable — the same URL can surface under several
      // different prompts, and clicking shows which ones plus what each
      // response mentioned. Domains aren't (a domain has no single "source"
      // to drill into the way one exact URL does).
      const keyCell = sourceViewMode === "url"
        ? el("button", { className: "linkbtn td-domain-btn", title: "Click to see which prompts cited this URL" }, key)
        : el("span", { className: "domain-name" }, key);
      if (sourceViewMode === "url") keyCell.onclick = () => openUrlDetailModal(key, profile, since, until);
      srcTable.append(el("tr", {}, el("td", { className: "td-domain" }, keyCell), el("td", { className: "num" }, String(row.citations)), el("td", { className: "num" }, String(row.fetched))));
    });
    root.append(el("div", { className: "drill-scroll" }, srcTable));
  }
}

/** "Rankings by Source URL" — which prompts pulled in this URL, whether the
 *  campaign's own brand was mentioned in that response, and every brand
 *  present. No trend chart — just the table (this URL's citation count over
 *  time isn't tracked at that granularity, and a fabricated chart would be
 *  worse than no chart). */
async function openUrlDetailModal(url, profile, since, until) {
  const existing = document.getElementById("url-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "url-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content" });
  const header = el("div", { className: "modal-header" });
  header.append(
    el("div", { style: "min-width:0" },
      el("h3", { style: "margin:0;font-size:15px;color:var(--fg-primary);" }, "Rankings by Source URL"),
      el("div", { className: "muted small", style: "overflow-wrap:anywhere;margin-top:2px" }, url)),
  );
  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  closeBtn.onclick = () => backdrop.remove();
  header.append(closeBtn);
  modal.append(header);

  const body = el("div", { className: "modal-body" }, el("div", { className: "muted small" }, "Loading…"));
  modal.append(body);
  backdrop.append(modal);
  document.body.append(backdrop);
  backdrop.onclick = (ev) => { if (ev.target === backdrop) backdrop.remove(); };

  const r = await send({ type: "geo-url-detail", profileId: profile.id, url, tags: geoTagFilter, engines: geoEngineFilter, since, until });
  body.textContent = "";
  if (!r.ok) { body.append(el("div", { className: "empty" }, r.error || "Couldn't load this URL's detail.")); return; }
  if (!r.rows.length) { body.append(el("div", { className: "empty" }, "No responses matched for this URL under the current filters.")); return; }

  const table = el("table", { className: "drill-table" });
  table.append(el("tr", {}, el("th", {}, "Prompt"), el("th", {}, "Brand Mentioned"), el("th", {}, "Brands"), el("th", {}, "Date")));
  r.rows.forEach((row) => {
    const brandChips = el("div", { className: "tagline" });
    row.brands.forEach((b) => brandChips.append(el("span", { className: "tag" }, b)));
    table.append(el("tr", {},
      el("td", {}, row.promptText),
      el("td", {}, row.mentioned == null ? "—" : yesNo(row.mentioned)),
      el("td", {}, brandChips),
      el("td", {}, new Date(row.capturedAt).toLocaleDateString()),
    ));
  });
  body.append(el("div", { className: "drill-scroll" }, table));
}

/* ---------- wiring ---------- */
document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    // clicking the Analyze tab directly returns to the latest capture
    if (btn.dataset.tab === "analyze") { viewingId = null; renderAnalyze(); }
    if (btn.dataset.tab === "loader") loadGeo();
    showTab(btn.dataset.tab);
  })
);
$("#openTab").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/panel.html") })
);
$("#exportJson")?.addEventListener("click", () =>
  download(`citoskeleton-export-${Date.now()}.json`, JSON.stringify(currentFilteredRecs, null, 2), "application/json")
);
$("#exportExcel")?.addEventListener("click", () => {
  if (!currentFilteredRecs.length) return alert("No data to export");
  
  // Generate HTML table for Excel
  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8" /></head>
    <body>
      <table border="1">
        <thead>
          <tr style="background-color: #f1f5f9; color: #0f172a; font-weight: bold;">
            <th style="width: 150px">Date</th>
            <th style="width: 120px">Platform</th>
            <th style="width: 300px">User Prompt</th>
            <th style="width: 80px">Has Search</th>
            <th style="width: 300px">Sources</th>
            <th style="width: 300px">Fan-Out Queries</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  const platformColors = {
    chatgpt: "#e0f2fe",
    gemini: "#fce7f3",
    perplexity: "#fef3c7",
    claude: "#ffedd5",
    grok: "#d1fae5"
  };

  currentFilteredRecs.forEach(r => {
    const bg = platformColors[r.platform] || "#ffffff";
    const srcText = r.sources.map(s => `[${s.outcome}] ${s.domain}`).join(", ");
    const fan = [...r.fanout.search, ...r.fanout.shopping, ...r.fanout.image];
    const fanText = fan.map(f => f.query).join(" | ");
    
    html += `
      <tr style="background-color: ${bg};">
        <td>${new Date(r.capturedAt).toLocaleString()}</td>
        <td>${r.platform || "chatgpt"}</td>
        <td>${sanitizeText(r.userPrompt || "")}</td>
        <td>${r.searched ? "Yes" : "No"}</td>
        <td>${sanitizeText(srcText)}</td>
        <td>${sanitizeText(fanText)}</td>
      </tr>
    `;
  });
  
  html += `</tbody></table></body></html>`;
  download(`llm-audit-${Date.now()}.xls`, html, "application/vnd.ms-excel");
});

$("#reprocess")?.addEventListener("click", async () => {
  const st = $("#setStatus"); // was "#status" — that id doesn't exist, so this never showed
  if (st) st.textContent = "Reprocessing…";
  const r = await send({ type: "reprocess-all" });
  if (st) st.textContent = r.ok ? `Reprocessed ${r.reprocessed}/${r.total} captures.` : "Reprocess failed";
  FULL.clear(); // records were re-derived; drop stale hydrated copies
  load();
});

$("#deleteFiltered")?.addEventListener("click", async () => {
  if (!currentFilteredRecs.length) return;
  if (!confirm(`Delete ${currentFilteredRecs.length} filtered conversations? This cannot be undone.`)) return;
  
  const st = $("#status");
  if (st) st.textContent = "Deleting...";
  for (const r of currentFilteredRecs) {
    await send({ type: "delete-record", captureId: r.captureId });
  }
  if (st) st.textContent = "Deleted successfully.";
  load();
});

/* ---------- Campaigns run status ---------- */
function renderLoaderStatus(s) {
  const box = $("#loaderStatus");
  if (!box) return;
  if (!s || !s.total) { box.textContent = ""; return; }
  const state = s.running ? (s.paused ? "paused" : "running") : "idle/done";
  let statusText = `${state} — ${s.done}/${s.total} done${s.errors ? `, ${s.errors} errors` : ""}`;
  if (s.platStats) {
    const details = Object.keys(s.platStats).map(p => `${p}: ${s.platStats[p].done}/${s.platStats[p].total}`).join(" | ");
    if (details) statusText += `\n[${details}]`;
  }
  statusText += (s.current && s.running ? `\nnow: "${s.current.slice(0, 40)}"` : "");
  box.innerText = statusText;
}

// poll loader status while the Campaigns tab is open
setInterval(async () => {
  if (!$("#loader")?.classList.contains("active")) return;
  const s = await send({ type: "loader-status" });
  if (s.ok) renderLoaderStatus(s);
}, 1500);

/* ---------- Capture debug ---------- */
async function renderDebug() {
  const r = await send({ type: "get-debug" });
  const log = $("#dbgLog");
  log.textContent = "";
  if (!r.ok || !r.events.length) { log.append(el("div", { className: "muted" }, "No events yet. Load ChatGPT/Gemini and run a prompt.")); return; }
  // group counts by host+kind for a quick summary
  const summ = {};
  r.events.forEach((e) => { const k = `${e.host} · ${e.kind}`; summ[k] = (summ[k] || 0) + 1; });
  log.append(el("div", { className: "muted", style: "margin:4px 0" }, Object.entries(summ).map(([k, n]) => `${k}: ${n}`).join("  |  ")));
  r.events.slice().reverse().forEach((e) => {
    const time = new Date(e.t).toLocaleTimeString();
    const d = e.data || {};
    let line = `${time}  [${e.kind}]`;
    if (e.kind === "fetch") line += `  ${d.status} ${d.matched ? "CAP" : "—"}  ${d.url}`;
    else if (e.kind === "xhr") line += `  ${d.matched ? "CAP" : "—"}  ${d.url}`;
    else if (e.kind === "xhr-done") line += `  len=${d.len}${d.rt && d.rt !== "text" ? " " + d.rt : ""}  ${d.url}`;
    else if (e.kind === "worker") line += `  WORKER  ${d.url}`;
    else if (e.kind === "installed") line += `  ${e.host}  ${d.href || ""}`;
    else line += `  ${e.host}`;
    // highlight big matched responses (candidate answer payloads)
    const cls = e.kind === "xhr-done" && d.len > 2000 ? "dbgline big" : "dbgline";
    log.append(el("div", { className: cls }, line));
  });
}
$("#dbgRefresh").addEventListener("click", renderDebug);
$("#dbgClear").addEventListener("click", async () => { await send({ type: "clear-debug" }); renderDebug(); });

/* ==================== QA DIAGNOSTICS (temporary) ====================
 * Added for a one-off 200-prompt/20-industry stress test. Safe to delete
 * this whole block, the matching #qaToggle/#qaPanel markup in panel.html's
 * About section, and the "qa-audit" case in src/background.js, once that's
 * done — nothing else in the app reads from or depends on any of it.
 *
 * Two independent checks, both read-only against whatever is already
 * captured (never calls ChatGPT/Gemini itself):
 *  - Data integrity audit (server-side, src/background.js "qa-audit"): flags
 *    real schema-level red flags — e.g. sources present but zero brand
 *    mentions, the adapter's own usedFallback/notes diagnostics never
 *    surfaced anywhere before — grouped by industry tag and platform.
 *  - Render self-test: actually calls the real renderAnalyze() for every
 *    stored capture (tracked AND ad-hoc) and catches any exception, as a
 *    proxy for "did the layout break" — the closest thing to an automated
 *    UI smoke test possible without a live browser driving the extension.
 */
let qaLastAudit = null;
let qaLastRenderTest = null;

const qaToggleBtn = $("#qaToggle");
if (qaToggleBtn) {
  let qaOpened = false;
  qaToggleBtn.addEventListener("click", () => {
    const panel = $("#qaPanel");
    const show = panel.style.display === "none";
    panel.style.display = show ? "block" : "none";
    if (show && !qaOpened) { qaOpened = true; renderQaPanel(); }
  });
}

function renderQaPanel() {
  const panel = $("#qaPanel");
  panel.textContent = "";
  panel.append(el("p", { className: "muted small" },
    "Runs against whatever is currently stored locally — captures from both ad-hoc browsing and Campaign runs. Nothing here calls ChatGPT/Gemini; it only inspects data already captured on this device."));

  const btnRow = el("div", { className: "ft-actions" });
  const auditBtn = el("button", { className: "btn sm" }, "▶ Run data integrity audit");
  const renderBtn = el("button", { className: "btn sm ghost" }, "▶ Run render self-test");
  const exportBtn = el("button", { className: "btn sm ghost" }, "⬇ Export QA report (JSON)");
  btnRow.append(auditBtn, renderBtn, exportBtn);
  panel.append(btnRow);

  const out = el("div", { id: "qaOut", style: "margin-top:10px" });
  panel.append(out);

  auditBtn.onclick = async () => {
    out.textContent = "Running data integrity audit…";
    const r = await send({ type: "qa-audit" });
    if (!r.ok) { out.textContent = r.error || "Audit failed."; return; }
    qaLastAudit = r;
    renderQaAuditResults(out, r);
  };
  renderBtn.onclick = () => runQaRenderSelfTest(out);
  exportBtn.onclick = () => {
    if (!qaLastAudit && !qaLastRenderTest) { alert("Run at least one check first."); return; }
    const report = { generatedAt: new Date().toISOString(), audit: qaLastAudit, renderSelfTest: qaLastRenderTest };
    download(`citoskeleton-qa-report-${Date.now()}.json`, JSON.stringify(report, null, 2), "application/json");
  };
}

function renderQaAuditResults(out, r) {
  out.textContent = "";
  const platformSummary = Object.entries(r.byPlatform).map(([k, v]) => `${k}: ${v}`).join(", ") || "—";
  out.append(el("div", { className: "muted small" }, `${r.totalRecords} total captures · by platform: ${platformSummary}`));

  const industryTable = el("table", { className: "drill-table" });
  industryTable.append(el("tr", {}, el("th", {}, "Industry / tag"), el("th", { className: "num" }, "Captures")));
  Object.entries(r.byIndustry).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    industryTable.append(el("tr", {}, el("td", {}, k), el("td", { className: "num" }, String(v))));
  });
  out.append(el("div", { className: "drill-scroll", style: "max-height:200px; margin-top:8px" }, industryTable));

  const checkNames = Object.keys(r.checks);
  if (!checkNames.length) {
    out.append(el("div", { className: "empty", style: "margin-top:10px" }, "No integrity issues flagged across any stored capture."));
    return;
  }
  const checksBox = el("div", { style: "margin-top:12px" });
  checksBox.append(el("div", { className: "muted small", style: "margin-bottom:6px" }, "Flagged (click a capture id to open it in Analyze):"));
  checkNames.forEach((name) => {
    const c = r.checks[name];
    const item = el("div", { className: "brand-item" });
    item.append(el("div", { className: "brand-head" },
      el("span", { className: "brand-name" }, name),
      el("span", { className: "tag fetched" }, String(c.count))));
    const byPlat = Object.entries(c.byPlatform).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (byPlat) item.append(el("div", { className: "muted small", style: "margin-top:2px" }, byPlat));
    const byInd = Object.entries(c.byIndustry).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (byInd) item.append(el("div", { className: "muted small", style: "margin-top:2px" }, byInd));
    const exWrap = el("div", { className: "tagline", style: "margin-top:4px" });
    c.examples.forEach((id) => {
      const b = el("button", { className: "tag clickable" }, id.slice(0, 8));
      b.onclick = () => openCapture(id);
      exWrap.append(b);
    });
    item.append(exWrap);
    checksBox.append(item);
  });
  out.append(checksBox);
}

async function runQaRenderSelfTest(out) {
  const res = await send({ type: "get-records" });
  const all = res.ok ? res.records : [];
  if (!all.length) { out.textContent = "No stored captures to test."; return; }

  const savedViewingId = viewingId;
  const failures = [];
  let done = 0;
  out.textContent = `Running render self-test… 0/${all.length}`;
  for (const light of all) {
    try {
      viewingId = light.captureId;
      await hydrate(light.captureId);
      renderAnalyze(); // writes into the (currently inactive/invisible) #analyze panel
    } catch (err) {
      failures.push({ captureId: light.captureId, platform: light.platform, error: String((err && err.message) || err) });
    }
    done++;
    if (done % 10 === 0 || done === all.length) out.textContent = `Running render self-test… ${done}/${all.length}`;
  }
  viewingId = savedViewingId;
  await hydrate(viewingId);
  renderAnalyze(); // restore whatever Analyze was actually showing before this ran

  qaLastRenderTest = { totalChecked: all.length, failureCount: failures.length, failures };

  out.textContent = "";
  out.append(el("div", { className: "muted small" }, `Checked ${all.length} captures.`));
  if (!failures.length) {
    out.append(el("div", { className: "empty", style: "margin-top:8px" }, "No exceptions thrown building the Analyze view for any stored capture."));
    return;
  }
  const box = el("div", { style: "margin-top:10px" });
  box.append(el("div", { className: "muted small", style: "margin-bottom:6px" }, `${failures.length} capture(s) threw while rendering — click to open in Analyze and inspect:`));
  failures.forEach((f) => {
    const item = el("div", { className: "brand-item" });
    const openBtn = el("button", { className: "linkbtn" }, `${f.captureId.slice(0, 8)} (${f.platform})`);
    openBtn.onclick = () => openCapture(f.captureId);
    item.append(el("div", { className: "brand-head" }, openBtn));
    item.append(el("div", { className: "muted small" }, f.error));
    box.append(item);
  });
  out.append(box);
}
/* ==================== /QA DIAGNOSTICS ==================== */

/* ---------- Settings ---------- */
async function loadSettings() {
  const r = await send({ type: "settings-get" });
  if (!r.ok) return;
  const s = r.settings;
  if ($("#setDebug")) $("#setDebug").checked = !!s.debugCapture;
  if ($("#setRetention")) $("#setRetention").value = s.retentionMax;
  if ($("#setMaxMB")) $("#setMaxMB").value = s.maxCaptureMB;
}
if ($("#setSave")) {
  $("#setSave").addEventListener("click", async () => {
    const patch = {
      debugCapture: $("#setDebug").checked,
      retentionMax: Math.max(50, parseInt($("#setRetention").value, 10) || 2000),
      maxCaptureMB: Math.max(1, parseInt($("#setMaxMB").value, 10) || 8),
    };
    const r = await send({ type: "settings-set", patch });
    $("#setStatus").textContent = r.ok ? "Saved." : "Failed to save.";
  });
}

/* ---------- Compare: one prompt across many timelines ----------
 * The GEO question is "for THIS query, am I gaining or losing ground over time?"
 * — so the unit of comparison is a single prompt tracked across every time it
 * ran, not two whole runs diffed against each other (which mixed unrelated
 * prompts together and made movement unreadable).
 *
 * A prompt is matched by its normalised text, so the same question captured on
 * different days / in different projects lines up into one timeline.
 */
let cmpProjectFilter = "";
let cmpModelFilter = "";

function normPrompt(p) {
  return String(p || "").toLowerCase().replace(/\s+/g, " ").replace(/[.?!,]+$/, "").trim();
}

// Every distinct prompt that has been captured, with its captures sorted oldest→newest.
function promptTimelines() {
  const byPrompt = new Map();
  for (const r of RECORDS) {
    if (!r.userPrompt) continue;
    if (cmpProjectFilter && r.projectId !== cmpProjectFilter) continue;
    if (cmpModelFilter && r.platform !== cmpModelFilter) continue;
    const key = normPrompt(r.userPrompt);
    if (!key) continue;
    if (!byPrompt.has(key)) byPrompt.set(key, { key, label: r.userPrompt, captures: [] });
    byPrompt.get(key).captures.push(r);
  }
  for (const t of byPrompt.values()) t.captures.sort((a, b) => a.capturedAt - b.capturedAt);
  return [...byPrompt.values()].sort((a, b) => b.captures.length - a.captures.length);
}

function refreshComparePickers() {
  const projSel = $("#cmpProject");
  if (projSel) {
    const keep = projSel.value;
    projSel.textContent = "";
    projSel.append(el("option", { value: "" }, "All projects"));
    PROJECTS.forEach((p) => projSel.append(el("option", { value: p.id }, p.name)));
    projSel.value = keep;
  }
  const sel = $("#cmpPrompt");
  if (!sel) return;
  const keep = sel.value;
  const timelines = promptTimelines();
  sel.textContent = "";
  sel.append(el("option", { value: "" }, "Choose a prompt…"));
  timelines.forEach((t) => {
    const n = t.captures.length;
    const txt = t.label.length > 60 ? t.label.slice(0, 60) + "…" : t.label;
    sel.append(el("option", { value: t.key }, `${txt}  —  ${n} capture${n === 1 ? "" : "s"}`));
  });
  sel.value = keep;

  const repeat = timelines.filter((t) => t.captures.length > 1).length;
  const hint = $("#cmpHint");
  if (hint) {
    hint.textContent = repeat
      ? `${repeat} prompt${repeat === 1 ? " has" : "s have"} been captured more than once — those show real movement.`
      : "Capture the same prompt again (any day, or via the Loader) to see what changed between runs.";
  }
}

// Per-capture aggregate for one point on the timeline.
function pointAggregate(rec) {
  const domains = new Map();
  (rec.sources || []).forEach((s) => {
    if (!s.domain) return;
    const prev = domains.get(s.domain) || { cited: 0, fetched: 0 };
    if (s.outcome === "cited") prev.cited++;
    else prev.fetched++;
    domains.set(s.domain, prev);
  });
  const brands = new Map();
  (rec.brandMentions || []).forEach((b) => {
    // count 0 = "shown but not narrated" — still presence, tracked separately
    const prev = brands.get(b.brand) || { count: 0, shown: false };
    prev.count += b.count || 0;
    if ((b.count || 0) === 0) prev.shown = true;
    brands.set(b.brand, prev);
  });
  return { domains, brands };
}

function deltaTag(delta) {
  if (delta > 0) return el("span", { className: "tag cited" }, `▲ +${delta}`);
  if (delta < 0) return el("span", { className: "tag fetched" }, `▼ ${delta}`);
  return el("span", { className: "tag mentioned" }, "no change");
}

function renderCompare() {
  const out = $("#cmpOut");
  if (!out) return;
  out.textContent = "";

  const key = $("#cmpPrompt") ? $("#cmpPrompt").value : "";
  if (!key) {
    out.append(el("div", { className: "empty" }, "Choose a prompt above to see how its results changed over time."));
    return;
  }
  const timeline = promptTimelines().find((t) => t.key === key);
  if (!timeline || !timeline.captures.length) {
    out.append(el("div", { className: "empty" }, "No captures for that prompt with the current filters."));
    return;
  }

  const caps = timeline.captures;
  const points = caps.map((r) => ({ rec: r, ...pointAggregate(r) }));
  const fmt = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // --- header: the prompt + its timeline ---
  const head = el("div", { className: "card" });
  head.append(el("div", { className: "card-header" }, el("h3", {}, timeline.label)));
  if (caps.length === 1) {
    head.append(el("div", { className: "muted" },
      "Only one capture so far — run this prompt again later and this page will show what moved."));
  }
  const tl = el("div", { className: "chips", style: "margin-top:6px" });
  caps.forEach((r, i) => {
    tl.append(el("span", { className: "chip" },
      `${i + 1}. ${fmt(r.capturedAt)} · ${r.platform}${r.model ? " · " + r.model : ""}`));
  });
  head.append(tl);
  out.append(head);

  if (caps.length < 2) return;

  const first = points[0];
  const last = points[points.length - 1];

  // --- headline movement between first and last capture ---
  const sum = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "What changed (first → latest)")));
  const sgrid = el("div", { className: "statgrid" });
  const stat = (n, l) => el("div", { className: "stat" }, el("div", { className: "n" }, String(n)), el("div", { className: "l" }, l));
  const domsFirst = new Set(first.domains.keys());
  const domsLast = new Set(last.domains.keys());
  const gainedDom = [...domsLast].filter((d) => !domsFirst.has(d));
  const lostDom = [...domsFirst].filter((d) => !domsLast.has(d));
  const brandsFirst = new Set(first.brands.keys());
  const brandsLast = new Set(last.brands.keys());
  const gainedBrand = [...brandsLast].filter((b) => !brandsFirst.has(b));
  const lostBrand = [...brandsFirst].filter((b) => !brandsLast.has(b));
  sgrid.append(
    stat(caps.length, "Captures"),
    stat(gainedBrand.length, "Brands gained"),
    stat(lostBrand.length, "Brands lost"),
    stat(gainedDom.length, "Domains gained"),
    stat(lostDom.length, "Domains lost"),
    stat(domsLast.size, "Domains now")
  );
  sum.append(sgrid);
  out.append(sum);

  // --- matrix helper: rows = item, columns = each capture in time order ---
  function matrixCard(title, subtitle, rows) {
    if (!rows.length) return null;
    const card = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, title)));
    if (subtitle) card.append(el("div", { className: "muted", style: "margin-bottom:6px" }, subtitle));
    const wrap = el("div", { style: "overflow-x:auto" });
    const t = el("table", {});
    const hr = el("tr", {}, el("th", {}, "Name"));
    caps.forEach((r, i) => hr.append(el("th", { className: "num", title: fmt(r.capturedAt) }, `#${i + 1}`)));
    hr.append(el("th", { className: "num" }, "Trend"));
    t.append(hr);
    rows.forEach((row) => {
      const tr = el("tr", {});
      tr.append(el("td", {}, row.name));
      row.values.forEach((v) => {
        tr.append(el("td", { className: "num" }, v.label));
      });
      tr.append(el("td", { className: "num" }, deltaTag(row.delta)));
      t.append(tr);
    });
    wrap.append(t);
    card.append(wrap);
    return card;
  }

  // --- brand presence over time ---
  const allBrands = new Set();
  points.forEach((p) => p.brands.forEach((_, b) => allBrands.add(b)));
  const brandRows = [...allBrands].map((name) => {
    const values = points.map((p) => {
      const v = p.brands.get(name);
      if (!v) return { n: 0, label: "—" };
      if (v.count === 0) return { n: 0, label: "shown" }; // present, but not narrated
      return { n: v.count, label: String(v.count) };
    });
    const firstN = values[0].n;
    const lastN = values[values.length - 1].n;
    return { name, values, delta: lastN - firstN, lastN };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.lastN - a.lastN);
  const bCard = matrixCard(
    "Brand mentions over time",
    "How many times each brand was named in the answer, at each capture. “shown” = appeared in a product card but was not named.",
    brandRows
  );
  if (bCard) out.append(bCard);

  // --- domain presence over time ---
  const allDomains = new Set();
  points.forEach((p) => p.domains.forEach((_, d) => allDomains.add(d)));
  const domRows = [...allDomains].map((name) => {
    const values = points.map((p) => {
      const v = p.domains.get(name);
      if (!v) return { n: 0, label: "—" };
      const total = v.cited + v.fetched;
      return { n: total, label: v.cited ? `${total} (c)` : String(total) };
    });
    const firstN = values[0].n;
    const lastN = values[values.length - 1].n;
    return { name, values, delta: lastN - firstN, lastN };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.lastN - a.lastN);
  const dCard = matrixCard(
    "Source domains over time",
    "Times each domain appeared per capture. “(c)” marks a domain that was actually cited, not just fetched.",
    domRows.slice(0, 60)
  );
  if (dCard) out.append(dCard);

  // --- explicit gained/lost lists ---
  const movement = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Gained and lost")));
  const ml = el("ul", { className: "itemlist" });
  const addRow = (label, items, cls) => {
    const li = el("li", {});
    const h = el("div", { className: "item-head" });
    h.append(el("span", { className: "item-name" }, label), el("span", { className: `tag ${cls}` }, String(items.length)));
    li.append(h);
    li.append(el("div", { className: "muted item-sub" }, items.length ? items.join(", ") : "—"));
    ml.append(li);
  };
  addRow("Brands newly appearing", gainedBrand, "cited");
  addRow("Brands no longer appearing", lostBrand, "fetched");
  addRow("Domains newly appearing", gainedDom, "cited");
  addRow("Domains no longer appearing", lostDom, "fetched");
  movement.append(ml);
  out.append(movement);

  // --- export this timeline ---
  const bar = el("div", { className: "dlbar" });
  const dl = el("button", { className: "btn sm" }, "⬇ Export this timeline (CSV)");
  dl.onclick = () => {
    const rows = [["prompt", "type", "name", ...caps.map((r, i) => `#${i + 1} ${new Date(r.capturedAt).toISOString()}`), "delta"]];
    brandRows.forEach((r) => rows.push([timeline.label, "brand", r.name, ...r.values.map((v) => v.label), r.delta]));
    domRows.forEach((r) => rows.push([timeline.label, "domain", r.name, ...r.values.map((v) => v.label), r.delta]));
    download(`citoskeleton-timeline-${Date.now()}.csv`, csvOf(rows), "text/csv");
  };
  bar.append(dl);
  out.append(el("div", { className: "card" }, bar));
}

["#cmpPrompt", "#cmpProject", "#cmpModel"].forEach((id) => {
  const node = $(id);
  if (!node) return;
  node.addEventListener("change", () => {
    if (id === "#cmpProject") cmpProjectFilter = node.value;
    if (id === "#cmpModel") cmpModelFilter = node.value;
    if (id !== "#cmpPrompt") refreshComparePickers();
    renderCompare();
  });
});

loadSettings();
load(); // also fills the Compare pickers, after projects are known
