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
 *
 * Since 0.49.0 the Saved Conversations list is the Dashboard's history: one
 * row per prompt, with a mark for every engine that answered it. The same
 * guarantee holds there, and each mark opens that engine's answer.
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
  // That first navigation, on a genuinely empty store, is exactly the
  // condition maybeFirstRun() (panel.js) auto-loads one sample/demo capture
  // under — it isn't seeded by this test but shows up as a real row in
  // Saved Conversations regardless, inflating the count by one. Clear it
  // before seeding the real fixtures so what this test counts is only what
  // it itself put there.
  await page.evaluate(
    () => new Promise((resolve) => chrome.runtime.sendMessage({ type: "demo-clear" }, resolve))
  );
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

  // Since 0.49.0 the Dashboard has one row per prompt (.db-row) carrying a
  // mark for every engine that answered it (.db-engine, which opens that
  // engine's answer). The guarantee is the same: a prompt run on only one
  // engine still says which engine.
  const rowsNow = () => page.evaluate(() => [...document.querySelectorAll("#dashboard .db-row")].map((li) => ({
    prompt: li.querySelector(".db-prompt")?.textContent?.trim() || "",
    marks: [...li.querySelectorAll(".db-engine")].map((b) => ({
      engine: b.dataset.engine, label: b.getAttribute("aria-label") || "", hasIcon: !!b.querySelector("svg"),
    })),
  })));
  // The seeded prompts are all from today, and the default period would hide
  // nothing; "All time" makes that explicit.
  await page.evaluate(() => [...document.querySelectorAll(".db-seg-btn")].find((b) => b.textContent === "All time")?.click());
  await page.waitForTimeout(300);
  const rows = await rowsNow();

  check("the Dashboard lists a row for every seeded prompt", rows.length === FILES.length, `${rows.length} rows`);
  check(
    "every row — including a prompt run on only ONE engine — names its engine",
    rows.length > 0 && rows.every((r) => r.marks.length > 0 && r.marks.every((m) => /^Open (ChatGPT|Gemini|Perplexity|Grok)'s answer$/.test(m.label))),
    JSON.stringify(rows.map((r) => ({ prompt: r.prompt.slice(0, 30), marks: r.marks.map((m) => m.label) })))
  );
  check("every mark has a real icon, not just text", rows.every((r) => r.marks.every((m) => m.hasIcon)));

  // Correlate each row to the engine its own fixture actually used, via the
  // one string every prompt is unique on.
  const expectByPromptFragment = [
    ["best tv to buy", "chatgpt"],
    ["new trending watch", "chatgpt"],
    ["modern jewellery", "gemini"],
    ["best camera phone", "gemini"],
  ];
  for (const [fragment, engine] of expectByPromptFragment) {
    const row = rows.find((r) => r.prompt.toLowerCase().includes(fragment));
    check(`row for "${fragment}" is marked ${engine}`, !!row && row.marks.length === 1 && row.marks[0].engine === engine,
      row ? JSON.stringify(row.marks) : "row not found");
  }

  console.log("\na prompt run on both engines shows both, and each opens its own answer");
  {
    // Seeded directly into IndexedDB (bypassing reqBody/adapter parsing
    // entirely) so this checks only the grouping and the marks, not extraction.
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
    check("synthetic records for one prompt on two engines were written", seeded === true);

    await page.reload();
    await page.waitForTimeout(1000);
    await page.click('[data-tab="dashboard"]').catch(() => {});
    await page.waitForTimeout(1200);
    const both = (await rowsNow()).filter((r) => r.prompt.includes("which laptop for college"));
    check("it is one row, not two", both.length === 1, JSON.stringify(both));
    check("the row carries both engines' marks", both[0] && both[0].marks.map((m) => m.engine).join() === "chatgpt,gemini", both[0] && JSON.stringify(both[0].marks));
    for (const [engine, label] of [["gemini", "Gemini"], ["chatgpt", "ChatGPT"]]) {
      await page.evaluate((engine) => [...document.querySelectorAll("#dashboard .db-row")]
        .find((li) => li.querySelector(".db-prompt")?.textContent?.includes("which laptop for college"))
        ?.querySelector(`.db-engine[data-engine="${engine}"]`)?.click(), engine);
      await page.waitForTimeout(1200);
      const asked = await page.evaluate(() => document.querySelector("#analyze .at-asked")?.textContent || "");
      check(`its ${label} mark opens ${label}'s answer`, asked === `Asked ${label}`, asked);
      await page.click('[data-tab="dashboard"]').catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  await page.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
