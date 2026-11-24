/*
 * aimode-stream.mjs — synthetic Google AI Mode answer payloads (1.0.5), in
 * the shape measured live (HTML, plus JSON data islands in comments), with
 * made-up brands, sites and prices only (HANDOFF rule 1).
 */
const enc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const island = (tag, json) => `<!--${tag}|a1|b2|${enc(JSON.stringify(json))}-->`;

/**
 * @param {{prompt?: string, tag?: string, sources?: {title: string, url: string, site: string, snippet?: string}[], pills?: string[], products?: {name: string, price: string, shop: string, rating: number, reviews: string}[], body?: string, footer?: boolean, broken?: boolean}} o
 */
export function aiModePayload(o = {}) {
  const prompt = o.prompt || "best trail shoes for wide feet";
  const tag = o.tag || "QxYzAb";
  const sources = o.sources || [
    { title: "Wide-foot trail shoes tested", url: "https://reviews.example/wide-trail#:~:text=Zento", site: "Reviews Example", snippet: "We tested twelve pairs." },
    { title: "Kovo Ridge review", url: "https://gearblog.example/kovo-ridge", site: "Gear Blog", snippet: null },
  ];
  const products = o.products || [
    { name: "Zento Pathfinder 4", price: "₹9,499.00", shop: "shop.example& more", rating: 4.5, reviews: "(1.2K)" },
    { name: "Lumora Trek 2", price: "₹7,999.00", shop: "Store Example", rating: 4.2, reviews: "(85)" },
  ];
  const pills = o.pills || [sources[0].url];
  const card = (p) => `<div><div><a data-pid="p${p.name.length}"><span>${p.name}</span></a></div><div>${p.price}</div><div>${p.shop}</div><div>${p.rating}</div><div>${p.reviews}</div></div>`;
  const body = o.body || `<p>For wide feet, <strong>Zento Pathfinder 4</strong> is roomy, and the <strong>Kovo Ridge</strong> suits rocky ground.</p><h2>Top picks</h2>${products.map(card).join("")}<ul><li><strong>Best for:</strong> long days on trails.</li><li><strong>User Sentiment:</strong> rated well for comfort.</li></ul><p>The Lumora Trek 2 is the budget choice.</p>`;
  const isl = [
    island(tag, [[sources.map((s) => [s.title, s.snippet || null, "https://encrypted-tbn0.gstatic.com/faviconV2?url=x", s.url.split("/").slice(0, 3).join("/"), [s.site], s.url])]]),
    island(tag, pills.map((u, i) => [`0000000${i}-1111-2222-3333-444444444444`, ["Pill", "snippet", "https://encrypted-tbn0.gstatic.com/faviconV2?url=x", null, null, u]])),
    island(tag, products.map((p) => [1, null, [p.name, `https://encrypted-tbn1.gstatic.com/shopping?q=tbn:${p.name.length}`, p.price, null, p.rating]])),
    island(tag, [["https://shop.example", "Shop Example"], ["https://www.google.com/x", "Google"]]),
  ];
  if (o.broken) isl.push(`<!--${tag}|a|b|[{not json]-->`);
  return [
    `<style>.x{}</style><h1>Shared</h1><div>0 files</div>`,
    `<h3 data-ignore-copy>AI Mode reply for ${enc(prompt)}</h3>`,
    body,
    `<a href="/goto?url=abc">source</a>`,
    ...isl,
    o.footer === false ? "" : `<div data-snt="1">AI can make mistakes, so double-check responses</div><button>Good response</button>`,
    `<h4 data-question-header>What is your budget?</h4>`,
  ].join("");
}
export const FOLWR = (prompt) => `https://www.google.com/async/folwr?q=${encodeURIComponent(prompt)}&udm=50`;
export const FOLIF = (prompt) => `https://www.google.com/async/folif?q=${encodeURIComponent(prompt)}&udm=50`;
