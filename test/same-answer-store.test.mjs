/*
 * same-answer-store.test.mjs — copies of one answer, through the real
 * capture pipeline, are stored as one record (background.js
 * settleSameAnswer, src/lib/sameAnswer.js).
 *
 * Reported: "i only run 1 query but the tool captured multiple responses":
 * one Grok question stored six times, the newest (no pages) being the one
 * every view opened. Here the committed Grok fixture is sent twice under the
 * same reply address (grok.com/c/<conversation>?rid=<reply>): as captured,
 * then as the late copy Grok sends, with the text but its search results
 * stripped. A ChatGPT answer in another conversation stays its own record.
 * Then reprocessing, and deleting the record.
 *
 * Fails on 0.56.0: two Grok records, the newest without pages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-same-answer-test";

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
  console.log("\nsame-answer-store: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the capture store, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// A fixture file: "# url:" and "# reqBody:" header lines, then the body.
function fixture(name) {
  const lines = readFileSync(path.join(FIXDIR, name), "utf8").split("\n");
  let i = 0, url = "", reqBody = "";
  while (i < lines.length && lines[i].startsWith("# ")) {
    if (lines[i].startsWith("# url: ")) url = lines[i].slice(7);
    if (lines[i].startsWith("# reqBody: ")) reqBody = lines[i].slice(11);
    i++;
  }
  return { url, reqBody, raw: lines.slice(i).join("\n").replace(/^\n/, "") };
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(800);
  const ask = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  await ask({ type: "demo-clear" });
  const send = (f, pageUrl, at) => ask({ type: "raw-conversation", payload: { raw: f.raw, reqBody: f.reqBody, url: f.url, pageUrl, capturedAt: at } });
  const derived = async () => ((await ask({ type: "get-records" })).records || []).filter((r) => !r.demo);
  const rawCount = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => { const q = r.result.transaction("raw").objectStore("raw").count(); q.onsuccess = () => res(q.result); }; }));

  const grok = fixture("grok-cameraPhoneRenderTags.txt");
  // Grok's late copy: the same reply, its search results and steps gone.
  const lateJson = JSON.parse(grok.raw);
  for (const r of lateJson.responses) {
    if (r.sender !== "assistant") continue;
    for (const k of ["webSearchResults", "citedWebSearchResults", "cardAttachmentsJson", "steps", "toolResponses"]) r[k] = [];
  }
  const late = { ...grok, raw: JSON.stringify(lateJson) };
  const REPLY = "https://grok.com/c/98312727-e1ec-4b06-9202-74c7f49d300f?rid=1604cd56-ed23-42db-86e4-c5244bc67490";
  const t0 = Date.now() - 60_000;

  console.log("\nTwo copies of one Grok reply");
  const a = await send(grok, REPLY, t0);
  const b = await send(late, REPLY, t0 + 4000);
  check("both were taken in", a && a.ok && b && b.ok, JSON.stringify({ a, b }));
  check("the second is merged into the first: same id", a.captureId && b.captureId === a.captureId, `${a.captureId} / ${b.captureId}`);
  let recs = await derived();
  const grokRecs = recs.filter((r) => r.platform === "grok");
  check("one Grok record, not two", grokRecs.length === 1, grokRecs.length);
  const full = (await ask({ type: "get-record", captureId: a.captureId })).record;
  check("it has the pages the full copy had", full && full.sources.length > 0, full && full.sources.length);
  check("and says which copy it absorbed", full && Array.isArray(full.mergedFrom) && full.mergedFrom.length === 1, JSON.stringify(full && full.mergedFrom));
  check("both raw copies are kept", (await rawCount()) === 2, await rawCount());

  console.log("\nAnother engine's answer stays its own");
  const chat = fixture("chatgpt-phone-under.txt");
  const c = await send({ ...chat, reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: ["best smartphone under 50000"] } }] }) }, "https://chatgpt.com/c/aaaa-bbbb", t0 + 5000);
  recs = await derived();
  check("a ChatGPT answer is a separate record", c.captureId !== a.captureId && recs.length === 2, recs.length);

  console.log("\nReprocessing rebuilds the same single record");
  await ask({ type: "reprocess-all" });
  recs = await derived();
  const after = recs.filter((r) => r.platform === "grok");
  check("still one Grok record, under the same id", after.length === 1 && after[0].captureId === a.captureId, after.map((r) => r.captureId).join(","));
  const re = (await ask({ type: "get-record", captureId: a.captureId })).record;
  check("with the same pages", re && re.sources.length === full.sources.length, `${re && re.sources.length} vs ${full.sources.length}`);

  console.log("\nDeleting the record deletes its copies");
  await ask({ type: "delete-record", captureId: a.captureId });
  check("the Grok record is gone", !(await derived()).some((r) => r.platform === "grok"));
  check("and both its raw copies, leaving ChatGPT's", (await rawCount()) === 1, await rawCount());
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
