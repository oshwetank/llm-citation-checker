/*
 * ui-visibility.test.mjs — the regression guard for "the whole UI is blank."
 *
 * WHY THIS EXISTS
 * ---------------
 * v0.26.0 shipped with the entire panel invisible for any user who has the
 * OS "reduce motion" accessibility setting enabled (Windows: Accessibility ->
 * Visual effects -> Animation effects off; macOS: Reduce motion). The cause:
 *
 *     .panel            { opacity: 0; }
 *     .panel.active     { animation: panelFadeIn ... forwards; }   <- only
 *                         thing that brought opacity to 1
 *     @media (prefers-reduced-motion: reduce) {
 *       .panel.active   { animation: none; }                       <- killed it
 *     }
 *
 * Content rendered, filled the DOM, had a normal bounding box — and was
 * completely transparent.
 *
 * Every check that ran before release measured `innerText.length`, which is
 * NON-ZERO for fully transparent content, so all of them passed while the
 * app was unusable. That is the real lesson this file encodes: a UI check
 * that does not assert *visibility* cannot catch a blank screen.
 *
 * WHAT THIS ASSERTS, for every tab, in BOTH motion modes:
 *   - effective opacity (the product of the element's own opacity and every
 *     ancestor's, since a transparent parent hides a fully opaque child)
 *   - computed visibility / display
 *   - a non-zero rendered bounding box
 *   - actual content inside the panel
 *   - no uncaught page errors while doing any of it
 *
 * It deliberately checks the reduced-motion axis explicitly rather than
 * trusting the default, because the default is exactly what hid this bug.
 *
 * Playwright is resolved from the global install; if it isn't present this
 * exits non-zero rather than silently "passing" — a guard that can quietly
 * skip itself is not a guard.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-ui-test";

// Compare left the top menu in 0.47.0 (it opens from an answer instead);
// compare-tab.test.mjs renders it that way.
const TABS = ["analyze", "dashboard", "loader", "about"];

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
};

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  const candidates = [
    "playwright",
    "/opt/node22/lib/node_modules/playwright/index.js",
  ];
  let pw = null;
  for (const c of candidates) {
    try { pw = req(c); break; } catch (_) { /* try next */ }
  }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log("\nui-visibility: CANNOT RUN — playwright is not installed.");
  console.log("This test guards against shipping a blank UI, so it fails rather than skips.");
  console.log(`Install it (npm i -g playwright) or set it up locally. Reason: ${err.message}`);
  process.exit(1);
}

// Reads real visibility, walking up the ancestor chain for opacity. A parent
// at opacity 0 makes an opaque child invisible, so the element's own computed
// opacity alone is not enough to conclude anything is on screen.
const PROBE = (tabId) => {
  const panel = document.getElementById(tabId);
  if (!panel) return { missing: true };
  const cs = getComputedStyle(panel);
  const rect = panel.getBoundingClientRect();
  let effOpacity = 1;
  let hiddenAncestor = null;
  for (let n = panel; n && n.nodeType === 1; n = n.parentElement) {
    const s = getComputedStyle(n);
    effOpacity *= parseFloat(s.opacity);
    if ((s.visibility === "hidden" || s.display === "none") && n !== panel) {
      hiddenAncestor = n.tagName + "." + String(n.className || "");
      break;
    }
  }
  return {
    missing: false,
    display: cs.display,
    visibility: cs.visibility,
    ownOpacity: cs.opacity,
    effOpacity,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    contentLen: panel.innerText.trim().length,
    childCount: panel.children.length,
    hiddenAncestor,
  };
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
          chrome.runtime.sendMessage(
            {
              type: "raw-conversation",
              payload: {
                raw,
                reqBody: "{}",
                pageUrl: isGemini ? "https://gemini.google.com/app" : "https://chatgpt.com/",
                capturedAt: Date.now(),
              },
            },
            resolve
          );
        }),
      { raw, isGemini }
    );
    await page.waitForTimeout(80);
  }
  await page.close();
  return files.length;
}

async function runMode(reducedMotion) {
  console.log(`\nUI visibility with prefers-reduced-motion: ${reducedMotion === "reduce" ? "REDUCE (the setting that shipped a blank UI)" : "no-preference"}`);

  const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${reducedMotion}`, {
    headless: false,
    reducedMotion,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--headless=new",
      "--no-sandbox",
    ],
  });

  // The first-run tour (panel.js's maybeFirstRun/runTour) starts on any page
  // that hasn't seen it, and its #tour-backdrop overlay intercepts pointer
  // events across the whole panel — including clicks this file makes to
  // switch tabs. A blocked click's own .catch(() => {}) swallows the
  // failure silently, and most of this file's assertions read declared
  // computed-style values (opacity, display, flex-direction) that stay
  // correct even on a panel that's never actually the ACTIVE one, so a
  // silently-blocked tab switch mostly hides itself — until a check reads
  // real rendered geometry (getBoundingClientRect) on a panel that was
  // never switched to, which is genuinely 0. Setting the "seen" flag before
  // the extension's own scripts ever run, for every page this context
  // opens, removes the backdrop as a variable entirely.
  await context.addInitScript(() => {
    try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) {}
  });

  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = sw.url().split("/")[2];

    await seedFixtures(context, extId);

    const pageErrors = [];
    const popup = await context.newPage();
    popup.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    // Google Fonts is fetched from the network; in an offline CI box that
    // fails harmlessly and must not be mistaken for an app error.
    popup.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/ERR_(CONNECTION|NAME|INTERNET|NETWORK)|fonts\.(googleapis|gstatic)/i.test(t)) return;
      pageErrors.push("console: " + t);
    });

    await popup.setViewportSize({ width: 400, height: 600 });
    await popup.goto(`chrome-extension://${extId}/ui/panel.html`);
    await popup.waitForTimeout(2500);

    const sanity = await popup.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    check(
      `the browser really is in ${reducedMotion} mode (guard against testing the wrong thing)`,
      sanity === (reducedMotion === "reduce"),
      `matchMedia says ${sanity}`
    );

    for (const tab of TABS) {
      await popup.evaluate((t) => {
        const b = document.querySelector(`[data-tab="${t}"]`);
        if (b) b.click();
      }, tab);
      await popup.waitForTimeout(700);

      const r = await popup.evaluate(PROBE, tab);
      if (r.missing) {
        check(`#${tab} exists in the DOM`, false, "element not found");
        continue;
      }

      // The assertion that actually catches a blank screen.
      check(
        `#${tab} is VISIBLE (effective opacity ${r.effOpacity})`,
        r.effOpacity > 0.01,
        `effOpacity=${r.effOpacity} ownOpacity=${r.ownOpacity} — content is in the DOM but transparent`
      );
      check(`#${tab} is displayed (display=${r.display})`, r.display !== "none", r.display);
      check(`#${tab} is not visibility:hidden`, r.visibility !== "hidden", r.visibility);
      check(
        `#${tab} has a real rendered box (${r.width}x${r.height})`,
        r.width > 0 && r.height > 0,
        `${r.width}x${r.height}`
      );
      check(`#${tab} has no hidden ancestor clipping it`, !r.hiddenAncestor, r.hiddenAncestor);
      check(
        `#${tab} actually has content (${r.contentLen} chars, ${r.childCount} children)`,
        r.contentLen > 0 && r.childCount > 0,
        `len=${r.contentLen} children=${r.childCount}`
      );
    }

    check(
      "no uncaught page errors while walking every tab",
      pageErrors.length === 0,
      pageErrors.join(" | ")
    );

    if (reducedMotion === "no-preference") {
      // Reported on 0.40-era About: the header's identity block and its
      // diagnostic-report action read as two unrelated pieces of UI
      // ("bifurcation") — mismatched heights, no shared edge. Since 0.51.0
      // About is five pages (see about.test.mjs) and the diagnostic report
      // lives on the Diagnostics page, so that header no longer exists. What
      // this still guards is the complaint underneath it: the blocks on screen
      // line up as one layout. In this 400px popup that is the home screen's
      // cards sharing one left edge with nothing pushed sideways; in the full
      // tab, the side menu and the page sharing one top edge.
      console.log("\nAbout's blocks line up as one layout");
      await popup.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
      await popup.waitForTimeout(600);
      const geo = await popup.evaluate(() => {
        const cards = [...document.querySelectorAll("#abHome > .card")].map((c) => c.getBoundingClientRect());
        const content = document.querySelector(".app-content");
        if (!cards.length) return null;
        return {
          cards: cards.length,
          leftSpread: Math.max(...cards.map((r) => r.left)) - Math.min(...cards.map((r) => r.left)),
          widthSpread: Math.max(...cards.map((r) => r.width)) - Math.min(...cards.map((r) => r.width)),
          overflow: content.scrollWidth - content.clientWidth,
        };
      });
      check("the popup's About opens on its home screen", !!geo && geo.cards >= 3, geo && JSON.stringify(geo));
      check("its cards share one left edge and one width", !!geo && geo.leftSpread < 2 && geo.widthSpread < 2, geo && JSON.stringify(geo));
      check("and nothing pushes the popup sideways", !!geo && geo.overflow <= 0, geo && `${geo.overflow}px`);

      const wide = await context.newPage();
      await wide.setViewportSize({ width: 1200, height: 700 });
      await wide.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
      await wide.waitForTimeout(900);
      // Driven through the page, not Playwright's own click: on a fresh
      // profile the first-run tour's #tour-backdrop covers the header, so an
      // actionability-checked click silently times out and every measurement
      // then runs against a still-hidden #about panel (all-zero rects).
      await wide.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
      await wide.waitForTimeout(500);
      const wgeo = await wide.evaluate(() => {
        const side = document.querySelector(".ab-side");
        const main = document.querySelector(".ab-main");
        if (!side || !main) return null;
        const a = side.getBoundingClientRect(), m = main.getBoundingClientRect();
        return { topDelta: Math.abs(a.top - m.top), beside: a.right <= m.left, sideWidth: a.width };
      });
      await wide.close();
      check("at full-tab width the side menu sits beside the page", !!wgeo && wgeo.beside, wgeo && JSON.stringify(wgeo));
      check("both share the same top edge", !!wgeo && wgeo.topDelta < 2, wgeo && `${wgeo.topDelta}px apart`);
      check("the side menu has a bounded width, not a stray full-width column",
        !!wgeo && wgeo.sideWidth > 100 && wgeo.sideWidth < 400, wgeo && `${wgeo.sideWidth}px`);
    }
  } finally {
    await context.close();
  }
}

await runMode("no-preference");
await runMode("reduce");

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
