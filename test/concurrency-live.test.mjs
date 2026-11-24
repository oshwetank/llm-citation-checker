/*
 * concurrency-live.test.mjs — starting a campaign really opens
 * CONCURRENT_TABS_PER_ENGINE tabs per engine, correctly sharded and
 * staggered, and loader-status reports each tab's own progress separately.
 *
 * concurrency.test.mjs already proves the pure math (the split, the
 * per-leg reconciliation) in isolation. This file is the other half: does
 * the real service worker, given a real campaign, actually WIRE that math
 * up — real chrome.tabs.create calls, the right shard handed to the right
 * tab, staggered starts, and a status report that can tell the two tabs
 * apart. That wiring is 100% new code for this feature; the math alone
 * being right doesn't prove background.js calls it correctly.
 *
 * Deliberately NOT attempting a full submit-to-capture cycle here. Driving
 * a real capture requires content-main.js's MAIN-world network interception
 * to see a fetch/XHR shaped like the real ChatGPT/Gemini API, which is a
 * separate, already-covered mechanism (fixtures replayed as raw-conversation
 * payloads elsewhere in this suite) — reproducing it inside a live tab this
 * test doesn't control the network stack of would mostly be re-testing that
 * pipeline, not concurrency. The advance-on-capture and advance-on-failure
 * code paths (loaderOnCapture, failTurnAndAdvance) are unchanged in what
 * they DO for a single leg — the only new risk in them is the leg lookup
 * (legForTab) and the leg-scoped reconciliation, both already pinned in
 * concurrency.test.mjs. What's tested here is everything upstream of that:
 * did starting the run create the right tabs with the right prompts at all.
 *
 * Network is routed context-wide to a trivial page for chatgpt.com/
 * gemini.google.com so navigation resolves instantly rather than depending
 * on the sandbox's network reachability — this test's assertions all happen
 * well before any real page would finish loading anyway.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-concurrency-test";

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
  console.log("\nconcurrency-live: CANNOT RUN — playwright is not installed.");
  console.log(`This guards new wiring, so it fails rather than skips. Reason: ${err.message}`);
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
  // Context-wide, so it also covers the tabs the EXTENSION opens via
  // chrome.tabs.create — not just the one page this script drives directly.
  await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<body>stub</body>" }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);
  const tabCount = () => page.evaluate(
    () => new Promise((res) => chrome.tabs.query({}, (tabs) => res(tabs.length))));

  // 5 prompts -> shardPrompts(5, 2) = [3, 2]: both legs real and unequal,
  // the exact case concurrency.test.mjs pins the math for.
  const PROMPTS = ["prompt one", "prompt two", "prompt three", "prompt four", "prompt five"];

  console.log("\nSeeding a locked campaign with 5 prompts on both engines");
  const seeded = await page.evaluate(async (prompts) => {
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
      id: profileId, name: "Concurrency Test",
      brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "gemini"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    // geoRunStart (background.js) orders prompts by createdAt, and a plain
    // Date.now() per row ties within this tight loop — db.getAll()'s
    // underlying order is the primary key (a random UUID), not insertion
    // order, so tied rows come back scrambled rather than in the order
    // seeded here. Stamp a strictly increasing createdAt (this is exactly
    // the real bug geo-prompt-bulk-add-rows was fixed for) so this test's
    // "shard 0 is the front of PROMPTS" assumptions hold reliably.
    let seq = 0;
    const batchAt = Date.now();
    for (const text of prompts) {
      await put("trackedPrompts", {
        id: crypto.randomUUID(), profileId, text,
        tags: [], active: true, createdAt: batchAt + seq++,
      });
    }
    return profileId;
  }, PROMPTS);
  check("campaign seeded", !!seeded, String(seeded));

  const before = await tabCount();

  console.log("\nStarting the run creates the right number of REAL tabs");
  // skipAuthCheck is the documented override behind the sign-in warning
  // dialog (see the PRE-FLIGHT AUTH GATE note in background.js). It is passed
  // here because this file measures TAB CONCURRENCY, not authentication: the
  // gate landed after these assertions were written, and no CI runner — nor
  // any sandbox — can hold a live ChatGPT/Gemini session for the cookie check
  // to find, so without it the run is refused before a single tab is created
  // and all three assertions below fail for a reason none of them is about.
  const start = await ask({ type: "geo-run-start", profileId: seeded, skipAuthCheck: true });
  check("geo-run-start accepted it", start && start.ok, JSON.stringify(start).slice(0, 200));

  // Give loaderStart's synchronous tab-creation loop time to finish — this
  // does NOT wait for any page to load, just for chrome.tabs.create to have
  // been called the right number of times.
  await page.waitForTimeout(1200);
  const after = await tabCount();
  const opened = after - before;
  // Gemini in 2 tabs (5 prompts split into two non-empty shards) plus ChatGPT
  // in 1 (0.79.0: its tabs share one session, see pacing.js TABS_PER_ENGINE)
  // = 3 new tabs. This is the headline assertion: concurrency is
  // supposed to open MORE than one tab per engine now, and this is the only
  // way to prove that really happened rather than trusting a status report
  // that could be wrong in the same way the tabs are.
  check("exactly 4 new real tabs were opened (Gemini in 2, ChatGPT in 2: 1.0.5)",
    opened === 4, `before=${before} after=${after} opened=${opened}`);

  console.log("\nloader-status reports Gemini's 2 legs, correctly sharded, and ChatGPT's 1");
  const status = await ask({ type: "loader-status" });
  check("a run is reported as running", status && status.running === true, JSON.stringify(status).slice(0, 200));

  {
    const ps = status.platStats && status.platStats.chatgpt;
    check("chatgpt: the whole list across its two tabs (1.0.5)", ps && ps.total === 5 && Array.isArray(ps.legs) && ps.legs.length === 2, JSON.stringify(ps && ps.legs));
  }
  for (const plat of ["gemini"]) {
    const ps = status.platStats && status.platStats[plat];
    check(`${plat}: platStats exists`, !!ps, JSON.stringify(status.platStats).slice(0, 300));
    if (!ps) continue;
    check(`${plat}: total is 5 (the whole prompt list), not per-leg or doubled`,
      ps.total === 5, String(ps.total));
    check(`${plat}: reports exactly 2 legs, matching CONCURRENT_TABS_PER_ENGINE`,
      Array.isArray(ps.legs) && ps.legs.length === 2, JSON.stringify(ps.legs));
    if (Array.isArray(ps.legs) && ps.legs.length === 2) {
      const sizes = ps.legs.map((l) => (l.current ? 1 : 0));
      // Leg 1 should already be under way (its tab was navigated
      // immediately); leg 2 is staggered by LEG_START_STAGGER_MS (~2.5s) and
      // this check runs well inside that window, so it should NOT have a
      // current prompt yet — this is what actually proves the stagger fired
      // rather than both tabs being kicked off in the same instant.
      check("tab 1 already has a prompt in flight (started immediately)",
        ps.legs[0].current != null, JSON.stringify(ps.legs[0]));
      check("tab 2 has NOT started yet — the offset-start stagger is holding it back",
        ps.legs[1].current == null, JSON.stringify(ps.legs[1]));
    }
  }

  // Confirm the two engines' first-tab prompts are drawn from the front of
  // the SAME 5-prompt list (shardPrompts is contiguous: shard 0 = prompts
  // 0..2), not two independently shuffled lists.
  const chatgptFirst = status.platStats.chatgpt.legs[0]?.current;
  const geminiFirst = status.platStats.gemini.legs[0]?.current;
  check("both engines are working the same prompt list from the front",
    chatgptFirst === PROMPTS[0] && geminiFirst === PROMPTS[0],
    `chatgpt="${chatgptFirst}" gemini="${geminiFirst}" want="${PROMPTS[0]}"`);

  console.log("\nWaiting past the stagger window: tab 2 should now have started too");
  await page.waitForTimeout(3000); // LEG_START_STAGGER_MS (2500) + margin
  const status2 = await ask({ type: "loader-status" });
  for (const plat of ["gemini"]) {
    const ps = status2.platStats && status2.platStats[plat];
    const leg2 = ps && ps.legs && ps.legs[1];
    check(`${plat}: tab 2 has started after the stagger window elapsed`,
      leg2 && leg2.current != null, JSON.stringify(leg2));
    // The two tabs must be on DIFFERENT prompts — proof the shard split is
    // real, not both tabs racing through the same list.
    if (leg2 && leg2.current != null) {
      check(`${plat}: tab 2's prompt differs from tab 1's — they are working separate shards`,
        leg2.current !== ps.legs[0].current, `both show "${leg2.current}"`);
      check(`${plat}: tab 2 is working the SECOND shard (contiguous split, prompt 4 = index 3)`,
        leg2.current === PROMPTS[3], `got "${leg2.current}", want "${PROMPTS[3]}"`);
    }
  }

  console.log("\nStopping the run cleans up rather than leaving tabs to time out");
  const stopped = await ask({ type: "loader-stop" });
  check("loader-stop accepted", stopped && stopped.ok, JSON.stringify(stopped).slice(0, 120));
  check("no page error anywhere in this flow", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
