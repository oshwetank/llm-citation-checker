/*
 * analyze-popup.test.mjs — the popup's Analyze screen (0.47.0), in a real
 * browser at the popup's real size (540 × 600).
 *
 * Reported on the design canvas, about the popup:
 *   1. "find a better and fix the font, and its style" — IBM Plex now ships
 *      inside the extension. It must actually be the face in use, and it
 *      must never be fetched from the web (the panel's no-network promise).
 *   2. "the box after the product card is also half cut from the bottom" —
 *      a box squeezed to fit the popup instead of the popup scrolling.
 *   3. "the searches (fan-out) is getting cut" — each search ended in an
 *      ellipsis inside a third-width column. They now sit directly under the
 *      prompt, one per line, in full.
 *   4. "the information it provides is less" — every brand, every cited page,
 *      what changed since last time, and a details sheet.
 * And Compare left the top menu: it is reached from the answer instead.
 *
 * On 0.46.0 this fails at the first checks: Compare is in the menu, the body
 * font is the system stack, and there is no #ap-searches at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-analyze-popup-test";

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
  console.log("\nanalyze-popup: CANNOT RUN — playwright is not installed.");
  console.log(`This guards reported popup regressions, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

// Every request any page makes, so the font check can prove nothing went out.
const requests = [];
context.on("request", (r) => requests.push(r.url()));

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  // Seed: one shopping answer captured twice (so there is a "previous" to
  // compare with, and two answers to the same prompt) and, between them, a
  // local answer with places. The prompts are made up; a fixture's prompt
  // comes from the request body, as on chatgpt.com.
  const SHOP = "best smartphone under 50000";
  const LOCAL = "jewellery shops near me";
  const body = (prompt) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [prompt] } }] });
  {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(600);
    const seed = [["chatgpt-phone-under.txt", SHOP, 3], ["chatgpt-jewellery-wedding.txt", LOCAL, 2], ["chatgpt-phone-under.txt", SHOP, 1]];
    for (const [f, prompt, hoursAgo] of seed) {
      const raw = readFileSync(path.join(FIXDIR, f), "utf8");
      const res = await page.evaluate(({ raw, reqBody, at }) => new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "raw-conversation",
          payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: at },
        }, resolve);
      }), { raw, reqBody: body(prompt), at: Date.now() - hoursAgo * 3600 * 1000 });
      if (!res || !res.captureId) throw new Error(`seeding ${f} stored nothing: ${JSON.stringify(res)}`);
      await page.waitForTimeout(150);
    }
    await page.close();
  }
  // A fresh install also loads sample answers, timestamped now, so "latest"
  // would be a sample. Open the newer of the two shopping answers by id, the
  // way the popup's own links do.
  const ids = await (async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    const out = await page.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: "get-records" }, (res) => {
      const recs = (res.records || []).filter((r) => r.platform === "chatgpt" && !String(r.captureId).startsWith("demo-"));
      resolve(recs.map((r) => ({ id: r.captureId, prompt: r.userPrompt, at: r.capturedAt })));
    })));
    await page.close();
    return out.sort((a, b) => b.at - a.at);
  })();
  const shopNewest = ids.find((r) => r.prompt === SHOP);
  const local = ids.find((r) => r.prompt === LOCAL);
  if (!shopNewest || !local) throw new Error("seeded captures not found: " + JSON.stringify(ids));

  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.setViewportSize({ width: 540, height: 600 });
  requests.length = 0;
  await page.goto(`chrome-extension://${extId}/ui/panel.html?capture=${encodeURIComponent(shopNewest.id)}`);
  await page.waitForTimeout(1800);

  console.log("\nTop menu: Compare is gone, reached from the answer instead");
  {
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".nav-tabs [data-tab]")].map((b) => b.dataset.tab));
    check("the menu is Analyze, Dashboard, Campaigns, About", tabs.join() === "analyze,dashboard,loader,about", tabs.join());
  }

  // Since 0.59.0 the default Studio theme sets Geist; Classic keeps IBM Plex.
  // Both ship inside the extension (theme-style.test.mjs checks Classic).
  console.log("\nTypeface: Geist (Studio, the default), from inside the extension");
  {
    const f = await page.evaluate(async () => {
      await document.fonts.ready;
      const body = getComputedStyle(document.body).fontFamily;
      const loaded = [...document.fonts].filter((x) => /^"?Geist"?$/.test(x.family) && x.status === "loaded").map((x) => x.family + " " + x.weight);
      return { body, loaded, check: document.fonts.check('500 12px "Geist"') };
    });
    check("the body's first font is Geist", /^"?Geist"?,/.test(f.body), f.body);
    check("the face has actually loaded (not a silent fallback)", f.loaded.length > 0 && f.check, JSON.stringify(f.loaded));
    const fontReqs = requests.filter((u) => /\.woff2?(\?|$)|fonts\.(googleapis|gstatic)\.com/.test(u));
    check("font files came from the extension itself", fontReqs.length > 0 && fontReqs.every((u) => u.startsWith(`chrome-extension://${extId}/fonts/`)), fontReqs.join(" | "));
    check("nothing was requested from Google Fonts", !requests.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)));
  }

  console.log("\nSearches it ran: right under the prompt, every one in full");
  {
    const s = await page.evaluate(() => {
      const ap = document.querySelector("#analyze .ap");
      if (!ap) return null;
      const kids = [...ap.children].filter((n) => !n.classList.contains("demo-banner"));
      const rows = [...document.querySelectorAll("#ap-searches .ap-fan-text")];
      return {
        order: kids.slice(0, 3).map((n) => n.id || n.className),
        rows: rows.length,
        cut: rows.filter((r) => r.scrollWidth > r.clientWidth + 1 || getComputedStyle(r).textOverflow === "ellipsis" || getComputedStyle(r).whiteSpace === "nowrap").map((r) => r.textContent),
        heading: document.querySelector("#ap-searches .ap-h")?.textContent || "",
      };
    });
    check("the popup Analyze layout is in use", !!s);
    if (s) {
      check("the searches are the first section after the prompt block", /^ap-head\b/.test(s.order[0]) && s.order[1] === "ap-searches", s.order.join(" > "));
      check("searches are listed", s.rows > 0, s.heading);
      check("no search is cut off or ellipsised", s.cut.length === 0, s.cut.join(" | "));
    }
  }

  console.log("\nNothing is squeezed or cut at the bottom; the popup scrolls instead");
  {
    const r = await page.evaluate(() => {
      const secs = [...document.querySelectorAll("#analyze .ap > section")];
      const clipped = secs.filter((sec) => {
        const b = sec.getBoundingClientRect().bottom;
        return [...sec.querySelectorAll("*")].some((c) => c.getBoundingClientRect().height > 0 && c.getBoundingClientRect().bottom > b + 1);
      }).map((s) => s.id);
      const content = document.querySelector(".app-content");
      return { n: secs.length, clipped, scrolls: content.scrollHeight > content.clientHeight + 10 };
    });
    check("several sections render", r.n >= 4, r.n);
    check("every section is tall enough for its content", r.clipped.length === 0, r.clipped.join(", "));
    check("the popup scrolls rather than shrinking boxes", r.scrolls);
  }

  console.log("\nMore information: every brand, every site and page, what changed");
  {
    const r = await page.evaluate(() => {
      const head = (id) => document.querySelector(`#${id} .ap-h`)?.textContent || "";
      return {
        brandHead: head("ap-brands"),
        brandRows: document.querySelectorAll("#ap-brands .ap-tr:not(.ap-th):not(.shown-only):not(.dropped)").length,
        sitesHead: head("ap-sites"),
        siteRows: document.querySelectorAll("#ap-sites .site-row").length,
        citedSites: document.querySelectorAll("#ap-sites .site-row.is-cited").length,
        pages: document.querySelectorAll("#ap-sites .site-pages li").length,
        legend: document.querySelectorAll("#ap-sites .ap-legend span").length,
        backedByColumn: [...document.querySelectorAll("#ap-brands .ap-th span")].some((x) => /Backed by/.test(x.textContent)),
        backingRows: document.querySelectorAll("#ap-backing .ap-backing-row").length,
        changes: document.querySelectorAll("#ap-changes li").length,
        facts: document.querySelector(".ap-facts")?.textContent || "",
      };
    });
    const nBrands = Number((r.brandHead.match(/·\s*(\d+)/) || [])[1]);
    check("the brand list has every named brand its heading counts", nBrands > 0 && r.brandRows === nBrands, `${r.brandRows} rows, heading "${r.brandHead}"`);
    // 0.58.0: "Pages cited" listed cited domains and put the rest on one line.
    // Now every site, cited first, each holding every page read there.
    const nSites = Number((r.sitesHead.match(/·\s*(\d+)/) || [])[1]);
    check("every site is listed, as the heading counts", nSites > 0 && r.siteRows === nSites, `${r.siteRows} rows, heading "${r.sitesHead}"`);
    check("including sites read but not cited", r.siteRows > r.citedSites && r.citedSites > 0, `${r.citedSites} of ${r.siteRows} cited`);
    check("each site holds its pages", r.pages >= r.siteRows, `${r.pages} pages`);
    check("cited pages are broken down by kind of site", r.legend > 0);
    check("the brand table no longer has a “Backed by” column", !r.backedByColumn);
    check("what backs each brand has its own section", r.backingRows > 0, r.backingRows);
    check("what changed since the previous answer is shown", r.changes > 0, r.changes);
    check("the answer's facts line is there", /Model/.test(r.facts), r.facts);
  }

  console.log("\nDetails sheet");
  {
    // Opened from part-way down, where the links are. Up to 0.47.0 the panel
    // kept a transform from its fade-in, which made it the sheet's containing
    // block: the "bottom sheet" sat at the bottom of the whole Analyze panel,
    // half below the popup's footer.
    await page.evaluate(() => { document.querySelector(".app-content").scrollTop = 400; });
    await page.waitForTimeout(200);
    await page.evaluate(() => [...document.querySelectorAll(".ap-links .ap-btn")].find((b) => b.textContent === "Technical")?.click());
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => {
      const s = document.querySelector(".ap-sheet");
      const r = s && s.getBoundingClientRect();
      const scrim = document.querySelector(".ap-scrim")?.getBoundingClientRect();
      return s ? { text: s.innerText, tabs: s.querySelectorAll(".ap-sheet-tab").length, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrimTop: scrim ? Math.round(scrim.top) : null } : null;
    });
    check("Technical opens the sheet", !!open && /Capture id/.test(open.text), open && open.text.slice(0, 80));
    check("the sheet sits on the bottom of the window, all of it on screen", !!open && Math.abs(open.bottom - open.vh) <= 1 && open.top > 0, open && `${open.top}..${open.bottom} of ${open.vh}`);
    check("its backdrop covers the whole popup", !!open && open.scrimTop === 0, open && open.scrimTop);
    await page.evaluate(() => document.querySelector(".ap-sheet-close")?.click());
    await page.waitForTimeout(200);
    check("× closes it", await page.evaluate(() => !document.querySelector(".ap-sheet")));
  }

  console.log("\nCompare, from the answer");
  {
    const btn = await page.evaluate(() => document.querySelector('.ap-links [data-open="compare"]')?.textContent || "");
    check("an answer asked twice offers 'All 2 answers to this prompt'", /All 2 answers/.test(btn), btn);
    await page.evaluate(() => document.querySelector('.ap-links [data-open="compare"]')?.click());
    await page.waitForTimeout(900);
    const c = await page.evaluate(() => ({
      active: document.querySelector(".panel.active")?.id,
      out: document.querySelector("#cmpOut")?.innerText || "",
    }));
    check("it opens the comparison for this prompt", c.active === "compare" && /run by run/i.test(c.out), `${c.active}: ${c.out.slice(0, 80)}`);
    await page.evaluate(() => document.querySelector("#cmpBack")?.click());
    await page.waitForTimeout(300);
    check("Back returns to the answer", await page.evaluate(() => document.querySelector(".panel.active")?.id) === "analyze");
    check("Compare opened on this prompt", /smartphone under 50000/.test(c.out), c.out.slice(0, 80));
  }

  console.log("\nA local answer: the map leads, places are named");
  {
    const ids = await page.evaluate(() => [...document.querySelectorAll(".nav-tabs [data-tab]")].length);
    // Page to the older capture (the local one sits between the two shopping ones).
    await page.evaluate(() => [...document.querySelectorAll(".ap-head .ap-icon-btn")].find((b) => b.getAttribute("aria-label") === "Older capture")?.click());
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      kind: document.querySelector(".ap-kind")?.textContent,
      places: document.querySelectorAll("#ap-places .ap-place").length,
      brandsTitle: document.querySelector("#ap-brands .ap-h")?.textContent || "",
    }));
    check("paging to the older capture works", ids === 4 && r.kind === "Local", r.kind);
    check("its places are listed", r.places > 0, r.places);
  }

  console.log("\nTabs by kind of answer (0.60.0, the canvas's popup boards)");
  {
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".ap-tabs [role=tab]")].map((b) => b.textContent));
    check("a local answer: Overview, Places, Facts, Sources, Answer", tabs.join("|") === "Overview|Places|Facts|Sources|Answer", tabs.join("|"));
    await page.evaluate(() => document.getElementById("ap-tab-facts").click());
    await page.waitForTimeout(500);
    const facts = await page.evaluate(() => document.getElementById("ap-view-facts")?.innerText || "");
    check("Facts says what each card carries, and that the source of each field isn't captured", /Rating/.test(facts) && /not captured/.test(facts), facts.slice(0, 160));
    await page.goto(`chrome-extension://${extId}/ui/panel.html?capture=${encodeURIComponent(shopNewest.id)}`);
    await page.waitForTimeout(1500);
    const shop = await page.evaluate(() => [...document.querySelectorAll(".ap-tabs [role=tab]")].map((b) => b.textContent));
    check("a shopping answer: Overview, Products, Stores, Sources, Answer", shop.join("|") === "Overview|Products|Stores|Sources|Answer", shop.join("|"));
    await page.evaluate(() => document.getElementById("ap-tab-products").click());
    await page.waitForTimeout(500);
    const prod = await page.evaluate(() => ({ cards: document.querySelectorAll("#ap-view-products .ap-pc").length, stores: document.querySelectorAll("#ap-view-products .at-store-chip").length, overview: !!document.getElementById("ap-searches") }));
    check("Products: a card each, with its stores in order", prod.cards === 5 && prod.stores >= 5 && !prod.overview, JSON.stringify(prod));
    await page.evaluate(() => document.getElementById("ap-tab-stores").click());
    await page.waitForTimeout(500);
    const stores = await page.evaluate(() => document.getElementById("ap-view-stores")?.innerText || "");
    check("Stores: where the cards send buyers, the price per store not captured", /cards/.test(stores) && /not captured/.test(stores), stores.slice(0, 160));
    await page.evaluate(() => document.getElementById("ap-tab-sources").click());
    await page.waitForTimeout(500);
    const src = await page.evaluate(() => ({ rows: document.querySelectorAll("#ap-view-sources .ap-page-row").length, pos: [...document.querySelectorAll("#ap-view-sources .ap-page-row .ap-muted")].some((x) => /#\d+/.test(x.textContent)) }));
    check("Sources: every page, with its place in the results", src.rows >= 10 && src.pos, JSON.stringify(src));
    await page.evaluate(() => document.getElementById("ap-tab-answer").click());
    await page.waitForTimeout(500);
    const ans = await page.evaluate(() => ({ words: (document.querySelector("#ap-view-answer")?.innerText || "").split(/\s+/).length, marks: document.querySelectorAll("#ap-view-answer mark.at-mark").length }));
    check("Answer: the answer itself, brands marked", ans.words > 100 && ans.marks > 0, JSON.stringify(ans));
    await page.evaluate(() => document.getElementById("ap-tab-overview").click());
    await page.waitForTimeout(500);
    check("Overview brings back the sections", await page.evaluate(() => !!document.getElementById("ap-searches")));
  }

  check("no page error anywhere above", pageErrors.length === 0, pageErrors.join(" | "));

  console.log("\nFull tab: its own layout, and it can open a given capture");
  {
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1280, height: 900 });
    await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
    await tab.waitForTimeout(1500);
    // Since 0.48.0 the full tab has its own two-column layout (analyze-tab.test.mjs).
    const r = await tab.evaluate(() => ({ popupLayout: !!document.querySelector("#analyze .ap"), tabLayout: !!document.querySelector("#analyze .at-grid #at-answer") }));
    check("the full tab uses its own layout, not the popup's", !r.popupLayout && r.tabLayout, JSON.stringify(r));
    const target = local;
    await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(target.id)}`);
    await tab.waitForTimeout(1500);
    const shown = await tab.evaluate(() => document.querySelector(".analyze-context-prompt")?.textContent || "");
    check("?capture= opens that answer (the popup's 'Full analysis' link)", shown === target.prompt, `${shown} vs ${target.prompt}`);
    await tab.close();
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
