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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "extract-page") return;
  try { sendResponse({ ok: true, ...extract(msg.html, msg.url) }); }
  catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
  return true;
});
