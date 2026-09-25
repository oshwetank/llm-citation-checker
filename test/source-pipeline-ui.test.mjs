/*
 * source-pipeline-ui.test.mjs — a capture's sources show which index they
 * came from, in the real panel.
 *
 * Requested after Peec AI's "ChatGPT built its own search index": highlight
 * the sources that came from OpenAI's own index (Labrador) against those
 * from external web scrapes. ChatGPT named the pipeline per result only from
 * 21 May to 21 July 2026, so the view must show it where it exists and say
 * plainly when it doesn't — never guess. See lib/retrieval.js.
 *
 * Two captures go through the real pipeline (raw-conversation → adapter →
 * store → Analyze): a real repository capture with no pipeline field, then a
 * SYNTHETIC one in the documented shape with labrador / oxylabs / bright
 * results. The panel opens on the latest capture each time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-source-pipeline-test";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
    try { pw = req(c); break; } catch (_) { /* next */ }
  }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log("\nsource-pipeline-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a requested feature, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const result = (url, title, refType, i, source) => ({
  type: "search_result", url, title, snippet: `${title} snippet`,
  ref_id: { turn_index: 0, ref_type: refType, ref_index: i }, attribution: new URL(url).hostname,
  ...(source ? { result_source: source } : {}),
});
const LABELLED = [
  `data: ${JSON.stringify({ message: { author: { role: "assistant" }, content: { parts: ["Answer text for the labelled capture."] }, metadata: {
    search_result_groups: [
      { type: "search_result_group", domain: "reviews.example", entries: [result("https://reviews.example/a", "Review A", "search", 0, "labrador")] },
      { type: "search_result_group", domain: "papers.example", entries: [result("https://papers.example/d", "Paper D", "academia", 1, "labrador")] },
      { type: "search_result_group", domain: "news.example", entries: [result("https://news.example/b", "Story B", "news", 2, "oxylabs")] },
      { type: "search_result_group", domain: "shop.example", entries: [result("https://shop.example/c", "Shop C", "search", 3, "bright")] },
      { type: "search_result_group", domain: "blog.example", entries: [result("https://blog.example/e", "Blog E", "search", 4, null)] },
    ],
    // Retrieval calls naming engines from the leaked registry.
    retrieval_calls: [{ engine: "labrador-news-7d", query: "q1" }, { engine: "labrador-news-7d", query: "q2" }, { engine: "serpapi", query: "q3" }],
  } } })}`,
  "data: [DONE]",
].join("\n");
const fx = readFileSync(path.join(HERE, "fixtures", "chatgpt-finance-trading.txt"), "utf8");
const UNLABELLED = fx.slice(fx.indexOf("\n\n") + 2);

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

// A returning user: no first-run tour over the panel (its backdrop takes
// every click).
await context.addInitScript(() => {
  try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* private mode */ }
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const send = async (raw) => {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/ui/panel.html`);
    await p.waitForTimeout(500);
    await p.evaluate((raw) => new Promise((res) => chrome.runtime.sendMessage({
      type: "raw-conversation",
      payload: { raw, reqBody: "{}", pageUrl: "https://chatgpt.com/", capturedAt: Date.now() },
    }, res)), raw);
    await p.close();
  };
  const openLatest = async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
    await page.waitForSelector("#card-sources", { timeout: 15000 });
    return page;
  };

  console.log("\nA capture ChatGPT didn't label says so, and still shows kinds");
  await send(UNLABELLED);
  {
    const page = await openLatest();
    const mix = await page.$eval("#card-sources .retrieval-mix", (n) => n.innerText.replace(/\s+/g, " ").trim()).catch(() => null);
    check("the pipeline line says it isn't labelled, and when it was", !!mix && /not labelled/.test(mix) && /21 May to 21 July 2026/.test(mix), mix);
    check("and lists the kinds of result", !!mix && /Scientific/.test(mix) && /Forum/.test(mix), mix);
    check("no source wears a pipeline chip", (await page.$$("#card-sources .tag.pipe-openai, #card-sources .tag.pipe-external")).length === 0);
    check("and no engine line appears", (await page.$$("#card-sources .engines-named")).length === 0);
    check("sources carry a kind chip instead of 'src: …'", (await page.$$("#card-sources .tag.src-type")).length > 0
      && !(await page.$eval("#card-sources", (n) => /src: /.test(n.innerText))));
    await page.close();
  }

  console.log("\nA capture ChatGPT labelled shows Labrador apart from external web");
  await send(LABELLED);
  {
    const page = await openLatest();
    const mix = await page.$eval("#card-sources .retrieval-mix", (n) => n.innerText.replace(/\s+/g, " ").trim()).catch(() => null);
    check("the pipeline line counts each", !!mix && /Labrador 2/.test(mix) && /Oxylabs 1/.test(mix) && /Bright Data 1/.test(mix) && /1 not labelled/.test(mix), mix);
    const openai = await page.$$eval("#card-sources .srclist .tag.pipe-openai", (ns) => ns.map((n) => n.textContent));
    const ext = await page.$$eval("#card-sources .srclist .tag.pipe-external", (ns) => ns.map((n) => n.textContent));
    check("Labrador sources are highlighted", openai.length === 2 && openai.every((t) => t === "Labrador"), JSON.stringify(openai));
    check("external ones say so", ext.includes("Web · Oxylabs") && ext.includes("Web · Bright Data"), JSON.stringify(ext));
    const tealBg = await page.$eval("#card-sources .srclist .tag.pipe-openai", (n) => getComputedStyle(n).backgroundColor);
    check("in their own colour", tealBg && tealBg !== "rgba(0, 0, 0, 0)" && tealBg !== "transparent", tealBg);
    const engines = await page.$$eval("#card-sources .engines-named .tag", (ns) => ns.map((n) => ({ t: n.textContent, own: n.classList.contains("pipe-openai") })));
    check("the engines the stream names are listed, OpenAI's own apart",
      JSON.stringify(engines) === JSON.stringify([{ t: "labrador-news-7d ×2", own: true }, { t: "serpapi", own: false }]), JSON.stringify(engines));
    const pill = await page.$$eval("#card-sources .filter-pill", (ns) => ns.map((n) => n.textContent));
    check("with Labrador and External web filters", pill.includes("Labrador (2)") && pill.includes("External web (2)"), JSON.stringify(pill));
    check("and the News filter counts what the kind chip calls news", pill.includes("News (1)"), JSON.stringify(pill));
    await page.click("#card-sources .filter-pill:has-text('Labrador (2)')");
    const shown = await page.$$eval("#card-sources .srclist .src-item .src-title", (ns) => ns.map((n) => n.textContent));
    check("the Labrador filter shows just those", shown.length === 2 && shown.includes("Review A") && shown.includes("Paper D"), JSON.stringify(shown));
    await page.close();
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
