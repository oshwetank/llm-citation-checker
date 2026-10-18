/*
 * campaign-view-ui.test.mjs — the 0.64.0 campaign board on screen.
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

  console.log("\nnine sections, in the order asked for");
  {
    const ids = await page.evaluate(() => [...document.querySelectorAll("#campaignResults section.cv-sec")].map((s) => s.id));
    check("overview, brands, you vs rival, sources, citations, prompts, products, searches, signals",
      JSON.stringify(ids) === JSON.stringify(["cv-overview", "cv-brands", "cv-compare", "cv-sources", "cv-citations", "cv-prompts", "cv-products", "cv-searches", "cv-signals"]), ids.join(" | "));
    const nav = await page.evaluate(() => [...document.querySelectorAll(".cb-nav-btn")].map((b) => b.textContent));
    check("a link to each, with counts where a count says something", nav.length === 9 && nav.some((t) => /^Citations\d+$/.test(t)), nav.join(" | "));
    const kpis = await page.evaluate(() => [...document.querySelectorAll("#cv-overview .cv-kpi")].map((k) => k.querySelector(".cv-kpi-l").textContent));
    check("the five headline numbers come first", JSON.stringify(kpis) === JSON.stringify(["Share of voice", "Visibility", "Average position", "Mentions", "Responses"]), kpis.join(" | "));
    const split = await page.evaluate(() => document.querySelectorAll("#cv-overview .cv-kpi:first-child .cv-split-row").length);
    check("each split by engine", split === 2, String(split));
    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
    check("nothing widens the page", overflow <= 0, `${overflow}px`);
  }

  console.log("\nlogos instead of names");
  {
    const lg = await page.evaluate(() => ({
      all: document.querySelectorAll("#campaignResults .cv-lg").length,
      eng: document.querySelectorAll("#campaignResults .cv-eng svg").length,
      letters: document.querySelectorAll("#campaignResults .cv-lg svg text").length,
    }));
    check("engines, brands and sites carry a mark", lg.all > 40 && lg.eng > 10, JSON.stringify(lg));
    check("a site Chrome has no icon for gets a letter badge", lg.letters > 5, JSON.stringify(lg));
  }

  console.log("\nbrands, and a rival side by side");
  {
    const before = await page.evaluate(() => document.querySelector("#cv-brands .cv-lead .cv-tr:not(.cv-th) .cv-num:last-child")?.textContent);
    await page.evaluate(() => [...document.querySelectorAll("#cv-brands .cv-seg button")].find((b) => b.textContent.startsWith("ChatGPT"))?.click());
    await settle();
    const after = await page.evaluate(() => ({ on: document.querySelector("#cv-brands .cv-seg button.on")?.textContent, last: document.querySelector("#cv-brands .cv-lead .cv-tr:not(.cv-th) .cv-num:last-child")?.textContent }));
    check("the engine switch redraws the leaderboard for that engine", /^ChatGPT/.test(after.on || "") && after.last !== before, `${before} → ${JSON.stringify(after)}`);
    const rivals = await page.evaluate(() => [...document.querySelectorAll("#cv-compare .cv-chips .cv-chip")].map((b) => b.textContent));
    check("every other brand can be picked as the rival", rivals.length >= 2, rivals.join(" | "));
    await page.evaluate(() => document.querySelectorAll("#cv-compare .cv-chips .cv-chip")[1]?.click());
    await settle();
    const vs = await page.evaluate(() => ({ name: document.querySelectorAll("#cv-compare .cv-vs-side b")[1]?.textContent, rows: document.querySelectorAll("#cv-compare .cv-duel .cv-div").length, picked: document.querySelector("#cv-compare .cv-chip.on")?.textContent }));
    check("picking one compares it on eight measures", vs.rows === 8 && vs.name && vs.picked && vs.picked.endsWith(vs.name), JSON.stringify(vs));
  }

  console.log("\nall citations, in detail");
  {
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
    const s = await page.evaluate(() => ({ site: document.querySelector("#cv-searches .cv-site-row")?.innerText || "", ads: document.querySelector("#cv-searches .cv-adt")?.innerText || "" }));
    check("a site: search shows its sites, and the ones it left out", /rtings\.com/.test(s.site) && /not reddit\.com/.test(s.site), s.site.slice(0, 160));
    check("an ad shows its advertiser and the prompt it came with", s.ads.includes(seeded.competitors[0]) && s.ads.includes("deals this week"), s.ads.slice(0, 200));
  }

  // Analyze, opened next, shows the answer's own images; the board itself
  // must not fetch anything.
  check("the board makes no request outside the browser", outside.length === 0, outside.slice(0, 3).join(" | "));

  console.log("\nprompts open their answers");
  {
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

  if (SHOTS) {
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await page.waitForTimeout(2500);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => { localStorage.setItem("cito-theme", t); document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/cv-${theme}.png`, fullPage: true });
    }
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
