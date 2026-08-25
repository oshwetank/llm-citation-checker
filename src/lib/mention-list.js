/*
 * mention-list.js — turn raw detections into the list the Brand Mentions card
 * shows.
 *
 * Three things happen here, and all three used to be inline in the panel:
 *
 * 1. NOISE. The detector is industry-agnostic, so a heading like "Battery" or
 *    "Overall" can reach it looking like a name. Those are dropped.
 *
 * 2. ALIASES. Sub-brands that share no leading words with their parent
 *    ("Galaxy" is Samsung, "ThinkPad" is Lenovo) need a lookup table; nothing
 *    in the text says so.
 *
 * 3. SKUs. A brand whose leading words are another detected brand is that
 *    brand: "Google Pixel 10a" under "Google". Listing both splits one
 *    company's mention count across two rows and shows the reader the same
 *    name twice — visible in a real capture as "Google Pixel 10a ×5" sitting
 *    next to "Google ×9". The SKU is not lost; it becomes a model chip on the
 *    parent's row, which is what that row is for.
 *
 * Order is preserved as first appearance in the answer, which is what the card
 * ranks by. A merged entry inherits the EARLIEST position of its parts — a
 * company was first named the moment any of its names appeared.
 *
 * Kept out of the panel so the merge rules are testable without a browser.
 */

/** Sub-brands that share no leading words with their parent. */
export const ALIAS_MAP = {
  "google pixel": "Google",
  pixel: "Google",
  galaxy: "Samsung",
  iphone: "Apple",
  ipad: "Apple",
  macbook: "Apple",
  surface: "Microsoft",
  rog: "Asus",
  tuf: "Asus",
  vivobook: "Asus",
  ideapad: "Lenovo",
  thinkpad: "Lenovo",
  victus: "HP",
  pavilion: "HP",
  inspiron: "Dell",
  alienware: "Dell",
  legion: "Lenovo",
  predator: "Acer",
};

/*
 * Generic words the detector could mistake for a brand — deliberately NOT a
 * place for real brand names. "sony" was once listed here, which silently
 * dropped every genuine Sony mention (TVs, cameras, audio…) from this card for
 * every industry, permanently. That was a correctness bug, not a filter.
 */
export const NOISE_BRAND_WORDS = new Set([
  "battery", "software", "camera", "cameras", "display", "performance", "design",
  "overall", "budget", "value", "rating", "phone", "phones", "mobile", "mobiles",
  "recommendation", "recommendations", "processor", "chipset", "storage", "memory",
  "charging", "screen", "gaming", "price", "pros", "cons", "specs", "life",
  "option", "options", "pick", "picks", "android", "ios", "best",
]);

const norm = (s) => String(s ?? "").toLowerCase().trim();

/**
 * @param mentions rec.brandMentions, already in first-appearance order
 * @returns [{ brand, count, passages, relation, skus }] — same order, merged.
 *          `skus` holds the longer product names folded into this row.
 */
export function normalizeMentions(mentions) {
  const kept = (mentions || []).filter((b) => b && b.brand && !NOISE_BRAND_WORDS.has(norm(b.brand)));

  // Pass 1: apply aliases, so the SKU pass below can see the real parents.
  const aliased = kept.map((b) => ({ ...b, brand: ALIAS_MAP[norm(b.brand)] || b.brand }));

  // Pass 2: work out what each name counts as. A name collapses onto the
  // shortest detected name that is a whole-word prefix of it — whole-word so
  // "Applebees" never lands under "Apple".
  const names = [...new Set(aliased.map((b) => norm(b.brand)))].sort((a, b) => a.length - b.length);
  const rootOf = new Map();
  for (const name of names) {
    let root = name;
    for (const other of names) {
      if (other.length >= name.length) break;
      if (name.startsWith(other + " ")) { root = other; break; }
    }
    rootOf.set(name, root);
  }

  // Pass 3: merge, preserving first-appearance order.
  const out = [];
  const byRoot = new Map();
  for (const b of aliased) {
    const key = rootOf.get(norm(b.brand));
    const isSku = key !== norm(b.brand);
    let row = byRoot.get(key);
    if (!row) {
      row = {
        ...b,
        // The parent's own spelling if it was detected, otherwise the first
        // spelling seen — never a lowercased key.
        brand: isSku ? (aliased.find((x) => norm(x.brand) === key)?.brand || b.brand) : b.brand,
        count: 0,
        passages: [],
        skus: [],
      };
      byRoot.set(key, row);
      out.push(row);
    }
    row.count += Number(b.count) || 0;
    if (b.passages && b.passages.length) row.passages.push(...b.passages);
    // A row is the user's brand or a competitor if ANY of its parts was.
    if (b.relation && !row.relation) row.relation = b.relation;
    if (isSku && !row.skus.includes(b.brand)) row.skus.push(b.brand);
  }
  return out;
}
