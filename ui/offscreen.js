/*
 * offscreen.js — readable text from a cited page's HTML (0.62.0).
 *
 * The service worker fetches a cited page; it has no DOM, so the HTML comes
 * here. Mozilla Readability (Apache-2.0, src/vendor/) finds the article, the
 * same code Firefox's Reader View uses. When it finds nothing (a listing, a
 * product page), the body text is taken with scripts, styles and the page's
 * own navigation, header and footer removed. Nothing here touches the
 * network: scripts in the parsed document never run.
 */
/* global Readability */
const DROP = "script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]";

function blockText(node) {
  // textContent runs paragraphs together; break after block elements first.
  node.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, section, article, td, th, dd, dt, blockquote, pre").forEach((el) => el.append("\n"));
  return node.textContent.replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export function extract(html, url) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  try { const base = doc.createElement("base"); base.href = url; doc.head && doc.head.prepend(base); } catch (_) { /* no base */ }
  const title = (doc.querySelector("meta[property='og:title']")?.content || doc.title || "").trim();
  const lang = doc.documentElement.getAttribute("lang") || null;
  let text = "", method = "readability";
  try {
    const art = new Readability(doc.cloneNode(true), { charThreshold: 300 }).parse();
    if (art && art.textContent) {
      const box = doc.createElement("div");
      box.innerHTML = art.content || "";
      text = blockText(box) || art.textContent.trim();
    }
  } catch (_) { /* fall through to the body */ }
  if (!text || text.split(/\s+/).length < 150) {
    const body = doc.body ? doc.body.cloneNode(true) : null;
    if (body) {
      body.querySelectorAll(DROP).forEach((el) => el.remove());
      const main = body.querySelector("main, article, [role=main]") || body;
      const t = blockText(main);
      if (t.length > text.length) { text = t; method = "body"; }
    }
  }
  return { title, text: text.slice(0, 200000), lang, method };
}

/* Freeing memory (0.74.0). Unloading the model inside this page can't give
 * its memory back (a WebAssembly heap only grows), so when nothing has used
 * this page for a while it closes itself, and the worker opens it again on
 * the next job. Only the real offscreen document does this: in Firefox this
 * file runs in the background page itself. */
let IDLE_CLOSE_MS = 150 * 1000;
let lastUse = Date.now();
let busyOps = 0;
const touchPage = () => { lastUse = Date.now(); };
if (/\/offscreen\.html$/.test(location.pathname)) {
  setInterval(() => {
    if (busyOps === 0 && Date.now() - lastUse > IDLE_CLOSE_MS) window.close();
  }, 1000);
}

// Tests only: a shorter idle time.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "set-idle") return;
  IDLE_CLOSE_MS = Math.max(1000, Number(msg.ms) || IDLE_CLOSE_MS);
  sendResponse({ ok: true });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "extract-page") return;
  touchPage();
  try { sendResponse({ ok: true, ...extract(msg.html, msg.url) }); }
  catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
  return true;
});

/* The built-in AI model (0.70.0, src/lib/llmEngine.js) lives here too: the
 * service worker sends it jobs and gets replies back. Its library is only
 * imported on the first AI job, so reading cited pages stays light. */
let engine = null;
const getEngine = () => (engine = engine || import("../src/lib/llmEngine.js"));
let laya = null;
const getLaya = () => (laya = laya || import("../src/lib/layaEngine.js"));
// Search by meaning (1.0.5, src/lib/meaningEngine.js).
let meaning = null;
const getMeaning = () => (meaning = meaning || import("../src/lib/meaningEngine.js"));
let lastProgress = 0;
const sendProgress = (p) => {
  const progress = { status: p.status, file: p.file || null, loaded: p.loaded || 0, total: p.total || 0, pct: p.progress ?? null };
  // In a browser without offscreen documents this runs in the background
  // page itself, which can't message itself: it is told directly.
  if (globalThis.citoOffscreen && typeof globalThis.citoOffscreen.onProgress === "function") { globalThis.citoOffscreen.onProgress(progress); return; }
  try { chrome.runtime.sendMessage({ type: "ai-progress", progress }, () => void chrome.runtime.lastError); } catch (_) { /* nobody listening */ }
};
async function llmOp(op, args = {}) {
  const e = await getEngine();
  switch (op) {
    case "hardware": return e.hardware();
    case "status": return e.status();
    case "load": return e.load({ ...args, onProgress: (p) => {
      // Throttled: a 1.4 GB download reports thousands of steps.
      const now = Date.now();
      if (p && p.status === "progress_total" && now - lastProgress < 300 && p.progress < 100) return;
      lastProgress = now;
      sendProgress(p || {});
    } });
    case "generate": return e.generate(args);
    case "unload": await e.unload(); return { ok: true };
    case "cached": return e.cachedBytes(args.repo, args.host);
    case "remove": return e.removeCached(args.repo, args.host);
    // Laya, the labeller (0.83.0, src/lib/layaEngine.js): its own engine,
    // and the whole check runs here, where its tokenizer is.
    case "laya-load": { const L = await getLaya(); return L.load({ ...args, onProgress: (p) => sendProgress({ ...(p || {}), status: `laya-${(p && p.status) || "progress"}` }) }); }
    case "laya-status": return (await getLaya()).status();
    case "laya-unload": await (await getLaya()).unload(); return { ok: true };
    case "laya-cached": return (await getLaya()).cachedBytes(args);
    case "laya-remove": return (await getLaya()).removeCached(args);
    case "laya-check": {
      const L = await getLaya();
      const st = await L.load(args.spec);
      const { layaCheckRecord } = await import("../src/lib/laya.js");
      return layaCheckRecord(args.record, (items) => L.run(items), { tok: L.encoder(), model: args.label || "Laya", maxLen: st.maxLen, headMaxLen: st.headMaxLen, temperature: st.temperature });
    }
    case "meaning-load": { const M = await getMeaning(); return M.load({ ...args, onProgress: (p) => sendProgress({ ...(p || {}), status: `meaning-${(p && p.status) || "progress"}` }) }); }
    case "meaning-status": return (await getMeaning()).status();
    case "meaning-cached": return (await getMeaning()).cachedBytes(args);
    case "meaning-remove": return (await getMeaning()).removeCached(args);
    case "meaning-rank": return (await getMeaning()).rank(args);
    default: throw new Error(`unknown op ${op}`);
  }
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "llm") return;
  touchPage();
  busyOps++;
  llmOp(msg.op, msg.args).then((r) => sendResponse({ ok: true, result: r }), (err) => sendResponse({ ok: false, error: String(err && err.message || err) }))
    .finally(() => { busyOps--; touchPage(); });
  return true;
});

// For browsers without offscreen documents (Firefox, Safari: 0.72.0) the
// background is a page and loads this file itself; it calls these directly.
globalThis.citoOffscreen = { extract, llmOp, onProgress: null };
