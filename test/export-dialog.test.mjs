/*
 * export-dialog.test.mjs — exporting a campaign (0.52.0).
 *
 * Release 6 of the canvas redesign: the board's Export… opens one dialog for
 * every way out of a campaign. Until 0.51.0 the board had a single button
 * that saved a chart-less SpreadsheetML .xls of everything. Now the dialog
 * picks a format (an .xlsx workbook with charts and live formulas, or CSV
 * tables), which runs and engines, and which tables to include, and says
 * what the file will hold, with row counts, before it is built.
 *
 * This drives the dialog in the full tab and the popup against a campaign
 * seeded from the test fixtures, downloads both formats and opens what was
 * saved. test/campaign-xlsx.test.mjs checks the workbook's numbers.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseXlsx } from "../src/lib/xlsxLite.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-export-dialog-test";

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
  console.log("\nexport-dialog: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the campaign export, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

/* The file names inside a zip, from its central directory. */
function zipNames(buf) {
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const len = buf.readUInt16LE(i + 28);
    names.push(buf.toString("utf8", i + 46, i + 46 + len));
    i += 45 + len;
  }
  return names;
}

// Fixture answers and the prompt each one answers. Two ChatGPT shopping
// answers, one Gemini answer to the same prompt, one ChatGPT answer that is
// tagged on its own.
const SEEDS = [
  ["chatgpt-phone-under.txt", "chatgpt", "best smartphone under 50000", ["buying"]],
  ["gemini-streamgenerate.txt", "gemini", "best smartphone under 50000", ["buying"]],
  ["chatgpt-tv.txt", "chatgpt", "best tv to buy", ["buying", "tv"]],
  ["chatgpt-watches.txt", "chatgpt", "new trending watch", ["watches"]],
];

/* Runs in the panel page: turns the stored captures into a campaign with two
 * runs. Run 1 is the same answers with the own brand taken out, so the two
 * runs differ and the board has a change to report. */
const SEED_CAMPAIGN = async (seeds) => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await open();
  const tx = (s, m) => db.transaction(s, m).objectStore(s);
  const all = (s) => new Promise((res) => { const r = tx(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
  const put = (s, v) => new Promise((res) => { const r = tx(s, "readwrite").put(v); r.onsuccess = () => res(); });
  const derived = (await all("derived")).filter((r) => r.userPrompt);
  if (!derived.length) return { error: "no captures were stored" };
  const counts = new Map();
  derived.forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  if (ranked.length < 3) return { error: `only ${ranked.length} brands in the captures` };
  const own = ranked[1];
  const competitors = ranked.filter((n) => n !== own).slice(0, 2);
  const profileId = crypto.randomUUID();
  await put("profiles", { id: profileId, name: "Export Test", brand: { name: own, url: own.toLowerCase().replace(/\W+/g, "") + ".com" },
    competitors: competitors.map((n) => ({ name: n, url: "" })), engines: ["chatgpt", "gemini"], locked: true,
    createdAt: Date.now() - 9e8, lastRunAt: Date.now(), deletedAt: null });
  const prompts = new Map();
  for (const [, , text, tags] of seeds) {
    if (prompts.has(text)) continue;
    const id = crypto.randomUUID();
    prompts.set(text, id);
    await put("trackedPrompts", { id, profileId, text, tags, active: true, createdAt: Date.now() - 9e8 + prompts.size });
  }
  const r1 = crypto.randomUUID(), r2 = crypto.randomUUID();
  const t1 = Date.now() - 7 * 864e5, t2 = Date.now() - 3600e3;
  for (const [id, t] of [[r1, t1], [r2, t2]]) {
    await put("geoRuns", { id, profileId, startedAt: t, finishedAt: t + 6e5, status: "done", engines: ["chatgpt", "gemini"],
      promptIds: [...prompts.values()], expected: 6, captured: derived.length, failed: 0, reasons: {} });
  }
  for (const rec of derived) {
    const promptId = prompts.get(rec.userPrompt);
    const tags = (seeds.find((s) => s[2] === rec.userPrompt) || [])[3] || [];
    await put("derived", { ...rec, capturedAt: t2 + 1000, geo: { profileId, runId: r2, promptId, tags } });
    await put("derived", { ...rec, captureId: `${rec.captureId}-r1`, capturedAt: t1 + 1000,
      brandMentions: (rec.brandMentions || []).filter((m) => m.brand !== own), geo: { profileId, runId: r1, promptId, tags } });
  }
  return { own, competitors, answers: derived.length, prompts: prompts.size };
};

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extId}/ui/panel.html`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
  // The sample answers a fresh install shows are not part of this campaign.
  await seedPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "demo-clear" }, r)));
  const gpt = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
  const gem = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);
  for (const [file, engine, prompt] of SEEDS) {
    const raw = readFileSync(path.join(FIXDIR, file), "utf8");
    await seedPage.evaluate(({ raw, reqBody, pageUrl }) => new Promise((res) =>
      chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody, pageUrl, capturedAt: Date.now() } }, res)),
    { raw, reqBody: engine === "gemini" ? gem(prompt) : gpt(prompt), pageUrl: engine === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/" });
    await seedPage.waitForTimeout(100);
  }
  const seeded = await seedPage.evaluate(SEED_CAMPAIGN, SEEDS);
  await seedPage.close();
  if (seeded.error) {
    console.log(`\nexport-dialog: CANNOT RUN — ${seeded.error}`);
    process.exit(1);
  }
  const perRun = seeded.answers;
  const gptPerRun = SEEDS.filter((s) => s[1] === "chatgpt").length;
  console.log(`\nseeded: ${perRun} answers to ${seeded.prompts} prompts, two runs; own brand "${seeded.own}"`);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2500);

  // The dialog's state, as a reader sees it.
  const look = () => page.evaluate(() => {
    const m = document.querySelector("#export-modal-backdrop .ex-modal");
    if (!m) return null;
    const rows = Object.fromEntries([...m.querySelectorAll(".ex-table")].map((b) => [b.dataset.table, b.querySelector(".ex-rows").textContent]));
    const list = (sel) => [...m.querySelectorAll(sel)].map((li) => li.querySelector("b").textContent);
    return {
      format: m.querySelector(".ex-format.on")?.dataset.format,
      rows, summaries: list(".ex-list:not(.raw) li"), raws: list(".ex-list.raw li"), csv: list(".ex-csv li"),
      get: m.querySelector(".ex-get-sum")?.textContent, file: m.querySelector(".ex-file")?.textContent, meta: m.querySelector(".ex-file-box .muted")?.textContent,
      go: m.querySelector("#ex-go")?.textContent, done: m.querySelector(".ex-done:not([hidden])")?.textContent || "",
      engines: [...m.querySelectorAll(".ex-chip")].map((b) => `${b.dataset.engine}:${b.getAttribute("aria-pressed")}`),
    };
  });
  const counted = () => page.waitForFunction(() => {
    const r = document.querySelector('#export-modal-backdrop .ex-table[data-table="answers"] .ex-rows');
    return r && !r.textContent.includes("…");
  }, null, { timeout: 15000 });
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
  const seg = (text) => page.evaluate((t) => [...document.querySelectorAll("#export-modal-backdrop .ex-seg-btn")].find((b) => b.textContent === t).click(), text);

  console.log("\nthe board opens the export dialog");
  const hasExport = await page.evaluate(() => document.getElementById("cbExport")?.textContent === "Export…");
  check("the campaign board has an Export… button", hasExport);
  if (!hasExport) throw new Error("no Export… button to open the dialog from");
  await click("#cbExport");
  await counted();
  let s = await look();
  check("it opens the dialog on the Excel workbook", s && s.format === "xlsx" && s.go === "Export workbook", JSON.stringify(s && { format: s.format, go: s.go }));
  check("with both runs counted: answers", s.rows.answers === `${perRun * 2} rows`, s.rows.answers);
  check("answers and brand mentions can't be left out", await page.evaluate(() => ["answers", "mentions"].every((t) => document.querySelector(`.ex-table[data-table="${t}"]`).getAttribute("aria-disabled") === "true")));
  check("what you get: every summary sheet and raw table", s.get === "11 summaries · 8 raw tables" && s.summaries.includes("Trends") && s.summaries.includes("Run over run"), `${s.get} · ${s.summaries.join(", ")}`);
  check("the file is named after the campaign and the day", /^citoskeleton-export-test-\d{4}-\d{2}-\d{2}\.xlsx$/.test(s.file), s.file);
  check("and the footer adds up the sheets", /^19 sheets · [\d,]+ rows · opens in Excel/.test(s.meta), s.meta);
  {
    const g = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const f = r(".ex-formats"), c = r(".ex-choices"), w = r(".ex-get");
      return { threeAcross: f.right <= c.left + 1 && c.right <= w.left + 1 && Math.abs(f.top - w.top) < 2 };
    });
    check("in the tab: format, options and what you get side by side", g.threeAcross, JSON.stringify(g));
  }

  console.log("\nthe choices change what you get");
  await seg("Latest run only");
  await counted();
  s = await look();
  check("latest run only: one run's answers", s.rows.answers === `${perRun} rows`, s.rows.answers);
  check("and the sheets that compare runs drop out", !s.summaries.includes("Trends") && !s.summaries.includes("Run over run"), s.summaries.join(", "));
  await click('.ex-chip[data-engine="gemini"]');
  await counted();
  s = await look();
  check("Gemini off: only ChatGPT's answers", s.rows.answers === `${gptPerRun} rows` && s.engines.includes("gemini:false"), `${s.rows.answers} · ${s.engines}`);
  await click('.ex-chip[data-engine="chatgpt"]');
  await page.waitForTimeout(300);
  s = await look();
  check("the last engine stays on", s.engines.includes("chatgpt:true"), s.engines.join(" "));
  await click('.ex-table[data-table="pages"]');
  s = await look();
  check("pages left out: its sheets go from the list", s.rows.pages === "left out" && !s.summaries.includes("Sources") && !s.raws.includes("Sources data"), `${s.rows.pages} · ${s.raws.join(", ")}`);

  console.log("\nexport the workbook");
  {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), click("#ex-go")]);
    const file = await dl.path();
    const buf = readFileSync(file);
    check("a .xlsx is saved under the name shown", dl.suggestedFilename() === s.file, dl.suggestedFilename());
    const names = zipNames(buf);
    check("it is a workbook package", names.includes("[Content_Types].xml") && names.includes("xl/workbook.xml") && names.includes("xl/styles.xml"), names.slice(0, 6).join(", "));
    const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length;
    check("one worksheet per sheet listed (no Trends, Run over run, Sources or Sources data)", sheets === s.summaries.length + s.raws.length, `${sheets} worksheets, ${s.summaries.length + s.raws.length} listed`);
    check("with charts", names.some((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)));
    const rows = await parseXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    check("it opens, and its first sheet names the campaign", rows.flat().some((v) => String(v).includes("Export Test")), JSON.stringify(rows.slice(0, 2)));
    await page.waitForTimeout(300);
    s = await look();
    check("the dialog says it was exported", /Exported/.test(s.done), s.done);
  }

  console.log("\nexport CSV tables");
  await click('.ex-format[data-format="csv"]');
  s = await look();
  check("CSV lists one file per table left in", s.go === "Export CSV files" && s.csv.includes("answers.csv") && !s.csv.includes("pages.csv"), `${s.go} · ${s.csv.join(", ")}`);
  check("a new choice clears the exported note", s.done === "", s.done);
  {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), click("#ex-go")]);
    const buf = readFileSync(await dl.path());
    check("a .zip of tables is saved", /-tables\.zip$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const names = zipNames(buf).sort();
    check("holding the files listed and a README", JSON.stringify(names) === JSON.stringify([...s.csv, "README.txt"].sort()), names.join(", "));
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the dialog", await page.evaluate(() => !document.getElementById("export-modal-backdrop")));

  console.log("\nin the popup");
  await page.setViewportSize({ width: 540, height: 600 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2500);
  await click("#cbExport");
  await counted();
  {
    const g = await page.evaluate(() => {
      const body = document.querySelector(".ex-modal .modal-body");
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { wide: body.scrollWidth - body.clientWidth, stacked: r(".ex-formats").bottom <= r(".ex-choices").top + 1 && r(".ex-choices").bottom <= r(".ex-get").top + 1,
        go: (() => { const b = r("#ex-go"); return b.bottom <= window.innerHeight && b.right <= window.innerWidth; })() };
    });
    check("the columns stack", g.stacked, JSON.stringify(g));
    check("nothing is wider than the popup", g.wide <= 0, JSON.stringify(g));
    check("and the Export button is on screen", g.go, JSON.stringify(g));
  }

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} catch (err) {
  failures++;
  console.log(`  ✗ stopped: ${err.message}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
