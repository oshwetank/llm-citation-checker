/*
 * The panel stays light while answers are being checked (0.74.0).
 * Run: node test/panel-refresh.test.mjs
 *
 * The owner: "once the LLM is downloaded the tool becomes heavy to use". The
 * AI queue tells the panel about a record several times per capture (queued,
 * checked); each of those used to refetch every capture and rebuild three
 * tabs. Now a record named by the broadcast is fetched alone and patched in,
 * and only the tab on screen is redrawn. A new capture still refreshes the
 * list.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-panel-refresh-test";

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
  console.log(`\npanel-refresh: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const fixture = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};

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
  page.on("pageerror", (e) => errors.push(String(e)));
  // Count what the panel asks the extension for.
  await page.addInitScript(() => {
    window.__sent = {};
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...rest) => { if (m && m.type) window.__sent[m.type] = (window.__sent[m.type] || 0) + 1; return orig(m, ...rest); };
  });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const ids = [];
  for (const f of ["chatgpt-genui-cards.txt", "chatgpt-genui-entity-cards.txt", "chatgpt-phone-under.txt"]) {
    const { raw, reqBody } = fixture(f);
    ids.push((await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } })).captureId);
  }
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForTimeout(1500);
  const sent = () => page.evaluate(() => ({ ...window.__sent }));

  console.log("\nan AI check finishing on the answer on screen");
  const s0 = await sent();
  for (let i = 0; i < 4; i++) await sw.evaluate((id) => chrome.runtime.sendMessage({ type: "capture-updated", captureId: id }).catch(() => {}), ids[ids.length - 1]);
  await page.waitForTimeout(1200);
  const s1 = await sent();
  check("no refetch of every capture", (s1["get-records"] || 0) === (s0["get-records"] || 0), JSON.stringify({ before: s0["get-records"], after: s1["get-records"] }));
  check("four broadcasts, one record fetched (they collapse)", (s1["get-record-light"] || 0) - (s0["get-record-light"] || 0) === 1, JSON.stringify(s1));
  check("no campaign or stats reload either", (s1["stats"] || 0) === (s0["stats"] || 0) && (s1["project-list"] || 0) === (s0["project-list"] || 0));
  check("the answer is still drawn", await page.evaluate(() => document.querySelectorAll("#analyze *").length > 50));

  console.log("\na brand-new capture");
  const { raw, reqBody } = fixture("chatgpt-genui-cards.txt");
  // A new reply has message ids of its own (1.0.2): copies sharing ids are one
  // reply and are merged, so changing the text alone is not a new answer.
  const fresh = raw.replace(/Zento/g, "Zentox").replace(/"(m-[a-z]+)"/g, '"$1-new"');
  await msg({ type: "raw-conversation", payload: { raw: fresh, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  await page.waitForTimeout(1500);
  const s2 = await sent();
  check("refreshes the list (a new row has to come in)", (s2["get-records"] || 0) > (s1["get-records"] || 0));
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
