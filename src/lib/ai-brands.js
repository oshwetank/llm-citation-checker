/*
 * ai-brands.js — optional AI-assisted enrichment layered on top of
 * brands.js's always-on, dependency-free detection (Tier C — the floor
 * every device gets, unconditionally, already shipped and tested on its
 * own). This layer NEVER removes or overrides anything Tier C found — it
 * only ADDS names Tier C's structural scan missed (most often: a brand
 * named only in plain prose, never a bold heading or table — a whole
 * category of mention Tier C never even looks at), or UPGRADES a
 * truncated name to its full form ("Ant" -> "Ant Esports"). If nothing
 * here is available, or anything here fails for any reason, the result is
 * byte-for-byte identical to calling detectBrands() directly — that's a
 * deliberate safety property, not an accident.
 *
 * Three tiers, tried in order, each free to be unavailable:
 *   A. Chrome's built-in Gemini Nano (nano.js) — 0 bytes bundled into this
 *      extension; Chrome manages the model itself, hardware-gated by
 *      Chrome, not by anything here.
 *   B. A small on-device NER model (GLiNER "Edge", ~32M params, an order
 *      of magnitude smaller than the 174MB tier this project evaluated
 *      and rejected for size) — for devices without Nano but that can
 *      handle a light local model. Wired in via registerTierB() once the
 *      offscreen-document pipeline and model asset land; until then this
 *      tier is a clean no-op, not a broken one.
 *   C. brands.js alone. Always computed first, always the fallback.
 */
import { detectBrands, escapeRegExp } from "./brands.js";
import { isNanoAvailable, extractEntitiesWithNano } from "./nano.js";

// Tier B hook, set by background.js once its offscreen-document GLiNER
// pipeline exists. `fn` must be an async (text) => string[]|null function
// with the exact same "null/throw means unavailable, never surfaced as an
// error" contract as nano.js's extractEntitiesWithNano.
let tierBExtractor = null;
export function registerTierB(fn) {
  tierBExtractor = fn;
}

// Folds a list of AI-reported entity names into an existing detectBrands()
// result. Two things can happen for each name: it upgrades an existing
// entry to a fuller form of the same name, or — only if the name genuinely
// appears in the text (never trusted blindly) — it's added as a brand
// Tier C's structural scan never saw at all.
function mergeAiNames(base, aiNames, plainText) {
  if (!aiNames || !aiNames.length) return base;
  const brands = base.brands.map((b) => ({ ...b }));
  const byLower = new Map(brands.map((b) => [b.brand.toLowerCase(), b]));

  for (const rawName of aiNames) {
    const name = String(rawName || "").replace(/\s+/g, " ").trim();
    if (!name || name.length < 2 || name.length > 60) continue;
    const lower = name.toLowerCase();
    if (byLower.has(lower)) continue; // already have this exact name

    // The AI's version is a longer, more complete form of a name we
    // already found (the real-world "Ant" -> "Ant Esports" case from the
    // GLiNER spike) — upgrade the display name in place. Every bit of
    // Tier C's own metadata (count/firstIndex/category/relation) is still
    // correct and is kept as-is; only the label changes.
    const existingHead = brands.find(
      (b) => lower.startsWith(b.brand.toLowerCase() + " ") && name.length > b.brand.length
    );
    if (existingHead) {
      existingHead.brand = name;
      byLower.set(lower, existingHead);
      continue;
    }

    // A genuinely new name — count its real occurrences the same way
    // brands.js itself does. If it doesn't actually appear in the text,
    // the AI hallucinated or paraphrased it — skip rather than trust
    // blindly, since this whole layer's safety property depends on never
    // inventing a mention that isn't really there.
    const hits = [...plainText.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"))];
    if (!hits.length) continue;
    const entry = {
      brand: name,
      count: hits.length,
      firstIndex: hits[0].index,
      category: null,
      description: null,
      passages: [plainText.slice(Math.max(0, hits[0].index - 110), hits[0].index + 110).replace(/\s+/g, " ").trim()],
      relation: null,
    };
    brands.push(entry);
    byLower.set(lower, entry);
  }

  brands.sort((a, b) => a.firstIndex - b.firstIndex);
  return { brands, entities: base.entities };
}

/**
 * Drop-in async replacement for detectBrands() — same signature, same
 * return shape, so existing callers only need `await` added. Tier C is
 * always computed first and is what's returned if every AI tier is
 * unavailable or fails; nothing below this comment is allowed to make the
 * result worse than a plain detectBrands() call would have been.
 */
export async function detectBrandsAI(answerText, plainText, ctx = {}) {
  const base = detectBrands(answerText, plainText, ctx);
  const text = plainText || answerText || "";
  if (!text) return base;

  try {
    if (await isNanoAvailable()) {
      const names = await extractEntitiesWithNano(text);
      if (names) return mergeAiNames(base, names, text);
    }
  } catch (_) {
    // Tier A failed for any reason — fall through to Tier B/C, never throw.
  }

  try {
    if (tierBExtractor) {
      const names = await tierBExtractor(text);
      if (names) return mergeAiNames(base, names, text);
    }
  } catch (_) {
    // Tier B failed for any reason — fall through to Tier C.
  }

  return base;
}
