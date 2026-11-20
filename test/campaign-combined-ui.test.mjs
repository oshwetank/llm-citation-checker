/*
 * campaign-combined-ui.test.mjs — engines run separately read as one
 * campaign; two runs of the same engine side by side; a second campaign
 * waits its turn (0.80.0).
 *
 * Asked: "if I run ChatGPT, then another model for the same campaign, I end
 * up losing my ChatGPT data … I'm not able to analyse it under one panel";
 * "same campaign, same prompt on same LLM, I should be able to see the
 * difference"; "two campaigns for two brands, I should be able to run both".
 * Seeded from fixture answers (made-up brands in the fixtures):
 *   run 1 (oldest): ChatGPT only;  run 2: Gemini only;  run 3: ChatGPT again,
 *   with the own brand taken out of its answers.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-combined-test";

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
  console.log(`\ncampaign-combined-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const SEEDS = [
  ["chatgpt-phone-under.txt", "chatgpt", "best smartphone under 50000"],
  ["gemini-streamgenerate.txt", "gemini", "best smartphone under 50000"],
  ["chatgpt-tv.txt", "chatgpt", "best tv to buy"],
];

const SEED = async (seeds) => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await open();
  const tx = (s, m) => db.transaction(s, m).objectStore(s);
  const all = (s) => new Promise((res) => { const r = tx(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
  const put = (s, v) => new Promise((res) => { const r = tx(s, "readwrite").put(v); r.onsuccess = () => res(); });
  const del = (s, k) => new Promise((res) => { const r = tx(s, "readwrite").delete(k); r.onsuccess = () => res(); });
  const derived = (await all("derived")).filter((r) => r.userPrompt);
  const counts = new Map();
  derived.filter((r) => r.platform === "chatgpt").forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const own = ranked[0];
  const profileId = crypto.randomUUID();
  await put("profiles", { id: profileId, name: "Combined Test", brand: { name: own, url: "" }, competitors: ranked.slice(1, 3).map((n) => ({ name: n, url: "" })), engines: ["chatgpt", "gemini"], locked: true, createdAt: Date.now() - 9e8, lastRunAt: Date.now(), deletedAt: null });
  const second = crypto.randomUUID();
  await put("profiles", { id: second, name: "Second Brand", brand: { name: "Lumora", url: "" }, competitors: [], engines: ["chatgpt"], locked: true, createdAt: Date.now() - 9e8, lastRunAt: null, deletedAt: null });
  await put("trackedPrompts", { id: crypto.randomUUID(), profileId: second, text: "best lamp for reading", tags: [], active: true, createdAt: Date.now() });
  const prompts = new Map();
  for (const [, , text] of seeds) if (!prompts.has(text)) { const id = crypto.randomUUID(); prompts.set(text, id); await put("trackedPrompts", { id, profileId, text, tags: [], active: true, createdAt: Date.now() - 9e8 + prompts.size }); }
  const runs = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const at = [Date.now() - 9 * 864e5, Date.now() - 5 * 864e5, Date.now() - 864e5];
  for (let i = 0; i < 3; i++) await put("geoRuns", { id: runs[i], profileId, startedAt: at[i], finishedAt: at[i] + 6e5, status: "done", engines: i === 1 ? ["gemini"] : ["chatgpt"], promptIds: [...prompts.values()], expected: 2, captured: 2, failed: 0, reasons: {} });
  for (const rec of derived) {
    const promptId = prompts.get(rec.userPrompt);
    await del("derived", rec.captureId);
    if (rec.platform === "gemini") { await put("derived", { ...rec, captureId: `${rec.captureId}-r2`, capturedAt: at[1] + 1000, geo: { profileId, runId: runs[1], promptId, tags: [] } }); continue; }
    await put("derived", { ...rec, captureId: `${rec.captureId}-r1`, capturedAt: at[0] + 1000, geo: { profileId, runId: runs[0], promptId, tags: [] } });
    await put("derived", { ...rec, captureId: `${rec.captureId}-r3`, capturedAt: at[2] + 1000, brandMentions: (rec.brandMentions || []).filter((m) => m.brand !== own), answerText: String(rec.answerText || "").split(own).join("Brand"), geo: { profileId, runId: runs[2], promptId, tags: [] } });
  }
  return { own, profileId, second };
};

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  // A stub ChatGPT page that takes the prompt and never answers: enough to
  // keep a run going while a second campaign is started.
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<body><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button">send</button></body>` }));
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(800);
  const ask = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  await ask({ type: "demo-clear" });
  const gpt = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
  const gem = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);
  for (const [file, engine, prompt] of SEEDS) {
    const raw = readFileSync(path.join(FIXDIR, file), "utf8");
    await ask({ type: "raw-conversation", payload: { raw, reqBody: engine === "gemini" ? gem(prompt) : gpt(prompt), pageUrl: engine === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/", capturedAt: Date.now() } });
  }
  const seeded = await page.evaluate(SEED, SEEDS);
  check("seeded three runs", !!seeded.own, JSON.stringify(seeded));

  console.log("\nengines run separately, one view");
  const b = await ask({ type: "campaign-board", profileId: seeded.profileId });
  check("opens on each engine's newest answers", b.ok && b.runId === "latest" && b.mixedRuns === true, JSON.stringify({ runId: b.runId, mixed: b.mixedRuns }));
  const engines = new Set((b.view && b.view.prompts || []).flatMap((p) => (p.cells || []).filter((c) => c && c.answered).map((c) => c.engine)));
  check("ChatGPT's answers from run 3 beside Gemini's from run 2: 3 answers, not 5", b.answers === 3, b.answers);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  // The switcher is a row of chips. Wait for the seeded campaign's chip, open
  // it, then wait for its board: fixed sleeps were too short on CI.
  await page.waitForFunction(() => [...document.querySelectorAll(".geo-switcher .geo-chip")].some((b) => /^Combined Test/.test(b.textContent)), null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { const b = [...document.querySelectorAll(".geo-switcher .geo-chip")].find((x) => /^Combined Test/.test(x.textContent)); if (b && !b.classList.contains("active")) b.click(); });
  await page.waitForFunction(() => document.getElementById("cbRun") && /Latest answer/.test(document.getElementById("campaignResultsH")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
  const pick = await page.evaluate(() => ({ value: document.getElementById("cbRun")?.value, first: document.querySelector("#cbRun option")?.textContent, scope: document.getElementById("campaignResultsH")?.textContent || "" }));
  check("the run picker starts on Latest answers · every engine", pick.value === "latest" && /Latest answers/.test(pick.first), JSON.stringify(pick));
  check("and the board says what it shows", /Latest answer per prompt and engine/.test(pick.scope), pick.scope);

  console.log("\nrun vs run");
  const runs = (b.runs || []).filter((r) => r.hasAnswers).sort((x, y) => x.startedAt - y.startedAt);
  const c = await ask({ type: "campaign-run-compare", profileId: seeded.profileId, runA: runs[0].id, runB: runs[2].id });
  check("ChatGPT run 1 against run 3: both prompts compared", c.ok && c.compare.compared === 2, JSON.stringify(c.compare && { compared: c.compare.compared, onlyA: c.compare.onlyA }));
  const own = c.compare.brands.find((x) => x.isOwn);
  check("your brand, named in run 1, gone in run 3", own && own.a.visibility > 0 && own.b.visibility === 0, JSON.stringify(own));
  check("so its prompts read as worse", c.compare.summary.worse >= 1, JSON.stringify(c.compare.summary));
  const g = await ask({ type: "campaign-run-compare", profileId: seeded.profileId, runA: runs[0].id, runB: runs[1].id });
  check("a ChatGPT run against a Gemini run has nothing in common", g.ok && g.compare.compared === 0);
  // The board is rebuilt after a fresh request whenever the campaign page
  // redraws, and has no tabs until it answers: a single click can land while
  // it is being rebuilt and do nothing (CI on 19 Nov 2026: Overview stayed
  // open, "a": false). So: wait for the tab, and click it again until the
  // section is the one shown.
  await page.waitForFunction(() => {
    if (document.getElementById("cvRunA") && document.querySelectorAll("#cv-runs .cv-tile").length === 4) return true;
    const t = document.querySelector('.cv-tab[data-section="cv-runs"]');
    if (t && t.getAttribute("aria-selected") !== "true") t.click();
    return false;
  }, null, { timeout: 20000, polling: 500 }).catch(() => {});
  const tabUi = await page.evaluate(() => ({ a: !!document.getElementById("cvRunA"), b: !!document.getElementById("cvRunB"), tiles: document.querySelectorAll("#cv-runs .cv-tile").length, rows: document.querySelectorAll("#cv-runs .cv-runrows .cv-tr:not(.cv-th)").length }));
  check("the Run vs run tab: two run pickers, the summary and the prompts", tabUi.a && tabUi.b && tabUi.tiles === 4, JSON.stringify(tabUi));

  console.log("\na second campaign waits its turn");
  const start = await ask({ type: "geo-run-start", profileId: seeded.profileId, skipAuthCheck: true });
  check("the first campaign starts", start && start.ok && !start.queued, JSON.stringify(start).slice(0, 200));
  const q = await ask({ type: "geo-run-start", profileId: seeded.second, skipAuthCheck: true });
  check("the second is queued, not refused", q && q.ok && q.queued && q.position === 1, JSON.stringify(q));
  const again = await ask({ type: "geo-run-start", profileId: seeded.profileId });
  check("the one running can't be queued behind itself", again && !again.ok, JSON.stringify(again));
  const list = await ask({ type: "run-queue" });
  check("the queue lists it", list.queue.length === 1 && list.queue[0].profileId === seeded.second && list.runningProfileId === seeded.profileId);
  await ask({ type: "loader-stop" });
  let st = null;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); st = await ask({ type: "loader-status" }); if (st.running && st.profileId === seeded.second) break; }
  check("stopping the first starts the second by itself", st && st.running && st.profileId === seeded.second, JSON.stringify(st && { running: st.running, profileId: st.profileId }));
  check("and the queue is empty", (await ask({ type: "run-queue" })).queue.length === 0);
  await ask({ type: "loader-stop" });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
