/*
 * run-interrupted.test.mjs — a run paused by something other than the user
 * says WHY, and says that nothing was lost.
 *
 * Two new self-pausing paths exist:
 *   1. The engine reported a usage limit (content-iso.js sends
 *      loader-rate-limited; background pauses instead of failing the turn).
 *   2. The browser or the automated tab was closed mid-run, so on rehydrate
 *      the run is parked rather than having its whole remainder marked FAILED
 *      — which is what used to happen, and what made runs longer than one
 *      browsing session impossible.
 *
 * Both surface as plain "Paused", which is indistinguishable from the user
 * having clicked Pause, and from the run having broken. Since the entire
 * value of these paths is "your prompts are still there, press Resume", the
 * explanation IS the feature — an unexplained pause on a 1000-prompt run
 * reads as data loss even when nothing was lost.
 *
 * loaderStatus() comes from the service worker, so rather than driving a real
 * multi-hour run this intercepts chrome.runtime.sendMessage in the panel page
 * and answers loader-status with a synthetic state, passing every other
 * message through untouched. That exercises the real render path in the real
 * page with the real CSS, which is where the failure would be.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-interrupted-test";

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
  console.log("\nrun-interrupted: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported correctness bug, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// A mid-run state: 400 of 1000 prompts done on each engine, nothing failed.
const statusFor = (interrupted) => ({
  ok: true,
  running: true,
  paused: true,
  total: 2000,
  done: 800,
  errors: 0,
  runId: "run-interrupted-test",
  etaMs: null,
  interrupted,
  platStats: {
    chatgpt: { done: 400, total: 1000, failed: 0, current: null, prompts: [] },
    gemini: { done: 400, total: 1000, failed: 0, current: null, prompts: [] },
  },
});

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
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

  const pageErrors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource|net::ERR_|fonts\.(googleapis|gstatic)/i.test(t)) return;
    pageErrors.push("console: " + t);
  });

  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);

  // The live run card — and therefore #loaderStatus, which the banner renders
  // into — only exists once a campaign is LOCKED and has prompts; an unlocked
  // one shows the setup form instead. Seed that state directly, the same way
  // campaign-drilldown.test.mjs does, rather than driving the whole form.
  const seeded = await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc", 4);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, v) => new Promise((res, rej) => {
      const r = dbh.transaction(store, "readwrite").objectStore(store).put(v);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    const id = crypto.randomUUID();
    await put("profiles", {
      id, name: "Interrupted Test",
      brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "gemini"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    for (const text of ["best phone under 20000", "best phone under 30000"]) {
      await put("trackedPrompts", {
        id: crypto.randomUUID(), profileId: id, text,
        tags: [], active: true, createdAt: Date.now(),
      });
    }
    return id;
  });
  check("a campaign was seeded so the live run card exists", !!seeded, String(seeded));
  await page.reload();
  await page.waitForTimeout(1500);

  // Answer loader-status ourselves; everything else goes to the real worker.
  await page.evaluate(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__setStatus = (s) => { window.__status = s; };
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === "loader-status" && window.__status) {
        if (cb) cb(window.__status);
        return;
      }
      return real(msg, cb);
    };
  });

  // Reads the banner as the user would see it: text, and whether it is
  // actually painted (a styled box that got opacity:0 or zero height would
  // pass a textContent check while showing nothing).
  const readBanner = async () =>
    page.evaluate(() => {
      const n = document.querySelector(".loader-interrupted");
      if (!n) return { present: false };
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return {
        present: true,
        text: n.innerText.replace(/\s+/g, " ").trim(),
        visible: cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) > 0.01,
        h: Math.round(r.height),
        w: Math.round(r.width),
      };
    });

  const showCampaigns = async (status) => {
    await page.evaluate((s) => window.__setStatus(s), status);
    await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    // The panel re-paints status on tab entry and again on its 1.5s poll.
    await page.waitForTimeout(2600);
  };

  console.log("\nPaused by a usage limit: says which engine, quotes it, promises nothing lost");
  pageErrors.length = 0;
  await showCampaigns(statusFor({
    at: Date.now() - 60000,
    reason: "rate limit",
    platform: "chatgpt",
    detail: "You've reached your limit for GPT-5",
  }));
  {
    const b = await readBanner();
    check("the banner is rendered", b.present === true, JSON.stringify(b));
    check("it is actually visible, not a zero-height or transparent box",
      b.present && b.visible && b.h > 10 && b.w > 10, `${b.w}x${b.h} visible=${b.visible}`);
    check("it names the usage limit as the cause",
      /usage limit/i.test(b.text || ""), b.text);
    check("it names the engine that hit it, so the user knows which account to rest",
      /ChatGPT/i.test(b.text || ""), b.text);
    check("it quotes what the engine actually said",
      /reached your limit for GPT-5/i.test(b.text || ""), b.text);
    // The whole point: 1200 prompts are still queued, not lost.
    check("it states no prompts were lost and how many remain",
      /No prompts were lost/i.test(b.text || "") && /1200 still queued/.test(b.text || ""), b.text);
    check("it tells the user Resume is the next step",
      /Resume/.test(b.text || ""), b.text);
    check("no page error while rendering it", pageErrors.length === 0, pageErrors.join(" | "));
  }

  console.log("\nPaused by the browser closing mid-run: offers to reopen the tab");
  pageErrors.length = 0;
  await showCampaigns(statusFor({
    at: Date.now() - 3600000,
    reason: "browser or tab closed mid-run",
  }));
  {
    const b = await readBanner();
    check("the banner is rendered", b.present === true, JSON.stringify(b));
    check("it says it was interrupted rather than blaming a limit",
      /interrupted/i.test(b.text || "") && !/usage limit/i.test(b.text || ""), b.text);
    check("it explains the tab will be reopened, so Resume isn't a surprise",
      /tab will be reopened/i.test(b.text || ""), b.text);
    check("it still promises nothing was lost", /No prompts were lost/i.test(b.text || ""), b.text);
    check("no page error while rendering it", pageErrors.length === 0, pageErrors.join(" | "));
  }

  console.log("\nA run the USER paused shows no such banner (it needs no explanation)");
  pageErrors.length = 0;
  await showCampaigns(statusFor(null));
  {
    const b = await readBanner();
    check("no interrupted banner appears", b.present === false, JSON.stringify(b));
    const txt = await page.evaluate(() => document.querySelector("#loaderStatus")?.innerText || "");
    check("the panel still renders the paused run itself", /Paused/i.test(txt), txt.slice(0, 120));
    check("no page error", pageErrors.length === 0, pageErrors.join(" | "));
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
