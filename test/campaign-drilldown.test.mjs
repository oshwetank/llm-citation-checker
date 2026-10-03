/*
 * campaign-drilldown.test.mjs — the campaign surfaces must SAY something when
 * the user hasn't configured competitors, and a source row must be drillable.
 *
 * Reported: "why is it that the domains are no more clickable, and while urls
 * are clickable they provide limited informations, we had much more things in
 * the 26v. Also if i have not added competition should not the cited brands
 * become my competiton automatically?"
 *
 * Those two complaints are one bug. Every brand-facing number on the Dashboard
 * — Share of Voice, Position, the Brands column in the drill-down — was
 * computed against trackedBrandsOf(profile). With no competitors configured
 * that set is the own brand alone, so Share of Voice was 100% by construction,
 * Position was always #1, and the drill-down's Brands column showed one name.
 * The campaign looked empty because it WAS measuring nothing.
 *
 * This runs in a real browser against real captures rather than asserting on
 * a render function, because what was reported is what appears on screen.
 *
 * The campaign is seeded straight into IndexedDB: a real run would have to
 * drive live ChatGPT and Gemini sessions, which a test cannot do. The captures
 * themselves are genuine — adapted from the same fixtures the rest of the
 * suite uses — and only the geo provenance a run would have stamped is added.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-drilldown-test";

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
  console.log("\ncampaign-drilldown: CANNOT RUN — playwright is not installed.");
  console.log(`This guards reported regressions, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

/* Open the extension's own database from the panel page and turn the captures
 * already stored there into a campaign: one profile with a brand and NO
 * competitors, one tracked prompt per capture, and the geo bag a real run
 * would have stamped on each derived record. */
const SEED_CAMPAIGN = async () => {
  const open = () => new Promise((res, rej) => {
    // No version argument on purpose. Hardcoding one (this said 4) breaks with
    // a VersionError the moment db.js adds a store and bumps DB_VERSION —
    // which it did, for the error log. Opening without a version attaches to
    // whatever the extension has already created, which is what a seed wants.
    const r = indexedDB.open("lcfc");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const db = await open();
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const all = (store) => new Promise((res) => { const r = tx(store, "readonly").getAll(); r.onsuccess = () => res(r.result); });
  const put = (store, v) => new Promise((res) => { const r = tx(store, "readwrite").put(v); r.onsuccess = () => res(); });

  const derived = await all("derived");
  if (!derived.length) return { error: "no captures were stored" };

  // The own brand is a name these answers actually use, so mention/position
  // are real numbers rather than a guaranteed zero.
  const counts = new Map();
  for (const rec of derived) for (const b of rec.brandMentions || []) {
    counts.set(b.brand, (counts.get(b.brand) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { error: "no brands detected in any capture" };
  // Prefer a brand that ALSO appears as a longer variant somewhere ("Motorola"
  // alongside "Motorola Edge 70 Fusion"), because that is the case that broke:
  // the SKU was proposed as a rival of its own maker.
  const names = ranked.map(([n]) => n);
  const withSku = names.find((n) =>
    names.some((o) => o !== n && o.toLowerCase().startsWith(n.toLowerCase() + " ")));
  const ownBrand = withSku || names[0];
  const ownSkus = names.filter((o) => o !== ownBrand
    && o.toLowerCase().startsWith(ownBrand.toLowerCase() + " "));

  const profileId = crypto.randomUUID();
  await put("profiles", {
    id: profileId,
    name: "Drilldown Test",
    brand: { name: ownBrand, url: "example.com" },
    competitors: [],                 // the whole point
    engines: ["chatgpt", "gemini"],
    locked: false,
    createdAt: Date.now(),
    lastRunAt: Date.now(),
    deletedAt: null,
  });

  const runId = crypto.randomUUID();
  for (const rec of derived) {
    const promptId = crypto.randomUUID();
    await put("trackedPrompts", {
      id: promptId, profileId,
      text: rec.userPrompt || `capture ${rec.captureId}`,
      tags: [], active: true, createdAt: Date.now(),
    });
    await put("derived", { ...rec, geo: { profileId, runId, promptId, tags: [] } });
  }
  return { ownBrand, ownSkus, profileId, captures: derived.length };
};

async function seedFixtures(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(600);
  const files = readdirSync(FIXDIR).filter((f) => f.endsWith(".txt")).sort();
  for (const f of files) {
    const raw = readFileSync(path.join(FIXDIR, f), "utf8");
    const isGemini = f.startsWith("gemini");
    await page.evaluate(
      async ({ raw, isGemini }) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: "raw-conversation",
            payload: {
              raw, reqBody: "{}",
              pageUrl: isGemini ? "https://gemini.google.com/app" : "https://chatgpt.com/",
              capturedAt: Date.now(),
            },
          }, resolve);
        }),
      { raw, isGemini }
    );
    await page.waitForTimeout(80);
  }
  const seeded = await page.evaluate(SEED_CAMPAIGN);
  await page.close();
  return seeded;
}

// Start from an empty browser profile every run. Seeding re-stamps every
// stored capture onto a fresh campaign id, so a leftover profile from a
// previous run would leave an older, now-empty campaign in the picker and the
// test would measure that one.
rmSync(PROFILE_BASE, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const seeded = await seedFixtures(context, extId);
  if (seeded.error) {
    console.log(`\ncampaign-drilldown: CANNOT RUN — ${seeded.error}`);
    process.exit(1);
  }
  console.log(`\nseeded: ${seeded.captures} captures, own brand "${seeded.ownBrand}", no competitors configured`);
  if (seeded.ownSkus.length) console.log(`  own-brand SKUs in the corpus: ${seeded.ownSkus.join(", ")}`);

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);

  // The campaign's results: under the campaign in Campaigns. Since 0.50.0 they
  // are one board (#campaignResults) of sections — brands, kinds of answer,
  // prompts, sources — instead of a metrics card and a prompt table.
  await page.click('[data-tab="loader"]').catch(() => {});
  await page.waitForTimeout(600);
  const picked = await page.evaluate(() => {
    const chip = [...document.querySelectorAll("#loader .geo-chip")].find((b) => /Drilldown Test/.test(b.textContent));
    if (!chip) return false;
    chip.click();
    return true;
  });
  check("the seeded campaign can be opened in Campaigns", picked);
  await page.waitForTimeout(2500);
  check("its results show below it", await page.evaluate(() => !!document.querySelector("#loader #campaignResults #cb-kpis")));

  // One row per brand in the board's brand table.
  const brandRows = () => page.evaluate(() => [...document.querySelectorAll("#cb-brands .cb-brand-row")].map((r) => ({
    name: r.getAttribute("data-brand") || "",
    own: r.classList.contains("own-brand"),
    auto: !!r.querySelector(".auto-tag"),
    sov: r.querySelectorAll('[role="cell"]')[1]?.textContent || "",
    removable: !!r.querySelector(".row-x"),
  })));
  const settle = (ms = 1600) => page.waitForTimeout(ms);

  console.log("\ncompetitors inferred from the captures");
  {
    const banner = await page.evaluate(() => {
      const n = document.querySelector(".auto-comp-banner");
      if (!n) return null;
      return {
        text: n.textContent,
        chips: [...n.querySelectorAll(".tag")].map((t) => t.textContent),
        hasSaveButton: [...n.querySelectorAll("button")].some((b) => /Save these as competitors/i.test(b.textContent)),
      };
    });
    check("the inference is stated on screen, not applied silently", !!banner);
    if (banner) {
      check("it names the brands it is using", banner.chips.length > 0, banner.chips.join(", "));
      check("it says nothing was written to the campaign", /Nothing has been saved/i.test(banner.text));
      check("it offers to save them, rather than saving them", banner.hasSaveButton);
    }

    const table = await brandRows();
    check("the brand table has competitors in it, not just the own brand",
      table.length > 1, `${table.length} rows`);
    check("inferred rows are labelled as inferred",
      table.some((r) => r.auto), table.map((r) => `${r.name}${r.auto ? "*" : ""}`).join(", "));
    const own = table.find((r) => r.own);
    check("the own brand row is there and not labelled inferred",
      own && !own.auto, own && own.name);
    // The bug, stated as an assertion: with only the own brand tracked, Share
    // of Voice is 100% no matter what the answers said.
    check("Share of Voice is a real number rather than 100% by construction",
      own && !/^\s*100(\.0+)?%/.test(own.sov), own && own.sov);
  }

  console.log("\nyour own SKUs are not your competitors");
  {
    // Reported: "why is Motorola Edge 70 Fusion considered as a new brand
    // entirely". The own brand was skipped BEFORE the SKU-collapse map was
    // built, so its own products had no root to collapse onto and were
    // proposed as rivals — taking share of voice off their own maker.
    const table = await brandRows();
    const own = seeded.ownBrand.toLowerCase();
    const leaked = table.filter((r) => !r.own && r.name.toLowerCase().startsWith(own + " ")).map((r) => r.name);
    check(`no SKU of ${seeded.ownBrand} is listed as a competitor`,
      leaked.length === 0, leaked.join(", ") || "none");
    check("the own brand itself is still there", table.some((r) => r.own), table.map((r) => r.name).join(" | "));
  }

  console.log("\nbrands you don't compete with can be removed");
  {
    // An inferred brand: removing a typed competitor asks first, which a
    // headless run can't answer.
    const victim = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#cb-brands .cb-brand-row")].find((r) => r.querySelector(".auto-tag") && r.querySelector(".row-x"));
      if (!row) return null;
      row.querySelector(".row-x").click();
      return row.getAttribute("data-brand");
    });
    check("an inferred row offers a remove control", !!victim, String(victim));
    if (victim) {
      await settle();
      const names = (await brandRows()).map((r) => r.name);
      const excluded = await page.evaluate(() => [...document.querySelectorAll(".excluded-row .tag")].map((t) => t.textContent.replace("↺", "").trim()));
      // Not a row-count assertion: the inference is capped, so removing one
      // brand promotes the next one in — the table can legitimately stay the
      // same length. What must be true is that this brand is gone.
      check("it disappears from the brand table", !names.includes(victim), names.join(", "));
      check("and is listed as left out, so the change is visible", excluded.includes(victim), excluded.join(", "));

      // An exclusion you cannot undo is a trap.
      await page.evaluate(() => document.querySelector(".excluded-row .tag-x")?.click());
      await settle();
      const restored = (await brandRows()).map((r) => r.name);
      check("restoring it brings it back", restored.includes(victim), restored.join(", "));
    }
  }

  console.log("\nthe campaign view can be pointed at any brand");
  {
    // A dropdown rather than chips: twenty tracked brands is a realistic
    // campaign, and a wrapping chip row would push the numbers off screen at
    // exactly the point the campaign gets interesting.
    const sw = await page.evaluate(() => {
      const sel = document.querySelector("#campaignResults .brand-picker");
      if (!sel) return null;
      return {
        options: [...sel.options].map((o) => o.textContent),
        groups: [...sel.querySelectorAll("optgroup")].map((g) => g.label),
        selected: sel.options[sel.selectedIndex]?.textContent || "",
      };
    });
    check("the brand selector is a dropdown, so it survives many brands", !!sw);
    check("every tracked brand is an option", sw && sw.options.length > 1, sw && String(sw.options.length));
    // Your brand, then the competitors you typed, then the ones found in the
    // answers — this campaign has none typed, so two groups.
    check("your brand and competitors are grouped",
      sw && sw.groups[0] === "Your brand" && sw.groups.length >= 2 && sw.groups.slice(1).every((g) => /^(Competitors|Found in the answers)/.test(g)),
      sw && sw.groups.join(" | "));
    check("each option carries its visibility, so the list is still a ranking",
      sw && sw.options.every((o) => /\d+(\.\d+)?%$/.test(o.trim())), sw && sw.options[0]);
    check("it starts on the own brand", /\(you\)/.test(sw?.selected || ""), sw?.selected);

    const target = await page.evaluate(() => {
      const sel = document.querySelector("#campaignResults .brand-picker");
      const opt = [...sel.options].find((o) => !/\(you\)/.test(o.textContent));
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return opt.value;
    });
    check("a competitor can be selected", !!target, String(target));
    if (target) {
      await settle();
      const after = await page.evaluate(() => ({
        active: document.querySelector("#campaignResults .brand-picker")?.value || "",
        title: document.getElementById("cb-kpis-h")?.textContent || "",
        hint: document.querySelector("#cb-kpis .cb-hint")?.textContent || "",
        focusedRow: document.querySelector("#cb-brands .cb-brand-row.focused-brand")?.getAttribute("data-brand") || "",
        ppTitle: [...document.querySelectorAll('#cb-prompts [role="columnheader"]')].map((h) => h.textContent).join(" | "),
      }));
      check("the switcher follows the click", after.active === target, after.active);
      // The headline numbers must name the brand they are about.
      check("the headline numbers name the brand they describe",
        after.title.includes(target) && after.hint.includes(target), `${after.title} · ${after.hint}`);
      check("the brand table highlights the selected row", after.focusedRow === target, after.focusedRow);
      check("the prompt-by-prompt grid re-points at it too", after.ppTitle.includes(target), after.ppTitle);

      // ...and must not say "your" about a competitor, on any of the focus
      // tabs: the tiles are written for your own brand ("Your cards", "cite
      // you"), and 0.50.0's first build left the labels saying it.
      const tabs = await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .cb-focus-tab")].map((t) => t.textContent));
      const said = [];
      for (let i = 0; i < tabs.length; i++) {
        await page.evaluate((i) => document.querySelectorAll("#cb-kpis .cb-focus-tab")[i]?.click(), i);
        await settle(1200);
        const txt = await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .k-label, #cb-kpis .k-sub")].map((k) => k.textContent));
        said.push(...txt.filter((x) => /\byou(r)?\b/i.test(x)).map((x) => `${tabs[i]}: ${x}`));
      }
      check("and no tile calls a competitor \"you\" or \"your\"", said.length === 0, said.join(" | "));
      await page.evaluate(() => document.querySelector("#cb-kpis .cb-focus-tab")?.click());
      await settle(1200);

      // Back to your own brand for everything after this.
      await page.evaluate(() => {
        const sel = document.querySelector("#campaignResults .brand-picker");
        sel.value = [...sel.options].find((o) => /\(you\)/.test(o.textContent)).value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle();
    }
  }

  console.log("\nthe headline numbers, one focus at a time");
  {
    // Until 0.49.0 this asserted "four headline numbers, not six", with the
    // source numbers and capture counts folded into a closed disclosure — the
    // reported clutter was twelve tiles above the fold. The 0.50.0 board
    // answers that complaint differently: the tiles are grouped by what the
    // answer showed (mentions, citations, product cards, images, map pins) and
    // one group is on screen at a time, with the brand-visibility numbers
    // first. The source numbers and capture counts get their own sections
    // instead of a disclosure. What this guards is the same: the brand's
    // visibility is what you see first, and nothing was dropped to get there.
    const k = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll("#cb-kpis .cb-focus-tab")].map((t) => t.textContent),
      on: document.querySelector("#cb-kpis .cb-focus-tab.on")?.textContent || "",
      labels: [...document.querySelectorAll("#cb-kpis .k-label")].map((x) => x.textContent),
      source: document.getElementById("cb-source")?.textContent || "",
      collected: document.getElementById("cb-collected")?.textContent || "",
    }));
    check("the numbers are grouped by what the answers showed",
      ["Mentions", "Citations", "Product cards", "Images", "Map listings"].every((t) => k.tabs.includes(t)), k.tabs.join(" | "));
    check("it opens on mentions", k.on === "Mentions", k.on);
    check("led by the brand-visibility numbers",
      k.labels.slice(0, 4).join("|") === "Visibility|Share of voice|Avg position|Mentions", k.labels.join(" | "));
    check("your site as a source has its own section",
      /Source visibility/.test(k.source) && /Citations/.test(k.source), k.source.slice(0, 120));
    check("and so do the capture counts",
      /Answers captured/.test(k.collected) && /Searches the engines ran/.test(k.collected), k.collected.slice(0, 120));

    await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .cb-focus-tab")].find((t) => t.textContent === "Citations")?.click());
    await settle(1200);
    const cit = await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .k-label")].map((x) => x.textContent));
    check("the Citations focus swaps in the source numbers",
      cit.includes("Source visibility") && cit.includes("Citation share"), cit.join(" | "));
    await page.evaluate(() => document.querySelector("#cb-kpis .cb-focus-tab")?.click());
    await settle(1200);

    // Only meaningful with more than one engine to compare — with one engine
    // it would just be the headline numbers again.
    const engines = await page.evaluate(() => document.querySelectorAll('#cb-prompts [role="columnheader"] .ap-sr').length);
    const split = await page.evaluate(() => [...document.querySelectorAll("#cb-by-engine .cb-engine-row")].map((r) => r.textContent));
    if (engines > 1) {
      check("the selected brand is broken down per engine", split.length === engines, `${split.length} rows for ${engines} engines`);
      check("each engine shows its visibility and average position",
        split.every((r) => /\d+%/.test(r) && /avg/.test(r)), split.join(" | "));
    } else {
      check(`only one engine in this data (${engines}) — the per-engine split has one row`, split.length <= 1);
    }
  }

  console.log("\nclicking a competitor gives you something to analyse");
  {
    // Reported: "when I click on any brand I don't get to know much about
    // that competition's visibility, I don't get data to analyse it." Since
    // 0.50.0 a brand opens its own page in place of the board (it was a modal).
    const clicked = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#cb-brands .cb-brand-row")].find((r) => !r.classList.contains("own-brand"));
      if (!row) return null;
      row.querySelector(".cb-brand-btn").click();
      return row.getAttribute("data-brand");
    });
    check("a competitor's name opens its detail", !!clicked, String(clicked));
    if (clicked) {
      await settle(2000);
      const m = await page.evaluate(() => {
        const t = document.getElementById("cb-detail-h");
        if (!t) return null;
        return {
          title: t.textContent,
          stats: [...document.querySelectorAll(".cb-vs .k-label")].map((x) => x.textContent),
          h2h: [...document.querySelectorAll("#cb-h2h .cb-h2h-row")].map((x) => ({ l: x.children[0]?.textContent, n: x.querySelector(".num")?.textContent })),
          lead: document.querySelector("#cb-h2h .cb-sec-head .muted")?.textContent || "",
          engines: document.querySelectorAll('#cb-vs-engines .cb-tr:not(.cb-th)').length,
          sources: !!document.getElementById("cb-vs-sources"),
          sourceBtns: document.querySelectorAll("#cb-vs-sources button.td-domain-btn").length,
          prompts: [...document.querySelectorAll("#cb-vs-prompts .cb-win")].map((x) => x.textContent),
        };
      });
      check("the detail opens", !!m);
      if (m) {
        check("titled for the brand, against yours", m.title.startsWith(clicked) && m.title.includes(seeded.ownBrand), m.title);
        check("it leads with the two brands' numbers side by side",
          ["Visibility", "Share of voice", "Avg position"].every((x) => m.stats.includes(x)), m.stats.join(" | "));

        // The comparison the table behind it cannot express.
        check("it counts answers that named them and not you — the gap",
          m.h2h.some((x) => x.l === `Only ${clicked}`), m.h2h.map((x) => `${x.l}=${x.n}`).join(", "));
        check("and answers that named you and not them, both, and neither",
          m.h2h.length === 4, m.h2h.map((x) => x.l).join(", "));
        check("when both appear, it says who was named first",
          /first in \d+/.test(m.lead), m.lead);

        check("the brand is broken down per engine", m.engines > 1, String(m.engines));
        check("the sources cited when it is named are listed", m.sources);
        // Requested: the same drill-down a domain gets in the campaign's own
        // sources table. A domain means the same thing wherever it is shown,
        // so it should answer the same question.
        check("those domains are clickable, like everywhere else", m.sourceBtns > 0, String(m.sourceBtns));

        // Per prompt and engine, which of the two came first — a row is a
        // comparison, not an isolated fact.
        check("a prompt-by-prompt comparison is present", m.prompts.length > 0, String(m.prompts.length));
        check("each cell names who came first",
          m.prompts.every((x) => [clicked, seeded.ownBrand, "both", "neither"].includes(x)), m.prompts.join(", "));
      }
      // Clicking one must land in the domain drill-down, not just look like a
      // link — the two paths derive the row through the same aggregation, so
      // they cannot report different numbers for the same domain.
      if (m && m.sourceBtns) {
        await page.evaluate(() => document.querySelector("#cb-vs-sources button.td-domain-btn").click());
        await settle(1500);
        const dom = await page.evaluate(() => {
          const b = document.getElementById("url-modal-backdrop");
          if (!b) return null;
          return {
            title: b.querySelector(".modal-title")?.textContent || "",
            stats: [...b.querySelectorAll(".modal-statgrid .l")].map((x) => x.textContent),
            pages: b.querySelectorAll(".url-drill-item").length,
          };
        });
        check("clicking one opens the domain drill-down", !!dom && /\./.test(dom.title), dom && dom.title);
        check("with the same reach/volume split the campaign table uses",
          dom && dom.stats.includes("Visibility") && dom.stats.includes("Citations"),
          dom && dom.stats.join(" | "));
        check("and the pages behind it", dom && dom.pages > 0, dom && String(dom.pages));
        await page.evaluate(() => document.getElementById("url-modal-backdrop")?.remove());
      }
      await page.evaluate(() => document.querySelector(".cb-detail-head .analyze-context-back")?.click());
      await settle();
      check("and the back button returns to the board", await page.evaluate(() => !!document.getElementById("cb-kpis") && !document.getElementById("cb-detail-h")));
    }
  }

  console.log("\nchanging the engine changes the campaign");
  {
    // Reported: "when I change the model the data in the campaign doesn't
    // change at all. Nothing changes." It didn't: the Dashboard's Model
    // select drove only the ad-hoc record list, while the campaign section
    // read a SEPARATE variable set by its own duplicate dropdown.
    const before = await page.evaluate(() => ({
      kpis: [...document.querySelectorAll("#cb-kpis .k-value")].map((k) => k.textContent),
      // One engine control for the results, not two with the same word on
      // them. Other selects (the run, the brand) are legitimately there.
      engineSelects: [...document.querySelectorAll("#campaignResults select")]
        .filter((sel) => [...sel.options].some((o) => /all engines|all models|chatgpt|gemini/i.test(o.textContent)))
        .length,
    }));
    check("the results have exactly one engine filter", before.engineSelects === 1, `${before.engineSelects} engine select(s)`);

    const switched = await page.evaluate(() => {
      const sel = document.querySelector('#campaignResults select[aria-label="Engine"]');
      const opt = sel && [...sel.options].find((o) => o.value === "chatgpt");
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    check("ChatGPT can be selected", switched);
    if (switched) {
      await settle(1800);
      const after = await page.evaluate(() => ({
        kpis: [...document.querySelectorAll("#cb-kpis .k-value")].map((k) => k.textContent),
        scope: document.querySelector("#campaignResults .scope-note")?.textContent || "",
        engineSplit: document.querySelectorAll("#cb-by-engine .cb-engine-row").length,
      }));
      check("the campaign's numbers actually change",
        after.kpis.join("|") !== before.kpis.join("|"),
        `${before.kpis.join(", ")}  ->  ${after.kpis.join(", ")}`);
      check("and the board says which engine it is scoped to", /ChatGPT/i.test(after.scope), after.scope);
      // With the view narrowed to one engine there is nothing to compare.
      check("the per-engine split is down to that one engine", after.engineSplit <= 1, String(after.engineSplit));

      // Put it back so the sections after this measure the full data set.
      await page.evaluate(() => {
        const sel = document.querySelector('#campaignResults select[aria-label="Engine"]');
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settle(1800);
      const restored = await page.evaluate(() => [...document.querySelectorAll("#cb-kpis .k-value")].map((k) => k.textContent));
      check("and clearing the filter restores the full numbers",
        restored.join("|") === before.kpis.join("|"),
        `${restored.join(", ")} vs ${before.kpis.join(", ")}`);
    }
  }

  console.log("\nmetric definitions are available wherever a metric is shown");
  {
    const terms = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[data-term]")];
      return {
        count: nodes.length,
        keys: [...new Set(nodes.map((n) => n.getAttribute("data-term")))],
        cursor: nodes[0] ? getComputedStyle(nodes[0]).cursor : "",
      };
    });
    check("metric labels are marked up for definitions",
      terms.count > 10, `${terms.count} elements, ${terms.keys.length} distinct terms`);
    check("headline metrics are among them",
      ["visibility", "shareOfVoice", "avgPosition", "mentions"].every((k) => terms.keys.includes(k)),
      terms.keys.join(", "));
    check("source metrics are among them",
      ["domainVisibility", "domainCitations", "readOnly"].every((k) => terms.keys.includes(k)),
      terms.keys.join(", "));
    check("and they signal that they explain themselves", terms.cursor === "help", terms.cursor);

    // The tooltip itself: same four slots, every time.
    const tip = await page.evaluate(async () => {
      const t = document.querySelector('[data-term="visibility"]');
      if (!t) return null;
      t.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2600));
      const el = document.querySelector(".app-tooltip");
      if (!el || el.style.display === "none") return { shown: false };
      return {
        shown: true,
        term: el.querySelector(".tip-term")?.textContent || "",
        what: el.querySelector(".tip-what")?.textContent || "",
        formula: el.querySelector(".tip-formula")?.textContent || "",
        note: el.querySelector(".tip-note")?.textContent || "",
      };
    });
    check("hovering a metric for ~2s shows a definition", tip && tip.shown, JSON.stringify(tip));
    if (tip && tip.shown) {
      check("it names the term", /Visibility/i.test(tip.term), tip.term);
      check("it says what the metric measures", tip.what.length > 20, tip.what);
      check("it gives the formula", /÷/.test(tip.formula), tip.formula);
      check("and the caveat that stops it being misread", tip.note.length > 20, tip.note);
      check("and never names another product",
        !/peec/i.test(JSON.stringify(tip)), JSON.stringify(tip));
    }
    await page.evaluate(() => document.querySelector(".app-tooltip")?.remove());
  }

  console.log("\ndomains report reach and volume as separate numbers");
  {
    const src = await page.evaluate(() => {
      const heads = [...document.querySelectorAll("#cb-sources .src-table th")].map((t) => t.textContent);
      const first = document.querySelector("#cb-sources .src-table tr:nth-child(2)");
      return {
        heads,
        bar: first?.querySelector(".src-bar-n")?.textContent || "",
        barTitle: first?.querySelector(".src-bar")?.getAttribute("title") || "",
      };
    });
    check("Visibility is a column", src.heads.some((h) => h.includes("Visibility")), src.heads.join(" | "));
    check("Citations is a separate column", src.heads.some((h) => h.includes("Citations")), src.heads.join(" | "));
    check("the bar shows the percentage, which is what a 0-100 bar can honestly show",
      /%$/.test(src.bar), src.bar);
    check("and says what it is a percentage OF",
      /of \d+ responses/.test(src.barTitle), src.barTitle);
  }

  console.log("\nsource rows drill down — domains as well as URLs");
  {
    const domainBtns = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("#cb-sources .drill-table td.td-domain button")];
      return { count: btns.length, first: btns[0]?.textContent || "" };
    });
    check("domain rows are clickable", domainBtns.count > 0, `${domainBtns.count} clickable`);

    // What was actually reported. They were clickable before too — the only
    // affordance was on :hover, so at rest a domain looked like plain text.
    const affordance = await page.evaluate(() => {
      const b = document.querySelector("#cb-sources .drill-table td.td-domain button");
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { deco: cs.textDecorationLine, cursor: cs.cursor };
    });
    check("a domain looks clickable before the pointer reaches it",
      affordance && affordance.deco.includes("underline"), affordance && affordance.deco);
    check("and takes a pointer cursor", affordance && affordance.cursor === "pointer",
      affordance && affordance.cursor);

    if (domainBtns.count) {
      await page.evaluate(() =>
        document.querySelector("#cb-sources .drill-table td.td-domain button").click());
      await page.waitForTimeout(1200);

      const modal = await page.evaluate(() => {
        const b = document.getElementById("url-modal-backdrop");
        if (!b) return null;
        return {
          title: b.querySelector(".modal-title")?.textContent || "",
          stats: [...b.querySelectorAll(".modal-statgrid .stat")].map((s) => s.textContent),
          pages: b.querySelectorAll(".url-drill-item").length,
        };
      });
      check("clicking a domain opens a drill-down", !!modal);
      if (modal) {
        check("it is titled for the domain", /\./.test(modal.title), modal.title);
        check("it opens with a roll-up, not straight into a table",
          modal.stats.length >= 3, modal.stats.join(" | "));
        check("the pages the engines read from this host are listed",
          modal.pages > 0, `${modal.pages} pages`);
      }
      await page.evaluate(() => document.getElementById("url-modal-backdrop")?.remove());
    }
  }

  console.log("\nthe URL drill-down says how the page was used, not just that it appeared");
  {
    await page.evaluate(() => {
      const pill = [...document.querySelectorAll("#cb-sources .filter-pill")].find((p) => p.textContent === "URLs");
      pill?.click();
    });
    await page.waitForTimeout(900);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector("#cb-sources .drill-table td.td-domain button");
      if (!btn) return false;
      btn.click();
      return true;
    });
    check("URL rows are clickable", clicked);
    if (clicked) {
      await page.waitForTimeout(1200);
      const modal = await page.evaluate(() => {
        const b = document.getElementById("url-modal-backdrop");
        if (!b) return null;
        const rows = [...b.querySelectorAll(".drill-table tr")];
        return {
          title: b.querySelector(".modal-title")?.textContent || "",
          stats: [...b.querySelectorAll(".modal-statgrid .stat")].map((s) => s.textContent),
          headers: [...b.querySelectorAll("th")].map((t) => t.textContent),
          rows: rows.length - 1,
          firstRowBrands: [...(rows[1]?.querySelectorAll(".tag") || [])].map((t) => t.textContent),
          outcomes: [...b.querySelectorAll(".pp-chip")].map((o) => o.textContent),
          engines: [...b.querySelectorAll(".engine-chip, .engine-th")].length,
        };
      });
      check("the URL drill-down opens", !!modal);
      if (modal) {
        check("titled for a URL", /URL/.test(modal.title), modal.title);
        check("it has rows", modal.rows > 0, String(modal.rows));
        // v0.26 had Prompt / You / Brands / Date and nothing else — the
        // reported "limited informations".
        ["Prompt", "Engine", "Used as", "Position", "Brands", "Date"].forEach((h) =>
          check(`column "${h}" is present`, modal.headers.some((x) => x.includes(h)), modal.headers.join(" | ")));
        check("the cited / read-only split is in the roll-up",
          modal.stats.some((x) => /Cited/.test(x)) && modal.stats.some((x) => /Read-only/.test(x)),
          modal.stats.join(" | "));
        check("which engine produced each response is shown", modal.engines > 0, String(modal.engines));

        // Reported from this exact modal: "Gemini logo is missing" — the
        // ChatGPT rows showed their mark and the Gemini rows showed bare
        // text. Gemini's is the only mark painted with a gradient, and
        // `fill="url(#id)"` resolves against the WHOLE document: every copy
        // emitted the same id, so all of them pointed at whichever copy came
        // first in the DOM. Re-rendering a section destroys that node, and a
        // modal — which lives on document.body and is not re-rendered —
        // is left pointing at a gradient that no longer exists. The path then
        // paints with no fill: an invisible icon in a space that still takes
        // up room, which is what the screenshot showed.
        const icons = await page.evaluate(() => {
          const grads = [...document.querySelectorAll(".llm-icon linearGradient")].map((g) => g.id);
          return { count: grads.length, unique: new Set(grads).size, sample: grads.slice(0, 3) };
        });
        check("the gradient-painted mark renders more than once", icons.count > 1, String(icons.count));
        check("every instance owns its own gradient id",
          icons.count === icons.unique, `${icons.count} icons, ${icons.unique} distinct ids`);
        check("none uses a shared id", !icons.sample.includes("ck-gem"), icons.sample.join(", "));

        // The failure itself, reproduced: destroy the page section that owns
        // one gradient and check an icon living on document.body still paints.
        // The section is one of the board's (.cb-sec); the survivor is any
        // other copy, moved onto document.body the way a modal's is.
        const survived = await page.evaluate(() => {
          const gem = [...document.querySelectorAll(".llm-icon")].filter((i) => i.querySelector("linearGradient"));
          const owner = gem.map((i) => i.closest("#campaignResults .cb-sec")).find(Boolean);
          const survivor = owner && gem.find((i) => !owner.contains(i));
          if (!owner || !survivor) return { owner: !!owner, survivor: !!survivor };
          document.body.appendChild(survivor);
          owner.remove();
          const fill = survivor.querySelector("path")?.getAttribute("fill") || "";
          const gradId = fill.replace(/^url\(#/, "").replace(/\)$/, "");
          return { resolves: !!survivor.querySelector(`#${CSS.escape(gradId)}`), gradId };
        });
        check("an icon that outlives its section still resolves its fill",
          survived.resolves === true, JSON.stringify(survived));
        check("cited vs read-only is shown per response", modal.outcomes.length > 0, modal.outcomes.join(", "));
        check("brands are numbered by the order they appear in the answer",
          modal.firstRowBrands.length > 0 && modal.firstRowBrands.every((b) => /^\d+\. /.test(b)),
          modal.firstRowBrands.join(", "));
      }
    }
  }

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
