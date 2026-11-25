/*
 * tour-once.test.mjs — the welcome guide opens once, and its email step
 * (0.80.0, 0.81.0).
 *
 * Reported: "the beginner guide screen keeps on popping up many times, even
 * if the user is not using it for the first time". The 0.80.0 fix marked the
 * old in-panel tour seen when it opened; 0.81.0 replaced that tour with a
 * full page (ui/welcome.html) the worker opens once on install. Asked with it:
 * an email for update news, checked properly, burner inboxes refused "in a
 * Gen Z style way", a plain statement of what it's for, and a skip that is
 * respected and never pushed again.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-tour-once-test";

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
  console.log(`\ntour-once: CANNOT RUN — playwright is not installed. ${err.message}`);
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
  const welcomePages = () => context.pages().filter((p) => p.url().endsWith("/ui/welcome.html"));

  console.log("\nthe panel never draws a guide over itself");
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html`);
  await panel.waitForTimeout(3000);
  check("no modal tour on the first open", !(await panel.evaluate(() => !!document.getElementById("tour-backdrop"))));
  const ask = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);

  console.log("\nthe welcome page, once");
  const before = welcomePages().length;
  const first = await ask({ type: "welcome-open-once", evenAutomated: true });
  await panel.waitForTimeout(800);
  check("opens as a page of its own", first.opened && welcomePages().length === before + 1, JSON.stringify(first));
  const again = await ask({ type: "welcome-open-once", evenAutomated: true });
  await panel.waitForTimeout(500);
  check("and never again", !again.opened && welcomePages().length === before + 1, JSON.stringify(again));

  const w = welcomePages()[0];
  await w.setViewportSize({ width: 1280, height: 800 });
  await w.waitForTimeout(400);
  const steps = [];
  for (let i = 0; i < 5; i++) {
    steps.push(await w.evaluate(() => ({ title: document.querySelector(".wl-h")?.textContent, art: !!document.querySelector(".wl-art"), words: (document.querySelector(".wl-sub")?.textContent || "").split(/\s+/).length })));
    await w.click("#wlNext");
    await w.waitForTimeout(250);
  }
  check("five picture steps: what it is, Analyze, Dashboard, Campaigns, Ask and share", steps.length === 5 && steps.every((s) => s.art) && /Analyze/.test(steps[1].title) && /Dashboard/.test(steps[2].title) && /Campaigns/.test(steps[3].title), steps.map((s) => s.title).join(" | "));
  check("light on words: under 40 per step", steps.every((s) => s.words < 40), steps.map((s) => s.words).join(","));

  console.log("\nthe email step");
  check("then the email, with what it's used for", await w.evaluate(() => !!document.getElementById("wlEmail") && /never sold, shared/i.test(document.getElementById("wlPrivacy")?.textContent || "")));
  const tryEmail = async (e) => { await w.fill("#wlEmail", e); await w.click("#wlSend"); await w.waitForTimeout(250); return w.evaluate(() => ({ text: document.getElementById("wlMsg")?.textContent || "", cls: document.getElementById("wlMsg")?.className || "" })); };
  const junk = await tryEmail("lol random text");
  check("random text is refused", /doesn't look like an email/.test(junk.text) && /bad/.test(junk.cls), JSON.stringify(junk));
  const burner = await tryEmail("me@yopmail.com");
  check("a burner inbox is called out, Gen Z style", /burner|vibe/i.test(burner.text) && /💀/.test(burner.text), burner.text);
  const typo = await tryEmail("asha@gmial.com");
  check("a slip in gmail's name gets a 'did you mean'", /Did you mean/.test(typo.text) && /gmail\.com/.test(typo.text), typo.text);
  check("nothing kept yet", !(await panel.evaluate(async () => (await chrome.storage.local.get("citoSignup")).citoSignup)));

  // Skip, said once plainly, then taken at its word.
  await w.click("#wlSkip");
  await w.waitForTimeout(200);
  const skipNote = await w.evaluate(() => document.getElementById("wlMsg")?.textContent || "");
  check("skipping says once what you'd miss", /won't hear about new features/.test(skipNote), skipNote);
  await w.fill("#wlEmail", "asha.k@zento.example");
  await w.click("#wlSend");
  await w.waitForTimeout(500);
  const kept = await panel.evaluate(async () => (await chrome.storage.local.get(["citoSignup", "citoWelcomeDone"])));
  check("a real email is kept, with consent", kept.citoSignup && kept.citoSignup.email === "asha.k@zento.example" && kept.citoSignup.consent === true, JSON.stringify(kept.citoSignup));
  check("and the guide is done", !!kept.citoWelcomeDone && await w.evaluate(() => /You're in/.test(document.querySelector(".wl-h")?.textContent || "")));

  console.log("\nSettings");
  const tab = await context.newPage();
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.waitForTimeout(1200);
  await tab.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
  await tab.waitForTimeout(400);
  await tab.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Settings"))?.click());
  await tab.waitForTimeout(500);
  // The email is under More settings → Kept on this computer (1.0.6).
  await tab.evaluate(() => { const d = document.getElementById("setGroupMore"); if (d) d.open = true; });
  check("About → Settings shows the email", await tab.evaluate(() => document.getElementById("setEmail")?.value === "asha.k@zento.example" && !document.getElementById("setEmailRemove").hidden));
  await tab.fill("#setEmail", "x@mailinator.com");
  await tab.click("#setEmailSave");
  await tab.waitForTimeout(200);
  check("the same checks there", /burner|vibe/i.test(await tab.evaluate(() => document.getElementById("setEmailMsg").textContent)));
  await tab.click("#setEmailRemove");
  await tab.waitForTimeout(400);
  const removed = await panel.evaluate(async () => (await chrome.storage.local.get("citoSignup")).citoSignup);
  check("Remove forgets it", removed && !removed.email && removed.skipped, JSON.stringify(removed));
  check("the guide can be opened again from About", await tab.evaluate(() => /guide/i.test(document.getElementById("replayTour")?.textContent || "")));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
