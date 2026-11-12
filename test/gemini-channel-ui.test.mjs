/*
 * gemini-channel-ui.test.mjs — a Gemini answer over its WebChannel becomes
 * a capture, in a real browser (0.66.0).
 *
 * Reported: "gemini … did not run": every Gemini turn ended "sent, no answer
 * captured", since Gemini's answer moved to a processSession stream that
 * 0.65.0 only kept as a probe, and only with Debug capture on. A stand-in
 * gemini.google.com page uploads a prompt and reads a made-up answer stream
 * (test/helpers/gemini-channel.mjs) the way Gemini does. Checks, with Debug
 * capture off: one record, with the prompt, the answer, three cited pages and
 * two products; the stream's repeated hand-overs make one answer, not two;
 * Analyze shows it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelStream, uploadBody } from "./helpers/gemini-channel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-gemini-channel-test";

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
  console.log(`\ngemini-channel-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const PROMPT = "waterproof phone under 60000 in India";
const UPLOAD = uploadBody(PROMPT);
const STREAM = channelStream();
const CH = "https://geminiweb-pa.clients6.google.com/v1/processSession";
// Gemini's order: the upload, a tiny acknowledgement upload, then the
// answer's long GETs. The first carries only the "Searching the web" status
// and goes quiet (0.69.0: handed over like that, it was stored as an empty
// answer that finished the campaign turn); the second brings the answer.
const PAGE = `<!doctype html><body>stub<script>
  const xhr = (method, url, body) => new Promise((done) => { const x = new XMLHttpRequest(); x.open(method, url); x.onloadend = done; x.send(body); });
  (async () => {
    await xhr("POST", "${CH}?VER=8&RID=52484&AID=0&zx=a&t=1", ${JSON.stringify(UPLOAD)});
    await xhr("POST", "${CH}?VER=8&RID=52485&AID=3&zx=b&t=1", "count=1&ofs=2&req0___data__=IgIIAQ%3D%3D");
    await xhr("GET", "${CH}?VER=8&RID=rpc&SID=abc&AID=0&CI=0&TYPE=xmlhttp&zx=c&t=1");
    await xhr("GET", "${CH}?VER=8&RID=rpc&SID=abc&AID=9&CI=0&TYPE=xmlhttp&zx=d&t=1");
    document.title = "done";
  })();
</script></body>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let gets = 0;
  await context.route(/^https:\/\/geminiweb-pa\.clients6\.google\.com\//, async (route) => {
    const get = route.request().method() === "GET";
    if (get && gets++ === 0) await new Promise((r) => setTimeout(r, 300));
    const body = get ? (gets === 1 ? channelStream({ steps: 0 }) : STREAM) : "51\n[[0,[\"c\",\"abc\",null,8]]]";
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "https://gemini.google.com", "access-control-allow-credentials": "true", "content-type": "text/plain" }, body });
  });
  await context.route(/^https:\/\/gemini\.google\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: PAGE }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);

  // A Google session cookie, as a signed-in browser has on google.com.
  await context.addCookies([{ name: "__Secure-1PSID", value: "made-up", domain: ".google.com", path: "/", secure: true, httpOnly: true, sameSite: "None" }]);
  const p = await context.newPage();
  await p.goto("https://gemini.google.com/app/0a1b2c3d4e5f6071");
  await p.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(3500);

  console.log("\nthe answer is captured, with Debug capture off");
  const recs = (((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "gemini");
  check("one Gemini answer: the status-only hand-over is not stored, the repeat folds in", recs.length === 1, String(recs.length));
  const rec = (recs[0] && ((await msg({ type: "get-record", captureId: recs[0].captureId })) || {}).record) || {};
  check("with the prompt that went up", rec.userPrompt === PROMPT, rec.userPrompt);
  check("the answer", /^For a \*\*waterproof phone/.test(rec.answerText || "") && /Kovo Aqua Pro/.test(rec.answerText || ""), (rec.answerText || "").slice(0, 80));
  check("three cited pages", (rec.sources || []).length === 3, JSON.stringify((rec.sources || []).map((s) => s.domain)));
  check("two product cards", (rec.products || []).length === 2 && rec.products[0].name === "Zento X9 5G", JSON.stringify((rec.products || []).map((x) => x.name)));
  // 1.0.0: Google's session cookie lives on google.com, which the extension
  // has no access to (no new permission for 0.36 users), so Chrome doesn't
  // show it. The answer must then say "unknown", never "signed out".
  check("sign-in marked unknown, not signed out", rec.session && rec.session.signedIn === "unknown" && rec.session.private === false, JSON.stringify(rec.session));
  const probes = ((await msg({ type: "get-probes" })) || {}).probes || [];
  check("nothing kept as a probe", probes.length === 0, String(probes.length));

  console.log("\nAnalyze shows it");
  await panel.reload();
  await panel.waitForTimeout(1500);
  const shown = await panel.evaluate(() => document.getElementById("analyze")?.innerText || "");
  check("the prompt and a product are on screen", shown.includes(PROMPT) && /Zento X9 5G/.test(shown), shown.slice(0, 300));
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
