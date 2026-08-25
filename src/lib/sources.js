/*
 * sources.js — citation and visibility metrics for source domains and URLs.
 *
 * Requested definition, verbatim: "if in 1 answer 2 times a url from same
 * domain was cited we should see 2 citations and 100% visibility. Now when we
 * look at 10 prompts, in which any url from that domain was cited in 5
 * prompts the Domain visibility would 50%, and let's say among those 5
 * prompts in 2 it was cited 2 times and in 1 it was cited 3 times and in next
 * 2 it was cited 1 & 1 times, so the total Citation of that domain would be
 * [the sum]."
 *
 * So the two numbers count different things on purpose, and the whole point
 * is that they must not be collapsed into one:
 *
 *   Citations  — every occurrence. A domain cited three times in one answer
 *                scored three. This is citation VOLUME.
 *   Visibility — the share of responses where it was cited AT LEAST ONCE.
 *                Cited five times in one answer out of ten and never again is
 *                10% visibility, not 50%. This is REACH.
 *
 * A domain can be high-volume and low-reach (one answer leans on it heavily)
 * or low-volume and high-reach (named once in nearly every answer). Those are
 * opposite situations and a single "citations" column hides which one you're
 * looking at — which is why this file exists rather than a count in the UI.
 *
 * Visibility is measured over RESPONSES, matching Brand Visibility in geo.js
 * (Peec: "responses mentioning your brand ÷ total responses"). With one
 * engine a response is a prompt and the two readings coincide; with two
 * engines they don't, so the distinct-prompt count is reported alongside
 * rather than substituted for it.
 *
 * Kept out of the panel so it is a plain function over data, testable without
 * a browser.
 */

/** One row's empty state, shared by the domain and URL aggregations. */
function emptyRow(key, extra = {}) {
  return {
    key,
    citations: 0,           // every occurrence — citation volume
    fetched: 0,             // pulled in as a source but never credited
    citedResponses: 0,      // responses citing it at least once — reach
    responses: 0,           // responses where it appeared at all
    citedPromptIds: new Set(),
    promptIds: new Set(),
    urls: new Set(),
    ...extra,
  };
}

/**
 * Aggregate a campaign's tracked runs into per-domain and per-URL rows.
 *
 * @param promptRuns    { [promptId]: run[] } — geo-prompt-performance's shape.
 *                      Each run: { captureId, capturedAt, platform, mentioned,
 *                      sources: [{ domain, url, outcome }] }
 * @param promptTextById Map/object promptId -> prompt text, for the drill-down.
 * @returns { domains, urls, totalResponses } — domains/urls are Maps keyed by
 *          domain/URL; every row carries `visibility` as a 0-100 percentage.
 */
export function aggregateSources(promptRuns, promptTextById = new Map()) {
  const textOf = (id) =>
    (promptTextById instanceof Map ? promptTextById.get(id) : promptTextById?.[id])
    || "(prompt no longer tracked)";

  const domains = new Map();
  const urls = new Map();
  let totalResponses = 0;

  for (const [promptId, runs] of Object.entries(promptRuns || {})) {
    for (const run of runs || []) {
      totalResponses++;

      // Per response, before touching the totals: which domains and URLs this
      // one answer cited. Counting a response as "cited" once per source
      // occurrence is exactly the mistake the definition above rules out —
      // three citations in one answer is three citations but one response.
      const citedDomains = new Set();
      const citedUrls = new Set();
      const seenDomains = new Set();
      const seenUrls = new Set();

      for (const sc of run.sources || []) {
        const cited = sc.outcome === "cited";
        const fetched = sc.outcome === "fetched";

        if (sc.domain) {
          let d = domains.get(sc.domain);
          if (!d) { d = emptyRow(sc.domain); domains.set(sc.domain, d); }
          if (cited) d.citations++;
          if (fetched) d.fetched++;
          d.promptIds.add(promptId);
          if (sc.url) d.urls.add(sc.url);
          seenDomains.add(sc.domain);
          if (cited) { citedDomains.add(sc.domain); d.citedPromptIds.add(promptId); }
        }

        if (sc.url) {
          let u = urls.get(sc.url);
          if (!u) { u = emptyRow(sc.url, { domain: sc.domain || "", runs: new Map() }); urls.set(sc.url, u); }
          if (cited) u.citations++;
          if (fetched) u.fetched++;
          u.promptIds.add(promptId);
          seenUrls.add(sc.url);
          if (cited) { citedUrls.add(sc.url); u.citedPromptIds.add(promptId); }

          // Keyed by capture so one response listing the same URL twice is
          // still one run in the drill-down list.
          const prev = u.runs.get(run.captureId);
          if (!prev) {
            u.runs.set(run.captureId, {
              captureId: run.captureId,
              capturedAt: run.capturedAt,
              platform: run.platform,
              promptId,
              promptText: textOf(promptId),
              cited,
              mentioned: run.mentioned,
            });
          } else if (cited) prev.cited = true;
        }
      }

      for (const k of seenDomains) domains.get(k).responses++;
      for (const k of citedDomains) domains.get(k).citedResponses++;
      for (const k of seenUrls) urls.get(k).responses++;
      for (const k of citedUrls) urls.get(k).citedResponses++;
    }
  }

  // Every row carries the denominator it was computed against, so a row
  // handed to a drill-down on its own can still say "5 of 10" rather than
  // just a bare percentage the reader has to take on trust.
  for (const row of domains.values()) {
    row.totalResponses = totalResponses;
    row.visibility = totalResponses ? (row.citedResponses / totalResponses) * 100 : 0;
    row.urlList = [...row.urls].map((u) => urls.get(u)).filter(Boolean);
  }
  for (const row of urls.values()) {
    row.totalResponses = totalResponses;
    row.visibility = totalResponses ? (row.citedResponses / totalResponses) * 100 : 0;
  }

  return { domains, urls, totalResponses };
}

/**
 * The same shape, but from ad-hoc captures rather than a campaign's tracked
 * runs — so the plain Dashboard's Top Domains list opens the identical
 * drill-down a campaign's Source Domains table does.
 *
 * Each capture is its own "prompt" here; there is no tracked prompt to group
 * by, so reach is measured over captures.
 */
export function aggregateSourcesFromCaptures(records) {
  const runs = {};
  for (const rec of records || []) {
    runs[rec.captureId] = [{
      captureId: rec.captureId,
      capturedAt: rec.capturedAt,
      platform: rec.platform,
      mentioned: null,
      sources: rec.sources || [],
    }];
  }
  const texts = new Map((records || []).map((r) => [r.captureId, r.userPrompt || "(no prompt text)"]));
  return aggregateSources(runs, texts);
}
