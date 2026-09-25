/*
 * duplicate-capture.test.mjs — a second capture of an answer can't complete
 * the NEXT prompt, which would skip that prompt without it ever being asked.
 *
 * Found in a real ten-prompt, four-engine run on v0.42.0: it reported 35/40
 * captured, but the per-turn log showed Gemini "completing" prompts whose
 * turns began at the same instant as the turn before them, and two legs
 * completing a "prompt 10" that doesn't exist. After a turn completes, the
 * next prompt is only sent after a 3-6s pacing gap, and until then the leg
 * still expects the OLD prompt. Gemini sends several captures per answer, so
 * a second capture of the answer just counted landed in that gap, matched
 * the old prompt, and advanced the leg again: the next prompt was marked ok
 * without ever being asked. MIN_ADVANCE_GAP_MS (2.5s) didn't stop it
 * because the duplicate came 3-4s after the first.
 *
 * The real pipeline end to end: stub ChatGPT pages answer their own prompt
 * with a real captured answer stream, then keep re-sending that same answer
 * every 300ms from 2.8s on — so a duplicate is guaranteed to land in the
 * window between the 2.5s guard and the next navigation (at least 3s after
 * the completion). Four prompts across two tabs: [A, B] and [C, D].
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-duplicate-capture-test";

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
  console.log("\nduplicate-capture: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a silent prompt-skipping bug, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const fixture = fs.readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
const SSE_BODY = fixture.slice(fixture.indexOf("\n\n") + 2);

const A = "1. I have thirty thousand rupees to spend on a phone and care most about the camera";
const B = "2. My priority is fast charging, which phones around thirty thousand charge quickest";
const C = "3. I need a phone that lasts all day on heavy usage without needing a top up charge";
const D = "4. What phone under thirty thousand would you recommend for gaming at high frame rates";
const PROMPTS = [A, B, C, D];

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

const asked = []; // every prompt an engine page was opened for
try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    const url = new URL(route.request().url());
    if (/\/backend-api\/(f\/)?conversation/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE_BODY });
    }
    const q = url.searchParams.get("q") || "";
    if (route.request().resourceType() === "document" && q) asked.push(q);
    const script = PROMPTS.includes(q)
      ? `<script>
          function answer() {
            fetch("/backend-api/f/conversation", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "next", messages: [{ author: { role: "user" },
                content: { content_type: "text", parts: [${JSON.stringify(q)}] } }] })
            }).then(function (r) { return r.text(); });
          }
          setTimeout(answer, 700);
          // The same answer again, and again — as Gemini's several captures
          // per answer do — until the run navigates this page away.
          setTimeout(function () { answer(); setInterval(answer, 300); }, 2800);
        </script>`
      : "";
    return route.fulfill({ status: 200, contentType: "text/html", body: `<body>stub${script}</body>` });
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
      id, name: "Duplicate Capture Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    let seq = 0;
    for (const text of texts) {
      await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() + seq++ });
    }
    return id;
  }, PROMPTS);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  // Two prompts a tab: ~1s to answer, a 3-6s gap, ~1s to answer, plus the
  // second tab's 2.5s stagger. Then time for any phantom to show itself.
  await page.waitForTimeout(24000);
  const status = await ask({ type: "loader-status" });
  const turns = await ask({ type: "error-log", limit: 200, cat: "turn" });
  await ask({ type: "loader-stop" });

  const oks = ((turns && turns.entries) || []).filter((e) => e.where === "run:turn:chatgpt" && e.message === "ok");
  const idxs = oks.map((e) => e.context.promptIndex).sort((a, b) => a - b);

  console.log("\nEvery prompt is asked, and completed once");
  for (const [label, p] of [["A", A], ["B", B], ["C", C], ["D", D]]) {
    check(`prompt ${label} was actually asked`, asked.includes(p), `asked: ${asked.map((q) => q.slice(0, 2)).join(" ")}`);
  }
  check("four turns completed — one per prompt", oks.length === 4, `completed indexes: ${idxs.join(",")}`);
  check("no prompt completed twice", new Set(idxs).size === idxs.length, idxs.join(","));
  check("no turn completed past the end of the list", idxs.every((i) => i >= 0 && i < 4), idxs.join(","));
  check("the run's own count agrees", status && status.done === 4, JSON.stringify(status && { done: status.done, errors: status.errors }));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
