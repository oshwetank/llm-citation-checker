/*
 * adapters/gemini.js — calibrated against real gemini.google.com StreamGenerate
 * traffic (Flash-Lite, 25 Jul 2026).
 *
 * Transport: Gemini's answer is a ~MB streaming XHR to
 *   /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
 * (NOT fetch — that's why fetch-patching saw nothing). The body is XSSI-guarded
 * ( )]}' ), then length-prefixed chunks; the useful data is a wrb.fr entry whose
 * 3rd element is a DOUBLE-encoded JSON string. Many streaming chunks carry
 * progressively fuller state — the one with the most citations is the final one.
 *
 * Confirmed shapes (with resilient shape-based fallbacks):
 *   citations : each is an array; inside it [ url, title, faviconUrl, snippet,
 *               …, attribution ]. We shape-scan for that quad (http url that
 *               isn't a gstatic favicon + a title string).
 *   prompt    : first quoted string in the url-encoded reqBody f.req payload.
 *   fan-out   : Flash-Lite app grounding does NOT expose sub-queries; we scan for
 *               a query array and otherwise report none (searched still true).
 */

import { makeRecord, makeSource } from "../schema.js";
import { walk, isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "gemini@0.2.0";

const FAVICON_RE = /gstatic\.com|googleusercontent|favicon-tbn/i;


// The assistant's answer sits at a stable slot in every streamed frame and
// grows as the response streams, so the longest value across all frames is
// the finished answer.
//
// This replaced picking "the longest markdown-ish string anywhere in the
// largest frame", which is only right when the answer happens to be the
// longest text present. On real shopping answers it is not: a Gemini reply
// that renders product cards also carries each product's scraped marketing
// copy, and those blobs are longer than the answer. Two captures reported as
// "lots of issues with Gemini" had answerText set to a V-Guard Luxecube ad
// and to ACC "Product Highlights" boilerplate — so every brand count, every
// passage and every downstream metric was computed against text the model
// never wrote. Verified against six real captures: the path is correct in
// all six, the old heuristic in three.
function answerAtPath(payload) {
  try {
    const v = payload[4][0][1][0];
    return typeof v === "string" ? v : null;
  } catch (_) {
    return null;
  }
}

function extractAnswerFromFrames(payloads) {
  let best = "";
  for (const p of payloads) {
    const v = answerAtPath(p);
    if (v && v.length > best.length) best = v;
  }
  return best;
}

function extractAnswerAndReasoning(payload) {
  const mdStrings = [];
  walk({ payload }, (v) => {
    if (typeof v === "string" && v.length > 150 && /\n|\*\*|##|^\d+\.|- /.test(v)) mdStrings.push(v);
  });
  mdStrings.sort((a, b) => b.length - a.length);
  const isReasoning = (s) => /Defining the Criteria|Analyzing User|I have successfully|I'm (now )?(analyzing|considering|evaluating)|My (plan|approach|strategy)/i.test(s);
  const answer = mdStrings.find((s) => !isReasoning(s)) || mdStrings[0] || "";
  const reasoning = mdStrings.find((s) => isReasoning(s)) || null;
  return { answer, reasoning };
}

// Brand detection is fully automatic and industry-agnostic — see lib/brands.js.
// `tracked` (the user's own brand + competitors) only LABELS results; it never
// drives detection, so the tool works on any vertical with zero configuration.
async function extractBrandMentions(text, ctx = {}) {
  if (!text) return [];
  // Synchronous, non-AI detection: the optional AI tier runs after the capture
  // is stored (background.js enrichCaptureWithAI), so it can't delay the write.
  const { brands } = detectBrands(text, text, ctx);
  return brands;
}

// Parse StreamGenerate body → all decoded wrb.fr payloads (each a nested array).
function parseStreamGenerate(raw) {
  const body = raw.replace(/^\)\]\}'/, "").trim();
  const payloads = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^\d+$/.test(t)) continue; // skip length markers
    let chunk;
    try {
      chunk = JSON.parse(t);
    } catch (_) {
      continue;
    }
    for (const entry of Array.isArray(chunk) ? chunk : []) {
      if (Array.isArray(entry) && entry[0] === "wrb.fr" && typeof entry[2] === "string") {
        try {
          payloads.push(JSON.parse(entry[2]));
        } catch (_) {
          /* not JSON */
        }
      }
    }
  }
  return payloads;
}

// Extract Chrome Scroll-to-Text fragment anchors (#:~:text=...) embedded by Gemini
function decodeTextFragment(url) {
  if (!url || typeof url !== "string") return null;
  const idx = url.indexOf("#:~:text=");
  if (idx === -1) return null;
  try {
    const raw = url.slice(idx + 9).split("&")[0];
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch (_) {
    return null;
  }
}

// Collect sentence-level and claim-level grounding spans (spp_ mapping) from StreamGenerate frames
function collectGroundingClaims(payload) {
  const claims = [];
  walk({ payload }, (value) => {
    if (!Array.isArray(value) || value.length < 3) return;
    const first = value[0];
    if (Array.isArray(first) && typeof first[0] === "string" && Array.isArray(first[3])) {
      const claimText = first[0];
      const offsets = first[3];
      let url = null;
      if (Array.isArray(value[2])) {
        walk({ urls: value[2] }, (v) => {
          if (!url && typeof v === "string" && isHttpUrl(v)) url = v;
        });
      }
      if (claimText && Array.isArray(offsets) && offsets.length > 0) {
        claims.push({
          claim: claimText,
          offsets: offsets[0],
          url,
        });
      }
    }
  });
  return claims;
}

// Collect citation-shaped inner arrays: [url, title, favicon?, snippet?, …, attribution?].
function collectCitations(payload) {
  const byUrl = new Map();
  walk({ payload }, (value) => {
    if (!Array.isArray(value)) return;
    const url = value[0];
    const title = value[1];
    if (!isHttpUrl(url) || FAVICON_RE.test(url) || typeof title !== "string") return;
    const exact = decodeTextFragment(url);
    const snippet = (typeof value[3] === "string" ? value[3].trim() : null) || exact || null;
    // attribution is a short source label somewhere after the snippet (e.g. "Cashkr")
    const attribution =
      (typeof value[6] === "string" && value[6]) ||
      value.find((v, i) => i > 3 && typeof v === "string" && v.length > 0 && v.length < 40 && !isHttpUrl(v)) ||
      null;
    if (!byUrl.has(url)) byUrl.set(url, { url, title, snippet, attribution, exactPassage: exact });
  });
  return [...byUrl.values()];
}

function extractPrompt(reqBody) {
  if (!reqBody) return null;
  try {
    const dec = decodeURIComponent(reqBody.replace(/^f\.req=/, ""));
    // dec looks like: [null,"[[\"best camera phone under 50K\",0,null,…
    const m = dec.match(/\[\[\\?"((?:[^"\\]|\\.)*?)\\?"/);
    // The payload is double-encoded, so a newline the user typed (or Gemini's
    // own trailing one) arrives as the literal characters \\n and survived
    // into the prompt as visible backslash-n — "…utterpredesh\\n". That text
    // is the key a campaign matches a prompt on, so the escapes have to come
    // out before it is stored.
    if (m) {
      return m[1]
        .replace(/\\{2,}n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\{2,}/g, "\\")
        .trim();
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

// Products: Gemini shopping cards (any category — phones, jewellery, …). The
// category-agnostic signal is a Google Shopping URL (google.com/search?…prds=)
// together with a price. Fields sit at stable indices (name[10], price[13],
// rating[16], brand[20], merchant[27]) with shape fallbacks.
function collectProducts(payload) {
  const out = [];
  const seen = new Set();
  const PRICE = /(?:₹|Rs\.?|\$|€)\s?[\d,]+(?:\.\d+)?/;
  walk({ payload }, (v) => {
    if (!Array.isArray(v) || v.length < 14) return;
    const hasShop = v.some((x) => typeof x === "string" && /google\.com\/search\?q=.*prds=/.test(x));
    const priceEl = v.find((x) => typeof x === "string" && PRICE.test(x) && x.length < 20);
    if (!hasShop || !priceEl) return;

    const name =
      typeof v[10] === "string" && v[10].length < 80 && !/^https?:/.test(v[10]) && !PRICE.test(v[10])
        ? v[10]
        : v.find((x) => typeof x === "string" && x.length > 4 && x.length < 70 && !/^https?:/.test(x) && !PRICE.test(x));
    if (!name) return;
    const key = name + "|" + priceEl;
    if (seen.has(key)) return;
    seen.add(key);

    const rating = typeof v[16] === "string" && /^\d(?:\.\d)?$/.test(v[16]) ? parseFloat(v[16]) : null;
    const reviews = typeof v[17] === "number" && v[17] > 1 ? v[17] : null;
    const brand = typeof v[20] === "string" && v[20].length < 40 ? v[20] : null;
    const merchant =
      (typeof v[27] === "string" && v[27].length < 50 && v[27]) ||
      v.find((x) => typeof x === "string" && /\.(com|in|co)\b/i.test(x) && !/^https?:/.test(x)) ||
      null;
    out.push({ name, price: priceEl, merchant, rating: rating || null, reviews, brand });
  });
  return out;
}

// Places: Gemini local/map queries ("coffee near me") return Google Maps Places
// records. Each is identified by a "places/<id>" string; stable fields: name at
// [30][0], category at [31][0] (+ slug elsewhere), rating (a bare number ~1-5) at
// [13], phone at [7], address at [8] or [50], lat/lng at [11], maps/website URLs
// at [14]/[15], review-count-ish integer at [21]. Price range ("· ₹200-₹400") and
// weekly hours ("Monday: 10:00 AM – 12:00 AM") are loose strings scanned separately
// and matched back to each place by proximity isn't reliable, so we attach the
// nearest price-range/hours strings found within the SAME record only.
function collectPlaces(payload) {
  const records = [];
  const seen = new Set();
  walk({ payload }, (v) => {
    if (!Array.isArray(v) || v.length < 30) return;
    const placeId = v.find((x) => typeof x === "string" && /^places\//.test(x));
    if (!placeId || seen.has(placeId)) return;
    const nameField = v[30];
    const catField = v[31];
    const name = Array.isArray(nameField) && typeof nameField[0] === "string" ? nameField[0] : null;
    if (!name) return;
    seen.add(placeId);
    const category = Array.isArray(catField) && typeof catField[0] === "string" ? catField[0] : null;
    const rating = typeof v[13] === "number" && v[13] >= 0 && v[13] <= 5 ? v[13] : null;
    // NOTE: v[21] was observed identical (330) across every place in a sample —
    // it's a shared/list-level count, not a per-place review total. Omit rather
    // than show a misleading number until a genuine per-place field is found.
    const reviews = null;
    const phone = v.find((x) => typeof x === "string" && /^\+?\d[\d\s]{7,}$/.test(x)) || null;
    const address = v.find((x) => typeof x === "string" && x.length > 15 && /,/.test(x) && !/^\+?\d/.test(x)) || null;
    const website = v.find((x) => typeof x === "string" && /^https?:\/\/(?!maps\.google|www\.google)/.test(x)) || null;
    const mapsUrl = v.find((x) => typeof x === "string" && /^https?:\/\/maps\.google/.test(x)) || null;
    const latLng = v.find((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && Math.abs(x[0]) <= 90);
    const priceRange = v.find((x) => typeof x === "string" && /₹[\d,]+\s*[-–—]\s*₹?[\d,]+/.test(x));
    const hoursArr = v.find(
      (x) => Array.isArray(x) && x.length === 7 && x[0] === true && Array.isArray(x[1])
    );
    let hours = null;
    if (hoursArr) {
      // human-readable day strings sit alongside the numeric schedule in the parent array
      hours = v.find((x) => Array.isArray(x) && x.length >= 5 && typeof x[0] === "string" && /^[A-Z][a-z]+:/.test(x[0]));
    }
    records.push({
      name,
      category,
      rating,
      reviews,
      phone,
      address,
      website,
      mapsUrl,
      lat: latLng ? latLng[0] : null,
      lng: latLng ? latLng[1] : null,
      priceRange: priceRange ? priceRange.replace(/^\s*·\s*/, "") : null,
      hours: hours || null,
    });
  });
  return records;
}

// Best-effort fan-out extraction. In standard chat Gemini masks search sub-queries,
// but in Flash Thinking / Deep Research mode reasoning blocks explicitly formulate search intents.
function extractFanout(_payload, diag, reasoning) {
  const search = [];
  if (reasoning) {
    const qMatches = reasoning.match(/(?:searching for|search(?:\s+query)?(?:\s+is)?:\s*|formulating search:\s*)["']([^"'\n]+)["']/gi);
    if (qMatches) {
      qMatches.forEach((m) => {
        const cleaned = m.replace(/^(?:searching for|search(?:\s+query)?(?:\s+is)?:\s*|formulating search:\s*)["']|["']$/gi, "").trim();
        if (cleaned.length > 3 && !search.some((s) => s.query.toLowerCase() === cleaned.toLowerCase())) {
          search.push({ query: cleaned, round: 1 });
        }
      });
    }
  }

  if (!search.length) {
    diag.notes.push(FANOUT_UNSUPPORTED_NOTE);
  }
  return { search, shopping: [], image: [] };
}

export const FANOUT_UNSUPPORTED_NOTE =
  "fanout: Gemini masks search sub-queries in standard chat; recovered when Thinking mode exposes formulation.";

export async function adapt(rawCapture, opts = {}) {
  const diag = { adapterVersion: ADAPTER_VERSION, usedFallback: false, notes: [] };
  const payloads = parseStreamGenerate(rawCapture.raw || "");

  // Use the largest (most complete) streamed frame for everything — model,
  // citations, and products. Selecting by "most citations" broke on product-only
  // responses (Pro shopping queries) where citations are 0 but the frame is huge.
  let bestPayload = null;
  let bestSize = -1;
  for (const p of payloads) {
    const size = JSON.stringify(p).length;
    if (size > bestSize) {
      bestSize = size;
      bestPayload = p;
    }
  }

  const cites = bestPayload ? collectCitations(bestPayload) : [];
  const products = bestPayload ? collectProducts(bestPayload) : [];
  const places = bestPayload ? collectPlaces(bestPayload) : [];
  const groundingClaims = bestPayload ? collectGroundingClaims(bestPayload) : [];

  const sources = cites.map((c) =>
    makeSource({
      url: c.url,
      domain: domainOf(c.url),
      title: c.title,
      snippet: c.snippet,
      outcome: "cited", // Gemini surfaces these in its Sources panel
      type: "citation",
      platformSpecific: {
        ...(c.attribution ? { attribution: c.attribution } : {}),
        ...(c.exactPassage ? { exactPassage: c.exactPassage } : {}),
      },
    })
  );

  const { answer: heuristicAnswer, reasoning } = bestPayload
    ? extractAnswerAndReasoning(bestPayload)
    : { answer: "", reasoning: null };

  const fanout = bestPayload ? extractFanout(bestPayload, diag, reasoning) : { search: [], shopping: [], image: [] };
  if (!sources.length && !products.length && !places.length) {
    diag.usedFallback = true;
    diag.notes.push("no citations, products, or places found — StreamGenerate shape may have drifted");
  }

  // Model label lives at a stable top-level slot (e.g. "3.5 Flash-Lite", "3.5 Pro").
  // Fall back to a shape scan for a short model-ish string.
  let model = null;
  if (bestPayload && typeof bestPayload[42] === "string" && /flash|pro|ultra|nano|gemini/i.test(bestPayload[42])) {
    model = bestPayload[42];
  } else if (bestPayload) {
    walk({ bestPayload }, (v) => {
      if (!model && typeof v === "string" && v.length < 30 && /^\d[.\d]*\s+(flash|pro|ultra|nano)/i.test(v)) model = v;
    });
  }
  model = model ? `Gemini ${model}` : "gemini";

  // Prefer the structural slot; keep the shape scan as a fallback so a future
  // payload reshuffle degrades to the old behaviour instead of to nothing.
  const pathAnswer = extractAnswerFromFrames(payloads);
  const answer = pathAnswer || heuristicAnswer;
  if (!pathAnswer && heuristicAnswer) {
    diag.notes.push("answer: stable slot missing, fell back to a shape scan (payload may have drifted)");
  }
  const userPrompt = extractPrompt(rawCapture.reqBody);
  const brandMentions = await extractBrandMentions(answer, {
    products,
    places,
    sources,
    tracked: opts.tracked,
    // See "5. prompt context" in lib/brands.js: the question's own category
    // words are never brands, however the answer formats them.
    prompt: userPrompt,
  });

  // Categorized entities: products → Product, merchants → Retailer, places → Place,
  // plus whatever the automatic detector classified.
  const seenE = new Set();
  const entities = [];
  const addE = (t, c) => { const k = c + "|" + (t || "").toLowerCase(); if (t && !seenE.has(k)) { seenE.add(k); entities.push({ text: t, category: c }); } };
  products.forEach((p) => { addE(p.name, "Product"); if (p.merchant) addE(p.merchant, "Retailer"); });
  places.forEach((p) => addE(p.name, "Place"));
  brandMentions.forEach((b) => addE(b.brand, b.category === "place" ? "Place" : "Brand"));

  const responseType = places.length ? "local" : products.length ? "shopping" : sources.length ? "web" : "general";

  return makeRecord({
    captureId: rawCapture.captureId,
    platform: "gemini",
    model,
    capturedAt: rawCapture.capturedAt,
    pageUrl: rawCapture.pageUrl,
    rawRef: rawCapture.captureId,
    userPrompt,
    searched: sources.length > 0 || products.length > 0 || places.length > 0 || fanout.search.length > 0,
    turnUseCase: responseType,
    fanout,
    sources,
    products,
    places,
    entities,
    brandMentions,
    answerChars: answer.length,
    answerText: answer, // capped by makeRecord; the UI needs this for rank/aspect analysis
    platformSpecific: {
      ...(reasoning ? { reasoning: reasoning.slice(0, 4000) } : {}),
      ...(groundingClaims.length ? { groundingClaims: groundingClaims.slice(0, 50) } : {}),
    },
    _extraction: diag,
  });
}

