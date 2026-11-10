/*
 * theme-style.test.mjs — the Studio and Classic themes (0.59.0).
 *
 * Asked for: "give the user the option to choose from the theme of 46 and
 * the current one under the setting". Studio is the design canvas's look and
 * the default; Classic is the 0.47–0.58 look, kept exactly. Both combine with
 * Light / Dark, so there are four looks. This checks:
 *   - a fresh install opens in Studio, and the theme is on <html> before the
 *     body exists (theme-boot.js in the head), so nobody sees a flash of the
 *     wrong theme while panel.js loads;
 *   - both themes use Geist (one typeface since 0.60.2), loaded from
 *     the extension and nothing from the web;
 *   - About → Settings → Theme switches at once, outside Save / Undo, and the
 *     other open view (popup or tab) follows;
 *   - text and the kind-of-answer header inks pass 4.5:1 contrast in all four
 *     looks.
 * Fails on 0.58.0: there is no data-style, no #setStyle and no Geist.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-theme-style-test";

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
  console.log("\ntheme-style: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the theme choice the owner asked for, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

// Records the theme attributes at the moment <body> is inserted: anything
// set later (by panel.js, a module that runs after the body) would have let
// the page paint once in the wrong theme.
const ATTRS_AT_BODY = () => {
  window.__atBody = null;
  new MutationObserver((list, obs) => {
    if (document.body) {
      window.__atBody = { style: document.documentElement.getAttribute("data-style"), theme: document.documentElement.getAttribute("data-theme") };
      obs.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
};

// Contrast of two CSS colours, as WCAG defines it. Runs in the page.
const CONTRASTS = () => {
  const toRgb = (c) => {
    const probe = document.createElement("span");
    probe.style.color = c;
    document.body.append(probe);
    const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    probe.remove();
    return m.slice(0, 3);
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const x = lum(toRgb(a)), y = lum(toRgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const v = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = {
    "text on page": ratio(v("--fg-primary"), v("--bg")),
    "secondary text on a card": ratio(v("--fg-secondary"), v("--surface-solid")),
    "muted text on a card": ratio(v("--fg-muted"), v("--surface-solid")),
    "links on a card": ratio(v("--accent"), v("--surface-solid")),
  };
  // The kind tints are rgba() in Classic dark, which a contrast ratio can't
  // judge without the layer under it; those are checked in the light looks.
  for (const k of ["shopping", "local", "images", "info", "memory", "lens", "dashboard", "campaign"]) {
    const bg = v(`--tint-${k}`);
    if (!/rgba/.test(bg)) out[`${k} header ink`] = ratio(v(`--tint-${k}-ink`), bg);
  }
  return out;
};

const requests = [];
context.on("request", (r) => requests.push(r.url()));

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const base = `chrome-extension://${extId}/ui/panel.html`;

  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(String(e.message || e)));
  await tab.addInitScript(ATTRS_AT_BODY);
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.goto(`${base}?mode=tab`);
  await tab.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await tab.reload();
  await tab.waitForTimeout(1200);

  console.log("\nA fresh install opens in Studio, set before the first paint");
  {
    const r = await tab.evaluate(async () => {
      await document.fonts.ready;
      return {
        atBody: window.__atBody,
        style: document.documentElement.getAttribute("data-style"),
        font: getComputedStyle(document.body).fontFamily,
        geist: document.fonts.check('500 13px "Geist"'),
        size: getComputedStyle(document.body).fontSize,
        bg: getComputedStyle(document.body).backgroundColor,
        image: getComputedStyle(document.body).backgroundImage,
      };
    });
    check("data-style is studio", r.style === "studio", r.style);
    check("already on <html> when <body> is inserted", r.atBody && r.atBody.style === "studio" && r.atBody.theme === "light", JSON.stringify(r.atBody));
    check("Studio's typeface is Geist, loaded", /^"?Geist"?,/.test(r.font) && r.geist, `${r.font} · loaded ${r.geist}`);
    check("on Studio's flat warm page, no colour blobs", r.bg === "rgb(244, 243, 238)" && r.image === "none", `${r.bg} · ${r.image.slice(0, 60)}`);
  }

  console.log("\nAbout → Settings → Theme");
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 540, height: 600 });
  await popup.goto(base);
  await popup.waitForTimeout(800);
  {
    await tab.evaluate(() => document.querySelector('[data-tab="about"]').click());
    await tab.waitForTimeout(400);
    await tab.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
    await tab.waitForTimeout(400);
    // Display is a closed group since 0.78.0.
    await tab.evaluate(() => { const d = document.getElementById("setGroupDisplay"); if (d) d.open = true; });
    const picks = await tab.evaluate(() => [...document.querySelectorAll("#setStyle [role=radio]")].map((b) => `${b.querySelector(".ab-style-name").textContent}:${b.getAttribute("aria-checked")}`));
    check("two themes to pick from, Studio picked", picks.join("|") === "Studio:true|Classic:false", picks.join("|"));
    await tab.click('#setStyle [data-style-pick="classic"]');
    await tab.waitForTimeout(300);
    const r = await tab.evaluate(async () => {
      await document.fonts.ready;
      return {
        style: document.documentElement.getAttribute("data-style"),
        stored: localStorage.getItem("cito-style"),
        font: getComputedStyle(document.body).fontFamily,
        size: getComputedStyle(document.body).fontSize,
        image: getComputedStyle(document.body).backgroundImage,
        unsaved: document.getElementById("setStatus").textContent,
      };
    });
    check("Classic applies at once and is kept", r.style === "classic" && r.stored === "classic", JSON.stringify(r));
    // One typeface and one size in both themes since 0.60.2 (asked for);
    // the themes differ in colour and shape.
    check("with the same typeface and size as Studio", /^"?Geist"?,/.test(r.font) && r.size === "13px", `${r.font} · ${r.size}`);
    check("and its glass page back", /radial-gradient/.test(r.image), r.image.slice(0, 60));
    check("without touching Save", !/Unsaved/.test(r.unsaved), r.unsaved);
    await popup.waitForTimeout(400);
    check("the open popup follows", await popup.evaluate(() => document.documentElement.getAttribute("data-style")) === "classic");
    await popup.reload();
    await popup.waitForTimeout(600);
    check("and opens in Classic next time", await popup.evaluate(() => document.documentElement.getAttribute("data-style")) === "classic");
  }

  console.log("\nText passes 4.5:1 in all four looks");
  for (const [style, theme] of [["studio", "light"], ["studio", "dark"], ["classic", "light"], ["classic", "dark"]]) {
    await tab.evaluate(([s, t]) => { localStorage.setItem("cito-style", s); localStorage.setItem("cito-theme", t); }, [style, theme]);
    await tab.reload();
    await tab.waitForTimeout(500);
    const at = await tab.evaluate(() => window.__atBody);
    check(`${style} ${theme} is set before the first paint`, at && at.style === style && at.theme === theme, JSON.stringify(at));
    const c = await tab.evaluate(CONTRASTS);
    const low = Object.entries(c).filter(([, x]) => x < 4.5).map(([k, x]) => `${k} ${x.toFixed(2)}`);
    check(`${style} ${theme}: every pair at least 4.5:1`, low.length === 0, low.join(", ") || `${Object.keys(c).length} pairs`);
  }

  console.log("\nNothing fetched from the web for any of it");
  {
    const fontReqs = requests.filter((u) => /\.woff2?(\?|$)/.test(u));
    check("Geist came from the extension's fonts folder", fontReqs.some((u) => /Geist-var/.test(u)) && fontReqs.every((u) => u.startsWith(`chrome-extension://${extId}/fonts/`)), fontReqs.join(" | "));
    const outside = requests.filter((u) => !u.startsWith("chrome-extension://") && !u.startsWith("data:") && !u.startsWith("blob:"));
    check("no request left the browser", outside.length === 0, outside.slice(0, 5).join(" | "));
  }
  check("no page error anywhere above", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
  rmSync(PROFILE_BASE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
