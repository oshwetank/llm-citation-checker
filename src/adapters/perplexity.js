/*
 * adapters/perplexity.js — derive a normalized record from raw Perplexity AI captures.
 *
 * Normalizes Perplexity web SSE / REST / Socket.IO / GraphQL WebSocket responses:
 *   - Answer text & citation markers ([1], [2] footnotes)
 *   - GraphQL thread entries, answerPreview, and live stream deltas
 *   - Model identity (sonar, sonar-pro, sonar-reasoning, etc.)
 *   - Search sources (web_results, search_results, chunks, sources, context)
 *   - Query Plan sub-searches (query_plan, queries, sub_queries)
 *   - Follow-up related queries (related_queries)
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "perplexity@0.3.0";

function extractJsonPayload(line) {
  const t = line.trim();
  if (t.startsWith("data:")) return t.slice(5).trim();
  const m = t.match(/^4[0-9]+(?:[\/\w-]+,)?(\[.*\]|\{.*\})$/);
  if (m) return m[1];
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) return t;
  return null;
}

function parsePayloads(raw) {
  if (!raw || typeof raw !== "string") return [];
  const nodes = [];

  const addParsed = (p) => {
    if (!p) return;
    if (Array.isArray(p)) {
      p.forEach((item) => {
        if (item && typeof item === "object") addParsed(item);
      });
      return;
    }
    if (typeof p !== "object") return;
    nodes.push(p);

    // Flatten nested arrays and GraphQL/Relay shapes
    if (p.payload && typeof p.payload === "object") addParsed(p.payload);
    if (p.data && typeof p.data === "object") addParsed(p.data);
    if (p.sidebarRecentThreads && typeof p.sidebarRecentThreads === "object") addParsed(p.sidebarRecentThreads);
    if (p.threads && typeof p.threads === "object") addParsed(p.threads);
    if (Array.isArray(p.edges)) {
      p.edges.forEach((edge) => {
        if (edge && edge.node) addParsed(edge.node);
      });
    }
    if (p.node && typeof p.node === "object") addParsed(p.node);
    if (p.threadEntry && typeof p.threadEntry === "object") addParsed(p.threadEntry);
    if (Array.isArray(p.messages)) addParsed(p.messages);
    if (Array.isArray(p.blocks)) addParsed(p.blocks);
    if (Array.isArray(p.entries)) addParsed(p.entries);
    if (p.entry && typeof p.entry === "object") addParsed(p.entry);
  };

  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      addParsed(JSON.parse(trimmed));
      if (nodes.length) return nodes;
    } catch (_) {}
  }
  for (const line of raw.split(/\r?\n/)) {
    const payload = extractJsonPayload(line);
    if (!payload || payload === "[DONE]") continue;
    try {
      addParsed(JSON.parse(payload));
    } catch (_) {}
  }
  return nodes;
}

function extractPrompt(reqBody, nodes) {
  if (reqBody && typeof reqBody === "string") {
    try {
      let raw = reqBody.trim();
      const m = raw.match(/^4[0-9]+(?:[\/\w-]+,)?(\[.*\]|\{.*\})$/);
      if (m) raw = m[1];
      else if (raw.startsWith("42[")) raw = raw.slice(2);
      const parsed = JSON.parse(raw);

      // Check direct properties
      if (parsed.query && typeof parsed.query === "string" && parsed.query.length > 1) return parsed.query;
      if (parsed.message && typeof parsed.message === "string") return parsed.message;
      if (parsed.text && typeof parsed.text === "string") return parsed.text;
      if (parsed.prompt && typeof parsed.prompt === "string") return parsed.prompt;

      // Check GraphQL variables
      if (parsed.variables && typeof parsed.variables === "object") {
        if (parsed.variables.query && typeof parsed.variables.query === "string") return parsed.variables.query;
        if (parsed.variables.message && typeof parsed.variables.message === "string") return parsed.variables.message;
        if (parsed.variables.prompt && typeof parsed.variables.prompt === "string") return parsed.variables.prompt;
        if (parsed.variables.text && typeof parsed.variables.text === "string") return parsed.variables.text;
      }
      if (parsed.payload && typeof parsed.payload === "object") {
        if (parsed.payload.variables && typeof parsed.payload.variables === "object") {
          if (parsed.payload.variables.query && typeof parsed.payload.variables.query === "string") return parsed.payload.variables.query;
          if (parsed.payload.variables.message && typeof parsed.payload.variables.message === "string") return parsed.payload.variables.message;
        }
      }

      if (parsed.params && parsed.params.query && typeof parsed.params.query === "string") return parsed.params.query;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            if (item.query && typeof item.query === "string") return item.query;
            if (item.text && typeof item.text === "string") return item.text;
            if (item.message && typeof item.message === "string") return item.message;
          }
        }
      }
      if (Array.isArray(parsed.messages)) {
        const lastUser = parsed.messages.filter((m) => m.role === "user" || m.sender === "user" || m.sender === "human").pop();
        if (lastUser && lastUser.content) {
          return typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
        }
      }
    } catch (_) {}
  }

  // Fallback: extract prompt from node fields (e.g. node.name or node.query in GraphQL responses)
  for (const node of nodes) {
    if (node && typeof node === "object") {
      if (typeof node.query === "string" && node.query.length > 2) return node.query;
      if (typeof node.user_query === "string" && node.user_query.length > 2) return node.user_query;
      if (typeof node.prompt === "string" && node.prompt.length > 2) return node.prompt;
      // In GraphQL thread edge nodes, `name` is the user query title!
      if (typeof node.name === "string" && node.name.length > 2 && (node.answerPreview || node.status)) {
        return node.name;
      }
    }
  }
  return "";
}

function extractModel(nodes) {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.model === "string" && n.model) return n.model;
    if (typeof n.display_model === "string" && n.display_model) return n.display_model;
    if (typeof n.search_model === "string" && n.search_model) return n.search_model;
  }
  return "sonar";
}

function extractAnswer(nodes) {
  let longest = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const candidates = [
      n.text,
      n.answer,
      n.answerPreview,
      n.output,
      n.completion,
      n.response,
      n.content,
      n.final_answer,
    ];
    for (const c of candidates) {
      if (typeof c === "string") {
        let clean = c;
        if (c.startsWith("{") && c.endsWith("}")) {
          try {
            const parsed = JSON.parse(c);
            if (parsed.answer && typeof parsed.answer === "string") clean = parsed.answer;
            else if (parsed.text && typeof parsed.text === "string") clean = parsed.text;
          } catch (_) {}
        }
        if (clean.length > longest.length) longest = clean;
      }
    }
  }
  return longest;
}

function extractSources(nodes) {
  const sources = [];
  const seenUrls = new Set();
  function addSource(obj, isCited = true) {
    if (!obj || typeof obj !== "object") return;
    const url = obj.url || obj.link || obj.page_url || obj.uri;
    if (!url || !isHttpUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);
    const title = obj.name || obj.title || obj.headline || "";
    const snippet = obj.snippet || obj.text || obj.extract || obj.content || obj.preview || "";
    const domain = domainOf(url);
    sources.push(
      makeSource({
        url,
        title,
        domain,
        snippet,
        outcome: isCited ? "cited" : "fetched",
        type: "citation",
        platformSpecific: {
          queryPlanQuery: obj.query || null,
          sourceIndex: obj.index != null ? obj.index : null,
        },
      })
    );
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const lists = [
      n.web_results,
      n.sources,
      n.search_results,
      n.searchResults,
      n.results,
      n.citations,
      n.chunks,
      n.context,
    ];
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
      search.push({ query: q.trim(), search_type: "search" });
    }
  };
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n.related_queries)) n.related_queries.forEach(pushQ);
    if (Array.isArray(n.queries)) n.queries.forEach(pushQ);
    if (Array.isArray(n.sub_queries)) n.sub_queries.forEach(pushQ);
    if (Array.isArray(n.query_plan)) {
      n.query_plan.forEach((qp) => {
        if (qp && qp.query) pushQ(qp.query);
      });
    }
  }
  return { search, shopping: [], image: [] };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parsePayloads(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const model = extractModel(nodes);
  const answerText = extractAnswer(nodes);
  const sources = extractSources(nodes);
  const fanout = extractFanout(nodes);
  const brandRes = detectBrands(answerText, answerText, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "perplexity",
    model: model || "sonar",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://www.perplexity.ai",
    userPrompt,
    answerText,
    answerChars: answerText.length,
    searched: sources.length > 0 || fanout.search.length > 0,
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
