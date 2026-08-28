/*
 * grounding-score.js — Verbatim Grounding, Authority Split, and Intent Analytics.
 *
 * Implements modern 2026 grounding analytics:
 *   1. computeVerbatimGrounding(answerText, sources): Measures factual alignment between AI prose and source text fragments.
 *   2. computeAuthoritySplit(sources, socialCitations): Measures Social (X/Twitter) vs. Editorial Media authority split.
 *   3. computeDomainExclusivity(records): Detects platform-specific domain bias across engines.
 *   4. computeSearchIntentGraph(records): Categorizes fan-out sub-queries by commercial research intent.
 */

import { domainOf } from "./deep.js";

/**
 * Normalizes text for robust n-gram token overlap comparison.
 */
function cleanTokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Computes Verbatim Grounding Score (0–100%) by measuring the containment of
 * answer claims in cited source snippets and exact scroll-to-text fragments.
 */
export function computeVerbatimGrounding(answerText, sources = []) {
  const text = String(answerText || "").trim();
  if (!text || !sources || !sources.length) {
    return {
      score: 0,
      groundedClaims: 0,
      totalClaims: 0,
      claimMatches: [],
      verdict: "No sources or text to evaluate",
    };
  }

  // Split answer into individual claim sentences (sentences with at least 5 words)
  const rawSentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.split(/\s+/).length >= 4);

  if (!rawSentences.length) {
    return {
      score: 100,
      groundedClaims: 0,
      totalClaims: 0,
      claimMatches: [],
      verdict: "Short answer / no complex claims",
    };
  }

  // Build corpus of source evidence text
  const sourceCorpus = sources.map((s) => {
    const textPieces = [
      s.snippet || "",
      s.title || "",
      s.platformSpecific?.exactPassage || "",
      s.platformSpecific?.attribution || "",
    ];
    return {
      source: s,
      url: s.url,
      domain: s.domain || domainOf(s.url),
      tokens: new Set(cleanTokens(textPieces.join(" "))),
      rawText: textPieces.join(" ").toLowerCase(),
    };
  });

  let groundedCount = 0;
  const claimMatches = [];

  for (const sentence of rawSentences) {
    const sentTokens = cleanTokens(sentence);
    if (sentTokens.length < 3) continue;

    let bestMatch = null;
    let maxOverlap = 0;

    for (const sc of sourceCorpus) {
      if (!sc.tokens.size) continue;
      let matchWords = 0;
      for (const t of sentTokens) {
        if (sc.tokens.has(t)) matchWords++;
      }
      const overlap = matchWords / sentTokens.length;
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestMatch = sc;
      }
    }

    const isGrounded = maxOverlap >= 0.35; // Significant lexical overlap threshold
    if (isGrounded) groundedCount++;

    claimMatches.push({
      sentence: sentence.slice(0, 180),
      confidence: Math.round(maxOverlap * 100),
      isGrounded,
      sourceDomain: bestMatch ? bestMatch.domain : null,
      sourceUrl: bestMatch ? bestMatch.url : null,
    });
  }

  const total = claimMatches.length || 1;
  const score = Math.round((groundedCount / total) * 100);

  let verdict = "Highly Grounded (Faithful to Sources)";
  if (score < 40) verdict = "High Hallucination Gap / Unsubstantiated Claims";
  else if (score < 70) verdict = "Moderately Grounded with Synthetic Extrapolations";

  return {
    score,
    groundedClaims: groundedCount,
    totalClaims: total,
    claimMatches: claimMatches.slice(0, 10),
    verdict,
  };
}

/**
 * Computes Social Media (X/Twitter) vs. Editorial Web Authority Split.
 */
export function computeAuthoritySplit(sources = [], socialCitations = []) {
  const totalSources = (sources || []).length;
  const socialCount = (socialCitations || []).length || (sources || []).filter((s) => s.platformSpecific?.isSocialPost || s.domain === "x.com" || s.domain === "twitter.com").length;
  const webCount = Math.max(0, totalSources - socialCount);

  const socialPct = totalSources > 0 ? Math.round((socialCount / totalSources) * 100) : 0;
  const webPct = totalSources > 0 ? 100 - socialPct : 100;

  return {
    socialCount,
    webCount,
    totalCount: totalSources,
    socialPct,
    webPct,
  };
}

/**
 * Computes Cross-Engine Domain Exclusivity: which domains are cited only by specific models.
 */
export function computeDomainExclusivity(records = []) {
  const domainToEngines = new Map();
  const enginesPresent = new Set();

  for (const r of records || []) {
    if (!r || !r.platform) continue;
    enginesPresent.add(r.platform);
    for (const s of r.sources || []) {
      const d = s.domain || domainOf(s.url);
      if (!d) continue;
      if (!domainToEngines.has(d)) domainToEngines.set(d, new Set());
      domainToEngines.get(d).add(r.platform);
    }
  }

  const exclusivityList = [];
  for (const [domain, engines] of domainToEngines.entries()) {
    const engineArr = [...engines];
    const isExclusive = enginesPresent.size > 1 && engineArr.length === 1;
    exclusivityList.push({
      domain,
      citedBy: engineArr,
      isExclusive,
      exclusiveEngine: isExclusive ? engineArr[0] : null,
      engineCount: engineArr.length,
    });
  }

  exclusivityList.sort((a, b) => b.engineCount - a.engineCount);
  return {
    totalDomains: exclusivityList.length,
    exclusiveDomains: exclusivityList.filter((e) => e.isExclusive),
    sharedDomains: exclusivityList.filter((e) => !e.isExclusive),
    all: exclusivityList,
  };
}

/**
 * Categorizes fan-out sub-queries by commercial research intent.
 */
export function computeSearchIntentGraph(records = []) {
  const intentBuckets = {
    comparison: { label: "Comparative / Head-to-Head", count: 0, queries: [] },
    pricing: { label: "Pricing & Commercial Value", count: 0, queries: [] },
    technical: { label: "Technical Specs & Features", count: 0, queries: [] },
    reviews: { label: "User Reviews & Ratings", count: 0, queries: [] },
    navigational: { label: "Navigational & Direct Brand", count: 0, queries: [] },
  };

  const seenQueries = new Set();

  for (const r of records || []) {
    const allQ = []
      .concat(r.fanout?.search || [], r.fanout?.shopping || [], r.fanout?.image || []);

    for (const q of allQ) {
      const trimmed = String(q || "").trim();
      if (!trimmed || seenQueries.has(trimmed.toLowerCase())) continue;
      seenQueries.add(trimmed.toLowerCase());
      const lower = trimmed.toLowerCase();

      if (/\b(vs|versus|better|compare|difference|alternative)\b/i.test(lower)) {
        intentBuckets.comparison.count++;
        intentBuckets.comparison.queries.push({ query: trimmed, engine: r.platform });
      } else if (/\b(price|cost|pricing|deal|discount|cheap|expensive|buy)\b/i.test(lower)) {
        intentBuckets.pricing.count++;
        intentBuckets.pricing.queries.push({ query: trimmed, engine: r.platform });
      } else if (/\b(spec|battery|processor|weight|dimension|performance|ram|camera|engine)\b/i.test(lower)) {
        intentBuckets.technical.count++;
        intentBuckets.technical.queries.push({ query: trimmed, engine: r.platform });
      } else if (/\b(review|rating|complaint|reddit|forum|opinions|good)\b/i.test(lower)) {
        intentBuckets.reviews.count++;
        intentBuckets.reviews.queries.push({ query: trimmed, engine: r.platform });
      } else {
        intentBuckets.navigational.count++;
        intentBuckets.navigational.queries.push({ query: trimmed, engine: r.platform });
      }
    }
  }

  return intentBuckets;
}
