/*
 * aiModeStream.js — reading Google AI Mode's answer (1.0.5, engine 5).
 *
 * AI Mode streams its answer as server-rendered HTML over GET /async/folwr
 * (a follow-up: /async/folif). The visible answer is in the HTML; the real
 * source URLs, titles and snippets, the inline citation pills and the
 * product cards are only in JSON "data islands" inside HTML comments shaped
 * <!--TAG|ids|ids|[json]-->. The TAG changes (seen "TgQPHd" and "Sv6Kpe"),
 * so any 5–8 letter tag is read. Regex only, no DOMParser: the service
 * worker has none. Measured on live payloads (live-harness audit/aimode,
 * 24 Nov 2026); the tests use synthetic payloads of the same shape.
 */
const ENT = { "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&", "&nbsp;": " " };
export const decodeEntities = (s) => String(s || "").replace(/&(?:quot|#39|lt|gt|amp|nbsp);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
// Google's own hosts are never a source.
const GOOGLE = /^https?:\/\/([^/]*\.)?(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|googleapis\.com|youtube-nocookie\.com)(\/|$)/i;
export const isExternal = (u) => typeof u === "string" && /^https?:\/\//.test(u) && !GOOGLE.test(u);
const clean = (u) => String(u).replace(/#:~:text=.*$/, "");

/** Every data island: { tag, json }; unreadable ones are counted, not thrown. */
export function islands(html) {
  const out = [];
  let errors = 0;
  for (const m of String(html || "").matchAll(/<!--([A-Za-z0-9]{5,8})\|([^|]*)\|([^|]*)\|(\[[\s\S]*?\])-->/g)) {
    if (m[4] === "[]") continue;
    try { out.push({ tag: m[1], json: JSON.parse(decodeEntities(m[4])) }); } catch (_) { errors++; }
  }
  return { islands: out, errors };
}

/** Sources, inline pills and product cards from the islands. */
export function readIslands(list) {
  const sources = new Map(), pills = new Set(), products = new Map();
  const walk = (a, depth = 0) => {
    if (!Array.isArray(a) || depth > 40) return;
    // A source card: [title, snippet|null, faviconUrl, siteRoot, [siteName], …url]
    if (typeof a[0] === "string" && a.length >= 6 && typeof a[2] === "string" && /favicon/i.test(a[2]) && Array.isArray(a[4])) {
      const url = a.slice(5).find(isExternal) || (isExternal(a[3]) ? a[3] : null);
      if (url) { const u = clean(url); if (!sources.has(u)) sources.set(u, { url: u, title: a[0], snippet: typeof a[1] === "string" ? a[1] : null, site: (a[4] && a[4][0]) || null }); }
    }
    // An inline citation pill: ["<uuid>", [title, snippet, favicon, …, url]]
    if (typeof a[0] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(a[0]) && Array.isArray(a[1]) && typeof a[1][0] === "string") {
      const url = a[1].find((x) => isExternal(x) && !/favicon/i.test(x));
      if (url) pills.add(clean(url));
    }
    // A product card: [1, null, [title, shoppingImage, price, null, rating], …]
    if (a[0] === 1 && Array.isArray(a[2]) && typeof a[2][0] === "string" && typeof a[2][1] === "string" && /shopping\?q=tbn|encrypted-tbn/.test(a[2][1])) {
      if (!products.has(a[2][0])) products.set(a[2][0], { name: a[2][0], image: a[2][1], price: typeof a[2][2] === "string" ? a[2][2] : null, rating: typeof a[2][4] === "number" ? a[2][4] : null, merchants: [] });
    }
    for (const x of a) walk(x, depth + 1);
  };
  for (const i of list) walk(i.json);
  return { sources: [...sources.values()], pills: [...pills], products: [...products.values()] };
}

/**
 * Product cards read from the HTML (live, 24 Nov 2026: the cards' islands
 * changed shape, and the name now sits right inside the link,
 * <a data-pid=… href="/search?ibp=oshop…"><!--…-->Name<!--…--></a>): the
 * name, then the first price and rating after it.
 */
export function productsFromHtml(html) {
  const h = String(html || "");
  const out = new Map();
  // The name is the first text in the link, after any comments (a hidden
  // block with its own text follows it before </a>).
  for (const m of h.matchAll(/<a\b[^>]*\bdata-pid="(\d+)"[^>]*>(?:\s*<!--[\s\S]*?-->)*\s*(?:<span[^>]*>)?\s*([^<]{2,120})/g)) {
    const name = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    if (!name || name.length > 120 || out.has(name)) continue;
    const after = decodeEntities(h.slice(m.index + m[0].length, m.index + m[0].length + 4000).replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    const price = (after.match(/[₹$€£¥]\s?[\d,]+(?:\.\d+)?/) || [null])[0];
    const rating = after.match(/(?:^|\s)([0-5]\.\d)(?:\s|$)/);
    out.set(name, { name, price, rating: rating ? Number(rating[1]) : null, image: null, merchants: [] });
  }
  return [...out.values()];
}

/** Shops named next to the product cards: ["https://shop.example","Shop"] pairs. */
export function merchantsIn(html) {
  const out = new Set();
  for (const m of decodeEntities(html).matchAll(/\["(https?:\/\/[^"]+)","([^"]{2,40})"\]/g)) if (isExternal(m[1])) out.add(m[2]);
  return [...out];
}

/** The HTML without the <div>s its own styles hide (.x{display:none}). */
export function stripHidden(html) {
  const hidden = new Set();
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const r of m[1].matchAll(/\.([\w-]+)\s*\{[^}]*display\s*:\s*none/g)) hidden.add(r[1]);
  }
  if (!hidden.size) return html;
  let out = "", i = 0;
  const open = /<div\b[^>]*\bclass="([^"]*)"[^>]*>/g;
  for (;;) {
    open.lastIndex = i;
    let m;
    while ((m = open.exec(html)) && !m[1].split(/\s+/).some((c) => hidden.has(c))) { /* next */ }
    if (!m) { out += html.slice(i); break; }
    out += html.slice(i, m.index);
    // Its end: count nested <div>s.
    let depth = 1, j = m.index + m[0].length;
    const tag = /<(\/?)div\b[^>]*>/g;
    tag.lastIndex = j;
    let t;
    while (depth && (t = tag.exec(html))) depth += t[1] ? -1 : 1;
    i = depth ? html.length : tag.lastIndex;
  }
  return out;
}

/** The answer as light markdown, and the refine questions. */
export function answerOf(html, prompt = "") {
  // Blocks the page hides (a product card's details inside its link, in the
  // newer layout) are not text.
  let h = stripHidden(String(html || "")).replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const refine = [...h.matchAll(/<h4[^>]*data-question-header[^>]*>([^<]+)</g)].map((m) => decodeEntities(m[1]).trim());
  // The prompt heading (h3 data-ignore-copy) and the feedback block (data-snt) by structure first.
  h = h.replace(/<h3[^>]*data-ignore-copy[^>]*>[\s\S]*?<\/h3>/g, "\n\u0001\n");
  const fb = h.search(/<[^>]+data-snt[^>]*>/);
  if (fb > 0) h = h.slice(0, fb);
  h = h.replace(/<strong[^>]*>([^<]{1,80})<\/strong>/g, "**$1**").replace(/<b>([^<]{1,80})<\/b>/g, "**$1**");
  h = h.replace(/(<a[^>]*data-pid="[^"]*"[^>]*>\s*<span[^>]*>)([^<]{2,80})/g, "$1**$2**");
  // The newer card link holds the name itself.
  h = h.replace(/(<a[^>]*data-pid="[^"]*"[^>]*>)\s*([^<*\s][^<*]{1,79}?)\s*(?=<)/g, "$1**$2**");
  h = h.replace(/<h1[^>]*>Shared<\/h1>/, "");
  h = h.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "\n- ").replace(/<h[1-6][^>]*>/gi, "\n### ");
  let text = decodeEntities(h.replace(/<[^>]+>/g, ""));
  text = text.replace(/Go to product viewer dialog for this item\./g, "").replace(/\[Highlight (?:start|end)\]/g, "")
    .replace(/[ \t]+/g, " ").replace(/^### *$/gm, "").replace(/\n\s*\n+/g, "\n").trim();
  // After the prompt heading (by structure, then the English label).
  const mark = text.lastIndexOf("\u0001");
  if (mark >= 0) text = text.slice(mark + 1);
  else { const head = text.match(/AI Mode reply for [^\n]+/); if (head) text = text.slice(text.indexOf(head[0]) + head[0].length); }
  const cut = text.search(/AI can make mistakes, so double-check responses/);
  if (cut > 0) text = text.slice(0, cut);
  text = text.replace(/\u0001/g, "").trim();
  if (prompt && text.startsWith(prompt)) text = text.slice(prompt.length).trim();
  return { text, refine };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The answer read as a person reads it: a product card's loose lines (name,
 * price, shop, rating, reviews) as one line with the name in bold, words
 * the markup broke off joined back, the "Shared · N files" header gone.
 */
export function tidy(text, products = []) {
  let t = String(text || "").replace(/^\s*\d+ files?\s*\n/, "")
    // The page's own buttons and toasts.
    .replace(/Show all\s*Show less/g, "").replace(/Copied to clipboard\s*(?:Failed to copy to clipboard\.?\s*Try again)?/g, "")
    // A sale price run into the list price: "₹13,599.00₹16,999".
    .replace(/(\d)([₹$€£¥])/g, "$1 $2");
  for (const p of products) {
    const re = new RegExp(`^(?:\\*\\*)?${esc(p.name)}(?:\\*\\*)?\\n((?:[^\\n]{1,40}\\n){0,4}?)(?=- |\\*\\*|[A-Z][^\\n]{40,}|$)`, "m");
    t = t.replace(re, (m, rest) => {
      const bits = rest.split("\n").map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/& more$/, " & more"));
      return `**${p.name}**${bits.length ? `: ${bits.join(" · ")}` : ""}\n`;
    });
  }
  // A line that starts mid-sentence (lower case or punctuation) belongs to the one before.
  // The page's controls left at the end ("Copied", "Failed to copy", "Copy", "Share", "later.").
  const lines = t.split("\n");
  while (lines.length && /^\s*(?:later\.?|(?:Copied|Failed to copy|Copy|Share|Show all|Show less|Good response|Bad response)+\s*)$/i.test(lines[lines.length - 1].replace(/Copied|Failed to copy|Copy/g, (m) => m))) lines.pop();
  t = lines.join("\n");
  t = t.replace(/\n(?=[ \t]*[a-z.,;:)!?])/g, " ").replace(/:\*\*\n/g, ":** ").replace(/[ \t]+/g, " ").replace(/ ([.,;:!?])/g, "$1");
  // Citation chips' labels ("RunRepeat +3") on their own line: links, not text.
  t = t.replace(/(^|\n)[\s ]*[\p{L}\d][\p{L}\d .&'’ -]{1,40}?[\s ]*\+\d+[\s ]*(?=\n|$)/gu, "$1");
  // A bold name the markup put on its own line, mid-sentence.
  t = t.replace(/([\p{Ll},])[ \t]*\n[ \t]*(\*\*[^*\n]{1,80}\*\*[ \t]+\p{Ll})/gu, "$1 $2");
  // "… prices. later." (a toast's tail joined on): gone.
  t = t.replace(/\s+later\.\s*$/, "");
  return t.trim();
}

/** The question: q= of the request, else the heading. */
export function promptOf(url, html) {
  try { const q = new URL(url, "https://www.google.com").searchParams.get("q"); if (q && q.trim()) return q.trim(); } catch (_) { /* no URL */ }
  const m = String(html || "").match(/<h3[^>]*data-ignore-copy[^>]*>([\s\S]*?)<\/h3>/);
  if (m) return decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/^AI Mode reply for /, "").trim();
  return "";
}

/** Everything in one answer payload. */
export function readAiMode(raw, url = "") {
  const html = String(raw || "");
  const { islands: list, errors } = islands(html);
  const isl = readIslands(list);
  // Cards the islands didn't give (the newer layout) come from the HTML.
  for (const p of productsFromHtml(html)) if (!isl.products.some((x) => x.name === p.name)) isl.products.push(p);
  const prompt = promptOf(url, html);
  const { text, refine } = answerOf(html, prompt);
  const tags = {};
  for (const i of list) tags[i.tag] = (tags[i.tag] || 0) + 1;
  const merchants = merchantsIn(html);
  return { prompt, answerText: tidy(text, isl.products), refine, ...isl, merchants, islandCount: list.length, islandErrors: errors, islandTags: tags, gotoLinks: (html.match(/\/goto\?url=/g) || []).length, followUp: /\/async\/folif\b/.test(url) };
}
