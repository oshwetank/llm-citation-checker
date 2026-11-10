/*
 * historyView.js — the Dashboard as a record of what you asked (0.49.0).
 *
 * Release 3 of the canvas redesign. The owner's feedback on the old
 * Dashboard: it must not be brand-centric; "it is a record of prompts,
 * search is central, and the right-hand side should go". On the canvas it
 * became a searchable history: one row per prompt, grouped by day, with the
 * engines that answered it, how many times it was asked, what the answer
 * held (searches, pages, brands, product cards, a map, images), and filters
 * for the period, the engines, the kind of answer and the week. A second
 * view lists the searches the engines ran, which is how they rephrased what
 * you asked.
 *
 * Everything here reads the light capture rows (no answer text), so it is
 * pure and unit-tested; panel.js draws it. Matches inside answer text come
 * from the background's "search-answers" message and are passed in.
 */
import { normalizeMentions } from "./mention-list.js";
import { sameBrand } from "./funnel-omitted.js";
import { normPrompt, knownVendors, answerKind } from "./analyzeView.js";
import { searchTokens, matchesTokens } from "./answerSearch.js";
import { normDomain, siteKindOf } from "./siteKind.js";

export const ENGINE_ORDER = ["chatgpt", "gemini", "perplexity", "grok"];

export const PERIODS = [
  { id: "today", label: "Today", phrase: "today" },
  { id: "yesterday", label: "Yesterday", phrase: "yesterday" },
  { id: "3d", label: "Last 3 days", phrase: "in the last 3 days" },
  { id: "7d", label: "7 days", phrase: "in the last 7 days" },
  { id: "30d", label: "30 days", phrase: "in the last 30 days" },
  { id: "all", label: "All time", phrase: "in all your history" },
  // Any span of days (0.60.2, asked for): f.from / f.to, "YYYY-MM-DD",
  // both days included, local time.
  { id: "custom", label: "Custom…", phrase: "between the dates you picked" },
];

/** Local midnight of a "YYYY-MM-DD" day, or null. */
export function dayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}
/** "12 Oct – 17 Oct" for a custom span, the year added when it isn't this one. */
export function rangeLabel(from, to, now = Date.now()) {
  const a = dayStart(from), b = dayStart(to);
  if (a == null && b == null) return "Custom…";
  const y = new Date(now).getFullYear();
  const fmt = (t) => { const d = new Date(t); return `${dayMon(d)}${d.getFullYear() !== y ? ` ${d.getFullYear()}` : ""}`; };
  if (a != null && b != null) return a === b ? fmt(a) : `${fmt(Math.min(a, b))} – ${fmt(Math.max(a, b))}`;
  return a != null ? `From ${fmt(a)}` : `Until ${fmt(b)}`;
}

// The kinds of answer, in the canvas's order. "task" is a prompt that asked
// for work (an email, a summary) rather than information: nothing to track.
export const KINDS = [
  { id: "shopping", label: "Shopping" },
  { id: "info", label: "Informational" },
  { id: "local", label: "Local" },
  { id: "images", label: "Images" },
  { id: "memory", label: "From memory" },
  { id: "task", label: "Tasks · not research" },
];

// When several engines answered one prompt, the row takes the richest kind:
// one engine showing product cards makes it a shopping prompt.
const KIND_RANK = { shopping: 0, local: 1, images: 2, info: 3, memory: 4, task: 5 };

const TASK_VERB = /^(?:please\s+|can you\s+|could you\s+)?(?:write|rewrite|re-write|draft|summari[sz]e|translate|proofread|paraphrase|reword|compose|format|fix|debug|refactor|convert|correct|edit|reply|respond|turn this|make this|generate a|create a|calculate|solve)\b/i;

/** A prompt that asks for work rather than information, answered without searching. */
export function isTaskPrompt(text, { searched, brands } = {}) {
  if (searched || brands) return false;
  return TASK_VERB.test(String(text || "").trim());
}

const queriesOf = (rec) => [].concat(
  ((rec.fanout && rec.fanout.search) || []).map((q) => ["web", q]),
  ((rec.fanout && rec.fanout.shopping) || []).map((q) => ["shopping", q]),
  ((rec.fanout && rec.fanout.image) || []).map((q) => ["image", q]),
).map(([lane, q]) => ({ lane, text: String(typeof q === "string" ? q : (q && q.query) || "").trim() })).filter((q) => q.text);

const namedBrands = (rec) => normalizeMentions(rec.brandMentions || [], knownVendors(rec)).filter((b) => b.count > 0).map((b) => b.brand);

/**
 * One row per prompt (normalised text), newest first. A prompt asked on
 * several engines, or asked again, is one row: `asked` is how many times it
 * was asked on the engine it was asked on most, so a campaign run of four
 * engines counts once. The figures describe the latest answer from each
 * engine.
 *
 * @param {object[]} records  light capture rows
 * @param {{ profiles?: object[] }} opts  campaigns, to name a campaign's prompts
 */
const baseLang = (l) => (l ? String(l).toLowerCase().split(/[-_]/)[0] : null);

export function historyRows(records, { profiles = [] } = {}) {
  const byKey = new Map();
  for (const r of records || []) {
    if (!r || !r.captureId) continue;
    const norm = normPrompt(r.userPrompt);
    if (!norm) continue;
    // A campaign's prompt is its own row (0.68.0): the Dashboard
    // groups a campaign's prompts together and can leave them out, so the
    // same words asked by hand stay a row of their own.
    const pid = r.geo && r.geo.profileId;
    const key = pid ? `${pid}|${norm}` : norm;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const rows = [];
  for (const [key, caps] of byKey) {
    caps.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
    const latest = caps[0];
    const perEngine = new Map();
    const countPerEngine = new Map();
    for (const c of caps) {
      if (!perEngine.has(c.platform)) perEngine.set(c.platform, c);
      countPerEngine.set(c.platform, (countPerEngine.get(c.platform) || 0) + 1);
    }
    const engines = [...ENGINE_ORDER.filter((e) => perEngine.has(e)), ...[...perEngine.keys()].filter((e) => !ENGINE_ORDER.includes(e))];
    const latestPer = engines.map((e) => perEngine.get(e));
    const brands = [];
    latestPer.forEach((c) => namedBrands(c).forEach((b) => { if (!brands.some((x) => sameBrand(x, b))) brands.push(b); }));
    const searched = latestPer.some((c) => c.searched);
    let kind = latestPer.map((c) => answerKind(c).id).sort((a, b) => KIND_RANK[a] - KIND_RANK[b])[0] || "info";
    if (kind === "memory" && isTaskPrompt(latest.userPrompt, { searched, brands: brands.length })) kind = "task";
    const sum = (f) => latestPer.reduce((a, c) => a + f(c), 0);
    const profileIds = [...new Set(caps.map((c) => c.geo && c.geo.profileId).filter(Boolean))];
    const campaign = profileIds.map((id) => (profiles.find((p) => p.id === id) || {}).name).filter(Boolean)[0] || (profileIds.length ? "a campaign" : "");
    const fan = [];
    caps.forEach((c) => queriesOf(c).forEach((q) => { if (!fan.some((x) => x.text.toLowerCase() === q.text.toLowerCase())) fan.push(q); }));
    const text = String(latest.userPrompt || "").trim();
    // The sites every capture of this prompt read, cited if any cited them,
    // and the ads shown with them (0.61.0: the Sites and Ads views).
    const siteMap = new Map();
    caps.forEach((c) => (c.sources || []).forEach((src) => {
      const d = normDomain(src.domain || src.url);
      if (!d) return;
      const x = siteMap.get(d) || { domain: d, cited: false };
      if (src.outcome === "cited") x.cited = true;
      siteMap.set(d, x);
    }));
    const adHits = [];
    caps.forEach((c) => (c.ads || []).forEach((a) => {
      const advertiser = String(a.advertiser || a.targetDomain || "").trim();
      if (!advertiser) return;
      const domain = normDomain(a.targetDomain || a.advertiserUrl || "");
      const label = domain.split(".")[0];
      adHits.push({
        advertiser, domain, at: c.capturedAt || 0, captureId: c.captureId, platform: c.platform,
        named: namedBrands(c).some((b) => sameBrand(b, advertiser)),
        cited: !!label && (c.sources || []).some((src) => src.outcome === "cited" && normDomain(src.domain || src.url).split(".")[0] === label),
      });
    }));
    rows.push({
      key, text, words: text.split(/\s+/).filter(Boolean).length,
      latestId: latest.captureId, latestAt: latest.capturedAt || 0, firstAt: caps[caps.length - 1].capturedAt || 0,
      captureIds: caps.map((c) => c.captureId), captures: caps.length,
      engines, latestByEngine: Object.fromEntries(latestPer.map((c) => [c.platform, c.captureId])),
      asked: Math.max(...countPerEngine.values()),
      kind, searched,
      searches: sum((c) => queriesOf(c).length),
      unpublished: latestPer.some((c) => c.searched && !queriesOf(c).length),
      pages: sum((c) => (c.sources || []).length),
      brands: brands.length,
      products: sum((c) => (c.products || []).length),
      places: sum((c) => (c.places || []).length),
      images: sum((c) => (c.images || []).length),
      campaign, fromCampaign: profileIds.length > 0, profileId: profileIds[0] || null,
      // Sample answers loaded on a fresh install say so wherever they show.
      sample: caps.every((c) => c.isDemo || String(c.captureId).startsWith("demo-")),
      fan,
      sites: [...siteMap.values()].map((x) => ({ domain: x.domain, cited: x.cited })),
      ads: [...new Set(adHits.map((h) => h.advertiser))],
      adHits,
      // The answers' languages and markets (0.70.0): the built-in AI's
      // reading when there is one, else Chrome's language detector.
      langs: [...new Set(latestPer.map((c) => baseLang((c.ai && c.ai.lang) || c.answerLang)).filter(Boolean))],
      markets: [...new Set(latestPer.map((c) => c.ai && c.ai.market && c.ai.market.country).filter(Boolean))],
    });
  }
  return rows.sort((a, b) => b.latestAt - a.latestAt);
}

/* ---------- time ---------- */

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Whole calendar days between two times, in local time (0 = same day). */
export function dayDiff(now, t) {
  return Math.round((startOfDay(now) - startOfDay(t)) / 86400000);
}
/** Monday 00:00 of the week `t` falls in, local time. */
export function weekStart(t) {
  const d = new Date(startOfDay(t));
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}
// Month and day names in the interface's language (0.71.0). English keeps
// the "12 Oct" order it always had; other languages take Intl's.
let LOC = null;
export function setDateLocale(l) { LOC = l && !/^en\b/i.test(l) ? l : null; }
const intl = (opts) => (t) => new Intl.DateTimeFormat(LOC, opts).format(new Date(t));
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayMon = (d) => (LOC ? intl({ day: "numeric", month: "short" })(d) : `${d.getDate()} ${MON_EN[d.getMonth()]}`);
const dayMonth = (d) => (LOC ? intl({ day: "numeric", month: "long" })(d) : `${d.getDate()} ${MONTH_EN[d.getMonth()]}`);
const monthName = (d) => (LOC ? intl({ month: "long" })(d) : MONTH_EN[d.getMonth()]);
const dowName = (d) => (LOC ? intl({ weekday: "long" })(d) : DOW_EN[d.getDay()]);
export const shortDate = (t) => dayMon(new Date(t));

function inPeriod(period, now, t, range) {
  if (period === "custom") {
    let a = dayStart(range && range.from), b = dayStart(range && range.to);
    if (a != null && b != null && a > b) [a, b] = [b, a];
    const end = b != null ? new Date(b).setDate(new Date(b).getDate() + 1) : null; // the whole of the last day
    return (a == null || t >= a) && (end == null || t < end);
  }
  const dd = dayDiff(now, t);
  switch (period) {
    case "today": return dd === 0;
    case "yesterday": return dd === 1;
    case "3d": return dd <= 2;
    case "7d": return dd <= 6;
    case "30d": return dd <= 29;
    default: return true;
  }
}

/** Day groups for the list: Today, Yesterday, Earlier this week, then months. */
export function groupRows(rows, now) {
  const thisWeek = weekStart(now);
  const nowYear = new Date(now).getFullYear();
  const groups = [];
  const put = (id, label, sub, row) => {
    let g = groups.find((x) => x.id === id);
    if (!g) { g = { id, label, sub, rows: [] }; groups.push(g); }
    g.rows.push(row);
  };
  for (const r of rows) {
    const dd = dayDiff(now, r.latestAt);
    const d = new Date(r.latestAt);
    if (dd === 0) put("today", "Today", `${dowName(d)}, ${dayMonth(d)}`, r);
    else if (dd === 1) put("yesterday", "Yesterday", `${dowName(d)}, ${dayMonth(d)}`, r);
    else if (r.latestAt >= thisWeek) put("week", "Earlier this week", "", r);
    else {
      const id = `${d.getFullYear()}-${d.getMonth()}`;
      put(id, monthName(d) + (d.getFullYear() !== nowYear ? ` ${d.getFullYear()}` : ""), "", r);
    }
  }
  return groups;
}

/** One block per campaign, its most recent first; rows newest first within. */
function campaignGroups(rows) {
  const by = new Map();
  for (const r of rows) {
    const id = `campaign:${r.profileId || r.campaign}`;
    if (!by.has(id)) by.set(id, { id, label: r.campaign || "A campaign", sub: "", rows: [], campaign: true, profileId: r.profileId || null, latestAt: 0 });
    const g = by.get(id);
    g.rows.push(r);
    g.latestAt = Math.max(g.latestAt, r.latestAt || 0);
  }
  return [...by.values()].sort((a, b) => b.latestAt - a.latestAt).map((g) => {
    const d = new Date(g.latestAt);
    return { ...g, sub: `campaign · last asked ${dayMonth(d)}` };
  });
}

/* ---------- search ---------- */

// searchTokens() and matchesTokens() live in answerSearch.js, shared with
// the background's answer search so both read a query the same way.
export { searchTokens, matchesTokens };
/** Split text into plain and matching runs, for highlighting. */
export function highlightRuns(text, toks) {
  const s = String(text || "");
  if (!toks.length) return [{ t: s, hit: false }];
  const esc = toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${esc.join("|")})`, "gi");
  return s.split(re).filter(Boolean).map((t) => ({ t, hit: toks.includes(t.toLowerCase()) }));
}

/**
 * Everything the Dashboard shows, for one set of filters.
 *
 * @param {object[]} rows  historyRows()
 * @param {object} f  { query, scope: {prompts, answers, fan}, engines: {id: bool}, period,
 *                      kinds: {id: bool}, week (weekStart ms | null), repeat, campaign, sort }
 * @param {{ now: number, answerHits?: Map<string,string> }} ctx  captureId -> snippet
 */
export function historyView(rows, f, { now = Date.now(), answerHits = new Map() } = {}) {
  const scope = f.scope || { prompts: true, answers: true, fan: true };
  const toks = searchTokens(f.query);
  const hasQ = toks.length > 0;
  const engineOn = (e) => !f.engines || f.engines[e] !== false;
  // Campaign prompts (0.68.0): "group" (each campaign's prompts in a block of
  // their own, after the prompts asked by hand), "hide" or "only". The old
  // campaign: true is "only".
  const campaignsMode = f.campaigns || (f.campaign ? "only" : "group");

  // 1. the search
  const matched = rows.map((r) => {
    if (!hasQ) return { ...r, hitPrompt: false, hitAnswer: null, hitFan: null };
    const hitPrompt = !!scope.prompts && matchesTokens(r.text, toks);
    const answerId = scope.answers ? r.captureIds.find((id) => answerHits.has(id)) : null;
    const hitFan = scope.fan ? (r.fan.find((q) => matchesTokens(q.text, toks)) || null) : null;
    return { ...r, hitPrompt, hitAnswer: answerId ? { captureId: answerId, snippet: answerHits.get(answerId) } : null, hitFan };
  }).filter((r) => !hasQ || r.hitPrompt || r.hitAnswer || r.hitFan);

  // 2. engines, period, toggles
  const engineCounts = Object.fromEntries(ENGINE_ORDER.map((e) => [e, matched.filter((r) => r.engines.includes(e)).length]));
  const pre = matched.filter((r) => r.engines.some(engineOn)
    && inPeriod(f.period || "all", now, r.latestAt, { from: f.from, to: f.to })
    && (!f.repeat || r.asked > 1)
    && (campaignsMode !== "only" || r.fromCampaign)
    && (campaignsMode !== "hide" || !r.fromCampaign)
    && (!f.ads || (r.ads || []).length > 0));
  // Language and market (0.70.0), counted before they filter so the
  // choices show how many prompts each one would leave.
  const tally = (key) => { const m = new Map(); pre.forEach((r) => (r[key] || []).forEach((v) => m.set(v, (m.get(v) || 0) + 1))); return [...m.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)); };
  const langCounts = tally("langs");
  const marketCounts = tally("markets");
  const preLM = pre.filter((r) => (!f.lang || (r.langs || []).includes(f.lang)) && (!f.market || (r.markets || []).includes(f.market)));

  // 3. kind of answer
  const anyKind = !!f.kinds && Object.values(f.kinds).some(Boolean);
  const kindCounts = Object.fromEntries(KINDS.map((k) => [k.id, preLM.filter((r) => r.kind === k.id).length]));
  const base = preLM.filter((r) => !anyKind || f.kinds[r.kind]);

  // 4. the week picked on the chart
  const lastWeek = weekStart(now);
  const weekStarts = [];
  for (let i = 7; i >= 0; i--) { const d = new Date(lastWeek); d.setDate(d.getDate() - 7 * i); weekStarts.push(d.getTime()); }
  const weeks = weekStarts.map((ws, i) => ({
    start: ws, label: i === 7 ? "This week" : shortDate(ws),
    n: base.filter((r) => weekStart(r.latestAt) === ws).length,
  }));
  let list = base.filter((r) => !f.week || weekStart(r.latestAt) === f.week);
  if (f.sort === "asked") list = [...list].sort((a, b) => b.asked - a.asked || b.latestAt - a.latestAt);
  else if (f.sort === "engines") list = [...list].sort((a, b) => b.engines.length - a.engines.length || b.latestAt - a.latestAt);

  // 5. the searches the engines ran, for the prompts in the list
  const fanMap = new Map();
  for (const r of list) {
    for (const q of r.fan) {
      if (hasQ && scope.fan && !r.hitPrompt && !matchesTokens(q.text, toks)) continue;
      const k = q.text.toLowerCase();
      if (!fanMap.has(k)) fanMap.set(k, { text: q.text, lane: q.lane, n: 0, engines: [], from: [] });
      const e = fanMap.get(k);
      e.n++;
      r.engines.forEach((x) => { if (!e.engines.includes(x)) e.engines.push(x); });
      if (!e.from.includes(r.text)) e.from.push(r.text);
    }
  }
  const fan = [...fanMap.values()].sort((a, b) => b.n - a.n || a.text.localeCompare(b.text));

  // 6. sites across these prompts (0.61.0): how many prompts each site
  // showed up for, and in how many of those it was cited rather than read.
  const siteAgg = new Map();
  for (const r of list) for (const x of r.sites || []) {
    const e = siteAgg.get(x.domain) || { domain: x.domain, prompts: 0, cited: 0 };
    e.prompts++;
    if (x.cited) e.cited++;
    siteAgg.set(x.domain, e);
  }
  const sites = [...siteAgg.values()].map((e) => ({ ...e, kind: siteKindOf(e.domain, {}), citedShare: Math.round((e.cited / e.prompts) * 100) }))
    .sort((a, b) => b.prompts - a.prompts || b.cited - a.cited || a.domain.localeCompare(b.domain));

  // 7. ads across these prompts (0.61.0): who advertised, how often, for
  // which prompts, first and last seen, and how often the same answer also
  // named or cited the advertiser.
  const adAgg = new Map();
  for (const r of list) for (const h of r.adHits || []) {
    const k = h.advertiser.toLowerCase();
    const e = adAgg.get(k) || { advertiser: h.advertiser, times: 0, prompts: new Set(), domains: new Set(), first: h.at, last: h.at, named: 0, cited: 0, latestId: h.captureId };
    e.times++;
    e.prompts.add(r.text);
    if (h.domain) e.domains.add(h.domain);
    if (h.at < e.first) e.first = h.at;
    if (h.at >= e.last) { e.last = h.at; e.latestId = h.captureId; }
    if (h.named) e.named++;
    if (h.cited) e.cited++;
    adAgg.set(k, e);
  }
  const ads = [...adAgg.values()].map((e) => ({ ...e, prompts: [...e.prompts], domains: [...e.domains] }))
    .sort((a, b) => b.times - a.times || b.last - a.last);

  const enginesUsed = ENGINE_ORDER.filter((e) => base.some((r) => r.engines.includes(e)));
  const times = base.map((r) => r.latestAt).sort((a, b) => a - b);
  const totals = {
    prompts: base.length,
    answers: base.reduce((a, r) => a + r.captures, 0),
    engines: enginesUsed.length,
    from: times.length ? times[0] : null,
    to: times.length ? times[times.length - 1] : null,
    kindLine: KINDS.filter((k) => kindCounts[k.id]).slice(0, 3).map((k) => `${kindCounts[k.id]} ${k.label.split(" ")[0].toLowerCase()}`).join(", "),
  };

  return {
    tokens: toks, matched, pre, base, list, engineCounts, kindCounts, anyKind, weeks, fan, totals, sites, ads, langCounts, marketCounts,
    withAds: matched.filter((r) => (r.ads || []).length).length,
    groups: f.sort && f.sort !== "newest" ? [{ id: "all", label: f.sort === "asked" ? "Asked most often" : "Most engines", sub: "", rows: list }]
      : campaignsMode === "group" || campaignsMode === "only"
        ? [...groupRows(list.filter((r) => !r.fromCampaign), now), ...campaignGroups(list.filter((r) => r.fromCampaign))]
        : groupRows(list, now),
    campaignsMode,
  };
}
