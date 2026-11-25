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
    // Run 1 doesn't name the own brand at all: out of the brand list AND the
    // text, since mentions are counted from what the answer writes (1.0.3).
    await put("derived", { ...rec, captureId: `${rec.captureId}-r1`, capturedAt: t1 + 1000,
      answerText: String(rec.answerText || "").split(own).join("another option"),
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
  // 1.0.6 (approved review): each fact said once. The board's header says
  // only what the run is compared with; the run is the picker's own label;
  // the answer count is the Overview's heading.
  const header = () => page.evaluate(() => document.querySelector("#cpHead .cp-scope")?.textContent || "");
  const runPicked = () => page.evaluate(() => { const s = document.getElementById("cbRun"); return s?.selectedOptions[0]?.textContent || ""; });
  const counted = () => page.evaluate(() => document.querySelector("#cv-overview .cv-sub")?.textContent || "");
  // 0.67.0: one section at a time, behind a row of tabs.
  const tab = async (id) => { await page.evaluate((id) => document.querySelector(`.cv-tab[data-section="${id}"]`)?.click(), id); await page.waitForTimeout(400); };

  console.log("\nthe board, in the full tab");
  check("the campaign's results are a board under the campaign",
    await page.evaluate(() => !!document.querySelector("#loader #campaignResults #cv-overview")));
  {
    // 0.64.0: the board the owner approved on the canvas, nine sections;
    // 0.67.0: each behind its own tab.
    const want = ["cv-overview", "cv-brands", "cv-compare", "cv-sources", "cv-citations", "cv-prompts", "cv-products", "cv-searches", "cv-signals"];
    const tabs = await page.evaluate(() => [...document.querySelectorAll("#campaignResults .cv-tabs [role=tab]")].map((b) => b.dataset.section));
    const missing = want.filter((x) => !tabs.includes(x));
    check("every section has a tab", missing.length === 0, `missing: ${missing.join(", ") || "none"}`);
    const seen = [];
    for (const id of want) { await tab(id); seen.push(await page.evaluate((id) => document.querySelectorAll("#campaignResults section.cv-sec").length === 1 && !!document.getElementById(id), id)); }
    check("and each tab shows its section, alone", seen.every(Boolean), JSON.stringify(seen));
    await tab("cv-sources");
    check("the sites table with its drill-downs is in Sources", await page.evaluate(() => !!document.querySelector("#cv-sources #cb-sources")));
    await tab("cv-overview");
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check("and nothing on it widens the page", overflow <= 0, `${overflow}px wider than the window`);
  }

  // Reported: "the new layout has not completily and properly been
  // implemented at all." On the canvas a set-up campaign opens on one header
  // card — its name, what it covers, Edit setup / Export… / Run again, and the
  // filters — with the board straight under it. Until 0.54.0 three cards
  // came first (the chooser, a summary, a run card with its run history) and
  // the filters were a fourth, so the board started about a screen down.
  console.log("\nthe campaign's header, as on the canvas");
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const h = await page.evaluate(() => {
      const head = document.getElementById("cpHead");
      const cards = [...document.querySelectorAll("#loader > *")].map((x) => x.id || x.className);
      const btns = head ? [...head.querySelectorAll(".cp-actions button:not(.ho-wrap button):not(.cp-menu button)")].filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent) : [];
      const name = head?.querySelector("h1")?.getBoundingClientRect();
      const acts = head?.querySelector(".cp-actions")?.getBoundingClientRect();
      return {
        first: cards[0], cards,
        name: head?.querySelector("h1")?.textContent || "",
        sub: head?.querySelector(".cp-sub")?.textContent || "",
        btns,
        beside: !!(name && acts) && acts.left > name.right && Math.abs(acts.top - name.top) < 30,
        filters: head ? ["#cbRun", ".cb-engs", ".brand-picker"].every((q) => head.querySelector(`#cpFilters ${q}`)) : false,
        oldCards: !!document.querySelector("#loader .campaign-summary") || [...document.querySelectorAll("#loader .card-header h3")].some((x) => /^(Run|Results)$/.test(x.textContent)),
        kpisTop: Math.round(document.getElementById("cv-overview").getBoundingClientRect().top),
        headNav: [...document.querySelectorAll("#headerPage .cb-nav-btn, #headerPage .cv-tab")].map((x) => x.textContent),
        tabsTop: Math.round(document.querySelector(".cv-tabs").getBoundingClientRect().top),
      };
    });
    check("the page opens on the campaign's own header", h.first === "cpHead", h.cards.join(" > "));
    check("named, with what it covers", h.name === "Board Test" && /\d+ prompts × 2 engines/.test(h.sub) && /last run/.test(h.sub), `${h.name} — ${h.sub}`);
    // 0.80.0: one Run (signed out under its arrow), everything else under ⋯.
    check("Run again, its arrow and ⋯ beside the name", h.btns.join("|") === "Run again|▾|⋯" && h.beside, `${h.btns.join("|")} beside=${h.beside}`);
    const menu = await page.evaluate(() => [...document.querySelectorAll("#cpHead .cp-more-menu .cp-menu button")].map((b) => b.textContent));
    check("⋯ holds Edit setup, Export…, Share campaign… and Delete campaign", menu.join("|") === "Edit setup|Export…|Share campaign…|Delete campaign", menu.join("|"));
    check("the arrow holds Run signed out", await page.evaluate(() => /^Run signed out/.test(document.querySelector("#cpHead .cp-run-menu .cp-menu button")?.textContent || "")));
    // 1.0.7 (live test): ⋯ ignored Escape and stayed open over the arrow's menu.
    const menus = async () => page.evaluate(() => ({ more: !document.querySelector("#cpHead .cp-more-menu .cp-menu").hidden, run: !document.querySelector("#cpHead .cp-run-menu .cp-menu").hidden }));
    await page.click("#cpHead .cp-more");
    const opened = await menus();
    await page.keyboard.press("Escape");
    const escaped = await menus();
    check("⋯ opens, and Escape closes it", opened.more && !escaped.more, JSON.stringify({ opened, escaped }));
    await page.click("#cpHead .cp-more");
    await page.click("#cpHead .cp-caret");
    const swapped = await menus();
    check("opening the arrow's menu closes ⋯: one menu at a time", swapped.run && !swapped.more, JSON.stringify(swapped));
    await page.keyboard.press("Escape");
    check("Pause, Resume and Stop only while a run is going", !h.btns.some((x) => /Pause|Resume|Stop/.test(x)), h.btns.join("|"));
    check("the run, brand and engine filters are in it", h.filters);
    check("no separate summary, run or results card", !h.oldCards);
    check("the board starts right under it", h.kpisTop < 420, `${h.kpisTop}px down`);
    check("the section tabs sit on the board, not in the app bar", h.headNav.length === 0 && h.tabsTop < 400, `${h.headNav.join(" | ")} tabs at ${h.tabsTop}px`);
    await tab("cv-signals");
    const history = await page.evaluate(() => document.querySelectorAll("#cv-signals .loader-history-row").length);
    check("run history sits with the signals and data quality", history === 2, `${history} rows`);
    await tab("cv-overview");
  }

  console.log("\none run at a time, compared with the one before");
  {
    const runs = await page.evaluate(() => [...document.querySelectorAll("#cbRun option")].map((o) => o.textContent));
    check("the run picker lists both runs and all runs combined",
      runs.length === 3 && /^Run 2 .*\(latest\)$/.test(runs[0]) && /^Run 1 /.test(runs[1]) && runs[2] === "All runs combined", runs.join(" | "));
    check("it starts on the latest run, compared with the one before", /^Run 2/.test(await runPicked()) && (await header()) === "Compared with run 1", `${await runPicked()} / ${await header()}`);
    const deltas = await page.evaluate(() => [...document.querySelectorAll("#cv-overview .k-delta")].map((d) => d.textContent));
    check("each headline number says how it moved since run 1", deltas.length > 0 && deltas.every((d) => /run 1/.test(d)), deltas.join(" | "));
    // Run 1 named the own brand nowhere; run 2 is the fixtures as captured.
    check("and the run where it appeared reads as a rise", deltas.some((d) => /^▲/.test(d)), deltas.join(" | "));

    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = s.options[1].value; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    check("picking run 1 shows run 1", /^Run 1/.test(await runPicked()) && (await header()) === "", `${await runPicked()} / ${await header()}`);
    check("which has nothing before it to compare with", await page.evaluate(() => document.querySelectorAll("#cv-overview .k-delta").length === 0));

    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = "all"; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    check("all runs combined counts both runs' answers", (await counted()).startsWith(`${seeded.answers * 2} answers`), await counted());

    // The run history above the board (a set-up campaign's run card) points
    // it at a run; newest first, so the last row is run 1.
    await tab("cv-signals");
    await page.evaluate(() => [...document.querySelectorAll("#loader .loader-history-row")].pop()?.click());
    await settle(2000);
    check("a run in the run history opens the board on that run",
      /^Run 1/.test(await runPicked()) && await page.evaluate(() => document.getElementById("cbRun")?.selectedIndex === 1), await runPicked());
    await page.evaluate(() => { const s = document.getElementById("cbRun"); s.value = s.options[0].value; s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  }

  console.log("\nscoped by tag");
  {
    await tab("cv-overview");
    const before = await counted();
    const tags = await page.evaluate(() => [...document.querySelectorAll('#loader .cb-tags[aria-label="Tags"] .db-chip')].map((c) => c.textContent));
    check("the campaign's tags are filters", ["buying", "tv", "watches"].every((t) => tags.includes(t)), tags.join(", "));
    await page.evaluate(() => [...document.querySelectorAll('#loader .cb-tags[aria-label="Tags"] .db-chip')].find((c) => c.textContent === "watches")?.click());
    await settle();
    const after = await counted();
    check("a tag narrows every number to its prompts", after.startsWith("1 answer from") && before !== after, `${before} -> ${after}`);
    await tab("cv-prompts");
    const rows = await page.evaluate(() => document.querySelectorAll("#cv-prompts .cv-prompts .cv-tr:not(.cv-th)").length);
    check("including the prompt grid", rows === 1, String(rows));
    await page.evaluate(() => [...document.querySelectorAll('#loader .cb-tags[aria-label="Tags"] .linkbtn')].find((c) => c.textContent === "Clear")?.click());
    await settle();
    await tab("cv-overview");
    check("and clearing it puts them back", (await counted()) === before, await counted());
  }

  console.log("\nwhat kind of answer each prompt got");
  {
    await tab("cv-signals");
    const kinds = await page.evaluate(() => [...document.querySelectorAll("#cv-signals .cv-legend > span")].map((x) => x.textContent));
    const n = await page.evaluate(() => [...document.querySelectorAll("#cv-signals .cv-legend b")].reduce((a, b) => a + Number(b.textContent), 0));
    check("the kinds of answer add up to every answer in the run", n === seeded.answers, kinds.join(" | "));
    await tab("cv-products");
    const cards = await page.evaluate(() => document.querySelectorAll("#cv-products .cv-prodt .cv-tr:not(.cv-th)").length);
    check("product cards from the shopping answers are listed", cards > 0, String(cards));
  }

  console.log("\nprompt by prompt");
  {
    await tab("cv-prompts");
    const grid = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#cv-prompts .cv-prompts .cv-tr:not(.cv-th)")];
      return {
        heads: document.querySelectorAll("#cv-prompts .cv-prompts .cv-th .cv-eng").length,
        rows: rows.map((r) => ({ text: r.querySelector(".cv-ptext .cv-ell")?.textContent || "", cells: r.querySelectorAll(".cv-pc").length })),
      };
    });
    check("one row per tracked prompt", grid.rows.length === seeded.prompts, grid.rows.map((r) => r.text).join(" | "));
    check("with a cell for each of the campaign's engines", grid.heads === 2 && grid.rows.every((r) => r.cells === 2), JSON.stringify(grid));
    await page.evaluate(() => document.querySelector("#cv-prompts .cv-ptoggle")?.click());
    await settle(800);
    const sub = await page.evaluate(() => document.querySelector("#cv-prompts .cv-detail")?.textContent || "");
    check("a prompt opens to the searches the engines ran for it", /Searches the engines ran/.test(sub), sub.slice(0, 120));
    const opened = await page.evaluate(async () => {
      const b = document.querySelector("#cv-prompts button.cv-pc");
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
    // It opens on the tab last used in the full tab (kept in this browser).
    check("the board renders in the popup, on the tab last open", await page.evaluate(() => document.body.classList.contains("popup") && document.querySelector(".cv-tab.on")?.dataset.section === "cv-prompts" && !!document.getElementById("cv-prompts")));
    check("its section tabs are on the board, not in the popup's bar", await page.evaluate(() => document.querySelectorAll("#campaignResults .cv-tabs .cv-tab").length === 10 && !document.querySelector("#headerPage .cb-nav-btn, #headerPage .cv-tab")));
    await tab("cv-prompts");
    const wide = await page.evaluate(() => { const c = document.querySelector(".app-content"); return c.scrollWidth - c.clientWidth; });
    check("nothing on it widens the popup", wide <= 0, `${wide}px`);
    // The prompt table is wider than the popup and scrolls inside its own box.
    const gridScroll = await page.evaluate(() => { const s = document.querySelector("#cv-prompts .cv-scroll"); return s ? getComputedStyle(s).overflowX : null; });
    check("the prompt table scrolls inside its own box", gridScroll === "auto", String(gridScroll));

    // CI (Chrome 153) measured the section 311–332px short however long the
    // test waited: the scroll had stopped, not slowed. The Campaigns tab polls
    // the run status every 1.5s and put the scroll position back after each
    // poll even when nothing had moved, and in current Chrome writing
    // scrollTop cancels a smooth scroll. Older Chrome ignored a write of the
    // same value, so this counts the writes rather than relying on the
    // browser to show the jump falling short.
    {
      const writes = await page.evaluate(() => new Promise((resolve) => {
        const c = document.querySelector(".app-content");
        const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        let n = 0;
        Object.defineProperty(c, "scrollTop", { configurable: true, get() { return d.get.call(this); }, set(v) { n++; d.set.call(this, v); } });
        setTimeout(() => { delete c.scrollTop; resolve(n); }, 3400);
      }));
      check("an idle Campaigns tab leaves the scroll position alone", writes === 0, `${writes} writes in 3.4s, about one per status poll`);
    }

    // Reported in the 0.55 screenshots: after a section link the popup's frame
    // itself had scrolled, the header sliding over the content and the footer
    // floating mid-popup. 0.67.0's tabs replace the links: a tab, picked with
    // the page scrolled down, shows its section with the tabs in sight and
    // the frame left alone.
    await page.evaluate(() => { document.querySelector(".app-content").scrollTop = 600; });
    await page.waitForTimeout(300);
    await tab("cv-citations");
    const g = await page.evaluate(() => {
      const w = document.querySelector(".app-wrapper"), c = document.querySelector(".app-content"), f = document.querySelector(".credit-footer");
      const wr = w.getBoundingClientRect(), cr = c.getBoundingClientRect(), fr = f.getBoundingClientRect(), tr = document.querySelector(".cv-tabs").getBoundingClientRect();
      return { frame: w.scrollTop, gap: Math.round(wr.bottom - fr.bottom), tabsTop: Math.round(tr.top - cr.top), shown: !!document.getElementById("cv-citations") };
    });
    check("a tab shows its section", g.shown, JSON.stringify(g));
    check("and not the popup's frame scrolled", g.frame === 0, JSON.stringify(g));
    check("so the footer stays at the bottom", Math.abs(g.gap) <= 2, JSON.stringify(g));
    check("with the tabs still in sight at the top", g.tabsTop >= -2 && g.tabsTop < 60, JSON.stringify(g));
  }

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
