/*
 * pageCopy.js — an answer read off the page itself, for any engine (0.84.0).
 *
 * The owner: on every engine, "the normal auto response capture … is
 * getting broken with each update", still broken after refreshing the tab.
 * Each engine's adapter reads the answer out of its network traffic, and
 * those formats are the engines' to change, without notice: ChatGPT's
 * answer moved to a WebSocket in October, Gemini's to a WebChannel before
 * that. What an engine shows on screen changes far less. So when a question
 * asked in a tab gets no readable network capture, content-iso.js copies the
 * finished answer from the page (the prompt, the answer as markdown, its
 * links and pictures) in one shape for every engine, read here:
 *
 *   { format: "cito-page-copy", v: 1, platform, prompt, markdown,
 *     links: [{url, title}], images: [{src, href, alt}], conversationId }
 *
 * The same brand detection as every adapter runs on it. A network copy of
 * the same answer, when one arrives, is the better record and wins
 * (lib/sameAnswer.js, which already prefers it).
 */
import { makeRecord, makeSource } from "../schema.js";
import { isHttpUrl, domainOf } from "../lib/deep.js";
import { detectBrands } from "../lib/brands.js";

export const PAGE_COPY_FORMAT = "cito-page-copy";
const ADAPTER_VERSION = "page-copy-1";
const HOME = { chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com", perplexity: "https://www.perplexity.ai", grok: "https://grok.com" };

export function isPageCopy(raw) {
  return typeof raw === "string" && raw.startsWith("{") && raw.includes(`"format":"${PAGE_COPY_FORMAT}"`);
}

export async function adaptPageCopy({ captureId, raw, capturedAt, pageUrl }, options = {}) {
  let p;
  try { p = JSON.parse(raw); } catch (_) { p = {}; }
  const platform = HOME[p.platform] ? p.platform : "chatgpt";
  const userPrompt = String(p.prompt || "").trim();
  const answerText = String(p.markdown || "").trim();
  const seen = new Set();
  const sources = [];
  for (const l of p.links || []) {
    const url = l && l.url;
    if (!isHttpUrl(url) || seen.has(url)) continue;
    // The engine's own pages are its interface, not a source.
    const d = domainOf(url) || "";
    if (/(^|\.)(chatgpt\.com|openai\.com|google\.com|gemini\.google\.com|perplexity\.ai|grok\.com|x\.com)$/.test(d) && !/\/url\?/.test(url)) continue;
    seen.add(url);
    sources.push(makeSource({ url, domain: d, title: l.title || null, outcome: "cited", type: "web", platformSpecific: { fromPage: true } }));
    if (sources.length >= 80) break;
  }
  const images = (p.images || []).filter((im) => im && isHttpUrl(im.src)).slice(0, 30)
    .map((im) => ({ url: im.src, title: im.alt || null, attribution: im.href && isHttpUrl(im.href) ? { url: im.href, domain: domainOf(im.href) } : null }));
  const brandRes = answerText ? detectBrands(answerText, answerText, { sources, tracked: options.tracked, prompt: userPrompt }) : null;
  return makeRecord({
    captureId,
    platform,
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || HOME[platform],
    conversationId: p.conversationId || null,
    userPrompt,
    answerText,
    answerChars: answerText.length,
    // The page doesn't say what the engine searched; links are what it cited.
    searched: sources.length > 0,
    sources,
    images,
    brandMentions: (brandRes && brandRes.brands) || [],
    entities: (brandRes && brandRes.entities) || [],
    platformSpecific: { adapterVersion: ADAPTER_VERSION, transport: "page-copy", pageCopy: true, harvestSource: "dom" },
    _extraction: { adapterVersion: ADAPTER_VERSION, usedFallback: true, notes: ["read off the page: no readable network copy of this answer arrived"] },
  });
}
