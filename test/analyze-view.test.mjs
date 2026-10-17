/*
 * analyze-view.test.mjs — the popup Analyze view's content (0.47.0), as data.
 *
 * Reported on the design canvas, about the popup's Analyze screen:
 *   - "the information it provides is less" — it listed the top four brands,
 *     the top four cited sites and four truncated searches, and nothing about
 *     what backed each brand or what changed since the last answer;
 *   - "the searches (fan-out) is getting cut" — each search was squeezed into
 *     a third of a box and ended in an ellipsis.
 *
 * The redesign moved all of that into src/lib/analyzeView.js so every figure
 * can be checked here without a browser. On 0.46.0 the module doesn't exist,
 * so this file fails at import: that is the "fails on the old code" step.
 *
 * Every brand, page and prompt below is made up. The review, forum and
 * retail domains are public sites from the shared lists in brands.js.
 */
import {
  answerKind, searchesView, brandsView, pagesView, domainsView, ownBrandFor, yourBrandView,
  findPrevious, changesView, normPrompt, adsView, resultPositions, sourceBrandMatrix, productsView,
} from "../src/lib/analyzeView.js";
import { siteKindOf, isBrandSite } from "../src/lib/siteKind.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const T0 = Date.UTC(2026, 8, 26, 9, 0);
const T1 = Date.UTC(2026, 9, 2, 9, 0);
const src = (domain, title, outcome = "cited") => ({ url: `https://${domain}/p/${encodeURIComponent(title)}`, domain, title, snippet: "", outcome, type: "citation" });
const mention = (brand, count, firstIndex) => ({ brand, count, firstIndex, passages: [] });

const LONG_QUERY = "wireless headphones under 3000 rupees with forty hour battery and multipoint pairing for calls";
const current = {
  captureId: "cap-now", platform: "chatgpt", capturedAt: T1, searched: true, model: "test-model",
  userPrompt: "Best wireless headphones under 3000?",
  fanout: {
    search: [{ query: "best wireless headphones under 3000" }, { query: "Zento Pulse vs Kovo Air review" }, { query: LONG_QUERY }, { query: "Kovo Air price" }],
    shopping: [{ query: "wireless headphones" }],
    image: [],
  },
  brandMentions: [mention("Zento", 3, 10), mention("Kovo", 2, 80), mention("Lumi", 1, 160), mention("Arvo", 1, 220)],
  sources: [
    src("zento.in", "Zento Pulse wireless headphones"),
    src("smartprix.com", "Best headphones under 3000: Zento Pulse and Lumi One"),
    src("kovo.com", "Kovo Air headphones"),
    src("reddit.com", "Which budget headphones? Kovo or Zento"),
    src("amazon.in", "Wireless headphones deals"),
    src("gadgets360.com", "Lumi One review", "fetched"),
    src("91mobiles.com", "Budget headphones compared", "fetched"),
  ],
  products: [
    { name: "Zento Pulse ANC", price: "₹2,499", merchant: "Zento store + 2 more", rating: 4.2 },
    { name: "Kovo Air", price: "₹2,799", merchant: "Amazon", rating: 4.1 },
  ],
  places: [], images: [], entities: [],
};
const previous = {
  captureId: "cap-before", platform: "chatgpt", capturedAt: T0, searched: true,
  userPrompt: "best wireless headphones under 3000",
  brandMentions: [mention("Zento", 2, 5), mention("Brio", 2, 40), mention("Kovo", 1, 90)],
  sources: [src("smartprix.com", "Zento and Brio"), src("brio.co.in", "Brio site"), src("zento.in", "Zento")],
};
const own = { name: "Zento", url: "https://www.zento.in", campaign: "Headphones" };

console.log("\nanswerKind: what led the answer");
check("product cards make it a shopping answer", answerKind(current).id === "shopping");
check("places make it a local answer", answerKind({ ...current, places: [{ name: "x" }] }).id === "local");
check("no search and no pages: answered from memory", answerKind({ searched: false, sources: [] }).id === "memory");
check("searched, text only: informational", answerKind({ searched: true, sources: [src("a.com", "x")], products: [], places: [], images: [] }).id === "info");

console.log("\nSearches it ran: every query in full, in its lane, with what it was after");
{
  const v = searchesView(current, current.brandMentions.map((b) => b.brand));
  check("all five searches are listed", v.count === 5 && v.rows.length === 5, v.count);
  check("web searches first, then shopping", v.rows.map((r) => r.lane).join() === "web,web,web,web,shopping", v.rows.map((r) => r.lane).join());
  check("a long search keeps every word (nothing cut)", v.rows[2].text === LONG_QUERY, v.rows[2].text);
  check("a 'vs' search is tagged comparison", v.rows[1].tag === "comparison", v.rows[1].tag);
  check("'best … under 3000' reads as buying", v.rows[0].tag === "buying", v.rows[0].tag);
  check("a shopping search is tagged products", v.rows[4].tag === "products", v.rows[4].tag);
  check("searches naming a brand are counted (2: Zento/Kovo, Kovo)", v.namingBrand === 2, v.namingBrand);
  check("five searches is a narrow search against the published 6-12 band", v.breadth && v.breadth.band === "narrow" && v.breadth.short === "Narrow search", JSON.stringify(v.breadth));
  const g = searchesView({ searched: true, fanout: { search: [], shopping: [], image: [] }, sources: [src("a.com", "x")] }, []);
  check("searched but no queries published (Gemini): said, not shown as zero", g.unpublished === true && g.count === 0);
}

console.log("\nBrands named: every brand, what backs it, how it moved");
{
  const v = brandsView(current, { own, previous });
  const by = Object.fromEntries(v.rows.map((r) => [r.name, r]));
  check("all four brands, not the top four of more", v.rows.length === 4, v.rows.map((r) => r.name).join());
  check("in the order the answer names them", v.rows.map((r) => r.position).join() === "1,2,3,4");
  check("your brand is marked", by.Zento.isYou && !by.Kovo.isYou);
  check("Zento: an independent page plus its own site", by.Zento.backing.verdict === "independent" && by.Zento.backing.label === "2 independent + own", by.Zento.backing.label);
  check("Kovo: an independent forum thread plus its own site", by.Kovo.backing.label === "1 independent + own", by.Kovo.backing.label);
  check("Lumi: named on a cited review site", by.Lumi.backing.verdict === "independent", by.Lumi.backing.label);
  check("Arvo: nothing the engine read mentions it", by.Arvo.backing.verdict === "none" && by.Arvo.backing.label === "Nothing", by.Arvo.backing.label);
  check("Zento kept first place", by.Zento.change && by.Zento.change.kind === "same", JSON.stringify(by.Zento.change));
  check("Kovo moved up from 3rd", by.Kovo.change.kind === "up" && by.Kovo.change.from === 3, JSON.stringify(by.Kovo.change));
  check("Lumi is new", by.Lumi.change.kind === "added");
  check("Brio dropped out, and its old place is kept", v.dropped.length === 1 && v.dropped[0].name === "Brio" && v.dropped[0].was === 2, JSON.stringify(v.dropped));
  const solo = brandsView(current, { own });
  check("no previous answer: no change column", !solo.hasPrevious && solo.rows.every((r) => r.change === null));
}
{
  const ownOnly = { ...current, sources: [src("kovo.com", "Kovo Air headphones")] };
  const v = brandsView(ownOnly, {});
  check("only its own site cited: 'Own site only'", v.rows.find((r) => r.name === "Kovo").backing.label === "Own site only");
  const readOnly = { ...current, sources: [src("gadgets360.com", "Lumi One review", "fetched")] };
  check("only in pages read but not cited: 'Read, not cited'", brandsView(readOnly, {}).rows.find((r) => r.name === "Lumi").backing.label === "Read, not cited");
}

console.log("\nPages cited: each cited page, its kind, and the brands it mentions");
{
  const v = pagesView(current, { own });
  const kind = Object.fromEntries(v.rows.map((r) => [r.domain, r.kind]));
  check("five cited pages, read-only ones kept apart", v.rows.length === 5 && v.sourceCount === 7, `${v.rows.length}/${v.sourceCount}`);
  check("your own site", kind["zento.in"] === "Your site");
  check("a rival's own site", kind["kovo.com"] === "Rival brand sites", kind["kovo.com"]);
  check("a review site", kind["smartprix.com"] === "Review sites");
  check("a forum", kind["reddit.com"] === "Forums & social");
  check("a retailer", kind["amazon.in"] === "Retailers");
  check("kinds are counted in the report's order", v.kinds.map((k) => k.label).join("|") === "Your site|Rival brand sites|Review sites|Retailers|Forums & social", v.kinds.map((k) => k.label).join("|"));
  const sp = v.rows.find((r) => r.domain === "smartprix.com");
  check("a page lists the brands it mentions, yours marked", sp.brands.map((b) => b.name).sort().join() === "Lumi,Zento" && sp.brands.find((b) => b.name === "Zento").isYou, JSON.stringify(sp.brands));
  check("pages read but not cited are listed separately", v.readOnly.join() === "gadgets360.com,91mobiles.com", v.readOnly.join());
  check("no independent cited page is silent about Zento here", v.silent.length === 0, v.silent.join());
  const silentCase = pagesView({ ...current, sources: [...current.sources, src("techradar.com", "Kovo Air tested")] }, { own });
  check("a cited review page that never mentions you is flagged", silentCase.silent.join() === "techradar.com", silentCase.silent.join());
}

console.log("\nSites it used: every domain and every page, cited sites first (0.58.0)");
{
  // Reported: the domains and URLs the answer cited had all but disappeared —
  // five pages in a column, the rest folded into "+ 6 pages read but not
  // cited". Every site must be listed, with every page the engine opened.
  const withRepeat = { ...current, sources: [
    ...current.sources,
    src("gadgets360.com", "Lumi One long-term test", "fetched"),
    src("gadgets360.com", "Lumi One review"), // the same page again: one row
    src("gadgets360.com", "Lumi One review"),
  ] };
  const v = domainsView(withRepeat, { own });
  const order = v.rows.map((r) => r.domain);
  check("every site is listed, cited and read-only alike", order.length === 7, order.join());
  check("cited sites first", v.rows.slice(0, v.citedSites).every((r) => r.cited > 0) && v.rows.slice(v.citedSites).every((r) => r.cited === 0), order.join());
  check("a site cited once outranks one only read", order.indexOf("gadgets360.com") < order.indexOf("91mobiles.com"), order.join());
  const g = v.rows.find((r) => r.domain === "gadgets360.com");
  check("a site keeps every page it read there, the cited one first",
    g.pages.length === 3 && g.pages[0].cited && g.pages[0].title === "Lumi One review", JSON.stringify(g.pages));
  check("a page repeated in the capture is counted once", g.cited === 1 && g.read === 2, `${g.cited} cited · ${g.read} read`);
  check("counts of cited and read-only sites", v.citedSites === 6 && v.readOnlySites === 1, `${v.citedSites}/${v.readOnlySites}`);
  check("each site keeps its kind", v.rows.find((r) => r.domain === "zento.in").kind === "Your site");
  const pv = pagesView(withRepeat, { own });
  const nOf = (url) => v.rows.flatMap((r) => r.pages).find((p) => p.url === url && p.cited)?.n;
  check("a cited page carries the same number Pages cited gives it", pv.rows.every((r) => nOf(r.url) === r.n), pv.rows.map((r) => `${r.n}:${nOf(r.url)}`).join(" "));
  check("no sources, no rows", domainsView({ sources: [] }).rows.length === 0);
}

console.log("\nYour brand: who it is, and four numbers");
{
  const profiles = [
    { id: "p1", name: "Headphones", brand: { name: "Zento", url: "zento.in" } },
    { id: "p2", name: "Speakers", brand: { name: "Ozo", url: "" } },
  ];
  check("a campaign capture uses that campaign's brand", ownBrandFor({ ...current, geo: { profileId: "p2" } }, profiles).name === "Ozo");
  check("an ad-hoc answer that names a tracked brand uses it", ownBrandFor(current, profiles).name === "Zento");
  check("one campaign only: its brand, even when not named", ownBrandFor({ brandMentions: [] }, [profiles[1]]).name === "Ozo");
  check("several campaigns, none named: no guess", ownBrandFor({ brandMentions: [] }, profiles) === null);
  check("a deleted campaign is ignored", ownBrandFor({ brandMentions: [] }, [{ ...profiles[1], deletedAt: 1 }]) === null);

  const y = yourBrandView(current, own, { previous });
  const t = Object.fromEntries(y.tiles.map((x) => [x.key, x]));
  check("named first, with its mention count", t.answer.value === "Named first" && t.answer.sub === "×3 mentions", JSON.stringify(t.answer));
  check("cited pages that mention it", t.cited.value === "3 of 5" && t.cited.sub === "own site cited", JSON.stringify(t.cited));
  check("its product card position", t.cards.value === "Card 1 of 2", JSON.stringify(t.cards));
  check("its own store is listed on the card", t.store.value === "Listed", JSON.stringify(t.store));
  check("at most four numbers", y.tiles.length === 4);
  check("compared with last time: still first", y.since === "still named first", y.since);
  const absent = yourBrandView({ ...current, brandMentions: [mention("Kovo", 2, 1)] }, own, {});
  check("not named is said plainly", absent.tiles[0].value === "Not named", absent.tiles[0].value);
}

console.log("\nSince last time: the previous answer to the same prompt, same engine");
{
  const others = [
    previous,
    { ...previous, captureId: "other-engine", platform: "gemini", capturedAt: T0 + 1000 },
    { ...previous, captureId: "later", capturedAt: T1 + 1000 },
    { ...previous, captureId: "older", capturedAt: T0 - 86400000 },
    { ...previous, captureId: "campaign", capturedAt: T0 + 2000, geo: { profileId: "p1", promptId: "q1" } },
  ];
  check("prompt text compared loosely (case, spaces, trailing ?)", normPrompt("Best wireless headphones under 3000?") === normPrompt("best  wireless headphones under 3000"));
  check("picks the latest earlier ad-hoc answer from the same engine", findPrevious(current, others).captureId === "cap-before", (findPrevious(current, others) || {}).captureId);
  const tracked = { ...current, geo: { profileId: "p1", promptId: "q1" } };
  check("a campaign answer compares with the same campaign prompt", findPrevious(tracked, others).captureId === "campaign");
  check("nothing earlier: null", findPrevious({ ...current, capturedAt: T0 - 2 * 86400000 }, others) === null);

  const c = changesView(current, previous);
  const texts = c.items.map((i) => i.text);
  check("new brand said in words", texts.includes("Lumi is new — not named last time"), texts.join(" | "));
  check("a move up said with both places", texts.includes("Kovo moved up from 3rd to 2nd"), texts.join(" | "));
  check("a dropped brand keeps its old place", texts.includes("Brio dropped out (was 2nd)"));
  check("the leader holding first is said", texts.includes("Zento still named first"));
  check("newly cited and no-longer-cited sites", texts.some((x) => x.startsWith("Newly cited: kovo.com")) && texts.includes("No longer cited: brio.co.in"), texts.join(" | "));
}

console.log("\nads (0.60.0): where the advertiser came, the cards that sell through it, and ads that came or went");
{
  const ad = { advertiser: "Kovo", label: "Sponsored", targetDomain: "kovo.com", targetUrl: "https://kovo.com/deal", placement: "conversational_bottom" };
  const store = { advertiser: "Amazon", label: "Sponsored", targetDomain: "amazon.in" };
  const withAds = { ...current, answerText: "Zento is the pick. Kovo Air is close behind.", ads: [ad, store] };
  const v = adsView(withAds);
  check("an advertiser the answer names gets its place among the brands", v[0].place === 2 && v[0].namedInAnswer, JSON.stringify(v[0]));
  check("an advertiser the answer doesn't name has no place", v[1].place === 0);
  check("cards that list the advertiser as a store are found", v[1].onCards.length === 1 && v[1].onCards[0].name === "Kovo Air" && v[1].onCards[0].n === 2, JSON.stringify(v[1].onCards));
  check("and a brand that is no card's store has none", v[0].onCards.length === 0, JSON.stringify(v[0].onCards));
  check("its site read and cited are counted", v[0].siteRead === 1 && v[0].siteCited === 1, `${v[0].siteRead}/${v[0].siteCited}`);
  const c1 = changesView(withAds, { ...previous, ads: [] }).items.filter((i) => i.kind === "ad").map((i) => i.text);
  check("an ad that appeared since last time is a change", c1.includes("An ad from Kovo was shown (no ad last time)") && c1.includes("An ad from Amazon was shown (no ad last time)"), c1.join(" | "));
  const c2 = changesView({ ...current, ads: [] }, { ...previous, ads: [ad] }).items.filter((i) => i.kind === "ad").map((i) => i.text);
  check("and so is one that went", c2.join() === "No ad from Kovo this time (shown last time)", c2.join(" | "));
}

console.log("\nwhere each page came in the engine's results (0.60.0)");
{
  const gpt = { platform: "chatgpt", sources: [
    { url: "https://a.example/1", outcome: "cited", platformSpecific: { markerIds: ["turn0search3", "turn0search7"] } },
    { url: "https://b.example/2", outcome: "fetched", platformSpecific: { markerIds: ["turn0search0"] } },
    { url: "https://c.example/3", outcome: "cited", platformSpecific: { markerIds: ["turn0news2"] } },
    { url: "https://d.example/4", outcome: "cited", platformSpecific: {} },
  ] };
  const p = resultPositions(gpt);
  check("ChatGPT: the search ref index, counted from 1, the best one kept", p.get("https://a.example/1") === 4 && p.get("https://b.example/2") === 1, JSON.stringify([...p]));
  check("a news or unmarked page gets no position, not a guess", !p.has("https://c.example/3") && !p.has("https://d.example/4"));
  const px = resultPositions({ platform: "perplexity", sources: [
    { url: "https://e.example", platformSpecific: { sourceIndex: 0 } }, { url: "https://f.example", platformSpecific: { sourceIndex: 1 } }, { url: "https://g.example", platformSpecific: {} },
  ] });
  check("Perplexity: its source index, shifted to count from 1", px.get("https://e.example") === 1 && px.get("https://f.example") === 2 && px.get("https://g.example") === 3, JSON.stringify([...px]));
  check("Gemini publishes no results: nothing", resultPositions({ platform: "gemini", sources: [{ url: "https://h.example", outcome: "cited" }] }).size === 0);
}

console.log("\nwhere each recommendation came from: the pages, their place and date (0.60.0)");
{
  const rec = {
    ...current,
    brandMentions: [{ brand: "Zento", count: 3, firstIndex: 10, passages: ["Zento Pulse is best for long flights, with a 40-hour battery."] }, mention("Kovo", 2, 80), mention("Lumi", 1, 160)],
    sources: [
      { ...src("smartprix.com", "Best headphones under 3000: Zento Pulse and Lumi One"), platformSpecific: { markerIds: ["turn0search2"], pubDate: 1790000000 } },
      { ...src("zento.in", "Zento Pulse wireless headphones"), platformSpecific: { markerIds: ["turn0search0"] } },
      { ...src("gadgets360.com", "Lumi One review", "fetched"), platformSpecific: { markerIds: ["turn0search5"] } },
    ],
  };
  const z = brandsView(rec, { own }).rows.find((r) => r.name === "Zento");
  const pg = z.backing.pages.find((p) => p.domain === "smartprix.com");
  check("each cited page that names the brand, in full", z.backing.pages.length === 2 && !!pg && /Zento Pulse/.test(pg.title) && /^https:\/\/smartprix\.com\//.test(pg.url), JSON.stringify(z.backing.pages));
  check("with where it came in the results", pg.pos === 3 && z.backing.pages.find((p) => p.own).pos === 1, JSON.stringify(z.backing.pages.map((p) => p.pos)));
  check("and the date the engine sent, in milliseconds", pg.date === 1790000000 * 1000, pg.date);
  check("a page with no date says so with null, not today", z.backing.pages.find((p) => p.own).date === null);
  check("the brand's own site is marked", z.backing.pages.filter((p) => p.own).map((p) => p.domain).join() === "zento.in");
  const l = brandsView(rec, { own }).rows.find((r) => r.name === "Lumi");
  check("pages read but not cited are kept apart", l.backing.readPages.map((p) => p.domain).join() === "gadgets360.com" && l.backing.readPages[0].pos === 6, JSON.stringify(l.backing.readPages));
  check("what the answer said about it, in a few words", z.took.includes("Long flights") && z.took.includes("Battery"), z.took.join(" | "));
  check("a brand named without a reason has nothing there", brandsView(rec, { own }).rows.find((r) => r.name === "Kovo").took.length === 0);
}

console.log("\nwhich sources name which brands (0.60.0)");
{
  const m = sourceBrandMatrix(current, { own });
  check("columns are the brands in the order the answer named them", m.brands.map((b) => b.name).join() === "Zento,Kovo,Lumi,Arvo", m.brands.map((b) => b.name).join());
  check("your brand is marked", m.brands[0].isYou && !m.brands[1].isYou);
  const row = (d) => m.rows.find((r) => r.domain === d);
  check("a cited page naming two brands fills both", row("smartprix.com").cells.slice(0, 3).join() === "cited,,cited", row("smartprix.com").cells.join());
  check("a page only read is 'read', not 'cited'", row("gadgets360.com").cells[2] === "read", row("gadgets360.com").cells.join());
  check("a site naming none of them is left out", !row("amazon.in") && !row("91mobiles.com"), m.rows.map((r) => r.domain).join());
  check("sites with the most cited cells come first", m.rows[0].domain === "smartprix.com" || m.rows[0].domain === "reddit.com", m.rows.map((r) => r.domain).join());
  check("nothing to show: null", sourceBrandMatrix({ ...current, sources: [] }) === null);
}

console.log("\nproduct cards: stores in order, the brand's own store, pages naming each (0.60.0)");
{
  const rec = {
    ...current,
    sources: [...current.sources, src("91mobiles.com", "Kovo Air review: the best under 3000", "fetched")],
    products: [
      { name: "Zento Pulse ANC", price: "₹2,499", merchant: "Amazon + zento.in + others", rating: 4.2, reviews: 1200 },
      { name: "Kovo Air", price: "₹2,799", merchant: "Flipkart · kovo.com", rating: 4.1 },
      { name: "Lumi One", price: "₹1,999", merchant: "Amazon", rating: 3.9 },
    ],
  };
  const v = productsView(rec, { own });
  const [zp, ka, lo] = v.rows;
  check("each card's brand, from the brands the answer named", zp.brand === "Zento" && ka.brand === "Kovo" && lo.brand === "Lumi", v.rows.map((r) => r.brand).join());
  check("stores in the order the card lists them", zp.stores.map((s) => s.name).join() === "Amazon,zento.in" && zp.otherStores, JSON.stringify(zp.stores));
  check("the brand's own store is marked", zp.stores[1].own && !zp.stores[0].own && ka.stores[1].own, JSON.stringify([zp.stores, ka.stores]));
  check("your brand's card is marked", zp.isYou && !ka.isYou);
  check("cited pages naming the model, not just the brand", ka.pages.join() === "kovo.com,reddit.com" || ka.pages.join() === "kovo.com", JSON.stringify(v.rows.map((r) => r.pages)));
  check("a page only read doesn't count", !ka.pages.includes("91mobiles.com"), ka.pages.join());
  check("Lumi One is named by a cited page", lo.pages.join() === "smartprix.com", lo.pages.join());
  check("where the cards send buyers first", v.firstStores.map((s) => `${s.name} ${s.n}`).join() === "Amazon 2,Flipkart 1", JSON.stringify(v.firstStores));
  check("store links and cards with a page are counted", v.storeLinks === 5 && v.withPages === 3, `${v.storeLinks} links, ${v.withPages} with a page`);
  check("a two-letter brand only matches a whole word", productsView({ ...rec, products: [{ name: "LG Tone", merchant: "Algo Store · LG Shop" }] }, {}).rows[0].stores.map((s) => s.own).join() === "false,true");
  check("no cards: null", productsView({ ...current, products: [] }) === null);
}

console.log("\nsiteKind: brand sites matched on whole names");
check("boat-lifestyle.com is boAt's", isBrandSite("boat-lifestyle.com", "boAt"));
check("sony.co.in is Sony's (two-part suffix)", isBrandSite("sony.co.in", "Sony"));
check("in.jbl.com is JBL's (subdomain)", isBrandSite("in.jbl.com", "JBL"));
check("pineappleexpress.com is not Apple's", !isBrandSite("pineappleexpress.com", "Apple"));
check("an unknown blog stays Other", siteKindOf("someones-notes.example", { brands: ["Zento"] }) === "Other");

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
