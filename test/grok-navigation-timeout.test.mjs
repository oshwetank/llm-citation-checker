/*
 * grok-navigation-timeout.test.mjs — a Grok turn that is going fine must not
 * be sent twice.
 *
 * v0.45.2 tried to fix Grok's timeouts by treating any Grok navigation away
 * from the ?lcfc=1 address as a lost prompt, on the belief that Grok never
 * changes its address after a send. It does: like ChatGPT it moves to
 * /c/<conversation id> as soon as it accepts the prompt, and our own content
 * script strips ?lcfc= from the address at document_start. Each of those was
 * then "lost", the tab was reloaded and the prompt re-sent, until the turn
 * died as "tab reloaded repeatedly" — the failure that cost the 0.38/0.39
 * runs 77 of 80 prompts. (Grok does bounce a fresh ?q= page through
 * /tos-gate and loses the prompt — the v0.45.3 run showed it on every turn —
 * but that is recovered by handing the turn to the page it lands on, see
 * redirect-claim.test.mjs, not by reloading on every address change.)
 *
 * The stub is a healthy Grok: it loads, takes the turn, and moves to its new
 * conversation after the reload detector's grace period, the way a slow real
 * send does. It must be loaded exactly once, with no reload retry logged.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-grok-nav-test";

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
    try { pw = req(c); break; } catch (_) {}
  }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log("\ngrok-navigation-timeout: CANNOT RUN — playwright is not installed.");
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

try {
  let promptLoads = 0;
  await context.route(/^https:\/\/grok\.com\//, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("q")) promptLoads++;
    // 5s is past RELOAD_DETECT_GRACE_MS (3s), so the move is judged by the
    // detector rather than waved through as the loader's own navigation.
    return route.fulfill({
      status: 200, contentType: "text/html",
      body: `<body>stub grok<script>
               setTimeout(() => history.pushState(null, "", "/c/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"), 5000);
             </script></body>`,
    });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  console.log("\nA Grok turn that moves to its new conversation");
  const profileId = await page.evaluate(async () => {
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
      id: profileId, name: "Grok Conversation Test",
      brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["grok"],
      locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    await put("trackedPrompts", {
      id: crypto.randomUUID(), profileId, text: "Grok test prompt", tags: [], active: true, createdAt: Date.now(),
    });
    return profileId;
  });

  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("geo-run-start accepted it", started && started.ok, JSON.stringify(started));

  // The move lands at ~5s; a retry would be decided RELOAD_VERIFY_WAIT_MS
  // (8s) after it and re-load the page straight away.
  await page.waitForTimeout(16000);

  const log = await ask({ type: "error-log", limit: 400 });
  const entries = (log && log.entries) || [];
  const reloadRetries = entries.filter((e) => String(e.where || "").startsWith("run:tab-reloaded:grok"));

  check("the prompt page was loaded once — not re-sent", promptLoads === 1, `loads = ${promptLoads}`);
  check("no reload retry was logged", reloadRetries.length === 0, reloadRetries.map((e) => e.where).join(", "));

  await ask({ type: "loader-stop" });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
