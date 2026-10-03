/*
 * full-audit.test.mjs — the whole-app regression net.
 *
 * Reported, repeatedly: "whenever we make some changes to the tool something
 * for sure breaks." That has been true, and the reason is structural rather
 * than careless — the app is one ~6000-line panel module where every tab
 * shares module-level state, so a rename or a deleted helper in one place
 * lands as a ReferenceError in a render path nothing exercises. Two shipped
 * bugs came from exactly that: the Compare tab blanked because ENGINE_ICONS
 * was deleted while five call sites still read it, and the whole panel went
 * blank when a stray brace survived a merge. Both were invisible to CI and
 * visible to the user.
 *
 * So this file is deliberately BROAD rather than deep. It does not check that
 * any number is correct — the focused tests do that. It checks that nothing
 * in the app throws or renders empty when a real user touches it:
 *
 *   1. Every message type the service worker handles gets called, with
 *      realistic arguments, and must answer. A handler that throws or never
 *      responds is a hang in the UI.
 *   2. Every tab renders, with content, no page errors.
 *   3. Every filter, select, and toggle in every tab gets exercised.
 *   4. Every drilldown (capture, brand, URL, prompt) opens.
 *   5. Every export runs to completion.
 *   6. Every button that isn't destructive gets clicked.
 *
 * The bar is "no uncaught error and something rendered", because that is the
 * failure mode that actually reaches users.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-audit";

// A mix of engines and verticals so brand/product/place paths all get data.
const FIXTURES = [
  ["chatgpt-phone-under.txt", "https://chatgpt.com/", "best smartphone under 50000"],
  ["chatgpt-tv.txt", "https://chatgpt.com/", "best 55 inch tv"],
  ["chatgpt-perfume.txt", "https://chatgpt.com/", "best perfume for men"],
  ["gemini-streamgenerate.txt", "https://gemini.google.com/app", "best laptop for students"],
];

let failures = 0;
const problems = [];
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ✓ ${label}`); return true; }
  failures++;
  problems.push(`${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  return false;
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
  console.log("\nfull-audit: CANNOT RUN — playwright is not installed.");
  console.log(`This is the app-wide regression net, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

const pageErrors = [];
const noise = /Failed to load resource|net::ERR_|fonts\.(googleapis|gstatic)|favicon/i;

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (noise.test(t)) return;
    pageErrors.push("console: " + t);
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  const drain = () => { const e = [...pageErrors]; pageErrors.length = 0; return e; };
  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) res({ __timeout: true }); }, 25000);
      try {
        chrome.runtime.sendMessage(m, (r) => { done = true; clearTimeout(t); res(r === undefined ? { __undefined: true } : r); });
      } catch (err) { done = true; clearTimeout(t); res({ __threw: String(err && err.message || err) }); }
    }), msg);

  /* ---------- seed realistic data ---------- */
  console.log("\nSeeding real captures through the real capture path");
  for (const [file, pageUrl, prompt] of FIXTURES) {
    const raw = readFileSync(path.join(HERE, "fixtures", file), "utf8");
    const reqBody = JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [prompt] } }] });
    const r = await ask({ type: "raw-conversation", payload: { raw, reqBody, pageUrl, capturedAt: Date.now() } });
    check(`captured ${file}`, r && !r.__timeout && !r.__threw, JSON.stringify(r).slice(0, 160));
    await page.waitForTimeout(600);
  }

  const stats = await ask({ type: "stats" });
  check("stats reports the captures landed", stats && stats.ok !== false, JSON.stringify(stats).slice(0, 200));

  // Turn them into a campaign with TWO runs of the same prompts, which is what
  // the per-run view and Compare both need.
  const seeded = await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => {
      // No version argument on purpose. Hardcoding one (this said 4) breaks with
      // a VersionError the moment db.js adds a store and bumps DB_VERSION —
      // which it did, for the error log. Opening without a version attaches to
      // whatever the extension has already created, which is what a seed wants.
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const all = (s) => new Promise((res) => { const r = dbh.transaction(s, "readonly").objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const put = (s, v) => new Promise((res, rej) => { const r = dbh.transaction(s, "readwrite").objectStore(s).put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });

    const derived = await all("derived");
    if (!derived.length) return { error: "no derived records" };
    const counts = new Map();
    for (const rec of derived) for (const b of rec.brandMentions || []) counts.set(b.brand, (counts.get(b.brand) || 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const profileId = crypto.randomUUID();
    await put("profiles", {
      id: profileId, name: "Audit Campaign",
      brand: { name: ranked[0] || "Acme", url: "acme.example" },
      competitors: ranked.slice(1, 4).map((n) => ({ name: n, url: "" })),
      engines: ["chatgpt", "gemini"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
      tags: ["audit"],
    });
    const runIds = [crypto.randomUUID(), crypto.randomUUID()];
    const promptIds = [];
    for (const rec of derived) {
      const promptId = crypto.randomUUID();
      promptIds.push(promptId);
      await put("trackedPrompts", { id: promptId, profileId, text: rec.userPrompt || `capture ${rec.captureId}`, tags: ["audit"], active: true, createdAt: Date.now() });
      /* Campaign copies are ADDED; the originals stay ad-hoc.
       *
       * The first version of this seed stamped a geo bag onto every existing
       * record, which left zero ad-hoc captures — a state a real user is
       * never in, since they browse as well as run campaigns. It also hid a
       * genuine bug behind a test artefact: with RECORDS empty, Analyze
       * rendered its empty state and the audit happily reported "0 buttons
       * clicked cleanly". Seeding both kinds keeps the isolation between
       * ad-hoc and campaign data under test, which is the point.
       */
      for (const [i, runId] of runIds.entries()) {
        await put("derived", {
          ...rec,
          captureId: `${rec.captureId}-r${i + 1}`,
          capturedAt: rec.capturedAt + i * 86400000,
          geo: { profileId, runId, promptId, tags: ["audit"] },
        });
      }
    }
    for (const [i, runId] of runIds.entries()) {
      await put("geoRuns", {
        id: runId, profileId, startedAt: Date.now() - (2 - i) * 3600000,
        finishedAt: Date.now() - (2 - i) * 3600000 + 900000,
        status: "done", engines: ["chatgpt", "gemini"],
        expected: derived.length, captured: derived.length, failed: i === 1 ? 1 : 0,
        reasons: i === 1 ? { timeout: 1 } : {},
      });
    }
    return { profileId, runIds, promptIds, brands: ranked.slice(0, 4), captures: derived.length };
  });
  check("campaign with two runs seeded", !seeded.error, JSON.stringify(seeded).slice(0, 200));
  if (seeded.error) throw new Error("cannot audit without seed data: " + seeded.error);

  const recs = await ask({ type: "get-records" });
  const someCapture = (recs && recs.records && recs.records[0]) || null;
  check("get-records returns records", !!someCapture, JSON.stringify(recs).slice(0, 160));

  /* ---------- 1. every backend message type ---------- */
  console.log("\nEvery service-worker message type answers (a hang here freezes the UI)");
  const CAP = someCapture ? someCapture.captureId : "none";
  const PID = seeded.profileId;
  const CALLS = [
    ["stats", { type: "stats" }],
    ["settings-get", { type: "settings-get" }],
    ["get-records", { type: "get-records" }],
    ["get-record", { type: "get-record", captureId: CAP }],
    ["get-raw", { type: "get-raw", captureId: CAP }],
    ["run-list", { type: "run-list" }],
    ["project-list", { type: "project-list" }],
    ["geo-profile-list", { type: "geo-profile-list" }],
    ["geo-prompt-list", { type: "geo-prompt-list", profileId: PID }],
    ["geo-run-list", { type: "geo-run-list", profileId: PID }],
    ["geo-metrics", { type: "geo-metrics", profileId: PID }],
    ["geo-metrics (engine filter)", { type: "geo-metrics", profileId: PID, engines: ["chatgpt"] }],
    ["geo-metrics (tag filter)", { type: "geo-metrics", profileId: PID, tags: ["audit"] }],
    ["geo-metrics (date window)", { type: "geo-metrics", profileId: PID, since: Date.now() - 7 * 86400000, until: Date.now() }],
    ["geo-prompt-performance", { type: "geo-prompt-performance", profileId: PID }],
    ["geo-brand-detail", { type: "geo-brand-detail", profileId: PID, name: seeded.brands[0] }],
    ["geo-url-detail", { type: "geo-url-detail", profileId: PID, domain: "amazon.in" }],
    ["loader-status", { type: "loader-status" }],
    ["get-debug", { type: "get-debug" }],
    ["debug", { type: "debug", event: { kind: "audit-probe", at: Date.now() } }],
  ];
  for (const [label, msg] of CALLS) {
    const r = await ask(msg);
    const bad = !r || r.__timeout || r.__threw || r.__undefined;
    check(`${label} responds`, !bad, JSON.stringify(r).slice(0, 200));
  }

  // Writes, on throwaway data, so nothing above is disturbed.
  console.log("\nWrite paths answer too");
  const wp = await ask({ type: "project-save", project: { name: "Audit Project" } });
  check("project-save responds", wp && !wp.__timeout && !wp.__threw, JSON.stringify(wp).slice(0, 160));
  const sv = await ask({ type: "settings-set", settings: { retention: 2000, maxMB: 12, debug: false } });
  check("settings-set responds", sv && !sv.__timeout && !sv.__threw, JSON.stringify(sv).slice(0, 160));
  const ps = await ask({ type: "geo-prompt-save", profileId: PID, prompt: { text: "audit probe prompt", tags: ["audit"], active: true } });
  check("geo-prompt-save responds", ps && !ps.__timeout && !ps.__threw, JSON.stringify(ps).slice(0, 160));
  const bulk = await ask({ type: "geo-prompt-bulk-add-rows", profileId: PID, rows: [["audit bulk one", "audit"], ["audit bulk two", ""]] });
  check("geo-prompt-bulk-add-rows responds", bulk && !bulk.__timeout && !bulk.__threw, JSON.stringify(bulk).slice(0, 160));
  const lp = await ask({ type: "loader-pause" });
  check("loader-pause responds even with no run active", lp && !lp.__timeout && !lp.__threw, JSON.stringify(lp).slice(0, 160));
  const lr = await ask({ type: "loader-resume" });
  check("loader-resume responds even with no run active", lr && !lr.__timeout && !lr.__threw, JSON.stringify(lr).slice(0, 160));
  const ls = await ask({ type: "loader-stop" });
  check("loader-stop responds even with no run active", ls && !ls.__timeout && !ls.__threw, JSON.stringify(ls).slice(0, 160));
  check("no page errors from the message sweep", drain().length === 0, drain().join(" | "));

  /* ---------- 2. every tab renders ---------- */
  await page.reload();
  await page.waitForTimeout(3000);
  drain();

  // Compare left the top menu in 0.47.0 (it opens from an answer instead);
  // compare-tab.test.mjs renders it that way.
  const TABS = ["analyze", "dashboard", "loader", "about"];
  /* The interactive surface each tab MUST have once data exists.
   *
   * Without this, a tab that silently rendered its empty state satisfied
   * every other assertion here — it has text, it has children, nothing threw.
   * These floors are set below what each tab actually renders with the seeded
   * data (Analyze alone has ~18 buttons), so they catch "this tab collapsed to
   * an empty state" without being brittle about exact counts.
   */
  const MIN_CONTROLS = {
    analyze: { buttons: 6, selects: 0 },
    // Since 0.49.0 the period is a row of buttons and Sort the one select.
    dashboard: { buttons: 12, selects: 1 },
    loader: { buttons: 3, selects: 0 },
    compare: { buttons: 0, selects: 3 },
    about: { buttons: 2, selects: 0 },
  };
  console.log("\nEvery tab renders with content and without throwing");
  for (const tab of TABS) {
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(1400);
    const r = await page.evaluate((t) => {
      const el = document.getElementById(t);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return {
        exists: true,
        len: el.innerText.trim().length,
        children: el.children.length,
        visible: cs.display !== "none" && parseFloat(cs.opacity) > 0.01,
      };
    }, tab);
    const errs = drain();
    check(`#${tab} renders`, r.exists && r.visible && r.len > 50 && r.children > 0 && errs.length === 0,
      `exists=${r.exists} visible=${r.visible} len=${r.len} children=${r.children} errors=${errs.join(" | ")}`);

    const want = MIN_CONTROLS[tab];
    const got = await page.evaluate((t) => {
      const el = document.getElementById(t);
      return { buttons: el.querySelectorAll("button").length, selects: el.querySelectorAll("select").length };
    }, tab);
    check(`#${tab} rendered its real controls, not an empty state`,
      got.buttons >= want.buttons && got.selects >= want.selects,
      `buttons ${got.buttons}/${want.buttons}, selects ${got.selects}/${want.selects}`);
  }

  /* ---------- 3. every control in every tab ---------- */
  /* Each tab gets a FRESH page.
   *
   * The first cut of this reused one page across phases, and that produced a
   * false pass worth keeping in mind: exercising the Dashboard's timeframe
   * and campaign selects left filters in a state where no records matched, so
   * by the time the audit reached Analyze the tab rendered its empty state —
   * zero buttons, zero selects — and "0 buttons clicked cleanly" passed. An
   * audit that reports success because a tab rendered NOTHING is worse than
   * no audit. Hence both the reload and MIN_CONTROLS below.
   */
  console.log("\nEvery select and filter can be changed without throwing");
  for (const tab of TABS) {
    await page.reload();
    await page.waitForTimeout(2200);
    drain();
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(900);
    const selects = await page.evaluate((t) => {
      const root = document.getElementById(t);
      return [...root.querySelectorAll("select")].map((s, i) => ({
        i, id: s.id || `(select ${i})`, options: s.options.length,
      }));
    }, tab);
    for (const s of selects) {
      if (s.options < 2) continue;
      const res = await page.evaluate(async ({ t, i }) => {
        const root = document.getElementById(t);
        const sel = [...root.querySelectorAll("select")][i];
        const seen = [];
        for (let o = 0; o < Math.min(sel.options.length, 4); o++) {
          sel.value = sel.options[o].value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          seen.push(sel.options[o].value);
          await new Promise((r) => setTimeout(r, 450));
        }
        return seen;
      }, { t: tab, i: s.i });
      const errs = drain();
      check(`${tab}: <select #${s.id}> accepts all its options`, errs.length === 0,
        `tried ${JSON.stringify(res)} errors=${errs.join(" | ")}`);
    }

    // Checkboxes and text filters.
    const toggled = await page.evaluate(async (t) => {
      const root = document.getElementById(t);
      let n = 0;
      for (const cb of root.querySelectorAll('input[type="checkbox"]')) {
        cb.click(); await new Promise((r) => setTimeout(r, 120));
        cb.click(); await new Promise((r) => setTimeout(r, 120));
        n++;
      }
      for (const tx of root.querySelectorAll('input[type="text"], input[type="search"]')) {
        tx.value = "a";
        tx.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        tx.value = "";
        tx.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        n++;
      }
      return n;
    }, tab);
    const errs2 = drain();
    check(`${tab}: ${toggled} checkbox/text control(s) exercised`, errs2.length === 0, errs2.join(" | "));
  }

  /* ---------- 4. drilldowns ---------- */
  /* The path a user actually takes: Dashboard -> click a saved conversation ->
   * Analyze opens on that capture. The first cut looked for `tbody tr`, found
   * zero, and reported "clicked 0 without error" — a green line for a
   * drilldown that was never tested. Since 0.49.0 each Dashboard row's prompt
   * is a .db-prompt button, so that is what gets clicked.
   */
  console.log("\nDrilldowns open without throwing");
  await page.reload();
  await page.waitForTimeout(2500);
  drain();
  await page.evaluate(() => document.querySelector('[data-tab="dashboard"]')?.click());
  await page.waitForTimeout(1800);

  const rowCount = await page.evaluate(() =>
    document.getElementById("dashboard").querySelectorAll(".db-prompt").length);
  check("the dashboard lists prompts to drill into", rowCount > 0, `${rowCount} rows`);

  for (let i = 0; i < Math.min(rowCount, 3); i++) {
    const opened = await page.evaluate(async (idx) => {
      document.querySelector('[data-tab="dashboard"]')?.click();
      await new Promise((r) => setTimeout(r, 500));
      const rows = [...document.getElementById("dashboard").querySelectorAll(".db-prompt")];
      if (!rows[idx]) return { clicked: false };
      const label = rows[idx].innerText.trim().slice(0, 40);
      rows[idx].click();
      await new Promise((r) => setTimeout(r, 1400));
      const a = document.getElementById("analyze");
      return {
        clicked: true, label,
        onAnalyze: a.classList.contains("active"),
        len: a.innerText.trim().length,
      };
    }, i);
    const errs = drain();
    check(`opening Dashboard prompt ${i + 1} lands on a populated Analyze`,
      opened.clicked && opened.onAnalyze && opened.len > 200 && errs.length === 0,
      `${JSON.stringify(opened).slice(0, 180)} errors=${errs.join(" | ")}`);
  }

  // Brand and source drill-downs, reached from the campaign's results board
  // in Campaigns (0.50.0): a brand opens its detail in place of the board, a
  // domain opens a modal.
  console.log("\nCampaign brand/source drill-downs open and close");
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2500);
  drain();
  check("the campaign's results show in Campaigns", await page.evaluate(() => !!document.querySelector("#loader #campaignResults #cb-kpis")));
  for (const sel of ["#cb-brands .cb-brand-btn", "#cb-sources td.td-domain button", "#cb-gaps .cb-tr", "#cb-kpis .cb-focus-tab:nth-child(3)"]) {
    const found = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    if (!found) continue;
    await page.evaluate(async (s) => {
      const n = document.querySelector(s);
      if (n) { n.click(); await new Promise((r) => setTimeout(r, 1500)); }
      document.querySelector(".modal-backdrop, .backdrop, #url-modal-backdrop")?.remove();
      const back = document.querySelector(".cb-detail-head .analyze-context-back");
      if (back) { back.click(); await new Promise((r) => setTimeout(r, 1500)); }
    }, sel);
    const errs = drain();
    check(`${sel} opens cleanly`, errs.length === 0, errs.join(" | "));
  }

  /* ---------- 5. exports ---------- */
  console.log("\nEvery export runs to completion");
  // Downloads are stubbed: the point is that the builder doesn't throw, and
  // a real download would hang the headless run.
  await page.evaluate(() => {
    window.__downloads = [];
    const realCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__downloads.push({ size: b && b.size, type: b && b.type }); return realCreate(b); };
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[download]");
      if (a) e.preventDefault();
    }, true);
  });
  for (const tab of TABS) {
    await page.reload();
    await page.waitForTimeout(2200);
    await page.evaluate(() => {
      window.__downloads = [];
      const realCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__downloads.push({ size: b && b.size }); return realCreate(b); };
      document.addEventListener("click", (e) => {
        const a = e.target.closest && e.target.closest("a[download]");
        if (a) e.preventDefault();
      }, true);
    });
    drain();
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(1200);
    const btns = await page.evaluate((t) => {
      const root = document.getElementById(t);
      return [...root.querySelectorAll("button")]
        .map((b, i) => ({ i, label: (b.innerText || "").trim().slice(0, 40) }))
        .filter((b) => /export|download|csv|excel|xls|pdf|html|json|copy|report/i.test(b.label));
    }, tab);
    for (const b of btns) {
      await page.evaluate(async ({ t, i }) => {
        const root = document.getElementById(t);
        const btn = [...root.querySelectorAll("button")][i];
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 1200));
      }, { t: tab, i: b.i });
      const errs = drain();
      check(`${tab}: "${b.label}" completes`, errs.length === 0, errs.join(" | "));
    }
  }

  /* ---------- 6. remaining non-destructive buttons ---------- */
  console.log("\nEvery other non-destructive button is clickable");
  const DESTRUCTIVE = /delete|clear|remove|trash|reset|stop|start run|lock|reprocess|unlock/i;
  for (const tab of TABS) {
    await page.reload();
    await page.waitForTimeout(2200);
    drain();
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(1100);
    const res = await page.evaluate(async ({ t, destructiveSrc }) => {
      const destructive = new RegExp(destructiveSrc, "i");
      const root = document.getElementById(t);
      const btns = [...root.querySelectorAll("button")];
      const clicked = [];
      for (const b of btns) {
        const label = (b.innerText || "").trim();
        if (!label || destructive.test(label)) continue;
        b.click();
        clicked.push(label.slice(0, 30));
        await new Promise((r) => setTimeout(r, 260));
      }
      return clicked;
    }, { t: tab, destructiveSrc: DESTRUCTIVE.source });
    const errs = drain();
    check(`${tab}: ${res.length} button(s) clicked cleanly`,
      errs.length === 0 && res.length >= (MIN_CONTROLS[tab].buttons ? 1 : 0),
      `clicked=${JSON.stringify(res).slice(0, 200)} errors=${errs.join(" | ")}`);
  }

  /* ---------- 6b. the error log actually catches things ---------- */
  /* The error log only earns its place if it catches the failures that
   * previously vanished. The two that mattered historically are an uncaught
   * ReferenceError in a render path (which blanked the Compare tab and left
   * its message only in the popup's devtools console, gone the moment the
   * popup closed) and a handler throwing in the service worker. Both are
   * injected here for real rather than asserted against the module.
   */
  console.log("\nThe error log records failures that used to vanish");
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(2000);
  await ask({ type: "error-log-clear" });

  await page.evaluate(() => {
    setTimeout(() => { throw new ReferenceError("AUDIT_PROBE_SYMBOL is not defined"); }, 10);
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => { Promise.reject(new Error("audit probe rejection")); });
  await page.waitForTimeout(700);
  await ask({ type: "geo-metrics" });   // no profileId: the handler throws
  await page.waitForTimeout(700);

  const logged = await ask({ type: "error-log" });
  const groups = (logged && logged.grouped) || [];
  const blob = JSON.stringify(groups);
  check("the log answers", logged && logged.ok === true, JSON.stringify(logged).slice(0, 120));
  check("an uncaught render-path ReferenceError is captured — the blank-tab bug class",
    /AUDIT_PROBE_SYMBOL is not defined/.test(blob), blob.slice(0, 240));
  check("it records WHICH tab was showing, which is the 'and where' half",
    groups.some((g) => /AUDIT_PROBE_SYMBOL/.test(g.message) && g.context && g.context.tab),
    blob.slice(0, 240));
  check("an unhandled promise rejection is captured",
    /audit probe rejection/.test(blob), blob.slice(0, 240));
  check("a service-worker handler throwing is captured, tagged with the message type",
    groups.some((g) => /^message:geo-metrics$/.test(g.where)), blob.slice(0, 240));

  // Privacy is the other half of the bargain: this log is meant to be copied
  // and shared, so nothing the user typed or read may appear in it. The seeded
  // prompts and a domain the captures cite are checked for by name.
  check("no prompt text leaked into the log",
    !/smartphone under 50000|55 inch tv|perfume for men|laptop for students/i.test(blob),
    blob.slice(0, 240));
  check("no URLs leaked into the log", !/https?:\/\//.test(blob), blob.slice(0, 240));

  await ask({ type: "error-log-clear" });
  const cleared = await ask({ type: "error-log" });
  check("clearing empties the log", ((cleared && cleared.entries) || []).length === 0,
    String(((cleared && cleared.entries) || []).length));

  /* ---------- 7. popup width, where layout bugs hide ---------- */
  /* 540px, not an arbitrary narrow width.
   *
   * panel.css sets `min-width: 540px !important` on html/body.popup as the
   * design's declared floor, and Chrome sizes an extension popup to its
   * content (up to 800px), so 540 is the narrowest a real popup can be. An
   * earlier version of this test used 420px and reported a horizontal-scroll
   * failure — which was the test's fault, not the CSS's: it was asserting
   * against a viewport the popup cannot have. Measuring at the real floor is
   * what catches an actual overflow.
   */
  console.log("\nThe popup layout (540px, the design's declared minimum) renders too");
  await page.setViewportSize({ width: 540, height: 700 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(2500);
  drain();
  for (const tab of TABS) {
    // Reload per tab here too. Without it the popup phase inherited state
    // from the earlier button-clicking sweep and reported panels as
    // display:none — a false failure that cost real time to chase.
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(2200);
    drain();
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(1200);
    const r = await page.evaluate((t) => {
      const el = document.getElementById(t);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return { exists: true, len: el.innerText.trim().length, display: cs.display, opacity: cs.opacity,
               visible: cs.display !== "none" && parseFloat(cs.opacity) > 0.01 };
    }, tab);
    const errs = drain();
    check(`popup #${tab} renders`, r.exists && r.visible && r.len > 50 && errs.length === 0,
      `display=${r.display} opacity=${r.opacity} len=${r.len} errors=${errs.join(" | ")}`);
  }
  // Per-tab, because an overflow usually comes from one tab's widest table.
  for (const tab of TABS) {
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(700);
    const h = await page.evaluate(() => {
      const d = document.documentElement;
      return { scrollW: d.scrollWidth, clientW: d.clientWidth };
    });
    check(`popup ${tab} does not force the page to scroll horizontally`,
      h.scrollW <= h.clientW + 2, JSON.stringify(h));
  }

} finally {
  await context.close();
}

if (problems.length) {
  console.log("\n──── FINDINGS ────");
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}
console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
