/*
 * prompt-manual-add.test.mjs — a long prompt's own commas must not be read
 * as tag separators.
 *
 * Reported: "i am not able to add long prompts, when i add that, lot of
 * it's texts become tags automatically." The manual "type prompts" textarea
 * split every line on EVERY comma and treated everything after the first as
 * tags — fine for a short "prompt, tag, tag" line, but a real prompt uses
 * commas as ordinary punctuation just as often ("best phones under 20k,
 * with a great camera and long battery life"), so most of a long prompt's
 * own text was silently chopped into tags instead of staying part of the
 * prompt.
 *
 * This runs in a real browser because the bug is in the DOM-facing click
 * handler itself (ui/panel.js), not in any pure/importable function.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-prompt-manual-add-test";

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
  console.log("\nprompt-manual-add: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported regression, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

rmSync(PROFILE_BASE, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
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
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  await page.click('[data-tab="loader"]').catch(() => {});
  await page.waitForTimeout(400);

  // A fresh campaign is unlocked by default, so its setup card (which hosts
  // the manual-add textarea) is already the one shown.
  const created = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll(".geo-chip.add")][0];
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("a new campaign can be created", created);
  await page.waitForTimeout(700);

  const opened = await page.evaluate(() => {
    const toggle = [...document.querySelectorAll("button")].find((b) => /type prompts manually/i.test(b.textContent));
    if (!toggle) return false;
    toggle.click();
    return true;
  });
  check("the manual-entry textarea can be opened", opened);
  await page.waitForTimeout(200);

  const LONG_PROMPT = "best budget smartphones in India, with a great camera, long battery life, and a smooth display for gaming";
  const SHORT_PROMPT = "best trading app in India";
  const lines = [
    LONG_PROMPT,                          // no pipe at all — every comma must survive as prose
    `${SHORT_PROMPT} | finance, beginner`, // explicit tags after a pipe
  ];

  await page.evaluate((text) => {
    const ta = document.querySelector(".prompt-manager textarea");
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, lines.join("\n"));

  const added = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /Add prompts/i.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("the Add prompts button exists and is clickable", added);
  await page.waitForTimeout(900);

  const saved = await page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "geo-profile-list" }, (profRes) => {
      const active = (profRes.profiles || []).find((p) => !p.locked) || (profRes.profiles || [])[0];
      chrome.runtime.sendMessage({ type: "geo-prompt-list", profileId: active && active.id }, (promptRes) => {
        resolve(promptRes.ok ? promptRes.prompts : []);
      });
    });
  }));

  const longSaved = saved.find((p) => p.text.startsWith("best budget smartphones"));
  check("the long prompt was saved at all", !!longSaved, saved.map((p) => p.text).join(" | "));
  if (longSaved) {
    check("its own commas stayed part of the prompt text, not chopped into tags",
      longSaved.text === LONG_PROMPT, longSaved.text);
    check("nothing was misread as a tag from a prompt with no pipe",
      (longSaved.tags || []).length === 0, JSON.stringify(longSaved.tags));
  }

  const shortSaved = saved.find((p) => p.text === SHORT_PROMPT);
  check("the short prompt (with an explicit pipe) was saved with its own text intact", !!shortSaved);
  if (shortSaved) {
    check("its pipe-delimited tags were parsed correctly",
      JSON.stringify(shortSaved.tags) === JSON.stringify(["finance", "beginner"]), JSON.stringify(shortSaved.tags));
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
