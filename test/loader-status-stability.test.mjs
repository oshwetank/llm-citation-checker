/*
 * loader-status-stability.test.mjs — the live run view holds still while it
 * refreshes.
 *
 * Reported, with a screenshot: "the llms sections in which prompts are there,
 * if i scroll down they automatically scroll up after 2 sec", and "the box
 * which shows the time is going up and down with each cooldown".
 *
 * Both have one cause. The run status block is torn down and rebuilt on every
 * 1.5s poll. Each engine's prompt list is its own 180px scroll box, so every
 * rebuild handed back a fresh list scrolled to the top — the poll's
 * withScrollPreserved only holds the PAGE's scroll position, which is why a
 * test that sampled the page scroller during live runs never saw it move. And
 * the cooldown banner carries a slide-in entrance animation, so being rebuilt
 * every 1.5s meant it slid down and up every 1.5s.
 *
 * The status is supplied by the test (as in run-interrupted.test.mjs), so the
 * lists have enough prompts to scroll and the cooldown is genuinely active.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-loader-stability-test";

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
  console.log("\nloader-status-stability: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// Forty prompts per engine — comfortably more than a 180px list shows.
const prompts = Array.from({ length: 40 }, (_, i) => ({
  text: `Phones with fast charging under 30000, variant ${i + 1}`,
  status: i < 3 ? "done" : i === 3 ? "running" : "pending",
}));
const status = {
  ok: true,
  running: true,
  paused: false,
  total: 160,
  done: 9,
  errors: 0,
  runId: "loader-stability-test",
  etaMs: null,
  interrupted: {
    at: Date.now() - 60000,
    reason: "rate limit",
    platform: "perplexity",
    detail: "limit reached",
    autoResumeAt: Date.now() + 28 * 60000,
  },
  platStats: Object.fromEntries(["chatgpt", "gemini", "perplexity", "grok"].map((p) => [p,
    { done: 3, total: 40, failed: 0, current: null, paused: p === "perplexity", legs: [], prompts }])),
};

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
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);

  // The Campaigns view only shows the run block with a campaign present.
  await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
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
      id, name: "Stability Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "gemini", "perplexity", "grok"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text: "p", tags: [], active: true, createdAt: Date.now() });
  });
  await page.reload();
  await page.waitForTimeout(1500);

  await page.evaluate((s) => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, cb) => {
      if (msg && msg.type === "loader-status") { if (cb) cb(s); return; }
      if (msg && msg.type === "loader-resume") { window.__resumed = (window.__resumed || 0) + 1; if (cb) cb(s); return; }
      return real(msg, cb);
    };
  }, status);
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForTimeout(2600);

  const listState = () => page.evaluate(() => {
    const r = document.querySelector('.loader-prompt-rows[data-plat="chatgpt"]') || document.querySelectorAll(".loader-prompt-rows")[0];
    return r ? { top: r.scrollTop, sh: r.scrollHeight, ch: r.clientHeight } : null;
  });

  console.log("\nA scrolled prompt list stays where the user put it across refreshes");
  const before = await listState();
  check("an engine's prompt list is rendered", !!before, JSON.stringify(before));
  check("and it genuinely overflows, so scrolling means something",
    !!before && before.sh > before.ch + 100, JSON.stringify(before));
  await page.evaluate(() => {
    const r = document.querySelector('.loader-prompt-rows[data-plat="chatgpt"]') || document.querySelectorAll(".loader-prompt-rows")[0];
    r.scrollTop = 250;
  });
  const scrolled = await listState();
  // Two full poll cycles.
  await page.waitForTimeout(3500);
  const after = await listState();
  check("after two refreshes the list is still scrolled, not back at the top",
    !!after && after.top > 150, `was ${scrolled && scrolled.top}, now ${after && after.top}`);
  check("and within a row or so of where it was left",
    !!after && !!scrolled && Math.abs(after.top - scrolled.top) < 40, `was ${scrolled && scrolled.top}, now ${after && after.top}`);

  console.log("\nThe cooldown box doesn't replay its slide-in on every refresh");
  const anim = await page.evaluate(() => {
    const b = document.querySelector(".cooldown-banner");
    return b ? getComputedStyle(b).animationName : null;
  });
  check("the cooldown banner is showing", anim !== null);
  check("a refreshed banner doesn't animate again", anim === "none", `animation-name: ${anim}`);

  // 0.66.0: "Resume Now" threw "refresh is not defined" (the owner's
  // diagnostics) and never resumed.
  console.log("\nResume Now on the cooldown banner resumes");
  const resumed = await page.evaluate(async () => {
    document.querySelector(".cooldown-banner button")?.click();
    await new Promise((r) => setTimeout(r, 400));
    return window.__resumed || 0;
  });
  check("it asks the runner to resume", resumed === 1, String(resumed));

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
