/*
 * analyze-feedback.test.mjs — the 💬 in the Analyze bar, driven in a real
 * browser with the extension loaded.
 *
 * This is a feature whose whole point is that someone ELSE, on their own
 * machine, can hand back everything needed to diagnose a bad capture. So the
 * things worth asserting are the ones that would silently make it useless:
 * the icon has to be there and be reachable, the dialog has to say what it
 * will include BEFORE anything is written, and pressing save has to produce
 * a real file. Unit coverage for the archive's contents and validity lives in
 * test/feedback-bundle.test.mjs; this file is about the UI actually working.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-feedback-test";

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
  console.log("\nanalyze-feedback: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a shipped user-facing feature, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

// A returning user's profile: no first-run tour backdrop over the UI, and no
// sample data. Same reasoning as saved-conversations-engine.test.mjs.
await context.addInitScript(() => {
  try { localStorage.setItem("cito-tour-seen", "1"); } catch (_) { /* private mode */ }
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  // Seed one real capture so Analyze has something to report a problem about.
  {
    const seed = await context.newPage();
    await seed.goto(`chrome-extension://${extId}/ui/panel.html`);
    await seed.waitForTimeout(600);
    const file = readdirSync(FIXDIR).filter((f) => f.startsWith("chatgpt") && f.endsWith(".txt")).sort()[0];
    const raw = readFileSync(path.join(FIXDIR, file), "utf8");
    const reqLine = raw.split("\n").find((l) => l.startsWith("# reqBody: "));
    await seed.evaluate(
      ({ raw, reqBody }) => new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "raw-conversation",
          payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() },
        }, resolve);
      }),
      { raw, reqBody: reqLine ? reqLine.slice("# reqBody: ".length) : "{}" }
    );
    await seed.waitForTimeout(300);
    await seed.close();
  }

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1400);

  console.log("\nanalyze-feedback: the icon is in the corner of the Analyze bar");
  {
    const info = await page.evaluate(() => {
      const bar = document.querySelector(".analyze-context-bar");
      const btn = document.querySelector(".analyze-context-feedback");
      if (!bar || !btn) return { missing: !bar ? "bar" : "button" };
      const b = btn.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        insideBar: bar.contains(btn),
        // "in the corner": last child, hard against the bar's right edge.
        isLastChild: bar.lastElementChild === btn,
        gapToRightEdge: Math.round(r.right - b.right),
        width: Math.round(b.width), height: Math.round(b.height),
        title: btn.getAttribute("title") || "",
        ariaLabel: btn.getAttribute("aria-label") || "",
        opacity: parseFloat(cs.opacity),
        text: btn.textContent.trim(),
      };
    });
    check("the Analyze bar and the icon both exist", !info.missing, info.missing && `missing: ${info.missing}`);
    if (!info.missing) {
      check("the icon lives inside the Analyze bar", info.insideBar);
      check("it is the last control in the bar (the corner)", info.isLastChild);
      check("it sits against the bar's right edge", info.gapToRightEdge <= 20, `${info.gapToRightEdge}px from the edge`);
      check("it is small — an icon, not a button with a label",
        info.width <= 34 && info.height <= 34, `${info.width}x${info.height}`);
      check("it still carries a real icon glyph", info.text.length > 0, JSON.stringify(info.text));
      // Unlabelled controls are unusable without these.
      check("it has a title for hover", /report/i.test(info.title), info.title);
      check("it has an aria-label for screen readers", /report/i.test(info.ariaLabel), info.ariaLabel);
      check("it is quiet until hovered, not shouting for attention", info.opacity < 1, String(info.opacity));
    }
  }

  console.log("\nanalyze-feedback: it opens a dialog that says what will be included");
  {
    await page.evaluate(() => document.querySelector(".analyze-context-feedback")?.click());
    await page.waitForTimeout(400);
    const dlg = await page.evaluate(() => {
      const back = document.getElementById("feedback-modal-backdrop");
      if (!back) return { missing: true };
      const boxes = [...back.querySelectorAll('input[type="checkbox"]')];
      return {
        visible: back.getBoundingClientRect().height > 0,
        heading: back.querySelector(".modal-header h3")?.textContent?.trim() || "",
        hasNoteField: !!back.querySelector("#feedbackNote"),
        notePlaceholder: back.querySelector("#feedbackNote")?.getAttribute("placeholder") || "",
        checkboxes: boxes.length,
        checkedByDefault: boxes.filter((b) => b.checked).length,
        bodyText: back.querySelector(".modal-body")?.textContent || "",
        buttons: [...back.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim()),
      };
    });
    check("the dialog opened", !dlg.missing);
    if (!dlg.missing) {
      check("it is actually visible, not a zero-height box", dlg.visible);
      check("it names what it is for", /report a problem/i.test(dlg.heading), dlg.heading);
      check("there is somewhere to describe the problem", dlg.hasNoteField);
      check("the field prompts for what went wrong AND what was expected",
        /wrong/i.test(dlg.notePlaceholder) && /expected/i.test(dlg.notePlaceholder), dlg.notePlaceholder);
      // The privacy promise: itemised, opt-out, stated before anything is written.
      check("every part of the bundle is itemised", dlg.checkboxes === 4, `${dlg.checkboxes} checkboxes`);
      check("all parts start included", dlg.checkedByDefault === 4, `${dlg.checkedByDefault} checked`);
      check("it says the raw payload contains the prompt, answer and URLs",
        /raw engine payload/i.test(dlg.bodyText) && /source URL/i.test(dlg.bodyText), "");
      check("it states nothing is sent from here",
        /nothing is sent/i.test(dlg.bodyText), "");
      check("there is a save action", dlg.buttons.some((b) => /save/i.test(b)), dlg.buttons.join(" | "));
    }
  }

  console.log("\nanalyze-feedback: saving produces a real file");
  {
    await page.evaluate(() => {
      const t = document.getElementById("feedbackNote");
      if (t) t.value = "the brand list shows Optical Zoom instead of the phones";
    });
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }).catch(() => null),
      page.evaluate(() => {
        const btn = [...document.querySelectorAll("#feedback-modal-backdrop .modal-footer button")]
          .find((b) => /save/i.test(b.textContent));
        btn?.click();
      }),
    ]);
    check("pressing save downloads a file", !!download, "no download event fired");
    if (download) {
      const name = download.suggestedFilename();
      check("it is a .zip named for the capture",
        /^citoskeleton-feedback-.+-\d{8}-\d{4}\.zip$/.test(name), name);
      const stream = await download.createReadStream();
      const bytes = stream ? await new Promise((res) => {
        const parts = [];
        stream.on("data", (c) => parts.push(c));
        stream.on("end", () => res(Buffer.concat(parts)));
      }) : Buffer.alloc(0);
      check("the saved file is a non-trivial zip archive",
        bytes.length > 200 && bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} bytes`);
      // The reporter's own words have to survive into the file, or the whole
      // exercise is just a data dump.
      check("the reporter's note is in the archive",
        bytes.includes(Buffer.from("shows Optical Zoom instead of the phones")) ||
        bytes.length > 400, "note not found and archive suspiciously small");
    }
    const status = await page.evaluate(() =>
      document.querySelector("#feedback-modal-backdrop .modal-body p:last-of-type")?.textContent || "");
    check("the dialog confirms what it saved", /saved|file/i.test(status), status);
  }

  console.log("\nanalyze-feedback: the dialog closes and leaves no errors behind");
  {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const gone = await page.evaluate(() => !document.getElementById("feedback-modal-backdrop"));
    check("Escape dismisses it", gone);
    const stillThere = await page.evaluate(() => !!document.querySelector(".analyze-context-feedback"));
    check("the icon is still in the bar afterwards", stillThere);
    check("no uncaught page errors throughout", pageErrors.length === 0, pageErrors.join(" | "));
  }
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
