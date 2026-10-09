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
    "card-cited-domains", "card-sources", "card-technical", "card-global-stats", "card-summary",
    "card-products", "card-images", "card-entities", "card-grounding-integrity",
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

/*
 * The redesign asked for: cited domains straight after Brand Mentions, every
 * source listed (it used to stop at ten), the snippet-based citation matrix
 * as the very last card, and no image frame left empty. Image hosts are
 * blocked for this run (see the route below), so every frame must fall back
 * to naming what it was.
 */
function checkRedesign(fullOrder, shape, where) {
  // Full screen has two columns, and the sidebar's cards interleave with the
  // wide column's by height. Reading order is per column, so compare within
  // the column Brand Mentions heads; the popup is one column already.
  const brandLeft = fullOrder.find((o) => o.id === "card-brand-mentions")?.left;
  const order = fullOrder.filter((o) => o.left === brandLeft);
  const brand = idx(order, "card-brand-mentions");
  const domains = idx(order, "card-cited-domains");
  const matrix = idx(order, "card-omitted-analysis");
  check(`${where}: Cited Domains is present`, domains !== -1);
  check(`${where}: Cited Domains comes right after Brand Mentions`,
    domains === brand + 1, order.map((o) => o.id).join(" -> "));
  if (matrix !== -1) {
    check(`${where}: the citation matrix is the last card on the page`,
      matrix === order.length - 1, order.map((o) => o.id).join(" -> "));
  }
  check(`${where}: Top Domains table is gone (replaced by Cited Domains)`, !shape.topDomains);
  check(`${where}: cited domains are ranked first`, shape.citedFirst, shape.domainOrder.join(", "));
  check(`${where}: every source is listed, no "show all" cut-off`,
    shape.sourceRows === shape.sourceCount && !shape.showAll,
    `${shape.sourceRows} of ${shape.sourceCount} listed`);
  check(`${where}: a domain row opens to its URLs`, shape.expandedUrls > 0, `${shape.expandedUrls} URLs`);
  if (shape.frames.length) {
    check(`${where}: no image frame is left empty`,
      shape.frames.every((f) => f.loaded || f.label), JSON.stringify(shape.frames.slice(0, 3)));
  }
}

async function redesignShape(context, extId, width, height) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(`chrome-extension://${extId}/ui/panel.html${width > 640 ? "?mode=tab" : ""}`);
  await page.waitForTimeout(1200);
  // Lazy images below the fold would never start loading in a headless run.
  await page.evaluate(() => document.querySelectorAll("#analyze img").forEach((i) => { i.loading = "eager"; }));
  await page.waitForTimeout(1500);
  const out = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#card-cited-domains .domain-rank")];
    const firstHead = document.querySelector("#card-cited-domains .domain-rank-head");
    firstHead && firstHead.click();
    const h3 = document.querySelector("#card-sources h3");
    return {
      topDomains: !!document.getElementById("card-top-domains"),
      domainOrder: rows.map((r) => (r.classList.contains("is-cited") ? "cited:" : "") +
        r.querySelector(".domain-rank-name").textContent),
      citedFirst: rows.findIndex((r) => !r.classList.contains("is-cited")) === -1 ||
        !rows.slice(rows.findIndex((r) => !r.classList.contains("is-cited"))).some((r) => r.classList.contains("is-cited")),
      expandedUrls: document.querySelectorAll("#card-cited-domains .domain-rank.open .domain-rank-urls a").length,
      sourceCount: h3 ? Number((h3.textContent.match(/\((\d+)\)/) || [])[1]) : 0,
      sourceRows: document.querySelectorAll("#card-sources .src-item").length,
      showAll: !!document.querySelector("#card-sources .src-more"),
      frames: [...document.querySelectorAll("#analyze .cap-img-wrap")].map((w) => ({
        loaded: w.classList.contains("cap-img-loaded"),
        label: getComputedStyle(w.querySelector(".cap-img-missing-label")).visibility === "visible" &&
          w.querySelector(".cap-img-missing-label").textContent.trim().length > 0,
      })),
    };
  });
  await page.close();
  return out;
}

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
  // Image hosts are unreachable here anyway; failing them outright makes the
  // empty-frame check deterministic instead of depending on a timeout.
  await context.route(/images\.openai\.com|gstatic\.com/, (r) => r.abort());
  await seedFixtures(context, extId);

  console.log("\nPOPUP (540px) — result first, reference last");
  {
    const order = await orderAt(context, extId, 540, 900);
    console.log("  painted order: " + order.map((o) => o.id).join(" -> "));
    const brand = idx(order, "card-brand-mentions");
    const funnel = idx(order, "card-omitted-analysis");
    const general = idx(order, "card-general");
    const tech = idx(order, "card-technical");

    check("Brand Mentions is present", brand !== -1);
    if (funnel !== -1) {
      // The reported bug, stated as an assertion.
      check("Search Funnel comes AFTER Brand Mentions", funnel > brand, `funnel@${funnel} brand@${brand}`);
    }

    // Reported: "Brand Mention section doesn't need snippet information for
    // each mentioned brand." The quote was the tallest element in each card
    // and the least reliable — a brand introduced inside a markdown table
    // arrived as a wall of rating cells, and two brands named in the same
    // sentence showed the identical block of text.
    const bm = await brandCardShape(context, extId, 540, 900);
    check("no per-brand quote block", bm.quotes === 0, `${bm.quotes} quotes`);
    check("every brand still shows its position in the answer",
      bm.ordinals === bm.rows, `${bm.ordinals} of ${bm.rows}`);
    check("and its mention count as a comparable bar",
      bm.meters > 0 && bm.meters <= bm.rows, `${bm.meters} of ${bm.rows}`);
    // Uniform rows are what makes the list read as a ranking.
    check("rows are the same height, give or take one wrapped chip line",
      bm.maxHeight - bm.minHeight < 40, `${bm.minHeight}-${bm.maxHeight}px`);
    check("the card is no longer the tallest thing on the page",
      bm.cardHeight < 520, `${bm.cardHeight}px for ${bm.rows} brands`);
    // A chip that ran into the next table column read "… Reliability Approx".
    check("no chip label trails into the next table column",
      !bm.chips.some((c) => /\b(approx|₹|\$)\b/i.test(c)), bm.chips.join(" | "));
    if (general !== -1) {
      check("General Information comes before Brand Mentions", general < brand, `general@${general} brand@${brand}`);
    }
    if (tech !== -1) {
      check("Technical Information is pushed below Brand Mentions", tech > brand, `tech@${tech} brand@${brand}`);
    }
    checkRedesign(order, await redesignShape(context, extId, 540, 900), "popup");
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
    checkRedesign(order, await redesignShape(context, extId, 1280, 900), "full screen");
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
