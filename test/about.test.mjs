/*
 * about.test.mjs — About in five pages (0.51.0, release 5 of the redesign).
 *
 * The owner approved the About pages on the design canvas: Overview, Metric
 * glossary, Settings, Data & tools and Diagnostics, one at a time, with a
 * side menu in the full tab; in the popup, a home screen with a "Get started"
 * checklist and a list of the pages, one page deep. Until 0.50.0 About was one
 * long column of cards (the glossary alone ran 36 terms deep), settings saved
 * with no way to tell whether a change had been saved, and the activity log
 * was a closed disclosure at the bottom.
 *
 * test/about-view.test.mjs pins the rules (search, checklist, unsaved
 * settings, the storage meter, the log's counts, the version check). This
 * checks the screens, in a real browser, in both layouts.
 */
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-about-test";
const VERSION = JSON.parse(readFileSync(path.join(EXT_PATH, "manifest.json"), "utf8")).version;

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
  console.log("\nabout: CANNOT RUN — playwright is not installed.");
  console.log(`This guards an approved layout, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const URL_TAB = `chrome-extension://${extId}/ui/panel.html?mode=tab`;
  const URL_POPUP = `chrome-extension://${extId}/ui/panel.html`;

  // Before any page script runs: the first-run tour loads the sample answer
  // in the background, which would race this test's own clean start.
  await context.addInitScript(() => { try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* fine */ } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const ask = (msg) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  await page.goto(URL_POPUP);
  // A clean start: no sample answer, and one error in the activity log.
  await ask({ type: "demo-clear" });
  await ask({ type: "error-report", where: "about-test", name: "Error", message: "A synthetic error for the About test", stack: "" });

  const settle = (ms = 700) => page.waitForTimeout(ms);
  const openAbout = async (url, size) => {
    await page.setViewportSize(size);
    await page.goto(url);
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await settle(1200);
  };
  const go = async (label) => {
    await page.evaluate((l) => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes(l))?.click(), label);
    await settle();
  };
  const shown = () => page.evaluate(() => ({ ab: document.getElementById("about").dataset.ab, visible: [...document.querySelectorAll("#about .ab-sec")].filter((s) => !s.hidden).map((s) => s.dataset.sec) }));

  /* ---------------- the full tab ---------------- */
  await openAbout(URL_TAB, { width: 1280, height: 900 });

  console.log("\na side menu, one page at a time");
  {
    const nav = await page.evaluate(() => [...document.querySelectorAll("#abNav .ab-nav-btn")].map((b) => b.querySelector(".ab-nav-label")?.textContent));
    check("five pages in the side menu", nav.join("|") === "Overview|Metric glossary|Settings|Data & tools|Diagnostics", nav.join(" | "));
    const s = await shown();
    check("it opens on the overview, and only the overview", s.ab === "overview" && s.visible.join() === "overview", JSON.stringify(s));
    const geo = await page.evaluate(() => {
      const side = document.querySelector(".ab-side").getBoundingClientRect(), main = document.querySelector(".ab-main").getBoundingClientRect();
      return { sideW: Math.round(side.width), top: Math.round(Math.abs(side.top - main.top)), beside: side.right <= main.left };
    });
    check("the menu sits beside the page, the same top edge", geo.beside && geo.top <= 2 && geo.sideW > 180 && geo.sideW < 280, JSON.stringify(geo));
    const status = await page.evaluate(() => document.getElementById("abBuild").textContent);
    check("under it, whether every part is the same version", status.includes("Up to date") && status.includes(VERSION), status);
    const badge = await page.evaluate(() => document.querySelector("#abNav .ab-nav-badge")?.textContent);
    check("and the activity log's errors, on Diagnostics", badge === "1", String(badge));
  }

  console.log("\nthe overview");
  {
    const o = await page.evaluate(() => {
      const box = document.getElementById("abOverview");
      return {
        badge: box.querySelector(".version-badge")?.textContent,
        facts: [...box.querySelectorAll(".ab-fact")].map((x) => x.textContent),
        engines: [...box.querySelectorAll(".ab-works .ab-engine")].map((x) => x.textContent),
        steps: [...box.querySelectorAll(".ab-how li")].map((li) => ({ title: li.querySelector("b")?.textContent, where: li.querySelector(".ab-where")?.textContent })),
        news: box.querySelectorAll(".ab-news li").length,
        text: box.textContent,
      };
    });
    check("the version comes from the build, so it can't go stale", o.badge === `v${VERSION}`, o.badge);
    check("what stays private, in three plain facts", o.facts.join("|") === "No account|No server|No requests of its own", o.facts.join(" | "));
    check("the four engines it works with", o.engines.join("|") === "ChatGPT|Gemini|Perplexity|Grok", o.engines.join(" | "));
    check("how it works: four steps, three of them a tab", o.steps.length === 4 && o.steps.slice(1).map((s) => s.where).join("|") === "Analyze →|Dashboard →|Campaigns →", JSON.stringify(o.steps));
    check("and none of them is the Compare tab, which left the menu in 0.47.0", !/Compare/.test(o.steps.map((s) => s.where).join()));
    check("what's new is listed", o.news >= 3, String(o.news));
    await page.evaluate(() => [...document.querySelectorAll("#abOverview .ab-where")].find((b) => b.textContent.startsWith("Dashboard"))?.click());
    await settle();
    check("a step's link opens its tab", await page.evaluate(() => document.getElementById("dashboard").classList.contains("active")));
    await page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await settle();
    check("and About comes back on the page it was on", (await shown()).ab === "overview");
  }

  console.log("\nthe metric glossary");
  {
    await go("Metric glossary");
    const s = await shown();
    check("its own page", s.visible.join() === "glossary", JSON.stringify(s));
    const all = await page.evaluate(() => ({ count: document.getElementById("abGlossCount").textContent, rows: document.querySelectorAll("#glossaryList .ab-term-row").length, chips: [...document.querySelectorAll("#abGlossChips .ab-chip-btn")].map((c) => c.textContent) }));
    check("every term, with the count", all.rows === 36 && all.count === "36 terms", JSON.stringify(all));
    check("a chip for each group, with its count", all.chips[0] === "All36" && all.chips.length === 7, all.chips.join(" | "));

    await page.fill("#abGlossSearch", "cited");
    await settle(300);
    const found = await page.evaluate(() => [...document.querySelectorAll("#glossaryList .ab-term-row")].map((r) => r.dataset.key));
    check("searching narrows the list as you type", found.length > 0 && found.length < 36 && found.includes("citedRate"), found.join(", "));
    check("and keeps focus in the search box", await page.evaluate(() => document.activeElement?.id === "abGlossSearch"));
    await page.evaluate(() => document.querySelector('#glossaryList .ab-term-row[data-key="citedRate"]')?.click());
    await settle(300);
    const d = await page.evaluate(() => {
      const box = document.querySelector(".ab-gloss-detail");
      return box && { title: box.querySelector(".ab-detail-title")?.textContent, group: box.querySelector(".ab-eyebrow")?.textContent, labels: [...box.querySelectorAll(".ab-label")].map((x) => x.textContent), on: document.querySelector(".ab-term-row.on")?.dataset.key };
    });
    check("picking a term shows it beside the list", d && d.title === "Cited %" && d.group === "Source metrics" && d.on === "citedRate", JSON.stringify(d));
    // 0.59.0: no "How to use it" advice; a term is defined, not prescribed.
    check("with its formula and what to keep in mind, and no advice", d && d.labels.join("|") === "Formula|Keep in mind", d && d.labels.join(" | "));

    await page.fill("#abGlossSearch", "");
    await page.evaluate(() => [...document.querySelectorAll("#abGlossChips .ab-chip-btn")].find((c) => c.textContent.startsWith("Source metrics"))?.click());
    await settle(300);
    const groups = await page.evaluate(() => [...document.querySelectorAll("#glossaryList .ab-gloss-group")].map((g) => g.textContent));
    check("a group chip keeps that group", groups.join() === "Source metrics", groups.join(" | "));
    await page.evaluate(() => document.querySelector("#abGlossChips .ab-chip-btn")?.click());
    await page.fill("#abGlossSearch", "zebra");
    await settle(300);
    const none = await page.evaluate(() => document.querySelector("#glossaryList .ab-empty")?.textContent || "");
    check("no match says so", /No terms match “zebra”/.test(none), none);
    await page.evaluate(() => document.querySelector("#glossaryList .ab-empty button")?.click());
    await settle(300);
    check("and Clear the search brings them all back", await page.evaluate(() => document.querySelectorAll("#glossaryList .ab-term-row").length === 36 && document.getElementById("abGlossSearch").value === ""));
  }

  console.log("\nsettings, with unsaved changes shown");
  {
    await go("Settings");
    const st = () => page.evaluate(() => ({
      keep: document.getElementById("setRetention").value, mb: document.getElementById("setMaxMB").value,
      status: document.getElementById("setStatus").textContent, save: !document.getElementById("setSave").disabled, undo: !document.getElementById("setUndo").disabled,
      meter: document.querySelector("#storageInfo .ab-meter-num")?.textContent || "", debug: document.getElementById("setDebugText").textContent,
    }));
    const a = await st();
    check("the stored values are filled in", a.keep === "2000" && a.mb === "8", JSON.stringify(a));
    check("nothing to save yet, and it says so", a.status === "All settings saved" && !a.save && !a.undo, JSON.stringify(a));
    check("how full storage is, against the limit", /^\d[\d,]* of 2,000 kept$/.test(a.meter), a.meter);
    await page.evaluate(() => document.querySelector('.ab-stepbtn[data-step="setRetention"][data-dir="1"]').click());
    await settle(200);
    const b = await st();
    check("+ adds a step", b.keep === "2050", b.keep);
    check("a change is marked unsaved, and can be saved or undone", b.status === "Unsaved changes" && b.save && b.undo, JSON.stringify(b));
    await page.evaluate(() => document.getElementById("setUndo").click());
    await settle(200);
    const c = await st();
    check("Undo changes puts it back", c.keep === "2000" && c.status === "All settings saved" && !c.save, JSON.stringify(c));
    await page.fill("#setMaxMB", "0");
    await page.evaluate(() => document.querySelector(".ab-switch").click());
    await settle(200);
    check("the debugger switch says what it's set to", (await st()).debug === "On");
    await page.evaluate(() => document.getElementById("setSave").click());
    await settle(600);
    const e = await st();
    check("saving says so", e.status === "Settings saved" && !e.save, JSON.stringify(e));
    check("and a value under the minimum is saved as the minimum", e.mb === "1", e.mb);
    const stored = await ask({ type: "settings-get" });
    check("it's really stored", stored && stored.settings && stored.settings.maxCaptureMB === 1 && stored.settings.debugCapture === true, JSON.stringify(stored && stored.settings));
    await ask({ type: "settings-set", patch: { maxCaptureMB: 8, debugCapture: false } });
  }

  console.log("\ndata & tools");
  {
    await go("Data & tools");
    const chip = () => page.evaluate(() => ({ chip: document.getElementById("demoStatus").textContent, btn: document.getElementById("demoToggle").textContent }));
    const a = await chip();
    check("the sample's state is shown", a.chip === "Not loaded" && a.btn === "Load sample", JSON.stringify(a));
    await page.evaluate(() => document.getElementById("demoToggle").click());
    await settle(2500);
    const b = await chip();
    check("loading it updates the page", b.chip === "Loaded" && b.btn === "Remove sample", JSON.stringify(b));
    await page.evaluate(() => document.getElementById("demoToggle").click());
    await settle(2500);
    check("and removing it too", (await chip()).chip === "Not loaded");
    await page.evaluate(() => document.getElementById("reprocess").click());
    await settle(2500);
    const done = await page.evaluate(() => document.getElementById("reprocessStatus").textContent);
    check("Reprocess says what it did, beside its own button", /^Done\. \d/.test(done), done);
  }

  console.log("\ndiagnostics");
  {
    await go("Diagnostics");
    await settle(800);
    const d = await page.evaluate(() => ({
      build: document.getElementById("abBuildFull").textContent,
      chips: [...document.querySelectorAll("#diagChips .ab-chip-btn")].map((c) => c.textContent),
      rows: [...document.querySelectorAll("#diagLog .ab-log-row")].map((r) => r.textContent),
      campaign: document.getElementById("diagExportProfile").textContent,
    }));
    check("whether every part is the same version", d.build.includes(`both version ${VERSION}`), d.build);
    check("the log, with a count for each kind", d.chips[0] === "All1" && d.chips[1] === "Errors1", d.chips.join(" | "));
    check("and the error in it", d.rows.length === 1 && d.rows[0].includes("A synthetic error for the About test"), d.rows.join(" | "));
    check("the campaign export says when there's nothing to export", d.campaign === "No campaigns yet", d.campaign);
    await page.evaluate(() => [...document.querySelectorAll("#diagChips .ab-chip-btn")].find((c) => c.textContent.startsWith("Turns"))?.click());
    await settle(200);
    check("a kind with nothing in it says so", /Nothing of this kind recorded/.test(await page.evaluate(() => document.getElementById("diagLog").textContent)));
    await page.evaluate(() => document.getElementById("diagClear").click());
    await settle(800);
    const after = await page.evaluate(() => ({ log: document.getElementById("diagLog").textContent, badge: !!document.querySelector("#abNav .ab-nav-badge") }));
    check("Clear log empties it, and the menu's error count goes", /The log is empty/.test(after.log) && !after.badge, JSON.stringify(after));
  }

  /* ---------------- the popup ---------------- */
  console.log("\nthe popup opens on a home screen");
  await openAbout(URL_POPUP, { width: 540, height: 600 });
  const home = () => page.evaluate(() => ({
    title: document.getElementById("abHomeTitle")?.textContent,
    progress: document.querySelector(".ab-progress-text")?.textContent || "",
    steps: [...document.querySelectorAll(".ab-steps-list .ab-step")].map((s) => `${s.dataset.step}:${s.classList.contains("done") ? "done" : "todo"}`),
    allDone: document.querySelector(".ab-alldone")?.textContent || "",
    more: [...document.querySelectorAll(".ab-more-row b")].map((b) => b.textContent),
    side: getComputedStyle(document.querySelector(".ab-side")).display,
    wide: (() => { const c = document.querySelector(".app-content"); return c.scrollWidth - c.clientWidth; })(),
  }));
  {
    const h = await home();
    check("a first visit is welcomed", h.title === "Welcome to CitoSkeleton", h.title);
    check("with three steps to get started, none done", h.progress === "0 of 3 done" && h.steps.join() === "ask:todo,analyze:todo,campaign:todo", JSON.stringify(h));
    check("then the pages, as a list", h.more.join("|") === "Metric glossary|Settings|Data & tools|Diagnostics|What’s new", h.more.join(" | "));
    check("no side menu in the popup", h.side === "none", h.side);
    check("and nothing wider than the popup", h.wide <= 0, `${h.wide}px`);

    await go("Metric glossary");
    const g = await page.evaluate(() => ({ head: document.getElementById("abSubhead").textContent, rows: document.querySelectorAll("#glossaryList .ab-term-row").length }));
    check("a page has a way back, and its title", g.head.startsWith("← About") && g.head.includes("Metric glossary") && !/null/.test(g.head), g.head);
    await page.evaluate(() => document.querySelector('#glossaryList .ab-term-row[data-key="citedRate"]')?.click());
    await settle();
    const t = await page.evaluate(() => ({ head: document.getElementById("abSubhead").textContent, body: document.getElementById("abTerm").textContent, ab: document.getElementById("about").dataset.ab }));
    check("a term is a page of its own", t.ab === "term" && t.head.startsWith("← Glossary") && t.head.includes("Cited %") && /Formula/.test(t.body), JSON.stringify(t).slice(0, 200));
    await page.evaluate(() => document.querySelector(".ab-back").click());
    await settle();
    check("back goes to the glossary", (await shown()).ab === "glossary");
    await page.evaluate(() => document.querySelector(".ab-back").click());
    await settle();
    check("and back again to the home screen", (await shown()).ab === "home");

    for (const p of ["Settings", "Data & tools", "Diagnostics", "What’s new"]) {
      await go(p);
      const w = await page.evaluate(() => { const c = document.querySelector(".app-content"); return c.scrollWidth - c.clientWidth; });
      check(`${p} fits the popup`, w <= 0, `${w}px`);
      await page.evaluate(() => document.querySelector(".ab-back").click());
      await settle();
    }
  }

  console.log("\ngetting started is done by doing it");
  {
    // The sample answer doesn't count as your first capture, even read in Analyze.
    await ask({ type: "demo-load" });
    await openAbout(URL_POPUP, { width: 540, height: 600 });
    await page.evaluate(() => document.querySelector('[data-tab="analyze"]')?.click());
    await settle(1200);
    await page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await settle();
    const s = await home();
    check("the sample, even opened in Analyze, doesn't tick anything", s.progress === "0 of 3 done", JSON.stringify(s.steps));
    check("the home screen says the sample is on", await page.evaluate(() => /Sample data is on/.test(document.getElementById("abHome").textContent)));
    await page.evaluate(() => [...document.querySelectorAll(".ab-step button")].find((b) => b.textContent === "Open Analyze")?.click());
    await settle(1200);
    check("step two's button opens Analyze", await page.evaluate(() => document.getElementById("analyze").classList.contains("active")));
    await ask({ type: "demo-clear" });

    const raw = readFileSync(path.join(FIXDIR, "chatgpt-tv.txt"), "utf8");
    await ask({ type: "raw-conversation", payload: { raw, reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: ["best tv to buy"] } }] }), pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    // The popup opens on Analyze, on the newest answer: a real capture is
    // read the moment the popup is opened, so steps one and two go together.
    await page.setViewportSize({ width: 540, height: 600 });
    await page.goto(URL_POPUP);
    await settle(1500);
    const onAnalyze = await page.evaluate(() => document.getElementById("analyze").classList.contains("active") && /best tv to buy/i.test(document.getElementById("analyze").textContent));
    check("the popup opens on Analyze, showing the new answer", onAnalyze);
    await page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await settle();
    const two = await home();
    check("a real capture, read in Analyze, is steps one and two", two.progress === "2 of 3 done" && two.steps.join() === "ask:done,analyze:done,campaign:todo", JSON.stringify(two));
    check("and the welcome becomes the name", two.title === "CitoSkeleton", two.title);
    await ask({ type: "geo-profile-save", profile: { name: "About Test", brand: { name: "Synthbrand", url: "synthbrand.example" }, competitors: [], engines: ["chatgpt"] } });
    await openAbout(URL_POPUP, { width: 540, height: 600 });
    const three = await home();
    check("a campaign is step three, and then it says you're set", three.steps.length === 0 && /You’re all set/.test(three.allDone), JSON.stringify(three));
  }

  check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
