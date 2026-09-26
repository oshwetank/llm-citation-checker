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
  let grokRequests = 0;
  await context.route(/^https:\/\/grok\.com\//, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      if (url.searchParams.has("q")) {
        grokRequests++;
        if (grokRequests === 1) {
          // First time: navigate to /tos-gate after 1s
          return route.fulfill({
            status: 200, contentType: "text/html",
            body: `<body>stub grok<script>
                     setTimeout(() => location.href = "https://grok.com/tos-gate", 1000);
                   </script></body>`
          });
        }
        // Second time: stay on the page (simulating successful login/TOS accept)
        return route.fulfill({ status: 200, contentType: "text/html", body: `<body>stub grok success</body>` });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: `<body>stub grok bare</body>` });
    }
    if (url.pathname === "/tos-gate") {
      return route.fulfill({
        status: 200, contentType: "text/html",
        body: `<body>tos-gate<script>
                 setTimeout(() => location.href = "https://grok.com/", 200);
               </script></body>`
      });
    }
    return route.continue();
  });

  // Mock chatgpt to complete immediately so run moves forward
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    return route.fulfill({ status: 200, contentType: "text/html", body: `<body>chatgpt stub</body>` });
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

  console.log("\nSeeding a Grok campaign");
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
      id: profileId, name: "Grok Bounce Test",
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

  // Wait long enough for the bounce to happen and the retry to be triggered.
  // RELOAD_VERIFY_WAIT_MS is 8000ms.
  await page.waitForTimeout(12000);

  const log = await ask({ type: "error-log", limit: 400 });
  const entries = (log && log.entries) || [];
  const reloadRetries = entries.filter((e) => String(e.where || "").startsWith("run:tab-reloaded:grok"));

  check("Grok bounce triggered a retry", grokRequests === 2, `grokRequests = ${grokRequests}`);
  check("Error log recorded the reload retry", reloadRetries.length > 0);

  await ask({ type: "loader-stop" });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
