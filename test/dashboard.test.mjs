/*
 * dashboard.test.mjs — the Dashboard as a record of what you asked (0.49.0),
 * in a real browser: a laptop-size tab (1440 × 900) and the popup (540 × 600).
 *
 * The owner's feedback on the canvas: the general Dashboard "must not be
 * brand-centric"; "it is a record of prompts, search is central, and the
 * right-hand side should go". So: one row per prompt (however many engines
 * answered it, however often it was asked), grouped by day; a search that
 * looks in the prompts, the answers and the searches the engines ran;
 * filters for the period, the engines, the kind of answer and the week; a
 * view of the searches the engines ran; remove with Undo; and a selection
 * that opens a prompt's answers side by side or adds it to a campaign.
 * A campaign's results moved to the Campaigns tab.
 *
 * On 0.48.0 this fails from the first checks: the Dashboard is the
 * "Performance Overview" with a campaign picker and a Top Domains column.
 *
 * Prompts are made up; the answers come from the existing test fixtures.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-dashboard-test";

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
  console.log("\ndashboard: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported redesign, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// Start from an empty profile. This folder is fixed and outlives the run, so
// without this a second run on the same machine reopens the first run's
// storage. That is how analyze-feedback, which had the same fixed-folder
// launch, failed on 10 Nov 2026: old captures were merged into the answer
// (raw-capture.txt held 4 copies, not 2) on every run after the first, master
// included. CI never sees it because each runner starts clean. Only this
// test's own folder is removed.
rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

const SHOP = "best smartphone under 50000";
const LOCAL = "jewellery shops near me for a wedding set";
const gpt = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
const gem = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = `chrome-extension://${extId}/ui/panel.html`;

  // Seed: the shopping prompt on ChatGPT twice and on Gemini once, and a
  // local prompt on ChatGPT, all within the last minute so they are "today"
  // whenever the test runs. Then pick words to search for from what was
  // actually stored, so the test doesn't depend on fixture wording.
  const seedPage = await context.newPage();
  await seedPage.goto(panel);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
  // The second ChatGPT ask is its own conversation, as a real one is: the
  // same stream twice in one conversation is one answer captured twice, and
  // is stored once (lib/sameAnswer.js).
  for (const [f, body, url, secondsAgo, conv] of [
    ["chatgpt-phone-under.txt", gpt(SHOP), "https://chatgpt.com/", 50],
    ["gemini-streamgenerate.txt", gem(SHOP), "https://gemini.google.com/app", 40],
    ["chatgpt-jewellery-wedding.txt", gpt(LOCAL), "https://chatgpt.com/", 30],
    ["chatgpt-phone-under.txt", gpt(SHOP), "https://chatgpt.com/", 20, "test-conversation-2"],
  ]) {
    let raw = readFileSync(path.join(FIXDIR, f), "utf8");
    if (conv) raw = raw.replace(/("conversation_id":\s*")[^"]+"/g, (_, key) => `${key}${conv}"`);
    const res = await seedPage.evaluate(({ raw, body, url, at }) => new Promise((r) => chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody: body, pageUrl: url, capturedAt: at } }, r)), { raw, body, url, at: Date.now() - secondsAgo * 1000 });
    if (!res || !res.captureId) throw new Error(`seeding ${f} stored nothing`);
    await seedPage.waitForTimeout(120);
  }
  const words = await seedPage.evaluate(async ({ SHOP, LOCAL }) => {
    const get = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));
    const recs = (await get({ type: "get-records" })).records.filter((r) => !String(r.captureId).startsWith("demo-"));
    const local = recs.find((r) => r.userPrompt === LOCAL);
    const shop = recs.filter((r) => r.userPrompt === SHOP);
    const promptWords = new Set((SHOP + " " + LOCAL).toLowerCase().split(/\W+/));
    const qs = (r) => [].concat(r.fanout.search || [], r.fanout.shopping || [], r.fanout.image || []).map((q) => q.query || q);
    const allQs = recs.flatMap(qs).join(" ").toLowerCase();
    const full = (await get({ type: "get-record", captureId: local.captureId })).record;
    const shopFull = await Promise.all(shop.map(async (r) => (await get({ type: "get-record", captureId: r.captureId })).record.answerText || ""));
    const answers = [full.answerText || "", ...shopFull].join(" ").toLowerCase();
    // The search drops a trailing "s", so a word is excluded by that stem.
    const stem = (w) => (w.length > 3 ? w.replace(/s$/, "") : w);
    // A word only the local prompt's searches contain: no prompt, no other
    // engine search and no answer has it.
    const fanWord = qs(local).join(" ").toLowerCase().split(/[^a-z]+/).find((w) => w.length > 5 && !promptWords.has(w) && !promptWords.has(stem(w))
      && !shop.flatMap(qs).join(" ").toLowerCase().includes(stem(w)) && !answers.includes(stem(w)));
    // A word only the local answer's text contains (not in any prompt or search).
    const answerWord = (full.answerText || "").toLowerCase().split(/[^a-z]+/).find((w) => w.length > 6 && !promptWords.has(w) && !allQs.includes(w) && !shopFull.join(" ").toLowerCase().includes(w));
    return { fanWord, answerWord, localId: local.captureId, shopIds: shop.map((r) => r.captureId) };
  }, { SHOP, LOCAL });
  await seedPage.close();
  if (!words.fanWord || !words.answerWord) throw new Error("couldn't pick search words from the fixtures: " + JSON.stringify(words));
  console.log(`\nsearch words picked from the seeded captures: "${words.fanWord}" (an engine search), "${words.answerWord}" (an answer)`);

  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${panel}?mode=tab`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
  await page.waitForTimeout(1200);
  const rowsNow = () => page.evaluate(() => [...document.querySelectorAll("#dashboard .db-row")].map((r) => ({
    text: r.querySelector(".db-prompt")?.textContent || "",
    muted: r.querySelector(".db-muted")?.textContent || "",
    engines: [...r.querySelectorAll(".db-engine")].map((b) => b.dataset.engine),
  })));
  const ours = (rows) => rows.filter((r) => r.text === SHOP || r.text === LOCAL);
  const type = async (q) => { await page.fill("#dashboardSearch", q); await page.waitForTimeout(250); };

  console.log("\nA record of prompts, not a brand report");
  {
    const r = await page.evaluate(() => ({
      text: document.getElementById("dashboard").innerText,
      search: !!document.getElementById("dashboardSearch"),
      campaignPicker: [...document.querySelectorAll("#dashboard select")].some((s) => [...s.options].some((o) => /campaign selected/i.test(o.textContent))),
    }));
    check("the search box leads the page", r.search);
    // Case-insensitive: the old card headers were uppercased by CSS, and
    // innerText returns the transformed text.
    check("no Performance Overview, no Top Domains column", !/Performance Overview|Top Domains/i.test(r.text));
    check("no campaign picker on the Dashboard", !r.campaignPicker);
    // Once, in the app bar (0.68.1: the card repeated it).
    const where = await page.evaluate(() => ({ bar: document.getElementById("headerPage")?.innerText || "", inCard: /stored on this computer/.test(document.querySelector("#dashboard .db-top")?.innerText || "") }));
    check("no \"stored on this computer\" line on the Dashboard (0.78.0)", !/stored on this computer/.test(where.bar) && !where.inCard, JSON.stringify(where));
    const rows = await page.evaluate(() => [...document.querySelectorAll("#dashboard .db-fgrid .db-flabel")].map((x) => x.textContent));
    check("the filters are labelled rows: Look in, Engines, When, Show", rows.join("|") === "Look in|Engines|When|Show", rows.join("|"));
    // 0.78.0, asked: the history started 60–70% down the page.
    const lay = await page.evaluate(() => ({
      list: Math.round(document.querySelector("#dashboard .db-list")?.getBoundingClientRect().top || 9999),
      open: !document.getElementById("dbFilters")?.hidden,
      btn: !!document.getElementById("dbFiltersBtn"),
      recentShown: [...document.querySelectorAll("#dashboard .db-recent")].some((x) => x.offsetParent !== null),
    }));
    // 1.0.0: a new user also sees the Get started card above it, kept to one
    // step so the first rows of history are still on a 900px laptop screen.
    const shown = await page.evaluate(() => !!document.querySelector("#dashboard .gs"));
    check("with the Get started card shown, still under 560px down", !shown || lay.list < 560, `${shown} ${lay.list}`);
    // Hidden, as for anyone who has dismissed it: the 0.78.0 bound holds.
    await page.evaluate(() => { localStorage.setItem("cito-gs-hidden", "1"); });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForSelector("#dashboard .db-list", { timeout: 15000 });
    const top = await page.evaluate(() => Math.round(document.querySelector("#dashboard .db-list")?.getBoundingClientRect().top || 9999));
    check("the history starts near the top: under 320px down", top < 320, String(top));
    check("the filters sit behind a Filters button, closed", lay.btn && !lay.open, JSON.stringify(lay));
    await page.click("#dbFiltersBtn");
    await page.waitForTimeout(250);
    check("which opens them", await page.evaluate(() => !document.getElementById("dbFilters").hidden && document.getElementById("dbFiltersBtn").getAttribute("aria-expanded") === "true"));
    await page.click("#dbFiltersBtn");
    await page.waitForTimeout(250);
  }

  console.log("\nOne row per prompt");
  {
    const rows = ours(await rowsNow());
    const shop = rows.filter((r) => r.text === SHOP);
    check("a prompt asked three times on two engines is one row", shop.length === 1, rows.map((r) => r.text).join(" | "));
    check("the row shows both engines that answered", shop[0] && shop[0].engines.join() === "chatgpt,gemini", shop[0] && shop[0].engines.join());
    check("and how often it was asked", shop[0] && /asked 2×/.test(shop[0].muted), shop[0] && shop[0].muted);
    const g = await page.evaluate(() => [...document.querySelectorAll("#dashboard .db-group-h")].map((h) => h.textContent));
    check("rows are grouped by day, today first", /^Today/.test(g[0] || ""), g.join(" | "));
    const s = await page.evaluate(() => ({ total: document.querySelector(".db-total-n")?.textContent, weeks: document.querySelectorAll(".db-week").length, kinds: document.querySelectorAll(".db-kindbtn").length }));
    check("a total, eight weeks of bars and six kinds of answer", Number(s.total) >= 2 && s.weeks === 8 && s.kinds === 6, JSON.stringify(s));
  }

  console.log("\nSearch: prompts, the engines' searches, the answers");
  {
    await type("smartphone");
    const rows = await rowsNow();
    check("a word in a prompt finds it", rows.length >= 1 && rows.every((r) => /smartphone/i.test(r.text)), rows.map((r) => r.text).join(" | "));
    check("the match is highlighted", await page.evaluate(() => !!document.querySelector(".db-row mark.db-hit")));
    check("the total says what matched", await page.evaluate(() => /match “smartphone”/.test(document.querySelector(".db-total-l")?.textContent || "")));
    await type(words.fanWord);
    const f = ours(await rowsNow());
    check("a word only an engine searched for finds the prompt", f.length === 1 && f[0].text === LOCAL && /An engine searched/.test(f[0].muted), JSON.stringify(f));
    await type(words.answerWord);
    await page.waitForTimeout(900);
    const a = ours(await rowsNow());
    check("a word only in the answer finds it, with the passage", a.length === 1 && a[0].text === LOCAL && /In the answer:/.test(a[0].muted) && a[0].muted.toLowerCase().includes(words.answerWord), JSON.stringify(a));
    await page.evaluate(() => [...document.querySelectorAll(".db-chip.scope")].find((b) => b.textContent === "Answers")?.click());
    await page.waitForTimeout(400);
    check("switching off Answers stops looking there", ours(await rowsNow()).length === 0);
    await page.evaluate(() => [...document.querySelectorAll(".db-chip.scope")].find((b) => b.textContent === "Answers")?.click());
    await page.keyboard.press("Enter").catch(() => {});
    await page.focus("#dashboardSearch");
    await page.keyboard.press("Enter");
    await type("");
    const recent = await page.evaluate(() => [...document.querySelectorAll(".db-chip.recent")].map((b) => b.textContent));
    check("searches are remembered as recent searches", recent.some((t) => t.toLowerCase() === words.answerWord), recent.join(", "));
  }

  console.log("\nFilters: engines, kinds, periods, weeks");
  {
    await page.evaluate(() => [...document.querySelectorAll(".db-chip.engine")].find((b) => /ChatGPT/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
    const r = ours(await rowsNow());
    check("ChatGPT off: the ChatGPT-only prompt goes, the one Gemini answered stays", r.length === 1 && r[0].text === SHOP, r.map((x) => x.text).join(" | "));
    await page.evaluate(() => [...document.querySelectorAll(".db-chip.engine")].find((b) => /ChatGPT/.test(b.textContent))?.click());
    await page.evaluate(() => [...document.querySelectorAll(".db-kindbtn")].find((b) => /Local/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
    const k = await rowsNow();
    check("a kind of answer picked shows only that kind", k.length >= 1 && k.every((x) => x.text === LOCAL || !ours([x]).length) && ours(k).length === 1 && ours(k)[0].text === LOCAL, k.map((x) => x.text).join(" | "));
    await page.evaluate(() => [...document.querySelectorAll(".db-kindbtn")].find((b) => /Local/.test(b.textContent))?.click());
    await page.evaluate(() => [...document.querySelectorAll(".db-seg-btn")].find((b) => b.textContent === "Today")?.click());
    await page.waitForTimeout(300);
    const t = ours(await rowsNow());
    check("Today keeps today's prompts", t.length === 2, t.length);
    await page.evaluate(() => [...document.querySelectorAll(".db-seg-btn")].find((b) => b.textContent === "All time")?.click());
    await page.evaluate(() => [...document.querySelectorAll(".db-week")].pop()?.click());
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => ({ pressed: document.querySelector(".db-week:last-child")?.getAttribute("aria-pressed"), hint: document.querySelector(".db-when-box .db-muted")?.textContent || "" }));
    check("clicking this week's bar picks the week", w.pressed === "true" && /Week of/.test(w.hint), JSON.stringify(w));
    await page.evaluate(() => [...document.querySelectorAll(".db-week")].pop()?.click());

    // A custom span of days (0.60.2, asked for).
    await page.evaluate(() => [...document.querySelectorAll(".db-seg-btn")].find((b) => b.textContent === "Custom…")?.click());
    await page.waitForTimeout(300);
    const c0 = await page.evaluate(() => ({
      fields: [...document.querySelectorAll(".db-range input[type=date]")].map((i) => i.value),
      label: document.querySelector(".db-seg-btn.on")?.textContent || "",
      dark: getComputedStyle(document.querySelector(".db-range input[type=date]") || document.body).colorScheme,
    }));
    check("Custom opens two date fields, the last 7 days to start with", c0.fields.length === 2 && c0.fields.every(Boolean) && /\d+ \w{3} – \d+ \w{3}/.test(c0.label), JSON.stringify(c0));
    const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const setRange = async (from, to) => {
      await page.evaluate(([from, to]) => {
        const [a, b] = document.querySelectorAll(".db-range input[type=date]");
        a.value = from; a.dispatchEvent(new Event("change"));
      }, [from, to]);
      await page.waitForTimeout(250);
      await page.evaluate(([from, to]) => {
        const b = document.querySelectorAll(".db-range input[type=date]")[1];
        b.value = to; b.dispatchEvent(new Event("change"));
      }, [from, to]);
      await page.waitForTimeout(300);
    };
    await setRange(today, today);
    const c1 = ours(await rowsNow());
    check("today to today keeps today's prompts", c1.length === 2, c1.length);
    await setRange("2001-01-01", "2001-01-31");
    const c2 = await page.evaluate(() => ({ rows: document.querySelectorAll(".db-row").length, label: document.querySelector(".db-seg-btn.on")?.textContent || "" }));
    check("a span with nothing in it shows nothing, and says the span", c2.rows === 0 && /1 Jan 2001 – 31 Jan 2001/.test(c2.label), JSON.stringify(c2));
    await page.evaluate(() => [...document.querySelectorAll(".db-seg-btn")].find((b) => b.textContent === "All time")?.click());
    await page.waitForTimeout(300);
    check("leaving Custom hides the date fields", await page.evaluate(() => !document.querySelector(".db-range")));
  }

  console.log("\nThe searches the engines ran");
  {
    await page.evaluate(() => [...document.querySelectorAll(".db-view")].find((b) => /Searches/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ rows: document.querySelectorAll(".db-fan-row:not(.db-th)").length, head: document.querySelector(".db-fan-row.db-th")?.textContent || "" }));
    check("a table of every search, how often, which engines, for which prompt", r.rows > 0 && /Ran for your prompt/.test(r.head), JSON.stringify(r));
    // "Ran for your prompt" was cut at 60 characters with the rest in a
    // tooltip, and only the first prompt was a link (0.60.2).
    const f = await page.evaluate(() => {
      const prompts = new Set([...document.querySelectorAll(".db-fan-row:not(.db-th) .db-from-link")].map((b) => b.textContent));
      const cells = [...document.querySelectorAll(".db-fan-row:not(.db-th) > span:last-child")];
      return { links: prompts.size, cut: cells.some((c) => /…/.test(c.textContent)), styles: [...document.querySelectorAll(".db-from-link")].every((b) => getComputedStyle(b).whiteSpace !== "nowrap") };
    });
    check("every prompt is whole, wraps, and is its own link", f.links > 0 && !f.cut && f.styles, JSON.stringify(f));
    await page.evaluate(() => [...document.querySelectorAll(".db-view")].find((b) => /Prompts/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
  }

  console.log("\nOpening an answer");
  {
    await page.evaluate((SHOP) => [...document.querySelectorAll(".db-row")].find((r) => r.querySelector(".db-prompt")?.textContent === SHOP)?.querySelector('.db-engine[data-engine="gemini"]')?.click(), SHOP);
    await page.waitForTimeout(1500);
    const a = await page.evaluate(() => ({ active: document.querySelector(".panel.active")?.id, asked: document.querySelector("#analyze .at-asked")?.textContent || "" }));
    check("an engine's mark opens that engine's answer", a.active === "analyze" && a.asked === "Asked Gemini", JSON.stringify(a));
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(800);
  }

  console.log("\nSelecting a prompt");
  {
    await page.evaluate((SHOP) => [...document.querySelectorAll(".db-row")].find((r) => r.querySelector(".db-prompt")?.textContent === SHOP)?.querySelector("input[type=checkbox]")?.click(), SHOP);
    await page.waitForTimeout(300);
    const bar = await page.evaluate(() => ({ text: document.querySelector(".db-selbar")?.innerText || "", side: [...document.querySelectorAll(".db-selbar button")].find((b) => /side by side/.test(b.textContent))?.disabled }));
    check("a selection bar: open side by side, add to a campaign, export, remove", /1 selected/.test(bar.text) && /Add to a campaign/.test(bar.text) && /Export/.test(bar.text) && /Remove/.test(bar.text), bar.text);
    check("side by side is offered for a prompt two engines answered", bar.side === false);
    // A campaign still being set up takes new prompts.
    const prof = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "geo-profile-save", profile: { name: "Test campaign", brand: { name: "Zento", url: "" }, engines: ["chatgpt"] } }, r)));
    await page.reload(); await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(800);
    await page.evaluate((SHOP) => [...document.querySelectorAll(".db-row")].find((r) => r.querySelector(".db-prompt")?.textContent === SHOP)?.querySelector("input[type=checkbox]")?.click(), SHOP);
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll(".db-selbar button")].find((b) => b.textContent === "Add to a campaign")?.click());
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll(".db-menu .menu-item")].find((b) => /Test campaign/.test(b.textContent))?.click());
    await page.waitForTimeout(800);
    const added = await page.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "geo-prompt-list", profileId: id }, (x) => r((x.prompts || []).map((p) => p.text)))), prof.profile && prof.profile.id);
    check("Add to a campaign adds the prompt to it", added.includes(SHOP), JSON.stringify(added));
    await page.evaluate((SHOP) => [...document.querySelectorAll(".db-row")].find((r) => r.querySelector(".db-prompt")?.textContent === SHOP)?.querySelector("input[type=checkbox]")?.click(), SHOP);
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll(".db-selbar button")].find((b) => /side by side/.test(b.textContent))?.click());
    await page.waitForTimeout(1500);
    const cmp = await page.evaluate(() => ({ active: document.querySelector(".panel.active")?.id, cmp: !!document.getElementById("at-cmp-diffs") }));
    check("Open side by side opens the engines' answers compared", cmp.active === "analyze" && cmp.cmp, JSON.stringify(cmp));
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(800);
  }

  console.log("\nRemove, with Undo");
  {
    const rm = () => page.evaluate((LOCAL) => [...document.querySelectorAll(".db-row")].find((r) => r.querySelector(".db-prompt")?.textContent === LOCAL)?.querySelector(".db-trash")?.click(), LOCAL);
    await rm();
    await page.waitForTimeout(300);
    const gone = ours(await rowsNow());
    const toast = await page.evaluate(() => document.querySelector(".db-toast")?.textContent || "");
    check("the row goes at once, with an Undo", !gone.some((r) => r.text === LOCAL) && /Removed from your history/.test(toast) && /Undo/.test(toast), toast);
    await page.evaluate(() => [...document.querySelectorAll(".db-toast button")].find((b) => b.textContent === "Undo")?.click());
    await page.waitForTimeout(300);
    check("Undo brings it back", ours(await rowsNow()).some((r) => r.text === LOCAL));
    await rm();
    await page.waitForTimeout(8500);
    const stored = await page.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId: id }, (x) => r(!!(x && x.record)))), words.localId);
    check("without Undo, the answer is deleted when the toast goes", stored === false);
  }

  check("nothing scrolls sideways in the tab", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  console.log("\nThe popup: the same history in one column");
  {
    await page.setViewportSize({ width: 540, height: 600 });
    await page.goto(panel);
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(1000);
    const r = await page.evaluate(() => {
      const d = document.getElementById("dashboard");
      const wide = [...d.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1 && !n.closest(".db-kindchips")).map((n) => n.className).slice(0, 5);
      return {
        popup: !!d.querySelector(".db-popup"),
        rows: d.querySelectorAll(".db-row").length,
        checkboxes: d.querySelectorAll(".db-row input[type=checkbox]").length,
        period: !!d.querySelector("select.db-select"),
        kinds: d.querySelectorAll(".db-kindchips .db-chip").length,
        wide,
      };
    });
    check("the popup uses its own one-column layout", r.popup && r.rows >= 1, JSON.stringify(r));
    check("a period menu and kind chips instead of the tab's panels", r.period && r.kinds === 6, JSON.stringify(r));
    check("no checkboxes in the popup's rows", r.checkboxes === 0);
    check("nothing pokes out past the popup's edge", r.wide.length === 0, r.wide.join(" | "));
  }

  console.log("\nCampaign results moved to Campaigns");
  {
    // The popup's "campaign prompts" menu (0.68.0) is a filter, not results.
    const has = await page.evaluate(() => [...document.querySelectorAll("#dashboard select:not(.db-campsel)")].length <= 1 && !document.getElementById("geoMetrics"));
    check("the Dashboard holds no campaign results", has);
  }

  check("no page error anywhere above", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
