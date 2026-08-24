/*
 * fanout.js — analysis of the sub-queries an engine actually ran.
 *
 * The raw fan-out list (an array of {query} objects from the adapters) is the
 * closest thing available to the engine's own retrieval strategy, and until
 * now the UI only counted it and printed the strings. Everything here is
 * pure, synchronous and dependency-free so it stays unit-testable.
 *
 * What's extracted, and why each one earns its place:
 *
 *  - Search operators, `site:` above all. ChatGPT has moved to leaning
 *    heavily on site:-scoped fan-out queries — reported both in Nectiv's
 *    28K-query study and in Lily Ray's tracking of the shift, and read as
 *    OpenAI curating toward sources it trusts rather than searching the open
 *    web. Which domains an engine scopes a search TO is therefore a direct
 *    read on the sources it considers authoritative for a topic, which is
 *    exactly the question this tool exists to answer. Also handled:
 *    -site: exclusions, quoted phrases, OR, filetype:, intitle:/inurl:,
 *    after:/before:.
 *
 *  - Query length. The same studies put average fan-out query length at
 *    roughly 3x what it was (~5 -> ~15 words in Nectiv's sample; ~6 -> ~12
 *    across Peec's 20M-query set). Long, heavily-qualified queries reward
 *    pages that match specific detail rather than broad head terms, so the
 *    word-count distribution is a signal worth having per capture.
 *
 *  - Fan-out breadth against a published benchmark. Nectiv measured mean
 *    queries-per-prompt rising 2.17 -> 7.61, with 55% of prompts landing in
 *    the 6-12 band and a longest observed chain of 29. A bare "Fan-out: 1"
 *    means nothing on its own; "1, well below the ~7.6 typical" does.
 *
 *  - Intent classification. Query-variant taxonomies used across fan-out
 *    coverage analysis converge on a small set of recurring shapes
 *    (comparison, commercial/superlative, definition, how-to, pricing,
 *    review, spec, plus temporal and geographic qualification). Labelling
 *    each sub-query shows WHICH angle the engine researched — and, by
 *    omission, which angle a page could still own.
 *
 * Benchmarks are stated as of the 2026 studies above and will drift; they're
 * collected in FANOUT_BENCHMARK so there's one place to update them.
 */

export const FANOUT_BENCHMARK = {
  meanPerPrompt: 7.61,       // Nectiv, ~4k prompts
  priorMeanPerPrompt: 2.17,  // same study, prior period
  typicalBandLow: 6,
  typicalBandHigh: 12,
  maxObserved: 29,
  meanWords: 15,             // Nectiv (~600 queries); Peec's 20M set puts it ~12
  priorMeanWords: 5,
};

// Bare-domain shape, deliberately loose: engines emit things like
// site:reddit.com, site:www.gadgets360.com and site:en.wikipedia.org/wiki.
const DOMAINISH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

function normDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].replace(/[),.;]+$/, "");
  return DOMAINISH.test(d) ? d : null;
}

/**
 * Pulls search operators out of one query string.
 * Returns { siteIncludes, siteExcludes, phrases, hasOr, filetypes, inTitle,
 *           inUrl, dateFilters, bare } where `bare` is the query with the
 * operator syntax stripped, i.e. the words actually being searched for.
 */
export function parseQueryOperators(query) {
  const q = String(query || "");
  const siteIncludes = [];
  const siteExcludes = [];
  const phrases = [];
  const filetypes = [];
  const inTitle = [];
  const inUrl = [];
  const dateFilters = [];

  // Quoted phrases first, so their contents can't be mistaken for operators.
  let rest = q.replace(/"([^"]+)"/g, (_m, inner) => {
    const t = inner.trim();
    if (t) phrases.push(t);
    return " ";
  });

  rest = rest.replace(/(-?)\bsite:\s*([^\s"]+)/gi, (_m, neg, val) => {
    const d = normDomain(val);
    if (d) (neg === "-" ? siteExcludes : siteIncludes).push(d);
    return " ";
  });
  rest = rest.replace(/\bfiletype:\s*([a-z0-9]+)/gi, (_m, v) => {
    filetypes.push(v.toLowerCase());
    return " ";
  });
  rest = rest.replace(/\bintitle:\s*([^\s]+)/gi, (_m, v) => { inTitle.push(v); return " "; });
  rest = rest.replace(/\binurl:\s*([^\s]+)/gi, (_m, v) => { inUrl.push(v); return " "; });
  rest = rest.replace(/\b(after|before):\s*([0-9-]+)/gi, (_m, k, v) => {
    dateFilters.push(`${k.toLowerCase()}:${v}`);
    return " ";
  });

  // A bare "OR" between terms (not the word "or" mid-sentence) is Google
  // syntax; require it uppercase, which is how engines actually emit it.
  const hasOr = /\sOR\s/.test(` ${rest} `);

  return {
    siteIncludes: [...new Set(siteIncludes)],
    siteExcludes: [...new Set(siteExcludes)],
    phrases,
    hasOr,
    filetypes: [...new Set(filetypes)],
    inTitle,
    inUrl,
    dateFilters,
    bare: rest.replace(/\s+/g, " ").trim(),
  };
}

// Intent labels. Order matters only for readability — a query can carry
// several, and all matching labels are returned.
const INTENT_RULES = [
  ["comparison", /\bvs\.?\b|\bversus\b|\bcompare[ds]?\b|\bdifference between\b|\bor\b\s+\w+\s*\?/i],
  ["commercial", /\bbest\b|\btop\s*\d*\b|\bcheapest\b|\brecommend(ed|ations?)?\b|\bworth (it|buying)\b/i],
  ["pricing", /\bprice\b|\bpricing\b|\bcost\b|\bfees?\b|\bcharges?\b|\bunder\s*[₹$€£]?\s*[\d,]+|[₹$€£]\s*[\d,]+/i],
  ["review", /\breview[s]?\b|\brating[s]?\b|\bcomplaints?\b|\bpros and cons\b|\bfeedback\b|\bexperience\b/i],
  ["specs", /\bspec(s|ification)s?\b|\bbattery\b|\bprocessor\b|\bchipset\b|\bcamera\b|\bdisplay\b|\bram\b|\bstorage\b|\bmah\b/i],
  ["howto", /\bhow to\b|\bhow do(es)?\b|\bsteps? to\b|\bguide\b|\btutorial\b|\bsetup\b/i],
  ["definition", /\bwhat is\b|\bwhat are\b|\bmeaning of\b|\bdefinition\b|\bexplained\b/i],
  ["availability", /\bin stock\b|\bavailab(le|ility)\b|\bbuy\b|\bwhere to\b|\bdeal[s]?\b|\boffers?\b|\bdiscount\b/i],
  ["official", /\bofficial\b|\bofficial site\b|\bwebsite\b/i],
];

// Four-digit years, and relative recency words, both count as temporal.
const TEMPORAL = /\b(19|20)\d{2}\b|\blatest\b|\bnewest\b|\bthis year\b|\bcurrent\b|\bupdated\b|\brecent\b/i;

export function classifyQuery(query) {
  const q = String(query || "");
  const labels = INTENT_RULES.filter(([, re]) => re.test(q)).map(([name]) => name);
  return {
    labels,
    temporal: TEMPORAL.test(q),
    words: q.trim() ? q.trim().split(/\s+/).length : 0,
  };
}

/**
 * Whole-capture fan-out analysis.
 *
 * `queries` — array of strings, or of {query} objects (the adapters' shape).
 * `sources` — optional record.sources, used to answer a question the raw
 *   data can't on its own: when the engine scoped a search to a domain with
 *   site:, did anything from that domain actually make it into the answer?
 *   A scoped-but-uncited domain means the engine went looking there and
 *   wasn't satisfied — a concrete, actionable gap.
 */
export function analyzeFanout(queries, sources = []) {
  const list = (queries || [])
    .map((q) => (typeof q === "string" ? q : q && q.query))
    .filter((q) => typeof q === "string" && q.trim());

  const sourceDomains = new Set(
    (sources || []).map((s) => normDomain(s && (s.domain || s.url))).filter(Boolean)
  );

  const siteCounts = new Map();   // domain -> times scoped to
  const excludeCounts = new Map();
  const intentCounts = new Map();
  const operatorCounts = new Map();
  const perQuery = [];
  let temporalCount = 0;
  let totalWords = 0;

  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const raw of list) {
    const ops = parseQueryOperators(raw);
    const cls = classifyQuery(ops.bare || raw);

    ops.siteIncludes.forEach((d) => bump(siteCounts, d));
    ops.siteExcludes.forEach((d) => bump(excludeCounts, d));
    if (ops.siteIncludes.length) bump(operatorCounts, "site:");
    if (ops.siteExcludes.length) bump(operatorCounts, "-site:");
    if (ops.phrases.length) bump(operatorCounts, '"exact phrase"');
    if (ops.hasOr) bump(operatorCounts, "OR");
    if (ops.filetypes.length) bump(operatorCounts, "filetype:");
    if (ops.inTitle.length) bump(operatorCounts, "intitle:");
    if (ops.inUrl.length) bump(operatorCounts, "inurl:");
    if (ops.dateFilters.length) bump(operatorCounts, "after:/before:");

    cls.labels.forEach((l) => bump(intentCounts, l));
    if (cls.temporal) temporalCount++;
    // Word count is measured on the real query, operators included, since
    // that is what the published length benchmarks count.
    const words = raw.trim().split(/\s+/).length;
    totalWords += words;

    perQuery.push({ query: raw, ...ops, intents: cls.labels, temporal: cls.temporal, words });
  }

  const n = list.length;
  const scopedDomains = [...siteCounts.entries()]
    .map(([domain, count]) => ({ domain, count, cited: sourceDomains.has(domain) }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const sortDesc = (m) =>
    [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    count: n,
    perQuery,
    avgWords: n ? Number((totalWords / n).toFixed(1)) : 0,
    maxWords: perQuery.reduce((m, q) => Math.max(m, q.words), 0),
    minWords: n ? perQuery.reduce((m, q) => Math.min(m, q.words), Infinity) : 0,
    temporalCount,
    scopedDomains,
    excludedDomains: sortDesc(excludeCounts).map((e) => ({ domain: e.key, count: e.count })),
    operators: sortDesc(operatorCounts),
    intents: sortDesc(intentCounts),
    // Scoped somewhere but nothing from there in the final answer.
    scopedNotCited: scopedDomains.filter((d) => !d.cited).map((d) => d.domain),
    benchmark: breadthVerdict(n),
  };
}

// Plain-language read on how this capture's breadth compares to the study
// averages, so a number in the UI carries meaning without the reader having
// to know the research.
export function breadthVerdict(count) {
  const b = FANOUT_BENCHMARK;
  if (!count) return { band: "none", label: "no sub-queries exposed" };
  if (count < b.typicalBandLow) {
    return { band: "narrow", label: `narrow — below the typical ${b.typicalBandLow}–${b.typicalBandHigh}` };
  }
  if (count <= b.typicalBandHigh) {
    return { band: "typical", label: `typical — in the usual ${b.typicalBandLow}–${b.typicalBandHigh} range` };
  }
  return { band: "broad", label: `broad — above the usual ${b.typicalBandHigh}` };
}
