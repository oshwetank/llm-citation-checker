/*
 * prompt-submit.test.mjs — the campaign runner actually submits its prompt,
 * exactly once, on both engines and through every submission path.
 *
 * Reported: ChatGPT turns failing with only six prompts queued — so not a
 * rate limit. Root cause: content-iso.js runs at document_start and stripped
 * the WHOLE query string before chatgpt.com's own app JS booted. ChatGPT
 * reads ?q= itself and auto-submits it natively (their deeplink path), so
 * wiping the query removed the prompt before ChatGPT ever saw it, and every
 * turn fell back to DOM-typing a React composer. Proven against the old
 * file: in the native-auto-submit shape it submitted ZERO times and reported
 * "send control never accepted the prompt".
 *
 * The fix keeps ?q= until it has clearly been consumed, so native submit gets
 * first chance, with typing as the fallback. Whether native fires is NOT
 * assumed — OpenAI gated auto-submit on sec-fetch-site after a 2025
 * prompt-injection disclosure, and Gemini has no native prefill at all — so
 * both paths must keep working. That is what this file pins.
 *
 * Each scenario asserts submits === 1: never 0 (dropped prompt) and never 2
 * (a duplicate turn, which corrupts a campaign's counts just as badly).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ISO = readFileSync(path.resolve(HERE, "..", "src", "content-iso.js"), "utf8");
const PROMPT = "best handset under 12000";

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
  console.log("\nprompt-submit: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported correctness bug, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

// Runs the REAL content-iso.js against a mock page shaped like one engine.
// The page records every submission it receives so the count can be asserted.
async function run(html, { gemini = false, waitMs = 9000 } = {}) {
  const page = await browser.newPage();
  const host = gemini ? "https://gemini.google.com" : "https://chatgpt.com";
  await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<body>${html}</body>` }));
  await page.goto(`${host}/mock?q=${encodeURIComponent(PROMPT)}&lcfc=1&lcfctok=T1`);
  const res = await page.evaluate(async ({ iso, waitMs }) => {
    const events = [];
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (m, cb) => { events.push(JSON.parse(JSON.stringify(m))); if (cb) cb({ ok: true }); },
        onMessage: { addListener() {} },
      },
      storage: { local: { get: (_k, cb) => cb && cb({}) } },
    };
    eval(iso); // eslint-disable-line no-eval
    await new Promise((r) => setTimeout(r, waitMs));
    return {
      events,
      submits: window.__submits || 0,
      text: window.__lastText || null,
      url: location.pathname + location.search,
    };
  }, { iso: ISO, waitMs });
  await page.close();
  return {
    ...res,
    gaveUp: res.events.filter((e) => e.type === "loader-submit-failed").map((e) => e.reason),
  };
}

// Records a submission and appends the prompt to the transcript, so the
// script's own "did this actually go out" detector has something to see.
const RECORD_CHATGPT = `
  window.__submits=0;
  window.__record=(t)=>{ window.__submits++; window.__lastText=t;
    const d=document.createElement('div'); d.setAttribute('data-message-author-role','user');
    d.textContent=t; document.getElementById('convo').appendChild(d); };`;
const RECORD_GEMINI = `
  window.__submits=0;
  window.__record=(t)=>{ window.__submits++; window.__lastText=t;
    const d=document.createElement('user-query'); d.textContent=t;
    document.getElementById('convo').appendChild(d); };`;

console.log("\nChatGPT: the page auto-submits ?q= itself (the path the old code destroyed)");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      setTimeout(()=>{ const q=new URLSearchParams(location.search).get('q');
        if(q) window.__record(q); }, 1200);
    </script>`);
  check("submitted exactly once", r.submits === 1, `submits=${r.submits}`);
  check("the prompt text is correct", r.text === PROMPT, JSON.stringify(r.text));
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
  check("?q= is cleared afterwards so a reload can't re-fire it", !/[?&]q=/.test(r.url), r.url);
}

console.log("\nChatGPT: page pre-fills the composer from ?q= but never submits");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      setTimeout(()=>{ const q=new URLSearchParams(location.search).get('q'); if(q) box.textContent=q; },800);
      document.getElementById('composer-submit-button').addEventListener('click',()=>{
        if(!box.innerText.trim()) return;
        const t=box.innerText; box.innerHTML=''; window.__record(t); });
    </script>`);
  check("submitted exactly once — not twice on top of the pre-fill", r.submits === 1, `submits=${r.submits}`);
  check("the prompt is not doubled", r.text === PROMPT, JSON.stringify(r.text));
}

console.log("\nChatGPT: send button present but inert via aria-disabled (Enter must save it)");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button" aria-disabled="true">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      box.addEventListener('keydown',e=>{ if(e.key==='Enter'&&box.innerText.trim()){
        const t=box.innerText; box.innerHTML=''; window.__record(t); }});
    </script>`);
  check("submitted exactly once via Enter", r.submits === 1, `submits=${r.submits}`);
  check("the prompt text is correct", r.text === PROMPT, JSON.stringify(r.text));
}

console.log("\nChatGPT: composer mounts late (a cold SPA boot)");
{
  const r = await run(`
    <div id="host"></div><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      setTimeout(()=>{
        document.getElementById('host').innerHTML =
          '<div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button">send</button>';
        const box=document.getElementById('prompt-textarea');
        document.getElementById('composer-submit-button').addEventListener('click',()=>{
          if(!box.innerText.trim()) return;
          const t=box.innerText; box.innerHTML=''; window.__record(t); });
      }, 6000);
    </script>`, { waitMs: 16000 });
  check("still submitted exactly once after a 6s mount delay", r.submits === 1, `submits=${r.submits}`);
}

console.log("\nGemini: no native prefill exists, so the typing path is the only path");
{
  const r = await run(`
    <rich-textarea><div contenteditable="true" id="g"></div></rich-textarea>
    <button aria-label="Send message">send</button><div id="convo"></div>
    <script>${RECORD_GEMINI}
      const box=document.getElementById('g');
      const fire=()=>{ if(!box.innerText.trim()) return; const t=box.innerText; box.innerHTML=''; window.__record(t); };
      box.addEventListener('keydown',e=>{ if(e.key==='Enter') fire(); });
      document.querySelector('button[aria-label="Send message"]').addEventListener('click',fire);
    </script>`, { gemini: true });
  check("submitted exactly once", r.submits === 1, `submits=${r.submits}`);
  check("the prompt text is correct", r.text === PROMPT, JSON.stringify(r.text));
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nNothing usable on the page: report the failure, never hang silently");
{
  const r = await run(`<div>nothing usable here</div>`, { waitMs: 34000 });
  check("no submission happened", r.submits === 0, `submits=${r.submits}`);
  check("a failure reason was reported to the run", r.gaveUp.length === 1, JSON.stringify(r.gaveUp));
  check("the reason names the real problem", /composer never appeared/.test(r.gaveUp[0] || ""), r.gaveUp[0]);
}

await browser.close();
console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
