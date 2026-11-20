/*
 * onboarding-ui.test.mjs — what a first-time user, or someone updating from
 * 0.36, sees (1.0.0), in a real browser with the extension loaded:
 *   - Get started on the Dashboard, ticked off by what was done, and hidden
 *     on request;
 *   - the help page, in the chosen language;
 *   - the welcome guide opening on "What's changed" only for an update from
 *     before the redesign;
 *   - example prompts in campaign setup, with the year written as a year.
 * The campaign's "What to do next" sentences are unit tested
 * (test/getting-started.test.mjs). Made-up answers from test/fixtures.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-onboarding-ui-test";

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
  console.log(`\nonboarding-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// Start from an empty profile. This folder is fixed and outlives the run, so
// without this a second run on the same machine reopens the first run's
// storage (HANDOFF rule 9). Only this test's own folder is removed.
rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  await context.addInitScript(() => { try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* fine */ } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1200, height: 900 });
  const TAB = `chrome-extension://${extId}/ui/panel.html?mode=tab`;
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const dash = async () => {
    await page.goto(TAB); await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]')?.click()); await page.waitForTimeout(900);
    return page.evaluate(() => {
      const g = document.querySelector(".gs");
      return g ? { count: g.querySelector(".gs-count")?.textContent, done: [...g.querySelectorAll(".gs-step.done")].length, next: g.querySelector(".gs-step.next b")?.textContent, go: g.querySelector(".gs-step.next .gs-go")?.textContent, help: g.querySelector(".gs-help")?.getAttribute("href") } : null;
    });
  };
  await page.goto(TAB); await page.waitForTimeout(800);
  await msg({ type: "demo-clear" });

  console.log("\nGet started, on the Dashboard");
  {
    const g = await dash();
    check("shown on a fresh install, nothing done", g && g.count === "0 of 5 done" && g.done === 0, JSON.stringify(g));
    check("the next step says what to do, and links to an engine", g && g.next === "Ask an AI something" && g.go === "Open ChatGPT", JSON.stringify(g));
    check("with a link to the help page", g && /ui\/help\.html$/.test(g.help || ""), g && g.help);
  }
  {
    // An answer arrives, as if asked on ChatGPT.
    const raw = readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
    const reqBody = JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: ["best smartphone under 50000"] } }] });
    await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    // The panel opens on Analyze with the newest answer, so having opened it
    // is having read it there.
    const g2 = await dash();
    check("a captured answer, opened in Analyze, ticks the first two steps", g2 && g2.done === 2 && g2.next === "Create a campaign" && g2.go === "Go there", JSON.stringify(g2));
    await page.evaluate(() => [...document.querySelectorAll(".gs-hide")][0]?.click()); await page.waitForTimeout(500);
    check("Hide puts it away", await page.evaluate(() => !document.querySelector(".gs")));
    const g3 = await dash();
    check("and it stays away", g3 === null, JSON.stringify(g3));
  }

  console.log("\nthe help page");
  {
    await page.goto(TAB); await page.evaluate(() => localStorage.setItem("cito-lang", "es"));
    await page.goto(`chrome-extension://${extId}/ui/help.html`); await page.waitForTimeout(1200);
    const h = await page.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, qs: document.querySelectorAll(".hp-q").length, steps: document.querySelectorAll(".hp-steps li").length, changed: document.querySelectorAll(".hp-changed dt").length, lang: document.documentElement.lang }));
    check("in the chosen language", h.h1 === "Ayuda de CitoSkeleton" && h.lang === "es", JSON.stringify(h));
    check("the five steps, the questions, and where things went since 0.36", h.steps === 5 && h.qs >= 10 && h.changed === 6, JSON.stringify(h));
    await page.evaluate(() => localStorage.setItem("cito-lang", "en"));
  }

  console.log("\nthe welcome guide");
  {
    const first = async () => { await page.goto(`chrome-extension://${extId}/ui/welcome.html`); await page.waitForTimeout(1200); return page.evaluate(() => ({ step: document.querySelector(".wl-step")?.dataset.step, h: document.querySelector(".wl-h")?.textContent, changed: document.querySelectorAll(".wl-changed dt").length })); };
    const fresh = await first();
    check("a new install starts on what the tool is", fresh.step === "hello", JSON.stringify(fresh));
    await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ citoUpdatedFrom: "0.36.0" }, r)));
    const upd = await first();
    check("an update from 0.36 starts on what changed, then the rest", upd.step === "changed" && upd.h === "What's changed since your last version" && upd.changed === 6, JSON.stringify(upd));
    await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ citoUpdatedFrom: "0.82.0" }, r)));
    check("an update from after the redesign doesn't", (await first()).step === "hello");
  }

  console.log("\nexample prompts in campaign setup");
  {
    await page.goto(TAB); await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click()); await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll("#loader button")].find((b) => /Create your first/.test(b.textContent))?.click()); await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll(".cs-mode")].find((b) => /Add manually/.test(b.textContent))?.click()); await page.waitForTimeout(600);
    await page.fill("#cs-brand", "Zento").catch(() => {});
    await page.evaluate(() => [...document.querySelectorAll(".cs-examples button")][0]?.click()); await page.waitForTimeout(300);
    check("nothing filled in without saying what you sell", await page.evaluate(() => !(document.getElementById("cs-manual") || {}).value));
    await page.fill("#cs-example-cat", "running shoes");
    await page.evaluate(() => [...document.querySelectorAll(".cs-examples button")][0]?.click()); await page.waitForTimeout(400);
    const lines = (await page.evaluate(() => (document.getElementById("cs-manual") || {}).value || "")).split("\n");
    const year = String(new Date().getFullYear());
    check("example prompts with the category, the brand and a tag", lines.length >= 8 && lines[0] === "best running shoes | discovery" && lines.some((l) => l.includes("Zento")), lines.slice(0, 3).join(" / "));
    check("the year written as a year", lines.some((l) => l.includes(` in ${year} `)) && !lines.some((l) => /\d,\d{3}/.test(l)), lines.find((l) => l.includes(" in ")));
    check("and they count as prompts ready to add", /^\d+ prompts ready to add$/.test(await page.evaluate(() => document.querySelector(".cs-manual-count")?.textContent || "")));
  }
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
