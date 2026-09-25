/*
 * timeout-diagnostics.test.mjs — a timed-out turn says where it got to.
 *
 * Across two real runs (two browsers, v0.41.0), 57 of 57 failures were
 * recorded as the bare word "timeout", with no trace. That one word covers
 * opposite failures — a prompt that never went out, and one that went out and
 * was answered but never captured — so the diagnostics export couldn't say
 * which, or why. When a turn's watchdog now fires, the run first asks the tab
 * where the turn got to and records the answer: a specific reason, the stage,
 * the clock that drove it, and the turn's event trace.
 *
 * This drives the REAL extension end to end: a stub ChatGPT page accepts the
 * prompt (it lands in the transcript, which is how the content script
 * confirms a send) but never produces an answer the extension can capture, so
 * the real watchdog fires after its real ~90s budget. It also proves the
 * service-worker clock works through Chrome itself, not just a harness stand-
 * in: the probe must report clock=worker.
 *
 * A second prompt runs alongside it in the engine's second tab, and there the
 * stub DOES answer — with a payload the ChatGPT reader can make nothing of.
 * That is how every Grok turn actually failed once grok.com moved its chat
 * onto a WebSocket gateway: the answer was caught, read as empty, dropped as
 * "0-signal" in silence, and the turn logged as a plain timeout. Now the drop
 * is logged with the payload's shape (never its content), the timeout names
 * it, and the diagnostics export carries the payload itself.
 *
 * Grok runs alongside, on a stub page that reloads itself once after load.
 * Every Grok turn in a real v0.42 run timed out as "page script not
 * responding": the probe reached the page, but no turn was running there,
 * because the document the prompt was sent to had been replaced. The page now
 * answers for itself, and the timeout says the page reloaded and lost the
 * prompt, with how it was loaded and where it is.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-timeout-diag-test";
const PROMPT = "best phone for portrait photos under thirty thousand rupees";
// The stub answers this one with a payload no reader understands.
const UNREADABLE_PROMPT = "UNREADABLE-CASE which laptop lasts longest on battery";

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
  console.log("\ntimeout-diagnostics: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the run's only record of why a turn failed, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});

try {
  // A ChatGPT stub that takes the prompt and shows it in the transcript. For
  // the first prompt it never makes the network call an answer arrives on —
  // nothing is captured and the turn can only end by its watchdog. For the
  // second it makes that call, and the "answer" is JSON with nothing in it a
  // reader could use.
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => {
    if (/\/backend-api\/conversation/.test(route.request().url())) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hello: "world" }) });
    }
    return route.fulfill({
      status: 200, contentType: "text/html",
      body: `<body>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button">send</button><div id="convo"></div>
      <script>
        const box = document.getElementById('prompt-textarea');
        document.getElementById('composer-submit-button').addEventListener('click', () => {
          const t = box.innerText.trim(); if (!t) return;
          box.innerHTML = '';
          const d = document.createElement('div'); d.setAttribute('data-message-author-role', 'user');
          d.textContent = t; document.getElementById('convo').appendChild(d);
          if (t.includes('UNREADABLE-CASE')) fetch('/backend-api/conversation', { method: 'POST', body: '{}' });
        });
      </script></body>`,
    });
  });

  // grok.com pages. The first prompt's reloads itself once, 1.5s after load
  // — after the content script has taken the run's markers off its URL. The
  // second's hangs its renderer 2s after load: in a real v0.43 run no Grok
  // page answered the probe at all, and only what the tab itself shows from
  // outside can say anything about that.
  await context.route(/^https:\/\/grok\.com\//, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<body>grok stub<script>
      var q = new URLSearchParams(location.search).get('q') || '';
      if (q.indexOf('UNREADABLE-CASE') >= 0) {
        setTimeout(function () { for (;;) {} }, 2000);
      } else if (!sessionStorage.getItem('reloaded')) {
        sessionStorage.setItem('reloaded', '1');
        setTimeout(function () { location.reload(); }, 1500);
      }
    </script></body>`,
  }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);
  const ask = (msg) => page.evaluate(
    (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => res(r))), msg);

  const profileId = await page.evaluate(async (texts) => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, v) => new Promise((res, rej) => {
      const r = dbh.transaction(store, "readwrite").objectStore(store).put(v);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    const id = crypto.randomUUID();
    await put("profiles", {
      id, name: "Timeout Diagnostics Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt", "grok"], locked: true,
      createdAt: Date.now(), lastRunAt: Date.now(), deletedAt: null,
    });
    // Two prompts on one engine run in its two tabs at once, so both
    // watchdogs fire in the same ~90s.
    for (const text of texts) {
      await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text, tags: [], active: true, createdAt: Date.now() });
    }
    return id;
  }, [PROMPT, UNREADABLE_PROMPT]);

  await ask({ type: "error-log-clear" });
  const started = await ask({ type: "geo-run-start", profileId, skipAuthCheck: true });
  check("run started", started && started.ok, JSON.stringify(started));

  console.log("\nWaiting out the turns' real watchdogs (~90s)…");
  let entry = null;
  let unreadableEntry = null;
  let grokEntry = null;
  let hungEntry = null;
  const deadline = Date.now() + 150000;
  while ((!entry || !unreadableEntry || !grokEntry || !hungEntry) && Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const log = await ask({ type: "error-log", limit: 100 });
    const failed = ((log && log.entries) || []).filter((e) => e.where === "run:turn-failed:chatgpt");
    entry = failed.find((e) => e.message === "timeout: sent, no answer captured") || entry;
    unreadableEntry = failed.find((e) => /couldn't be read/.test(e.message)) || unreadableEntry;
    const grokFailed = ((log && log.entries) || []).filter((e) => e.where === "run:turn-failed:grok");
    grokEntry = grokFailed.find((e) => e.context && e.context.stage === "no-turn") || grokEntry;
    hungEntry = grokFailed.find((e) => e.context && e.context.stage === "no answer") || hungEntry;
  }
  const diag = await ask({ type: "get-campaign-diagnostics", profileId });
  await ask({ type: "loader-stop" });

  console.log("\nThe failure says where the turn got to");
  check("the turn was recorded as failed", !!entry);
  const ctx = (entry && entry.context) || {};
  check("with a specific reason — sent, but no answer captured — not a bare 'timeout'",
    !!entry && entry.message === "timeout: sent, no answer captured", entry && entry.message);
  check("its stage is recorded", ctx.stage === "sent", JSON.stringify(ctx.stage));
  check("the real service-worker clock drove the turn", ctx.clock === "worker", JSON.stringify(ctx.clock));
  check("its tick timing is recorded", typeof ctx.maxTickGapMs === "number" && ctx.maxTickGapMs > 0, JSON.stringify(ctx.maxTickGapMs));
  check("and the turn's event trace is attached", !!entry && /probe stage=sent/.test(entry.trace || ""), entry && entry.trace);

  console.log("\nAn answer that arrived but couldn't be read is named as such");
  check("its turn failed with that reason, not as a bare no-answer timeout", !!unreadableEntry,
    "no run:turn-failed entry mentioning an unreadable answer");
  const uctx = (unreadableEntry && unreadableEntry.context) || {};
  check("the failure carries the payload's shape", uctx.unreadableShape === "keys=hello", JSON.stringify(uctx.unreadableShape));
  check("and the shape is in its trace", !!unreadableEntry && /unreadable=keys=hello/.test(unreadableEntry.trace || ""), unreadableEntry && unreadableEntry.trace);
  const caps = await ask({ type: "error-log", limit: 100, cat: "capture" });
  const drop = ((caps && caps.entries) || []).find((e) => e.where === "capture:unreadable:chatgpt");
  check("the dropped payload is logged, not silently discarded", !!drop);
  const dctx = (drop && drop.context) || {};
  check("with the endpoint it came from", dctx.endpoint === "/backend-api/conversation", JSON.stringify(dctx.endpoint));
  check("and its shape — keys only, no values", dctx.shape === "keys=hello" && !JSON.stringify(dctx).includes("world"), JSON.stringify(dctx));
  check("and the capture's id, so the export can find it", typeof dctx.captureId === "string" && dctx.captureId.length > 10);
  const u = (diag && diag.unreadable) || [];
  const uRaw = u[0] ? await ask({ type: "get-raw", captureId: u[0].captureId }) : null;
  check("the diagnostics export includes the unreadable payload itself",
    u.length === 1 && u[0].platform === "chatgpt" && u[0].captureId === dctx.captureId && !!uRaw && String(uRaw.raw).includes('"hello"'),
    JSON.stringify({ u, raw: uRaw && String(uRaw.raw).slice(0, 40) }));

  console.log("\nA page that reloaded after the prompt started says so");
  const gctx = (grokEntry && grokEntry.context) || {};
  check("the Grok turn failed as a lost prompt, not 'page script not responding'",
    !!grokEntry && grokEntry.message === "timeout: page reloaded and lost the prompt", grokEntry && grokEntry.message);
  check("with the evidence: reloaded, without the run's markers", gctx.stage === "no-turn" && gctx.navType === "reload" && gctx.hadMarkers === false,
    JSON.stringify(gctx));
  check("and where the page is", gctx.path === "/", JSON.stringify(gctx.path));
  check("in its trace too", !!grokEntry && /nav=reload markers=no/.test(grokEntry.trace || ""), grokEntry && grokEntry.trace);
  check("with the tab's own record of the reload", !!grokEntry && /\| tab: .*L.*C.*L/.test(grokEntry.trace || ""), grokEntry && grokEntry.trace);

  console.log("\nA page that stops answering is described from outside");
  const hctx = (hungEntry && hungEntry.context) || {};
  check("the hung page's turn failed", !!hungEntry, "no failure with stage 'no answer'");
  check("after waiting the full probe window", hctx.probeMs >= 3900, hctx.probeMs);
  check("with the tab's state: loaded, not frozen or discarded", hctx.tabStatus === "complete" && hctx.frozen === false && hctx.discarded === false,
    JSON.stringify(hctx));
  check("and where it is — host and path, no query", hctx.where === "grok.com/", JSON.stringify(hctx.where));
  check("the trace carries the tab's load log", !!hungEntry && /tab=complete at=grok\.com\/ .*\| tab: \S+:L/.test(hungEntry.trace || ""), hungEntry && hungEntry.trace);
  check("and never the prompt", !!hungEntry && !/UNREADABLE|laptop/i.test(JSON.stringify(hungEntry)), hungEntry && hungEntry.trace);

  const turns = await ask({ type: "error-log", limit: 100, cat: "turn" });
  const turn = ((turns && turns.entries) || []).find((e) => e.where === "run:turn:chatgpt" && e.context && e.context.stage === "sent" && !e.context.unreadableShape);
  check("the per-turn timeline carries the same diagnosis",
    !!turn && turn.message === "timeout: sent, no answer captured" && turn.context.stage === "sent",
    turn && JSON.stringify({ m: turn.message, stage: turn.context.stage }));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
