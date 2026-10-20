/*
 * campaign-edit-ui.test.mjs — campaigns without the friction, on the board
 * (0.77.0).
 *
 * The owner: "once i run a campaign, and i got the competiton now to addd
 * them i have to open and enable the editing of the campaign … i want the
 * competition adding process to be smoothh". On a locked campaign seeded from
 * the fixtures:
 *   1. the brands the answers name that aren't on the list are offered with
 *      "+ Add"; one click adds one, the campaign stays locked, and the other
 *      suggestions stay;
 *   2. "+ Add" on a "found in answers" leaderboard row;
 *   3. the board says what changed since the campaign was set up;
 *   4. the prompt list: primary and secondary tags apart, one tag taken off
 *      one prompt, a secondary made primary, the role filter; the Excel
 *      template downloads and reads back.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { seedCampaign } from "./helpers/campaign-seed.mjs";
import { parseXlsx, rowsToPrompts } from "../src/lib/xlsxLite.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-edit-ui-test";

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
  console.log(`\ncampaign-edit-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  acceptDownloads: true,
});
try {
  const { extId, seeded, seedPage } = await seedCampaign(context, path.join(HERE, "fixtures"));
  if (seeded.error) { console.log(`\ncampaign-edit-ui: CANNOT RUN — ${seeded.error}`); process.exit(1); }
  await seedPage.close();
  console.log(`\nseeded: own brand "${seeded.own}", rivals ${seeded.competitors.join(", ")}`);

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(1000);
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const profile = async () => ((await msg({ type: "geo-profile-list" })).profiles || [])[0];
  const openBoard = async () => { await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click()); await page.waitForTimeout(2500); };
  await openBoard();

  console.log("\n1. suggested competitors, one click each");
  const sugg = await page.evaluate(() => [...document.querySelectorAll("#cbSuggest .cb-sugg")].map((c) => c.dataset.name));
  check("brands named in the answers but not on the list are offered", sugg.length >= 2 && !sugg.includes(undefined), sugg.join(", "));
  const first = sugg[0];
  await page.click(`#cbSuggest .cb-sugg[data-name="${first}"] .tag-add`);
  await page.waitForTimeout(2500);
  let p = await profile();
  check("one click adds it", p.competitors.some((c) => c.name === first), p.competitors.map((c) => c.name).join(", "));
  check("the campaign stays locked", p.locked === true);
  check("logged", (p.changes || []).some((c) => c.kind === "competitor-added" && c.name === first));
  const sugg2 = await page.evaluate(() => [...document.querySelectorAll("#cbSuggest .cb-sugg")].map((c) => c.dataset.name));
  check("the other suggestions stay, without the one added", sugg2.length >= 1 && !sugg2.includes(first) && sugg.slice(1).every((n) => sugg2.includes(n)), sugg2.join(", "));
  await page.evaluate(() => document.querySelector('.cv-tab[data-section="cv-brands"]')?.click());
  await page.waitForTimeout(500);
  check("the leaderboard now lists it as a competitor", await page.evaluate((n) => [...document.querySelectorAll(".cv-lead .cv-tr")].some((r) => r.dataset.brand === n && !r.querySelector(".auto-tag")), first));

  console.log("\n3. the board says what changed");
  const note = await page.evaluate(() => ({ sum: document.querySelector("#cbChanges summary")?.textContent || "", items: [...document.querySelectorAll("#cbChanges li")].map((l) => l.textContent) }));
  check("a change note with the competitor added", /1 change/.test(note.sum) && note.items.some((t) => t.includes(`Added competitor ${first}`)), JSON.stringify(note));

  console.log("\n2. + Add on the leaderboard");
  // A campaign without competitors counts the brands the answers name; the
  // leaderboard marks them "found in answers" and offers + Add.
  await msg({ type: "geo-profile-save", profile: { ...p, competitors: [] } });
  await page.evaluate(() => document.querySelector('[data-tab="analyze"]')?.click());
  await openBoard();
  await page.evaluate(() => document.querySelector('.cv-tab[data-section="cv-brands"]')?.click());
  await page.waitForTimeout(500);
  const autoRow = await page.evaluate(() => { const r = [...document.querySelectorAll(".cv-lead .cv-tr")].find((x) => x.querySelector(".row-add")); return r ? r.dataset.brand : null; });
  check("a found-in-answers row has + Add", !!autoRow);
  if (autoRow) {
    await page.click(`.cv-lead .cv-tr[data-brand="${autoRow}"] .row-add`);
    await page.waitForTimeout(2500);
    p = await profile();
    check("which adds it", p.competitors.some((c) => c.name === autoRow) && p.locked, p.competitors.map((c) => c.name).join(", "));
  }

  console.log("\n4. prompts: primary and secondary tags");
  await page.click('#cpHead button:has-text("Edit setup")');
  await page.waitForTimeout(800);
  const head = await page.evaluate(() => [...document.querySelectorAll(".prompt-table th")].map((t) => t.textContent));
  check("the prompt list has Primary tag and Secondary tags columns", head.includes("Primary tag") && head.includes("Secondary tags"), head.join("|"));
  const twoTags = await page.evaluate(() => { const r = [...document.querySelectorAll(".prompt-table tr")].find((tr) => tr.querySelector(".prompt-sec .tag")); return r ? { pri: r.querySelector(".prompt-pri .tag")?.firstChild?.textContent, sec: r.querySelector(".prompt-sec .tag .tag-label")?.textContent, text: r.querySelector(".prompt-cell")?.textContent } : null; });
  check("a prompt with two tags shows its first as primary", twoTags && twoTags.pri === "buying" && twoTags.sec === "tv", JSON.stringify(twoTags));
  // Make the secondary primary.
  await page.evaluate(() => { const r = [...document.querySelectorAll(".prompt-table tr")].find((tr) => tr.querySelector(".prompt-sec .tag")); r.querySelector(".prompt-sec .tag-label").click(); });
  await page.waitForTimeout(1500);
  let prompts = (await msg({ type: "geo-prompt-list", profileId: p.id })).prompts;
  const tv = prompts.find((x) => x.text === "best tv to buy");
  check("a secondary tag made primary", tv && tv.tags.join("|") === "tv|buying", tv && tv.tags.join("|"));
  // Take one tag off one prompt.
  await page.evaluate(() => { const r = [...document.querySelectorAll(".prompt-table tr")].find((tr) => /best tv to buy/.test(tr.textContent)); r.querySelector(".prompt-sec .tag-x").click(); });
  await page.waitForTimeout(1500);
  prompts = (await msg({ type: "geo-prompt-list", profileId: p.id })).prompts;
  check("one tag taken off one prompt; the others keep theirs", prompts.find((x) => x.text === "best tv to buy").tags.join("|") === "tv" && prompts.filter((x) => (x.tags || []).includes("buying")).length >= 1, prompts.map((x) => `${x.text}:${x.tags}`).join(" · "));
  p = await profile();
  check("tag changes on a locked campaign are logged", (p.changes || []).some((c) => c.kind === "tags"));
  // The role filter.
  await page.selectOption("#csTagRole", "secondary");
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll(".tag-sidebar-label")].find((b) => b.textContent === "buying")?.click());
  await page.waitForTimeout(500);
  const rowsSec = await page.evaluate(() => document.querySelectorAll(".prompt-table tr").length - 1);
  await page.selectOption("#csTagRole", "primary");
  await page.waitForTimeout(500);
  const rowsPri = await page.evaluate(() => document.querySelectorAll(".prompt-table tr").length - 1);
  check("filtering a tag as primary or as secondary gives different prompts", rowsPri >= 1 && rowsSec === 0, `${rowsPri} as primary, ${rowsSec} as secondary`);

  console.log("\nthe Excel template");
  await page.evaluate(() => document.querySelector('.cs-mode[data-mode="upload"]')?.click());
  await page.waitForTimeout(300);
  const dl = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await page.click("#csTemplateXlsx").catch(() => {});
  const d = await dl;
  check("Download the Excel template saves an .xlsx", d && d.suggestedFilename() === "prompts-template.xlsx", d && d.suggestedFilename());
  if (d) {
    const rows = await parseXlsx(readFileSync(await d.path()).buffer);
    const back = rowsToPrompts(rows);
    check("with Prompt, Primary tag and Secondary tag, reading back with the primary first", rows[0].join("|") === "Prompt|Primary tag|Secondary tag" && back[0].tags[0] === "Buying guide", rows[0].join("|"));
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
