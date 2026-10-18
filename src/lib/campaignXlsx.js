/*
 * campaignXlsx.js — a campaign as an analyst's workbook (.xlsx), release 6
 * of the canvas redesign (0.52.0).
 *
 * The approved workbook map: a Start here sheet, ten summary sheets that
 * each answer one question with live formulas and charts, and eight raw
 * tables an analyst can filter and pivot. Two yellow cells on Overview — the
 * run and the engine — drive every summary: each summary number is a
 * COUNTIFS / SUMIFS / AVERAGEIFS over the raw tables' named columns.
 *
 * Every formula is written with its value for the pickers' starting state
 * (the latest run, all engines), computed here from the same rows by the
 * same rule (see Q below), so the file reads correctly in any app on open
 * and recalculates when a picker changes.
 *
 * Only what the captures measure: a store's own price, which claims a page
 * backs, or which search led to which page are not in a capture, so the
 * workbook has no column for them rather than an empty or guessed one.
 *
 * PURE: bundle in, Workbook out (see xlsxWrite.js). The background builds it
 * — it holds the answer text positions need — and hands the panel the parts.
 */
import { parsePrice, parseNumber } from "./money.js";
import { Workbook, absRange, sheetRef, cellRef, colName } from "./xlsxWrite.js";
import { brandPresence, normName, domainOfUrl, domainMatches } from "./geo.js";
import { answerKind, resultPositions } from "./analyzeView.js";
import { pageTypeOf } from "./campaignView.js";
import { parseQueryOperators } from "./fanout.js";
import { siteKindOf } from "./siteKind.js";
import { extractBrandAspects } from "./aspects.js";
import { cardIsBrand } from "./campaignBoard.js";
import { glossaryEntries } from "./glossary.js";

const ENGINE_ORDER = ["chatgpt", "gemini", "perplexity", "grok"];
const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
const KINDS = ["Shopping", "Informational", "Images", "From memory", "Local"];
const SITE_KINDS = ["Your site", "Rival brand sites", "Review sites", "Retailers", "Forums & social", "Public & reference", "Other"];
// Engines' image proxies: the picture came through the engine, not a site.
const PROXY_HOSTS = /(^|\.)(images\.openai\.com|gstatic\.com|googleusercontent\.com|bing\.net|perplexity\.ai|x\.ai|grok\.com)$/i;
const YEAR = /\b(19|20)\d{2}\b/;

/* ---------- the rows ---------- */

const wordRe = (w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");
function merchantsOf(p) {
  return String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x));
}
// The amount and its currency, so prices from different markets are never
// added up as one (money.js, 0.69.0). A price with no currency mark keeps
// its number and an empty currency.
function priceOf(s) {
  const p = parsePrice(s);
  if (p) return p;
  const n = parseNumber((String(s || "").match(/\d[\d.,]*/) || [])[0]);
  return n == null ? { amount: null, currency: null } : { amount: n, currency: null };
}
const fanoutOf = (rec) => {
  const f = rec.fanout || {};
  return [...(f.search || []).map((q) => ["Web", q]), ...(f.shopping || []).map((q) => ["Shopping", q]), ...(f.image || []).map((q) => ["Image", q])]
    .map(([kind, q]) => [kind, typeof q === "string" ? q : (q && (q.query || q.text)) || ""]).filter(([, q]) => q);
};

/**
 * The eight raw tables as arrays of rows, plus what the summaries need.
 * bundle: { profile, prompts, runs, records, brands, answerText: "excerpt" | "full" | "none" }
 */
export function campaignFacts({ profile = {}, prompts = [], runs = [], records = [], brands = [], answerText = "excerpt" } = {}) {
  const own = brands.find((b) => b.isOwn) || brands[0] || { name: (profile.brand && profile.brand.name) || "Your brand", url: (profile.brand && profile.brand.url) || "" };
  const OWN = own.name;
  const ownDom = domainOfUrl(own.url);
  const brandDom = new Map(brands.map((b) => [b.name, domainOfUrl(b.url)]));
  const brandType = (b) => (b.isOwn ? "You" : b.auto ? "Found in the answers" : "Competitor");

  const runsWith = runs.filter((r) => records.some((x) => x.geo && x.geo.runId === r.id)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const runLabel = new Map(runsWith.map((r, i) => [r.id, `Run ${i + 1}`]));
  const runs2 = runsWith.map((r, i) => ({ id: r.id, label: `Run ${i + 1}`, date: new Date(r.startedAt || 0) }));
  const promptsSorted = [...prompts].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const pid = new Map(promptsSorted.map((p, i) => [p.id, `P${String(i + 1).padStart(2, "0")}`]));
  const promptRows = promptsSorted.filter((p) => records.some((r) => r.geo && r.geo.promptId === p.id)).map((p) => ({ id: pid.get(p.id), text: p.text || "", tags: (p.tags || []).join(", ") }));
  const engines = ENGINE_ORDER.filter((e) => records.some((r) => r.platform === e)).map((e) => ENGINE_LABEL[e]);

  const recs = records.filter((r) => r.geo && runLabel.has(r.geo.runId)).sort((a, b) =>
    runLabel.get(a.geo.runId).localeCompare(runLabel.get(b.geo.runId), undefined, { numeric: true })
    || String(pid.get(a.geo.promptId) || "").localeCompare(String(pid.get(b.geo.promptId) || ""))
    || ENGINE_ORDER.indexOf(a.platform) - ENGINE_ORDER.indexOf(b.platform));

  const A = [], M = [], S = [], Qs = [], P = [], O = [], I = [], H = [];
  recs.forEach((rec, n) => {
    const aid = `A${String(n + 1).padStart(4, "0")}`;
    const run = runLabel.get(rec.geo.runId);
    const runDate = new Date((runsWith.find((r) => r.id === rec.geo.runId) || {}).startedAt || rec.capturedAt || 0);
    const prompt = pid.get(rec.geo.promptId) || "";
    const engine = ENGINE_LABEL[rec.platform] || rec.platform || "";
    const kind = answerKind(rec).label;
    const pres = brandPresence(rec, brands);
    const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
    const rank = new Map(ranked.map((p, i) => [p.name, i + 1]));
    const ownP = pres.find((p) => p.isOwn) || { present: false, mentions: 0 };
    const sources = rec.sources || [];
    const cited = sources.filter((s) => s.outcome === "cited");
    const products = rec.products || [];
    const images = rec.images || [];
    const fan = fanoutOf(rec);
    const text = String(rec.answerText || "");
    const ownCards = products.filter((p) => cardIsBrand(p, OWN)).length;
    const ownImages = images.filter((im) => wordRe(OWN).test(String(im.title || ""))).length;
    const prompText = (promptRows.find((p) => p.id === prompt) || {}).text || rec.userPrompt || "";
    A.push([aid, run, runDate, prompt, prompText, (rec.geo.tags || []).join(", "), kind, engine, new Date(rec.capturedAt || 0),
      rec.searched || sources.length ? 1 : 0, fan.length, fan.filter((f) => f[0] === "Web").length, fan.filter((f) => f[0] === "Shopping").length, fan.filter((f) => f[0] === "Image").length,
      sources.length, cited.length, pres.filter((p) => p.present).length, ownP.present ? 1 : 0, rank.get(OWN) || null, ownP.mentions || 0, rank.get(OWN) === 1 ? 1 : 0,
      ownDom && cited.some((s) => domainMatches(s.domain, ownDom)) ? 1 : 0, products.length, ownCards, images.length, ownImages,
      text ? text.split(/\s+/).filter(Boolean).length : 0,
      answerText === "none" ? "" : answerText === "full" ? text.slice(0, 32000) : text.replace(/\s+/g, " ").slice(0, 300),
      rec.pageUrl || rec.conversationUrl || "",
      // 0.64.0: the ad shown after the answer, if any (ChatGPT only).
      (rec.ads || []).length ? 1 : 0, (rec.ads || []).map((a) => a.advertiser || a.targetDomain || "").filter(Boolean).join(", ")]);

    // One row per tracked brand the answer named (or showed on a card).
    pres.filter((p) => p.present).forEach((p) => {
      const b = brands.find((x) => x.name === p.name) || {};
      const dom = brandDom.get(p.name);
      const pagesNaming = cited.filter((s) => wordRe(p.name).test(`${s.title || ""} ${s.snippet || ""}`)).length;
      const hit = (rec.brandMentions || []).find((m) => normName(m.brand) === p.key);
      const picked = extractBrandAspects((hit && hit.passages) || []).slice(0, 3).join(", ");
      M.push([aid, run, prompt, engine, kind, p.name, brandType(b), rank.get(p.name) || null, p.mentions || 0, rank.get(p.name) === 1 ? 1 : 0, 1,
        picked, pagesNaming, dom && cited.some((s) => domainMatches(s.domain, dom)) ? 1 : 0]);
    });

    // One row per page the engine opened. 0.64.0 adds what the board's
    // citations show: the kind of page, its place among the answer's
    // citations, its rank in ChatGPT's results, the lane, and its date.
    const ranks = resultPositions(rec);
    sources.forEach((s) => {
      const ps = s.platformSpecific || {};
      const pub = typeof ps.pubDate === "number" && ps.pubDate > 0 ? new Date(ps.pubDate < 1e12 ? ps.pubDate * 1000 : ps.pubDate) : null;
      const place = s.outcome === "cited" ? cited.indexOf(s) + 1 : null;
      const d = s.domain || domainOfUrl(s.url);
      const site = brands.find((b) => brandDom.get(b.name) && domainMatches(d, brandDom.get(b.name)));
      const on = `${s.title || ""} ${s.snippet || ""}`;
      const named = brands.filter((b) => wordRe(b.name).test(on)).map((b) => b.name);
      S.push([aid, run, prompt, engine, d, s.url || "", s.title || "", siteKindOf(d, { ownBrand: OWN, ownUrl: own.url, brands: brands.map((b) => b.name) }),
        s.outcome === "cited" ? "Cited" : "Read only", s.outcome === "cited" ? 1 : 0, named.includes(OWN) ? 1 : 0, named.some((x) => x !== OWN) ? 1 : 0,
        named.join(", "), site ? site.name : "", site && site.isOwn ? 1 : 0,
        pageTypeOf(s.url), place, rec.platform === "chatgpt" ? ranks.get(s.url) || null : null, ps.resultSource || ps.refType || "", pub]);
    });

    // One row per search the engine ran.
    fan.forEach(([k, q]) => {
      Qs.push([aid, run, prompt, engine, k, q, q.split(/\s+/).filter(Boolean).length,
        brands.some((b) => wordRe(b.name).test(q)) ? 1 : 0, wordRe(OWN).test(q) ? 1 : 0, YEAR.test(q) ? 1 : 0, /reddit/i.test(q) ? 1 : 0,
        ...(() => { const ops = parseQueryOperators(q); return [ops.siteIncludes.length || ops.siteExcludes.length ? 1 : 0, ops.siteIncludes.join(", "), ops.siteExcludes.join(", ")]; })()]);
    });

    // One row per product card, and per store a card lists.
    products.forEach((p, k) => {
      const b = brands.find((x) => cardIsBrand(p, x.name));
      const stores = merchantsOf(p);
      const imgDom = domainOfUrl(p.image || "");
      const ownStore = (m) => (ownDom && m.toLowerCase().includes(ownDom.split(".")[0])) || wordRe(OWN).test(m);
      P.push([aid, run, prompt, engine, k + 1, p.name || "", b ? b.name : String(p.name || "").split(/\s+/)[0], b && b.isOwn ? 1 : 0, priceOf(p.price).amount, priceOf(p.price).currency || "", p.price || "",
        Number.isFinite(Number(p.rating)) && p.rating !== null ? Number(p.rating) : null, Number.isFinite(Number(p.reviews)) && p.reviews !== null ? Number(p.reviews) : null,
        imgDom, stores[0] || "", stores.length, b && b.isOwn && stores.some(ownStore) ? 1 : 0]);
      stores.forEach((m, j) => O.push([aid, run, engine, p.name || "", b ? b.name : "", j + 1, m, ownStore(m) ? 1 : 0]));
    });

    // One row per image.
    images.forEach((im, k) => {
      const d = domainOfUrl(im.url || "");
      const proxied = PROXY_HOSTS.test(d) ? 1 : 0;
      const shown = brands.find((b) => wordRe(b.name).test(String(im.title || "")));
      I.push([aid, run, prompt, engine, k + 1, d, proxied, im.title || "", shown ? shown.name : "", shown && shown.isOwn ? 1 : 0]);
    });

    // Your brand against each rival, answer by answer.
    brands.filter((b) => !b.isOwn).forEach((b) => {
      const them = pres.find((p) => p.name === b.name) || { present: false };
      const yr = rank.get(OWN) || null, tr = rank.get(b.name) || null;
      const outcome = ownP.present && them.present
        ? (yr && tr ? (yr < tr ? `${OWN} first` : `${b.name} first`) : "Both, no order")
        : ownP.present ? `Only ${OWN}` : them.present ? `Only ${b.name}` : "Neither";
      const tag = ownP.present && them.present ? (yr && tr ? (yr < tr ? "Ahead" : "Behind") : "Both") : ownP.present ? "Only you" : them.present ? "Only them" : "Neither";
      H.push([aid, run, engine, prompt, b.name, yr, tr, outcome, tag]);
    });
  });

  return { own, OWN, ownDom, brands, runs: runs2, prompts: promptRows, engines, A, M, S, Q: Qs, P, O, I, H, profile };
}

/* The raw tables' columns. The prefix names every column in the workbook
   (A_Run, M_Brand, …), so formulas read clearly and survive sorting. */
export const RAW = [
  { key: "A", sheet: "Answers", table: "tAnswers", what: "One row per prompt × engine × run", cols: ["Answer ID", "Run", "Run date", "Prompt ID", "Prompt", "Tags", "Kind of answer", "Engine", "Captured at", "Searched web", "Searches", "Web searches", "Shopping searches", "Image searches", "Pages read", "Pages cited", "Brands named", "You named", "Your position", "Your mentions", "Named first", "Cites your site", "Product cards", "Your cards", "Images", "Your images", "Words", "Answer text", "Conversation URL", "Ad shown", "Advertisers"] },
  { key: "M", sheet: "Mentions", table: "tMentions", what: "One row per tracked brand an answer named", cols: ["Answer ID", "Run", "Prompt ID", "Engine", "Kind of answer", "Brand", "Brand type", "Position", "Mentions", "Named first", "Tracked", "Picked for", "Cited pages naming it", "Its site cited"] },
  { key: "S", sheet: "Sources data", table: "tSources", what: "One row per page an engine opened", cols: ["Answer ID", "Run", "Prompt ID", "Engine", "Domain", "URL", "Page title", "Kind of site", "Outcome", "Cited", "Names you", "Names a rival", "Brands on page", "Site of brand", "Your site", "Kind of page", "Place among citations", "Search result", "Found through", "Published"] },
  { key: "Q", sheet: "Engine searches", table: "tSearches", what: "One row per search an engine ran", cols: ["Answer ID", "Run", "Prompt ID", "Engine", "Kind of search", "Search text", "Words", "Names a brand", "Names you", "Has a year", "Asks Reddit", "Uses site:", "site: sites", "Sites left out"] },
  { key: "P", sheet: "Product cards", table: "tProducts", what: "One row per product card", cols: ["Answer ID", "Run", "Prompt ID", "Engine", "Card position", "Product", "Brand", "Yours", "Price", "Currency", "Price as shown", "Rating", "Reviews", "Image from", "Card sends buyers to", "Stores listed", "Your store listed"] },
  { key: "O", sheet: "Store offers", table: "tOffers", what: "One row per store a product card lists", cols: ["Answer ID", "Run", "Engine", "Product", "Brand", "Store rank", "Store", "Your store"] },
  { key: "I", sheet: "Images", table: "tImages", what: "One row per image in an answer", cols: ["Answer ID", "Run", "Prompt ID", "Engine", "Image position", "Image from", "Served by the engine", "Image title", "Brand shown", "Yours"] },
  { key: "H", sheet: "Head to head", table: "tH2H", what: "One row per answer × rival", cols: ["Answer ID", "Run", "Engine", "Prompt ID", "Competitor", "Your position", "Rival position", "Outcome", "Result"] },
];
const camel = (s) => s.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
export const colNameOf = (key, col) => `${key}_${camel(col)}`;

/* ---------- Q: a formula and its value, from one rule ----------
 *
 * Each criterion is { f: formula text, v: the value it stands for }. A
 * criterion's value "*" matches any non-empty text, as COUNTIFS's "*" does.
 */
const matches = (cell, v) => {
  if (v === "*") return cell !== null && cell !== undefined && cell !== "" && typeof cell === "string";
  if (typeof v === "number") return Number(cell) === v;
  return String(cell ?? "").toLowerCase() === String(v ?? "").toLowerCase();
};
export class Q {
  constructor(facts, key) {
    this.facts = facts;
    this.key = key;
    this.def = RAW.find((r) => r.key === key);
    this.rows = facts[key];
    this.crits = [];
  }
  col(name) {
    const i = this.def.cols.indexOf(name);
    if (i < 0) throw new Error(`No column ${name} in ${this.def.sheet}`);
    return i;
  }
  where(col, crit) {
    const q = new Q(this.facts, this.key);
    q.crits = [...this.crits, { col, ...crit }];
    return q;
  }
  pick() {
    return this.rows.filter((r) => this.crits.every((c) => matches(r[this.col(c.col)], c.v)));
  }
  pairs() { return this.crits.map((c) => `${colNameOf(this.key, c.col)},${c.f}`).join(","); }
  count() { return { f: `COUNTIFS(${this.pairs()})`, v: this.pick().length }; }
  sum(col) {
    const i = this.col(col);
    return { f: `SUMIFS(${colNameOf(this.key, col)},${this.pairs()})`, v: this.pick().reduce((a, r) => a + (Number(r[i]) || 0), 0) };
  }
  avg(col) {
    const i = this.col(col);
    const vals = this.pick().map((r) => r[i]).filter((x) => typeof x === "number");
    return { f: `IFERROR(AVERAGEIFS(${colNameOf(this.key, col)},${this.pairs()}),"")`, v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : "" };
  }
}
export const lit = (v) => ({ f: typeof v === "number" ? String(v) : `"${String(v).replace(/"/g, '""')}"`, v });
export const ratio = (a, b) => ({ f: `IFERROR(${a.f}/${b.f},0)`, v: b.v ? a.v / b.v : 0 });

/* ---------- the workbook ---------- */

const INK = "0F172A", MUTED = "64748B", NAVY = "1E3A8A", LINE = "D5DDE8", GREEN = "15803D", RED = "B91C1C", PALE = "F1F5F9", PICK = "FEF3C7";
const OWN_COLOR = "2A78D6";
const RIVAL_COLORS = ["EB6834", "1BAF7A", "4A3AA7", "EDA100", "64748B", "C2410C", "0E7490", "A21CAF"];
const thin = { color: LINE };
const ST = {
  title: { font: { bold: true, size: 16 } },
  sub: { font: { color: MUTED } },
  note: { font: { color: MUTED, italic: true } },
  section: { font: { bold: true, size: 12 } },
  th: { font: { bold: true, color: "FFFFFF" }, fill: NAVY, align: { v: "center", wrap: true } },
  thc: { font: { bold: true, color: "FFFFFF" }, fill: NAVY, align: { h: "center", v: "center", wrap: true } },
  text: { border: { bottom: thin }, align: { v: "top" } },
  wrap: { border: { bottom: thin }, align: { v: "top", wrap: true } },
  bold: { font: { bold: true }, border: { bottom: thin } },
  int: { numFmt: "#,##0", align: { h: "center" }, border: { bottom: thin } },
  pct: { numFmt: "0%", align: { h: "center" }, border: { bottom: thin } },
  dec: { numFmt: "0.0", align: { h: "center" }, border: { bottom: thin } },
  dpct: { numFmt: '+0%;-0%;0%', align: { h: "center" }, border: { bottom: thin } },
  ddec: { numFmt: '+0.0;-0.0;0.0', align: { h: "center" }, border: { bottom: thin } },
  dint: { numFmt: '+#,##0;-#,##0;0', align: { h: "center" }, border: { bottom: thin } },
  link: { font: { color: "2563EB", underline: true } },
  pick: { font: { bold: true }, fill: PICK, border: { left: { color: "D97706" }, right: { color: "D97706" }, top: { color: "D97706" }, bottom: { color: "D97706" } } },
  total: { font: { bold: true }, fill: PALE, border: { bottom: thin } },
  totalInt: { font: { bold: true }, fill: PALE, numFmt: "#,##0", align: { h: "center" }, border: { bottom: thin } },
  totalPct: { font: { bold: true }, fill: PALE, numFmt: "0%", align: { h: "center" }, border: { bottom: thin } },
  date: { numFmt: "yyyy-mm-dd", align: { h: "center" }, border: { bottom: thin } },
  datetime: { numFmt: "yyyy-mm-dd hh:mm", border: { bottom: thin } },
};
const GOOD = { font: { bold: true, color: GREEN } };
const BAD = { font: { bold: true, color: RED } };

const DEFS = [
  ["Answer", "One engine's reply to one prompt in one run. Most rates are out of answers."],
  ["Visibility", "Answers that named the brand ÷ answers. Reach, not volume."],
  ["Share of voice", "The brand's mentions ÷ mentions of every tracked brand. Volume, among the brands you track."],
  ["Average position", "Where the brand came among the tracked brands named, by first appearance. 1 is first; lower is better."],
  ["Named first", "Answers where the brand was the first tracked brand named."],
  ["Citations of your site", "Pages from your site the engines cited in their answers."],
  ["Source visibility", "Answers that cited your site at least once ÷ answers."],
  ["Card share", "Product cards for the brand ÷ all product cards."],
  ["Cited rate", "Pages cited ÷ pages read, for a site or a kind of site."],
  ["Flags", "1 = yes and 0 = no, so SUM counts and AVERAGE gives a rate."],
];

const LEVERS = {
  Shopping: "Product feed, retailer listings and the review sites that decide the carousel.",
  Informational: "The explainer and review pages the engines cite.",
  Images: "Image-rich pages and product imagery the engines can reuse.",
  "From memory": "No search ran: only what the model already knows about you.",
  Local: "Map listings: name, category, reviews and the website on the listing.",
};

/**
 * The workbook. bundle as for campaignFacts, plus generatedAt.
 * Returns { wb, facts, stats } — stats counts sheets, charts, formulas and names.
 */
export function buildCampaignXlsx(bundle = {}) {
  const F = campaignFacts(bundle);
  const { OWN, brands, runs, prompts, engines } = F;
  const profileName = (F.profile && F.profile.name) || "Campaign";
  const wb = new Workbook({ title: `${profileName} — campaign workbook`, created: new Date(bundle.generatedAt || Date.now()) });
  const stats = { formulas: 0, charts: 0 };
  const latest = runs.length ? runs[runs.length - 1].label : "All runs";
  const prevLabel = runs.length > 1 ? runs[runs.length - 2].label : "(none)";
  const RUN = { f: "RunCrit", v: runs.length ? latest : "*" };
  const ENG = { f: "EngCrit", v: "*" };
  const PREV = { f: "PrevCrit", v: prevLabel };
  const brandColor = new Map(brands.map((b, i) => [b.name, b.isOwn ? OWN_COLOR : RIVAL_COLORS[(brands.filter((x) => !x.isOwn).indexOf(b)) % RIVAL_COLORS.length]]));
  const rivals = brands.filter((b) => !b.isOwn);
  // What the export dialog left out. Answers and Mentions are always in:
  // every summary reads them. Leaving a table out takes out the sheets and
  // sections that read it, so no formula ever points at a missing range.
  const inc = { pages: true, searches: true, products: true, images: true, h2h: true, ...(bundle.include || {}) };
  const RAW_ON = RAW.filter((d) => ({ A: true, M: true, S: inc.pages, Q: inc.searches, P: inc.products, O: inc.products, I: inc.images, H: inc.h2h })[d.key]);
  const multi = runs.length > 1;

  // A cell holding a formula and its value; counts formulas for the Start here sheet.
  const fx = (q) => ({ f: q.f, v: q.v });
  const put = (sh, r, c, v, st) => { if (v && typeof v === "object" && "f" in v) stats.formulas++; sh.set([r, c], v, st); };
  const chart = (sh, spec) => { stats.charts++; sh.chart(spec); };
  const T = (key) => new Q(F, key);
  const inView = (key) => T(key).where("Run", RUN).where("Engine", ENG);
  const atPrev = (key) => T(key).where("Run", PREV).where("Engine", ENG);

  /* sheets, in tab order */
  const SUM = ["Start here", "Overview", ...(multi ? ["Trends"] : []), "Brands", "Prompts", "Answer types", ...(inc.pages ? ["Sources"] : []),
    ...(inc.products || inc.images ? ["Products"] : []), ...(inc.searches ? ["Searches"] : []), ...(multi ? ["Run over run"] : []), "Actions"];
  const sh = {};
  SUM.forEach((n, i) => { sh[n] = wb.addSheet(n, { tabColor: i === 0 ? "0F172A" : "2A78D6", gridlines: false, print: { portrait: false } }); });
  RAW_ON.forEach((r) => { sh[r.sheet] = wb.addSheet(r.sheet, { tabColor: "94A3B8", print: { titleRows: "3:3" } }); });

  const header = (s, title, question, follows = true) => {
    s.set("B1", "← Start here", ST.link).link("B1", { location: "'Start here'!A1", display: "Start here" });
    s.set("B2", title, ST.title).set("B3", question, ST.sub);
    if (follows) put(s, 4, 2, { f: `"Run: "&RunKey&"   ·   Engine: "&EngKey&"   (change them on Overview)"`, v: `Run: ${latest}   ·   Engine: All engines   (change them on Overview)` }, ST.note);
    s.width("A", 2).width("B", 30);
  };
  // Header rows get a fixed height: charts are anchored to rows, and an app
  // that sizes wrapped headers itself would otherwise slide a chart over a table.
  const thRow = (s, r, c0, heads) => { s.height(r, 30); heads.forEach((h, i) => s.set([r, c0 + i], h, i === 0 ? ST.th : ST.thc)); };
  const countUnit = (vals) => (Math.max(0, ...vals.map((v) => Number(v) || 0)) <= 10 ? 1 : undefined);

  /* ----- raw tables first: their named columns are what everything reads ----- */
  RAW_ON.forEach((def) => {
    const s = sh[def.sheet];
    const rows = F[def.key];
    s.set("A1", "← Start here", ST.link).link("A1", { location: "'Start here'!A1", display: "Start here" });
    s.set("B1", `${def.sheet}: ${def.what}. ${rows.length.toLocaleString("en-US")} rows.`, { font: { bold: true } });
    def.cols.forEach((c, i) => s.set([3, i + 1], c, ST.th));
    rows.forEach((row, ri) => row.forEach((v, ci) => {
      const col = def.cols[ci];
      const st = v instanceof Date ? (/at$/.test(col) ? ST.datetime : ST.date) : typeof v === "number" ? undefined : undefined;
      s.set([4 + ri, ci + 1], v === null ? "" : v, st);
    }));
    const last = Math.max(4, 3 + rows.length);
    s.table({ ref: `A3:${colName(def.cols.length)}${last}`, name: def.table, columns: def.cols });
    s.freeze("B4");
    def.cols.forEach((c, i) => {
      s.width(i + 1, /text|Prompt$|Page title|Search text|URL|Product$/.test(c) ? 40 : c.length > 14 ? 16 : 13);
      wb.defineName(colNameOf(def.key, c), absRange(def.sheet, i + 1, 4, i + 1, last));
    });
  });

  /* ----- Start here ----- */
  {
    const s = sh["Start here"];
    s.width("A", 2).width("B", 26).width("C", 60).width("D", 14);
    s.set("B2", `${profileName}: the campaign workbook`, ST.title);
    s.set("B3", `Exported by CitoSkeleton on ${new Date(bundle.generatedAt || Date.now()).toISOString().slice(0, 10)}. Every number on the blue sheets is a live formula over the grey raw tables.`, ST.sub);
    let r = 5;
    s.set([r, 2], "The campaign", ST.section); r++;
    [["Your brand", `${OWN}${F.ownDom ? ` (${F.ownDom})` : ""}`], ["Competitors", rivals.map((b) => b.name + (b.auto ? " (found in the answers)" : "")).join(", ") || "None"],
      ["Engines", engines.join(", ") || "None"], ["Prompts", String(prompts.length)], ["Runs", runs.map((x) => `${x.label} (${x.date.toISOString().slice(0, 10)})`).join(", ") || "None"],
      ["Answers", String(F.A.length)]].forEach(([k, v]) => { s.set([r, 2], k, ST.bold).set([r, 3], v, ST.wrap); r++; });
    r++;
    s.set([r, 2], "How to use it", ST.section); r++;
    ["Pick a run and an engine in the two yellow cells on Overview. Every summary sheet, chart and finding follows them.",
      "Read the blue summary sheets: each answers one question, with charts.",
      "Go deeper in the grey raw tables: filter them, sort them, or Insert → PivotTable. Answer ID joins every table to Answers."]
      .forEach((t, i) => { s.set([r, 2], `${i + 1}.`, { align: { h: "right", v: "top" } }).set([r, 3], t, { align: { wrap: true, v: "top" } }); r++; });
    r++;
    s.set([r, 2], "Runs", ST.section); r++;
    thRow(s, r, 2, ["Run", "Started", "Answers"]); r++;
    const runRow0 = r;
    runs.forEach((x) => {
      s.set([r, 2], x.label, ST.text).set([r, 3], x.date, { ...ST.date, align: { h: "left" } });
      put(s, r, 4, fx(T("A").where("Run", { f: cellRef(r, 2), v: x.label }).count()), ST.int);
      r++;
    });
    wb.defineName("RunList", absRange("Start here", 2, runRow0, 2, Math.max(runRow0, r - 1)));
    r++;
    s.set([r, 2], "Every sheet", ST.section); r++;
    thRow(s, r, 2, ["Sheet", "What it answers", "Rows"]); r++;
    const what = {
      Overview: `Where ${OWN} stands in the run and engine you pick`, Trends: "How every brand moved across runs", Brands: "Who gets named, how high, and who beats whom",
      Prompts: `How ${OWN} does on every prompt`, "Answer types": "Shopping, informational, images, from memory, local", Sources: "Which sites and pages the engines use",
      Products: "Product cards, the stores they list, and images", Searches: "The searches the engines ran", "Run over run": `${OWN}'s position on every prompt and engine, run by run`,
      Actions: "Where to act next",
    };
    SUM.slice(1).forEach((n) => { s.set([r, 2], n, { ...ST.link, border: { bottom: thin } }).link(cellRef(r, 2), { location: `${sheetRef(n)}!A1`, display: n }).set([r, 3], what[n], ST.text).set([r, 4], "", ST.text); r++; });
    RAW_ON.forEach((d) => { s.set([r, 2], d.sheet, { ...ST.link, border: { bottom: thin } }).link(cellRef(r, 2), { location: `${sheetRef(d.sheet)}!A1`, display: d.sheet }).set([r, 3], d.what, ST.text).set([r, 4], F[d.key].length, ST.int); r++; });
    r++;
    s.set([r, 2], "What the measures mean", ST.section); r++;
    DEFS.forEach(([k, v]) => { s.set([r, 2], k, ST.bold).set([r, 3], v, ST.wrap); r++; });
    const gl = glossaryEntries().filter((g) => ["sourceVisibility", "citedRate", "readOnly", "fanout", "autoCompetitor", "sentiment"].includes(g.key));
    gl.forEach((g) => { s.set([r, 2], g.term, ST.bold).set([r, 3], `${g.what}${g.note ? ` ${g.note}` : ""}`, ST.wrap); r++; });
    r++;
    s.set([r, 2], "Not in this file", ST.section); r++;
    s.set([r, 3], "A store's own price, which claims a page backs, and which search led to which page are not in a capture, so there is no column for them rather than a guessed one. Tone isn't scored: a mention counts the same whether the answer praises or criticises the brand.", { align: { wrap: true, v: "top" } });
    s.height(r, 48);
  }

  /* ----- Overview ----- */
  const ov = sh.Overview;
  header(ov, `Where ${OWN} stands`, "Pick a run and an engine; every blue sheet follows these two yellow cells.", false);
  ov.width("C", 16).width("D", 16).width("E", 14).width("F", 14).width("G", 14).width("H", 14).width("I", 14).width("J", 16).width("Z", 12, { hidden: true });
  ov.set("B5", "Run", ST.bold).set("C5", latest, ST.pick).dropdown("C5", [...runs.map((x) => x.label), "All runs"], { prompt: "One run, or all runs combined" });
  ov.set("B6", "Engine", ST.bold).set("C6", "All engines", ST.pick).dropdown("C6", ["All engines", ...engines], { prompt: "One engine, or all of them" });
  ov.set("D5", "← every summary follows these", ST.note);
  wb.defineName("RunKey", "'Overview'!$C$5").defineName("EngKey", "'Overview'!$C$6");
  // The criteria the formulas use, in a hidden column: "*" matches every run or engine.
  put(ov, 5, 26, { f: 'IF(RunKey="All runs","*",RunKey)', v: RUN.v });
  put(ov, 6, 26, { f: 'IF(EngKey="All engines","*",EngKey)', v: "*" });
  put(ov, 7, 26, { f: 'IFERROR(IF(MATCH(RunKey,RunList,0)>1,INDEX(RunList,MATCH(RunKey,RunList,0)-1),"(none)"),"(none)")', v: prevLabel });
  wb.defineName("RunCrit", "'Overview'!$Z$5").defineName("EngCrit", "'Overview'!$Z$6").defineName("PrevCrit", "'Overview'!$Z$7");

  let r = 8;
  ov.set([r, 2], `${OWN}, headline numbers`, ST.section); r++;
  thRow(ov, r, 2, ["Measure", "Run picked", "Run before", "Change"]);
  put(ov, r, 3, { f: 'RunKey', v: latest }, ST.thc); put(ov, r, 4, { f: 'IF(PrevCrit="(none)","No run before",PrevCrit)', v: prevLabel === "(none)" ? "No run before" : prevLabel }, ST.thc);
  r++;
  const ownQ = (q) => q.where("Brand", lit(OWN));
  const measures = [
    ["Answers", (v) => v("A").count(), ST.int, ST.dint, 0],
    ["Visibility", (v) => ratio(ownQ(v("M")).count(), v("A").count()), ST.pct, ST.dpct, 1],
    ["Share of voice", (v) => ratio(ownQ(v("M")).sum("Mentions"), v("M").sum("Mentions")), ST.pct, ST.dpct, 1],
    ["Average position", (v) => ownQ(v("M")).avg("Position"), ST.dec, ST.ddec, -1],
    ["Named first", (v) => ownQ(v("M")).sum("Named first"), ST.int, ST.dint, 1],
    ...(inc.pages ? [["Citations of your site", (v) => v("S").where("Your site", lit(1)).where("Cited", lit(1)).count(), ST.int, ST.dint, 1]] : []),
    ["Source visibility", (v) => ratio(v("A").sum("Cites your site"), v("A").count()), ST.pct, ST.dpct, 1],
    ...(inc.products ? [["Product card share", (v) => ratio(v("P").where("Yours", lit(1)).count(), v("P").count()), ST.pct, ST.dpct, 1]] : []),
  ];
  const headline = {};
  measures.forEach(([label, make, st, dst, better]) => {
    const cur = make(inView), prev = make(atPrev);
    ov.set([r, 2], label, ST.text);
    put(ov, r, 3, fx(cur), st);
    put(ov, r, 4, { f: `IF(PrevCrit="(none)","",${prev.f})`, v: prevLabel === "(none)" ? "" : prev.v }, st);
    const dv = prevLabel === "(none)" || cur.v === "" || prev.v === "" ? "" : cur.v - prev.v;
    put(ov, r, 5, { f: `IF(OR(D${r}="",C${r}=""),"",C${r}-D${r})`, v: dv }, dst);
    if (better) {
      ov.cond(`E${r}`, { type: "cellIs", op: better > 0 ? "greaterThan" : "lessThan", formula: "0", style: GOOD });
      ov.cond(`E${r}`, { type: "cellIs", op: better > 0 ? "lessThan" : "greaterThan", formula: "0", style: BAD });
    }
    headline[label] = { row: r, v: cur.v };
    r++;
  });
  r++;

  // Every brand compared.
  ov.set([r, 2], "Every brand compared", ST.section); r++;
  thRow(ov, r, 2, ["Brand", "Type", "Visibility", "Share of voice", "Average position", "Mentions", "Named first", ...(inc.pages ? ["Citations of its site"] : []), ...(inc.products ? ["Product cards"] : [])]); r++;
  const b0 = r;
  const answersInView = inView("A").count();
  const brandRows = [];
  brands.forEach((b) => {
    const m = inView("M").where("Brand", { f: `$B${r}`, v: b.name });
    const vis = ratio(m.count(), answersInView), sov = ratio(m.sum("Mentions"), inView("M").sum("Mentions"));
    ov.set([r, 2], b.name, b.isOwn ? ST.bold : ST.text).set([r, 3], b.isOwn ? "You" : b.auto ? "Found in the answers" : "Competitor", ST.text);
    put(ov, r, 4, fx(vis), ST.pct); put(ov, r, 5, fx(sov), ST.pct); put(ov, r, 6, fx(m.avg("Position")), ST.dec);
    put(ov, r, 7, fx(m.sum("Mentions")), ST.int); put(ov, r, 8, fx(m.sum("Named first")), ST.int);
    let c = 9;
    if (inc.pages) put(ov, r, c++, fx(inView("S").where("Site of brand", { f: `$B${r}`, v: b.name }).where("Cited", lit(1)).count()), ST.int);
    if (inc.products) put(ov, r, c++, fx(inView("P").where("Brand", { f: `$B${r}`, v: b.name }).count()), ST.int);
    brandRows.push({ name: b.name, vis: vis.v, sov: sov.v });
    r++;
  });
  const bl = r - 1;
  if (brands.length) {
    ov.cond(`D${b0}:D${bl}`, { type: "dataBar", color: "93C5FD", max: 1 });
    ov.cond(`E${b0}:E${bl}`, { type: "dataBar", color: "C4B5FD" });
    chart(ov, { type: "bar", title: "Share of voice", from: `L${b0 - 1}`, cols: 7, rows: Math.max(10, brands.length + 6), valFmt: "0%", reverse: true, legend: false,
      series: [{ name: "Share of voice", cats: absRange("Overview", 2, b0, 2, bl), vals: absRange("Overview", 5, b0, 5, bl), catCache: brandRows.map((x) => x.name), valCache: brandRows.map((x) => x.sov), pointColors: brands.map((b) => brandColor.get(b.name)) }] });
  }
  r++;

  // You on each engine.
  ov.set([r, 2], `${OWN} on each engine`, ST.section); r++;
  thRow(ov, r, 2, ["Engine", "Answers", "Visibility", "Source visibility", "Average position"]); r++;
  const e0 = r;
  const engRows = [];
  engines.forEach((e) => {
    const a = T("A").where("Run", RUN).where("Engine", { f: `$B${r}`, v: e });
    const m = T("M").where("Run", RUN).where("Engine", { f: `$B${r}`, v: e }).where("Brand", lit(OWN));
    const vis = ratio(m.count(), a.count()), sv = ratio(a.sum("Cites your site"), a.count());
    ov.set([r, 2], e, ST.text);
    put(ov, r, 3, fx(a.count()), ST.int); put(ov, r, 4, fx(vis), ST.pct); put(ov, r, 5, fx(sv), ST.pct); put(ov, r, 6, fx(m.avg("Position")), ST.dec);
    engRows.push({ e, vis: vis.v, sv: sv.v });
    r++;
  });
  const el = r - 1;
  if (engines.length) {
    ov.cond(`D${e0}:E${el}`, { type: "colorScale", colors: ["FEE2E2", "FFFFFF", "BBF7D0"], values: [0, 0.5, 1] });
    chart(ov, { type: "col", title: `${OWN}: visibility and source visibility by engine`, from: `L${e0 - 1}`, cols: 7, rows: 14, valFmt: "0%", min: 0, max: 1,
      series: [
        { name: "Visibility", cats: absRange("Overview", 2, e0, 2, el), vals: absRange("Overview", 4, e0, 4, el), catCache: engRows.map((x) => x.e), valCache: engRows.map((x) => x.vis), color: OWN_COLOR },
        { name: "Source visibility", cats: absRange("Overview", 2, e0, 2, el), vals: absRange("Overview", 5, e0, 5, el), catCache: engRows.map((x) => x.e), valCache: engRows.map((x) => x.sv), color: "1BAF7A" }] });
  }
  r += Math.max(0, 15 - engines.length - 2);

  // Answers by kind.
  ov.set([r, 2], "Answers by kind", ST.section); r++;
  thRow(ov, r, 2, ["Kind of answer", "Answers", `${OWN} named`]); r++;
  const k0 = r;
  const kindRows = [];
  KINDS.forEach((k) => {
    const a = inView("A").where("Kind of answer", { f: `$B${r}`, v: k });
    ov.set([r, 2], k, ST.text); put(ov, r, 3, fx(a.count()), ST.int); put(ov, r, 4, fx(ratio(a.sum("You named"), a.count())), ST.pct);
    kindRows.push({ k, n: a.count().v });
    r++;
  });
  chart(ov, { type: "doughnut", title: "Answers by kind", from: `L${k0 - 1}`, cols: 7, rows: 13,
    series: [{ name: "Answers", cats: absRange("Overview", 2, k0, 2, r - 1), vals: absRange("Overview", 3, k0, 3, r - 1), catCache: kindRows.map((x) => x.k), valCache: kindRows.map((x) => x.n) }],
    colors: ["2A78D6", "1BAF7A", "4A3AA7", "64748B", "EB6834"] });
  r += 6;

  // The most-cited sites.
  let topSites = [], siteRows = [], t0 = 0;
  if (inc.pages) {
  const siteCount = new Map();
  F.S.forEach((row) => { if (row[9]) siteCount.set(row[4], (siteCount.get(row[4]) || 0) + 1); });
  topSites = [...siteCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d]) => d);
  ov.set([r, 2], "The most-cited sites", ST.section); r++;
  thRow(ov, r, 2, ["Site", "Pages read", "Pages cited", "Cited rate", `Cited pages naming ${OWN}`, "Cites rivals, never you"]); r++;
  t0 = r;
  topSites.forEach((d) => {
    const s = inView("S").where("Domain", { f: `$B${r}`, v: d });
    const read = s.count(), cited = s.where("Cited", lit(1)).count(), mine = s.where("Cited", lit(1)).where("Names you", lit(1)).count(), riv = s.where("Cited", lit(1)).where("Names a rival", lit(1)).count();
    ov.set([r, 2], d, ST.text);
    put(ov, r, 3, fx(read), ST.int); put(ov, r, 4, fx(cited), ST.int); put(ov, r, 5, fx(ratio(cited, read)), ST.pct); put(ov, r, 6, fx(mine), ST.int);
    put(ov, r, 7, { f: `IF(AND(${riv.f}>0,F${r}=0),"Yes","")`, v: riv.v > 0 && mine.v === 0 ? "Yes" : "" }, { ...ST.text, align: { h: "center" } });
    siteRows.push({ d, cited: cited.v });
    r++;
  });
  if (topSites.length) {
    ov.cond(`D${t0}:D${r - 1}`, { type: "dataBar", color: "86EFAC" });
    ov.cond(`G${t0}:G${r - 1}`, { type: "cellIs", op: "equal", formula: '"Yes"', style: BAD });
    chart(ov, { type: "bar", title: "Citations by site", from: `L${t0 - 1}`, cols: 7, rows: Math.max(10, topSites.length + 5), reverse: true, legend: false, majorUnit: countUnit(siteRows.map((x) => x.cited)),
      series: [{ name: "Pages cited", cats: absRange("Overview", 2, t0, 2, r - 1), vals: absRange("Overview", 4, t0, 4, r - 1), catCache: siteRows.map((x) => x.d), valCache: siteRows.map((x) => x.cited), color: "1BAF7A" }] });
  }
  r++;
  }

  // Findings, written by formulas so they follow the pickers.
  ov.set([r, 2], "Findings", ST.section); r++;
  const vis = headline.Visibility, sov = headline["Share of voice"];
  const pctTxt = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
  const findings = [];
  findings.push({ f: `"${OWN} was named in "&TEXT(C${vis.row},"0%")&" of the answers, with "&TEXT(C${sov.row},"0%")&" of the voice among tracked brands."`, v: `${OWN} was named in ${pctTxt(vis.v)} of the answers, with ${pctTxt(sov.v)} of the voice among tracked brands.` });
  if (engines.length > 1) {
    const best = engRows.reduce((a, b) => (b.vis > a.vis ? b : a), engRows[0]);
    findings.push({ f: `"Most visible on "&INDEX(B${e0}:B${el},MATCH(MAX(D${e0}:D${el}),D${e0}:D${el},0))&" ("&TEXT(MAX(D${e0}:D${el}),"0%")&")."`, v: `Most visible on ${best.e} (${pctTxt(best.vis)}).` });
  }
  if (rivals.length) {
    const rv = brandRows.filter((x) => x.name !== OWN);
    const top = rv.reduce((a, b) => (b.sov > a.sov ? b : a), rv[0]);
    const rr0 = b0 + brands.findIndex((b) => !b.isOwn);
    // Rival rows follow your row in the brand table.
    findings.push({ f: `"The loudest rival is "&INDEX(B${rr0}:B${bl},MATCH(MAX(E${rr0}:E${bl}),E${rr0}:E${bl},0))&", with "&TEXT(MAX(E${rr0}:E${bl}),"0%")&" of the voice."`, v: `The loudest rival is ${top.name}, with ${pctTxt(top.sov)} of the voice.` });
  }
  if (topSites.length) findings.push({ f: `"The most-cited site is "&B${t0}&" ("&D${t0}&" pages cited)."`, v: `The most-cited site is ${topSites[0]} (${siteRows[0].cited} pages cited).` });
  const gaps = siteRows.filter((x) => { const s = inView("S").where("Domain", lit(x.d)).where("Cited", lit(1)); return s.where("Names a rival", lit(1)).count().v > 0 && s.where("Names you", lit(1)).count().v === 0; }).length;
  if (topSites.length) findings.push({ f: `COUNTIF(G${t0}:G${t0 + topSites.length - 1},"Yes")&" of the top sites cite rivals but never ${OWN.replace(/"/g, '""')}."`, v: `${gaps} of the top sites cite rivals but never ${OWN}.` });
  findings.forEach((fv) => { put(ov, r, 2, fv, { align: { wrap: false } }); r++; });
  ov.freeze("A8");

  if (multi) buildTrends();
  buildBrands(); buildPrompts(); buildKinds();
  if (sh.Sources) buildSources();
  if (sh.Products) buildProducts();
  if (sh.Searches) buildSearches();
  if (multi) buildRunOverRun();
  buildActions();
  wb.activeTab = 1;
  stats.sheets = wb.sheets.length;
  stats.names = wb.names.length;
  return { wb, facts: F, stats };

  /* ----- Trends: every brand, run by run (follows the engine picker) ----- */
  function buildTrends() {
    const s = sh.Trends;
    header(s, "Trends", "How every brand moved across runs. Follows the engine picker; every run is shown.");
    let r = 6;
    const tables = [
      ["Visibility", (m, a) => ratio(m.count(), a.count()), ST.pct, 1],
      ["Share of voice", (m, a, all) => ratio(m.sum("Mentions"), all.sum("Mentions")), ST.pct, 1],
      ["Average position (lower is better)", (m) => m.avg("Position"), ST.dec, -1],
    ];
    tables.forEach(([title, make, st, better], ti) => {
      s.set([r, 2], title, ST.section); r++;
      thRow(s, r, 2, ["Brand", ...runs.map((x) => x.label), "Change"]); r++;
      const r0 = r;
      const cache = [];
      brands.forEach((b) => {
        s.set([r, 2], b.name, b.isOwn ? ST.bold : ST.text);
        const vals = runs.map((x, j) => {
          const runCrit = lit(x.label);
          const a = T("A").where("Run", runCrit).where("Engine", ENG);
          const m = T("M").where("Run", runCrit).where("Engine", ENG).where("Brand", { f: `$B${r}`, v: b.name });
          const all = T("M").where("Run", runCrit).where("Engine", ENG);
          const q = make(m, a, all);
          put(s, r, 3 + j, fx(q), st);
          return q.v;
        });
        if (runs.length > 1) {
          const c1 = colName(3), cl = colName(2 + runs.length);
          const dv = vals[0] === "" || vals[vals.length - 1] === "" ? "" : vals[vals.length - 1] - vals[0];
          put(s, r, 3 + runs.length, { f: `IF(OR(${c1}${r}="",${cl}${r}=""),"",${cl}${r}-${c1}${r})`, v: dv }, st === ST.pct ? ST.dpct : ST.ddec);
          s.cond(`${colName(3 + runs.length)}${r}`, { type: "cellIs", op: better > 0 ? "greaterThan" : "lessThan", formula: "0", style: GOOD });
          s.cond(`${colName(3 + runs.length)}${r}`, { type: "cellIs", op: better > 0 ? "lessThan" : "greaterThan", formula: "0", style: BAD });
        }
        cache.push(vals);
        r++;
      });
      if (runs.length && brands.length) {
        chart(s, { type: "line", title: title.replace(" (lower is better)", " (1 = named first)"), from: `${colName(5 + runs.length)}${r0 - 2}`, cols: 8, rows: Math.max(12, brands.length + 6), valFmt: st === ST.pct ? "0%" : "0.0",
          ...(st === ST.pct ? { min: 0, max: 1 } : { valReverse: true, min: 1, majorUnit: 1 }),
          series: brands.map((b, i) => ({ name: b.name, nameRef: absRange("Trends", 2, r0 + i), cats: absRange("Trends", 3, r0 - 1, 2 + runs.length, r0 - 1), vals: absRange("Trends", 3, r0 + i, 2 + runs.length, r0 + i),
            catCache: runs.map((x) => x.label), valCache: cache[i].map((v) => (v === "" ? null : v)), color: brandColor.get(b.name) })) });
      }
      r = Math.max(r + 1, r0 + Math.max(12, brands.length + 6) - 1);
    });
    // You, by engine and run.
    s.set([r, 2], `${OWN}: visibility by engine and run`, ST.section); r++;
    thRow(s, r, 2, ["Engine", ...runs.map((x) => x.label)]); r++;
    const r0 = r;
    const cache = [];
    engines.forEach((e) => {
      s.set([r, 2], e, ST.text);
      cache.push(runs.map((x, j) => {
        const a = T("A").where("Run", lit(x.label)).where("Engine", { f: `$B${r}`, v: e });
        const q = ratio(T("M").where("Run", lit(x.label)).where("Engine", { f: `$B${r}`, v: e }).where("Brand", lit(OWN)).count(), a.count());
        put(s, r, 3 + j, fx(q), ST.pct);
        return q.v;
      }));
      r++;
    });
    if (engines.length && runs.length) {
      s.cond(`C${r0}:${colName(2 + runs.length)}${r - 1}`, { type: "colorScale", colors: ["FEE2E2", "FFFFFF", "BBF7D0"], values: [0, 0.5, 1] });
      chart(s, { type: "col", title: `${OWN} visibility by engine and run`, from: `${colName(5 + runs.length)}${r0 - 2}`, cols: 8, rows: 14, valFmt: "0%", min: 0, max: 1,
        series: runs.map((x, j) => ({ name: x.label, nameRef: absRange("Trends", 3 + j, r0 - 1), cats: absRange("Trends", 2, r0, 2, r - 1), vals: absRange("Trends", 3 + j, r0, 3 + j, r - 1),
          catCache: engines, valCache: cache.map((row) => row[j]), color: ["94A3B8", "60A5FA", "2A78D6", "1E3A8A", "0F172A"][Math.max(0, 5 - runs.length + j) % 5] })) });
    }
    s.width("C", 12).freeze("C6");
    for (let j = 0; j < runs.length + 1; j++) s.width(3 + j, 12);
  }

  /* ----- Brands: scorecard, engines, head to head, what each is picked for ----- */
  function buildBrands() {
    const s = sh.Brands;
    header(s, "Brands", "Who gets named, how high, what backs them, and who beats whom.");
    let r = 6;
    s.set([r, 2], "Scorecard", ST.section); r++;
    thRow(s, r, 2, ["Brand", "Type", "Answers naming it", "Visibility", "Share of voice", "Average position", "Mentions", "Named first", "Cited pages naming it", "Answers citing its site", ...(inc.products ? ["Product cards", "Card share"] : [])]); r++;
    const r0 = r;
    brands.forEach((b) => {
      const m = inView("M").where("Brand", { f: `$B${r}`, v: b.name });
      s.set([r, 2], b.name, b.isOwn ? ST.bold : ST.text).set([r, 3], b.isOwn ? "You" : b.auto ? "Found in the answers" : "Competitor", ST.text);
      put(s, r, 4, fx(m.count()), ST.int); put(s, r, 5, fx(ratio(m.count(), inView("A").count())), ST.pct); put(s, r, 6, fx(ratio(m.sum("Mentions"), inView("M").sum("Mentions"))), ST.pct);
      put(s, r, 7, fx(m.avg("Position")), ST.dec); put(s, r, 8, fx(m.sum("Mentions")), ST.int); put(s, r, 9, fx(m.sum("Named first")), ST.int);
      put(s, r, 10, fx(m.sum("Cited pages naming it")), ST.int); put(s, r, 11, fx(m.sum("Its site cited")), ST.int);
      if (inc.products) {
        const cards = inView("P").where("Brand", { f: `$B${r}`, v: b.name }).count();
        put(s, r, 12, fx(cards), ST.int); put(s, r, 13, fx(ratio(cards, inView("P").count())), ST.pct);
      }
      r++;
    });
    if (brands.length) {
      ["E", "F", ...(inc.products ? ["M"] : [])].forEach((c) => s.cond(`${c}${r0}:${c}${r - 1}`, { type: "dataBar", color: "93C5FD" }));
      s.cond(`G${r0}:G${r - 1}`, { type: "colorScale", colors: ["BBF7D0", "FFFFFF", "FECACA"], values: [1, 2, 4] });
    }
    r++;
    s.set([r, 2], "Visibility on each engine", ST.section); r++;
    thRow(s, r, 2, ["Brand", ...engines]); r++;
    const h0 = r;
    brands.forEach((b) => {
      s.set([r, 2], b.name, b.isOwn ? ST.bold : ST.text);
      engines.forEach((e, j) => {
        const a = T("A").where("Run", RUN).where("Engine", lit(e));
        put(s, r, 3 + j, fx(ratio(T("M").where("Run", RUN).where("Engine", lit(e)).where("Brand", { f: `$B${r}`, v: b.name }).count(), a.count())), ST.pct);
      });
      r++;
    });
    if (brands.length && engines.length) s.cond(`C${h0}:${colName(2 + engines.length)}${r - 1}`, { type: "colorScale", colors: ["FFFFFF", "3B82F6"], values: [0, 1] });
    r++;
    if (rivals.length && inc.h2h) {
      s.set([r, 2], `${OWN} head to head with each rival`, ST.section); r++;
      const outs = ["Ahead", "Behind", "Both", "Only you", "Only them", "Neither"];
      thRow(s, r, 2, ["Rival", `${OWN} ahead`, `${OWN} behind`, "Both, no order", `Only ${OWN}`, "Only the rival", "Neither", "Win rate when both named"]); r++;
      const x0 = r;
      const cache = [];
      rivals.forEach((b) => {
        s.set([r, 2], b.name, ST.text);
        const row = outs.map((o, j) => {
          const q = inView("H").where("Competitor", { f: `$B${r}`, v: b.name }).where("Result", lit(o)).count();
          put(s, r, 3 + j, fx(q), ST.int);
          return q.v;
        });
        put(s, r, 9, { f: `IFERROR(C${r}/(C${r}+D${r}),"")`, v: row[0] + row[1] ? row[0] / (row[0] + row[1]) : "" }, ST.pct);
        cache.push(row);
        r++;
      });
      s.cond(`I${x0}:I${r - 1}`, { type: "colorScale", colors: ["FECACA", "FFFFFF", "BBF7D0"], values: [0, 0.5, 1] });
      chart(s, { type: "bar", stacked: "percent", title: "Head to head (share of answers)", from: `B${r + 1}`, cols: 8, rows: Math.max(10, rivals.length * 2 + 6), reverse: true, valFmt: "0%",
        series: outs.map((o, j) => ({ name: [`${OWN} ahead`, `${OWN} behind`, "Both, no order", `Only ${OWN}`, "Only the rival", "Neither"][j], nameRef: absRange("Brands", 3 + j, x0 - 1),
          cats: absRange("Brands", 2, x0, 2, r - 1), vals: absRange("Brands", 3 + j, x0, 3 + j, r - 1), catCache: rivals.map((b) => b.name), valCache: cache.map((row) => row[j]),
          color: ["15803D", "B91C1C", "94A3B8", "86EFAC", "FCA5A5", "E2E8F0"][j] })) });
      r += Math.max(10, rivals.length * 2 + 6) + 2;
    }
    // What the engines recommend each brand for.
    const aspectCount = new Map();
    F.M.forEach((row) => String(row[11] || "").split(",").map((x) => x.trim()).filter(Boolean).forEach((a) => aspectCount.set(a, (aspectCount.get(a) || 0) + 1)));
    const aspects = [...aspectCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a]) => a);
    if (aspects.length) {
      s.set([r, 2], "What the engines recommend each brand for", ST.section); r++;
      thRow(s, r, 2, ["Picked for", ...brands.map((b) => b.name)]); r++;
      const a0 = r;
      aspects.forEach((a) => {
        s.set([r, 2], a, ST.text);
        brands.forEach((b, j) => {
          const rows = inView("M").where("Brand", lit(b.name)).pick().filter((row) => String(row[11] || "").toLowerCase().includes(a.toLowerCase()));
          put(s, r, 3 + j, { f: `${inView("M").where("Brand", lit(b.name)).where("Picked for", { f: `"*"&$B${r}&"*"`, v: a }).count().f}`, v: rows.length }, ST.int);
        });
        r++;
      });
      s.cond(`C${a0}:${colName(2 + brands.length)}${r - 1}`, { type: "colorScale", colors: ["FFFFFF", "A78BFA"] });
    }
    s.freeze("C6");
    for (let j = 3; j <= 13; j++) s.width(j, 13);
  }

  /* ----- Prompts ----- */
  function buildPrompts() {
    const s = sh.Prompts;
    header(s, "Prompts", `How ${OWN} does on every prompt, and who does better.`);
    s.width("B", 9).width("C", 46);
    let r = 6;
    s.set([r, 2], "Scorecard", ST.section); r++;
    thRow(s, r, 2, ["ID", "Prompt", "Tags", "Answers", `${OWN} named`, "Visibility", "Average position", "Named first", "Answers citing your site", "Best rival", "Best rival's visibility"]); r++;
    const p0 = r;
    // A hidden grid of every brand's visibility per prompt feeds "best rival".
    const gridCol = 30;
    prompts.forEach((p) => {
      const a = inView("A").where("Prompt ID", { f: `$B${r}`, v: p.id });
      const m = inView("M").where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(OWN));
      s.set([r, 2], p.id, ST.text).set([r, 3], p.text, ST.wrap).set([r, 4], p.tags, ST.text);
      put(s, r, 5, fx(a.count()), ST.int); put(s, r, 6, fx(m.count()), ST.int); put(s, r, 7, fx(ratio(m.count(), a.count())), ST.pct);
      put(s, r, 8, fx(m.avg("Position")), ST.dec); put(s, r, 9, fx(m.sum("Named first")), ST.int); put(s, r, 10, fx(a.sum("Cites your site")), ST.int);
      const rv = rivals.map((b, j) => {
        const q = ratio(inView("M").where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(b.name)).count(), a.count());
        put(s, r, gridCol + j, fx(q), ST.pct);
        return q.v;
      });
      if (rivals.length) {
        const g1 = colName(gridCol), g2 = colName(gridCol + rivals.length - 1);
        const best = rv.reduce((bi, v, i) => (v > rv[bi] ? i : bi), 0);
        put(s, r, 11, { f: `IF(MAX(${g1}${r}:${g2}${r})=0,"",INDEX($${g1}$${p0 - 1}:$${g2}$${p0 - 1},MATCH(MAX(${g1}${r}:${g2}${r}),${g1}${r}:${g2}${r},0)))`, v: rv[best] > 0 ? rivals[best].name : "" }, ST.text);
        put(s, r, 12, { f: `MAX(${g1}${r}:${g2}${r})`, v: Math.max(0, ...rv) }, ST.pct);
      }
      r++;
    });
    rivals.forEach((b, j) => s.set([p0 - 1, gridCol + j], b.name, ST.thc).width(gridCol + j, 10, { hidden: true }));
    if (prompts.length) {
      s.cond(`G${p0}:G${r - 1}`, { type: "dataBar", color: "93C5FD", max: 1 });
      s.cond(`L${p0}:L${r - 1}`, { type: "expression", formula: `L${p0}>G${p0}`, style: BAD });
    }
    r++;
    s.set([r, 2], "Every brand on every prompt (visibility)", ST.section); r++;
    thRow(s, r, 2, ["ID", "Prompt", ...brands.map((b) => b.name)]); r++;
    const g0 = r;
    prompts.forEach((p) => {
      s.set([r, 2], p.id, ST.text).set([r, 3], p.text, ST.text);
      const a = inView("A").where("Prompt ID", { f: `$B${r}`, v: p.id });
      brands.forEach((b, j) => put(s, r, 4 + j, fx(ratio(inView("M").where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(b.name)).count(), a.count())), ST.pct));
      r++;
    });
    if (prompts.length && brands.length) s.cond(`D${g0}:${colName(3 + brands.length)}${r - 1}`, { type: "colorScale", colors: ["FFFFFF", "3B82F6"], values: [0, 1] });
    r++;
    s.set([r, 2], `${OWN}'s average position on each engine (1 = named first)`, ST.section); r++;
    thRow(s, r, 2, ["ID", "Prompt", ...engines]); r++;
    const q0 = r;
    prompts.forEach((p) => {
      s.set([r, 2], p.id, ST.text).set([r, 3], p.text, ST.text);
      engines.forEach((e, j) => put(s, r, 4 + j, fx(T("M").where("Run", RUN).where("Engine", lit(e)).where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(OWN)).avg("Position")), ST.dec));
      r++;
    });
    if (prompts.length && engines.length) s.cond(`D${q0}:${colName(3 + engines.length)}${r - 1}`, { type: "colorScale", colors: ["22C55E", "FEF9C3", "F87171"], values: [1, 2, 4] });
    s.freeze("D8");
    for (let j = 4; j <= 12; j++) s.width(j, 12);
    s.width("K", 18);
  }

  /* ----- Answer types ----- */
  function buildKinds() {
    const s = sh["Answer types"];
    header(s, "Answer types", "Shopping, informational, image-led, from memory and local answers each have their own way in.");
    let r = 6;
    thRow(s, r, 2, ["Kind of answer", "Answers", "Share of answers", `${OWN} named`, "Visibility", "Average position", "Cites your site", "Product cards", "Your cards", "Images", "Your images", "The lever that matters"]); r++;
    const k0 = r;
    const cache = [];
    KINDS.forEach((k) => {
      const a = inView("A").where("Kind of answer", { f: `$B${r}`, v: k });
      const m = inView("M").where("Kind of answer", { f: `$B${r}`, v: k }).where("Brand", lit(OWN));
      s.set([r, 2], k, ST.text);
      put(s, r, 3, fx(a.count()), ST.int); put(s, r, 4, fx(ratio(a.count(), inView("A").count())), ST.pct);
      put(s, r, 5, fx(a.sum("You named")), ST.int); const vis = ratio(a.sum("You named"), a.count()); put(s, r, 6, fx(vis), ST.pct);
      put(s, r, 7, fx(m.avg("Position")), ST.dec); const cites = ratio(a.sum("Cites your site"), a.count()); put(s, r, 8, fx(cites), ST.pct);
      put(s, r, 9, fx(a.sum("Product cards")), ST.int); put(s, r, 10, fx(a.sum("Your cards")), ST.int); put(s, r, 11, fx(a.sum("Images")), ST.int); put(s, r, 12, fx(a.sum("Your images")), ST.int);
      s.set([r, 13], LEVERS[k], ST.wrap).height(r, 30);
      cache.push({ k, vis: vis.v, cites: cites.v });
      r++;
    });
    s.set([r, 2], "All answers", ST.total);
    put(s, r, 3, { f: `SUM(C${k0}:C${r - 1})`, v: inView("A").count().v }, ST.totalInt);
    put(s, r, 4, { f: `SUM(D${k0}:D${r - 1})`, v: inView("A").count().v ? 1 : 0 }, ST.totalPct);
    put(s, r, 5, { f: `SUM(E${k0}:E${r - 1})`, v: inView("A").sum("You named").v }, ST.totalInt);
    put(s, r, 6, fx(ratio(inView("A").sum("You named"), inView("A").count())), ST.totalPct);
    put(s, r, 8, fx(ratio(inView("A").sum("Cites your site"), inView("A").count())), ST.totalPct);
    [9, 10, 11, 12].forEach((c) => put(s, r, c, { f: `SUM(${colName(c)}${k0}:${colName(c)}${r - 1})`, v: inView("A").sum(["Product cards", "Your cards", "Images", "Your images"][c - 9]).v }, ST.totalInt));
    s.width("M", 52);
    for (let j = 3; j <= 12; j++) s.width(j, 12);
    chart(s, { type: "col", title: `${OWN} named, and your site cited, by kind of answer`, from: `B${r + 3}`, cols: 9, rows: 15, valFmt: "0%", min: 0, max: 1,
      series: [
        { name: `${OWN} named`, cats: absRange("Answer types", 2, k0, 2, k0 + KINDS.length - 1), vals: absRange("Answer types", 6, k0, 6, k0 + KINDS.length - 1), catCache: KINDS, valCache: cache.map((x) => x.vis), color: OWN_COLOR },
        { name: "Your site cited", cats: absRange("Answer types", 2, k0, 2, k0 + KINDS.length - 1), vals: absRange("Answer types", 8, k0, 8, k0 + KINDS.length - 1), catCache: KINDS, valCache: cache.map((x) => x.cites), color: "1BAF7A" }] });
    s.freeze("C7");
  }

  /* ----- Sources ----- */
  function buildSources() {
    const s = sh.Sources;
    header(s, "Sources", "Which sites and pages the engines read and cite.");
    let r = 6;
    s.set([r, 2], "Kinds of site", ST.section); r++;
    thRow(s, r, 2, ["Kind of site", "Pages read", "Pages cited", "Cited rate", `Cited pages naming ${OWN}`]); r++;
    const k0 = r;
    const cache = [];
    SITE_KINDS.forEach((k) => {
      const q = inView("S").where("Kind of site", { f: `$B${r}`, v: k });
      const cited = q.where("Cited", lit(1)).count();
      s.set([r, 2], k, ST.text); put(s, r, 3, fx(q.count()), ST.int); put(s, r, 4, fx(cited), ST.int); put(s, r, 5, fx(ratio(cited, q.count())), ST.pct);
      put(s, r, 6, fx(q.where("Cited", lit(1)).where("Names you", lit(1)).count()), ST.int);
      cache.push(cited.v);
      r++;
    });
    chart(s, { type: "pie", title: "Citations by kind of site", from: `I${k0 - 2}`, cols: 7, rows: 14,
      series: [{ name: "Pages cited", cats: absRange("Sources", 2, k0, 2, r - 1), vals: absRange("Sources", 4, k0, 4, r - 1), catCache: SITE_KINDS, valCache: cache }],
      colors: ["2A78D6", "EB6834", "1BAF7A", "EDA100", "4A3AA7", "94A3B8"] });
    r = Math.max(r + 1, k0 + 14);
    s.set([r, 2], "Every site", ST.section); r++;
    thRow(s, r, 2, ["Site", "Kind of site", "Pages read", "Pages cited", "Cited rate", `Cited pages naming ${OWN}`, "Cited pages naming a rival", "Cites rivals, never you"]); r++;
    const counts = new Map();
    F.S.forEach((row) => counts.set(row[4], (counts.get(row[4]) || 0) + 1 + row[9] * 1000));
    const sites = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).map(([d]) => d);
    const s0 = r;
    sites.forEach((d) => {
      const q = inView("S").where("Domain", { f: `$B${r}`, v: d });
      const kind = (F.S.find((row) => row[4] === d) || [])[7] || "";
      const cited = q.where("Cited", lit(1));
      const mine = cited.where("Names you", lit(1)).count(), riv = cited.where("Names a rival", lit(1)).count();
      s.set([r, 2], d, ST.text).set([r, 3], kind, ST.text);
      put(s, r, 4, fx(q.count()), ST.int); put(s, r, 5, fx(cited.count()), ST.int); put(s, r, 6, fx(ratio(cited.count(), q.count())), ST.pct);
      put(s, r, 7, fx(mine), ST.int); put(s, r, 8, fx(riv), ST.int);
      put(s, r, 9, { f: `IF(AND(H${r}>0,G${r}=0),"Yes","")`, v: riv.v > 0 && mine.v === 0 ? "Yes" : "" }, { ...ST.text, align: { h: "center" } });
      r++;
    });
    if (sites.length) {
      s.cond(`E${s0}:E${r - 1}`, { type: "dataBar", color: "86EFAC" });
      s.cond(`I${s0}:I${r - 1}`, { type: "cellIs", op: "equal", formula: '"Yes"', style: BAD });
    }
    r++;
    s.set([r, 2], "The most-cited pages", ST.section); r++;
    thRow(s, r, 2, ["Page", "Site", "Times cited"]); r++;
    const pageCount = new Map();
    F.S.forEach((row) => { if (row[9] && row[5]) pageCount.set(row[5], { n: ((pageCount.get(row[5]) || {}).n || 0) + 1, title: row[6], d: row[4] }); });
    [...pageCount.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25).forEach(([url, x]) => {
      s.set([r, 2], x.title || url, { ...ST.link, border: { bottom: thin } }).link(cellRef(r, 2), { url }).set([r, 3], x.d, ST.text);
      // A URL longer than COUNTIFS's 255-character criteria limit is counted as written.
      put(s, r, 4, url.length < 250 ? fx(inView("S").where("URL", lit(url)).where("Cited", lit(1)).count()) : inView("S").where("URL", lit(url)).where("Cited", lit(1)).count().v, ST.int);
      r++;
    });
    s.width("B", 44).width("C", 20);
    for (let j = 4; j <= 9; j++) s.width(j, 13);
    s.freeze("C6");
  }

  /* ----- Products ----- */
  function buildProducts() {
    const s = sh.Products;
    header(s, "Products", "Product cards, the stores they list, and the images in answers.");
    let r = 6;
    if (inc.products) {
    s.set([r, 2], "Card share by brand", ST.section); r++;
    thRow(s, r, 2, ["Brand", "Cards", "Card share", "Average card position", "First cards"]); r++;
    const c0 = r;
    const cache = [];
    brands.forEach((b) => {
      const p = inView("P").where("Brand", { f: `$B${r}`, v: b.name });
      const share = ratio(p.count(), inView("P").count());
      s.set([r, 2], b.name, b.isOwn ? ST.bold : ST.text);
      put(s, r, 3, fx(p.count()), ST.int); put(s, r, 4, fx(share), ST.pct); put(s, r, 5, fx(p.avg("Card position")), ST.dec);
      put(s, r, 6, fx(p.where("Card position", lit(1)).count()), ST.int);
      cache.push(share.v);
      r++;
    });
    if (brands.length) chart(s, { type: "bar", title: "Card share by brand", from: `I${c0 - 2}`, cols: 7, rows: Math.max(10, brands.length + 5), valFmt: "0%", reverse: true, legend: false,
      series: [{ name: "Card share", cats: absRange("Products", 2, c0, 2, r - 1), vals: absRange("Products", 4, c0, 4, r - 1), catCache: brands.map((b) => b.name), valCache: cache, pointColors: brands.map((b) => brandColor.get(b.name)) }] });
    r = Math.max(r + 1, c0 + Math.max(10, brands.length + 5));
    s.set([r, 2], `Stores listed on ${OWN}'s cards`, ST.section); r++;
    thRow(s, r, 2, ["Store", "Times listed", "Your own store"]); r++;
    const storeCount = new Map();
    F.O.filter((o) => o[4] === OWN).forEach((o) => storeCount.set(o[6], (storeCount.get(o[6]) || 0) + 1));
    const st0 = r;
    const stores = [...storeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    stores.forEach(([m]) => {
      s.set([r, 2], m, ST.text);
      put(s, r, 3, fx(inView("O").where("Brand", lit(OWN)).where("Store", { f: `$B${r}`, v: m }).count()), ST.int);
      s.set([r, 4], (F.O.find((o) => o[6] === m) || [])[7] ? "Yes" : "", { ...ST.text, align: { h: "center" } });
      r++;
    });
    if (!stores.length) { s.set([r, 2], `No product card for ${OWN} listed a store.`, ST.note); r++; }
    r++;
    s.set([r, 2], "Every product shown", ST.section); r++;
    thRow(s, r, 2, ["Product", "Brand", "Times shown", "Average card position", "Price as shown", "Rating"]); r++;
    const prod = new Map();
    F.P.forEach((p) => { if (!prod.has(p[5])) prod.set(p[5], p); });
    [...prod.keys()].slice(0, 200).forEach((name) => {
      const p = prod.get(name);
      s.set([r, 2], name, ST.text).set([r, 3], p[6], ST.text);
      const q = inView("P").where("Product", { f: `$B${r}`, v: name });
      if (name.length < 250) { put(s, r, 4, fx(q.count()), ST.int); put(s, r, 5, fx(q.avg("Card position")), ST.dec); }
      s.set([r, 6], p[9], ST.text).set([r, 7], p[10] === null ? "" : p[10], ST.dec);
      r++;
    });
    r++;
    }
    if (inc.images) {
    s.set([r, 2], "Images in answers", ST.section); r++;
    thRow(s, r, 2, ["Image from", "Images", "Served by the engine", `Show ${OWN}`]); r++;
    const imgFrom = [...new Set(F.I.map((x) => x[5]))].slice(0, 20);
    imgFrom.forEach((d) => {
      const q = inView("I").where("Image from", { f: `$B${r}`, v: d });
      s.set([r, 2], d, ST.text); put(s, r, 3, fx(q.count()), ST.int); put(s, r, 4, fx(q.sum("Served by the engine")), ST.int); put(s, r, 5, fx(q.sum("Yours")), ST.int);
      r++;
    });
    if (!imgFrom.length) s.set([r, 2], "No answer in this campaign showed images.", ST.note);
    }
    s.width("B", 40).width("C", 16);
    for (let j = 4; j <= 7; j++) s.width(j, 14);
  }

  /* ----- Searches ----- */
  function buildSearches() {
    const s = sh.Searches;
    header(s, "Searches", "The searches the engines ran behind the answers: how many, of what kind, in what words.");
    let r = 6;
    s.set([r, 2], "Searches by engine", ST.section); r++;
    thRow(s, r, 2, ["Engine", "Answers", "Searches", "Web", "Shopping", "Image", "Per answer"]); r++;
    const e0 = r;
    const cache = [];
    engines.forEach((e) => {
      const a = T("A").where("Run", RUN).where("Engine", { f: `$B${r}`, v: e });
      s.set([r, 2], e, ST.text);
      put(s, r, 3, fx(a.count()), ST.int); put(s, r, 4, fx(a.sum("Searches")), ST.int);
      const w = a.sum("Web searches"), sp = a.sum("Shopping searches"), im = a.sum("Image searches");
      put(s, r, 5, fx(w), ST.int); put(s, r, 6, fx(sp), ST.int); put(s, r, 7, fx(im), ST.int);
      put(s, r, 8, { f: `IFERROR(D${r}/C${r},0)`, v: a.count().v ? a.sum("Searches").v / a.count().v : 0 }, ST.dec);
      cache.push([w.v, sp.v, im.v]);
      r++;
    });
    if (engines.length) chart(s, { type: "col", stacked: "stacked", title: "Searches by engine and kind", from: `J${e0 - 2}`, cols: 7, rows: 13, majorUnit: countUnit(cache.map((x) => x[0] + x[1] + x[2])),
      series: ["Web", "Shopping", "Image"].map((k, j) => ({ name: k, nameRef: absRange("Searches", 5 + j, e0 - 1), cats: absRange("Searches", 2, e0, 2, r - 1), vals: absRange("Searches", 5 + j, e0, 5 + j, r - 1), catCache: engines, valCache: cache.map((x) => x[j]), color: ["2A78D6", "EB6834", "4A3AA7"][j] })) });
    r = Math.max(r + 1, e0 + 12);
    s.set([r, 2], "How the searches are worded", ST.section); r++;
    thRow(s, r, 2, ["Search…", "Searches", "Share"]); r++;
    const all = inView("Q").count();
    [["names a brand", "Names a brand"], [`names ${OWN}`, "Names you"], ["has a year", "Has a year"], ["asks Reddit", "Asks Reddit"]].forEach(([label, col]) => {
      const q = inView("Q").where(col, lit(1)).count();
      s.set([r, 2], label, ST.text); put(s, r, 3, fx(q), ST.int); put(s, r, 4, fx(ratio(q, all)), ST.pct);
      r++;
    });
    r++;
    s.set([r, 2], "Every distinct search", ST.section); r++;
    thRow(s, r, 2, ["Search text", "Kind", "Times run", "Engines", "Prompts"]); r++;
    const seen = new Map();
    F.Q.forEach((q) => {
      const k = q[5].toLowerCase();
      const x = seen.get(k) || { text: q[5], kind: q[4], engines: new Set(), prompts: new Set() };
      x.engines.add(q[3]); x.prompts.add(q[2]); seen.set(k, x);
    });
    [...seen.values()].slice(0, 400).forEach((x) => {
      s.set([r, 2], x.text, ST.text).set([r, 3], x.kind, ST.text);
      put(s, r, 4, x.text.length < 250 ? fx(inView("Q").where("Search text", { f: `$B${r}`, v: x.text }).count()) : inView("Q").where("Search text", lit(x.text)).count().v, ST.int);
      s.set([r, 5], [...x.engines].join(", "), ST.text).set([r, 6], [...x.prompts].join(", "), ST.text);
      r++;
    });
    s.width("B", 56).width("E", 22).width("F", 16);
    for (let j = 3; j <= 8; j++) if (j !== 5 && j !== 6) s.width(j, 12);
  }

  /* ----- Run over run ----- */
  function buildRunOverRun() {
    const s = sh["Run over run"];
    header(s, "Run over run", `${OWN}'s position on every prompt and engine, run by run (1 = named first; blank = not named).`, false);
    let r = 5;
    const lastC = 3 + runs.length;
    thRow(s, r, 2, ["Prompt", "Engine", ...runs.map((x) => x.label), "Latest change"]); r++;
    const r0 = r;
    const changes = [];
    prompts.forEach((p) => engines.forEach((e) => {
      s.set([r, 2], p.id, ST.text).set([r, 3], e, ST.text);
      const vals = runs.map((x, j) => {
        const q = T("M").where("Run", lit(x.label)).where("Engine", { f: `$C${r}`, v: e }).where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(OWN)).avg("Position");
        put(s, r, 4 + j, fx(q), ST.dec);
        return q.v;
      });
      if (runs.length > 1) {
        const c = colName(3 + runs.length), b = colName(2 + runs.length);
        const cur = vals[vals.length - 1], prev = vals[vals.length - 2];
        const v = cur === "" && prev === "" ? "Not named" : prev === "" ? "New" : cur === "" ? "Dropped" : cur < prev ? "Moved up" : cur > prev ? "Moved down" : "Same";
        put(s, r, lastC + 1, { f: `IF(AND(${b}${r}="",${c}${r}=""),"Not named",IF(${b}${r}="","New",IF(${c}${r}="","Dropped",IF(${c}${r}<${b}${r},"Moved up",IF(${c}${r}>${b}${r},"Moved down","Same")))))`, v }, { ...ST.text, align: { h: "center" } });
        changes.push(v);
      }
      r++;
    }));
    if (r > r0 && runs.length) {
      s.cond(`D${r0}:${colName(lastC)}${r - 1}`, { type: "colorScale", colors: ["22C55E", "FEF9C3", "F87171"], values: [1, 2, 4] });
      if (runs.length > 1) {
        const cc = colName(lastC + 1);
        s.cond(`${cc}${r0}:${cc}${r - 1}`, { type: "cellIs", op: "equal", formula: '"Moved up"', style: GOOD });
        s.cond(`${cc}${r0}:${cc}${r - 1}`, { type: "cellIs", op: "equal", formula: '"New"', style: GOOD });
        s.cond(`${cc}${r0}:${cc}${r - 1}`, { type: "cellIs", op: "equal", formula: '"Moved down"', style: BAD });
        s.cond(`${cc}${r0}:${cc}${r - 1}`, { type: "cellIs", op: "equal", formula: '"Dropped"', style: BAD });
        r++;
        s.set([r, 2], "In the latest run", ST.section); r++;
        ["Moved up", "Moved down", "Same", "New", "Dropped", "Not named"].forEach((k) => {
          s.set([r, 2], k, ST.text);
          put(s, r, 3, { f: `COUNTIF(${cc}${r0}:${cc}${r0 + changes.length - 1},"${k}")`, v: changes.filter((x) => x === k).length }, ST.int);
          r++;
        });
      }
    }
    s.width("B", 12).width("C", 12);
    for (let j = 4; j <= lastC + 1; j++) s.width(j, 12);
    s.freeze("D6");
  }

  /* ----- Actions ----- */
  function buildActions() {
    const s = sh.Actions;
    header(s, "Actions", "Where to act next. Every number is a live formula over the raw tables.");
    let r = 6;
    s.set([r, 2], `Prompts where ${OWN} is missing`, ST.section); r++;
    thRow(s, r, 2, ["ID", "Prompt", "Answers", `${OWN} named`, "Named first most often instead"]); r++;
    const fc = 30;
    rivals.forEach((b, j) => s.set([r - 1, fc + j], b.name, ST.thc).width(fc + j, 10, { hidden: true }));
    const p0 = r;
    prompts.forEach((p) => {
      const a = inView("A").where("Prompt ID", { f: `$B${r}`, v: p.id });
      const mine = inView("M").where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(OWN)).count();
      s.set([r, 2], p.id, ST.text).set([r, 3], p.text, ST.wrap);
      put(s, r, 4, fx(a.count()), ST.int); put(s, r, 5, fx(mine), ST.int);
      const firsts = rivals.map((b, j) => {
        const q = inView("M").where("Prompt ID", { f: `$B${r}`, v: p.id }).where("Brand", lit(b.name)).sum("Named first");
        put(s, r, fc + j, fx(q), ST.int);
        return q.v;
      });
      if (rivals.length) {
        const g1 = colName(fc), g2 = colName(fc + rivals.length - 1);
        const best = firsts.reduce((bi, v, i) => (v > firsts[bi] ? i : bi), 0);
        put(s, r, 6, { f: `IF(MAX(${g1}${r}:${g2}${r})=0,"",INDEX($${g1}$${p0 - 1}:$${g2}$${p0 - 1},MATCH(MAX(${g1}${r}:${g2}${r}),${g1}${r}:${g2}${r},0)))`, v: firsts[best] > 0 ? rivals[best].name : "" }, ST.text);
      }
      r++;
    });
    if (prompts.length) s.cond(`B${p0}:F${r - 1}`, { type: "expression", formula: `AND($D${p0}>0,$E${p0}=0)`, style: { fill: "FEE2E2" } });
    r++;
    if (inc.pages) {
    s.set([r, 2], `Sites that cite rivals but never ${OWN}`, ST.section); r++;
    thRow(s, r, 2, ["Site", "Kind of site", "Cited pages naming a rival", `Cited pages naming ${OWN}`]); r++;
    const gapSites = [...new Set(F.S.filter((x) => x[9] && x[11] && x[7] !== "Your site").map((x) => x[4]))]
      .filter((d) => !F.S.some((x) => x[4] === d && x[9] && x[10])).slice(0, 40);
    gapSites.forEach((d) => {
      const c = inView("S").where("Domain", { f: `$B${r}`, v: d }).where("Cited", lit(1));
      s.set([r, 2], d, ST.text).set([r, 3], (F.S.find((x) => x[4] === d) || [])[7] || "", ST.text);
      put(s, r, 4, fx(c.where("Names a rival", lit(1)).count()), ST.int); put(s, r, 5, fx(c.where("Names you", lit(1)).count()), ST.int);
      r++;
    });
    if (!gapSites.length) { s.set([r, 2], `Every cited page that names a rival also names ${OWN}.`, ST.note); r++; }
    r++;
    }
    if (inc.products) {
    s.set([r, 2], `${OWN} product cards that list no ${OWN} store`, ST.section); r++;
    thRow(s, r, 2, ["Product", "Times shown", "With your store listed"]); r++;
    const ownProducts = [...new Set(F.P.filter((p) => p[7]).map((p) => p[5]))].slice(0, 40);
    ownProducts.forEach((name) => {
      const q = inView("P").where("Product", { f: `$B${r}`, v: name });
      s.set([r, 2], name, ST.text);
      if (name.length < 250) { put(s, r, 3, fx(q.count()), ST.int); put(s, r, 4, fx(q.sum("Your store listed")), ST.int); }
      r++;
    });
    if (!ownProducts.length) s.set([r, 2], `No product card for ${OWN} in this campaign.`, ST.note);
    }
    s.width("B", 30).width("C", 46).width("D", 14).width("E", 14).width("F", 26);
  }
}

/* ---------- CSV tables ---------- */

export const CSV_FILES = { A: "answers.csv", M: "mentions.csv", S: "pages.csv", Q: "searches.csv", P: "products.csv", O: "stores.csv", I: "images.csv", H: "head_to_head.csv" };

// Page titles, searches and answers come from the web. A spreadsheet that
// opens a CSV runs any cell starting with = + - or @ as a formula, so text
// that starts that way gets a leading apostrophe. Numbers are written as is.
export function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The same raw tables as CSV files: UTF-8 with a header row, flags as 1 and
 * 0, dates in ISO format. Answer ID joins every file to answers.csv.
 */
export function campaignCsvFiles(bundle = {}) {
  const F = campaignFacts(bundle);
  const inc = { pages: true, searches: true, products: true, images: true, h2h: true, ...(bundle.include || {}) };
  const on = { A: true, M: true, S: inc.pages, Q: inc.searches, P: inc.products, O: inc.products, I: inc.images, H: inc.h2h };
  const files = RAW.filter((d) => on[d.key]).map((d) => ({
    name: CSV_FILES[d.key],
    text: [d.cols, ...F[d.key]].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n",
  }));
  files.push({ name: "README.txt", text: [
    `${(F.profile && F.profile.name) || "Campaign"}: raw tables exported by CitoSkeleton.`,
    "",
    ...RAW.filter((d) => on[d.key]).map((d) => `${CSV_FILES[d.key]}: ${d.what}. ${F[d.key].length} rows.`),
    "",
    "UTF-8 with a header row. Flags are 1 (yes) and 0 (no). Dates are ISO 8601 (UTC).",
    "Text that starts with = + - or @ has a leading ' so a spreadsheet shows it rather than running it.",
    "Answer ID joins every file to answers.csv.",
  ].join("\r\n") + "\r\n" });
  return files;
}

/** Row counts for the export dialog's "What you get", without building anything. */
export function campaignExportCounts(bundle = {}) {
  const F = campaignFacts(bundle);
  const cols = Object.fromEntries(RAW.map((d) => [d.key, d.cols.length]));
  return {
    answers: F.A.length, mentions: F.M.length, pages: F.S.length, searches: F.Q.length, products: F.P.length, stores: F.O.length, images: F.I.length, h2h: F.H.length,
    runs: F.runs.length, engines: F.engines,
    cols: { answers: cols.A, mentions: cols.M, pages: cols.S, searches: cols.Q, products: cols.P, stores: cols.O, images: cols.I, h2h: cols.H },
  };
}
