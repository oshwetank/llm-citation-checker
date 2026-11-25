/*
 * layout-106.test.mjs — the 1.0.6 layout (asked 24 Nov 2026):
 *   - the app's bar stays across the top ("Something terrible … Please
 *     change that to what it was"); a campaign's sections (Overview,
 *     Brands, Sources…) run down the side of its results, left or right as
 *     picked in Settings, and stay where they were put;
 *   - About is four pages;
 *   - Settings shows three things, the rest folded under "More settings",
 *     saves by itself, and has no AI Mode or debugger switch (the debugger
 *     is on from install);
 *   - a first look shows once, and "Got it" closes it for good.
 * Run: node test/layout-106.test.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-layout106-test";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) { console.log(`\nlayout-106: CANNOT RUN — playwright is not installed. ${err.message}`); process.exit(1); }

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  const url = `chrome-extension://${extId}/ui/panel.html?mode=tab`;
  await page.goto(url);
  await page.waitForTimeout(1200);
  const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; }, sel);

  console.log("\nThe app's bar across the top");
  {
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".nav-tab")].map((b) => Math.round(b.getBoundingClientRect().top)));
    const head = await box(".app-header"), main = await box(".app-content");
    check("the five pages sit side by side", tabs.length === 5 && new Set(tabs).size === 1, JSON.stringify(tabs));
    check("the bar is above the page", head && main && head.top + head.height <= main.top + 1, JSON.stringify({ head, main }));
  }
  // A campaign's results, as the board lays them out (the sections list and the panel).
  const sections = () => page.evaluate(() => {
    let lay = document.querySelector("#cvTest");
    if (!lay) {
      lay = document.createElement("div"); lay.id = "cvTest"; lay.className = "cv-layout";
      const t = document.createElement("div"); t.className = "cv-tabs";
      for (const n of ["Overview", "Brands", "Sources"]) { const b = document.createElement("button"); b.className = "cv-tab"; b.textContent = n; t.append(b); }
      const p = document.createElement("div"); p.className = "cv-panel"; p.style.height = "400px";
      lay.append(t, p); document.querySelector(".app-content").prepend(lay);
    }
    const t = lay.querySelector(".cv-tabs").getBoundingClientRect(), p = lay.querySelector(".cv-panel").getBoundingClientRect();
    const tops = [...lay.querySelectorAll(".cv-tab")].map((b) => Math.round(b.getBoundingClientRect().top));
    return { tabsLeft: t.left, tabsRight: t.right, panelLeft: p.left, panelRight: p.right, tops };
  });
  {
    const x = await sections();
    check("a campaign's sections are listed one under another", x.tops.every((t, i) => i === 0 || t > x.tops[i - 1]), JSON.stringify(x.tops));
    check("to the left of its results", x.tabsRight <= x.panelLeft + 1, JSON.stringify(x));
  }

  console.log("\nAbout: four pages");
  await page.click('.nav-tab[data-tab="about"]');
  await page.waitForTimeout(800);
  {
    const labels = await page.evaluate(() => [...document.querySelectorAll("#abNav .ab-nav-btn .ab-nav-label")].map((x) => x.textContent.trim()));
    check("Get started, Settings, Glossary, Help", JSON.stringify(labels) === JSON.stringify(["Get started", "Settings", "Glossary", "Help"]), JSON.stringify(labels));
    check("Get started has its steps", await page.evaluate(() => document.querySelectorAll("#abOverview .ab-step").length >= 4));
  }

  console.log("\nSettings: three things, the rest folded");
  await page.evaluate(() => [...document.querySelectorAll("#abNav .ab-nav-btn")].find((b) => b.textContent.includes("Settings"))?.click());
  await page.waitForTimeout(800);
  {
    const st = await page.evaluate(() => ({
      theme: !!document.querySelector("#setTheme"), nav: !!document.querySelector("#setNav"), lang: !!document.querySelector("#setLang"),
      moreOpen: document.querySelector("#setGroupMore")?.open, aimode: !!document.querySelector("#setAiMode"),
      debugRowShown: (() => { const d = document.querySelector("#setDebug"); return !!d && d.offsetParent !== null; })(),
      saveShown: (() => { const b = document.querySelector("#setSave"); return !!b && !b.hidden; })(),
    }));
    check("Appearance, Campaign sections and Language are at the top", st.theme && st.nav && st.lang, JSON.stringify(st));
    check("everything else starts folded", st.moreOpen === false, JSON.stringify(st));
    check("no AI Mode switch (it's always on)", !st.aimode);
    check("no debugger switch and no Save button", !st.debugRowShown && !st.saveShown, JSON.stringify(st));
    const s = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "settings-get" }, (x) => r(x))));
    check("the capture debugger is on from install", s && s.ok && s.settings.debugCapture === true, JSON.stringify(s && s.settings && s.settings.debugCapture));
  }
  {
    // A change saves itself.
    await page.evaluate(() => { document.querySelector("#setGroupMore").open = true; });
    const before = await page.evaluate(() => Number(document.querySelector("#setRetention").value));
    await page.click('.ab-stepbtn[data-step="setRetention"][data-dir="1"]');
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "settings-get" }, (x) => r(x))));
    check("a change is saved without pressing Save", s && s.ok && s.settings.retentionMax === before + 50, `${before} → ${s && s.settings && s.settings.retentionMax}`);
  }

  console.log("\nLeft or right");
  await page.click('#setNav [data-nav-pick="right"]');
  await page.waitForTimeout(400);
  {
    const x = await sections();
    check("Right lists the sections on the right of the results", x.tabsLeft >= x.panelRight - 1, JSON.stringify(x));
  }
  await page.reload();
  await page.waitForTimeout(1200);
  {
    const x = await sections();
    check("and they stay there after the page is opened again", x.tabsLeft >= x.panelRight - 1, JSON.stringify(x));
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".nav-tab")].map((b) => Math.round(b.getBoundingClientRect().top)));
    check("the app's bar is still across the top", new Set(tabs).size === 1, JSON.stringify(tabs));
  }
  await page.evaluate(() => document.querySelector('#setNav [data-nav-pick="left"]')?.click() || localStorage.setItem("cito-nav-side", "left"));

  console.log("\nThe first look");
  await page.evaluate(() => { localStorage.setItem("cito-test-first-look", "1"); localStorage.removeItem("cito-start-106"); });
  await page.reload();
  await page.waitForTimeout(1800);
  check("it shows on a first visit", await page.evaluate(() => !!document.querySelector(".fs-box")));
  check("with the steps and a way to set up a campaign", await page.evaluate(() => document.querySelectorAll(".fs-step").length === 4 && [...document.querySelectorAll(".fs-box button")].some((b) => /campaign/i.test(b.textContent))));
  await page.evaluate(() => [...document.querySelectorAll(".fs-box button")].find((b) => b.textContent.trim() === "Got it")?.click());
  await page.waitForTimeout(300);
  check("Got it closes it", await page.evaluate(() => !document.querySelector(".fs-back")));
  await page.reload();
  await page.waitForTimeout(1800);
  check("and it doesn't come back", await page.evaluate(() => !document.querySelector(".fs-back")));

  console.log("\nThe popup keeps its bar across the top");
  {
    const pop = await context.newPage();
    await pop.setViewportSize({ width: 520, height: 600 });
    await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
    await pop.waitForTimeout(1000);
    const tops = await pop.evaluate(() => [...document.querySelectorAll(".nav-tab")].map((b) => Math.round(b.getBoundingClientRect().top)));
    check("the pages sit side by side", tops.length === 5 && new Set(tops).size === 1, JSON.stringify(tops));
    await pop.close();
  }
  check("no page errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
