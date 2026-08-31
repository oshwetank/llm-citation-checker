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
 *   B. A hook for a small on-device NER model, INTENTIONALLY left
 *      unregistered. Investigated bundling GLiNER "Edge"
 *      (knowledgator/gliner-bi-edge-v2.0) for this slot: it turned out to
 *      have no ONNX export published anywhere (PyTorch weights only,
 *      ~243MB fp32 — meaning it's actually ~60M params, not the ~32M
 *      originally estimated from its name), and every GLiNER variant that
 *      DOES have a ready-made quantized ONNX file (onnx-community's
 *      small/base/large) is the same size class as the 174MB tier this
 *      project already evaluated and rejected — quantization alone
 *      doesn't get GLiNER meaningfully smaller than that. Converting
 *      bi-edge ourselves, or swapping in a small fixed-category NER model
 *      instead, were both considered and declined: the fixed-category
 *      option would only catch bare company names in prose (its training
 *      categories have no concept of "product model number"), missing
 *      exactly the full brand+model extraction this whole effort is
 *      about — not judged a big enough quality gain over Tier A + Tier C
 *      alone to be worth the size/complexity. registerTierB() is kept as
 *      live, tested plumbing in case a suitably small model shows up
 *      later; nothing currently calls it.
 *   C. brands.js alone. Always computed first, always the fallback.
 */
import { detectBrands, escapeRegExp } from "./brands.js";
import { isNanoAvailable, extractEntitiesWithNano, classifyBrandStanceWithNano } from "./nano.js";

// Tier B hook. Nothing currently registers one (see the file header) — kept
// as tested plumbing for a future small on-device model, not active work in
// progress. `fn` must be an async (text) => string[]|null function with the
// exact same "null/throw means unavailable, never surfaced as an error"
// contract as nano.js's extractEntitiesWithNano.
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
/**
 * Run ONLY the AI tiers over already-detected brands, and return an improved
 * list — or null when no tier is available or nothing changed.
 *
 * Split out of detectBrandsAI() because the AI call must not sit in the path
 * that stores a capture. It did, and on a machine where Chrome's on-device
 * model IS available that meant nothing was written to the database — and the
 * panel showed nothing — until an on-device inference over up to 6000
 * characters finished. Reported as the tool taking ~20 seconds to show a
 * prompt that had already finished answering.
 *
 * Nothing about the RESULT changes: this is the same merge, over the same
 * names, producing the same list. Only when it happens changes — the base
 * result is stored and shown immediately, and this upgrades it in place a
 * moment later.
 */
export async function enrichBrandsWithAI(brands, plainText, query) {
  const text = plainText || "";
  if (!text.trim()) return null;

  const merge = (names) => {
    if (!names || !names.length) return null;
    const merged = mergeAiNames({ brands: brands || [], entities: [] }, names, text);
    return merged.brands;
  };

  try {
    if (await isNanoAvailable()) {
      const out = merge(await extractEntitiesWithNano(text, query));
      if (out) return out;
    }
  } catch (_) {
    // Any failure means "no enrichment", never a thrown error into the caller.
  }
  try {
    if (tierBExtractor) {
      const out = merge(await tierBExtractor(text));
      if (out) return out;
    }
  } catch (_) {
    /* same */
  }
  return null;
}

export async function detectBrandsAI(answerText, plainText, ctx = {}) {
  const base = detectBrands(answerText, plainText, ctx);
  const text = plainText || answerText || "";
  if (!text) return base;

  try {
    if (await isNanoAvailable()) {
      const names = await extractEntitiesWithNano(text, ctx.query);
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

/*
 * Attach a per-brand stance (recommended / mentioned / negative) using the
 * on-device model. Separate from enrichBrandsWithAI() on purpose: that one
 * decides WHICH brands exist, this one only annotates brands already found,
 * so a failure here can never change the brand list itself.
 *
 * Returns a NEW array when anything was annotated, or null when the model is
 * unavailable or produced nothing usable. `stance: null` on a brand means
 * "not assessed" — it is never downgraded to a neutral verdict, because
 * "we didn't look" and "we looked and it was neutral" are different claims
 * and only one of them is true on a device without Gemini Nano.
 */
export async function enrichBrandStance(brands, plainText, query) {
  const list = brands || [];
  const text = plainText || "";
  if (!list.length || !text.trim()) return null;
  try {
    if (!(await isNanoAvailable())) return null;
    const stances = await classifyBrandStanceWithNano(text, list, query);
    if (!stances || !stances.size) return null;
    let changed = false;
    const out = list.map((b) => {
      const verdict = stances.get(String(b.brand || "").toLowerCase());
      if (!verdict) return b;
      changed = true;
      return { ...b, stance: verdict };
    });
    return changed ? out : null;
  } catch (_) {
    return null;
  }
}
