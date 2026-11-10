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

/* ---------- What ChatGPT loads when a card is opened (0.62.1) ----------
 * From the owner's recording of opening every card in one answer. Opening a
 * card makes two requests, both event streams:
 *   POST /backend-api/search/product_update  {product_query, product_lookup_key}
 *     → "product_entity" events: the product ChatGPT looked up (title, price,
 *       rating, review count, pictures) and its offers (store, price, link,
 *       stock and delivery, a tag such as "Best price", the supplier code).
 *       The lookup can return something else than the card (a case for the
 *       earbuds); it is recorded as ChatGPT returned it.
 *   POST /backend-api/sidebar/conversation  {conversation_id, message_id,
 *       generic_entity_params: {category: "product_rationale_and_reviews", name}}
 *     → one message whose content_references hold the rationale ("why"),
 *       review themes with their sentiment and source, and the pages behind
 *       them (search_result_groups).
 * Using the follow-up form posts …/dil/view_state with the choices made. */

const sseEvents = (text) => {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (!d || d === "[DONE]" || d[0] !== "{") continue;
    try { out.push(JSON.parse(d)); } catch (_) { /* a partial line */ }
  }
  return out;
};
const parseBody = (b) => { try { return typeof b === "string" ? JSON.parse(b) : (b || {}); } catch (_) { return {}; } };
const s = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return null; } };
const noUtm = (u) => String(u || "").replace(/([?&])utm_[^&#]*&?/g, "$1").replace(/[?&]$/, "");

/** A product_update stream: what the lookup returned, with its stores. */
export function productUpdateFrom(responseText, requestBody) {
  const req = parseBody(requestBody);
  const query = s(req.product_query);
  let lookupIds = [];
  try { const k = JSON.parse((req.product_lookup_key && req.product_lookup_key.data) || "{}"); lookupIds = Object.values(k.all_ids || {}).flat().map(String); } catch (_) { /* none */ }
  const products = [];
  for (const ev of sseEvents(responseText)) {
    const p = ev && ev.type === "product_entity" && ev.product;
    if (!p || typeof p !== "object") continue;
    products.push({
      id: s(p.id), title: s(p.title), url: s(p.url) ? noUtm(p.url) : null, price: s(p.price),
      rating: n(p.rating), reviews: n(p.num_reviews), merchants: s(p.merchants),
      images: (Array.isArray(p.image_urls) ? p.image_urls : []).filter((u) => typeof u === "string").slice(0, 6),
      offers: (Array.isArray(p.offers) ? p.offers : []).map((o) => ({
        merchant: s(o.merchant_name) || s(o.seller_name) || host(o.url),
        price: s(o.price) || s(o.price_details && o.price_details.total),
        url: s(o.url) ? noUtm(o.url) : null,
        details: s(o.details), tag: s(o.tag && o.tag.text), available: typeof o.available === "boolean" ? o.available : null,
        provider: s(o.provider),
      })).filter((o) => o.merchant),
    });
  }
  return { query, lookupIds, products };
}

/** A sidebar/conversation stream: why ChatGPT recommends the product, what reviews say, and the pages behind both. */
export function productPanelFrom(responseText, requestBody) {
  const req = parseBody(requestBody);
  const params = req.generic_entity_params || {};
  const out = { name: s(params.name), category: s(params.category), conversationId: s(req.conversation_id), messageId: s(req.message_id), rationale: null, summary: null, reviews: [], pages: [] };
  const msgs = [];
  for (const ev of sseEvents(responseText)) {
    const m = ev && ev.v && ev.v.type === "message" ? ev.v.data : ev && ev.type === "message" ? ev.data : null;
    if (m && m.metadata) msgs.push(m);
  }
  const byRef = new Map();
  for (const m of msgs) {
    for (const g of Array.isArray(m.metadata.search_result_groups) ? m.metadata.search_result_groups : []) {
      for (const e of Array.isArray(g.entries) ? g.entries : []) {
        if (!s(e.url)) continue;
        const page = { url: noUtm(e.url), domain: host(e.url), title: s(e.title), snippet: s(e.snippet), resultSource: s(e.result_source) };
        if (!out.pages.some((x) => x.url === page.url)) out.pages.push(page);
        const r = e.ref_id;
        if (r && typeof r.ref_index === "number") byRef.set(`turn${r.turn_index || 0}${r.ref_type || "search"}${r.ref_index}`, page.url);
      }
    }
    for (const cr of Array.isArray(m.metadata.content_references) ? m.metadata.content_references : []) {
      if (cr.type === "product_rationale") {
        out.rationale = s(cr.rationale) || out.rationale;
        const g = cr.grouped_citation;
        for (const w of [g, ...((g && g.supporting_websites) || [])]) {
          if (w && s(w.url) && !out.pages.some((x) => x.url === noUtm(w.url))) out.pages.push({ url: noUtm(w.url), domain: host(w.url), title: s(w.title), snippet: s(w.snippet), resultSource: s(w.result_source) });
        }
      } else if (cr.type === "product_reviews") {
        out.summary = s(cr.summary) || out.summary;
        for (const r of Array.isArray(cr.reviews) ? cr.reviews : []) {
          out.reviews.push({ source: s(r.source), theme: s(r.theme), summary: s(r.summary), sentiment: s(r.sentiment), rating: n(r.rating), url: s(r.cite_url) || byRef.get(String(r.cite || "")) || null });
        }
      }
    }
  }
  return out;
}

/** The follow-up form's choices (…/dil/view_state, scope "root"). */
export function formChoicesFrom(requestBody) {
  const req = parseBody(requestBody);
  const root = (Array.isArray(req.updates) ? req.updates : []).filter((u) => u && u.scope === "root" && u.state && typeof u.state === "object").pop();
  if (!root) return null;
  const choices = Object.entries(root.state).filter(([, v]) => typeof v === "string" || typeof v === "boolean" || Array.isArray(v)).map(([key, value]) => ({ key, value }));
  return choices.length ? choices : null;
}

/** Which card a lookup or panel belongs to: by listing id, then by the name it was opened with. */
export function cardIndexFor(products, { ids = [], name = "" } = {}) {
  let i = ids.length ? products.findIndex((p) => p.id && ids.includes(String(p.id))) : -1;
  const q = norm(name);
  if (i < 0 && q) i = products.findIndex((p) => norm(p.name) === q);
  if (i < 0 && q) i = products.findIndex((p) => norm(p.name) && (q.includes(norm(p.name)) || norm(p.name).includes(q)));
  return i;
}
