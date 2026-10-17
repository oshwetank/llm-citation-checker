/*
 * build-mismatch.test.mjs — a half-updated install is called out, not silent.
 *
 * A real browser ran new interface files on top of an OLD background script
 * (see src/lib/build.js): every screen said 0.41.0 while its runs failed with
 * a bug fixed two versions earlier, and the only way to tell was forensic —
 * fingerprints in the captures, and retry timings the new code can't produce.
 * The panel now asks the background which build it's running and warns when
 * the answer disagrees with its own, or when the background is too old to
 * understand the question.
 *
 * The old background is simulated by answering "build-info" the way each kind
 * of stale background actually would, before panel.js runs (an init script).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-build-mismatch-test";

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
  console.log("\nbuild-mismatch: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a real failure mode, so it fails rather than skips. Reason: ${err.message}`);
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
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const url = `chrome-extension://${extId}/ui/panel.html?mode=tab`;

  const banner = (page) => page.evaluate(() => {
    const n = document.querySelector(".build-mismatch");
    return n ? n.innerText.replace(/\s+/g, " ").trim() : null;
  });

  // Opens the panel with its "build-info" question answered by `reply`
  // (null = let the real background answer).
  const openWith = async (reply) => {
    const page = await context.newPage();
    if (reply) {
      await page.addInitScript((r) => {
        const install = () => {
          if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) return false;
          const real = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (msg, cb) => {
            if (msg && msg.type === "build-info") { if (cb) cb(r); return; }
            return real(msg, cb);
          };
          return true;
        };
        install();
      }, reply);
    }
    await page.goto(url);
    await page.waitForTimeout(1500);
    return page;
  };

  console.log("\nA healthy install shows no warning");
  {
    const page = await openWith(null);
    check("background and screens agree, so nothing is shown", (await banner(page)) === null, await banner(page));
    await page.close();
  }

  console.log("\nA background too old to know the question");
  {
    const page = await openWith({ ok: false, error: "unknown message type" });
    const b = await banner(page);
    check("the warning is shown", !!b, String(b));
    check("it says the part that runs campaigns is out of date", /runs campaigns is still an older version/i.test(b || ""), b);
    check("and tells the user how to fix it", /chrome:\/\/extensions/.test(b || "") && /reload/i.test(b || ""), b);
    // Reproduced with a reused test profile: relaunching Chrome kept the old
    // background; only the reload button replaced it. The advice must not
    // send the user round a restart that doesn't work.
    check("and warns that restarting Chrome is not enough", /restarting chrome is not enough/i.test(b || ""), b);
    await page.close();
  }

  console.log("\nA background reporting a different build");
  {
    const page = await openWith({ ok: true, build: "0.39.0" });
    const b = await banner(page);
    check("the warning names the build actually running", /version 0\.39\.0/.test(b || ""), b);
    await page.close();
  }

  console.log("\nA broken connection is not mistaken for a stale install");
  {
    const page = await openWith({ ok: false, error: "Extension context invalidated." });
    check("no out-of-date warning for a connection error", (await banner(page)) === null, await banner(page));
    await page.close();
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
