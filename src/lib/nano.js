/*
 * nano.js — optional, zero-bundle-cost brand/product extraction via
 * Chrome's built-in on-device model (Gemini Nano, the Prompt API).
 *
 * This is Tier A of the three-tier strategy in ai-brands.js. Chrome
 * manages Gemini Nano itself — downloaded once by Chrome, shared across
 * every extension and site that uses it — so calling it costs this
 * extension exactly 0 bytes of bundle size, versus the 100s of MB a
 * bundled NER model costs every single user regardless of whether they
 * ever wanted the feature.
 *
 * Availability is hardware-gated by Chrome itself (GPU/VRAM, free disk
 * space, desktop OS) and genuinely isn't there on a lot of devices. Every
 * function here is written so "not available" or "the call failed for any
 * reason" is indistinguishable to the caller from "just don't use this
 * tier" — ai-brands.js always has Tier B and Tier C to fall back to, so
 * nothing here is allowed to throw past its own boundary.
 *
 * Written from Chrome's documented Prompt API surface (availability()/
 * create()/prompt(), responseConstraint for schema-constrained JSON
 * output, stable since Chrome 137 for structured output — the origin-trial
 * permission/token flow has expired). One genuine unresolved ambiguity:
 * research for this turned up conflicting information on whether an
 * EXTENSION service worker sees this as the bare `LanguageModel` global
 * (the same surface websites use) or as a `chrome.languageModel`
 * namespace, and whether a manifest permission is required at all now that
 * the old trial-token flow is gone — Chrome's own docs site was blocked
 * from the sandbox this was researched in, so it couldn't be confirmed
 * against the primary source. resolveLanguageModel() below checks both
 * plausible surfaces defensively; manifest.json declares "languageModel"
 * speculatively (a permission Chrome doesn't recognize is simply ignored,
 * not a hard error, so this errs toward declaring it).
 *
 * None of this has been live-verified against a real on-device model: the
 * sandbox this was built in has no GPU and can't run Gemini Nano at all
 * (confirmed directly — see the PR description). This needs a real-device
 * smoke test before anyone should lean on it in production; until then,
 * "always falls through safely if anything about this is wrong" is the
 * load-bearing property this file is written around, not "extracts
 * correctly" — every function here treats an unrecognized surface, a
 * missing method, or any thrown error identically to "not available."
 */

// Whichever surface actually exists on this browser, or null. Checked once
// per call rather than cached, since availability can change over the
// lifetime of a long-lived service worker (Chrome can finish downloading
// the model, or free disk space can drop below Chrome's own threshold and
// the model gets evicted, at any time).
function resolveLanguageModel() {
  if (typeof LanguageModel !== "undefined") return LanguageModel;
  if (typeof chrome !== "undefined" && chrome.languageModel) return chrome.languageModel;
  return null;
}

const ENTITY_SCHEMA = {
  type: "object",
  properties: {
    entities: { type: "array", items: { type: "string" } },
  },
  required: ["entities"],
};

const SYSTEM_PROMPT =
  "You extract brand, product, and company names mentioned in text. " +
  'List each one exactly as it is written in the text, using its full name (e.g. "Ant Esports" ' +
  'not "Ant", "Zebronics Transformer M Plus" not just "Zebronics"). Do NOT include video games, ' +
  "generic categories, prices, or common words. Only real commercial brand/product/company names. " +
  "If none are mentioned, return an empty list.";

// Only these two states mean "ready to use right this instant, with zero
// download or user prompt." Anything else (downloadable/downloading/
// unavailable, or a future API's naming this doesn't recognize) is treated
// as not ready — this deliberately never triggers a model download or
// waits on one; the whole point of this tier is zero friction or nothing.
const READY_STATES = new Set(["available", "readily"]);

export async function isNanoAvailable() {
  try {
    const lm = resolveLanguageModel();
    if (!lm) return false;
    const availability = await lm.availability();
    return READY_STATES.has(availability);
  } catch (_) {
    return false;
  }
}

// Returns string[] of entity names as the model wrote them, or null on any
// failure/unavailability — callers always have a deterministic fallback
// and should never treat null as an error worth surfacing to the user.
export async function extractEntitiesWithNano(text) {
  if (!text || !text.trim()) return null;
  const lm = resolveLanguageModel();
  if (!lm) return null;

  let session;
  try {
    session = await lm.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
    });
    // Real capture answers can run long; Gemini Nano has a limited context
    // window. This cap has been enough for every real fixture in this
    // repo's test suite while staying well under typical on-device limits.
    const clipped = text.length > 6000 ? text.slice(0, 6000) : text;
    const raw = await session.prompt(
      `Extract every brand, product, and company name from this text:\n\n${clipped}`,
      { responseConstraint: ENTITY_SCHEMA }
    );
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entities)) return null;
    return parsed.entities.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim());
  } catch (_) {
    return null;
  } finally {
    try { session?.destroy?.(); } catch (_) {}
  }
}
