/*
 * aimode.js — Google AI Mode, engine 5 (1.0.5).
 *
 * The capture is the text of GET /async/folwr (first question) or
 * /async/folif (a follow-up): HTML with JSON data islands, read by
 * lib/aiModeStream.js. Sources are the real URLs from the islands (the page
 * itself only links /goto?url=… redirects); the inline citation pills are
 * marked. Brands come from the answer, and from the product cards, whose
 * names often carry a brand the text never repeats.
 */
import { makeRecord, makeSource } from "../schema.js";
import { detectBrands, vendorFromProductName } from "../lib/brands.js";
import { readAiMode } from "../lib/aiModeStream.js";

export const ADAPTER_VERSION = "aimode@0.1.0";
export const AIMODE_FANOUT_NOTE = "fanout: AI Mode doesn't show the searches it runs.";
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return null; } };

export async function adapt({ captureId, raw, capturedAt, pageUrl, url }, options = {}) {
  const r = readAiMode(raw, url || "");
  const pills = new Set(r.pills);
  const sources = r.sources.map((s) => makeSource({
    url: s.url, domain: domainOf(s.url), title: s.title, snippet: s.snippet,
    outcome: "cited", type: "citation", platformSpecific: { site: s.site || null, inline: pills.has(s.url) },
  }));
  // A pill whose card wasn't in the source panel still counts.
  for (const u of pills) if (!r.sources.some((s) => s.url === u)) sources.push(makeSource({ url: u, domain: domainOf(u), outcome: "cited", type: "citation", platformSpecific: { inline: true } }));
  const products = r.products.map((p) => ({ name: p.name, price: p.price, rating: p.rating, brand: vendorFromProductName(p.name) || null, ...(p.image ? { images: [p.image] } : {}) }));
  // Links but no AI answer (Google chose not to write one): the few words
  // left are link text, not an answer.
  // A source's link chip, read as a line of its own (" SHK Global
  // Ventures", " opsloop.in"), is not the answer's words: both were
  // brands in a live test of 25 Nov 2026 (1.0.7). Only a line that opens
  // with a no-break space and spells a source's own site goes.
  const squeeze = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const siteKeys = new Set();
  for (const s of sources) {
    const d = String(s.domain || "").replace(/^www\./, "");
    if (d) { siteKeys.add(squeeze(d)); siteKeys.add(squeeze(d.replace(/\.[a-z]{2,3}(?:\.[a-z]{2})?$/i, ""))); }
    if (s.platformSpecific && s.platformSpecific.site) siteKeys.add(squeeze(s.platformSpecific.site));
  }
  siteKeys.delete("");
  const answer = String(r.answerText || "").split("\n")
    .filter((line) => !(/^ /.test(line) && line.trim().split(/\s+/).length <= 6 && siteKeys.has(squeeze(line))))
    .join("\n");
  const text = answer.length < 20 && r.sources.length ? "" : answer;
  // Card names feed brand detection too: "Hoka Clifton 9" names Hoka even
  // when the text only says "this cushioned trainer".
  const cardText = products.map((p) => p.name).join("\n");
  const brandRes = detectBrands(text, `${text}\n${cardText}`, { sources, tracked: options.tracked, prompt: r.prompt });
  const brandMentions = (brandRes && brandRes.brands) || [];
  // A product card's maker is named in the answer even when no sentence
  // says it in bold ("Hoka Arahi 8" on a card): counted where it appears.
  const low = text.toLowerCase();
  for (const b of [...new Set(products.map((p) => p.brand).filter(Boolean))]) {
    if (brandMentions.some((m) => m.brand && m.brand.toLowerCase() === b.toLowerCase())) continue;
    const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const count = (text.match(re) || []).length;
    if (count) brandMentions.push({ brand: b, count, firstIndex: low.indexOf(b.toLowerCase()), via: "product-card" });
  }
  const noAiAnswer = !text && sources.length > 0;
  return makeRecord({
    captureId,
    platform: "aimode",
    model: null,
    capturedAt: capturedAt || Date.now(),
    pageUrl: pageUrl || "https://www.google.com/search?udm=50",
    userPrompt: r.prompt,
    answerText: text,
    answerChars: text.length,
    searched: sources.length > 0,
    sources,
    products,
    images: r.products.filter((p) => p.image).map((p) => ({ url: p.image, title: p.name, price: p.price || null })),
    fanout: { search: [], shopping: [], image: [] },
    brandMentions,
    entities: (brandRes && brandRes.entities) || [],
    platformSpecific: {
      adapterVersion: ADAPTER_VERSION,
      transport: r.followUp ? "folif" : "folwr",
      turn: r.followUp ? "followup" : "first",
      islands: r.islandCount,
      islandErrors: r.islandErrors,
      islandTags: r.islandTags,
      refine: r.refine.length ? r.refine : undefined,
      merchants: r.merchants.length ? r.merchants : undefined,
      noAiAnswer: noAiAnswer || undefined,
      fanoutNote: AIMODE_FANOUT_NOTE,
    },
  });
}
