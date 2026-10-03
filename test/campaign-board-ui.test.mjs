/*
 * campaign-board-ui.test.mjs — a campaign's results as one board (0.50.0).
 *
 * Asked for: "the campaign dashboards have not accounted for all the section
 * which are currently visible in the tool", and "across multiple layout i see
 * white spaces/blank space". Until 0.49.0 a campaign's results were a metrics
 * card and a prompt table; what the rest of the tool shows about an answer —
 * the kind of answer, product cards, the searches the engines ran, which
 * sites cite rivals — had no place in it. The board puts each of those in its
 * own section, scoped by run, engine, tag and brand.
 *
 * test/campaign-board.test.mjs pins the arithmetic; this checks what is on
 * screen, in the full tab and in the popup, against a campaign seeded from the
 * test fixtures: an own brand, two typed competitors, tagged prompts and two
 * runs. campaign-drilldown.test.mjs covers inferred competitors, the brand
 * picker, the brand detail and the source drill-downs.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-board-test";

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
  console.log("\ncampaign-board-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported layout, so it fails rather than skips. Reason: ${err.message}`);
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
  await put("profiles", { id: profileId, name: "Board Test", brand: { name: own, url: own.toLowerCase().replace(/\W+/g, "") + ".com" },
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
    console.log(`\ncampaign-board-ui: CANNOT RUN — ${seeded.error}`);
    process.exit(1);
  }
  console.log(`\nseeded: ${seeded.answers} answers to ${seeded.prompts} prompts, two runs; own brand "${seeded.own}", competitors ${seeded.competitors.join(", ")}`);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2500);
  const settle = (ms = 1600) => page.waitForTimeout(ms);
  const header = () => page.evaluate(() => document.querySelector("#campaignResults .cb-head .card-header .muted")?.textContent || "");

  console.log("\nthe board, in the full tab");
  check("the campaign's results are a board under the campaign",
    await page.evaluate(() => !!document.querySelector("#loader #campaignResults #cb-kpis")));
  {
    const ids = await page.evaluate(() => [...document.querySelectorAll("#campaignResults section[id]")].map((s) => s.id));
    const want = ["cb-kpis", "cb-kinds", "cb-products", "cb-brands", "cb-source", "cb-by-engine", "cb-collected", "cb-runs", "cb-heat",
      "cb-topics", "cb-recommend", "cb-sitekinds", "cb-gaps", "cb-searches", "cb-prompts", "cb-sources"];
    const missing = want.filter((x) => !ids.includes(x));
    check("every section has a place on it", missing.length === 0, `missing: ${missing.join(", ") || "none"}`);
    const nav = await page.evaluate(() => [...document.querySelectorAll("#campaignResults .cb-nav-btn")].map((b) => b.textContent));
    check("with links to jump between them", nav.length >= 5, nav.join(" | "));
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check("and nothing on it widens the page", overflow <= 0, `${overflow}px wider than the window`);
  }

  console.log("\none run at a time, compared with the one before");
  {
    const runs = await page.evaluate(() => [...document.querySelectorAll("#cbRun option")].map((o) => o.textContent));
    check("the run picker lists both runs and all runs combined",
      runs.length === 3 && /^Run 2 .*\(latest\)$/.test(runs[0]) && /^Run 1 /.test(runs[1]) && runs[2] === "All runs combined", runs.join(" | "));
    check("it starts on the latest run, compared with the one before", /Run 2 · compared with run 1/.test(await header()), await header());
    const deltas = await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .k-delta")].map((d) => d.textContent));
    check("each headline number says how it moved since run 1", deltas.length > 0 && deltas.every((d) => /run 1/.test(d)), deltas.join(" | "));
    // Run 1 named the own brand nowhere; run 2 is the fixtures as captured.
    check("and the run where it appeared reads as a rise", deltas.some((d) => /^▲/.test(d)), deltas.join(" | "));

    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = s.options[1].value; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    check("picking run 1 shows run 1", /Run 1/.test(await header()) && !/compared with/.test(await header()), await header());
    check("which has nothing before it to compare with", await page.evaluate(() => document.querySelectorAll("#cb-kpis .k-delta").length === 0));

    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = "all"; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    check("all runs combined counts both runs' answers", (await header()).startsWith(`${seeded.answers * 2} answers`), await header());

    // The run history above the board (a set-up campaign's run card) points
    // it at a run; newest first, so the last row is run 1.
    await page.evaluate(() => [...document.querySelectorAll("#loader .loader-history-row")].pop()?.click());
    await settle(2000);
    check("a run in the run history opens the board on that run",
      /Run 1/.test(await header()) && await page.evaluate(() => document.getElementById("cbRun")?.selectedIndex === 1), await header());
    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = s.options[0].value; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  }

  console.log("\nscoped by tag");
  {
    const before = await header();
    const tags = await page.evaluate(() => [...document.querySelectorAll('#campaignResults .cb-tags[aria-label="Tags"] .db-chip')].map((c) => c.textContent));
    check("the campaign's tags are filters", ["buying", "tv", "watches"].every((t) => tags.includes(t)), tags.join(", "));
    await page.evaluate(() => [...document.querySelectorAll('#campaignResults .cb-tags[aria-label="Tags"] .db-chip')].find((c) => c.textContent === "watches")?.click());
    await settle();
    const after = await header();
    check("a tag narrows every number to its prompts", after.startsWith("1 answer ") && before !== after, `${before} -> ${after}`);
    const rows = await page.evaluate(() => document.querySelectorAll("#cb-prompts .cb-grid-row:not(:first-child):not(.sub)").length);
    check("including the prompt grid", rows === 1, String(rows));
    await page.evaluate(() => [...document.querySelectorAll('#campaignResults .cb-tags[aria-label="Tags"] .linkbtn')].find((c) => c.textContent === "Clear")?.click());
    await settle();
    check("and clearing it puts them back", (await header()) === before, await header());
  }

  console.log("\nwhat kind of answer each prompt got");
  {
    const kinds = await page.evaluate(() => [...document.querySelectorAll("#cb-kinds .cb-tr:not(.cb-th)")].map((r) => [...r.children].map((c) => c.textContent.trim())));
    check("one row per kind of answer, and the total",
      kinds.map((r) => r[0]).join("|") === "Shopping|Informational|Image-led|From memory|Local|All answers", kinds.map((r) => r[0]).join(" | "));
    const total = kinds.find((r) => r[0] === "All answers");
    check("the total is every answer in the run", total && Number(total[1]) === seeded.answers, total && total[1]);
    check("and the kinds add up to it", total && kinds.slice(0, -1).reduce((a, r) => a + Number(r[1]), 0) === Number(total[1]),
      kinds.map((r) => `${r[0]}=${r[1]}`).join(", "));
    const cards = await page.evaluate(() => document.querySelectorAll("#cb-products .cb-prod-table .cb-tr:not(.cb-th)").length);
    check("product cards from the shopping answers are listed", cards > 0, String(cards));
  }

  console.log("\nprompt by prompt");
  {
    const grid = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#cb-prompts .cb-grid-row:not(:first-child):not(.sub)")];
      return {
        heads: document.querySelectorAll('#cb-prompts .cb-grid-row:first-child .ap-sr').length,
        rows: rows.map((r) => ({ text: r.querySelector(".cb-ptitle")?.textContent || "", cells: r.querySelectorAll(".cb-pos").length })),
      };
    });
    check("one row per tracked prompt", grid.rows.length === seeded.prompts, grid.rows.map((r) => r.text).join(" | "));
    check("with a cell for each of the campaign's engines", grid.heads === 2 && grid.rows.every((r) => r.cells === 2), JSON.stringify(grid));
    await page.evaluate(() => document.querySelector("#cb-prompts .cb-grid-row .linkbtn")?.click());
    await settle(1200);
    const sub = await page.evaluate(() => [...document.querySelectorAll("#cb-prompts .cb-grid-row.sub")].map((r) => r.textContent));
    check("a prompt's earlier runs open under it", sub.length === 1 && /Run 1/.test(sub[0]), sub.join(" | "));
    const opened = await page.evaluate(async () => {
      const b = document.querySelector("#cb-prompts .cb-grid-row:not(.sub) button.cb-pos");
      if (!b) return null;
      b.click();
      await new Promise((r) => setTimeout(r, 1800));
      const a = document.getElementById("analyze");
      return { active: a.classList.contains("active"), len: a.innerText.trim().length };
    });
    check("a cell opens that engine's answer in Analyze", opened && opened.active && opened.len > 200, JSON.stringify(opened));
  }

  console.log("\nthe board in the popup");
  {
    await page.setViewportSize({ width: 540, height: 600 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await page.waitForTimeout(2500);
    check("the board renders in the popup", await page.evaluate(() => document.body.classList.contains("popup") && !!document.getElementById("cb-kpis")));
    const wide = await page.evaluate(() => { const c = document.querySelector(".app-content"); return c.scrollWidth - c.clientWidth; });
    check("nothing on it widens the popup", wide <= 0, `${wide}px`);
    // Two engines leave the prompt room, so the grid needn't scroll sideways.
    const gridScroll = await page.evaluate(() => { const s = document.querySelector("#cb-prompts .cb-scroll"); return s ? s.scrollWidth - s.clientWidth : null; });
    check("the prompt grid fits without scrolling sideways", gridScroll !== null && gridScroll <= 1, `${gridScroll}px`);

    // Reported in the screenshots for this release: after a section link, the
    // popup's frame itself had scrolled — the header slid over the content and
    // the footer floated mid-popup over an empty band. The frame is overflow:
    // hidden, which is still a scroll container that scrollIntoView() moves.
    await page.evaluate(() => [...document.querySelectorAll(".cb-nav-btn")].find((b) => b.textContent === "Prompts")?.click());
    // The jump is a smooth scroll; on a slow runner it was still moving after
    // a fixed 1.5s (CI measured the section 332px down). Wait until it stops.
    await page.evaluate(() => new Promise((resolve) => {
      const c = document.querySelector(".app-content");
      let last = -1, still = 0;
      const tick = () => {
        if (c.scrollTop === last) still++; else { still = 0; last = c.scrollTop; }
        if (still >= 5) resolve(); else setTimeout(tick, 100);
      };
      setTimeout(tick, 200);
      setTimeout(resolve, 10000);
    }));
    const g = await page.evaluate(() => {
      const w = document.querySelector(".app-wrapper"), c = document.querySelector(".app-content"), f = document.querySelector(".credit-footer");
      const wr = w.getBoundingClientRect(), cr = c.getBoundingClientRect(), fr = f.getBoundingClientRect(), pr = document.getElementById("cb-prompts").getBoundingClientRect();
      return { frame: w.scrollTop, content: c.scrollTop, gap: Math.round(wr.bottom - fr.bottom), promptsTop: Math.round(pr.top - cr.top) };
    });
    check("a section link scrolls the content", g.content > 0, JSON.stringify(g));
    check("and not the popup's frame", g.frame === 0, JSON.stringify(g));
    check("so the footer stays at the bottom", Math.abs(g.gap) <= 2, JSON.stringify(g));
    check("and the section lands at the top of the content", g.promptsTop >= -2 && g.promptsTop < 40, JSON.stringify(g));
  }

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
