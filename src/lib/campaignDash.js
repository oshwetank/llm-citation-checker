/*
 * campaignDash.js — the campaign dashboard (1.0.6), the "extended layout" the
 * owner approved on the design canvas: a menu of pages (Visibility, Sources,
 * Answers, Go deeper), one filter bar, and every number with what it is out
 * of. It works from one run up: a section that needs more runs than the
 * campaign has is greyed out and says how many it needs.
 *
 * Two halves, both pure:
 *   dashRecords()  runs in the background worker. It reads the stored answers
 *                  (which carry the answer text, needed for rank and brand
 *                  presence) and turns each into a small row: brands named
 *                  and where, sources cited and read, searches, cards, ads,
 *                  images, pins. The panel gets the rows once per campaign.
 *   dashModel()    runs in the panel on those rows, for whatever the filters,
 *                  tabs and sorts are, so none of them needs a round trip.
 *                  It returns everything ui/campaignDash.js draws.
 *
 * Numbers follow the definitions in glossary.js and geo.js computeMetrics():
 * Visibility counts answers naming the brand, Share of voice its mentions
 * among the tracked brands', Position its order of first appearance in the
 * text (answers that show it only as a card have no position), Citations the
 * answers that linked its own site. Failed answers and usage limits are never
 * counted (answerKind "noanswer").
 */
import { brandPresence, normName, domainOfUrl, domainMatches, usageLimitOf } from "./geo.js";
import { cardIsBrand } from "./campaignBoard.js";
import { siteKindOf, normDomain, KIND_GROUPS } from "./siteKind.js";
import { answerKind, adsView } from "./analyzeView.js";
import { pageTypeOf, themeIdOf, themeLabel, THEMES, THEME_OTHER, promptText } from "./campaignView.js";
import { BRAND_MARKS, brandSlug, letterBadge } from "./logos.js";
import { parsePrice, formatMoney } from "./money.js";
import { classifyQuery, parseQueryOperators, titleMatchesQueries } from "./fanout.js";
import { wordRe } from "./textMatch.js";

/* ---------- engines: the same marks the extension draws (ui/panel.js ENGINE_ICON_SVG) ---------- */
export const DASH_ENGINES = [
  { id: "chatgpt", label: "ChatGPT", color: "#12796d", fan: true, shop: true, st: "fill:currentColor", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  { id: "gemini", label: "Gemini", color: "#2b72bc", fan: false, shop: true, st: "fill:url(#cd-gem)", d: "M12 24A14.304 14.304 0 0 0 0 12A14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12a14.305 14.305 0 0 0-12 12" },
  { id: "perplexity", label: "Perplexity", color: "#7a52c7", fan: true, shop: false, st: "fill:#20808D", d: "M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z" },
  { id: "grok", label: "Grok", color: "#6b7280", fan: true, shop: false, st: "fill:currentColor; fill-rule:evenodd", d: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" },
  // AI Mode: the extension's own plain mark (a search glass with a spark), not Google's logo.
  { id: "aimode", label: "AI Mode", color: "#b45309", fan: true, shop: true, st: "fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round", d: "M16 10a6 6 0 1 1-12 0a6 6 0 1 1 12 0ZM14.5 14.5 20 20M10 7.5v5M7.5 10h5" },
];
const ENG_BY = new Map(DASH_ENGINES.map((e) => [e.id, e]));
const engOf = (id) => ENG_BY.get(id) || { id, label: id, color: "#6b7280", fan: true, shop: false, st: "fill:currentColor", d: "M4 4h16v16H4z" };

// Brand series colours (charts), the validated categorical order; the brand being viewed is drawn in the accent.
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#d99a00", "#e87ba4", "#0e7490", "#9c2f5f", "#64748b", "#4a3aa7", "#8a6d3b"];
const KINDC = { "Your site": "var(--kind-you)", "Rival brand sites": "var(--kind-rival)", "Review sites": "var(--kind-review)", "Retailers": "var(--kind-retail)", "Forums & social": "var(--kind-forum)", "Public & reference": "var(--kind-public)", "Other": "var(--kind-other)" };
const KINDS = [["shopping", "Shopping", "var(--ak-shopping)"], ["info", "Informational", "var(--ak-info)"], ["images", "Image-led", "var(--ak-images)"], ["memory", "From memory", "var(--ak-memory)"], ["local", "Local", "var(--ak-local)"]];
const TAGC = ["#2a78d6", "#eb6834", "#1baf7a", "#d99a00", "#e87ba4", "#0e7490", "#9c2f5f", "#64748b"];
const PROXY_HOSTS = /(^|\.)(images\.openai\.com|gstatic\.com|googleusercontent\.com|bing\.net|perplexity\.ai|x\.ai|grok\.com)$/i;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dlab = (t) => { const d = new Date(t); return d.getDate() + " " + MON[d.getMonth()]; };

/* ---------- formatting ---------- */
const f0 = (v) => (v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("en-US"));
const fp = (v) => (v == null || !Number.isFinite(v) ? "—" : (v !== 0 && Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + "%");
const f1 = (v) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(1));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (a, b) => (b ? (a / b) * 100 : 0);
const ageLabel = (d) => (d == null ? "—" : d < 31 ? Math.max(0, Math.round(d)) + " days" : d < 366 ? Math.round(d / 30.4) + " months" : (d / 365).toFixed(1) + " years");
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function dlt(cur, prev, kind) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return { t: "", c: "none" };
  const d = cur - prev; const better = kind === "pos" || kind === "nbad" || kind === "ptsbad" ? d < 0 : d > 0;
  if (kind === "pos" ? Math.abs(d) < 0.05 : Math.abs(d) < 0.5) return { t: "= no change", c: "same" };
  const size = kind === "pts" || kind === "ptsbad" ? Math.round(Math.abs(d)) + " pts" : kind === "pos" ? Math.abs(d).toFixed(1) : f0(Math.abs(d));
  return { t: (d > 0 ? "▲ " : "▼ ") + size, c: better ? "up" : "down" };
}
const wilson = (k, n) => { if (!n) return null; const z = 1.96, p = k / n, den = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / den, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den; return [Math.max(0, c - h) * 100, Math.min(1, c + h) * 100]; };
const marg = (k, n) => { const c = wilson(k, n); return c ? "±" + Math.max(1, Math.round((c[1] - c[0]) / 2)) + " pts" : ""; };
const noisy = (d, k1, n1, k0, n0) => { if (!d || d.c === "none" || k0 == null || !n0 || !n1) return d; const a = wilson(k1, n1), b = wilson(k0, n0); const h = Math.sqrt(Math.pow((a[1] - a[0]) / 2, 2) + Math.pow((b[1] - b[0]) / 2, 2)); return Math.abs((k1 / n1) * 100 - (k0 / n0) * 100) < h ? { t: d.t + " · within noise", c: "same" } : d; };
const heatC = (v) => { if (v == null) return { bg: "transparent", fg: "var(--fg-muted)" }; const a = Math.round(6 + v * 0.9); return { bg: `color-mix(in srgb, var(--accent) ${a}%, transparent)`, fg: a > 55 ? "var(--accent-fg)" : "var(--fg-primary)" }; };
const gauge = (v) => `conic-gradient(var(--accent) 0 ${Math.max(0, Math.min(100, v || 0))}%, var(--line-soft) 0 100%)`;

/* ---------- background half: stored answers → dashboard rows ---------- */

// "Reliance Digital + others" -> "Reliance Digital".
const firstMerchant = (p) => String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x))[0] || "";
const sentences = (text) => String(text || "").replace(/\[\[cite:[^\]]*\]\]/g, "").replace(/[*#_`>|]/g, " ").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/);

/**
 * @param {object[]} records  a campaign's answers (full records, with answerText), runs still going left out
 * @param {object} o  brands (tracked + inferred, own flagged), prompts (tracked prompts), runs (finished runs)
 * @returns {object} the rows and the campaign's context, as the panel's dashModel() reads them
 */
export function dashRecords(records, { brands = [], prompts = [], runs = [], engines = [] } = {}) {
  const runsAsc = [...runs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const runIx = new Map(runsAsc.map((r, i) => [r.id, i]));
  const pr = prompts.map((p) => ({ id: p.id, text: promptText(p.text || ""), tags: (p.tags || []).filter(Boolean) }));
  const prIx = new Map(pr.map((p, i) => [p.id, i]));
  const bl = brands.map((b) => ({ id: normName(b.name), name: b.name, url: b.url || "", domain: domainOfUrl(b.url) || "", isOwn: !!b.isOwn, auto: !!b.auto }));
  const rows = [];
  for (const rec of records) {
    const run = runIx.get(rec.geo && rec.geo.runId);
    if (run == null) continue;
    const kind = answerKind(rec).id;
    if (kind === "noanswer" || usageLimitOf(rec)) continue;
    let p = prIx.get(rec.geo && rec.geo.promptId);
    if (p == null) { pr.push({ id: (rec.geo && rec.geo.promptId) || `x${pr.length}`, text: promptText(rec.userPrompt || ""), tags: (rec.geo && rec.geo.tags) || [] }); p = pr.length - 1; prIx.set(pr[p].id, p); }
    // Brands named and where: rank by first appearance in the text, as computeMetrics() ranks them.
    const pres = brandPresence(rec, brands).map((x, i) => ({ ...x, id: bl[i].id })).filter((x) => x.present);
    const ranked = pres.filter((x) => x.firstIndex != null).sort((a, b) => a.firstIndex - b.firstIndex);
    const rankOf = new Map(ranked.map((x, i) => [x.id, i + 1]));
    const named = pres.map((x) => ({ id: x.id, rank: rankOf.get(x.id) || null, m: x.mentions })).sort((a, b) => (a.rank || 99) - (b.rank || 99));
    const snips = {};
    if (named.length) {
      const ss = sentences(rec.answerText);
      for (const x of named) { const b = bl.find((y) => y.id === x.id); const s = ss.find((t) => wordRe(b.name).test(t)); if (s) snips[x.id] = s.trim().slice(0, 240); }
    }
    const at = rec.capturedAt || 0;
    const sources = (rec.sources || []).map((s, i) => {
      const d = normDomain(s.domain || s.url);
      const url = String(s.url || "").replace(/#.*$/, "");
      const ps = s.platformSpecific || {};
      const pub = typeof ps.pubDate === "number" && ps.pubDate > 0 ? (ps.pubDate < 1e12 ? ps.pubDate * 1000 : ps.pubDate) : null;
      const sub = (url.match(/reddit\.com\/r\/([^/?#]+)/i) || [])[1];
      return { d, url: url.replace(/^https?:\/\/(www\.)?/, ""), title: String(s.title || "").trim().slice(0, 200) || d, cited: s.outcome === "cited", pos: i + 1, sub: sub ? "r/" + sub : null, yt: /(^|\.)(youtube\.com|youtu\.be)$/.test(d), age: pub && at ? Math.max(0, (at - pub) / 864e5) : null };
    }).filter((s) => s.d);
    const products = (rec.products || []).map((x, i) => {
      const b = bl.find((y) => cardIsBrand(x, y.name));
      const price = parsePrice(x.price);
      return { name: String(x.name || "").trim(), brand: b ? b.id : null, price: price ? price.amount : null, cur: price ? price.currency || "" : "", merchant: firstMerchant(x), pos: i + 1 };
    }).filter((x) => x.name);
    const queries = [].concat(((rec.fanout || {}).search) || [], ((rec.fanout || {}).shopping) || [], ((rec.fanout || {}).image) || [])
      .map((q) => String(typeof q === "string" ? q : (q && q.query) || "").trim()).filter(Boolean);
    const ads = (rec.ads || []).length ? adsView(rec, { knownBrands: brands.map((b) => b.name) }).map((a) => {
      const b = bl.find((y) => normName(a.advertiser).startsWith(y.id) && y.id);
      return { adv: a.advertiser, brand: b ? b.id : null, named: !!a.namedInAnswer, cited: !!a.siteCited };
    }) : [];
    const images = (rec.images || []).map((im) => {
      const host = normDomain(im.source || im.pageUrl || im.attribution || "");
      const b = bl.find((y) => wordRe(y.name).test(String(im.title || "")));
      return { host: host && !PROXY_HOSTS.test(host) ? host : null, brand: b ? b.id : null };
    });
    const places = (rec.places || []).map((pl, i) => {
      const b = bl.find((y) => wordRe(y.name).test(String(pl.name || "")));
      const site = normDomain(pl.website || "");
      return { name: String(pl.name || "").trim(), rating: Number(pl.rating) || null, pos: i + 1, brand: b ? b.id : null, site: !!(b && b.domain && site && domainMatches(site, b.domain)) };
    }).filter((x) => x.name);
    rows.push({ id: rec.captureId, run, p, e: rec.platform, tags: (rec.geo && rec.geo.tags && rec.geo.tags.length ? rec.geo.tags : pr[p].tags) || [], kind, brands: named, sources, products, queries, ads, images, places, snips });
  }
  // Only runs with answers count as runs: a run that captured nothing would be an empty point on every chart.
  const used = [...new Set(rows.map((r) => r.run))].sort((a, b) => a - b);
  const re = new Map(used.map((old, i) => [old, i]));
  rows.forEach((r) => { r.run = re.get(r.run); });
  const tags = [...new Set(pr.flatMap((p) => p.tags))];
  const engs = DASH_ENGINES.map((e) => e.id).filter((id) => engines.includes(id) || rows.some((r) => r.e === id));
  return { brands: bl, prompts: pr, tags, engines: engs, runs: used.map((i) => ({ id: runsAsc[i].id, startedAt: runsAsc[i].startedAt || 0 })), recs: rows };
}

/** The snippet for answer search: the background reads the answer text, the panel shows it. */
export function dashSearch(records, q, limit = 300) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const r of records) {
    const text = String(r.answerText || "").replace(/\[\[cite:[^\]]*\]\]/g, "").replace(/\s+/g, " ");
    const i = text.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    out.push({ id: r.captureId, pre: text.slice(Math.max(0, i - 80), i), hit: text.slice(i, i + needle.length), post: text.slice(i + needle.length, i + needle.length + 120) });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------- panel half: rows + filters → what the page draws ---------- */

export const DASH_PAGES = [
  ["Visibility", [["overview", "Overview"], ["prompts", "Prompt rankings"], ["gaps", "Gaps"], ["tags", "Tags"]]],
  ["Sources", [["citations", "Your site"], ["sources", "Source analysis"], ["community", "Reddit & YouTube"], ["impact", "Source impact"]]],
  ["Answers", [["products", "Products & shopping"], ["searches", "Engine searches"], ["search", "Answer search"]]],
  ["Go deeper", [["h2h", "Head to head"], ["changes", "Run vs run"], ["compset", "Competitive set"], ["stability", "Agreement & stability"], ["funnel", "Read → cited → named"], ["content", "Content & freshness"], ["surfaces", "Ads, images & local"], ["intent", "Search intent"], ["social", "Social vs web"], ["exclusive", "Engine-only sites"]]],
];
export const DASH_PAGE_IDS = DASH_PAGES.flatMap(([, items]) => items.map(([id]) => id));
const NAVICON = {
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", prompts: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", gaps: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", tags: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  citations: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20", sources: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7", community: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", impact: "M22 12h-4l-3 9L9 3l-3 9H2",
  products: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0", searches: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35", search: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M11.5 17a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM13.3 16.3 15 18",
  h2h: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5", changes: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2", compset: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  stability: "M12 3v18M7 21h10M3 7h18M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z", funnel: "M3 4h18l-7 9v6l-4 2v-8z", content: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  surfaces: "M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6", intent: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z", social: "M17 8h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v4l-4-4H9a2 2 0 0 1-2-2v-1M15 4H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2v4l4-4h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z", exclusive: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
};

export const DASH_DEFAULTS = () => ({ page: "overview", run: "latest", cmp: "prev", engines: null, tags: [], intents: [], kinds: [], view: null, open: null, metric: "vis", gran: "run", hidden: {}, sort: {}, pg: {}, tab: {}, drawer: null, q: "", pinned: false, cols: { tag: true, intent: true, engines: true, runs: true, pos: true, cited: true, first: true }, kindOff: {}, rival: null, runA: null, runB: null });

// A brand's tile: its Simple Icons mark on its own colour (logos.js), else a letter badge, as the extension draws them.
function brandTile(b) {
  const slug = b && brandSlug(b.name);
  const m = slug && BRAND_MARKS[slug];
  if (m) { const n = parseInt(m[1], 16); const light = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 186; return { color: light ? "#1f2328" : "#" + m[1], ini: "", d: m[2], sc: "" }; }
  const l = letterBadge((b && b.name) || "?");
  return { color: l.bg, ini: l.letter, d: "", sc: "no" };
}
const firstOf = (r) => r.brands.find((x) => x.rank === 1) || null;

/**
 * @param {object} data  dashRecords()'s output (plus `search`: { q, hits } once an answer search came back)
 * @param {object} S     the page's state (DASH_DEFAULTS() and what the reader changed)
 * @param {object} act   { set(patch), toast(msg), openCapture(id) }
 */
export function dashModel(data, S0, act) {
  const S = Object.assign(DASH_DEFAULTS(), S0 || {});
  const set = (p) => act.set(p);
  const NR = Math.max(1, data.runs.length);
  const RUNS = data.runs;
  const BR = data.brands.map((b, i) => ({ ...b, color: PALETTE[i % PALETTE.length] }));
  const own = BR.find((b) => b.isOwn) || BR[0] || { id: "", name: "", domain: "" };
  const bOf = (id) => BR.find((b) => b.id === id) || null;
  const view = bOf(S.view) || own;
  const ownDom = view.domain;
  const PROMPTS = data.prompts;
  const TAGS = data.tags;
  const ENGS = data.engines.map(engOf);
  const engs = (S.engines && S.engines.length ? S.engines : data.engines).filter((e) => data.engines.includes(e));
  const engsX = ENGS.filter((e) => engs.includes(e.id));
  const emk = (e) => ({ label: e.label, d: e.d, st: e.st });
  const engMark = (id) => { const e = engOf(id); return { label: e.label, d: e.d, st: e.st }; };
  const lg = brandTile;
  const ptext = (p) => (PROMPTS[p] ? PROMPTS[p].text : "");
  const ptag = (r) => (r.tags && r.tags[0]) || (PROMPTS[r.p] && PROMPTS[r.p].tags[0]) || "—";
  const intentOfP = (p) => themeIdOf(ptext(p));

  // Kinds of site and brand of each site, for the brand being viewed (its site is "Your site").
  const kctx = { ownBrand: view.name, ownUrl: view.url || "", brands: BR.map((b) => b.name) };
  const kindCache = new Map(), siteBrand = new Map();
  const kindOf = (d) => { if (!kindCache.has(d)) kindCache.set(d, siteKindOf(d, kctx)); return kindCache.get(d); };
  const brandOfSite = (d) => { if (!siteBrand.has(d)) { const b = BR.find((x) => x.domain && domainMatches(d, x.domain)); siteBrand.set(d, b ? b.id : null); } return siteBrand.get(d); };
  for (const r of data.recs) for (const s of r.sources) { s.k = kindOf(s.d); s.b = brandOfSite(s.d); }

  // Normalise the state to what this campaign has.
  if (S.run !== "latest" && S.run !== "all" && S.run !== "last4" && !(+S.run >= 0 && +S.run < NR)) S.run = "latest";
  if (S.run === "last4" && NR < 5) S.run = "latest";
  if (S.cmp !== "prev" && S.cmp !== "none" && !(+S.cmp >= 0 && +S.cmp < NR)) S.cmp = "prev";
  const weekKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const bucketsOf = (gran) => {
    if (gran === "run") return RUNS.map((r, i) => ({ label: dlab(r.startedAt), runs: [i] }));
    const map = new Map();
    RUNS.forEach((r, i) => { const key = gran === "week" ? weekKey(r.startedAt) : new Date(r.startedAt).getFullYear() * 12 + new Date(r.startedAt).getMonth(); const label = gran === "week" ? "Wk " + dlab(key) : MON[new Date(r.startedAt).getMonth()] + " " + new Date(r.startedAt).getFullYear(); if (!map.has(key)) map.set(key, { label, runs: [] }); map.get(key).runs.push(i); });
    return [...map.values()];
  };
  const nW = bucketsOf("week").length, nM = bucketsOf("month").length;
  if ((S.gran === "week" && nW < 2) || (S.gran === "month" && nM < 2)) S.gran = "run";
  const gateOf = (need, what) => { const on = NR < need; const more = need - NR; return { on, off: !on, cls: on ? "locked" : "", badge: "Opens after " + need + " runs", msg: what + " opens once the campaign has " + need + " runs. It has " + NR + (NR === 1 ? " run" : " runs") + " so far: run it " + (more === 1 ? "once more." : more + " more times.") }; };
  const LOCK = { trend: gateOf(2, "This chart"), moved: gateOf(2, "What moved"), history: gateOf(2, "Prompt history"), flips: gateOf(3, "The flip rate"), prices: gateOf(2, "Prices over time"), changes: gateOf(2, "Run vs run"), cmp: gateOf(2, "Compare to"), newth: gateOf(2, "“New this period”"), last4: gateOf(5, "“Last 4 runs”") };
  const page = DASH_PAGE_IDS.includes(S.page) ? S.page : "overview";

  // Answers in view, and the ones they are compared with.
  const baseNoKind = (r) => engs.includes(r.e) && (!S.tags.length || r.tags.some((t) => S.tags.includes(t))) && (!S.intents.length || S.intents.includes(intentOfP(r.p)));
  const base = (r) => baseNoKind(r) && (!S.kinds.length || S.kinds.includes(r.kind));
  const pick = (list) => {
    const pair = (r) => r.p + "|" + r.e;
    if (S.run === "latest") {
      const best = new Map(); list.forEach((r) => { const k = pair(r); const b = best.get(k); if (!b || r.run > b.run) best.set(k, r); });
      const now = [...best.values()];
      let prev = null;
      if (S.cmp === "prev") { const pb = new Map(); list.forEach((r) => { const k = pair(r); const top = best.get(k); if (r.run >= top.run) return; const b = pb.get(k); if (!b || r.run > b.run) pb.set(k, r); }); prev = [...pb.values()]; }
      return { now, prev };
    }
    let vr;
    if (S.run === "all") vr = RUNS.map((_, i) => i); else if (S.run === "last4") vr = [NR - 4, NR - 3, NR - 2, NR - 1]; else vr = [+S.run];
    const now = list.filter((r) => vr.includes(r.run));
    let prev = null;
    if (S.cmp === "prev" && S.run !== "all") { const k = vr.length, first = vr[0]; if (first - k >= 0) { const pr = []; for (let i = first - k; i < first; i++) pr.push(i); prev = list.filter((r) => pr.includes(r.run)); } }
    return { now, prev };
  };
  const filtered = data.recs.filter(base);
  const sel = pick(filtered);
  const now = sel.now;
  let prev = sel.prev;
  const vr = new Set(now.map((r) => r.run));
  if (S.cmp !== "prev" && S.cmp !== "none") { const c = +S.cmp; prev = vr.has(c) ? null : filtered.filter((r) => r.run === c); }
  if (S.cmp === "none") prev = null;
  if (prev && !prev.length) prev = null;
  const crA = prev ? [...new Set(prev.map((r) => r.run))].sort((a, b) => a - b) : null;
  const byRun = RUNS.map((_, i) => filtered.filter((r) => r.run === i));
  const runIdx = [...vr].sort((a, b) => a - b);
  const runSpan = (xs) => (xs.length === 1 ? "Run " + (xs[0] + 1) : "Runs " + (xs[0] + 1) + "–" + (xs[xs.length - 1] + 1));

  const metrics = (recs) => {
    const n = recs.length; const acc = {}; BR.forEach((b) => { acc[b.id] = { present: 0, m: 0, pos: [], cit: 0, src: 0 }; }); let pool = 0;
    for (const r of recs) {
      for (const x of r.brands) { const a = acc[x.id]; if (!a) continue; a.present++; a.m += x.m; if (x.rank != null) a.pos.push(x.rank); pool += x.m; }
      const sv = new Set(), cv = new Set(); for (const s of r.sources) if (s.b) { sv.add(s.b); if (s.cited) cv.add(s.b); }
      sv.forEach((b) => acc[b] && acc[b].src++); cv.forEach((b) => acc[b] && acc[b].cit++);
    }
    const out = {}; BR.forEach((b) => { const a = acc[b.id]; out[b.id] = { vis: n ? pct(a.present, n) : null, sov: pool ? pct(a.m, pool) : null, m: a.m, present: a.present, pos: avg(a.pos), cit: a.cit, srcVis: n ? pct(a.src, n) : null }; });
    return { n, pool, b: out };
  };
  const M = metrics(now); const MP = prev ? metrics(prev) : null;
  const me = M.b[view.id] || { vis: null, sov: null, m: 0, present: 0, pos: null, cit: 0, srcVis: null }; const mp = MP ? MP.b[view.id] : null;
  const n = M.n, nameN = me.present;
  const latestIn = runIdx.length > 1 ? "Latest answers · " + runSpan(runIdx) : RUNS[runIdx[0]] ? "Run " + (runIdx[0] + 1) + " · " + dlab(RUNS[runIdx[0]].startedAt) : "No answers";
  const runLabel = S.run === "latest" ? (runIdx.length > 1 ? "Latest answers" : "Latest run · " + (RUNS[NR - 1] ? dlab(RUNS[NR - 1].startedAt) : "")) : S.run === "last4" ? "Last 4 runs" : S.run === "all" ? (NR === 1 ? "All runs (1)" : "All " + NR + " runs") : "Run " + (+S.run + 1) + " · " + dlab(RUNS[+S.run].startedAt);
  const cmpLabel = crA ? runSpan(crA) : "Nothing";
  const cmpShort = crA ? "vs " + runSpan(crA).toLowerCase() : null;
  const foot = "Based on " + f0(n) + " answers · " + (S.run === "latest" ? latestIn : runLabel) + " · " + engs.length + " engine" + (engs.length === 1 ? "" : "s") + (cmpShort ? " · Δ " + cmpShort : "");
  const go = (pg) => () => set({ page: pg, open: null });
  const openPrompt = (pi) => (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); set({ drawer: pi }); };
  const tabsOf = (key, opts, def) => { const cur = (S.tab && S.tab[key]) || def; return { cur, list: opts.map(([id, label]) => ({ label, cls: cur === id ? "on" : "", go: () => set({ tab: Object.assign({}, S.tab, { [key]: id }) }) })) }; };
  const sorter = (tid, keys, def) => { const cur = (S.sort && S.sort[tid]) || def; const s = {}; keys.forEach((k) => { s[k] = { ar: cur.k === k ? (cur.d > 0 ? "↑" : "↓") : "", go: () => set({ sort: Object.assign({}, S.sort, { [tid]: { k, d: cur.k === k ? -cur.d : k === "text" || k === "pos" ? 1 : -1 } }), pg: Object.assign({}, S.pg, { [tid]: 0 }) }) }; }); return { s, cur }; };
  const pager = (tid, total, per = 10) => { const p = Math.min((S.pg && S.pg[tid]) || 0, Math.max(0, Math.ceil(total / per) - 1)); const goTo = (d) => () => set({ pg: Object.assign({}, S.pg, { [tid]: p + d }) }); return { from: p * per, to: p * per + per, label: total ? p * per + 1 + "–" + Math.min(total, p * per + per) + " of " + total : "0 rows", prev: goTo(-1), next: goTo(1), noPrev: p === 0, noNext: (p + 1) * per >= total }; };
  const kp = (label, value, sub, d, tip) => ({ label, value, sub, d: d || { t: "", c: "none" }, tip });

  // A line chart: each column carries its own tooltip and dots, shown on hover by CSS.
  const B = bucketsOf(S.gran);
  const bucketRecs = B.map((b) => [].concat(...b.runs.map((i) => byRun[i])));
  const bucketM = bucketRecs.map((rs) => metrics(rs));
  const line = (id, series, o = {}) => {
    const vis = series.filter((s) => !(S.hidden && S.hidden[id + ":" + s.id]));
    const all = []; vis.forEach((s) => s.vals.forEach((v) => { if (v != null) all.push(v); }));
    let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.14; lo = Math.max(o.floor != null ? o.floor : -Infinity, lo - pad); hi += pad;
    const nb = B.length; const X = (i) => (nb < 2 ? 50 : (i / (nb - 1)) * 100);
    const Y = (v) => (o.invert ? ((v - lo) / (hi - lo)) * 100 : 100 - ((v - lo) / (hi - lo)) * 100);
    const fmt = o.fmt || fp;
    const ticks = []; for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4; ticks.push({ top: Y(v).toFixed(2), label: fmt(v) }); }
    const step = Math.max(1, Math.ceil(nb / 8));
    const x = B.map((b, i) => ({ left: X(i).toFixed(2), label: b.label })).filter((_, i) => i % step === 0 || i === nb - 1);
    const inb = B.map((b) => b.runs.some((r) => vr.has(r)));
    const fi = inb.indexOf(true), li = inb.lastIndexOf(true);
    const w = nb < 2 ? 100 : 100 / (nb - 1);
    const band = fi < 0 ? [] : [{ left: Math.max(0, X(fi) - w / 2).toFixed(2), width: (Math.min(100, X(li) + w / 2) - Math.max(0, X(fi) - w / 2)).toFixed(2) }];
    const ser = vis.map((s) => ({ color: s.color, w: s.bold ? 3 : 1.6, points: s.vals.map((v, i) => (v == null ? null : X(i).toFixed(2) + "," + Y(v).toFixed(2))).filter(Boolean).join(" ") }));
    const cols = B.map((b, i) => ({
      left: (X(i) - w / 2).toFixed(2), width: w.toFixed(2), shift: X(i) > 70 ? -105 : X(i) < 30 ? 5 : -50,
      title: b.label + (b.runs.length > 1 ? " · " + b.runs.length + " runs" : " · Run " + (b.runs[0] + 1)),
      rows: vis.map((s) => ({ label: s.label, color: s.color, v: s.vals[i], val: fmt(s.vals[i]) })).filter((r) => r.v != null).sort((a, c) => (o.invert ? a.v - c.v : c.v - a.v)),
      dots: vis.filter((s) => s.vals[i] != null).map((s) => ({ top: Y(s.vals[i]).toFixed(2), color: s.color })),
    }));
    const legend = series.map((s) => { const on = !(S.hidden && S.hidden[id + ":" + s.id]); return { label: s.label, color: s.color, on, cls: on ? "" : "off", last: fmt(s.vals[s.vals.length - 1]), go: () => set({ hidden: Object.assign({}, S.hidden, { [id + ":" + s.id]: on }) }) }; });
    return { ticks, x, band, series: ser, cols, legend };
  };
  const EC = () => ({ ticks: [], x: [], band: [], series: [], cols: [], legend: [] });
  const PG = { label: "", noPrev: true, noNext: true };
  const R = { tr: EC(), gt: EC(), pt: EC(), trendTabs: [], gapTabs: [], lb: { rows: [], s: {} }, ts: { rows: [] }, hm: { head: [], rows: [] }, ak: { rows: [] }, gp: { top: [], rows: [], pg: PG }, oc: { rows: [] }, gs: { tabs: [], rows: [] }, pr: { rows: [], c: {}, s: {}, show: [], engHead: [], colOpts: [], pg: PG }, tg: { chart: EC(), rows: [], s: {} }, ci: { chart: EC(), metricTabs: [], tabs: [], rows: [] }, cg: { rows: [] }, cbt: { rows: [] }, sk: { rows: [] }, bb: { ticks: [], x: [], dots: [] }, sd: { chart: EC(), tabs: [], rows: [], s: {}, h: {}, pg: PG }, ac: { rows: [], pg: PG }, cm: { chart: EC(), tabs: [], subs: [], thTabs: [], threads: [], videos: [] }, im: { tabs: [], rows: [], s: {}, pg: PG }, la: { rows: [], pg: PG }, pd: { scope: [], rows: [], s: {}, dest: [], tiles: [], pg: PG, ranges: [], ptrows: [], pruns: [] }, pb: { ticks: [], x: [], dots: [] }, fo: { engines: [], tiles: [], rows: [], pg: PG }, sq: { sugg: [], rows: [] }, q: S.q || "", qi: { rows: [], legend: [], engines: [] }, so: { chart: EC(), overall: [], vs: [], platforms: [], legend: [], engines: [] }, ex: { cards: [], head: [], rows: [], tabs: [], list: [], pg: PG }, hh: { rivalOpts: [], engines: [], tags: [], lose: [], qMe: [], qThem: [] }, ch: { pickA: [], pickB: [], tabs: [], rows: [], engines: [], up: [], down: [], pg: PG }, cs: { dist: [], legend: [], head: [], rows: [], crowd: [] }, sb: { same: [], sameN: "", noSame: false, tabs: [], rows: [], engHead: [], hist: [], runHead: [], flipE: [], pg: PG, hpg: PG }, fn: { stages: [], engines: [], pages: [], kinds: [] }, ct: { mism: [], mmSub: "", types: [], bands: [], engines: [], pages: [], pg: PG }, sf: { tabs: [], ads: [], hosts: [], imgTiles: [], places: [], locTiles: [] } };

  /* ---- chrome ---- */
  const LEDES = { overview: "How " + view.name + " shows up across every engine’s answers, against its rivals.", prompts: "Where " + view.name + " came in each prompt on each engine. Click a prompt for every engine’s answer.", gaps: "Answers that named a rival and not " + view.name + ", who got ahead, and the pages behind them.", tags: "Your prompt sheet’s tags, compared: where " + view.name + " is strong and where a rival leads.", citations: "When the engines use " + (ownDom || "its site") + ", which pages, and which sites cite rivals instead.", sources: "Every site the engines cited or read, what kind it is, and what moved.", community: "Communities and videos the engines lean on.", impact: "Which cited sites go with " + view.name + " being named, and the latest answer per prompt.", products: "Product cards in the answers: whose, in which slot, at what price, and where they send buyers.", searches: "The searches the engines ran behind the answers (fan-out).", search: "Find any phrase across every answer in view.", h2h: view.name + " against one rival: when both are named, who comes first, where the rival gets ahead, and how the answers word each.", changes: "Pick any two runs: which prompts and engines gained or lost " + view.name + ", and which sites moved.", compset: "Where each brand lands in the answer, which brands are named together, and how crowded the answers are.", stability: "Do the engines agree on who comes first, and how often does an answer change from run to run.", funnel: "How often the engines read " + (ownDom || "its site") + ", how often they credit it, and the pages they read but never cite.", content: "What kind of page gets cited, how old the cited pages are, and pages that match none of the engine’s searches.", surfaces: "The parts of an answer beyond text: ChatGPT ads, images and map pins.", intent: "What the engines look for when they search behind an answer, and how " + view.name + " fares in each kind of search.", social: "How much the engines lean on Reddit, YouTube and forums, against editorial, retail and brand sites.", exclusive: "Sites only one engine cites, and how much the engines’ sources overlap." };
  const TITLES = Object.fromEntries(DASH_PAGES.flatMap(([, items]) => items));
  const NEW = new Set(DASH_PAGES[3][1].map(([id]) => id));
  R.nav = DASH_PAGES.map(([label, items]) => ({ label, items: items.map(([id, l]) => { const lk = id === "changes" && LOCK.changes.on; return { label: l, cnt: lk ? "2 runs" : id === "prompts" ? PROMPTS.length : id === "tags" ? TAGS.length || "" : "", lk, tip: lk ? LOCK.changes.msg : l, cls: (page === id ? "on" : "") + (lk ? " locked" : ""), cur: page === id ? "page" : null, icon: NAVICON[id], go: lk ? () => act.toast(LOCK.changes.msg) : go(id) }; }) }));
  void NEW;
  R.pin = { on: !!S.pinned, ico: S.pinned ? "«" : "»", label: S.pinned ? "Fold away" : "Keep open", tip: S.pinned ? "Let the menu fold away" : "Keep the menu open", go: () => set({ pinned: !S.pinned }) };
  R.go = { prompts: go("prompts"), sources: go("sources"), gaps: go("gaps") };
  R.pageTitle = TITLES[page]; R.pageLede = LEDES[page];
  R.themeCls = S.pinned ? "pinned" : "";
  R.lock = LOCK;
  R.is = {}; DASH_PAGE_IDS.forEach((k) => { R.is[k] = page === k && n > 0; });
  R.noData = n === 0; R.hasData = n > 0;

  /* ---- filters ---- */
  const openKey = (k) => () => set({ open: S.open === k ? null : k });
  R.op = { runs: openKey("runs"), cmp: LOCK.cmp.on ? () => {} : openKey("cmp"), view: openKey("view"), eng: openKey("eng"), tags: openKey("tags"), adv: openKey("adv"), cols: openKey("cols") };
  R.openIs = {}; ["runs", "cmp", "view", "eng", "tags", "adv", "cols"].forEach((k) => { R.openIs[k] = S.open === k; });
  R.anyOpen = !!S.open; R.closeAll = () => set({ open: null });
  R.runLabel = runLabel; R.cmpLabel = cmpLabel;
  const setRun = (v) => () => set({ run: v, open: null, pg: {} });
  R.runOpts = [["latest", "Latest answers", "The newest answer for each prompt on each engine", null], ["last4", "Last 4 runs", NR >= 5 ? dlab(RUNS[NR - 4].startedAt) + " – " + dlab(RUNS[NR - 1].startedAt) + ", answers pooled" : LOCK.last4.msg, LOCK.last4], ["all", "All runs combined", NR === 1 ? "Only one run so far: the same answers as the latest" : dlab(RUNS[0].startedAt) + " – " + dlab(RUNS[NR - 1].startedAt) + " · " + NR + " runs", null]].map(([v, l, sub, g]) => ({ label: l, sub, cls: S.run === v ? "on" : "", lk: g && g.on ? "locked" : "", dis: !!(g && g.on), go: g && g.on ? () => {} : setRun(v) }));
  R.runPick = RUNS.map((r, i) => ({ label: "Run " + (i + 1) + " · " + dlab(r.startedAt), cls: String(S.run) === String(i) ? "you" : "", go: setRun(String(i)) }));
  const setCmp = (v) => () => set({ cmp: v, open: null });
  R.cmpOpts = [["prev", "Previous period", "The answers just before the ones in view"], ["0", "Run 1 · " + (RUNS[0] ? dlab(RUNS[0].startedAt) : ""), vr.has(0) ? "Run 1 is already in view, so there is nothing to compare it with" : "The first run, as a baseline"], ["none", "Nothing", "Hide ▲▼ changes"]].map(([v, l, sub]) => { const lk = v === "0" && vr.has(0); return { label: l, sub, cls: S.cmp === v ? "on" : "", lk: lk ? "locked" : "", dis: lk, go: lk ? () => {} : setCmp(v) }; });
  R.viewBrand = Object.assign({ name: view.name, domain: ownDom || "its site" }, lg(view));
  R.viewOpts = BR.map((b) => ({ ...lg(b), lk: "", dis: false, name: b.name, sub: (b.isOwn ? "Your brand" : b.auto ? "Found in the answers" : "Competitor") + (b.domain ? " · " + b.domain : ""), cls: view.id === b.id ? "on" : "", go: () => set({ view: b.id, open: null }) }));
  const toggleIn = (key, v, all) => () => { const cur = (S[key] && S[key].length ? S[key] : all || []).slice(); const nx = cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat([v]); if (key === "engines" && !nx.length) return; set({ [key]: nx, pg: {} }); };
  R.engOpts = ENGS.map((e) => ({ label: e.label, d: e.d, st: e.st, sub: (e.fan ? "Publishes its searches" : "Doesn’t publish its searches") + (e.shop ? " · product cards" : ""), on: engs.includes(e.id), cls: engs.includes(e.id) ? "on" : "", go: toggleIn("engines", e.id, data.engines) }));
  R.engAll = () => set({ engines: null });
  R.engLabel = engs.length === data.engines.length ? "All " + engs.length : engs.map((e) => engOf(e).label).join(", ");
  R.engSet = engs.length === data.engines.length ? "" : "set";
  R.tagOpts = TAGS.map((t) => ({ label: t, sub: PROMPTS.filter((p) => p.tags.includes(t)).length + " prompts", on: S.tags.includes(t), cls: S.tags.includes(t) ? "on" : "", go: toggleIn("tags", t) }));
  R.hasTags = TAGS.length > 0;
  R.tagsClear = () => set({ tags: [] }); R.tagLabel = S.tags.length ? (S.tags.length === 1 ? S.tags[0] : S.tags.length + " tags") : "All"; R.tagSet = S.tags.length ? "set" : "";
  const intentIds = [...THEMES.map(([id, l]) => [id, l]), THEME_OTHER].filter(([id]) => PROMPTS.some((p, i) => intentOfP(i) === id));
  R.intentOpts = intentIds.map(([id, l]) => ({ label: l, sub: PROMPTS.filter((_, i) => intentOfP(i) === id).length + " prompts", on: S.intents.includes(id), cls: S.intents.includes(id) ? "on" : "", go: toggleIn("intents", id) }));
  const noKind = pick(data.recs.filter(baseNoKind)).now;
  R.kindOpts = KINDS.map(([id, l]) => ({ label: l, sub: noKind.filter((r) => r.kind === id).length + " answers in view", on: S.kinds.includes(id), cls: S.kinds.includes(id) ? "on" : "", go: toggleIn("kinds", id) }));
  R.advClear = () => set({ intents: [], kinds: [] });
  const advN = S.intents.length + S.kinds.length; R.advLabel = advN ? advN + " on" : "None"; R.advSet = advN ? "set" : "";
  R.anyFilter = !!(engs.length !== data.engines.length || S.tags.length || advN || view.id !== own.id || S.run !== "latest" || S.cmp !== "prev");
  R.resetAll = () => set({ engines: null, tags: [], intents: [], kinds: [], view: null, run: "latest", cmp: "prev", pg: {} });
  R.scopeLine = f0(n) + " answers · " + new Set(now.map((r) => r.p)).size + " prompts";
  R.statusLine = NR + (NR === 1 ? " run" : " runs") + " · last " + (RUNS[NR - 1] ? dlab(RUNS[NR - 1].startedAt) : "—") + " · " + f0(data.recs.length) + " answers stored";

  /* ---- KPI strip ---- */
  const KP = {
    vis: kp("Visibility", fp(me.vis), "named in " + f0(nameN) + " of " + f0(n) + " answers · " + marg(nameN, n), noisy(dlt(me.vis, mp && mp.vis, "pts"), nameN, n, mp ? mp.present : null, MP ? MP.n : 0), "Share of answers that named the brand at least once. ± is the 95% range for this many answers; a change smaller than the two ranges together is marked “within noise”."),
    sov: kp("Share of voice", fp(me.sov), f0(me.m) + " of " + f0(M.pool) + " tracked-brand mentions", dlt(me.sov, mp && mp.sov, "pts"), "The brand’s mentions ÷ mentions of every tracked brand in the same answers."),
    pos: kp("Avg position", f1(me.pos), "when named · 1 = named first", dlt(me.pos, mp && mp.pos, "pos"), "Order of first mention among tracked brands; only answers that name the brand in the text count."),
    men: kp("Mentions", f0(me.m), f0(n - nameN) + " answers didn’t name it", dlt(me.m, mp && MP ? mp.m * (n / Math.max(1, MP.n)) : null, "n"), "Every written mention of the brand across the answers in view. Δ is scaled to the same number of answers."),
    cit: kp("Citations", f0(me.cit), "answers linked " + (ownDom || "its site") + " · " + f0(n - me.cit) + " didn’t", dlt(me.cit, mp && MP ? mp.cit * (n / Math.max(1, MP.n)) : null, "n"), "Answers that linked the brand’s own website (cited, not just read). Δ is scaled to the same number of answers."),
    srcv: kp("Source visibility", fp(me.srcVis), (ownDom || "its site") + " cited or read · " + marg(Math.round(((me.srcVis || 0) * n) / 100), n), noisy(dlt(me.srcVis, mp && mp.srcVis, "pts"), Math.round(((me.srcVis || 0) * n) / 100), n, mp && MP ? Math.round(((mp.srcVis || 0) * MP.n) / 100) : null, MP ? MP.n : 0), "Share of answers where the brand’s own domain appeared as a source at all: cited or only read."),
  };
  R.kpis = [KP.vis, KP.sov, KP.pos, KP.men, KP.cit, KP.srcv];
  R.granTabs = [["run", "By run", 9], ["week", "Week", nW], ["month", "Month", nM]].map(([id, l, k]) => { const lk = k < 2; return { label: l, lk, tip: lk ? (id === "week" ? "Grouping by week opens once the runs span 2 different weeks." : "Grouping by month opens once the runs span 2 different months.") : "", cls: (S.gran === id ? "on" : "") + (lk ? " locked" : ""), go: lk ? () => {} : () => set({ gran: id }) }; });

  const ahead = (t, y) => !!t && t.rank != null && (!y || y.rank == null || t.rank < y.rank);

  if (page === "overview") {
    R.trendTabs = [["vis", "Visibility"], ["sov", "Share of voice"], ["m", "Mentions"], ["pos", "Avg position"]].map(([id, l]) => ({ label: l, cls: S.metric === id ? "on" : "", go: () => set({ metric: id }) }));
    const key = S.metric;
    R.tr = line("trend", BR.map((b) => ({ id: b.id, label: b.name, color: b.id === view.id ? "var(--accent)" : b.color, bold: b.id === view.id, vals: bucketM.map((m) => (m.n ? (key === "pos" ? m.b[b.id].pos : m.b[b.id][key]) : null)) })), { fmt: key === "m" ? f0 : key === "pos" ? f1 : fp, invert: key === "pos", floor: 0 });
    R.tr.foot = "Each point: every answer in that " + (S.gran === "run" ? "run" : S.gran) + " under the current engine and tag filters.";
    const lbs = sorter("lb", ["sov", "vis", "pos"], { k: "sov", d: -1 });
    const rows = BR.map((b) => ({ b, m: M.b[b.id], p: MP ? MP.b[b.id] : null }));
    const kf = { sov: (x) => x.m.sov || 0, vis: (x) => x.m.vis || 0, pos: (x) => (x.m.pos == null ? 99 : x.m.pos) };
    rows.sort((a, b) => (kf[lbs.cur.k](a) - kf[lbs.cur.k](b)) * lbs.cur.d);
    const maxS = Math.max(...rows.map((x) => x.m.sov || 0), 0.0001);
    const lcols = "28px minmax(120px,1.4fr) minmax(130px,1.6fr) 72px 70px 76px";
    R.lb = { cols: lcols, s: lbs.s, foot, rows: rows.map((x, i) => ({ i: i + 1, name: x.b.name, ...lg(x.b), own: !!x.b.isOwn, cls: x.b.id === view.id ? "you" : "", sov: fp(x.m.sov), sovW: pct(x.m.sov || 0, maxS).toFixed(1), vis: fp(x.m.vis), pos: f1(x.m.pos), dd: dlt(x.m.sov, x.p && x.p.sov, "pts"), cols: lcols })) };
    const ds = new Map(); now.forEach((r) => { const seen = new Set(); r.sources.forEach((s) => { if (!s.cited) return; const e = ds.get(s.d) || { d: s.d, k: s.k, n: 0, ans: 0 }; e.n++; if (!seen.has(s.d)) { seen.add(s.d); e.ans++; } ds.set(s.d, e); }); });
    const top = [...ds.values()].sort((a, b) => b.n - a.n).slice(0, 8); const mx = top.length ? top[0].n : 1;
    const tcols = "minmax(140px,1.4fr) minmax(110px,1fr) 70px minmax(120px,1.4fr)";
    R.ts = { cols: tcols, foot: "Cited pages in " + f0(n) + " answers", rows: top.map((x) => ({ d: x.d, k: x.k, kc: KINDC[x.k], n: f0(x.n), w: pct(x.n, mx).toFixed(1), share: fp(pct(x.ans, n)), cols: tcols })) };
    const perE = engsX.map((e) => metrics(now.filter((r) => r.e === e.id)));
    R.hm = { cols: "minmax(120px,1.2fr) " + engsX.map(() => "minmax(64px,1fr)").join(" "), head: engsX.map(emk), rows: BR.map((b) => ({ name: b.name, ...lg(b), fw: b.id === view.id ? 700 : 400, cells: perE.map((m) => { const v = m.n ? m.b[b.id].vis : null; const c = heatC(v); return { v: v == null ? "—" : Math.round(v) + "%", bg: c.bg, fg: c.fg }; }) })) };
    const leaders = engsX.map((e, i) => { if (!perE[i].n) return null; const best = BR.slice().sort((a, b) => (perE[i].b[b.id].vis || 0) - (perE[i].b[a.id].vis || 0))[0]; return best && (perE[i].b[best.id].vis || 0) > 0 ? { e: e.label, b: best } : null; }).filter(Boolean);
    const mine = leaders.filter((l) => l.b.id === view.id).map((l) => l.e), theirs = leaders.filter((l) => l.b.id !== view.id);
    R.hm.note = (theirs.length ? theirs.map((l) => l.e + " leans to " + l.b.name).join(", ") + ". " : "") + (mine.length ? view.name + " leads on " + mine.join(" and ") + "." : view.name + " leads on no engine in this view.");
    const kcols = "minmax(130px,1.3fr) 110px 110px 90px";
    R.ak = { cols: kcols, rows: KINDS.map(([id, l, c]) => { const list = now.filter((r) => r.kind === id); const mm = metrics(list); return { label: l, color: c, n: f0(list.length), share: pct(list.length, n).toFixed(1), sharet: fp(pct(list.length, n)), vis: list.length ? fp(mm.b[view.id].vis) : "—", cit: list.length && id !== "memory" ? fp(pct(mm.b[view.id].cit, list.length)) : "—", cols: kcols }; }) };
  }

  if (page === "overview" || page === "gaps") {
    const isGap = (r) => !r.brands.some((x) => x.id === view.id) && r.brands.length > 0;
    const gapRecs = now.filter(isGap);
    const gm = new Map();
    gapRecs.forEach((r) => { const e = gm.get(r.p) || { p: r.p, n: 0, engs: new Set(), riv: new Map(), bn: [] }; e.n++; e.engs.add(r.e); r.brands.forEach((x) => e.riv.set(x.id, (e.riv.get(x.id) || 0) + 1)); e.bn.push(r.brands.length); gm.set(r.p, e); });
    const runsWithGap = (pi) => new Set(filtered.filter((r) => r.p === pi && isGap(r)).map((r) => r.run)).size;
    const rows = [...gm.values()].sort((a, b) => b.n - a.n);
    const cols = "minmax(220px,2fr) 120px minmax(160px,1.4fr) 90px", cols2 = "minmax(220px,2fr) 130px 120px minmax(160px,1.4fr) 100px minmax(120px,1fr)";
    const mk = (e) => { const rv = runsWithGap(e.p); return { text: ptext(e.p), tag: (PROMPTS[e.p].tags[0]) || "—", n: e.n, engs: [...e.engs].map(engMark), rivals: [...e.riv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => (bOf(id) || { name: id }).name), brandsN: f1(avg(e.bn)), runs: rv + " of " + NR, runsW: pct(rv, NR).toFixed(0), open: openPrompt(e.p), cols, cols2 }; };
    const pg = pager("gp", rows.length);
    R.gp = { cols, cols2, top: rows.slice(0, 5).map(mk), rows: rows.slice(pg.from, pg.to).map(mk), pg, sub: rows.length + " of " + new Set(now.map((r) => r.p)).size + " prompts · " + gapRecs.length + " gap answers", none: !rows.length };
    if (page === "gaps") {
      const pPrev = prev ? prev.filter(isGap) : null;
      R.kpis = [
        kp("Prompts with a gap", f0(gm.size), "of " + new Set(now.map((r) => r.p)).size + " prompts in view", prev ? dlt(gm.size, new Set(pPrev.map((r) => r.p)).size, "nbad") : null, "Prompts where at least one engine named a rival and not the viewed brand."),
        kp("Gap answers", fp(pct(gapRecs.length, n)), f0(gapRecs.length) + " of " + f0(n) + " answers", prev ? dlt(pct(gapRecs.length, n), pct(pPrev.length, prev.length), "ptsbad") : null, "Answers that named a rival and not the viewed brand."),
        kp("Not named at all", f0(n - nameN), "answers without " + view.name, null, "Includes answers that named no tracked brand."),
        kp("Rivals per gap answer", f1(avg(gapRecs.map((r) => r.brands.length))), "brands named instead, on average", null, "How crowded the answers are where the brand is missing."),
      ];
      const gt = tabsOf("gapm", [["n", "Gap answers"], ["pct", "Share of answers"]], "n");
      R.gapTabs = gt.list;
      R.gt = line("gapt", [{ id: "g", label: "Gap answers", color: "var(--red-fg)", bold: true, vals: bucketRecs.map((rs) => (rs.length ? (gt.cur === "n" ? rs.filter(isGap).length : pct(rs.filter(isGap).length, rs.length)) : null)) }], { fmt: gt.cur === "n" ? f0 : fp, floor: 0 });
      const oc = BR.filter((b) => b.id !== view.id).map((b) => { let k = 0; now.forEach((r) => { const t = r.brands.find((x) => x.id === b.id); if (!t) return; const y = r.brands.find((x) => x.id === view.id); if (!y || ahead(t, y)) k++; }); return { b, k }; }).sort((a, b) => b.k - a.k);
      const mx = oc.length ? oc[0].k || 1 : 1; const occ = "minmax(140px,1.2fr) minmax(160px,1.6fr) 110px";
      R.oc = { cols: occ, rows: oc.map((x) => ({ name: x.b.name, ...lg(x.b), n: f0(x.k), w: pct(x.k, mx).toFixed(1), share: fp(pct(x.k, n)), cols: occ })) };
      const gst = tabsOf("gs", [["pages", "Pages"], ["sites", "Sites"]], "pages");
      const agg = new Map(); gapRecs.forEach((r) => r.sources.forEach((s) => { if (!s.cited || s.k === "Your site") return; const key = gst.cur === "pages" ? s.url : s.d; const e = agg.get(key) || { s, n: 0, ps: new Set() }; e.n++; e.ps.add(r.p); agg.set(key, e); }));
      const gcols = "minmax(220px,2fr) 120px 70px 70px";
      R.gs = { tabs: gst.list, cols: gcols, h1: gst.cur === "pages" ? "Page" : "Site", rows: [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 10).map((e) => ({ title: gst.cur === "pages" ? e.s.title : e.s.d, sub: gst.cur === "pages" ? e.s.url : "", full: e.s.url, k: e.s.k, n: f0(e.n), p: e.ps.size, cols: gcols })) };
    }
  }

  // The newest answer in view for a prompt on an engine.
  const newest = (pi, e) => { let best = null; for (const r of now) if (r.p === pi && r.e === e && (!best || r.run > best.run)) best = r; return best; };

  if (page === "prompts") {
    const C = S.cols;
    let rows = PROMPTS.map((pr, pi) => {
      const list = now.filter((r) => r.p === pi); if (!list.length) return null;
      const mineR = list.map((r) => r.brands.find((x) => x.id === view.id)).filter((x) => x && x.rank != null);
      const named = new Set(filtered.filter((r) => r.p === pi && r.brands.some((x) => x.id === view.id)).map((r) => r.run)).size;
      const firstC = new Map(); list.forEach((r) => { const f = firstOf(r); if (f) firstC.set(f.id, (firstC.get(f.id) || 0) + 1); });
      const fb = [...firstC.entries()].sort((a, b) => b[1] - a[1])[0];
      const cells = engsX.map((e) => { const r = newest(pi, e.id); if (!r) return { v: "○", cls: "na", tip: e.label + ": no answer in view (failed, or left out by a filter)" }; const y = r.brands.find((x) => x.id === view.id); if (!y) return { v: "–", cls: "miss", tip: e.label + ": answered, " + view.name + " not named" }; if (y.rank == null) return { v: "•", cls: "", tip: e.label + ": shown as a card, not named in the text" }; return { v: y.rank, cls: y.rank === 1 ? "first" : "", tip: e.label + ": named #" + y.rank }; });
      return { pi, text: pr.text, tag: pr.tags[0] || "—", intent: themeLabel(intentOfP(pi)), runs: named, pos: avg(mineR.map((x) => x.rank)), cited: list.filter((r) => r.sources.some((s) => s.cited && s.b === view.id)).length, n: list.length, first: fb ? (bOf(fb[0]) || { name: "—" }).name : "—", firstOwn: !!(fb && fb[0] === view.id), cells };
    }).filter(Boolean);
    const showT = tabsOf("prf", [["all", "All"], ["missing", "Missing somewhere"], ["first", "Named first everywhere"], ["cited", "Site cited"]], "all");
    if (showT.cur === "missing") rows = rows.filter((r) => r.cells.some((c) => c.cls === "miss"));
    if (showT.cur === "first") rows = rows.filter((r) => r.cells.every((c) => c.cls === "first" || c.cls === "na") && r.cells.some((c) => c.cls === "first"));
    if (showT.cur === "cited") rows = rows.filter((r) => r.cited > 0);
    const so = sorter("pr", ["text", "runs", "pos", "cited"], { k: "runs", d: -1 });
    const kf = { text: (r) => r.text.toLowerCase(), runs: (r) => r.runs, pos: (r) => (r.pos == null ? 99 : r.pos), cited: (r) => r.cited };
    rows.sort((a, b) => { const x = kf[so.cur.k](a), y = kf[so.cur.k](b); return (x < y ? -1 : x > y ? 1 : 0) * so.cur.d; });
    const parts = ["minmax(240px,2.2fr)"]; if (C.tag) parts.push("150px"); if (C.intent) parts.push("minmax(130px,1fr)"); if (C.engines) parts.push(engsX.length * 32 + "px"); if (C.runs) parts.push("minmax(120px,1fr)"); if (C.pos) parts.push("72px"); if (C.cited) parts.push("76px"); if (C.first) parts.push("110px");
    const cols = parts.join(" ");
    const pg = pager("pr", rows.length);
    const colDefs = [["tag", "Tag", "Primary tag from your prompt sheet"], ["intent", "Intent", "What the prompt asks for"], ["engines", "Rank on each engine", "Newest answer in view"], ["runs", "Runs named", "Runs in which any engine named the brand"], ["pos", "Avg position", "When named in the text"], ["cited", "Site cited", "Answers linking " + (ownDom || "its site")], ["first", "Named first", "Brand most often named first"]];
    R.pr = { cols, c: C, s: so.s, show: showT.list, engHead: engsX.map(emk), pg, foot: rows.length + " prompts · " + foot, colCount: Object.values(C).filter(Boolean).length + "/7",
      colOpts: colDefs.map(([k, l, s]) => ({ label: l, sub: s, on: !!C[k], cls: C[k] ? "on" : "", go: () => set({ cols: Object.assign({}, S.cols, { [k]: !C[k] }) }) })),
      rows: rows.slice(pg.from, pg.to).map((r) => ({ text: r.text, tag: r.tag, intent: r.intent, cells: r.cells, runs: r.runs + " of " + NR, runsW: pct(r.runs, NR).toFixed(0), pos: f1(r.pos), cited: r.cited ? r.cited + " of " + r.n : "—", first: r.first, firstCls: r.firstOwn ? "you" : "", open: openPrompt(r.pi), c: C, cols })) };
    const firstN = (list) => list.filter((r) => { const f = firstOf(r); return f && f.id === view.id; }).length;
    R.kpis = [KP.vis, KP.pos, kp("Prompts named", f0(new Set(now.filter((r) => r.brands.some((x) => x.id === view.id)).map((r) => r.p)).size), "of " + new Set(now.map((r) => r.p)).size + " prompts, by at least one engine", null, "Prompts where at least one engine named the brand."), kp("Named first", f0(firstN(now)), "answers where " + view.name + " came first", prev ? dlt(firstN(now), firstN(prev) * (n / Math.max(1, prev.length)), "n") : null, "Answers where the brand was the first tracked brand named."), KP.cit];
  }

  if (page === "tags") {
    const tagsIn = TAGS.filter((t) => !S.tags.length || S.tags.includes(t));
    const tchart = line("tags", tagsIn.map((t, i) => ({ id: t, label: t, color: TAGC[i % TAGC.length], vals: bucketRecs.map((rs) => { const l = rs.filter((r) => r.tags.includes(t)); return l.length ? metrics(l).b[view.id].vis : null; }) })), { fmt: fp, floor: 0 });
    let rows = tagsIn.map((t) => { const l = now.filter((r) => r.tags.includes(t)); if (!l.length) return null; const mm = metrics(l); const y = mm.b[view.id]; const rv = BR.filter((b) => b.id !== view.id).sort((a, b) => (mm.b[b.id].vis || 0) - (mm.b[a.id].vis || 0))[0]; return { t, prompts: PROMPTS.filter((p) => p.tags.includes(t)).length, m: y.m, sov: y.sov || 0, vis: y.vis || 0, pos: y.pos, rv, rvv: rv ? mm.b[rv.id].vis || 0 : 0, gap: (y.vis || 0) - (rv ? mm.b[rv.id].vis || 0 : 0) }; }).filter(Boolean);
    const so = sorter("tg", ["mentions", "sov", "vis", "pos", "gap"], { k: "mentions", d: -1 });
    const kf = { mentions: (r) => r.m, sov: (r) => r.sov, vis: (r) => r.vis, pos: (r) => (r.pos == null ? 99 : r.pos), gap: (r) => r.gap };
    rows.sort((a, b) => (kf[so.cur.k](a) - kf[so.cur.k](b)) * so.cur.d);
    const mm = Math.max(1, ...rows.map((r) => r.m)), ms = Math.max(1, ...rows.map((r) => r.sov));
    const cols = "minmax(150px,1.3fr) 70px minmax(110px,1.2fr) minmax(110px,1.2fr) 100px 70px minmax(150px,1.3fr) 80px";
    R.tg = { chart: tchart, cols, s: so.s, none: !TAGS.length, rows: rows.map((r) => { const rt = r.rv ? lg(r.rv) : { color: "#64748b", ini: "—", d: "", sc: "no" }; return { tag: r.t, prompts: r.prompts, mentions: f0(r.m), mW: pct(r.m, mm).toFixed(1), sov: fp(r.sov), sovW: pct(r.sov, ms).toFixed(1), vis: fp(r.vis), gauge: gauge(r.vis), pos: f1(r.pos), rival: r.rv ? r.rv.name : "—", rc: rt.color, ri: rt.ini, rd: rt.d, rsc: rt.sc, rv: fp(r.rvv), gap: (r.gap >= 0 ? "+" : "−") + Math.abs(Math.round(r.gap)) + " pts", gc: r.gap >= 0 ? "up" : "down", cols }; }) };
    const best = rows.slice().sort((a, b) => b.gap - a.gap)[0], worst = rows.slice().sort((a, b) => a.gap - b.gap)[0];
    R.kpis = [KP.vis, KP.sov, kp("Strongest tag", best ? best.t : "—", best ? fp(best.vis) + " visibility · " + (best.gap >= 0 ? "leads by " : "trails by ") + Math.abs(Math.round(best.gap)) + " pts" : "no tags on the prompts", null, "The tag where the brand is furthest ahead of (or least behind) its strongest rival."), kp("Weakest tag", worst ? worst.t : "—", worst && worst.rv ? worst.rv.name + " leads by " + Math.abs(Math.round(worst.gap)) + " pts" : "", null, "The tag where the strongest rival is furthest ahead.")];
  }

  if (page === "citations") {
    const mt = tabsOf("cim", [["srcVis", "Source visibility"], ["cit", "Citations"]], "srcVis");
    const cchart = line("cit", BR.filter((b) => b.domain).map((b) => ({ id: b.id, label: b.domain, color: b.id === view.id ? "var(--accent)" : b.color, bold: b.id === view.id, vals: bucketM.map((m) => (m.n ? m.b[b.id][mt.cur] : null)) })), { fmt: mt.cur === "cit" ? f0 : fp, floor: 0 });
    const ownC = []; now.forEach((r) => r.sources.forEach((s) => { if (s.b === view.id && s.cited) ownC.push({ r, s }); }));
    const allCited = now.reduce((a, r) => a + r.sources.filter((s) => s.cited).length, 0);
    const citedNotNamed = now.filter((r) => r.sources.some((s) => s.cited && s.b === view.id) && !r.brands.some((x) => x.id === view.id)).length;
    R.kpis = [KP.srcv, KP.cit, kp("Citation share", fp(pct(ownC.length, allCited)), f0(ownC.length) + " of " + f0(allCited) + " cited pages", null, "The brand’s own pages ÷ every page cited in these answers."), kp("Your pages cited", f0(new Set(ownC.map((x) => x.s.url)).size), "different URLs on " + (ownDom || "its site"), null, "Distinct pages of the brand’s site that were cited."), kp("Cited, not named", f0(citedNotNamed), "answers used the page but skipped the name", null, "Answers that linked the brand’s site without naming the brand.")];
    const tb = tabsOf("cit", [["prompts", "Prompts"], ["urls", "Its pages"], ["sections", "Site sections"]], "prompts");
    const cols = "minmax(240px,2fr) minmax(160px,1.2fr) minmax(130px,1.2fr) 90px";
    let rows = [], heads;
    const group = (keyOf) => { const m = new Map(); ownC.forEach(({ r, s }) => { const k = keyOf(r, s); const e = m.get(k) || { n: 0, engs: new Set(), urls: new Set(), ps: new Set() }; e.n++; e.engs.add(r.e); e.urls.add(s.url); e.ps.add(r.p); m.set(k, e); }); return [...m.entries()].sort((a, b) => b[1].n - a[1].n); };
    if (tb.cur === "prompts") { rows = group((r) => r.p).map(([p, e]) => ({ a: ptext(p), engs: [...e.engs].map(engMark), b: "", c: e.n, d: e.urls.size + " page" + (e.urls.size === 1 ? "" : "s") })); heads = { h1: "Prompt", h2: "Engines", h3: "Citations", h4: "Pages used" }; }
    if (tb.cur === "urls") { rows = group((r, s) => s.url).map(([u, e]) => ({ a: u, engs: [...e.engs].map(engMark), b: "", c: e.n, d: e.ps.size + " prompts" })); heads = { h1: "Page", h2: "Engines", h3: "Citations", h4: "Prompts" }; }
    if (tb.cur === "sections") { rows = group((r, s) => { const seg = s.url.split("/").filter(Boolean)[1]; return seg ? "/" + seg.split(/[?#]/)[0] : "/ (home)"; }).map(([sec, e]) => ({ a: sec, engs: [...e.engs].map(engMark), b: "", c: e.n, d: e.urls.size + " pages" })); heads = { h1: "Section (first part of the path)", h2: "Engines", h3: "Citations", h4: "Pages" }; }
    const mx = Math.max(1, ...rows.map((r) => r.c));
    R.ci = Object.assign(heads, { noSite: !ownDom, chart: cchart, metricTabs: mt.list, tabs: tb.list, cols, empty: !rows.length, tabNote: tb.cur === "sections" ? "Sections are read from the URL path; no setup needed." : foot, rows: rows.slice(0, 10).map((r) => Object.assign(r, { w: pct(r.c, mx).toFixed(1), c: f0(r.c), cols })) });
    const g = new Map(); now.forEach((r) => { if (r.brands.some((x) => x.id === view.id) || !r.brands.length) return; const rivalsHere = r.brands.map((x) => (bOf(x.id) || { name: x.id }).name); r.sources.forEach((s) => { if (!s.cited || s.k === "Your site" || s.k === "Rival brand sites") return; const e = g.get(s.d) || { d: s.d, k: s.k, n: 0, riv: new Map() }; e.n++; rivalsHere.forEach((nm) => e.riv.set(nm, (e.riv.get(nm) || 0) + 1)); g.set(s.d, e); }); });
    const gc = "minmax(140px,1.2fr) minmax(160px,1.6fr) 90px";
    R.cg = { cols: gc, rows: [...g.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((e) => ({ d: e.d, kc: KINDC[e.k], rivals: [...e.riv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([nm]) => nm), n: e.n, cols: gc })) };
    const bt = "minmax(150px,1.3fr) minmax(130px,1.4fr) 140px";
    const trows = TAGS.filter((t) => !S.tags.length || S.tags.includes(t)).map((t) => { const l = now.filter((r) => r.tags.includes(t)); return { t, c: l.filter((r) => r.sources.some((s) => s.cited && s.b === view.id)).length, sv: l.length ? pct(l.filter((r) => r.sources.some((s) => s.b === view.id)).length, l.length) : 0 }; });
    const tm = Math.max(1, ...trows.map((r) => r.c));
    R.cbt = { cols: bt, rows: trows.sort((a, b) => b.c - a.c).map((r) => ({ tag: r.t, n: r.c, w: pct(r.c, tm).toFixed(1), sv: fp(r.sv), gauge: gauge(r.sv), cols: bt })) };
  }

  if (page === "sources") {
    const kindOff = S.kindOff || {};
    const kc = new Map(KIND_GROUPS.map((k) => [k, 0])); let tot = 0; now.forEach((r) => r.sources.forEach((s) => { if (s.cited) { kc.set(s.k, (kc.get(s.k) || 0) + 1); tot++; } }));
    let accp = 0; const segs = [];
    KIND_GROUPS.forEach((k) => { const v = pct(kc.get(k), tot); segs.push(KINDC[k] + " " + accp.toFixed(2) + "% " + (accp + v).toFixed(2) + "%"); accp += v; });
    R.sk = { total: f0(tot), conic: tot ? "conic-gradient(" + segs.join(", ") + ")" : "var(--line-soft)", rows: KIND_GROUPS.map((k) => ({ label: k, color: KINDC[k], n: f0(kc.get(k)), pct: fp(pct(kc.get(k), tot)), on: !kindOff[k], cls: kindOff[k] ? "off" : "", go: () => set({ kindOff: Object.assign({}, kindOff, { [k]: !kindOff[k] }) }) })) };
    const agg = (recs, key) => { const m = new Map(); recs.forEach((r) => { const seenA = new Set(); r.sources.forEach((s) => { if (kindOff[s.k]) return; const kk = key(s); const e = m.get(kk) || { s, cited: 0, read: 0, ans: 0, pos: [], engs: new Set() }; if (s.cited) { e.cited++; e.pos.push(s.pos); } else e.read++; if (!seenA.has(kk) && s.cited) { seenA.add(kk); e.ans++; } e.engs.add(r.e); m.set(kk, e); }); }); return m; };
    const dNow = agg(now, (s) => s.d), dPrev = prev ? agg(prev, (s) => s.d) : null;
    const scale = prev && prev.length ? n / prev.length : 1;
    const topD = [...dNow.values()].sort((a, b) => b.cited - a.cited).slice(0, 12);
    const bubs = topD.map((e) => { const p = dPrev && dPrev.get(e.s.d); return { e, ch: p && p.cited ? ((e.cited - p.cited * scale) / (p.cited * scale)) * 100 : null }; });
    const ext = Math.max(20, ...bubs.map((b) => Math.abs(b.ch || 0))) * 1.15, ymax = Math.max(1, ...topD.map((e) => e.cited)) * 1.15;
    R.bb = { sub: cmpShort ? "Change " + cmpShort : "Pick a comparison to see change", zero: 50, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ top: (100 - f * 100).toFixed(1), label: f0(ymax * f) })), x: [-1, -0.5, 0, 0.5, 1].map((f) => ({ left: (50 + f * 50).toFixed(1), label: (f > 0 ? "+" : "") + Math.round(ext * f) + "%" })), dots: bubs.map(({ e, ch }) => ({ x: (50 + ((ch || 0) / ext) * 50).toFixed(1), y: (100 - (e.cited / ymax) * 100).toFixed(1), s: Math.round(18 + Math.sqrt(pct(e.ans, n)) * 7), color: KINDC[e.s.k], ini: e.s.d[0].toUpperCase(), tip: e.s.d + " · " + e.cited + " citations · " + (ch == null ? "no comparison" : (ch >= 0 ? "+" : "") + Math.round(ch) + "%") })), foot: "Top 12 sites by citations · colour = kind of site" };
    const top6 = topD.slice(0, 6).map((e) => e.s.d);
    const dchart = line("dom", top6.map((d, i) => ({ id: d, label: d, color: PALETTE[i], vals: bucketRecs.map((rs) => (rs.length ? rs.reduce((a, r) => a + r.sources.filter((s) => s.cited && s.d === d).length, 0) : null)) })), { fmt: f0, floor: 0 });
    const tb = tabsOf("sd", [["domains", "Sites"], ["urls", "Pages"], ["prompts", "Prompts"]], "domains");
    let m, mp2, h;
    if (tb.cur === "domains") { m = dNow; mp2 = dPrev; h = { a: "Site", b: "Kind", e: "Cited in", g: "Avg order" }; }
    if (tb.cur === "urls") { m = agg(now, (s) => s.url); mp2 = prev ? agg(prev, (s) => s.url) : null; h = { a: "Page", b: "Page type", e: "Cited in", g: "Avg order" }; }
    if (tb.cur === "prompts") { m = new Map(); now.forEach((r) => { const e = m.get(r.p) || { p: r.p, cited: 0, read: 0, ans: 0, doms: new Set(), urls: new Set(), engs: new Set() }; r.sources.forEach((s) => { if (kindOff[s.k]) return; if (s.cited) { e.cited++; e.doms.add(s.d); e.urls.add(s.url); } else e.read++; }); e.ans++; e.engs.add(r.e); m.set(r.p, e); }); mp2 = null; h = { a: "Prompt", b: "Sites cited", e: "Pages cited", g: "Answers" }; }
    let rows = [...m.entries()].map(([k, e]) => { const p = mp2 && mp2.get(k); return { k, e, ch: mp2 ? (p ? e.cited - Math.round(p.cited * scale) : e.cited) : null }; });
    const so = sorter("sd", ["cited", "chg", "share", "read"], { k: "cited", d: -1 });
    const kf = { cited: (r) => r.e.cited, chg: (r) => (r.ch == null ? -1e9 : r.ch), share: (r) => (tb.cur === "prompts" ? r.e.urls.size : r.e.ans), read: (r) => r.e.read };
    rows.sort((a, b) => (kf[so.cur.k](a) - kf[so.cur.k](b)) * so.cur.d);
    const pg = pager("sd", rows.length); const mx = Math.max(1, ...rows.map((r) => r.e.cited));
    const cols = "minmax(220px,2fr) minmax(110px,1fr) minmax(120px,1.2fr) 80px 84px 84px 80px 110px";
    R.sd = { chart: dchart, tabs: tb.list, h, s: so.s, cols, pg, note: tb.cur === "urls" ? "Page type is read from the URL (list, review, comparison, product page…)" : "Read only = opened while searching, never linked", rows: rows.slice(pg.from, pg.to).map(({ e, ch }) => ({ a: tb.cur === "prompts" ? ptext(e.p) : tb.cur === "urls" ? e.s.url : e.s.d, full: tb.cur === "prompts" ? "" : e.s.url, b: tb.cur === "prompts" ? e.doms.size + " sites" : tb.cur === "urls" ? pageTypeOf("https://" + e.s.url) : e.s.k, kc: tb.cur === "prompts" ? "transparent" : KINDC[e.s.k], c: f0(e.cited), w: pct(e.cited, mx).toFixed(1), d: ch == null ? "—" : ch === 0 ? "0" : (ch > 0 ? "+" : "") + ch, dc: ch == null || ch === 0 ? "same" : ch > 0 ? "up" : "down", e: tb.cur === "prompts" ? e.urls.size + " pages" : fp(pct(e.ans, n)), f: f0(e.read), g: tb.cur === "prompts" ? e.ans : f1(avg(e.pos)), engs: [...e.engs].map(engMark), cols })) };
    const log = []; now.forEach((r) => r.sources.forEach((s) => { if (!kindOff[s.k]) log.push({ r, s }); }));
    log.sort((a, b) => b.r.run - a.r.run || a.r.p - b.r.p || a.s.pos - b.s.pos);
    const lpg = pager("ac", log.length); const lc = "minmax(200px,1.6fr) 110px 70px minmax(220px,2fr) 60px 90px 130px";
    R.ac = { cols: lc, pg: lpg, sub: f0(log.length) + " sources · " + f0(log.filter((x) => x.s.cited).length) + " cited, " + f0(log.filter((x) => !x.s.cited).length) + " read only", rows: log.slice(lpg.from, lpg.to).map(({ r, s }) => { const em = engMark(r.e); return { prompt: ptext(r.p), open: openPrompt(r.p), el: em.label, ed: em.d, est: em.st, run: "Run " + (r.run + 1), url: s.url, pos: s.pos, o: s.cited ? "Cited" : "Read only", oc: s.cited ? "cited" : "read", tag: ptag(r), cols: lc }; }) };
    const read = now.reduce((a, r) => a + r.sources.filter((s) => !s.cited).length, 0);
    R.kpis = [kp("Cited pages", f0(tot), "links in " + f0(n) + " answers", prev ? dlt(tot, prev.reduce((a, r) => a + r.sources.filter((s) => s.cited).length, 0) * scale, "n") : null, "Every page the engines linked in their answers."), kp("Read only", f0(read), "pages opened, never linked", null, "Pages the engine opened while searching but did not cite: the gap between read and credited."), kp("Sites cited", f0(dNow.size), "different domains", null, "Distinct domains cited."), kp("Per answer", f1(tot / Math.max(1, n)), "cited pages, on average", null, "Cited pages ÷ answers."), KP.srcv];
  }

  if (page === "community") {
    const tb = tabsOf("cm", [["reddit", "Reddit"], ["yt", "YouTube"]], "reddit");
    const red = []; now.forEach((r) => r.sources.forEach((s) => { if (s.sub && s.cited) red.push({ r, s }); }));
    const sm = new Map(); red.forEach(({ r, s }) => { const e = sm.get(s.sub) || { n: 0, th: new Set(), ans: new Set(), you: 0 }; e.n++; e.th.add(s.url); if (!e.ans.has(r.id)) { e.ans.add(r.id); if (r.brands.some((x) => x.id === view.id)) e.you++; } sm.set(s.sub, e); });
    const subs = [...sm.entries()].sort((a, b) => b[1].n - a[1].n); const mx = subs.length ? subs[0][1].n : 1;
    const sc = "minmax(170px,1.4fr) minmax(130px,1.4fr) 70px 110px 110px";
    const cmchart = line("red", subs.slice(0, 5).map(([sub], i) => ({ id: sub, label: sub, color: PALETTE[i], vals: bucketRecs.map((rs) => (rs.length ? rs.reduce((a, r) => a + r.sources.filter((s) => s.cited && s.sub === sub).length, 0) : null)) })), { fmt: f0, floor: 0 });
    const tt = tabsOf("th", [["top", "Most cited"], ["new", "New this period"]], "top");
    const thm = new Map(); red.forEach(({ s }) => { const e = thm.get(s.url) || { s, n: 0 }; e.n++; thm.set(s.url, e); });
    const firstCit = new Map(); filtered.forEach((r) => r.sources.forEach((s) => { if (s.sub && s.cited) { const f = firstCit.get(s.url); if (f == null || r.run < f) firstCit.set(s.url, r.run); } }));
    let th = [...thm.values()].sort((a, b) => b.n - a.n);
    if (tt.cur === "new") th = NR < 2 ? [] : th.filter((e) => { const f = firstCit.get(e.s.url); return vr.has(f) && f > 0; });
    const thc = "minmax(220px,2fr) minmax(140px,1fr) 70px 90px";
    const yt = []; now.forEach((r) => r.sources.forEach((s) => { if (s.yt && s.cited) yt.push({ r, s }); }));
    const vm = new Map(); yt.forEach(({ r, s }) => { const e = vm.get(s.url) || { s, n: 0, ps: new Set(), engs: new Set(), you: 0, ans: new Set() }; e.n++; e.ps.add(r.p); e.engs.add(r.e); if (!e.ans.has(r.id)) { e.ans.add(r.id); if (r.brands.some((x) => x.id === view.id)) e.you++; } vm.set(s.url, e); });
    const vids = [...vm.values()].sort((a, b) => b.n - a.n); const vmx = vids.length ? vids[0].n : 1;
    const yc = "minmax(240px,2fr) minmax(160px,1.2fr) minmax(110px,1fr) 70px 90px 110px";
    const ansRed = new Set(red.map((x) => x.r.id)).size, ansYt = new Set(yt.map((x) => x.r.id)).size;
    R.cm = { tabs: tb.list, isReddit: tb.cur === "reddit", isYt: tb.cur === "yt", chart: cmchart, subCols: sc, noSubs: !subs.length, noVids: !vids.length, subs: subs.slice(0, 10).map(([s, e]) => ({ name: s, n: e.n, w: pct(e.n, mx).toFixed(1), threads: e.th.size, share: fp(pct(e.ans.size, n)), you: e.ans.size ? fp(pct(e.you, e.ans.size)) : "—", cols: sc })), thTabs: tt.list, thCols: thc, threads: th.slice(0, 10).map((e) => ({ title: e.s.title, url: e.s.url, sub: e.s.sub, n: e.n, first: "Run " + (firstCit.get(e.s.url) + 1), cols: thc })), noThreads: !th.length, noThMsg: tt.cur === "new" && NR < 2 ? LOCK.newth.msg : tt.cur === "new" ? "No thread was cited for the first time in this period." : "No Reddit thread was cited in these answers.", ytCols: yc, videos: vids.slice(0, 10).map((e) => ({ title: e.s.title, url: e.s.url, n: e.n, w: pct(e.n, vmx).toFixed(1), p: e.ps.size, engs: [...e.engs].map(engMark), you: fp(pct(e.you, e.ans.size)), cols: yc })) };
    R.kpis = tb.cur === "reddit"
      ? [kp("Subreddits cited", f0(sm.size), "different communities", null, "Distinct subreddits among cited Reddit threads."), kp("Top subreddit", subs[0] ? subs[0][0] : "—", subs[0] ? subs[0][1].n + " citations" : "", null, "The subreddit cited most often."), kp("Answers citing Reddit", f0(ansRed), fp(pct(ansRed, n)) + " of " + f0(n) + " answers", null, "Answers that linked at least one Reddit thread."), kp("Threads cited", f0(thm.size), "different threads", null, "Distinct Reddit threads cited.")]
      : [kp("Videos cited", f0(vm.size), "different videos", null, "Distinct YouTube videos cited."), kp("Answers citing YouTube", f0(ansYt), fp(pct(ansYt, n)) + " of " + f0(n) + " answers", null, "Answers that linked at least one video."), kp("Top video", vids[0] ? vids[0].n + " citations" : "—", vids[0] ? vids[0].s.title : "", null, "The video cited most often.")];
  }

  if (page === "impact") {
    const tb = tabsOf("im", [["sites", "Sites"], ["pages", "Pages"]], "sites");
    const key = (s) => (tb.cur === "sites" ? s.d : s.url);
    const m = new Map(); now.forEach((r) => { const seen = new Set(); r.sources.forEach((s) => { if (!s.cited) return; const k = key(s); if (seen.has(k)) return; seen.add(k); const e = m.get(k) || { s, n: 0, named: 0, pos: [] }; e.n++; const y = r.brands.find((x) => x.id === view.id); if (y) { e.named++; if (y.rank != null) e.pos.push(y.rank); } m.set(k, e); }); });
    const overall = me.vis || 0;
    let rows = [...m.values()].filter((e) => e.n >= 3).map((e) => ({ e, vis: pct(e.named, e.n), imp: pct(e.named, e.n) - overall }));
    const so = sorter("im", ["n", "vis", "imp"], { k: "n", d: -1 });
    const kf = { n: (r) => r.e.n, vis: (r) => r.vis, imp: (r) => r.imp }; rows.sort((a, b) => (kf[so.cur.k](a) - kf[so.cur.k](b)) * so.cur.d);
    const pg = pager("im", rows.length); const mx = Math.max(1, ...rows.map((r) => r.e.n));
    const cols = "minmax(240px,2fr) minmax(120px,1fr) minmax(120px,1.2fr) 120px 90px 120px";
    R.im = { tabs: tb.list, s: so.s, cols, pg, h1: tb.cur === "sites" ? "Site" : "Page", foot: view.name + " is named in " + fp(overall) + " of all answers in view. Sites cited fewer than 3 times are left out.", rows: rows.slice(pg.from, pg.to).map(({ e, vis, imp }) => ({ a: tb.cur === "sites" ? e.s.d : e.s.url, full: e.s.url, k: e.s.k, kc: KINDC[e.s.k], n: e.n, w: pct(e.n, mx).toFixed(1), vis: fp(vis), imp: (imp >= 0 ? "+" : "−") + Math.abs(Math.round(imp)) + " pts", ic: Math.abs(imp) < 0.5 ? "same" : imp > 0 ? "up" : "down", pos: f1(avg(e.pos)), cols })) };
    const latestRecs = []; PROMPTS.forEach((_, pi) => engs.forEach((e) => { const r = newest(pi, e); if (r) latestRecs.push(r); }));
    const lpg = pager("la", latestRecs.length); const lc = "minmax(220px,2fr) 110px 80px minmax(150px,1.2fr) 90px minmax(200px,1.6fr)";
    R.la = { cols: lc, pg: lpg, rows: latestRecs.slice(lpg.from, lpg.to).map((r) => { const y = r.brands.find((x) => x.id === view.id); const card = r.products.find((p) => p.brand === view.id); const cs = r.sources.find((s) => s.cited && s.b === view.id); const em = engMark(r.e); return { prompt: ptext(r.p), open: openPrompt(r.p), el: em.label, ed: em.d, est: em.st, pos: y ? (y.rank != null ? y.rank : "•") : "–", pc: y ? (y.rank === 1 ? "first" : "") : "miss", card: card ? card.name + " · slot " + card.pos : r.products.length ? "Cards shown, none of " + view.name : "—", cited: cs ? "Cited" : "—", cc: cs ? "cited" : "", url: cs ? cs.url : "", cols: lc }; }) };
    const best = rows.slice().sort((a, b) => b.imp - a.imp)[0];
    R.kpis = [KP.vis, KP.cit, kp("Most helpful site", best ? best.e.s.d : "—", best ? view.name + " named in " + fp(best.vis) + " of answers citing it" : "no site cited 3+ times", null, "The cited site with the highest visibility for the brand when it is cited (3+ citations)."), KP.srcv];
  }

  if (page === "products") {
    const sc = tabsOf("pds", [["all", "All brands"], ["view", view.name + " only"]], "all");
    const cards = []; now.forEach((r) => r.products.forEach((p) => cards.push({ r, p })));
    const pcards = prev ? [].concat(...prev.map((r) => r.products)) : [];
    const pm = new Map(); cards.forEach(({ r, p }) => { const e = pm.get(p.name) || { name: p.name, brand: p.brand, n: 0, pos: [], prices: [], engs: new Set() }; e.n++; e.pos.push(p.pos); if (p.price != null) e.prices.push(p); e.engs.add(r.e); pm.set(p.name, e); });
    const scale = prev && prev.length ? n / prev.length : 1;
    const tile = (e) => (e.brand ? lg(bOf(e.brand)) : brandTile({ name: e.name }));
    // Prices: the currency most cards were in, so amounts in different currencies are never mixed.
    const priceOf = (ps) => { if (!ps.length) return null; const byCur = new Map(); ps.forEach((p) => byCur.set(p.cur, (byCur.get(p.cur) || []).concat([p.price]))); const [cur, xs] = [...byCur.entries()].sort((a, b) => b[1].length - a[1].length)[0]; return { cur, med: median(xs), lo: Math.min(...xs), hi: Math.max(...xs) }; };
    const money = (v, cur) => (v == null ? "—" : formatMoney(v, cur || null));
    let rows = [...pm.values()]; if (sc.cur === "view") rows = rows.filter((e) => e.brand === view.id);
    const so = sorter("pd", ["shown", "share", "pos"], { k: "shown", d: -1 });
    const kf = { shown: (e) => e.n, share: (e) => e.n, pos: (e) => avg(e.pos) }; rows.sort((a, b) => (kf[so.cur.k](a) - kf[so.cur.k](b)) * so.cur.d);
    const pg = pager("pd", rows.length); const mx = Math.max(1, ...rows.map((e) => e.n));
    const cols = "28px minmax(170px,1.6fr) 60px minmax(120px,1.3fr) 66px 96px 80px";
    R.pd = { scope: sc.list, s: so.s, cols, pg, none: !cards.length, rows: rows.slice(pg.from, pg.to).map((e, i) => { const pn = pcards.filter((p) => p.name === e.name).length * scale; const pr = priceOf(e.prices); return { i: pg.from + i + 1, name: e.name, ...tile(e), cls: e.brand === view.id ? "you" : "", shown: e.n, share: fp(pct(e.n, cards.length)), w: pct(e.n, mx).toFixed(1), pos: f1(avg(e.pos)), price: pr ? money(pr.med, pr.cur) : "—", dd: prev ? dlt(e.n, pn, "n") : { t: "", c: "none" }, cols }; }) };
    const mine = cards.filter((x) => x.p.brand === view.id);
    const dm = new Map(); mine.forEach(({ p }) => { if (p.merchant) dm.set(p.merchant, (dm.get(p.merchant) || 0) + 1); });
    const ownStore = (nm) => !!ownDom && (normName(nm).includes(normName(ownDom.split(".")[0])) || wordRe(view.name).test(nm));
    const dl = [...dm.entries()].sort((a, b) => b[1] - a[1]); const dmx = dl.length ? dl[0][1] : 1;
    R.pd.dest = dl.map(([nm, k]) => ({ name: ownStore(nm) ? nm + " (own store)" : nm, n: k, w: pct(k, dmx).toFixed(1), bc: ownStore(nm) ? "" : "a", fw: ownStore(nm) ? 700 : 400 }));
    const ownN = dl.filter(([nm]) => ownStore(nm)).reduce((a, [, k]) => a + k, 0);
    R.pd.destNote = mine.length ? ownN + " of " + mine.length + " " + view.name + " cards list its own store. " + (dl[0] && !ownStore(dl[0][0]) ? dl[0][0] + " gets most of the clicks the engines send." : "") : "No card in these answers is " + view.name + "’s.";
    const withCards = now.filter((r) => r.products.length).length;
    const myPrice = priceOf(mine.map((x) => x.p).filter((p) => p.price != null));
    R.pd.tiles = [{ label: "Answers with cards", value: withCards + " of " + n, sub: fp(pct(withCards, n)) + " showed a carousel" }, { label: "Median price, " + view.name, value: myPrice ? money(myPrice.med, myPrice.cur) : "—", sub: "across its cards" }, { label: "Cards per answer", value: f1(cards.length / Math.max(1, withCards)), sub: "when cards are shown" }];
    const topP = [...pm.values()].sort((a, b) => b.n - a.n).slice(0, 12);
    const shareNow = (e) => pct(e.n, cards.length); const sharePrev = (e) => (pcards.length ? pct(pcards.filter((p) => p.name === e.name).length, pcards.length) : null);
    const bub = topP.map((e) => ({ e, ch: sharePrev(e) == null ? null : shareNow(e) - sharePrev(e) }));
    const ext = Math.max(2, ...bub.map((b) => Math.abs(b.ch || 0))) * 1.2, ymax = Math.max(1, ...topP.map(shareNow)) * 1.2;
    R.pb = { zero: 50, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ top: (100 - f * 100).toFixed(1), label: fp(ymax * f) })), x: [-1, -0.5, 0, 0.5, 1].map((f) => ({ left: (50 + f * 50).toFixed(1), label: (f > 0 ? "+" : "") + (ext * f).toFixed(1) + " pts" })), dots: bub.map(({ e, ch }) => { const t = tile(e); return { x: (50 + ((ch || 0) / ext) * 50).toFixed(1), y: (100 - (shareNow(e) / ymax) * 100).toFixed(1), s: Math.round(16 + (e.n / Math.max(1, topP[0].n)) * 22), color: t.color, ini: (e.name[0] || "?").toUpperCase(), tip: e.name + " · " + fp(shareNow(e)) + " card share · " + (ch == null ? "no comparison" : (ch >= 0 ? "+" : "") + ch.toFixed(1) + " pts") }; }), foot: cmpShort ? "Change " + cmpShort + " · colour = brand" : "Pick a comparison to see change" };
    R.pt = line("prod", topP.slice(0, 5).map((e, i) => ({ id: e.name, label: e.name, color: PALETTE[i], vals: bucketRecs.map((rs) => { const cs = [].concat(...rs.map((r) => r.products)); return cs.length ? pct(cs.filter((p) => p.name === e.name).length, cs.length) : null; }) })), { fmt: fp, floor: 0 });
    const rcols = "minmax(170px,1.6fr) minmax(130px,1fr) minmax(130px,1fr) 64px";
    R.pd.rcols = rcols;
    R.pd.ranges = topP.slice(0, 8).map((e) => { const cs = cards.filter((x) => x.p.name === e.name && x.p.price != null); const pr = priceOf(cs.map((x) => x.p)); const lo = pr ? cs.find((x) => x.p.cur === pr.cur && x.p.price === pr.lo) : null, hi = pr ? cs.find((x) => x.p.cur === pr.cur && x.p.price === pr.hi) : null; return { name: e.name, ...tile(e), cls: e.brand === view.id ? "you" : "", lo: pr ? money(pr.lo, pr.cur) : "—", los: lo ? lo.p.merchant : "", hi: pr ? money(pr.hi, pr.cur) : "—", his: hi ? hi.p.merchant : "", stores: new Set(cards.filter((x) => x.p.name === e.name).map((x) => x.p.merchant).filter(Boolean)).size, cols: rcols }; });
    const pruns = byRun.map((_, i) => i).slice(-6);
    R.pd.pruns = pruns.map((i) => ({ label: "R" + (i + 1), tip: "Run " + (i + 1) + " · " + dlab(RUNS[i].startedAt) }));
    R.pd.ptcols = "minmax(170px,1.6fr) repeat(" + pruns.length + ", minmax(72px,1fr)) 96px";
    R.pd.ptrows = topP.slice(0, 8).map((e) => { const prs = pruns.map((i) => priceOf([].concat(...byRun[i].map((r) => r.products)).filter((p) => p.name === e.name && p.price != null))); const known = prs.filter(Boolean); const ch = known.length > 1 && known[0].cur === known[known.length - 1].cur ? known[known.length - 1].med - known[0].med : null; return { name: e.name, ...tile(e), cls: e.brand === view.id ? "you" : "", cells: prs.map((p) => ({ v: p ? money(p.med, p.cur) : "—" })), ch: ch == null || ch === 0 ? "—" : (ch > 0 ? "+" : "−") + money(Math.abs(ch), known[0].cur), cols: R.pd.ptcols }; });
    R.kpis = [kp("Answers with cards", fp(pct(withCards, n)), withCards + " of " + n + " answers", null, "Answers that showed a product carousel."), kp("Its cards", f0(mine.length), "in " + new Set(mine.map((x) => x.r.id)).size + " answers", prev ? dlt(mine.length, pcards.filter((p) => p.brand === view.id).length * scale, "n") : null, "Product cards whose name starts with the brand."), kp("Card share", fp(pct(mine.length, cards.length)), mine.length + " of " + cards.length + " cards", prev ? dlt(pct(mine.length, cards.length), pct(pcards.filter((p) => p.brand === view.id).length, pcards.length), "pts") : null, "The brand’s cards ÷ every card shown."), kp("Avg card slot", f1(avg(mine.map((x) => x.p.pos))), "when shown · 1 = first card", null, "Average position of the brand’s cards in the carousel."), kp("Own store offered", ownN + " of " + mine.length, "cards list " + (ownDom || "its store"), null, "Cards that list the brand’s own store.")];
  }

  if (page === "searches") {
    const qs = []; now.forEach((r) => r.queries.forEach((q) => qs.push({ r, q })));
    const per = engsX.map((e) => { const l = now.filter((r) => r.e === e.id); return { e, k: l.reduce((a, r) => a + r.queries.length, 0), n: l.length }; });
    const mxe = Math.max(1, ...per.map((x) => x.k));
    const nameAny = qs.filter(({ q }) => BR.some((b) => wordRe(b.name).test(q))).length, nameView = qs.filter(({ q }) => wordRe(view.name).test(q)).length;
    const red = qs.filter(({ q }) => /reddit/i.test(q)).length, yr = qs.filter(({ q }) => /\b20\d\d\b/.test(q)).length, site = qs.filter(({ q }) => /site:/i.test(q)).length;
    const qm = new Map(); qs.forEach(({ r, q }) => { const k = q.toLowerCase(); const e = qm.get(k) || { q, n: 0, engs: new Set(), lead: new Map() }; e.n++; e.engs.add(r.e); const f = firstOf(r); if (f) e.lead.set(f.id, (e.lead.get(f.id) || 0) + 1); qm.set(k, e); });
    const rows = [...qm.values()].sort((a, b) => b.n - a.n); const pg = pager("fo", rows.length); const mx = rows.length ? rows[0].n : 1;
    const cols = "minmax(280px,2.4fr) minmax(120px,1fr) 110px 170px";
    R.fo = { cols, pg, sub: f0(qs.length) + " searches behind " + f0(n) + " answers", none: !qs.length, engines: per.map(({ e, k, n: nn }) => ({ label: e.label, d: e.d, st: e.st, pub: e.fan, nopub: !e.fan, n: f0(k), w: pct(k, mxe).toFixed(1), per: f1(k / Math.max(1, nn)) })), tiles: [{ label: "Name a tracked brand", value: fp(pct(nameAny, qs.length)), sub: f0(nameAny) + " searches" }, { label: "Name " + view.name, value: fp(pct(nameView, qs.length)), sub: f0(nameView) + " searches" }, { label: "Add “reddit”", value: fp(pct(red, qs.length)), sub: f0(red) + " searches" }, { label: "Add a year", value: fp(pct(yr, qs.length)), sub: f0(yr) + " searches" }, { label: "Use site:", value: fp(pct(site, qs.length)), sub: f0(site) + " searches" }], rows: rows.slice(pg.from, pg.to).map((e) => { const l = [...e.lead.entries()].sort((a, b) => b[1] - a[1])[0]; return { q: e.q, n: e.n, w: pct(e.n, mx).toFixed(1), engs: [...e.engs].map(engMark), lead: l ? (bOf(l[0]) || { name: "—" }).name : "—", lc: l && l[0] === view.id ? "you" : "", cols }; }) };
    const pubAns = now.filter((r) => engOf(r.e).fan).length;
    R.kpis = [kp("Searches run", f0(qs.length), "by the engines behind the answers", null, "Search queries the engines issued before answering (fan-out). Gemini doesn’t publish them."), kp("Per answer", f1(qs.length / Math.max(1, pubAns)), "on engines that publish them", null, "Searches ÷ answers from engines that publish their searches."), kp("Name " + view.name, fp(pct(nameView, qs.length)), f0(nameView) + " searches", null, "Searches that include the brand’s name."), kp("Distinct searches", f0(qm.size), "after merging repeats", null, "Unique search strings.")];
  }

  if (page === "search") {
    const q = String(S.q || "").trim();
    R.onQ = (ev) => set({ q: ev && ev.target ? ev.target.value : "" });
    R.q = S.q || "";
    const ready = data.search && data.search.q === q;
    const byId = new Map(now.map((r) => [r.id, r]));
    const hits = ready ? data.search.hits.filter((h) => byId.has(h.id)) : [];
    const sugg = [...new Set([...BR.slice(0, 2).map((b) => b.name), ...(now.flatMap((r) => r.products.map((p) => p.name)).slice(0, 2))])].slice(0, 4);
    R.sq = { sugg: sugg.map((s) => ({ label: s, go: () => set({ q: s }) })), title: !q ? "Type and press Enter to search" : !ready ? "Searching…" : hits.length + " answers mention “" + q + "”", sub: q ? "In " + f0(n) + " answers in view" : "", empty: !hits.length, emptyText: !q ? "Results show the passage, the engine, the run and the brands the answer named." : !ready ? "Reading the answers…" : "No answer in view says “" + q + "”. Widen the runs or engines.", rows: hits.slice(0, 20).map((h) => { const r = byId.get(h.id); const em = engMark(r.e); return { prompt: ptext(r.p), open: openPrompt(r.p), el: em.label, ed: em.d, est: em.st, run: "Run " + (r.run + 1) + " · " + dlab(RUNS[r.run].startedAt), pre: h.pre, hit: h.hit, post: h.post, brands: r.brands.slice(0, 5).map((x) => ({ rank: x.rank != null ? "#" + x.rank : "card", name: (bOf(x.id) || { name: x.id }).name, cls: x.id === view.id ? "you" : "" })) }; }) };
    R.kpis = [];
  }

  /* ===================== Go deeper ===================== */
  if (page === "h2h") {
    const others = BR.filter((b) => b.id !== view.id);
    const rv = others.find((b) => b.id === S.rival) || others.slice().sort((a, b) => (M.b[b.id].vis || 0) - (M.b[a.id].vis || 0))[0];
    if (rv) {
      const split = (list) => { const o = { both: 0, me: 0, them: 0, none: 0, meF: 0, themF: 0, n: list.length }; list.forEach((r) => { const a = r.brands.find((x) => x.id === view.id), b = r.brands.find((x) => x.id === rv.id); if (a && b) { o.both++; if (ahead(a, b)) o.meF++; else if (ahead(b, a)) o.themF++; } else if (a) o.me++; else if (b) o.them++; else o.none++; }); return o; };
      const P = (k, s) => (s.n ? pct(s[k], s.n) : 0);
      const al = split(now);
      const tcols = "minmax(140px,1.2fr) 90px 90px 100px", lcols = "minmax(220px,2fr) 110px 80px";
      const lose = new Map(); now.forEach((r) => { const a = r.brands.find((x) => x.id === view.id), b = r.brands.find((x) => x.id === rv.id); if (b && (!a || ahead(b, a))) { const e = lose.get(r.p) || { p: r.p, n: 0, engs: new Set() }; e.n++; e.engs.add(r.e); lose.set(r.p, e); } });
      const quotes = (b) => { const out = [], seen = new Set(); for (const r of now) { const s = r.snips && r.snips[b.id]; if (s && !seen.has(s)) { seen.add(s); out.push({ text: s, src: engOf(r.e).label + " · “" + ptext(r.p) + "”" }); if (out.length >= 3) break; } } return out; };
      R.hh = {
        rivalOpts: others.map((b) => ({ ...lg(b), name: b.name, cls: b.id === rv.id ? "you" : "", go: () => set({ rival: b.id }) })),
        rname: rv.name, rcol: rv.color, tcols, lcols,
        engines: engsX.map((e) => { const s = split(now.filter((r) => r.e === e.id)); return { ...emk(e), rc: rv.color, me: P("me", s).toFixed(1), both: P("both", s).toFixed(1), them: P("them", s).toFixed(1), none: P("none", s).toFixed(1), first: s.both ? Math.round(pct(s.meF, s.both)) + "% / " + Math.round(pct(s.themF, s.both)) + "%" : "—" }; }),
        tags: TAGS.filter((t) => !S.tags.length || S.tags.includes(t)).map((t) => { const l = now.filter((r) => r.tags.includes(t)); if (!l.length) return null; const mm = metrics(l); const a = mm.b[view.id].vis || 0, b = mm.b[rv.id].vis || 0; return { tag: t, me: fp(a), them: fp(b), d: (a - b >= 0 ? "+" : "−") + Math.abs(Math.round(a - b)) + " pts", dc: Math.abs(a - b) < 0.5 ? "same" : a >= b ? "up" : "down", cols: tcols }; }).filter(Boolean),
        lose: [...lose.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((e) => ({ text: ptext(e.p), open: openPrompt(e.p), engs: [...e.engs].map(engMark), n: e.n, cols: lcols })),
        qMe: quotes(view), qThem: quotes(rv),
      };
      R.kpis = [kp("Both named", fp(P("both", al)), f0(al.both) + " of " + f0(al.n) + " answers", null, "Answers that named both brands."), kp("Only " + view.name, fp(P("me", al)), f0(al.me) + " answers", null, "Named the viewed brand and not the rival."), kp("Only " + rv.name, fp(P("them", al)), f0(al.them) + " answers", null, "Named the rival and not the viewed brand."), kp("Neither", fp(P("none", al)), f0(al.none) + " answers", null, "Named neither brand."), kp("First, when both", al.both ? Math.round(pct(al.meF, al.both)) + "%" : "—", view.name + " before " + rv.name + " in " + f0(al.meF) + " of " + f0(al.both), null, "Of the answers naming both, how often the viewed brand came first in the text.")];
    } else R.kpis = [];
  }

  if (page === "changes" && NR < 2) R.kpis = [];
  if (page === "changes" && NR >= 2) {
    const A = S.runA != null && S.runA < NR ? S.runA : NR - 2, Bn = S.runB != null && S.runB < NR ? S.runB : NR - 1;
    const ra = filtered.filter((r) => r.run === A), rb = filtered.filter((r) => r.run === Bn);
    const ma = metrics(ra), mb = metrics(rb);
    const ia = new Map(ra.map((r) => [r.p + "|" + r.e, r]));
    const rows = [];
    const rk = (x) => (x ? (x.rank != null ? x.rank : 50) : null);
    rb.forEach((r) => { const a = ia.get(r.p + "|" + r.e); if (!a) return; const ar = rk(a.brands.find((y) => y.id === view.id)), br = rk(r.brands.find((z) => z.id === view.id)); let st, c; if (ar == null && br == null) return; if (ar == null) { st = "Gained"; c = "up"; } else if (br == null) { st = "Lost"; c = "down"; } else if (br < ar) { st = br === 1 ? "Took first" : "Moved up"; c = "up"; } else if (br > ar) { st = ar === 1 ? "Lost first" : "Moved down"; c = "down"; } else return; rows.push({ r, ar, br, st, c }); });
    const tb = tabsOf("chg", [["all", "All changes"], ["Gained", "Gained"], ["Lost", "Lost"], ["first", "First place"]], "all");
    let shown = rows; if (tb.cur === "Gained" || tb.cur === "Lost") shown = rows.filter((x) => x.st === tb.cur); if (tb.cur === "first") shown = rows.filter((x) => /first/.test(x.st));
    const pg = pager("chg", shown.length);
    const cols = "minmax(220px,2fr) 120px 60px 24px 60px 120px", scols = "minmax(150px,1.4fr) 70px 70px 80px";
    const dcount = (list) => { const m = new Map(); list.forEach((r) => r.sources.forEach((s) => { if (s.cited) m.set(s.d, (m.get(s.d) || 0) + 1); })); return m; };
    const da = dcount(ra), db = dcount(rb);
    const sr = [...new Set([...da.keys(), ...db.keys()])].map((d) => ({ d, a: da.get(d) || 0, b: db.get(d) || 0 })).map((x) => ({ ...x, ch: x.b - x.a }));
    const mkS = (x) => ({ d: x.d, a: x.a, b: x.b, ch: (x.ch > 0 ? "+" : "") + x.ch, c: x.ch > 0 ? "up" : x.ch < 0 ? "down" : "same", kc: KINDC[kindOf(x.d)], cols: scols });
    const cnt = (st) => rows.filter((x) => x.st === st).length;
    const shw = (v) => (v == null ? "–" : v === 50 ? "•" : v);
    R.ch = {
      la: "Run " + (A + 1), lb: "Run " + (Bn + 1), tabs: tb.list, cols, scols, pg, same: A === Bn,
      pickA: RUNS.map((r, i) => ({ label: "Run " + (i + 1) + " · " + dlab(r.startedAt), cls: i === A ? "you" : "", go: () => set({ runA: i }) })),
      pickB: RUNS.map((r, i) => ({ label: "Run " + (i + 1) + " · " + dlab(r.startedAt), cls: i === Bn ? "you" : "", go: () => set({ runB: i }) })),
      rows: shown.slice(pg.from, pg.to).map(({ r, ar, br, st, c }) => { const em = engMark(r.e); return { prompt: ptext(r.p), open: openPrompt(r.p), el: em.label, ed: em.d, est: em.st, a: shw(ar), b: shw(br), ac: ar === 1 ? "first" : ar == null ? "miss" : "", bc: br === 1 ? "first" : br == null ? "miss" : "", st, c, cols }; }),
      engines: engsX.map((e) => { const x = metrics(ra.filter((r) => r.e === e.id)).b[view.id].vis, y = metrics(rb.filter((r) => r.e === e.id)).b[view.id].vis; const dd = (y || 0) - (x || 0); const w = Math.min(50, Math.abs(dd)); return { ...emk(e), a: fp(x), b: fp(y), w: w.toFixed(1), left: dd >= 0 ? "50" : (50 - w).toFixed(1), bg: dd >= 0 ? "var(--green-border)" : "var(--red-border)", dt: (dd >= 0 ? "+" : "−") + Math.abs(Math.round(dd)) + " pts" }; }),
      up: sr.filter((x) => x.ch > 0).sort((x, y) => y.ch - x.ch).slice(0, 6).map(mkS), down: sr.filter((x) => x.ch < 0).sort((x, y) => x.ch - y.ch).slice(0, 6).map(mkS),
    };
    const vb = mb.b[view.id], va = ma.b[view.id];
    R.kpis = [kp("Visibility", fp(vb.vis), "was " + fp(va.vis) + " in Run " + (A + 1), noisy(dlt(vb.vis, va.vis, "pts"), vb.present, mb.n, va.present, ma.n), "Visibility in the second run, against the first."), kp("Gained", f0(cnt("Gained")), "prompt × engine pairs now naming " + view.name, null, "Answered in both runs; named only in the second."), kp("Lost", f0(cnt("Lost")), "pairs that stopped naming it", null, "Answered in both runs; named only in the first."), kp("Took first", f0(cnt("Took first")), "now named first", null, "Named first in the second run, not in the first."), kp("Lost first", f0(cnt("Lost first")), "no longer named first", null, "Named first in the first run, lower in the second.")];
  }

  if (page === "compset") {
    const DC = ["#f2c14e", "var(--accent)", "color-mix(in srgb, var(--accent) 60%, transparent)", "color-mix(in srgb, var(--accent) 30%, transparent)", "var(--line-soft)"], DL = ["Named first", "Second", "Third", "Later, or a card only", "Not named"];
    const dist = BR.map((b) => { const c = [0, 0, 0, 0, 0]; now.forEach((r) => { const x = r.brands.find((y) => y.id === b.id); if (!x) c[4]++; else if (x.rank == null) c[3]++; else c[Math.min(3, x.rank - 1)]++; }); return { b, c }; }).sort((x, y) => n - y.c[4] - (n - x.c[4]));
    const crcols = "minmax(110px,1fr) minmax(140px,1.5fr) 110px 90px";
    const withMe = now.filter((r) => r.brands.some((x) => x.id === view.id));
    const comp = BR.filter((b) => b.id !== view.id).map((b) => ({ b, v: withMe.length ? pct(withMe.filter((r) => r.brands.some((x) => x.id === b.id)).length, withMe.length) : 0 })).sort((a, b) => b.v - a.v)[0];
    R.cs = {
      legend: DL.map((l, i) => ({ label: l, color: DC[i] })),
      dist: dist.map(({ b, c }) => ({ name: b.name, ...lg(b), fw: b.id === view.id ? 700 : 400, first: fp(pct(c[0], n)), named: fp(pct(n - c[4], n)), segs: c.map((k, i) => ({ w: pct(k, n).toFixed(1), bg: DC[i], tip: b.name + " · " + DL[i] + ": " + fp(pct(k, n)) })) })),
      cols: "minmax(110px,1.2fr) " + BR.map(() => "minmax(52px,1fr)").join(" "), head: BR.map((b) => ({ ...lg(b), name: b.name })),
      rows: BR.map((a) => { const la = now.filter((r) => r.brands.some((x) => x.id === a.id)); return { name: a.name, ...lg(a), fw: a.id === view.id ? 700 : 400, cells: BR.map((b) => { if (a.id === b.id) return { v: "—", bg: "transparent", fg: "var(--fg-muted)" }; const v = la.length ? pct(la.filter((r) => r.brands.some((x) => x.id === b.id)).length, la.length) : null; const c = heatC(v); return { v: v == null ? "—" : Math.round(v) + "%", bg: c.bg, fg: c.fg }; }) }; }),
      crcols, crowd: [0, 1, 2, 3, 4, 5, 6].map((k) => { const l = now.filter((r) => (k < 6 ? r.brands.length === k : r.brands.length >= 6)); const mm = metrics(l); return { label: k < 6 ? k + " brand" + (k === 1 ? "" : "s") : "6 or more", n: f0(l.length), w: pct(l.length, n).toFixed(1), vis: l.length ? fp(mm.b[view.id].vis) : "—", pos: l.length ? f1(mm.b[view.id].pos) : "—", cols: crcols }; }),
    };
    const firstMe = now.filter((r) => { const f = firstOf(r); return f && f.id === view.id; }).length;
    R.kpis = [kp("Brands per answer", f1(avg(now.map((r) => r.brands.length))), "tracked brands named, on average", null, "How many tracked brands an answer names."), kp("Named first, when named", fp(pct(firstMe, nameN)), "of " + f0(nameN) + " answers naming " + view.name, null, "Of the answers naming the brand, how often it is named first."), kp("Named alone", f0(now.filter((r) => r.brands.length === 1 && r.brands[0].id === view.id).length), "answers naming only " + view.name, null, "Answers where the viewed brand is the only tracked brand named."), kp("Most frequent companion", comp ? comp.b.name : "—", comp ? "in " + fp(comp.v) + " of answers naming " + view.name : "", null, "The brand most often named in the same answer as the viewed brand.")];
  }

  if (page === "stability") {
    const all = PROMPTS.map((pr, pi) => { if (S.tags.length && !pr.tags.some((t) => S.tags.includes(t))) return null; const cells = engsX.map((e) => { const r = newest(pi, e.id); const f = r ? firstOf(r) : null; const fb = f ? bOf(f.id) : null; return { ...emk(e), name: fb ? fb.name : r ? "Nobody" : "No answer", cls: fb && fb.id === view.id ? "you" : fb ? "" : "read", top: r ? r.brands.filter((x) => x.rank != null).slice(0, 3).map((x) => x.id) : [] }; }); const names = cells.map((c) => c.name).filter((x) => x !== "No answer"); return { pi, text: pr.text, cells, agree: names.length > 1 && new Set(names).size === 1, kinds: new Set(names).size, answered: names.length }; }).filter(Boolean);
    let trans = 0, flips = 0; const perE = {}, perP = new Map(); engsX.forEach((e) => { perE[e.id] = { t: 0, f: 0 }; });
    PROMPTS.forEach((_, pi) => engsX.forEach((e) => { let prevP = null; for (let k = 0; k < NR; k++) { const r = byRun[k].find((x) => x.p === pi && x.e === e.id); if (!r) continue; const pres = r.brands.some((x) => x.id === view.id); if (prevP != null) { trans++; perE[e.id].t++; if (pres !== prevP) { flips++; perE[e.id].f++; perP.set(pi, (perP.get(pi) || 0) + 1); } } prevP = pres; } }));
    const tb = tabsOf("stab", [["all", "All prompts"], ["dis", "Engines disagree"], ["agree", "Engines agree"]], "all");
    let rr = all; if (tb.cur === "dis") rr = rr.filter((r) => !r.agree && r.answered > 1); if (tb.cur === "agree") rr = rr.filter((r) => r.agree);
    const pg = pager("stab", rr.length);
    const acols = "minmax(220px,2fr) " + engsX.map(() => "minmax(92px,1fr)").join(" ") + " 100px";
    const hl = all.slice().sort((a, b) => (perP.get(b.pi) || 0) - (perP.get(a.pi) || 0));
    const hp = pager("hist", hl.length);
    const hcols = "minmax(220px,2fr) repeat(" + NR + ", minmax(30px,1fr)) 64px";
    R.sb = {
      tabs: tb.list, pg, acols, engHead: engsX.map(emk), hcols, hpg: hp,
      rows: rr.slice(pg.from, pg.to).map((r) => ({ text: r.text, open: openPrompt(r.pi), cells: r.cells, ag: r.agree ? "Agree" : r.answered < 2 ? "One engine" : r.kinds + " different", agc: r.agree ? "cited" : "read", cols: acols })),
      runHead: RUNS.map((r, i) => ({ label: "R" + (i + 1), tip: "Run " + (i + 1) + " · " + dlab(r.startedAt) })),
      hist: hl.slice(hp.from, hp.to).map((x) => ({ text: x.text, open: openPrompt(x.pi), flips: perP.get(x.pi) || 0, cols: hcols, cells: byRun.map((list0, k) => { const list = list0.filter((r) => r.p === x.pi); const ranks = list.map((r) => { const y = r.brands.find((z) => z.id === view.id); return y ? (y.rank != null ? y.rank : 50) : null; }).filter((v) => v != null); const best = ranks.length ? Math.min(...ranks) : null; return { v: best == null ? (list.length ? "–" : "") : best === 50 ? "•" : best, cls: best === 1 ? "first" : best == null ? "miss" : "", tip: "Run " + (k + 1) + ": " + (best == null ? (list.length ? "not named" : "no answer") : best === 50 ? "shown as a card" : "best #" + best + " across engines") }; }) })),
      flipE: engsX.map((e) => ({ ...emk(e), v: fp(pct(perE[e.id].f, perE[e.id].t)), w: Math.min(100, pct(perE[e.id].f, perE[e.id].t) * 2).toFixed(1) })),
    };
    const sameDiff = []; all.forEach((p) => { const lists = p.cells.map((c, i) => ({ e: engsX[i], top: c.top })).filter((l) => l.top.length >= 2); const groups = new Map(); lists.forEach((l) => { const key = l.top.slice().sort().join("|"); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(l); }); for (const g of groups.values()) { if (g.length >= 2 && new Set(g.map((l) => l.top.join(">"))).size > 1) { sameDiff.push({ p, g }); break; } } });
    R.sb.same = sameDiff.slice(0, 8).map(({ p, g }) => ({ text: p.text, open: openPrompt(p.pi), rows: g.map((l) => ({ ...emk(l.e), order: l.top.map((id) => (bOf(id) || { name: id }).name).join(" › "), cls: l.top[0] === view.id ? "you" : "" })) }));
    R.sb.sameN = sameDiff.length + " of " + all.length + " prompts" + (sameDiff.length > 8 ? " · first 8 shown" : "");
    R.sb.noSame = !sameDiff.length;
    const multi = all.filter((r) => r.answered > 1);
    const vol = hl[0];
    R.kpis = [kp("Engines agree on #1", multi.length ? fp(pct(multi.filter((r) => r.agree).length, multi.length)) : "—", multi.filter((r) => r.agree).length + " of " + multi.length + " prompts, newest answers in view", null, "Prompts where every engine that answered named the same brand first."),
      NR < 2 ? kp("Stable run to run", "—", "opens after 2 runs", null, LOCK.history.msg) : kp("Stable run to run", fp(100 - pct(flips, trans)), "answers keep " + view.name + " in or out", null, "Share of consecutive-run pairs (same prompt, same engine) where the brand was named both times or neither time."),
      NR < 2 ? kp("Flips", "—", "opens after 2 runs", null, LOCK.history.msg) : kp("Flips", f0(flips), "in or out of an answer, across " + NR + " runs", null, "Times a prompt on an engine switched between naming and not naming the brand."),
      NR < 2 || !vol || !perP.get(vol.pi) ? kp("Most volatile prompt", "—", NR < 2 ? "opens after 2 runs" : "no prompt flipped", null, "The prompt whose answers switched most often.") : kp("Most volatile prompt", perP.get(vol.pi) + " flips", vol.text, null, "The prompt whose answers switched most often.")];
  }

  if (page === "funnel") {
    const ownS = (r, cited) => r.sources.some((s) => s.b === view.id && (!cited || s.cited));
    const stages = (list) => [list.length, list.filter((r) => r.sources.length).length, list.filter((r) => ownS(r)).length, list.filter((r) => ownS(r, true)).length, list.filter((r) => ownS(r, true) && r.brands.some((x) => x.id === view.id)).length];
    const st = stages(now); const SL = ["Answers in view", "Searched the web", "Read " + (ownDom || "its site"), "Cited " + (ownDom || "its site"), "Cited it and named " + view.name];
    const fcols = "minmax(120px,1fr) repeat(4, minmax(84px,1fr))";
    const pm = new Map(); now.forEach((r) => r.sources.forEach((s) => { if (s.b !== view.id) return; const e = pm.get(s.url) || { url: s.url, read: 0, cited: 0, engs: new Set() }; if (s.cited) e.cited++; else e.read++; e.engs.add(r.e); pm.set(s.url, e); }));
    const pcols = "minmax(240px,2fr) 70px 70px 90px 110px";
    const kr = KIND_GROUPS.map((k) => { let c = 0, rd = 0; now.forEach((r) => r.sources.forEach((s) => { if (s.k !== k) return; if (s.cited) c++; else rd++; })); return { k, c, rd }; }).filter((x) => x.c + x.rd);
    R.fn = {
      noSite: !ownDom,
      stages: st.map((k, i) => ({ label: SL[i], n: f0(k), w: pct(k, st[0]).toFixed(1), share: fp(pct(k, st[0])), step: i ? fp(pct(k, st[i - 1])) + " of the step before" : "", bg: i === 0 ? "var(--line-soft)" : i < 3 ? "var(--indigo-border)" : "var(--green-border)" })),
      fcols, engines: engsX.map((e) => { const s = stages(now.filter((r) => r.e === e.id)); return { ...emk(e), cells: [1, 2, 3, 4].map((i) => ({ v: fp(pct(s[i], s[0])), sub: f0(s[i]) + " answers" })), cols: fcols }; }),
      pcols, pages: [...pm.values()].sort((a, b) => b.read - b.cited - (a.read - a.cited)).slice(0, 8).map((e) => ({ url: e.url, read: e.read, cited: e.cited, rate: fp(pct(e.cited, e.cited + e.read)), rc: e.cited ? "" : "bad", engs: [...e.engs].map(engMark), cols: pcols })), noPages: !pm.size,
      kinds: kr.map((x) => ({ label: x.k, color: KINDC[x.k], w: pct(x.c, x.c + x.rd).toFixed(1), rate: fp(pct(x.c, x.c + x.rd)), sub: f0(x.c) + " cited · " + f0(x.rd) + " read only" })),
    };
    const onlyRead = [...pm.values()].filter((e) => !e.cited).length;
    R.kpis = [kp("Read " + (ownDom || "its site"), fp(pct(st[2], st[0])), f0(st[2]) + " of " + f0(st[0]) + " answers", null, "Answers where the engine opened a page of the brand’s site, cited or not."), kp("Cited when read", fp(pct(st[3], st[2])), f0(st[3]) + " of " + f0(st[2]), null, "Of the answers that read the site, how many linked it."), kp("Named when cited", fp(pct(st[4], st[3])), f0(st[4]) + " of " + f0(st[3]), null, "Of the answers that linked the site, how many also named the brand."), kp("Pages read, never cited", f0(onlyRead), "of " + f0(pm.size) + " pages of " + (ownDom || "its site"), null, "Pages of the brand’s site the engines opened but never linked, in the answers in view.")];
  }

  if (page === "content") {
    const cited = [], allS = []; now.forEach((r) => r.sources.forEach((s) => { allS.push({ r, s }); if (s.cited) cited.push({ r, s }); }));
    const ptype = (s) => (s.yt ? "Video" : pageTypeOf("https://" + s.url));
    const types = new Map(); allS.forEach(({ s }) => { const t = ptype(s); const e = types.get(t) || { t, c: 0, rd: 0 }; if (s.cited) e.c++; else e.rd++; types.set(t, e); });
    const tl = [...types.values()].sort((a, b) => b.c - a.c); const tm = Math.max(1, ...tl.map((x) => x.c));
    const tcols = "minmax(130px,1.1fr) minmax(140px,1.5fr) 80px 90px";
    const BANDS = [["Under a month", 31], ["1–3 months", 92], ["3–6 months", 183], ["6–12 months", 366], ["Over a year", Infinity]], BC = ["var(--green-fg)", "var(--kind-review)", "var(--kind-retail)", "var(--kind-rival)", "var(--red-fg)"];
    const dated = cited.filter((x) => x.s.age != null); const bc = BANDS.map(() => 0); dated.forEach((x) => { bc[BANDS.findIndex((b) => x.s.age <= b[1])]++; });
    const ecols = "minmax(120px,1fr) minmax(140px,1.4fr) 110px";
    const pm = new Map(); cited.forEach(({ s }) => { const e = pm.get(s.url) || { s, n: 0, age: null }; e.n++; if (s.age != null) e.age = s.age; pm.set(s.url, e); });
    const pl = [...pm.values()].sort((a, b) => b.n - a.n); const pg = pager("ctp", pl.length);
    const pcols = "minmax(240px,2fr) 120px 110px 70px";
    const mm = new Map(); let checked = 0;
    now.forEach((r) => { if (!r.queries.length) return; r.sources.forEach((s) => { checked++; if (titleMatchesQueries(s.title, r.queries) !== false) return; const e = mm.get(s.url) || { s, c: 0, rd: 0, engs: new Set() }; if (s.cited) e.c++; else e.rd++; e.engs.add(r.e); mm.set(s.url, e); }); });
    const mmTot = [...mm.values()].reduce((a, e) => a + e.c + e.rd, 0);
    const mcols = "minmax(220px,1.6fr) minmax(200px,1.4fr) 60px 80px 110px";
    R.ct = {
      tcols, types: tl.map((x) => ({ label: x.t, n: f0(x.c), w: pct(x.c, tm).toFixed(1), share: fp(pct(x.c, cited.length)), rate: fp(pct(x.c, x.c + x.rd)), cols: tcols })),
      bands: BANDS.map((b, i) => ({ label: b[0], n: f0(bc[i]), w: pct(bc[i], Math.max(1, ...bc)).toFixed(1), share: fp(pct(bc[i], dated.length)), color: BC[i] })),
      covN: f0(dated.length) + " of " + f0(cited.length),
      ecols, engines: engsX.map((e) => { const l = cited.filter((x) => x.r.e === e.id); const dl = l.filter((x) => x.s.age != null); return { ...emk(e), cov: pct(dl.length, l.length).toFixed(1), covt: fp(pct(dl.length, l.length)), med: dl.length ? ageLabel(median(dl.map((x) => x.s.age))) : "—", cols: ecols }; }),
      pcols, pg, pages: pl.slice(pg.from, pg.to).map((e) => ({ url: e.s.url, kc: KINDC[e.s.k], type: ptype(e.s), age: e.age == null ? "No date" : ageLabel(e.age), ac: e.age == null ? "" : e.age <= 92 ? "cited" : e.age > 366 ? "bad" : "read", n: e.n, cols: pcols })),
      mcols, mmSub: f0(mmTot) + " of " + f0(checked) + " sources checked", mism: [...mm.values()].sort((a, b) => b.c + b.rd - (a.c + a.rd)).slice(0, 8).map((e) => ({ title: e.s.title, url: e.s.url, c: e.c, rd: e.rd, engs: [...e.engs].map(engMark), cols: mcols })), noMism: !mm.size,
    };
    R.kpis = [kp("Cited pages with a date", fp(pct(dated.length, cited.length)), f0(dated.length) + " of " + f0(cited.length) + " citations", null, "Perplexity sends a page date with most sources; other engines rarely. Ages are only shown where a date came with the answer, never guessed."), kp("Median age", ageLabel(median(dated.map((x) => x.s.age))), "of dated cited pages", null, "Half the dated cited pages are younger than this."), kp("Under 3 months", fp(pct(bc[0] + bc[1], dated.length)), "of dated cited pages", null, "Share of dated cited pages published in the 92 days before the answer."), kp("Most-cited page type", tl[0] ? tl[0].t : "—", tl[0] ? fp(pct(tl[0].c, cited.length)) + " of citations" : "", null, "Page type is read from the URL: list of picks, review, comparison, product page, discussion, video.")];
  }

  if (page === "surfaces") {
    const tb = tabsOf("surf", [["ads", "Ads in answers"], ["images", "Images"], ["local", "Local & maps"]], "ads");
    const chat = now.filter((r) => r.e === "chatgpt"); const withAd = chat.filter((r) => r.ads.length);
    const am = new Map(); withAd.forEach((r) => r.ads.forEach((a) => { const e = am.get(a.adv) || { a, n: 0, ps: new Set(), named: 0, cited: 0 }; e.n++; e.ps.add(r.p); if (a.named) e.named++; if (a.cited) e.cited++; am.set(a.adv, e); }));
    const acols = "minmax(140px,1.2fr) 100px 60px 70px 120px 100px";
    const imgs = []; now.forEach((r) => r.images.forEach((im) => imgs.push({ r, im })));
    const hm = new Map(); imgs.forEach(({ im }) => { if (im.host) hm.set(im.host, (hm.get(im.host) || 0) + 1); }); const hl = [...hm.entries()].sort((a, b) => b[1] - a[1]); const hmx = hl.length ? hl[0][1] : 1;
    const isOwnHost = (h) => !!ownDom && domainMatches(h, ownDom);
    const mineI = imgs.filter((x) => x.im.brand === view.id);
    const loc = now.filter((r) => r.places.length); const pl = []; loc.forEach((r) => r.places.forEach((p) => pl.push({ r, p })));
    const ppm = new Map(); pl.forEach(({ p }) => { const e = ppm.get(p.name) || { p, n: 0, pos: [] }; e.n++; e.pos.push(p.pos); ppm.set(p.name, e); });
    const myPins = pl.filter((x) => x.p.brand === view.id);
    const lcols = "minmax(200px,1.6fr) 80px 90px 70px";
    R.sf = {
      tabs: tb.list, isAds: tb.cur === "ads", isImg: tb.cur === "images", isLoc: tb.cur === "local", acols, lcols,
      adNote: "Ads appear only in ChatGPT answers. " + f0(withAd.length) + " of " + f0(chat.length) + " ChatGPT answers in view carried one.", noAds: !am.size, noImgs: !imgs.length, noLoc: !pl.length,
      ads: [...am.values()].sort((x, y) => y.n - x.n).map((e) => ({ name: e.a.adv, role: e.a.brand === view.id ? "This brand" : e.a.brand ? "Tracked rival" : "Other", rc: e.a.brand === view.id ? "you" : e.a.brand ? "bad" : "", n: e.n, p: e.ps.size, named: fp(pct(e.named, e.n)), cited: fp(pct(e.cited, e.n)), cols: acols })),
      hosts: hl.slice(0, 10).map(([h, k]) => ({ name: isOwnHost(h) ? h + " (its site)" : h, n: k, w: pct(k, hmx).toFixed(1), bc: isOwnHost(h) ? "" : "a", fw: isOwnHost(h) ? 700 : 400 })),
      imgTiles: [{ label: "Image-led answers", value: f0(now.filter((r) => r.kind === "images").length), sub: "of " + f0(n) + " answers" }, { label: "Images shown", value: f0(imgs.length), sub: "in " + f0(new Set(imgs.map((x) => x.r.id)).size) + " answers" }, { label: "Of " + view.name, value: f0(mineI.length), sub: fp(pct(mineI.length, imgs.length)) + " of images" }, { label: "From " + (ownDom || "its site"), value: f0(mineI.filter((x) => x.im.host && isOwnHost(x.im.host)).length), sub: "of its " + f0(mineI.length) + " images" }],
      places: [...ppm.values()].sort((a, b) => b.n - a.n).slice(0, 12).map((e) => ({ name: e.p.name, n: e.n, pos: f1(avg(e.pos)), rating: e.p.rating ? e.p.rating.toFixed(1) + " ★" : "—", cls: e.p.brand === view.id ? "you" : "", cols: lcols })),
      locTiles: [{ label: "Answers with a map", value: f0(loc.length), sub: "of " + f0(n) + " answers" }, { label: "Pin share", value: pl.length ? fp(pct(myPins.length, pl.length)) : "—", sub: f0(myPins.length) + " of " + f0(pl.length) + " pins" }, { label: "Avg pin position", value: f1(avg(myPins.map((x) => x.p.pos))), sub: "when pinned" }, { label: "Website on its pin", value: myPins.length ? myPins.filter((x) => x.p.site).length + " of " + myPins.length : "—", sub: "links to " + (ownDom || "its site") }],
    };
    const ownAds = withAd.filter((r) => r.ads.some((a) => a.brand === view.id)).length, rivAds = withAd.filter((r) => r.ads.some((a) => a.brand && a.brand !== view.id)).length;
    R.kpis = [kp("ChatGPT answers with an ad", fp(pct(withAd.length, chat.length)), f0(withAd.length) + " of " + f0(chat.length), null, "Answers where ChatGPT showed a sponsored placement."), kp(view.name + " ads", f0(ownAds), "answers carrying its ad", null, "Ads whose advertiser is the viewed brand."), kp("Rivals’ ads", f0(rivAds), "answers carrying a tracked rival’s ad", null, "Ads from tracked rivals."), kp("Images of " + view.name, f0(mineI.length), "of " + f0(imgs.length) + " images shown", null, "Images whose title names the brand."), kp("Pin share", pl.length ? fp(pct(myPins.length, pl.length)) : "—", f0(myPins.length) + " of " + f0(pl.length) + " map pins", null, "The brand’s places ÷ every place pinned.")];
  }

  if (page === "intent") {
    // Each search counts once, under its first intent in this order; the labels are Analyze's own (fanout.js classifyQuery).
    const QI = [["site", "Site-restricted", "site:", "#64748b"], ["community", "Community & forums", "reddit, forum, quora", "#e87ba4"], ["comparison", "Comparisons", "vs, compare", "#eb6834"], ["review", "Reviews & ratings", "review, rating", "#1baf7a"], ["pricing", "Price & budget", "price, under, budget", "#d99a00"], ["availability", "Where to buy & deals", "buy, deal, offer", "#9c2f5f"], ["specs", "Specs & features", "battery, camera…", "#0e7490"], ["commercial", "Best & recommended", "best, top", "#2a78d6"], ["howto", "How-to", "how to, guide", "#4a3aa7"], ["definition", "Explainers", "what is", "#8a6d3b"], ["official", "Official site", "official, website", "#12796d"], ["fresh", "Freshness", "a year, latest", "#b45309"], ["brand", "Brand or model lookup", "names a tracked brand", "#7a52c7"], ["other", "Other", "none of the above", "#a9aeb6"]];
    const qIntent = (q) => { if (parseQueryOperators(q).siteIncludes.length) return "site"; if (/reddit|forum|quora/i.test(q)) return "community"; const c = classifyQuery(q); for (const [id] of QI.slice(2, 11)) if (c.labels.includes(id)) return id; if (c.temporal) return "fresh"; if (BR.some((b) => wordRe(b.name).test(q))) return "brand"; return "other"; };
    const qs = []; now.forEach((r) => r.queries.forEach((q) => qs.push({ r, q, i: qIntent(q) })));
    const tot = qs.length;
    const by = new Map(QI.map((x) => [x[0], { x, n: 0, ans: new Set(), ex: new Map() }]));
    qs.forEach(({ r, q, i }) => { const e = by.get(i); e.n++; e.ans.add(r); e.ex.set(q, (e.ex.get(q) || 0) + 1); });
    const rows = [...by.values()].filter((e) => e.n).sort((a, b) => b.n - a.n);
    const mx = Math.max(1, ...rows.map((e) => e.n));
    const icols = "minmax(180px,1.3fr) minmax(140px,1.4fr) 70px 110px minmax(200px,1.8fr)";
    const withQ = now.filter((r) => r.queries.length).length;
    R.qi = {
      icols, sub: f0(tot) + " searches behind " + f0(withQ) + " answers", none: !tot,
      rows: rows.map((e) => ({ label: e.x[1], color: e.x[3], hint: e.x[2], n: f0(e.n), w: pct(e.n, mx).toFixed(1), share: fp(pct(e.n, tot)), vis: fp(metrics([...e.ans]).b[view.id].vis), ex: [...e.ex.entries()].sort((a, b) => b[1] - a[1])[0][0], cols: icols })),
      legend: QI.filter((x) => by.get(x[0]).n).map((x) => ({ label: x[1], color: x[3] })),
      engines: engsX.map((e) => { const l = qs.filter((x) => x.r.e === e.id); return { ...emk(e), pub: e.fan, nopub: !e.fan, n: f0(l.length), segs: QI.map((x) => { const k = l.filter((y) => y.i === x[0]).length; return { w: pct(k, l.length).toFixed(1), bg: x[3], tip: x[1] + ": " + fp(pct(k, l.length)) }; }) }; }),
    };
    const named = qs.filter((x) => BR.some((b) => wordRe(b.name).test(x.q))).length;
    const withMine = now.filter((r) => r.queries.some((q) => wordRe(view.name).test(q)));
    R.kpis = [kp("Searches", f0(tot), "behind " + f0(withQ) + " answers", null, "Searches the engines ran before answering. Gemini doesn’t publish them."), kp("Most common intent", rows[0] ? rows[0].x[1] : "—", rows[0] ? fp(pct(rows[0].n, tot)) + " of searches" : "no searches in view", null, "The intent most searches fall under."), kp("Name a tracked brand", fp(pct(named, tot)), f0(named) + " searches", null, "Searches that include any tracked brand’s name."), kp(view.name + " when searched for", withMine.length ? fp(metrics(withMine).b[view.id].vis) : "—", "named in answers whose searches named it · " + f0(withMine.length) + " answers", null, "Visibility in the answers where the engine searched for the brand by name.")];
  }

  if (page === "social") {
    const SG = [["social", "Social & community", ["Forums & social"], "var(--kind-forum)"], ["editorial", "Editorial & reviews", ["Review sites"], "var(--kind-review)"], ["retail", "Retailers", ["Retailers"], "var(--kind-retail)"], ["brand", "Brand sites", ["Your site", "Rival brand sites"], "var(--kind-you)"], ["ref", "Reference", ["Public & reference"], "var(--kind-public)"], ["other", "Other web", ["Other"], "var(--kind-other)"]];
    const grpOf = (k) => (SG.find((g) => g[2].includes(k)) || SG[5])[0];
    const cit = []; now.forEach((r) => r.sources.forEach((s) => { if (s.cited) cit.push({ r, s, g: grpOf(s.k) }); }));
    const cnt = (list, g) => list.filter((x) => x.g === g).length;
    const soc = cnt(cit, "social");
    const isSoc = (r) => r.sources.some((s) => s.cited && grpOf(s.k) === "social");
    const withSoc = now.filter(isSoc), webOnly = now.filter((r) => !isSoc(r) && r.sources.some((s) => s.cited));
    const perEng = engsX.map((e) => { const l = cit.filter((x) => x.r.e === e.id); return { e, l, sh: pct(cnt(l, "social"), l.length), n: l.length }; });
    const visOf = (list) => (list.length ? fp(metrics(list).b[view.id].vis) : "—");
    const plat = [["reddit.com", "Reddit"], ["youtube.com", "YouTube"], ["quora.com", "Quora"]];
    R.so = {
      sub: f0(cit.length) + " cited pages",
      legend: SG.map((g) => ({ label: g[1], color: g[3] })),
      overall: SG.map((g) => ({ label: g[1], color: g[3], n: f0(cnt(cit, g[0])), w: pct(cnt(cit, g[0]), cit.length).toFixed(1), share: fp(pct(cnt(cit, g[0]), cit.length)) })),
      engines: perEng.map(({ e, l }) => ({ ...emk(e), soc: fp(pct(cnt(l, "social"), l.length)), segs: SG.map((g) => ({ w: pct(cnt(l, g[0]), l.length).toFixed(1), bg: g[3], tip: g[1] + ": " + fp(pct(cnt(l, g[0]), l.length)) })) })),
      platforms: plat.map(([d, l]) => { const k = cit.filter((x) => x.g === "social" && domainMatches(x.s.d, d)).length; return { label: l, n: f0(k), w: pct(k, Math.max(1, soc)).toFixed(1) }; }).concat([{ label: "Other forums", n: f0(soc - cit.filter((x) => x.g === "social" && plat.some(([d]) => domainMatches(x.s.d, d))).length), w: pct(soc - cit.filter((x) => x.g === "social" && plat.some(([d]) => domainMatches(x.s.d, d))).length, Math.max(1, soc)).toFixed(1) }]),
      vs: [{ label: "Answers citing a forum or video", n: f0(withSoc.length), vis: visOf(withSoc) }, { label: "Answers citing only other web pages", n: f0(webOnly.length), vis: visOf(webOnly) }],
      chart: line("soc", engsX.map((e) => ({ id: e.id, label: e.label, color: e.color, vals: bucketRecs.map((rs) => { const gs = []; rs.forEach((r) => { if (r.e !== e.id) return; r.sources.forEach((s) => { if (s.cited) gs.push(grpOf(s.k)); }); }); return gs.length ? pct(gs.filter((g) => g === "social").length, gs.length) : null; }) })), { fmt: fp, floor: 0 }),
    };
    const most = perEng.filter((x) => x.n).sort((a, b) => b.sh - a.sh)[0];
    R.kpis = [kp("Social share of citations", fp(pct(soc, cit.length)), f0(soc) + " of " + f0(cit.length) + " cited pages", null, "Cited pages from forums and social sites (Reddit, YouTube, Quora and the like) ÷ every cited page."), kp("Leans most on social", most ? most.e.label : "—", most ? fp(most.sh) + " of its citations" : "", null, "The engine with the highest social share of its citations."), kp("Answers citing a forum or video", fp(pct(withSoc.length, n)), f0(withSoc.length) + " of " + f0(n), null, "Answers that linked at least one forum, social or video page."), kp(view.name + " named: social / web", visOf(withSoc) + " / " + visOf(webOnly), "answers citing a forum or video / web only", null, "Visibility in each group of answers. A correlation, not a cause.")];
  }

  if (page === "exclusive") {
    const dm = new Map(); now.forEach((r) => r.sources.forEach((s) => { if (!s.cited) return; const e = dm.get(s.d) || { d: s.d, k: s.k, n: 0, engs: new Set() }; e.n++; e.engs.add(r.e); dm.set(s.d, e); }));
    const all = [...dm.values()]; const ne = engsX.length;
    const only = all.filter((e) => e.engs.size === 1), every = all.filter((e) => e.engs.size === ne);
    const tb = tabsOf("exc", [["all", "All sites"], ["only", "One engine only"], ["every", "Every engine"]], "all");
    const list = (tb.cur === "only" ? only : tb.cur === "every" ? every : all).slice().sort((a, b) => b.n - a.n);
    const pg = pager("exc", list.length); const tcols = "minmax(170px,1.4fr) minmax(130px,1fr) 80px";
    R.ex = {
      one: ne < 2, tabs: tb.list, pg, tcols,
      cards: engsX.map((e) => { const mine = all.filter((x) => x.engs.has(e.id)); const l = only.filter((x) => x.engs.has(e.id)).sort((a, b) => b.n - a.n); return { ...emk(e), n: f0(l.length), of: f0(mine.length), share: fp(pct(l.length, mine.length)), sites: l.slice(0, 5).map((x) => x.d + " · " + x.n), none: !l.length }; }),
      cols: "minmax(110px,1.2fr) " + engsX.map(() => "minmax(60px,1fr)").join(" "), head: engsX.map(emk),
      rows: engsX.map((a) => { const A = all.filter((x) => x.engs.has(a.id)); return { ...emk(a), cells: engsX.map((b) => { if (a.id === b.id) return { v: "—", bg: "transparent", fg: "var(--fg-muted)" }; const v = A.length ? pct(A.filter((x) => x.engs.has(b.id)).length, A.length) : null; const c = heatC(v); return { v: v == null ? "—" : Math.round(v) + "%", bg: c.bg, fg: c.fg }; }) }; }),
      list: list.slice(pg.from, pg.to).map((e) => ({ d: e.d, kc: KINDC[e.k], n: e.n, engs: DASH_ENGINES.filter((x) => e.engs.has(x.id)).map(emk), cols: tcols })),
    };
    const ownE = ownDom ? all.find((x) => domainMatches(x.d, ownDom)) : null;
    R.kpis = [kp("Sites cited", f0(all.length), "by the engines in view", null, "Distinct domains cited."), kp("Cited by one engine only", fp(pct(only.length, all.length)), f0(only.length) + " sites", null, "Sites only one of the engines in view linked."), kp("Cited by every engine", f0(every.length), "of " + f0(all.length) + " sites", null, "Sites every engine in view linked at least once."), kp((ownDom || view.name) + " cited by", ownE ? ownE.engs.size + " of " + ne + " engines" : "no engine", ownE ? DASH_ENGINES.filter((x) => ownE.engs.has(x.id)).map((x) => x.label).join(", ") : "in the answers in view", null, "Which engines linked the viewed brand’s own site.")];
  }

  /* ---- the answers to one prompt ---- */
  R.dr = { open: S.drawer != null && !!PROMPTS[S.drawer], close: () => set({ drawer: null }) };
  if (R.dr.open) {
    const pi = S.drawer; const pr = PROMPTS[pi];
    R.dr.prompt = pr.text; R.dr.tag = pr.tags[0] || "No tag"; R.dr.intent = themeLabel(intentOfP(pi));
    R.dr.runLabel = "Newest answer in view, per engine";
    R.dr.blocks = engsX.map((e) => {
      const r = newest(pi, e.id);
      if (!r) return { ...emk(e), el: e.label, ed: e.d, est: e.st, kind: "No answer", status: "No answer in view", ok: false, openIt: () => {} };
      return { el: e.label, ed: e.d, est: e.st, kind: (KINDS.find((x) => x[0] === r.kind) || [0, r.kind])[1], ok: true, status: "Run " + (r.run + 1) + " · " + r.sources.length + " sources · " + r.queries.length + " searches", openIt: () => act.openCapture(r.id),
        brands: r.brands.map((x) => ({ rank: x.rank != null ? "#" + x.rank : "card", name: (bOf(x.id) || { name: x.id }).name, m: x.m, cls: x.id === view.id ? "you" : "" })), noBrands: !r.brands.length,
        srcN: r.sources.filter((s) => s.cited).length + " cited, " + r.sources.filter((s) => !s.cited).length + " read only", sources: r.sources.slice(0, 12).map((s) => ({ pos: s.pos, url: s.url, o: s.cited ? "Cited" : "Read", oc: s.cited ? "cited" : "read" })),
        hasQ: r.queries.length > 0, queries: r.queries.slice(0, 8), noQ: !r.queries.length, noQText: engOf(r.e).fan ? (r.kind === "memory" ? "Answered from memory: no web search." : "No searches published for this answer.") : "Gemini doesn’t publish the searches it runs.",
        hasCards: r.products.length > 0, cards: r.products.slice(0, 8).map((p) => ({ pos: p.pos, name: p.name, price: p.price != null ? formatMoney(p.price, p.cur || null) : "", merchant: p.merchant || "—", fw: p.brand === view.id ? 700 : 400 })) };
    });
  }
  R.toast = S.toast || ""; R.toastOn = !!S.toast;
  return R;
}
