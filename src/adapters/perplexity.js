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
// 0.4.1: records say where their answer came from (platformSpecific.
// answerSource / previewUpdatedAt), so a campaign run can refuse a thread-
// list preview that belongs to another tab's prompt or to an earlier run.
export const ADAPTER_VERSION = "perplexity@0.5.0";

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

/* Perplexity's current answer stream (/rest/sse/perplexity_ask).
 *
 * Each SSE event carries ids and flags (backend_uuid, display_model,
 * text_completed, final_sse_message...) and a `blocks` array; the answer is
 * no longer in a top-level field. A real v0.42 run logged every one of these
 * streams as unreadable — 150-430 KB answers, captured and then dropped as
 * 0-signal — so Perplexity results came only from the slower DOM harvest.
 * The block shapes follow henrique-coder/perplexity-webui-scraper
 * (core/parser.py), a maintained client of the same endpoint:
 *
 *   markdown_block    { chunks[], chunk_starting_offset, answer }
 *                     chunks land at their offset; offset 0 starts over
 *   workflow_block    { steps[].items[].payload.text_payload.{text,chunks} }
 *   diff_block        { patches[] } JSON Patch (add/replace/remove) against
 *                     the last workflow_block
 *   web_result_block  { web_results[]: {name, snippet, url} }
 *
 * The request body is {params, query_str}. Inline citations are [n], a
 * 1-based index into web_results; they become the [[cite:URL]] marker the
 * DOM harvester writes, and only sources the answer cites are "cited" — the
 * rest were fetched. As with Grok, the stream is folded into one node in
 * the shape the readers below already understand.
 */
function applyJsonPatch(doc, op) {
  if (!op || typeof op !== "object" || typeof op.path !== "string" || !op.path.startsWith("/")) return;
  const tokens = op.path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target = doc;
  for (const t of tokens.slice(0, -1)) {
    target = Array.isArray(target) ? target[Number(t)] : target && target[t];
    if (!target || typeof target !== "object") return;
  }
  const key = tokens[tokens.length - 1];
  if (Array.isArray(target)) {
    const i = key === "-" ? target.length : Number(key);
    if (!Number.isInteger(i) || i < 0) return;
    if (op.op === "add") target.splice(i, 0, op.value);
    else if (op.op === "replace") target[i] = op.value;
    else if (op.op === "remove") target.splice(i, 1);
  } else if (op.op === "add" || op.op === "replace") target[key] = op.value;
  else if (op.op === "remove") delete target[key];
}

const longer = (a, b) => (String(b || "").length > String(a || "").length ? String(b) : String(a || ""));

function workflowText(workflow) {
  let best = "";
  for (const step of Array.isArray(workflow && workflow.steps) ? workflow.steps : []) {
    for (const item of Array.isArray(step && step.items) ? step.items : []) {
      const tp = item && item.payload && item.payload.text_payload;
      if (!tp || typeof tp !== "object") continue;
      const chunks = Array.isArray(tp.chunks) ? tp.chunks.filter((c) => c != null).map(String).join("") : "";
      best = longer(best, longer(typeof tp.text === "string" ? tp.text : "", chunks));
    }
  }
  return best;
}

// Search queries, wherever a block lists them: arrays under "queries" or
// "search_queries" holding strings or {query}. Not "related_queries" — those
// are follow-up suggestions, not what the engine searched.
function collectQueries(value, out, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) { value.forEach((v) => collectQueries(v, out, depth + 1)); return; }
  for (const [k, v] of Object.entries(value)) {
    if ((k === "queries" || k === "search_queries") && Array.isArray(v)) {
      for (const q of v) {
        if (typeof q === "string") out.push(q);
        else if (q && typeof q.query === "string") out.push(q.query);
      }
    } else if (k !== "related_queries" && v && typeof v === "object") collectQueries(v, out, depth + 1);
  }
}

function readBlockStream(nodes) {
  const events = nodes.filter((n) => n && typeof n === "object" && Array.isArray(n.blocks));
  if (!events.length) return null;
  let md = [];
  let mdAnswer = "";
  let workflow = null;
  let results = [];
  const queries = [];
  let prompt = "";
  let model = null;
  let final = false;
  for (const ev of events) {
    if (!prompt && typeof ev.query_str === "string") prompt = ev.query_str;
    if (!model && typeof ev.display_model === "string" && ev.display_model) model = ev.display_model;
    if (ev.text_completed || ev.final_sse_message || ev.final) final = true;
    for (const b of ev.blocks) {
      if (!b || typeof b !== "object") continue;
      const mb = b.markdown_block;
      if (mb && typeof mb === "object") {
        if (Array.isArray(mb.chunks)) {
          const off = Number.isInteger(mb.chunk_starting_offset) && mb.chunk_starting_offset >= 0 ? mb.chunk_starting_offset : 0;
          if (off === 0) md = [];
          while (md.length < off) md.push("");
          mb.chunks.forEach((c, i) => { md[off + i] = c == null ? "" : String(c); });
        }
        if (typeof mb.answer === "string") mdAnswer = longer(mdAnswer, mb.answer);
      }
      if (b.workflow_block && typeof b.workflow_block === "object") {
        try { workflow = structuredClone(b.workflow_block); } catch (_) { workflow = null; }
      }
      if (b.diff_block && workflow && Array.isArray(b.diff_block.patches)) {
        for (const op of b.diff_block.patches) { try { applyJsonPatch(workflow, op); } catch (_) { /* skip a patch that doesn't fit */ } }
      }
      const wr = b.web_result_block;
      if (wr && Array.isArray(wr.web_results)) results = wr.web_results.filter((r) => r && typeof r === "object");
      const { workflow_block: _w, diff_block: _d, markdown_block: _m, web_result_block: _r, ...rest } = b;
      collectQueries(rest, queries);
    }
  }
  // A workflow step names its tool. "fetch_url" is Perplexity opening one
  // address directly; its "queries" item holds that address, which used to
  // be listed as a search ("https://www.bajajfinserv.in/…" among the
  // searches, 0.62.0 feedback). Those go to opened; every other step's
  // queries are searches as before.
  const opened = [];
  if (workflow) {
    for (const step of Array.isArray(workflow.steps) ? workflow.steps : []) {
      if (step && step.tool_name === "fetch_url") {
        const got = [];
        collectQueries(step, got);
        got.filter((u) => isHttpUrl(u) && !opened.includes(u)).forEach((u) => opened.push(u));
      } else collectQueries(step, queries);
    }
    const { steps: _s, ...restOfWorkflow } = workflow;
    collectQueries(restOfWorkflow, queries);
  }

  let text = longer(md.join(""), mdAnswer);
  const answerBlock = !!text;
  if (!text && workflow) text = workflowText(workflow);
  /*
   * Perplexity's wall for someone not signed in (1.0.0). The owner's
   * private-window campaign of 15 Nov 2026 stored 133 of 139 Perplexity turns
   * as answers that read only "Sign up and repeat your request." (and
   * "Daftar dan ulangi permintaan Anda.", "Înscrie-te și repetă-ți cererea.",
   * "Iscriviti e ripeti la richiesta." — it follows the account's language,
   * so it can't be matched by its words). Every one had the same shape: no
   * answer block at all, the text only in a workflow step, no search results
   * and no searches, one short sentence. Such a reply is not an answer: the
   * adapter flags it as a limit, so a campaign pauses Perplexity and asks
   * again, and it is never counted as an answer that named nobody.
   */
  const refusal = !answerBlock && !!text && results.length === 0 && queries.length === 0
    && text.trim().length <= 120 && !/\n\s*\S/.test(text.trim()) && final;

  const cited = new Set();
  text = text.replace(/\[(\d{1,2})\]/g, (whole, n) => {
    const r = results[Number(n) - 1];
    const url = r && typeof r.url === "string" ? r.url : null;
    if (!url || !isHttpUrl(url)) return whole;
    cited.add(url);
    return `[[cite:${url}]]`;
  });
  return {
    node: {
      answer: text,
      web_results: results.map((r) => ({ ...r, outcome: cited.has(r.url) ? "cited" : "fetched" })),
      queries,
      opened,
      query_str: prompt,
      display_model: model,
    },
    prompt,
    final,
    refusal: refusal ? text.trim() : null,
  };
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
      if (typeof parsed.query_str === "string" && parsed.query_str.length > 1) return parsed.query_str;
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
  // NULL, not a made-up "sonar". Perplexity captures come from the DOM
  // harvester (see the research note in this repo's history: of 20 fields
  // this adapter can extract, only query/text/web_results ever arrive), so
  // no model field is present on the overwhelming majority of real
  // captures — and this used to answer "sonar" for every single one of
  // them regardless. That is fabricated provenance in a tool whose whole
  // job is reporting what an engine actually did: a reader cannot tell a
  // genuinely-reported sonar from a guess. Unknown is reported as unknown.
  return null;
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

// `info`, when passed, is told where the answer came from — "real" (a live
// answer field), "preview" (a thread-list entry's answerPreview, with that
// thread's updatedAt), or "none". A preview is a truncated summary of some
// thread in the user's ACCOUNT-WIDE history, so whoever consumes the record
// may need to judge whether that thread is really the one being captured —
// see isUnusableCampaignPreview in background.js.
function extractAnswer(nodes, userPrompt, info = {}) {
  info.source = "none";
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
  if (longest) { info.source = "real"; return longest; }

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
  let matchedAt = null;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const title = normTitle(n.name || n.query || n.user_query);
    if (title && title === promptNorm && typeof n.answerPreview === "string" && n.answerPreview.length > matched.length) {
      matched = n.answerPreview;
      matchedAt = typeof n.updatedAt === "string" ? n.updatedAt : null;
    }
  }
  if (matched) { info.source = "preview"; info.updatedAt = matchedAt; }
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

// The DOM harvester (content-iso.js) writes inline citation markers as
// [[cite:https://full/url]] — NOT the bare-footnote-token shape
// stripCitationFootnotes above handles, and never stripped anywhere before
// this. So the raw URL sat right there in the text detectBrands() scans for
// mentions, and a cited-domain candidate ("mobileburn.com" -> "Mobileburn")
// trivially "found itself" inside its own citation marker every single time
// — reported as a real brand mention (with a bogus count matching how many
// times that domain was cited, and a "cited for X" pulled from whatever
// prose happened to sit nearby), for review/listicle sites the SAME
// EDITORIAL_DOMAINS exclusion in brands.js already exists to keep out.
// Kept OUT of stripCitationFootnotes and the stored/returned answerText —
// exportDoc.js's PPLX_CITE_RE relies on these markers surviving there to
// render numbered footnotes at export time. This is a detection-only copy.
const PPLX_CITE_RE = /\[\[cite:https?:\/\/[^\]\s]+\]\]/g;
function stripCiteMarkersForDetection(text) {
  return text ? text.replace(PPLX_CITE_RE, "") : text;
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
          // Perplexity's own "Trusted domain" shield, harvested from the
          // inline citation markup. No other engine this tool supports
          // publishes a per-source trust judgement, so it's carried through
          // rather than dropped — it's exactly the kind of engine-specific
          // signal worth surfacing instead of flattening every platform
          // into a shared lowest common denominator.
          trusted: obj.trusted === true ? true : null,
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
  // Addresses it opened directly (readBlockStream), not searches.
  const opened = [...new Set(nodes.flatMap((n) => (n && Array.isArray(n.opened) ? n.opened : [])))].map((url) => ({ url }));
  return { search, shopping: [], image: [], ...(opened.length ? { opened } : {}) };
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
  const parsed = parsePayloads(raw);
  const stream = readBlockStream(parsed);
  // A block-stream capture is read through its folded node alone — see
  // readBlockStream. Everything else goes through the readers as before.
  const nodes = stream ? [stream.node] : parsed;
  const userPrompt = extractPrompt(reqBody, nodes) || (stream && stream.prompt) || "";
  const generatedTitle = extractGeneratedTitle(nodes, userPrompt);
  const model = extractModel(nodes);
  const sources = extractSources(nodes);
  // Clean citation-footnote noise ("...clean.\njaquar\n\n") out of the answer
  // BEFORE brand detection runs, since detectBrands has no way to tell a
  // bare footnote token from a real one-word brand mention on its own line —
  // see stripCitationFootnotes above. Cleaning it out of the returned
  // answerText too (not just a brand-detection-only copy) also fixes the
  // same tokens showing up as visible clutter inline in the rendered answer.
  const answerInfo = {};
  const refusal = stream && stream.refusal;
  const answerText = refusal ? "" : stripCitationFootnotes(extractAnswer(nodes, userPrompt, answerInfo), sources);
  const fanout = extractFanout(nodes);
  // Detection-only text: strips [[cite:URL]] markers so a cited domain can't
  // match itself inside its own citation marker (see stripCiteMarkersForDetection
  // above). answerText itself keeps the markers — exportDoc.js needs them intact
  // to render numbered footnotes.
  const textForDetection = stripCiteMarkersForDetection(answerText);
  const brandRes = detectBrands(textForDetection, textForDetection, { sources, tracked: options.tracked, prompt: userPrompt });
  const brandMentions = (brandRes && brandRes.brands) || [];
  const entities = (brandRes && brandRes.entities) || [];

  return makeRecord({
    captureId,
    platform: "perplexity",
    model: model || null,
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
      answerSource: answerInfo.source,
      previewUpdatedAt: answerInfo.updatedAt || null,
      transport: stream ? "blocks" : "legacy",
      // Perplexity asked to sign up instead of answering (see readBlockStream):
      // a limit, which geo.js usageLimitOf() turns into a cooldown in a run.
      ...(refusal ? { gatewayError: "signed-out limit: Perplexity asked to sign up", refusal } : {}),
      streamFinal: stream ? stream.final : undefined,
      // Read off the page's text (content-iso.js): a fallback that any
      // network copy of the same answer beats (lib/sameAnswer.js).
      pageCopy: (!stream && parsed.length === 1 && parsed[0] && parsed[0].harvestSource === "dom") || undefined,
    },
  });
}
