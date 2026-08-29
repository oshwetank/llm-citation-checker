/*
 * adapters/claude.js — derive a normalized record from raw Anthropic Claude captures.
 *
 * Normalizes Claude (claude.ai) responses:
 *   - Answer text & model identity (Claude 3.5 / 3.7 Sonnet)
 *   - Web search tool calls & citations (tool_use / tool_result)
 *   - Extended Thinking blocks (Claude 3.7 reasoning traces)
 *   - Artifacts & code generation blocks
 *   - Brand & entity mentions
 */

import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const ADAPTER_VERSION = "claude@0.1.0";

function parseEvents(raw) {
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
      if (parsed.prompt) return parsed.prompt;
      if (Array.isArray(parsed.messages)) {
        const u = parsed.messages.filter((m) => m.role === "user" || m.sender === "human").pop();
        if (u) {
          if (typeof u.content === "string") return u.content;
          if (Array.isArray(u.content)) {
            const txtBlock = u.content.find((b) => b.type === "text" || typeof b === "string");
            if (txtBlock) return typeof txtBlock === "string" ? txtBlock : txtBlock.text;
          }
        }
      }
    } catch (_) {}
  }
  for (const n of nodes) {
    if (n && typeof n === "object" && n.prompt) return n.prompt;
  }
  return "";
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
        } else if (block.type === "tool_use" && block.name === "web_search" && block.input) {
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
                  snippet: item.snippet || item.text || "",
                  outcome: "cited",
                  type: "citation",
                })
              );
            }
          }
        }
      }
    }
  }

  return { answer, thinking, searches, sources };
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parseEvents(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const { answer, thinking, searches, sources } = extractContentAndThinking(nodes);

  const brandRes = detectBrands(answer, answer, { sources, tracked: options.tracked });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "claude",
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://claude.ai",
    userPrompt,
    answerText: answer,
    answerChars: answer.length,
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
