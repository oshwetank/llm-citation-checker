/*
 * same-answer.test.mjs — copies of one answer become one record
 * (src/lib/sameAnswer.js).
 *
 * Reported: "i only run 1 query but the tool captured multiple responses."
 * One Grok question was stored six times: three in-progress snapshots from
 * the live gateway (no text yet), the gateway's completed copy (48 pages
 * read, none marked cited), the REST copy (the fullest: 2 cited, 46 read,
 * five searches including the site: one), and a late REST copy with the text
 * but no pages, whose only "search" was the question itself. All six had the
 * same page address, grok.com/c/<conversation>?rid=<reply>. The newest copy
 * was the one Analyze and the PDF opened, so the report said "nothing
 * opened" and listed one search.
 *
 * Made-up records in that shape. Fails at import on 0.56.0 (no module).
 */
import { answerKey, sameAnswer, mergeAnswers, SAME_ANSWER_WINDOW_MS } from "../src/lib/sameAnswer.js";
import { adapt as grokAdapt, cleanPageCopy } from "../src/adapters/grok.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PAGE = "https://grok.com/c/11111111-2222-3333-4444-555555555555?rid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PROMPT = "Budget hotels in Lakeport under 3000";
const Q = ["budget hotels in Lakeport under 3000 INR", "best cheap hotels Lakeport 2024", "Lakeport hotels under ₹3000 site:booking.com OR site:makemytrip.com", "Hotel Pine Inn Lakeport price", "Summit Lakeport price under 3000"];
const pages = (n, cited = []) => Array.from({ length: n }, (_, i) => ({ url: `https://site${i}.example/hotels?utm_source=grok`, domain: `site${i}.example`, title: `Page ${i}`, outcome: cited.includes(i) ? "cited" : "fetched" }));
const T0 = 1_800_000_000_000;
const copy = (id, dt, extra) => ({ captureId: id, platform: "grok", pageUrl: PAGE, userPrompt: PROMPT, capturedAt: T0 + dt * 1000, answerText: "", answerChars: 0, sources: [], fanout: { search: [], shopping: [], image: [] }, brandMentions: [], products: [], places: [], images: [], searched: true, ...extra });
const answer = "Budget hotels in Lakeport under ₹3,000 per night are widely available. Hotel Pine Inn is a strong value pick.";

const copies = [
  copy("snap1", 0, { sources: pages(29), fanout: { search: Q.slice(0, 3).map((query) => ({ query })) } }),
  copy("snap2", 6, { sources: pages(48), fanout: { search: Q.map((query) => ({ query })) } }),
  copy("snap3", 10, { sources: pages(48), fanout: { search: Q.map((query) => ({ query })) } }),
  copy("gateway", 24, { answerText: answer.slice(0, 90), answerChars: 90, sources: pages(48), fanout: { search: Q.map((query) => ({ query })) }, brandMentions: [{ brand: "Hotel Pine Inn", count: 1 }] }),
  copy("rest", 25, { answerText: answer, answerChars: answer.length, sources: pages(48, [0, 1]).slice(0, 48), fanout: { search: Q.map((query) => ({ query })) }, brandMentions: [{ brand: "Hotel Pine Inn", count: 2 }, { brand: "MakeMyTrip", count: 1 }] }),
  copy("late", 29, { answerText: answer.slice(0, 100), answerChars: 100, fanout: { search: [{ query: PROMPT }] } }),
];

console.log("\nWhich answer a record belongs to");
{
  check("a reply id in the address names the reply", answerKey(copies[0]) === "grok|reply:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", answerKey(copies[0]));
  check("all six copies name the same answer", new Set(copies.map(answerKey)).size === 1);
  check("and fall within the window", copies.every((c) => sameAnswer(copies[0], c)));
  // A reply id names one reply however late a copy of it turns up (0.62.1:
  // reopening a chat 44 minutes on stored it again as a new answer). Only a
  // copy a week apart is left alone.
  const later = { ...copies[4], capturedAt: copies[0].capturedAt + SAME_ANSWER_WINDOW_MS + 1000 };
  check("the same reply later still is joined", sameAnswer(copies[0], later));
  const weekLater = { ...copies[4], capturedAt: copies[0].capturedAt + 8 * 24 * 3600 * 1000 };
  check("but not a week later", !sameAnswer(copies[0], weekLater));
  const chat = (prompt, url = "https://chatgpt.com/c/abc-123") => ({ platform: "chatgpt", pageUrl: url, userPrompt: prompt, capturedAt: T0 });
  check("without a reply id, the conversation and the question decide", answerKey(chat("Hotels in Lakeport")) === answerKey(chat("hotels  in lakeport")));
  check("two questions in one conversation stay apart", answerKey(chat("Hotels in Lakeport")) !== answerKey(chat("Cafes in Lakeport")));
  check("a conversation id from the engine works too", answerKey({ platform: "chatgpt", conversationId: "conv-1", userPrompt: "x", pageUrl: "https://chatgpt.com/" }) === "chatgpt|conv:conv-1|x");
  const regen = { ...chat("Hotels in Lakeport"), answerText: "Lakeport has a handful of well-reviewed budget stays near the lake, and most sit under the price you gave." };
  const first = { ...chat("Hotels in Lakeport"), answerText: "Here are budget hotels in Lakeport that fit your price, grouped by the part of town they are in, with the current rates." };
  check("a regenerated answer to the same question is its own record", !sameAnswer(first, regen));
  const sameStart = { ...first, answerText: first.answerText.slice(0, 70) + " Prices change daily, so check before you book anything at all." };
  check("even one that opens with the same words", !sameAnswer(first, sameStart));
  check("but a copy that is still streaming joins it", sameAnswer(first, { ...first, answerText: first.answerText.slice(0, 60) + "…" }) && sameAnswer(first, { ...first, answerText: "" }));
  // 1.0.2, live run of 22 Nov 2026: a card answer's copies taken while it
  // was laid out read the same for hundreds of letters, then differ where the
  // cards go ("<AsyncImage …>", then "1. BHIVE…", then "BHIVE…").
  const opening = "Bangalore has some of India's strongest coworking options for startups, from affordable founder-focused communities to premium managed offices. The best choice depends on your team size, budget and whether you need a fixed desk or a private cabin. Ranked by startup suitability, flexibility, location and workspace offering, with indicative prices that are not confirmed quotes. ";
  const early = { ...chat("Top coworking spaces"), answerText: opening + '<AsyncImage query="BHIVE Workspace HSR Layout" aspectRatio="5:4">' };
  const mid = { ...chat("Top coworking spaces"), answerText: opening + "1. BHIVE Workspace — best overall for early-stage startups, with multiple locations." };
  const done = { ...chat("Top coworking spaces"), answerText: opening + "BHIVE Workspace — best overall for early-stage startups, with multiple locations across the city and day passes from ₹499." };
  check("a card answer's copies taken mid-layout are one answer", sameAnswer(early, mid) && sameAnswer(mid, done) && sameAnswer(early, done));
  // Copies of one ChatGPT reply share its message ids even when the layout
  // made their texts open differently ("## Best home loan rates…" mid-layout,
  // "As of 22 November…" finished); a regenerated reply has ids of its own.
  const ids = (list) => ({ platformSpecific: { messageIds: list } });
  const midLayout = { ...chat("Best home loan rates"), answerText: "## Best home loan rates in India\n\n| Bank | Rate |", ...ids(["u1", "a1", "a2"]) };
  const finished = { ...chat("Best home loan rates"), answerText: "As of 22 November, the lowest advertised home loan rates start at 7.40% from two public-sector banks.", ...ids(["u1", "a1", "a2", "a3", "a4"]) };
  const regenerated = { ...chat("Best home loan rates"), answerText: "As of 22 November, the lowest advertised home loan rates start at 7.40% from two public-sector banks.", ...ids(["u1", "b1", "b2"]) };
  check("copies of one ChatGPT reply join by its message ids", sameAnswer(midLayout, finished));
  check("a regenerated reply, with ids of its own, does not", !sameAnswer(midLayout, regenerated));
  check("Perplexity's /session/ threads have a key, so their copies join", answerKey({ platform: "perplexity", pageUrl: "https://www.perplexity.ai/session/333343b7-a90a", userPrompt: "x" }) === "perplexity|path:/session/333343b7-a90a|x");
  check("nothing to go on, nothing joined", answerKey({ platform: "gemini", pageUrl: "https://gemini.google.com/app", userPrompt: "x" }) === null);
  check("different engines never join", answerKey({ ...copies[0], platform: "perplexity" }) !== answerKey(copies[0]));
}

console.log("\nSix copies become one record, the fullest");
{
  const m = mergeAnswers(copies);
  check("it keeps the earliest copy's id and time", m.captureId === "snap1" && m.capturedAt === copies[0].capturedAt, `${m.captureId} ${m.capturedAt}`);
  check("and the fullest copy's answer and brands", m.answerText === answer && m.brandMentions.length === 2, `${m.answerChars} chars, ${m.brandMentions.length} brands`);
  check("all 48 pages, each once (tracking tags ignored)", m.sources.length === 48, m.sources.length);
  check("the pages cited in any copy are cited", m.sources.filter((s) => s.outcome === "cited").length === 2);
  check("all five searches, including the site: one", m.fanout.search.length === 5 && m.fanout.search.some((q) => /site:booking\.com/.test(q.query)), m.fanout.search.map((q) => q.query).join(" | "));
  check("the late copy's echo of the question is not a search", !m.fanout.search.some((q) => q.query === PROMPT));
  check("it lists the five copies it absorbed", m.mergedFrom.length === 5 && !m.mergedFrom.includes("snap1"), m.mergedFrom.join(","));
  const again = mergeAnswers([m, copy("late2", 40, { answerText: "x", answerChars: 1 })]);
  check("merging again keeps the list and the id", again.captureId === "snap1" && again.mergedFrom.length === 6, again.mergedFrom.join(","));
}

console.log("\nCards and what a copy alone saw");
{
  const a = copy("a", 0, { answerText: answer, answerChars: answer.length, places: [{ name: "Hotel Pine Inn" }, { name: "Cedar Guest House" }] });
  const b = copy("b", 5, { places: [{ name: "Hotel Pine Inn" }, { name: "Hilltop Stays" }], ads: [{ advertiser: "Tripfinder", title: "Cheap stays" }], geo: { profileId: "p1", runId: "r1", promptId: "q1" }, runId: "r1" });
  const m = mergeAnswers([a, b]);
  check("a place seen only in one copy is kept", m.places.map((p) => p.name).join("|") === "Hotel Pine Inn|Cedar Guest House|Hilltop Stays", m.places.map((p) => p.name).join("|"));
  check("so is an ad", m.ads && m.ads.length === 1);
  check("and the campaign it belongs to", m.geo && m.geo.promptId === "q1" && m.runId === "r1");
  check("one record alone is returned as it is", mergeAnswers([a]) === a);
}

console.log("\na page-text copy made when the conversation was reopened (0.62.1)");
{
  // Reported: a prompt "Youbest good quality…" that was never asked. The
  // owner reopened the Grok conversation 44 minutes after asking; the page
  // reader sent the answer again, its prompt with Grok's hidden "You" label
  // glued on, its text with "## Grok / Worked for 19s" on top.
  const gateway = copy("gw", 0, { answerText: answer, answerChars: answer.length, sources: pages(12), brandMentions: [{ brand: "Hotel Pine Inn", count: 2 }] });
  const raw = JSON.stringify({ query: `You${PROMPT}`, text: `## Grok\n\nWorked for 19s\n${answer} More words here.`, web_results: [], status: "COMPLETED", harvestSource: "dom" });
  const late = await grokAdapt({ captureId: "page", raw, reqBody: JSON.stringify({ query: `You${PROMPT}` }), capturedAt: T0 + 44 * 60 * 1000, pageUrl: PAGE });
  check("the old copy's prompt loses the glued label, its text the page's labels", late.userPrompt === PROMPT && !/Worked for|^## Grok/.test(late.answerText), JSON.stringify([late.userPrompt, late.answerText.slice(0, 40)]));
  check("it is marked as read off the page", late.platformSpecific.pageCopy === true && late.platformSpecific.transport === "page");
  check("44 minutes later it is still the same reply", sameAnswer(gateway, late), `${answerKey(gateway)} / ${answerKey(late)}`);
  const m = mergeAnswers([gateway, late]);
  check("folded in, the network copy's prompt, text and pages win, though the page text is longer", m.captureId === "gw" && m.userPrompt === PROMPT && m.answerText === answer && m.sources.length === 12 && m.mergedFrom.includes("page"), JSON.stringify({ id: m.captureId, p: m.userPrompt, n: m.sources.length }));
  check("a prompt read since 0.62.1 (already clean) keeps a leading You", cleanPageCopy({ prompt: "Youtube or Vimeo for a course", answer: "x", promptClean: true }).prompt === "Youtube or Vimeo for a course");
  const other = copy("other", 0, { pageUrl: "https://grok.com/c/11111111-2222-3333-4444-555555555555?rid=ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee", answerText: answer, answerChars: answer.length });
  check("another reply in the same conversation stays its own answer", !sameAnswer(other, late));
}

console.log("\na Perplexity answer whose text marks its own citations (1.0.2)");
{
  // Live run, 22 Nov 2026: the network copy cites one getbelong.com page; the
  // page copy matched the site's badge and marked its second page cited too.
  const P = "https://www.perplexity.ai/search/abc-123";
  const A = "https://getbelong.com/blog/trading-apps", B = "https://getbelong.com/blog/trading-apps.md", C = "https://other.example/x";
  const src = (url, outcome) => ({ url, domain: new URL(url).host, title: url, outcome });
  const base = { platform: "perplexity", pageUrl: P, userPrompt: "which stock trading app is best for beginners in India", fanout: { search: [], shopping: [], image: [] }, brandMentions: [], products: [], places: [], images: [], searched: true };
  const text = `Zerodha suits most beginners.[[cite:${A}]] Groww is simpler to start with and has a clean app for first-time investors.`;
  const net = { ...base, captureId: "net", capturedAt: T0, answerText: text, answerChars: text.length, sources: [src(A, "cited"), src(B, "fetched"), src(C, "fetched")] };
  const pageCopy = { ...base, captureId: "page", capturedAt: T0 + 3000, answerText: "Zerodha suits most beginners. Groww is simpler.", answerChars: 46, sources: [src(A, "cited"), src(B, "cited"), src(C, "cited")] };
  const m = mergeAnswers([net, pageCopy]);
  const out = (u) => (m.sources.find((s) => s.url === u) || {}).outcome;
  check("the page the text cites stays cited", out(A) === "cited");
  check("another page of the same site is not made cited by the page copy", out(B) === "fetched", out(B));
  check("nor is any page the text doesn't cite", out(C) === "fetched", out(C));
  // Without markers in the kept text (ChatGPT, Gemini…), cited in any copy still wins.
  const plainNet = { ...net, answerText: "Zerodha suits most beginners. Groww is simpler to start with and has a clean app.", answerChars: 80 };
  const m2 = mergeAnswers([plainNet, pageCopy]);
  check("a text without its own markers still takes another copy's citations", (m2.sources.find((s) => s.url === B) || {}).outcome === "cited");
}

console.log("\na short answer's network and page copies, citing differently (1.0.2)");
{
  // Live run, 22 Nov 2026: one /session/ answer stored twice, 3 s apart — the
  // network copy citing tech.co and fitsmallbusiness.com, the page copy only
  // the second. Under 300 letters, so the shared-opening rule couldn't join them.
  const P = "https://www.perplexity.ai/session/2a0c67b8-ed0e-434b-ae2f-b5f4b44a6ef2";
  const body = "For most restaurants, Wix is the best all-around choice: it offers restaurant-focused features, customizable templates, and integrations for reservations and delivery.  If you want a dedicated restaurant platform with less setup, consider GloriaFood instead.";
  const base = { platform: "perplexity", pageUrl: P, userPrompt: "which website builder is best for a restaurant", sources: [], fanout: { search: [], shopping: [], image: [] } };
  const net = { ...base, captureId: "net", capturedAt: T0, answerText: body + "[[cite:https://tech.co/website-builders/best-restaurant-website-builder]][[cite:https://fitsmallbusiness.com/best-restaurant-website-builder/]]" };
  const page = { ...base, captureId: "page", capturedAt: T0 + 3700, answerText: body + "[[cite:https://fitsmallbusiness.com/best-restaurant-website-builder/]]" };
  check("they are one answer", sameAnswer(net, page));
  const other = { ...page, captureId: "other", answerText: "For most restaurants, Squarespace is the simplest choice for a menu site with online ordering built in." };
  check("a different answer on the same page still isn't", !sameAnswer(net, other));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
