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
    return true;
  });
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
export function execute(plan, data) {
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
    parts.push({ collection: { id, name: profile.name, brand: I.campaign.brand }, coverage, data: shape(intent, plan, I, rs, profile, runs) });
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

function shape(intent, plan, I, rs, profile, runs) {
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
    case "find_answers": return findAnswers(plan, rs);
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

// Stage 1 wording search: every word of the text in the prompt or answer,
// newest first. Stage 3 replaces this with the passage index.
function findAnswers(plan, rs) {
  const words = String(plan.text || "").split(/\s+/).filter((w) => w.length > 2);
  let hits = rs.filter(answered);
  if (plan.subject.brands.length) hits = hits.filter((r) => named(r).some((b) => plan.subject.brands.some((x) => fold(x) === fold(b))));
  if (words.length) hits = hits.filter((r) => { const hay = fold(`${r.userPrompt || ""} ${r.answerText || ""}`); return words.every((w) => hay.includes(w)); });
  hits.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  const snippet = (r) => {
    const t = String(r.answerText || "");
    const w = words[0] || (plan.subject.brands[0] && fold(plan.subject.brands[0]));
    const i = w ? fold(t).indexOf(w) : -1;
    return clip(i > 60 ? `…${t.slice(i - 60)}` : t, 200);
  };
  return { found: hits.length, answers: hits.slice(0, 8).map((r) => ({ engine: ENGINE_LABEL[r.platform] || r.platform, date: new Date(r.capturedAt || 0).toISOString().slice(0, 10), prompt: clip(r.userPrompt, 120), excerpt: snippet(r) })), ids: hits.slice(0, MAX_REFS).map((r) => r.captureId) };
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
