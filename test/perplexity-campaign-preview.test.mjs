/*
 * perplexity-campaign-preview.test.mjs — a campaign keeps a Perplexity
 * thread-list preview only when it is THIS tab's prompt, from THIS run.
 *
 * Found in a real 40-prompt run's diagnostics export. Every network capture
 * Perplexity produced was its account-wide recent-threads list (the sidebar
 * push over its GraphQL socket), not an answer. The adapter reads the newest
 * thread's title as the question and that thread's preview as the answer,
 * which in a campaign goes wrong three ways:
 *
 *   - CROSS-TAB. The list is account-wide. With two Perplexity tabs running,
 *     one tab's capture was usually the other tab's newest thread — the real
 *     export showed prompt 6's thread captured on the tab running prompts 1-5.
 *   - STALE. Campaigns re-ask identical prompts every run, and the real list
 *     held last week's threads with the same titles as this run's.
 *   - EMPTY. A thread whose answer isn't written yet has no preview, and the
 *     result was stored as a record with a question and no answer at all.
 *
 * Only a preview for one of this tab's own prompts, from a thread updated
 * during this run, may be stored. The rejects must be logged, so the
 * diagnostics export says what was dropped rather than it vanishing.
 *
 * The payload is SYNTHETIC but shaped exactly like the real push — the real
 * one carries the user's own thread history, which does not belong in a repo.
 * It travels over a POST to /rest/sse/perplexity_ask rather than the socket
 * because a stub page can make that call and the adapter parses the list the
 * same way whichever transport delivers it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-pplx-preview-test";

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
  console.log("\nperplexity-campaign-preview: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a data-integrity regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// Two tabs (CONCURRENT_TABS_PER_ENGINE = 2): the tab under test runs [A, B],
// the other runs [C, D].
const A = "1. Which phone under thirty thousand rupees takes the best portrait photos";
const B = "2. Which phone under thirty thousand rupees has the fastest charging";
const C = "3. Which phone under thirty thousand rupees lasts longest on one charge";
const D = "4. Which phone under thirty thousand rupees is best for mobile gaming";

const GOOD = "I would pick the Orbit X2 for portraits: its telephoto lens and skin tones are the best at this price.";
const STALE = "Last week's answer: the Nimbus 7 was the portrait pick at this price, ahead of the Orbit X1.";
const OTHER = "For battery life the Volt 9 lasts two full days, well ahead of anything else at this price.";

// Shaped like the real push: a "next" frame whose data is sidebarRecentThreads
// with a RECENT list of threads, newest first.
const sidebar = (threads) => JSON.stringify({
  type: "next", id: "1",
  payload: { data: { sidebarRecentThreads: { id: "s1", type: "RECENT", threads: threads.map((t, i) => ({
    id: `t${i}`, contextUUID: `c${i}`, frontendContextUUID: `f${i}`, entryId: `e${i}`,
    mode: "copilot", variant: "default", status: "COMPLETED", space: null, isUnread: false,
    name: t.name, answerPreview: t.preview, updatedAt: t.at,
  })) } } },
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
  await context.route(/^https:\/\/(www\.)?perplexity\.ai\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/rest/sse/perplexity_ask")) {
      const now = new Date().toISOString();
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const body = {
        // Newest thread is the OTHER tab's prompt, freshly answered.
        cross: sidebar([{ name: C, preview: OTHER, at: now }, { name: A, preview: null, at: now }]),
        // Newest thread is this tab's prompt — but last week's, not this run's.
        stale: sidebar([{ name: A, preview: STALE, at: weekAgo }]),
        // This tab's prompt, this run — but its answer isn't written yet.
        empty: sidebar([{ name: A, preview: null, at: now }]),
        // This tab's prompt, answered during this run: the one worth keeping.
        good: sidebar([{ name: A, preview: GOOD, at: now }]),
      }[url.searchParams.get("case")] || "{}";
      return route.fulfill({ status: 200, contentType: "text/event-stream", body });
    }
    // Only A's page sends anything, so every capture below is attributable to
    // the tab running [A, B]. The good case goes last, so the tab is still on
    // A for all four.
    const q = url.searchParams.get("q") || "";
    const script = q === A
      ? `<script>
           (async function () {
             for (const c of ["cross", "stale", "empty", "good"]) {
               await new Promise(function (r) { setTimeout(r, 600); });
               await fetch("/rest/sse/perplexity_ask?case=" + c, { method: "POST", body: "{}" }).then(function (r) { return r.text(); });
             }
           })();
         </script>`
      : "";
    return route.fulfill({ status: 200, contentType: "text/html", body: `<body>stub${script}</body>` });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  console.log("\nSeeding a locked Perplexity campaign with four prompts");
  const seeded = await page.evaluate(async (texts) => {
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
    const profileId = crypto.randomUUID();
    await put("profiles", {
      id: profileId, name: "Perplexity Preview Test", brand: { name: "Orbit", url: "orbit.example" },
      competitors: [], engines: ["perplexity"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    const ids = {};
    let seq = 0;
    const at = Date.now();
    for (const text of texts) {
      const id = crypto.randomUUID();
      ids[text] = id;
      await put("trackedPrompts", { id, profileId, text, tags: [], active: true, createdAt: at + seq++ });
    }
    return { profileId, ids };
  }, [A, B, C, D]);
  check("campaign seeded", !!seeded.profileId);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId: seeded.profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));
  await page.waitForTimeout(9000);
  await ask({ type: "loader-stop" });

  const stored = await page.evaluate(async (profileId) => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res, rej) => {
      const r = dbh.transaction("derived").objectStore("derived").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    // This campaign's records only — the first-run demo data includes
    // Perplexity captures of its own, which say nothing about this run.
    return all.filter((r) => r.platform === "perplexity" && r.geo && r.geo.profileId === profileId)
      .map((r) => ({ q: r.userPrompt, a: r.answerText || "", promptId: r.geo && r.geo.promptId }));
  }, seeded.profileId);

  console.log("\nOnly this tab's own prompt, answered during this run, is stored");
  check("the other tab's thread is not stored as this tab's capture",
    !stored.some((r) => r.q === C || r.a === OTHER), JSON.stringify(stored.map((r) => r.q.slice(0, 3))));
  check("last week's thread with the same title is not stored",
    !stored.some((r) => r.a === STALE), JSON.stringify(stored.map((r) => r.a.slice(0, 20))));
  check("no record is stored with a question but no answer",
    !stored.some((r) => !r.a), JSON.stringify(stored.map((r) => r.a.length)));
  const good = stored.filter((r) => r.a === GOOD);
  check("this run's own answer IS stored — the fix doesn't just discard everything",
    good.length === 1, `${good.length} stored`);
  check("and it is filed under the prompt it answers", good.length === 1 && good[0].promptId === seeded.ids[A],
    good[0] && good[0].promptId);

  const log = await ask({ type: "error-log", limit: 200 });
  const reasons = ((log && log.entries) || [])
    .filter((e) => String(e.where || "").startsWith("capture:discarded:perplexity"))
    .map((e) => e.message);
  check("every discard is logged with its reason, for the diagnostics export",
    reasons.some((m) => /another tab/.test(m)) && reasons.some((m) => /before this run/.test(m)) && reasons.some((m) => /no answer/.test(m)),
    JSON.stringify(reasons));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
