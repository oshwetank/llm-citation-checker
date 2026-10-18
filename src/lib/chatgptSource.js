/*
 * chatgptSource.js — ChatGPT's answer when nobody is signed in (0.69.0).
 *
 * Signed out (the owner's "Run signed out" campaign, 18 Oct 2026), chatgpt.com
 * serves a lighter app under /unauth-mweb/ and the answer arrives from
 * /unauth-mweb/conversation/updates as newline-delimited JSON
 * (application/vnd.openai.conversation-source+ndjson), not as the signed-in
 * SSE stream. Only the shape of its first 2 KB is known so far, from the
 * network recorder: events carrying conversationId, messageId, revision,
 * status, markdown, html, references, approvedUrls, items and activity.
 *
 * So this reads by name, not by position: the answer is the newest
 * revision's markdown (the html, stripped, if there is none); its sources
 * are the references and approved addresses; searches are any query-ish
 * strings in its activity. Anything it can't find stays empty, and the raw
 * stream is stored as it came, so a later build can read it again.
 */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** True for an ndjson conversation-source stream rather than SSE. */
export function isConversationSource(raw, url = "") {
  if (/\/unauth-mweb\/conversation\/updates\b/.test(url)) return true;
  const head = String(raw || "").slice(0, 4000);
  return /^\s*\{/.test(head) && /"(?:streamType|conversation-source|canonicalPath|stopConduitToken)"/.test(head) && !/^\s*(?:event|data):/m.test(head);
}

/** Every JSON object in the stream, one per line (a line that isn't JSON is skipped). */
export function sourceEvents(raw) {
  const out = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    let t = line.trim();
    if (t.startsWith("data:")) t = t.slice(5).trim();
    if (!t || t[0] !== "{") continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* a cut line */ }
  }
  return out;
}

function walk(v, fn, depth = 0) {
  if (depth > 14 || v == null) return;
  if (Array.isArray(v)) { v.forEach((x) => walk(x, fn, depth + 1)); return; }
  if (!isObj(v)) return;
  fn(v);
  for (const k of Object.keys(v)) walk(v[k], fn, depth + 1);
}

const stripHtml = (h) => String(h || "")
  .replace(/<\s*(?:br|\/p|\/li|\/h\d|\/div)\s*>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\n{3,}/g, "\n\n").trim();
const isUrl = (s) => typeof s === "string" && /^https?:\/\/[^\s]+$/.test(s);

/**
 * The answer in a conversation-source stream: { answer, sources, queries,
 * conversationId, messageId, prompt, status } or null when it holds no text.
 */
export function readConversationSource(raw) {
  const events = sourceEvents(raw);
  if (!events.length) return null;
  const texts = []; // { messageId, revision, markdown, html, order }
  const refs = new Map(); // url -> { url, title, snippet, cited }
  const queries = [];
  let conversationId = null, prompt = null, status = null, order = 0;
  const addRef = (url, title, snippet, cited) => {
    if (!isUrl(url)) return;
    const u = url.replace(/[?&]utm_source=chatgpt\.com/, "").replace(/\?$/, "");
    const cur = refs.get(u) || { url: u, title: null, snippet: null, cited: false };
    if (title && !cur.title) cur.title = String(title).slice(0, 300);
    if (snippet && !cur.snippet) cur.snippet = String(snippet).slice(0, 600);
    if (cited) cur.cited = true;
    refs.set(u, cur);
  };
  for (const ev of events) {
    walk(ev, (o) => {
      if (typeof o.conversationId === "string" && !conversationId) conversationId = o.conversationId;
      if (typeof o.status === "string") status = o.status;
      const role = o.role || (isObj(o.author) && o.author.role);
      if (role === "user" && !prompt) {
        const t = typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : typeof o.markdown === "string" ? o.markdown : null;
        if (t && t.trim()) prompt = t.trim();
      }
      if (role !== "user" && (typeof o.markdown === "string" || typeof o.html === "string")) {
        texts.push({ messageId: o.messageId || o.id || null, revision: typeof o.revision === "number" ? o.revision : null, markdown: typeof o.markdown === "string" ? o.markdown : "", html: typeof o.html === "string" ? o.html : "", order: order++ });
      }
      if (Array.isArray(o.references)) o.references.forEach((r) => {
        if (isUrl(r)) addRef(r, null, null, true);
        else if (isObj(r)) addRef(r.url || r.href || r.link, r.title || r.name || r.attribution, r.snippet || r.description || r.text, true);
      });
      for (const k of ["approvedUrls", "canonicalApprovedUrls"]) if (Array.isArray(o[k])) o[k].forEach((u) => addRef(typeof u === "string" ? u : u && u.url, null, null, true));
      for (const k of ["query", "queries", "search_query", "searchQuery"]) {
        const v = o[k];
        (Array.isArray(v) ? v : [v]).forEach((q) => { const t = typeof q === "string" ? q : q && q.q; if (t && t.trim() && t.length < 300 && !queries.includes(t.trim())) queries.push(t.trim()); });
      }
      if (isUrl(o.url) && (o.title || o.snippet) && !/\/(?:unauth-mweb|backend-api|cdn)\//.test(o.url)) addRef(o.url, o.title, o.snippet, false);
    });
  }
  // The newest message, at its newest revision. A stream that sends pieces
  // rather than snapshots is joined in order.
  const lastId = [...texts].reverse().find((t) => t.messageId)?.messageId || null;
  const mine = texts.filter((t) => !lastId || t.messageId === lastId || !t.messageId);
  let answer = "";
  if (mine.length) {
    const md = mine.filter((t) => t.markdown.trim());
    if (md.length) {
      const byRev = md.filter((t) => t.revision != null);
      const snap = byRev.length ? byRev.sort((a, b) => a.revision - b.revision || a.order - b.order) : md;
      const cumulative = snap.every((t, i) => i === 0 || t.markdown.startsWith(snap[i - 1].markdown.slice(0, Math.min(40, snap[i - 1].markdown.length))));
      answer = cumulative ? snap.reduce((a, t) => (t.markdown.length >= a.length ? t.markdown : a), "") : snap.map((t) => t.markdown).join("");
    } else {
      const html = mine.map((t) => t.html).filter(Boolean).pop() || "";
      answer = stripHtml(html);
    }
  }
  answer = answer.trim();
  if (!answer) return null;
  return { answer, sources: [...refs.values()], queries, conversationId, messageId: lastId, prompt, status };
}
