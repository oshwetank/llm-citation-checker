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

const TABS = ["analyze", "dashboard", "loader", "compare", "about"];

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
  } finally {
    await context.close();
  }
}

await runMode("no-preference");
await runMode("reduce");

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
