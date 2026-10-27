/*
 * limit-resume.test.mjs — after a usage limit's cooldown, the run asks the
 * same prompt again and goes on (0.79.0).
 *
 * Until 0.79.0 the auto-resume called a function that didn't exist: the
 * cooldown ended, the engine's tabs were marked running again, and nothing
 * restarted them. The heartbeat then failed the waiting prompt as "watchdog
 * lost", so every ChatGPT limit notice cost a prompt and stalled ChatGPT,
 * while Gemini in the same run carried on — part of why ChatGPT failed far
 * more often in the owner's two-engine runs.
 *
 * A stub ChatGPT page shows a limit notice ("try again in 1 minute") the
 * first time it is asked and answers (a made-up answer stream) after that.
 * The prompt must end answered, not failed, without a click.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-limit-resume-test";
const PROMPT = "best camera phone under thirty thousand";

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
  console.log(`\nlimit-resume: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const fixture = fs.readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
const SSE_BODY = fixture.slice(fixture.indexOf("\n\n") + 2);

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

let asked = 0;
try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    if (/\/backend-api\/(f\/)?conversation/.test(route.request().url())) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE_BODY });
    }
    if (route.request().url().includes("/__asked")) { asked++; return route.fulfill({ status: 200, body: String(asked) }); }
    return route.fulfill({
      status: 200, contentType: "text/html",
      body: `<body>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button">send</button><div id="convo"></div>
      <script>
        const box = document.getElementById('prompt-textarea');
        document.getElementById('composer-submit-button').addEventListener('click', async () => {
          const t = box.innerText.trim(); if (!t) return;
          box.innerHTML = '';
          const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'user');
          d.textContent = t; document.getElementById('convo').appendChild(d);
          const n = Number(await (await fetch('/__asked')).text());
          if (n === 1) {
            const lim = document.createElement('div');
            lim.textContent = "You've reached the message limit. Try again in 1 minute.";
            document.getElementById('convo').appendChild(lim);
            return;
          }
          fetch('/backend-api/f/conversation', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'next', messages: [{ author: { role: 'user' },
              content: { content_type: 'text', parts: [t] } }] })
          }).then((r) => r.text());
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
      id, name: "Limit Resume Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    return id;
  }, PROMPT);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  console.log("\nThe limit notice pauses ChatGPT; waiting out its 1-minute cooldown…");
  let paused = null, ok = null, failed = null, resumed = null;
  const deadline = Date.now() + 170000;
  while (!ok && !failed && Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const st = await ask({ type: "loader-status" });
    if (!paused && st && st.platStats && st.platStats.chatgpt && st.platStats.chatgpt.paused) paused = st.platStats.chatgpt;
    const entries = ((await ask({ type: "error-log", limit: 200 })) || {}).entries || [];
    resumed = resumed || entries.find((e) => e.where === "run:auto-resume:chatgpt") || null;
    ok = entries.find((e) => e.where === "run:turn:chatgpt" && e.message === "ok") || null;
    failed = entries.find((e) => e.where === "run:turn-failed:chatgpt") || null;
  }
  await ask({ type: "loader-stop" });

  check("ChatGPT paused for the limit, with when it resumes", !!paused && !!paused.cooldownUntil, JSON.stringify(paused && { paused: paused.paused, cooldownUntil: paused.cooldownUntil }));
  check("it resumed by itself after the cooldown", !!resumed);
  check("the prompt was asked again", asked >= 2, `asked ${asked} time(s)`);
  check("and answered, not failed", !!ok && !failed, failed ? `${failed.message}` : "no answered turn within 170 s");
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
