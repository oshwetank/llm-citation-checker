/*
 * analyze-tab.test.mjs — Analyze in the full browser tab (0.48.0), in a real
 * browser at a laptop size (1440 × 900).
 *
 * Reported on the design canvas, about the full tab:
 *   1. "the full browser tab analyze layout has a lot of white spaces, the
 *      layout needs to be redesigned" — one long column of cards, most of
 *      them half empty. Now: the analysis on the left, and on the right the
 *      answer as the engine showed it, pinned while the analysis scrolls.
 *   2. "how would you display a prompt which was run across different LLMs
 *      in the analyze section" — engine tabs under the prompt, and a
 *      "Compare N engines" view (src/lib/compareView.js).
 *   3. "how properly large paragraph-level prompts are displayed" — a long
 *      prompt is clamped to two lines with "Show the whole prompt".
 * Clicking a brand or a cited page lights it up in the answer.
 *
 * Since 0.54.0 the left column is the canvas's TabAnalyze board, reported as
 * "the new layout has not completily and properly been implemented at all": an "at a
 * glance" card (brands named, pages cited, searches it ran) heads it; product
 * cards are a table with where to buy beside it; every named brand gets a row
 * in "what backs each brand" with what backs it (no advice since 0.59.0); Details is a
 * switch between technical tiles, the grounding check, the page behind each
 * part and every page it read. The page keeps the canvas's narrow gutters.
 * On 0.53.0 the "at a glance", products, backing and Details checks fail:
 * the column opened on a "Searches it ran" card, the products were a plain
 * table, and Details held the old cards.
 *
 * On 0.47.0 this fails at the first checks: there is no .at-grid, no answer
 * panel and no engine tabs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-analyze-tab-test";

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
  console.log("\nanalyze-tab: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported layout, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  // The engines' image hosts, answered with a small stand-in picture so the
  // product and image tiles can be checked for an actual loaded image
  // (0.58.0). gstatic is where an images.openai.com thumbnail's original lives.
  await context.route(/images\.openai\.com|gstatic\.com/, (r) => r.fulfill({
    status: 200, contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#89a"/></svg>',
  }));

  // Seed, all with made-up prompts (a fixture's prompt comes from the request
  // body, as on the engines' own pages):
  //   - one shopping answer from ChatGPT, asked twice, and the same prompt on
  //     Gemini, so there are two engines to compare;
  //   - a local answer whose place names contain " - " (it crashed the
  //     brand highlighter before the /u escape fix);
  //   - the same shopping answer under a 70-word prompt.
  const SHOP = "best smartphone under 50000";
  const LOCAL = "jewellery shops near me for a wedding set";
  const LONG = Array.from({ length: 7 }, (_, i) => `Sentence ${i + 1} of a long brief about phones under fifty thousand rupees with a good camera.`).join(" ");
  const gpt = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
  const gem = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);
  const ids = {};
  {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
    await page.waitForTimeout(600);
    const seed = [
      ["shopOld", "chatgpt-phone-under.txt", gpt(SHOP), "https://chatgpt.com/", 5],
      ["gem", "gemini-streamgenerate.txt", gem(SHOP), "https://gemini.google.com/app", 4],
      ["local", "chatgpt-jewellery-wedding.txt", gpt(LOCAL), "https://chatgpt.com/", 3],
      ["long", "chatgpt-phone-under.txt", gpt(LONG), "https://chatgpt.com/", 2],
      ["shop", "chatgpt-phone-under.txt", gpt(SHOP), "https://chatgpt.com/", 1],
    ];
    for (const [name, f, reqBody, pageUrl, hoursAgo] of seed) {
      const raw = readFileSync(path.join(FIXDIR, f), "utf8");
      const res = await page.evaluate(({ raw, reqBody, pageUrl, at }) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody, pageUrl, capturedAt: at } }, resolve);
      }), { raw, reqBody, pageUrl, at: Date.now() - hoursAgo * 3600 * 1000 });
      if (!res || !res.captureId) throw new Error(`seeding ${f} stored nothing: ${JSON.stringify(res)}`);
      ids[name] = res.captureId;
      await page.waitForTimeout(150);
    }
    await page.close();
  }

  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  const open = async (id) => {
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(id)}`);
    await page.waitForTimeout(1800);
  };
  await open(ids.shop);

  console.log("\nThree columns (0.60.0): the rail of sections, the analysis, the answer");
  {
    const r = await page.evaluate(() => {
      const grid = document.querySelector("#analyze .at-grid");
      const main = document.querySelector("#analyze .at-main");
      const ans = document.getElementById("at-answer");
      if (!grid || !main || !ans) return null;
      const m = main.getBoundingClientRect(), a = ans.getBoundingClientRect();
      return {
        side: a.left >= m.right - 1 && Math.abs(a.top - m.top) < 80,
        widths: [Math.round(m.width), Math.round(a.width)],
        popup: !!document.querySelector("#analyze .ap"),
        oldColumn: !!document.querySelector("#analyze > #card-brand-mentions, #analyze .analyze-grid"),
        hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        error: document.querySelector("#analyze")?.innerText.match(/Could not render[^\n]*/)?.[0] || "",
      };
    });
    check("the full tab uses the two-column layout", !!r, "no .at-grid / #at-answer");
    if (r) {
      check("the answer sits beside the analysis, not under it", r.side, JSON.stringify(r.widths));
      check("both columns get real width", r.widths[0] >= 600 && r.widths[1] >= 380, JSON.stringify(r.widths));
      check("not the popup layout, not the old single column", !r.popup && !r.oldColumn);
      check("nothing scrolls sideways", !r.hscroll);
      check("it rendered without an error", !r.error, r.error);
    }
  }

  console.log("\nAt a glance first: brands named, pages cited, searches it ran");
  {
    const r = await page.evaluate(() => {
      const secs = [...document.querySelectorAll("#analyze .at-main > section")];
      const g = document.getElementById("at-glance");
      const cols = g ? [...g.querySelectorAll(".at-glance-col")].map((c) => { const b = c.getBoundingClientRect(); return { h: c.querySelector("h2")?.textContent || "", top: Math.round(b.top), left: Math.round(b.left) }; }) : [];
      const built = [...document.querySelectorAll("#at-built .at-lane-q > :first-child")];
      return {
        order: secs.map((x) => x.id),
        cols,
        brands: g ? g.querySelectorAll(".at-glance-brand").length : 0,
        pages: g ? g.querySelectorAll(".at-glance-page").length : 0,
        searches: g ? g.querySelectorAll(".at-glance-q").length : 0,
        built: built.length,
        cut: built.filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent),
      };
    });
    check("the first section is the at-a-glance card", r.order[0] === "at-glance", r.order.join(" > "));
    check("three columns side by side", r.cols.length === 3 && r.cols.every((c) => c.top === r.cols[0].top) && r.cols[1].left > r.cols[0].left && r.cols[2].left > r.cols[1].left, JSON.stringify(r.cols));
    check("headed brands, pages cited, searches", /^Brands named/.test(r.cols[0]?.h) && /^Pages cited/.test(r.cols[1]?.h) && /^Searches it ran/.test(r.cols[2]?.h), r.cols.map((c) => c.h).join(" | "));
    check("it lists the brands, the cited pages and the searches", r.brands === 5 && r.pages === 2 && r.searches > 0, `${r.brands} brands, ${r.pages} pages, ${r.searches} searches`);
    check("every search is under how the answer was built", r.built === r.searches, `${r.built} vs ${r.searches}`);
    check("no search is cut off there", r.cut.length === 0, r.cut.join(" | "));
    // 0.60.0, the approved canvas order: what led the answer (products,
    // pictures), then where it came from, every site it read, the searches,
    // since last time, and Details last.
    const want = ["at-glance", "at-products", "at-images", "at-backing", "at-sites", "at-built", "at-changes", "at-details"];
    check("then the canvas's order: products, pictures, where it came from, sites, searches, since last time, Details",
      want.every((id) => r.order.includes(id)) && want.every((id, i) => i === 0 || r.order.indexOf(want[i - 1]) < r.order.indexOf(id)) && r.order.at(-1) === "at-details", r.order.join(" > "));
  }

  console.log("\nNothing in the glance card is cut off (0.58.0)");
  {
    const r = await page.evaluate(() => {
      const g = document.getElementById("at-glance");
      const qs = [...g.querySelectorAll(".at-glance-qt")];
      return {
        more: [...g.querySelectorAll(".at-glance-more")].map((x) => x.textContent),
        cut: [...qs, ...g.querySelectorAll(".at-glance-name, .at-glance-kind")].filter((x) => x.scrollWidth > x.clientWidth + 1 || getComputedStyle(x).textOverflow === "ellipsis").map((x) => x.textContent),
        searches: qs.length,
      };
    });
    check("no “+ N more” in place of brands, pages or searches", r.more.length === 0, r.more.join(" | "));
    check("no search, brand or site is ellipsised", r.searches > 0 && r.cut.length === 0, r.cut.join(" | "));
  }

  console.log("\nSites it used: every domain, cited first, each with its pages (0.58.0)");
  {
    const r = await page.evaluate(() => {
      const sec = document.getElementById("at-sites");
      const rows = sec ? [...sec.querySelectorAll(".site-row")] : [];
      const cited = rows.map((x) => x.classList.contains("is-cited"));
      return {
        rows: rows.length,
        citedFirst: cited.indexOf(false) === -1 || !cited.slice(cited.indexOf(false)).includes(true),
        citedOpen: rows.filter((x) => x.classList.contains("is-cited")).every((x) => x.open),
        readClosed: rows.filter((x) => !x.classList.contains("is-cited")).every((x) => !x.open),
        citedRows: cited.filter(Boolean).length,
        pages: sec ? sec.querySelectorAll(".site-pages li").length : 0,
        links: sec ? [...sec.querySelectorAll(".site-pages a")].filter((a) => /^https?:/.test(a.href)).length : 0,
        glancePages: document.querySelectorAll("#at-glance .at-glance-page").length,
      };
    });
    check("a row per site, more than the cited ones alone", r.rows > r.citedRows && r.citedRows > 0, `${r.rows} sites, ${r.citedRows} cited`);
    check("cited sites first", r.citedFirst);
    check("cited sites open on their pages, read-only ones closed", r.citedOpen && r.readClosed);
    check("every page read is listed, each linked", r.pages > r.glancePages && r.links === r.pages, `${r.pages} pages, ${r.links} links`);
    await page.evaluate(() => [...document.querySelectorAll("#at-sites .site-row:not(.is-cited) summary")][0]?.click());
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => {
      const row = document.querySelector("#at-sites .site-row:not(.is-cited)");
      return !!row && row.open && !row.querySelector(".site-pages").hidden && row.querySelectorAll(".site-pages li").length > 0;
    });
    check("a read-only site opens to its pages", opened);
  }

  console.log("\nPictures: product tiles and the Images section show the image (0.58.0)");
  {
    await page.evaluate(() => document.querySelectorAll("#analyze img").forEach((i) => { i.loading = "eager"; }));
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => ({
      thumbs: document.querySelectorAll("#at-products .at-thumb").length,
      loaded: document.querySelectorAll("#at-products .at-thumb.img-loaded img").length,
      washed: [...document.querySelectorAll("#at-products .at-thumb, .at-ans-thumb, .at-img-thumb")].filter((x) => /gradient/.test(getComputedStyle(x).backgroundImage)).length,
      answerCards: document.querySelectorAll("#at-answer .at-ans-thumb.img-loaded img").length,
      images: !!document.getElementById("at-images"),
      imageTiles: document.querySelectorAll("#at-images .at-img-thumb.img-loaded img").length,
    }));
    check("every product row shows its picture", r.thumbs > 0 && r.loaded === r.thumbs, `${r.loaded} of ${r.thumbs}`);
    check("so do the answer panel's product cards", r.answerCards === r.thumbs, `${r.answerCards}`);
    check("no tile is a colour wash", r.washed === 0, `${r.washed} with a gradient`);
    check("a shopping answer's images show in the full tab", r.images && r.imageTiles > 0, `${r.imageTiles} images`);
  }

  console.log("\nThe canvas's spacing: narrow gutters, a wide analysis column");
  {
    const r = await page.evaluate(() => {
      const hero = document.querySelector("#analyze .at-hero").getBoundingClientRect();
      const m = document.querySelector("#analyze .at-main").getBoundingClientRect();
      const a = document.getElementById("at-answer").getBoundingClientRect();
      return { left: Math.round(hero.left), right: Math.round(window.innerWidth - hero.right), main: Math.round(m.width), ans: Math.round(a.width) };
    });
    // 0.53.0 left ~70px a side and a 740px column; the canvas has 20px.
    check("the page's side margins are narrow", r.left <= 30 && r.right <= 40, JSON.stringify(r));
    // Three columns since 0.60.0: the canvas gives the analysis ~600px and
    // the answer ~440px beside a 230px rail at this width.
    check("the analysis column gets the most width", r.main >= 600 && r.main > r.ans, JSON.stringify(r));
    check("the answer panel is as wide as the canvas's", r.ans >= 440, JSON.stringify(r));
  }

  console.log("\nProducts and where to buy (0.60.0): stores in order, the pages naming each card");
  {
    const r = await page.evaluate(() => {
      const sec = document.getElementById("at-products");
      const rows = sec ? [...sec.querySelectorAll(".at-prod-row:not(.at-th)")] : [];
      return {
        rows: rows.length,
        thumbs: sec ? sec.querySelectorAll(".at-prod-row .at-thumb").length : 0,
        heads: sec ? [...sec.querySelectorAll(".at-prod-row.at-th > span")].map((x) => x.textContent).filter(Boolean) : [],
        stores: rows.map((x) => [...x.querySelectorAll(".at-store-chip")].map((c) => c.textContent.trim())),
        pages: rows.map((x) => x.querySelector(".at-prod-pages")?.textContent || ""),
        facts: sec ? sec.querySelector(".at-prod-facts")?.innerText || "" : "",
      };
    });
    check("one row per card, each with a picture tile", r.rows === 5 && r.thumbs === 5, `${r.rows} rows, ${r.thumbs} tiles`);
    check("the canvas's columns", r.heads.join("|") === "#|Product|Price|Rating|Pages naming it|Where to buy", r.heads.join("|"));
    check("each card's stores, numbered in the card's order", r.stores.every((x) => x.length > 0 && /^1 /.test(x[0])), JSON.stringify(r.stores));
    check("each card says which cited pages name it, or that none does", r.pages.every((x) => x.length > 0), JSON.stringify(r.pages));
    check("where the cards send buyers first, and the price per store stated as not captured", /First store on each card/i.test(r.facts) && /Not captured/i.test(r.facts) && /store’s own price/.test(r.facts), r.facts);
  }

  console.log("\nWhat backs each brand: what backs each one, and no advice");
  {
    const r = await page.evaluate(() => {
      const sec = document.getElementById("at-backing");
      const rows = sec ? [...sec.querySelectorAll(".at-backing-row:not(.dropped)")] : [];
      return {
        rows: rows.length,
        verdicts: rows.map((x) => x.querySelector(".ap-pill")?.textContent || ""),
        firstName: rows[0]?.querySelector(".at-backing-name")?.textContent || "",
        todo: sec?.querySelector(".at-todo")?.textContent || "",
        advice: /what to do|get onto|drop out|keep their place|matter most/i.test(document.getElementById("analyze").innerText),
      };
    });
    check("a row for each named brand, in order", r.rows === 5 && r.firstName === "OnePlus", `${r.rows} rows, first ${r.firstName}`);
    check("each with a plain verdict", r.verdicts.every((v) => /^(Backed by independent pages|Backed only by its own site|Read, not cited|Nothing behind it|From memory)$/.test(v)), r.verdicts.join(" | "));
    // 0.59.0: the owner asked for the data without the advice ("we are not
    // spoonfeeding here"). Until then the section closed with a "What to do"
    // line and the page opened with what "matters most".
    check("no 'what to do' line, and no advice anywhere in Analyze", !r.todo && !r.advice, r.todo || "advice text found");
  }

  console.log("\nThe answer, as the engine showed it, with brands and citations marked");
  {
    const r = await page.evaluate(() => {
      const ans = document.getElementById("at-answer");
      const text = ans.querySelector(".at-answer-text");
      return {
        title: ans.querySelector("#at-answer-h")?.textContent || "",
        words: text ? text.innerText.trim().split(/\s+/).length : 0,
        cards: ans.querySelectorAll(".at-ans-card").length,
        marks: [...ans.querySelectorAll(".at-mark")].map((m) => m.dataset.brand),
        cites: [...ans.querySelectorAll(".at-cite")].map((c) => c.textContent),
        fnList: ans.querySelectorAll(".at-fn-list li").length,
        rawMarkers: /[-]|\[\[cite:|cite│|turn\d+(search|product)/.test(text?.innerText || ""),
        open: ans.querySelector(".at-open")?.textContent || "",
        step: ans.querySelector(".at-ans-step")?.textContent || "",
        thumbs: ans.querySelectorAll(".at-ans-card .at-ans-thumb").length,
        perRow: (() => { const c = [...ans.querySelectorAll(".at-ans-card")]; return c.filter((x) => Math.round(x.getBoundingClientRect().top) === Math.round(c[0]?.getBoundingClientRect().top)).length; })(),
      };
    });
    check("headed with the engine's name", /as ChatGPT showed it/.test(r.title), r.title);
    check("the answer text is there", r.words > 100, r.words);
    check("its product cards come first, in carousel order", r.cards === 5, r.cards);
    check("brands are marked in the text", r.marks.length >= 5 && r.marks.includes("OnePlus"), r.marks.slice(0, 8).join());
    check("citations show as the site's name, not a bare number", r.cites.length > 0 && r.cites.every((c) => /[a-z]\.[a-z]/i.test(c)), r.cites.join());
    check("the sources it cited are listed under the answer", r.fnList > 0, r.fnList);
    check("no raw citation markers leak into the text", !r.rawMarkers);
    check("a link back to the conversation", /Open on chatgpt\.com/.test(r.open), r.open);
    check("the line ChatGPT shows above its answer", r.step === "Searched 12 sites", r.step);
    check("product cards with a picture tile, three to a row", r.thumbs === 5 && r.perRow === 3, `${r.thumbs} tiles, ${r.perRow} a row`);
  }

  console.log("\nClicking a brand or a cited page lights it up in the answer");
  {
    // From part-way down the page, as when reading the brand table.
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("#at-answer .at-answer-body").scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, document.getElementById("at-backing").getBoundingClientRect().top + window.scrollY - 200));
    await page.waitForTimeout(400);
    const y0 = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.querySelector('#at-backing [data-focus-brand="Samsung"]')?.click());
    await page.waitForTimeout(900);
    const moved = await page.evaluate(() => {
      const body = document.querySelector("#at-answer .at-answer-body").getBoundingClientRect();
      const m = document.querySelector("#at-answer .at-mark.focus")?.getBoundingClientRect();
      return { y: window.scrollY, inView: !!m && m.top >= body.top && m.bottom <= body.bottom, panelTop: document.querySelector("#at-answer .at-answer-body").scrollTop };
    });
    check("the answer panel scrolls to the brand", moved.inView && moved.panelTop > 0, JSON.stringify(moved));
    check("the page itself doesn't jump", Math.abs(moved.y - y0) < 2, `${y0} → ${moved.y}`);
    await page.evaluate(() => document.querySelector("#at-answer .at-hl-clear")?.click());
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("#at-answer .at-answer-body").scrollTop = 0; });
    await page.waitForTimeout(300);

    await page.evaluate(() => document.querySelector('#at-glance [data-focus-brand="OnePlus"]')?.click());
    await page.waitForTimeout(500);
    const a = await page.evaluate(() => ({
      focused: [...document.querySelectorAll("#at-answer .at-mark.focus")].map((m) => m.dataset.brand),
      dimmed: document.querySelector("#at-answer .at-answer-body")?.classList.contains("has-focus"),
      pressed: document.querySelector('#at-glance [data-focus-brand="OnePlus"]')?.getAttribute("aria-pressed"),
      clear: document.querySelector("#at-answer .at-hl-clear")?.textContent || "",
    }));
    check("only that brand's marks are lit", a.focused.length > 0 && a.focused.every((b) => b === "OnePlus"), a.focused.join());
    check("the rest of the answer is dimmed", a.dimmed === true);
    check("the brand's button says it is on", a.pressed === "true", a.pressed);
    check("a clear button names what is shown", /Showing OnePlus/.test(a.clear), a.clear);
    await page.evaluate(() => document.querySelector("#at-answer .at-hl-clear")?.click());
    await page.waitForTimeout(200);
    check("clear turns it off", await page.evaluate(() => !document.querySelector("#at-answer .at-mark.focus") && !document.querySelector("#at-answer .has-focus")));

    await page.evaluate(() => document.querySelector("#at-glance [data-focus-cite]")?.click());
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => ({
      n: document.querySelector("#at-glance [data-focus-cite]")?.dataset.focusCite,
      lit: [...document.querySelectorAll("#at-answer .at-cite.focus")].map((x) => x.dataset.n),
    }));
    check("a cited page lights that citation", c.lit.length > 0 && c.lit.every((n) => n === c.n), `${c.n}: ${c.lit.join()}`);
    await page.evaluate(() => document.querySelector("#at-answer .at-hl-clear")?.click());

    await page.evaluate(() => [...document.querySelectorAll("#at-answer .at-hl-btn")].find((b) => b.textContent === "Brands")?.click());
    await page.waitForTimeout(200);
    const off = await page.evaluate(() => {
      const m = document.querySelector("#at-answer .at-mark");
      return { cls: document.querySelector("#at-answer .at-answer-body").classList.contains("hl-brands"), bg: m ? getComputedStyle(m).backgroundColor : "" };
    });
    check("the Brands toggle turns the highlighting off", off.cls === false && /rgba\(0, 0, 0, 0\)|transparent/.test(off.bg), JSON.stringify(off));
    await page.evaluate(() => [...document.querySelectorAll("#at-answer .at-hl-btn")].find((b) => b.textContent === "Brands")?.click());
  }

  console.log("\nScrolling a little doesn't make the page shake (0.60.1)");
  {
    // Reported on 0.60.0: two or three inches of scroll and "the entire
    // layout starts glitching". Shrinking the header moved the scroll
    // position back above the point that shrinks it, every frame.
    const flips = [];
    for (const y of [150, 230, 300, 120, 30, 10]) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      flips.push(await page.evaluate(() => new Promise((done) => {
        const seen = []; let n = 0;
        const tick = () => { seen.push(document.querySelector("#analyze .at-hero").classList.contains("compact")); if (++n < 30) requestAnimationFrame(tick); else done(seen.filter((c, i) => i && c !== seen[i - 1]).length); };
        tick();
      })));
    }
    check("the header changes size at most once per scroll, never back and forth", flips.every((f) => f <= 1), flips.join(","));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
  }

  console.log("\nScrolling: the answer stays in view, the header shrinks to one line");
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => document.querySelector("#analyze .at-hero").getBoundingClientRect().height);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const hero = document.querySelector("#analyze .at-hero").getBoundingClientRect();
      const ans = document.getElementById("at-answer").getBoundingClientRect();
      return { y: window.scrollY, compact: document.querySelector("#analyze .at-hero").classList.contains("compact"), heroH: hero.height, heroBottom: hero.bottom, ansTop: ans.top, ansBottom: ans.bottom, vh: window.innerHeight };
    });
    check("the page did scroll", r.y > 600, r.y);
    check("the answer is still on screen", r.ansTop >= 0 && r.ansTop < 300 && r.ansBottom <= r.vh + 1, `${Math.round(r.ansTop)}..${Math.round(r.ansBottom)} of ${r.vh}`);
    check("the header went compact and got shorter", r.compact && r.heroH < before - 30, `${Math.round(before)} → ${Math.round(r.heroH)}`);
    check("the answer starts below the header, not under it", r.ansTop >= r.heroBottom, `${Math.round(r.heroBottom)} / ${Math.round(r.ansTop)}`);
    // At the very end the grid stops above the footer; the pinned panel used
    // to be pushed up under the header there (0.53.0: by ~110px).
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await page.waitForTimeout(400);
    const end = await page.evaluate(() => ({ hero: document.querySelector("#analyze .at-hero").getBoundingClientRect().bottom, top: document.getElementById("at-answer").getBoundingClientRect().top }));
    check("even at the very end of the page", end.top >= end.hero, `${Math.round(end.hero)} / ${Math.round(end.top)}`);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(300);
    // The app header above it is glass, and scrolled text used to show
    // through it. Now the band behind it is painted with the page's own
    // (fixed) backdrop, so the pinned header looks the same whatever is
    // scrolling past: two scroll positions, identical pixels.
    const band = await page.evaluate(() => { const r = document.querySelector(".app-header").getBoundingClientRect(); return { x: 0, y: 0, width: window.innerWidth - 20, height: Math.round(r.bottom) }; });
    const shotA = await page.screenshot({ clip: band });
    await page.evaluate(() => window.scrollBy(0, 450));
    await page.waitForTimeout(400);
    const shotB = await page.screenshot({ clip: band });
    check("nothing shows through the app header while scrolling", shotA.equals(shotB), `${shotA.length} vs ${shotB.length} bytes`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    check("scrolling back up restores the full header", await page.evaluate(() => !document.querySelector("#analyze .at-hero").classList.contains("compact")));
    check("panels keep no transform after fading in (it trapped fixed backgrounds and the popup's sheet)",
      await page.evaluate(() => getComputedStyle(document.getElementById("analyze")).transform === "none"));
  }

  console.log("\nDetails: one switch, technical details first");
  {
    const r = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll("#at-details dl.at-tech > div")];
      return {
        tabs: [...document.querySelectorAll("#at-details .at-seg [role=tab]")].map((t) => t.textContent),
        tiles: tiles.map((x) => x.querySelector("dt")?.textContent),
        perRow: tiles.filter((x) => Math.round(x.getBoundingClientRect().top) === Math.round(tiles[0].getBoundingClientRect().top)).length,
      };
    });
    check("Details has the canvas's tabs first", r.tabs.slice(0, 4).join(" | ") === "Technical details | Grounding check | Page behind each part | Every page it read", r.tabs.join(" | "));
    // The detailed cards the 0.53.0 Details held stay reachable after them;
    // 0.54.0 first dropped them (caught by source-pipeline-ui).
    check("then the search breakdown and the brand & page matrix", r.tabs.includes("Search details") && r.tabs.includes("Brand & page matrix"), r.tabs.join(" | "));
    check("it opens on technical details, as tiles three to a row", r.tiles.length === 12 && r.perRow === 3 && r.tiles[0] === "Captured", `${r.tiles.length} tiles, ${r.perRow} a row: ${r.tiles.join(", ")}`);
    await page.evaluate(() => [...document.querySelectorAll("#at-details .at-seg [role=tab]")].find((t) => t.textContent === "Every page it read")?.click());
    await page.waitForTimeout(500);
    const t = await page.evaluate(() => ({
      card: !!document.querySelector("#at-details #card-sources"),
      pages: document.querySelectorAll("#at-details #card-sources .src-item").length,
      tech: !!document.querySelector("#at-details dl.at-tech"),
      on: document.querySelector("#at-details .at-seg [aria-selected=true]")?.textContent,
    }));
    check("'Every page it read' is the full sources card, with its pages", t.card && t.pages > 0 && !t.tech && t.on === "Every page it read", JSON.stringify(t));
  }

  console.log("\nOne prompt, two engines: engine tabs and a comparison");
  {
    // The canvas's answer strip (0.60.0): a card per engine, then the lenses.
    const tabs = await page.evaluate(() => [...document.querySelectorAll("#analyze .at-engines .at-engine-tab")].map((b) => {
      const l = b.querySelector(".at-engine-tab-label").cloneNode(true);
      l.querySelector(".at-engine-model")?.remove();
      return { label: l.textContent.trim(), on: b.classList.contains("on") };
    }));
    check("a card per engine, then Side by side and Over time", tabs.map((t) => t.label).join("|") === "ChatGPT|Gemini|Side by side|Over time", tabs.map((t) => t.label).join("|"));
    check("the engine on screen is the selected tab", tabs.find((t) => t.label === "ChatGPT")?.on === true);
    const overtime = await page.evaluate(() => document.querySelector("#analyze .at-overtime")?.textContent || "");
    check("every answer to the prompt is one click away", /All 3 answers to this prompt/.test(overtime), overtime);

    await page.evaluate(() => document.querySelector("#analyze .at-engine-tab.cmp")?.click());
    await page.waitForTimeout(900);
    const c = await page.evaluate(() => {
      const d = Object.fromEntries([...document.querySelectorAll("#at-cmp-diffs .at-diffs li")].map((x) => [x.querySelector(".at-diff-k")?.textContent.trim(), x.lastElementChild?.textContent.trim()]));
      return {
        diffs: d,
        rows: document.querySelectorAll("#at-cmp-table .at-tr:not(.at-th)").length,
        brandRows: document.querySelectorAll("#at-cmp-brands [role=row]:has([role=rowheader])").length,
        sites: document.querySelectorAll("#at-cmp-sites [role=row]:has([role=rowheader])").length,
        ansTabs: [...document.querySelectorAll("#at-answer .at-ans-tabs [role=tab]")].map((b) => b.textContent.trim()),
        singleGone: !document.getElementById("at-glance") && !document.getElementById("at-backing"),
      };
    });
    check("how the answers differ, in sentences", /ChatGPT named OnePlus first/.test(c.diffs["Who came first"] || ""), JSON.stringify(c.diffs).slice(0, 200));
    check("each engine in numbers", c.rows === 2, c.rows);
    check("where each brand came", c.brandRows >= 5, c.brandRows);
    check("which sites each engine used", c.sites >= 3, c.sites);
    check("the answer panel can switch between the engines' answers", c.ansTabs.join("|") === "ChatGPT|Gemini", c.ansTabs.join("|"));
    check("the single-answer analysis steps aside", c.singleGone);

    await page.evaluate(() => [...document.querySelectorAll("#at-answer .at-ans-tabs [role=tab]")].find((b) => /Gemini/.test(b.textContent))?.click());
    await page.waitForTimeout(1500);
    const g = await page.evaluate(() => ({ title: document.getElementById("at-answer-h")?.textContent || "", words: document.querySelector("#at-answer .at-answer-text")?.innerText.length || 0 }));
    check("reading Gemini's answer beside the comparison", /as Gemini showed it/.test(g.title) && g.words > 200, `${g.title} (${g.words} chars)`);

    await page.evaluate(() => [...document.querySelectorAll("#analyze .at-engines .at-engine-tab")].find((b) => /Gemini/.test(b.textContent))?.click());
    await page.waitForTimeout(1500);
    const asked = await page.evaluate(() => ({ asked: document.querySelector("#analyze .at-asked")?.textContent || "", cmp: !!document.getElementById("at-cmp-diffs") }));
    check("the Gemini tab opens Gemini's answer, analysed", asked.asked === "Asked Gemini" && !asked.cmp, JSON.stringify(asked));
  }

  // 0.56.0, from the canvas: the app bar holds "Find a captured prompt" and
  // Newer / Older. Until then the pager sat in the prompt header and there
  // was no way to find a capture without going back to the Dashboard.
  console.log("\nThe rail of sections (0.60.0)");
  await open(ids.shop);
  {
    const r = await page.evaluate(() => {
      const rail = document.getElementById("at-rail");
      const items = rail ? [...rail.querySelectorAll(".at-rail-item[data-target]")] : [];
      const secs = [...document.querySelectorAll("#analyze .at-main > section[id]")].map((x) => x.id);
      return { items: items.map((b) => b.dataset.target), labels: items.map((b) => b.querySelector(".t").textContent), secs, on: items.filter((b) => b.classList.contains("on")).map((b) => b.dataset.target) };
    });
    check("one rail row per section, in the page's order", r.items.length > 5 && r.items.join() === r.secs.join(), `${r.items.join()} vs ${r.secs.join()}`);
    check("named as on the canvas", r.labels.includes("At a glance") && r.labels.includes("Where it came from") && r.labels.includes("Every site it read") && r.labels.includes("Details"), r.labels.join(" | "));
    check("the section in view is lit", r.on.join() === "at-glance", r.on.join());
    await page.evaluate(() => document.querySelector('#at-rail [data-target="at-sites"]').click());
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => {
      const hero = document.querySelector("#analyze .at-hero").getBoundingClientRect();
      const sec = document.getElementById("at-sites").getBoundingClientRect();
      return { top: Math.round(sec.top), heroBottom: Math.round(hero.bottom), on: [...document.querySelectorAll("#at-rail .at-rail-item.on")].map((b) => b.dataset.target).join() };
    });
    check("clicking a row brings its section to the top, below the header", after.top >= after.heroBottom - 2 && after.top < after.heroBottom + 120, JSON.stringify(after));
    check("and lights that row", after.on === "at-sites", after.on);
  }

  console.log("\nThe rail folds to icons and opens on hover; a pin keeps it open (0.62.1)");
  await page.evaluate(() => localStorage.removeItem("cito-rail-pinned"));
  await open(ids.shop);
  {
    const measure = () => page.evaluate(() => {
      const rail = document.getElementById("at-rail");
      const main = document.querySelector("#analyze .at-main");
      const t = rail.querySelector(".at-rail-item .t");
      return { rail: Math.round(rail.getBoundingClientRect().width), mainLeft: Math.round(main.getBoundingClientRect().left), mainW: Math.round(main.getBoundingClientRect().width), label: getComputedStyle(t).display };
    });
    const folded = await measure();
    check("folded, the rail is a strip of icons", folded.rail <= 60 && folded.label === "none", JSON.stringify(folded));
    await page.hover("#at-rail");
    await page.waitForTimeout(400);
    const open1 = await measure();
    check("hovering opens it with the section names", open1.rail >= 200 && open1.label !== "none", JSON.stringify(open1));
    check("over the page, without moving the analysis", open1.mainLeft === folded.mainLeft, `${folded.mainLeft} → ${open1.mainLeft}`);
    await page.mouse.move(1300, 850);
    await page.evaluate(() => document.querySelector("#at-rail .at-rail-pin").click());
    await page.waitForTimeout(500);
    await page.mouse.move(1300, 850);
    const pinned = await measure();
    check("pinned, it stays open beside the page", pinned.rail >= 150 && pinned.label !== "none" && pinned.mainLeft > folded.mainLeft, JSON.stringify(pinned));
    await open(ids.shop);
    const again = await measure();
    check("and stays pinned on the next capture", again.rail >= 150, JSON.stringify(again));
    await page.evaluate(() => document.querySelector("#at-rail .at-rail-pin").click());
    await page.waitForTimeout(400);
    await page.mouse.move(1300, 850);
    check("unpinning folds it again", (await measure()).rail <= 60);
  }

  console.log("\nWhich page backs each part: in Details only; site: searches stated (0.62.1)");
  await open(ids.gem);
  {
    const r = await page.evaluate(() => ({
      inMain: !!document.querySelector("#analyze .at-main > #at-parts"),
      rail: [...document.querySelectorAll("#at-rail .at-rail-item .t")].map((t) => t.textContent),
      tabs: [...document.querySelectorAll("#at-details .at-seg [role=tab]")].map((t) => t.textContent),
    }));
    check("not a section of the page, nor a rail row", !r.inMain && !r.rail.some((t) => /each part/i.test(t)), r.rail.join(" | "));
    check("still a tab of Details", r.tabs.includes("Page behind each part"), r.tabs.join(" | "));
  }
  // The sections below read the shopping answer.
  await open(ids.shop);
  {
    const scoped = await page.evaluate(() => document.querySelector("#at-built .at-scoped")?.textContent || "");
    check("Searches it ran says whether any search was limited to a site", /site:/.test(scoped), scoped || "no line");
  }

  console.log("\nWhere it came from (0.60.0): each page with its place in the results and its date");
  {
    const r = await page.evaluate(() => {
      const sec = document.getElementById("at-backing");
      return {
        title: sec?.querySelector(".at-h")?.textContent || "",
        lead: sec?.querySelector(".at-backing-lead")?.textContent || "",
        matrix: sec ? sec.querySelectorAll(".at-matrix [role=row]").length : 0,
        sitesMeta: [...document.querySelectorAll("#at-sites .site-page-meta")].map((x) => x.textContent),
        filters: [...document.querySelectorAll("#at-sites .at-filter")].map((b) => b.textContent),
      };
    });
    check("headed as on the canvas, with how backing is counted", r.title === "Where it came from" && /counts as backed/.test(r.lead) && /#N/.test(r.lead), r.title);
    check("which sources name which brands, as a grid", r.matrix >= 2, r.matrix);
    check("every page read shows where it came in ChatGPT's results", r.sitesMeta.some((t) => /#\d+ in its results/.test(t)), r.sitesMeta.slice(0, 4).join(" | "));
    check("filters for cited and read-only sites", r.filters.some((t) => /^All \d+/.test(t)) && r.filters.some((t) => /^Cited \d+/.test(t)) && r.filters.some((t) => /^Read only \d+/.test(t)), r.filters.join(" | "));
    await page.evaluate(() => [...document.querySelectorAll("#at-sites .at-filter")].find((b) => /^Read only/.test(b.textContent)).click());
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => [...document.querySelectorAll("#at-sites .site-row")].filter((x) => !x.hidden).map((x) => x.classList.contains("is-cited")));
    check("'Read only' leaves only the sites it read without citing", shown.length > 0 && shown.every((c) => !c), JSON.stringify(shown));
  }

  console.log("\nHide the answer, and bring it back by picking a brand (0.60.0)");
  {
    const before = await page.evaluate(() => Math.round(document.querySelector("#analyze .at-main").getBoundingClientRect().width));
    await page.evaluate(() => document.querySelector("#at-rail .at-split-btn").click());
    await page.waitForTimeout(700);
    const hidden = await page.evaluate(() => ({ ans: !!document.getElementById("at-answer"), w: Math.round(document.querySelector("#analyze .at-main").getBoundingClientRect().width), label: document.querySelector("#at-rail .at-split-btn").textContent, kept: localStorage.getItem("cito-at-split") }));
    check("the answer goes and the analysis takes its width", !hidden.ans && hidden.w > before + 300, JSON.stringify({ before, ...hidden }));
    check("the button offers it back, and the choice is kept", /Read the answer beside/.test(hidden.label) && hidden.kept === "0", JSON.stringify(hidden));
    await page.evaluate(() => document.querySelector('#at-glance [data-focus-brand="OnePlus"]').click());
    await page.waitForTimeout(900);
    const back = await page.evaluate(() => ({ ans: !!document.getElementById("at-answer"), lit: [...document.querySelectorAll("#at-answer .at-mark.focus")].map((m) => m.dataset.brand) }));
    check("picking a brand brings the answer back, with that brand lit", back.ans && back.lit.length > 0 && back.lit.every((b) => b === "OnePlus"), JSON.stringify(back));
  }

  console.log("\nSimple and Expert (0.60.0)");
  {
    const simple = await page.evaluate(() => ({
      raw: [...document.querySelectorAll("#at-details .at-seg-btn")].some((b) => b.textContent === "Raw"),
      xs: [...document.querySelectorAll("#analyze .x-only")].filter((x) => x.offsetParent).length,
      seg: [...document.querySelectorAll("#headerPage .at-detail-switch")].map((b) => `${b.textContent}:${b.getAttribute("aria-checked")}`).join(),
      segW: Math.round(document.querySelector("#headerPage .at-detail-switch")?.getBoundingClientRect().width || 0),
    }));
    check("Simple by default: no Raw tab, no expert-only detail shown", !simple.raw && simple.xs === 0, JSON.stringify(simple));
    check("the switch sits in the top bar, one small Expert switch, off", simple.seg === "Expert:false" && simple.segW > 0 && simple.segW <= 90, JSON.stringify(simple));
    await page.evaluate(() => document.querySelector('#headerPage .at-detail-switch[aria-checked="false"]').click());
    await page.waitForTimeout(700);
    await page.evaluate(() => [...document.querySelectorAll("#at-details .at-seg-btn")].find((b) => b.textContent === "Raw")?.click());
    await page.waitForTimeout(500);
    const expert = await page.evaluate(() => {
      let raw = null;
      try { raw = JSON.parse(document.querySelector("#at-details .at-raw")?.textContent || "null"); } catch (_) {}
      return { attr: document.documentElement.getAttribute("data-detail"), kept: localStorage.getItem("cito-detail"), raw, refs: [...document.querySelectorAll("#at-sites .site-page-meta.x-only")].filter((x) => x.textContent).length };
    });
    check("Expert is applied and kept", expert.attr === "expert" && expert.kept === "expert", JSON.stringify(expert));
    check("Details gets a Raw tab with the fields the capture read", !!expert.raw && expert.raw.platform === "chatgpt" && Array.isArray(expert.raw.sources) && expert.raw.sources.length > 0, JSON.stringify(expert.raw || {}).slice(0, 120));
    check("each page shows its ref ids", expert.refs > 0, expert.refs);

    // The raw payload breakdown (0.60.1): under the prompt, Expert only,
    // closed until opened, and nothing fetched before that.
    check("Simple hides the raw payload breakdown", simple.xs === 0);
    // The header used to print "null" after "Ad-hoc" (0.60.0): a null handed
    // to the DOM's own append() is written out as text.
    const stray = await page.evaluate(() => {
      const w = document.createTreeWalker(document.getElementById("analyze"), NodeFilter.SHOW_TEXT);
      const bad = [];
      while (w.nextNode()) if (/^\s*(null|undefined)\s*$/.test(w.currentNode.nodeValue)) bad.push(w.currentNode.parentElement.className);
      return bad;
    });
    check("no stray null or undefined text on the page", stray.length === 0, JSON.stringify(stray));
    const rx0 = await page.evaluate(() => {
      const d = document.getElementById("at-rawx");
      const main = document.querySelector("#analyze .at-main");
      return { there: !!d && !!d.offsetParent, open: d && d.open, first: main && main.firstElementChild === d, rows: d ? d.querySelectorAll(".at-rawx-sec").length : -1 };
    });
    check("Expert shows it first, under the prompt, closed, with nothing read yet", rx0.there && rx0.open === false && rx0.first && rx0.rows === 0, JSON.stringify(rx0));
    await page.evaluate(() => document.querySelector("#at-rawx > summary").click());
    await page.waitForFunction(() => document.querySelectorAll("#at-rawx .at-rawx-sec").length > 0, null, { timeout: 8000 }).catch(() => {});
    const rx1 = await page.evaluate(() => ({
      meta: document.querySelector("#at-rawx .at-rawx-meta")?.textContent || "",
      secs: [...document.querySelectorAll("#at-rawx .at-rawx-sec")].map((s) => s.dataset.section),
      drawn: document.querySelectorAll("#at-rawx .at-rawx-field").length,
      types: document.querySelectorAll("#at-rawx .at-rawx-types .at-page-chip").length,
    }));
    check("opening it reads the stored response into sections", /^sse · .* fields in \d+ sections$/.test(rx1.meta) && ["answer", "sources", "searches", "request"].every((s) => rx1.secs.includes(s)), JSON.stringify(rx1));
    check("sections stay closed and undrawn until opened", rx1.drawn === 0 && rx1.types > 0, JSON.stringify(rx1));
    await page.evaluate(() => document.querySelector('#at-rawx .at-rawx-sec[data-section="sources"] > summary').click());
    await page.waitForTimeout(300);
    const rx2 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#at-rawx .at-rawx-sec[data-section="sources"] .at-rawx-field')];
      return { n: rows.length, url: rows.some((r) => /https:\/\//.test(r.textContent)), wide: document.documentElement.scrollWidth <= window.innerWidth };
    });
    check("a section lists its fields with samples, without widening the page", rx2.n > 3 && rx2.url && rx2.wide, JSON.stringify(rx2));
    // Values wrap instead of being cut, and "Show all" opens them in full (0.60.2).
    await page.evaluate(() => document.querySelector('#at-rawx .at-rawx-sec[data-section="searches"] > summary').click());
    await page.waitForTimeout(300);
    const rx3 = await page.evaluate(() => {
      const sec = document.querySelector('#at-rawx .at-rawx-sec[data-section="searches"]');
      const v = sec.querySelector(".at-rawx-val");
      const btn = sec.querySelector(".at-rawx-more");
      const nowrap = [...document.querySelectorAll("#at-rawx .at-rawx-val")].some((x) => getComputedStyle(x).whiteSpace === "nowrap" || getComputedStyle(x).textOverflow === "ellipsis");
      btn && btn.click();
      const pre = sec.querySelector(".at-rawx-full pre");
      return { val: v ? v.textContent : "", nowrap, pre: pre ? pre.textContent : "", expanded: btn && btn.getAttribute("aria-expanded") };
    });
    check("search values wrap, uncut, and Show all opens them in full", rx3.val && !rx3.val.endsWith("…") && !rx3.nowrap && rx3.pre.length >= rx3.val.length - 2 && rx3.expanded === "true", JSON.stringify(rx3).slice(0, 300));
    await page.evaluate(() => document.querySelector('#headerPage .at-detail-switch[aria-checked="true"]').click());
    await page.waitForTimeout(300);
    check("back in Simple it is hidden again", await page.evaluate(() => !document.getElementById("at-rawx")?.offsetParent));
    await page.evaluate(() => document.querySelector('#headerPage .at-detail-switch[aria-checked="false"]').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('#headerPage .at-detail-switch[aria-checked="true"]').click());
    await page.waitForTimeout(500);
  }

  console.log("\nPage through captures from the top bar (no search box since 0.60.2)");
  {
    await open(ids.shop);
    const bar = await page.evaluate(() => {
      const slot = document.getElementById("headerPage");
      return {
        find: !!slot?.querySelector('input[type="search"]'),
        paging: slot?.querySelector(".ap-paging")?.textContent || "",
        inHero: !!document.querySelector("#analyze .at-hero .ap-paging"),
      };
    });
    check("no search box on Analyze (reported: it made no sense there)", !bar.find, JSON.stringify(bar));
    // Five seeded captures, plus the built-in sample when it lands first on a
    // fresh install (CI saw "2 of 6").
    const of = Number((/^\d+ of (\d+)$/.exec(bar.paging) || [])[1]);
    check("the pager is in the bar, not in the prompt header", of >= 5 && !bar.inHero, JSON.stringify(bar));
    const p0 = await page.evaluate(() => document.querySelector("#headerPage .ap-paging")?.textContent);
    await page.evaluate(() => document.querySelector('#headerPage [aria-label="Older capture"]')?.click());
    await page.waitForTimeout(1500);
    const p1 = await page.evaluate(() => document.querySelector("#headerPage .ap-paging")?.textContent);
    check("Older moves one capture on", p0 && p1 && Number(p1.split(" ")[0]) === Number(p0.split(" ")[0]) + 1, `${p0} → ${p1}`);
    await page.evaluate(() => document.querySelector('[data-tab="dashboard"]').click());
    await page.waitForTimeout(500);
    check("the tools leave the bar with the page", await page.evaluate(() => !document.querySelector("#headerPage .at-pager")));
    await page.evaluate(() => document.querySelector('[data-tab="analyze"]').click());
    await page.waitForTimeout(500);
    check("and come back with it", await page.evaluate(() => !!document.querySelector("#headerPage .at-pager")));
  }

  console.log("\nA long, paragraph-length prompt");
  {
    await open(ids.long);
    const r = await page.evaluate(() => {
      const h = document.querySelector("#analyze .at-prompt");
      const btn = [...document.querySelectorAll("#analyze .at-hero > .ap-link")].find((b) => /whole prompt/.test(b.textContent));
      return { clamped: h.classList.contains("clamped"), h: h.getBoundingClientRect().height, btn: !!btn, tag: document.querySelector("#analyze .at-hero .ap-tag")?.textContent || "" };
    });
    check("it is clamped to two lines", r.clamped && r.h < 70, Math.round(r.h));
    check("its length is named", /\d+-word prompt/.test(r.tag), r.tag);
    check("'Show the whole prompt' is offered", r.btn);
    await page.evaluate(() => [...document.querySelectorAll("#analyze .at-hero > .ap-link")].find((b) => /whole prompt/.test(b.textContent))?.click());
    await page.waitForTimeout(400);
    const o = await page.evaluate(() => {
      const h = document.querySelector("#analyze .at-prompt");
      return { clamped: h.classList.contains("clamped"), full: h.scrollHeight <= h.clientHeight + 1, h: h.getBoundingClientRect().height };
    });
    check("and shows all of it", !o.clamped && o.full && o.h > 70, JSON.stringify(o));
  }

  console.log("\nA local answer: places, and names with ' - ' in them");
  {
    await open(ids.local);
    const r = await page.evaluate(() => ({
      error: document.querySelector("#analyze")?.innerText.match(/Could not render[^\n]*/)?.[0] || "",
      places: document.querySelectorAll("#at-places .at-tr:not(.at-th)").length,
      pins: document.querySelectorAll("#at-answer .at-ans-places .ap-place").length,
      dashMark: [...document.querySelectorAll("#at-answer .at-mark")].some((m) => / - /.test(m.dataset.brand)),
      wrapped: [...document.querySelectorAll("#at-answer .at-ans-places .ap-place > .ap-muted")].filter((s) => s.getBoundingClientRect().height > 24).map((s) => s.textContent),
      kind: document.querySelector("#analyze .at-hero .ap-kind")?.textContent,
    }));
    check("it renders (no 'Invalid regular expression')", !r.error, r.error);
    check("it is read as a local answer", r.kind === "Local", r.kind);
    check("the places are listed on the left", r.places > 0, r.places);
    check("and pinned in order above the answer", r.pins === r.places, `${r.pins} vs ${r.places}`);
    check("a place named 'X - Y' is still marked in the text", r.dashMark);
    check("ratings stay on one line beside long names", r.wrapped.length === 0, r.wrapped.join());
  }

  console.log("\nA narrower window: one column, the answer under the analysis");
  {
    await page.setViewportSize({ width: 1000, height: 800 });
    await open(ids.shop);
    const r = await page.evaluate(() => {
      const m = document.querySelector("#analyze .at-main").getBoundingClientRect();
      const a = document.getElementById("at-answer").getBoundingClientRect();
      return { stacked: a.top >= m.bottom - 1, hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    check("the columns stack", r.stacked);
    check("nothing scrolls sideways", !r.hscroll);
  }

  console.log("\nDark mode");
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.setItem("cito-theme", "dark"));
    await open(ids.shop);
    const r = await page.evaluate(() => {
      const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
      const sec = getComputedStyle(document.querySelector("#at-glance"));
      const ans = getComputedStyle(document.getElementById("at-answer"));
      const txt = getComputedStyle(document.querySelector("#at-answer .at-answer-text"));
      return { sec: lum(sec.backgroundColor), ans: lum(ans.backgroundColor), txt: lum(txt.color) };
    });
    check("sections and the answer panel go dark, text goes light", r.sec < 0.25 && r.ans < 0.25 && r.txt > 0.6, JSON.stringify(r));
  }

  check("no page error anywhere above", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
