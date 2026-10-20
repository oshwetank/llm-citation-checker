/*
 * app-header.test.mjs — the app's bar, in the full tab and in the popup (0.55.0).
 *
 * Reported: "the new layout has not completily and properly been implemented
 * at all." On the canvas the bar is one row in both places: the logo, the
 * four pages as a segmented pill of words, then whatever the page adds (a
 * campaign's section links, the Dashboard's note) and, in the popup, a
 * pop-out icon. Until 0.54.0 the popup's bar was two rows (the name with
 * "Theme" and "Full tab" pills, then the tabs with icons), and the full tab
 * put the pages at the far right, away from the logo.
 *
 * On 0.54.0 this fails: the popup's bar is two rows and ~90px tall, the tabs
 * carry icons, and in the full tab the pill sits at the far end of the bar.
 * Since 0.56.0 the theme button is gone from the bar too (the canvas has
 * none); Light / Dark is in About → Settings, and applies everywhere. On
 * 0.55.0 those checks fail: the button is there and Settings has no choice.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-app-header-test";

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
  console.log("\napp-header: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported layout, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));

  const measure = () => page.evaluate(() => {
    const box = (q) => { const n = document.querySelector(q); if (!n) return null; const r = n.getBoundingClientRect(); return r.width ? { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } : null; };
    // Shown pages only: the popup hides Ask (0.73.0), which needs the full tab.
    const tabs = [...document.querySelectorAll(".nav-tabs .nav-tab")].filter((t) => t.getBoundingClientRect().width > 0);
    return {
      header: box(".app-header"),
      logo: box(".brand-icon"),
      title: box(".brand-title"),
      nav: box(".nav-tabs"),
      openTab: box("#openTab"),
      page: box("#headerPage"),
      tabWidths: tabs.map((t) => Math.round(t.getBoundingClientRect().width)),
      tabIcons: tabs.filter((t) => { const s = t.querySelector("svg"); return s && getComputedStyle(s).display !== "none"; }).length,
      labels: tabs.map((t) => t.textContent.trim()),
      openLabel: document.querySelector("#openTab .popout-label") ? getComputedStyle(document.querySelector("#openTab .popout-label")).display : "",
      openAria: document.getElementById("openTab")?.getAttribute("aria-label") || "",
      pageText: document.getElementById("headerPage")?.textContent || "",
    };
  });
  const centre = (b) => b.t + b.h / 2;

  console.log("\nThe popup: one row — the logo, the four pages, the pop-out icon");
  {
    await page.setViewportSize({ width: 540, height: 600 });
    await page.reload();
    await page.waitForTimeout(1200);
    const m = await measure();
    check("the bar is one short row", m.header && m.header.h <= 52, m.header && `${m.header.h}px tall`);
    check("the logo, the pages and the pop-out sit on the same line",
      m.logo && m.nav && m.openTab && Math.abs(centre(m.logo) - centre(m.nav)) < 6 && Math.abs(centre(m.openTab) - centre(m.nav)) < 6,
      JSON.stringify({ logo: m.logo, nav: m.nav, openTab: m.openTab }));
    check("in that order", m.logo && m.nav && m.openTab && m.logo.r <= m.nav.l && m.nav.r <= m.openTab.l);
    check("the pages are words, no icons", m.tabIcons === 0 && m.labels.join("|") === "Analyze|Dashboard|Campaigns|About", `${m.tabIcons} icons; ${m.labels.join("|")}`);
    check("each page gets an equal share of the pill", Math.max(...m.tabWidths) - Math.min(...m.tabWidths) <= 1, m.tabWidths.join(", "));
    check("the name is left to the full tab", !m.title);
    check("pop-out is an icon that still says what it does", m.openLabel === "none" && /full tab/i.test(m.openAria), `${m.openLabel} · ${m.openAria}`);
    // 0.56.0: the canvas's bar has no theme button; Appearance is in Settings.
    check("nothing else in the bar: no theme button", await page.evaluate(() => !document.getElementById("themeToggle") && document.querySelectorAll(".header-actions button").length === 1));
  }

  console.log("\nThe full tab: the logo and name, the pages beside them, the page's own items at the right");
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
    await page.waitForTimeout(1200);
    const m = await measure();
    check("one row", m.header && m.header.h <= 56, m.header && `${m.header.h}px tall`);
    // Centred since 0.60.2 (reported: the pages sat off to one side).
    check("the pages sit in the middle of the bar", m.header && m.nav && Math.abs((m.nav.l + m.nav.r) / 2 - (m.header.l + m.header.r) / 2) < 24, JSON.stringify({ header: m.header, nav: m.nav }));
    check("words, no icons", m.tabIcons === 0, `${m.tabIcons} icons`);
    // Analyze adds its search and pager (analyze-tab covers them) when an
    // answer is on screen; the sample capture can arrive on a fresh install
    // before this runs, so check against what Analyze is showing.
    const az = await page.evaluate(() => ({ answer: !!document.getElementById("at-answer"), sw: !!document.querySelector("#headerPage .at-detail-switch"), find: !!document.querySelector("#headerPage input[type=search]"), items: document.getElementById("headerPage").childElementCount }));
    check("Analyze adds its Expert switch (and no search) to the bar only when it shows an answer", (az.answer ? az.sw : az.items === 0) && !az.find, JSON.stringify(az));

    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(800);
    const d = await measure();
    check("the Dashboard adds no \"stored on this computer\" note (0.78.0)", !/stored on this computer/.test(d.pageText), d.pageText);
    await page.evaluate(() => document.querySelector('[data-tab="about"]').click());
    await page.waitForTimeout(800);
    check("and it goes again on the next page", !(await measure()).page);
  }

  console.log("\nLight or dark, from About → Settings");
  {
    await page.evaluate(() => document.querySelector('[data-tab="about"]').click());
    await page.waitForTimeout(500);
    await page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
    await page.waitForTimeout(500);
    const seg = await page.evaluate(() => [...document.querySelectorAll("#setTheme [role=radio]")].map((b) => `${b.textContent}:${b.getAttribute("aria-checked")}`));
    check("Settings has Appearance: Light or Dark, Light picked", seg.join("|") === "Light:true|Dark:false", seg.join("|"));
    await page.click('#setTheme [data-theme-pick="dark"]');
    const dark = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("cito-theme"), bg: getComputedStyle(document.body).backgroundColor }));
    check("Dark applies at once and is kept", dark.attr === "dark" && dark.stored === "dark", JSON.stringify(dark));
    check("without touching Save", await page.evaluate(() => !document.getElementById("setStatus").textContent.includes("Unsaved")));
    await page.setViewportSize({ width: 540, height: 600 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(800);
    check("the popup opens dark too", await page.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"));
    await page.evaluate(() => localStorage.setItem("cito-theme", "light"));
  }

  check("no page error anywhere above", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
