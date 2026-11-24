/*
 * campaign-tabs-scroll.test.mjs — a campaign's section tabs in the popup
 * (1.0.4, UI audit of 23 Nov 2026).
 *
 * The tab bar scrolls sideways with its scrollbar hidden. It was rebuilt on
 * every pick, scrolled back to the left: picking a tab past the edge hid it
 * again, and a board reopened on its last section ("Signals") showed no tab
 * as open. A mouse wheel couldn't reach the tabs past the edge at all.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seedCampaign } from "./helpers/campaign-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-tabs-scroll-test";

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
  console.log(`\ncampaign-tabs-scroll: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  const { extId, seeded } = await seedCampaign(context, path.join(HERE, "fixtures"));
  if (seeded.error) { console.log(`\ncampaign-tabs-scroll: CANNOT RUN — ${seeded.error}`); process.exit(1); }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.setViewportSize({ width: 540, height: 640 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForSelector(".cv-tabs .cv-tab", { timeout: 15000 });
  await page.waitForTimeout(800);
  const inView = (id) => page.evaluate((id) => {
    const bar = document.querySelector(".cv-tabs"); const t = document.querySelector(`.cv-tab[data-section="${id}"]`);
    if (!bar || !t) return false;
    const b = bar.getBoundingClientRect(), r = t.getBoundingClientRect();
    return r.left >= b.left - 1 && r.right <= b.right + 1;
  }, id);
  const last = await page.evaluate(() => [...document.querySelectorAll(".cv-tab")].pop().dataset.section);

  console.log("\nThe bar is wider than the popup");
  check("its last tab starts out of sight", !(await inView(last)), last);

  console.log("\nPicking a tab past the edge keeps it in sight");
  await page.evaluate((id) => document.querySelector(`.cv-tab[data-section="${id}"]`).click(), last);
  await page.waitForTimeout(600);
  check("the picked tab is in sight after the bar is rebuilt", await inView(last));

  console.log("\nReopened on that section, its tab is in sight");
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForSelector(".cv-tabs .cv-tab.on", { timeout: 15000 });
  await page.waitForTimeout(800);
  check("the open section's tab shows", await inView(last));

  console.log("\nA mouse wheel scrolls the bar sideways");
  await page.evaluate(() => { document.querySelector(".cv-tabs").scrollLeft = 0; });
  const box = await page.locator(".cv-tabs").boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  check("the wheel moved the tabs", await page.evaluate(() => document.querySelector(".cv-tabs").scrollLeft > 0));
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
