/*
 * chatgpt-stream-end.test.mjs — a ChatGPT answer is recorded the moment its
 * stream says it's done, even when the stream stays open (0.79.0).
 *
 * The owner: "the prompt is pasted and the answer is ready but the capture
 * … is taking 1–2 mins … it should happen immediately". Until 0.79.0 a
 * signed-in answer was handed over only when its stream closed or after 30 s
 * without data, and every keep-alive line restarted those 30 s, so a stream
 * that stays open and pings was never handed over at all until it closed.
 *
 * A local server stands in for chatgpt.com (made-up Zento/Kovo answers) and
 * keeps each stream open, pinging every second, after the answer:
 *   1. signed in, the answer ends with `message_stream_complete` and
 *      `data: [DONE]` — recorded within 2.5 s of that line;
 *   2. signed in, no end line at all, only pings after the answer — recorded
 *      once the answer data has been quiet a few seconds, not never;
 *   3. signed out, the ndjson updates stream ends with
 *      `{"version":2,"type":"end"}` — recorded within 2.5 s;
 *   4. signed out, a 9 MB stream of mostly page markup — stored: the size
 *      limit is on the compressed copy (0.79.0). Real signed-out answers ran
 *      to 8.4 MB, and over the old raw-length limit they were dropped whole.
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-chatgpt-stream-end-test";

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
  console.log(`\nchatgpt-stream-end: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const fx = readFileSync(path.join(HERE, "fixtures", "chatgpt-genui-cards.txt"), "utf8").split(/\r?\n/);
const REQ = (fx.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "");
const SSE = fx.filter((l) => !l.startsWith("# ")).join("\n");
const SSE_NO_END = SSE.replace(/data: \{"type":"message_stream_complete"[^\n]*\n\n/, "").replace(/data: \[DONE\]\s*$/, "");

const ev = (salt, detail) => JSON.stringify({ version: 2, type: "conversation-source", detail: { operationId: `op-${salt}`, streamType: "conversation", kind: "message", conversationId: `c-${salt}`, ...detail } });
const signedOut = (salt) => [
  ev(salt, { role: "user", messageId: `u-${salt}`, markdown: `best linen shirt brands for summer ${salt}` }),
  ev(salt, { messageId: `m-${salt}`, revision: 1, status: "streaming", markdown: "**Zento Linen** is the pick for hot days." }),
  ev(salt, { messageId: `m-${salt}`, revision: 2, status: "resolved", markdown: "**Zento Linen** is the pick for hot days.\n\n- **Kovo Weave**: softer.", references: [{ url: "https://stylelab.example/linen", title: "Linen — StyleLab" }] }),
  JSON.stringify({ version: 2, type: "end" }),
].join("\n") + "\n";

const PAGE = (endpoint) => `<!doctype html><html lang="en"><body>stub<script>
  (async () => {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(${JSON.stringify(endpoint)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(REQ)} });
    document.title = "asked";
    const rd = res.body.getReader();
    for (;;) { const { done } = await rd.read(); if (done) break; }
  })();
</script></body></html>`;

// The answer, then a keep-alive line every second for as long as the test
// needs, the way a stream that stays open behaves.
let current = { body: "", ping: "", salt: "" };
let answerSentAt = 0;
const openStreams = new Set();
const certDir = mkdtempSync(path.join(os.tmpdir(), "cito-streamend-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-keyout", path.join(certDir, "k.pem"), "-out", path.join(certDir, "c.pem")], { stdio: "ignore" });
const server = https.createServer({ key: readFileSync(path.join(certDir, "k.pem")), cert: readFileSync(path.join(certDir, "c.pem")) }, (req, res) => {
  const u = new URL(req.url, "https://chatgpt.com");
  if (req.method === "POST" && (u.pathname.startsWith("/backend-") || u.pathname.startsWith("/unauth-"))) {
    req.resume();
    res.writeHead(200, { "content-type": current.ndjson ? "application/x-ndjson" : "text/event-stream; charset=utf-8" });
    res.write(current.body);
    answerSentAt = Date.now();
    const iv = setInterval(() => { try { res.write(current.ping); } catch (_) { clearInterval(iv); } }, 1000);
    const end = setTimeout(() => { clearInterval(iv); try { res.end(); } catch (_) {} }, 45000);
    openStreams.add({ res, iv, end });
    res.on("close", () => { clearInterval(iv); clearTimeout(end); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE(current.endpoint));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox",
    `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${PORT}`, "--ignore-certificate-errors", "--no-proxy-server"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await panel.waitForTimeout(800);
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const count = async () => ((((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "chatgpt" && !String(r.captureId).startsWith("demo-"))).length;

  // How long after the answer went out it was stored; null if not in `waitMs`.
  const ask = async (setup, waitMs) => {
    const salt = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    current = { ...setup(salt), salt };
    answerSentAt = 0;
    const before = await count();
    const g = await context.newPage();
    await g.goto(`https://chatgpt.com/c/${salt}`);
    const t0 = Date.now();
    while (!answerSentAt && Date.now() - t0 < 10000) await g.waitForTimeout(100);
    let took = null;
    while (Date.now() - answerSentAt < waitMs) {
      if ((await count()) > before) { took = Date.now() - answerSentAt; break; }
      await g.waitForTimeout(200);
    }
    await g.close();
    return took;
  };
  const salted = (body, salt) => body.replace(/\b[0-9a-f]{8}-(?=[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/g, `${salt}-`);

  console.log("\n1. signed in: the end line, then the stream stays open with pings");
  const t1 = await ask((salt) => ({ endpoint: "/backend-api/f/conversation", body: salted(SSE, salt), ping: ": ping\n\n" }), 20000);
  check("recorded within 2.5 s of the end line", t1 != null && t1 < 2500, t1 == null ? "not in 20 s" : `${t1} ms`);

  console.log("\n2. signed in: no end line, only keep-alive pings after the answer");
  const t2 = await ask((salt) => ({ endpoint: "/backend-api/f/conversation", body: salted(SSE_NO_END, salt), ping: 'data: {"type":"ping"}\n\n' }), 20000);
  check("recorded once the answer has been quiet, pings or not", t2 != null && t2 < 9000, t2 == null ? "not in 20 s" : `${t2} ms`);

  console.log("\n3. signed out: the updates stream's end line, then it stays open");
  const t3 = await ask((salt) => ({ endpoint: "/unauth-mweb/conversation/updates?operationId=x", body: signedOut(salt), ping: "\n", ndjson: true }), 20000);
  check("recorded within 2.5 s of the end line", t3 != null && t3 < 2500, t3 == null ? "not in 20 s" : `${t3} ms`);

  console.log("\n4. signed out: 9 MB of mostly page markup");
  const t4 = await ask((salt) => {
    const filler = JSON.stringify({ version: 2, type: "shared", detail: { html: `<template>${"<div class=\"row\"><span>layout</span></div>".repeat(220000)}</template>` } });
    const body = signedOut(salt).replace(/\{"version":2,"type":"end"\}\n$/, `${filler}\n{"version":2,"type":"end"}\n`);
    return { endpoint: "/unauth-mweb/conversation/updates?operationId=y", body, ping: "\n", ndjson: true, bytes: body.length };
  }, 20000);
  check(`stored (${(current.bytes / 1e6).toFixed(1)} MB raw)`, t4 != null && current.bytes > 8.5 * 1024 * 1024, t4 == null ? "not stored in 20 s" : `${t4} ms`);
} finally {
  for (const s of openStreams) { clearInterval(s.iv); clearTimeout(s.end); try { s.res.destroy(); } catch (_) {} }
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
