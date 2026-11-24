/*
 * campaign-popup.test.mjs — campaigns are set up in the full view only
 * (1.0.5, asked: "people can't create a campaign in the popup"). The popup
 * closes as soon as focus moves, and a half-typed setup went with it.
 *
 * In the popup: "+ New campaign" makes no campaign there and opens the full
 * view, which lands on a new campaign's setup; a campaign that needs setting
 * up shows a card that opens the full view instead of the form.
 * Run: node test/campaign-popup.test.mjs
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-popup-test";
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
} catch (err) { console.log(`\ncampaign-popup: CANNOT RUN — playwright is not installed. ${err.message}`); process.exit(1); }

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 420, height: 600 });
  await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
  await pop.evaluate(() => { localStorage.setItem("cito-tour-seen", "1"); window.close = () => { window.__closed = true; }; });
  await pop.waitForTimeout(800);
  const send = (m) => pop.evaluate((x) => new Promise((r) => chrome.runtime.sendMessage(x, r)), m);
  check("this is the popup", await pop.evaluate(() => document.documentElement.classList.contains("popup")));
  await pop.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await pop.waitForTimeout(800);

  console.log("\n\"Create your first campaign\" in the popup");
  const before = ((await send({ type: "geo-profile-list" })) || {}).profiles || [];
  const opened = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
  await pop.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Create your first campaign|\+ New campaign/.test(b.textContent))?.click());
  const full = await opened;
  await pop.waitForTimeout(500);
  check("opens the full view", !!full && /panel\.html\?.*mode=tab.*newCampaign=1/.test(full.url()), full ? full.url() : "no new tab");
  check("and the popup closes", await pop.evaluate(() => window.__closed === true));

  console.log("\nThe full view it opened");
  if (full) {
    await full.waitForLoadState("domcontentloaded");
    await full.waitForTimeout(2500);
    const st = await full.evaluate(() => ({ tab: document.querySelector(".panel.active")?.id, form: !!document.querySelector("#loader .cs-card-details, #cs-name"), popupCard: !!document.getElementById("csPopupNote") }));
    const after = ((await send({ type: "geo-profile-list" })) || {}).profiles || [];
    check("lands on the new campaign's setup form, the only campaign made (the popup made none)", st.tab === "loader" && st.form && !st.popupCard && after.length === before.length + 1, JSON.stringify({ ...st, campaigns: after.length }));
  }

  console.log("\nA campaign that needs setting up, seen in the popup");
  await pop.reload(); await pop.evaluate(() => { window.close = () => { window.__closed = true; }; });
  await pop.waitForTimeout(800);
  await pop.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await pop.waitForTimeout(1200);
  const pv = await pop.evaluate(() => ({ form: !!document.querySelector("#loader #cs-name"), card: !!document.getElementById("csPopupNote"), btn: document.getElementById("csOpenFull")?.textContent }));
  check("no setup form in the popup, a card to the full view instead", !pv.form && pv.card && /Open the full view/.test(pv.btn || ""), JSON.stringify(pv));
} finally { await context.close(); }
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
