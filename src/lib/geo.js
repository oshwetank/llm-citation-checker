/*
 * lib/geo.js — the GEO brand-tracking module's data shapes and metrics engine.
 *
 * This is the "tool under the tool": a deliberate, repeatable measurement
 * surface (fixed brand + competitors + prompt set + engines, re-run on a
 * cadence) that sits alongside the ad-hoc capture analysis without either one
 * contaminating the other.
 *
 * ISOLATION — the load-bearing rule of this whole module:
 *   A derived record produced by a tracking run carries a `geo` bag
 *   ({ profileId, runId, promptId, tags }). A record captured from ordinary
 *   browsing has `geo: null`. Every read path must go through `isTracked()` /
 *   `partitionRecords()` below rather than testing fields ad hoc, so the two
 *   data sets can never blur into each other. Tracking metrics must be
 *   reproducible; a stray manual ChatGPT query about an unrelated topic would
 *   silently move a brand's Visibility if it leaked in.
 *
 * METRIC DEFINITIONS live in src/lib/glossary.js — one definition per term,
 * shared by every surface that shows it, so a metric cannot end up explained
 * three different ways on three different screens. The arithmetic here must
 * match the formula stated there.
 *
 *   Visibility     responses mentioning the brand ÷ total responses
 *   Share of Voice this brand's mentions ÷ all tracked brands' mentions
 *   Position       mean rank by first appearance, over responses where the
 *                  brand appears — responses without it are excluded rather
 *                  than scored as a penalty rank
 *   Sentiment      NOT implemented. Scoring it needs either a language model
 *                  reading every answer or a documented word list; a
 *                  fabricated 0-100 number in a measurement tool would be
 *                  worse than the honest gap. See SENTIMENT_NOTE.
 */
import { wordRe } from "./textMatch.js";

export const MAX_PROFILES = 3;

// A soft-deleted campaign stays recoverable for this many days before it's
// purged for real (see "geo-profile-trash"/"geo-profile-restore" in
// background.js and the lazy sweep in "geo-profile-list").
export const TRASH_RETENTION_DAYS = 7;

export const SENTIMENT_NOTE =
  "Whether an answer speaks about a brand favourably is not measured yet. " +
  "Scoring it honestly needs either a language model reading every answer or a " +
  "documented word list, and a made-up number in a measurement tool would be " +
  "worse than an admitted gap.";

/* ---------------- engine registry ----------------
 * `available` reflects what this extension can ACTUALLY drive today: an engine
 * needs host_permissions + a content script + an adapter. Unavailable engines
 * are shown disabled rather than hidden, so the roadmap is visible and a metric
 * can never silently under-count because a checkbox did nothing.
 */
export const ENGINES = [
  { id: "chatgpt", label: "ChatGPT", host: "chatgpt.com", available: true },
  { id: "gemini", label: "Gemini", host: "gemini.google.com", available: true },
  { id: "perplexity", label: "Perplexity", host: "perplexity.ai", available: true },
  { id: "grok", label: "Grok", host: "grok.com", available: true },
];

export const availableEngines = () => ENGINES.filter((e) => e.available);

/* ---------------- normalisation helpers ---------------- */

// Brand names are compared loosely (case, punctuation, spacing) because the
// same company shows up as "Angel One" / "AngelOne" / "angel one" across
// answers, and a tracking table that lists those as three brands is useless.
// Letters and digits of any script (0.70.0): an ASCII-only key made every
// non-Latin brand name "" and so never found.
export function normName(s) {
  return String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function domainOfUrl(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).hostname.replace(/^www\./i, "").toLowerCase();
  } catch (_) {
    return "";
  }
}

// A source belongs to a brand if its domain is that brand's domain or a
// subdomain of it (support.zerodha.com counts for zerodha.com) — but NOT if it
// merely ends with the same string ("notzerodha.com" must not match).
export function domainMatches(sourceDomain, brandDomain) {
  if (!sourceDomain || !brandDomain) return false;
  const a = String(sourceDomain).replace(/^www\./i, "").toLowerCase();
  const b = String(brandDomain).replace(/^www\./i, "").toLowerCase();
  return a === b || a.endsWith("." + b);
}

/* ---------------- factories ---------------- */

export function makeProfile(base = {}) {
  return {
    id: base.id || (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
    name: base.name || "Untitled profile",
    brand: { name: base.brand?.name || "", url: base.brand?.url || "" },
    competitors: Array.isArray(base.competitors)
      ? base.competitors.filter((c) => c && c.name).map((c) => ({ name: c.name, url: c.url || "" }))
      : [],
    // Brands the user has said are NOT competitors — publishers, retailers,
    // their own sub-brands, anything the detector legitimately found but that
    // shouldn't count in Share of Voice. Only ever suppresses INFERRED
    // competitors; a competitor the user typed is removed by deleting it.
    excludedBrands: Array.isArray(base.excludedBrands)
      ? [...new Set(base.excludedBrands.map((n) => String(n).trim()).filter(Boolean))]
      : [],
    engines: Array.isArray(base.engines) && base.engines.length
      ? base.engines.filter((id) => availableEngines().some((e) => e.id === id))
      : availableEngines().map((e) => e.id),
    // Locking freezes the measurement definition. Changing the brand set or
    // prompt list mid-stream makes a time series meaningless (yesterday's
    // Share of Voice was computed against a different denominator), so the UI
    // requires an explicit unlock and warns about the comparability break.
    locked: !!base.locked,
    createdAt: base.createdAt || Date.now(),
    lastRunAt: base.lastRunAt || null,
    // Soft-delete: set to a timestamp instead of removing the profile outright,
    // so a campaign can be restored for a window before it's purged for real.
    deletedAt: base.deletedAt || null,
    // What the campaign's board leads with (0.55.0): its headline views, set
    // in setup. Brand mentions are always measured. null means the campaign
    // predates the choice, so every view stays offered.
    measure: base.measure && typeof base.measure === "object"
      ? { citations: !!base.measure.citations, products: !!base.measure.products, images: !!base.measure.images, local: !!base.measure.local }
      : null,
    // What was changed after the campaign was locked (0.77.0), newest last:
    // {at, kind, name?, detail?}. A locked campaign can be edited without
    // unlocking it; this is how the board marks where numbers stop being
    // directly comparable.
    changes: Array.isArray(base.changes) ? base.changes.filter((c) => c && c.kind).slice(-MAX_CHANGES) : [],
  };
}

const MAX_CHANGES = 300;

/* ---------------- editing a locked campaign (0.77.0) ----------------
 * The owner: "I don't want to open and enable the editing of the campaign …
 * the process to make changes in the campaign is tedious". Only the brand
 * and its website still need an explicit unlock, because they change every
 * number; prompts, tags, competitors, engines and what the board measures
 * are edited in place, and each change is logged. */

/** Whether saving `next` over a locked `existing` needs the explicit unlock. */
export function needsUnlock(existing, next) {
  if (!existing || !existing.locked) return false;
  const a = existing.brand || {}, b = (next && next.brand) || a;
  return normName(a.name || "") !== normName(b.name || "") || String(a.url || "").trim().toLowerCase() !== String(b.url || "").trim().toLowerCase();
}

/** The change-log entries between two versions of a campaign. */
export function profileChanges(before, after, at = Date.now()) {
  if (!before) return [];
  const out = [];
  const names = (p) => new Map((p.competitors || []).map((c) => [normName(c.name), c.name]));
  const was = names(before), now = names(after);
  for (const [k, n] of now) if (!was.has(k)) out.push({ at, kind: "competitor-added", name: n });
  for (const [k, n] of was) if (!now.has(k)) out.push({ at, kind: "competitor-removed", name: n });
  const e1 = [...(before.engines || [])].sort().join(), e2 = [...(after.engines || [])].sort().join();
  if (e1 !== e2) out.push({ at, kind: "engines", detail: `${(before.engines || []).join(", ")} → ${(after.engines || []).join(", ")}` });
  const m = (p) => JSON.stringify(p.measure || null);
  if (m(before) !== m(after)) out.push({ at, kind: "measure" });
  const b1 = before.brand || {}, b2 = after.brand || {};
  if ((b1.name || "") !== (b2.name || "") || (b1.url || "") !== (b2.url || "")) out.push({ at, kind: "brand", detail: `${b1.name || ""} (${b1.url || ""}) → ${b2.name || ""} (${b2.url || ""})` });
  return out;
}

/** Adds one competitor; never the own brand, never twice. */
export function addCompetitor(profile, { name, url = "" } = {}, at = Date.now()) {
  const n = String(name || "").trim();
  if (!n) return { error: "No brand given." };
  const key = normName(n);
  if (key === normName(profile?.brand?.name || "")) return { error: "That's your own brand — it's tracked already." };
  if ((profile.competitors || []).some((c) => normName(c.name) === key)) return { profile, added: false };
  const next = makeProfile({
    ...profile,
    competitors: [...(profile.competitors || []), { name: n, url: String(url || "").trim() }],
    // Adding a brand undoes leaving it out.
    excludedBrands: (profile.excludedBrands || []).filter((x) => normName(x) !== key),
    changes: profile.locked ? [...(profile.changes || []), { at, kind: "competitor-added", name: n }] : profile.changes,
  });
  return { profile: next, added: true };
}

/** Human words for a change-log entry. */
export function changeText(c) {
  switch (c.kind) {
    case "competitor-added": return `Added competitor ${c.name}`;
    case "competitor-removed": return `Removed competitor ${c.name}`;
    case "engines": return `Engines changed: ${c.detail}`;
    case "measure": return "Changed what the board measures";
    case "brand": return `Brand changed: ${c.detail}`;
    case "prompts-added": return `Added ${c.count} prompt${c.count === 1 ? "" : "s"}`;
    case "prompt-removed": return `Removed a prompt: "${c.name}"`;
    case "prompt-edited": return `Edited a prompt: "${c.name}"`;
    case "tags": return `Changed tags on "${c.name}"`;
    default: return c.kind;
  }
}

export function makeTrackedPrompt(base = {}) {
  return {
    id: base.id || (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
    profileId: base.profileId || null,
    text: String(base.text || "").trim(),
    tags: Array.isArray(base.tags) ? [...new Set(base.tags.map((t) => String(t).trim()).filter(Boolean))] : [],
    active: base.active !== false,
    createdAt: base.createdAt || Date.now(),
  };
}

export function makeGeoRun(base = {}) {
  return {
    id: base.id || (globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random())),
    profileId: base.profileId || null,
    startedAt: base.startedAt || Date.now(),
    finishedAt: base.finishedAt || null,
    status: base.status || "running", // running | done | stopped | failed
    engines: base.engines || [],
    promptIds: base.promptIds || [],
    expected: base.expected || 0, // prompts × engines
    captured: base.captured || 0,
    failed: base.failed || 0,
    // Failure-reason histogram — { "timeout": 3, "tab closed": 1, … } — kept
    // durably here (not just in the ephemeral in-memory/session loader
    // state) so a diagnostic export can report WHY things failed without
    // shipping any prompt/answer/URL content. Never contains anything but
    // these short, fixed reason strings (see background.js's
    // failTurnAndAdvance and resumeFromSnapshot, the only places that set a
    // reason) — no user content ever flows into this field.
    reasons: base.reasons || {},
  };
}

/* ---------------- isolation ---------------- */

export function isTracked(rec) {
  return !!(rec && rec.geo && rec.geo.profileId);
}

/** Split a record list into tracking-run records and ad-hoc browsing records. */
export function partitionRecords(records) {
  const tracked = [];
  const adhoc = [];
  for (const r of records || []) (isTracked(r) ? tracked : adhoc).push(r);
  return { tracked, adhoc };
}

/* One capture per prompt, per engine, per run.
 *
 * An engine can deliver several captures for one prompt: Gemini's answer
 * arrives as several StreamGenerate responses, Perplexity is captured both
 * from its answer stream and from the page, and a send that was accepted
 * more than once (see RETRY_GAP_MS in content-iso.js) produces several
 * answers. Every metric divides by the number of records — a real run
 * stored 30 Gemini records for 7 prompts and 27 Perplexity records for 10 —
 * so each prompt counted as many responses as it had captures, and a
 * brand's visibility shifted with how many copies happened to arrive. The
 * copy kept is the most complete: most sources, then longest answer, then
 * earliest. A record without a run or prompt (older captures) is kept as is.
 */
const moreComplete = (a, b) => {
  const sa = (a.sources || []).length;
  const sb = (b.sources || []).length;
  if (sa !== sb) return sa > sb;
  const la = a.answerChars || 0;
  const lb = b.answerChars || 0;
  if (la !== lb) return la > lb;
  return (a.capturedAt || 0) < (b.capturedAt || 0);
};
const captureKey = (r) => (r.geo && r.geo.runId && r.geo.promptId ? `${r.geo.runId}|${r.platform}|${r.geo.promptId}` : null);
export function oneCapturePerPrompt(records) {
  const best = new Map();
  for (const r of records || []) {
    const k = captureKey(r);
    if (k && (!best.has(k) || moreComplete(r, best.get(k)))) best.set(k, r);
  }
  return (records || []).filter((r) => {
    const k = captureKey(r);
    return !k || best.get(k) === r;
  });
}

/** Records for one profile, optionally narrowed by engine / tags / time.
 * One capture per prompt per engine per run (see oneCapturePerPrompt);
 * `allCaptures` keeps every copy, for the diagnostics export. */
// tagMode "all" (0.67.0) keeps only prompts carrying every tag asked for;
// the default, "any", keeps prompts carrying at least one.
/**
 * The newest answer for each prompt on each engine, across every run
 * (0.80.0). A campaign run on ChatGPT on Monday and on Gemini on Tuesday is
 * one picture: ChatGPT's answers from Monday beside Gemini's from Tuesday.
 * Before, the board opened on the latest run alone, so running engines one
 * at a time made each run hide the one before ("I end up losing my ChatGPT
 * data"), and "all runs" counted a prompt asked twice twice.
 */
export function latestAnswers(records) {
  const best = new Map();
  for (const r of records || []) {
    const g = r.geo || {};
    const key = `${g.promptId || String(r.userPrompt || "").trim().toLowerCase()}|${r.platform}`;
    const cur = best.get(key);
    if (!cur || (r.capturedAt || 0) > (cur.capturedAt || 0)) best.set(key, r);
  }
  return [...best.values()];
}

export function selectTracked(records, { profileId, engines, tags, tagMode = "any", since, until, runId, allCaptures = false } = {}) {
  const picked = (records || []).filter((r) => {
    if (!isTracked(r)) return false;
    if (profileId && r.geo.profileId !== profileId) return false;
    if (runId && r.geo.runId !== runId) return false;
    if (engines && engines.length && !engines.includes(r.platform)) return false;
    if (since && r.capturedAt < since) return false;
    if (until && r.capturedAt > until) return false;
    if (tags && tags.length) {
      const rt = r.geo.tags || [];
      if (tagMode === "all" ? !tags.every((t) => rt.includes(t)) : !tags.some((t) => rt.includes(t))) return false;
    }
    return true;
  });
  return allCaptures ? picked : oneCapturePerPrompt(picked);
}

/* ---------------- per-record brand presence ---------------- */

/**
 * Which tracked brands appear in one response, and where.
 * Returns [{ key, name, isOwn, mentions, present, firstIndex, citedSource }].
 *
 * `mentions` is the raw mention count that feeds Share of Voice.
 * `present` is the boolean that feeds Visibility — deliberately true for a
 * count-0 "shown but not named" brand (a product-carousel appearance the user
 * genuinely saw) even though it contributes 0 to the mention total. Those two
 * metrics answer different questions and must not be collapsed.
 */
/**
 * Does one brandMentions[] entry identify the tracked brand named by `key`
 * (an already-normName()'d string)? A plain `normName(m.brand) === key`
 * check is only correct as long as `m.brand` never changes after Tier C
 * first detects it — but mergeAiNames() (ai-brands.js) upgrades a short
 * deterministic name to a fuller AI-expanded one ("Ant" -> "Ant Esports"),
 * possibly more than once in the same answer ("Ant" -> "Ant Esports" ->
 * "Ant Esports India") — IN PLACE. A brand tracked under any form other
 * than whichever one happens to be current — the original name, or a
 * middle form from a second upgrade — must still match, or its count
 * silently drops to 0 even though it's genuinely mentioned. `originalName`
 * covers the first form ever seen; `aliases` covers every form seen since,
 * including middle ones neither original nor current.
 *
 * Every place that identifies a mention as a SPECIFIC known brand (own
 * brand, a tracked competitor) by name equality needs this, not just
 * brandPresence() below — see callers in campaignWorkbook.js.
 */
export function mentionMatchesBrand(m, key) {
  if (!key || !m) return false;
  return (
    normName(m.brand) === key ||
    (m.originalName && normName(m.originalName) === key) ||
    (Array.isArray(m.aliases) && m.aliases.some((a) => normName(a) === key))
  );
}

export function brandPresence(rec, trackedBrands) {
  const text = rec.answerText || "";
  const mentions = rec.brandMentions || [];
  const sources = rec.sources || [];

  return trackedBrands.map((b) => {
    const key = normName(b.name);
    const hit = mentions.find((m) => mentionMatchesBrand(m, key));
    // Mentions as the answer writes the tracked name (1.0.2), the same
    // evidence Visibility already uses: whole words, a capitalised brand not
    // counted where it's written all lowercase, citation markers left out.
    // The detector's count alone left an answer that named the brand once —
    // but that the detector missed — at 0 mentions while it counted for
    // Visibility, and a name glued to another ("DTDC & Delhivery") took both
    // brands' mentions: DTDC read 5.9% share of voice for 12.9% (live
    // campaign, 22 Nov 2026). The larger of the two counts is kept.
    let textCount = 0;
    if (key) {
      const plain = text.replace(/\[\[cite:[^\]]*\]\]/g, " ");
      const nm = String(b.name);
      const upper = /[A-Z]/.test(nm);
      for (const m of plain.matchAll(wordRe(nm, "gi"))) if (!(upper && m[0] === m[0].toLowerCase())) textCount++;
    }
    const count = Math.max(hit ? Number(hit.count) || 0 : 0, textCount);
    // Where the brand first appears in the prose, which sets its rank.
    //
    // Prefer the detector's own index: it already resolved overlaps and
    // aliases. A "shown but not named" hit carries MAX_SAFE_INTEGER as a sort
    // sentinel, not a real offset, so it must not become a position.
    let idx = -1;
    if (hit && Number.isFinite(hit.firstIndex) && hit.firstIndex < Number.MAX_SAFE_INTEGER) {
      idx = hit.firstIndex;
    } else if (key) {
      // Fallback for a tracked brand the detector didn't surface. Whole-word on
      // purpose: a plain indexOf() matched "HP" inside "shipping", which
      // silently inflated Visibility and handed the brand rank 1.
      //
      // Casing is then checked too, because several real brands ARE ordinary
      // words — "Nothing", "Wild", "Boat", "Noise". A capitalised brand written
      // in all-lowercase is the English word, not the company, so those hits are
      // skipped. Under-counting is the right way to be wrong in a measurement
      // tool, and this only ever runs when the detector found nothing.
      const name = String(b.name);
      const hasUpper = /[A-Z]/.test(name);
      const re = wordRe(name, "gi");
      let m;
      while ((m = re.exec(text))) {
        if (hasUpper && m[0] === m[0].toLowerCase()) continue;
        idx = m.index;
        break;
      }
    }
    // Present if the detector found it at all — including a count-0 carousel
    // appearance — or if the name occurs as a whole word in the answer text.
    const present = !!hit || idx >= 0;
    const dom = domainOfUrl(b.url);
    const citedSource = dom ? sources.some((s) => domainMatches(s.domain, dom) && s.outcome === "cited") : false;
    const anySource = dom ? sources.some((s) => domainMatches(s.domain, dom)) : false;
    return {
      key,
      name: b.name,
      isOwn: !!b.isOwn,
      mentions: count,
      present,
      firstIndex: idx >= 0 ? idx : null,
      citedSource,
      anySource,
    };
  });
}

/** brand + competitors as one list, own brand flagged. */
export function trackedBrandsOf(profile) {
  const out = [];
  if (profile?.brand?.name) out.push({ name: profile.brand.name, url: profile.brand.url, isOwn: true });
  for (const c of profile?.competitors || []) if (c.name) out.push({ name: c.name, url: c.url, isOwn: false });
  return out;
}

/**
 * Competitors inferred from the campaign's own captures.
 *
 * A campaign with no competitors configured measures almost nothing: every
 * brand-facing surface here — Share of Voice, the Brands column, the omitted
 * funnel — is computed against trackedBrandsOf(), which is just the own brand
 * on its own. The answers themselves already name who the competitors are, so
 * when the user hasn't said, the detected brands ARE the answer.
 *
 * Ranked by how many responses each appears in, not by raw mention count: a
 * brand named once in each of ten answers is a more consistent competitor than
 * one named ten times in a single answer.
 *
 * Returned separately rather than folded into trackedBrandsOf() so a caller
 * can always tell an inferred competitor from one the user typed, and label it
 * as such. Nothing here is ever written to the profile without the user asking.
 */
export function autoCompetitorsFrom(records, profile, limit = 8) {
  const ownKey = normName(profile?.brand?.name || "");
  const configured = new Map((profile?.competitors || []).map((c) => [normName(c.name), c.name]));
  const excluded = new Set((profile?.excludedBrands || []).map((n) => normName(n)));

  // Pass 1: every distinct name the captures name, with its best spelling.
  // The own brand and the configured competitors are seeded in as ROOTS even
  // though they can never be proposed — a SKU has to have something to
  // collapse onto, and the most important root of all is the user's own
  // brand. Without it "Motorola Edge 70 Fusion" became a rival of Motorola,
  // taking a share of voice off its own maker.
  const spelling = new Map(); // key -> name
  const roots = new Set();    // keys that exist only to absorb SKUs
  if (ownKey) { spelling.set(ownKey, profile.brand.name); roots.add(ownKey); }
  for (const [key, name] of configured) { spelling.set(key, name); roots.add(key); }
  for (const rec of records || []) {
    for (const b of rec.brandMentions || []) {
      const name = String(b.brand || "").trim();
      const key = normName(name);
      if (!key) continue;
      if (!spelling.has(key)) spelling.set(key, name);
    }
  }

  // A competitor is a BRAND, not a SKU. Detection legitimately returns both
  // "Vivo" and "vivo X200 FE" from the same corpus; counted separately they
  // split one competitor's share of voice across two rows, and the SKU row
  // then under-matches, because brandPresence looks for that exact string and
  // plain "Vivo" mentions don't contain it. So a name whose leading words are
  // another known name collapses onto the shorter one.
  const canon = new Map(); // key -> the key it counts as
  const keys = [...spelling.keys()].sort((a, b) => a.length - b.length);
  for (const key of keys) {
    let root = key;
    for (const other of keys) {
      if (other.length >= key.length) break;
      if (key.startsWith(other + " ")) { root = other; break; }
    }
    canon.set(key, root);
  }

  const seenIn = new Map(); // key -> { name, responses }
  for (const rec of records || []) {
    const perResponse = new Set();
    for (const b of rec.brandMentions || []) {
      // A count-0 entry was shown in a carousel but never written about; it is
      // still a real competitor appearance, so it counts here.
      const key = canon.get(normName(b.brand));
      // Roots are absorbers, not candidates: a SKU of the own brand or of a
      // configured competitor lands on that root and stops there.
      if (!key || roots.has(key) || excluded.has(key)) continue;
      if (perResponse.has(key)) continue;
      perResponse.add(key);
      const cur = seenIn.get(key) || { name: spelling.get(key), responses: 0 };
      cur.responses++;
      seenIn.set(key, cur);
    }
  }

  return [...seenIn.values()]
    .sort((a, b) => b.responses - a.responses || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map((c) => ({ name: c.name, url: "", isOwn: false, auto: true, responses: c.responses }));
}

/**
 * The brand set a campaign should actually be measured against: what the user
 * configured, plus — only when they configured no competitors at all —
 * whatever the captures show they are competing with.
 */
export function effectiveTrackedBrands(profile, records) {
  const configured = trackedBrandsOf(profile);
  const hasCompetitors = configured.some((b) => !b.isOwn);
  if (hasCompetitors) return configured;
  const auto = autoCompetitorsFrom(records, profile).map(({ name, url, isOwn, auto }) => ({ name, url, isOwn, auto }));
  return configured.concat(auto);
}

/* ---------------- the metrics ---------------- */

/**
 * Compute the tracking metrics over a set of responses.
 *
 * @param records  responses (already filtered to one profile / period / tags)
 * @param profile  the brand profile (supplies brand + competitors)
 * @param brands   the brand set to measure against; defaults to whatever the
 *                 profile configures. Pass effectiveTrackedBrands() to include
 *                 competitors inferred from the captures.
 * @returns { totalResponses, brands: [...], sentiment: null }
 */
export function computeMetrics(records, profile, brands = trackedBrandsOf(profile)) {
  const totalResponses = records.length;

  const acc = new Map(
    brands.map((b) => [
      normName(b.name),
      {
        name: b.name,
        url: b.url || "",
        isOwn: !!b.isOwn,
        // Inferred from the captures rather than typed by the user; carried
        // through so the UI can label the row instead of implying the user
        // chose to track this brand.
        auto: !!b.auto,
        responsesPresent: 0,
        mentions: 0,
        positions: [],
        citedResponses: 0,
        sourceResponses: 0,
      },
    ])
  );

  for (const rec of records) {
    const pres = brandPresence(rec, brands);

    // Rank tracked brands by where each first appears in the answer text.
    // Only brands actually located in the text can be ranked; a brand that is
    // "present" only via a carousel has no position in the prose.
    const ranked = pres
      .filter((p) => p.firstIndex !== null)
      .sort((a, b) => a.firstIndex - b.firstIndex);
    const rankOf = new Map(ranked.map((p, i) => [p.key, i + 1]));

    for (const p of pres) {
      const a = acc.get(p.key);
      if (!a) continue;
      if (p.present) a.responsesPresent++;
      a.mentions += p.mentions;
      const rank = rankOf.get(p.key);
      if (rank) a.positions.push(rank);
      if (p.citedSource) a.citedResponses++;
      if (p.anySource) a.sourceResponses++;
    }
  }

  // Share of Voice denominator: mentions of ALL tracked brands combined.
  // Share of Voice denominator — see glossary.js `shareOfVoice`.
  const mentionPool = [...acc.values()].reduce((n, a) => n + a.mentions, 0);

  const out = [...acc.values()].map((a) => ({
    name: a.name,
    url: a.url,
    isOwn: a.isOwn,
    auto: a.auto,
    // glossary.js `visibility`
    visibility: totalResponses ? (a.responsesPresent / totalResponses) * 100 : 0,
    // glossary.js `shareOfVoice`
    shareOfVoice: mentionPool ? (a.mentions / mentionPool) * 100 : 0,
    mentions: a.mentions,
    responsesPresent: a.responsesPresent,
    // glossary.js `avgPosition`: averaged across responses where the brand
    // appears, so responses without it are excluded rather than scored as a
    // penalty rank. null when it never appeared.
    avgPosition: a.positions.length ? a.positions.reduce((x, y) => x + y, 0) / a.positions.length : null,
    citations: a.citedResponses,
    // Share of responses where this brand's own domain surfaced as a source at
    // all (cited or merely fetched) — "did my site get pulled into the answer".
    sourceVisibility: totalResponses ? (a.sourceResponses / totalResponses) * 100 : 0,
    sourceResponses: a.sourceResponses,
  }));

  out.sort((a, b) => (b.isOwn ? 1 : 0) - (a.isOwn ? 1 : 0) || b.visibility - a.visibility);

  return {
    totalResponses,
    mentionPool,
    brands: out,
    own: out.find((b) => b.isOwn) || null,
    sentiment: null, // see SENTIMENT_NOTE
  };
}

/** Bucket a day/week key out of a timestamp, for the trend series. */
export function bucketKey(ts, bucket = "day") {
  const d = new Date(ts);
  if (bucket === "week") {
    const day = (d.getUTCDay() + 6) % 7; // Monday-based
    d.setUTCDate(d.getUTCDate() - day);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Metrics per time bucket, for trend charts.
 *
 * `brands` is resolved once for the whole series rather than per bucket: a set
 * inferred from the captures would otherwise differ from day to day and the
 * trend lines would appear and vanish for reasons that have nothing to do with
 * the trend.
 */
export function computeSeries(records, profile, bucket = "day", brands = trackedBrandsOf(profile)) {
  const groups = new Map();
  for (const r of records) {
    const k = bucketKey(r.capturedAt, bucket);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, recs]) => ({ key, ...computeMetrics(recs, profile, brands) }));
}

/** Every distinct tag across a prompt list (for the filter chips). */
export function allTags(prompts) {
  const s = new Set();
  for (const p of prompts || []) for (const t of p.tags || []) s.add(t);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/**
 * Is a tracking run due? "Manual + daily reminder" mode: we never fire on our
 * own, we only report that a day has elapsed since the last completed run.
 */
export function runDue(profile, now = Date.now()) {
  if (!profile) return false;
  if (!profile.lastRunAt) return true;
  return bucketKey(profile.lastRunAt) !== bucketKey(now);
}

/* ---------------- Retention policy ----------------
 * Which captures the retention cap is allowed to delete.
 *
 * enforceRetention() used to prune purely by age, oldest first, with no idea
 * what it was deleting. That is fine while browsing ad-hoc, but it silently
 * destroys measurement data during a large campaign run: the default cap is
 * 2000 captures, and a 1000-prompt run across two engines produces exactly
 * 2000 — so once the store fills, every new capture deleted the oldest, which
 * by then were that same run's own earlier results. The run cannibalised
 * itself and the missing prompts looked like a capture failure.
 *
 * A campaign capture is the product of a deliberate, reproducible measurement
 * the user set up and waited for; an ad-hoc browsing capture is a by-product
 * of looking at something once. Only the latter is disposable. Tracked
 * captures carry the `geo` provenance bag (profileId/runId/promptId) — that
 * flag is the whole basis of the ad-hoc/campaign split described in the
 * README, so it is exactly the right thing to key this on.
 *
 * Consequence, accepted deliberately: a store consisting only of campaign
 * captures can exceed the cap and keep growing. That is the correct trade —
 * "unlimitedStorage" is already granted, and losing measurement data is far
 * worse than using more disk. Storage usage is shown in the About tab.
 */
export function isPrunableCapture(rec) {
  if (!rec) return false;
  // Legacy records predate the geo bag entirely and have no key at all; those
  // are ad-hoc by definition (see the isTracked note elsewhere in this file).
  return !rec.geo;
}

/**
 * Which manual captures to delete (0.73.1). The cap counts manual captures
 * only: counting campaign captures too meant that once campaigns filled the
 * cap, the one manual capture just stored was the whole excess and was
 * deleted the moment it arrived, so a question asked by hand never appeared.
 * The capture just stored is never chosen.
 * @param {string[]} prunableOldestFirst  ids of manual captures, oldest first
 * @param {number} limit  how many manual captures to keep
 * @param {string} [keepId]  the capture just stored
 */
export function retentionVictims(prunableOldestFirst, limit, keepId) {
  const ids = prunableOldestFirst || [];
  const excess = ids.length - Math.max(1, limit || 0);
  if (excess <= 0) return [];
  return ids.filter((id) => id !== keepId).slice(0, excess);
}

/** Submissions a run will make — surfaced in the UI before the user commits. */
export function runVolume(prompts, engines) {
  const active = (prompts || []).filter((p) => p.active !== false).length;
  const eng = (engines || []).length;
  return { prompts: active, engines: eng, submissions: active * eng };
}

/* ---------------- Loader run-progress reconciliation ----------------
 * The Loader (background.js) tracks its own progress (`idx`) in memory as it
 * runs, but that counter lives in the MV3 service worker, which Chrome can
 * kill and restart at any moment — dropping the counter along with it. A
 * restarted worker must not just trust whatever `idx` it can recover (from
 * storage, possibly stale by exactly the completion that was in flight when
 * it died) — it must ask the one place that can't lie: the derived captures
 * actually stored for this run. This is that answer, kept here (not in
 * background.js) so it's a plain, testable function over data, with no
 * chrome.* APIs involved.
 */

// A capture with no prompt AND no fan-out/sources/products/places/answer
// text. ChatGPT races parallel requests per turn; the losing racer still
// hits the capture endpoint but streams almost nothing. These must never
// count as a completed turn, or a restart's reconciliation would silently
// skip real prompts. (Same definition background.js has always used for
// this — kept here too since reconciliation needs it and this module must
// not import from background.js.)
export function hasSignal(r) {
  if (!r) return false;
  const f = r.fanout || {};
  const fan = (f.search?.length || 0) + (f.shopping?.length || 0) + (f.image?.length || 0);
  return !!(
    r.userPrompt ||
    fan ||
    r.sources?.length ||
    r.products?.length ||
    r.places?.length ||
    r.answerChars
  );
}

/**
 * Whether a capture finishes a campaign turn (0.62.2). hasSignal() is enough
 * for most engines, but Grok's gateway hands over what it has whenever its
 * socket goes quiet: the prompt, then the search results, then the answer.
 * In the owner's Motorola run every Grok turn was counted on the first of
 * those, the tab moved on, and none of the 30 answers was ever captured. A
 * gateway turn is done only once Grok says the response completed and there
 * is answer text.
 */
// The statuses a signed-out answer carries while it's still being written
// ("pending", "streaming"); "resolved" and "complete" are done. Matched whole
// (0.79.0): the old pattern also matched finished words such as
// "stream_complete" or "generated", and such a capture waited out the turn.
const STILL_WRITING_RE = /^(?:in_?progress|streaming|pending|running|generating|queued)$/i;

export function turnAnswered(r) {
  if (!hasSignal(r)) return false;
  const ps = (r && r.platformSpecific) || {};
  if (r.platform === "grok" && ps.transport === "gateway") return ps.gatewayStatus === "completed" && (r.answerChars || 0) > 0;
  // Gemini's stream is handed over whenever it goes quiet, which can be
  // while it is still searching (0.69.0): done only with answer text.
  if (r.platform === "gemini" && ps.transport === "webchannel") return (r.answerChars || 0) > 0;
  // ChatGPT signed out (0.69.0): handed over whenever its stream goes quiet,
  // so a snapshot still being written doesn't count.
  if (r.platform === "chatgpt" && ps.transport === "conversation-source") return (r.answerChars || 0) > 0 && !STILL_WRITING_RE.test(ps.status || "");
  return true;
}

/** An engine-side limit the capture itself reports (Grok's stream_error). */
export function usageLimitOf(r) {
  const e = r && r.platformSpecific && r.platformSpecific.gatewayError;
  return typeof e === "string" && /limit|rate|quota|too_many/i.test(e) ? e : null;
}

/**
 * How many prompts have genuinely completed for one platform of one Loader
 * run, per the derived store itself — not per any in-memory or persisted
 * counter. `runId` matches `record.runId`, stamped on every capture made
 * during a Loader run (ad-hoc Project runs and GEO Campaign runs alike —
 * both go through the same Loader and both stamp it; see storeCapture's
 * `meta.runId` in background.js). Assumes at most one signal-bearing
 * capture per completed turn, which is exactly what the watchdog +
 * MIN_ADVANCE_GAP_MS debounce in background.js guarantee.
 */
export function countCompletedForRun(records, runId, platform) {
  if (!runId) return 0;
  let n = 0;
  for (const r of records || []) {
    if (r.runId === runId && r.platform === platform && hasSignal(r)) n++;
  }
  return n;
}

/**
 * The same reconciliation as countCompletedForRun, but scoped to ONE
 * concurrent tab's own shard of the prompt list rather than the whole
 * platform.
 *
 * With multiple tabs per engine (src/lib/pacing.js's shardPrompts),
 * `countCompletedForRun` alone isn't enough to recover after a restart: it
 * returns one number for the whole platform, but each tab's own `idx` needs
 * reconciling against only ITS OWN prompts, not the platform's total —
 * otherwise a tab that has done 3 of its own 4 prompts could be "corrected"
 * using a count that includes the OTHER tab's completions too, resubmitting
 * or skipping prompts that were never actually assigned to it.
 *
 * Matched by normalized prompt text rather than an explicit shard id,
 * because captures don't carry one (they carry `userPrompt`, the plain
 * string that was actually submitted) — the same normalize-and-compare
 * approach the live late-capture guard in background.js already uses, so
 * "which shard does this capture belong to" is answered the same way
 * whether the run is live or being reconciled after a restart. Deduped by
 * distinct prompt text on purpose: a shard's own list is what the tab was
 * ASKED, and asking the same question twice in one shard (a duplicate
 * prompt) should only ever count once here — the live per-turn advance
 * logic is what actually paces repeats, not this recovery path.
 */
export function countCompletedForLeg(records, runId, platform, legPrompts) {
  if (!runId) return 0;
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = new Set((legPrompts || []).map(norm));
  if (!want.size) return 0;
  const seen = new Set();
  for (const r of records || []) {
    if (r.runId !== runId || r.platform !== platform || !hasSignal(r)) continue;
    const key = norm(r.userPrompt);
    if (want.has(key)) seen.add(key);
  }
  return seen.size;
}

/* ---------------- competitive analysis for one brand ---------------- */

/**
 * Head-to-head between two tracked brands over the same responses.
 *
 * The competitor question a campaign is actually asked is not "what is their
 * Share of Voice" — that is on the table already — but "where do they get in
 * and we don't". Only a per-response comparison can answer that, and the
 * aggregate metrics deliberately throw the pairing away.
 *
 * `aheadA` / `aheadB` compare where each brand FIRST appears in the prose.
 * Only responses where both are locatable in the text can be ordered; a brand
 * present only via a carousel has no position, so those land in `bothUnranked`
 * rather than being scored as a loss for either side.
 *
 * @returns { responses, both, aOnly, bOnly, neither, aheadA, aheadB, bothUnranked }
 */
export function headToHead(records, trackedBrands, aName, bName) {
  const aKey = normName(aName);
  const bKey = normName(bName);
  const out = { responses: 0, both: 0, aOnly: 0, bOnly: 0, neither: 0, aheadA: 0, aheadB: 0, bothUnranked: 0 };
  if (!aKey || !bKey || aKey === bKey) return out;

  for (const rec of records || []) {
    out.responses++;
    const pres = brandPresence(rec, trackedBrands);
    const a = pres.find((p) => p.key === aKey);
    const b = pres.find((p) => p.key === bKey);
    const aIn = !!a?.present;
    const bIn = !!b?.present;

    if (aIn && bIn) {
      out.both++;
      if (a.firstIndex !== null && b.firstIndex !== null) {
        if (a.firstIndex < b.firstIndex) out.aheadA++;
        else if (b.firstIndex < a.firstIndex) out.aheadB++;
        else out.bothUnranked++;   // same offset: neither is "first"
      } else out.bothUnranked++;
    } else if (aIn) out.aOnly++;
    else if (bIn) out.bOnly++;
    else out.neither++;
  }
  return out;
}

/**
 * The domains cited in the answers that mention a given brand.
 *
 * Deliberately named for what it measures. This is NOT "the sites that write
 * about this brand" — a source can be cited in an answer for a reason nothing
 * to do with the brand named three paragraphs later. It is "when the engine
 * says this name, what was it reading", which is the honest and still useful
 * version of the question, and the closest thing the captured data supports.
 *
 * @returns [{ domain, citations, citedResponses, visibility }] — visibility is
 *          over the responses MENTIONING the brand, not over all responses.
 */
export function brandSourceDomains(records, trackedBrands, name, limit = 10) {
  const key = normName(name);
  if (!key) return [];

  const agg = new Map();
  let mentioning = 0;
  for (const rec of records || []) {
    const pres = brandPresence(rec, trackedBrands).find((p) => p.key === key);
    if (!pres?.present) continue;
    mentioning++;

    const citedHere = new Set();
    for (const s of rec.sources || []) {
      if (!s.domain || s.outcome !== "cited") continue;
      const row = agg.get(s.domain) || { domain: s.domain, citations: 0, citedResponses: 0 };
      row.citations++;
      agg.set(s.domain, row);
      citedHere.add(s.domain);
    }
    for (const d of citedHere) agg.get(d).citedResponses++;
  }

  return [...agg.values()]
    .map((r) => ({ ...r, visibility: mentioning ? (r.citedResponses / mentioning) * 100 : 0 }))
    .sort((a, b) => b.citedResponses - a.citedResponses || b.citations - a.citations
      || a.domain.localeCompare(b.domain))
    .slice(0, Math.max(0, limit));
}

/* "Retry missing" (0.78.1): ask again only the prompts a finished run has no
 * answer for, engine by engine, and add the answers to that same run. In the
 * owner's 752-turn run, 101 turns had no answer (65 never accepted by the
 * send button, 28 sent with no answer, ChatGPT's message limit on top). */
export function missingTurns(run, prompts, records) {
  const have = new Set();
  for (const r of records || []) {
    if (!r.geo || r.geo.runId !== run.id || !(r.answerChars > 0)) continue;
    have.add(`${r.platform}|${r.geo.promptId}`);
  }
  const ids = new Set(run.promptIds || []);
  const list = (prompts || []).filter((p) => ids.has(p.id));
  const only = {};
  let n = 0;
  for (const e of run.engines || []) {
    only[e] = [];
    list.forEach((p, i) => { if (!have.has(`${e}|${p.id}`)) { only[e].push(i); n++; } });
  }
  return { prompts: list, only, count: n };
}
