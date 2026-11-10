/*
 * screens.mjs — renders every screen of the panel with synthetic captures and
 * saves PNGs, so a layout change can be checked against the design canvas by
 * eye. Not a test (no assertions, not wired into CI); run it by hand:
 *
 *   node test/tools/screens.mjs [--out DIR] [--styles studio,classic]
 *        [--themes light,dark] [--only analyze,dashboard,...]
 *
 * Seeds only the made-up or synthetic fixtures in test/fixtures (HANDOFF rule
 * 1: never the owner's data). Uses a fresh profile each run, because a reused
 * profile keeps a stale service worker.
 */
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..", "..");
const FIXDIR = path.join(HERE, "..", "fixtures");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const OUT = arg("out", "/tmp/citoskeleton-screens-out");
const STYLES = arg("styles", "studio,classic").split(",");
const THEMES = arg("themes", "light").split(",");
const ONLY = arg("only", "").split(",").filter(Boolean);
const want = (name) => !ONLY.length || ONLY.some((o) => name.startsWith(o));
mkdirSync(OUT, { recursive: true });

const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
let pw = null;
for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
  try { pw = req(c); break; } catch (_) { /* next */ }
}
if (!pw) { console.log("playwright is not installed"); process.exit(1); }

function fixture(name) {
  const lines = readFileSync(path.join(FIXDIR, name), "utf8").split("\n");
  const head = (k) => (lines.find((l) => l.startsWith(`# ${k}: `)) || "").slice(k.length + 4);
  return { reqBody: head("reqBody"), url: head("url"), raw: lines.filter((l) => !l.startsWith("# ")).join("\n") };
}
const gptBody = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
const gemBody = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);

// [file, pageUrl, prompt override (null = the fixture's own), campaign tags or null]
const SEEDS = [
  ["chatgpt-phone-under.txt", "https://chatgpt.com/c/screens-0001", "best smartphone under 50000", ["buying"], "ad"],
  ["gemini-streamgenerate.txt", "https://gemini.google.com/app/screens-0002", "best smartphone under 50000", ["buying"]],
  ["chatgpt-tv.txt", "https://chatgpt.com/c/screens-0003", "best tv to buy", ["buying", "tv"]],
  ["chatgpt-watches.txt", "https://chatgpt.com/c/screens-0004", "new trending watch", ["watches"]],
  ["gemini-hotels.txt", "https://gemini.google.com/app/screens-0005", null, null],
  ["chatgpt-expense-apps.txt", "https://chatgpt.com/c/screens-0006", null, null],
  ["perplexity-cameraPhoneCiteMarkers.txt", "https://www.perplexity.ai/search/screens-0007", null, null],
  ["grok-cameraPhoneRenderTags.txt", "https://grok.com/c/screens-0008", null, null],
];

const SEED_CAMPAIGN = async (seeds) => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await open();
  const tx = (s, m) => db.transaction(s, m).objectStore(s);
  const all = (s) => new Promise((res) => { const r = tx(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
  const put = (s, v) => new Promise((res) => { const r = tx(s, "readwrite").put(v); r.onsuccess = () => res(); });
  const tagged = seeds.filter((s) => s[3]);
  const derived = (await all("derived")).filter((r) => tagged.some((s) => s[2] === r.userPrompt));
  const counts = new Map();
  derived.forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const own = ranked[1] || ranked[0];
  const competitors = ranked.filter((n) => n !== own).slice(0, 3);
  const profileId = crypto.randomUUID();
  await put("profiles", { id: profileId, name: "Phones India", brand: { name: own, url: own.toLowerCase().replace(/\W+/g, "") + ".com" },
    competitors: competitors.map((n) => ({ name: n, url: "" })), engines: ["chatgpt", "gemini"], locked: true,
    createdAt: Date.now() - 9e8, lastRunAt: Date.now(), deletedAt: null });
  const prompts = new Map();
  for (const [, , text, tags] of tagged) {
    if (prompts.has(text)) continue;
    const id = crypto.randomUUID();
    prompts.set(text, id);
    await put("trackedPrompts", { id, profileId, text, tags, active: true, createdAt: Date.now() - 9e8 + prompts.size });
  }
  const r1 = crypto.randomUUID(), r2 = crypto.randomUUID();
  const t1 = Date.now() - 7 * 864e5, t2 = Date.now() - 3600e3;
  for (const [id, t] of [[r1, t1], [r2, t2]]) {
    await put("geoRuns", { id, profileId, startedAt: t, finishedAt: t + 6e5, status: "done", engines: ["chatgpt", "gemini"],
      promptIds: [...prompts.values()], expected: 8, captured: derived.length, failed: 0, reasons: {} });
  }
  for (const rec of derived) {
    const promptId = prompts.get(rec.userPrompt);
    const tags = (tagged.find((s) => s[2] === rec.userPrompt) || [])[3] || [];
    await put("derived", { ...rec, capturedAt: t2 + 1000, geo: { profileId, runId: r2, promptId, tags } });
    await put("derived", { ...rec, captureId: `${rec.captureId}-r1`, capturedAt: t1 + 1000,
      brandMentions: (rec.brandMentions || []).filter((m) => m.brand !== own), geo: { profileId, runId: r1, promptId, tags } });
  }
  return { own, competitors, answers: derived.length };
};

const profile = `/tmp/citoskeleton-screens-${Date.now()}`;
rmSync(profile, { recursive: true, force: true });
const context = await pw.chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const errors = [];
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const base = `chrome-extension://${extId}/ui`;

  const seedPage = await context.newPage();
  await seedPage.goto(`${base}/panel.html`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
  await seedPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "demo-clear" }, r)));
  const ad = readFileSync(path.join(FIXDIR, "chatgpt-ad-event.json"), "utf8").trim();
  const ids = {};
  let t = Date.now() - 20 * 60e3;
  for (const [file, pageUrl, prompt, , extra] of SEEDS) {
    const f = fixture(file);
    let raw = f.raw;
    if (extra === "ad") raw = raw.replace("data: [DONE]", `data: ${ad}\n\ndata: [DONE]`);
    const reqBody = prompt ? (file.startsWith("gemini") ? gemBody(prompt) : gptBody(prompt)) : f.reqBody;
    const res = await seedPage.evaluate((p) => new Promise((r) => chrome.runtime.sendMessage({ type: "raw-conversation", payload: p }, r)),
      { raw, reqBody, pageUrl, capturedAt: (t += 60e3) });
    ids[file] = res && res.captureId;
  }
  const seeded = await seedPage.evaluate(SEED_CAMPAIGN, SEEDS);
  console.log("seeded", JSON.stringify(seeded), Object.values(ids).filter(Boolean).length, "captures");
  await seedPage.close();

  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  const shot = async (name) => {
    await page.waitForTimeout(700);
    // Clipped to the window's width: the Analyze header's backdrop strip is
    // wider than the page (body clips it), and fullPage would include it.
    const size = await page.evaluate(() => ({ w: innerWidth, h: Math.max(document.scrollingElement.scrollHeight, innerHeight) }));
    const full = !name.includes("popup");
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full, clip: full ? { x: 0, y: 0, width: size.w, height: Math.min(size.h, 9000) } : undefined });
    console.log("  saved", name);
  };
  const setLook = async (style, theme) => {
    await page.evaluate(([s, th]) => { localStorage.setItem("cito-style", s); localStorage.setItem("cito-theme", th); }, [style, theme]);
  };
  const tab = async (name) => page.evaluate((n) => document.querySelector(`[data-tab="${n}"]`)?.click(), name);

  for (const style of STYLES) {
    for (const theme of THEMES) {
      const sfx = `${style}-${theme}`;
      // Full tab.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${base}/panel.html?mode=tab`);
      await setLook(style, theme);
      for (const [file, label] of [["chatgpt-phone-under.txt", "shopping"], ["gemini-hotels.txt", "local"], ["chatgpt-expense-apps.txt", "info"],
        ["perplexity-cameraPhoneCiteMarkers.txt", "perplexity"], ["grok-cameraPhoneRenderTags.txt", "grok"]]) {
        if (!want(`analyze-tab-${label}`) || !ids[file]) continue;
        await page.goto(`${base}/panel.html?mode=tab&capture=${encodeURIComponent(ids[file])}`);
        await page.waitForTimeout(1500);
        await shot(`analyze-tab-${label}-${sfx}`);
      }
      if (want("compare-tab") && ids["chatgpt-phone-under.txt"]) {
        await page.goto(`${base}/panel.html?mode=tab&capture=${encodeURIComponent(ids["chatgpt-phone-under.txt"])}`);
        await page.waitForTimeout(1500);
        await page.evaluate(() => document.querySelector(".at-engine-tab.cmp")?.click());
        await shot(`compare-tab-${sfx}`);
      }
      if (want("dashboard-tab")) { await page.goto(`${base}/panel.html?mode=tab`); await page.waitForTimeout(800); await tab("dashboard"); await page.waitForTimeout(1200); await shot(`dashboard-tab-${sfx}`); }
      if (want("campaign-tab")) {
        await page.goto(`${base}/panel.html?mode=tab`); await page.waitForTimeout(800); await tab("loader"); await page.waitForTimeout(3000);
        await shot(`campaign-tab-${sfx}`);
        const opened = await page.evaluate(() => { const b = [...document.querySelectorAll(".cb-brand-btn")][1]; if (b) b.click(); return !!b; });
        if (opened) { await page.waitForTimeout(2500); await shot(`competitor-tab-${sfx}`); }
      }
      if (want("about-tab")) {
        await page.goto(`${base}/panel.html?mode=tab`); await page.waitForTimeout(800); await tab("about"); await page.waitForTimeout(800);
        await page.evaluate(() => [...document.querySelectorAll("#abNav button, #abNav a")].find((b) => /Settings/.test(b.textContent))?.click());
        await shot(`about-settings-tab-${sfx}`);
      }
      // Popup.
      await page.setViewportSize({ width: 540, height: 600 });
      for (const [file, label] of [["chatgpt-phone-under.txt", "shopping"], ["gemini-hotels.txt", "local"], ["chatgpt-expense-apps.txt", "info"]]) {
        if (!want(`analyze-popup-${label}`) || !ids[file]) continue;
        await page.goto(`${base}/panel.html?capture=${encodeURIComponent(ids[file])}`);
        await page.waitForTimeout(1500);
        await shot(`analyze-popup-${label}-${sfx}`);
      }
      if (want("dashboard-popup")) { await page.goto(`${base}/panel.html`); await page.waitForTimeout(800); await tab("dashboard"); await page.waitForTimeout(1200); await shot(`dashboard-popup-${sfx}`); }
      if (want("campaign-popup")) { await page.goto(`${base}/panel.html`); await page.waitForTimeout(800); await tab("loader"); await page.waitForTimeout(2500); await shot(`campaign-popup-${sfx}`); }
      if (want("about-popup")) { await page.goto(`${base}/panel.html`); await page.waitForTimeout(800); await tab("about"); await page.waitForTimeout(800); await shot(`about-popup-${sfx}`); }
    }
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
  if (errors.length) { console.log("page errors:"); errors.forEach((e) => console.log("  " + e)); }
}
