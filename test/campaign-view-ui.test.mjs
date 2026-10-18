/*
 * campaign-view-ui.test.mjs — the 0.64.0 campaign board on screen.
 *
 * 0.67.0: the sections are tabs, one open at a time; a prompt anywhere
 * opens its answer and Back (the page's, the browser's, or Campaigns) finds
 * the board as it was left; engines, the brand in view and tags filter it;
 * Compare takes several brands at once.
 *
 * Asked for: the headline numbers first (share of voice, visibility,
 * position, mentions, responses), then each engine, then a leaderboard, a
 * comparison with any rival, every citation in detail, prompt rankings,
 * products and topics, the searches the engines ran with site:, ads, and
 * signals; logos for engines, brands and sites wherever they read faster
 * than a name. On 0.62.2 none of these sections exist.
 *
 * Seeded from the fixtures (test/helpers/campaign-seed.mjs), plus one
 * made-up ad from a rival and one site: search, so those sections have
 * something to show.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seedCampaign } from "./helpers/campaign-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-view-test";
const SHOTS = process.env.CV_SHOTS || "";

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
  console.log(`\ncampaign-view-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  const { extId, seeded, seedPage } = await seedCampaign(context, path.join(HERE, "fixtures"));
  if (seeded.error) { console.log(`\ncampaign-view-ui: CANNOT RUN — ${seeded.error}`); process.exit(1); }
  // An ad from the first competitor and a site: search, on the latest run.
  const extra = await seedPage.evaluate(async (rival) => {
    const db = await new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); });
    const store = (m) => db.transaction("derived", m).objectStore("derived");
    const all = await new Promise((res) => { const r = store("readonly").getAll(); r.onsuccess = () => res(r.result); });
    const latest = all.filter((r) => r.geo && r.platform === "chatgpt" && !String(r.captureId).endsWith("-r1"));
    if (latest.length < 2) return { error: "not enough ChatGPT answers" };
    const a = { ...latest[0], ads: [{ advertiser: rival, targetDomain: `${rival.toLowerCase().replace(/\W+/g, "")}.example`, title: `${rival} deals this week`, label: "Sponsored" }] };
    const b = { ...latest[1], fanout: { ...(latest[1].fanout || {}), search: [...((latest[1].fanout || {}).search || []), { query: "best tv site:rtings.com -site:reddit.com" }] } };
    for (const rec of [a, b]) await new Promise((res) => { const r = store("readwrite").put(rec); r.onsuccess = () => res(); });
    return { ad: a.userPrompt, site: b.userPrompt };
  }, seeded.competitors[0]);
  await seedPage.close();
  if (extra.error) { console.log(`\ncampaign-view-ui: CANNOT RUN — ${extra.error}`); process.exit(1); }
  console.log(`\nseeded: ${seeded.answers} answers, own brand "${seeded.own}", rivals ${seeded.competitors.join(", ")}`);

  const page = await context.newPage();
  const errors = [];
  const outside = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (q) => { if (!/^(chrome-extension|data|blob):/.test(q.url())) outside.push(q.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2800);
  const settle = (ms = 500) => page.waitForTimeout(ms);

  const tabTo = async (id) => { await page.evaluate((id) => document.querySelector(`.cv-tab[data-section="${id}"]`)?.click(), id); await settle(400); };
  const shownSecs = () => page.evaluate(() => [...document.querySelectorAll("#cvPanel section.cv-sec")].map((s) => s.id));

  console.log("\nnine sections as tabs, one at a time (0.67.0)");
  {
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".cv-tabs [role=tab]")].map((b) => ({ id: b.dataset.section, text: b.textContent, sel: b.getAttribute("aria-selected") })));
    check("a tab for each section, in the order asked for", JSON.stringify(tabs.map((t) => t.id)) === JSON.stringify(["cv-overview", "cv-brands", "cv-compare", "cv-sources", "cv-citations", "cv-prompts", "cv-products", "cv-searches", "cv-signals"]), tabs.map((t) => t.id).join(" | "));
    check("with counts where a count says something", tabs.some((t) => /^Citations\d+$/.test(t.text)), tabs.map((t) => t.text).join(" | "));
    check("Overview is open, and only Overview", JSON.stringify(await shownSecs()) === JSON.stringify(["cv-overview"]) && tabs[0].sel === "true", JSON.stringify(await shownSecs()));
    check("the app bar no longer carries the section links", await page.evaluate(() => !document.querySelector("#headerPage .cb-nav, #headerPage .cb-nav-btn")));
    const kpis = await page.evaluate(() => [...document.querySelectorAll("#cv-overview .cv-kpi")].map((k) => k.querySelector(".cv-kpi-l").textContent));
    check("the five headline numbers come first", JSON.stringify(kpis) === JSON.stringify(["Share of voice", "Visibility", "Average position", "Mentions", "Responses"]), kpis.join(" | "));
    const split = await page.evaluate(() => document.querySelectorAll("#cv-overview .cv-kpi:first-child .cv-split-row").length);
    check("each split by engine", split === 2, String(split));
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check("nothing widens the page", overflow <= 0, `${overflow}px`);
    await page.evaluate(() => document.querySelector('.cv-tab[data-section="cv-overview"]').focus());
    await page.keyboard.press("ArrowRight");
    await settle(300);
    check("arrow keys move between tabs", JSON.stringify(await shownSecs()) === JSON.stringify(["cv-brands"]) && await page.evaluate(() => document.activeElement?.dataset.section === "cv-brands"));
  }

  console.log("\nlogos instead of names");
  {
    await tabTo("cv-sources");
    await settle(600);
    const lg = await page.evaluate(() => ({
      all: document.querySelectorAll("#campaignResults .cv-lg").length,
      eng: document.querySelectorAll("#campaignResults .cv-eng svg, #campaignResults .cv-eng").length,
      letters: document.querySelectorAll("#campaignResults .cv-lg svg text").length,
    }));
    check("engines, brands and sites carry a mark", lg.all > 20 && lg.eng > 4, JSON.stringify(lg));
    check("a site Chrome has no icon for gets a letter badge", lg.letters > 5, JSON.stringify(lg));
  }

  console.log("\nbrands");
  {
    await tabTo("cv-brands");
    const before = await page.evaluate(() => document.querySelector("#cv-brands .cv-lead .cv-tr:not(.cv-th) .cv-num:last-child")?.textContent);
    await page.evaluate(() => [...document.querySelectorAll("#cv-brands .cv-seg button")].find((b) => b.textContent.startsWith("ChatGPT"))?.click());
    await settle();
    const after = await page.evaluate(() => ({ on: document.querySelector("#cv-brands .cv-seg button.on")?.textContent, last: document.querySelector("#cv-brands .cv-lead .cv-tr:not(.cv-th) .cv-num:last-child")?.textContent }));
    check("the engine switch redraws the leaderboard for that engine", /^ChatGPT/.test(after.on || "") && after.last !== before, `${before} → ${JSON.stringify(after)}`);
  }

  console.log("\ncompare with one or more brands");
  {
    await tabTo("cv-compare");
    const chips = await page.evaluate(() => [...document.querySelectorAll("#cv-compare .cv-chips[aria-label='Brands to compare'] .cv-chip")].map((b) => ({ t: b.textContent, on: b.classList.contains("on") })));
    check("every other brand can be picked, the strongest first", chips.length >= 2 && chips[0].on && chips.filter((c) => c.on).length === 1, JSON.stringify(chips));
    await page.evaluate(() => document.querySelectorAll("#cv-compare .cv-chips[aria-label='Brands to compare'] .cv-chip")[1]?.click());
    await settle();
    const m = await page.evaluate(() => {
      const t = document.querySelector("#cv-compare .cv-cmp[aria-label='Measures']");
      return { cols: t ? t.querySelectorAll(".cv-th [role=columnheader]").length : 0, rows: t ? t.querySelectorAll(".cv-tr:not(.cv-th):not(.cv-foot-row)").length : 0, best: t ? t.querySelectorAll(".cv-best").length : 0, picked: document.querySelectorAll("#cv-compare .cv-chips[aria-label='Brands to compare'] .cv-chip.on").length };
    });
    check("two rivals: a column for each beside yours, on eight measures", m.picked === 2 && m.cols === 4 && m.rows === 8, JSON.stringify(m));
    check("the best figure in each row is marked", m.best >= 8, String(m.best));
    const parts = await page.evaluate(() => [...document.querySelectorAll("#cv-compare .cv-h4")].map((x) => x.firstChild.textContent));
    check("engine by engine, topic by topic, named together, prompt by prompt, products, wording", ["Engine by engine", "Topic by topic", "Prompt by prompt", "Product cards", "How the answers word it"].every((x) => parts.includes(x)) && parts.some((x) => /^Named in the same answers/.test(x)), parts.join(" | "));
    await page.evaluate(() => [...document.querySelectorAll("#cv-compare .cv-seg[aria-label='Measure'] button")].find((b) => b.textContent === "Visibility")?.click());
    await settle();
    check("the engine table switches measure", await page.evaluate(() => document.querySelector("#cv-compare .cv-seg[aria-label='Measure'] button.on")?.textContent === "Visibility"));
  }

  console.log("\nall citations, in detail");
  {
    await tabTo("cv-citations");
    const c = await page.evaluate(() => ({ rows: document.querySelectorAll("#cv-citations .cv-cits .cv-rowbtn").length, pager: document.querySelector("#cv-citations .cv-pager .cv-muted")?.textContent }));
    check("a page of citations with a pager", c.rows > 0 && c.rows <= 20 && /of \d+/.test(c.pager || ""), JSON.stringify(c));
    await page.evaluate(() => document.querySelector("#cv-citations .cv-rowbtn")?.click());
    await settle();
    const d = await page.evaluate(() => document.querySelector("#cv-citations .cv-detail")?.innerText || "");
    check("a row opens to the snippet, the address and the answer's context", /Pages this answer read/.test(d) && /https?:\/\//.test(d), d.slice(0, 120));
    const total = await page.evaluate(() => Number((document.querySelector("#cv-citations .cv-pager .cv-muted")?.textContent || "").split(" of ")[1]));
    await page.fill("#cvCitQ", "zzzz-no-such-site");
    await settle();
    const none = await page.evaluate(() => document.querySelector("#cv-citations .cv-empty")?.textContent || "");
    check("the search box filters them", /No citation matches/.test(none), none);
    await page.fill("#cvCitQ", "");
    await settle();
    const back = await page.evaluate(() => Number((document.querySelector("#cv-citations .cv-pager .cv-muted")?.textContent || "").split(" of ")[1]));
    check("and clearing it brings them back", back === total && total > 0, `${back} vs ${total}`);
  }

  console.log("\nsearches, site: and ads");
  {
    await tabTo("cv-searches");
    const s = await page.evaluate(() => ({ site: document.querySelector("#cv-searches .cv-site-row")?.innerText || "", ads: document.querySelector("#cv-searches .cv-adt")?.innerText || "" }));
    check("a site: search shows its sites, and the ones it left out", /rtings\.com/.test(s.site) && /not reddit\.com/.test(s.site), s.site.slice(0, 160));
    check("an ad shows its advertiser and the prompt it came with", s.ads.includes(seeded.competitors[0]) && s.ads.includes("deals this week"), s.ads.slice(0, 200));
    check("the prompt under a site: search opens its answer", await page.evaluate(() => !!document.querySelector("#cv-searches .cv-site-row .cv-plink")));
  }

  // Analyze, opened next, shows the answer's own images; the board itself
  // must not fetch anything.
  check("the board makes no request outside the browser", outside.length === 0, outside.slice(0, 3).join(" | "));

  console.log("\nprompts open their answers, and coming back finds the board as it was");
  {
    await tabTo("cv-prompts");
    await page.evaluate(() => [...document.querySelectorAll("#cv-prompts .cv-chips[aria-label='Show'] .cv-chip")].find((b) => b.textContent.startsWith("A rival named first"))?.click());
    await settle();
    const before = await page.evaluate(() => {
      const sc = document.scrollingElement; sc.scrollTop = 220;
      return { filter: document.querySelector("#cv-prompts .cv-chips[aria-label='Show'] .cv-chip.on")?.textContent, rows: document.querySelectorAll("#cv-prompts .cv-prompts .cv-tr:not(.cv-th)").length, y: sc.scrollTop };
    });
    const opened = await page.evaluate(async () => {
      const b = document.querySelector("#cv-prompts .cv-plink");
      if (!b) return null;
      const text = b.textContent;
      b.click();
      await new Promise((r) => setTimeout(r, 1800));
      const a = document.getElementById("analyze");
      return { text, active: a.classList.contains("active"), shows: a.innerText.includes(text) };
    });
    check("the prompt's text opens its answer in Analyze", opened && opened.active && opened.shows, JSON.stringify(opened));
    const state = async () => page.evaluate(() => ({ loader: document.getElementById("loader").classList.contains("active"), sec: document.querySelector(".cv-tab.on")?.dataset.section, filter: document.querySelector("#cv-prompts .cv-chips[aria-label='Show'] .cv-chip.on")?.textContent, rows: document.querySelectorAll("#cv-prompts .cv-prompts .cv-tr:not(.cv-th)").length, y: document.scrollingElement.scrollTop }));
    const same = (x) => x.loader && x.sec === "cv-prompts" && x.filter === before.filter && x.rows === before.rows && Math.abs(x.y - before.y) < 4;
    await page.evaluate(() => document.querySelector(".analyze-context-back")?.click());
    await settle(800);
    const b1 = await state();
    check("its Back button returns to the same tab, filter and scroll", same(b1), `${JSON.stringify(before)} → ${JSON.stringify(b1)}`);
    await page.evaluate(() => document.querySelector("#cv-prompts .cv-pc:not(.na)")?.click());
    await settle(1500);
    await page.goBack();
    await settle(800);
    const b2 = await state();
    check("so does the browser's Back", same(b2), JSON.stringify(b2));
    await page.evaluate(() => document.querySelector("#cv-prompts .cv-plink")?.click());
    await settle(1500);
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await settle(1200);
    const b3 = await state();
    check("and so does clicking Campaigns", same(b3), JSON.stringify(b3));
  }

  console.log("\nfilters: engines, the brand in view, tags");
  {
    const engChip = (id) => page.evaluate((id) => document.querySelector(`.cb-engs .cb-eng[data-engine="${id}"]`)?.click(), id);
    await engChip("chatgpt");
    await page.waitForTimeout(1800);
    const one = await page.evaluate(() => ({ on: [...document.querySelectorAll(".cb-engs .db-chip.on")].map((b) => b.textContent.trim()), note: document.querySelector(".scope-note")?.textContent }));
    check("one engine", JSON.stringify(one.on) === JSON.stringify(["ChatGPT"]) && /ChatGPT only/.test(one.note || ""), JSON.stringify(one));
    await engChip("gemini");
    await page.waitForTimeout(1800);
    const two = await page.evaluate(() => ({ on: [...document.querySelectorAll(".cb-engs .db-chip.on")].map((b) => b.textContent.trim()), note: document.querySelector(".scope-note")?.textContent }));
    check("or several", two.on.length === 2 && /ChatGPT and Gemini only/.test(two.note || ""), JSON.stringify(two));
    await page.evaluate(() => [...document.querySelectorAll(".cb-engs .db-chip")].find((b) => b.textContent.trim() === "All")?.click());
    await page.waitForTimeout(1800);
    check("or all", await page.evaluate(() => !document.querySelector(".scope-note")));
    check("the open tab survives a filter change", await page.evaluate(() => document.querySelector(".cv-tab.on")?.dataset.section === "cv-prompts"));

    const rival = seeded.competitors[0];
    await page.selectOption(".brand-picker", rival);
    await page.waitForTimeout(1800);
    await tabTo("cv-overview");
    const v = await page.evaluate(() => ({ title: document.querySelector("#cv-overview .cv-h")?.textContent, badge: document.querySelector(".cv-badge.you")?.textContent }));
    check("any brand can be put in view, and the whole board measures it", v.title === `${rival} in this run`, JSON.stringify(v));
    await tabTo("cv-brands");
    check("marked as the brand in view, not as you", await page.evaluate(() => [...document.querySelectorAll("#cv-brands .cv-badge.you")].some((b) => b.textContent === "Viewing")));
    await page.selectOption(".brand-picker", seeded.own);
    await page.waitForTimeout(1800);

    const tag = (t) => page.evaluate((t) => [...document.querySelectorAll(".cb-tags .db-chip")].find((b) => b.textContent === t)?.click(), t);
    const promptsShown = async () => { await tabTo("cv-prompts"); await page.evaluate(() => [...document.querySelectorAll("#cv-prompts .cv-chips[aria-label='Show'] .cv-chip")].find((b) => b.textContent.startsWith("All prompts"))?.click()); await settle(); return page.evaluate(() => document.querySelectorAll("#cv-prompts .cv-prompts .cv-tr:not(.cv-th)").length); };
    await tag("buying"); await page.waitForTimeout(1800);
    await tag("tv"); await page.waitForTimeout(1800);
    const any = await promptsShown();
    await page.evaluate(() => [...document.querySelectorAll(".cb-tagmode button")].find((b) => b.textContent === "All of these")?.click());
    await page.waitForTimeout(1800);
    const allOf = await promptsShown();
    check("two tags: prompts with any of them, or with all of them", any === 2 && allOf === 1, `any ${any}, all ${allOf}`);
    await page.evaluate(() => [...document.querySelectorAll(".cb-tags .linkbtn")].find((b) => b.textContent === "Clear")?.click());
    await page.waitForTimeout(1500);
  }

  console.log("\nthe Dashboard: campaign prompts grouped, or left out (0.68.0)");
  {
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]')?.click());
    await page.waitForTimeout(1500);
    const read = () => page.evaluate(() => ({
      blocks: [...document.querySelectorAll("#dashboard .db-campaign-block")].map((b) => ({ label: b.querySelector(".db-group-h")?.textContent || "", rows: b.querySelectorAll(".db-row").length })),
      rows: document.querySelectorAll("#dashboard .db-row").length,
      last: [...document.querySelectorAll("#dashboard .db-group-block")].pop()?.classList.contains("db-campaign-block"),
      on: document.querySelector("#dashboard .db-campseg .on")?.dataset.campaigns,
    }));
    const g = await read();
    check("a campaign's prompts are one block, named for the campaign, after the rest", g.on === "group" && g.blocks.length === 1 && /Campaign/.test(g.blocks[0].label) && g.blocks[0].rows === seeded.prompts && g.last, JSON.stringify(g));
    await page.evaluate(() => document.querySelector('#dashboard .db-campseg [data-campaigns="hide"]')?.click());
    await page.waitForTimeout(800);
    const h = await read();
    check("Left out: the Dashboard without them", h.on === "hide" && h.blocks.length === 0 && h.rows === g.rows - g.blocks[0].rows, JSON.stringify(h));
    await page.evaluate(() => document.querySelector('#dashboard .db-campseg [data-campaigns="only"]')?.click());
    await page.waitForTimeout(800);
    const o = await read();
    check("Only: just the campaign's", o.on === "only" && o.blocks.length === 1 && o.rows === g.blocks[0].rows, JSON.stringify(o));
    await page.reload();
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]')?.click());
    await page.waitForTimeout(1200);
    check("the choice is kept", (await read()).on === "only");
    await page.evaluate(() => document.querySelector('#dashboard .db-campseg [data-campaigns="group"]')?.click());
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await page.waitForTimeout(2500);
  }

  if (SHOTS) {
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await page.waitForTimeout(2500);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => { localStorage.setItem("cito-theme", t); document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/cv-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => { localStorage.setItem("cito-theme", "light"); document.documentElement.dataset.theme = "light"; document.querySelector('.cv-tab[data-section="cv-compare"]')?.click(); });
    await page.waitForTimeout(500);
    await page.evaluate(() => [...document.querySelectorAll("#cv-compare .cv-chips[aria-label='Brands to compare'] .cv-chip:not(.on)")][0]?.click());
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/cv-compare.png`, fullPage: true });
    await page.setViewportSize({ width: 540, height: 900 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/cv-narrow.png`, fullPage: true });
  }

  console.log("\nquietly");
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
