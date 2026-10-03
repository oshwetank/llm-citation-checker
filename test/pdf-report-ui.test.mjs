/*
 * pdf-report-ui.test.mjs — the designed PDF reports (0.53.0).
 *
 * Release 6b of the canvas redesign. Until 0.52.0 a PDF was the conversation
 * printed as it was (ui/export.html) and a campaign had no PDF at all. Now
 * the export dialog has a PDF report for one run of a campaign, and
 * Analyze's "Save as PDF" opens a two-page report on the answer. Both are
 * A4 pages laid out by ui/report.html; the browser's print dialog saves
 * them ("Save as PDF").
 *
 * Seeded from the test fixtures, plus forty tracked prompts the runs never
 * reached, so the Prompts page's table is longer than a page and the
 * report has to carry it over. Checks every page fits its A4 box, the
 * pages are numbered, Chrome's own PDF has one page per report page, the
 * fonts are the bundled ones and nothing is fetched from the network.
 * test/pdf-report.test.mjs checks the numbers.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-pdf-report-test";

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
  console.log("\npdf-report-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the PDF reports, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
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
  await put("profiles", { id: profileId, name: "Report Test", brand: { name: own, url: own.toLowerCase().replace(/\W+/g, "") + ".com" },
    competitors: competitors.map((n) => ({ name: n, url: "" })), engines: ["chatgpt", "gemini"], locked: true,
    createdAt: Date.now() - 9e8, lastRunAt: Date.now(), deletedAt: null });
  const prompts = new Map();
  for (const [, , text, tags] of seeds) {
    if (prompts.has(text)) continue;
    const id = crypto.randomUUID();
    prompts.set(text, id);
    await put("trackedPrompts", { id, profileId, text, tags, active: true, createdAt: Date.now() - 9e8 + prompts.size });
  }
  // Forty more prompts the runs never reached: the Prompts page lists every
  // tracked prompt, so its table runs past one A4 page and has to split.
  for (let i = 0; i < 40; i++) {
    const id = crypto.randomUUID();
    await put("trackedPrompts", { id, profileId, text: `long tail prompt ${i + 1}: which one should I pick for a small flat with thin walls and a tight budget`, tags: ["tail"], active: true, createdAt: Date.now() - 8e8 + i });
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
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
// The print dialog would block a headless page; record that it was asked for.
await context.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });

/* One report page's state, as a reader would check it. */
const inspect = (page) => page.evaluate(() => {
  const pages = [...document.querySelectorAll(".page")];
  const text = pages.map((p) => p.innerText).join("\n");
  return {
    count: pages.length,
    over: pages.map((p) => p.scrollHeight - p.clientHeight).filter((x) => x > 1),
    numbers: pages.map((p) => p.querySelector(".pg")?.textContent),
    eyebrows: pages.map((p) => p.querySelector(".eyebrow")?.textContent || ""),
    dupes: pages.filter((p) => { const ids = [...p.querySelectorAll(":scope > .blk")].map((b) => b.dataset.blk); return new Set(ids).size !== ids.length; }).length,
    junk: (text.match(/\b(undefined|NaN|null|\[object Object\])\b/g) || []).slice(0, 3),
    font: document.fonts.check('600 12px "IBM Plex Sans"'),
    title: document.title, printed: window.__printed || 0,
    h1: document.querySelector("h1")?.textContent || "",
  };
});
async function pdfPages(page) {
  const cdp = await page.context().newCDPSession(page);
  const pdf = await cdp.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true });
  return (Buffer.from(pdf.data, "base64").toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
}

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extId}/ui/panel.html`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
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
    console.log(`\npdf-report-ui: CANNOT RUN — ${seeded.error}`);
    process.exit(1);
  }
  console.log(`\nseeded: ${seeded.answers} answers to ${seeded.prompts} prompts (and 40 never reached), two runs; own brand "${seeded.own}"`);

  const external = [];
  context.on("request", (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) external.push(r.url()); });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2500);

  console.log("\nthe export dialog's PDF report");
  await page.evaluate(() => document.getElementById("cbExport")?.click());
  await page.waitForTimeout(800);
  const hasPdf = await page.evaluate(() => !!document.querySelector('.ex-format[data-format="pdf"]'));
  check("the export dialog offers a PDF report", hasPdf);
  if (!hasPdf) throw new Error("no PDF format in the export dialog");
  await page.evaluate(() => document.querySelector('.ex-format[data-format="pdf"]').click());
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => ({
    runs: [...document.querySelectorAll(".ex-choices .ex-seg-btn")].map((b) => `${b.textContent}${b.classList.contains("on") ? " *" : ""}`),
    pages: [...document.querySelectorAll(".ex-table[data-page]")].map((b) => b.dataset.page),
    file: document.querySelector(".ex-file")?.textContent, go: document.getElementById("ex-go")?.textContent,
  }));
  check("it reports on one run, the latest picked", d.runs.length === 2 && /^Run 2 .*\(latest\) \*$/.test(d.runs[0]) && /^Run 1 /.test(d.runs[1]), d.runs.join(" | "));
  check("with the seven pages to choose from", d.pages.join(",") === "summary,brands,prompts,sources,products,searches,actions", d.pages.join(","));
  check("and a file named after the campaign and the run", d.file === "citoskeleton-report-test-run2.pdf" && d.go === "Open PDF report", `${d.file} · ${d.go}`);
  await page.evaluate(() => document.querySelector('.ex-table[data-page="searches"]').click());
  const [rep] = await Promise.all([context.waitForEvent("page"), page.evaluate(() => document.getElementById("ex-go").click())]);
  await rep.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  await rep.waitForTimeout(600);
  const url = new URL(rep.url());
  check("Open PDF report opens the report in a tab", url.pathname.endsWith("/ui/report.html") && url.searchParams.get("kind") === "campaign" && !url.searchParams.get("sections").includes("searches"), rep.url());
  let r = await inspect(rep);
  check("and opens the print dialog once it is laid out", r.printed === 1, `print called ${r.printed} times`);
  check("Save as PDF suggests the same file name", r.title === "citoskeleton-report-test-run2", r.title);
  check("the pages left in, and not the one left out", ["Brands", "Prompts", "Sources", "Kinds of answer and products", "Actions and method"].every((e) => r.eyebrows.some((x) => x.toLowerCase().startsWith(e.toLowerCase()))) && !r.eyebrows.some((x) => /engine searches/i.test(x)), r.eyebrows.join(" | "));
  check("the long prompt table carries over onto a continuation page", r.eyebrows.some((x) => /^prompts.*continued/i.test(x)), r.eyebrows.join(" | "));
  {
    // The prompt-by-prompt table is the one headed "ID".
    const rows = await rep.evaluate(() => [...document.querySelectorAll(".page")].filter((p) => /^prompts/i.test(p.querySelector(".eyebrow")?.textContent || ""))
      .reduce((a, p) => a + [...p.querySelectorAll("table")].filter((t) => t.querySelector("thead th")?.textContent === "ID").reduce((n, t) => n + t.tBodies[0].rows.length, 0), 0));
    check("with every prompt on it once, across the pages", rows === seeded.prompts + 40, `${rows} rows, ${seeded.prompts + 40} prompts`);
  }
  check("every page fits its A4 page", r.over.length === 0, JSON.stringify(r.over));
  check("no table appears twice on one page", r.dupes === 0, `${r.dupes} pages`);
  check("pages are numbered 1 to N", r.numbers.every((x, i) => x === `${i + 1} / ${r.count}`), r.numbers.join(", "));
  check("nothing reads undefined, NaN or null", r.junk.length === 0, r.junk.join(", "));
  check("the bundled typeface is loaded", r.font === true);
  check(`Chrome's PDF has one page per report page (${r.count})`, (await pdfPages(rep)) === r.count);
  check("the campaign is named on the first page", r.h1 === "Report Test", r.h1);
  await rep.close();

  console.log("\nAnalyze's Save as PDF");
  const capId = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "get-records" }, (x) => r(((x && x.records) || []).find((y) => y.platform === "chatgpt" && y.geo)?.captureId))));
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(capId)}`);
  const hasBtn = await page.waitForFunction(() => [...document.querySelectorAll(".at-btn")].some((b) => b.textContent === "Save as PDF"), null, { timeout: 15000 }).then(() => true, () => false);
  check("Analyze has Save as PDF", hasBtn);
  const [ans] = await Promise.all([context.waitForEvent("page"), page.evaluate(() => [...document.querySelectorAll(".at-btn")].find((b) => b.textContent === "Save as PDF").click())]);
  await ans.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  await ans.waitForTimeout(600);
  r = await inspect(ans);
  check("it opens the answer's report and the print dialog", new URL(ans.url()).searchParams.get("kind") === "answer" && r.printed === 1, ans.url());
  check("headed with the engine, and the prompt as its title", /^Answer report · (ChatGPT|Gemini)/.test(r.eyebrows[0]) && r.h1.length > 3, `${r.eyebrows[0]} · ${r.h1}`);
  const a = await ans.evaluate(() => ({ marks: document.querySelectorAll(".answer mark").length, text: (document.querySelector(".answer")?.innerText || "").length, cites: document.querySelectorAll(".answer .cite").length }));
  check("the answer as the engine showed it, brands marked", a.text > 200 && a.marks > 0, JSON.stringify(a));
  check("every page fits, numbered, no junk", r.over.length === 0 && r.numbers.every((x, i) => x === `${i + 1} / ${r.count}`) && r.junk.length === 0, JSON.stringify({ over: r.over, numbers: r.numbers, junk: r.junk }));
  // A table carried over must stay one table on the next page: before the
  // paginator folded a moved block back into its continuation, the list of
  // pages opened came out as two "(continued)" tables on one page.
  check("a carried-over table stays one table on the next page", r.dupes === 0, `${r.dupes} page(s) with the same table twice`);
  check(`Chrome's PDF has one page per report page (${r.count})`, (await pdfPages(ans)) === r.count);
  await ans.close();

  console.log("\nprivacy");
  check("nothing was fetched from the network", external.length === 0, external.slice(0, 3).join(" | "));
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} catch (err) {
  failures++;
  console.log(`  ✗ stopped: ${err.message}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
