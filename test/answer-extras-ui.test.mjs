/*
 * answer-extras-ui.test.mjs — what an answer carried besides its text, on
 * screen: ChatGPT's ad, Gemini's Google Hotels card and its links, and the
 * address of every page the engine opened. Analyze (full tab and popup) and
 * the answer report.
 *
 * Reported on one "budget hotels" question asked on three engines:
 *   - "i am not able to see all the cited, featched domain and there urls"
 *   - "the format in which the answe came it was not captured" (Gemini's
 *     linked hotel names printed as "[ Hotel X ](https://…"; the report said
 *     "From memory · no search" and "No map" over a five-hotel card)
 *   - "The chatgpt puched an add in the bottom we should have a section to
 *     show that and it data"
 *
 * Seeded with the committed phone answer plus a made-up ad
 * (fixtures/chatgpt-ad-event.json), and the made-up Gemini hotel answer
 * (fixtures/gemini-hotels.txt). Fails on 0.56.0: no ad anywhere, no hotels,
 * no listing links, no page addresses.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-answer-extras-test";

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
  console.log("\nanswer-extras-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards what Analyze and the report show, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

function fixture(name) {
  const lines = readFileSync(path.join(FIXDIR, name), "utf8").split("\n");
  const reqBody = (lines.find((l) => l.startsWith("# reqBody: ")) || "").slice(11);
  return { reqBody, raw: lines.filter((l) => !l.startsWith("# ")).join("\n") };
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const base = `chrome-extension://${extId}/ui`;

  const seedPage = await context.newPage();
  await seedPage.goto(`${base}/panel.html`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
  const send = (payload) => seedPage.evaluate((p) => new Promise((r) => chrome.runtime.sendMessage({ type: "raw-conversation", payload: p }, r)), payload);
  await seedPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "demo-clear" }, r)));

  const phone = fixture("chatgpt-phone-under.txt");
  const ad = readFileSync(path.join(FIXDIR, "chatgpt-ad-event.json"), "utf8").trim();
  const gpt = await send({ raw: phone.raw.replace("data: [DONE]", `data: ${ad}\n\ndata: [DONE]`), reqBody: phone.reqBody, pageUrl: "https://chatgpt.com/c/ad-test-0001", capturedAt: Date.now() - 2 * 3600e3 });
  const hotels = fixture("gemini-hotels.txt");
  const gem = await send({ raw: hotels.raw, reqBody: hotels.reqBody, pageUrl: "https://gemini.google.com/app/hotels-test-0001", capturedAt: Date.now() - 3600e3 });
  if (!gpt || !gpt.captureId || !gem || !gem.captureId) throw new Error(`seeding stored nothing: ${JSON.stringify({ gpt, gem })}`);
  const gptRec = (await seedPage.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId: id }, r)), gpt.captureId)).record;
  await seedPage.close();

  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  const openTab = async (id) => {
    await page.goto(`${base}/panel.html?mode=tab&capture=${encodeURIComponent(id)}`);
    await page.waitForSelector("#at-answer .at-answer-text", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
  };

  console.log("\nChatGPT's ad, in the full-tab Analyze");
  await openTab(gpt.captureId);
  {
    const r = await page.evaluate(() => {
      const sec = document.getElementById("at-ads");
      const card = sec && sec.querySelector(".ad-card");
      const link = card && card.querySelector(".ad-link a");
      const inAnswer = document.querySelector("#at-answer .ad-card.compact");
      const text = document.querySelector("#at-answer .at-answer-text");
      return {
        chips: [...document.querySelectorAll("#analyze .ap-chip")].map((c) => c.textContent),
        title: sec ? sec.querySelector(".at-h").textContent : null,
        card: card ? card.innerText : "",
        href: link ? link.getAttribute("href") : null,
        inAnswer: inAnswer ? inAnswer.innerText : "",
        after: !!(inAnswer && text && (text.compareDocumentPosition(inAnswer) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    });
    check("a chip says there was an ad, and whose", r.chips.includes("Ad · Phonekart"), r.chips.join(" | "));
    check("an 'Ad shown with the answer' section", /^Ad shown with the answer/.test(r.title || ""), r.title);
    check("it names the advertiser, the label and where it sat", /Phonekart/.test(r.card) && /Sponsored/i.test(r.card) && /Below the answer/.test(r.card), r.card);
    check("what the card said", /For phones under 50,000, here's one store with current deals\./.test(r.card) && /Phones under 50,000/.test(r.card) && /Free delivery on today's top picks/.test(r.card), r.card);
    check("where it links, as a working link", r.href === "https://www.phonekart.example/deals/phones-under-50000?cip=123&oppref=gAAAAABTESTTOKEN" && /phonekart\.example/.test(r.card), r.href);
    check("what ties it to the answer", /Not named in the answer/.test(r.card) && /Its site not opened/.test(r.card), r.card);
    check("and the ad under the answer text, as ChatGPT showed it", r.after && /Phonekart/.test(r.inAnswer), r.inAnswer);
  }

  console.log("\nEvery page's address, in the full tab");
  {
    await page.evaluate(() => [...document.querySelectorAll("#at-details .at-seg-btn")].find((b) => b.textContent === "Every page it read")?.click());
    await page.waitForTimeout(400);
    await page.evaluate(() => [...document.querySelectorAll("#at-details button")].find((b) => /^Show all \d+ sources$/.test(b.textContent))?.click());
    await page.waitForTimeout(300);
    const urls = await page.evaluate(() => [...document.querySelectorAll("#at-details .src-url")].map((u) => ({ text: u.textContent, title: u.getAttribute("title") })));
    const want = gptRec.sources.map((s) => s.url);
    check(`all ${want.length} pages show their address`, urls.length === want.length, `${urls.length} of ${want.length}`);
    check("the full address on hover, readable in the line", urls.every((u) => want.includes(u.title) && !/^https?:\/\//.test(u.text) && u.text.length > 8), JSON.stringify(urls.slice(0, 2)));
  }

  console.log("\nGemini's hotel card and links, in the full tab");
  await openTab(gem.captureId);
  {
    const r = await page.evaluate(() => {
      const text = document.querySelector("#at-answer .at-answer-text");
      const links = text ? [...text.querySelectorAll("a")] : [];
      const places = document.getElementById("at-places");
      return {
        chips: [...document.querySelectorAll("#analyze .ap-chip")].map((c) => c.textContent),
        links: links.map((a) => ({ href: a.getAttribute("href"), text: a.textContent, marked: !!a.querySelector("mark.at-mark") })),
        raw: text ? text.textContent : "",
        rows: places ? places.querySelectorAll(".at-tr:not(.at-th)").length : 0,
        listing: places ? [...places.querySelectorAll("a.ap-bchip")].map((a) => [a.textContent, a.getAttribute("href")]) : [],
        kinds: places ? [...places.querySelectorAll(".at-tr:not(.at-th) .at-ellipsis")].map((c) => c.textContent) : [],
        built: document.getElementById("at-built") ? document.getElementById("at-built").innerText : "",
      };
    });
    check("not 'No web search': Gemini searched Google Hotels", !r.chips.includes("No web search") && r.chips.some((c) => /^Searched the web · 1 search$/.test(c)), r.chips.join(" | "));
    check("the map chip counts the five hotels", r.chips.includes("Map · 5 places"), r.chips.join(" | "));
    check("each linked hotel name is a link", r.links.length === 5 && r.links.every((l) => /^https:\/\/www\.google\.com\/travel\/search\?q=/.test(l.href)), JSON.stringify(r.links.map((l) => l.text)));
    check("and still marked as a brand inside its link", r.links.every((l) => l.marked), JSON.stringify(r.links));
    check("no markdown or card placeholder left in the text", !/\]\(|\[Hotel|googleusercontent\.com\/hotel_content/.test(r.raw), r.raw.slice(-120));
    check("the five hotels are listed as places", r.rows === 5, r.rows);
    check("each with its listing link", r.listing.length === 5 && r.listing.every(([t, h]) => t === "Listing" && /^https:\/\/www\.google\.com\/travel\//.test(h)), JSON.stringify(r.listing.slice(0, 1)));
    check("its class and price a night", r.kinds.includes("3-star hotel · ₹1,540"), r.kinds.join(" | "));
    check("the search shows the tool, dates and guests", /Budget hotels in Lakeport/.test(r.built) && /Google Hotels · 12 Nov – 13 Nov · 2 adults/.test(r.built), r.built.slice(0, 300));
  }

  console.log("\nThe popup");
  {
    await page.setViewportSize({ width: 540, height: 640 });
    await page.goto(`${base}/panel.html?capture=${encodeURIComponent(gpt.captureId)}`);
    await page.waitForTimeout(1800);
    const sec = await page.evaluate(() => { const s = document.getElementById("ap-ads"); return s ? s.innerText : ""; });
    check("an 'Ad shown with the answer' section with the advertiser", /Ad shown with the answer/.test(sec) && /Phonekart/.test(sec) && /phonekart\.example/.test(sec), sec);
    await page.evaluate(() => [...document.querySelectorAll(".ap-links .ap-btn")].find((b) => b.textContent === "Every page it opened")?.click());
    await page.waitForTimeout(400);
    const sheet = await page.evaluate(() => {
      const s = document.querySelector(".ap-sheet");
      return s ? { rows: s.querySelectorAll(".ap-page-row").length, urls: [...s.querySelectorAll(".src-url")].map((u) => u.getAttribute("title")), cited: s.querySelectorAll(".ap-page-row .tone-good").length } : null;
    });
    const want = gptRec.sources.map((s) => s.url);
    check("'Every page it opened' lists each page", !!sheet && sheet.rows === want.length, sheet && `${sheet.rows} of ${want.length}`);
    check("with its full address", !!sheet && want.every((u) => sheet.urls.includes(u)), sheet && sheet.urls.length);
    check("cited ones marked", !!sheet && sheet.cited === gptRec.sources.filter((s) => s.outcome === "cited").length, sheet && sheet.cited);
  }

  console.log("\nThe answer report");
  {
    const rep = await context.newPage();
    rep.on("pageerror", (e) => errors.push(`report: ${e.message || e}`));
    await rep.goto(`${base}/report.html?kind=answer&captureId=${encodeURIComponent(gpt.captureId)}`);
    await rep.waitForTimeout(2500);
    const t = await rep.evaluate(() => document.body.innerText);
    const urls = await rep.evaluate(() => [...document.querySelectorAll(".url")].map((u) => u.textContent));
    check("an 'Ad shown with the answer' card", /Ad shown with the answer/.test(t) && /Phonekart/.test(t) && /Phones under 50,000/.test(t), t.slice(0, 200));
    check("with where it links and where it sat", /phonekart\.example/.test(t) && /Below the answer/.test(t));
    check("the ad chip on the first page", /Ad · Phonekart/.test(t));
    check("every page it opened, with its address", urls.filter((u) => /^https?:\/\//.test(u)).length >= gptRec.sources.length, `${urls.length} addresses for ${gptRec.sources.length} pages`);
    await rep.goto(`${base}/report.html?kind=answer&captureId=${encodeURIComponent(gem.captureId)}`);
    await rep.waitForTimeout(2500);
    const g = await rep.evaluate(() => ({ text: document.body.innerText, links: document.querySelectorAll(".answer a[href^='https://www.google.com/travel']").length }));
    check("Gemini's report: searched, a map of five", /Searched the web · 1 search/.test(g.text) && /Map · 5 places/.test(g.text) && !/From memory/.test(g.text), g.text.slice(0, 300));
    check("its answer shows links, not markdown", g.links === 5 && !/\[ ?Hotel|\]\(https/.test(g.text), `${g.links} links`);
    check("its searches list the dates and guests", /Google Hotels · 12 Nov – 13 Nov · 2 adults/.test(g.text));
    await rep.close();
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
