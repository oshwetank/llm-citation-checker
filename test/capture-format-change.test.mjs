/*
 * capture-format-change.test.mjs — an engine changes how it sends answers,
 * and a question asked by hand is still captured (0.84.0).
 *
 * The owner, 29 Oct: on ChatGPT, Gemini, Perplexity and Grok, the everyday
 * capture "is getting broken with each update" and stays broken after a
 * refresh. Updating over an old profile isn't it (upgrade-capture passes);
 * what changes is the engines' own traffic, which no fixture can follow.
 * Here each engine's page answers over an address CitoSkeleton has never
 * seen, the way a site does after a redesign, and shows the answer on the
 * page. The person presses Enter in the composer; the answer must be stored
 * anyway, read off the page, with its prompt, its text and its links.
 * Then a page that never answers: Analyze must say the question wasn't
 * captured, with a way to refresh that tab. Made-up brands only.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-capture-format-change-test";

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
  console.log(`\ncapture-format-change: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

// Laid out as the engines lay out a recommendation: a named pick per item.
const ANSWER = "Two lamps stand out for reading in bed.</p><ul><li><strong>Zento Glow</strong> is the pick: warm light and a long arm.</li><li><strong>Kovo Lite</strong> costs less and is fine on a desk.</li></ul><p>Read more at [the lamp test](https://lamps.example/test).";
// Each engine's page, in the markup its reader expects: the composer, the
// question bubble and the answer as the site draws them. The answer comes
// over /v9/new-stream, an address no version of CitoSkeleton knows.
const PAGES = {
  chatgpt: { url: "https://chatgpt.com/c/0a1b2c3d", composer: '<div id="prompt-textarea" contenteditable="true"></div>', user: (q) => `<div data-message-author-role="user">${q}</div>`, bot: (a) => `<div data-message-author-role="assistant" data-message-id="m1"><div class="markdown"><p>${a}</p></div></div>` },
  gemini: { url: "https://gemini.google.com/app/0a1b2c3d4e5f", composer: '<rich-textarea><div contenteditable="true"></div></rich-textarea>', user: (q) => `<user-query><div class="query-text"><p>${q}</p></div></user-query>`, bot: (a) => `<model-response><message-content><div class="markdown"><p>${a}</p></div></message-content></model-response>` },
  perplexity: { url: "https://www.perplexity.ai/search/0a1b2c3d", composer: "<textarea></textarea>", user: (q) => `<div class="group/user-bubble">${q}</div>`, bot: (a) => `<div class="prose"><p>${a}</p></div>` },
  grok: { url: "https://grok.com/c/0a1b2c3d", composer: "<textarea></textarea>", user: (q) => `<div data-testid="user-message"><div class="message-bubble">${q}</div></div>`, bot: (a) => `<div class="message-row"><div class="message-bubble"><p>${a}</p></div></div>` },
};
const md = (a) => a.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
const html = (p, { answer = true } = {}) => `<!doctype html><html lang="en"><body><main id="thread"></main><form>${p.composer}</form><script>
  const ed = document.querySelector('[contenteditable="true"], textarea');
  ed.focus();
  window.ask = async (q) => {
    if ('value' in ed) ed.value = q; else ed.textContent = q;
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById("thread").insertAdjacentHTML("beforeend", ${JSON.stringify(p.user("__Q__"))}.replace("__Q__", q));
    // The answer over an address the capture has never seen.
    try { const r = await fetch("/v9/new-stream", { method: "POST", body: q }); await r.text(); } catch (_) {}
    ${answer ? `document.getElementById("thread").insertAdjacentHTML("beforeend", ${JSON.stringify(p.bot(md(ANSWER)))});` : ""}
  };
</script></body></html>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
let quiet = null;
for (const [id, p] of Object.entries(PAGES)) {
  const origin = new URL(p.url).origin;
  await context.route(new RegExp(`^${origin.replace(/[.]/g, "\\.")}/`), (route) => {
    const u = route.request().url();
    if (/\/v9\/new-stream/.test(u)) return route.fulfill({ status: 200, contentType: "application/x-unknown", body: "\u0000binary-ish frames the capture can't read\u0000" });
    return route.fulfill({ status: 200, contentType: "text/html", body: html(p, { answer: quiet !== id }) });
  });
}
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.waitForTimeout(1000);
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  await msg({ type: "demo-clear" });
  const recs = async () => (((await msg({ type: "get-records" })) || {}).records || []);

  console.log("\nthe answer comes over an address CitoSkeleton doesn't know; it's on the page");
  for (const [id, p] of Object.entries(PAGES)) {
    const before = (await recs()).filter((r) => r.platform === id).length;
    const tab = await context.newPage();
    await tab.goto(p.url);
    await tab.waitForTimeout(800);
    const q = `best reading lamp for ${id} night owls`;
    await tab.evaluate((q) => window.ask(q), q);
    let rec = null;
    for (let i = 0; i < 40 && !rec; i++) {
      await tab.waitForTimeout(500);
      rec = (await recs()).filter((r) => r.platform === id)[before] || null;
    }
    check(`${id}: stored all the same`, !!rec, `${(await recs()).filter((r) => r.platform === id).length} stored`);
    if (rec) {
      const full = ((await msg({ type: "get-record", captureId: rec.captureId })) || {}).record || rec;
      check(`${id}: with the question as asked`, String(full.userPrompt || "").includes("night owls"), full.userPrompt);
      // Grok's page reader keeps the text only, not its links.
    check(`${id}: and the answer, its brands${id === "grok" ? "" : " and its link"}`, /Zento Glow/.test(full.answerText || "") && (full.brandMentions || []).some((m) => /Zento/.test(m.brand)) && (id === "grok" || (full.sources || []).some((s) => /lamps\.example/.test(s.url || ""))),
        JSON.stringify({ a: String(full.answerText || "").slice(0, 80), b: (full.brandMentions || []).map((m) => m.brand), s: (full.sources || []).map((s) => s.url) }));
    }
    await tab.close();
  }

  console.log("\na question that never gets an answer stored is said, not lost");
  quiet = "gemini";
  const tab = await context.newPage();
  await tab.goto(PAGES.gemini.url);
  await tab.waitForTimeout(800);
  await tab.evaluate(() => window.ask("which lamp is brightest"));
  await tab.waitForTimeout(1500);
  const soon = await msg({ type: "capture-missed" });
  check("not straight away: it may still be answering", soon.ok && soon.missed.length === 0, JSON.stringify(soon));
  const later = await msg({ type: "capture-missed", afterMs: 1000 });
  check("then: Gemini, with its tab", later.missed.length === 1 && later.missed[0].engine === "gemini" && later.missed[0].tabId != null, JSON.stringify(later));
  await panel.evaluate(() => localStorage.setItem("cito-test-missed-after", "1000"));
  await panel.reload();
  await panel.waitForSelector("#missedBanner:not([hidden]) .missed-row", { timeout: 25000 }).catch(() => {});
  const banner = await panel.evaluate(() => document.getElementById("missedBanner")?.innerText || "");
  check("Analyze says so, with Refresh and the report", /question on Gemini .* wasn.t captured/.test(banner) && /Refresh the Gemini tab/.test(banner) && /Copy capture report/.test(banner), banner);
  await panel.evaluate(() => document.querySelector("#missedBanner .missed-x")?.click());
  await panel.waitForTimeout(600);
  check("dismissed, it goes", await panel.evaluate(() => document.getElementById("missedBanner").hidden));
  check("and stays gone", (await msg({ type: "capture-missed", afterMs: 1000 })).missed.length === 0);
  await tab.close();
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
