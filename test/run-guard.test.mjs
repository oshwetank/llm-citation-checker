/*
 * run-guard.test.mjs — a campaign run when the internet drops (1.0.5).
 *
 * The run must wait, not fail: no question is sent into an error page and
 * none is counted as failed; once the connection is back it goes on by
 * itself and every question is answered. A stub ChatGPT page answers (a
 * made-up answer stream); the connection drop is the service worker's own
 * offline/online events with navigator.onLine set to match.
 * Run: node test/run-guard.test.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-run-guard-test";
const PROMPTS = ["best camera phone under thirty thousand", "best phone for battery life"];

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) { console.log(`\nrun-guard: CANNOT RUN — playwright is not installed. ${err.message}`); process.exit(1); }

const fixture = fs.readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
const SSE_BODY = fixture.slice(fixture.indexOf("\n\n") + 2);
const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

let asked = 0;
try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    if (/\/backend-api\/(f\/)?conversation/.test(route.request().url())) { asked++; return route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE_BODY }); }
    return route.fulfill({
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
          fetch('/backend-api/f/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: [t] } }] }) }).then((r) => r.text());
        });
      </script></body>`,
    });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  const ask = (msg) => page.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);
  const net = (on) => sw.evaluate((up) => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => up });
    self.dispatchEvent(new Event(up ? "online" : "offline"));
  }, on);

  await ask({ type: "error-log-clear" });
  // Offline before the run's first question.
  await net(false);
  const started = await ask({ type: "loader-start", prompts: PROMPTS, options: { platforms: ["chatgpt"], skipAuthCheck: true } });
  check("the run starts", started && started.ok, JSON.stringify(started));
  await page.waitForTimeout(8000);
  const st = await ask({ type: "loader-status" });
  const log1 = ((await ask({ type: "error-log", limit: 200 })) || {}).entries || [];
  check("offline: it waits, and says why", st.running && st.interrupted && st.interrupted.reason === "offline", JSON.stringify(st.interrupted));
  check("nothing was asked into a dead connection", asked === 0, `asked ${asked}`);
  check("and no question failed", !log1.some((e) => /run:turn-failed/.test(e.where)) && (st.errors || 0) === 0, JSON.stringify(log1.filter((e) => /turn-failed/.test(e.where)).map((e) => e.message)));

  console.log("\nThe connection comes back…");
  await net(true);
  let done = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const s = await ask({ type: "loader-status" });
    if (!s.running) { done = s; break; }
  }
  const log2 = ((await ask({ type: "error-log", limit: 300 })) || {}).entries || [];
  check("it went on by itself and finished", !!done, "still running after 120 s");
  check("every question answered, none failed", asked >= 2 && !log2.some((e) => /run:turn-failed/.test(e.where)), `asked ${asked}; ${JSON.stringify(log2.filter((e) => /turn-failed/.test(e.where)).map((e) => e.message))}`);
  check("the drop and the return are in the log", log2.some((e) => e.where === "run:offline") && log2.some((e) => e.where === "run:online"));

  console.log("\nThe run's tab is closed mid-run");
  await ask({ type: "error-log-clear" });
  const askedBefore = asked;
  const r2 = await ask({ type: "loader-start", prompts: ["which phone has the best camera", "which phone charges fastest"], options: { platforms: ["chatgpt"], skipAuthCheck: true } });
  check("a second run starts", r2 && r2.ok, JSON.stringify(r2));
  // Close the first run tab as soon as it opens.
  let closed = false;
  for (let i = 0; i < 20 && !closed; i++) {
    await page.waitForTimeout(500);
    const runTabs = context.pages().filter((p) => p.url().startsWith("https://chatgpt.com/"));
    if (runTabs.length) { await runTabs[0].close(); closed = true; }
  }
  check("(a run tab was closed)", closed);
  let fin = null;
  const dl = Date.now() + 120000;
  while (Date.now() < dl) { await page.waitForTimeout(3000); const s = await ask({ type: "loader-status" }); if (!s.running) { fin = s; break; } }
  const log3 = ((await ask({ type: "error-log", limit: 300 })) || {}).entries || [];
  check("a new tab took over", log3.some((e) => /run:tab-replaced/.test(e.where)), JSON.stringify(log3.map((e) => e.where).slice(-12)));
  check("and both questions were answered, none failed", !!fin && asked - askedBefore >= 2 && !log3.some((e) => /run:turn-failed/.test(e.where)), `asked ${asked - askedBefore}; ${JSON.stringify(log3.filter((e) => /turn-failed/.test(e.where)).map((e) => e.message))}`);
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
