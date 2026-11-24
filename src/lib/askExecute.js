/*
 * askExecute.js — runs a resolved Ask plan, in code (1.0.5, Stage 1 of
 * ASK-ARCHITECTURE.md §4.6).
 *
 * No model here. The plan's scope picks the turns (collection, run, engines,
 * tags, prompts, dates, signed in or out); the numbers come from the boards'
 * own functions (campaignInsights, brandTrend → computeMetrics), so Ask and
 * the boards cannot disagree. Every result says what it was based on
 * (coverage): answers used, turns in scope with no answer or stopped by a
 * usage limit, engines asked for that the scope never ran, the run.
 */
import { campaignInsights, brandTrend } from "./insights.js";
import { usageLimitOf, normName } from "./geo.js";
import { GLOSSARY } from "./glossary.js";
import { fold, collectionOf, HISTORY_ID, HISTORY_NAME, ENGINE_LABEL } from "./askCatalog.js";
import { indexFor, keywordHits, byAnswer } from "./passages.js";

const answered = (r) => String(r.answerText || "").trim().length > 0;
const runOf = (r) => (r.geo && r.geo.runId) || r.runId || null;
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const named = (r) => (r.brandMentions || []).filter((m) => m && m.brand && (m.count || 0) > 0).map((m) => m.brand);
const MAX_REFS = 8;

export const NOT_RECORDED = "CitoSkeleton records what the AI engines answer: the brands they name, in what order, and the sites they cite or read. It does not see clicks, traffic, impressions, spend or Google rankings, so it can't answer that. It can tell you how often your site is cited, and in which answers.";

/** The turns of one collection that the scope keeps (before run choice). */
function scoped(records, plan, collectionId) {
  const s = plan.scope;
  const tags = (s.tags || []).map(fold);
  const prompts = new Set(s.prompts || []);
  return records.filter((r) => {
    if (collectionOf(r) !== collectionId) return false;
    if (s.engines && s.engines.length && !s.engines.includes(r.platform)) return false;
    if (tags.length && !((r.geo && r.geo.tags) || []).some((t) => tags.includes(fold(t)))) return false;
    if (prompts.size) {
      const id = (r.geo && r.geo.promptId) || `h:${fold(r.userPrompt).slice(0, 80)}`;
      if (!prompts.has(id)) return false;
    }
    if (s.dates && s.dates.from && (r.capturedAt || 0) < s.dates.from) return false;
    if (s.dates && s.dates.to && (r.capturedAt || 0) >= s.dates.to) return false;
    if (s.signedIn && ((r.session && r.session.signedIn) || "unknown") !== s.signedIn) return false;
    // Answers that treat the named brand this way, by the AI labels.
    const stance = Array.isArray(s.stance) ? s.stance[0] : s.stance;
    if (stance && !(r.brandMentions || []).some((m) => m && m.aiStance === stance && (!plan.subject.brands.length || plan.subject.brands.some((b) => fold(b) === fold(m.brand))))) return false;
    return true;
  });
}

/** Every stored record in the plan's scope, across its collections. */
export function scopeRecords(plan, data) {
  return (plan.scope.collections || []).flatMap((id) => scoped(data.records || [], plan, id));
}

// "My questions" as a campaign the board functions can read: no own brand,
// no tracked rivals (the brands named are inferred), no runs.
function historyProfile() { return { id: HISTORY_ID, name: HISTORY_NAME, brand: null, competitors: [], prompts: [] }; }
const asHistory = (rs) => rs.map((r) => ({ ...r, geo: { ...(r.geo || {}), profileId: HISTORY_ID } }));

/**
 * Run one plan.
 * @param {object} plan     resolved (askPlan.resolveScope)
 * @param {{records: object[], profiles: object[], runs: object[]}} data
 * @returns {{intent: string, parts: object[], refs: object[], result: object}}
 */
export function execute(plan, data, opts = {}) {
  const records = data.records || [], profiles = data.profiles || [], runs = data.runs || [];
  const intent = plan.intent || "metric";
  if (intent === "not_recorded") return { intent, parts: [], refs: [], result: { notRecorded: true, text: NOT_RECORDED } };
  if (intent === "define") return { intent, parts: [], refs: [], result: define(plan) };

  const parts = [];
  const refs = new Map();
  for (const id of plan.scope.collections || []) {
    const profile = id === HISTORY_ID ? historyProfile() : profiles.find((p) => p.id === id);
    if (!profile) continue;
    let rs = scoped(records, plan, id);
    if (id === HISTORY_ID) rs = asHistory(rs);
    // Answers naming a brand, for "sources for Kovo" and the like.
    if ((intent === "sources" || intent === "searches") && plan.subject.brands.length) rs = rs.filter((r) => named(r).some((b) => plan.subject.brands.some((x) => fold(x) === fold(b))));
    // "Latest" = each engine's latest finished run, as the board's "Latest
    // answers"; "all" (trends, date ranges) = every turn in scope.
    const latest = plan.scope.runs === "latest" && id !== HISTORY_ID;
    const I = campaignInsights({ records: rs, profile, runs: latest ? runs : [], engines: plan.scope.engines && plan.scope.engines.length ? plan.scope.engines : null });
    if (!I) continue;
    for (const [k, v] of I.refs) if (!refs.has(k)) refs.set(k, v);
    // Coverage: the same turns, answered or not.
    const runRecs = I.run.id ? rs.filter((r) => runOf(r) === I.run.id) : rs;
    const coverage = {
      answers: I.run.answers,
      turns: runRecs.length,
      noAnswer: runRecs.filter((r) => !answered(r)).length,
      usageLimit: runRecs.filter((r) => usageLimitOf(r)).length,
      engines: I.run.engines,
      enginesMissing: (plan.scope.engines || []).filter((e) => !I.run.engines.includes(e)),
      run: I.run.date,
      runs: latest ? 1 : new Set(rs.map(runOf).filter(Boolean)).size,
    };
    parts.push({ collection: { id, name: profile.name, brand: I.campaign.brand }, coverage, data: shape(intent, plan, I, rs, profile, runs, records, opts) });
  }
  const ids = parts.flatMap((p) => p.data.ids || []);
  const shown = [...new Set(ids)].slice(0, MAX_REFS).map((id) => refs.get(id)).filter(Boolean);
  const result = {
    intent,
    scope: parts.map((p) => ({ collection: p.collection.name, ...p.coverage })),
    results: parts.map((p) => ({ collection: p.collection.name, yourBrand: p.collection.brand, ...strip(p.data) })),
    answersBehind: new Set(ids).size,
  };
  return { intent, parts, refs: shown, result };
}

const strip = ({ ids, ...x }) => x;
const pickBrands = (rows, plan, own) => {
  const want = [...plan.subject.brands.map(fold), ...(plan.subject.own && own ? [fold(own)] : [])];
  return want.length ? rows.filter((b) => want.includes(fold(b.brand))) : rows;
};

function shape(intent, plan, I, rs, profile, runs, allRecords, opts) {
  const own = I.campaign.brand;
  const by = plan.by;
  switch (intent) {
    case "trend": {
      const brands = plan.subject.brands.length ? plan.subject.brands : own ? [own] : I.overview.slice(0, 1).map((b) => b.brand);
      return { trend: brands.map((b) => ({ brand: b, runs: profile.id === HISTORY_ID ? [] : brandTrend({ records: rs, profile, runs, brand: b }) })), ids: I.prompts.flatMap((x) => x.ids) };
    }
    case "compare": {
      const rows = pickBrands(I.overview, plan, own);
      return { brands: rows, byEngine: I.byEngine.map((e) => ({ engine: e.engine, answers: e.answers, brands: pickBrands(e.brands, plan, own) })), ids: I.prompts.flatMap((x) => x.ids) };
    }
    case "gaps":
      return { promptsWhereAbsent: I.absent.slice(0, 10).map((x) => ({ prompt: x.prompt, rivalsNamed: x.rivalsNamed })), of: I.prompts.length, absentCount: I.absent.length,
        sourceGaps: I.sources.gaps.slice(0, 10).map((x) => ({ site: x.site, kind: x.kind, answersCitingWithRivalsOnly: x.withRivalsOnly })), ids: [...I.absent.flatMap((x) => x.ids), ...I.sources.gaps.flatMap((x) => x.ids)] };
    case "why":
      return { changes: I.changes, previousRun: I.previousRun && I.previousRun.date, promptsWhereAbsent: I.absent.slice(0, 5).map((x) => ({ prompt: x.prompt, rivalsNamed: x.rivalsNamed })), rivalWins: I.rivalWins.slice(0, 5).map(({ ids, ...x }) => x), ids: I.absent.flatMap((x) => x.ids) };
    case "sources":
      return { citations: I.sources.citations, yourSiteCitations: I.sources.ownSiteCitations, yourSiteShare: I.sources.ownSiteShare, sites: I.sources.top.slice(0, plan.limit || 10), kinds: I.sources.kinds, ids: [] };
    case "searches": return { ...I.searches, ids: [] };
    case "cards": return { ...I.products, ids: [] };
    case "data_status": return { engines: I.quality, ids: [] };
    case "find_answers": return findAnswers(plan, rs, allRecords, opts);
    default: {
      // metric / rank, sliced as asked.
      if (by === "engine") return { byEngine: I.byEngine.map((e) => ({ engine: e.engine, answers: e.answers, brands: pickBrands(e.brands, plan, own).slice(0, 8) })), ids: I.prompts.flatMap((x) => x.ids) };
      if (by === "tag") return { topics: I.topics.slice(0, 12), ids: [] };
      if (by === "prompt") return { prompts: I.prompts.slice(0, 15).map((x) => ({ prompt: x.prompt, yourBrandNamedIn: `${x.yoursIn} of ${x.answers}`, engines: x.engines })), ids: I.prompts.flatMap((x) => x.ids) };
      const rows = intent === "rank" ? I.overview : pickBrands(I.overview, plan, own);
      return { brands: (rows.length ? rows : I.overview).slice(0, intent === "rank" ? plan.limit || 10 : 12), changeSincePrevious: I.changes.filter((c) => !plan.subject.brands.length || pickBrands([c], plan, own).length), previousRun: I.previousRun && I.previousRun.date, ids: I.prompts.flatMap((x) => x.ids) };
    }
  }
}

// Wording search (Stage 3): the passage index, inside the scope. Keyword
// ranking (BM25, every word, typos and plurals tolerated), fused with the
// meaning model's ranking when that is on (opts.meaning: passage ids, best
// first). The excerpt is the matching passage itself.
function findAnswers(plan, rs, allRecords, opts = {}) {
  let pool = rs.filter(answered);
  if (plan.subject.brands.length) pool = pool.filter((r) => named(r).some((b) => plan.subject.brands.some((x) => fold(x) === fold(b))));
  const inScope = new Set(pool.map((r) => r.captureId));
  const byId = new Map(pool.map((r) => [r.captureId, r]));
  const text = String(plan.text || "").trim();
  let hits, fixed = [];
  if (!text) {
    hits = [...pool].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0)).map((r) => ({ r, excerpt: clip(r.answerText, 200) }));
  } else {
    const index = indexFor(allRecords);
    const docs = index.docs.filter((d) => inScope.has(d.captureId));
    const k = keywordHits(index, text, { pool: docs });
    fixed = k.fixed;
    let ranked = k.hits;
    if (opts.meaning && opts.meaning.length) {
      const score = new Map();
      k.hits.slice(0, 200).forEach((h, i) => score.set(h.doc.id, (score.get(h.doc.id) || 0) + 1 / (61 + i)));
      opts.meaning.slice(0, 200).forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (61 + i)));
      const docById = new Map(docs.map((d) => [d.id, d]));
      ranked = [...score.entries()].map(([id, s]) => ({ doc: docById.get(id), score: s })).filter((h) => h.doc).sort((a, b) => b.score - a.score);
    }
    hits = byAnswer(ranked).map((h) => ({ r: byId.get(h.doc.captureId), excerpt: clip(h.doc.text, 220) })).filter((h) => h.r);
  }
  return {
    found: hits.length,
    ...(fixed.length ? { readAs: fixed.map((f) => `${f.from} → ${f.to}`) } : {}),
    answers: hits.slice(0, 8).map(({ r, excerpt }) => ({ engine: ENGINE_LABEL[r.platform] || r.platform, date: new Date(r.capturedAt || 0).toISOString().slice(0, 10), prompt: clip(r.userPrompt, 120), excerpt })),
    ids: hits.slice(0, MAX_REFS).map((h) => h.r.captureId),
  };
}

function define(plan) {
  const keys = { visibility: "visibility", share_of_voice: "shareOfVoice", position: "avgPosition", mentions: "mentions", citations: "citations" };
  const want = (plan.measure || [])[0];
  const hit = Object.entries(GLOSSARY).find(([k, g]) => (want && (k === keys[want] || normName(g.term) === normName(want.replace(/_/g, " ")))))
    || Object.entries(GLOSSARY).find(([, g]) => fold(plan.question || "").includes(fold(g.term)));
  if (!hit) return { term: null, note: "Measures Ask can explain: visibility, share of voice, average position, mentions, citations." };
  const [, g] = hit;
  return { term: g.term, what: g.what, formula: g.formula || null, note: g.note || null };
}
