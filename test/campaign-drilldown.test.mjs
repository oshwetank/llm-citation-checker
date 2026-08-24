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
    const r = indexedDB.open("lcfc", 4);
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
  const ownBrand = ranked[0][0];

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
  return { ownBrand, profileId, captures: derived.length };
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

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);

  // Dashboard, campaign selected.
  await page.click('[data-tab="dashboard"]').catch(() => {});
  await page.waitForTimeout(600);
  const picked = await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => /Drilldown Test/.test(o.textContent)));
    if (!sel) return false;
    const opt = [...sel.options].find((o) => /Drilldown Test/.test(o.textContent));
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  check("the seeded campaign is selectable on the Dashboard", picked);
  await page.waitForTimeout(1500);

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

    const table = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#geoMetrics table tr")].slice(1);
      return rows.map((r) => ({
        name: r.cells[0]?.textContent || "",
        auto: !!r.cells[0]?.querySelector(".auto-tag"),
        sov: r.cells[2]?.textContent || "",
      }));
    });
    check("the brand table has competitors in it, not just the own brand",
      table.length > 1, `${table.length} rows`);
    check("inferred rows are labelled as inferred",
      table.some((r) => r.auto), table.map((r) => `${r.name}${r.auto ? "*" : ""}`).join(", "));
    check("the own brand row is not labelled inferred",
      table[0] && !table[0].auto, table[0] && table[0].name);
    // The bug, stated as an assertion: with only the own brand tracked, Share
    // of Voice is 100% no matter what the answers said.
    check("Share of Voice is a real number rather than 100% by construction",
      table[0] && !/^\s*100(\.0+)?%/.test(table[0].sov), table[0] && table[0].sov);
  }

  console.log("\nsource rows drill down — domains as well as URLs");
  {
    const domainBtns = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("#geoPromptTable .drill-table td.td-domain button")];
      return { count: btns.length, first: btns[0]?.textContent || "" };
    });
    check("domain rows are clickable", domainBtns.count > 0, `${domainBtns.count} clickable`);

    // What was actually reported. They were clickable before too — the only
    // affordance was on :hover, so at rest a domain looked like plain text.
    const affordance = await page.evaluate(() => {
      const b = document.querySelector("#geoPromptTable .drill-table td.td-domain button");
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
        document.querySelector("#geoPromptTable .drill-table td.td-domain button").click());
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
      const pill = [...document.querySelectorAll("#geoPromptTable .filter-pill")].find((p) => p.textContent === "URLs");
      pill?.click();
    });
    await page.waitForTimeout(900);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector("#geoPromptTable .drill-table td.td-domain button");
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
