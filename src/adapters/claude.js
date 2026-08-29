/*
 * adapters/claude.js — derive a normalized record from raw Anthropic Claude captures.
 *
 * Normalizes Claude (claude.ai) responses:
 *   - Answer text & model identity (Claude 3.5 / 3.7 Sonnet)
 *   - Web search tool calls & citations (tool_use / tool_result / citations)
 *   - Extended Thinking blocks (Claude 3.7 reasoning traces)
 *   - Artifacts & code generation blocks
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "claude@0.2.0";

function parseEvents(raw) {
  if (!raw || typeof raw !== "string") return [];
  const nodes = [];
  const addNode = (p) => {
    if (!p) return;
    if (Array.isArray(p)) {
      p.forEach((item) => {
        if (item && typeof item === "object") nodes.push(item);
      });
    } else if (typeof p === "object") {
      nodes.push(p);
      if (p.message && typeof p.message === "object") nodes.push(p.message);
    }
  };

  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      addNode(JSON.parse(trimmed));
      if (nodes.length) return nodes;
    } catch (_) {}
  }

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:") && !t.startsWith("{")) continue;
    const payload = t.startsWith("data:") ? t.slice(5).trim() : t;
    if (!payload || payload === "[DONE]") continue;
    try {
      addNode(JSON.parse(payload));
    } catch (_) {}
  }
  return nodes;
}

function extractPrompt(reqBody, nodes) {
  if (reqBody && typeof reqBody === "string") {
    try {
      const parsed = JSON.parse(reqBody);
      if (parsed.prompt && typeof parsed.prompt === "string") return parsed.prompt;
      if (parsed.message && typeof parsed.message === "string") return parsed.message;
      if (parsed.text && typeof parsed.text === "string") return parsed.text;
      if (parsed.query && typeof parsed.query === "string") return parsed.query;
      if (Array.isArray(parsed.messages)) {
        const u = parsed.messages.filter((m) => m.role === "user" || m.sender === "human").pop();
        if (u) {
          if (typeof u.content === "string") return u.content;
          if (typeof u.text === "string") return u.text;
          if (typeof u.message === "string") return u.message;
          if (Array.isArray(u.content)) {
            const txtBlock = u.content.find((b) => b.type === "text" || typeof b === "string");
            if (txtBlock) return typeof txtBlock === "string" ? txtBlock : txtBlock.text;
          }
        }
      }
    } catch (_) {}
  }
  for (const n of nodes) {
    if (n && typeof n === "object") {
      if (typeof n.prompt === "string" && n.prompt) return n.prompt;
      if (n.sender === "human" && typeof n.message === "string" && n.message) return n.message;
    }
  }
  return "";
}

function extractModel(reqBody, nodes) {
  if (reqBody && typeof reqBody === "string") {
    try {
      const parsed = JSON.parse(reqBody);
      if (typeof parsed.model === "string" && parsed.model) return parsed.model;
    } catch (_) {}
  }
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.model === "string" && n.model) return n.model;
    if (n.message && typeof n.message.model === "string" && n.message.model) return n.message.model;
  }
  return "claude-3-7-sonnet";
}

function extractContentAndThinking(nodes) {
  let answer = "";
  let thinking = "";
  const searches = [];
  const sources = [];
  const seenUrls = new Set();

  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;

    // Standard completion text
    if (typeof n.completion === "string") answer += n.completion;

    // Delta stream events (content_block_delta, message_delta)
    if (n.type === "content_block_delta" && n.delta) {
      if (n.delta.type === "text_delta" && typeof n.delta.text === "string") {
        answer += n.delta.text;
      } else if (n.delta.type === "thinking_delta" && typeof n.delta.thinking === "string") {
        thinking += n.delta.thinking;
      }
    }

    // Direct content blocks
    if (Array.isArray(n.content)) {
      for (const block of n.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          answer = block.text.length > answer.length ? block.text : answer;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          thinking += block.thinking;
        } else if (block.type === "tool_use" && (block.name === "web_search" || block.name === "search") && block.input) {
          if (typeof block.input.query === "string") searches.push(block.input.query);
        } else if (block.type === "tool_result" && Array.isArray(block.content)) {
          for (const item of block.content) {
            const url = item.url || item.link;
            if (url && isHttpUrl(url) && !seenUrls.has(url)) {
              seenUrls.add(url);
              sources.push(
                makeSource({
                  url,
                  title: item.title || "",
                  domain: domainOf(url),
                  snippet: item.snippet || item.text || item.content || "",
                  outcome: "cited",
                  type: "citation",
                })
              );
            }
          }
        }
      }
    }

    // Direct citations on message objects
    if (Array.isArray(n.citations)) {
      for (const cit of n.citations) {
        const url = cit.url || cit.link || (cit.metadata && cit.metadata.url);
        if (url && isHttpUrl(url) && !seenUrls.has(url)) {
          seenUrls.add(url);
          sources.push(
            makeSource({
              url,
              title: cit.title || "",
              domain: domainOf(url),
              snippet: cit.cited_text || cit.snippet || "",
              outcome: "cited",
              type: "citation",
            })
          );
        }
      }
    }
  }

  return { answer, thinking, searches, sources };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parseEvents(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const model = extractModel(reqBody, nodes);
  const { answer, thinking, searches, sources } = extractContentAndThinking(nodes);

  const brandRes = detectBrands(answer, answer, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "claude",
    model: model || "claude-3-7-sonnet",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://claude.ai",
    userPrompt,
    answerText: answer,
    answerChars: answer.length,
    searched: sources.length > 0 || searches.length > 0,
    sources,
    fanout: {
      search: searches.map((q) => (typeof q === "string" ? { query: q, search_type: "search" } : q)),
      shopping: [],
      image: [],
    },
    brandMentions,
    entities,
    platformSpecific: {
      adapterVersion: ADAPTER_VERSION,
      thinkingTrace: thinking ? thinking.slice(0, 4000) : undefined,
    },
  });
}
