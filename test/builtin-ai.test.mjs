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
    check("no hardware check while Settings isn't shown (it opens the AI page)", s && s.hardware == null, JSON.stringify(s && s.hardware));
    check("the default settings: campaigns and everyday on, counts off", s.settings.onCampaigns && s.settings.onEveryday && !s.settings.inCounts, JSON.stringify(s.settings));
    const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
    const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    const rec = await record(res.captureId);
    check("a capture says the AI check is off", rec && rec.aiStatus === "off", rec && rec.aiStatus);
    check("and Chrome's detector gave its language", rec && rec.answerLang === "en", rec && rec.answerLang);
    const tab = await context.newPage();
    await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${res.captureId}`);
    await tab.waitForSelector("#at-ai", { timeout: 15000 }).catch(() => {});
    const t = await tab.evaluate(() => document.getElementById("at-ai")?.innerText || "");
    check("Analyze says the AI check is off, and where to turn it on", /AI check off/.test(t) && /Fast labels/.test(t) && /in Ask/.test(t) && /English/.test(t), t);
    await tab.close();
  }

  const openSettings = async () => {
    await page.evaluate(() => document.querySelector('[data-tab="about"]').click());
    await page.waitForTimeout(400);
    await page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
    await page.waitForTimeout(800);
    // Sizes, folders and engines are under "More options" since 0.84.0.
    await page.evaluate(() => { const d = document.getElementById("aiMore"); if (d && !d.open) { d.open = true; d.dispatchEvent(new Event("toggle")); } });
    await page.waitForTimeout(200);
  };
  const card = () => page.evaluate(() => {
    const c = document.getElementById("setAi");
    return { text: c ? c.innerText : "", tiers: [...(c ? c.querySelectorAll("[data-tier]") : [])].map((b) => [b.dataset.tier, b.getAttribute("aria-checked")]),
      download: c && c.querySelector("#aiDownload") ? c.querySelector("#aiDownload").textContent : null, switches: [...(c ? c.querySelectorAll("input[role=switch]") : [])].filter((i) => !/^sw/.test(i.id)).map((i) => [i.id, i.checked]),
      models: [...(c ? c.querySelectorAll("#aiSwitches input[role=switch]") : [])].map((i) => [i.id, i.checked]) };
  });

  console.log("\nthe Settings card before downloading");
  {
    await openSettings();
    await page.waitForFunction(() => /This computer:/.test(document.getElementById("aiHw")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    const c = await card();
    check("Built-in AI is there, off, and says nothing leaves the computer", /Built-in AI/.test(c.text) && /Off/.test(c.text) && /nothing you capture is ever sent anywhere/i.test(c.text), c.text.slice(0, 300));
    check("the hardware check and a suggested size, with why", /This computer:/.test(c.text) && /Suggested:/.test(c.text), c.text);
    check("three sizes, one picked", c.tiers.length === 3 && c.tiers.filter(([, v]) => v === "true").length === 1, JSON.stringify(c.tiers));
    check("a Download button; no switches yet", c.download === "Download AI model" && c.switches.length === 0, JSON.stringify(c));
    check("and the model switches on top, all off (0.84.0; Search by meaning, 1.0.5)", JSON.stringify(c.models) === JSON.stringify([["swAskModel", false], ["swLaya", false], ["swMeaning", false]]), JSON.stringify(c.models));
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
    // Asked for the graphics chip on a computer without one (this headless
    // browser): it must fall back to the processor, not fail.
    const d = await msg({ type: "ai-download", device: "webgpu" });
    check("download starts", d && d.ok && d.started, JSON.stringify(d));
    const s = await waitFor(async () => { const x = await msg({ type: "ai-status" }); return x.ready || x.error ? x : null; }, 90000);
    check("and finishes: ready", s && s.ready && !s.error, JSON.stringify(s));
    check("on the processor, since there is no graphics chip here", s && s.device === "wasm", s && s.device);
    check("the model's files were fetched", hits.some((h) => /onnx\/model\.onnx/.test(h)) && hits.some((h) => /tokenizer\.json/.test(h)), hits.join(" "));
  }

  console.log("\nthe Settings card once downloaded");
  {
    await page.reload();
    await openSettings();
    await page.waitForFunction(() => /Ready/.test(document.getElementById("setAi")?.innerText || ""), null, { timeout: 15000 }).catch(() => {});
    const c = await card();
    if (process.env.SHOTS) await page.locator("#setAi").screenshot({ path: `${process.env.SHOTS}/ai-card.png` });
    check("Ready, with the model named", /Ready/.test(c.text) && /Model: tiny/.test(c.text), c.text.slice(0, 400));
    check("three switches: campaigns on, everyday on, counts off", JSON.stringify(c.switches) === JSON.stringify([["aiCampaigns", true], ["aiEveryday", true], ["aiCounts", false]]), JSON.stringify(c.switches));
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
    // 0.74.0: one combined question per piece of the answer (was three).
    check("the model ran: one question for the piece, retried once", rec && rec.ai && rec.ai.checks.calls === 2 && rec.ai.checks.retries === 2, JSON.stringify(rec && rec.ai && rec.ai.checks));
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

  console.log("\nAnalyze shows the check");
  {
    // A filled-in check, as the real model would leave it, put straight into
    // the store; Reprocess puts it on the record.
    await page.evaluate(async (captureId) => {
      const { aiKey } = await import("/src/lib/aiCheck.js");
      const rec = await new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId }, (x) => r(x.record)));
      const names = (rec.brandMentions || []).map((m) => m.brand);
      const ai = { key: aiKey(rec, "tiny"), captureId, v: 1, source: "builtin", model: "Qwen3.5 test", modelRepo: "tiny", at: Date.now(),
        lang: "en", market: { country: "IN", currency: "INR", scope: "national", evidence: ["₹"] }, intent: "best_top", funnel: "decision", audience: "consumer", vertical: "smartphones",
        topics: { en: ["foldable phones"], orig: ["foldable phones"] },
        entities: [{ name: names[0], type: "brand", owner: "Made-up Group", stance: "recommended", quote: "a made-up quote for the test" }],
        missed: [{ name: "Orbix Labs", type: "brand", quote: "Orbix Labs makes cases" }],
        checks: { calls: 3, retries: 0, unreadable: 0, ms: 900, dropped: [{ field: "missed", value: "Fakebrand", why: "not written in the answer" }] } };
      await new Promise((res, rej) => { const o = indexedDB.open("lcfc"); o.onsuccess = () => { const t = o.result.transaction("ai", "readwrite"); t.objectStore("ai").put(ai); t.oncomplete = res; t.onerror = rej; }; o.onerror = rej; });
    }, id);
    await msg({ type: "reprocess-all" });
    await page.waitForTimeout(800);
    const tab = await context.newPage();
    await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${id}`);
    await tab.waitForSelector("#at-ai", { timeout: 15000 }).catch(() => {});
    const a = await tab.evaluate(() => { const s = document.getElementById("at-ai"); return s ? { text: s.innerText, rail: !!document.querySelector('.at-rail-item[data-target="at-ai"]'), q: s.querySelectorAll(".at-ai-q").length } : null; });
    if (process.env.SHOTS) { await tab.setViewportSize({ width: 1280, height: 900 }); await tab.waitForTimeout(300); await tab.locator("#at-ai").screenshot({ path: `${process.env.SHOTS}/at-ai.png` }); }
    check("an AI check section, with its rail entry", a && a.rail, JSON.stringify(a && { rail: a.rail }));
    check("language and market, named in words", a && /English/.test(a.text) && /India/.test(a.text) && /INR/.test(a.text), a && a.text.slice(0, 300));
    check("intent, stage, audience, industry and topics", a && /Best, top & reviews/.test(a.text) && /Ready to choose/.test(a.text) && /Consumers/.test(a.text) && /smartphones/.test(a.text) && /foldable phones/.test(a.text), a && a.text);
    check("each brand's type, owner and stance, with its quote", a && /Made-up Group/.test(a.text) && /Recommended/.test(a.text) && a.q >= 2, a && a.text);
    check("names it found, marked as not in your counts", a && /Also found by AI/.test(a.text) && /Orbix Labs/.test(a.text) && /not in your counts/.test(a.text), a && a.text);
    check("and how many claims were left out", a && /1 claim left out/.test(a.text), a && a.text);
    // With "Let the AI correct brands in counts" on, the found name joins the
    // counts only if it is written in the answer (it isn't here).
    await msg({ type: "settings-set", patch: { aiInCounts: true } });
    await msg({ type: "reprocess-all" });
    const r = await record(id);
    check("a found name that isn't in the answer text never joins the counts", r && !(r.brandMentions || []).some((m) => m.brand === "Orbix Labs"), JSON.stringify((r.brandMentions || []).map((m) => m.brand)));
    await msg({ type: "settings-set", patch: { aiInCounts: false } });
    await tab.close();
  }

  console.log("\nRemove deletes the downloaded files");
  {
    const r = await msg({ type: "ai-remove" });
    const s = await msg({ type: "ai-status" });
    check("removed: not ready", r && r.ok && !s.ready, JSON.stringify(s));
    const left = await page.evaluate(async (host) => { const c = await caches.open("transformers-cache"); return (await c.keys()).filter((k) => k.url.startsWith(host)).length; }, HOST);
    check("no model file left in the browser's cache", left === 0, String(left));
  }

  console.log("\nLoad from a folder: no download at all");
  {
    const files = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model.onnx"]
      .map((f) => ({ path: `llm-tiny/${f}`, b64: readFileSync(path.join(MODEL_DIR, f)).toString("base64") }));
    const before = hits.length;
    const n = await page.evaluate(async ({ files, host }) => {
      const { importFiles } = await import("/src/lib/llmEngine.js");
      const blobs = files.map((f) => ({ path: f.path, blob: new Blob([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))]) }));
      return (await importFiles({ repo: "tiny", host, files: blobs })).imported;
    }, { files, host: HOST });
    check("six files put in the browser's cache", n === 6, String(n));
    await msg({ type: "ai-download", device: "wasm" });
    const s = await waitFor(async () => { const x = await msg({ type: "ai-status" }); return x.ready || x.error ? x : null; }, 90000);
    check("the model loads from them", s && s.ready, JSON.stringify(s && s.error));
    check("without fetching any model file", !hits.slice(before).some((h) => /onnx|tokenizer|config/.test(h)), hits.slice(before).join(" "));
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
