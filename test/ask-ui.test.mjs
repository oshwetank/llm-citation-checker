/*
 * Ask, in the full tab (0.73.0). Run: node test/ask-ui.test.mjs
 *
 * The built-in model is a stand-in served from this computer, with a script
 * of replies: first a tool call in Qwen's format, then the answer. The tool
 * itself runs for real over the captures, so the links under the answer are
 * the answers it found.
 */
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const MODEL_DIR = path.join(HERE, "fixtures", "llm-tiny");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-ask-ui-test";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) { console.log(`\nask-ui: CANNOT RUN — ${err.message}`); process.exit(1); }

const server = http.createServer((req, res) => {
  const m = /^\/tiny\/resolve\/main\/(.+)$/.exec(decodeURIComponent(req.url.split("?")[0]));
  const file = m && path.join(MODEL_DIR, m[1]);
  const headers = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length" };
  if (!file || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end(); }
  const body = readFileSync(file);
  res.writeHead(200, { ...headers, "content-length": body.length }); res.end(req.method === "HEAD" ? undefined : body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${server.address().port}/`;
const fixture = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};
// 1.0.5: the model only writes the reply, from results worked out in code,
// in one turn. 87% is made up: no result holds it, so it is flagged.
// First the plan for what the rules left open ("Where was Zento named?" has
// no question word a rule knows), then the reply.
const SCRIPT = [
  '{"intent":"metric","collections":[]}',
  "Zento was named in the answers below, first in each, with 87% visibility.",
];

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false, args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  for (const f of ["chatgpt-genui-cards.txt", "chatgpt-genui-entity-cards.txt"]) {
    const { raw, reqBody } = fixture(f);
    await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  }
  const openAsk = async () => { await page.evaluate(() => document.querySelector('[data-tab="ask"]').click()); await page.waitForTimeout(700); };

  console.log("\nthe Ask tab");
  {
    const vis = await page.evaluate(() => { const b = document.querySelector('[data-tab="ask"]'); return b && getComputedStyle(b).display !== "none"; });
    check("in the full tab's menu", vis);
    await openAsk();
    await page.waitForSelector("#swAskModel", { timeout: 10000 }).catch(() => {});
    const t = await page.evaluate(() => document.getElementById("ask").innerText);
    check("without a model, Ask offers the switches right there (0.84.0)", /Models on this computer/.test(t) && !!(await page.$("#swAskModel")) && !!(await page.$("#swLaya")), t.slice(0, 300));
    check("each says its size, and that uninstalling removes it", /download, once/.test(t) && /Uninstalling CitoSkeleton removes them/.test(t));
  }

  console.log("\nasking with no model (1.0.5): answered from the data, its scope shown");
  {
    check("the chat is there without a model", !!(await page.$("#askInput")) && !!(await page.$("#askOffNote")));
    await page.fill("#askInput", "Which brands are named most?");
    await page.click("#askSend");
    await page.waitForFunction(() => document.querySelectorAll(".ask-msg.ai").length > 0, null, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate(() => ({ text: document.querySelector(".ask-msg.ai .ask-text")?.textContent || "", scope: [...document.querySelectorAll(".ask-msg.ai .ask-scope .ask-scope-chip")].map((x) => x.tagName === "SELECT" ? x.selectedOptions[0]?.textContent : x.textContent), n: document.querySelector(".ask-msg.ai .ask-scope-n")?.textContent || "" }));
    check("a reply from the numbers, naming brands", /named in/.test(r.text) && /%/.test(r.text), r.text.slice(0, 200));
    check("the scope above it: My questions, the run, the engines", r.scope.includes("My questions") && r.scope.some((x) => /engines/.test(x)) && /answers/.test(r.n), JSON.stringify(r));
    // A chip changes the scope and runs the same question again.
    await page.evaluate(() => { const s = [...document.querySelectorAll(".ask-msg.ai .ask-scope select")].find((x) => [...x.options].some((o) => o.textContent === "ChatGPT")); s.value = JSON.stringify(["chatgpt"]); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => document.querySelectorAll(".ask-msg.ai").length > 1, null, { timeout: 20000 }).catch(() => {});
    const two = await page.evaluate(() => [...document.querySelectorAll(".ask-msg.ai")].pop().querySelector(".ask-scope")?.innerText || "");
    check("changing the engine chip answers again for ChatGPT only", /ChatGPT/.test(two), two);
    await page.click("#askClear");
    await page.waitForTimeout(300);
  }

  console.log("\nasking, with the built-in AI");
  {
    await msg({ type: "ai-test-model", model: { repo: "tiny", host: HOST, dtype: "fp32", script: SCRIPT } });
    await openAsk();
    await page.waitForSelector("#swAskModel", { timeout: 10000 }).catch(() => {});
    // Turned on in Ask, the way a new user would.
    await page.evaluate(() => { const i = document.getElementById("swAskModel"); i.checked = true; i.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 120; i++) { const s = await msg({ type: "ai-status" }); if (s.ready || s.error) break; await page.waitForTimeout(500); }
    check("the switch downloaded it", (await msg({ type: "ai-status" })).ready);
    await page.waitForSelector(".ask-chip", { timeout: 10000 }).catch(() => {});
    check("and Ask turned into the chat by itself", (await page.$$(".ask-chip")).length === 4);
    await openAsk();
    check("suggested questions are offered", (await page.$$(".ask-chip")).length === 4);
    // A chat (0.78.0): the box at the bottom, the conversation above it.
    const lay = await page.evaluate(() => {
      const f = document.querySelector(".ask-form").getBoundingClientRect(), l = document.getElementById("askLog").getBoundingClientRect();
      return { formBottom: Math.round(f.bottom), vh: innerHeight, logAbove: l.bottom <= f.top + 1, sugInLog: !!document.querySelector("#askLog .ask-chip"), newChat: document.getElementById("askClear")?.textContent };
    });
    check("the box to type in is at the bottom of the page, the conversation above it", lay.formBottom > lay.vh - 140 && lay.formBottom <= lay.vh && lay.logAbove, JSON.stringify(lay));
    check("suggestions sit in the empty chat; New chat starts over", lay.sugInLog && lay.newChat === "New chat", JSON.stringify(lay));
    await page.fill("#askInput", "Where was Zento named?");
    // The stand-in model can answer within a frame, so the bubble is caught
    // as it appears rather than looked for afterwards.
    await page.evaluate(() => {
      window.__typingShown = false;
      const t = document.getElementById("askTyping");
      new MutationObserver(() => { if (!t.hidden) window.__typingShown = true; }).observe(t, { attributes: true, attributeFilter: ["hidden"] });
    });
    await page.click("#askSend");
    await page.waitForFunction(() => document.querySelectorAll(".ask-msg.ai").length > 0, null, { timeout: 30000 }).catch(() => {});
    const r = await page.evaluate(() => ({ you: [...document.querySelectorAll(".ask-msg.you .ask-text")].map((x) => x.textContent), ai: [...document.querySelectorAll(".ask-msg.ai .ask-text")].map((x) => x.textContent), refs: [...document.querySelectorAll(".ask-ref")].map((x) => x.textContent) }));
    check("the question, then the answer", r.you[0] === "Where was Zento named?" && /Zento was named/.test(r.ai[0] || ""), JSON.stringify(r));
    check("a bubble said it was working", await page.evaluate(() => window.__typingShown === true));
    const chat = await page.evaluate(() => ({ who: [...document.querySelectorAll(".ask-msg .ask-meta b")].map((b) => b.textContent), typing: document.getElementById("askTyping").hidden, sug: !!document.querySelector("#askLog .ask-chip") }));
    check("each bubble says who; the working bubble has gone; no suggestions once chatting", chat.who.join("|") === "You|CitoSkeleton" && chat.typing && !chat.sug, JSON.stringify(chat));
    const flag = await page.evaluate(() => document.querySelector(".ask-msg.ai .ask-unverified")?.textContent || "");
    check("a number no lookup returned is flagged under the answer", /87/.test(flag) && /check these numbers/i.test(flag), flag);
    check("links to the answers the tool found", r.refs.length >= 1 && r.refs.every((x) => /^ChatGPT · /.test(x)), JSON.stringify(r.refs));
    check("and says what it is about", await page.evaluate(() => /My questions/.test(document.querySelector(".ask-msg.ai .ask-scope")?.innerText || "")));
    await page.click(".ask-ref");
    await page.waitForSelector("#at-glance", { timeout: 10000 }).catch(() => {});
    check("a link opens that answer in Analyze", await page.evaluate(() => document.querySelector('[data-tab="analyze"]').classList.contains("active") && !!document.getElementById("at-glance")));
  }

  console.log("\nthe conversation is kept");
  {
    await page.reload(); await page.waitForTimeout(800);
    await openAsk();
    const n = await page.evaluate(() => document.querySelectorAll(".ask-msg").length);
    check("after a reload", n === 2, String(n));
    await page.click("#askClear");
    await page.waitForTimeout(300);
    check("and cleared on request", await page.evaluate(() => document.querySelectorAll(".ask-msg").length === 0));
  }

  console.log("\nthe popup");
  {
    await page.setViewportSize({ width: 540, height: 600 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html`);
    await page.waitForTimeout(800);
    // 0.84.0: Ask is in the popup too, where new users are.
    check("has the Ask tab", await page.evaluate(() => { const b = document.querySelector('[data-tab="ask"]'); return !!b && getComputedStyle(b).display !== "none"; }));
    await page.evaluate(() => document.querySelector('[data-tab="ask"]').click());
    await page.waitForSelector("#askInput, .ask-input", { timeout: 8000 }).catch(() => {});
    check("and its chat fits: the box to type in is on screen", await page.evaluate(() => { const i = document.querySelector("#askInput, .ask-chat .ask-input"); if (!i) return false; const r = i.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0 && r.width > 200; }));
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally { await context.close(); server.close(); }

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
