/*
 * assistantTools.js — what the Ask assistant can look up (0.73.0).
 *
 * Read-only tools over the user's own captures, campaigns and runs. The
 * model picks a tool and its arguments; the tool runs here, in code, and
 * every number it returns is computed the same way the boards compute it
 * (computeMetrics in geo.js), so the assistant can't make one up. Each
 * result carries the captures it came from, so an answer can link to them.
 * Nothing here writes or fetches.
 */
import { computeMetrics, trackedBrandsOf, normName } from "./geo.js";
import { siteKindOf, normDomain } from "./siteKind.js";
import { textHas } from "./textMatch.js";

const DAY = 24 * 60 * 60 * 1000;
const ENGINES = ["chatgpt", "gemini", "perplexity", "grok"];
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
];
export const TOOL_NAMES = TOOLS.map((t) => t.function.name);

function findCampaign(profiles, name) {
  const n = normName(name);
  if (!n) return null;
  return profiles.find((p) => normName(p.name) === n) || profiles.find((p) => normName(p.name).includes(n) || n.includes(normName(p.name))) || null;
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
    const p = findCampaign(profiles, a.campaign);
    if (!p) throw new Error(`No campaign called "${a.campaign || ""}". Campaigns: ${profiles.map((x) => x.name).join(", ") || "none"}.`);
    return p;
  };
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
      default: throw new Error(`Unknown tool ${name}. Tools: ${TOOL_NAMES.join(", ")}.`);
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
