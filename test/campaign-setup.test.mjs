/*
 * campaign-setup.test.mjs — the campaign setup screen: save actions on top,
 * the required items called out and turned red when missing, competitors
 * that don't push the rest of the form down, two clear ways to add prompts,
 * and a narrow layout that stays in one aligned column.
 *
 * Asked for after the old screen: Save / Lock sat at the bottom under the
 * whole prompt table, nothing said which fields a campaign needs before it
 * can be tracked, each competitor was a full-width row that pushed the AI
 * engine picker further down, and the popup squeezed two-column rows into
 * ~490px.
 *
 * Runs in a real browser: what it guards is layout and the click handlers in
 * ui/panel.js, none of which is importable.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-setup-test";

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
  console.log("\ncampaign-setup: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a requested redesign, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
// A returning user: no first-run tour, whose backdrop swallows clicks.
await context.addInitScript(() => {
  try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* private mode */ }
});

// In page coordinates: filling a field can scroll the page, which is not the
// layout moving.
const docTop = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); return n ? { top: n.getBoundingClientRect().top + window.scrollY } : null; }, sel);
const rect = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}, sel);

const profiles = (page) => page.evaluate(() => new Promise((res) =>
  chrome.runtime.sendMessage({ type: "geo-profile-list" }, (r) => res((r && r.profiles) || []))));

// The redesign's red is the app's own danger token, so this compares against
// whatever --red-fg resolves to in the current theme.
const isRed = (page, sel, prop) => page.evaluate(([s, p]) => {
  const n = document.querySelector(s);
  if (!n) return false;
  const probe = document.createElement("span");
  probe.style.color = "var(--red-fg)";
  document.body.append(probe);
  const red = getComputedStyle(probe).color;
  probe.remove();
  return getComputedStyle(n)[p].includes(red.replace(/\)$/, ""));
}, [sel, prop]);

const reqStates = (page) => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll(".cs-req")].map((n) => [n.dataset.req, n.dataset.state])));

async function newCampaign(page) {
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector(".geo-chip.add")?.click());
  await page.waitForTimeout(800);
}

async function addCompetitor(page, name, site) {
  await page.fill("#cs-comp-name", name);
  if (site) await page.fill("#cs-comp-site", site);
  await page.click(".cs-comp-add");
  await page.waitForTimeout(80);
}

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const pageErrors = [];

  /* ---------------- full tab ---------------- */
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  await newCampaign(page);

  console.log("\nThe save actions are at the top");
  const bar = await rect(page, ".cs-bar");
  const nameBox = await rect(page, "#cs-name");
  check("a setup bar is rendered", !!bar);
  check("Save draft and Save & start tracking are both in it", await page.evaluate(() => {
    const b = document.querySelector(".cs-bar");
    return !!b && /Save draft/.test(b.querySelector(".cs-draft")?.textContent || "") &&
      /Save & start tracking/.test(b.querySelector(".cs-save")?.textContent || "");
  }));
  check("and the bar sits above the first field", bar && nameBox && bar.bottom <= nameBox.top, JSON.stringify({ bar, nameBox }));
  check("no save button is left at the bottom of the form", await page.evaluate(() =>
    ![...document.querySelectorAll(".cs button")].some((b) => !b.closest(".cs-bar") && /Save details|Lock & start/i.test(b.textContent))));

  console.log("\nThe five required items are listed, and a new campaign shows which are done");
  const st0 = await reqStates(page);
  check("exactly name, brand, website, engine and prompt are required",
    JSON.stringify(Object.keys(st0).sort()) === JSON.stringify(["brand", "engine", "name", "prompt", "site"]), JSON.stringify(st0));
  check("the prefilled name and default engines count as done; the rest are to do",
    st0.name === "done" && st0.engine === "done" && st0.brand === "todo" && st0.site === "todo" && st0.prompt === "todo", JSON.stringify(st0));

  console.log("\nSaving with gaps refuses, and turns each missing box red");
  await page.click(".cs-save");
  await page.waitForTimeout(400);
  check("the campaign was not locked", !(await profiles(page)).some((p) => p.locked));
  const st1 = await reqStates(page);
  check("the missing items are marked bad", st1.brand === "bad" && st1.site === "bad" && st1.prompt === "bad" && st1.name === "done", JSON.stringify(st1));
  check("an error summary names them", await page.evaluate(() => {
    const a = document.querySelector('.cs-errors[role="alert"]');
    return !!a && /Brand name/.test(a.textContent) && /Website/.test(a.textContent) && /Prompt/.test(a.textContent) && !/Campaign name/.test(a.textContent);
  }));
  check("the brand box is marked invalid", await page.$eval("#cs-brand", (n) => n.getAttribute("aria-invalid") === "true"));
  check("and drawn in red", await isRed(page, "#cs-brand", "borderTopColor"));
  check("the website box too", await isRed(page, "#cs-site", "borderTopColor"));
  check("the prompts box is outlined in red", await isRed(page, "#cs-prompts", "boxShadow"));
  check("the name box is not red", !(await isRed(page, "#cs-name", "borderTopColor")));

  console.log("\nFilling a box clears its red straight away");
  await page.fill("#cs-brand", "Northwind");
  await page.waitForTimeout(100);
  check("the brand box is no longer invalid", await page.$eval("#cs-brand", (n) => n.getAttribute("aria-invalid") !== "true"));
  check("its checklist item is done", (await reqStates(page)).brand === "done");

  // 0.77.0, asked: "the competition adding option is so down that people
  // may miss it". Competitors now come right after the brand.
  console.log("\nCompetitors right after the brand, before the engines");
  const order = await page.evaluate(() => {
    const top = (q) => document.querySelector(q)?.getBoundingClientRect().top;
    return { brand: top("#cs-brand"), comps: top(".cs-card-comps"), engines: top("#cs-engines"), inDetails: !!document.querySelector(".cs-card-details .cs-card-comps") };
  });
  check("inside the details card, under the brand and above the engines", order.inDetails && order.comps > order.brand && order.comps < order.engines, JSON.stringify(order));
  check("the one-line explainers are tooltips now, not lines of text", await page.evaluate(() =>
    !/Everything here is needed/.test(document.querySelector(".cs").textContent) && !!document.querySelector('.cs-card-comps [data-tip]') && !document.querySelector(".cs-card-details > .cs-card-head .cs-help")));
  for (const [n, s] of [["Contoso", "contoso.com"], ["Fabrikam", "fabrikam.com"], ["Litware", ""], ["Tailspin", "tailspin.com"], ["Adventure Works", "adventure-works.com"], ["Proseware", "proseware.com"]]) {
    await addCompetitor(page, n, s);
  }
  check("six competitors were added", (await page.$$(".cs-comp-chip")).length === 6);
  const compCard = await rect(page, ".cs-card-comps");
  check("six competitors fit in a compact block", compCard && compCard.height < 260, compCard && compCard.height);
  const engRow = await page.evaluate(() => [...document.querySelectorAll(".cs-engine")].map((n) => Math.round(n.getBoundingClientRect().top)));
  check("the AI engines are one row of chips", engRow.length === 4 && engRow.every((t) => t === engRow[0]), JSON.stringify(engRow));
  await page.click('.cs-comp-chip:has-text("Litware") .cs-comp-remove');
  await page.waitForTimeout(80);
  check("a competitor can be removed", (await page.$$(".cs-comp-chip")).length === 5);
  await addCompetitor(page, "contoso", "");
  check("the same competitor isn't added twice", (await page.$$(".cs-comp-chip")).length === 5);

  console.log("\nTwo columns: details on the left, prompts on the right");
  const det = await rect(page, ".cs-card-details");
  const pro = await rect(page, ".cs-card-prompts");
  const com = await rect(page, ".cs-card-comps");
  check("prompts are to the right of the details", det && pro && pro.left >= det.right, JSON.stringify({ det, pro }));
  check("competitors are inside the details column", det && com && com.left >= det.left && com.right <= det.right && com.top >= det.top && com.bottom <= det.bottom);

  console.log("\nTwo buttons for adding prompts");
  const up = await rect(page, '.cs-mode[data-mode="upload"]');
  const man = await rect(page, '.cs-mode[data-mode="manual"]');
  check("Upload a file and Add manually sit side by side", up && man && Math.abs(up.top - man.top) < 1 && man.left > up.right - 1);
  check("they say what they do", await page.evaluate(() =>
    /Upload a file/.test(document.querySelector('.cs-mode[data-mode="upload"]')?.textContent || "") &&
    /Add manually/.test(document.querySelector('.cs-mode[data-mode="manual"]')?.textContent || "")));
  await page.click('.cs-mode[data-mode="upload"]');
  check("Upload opens a drop zone with a file picker and a template", await page.evaluate(() =>
    !!document.querySelector(".cs-drop") && /Choose file/.test(document.querySelector(".cs-drop").textContent) &&
    /template/i.test(document.querySelector(".cs-drop").textContent)));
  await page.click('.cs-mode[data-mode="manual"]');
  check("Add manually swaps it for a text box", await page.evaluate(() =>
    !document.querySelector(".cs-drop") && !!document.querySelector(".prompt-manager textarea")));
  await page.fill(".prompt-manager textarea", "best running shoes for flat feet | footwear\nwhich running shoe brands last the longest");
  await page.click('button:has-text("Add prompts")');
  await page.waitForTimeout(900);
  check("adding prompts kept the competitors typed in so far", (await page.$$(".cs-comp-chip")).length === 5);
  check("and the prompt item is done now", (await reqStates(page)).prompt === "done");

  // 0.55.0, from the canvas: which views the campaign's board leads with.
  console.log("\nWhat this campaign should measure");
  const ms = await page.evaluate(() => [...document.querySelectorAll("#cs-measure .cs-measure")].map((b) => ({
    v: b.dataset.value, on: b.getAttribute("aria-pressed") === "true", tag: b.querySelector(".cs-measure-tag")?.textContent, off: b.disabled })));
  check("five views to pick from", ms.map((m) => m.v).join() === "mentions,citations,products,images,local", ms.map((m) => m.v).join());
  check("brand mentions are always on", ms[0] && ms[0].on && ms[0].off && ms[0].tag === "Always on", JSON.stringify(ms[0]));
  check("a new campaign starts on mentions and citations", ms.filter((m) => m.on).map((m) => m.v).join() === "mentions,citations", ms.filter((m) => m.on).map((m) => m.v).join());
  await page.click('#cs-measure .cs-measure[data-value="products"]');
  check("a view turns on with a click, and says so", await page.evaluate(() => {
    const b = document.querySelector('#cs-measure .cs-measure[data-value="products"]');
    return b.getAttribute("aria-pressed") === "true" && b.querySelector(".cs-measure-tag").textContent === "On";
  }));

  console.log("\nSave draft stores everything without locking");
  await page.click(".cs-draft");
  await page.waitForTimeout(600);
  let p = (await profiles(page))[0];
  check("brand saved", p && p.brand.name === "Northwind", JSON.stringify(p && p.brand));
  check("competitors saved", p && p.competitors.length === 5 && p.competitors.some((c) => c.name === "Contoso" && c.url === "contoso.com"), JSON.stringify(p && p.competitors));
  check("not locked", p && !p.locked);
  check("what it measures is saved", p && p.measure && p.measure.citations && p.measure.products && !p.measure.images && !p.measure.local, JSON.stringify(p && p.measure));

  console.log("\nThe bar stays on screen while scrolling");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  const barScrolled = await rect(page, ".cs-bar");
  const header = await rect(page, ".app-header");
  check("after scrolling down, the bar is still visible below the header",
    barScrolled && header && barScrolled.top >= header.bottom - 1 && barScrolled.bottom <= 900, JSON.stringify({ barScrolled, header }));
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log("\nWith everything in place, Save & start tracking locks it");
  await page.fill("#cs-site", "northwind.com");
  await page.click(".cs-save");
  await page.waitForTimeout(800);
  p = (await profiles(page))[0];
  check("locked", p && p.locked === true);
  check("with the website saved", p && p.brand.url === "northwind.com");
  check("and the competitors", p && p.competitors.length === 5);

  // 0.77.0, asked: "I don't want to open and enable the editing of the
  // campaign". Everything but the brand and website edits in place.
  console.log("\nA locked campaign's setup opens editable, and saves as you go");
  await page.click('#cpHead button:has-text("Edit setup")');
  await page.waitForTimeout(300);
  check("editable, with no unlock step", await page.evaluate(() => {
    const cs = document.querySelector(".cs");
    return !!cs && !cs.classList.contains("cs-readonly") && !/Unlock to edit/.test(cs.querySelector(".cs-bar").textContent) &&
      !!cs.querySelector("#cs-comp-name") && !!cs.querySelector(".cs-mode") && !cs.querySelector(".cs-save") &&
      cs.querySelectorAll(".cs-comp-chip").length === 5 && !document.querySelector("#cs-name").disabled;
  }));
  check("the brand and website ask first", await page.evaluate(() => document.querySelector("#cs-brand").disabled && document.querySelector("#cs-site").disabled && !!document.querySelector("#csBrandChange")));
  await addCompetitor(page, "Woodgrove", "woodgrove.com");
  await page.click('#cs-engines .cs-engine[data-value="perplexity"]').catch(() => {});
  await page.waitForTimeout(1200);
  p = (await profiles(page))[0];
  check("a competitor added there is saved at once, and the campaign stays locked", p && p.locked === true && p.competitors.some((c) => c.name === "Woodgrove"), JSON.stringify(p && p.competitors));
  check("and the change is logged", p && (p.changes || []).some((c) => c.kind === "competitor-added" && c.name === "Woodgrove"), JSON.stringify(p && p.changes));
  check("the bar says it saved", /Saved/.test(await page.evaluate(() => document.querySelector("#csSaved")?.textContent || "")));
  await page.click("#csBrandChange");
  await page.waitForTimeout(150);
  check("Change brand asks, then opens the brand fields", await page.evaluate(() => !document.querySelector("#cs-brand").disabled && !document.querySelector("#cs-site").disabled));
  await page.fill("#cs-brand", "Northwind Labs");
  await page.waitForTimeout(1200);
  p = (await profiles(page))[0];
  check("the new brand is saved, still locked, and logged", p && p.brand.name === "Northwind Labs" && p.locked && (p.changes || []).some((c) => c.kind === "brand"), JSON.stringify(p && p.brand));
  const refused = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "geo-profile-list" }, (x) => {
    const q = x.profiles[0];
    chrome.runtime.sendMessage({ type: "geo-profile-save", profile: { ...q, brand: { name: "Other", url: "other.example" } } }, r);
  })));
  check("without the unlock, the service worker refuses a new brand", refused && !refused.ok && refused.needsUnlock, JSON.stringify(refused));

  /* ---------------- popup ---------------- */
  console.log("\nThe popup gets one aligned column, required things first");
  const pop = await context.newPage();
  pop.on("pageerror", (e) => pageErrors.push(String(e)));
  pop.on("dialog", (d) => d.accept());
  await pop.setViewportSize({ width: 540, height: 600 });
  await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
  await pop.waitForTimeout(1000);
  check("it is in popup mode", await pop.evaluate(() => document.body.classList.contains("popup")));
  await newCampaign(pop);
  for (const n of ["Contoso", "Fabrikam", "Litware"]) await addCompetitor(pop, n, `${n.toLowerCase()}.com`);
  const pd = await rect(pop, ".cs-card-details");
  const pp = await rect(pop, ".cs-card-prompts");
  const pc = await rect(pop, ".cs-card-comps");
  check("details (with competitors), then prompts", pd && pp && pc && pd.bottom <= pp.top && pc.top >= pd.top && pc.bottom <= pd.bottom, JSON.stringify({ pd, pp, pc }));
  check("on one left edge and one width", pd && pp && Math.abs(pd.left - pp.left) < 1 && Math.abs(pd.width - pp.width) < 1);
  const lefts = await pop.evaluate(() => ["#cs-name", "#cs-brand", "#cs-site", "#cs-comp-name"].map((s) => document.querySelector(s)?.getBoundingClientRect().left));
  check("fields line up on the card's left edge", lefts.every((l) => l != null && Math.abs(l - lefts[0]) < 1), JSON.stringify(lefts));
  const brandR = await rect(pop, "#cs-brand");
  const siteR = await rect(pop, "#cs-site");
  check("brand name and website are stacked, not squeezed side by side", brandR && siteR && siteR.top >= brandR.bottom);
  const tiles = await pop.evaluate(() => [...document.querySelectorAll(".cs-engine")].map((n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, h: r.height }; }));
  const card = await rect(pop, ".cs-card-details");
  check("the AI engines are compact chips that wrap inside the card", tiles.length === 4 && tiles.every((t) => t.h <= 40 && t.r <= card.right + 1), JSON.stringify(tiles));
  check("nothing overflows sideways", await pop.evaluate(() => {
    const c = document.querySelector(".app-content");
    const cr = c.getBoundingClientRect();
    return c.scrollWidth <= c.clientWidth && [...document.querySelectorAll(".cs *")].every((n) => {
      const r = n.getBoundingClientRect();
      return r.width === 0 || r.right <= cr.right + 0.5;
    });
  }));
  await pop.evaluate(() => { const c = document.querySelector(".app-content"); c.scrollTop = c.scrollHeight; });
  await pop.waitForTimeout(150);
  const save = await rect(pop, ".cs-save");
  check("scrolled to the bottom, Save & start tracking is still on screen", save && save.top >= 0 && save.bottom <= 600, JSON.stringify(save));
  const pu = await rect(pop, '.cs-mode[data-mode="upload"]');
  const pm = await rect(pop, '.cs-mode[data-mode="manual"]');
  check("the two prompt buttons still sit side by side", pu && pm && Math.abs(pu.top - pm.top) < 1);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
