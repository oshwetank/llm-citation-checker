/*
 * capture-pause.test.mjs — the "pause capture" switch (0.66.0).
 *
 * Asked for: "an option at the top in the popup and the full screen to stop
 * the tool from capturing the llm requests, as there are times when people
 * don't want any record of their conversations". Checks: the switch is in
 * both views and they follow each other; while paused an answer on an
 * engine page (the made-up Gemini stream from test/helpers/gemini-channel.mjs)
 * is not stored, and nothing goes to the probes or network log; the toolbar
 * icon says "off"; turned back on, the same answer is stored, marked as
 * asked from a normal (not private) window.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelStream, uploadBody } from "./helpers/gemini-channel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-capture-pause-test";

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
  console.log(`\ncapture-pause: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

const CH = "https://geminiweb-pa.clients6.google.com/v1/processSession";
const PAGE = `<!doctype html><body>stub<script>
  const xhr = (method, url, body) => new Promise((done) => { const x = new XMLHttpRequest(); x.open(method, url); x.onloadend = done; x.send(body); });
  (async () => {
    await xhr("POST", "${CH}?VER=8&RID=1&AID=0&zx=a&t=1", ${JSON.stringify(uploadBody("waterproof phone under 60000"))});
    await xhr("GET", "${CH}?VER=8&RID=rpc&SID=abc&AID=0&CI=0&TYPE=xmlhttp&zx=c&t=1");
    document.title = "done";
  })();
</script></body>`;

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  await context.route(/^https:\/\/geminiweb-pa\.clients6\.google\.com\//, (route) => route.fulfill({ status: 200, headers: { "access-control-allow-origin": "https://gemini.google.com", "access-control-allow-credentials": "true", "content-type": "text/plain" }, body: route.request().method() === "GET" ? channelStream() : "1\n0" }));
  await context.route(/^https:\/\/gemini\.google\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: PAGE }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const errors = [];
  const tab = await context.newPage();
  tab.on("pageerror", (e) => errors.push(String(e)));
  await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await tab.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await tab.waitForTimeout(800);
  const msg = (m) => tab.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const toggle = (p) => p.evaluate(() => { const b = document.getElementById("capToggle"); return b && { on: b.getAttribute("aria-checked"), label: b.textContent.trim(), visible: b.getBoundingClientRect().width > 0 }; });
  const ask = async () => {
    const g = await context.newPage();
    await g.goto("https://gemini.google.com/app/0a1b2c3d4e5f6071");
    await g.waitForFunction(() => document.title === "done", null, { timeout: 15000 }).catch(() => {});
    await g.waitForTimeout(3500);
    await g.close();
  };
  const geminiCount = async () => ((((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "gemini")).length;

  console.log("\nthe switch, in the tab and the popup");
  const t0 = await toggle(tab);
  check("the tab shows it, capturing", t0 && t0.visible && t0.on === "true" && t0.label === "Capturing", JSON.stringify(t0));
  const pop = await context.newPage();
  pop.on("pageerror", (e) => errors.push(String(e)));
  await pop.setViewportSize({ width: 540, height: 600 });
  await pop.goto(`chrome-extension://${extId}/ui/panel.html`);
  await pop.waitForTimeout(800);
  const p0 = await toggle(pop);
  check("so does the popup", p0 && p0.visible && p0.on === "true", JSON.stringify(p0));
  await pop.evaluate(() => document.getElementById("capToggle").click());
  await pop.waitForTimeout(600);
  const t1 = await toggle(tab);
  check("pausing in the popup pauses the tab's switch too", t1 && t1.on === "false" && t1.label === "Paused", JSON.stringify(t1));
  const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
  check("the toolbar icon says off", badge === "off", badge);

  console.log("\nwhile paused nothing is kept");
  await msg({ type: "settings-set", patch: { debugCapture: true } });
  await ask();
  check("an answer on Gemini is not stored", (await geminiCount()) === 0);
  const probes = ((await msg({ type: "get-probes" })) || {}).probes || [];
  const net = ((await msg({ type: "get-netlog" })) || {}).entries || [];
  check("nor kept as a probe, nor in the network log", probes.length === 0 && net.length === 0, `${probes.length} probes, ${net.length} log entries`);
  await msg({ type: "settings-set", patch: { debugCapture: false } });

  console.log("\nback on");
  await tab.evaluate(() => document.getElementById("capToggle").click());
  await tab.waitForTimeout(600);
  check("the switch says capturing in both", (await toggle(tab)).on === "true" && (await toggle(pop)).on === "true");
  check("the icon's badge clears", (await sw.evaluate(() => chrome.action.getBadgeText({}))) === "");
  await ask();
  const recs = (((await msg({ type: "get-records" })) || {}).records || []).filter((r) => r.platform === "gemini");
  check("the same answer is stored now", recs.length === 1, String(recs.length));
  const full = recs[0] ? ((await msg({ type: "get-record", captureId: recs[0].captureId })) || {}).record : null;
  check("marked as asked from a normal window", full && full.session && full.session.private === false && ["in", "out", "unknown"].includes(full.session.signedIn), JSON.stringify(full && full.session));

  console.log("\nan answer asked signed out, in a private window");
  {
    await tab.evaluate(async (id) => {
      const db = await new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); });
      const store = (m) => db.transaction("derived", m).objectStore("derived");
      const rec = await new Promise((res) => { const r = store("readonly").get(id); r.onsuccess = () => res(r.result); });
      rec.session = { private: true, signedIn: "out" };
      await new Promise((res) => { const r = store("readwrite").put(rec); r.onsuccess = () => res(); });
    }, recs[0].captureId);
    await tab.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${recs[0].captureId}`);
    await tab.waitForTimeout(1500);
    const chip = await tab.evaluate(() => document.querySelector("#analyze .at-chip-session")?.textContent || "");
    check("Analyze says so", chip === "Private window · Signed out", chip);
  }

  console.log("\na campaign can run signed out");
  {
    await tab.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); });
      const put = (store, v) => new Promise((res) => { const r = db.transaction(store, "readwrite").objectStore(store).put(v); r.onsuccess = () => res(); });
      const id = crypto.randomUUID();
      await put("profiles", { id, name: "Signed out test", brand: { name: "Zento", url: "zento.example" }, competitors: [], engines: ["gemini"], locked: true, createdAt: Date.now(), lastRunAt: null, deletedAt: null });
      await put("trackedPrompts", { id: crypto.randomUUID(), profileId: id, text: "waterproof phone under 60000", tags: [], active: true, createdAt: Date.now() });
    });
    await tab.reload();
    await tab.waitForTimeout(1000);
    await tab.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
    await tab.waitForTimeout(1500);
    let asked = "";
    tab.once("dialog", (d) => { asked = d.message(); d.accept(); });
    await tab.evaluate(() => document.querySelector("#cpHead .cp-run-private")?.click());
    await tab.waitForTimeout(1500);
    check("a Run signed out button asks first, saying it opens a private window", /private window, signed out/.test(asked), asked.slice(0, 160));
    const toast = await tab.evaluate(() => [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((t) => t.textContent).join(" | "));
    check("without private-window access it says how to allow it", /Allow in Incognito/.test(toast), toast.slice(0, 200));
    const running = ((await msg({ type: "loader-status" })) || {}).running;
    check("and nothing starts", !running, String(running));
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
