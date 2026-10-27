/*
 * tour-once.test.mjs — the first-run guide opens once (0.80.0).
 *
 * Reported: "the beginner guide screen keeps on popping up many times, even
 * if the user is not using it for the first time". It was marked seen only
 * when clicked through to the end, so a popup closed half way showed it again
 * next time; and it read the flag before loading the sample data and not
 * after, so it could open after being marked seen.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-tour-once-test";

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
  console.log(`\ntour-once: CANNOT RUN — playwright is not installed. ${err.message}`);
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
  const shown = async (url) => {
    const p = await context.newPage();
    await p.goto(url);
    let on = false;
    for (let i = 0; i < 12 && !on; i++) { await p.waitForTimeout(500); on = await p.evaluate(() => !!document.getElementById("tour-backdrop")); }
    return { p, on };
  };

  console.log("\nthe first time");
  const first = await shown(`chrome-extension://${extId}/ui/panel.html`);
  check("the guide opens", first.on);
  // Closed half way: the popup simply goes away, nothing clicked.
  await first.p.close();

  console.log("\nevery time after");
  const second = await shown(`chrome-extension://${extId}/ui/panel.html`);
  check("not again in the popup, though it was closed half way", !second.on);
  await second.p.close();
  const tab = await shown(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  check("nor in the full tab", !tab.on);
  await tab.p.evaluate(() => localStorage.clear());
  await tab.p.reload();
  await tab.p.waitForTimeout(4000);
  check("nor when this page's own storage is cleared (the extension remembers)", !(await tab.p.evaluate(() => !!document.getElementById("tour-backdrop"))));
  await tab.p.evaluate(() => document.getElementById("replayTour")?.click());
  await tab.p.waitForTimeout(300);
  check("it can still be replayed from About", await tab.p.evaluate(() => !!document.getElementById("tour-backdrop")));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
