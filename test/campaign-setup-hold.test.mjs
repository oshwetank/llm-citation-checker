/*
 * campaign-setup-hold.test.mjs — a campaign's setup form is not rebuilt by
 * the captures of a run going on elsewhere.
 *
 * Seen in a live run (23 Nov 2026): with one campaign running, setting up a
 * second one was impossible. Every capture of the run broadcasts
 * `new-capture`; the panel answered each with load(), which rebuilt the
 * Campaigns tab every 2–3 s. The campaign's name and brand survive in
 * setupDraft, but a half-typed competitor, prompts pasted and not yet added,
 * and the cursor were wiped. A new capture never changes a setup form, so
 * the form is now left alone.
 *
 * Broadcasts are fired from a second extension page: a page's own
 * sendMessage is not delivered to its own onMessage listener.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-setup-hold-test";

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
  console.log(`\ncampaign-setup-hold: CANNOT RUN — playwright is not installed. ${err.message}`);
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
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.reload();
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector(".geo-chip.add")?.click());
  await page.waitForTimeout(1000);

  const other = await context.newPage();
  await other.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await other.waitForTimeout(800);
  const fire = (body) => other.evaluate((b) => chrome.runtime.sendMessage(b), body);

  console.log("\nA new campaign's setup form, half filled in");
  check("the setup form is open", await page.locator("#loader .cs-card-details").count() === 1);
  await page.fill("#cs-name", "Hold test");
  await page.fill("#cs-comp-name", "Half-typed rival");
  await page.click('.cs-mode[data-mode="manual"]').catch(() => {});
  const pasted = "first pasted prompt\nsecond pasted prompt";
  if (await page.locator("#cs-manual").count()) await page.fill("#cs-manual", pasted);
  await page.focus("#cs-comp-name");
  await page.evaluate(() => { window.__field = document.getElementById("cs-comp-name"); });

  console.log("\nCaptures of a run going on elsewhere arrive");
  for (let i = 0; i < 4; i++) {
    await fire({ type: "new-capture", captureId: `run-${i}`, duringRun: true });
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(900);
  check("the competitor field is the same element (not rebuilt)", await page.evaluate(() => document.getElementById("cs-comp-name") === window.__field));
  check("the half-typed competitor is kept", (await page.inputValue("#cs-comp-name")) === "Half-typed rival");
  if (await page.locator("#cs-manual").count()) check("prompts pasted but not added are kept", (await page.inputValue("#cs-manual")) === pasted);
  check("the cursor stays in the field", await page.evaluate(() => document.activeElement && document.activeElement.id === "cs-comp-name"));
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
