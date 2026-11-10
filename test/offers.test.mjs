/*
 * A product card's stores, from what ChatGPT loads when the card is opened
 * (src/lib/offers.js, 0.62.0). Run: node test/offers.test.mjs
 *
 * Reported: "Products and where to buy" showed only "Kovo Store + others",
 * the stores ChatGPT lists when someone opens the card come in a separate
 * reply. Its shape isn't documented, so these are made-up replies in the
 * shapes such a reply could take; the reader must find the stores in each
 * and put them on the right card, and ignore replies that aren't stores.
 */
import { offersFrom, attachOffers, productUpdateFrom, productPanelFrom, formChoicesFrom, cardIndexFor } from "../src/lib/offers.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

const cards = () => [
  { id: "kovo-edge-5-pro", name: "Kovo Edge 5 Pro", price: "₹28,499" },
  { id: "answer-1", name: "Zento Nova 8", price: "Around ₹27,999" },
];

console.log("a product with an offers list");
{
  const reply = { product: { id: "kovo-edge-5-pro", title: "Kovo Edge 5 Pro", offers: [
    { merchant_name: "Kovo Store", price_display: "₹28,499", url: "https://kovo.example/edge5", availability: "In stock" },
    { merchant_name: "Phonekart", price_display: "₹27,999", url: "https://phonekart.example/kovo-edge-5", delivery: "Free delivery" },
    { merchant_name: "No link or price" },
  ] } };
  const found = offersFrom(reply);
  check("finds the product and its stores", found.length === 1 && found[0].id === "kovo-edge-5-pro" && found[0].offers.length === 2, JSON.stringify(found));
  check("each store with its price, link, stock and delivery", found[0].offers[1].merchant === "Phonekart" && found[0].offers[1].price === "₹27,999" && found[0].offers[1].url === "https://phonekart.example/kovo-edge-5" && found[0].offers[1].delivery === "Free delivery" && found[0].offers[0].availability === "In stock", JSON.stringify(found[0].offers));
  const p = cards();
  check("they go on the card with that product's id", attachOffers(p, found) === 1 && p[0].offers.length === 2 && !p[1].offers);
  check("the same reply twice adds nothing", attachOffers(p, found) === 0 && p[0].offers.length === 2);
}

console.log("other shapes");
{
  const nested = { data: { entity: { name: "Zento Nova 8", merchants: [{ merchant: { name: "Zento Official" }, price: { currency: "₹", value: "27,999" }, link: "https://zento.example/nova8" }] } } };
  const f = offersFrom(nested);
  check("a merchants list deeper in, with an object price", f.length === 1 && f[0].title === "Zento Nova 8" && f[0].offers[0].merchant === "Zento Official" && f[0].offers[0].price === "₹ 27,999", JSON.stringify(f));
  const p = cards();
  check("matched to the card by its title", attachOffers(p, f) === 1 && p[1].offers[0].merchant === "Zento Official");
  const bare = { sellers: [{ seller: "Phonekart", price: "₹27,500", url: "https://phonekart.example/z" }] };
  const p2 = cards();
  check("a list with no product, matched by the product named in the request", attachOffers(p2, offersFrom(bare), { path: "/backend-api/search/product?q=Zento+Nova+8" }) === 1 && p2[1].offers[0].merchant === "Phonekart", JSON.stringify(p2[1]));
}

console.log("replies that aren't stores");
{
  check("a settings reply has none", offersFrom({ settings: { theme: "dark", merchants_enabled: true } }).length === 0);
  check("a list of names without prices or links has none", offersFrom({ offers: [{ name: "Nice" }, { name: "Other" }] }).length === 0);
  const p = cards();
  check("stores for a product that isn't on any card go nowhere", attachOffers(p, offersFrom({ product: { id: "x", title: "Unrelated Phone", offers: [{ merchant_name: "Shop", url: "https://shop.example/" }] } })) === 0 && !p.some((c) => c.offers));
}

// 0.62.1: the real shapes, from the owner's recording of opening every card
// in one ChatGPT answer (not committed). Made-up products and stores here.
const sse = (...events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const updateReq = (q, id) => JSON.stringify({ product_query: q, product_lookup_key: { data: JSON.stringify({ request_query: q, all_ids: { p2: [id] }, merchant_hints: ["Kovo Store + others"] }) } });

console.log("a card opened: search/product_update");
{
  const resp = sse({ type: "__debug", data: { sonic_thread_id: "t" } }, { type: "product_entity", product: {
    id: "777", title: "Kovo Edge 5 Pro (12GB, 256GB)", url: "https://kovo.example/edge5?utm_source=chatgpt.com", price: "₹28,499", rating: 4.4, num_reviews: 1290, merchants: "Kovo Store + others",
    image_urls: ["https://images.example/a.jpg"],
    offers: [
      { merchant_name: "Kovo Store", price: "₹28,499", url: "https://kovo.example/edge5?utm_source=chatgpt.com", details: "In stock online, Free delivery", tag: { text: "Best price" }, available: true, provider: "p2" },
      { merchant_name: "Phonekart", price: "₹29,999", url: "https://phonekart.example/k5", details: "In stock online", tag: null, available: true, provider: "p2" },
    ] } });
  const u = productUpdateFrom(resp, updateReq("Kovo Edge 5 Pro", "777"));
  const got = u.products[0];
  check("the query it was opened with, and the listing id", u.query === "Kovo Edge 5 Pro" && u.lookupIds.join() === "777", JSON.stringify([u.query, u.lookupIds]));
  check("what the lookup returned: title, price, rating, reviews", got.title.startsWith("Kovo Edge 5 Pro") && got.price === "₹28,499" && got.rating === 4.4 && got.reviews === 1290, JSON.stringify(got));
  check("each store with price, link without utm, stock and delivery, tag, supplier", got.offers.length === 2 && got.offers[0].merchant === "Kovo Store" && got.offers[0].tag === "Best price" && got.offers[0].details === "In stock online, Free delivery" && got.offers[0].provider === "p2" && !/utm_/.test(got.offers[0].url), JSON.stringify(got.offers[0]));
  const cards = [{ id: "777", name: "Kovo Edge 5 Pro" }, { name: "Zento Nova 8" }];
  check("matched to its card by listing id", cardIndexFor(cards, { ids: u.lookupIds, name: u.query }) === 0);
  check("or by the name it was opened with", cardIndexFor([{ name: "Zento Nova 8" }, { name: "Kovo Edge 5 Pro" }], { name: "Kovo Edge 5 Pro" }) === 1);
  check("an empty reply is nothing", productUpdateFrom("", updateReq("x", "1")).products.length === 0);
}

console.log("a card opened: sidebar/conversation (why, reviews, pages)");
{
  const msg = { id: "m1", author: { role: "assistant" }, content: { content_type: "text", parts: ["…"] }, metadata: {
    content_references: [
      { type: "product_rationale", rationale: "The Kovo Edge 5 Pro suits buyers who want a long battery and a clean camera.", grouped_citation: { title: "Kovo Edge 5 Pro review", url: "https://phonereview.example/kovo-edge-5-pro", snippet: "Good battery.", supporting_websites: [{ title: "Edge 5 Pro long-term", url: "https://mobilelab.example/edge5", snippet: "Two weeks in.", result_source: null }] } },
      { type: "product_reviews", summary: "Reviewers like the battery; some find it heavy.", reviews: [
        { source: "Phone Review", theme: "Battery", summary: "Lasted two days.", sentiment: "positive", rating: null, cite_url: null, cite: "turn0search0" },
        { source: "Forum", theme: "Weight", summary: "Heavier than rivals.", sentiment: "negative", cite: "turn0search1" },
      ] },
    ],
    search_result_groups: [
      { type: "search_result_group", domain: "phonereview.example", entries: [{ type: "search_result", url: "https://phonereview.example/kovo-edge-5-pro?utm_source=chatgpt.com", title: "Kovo Edge 5 Pro review", snippet: "Good battery.", ref_id: { turn_index: 0, ref_type: "search", ref_index: 0 }, result_source: null }] },
      { type: "search_result_group", domain: "forum.example", entries: [{ type: "search_result", url: "https://forum.example/t/edge5", title: "Edge 5 weight?", snippet: "Heavy.", ref_id: { turn_index: 0, ref_type: "search", ref_index: 1 } }] },
    ] } };
  const resp = "event: delta_encoding\ndata: \"v1\"\n\nevent: delta\n" + sse({ p: "", o: "add", v: { type: "__debug", data: { conversation_id: "x" } }, c: 0 }) .replace("data: [DONE]\n\n", "") + "event: delta\n" + sse({ v: { type: "message", data: msg } });
  const req = JSON.stringify({ category: "generic_entity", conversation_id: "conv-1", message_id: "msg-9", generic_entity_params: { category: "product_rationale_and_reviews", name: "Kovo Edge 5 Pro" } });
  const pnl = productPanelFrom(resp, req);
  check("which product, conversation and message it is for", pnl.name === "Kovo Edge 5 Pro" && pnl.conversationId === "conv-1" && pnl.messageId === "msg-9", JSON.stringify([pnl.name, pnl.conversationId, pnl.messageId]));
  check("why ChatGPT recommends it", /long battery/.test(pnl.rationale || ""), pnl.rationale);
  check("what reviews say: theme, sentiment, source and its page", pnl.reviews.length === 2 && pnl.reviews[0].theme === "Battery" && pnl.reviews[0].sentiment === "positive" && pnl.reviews[0].url === "https://phonereview.example/kovo-edge-5-pro" && pnl.reviews[1].url === "https://forum.example/t/edge5", JSON.stringify(pnl.reviews));
  check("the pages behind the panel, once each", pnl.pages.length === 3 && pnl.pages.some((x) => x.domain === "mobilelab.example"), JSON.stringify(pnl.pages.map((x) => x.url)));
}

console.log("the follow-up form's choices: dil/view_state");
{
  check("the form's own choices", JSON.stringify(formChoicesFrom(JSON.stringify({ updates: [{ scope: "root", state: { priority: "Battery", fit: "Compact" } }] }))) === JSON.stringify([{ key: "priority", value: "Battery" }, { key: "fit", value: "Compact" }]));
  check("a widget's scroll state isn't a choice", formChoicesFrom(JSON.stringify({ updates: [{ scope: "widget", state: { 0: 0, 1: false } }] })) === null);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
