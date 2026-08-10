/*
 * Regression tests for the ChatGPT adapter against REAL captured payloads.
 * Run: node test/adapter.test.mjs
 *
 * Fixtures are raw debug exports from the extension (with the leading `# ` header
 * lines that downloadRaw() writes). Add more by dropping a *.txt export into
 * test/fixtures and appending an expectation block below.
 */
import { adapt } from "../src/adapters/chatgpt.js";
import { adapt as adaptGemini } from "../src/adapters/gemini.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

function loadFixture(name, adapter = adapt) {
  const txt = readFileSync(join(FIX, name), "utf8");
  const lines = txt.split(/\r?\n/);
  const reqBody = (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") || "{}";
  const raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
  return adapter({ captureId: name, raw, reqBody, capturedAt: Date.now() });
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}  ${detail}`);
  }
}

// --- chatgpt-search-40k.txt : a shopping/search turn with products ---
{
  console.log("chatgpt-search-40k.txt");
  const r = loadFixture("chatgpt-search-40k.txt");
  const cited = r.sources.filter((s) => s.outcome === "cited");
  const fetched = r.sources.filter((s) => s.outcome === "fetched");
  check("prompt extracted", !!r.userPrompt, `got ${r.userPrompt}`);
  check("model = gpt-5-5", r.model === "gpt-5-5", `got ${r.model}`);
  check("turn_use_case = shopping", r.turnUseCase === "shopping", `got ${r.turnUseCase}`);
  check("no shape fallback", r._extraction.usedFallback === false);
  check("fan-out captured", r.fanout.search.length >= 1, `got ${r.fanout.search.length}`);
  check("has cited sources", cited.length >= 1, `cited=${cited.length}`);
  check("has fetched sources", fetched.length >= 1, `fetched=${fetched.length}`);
  check("fetched > cited (fetched-but-not-cited gap)", fetched.length > cited.length, `${fetched.length} vs ${cited.length}`);
  check("products extracted", r.products.length >= 1, `got ${r.products.length}`);
  check("product has price", r.products.every((p) => p.name) && r.products.some((p) => p.price));
  check("domains are hostnames not display names", r.sources.every((s) => !/\s/.test(s.domain || "")));
  check("no utm params in urls", r.sources.every((s) => !/utm_source/.test(s.url || "")));
  // depth extraction (delta reducer)
  check("answer text reconstructed", r.answerChars > 0, `got ${r.answerChars}`);
  check("reference types counted", Object.keys(r.referenceTypes).length >= 1, JSON.stringify(r.referenceTypes));
  check("ref counts are sane (no delta inflation)", Object.values(r.referenceTypes).every((n) => n < 50));
  check("brand mentions found", r.brandMentions.length >= 1, `got ${r.brandMentions.length}`);
  check("brand mention has passage", r.brandMentions.every((b) => b.passages[0]));
  check("products carousel flagged", r.carousels.products === true);
  // resultSource pipeline + entities/images/news depth
  check("sources tagged with resultSource", r.sources.some((s) => s.platformSpecific.resultSource));
  check("entities categorized", r.entities.length >= 1 && r.entities.every((e) => e.category && e.text));
  check("entity categories incl Product", r.entities.some((e) => e.category === "Product"));
  check("images extracted", r.images.length >= 1 && r.images.every((i) => /^https?:/.test(i.url)));
  check("news sources carry pubDate", r.sources.filter((s) => s.type === "news").every((s) => s.platformSpecific.pubDate));
}

// --- chatgpt-search-60k.txt : text-heavy answer with array-op deltas ---
{
  console.log("\nchatgpt-search-60k.txt");
  const r = loadFixture("chatgpt-search-60k.txt");
  check("answer fully reconstructed (>1400 chars)", r.answerChars > 1400, `got ${r.answerChars}`);
  const brands = r.brandMentions.map((b) => b.brand);
  check("OPPO captured (array-op reconstruction)", brands.includes("Oppo"), brands.join(","));
  check("multiple brands captured", brands.length >= 4, brands.join(","));
  check("no duplicate-case brands", new Set(brands.map((b) => b.toLowerCase())).size === brands.length);
  check("fetched-but-not-cited gap present", r.sources.filter((s) => s.outcome === "fetched").length > r.sources.filter((s) => s.outcome === "cited").length);
}

// --- gemini-streamgenerate.txt : real Gemini Flash-Lite StreamGenerate ---
{
  console.log("\ngemini-streamgenerate.txt");
  const r = loadFixture("gemini-streamgenerate.txt", adaptGemini);
  check("platform is gemini", r.platform === "gemini");
  check("prompt extracted from reqBody", r.userPrompt === "best camera phone under 50K", `got ${r.userPrompt}`);
  check("searched = true", r.searched === true);
  check("no shape fallback", r._extraction.usedFallback === false);
  check("citations extracted", r.sources.length >= 10, `got ${r.sources.length}`);
  check("citations are cited", r.sources.every((s) => s.outcome === "cited"));
  check("citations have titles", r.sources.every((s) => s.title));
  check("domains are real hosts", r.sources.some((s) => s.domain === "cashkr.com"));
  check("no gstatic favicons leaked", r.sources.every((s) => !/gstatic/.test(s.url)));
}

// --- gemini-pro-shopping.txt : Pro model, product/shopping response ---
{
  console.log("\ngemini-pro-shopping.txt");
  const r = loadFixture("gemini-pro-shopping.txt", adaptGemini);
  check("model detected as Pro", /Pro/.test(r.model), `got ${r.model}`);
  check("model detection survives 0 citations", r.model !== "gemini");
  check("no shape fallback", r._extraction.usedFallback === false);
  check("products extracted", r.products.length >= 3, `got ${r.products.length}`);
  check("products have price", r.products.every((p) => p.name && p.price));
  check("products have merchant/rating", r.products.some((p) => p.merchant && p.rating));
  check("answer text extracted", r.answerChars > 0, `got ${r.answerChars}`);
  check("entities categorized", r.entities.length >= 1);
  check("response type classified", r.turnUseCase === "shopping", `got ${r.turnUseCase}`);
  check("Pro reasoning trace captured", !!(r.platformSpecific && r.platformSpecific.reasoning));
}

// --- gemini-jewellery-shopping.txt : non-phone category proves generalized product extraction ---
{
  console.log("\ngemini-jewellery-shopping.txt");
  const r = loadFixture("gemini-jewellery-shopping.txt", adaptGemini);
  check("model detected as Flash", /Flash/.test(r.model), `got ${r.model}`);
  check("no shape fallback", r._extraction.usedFallback === false);
  check("products extracted (non-phone category)", r.products.length >= 5, `got ${r.products.length}`);
  check("products have price", r.products.every((p) => p.price));
  check("citations also present", r.sources.length >= 1);
  check("response type = shopping", r.turnUseCase === "shopping");
}

// --- gemini-local-places.txt : Maps/local response ---
{
  console.log("\ngemini-local-places.txt");
  const r = loadFixture("gemini-local-places.txt", adaptGemini);
  check("no shape fallback", r._extraction.usedFallback === false);
  check("places extracted", r.places.length >= 3, `got ${r.places.length}`);
  check("places have name+category+rating", r.places.every((p) => p.name && p.category && p.rating != null));
  check("places have address", r.places.every((p) => p.address));
  check("response type = local", r.turnUseCase === "local");
  check("searched = true", r.searched === true);
}

console.log(`\nfixtures on disk: ${readdirSync(FIX).join(", ")}`);
console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
