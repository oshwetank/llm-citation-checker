/*
 * tab-management.test.mjs — the engine tabs a campaign run opens are
 * grouped and collapsed rather than spilling across the window, and closing
 * them is scoped correctly: never on an explicit Stop (the user is likely
 * reaching for one of those tabs), and never one the user has reclaimed for
 * their own browsing mid-run.
 *
 * Reported: "i want to automatically group and colapse llm tabs which
 * opens, so that they don't fill the entire windown. I also would like this
 * tabs to automatically close after all the prompts are run."
 *
 * A full submit-to-capture cycle (real network response -> real adapter ->
 * leg.idx advancing to natural completion) is deliberately NOT reproduced
 * here — concurrency-live.test.mjs's own header explains why: doing that
 * live would mean re-testing the whole capture pipeline, not tab
 * management. What's covered instead is everything this feature actually
 * added: the tabs come back grouped and collapsed the moment a run starts,
 * and Stop — the one path that must NOT trigger the auto-close — leaves
 * them open. Natural-completion auto-close reuses closeRunTabs(), which
 * reuses checkTabOwnership() — already exercised by the reload-retry and
 * interrupted-run suites — so the close/skip decision itself isn't new,
 * untested logic; only its use at run-start (grouping) and its scoping
 * (never on Stop) are new surface, and that's what this file pins.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-tab-mgmt-test";

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
  console.log("\ntab-management: CANNOT RUN — playwright is not installed.");
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
  // Context-wide, exactly like concurrency-live.test.mjs, so it also covers
  // the tabs the EXTENSION opens via chrome.tabs.create.
  await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com|www\.perplexity\.ai|grok\.com)\//, (route) =>
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

  console.log("\nSeeding a locked campaign with 3 prompts on three engines");
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
      id: profileId, name: "Tab Management Test",
      brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "gemini", "perplexity"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    let seq = 0;
    const batchAt = Date.now();
    for (const text of ["prompt one", "prompt two", "prompt three"]) {
      await put("trackedPrompts", {
        id: crypto.randomUUID(), profileId, text, tags: [], active: true, createdAt: batchAt + seq++,
      });
    }
    return profileId;
  });
  check("campaign seeded", !!profileId);

  // Snapshot tab ids BEFORE starting the run — a freshly launched persistent
  // context can carry its own initial about:blank tab that has nothing to do
  // with this run, so "which tabs are ours" is answered by what's NEW after
  // starting, not by guessing from URL shape.
  const preRunIds = await page.evaluate(() => new Promise((res) =>
    chrome.tabs.query({}, (tabs) => res(tabs.map((t) => t.id)))));

  console.log("\nStarting the run groups and collapses its tabs");
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("geo-run-start accepted it", started && started.ok, JSON.stringify(started));
  await page.waitForTimeout(1200);

  const runTabs = await page.evaluate(async (preRunIds) => {
    const tabs = await new Promise((res) => chrome.tabs.query({}, res));
    const pre = new Set(preRunIds);
    const ours = tabs.filter((t) => !pre.has(t.id));
    const groups = await new Promise((res) => chrome.tabGroups.query({}, res));
    return {
      tabCount: tabs.length,
      ours: ours.map((t) => ({ id: t.id, groupId: t.groupId, url: t.url, autoDiscardable: t.autoDiscardable })),
      groups,
    };
  }, preRunIds);

  // 3 prompts, 1 tab per engine (below CONCURRENT_TABS_PER_ENGINE's shard
  // threshold for this volume) x 3 engines = 3 tabs, all sharing one group.
  const groupedIds = runTabs.ours.filter((t) => t.groupId !== -1).map((t) => t.groupId);
  check("at least one run tab was actually created", runTabs.ours.length > 0, JSON.stringify(runTabs.ours));
  check("every run tab is in a group, not loose in the window",
    groupedIds.length === runTabs.ours.length, JSON.stringify(runTabs.ours));
  check("all of them share the SAME group — one group for the whole run",
    new Set(groupedIds).size === 1, JSON.stringify(groupedIds));
  check("a tab group actually exists", runTabs.groups.length >= 1, JSON.stringify(runTabs.groups));
  const group = runTabs.groups.find((g) => g.id === groupedIds[0]);
  check("the group is collapsed, so it doesn't fill the window", group && group.collapsed === true, JSON.stringify(group));
  check("the group is titled so it's identifiable", group && group.title === "CitoSkeleton", group && group.title);

  console.log("\nRun tabs are opted out of Chrome's automatic discarder");
  // A discarded background tab reloads itself the instant the run touches
  // it again, which the reload-retry watchdog reads as "tab reloaded
  // repeatedly" and fails the turn — a real, reported failure mode with 4
  // heavy engine tabs sitting backgrounded for an entire run. Without this,
  // Chrome's own Memory Saver — not a bug in the run logic — was silently
  // destroying the majority of a campaign's prompts.
  check("every run tab has autoDiscardable explicitly turned off",
    runTabs.ours.every((t) => t.autoDiscardable === false), JSON.stringify(runTabs.ours));

  console.log("\nStopping the run leaves the tabs open — the user is likely reaching for one of them");
  const beforeStopCount = (await page.evaluate(() => new Promise((res) => chrome.tabs.query({}, (t) => res(t.length)))));
  const stopped = await ask({ type: "loader-stop" });
  check("loader-stop accepted", stopped && stopped.ok, JSON.stringify(stopped));
  await page.waitForTimeout(600);
  const afterStopCount = (await page.evaluate(() => new Promise((res) => chrome.tabs.query({}, (t) => res(t.length)))));
  check("stopping the run did not close any tabs", afterStopCount === beforeStopCount,
    `before=${beforeStopCount} after=${afterStopCount}`);

  check("no uncaught page errors anywhere in this flow", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
