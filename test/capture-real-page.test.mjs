/*
 * capture-real-page.test.mjs — a question asked by hand on ChatGPT reaches
 * the store, through the page's own requests (0.73.1).
 *
 * The owner: "the tool is not able to get the data of prompt which i add on
 * my chatgpt … nothing appears at all". Every other capture test hands the
 * worker a payload directly or serves a page that never touches <html>; a
 * real ChatGPT page is a React app. Each case here is a page on chatgpt.com
 * (served locally, made-up Zento/Kovo answer) making the request the way the
 * real one might, and must end as a stored answer:
 *   1. the page rebuilds <html> after loading, wiping our marker;
 *   2. the answer comes on a resume stream, read with GET;
 *   3. the answer comes on an address the capture doesn't know;
 *   4. the stream carries a keep-alive ping frame.
 * Then the capture check: ChatGPT reads "ok", the open tab is connected with
 * its marker, the unfamiliar address is named, and pausing shows as the cause.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-capture-real-page-test";

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
  console.log(`\ncapture-real-page: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const fx = readFileSync(path.join(HERE, "fixtures", "chatgpt-genui-cards.txt"), "utf8").split(/\r?\n/);
const REQ = (fx.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "");
const SSE = fx.filter((l) => !l.startsWith("# ")).join("\n");
// A keep-alive frame in compact JSON, as a server may send between events.
const SSE_PING = SSE.replace(/\n\n/, '\n\ndata: {"type":"ping"}\n\n');

// The page: loads, then (like a React app re-rendering the document) strips
// every attribute from <html>, then asks its question.
const page = (endpoint, method, { wipe = true } = {}) => `<!doctype html><html lang="en"><body>stub<script>
  (async () => {
    await new Promise((r) => setTimeout(r, 300));
    ${wipe ? `for (const a of [...document.documentElement.attributes]) document.documentElement.removeAttribute(a.name);` : ""}
    await new Promise((r) => setTimeout(r, 200));
    try { new WebSocket("wss://chatgpt.com/backend-api/live/ws"); } catch (_) {}
    const res = await fetch(${JSON.stringify(endpoint)}, ${method === "GET" ? `{ method: "GET" }` : `{ method: "POST", headers: { "content-type": "application/json" }, body: new Blob([${JSON.stringify(REQ)}], { type: "application/json" }) }`});
    await res.text();
    document.title = "done";
  })();
</script></body></html>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
let current = { endpoint: "", method: "POST", body: SSE, wipe: true };
try {
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/backend-") || u.pathname.startsWith("/unauth-")) {
      // A new conversation and message ids each time, so each case is its
      // own answer rather than a copy folded into the one before.
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: current.body.replace(/\b[0-9a-f]{8}-(?=[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/g, `${current.salt}-`) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: page(current.endpoint, current.method, current) });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(String(e)));
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await tab.waitForTimeout(800);
  const msg = (m) => tab.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const chatgptRecords = async () => ((((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "chatgpt" && !String(r.captureId).startsWith("demo-")));
  let engineTab = null;
  const ask = async (endpoint, method, opts = {}) => {
    current = { endpoint, method, body: opts.body || SSE, wipe: opts.wipe !== false, salt: Math.random().toString(16).slice(2, 10).padEnd(8, "0") };
    const before = (await chatgptRecords()).length;
    const g = await context.newPage();
    await g.goto(`https://chatgpt.com/c/${Math.random().toString(16).slice(2, 10)}`);
    await g.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
    let after = before;
    for (let i = 0; i < 20 && after <= before; i++) { await g.waitForTimeout(300); after = (await chatgptRecords()).length; }
    if (opts.keepOpen) engineTab = g; else await g.close();
    return after - before;
  };

  console.log("\n1. the page rebuilds <html> before asking");
  const n1 = await ask("/backend-api/f/conversation", "POST");
  check("the answer is stored", n1 >= 1, `${n1} new`);
  const recs = await chatgptRecords();
  check("with its prompt (sent as a Blob body)", recs.some((r) => /phone|camera|Zento|Kovo/i.test(r.userPrompt || "")), recs.map((r) => r.userPrompt).join(" | ").slice(0, 160));

  console.log("\n2. the answer on a resume stream, read with GET");
  check("stored", (await ask("/backend-api/f/conversation/resume", "GET")) >= 1);

  console.log("\n3. the answer on an address the capture doesn't know");
  check("stored anyway", (await ask("/backend-api/lightning/turn/stream", "POST")) >= 1);

  console.log("\n4. a keep-alive ping frame inside the stream");
  check("stored", (await ask("/backend-api/f/conversation", "POST", { body: SSE_PING, keepOpen: true })) >= 1);

  console.log("\nthe capture check");
  await tab.waitForTimeout(500);
  const c = await msg({ type: "capture-check" });
  const g = (c.engines || []).find((e) => e.engine === "chatgpt") || {};
  check("ChatGPT reads ok", g.status === "ok", JSON.stringify(g));
  const t = (c.tabs || []).find((x) => x.engine === "chatgpt");
  check("the open ChatGPT tab is connected, with its marker, and saw the request", t && t.alive && t.marker && t.conv >= 1, JSON.stringify(t));
  check("the unfamiliar address is named in the report", /stream taken \(unfamiliar address\): POST \/backend-api\/lightning\/turn\/stream/.test(c.report || ""), (c.report || "").slice(0, 600));
  check("a live socket the capture doesn't read is named", /live socket not read: WS \/backend-api\/live\/ws/.test(c.report || ""), (c.report || "").slice(0, 900));
  check("the report has no prompt or answer text", !/Zento|Kovo|Lumora/.test(c.report || ""));
  check("counts: answers asked by hand", c.counts && c.counts.manual >= 4, JSON.stringify(c.counts));

  // In the panel.
  await tab.evaluate(() => { document.querySelector('[data-tab="about"]')?.click(); });
  await tab.waitForTimeout(500);
  await tab.evaluate(() => { [...document.querySelectorAll(".ab-nav-btn")].find((b) => /Diagnostics/.test(b.textContent))?.click(); });
  await tab.waitForTimeout(1200);
  const ui = await tab.evaluate(() => [...document.querySelectorAll("#capCheckRows .cap-row")].map((r) => `${r.dataset.engine}:${r.className}:${r.textContent.trim().slice(0, 60)}`));
  check("About → Diagnostics shows a row per engine, ChatGPT ok", ui.length === 5 && ui.some((x) => /^chatgpt:cap-row ok/.test(x)), ui.join(" | "));

  console.log("\npaused, the check says so");
  await msg({ type: "settings-set", patch: { capturePaused: true } });
  const n5 = await ask("/backend-api/f/conversation", "POST");
  const c2 = await msg({ type: "capture-check" });
  const g2 = (c2.engines || []).find((e) => e.engine === "chatgpt") || {};
  check("nothing stored while paused", n5 === 0);
  check("the check names the pause", g2.status === "bad" && /paused/i.test(g2.line), JSON.stringify(g2));
  await msg({ type: "settings-set", patch: { capturePaused: false } });

  check("no page errors", errors.length === 0, errors.join(" | "));
  if (engineTab) await engineTab.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
