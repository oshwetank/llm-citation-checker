/*
 * The AI engines (0.74.0). Run: node test/ai-engines.test.mjs
 *
 * The owner: "if we run with 1 core and download the small model the
 * overall output quality and speed will be bad, find a better solution".
 * Checked here:
 *   - extension pages are cross-origin isolated, so the downloaded model
 *     runs on several processor threads, not one;
 *   - "Test this computer" times each engine on the same made-up answer and
 *     scores it (a stand-in model's noise fails);
 *   - Chrome's own built-in AI (a stand-in in the worker) is found, passes,
 *     and is chosen; a capture is checked with one schema-held reply;
 *   - the engine can be chosen by hand;
 *   - the AI page closes itself when idle (freeing the model's memory) and
 *     opens again on the next job.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const MODEL_DIR = path.join(HERE, "fixtures", "llm-tiny");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-ai-engines-test";

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
  console.log(`\nbuiltin-ai: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// "/tiny/resolve/main/<file>" -> test/fixtures/llm-tiny/<file>
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  const m = /^\/tiny\/resolve\/main\/(.+)$/.exec(decodeURIComponent(req.url.split("?")[0]));
  const file = m && path.join(MODEL_DIR, m[1]);
  const headers = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length" };
  if (!file || !file.startsWith(MODEL_DIR) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end(); }
  const body = readFileSync(file);
  res.writeHead(200, { ...headers, "content-length": body.length, "content-type": "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${server.address().port}/`;

const fixture = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const waitFor = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await page.waitForTimeout(300); } return null; };
  const record = async (id) => ((await msg({ type: "get-record", captureId: id })) || {}).record || null;
  const offscreenOpen = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length);

  console.log("\nextension pages are cross-origin isolated, so the model gets several processor threads");
  check("the panel is isolated", await page.evaluate(() => self.crossOriginIsolated === true));

  console.log("\nthe downloaded model (a stand-in), tested on this computer");
  await msg({ type: "ai-test-model", model: { repo: "tiny", host: HOST, dtype: "fp32" } });
  await msg({ type: "ai-download", device: "wasm" });
  const s0 = await waitFor(async () => { const x = await msg({ type: "ai-status" }); return x.ready || x.error ? x : null; }, 90000);
  check("ready, on the processor", s0 && s0.ready && s0.engine && s0.engine.id === "qwen", JSON.stringify(s0 && { r: s0.ready, e: s0.engine, err: s0.error }));
  const b0 = await msg({ type: "ai-benchmark" });
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  check("the test ran and timed it", b0 && b0.ok && b0.bench.qwen && Number.isFinite(b0.bench.qwen.ms), JSON.stringify(b0));
  // Half the cores, at most 4 (1.0.0): every core but one ran a laptop hot.
  const want = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  check(`with ${want} threads: half the cores, at most 4`, b0.bench.qwen.threads === want, String(b0.bench.qwen.threads));
  check("the stand-in's noise fails the quality test", b0.bench.qwen.ok === false && b0.bench.qwen.score < 3, JSON.stringify(b0.bench.qwen));
  // This Chromium has the Prompt API but no model fetched ("downloadable").
  check("Chrome's model isn't ready here, and the test says why", b0.bench.nano && b0.bench.nano.ok === false && ["unavailable", "downloadable", "downloading"].includes(b0.bench.nano.availability), JSON.stringify(b0.bench.nano));

  console.log("\nChrome's built-in AI, where Chrome has it (a stand-in inside the worker)");
  await sw.evaluate(() => {
    const GOOD = JSON.stringify({ lang: "en", market: { country: "DE", currency: "EUR", scope: "local", evidence: ["Berlin"] }, intent: "best_top", funnel: "decision", audience: "consumer", vertical: "home appliances", topics: { en: ["robot vacuums"], orig: ["robot vacuums"] },
      entities: [{ name: "Zento Glide 3", type: "product", owner: null, stance: "recommended", quote: "I'd recommend the **Zento Glide 3**" }, { name: "Kovo S2", type: "product", owner: null, stance: "advised_against", quote: "I would not recommend it" }],
      missed: [{ name: "Brisa Pro", type: "product", quote: "the Brisa Pro from Brisa Home" }] });
    globalThis.__nanoCalls = [];
    globalThis.LanguageModel = {
      availability: async () => "available",
      create: async (o) => {
        const mk = () => ({
          clone: async () => mk(),
          append: async () => {},
          prompt: async (text, opts) => { globalThis.__nanoCalls.push({ schema: !!(opts && opts.responseConstraint), sys: (o && o.initialPrompts || []).length }); return /Zento Glide 3/.test(text) ? GOOD : JSON.stringify({ lang: "en", entities: [], missed: [] }); },
          destroy: () => {},
        });
        return mk();
      },
    };
  });
  const s1 = await msg({ type: "ai-status" });
  check("found, and chosen: it answers faster and costs no download", s1.nano === "available" && s1.engine && s1.engine.id === "nano", JSON.stringify({ n: s1.nano, e: s1.engine }));
  const b1 = await msg({ type: "ai-benchmark" });
  check("it passes the quality test", b1.bench.nano && b1.bench.nano.ok && b1.bench.nano.score >= 4, JSON.stringify(b1.bench.nano));
  const calls = await sw.evaluate(() => globalThis.__nanoCalls);
  check("one reply per answer, held to a JSON schema", calls.length === 1 && calls[0].schema, JSON.stringify(calls));
  const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
  const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  const rec = await waitFor(async () => { const r = await record(res.captureId); return r && r.aiStatus === "done" ? r : null; }, 60000);
  check("a new capture is checked by Chrome's model", rec && rec.ai && rec.ai.engine === "nano" && rec.ai.modelRepo === "chrome-nano", JSON.stringify(rec && rec.ai && { e: rec.ai.engine, m: rec.ai.modelRepo }));

  console.log("\nchoosing the engine by hand");
  await msg({ type: "ai-set-engine", engine: "qwen" });
  check("the downloaded model, when asked for", (await msg({ type: "ai-status" })).engine.id === "qwen");
  await msg({ type: "ai-set-engine", engine: "auto" });
  check("back to automatic: Chrome's model again", (await msg({ type: "ai-status" })).engine.id === "nano");

  console.log("\nmemory is given back when the AI is idle");
  await msg({ type: "ai-set-engine", engine: "qwen" });
  await msg({ type: "ai-check-now", record: { captureId: "x", answerText: "Zento is fine.", userPrompt: "q", brandMentions: [] } });
  check("the AI page is open while it works", (await offscreenOpen()) === 1);
  await msg({ type: "ai-test-offscreen-idle", ms: 3000 });
  const closed = await waitFor(async () => ((await offscreenOpen()) === 0 ? true : null), 20000);
  check("then closes itself when idle, freeing the model's memory", closed === true);
  const again = await msg({ type: "ai-check-now", record: { captureId: "y", answerText: "Kovo is fine.", userPrompt: "q", brandMentions: [] } });
  check("and opens again on the next job", again && again.ok && (await offscreenOpen()) === 1, JSON.stringify(again && again.error));

  console.log("\nSettings → Built-in AI shows the engines and the test");
  await msg({ type: "ai-set-engine", engine: "auto" });
  const tab = await context.newPage();
  tab.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.evaluate(() => { document.querySelector('[data-tab="about"]')?.click(); });
  await tab.waitForTimeout(400);
  await tab.evaluate(() => { [...document.querySelectorAll(".ab-nav-btn")].find((b) => /Settings/.test(b.textContent))?.click(); });
  // The detailed options are under More settings → Built-in AI (1.0.6).
  await tab.evaluate(() => { const d = document.getElementById("setGroupMore"); if (d) d.open = true; });
  await tab.waitForSelector("#aiEngineSeg", { timeout: 15000 }).catch(() => {});
  // From 0.84.0 the engine choice and the test sit under More options.
  await tab.evaluate(() => { const d = document.getElementById("aiMore"); if (d) d.open = true; });
  await tab.waitForTimeout(200);
  const ui = await tab.evaluate(() => ({
    seg: [...document.querySelectorAll("#aiEngineSeg [data-engine]")].map((b) => `${b.dataset.engine}:${b.getAttribute("aria-checked")}:${b.disabled ? "off" : "on"}`),
    bench: document.getElementById("aiBenchTable")?.innerText || "",
    chip: document.querySelector(".ai-chip")?.textContent || "",
    test: !!document.getElementById("aiBench"),
  }));
  check("Automatic / Chrome's built-in AI / Downloaded model, automatic chosen, both available", ui.seg.join() === "auto:true:on,nano:false:on,qwen:false:on", ui.seg.join());
  check("the last test's results, per engine", /Chrome's built-in AI/.test(ui.bench) && /Downloaded model/.test(ui.bench) && /processor, \d+ threads/.test(ui.bench), ui.bench);
  check("ready, answered by Chrome's built-in AI", /Chrome's built-in AI/.test(ui.chip) && ui.test, ui.chip);

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
