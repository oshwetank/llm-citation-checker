/*
 * genui-answer-ui.test.mjs — a ChatGPT card answer on screen (0.60.1), in a
 * real browser: the full tab at 1440 × 900 and the popup at 540 × 600.
 *
 * Reported on a "best camera phone" answer: the answer panel and the PDF
 * showed the layout code itself (<row>, <Entity …/>, <Cite refs={…}/>),
 * every sentence twice, one product card of three and 0 pages cited. The
 * fixture is made up (Zento, Kovo, Lumora) in the same stream shapes; the
 * adapter side is in chatgpt-genui.test.mjs. On 0.60.0 the answer-panel,
 * product and cited checks fail.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-genui-ui-test";

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
  console.log("\ngenui-answer-ui: CANNOT RUN — playwright is not installed.");
  console.log(`This guards a reported answer, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(PROFILE_BASE, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});


try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  await context.route(/images\.openai\.com/, (r) => r.fulfill({
    status: 200, contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#89a"/></svg>',
  }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  await page.goto(`chrome-extension://${extId}/ui/panel.html`);
  await page.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await page.waitForTimeout(500);
  const fixture = readFileSync(path.join(HERE, "fixtures", "chatgpt-genui-cards.txt"), "utf8");
  const reqBody = (fixture.split(/\r?\n/).find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "");
  const raw = fixture.split(/\r?\n/).filter((l) => !l.startsWith("# ")).join("\n");
  const res = await page.evaluate(({ raw, reqBody }) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } }, resolve);
  }), { raw, reqBody });
  if (!res || !res.captureId) throw new Error(`seeding stored nothing: ${JSON.stringify(res)}`);
  const id = res.captureId;

  console.log("\nFull tab");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(id)}`);
  await page.waitForTimeout(1800);
  const tab = await page.evaluate(() => {
    const ans = document.querySelector("#at-answer .at-answer-body");
    const t = ans ? ans.innerText : "";
    return {
      text: t,
      intro: t.split("If you want the best camera under").length - 1,
      headings: [...(ans ? ans.querySelectorAll(".gu-card .gu-name") : [])].map((h) => h.textContent.trim()),
      products: [...document.querySelectorAll("#at-products .at-prod-row:not(.at-th) .at-prod-text > b")].map((b) => b.textContent),
      noListing: [...document.querySelectorAll("#at-products .at-prod-stores")].filter((s) => /no shopping listing/.test(s.textContent)).length,
      strip: document.querySelector("#analyze .at-strip")?.textContent || "",
      hero: document.querySelector("#analyze .at-hero")?.innerText || "",
    };
  });
  check("the answer panel shows no layout code", tab.text.length > 200 && !/[<>]/.test(tab.text.replace(/[≤≥]/g, "")) && !/\{@body|onClick/.test(tab.text), JSON.stringify(tab.text.slice(0, 300)));
  check("the intro is there, once", tab.intro === 1, tab.intro);
  check("the cards are drawn as cards, in order", /Zento Nova 8/.test(tab.headings[0] || "") && /Kovo Edge 5 Pro/.test(tab.headings[1] || "") && /Lumora Pix 3/.test(tab.headings[2] || ""), JSON.stringify(tab.headings));
  check("the follow-up choices are listed", /Mostly photos/.test(tab.text) && /Find my best camera phone/.test(tab.text));
  check("three product rows, in the answer's order", JSON.stringify(tab.products) === JSON.stringify(["Zento Nova 8", "Kovo Edge 5 Pro", "Lumora Pix 3"]), JSON.stringify(tab.products));
  check("cards without a listing say so", tab.noListing === 2, tab.noListing);
  check("two pages cited, and no News chip", /2 cited/.test(tab.strip) && !/News/.test(tab.hero), tab.strip);

  // The second card layout (0.60.2): product on a bold line, spec as the
  // large title, a badge, the price in a grey note, a two-question form.
  // Reported: "The answer, as ChatGPT showed it" didn't look like it at all.
  console.log("\nCards drawn as ChatGPT drew them");
  {
    const fx = readFileSync(path.join(HERE, "fixtures", "chatgpt-genui-entity-cards.txt"), "utf8").split(/\r?\n/);
    const res2 = await page.evaluate(({ raw, reqBody }) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody, pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } }, resolve);
    }), { raw: fx.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: (fx.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") });
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(res2.captureId)}`);
    await page.waitForTimeout(2000);
    const c = await page.evaluate(() => {
      const ans = document.querySelector("#at-answer .at-answer-body");
      const cards = [...ans.querySelectorAll(".gu-card")];
      return {
        names: cards.map((k) => k.querySelector(".gu-name")?.textContent.trim()),
        badges: cards.map((k) => k.querySelector(".gu-badge")?.textContent.trim() || ""),
        specs: cards.map((k) => k.querySelector(".gu-title.gu-lg")?.textContent.trim() || ""),
        pics: cards.filter((k) => { const i = k.querySelector(".gu-pic img"); return i && i.complete && i.naturalWidth > 0; }).length,
        picLeft: cards.every((k) => { const p = k.querySelector(".gu-pic").getBoundingClientRect(), b = k.querySelector(".gu-body").getBoundingClientRect(); return p.right <= b.left + 1; }),
        notes: cards.map((k) => k.querySelector(".gu-text.gu-sm")?.textContent.trim() || ""),
        chips: ans.querySelectorAll(".gu-card .at-cite").length,
        selected: [...ans.querySelectorAll(".gu-form .gu-opt.on")].map((o) => o.textContent.trim()),
        questions: [...ans.querySelectorAll(".gu-form .gu-q")].map((o) => o.textContent.trim()),
        button: ans.querySelector(".gu-form .gu-btn")?.textContent.trim() || "",
        carousel: !!ans.querySelector(".at-ans-cards"),
        products: [...document.querySelectorAll("#at-products .at-prod-row:not(.at-th) .at-prod-text > b")].map((b) => b.textContent),
      };
    });
    check("three cards named by their product", JSON.stringify(c.names) === JSON.stringify(["Zento Slate Pro", "Kovo Edge 5 Pro", "Lumora Tab 3"]), JSON.stringify(c.names));
    check("badges, specs and notes where ChatGPT put them", c.badges[0] === "Best for raw power" && c.badges[1] === "" && c.specs[0] === "Octa X9 chip · 12GB RAM" && /₹89,999/.test(c.notes[0]), JSON.stringify(c));
    check("each card has its picture, on the left", c.pics === 3 && c.picLeft, JSON.stringify({ pics: c.pics, left: c.picLeft }));
    check("citations sit in the cards as chips", c.chips >= 2, c.chips);
    check("the form shows both questions with ChatGPT's choices selected", JSON.stringify(c.selected) === JSON.stringify(["₹50,000–₹1,00,000", "Both equally"]) && c.questions.includes("Which matters more?") && c.button === "Find my tablet", JSON.stringify(c));
    check("no carousel strip repeating the cards", !c.carousel);
    check("the product rows use the same names", JSON.stringify(c.products) === JSON.stringify(c.names), JSON.stringify(c.products));
    if (process.env.SHOT) { await page.evaluate(() => document.querySelector("#at-answer .gu-card")?.scrollIntoView()); await page.waitForTimeout(300); await page.screenshot({ path: process.env.SHOT }); }
  }

  console.log("\nPopup");
  await page.setViewportSize({ width: 540, height: 600 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?capture=${encodeURIComponent(id)}`);
  await page.waitForTimeout(1500);
  const pop = await page.evaluate(() => {
    const t = document.getElementById("analyze")?.innerText || "";
    return { tags: t, hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
  check("the popup shows no layout code and doesn't scroll sideways", !/<\/?(?:row|box|Entity|Cite|AsyncImage)\b/.test(pop.tags) && !pop.hscroll, JSON.stringify(pop).slice(0, 200));
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

} catch (e) {
  failures++;
  console.log(`  ✗ crashed: ${e.stack || e}`);
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
