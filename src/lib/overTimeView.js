/*
 * overTimeView.js — one prompt's answers, run by run (0.60.0, the canvas's
 * Over time board).
 *
 * The Compare page listed each run's numbers and then matrices of counts.
 * The canvas asks for the movement itself: where each brand came in each
 * run, which sites were cited in each run, what the searches were after and
 * in how many runs, any ad shown, and what changed between the first run and
 * the latest. All of it is read from the light capture rows (no answer
 * text), so the page never waits on loading every full record.
 */
import { normalizeMentions } from "./mention-list.js";
import { sameBrand } from "./funnel-omitted.js";
import { normDomain } from "./siteKind.js";
import { knownVendors, changesView } from "./analyzeView.js";
import { computeSearchIntentGraph } from "./grounding-score.js";

const named = (rec) => normalizeMentions(rec.brandMentions || [], knownVendors(rec)).filter((b) => b.count > 0).map((b) => b.brand);
const citedDomains = (rec) => new Set((rec.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean));
const queries = (rec) => ["search", "shopping", "image"].flatMap((k) => (rec.fanout && rec.fanout[k]) || [])
  .map((q) => (typeof q === "string" ? q : q && q.query)).filter((q) => typeof q === "string" && q.trim());

/**
 * @param {object[]} caps  the captures of one prompt, oldest first
 * @param {{ own?: {name:string}, maxBrands?: number, maxSites?: number }} opts
 */
export function overTimeView(caps, { own, maxBrands = 6, maxSites = 14 } = {}) {
  const list = (caps || []).filter(Boolean);
  if (!list.length) return null;
  const orders = list.map(named);
  const posOf = (i, name) => orders[i].findIndex((b) => sameBrand(b, name)) + 1;

  const runs = list.map((r, i) => {
    const ps = r.platformSpecific || {};
    return {
      n: i + 1, at: r.capturedAt, captureId: r.captureId, platform: r.platform, model: r.model || "",
      searches: queries(r).length, searched: !!r.searched, read: (r.sources || []).length, cited: (r.sources || []).filter((s) => s.outcome === "cited").length,
      brands: orders[i].length, first: orders[i][0] || "",
      words: ps.wordCount || (r.answerChars ? Math.round(r.answerChars / 6) : 0),
      you: own ? posOf(i, own.name) : null,
      ads: [...new Set((r.ads || []).map((a) => String(a.advertiser || a.targetDomain || "").trim()).filter(Boolean))],
    };
  });

  // The brands named most often across the runs, yours always among them.
  const seen = new Map();
  orders.forEach((o) => o.forEach((b) => {
    const k = [...seen.keys()].find((x) => sameBrand(x, b)) || b;
    seen.set(k, (seen.get(k) || 0) + 1);
  }));
  let top = [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b);
  if (own && !top.slice(0, maxBrands).some((b) => sameBrand(b, own.name)) && top.some((b) => sameBrand(b, own.name))) {
    top = [own.name, ...top.filter((b) => !sameBrand(b, own.name))];
  }
  const brandLines = top.slice(0, maxBrands).map((name) => {
    const positions = list.map((_, i) => posOf(i, name));
    const firstPos = positions[0], lastPos = positions[positions.length - 1];
    const trend = !firstPos && lastPos ? "new" : firstPos && !lastPos ? "gone" : !firstPos && !lastPos ? "in between"
      : firstPos === lastPos ? `held ${ord(lastPos)}` : `${ord(firstPos)} → ${ord(lastPos)}`;
    return { name, isYou: !!own && sameBrand(own.name, name), positions, trend, up: firstPos && lastPos ? firstPos - lastPos : 0 };
  });

  // Sites cited, run by run.
  const cited = list.map(citedDomains);
  const count = new Map();
  cited.forEach((set) => set.forEach((d) => count.set(d, (count.get(d) || 0) + 1)));
  const sites = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxSites).map(([domain, n]) => {
    const cells = cited.map((set) => set.has(domain));
    const firstIn = cells[0], lastIn = cells[cells.length - 1];
    const trend = n === list.length ? "every run" : !firstIn && lastIn ? "new" : firstIn && !lastIn ? "dropped" : `${n} of ${list.length}`;
    return { domain, cells, n, trend };
  });

  // Searches, grouped by what they were after, with the runs that had them.
  const graph = computeSearchIntentGraph(list);
  const intents = Object.entries(graph).filter(([, b]) => b.count).map(([key, b]) => {
    const texts = new Set(b.queries.map((q) => q.query.toLowerCase()));
    const inRuns = list.filter((r) => queries(r).some((q) => texts.has(q.trim().toLowerCase()))).length;
    return { key, label: b.label, count: b.count, inRuns, queries: b.queries.slice(0, 3).map((q) => q.query) };
  }).sort((a, b) => b.inRuns - a.inRuns || b.count - a.count);

  // First run against the latest.
  const first = list[0], last = list[list.length - 1];
  const a = cited[0], z = cited[cited.length - 1];
  const kept = a.size ? Math.round(([...a].filter((d) => z.has(d)).length / a.size) * 100) : null;
  const changed = list.length > 1 ? {
    from: first.capturedAt, to: last.capturedAt,
    you: own ? { from: runs[0].you, to: runs[runs.length - 1].you } : null,
    kept, gained: [...z].filter((d) => !a.has(d)).length, lost: [...a].filter((d) => !z.has(d)).length,
    searches: [runs[0].searches, runs[runs.length - 1].searches],
    words: [runs[0].words, runs[runs.length - 1].words],
    items: (changesView(last, first, { knownBrands: knownVendors(last) }) || { items: [] }).items,
  } : null;

  return {
    runs, brandLines, sites, intents, changed,
    engines: [...new Set(list.map((r) => r.platform))],
    anyAds: runs.some((r) => r.ads.length),
  };
}

function ord(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
