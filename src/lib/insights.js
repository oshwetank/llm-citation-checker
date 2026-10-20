/*
 * insights.js — what a campaign's answers show, worked out in code (0.74.0).
 *
 * The owner wants the AI to answer about the tool's data "comprehensively and
 * thoroughly" and fast. A small on-device model can't read hundreds of
 * answers, and shouldn't have to: counting, comparing and finding gaps is
 * exact work for code. This file does it once, with the same measures as the
 * board (computeMetrics / brandPresence in geo.js, ranksIn and cardIsBrand in
 * campaignBoard.js), and every finding carries the captures behind it. The
 * Ask tools, the board and the "Continue in…" hand-off all read from here, so
 * a number never differs between them, and the model only has to explain.
 *
 * Pure: no storage, no browser APIs. Plain objects in, plain objects out.
 */
import { computeMetrics, trackedBrandsOf, normName, brandPresence, usageLimitOf, domainOfUrl, domainMatches } from "./geo.js";
import { ranksIn, cardIsBrand, ENGINE_ORDER } from "./campaignBoard.js";
import { themeOf } from "./campaignView.js";
import { normDomain, siteKindOf } from "./siteKind.js";

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (n, d) => (d ? (n / d) * 100 : 0);
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const answered = (r) => String(r.answerText || "").trim().length > 0;
export const ref = (r) => ({ id: r.captureId, engine: r.platform, prompt: clip(r.userPrompt, 90), date: day(r.capturedAt) });
const runOf = (r) => r.runId || (r.geo && r.geo.runId) || null;
const promptKey = (r) => (r.geo && r.geo.promptId) || normName(r.userPrompt);
const queriesOf = (rec) => [].concat(((rec.fanout && rec.fanout.search) || []), ((rec.fanout && rec.fanout.shopping) || []), ((rec.fanout && rec.fanout.image) || []))
  .map((q) => String(typeof q === "string" ? q : (q && q.query) || "").trim()).filter(Boolean);
const citedDomains = (r) => [...new Set((r.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean))];

/** The campaign's finished runs, newest first. */
export function finishedRuns(runs, profile) {
  return (runs || []).filter((g) => g.profileId === profile.id && g.status !== "running").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/** The brands measured: the campaign's own list, or the most named in its answers. */
export function measuredBrands(profile, recs) {
  const own = trackedBrandsOf(profile);
  if (own.some((b) => !b.isOwn)) return own;
  const counts = new Map();
  for (const r of recs) for (const m of r.brandMentions || []) if (m && m.brand && (m.count || 0) > 0) counts.set(m.brand, (counts.get(m.brand) || 0) + 1);
  const ownKey = own[0] ? normName(own[0].name) : null;
  const extra = [...counts.entries()].filter(([n]) => normName(n) !== ownKey).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => ({ name, auto: true }));
  return [...own, ...extra];
}

function brandTable(recs, profile, brands) {
  const m = computeMetrics(recs, profile, brands);
  return m.brands.map((b) => ({ brand: b.name, yours: b.isOwn, auto: !!b.auto, visibility: r1(b.visibility), shareOfVoice: r1(b.shareOfVoice), avgPosition: r1(b.avgPosition), mentions: b.mentions, answersNaming: b.responsesPresent, answersCitingSite: b.citations }));
}

/**
 * Everything worth knowing about one campaign's run.
 * @param {{records: object[], profile: object, runs?: object[], runId?: string, engines?: string[]}} o
 */
export function campaignInsights({ records = [], profile, runs = [], runId = null, engines = null } = {}) {
  if (!profile) return null;
  const mine = records.filter((r) => r.geo && r.geo.profileId === profile.id && answered(r));
  const done = finishedRuns(runs, profile);
  let run = runId ? done.find((g) => g.id === runId) : null;
  if (!run) run = done.find((g) => mine.some((r) => runOf(r) === g.id)) || null;
  const pick = (g) => mine.filter((r) => runOf(r) === g.id && (!engines || engines.includes(r.platform)));
  let recs = run ? pick(run) : mine.filter((r) => !engines || engines.includes(r.platform));
  const prev = run ? done.filter((g) => (g.startedAt || 0) < (run.startedAt || 0)).find((g) => pick(g).length) : null;
  const prevRecs = prev ? pick(prev) : [];
  const brands = measuredBrands(profile, recs);
  const own = brands.find((b) => b.isOwn) || null;
  const ownKey = own ? normName(own.name) : null;
  const rivals = brands.filter((b) => !b.isOwn);
  const refs = new Map();
  const keep = (rs) => { for (const r of rs) refs.set(r.captureId, ref(r)); return rs.map((r) => r.captureId); };

  // Headline numbers, per brand, overall and per engine.
  const overview = brandTable(recs, profile, brands);
  const byEngine = ENGINE_ORDER.map((e) => [e, recs.filter((r) => r.platform === e)]).filter(([, v]) => v.length)
    .map(([engine, v]) => ({ engine, answers: v.length, brands: brandTable(v, profile, brands) }));

  // What changed since the previous run, per brand.
  const before = prevRecs.length ? new Map(brandTable(prevRecs, profile, brands).map((b) => [normName(b.brand), b])) : null;
  const changes = before ? overview.map((b) => {
    const p = before.get(normName(b.brand)) || {};
    const d = (k) => (b[k] == null || p[k] == null ? null : r1(b[k] - p[k]));
    return { brand: b.brand, yours: b.yours, visibility: d("visibility"), shareOfVoice: d("shareOfVoice"), avgPosition: d("avgPosition") };
  }) : [];

  // Prompt by prompt: who is named, who comes first, on each engine.
  const byPrompt = new Map();
  for (const r of recs) {
    const k = promptKey(r);
    const row = byPrompt.get(k) || { prompt: clip(r.userPrompt, 160), tags: (r.geo && r.geo.tags) || [], answers: [], engines: {} };
    const { pres, rank } = ranksIn(r, brands);
    const ownP = ownKey ? pres.find((p) => p.key === ownKey) : null;
    const first = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex)[0] || null;
    row.answers.push(r);
    row.engines[r.platform] = { yours: !!(ownP && ownP.present), rank: ownP ? rank.get(ownP.key) || null : null, first: first ? first.name : null, named: pres.filter((p) => p.present).map((p) => p.name), id: r.captureId };
    byPrompt.set(k, row);
  }
  const prompts = [...byPrompt.values()].map((row) => {
    const es = Object.values(row.engines);
    const yours = es.filter((e) => e.yours).length;
    const rivalsNamed = [...new Set(es.flatMap((e) => e.named).filter((n) => normName(n) !== ownKey))];
    return { prompt: row.prompt, tags: row.tags, answers: es.length, yoursIn: yours, rivalsNamed, engines: Object.fromEntries(Object.entries(row.engines).map(([k, v]) => [k, { yours: v.yours, rank: v.rank, first: v.first }])), ids: keep(row.answers) };
  });

  // Gaps: prompts where you never appear but two or more rivals do.
  const absent = prompts.filter((p) => p.yoursIn === 0 && p.rivalsNamed.length >= 2).sort((a, b) => b.rivalsNamed.length - a.rivalsNamed.length);
  // Prompts where you appear but a rival is named before you somewhere.
  const behind = prompts.filter((p) => Object.values(p.engines).some((e) => e.yours && e.first && normName(e.first) !== ownKey));

  // Each rival: answers it wins (named first) and answers it's in without you.
  const rivalWins = rivals.map((b) => {
    const k = normName(b.name);
    let first = 0, without = 0, ahead = 0;
    const ids = [];
    for (const r of recs) {
      const { pres } = ranksIn(r, brands);
      const them = pres.find((p) => p.key === k);
      const you = ownKey ? pres.find((p) => p.key === ownKey) : null;
      if (!them || !them.present) continue;
      const lead = pres.filter((p) => p.firstIndex !== null).sort((a, x) => a.firstIndex - x.firstIndex)[0];
      if (lead && lead.key === k) { first++; ids.push(r.captureId); }
      if (!you || !you.present) without++;
      else if (them.firstIndex !== null && you.firstIndex !== null && them.firstIndex < you.firstIndex) ahead++;
    }
    keep(recs.filter((r) => ids.includes(r.captureId)));
    return { brand: b.name, namedFirst: first, inAnswersWithoutYou: without, aheadOfYou: ahead, ids: ids.slice(0, 20) };
  }).filter((x) => x.namedFirst || x.inAnswersWithoutYou || x.aheadOfYou).sort((a, b) => b.namedFirst - a.namedFirst || b.inAnswersWithoutYou - a.inAnswersWithoutYou);

  // Sources: what is cited, of what kind; which sites are cited for rivals
  // but never in an answer that names you; your own site's share.
  const ownDomain = own && own.url ? domainOfUrl(own.url) : null;
  const ctx = { ownBrand: own ? own.name : undefined, ownUrl: own ? own.url : undefined, brands: rivals.map((b) => b.name) };
  const siteRows = new Map();
  let citationsAll = 0, citationsOwn = 0;
  for (const r of recs) {
    const pres = brandPresence(r, brands);
    const youIn = ownKey ? !!(pres.find((p) => p.key === ownKey) || {}).present : false;
    const rivalIn = pres.some((p) => p.key !== ownKey && p.present);
    for (const s of r.sources || []) if (s.outcome === "cited") { citationsAll++; if (ownDomain && domainMatches(s.domain, ownDomain)) citationsOwn++; }
    for (const d of citedDomains(r)) {
      const row = siteRows.get(d) || { site: d, answersCiting: 0, withYou: 0, withRivalsOnly: 0, engines: new Set(), ids: [] };
      row.answersCiting++;
      if (youIn) row.withYou++; else if (rivalIn) row.withRivalsOnly++;
      row.engines.add(r.platform);
      if (row.ids.length < 10) row.ids.push(r.captureId);
      siteRows.set(d, row);
    }
  }
  const sites = [...siteRows.values()].map((x) => ({ ...x, engines: [...x.engines], kind: siteKindOf(x.site, ctx) })).sort((a, b) => b.answersCiting - a.answersCiting);
  const sourceGaps = sites.filter((x) => x.withYou === 0 && x.withRivalsOnly >= 1 && !(ownDomain && domainMatches(x.site, ownDomain))).sort((a, b) => b.withRivalsOnly - a.withRivalsOnly).slice(0, 15);
  const kinds = {};
  for (const x of sites) kinds[x.kind] = (kinds[x.kind] || 0) + x.answersCiting;

  // Topics: the primary tag (the first) when prompts have tags, else the
  // wording theme; your visibility in each.
  const useTags = prompts.some((p) => p.tags && p.tags.length);
  const topicMap = new Map();
  for (const r of recs) {
    const t = useTags ? ((r.geo && r.geo.tags && r.geo.tags[0]) || "Untagged") : themeOf(r.userPrompt);
    const row = topicMap.get(t) || { topic: t, answers: 0, yours: 0, firsts: new Map() };
    row.answers++;
    const { pres } = ranksIn(r, brands);
    if (ownKey && (pres.find((p) => p.key === ownKey) || {}).present) row.yours++;
    const lead = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex)[0];
    if (lead) row.firsts.set(lead.name, (row.firsts.get(lead.name) || 0) + 1);
    topicMap.set(t, row);
  }
  const topics = [...topicMap.values()].map((t) => ({ topic: t.topic, answers: t.answers, yourVisibility: r1(pct(t.yours, t.answers)), mostOftenFirst: [...t.firsts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
    .sort((a, b) => b.answers - a.answers);

  // Engines that disagree about who comes first on the same prompt.
  const disagreements = prompts.filter((p) => new Set(Object.values(p.engines).map((e) => e.first).filter(Boolean)).size > 1)
    .map((p) => ({ prompt: p.prompt, first: Object.fromEntries(Object.entries(p.engines).map(([k, v]) => [k, v.first])), ids: p.ids }));

  // Product cards, per brand.
  const cardsBy = new Map();
  let cardAnswers = 0;
  for (const r of recs) {
    const ps = r.products || [];
    if (ps.length) cardAnswers++;
    ps.forEach((p, i) => {
      const b = brands.find((x) => cardIsBrand(p, x.name));
      const k = b ? b.name : "Other brands";
      const row = cardsBy.get(k) || { brand: k, cards: 0, firstCards: 0, products: new Map() };
      row.cards++;
      if (i === 0) row.firstCards++;
      row.products.set(p.name, (row.products.get(p.name) || 0) + 1);
      cardsBy.set(k, row);
    });
  }
  const products = { answersWithCards: cardAnswers, byBrand: [...cardsBy.values()].map((x) => ({ brand: x.brand, cards: x.cards, firstCards: x.firstCards, top: [...x.products.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n })) })).sort((a, b) => b.cards - a.cards) };

  // The engines' own searches: how many, and which name a brand.
  const searchRows = [];
  for (const r of recs) for (const q of queriesOf(r)) searchRows.push({ engine: r.platform, q, brands: brands.filter((b) => new RegExp(`(^|[^\\p{L}\\p{N}])${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(q)).map((b) => b.name) });
  const searches = { total: searchRows.length, perAnswer: r1(recs.length ? searchRows.length / recs.length : 0), namingYou: own ? searchRows.filter((s) => s.brands.includes(own.name)).length : 0,
    namingRivals: searchRows.filter((s) => s.brands.some((b) => !own || b !== own.name)).length, siteScoped: searchRows.filter((s) => /\bsite:/i.test(s.q)).length,
    examples: searchRows.slice(0, 8).map((s) => ({ engine: s.engine, query: clip(s.q, 120) })) };

  // Ads ChatGPT showed.
  const adRows = recs.flatMap((r) => (r.ads || []).map((a) => ({ advertiser: a.advertiser || a.targetDomain || "?", id: r.captureId })));
  const ads = { answersWithAds: new Set(adRows.map((a) => a.id)).size, advertisers: Object.entries(adRows.reduce((m, a) => ((m[a.advertiser] = (m[a.advertiser] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([advertiser, n]) => ({ advertiser, n })) };

  // How complete the data is, per engine.
  const allInRun = run ? mine.filter((r) => runOf(r) === run.id) : mine;
  const quality = ENGINE_ORDER.map((e) => {
    const rs = records.filter((r) => r.geo && r.geo.profileId === profile.id && r.platform === e && (!run || runOf(r) === run.id));
    if (!rs.length) return null;
    return { engine: e, captured: rs.length, withAnswer: rs.filter(answered).length, usageLimit: rs.filter((r) => usageLimitOf(r)).length };
  }).filter(Boolean);

  return {
    campaign: { name: profile.name, brand: own ? own.name : null, site: ownDomain, competitors: rivals.filter((b) => !b.auto).map((b) => b.name), inferredCompetitors: rivals.filter((b) => b.auto).map((b) => b.name) },
    run: run ? { id: run.id, date: day(run.startedAt), answers: recs.length, engines: [...new Set(recs.map((r) => r.platform))] } : { id: null, date: null, answers: recs.length, engines: [...new Set(recs.map((r) => r.platform))] },
    previousRun: prev ? { id: prev.id, date: day(prev.startedAt), answers: prevRecs.length } : null,
    runs: done.length,
    overview, byEngine, changes,
    prompts, absent, behind, rivalWins,
    sources: { citations: citationsAll, ownSiteCitations: citationsOwn, ownSiteShare: r1(pct(citationsOwn, citationsAll)), kinds, top: sites.slice(0, 20), gaps: sourceGaps },
    topics, disagreements, products, searches, ads, quality,
    refs,
    _allInRun: allInRun.length,
  };
}

/** A brand's numbers in each finished run of a campaign, oldest first. */
export function brandTrend({ records = [], profile, runs = [], brand }) {
  const mine = records.filter((r) => r.geo && r.geo.profileId === profile.id && answered(r));
  const brands = trackedBrandsOf(profile).some((b) => normName(b.name) === normName(brand)) ? trackedBrandsOf(profile) : [...trackedBrandsOf(profile), { name: brand }];
  return finishedRuns(runs, profile).slice().reverse().map((g) => {
    const sub = mine.filter((r) => runOf(r) === g.id);
    if (!sub.length) return null;
    const b = computeMetrics(sub, profile, brands).brands.find((x) => normName(x.name) === normName(brand));
    return { run: day(g.startedAt), answers: sub.length, visibility: r1(b && b.visibility), shareOfVoice: r1(b && b.shareOfVoice), avgPosition: r1(b && b.avgPosition) };
  }).filter(Boolean);
}
