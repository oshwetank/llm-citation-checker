/*
 * compareView.js — one prompt, several engines, side by side (0.48.0).
 *
 * The owner removed Compare from the top menu (0.47.0) because comparing
 * belongs to the answer: "it's now integrated into the analyze section only".
 * On the design canvas the full tab's Analyze shows engine tabs whenever the
 * same prompt was answered by more than one engine, plus a "Compare all"
 * view: how the answers differ in plain sentences, each engine in numbers,
 * where each brand came, which sites each engine used, and the searches each
 * engine ran. This module works all of that out as data; panel.js draws it.
 *
 * Everything reads the light capture rows (answer text is not needed), so a
 * comparison never waits on fetching four full records.
 */
import { normalizeMentions } from "./mention-list.js";
import { sameBrand } from "./funnel-omitted.js";
import { normDomain, siteKindOf } from "./siteKind.js";
import { pageTypeOf } from "./campaignView.js";
import { parseQueryOperators } from "./fanout.js";
import { normPrompt, knownVendors, answerKind } from "./analyzeView.js";

export const ENGINE_ORDER = ["chatgpt", "gemini", "perplexity", "grok"];
const LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
const ORD = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const list = (xs) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];

/**
 * The answers to compare with `rec`: one per engine, `rec` itself for its own
 * engine. A campaign answer is compared within its own run (same campaign,
 * prompt and run), because that is what a run measures; an ad-hoc answer with
 * each engine's latest ad-hoc answer to the same prompt.
 */
export function answersToPrompt(rec, records = []) {
  const byEngine = new Map([[rec.platform, rec]]);
  const g = rec.geo;
  const key = normPrompt(rec.userPrompt);
  for (const r of records) {
    if (!r || r.platform === rec.platform || !ENGINE_ORDER.includes(r.platform)) continue;
    if (g && g.profileId && g.promptId) {
      if (!r.geo || r.geo.profileId !== g.profileId || r.geo.promptId !== g.promptId) continue;
      if (g.runId && r.geo.runId !== g.runId) continue;
    } else {
      if (r.geo || !key || normPrompt(r.userPrompt) !== key) continue;
    }
    const cur = byEngine.get(r.platform);
    if (!cur || r.capturedAt > cur.capturedAt) byEngine.set(r.platform, r);
  }
  return ENGINE_ORDER.filter((e) => byEngine.has(e)).map((e) => byEngine.get(e));
}

// domain -> "cited" | "read"; a domain the engine both read and cited counts as cited.
function domainsOf(sources) {
  const m = new Map();
  for (const s of sources) {
    const d = normDomain(s.domain || s.url);
    if (!d) continue;
    if (s.outcome === "cited") m.set(d, "cited");
    else if (!m.has(d)) m.set(d, "read");
  }
  return m;
}

function mentionsOf(rec) {
  return normalizeMentions(rec.brandMentions || [], knownVendors(rec)).filter((b) => b.count > 0);
}
function named(rec) {
  return mentionsOf(rec).map((b) => b.brand);
}
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const normName = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function queries(rec) {
  return [].concat((rec.fanout && rec.fanout.search) || [], (rec.fanout && rec.fanout.shopping) || [], (rec.fanout && rec.fanout.image) || [])
    .map((q) => (typeof q === "string" ? q : q && q.query)).filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim());
}

const words = (q) => new Set(q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

/**
 * @param {object[]} answers  one capture per engine (answersToPrompt)
 * @param {{ own?: {name:string} }} opts
 */
export function compareView(answers, { own } = {}) {
  const kindCtx = own ? { ownBrand: own.name, ownUrl: own.url || "" } : {};
  const engines = answers.map((r) => {
    const n = named(r);
    const ments = mentionsOf(r);
    const sources = r.sources || [];
    const cited = sources.filter((s) => s.outcome === "cited");
    const qs = queries(r);
    return {
      id: r.platform, label: LABEL[r.platform] || r.platform, captureId: r.captureId, capturedAt: r.capturedAt,
      named: n, first: n[0] || null, brands: n.length,
      searched: !!r.searched, searches: queries(r), read: sources.length, cited: cited.length,
      kind: answerKind(r).label,
      had: [(r.products || []).length ? "product cards" : null, (r.places || []).length ? "a map" : null, (r.images || []).length >= 3 ? "images" : null].filter(Boolean),
      domains: domainsOf(sources),
      // Ads shown with the answer (0.60.0). Only ChatGPT has an ad format;
      // the others never show one, which is not the same as "no ad this time".
      ads: [...new Set((r.ads || []).map((a) => String(a.advertiser || a.targetDomain || "").trim()).filter(Boolean))],
      adFormat: r.platform === "chatgpt",
      // 0.68.0: the detail the side by side shows (asked for "much more
      // information, a lot like in campaign").
      chars: r.answerChars || 0,
      mentions: Object.fromEntries(ments.map((b) => [b.brand, b.count])),
      mentionTotal: ments.reduce((a, b) => a + b.count, 0),
      citations: cited.map((s, i) => ({ n: i + 1, url: String(s.url || ""), title: String(s.title || "").trim() || normDomain(s.domain || s.url), domain: normDomain(s.domain || s.url), kind: siteKindOf(s.domain || s.url, kindCtx), pageType: pageTypeOf(s.url) })),
      products: (r.products || []).map((c, i) => ({ name: String(c.name || "").trim(), price: c.price || null, merchant: c.merchant || (c.merchants && c.merchants[0]) || null, i })).filter((c) => c.name),
      siteSearches: qs.filter((q) => { const o = parseQueryOperators(q); return o.siteIncludes.length || o.siteExcludes.length; }).length,
      avgWords: qs.length ? Math.round((qs.reduce((a, q) => a + q.split(/\s+/).filter(Boolean).length, 0) / qs.length) * 10) / 10 : 0,
    };
  });
  // Where each brand came, in every answer.
  const allBrands = [];
  engines.forEach((e) => e.named.forEach((b) => { if (!allBrands.some((x) => sameBrand(x, b))) allBrands.push(b); }));
  const brandGrid = allBrands.map((b) => {
    const cells = engines.map((e) => {
      const i = e.named.findIndex((x) => sameBrand(x, b));
      return i < 0 ? null : i + 1;
    });
    const hits = cells.filter((c) => c != null);
    const count = (e) => { const k = Object.keys(e.mentions).find((x) => sameBrand(x, b)); return k ? e.mentions[k] : 0; };
    const mentions = engines.map(count);
    return { name: b, isYou: !!own && sameBrand(own.name, b), cells, namedBy: hits.length, avg: hits.length ? hits.reduce((a, c) => a + c, 0) / hits.length : 99,
      mentions, share: engines.map((e, i) => pctOf(mentions[i], e.mentionTotal)), firsts: cells.filter((c) => c === 1).length };
  }).sort((a, b) => b.namedBy - a.namedBy || a.avg - b.avg);

  // Which sites each engine used.
  const allDomains = new Set();
  engines.forEach((e) => e.domains.forEach((_, d) => allDomains.add(d)));
  const siteGrid = [...allDomains].map((d) => {
    const cells = engines.map((e) => e.domains.get(d) || null);
    const pages = engines.map((e) => e.citations.filter((c) => c.domain === d).length);
    return { domain: d, kind: siteKindOf(d, kindCtx), cells, pages, citedBy: cells.filter((c) => c === "cited").length, readBy: cells.filter(Boolean).length };
  }).sort((a, b) => b.citedBy - a.citedBy || b.readBy - a.readBy || a.domain.localeCompare(b.domain));

  // Searches each engine ran; a search another engine also ran is marked.
  const searchRows = engines.map((e, i) => ({
    id: e.id, label: e.label, searched: e.searched,
    queries: e.searches.map((q) => ({ text: q, shared: engines.some((o, j) => j !== i && o.searches.some((x) => similar(x, q))) })),
  }));

  // How the answers differ, in sentences.
  const diffs = [];
  if (engines.length > 1) {
    const byFirst = new Map();
    engines.forEach((e) => {
      const k = e.first || "";
      if (!byFirst.has(k)) byFirst.set(k, []);
      byFirst.get(k).push(e.label);
    });
    const parts = [...byFirst.entries()].map(([b, es]) => b ? `${list(es)} named ${b} first` : `${list(es)} named no brand`);
    diffs.push({ k: "Who came first", v: byFirst.size === 1 && engines[0].first ? `All ${engines.length} named ${engines[0].first} first.` : parts.join("; ") + "." });
    const everywhere = brandGrid.filter((b) => b.namedBy === engines.length).map((b) => b.name);
    const once = brandGrid.filter((b) => b.namedBy === 1).map((b) => `${b.name} (${engines[b.cells.findIndex((c) => c != null)].label})`);
    diffs.push({ k: "Agreement", v: (everywhere.length ? `Named by all ${engines.length}: ${list(everywhere)}.` : `No brand was named by all ${engines.length}.`) + (once.length ? ` Named by one engine only: ${list(once.slice(0, 5))}${once.length > 5 ? ` and ${once.length - 5} more` : ""}.` : "") });
    const shared = siteGrid.filter((s) => s.citedBy > 1);
    const solo = siteGrid.filter((s) => s.citedBy === 1).length;
    diffs.push({ k: "Sources", v: shared.length ? `Cited by more than one engine: ${list(shared.slice(0, 4).map((s) => `${s.domain} (${s.citedBy})`))}. ${solo} site${solo === 1 ? " was" : "s were"} cited by one engine only.` : `No site was cited by more than one engine${solo ? `; each cited its own ${solo === 1 ? "site" : "sites"}` : ""}.` });
    const withSearch = engines.filter((e) => e.searches.length);
    const unpublished = engines.filter((e) => e.searched && !e.searches.length).map((e) => e.label);
    if (withSearch.length) {
      const most = withSearch.reduce((a, e) => (e.searches.length > a.searches.length ? e : a));
      const least = withSearch.reduce((a, e) => (e.searches.length < a.searches.length ? e : a));
      diffs.push({ k: "Searching", v: (most === least ? `${most.label} ran ${most.searches.length} search${most.searches.length === 1 ? "" : "es"}.` : `${most.label} searched most (${most.searches.length}); ${least.label} least (${least.searches.length}).`) + (unpublished.length ? ` ${list(unpublished)} searched without publishing what for.` : "") });
    }
    const memory = engines.filter((e) => !e.searched && !e.read).map((e) => e.label);
    if (memory.length) diffs.push({ k: "From memory", v: `${list(memory)} answered without searching the web.` });
    const withAds = engines.filter((e) => e.ads.length);
    if (withAds.length) {
      const none = engines.filter((e) => e.adFormat && !e.ads.length).map((e) => e.label);
      const noFormat = engines.filter((e) => !e.adFormat).map((e) => e.label);
      diffs.push({ k: "Ads", v: withAds.map((e) => `${e.label} showed an ad from ${list(e.ads)}`).join("; ") + "."
        + (none.length ? ` ${list(none)} showed none.` : "")
        + (noFormat.length ? ` ${list(noFormat)} ${noFormat.length === 1 ? "has" : "have"} no ad format.` : "") });
    }
    if (own) {
      const row = brandGrid.find((b) => b.isYou);
      const firsts = row ? row.cells.filter((c) => c === 1).length : 0;
      diffs.push({ k: own.name, v: row ? `Named by ${row.namedBy} of ${engines.length}; first in ${firsts}.` : `Not named by any of the ${engines.length} engines.` });
    }
  }

  const table = engines.map((e) => ({
    id: e.id, label: e.label, captureId: e.captureId,
    first: e.first || "—", had: e.had, brands: e.brands, searches: e.searched ? (e.searches.length || "not published") : "none",
    read: e.read, cited: e.cited, kind: e.kind,
    stat: e.first ? `${e.first} first · ${e.cited} cited` : `${e.brands} brands · ${e.cited} cited`,
    ads: e.ads, adFormat: e.adFormat,
    model: (answers.find((r) => r.captureId === e.captureId) || {}).model || "",
  }));
  // Kinds of site each engine cited.
  const KINDS = ["Your site", "Review sites", "Retailers", "Rival brand sites", "Forums & social", "Other"];
  const kindMix = engines.map((e) => ({ id: e.id, label: e.label, total: e.citations.length,
    parts: KINDS.map((k) => ({ label: k, n: e.citations.filter((c) => (KINDS.includes(c.kind) ? c.kind : "Other") === k).length })).filter((x) => x.n) }));
  // Product cards, matched across engines by name.
  const pmap = new Map();
  engines.forEach((e, i) => e.products.forEach((c) => {
    const k = normName(c.name);
    if (!pmap.has(k)) pmap.set(k, { name: c.name, cells: engines.map(() => null) });
    const row = pmap.get(k);
    if (!row.cells[i]) row.cells[i] = { price: c.price, merchant: c.merchant, place: c.i + 1 };
  }));
  const productGrid = [...pmap.values()].map((x) => ({ ...x, shownBy: x.cells.filter(Boolean).length }))
    .sort((a, b) => b.shownBy - a.shownBy || Math.min(...a.cells.filter(Boolean).map((c) => c.place)) - Math.min(...b.cells.filter(Boolean).map((c) => c.place)));
  // How far the answers agree.
  const n = engines.length;
  const overlap = {
    brandsAll: brandGrid.filter((b) => b.namedBy === n).length, brands: brandGrid.length,
    sitesShared: siteGrid.filter((x) => x.citedBy > 1).length, sitesCited: siteGrid.filter((x) => x.citedBy > 0).length,
    sameFirst: n > 1 && engines.every((e) => e.first && sameBrand(e.first, engines[0].first || "")),
    searchesShared: searchRows.reduce((a, r) => a + r.queries.filter((q) => q.shared).length, 0),
    productsShared: productGrid.filter((p) => p.shownBy > 1).length, products: productGrid.length,
  };
  const detail = engines.map((e) => ({ id: e.id, label: e.label, chars: e.chars, mentionTotal: e.mentionTotal, citations: e.citations, products: e.products.length,
    searches: e.searches.length, siteSearches: e.siteSearches, avgWords: e.avgWords }));
  return { engines: table, brandGrid, siteGrid, searchRows, diffs, kindMix, productGrid, overlap, detail };
}
