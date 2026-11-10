/*
 * display-settings.test.mjs — Settings → Display (0.63.0) on screen.
 *
 * Asked for: a font picker with bundled and Google fonts, and sliders for
 * size, brightness, contrast, line spacing and density. This checks they
 * apply before the first paint, follow from the popup to the tab, work from
 * the keyboard, fetch nothing unless a Google Font is chosen, and reset.
 * On 0.64.0 there is no Display block.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-display-test";

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
  console.log(`\ndisplay-settings: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const outside = [];
  context.on("request", (q) => { if (!/^(chrome-extension|data|blob):/.test(q.url())) outside.push(q.url()); });
  const errors = [];

  const tab = await context.newPage();
  tab.on("pageerror", (e) => errors.push(String(e)));
  await tab.setViewportSize({ width: 1280, height: 900 });
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await tab.waitForTimeout(1000);
  const openSettings = async (p) => {
    await p.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await p.waitForTimeout(500);
    await p.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
    await p.waitForTimeout(500);
    // Display is a group that starts closed (0.78.0).
    await p.evaluate(() => { const d = document.getElementById("setGroupDisplay"); if (d && !d.open) d.querySelector("summary").click(); });
    await p.waitForTimeout(200);
  };
  await openSettings(tab);

  // 0.78.0, asked: theme, font and the like grouped under Display settings.
  console.log("\nsettings in groups");
  {
    const g = await tab.evaluate(() => [...document.querySelectorAll("details.ab-group")].map((d) => d.querySelector("summary b").textContent));
    check("Display, Language and detail, Data and capture, Built-in AI, Reading and capture", g.join("|") === "Display|Language and detail|Data and capture|Built-in AI|Reading and capture", g.join("|"));
    check("theme, light/dark, motion and the typeface are all in Display", await tab.evaluate(() => ["#setStyle", "#setTheme", "#setMotion", "#setDisplay"].every((q) => document.querySelector(`#setGroupDisplay ${q}`))));
  }
  console.log("\nmotion on or off");
  {
    check("on by default", await tab.evaluate(() => document.documentElement.getAttribute("data-motion") === "on" && document.querySelector('#setMotion [data-motion-pick="on"]').getAttribute("aria-checked") === "true"));
    await tab.click('#setMotion [data-motion-pick="off"]');
    await tab.waitForTimeout(150);
    const off = await tab.evaluate(() => {
      document.querySelector('[data-tab="dashboard"]').click();
      const p = document.getElementById("dashboard");
      return { attr: document.documentElement.getAttribute("data-motion"), anim: getComputedStyle(p).animationName, saved: localStorage.getItem("cito-motion") };
    });
    check("Off stills every animation, and is kept", off.attr === "off" && off.anim === "none" && off.saved === "off", JSON.stringify(off));
    await tab.reload();
    await tab.waitForTimeout(800);
    check("and is in place before the panel's script runs, after a reload", await tab.evaluate(() => document.documentElement.getAttribute("data-motion") === "off"));
    await openSettings(tab);
    await tab.click('#setMotion [data-motion-pick="on"]');
    await tab.waitForTimeout(150);
    const on = await tab.evaluate(() => {
      document.querySelector('[data-tab="dashboard"]').click();
      return getComputedStyle(document.getElementById("dashboard")).animationName;
    });
    check("On: opening a page fades it in", on === "cito-fade", on);
    await openSettings(tab);
    const kept = await tab.evaluate(() => document.getElementById("setGroupDisplay").open);
    check("the Display group stays open once opened", kept);
  }

  console.log("\nthe Display block");
  {
    const d = await tab.evaluate(() => ({
      fonts: [...document.querySelectorAll("#dsFonts .ds-font")].map((b) => b.dataset.font),
      checked: document.querySelector('#dsFonts [aria-checked="true"]')?.dataset.font,
      sliders: [...document.querySelectorAll("#setDisplay .ds-range")].map((r) => r.id),
      density: !!document.getElementById("dsDensity"),
      mono: document.querySelectorAll("#dsMono button").length,
      google: !!document.getElementById("dsGoogle"),
      reset: document.getElementById("dsReset")?.disabled,
    }));
    check("fifteen bundled typefaces, Geist chosen", d.fonts.length === 15 && d.checked === "geist", d.fonts.join(", "));
    check("sliders for size, brightness, contrast and line spacing", d.sliders.join("|") === "dsSize|dsBrightness|dsContrast|dsLeading", d.sliders.join(", "));
    check("density, three code fonts and a Google Fonts search", d.density && d.mono === 3 && d.google, JSON.stringify(d));
    check("nothing to reset yet", d.reset === true);
  }

  console.log("\ntypeface and sliders apply at once");
  {
    await tab.evaluate(() => document.querySelector('#dsFonts [data-font="inter"]')?.click());
    await tab.waitForTimeout(400);
    const f = await tab.evaluate(async () => {
      await document.fonts.ready;
      return { family: getComputedStyle(document.body).fontFamily, loaded: document.fonts.check('13px "Inter"') };
    });
    check("picking Inter sets the page's typeface", /^"?Inter"?,/.test(f.family), f.family);
    check("from the bundled file", f.loaded, JSON.stringify(f));
    // Focused before each press: the Settings page draws other cards as their
    // data arrives, and a key sent while the page moved focus would be lost.
    for (let i = 0; i < 3; i++) { await tab.focus("#dsSize"); await tab.keyboard.press("ArrowRight"); }
    await tab.waitForTimeout(300);
    const z = await tab.evaluate(() => ({ v: document.getElementById("dsSize").value, out: document.querySelector('output[for="dsSize"]').textContent, zoom: getComputedStyle(document.querySelector(".app-content")).zoom }));
    check("the size slider moves from the keyboard and says its value", z.v === "115" && z.out === "115%", JSON.stringify(z));
    check("and the page grows", Math.abs(Number(z.zoom) - 1.15) < 0.001, z.zoom);
    await tab.focus("#dsContrast");
    await tab.keyboard.press("ArrowRight");
    await tab.waitForTimeout(300);
    const c = await tab.evaluate(() => ({ filter: getComputedStyle(document.querySelector(".app-content")).filter, flag: document.documentElement.hasAttribute("data-display-filter") }));
    check("contrast is a filter on the page", c.flag && /contrast\(1\.05\)/.test(c.filter), JSON.stringify(c));
    await tab.evaluate(() => document.querySelector('#dsDensity [data-value="compact"]')?.click());
    await tab.waitForTimeout(300);
    check("compact density is set", await tab.evaluate(() => document.documentElement.dataset.density === "compact"));
    check("reset is offered once something changed", await tab.evaluate(() => document.getElementById("dsReset").disabled === false));
  }

  console.log("\nthe popup follows, and has it before its first paint");
  {
    const pop = await context.newPage();
    pop.on("pageerror", (e) => errors.push(String(e)));
    await pop.setViewportSize({ width: 540, height: 600 });
    // Read the moment the boot script has run, before panel.js.
    await pop.addInitScript(() => { document.addEventListener("readystatechange", () => { if (document.readyState === "interactive" && !window.__firstPaint) window.__firstPaint = { zoom: document.documentElement.style.getPropertyValue("--ui-zoom"), font: document.documentElement.style.getPropertyValue("--font-sans") }; }); });
    await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
    await pop.waitForTimeout(1000);
    const fp = await pop.evaluate(() => window.__firstPaint);
    check("the saved size and typeface are there before the panel's script runs", fp && fp.zoom === "1.15" && /^"Inter"/.test(fp.font), JSON.stringify(fp));
    const wide = await pop.evaluate(() => { const c = document.querySelector(".app-content"); return c.scrollWidth - c.clientWidth; });
    check("the bigger text reflows inside the popup", wide <= 1, `${wide}px`);
    await openSettings(pop);
    await pop.focus("#dsLeading");
    await pop.keyboard.press("ArrowRight");
    await pop.waitForTimeout(400);
    const l = await tab.evaluate(() => ({ v: getComputedStyle(document.documentElement).getPropertyValue("--ui-leading").trim(), slider: document.getElementById("dsLeading").value }));
    check("a change in the popup reaches the open tab", l.v === "1.05" && l.slider === "105", JSON.stringify(l));
    await pop.close();
  }

  console.log("\nno request leaves the browser for a bundled face");
  check("none so far", outside.length === 0, outside.slice(0, 3).join(" | "));

  console.log("\na Google Font, when asked for");
  {
    await tab.fill("#dsGoogle", "Popp");
    await tab.waitForTimeout(600);
    const opts = await tab.evaluate(() => [...document.querySelectorAll("#dsGoogleList li")].map((li) => li.firstChild.textContent));
    check("searching lists matching Google families", opts[0] === "Poppins", opts.join(", "));
    await tab.keyboard.press("Enter");
    await tab.waitForTimeout(800);
    const g = await tab.evaluate(() => ({
      href: document.getElementById("cito-gfont")?.getAttribute("href") || "",
      checked: document.querySelector('#dsFonts [aria-checked="true"]')?.dataset.font,
      note: document.getElementById("dsGoogleNote")?.textContent || "",
      family: getComputedStyle(document.body).fontFamily,
    }));
    check("it adds the one stylesheet from fonts.googleapis.com", /^https:\/\/fonts\.googleapis\.com\/css2\?family=Poppins/.test(g.href), g.href);
    check("and says Google sees the request", /Google sees/.test(g.note) && g.checked === "google", g.note);
    check("the page asks for it, and only that host", outside.length > 0 && outside.every((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), outside.slice(0, 3).join(" | "));
    check("the typeface follows", /^"?Poppins"?,/.test(g.family), g.family);
  }

  console.log("\nin both themes, and reset");
  {
    await tab.evaluate(() => document.querySelector('#dsFonts [data-font="lora"]')?.click());
    await tab.waitForTimeout(300);
    const both = [];
    for (const t of ["light", "dark"]) {
      await tab.evaluate((t) => document.querySelector(`#setTheme [data-theme-pick="${t}"]`)?.click(), t);
      await tab.waitForTimeout(200);
      both.push(await tab.evaluate(() => getComputedStyle(document.body).fontFamily));
    }
    check("the typeface is the same in light and dark", both.every((f) => /^"?Lora"?,/.test(f)), both.join(" | "));
    check("and a bundled face removes the Google link", await tab.evaluate(() => !document.getElementById("cito-gfont")));
    await tab.evaluate(() => document.getElementById("dsReset")?.click());
    await tab.waitForTimeout(300);
    const r = await tab.evaluate(() => ({ stored: localStorage.getItem("cito-display"), zoom: getComputedStyle(document.querySelector(".app-content")).zoom, family: getComputedStyle(document.body).fontFamily, density: document.documentElement.dataset.density, filter: document.documentElement.hasAttribute("data-display-filter") }));
    check("reset puts everything back", r.stored === null && Number(r.zoom) === 1 && /^"?Geist"?,/.test(r.family) && r.density === "comfortable" && !r.filter, JSON.stringify(r));
    await tab.evaluate(() => document.querySelector('#setTheme [data-theme-pick="light"]')?.click());
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
