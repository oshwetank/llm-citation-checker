/*
 * gemini-page-prompt.test.mjs — Gemini's question, when its request no
 * longer carries it (1.0.0).
 *
 * The owner's Gemini capture of 15 Nov 2026: the upload had the question
 * field (1.8.5.1.1.1) present and empty, and no other upload held the
 * question, so the answer was stored with no prompt. The question is on the
 * page (Gemini draws it in <user-query> as soon as it's sent); the page
 * script sends it with the capture and the worker uses it only when the
 * engine's request has none, and only for a capture that has an answer.
 * The answer's card markup ("<EntityCard … />", "[name](_link)") is taken
 * out of the stored text too.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelStream, uploadBody } from "./helpers/gemini-channel.mjs";
import { stripCardPlaceholders } from "../src/adapters/gemini.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-gemini-page-prompt-test";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nGemini's card markup is not answer text");
{
  const t = "Here are picks.\n\n<EntityCard entity_id=\"27\" entity_type=\"product\" title=\"Zento X9 5G\"/>\nThe [Zento X9 5G](_link) has an IP69 rating.\n\n<EntityCard entity_id=\"28\" entity_type=\"product\" title=\"Kovo Aqua Pro\"/>\nThe [Kovo Aqua Pro](_link) is cheaper.";
  const r = stripCardPlaceholders(t);
  check("no <EntityCard> or (_link) left", !/<EntityCard|\(_link\)/.test(r.text), r.text);
  check("the names stay as text", /The Zento X9 5G has an IP69 rating\./.test(r.text) && /The Kovo Aqua Pro is cheaper\./.test(r.text), r.text);
  check("each card kept by kind and title", r.cards.length === 2 && r.cards[0].kind === "product" && r.cards[1].title === "Kovo Aqua Pro", JSON.stringify(r.cards));
}

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log(`\ngemini-page-prompt: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const QUESTION = "which waterproof phone has the biggest battery";
const CH = "https://geminiweb-pa.clients6.google.com/v1/processSession";
// The upload as on 15 Nov 2026: the question field there, and empty.
const EMPTY_Q = uploadBody("");
// `answer`: whether the stream brings an answer (else only "Searching the web").
const PAGE = (answer) => `<!doctype html><body>
  <user-query><span class="cdk-visually-hidden">You said</span><div class="query-text"><p>${QUESTION}</p></div></user-query>
  <script>
  const xhr = (method, url, body) => new Promise((done) => { const x = new XMLHttpRequest(); x.open(method, url); x.onloadend = done; x.send(body); });
  (async () => {
    await xhr("POST", "${CH}?VER=8&RID=1&AID=0&zx=a&t=1", ${JSON.stringify(EMPTY_Q)});
    await xhr("GET", "${CH}?VER=8&RID=rpc&SID=abc&AID=0&CI=0&TYPE=xmlhttp&zx=${answer ? "ans" : "status"}&t=1");
    document.title = "done";
  })();
  </script></body>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.route(/^https:\/\/geminiweb-pa\.clients6\.google\.com\//, async (route) => {
    const req = route.request();
    const body = req.method() === "GET" ? (/zx=ans/.test(req.url()) ? channelStream() : channelStream({ steps: 0 })) : "51\n[[0,[\"c\",\"abc\",null,8]]]";
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "https://gemini.google.com", "access-control-allow-credentials": "true", "content-type": "text/plain" }, body });
  });
  await context.route(/^https:\/\/gemini\.google\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: PAGE(!/status-only/.test(route.request().url())) }));
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const records = async () => (((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "gemini");

  console.log("\na status-only stream with a question on the page: still nothing stored");
  const s = await context.newPage();
  await s.goto("https://gemini.google.com/app/status-only");
  await s.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
  await s.waitForTimeout(4000);
  check("no record", (await records()).length === 0, String((await records()).length));
  await s.close();

  console.log("\nan answer whose upload's question field is empty");
  const p = await context.newPage();
  await p.goto("https://gemini.google.com/app/0a1b2c3d4e5f6071");
  await p.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
  let recs = [];
  for (let i = 0; i < 20 && !recs.length; i++) { await p.waitForTimeout(500); recs = await records(); }
  check("recorded", recs.length === 1, String(recs.length));
  const rec = (recs[0] && ((await msg({ type: "get-record", captureId: recs[0].captureId })) || {}).record) || {};
  check("with the question the page showed", rec.userPrompt === QUESTION, JSON.stringify(rec.userPrompt));
  check("and says where it came from", ((rec._extraction || {}).notes || []).some((n) => /read off the page/.test(n)), JSON.stringify((rec._extraction || {}).notes));
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
