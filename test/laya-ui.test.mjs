/*
 * laya-ui.test.mjs — Laya labels answers, end to end in Chromium (0.83.0).
 *
 * The real bundle is 1.3 GB, so this serves a stand-in with the same files,
 * inputs and outputs (test/fixtures/laya-tiny, written by
 * test/tools/laya-fixtures.py) from this computer, laid out the way Hugging
 * Face serves duration465/laya-onnx's multilingual/ folder. Its "opinion" is
 * fixed: it prefers best_top, decision, consumer, brand and recommended, and
 * has no view on scope, so the labels it gives, and the one it leaves out
 * as unsure, are known. Checked:
 *   - Settings → Download Laya fetches the five files once, through the
 *     offscreen page (ONNX Runtime's own API under the extension's CSP, the
 *     tokenizer from Transformers.js, weights in a separate .data file);
 *   - a capture is labelled by Laya, not the language model, which isn't
 *     downloaded at all;
 *   - the unsure label is left out; brand rows get type and stance; counts
 *     don't change;
 *   - nothing is fetched while labelling; a second answer reads the cache;
 *   - Analyze shows the Laya chip; Remove takes it away.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const BUNDLE = path.join(HERE, "fixtures", "laya-tiny");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-laya-ui-test";

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
  console.log(`\nlaya-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// "/laya/resolve/main/multilingual/<file>" -> test/fixtures/laya-tiny/<file>
const hits = [];
let slowData = false; // hold the weights back, so a download can be cancelled mid-way
const server = http.createServer(async (req, res) => {
  hits.push(`${req.method} ${req.url}`);
  if (slowData && /laya\.onnx\.data/.test(req.url)) await new Promise((r) => setTimeout(r, 6000));
  const m = /^\/laya\/resolve\/main\/multilingual\/(.+)$/.exec(decodeURIComponent(req.url.split("?")[0]));
  const file = m && path.join(BUNDLE, m[1]);
  const headers = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length" };
  if (!file || !file.startsWith(BUNDLE) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end(); }
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
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const waitFor = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await page.waitForTimeout(300); } return null; };
  const record = async (id) => ((await msg({ type: "get-record", captureId: id })) || {}).record || null;
  const outside = [];
  // What the worker and the AI page fetch (the panel's own pictures of an
  // answer are the answer's business, not the labeller's).
  context.on("request", (r) => {
    const u = r.url();
    if (/^(chrome-extension|data|blob):/.test(u) || u.startsWith(HOST)) return;
    let from = "";
    try { from = r.serviceWorker() ? "worker" : (r.frame() && r.frame().url()) || ""; } catch (_) { from = "worker"; }
    if (from === "worker" || /offscreen\.html/.test(from)) outside.push(u);
  });

  console.log("\nSettings → Download Laya");
  check("the test bundle is accepted (local addresses only)", (await msg({ type: "laya-test-model", model: { host: HOST, repo: "laya", rev: "main", sub: "multilingual" } })).ok);
  check("a web address is refused", !(await msg({ type: "laya-test-model", model: { host: "https://example.com/", repo: "x" } })).ok);
  await page.evaluate(() => document.querySelector('[data-tab="about"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
  await page.waitForSelector("#swLaya", { timeout: 15000 }).catch(() => {});
  const flip = (on) => page.evaluate((on) => { const i = document.getElementById("swLaya"); i.checked = on; i.dispatchEvent(new Event("change", { bubbles: true })); }, on);
  const before = await page.evaluate(() => ({ row: document.querySelector('#aiSwitches [data-model="laya"]')?.innerText || "", on: document.getElementById("swLaya")?.checked, about: document.getElementById("aiLaya")?.textContent || "" }));
  check("Laya is a switch at the top of Built-in AI, off, with its size (0.84.0)", /Fast labels/.test(before.row) && /1\.2 GB|MB/.test(before.row) && before.on === false, JSON.stringify(before));
  check("it says Ask still uses the AI model", /Ask still uses the AI model/.test(before.about));

  console.log("\nturned off while it downloads: cancelled");
  slowData = true;
  await flip(true);
  await waitFor(async () => { const s = await msg({ type: "ai-status" }); return s.laya.downloading ? s : null; }, 10000);
  await page.waitForTimeout(800);
  await page.waitForSelector("#swLaya", { timeout: 5000 });
  await flip(false);
  const stopped = await waitFor(async () => { const s = await msg({ type: "ai-status" }); return !s.laya.downloading ? s : null; }, 20000);
  check("the download stops", stopped && !stopped.laya.ready && !stopped.laya.error, JSON.stringify(stopped && stopped.laya));
  const left = await waitFor(async () => { const n = await page.evaluate(async () => { const c = await caches.open("laya-cache"); return (await c.keys()).length; }); return n === 0 ? "empty" : null; }, 15000);
  check("and what had arrived is removed", left === "empty");
  slowData = false;
  await page.waitForTimeout(6500);
  hits.length = 0;

  console.log("\non: downloaded");
  await page.waitForSelector("#swLaya", { timeout: 5000 });
  await flip(true);
  const ready = await waitFor(async () => { const s = await msg({ type: "ai-status" }); return s && s.laya && s.laya.ready ? s : null; }, 90000);
  check("downloaded and loaded", !!ready, JSON.stringify((await msg({ type: "ai-status" })).laya));
  const files = hits.filter((h) => h.startsWith("GET ")).map((h) => h.split("multilingual/")[1]).sort();
  check("the five files, once each", files.join() === ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"].sort().join(), files.join());
  check("labels now by Laya, the language model never downloaded", ready && ready.labelsBy && ready.labelsBy.id === "laya" && !ready.qwenReady, JSON.stringify(ready && ready.labelsBy));
  await page.waitForFunction(() => /On · downloaded/.test(document.querySelector('#aiSwitches [data-model="laya"]')?.innerText || ""), null, { timeout: 10000 }).catch(() => {});
  check("the switch says on, downloaded", await page.evaluate(() => document.getElementById("swLaya")?.checked && /On · downloaded/.test(document.querySelector('#aiSwitches [data-model="laya"]')?.innerText || "")));

  console.log("\na capture, labelled");
  const hitsBefore = hits.length;
  const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
  const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  const rec = await waitFor(async () => { const r = await record(res.captureId); return r && r.aiStatus === "done" ? r : null; }, 90000);
  check("checked", !!rec, JSON.stringify((await record(res.captureId) || {}).aiStatus));
  const ai = rec && rec.ai;
  check("by Laya", ai && ai.source === "laya" && ai.engine === "laya", JSON.stringify(ai && { source: ai.source, engine: ai.engine }));
  check("what it asks, its stage, who it's for", ai && ai.intent === "best_top" && ai.funnel === "decision" && ai.audience === "consumer", JSON.stringify(ai && { i: ai.intent, f: ai.funnel, a: ai.audience }));
  check("the label it had no view on is left out, and listed", ai && !(ai.market && ai.market.scope) && ai.checks.unsure.some((u) => u.what === "scope"));
  const brands = (rec && rec.brandMentions) || [];
  const labelled = brands.filter((m) => m.aiType === "brand" && m.aiStance === "recommended");
  check("brand rows get type and stance", brands.length > 0 && labelled.length === Math.min(10, brands.length), `${labelled.length}/${brands.length}`);
  const badQ = labelled.find((m) => m.aiQuote && !rec.answerText.includes(m.aiQuote));
  check("each stance quoted from the answer itself", !badQ, badQ && JSON.stringify({ q: badQ.aiQuote, near: rec.answerText.slice(Math.max(0, rec.answerText.indexOf(badQ.brand) - 40), rec.answerText.indexOf(badQ.brand) + 160) }));
  check("no names added, counts as they were", brands.every((m) => !m.aiAdded) && (ai.missed || []).length === 0);
  check("one run of the model for the whole answer", ai && ai.checks.calls === 1 && ai.checks.questions === 4 + 2 * Math.min(10, brands.length), JSON.stringify(ai && ai.checks));
  check("nothing fetched while labelling", hits.length === hitsBefore, hits.slice(hitsBefore).join(", "));

  const second = await msg({ type: "raw-conversation", payload: { ...fixture("chatgpt-tv.txt"), pageUrl: "https://chatgpt.com/", capturedAt: Date.now(), reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: ["best tv to buy"] } }] }) } });
  const rec2 = await waitFor(async () => { const r = await record(second.captureId); return r && r.aiStatus === "done" ? r : null; }, 60000);
  check("a second answer too, from the cache", rec2 && rec2.ai.source === "laya" && hits.length === hitsBefore);
  const pace = await waitFor(async () => { const s = await msg({ type: "ai-status" }); return s.laya.msPerAnswer ? s : null; }, 5000);
  check("the pace is measured, for Settings", pace && pace.laya.msPerAnswer > 0);

  // Labelling fetched nothing from anywhere (Analyze, next, shows the
  // answer's own product pictures, which are its business).
  check("nothing fetched from the internet while labelling", outside.length === 0, outside.slice(0, 3).join(", "));

  console.log("\nAnalyze");
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${res.captureId}`);
  await tab.waitForSelector("#at-ai", { timeout: 15000 }).catch(() => {});
  const t = await tab.evaluate(() => document.getElementById("at-ai")?.innerText || "");
  check("the AI check says Laya, with what it found", /Laya/.test(t) && /What it asks/.test(t) && /Recommended/i.test(t), t.slice(0, 300));
  await tab.close();

  console.log("\nLabel answers with");
  await page.evaluate(() => { const d = document.getElementById("aiMore"); if (d) d.open = true; });
  await page.waitForSelector("#aiLabellerSeg", { timeout: 5000 }).catch(() => {});
  const seg = await page.evaluate(() => [...document.querySelectorAll("#aiLabellerSeg [data-labeller]")].map((b) => [b.dataset.labeller, b.getAttribute("aria-checked"), b.disabled]));
  check("Automatic chosen, Laya available, the AI model not (not downloaded)", JSON.stringify(seg) === JSON.stringify([["auto", "true", false], ["laya", "false", false], ["llm", "false", true]]), JSON.stringify(seg));
  await page.click('#aiLabellerSeg [data-labeller="laya"]');
  const chosen = await waitFor(async () => { const s = await msg({ type: "ai-status" }); return s.labeller === "laya" ? s : null; }, 5000);
  check("a choice is kept", !!chosen);

  console.log("\nRemove");
  page.once("dialog", (d) => d.accept());
  await page.waitForSelector("#swLaya", { timeout: 5000 });
  await flip(false);
  const gone = await waitFor(async () => { const s = await msg({ type: "ai-status" }); return s.laya && !s.laya.ready ? s : null; }, 10000);
  check("removed", !!gone && !gone.labelsBy, JSON.stringify(gone && gone.labelsBy));
  const kept = await record(res.captureId);
  check("the labels already made are kept", kept && kept.ai && kept.ai.source === "laya");

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
