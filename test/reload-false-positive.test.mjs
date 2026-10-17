/*
 * reload-false-positive.test.mjs — the mid-turn reload detector must not fire
 * on the engine's OWN post-submit navigation.
 *
 * Reported, twice, from real runs: "tab reloaded repeatedly" accounting for
 * 56/60 and then 63/65 of a campaign's failures, across chatgpt, gemini,
 * perplexity and grok simultaneously, starting within seconds of the run
 * beginning. That is not a browser discarding backgrounded tabs (which takes
 * minutes and would not hit every tab at once) — it is the run misreading
 * ordinary engine behaviour as a lost prompt.
 *
 * Every supported engine navigates after accepting a prompt: submitting from
 * `/?q=…` lands you on the conversation it just created. That is a real
 * document load, so it reaches chrome.tabs.onUpdated as `status:"loading"`,
 * and it happens whenever the engine gets round to it — routinely more than
 * RELOAD_DETECT_GRACE_MS after the navigation the run itself issued. The
 * detector counted it as a spontaneous reload, re-navigated the tab (killing
 * the answer that was actually on its way), and after MAX_RELOAD_RETRIES
 * failed the turn. Worse, each retry re-issues the navigation, which produces
 * the next late load event — so the retry causes the next detection and the
 * turn burns its whole budget in seconds. That is the 3-10s, retries=3
 * signature in both diagnostic reports.
 *
 * The grace window cannot fix this by being bigger: how long an engine takes
 * to create a conversation is not a constant this extension gets to pick.
 * What distinguishes a lost prompt from normal progress is EVIDENCE, not
 * elapsed time — so that is what this test pins. The stub below reproduces
 * the real behaviour deterministically: serve the prompt URL, then navigate
 * to a conversation URL well after the grace window has expired.
 *
 * Note the same navigation is ALREADY the content script's own proof of a
 * successful submit (`submittedWhy()`'s "url" branch in content-iso.js): the
 * page moving to a longer path is how it knows the prompt went out. The two
 * halves of the extension were reading one event in opposite directions.
 *
 * NOT covered here, deliberately rather than by oversight: the other side of
 * the detector — a turn whose prompt never reached the page at all, which
 * must still be retried. Producing that needs the tab to COMMIT a document
 * whose URL lacks the loader token (what a sign-out redirect does in the
 * wild), and this harness cannot: playwright's route.fulfill aborts on a 3xx
 * (net::ERR_ABORTED) and a meta-refresh is interrupted before it commits.
 * Both were tried. That path is therefore still verified by reading rather
 * than by test — worth knowing before anyone narrows the detector further.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-reload-fp-test";

// Comfortably past RELOAD_DETECT_GRACE_MS (3s) — a real engine taking longer
// than that to open the conversation is the normal case, not an edge case.
const ENGINE_NAV_DELAY_MS = 3500;

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
  console.log("\nreload-false-positive: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a shipped regression, so it fails rather than skips. Reason: ${err.message}`);
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
  // The engine stub. A prompt URL (?q=…) answers immediately and then, after
  // the grace window has passed, navigates to a conversation URL the way a
  // real engine does once it has accepted the prompt. The conversation URL
  // itself is a plain terminal page — it must NOT bounce again, so that any
  // reload report this test sees is attributable to the one navigation it
  // deliberately performs.
  await context.route(
    /^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|www\.perplexity\.ai|grok\.com)\//,
    (route) => {
      const url = new URL(route.request().url());
      const isPromptUrl = url.searchParams.has("q");
      const body = isPromptUrl
        ? `<body>stub composer<script>
             setTimeout(function () {
               location.href = "https://" + location.host + "/c/conversation-created";
             }, ${ENGINE_NAV_DELAY_MS});
           </script></body>`
        : `<body>stub conversation</body>`;
      return route.fulfill({ status: 200, contentType: "text/html", body });
    });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  console.log("\nSeeding a locked campaign");
  const profileId = await page.evaluate(async () => {
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
      id: profileId, name: "Reload False Positive Test",
      brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "perplexity"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    let seq = 0;
    const batchAt = Date.now();
    for (const text of ["prompt one", "prompt two"]) {
      await put("trackedPrompts", {
        id: crypto.randomUUID(), profileId, text, tags: [], active: true, createdAt: batchAt + seq++,
      });
    }
    return profileId;
  });
  check("campaign seeded", !!profileId);

  console.log("\nRunning, while each engine tab navigates to its conversation mid-turn");
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("geo-run-start accepted it", started && started.ok, JSON.stringify(started));

  // Long enough for the stub's navigation (3.5s) plus the two retries the old
  // detector would burn immediately afterwards, so a regression shows up as
  // real entries rather than as a race this test happened to outrun.
  await page.waitForTimeout(14000);

  const log = await ask({ type: "error-log", limit: 400 });
  const entries = (log && log.entries) || [];
  const reloadRetries = entries.filter((e) => String(e.where || "").startsWith("run:tab-reloaded"));
  const reloadFails = entries.filter((e) => String(e.message || "") === "tab reloaded repeatedly");

  check("the engine's own post-submit navigation is not reported as a reload",
    reloadRetries.length === 0,
    `${reloadRetries.length} retry reports: ${JSON.stringify(reloadRetries.slice(0, 3).map((e) => e.where))}`);
  check("no turn was failed as 'tab reloaded repeatedly'",
    reloadFails.length === 0,
    `${reloadFails.length} such failures`);

  await ask({ type: "loader-stop" });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
