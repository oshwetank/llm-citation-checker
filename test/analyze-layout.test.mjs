/*
 * analyze-layout.test.mjs — asserts the Analyze tab's READING ORDER, in a
 * real browser, at both widths.
 *
 * Reported: "the 'Evaluated vs. Omitted (Search Funnel)' is coming before
 * brand mention which is not right." It was: the funnel card lived in
 * .analyze-sidebar, and in the narrow popup the sidebar paints before the
 * brand card. Alongside it, all four reference cards (General Information,
 * Technical, Global Statistics, Summary) painted before Brand Mentions too,
 * so the popup opened on metadata rather than on the result.
 *
 * Order here is measured by real on-screen geometry — getBoundingClientRect()
 * after layout — not by DOM position: up to 0.46.0 the layout was driven by
 * flex `order` and a `display: contents` sidebar, so DOM order and paint
 * order differed and only the painted result proved anything. Since 0.47.0
 * (popup) and 0.48.0 (full tab) each view has its own layout; the order the
 * owner asked for still holds in both.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-layout-test";

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
  console.log("\nanalyze-layout: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported layout regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

async function seedFixtures(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(600);
  const files = readdirSync(FIXDIR).filter((f) => f.endsWith(".txt")).sort();
  for (const f of files) {
    const raw = readFileSync(path.join(FIXDIR, f), "utf8");
    const isGemini = f.startsWith("gemini");
    await page.evaluate(
      async ({ raw, isGemini }) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: "raw-conversation",
            payload: {
              raw, reqBody: "{}",
              pageUrl: isGemini ? "https://gemini.google.com/app" : "https://chatgpt.com/",
              capturedAt: Date.now(),
            },
          }, resolve);
        }),
      { raw, isGemini }
    );
    await page.waitForTimeout(80);
  }
  await page.close();
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
  await seedFixtures(context, extId);

  // Since 0.47.0 the popup has its own Analyze layout (renderAnalyzePopup;
  // analyze-popup.test.mjs covers it in depth). The reading order is the
  // owner's, from the design canvas: the searches the engine ran directly
  // under the prompt, then what led the answer, then the brands and pages.
  console.log("\nPOPUP (540px) — searches, then what led, then brands and pages");
  {
    const page = await context.newPage();
    await page.setViewportSize({ width: 540, height: 900 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(1200);
    const order = await page.evaluate(() => [...document.querySelectorAll("#analyze .ap > section")]
      .map((n) => ({ id: n.id, top: Math.round(n.getBoundingClientRect().top) }))
      .sort((a, b) => a.top - b.top).map((n) => n.id));
    await page.close();
    console.log("  painted order: " + order.join(" -> "));
    const at = (id) => order.indexOf(id);
    check("the popup uses its own Analyze layout", order.length > 0);
    check("searches come first", at("ap-searches") === 0, order.join(" -> "));
    check("brands come after the searches", at("ap-brands") > at("ap-searches"), order.join(" -> "));
    if (at("ap-sites") !== -1) check("the sites it used come after the brands", at("ap-sites") > at("ap-brands"), order.join(" -> "));
    // 0.58.0: "What backs each brand" is an inference from titles and
    // snippets; requested at the very bottom of the popup.
    if (at("ap-backing") !== -1) check("what backs each brand is the last section", at("ap-backing") === order.length - 1, order.join(" -> "));
    if (at("ap-products") !== -1) check("product cards lead the analysis, before brands", at("ap-products") < at("ap-brands"), order.join(" -> "));
  }

  // Since 0.48.0 the full tab has its own layout too (renderAnalyzeTab;
  // analyze-tab.test.mjs covers it in depth): the analysis in a left column,
  // the answer pinned on the right. Since 0.54.0 it follows the canvas: an
  // "at a glance" card (brands named, pages cited, searches) heads it, then
  // what led the answer, then what backs each brand, and Details last.
  console.log("\nFULL SCREEN (1280px) — at a glance first, then what backs each brand, Details last");
  {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
    await page.waitForTimeout(1200);
    const order = await page.evaluate(() => [...document.querySelectorAll("#analyze .at-main > section, #analyze .at-main > .at-pair > .at-sec")]
      .map((n) => ({ id: n.id, top: Math.round(n.getBoundingClientRect().top + window.scrollY) }))
      .sort((a, b) => a.top - b.top).map((n) => n.id));
    console.log("  painted order: " + order.join(" -> "));
    const at = (id) => order.indexOf(id);
    check("the at-a-glance card comes first", at("at-glance") === 0, order.join(" -> "));
    // 0.60.0, the approved canvas order (it replaces 0.58.0's, which put the
    // sites second and what backs each brand last): where it came from, then
    // every site it read, the searches, since last time, and Details last.
    if (at("at-backing") !== -1) check("where it came from comes before every site it read", at("at-backing") < at("at-sites"), order.join(" -> "));
    check("every site it read comes before the searches", at("at-sites") < at("at-built"), order.join(" -> "));
    check("Details is the last section", at("at-details") === order.length - 1, order.join(" -> "));
    const matrixFirst = await page.evaluate(() => {
      const m = document.getElementById("card-omitted-analysis");
      const b = document.getElementById("at-glance");
      return !!(m && b && m.getBoundingClientRect().top < b.getBoundingClientRect().top);
    });
    check("the funnel matrix never paints above the brands", !matrixFirst);

    // Reported: "Brand Mention section doesn't need snippet information for
    // each mentioned brand." The quote was the tallest element in each row
    // and the least reliable — a brand introduced inside a markdown table
    // arrived as a wall of rating cells, and two brands named in the same
    // sentence showed the identical block of text. The brands now show as
    // one line each in the glance, and as one row each in "what backs it".
    const bm = await page.evaluate(() => {
      const glance = document.getElementById("at-glance");
      const back = document.getElementById("at-backing");
      if (!glance || !back) return null;
      const rows = [...glance.querySelectorAll(".at-glance-brand")];
      const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
      return {
        rows: rows.length,
        backRows: back.querySelectorAll(".at-backing-row:not(.dropped)").length,
        quotes: document.querySelectorAll("#analyze .at-main .brand-quote, #analyze .at-main blockquote").length,
        ordinals: rows.filter((r) => /^\d+$/.test(r.querySelector(".at-rank")?.textContent || "")).length,
        counts: rows.filter((r) => /^×\d+$/.test(r.querySelector(".at-glance-n")?.textContent || "")).length,
        chips: [...back.querySelectorAll(".at-backer")].map((t) => t.textContent),
        minHeight: Math.min(...heights),
        maxHeight: Math.max(...heights),
      };
    });
    await page.close();
    check("the brand list renders", !!bm && bm.rows > 0, JSON.stringify(bm));
    if (bm) {
      check("no per-brand quote block", bm.quotes === 0, `${bm.quotes} quotes`);
      check("every brand still shows its position in the answer", bm.ordinals === bm.rows, `${bm.ordinals} of ${bm.rows}`);
      check("and how often it was named", bm.counts === bm.rows, `${bm.counts} of ${bm.rows}`);
      check("each named brand gets a row in what backs it", bm.backRows >= bm.rows, `${bm.backRows} vs ${bm.rows}`);
      check("brand lines are all one line high", bm.maxHeight - bm.minHeight < 4, `${bm.minHeight}-${bm.maxHeight}px`);
      // A chip that ran into the next table column read "… Reliability Approx".
      check("no chip label trails into the next column",
        !bm.chips.some((c) => /\b(approx|₹|\$)\b/i.test(c)), bm.chips.join(" | "));
    }
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
