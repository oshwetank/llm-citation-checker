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
import { analyzeFanout } from "./fanout.js";
import { computeBrandMatrix, sameBrand } from "./funnel-omitted.js";
import { normalizeMentions } from "./mention-list.js";
import { siteKindOf, isBrandSite, normDomain, KIND_GROUPS } from "./siteKind.js";

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

export function searchesView(rec, brandNames = []) {
  const rows = [];
  for (const [key, lane, laneLabel] of LANES) {
    for (const q of (rec.fanout && rec.fanout[key]) || []) {
      const text = typeof q === "string" ? q : q && q.query;
      if (typeof text !== "string" || !text.trim()) continue;
      rows.push({ lane, laneLabel, text: text.trim(), tag: "" });
    }
  }
  const fa = analyzeFanout(rows.map((r) => r.text), rec.sources || []);
  rows.forEach((r, i) => {
    const labels = (fa.perQuery[i] && fa.perQuery[i].intents) || [];
    r.tag = r.lane === "shopping" ? "products" : r.lane === "image" ? "images" : (TAG_WORDS[labels[0]] || "");
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
    const independent = backers.filter((x) => !x.own).length;
    const ownSite = backers.length - independent;
    let verdict, label, tone;
    if (!rec.searched && !sources.length) { verdict = "memory"; label = "From memory"; tone = "warn"; }
    else if (independent) { verdict = "independent"; label = `${independent} independent${ownSite ? " + own" : ""}`; tone = "good"; }
    else if (ownSite) { verdict = "own"; label = "Own site only"; tone = "warn"; }
    else if (readOnly.length) { verdict = "read"; label = "Read, not cited"; tone = "warn"; }
    else { verdict = "none"; label = "Nothing"; tone = "bad"; }
    const pos = b.count > 0 ? named.indexOf(b.brand) + 1 : 0;
    return {
      name: b.brand,
      position: pos,
      count: b.count || 0,
      shownOnly: !(b.count > 0),
      isYou: isOwnBrand,
      relation: b.relation || null,
      stance: b.stance || null,
      backing: { verdict, label, tone, independent, ownSite, readOnly: readOnly.length, backers },
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
  // Cited, independent, and silent about you: the pages to get onto.
  const silent = own ? [...new Set(rows.filter((r) => r.kind !== "Your site" && r.kind !== "Rival brand sites" && r.kind !== "Retailers"
    && !r.brands.some((b) => b.isYou)).map((r) => r.domain))] : [];
  return { rows, kinds, readOnly, silent, sourceCount: sources.length };
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
    const k = images.filter((m) => new RegExp(`\\b${own.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(`${m.title || ""} ${m.attribution || ""} ${m.url || ""}`)).length;
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
  if (!items.length) items.push({ kind: "same", text: "Same brands in the same order, citing the same sites" });
  return { at: previous.capturedAt, items };
}
