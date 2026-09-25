/*
 * capture-attribution.test.mjs — a campaign capture is filed under the prompt
 * it ANSWERS, not whichever prompt its tab happens to be on when it arrives.
 *
 * Found in a real 40-prompt run's diagnostics export: several captures stored
 * under the wrong tracked prompt — Gemini's answer to prompt 8 filed as prompt
 * 9, prompt 9's as prompt 10, ChatGPT's answer to prompt 3 as prompt 2. The
 * capture handler stamped each capture with the tab's CURRENT position, so an
 * answer that arrived after its turn had timed out (and the tab had moved on)
 * was attributed to the next prompt. The run correctly refused to COUNT it,
 * but the record was already saved under the wrong prompt, feeding one
 * prompt's answer into another's visibility and position metrics — silently.
 *
 * This drives the real pipeline rather than calling a helper: stub engine
 * pages make the same POST a real ChatGPT answer does, content-main.js
 * intercepts it, content-iso.js relays it, and the service worker stores it.
 * The ChatGPT adapter reads the question from the request body, which is what
 * lets the stub control which prompt an answer claims to be for.
 *
 * Scenario, on one tab running prompts [A, B]:
 *   - A's page answers A — credited, and the tab moves on to B
 *   - B's page then receives ANOTHER answer to A (the late-arrival case)
 * That second capture must be filed under A. Before the fix it was filed
 * under B.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-attribution-test";

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
  console.log("\ncapture-attribution: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a data-integrity regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// A real captured ChatGPT answer stream; everything after its "# …" header.
const fixture = fs.readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
const SSE_BODY = fixture.slice(fixture.indexOf("\n\n") + 2);

// Four prompts across two tabs (CONCURRENT_TABS_PER_ENGINE = 2), so the tab
// under test runs [A, B]. Long and distinct, like real campaign prompts, so
// attribution is decided by the text rather than by a lucky prefix.
const A = "1. I have thirty thousand rupees to spend on a phone and care most about the camera";
const B = "2. My priority is fast charging, which phones around thirty thousand charge quickest";
const C = "3. I need a phone that lasts all day on heavy usage without needing a top up charge";
const D = "4. What phone under thirty thousand would you recommend for gaming at high frame rates";

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
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    const url = new URL(route.request().url());
    if (/\/backend-api\/(f\/)?conversation/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: SSE_BODY });
    }
    // The engine page for one prompt. It answers the question named in its
    // own script — which, on B's page, is deliberately A.
    const q = url.searchParams.get("q") || "";
    const answers = q === A ? A : q === B ? A : q === C ? C : null;
    const script = answers
      ? `<script>setTimeout(function () {
           fetch("/backend-api/f/conversation", {
             method: "POST",
             headers: { "content-type": "application/json" },
             body: JSON.stringify({ action: "next", messages: [{ author: { role: "user" },
               content: { content_type: "text", parts: [${JSON.stringify(answers)}] } }] })
           }).then(function (r) { return r.text(); });
         }, 700);</script>`
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

  console.log("\nSeeding a locked ChatGPT campaign with four prompts");
  const seeded = await page.evaluate(async (texts) => {
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
    const profileId = crypto.randomUUID();
    await put("profiles", {
      id: profileId, name: "Attribution Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    const ids = {};
    let seq = 0;
    const at = Date.now();
    for (const text of texts) {
      const id = crypto.randomUUID();
      ids[text] = id;
      await put("trackedPrompts", { id, profileId, text, tags: [], active: true, createdAt: at + seq++ });
    }
    return { profileId, ids };
  }, [A, B, C, D]);
  check("campaign seeded", !!seeded.profileId);

  const started = await ask({ type: "geo-run-start", profileId: seeded.profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  // A's answer lands (~1s), the tab waits 3-6s, moves to B, and B's page
  // delivers the late answer to A ~1s after that.
  await page.waitForTimeout(16000);
  await ask({ type: "loader-stop" });

  const answersToA = await page.evaluate(async (A) => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res, rej) => {
      const r = dbh.transaction("derived").objectStore("derived").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return all.filter((r) => r.userPrompt === A).map((r) => ({ promptId: r.geo && r.geo.promptId, at: r.capturedAt }));
  }, A);

  console.log("\nA late answer is filed under the prompt it answers");
  check("both answers to A were captured — the one on A's page and the late one on B's",
    answersToA.length === 2, `${answersToA.length} captured`);
  check("every answer to A is filed under A — none under B",
    answersToA.length > 0 && answersToA.every((r) => r.promptId === seeded.ids[A]),
    JSON.stringify(answersToA.map((r) => r.promptId === seeded.ids[A] ? "A" : r.promptId === seeded.ids[B] ? "B" : r.promptId)));

  // The raw row is what "Reprocess all captures" rebuilds geo from — if only
  // the derived record were corrected, a reprocess would bring B back.
  const rawGeo = await page.evaluate(async (A) => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = (store) => new Promise((res, rej) => {
      const r = dbh.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const derived = (await get("derived")).filter((r) => r.userPrompt === A).map((r) => r.captureId);
    return (await get("raw")).filter((r) => derived.includes(r.captureId)).map((r) => r.geo && r.geo.promptId);
  }, A);
  check("the correction survives a reprocess — the raw row agrees",
    rawGeo.length > 0 && rawGeo.every((id) => id === seeded.ids[A]),
    JSON.stringify(rawGeo.map((id) => id === seeded.ids[A] ? "A" : id === seeded.ids[B] ? "B" : id)));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
