/*
 * campaignBoard.js — a campaign's results, as the canvas lays them out
 * (0.50.0).
 *
 * Release 4 of the redesign. The campaign board answers, for one brand
 * ("viewing as"), how it shows up across a campaign's answers: by kind of
 * answer (a product carousel, an explainer, a map), against each competitor,
 * on each engine, run by run, topic by topic, prompt by prompt, and which
 * sites the engines lean on — including the ones that cite rivals and never
 * mention you. Everything here is pure; the background calls it over full
 * records (positions need the answer text) and the panel draws the result.
 *
 * Numbers follow the definitions in glossary.js and computeMetrics(): an
 * answer "names" a brand when the detector found it or its name occurs as a
 * whole word; Position ranks the tracked brands by first appearance;
 * Citations count answers that cited the brand's own domain.
 */
import { computeMetrics, brandPresence, normName, domainOfUrl, domainMatches, headToHead } from "./geo.js";
import { computeBrandMatrix, sameBrand } from "./funnel-omitted.js";
import { siteKindOf, normDomain, KIND_GROUPS } from "./siteKind.js";
import { answerKind } from "./analyzeView.js";
import { extractBrandAspects } from "./aspects.js";

export const ENGINE_ORDER = ["chatgpt", "gemini", "perplexity", "grok"];
const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const queriesOf = (rec) => [].concat(
  ((rec.fanout && rec.fanout.search) || []), ((rec.fanout && rec.fanout.shopping) || []), ((rec.fanout && rec.fanout.image) || []),
).map((q) => String(typeof q === "string" ? q : (q && q.query) || "").trim()).filter(Boolean);
const wordRe = (name) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");

// Image hosts that are the engine's own thumbnail proxy: they say nothing
// about which site the picture came from.
const PROXY_HOSTS = /(^|\.)(images\.openai\.com|gstatic\.com|googleusercontent\.com|bing\.net|perplexity\.ai|x\.ai|grok\.com)$/i;

/** Where each tracked brand came in one answer: Map(key -> rank), first appearance in the text. */
export function ranksIn(rec, brands) {
  const pres = brandPresence(rec, brands);
  const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
  return { pres, rank: new Map(ranked.map((p, i) => [p.key, i + 1])) };
}

/** Does a product card belong to the brand? Its name starts with the brand, as a word. */
export function cardIsBrand(p, brand) {
  const name = String((p && p.name) || "").trim();
  return !!name && !!brand && new RegExp(`^${String(brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(name);
}
const brandOfCard = (p, brands) => brands.find((b) => cardIsBrand(p, b.name));

// "Reliance Digital + others" -> ["Reliance Digital"]; "amazon.in · flipkart" -> both.
function merchantsOf(p) {
  return String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x));
}
function isOwnStore(merchant, brand, domain) {
  const m = String(merchant || "").toLowerCase();
  if (!m) return false;
  if (domain && m.includes(domain.split(".")[0])) return true;
  return !!brand && wordRe(brand).test(merchant);
}

/* ---------- KPIs for one brand, five ways ---------- */

function brandKpis(recs, brand, brands, profile) {
  const m = computeMetrics(recs, profile, brands);
  const row = m.brands.find((b) => normName(b.name) === normName(brand.name)) || null;
  const dom = domainOfUrl(brand.url);
  const n = recs.length;
  // Citations of the brand's own site.
  const ownCitedUrls = new Set();
  let allCited = 0, ownCited = 0, citedNotNamed = 0;
  const independent = new Set();
  // Cards, images, pins.
  let answersWithCards = 0, cards = 0, myCards = 0, myCardAnswers = 0, ownStore = 0;
  const cardPos = [];
  const destCount = new Map();
  let answersWithImages = 0, images = 0, myImages = 0, myImagesOwnSite = 0;
  const imgHosts = new Map();
  let answersWithMap = 0, places = 0, myPlaces = 0, myPlacesSite = 0;
  const pinPos = [];
  const placeNames = new Set();
  const key = normName(brand.name);
  for (const r of recs) {
    const pres = brandPresence(r, brands).find((p) => p.key === key);
    let citesOwn = false;
    const matrix = computeBrandMatrix(r);
    const pagesPresent = new Map((matrix.sources || []).map((s) => [s.sourceIdx, s.presentBrands || []]));
    (r.sources || []).forEach((s, i) => {
      if (s.outcome !== "cited") return;
      allCited++;
      if (dom && domainMatches(s.domain, dom)) { ownCited++; citesOwn = true; if (s.url) ownCitedUrls.add(s.url); }
      else if ((pagesPresent.get(i) || []).some((b) => sameBrand(b, brand.name))) independent.add(s.url || `${s.domain}|${s.title}`);
    });
    if (citesOwn && !(pres && pres.present)) citedNotNamed++;
    const ps = r.products || [];
    if (ps.length) answersWithCards++;
    cards += ps.length;
    let mine = 0;
    ps.forEach((p, i) => {
      if (!cardIsBrand(p, brand.name)) return;
      mine++;
      cardPos.push(i + 1);
      const ms = merchantsOf(p);
      if (ms.some((x) => isOwnStore(x, brand.name, dom))) ownStore++;
      ms.forEach((x) => destCount.set(x, (destCount.get(x) || 0) + 1));
    });
    myCards += mine;
    if (mine) myCardAnswers++;
    const ims = r.images || [];
    if (ims.length) answersWithImages++;
    images += ims.length;
    ims.forEach((im) => {
      const host = normDomain(im.source || im.pageUrl || im.url || "");
      if (host && !PROXY_HOSTS.test(host)) imgHosts.set(host, (imgHosts.get(host) || 0) + 1);
      if (wordRe(brand.name).test(String(im.title || ""))) {
        myImages++;
        if (dom && host && domainMatches(host, dom)) myImagesOwnSite++;
      }
    });
    const pl = r.places || [];
    if (pl.length) answersWithMap++;
    places += pl.length;
    pl.forEach((p, i) => {
      placeNames.add(String(p.name || "").toLowerCase());
      if (!wordRe(brand.name).test(String(p.name || ""))) return;
      myPlaces++;
      pinPos.push(i + 1);
      if (dom && domainMatches(normDomain(p.website || ""), dom)) myPlacesSite++;
    });
  }
  const topDest = [...destCount.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const topImg = [...imgHosts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return {
    n,
    mentions: {
      visibility: row ? row.visibility : 0, present: row ? row.responsesPresent : 0,
      shareOfVoice: row ? row.shareOfVoice : 0, mentions: row ? row.mentions : 0, pool: m.mentionPool,
      avgPosition: row ? row.avgPosition : null,
      citations: row ? row.citations : 0, sourceVisibility: row ? row.sourceVisibility : 0,
    },
    citations: {
      sourceVisibility: row ? row.sourceVisibility : 0, citations: row ? row.citations : 0,
      pages: ownCitedUrls.size, share: pct(ownCited, allCited), ownCited, allCited,
      independent: independent.size, citedNotNamed,
    },
    products: {
      answersWithCards, cards, myCards, myCardAnswers, share: pct(myCards, cards),
      avgCard: avg(cardPos), ownStore, topDestination: topDest ? { name: topDest[0], n: topDest[1] } : null,
    },
    images: {
      answersWithImages, images, myImages, myImagesOwnSite,
      topSource: topImg ? { name: topImg[0], n: topImg[1] } : null,
    },
    local: {
      answersWithMap, places, myPlaces, share: pct(myPlaces, places), avgPin: avg(pinPos), websiteOnCard: myPlacesSite, placesNamed: placeNames.size,
    },
  };
}

// The five KPI views, as tiles: label, value, what it is out of.
function kpiTiles(k, brand, dom) {
  const f = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
  const p = (x) => `${Math.round(x)}%`;
  const site = dom || "your site";
  return {
    mentions: [
      ["Visibility", p(k.mentions.visibility), `named in ${k.mentions.present} of ${k.n} answers`, "visibility", "pts"],
      ["Share of voice", p(k.mentions.shareOfVoice), `${k.mentions.mentions} of ${k.mentions.pool} tracked mentions`, "shareOfVoice", "pts"],
      ["Avg position", f(k.mentions.avgPosition), "when named", "avgPosition", "rank"],
      ["Mentions", String(k.mentions.mentions), `across ${k.n} answers`, "mentions", "n"],
      ["Citations", String(k.mentions.citations), `of ${site}`, "citations", "n"],
      ["Source visibility", p(k.mentions.sourceVisibility), `${k.mentions.citations} of ${k.n} answers cite you`, "sourceVisibility", "pts"],
    ],
    citations: [
      ["Source visibility", p(k.citations.sourceVisibility), `${k.citations.citations} of ${k.n} answers cite you`, "sourceVisibility", "pts"],
      ["Citations", String(k.citations.citations), `of ${site}`, "citations", "n"],
      ["Your pages cited", String(k.citations.pages), "different URLs", "pages", "n"],
      ["Citation share", p(k.citations.share), `${k.citations.ownCited} of ${k.citations.allCited} citations`, "share", "pts"],
      ["Independent pages about you", String(k.citations.independent), `cited pages that mention ${brand}`, "independent", "n"],
      ["Cited, but not named", String(k.citations.citedNotNamed), "answers use your page, skip your name", "citedNotNamed", "n-bad"],
    ],
    products: [
      ["Answers with cards", `${k.products.answersWithCards} of ${k.n}`, `${Math.round(pct(k.products.answersWithCards, k.n))}% showed a carousel`, "answersWithCards", "n"],
      ["Your cards", String(k.products.myCards), `in ${plural(k.products.myCardAnswers, "answer")}`, "myCards", "n"],
      ["Card share", p(k.products.share), `${k.products.myCards} of ${k.products.cards} cards`, "share", "pts"],
      ["Avg card position", f(k.products.avgCard), "when shown", "avgCard", "rank"],
      ["Own store offered", `${k.products.ownStore} of ${k.products.myCards}`, `cards list ${site}`, "ownStore", "n"],
      ["Top destination", k.products.topDestination ? k.products.topDestination.name : "—", k.products.topDestination ? `${k.products.topDestination.n} of your ${k.products.myCards} cards` : "", null, null],
    ],
    images: [
      ["Answers with images", `${k.images.answersWithImages} of ${k.n}`, "image-led answers", "answersWithImages", "n"],
      ["Your images", `${k.images.myImages} of ${k.images.images}`, `${Math.round(pct(k.images.myImages, k.images.images))}% of images shown`, "myImages", "n"],
      ["From your own site", String(k.images.myImagesOwnSite), `of your ${k.images.myImages} images`, "myImagesOwnSite", "n"],
      ["Top image source", k.images.topSource ? k.images.topSource.name : "—", k.images.topSource ? `${k.images.topSource.n} of ${k.images.images} images` : "the engines served images from their own proxy", null, null],
    ],
    local: [
      ["Answers with a map", `${k.local.answersWithMap} of ${k.n}`, k.local.answersWithMap ? "" : "no local prompts yet", "answersWithMap", "n"],
      ["Your pin share", k.local.places ? p(k.local.share) : "—", k.local.places ? `${k.local.myPlaces} of ${k.local.places} pins` : "", "share", "pts"],
      ["Avg pin position", f(k.local.avgPin), k.local.myPlaces ? "when pinned" : "", "avgPin", "rank"],
      ["Website on your card", k.local.myPlaces ? `${k.local.websiteOnCard} of ${k.local.myPlaces}` : "—", "", "websiteOnCard", "n"],
      ["Places named", k.local.places ? String(k.local.placesNamed) : "—", "", "placesNamed", "n"],
    ],
  };
}

// "▲ 6 pts since run 2" — direction is good or bad by the metric's kind.
function delta(cur, prev, unit, label) {
  if (cur == null || prev == null || !unit) return null;
  const d = cur - prev;
  const better = unit === "rank" || unit === "n-bad" ? d < 0 : d > 0;
  if (Math.abs(d) < (unit === "rank" ? 0.05 : 0.5)) return { text: `= same as ${label}`, tone: 0 };
  const size = unit === "pts" ? `${Math.round(Math.abs(d))} pt${Math.round(Math.abs(d)) === 1 ? "" : "s"}` : unit === "rank" ? `${Math.abs(d).toFixed(1)} ${d < 0 ? "better" : "worse"}` : String(Math.round(Math.abs(d)));
  return { text: `${d > 0 ? "▲" : "▼"} ${size} since ${label}`, tone: better ? 1 : -1 };
}
function flatKpi(k, group, field) {
  const g = k[group] || {};
  return g[field];
}

/* ---------- the board ---------- */

const KIND_ORDER = [
  ["shopping", "Shopping", "Product feed, retailer listings and review sites decide the carousel."],
  ["info", "Informational", "Get onto the explainer and review pages engines cite."],
  ["images", "Image-led", "Supply clean product images to retailers and your own pages."],
  ["memory", "From memory", "Nothing on-page to fix; this is the brand's footprint in the model."],
  ["local", "Local", "Keep the map listing complete: website, hours, photos, reviews."],
];

/**
 * The tracked prompts a tag filter leaves in view: the ones carrying one of
 * the tags now, and the ones whose answers in view were tagged with one when
 * they ran (a prompt can be retagged after a run). With no tags, all of them.
 * Without this the numbers followed the tag and the prompt grid didn't.
 */
export function promptsInScope(prompts, tags, recs) {
  if (!tags || !tags.length) return prompts;
  const answered = new Set(recs.map((r) => r.geo && r.geo.promptId).filter(Boolean));
  return prompts.filter((p) => (p.tags || []).some((t) => tags.includes(t)) || answered.has(p.id));
}

/**
 * @param {object[]} recs  this view's answers (one per prompt, engine and run)
 * @param {object} o
 *   profile, brands (tracked + inferred, own flagged), viewAs (brand name),
 *   prompts (tracked prompts), runs (newest first), runId (the run shown, or null for all),
 *   all (every answer of the campaign under the same engine/tag filters, any run),
 *   engineFilter (the engines the board is limited to; empty for all),
 *   tags (the tag filter the answers were selected with; empty for none)
 */
export function campaignBoard(recs, { profile, brands, viewAs, prompts = [], runs = [], runId = null, all = recs, engineFilter = [], tags = [] } = {}) {
  prompts = promptsInScope(prompts, tags, all);
  const own = brands.find((b) => b.isOwn) || brands[0] || { name: (profile && profile.brand && profile.brand.name) || "", url: "" };
  const view = brands.find((b) => normName(b.name) === normName(viewAs || "")) || own;
  const dom = domainOfUrl(view.url);
  // The campaign's engines show even before they have answered, so a missing
  // one is visible; an engine filter narrows them to what was asked for.
  const engines = ENGINE_ORDER.filter((e) => (recs.some((r) => r.platform === e) || ((profile && profile.engines) || []).includes(e))
    && (!engineFilter.length || engineFilter.includes(e)));
  const runsAsc = [...runs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const runNo = new Map(runsAsc.map((r, i) => [r.id, i + 1]));

  // KPIs, and the same for the run before, for "since run N".
  const k = brandKpis(recs, view, brands, profile);
  const tiles = kpiTiles(k, view.name, dom);
  let prevLabel = null, prevK = null;
  const curRun = runId ? runsAsc.find((r) => r.id === runId) : null;
  if (curRun) {
    const i = runsAsc.indexOf(curRun);
    const prevRun = i > 0 ? runsAsc[i - 1] : null;
    if (prevRun) {
      const prevRecs = all.filter((r) => r.geo && r.geo.runId === prevRun.id);
      if (prevRecs.length) { prevK = brandKpis(prevRecs, view, brands, profile); prevLabel = `run ${runNo.get(prevRun.id)}`; }
    }
  }
  const focus = {};
  for (const [group, list] of Object.entries(tiles)) {
    focus[group] = list.map(([label, value, sub, field, unit]) => ({
      label, value, sub,
      delta: prevK && field ? delta(flatKpi(k, group, field), flatKpi(prevK, group, field), unit, prevLabel) : null,
    }));
  }
  const available = {
    mentions: true, citations: true,
    products: k.products.answersWithCards > 0, images: k.images.answersWithImages > 0, local: k.local.answersWithMap > 0,
  };

  // By kind of answer.
  const kindOf = (r) => answerKind(r).id;
  const kindRow = (id, label, lever, list) => {
    const n = list.length;
    let named = 0, cited = 0, withCards = 0, myCardAns = 0, imgs = 0, myImgs = 0, withMap = 0, myPin = 0;
    const cardPos = [];
    for (const r of list) {
      const p = brandPresence(r, brands).find((x) => x.key === normName(view.name));
      if (p && p.mentions > 0) named++;
      if (p && p.citedSource) cited++;
      const ps = r.products || [];
      if (ps.length) {
        withCards++;
        const i = ps.findIndex((c) => cardIsBrand(c, view.name));
        if (i >= 0) { myCardAns++; cardPos.push(i + 1); }
      }
      imgs += (r.images || []).length;
      myImgs += (r.images || []).filter((im) => wordRe(view.name).test(String(im.title || ""))).length;
      if ((r.places || []).length) { withMap++; if ((r.places || []).some((pl) => wordRe(view.name).test(String(pl.name || "")))) myPin++; }
    }
    return {
      id, label, lever, answers: n,
      named: n ? pct(named, n) : null, cited: n && id !== "memory" ? pct(cited, n) : null,
      card: withCards ? { pct: pct(myCardAns, withCards), avg: avg(cardPos) } : null,
      images: imgs ? { mine: myImgs, of: imgs } : null,
      pin: withMap ? pct(myPin, withMap) : null,
    };
  };
  const byKind = KIND_ORDER.map(([id, label, lever]) => kindRow(id, label, lever, recs.filter((r) => kindOf(r) === id)));
  byKind.push(kindRow("all", "All answers", "", recs));

  // Product cards across the campaign.
  const prodMap = new Map();
  for (const r of recs) {
    (r.products || []).forEach((p, i) => {
      const keyP = String(p.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!keyP) return;
      if (!prodMap.has(keyP)) prodMap.set(keyP, { name: p.name, brand: (brandOfCard(p, brands) || {}).name || String(p.name).split(/\s+/)[0], shown: 0, pos: [], engines: new Set(), dest: new Map(), own: false });
      const e = prodMap.get(keyP);
      e.shown++;
      e.pos.push(i + 1);
      e.engines.add(r.platform);
      const b = brands.find((x) => x.name === e.brand);
      merchantsOf(p).forEach((x) => {
        e.dest.set(x, (e.dest.get(x) || 0) + 1);
        if (b && isOwnStore(x, b.name, domainOfUrl(b.url))) e.own = true;
      });
    });
  }
  const products = {
    total: k.products.cards, answers: k.products.answersWithCards,
    rows: [...prodMap.values()].sort((a, b) => b.shown - a.shown || avg(a.pos) - avg(b.pos)).slice(0, 12).map((e) => ({
      name: e.name, brand: e.brand, isView: sameBrand(e.brand, view.name), shown: e.shown, avgPos: avg(e.pos),
      engines: ENGINE_ORDER.filter((x) => e.engines.has(x)),
      dest: [...e.dest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d), own: e.own,
    })),
  };
  const myDest = new Map();
  const myCardImg = new Map();
  recs.forEach((r) => (r.products || []).forEach((p) => {
    if (!cardIsBrand(p, view.name)) return;
    merchantsOf(p).forEach((x) => myDest.set(x, (myDest.get(x) || 0) + 1));
    const host = normDomain(p.image || "");
    if (host && !PROXY_HOSTS.test(host)) myCardImg.set(host, (myCardImg.get(host) || 0) + 1);
  }));
  products.destinations = [...myDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n, own: isOwnStore(name, view.name, dom) }));
  products.cardImages = [...myCardImg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n, own: !!dom && domainMatches(name, dom) }));
  products.note = k.products.myCards
    ? `Only ${k.products.ownStore} of ${k.products.myCards} cards list ${view.name}’s own store.${products.destinations[0] && !products.destinations[0].own ? ` ${products.destinations[0].name} gets most of the clicks the engines send.` : ""}`
    : `No card in these answers is ${view.name}’s.`;

  // Brands compared.
  const metrics = computeMetrics(recs, profile, brands);
  const brandRows = metrics.brands.map((b) => ({
    name: b.name, isOwn: b.isOwn, auto: b.auto, isView: normName(b.name) === normName(view.name),
    visibility: b.visibility, shareOfVoice: b.shareOfVoice, mentions: b.mentions, avgPosition: b.avgPosition,
    citations: b.citations, sourceVisibility: b.sourceVisibility,
  })).sort((a, b) => (b.isOwn ? 1 : 0) - (a.isOwn ? 1 : 0) || b.visibility - a.visibility);

  // As a source, and by engine.
  const vRow = metrics.brands.find((b) => normName(b.name) === normName(view.name)) || {};
  const asSource = {
    domain: dom, sourceVisibility: vRow.sourceVisibility || 0, citations: vRow.citations || 0, answers: recs.length,
    note: dom ? `Named in ${vRow.responsesPresent || 0} answers but cited in ${vRow.citations || 0}${(vRow.responsesPresent || 0) > (vRow.citations || 0) ? `, so ${(vRow.responsesPresent || 0) - (vRow.citations || 0)} answers mention ${view.name} using someone else’s page` : ""}.` : `${view.name} has no website on this campaign, so its own pages can't be counted.`,
  };
  const byEngine = engines.map((e) => {
    const list = recs.filter((r) => r.platform === e);
    const mm = computeMetrics(list, profile, brands).brands.find((b) => normName(b.name) === normName(view.name));
    return { id: e, label: ENGINE_LABEL[e], answers: list.length, visibility: mm ? mm.visibility : 0, avgPosition: mm ? mm.avgPosition : null };
  });

  // Data collected.
  const domains = new Set();
  let searched = 0, searches = 0;
  recs.forEach((r) => { if (r.searched) searched++; searches += queriesOf(r).length; (r.sources || []).forEach((s) => { const d = normDomain(s.domain || s.url); if (d) domains.add(d); }); });
  const collected = { answers: recs.length, runs: new Set(recs.map((r) => r.geo && r.geo.runId).filter(Boolean)).size, searched, searches, domains: domains.size };

  // Visibility across runs (the last four), for every brand.
  const lastRuns = runsAsc.filter((r) => all.some((x) => x.geo && x.geo.runId === r.id)).slice(-4);
  const acrossRuns = {
    runs: lastRuns.map((r) => ({ id: r.id, label: `Run ${runNo.get(r.id)}`, at: r.startedAt })),
    rows: brands.map((b) => {
      const cells = lastRuns.map((run) => {
        const list = all.filter((x) => x.geo && x.geo.runId === run.id);
        const mm = computeMetrics(list, profile, brands).brands.find((x) => normName(x.name) === normName(b.name));
        return list.length ? Math.round(mm ? mm.visibility : 0) : null;
      });
      const have = cells.filter((c) => c != null);
      return { name: b.name, isView: normName(b.name) === normName(view.name), cells, delta: have.length > 1 ? have[have.length - 1] - have[0] : null };
    }).sort((a, b) => (b.cells[b.cells.length - 1] || 0) - (a.cells[a.cells.length - 1] || 0)),
  };

  // Each brand on each engine.
  const heat = {
    engines: engines.map((e) => ({ id: e, label: ENGINE_LABEL[e] })),
    rows: metrics.brands.map((b) => ({
      name: b.name, isView: normName(b.name) === normName(view.name),
      cells: engines.map((e) => {
        const list = recs.filter((r) => r.platform === e);
        const mm = computeMetrics(list, profile, brands).brands.find((x) => normName(x.name) === normName(b.name));
        return list.length ? Math.round(mm ? mm.visibility : 0) : null;
      }),
    })),
  };
  heat.note = heatNote(heat, view.name);

  // By topic (the prompt tags): the viewed brand against its strongest rival.
  const topicTags = [...new Set(prompts.flatMap((p) => p.tags || []))];
  const topics = topicTags.map((t) => {
    const list = recs.filter((r) => ((r.geo && r.geo.tags) || []).includes(t));
    if (!list.length) return null;
    const mm = computeMetrics(list, profile, brands).brands;
    const you = mm.find((b) => normName(b.name) === normName(view.name));
    const rival = mm.filter((b) => normName(b.name) !== normName(view.name)).sort((a, b) => b.visibility - a.visibility)[0];
    const y = Math.round(you ? you.visibility : 0), rv = Math.round(rival ? rival.visibility : 0);
    return { tag: t, answers: list.length, you: y, rival: rival ? rival.name : "—", rivalV: rv, gap: y - rv };
  }).filter(Boolean).sort((a, b) => a.gap - b.gap);

  // What the engines recommend each brand for.
  const recommend = metrics.brands.filter((b) => b.mentions > 0).slice(0, 6).map((b) => {
    const counts = new Map();
    for (const r of recs) {
      const hit = (r.brandMentions || []).find((mm) => sameBrand(mm.brand, b.name));
      if (!hit) continue;
      extractBrandAspects(hit.passages || []).forEach((a) => counts.set(a, (counts.get(a) || 0) + 1));
    }
    return { name: b.name, isView: normName(b.name) === normName(view.name), aspects: [...counts.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4).map(([label, n]) => ({ label, n })) };
  }).filter((x) => x.aspects.length);

  // Kinds of sites cited, and the sites that cite rivals but not you.
  const ctx = { ownBrand: view.name, ownUrl: view.url || "", brands: brands.map((b) => b.name) };
  const kindAgg = new Map(KIND_GROUPS.map((g) => [g, { n: 0, you: 0, eg: new Map() }]));
  const siteAgg = new Map();
  let citedTotal = 0;
  for (const r of recs) {
    const matrix = computeBrandMatrix(r);
    const present = new Map((matrix.sources || []).map((s) => [s.sourceIdx, s.presentBrands || []]));
    (r.sources || []).forEach((s, i) => {
      if (s.outcome !== "cited") return;
      citedTotal++;
      const d = normDomain(s.domain || s.url);
      if (!d) return;
      const kind = siteKindOf(d, ctx);
      const g = kindAgg.get(kind);
      const pageBrands = (present.get(i) || []).map((n) => brands.find((b) => sameBrand(b.name, n))).filter(Boolean);
      const mentionsView = pageBrands.some((b) => normName(b.name) === normName(view.name));
      g.n++;
      if (mentionsView) g.you++;
      g.eg.set(d, (g.eg.get(d) || 0) + 1);
      if (!siteAgg.has(d)) siteAgg.set(d, { site: d, kind, cited: 0, rivals: new Set(), you: false });
      const sa = siteAgg.get(d);
      sa.cited++;
      pageBrands.forEach((b) => { if (normName(b.name) !== normName(view.name)) sa.rivals.add(b.name); });
      if (mentionsView) sa.you = true;
    });
  }
  const siteKinds = {
    total: citedTotal,
    rows: KIND_GROUPS.map((label) => {
      const g = kindAgg.get(label);
      return { label, n: g.n, you: g.you, eg: [...g.eg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d).join(", ") };
    }).filter((x) => x.n),
  };
  const gapSites = [...siteAgg.values()]
    .filter((x) => !x.you && x.rivals.size && x.kind !== "Your site" && x.kind !== "Rival brand sites")
    .sort((a, b) => b.cited - a.cited || b.rivals.size - a.rivals.size).slice(0, 10)
    .map((x) => ({ site: x.site, kind: x.kind, cited: x.cited, rivals: [...x.rivals].slice(0, 4) }));

  // The searches the engines ran.
  const qCount = new Map();
  let nameAny = 0, nameView = 0, reddit = 0, year = 0, totalQ = 0;
  for (const r of recs) {
    const { rank } = ranksIn(r, brands);
    const lead = [...rank.entries()].find(([, v]) => v === 1);
    for (const q of queriesOf(r)) {
      totalQ++;
      if (brands.some((b) => wordRe(b.name).test(q))) nameAny++;
      if (wordRe(view.name).test(q)) nameView++;
      if (/reddit/i.test(q)) reddit++;
      if (/\b20\d\d\b/.test(q)) year++;
      const kq = q.toLowerCase();
      if (!qCount.has(kq)) qCount.set(kq, { text: q, n: 0, leads: new Map() });
      const e = qCount.get(kq);
      e.n++;
      if (lead) e.leads.set(lead[0], (e.leads.get(lead[0]) || 0) + 1);
    }
  }
  const leadName = (key) => (brands.find((b) => normName(b.name) === key) || {}).name || null;
  const searchesView = {
    total: totalQ, perAnswer: recs.length ? totalQ / recs.length : 0,
    nameBrand: pct(nameAny, totalQ), nameView: pct(nameView, totalQ), reddit: pct(reddit, totalQ), year: pct(year, totalQ),
    top: [...qCount.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text)).slice(0, 12).map((e) => {
      const top = [...e.leads.entries()].sort((a, b) => b[1] - a[1])[0];
      return { text: e.text, n: e.n, lead: top ? leadName(top[0]) : null };
    }),
  };

  // Prompt by prompt: where the viewed brand came in each engine's answer.
  const promptRows = promptGrid(prompts, recs, all, { brands, view, engines, runsAsc, runNo, runId });

  return {
    view: { name: view.name, url: view.url || "", domain: dom, isOwn: !!view.isOwn },
    own: { name: own.name },
    engines: engines.map((e) => ({ id: e, label: ENGINE_LABEL[e] })),
    runLabel: curRun ? `Run ${runNo.get(curRun.id)}` : "All runs combined",
    previousLabel: prevLabel,
    focus, available, byKind, products, brandRows, mentionPool: metrics.mentionPool, asSource, byEngine, collected,
    acrossRuns, heat, topics, recommend, siteKinds, gapSites, searches: searchesView, prompts: promptRows,
  };
}

function heatNote(heat, viewName) {
  if (heat.engines.length < 2 || !heat.rows.length) return "";
  const leaders = heat.engines.map((e, i) => {
    const best = [...heat.rows].filter((r) => r.cells[i] != null).sort((a, b) => b.cells[i] - a.cells[i])[0];
    return best && best.cells[i] > 0 ? { engine: e.label, brand: best.name } : null;
  }).filter(Boolean);
  const viewLeads = leaders.filter((l) => sameBrand(l.brand, viewName)).map((l) => l.engine);
  const others = leaders.filter((l) => !sameBrand(l.brand, viewName));
  const parts = [];
  if (others.length) parts.push(others.map((l) => `${l.engine} leans to ${l.brand}`).join(" and "));
  if (viewLeads.length) parts.push(`${viewName} leads on ${viewLeads.join(" and ")}`);
  return parts.length ? parts.join("; ") + "." : "";
}

function promptGrid(prompts, recs, all, { brands, view, engines, runsAsc, runNo, runId }) {
  const key = normName(view.name);
  const dom = domainOfUrl(view.url);
  const cellOf = (r) => {
    if (!r) return null;
    const { pres, rank } = ranksIn(r, brands);
    const p = pres.find((x) => x.key === key);
    // A rank when the brand is in the text; "shown" when it is only on a
    // card or pin (present, but nothing to rank); 0 when not there at all.
    const pos = p && p.present ? rank.get(key) || "shown" : 0;
    const cited = !!dom && (r.sources || []).some((s) => s.outcome === "cited" && domainMatches(s.domain, dom));
    return { pos, cited, captureId: r.captureId };
  };
  const rows = [];
  const active = prompts.filter((p) => p.active !== false);
  active.forEach((p, i) => {
    const mine = recs.filter((r) => r.geo && r.geo.promptId === p.id);
    const latestBy = (list, e) => list.filter((r) => r.platform === e).sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
    const cells = engines.map((e) => cellOf(latestBy(mine, e)));
    const lastAt = Math.max(0, ...mine.map((r) => r.capturedAt || 0));
    // Earlier runs, newest first.
    const curRunId = runId || (mine[0] && mine[0].geo && mine[0].geo.runId);
    const history = runsAsc.filter((run) => run.id !== curRunId).reverse().map((run) => {
      const list = all.filter((r) => r.geo && r.geo.promptId === p.id && r.geo.runId === run.id);
      if (!list.length) return null;
      return { label: `Run ${runNo.get(run.id)}`, at: run.startedAt, cells: engines.map((e) => cellOf(latestBy(list, e))) };
    }).filter(Boolean).slice(0, 3);
    const nums = cells.filter((c) => c && typeof c.pos === "number");
    const best = nums.filter((c) => c.pos > 0).map((c) => c.pos);
    rows.push({
      n: i + 1, id: p.id, text: p.text, words: String(p.text || "").split(/\s+/).filter(Boolean).length, tags: p.tags || [],
      cells, citedYou: cells.filter((c) => c && c.cited).length, lastAt: lastAt || null, history,
      status: !mine.length ? "none" : best.includes(1) ? "first" : best.length ? "lower" : "not",
    });
  });
  const allPos = rows.flatMap((r) => r.cells.filter((c) => c && typeof c.pos === "number" && c.pos > 0).map((c) => c.pos));
  return {
    rows, avgWhenNamed: avg(allPos),
    counts: { all: rows.length, first: rows.filter((r) => r.status === "first").length, lower: rows.filter((r) => r.status === "lower").length, not: rows.filter((r) => r.status === "not").length },
  };
}

/* ---------- one brand against another (the brand detail) ---------- */

/**
 * A competitor ("them") against the brand viewed ("you"): the headline
 * numbers side by side, head to head across the answers, on each engine,
 * which kinds of site write about each, which sites cite one and not the
 * other, and prompt by prompt who came first.
 */
export function brandDetail(recs, { profile, brands, them, you, prompts = [], tags = [] } = {}) {
  prompts = promptsInScope(prompts, tags, recs);
  const find = (n) => brands.find((b) => normName(b.name) === normName(n || ""));
  const T = find(them);
  const Y = find(you) || brands.find((b) => b.isOwn) || null;
  if (!T || !Y || T === Y) return null;
  const tk = normName(T.name), yk = normName(Y.name);
  const engines = ENGINE_ORDER.filter((e) => recs.some((r) => r.platform === e));
  const metricsOf = (list) => {
    const mm = computeMetrics(list, profile, brands).brands;
    return { t: mm.find((b) => normName(b.name) === tk) || null, y: mm.find((b) => normName(b.name) === yk) || null };
  };
  const all = metricsOf(recs);
  const side = (field, lowerIsBetter) => {
    const a = all.t ? all.t[field] : null, b = all.y ? all.y[field] : null;
    const better = a == null || b == null || a === b ? null : (lowerIsBetter ? a < b : a > b) ? "them" : "you";
    return { them: a, you: b, better };
  };
  const kpis = [
    { label: "Visibility", unit: "%", ...side("visibility") },
    { label: "Share of voice", unit: "%", ...side("shareOfVoice") },
    { label: "Avg position", unit: "rank", ...side("avgPosition", true) },
    { label: "Citations", unit: "n", ...side("citations") },
    { label: "Source visibility", unit: "%", ...side("sourceVisibility") },
  ];

  const h = headToHead(recs, brands, T.name, Y.name);
  const h2h = {
    answers: h.responses, both: h.both, themOnly: h.aOnly, youOnly: h.bOnly, neither: h.neither,
    firstThem: h.aheadA, firstYou: h.aheadB,
    line: h.both
      ? `Both were named in ${plural(h.both, "answer")}; ${T.name} came first in ${h.aheadA} and ${Y.name} in ${h.aheadB}.`
      : `${T.name} and ${Y.name} were never named in the same answer.`,
  };

  const byEngine = engines.map((e) => {
    const list = recs.filter((r) => r.platform === e);
    const mm = metricsOf(list);
    return {
      id: e, label: ENGINE_LABEL[e], answers: list.length,
      them: { visibility: mm.t ? mm.t.visibility : 0, avgPosition: mm.t ? mm.t.avgPosition : null },
      you: { visibility: mm.y ? mm.y.visibility : 0, avgPosition: mm.y ? mm.y.avgPosition : null },
    };
  });
  const ahead = byEngine.filter((e) => e.them.visibility > e.you.visibility).map((e) => e.label);
  const behind = byEngine.filter((e) => e.them.visibility < e.you.visibility).map((e) => e.label);
  const engineLine = [ahead.length ? `${T.name} is named more on ${ahead.join(" and ")}` : "", behind.length ? `${Y.name} on ${behind.join(" and ")}` : ""].filter(Boolean).join("; ") + (ahead.length || behind.length ? "." : "");

  // Cited pages that mention each brand, by kind of site; and per site.
  const ctx = { ownBrand: Y.name, ownUrl: Y.url || "", brands: brands.map((b) => b.name) };
  const kinds = new Map(KIND_GROUPS.map((g) => [g, { them: 0, you: 0 }]));
  const sites = new Map();
  for (const r of recs) {
    const matrix = computeBrandMatrix(r);
    const present = new Map((matrix.sources || []).map((s) => [s.sourceIdx, s.presentBrands || []]));
    (r.sources || []).forEach((s, i) => {
      if (s.outcome !== "cited") return;
      const d = normDomain(s.domain || s.url);
      if (!d) return;
      const names = present.get(i) || [];
      const mt = names.some((n) => sameBrand(n, T.name)) || (T.url && domainMatches(d, domainOfUrl(T.url)));
      const my = names.some((n) => sameBrand(n, Y.name)) || (Y.url && domainMatches(d, domainOfUrl(Y.url)));
      if (!mt && !my) return;
      const kind = siteKindOf(d, { ...ctx, brands: brands.map((b) => b.name) });
      if (mt) kinds.get(kind).them++;
      if (my) kinds.get(kind).you++;
      if (!sites.has(d)) sites.set(d, { site: d, kind, them: 0, you: 0 });
      const e = sites.get(d);
      if (mt) e.them++;
      if (my) e.you++;
    });
  }
  const kindRows = KIND_GROUPS.map((label) => ({ label, ...kinds.get(label) })).filter((k) => k.them || k.you);
  const strongest = [...kindRows].sort((a, b) => (b.them - b.you) - (a.them - a.you))[0];
  const kindsLine = strongest && strongest.them > strongest.you ? `${T.name}'s lead is on ${strongest.label.toLowerCase()}: ${strongest.them} cited pages mention ${T.name}, ${strongest.you} mention ${Y.name}.` : "";
  const siteRows = [...sites.values()].map((s) => ({ ...s, verdict: s.them && !s.you ? `only ${T.name}` : s.you && !s.them ? `only ${Y.name}` : s.them > s.you ? `${T.name} more` : s.you > s.them ? `${Y.name} more` : "both" }))
    .sort((a, b) => (b.them - b.you) - (a.them - a.you) || b.them - a.them).slice(0, 14);
  const onlyThem = siteRows.filter((s) => s.them && !s.you).length;
  const gapLine = onlyThem ? `${plural(onlyThem, "site")} cite pages about ${T.name} and never one about ${Y.name}: the places to get reviewed or listed.` : `No site writes only about ${T.name}.`;

  // Prompt by prompt: who came first on each engine.
  const rows = prompts.filter((p) => p.active !== false).map((p, i) => {
    const mine = recs.filter((r) => r.geo && r.geo.promptId === p.id);
    const cells = engines.map((e) => {
      const r = mine.filter((x) => x.platform === e).sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
      if (!r) return null;
      const { pres, rank } = ranksIn(r, brands);
      const tp = pres.find((x) => x.key === tk), yp = pres.find((x) => x.key === yk);
      const tr = rank.get(tk), yr = rank.get(yk);
      const winner = tp && tp.present && yp && yp.present ? (tr && yr ? (tr < yr ? "them" : "you") : "both")
        : tp && tp.present ? "them" : yp && yp.present ? "you" : "neither";
      return { winner, them: tr || (tp && tp.present ? "shown" : 0), you: yr || (yp && yp.present ? "shown" : 0), captureId: r.captureId };
    });
    return { n: i + 1, id: p.id, text: p.text, tags: p.tags || [], cells };
  }).filter((r) => r.cells.some(Boolean));
  const count = (w) => rows.filter((r) => r.cells.some((c) => c && c.winner === w)).length;

  return {
    them: { name: T.name, isOwn: !!T.isOwn, auto: !!T.auto }, you: { name: Y.name, isOwn: !!Y.isOwn },
    engines: engines.map((e) => ({ id: e, label: ENGINE_LABEL[e] })),
    kpis, h2h, byEngine, engineLine, kinds: kindRows, kindsLine, sites: siteRows, gapLine,
    prompts: { rows, counts: { all: rows.length, them: count("them"), you: count("you") } },
  };
}
