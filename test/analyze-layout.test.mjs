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
 * after layout — not by DOM position, because the popup layout is driven by
 * flex `order` and a `display: contents` sidebar. DOM order and paint order
 * are deliberately different, so only the painted result proves anything.
 */
import { readFileSync, readdirSync } from "node:fs";
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

// Vertical position of each Analyze card that has a stable id, in painted
// order. Cards absent for this capture are simply omitted.
const PROBE = () => {
  const ids = [
    "card-general", "card-brand-mentions", "card-omitted-analysis", "card-fanout",
    "card-top-domains", "card-sources", "card-technical", "card-global-stats", "card-summary",
  ];
  const out = [];
  for (const id of ids) {
    const n = document.getElementById(id);
    if (!n) continue;
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push({ id, top: Math.round(r.top + window.scrollY), left: Math.round(r.left) });
  }
  out.sort((a, b) => a.top - b.top || a.left - b.left);
  return out;
};

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

async function orderAt(context, extId, width, height) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${extId}/ui/panel.html${width > 640 ? "?mode=tab" : ""}`);
  await page.waitForTimeout(1200);
  const order = await page.evaluate(PROBE);
  await page.close();
  return order;
}

const idx = (order, id) => order.findIndex((o) => o.id === id);

/** Shape of the Brand Mentions card as actually rendered. */
async function brandCardShape(context, extId, width, height) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${extId}/ui/panel.html${width > 640 ? "?mode=tab" : ""}`);
  await page.waitForTimeout(1200);
  const out = await page.evaluate(() => {
    const card = document.getElementById("card-brand-mentions");
    if (!card) return null;
    const rows = [...card.querySelectorAll(".brand-item")];
    const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
    return {
      rows: rows.length,
      quotes: card.querySelectorAll(".brand-quote").length,
      ordinals: card.querySelectorAll(".brand-ordinal").length,
      meters: card.querySelectorAll(".brand-meter").length,
      chips: [...card.querySelectorAll(".tag")].map((t) => t.textContent),
      minHeight: Math.min(...heights),
      maxHeight: Math.max(...heights),
      cardHeight: Math.round(card.getBoundingClientRect().height),
    };
  });
  await page.close();
  return out;
}

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
    if (at("ap-pages") !== -1) check("pages cited come after the brands", at("ap-pages") > at("ap-brands"), order.join(" -> "));
    if (at("ap-products") !== -1) check("product cards lead the analysis, before brands", at("ap-products") < at("ap-brands"), order.join(" -> "));
  }

  console.log("\nFULL SCREEN (1280px) — Brand Mentions heads the wide column");
  {
    const order = await orderAt(context, extId, 1280, 900);
    console.log("  painted order: " + order.map((o) => o.id).join(" -> "));
    const brand = idx(order, "card-brand-mentions");
    const funnel = idx(order, "card-omitted-analysis");
    check("Brand Mentions is present", brand !== -1);
    if (funnel !== -1) {
      check("Search Funnel still comes after Brand Mentions", funnel > brand, `funnel@${funnel} brand@${brand}`);
    }

    // Reported: "Brand Mention section doesn't need snippet information for
    // each mentioned brand." The quote was the tallest element in each card
    // and the least reliable — a brand introduced inside a markdown table
    // arrived as a wall of rating cells, and two brands named in the same
    // sentence showed the identical block of text. (Checked in the popup
    // until 0.47.0 gave the popup its own layout; the card lives on here.)
    const bm = await brandCardShape(context, extId, 1280, 900);
    check("no per-brand quote block", bm.quotes === 0, `${bm.quotes} quotes`);
    check("every brand still shows its position in the answer",
      bm.ordinals === bm.rows, `${bm.ordinals} of ${bm.rows}`);
    check("and its mention count as a comparable bar",
      bm.meters > 0 && bm.meters <= bm.rows, `${bm.meters} of ${bm.rows}`);
    check("rows are the same height, give or take one wrapped chip line",
      bm.maxHeight - bm.minHeight < 40, `${bm.minHeight}-${bm.maxHeight}px`);
    check("the card is no longer the tallest thing on the page",
      bm.cardHeight < 520, `${bm.cardHeight}px for ${bm.rows} brands`);
    // A chip that ran into the next table column read "… Reliability Approx".
    check("no chip label trails into the next table column",
      !bm.chips.some((c) => /\b(approx|₹|\$)\b/i.test(c)), bm.chips.join(" | "));
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
