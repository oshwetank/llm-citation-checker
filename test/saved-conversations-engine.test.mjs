/*
 * saved-conversations-engine.test.mjs — every Saved Conversations row states
 * which engine produced it, whether or not that prompt was also run on the
 * other engine.
 *
 * Reported: "In Saved Conversations section if same prompt is not run on both
 * the llms you won't know which one was run on which platform."
 *
 * The platform pill selector in that list only ever rendered when a cluster
 * (same date + same prompt text) held MORE than one run — i.e. only once the
 * prompt HAD been run on both engines. The far more common case — a prompt
 * captured on just one engine — showed no platform indicator anywhere on the
 * row: no icon, no label, nothing. This test seeds a mix of ChatGPT-only and
 * Gemini-only captures (deliberately distinct prompts, so none of them
 * cluster) and asserts every row now carries a correct, visible engine badge.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-saved-conv-test";

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
  console.log("\nsaved-conversations-engine: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported correctness bug, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// Distinct prompts across every fixture (confirmed by inspection), so each
// one becomes its own SOLO cluster — exactly the case that was silent.
const FILES = [
  "chatgpt-tv.txt",
  "chatgpt-watches.txt",
  "gemini-jewellery-shopping.txt",
  "gemini-streamgenerate.txt",
];

async function seedFixtures(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.waitForTimeout(600);
  for (const f of FILES) {
    const raw = readFileSync(path.join(FIXDIR, f), "utf8");
    const isGemini = f.startsWith("gemini");
    // Each fixture's real prompt lives in its "# reqBody: ..." header line —
    // both adapters extract userPrompt from THIS field, not from `raw`. A
    // placeholder reqBody (as several other tests use, since they don't care
    // about prompt text) makes userPrompt null for every capture, which
    // would collapse all of them into one "(No prompt)" cluster and silently
    // defeat the very thing this test exists to check.
    const reqBody = raw.split("\n").find((l) => l.startsWith("# reqBody: ")).slice("# reqBody: ".length);
    await page.evaluate(
      async ({ raw, reqBody, isGemini }) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: "raw-conversation",
              payload: {
                raw, reqBody,
                pageUrl: isGemini ? "https://gemini.google.com/app" : "https://chatgpt.com/",
                capturedAt: Date.now(),
              },
            },
            resolve
          );
        }),
      { raw, reqBody, isGemini }
    );
    await page.waitForTimeout(120);
  }
  await page.close();
}

// Start from an empty browser profile every run. Otherwise each fixture
// re-seeds with a fresh random captureId on every invocation, and a profile
// left over from a prior run silently doubles the row count — which is
// exactly the kind of self-inflicted failure that looks like a product bug
// but isn't one.
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

// Mark the first-run tour as already seen, for every page in this context,
// before any of the panel's own scripts get to run.
//
// Two reasons, both real. The panel loads SAMPLE DATA on first run (see
// maybeFirstRun in ui/panel.js) whenever the store holds no real captures —
// and this harness opens the panel before it seeds, so that condition is met
// and the sample capture lands in the list, making the row count one higher
// than the fixtures seeded here. It also draws #tour-backdrop over the whole
// UI, which swallows clicks. Neither is a product bug; both are first-run
// behaviour this test does not mean to exercise.
await context.addInitScript(() => {
  try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* private mode */ }
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  await seedFixtures(context, extId);

  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  await page.click('[data-tab="dashboard"]').catch(() => {});
  await page.waitForTimeout(1200);

  const rows = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".capture-item")];
    return items.map((li) => {
      const prompt = li.querySelector(".capture-prompt")?.textContent?.trim() || "";
      const badge = li.querySelector(".capture-engine");
      const tabsRow = li.querySelector(".capture-meta")?.nextElementSibling; // best-effort, not asserted on
      return {
        prompt,
        hasBadge: !!badge,
        badgeText: badge ? badge.textContent.trim() : "",
        hasIcon: !!badge?.querySelector("svg, .llm-icon"),
      };
    });
  });

  check("Saved Conversations rendered rows for every seeded capture", rows.length === FILES.length, `${rows.length} rows`);

  const solo = rows; // every fixture here is deliberately a solo (non-clustered) cluster
  check(
    "every row — including a prompt run on only ONE engine — carries an engine badge",
    solo.length > 0 && solo.every((r) => r.hasBadge),
    JSON.stringify(solo.map((r) => ({ prompt: r.prompt.slice(0, 30), hasBadge: r.hasBadge })))
  );
  check(
    "every badge has a real icon, not just text",
    solo.every((r) => r.hasIcon),
    JSON.stringify(solo.map((r) => r.hasIcon))
  );

  // Correlate each row to the engine its own fixture actually used, via the
  // one string every prompt is unique on.
  const expectByPromptFragment = [
    ["best tv to buy", "ChatGPT"],
    ["new trending watch", "ChatGPT"],
    ["modern jewellery", "Gemini"],
    ["best camera phone", "Gemini"],
  ];
  for (const [fragment, engine] of expectByPromptFragment) {
    const row = rows.find((r) => r.prompt.toLowerCase().includes(fragment));
    check(`row for "${fragment}" is labelled ${engine}`, !!row && row.badgeText.includes(engine),
      row ? `badge says "${row.badgeText}"` : "row not found");
  }

  console.log("\nthe badge also stays correct once a prompt HAS run on both engines");
  {
    // The one case that already had a platform indicator (the pill selector,
    // shown only when a cluster holds more than one run) still needs the
    // badge to track whichever run is currently active — otherwise switching
    // pills would leave a stale engine label on screen. Seeded directly into
    // IndexedDB (bypassing reqBody/adapter parsing entirely) so this checks
    // only the clustering + badge-sync behaviour, not extraction.
    const seeded = await page.evaluate(async () => {
      const open = () => new Promise((res, rej) => {
        // No version argument on purpose. Hardcoding one (this said 4) breaks with
        // a VersionError the moment db.js adds a store and bumps DB_VERSION —
        // which it did, for the error log. Opening without a version attaches to
        // whatever the extension has already created, which is what a seed wants.
        const r = indexedDB.open("lcfc");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const put = (v) => new Promise((res) => {
        const r = db.transaction("derived", "readwrite").objectStore("derived").put(v);
        r.onsuccess = () => res();
      });
      const now = Date.now();
      const prompt = "which laptop for college students";
      const base = {
        schemaVersion: 2, model: null, pageUrl: null, rawRef: null,
        conversationId: null, turnId: null, projectId: null, runId: null, geo: null,
        generatedTitle: null, turnUseCase: null, searched: false,
        fanout: { search: [], shopping: [], image: [] }, sources: [], products: [],
        places: [], entities: [], images: [], brandMentions: [],
        carousels: { products: false, images: false, news: false, map: false },
        referenceTypes: {}, answerChars: 0, answerText: "", platformSpecific: {},
      };
      await put({ ...base, captureId: "cluster-chatgpt", platform: "chatgpt", capturedAt: now, userPrompt: prompt });
      await put({ ...base, captureId: "cluster-gemini", platform: "gemini", capturedAt: now + 1000, userPrompt: prompt });
      return true;
    });
    check("synthetic clustered records were written", seeded === true);

    await page.reload();
    await page.waitForTimeout(1000);
    await page.click('[data-tab="dashboard"]').catch(() => {});
    await page.waitForTimeout(1200);

    const clustered = await page.evaluate(() => {
      const items = [...document.querySelectorAll(".capture-item")];
      const li = items.find((el) => el.querySelector(".capture-prompt")?.textContent?.includes("which laptop for college"));
      if (!li) return null;
      const pills = [...li.querySelectorAll("button")].filter((b) => /^(chatgpt|gemini)\s*\(/i.test(b.textContent.trim()));
      return {
        hasPills: pills.length >= 2,
        badgeBefore: li.querySelector(".capture-engine")?.textContent?.trim() || "",
      };
    });
    check("the clustered row shows the platform pill selector", !!clustered && clustered.hasPills, JSON.stringify(clustered));
    check("its badge matches whichever run is active by default",
      !!clustered && /ChatGPT|Gemini/.test(clustered.badgeBefore), clustered && clustered.badgeBefore);

    if (clustered && clustered.hasPills) {
      const switched = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".capture-item")];
        const li = items.find((el) => el.querySelector(".capture-prompt")?.textContent?.includes("which laptop for college"));
        const before = li.querySelector(".capture-engine")?.textContent?.trim() || "";
        const otherPill = [...li.querySelectorAll("button")]
          .find((b) => /^(chatgpt|gemini)\s*\(/i.test(b.textContent.trim()) && !b.className.includes("primary"));
        otherPill?.click();
        return { before, clickedText: otherPill?.textContent || "" };
      });
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".capture-item")];
        const li = items.find((el) => el.querySelector(".capture-prompt")?.textContent?.includes("which laptop for college"));
        return li.querySelector(".capture-engine")?.textContent?.trim() || "";
      });
      check("switching the pill updates the badge to the newly active engine",
        after && after !== switched.before,
        `before="${switched.before}" clicked="${switched.clickedText}" after="${after}"`);
    }
  }

  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
