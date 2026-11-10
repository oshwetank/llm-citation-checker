/*
 * analyze-header-gap.test.mjs — the dead band between the sticky .app-header
 * and the Analyze context bar right under it, measured as real on-screen
 * geometry in a real browser (full-tab view, where both live in the SAME
 * scrolling page).
 *
 * Reported twice. The first report ("too much space above the bar") was
 * partly fixed by cutting .app-content's own top padding from 24px to
 * 10px — but .app-header carried its OWN 24px bottom margin the whole
 * time, untouched by that fix and larger than the piece that WAS cut. A
 * second report ("distance has not decreased, it's still as it was")
 * called that out: a 14px-out-of-48px reduction reads as no change at all
 * when the dominant 24px is still there. Fixed by matching the header's
 * bottom margin to its 12px top margin.
 *
 * This guards the actual regression — not a specific pixel constant, since
 * that would just be re-asserting whatever the CSS currently says, but a
 * ceiling comfortably below the old ~34px dead band this bug produced.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXTURE = path.join(HERE, "fixtures", "chatgpt-finance-trading.txt");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-header-gap-test";

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
  console.log("\nanalyze-header-gap: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported layout regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// Start from an empty profile. This folder is fixed and outlives the run, so
// without this a second run on the same machine reopens the first run's
// storage. That is how analyze-feedback, which had the same fixed-folder
// launch, failed on 10 Nov 2026: old captures were merged into the answer
// (raw-capture.txt held 4 copies, not 2) on every run after the first, master
// included. CI never sees it because each runner starts clean. Only this
// test's own folder is removed.
rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extId}/ui/panel.html`);
  await seed.waitForTimeout(600);
  const raw = readFileSync(FIXTURE, "utf8");
  await seed.evaluate(
    (raw) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "raw-conversation",
          payload: { raw, reqBody: "{}", pageUrl: "https://chatgpt.com/", capturedAt: Date.now() },
        }, resolve);
      }),
    raw
  );
  await seed.waitForTimeout(80);
  await seed.close();

  console.log("\nFULL-TAB (1280px) — gap between .app-header and .analyze-context-bar");
  {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
    await page.waitForTimeout(1200);

    const rects = await page.evaluate(() => {
      const header = document.querySelector(".app-header");
      const bar = document.querySelector(".analyze-context-bar");
      if (!header || !bar) return null;
      const h = header.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { headerBottom: h.bottom, barTop: b.top };
    });

    check(".app-header and .analyze-context-bar are both on screen", !!rects, JSON.stringify(rects));
    if (rects) {
      const gap = rects.barTop - rects.headerBottom;
      // Old behaviour: 24px header margin-bottom + 24px (then 10px) content
      // padding-top stacked into a ~34-48px dead band. Comfortably below
      // that, without pinning to one exact number.
      check(`the visual gap is comfortably below the old ~34px dead band (got ${Math.round(gap)}px)`,
        gap < 30, `${gap}px`);
      check("the gap did not collapse to nothing (the bar still reads as a separate element)",
        gap >= 0, `${gap}px`);
    }
    await page.close();
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
