/*
 * upgrade-capture.test.mjs — answers asked by hand are still captured after
 * an update, on every engine (0.84.0).
 *
 * The owner: "the normal auto response capture … is getting broken with
 * each update", on ChatGPT, Gemini, Perplexity and Grok, and still broken
 * after refreshing the tab. Every other test starts from a fresh profile;
 * the owner's browser never does. Here an older release runs first in a
 * profile and captures an answer on each engine; then this build replaces
 * it in the same folder (exactly what an update does: same extension id,
 * same IndexedDB, chrome.storage and caches), the browser starts again, and
 * an answer asked by hand on each engine must be stored and shown in
 * Analyze. The engine pages are served locally under the engines' own
 * addresses and make the request the real page makes; made-up answers.
 *
 *   node test/upgrade-capture.test.mjs [--from <commit>]   (default: v0.80.0)
 *   CI also runs it --from 4d5a046: v0.36.0, the version live on the store.
 *
 * 1.0.0: until now the "update" never ran the new code. Chrome keeps an
 * extension's service-worker script in the profile, and loading a newer
 * build from a folder over it did not replace it: the worker went on
 * answering as the old release (its build-info said 0.80.0) while the pages
 * were the new ones, so every check after the update tested the old
 * background. A store update drops the old worker and registers the new
 * one; the profile's stored worker scripts are now removed between the two
 * runs to do the same, the extension's own data (IndexedDB, chrome.storage)
 * is left where it is, and the test checks the worker that answers is this
 * build.
 */
import { readFileSync, rmSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-upgrade-capture-test";
const argFrom = process.argv.indexOf("--from");
const FROM = argFrom > -1 ? process.argv[argFrom + 1] : "f2eb0f3"; // v0.80.0

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
  console.log(`\nupgrade-capture: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

/* ---------- one question per engine, the way each page asks it ---------- */
const fx = (name) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  const head = (k) => (lines.find((l) => l.startsWith(`# ${k}: `)) || "").slice(k.length + 4);
  return { url: head("url"), reqBody: head("reqBody"), body: lines.filter((l) => !l.startsWith("# ")).join("\n") };
};
const GPT = fx("chatgpt-genui-cards.txt");
const GEM = fx("gemini-streamgenerate.txt");
const GROK = fx("grok-cameraPhoneRenderTags.txt");
const PPX_ids = { backend_uuid: "b-1", context_uuid: "c-1", uuid: "u-1", frontend_context_uuid: "fc-1", frontend_uuid: "f-1" };
const ppxEvent = (fields) => `event: message\ndata: ${JSON.stringify({ ...PPX_ids, display_model: "turbo", ...fields })}\n`;
const PPX = {
  url: "https://www.perplexity.ai/rest/sse/perplexity_ask",
  reqBody: JSON.stringify({ params: { version: "2.18", language: "en-US" }, query_str: "best lamp for reading" }),
  body: [
    ppxEvent({ blocks: [{ intended_usage: "web_results", web_result_block: { progress: "DONE", web_results: [{ name: "Lamps tested", url: "https://reviews.example/lamps", snippet: "We tested ten" }] } }] }),
    ppxEvent({ blocks: [{ intended_usage: "ask_text", markdown_block: { progress: "IN_PROGRESS", chunks: ["Zento Glow ", "is the pick [1]."], chunk_starting_offset: 0 } }] }),
    ppxEvent({ text_completed: true, final_sse_message: true, blocks: [] }),
  ].join("\n"),
};
const ENGINES = [
  { id: "chatgpt", page: "https://chatgpt.com/c/0a1b2c3d", origin: "https://chatgpt.com", api: GPT, how: "fetch", type: "text/event-stream" },
  { id: "gemini", page: "https://gemini.google.com/app/0a1b2c3d4e5f6071", origin: "https://gemini.google.com", api: { ...GEM, url: `https://gemini.google.com${GEM.url}` }, how: "xhr", type: "application/x-protobuf" },
  { id: "perplexity", page: "https://www.perplexity.ai/search/0a1b2c3d", origin: "https://www.perplexity.ai", api: PPX, how: "fetch", type: "text/event-stream" },
  { id: "grok", page: "https://grok.com/c/0a1b2c3d", origin: "https://grok.com", api: GROK, how: "fetch", type: "application/json" },
];
// The second round asks different questions: the same answer again is
// folded into the first one, by design (sameAnswer). Same-length swaps, so
// Gemini's length-prefixed frames stay valid.
const SWAPS = [[/camera/g, "camara"], [/Camera/g, "Camara"], [/phone/g, "phona"], [/Zento/g, "Zentu"], [/lamp/g, "lump"]];
const vary = (s, round) => (round < 2 ? s : SWAPS.reduce((t, [re, to]) => t.replace(re, to), String(s)));
let ROUND = 1;
const apiOf = (e) => ({ ...e.api, body: vary(e.api.body, ROUND), reqBody: vary(e.api.reqBody, ROUND) });
const pageHtml = (e0) => { const e = { ...e0, api: apiOf(e0) }; return  `<!doctype html><html lang="en"><body>stub<script>
  (async () => {
    await new Promise((r) => setTimeout(r, 400));
    ${e.how === "xhr"
      ? `await new Promise((done) => { const x = new XMLHttpRequest(); x.open("POST", ${JSON.stringify(e.api.url)}); x.setRequestHeader("content-type", "application/x-www-form-urlencoded;charset=UTF-8"); x.onloadend = done; x.send(${JSON.stringify(e.api.reqBody)}); });`
      : `const r = await fetch(${JSON.stringify(e.api.url)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(e.api.reqBody)} }); const rd = r.body.getReader(); while (!(await rd.read()).done) {}`}
    document.title = "asked";
  })();
</script></body></html>`; };

async function launch(extDir, profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--headless=new", "--no-sandbox"],
  });
  for (const e of ENGINES) {
    await context.route(new RegExp(`^${e.origin.replace(/[.]/g, "\\.")}/`), (route) => {
      const u = route.request().url();
      if (u.startsWith(e.api.url.split("?")[0])) return route.fulfill({ status: 200, headers: { "content-type": e.type, "access-control-allow-origin": e.origin }, body: apiOf(e).body });
      return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(e) });
    });
  }
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
  const extId = sw.url().split("/")[2];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await panel.waitForTimeout(1500);
  const msg = (m) => panel.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  return { context, extId, panel, msg };
}

const countBy = async (msg) => {
  const recs = (((await msg({ type: "get-records" })) || {}).records || []);
  const n = {};
  for (const r of recs) n[r.platform] = (n[r.platform] || 0) + 1;
  return { n, recs };
};

async function askAll(b) {
  const before = (await countBy(b.msg)).n;
  for (const e of ENGINES) {
    const p = await b.context.newPage();
    await p.goto(e.page);
    await p.waitForFunction(() => document.title === "asked", null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(2500);
    await p.close();
  }
  await b.panel.waitForTimeout(4000);
  const after = await countBy(b.msg);
  return { gained: Object.fromEntries(ENGINES.map((e) => [e.id, (after.n[e.id] || 0) - (before[e.id] || 0)])), recs: after.recs };
}

const EXT = `${BASE}-ext`;
const PROFILE = `${BASE}-profile`;
rmSync(EXT, { recursive: true, force: true });
rmSync(PROFILE, { recursive: true, force: true });
const unpack = (rev) => {
  for (const f of (() => { try { return readdirSync(EXT); } catch (_) { return []; } })()) rmSync(path.join(EXT, f), { recursive: true, force: true });
  mkdirSync(EXT, { recursive: true });
  const tar = execFileSync("git", ["-C", ROOT, "archive", rev], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", EXT], { input: tar });
};
const version = () => JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;

let current = null;
try {
  console.log(`\nan older release first (${FROM})`);
  unpack(FROM);
  const oldVersion = version();
  current = await launch(EXT, PROFILE);
  const first = await askAll(current);
  // An older release may not read today's format on every engine (0.36
  // predates Perplexity's current stream); the default baseline must.
  if (argFrom === -1) check(`v${oldVersion} captured an answer on each engine`, ENGINES.every((e) => first.gained[e.id] >= 1), JSON.stringify(first.gained));
  else check(`v${oldVersion} captured answers before the update`, ENGINES.some((e) => first.gained[e.id] >= 1), JSON.stringify(first.gained));
  await current.context.close();
  current = null;

  console.log("\nthis build, as an update over it");
  // What a store update does and a folder reload doesn't: the old worker
  // script is dropped. The extension's data stays (see the note above).
  for (const d of ["Service Worker", "Code Cache"]) rmSync(path.join(PROFILE, "Default", d), { recursive: true, force: true });
  // Working tree, so uncommitted changes are tested too.
  for (const f of readdirSync(EXT)) rmSync(path.join(EXT, f), { recursive: true, force: true });
  for (const f of ["manifest.json", "src", "ui", "icons", "fonts", "_locales"]) cpSync(path.join(ROOT, f), path.join(EXT, f), { recursive: true });
  current = await launch(EXT, PROFILE);
  check(`updated in place: v${oldVersion} → v${version()}, same extension`, version() !== oldVersion);
  const running = await current.msg({ type: "build-info" });
  check("and the worker answering is this build, not the old one", running && running.build === version(), JSON.stringify(running));
  const kept = await countBy(current.msg);
  check("the older answers are still there", ENGINES.every((e) => (kept.n[e.id] || 0) >= first.gained[e.id]), JSON.stringify(kept.n));
  const errs = (((await current.msg({ type: "get-errors" })) || {}).errors || []).filter((x) => x.at > Date.now() - 120000);
  ROUND = 2;
  const second = await askAll(current);
  for (const e of ENGINES) check(`${e.id}: an answer asked by hand after the update is stored`, second.gained[e.id] >= 1, JSON.stringify(second.gained));
  const newest = second.recs.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0];
  const tab = await current.context.newPage();
  await tab.goto(`chrome-extension://${current.extId}/ui/panel.html?mode=tab`);
  await tab.waitForTimeout(2500);
  const shown = await tab.evaluate(() => (document.querySelector("#analyze")?.innerText || "").slice(0, 4000));
  check("and Analyze opens on the newest one", newest && shown.includes(String(newest.userPrompt || "").slice(0, 20)), `${newest && newest.userPrompt} | ${shown.slice(0, 200)}`);
  check("no errors logged by the update", errs.length === 0, JSON.stringify(errs.slice(0, 3)));
} finally {
  if (current) await current.context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
