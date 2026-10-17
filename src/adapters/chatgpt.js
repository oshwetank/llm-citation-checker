/*
 * adapters/chatgpt.js — derive a normalized record from a raw ChatGPT capture.
 *
 * Calibrated against live gpt-5-5 traffic (24 Jul 2026 sample). Key facts about
 * the real SSE, which is delta-encoded ("event: delta_encoding" / "v1"):
 *
 *  - Fan-out:   metadata.search_model_queries = { type, queries: [...] }  (OBJECT)
 *  - Fetched:   objects with type "search_result" / "search_result_group"
 *  - Cited:     content_reference items carrying an `attribution` domain
 *               (inline `sources` items + `grouped_webpages`), usually with
 *               `pub_date` + `snippet`. These are what the user actually sees.
 *  - Products:  `product` objects (title, price, merchants, rating, num_reviews…)
 *  - Model:     metadata.model_slug / resolved_model_slug
 *
 * Content is assembled via JSON-patch `append`/`add` ops, but each op carries a
 * COMPLETE sub-object, so deep-walking every parsed node collects them reliably
 * without implementing a patch reducer. De-dup by URL / product id handles the
 * add-then-patch churn. Shape fallbacks remain for when OpenAI moves things.
 */

import { makeRecord, makeSource } from "../schema.js";
import { isKnownRetrievalName, enginesNamedIn } from "../lib/retrieval.js";
import { walk, collectByKey, collectObjects, firstPath, isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";
import { isGenUi, readGenUi } from "../lib/genui.js";

export const ADAPTER_VERSION = "chatgpt@0.5.0";

function parseSse(raw) {
  const nodes = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      nodes.push(JSON.parse(payload));
    } catch (_) {
      /* keepalive / non-JSON lines expected */
    }
  }
  return nodes;
}

// Reconstruct the assistant's visible answer text from the delta-encoded stream.
// The stream adds messages (v.message.id) then mutates the "current" one via
// append ops on /message/content/parts/0, plus bare {v:"…"} continuations.
// We only accumulate the final visible answer (channel "final" / tool:web author).
function reconstructAnswer(nodes) {
  const textById = new Map();
  const finalIds = new Set();
  let currentId = null;
  // Message ids in the order their headers arrive. A delta carrying "c" (the
  // v1 delta encoding) is addressed to message number c in this list, not to
  // the latest header. Since ChatGPT's generative-UI answers (October 2026)
  // the same text is sent twice: once to the physical message and once, with
  // its "c", to the logical answer that joins the intro and the cards. Applied
  // to "the current message" both copies landed in one message, so every
  // chunk appeared twice and the intro was lost (reported, 0.60.0).
  const order = [];
  let target = null;

  const bump = (delta) => {
    const id = target || currentId;
    if (id == null || typeof delta !== "string") return;
    textById.set(id, (textById.get(id) || "") + delta);
  };

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    // message boundary: a full message object arrives (o:add or bare {v:{message}})
    const msg = node.v && node.v.message;
    if (msg && msg.id) {
      currentId = msg.id;
      if (!order.includes(msg.id)) order.push(msg.id);
      if (!textById.has(currentId)) {
        const seed = msg.content && Array.isArray(msg.content.parts) ? msg.content.parts[0] : "";
        textById.set(currentId, typeof seed === "string" ? seed : "");
      }
      if (node.channel === "final" || (msg.author && msg.author.metadata && msg.author.metadata.real_author === "tool:web")) {
        finalIds.add(currentId);
      }
      continue;
    }

    // op-carriers. `v` may be an array of ops WITHOUT a top-level "o":"patch"
    // (e.g. {"v":[{"p":"/message/content/parts/0","o":"append","v":"…"}]}) — those
    // must still be applied, or chunks of the answer (and their brands) are lost.
    const ops = Array.isArray(node.v) ? node.v : [node];
    target = Number.isInteger(node.c) && order[node.c] ? order[node.c] : null;
    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      if (op.p === "/message/content/parts/0" && (op.o === "append" || op.o === undefined) && typeof op.v === "string") {
        bump(op.v);
      } else if (op.p === undefined && op.o === undefined && typeof op.v === "string") {
        bump(op.v); // bare continuation appends to current content
      }
    }
  }

  // Prefer the final-channel message; else the longest reconstructed text.
  let best = "";
  for (const id of finalIds) if ((textById.get(id) || "").length > best.length) best = textById.get(id);
  if (!best) for (const t of textById.values()) if (t.length > best.length) best = t;
  // A logical answer holds the final message's text and more (the intro that
  // came before the search, in its own message): it is the whole answer.
  if (best) for (const t of textById.values()) if (t.length > best.length && t.includes(best)) best = t;
  return best;
}

// Reference-type breakdown (RESONEO's "product 11, search 4, news 1, youtube 1").
// Counts come from content_references[].refs[].ref_type and inline cite markers
// like turn0search2 / turn0product5 / turn0reddit21.
function extractReferenceTypes(nodes, answerText) {
  const counts = {};
  const bump = (k) => (counts[k] = (counts[k] || 0) + 1);

  // Primary: unique inline cite markers in the FINAL answer text
  // (turn0search2, turn0product5, turn0reddit21…). De-duped by type+index so a
  // reference cited twice isn't double-counted, and delta churn can't inflate.
  if (answerText) {
    const seen = new Set();
    const re = /turn\d+([a-z]+)(\d+)/g;
    let m;
    while ((m = re.exec(answerText))) {
      const key = m[1] + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      bump(m[1]);
    }
  }
  if (Object.keys(counts).length) return counts;

  // Fallback: unique refs[] entries when no answer text is available.
  const seen = new Set();
  walk({ nodes }, (value, key, parent) => {
    if (key === "ref_type" && typeof value === "string" && parent) {
      const k = value + "|" + parent.ref_index;
      if (!seen.has(k)) {
        seen.add(k);
        bump(value);
      }
    }
  });
  return counts;
}


export function cleanPassage(text) {
  // ChatGPT's inline markup wraps refs in real Unicode Private-Use-Area chars:
  // U+E200 (open) / U+E202 (mid-delimiter) / U+E201 (close). Byte shapes:
  //   entity/product marker:  OPEN + kind + MID + "[" ... "]" + CLOSE
  //   bulk products marker:   OPEN + "products" + MID + "{" ... "}" + CLOSE
  //   a "cite" run:           OPEN + "cite" + (MID + turnNtypeM)+ + optional CLOSE
  //   a bare "map" flag:      OPEN + "map" + CLOSE (no MID, no body)
  // The entity/product array body is parsed with JSON.parse (not a hand-rolled
  // capture group), so a name containing a literal quote — a monitor size like
  // 27" — round-trips correctly. A naive [^"]* capture group doesn't understand
  // JSON's \" escape and truncates right at it, leaving a stray backslash
  // (found while building the conversation-export feature: a real export showed
  // "Lenovo Legion R27qe Gen 2 27\\" instead of the real 27" name).
  // cleanPassage runs on ~230-char SLICES, which can cut a marker mid-way —
  // JSON.parse can genuinely throw here, so every parse is wrapped and falls
  // back to dropping the marker, same as a truncated marker always did.
  const entityRe = new RegExp("entity(\\[[\\s\\S]*?\\])", "gu");
  const productRe = new RegExp("product(\\[[\\s\\S]*?\\])", "gu");
  const productsBulkRe = new RegExp("products\\{[\\s\\S]*?\\}", "gu");
  const mapRe = new RegExp("map", "gu");
  const citeRe = new RegExp("cite(?:turn\\d+[a-z]+\\d+)+?", "gu");
  const puaRe = new RegExp("[-]", "gu");
  const nameFrom = (jsonBody) => {
    try {
      const arr = JSON.parse(jsonBody);
      return Array.isArray(arr) ? String(arr[1] ?? "") : "";
    } catch (_) {
      return null;
    }
  };
  return text
    .replace(entityRe, (_, body) => { const n = nameFrom(body); return n == null ? "" : `[${n}]`; })
    .replace(productRe, (_, body) => { const n = nameFrom(body); return n == null ? "" : `[${n}]`; })
    .replace(productsBulkRe, "")
    .replace(mapRe, "")
    .replace(citeRe, "")
    .replace(puaRe, "")
    .replace(/\bturn\d+[a-z]+\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Exported for the conversation-export renderer (src/lib/exportDoc.js): walks
// answerText and returns it as an ORDERED list of segments instead of stripping
// markers like cleanPassage does — so an export document can turn entity/product
// markers into inline rich text and cite runs into numbered footnotes linked to
// the matching source (via source.platformSpecific.markerIds). Reuses the exact
// same PUA-anchored, JSON.parse-based patterns as cleanPassage (kept in sync
// manually — both are short and heavily commented, see cleanPassage above).
export function tokenizeAnswerMarkup(text) {
  if (!text) return [];
  const entityRe = new RegExp("entity(\\[[\\s\\S]*?\\])", "gu");
  const productRe = new RegExp("product(\\[[\\s\\S]*?\\])", "gu");
  const productsBulkRe = new RegExp("products\\{[\\s\\S]*?\\}", "gu");
  const mapRe = new RegExp("map", "gu");
  const citeRe = new RegExp("cite(?:turn\\d+[a-z]+\\d+)+?", "gu");
  const nameFrom = (jsonBody) => {
    try {
      const arr = JSON.parse(jsonBody);
      return Array.isArray(arr) ? String(arr[1] ?? "") : "";
    } catch (_) {
      return "";
    }
  };
  const spans = [];
  let m;
  while ((m = entityRe.exec(text))) spans.push({ start: m.index, end: entityRe.lastIndex, type: "entity", name: nameFrom(m[1]) });
  while ((m = productRe.exec(text))) spans.push({ start: m.index, end: productRe.lastIndex, type: "product", name: nameFrom(m[1]) });
  while ((m = productsBulkRe.exec(text))) spans.push({ start: m.index, end: productsBulkRe.lastIndex, type: "productsBulk" });
  while ((m = mapRe.exec(text))) spans.push({ start: m.index, end: mapRe.lastIndex, type: "map" });
  while ((m = citeRe.exec(text))) {
    const ids = m[0].match(/turn\d+[a-z]+\d+/g) || [];
    spans.push({ start: m.index, end: citeRe.lastIndex, type: "cite", ids });
  }
  spans.sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    if (s.start > cursor) out.push({ type: "text", value: text.slice(cursor, s.start) });
    out.push(s);
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
  return out;
}

// Brand detection is fully automatic and industry-agnostic — see lib/brands.js
// (and lib/ai-brands.js for the optional AI-enrichment layered on top of it).
// `tracked` (the user's own brand + competitors, with URLs) only LABELS what was
// detected; it never drives detection.
//
// Computed ONCE and shared for both the brand list and the base entity list
// below (extractEntities) — this used to be two separate detectBrands()
// calls with nearly identical arguments, which was mildly wasteful even
// synchronously and would have doubled the cost of the AI tier for no
// reason now that this call is async.
async function detectBrandsForCapture(answerText, products, tracked, sources, places, prompt) {
  if (!answerText) return { brands: [], entities: [] };
  // A card's "Listed at <store> + others" line names where it's sold, not a
  // brand the answer recommends (a resolved binding since 0.62.1). The
  // stores are on the product; detection doesn't read that line.
  answerText = answerText.replace(/^\s*Listed at [^\n]*$/gim, "");
  // Deliberately the synchronous, non-AI detector. The optional on-device AI
  // tier runs AFTER the capture is stored (see background.js's
  // enrichCaptureWithAI) — inside here it blocked the write, so nothing
  // appeared in the UI until an on-device inference finished.
  return detectBrands(answerText, cleanPassage(answerText), {
    products,
    places,
    sources,
    tracked,
    // What the user actually asked for. Detection uses it to keep the
    // question's own category words ("camera phone") out of Brand Mentions —
    // see "5. prompt context" in lib/brands.js.
    prompt,
  });
}

function cleanUrl(u) {
  if (!isHttpUrl(u)) return u;
  try {
    const url = new URL(u);
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    return url.toString().replace(/\?$/, "");
  } catch (_) {
    return u;
  }
}

function extractPrompt(reqBody) {
  if (!reqBody) return null;
  let body;
  try {
    body = JSON.parse(reqBody);
  } catch (_) {
    return null;
  }
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m?.author?.role || m?.role) === "user") {
      const parts = m?.content?.parts || m?.content;
      if (Array.isArray(parts)) {
        const validStr = parts.filter((p) => typeof p === "string" && p.trim().length > 0);
        const uniqueParts = [...new Set(validStr)];
        return uniqueParts.join("\n");
      }
      if (typeof parts === "string") return parts;
    }
  }
  return null;
}

// --- fan-out queries ---
function extractFanout(nodes, diag) {
  const out = { search: [], shopping: [], image: [] };

  // search_model_queries appears both as a standalone node ({type, queries}) and
  // nested at metadata.search_model_queries. Handle the object form (real shape).
  for (const node of nodes) {
    const smq =
      firstPath(node, [
        "search_model_queries",
        "v.message.metadata.search_model_queries",
        "message.metadata.search_model_queries",
      ]) || null;
    const arrs = [];
    if (smq && Array.isArray(smq.queries)) arrs.push(smq.queries);
    else if (Array.isArray(smq)) arrs.push(smq);
    for (const arr of arrs) {
      for (const q of arr) {
        const text = typeof q === "string" ? q : q?.q || q?.query || q?.text;
        if (text) out.search.push({ query: String(text) });
      }
    }
  }

  // Fallback: any {type:"search_model_queries"} or product_query anywhere.
  if (!out.search.length) {
    for (const node of nodes) {
      collectObjects(node, (o) => o.type === "search_model_queries" && Array.isArray(o.queries)).forEach((o) =>
        o.queries.forEach((q) => out.search.push({ query: String(q) }))
      );
      collectObjects(node, (o) => typeof o.product_query === "string").forEach((o) =>
        out.shopping.push({ query: o.product_query })
      );
    }
    if (out.search.length || out.shopping.length) {
      diag.usedFallback = true;
      diag.notes.push("fanout: used shape fallback");
    }
  }

  for (const k of Object.keys(out)) {
    const seen = new Set();
    out[k] = out[k].filter((q) => (seen.has(q.query) ? false : seen.add(q.query)));
  }
  return out;
}

// --- sources: cited (attribution-bearing display sources) vs fetched (search_result) ---
function extractSources(nodes, diag) {
  const byUrl = new Map();
  const RANK = { mentioned: 0, fetched: 1, cited: 2 };

  function add(rawUrl, fields) {
    const url = cleanUrl(rawUrl);
    if (!isHttpUrl(url)) return;
    const prev = byUrl.get(url) || {};
    let outcome = fields.outcome || "fetched";
    if (prev.outcome && RANK[prev.outcome] >= RANK[outcome]) outcome = prev.outcome;
    const prevIds = (prev.platformSpecific && prev.platformSpecific.markerIds) || [];
    const newIds = fields.markerIds || [];
    const markerIds = newIds.length || prevIds.length ? [...new Set([...prevIds, ...newIds])] : undefined;
    byUrl.set(url, {
      url,
      domain: fields.domain || prev.domain || domainOf(url),
      title: fields.title || prev.title || null,
      snippet: fields.snippet || prev.snippet || null,
      outcome,
      type: fields.type || prev.type || "unknown",
      platformSpecific: {
        ...(prev.platformSpecific || {}),
        ...(fields.platformSpecific || {}),
        ...(markerIds ? { markerIds } : {}),
      },
    });
  }

  // Builds the literal inline-citation-marker id ChatGPT embeds in the answer
  // text (e.g. "turn0search3") from a {turn_index, ref_type, ref_index} object
  // — the exact same three fields under both `ref_id` (search_results) and each
  // entry of `refs[]` (grouped/cited items). Confirmed against real payloads:
  // `ref_id: {"turn_index":0,"ref_type":"search","ref_index":1}` next to a
  // source whose answer-text marker is literally `citeturn0search1`.
  // Capturing this lets an export renderer join inline cite markers back to a
  // specific source for numbered footnotes, instead of only counting types.
  function markerId(o) {
    if (!o || typeof o.turn_index !== "number" || typeof o.ref_type !== "string" || typeof o.ref_index !== "number")
      return null;
    return `turn${o.turn_index}${o.ref_type}${o.ref_index}`;
  }

  let sawSource = false;
  walk({ nodes }, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const url = value.url || value.link;
    if (!isHttpUrl(url)) return;

    // Domain always comes from the URL (reliable). `attribution` is a display
    // label only — it's inconsistently a domain ("gadgets360.com") or a name
    // ("Gadgets 360"), so it must not drive grouping.
    const attribution = typeof value.attribution === "string" ? value.attribution : null;

    // Two different things, see lib/retrieval.js. ref_type (search | news |
    // academia | reddit | youtube | product …, on ref_id or refs[]) is the
    // KIND of result, present on every one. result_source is the PIPELINE
    // that supplied it — labrador (OpenAI's own index), bright, oxylabs or
    // serp — and ChatGPT only sent it from 21 May to 21 July 2026. Kept
    // exactly as sent; nothing is inferred when it's missing.
    // (`resultSource` has always held the ref_type — the name predates the
    // pipeline field — so it stays, for the screens and exports that read it.)
    const refType =
      (value.ref_id && value.ref_id.ref_type) ||
      (Array.isArray(value.refs) && value.refs[0] && value.refs[0].ref_type) ||
      null;
    // result_source as sent; otherwise an engine or source field on the
    // same result, but only if it is EXACTLY a name from the leaked engine
    // registry — a field called "source" holding anything else is not one.
    const pipeline =
      (typeof value.result_source === "string" && value.result_source) ||
      (value.metadata && typeof value.metadata.result_source === "string" && value.metadata.result_source) ||
      ["engine", "engine_name", "search_engine", "retrieval_engine", "source"].map((k) => value[k]).find(isKnownRetrievalName) ||
      null;
    const retrieval = {
      ...(refType ? { resultSource: refType, refType } : {}),
      ...(pipeline ? { pipeline: pipeline.toLowerCase() } : {}),
    };

    const markerIds = [
      markerId(value.ref_id),
      ...(Array.isArray(value.refs) ? value.refs.map(markerId) : []),
    ].filter(Boolean);

    const pubDate = typeof value.pub_date === "number" ? value.pub_date : null;

    // Fetched: raw retrieved results. Checked first so the cited/fetched split
    // survives even when a search_result also carries an attribution label.
    if (value.type === "search_result" || value.type === "search_result_group") {
      sawSource = true;
      add(url, {
        title: value.title || null,
        snippet: value.snippet || null,
        outcome: "fetched",
        type: pubDate ? "news" : "other",
        markerIds,
        platformSpecific: {
          ...(attribution ? { attribution } : {}),
          ...retrieval,
          ...(pubDate ? { pubDate } : {}),
        },
      });
      return;
    }
    // Cited/shown: display sources (inline `sources` items + grouped_webpages)
    // carry an `attribution` label and usually a pub_date/snippet.
    if (attribution) {
      sawSource = true;
      add(url, {
        title: value.title || null,
        snippet: value.snippet || null,
        markerIds,
        outcome: "cited",
        type: pubDate ? "news" : "citation",
        platformSpecific: { attribution, ...retrieval, ...(pubDate ? { pubDate } : {}) },
      });
    }
  });

  // Last-resort fallback: any http URL (skip ChatGPT's own image CDN).
  if (!sawSource) {
    for (const node of nodes) {
      collectByKey(node, /.*/, isHttpUrl).forEach((u) => {
        if (!/images\.openai\.com/.test(u)) add(u, { outcome: "fetched", type: "unknown" });
      });
    }
    if (byUrl.size) {
      diag.usedFallback = true;
      diag.notes.push("sources: used raw-URL fallback");
    }
  }

  return [...byUrl.values()].map(makeSource);
}

// --- products (carousel) ---
function extractProducts(nodes) {
  const byId = new Map();
  walk({ nodes }, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const p = value.product || (value.title && value.price && value.merchants ? value : null);
    if (!p || !p.title) return;
    const id = p.id || p.title;
    const prev = byId.get(id) || {};
    const renderAs = value.render_as || p.render_as || prev.renderAs || "block";
    byId.set(id, {
      id,
      name: p.title || prev.name,
      price: p.price || prev.price || null,
      merchant: p.merchants || prev.merchant || null,
      rating: p.rating ?? prev.rating ?? null,
      reviews: p.num_reviews ?? prev.reviews ?? null,
      image: (p.image_urls && p.image_urls[0]) || prev.image || null,
      cite: p.cite || prev.cite || null,
      renderAs,
      // The feed behind the listing (see lib/retrieval.js): `provider` is
      // "deprecated" on current payloads, the codes live in providers[].
      supplier: (Array.isArray(p.providers) && p.providers[0]) || (p.provider !== "deprecated" && p.provider) || prev.supplier || null,
    });
  });
  return [...byId.values()];
}

// Local/business results (e.g. "jewellers near me", "coffee shop with wifi").
// ChatGPT's local search returns a rich structured object per business —
// name, coordinates, rating, review_count, address, phone, hours, website,
// open/closed status, and a Google-Place-style id — nested under
// { category: "local_business", entity_data: {...} }. This is genuinely useful
// GEO data (how a business appears in ChatGPT's local layer) that was previously
// dropped entirely; only Gemini had a places[] extractor before this.
function formatHours(hours) {
  if (!Array.isArray(hours) || !hours.length) return null;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmt = (hhmm) => {
    if (typeof hhmm !== "string" || hhmm.length < 3) return hhmm;
    const h = parseInt(hhmm.slice(0, hhmm.length - 2), 10);
    const m = hhmm.slice(-2);
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m} ${period}`;
  };
  return hours
    .filter((h) => h && typeof h.day === "number")
    .map((h) => `${DAYS[h.day] || h.day} ${fmt(h.start)}–${fmt(h.end)}`)
    .join(", ");
}

function extractPlaces(nodes) {
  const byKey = new Map();
  walk({ nodes }, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.category !== "local_business") return;
    const ed = value.entity_data;
    if (!ed || typeof ed !== "object") return;
    const key = ed.id || value.name || ed.name;
    if (!key) return;
    const prev = byKey.get(key) || {};
    const placeId = ed.id || prev.placeId || null;
    byKey.set(key, {
      name: ed.name || value.name || prev.name || null,
      category: (Array.isArray(ed.categories) && ed.categories[0]) || prev.category || null,
      rating: ed.rating ?? prev.rating ?? null,
      reviews: ed.review_count ?? prev.reviews ?? null,
      phone: ed.phone || prev.phone || null,
      address: ed.address || prev.address || null,
      website: ed.website_url || prev.website || null,
      // A Google Place id (e.g. "ChIJ...") resolves to a real Maps listing.
      mapsUrl: placeId ? `https://www.google.com/maps/place/?q=place_id:${placeId}` : prev.mapsUrl || null,
      lat: typeof ed.latitude === "number" ? ed.latitude : prev.lat ?? null,
      lng: typeof ed.longitude === "number" ? ed.longitude : prev.lng ?? null,
      priceRange: ed.price_str || prev.priceRange || null,
      hours: formatHours(ed.hours) || prev.hours || null,
      isOpen: typeof ed.is_open === "boolean" ? ed.is_open : prev.isOpen ?? null,
      placeId,
      // The feed behind the listing (b1, b3, serp, yelp…) — lib/retrieval.js.
      supplier: (typeof ed.provider === "string" && ed.provider) || (typeof value.provider === "string" && value.provider) || prev.supplier || null,
    });
  });
  return [...byKey.values()];
}

// Entities come from the model's own annotations where available (it labels them
// with a real category — "company", "organization", … for whatever industry the
// answer is about), plus products/merchants and detected brands. `baseEntities`
// is the entities half of the same detectBrandsForCapture() result brandMentions
// came from — see the comment there for why this isn't its own detectBrands() call.
function extractEntities(baseEntities, products, brandMentions, sources, places) {
  const seen = new Set(baseEntities.map((e) => (e.category || "") + "|" + e.text.toLowerCase()));
  const out = [...baseEntities];
  const add = (text, category) => {
    const t = (text || "").trim();
    const k = category + "|" + t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push({ text: t, category });
    }
  };
  (products || []).forEach((p) => {
    if (p.merchant) add(String(p.merchant).split(/[+,]/)[0].trim(), "Retailer");
  });
  (places || []).forEach((p) => add(p.name, "Local Business"));
  (brandMentions || []).forEach((b) => add(b.brand, b.category ? titleish(b.category) : "Brand"));
  return out;
}
function titleish(s) {
  return String(s).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Image carousel: product thumbnails today (images.openai.com), plus any
// image-typed content reference that carries a direct URL.
function extractImages(nodes, products) {
  const out = [];
  const seen = new Set();
  const add = (url, title, extra = {}) => {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: title || null, ...extra });
  };
  (products || []).forEach((p) => p.image && add(p.image, p.name, { price: p.price || null }));
  collectObjects({ nodes }, (o) => typeof o.type === "string" && /image/i.test(o.type) && o.url).forEach((o) =>
    add(o.url, o.title || o.alt, { attribution: o.attribution || null })
  );
  return out;
}

// Generative-UI answers: which refs the answer cites, its cards as products,
// and the pictures each card showed.
//
// Cited refs come from the <Cite refs> in the text and from the "cite"
// components ChatGPT lists beside it (genui_components / content_references,
// each with entities[].ref). A source whose ref is among them was cited:
// these answers carry no attribution-bearing citation items, so until 0.60.1
// every page read showed as "read only" (reported: "0 of 20 cited" on an
// answer whose own chips cited Smartprix and 91mobiles).
function markGenUiCited(nodes, sources, textRefs) {
  const refs = new Set(textRefs || []);
  collectObjects({ nodes }, (o) => o.type === "cite" && Array.isArray(o.entities)).forEach((o) =>
    o.entities.forEach((e) => { if (e && typeof e.ref === "string") refs.add(e.ref); }));
  if (!refs.size) return;
  for (const s of sources) {
    const ids = (s.platformSpecific && s.platformSpecific.markerIds) || s.markerIds || [];
    if (ids.some((id) => refs.has(id))) s.outcome = "cited";
  }
}

// The pictures of each <AsyncImage>, in the order the images appear in the
// answer: appData.opGenui.componentResults[<component id>].state.images.
// Returns one list per image component.
function genUiImages(nodes) {
  const byId = new Map();
  const put = (id, list) => {
    if (!Array.isArray(list)) return;
    const cur = byId.get(id) || [];
    list.forEach((im) => {
      if (!im || typeof im !== "object") return;
      const url = im.content_url || im.thumbnail_url || im.original_content_url;
      if (!isHttpUrl(url) || cur.some((x) => x.url === url)) return;
      const page = isHttpUrl(im.url) ? im.url : null;
      cur.push({ url, title: typeof im.title === "string" ? im.title : null, sourceUrl: page, attribution: page ? domainOf(page) : null });
    });
    byId.set(id, cur);
  };
  walk({ nodes }, (value, key) => {
    if (key === "p" || !value || typeof value !== "object") return;
    if (typeof value.p === "string") {
      const m = /componentResults\/([^/]+)\/state\/images$/.exec(value.p);
      if (m) put(m[1], value.v);
    }
    if (value.componentResults && typeof value.componentResults === "object") {
      for (const [id, r] of Object.entries(value.componentResults)) put(id, r && r.state && r.state.images);
    }
  });
  const order = [];
  collectObjects({ nodes }, (o) => o.type === "async_image" && typeof o.component_resolution_id === "string").forEach((o) => {
    if (!order.includes(o.component_resolution_id)) order.push(o.component_resolution_id);
  });
  return order.map((id) => byId.get(id) || []);
}

// The answer's cards, in the answer's order, as products. A card tied to a
// shopping listing (Entity ref …productN) keeps that listing's data (stores,
// rating, image); the others become products the answer named with a price,
// marked as having no listing. Listings the answer didn't put on a card keep
// their place after them.
// A card and a shopping listing name the same product when every word of the
// card's name is in the listing's ("Air 8" = "Air8"), and the listing adds no
// variant word the card lacks: "Nord Buds 4" is not "Nord Buds 4 Pro".
const VARIANT = new Set(["pro", "max", "plus", "ultra", "lite", "mini", "neo", "se", "air", "fe", "prime", "r", "s"]);
function productWords(name) {
  return String(name || "").toLowerCase().replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
export function sameProduct(cardName, listingName) {
  const c = productWords(cardName), l = productWords(listingName);
  if (c.length < 2 || !l.length) return false;
  const ls = new Set(l), cs = new Set(c);
  if (!c.every((w) => ls.has(w))) return false;
  return !l.some((w) => VARIANT.has(w) && !cs.has(w));
}

function mergeGenUiCards(products, cards, imageLists) {
  if (!cards || !cards.length) return products;
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  let img = 0;
  const out = [];
  const used = new Set();
  for (const c of cards) {
    const pics = c.image ? (imageLists[img++] || []) : [];
    const hit = products.find((p, i) => !used.has(i) && norm(p.name) === norm(c.name))
      || products.find((p, i) => !used.has(i) && sameProduct(c.name, p.name));
    if (hit) {
      used.add(products.indexOf(hit));
      // One product, shown once: the card's name and place (what was on
      // screen), the listing's id, price, stores and rating. The card's own
      // picture leads; the listing's stays as the fallback. Before 0.62.1
      // "realme Buds Air 8" and its listing "Realme Buds Air8 With 55db Anc,
      // …" were two products.
      out.push({ ...hit, name: c.name, listingName: hit.name !== c.name ? hit.name : undefined, price: hit.price || c.price || null, image: (pics[0] && pics[0].url) || hit.image || null, subtitle: c.subtitle || null, badge: c.badge || null, headline: c.headline || null });
    } else {
      out.push({
        id: `answer-${c.n}`, name: c.name, price: c.price || null, merchant: null, rating: null, reviews: null,
        image: (pics[0] && pics[0].url) || null, cite: null, renderAs: "answer-card", supplier: null,
        listing: false, subtitle: c.subtitle || null, badge: c.badge || null, headline: c.headline || null,
      });
    }
  }
  products.forEach((p, i) => { if (!used.has(i)) out.push(p); });
  return out;
}

// Ads: ChatGPT can follow an answer with a sponsored card, sent as its own
// SSE event { type: "ads", content: { type: "single_advertiser_ad_unit",
// preamble, advertiser_brand: { name, url }, ad_cards: [{ title, body,
// target: { value }, image_url, card_header: { subtitle: "Sponsored" },
// format }] }, placement_name: "conversational_bottom" }. Reported: "The
// chatgpt pushed an ad in the bottom, we should have a section to show that
// and its data." Kept: who advertised, what the card said, where it links,
// where it sat. Dropped: the inline logos (data: URLs, ~20 KB each) and the
// tracking tokens, which say nothing about the answer.
const AD_PLACEMENT = { conversational_bottom: "Below the answer", conversational_top: "Above the answer" };
function extractAds(nodes) {
  const out = [];
  const seen = new Set();
  const str = (v, max = 400) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  for (const ev of collectObjects({ nodes }, (o) => o.type === "ads" && o.content && typeof o.content === "object")) {
    if (ev.visibility && ev.visibility.status && ev.visibility.status !== "allowed") continue;
    const c = ev.content;
    const brand = c.advertiser_brand || {};
    const cards = Array.isArray(c.ad_cards) && c.ad_cards.length ? c.ad_cards : Array.isArray(c.carousel_cards) ? c.carousel_cards : [];
    for (const card of cards.length ? cards : [{}]) {
      const target = card.target && isHttpUrl(card.target.value) ? card.target.value : null;
      const header = card.card_header || {};
      const ad = {
        advertiser: str(brand.name, 80) || str(card.company_name, 80) || str(header.title, 80),
        advertiserUrl: str(brand.url, 200),
        label: str(header.subtitle, 40) || "Sponsored",
        preamble: str(c.preamble),
        title: str(card.title, 200),
        body: str(card.body),
        targetUrl: target,
        targetDomain: target ? domainOf(target) : brand.url ? domainOf(`https://${String(brand.url).replace(/^https?:\/\//, "")}`) : null,
        imageUrl: isHttpUrl(card.image_url) ? card.image_url : null,
        format: str(card.format, 60),
        unit: str(c.type, 60),
        placement: AD_PLACEMENT[ev.placement_name] || str(ev.placement_name, 60),
      };
      if (!ad.advertiser && !ad.title) continue;
      const key = `${ad.advertiser}|${ad.title}|${ad.targetDomain}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ad);
    }
  }
  return out;
}

/* The values a generative-UI card binds by name: "{turn168326product0.
 * displayed_price}" in the layout, the value under appData.opGenui.
 * modelDataBindings (sent whole, or one product at a time as patches). Left
 * unread, a card lost its price and store (0.62.1, from the owner's
 * "best earbuds under 4000" capture). */
function genUiBindings(nodes) {
  const out = {};
  const put = (id, v) => { if (id && v && typeof v === "object" && !Array.isArray(v)) out[id] = { ...(out[id] || {}), ...v }; };
  collectObjects({ nodes }, (o) => typeof o.p === "string" && /\/modelDataBindings(?:\/|$)/.test(o.p) && o.v && typeof o.v === "object").forEach((o) => {
    const m = /\/modelDataBindings(?:\/([^/]+))?$/.exec(o.p);
    if (!m) return;
    if (m[1]) put(m[1], o.v);
    else Object.entries(o.v).forEach(([id, v]) => put(id, v));
  });
  collectByKey({ nodes }, /^modelDataBindings$/, (v) => v && typeof v === "object" && !Array.isArray(v)).forEach((b) => Object.entries(b).forEach(([id, v]) => put(id, v)));
  return out;
}

export async function adapt(rawCapture, opts = {}) {
  const diag = { adapterVersion: ADAPTER_VERSION, usedFallback: false, notes: [] };
  const nodes = parseSse(rawCapture.raw || "");

  const fanout = extractFanout(nodes, diag);
  const sources = extractSources(nodes, diag);
  let products = extractProducts(nodes);
  const places = extractPlaces(nodes);
  const ads = extractAds(nodes);
  const searched =
    fanout.search.length + fanout.shopping.length + fanout.image.length > 0 ||
    sources.some((s) => s.outcome !== "unknown") ||
    sources.length > 0;

  const conversationId = collectByKey({ nodes }, /^conversation_id$/, (v) => typeof v === "string")[0] || null;
  const model = collectByKey({ nodes }, /^model_slug$|^resolved_model_slug$/, (v) => typeof v === "string")[0] || null;
  const generatedTitle = collectObjects({ nodes }, (o) => o.type === "title_generation" && o.title).map((o) => o.title).pop() || null;
  const turnUseCase = collectByKey({ nodes }, /^turn_use_case$/, (v) => typeof v === "string")[0] || null;

  let answerText = reconstructAnswer(nodes);
  // ChatGPT's generative-UI answers (October 2026): layout code turned back
  // into the answer, its cards into products, its citations marked (see
  // lib/genui.js).
  const genui = isGenUi(answerText) ? readGenUi(answerText, { bindings: genUiBindings(nodes) }) : null;
  if (genui) {
    answerText = genui.markdown;
    markGenUiCited(nodes, sources, genui.cites);
    const pics = genUiImages(nodes);
    products = mergeGenUiCards(products, genui.cards, pics);
    // Each card block gets its picture, in the order the AsyncImages came,
    // so the answer view can draw the card as ChatGPT did (0.60.2).
    let k = 0;
    genui.blocks.forEach((bl) => {
      if (bl.type !== "card") return;
      const pic = bl.image ? (pics[k++] || [])[0] : null;
      bl.image = pic ? { url: pic.url, sourceUrl: pic.sourceUrl || null, title: pic.title || null } : null;
    });
  }
  const referenceTypes = extractReferenceTypes(nodes, answerText);
  const userPrompt = extractPrompt(rawCapture.reqBody);
  const { brands: brandMentions, entities: baseEntities } = await detectBrandsForCapture(answerText, products, opts.tracked, sources, places, userPrompt);
  const entities = extractEntities(baseEntities, products, brandMentions, sources, places);
  const images = extractImages(nodes, products);
  // The picture each card showed (the first of its image component).
  // A card's picture is often already in the list as its product's image,
  // without the page it came from; the card's copy knows that page.
  if (genui) genUiImages(nodes).map((l) => l[0]).filter(Boolean).forEach((im) => {
    const have = images.find((x) => x.url === im.url);
    if (!have) images.push(im);
    else for (const k of ["sourceUrl", "attribution", "title"]) if (!have[k] && im[k]) have[k] = im[k];
  });

  // Carousel presence: products carousel if any product; news if any dated/news
  // source; image carousel if an image-typed content reference exists; map if a
  // map/place reference or maps content type shows up.
  const carousels = {
    products: products.length > 0,
    // A news carousel only when the stream has a block of its own for one.
    // Neither news pages read while searching nor a news page cited in the
    // text put a carousel on screen (reported twice: 0.60.0 for read pages,
    // 0.60.1 for a card that cited a news story, both with no carousel).
    news: collectObjects({ nodes }, (o) => typeof o.type === "string" && /news/i.test(o.type) && o.type !== "search_result").length > 0,
    images: collectObjects({ nodes }, (o) => typeof o.type === "string" && /image/i.test(o.type) && (o.url || o.image_urls)).length > 0,
    map: places.length > 0,
  };

  const steObj = collectObjects({ nodes }, (o) => o.type === "server_ste_metadata" && o.metadata).map((o) => o.metadata).pop() || {};
  const clientContext = collectByKey({ nodes }, /^client_contextual_info$/, (v) => typeof v === "object")[0] || null;
  const useragentObj = collectByKey({ nodes }, /^useragent$/, (v) => typeof v === "object")[0] || null;
  const limitsProgress = collectObjects({ nodes }, (o) => o.type === "conversation_detail_metadata" && o.limits_progress).map((o) => o.limits_progress).pop() || [];
  
  const abExperiment = collectObjects({ nodes }, (o) => o.analytics_meta && o.analytics_meta["ab_test.search_engine_all.allocated_experiment"]).map((o) => o.analytics_meta["ab_test.search_engine_all.allocated_experiment"]).pop() || null;
  const wordCount = answerText.trim() ? answerText.trim().split(/\s+/).length : 0;

  const platformSpecific = {
    ste: steObj,
    toolName: steObj.tool_name || (searched ? "SonicBrowserTool" : null),
    planType: steObj.plan_type || "free",
    clusterRegion: steObj.cluster_region || null,
    ttfvtMs: steObj.server_ttfvt_ms || null,
    conduitPrewarmed: steObj.conduit_prewarmed ?? null,
    warmupState: steObj.warmup_state || null,
    author: collectByKey({ nodes }, /^real_author$/, (v) => typeof v === "string")[0] || (searched ? "tool:web" : "assistant"),
    clientContext,
    useragent: useragentObj,
    limitsProgress,
    abExperiment,
    // A generative-UI answer (lib/genui.js), and the follow-up form it ended
    // with: the choices it offered, its checkboxes and its button.
    genUi: !!genui,
    followUp: genui ? genui.followUp : null,
    genUiBlocks: genui ? genui.blocks : null,
    wordCount,
    // The assistant messages this answer is made of. What ChatGPT loads when
    // someone opens a product card names the message it belongs to
    // (sidebar/conversation's message_id), which ties it to this answer
    // exactly rather than to whatever was asked last in the conversation.
    messageIds: [...new Set(collectObjects({ nodes }, (o) => typeof o.id === "string" && o.author && o.author.role === "assistant").map((o) => o.id))].slice(0, 20),
  };
  // Engines from the leaked retrieval registry that this stream names, if any
  // (see lib/retrieval.js): which of OpenAI's own and external engines the
  // answer's search touched.
  const enginesNamed = enginesNamedIn(rawCapture.raw);
  if (enginesNamed.length) platformSpecific.enginesNamed = enginesNamed;

  return makeRecord({
    captureId: rawCapture.captureId,
    platform: "chatgpt",
    model,
    capturedAt: rawCapture.capturedAt,
    pageUrl: rawCapture.pageUrl,
    rawRef: rawCapture.captureId,
    conversationId,
    generatedTitle,
    turnUseCase,
    userPrompt,
    searched,
    fanout,
    sources,
    products,
    places,
    entities,
    images,
    brandMentions,
    carousels,
    referenceTypes,
    ads,
    answerChars: answerText.length,
    answerText, // capped by makeRecord; the UI needs this for rank/aspect analysis
    platformSpecific,
    _extraction: diag,
  });
}
