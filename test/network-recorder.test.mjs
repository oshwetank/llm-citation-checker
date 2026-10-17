/*
 * network-recorder.test.mjs — the network recorder (0.62.0), in a real browser.
 *
 * Reported: Gemini, Perplexity and Grok stopped being captured, and the
 * diagnostic report couldn't say why: the extension kept only the requests
 * its patterns matched and logged nothing about the rest. With Debug capture
 * on, an engine page's every request (fetch of any method, XHR, WebSocket,
 * EventSource) is now logged, stripped before it leaves the page, and the
 * report groups them.
 *
 * A stand-in gemini.google.com page makes the kinds of calls an engine makes:
 * the matched StreamGenerate XHR, an unmatched batchexecute, a JSON answer on
 * a path no pattern knows (with the prompt in its query and answer text in
 * its body), an event stream and a socket. Checks: nothing is logged while
 * Debug capture is off; with it on each kind is logged, ids are masked, the
 * prompt and answer text are never stored, an unmatched JSON reply keeps its
 * key names, and "Copy diagnostic report" has the table.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-network-recorder-test";

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
  console.log("\nnetwork-recorder: CANNOT RUN — playwright is not installed.");
  console.log(`This guards the capture diagnostics, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const PROMPT = "which zento phone has the sharpest night camera";
const SECRET = "Zento Nova 8 wins at night";
const PAGE = `<!doctype html><body>stub<script>
  (async () => {
    const x = new XMLHttpRequest();
    x.open("POST", "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq&_reqid=12345");
    x.send("f.req=" + encodeURIComponent(${JSON.stringify(PROMPT)}));
    await fetch("/_/BardChatUi/data/batchexecute?rpcids=ESY5D&f.sid=-4242&bl=boq", { method: "POST", body: "f.req=x" }).then((r) => r.text());
    await fetch("/api/v2/conversations/8f3a2b1c9d0e4f5a/answers?prompt=" + encodeURIComponent(${JSON.stringify(PROMPT)})).then((r) => r.text());
    await fetch("/app/c/6f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f").then((r) => r.text());
    const es = new EventSource("/api/stream/updates?token=abc");
    setTimeout(() => es.close(), 1500);
    try { const ws = new WebSocket("wss://gemini.google.com/ws/live/0123456789abcdef"); ws.onerror = () => {}; } catch (_) {}
    document.title = "done";
  })();
</script></body>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.route(/^https:\/\/gemini\.google\.com\//, (route) => {
    const u = new URL(route.request().url());
    if (/StreamGenerate/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: `)]}'\n[["wrb.fr",null,"[]"]]` });
    if (/batchexecute/.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: `)]}'\n\n123\n[["wrb.fr","ESY5D","[]"]]` });
    if (/\/api\/v2\/conversations\//.test(u.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ answer_text: SECRET, sources: [{ url: "https://phonereview.example/", title: "Night test" }], conversation_id: "c1" }) });
    if (/\/api\/stream\//.test(u.pathname)) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: {"event":"tick","value":"${SECRET}"}\n\n` });
    return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  const pageErrors = [];
  panel.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const visit = async () => {
    const p = await context.newPage();
    await p.goto("https://gemini.google.com/app");
    await p.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(2500);
    await p.close(); // pagehide sends what's left of the batch
    await panel.waitForTimeout(800);
  };

  console.log("\nOff: nothing is logged");
  {
    await visit();
    const r = await msg({ type: "get-netlog" });
    check("with Debug capture off the log stays empty", r && r.ok && r.entries.length === 0, JSON.stringify(r && r.entries && r.entries.length));
  }

  console.log("\nOn: every kind of request is logged, stripped");
  let entries = [];
  {
    await msg({ type: "settings-set", patch: { debugCapture: true } });
    await visit();
    entries = ((await msg({ type: "get-netlog" })) || {}).entries || [];
    const gem = entries.filter((e) => e.page === "gemini.google.com");
    const find = (frag, kind) => gem.find((e) => e.path.includes(frag) && (!kind || e.kind === kind));
    const sg = find("StreamGenerate", "xhr");
    check("the answer XHR is logged as captured", sg && sg.matched === true && sg.method === "POST" && sg.status === 200, JSON.stringify(sg));
    const be = find("batchexecute", "fetch");
    check("an uncaptured POST is logged, query keys only, with its shape", be && !be.matched && JSON.stringify(be.q) === JSON.stringify(["bl", "f.sid", "rpcids"]) && be.shape && be.shape.form === "xssi", JSON.stringify(be));
    const ans = find("/api/v2/conversations/", "fetch");
    check("a GET on an unknown path is logged with its id masked", ans && ans.method === "GET" && ans.path === "/api/v2/conversations/:id/answers" && ans.q.join() === "prompt", JSON.stringify(ans));
    check("and its reply's key names, which say it's an answer", ans && ans.shape && ans.shape.keys.includes("answer_text") && ans.shape.keys.includes("sources"), JSON.stringify(ans && ans.shape));
    check("a uuid in a path is masked", !!find("/app/c/:id"), JSON.stringify(gem.map((e) => e.path)));
    const sse = gem.find((e) => e.kind === "sse");
    check("an EventSource is logged", sse && sse.path === "/api/stream/updates" && sse.q.join() === "token", JSON.stringify(sse));
    const ws = gem.find((e) => e.kind === "ws-open" || e.kind === "ws");
    check("a WebSocket is logged", ws && ws.host === "gemini.google.com" && ws.path === "/ws/live/:id", JSON.stringify(ws));
    const all = JSON.stringify(entries);
    check("the prompt, the answer text and query values are never stored", !all.includes("zento") && !all.includes("Zento") && !all.includes("sharpest") && !all.includes("4242") && !all.includes("ESY5D") && !all.includes("abc\""), all.slice(0, 400));
  }

  console.log("\nThe diagnostic report has the table");
  {
    await panel.reload();
    await panel.waitForTimeout(800);
    await panel.evaluate(() => document.getElementById("diagReport").click());
    await panel.waitForFunction(() => /Network seen on engine pages/.test(document.querySelector("#diag-modal-backdrop textarea")?.value || ""), null, { timeout: 8000 }).catch(() => {});
    const text = await panel.evaluate(() => document.querySelector("#diag-modal-backdrop textarea")?.value || "");
    check("grouped by engine page", /gemini\.google\.com · \d+ requests/.test(text), text.slice(-1500));
    check("an uncaptured call says so, with its keys", /\/api\/v2\/conversations\/:id\/answers\?prompt · 1× · not captured/.test(text) && /keys: [^\n]*answer_text/.test(text), text.slice(-1500));
    check("the captured call says so", /StreamGenerate\?_reqid&bl · 1× · captured 1/.test(text), text.slice(-1500));
    check("no prompt or answer text in the report", !/zento|sharpest/i.test(text));
  }

  console.log("\nCleared with everything else");
  {
    await msg({ type: "clear-all" });
    const r = await msg({ type: "get-netlog" });
    check("Clear all data empties the log", r && r.entries.length === 0);
  }
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
