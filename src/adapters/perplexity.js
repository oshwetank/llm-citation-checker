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

// 0.4.0: extractAnswer() no longer lets an unrelated sidebarRecentThreads
// entry's preview outrank the current query's own preview by raw length
// (matches by title instead, empty rather than a wrong guess when nothing
// matches); citation-footnote tokens ("...clean.\njaquar\n\n") are stripped
// from answerText before brand detection and display, so cited-source
// domains stop being reported as brand mentions. Re-run "Reprocess all
// captures" to apply this to existing captures.
export const ADAPTER_VERSION = "perplexity@0.4.0";

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
    // `sidebarRecentThreads`/`threads` ARE flattened deliberately: on a
    // capture where no other network answer stream ever arrives, this
    // sidebar-history push — a live-updating list of the user's recent
    // threads — is the ONLY source this adapter has for the query's own
    // answer (see test/multi-engine.test.mjs's "GraphQL thread" case,
    // built from a real user capture). The risk this creates — the list
    // also contains OTHER, unrelated threads, each with its own
    // answerPreview — is handled in extractAnswer() below by matching the
    // node's own title against the known query, not by refusing to look at
    // this data at all.
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

// `answerPreview` is deliberately NOT a peer candidate alongside the real
// answer fields below — it's a truncated summary Perplexity generates for a
// thread-LIST entry (the sidebar, thread history), not the model's live
// answer to the query being captured. Treating it as equally-weighted in a
// "longest wins" scan meant an unrelated thread's preview could outrank the
// CURRENT query's own preview by raw length alone. It's tried only as a
// last resort, when no real answer field was found in ANY node.
const REAL_ANSWER_FIELDS = ["text", "answer", "output", "completion", "response", "content", "final_answer"];

// Loose-normalize a title for comparison: lowercase, alphanumerics only.
// The sidebar's thread title and the submitted query are two different
// strings from two different systems (one is Perplexity's own generated
// title, one is what the user typed) — exact string equality is too
// brittle for what should be "obviously the same query".
const normTitle = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function extractAnswer(nodes, userPrompt) {
  let longest = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    for (const field of REAL_ANSWER_FIELDS) {
      const c = n[field];
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
  if (longest) return longest;

  // Fallback tier: `answerPreview`-only nodes, most often the entries of a
  // sidebarRecentThreads push — the user's thread history, which can
  // legitimately contain MULTIPLE unrelated past threads at once, each
  // with its own answerPreview. Confirmed on a real capture: "longest wins"
  // among these picked a completely different, older thread's preview over
  // the current query's own (shorter) preview, because it happened to be
  // longer — reporting that unrelated thread's brands and content as the
  // answer to this query.
  //
  // Only ever return a preview whose OWN title (name/query/user_query)
  // actually matches the query being captured. If nothing matches, return
  // "" rather than guessing via length — an empty answer is a visible,
  // honest miss; a confidently wrong answer attributed to the user's own
  // query is the bug this exists to prevent.
  const promptNorm = normTitle(userPrompt);
  if (!promptNorm) return "";
  let matched = "";
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const title = normTitle(n.name || n.query || n.user_query);
    if (title && title === promptNorm && typeof n.answerPreview === "string" && n.answerPreview.length > matched.length) {
      matched = n.answerPreview;
    }
  }
  return matched;
}

// Perplexity renders each inline citation in the plain-text answer as the
// cited source's bare domain label sitting alone on its own line right
// after the cited sentence, sometimes followed by a "+N" line counting
// additional sources bundled at that same point:
//   "...easy to clean.\nthespruce\n+3\n\n"
//   "...low VOC emissions.\nfamilyhandyman\n+1\n\n"
// These are footnote markers, not brand names — left in place they get
// misdetected as brands by detectBrands's structural heuristics (a bare
// word starting its own paragraph reads exactly like a one-word brand:
// "Nothing", "Oppo"). Confirmed on real captures: jaquar, familyhandyman,
// compositepaint, talkofthehouse, paintdeck, edify, and gadgets360 all
// reached "Brand mentions" as cited-domain false positives this way.
//
// Only two shapes are stripped, both requiring positive evidence the line
// IS a footnote rather than real prose — a bare word is never removed just
// for being short and lowercase:
//   1. The line, alnum-only and lowercased, matches a domain actually cited
//      for THIS answer (from `sources`, which carry a real URL).
//   2. The line is immediately followed by a "+N" line — Perplexity's own
//      "N more sources at this point" marker, which real prose never
//      produces by coincidence.
// A domain cited in prose but never itself present in `sources` (case 2
// alone — e.g. "domino"/"bathfitter" in the real fixture) is cleaned out of
// the brand list this way, but no source entry is fabricated for it: this
// codebase never invents a citation it can't back with a real URL (see
// ai-brands.js's "never invent a mention that isn't really there" rule).
function stripCitationFootnotes(text, sources) {
  if (!text) return text;
  const labels = new Set(
    (sources || [])
      .map((s) => String(s.domain || "").replace(/^www\./, "").split(".")[0].toLowerCase())
      .filter(Boolean)
  );
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\+\d+$/.test(trimmed)) continue; // "+3" sibling-count marker
    const bare = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nextIsCount = /^\+\d+$/.test((lines[i + 1] || "").trim());
    if (bare && bare.length >= 3 && trimmed.length < 40 && !/\s/.test(trimmed) && (labels.has(bare) || nextIsCount)) {
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
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
    const outcome = obj.outcome || (isCited ? "cited" : "fetched");
    sources.push(
      makeSource({
        url,
        title,
        domain,
        snippet,
        outcome,
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

function extractGeneratedTitle(nodes, userPrompt) {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.generatedTitle === "string" && n.generatedTitle && n.generatedTitle !== userPrompt) {
      return n.generatedTitle;
    }
  }
  return null;
}

export async function adapt({ captureId, raw, reqBody, capturedAt, pageUrl }, options = {}) {
  const nodes = parsePayloads(raw);
  const userPrompt = extractPrompt(reqBody, nodes);
  const generatedTitle = extractGeneratedTitle(nodes, userPrompt);
  const model = extractModel(nodes);
  const sources = extractSources(nodes);
  // Clean citation-footnote noise ("...clean.\njaquar\n\n") out of the answer
  // BEFORE brand detection runs, since detectBrands has no way to tell a
  // bare footnote token from a real one-word brand mention on its own line —
  // see stripCitationFootnotes above. Cleaning it out of the returned
  // answerText too (not just a brand-detection-only copy) also fixes the
  // same tokens showing up as visible clutter inline in the rendered answer.
  const answerText = stripCitationFootnotes(extractAnswer(nodes, userPrompt), sources);
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
    generatedTitle,
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
