/*
 * page-copy.test.mjs — reading a conversation is not asking (0.62.1), in a
 * real browser.
 *
 * Reported: a prompt "Youbest good quality earbuds under 4000" showed in the
 * Dashboard and Analyze though it was never asked. The owner had reopened a
 * Grok conversation 44 minutes after asking. content-iso.js's page-text
 * reader ran because the conversation was on screen, read the prompt with
 * Grok's hidden "You" label glued on, and the answer was stored again as a
 * new one with no pages.
 *
 * Checks: opening a Grok conversation without sending anything stores
 * nothing; a page-text copy of an answer (in the old shape, label and all)
 * arriving 44 minutes after the network capture folds into it, so the
 * records list one answer with the real prompt; Reprocess keeps it that way.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-page-copy-test";

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
  console.log("\npage-copy: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported phantom prompt, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const CONV = "98312727-e1ec-4b06-9202-74c7f49d300f";
const REPLY = "1604cd56-ed23-42db-86e4-c5244bc67490";
const PAGE_URL = `https://grok.com/c/${CONV}?rid=${REPLY}`;
const PROMPT = "best camera phone under 80000";
const ANSWER = "The Zento Nova 8 is the best camera phone under 80000 for most people, with the Kovo Edge 5 Pro close behind for video.";
// grok.com as it looks when a finished conversation is reopened: the user
// message with its hidden "You" label, then the answer with Grok's labels.
const CONVERSATION_HTML = `<!doctype html><body><main>
  <div data-testid="user-message"><span class="sr-only">You</span><div class="message-bubble">${PROMPT}</div></div>
  <div class="message-bubble"><h2>Grok</h2><p>Worked for 19s</p><p>${ANSWER}</p><p>${ANSWER}</p></div>
</main></body>`;

const fixture = readFileSync(path.join(HERE, "fixtures", "grok-cameraPhoneRenderTags.txt"), "utf8");
const restRaw = fixture.split("\n").filter((l) => !l.startsWith("#")).join("\n");
const restReq = (fixture.match(/^# reqBody: (.*)$/m) || [])[1] || null;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.route(/^https:\/\/grok\.com\//, (route) => {
    if (route.request().resourceType() === "document") return route.fulfill({ status: 200, contentType: "text/html", body: CONVERSATION_HTML });
    return route.fulfill({ status: 204, body: "" });
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const grokRecords = async () => (((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "grok");

  console.log("\nOpening an old conversation stores nothing");
  {
    const tab = await context.newPage();
    await tab.goto(PAGE_URL);
    await tab.waitForTimeout(6000); // the reader's own timers fire at 1.5 s and 3 s
    await tab.close();
    const recs = await grokRecords();
    check("no capture when nothing was sent from the page", recs.length === 0, JSON.stringify(recs.map((r) => r.userPrompt)));
  }

  console.log("\nA page-text copy 44 minutes later folds into the answer");
  const T = Date.now() - 2 * 3600 * 1000;
  {
    const a = await msg({ type: "raw-conversation", payload: { url: `https://grok.com/rest/app-chat/conversations/${CONV}/load-responses`, reqBody: restReq, raw: restRaw, transport: "fetch", pageUrl: PAGE_URL, capturedAt: T } });
    // The shape 0.62.0 stored: prompt with the label glued on, no promptClean.
    const pageRaw = JSON.stringify({ query: `You${PROMPT}`, text: `## Grok\n\nWorked for 19s\n${ANSWER}`, web_results: [], status: "COMPLETED", harvestSource: "dom" });
    const b = await msg({ type: "raw-conversation", payload: { url: PAGE_URL, reqBody: JSON.stringify({ query: `You${PROMPT}` }), raw: pageRaw, transport: "dom_harvest", pageUrl: PAGE_URL, capturedAt: T + 44 * 60 * 1000 } });
    check("both copies were taken in", a && a.captureId && b && b.captureId, JSON.stringify([a, b]));
    const recs = await grokRecords();
    check("one answer, not two", recs.length === 1, JSON.stringify(recs.map((r) => r.userPrompt)));
    check("with the prompt that was asked", recs[0] && recs[0].userPrompt === PROMPT, recs[0] && recs[0].userPrompt);
    check("and no prompt anywhere starts with the label", !recs.some((r) => /^You\S/.test(r.userPrompt || "")));
  }

  console.log("\nReprocess keeps it one answer");
  {
    await msg({ type: "reprocess-all" });
    const recs = await grokRecords();
    check("still one answer with the real prompt", recs.length === 1 && recs[0].userPrompt === PROMPT, JSON.stringify(recs.map((r) => r.userPrompt)));
  }
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
