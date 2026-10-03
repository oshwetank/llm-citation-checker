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
 * The searches it ran come first, as in the popup; clicking a brand or a
 * cited page lights it up in the answer; the old detailed cards live under
 * Details, one at a time.
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

  console.log("\nTwo columns: the analysis on the left, the answer on the right");
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
      check("both columns get real width", r.widths[0] >= 700 && r.widths[1] >= 380, JSON.stringify(r.widths));
      check("not the popup layout, not the old single column", !r.popup && !r.oldColumn);
      check("nothing scrolls sideways", !r.hscroll);
      check("it rendered without an error", !r.error, r.error);
    }
  }

  console.log("\nSearches it ran come first, every one in full");
  {
    const r = await page.evaluate(() => {
      const secs = [...document.querySelectorAll("#analyze .at-main > .at-sec")];
      const rows = [...document.querySelectorAll("#at-searches .ap-fan-text")];
      return {
        first: secs[0]?.id,
        order: secs.map((s) => s.id),
        rows: rows.length,
        cut: rows.filter((x) => x.scrollWidth > x.clientWidth + 1 || getComputedStyle(x).textOverflow === "ellipsis").map((x) => x.textContent),
      };
    });
    check("the first section is the searches", r.first === "at-searches", r.order.join(" > "));
    check("the searches are listed", r.rows > 0, r.rows);
    check("no search is cut off", r.cut.length === 0, r.cut.join(" | "));
    check("then products, brands and pages", ["at-products", "at-brands", "at-pages"].every((id) => r.order.includes(id)) && r.order.indexOf("at-products") < r.order.indexOf("at-brands"), r.order.join(" > "));
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
  }

  console.log("\nClicking a brand or a cited page lights it up in the answer");
  {
    // From part-way down the page, as when reading the brand table.
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("#at-answer .at-answer-body").scrollTop = 0; });
    await page.evaluate(() => window.scrollTo(0, document.getElementById("at-brands").getBoundingClientRect().top + window.scrollY - 200));
    await page.waitForTimeout(400);
    const y0 = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.querySelector('#at-brands [data-focus-brand="Samsung"]')?.click());
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

    await page.evaluate(() => document.querySelector('#at-brands [data-focus-brand="OnePlus"]')?.click());
    await page.waitForTimeout(500);
    const a = await page.evaluate(() => ({
      focused: [...document.querySelectorAll("#at-answer .at-mark.focus")].map((m) => m.dataset.brand),
      dimmed: document.querySelector("#at-answer .at-answer-body")?.classList.contains("has-focus"),
      pressed: document.querySelector('#at-brands [data-focus-brand="OnePlus"]')?.getAttribute("aria-pressed"),
      clear: document.querySelector("#at-answer .at-hl-clear")?.textContent || "",
    }));
    check("only that brand's marks are lit", a.focused.length > 0 && a.focused.every((b) => b === "OnePlus"), a.focused.join());
    check("the rest of the answer is dimmed", a.dimmed === true);
    check("the brand's button says it is on", a.pressed === "true", a.pressed);
    check("a clear button names what is shown", /Showing OnePlus/.test(a.clear), a.clear);
    await page.evaluate(() => document.querySelector("#at-answer .at-hl-clear")?.click());
    await page.waitForTimeout(200);
    check("clear turns it off", await page.evaluate(() => !document.querySelector("#at-answer .at-mark.focus") && !document.querySelector("#at-answer .has-focus")));

    await page.evaluate(() => document.querySelector("#at-pages [data-focus-cite]")?.click());
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => ({
      n: document.querySelector("#at-pages [data-focus-cite]")?.dataset.focusCite,
      lit: [...document.querySelectorAll("#at-answer .at-cite.focus")].map((x) => x.dataset.n),
    }));
    check("'Show in answer' lights that citation", c.lit.length > 0 && c.lit.every((n) => n === c.n), `${c.n}: ${c.lit.join()}`);
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

  console.log("\nDetails: the detailed cards, one at a time");
  {
    const r = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll("#at-details .at-det-tabs .ap-sheet-tab")].map((t) => t.textContent),
      sources: !!document.querySelector("#at-details .at-det-panel #card-sources"),
      cards: document.querySelectorAll("#at-details .at-det-panel > .card").length,
    }));
    check("Details has tabs", r.tabs.length >= 3 && r.tabs[0] === "Every page it read", r.tabs.join(" | "));
    check("it opens on every page it read", r.sources);
    await page.evaluate(() => [...document.querySelectorAll("#at-details .ap-sheet-tab")].find((t) => t.textContent === "Technical")?.click());
    await page.waitForTimeout(500);
    const t = await page.evaluate(() => ({
      general: !!document.querySelector("#at-details .at-det-panel #card-general"),
      sources: !!document.querySelector("#at-details .at-det-panel #card-sources"),
    }));
    check("Technical swaps in the technical cards", t.general && !t.sources, JSON.stringify(t));
  }

  console.log("\nOne prompt, two engines: engine tabs and a comparison");
  {
    const tabs = await page.evaluate(() => [...document.querySelectorAll("#analyze .at-engines .at-engine-tab")].map((b) => ({ label: b.querySelector(".at-engine-tab-label").textContent.trim(), on: b.classList.contains("on") })));
    check("tabs: Compare, then one per engine", tabs.map((t) => t.label).join("|") === "Compare 2 engines|ChatGPT|Gemini", tabs.map((t) => t.label).join("|"));
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
        singleGone: !document.getElementById("at-searches"),
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
      const sec = getComputedStyle(document.querySelector("#at-searches"));
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
