/*
 * compare-tab.test.mjs — the Compare tab actually renders, and no tab in the
 * app throws on render.
 *
 * Reported: "the comparison is not working now." Cause: the Compare tab
 * referenced ENGINE_ICONS — the emoji map that was DELETED when engine icons
 * moved to real inline-SVG brand marks (engineIconEl/engineChip). Five call
 * sites in renderCompare() still read it, so picking a prompt threw
 * "ENGINE_ICONS is not defined" and #cmpOut rendered zero children: a
 * completely blank tab, with the failure visible only in the devtools
 * console.
 *
 * Two things went wrong and this file guards both:
 *   1. Compare specifically was never rendered by any test, so a hard
 *      ReferenceError in it passed CI.
 *   2. The failure mode — an undefined global in one render path — blanks a
 *      tab silently. So this asserts every tab renders AND that zero page
 *      errors occur while walking them, which catches the whole class, not
 *      just this one identifier.
 *
 * Since 0.47.0 Compare is reached from Analyze, not the top menu; this file
 * opens it that way.
 *
 * Compare needs a prompt captured MORE THAN ONCE to have anything to compare,
 * so the same fixture is submitted twice (identical prompt text = one
 * timeline with two runs) rather than seeding distinct prompts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXTURE = path.join(HERE, "fixtures", "chatgpt-phone-under.txt");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-compare-test";

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
  console.log("\ncompare-tab: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported correctness bug, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const RAW = readFileSync(FIXTURE, "utf8");
// The prompt text this fixture's reqBody declares — both submissions use it,
// so they land in ONE timeline rather than two unrelated ones.
const REQ_BODY = JSON.stringify({
  messages: [{ author: { role: "user" }, content: { parts: ["best smartphone under 50000"] } }],
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
    // Any failed network FETCH is environmental, not an app logic error: this
    // runs offline, so Google Fonts and the remote product thumbnails the
    // Analyze tab renders (ERR_TUNNEL_CONNECTION_FAILED behind a proxy) will
    // always fail here. Matching "net::ERR_" covers the family without
    // needing to enumerate each code, and still lets real thrown errors and
    // console.error() calls from our own code through.
    if (/Failed to load resource|net::ERR_|fonts\.(googleapis|gstatic)/i.test(t)) return;
    pageErrors.push("console: " + t);
  });

  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(800);

  // Same prompt twice -> a two-run timeline for Compare to work with.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(
      async ({ raw, reqBody }) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: "raw-conversation",
            payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() },
          }, resolve);
        }),
      { raw: RAW, reqBody: REQ_BODY }
    );
    await page.waitForTimeout(900);
  }
  await page.reload();
  await page.waitForTimeout(2500);

  // Errors from seeding/first paint aren't what this test is about.
  pageErrors.length = 0;

  console.log("\nCompare: renders a real comparison for a prompt with two runs");
  // Since 0.47.0 Compare is not in the top menu; it opens from the answer,
  // on that answer's prompt (analyze-popup.test.mjs covers the popup's link).
  const menuHasCompare = await page.evaluate(() => !!document.querySelector('.nav-tabs [data-tab="compare"]'));
  check("Compare is no longer a top-menu tab", !menuHasCompare);
  const opener = await page.evaluate(() => document.querySelector('#analyze [data-open="compare"]')?.textContent || "");
  check("the answer offers to compare its two answers", /Compare 2 answers/.test(opener), opener);
  await page.evaluate(() => document.querySelector('#analyze [data-open="compare"]')?.click());
  await page.waitForTimeout(900);
  const preselected = await page.evaluate(() => document.querySelector("#cmpPrompt")?.value || "");
  check("Compare opens on this answer's prompt", /50000/.test(preselected), preselected);

  const optionCount = await page.evaluate(() => document.querySelectorAll("#cmpPrompt option").length);
  check("the prompt picker is populated (placeholder + at least one prompt)", optionCount >= 2, `${optionCount} options`);

  const picked = await page.evaluate(() => {
    const sel = document.querySelector("#cmpPrompt");
    if (!sel || sel.options.length < 2) return null;
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  });
  check("a prompt can be selected", !!picked, String(picked));
  await page.waitForTimeout(1500);

  const out = await page.evaluate(() => {
    const o = document.querySelector("#cmpOut");
    return { children: o ? o.children.length : -1, text: o ? o.innerText.trim() : "" };
  });

  // The actual regression: this was 0, and the tab was blank.
  check("#cmpOut renders content rather than staying blank", out.children > 0, `${out.children} children`);
  check("the comparison names the prompt it is comparing", /50000/.test(out.text), out.text.slice(0, 120));
  check("the run-by-run breakdown is present", /RUN BY RUN|Run by run/i.test(out.text), out.text.slice(0, 200));
  check(
    "no page error while rendering Compare (an undefined global here blanks the whole tab)",
    pageErrors.length === 0,
    pageErrors.join(" | ")
  );

  // Same failure mode could hide in any render path, so walk them all.
  console.log("\nEvery tab renders without throwing");
  for (const tab of ["analyze", "dashboard", "loader", "about"]) {
    pageErrors.length = 0;
    await page.evaluate((t) => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(700);
    const r = await page.evaluate((t) => {
      const el = document.getElementById(t);
      return { exists: !!el, len: el ? el.innerText.trim().length : -1 };
    }, tab);
    check(`#${tab} renders with content and no page error`, r.exists && r.len > 0 && pageErrors.length === 0,
      `exists=${r.exists} len=${r.len} errors=${pageErrors.join(" | ")}`);
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
