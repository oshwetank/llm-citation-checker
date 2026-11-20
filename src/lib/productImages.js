/*
 * productImages.js — the picture each product card showed (1.0.1).
 *
 * The owner's "best phone in the world" answer (19 Nov 2026) listed five
 * phones as cards and five pictures under "Images shown", but every card in
 * "The answer, as ChatGPT showed it" was an empty cart: the products came from
 * the answer's data bindings (title, price, store, no picture) and the
 * pictures from its image components, each titled with its product's name
 * (source_ref_type "product"). Nothing joined the two. A product with no
 * picture now takes the image whose title names it.
 *
 * Shared by the ChatGPT adapter (so exports have the pictures) and Analyze
 * (so answers stored before this show them without being read again).
 */

// Words a model name splits into: "S26Ultra" = "S26 Ultra" = "s 26 ultra".
const words = (s) => String(s || "").toLowerCase()
  .replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2")
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Words that make a different model: "Nord Buds 4" is not "Nord Buds 4 Pro".
const VARIANT = new Set(["pro", "max", "plus", "ultra", "lite", "mini", "neo", "se", "air", "fe", "prime", "fold", "flip", "edge"]);

/** Whether an image titled `title` shows the product named `name`. */
export function imageShowsProduct(name, title) {
  const n = words(name), t = words(title);
  if (n.length < 2 || !t.length) return false;
  const ts = new Set(t), ns = new Set(n);
  if (t.some((w) => VARIANT.has(w) && !ns.has(w))) return false;
  if (n.every((w) => ts.has(w))) return true;
  // The maker left out of the picture's title ("Apple iPhone 18 Pro Max"
  // pictured as "iPhone 18 Pro Max 256 GB"): the rest must hold a model number.
  const rest = n.slice(1);
  return rest.length >= 2 && rest.some((w) => /\d/.test(w)) && rest.every((w) => ts.has(w));
}

/**
 * Products with a picture where one of the images names them. Returns new
 * product objects; products that have a picture, or no match, are unchanged.
 * Each image goes to one product at most.
 */
export function pictureProducts(products, images) {
  const list = Array.isArray(products) ? products : [];
  const pool = (Array.isArray(images) ? images : []).filter((im) => im && typeof im.url === "string" && /^https?:/i.test(im.url) && im.title);
  if (!pool.length || list.every((p) => !p || p.image)) return list;
  const used = new Set(list.map((p) => p && p.image).filter(Boolean));
  return list.map((p) => {
    if (!p || p.image || !p.name) return p;
    const im = pool.find((x) => !used.has(x.url) && imageShowsProduct(p.name, x.title));
    if (!im) return p;
    used.add(im.url);
    return { ...p, image: im.url };
  });
}
