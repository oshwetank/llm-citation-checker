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
 * METRIC DEFINITIONS — provenance matters here, so it's recorded per metric:
 *   Visibility and Share of Voice use Peec.ai's published formulas verbatim
 *   (docs.peec.ai/metrics/brand-metrics/{visibility,share-of-voice}) so numbers
 *   are comparable with that tool. Position uses the one thing Peec's page does
 *   state ("average ranking across all responses where your brand appears") and
 *   derives rank from our own data. Sentiment is NOT implemented — Peec's page
 *   defines neither a formula nor an aggregation method, and inventing a 0-100
 *   score in a measurement tool would be worse than the gap. See SENTIMENT_NOTE.
 */

export const MAX_PROFILES = 3;

// A soft-deleted campaign stays recoverable for this many days before it's
// purged for real (see "geo-profile-trash"/"geo-profile-restore" in
// background.js and the lazy sweep in "geo-profile-list").
export const TRASH_RETENTION_DAYS = 7;

export const SENTIMENT_NOTE =
  "Sentiment is not measured yet. The published definition gives a 0-100 scale " +
  "but no formula or aggregation method, and a fabricated score would be worse " +
  "than an honest gap. It needs either an LLM judge pass over each answer or a " +
  "documented lexicon before it can be trusted.";

/* ---------------- engine registry ----------------
 * `available` reflects what this extension can ACTUALLY drive today: an engine
 * needs host_permissions + a content script + an adapter. Unavailable engines
 * are shown disabled rather than hidden, so the roadmap is visible and a metric
 * can never silently under-count because a checkbox did nothing.
 */
export const ENGINES = [
  { id: "chatgpt", label: "ChatGPT", host: "chatgpt.com", available: true },
  { id: "gemini", label: "Gemini", host: "gemini.google.com", available: true },
  { id: "perplexity", label: "Perplexity", host: "perplexity.ai", available: false, note: "adapter not built yet" },
  { id: "claude", label: "Claude", host: "claude.ai", available: false, note: "adapter not built yet" },
  { id: "grok", label: "Grok", host: "grok.com", available: false, note: "adapter not built yet" },
];

export const availableEngines = () => ENGINES.filter((e) => e.available);

/* ---------------- normalisation helpers ---------------- */

// Brand names are compared loosely (case, punctuation, spacing) because the
// same company shows up as "Angel One" / "AngelOne" / "angel one" across
// answers, and a tracking table that lists those as three brands is useless.
export function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
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
  };
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

/** Records for one profile, optionally narrowed by engine / tags / time. */
export function selectTracked(records, { profileId, engines, tags, since, until, runId } = {}) {
  return (records || []).filter((r) => {
    if (!isTracked(r)) return false;
    if (profileId && r.geo.profileId !== profileId) return false;
    if (runId && r.geo.runId !== runId) return false;
    if (engines && engines.length && !engines.includes(r.platform)) return false;
    if (since && r.capturedAt < since) return false;
    if (until && r.capturedAt > until) return false;
    if (tags && tags.length) {
      const rt = r.geo.tags || [];
      if (!tags.some((t) => rt.includes(t))) return false;
    }
    return true;
  });
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
export function brandPresence(rec, trackedBrands) {
  const text = rec.answerText || "";
  const mentions = rec.brandMentions || [];
  const sources = rec.sources || [];

  return trackedBrands.map((b) => {
    const key = normName(b.name);
    const hit = mentions.find((m) => normName(m.brand) === key);
    const count = hit ? Number(hit.count) || 0 : 0;
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
      const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi");
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

/* ---------------- the metrics ---------------- */

/**
 * Compute the tracking metrics over a set of responses.
 *
 * @param records  responses (already filtered to one profile / period / tags)
 * @param profile  the brand profile (supplies brand + competitors)
 * @returns { totalResponses, brands: [...], sentiment: null }
 */
export function computeMetrics(records, profile) {
  const brands = trackedBrandsOf(profile);
  const totalResponses = records.length;

  const acc = new Map(
    brands.map((b) => [
      normName(b.name),
      {
        name: b.name,
        url: b.url || "",
        isOwn: !!b.isOwn,
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
  // Peec: "SoV = (times your brand was mentioned) / (total brand mentions) × 100".
  const mentionPool = [...acc.values()].reduce((n, a) => n + a.mentions, 0);

  const out = [...acc.values()].map((a) => ({
    name: a.name,
    url: a.url,
    isOwn: a.isOwn,
    // Peec: "Visibility = (responses mentioning your brand / total responses) × 100"
    visibility: totalResponses ? (a.responsesPresent / totalResponses) * 100 : 0,
    // Peec: "SoV = (your mentions) / (total mentions of all tracked brands) × 100"
    shareOfVoice: mentionPool ? (a.mentions / mentionPool) * 100 : 0,
    mentions: a.mentions,
    responsesPresent: a.responsesPresent,
    // Peec states position averages "across all responses where your brand
    // appears" — so responses without the brand are excluded rather than
    // scored as a penalty rank. null when it never appeared.
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

/** Metrics per time bucket, for trend charts. */
export function computeSeries(records, profile, bucket = "day") {
  const groups = new Map();
  for (const r of records) {
    const k = bucketKey(r.capturedAt, bucket);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, recs]) => ({ key, ...computeMetrics(recs, profile) }));
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

/** Submissions a run will make — surfaced in the UI before the user commits. */
export function runVolume(prompts, engines) {
  const active = (prompts || []).filter((p) => p.active !== false).length;
  const eng = (engines || []).length;
  return { prompts: active, engines: eng, submissions: active * eng };
}
