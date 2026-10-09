/*
 * cited-domains.js — which publishers an answer actually leaned on.
 *
 * Feeds the "Cited Domains" card that sits right under Brand Mentions in the
 * Analyze tab. It replaced the old "Top Domains" table, which sorted by raw
 * URL count: a domain the engine fetched three times and never used outranked
 * the one it actually cited, which is backwards for GEO work. Here a citation
 * outranks any number of fetches.
 *
 * Pure and DOM-free so the ranking is testable (test/cited-domains.test.mjs).
 */

/**
 * Group a capture's sources by domain.
 *
 * @param {Array<{domain?: string, url?: string, outcome?: string, type?: string}>} sources
 * @returns {Array<{domain: string, cited: number, fetched: number, other: number,
 *   news: number, total: number, sourceIdxs: number[]}>}
 *   Ranked by cited count, then total URLs, then domain name. sourceIdxs point
 *   into the input array, cited sources first, so the card can list them.
 */
export function summarizeDomains(sources) {
  const byDomain = new Map();
  (sources || []).forEach((s, idx) => {
    if (!s) return;
    const domain = s.domain || hostOf(s.url);
    if (!domain) return;
    let d = byDomain.get(domain);
    if (!d) {
      d = { domain, cited: 0, fetched: 0, other: 0, news: 0, total: 0, sourceIdxs: [] };
      byDomain.set(domain, d);
    }
    if (s.outcome === "cited") d.cited++;
    else if (s.outcome === "fetched") d.fetched++;
    else d.other++;
    if (s.type === "news") d.news++;
    d.total++;
    d.sourceIdxs.push(idx);
  });

  const rank = { cited: 0, fetched: 1 };
  const list = [...byDomain.values()];
  for (const d of list) {
    d.sourceIdxs.sort((a, b) =>
      (rank[sources[a].outcome] ?? 2) - (rank[sources[b].outcome] ?? 2) || a - b);
  }
  return list.sort((a, b) =>
    b.cited - a.cited || b.total - a.total || a.domain.localeCompare(b.domain));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch (_) {
    return null;
  }
}
