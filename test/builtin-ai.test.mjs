/*
 * The built-in AI, end to end in Chromium (0.70.0).
 * Run: node test/builtin-ai.test.mjs
 *
 * The real Qwen3.5 weights are 0.5–2.8 GB, so this uses a stand-in: a
 * 260 KB two-layer model with random weights (test/fixtures/llm-tiny), served
 * from this computer in the layout Hugging Face uses. Its replies are noise,
 * which is the point of the second half: an unreadable reply must change
 * nothing. What is checked:
 *   - the model is downloaded once, into the browser's cache, through the
 *     offscreen document (the vendored Transformers.js and ONNX Runtime run
 *     under the extension's CSP);
 *   - a capture is queued, checked, and the result kept: Reprocess puts it
 *     back without running the model again;
 *   - while answers are checked, nothing is fetched from anywhere;
 *   - counts are unchanged;
 *   - Remove deletes the files.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const MODEL_DIR = path.join(HERE, "fixtures", "llm-tiny");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-builtin-ai-test";

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

  console.log("\nbefore anything is downloaded");
  {
    const s = await msg({ type: "ai-status" });
    check("off, nothing downloaded", s && s.ok && !s.ready && !s.downloading, JSON.stringify(s));
    check("the default settings: campaigns and everyday on, counts off", s.settings.onCampaigns && s.settings.onEveryday && !s.settings.inCounts, JSON.stringify(s.settings));
    const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
    const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    const rec = await record(res.captureId);
    check("a capture says the AI check is off", rec && rec.aiStatus === "off", rec && rec.aiStatus);
    check("and Chrome's detector gave its language", rec && rec.answerLang === "en", rec && rec.answerLang);
  }

  console.log("\nthe hardware check");
  {
    const h = await msg({ type: "ai-hardware" });
    check("it answers, with a size and a reason", h && h.ok && h.pick && typeof h.pick.reason === "string" && "webgpu" in h.hardware, JSON.stringify(h));
  }

  console.log("\ndownloading the model (a stand-in, from this computer)");
  {
    const t = await msg({ type: "ai-test-model", model: { repo: "tiny", host: HOST, dtype: "fp32" } });
    check("a stand-in can only come from this computer", t && t.ok);
    const bad = await msg({ type: "ai-test-model", model: { repo: "tiny", host: "https://example.com/", dtype: "fp32" } });
    check("anywhere else is refused", bad && !bad.ok);
    const d = await msg({ type: "ai-download", device: "wasm" });
    check("download starts", d && d.ok && d.started, JSON.stringify(d));
    const s = await waitFor(async () => { const x = await msg({ type: "ai-status" }); return x.ready || x.error ? x : null; }, 90000);
    check("and finishes: ready", s && s.ready && !s.error, JSON.stringify(s));
    check("the model's files were fetched", hits.some((h) => /onnx\/model\.onnx/.test(h)) && hits.some((h) => /tokenizer\.json/.test(h)), hits.join(" "));
  }

  console.log("\nan answer is checked on this computer, with nothing fetched");
  let id;
  {
    const before = hits.length;
    const { raw, reqBody } = fixture("chatgpt-genui-entity-cards.txt");
    const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    id = res.captureId;
    const rec0 = await record(id);
    check("queued as soon as it is captured", rec0 && (rec0.aiStatus === "queued" || rec0.aiStatus === "done"), rec0 && rec0.aiStatus);
    const rec = await waitFor(async () => { const r = await record(id); return r && r.aiStatus === "done" ? r : null; }, 120000);
    check("then checked", !!rec, rec ? "" : JSON.stringify((await record(id) || {}).aiStatus));
    check("the check is kept on the record, with the model named", rec && rec.ai && rec.ai.source === "builtin" && rec.ai.modelRepo === "tiny", JSON.stringify(rec && rec.ai && { s: rec.ai.source, m: rec.ai.modelRepo }));
    check("the stand-in's noise is unreadable, so nothing is claimed", rec && rec.ai && !rec.ai.lang && (rec.ai.entities || []).length === 0 && (rec.ai.missed || []).length === 0 && rec.ai.checks.unreadable >= 1, JSON.stringify(rec && rec.ai && rec.ai.checks));
    check("the model ran: three questions asked, each retried once", rec && rec.ai && rec.ai.checks.calls >= 4, JSON.stringify(rec && rec.ai && rec.ai.checks));
    check("no request went anywhere while checking (the model was already here)", hits.length === before, hits.slice(before).join(" "));
    const plain = await record(id);
    check("counts are the rules' alone: no row marked as added by the AI", plain && !(plain.brandMentions || []).some((m) => m.aiAdded));
  }

  console.log("\nReprocess keeps the check and doesn't run the model again");
  {
    const before = hits.length;
    const s0 = await msg({ type: "ai-status" });
    await msg({ type: "reprocess-all" });
    const rec = await waitFor(async () => { const r = await record(id); return r && r.aiStatus ? r : null; }, 30000);
    check("still checked after Reprocess", rec && rec.aiStatus === "done" && rec.ai && rec.ai.source === "builtin", rec && rec.aiStatus);
    const s1 = await msg({ type: "ai-status" });
    check("nothing queued again", s1.queued === 0 && !s1.checking, JSON.stringify({ q: s1.queued, c: s1.checking, q0: s0.queued }));
    check("nothing fetched", hits.length === before, hits.slice(before).join(" "));
  }

  console.log("\nchecking one answer by hand");
  {
    const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
    await msg({ type: "settings-set", patch: { aiOnEveryday: false } });
    const res = await msg({ type: "raw-conversation", payload: { raw: raw.replace(/Zento/g, "Zentox"), reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    const r0 = await record(res.captureId);
    check("with everyday checks off, a new answer isn't queued", r0 && r0.aiStatus === "not-checked", r0 && r0.aiStatus);
    const q = await msg({ type: "ai-check-capture", captureId: res.captureId });
    check("'Check with built-in AI' queues it anyway", q && q.ok, JSON.stringify(q));
    const r1 = await waitFor(async () => { const r = await record(res.captureId); return r && r.aiStatus === "done" ? r : null; }, 120000);
    check("and it is checked", !!r1);
  }

  console.log("\nRemove deletes the downloaded files");
  {
    const r = await msg({ type: "ai-remove" });
    const s = await msg({ type: "ai-status" });
    check("removed: not ready", r && r.ok && !s.ready, JSON.stringify(s));
    const left = await page.evaluate(async (host) => { const c = await caches.open("transformers-cache"); return (await c.keys()).filter((k) => k.url.startsWith(host)).length; }, HOST);
    check("no model file left in the browser's cache", left === 0, String(left));
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
