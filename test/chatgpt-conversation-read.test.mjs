/*
 * chatgpt-conversation-read.test.mjs — a ChatGPT answer is recorded even
 * when the page's network calls and its markup are both out of reach (1.0.0).
 *
 * The owner's recording of 13 Nov 2026: every ChatGPT request went through
 * another extension's inject.js ("patchedFetch"), and CitoSkeleton's fetch
 * hook was not in the chain at all ("requests seen 0", "sends seen 0"); the
 * thread's markup had changed too ("0 questions, 0 answers on the page").
 * Nothing was recorded.
 *
 * The stand-in chatgpt.com here does both: it sends its requests with a
 * fetch the extension's hook can't see (an iframe's), and draws the answer in
 * plain divs with no marker the extension knows. Its conversation address
 * answers the way ChatGPT's does for its own page (checked against the
 * owner's recording: cookies plus a device and an account identifier, never an
 * Authorization header), and says the answer is unfinished for the first few
 * seconds. The test fails if the extension ever asks for or sends a token.
 *   1. the pure part: the latest turn of a conversation, both shapes;
 *   2. a question asked in the tab is recorded from the conversation, with
 *      its prompt, answer, brands and sources;
 *   3. an old conversation merely opened is never read.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { latestTurn, turnAsCapture, conversationMessages, isConversationJson } from "../src/lib/chatgptConversation.js";
import { adapt } from "../src/adapters/chatgpt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-chatgpt-conversation-read-test";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const ID = "6af70000-aaaa-bbbb-cccc-000000000001";
const PROMPT = "best linen shirt brands for summer";
const ANSWER = "For hot days, these are the picks:\n\n- **Zento Linen**: breathable and well cut.\n- **Kovo Weave**: softer, a little pricier.\n- **Lumora**: the budget choice.";
// A conversation in the shape ChatGPT's page loads (the owner's 13 Nov
// recording: a `messages` list), made-up brands.
const conversation = (askedAt, done, prompt = PROMPT, answer = ANSWER) => ({
  title: "Linen shirts", conversation_id: ID, default_model_slug: "gpt-x", current_node: "a2",
  messages: [
    { id: "s0", author: { role: "system" }, content: { content_type: "text", parts: [""] }, status: "finished_successfully", recipient: "all" },
    { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: [prompt] }, create_time: askedAt / 1000, status: "finished_successfully", recipient: "all" },
    { id: "t1", author: { role: "tool", name: "web.run" }, content: { content_type: "text", parts: [""] }, recipient: "all", status: "finished_successfully",
      metadata: { search_model_queries: { type: "search_model_queries", queries: ["best linen shirts summer"] },
        search_result_groups: [{ type: "search_result_group", domain: "stylelab.example", entries: [{ type: "search_result", url: "https://stylelab.example/linen", title: "Linen shirts — StyleLab", snippet: "Zento Linen tops our list." }] }] } },
    { id: "a2", author: { role: "assistant" }, channel: "final", recipient: "all", content: { content_type: "text", parts: [done ? answer : "For hot days, **Zento"] }, status: done ? "finished_successfully" : "in_progress",
      metadata: { content_references: [{ matched_text: "", type: "grouped_webpages", items: [{ url: "https://stylelab.example/linen", title: "Linen shirts — StyleLab" }] }] } },
  ],
});

console.log("\n1. the latest turn of a conversation");
{
  const c = conversation(Date.now(), true);
  check("found, with its question and answer", latestTurn(c) && latestTurn(c).prompt === PROMPT && /Zento Linen/.test(latestTurn(c).finalText));
  check("not while the answer is still being written", latestTurn(conversation(Date.now(), false)) === null);
  // The classic shape: a tree in `mapping`.
  const mapping = {}; let parent = null;
  for (const m of c.messages) { mapping[m.id] = { id: m.id, message: m, parent, children: [] }; parent = m.id; }
  check("the classic tree shape too", conversationMessages({ mapping, current_node: "a2" }).length === 4 && latestTurn({ mapping, current_node: "a2" }).prompt === PROMPT);
  check("recognised as a conversation, not a stream", isConversationJson(JSON.stringify(c), `https://chatgpt.com/backend-api/conversations/${ID}`) && !isConversationJson("data: {}", `https://chatgpt.com/backend-api/conversations/${ID}`));
  const r = await adapt({ captureId: "t", raw: JSON.stringify(c), reqBody: null, url: `https://chatgpt.com/backend-api/conversations/${ID}`, pageUrl: `https://chatgpt.com/c/${ID}`, capturedAt: Date.now() });
  check("read by the ChatGPT adapter: prompt and answer", r && r.userPrompt === PROMPT && /\*\*Zento Linen\*\*/.test(r.answerText || ""), r && JSON.stringify({ p: r.userPrompt, a: (r.answerText || "").slice(0, 60) }));
  check("its brands", r && ["Zento", "Kovo", "Lumora"].every((b) => (r.brandMentions || []).some((m) => m.brand.startsWith(b))), r && (r.brandMentions || []).map((m) => m.brand).join(", "));
  check("its source and search", r && (r.sources || []).some((s) => s.domain === "stylelab.example") && JSON.stringify(r.fanout || r.queryFanout || {}).includes("best linen shirts summer"));
  check("a turn as stream lines ends with [DONE]", /data: \[DONE\]\s*$/.test(turnAsCapture(c).raw));
}

console.log("\nno sign-in token, by construction");
{
  const { readFileSync } = await import("node:fs");
  const iso = readFileSync(path.join(EXT_PATH, "src/content-iso.js"), "utf8");
  const bg = readFileSync(path.join(EXT_PATH, "src/background.js"), "utf8");
  const conv = readFileSync(path.join(EXT_PATH, "src/lib/chatgptConversation.js"), "utf8");
  // Code only: comments (which say there is no token) are taken out first.
  const code = iso.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the page scripts never reach for a session token", !/api\/auth\/session|accessToken|access_token|authorization/i.test(code));
  check("nor does the conversation reader", !/api\/auth\/session|accessToken|access_token/i.test(conv.replace(/Authorization header[^.]*\./gi, "")));
  check("the worker doesn't fetch ChatGPT itself", !/fetch\([^)]*chatgpt\.com\/(?:backend-api|api)/.test(bg));
}

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log(`\nchatgpt-conversation-read: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// The page: a composer; on Enter it "sends" with an iframe's fetch (out of the
// extension's hook) and draws the answer in plain divs, no known markers.
const PAGE = () => `<!doctype html><html${idsInPage ? ` data-theme-account-id="${ACCOUNT}"` : ""}><body>${idsInPage ? `<script>window.__boot = "{\\"user\\":{\\"customIDs\\":{\\"DeviceId\\":\\"${DEVICE}\\"}}}";</script>` : ""}
  <div id="thread"></div>
  <div data-composer-body=""><textarea id="pending-conversation-input" aria-label="Ask ChatGPT"></textarea></div>
  <script>
    const frame = document.createElement('iframe'); frame.style.display = 'none'; document.body.appendChild(frame);
    const hiddenFetch = frame.contentWindow.fetch.bind(frame.contentWindow);
    const box = document.getElementById('pending-conversation-input');
    box.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = box.value.trim(); if (!q) return; box.value = '';
      await hiddenFetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ q }) });
      const t = document.getElementById('thread');
      const u = document.createElement('div'); u.textContent = q; t.appendChild(u);
      const a = document.createElement('div'); a.textContent = 'For hot days, Zento Linen is the pick.'; setTimeout(() => t.appendChild(a), 2000);
    });
  </script></body></html>`;

const DEVICE = "7c1d2e3f-0a1b-4c5d-8e9f-a0b1c2d3e4f5", ACCOUNT = "bdf806ad-e7e1-4a2b-9c3d-4e5f6a7b8c9d";
let lastQ = PROMPT, refuseIds = false, bareReads = 0, idsInPage = false, notFound = 0;
let askedAt = 0, convReads = 0, convUnauthorized = 0, sessionReads = 0, authHeaders = 0;
const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.addCookies([
    { name: "oai-did", value: DEVICE, url: "https://chatgpt.com/" },
    { name: "_account", value: ACCOUNT, url: "https://chatgpt.com/" },
    { name: "session-cookie", value: "made-up", url: "https://chatgpt.com/", httpOnly: true },
  ]);
  await context.route(/^https:\/\/chatgpt\.com\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === "/backend-api/f/conversation") { askedAt = Date.now(); try { lastQ = JSON.parse(req.postData() || "{}").q || lastQ; } catch (_) { /* keep */ } return route.fulfill({ status: 200, contentType: "text/event-stream", body: "data: [DONE]\n\n" }); }
    if (u.pathname === "/api/auth/session") { sessionReads++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accessToken: "must-never-be-asked-for" }) }); }
    if (/^\/backend-api\/conversations?\//.test(u.pathname)) {
      const hd = req.headers();
      if (hd.authorization) authHeaders++;
      // A ChatGPT that doesn't take the identifiers: refused, then cookies alone.
      if (refuseIds && (hd["oai-device-id"] || hd["chatgpt-account-id"])) { convUnauthorized++; return route.fulfill({ status: 400, contentType: "application/json", body: '{"detail":"bad request"}' }); }
      if (refuseIds && /session-cookie=made-up/.test(hd.cookie || "")) {
        bareReads++; convReads++;
        const done0 = askedAt && Date.now() - askedAt > 7000;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conversation(askedAt || Date.now(), done0, lastQ, "Cheapest is the **Lumora** shirt.\n\n- **Lumora**: the budget choice.\n- **Kovo Weave**: pricier.")) });
      }
      // The owner's browser of 16 Nov 2026: no identifier cookies, and a
      // read without the identifiers is "not found".
      if (idsInPage && (hd["oai-device-id"] !== DEVICE || hd["chatgpt-account-id"] !== ACCOUNT)) { notFound++; return route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Conversation not found"}' }); }
      // As ChatGPT answers its own page: the cookies, and the device and
      // account identifiers the page sends.
      if (hd["oai-device-id"] !== DEVICE || hd["chatgpt-account-id"] !== ACCOUNT || !/session-cookie=made-up/.test(hd.cookie || "")) { convUnauthorized++; return route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"Unauthorized"}' }); }
      convReads++;
      const done = askedAt && Date.now() - askedAt > 7000;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(conversation(askedAt || Date.now(), done, lastQ)) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: PAGE() });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.waitForTimeout(1000);
  const ask = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const records = async () => ((((await ask({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "chatgpt" && !String(r.captureId).startsWith("demo-")));

  console.log("\n3. an old conversation opened, nothing asked");
  const old = await context.newPage();
  await old.goto(`https://chatgpt.com/c/${ID}`);
  await old.waitForTimeout(12000);
  check("the conversation is never read", convReads === 0 && convUnauthorized === 0 && sessionReads === 0, JSON.stringify({ convReads, convUnauthorized, sessionReads }));
  check("nothing recorded", (await records()).length === 0);

  console.log("\n2. a question asked in the tab");
  await old.click("#pending-conversation-input");
  await old.keyboard.type(PROMPT);
  await old.keyboard.press("Enter");
  let recs = [];
  for (let i = 0; i < 60 && !recs.length; i++) { await old.waitForTimeout(500); recs = await records(); }
  check("recorded", recs.length === 1, `${recs.length} records`);
  check("asked the way the page asks: cookies and its two identifiers, accepted first time", convUnauthorized === 0 && convReads >= 1, JSON.stringify({ convUnauthorized, convReads }));
  check("no sign-in token asked for, read or sent", sessionReads === 0 && authHeaders === 0, JSON.stringify({ sessionReads, authHeaders }));
  check("read again until the answer was finished, then no more", convReads >= 2 && convReads <= 4, String(convReads));
  const r = recs[0];
  if (r) {
    const full = ((await ask({ type: "get-record", captureId: r.captureId })) || {}).record || r;
    check("with the question", full.userPrompt === PROMPT, JSON.stringify(full.userPrompt));
    check("the whole answer, not what the page showed", /\*\*Zento Linen\*\*/.test(full.answerText || "") && /Lumora/.test(full.answerText || ""), (full.answerText || "").slice(0, 80));
    check("its brands and source", ["Zento", "Kovo", "Lumora"].every((b) => (full.brandMentions || []).some((m) => m.brand.startsWith(b))) && (full.sources || []).some((s) => s.domain === "stylelab.example"), (full.brandMentions || []).map((m) => m.brand).join(", "));
  }
  const before = convReads;
  await old.waitForTimeout(9000);
  check("and the tab stops asking afterwards", convReads === before, `${convReads - before} more reads`);
  console.log("\n4. ChatGPT refuses the identifiers: the read is made again with cookies alone");
  refuseIds = true;
  const unauthBefore = convUnauthorized;
  await old.click("#pending-conversation-input");
  await old.keyboard.type("which linen shirt is cheapest");
  await old.keyboard.press("Enter");
  let recs4 = recs;
  for (let i = 0; i < 70 && recs4.length < 2; i++) { await old.waitForTimeout(500); recs4 = await records(); }
  check("recorded all the same", recs4.length === 2, `${recs4.length} records`);
  check("with the second question", recs4.some((x) => x.userPrompt === "which linen shirt is cheapest"), recs4.map((x) => x.userPrompt).join(" | "));
  check("the identifiers were refused once, then cookies alone were accepted", convUnauthorized > unauthBefore && bareReads >= 1, JSON.stringify({ refused: convUnauthorized - unauthBefore, bareReads }));
  check("still no token, ever", sessionReads === 0 && authHeaders === 0);
  const rep = ((await ask({ type: "capture-check" })) || {}).report || "";
  check("the report says it was read from the conversation", /read from the conversation/.test(rep) && /conversation read: ok/.test(rep), rep.split("\n").find((l) => /page copy/.test(l)) || rep.slice(0, 300));

  console.log("\n5. no identifier cookies: the identifiers are read off the page (16 Nov 2026)");
  refuseIds = false; idsInPage = true;
  await context.clearCookies();
  await context.addCookies([{ name: "session-cookie", value: "made-up", url: "https://chatgpt.com/", httpOnly: true }]);
  const p5 = await context.newPage();
  await p5.goto(`https://chatgpt.com/c/${ID}`);
  await p5.waitForTimeout(1500);
  const before5 = (await records()).length, nf = notFound;
  await p5.click("#pending-conversation-input");
  await p5.keyboard.type("which linen shirt lasts longest");
  await p5.keyboard.press("Enter");
  let recs5 = [];
  for (let i = 0; i < 70 && recs5.length <= before5; i++) { await p5.waitForTimeout(500); recs5 = await records(); }
  check("recorded", recs5.some((x) => x.userPrompt === "which linen shirt lasts longest"), recs5.map((x) => x.userPrompt).join(" | "));
  check("asked with the page's own identifiers: never 'not found'", notFound === nf, `${notFound - nf} not-found replies`);
  check("still no token", sessionReads === 0 && authHeaders === 0);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
