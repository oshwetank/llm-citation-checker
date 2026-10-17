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
  // "Images shown" was reported as broken (0.60.1): 120px columns under
  // 150px frames, white text on pale tints, three-line wraps.
  const im = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#at-images .at-img-card")];
    const t = cards[0]?.querySelector(".at-img-thumb")?.getBoundingClientRect();
    const kind = cards[0]?.querySelector(".at-img-kind");
    return {
      n: cards.length,
      w: Math.round(cards[0]?.getBoundingClientRect().width || 0),
      ratio: t ? +(t.width / t.height).toFixed(2) : 0,
      kindColor: kind ? getComputedStyle(kind).color : "",
      leads: cards.map((c) => c.querySelector(".at-img-lead")?.textContent.trim()),
      names: [...document.querySelectorAll("#at-answer .gu-name")].map((n) => n.textContent.trim()),
    };
  });
  check("image cards are wide, with 4:3 pictures and readable kind labels", im.n === 3 && im.w >= 160 && Math.abs(im.ratio - 4 / 3) < 0.05 && !/255, 255, 255/.test(im.kindColor), JSON.stringify(im));
  check("each picture says which page it came from", im.leads.every((l) => /shop1\.example page/.test(l)), JSON.stringify(im.leads));
  check("cards keep their own numbers", JSON.stringify(im.names) === JSON.stringify(["1. Zento Nova 8", "2. Kovo Edge 5 Pro", "3. Lumora Pix 3"]), JSON.stringify(im.names));

  // A card's stores load only when someone opens the card on ChatGPT
  // (0.62.0). The reply ChatGPT fetched is recorded against the answer it
  // followed; this one is made up, in a plausible shape.
  console.log("\nStores listed when a card was opened");
  {
    const rec = await page.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId: id }, (x) => r(x && x.record))), id);
    const body = JSON.stringify({ product: { id: "kovo-edge-5-pro", title: "Kovo Edge 5 Pro", offers: [
      { merchant_name: "Kovo Store", price_display: "₹28,499", url: "https://kovo.example/edge5" },
      { merchant_name: "Phonekart", price_display: "₹27,999", url: "https://phonekart.example/kovo-edge-5" },
    ] } });
    const sent = await page.evaluate(([conv, body]) => new Promise((r) => chrome.runtime.sendMessage({ type: "page-interaction", payload: { path: "/backend-api/shopping/product?id=kovo-edge-5-pro", method: "GET", status: 200, body, at: Date.now(), pageUrl: `https://chatgpt.com/c/${conv}` } }, r)), [rec.conversationId, body]);
    check("the reply is tied to the answer it followed", sent && sent.ok && sent.captureId === id, JSON.stringify(sent));
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(id)}`);
    await page.waitForTimeout(1800);
    const st = await page.evaluate(() => {
      const row = [...document.querySelectorAll("#at-products .at-prod-row:not(.at-th)")].find((r) => /Kovo Edge 5 Pro/.test(r.textContent));
      return { offers: [...(row ? row.querySelectorAll(".at-offer") : [])].map((a) => `${a.textContent.trim()}|${a.getAttribute("href") || ""}`), note: row ? row.querySelector(".at-offer-note")?.textContent : "" };
    });
    check("the card lists every store with its price and link", JSON.stringify(st.offers) === JSON.stringify(["1 Kovo Store ₹28,499|https://kovo.example/edge5", "2 Phonekart ₹27,999|https://phonekart.example/kovo-edge-5"]), JSON.stringify(st));
    check("and says where the list came from", /when the card was opened/.test(st.note || ""), st.note);
    await page.evaluate(() => { localStorage.setItem("cito-detail", "expert"); document.documentElement.setAttribute("data-detail", "expert"); });
    await page.evaluate(() => document.querySelector("#at-rawx > summary")?.click());
    await page.waitForFunction(() => !!document.querySelector('#at-rawx [data-section="interactions"]'), null, { timeout: 8000 }).catch(() => {});
    const raw = await page.evaluate(() => document.querySelector('#at-rawx [data-section="interactions"]')?.textContent || "");
    check("the raw breakdown has the reply in full", /Loaded after the answer/.test(raw) && /Phonekart/.test(raw), raw.slice(0, 160));
    await page.evaluate(() => { localStorage.setItem("cito-detail", "simple"); });
  }

  console.log("\nA card opened on ChatGPT: its stores, why it's recommended, what reviews say (0.62.1)");
  {
    // The shapes from the owner's recording of opening every card (not
    // committed): product_update and sidebar/conversation are event streams
    // whose request names the product, and the panel's names the message.
    const rec = await page.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId: id }, (x) => r(x && x.record))), id);
    const msgId = ((rec.platformSpecific || {}).messageIds || [])[0];
    check("the answer keeps its assistant message ids", !!msgId, JSON.stringify((rec.platformSpecific || {}).messageIds));
    const sse = (...evs) => evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    const post = (path, body, reqBody, pageUrl) => page.evaluate((p) => new Promise((r) => chrome.runtime.sendMessage({ type: "page-interaction", payload: p }, r)),
      { path, method: "POST", status: 200, body, reqBody, at: Date.now(), pageUrl });
    // Opened from a reloaded page with no conversation in its address: the
    // panel still finds its answer by the message it names.
    const panelBody = sse({ v: { type: "message", data: { id: "side-1", author: { role: "assistant" }, metadata: {
      content_references: [
        { type: "product_rationale", rationale: "The Zento Nova 8 suits buyers who shoot in low light.", grouped_citation: { title: "Nova 8 review", url: "https://phonereview.example/zento-nova-8", supporting_websites: [{ title: "Night test", url: "https://mobilelab.example/nova8-night" }] } },
        { type: "product_reviews", summary: "Reviewers praise the night camera.", reviews: [{ source: "Phone Review", theme: "Night photos", summary: "Clean shots after dark.", sentiment: "positive", cite: "turn0search0" }, { source: "Forum", theme: "Heat", summary: "Warms up in games.", sentiment: "negative", cite: "turn0search1" }] },
      ],
      search_result_groups: [{ entries: [{ url: "https://phonereview.example/zento-nova-8", title: "Nova 8 review", ref_id: { turn_index: 0, ref_type: "search", ref_index: 0 } }, { url: "https://forum.example/nova8-heat", title: "Heat?", ref_id: { turn_index: 0, ref_type: "search", ref_index: 1 } }] }],
    } } } });
    const a = await post("/backend-api/sidebar/conversation", panelBody, JSON.stringify({ category: "generic_entity", conversation_id: rec.conversationId, message_id: msgId, generic_entity_params: { category: "product_rationale_and_reviews", name: "Zento Nova 8" } }), "https://chatgpt.com/");
    check("the panel is tied to its answer by the message it names", a && a.ok && a.captureId === id, JSON.stringify(a));
    const storesBody = sse({ type: "product_entity", product: { id: "991", title: "Zento Nova 8 Case, Matte Black", price: "₹799", rating: 4.1, num_reviews: 210, offers: [
      { merchant_name: "Zento Official", price: "₹799", url: "https://zento.example/case?utm_source=chatgpt.com", details: "In stock online, Free delivery", tag: { text: "Best price" }, available: true, provider: "p2" },
      { merchant_name: "Phonekart", price: "₹899", url: "https://phonekart.example/zcase", details: "In stock online", available: true, provider: "p2" },
    ] } });
    const b = await post("/backend-api/search/product_update", storesBody, JSON.stringify({ product_query: "Zento Nova 8" }), `https://chatgpt.com/c/${rec.conversationId}`);
    check("the stores reply is tied to the same answer", b && b.ok && b.captureId === id, JSON.stringify(b));
    const c = await post(`/backend-api/conversation/${rec.conversationId}/message/${msgId}/dil/view_state`, '{"status":"success"}', JSON.stringify({ updates: [{ scope: "root", state: { priority: "Camera", budget: "Under 30k" } }] }), `https://chatgpt.com/c/${rec.conversationId}`);
    check("and the form's choices", c && c.ok, JSON.stringify(c));
    const after = await page.evaluate((id) => new Promise((r) => chrome.runtime.sendMessage({ type: "get-record", captureId: id }, (x) => r(x && x.record))), id);
    check("the record keeps the choices made in the form", JSON.stringify(after.followUpChoices) === JSON.stringify([{ key: "priority", value: "Camera" }, { key: "budget", value: "Under 30k" }]), JSON.stringify(after.followUpChoices));
    await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab&capture=${encodeURIComponent(id)}`);
    await page.waitForTimeout(1800);
    const ui = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#at-products .at-prod-row:not(.at-th)")];
      const row = rows.find((r) => /Zento Nova 8/.test(r.querySelector(".at-prod-name")?.textContent || ""));
      const more = row && row.nextElementSibling && row.nextElementSibling.classList.contains("at-prod-more") ? row.nextElementSibling : null;
      return {
        offers: [...(row ? row.querySelectorAll(".at-offer") : [])].map((o) => o.textContent.trim()),
        why: more?.querySelector(".at-prod-why")?.textContent || "",
        reviews: [...(more ? more.querySelectorAll(".at-review") : [])].map((li) => `${li.className.replace("at-review", "").trim()}|${li.querySelector("b")?.textContent}|${li.querySelector("a")?.getAttribute("href") || ""}`),
        pages: [...(more ? more.querySelectorAll(".at-prod-pages-behind a") : [])].map((x) => x.getAttribute("href")),
        mismatch: more?.querySelector(".at-prod-mismatch")?.textContent || "",
        fact: [...document.querySelectorAll("#at-products .at-fact")].map((f) => f.textContent).join(" "),
      };
    });
    check("its stores with price and ChatGPT's tag", ui.offers.length === 2 && /Zento Official ₹799/.test(ui.offers[0]) && /Best price/.test(ui.offers[0]), JSON.stringify(ui.offers));
    check("why ChatGPT recommends it", /shoot in low light/.test(ui.why), ui.why);
    check("what reviews say, each with its sentiment and page", JSON.stringify(ui.reviews) === JSON.stringify(["positive|Night photos|https://phonereview.example/zento-nova-8", "negative|Heat|https://forum.example/nova8-heat"]), JSON.stringify(ui.reviews));
    check("the pages behind the panel", ui.pages.includes("https://mobilelab.example/nova8-night") && ui.pages.includes("https://forum.example/nova8-heat"), JSON.stringify(ui.pages));
    check("a lookup that returned something else than the card says so", /returned “Zento Nova 8 Case, Matte Black”/.test(ui.mismatch), ui.mismatch);
    check("the section says how many cards were opened", /cards were opened on ChatGPT/.test(ui.fact), ui.fact);
  }

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
