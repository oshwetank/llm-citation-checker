/*
 * handoff-ui.test.mjs — "Continue in…": CitoSkeleton's data, the question and
 * the request go to another AI in one click (0.76.0).
 *
 * Each engine is a local stand-in page on its real address (served by the
 * test) with the kind of chat box that engine uses: ChatGPT a textarea,
 * Gemini a rich editor inside <rich-textarea>, Perplexity a textarea with a
 * Submit button, Grok and Claude ProseMirror-like editors. Each page records
 * what was sent when its send button is pressed. Checked:
 *   1. the message lands in each engine's box and is sent, whole;
 *   2. "leave it in the box" fills without sending;
 *   3. the chat in a hand-off tab isn't captured as an engine answer (a
 *      normal tab, same page, is);
 *   4. Claude needs its permission first, and says so;
 *   5. the button is on Analyze, Ask and the campaign board; the preview is
 *      editable and what is sent is the edited text; Copy and Download.
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seedCampaign } from "./helpers/campaign-seed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-handoff-ui-test";

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
  console.log(`\nhandoff-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const fx = readFileSync(path.join(HERE, "fixtures", "chatgpt-genui-cards.txt"), "utf8").split(/\r?\n/);
const REQ = (fx.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "");
const SSE = fx.filter((l) => !l.startsWith("# ")).join("\n");

// The chat boxes, as each engine builds them. The send button only works
// once there is text (as on the real sites), and the page empties the box
// after sending. ChatGPT's page then asks its question the way the real one
// does, so a capture would happen if the tab weren't a hand-off.
const BOXES = {
  chatgpt: `<textarea id="prompt-textarea" rows="4" style="width:600px"></textarea><button id="composer-submit-button" disabled>Send</button>`,
  gemini: `<rich-textarea style="display:block"><div contenteditable="true" style="min-height:40px;width:600px"></div></rich-textarea><button aria-label="Send message" disabled>➤</button>`,
  perplexity: `<textarea rows="4" style="width:600px"></textarea><button aria-label="Submit" disabled>→</button>`,
  grok: `<div data-testid="chat-input"><div class="ProseMirror" contenteditable="true" style="min-height:40px;width:600px"></div></div><button data-testid="chat-submit" disabled>↑</button>`,
  claude: `<div class="ProseMirror" contenteditable="true" style="min-height:40px;width:600px"></div><button aria-label="Send message" disabled>↑</button>`,
};
const enginePage = (engine) => `<!doctype html><html lang="en"><body><main>${BOXES[engine]}</main><script>
  window.__sent = null;
  const box = document.querySelector("textarea, [contenteditable=true]");
  const btn = document.querySelector("button");
  const text = () => box.tagName === "TEXTAREA" ? box.value : box.innerText;
  box.addEventListener("input", () => { btn.disabled = !text().trim(); });
  btn.addEventListener("click", async () => {
    window.__sent = text();
    if (box.tagName === "TEXTAREA") box.value = ""; else box.textContent = "";
    btn.disabled = true;
    if (location.hostname === "chatgpt.com") {
      const res = await fetch("/backend-api/f/conversation", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(REQ)} });
      await res.text();
    }
    document.title = "sent";
  });
</script></body></html>`;

const HOSTS = { "chatgpt.com": "chatgpt", "gemini.google.com": "gemini", "www.perplexity.ai": "perplexity", "grok.com": "grok", "claude.ai": "claude" };

// The engines' addresses point at a local HTTPS server (a self-signed
// certificate the test browser is told to accept): tabs the extension opens
// itself aren't covered by the test's request routing.
const certDir = mkdtempSync(path.join(os.tmpdir(), "cito-handoff-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-keyout", path.join(certDir, "k.pem"), "-out", path.join(certDir, "c.pem")], { stdio: "ignore" });
let salt = 1;
const server = https.createServer({ key: readFileSync(path.join(certDir, "k.pem")), cert: readFileSync(path.join(certDir, "c.pem")) }, (req, res) => {
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  const engine = HOSTS[host];
  const u = new URL(req.url, `https://${host}`);
  if (engine === "chatgpt" && u.pathname.startsWith("/backend-")) {
    salt++;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    return res.end(SSE.replace(/\b[0-9a-f]{8}-(?=[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)/g, `${String(salt).padStart(8, "0")}-`));
  }
  if (!engine || u.pathname !== "/" && !/^\/(new|app|c\/)/.test(u.pathname)) { res.writeHead(204); return res.end(); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(enginePage(engine));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox",
    `--host-resolver-rules=${Object.keys(HOSTS).map((h) => `MAP ${h} 127.0.0.1:${PORT}`).join(", ")}`, "--ignore-certificate-errors", "--no-proxy-server"],
  acceptDownloads: true,
});
try {
  const { extId, seeded, seedPage } = await seedCampaign(context, path.join(HERE, "fixtures"));
  if (seeded.error) { console.log(`\nhandoff-ui: CANNOT RUN — ${seeded.error}`); process.exit(1); }
  await seedPage.close();

  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(String(e)));
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await tab.waitForTimeout(1000);
  const msg = (m) => tab.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const records = async () => (((await msg({ type: "get-records" })) || {}).records || []).filter((r) => !String(r.captureId).startsWith("demo-"));

  // Waits for the tab the extension opens, then for its page to report.
  const nextTab = () => context.waitForEvent("page", { timeout: 15000 });
  const sentIn = async (p) => {
    await p.waitForFunction(() => document.title === "sent", null, { timeout: 20000 }).catch(() => {});
    return p.evaluate(() => window.__sent);
  };
  const boxIn = (p) => p.evaluate(() => { const b = document.querySelector("textarea, [contenteditable=true]"); return b.tagName === "TEXTAREA" ? b.value : b.innerText; });
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  const LONG = ["# CitoSkeleton — test pack", "", "| Brand | Share |", "|---|---|", "| Zento | 41% |", "| Kovo | 22% |", "",
    "Line with ünïcödé, an Arabic word مرحبا and Hindi नमस्ते.", ...Array.from({ length: 120 }, (_, i) => `Row ${i + 1}: Zento named first on prompt ${i + 1}.`), "", "Request: explain."].join("\n");

  console.log("\n1. the message lands in each engine's box and is sent");
  for (const engine of ["chatgpt", "gemini", "perplexity", "grok"]) {
    const opened = nextTab();
    const r = await msg({ type: "handoff-open", engine, text: LONG, autoSend: true });
    const p = await opened.catch(() => null);
    if (!r || !r.ok || !p) { check(`${engine}: opened`, false, JSON.stringify(r)); continue; }
    const sent = await sentIn(p);
    check(`${engine}: sent, whole (${LONG.length} characters)`, norm(sent) === norm(LONG), `${norm(sent).length} vs ${norm(LONG).length}: ${norm(sent).slice(0, 80)}`);
    await p.waitForTimeout(400);
    const last = await tab.evaluate(() => chrome.storage.session.get("lcfcHandoffLast")).then((x) => x.lcfcHandoffLast);
    check(`${engine}: the page reported it sent`, last && last.ok && last.sent, JSON.stringify(last));
    await p.close();
  }

  console.log("\n2. left in the box, not sent");
  {
    const opened = nextTab();
    await msg({ type: "handoff-open", engine: "grok", text: "Only fill this one.", autoSend: false });
    const p = await opened;
    await p.waitForFunction(() => { const b = document.querySelector("[contenteditable=true]"); return b && b.innerText.trim(); }, null, { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(1500);
    check("the text is in the box", norm(await boxIn(p)) === "Only fill this one.", await boxIn(p));
    check("and nothing was sent", (await p.evaluate(() => window.__sent)) === null);
    await p.close();
  }

  console.log("\n3. a hand-off chat isn't captured as an engine answer");
  {
    const before = (await records()).filter((r) => r.platform === "chatgpt").length;
    const opened = nextTab();
    await msg({ type: "handoff-open", engine: "chatgpt", text: "What do you make of this?", autoSend: true });
    const p = await opened;
    await sentIn(p);
    await p.waitForTimeout(2500);
    const after = (await records()).filter((r) => r.platform === "chatgpt").length;
    check("no answer stored from the hand-off tab", after === before, `${before} → ${after}`);
    // The same page in an ordinary tab is captured: the check above means something.
    const q = await context.newPage();
    await q.goto("https://chatgpt.com/");
    await q.fill("#prompt-textarea", "an ordinary question");
    await q.evaluate(() => document.querySelector("#prompt-textarea").dispatchEvent(new Event("input")));
    await q.click("#composer-submit-button");
    await sentIn(q);
    let n = after;
    for (let i = 0; i < 20 && n <= after; i++) { await q.waitForTimeout(300); n = (await records()).filter((r) => r.platform === "chatgpt").length; }
    check("the same page in an ordinary tab is captured", n > after, `${after} → ${n}`);
    await q.close();
    await p.close();
    // The setting that keeps them.
    await tab.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
    await tab.waitForTimeout(600);
    const row = await tab.evaluate(() => !!document.querySelector("#setHandoffKeep"));
    check("Settings has a switch to keep those chats", row);
    await msg({ type: "settings-set", patch: { keepHandoffCaptures: true } });
    const before2 = n;
    const opened2 = nextTab();
    await msg({ type: "handoff-open", engine: "chatgpt", text: "Keep this one.", autoSend: true });
    const p2 = await opened2;
    await sentIn(p2);
    let n2 = before2;
    for (let i = 0; i < 20 && n2 <= before2; i++) { await p2.waitForTimeout(300); n2 = (await records()).filter((r) => r.platform === "chatgpt").length; }
    check("with it on, the hand-off chat is captured", n2 > before2, `${before2} → ${n2}`);
    await msg({ type: "settings-set", patch: { keepHandoffCaptures: false } });
    await p2.close();
  }

  console.log("\n4. Claude asks for its permission first");
  {
    const r = await msg({ type: "handoff-open", engine: "claude", text: "hello", autoSend: true });
    check("without it, nothing opens and the reply says what's needed", r && !r.ok && r.needsPermission === "https://claude.ai/*" && /claude\.ai/.test(r.error), JSON.stringify(r));
  }

  console.log("\n5. the button, the preview, and edited text");
  {
    // Analyze: open a capture.
    await tab.evaluate(() => document.querySelector('[data-tab="analyze"]')?.click());
    await tab.waitForTimeout(1500);
    const hasAt = await tab.evaluate(() => !!document.querySelector("#atHandoff"));
    check("Analyze has Continue in…", hasAt);
    await tab.click("#atHandoff");
    const menu = await tab.evaluate(() => [...document.querySelectorAll(".ho-wrap:has(#atHandoff) .ho-item")].map((b) => b.dataset.engine || b.dataset.act));
    check("the menu: five AIs, Copy, Download", JSON.stringify(menu) === JSON.stringify(["chatgpt", "claude", "gemini", "perplexity", "grok", "copy", "download"]), menu.join(","));
    await tab.evaluate(() => document.querySelector('.ho-wrap:has(#atHandoff) .ho-item[data-engine="perplexity"]').click());
    await tab.waitForSelector("#hoText", { timeout: 5000 }).catch(() => {});
    await tab.waitForTimeout(500);
    const pv = await tab.evaluate(() => ({ text: document.querySelector("#hoText")?.value || "", size: document.querySelector("#hoSize")?.textContent || "", engine: document.querySelector("#hoEngine")?.value }));
    check("the preview shows the pack for that AI", pv.engine === "perplexity" && /CitoSkeleton/.test(pv.text) && pv.text.length > 200, `${pv.engine} ${pv.text.slice(0, 120)}`);
    check("with its size against the AI's limit", /characters/.test(pv.size) && /Perplexity/.test(pv.size), pv.size);
    check("the answer's prompt is in it", seeded && (await records()).some((r) => r.userPrompt && pv.text.includes(r.userPrompt)), pv.text.slice(0, 300));
    // Change the engine: rebuilt for its budget.
    await tab.selectOption("#hoEngine", "chatgpt");
    await tab.waitForTimeout(400);
    // Edit, then send: the edited text is what arrives.
    await tab.fill("#hoText", "EDITED by the user — Zento vs Kovo, please compare.");
    const opened = nextTab();
    await tab.click("#hoSend");
    const p = await opened.catch(() => null);
    const sent = p ? await sentIn(p) : null;
    check("the edited text is what is sent", norm(sent) === "EDITED by the user — Zento vs Kovo, please compare.", sent);
    check("the preview closes once sent", await tab.evaluate(() => !document.querySelector("#hoBackdrop")));
    if (p) await p.close();

    // (Claude from the preview asks Chrome for the permission inside the
    // click; nobody can answer that prompt in a test browser, so that path is
    // covered by step 4, the worker refusing without it.)

    // Copy and Download.
    // The clipboard is read back through a stand-in: reading it for real
    // asks a permission nobody can answer here.
    await tab.evaluate(() => { window.__clip = ""; navigator.clipboard.writeText = async (t) => { window.__clip = t; }; });
    await tab.click("#atHandoff");
    await tab.evaluate(() => document.querySelector('.ho-wrap:has(#atHandoff) .ho-item[data-act="copy"]').click());
    await tab.waitForTimeout(600);
    const clip = await tab.evaluate(() => window.__clip);
    check("Copy for any AI puts the pack on the clipboard", /CitoSkeleton/.test(clip) && clip.length > 200, clip.slice(0, 80));
    await tab.click("#atHandoff");
    const dl = tab.waitForEvent("download", { timeout: 5000 }).catch(() => null);
    await tab.evaluate(() => document.querySelector('.ho-wrap:has(#atHandoff) .ho-item[data-act="download"]').click());
    const d = await dl;
    check("Download as .md", d && /\.md$/.test(d.suggestedFilename()), d && d.suggestedFilename());

    // Campaigns.
    await tab.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await tab.waitForTimeout(2500);
    check("the campaign board has Continue in…", await tab.evaluate(() => !!document.querySelector("#cpHandoff")));
    await tab.click("#cpHandoff");
    await tab.evaluate(() => document.querySelector('.ho-wrap:has(#cpHandoff) .ho-item[data-engine="gemini"]').click());
    await tab.waitForSelector("#hoText", { timeout: 5000 }).catch(() => {});
    await tab.waitForTimeout(800);
    const cp = await tab.evaluate(() => document.querySelector("#hoText")?.value || "");
    check("its pack names the campaign's brands and their numbers", cp.includes(seeded.own) && seeded.competitors.every((c) => cp.includes(c)) && /\|/.test(cp), cp.slice(0, 300));
    await tab.evaluate(() => document.querySelector("#hoCancel")?.click());

    // Ask: with the built-in AI off there's still a way to ask, by hand-off.
    await tab.evaluate(() => document.querySelector('[data-tab="ask"]')?.click());
    await tab.waitForTimeout(1200);
    const ask = await tab.evaluate(() => ({ off: !!document.querySelector("#askOffHandoff"), on: !!document.querySelector("#askHandoff") }));
    check("Ask has Continue in… (with or without the built-in AI)", ask.off || ask.on, JSON.stringify(ask));
    const askId = ask.off ? "askOff" : "ask";
    await tab.fill(ask.off ? "#askOffQ" : "#askInput", "Why is Kovo ahead on TV prompts?").catch(() => {});
    await tab.click(`#${askId}Handoff`);
    await tab.evaluate((id) => document.querySelector(`.ho-wrap:has(#${id}Handoff) .ho-item[data-engine="chatgpt"]`).click(), askId);
    await tab.waitForSelector("#hoText", { timeout: 5000 }).catch(() => {});
    await tab.waitForTimeout(800);
    const aq = await tab.evaluate(() => ({ q: document.querySelector("#hoQuestion")?.value, text: document.querySelector("#hoText")?.value || "" }));
    check("the typed question goes with the data", aq.q === "Why is Kovo ahead on TV prompts?" && aq.text.includes("Why is Kovo ahead on TV prompts?"), JSON.stringify(aq).slice(0, 300));
    await tab.evaluate(() => document.querySelector("#hoCancel")?.click());
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
