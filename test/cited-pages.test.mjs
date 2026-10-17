/*
 * cited-pages.test.mjs — "Read the cited pages" (0.62.0), in a real browser.
 *
 * Reported: "Which sources name which brands" judged each page by the title
 * and snippet the engine sent. With the setting on, the extension fetches
 * the pages an answer cited (only those), reads their text on this computer
 * and matches brands against it. Here two local servers stand in for the
 * cited sites: one serves a real article, the other a bot check (and a cited
 * news page that isn't there). A page the engine only read must never be
 * fetched.
 *
 * Checks: nothing is fetched while the setting is off; with it on, only the
 * cited pages are fetched; the article is read and names the brands its text
 * names; the bot check is reported as such; Analyze says how many pages were
 * read and which grid rows come from page text; a reprocess keeps it without
 * fetching again; a page read in the last 7 days isn't fetched again.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-cited-pages-test";

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
  console.log("\ncited-pages: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported reading, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

// The made-up cited sites. CORS is open because the extension asks for site
// access only when the owner turns the setting on, which a test can't click
// through; an open page is read the same way.
const hits = [];
const ARTICLE = `<!doctype html><html lang="en"><head><title>Best camera phones under 30000</title></head><body>
<nav>Home · Phones · Deals</nav><main><article><h1>Best camera phones under 30000</h1>
${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}. We tested the Zento Nova 8 against the Kovo Edge 5 Pro in low light, daylight and video, and the Zento held detail better in the dark while the Kovo was warmer in portraits. Battery life, charging and weight were measured over a week of use.</p>`).join("\n")}
</article></main><footer>© Phone Review</footer></body></html>`;
const WALL = `<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site. Enable JavaScript and cookies to continue.</p></body></html>`;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url.startsWith("/phonereview/")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(ARTICLE); return; }
  if (req.url.startsWith("/mobilelab/")) { res.writeHead(403, { "content-type": "text/html" }); res.end(WALL); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const fixture = (name) => {
  const txt = readFileSync(path.join(HERE, "fixtures", name), "utf8")
    .replaceAll("https://phonereview.example", `http://127.0.0.1:${PORT}/phonereview`)
    .replaceAll("https://mobilelab.example", `http://localhost:${PORT}/mobilelab`)
    .replaceAll("https://technews.example", `http://localhost:${PORT}/technews`);
  const lines = txt.split(/\r?\n/);
  return { raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") };
};

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(400);
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  const seed = async (name) => {
    const { raw, reqBody } = fixture(name);
    const res = await msg({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
    if (!res || !res.captureId) throw new Error(`seeding ${name} stored nothing`);
    return res.captureId;
  };
  const record = async (id) => (await msg({ type: "get-record", captureId: id }) || {}).record || null;
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await page.waitForTimeout(250); } return null; };

  console.log("\nOff by default: nothing is fetched");
  {
    const s = await msg({ type: "settings-get" });
    check("the setting starts off", s && s.settings && s.settings.readCitedPages === false, JSON.stringify(s && s.settings));
    const id = await seed("chatgpt-genui-cards.txt");
    await page.waitForTimeout(2500);
    const r = await record(id);
    check("a capture with the setting off fetches nothing", hits.length === 0 && !r.pagesRead, JSON.stringify(hits));
  }

  console.log("\nOn: the cited pages, and only those, are read");
  let id2;
  {
    await msg({ type: "settings-set", patch: { readCitedPages: true } });
    id2 = await seed("chatgpt-genui-entity-cards.txt");
    const r = await waitFor(async () => { const x = await record(id2); return x && x.pagesRead ? x : null; });
    check("the capture's cited pages are read after it's stored", !!r, "no pagesRead after 20s");
    const paths = [...new Set(hits.map((h) => h.split("?")[0]))].sort();
    check("only the cited pages were fetched, never the read-only one", JSON.stringify(paths) === JSON.stringify(["/mobilelab/lumora-pix-3-review", "/phonereview/best-camera-phones-30000", "/technews/2026/10/phone-launches"]), JSON.stringify(paths));
    const by = (frag) => (r.sources || []).find((s) => (s.url || "").includes(frag))?.platformSpecific?.page;
    const art = by("phonereview"), wall = by("mobilelab/lumora");
    check("the article is read, with its words and the brands its text names", art && art.status === "ok" && art.words > 300 && art.brands.some((b) => b.brand === "Zento") && art.brands.some((b) => b.brand === "Kovo"), JSON.stringify(art));
    check("the bot check is reported as one, not read as the page", wall && wall.status !== "ok" && !wall.brands, JSON.stringify(wall));
    check("the record counts them", r.pagesRead.read === 1 && r.pagesRead.cited === 3, JSON.stringify(r.pagesRead));
  }

  console.log("\nAnalyze shows it");
  {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(id2)}`);
    await page.waitForTimeout(1800);
    const ui = await page.evaluate(() => {
      document.querySelectorAll("#at-sites details").forEach((d) => { d.open = true; d.dispatchEvent(new Event("toggle")); });
      return {
        bar: document.querySelector("#at-sites .at-pages-bar")?.textContent || "",
        metas: [...document.querySelectorAll("#at-sites .site-page-meta")].map((m) => m.textContent),
        basis: [...document.querySelectorAll("#analyze .at-mx-basis")].map((b) => b.textContent),
      };
    });
    check("the section says how many cited pages were read", /Cited pages read: 1 of 3/.test(ui.bar), ui.bar);
    check("each cited page says what reading it found", ui.metas.some((m) => /page read · [\d,]+ words · names .*Zento/.test(m)) && ui.metas.some((m) => /page not read: /.test(m)), JSON.stringify(ui.metas));
    check("grid rows say whether they come from page text or the snippet", ui.basis.includes("page text"), JSON.stringify(ui.basis));
  }

  console.log("\nKept, and not fetched again");
  {
    const before = hits.length;
    await msg({ type: "reprocess-all" });
    await page.waitForTimeout(1500);
    const r = await record(id2);
    check("a reprocess keeps what the pages said, without fetching", r && r.pagesRead && r.pagesRead.read === 1 && hits.length === before, `${JSON.stringify(r && r.pagesRead)} · ${hits.length - before} new requests`);
    await msg({ type: "read-cited-pages", captureId: id2 });
    const again = hits.slice(before).map((h) => h.split("?")[0]);
    check("reading again within 7 days fetches only the page that failed", !again.includes("/phonereview/best-camera-phones-30000"), JSON.stringify(again));
  }
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
