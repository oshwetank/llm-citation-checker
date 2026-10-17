/*
 * offers.js — a product card's stores, from what ChatGPT loads when the card
 * is opened (0.62.0).
 *
 * The answer stream names a card's stores only as "Motorola India + others".
 * The list someone sees after clicking the card (store, price, link) comes
 * in a separate reply, which content-main.js passes on when it reads like
 * shopping data. Its shape isn't documented and has changed before, so this
 * looks for it rather than at a fixed path: a product (an object with a
 * title or name and an id) holding a list of objects that each name a store
 * and carry a price or a link. Anything else is ignored.
 */

const STORE_KEYS = ["merchant_name", "merchant", "seller_name", "seller", "store_name", "store", "retailer", "domain", "source", "name"];
const PRICE_KEYS = ["price_display", "formatted_price", "display_price", "price", "price_text", "amount"];
const URL_KEYS = ["url", "buy_url", "checkout_url", "link", "offer_url", "merchant_url"];
const LIST_KEYS = /^(offers|merchants|sellers|stores|retailers|merchant_offers|buy_options|purchase_options)$/i;

const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : (v && typeof v === "object" && typeof v.name === "string") ? v.name.trim() : "");
const first = (o, keys) => { for (const k of keys) { const s = str(o[k]); if (s) return s; } return ""; };
const priceOf = (o) => {
  const p = first(o, PRICE_KEYS);
  if (p) return p;
  const pr = o.price;
  if (pr && typeof pr === "object") return [str(pr.currency || pr.currency_code), str(pr.value || pr.amount)].filter(Boolean).join(" ");
  return "";
};

function offerFrom(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const merchant = first(o, STORE_KEYS);
  const url = first(o, URL_KEYS);
  const price = priceOf(o);
  if (!merchant || !(price || /^https?:\/\//i.test(url))) return null;
  return {
    merchant,
    price: price || null,
    url: /^https?:\/\//i.test(url) ? url : null,
    availability: str(o.availability || o.stock_status || (o.in_stock === true ? "In stock" : o.in_stock === false ? "Out of stock" : "")) || null,
    delivery: str(o.delivery || o.shipping || o.delivery_text) || null,
  };
}

/** Every product in the reply that lists stores, with its offers. */
export function offersFrom(json) {
  const out = [];
  const seen = new Set();
  const walk = (v, parent, depth) => {
    if (!v || typeof v !== "object" || depth > 30 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x) => walk(x, parent, depth + 1)); return; }
    for (const [k, val] of Object.entries(v)) {
      if (LIST_KEYS.test(k) && Array.isArray(val)) {
        const offers = val.map(offerFrom).filter(Boolean);
        if (offers.length) {
          out.push({ id: str(v.id || v.product_id || (parent && parent.id)) || null, title: str(v.title || v.name || v.product_name || (parent && (parent.title || parent.name))) || null, offers });
          continue;
        }
      }
      walk(val, v, depth + 1);
    }
  };
  walk(json, null, 0);
  return out;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Puts the stores on the record's product cards: by product id, then by
 * title, then (when the reply names no product and the record has one card
 * the reply's address names) by that. Returns how many cards gained stores.
 */
export function attachOffers(products, found, { path = "" } = {}) {
  let n = 0;
  const q = norm(decodeURIComponent(String(path).replace(/\+/g, " ")));
  for (const f of found) {
    let i = f.id ? products.findIndex((p) => p.id && String(p.id) === f.id) : -1;
    if (i < 0 && f.title) i = products.findIndex((p) => norm(p.name) === norm(f.title));
    if (i < 0 && f.title) i = products.findIndex((p) => norm(p.name) && (norm(f.title).includes(norm(p.name)) || norm(p.name).includes(norm(f.title))));
    if (i < 0 && q) i = products.findIndex((p) => norm(p.name) && q.includes(norm(p.name)));
    if (i < 0) continue;
    const have = products[i].offers || [];
    const key = (o) => `${norm(o.merchant)}|${o.url || ""}`;
    const merged = [...have];
    f.offers.forEach((o) => { if (!merged.some((x) => key(x) === key(o))) merged.push(o); });
    if (merged.length !== have.length) n++;
    products[i] = { ...products[i], offers: merged };
  }
  return n;
}
