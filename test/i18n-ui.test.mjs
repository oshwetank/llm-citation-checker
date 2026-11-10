/*
 * The interface in Spanish and Arabic, right to left (0.71.0).
 * Run: node test/i18n-ui.test.mjs
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-i18n-ui-test";
const ES = JSON.parse(readFileSync(path.join(EXT_PATH, "ui/i18n/es.json"), "utf8"));
const AR = JSON.parse(readFileSync(path.join(EXT_PATH, "ui/i18n/ar.json"), "utf8"));

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
} catch (err) { console.log(`\ni18n-ui: CANNOT RUN — ${err.message}`); process.exit(1); }

const fixture = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false, args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
  const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  const navText = () => page.evaluate(() => [...document.querySelectorAll(".nav-tab")].map((b) => b.textContent.trim()));

  console.log("\nEnglish, as before");
  {
    await page.reload(); await page.waitForTimeout(800);
    const n = await navText();
    check("the tabs read in English", n.some((t) => /Dashboard/.test(t)) && n.some((t) => /Campaigns/.test(t)), n.join(" | "));
    check("left to right", await page.evaluate(() => document.documentElement.dir !== "rtl"));
  }

  console.log("\nSpanish, picked in Settings");
  {
    await page.evaluate(() => document.querySelector('[data-tab="about"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn")].find((b) => /Settings/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
    const opts = await page.evaluate(() => [...document.querySelectorAll("#setLang option")].map((o) => o.value));
    check("a Language choice with the browser's and six languages", opts.join() === "auto,en,es,pt-BR,fr,hi,ar", opts.join());
    await Promise.all([page.waitForNavigation({ timeout: 10000 }).catch(() => {}), page.selectOption("#setLang", "es")]);
    await page.waitForTimeout(1000);
    const n = await navText();
    check("the tabs read in Spanish", n.some((t) => t.includes(ES.Dashboard)) && n.some((t) => t.includes(ES.Campaigns)), n.join(" | "));
    check("the page says it is Spanish", await page.evaluate(() => document.documentElement.lang === "es"));
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${res.captureId}`);
    await page.waitForSelector("#at-glance", { timeout: 15000 }).catch(() => {});
    const t = await page.evaluate(() => document.body.innerText);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/es-analyze.png` });
    check("Analyze's section titles are Spanish too", t.includes(ES["At a glance"]) && t.includes(ES["Where it came from"]), t.slice(0, 200));
    check("the answer's own text is left as it is", /Zento/.test(t));
  }

  console.log("\nArabic, right to left");
  {
    await page.evaluate(() => localStorage.setItem("cito-lang", "ar"));
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${res.captureId}`);
    await page.waitForSelector("#at-glance", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const d = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    check("dir=rtl, lang=ar", d.dir === "rtl" && d.lang === "ar", JSON.stringify(d));
    check("no sideways scroll at 1280", d.over <= 1, String(d.over));
    const n = await navText();
    check("the tabs read in Arabic", n.some((x) => x.includes(AR.Dashboard)), n.join(" | "));
    const side = await page.evaluate(() => { const r = document.getElementById("at-rail"); const m = document.querySelector(".at-main, #analyze"); return r && m ? { rail: Math.round(r.getBoundingClientRect().left), w: innerWidth } : null; });
    check("the section rail sits on the right", side && side.rail > side.w / 2, JSON.stringify(side));
    const ans = await page.evaluate(() => { const b = document.querySelector(".at-answer-body"); return b ? getComputedStyle(b.querySelector("li, p, div") || b).direction : null; });
    check("an English answer still reads left to right inside it", ans === "ltr", String(ans));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/ar-analyze.png` });
    await page.setViewportSize({ width: 540, height: 720 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(1200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("no sideways scroll in the popup either", over <= 1, String(over));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/ar-popup.png` });
  }

  console.log("\nback to the browser's language");
  {
    await page.evaluate(() => localStorage.setItem("cito-lang", "auto"));
    await page.reload(); await page.waitForTimeout(800);
    check("English again, left to right", await page.evaluate(() => document.documentElement.lang === "en" && document.documentElement.dir === "ltr"));
  }
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally { await context.close(); }

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
