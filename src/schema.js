/*
 * schema.js — the normalized, cross-engine record.
 *
 * Every adapter (ChatGPT now; Perplexity/Gemini/Grok/Claude later) must emit this
 * shape. Engine-only fields that don't generalize go in `platformSpecific` bags so
 * nothing is lost, but the top-level fields stay comparable across engines.
 *
 * Core modelling choice: each source carries an `outcome` of fetched | cited |
 * mentioned — the distinction that separates this from output-only tools.
 */

export const SCHEMA_VERSION = 2;

// The reconstructed answer can be long. Cap what we persist so the derived store
// (which is loaded wholesale by the UI) stays small, while keeping enough text
// for brand/aspect/rank analysis.
export const ANSWER_TEXT_CAP = 30000;

export const SOURCE_OUTCOME = ["fetched", "cited", "mentioned"];
export const SOURCE_TYPE = [
  "citation",
  "other",
  "product",
  "news",
  "image",
  "hidden",
  "unknown",
];

// Factory: a well-formed empty record. Adapters fill what they can.
export function makeRecord(base = {}) {
  return {
    captureId: base.captureId || crypto.randomUUID(),
    schemaVersion: SCHEMA_VERSION,
    platform: base.platform || "chatgpt",
    model: base.model || null,
    capturedAt: base.capturedAt || Date.now(),
    pageUrl: base.pageUrl || null,
    rawRef: base.rawRef || base.captureId || null, // points at the raw store row

    conversationId: base.conversationId || null,
    turnId: base.turnId || null,
    projectId: base.projectId || null, // owning prompt-group, if captured under one
    runId: base.runId || null, // which Loader run produced this (for drift/compare)
    userPrompt: base.userPrompt || null,
    generatedTitle: base.generatedTitle || null,
    turnUseCase: base.turnUseCase || null,
    searched: base.searched ?? false, // did the model actually run a web search?

    fanout: base.fanout || { search: [], shopping: [], image: [] },
    sources: base.sources || [], // [{ url, domain, title, snippet, outcome, type, platformSpecific }]
    products: base.products || [],
    places: base.places || [], // [{ name, category, rating, reviews, phone, address, website, mapsUrl, lat, lng, priceRange, hours }]
    entities: base.entities || [], // [{ text, category }]
    images: base.images || [], // [{ url, title, price?, attribution? }]
    brandMentions: base.brandMentions || [], // [{ brand, count, passages[] }]
    carousels: base.carousels || { products: false, images: false, news: false, map: false },
    referenceTypes: base.referenceTypes || {}, // { search: n, product: n, news: n, reddit: n, youtube: n, ... }
    answerChars: base.answerChars || 0, // length of reconstructed assistant answer
    // The assistant's reconstructed answer text. Needed by the UI for brand rank,
    // "cited for" aspects, brand→model mapping and hero-product detection. Stripped
    // from list responses (see background `get-records`) and re-fetched per capture.
    answerText: typeof base.answerText === "string" ? base.answerText.slice(0, ANSWER_TEXT_CAP) : "",

    platformSpecific: base.platformSpecific || {},

    // extraction diagnostics — surfaced so format drift is visible to us + user
    _extraction: base._extraction || { adapterVersion: null, usedFallback: false, notes: [] },
  };
}

export function makeSource(s = {}) {
  return {
    url: s.url || null,
    domain: s.domain || null,
    title: s.title || null,
    snippet: s.snippet || null,
    outcome: SOURCE_OUTCOME.includes(s.outcome) ? s.outcome : "fetched",
    type: SOURCE_TYPE.includes(s.type) ? s.type : "unknown",
    platformSpecific: s.platformSpecific || {},
  };
}
