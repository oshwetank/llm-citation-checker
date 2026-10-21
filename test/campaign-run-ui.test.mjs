/*
 * campaign-run-ui.test.mjs — running a campaign from the Campaigns screen,
 * through the real service worker, by clicking what the owner clicks.
 *
 * 0.55.0 moved the run controls from a "Run" card into the campaign's
 * header (renderCampaignHead). The other run tests (concurrency-live,
 * capture-attribution, long-answer, …) drive the background with messages,
 * so none of them would notice a button that no longer starts a run. This
 * one clicks: Start run → the confirm dialog → the sign-in check → Run anyway,
 * then Pause, Resume and Stop, and reads the run's real state from the
 * service worker after each. Engine pages are stubbed (as concurrency-live
 * does) so tabs open instantly; no answer is captured, which is the point of
 * the last part: a run that captured nothing still shows in the run history.
 *
 * Also asked for with it: "make sure the technical side of working of the
 * tool is not impacted, our overall prompt loader and everything else."
 *
 * On 0.55.0 the "a header rebuilt mid-run" and "run history after a run
 * that captured nothing" checks fail; the rest pin the move.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-campaign-run-ui-test";

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
  console.log("\ncampaign-run-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the prompt loader's controls, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  // Context-wide, so the tabs the extension opens resolve too.
  await context.route(/^https:\/\/(chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<body>stub</body>" }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on("dialog", (d) => d.accept());
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(800);

  const ask = (msg) => page.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);
  const status = () => ask({ type: "loader-status" });
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await page.waitForTimeout(200); } return v; };
  const head = () => page.evaluate(() => {
    const h = document.getElementById("cpHead");
    if (!h) return null;
    const shown = [...h.querySelectorAll(".cp-actions button:not(.ho-wrap button)")].filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent);
    return { live: h.classList.contains("live"), paused: h.classList.contains("paused"), shown, status: document.getElementById("loaderStatus")?.innerText || "" };
  });

  // A set-up campaign with two prompts on ChatGPT, never run.
  const profileId = await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const put = (s, v) => new Promise((res, rej) => { const r = dbh.transaction(s, "readwrite").objectStore(s).put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
    const id = crypto.randomUUID();
    await put("profiles", { id, name: "Run Test", brand: { name: "Acme", url: "acme.example" }, competitors: [], engines: ["chatgpt"], locked: true, createdAt: Date.now(), lastRunAt: null, deletedAt: null });
    const at = Date.now();
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text: "which kettle boils fastest", tags: [], active: true, createdAt: at });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text: "quietest electric kettle", tags: [], active: true, createdAt: at + 1 });
    return id;
  });
  await page.reload();
  await page.waitForTimeout(1000);
  await page.click('[data-tab="loader"]');
  await page.waitForTimeout(1200);

  console.log("\nBefore a run: Start run, nothing live");
  {
    const h = await head();
    check("the campaign opens on its header", !!h);
    check("it offers Start run, and no Pause, Resume or Stop", h && h.shown.join("|") === "Edit setup|Export…|Start run|Run signed out" && !h.live, h && h.shown.join("|"));
    check("the service worker has no run going", !(await status()).running);
  }

  console.log("\nStart run: the confirm, the sign-in check, then a real run");
  {
    await page.click("#cpHead .cp-run");
    // No engine session exists here, so the sign-in check stops it; "Run
    // anyway" is the documented way past (see showSignInGate).
    const gate = await waitFor(() => page.evaluate(() => !!document.getElementById("signin-gate-backdrop")), 6000);
    check("with no session, the sign-in check comes up first", gate);
    if (gate) await page.click('#signin-gate-backdrop button:has-text("Run anyway")');
    const s = await waitFor(async () => { const x = await status(); return x && x.running ? x : null; }, 10000);
    check("the service worker is running the campaign", !!s && s.running && !s.paused, JSON.stringify(s || {}).slice(0, 160));
    const ps = await waitFor(async () => { const x = await status(); return x && x.platStats && x.platStats.chatgpt ? x.platStats.chatgpt : null; }, 6000);
    check("with this campaign's two prompts on ChatGPT", !!ps && ps.total === 2, JSON.stringify(ps).slice(0, 200));
    const h = await waitFor(async () => { const x = await head(); return x && x.live ? x : null; }, 4000);
    check("the header goes live: Edit setup, Export…, Pause, Stop", !!h && h.shown.join("|") === "Edit setup|Export…|Pause|Stop", h && h.shown.join("|"));
    check("and shows the run's progress and its prompts", !!h && /Running/i.test(h.status) && /chatgpt/i.test(h.status) && /which kettle boils fastest/.test(h.status), h && h.status.slice(0, 160));
    // Two status polls later it is still there (the poll rebuilds it).
    await page.waitForTimeout(3300);
    const later = await head();
    check("still live after the status polls", later && later.live && /Running/i.test(later.status), later && later.status.slice(0, 80));
  }

  console.log("\nA header rebuilt mid-run keeps Pause and Stop");
  {
    // Every capture re-renders the tab; so does picking the campaign again.
    // Record the header's state at the moment each new one is inserted.
    await page.evaluate(() => {
      window.__heads = [];
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.id === "cpHead") window.__heads.push(n.classList.contains("live"));
      }))).observe(document.getElementById("loader"), { childList: true });
      [...document.querySelectorAll("#cpHead .geo-chip")].find((c) => /Run Test/.test(c.textContent))?.click();
    });
    await page.waitForTimeout(1500);
    const heads = await page.evaluate(() => window.__heads);
    check("a new header is live from the start, not after the next status reply", heads.length > 0 && heads.every(Boolean), JSON.stringify(heads));
  }

  console.log("\nA capture mid-run doesn't rebuild the page (0.62.2)");
  {
    // Reported: "with each new prompt run/capture the layout bounces, if you
    // have scrolled down, you will be bounced back up forcefully". Every
    // capture used to empty the Campaigns page and build it again.
    await page.evaluate(() => {
      window.__rebuilt = 0;
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.id === "cpHead") window.__rebuilt++; })))
        .observe(document.getElementById("loader"), { childList: true });
    });
    const raw = readFileSync(path.join(HERE, "fixtures", "chatgpt-phone-under.txt"), "utf8");
    for (let i = 0; i < 3; i++) {
      await ask({ type: "raw-conversation", payload: { raw, reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [`ad-hoc question ${i}`] } }] }), pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(800);
    check("three captures, no rebuild of the page", await page.evaluate(() => window.__rebuilt) === 0, String(await page.evaluate(() => window.__rebuilt)));
    const wait = await page.evaluate(() => document.querySelector("#campaignResults .cb-run-wait")?.textContent || "");
    check("the results say the running run's answers come at the end", /appear here when it finishes or is stopped/.test(wait), wait || "no note");
  }

  console.log("\nPause and Resume");
  {
    await page.click("#cpHead .cp-pause");
    const s = await waitFor(async () => { const x = await status(); return x && x.paused ? x : null; }, 6000);
    check("Pause pauses the run in the service worker", !!s && s.running && s.paused);
    const h = await waitFor(async () => { const x = await head(); return x && x.paused ? x : null; }, 4000);
    check("the header offers Resume and Stop", !!h && h.shown.join("|") === "Edit setup|Export…|Resume|Stop", h && h.shown.join("|"));
    check("and says it is paused", !!h && /Paused/i.test(h.status), h && h.status.slice(0, 120));
    await page.click("#cpHead .cp-resume");
    const r = await waitFor(async () => { const x = await status(); return x && x.running && !x.paused ? x : null; }, 6000);
    check("Resume picks it up again", !!r);
    const h2 = await waitFor(async () => { const x = await head(); return x && x.live && !x.paused ? x : null; }, 4000);
    check("and the header is back to Pause and Stop", !!h2 && h2.shown.includes("Pause") && !h2.shown.includes("Resume"), h2 && h2.shown.join("|"));
  }

  console.log("\nStop");
  {
    await page.click('#cpHead button:has-text("Stop")');
    const s = await waitFor(async () => { const x = await status(); return x && !x.running ? x : null; }, 8000);
    check("Stop ends the run in the service worker", !!s);
    const h = await waitFor(async () => { const x = await head(); return x && !x.live ? x : null; }, 4000);
    check("the header offers Run again, no live controls", !!h && h.shown.join("|") === "Edit setup|Export…|Run again|Run signed out", h && h.shown.join("|"));
    const runs = await ask({ type: "geo-run-list", profileId });
    check("the run is recorded as stopped", runs && runs.ok && runs.runs.length === 1 && runs.runs[0].status === "stopped", JSON.stringify(runs && runs.runs).slice(0, 200));
    await page.waitForTimeout(1500);
    const hist = await waitFor(() => page.evaluate(() => [...document.querySelectorAll("#loader .loader-history-row")].map((r) => r.innerText.replace(/\s+/g, " "))), 5000);
    check("a run that captured nothing still shows in the run history", hist && hist.length === 1 && /Stopped/.test(hist[0]) && /0\/\d+ captured/.test(hist[0]), JSON.stringify(hist));
  }

  // 0.78.1: what a finished run is missing is asked again, into that run.
  console.log("\nRetry missing");
  {
    const note = await waitFor(() => page.evaluate(() => { const n = document.getElementById("cpMissing"); return n && !n.hidden ? n.innerText.replace(/\s+/g, " ") : null; }), 6000);
    check("the header says how many answers the run is missing, and where", note && /2 answers are missing from the last run/.test(note) && /2 on ChatGPT/.test(note), note);
    await page.click("#cpRetryMissing");
    // The same sign-in check as Start run; this test browser is signed out.
    const gate2 = await waitFor(() => page.evaluate(() => !!document.getElementById("signin-gate-backdrop")), 10000);
    if (gate2) await page.click('#signin-gate-backdrop button:has-text("Run anyway")');
    // Running with prompts: while the sign-in check runs, the runner reads
    // "running" with nothing in it yet.
    const s = await waitFor(async () => { const x = await status(); return x && x.running && x.total ? x : null; }, 15000);
    check("Retry starts a run of just those prompts", s && s.total === 2, JSON.stringify(s && { total: s.total, running: s.running }));
    const runs = await ask({ type: "geo-run-list", profileId });
    check("into the same campaign run, not a new one", runs && runs.runs.length === 1 && runs.runs[0].status === "running", JSON.stringify(runs && runs.runs.map((r) => [r.id.slice(0, 6), r.status])));
    await page.click('#cpHead button:has-text("Stop")');
    await waitFor(async () => { const x = await status(); return x && !x.running ? x : null; }, 8000);
    const back = await ask({ type: "geo-run-list", profileId });
    check("stopping it leaves that one run, its counts not doubled", back && back.runs.length === 1 && (back.runs[0].captured || 0) === 0, JSON.stringify(back && back.runs[0]).slice(0, 200));
  }

  console.log("\nThe popup has the same controls");
  {
    const pop = await context.newPage();
    pop.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    pop.on("dialog", (d) => d.accept());
    await pop.setViewportSize({ width: 540, height: 600 });
    await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
    await pop.waitForTimeout(800);
    await pop.click('[data-tab="loader"]');
    await pop.waitForTimeout(1500);
    const r = await pop.evaluate(() => {
      const h = document.getElementById("cpHead");
      const c = document.querySelector(".app-content");
      return { run: !!h?.querySelector(".cp-run"), shown: h ? [...h.querySelectorAll(".cp-actions button:not(.ho-wrap button)")].filter((b) => getComputedStyle(b).display !== "none").map((b) => b.textContent) : [], wide: c.scrollWidth - c.clientWidth };
    });
    check("the header and its actions are there", r.run && r.shown.join("|") === "Edit setup|Export…|Run again|Run signed out", r.shown.join("|"));
    check("and fit the popup", r.wide <= 0, `${r.wide}px too wide`);
    await pop.close();
  }

  check("no page error anywhere above", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
