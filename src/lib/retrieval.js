/*
 * retrieval.js — where an engine's sources came from, in words a reader can
 * use.
 *
 * ChatGPT's answer stream says three different things about a source, and
 * they are easy to conflate:
 *
 *   pipeline  The retrieval system that supplied a result: `result_source`
 *             on each search result, or an engine name from the leaked
 *             engine registry below. Four values were seen: labrador (OpenAI's own
 *             index — a family of vertical indexes: web, PDF, YouTube, news,
 *             arXiv, Wikipedia, local, finance, legal, medical, shopping,
 *             images), and three external scrapes, bright (Bright Data),
 *             oxylabs (Oxylabs) and serp. OpenAI sent it from 21 May to 21
 *             July 2026 and then removed it, so only captures from that
 *             window — or from any time it returns — carry it. Nothing is
 *             inferred when it is absent: a guess presented as a label is
 *             worse than no label.
 *             Sources: Peec AI, "ChatGPT built its own search index"; Search
 *             Engine Land, "ChatGPT citations change when hidden search
 *             pipelines switch"; RESONEO, "What ChatGPT pulls, what it shows,
 *             what it cites".
 *
 *   type      `ref_id.ref_type`: what kind of result it is — web search,
 *             news, scientific paper, forum thread, video… Present on every
 *             result, including today's. Named as RESONEO names them.
 *
 *   supplier  `provider` on a local listing (and `providers` on a product):
 *             an opaque code for the feed behind it. Peec AI reports b1 as
 *             business websites and Facebook pages and b3 as Google Maps;
 *             other codes are shown as they are.
 */

/*
 * The engine registry leaked through ChatGPT's server-sent events (found by
 * Metehan Yesilyurt; listed in full by David Konitzny, Peec AI, "The Complete
 * List: Every Search Engine Hidden Inside ChatGPT's Retrieval Leak", 17
 * September 2026): 69 engines, each with a source, internal/external tags, the
 * result types it returns and its query rewriter. 47 are OpenAI's own
 * (sources labrador and labrador-web), 22 external. An engine's own tag
 * decides its side: labrador-web-fallback reaches labrador-web but is tagged
 * external. system1/system2 engines are the fast- and thinking-mode paths;
 * only system2 reaches Reddit, web PDFs and YouTube.
 *
 * [name, source, "i" internal | "e" external, result types]
 */
const ENGINE_ROWS = [
  ["labrador-aixiv", "labrador", "i", "aixiv"], ["labrador-arxiv", "labrador", "i", "arxiv"],
  ["labrador-arxiv-web", "labrador", "i", "arxiv"], ["labrador-finance", "labrador", "i", "finance"],
  ["labrador-images", "labrador", "i", "images"], ["labrador-images-nocache", "labrador", "i", "images"],
  ["labrador-knowledge-legal-pdf", "labrador", "i", "legal PDF"], ["labrador-knowledge-legal-text", "labrador", "i", "legal"],
  ["labrador-knowledge-medical-pdf", "labrador", "i", "medical PDF"], ["labrador-knowledge-medical-text", "labrador", "i", "medical"],
  ["labrador-legal", "labrador", "i", "legal"], ["labrador-local", "labrador", "i", "places"],
  ["labrador-news-1d", "labrador", "i", "news, last day"], ["labrador-news-7d", "labrador", "i", "news, last 7 days"],
  ["labrador-news-all", "labrador", "i", "news"], ["labrador-news-google-redirect-fallback", "labrador", "i", "news"],
  ["labrador-reddit-web", "labrador", "i", "reddit"], ["labrador-stem", "labrador", "i", "stem"],
  ["labrador-synthetic", "labrador", "i", "synthetic"], ["labrador-synthetic-index", "labrador", "i", "synthetic"],
  ["labrador-web-pdf", "labrador", "i", "web PDF"], ["labrador-web-youtube", "labrador", "i", "YouTube"],
  ["labrador-wiki", "labrador", "i", "wiki"], ["labrador-wiki-web", "labrador", "i", "wiki"],
  ["system1-arxiv", "labrador", "i", "arxiv"], ["system1-labrador-news-google-redirect-fallback", "labrador", "i", "news"],
  ["system1-news-1d", "labrador", "i", "news, last day"], ["system1-news-7d", "labrador", "i", "news, last 7 days"],
  ["system1-news-all", "labrador", "i", "news"], ["system1-stem", "labrador", "i", "stem"],
  ["system1-wiki", "labrador", "i", "wiki"], ["system2-arxiv", "labrador", "i", "arxiv"],
  ["system2-image", "labrador", "i", "images"], ["system2-labrador-news-google-redirect-fallback", "labrador", "i", "news"],
  ["system2-news-1d", "labrador", "i", "news, last day"], ["system2-news-7d", "labrador", "i", "news, last 7 days"],
  ["system2-news-all", "labrador", "i", "news"], ["system2-reddit", "labrador", "i", "reddit"],
  ["system2-stem", "labrador", "i", "stem"], ["system2-web-pdf", "labrador", "i", "web PDF"],
  ["system2-web-youtube", "labrador", "i", "YouTube"], ["system2-wiki", "labrador", "i", "wiki"],
  ["labrador-web", "labrador-web", "i", "web"], ["labrador-web-news-google-redirect-fallback", "labrador-web", "i", "web, news"],
  ["system1-labrador-web-fallback", "labrador-web", "i", "web"], ["system1-labrador-web-news-google-redirect-fallback", "labrador-web", "i", "web, news"],
  ["system2-web", "labrador-web", "i", "web"],
  ["bing", "bing", "e", "web, news"], ["bing-image", "bing", "e", "images"],
  ["fortis", "fortis", "e", "web, news, business"], ["fortis-barebone", "fortis_barebone", "e", "web, news, business"],
  ["foursquare", "foursquare", "e", "business"], ["getty-image", "getty", "e", "images"],
  ["labrador-web-fallback", "labrador-web", "e", "web"],
  ["mai-grounding-bing-query", "mai_grounding", "e", "web"], ["system1-mai-grounding-web", "mai_grounding", "e", "web"],
  ["mai-grounding-news", "mai_grounding_news", "e", "news"], ["system1-mai-grounding-news", "mai_grounding_news", "e", "news"],
  ["system2-mai-grounding-news", "mai_grounding_news", "e", "news"],
  ["serpapi-image", "serpapi_auto_image", "e", "images"], ["system1-image", "serpapi_auto_image", "e", "images"],
  ["serpapi-news", "serpapi_auto_news", "e", "news"], ["serpapi-news-tab", "serpapi_auto_news", "e", "news"],
  ["serpapi-news-tab-light", "serpapi_auto_news", "e", "news"], ["system1-news-serpapi", "serpapi_auto_news", "e", "news"],
  ["system2-news-serpapi", "serpapi_auto_news", "e", "news"],
  ["serpapi", "serpapi_auto_web", "e", "web, news"], ["system1-web", "serpapi_auto_web", "e", "web, news"],
  ["yelp", "yelp", "e", "business"],
];
export const ENGINES = new Map(ENGINE_ROWS.map(([name, source, tier, results]) => [name, {
  name, source, results,
  internal: tier === "i",
  mode: name.startsWith("system1-") ? "fast" : name.startsWith("system2-") ? "thinking" : null,
}]));

// Sources, and the pipeline values ChatGPT sent as result_source (21 May -
// 21 July 2026), in plain words.
const SOURCES = {
  labrador: { label: "Labrador", kind: "openai", note: "OpenAI's own search index" },
  "labrador-web": { label: "Labrador", kind: "openai", note: "OpenAI's own web index (labrador-web)" },
  bing: { label: "Bing", kind: "external", note: "Microsoft Bing" },
  serpapi_auto_web: { label: "SerpAPI", kind: "external", note: "SerpAPI — scraped Google web results" },
  serpapi_auto_news: { label: "SerpAPI", kind: "external", note: "SerpAPI — scraped Google News results" },
  serpapi_auto_image: { label: "SerpAPI", kind: "external", note: "SerpAPI — scraped Google Images results" },
  mai_grounding: { label: "Microsoft grounding", kind: "external", note: "Microsoft's MAI grounding service (web)" },
  mai_grounding_news: { label: "Microsoft grounding", kind: "external", note: "Microsoft's MAI grounding service (news, in beta)" },
  fortis: { label: "Fortis", kind: "external", note: "External provider, not publicly identified" },
  fortis_barebone: { label: "Fortis", kind: "external", note: "External provider, not publicly identified (barebone)" },
  getty: { label: "Getty Images", kind: "external", note: "Getty Images" },
  yelp: { label: "Yelp", kind: "external", note: "Yelp business listings" },
  foursquare: { label: "Foursquare", kind: "external", note: "Foursquare business listings" },
  bright: { label: "Bright Data", kind: "external", note: "External scrape of Google results (Bright Data)" },
  oxylabs: { label: "Oxylabs", kind: "external", note: "External scrape of Google results, mostly news (Oxylabs)" },
  serp: { label: "SERP", kind: "external", note: "External search-results scrape, mostly news" },
};

/** Is this exactly an engine or source name ChatGPT is known to use? */
export function isKnownRetrievalName(code) {
  if (typeof code !== "string") return false;
  const key = code.trim().toLowerCase();
  return ENGINES.has(key) || Object.prototype.hasOwnProperty.call(SOURCES, key);
}

/**
 * The retrieval pipeline behind a result — from an engine name
 * ("labrador-news-7d"), a source ("serpapi_auto_web") or a result_source value
 * ("bright") — or null if none was given. An unfamiliar value is shown as
 * sent, on neither side.
 */
export function pipelineOf(code) {
  if (typeof code !== "string" || !code.trim()) return null;
  const key = code.trim().toLowerCase();
  const engine = ENGINES.get(key);
  if (engine) {
    const src = SOURCES[engine.source] || { label: engine.source };
    const kind = engine.internal ? "openai" : "external";
    const mode = engine.mode ? `, ${engine.mode}-mode path` : "";
    return {
      code: key, engine: key,
      // labrador-web-fallback reaches OpenAI's web index but is tagged external.
      label: engine.internal ? "Labrador" : engine.source.startsWith("labrador") ? "Labrador fallback" : src.label,
      kind,
      note: `${key}: ${engine.internal ? "OpenAI's own index" : engine.source.startsWith("labrador") ? "OpenAI's web index, on a path tagged external" : src.note || "external"} — ${engine.results}${mode}`,
    };
  }
  const known = SOURCES[key];
  return known ? { code: key, ...known } : { code: key, label: code.trim(), kind: "unknown", note: "Pipeline named by ChatGPT" };
}

const TYPES = {
  search: "Web",
  news: "News",
  academia: "Scientific",
  reddit: "Forum",
  youtube: "Video",
  video: "Video",
  business: "Local",
  local: "Local",
  product: "Product",
  products: "Product",
  image: "Image",
  images: "Image",
  weather: "Weather",
};

/** A result's type (ref_type) as a label; an unfamiliar value is shown as it is. */
export function typeLabel(refType) {
  if (typeof refType !== "string" || !refType) return null;
  return TYPES[refType.toLowerCase()] || refType;
}

const SUPPLIERS = {
  b1: "Business websites and Facebook pages (per Peec AI)",
  b3: "Google Maps (per Peec AI)",
  serp: "External search-results scrape",
  yelp: "Yelp",
  tripadvisor: "Tripadvisor",
};

/** A listing's supplier code with what is publicly known about it. "deprecated" is ChatGPT's placeholder, not a supplier. */
export function supplierOf(code) {
  if (typeof code !== "string" || !code || code === "deprecated") return null;
  const key = code.toLowerCase();
  return { code: key, note: SUPPLIERS[key] || null };
}

/*
 * How one capture's sources split by pipeline and by type, for the summary
 * line above a source list and for campaign totals. `unlabelled` counts
 * sources ChatGPT gave no pipeline for — every source after 21 July 2026.
 */
export function retrievalMix(sources) {
  const pipelines = new Map();
  const types = new Map();
  let unlabelled = 0;
  let openai = 0;
  let external = 0;
  for (const s of sources || []) {
    const ps = s.platformSpecific || {};
    const p = pipelineOf(ps.pipeline);
    if (p) {
      const key = `${p.kind}|${p.label}`;
      const cur = pipelines.get(key) || { label: p.label, kind: p.kind, count: 0 };
      cur.count++;
      pipelines.set(key, cur);
      if (p.kind === "openai") openai++;
      else if (p.kind === "external") external++;
    } else unlabelled++;
    const t = typeLabel(ps.refType || ps.resultSource);
    if (t) types.set(t, (types.get(t) || 0) + 1);
  }
  const byCount = (a, b) => b.count - a.count;
  return {
    pipelines: [...pipelines.values()].sort(byCount),
    types: [...types.entries()].map(([label, count]) => ({ label, count })).sort(byCount),
    unlabelled, openai, external, total: (sources || []).length,
  };
}

/*
 * Every known engine name that appears as a JSON string in a capture, with
 * how often: what the stream itself says about which engines were involved.
 * Exact, quoted matches only, so an engine is listed only when the payload
 * names it. Empty for captures without the leaked retrieval data.
 */
const ENGINE_NAME_RE = new RegExp(
  `"(${[...ENGINES.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[-]/g, "\\-")).join("|")})"`,
  "g",
);
export function enginesNamedIn(rawText) {
  const counts = new Map();
  for (const m of String(rawText || "").matchAll(ENGINE_NAME_RE)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 40);
}
