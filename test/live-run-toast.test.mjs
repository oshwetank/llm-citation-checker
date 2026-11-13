/*
 * live-run-toast.test.mjs — a campaign run must not pop a toast for every
 * prompt it captures.
 *
 * Reported: "when the prompts are running the tool give a glitch kind of a
 * effect". Every captured prompt broadcasts `new-capture`, and the panel
 * answered each one with a toast — an element that slides in over the
 * content, sits for 3.5s and leaves, then does it again on the next prompt,
 * for the entire length of the run. In the popup, where it overlays the very
 * list the user is reading, that is the "glitch".
 *
 * A toast is the right response to an AD-HOC browsing capture: nothing else
 * on screen announces it. During a run it is pure noise — the progress card
 * already counts every prompt as it lands. So the broadcast now says which
 * kind it is, and only the ad-hoc one is announced.
 *
 * Scope note, stated because it would otherwise be easy to assume: this file
 * does NOT verify the other half of that report ("the screen automatically
 * jumpp up"). That was not reproducible here — scrollTop was sampled through
 * live runs in both popup and full-tab layouts, and across real load()
 * rebuilds driven by this same broadcast, and it never moved. Whatever
 * causes it is not yet understood, so nothing here should be read as
 * covering it.
 *
 * 1.0.0, reported: "the tool is continuously sending a popup which says New
 * Citation captured, even though I am not running any prompt". A Perplexity
 * tab left open keeps making requests that are saved raw but hold no
 * answer, and each one was announced; so was an answer the page sent again.
 * Through the real worker now: neither raises the notice, a new answer does,
 * once.
 *
 * As with any panel-messaging test: a page's own chrome.runtime.sendMessage
 * is NOT delivered to that page's own onMessage listener, so the broadcasts
 * below are fired from a second extension page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-live-toast-test";

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
  console.log("\nlive-run-toast: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported regression, so it fails rather than skips. Reason: ${err.message}`);
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

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1200);

  const other = await context.newPage();
  await other.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await other.waitForTimeout(800);

  const toastCount = () => page.evaluate(() => document.querySelectorAll(".app-toast").length);
  const fire = (body) => other.evaluate((b) => chrome.runtime.sendMessage(b), body);

  console.log("\nCaptures from a campaign run are not announced one by one");
  for (let i = 0; i < 3; i++) {
    await fire({ type: "new-capture", captureId: `run-${i}`, duringRun: true });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(900);
  const duringRunToasts = await toastCount();
  check("no toast for a capture that is part of a run", duringRunToasts === 0, `saw ${duringRunToasts}`);

  console.log("\nAn ad-hoc browsing capture is still announced — nothing else reports it");
  await fire({ type: "new-capture", captureId: "adhoc-1" });
  await page.waitForTimeout(900);
  const adhocToasts = await toastCount();
  check("a browsing capture still raises a toast", adhocToasts === 1, `saw ${adhocToasts}`);

  console.log("\nThrough the worker: only a new answer is announced");
  await page.waitForTimeout(16000); // past the one-notice-per-15-s spacing
  const before = await toastCount();
  const toastsAfter = async (ms) => { await page.waitForTimeout(ms); return (await toastCount()) - before; };
  const send = (payload) => other.evaluate((p) => new Promise((r) => chrome.runtime.sendMessage({ type: "raw-conversation", payload: p }, r)), payload);
  // Perplexity's background requests: saved raw, no answer in them.
  for (const path of ["/rest/perplexity_ask/graphql", "/rest/perplexity_ask/graphql/ws", "/rest/sse/related-queries/abc"]) {
    await send({ url: `https://www.perplexity.ai${path}`, raw: '{"data":{"ping":true}}', transport: "fetch", pageUrl: "https://www.perplexity.ai/", capturedAt: Date.now() });
  }
  check("Perplexity's empty requests raise no notice", (await toastsAfter(1200)) === 0);
  const fx = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "chatgpt-genui-cards.txt"), "utf8").split(/\r?\n/);
  const answer = { url: "https://chatgpt.com/backend-api/f/conversation", reqBody: (fx.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", ""), raw: fx.filter((l) => !l.startsWith("# ")).join("\n"), transport: "fetch", pageUrl: "https://chatgpt.com/", capturedAt: Date.now() };
  const first = await send(answer);
  check("a new answer is announced", first && first.captureId && (await toastsAfter(1500)) === 1, JSON.stringify(first));
  await page.waitForTimeout(16000);
  const before2 = await toastCount();
  await send({ ...answer, capturedAt: Date.now() });
  await page.waitForTimeout(1500);
  check("the same answer sent again is not announced again", (await toastCount()) - before2 === 0);

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
