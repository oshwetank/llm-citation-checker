/*
 * long-answer.test.mjs — an answer that is still streaming when the turn's
 * 90s watchdog fires gets more time, and is captured.
 *
 * In a real v0.42 run, two ChatGPT turns were failed at 90s while the probe
 * reported the page still streaming (its stop button showing): long answers,
 * not lost ones. The watchdog now extends a turn whose answer is still
 * streaming, 60s at a time and at most twice, so a stuck indicator can't hold
 * a turn forever.
 *
 * The real extension end to end: a stub ChatGPT page takes the prompt, shows
 * a stop button, and only delivers its answer (a real captured answer stream)
 * at ~100s. Before the fix this turn failed at 90s.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-long-answer-test";
const PROMPT = "compare the three best phones under thirty thousand rupees in detail";

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
  console.log("\nlong-answer: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a real failure mode, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const fixture = fs.readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
const SSE_BODY = fixture.slice(fixture.indexOf("\n\n") + 2);

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    if (/\/backend-api\/(f\/)?conversation/.test(route.request().url())) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE_BODY });
    }
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
          // Still writing: the stop button shows until the answer is done.
          const stop = document.createElement('button');
          stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'stop';
          document.body.appendChild(stop);
          setTimeout(() => {
            fetch('/backend-api/f/conversation', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' },
                content: { content_type: 'text', parts: [t] } }] })
            }).then((r) => r.text()).then(() => stop.remove());
          }, 100000);
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
      id, name: "Long Answer Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    return id;
  }, PROMPT);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  console.log("\nWaiting past the 90s watchdog for the ~100s answer…");
  let ok = null;
  let failed = null;
  const deadline = Date.now() + 170000;
  while (!ok && !failed && Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const log = await ask({ type: "error-log", limit: 100 });
    const entries = (log && log.entries) || [];
    ok = entries.find((e) => e.where === "run:turn:chatgpt" && e.message === "ok") || null;
    failed = entries.find((e) => e.where === "run:turn-failed:chatgpt") || null;
  }
  await ask({ type: "loader-stop" });

  console.log("\nThe long answer is captured, not failed");
  check("the turn was not failed at the 90s watchdog", !failed, failed && `${failed.message} ${JSON.stringify(failed.context)}`);
  check("it completed with the answer", !!ok, "no ok turn within 170s");
  check("after the first watchdog would have fired", !!ok && ok.context.elapsedMs > 90000, ok && ok.context.elapsedMs);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
