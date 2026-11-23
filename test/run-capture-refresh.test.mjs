/*
 * run-capture-refresh.test.mjs — a campaign run's captures don't reload the
 * panel one by one (1.0.4; first fixed in 0.62.2, back since).
 *
 * Each `new-capture` from a run used to reload every stored answer and
 * redraw Analyze, the Dashboard and Compare in every open panel: on a big
 * store the worker was busy for seconds per answer, a popup took over 30 s
 * to open, and the Campaigns page blinked on every capture. A run's capture
 * now only marks the data stale; it is reloaded when a tab that shows answers
 * is opened (or every 30 s while one is open). A capture asked by hand still
 * refreshes at once.
 *
 * Broadcasts are fired from a second extension page: a page's own
 * sendMessage is not delivered to its own onMessage listener.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-run-refresh-test";

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
  console.log(`\nrun-capture-refresh: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__reloads = 0;
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...a) => { if (a[0] && a[0].type === "get-records") window.__reloads++; return orig(...a); };
  });
  const other = await context.newPage();
  await other.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await other.waitForTimeout(800);
  const fire = (body) => other.evaluate((b) => chrome.runtime.sendMessage(b).catch(() => null), body);
  const reloads = () => page.evaluate(() => window.__reloads);

  console.log("\nOn the Campaigns page, a run's captures reload nothing");
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(800);
  const before = await reloads();
  for (let i = 0; i < 8; i++) { await fire({ type: "new-capture", captureId: `run-${i}`, duringRun: true }); await page.waitForTimeout(250); }
  await page.waitForTimeout(1500);
  check("8 run captures, no reload", (await reloads()) === before, `${(await reloads()) - before} reloads`);

  console.log("\nOpening the Dashboard catches up, once");
  await page.evaluate(() => document.querySelector('[data-tab="dashboard"]')?.click());
  await page.waitForTimeout(1500);
  check("one reload on opening it", (await reloads()) - before === 1, `${(await reloads()) - before} reloads`);

  console.log("\nA capture asked by hand still refreshes at once");
  const b2 = await reloads();
  await fire({ type: "new-capture", captureId: "adhoc-1" });
  await page.waitForTimeout(1500);
  check("it reloads", (await reloads()) - b2 === 1, `${(await reloads()) - b2} reloads`);
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
