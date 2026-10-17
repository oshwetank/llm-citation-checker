/* answerReport.js — the single-answer PDF report (0.53.0), as data.
 *
 * Two A4 pages about one captured answer: what it was (kind, searches,
 * pages, cards), how your brand did in it, the product cards and where they
 * send buyers, what backs each brand, and what changed since the last time
 * the prompt was asked; then the answer as the engine showed it, the
 * technical details, the searches and every page it opened.
 *
 * Built from the same views Analyze shows (analyzeView.js), so the report
 * says what the screen says. Pure: the record, the previous answer to the
 * same prompt and the campaigns in, a plain object out. The answer's HTML is
 * exportDoc.js's, built from escaped text plus its own fixed set of tags.
 */

import { answerKind, knownVendors, searchesView, brandsView, ownBrandFor, yourBrandView, changesView, pagesView, adsView } from "./analyzeView.js";
import { buildExportModel } from "./exportDoc.js";
import { computeBrandMatrix, sameBrand } from "./funnel-omitted.js";
import { siteKindOf, normDomain } from "./siteKind.js";
import { extractBrandAspects } from "./aspects.js";
import { dayLabel } from "./campaignReport.js";

const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
const ORD = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const host = (u) => normDomain(String(u || "").replace(/^https?:\/\//, "").split("/")[0]);

function merchantsOf(p) {
  return String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x));
}
function productBrand(p, names) {
  if (p.brand) return p.brand;
  const name = String(p.name || "").trim();
  const hit = names.find((b) => new RegExp(`^${String(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(name));
  return hit || name.split(/\s+/)[0] || "";
}

/**
 * rec       the full record (with answerText)
 * previous  the previous answer to the same prompt on the same engine, or null
 * profiles  the campaigns, for "your brand" (ownBrandFor)
 */
export function answerReport(rec, { previous = null, profiles = [], generatedAt = Date.now() } = {}) {
  const engine = ENGINE_LABEL[rec.platform] || rec.platform || "Engine";
  const own = ownBrandFor(rec, profiles);
  const knownBrands = knownVendors(rec);
  const kind = answerKind(rec);
  const brands = brandsView(rec, { own, knownBrands, previous });
  const names = brands.rows.map((b) => b.name);
  const searches = searchesView(rec, names);
  const pages = pagesView(rec, { own, knownBrands });
  const you = yourBrandView(rec, own, { knownBrands, previous, max: 6 });
  const changes = changesView(rec, previous, { knownBrands });
  const sources = rec.sources || [];
  const cited = sources.filter((s) => s.outcome === "cited");
  const products = rec.products || [];
  const places = rec.places || [];
  const images = rec.images || [];
  const ads = adsView(rec);
  const lanes = (lane) => searches.rows.filter((r) => r.lane === lane).length;

  const chips = [
    { text: `${kind.label} answer`, kind: "type" },
    rec.searched || sources.length
      ? { text: searches.count ? `Searched the web · ${plural(searches.count, "search", "searches")}` : "Searched the web" }
      : { text: "From memory · no search" },
    sources.length ? { text: `${plural(sources.length, "page")} read · ${cited.length} cited` } : null,
    products.length ? { text: plural(products.length, "product card") } : { text: "No product cards", off: true },
    places.length ? { text: `Map · ${plural(places.length, "place")}` } : { text: "No map", off: true },
    images.length ? { text: plural(images.length, "image") } : { text: "No images", off: true },
    rec.carousels && rec.carousels.news ? { text: "News" } : null,
    ads.length ? { text: `Ad · ${[...new Set(ads.map((a) => a.advertiser || a.targetDomain))].join(", ")}` } : null,
  ].filter(Boolean);

  const named = brands.rows.filter((b) => b.position > 0).sort((a, b) => a.position - b.position);
  const ownRow = own ? brands.rows.find((b) => b.isYou) : null;
  const kpis = [
    { label: "Brands named", value: String(named.length), sub: named[0] ? `${named[0].name} named first` : "no brand named" },
    { label: "Pages cited", value: sources.length ? `${cited.length} of ${sources.length}` : "0", sub: sources.length ? `${sources.length - cited.length} read only` : "nothing opened" },
    { label: "Searches", value: searches.unpublished ? "—" : String(searches.count), sub: searches.unpublished ? `${engine} doesn’t show them` : [lanes("web") && `${lanes("web")} web`, lanes("shopping") && `${lanes("shopping")} shopping`, lanes("image") && `${lanes("image")} image`].filter(Boolean).join(" · ") || "none" },
  ];
  if (own) kpis.push({ label: `${own.name} position`, value: ownRow && ownRow.position ? `#${ownRow.position}` : "—", sub: [ownRow && ownRow.position ? (ownRow.position === 1 ? "named first" : `named ${ORD(ownRow.position)}`) : "not named", you && you.since && previous ? `${you.since} vs ${dayLabel(previous.capturedAt)}` : ""].filter(Boolean).join(", ") });

  const productRows = products.map((p, i) => {
    const brand = productBrand(p, names);
    const stores = merchantsOf(p);
    return {
      n: i + 1, name: p.name || "—", brand, isYou: !!own && sameBrand(brand, own.name),
      price: p.price || "", rating: p.rating != null ? Number(p.rating) : null, reviews: p.reviews != null ? p.reviews : null,
      sendsTo: stores[0] || "", imageFrom: host(p.image), stores: p.merchant || "",
    };
  });
  const topDest = (() => {
    const c = new Map();
    productRows.forEach((r) => { if (r.sendsTo) c.set(r.sendsTo, (c.get(r.sendsTo) || 0) + 1); });
    const t = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
    return t && t[1] > 1 ? `${t[1]} of ${productRows.length} cards send buyers to ${t[0]}.` : "";
  })();

  const passagesOf = (name) => ((rec.brandMentions || []).find((m) => sameBrand(m.brand, name)) || {}).passages || [];
  const brandRows = brands.rows.map((b) => ({
    position: b.position, name: b.name, isYou: b.isYou, count: b.count, shownOnly: b.shownOnly,
    pickedFor: extractBrandAspects(passagesOf(b.name)).slice(0, 2).join(", "),
    backing: { label: b.backing.label, tone: b.backing.tone, verdict: b.backing.verdict },
  })).sort((a, b) => (a.position || 99) - (b.position || 99));
  const weak = brandRows.find((b) => b.position && b.position <= 3 && (b.backing.verdict === "own" || b.backing.verdict === "none"));
  const brandNote = weak ? `${weak.name} was named ${weak.position === 1 ? "first" : ORD(weak.position)} with ${weak.backing.verdict === "own" ? "only its own site" : "no cited page"} behind it.` : "";

  // Every page the engine opened, cited first.
  const matrix = computeBrandMatrix(rec);
  const present = new Map((matrix.sources || []).map((s) => [s.sourceIdx, s.presentBrands || []]));
  const ctx = { ownBrand: own ? own.name : "", ownUrl: own ? own.url : "", brands: names };
  const opened = sources.map((s, i) => {
    const domain = normDomain(s.domain || s.url);
    const onPage = [...new Set((present.get(i) || []).map((n) => names.find((b) => sameBrand(b, n))).filter(Boolean))];
    return { cited: s.outcome === "cited", title: s.title || domain || s.url || "—", url: s.url || "", domain, kind: siteKindOf(domain, ctx), brands: onPage };
  }).sort((a, b) => (b.cited ? 1 : 0) - (a.cited ? 1 : 0));
  const silentRead = own ? opened.filter((p) => !p.cited && p.brands.some((n) => sameBrand(n, own.name))).map((p) => p.domain) : [];

  const doc = buildExportModel(rec);
  const words = rec.answerText ? rec.answerText.trim().split(/\s+/).length : 0;
  const technical = [
    ["Captured", dateTime(rec.capturedAt)],
    ["Engine", `${engine}${rec.model ? ` · ${rec.model}` : ""}`],
    ["Kind of answer", kind.label],
    ["Answer length", words ? `${words.toLocaleString("en-US")} words` : "not captured"],
    ["Searched the web", rec.searched || sources.length ? "yes" : "no"],
    ["Pages opened", `${sources.length} (${cited.length} cited)`],
    rec.geo && own && own.campaign ? ["Campaign", own.campaign] : null,
    rec.pageUrl && /^https?:\/\//.test(rec.pageUrl) ? ["Conversation", rec.pageUrl] : null,
    ["Capture ID", rec.captureId],
  ].filter(Boolean);

  return {
    ok: true,
    engine, prompt: rec.userPrompt || "(no prompt captured)", capturedAt: rec.capturedAt, generatedAt,
    own: own ? { name: own.name } : null,
    chips, kpis,
    you: you ? { name: you.name, tiles: you.tiles.map((t) => ({ label: t.label, value: t.value, tone: t.tone })) } : null,
    products: productRows, productNote: topDest,
    brands: brandRows, brandNote, brandNames: names,
    changes: changes ? { at: dayLabel(changes.at), items: changes.items } : null,
    answer: { html: doc.bodyHtml, footnotes: doc.footnotes.map((f) => ({ n: f.n, domain: normDomain(f.source.domain || f.source.url), title: f.source.title || "", url: f.source.url || "" })), truncated: doc.truncated, hasText: !!rec.answerText },
    technical,
    searches: { rows: searches.rows.map((r) => ({ lane: r.laneLabel.replace(" search", ""), text: r.text, tag: r.tag, detail: r.detail || "" })), unpublished: searches.unpublished },
    opened, silentRead: [...new Set(silentRead)],
    ads,
    citedKinds: pages.kinds,
  };
}

function dateTime(t) { const d = new Date(t); return `${dayLabel(t)}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`; }
