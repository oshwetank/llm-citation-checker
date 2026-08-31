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
  "You extract brand, product, and company names that the text discusses IN THE CONTEXT OF the " +
  "user's own question. " +
  'List each one exactly as it is written in the text, using its full name (e.g. "Ant Esports" ' +
  'not "Ant", "Zebronics Transformer M Plus" not just "Zebronics"). Do NOT include video games, ' +
  "generic categories, prices, or common words. Do NOT include a name that appears only as a " +
  "citation source, publisher, or footnote marker for where the information came from -- only " +
  "names the text is actually discussing as an answer to the question. If the text mentions a " +
  "name that has nothing to do with what the user asked (for example, leftover from an unrelated " +
  "past conversation), leave it out. If none are mentioned, return an empty list.";

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
// On-device inference has no server to time it out, and a wedged session
// would otherwise leave the caller awaiting forever. Enrichment is optional by
// design, so giving up is always safe: the caller keeps the non-AI result.
const NANO_TIMEOUT_MS = 20000;
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("nano timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// `query` is the user's own prompt for this capture, when known. Passing it
// is what lets Nano judge RELEVANCE rather than just running blind NER over
// the answer text — without it, Nano has no way to tell a name the answer is
// actually discussing apart from an unrelated name that merely appears
// somewhere in the text (a citation source, a stray leftover reference).
// Optional and additive: omitting it falls back to the previous
// context-free extraction, never an error.
export async function extractEntitiesWithNano(text, query) {
  if (!text || !text.trim()) return null;
  const lm = resolveLanguageModel();
  if (!lm) return null;

  let session;
  try {
    session = await withTimeout(
      lm.create({ initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }] }),
      NANO_TIMEOUT_MS
    );
    // Real capture answers can run long; Gemini Nano has a limited context
    // window. This cap has been enough for every real fixture in this
    // repo's test suite while staying well under typical on-device limits.
    const clipped = text.length > 6000 ? text.slice(0, 6000) : text;
    const q = String(query || "").trim();
    const instruction = q
      ? `The user asked: "${q}"\n\nExtract every brand, product, and company name from this answer that is relevant to that question:\n\n${clipped}`
      : `Extract every brand, product, and company name from this text:\n\n${clipped}`;
    const raw = await withTimeout(
      session.prompt(instruction, { responseConstraint: ENTITY_SCHEMA }),
      NANO_TIMEOUT_MS
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

/*
 * Brand STANCE — is the answer recommending this brand, merely mentioning it,
 * or steering the reader away from it?
 *
 * A share-of-voice number treats every mention identically, so "the Rockerz
 * 512 is the best pick" and "avoid the Rockerz 512, it overheats" score the
 * same today. For a tool whose job is telling someone how AI engines talk
 * about their brand, those are close to opposite findings — and the
 * distinction is genuinely hard to get from keywords, because the sentiment
 * usually lives in a clause some distance from the brand name.
 *
 * That makes it a good fit for the on-device model specifically: it needs
 * real language understanding, it is per-capture rather than per-keystroke,
 * and it is entirely optional — every device without Gemini Nano simply gets
 * `stance: null`, which the UI renders as "not assessed" rather than
 * guessing. Nothing here ever invents a verdict.
 */
const STANCE_SCHEMA = {
  type: "object",
  properties: {
    stances: {
      type: "array",
      items: {
        type: "object",
        properties: {
          brand: { type: "string" },
          stance: { type: "string", enum: ["recommended", "mentioned", "negative"] },
        },
        required: ["brand", "stance"],
      },
    },
  },
  required: ["stances"],
};

const STANCE_SYSTEM_PROMPT =
  "You judge how a piece of text treats each brand it names. For every brand you are given, answer with " +
  'exactly one of: "recommended" if the text puts it forward as a good choice; "negative" if the text ' +
  'advises against it or highlights it as a poor choice; "mentioned" if it is simply named, compared, or ' +
  "described without a clear positive or negative recommendation. Judge only what the text actually says " +
  "— do not use outside knowledge about the brand, and do not guess. When in doubt, answer \"mentioned\".";

// Returns a Map of lowercased brand -> stance, or null when unavailable or on
// any failure. Callers must treat null as "not assessed", never as neutral.
export async function classifyBrandStanceWithNano(text, brands, query) {
  if (!text || !text.trim()) return null;
  const names = (brands || [])
    .map((b) => (typeof b === "string" ? b : b && b.brand))
    .filter((n) => typeof n === "string" && n.trim());
  if (!names.length) return null;

  const lm = resolveLanguageModel();
  if (!lm) return null;

  let session;
  try {
    session = await withTimeout(
      lm.create({ initialPrompts: [{ role: "system", content: STANCE_SYSTEM_PROMPT }] }),
      NANO_TIMEOUT_MS
    );
    const clipped = text.length > 6000 ? text.slice(0, 6000) : text;
    const q = String(query || "").trim();
    const raw = await withTimeout(
      session.prompt(
        (q ? `The user asked: "${q}"\n\n` : "") +
          `Brands to judge: ${names.join(", ")}\n\nText:\n\n${clipped}`,
        { responseConstraint: STANCE_SCHEMA }
      ),
      NANO_TIMEOUT_MS
    );
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.stances)) return null;
    const allowed = new Set(["recommended", "mentioned", "negative"]);
    const out = new Map();
    for (const s of parsed.stances) {
      if (!s || typeof s.brand !== "string" || !allowed.has(s.stance)) continue;
      // Only accept verdicts for brands we actually asked about — the model
      // must not be able to introduce a brand through this path.
      const key = s.brand.trim().toLowerCase();
      if (names.some((n) => n.toLowerCase() === key)) out.set(key, s.stance);
    }
    return out.size ? out : null;
  } catch (_) {
    return null;
  } finally {
    try { session?.destroy?.(); } catch (_) {}
  }
}
