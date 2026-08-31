/*
 * adapters/grok.js — derive a normalized record from raw xAI Grok captures.
 *
 * Normalizes Grok (grok.com & x.com/i/grok) responses:
 *   - Answer text & model identity (grok-2, grok-3, etc.)
 *   - Web & X/Twitter post citations
 *   - Inline citations from cardAttachmentsJson & render_inline_citation
 *   - Web search results from webSearchResults & toolUsageResults
 *   - Real-time social engagement signals (author, likes, post metrics)
 *   - DeepSearch thinking traces & search sub-queries from toolUsageCards
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf, stripCiteMarkers } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "grok@0.2.0";

function parseFrames(raw) {
  if (!raw || typeof raw !== "string") return [];
  const nodes = [];
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) nodes.push(...parsed);
      else nodes.push(parsed);
      if (parsed && Array.isArray(parsed.responses)) {
        nodes.push(...parsed.responses);
      }
      return nodes;
    } catch (_) {}
  }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:") && !t.startsWith("{")) continue;
    const payload = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (!payload || payload === "[DONE]") continue;
    try {
      const p = JSON.parse(payload);
      if (Array.isArray(p)) nodes.push(...p);
      else nodes.push(p);
      if (p && Array.isArray(p.responses)) {
        nodes.push(...p.responses);
      }
    } catch (_) {}
  }
  return nodes;
}

function extractPrompt(reqBody, nodes) {
  if (reqBody && typeof reqBody === "string") {
    try {
      const parsed = JSON.parse(reqBody);
      if (parsed.message) return parsed.message;
      if (parsed.query) return parsed.query;
      if (Array.isArray(parsed.messages)) {
        const u = parsed.messages.filter((m) => m.role === "user" || m.sender === "human" || m.sender === "user").pop();
        if (u && (u.content || u.text || u.message)) return u.content || u.text || u.message;
      }
    } catch (_) {}
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (n.sender === "human" && n.message) return n.message;
    if (n.userMessage && typeof n.userMessage === "string") return n.userMessage;
    if (n.prompt && typeof n.prompt === "string") return n.prompt;
    if (n.query && typeof n.query === "string" && n.query) return n.query;
  }
  return "";
}

function extractAnswer(nodes) {
  let text = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    // Skip human prompts when looking for answer text
    if (n.sender === "human") continue;
    if (typeof n.message === "string" && n.message.length > text.length) text = n.message;
    if (typeof n.response === "string" && n.response.length > text.length) text = n.response;
    if (typeof n.text === "string" && n.text.length > text.length) text = n.text;
    if (n.result && typeof n.result.response === "string" && n.result.response.length > text.length) {
      text = n.result.response;
    }
    if (typeof n.token === "string") text += n.token;
  }
  return text;
}

function extractModel(nodes) {
  for (const n of nodes) {
    if (n && typeof n.model === "string" && n.model) return n.model;
    if (n && n.metadata && typeof n.metadata.model === "string") return n.metadata.model;
  }
  return null;
}

function extractSources(nodes) {
  const sources = [];
  const socialCitations = [];
  const seenUrls = new Set();

  function addSource(item, isCited = false) {
    if (!item || typeof item !== "object") return;
    const url = item.url || item.link || item.web_url || item.uri;
    if (!url || !isHttpUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);

    const title = item.title || item.name || item.snippet_title || item.headline || "";
    const snippet = item.snippet || item.preview || item.text || item.summary || "";
    const domain = domainOf(url);

    const isXPost = domain === "x.com" || domain === "twitter.com" || item.is_x_post || item.type === "x_post" || item.xpostId;
    if (isXPost) {
      socialCitations.push({
        url,
        author: item.author || item.username || item.handle || null,
        likes: item.likes != null ? item.likes : null,
        reposts: item.reposts != null ? item.reposts : null,
        snippet: snippet.slice(0, 200),
      });
    }

    sources.push(
      makeSource({
        url,
        title,
        domain,
        snippet,
        outcome: isCited ? "cited" : "fetched",
        type: isXPost ? "other" : "citation",
        platformSpecific: {
          isSocialPost: isXPost,
          author: item.author || null,
          likes: item.likes != null ? item.likes : null,
        },
      })
    );
  }

  // 1. Check cardAttachmentsJson for explicitly cited cards
  const citedUrls = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.cardAttachmentsJson)) {
      n.cardAttachmentsJson.forEach((cardStr) => {
        try {
          const card = typeof cardStr === "string" ? JSON.parse(cardStr) : cardStr;
          if (card && card.url) {
            citedUrls.add(card.url);
            addSource(card, true);
          }
        } catch (_) {}
      });
    }
    if (Array.isArray(n.citedWebSearchResults)) {
      n.citedWebSearchResults.forEach((item) => {
        if (item && item.url) {
          citedUrls.add(item.url);
          addSource(item, true);
        }
      });
    }
  }

  // 2. Check all search results
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const lists = [
      n.webSearchResults,
      n.web_search_results,
      n.searchResults,
      n.sources,
      n.citations,
      n.xposts,
      n.x_post_results,
      n.posts,
    ];
    for (const list of lists) {
      if (Array.isArray(list)) {
        list.forEach((item) => {
          const isExplicitlyCited = item.url && citedUrls.has(item.url);
          addSource(item, isExplicitlyCited);
        });
      }
    }

    // Check steps toolUsageResults
    if (Array.isArray(n.steps)) {
      n.steps.forEach((st) => {
        if (Array.isArray(st.toolUsageResults)) {
          st.toolUsageResults.forEach((tur) => {
            if (tur && tur.webSearchResults && Array.isArray(tur.webSearchResults.results)) {
              tur.webSearchResults.results.forEach((item) => {
                const isExplicitlyCited = item.url && citedUrls.has(item.url);
                addSource(item, isExplicitlyCited);
              });
            }
          });
        }
        if (Array.isArray(st.webSearchResults)) {
          st.webSearchResults.forEach((item) => {
            const isExplicitlyCited = item.url && citedUrls.has(item.url);
            addSource(item, isExplicitlyCited);
          });
        }
      });
    }
  }

  return { sources, socialCitations };
}

// Grok's own message text carries its inline citations as literal markup:
//   <grok:render card_id="3a8177" card_type="citation_card"
//     type="render_inline_citation"><argument name="citation_id">4</argument>
//   </grok:render>
// Nothing converted or stripped this before it reached answerText, so it
// rendered as visible "code" in the exported PDF/HTML — text the user never
// actually saw in the real answer (the real UI turns this into a small
// citation pill). card_id is the reliable key into cardAttachmentsJson
// (present on every node that carries one, same objects extractSources
// already parses for the sources list); citation_id is a 0-based index into
// webSearchResults, kept only as a fallback for the rarer case where a
// card_id has no matching attachment. Converts to the SAME [[cite:URL]]
// marker Perplexity's harvester writes, so one export renderer
// (exportDoc.js's renderPerplexityAnswer) and one detection-time strip
// (stripCiteMarkers, lib/deep.js) cover both platforms.
const GROK_RENDER_RE = /<grok:render\b([^>]*)>([\s\S]*?)<\/grok:render>/g;

function convertGrokCitationMarkers(text, nodes) {
  if (!text || !GROK_RENDER_RE.test(text)) return text;
  GROK_RENDER_RE.lastIndex = 0;

  const cardIdToUrl = new Map();
  const flatResults = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.cardAttachmentsJson)) {
      for (const cardStr of n.cardAttachmentsJson) {
        try {
          const card = typeof cardStr === "string" ? JSON.parse(cardStr) : cardStr;
          if (card && card.id && card.url) cardIdToUrl.set(card.id, card.url);
        } catch (_) { /* not parseable — skip */ }
      }
    }
    if (Array.isArray(n.webSearchResults)) flatResults.push(...n.webSearchResults);
    if (Array.isArray(n.steps)) {
      for (const st of n.steps) {
        if (st && Array.isArray(st.webSearchResults)) flatResults.push(...st.webSearchResults);
      }
    }
  }

  return text.replace(GROK_RENDER_RE, (whole, attrs, inner) => {
    const cardId = (attrs.match(/\bcard_id="([^"]*)"/) || [])[1];
    const citationIdx = (inner.match(/name="citation_id">(\d+)</) || [])[1];
    const url =
      (cardId && cardIdToUrl.get(cardId)) ||
      (citationIdx != null && flatResults[Number(citationIdx)]?.url) ||
      null;
    // Unresolvable: drop the raw tag rather than leave broken markup or
    // fabricate a URL this codebase can't back with a real source.
    return url ? `[[cite:${url}]]` : "";
  });
}

function extractFanoutAndThoughts(nodes) {
  const search = [];
  const thoughts = [];
  const seen = new Set();

  const pushQ = (q) => {
    if (typeof q === "string" && q.trim().length > 2 && !seen.has(q.trim())) {
      seen.add(q.trim());
      search.push({ query: q.trim(), search_type: "search" });
    }
  };

  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.queries)) n.queries.forEach(pushQ);
    if (Array.isArray(n.search_queries)) n.search_queries.forEach(pushQ);
    if (typeof n.search_query === "string") pushQ(n.search_query);
    if (typeof n.query === "string" && n.query) pushQ(n.query);

    if (typeof n.thought === "string" && n.thought) thoughts.push(n.thought);
    if (typeof n.reasoning === "string" && n.reasoning) thoughts.push(n.reasoning);

    // Grok steps with toolUsageCards & text annotations
    if (Array.isArray(n.steps)) {
      n.steps.forEach((st) => {
        if (Array.isArray(st.toolUsageCards)) {
          st.toolUsageCards.forEach((tuc) => {
            if (tuc && tuc.webSearch && tuc.webSearch.args && tuc.webSearch.args.query) {
              pushQ(tuc.webSearch.args.query);
            }
          });
        }
        if (Array.isArray(st.text)) {
          st.text.forEach((t) => {
            if (typeof t === "string" && t.includes("<xai:tool_args>")) {
              const m = t.match(/"query":\s*"([^"]+)"/);
              if (m) pushQ(m[1]);
            }
          });
        }
      });
    }
  }

  return { search, thoughts };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parseFrames(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  // Converted to [[cite:URL]] here, in the STORED answerText — not just a
  // detection-only copy — matching how Perplexity's own <grok:render>
  // equivalent already works: content-iso.js's DOM harvester writes
  // [[cite:URL]] directly during capture, so by the time either adapter's
  // answerText exists, the marker shape is already uniform. See
  // convertGrokCitationMarkers above for why the raw tag needs converting
  // rather than just stripping (a citation genuinely belongs at that
  // position in the text, exportDoc.js just needs it in the shared shape).
  const answerText = convertGrokCitationMarkers(extractAnswer(nodes), nodes);
  const model = extractModel(nodes);
  const { sources, socialCitations } = extractSources(nodes);
  const { search, thoughts } = extractFanoutAndThoughts(nodes);

  // Detection-only copy: a cited domain must not be able to match itself
  // inside its own citation marker (the exact bug already fixed for
  // Perplexity — see perplexity.js's stripCiteMarkersForDetection).
  const textForDetection = stripCiteMarkers(answerText);
  const brandRes = detectBrands(textForDetection, textForDetection, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "grok",
    model: model || "grok-3",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://grok.com",
    userPrompt,
    answerText,
    answerChars: answerText.length,
    searched: sources.length > 0 || search.length > 0,
    sources,
    fanout: {
      search,
      shopping: [],
      image: [],
    },
    brandMentions,
    entities,
    platformSpecific: {
      adapterVersion: ADAPTER_VERSION,
      socialCitations,
      thoughts: thoughts.length ? thoughts : undefined,
    },
  });
}
