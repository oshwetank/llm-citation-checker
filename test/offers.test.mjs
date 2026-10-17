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
import { offersFrom, attachOffers } from "../src/lib/offers.js";

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

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
