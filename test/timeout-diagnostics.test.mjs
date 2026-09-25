/*
 * timeout-diagnostics.test.mjs — a timed-out turn says where it got to.
 *
 * Across two real runs (two browsers, v0.41.0), 57 of 57 failures were
 * recorded as the bare word "timeout", with no trace. That one word covers
 * opposite failures — a prompt that never went out, and one that went out and
 * was answered but never captured — so the diagnostics export couldn't say
 * which, or why. When a turn's watchdog now fires, the run first asks the tab
 * where the turn got to and records the answer: a specific reason, the stage,
 * the clock that drove it, and the turn's event trace.
 *
 * This drives the REAL extension end to end: a stub ChatGPT page accepts the
 * prompt (it lands in the transcript, which is how the content script
 * confirms a send) but never produces an answer the extension can capture, so
 * the real watchdog fires after its real ~90s budget. It also proves the
 * service-worker clock works through Chrome itself, not just a harness stand-
 * in: the probe must report clock=worker.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-timeout-diag-test";
const PROMPT = "best phone for portrait photos under thirty thousand rupees";

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
  console.log("\ntimeout-diagnostics: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the run's only record of why a turn failed, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

try {
  // A ChatGPT stub that takes the prompt and shows it in the transcript, but
  // never makes the network call an answer arrives on — so nothing is ever
  // captured and the turn can only end by its watchdog.
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<body>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button">send</button><div id="convo"></div>
      <script>
        const box = document.getElementById('prompt-textarea');
        document.getElementById('composer-submit-button').addEventListener('click', () => {
          const t = box.innerText.trim(); if (!t) return;
          box.innerHTML = '';
          const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'user');
          d.textContent = t; document.getElementById('convo').appendChild(d);
        });
      </script></body>`,
  }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  const profileId = await page.evaluate(async (text) => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, v) => new Promise((res, rej) => {
      const r = dbh.transaction(store, "readwrite").objectStore(store).put(v);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    const id = crypto.randomUUID();
    await put("profiles", {
      id, name: "Timeout Diagnostics Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    return id;
  }, PROMPT);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  console.log("\nWaiting out the turn's real watchdog (~90s)…");
  let entry = null;
  const deadline = Date.now() + 150000;
  while (!entry && Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const log = await ask({ type: "error-log", limit: 100 });
    entry = ((log && log.entries) || []).find((e) => e.where === "run:turn-failed:chatgpt");
  }
  await ask({ type: "loader-stop" });

  console.log("\nThe failure says where the turn got to");
  check("the turn was recorded as failed", !!entry);
  const ctx = (entry && entry.context) || {};
  check("with a specific reason — sent, but no answer captured — not a bare 'timeout'",
    !!entry && entry.message === "timeout: sent, no answer captured", entry && entry.message);
  check("its stage is recorded", ctx.stage === "sent", JSON.stringify(ctx.stage));
  check("the real service-worker clock drove the turn", ctx.clock === "worker", JSON.stringify(ctx.clock));
  check("its tick timing is recorded", typeof ctx.maxTickGapMs === "number" && ctx.maxTickGapMs > 0, JSON.stringify(ctx.maxTickGapMs));
  check("and the turn's event trace is attached", !!entry && /probe stage=sent/.test(entry.trace || ""), entry && entry.trace);

  const turns = await ask({ type: "error-log", limit: 100, cat: "turn" });
  const turn = ((turns && turns.entries) || []).find((e) => e.where === "run:turn:chatgpt");
  check("the per-turn timeline carries the same diagnosis",
    !!turn && turn.message === "timeout: sent, no answer captured" && turn.context.stage === "sent",
    turn && JSON.stringify({ m: turn.message, stage: turn.context.stage }));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
