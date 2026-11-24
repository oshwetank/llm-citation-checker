/*
 * assistantTools.js — what the Ask assistant can look up (0.73.0).
 *
 * Read-only tools over the user's own captures, campaigns and runs. The
 * model picks a tool and its arguments; the tool runs here, in code, and
 * every number it returns is computed the same way the boards compute it
 * (computeMetrics in geo.js), so the assistant can't make one up. Each
 * result carries the captures it came from, so an answer can link to them.
 * Nothing here writes or fetches.
 *
 * 0.75.0: twenty tools, most built on lib/insights.js — the same findings
 * the board and the hand-off use — so Ask can answer about gaps, rivals,
 * sources, topics, cards, searches, ads and data quality, not just the
 * headline numbers. A campaign may be left out when there is only one (or
 * the latest is meant): small models often forget to name it.
 */
import { computeMetrics, trackedBrandsOf, normName } from "./geo.js";
import { siteKindOf, normDomain } from "./siteKind.js";
import { textHas } from "./textMatch.js";
import { campaignInsights, brandTrend } from "./insights.js";
import { GLOSSARY } from "./glossary.js";

const DAY = 24 * 60 * 60 * 1000;
const ENGINES = ["chatgpt", "gemini", "perplexity", "grok", "aimode"];
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The tool list, in the JSON-schema shape chat templates take. */
export const TOOLS = [
  { type: "function", function: { name: "list_campaigns", description: "List the user's campaigns: name, own brand, competitors, number of prompts and runs, and when it last ran.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "campaign_metrics", description: "Share of voice, visibility (% of answers naming the brand) and average position for each tracked brand in a campaign's latest finished run.", parameters: { type: "object", properties: { campaign: { type: "string", description: "Campaign name" }, engine: { type: "string", enum: ENGINES, description: "Only this engine" } }, required: ["campaign"] } } },
  { type: "function", function: { name: "query_answers", description: "Find captured answers by words in the prompt or answer, engine, a brand they name, or how recent.", parameters: { type: "object", properties: { text: { type: "string" }, engine: { type: "string", enum: ENGINES }, brand: { type: "string" }, days: { type: "integer", description: "Only the last N days" }, limit: { type: "integer" } } } } },
  { type: "function", function: { name: "get_answer", description: "One captured answer: its prompt, engine, date, the start of the answer, the brands named and the sites cited.", parameters: { type: "object", properties: { id: { type: "string", description: "The answer id from query_answers" } }, required: ["id"] } } },
  { type: "function", function: { name: "compare_brands", description: "Compare brands across captured answers (optionally one campaign): answers naming each, mentions, and how often each is named first, per engine.", parameters: { type: "object", properties: { brands: { type: "array", items: { type: "string" } }, campaign: { type: "string" } }, required: ["brands"] } } },
  { type: "function", function: { name: "top_sources", description: "The sites cited most, with their kind (review site, retailer, forum, public…), optionally for one campaign or only answers naming a brand.", parameters: { type: "object", properties: { campaign: { type: "string" }, brand: { type: "string" }, limit: { type: "integer" } } } } },
  { type: "function", function: { name: "brand_trend", description: "A brand's visibility and share of voice in each run of a campaign, oldest first.", parameters: { type: "object", properties: { brand: { type: "string" }, campaign: { type: "string" } }, required: ["brand", "campaign"] } } },
  // 0.75.0, built on lib/insights.js. `campaign` may be left out: the only
  // campaign, or the one run most recently.
  ...[
    ["campaign_overview", "A campaign's latest run in one view: every brand's visibility, share of voice, average position and mentions, overall and per engine, and how each changed since the previous run."],
    ["prompts_where_absent", "Prompts where your brand is never named but two or more rivals are, in the latest run: the coverage gaps."],
    ["prompts_behind", "Prompts where your brand is named but a rival comes first on at least one engine."],
    ["rival_wins", "For each rival (or one, with `brand`): how many answers it is named first in, appears in without you, and comes before you."],
    ["source_gaps", "Sites the engines cited in answers that name rivals but never in an answer that names you; the sites worth getting onto."],
    ["own_site_share", "How many of all citations went to your own website, in the latest run."],
    ["topic_breakdown", "Your visibility per topic (the prompts' primary tag, or their wording) and which brand is most often named first in each."],
    ["engine_compare", "Each engine side by side: answers, and every brand's visibility, share of voice and position on it."],
    ["engine_disagreement", "Prompts where the engines name a different brand first."],
    ["products_named", "Product cards shown in answers: how many answers had cards, and each brand's cards and first cards, with its products."],
    ["fanout_searches", "The web searches the engines ran to answer: how many, how many per answer, which named you or rivals, and examples."],
    ["ads_seen", "Ads ChatGPT showed next to the answers, by advertiser."],
    ["data_quality", "Per engine: answers captured, with an answer, and stopped by a usage limit, in the latest run."],
  ].map(([name, description]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: {
    campaign: { type: "string", description: "Campaign name (optional if there is one)" },
    ...(name === "rival_wins" ? { brand: { type: "string", description: "One rival" } } : {}),
    ...(name === "campaign_overview" || name === "topic_breakdown" || name === "prompts_where_absent" ? { engine: { type: "string", enum: ENGINES, description: "Only this engine" } } : {}),
  } } } })),
  { type: "function", function: { name: "prompt_detail", description: "One prompt of a campaign: on each engine, whether you are named, at what rank, who comes first, and the answers to open.", parameters: { type: "object", properties: { campaign: { type: "string" }, prompt: { type: "string", description: "Words from the prompt" } }, required: ["prompt"] } } },
  { type: "function", function: { name: "glossary", description: "What one of CitoSkeleton's measures means and how it is counted (e.g. visibility, share of voice, average position, citations).", parameters: { type: "object", properties: { term: { type: "string" } }, required: ["term"] } } },
];
export const TOOL_NAMES = TOOLS.map((t) => t.function.name);

function findCampaign(profiles, name) {
  const n = normName(name);
  if (!n) return null;
  return profiles.find((p) => normName(p.name) === n) || profiles.find((p) => normName(p.name).includes(n) || n.includes(normName(p.name))) || null;
}
// The campaign meant when none is named: the only one, or the one run last.
function latestCampaign(profiles, runs) {
  if (profiles.length <= 1) return profiles[0] || null;
  const last = (p) => runs.filter((g) => g.profileId === p.id).reduce((m, g) => Math.max(m, g.startedAt || 0), 0);
  return [...profiles].sort((x, y) => last(y) - last(x))[0];
}
const recsOf = (records, profile) => records.filter((r) => r.geo && r.geo.profileId === profile.id);
const answered = (r) => String(r.answerText || "").trim().length > 0;
function latestRunRecs(records, runs, profile) {
  const mine = recsOf(records, profile).filter(answered);
  const done = runs.filter((g) => g.profileId === profile.id && g.status !== "running").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  for (const g of done) { const rs = mine.filter((r) => r.runId === g.id || (r.geo && r.geo.runId === g.id)); if (rs.length) return { run: g, recs: rs }; }
  return { run: null, recs: mine };
}
const brandsNamed = (r) => (r.brandMentions || []).filter((m) => m && m.brand && (m.count || 0) > 0).map((m) => m.brand);
const firstBrand = (r) => { const b = [...(r.brandMentions || [])].filter((m) => (m.count || 0) > 0).sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15))[0]; return b ? b.brand : null; };
const ref = (r) => ({ id: r.captureId, engine: r.platform, prompt: clip(r.userPrompt, 90) });

/**
 * Run one tool.
 * @param {string} name
 * @param {object} args
 * @param {{records: object[], profiles?: object[], runs?: object[], now?: number}} data
 * @returns {{ok: boolean, result?: any, error?: string, refs?: object[]}}
 */
export function runTool(name, args = {}, data = {}) {
  const records = data.records || [], profiles = data.profiles || [], runs = data.runs || [];
  const now = data.now || Date.now();
  const a = args && typeof args === "object" ? args : {};
  const needCampaign = () => {
    let p = a.campaign ? findCampaign(profiles, a.campaign) : null;
    if (!p && !a.campaign) p = latestCampaign(profiles, runs);
    if (!p) throw new Error(`No campaign called "${a.campaign || ""}". Campaigns: ${profiles.map((x) => x.name).join(", ") || "none"}.`);
    return p;
  };
  // One worked-out view per campaign (and engine) for this question.
  const cache = data._insights || (data._insights = new Map());
  const insightsOf = (p, engine) => {
    const k = `${p.id}|${engine || ""}`;
    if (!cache.has(k)) cache.set(k, campaignInsights({ records, profile: p, runs, engines: engine ? [engine] : null }));
    return cache.get(k);
  };
  const withRefs = (I, ids) => [...new Set(ids)].slice(0, 8).map((id) => I.refs.get(id)).filter(Boolean);
  const head = (I) => ({ campaign: I.campaign.name, yourBrand: I.campaign.brand, run: I.run.date, answers: I.run.answers, engines: I.run.engines });
  try {
    switch (name) {
      case "list_campaigns": {
        const result = profiles.map((p) => {
          const rs = runs.filter((g) => g.profileId === p.id);
          const last = rs.reduce((m, g) => Math.max(m, g.startedAt || 0), 0);
          return { name: p.name, brand: p.brand && p.brand.name || null, competitors: (p.competitors || []).map((c) => c.name).filter(Boolean),
            prompts: (p.prompts || []).length || new Set(recsOf(records, p).map((r) => r.geo.promptId || r.userPrompt)).size, runs: rs.length, lastRun: last ? new Date(last).toISOString().slice(0, 10) : null };
        });
        return { ok: true, result };
      }
      case "campaign_metrics": {
        const p = needCampaign();
        let { run, recs } = latestRunRecs(records, runs, p);
        if (a.engine) recs = recs.filter((r) => r.platform === a.engine);
        if (!recs.length) return { ok: true, result: { campaign: p.name, answers: 0, note: "No answered prompts in its latest run." } };
        const m = computeMetrics(recs, p, trackedBrandsOf(p).length ? trackedBrandsOf(p) : [...new Set(recs.flatMap(brandsNamed))].slice(0, 12).map((n) => ({ name: n })));
        return { ok: true, refs: recs.slice(0, 6).map(ref), result: {
          campaign: p.name, run: run ? new Date(run.startedAt).toISOString().slice(0, 10) : null, engine: a.engine || "all", answers: m.totalResponses,
          brands: m.brands.slice(0, 12).map((b) => ({ brand: b.name, yours: b.isOwn, shareOfVoice: r1(b.shareOfVoice), visibility: r1(b.visibility), avgPosition: r1(b.avgPosition), mentions: b.mentions })),
        } };
      }
      case "query_answers": {
        let rs = records.filter(answered);
        if (a.engine) rs = rs.filter((r) => r.platform === a.engine);
        if (a.days) rs = rs.filter((r) => (r.capturedAt || 0) >= now - Number(a.days) * DAY);
        if (a.brand) rs = rs.filter((r) => brandsNamed(r).some((b) => normName(b) === normName(a.brand)) || textHas(r.answerText, a.brand));
        if (a.text) { const words = String(a.text).toLowerCase().split(/\s+/).filter((w) => w.length > 2); rs = rs.filter((r) => { const hay = `${r.userPrompt || ""} ${r.answerText || ""}`.toLowerCase(); return words.every((w) => hay.includes(w)); }); }
        rs.sort((x, y) => (y.capturedAt || 0) - (x.capturedAt || 0));
        const limit = Math.max(1, Math.min(20, Number(a.limit) || 8));
        return { ok: true, refs: rs.slice(0, limit).map(ref), result: { found: rs.length, answers: rs.slice(0, limit).map((r) => ({ id: r.captureId, engine: r.platform, date: new Date(r.capturedAt || 0).toISOString().slice(0, 10), prompt: clip(r.userPrompt, 120), namedFirst: firstBrand(r), brands: brandsNamed(r).slice(0, 6) })) } };
      }
      case "get_answer": {
        const r = records.find((x) => x.captureId === a.id);
        if (!r) throw new Error(`No answer with id ${a.id}.`);
        return { ok: true, refs: [ref(r)], result: { id: r.captureId, engine: r.platform, date: new Date(r.capturedAt || 0).toISOString().slice(0, 10), prompt: r.userPrompt || "", answer: clip(r.answerText, 1500),
          brands: (r.brandMentions || []).slice(0, 12).map((m) => ({ brand: m.brand, mentions: m.count })), cited: [...new Set((r.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url)))].slice(0, 12),
          ...(r.ai && r.ai.market ? { market: r.ai.market.country || null } : {}), ...(r.ai && r.ai.lang ? { language: r.ai.lang } : {}) } };
      }
      case "compare_brands": {
        const names = (Array.isArray(a.brands) ? a.brands : String(a.brands || "").split(/,\s*/)).map(String).filter(Boolean).slice(0, 6);
        if (names.length < 1) throw new Error("Name at least one brand.");
        let rs = records.filter(answered);
        if (a.campaign) rs = recsOf(rs, needCampaign());
        const per = (sub) => names.map((n) => ({ brand: n, answers: sub.filter((r) => brandsNamed(r).some((b) => normName(b) === normName(n)) || textHas(r.answerText, n)).length, mentions: sub.reduce((s, r) => s + ((r.brandMentions || []).find((m) => normName(m.brand) === normName(n)) || { count: 0 }).count, 0), namedFirst: sub.filter((r) => normName(firstBrand(r)) === normName(n)).length }));
        const byEngine = Object.fromEntries(ENGINES.map((e) => [e, rs.filter((r) => r.platform === e)]).filter(([, v]) => v.length).map(([e, v]) => [e, { answers: v.length, brands: per(v) }]));
        return { ok: true, result: { answers: rs.length, brands: per(rs), byEngine } };
      }
      case "top_sources": {
        let rs = records.filter(answered);
        if (a.campaign) rs = recsOf(rs, needCampaign());
        if (a.brand) rs = rs.filter((r) => brandsNamed(r).some((b) => normName(b) === normName(a.brand)));
        const m = new Map();
        for (const r of rs) for (const d of new Set((r.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean))) m.set(d, (m.get(d) || 0) + 1);
        const limit = Math.max(1, Math.min(25, Number(a.limit) || 10));
        return { ok: true, result: { answers: rs.length, sites: [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([site, n]) => ({ site, answersCiting: n, kind: siteKindOf(site, {}) })) } };
      }
      case "brand_trend": {
        const p = needCampaign();
        const mine = recsOf(records, p).filter(answered);
        const rs = runs.filter((g) => g.profileId === p.id && g.status !== "running").sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
        const brands = trackedBrandsOf(p).some((b) => normName(b.name) === normName(a.brand)) ? trackedBrandsOf(p) : [...trackedBrandsOf(p), { name: a.brand }];
        const result = rs.map((g) => { const sub = mine.filter((r) => r.runId === g.id || (r.geo && r.geo.runId === g.id)); if (!sub.length) return null; const m = computeMetrics(sub, p, brands); const b = m.brands.find((x) => normName(x.name) === normName(a.brand)); return { run: new Date(g.startedAt).toISOString().slice(0, 10), answers: sub.length, visibility: r1(b && b.visibility), shareOfVoice: r1(b && b.shareOfVoice), avgPosition: r1(b && b.avgPosition) }; }).filter(Boolean);
        return { ok: true, result: { campaign: p.name, brand: a.brand, runs: result } };
      }
      case "campaign_overview": {
        const p = needCampaign();
        const I = insightsOf(p, a.engine);
        return { ok: true, refs: withRefs(I, I.prompts.flatMap((x) => x.ids)), result: { ...head(I), previousRun: I.previousRun && I.previousRun.date,
          brands: I.overview.slice(0, 10), changeSincePrevious: I.changes.slice(0, 10), byEngine: I.byEngine.map((e) => ({ engine: e.engine, answers: e.answers, brands: e.brands.slice(0, 6).map((b) => ({ brand: b.brand, visibility: b.visibility, shareOfVoice: b.shareOfVoice, avgPosition: b.avgPosition })) })) } };
      }
      case "prompts_where_absent": {
        const I = insightsOf(needCampaign(), a.engine);
        return { ok: true, refs: withRefs(I, I.absent.flatMap((x) => x.ids)), result: { ...head(I), count: I.absent.length, of: I.prompts.length, prompts: I.absent.slice(0, 10).map((x) => ({ prompt: x.prompt, tags: x.tags, rivalsNamed: x.rivalsNamed, first: x.engines })) } };
      }
      case "prompts_behind": {
        const I = insightsOf(needCampaign());
        return { ok: true, refs: withRefs(I, I.behind.flatMap((x) => x.ids)), result: { ...head(I), count: I.behind.length, prompts: I.behind.slice(0, 10).map((x) => ({ prompt: x.prompt, engines: x.engines })) } };
      }
      case "rival_wins": {
        const I = insightsOf(needCampaign());
        const rows = a.brand ? I.rivalWins.filter((x) => normName(x.brand) === normName(a.brand)) : I.rivalWins;
        return { ok: true, refs: withRefs(I, rows.flatMap((x) => x.ids)), result: { ...head(I), rivals: rows.slice(0, 8).map(({ ids, ...x }) => x) } };
      }
      case "source_gaps": {
        const I = insightsOf(needCampaign());
        return { ok: true, refs: withRefs(I, I.sources.gaps.flatMap((x) => x.ids)), result: { ...head(I), sites: I.sources.gaps.slice(0, 12).map((x) => ({ site: x.site, kind: x.kind, answersCitingWithRivalsOnly: x.withRivalsOnly, engines: x.engines })) } };
      }
      case "own_site_share": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), site: I.campaign.site, citations: I.sources.citations, yourSiteCitations: I.sources.ownSiteCitations, yourSiteShare: I.sources.ownSiteShare, kindsOfSitesCited: I.sources.kinds } };
      }
      case "topic_breakdown": {
        const I = insightsOf(needCampaign(), a.engine);
        return { ok: true, result: { ...head(I), topics: I.topics.slice(0, 12) } };
      }
      case "engine_compare": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), engines: I.byEngine.map((e) => ({ engine: e.engine, answers: e.answers, brands: e.brands.slice(0, 8) })) } };
      }
      case "engine_disagreement": {
        const I = insightsOf(needCampaign());
        return { ok: true, refs: withRefs(I, I.disagreements.flatMap((x) => x.ids)), result: { ...head(I), count: I.disagreements.length, of: I.prompts.length, prompts: I.disagreements.slice(0, 10).map(({ ids, ...x }) => x) } };
      }
      case "products_named": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), ...I.products } };
      }
      case "fanout_searches": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), ...I.searches } };
      }
      case "ads_seen": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), ...I.ads, note: "Only ChatGPT shows this ad format; clicks, impressions and spend are not captured." } };
      }
      case "data_quality": {
        const I = insightsOf(needCampaign());
        return { ok: true, result: { ...head(I), engines: I.quality } };
      }
      case "prompt_detail": {
        const I = insightsOf(needCampaign());
        const words = String(a.prompt || "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const scored = I.prompts.map((x) => ({ x, n: words.filter((w) => x.prompt.toLowerCase().includes(w)).length })).filter((y) => y.n).sort((u, v) => v.n - u.n);
        if (!scored.length) throw new Error(`No prompt in "${I.campaign.name}" matches "${a.prompt}".`);
        const x = scored[0].x;
        return { ok: true, refs: withRefs(I, x.ids), result: { ...head(I), prompt: x.prompt, tags: x.tags, yourBrandNamedIn: `${x.yoursIn} of ${x.answers} engines`, rivalsNamed: x.rivalsNamed, engines: x.engines } };
      }
      case "glossary": {
        const q = normName(a.term);
        const hit = Object.entries(GLOSSARY).find(([k, g]) => normName(k) === q || normName(g.term) === q) || Object.entries(GLOSSARY).find(([k, g]) => normName(g.term).includes(q) || q.includes(normName(g.term)));
        if (!hit) throw new Error(`No measure called "${a.term}". Some are: visibility, share of voice, average position, mentions, citations.`);
        const [, g] = hit;
        return { ok: true, result: { term: g.term, what: g.what, formula: g.formula || null, note: g.note || null } };
      }
      default: throw new Error(`Unknown tool ${name}. Tools: ${TOOL_NAMES.join(", ")}.`);
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
