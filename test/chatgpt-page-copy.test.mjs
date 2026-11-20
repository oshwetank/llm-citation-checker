/*
 * chatgpt-page-copy.test.mjs — a ChatGPT answer the network capture can't
 * see is read off the page (0.79.0).
 *
 * The owner's 0.78.1 network report from a ChatGPT + Gemini campaign: on
 * chatgpt.com no conversation request was seen at all, only a WebSocket to
 * ws.chatgpt.com per prompt. ChatGPT's turns timed out ("sent, no answer
 * captured") while Gemini's were captured. A stub ChatGPT page here answers
 * the same way, with nothing on the network the page script can read: the
 * answer appears on the page (made-up Zento/Kovo answer with links), a stop
 * button shows while it "writes".
 *   1. a campaign turn completes with the answer, its prompt and its links;
 *   2. a question asked by hand (Enter in the composer) is captured too;
 *   3. an old conversation merely opened is never copied;
 *   4. (1.0.0) the owner's 12 Nov 2026 recording: ChatGPT now sends with a
 *      POST to conversation/prepare ("client_prepare_state":"sent") and the
 *      answer comes over its WebSocket. Asked with a Send button the
 *      extension doesn't recognise, in a conversation that already has an
 *      answer, the new answer is still copied, on that request alone; a
 *      prepare sent while typing ("typing") starts nothing;
 *   5. (1.0.0) ChatGPT's composer as the owner's recording has it: a
 *      textarea inside [data-composer-body], no <form>, and prepare sent as
 *      a Request object. Enter is enough, and the capture report says how far
 *      the page copy got;
 *   6. (1.0.0) the owner's capture report of 13 Nov 2026 ("0 questions, 0
 *      answers on the page") and ChatGPT's own page code: the thread is
 *      virtualized into div[data-turn-key] turns, each with a hidden "You
 *      said:" / "ChatGPT said:" heading (data-conversation-role), buttons
 *      inside, and no data-message-author-role anywhere. The answer is still
 *      copied, without the headings or buttons in it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-chatgpt-page-copy-test";
const PROMPT = "best linen shirt brands for a hot summer";

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
  console.log(`\nchatgpt-page-copy: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// The page writes its answer in pieces over ~3 s with a stop button showing,
// then removes the button. `old` pages open with a finished conversation.
const PAGE = (old) => `<body>
  <div id="convo">${old ? `<div data-message-author-role="user">an older question about kettles</div>
    <div data-message-author-role="assistant"><p><strong>Lumora Kettle</strong> is the pick, says <a href="https://kitchenlab.example/kettles">KitchenLab</a>, and it boils fast enough for most homes.</p></div>` : ""}</div>
  <div id="prompt-textarea" contenteditable="true"></div>
  <button id="composer-submit-button">send</button>
  <button id="go" aria-label="Go">→</button>
  <script>
    const box = document.getElementById('prompt-textarea');
    const prepare = (state) => fetch('/backend-api/f/conversation/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_prepare_state: state, action: 'next', model: 'gpt-x' }) }).catch(() => {});
    box.addEventListener('input', () => prepare('typing'));
    const send = () => {
      const t = box.innerText.trim(); if (!t) return;
      box.innerHTML = '';
      prepare('sent');
      const u = document.createElement('div'); u.setAttribute('data-message-author-role', 'user');
      u.textContent = t; document.getElementById('convo').appendChild(u);
      const stop = document.createElement('button'); stop.setAttribute('data-testid', 'stop-button'); stop.textContent = 'stop';
      document.body.appendChild(stop);
      const a = document.createElement('div'); a.setAttribute('data-message-author-role', 'assistant');
      document.getElementById('convo').appendChild(a);
      const parts = [
        '<p><strong>Zento Linen</strong> is the pick for hot days: breathable and well cut.</p>',
        '<ul><li><strong>Kovo Weave</strong>: softer, a little pricier (<a href="https://stylelab.example/linen-shirts">StyleLab</a>).</li>',
        '<li><strong>Lumora</strong>: the budget choice (<a href="https://fabricdesk.example/lumora-review">FabricDesk</a>).</li></ul>',
      ];
      let i = 0;
      const step = () => { a.innerHTML += parts[i++]; if (i < parts.length) setTimeout(step, 1000); else setTimeout(() => stop.remove(), 800); };
      setTimeout(step, 500);
    };
    document.getElementById('composer-submit-button').addEventListener('click', send);
    document.getElementById('go').addEventListener('click', send);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  </script></body>`;

// The composer as chatgpt.com served it on 12 Nov 2026: a textarea in
// [data-composer-body], no form, no #prompt-textarea; prepare as a Request.
const PAGE_NOV = () => PAGE(false)
  .replace('<div id="prompt-textarea" contenteditable="true"></div>', '<div data-composer-body=""><textarea id="pending-conversation-input" aria-label="Ask ChatGPT"></textarea></div>')
  .replace("const box = document.getElementById('prompt-textarea');", "const box = document.getElementById('pending-conversation-input'); Object.defineProperty(box, 'innerText', { get() { return box.value; }, set(v) { box.value = v; } }); Object.defineProperty(box, 'innerHTML', { set(v) { box.value = ''; } });")
  .replace("const prepare = (state) => fetch('/backend-api/f/conversation/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_prepare_state: state, action: 'next', model: 'gpt-x' }) }).catch(() => {});",
    "const prepare = (state) => fetch(new Request('/backend-api/f/conversation/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_prepare_state: state, action: 'next', model: 'gpt-x' }) })).catch(() => {});");

// The thread as ChatGPT drew it in Nov 2026: virtualized turns, no author-role wrapper.
const PAGE_VIRT = () => PAGE_NOV()
  .replace("u.setAttribute('data-message-author-role', 'user');\n      u.textContent = t; document.getElementById('convo').appendChild(u);",
    "u.setAttribute('data-turn-key', 'turn-u' + Date.now()); u.innerHTML = '<div data-virtualized-turn-content=\"\"><h4 class=\"sr-only\" data-conversation-role=\"user\">You said:</h4><div class=\"whitespace-pre-wrap\"></div></div>'; u.querySelector('.whitespace-pre-wrap').textContent = t; document.getElementById('convo').appendChild(u);")
  .replace("a.setAttribute('data-message-author-role', 'assistant');\n      document.getElementById('convo').appendChild(a);",
    "a.setAttribute('data-turn-key', 'turn-a' + Date.now()); a.innerHTML = '<div data-virtualized-turn-content=\"\"><h4 class=\"sr-only\" data-conversation-role=\"assistant\" tabindex=\"-1\">ChatGPT said:</h4><div class=\"markdown\"></div><button aria-label=\"Copy\">Copy</button><span data-markdown-copy=\"exclude\">Good response</span></div>'; document.getElementById('convo').appendChild(a);")
  .replace("a.innerHTML += parts[i++];", "a.querySelector('.markdown').innerHTML += parts[i++];");

// 16 Nov 2026: the question and the answer in ONE turn (the owner's report:
// "turns 1 · role headings 2", page copy gave up after 6 minutes).
const PAGE_ONETURN = () => PAGE_VIRT()
  .replace("a.setAttribute('data-turn-key', 'turn-a' + Date.now()); ", "")
  .replace("Good response</span></div>'; document.getElementById('convo').appendChild(a);", "Good response</span></div>'; [...document.querySelectorAll('[data-turn-key]')].pop().appendChild(a);");

// ChatGPT's card answer (16 Nov 2026): the number and the name bold apart,
// the price in a heading. Stored as "**1.****Titan Eye+**" and "# **₹…**".
const PAGE_CARDS = () => PAGE_ONETURN().replace(/const parts = \[[\s\S]*?\];/, `const parts = [
        '<h2><strong>Best optical stores</strong></h2><p><strong>1.</strong><strong>Titan Eye+</strong><strong>&ndash; Bandra West</strong></p>',
        '<ul><li>Large collection of branded frames</li></ul><h1><strong>&#8377;1,999</strong></h1>',
        '<p><strong>2.</strong><strong>Zento Optics</strong></p><ul><li>Budget-friendly options and quick eye tests near the station.</li></ul>',
      ];`);

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/conversation/prepare")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", conduit_token: "made-up" }) });
    if (u.pathname.startsWith("/c/cards")) return route.fulfill({ status: 200, contentType: "text/html", body: PAGE_CARDS() });
    if (u.pathname.startsWith("/c/oneturn")) return route.fulfill({ status: 200, contentType: "text/html", body: PAGE_ONETURN() });
    if (u.pathname.startsWith("/c/virt")) return route.fulfill({ status: 200, contentType: "text/html", body: PAGE_VIRT() });
    if (u.pathname.startsWith("/c/nov")) return route.fulfill({ status: 200, contentType: "text/html", body: PAGE_NOV() });
    return route.fulfill({ status: 200, contentType: "text/html", body: PAGE(u.pathname.startsWith("/c/old")) });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(1000);
  const ask = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const records = async () => ((((await ask({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "chatgpt" && !String(r.captureId).startsWith("demo-")));

  console.log("\n1. a campaign turn");
  const profileId = await page.evaluate(async (text) => {
    const dbh = await new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const put = (store, v) => new Promise((res, rej) => { const r = dbh.transaction(store, "readwrite").objectStore(store).put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
    const id = crypto.randomUUID();
    await put("profiles", { id, name: "Page Copy Test", brand: { name: "Zento", url: "zento.example" }, competitors: [{ name: "Kovo" }], engines: ["chatgpt"], locked: true, createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    return id;
  }, PROMPT);
  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));
  let ok = null, failed = null;
  const deadline = Date.now() + 80000;
  while (!ok && !failed && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const entries = ((await ask({ type: "error-log", limit: 100 })) || {}).entries || [];
    ok = entries.find((e) => e.where === "run:turn:chatgpt" && e.message === "ok") || null;
    failed = entries.find((e) => e.where === "run:turn-failed:chatgpt") || null;
  }
  await ask({ type: "loader-stop" });
  check("the turn completed, not timed out", !!ok && !failed, failed ? failed.message : "no answered turn in 80 s");
  check("well before the 90 s watchdog", !!ok && ok.context.elapsedMs < 30000, ok && ok.context.elapsedMs);
  const recs = await records();
  const r = recs.find((x) => x.userPrompt === PROMPT);
  check("stored with its prompt", !!r, recs.map((x) => x.userPrompt).join(" | "));
  if (r) {
    const full = ((await ask({ type: "get-record", captureId: r.captureId })) || {}).record || r;
    check("the answer as markdown, structure kept", /\*\*Zento Linen\*\*/.test(full.answerText || "") && /Lumora/.test(full.answerText || ""), (full.answerText || "").slice(0, 160));
    check("its links are its cited sources", (full.sources || []).filter((s) => s.outcome === "cited").map((s) => s.domain).sort().join(",") === "fabricdesk.example,stylelab.example", JSON.stringify((full.sources || []).map((s) => s.url)));
    const named = (full.brandMentions || []).map((b) => b.brand);
    check("brands named in it", named.some((b) => /^Zento/.test(b)) && named.some((b) => /^Kovo/.test(b)), named.join(", "));
    check("marked as read off the page", full.platformSpecific && full.platformSpecific.transport === "page-copy" && full.platformSpecific.pageCopy === true, JSON.stringify(full.platformSpecific));
    check("filed under the campaign", full.geo && full.geo.profileId === profileId);
  }

  console.log("\n2. a question asked by hand");
  const before = (await records()).length;
  const g = await context.newPage();
  await g.goto("https://chatgpt.com/");
  await g.waitForTimeout(1500);
  await g.click("#prompt-textarea");
  await g.keyboard.type("which linen shirt lasts longest");
  await g.keyboard.press("Enter");
  let after = before;
  for (let i = 0; i < 40 && after <= before; i++) { await g.waitForTimeout(500); after = (await records()).length; }
  check("captured", after === before + 1, `${after - before} new`);
  const manual = (await records()).find((x) => x.userPrompt === "which linen shirt lasts longest");
  check("with the question typed", !!manual);
  await g.close();

  console.log("\n3. an old conversation opened, nothing asked");
  const before3 = (await records()).length;
  const o = await context.newPage();
  await o.goto("https://chatgpt.com/c/old-1");
  await o.waitForTimeout(12000);
  check("nothing copied", (await records()).length === before3);
  // Typing sends prepare with "typing": that is not a question going out.
  await o.click("#prompt-textarea");
  await o.keyboard.type("half a question");
  await o.waitForTimeout(9000);
  check("typing alone copies nothing", (await records()).length === before3);
  await o.close();

  console.log("\n4. ChatGPT's prepare send, a Send button we don't know, an answered conversation");
  const before4 = (await records()).length;
  const n = await context.newPage();
  await n.goto("https://chatgpt.com/c/old-2");
  await n.waitForTimeout(1500);
  await n.click("#prompt-textarea");
  await n.keyboard.type("which linen shirt dries fastest");
  await n.click("#go");
  let after4 = before4;
  for (let i = 0; i < 40 && after4 <= before4; i++) { await n.waitForTimeout(500); after4 = (await records()).length; }
  check("captured", after4 === before4 + 1, `${after4 - before4} new`);
  const viaPrepare = (await records()).find((x) => x.userPrompt === "which linen shirt dries fastest");
  check("the new question, not the old one", !!viaPrepare, (await records()).map((x) => x.userPrompt).join(" | "));
  if (viaPrepare) {
    const full = ((await ask({ type: "get-record", captureId: viaPrepare.captureId })) || {}).record || viaPrepare;
    check("with the new answer, not the kettle one", /Zento Linen/.test(full.answerText || "") && !/Lumora Kettle/.test(full.answerText || ""), (full.answerText || "").slice(0, 120));
  }
  await n.close();

  console.log("\n5. the November 2026 composer: a textarea, no form, prepare as a Request");
  const before5 = (await records()).length;
  const v = await context.newPage();
  await v.goto("https://chatgpt.com/c/nov-1");
  await v.waitForTimeout(1500);
  await v.click("#pending-conversation-input");
  await v.keyboard.type("which linen shirt wrinkles least");
  await v.keyboard.press("Enter");
  let after5 = before5;
  for (let i = 0; i < 40 && after5 <= before5; i++) { await v.waitForTimeout(500); after5 = (await records()).length; }
  check("captured", after5 === before5 + 1, `${after5 - before5} new`);
  check("with the question typed", !!(await records()).find((x) => x.userPrompt === "which linen shirt wrinkles least"));
  const rep5 = ((await ask({ type: "capture-check" })) || {}).report || "";
  const line = rep5.split("\n").find((l) => /page copy:/.test(l) && /sends seen: [1-9]/.test(l)) || "";
  check("the report has the send and the page copy's last step", /\(prepare\)/.test(line) && /"copied off the page"/.test(line) && /\d+ questions, \d+ answers/.test(line), line || rep5.slice(0, 400));
  await v.close();

  console.log("\n6. the virtualized thread (no author-role wrapper anywhere)");
  const before6 = (await records()).length;
  const w6 = await context.newPage();
  await w6.goto("https://chatgpt.com/c/virt-1");
  await w6.waitForTimeout(1500);
  const wrappers = await w6.evaluate(() => document.querySelectorAll("[data-message-author-role]").length);
  await w6.click("#pending-conversation-input");
  await w6.keyboard.type("which linen shirt is cheapest");
  await w6.keyboard.press("Enter");
  let after6 = before6;
  for (let i = 0; i < 40 && after6 <= before6; i++) { await w6.waitForTimeout(500); after6 = (await records()).length; }
  check("the page has no old wrapper (the test is honest)", wrappers === 0 && (await w6.evaluate(() => document.querySelectorAll("[data-turn-key]").length)) === 2);
  check("captured", after6 === before6 + 1, `${after6 - before6} new`);
  const virt = (await records()).find((x) => /cheapest/.test(x.userPrompt || ""));
  check("with the question typed, without the hidden heading", !!virt && virt.userPrompt === "which linen shirt is cheapest", virt && JSON.stringify(virt.userPrompt));
  if (virt) {
    const full = ((await ask({ type: "get-record", captureId: virt.captureId })) || {}).record || virt;
    check("the answer, with its structure and links", /\*\*Zento Linen\*\*/.test(full.answerText || "") && (full.sources || []).some((x) => /stylelab/.test(x.domain || "")), (full.answerText || "").slice(0, 100));
    check("no heading, button or feedback text in it", !/You said|ChatGPT said|Good response|\bCopy\b/.test(full.answerText || ""), (full.answerText || "").slice(0, 160));
  }
  const rep6 = ((await ask({ type: "capture-check" })) || {}).report || "";
  check("the report says what the page looks like", /page: old wrapper 0 · turns \d+ · role headings \d+/.test(rep6), rep6.split("\n").find((l) => /page copy/.test(l)) || rep6.slice(0, 300));
  await w6.close();

  console.log("\n7. the question and the answer in one turn (16 Nov 2026)");
  const before7 = (await records()).length;
  const w7 = await context.newPage();
  await w7.goto("https://chatgpt.com/c/oneturn-1");
  await w7.waitForTimeout(1500);
  await w7.click("#pending-conversation-input");
  await w7.keyboard.type("which linen shirt lasts longest");
  await w7.keyboard.press("Enter");
  let after7 = before7;
  for (let i = 0; i < 40 && after7 <= before7; i++) { await w7.waitForTimeout(500); after7 = (await records()).length; }
  const shape7 = await w7.evaluate(() => ({ turns: document.querySelectorAll("[data-turn-key]").length, heads: document.querySelectorAll("[data-conversation-role]").length }));
  check("one turn holds both headings (the test is honest)", shape7.turns === 1 && shape7.heads === 2, JSON.stringify(shape7));
  check("captured", after7 === before7 + 1, `${after7 - before7} new`);
  const one = (await records()).find((x) => /lasts longest/.test(x.userPrompt || ""));
  check("the question alone, not the answer with it", !!one && one.userPrompt === "which linen shirt lasts longest", one && JSON.stringify(one.userPrompt));
  if (one) {
    const full = ((await ask({ type: "get-record", captureId: one.captureId })) || {}).record || one;
    check("the answer alone, not the question with it", /\*\*Zento Linen\*\*/.test(full.answerText || "") && !/lasts longest|You said|ChatGPT said/.test(full.answerText || ""), (full.answerText || "").slice(0, 160));
  }
  await w7.close();

  console.log("\n8. a card answer: number and name bold apart, the price in a heading");
  const before8 = (await records()).length;
  const w8 = await context.newPage();
  await w8.goto("https://chatgpt.com/c/cards-1");
  await w8.waitForTimeout(1500);
  await w8.click("#pending-conversation-input");
  await w8.keyboard.type("best place to buy new glasses");
  await w8.keyboard.press("Enter");
  let after8 = before8;
  for (let i = 0; i < 40 && after8 <= before8; i++) { await w8.waitForTimeout(500); after8 = (await records()).length; }
  const cards = (await records()).find((x) => x.userPrompt === "best place to buy new glasses");
  check("captured", !!cards);
  if (cards) {
    const full = ((await ask({ type: "get-record", captureId: cards.captureId })) || {}).record || cards;
    const t = full.answerText || "";
    check("a numbered item, the bold runs apart", /^1\. \*\*Titan Eye\+\*\* \*\*– Bandra West\*\*$/m.test(t), t.split("\n").find((l) => /Titan/.test(l)));
    check("the price is a line, not a heading", /^₹1,999$/m.test(t) && !/^# /m.test(t), t.split("\n").find((l) => /1,999/.test(l)));
    const b = (full.brandMentions || []).map((m) => m.brand);
    check("the stores are its brands", b.includes("Titan Eye+") && b.some((x) => /^Zento/.test(x)), b.join(", "));
  }
  await w8.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
