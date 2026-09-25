/*
 * chatgpt-retrieval.test.mjs — which index each ChatGPT source came from.
 *
 * Peec AI's "ChatGPT built its own search index" (and Search Engine Land and
 * RESONEO on the same data) documented a `result_source` field ChatGPT sent
 * on every search result from 21 May to 21 July 2026: labrador (OpenAI's own
 * index), bright (Bright Data), oxylabs (Oxylabs) and serp. The adapter now
 * keeps it as the source's `pipeline`, alongside the kind of result
 * (`ref_type`: web, news, scientific, forum, video…) and, for local listings
 * and products, the supplier code (b1, b3, serp, p2…). Engine names from the
 * leaked retrieval registry (David Konitzny, Peec AI, 17 September 2026: 69
 * engines, 47 internal, 22 external) are recognised too, on a result or
 * anywhere in the stream — by exact name only.
 *
 * The labelled payload below is SYNTHETIC — built in the documented shape,
 * no real conversation. The unlabelled cases are the repository's real
 * captures, which predate or postdate that window: they must come out with
 * types and suppliers, and with no pipeline at all rather than a guessed one.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/chatgpt.js";
import { pipelineOf, typeLabel, supplierOf, retrievalMix, ENGINES, enginesNamedIn } from "../src/lib/retrieval.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const fixture = (name) => {
  const t = readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
  return { raw: t.slice(t.indexOf("\n\n") + 2), reqBody: (t.match(/^# reqBody: (.*)$/m) || [])[1] || "{}" };
};

console.log("\nLabels");
{
  check("labrador is OpenAI's own index", pipelineOf("labrador")?.kind === "openai" && pipelineOf("Labrador")?.label === "Labrador");
  check("bright, oxylabs and serp are external", ["bright", "oxylabs", "serp"].every((c) => pipelineOf(c)?.kind === "external"));
  check("bright reads as Bright Data", pipelineOf("bright")?.label === "Bright Data");
  check("an unfamiliar pipeline is shown as sent, not dropped", pipelineOf("webiq")?.label === "webiq");
  check("no pipeline is no label", pipelineOf(undefined) === null && pipelineOf("") === null);
  check("ref_type reads as a kind", typeLabel("academia") === "Scientific" && typeLabel("reddit") === "Forum" && typeLabel("search") === "Web");
  check("an unfamiliar kind is shown as sent", typeLabel("weather_v2") === "weather_v2");
  check("b1 and b3 carry what is publicly reported", /Facebook/.test(supplierOf("b1")?.note || "") && /Google Maps/.test(supplierOf("b3")?.note || ""));
  check("'deprecated' is ChatGPT's placeholder, not a supplier", supplierOf("deprecated") === null);
}

console.log("\nThe leaked engine registry");
{
  const all = [...ENGINES.values()];
  check("69 engines: 47 OpenAI's own, 22 external", all.length === 69 && all.filter((e) => e.internal).length === 47, `${all.length}/${all.filter((e) => e.internal).length}`);
  check("labrador-news-7d is Labrador, last-7-days news", pipelineOf("labrador-news-7d")?.kind === "openai" && /last 7 days/.test(pipelineOf("labrador-news-7d")?.note));
  check("system2 engines are the thinking-mode paths", /thinking-mode/.test(pipelineOf("system2-web-youtube")?.note || ""));
  check("labrador-web-fallback is external, as tagged", pipelineOf("labrador-web-fallback")?.kind === "external" && pipelineOf("labrador-web-fallback")?.label === "Labrador fallback");
  check("serpapi, mai grounding, fortis, yelp are external", ["serpapi", "mai-grounding-news", "fortis", "yelp", "getty-image"].every((n) => pipelineOf(n)?.kind === "external"));
  check("sources resolve too", pipelineOf("serpapi_auto_web")?.label === "SerpAPI" && pipelineOf("labrador-web")?.kind === "openai");
  check("an unfamiliar name is on neither side", pipelineOf("webiq")?.kind === "unknown");
  const named = enginesNamedIn(JSON.stringify({ calls: [{ engine: "labrador-news-7d", q: "a" }, { engine: "serpapi" }, { engine: "serpapi" }], other: "labrador-news-7d-x", text: "yelp and bing in prose" }));
  check("the stream's engine names are counted, exactly", JSON.stringify(named) === JSON.stringify([{ name: "serpapi", count: 2 }, { name: "labrador-news-7d", count: 1 }]), JSON.stringify(named));
}

console.log("\nA stream that names each result's pipeline");
{
  const result = (url, title, refType, i, source) => ({
    type: "search_result", url, title, snippet: `${title} snippet`,
    ref_id: { turn_index: 0, ref_type: refType, ref_index: i }, pub_date: null, attribution: new URL(url).hostname,
    ...(source ? { result_source: source } : {}),
  });
  const groups = [
    { type: "search_result_group", domain: "reviews.example", entries: [result("https://reviews.example/a", "Review A", "search", 0, "labrador")] },
    { type: "search_result_group", domain: "news.example", entries: [result("https://news.example/b", "Story B", "news", 1, "oxylabs")] },
    { type: "search_result_group", domain: "shop.example", entries: [result("https://shop.example/c", "Shop C", "search", 2, "bright")] },
    { type: "search_result_group", domain: "papers.example", entries: [result("https://papers.example/d", "Paper D", "academia", 3, "labrador")] },
    { type: "search_result_group", domain: "blog.example", entries: [result("https://blog.example/e", "Blog E", "search", 4, null)] },
    // An engine name on the result instead of result_source; and a "source"
    // field that is not a retrieval name at all.
    { type: "search_result_group", domain: "tube.example", entries: [{ ...result("https://tube.example/f", "Video F", "youtube", 5, null), engine: "system2-web-youtube" }] },
    { type: "search_result_group", domain: "forum.example", entries: [{ ...result("https://forum.example/g", "Thread G", "reddit", 6, null), source: "reddit" }] },
  ];
  // The same page shown as a citation too — the cited copy carries no
  // result_source; the label must survive the merge.
  const cited = { url: "https://reviews.example/a", title: "Review A", attribution: "reviews.example", refs: [{ turn_index: 0, ref_type: "search", ref_index: 0 }] };
  const raw = [
    `data: ${JSON.stringify({ message: { author: { role: "assistant" }, content: { parts: ["Answer text."] }, metadata: { search_result_groups: groups, content_references: [{ type: "grouped_webpages", items: [cited] }] } } })}`,
    "data: [DONE]",
  ].join("\n");
  const r = await adapt({ captureId: "t1", raw, reqBody: "{}", capturedAt: 1, pageUrl: "https://chatgpt.com/" }, {});
  const by = new Map(r.sources.map((s) => [s.url, s]));
  const pipe = (u) => by.get(u)?.platformSpecific?.pipeline;
  check("a labrador result is labelled labrador", pipe("https://reviews.example/a") === "labrador", pipe("https://reviews.example/a"));
  check("and keeps it once it is also cited", by.get("https://reviews.example/a")?.outcome === "cited", by.get("https://reviews.example/a")?.outcome);
  check("oxylabs and bright results keep theirs", pipe("https://news.example/b") === "oxylabs" && pipe("https://shop.example/c") === "bright");
  check("a result sent without one has none", pipe("https://blog.example/e") === undefined, pipe("https://blog.example/e"));
  check("an engine name on a result is its pipeline", pipe("https://tube.example/f") === "system2-web-youtube", pipe("https://tube.example/f"));
  check("a 'source' that isn't a retrieval name is ignored", pipe("https://forum.example/g") === undefined, pipe("https://forum.example/g"));
  check("the record lists the engines its stream names", JSON.stringify((r.platformSpecific || {}).enginesNamed) === JSON.stringify([{ name: "system2-web-youtube", count: 1 }]),
    JSON.stringify((r.platformSpecific || {}).enginesNamed));
  check("each carries its kind", by.get("https://papers.example/d")?.platformSpecific?.refType === "academia");
  const mix = retrievalMix(r.sources);
  check("the mix counts OpenAI's index and external scrapes apart", mix.openai === 3 && mix.external === 2 && mix.unlabelled === 2, JSON.stringify(mix));
  check("Labrador leads the pipeline list", mix.pipelines[0]?.label === "Labrador" && mix.pipelines[0]?.count === 3, JSON.stringify(mix.pipelines));
}

console.log("\nReal captures from outside that window");
{
  const { raw, reqBody } = fixture("chatgpt-jewellery-wedding");
  const r = await adapt({ captureId: "t2", raw, reqBody, capturedAt: 1, pageUrl: "https://chatgpt.com/" }, {});
  const mix = retrievalMix(r.sources);
  check("no source is given a pipeline ChatGPT didn't send", mix.pipelines.length === 0 && mix.unlabelled === r.sources.length, JSON.stringify(mix.pipelines));
  check("and no engines are listed", !(r.platformSpecific || {}).enginesNamed);
  check("kinds still come through", mix.types.some((t) => t.label === "Scientific") && mix.types.some((t) => t.label === "Forum"), JSON.stringify(mix.types));
  const places = r.places || (r.platformSpecific || {}).places || [];
  check("local listings carry their supplier", places.length > 0 && places.every((p) => p.supplier === "b1"), JSON.stringify(places.map((p) => p.supplier)));
}
{
  const { raw, reqBody } = fixture("chatgpt-tv");
  const r = await adapt({ captureId: "t3", raw, reqBody, capturedAt: 1, pageUrl: "https://chatgpt.com/" }, {});
  const products = r.products || (r.platformSpecific || {}).products || [];
  check("products carry their supplier code, not 'deprecated'", products.length > 0 && products.every((p) => p.supplier === "p2"), JSON.stringify(products.map((p) => p.supplier)));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
