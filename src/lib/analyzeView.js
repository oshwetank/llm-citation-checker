/*
 * analyzeView.js — everything the popup's Analyze view says about one
 * captured answer, worked out as plain data so it can be tested without a
 * browser. panel.js turns it into elements; nothing here touches the DOM.
 *
 * The layout this feeds was designed and approved on the design canvas
 * (0.47.0), after three rounds of owner feedback on the popup:
 *   - "just below the prompt the query fan-out which happened": the searches
 *     come first, each one in full. The old popup squeezed them into a third
 *     of a box and cut them off with an ellipsis.
 *   - "the information it provides is less": every brand (not the top four),
 *     what backs each one, every cited page and the brands it mentions, your
 *     own brand as four numbers, and what changed since the last time the
 *     same prompt was asked of the same engine.
 *
 * Every figure here comes from the capture itself. Where the capture can't
 * say (Gemini doesn't publish its searches; a product card names stores but
 * not their prices) the view says so instead of filling the gap.
 */
import { wordRe } from "./textMatch.js";
import { analyzeFanout, parseQueryOperators } from "./fanout.js";
import { computeBrandMatrix, sameBrand } from "./funnel-omitted.js";
import { normalizeMentions } from "./mention-list.js";
import { siteKindOf, isBrandSite, normDomain, KIND_GROUPS } from "./siteKind.js";
import { extractBrandAspects } from "./aspects.js";

const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function normPrompt(p) {
  return String(p || "").toLowerCase().replace(/\s+/g, " ").replace(/[.?!,]+$/, "").trim();
}

/**
 * Vendor names the capture knows for certain: ChatGPT's "Product Vendor"
 * entities and the first word of each product card ("Realme P4 5G" ->
 * "Realme"). normalizeMentions folds model names onto these, so a capture that
 * named "Realme P4" and "Realme" counts one brand. Moved here from panel.js in
 * 0.48.0 so the compare view can use the same rule.
 */
export function knownVendors(rec) {
  const out = [];
  for (const e of rec.entities || []) {
    if (e && e.text && /vendor|manufacturer|brand/i.test(e.category || "")) out.push(e.text);
  }
  for (const p of rec.products || []) {
    // Only the first word, and only when it looks like a name rather than a
    // spec, so a product called "5G Router" can't invent a vendor called "5G".
    const first = String(p.name || "").trim().split(/\s+/)[0];
    if (first && first.length > 1 && /^[A-Za-z][A-Za-z.&'-]*$/.test(first)) out.push(first);
  }
  return [...new Set(out)];
}

/** What led the answer, from what the capture actually holds. */
export function answerKind(rec) {
  if (!rec.searched && !(rec.sources || []).length) return { id: "memory", label: "From memory" };
  if ((rec.places || []).length) return { id: "local", label: "Local" };
  if ((rec.products || []).length) return { id: "shopping", label: "Shopping" };
  if ((rec.images || []).length >= 3) return { id: "images", label: "Images" };
  return { id: "info", label: "Informational" };
}

/* ---------- searches it ran ---------- */

// classifyQuery's labels, in the words the owner uses.
const TAG_WORDS = {
  comparison: "comparison", commercial: "buying", pricing: "pricing", review: "review", specs: "specs",
  howto: "how-to", definition: "explainer", availability: "where to buy", official: "official site",
};
const LANES = [
  ["search", "web", "Web search"],
  ["shopping", "shopping", "Shopping search"],
  ["image", "image", "Image search"],
];

function scopedSearches(rows) {
  const include = new Map(), exclude = new Map();
  let n = 0;
  for (const r of rows) {
    const ops = parseQueryOperators(r.text);
    if (ops.siteIncludes.length || ops.siteExcludes.length) n++;
    ops.siteIncludes.forEach((d) => include.set(d, (include.get(d) || 0) + 1));
    ops.siteExcludes.forEach((d) => exclude.set(d, (exclude.get(d) || 0) + 1));
  }
  const list = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count }));
  return { count: n, sites: list(include), excluded: list(exclude) };
}

export function searchesView(rec, brandNames = []) {
  const rows = [];
  for (const [key, lane, laneLabel] of LANES) {
    for (const q of (rec.fanout && rec.fanout[key]) || []) {
      const text = typeof q === "string" ? q : q && q.query;
      if (typeof text !== "string" || !text.trim()) continue;
      // A search run through one of the engine's own tools (Gemini's Google
      // Hotels card) says which, and the dates and guests it searched for.
      const via = (q && typeof q.tool === "string" && q.tool) || "";
      const dates = q && q.checkIn ? [q.checkIn, q.checkOut].filter(Boolean).join(" – ") : "";
      const detail = via ? [via, dates, (q && q.guests) || ""].filter(Boolean).join(" · ") : "";
      rows.push({ lane, laneLabel, text: text.trim(), tag: "", via, detail });
    }
  }
  const fa = analyzeFanout(rows.map((r) => r.text), rec.sources || []);
  rows.forEach((r, i) => {
    const labels = (fa.perQuery[i] && fa.perQuery[i].intents) || [];
    r.tag = r.via || (r.lane === "shopping" ? "products" : r.lane === "image" ? "images" : (TAG_WORDS[labels[0]] || ""));
  });
  const firstWords = brandNames.map((b) => String(b).toLowerCase().split(/\s+/)[0]).filter((w) => w.length >= 3);
  const namingBrand = rows.filter((r) => {
    const t = r.text.toLowerCase();
    return firstWords.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
  }).length;
  const band = fa.benchmark.band; // none | narrow | typical | broad
  return {
    rows,
    count: rows.length,
    breadth: rows.length ? { band, short: { narrow: "Narrow search", typical: "Typical search", broad: "Wide search" }[band] || "", label: fa.benchmark.label } : null,
    avgWords: fa.avgWords,
    namingBrand,
    // Gemini searches without publishing what it searched for: say so rather
    // than show an empty list that reads as "no searches".
    unpublished: !rows.length && !!rec.searched,
    // Searches limited to (or excluding) a site with site:, counted even when
    // there are none, so "none" is a stated fact (asked, 0.62.1: "why are we
    // not showing site: searches data").
    scoped: scopedSearches(rows),
    // Addresses the engine opened directly rather than found by a search
    // (Perplexity's fetch_url step).
    opened: ((rec.fanout && rec.fanout.opened) || []).map((o) => (typeof o === "string" ? o : o && o.url)).filter(Boolean),
  };
}

/* ---------- brands, and what backs each one ---------- */

function cleanBrands(rec, knownBrands) {
  return normalizeMentions(rec.brandMentions || [], knownBrands || []);
}

function namedOrder(list) {
  return list.filter((b) => b.count > 0).map((b) => b.brand);
}

/**
 * Brands named (or only shown in a card), in the order the answer names
 * them, each with what backs it among the pages the engine CITED.
 *
 * "Backed by independent pages" is the strongest position: a third-party page
 * the engine chose to cite mentions the brand. "Own site only" means the only
 * cited page about it is the brand's own. Brands with nothing behind them
 * came from the model's memory — and are the ones most likely to drop out
 * next time.
 */
export function brandsView(rec, { own, knownBrands, previous } = {}) {
  const list = cleanBrands(rec, knownBrands);
  const sources = rec.sources || [];
  const matrix = computeBrandMatrix(rec);
  const matrixFor = (name) => (matrix.brands || []).find((m) => sameBrand(m.brand, name));
  const named = namedOrder(list);
  const change = previous ? brandChanges(rec, previous, knownBrands) : null;
  const positions = resultPositions(rec);
  // Cited pages, once each, and how many of them were read (0.62.0's "Read
  // the cited pages"): what "no cited page names it" can rest on.
  const citedPages = (() => {
    const seen = new Map();
    for (const s of sources) {
      if (s.outcome !== "cited" || !s.url) continue;
      const k = s.url.replace(/#.*$/, "");
      const ok = !!(s.platformSpecific && s.platformSpecific.page && s.platformSpecific.page.status === "ok");
      seen.set(k, seen.get(k) || ok);
    }
    return { total: seen.size, read: [...seen.values()].filter(Boolean).length };
  })();

  const rows = list.map((b) => {
    const m = matrixFor(b.brand);
    const idxs = m ? m.supportedSourceIdxs : [];
    const isOwnBrand = !!own && sameBrand(own.name, b.brand);
    const brandUrl = isOwnBrand ? own.url : "";
    const cited = idxs.filter((i) => sources[i] && sources[i].outcome === "cited");
    const readOnly = idxs.filter((i) => sources[i] && sources[i].outcome !== "cited");
    const backers = dedupeByDomain(cited.map((i) => ({
      domain: normDomain(sources[i].domain || sources[i].url),
      own: isBrandSite(sources[i].domain || sources[i].url, b.brand, brandUrl),
    })));
    // Each page in full, for "where it came from" (0.60.0): the page, where
    // it came in the engine's results when the capture holds that, and the
    // date the engine sent with it.
    const page = (i) => {
      const s = sources[i];
      return {
        domain: normDomain(s.domain || s.url), url: s.url || "", title: s.title || "",
        own: isBrandSite(s.domain || s.url, b.brand, brandUrl),
        pos: (s.url && positions.get(s.url)) || null, date: pubDateOf(s),
      };
    };
    const independent = backers.filter((x) => !x.own).length;
    const ownSite = backers.length - independent;
    let verdict, label, tone;
    if (!rec.searched && !sources.length) { verdict = "memory"; label = "From memory"; tone = "warn"; }
    else if (independent) { verdict = "independent"; label = `${independent} independent${ownSite ? " + own" : ""}`; tone = "good"; }
    else if (ownSite) { verdict = "own"; label = "Own site only"; tone = "warn"; }
    else if (readOnly.length) { verdict = "read"; label = "Read, not cited"; tone = "warn"; }
    // Nothing found. Said only as far as it was checked (0.62.1, reported:
    // "we can't for sure say that other brands … came from the llms
    // memory"): a cited page whose text wasn't read may still name it.
    else if (!citedPages.total) { verdict = "nocited"; label = "Nothing cited"; tone = "neutral"; }
    else if (citedPages.read >= citedPages.total) { verdict = "none"; label = "No cited page names it"; tone = "bad"; }
    else { verdict = "unchecked"; label = "Not in what the engine sent"; tone = "neutral"; }
    const pos = b.count > 0 ? named.indexOf(b.brand) + 1 : 0;
    return {
      name: b.brand,
      position: pos,
      count: b.count || 0,
      shownOnly: !(b.count > 0),
      isYou: isOwnBrand,
      relation: b.relation || null,
      stance: b.stance || null,
      backing: {
        verdict, label, tone, independent, ownSite, readOnly: readOnly.length, backers,
        citedTotal: citedPages.total, citedRead: citedPages.read,
        pages: dedupeByUrl(cited.map(page)), readPages: dedupeByUrl(readOnly.map(page)),
      },
      // What the answer said about it, in a few words ("Battery", "Best for
      // gaming"), from the sentences that name it.
      took: b.count > 0 ? extractBrandAspects(b.passages || []) : [],
      change: change ? change.byBrand.get(b.brand.toLowerCase()) || null : null,
    };
  });
  return { rows, dropped: change ? change.dropped : [], hasPrevious: !!previous };
}

function dedupeByDomain(list) {
  const seen = new Map();
  for (const x of list) if (x.domain && !seen.has(x.domain)) seen.set(x.domain, x);
  return [...seen.values()];
}

function dedupeByUrl(list) {
  const seen = new Map();
  for (const x of list) {
    const k = x.url || `${x.domain}|${x.title}`;
    if (!seen.has(k)) seen.set(k, x);
  }
  return [...seen.values()];
}

// A page's publication date, as the engine sent it with the result.
// ChatGPT's pub_date is Unix time in seconds; a value already in
// milliseconds is kept as it is. Returns ms, or null.
function pubDateOf(s) {
  const v = s && s.platformSpecific && s.platformSpecific.pubDate;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? Math.round(v * 1000) : v;
}

/* ---------- which sources name which brands ---------- */

/**
 * A grid of sites against the brands the answer named first, for "which
 * sources feed which brands" (0.60.0). A cell is "cited" when a cited page on
 * that site names the brand in its title or snippet, "read" when only pages
 * the engine read without citing do, and "" when none does. Sites that name
 * none of the brands are left out; the rest are ordered by cited cells.
 */
export function sourceBrandMatrix(rec, { own, knownBrands, maxBrands = 6, maxSites = 12 } = {}) {
  const sources = rec.sources || [];
  const named = namedOrder(cleanBrands(rec, knownBrands)).slice(0, maxBrands);
  if (!named.length || !sources.length) return null;
  const matrix = computeBrandMatrix(rec).sources || [];
  const present = new Map(matrix.map((s) => [s.sourceIdx, s.presentBrands]));
  const basis = new Map(matrix.map((s) => [s.sourceIdx, s.basis]));
  const byDomain = new Map();
  sources.forEach((s, i) => {
    const domain = normDomain(s.domain || s.url);
    if (!domain) return;
    let row = byDomain.get(domain);
    if (!row) { row = { domain, cited: false, cells: named.map(() => ""), pagesRead: new Set(), pages: new Set() }; byDomain.set(domain, row); }
    const cited = s.outcome === "cited";
    if (cited) row.cited = true;
    // Whether this site's cells come from its pages' text or only from the
    // titles and snippets the engine sent (0.62.0).
    const key = String(s.url || i).replace(/#.*$/, "");
    row.pages.add(key);
    if (basis.get(i) === "page") row.pagesRead.add(key);
    const names = present.get(i) || [];
    named.forEach((b, j) => {
      if (!names.some((n) => sameBrand(n, b))) return;
      if (cited) row.cells[j] = "cited";
      else if (!row.cells[j]) row.cells[j] = "read";
    });
  });
  const score = (r) => r.cells.filter((c) => c === "cited").length * 10 + r.cells.filter(Boolean).length;
  const rows = [...byDomain.values()].filter((r) => r.cells.some(Boolean))
    .sort((a, b) => score(b) - score(a) || a.domain.localeCompare(b.domain));
  return {
    brands: named.map((name) => ({ name, isYou: !!own && sameBrand(own.name, name) })),
    rows: rows.slice(0, maxSites).map(({ pagesRead, pages, ...r }) => ({ ...r, basis: pagesRead.size ? (pagesRead.size === pages.size ? "page" : "mixed") : "snippet" })),
    more: Math.max(0, rows.length - maxSites),
    pagesRead: matrix.filter((m) => m.basis === "page").length,
  };
}

/* ---------- product cards, their stores and the pages naming them ---------- */

// "Reliance Digital + others" -> ["Reliance Digital"]; "amazon.in · flipkart" -> both.
function merchantList(p) {
  return String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x));
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
// A store is the brand's own when its name or address carries the brand
// ("boat-lifestyle.com" for boAt, "oneplus.in" for OnePlus), or the tracked
// brand's own domain. Two-letter brands only match as a whole word, so "LG"
// doesn't claim every store with "lg" in its name.
function storeIsBrand(store, brand, own) {
  const s = String(store || "");
  if (!s) return false;
  if (own && own.url && sameBrand(own.name, brand)) {
    const d = normDomain(own.url).split(".")[0];
    if (d && slug(s).includes(slug(d))) return true;
  }
  const b = slug(brand);
  if (b.length >= 3) return slug(s).includes(b);
  return !!b && new RegExp(`(^|[^\\p{L}\\p{N}])${b}([^\\p{L}\\p{N}]|$)`, "iu").test(s);
}

/**
 * The product cards as a table (0.60.0): each card's brand, its stores in the
 * order the card lists them (the brand's own store marked), and the cited
 * pages whose title or snippet names that product. The summary is where the
 * cards send buyers first. A store's own price is not in the capture; the
 * card's price is the only one there is.
 */
export function productsView(rec, { own, knownBrands } = {}) {
  const products = rec.products || [];
  if (!products.length) return null;
  const brands = cleanBrands(rec, knownBrands).map((b) => b.brand);
  const cited = (rec.sources || []).filter((s) => s.outcome === "cited");
  const words = (t) => String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const rows = products.map((p, i) => {
    const name = String(p.name || "").trim();
    const startsWith = (b) => new RegExp(`^${String(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(name);
    const brand = p.brand || brands.filter(startsWith).sort((a, b) => b.length - a.length)[0] || name.split(/\s+/)[0] || "";
    // A page names the product when it has the brand and the model's telling
    // word, each as a whole word: "Airdopes 141" needs boAt and 141, "Pulse
    // ANC" needs Zento and Pulse. The brand alone isn't enough (a page about
    // OnePlus isn't about every OnePlus card), and neither is a substring
    // ("One" is not inside "headphones").
    const branded = !!brand && startsWith(brand);
    const model = words(branded ? name.slice(brand.length) : name);
    const key = model.find((w) => /\d/.test(w) && w.length >= 2) || model.find((w) => w.length >= 3) || "";
    const need = [...new Set([branded ? words(brand)[0] : words(name)[0], key].filter(Boolean))];
    const names = (s) => { const ws = new Set(words(`${s.title || ""} ${s.snippet || ""}`)); return need.every((w) => ws.has(w)); };
    const pages = need.length ? [...new Set(cited.filter(names).map((s) => normDomain(s.domain || s.url)).filter(Boolean))] : [];
    return {
      n: i + 1, name, brand, isYou: !!own && !!brand && sameBrand(own.name, brand),
      price: p.price || "", rating: p.rating ?? null, reviews: p.reviews ?? null, image: p.image || "",
      stores: merchantList(p).map((s) => ({ name: s, own: storeIsBrand(s, brand, own) })),
      otherStores: /\bothers?\b/i.test(p.merchant || ""),
      pages,
    };
  });
  const first = new Map();
  rows.forEach((r) => {
    const s = r.stores[0];
    if (!s) return;
    const f = first.get(s.name) || { name: s.name, n: 0, own: false };
    f.n++;
    f.own = f.own || s.own;
    first.set(s.name, f);
  });
  return {
    rows,
    firstStores: [...first.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
    storeLinks: rows.reduce((t, r) => t + r.stores.length, 0),
    withPages: rows.filter((r) => r.pages.length).length,
  };
}

/* ---------- pages cited ---------- */

export function pagesView(rec, { own, knownBrands } = {}) {
  const sources = rec.sources || [];
  const brands = cleanBrands(rec, knownBrands).map((b) => b.brand);
  const ctx = { ownBrand: own ? own.name : "", ownUrl: own ? own.url : "", brands };
  const matrix = computeBrandMatrix(rec);
  const present = new Map((matrix.sources || []).map((s) => [s.sourceIdx, s.presentBrands]));
  const rows = [];
  const seen = new Set();
  sources.forEach((s, i) => {
    if (s.outcome !== "cited") return;
    const key = s.url || `${s.domain}|${s.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    const domain = normDomain(s.domain || s.url);
    // Only brands this answer named or carded. The matrix vocabulary also
    // picks up capitalised words from the searches that recur in snippets —
    // model names like "Pulse" — which are not brands to list against a page.
    const names = (present.get(i) || []).map((n) => brands.find((b) => sameBrand(b, n))).filter(Boolean);
    rows.push({
      n: rows.length + 1,
      domain,
      title: s.title || "",
      url: s.url || "",
      kind: siteKindOf(domain, ctx),
      brands: [...new Set(names)].map((name) => ({ name, isYou: !!own && sameBrand(own.name, name) })),
    });
  });
  const kinds = KIND_GROUPS.map((label) => ({ label, n: rows.filter((r) => r.kind === label).length })).filter((k) => k.n);
  const citedDomains = new Set(rows.map((r) => r.domain));
  const readOnly = [...new Set(sources.filter((s) => s.outcome !== "cited")
    .map((s) => normDomain(s.domain || s.url)).filter((d) => d && !citedDomains.has(d)))];
  // Cited pages on independent sites (not yours, a rival brand's or a
  // retailer) whose title and snippet never name your brand.
  const silent = own ? [...new Set(rows.filter((r) => r.kind !== "Your site" && r.kind !== "Rival brand sites" && r.kind !== "Retailers"
    && !r.brands.some((b) => b.isYou)).map((r) => r.domain))] : [];
  return { rows, kinds, readOnly, silent, sourceCount: sources.length };
}

/* ---------- sites it used ---------- */

/**
 * Every site the answer read, one row per domain, with its pages.
 *
 * Reported (0.58.0): "we have almost removed the domains and the URLs which
 * were getting cited … the visibility around them was an important section".
 * The at-a-glance column showed five cited pages and folded everything else
 * into "+ 6 pages read but not cited"; the popup listed cited domains and put
 * the rest on one line. This is the full picture: cited sites first, then
 * sites read but not cited, each with every page the engine opened there.
 *
 * Ranked by cited pages, then pages read, then name: a site cited once
 * outranks one read three times and never used. A cited page's `n` is its
 * position among cited pages, the same numbering pagesView gives.
 */
export function domainsView(rec, { own, knownBrands } = {}) {
  const sources = rec.sources || [];
  const brands = cleanBrands(rec, knownBrands).map((b) => b.brand);
  const ctx = { ownBrand: own ? own.name : "", ownUrl: own ? own.url : "", brands };
  const byDomain = new Map();
  const seen = new Set();
  let citedN = 0;
  sources.forEach((s) => {
    const domain = normDomain(s.domain || s.url);
    if (!domain) return;
    const cited = s.outcome === "cited";
    const key = `${s.url || `${s.domain}|${s.title}`}|${cited}`;
    if (seen.has(key)) return;
    seen.add(key);
    let d = byDomain.get(domain);
    if (!d) {
      d = { domain, kind: siteKindOf(domain, ctx), cited: 0, read: 0, pages: [] };
      byDomain.set(domain, d);
    }
    if (cited) d.cited++; else d.read++;
    d.pages.push({ title: s.title || "", url: s.url || "", cited, n: cited ? ++citedN : null });
  });
  const rows = [...byDomain.values()];
  rows.forEach((d) => d.pages.sort((a, b) => (b.cited - a.cited) || ((a.n || 0) - (b.n || 0))));
  rows.sort((a, b) => b.cited - a.cited || (b.cited + b.read) - (a.cited + a.read) || a.domain.localeCompare(b.domain));
  return {
    rows,
    citedSites: rows.filter((d) => d.cited).length,
    readOnlySites: rows.filter((d) => !d.cited).length,
    maxPages: Math.max(1, ...rows.map((d) => d.cited + d.read)),
  };
}

/* ---------- your brand ---------- */

/**
 * Who "your brand" is for this answer.
 * 1. A campaign capture: that campaign's brand.
 * 2. A brand the capture itself tagged as yours (Settings → my brand).
 * 3. A campaign whose brand this answer names — the owner tracks it, so
 *    seeing how it did here is the point of opening the answer.
 * 4. Exactly one campaign: its brand, even if the answer never named it
 *    ("not named" is the most useful thing the view can say).
 */
export function ownBrandFor(rec, profiles = []) {
  const live = (profiles || []).filter((p) => p && !p.deletedAt && p.brand && p.brand.name);
  if (rec.geo && rec.geo.profileId) {
    const p = live.find((x) => x.id === rec.geo.profileId);
    if (p) return { name: p.brand.name, url: p.brand.url || "", source: "campaign", campaign: p.name };
  }
  const tagged = (rec.brandMentions || []).find((b) => b.relation === "own");
  if (tagged) return { name: tagged.brand, url: "", source: "settings" };
  const named = (rec.brandMentions || []).filter((b) => b.count > 0).map((b) => b.brand);
  const hit = live.find((p) => named.some((n) => sameBrand(n, p.brand.name)));
  if (hit) return { name: hit.brand.name, url: hit.brand.url || "", source: "campaign", campaign: hit.name };
  if (live.length === 1) return { name: live[0].brand.name, url: live[0].brand.url || "", source: "campaign", campaign: live[0].name };
  return null;
}

/** Four numbers for your brand: where it was named, cited pages, cards, map or images. */
export function yourBrandView(rec, own, { knownBrands, previous, max = 4 } = {}) {
  if (!own) return null;
  const list = cleanBrands(rec, knownBrands);
  const named = namedOrder(list);
  const pos = named.findIndex((n) => sameBrand(n, own.name)) + 1;
  const mention = list.find((b) => sameBrand(b.brand, own.name));
  const tiles = [];
  tiles.push(pos
    ? { key: "answer", label: "In the answer", value: pos === 1 ? "Named first" : `Named ${ORD(pos)}`, sub: `×${mention.count} mention${mention.count === 1 ? "" : "s"}`, tone: pos === 1 ? "good" : "neutral" }
    : { key: "answer", label: "In the answer", value: "Not named", sub: `${named.length} other brand${named.length === 1 ? "" : "s"} named`, tone: "bad" });

  const pages = pagesView(rec, { own, knownBrands });
  if (rec.searched || pages.rows.length) {
    const about = pages.rows.filter((r) => r.brands.some((b) => b.isYou)).length;
    const ownCited = pages.rows.some((r) => r.kind === "Your site");
    tiles.push({ key: "cited", label: "Cited pages", value: `${about} of ${pages.rows.length}`, sub: ownCited ? "own site cited" : "own site not cited", tone: about ? "good" : "bad" });
  }
  const products = rec.products || [];
  if (products.length) {
    const mine = products.map((p, i) => (productBrandIs(p, own.name) ? i + 1 : 0)).filter(Boolean);
    tiles.push({ key: "cards", label: "Product cards", value: mine.length ? `Card ${mine.join(", ")} of ${products.length}` : "No card", sub: mine.length ? `${mine.length} card${mine.length === 1 ? "" : "s"}` : `rivals have ${products.length}`, tone: mine.length ? "good" : "bad" });
    if (mine.length) {
      const ownStore = mine.some((i) => merchantIsBrand(products[i - 1].merchant, own));
      tiles.push({ key: "store", label: "Own store", value: ownStore ? "Listed" : "Not listed", sub: ownStore ? "next to resellers" : "only resellers", tone: ownStore ? "good" : "bad" });
    }
  }
  const places = rec.places || [];
  if (places.length) {
    const i = places.findIndex((p) => sameBrand(p.name, own.name) || String(p.name || "").toLowerCase().startsWith(own.name.toLowerCase()));
    tiles.push(i >= 0
      ? { key: "map", label: "Map", value: `Pin ${i + 1} of ${places.length}`, sub: places[i].website ? "website on card" : "no website link", tone: i < 3 ? "good" : "neutral" }
      : { key: "map", label: "Map", value: "Not on map", sub: `${places.length} places shown`, tone: "bad" });
  }
  const images = rec.images || [];
  if (images.length >= 3) {
    const k = images.filter((m) => wordRe(own.name, "i").test(`${m.title || ""} ${m.attribution || ""} ${m.url || ""}`)).length;
    tiles.push({ key: "images", label: "Images", value: `${k} of ${images.length}`, sub: k ? "show your brand" : "none show it", tone: k ? "good" : "bad" });
  }
  let since = null;
  if (previous) {
    const prevNamed = namedOrder(cleanBrands(previous, knownBrands));
    const was = prevNamed.findIndex((n) => sameBrand(n, own.name)) + 1;
    since = was === pos ? (pos ? `still named ${pos === 1 ? "first" : ORD(pos)}` : "still not named")
      : !was ? "newly named" : !pos ? `dropped out (was ${ORD(was)})` : pos < was ? `up from ${ORD(was)}` : `down from ${ORD(was)}`;
  }
  return { name: own.name, campaign: own.campaign || "", tiles: tiles.slice(0, max), since, previousAt: previous ? previous.capturedAt : null };
}

function productBrandIs(p, brand) {
  if (p.brand && sameBrand(p.brand, brand)) return true;
  return new RegExp(`^${String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(p.name || "").trim());
}

function merchantIsBrand(merchant, own) {
  const m = String(merchant || "").toLowerCase();
  if (!m) return false;
  if (m.includes(own.name.toLowerCase())) return true;
  const d = normDomain(own.url);
  return !!d && m.includes(d.split(".")[0]);
}

/* ---------- since last time ---------- */

/** The previous answer to the same prompt from the same engine. */
export function findPrevious(rec, records = []) {
  let best = null;
  const tracked = rec.geo && rec.geo.profileId && rec.geo.promptId;
  const key = normPrompt(rec.userPrompt);
  for (const r of records) {
    if (!r || r.captureId === rec.captureId || r.platform !== rec.platform) continue;
    if (!(r.capturedAt < rec.capturedAt)) continue;
    if (tracked) {
      if (!r.geo || r.geo.profileId !== rec.geo.profileId || r.geo.promptId !== rec.geo.promptId) continue;
    } else {
      // Ad-hoc answers compare with ad-hoc answers only, the same isolation
      // the rest of the app keeps between campaign runs and browsing.
      if (r.geo || !key || normPrompt(r.userPrompt) !== key) continue;
    }
    if (!best || r.capturedAt > best.capturedAt) best = r;
  }
  return best;
}

function brandChanges(rec, previous, knownBrands) {
  const now = namedOrder(cleanBrands(rec, knownBrands));
  const was = namedOrder(cleanBrands(previous, knownBrands));
  const byBrand = new Map();
  now.forEach((name, i) => {
    const j = was.findIndex((w) => sameBrand(w, name));
    const kind = j < 0 ? "added" : j > i ? "up" : j < i ? "down" : "same";
    byBrand.set(name.toLowerCase(), { kind, from: j < 0 ? null : j + 1, to: i + 1 });
  });
  const dropped = was.map((name, j) => ({ name, was: j + 1 })).filter((d) => !now.some((n) => sameBrand(n, d.name)));
  return { byBrand, dropped, now, was };
}

/** Plain sentences describing what moved since the previous answer. */
export function changesView(rec, previous, { knownBrands } = {}) {
  if (!previous) return null;
  const { byBrand, dropped, now } = brandChanges(rec, previous, knownBrands);
  const items = [];
  now.forEach((name) => {
    const c = byBrand.get(name.toLowerCase());
    if (c.kind === "added") items.push({ kind: "added", text: `${name} is new — not named last time` });
    else if (c.kind === "up") items.push({ kind: "up", text: `${name} moved up from ${ORD(c.from)} to ${ORD(c.to)}` });
    else if (c.kind === "down") items.push({ kind: "down", text: `${name} moved down from ${ORD(c.from)} to ${ORD(c.to)}` });
  });
  dropped.forEach((d) => items.push({ kind: "dropped", text: `${d.name} dropped out (was ${ORD(d.was)})` }));
  const first = now[0];
  if (first && byBrand.get(first.toLowerCase()).kind === "same") items.push({ kind: "same", text: `${first} still named first` });
  const cited = (r) => new Set((r.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean));
  const a = cited(rec), b = cited(previous);
  const gained = [...a].filter((d) => !b.has(d)), lost = [...b].filter((d) => !a.has(d));
  if (gained.length) items.push({ kind: "site", text: `Newly cited: ${gained.slice(0, 4).join(", ")}${gained.length > 4 ? ` +${gained.length - 4}` : ""}` });
  if (lost.length) items.push({ kind: "site", text: `No longer cited: ${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ` +${lost.length - 4}` : ""}` });
  // An ad shown with the answer is part of what changed (0.60.0): ChatGPT
  // shows one with some answers and not others.
  const advertisers = (r) => new Set((r.ads || []).map((a) => String(a.advertiser || a.targetDomain || "").trim()).filter(Boolean));
  const adNow = advertisers(rec), adThen = advertisers(previous);
  [...adNow].filter((a) => !adThen.has(a)).forEach((a) => items.push({ kind: "ad", text: `An ad from ${a} was shown${adThen.size ? "" : " (no ad last time)"}` }));
  [...adThen].filter((a) => !adNow.has(a)).forEach((a) => items.push({ kind: "ad", text: `No ad from ${a} this time (shown last time)` }));
  if (!items.length) items.push({ kind: "same", text: "Same brands in the same order, citing the same sites" });
  return { at: previous.capturedAt, items };
}

/* ---------- ads shown with the answer ---------- */

/* The sponsored cards shown with the answer (ChatGPT's ads), with what ties
 * each to the answer: whether the answer itself names the advertiser, and
 * whether the engine read or cited the advertiser's site. Analyze and the
 * answer report both show it. */
export function adsView(rec, { knownBrands } = {}) {
  const answer = String(rec.answerText || "").toLowerCase();
  const sources = rec.sources || [];
  const site = (d) => normDomain(d || "").split(".")[0];
  // Where the advertiser came among the brands the answer named, and which
  // product cards list it as a store (0.60.0): an ad for a store that the
  // cards already send buyers to is a different thing from one for a store
  // the answer never mentions.
  const named = namedOrder(cleanBrands(rec, knownBrands));
  return (rec.ads || []).map((a) => {
    const domain = normDomain(a.targetDomain || a.advertiserUrl || "");
    const name = String(a.advertiser || "").toLowerCase();
    const onSite = sources.filter((s) => { const d = normDomain(s.domain || s.url); return d && domain && site(d) === site(domain); });
    const label = site(domain);
    const sells = (p) => String(p.merchant || "").toLowerCase().split(/\s*(?:\+|·|,|\band\b)\s*/).map((x) => x.trim()).filter(Boolean)
      .some((m) => (name && (m === name || m.includes(name))) || (label && label.length > 2 && m.replace(/\s+/g, "").includes(label)));
    const cards = (rec.products || []).map((p, i) => ({ n: i + 1, name: p.name || "" })).filter((c, i) => sells(rec.products[i]));
    const place = name ? named.findIndex((b) => sameBrand(b, a.advertiser)) + 1 : 0;
    return {
      place,
      onCards: cards,
      advertiser: a.advertiser || domain || "Advertiser",
      label: a.label || "Sponsored",
      preamble: a.preamble || "",
      title: a.title || "",
      body: a.body || "",
      domain,
      url: a.targetUrl || "",
      placement: a.placement || "",
      format: a.format || "",
      namedInAnswer: !!name && new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "u").test(answer),
      siteRead: onSite.length,
      siteCited: onSite.filter((s) => s.outcome === "cited").length,
    };
  });
}

/* ---------- where a page came in the engine's results ---------- */

/**
 * A page's position in the results the engine got for this answer, where the
 * capture holds it (0.60.0, the "page found at #N" step of where a
 * recommendation came from):
 *   ChatGPT    the ref index in its citation id: `turn0search3` is the
 *              fourth result of that turn's searches (0-based in the id).
 *   Perplexity the result's index in its source list (`[n]` markers count
 *              from 1; a 0-based index is shifted to match).
 * Gemini publishes neither its searches nor their results, and Grok's
 * source order isn't a ranking, so they get nothing rather than a guess.
 * Returns Map(url -> position).
 */
export function resultPositions(rec) {
  const out = new Map();
  const sources = rec.sources || [];
  if (rec.platform === "chatgpt") {
    for (const s of sources) {
      const ids = (s.platformSpecific && s.platformSpecific.markerIds) || [];
      const nums = ids.map((x) => /^turn\d+search(\d+)$/.exec(String(x))).filter(Boolean).map((m) => Number(m[1]) + 1);
      if (nums.length && s.url && !out.has(s.url)) out.set(s.url, Math.min(...nums));
    }
  } else if (rec.platform === "perplexity") {
    const idx = sources.map((s) => (s.platformSpecific && Number.isInteger(s.platformSpecific.sourceIndex) ? s.platformSpecific.sourceIndex : null));
    const zeroBased = idx.some((x) => x === 0);
    sources.forEach((s, i) => {
      if (!s.url || out.has(s.url)) return;
      out.set(s.url, idx[i] != null ? idx[i] + (zeroBased ? 1 : 0) : i + 1);
    });
  }
  return out;
}
