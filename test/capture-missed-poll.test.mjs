/*
 * capture-missed-poll.test.mjs — the "wasn't captured" check runs as one
 * loop, however many captures arrive.
 *
 * Seen in a live run (23 Nov 2026): the panel checks for missed answers
 * every 20 s and again on every capture. Two checks in flight together each
 * set their own 20 s timer, so the loops multiplied with every burst of
 * captures and never stopped; an hour into a campaign run, the open panels
 * sent hundreds of capture-missed requests every few seconds and slowed the
 * worker, which delayed every screen.
 *
 * Broadcasts are fired from a second extension page: a page's own
 * sendMessage is not delivered to its own onMessage listener.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-missed-poll-test";

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
  console.log(`\ncapture-missed-poll: CANNOT RUN — playwright is not installed. ${err.message}`);
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
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1500);
  // Count the panel's own capture-missed requests from here on.
  await page.evaluate(() => {
    window.__missed = 0;
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...a) => { if (a[0] && a[0].type === "capture-missed") window.__missed++; return orig(...a); };
  });

  const other = await context.newPage();
  await other.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await other.waitForTimeout(800);

  console.log("\nThree bursts of 20 captures arrive at once");
  for (let b = 0; b < 3; b++) {
    await other.evaluate(() => Promise.all(Array.from({ length: 20 }, (_, i) =>
      chrome.runtime.sendMessage({ type: i % 2 ? "capture-updated" : "new-capture", captureId: `burst-${Date.now()}-${i}`, duringRun: true }).catch(() => null))));
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(2000);
  const afterBursts = await page.evaluate(() => window.__missed);
  check("a burst is answered by a few checks, not one per capture", afterBursts <= 8, `${afterBursts} checks`);

  console.log("\nThen 45 s with nothing new: one loop, every 20 s");
  const before = afterBursts;
  await page.waitForTimeout(45000);
  const quiet = (await page.evaluate(() => window.__missed)) - before;
  check("2 or 3 checks in 45 s (one 20-second loop)", quiet >= 1 && quiet <= 3, `${quiet} checks`);
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
