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

export const ADAPTER_VERSION = "grok@0.3.0";

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

/* grok.com's WebSocket gateway (wss://grok.com/ws/mgw/).
 *
 * grok.com moved its web text chat off the REST stream this adapter was
 * written for (rest/app-chat/conversations/new) onto a WebSocket gateway. Two
 * independent open-source bridges for authenticated grok.com sessions
 * document it: anojndr/grok.com-to-openai (grok_gateway.py) and the
 * "Align Grok web chat with grok2api Gateway websocket" change in
 * stabey/Aether-upstream-fork ("REST conversations/new is no longer used for
 * text chat"). Every frame is an envelope {session_id?, event: {type, ...}}:
 *
 *   sent:     conversation.item.create  item.x_grok.input_chunks[].text.text
 *             response.create
 *   received: response.chunk            chunk.text.{text, channel}
 *             response.output_text.delta / response.reasoning_text.delta
 *             response.grok.output      output.{tool_usage_card, stream_error}
 *             response.search.result    result.{web_results|webpages|results}
 *             response.done             response.status
 *
 * None of that has a top-level message/token field, so every gateway capture
 * read as empty and was dropped as "0-signal" — Grok recorded nothing at all
 * in any campaign. The frames are folded into ONE node in the REST shape the
 * rest of this file already reads (message, cardAttachmentsJson,
 * webSearchResults, queries), so answer text, citation markers, sources and
 * fan-out all go through the same, already-tested code as before.
 */
const GW_RESULT_KEYS = ["web_results", "webSearch_results", "webpages", "results"];
const GW_WEB_SEARCH_KEYS = ["webpages", "results", "web_results"];
const GW_TOOL_KEYS = ["web_search_results", "web_results", "webpages", "results"];

const isGatewayFrame = (n) =>
  !!(n && typeof n === "object" && n.event && typeof n.event === "object" && typeof n.event.type === "string");

// The prompt text of a conversation.item.create (the frame the page SENT),
// or of the server's echo of it. Chunks are concatenated in order; a
// file-mention chunk has no text and contributes nothing.
function gatewayItemText(item) {
  if (!item || typeof item !== "object") return "";
  const chunks = item.x_grok && item.x_grok.input_chunks;
  if (Array.isArray(chunks)) {
    return chunks.map((c) => (c && c.text && typeof c.text.text === "string" ? c.text.text : "")).join("").trim();
  }
  if (Array.isArray(item.content)) {
    return item.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("").trim();
  }
  return "";
}

function gatewayPrompt(reqBody, frames) {
  if (reqBody && typeof reqBody === "string") {
    try {
      const p = JSON.parse(reqBody);
      const text = gatewayItemText(p && p.event && p.event.item);
      if (text) return text;
    } catch (_) {}
  }
  for (const f of frames) {
    const ev = f.event;
    if (ev.type === "conversation.item.added" && ev.item && ev.item.role === "user") {
      const text = gatewayItemText(ev.item);
      if (text) return text;
    }
  }
  return "";
}

function gatewayCardQuery(card) {
  const ws = card && typeof card === "object" && card.web_search;
  if (!ws || typeof ws !== "object") return null;
  const q = ws.args && typeof ws.args.query === "string" ? ws.args.query : ws.query;
  return typeof q === "string" && q.trim() ? q.trim() : null;
}

function readGateway(nodes, reqBody) {
  const frames = nodes.filter(isGatewayFrame);
  if (!frames.length) return null;

  const chunkText = [];
  const deltaText = [];
  const thoughts = [];
  const queries = [];
  const cards = [];
  const results = [];
  let status = null;
  let error = null;
  let model = null;

  const addList = (list, sink) => {
    if (!Array.isArray(list)) return;
    for (const it of list) if (it && typeof it === "object" && typeof it.url === "string") sink.push(it);
  };
  // Where the bridges find citations: the envelope, its event, and each of
  // those's output/chunk — card attachments (the inline citation cards the
  // answer's <grok:render> tags point at), search results, and tool results.
  const scan = (c) => {
    if (!c || typeof c !== "object") return;
    if (c.card_attachment && typeof c.card_attachment === "object") addList([c.card_attachment], cards);
    if (c.result && typeof c.result === "object") for (const k of GW_RESULT_KEYS) addList(c.result[k], results);
    const tr = c.tool_result;
    if (tr && typeof tr === "object") {
      if (tr.web_search && typeof tr.web_search === "object") for (const k of GW_WEB_SEARCH_KEYS) addList(tr.web_search[k], results);
      for (const k of GW_TOOL_KEYS) addList(tr[k], results);
    }
  };

  for (const f of frames) {
    const ev = f.event;
    for (const c of [f, f.output, f.chunk, ev, ev.output, ev.chunk]) scan(c);
    for (const holder of [ev.chunk, ev.output]) {
      const q = holder && gatewayCardQuery(holder.tool_usage_card);
      if (q) queries.push(q);
    }
    if (ev.type === "response.chunk") {
      const info = (ev.chunk && ev.chunk.text) || {};
      const value = typeof info.text === "string" ? info.text : "";
      const channel = String(info.channel || "");
      if (!value || channel.includes("NOTETAKER_HEADER")) continue; // title chrome, not answer
      if (channel.includes("THINKING") || channel.includes("NOTETAKER")) thoughts.push(value);
      else chunkText.push(value);
    } else if (ev.type === "response.output_text.delta") {
      if (typeof ev.delta === "string") deltaText.push(ev.delta);
    } else if (ev.type === "response.reasoning_text.delta") {
      if (typeof ev.delta === "string") thoughts.push(ev.delta);
    } else if (ev.type === "response.grok.output") {
      const se = ev.output && ev.output.stream_error;
      if (se && typeof se === "object") error = String(se.kind || se.message || "stream_error").slice(0, 60);
    } else if (ev.type === "response.done") {
      const r = ev.response || {};
      status = typeof r.status === "string" ? r.status : "completed";
      if (typeof r.model === "string" && r.model) model = r.model;
    } else if (ev.type === "error") {
      const e = ev.error || {};
      error = String(e.code || e.type || e.message || "error").slice(0, 60);
    } else if (ev.type === "session.created" && ev.session && typeof ev.session.model === "string") {
      model = model || ev.session.model;
    }
  }

  // The chunk and delta channels carry the same answer on different gateway
  // builds; the bridge that reads both would double the text if a build ever
  // sent both, so one is used — chunks when there are any.
  const message = (chunkText.length ? chunkText : deltaText).join("");
  const node = {
    sender: "assistant",
    message,
    cardAttachmentsJson: cards,
    webSearchResults: results,
    queries,
  };
  if (model) node.model = model;
  if (thoughts.length) node.thought = thoughts.join("");
  return {
    node,
    prompt: gatewayPrompt(reqBody, frames),
    status,
    error,
    eventTypes: [...new Set(frames.map((f) => f.event.type))].slice(0, 12),
  };
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

/* A copy content-iso.js read off the page's text (harvestSource "dom").
 * Until 0.62.1 grok.com's user message carried a hidden "You" label that the
 * reader took as part of the prompt ("Youbest good quality…"), and the answer
 * opened with Grok's own "## Grok / Worked for 19s" lines. Copies made since
 * are cleaned at the source and say so (promptClean); older ones are cleaned
 * here, so a reprocess repairs what's already stored. */
const GROK_UI_LINE = /^(?:#{1,3}\s*)?(?:Grok|(?:Worked|Thought|Thinking) for \d+(?:\.\d+)?\s*s(?:econds?)?)\s*$/i;
export function cleanPageCopy({ prompt, answer, promptClean }) {
  let p = String(prompt || "").trim();
  if (!promptClean) p = p.replace(/^You(?=\S)/, "").trim();
  const lines = String(answer || "").split("\n");
  while (lines.length && (!lines[0].trim() || GROK_UI_LINE.test(lines[0].trim()))) lines.shift();
  return { prompt: p, answer: lines.join("\n").trim() };
}

/* Grok's own word that a turn failed, in the REST copy (1.0.2). A live run on
 * 22 Nov 2026 reached the free tier's limit after 10 prompts: every later
 * turn was stored twice as an empty answer that "didn't search" — once from
 * the gateway (which already said usage_limit_reached) and once from
 * /load-responses, which carries the same thing as
 * streamErrors: [{ message: "You've reached your usage limit…",
 * usageLimitReached: {…} }] and was read as an ordinary empty answer. */
export function restStreamError(nodes) {
  let found = null;
  const walk = (v, depth) => {
    if (found || !v || typeof v !== "object" || depth > 5) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const key of ["streamErrors", "stream_errors"]) {
      const list = v[key];
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || typeof e !== "object") continue;
        if (e.usageLimitReached || e.usage_limit_reached) { found = "usage_limit_reached"; return; }
        if (!found && typeof e.message === "string" && e.message) found = `stream_error: ${e.message.slice(0, 120)}`;
      }
    }
    for (const k of Object.keys(v)) if (k !== "streamErrors" && k !== "stream_errors") walk(v[k], depth + 1);
  };
  walk(nodes, 0);
  return found;
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const frames = parseFrames(raw);
  const gateway = readGateway(frames, reqBody);
  // A gateway capture is read through its folded node alone: the raw
  // envelopes carry nothing the REST readers below understand.
  const nodes = gateway ? [gateway.node] : frames;
  const pageCopy = !gateway && frames.length === 1 && frames[0] && frames[0].harvestSource === "dom";
  if (pageCopy) {
    const c = cleanPageCopy({ prompt: frames[0].query, answer: frames[0].text, promptClean: frames[0].promptClean });
    nodes[0] = { ...frames[0], query: c.prompt, text: c.answer };
    reqBody = JSON.stringify({ query: c.prompt });
  }
  const userPrompt = (gateway && gateway.prompt) || extractPrompt(reqBody, nodes);
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
  const brandRes = detectBrands(textForDetection, textForDetection, { sources, tracked: options.tracked, prompt: userPrompt });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];
  // Only a turn that produced no answer is a refusal: an error after some
  // text leaves that text as the answer.
  const restError = !gateway && !answerText ? restStreamError(nodes) : null;

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
      transport: gateway ? "gateway" : pageCopy ? "page" : "rest",
      pageCopy: pageCopy || undefined,
      gatewayStatus: gateway ? gateway.status : undefined,
      gatewayError: gateway && gateway.error ? gateway.error : restError || undefined,
      gatewayEvents: gateway ? gateway.eventTypes : undefined,
    },
  });
}
