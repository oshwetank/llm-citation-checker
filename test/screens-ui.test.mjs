/*
 * Every screen at every width (0.72.0). Run: node test/screens-ui.test.mjs
 *
 * The owner: "compatible to be able to use across any browser and screen
 * size". The full tab is opened at a phone, a tablet, a laptop, a desktop
 * and a 4K width, and at 200% zoom (half the width at twice the pixels);
 * each tab must draw without pushing the page sideways and without errors.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-screens-ui-test";
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
} catch (err) { console.log(`\nscreens-ui: CANNOT RUN — ${err.message}`); process.exit(1); }

const fixture = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};
const WIDTHS = [[360, 740, 1], [768, 1024, 1], [1024, 768, 1], [1440, 900, 1], [2560, 1440, 1], [720, 450, 2]];
const TABS = ["analyze", "dashboard", "campaigns", "about"];

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false, args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => seedPage.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  let id = null;
  for (const f of ["chatgpt-genui-cards.txt", "chatgpt-genui-entity-cards.txt"]) {
    const { raw, reqBody } = fixture(f);
    const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    id = id || res.captureId;
  }
  await seedPage.close();
  for (const [w, h, dpr] of WIDTHS) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    // 200% zoom lays the page out at half the width in CSS pixels: the 720
    // case is a 1440 screen at 200%.
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${id}`);
    await page.waitForSelector("#at-glance", { timeout: 15000 }).catch(() => {});
    const bad = [];
    for (const t of TABS) {
      await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), t);
      await page.waitForTimeout(900);
      const r = await page.evaluate(() => {
        const d = document.documentElement;
        const over = d.scrollWidth - d.clientWidth;
        // The widest element sticking out of the viewport, to say what broke.
        let worst = null;
        if (over > 1) for (const el of document.querySelectorAll("body *")) {
          const b = el.getBoundingClientRect();
          if (b.right > d.clientWidth + 1 && b.width > 0 && getComputedStyle(el).position !== "fixed") { if (!worst || b.right > worst.r) worst = { r: Math.round(b.right), c: String(el.className || el.tagName).slice(0, 60) }; }
        }
        return { over, worst };
      });
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      if (Math.abs(vw - w) > 20) bad.push(`${t}: laid out ${vw}px wide, not ${w}`);
      if (r.over > 1) bad.push(`${t}: ${r.over}px (${r.worst && r.worst.c})`);
    }
    check(`${w}×${h}${dpr > 1 ? " at 200%" : ""}: every tab fits the width`, bad.length === 0, bad.join("; "));
    check(`${w}×${h}${dpr > 1 ? " at 200%" : ""}: no page errors`, errors.length === 0, errors.join(" | "));
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/screen-${w}x${dpr}.png` });
    await page.close();
  }
} finally { await context.close(); }

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
