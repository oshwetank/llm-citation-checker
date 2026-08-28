/*
 * adapters/grok.js — derive a normalized record from raw xAI Grok captures.
 *
 * Normalizes Grok (grok.com & x.com/i/grok) responses:
 *   - Answer text & model identity
 *   - Web & X/Twitter post citations
 *   - Real-time social engagement signals (author, likes, post metrics)
 *   - DeepSearch thinking traces & search sub-queries
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "grok@0.1.0";

function parseFrames(raw) {
  if (!raw || typeof raw !== "string") return [];
  const nodes = [];
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      nodes.push(JSON.parse(trimmed));
      return nodes;
    } catch (_) {}
  }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:") && !t.startsWith("{")) continue;
    const payload = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (!payload || payload === "[DONE]") continue;
    try {
      nodes.push(JSON.parse(payload));
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
        const u = parsed.messages.filter((m) => m.role === "user" || m.sender === "user").pop();
        if (u && (u.content || u.text)) return u.content || u.text;
      }
    } catch (_) {}
  }
  for (const n of nodes) {
    if (n && typeof n === "object") {
      if (n.userMessage && typeof n.userMessage === "string") return n.userMessage;
      if (n.prompt && typeof n.prompt === "string") return n.prompt;
    }
  }
  return "";
}

function extractAnswer(nodes) {
  let text = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.message === "string" && n.message.length > text.length) text = n.message;
    if (typeof n.response === "string" && n.response.length > text.length) text = n.response;
    if (typeof n.text === "string" && n.text.length > text.length) text = n.text;
    if (n.result && typeof n.result.response === "string" && n.result.response.length > text.length) {
      text = n.result.response;
    }
    // Incremental token appending if stream format
    if (typeof n.token === "string") text += n.token;
  }
  return text;
}

function extractSources(nodes) {
  const sources = [];
  const socialCitations = [];
  const seenUrls = new Set();

  function addSource(item, isCited = true) {
    if (!item || typeof item !== "object") return;
    const url = item.url || item.link || item.web_url;
    if (!url || !isHttpUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);

    const title = item.title || item.name || item.snippet_title || "";
    const snippet = item.snippet || item.text || item.summary || "";
    const domain = domainOf(url);

    const isXPost = domain === "x.com" || domain === "twitter.com" || item.is_x_post || item.type === "x_post";
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
        type: isCited ? "cited" : "fetched",
        platformSpecific: {
          isSocialPost: isXPost,
          author: item.author || null,
          likes: item.likes != null ? item.likes : null,
        },
      })
    );
  }

  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const lists = [
      n.web_search_results,
      n.searchResults,
      n.sources,
      n.citations,
      n.x_post_results,
      n.posts,
    ];
    for (const list of lists) {
      if (Array.isArray(list)) list.forEach((item) => addSource(item, true));
    }
  }

  return { sources, socialCitations };
}

function extractFanoutAndThoughts(nodes) {
  const search = [];
  const thoughts = [];
  const seen = new Set();

  const pushQ = (q) => {
    if (typeof q === "string" && q.trim().length > 2 && !seen.has(q.trim())) {
      seen.add(q.trim());
      search.push(q.trim());
    }
  };

  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.queries)) n.queries.forEach(pushQ);
    if (Array.isArray(n.search_queries)) n.search_queries.forEach(pushQ);
    if (typeof n.search_query === "string") pushQ(n.search_query);

    if (typeof n.thought === "string" && n.thought) thoughts.push(n.thought);
    if (typeof n.reasoning === "string" && n.reasoning) thoughts.push(n.reasoning);
  }

  return { search, thoughts };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parseFrames(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const answerText = extractAnswer(nodes);
  const { sources, socialCitations } = extractSources(nodes);
  const { search, thoughts } = extractFanoutAndThoughts(nodes);

  const brandRes = detectBrands(answerText, answerText, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "grok",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://grok.com",
    userPrompt,
    answerText,
    answerChars: answerText.length,
    sources,
    fanout: { search, internal: [] },
    brandMentions,
    entities,
    platformSpecific: {
      adapterVersion: ADAPTER_VERSION,
      socialCitations,
      thoughts: thoughts.length ? thoughts : undefined,
    },
  });
}
