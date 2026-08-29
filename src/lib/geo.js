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
  // Blocked pending a real-capture calibration pass — the same bar Perplexity
  // and Grok had to clear before flipping to available:true. Both of those
  // shipped bugs when built against guessed markup instead of a real capture
  // (see the interception + citation-marking fixes in this repo's history);
  // adapters/claude.js has zero real fixtures backing it, unlike either.
  { id: "claude", label: "Claude", host: "claude.ai", available: false, note: "coming soon" },
  { id: "grok", label: "Grok", host: "grok.com", available: true },
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
