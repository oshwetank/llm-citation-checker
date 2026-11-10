/*
 * campaign-share-ui.test.mjs — share a campaign as a file and open it on
 * another computer (0.82.0).
 *
 * Asked: "transfer a campaign to another person who can then run it on their
 * own system". Browser A seeds a campaign from fixture answers (made-up
 * brands), shares it from ⋯ → Share campaign… as a .cito file; browser B, a
 * fresh profile, imports the file from Campaigns → Import… and gets the same
 * board, and can run it. Accounts aren't switched on in this build, which
 * every place that mentions codes must say.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-share-test";

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
  console.log(`\ncampaign-share-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const SEEDS = [["chatgpt-phone-under.txt", "best smartphone under 50000"], ["chatgpt-tv.txt", "best tv to buy"]];

async function open(dir) {
  rmSync(dir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  });
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<body><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button">send</button></body>` }));
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(800);
  const ask = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  await ask({ type: "demo-clear" });
  const requests = [];
  context.on("request", (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url()) && !/chatgpt\.com/.test(r.url())) requests.push(r.url()); });
  return { context, page, ask, requests };
}

const openCampaigns = async (page, name) => {
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForFunction((n) => [...document.querySelectorAll(".geo-switcher .geo-chip")].some((b) => b.textContent.startsWith(n)), name, { timeout: 15000 }).catch(() => {});
  await page.evaluate((n) => { const b = [...document.querySelectorAll(".geo-switcher .geo-chip")].find((x) => x.textContent.startsWith(n)); if (b && !b.classList.contains("active")) b.click(); }, name);
  await page.waitForFunction(() => /answer/.test(document.getElementById("campaignResultsH")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
};

const A = await open(`${BASE}-a`);
let file = null;
let boardA = null;
try {
  for (const [f, prompt] of SEEDS) {
    await A.ask({ type: "raw-conversation", payload: { raw: readFileSync(path.join(FIXDIR, f), "utf8"), reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [prompt] } }] }), pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  }
  // Seeded as one finished run of a campaign, the way a run files them.
  const seeded = await A.page.evaluate(async (texts) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const st = (s, m) => db.transaction(s, m).objectStore(s);
    const all = (s) => new Promise((res) => { const r = st(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
    const put = (s, v) => new Promise((res) => { const r = st(s, "readwrite").put(v); r.onsuccess = () => res(); });
    const recs = (await all("derived")).filter((r) => r.userPrompt);
    const counts = new Map();
    recs.forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const profileId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const ids = {};
    for (const t of texts) { ids[t] = crypto.randomUUID(); await put("trackedPrompts", { id: ids[t], profileId, text: t, tags: ["phones"], active: true, createdAt: Date.now() - 1e6 + Object.keys(ids).length }); }
    await put("profiles", { id: profileId, name: "Zento Phones", brand: { name: ranked[0], url: "" }, competitors: ranked.slice(1, 3).map((n) => ({ name: n, url: "" })), engines: ["chatgpt"], locked: true, createdAt: Date.now() - 1e6, lastRunAt: Date.now() - 5e5, deletedAt: null });
    await put("geoRuns", { id: runId, profileId, startedAt: Date.now() - 6e5, finishedAt: Date.now() - 5e5, status: "done", engines: ["chatgpt"], promptIds: Object.values(ids), expected: 2, captured: 2, failed: 0, reasons: {} });
    const raws = await all("raw");
    for (const r of recs) {
      const geo = { profileId, runId, promptId: ids[r.userPrompt], tags: ["phones"] };
      await put("derived", { ...r, geo });
      const raw = raws.find((x) => x.captureId === r.captureId);
      if (raw) await put("raw", { ...raw, geo });
    }
    return { profileId, own: ranked[0] };
  }, SEEDS.map(([, p]) => p));

  console.log("\nsharing, as a file");
  boardA = await A.ask({ type: "campaign-board", profileId: seeded.profileId });
  await openCampaigns(A.page, "Zento Phones");
  await A.page.evaluate(() => document.querySelector(".cp-more")?.click());
  check("⋯ has Share campaign…", await A.page.evaluate(() => !!document.getElementById("cpShareCampaign") && !document.querySelector(".cp-more-menu .cp-menu").hidden));
  await A.page.evaluate(() => document.getElementById("cpShareCampaign").click());
  await A.page.waitForSelector("#share-modal-backdrop #shFile", { timeout: 5000 });
  await A.page.waitForFunction(() => /aren't switched on/.test(document.getElementById("shCodeBox")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("by code: says accounts aren't switched on yet", await A.page.evaluate(() => /aren't switched on/.test(document.getElementById("shCodeBox").textContent)));
  const dl = A.page.waitForEvent("download", { timeout: 15000 });
  await A.page.click("#shFile");
  const d = await dl;
  file = path.join(path.dirname(BASE), `share-test-${process.pid}.cito`);
  await d.saveAs(file);
  const bytes = readFileSync(file);
  check("a .cito file named after the campaign", /^Zento-Phones-\d{4}-\d\d-\d\d\.cito$/.test(d.suggestedFilename()), d.suggestedFilename());
  check("gzipped", bytes[0] === 0x1f && bytes[1] === 0x8b);
  await A.page.waitForFunction(() => /Saved .*2 prompts, 1 run, 2 answers/.test(document.getElementById("shStatus")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("and says what's in it", await A.page.evaluate(() => /Saved .*2 prompts, 1 run, 2 answers/.test(document.getElementById("shStatus").textContent)), await A.page.evaluate(() => document.getElementById("shStatus").textContent));
  check("nothing left the computer", A.requests.length === 0, A.requests.join(", "));

  console.log("\nimporting on the same computer");
  const again = await A.ask({ type: "campaign-bundle-import", data: bytes.toString("base64") });
  check("a second copy, named so it's told apart", again.ok && again.name === "Zento Phones (shared)" && again.profileId !== seeded.profileId, JSON.stringify(again));
  const origin = await A.ask({ type: "campaign-board", profileId: seeded.profileId });
  check("the original is untouched", origin.answers === boardA.answers);
} finally {
  await A.context.close();
}

console.log("\nopening it on another computer");
const B = await open(`${BASE}-b`);
try {
  await B.page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await B.page.waitForSelector("#cpImportFirst", { timeout: 10000 }).catch(() => {});
  check("with no campaign yet, Import is offered beside Create", await B.page.evaluate(() => /Import a shared campaign/.test(document.getElementById("cpImportFirst")?.textContent || "")));
  await B.ask({ type: "geo-profile-save", profile: { name: "Mine", brand: { name: "Kovo", url: "" }, engines: ["chatgpt"] } });
  await B.page.evaluate(() => document.querySelector('[data-tab="analyze"]')?.click());
  await B.page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await B.page.waitForSelector("#cpImport", { timeout: 10000 }).catch(() => {});
  check("Campaigns has Import…", await B.page.evaluate(() => !!document.getElementById("cpImport")));
  await B.page.evaluate(() => document.getElementById("cpImport")?.click());
  await B.page.waitForSelector("#import-modal-backdrop #imFile", { timeout: 5000 });
  await B.page.setInputFiles("#imFile", file);
  await B.page.waitForFunction(() => !document.getElementById("import-modal-backdrop"), null, { timeout: 10000 }).catch(() => {});
  check("the file opens and the dialog closes", await B.page.evaluate(() => !document.getElementById("import-modal-backdrop")), await B.page.evaluate(() => document.getElementById("imStatus")?.textContent));
  await B.page.waitForFunction(() => document.getElementById("cpName")?.textContent === "Zento Phones", null, { timeout: 10000 }).catch(() => {});
  check("and it's the campaign on screen", await B.page.evaluate(() => document.getElementById("cpName")?.textContent), "Zento Phones");
  const list = await B.ask({ type: "geo-profile-list" });
  const imported = (list.profiles || []).find((p) => p.name === "Zento Phones");
  check("beside the campaign already there", imported && list.profiles.some((p) => p.name === "Mine"));
  check("says where it came from", imported && imported.importedFrom && imported.importedFrom.name === "Zento Phones");
  const boardB = await B.ask({ type: "campaign-board", profileId: imported.id });
  check("the same answers", boardB.ok && boardB.answers === boardA.answers, `${boardB.answers} vs ${boardA.answers}`);
  const sov = (b) => JSON.stringify((b.view && b.view.overview && b.view.overview.kpis || []).map((k) => [k.id, k.value]));
  check("the same numbers on the board", sov(boardA).length > 20 && sov(boardB) === sov(boardA), `${sov(boardB)} vs ${sov(boardA)}`);
  const prompts = await B.ask({ type: "geo-prompt-list", profileId: imported.id });
  check("its prompts, with their tags", prompts.prompts.length === 2 && prompts.prompts.every((p) => p.tags[0] === "phones"));
  const raws = await B.page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); });
    return new Promise((res) => { const r = db.transaction("raw").objectStore("raw").getAll(); r.onsuccess = () => res(r.result.filter((x) => x.geo && x.geo.profileId).length); });
  });
  check("with the raw captures, so Reprocess works there too", raws === 2, raws);
  const run = await B.ask({ type: "geo-run-start", profileId: imported.id, skipAuthCheck: true });
  check("and it can be run there", run && run.ok, JSON.stringify(run).slice(0, 200));
  await B.ask({ type: "loader-stop" });

  console.log("\nbad files");
  const junk = await B.ask({ type: "campaign-bundle-import", data: Buffer.from("not a campaign").toString("base64") });
  check("anything else is refused, plainly", !junk.ok && /isn't a CitoSkeleton campaign/.test(junk.error));

  console.log("\nAbout → Account");
  await B.page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
  await B.page.waitForTimeout(300);
  await B.page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Account"))?.click());
  await B.page.waitForSelector("#acOff", { timeout: 5000 }).catch(() => {});
  check("says accounts aren't switched on, and how to share anyway", await B.page.evaluate(() => /aren't switched on yet.*Share campaign/.test(document.getElementById("acOff")?.textContent || "")));
  check("nothing left the computer", B.requests.length === 0, B.requests.join(", "));
} finally {
  await B.context.close();
  if (file) rmSync(file, { force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
