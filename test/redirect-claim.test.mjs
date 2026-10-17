/*
 * redirect-claim.test.mjs — a prompt survives the tab being sent to another
 * page.
 *
 * The prompt reaches the engine only in the tab's address (?q=…&lcfc=1), so
 * a reload or a cross-page redirect loses it: the page the tab lands on has
 * no markers and nothing types the prompt. The run keeps the prompt, so a
 * page the tab lands on can ask for it: a document without markers, in a
 * tab the run owns, on that tab's engine, whose turn hasn't gone out yet, is
 * handed the turn. One that has gone out is not — a redirect after a send
 * must never send it twice.
 *
 * Written after grok.com's /tos-gate hop in a v0.45.3 run, modelled here as
 * a cross-page redirect. A v0.45.4 run showed that hop happens inside the
 * same document (a false "sent", covered in prompt-submit.test.mjs); the
 * recovery stays for real reloads and redirects, which lose the prompt
 * exactly as this stub does. A second prompt's page sends the prompt itself
 * (Grok's own submit request) before bouncing.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-redirect-claim-test";
const LOST = "which phone has the best low light camera";
const SENT = "SENT-FIRST which laptop lasts longest on battery";

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
  console.log("\nredirect-claim: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a real-run failure, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  // Every submit request Grok's page makes, with the prompt it carried and
  // the page it came from.
  const submits = [];
  await context.route(/^https:\/\/grok\.com\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "POST" && url.pathname === "/rest/app-chat/conversations/new") {
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch (_) { /* keep empty */ }
      submits.push({ text: body.message || "", from: body.from || "" });
      // The answer is still streaming for as long as the test looks: a reply
      // that finished would complete the turn, and a completed turn is never
      // handed to another page anyway — which would leave the no-second-send
      // check proving nothing.
      setTimeout(() => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {}), 60000);
      return;
    }
    const html = (b) => route.fulfill({ status: 200, contentType: "text/html", body: `<body>${b}</body>` });
    if (url.pathname === "/tos-gate") {
      return html(`tos-gate<script>setTimeout(function () { location.href = "/"; }, 200);</script>`);
    }
    if (url.pathname === "/" && url.searchParams.has("q")) {
      // The prompt page. The SENT-FIRST one sends the prompt itself, as a
      // native ?q= submit would, then bounces like the other.
      return html(`grok prompt page<script>
        var q = new URLSearchParams(location.search).get('q') || '';
        if (q.indexOf('SENT-FIRST') === 0) {
          setTimeout(function () {
            fetch('/rest/app-chat/conversations/new', { method: 'POST', body: JSON.stringify({ message: q, from: 'prompt-page' }) });
          }, 300);
        }
        setTimeout(function () { location.href = '/tos-gate'; }, 1500);
      </script>`);
    }
    // The bare page the bounce lands on: a working composer.
    return html(`<textarea placeholder="Ask anything"></textarea>
      <button aria-label="Send" type="button">send</button><div id="convo"></div>
      <script>
        var box = document.querySelector('textarea');
        document.querySelector('button').addEventListener('click', function () {
          var t = box.value.trim(); if (!t) return;
          box.value = '';
          fetch('/rest/app-chat/conversations/new', { method: 'POST', body: JSON.stringify({ message: t, from: 'bare-page' }) });
          var d = document.createElement('div'); d.className = 'user-message'; d.textContent = t;
          document.getElementById('convo').appendChild(d);
        });
      </script>`);
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  const profileId = await page.evaluate(async (texts) => {
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
      id, name: "Redirect Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["grok"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    for (const text of texts) {
      await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    }
    return id;
  }, [LOST, SENT]);

  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("the run started", started && started.ok, JSON.stringify(started));

  // Both prompts run at once, one per tab. Bounce at 1.5s, back by ~2s, then
  // the composer needs a few ticks and a send.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !submits.some((s) => s.from === "bare-page")) await page.waitForTimeout(500);
  await page.waitForTimeout(4000); // room for a duplicate to show up

  console.log("\nThe engine bounced the tab and dropped the prompt from its address");
  const lost = submits.filter((s) => s.text === LOST);
  check("the page it landed on sent the prompt", lost.length >= 1, JSON.stringify(submits));
  check("exactly once", lost.length === 1, JSON.stringify(lost));
  check("from the page the tab ended up on", lost[0] && lost[0].from === "bare-page", JSON.stringify(lost));

  console.log("\nThe engine sent the prompt, then bounced the tab");
  const sent = submits.filter((s) => s.text === SENT);
  check("it was sent once, by the prompt page", sent.length === 1 && sent[0].from === "prompt-page", JSON.stringify(sent));
  check("and not again after the bounce", !sent.some((s) => s.from === "bare-page"), JSON.stringify(sent));

  await ask({ type: "loader-stop" });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
