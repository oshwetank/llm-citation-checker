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
 * ChatGPT refusing the turn because of a message limit (0.78.1). In the
 * owner's signed-out campaign, 39% of ChatGPT's replies were not answers but
 * its "Message limit reached — You have reached the anonymous message limit"
 * card, and they were stored and counted as answers that named no brand.
 * The stream says so in two places: a diagnostic event with status 429
 * ("source_submission_unavailable") and a safety gate of kind "rate_limited"
 * inside the card's html. Returns a short label, or null.
 */
export function limitOfSource(raw) {
  const text = String(raw || "");
  let limited = null;
  for (const ev of sourceEvents(text)) {
    if (ev.type === "diagnostic" && typeof ev.payload === "string" && /"status"\s*:\s*429/.test(ev.payload)) limited = limited || "rate_limited";
    if (typeof ev.html === "string") {
      const h = ev.html.replace(/&quot;/g, '"');
      const kind = /"gate"\s*:\s*\{[^}]*"kind"\s*:\s*"([a-z_]+)"/.exec(h);
      if (kind && /limit|rate|quota/.test(kind[1])) limited = kind[1];
      else if (/anonymous message limit|message limit reached/i.test(h)) limited = limited || "rate_limited";
    }
  }
  if (!limited) return null;
  return /anonymous message limit/i.test(text.replace(/&quot;/g, '"')) ? "anonymous message limit" : limited;
}

/** The prompt, from the form the signed-out page posts (its "prompt" field). */
export function promptOfSourceRequest(reqBody) {
  const b = String(reqBody || "");
  if (!/(?:^|&)prompt=/.test(b)) return null;
  try { const p = new URLSearchParams(b).get("prompt"); return p && p.trim() ? p.trim() : null; } catch (_) { return null; }
}

/**
 * ChatGPT's fallback markdown as plain markdown: its escapes ("1\\.", "audio\\,")
 * undone, and a price's doubled currency sign ("₹₹3,999": the layout writes
 * the sign and the bound price carries it too) made single.
 */
export function fallbackToMarkdown(text) {
  return String(text || "")
    // Layout directives and button text the fallback spells out as words:
    // "image_group{…}" and "urlCheck pricehttps://chatgpt.com/?hints=…".
    .replace(/^\s*image_group\{[^\n]*\}\s*$/gm, "")
    .replace(/\burl[^\n]*?https?:\/\/chatgpt\.com\/\?hints=[^\s)\]]+/g, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/chatgpt\.com\/\?hints=[^)]*\)/g, "$1")
    .replace(/\\([.,!:;()'"=?&@%/-])/g, "$1")
    .replace(/([₹$€£¥])\1+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
  // The answer's own cards (0.80.0): products, local businesses and pictures,
  // from its generative-UI components. Signed out, these were all dropped,
  // so a campaign's answers showed no products, places or images.
  const products = new Map(), places = new Map(), images = new Map();
  // ChatGPT's own plain-markdown version of a generated-UI answer (1.0.0), per
  // message: { revision, text, order }. The owner's signed-out answer of 15 Nov
  // 2026 had `markdown: ""` in all 26 of its content events, the whole answer
  // being in `dil` (layout code), and no answer was read from 2.3 MB of data.
  const fallbacks = [];
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
    // ChatGPT's own markdown for a generated-UI answer. Each event carries it
    // twice: `dil` (clean) and inside `references[].modelDilV2` (the same with
    // image-group directives and chatgpt.com link text left in). The clean one
    // is used; the other only when there is no clean one.
    const addFallback = (text, primary) => { if (typeof text === "string" && text.trim()) fallbacks.push({ messageId: ev.messageId || null, revision: typeof ev.revision === "number" ? ev.revision : -1, text, primary, order: order++ }); };
    if (isObj(ev.dil)) addFallback(ev.dil.fallbackMarkdown, true);
    if (Array.isArray(ev.references)) ev.references.forEach((r) => { if (isObj(r) && isObj(r.modelDilV2)) addFallback(r.modelDilV2.fallbackMarkdown, false); });
    walk(ev, (o) => {
      // Products named by the answer's data bindings ({id: {title, displayed_price,
      // merchant}}): the names a card's layout refers to.
      if (isObj(o.modelDataBindings)) {
        for (const v of Object.values(o.modelDataBindings)) {
          if (!isObj(v) || typeof v.title !== "string") continue;
          const name = v.title.trim();
          if (name && name.length < 200 && !products.has(name)) products.set(name, { id: name, name, price: typeof v.displayed_price === "string" ? v.displayed_price : null, merchant: typeof v.merchant === "string" ? v.merchant : null, image: null, note: null, renderAs: "card" });
        }
      }
      if (o.componentName === "Entity" && isObj(o.state) && typeof o.state.value === "string") {
        const st = o.state, pay = isObj(st.action_payload) ? st.action_payload : {};
        const extra = isObj(pay.extraParams) ? pay.extraParams : {};
        const name = st.value.trim();
        if (name && pay.category === "product" && !products.has(name)) products.set(name, { id: name, name, price: null, merchant: null, image: isUrl(st.image_url) ? st.image_url : null, note: extra.disambiguation || null, renderAs: "inline" });
        if (name && /^(?:local_)?business$/.test(pay.category || "") && !places.has(name)) places.set(name, { name, address: extra.location || null, mapsUrl: isUrl(st.directions_url) ? st.directions_url : null, image: isUrl(st.image_url) ? st.image_url : null, category: null });
      }
      if (o.componentName === "AsyncImage" && isObj(o.state) && Array.isArray(o.state.images)) {
        for (const im of o.state.images) {
          const url = isObj(im) && (im.thumbnail_url || im.content_url);
          if (!isUrl(url) || images.has(url)) continue;
          images.set(url, { url, sourceUrl: isUrl(im.url) ? im.url : null, title: typeof im.title === "string" ? im.title : null });
        }
      }
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
  if (!answer && fallbacks.length) {
    // The newest, fullest of ChatGPT's own markdown for the message.
    const sameMsg = fallbacks.filter((f) => !lastId || !f.messageId || f.messageId === lastId);
    let pool = sameMsg.length ? sameMsg : fallbacks;
    if (pool.some((f) => f.primary)) pool = pool.filter((f) => f.primary);
    // The final revision (a stream sends snapshots, each newer one whole).
    const best = pool.reduce((a, f) => (f.revision > a.revision || (f.revision === a.revision && f.order > a.order) ? f : a), pool[0]);
    answer = fallbackToMarkdown(best.text);
  }
  if (!answer) return null;
  // A name cut short with "…" next to the full one is the same product.
  const productList = [...products.values()];
  const whole = productList.filter((p) => !(/…$/.test(p.name) && productList.some((q) => q !== p && !/…$/.test(q.name) && q.name.startsWith(p.name.slice(0, -1)))));
  return { answer, sources: [...refs.values()], queries, conversationId, messageId: lastId, prompt, status, products: whole, places: [...places.values()], images: [...images.values()].slice(0, 60) };
}
