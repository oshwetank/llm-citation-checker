/*
 * adapters/perplexity.js — derive a normalized record from raw Perplexity AI captures.
 *
 * Normalizes Perplexity web SSE/REST responses:
 *   - Answer text & citation markers ([1], [2] footnotes)
 *   - Search sources (web_results, search_results, chunks)
 *   - Query Plan sub-searches (query_plan)
 *   - Follow-up related queries (related_queries)
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "perplexity@0.1.0";

function parsePayloads(raw) {
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
    if (!t.startsWith("data:") && !t.startsWith("42[")) continue;
    let payload = t;
    if (t.startsWith("data:")) payload = t.slice(5).trim();
    else if (t.startsWith("42[")) payload = t.slice(2).trim();
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
      if (parsed.query) return parsed.query;
      if (parsed.message) return parsed.message;
      if (Array.isArray(parsed.messages)) {
        const lastUser = parsed.messages.filter((m) => m.role === "user").pop();
        if (lastUser && lastUser.content) return typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
      }
    } catch (_) {}
  }
  for (const node of nodes) {
    if (node && typeof node === "object") {
      if (typeof node.query === "string" && node.query) return node.query;
      if (typeof node.user_query === "string" && node.user_query) return node.user_query;
    }
  }
  return "";
}

function extractAnswer(nodes) {
  let longest = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const candidates = [n.text, n.answer, n.output, n.completion, n.response];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > longest.length) longest = c;
    }
  }
  return longest;
}

function extractSources(nodes) {
  const sources = [];
  const seenUrls = new Set();
  function addSource(obj, isCited = true) {
    if (!obj || typeof obj !== "object") return;
    const url = obj.url || obj.link || obj.page_url;
    if (!url || !isHttpUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);
    const title = obj.name || obj.title || obj.headline || "";
    const snippet = obj.snippet || obj.text || obj.extract || "";
    const domain = domainOf(url);
    sources.push(
      makeSource({
        url,
        title,
        domain,
        snippet,
        type: isCited ? "cited" : "fetched",
        platformSpecific: {
          queryPlanQuery: obj.query || null,
          sourceIndex: obj.index != null ? obj.index : null,
        },
      })
    );
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const lists = [n.web_results, n.sources, n.search_results, n.results, n.citations];
    for (const list of lists) {
      if (Array.isArray(list)) {
        list.forEach((item) => addSource(item, true));
      }
    }
    if (Array.isArray(n.query_plan)) {
      for (const qp of n.query_plan) {
        if (Array.isArray(qp.results)) {
          qp.results.forEach((item) => addSource({ ...item, query: qp.query }, true));
        }
      }
    }
  }
  return sources;
}

function extractFanout(nodes) {
  const search = [];
  const seen = new Set();
  const pushQ = (q) => {
    if (typeof q === "string" && q.trim().length > 2 && !seen.has(q.trim())) {
      seen.add(q.trim());
      search.push(q.trim());
    }
  };
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.related_queries)) n.related_queries.forEach(pushQ);
    if (Array.isArray(n.queries)) n.queries.forEach(pushQ);
    if (Array.isArray(n.query_plan)) {
      n.query_plan.forEach((qp) => {
        if (qp && qp.query) pushQ(qp.query);
      });
    }
  }
  return { search, internal: [] };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parsePayloads(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const answerText = extractAnswer(nodes);
  const sources = extractSources(nodes);
  const fanout = extractFanout(nodes);
  const brandRes = detectBrands(answerText, answerText, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "perplexity",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://www.perplexity.ai",
    userPrompt,
    answerText,
    answerChars: answerText.length,
    sources,
    fanout,
    brandMentions,
    entities,
    platformSpecific: {
      adapterVersion: ADAPTER_VERSION,
      nodeCount: nodes.length,
    },
  });
}
