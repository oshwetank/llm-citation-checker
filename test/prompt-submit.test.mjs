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
async function run(html, { gemini = false, grok = false, waitMs = 9000, throttle = false, throttleMs = 60000, workerClock = true, clockMs = 0 } = {}) {
  const page = await browser.newPage();
  const host = gemini ? "https://gemini.google.com" : grok ? "https://grok.com" : "https://chatgpt.com";
  await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<body>${html}</body>` }));
  await page.goto(`${host}/mock?q=${encodeURIComponent(PROMPT)}&lcfc=1&lcfctok=T1`);
  const res = await page.evaluate(async ({ iso, waitMs, throttle, throttleMs, workerClock, clockMs }) => {
    const t0 = Date.now();
    window.__t0 = t0;
    const events = [];
    // Unthrottled timers, kept for the harness itself and for standing in for
    // the service worker — which is exactly what isn't throttled in reality.
    const realSetInterval = window.setInterval.bind(window);
    const realClearInterval = window.clearInterval.bind(window);
    const realSetTimeout = window.setTimeout.bind(window);
    if (throttle) {
      // Chrome's throttling of a hidden page's timers: once a second from the
      // moment it's hidden, once a MINUTE after five minutes (the default
      // here). Real browsers can't be made to do this under Playwright, which
      // keeps every page it drives "visible".
      window.setInterval = (fn, ms, ...a) => realSetInterval(fn, Math.max(ms || 0, throttleMs), ...a);
      window.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.max(ms || 0, throttleMs), ...a);
    }
    let onMsg = null;
    const runtime = {
      lastError: null,
      sendMessage: (m, cb) => { events.push(JSON.parse(JSON.stringify(m))); if (cb) cb({ ok: true }); },
      onMessage: { addListener(fn) { onMsg = fn; } },
    };
    if (workerClock && throttle) {
      // The service worker's side of startClock: ticks at the asked-for rate,
      // from a clock the page's throttling doesn't touch.
      runtime.connect = () => {
        const fns = [];
        let iv = null;
        return {
          onMessage: { addListener: (fn) => fns.push(fn) },
          onDisconnect: { addListener() {} },
          // clockMs runs the clock faster than asked, to reach tick counts
          // that take a minute in real time.
          postMessage: (m) => { if (m && m.everyMs && !iv) iv = realSetInterval(() => fns.forEach((f) => f(1)), clockMs || m.everyMs); },
          disconnect: () => { if (iv) realClearInterval(iv); },
        };
      };
    }
    window.chrome = { runtime, storage: { local: { get: (_k, cb) => cb && cb({}) } } };
    eval(iso); // eslint-disable-line no-eval
    await new Promise((r) => realSetTimeout(r, waitMs));
    // What the run's watchdog would be told if it asked now (see
    // probeLoaderTab in background.js).
    let probe = null;
    if (onMsg) onMsg({ type: "loader-probe", token: "T1" }, {}, (r) => { probe = r; });
    let locks = [];
    try { locks = ((await navigator.locks.query()).held || []).map((l) => l.name); } catch (_) {}
    return {
      events,
      probe,
      locks,
      submits: window.__submits || 0,
      submitAt: window.__submitAt === undefined ? null : window.__submitAt,
      text: window.__lastText || null,
      url: location.pathname + location.search,
    };
  }, { iso: ISO, waitMs, throttle, throttleMs, workerClock, clockMs });
  await page.close();
  return {
    ...res,
    gaveUp: res.events.filter((e) => e.type === "loader-submit-failed").map((e) => e.reason),
    traces: res.events.filter((e) => e.type === "loader-submit-failed").map((e) => e.trace || ""),
    limits: res.events.filter((e) => e.type === "loader-rate-limited").map((e) => e.detail),
  };
}

// Records a submission and appends the prompt to the transcript, so the
// script's own "did this actually go out" detector has something to see.
const RECORD_CHATGPT = `
  window.__submits=0;
  window.__record=(t)=>{ window.__submits++; window.__lastText=t;
    if(window.__submitAt===undefined) window.__submitAt=Date.now()-(window.__t0||Date.now());
    const d=document.createElement('div'); d.setAttribute('data-message-author-role','user');
    d.textContent=t; document.getElementById('convo').appendChild(d); };`;
const RECORD_GEMINI = `
  window.__submits=0;
  window.__record=(t)=>{ window.__submits++; window.__lastText=t;
    if(window.__submitAt===undefined) window.__submitAt=Date.now()-(window.__t0||Date.now());
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

console.log("\nChatGPT: the page fills ?q= in just after the script typed (0.62.2)");
{
  // The owner's Motorola run sent 13 of 30 ChatGPT prompts doubled
  // ("Best gaming phones under 30000Best gaming phones under 30000"): the
  // page's own ?q= fill landed on top of the typed prompt. Here it lands
  // right after the first input the script makes, once.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      let filled=false;
      box.addEventListener('input',()=>{ if(filled||!box.textContent.trim()) return; filled=true;
        const q=new URLSearchParams(location.search).get('q');
        setTimeout(()=>{ box.textContent=box.textContent+q; },0); });
      document.getElementById('composer-submit-button').addEventListener('click',()=>{
        if(!box.innerText.trim()) return;
        const t=box.innerText; box.innerHTML=''; window.__record(t); });
    </script>`);
  check("submitted once", r.submits === 1, `submits=${r.submits}`);
  check("with the prompt once, not twice", r.text === PROMPT, JSON.stringify(r.text));
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

/* Hidden-tab throttling.
 *
 * A campaign's engine tabs are always hidden, and Chrome throttles a hidden
 * page's timers — to once a MINUTE after five minutes. Two real runs, in two
 * browsers, stopped succeeding at 4.96 and 4.97 minutes on every engine at
 * once, and not one of 57 failures carried a trace: the page-timer-driven
 * loop never got far enough to report. The loop now runs on ticks the
 * service worker supplies over a port. The first scenario is the control — it
 * proves this harness's throttle is real, so the second isn't passing by luck.
 */
const ENTER_PAGE = `
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button" aria-disabled="true">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      box.addEventListener('keydown',e=>{ if(e.key==='Enter'&&box.innerText.trim()){
        const t=box.innerText; box.innerHTML=''; window.__record(t); }});
    </script>`;

console.log("\nControl: page timers throttled to once a minute, and only the page's clock to run on");
{
  const r = await run(ENTER_PAGE, { throttle: true, workerClock: false });
  check("nothing is submitted — the throttle this harness applies is real", r.submits === 0, `submits=${r.submits}`);
}

console.log("\nPage timers throttled to once a minute, ticks supplied by the service worker");
{
  const r = await run(ENTER_PAGE, { throttle: true });
  check("the prompt is still submitted, exactly once", r.submits === 1, `submits=${r.submits}`);
  check("in about the time an unthrottled tab takes, not minutes", r.submitAt !== null && r.submitAt < 8000, `submitAt=${r.submitAt}ms`);
  check("the prompt text is correct", r.text === PROMPT, JSON.stringify(r.text));
  // What the watchdog would record if this turn's answer then never arrived.
  const p = r.probe || {};
  check("a probe reports the turn as sent, and how that was confirmed",
    p.stage === "sent" && !!p.sentWhy, JSON.stringify({ stage: p.stage, sentWhy: p.sentWhy }));
  check("it reports the worker's clock, ticking at its intended rate",
    p.clock === "worker" && p.maxTickGap > 0 && p.maxTickGap < 900, JSON.stringify({ clock: p.clock, maxTickGap: p.maxTickGap }));
  check("it carries the turn's event trace", typeof p.trace === "string" && /\bsent\b/.test(p.trace), p.trace);
  // Chrome 133+ freezes CPU-busy hidden tabs under Energy Saver; holding a
  // Web Lock is a documented exemption. Whether Chrome honours it can't be
  // driven from this harness — that the turn holds one while in flight can.
  check("a turn in flight holds the Web Lock that exempts its tab from freezing",
    r.locks.some((n) => n === "citoskeleton-turn-T1"), JSON.stringify(r.locks));
}

/* The lock has to outlast the send. In a real v0.45.3 run every turn still
 * waiting at about a minute was frozen, and never answered again: Chrome's
 * page-load tracker calls a busy page "loaded" at most a minute after it
 * stops loading (kWaitingForIdleTimeout), and from then on a hidden tab with
 * no freeze exemption is frozen. The lock was released when the post-send
 * watch ended — ~150 ticks, one minute — so a slow answer lost its exemption
 * exactly then. The clock here runs 80x fast to get past those ticks.
 */
console.log("\nA sent turn keeps its freeze exemption after the post-send watch ends");
{
  const r = await run(ENTER_PAGE, { throttle: true, clockMs: 5, waitMs: 4000 });
  check("the prompt was submitted, exactly once", r.submits === 1, `submits=${r.submits}`);
  // The loop stops ticking when the watch ends, so a count past 150 says
  // it has ended, not how long ago.
  check("the ~150-tick post-send watch has ended", (r.probe || {}).ticks > 150, String((r.probe || {}).ticks));
  check("the turn still holds its Web Lock while it waits for the answer",
    r.locks.some((n) => n === "citoskeleton-turn-T1"), JSON.stringify(r.locks));
}

console.log("\nPage timers at Chrome's once-a-second hidden-tab rate, no worker clock");
{
  // The rate every campaign tab gets from the moment it's hidden, before the
  // five-minute cliff. The loop still limps along — but the probe must show
  // the throttling plainly, so an export can say so.
  const r = await run(ENTER_PAGE, { throttle: true, throttleMs: 1000, workerClock: false, waitMs: 6000 });
  const p = r.probe || {};
  check("the probe says the page's own clock was driving the turn", p.clock === "page", JSON.stringify(p.clock));
  check("and that its ticks were ~1s apart instead of 400ms — throttling, measured",
    p.maxTickGap >= 900, JSON.stringify({ maxTickGap: p.maxTickGap, ticks: p.ticks }));
}

console.log("\nChatGPT: send button only mounts after a real pointer interaction with the composer");
{
  // Reported: "send control never accepted the prompt" on Gemini, Grok and
  // ChatGPT alike, traced to pick(sel.send) finding nothing at all — not an
  // inert button, an ABSENT one. Some composer UIs only render their send
  // control once the textarea has registered a genuine pointer interaction,
  // not just programmatic .focus(). This mimics that: the button doesn't
  // exist in the DOM until a real mousedown fires on the composer.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <div id="btn-host"></div><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      box.addEventListener('mousedown',()=>{
        if(document.getElementById('composer-submit-button')) return;
        const b=document.createElement('button'); b.id='composer-submit-button'; b.textContent='send';
        b.addEventListener('click',()=>{ if(!box.innerText.trim()) return;
          const t=box.innerText; box.innerHTML=''; window.__record(t); });
        document.getElementById('btn-host').appendChild(b);
      });
    </script>`);
  check("submitted exactly once — the pointer interaction woke the send control up", r.submits === 1, `submits=${r.submits}`);
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nChatGPT: send button stays inert for 12s before becoming usable");
{
  // Pins the widened retry window (MAX_SEND_TICKS 20 -> 45, ~8s -> ~18s):
  // a button that takes this long to become usable used to be abandoned as
  // "send control never accepted the prompt" well before it ever had a
  // chance to work.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button" aria-disabled="true">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      const btn=document.getElementById('composer-submit-button');
      btn.addEventListener('click',()=>{ if(btn.getAttribute('aria-disabled')==='true') return;
        if(!box.innerText.trim()) return; const t=box.innerText; box.innerHTML=''; window.__record(t); });
      setTimeout(()=>btn.removeAttribute('aria-disabled'), 12000);
    </script>`, { waitMs: 20000 });
  check("submitted exactly once once the button finally became usable", r.submits === 1, `submits=${r.submits}`);
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
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

  /* Run duration, measured rather than assumed.
   *
   * The auto-submit grace used to be a flat ~7.2s counted from
   * document_start, applied on BOTH engines. Gemini has no native ?q=
   * handling at all — which is why third-party "Gemini URL prompt" extensions
   * exist — so on Gemini that wait could only ever elapse in full before the
   * script typed. Across a 1000-prompt leg that is ~2 hours spent waiting for
   * something that cannot happen. It is now a short settle measured from the
   * composer actually appearing.
   *
   * This is dead time inside our own script, not request pacing: the
   * inter-prompt human-paced gap and the engine's own answer time are
   * untouched, so nothing here trades account safety for speed. Pinned as a
   * number because the saving is the entire point — a future refactor that
   * reintroduced a long unconditional wait would otherwise pass silently.
   */
  // 1.0.2: Gemini DOES send ?q= itself now (a live campaign of 22 Nov 2026
  // asked every Gemini question twice), so it waits out the same native-submit
  // grace as ChatGPT (~3.2 s from the composer) before typing. Still bounded:
  // a long unconditional wait would fail here.
  check("Gemini submits within the native-submit wait",
    r.submitAt != null && r.submitAt < 5000, `submitted at ${r.submitAt}ms`);
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nGemini: the page sends ?q= itself (1.0.2) — never sent a second time");
{
  const r = await run(`
    <rich-textarea><div contenteditable="true" id="g"></div></rich-textarea>
    <button aria-label="Send message">send</button><div id="convo"></div>
    <script>${RECORD_GEMINI}
      const box=document.getElementById('g');
      const fire=()=>{ if(!box.innerText.trim()) return; const t=box.innerText; box.innerHTML=''; window.__record(t); };
      box.addEventListener('keydown',e=>{ if(e.key==='Enter') fire(); });
      document.querySelector('button[aria-label="Send message"]').addEventListener('click',fire);
      // Gemini's own deep-link send: it reads ?q= as the page loads and
      // sends ~2 s later, the conversation opening at /app/<id> (as seen live).
      const q0=new URLSearchParams(location.search).get('q');
      setTimeout(()=>{ if(q0){ history.pushState(null,'','/app/abc123def456'); window.__record(q0); } }, 2000);
    </script>`, { gemini: true });
  check("submitted exactly once — Gemini's own send, not ours as well", r.submits === 1, `submits=${r.submits}`);
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
}

/* ---------- Upstream rate limits ----------
 *
 * A limit used to be invisible to this script: the turn just sat there until
 * the background watchdog gave up 90s later and marked it FAILED. With a
 * queue of hundreds of prompts that converted a temporary block into
 * permanent data loss — every remaining prompt burned at 90s each. Detecting
 * it lets the run PAUSE and resume once the window clears.
 *
 * The dangerous half is the FALSE POSITIVE: pausing a healthy run. The
 * detector originally scanned document.body.innerText, which includes the
 * model's own answer — so a campaign asking about API rate limits would have
 * paused itself on its own output. The scan now excludes the transcript, and
 * the last two cases below are what pin that.
 */
console.log("\nRate limit: a cap banner BEFORE the prompt is sent pauses the run");
{
  const r = await run(`
    <div role="alert">You've reached your limit for GPT-5. Try again after 3:00 PM.</div>
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      document.getElementById('composer-submit-button').addEventListener('click',()=>{
        if(!box.innerText.trim()) return;
        const t=box.innerText; box.innerHTML=''; window.__record(t); });
    </script>`, { waitMs: 4000 });
  check("the limit was reported", r.limits.length === 1, JSON.stringify(r.limits));
  check("the reported detail quotes the real banner text",
    /reached your limit/i.test(r.limits[0] || ""), JSON.stringify(r.limits[0]));
  check("nothing was submitted into a capped account", r.submits === 0, `submits=${r.submits}`);
  check("it is NOT reported as a submit failure (a failure would burn the prompt)",
    r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nRate limit: a cap appearing AFTER submit, in place of the answer");
{
  // The shape ChatGPT actually produces most often: the prompt goes out
  // fine, then the cap notice replaces the reply. The script used to stop
  // watching the moment the turn was submitted, so this was never seen.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button>
    <div id="convo"></div><div id="banner"></div>
    <script>${RECORD_CHATGPT}
      setTimeout(()=>{ const q=new URLSearchParams(location.search).get('q');
        if(q) window.__record(q); }, 1000);
      setTimeout(()=>{ document.getElementById('banner').textContent =
        'You have hit the usage cap for this model. Please try again in 2 hours.'; }, 3000);
    </script>`, { waitMs: 9000 });
  check("the prompt did go out first", r.submits === 1, `submits=${r.submits}`);
  check("the late cap was still detected", r.limits.length === 1, JSON.stringify(r.limits));
  check("no submit failure was reported for a turn that did submit",
    r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nRate limit: Gemini's quota wording");
{
  const r = await run(`
    <div class="error-banner">You've exceeded your current quota. Please try again in a moment.</div>
    <rich-textarea><div contenteditable="true" id="g"></div></rich-textarea>
    <button aria-label="Send message">send</button><div id="convo"></div>
    <script>${RECORD_GEMINI}</script>`, { gemini: true, waitMs: 4000 });
  check("the limit was reported", r.limits.length === 1, JSON.stringify(r.limits));
  check("nothing was submitted", r.submits === 0, `submits=${r.submits}`);
}

console.log("\nNO false positive: the ANSWER is about rate limits (the run must not pause)");
{
  // This is the case that makes a naive body-text scan unusable. Every
  // trigger phrase appears — inside the assistant's own reply.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button>
    <div id="convo">
      <div data-message-author-role="assistant">
        The OpenAI API is rate limited per organisation. If you send too many
        requests you'll see "You've reached your limit" and should please try
        again in a minute. Your usage quota exceeded errors are also billed.
      </div>
    </div>
    <script>${RECORD_CHATGPT}
      setTimeout(()=>{ const q=new URLSearchParams(location.search).get('q');
        if(q) window.__record(q); }, 1000);
    </script>`, { waitMs: 8000 });
  check("no limit was reported despite every trigger phrase being on the page",
    r.limits.length === 0, JSON.stringify(r.limits));
  check("the prompt ran normally, exactly once", r.submits === 1, `submits=${r.submits}`);
  check("no submit failure either", r.gaveUp.length === 0, r.gaveUp.join(","));
}

console.log("\nChatGPT's /c/local-… address is not proof the question was sent (1.0.4)");
{
  // The owner's Birla Opus campaign, 23 Nov 2026: the click moved ChatGPT to
  // /c/local-chatgpt-…, the question showed in the transcript, and nothing
  // was ever sent. The turn was taken as sent and timed out 90 s later.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button>
    <div id="convo"></div>
    <script>
      document.getElementById('composer-submit-button').addEventListener('click', () => {
        const box = document.getElementById('prompt-textarea'); const t = box.textContent; if (!t) return;
        box.textContent = '';
        const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'user'); d.textContent = t;
        document.getElementById('convo').appendChild(d);
        history.pushState({}, '', '/c/local-chatgpt-1234abcd');
      });
    </script>`, { waitMs: 22000 });
  check("the turn fails fast, saying the question never left", r.gaveUp.some((g) => /stayed local/.test(g)), JSON.stringify(r.gaveUp));
}
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button>
    <div id="convo"></div>
    <script>
      document.getElementById('composer-submit-button').addEventListener('click', () => {
        const box = document.getElementById('prompt-textarea'); const t = box.textContent; if (!t) return;
        box.textContent = '';
        const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'user'); d.textContent = t;
        document.getElementById('convo').appendChild(d);
        history.pushState({}, '', '/c/local-chatgpt-1234abcd');
        setTimeout(() => history.replaceState({}, '', '/c/6b03b81f-12c4-83ee-9967-03e7510b85ae'), 2000);
      });
    </script>`, { waitMs: 14000 });
  check("once ChatGPT gives the real address, the question counts as sent", r.gaveUp.length === 0, JSON.stringify(r.gaveUp));
}

console.log("\nGemini sends ?q= itself and moves to its conversation: the address is left alone");
{
  // Live run, 23 Nov 2026: once Gemini had moved to /app/<id>, the script put
  // back the address the page started on; Gemini sent the question again
  // into 3 to 5 new conversations, and its address flipped ~100 times a
  // minute. The page below sends from ?q= by itself, as Gemini now does.
  const r = await run(`
    <rich-textarea><div contenteditable="true" id="g"></div></rich-textarea>
    <button aria-label="Send message">send</button>
    <div id="convo"></div>
    <script>${RECORD_GEMINI}
      window.__paths = [];
      const rs = history.replaceState.bind(history);
      history.replaceState = (s, t, u) => { window.__paths.push(String(u)); return rs(s, t, u); };
      setTimeout(() => { const q = new URLSearchParams(location.search).get('q'); if (!q) return;
        window.__record(q); history.pushState({ app: 1 }, '', '/app/abc123?q=' + encodeURIComponent(q)); }, 1200);
    </script>`, { gemini: true, waitMs: 12000 });
  check("the question went out once", r.submits === 1, `submits=${r.submits}`);
  check("the address stays on Gemini's conversation", r.url.startsWith("/app/abc123"), r.url);
}

console.log("\nNO false positive: a source card outside the answer mentions rate limits");
{
  // Perplexity draws its source cards outside the answer block: a link to
  // the cited site with a snippet. One for a CRM comparison ("…API, rate
  // limits, bulk writes…") paused a live campaign for 30 minutes.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button>
    <div id="convo"><div data-message-author-role="assistant">Copper and HubSpot both suit small teams.</div></div>
    <div class="sources"><a href="https://prospeo.io/s/copper-vs-hubspot"><div>prospeo</div>
      <span>Copper vs HubSpot for GTM teams: per-seat prices, which plan unlocks the API, rate limits, bulk writes, webhooks</span></a></div>
    <script>${RECORD_CHATGPT}
      setTimeout(()=>{ const q=new URLSearchParams(location.search).get('q');
        if(q) window.__record(q); }, 1000);
    </script>`, { waitMs: 8000 });
  check("no limit was reported from a source card's snippet", r.limits.length === 0, JSON.stringify(r.limits));
  check("the prompt ran normally, exactly once", r.submits === 1, `submits=${r.submits}`);
}

console.log("\nNO false positive: the user's own PROMPT is about rate limits");
{
  const r = await run(`
    <rich-textarea><div contenteditable="true" id="g"></div></rich-textarea>
    <button aria-label="Send message">send</button>
    <div id="convo"><user-query>why am I rate limited and told too many requests?</user-query></div>
    <script>${RECORD_GEMINI}
      const box=document.getElementById('g');
      const fire=()=>{ if(!box.innerText.trim()) return; const t=box.innerText; box.innerHTML=''; window.__record(t); };
      box.addEventListener('keydown',e=>{ if(e.key==='Enter') fire(); });
      document.querySelector('button[aria-label="Send message"]').addEventListener('click',fire);
    </script>`, { gemini: true, waitMs: 12000 });
  check("no limit reported from prompt text sitting in the transcript",
    r.limits.length === 0, JSON.stringify(r.limits));
}

/* ---------- The silent-failure bug ----------
 *
 * Reported: six prompts, ChatGPT failed EVERY one, and every failure was a
 * bare "timeout" — never a submit failure. Gemini, on the same run, reported
 * a real "send control never accepted the prompt". That asymmetry was the
 * clue: Gemini's script tried and told the truth; ChatGPT's script believed
 * it had succeeded and went quiet, leaving the 90s watchdog to record a
 * generic timeout with nothing to act on.
 *
 * The cause was treating an EMPTIED COMPOSER as proof of submission. React
 * clearing or re-rendering its own composer is byte-for-byte identical to a
 * successful send, so a send that did nothing set sentOk, stopped all further
 * attempts, and guaranteed the turn died silently.
 *
 * Proof is now positive only: the conversation URL, a streaming indicator, or
 * the prompt in the transcript.
 */
console.log("\nA send that clears the composer but does NOTHING is reported, not silently accepted");
{
  // The exact shape: clicking send empties the composer, and nothing else
  // ever happens — no navigation, no stop button, no transcript entry.
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      document.getElementById('composer-submit-button').addEventListener('click',()=>{
        box.innerHTML='';        // looks exactly like a successful send
      });
    </script>`, { waitMs: 22000 });
  check("nothing was actually submitted", r.submits === 0, `submits=${r.submits}`);
  check("the failure IS reported rather than left to time out silently",
    r.gaveUp.length === 1, JSON.stringify(r.gaveUp));
  check("and it names the real problem",
    /never reached the conversation/i.test(r.gaveUp[0] || ""), r.gaveUp[0]);
  check("a turn timeline comes with it", (r.traces[0] || "").length > 0, JSON.stringify(r.traces[0]));
  check("the timeline shows the send was attempted and the composer cleared",
    /click|enter/.test(r.traces[0] || "") && /cleared/.test(r.traces[0] || ""), r.traces[0]);
}

console.log("\nProof of submission survives stale DOM selectors (the URL changes)");
{
  /* Both engines move the tab to a per-conversation path once a turn really
   * goes out. That signal does not depend on any markup, so it keeps working
   * when a data-testid or aria-label is renamed — which is exactly how a turn
   * came to look "sent" while nothing had happened. */
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      const box=document.getElementById('prompt-textarea');
      document.getElementById('composer-submit-button').addEventListener('click',()=>{
        const t=box.innerText; box.innerHTML='';
        window.__submits++; window.__lastText=t;
        history.pushState(null,'','/c/abc-123');   // the real signal, no markup involved
      });
    </script>`, { waitMs: 14000 });
  check("submitted exactly once", r.submits === 1, `submits=${r.submits}`);
  check("no failure reported — the URL alone proved it went out",
    r.gaveUp.length === 0, JSON.stringify(r.gaveUp));
}

/* grok.com as it really is (v0.45.4 run, and grok-brain's selector map,
 * verified on grok.com in 2026-09). Every Grok turn in the run read
 * "composer … sent:url" and nothing was ever typed: the app routes a fresh
 * ?q= page to /tos-gate and back to / in the SAME document, and a path that
 * changed and got longer counted as proof the prompt went out. The page
 * also carries a hidden, aria-hidden <textarea> placeholder'd "Ask Grok
 * anything" — typing into it does nothing — beside the real composer, a
 * Tiptap/ProseMirror contenteditable inside [data-testid="chat-input"]; the
 * send control is [data-testid="chat-submit"], labelled "Submit".
 */
const GROK_PAGE = `
    <textarea placeholder="Ask Grok anything" aria-hidden="true" tabindex="-1" style="height:14px"></textarea>
    <div data-testid="chat-input"><div class="tiptap ProseMirror" contenteditable="true" role="textbox"></div></div>
    <button data-testid="chat-submit" type="submit" aria-label="Submit">send</button><div id="convo"></div>
    <script>
      window.__submits=0;
      const box=document.querySelector('.ProseMirror');
      // The app's own bounce: /tos-gate and back, same document, ?q= gone.
      setTimeout(()=>history.replaceState(null,'','/tos-gate'),300);
      setTimeout(()=>history.replaceState(null,'','/'),600);
      document.querySelector('[data-testid="chat-submit"]').addEventListener('click',()=>{
        const t=box.innerText.trim(); if(!t) return;
        box.innerHTML=''; window.__submits++; window.__lastText=t;
        if(window.__submitAt===undefined) window.__submitAt=Date.now()-(window.__t0||Date.now());
        const d=document.createElement('div'); d.setAttribute('data-testid','user-message'); d.textContent=t;
        document.getElementById('convo').appendChild(d);
        history.pushState(null,'','/c/6ca7034d-866d-404f-a776-72608a3113c6');
      });
    </script>`;

console.log("\nGrok: the app hops through /tos-gate in the same page, beside a hidden decoy textarea");
{
  const r = await run(GROK_PAGE, { grok: true, waitMs: 12000 });
  check("the prompt is typed and submitted, exactly once", r.submits === 1, `submits=${r.submits}`);
  check("into the real composer, with the right text", r.text === PROMPT, JSON.stringify(r.text));
  const tr = (r.probe || {}).trace || "";
  check("the /tos-gate hop is not taken for a send — it comes after the typing",
    tr.includes(":typed") && tr.indexOf(":sent") > tr.indexOf(":typed"), tr);
  check("the send is confirmed by the conversation opening", (r.probe || {}).sentWhy === "url" || (r.probe || {}).sentWhy === "turn",
    JSON.stringify(r.probe && r.probe.sentWhy));
}

console.log("\nA tab bounced to a login page says SO, instead of 'composer never appeared'");
{
  const page = await browser.newPage();
  await page.route("**/*", (rt) => rt.fulfill({ status: 200, contentType: "text/html", body: "<body><h1>Sign in</h1></body>" }));
  await page.goto(`https://chatgpt.com/auth/login?q=${encodeURIComponent(PROMPT)}&lcfc=1&lcfctok=T1`);
  const res = await page.evaluate(async ({ iso }) => {
    const events = [];
    window.chrome = {
      runtime: { lastError: null, sendMessage: (m, cb) => { events.push(JSON.parse(JSON.stringify(m))); if (cb) cb({ ok: true }); }, onMessage: { addListener() {} } },
      storage: { local: { get: (_k, cb) => cb && cb({}) } },
    };
    eval(iso); // eslint-disable-line no-eval
    await new Promise((r) => setTimeout(r, 4000));
    return events.filter((e) => e.type === "loader-submit-failed").map((e) => e.reason);
  }, { iso: ISO });
  await page.close();
  check("the sign-in problem is named outright", res.length === 1 && /not signed in/i.test(res[0]), JSON.stringify(res));
}

console.log("\nNothing usable on the page: report the failure, never hang silently");
{
  const r = await run(`<div>nothing usable here</div>`, { waitMs: 34000 });
  check("no submission happened", r.submits === 0, `submits=${r.submits}`);
  check("a failure reason was reported to the run", r.gaveUp.length === 1, JSON.stringify(r.gaveUp));
  check("the reason names the real problem", /composer never appeared/.test(r.gaveUp[0] || ""), r.gaveUp[0]);
  // The freeze-exemption lock (see stopLoop in content-iso.js) belongs to a
  // live turn only; one that's over must let go of it.
  check("the turn's Web Lock is released once it has given up",
    !r.locks.some((n) => n.startsWith("citoskeleton-turn-")), JSON.stringify(r.locks));
}

// Grok in a real run: the script typed, clicked, and then — with no URL
// change, no stop button it recognised and no transcript entry it could
// match — kept re-entering the prompt ("reenter", "recomposer") until it
// gave up, possibly sending it several times. The page's own submit request
// is proof on the wire; content-main.js reports it as "engine-submit". This
// page shows NOTHING after a send except that report.
console.log("\nA send confirmed only by the engine's own submit request");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>
      document.documentElement.setAttribute('data-lcfc-ch', 'CH-TEST');
      window.__submits = 0;
      const box = document.getElementById('prompt-textarea');
      document.getElementById('composer-submit-button').addEventListener('click', () => {
        const t = box.innerText.trim(); if (!t) return;
        window.__submits++; window.__lastText = t;
        if (window.__submitAt === undefined) window.__submitAt = Date.now() - (window.__t0 || Date.now());
        box.innerHTML = '';
        // What content-main.js posts when the engine's submit request leaves.
        window.postMessage({ __LCFC__: 'CH-TEST', type: 'engine-submit', via: 'ws' }, location.origin);
      });
    </script>`, { waitMs: 25000 });
  check("the prompt went out exactly once — no re-entering it", r.submits === 1, `submits=${r.submits}`);
  // The old code gave up on this prompt at ~22s — "send emptied the
  // composer but the prompt never reached the conversation" — after it had
  // gone out.
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
  check("the turn reads as sent, confirmed on the wire", !!r.probe && r.probe.stage === "sent" && r.probe.sentWhy === "net",
    JSON.stringify(r.probe && { stage: r.probe.stage, why: r.probe.sentWhy }));
}

// 1.0.2, a live campaign of 22 Nov 2026: ChatGPT pre-filled the box from
// ?q=, its "prepare … sent" request went out, and nothing else happened — the
// question sat in the box and the turn timed out as "sent". 3 of 5 turns.
console.log("\nChatGPT says \"prepare … sent\" but never sends: the runner presses Send");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>${RECORD_CHATGPT}
      document.documentElement.setAttribute('data-lcfc-ch', 'CH-PREP');
      const box = document.getElementById('prompt-textarea');
      const q0 = new URLSearchParams(location.search).get('q');
      setTimeout(() => {
        box.textContent = q0;  // the ?q= pre-fill
        window.postMessage({ __LCFC__: 'CH-PREP', type: 'engine-submit', via: 'prepare' }, location.origin);
      }, 300);
      document.getElementById('composer-submit-button').addEventListener('click', () => {
        const t = box.innerText.trim(); if (!t) return; box.innerHTML = ''; window.__record(t);
      });
    </script>`, { waitMs: 20000 });
  check("the question is sent, once", r.submits === 1, `submits=${r.submits}`);
  check("no failure reported", r.gaveUp.length === 0, r.gaveUp.join(","));
}

// Gemini in a real run, in a hidden tab: a click or Enter was accepted but
// acted on seconds later, and the loop — ticking every 400ms — clicked and
// pressed Enter 8-10 times before the first request left. Every one of them
// was a submission: up to nine new conversations for one prompt. This page
// takes each click/Enter and submits what was in the composer 2.5s later,
// showing nothing until then.
console.log("\nA page that acts on a send seconds later gets one send, not a burst");
{
  const r = await run(`
    <div id="prompt-textarea" contenteditable="true"></div>
    <button id="composer-submit-button">send</button><div id="convo"></div>
    <script>
      document.documentElement.setAttribute('data-lcfc-ch', 'CH-SLOW');
      window.__submits = 0;
      const box = document.getElementById('prompt-textarea');
      const accept = () => {
        const t = box.innerText.trim(); if (!t) return;
        setTimeout(() => {
          window.__submits++; window.__lastText = t;
          if (window.__submitAt === undefined) window.__submitAt = Date.now() - (window.__t0 || Date.now());
          box.innerHTML = '';
          window.postMessage({ __LCFC__: 'CH-SLOW', type: 'engine-submit', via: 'xhr' }, location.origin);
        }, 2500);
      };
      document.getElementById('composer-submit-button').addEventListener('click', accept);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') accept(); });
    </script>`, { waitMs: 12000 });
  check("the prompt was submitted once", r.submits === 1, `submits=${r.submits}`);
  check("and reads as sent", !!r.probe && r.probe.stage === "sent", JSON.stringify(r.probe && r.probe.stage));
}

await browser.close();
console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
