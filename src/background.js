/*
 * background.js — MV3 service worker. The only place that touches storage.
 *
 * Flow:
 *   raw-conversation  → gzip + persist RAW (immutable) → run adapter → persist DERIVED
 *   get-records       → derived records for list/aggregate views (heavy fields stripped)
 *   get-record        → ONE full derived record (includes answerText) for Analyze
 *   get-raw           → decompressed raw payload for a capture (debug view)
 *   reprocess-all     → re-run adapters over the raw store (after adapter upgrades)
 *   clear-all         → wipe both stores
 *
 * No network calls. Nothing leaves the device.
 */

import { db } from "./lib/db.js";
import {
  turnBudgetMs, legEta, INTER_PROMPT_MIN_MS, INTER_PROMPT_MAX_MS,
  CONCURRENT_TABS_PER_ENGINE, LEG_START_STAGGER_MS, shardPrompts,
  parseCooldownFromNotice, formatCooldown,
} from "./lib/pacing.js";
import { createErrorLog } from "./lib/errorlog.js";
import { buildCampaignWorkbook } from "./lib/campaignWorkbook.js";
import { gzipString, gunzipToString } from "./lib/gzip.js";
import { adapt as adaptChatGpt, cleanPassage } from "./adapters/chatgpt.js";
import { enrichBrandsWithAI } from "./lib/ai-brands.js";
import { adapt as adaptGemini } from "./adapters/gemini.js";
import { adapt as adaptPerplexity } from "./adapters/perplexity.js";
import { adapt as adaptGrok } from "./adapters/grok.js";
import { adapt as adaptClaude } from "./adapters/claude.js";
import {
  MAX_PROFILES, TRASH_RETENTION_DAYS, makeProfile, makeTrackedPrompt, makeGeoRun, runVolume,
  selectTracked, computeMetrics, computeSeries, brandPresence, normName,
  effectiveTrackedBrands, headToHead, brandSourceDomains,
  hasSignal, countCompletedForRun, countCompletedForLeg, isPrunableCapture,
} from "./lib/geo.js";
export { hasSignal };

// Loose match for duplicate-prompt detection: trim, lowercase, collapse
// whitespace. Deliberately NOT as aggressive as geo.js's normName() (which
// strips all punctuation) — "40,000" and "40000" should probably stay
// distinct prompts, just exact-text-modulo-whitespace duplicates should not.
function normPromptText(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const ADAPTERS = {
  chatgpt: adaptChatGpt,
  gemini: adaptGemini,
  perplexity: adaptPerplexity,
  grok: adaptGrok,
  claude: adaptClaude,
};

const AI_TAB_MATCHES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://www.perplexity.ai/*",
  "https://perplexity.ai/*",
  "https://grok.com/*",
  "https://x.com/i/grok/*",
  "https://x.com/i/grok",
  "https://claude.ai/*",
];

/* ---------- Settings ---------- */
const DEFAULT_SETTINGS = {
  // Who the user is tracking. This does NOT drive brand detection — detection is
  // automatic and industry-agnostic (see lib/brands.js). These entries only LABEL
  // detected brands as own/competitor so share-of-voice can be reported, and the
  // URLs let cited domains be attributed to the right brand.
  myBrand: { name: "", url: "" },
  competitors: [], // [{ name, url }]
  debugCapture: false, // diagnostic channel is OFF by default (it is chatty)
  maxCaptureMB: 8, // skip storing a single raw payload larger than this
  retentionMax: 2000, // keep at most N captures; oldest pruned first
};

// Flatten settings into the label list the adapters take.
function trackedFrom(settings) {
  const out = [];
  if (settings.myBrand && settings.myBrand.name) {
    out.push({ name: settings.myBrand.name, url: settings.myBrand.url || "", relation: "own" });
  }
  (settings.competitors || []).forEach((c) => {
    if (c && c.name) out.push({ name: c.name, url: c.url || "", relation: "competitor" });
  });
  return out;
}

// Cached: getSettings() runs on every capture, and settings change rarely.
let settingsCache = null;
async function getSettings() {
  if (settingsCache) return settingsCache;
  const got = await chrome.storage.local.get("lcfcSettings");
  settingsCache = { ...DEFAULT_SETTINGS, ...(got.lcfcSettings || {}) };
  return settingsCache;
}
async function setSettings(patch) {
  const next = { ...(await getSettings()), ...(patch || {}) };
  await chrome.storage.local.set({ lcfcSettings: next });
  settingsCache = next;
  return next;
}
// Keep the cache honest if settings are changed from another context.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lcfcSettings) settingsCache = null;
});

// Reloading the extension orphans content scripts already running in open tabs
// (they can no longer reach the new service worker — capture goes silent).
// Auto-refresh the AI tabs on install/update so their scripts re-inject.
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: AI_TAB_MATCHES }, (tabs) => {
    for (const t of tabs || []) {
      try {
        chrome.tabs.reload(t.id);
      } catch (_) {
        /* tab may be discarded/closed */
      }
    }
  });
});

function platformFromUrl(url) {
  const u = String(url || "");
  if (/gemini\.google\.com|BardChatUi|StreamGenerate/i.test(u)) return "gemini";
  if (/perplexity\.ai|\/api\/sse\/query|\/api\/thread|\/rest\/queries/i.test(u)) return "perplexity";
  if (/grok\.com|x\.com\/i\/grok|app-chat\/conversations/i.test(u)) return "grok";
  if (/claude\.ai|chat_conversations/i.test(u)) return "claude";
  if (/chatgpt\.com|chat\.openai\.com|backend-api/i.test(u)) return "chatgpt";
  return "chatgpt";
}

/* ---------- Capture ---------- */
async function storeCapture(payload, meta) {
  const platform = platformFromUrl(payload.pageUrl || payload.url);
  const settings = await getSettings();
  const rawText = payload.raw || "";

  // Gemini emits many small RPCs; only the assistant generation is substantial.
  if (platform === "gemini" && rawText.length < 2000) return null;

  // Perplexity background sidebar subscriptions shouldn't create dummy captures.
  if (rawText.includes("SidebarRecentThreadsUpdatesRelaySubscription") && !rawText.includes('"web_results"') && !rawText.includes('"sources"') && !rawText.includes('"chunks"')) {
    return null;
  }

  // Guard against pathological payloads (Gemini local/map answers have been seen
  // at 25MB raw / ~5MB stored). Without a cap the store grows ~1GB per 1k captures.
  const capBytes = Math.max(1, settings.maxCaptureMB) * 1024 * 1024;
  if (rawText.length > capBytes) {
    return { skipped: "too-large", bytes: rawText.length };
  }

  const captureId = crypto.randomUUID();
  const rawRow = {
    captureId,
    platform,
    url: payload.url,
    reqBody: payload.reqBody,
    transport: payload.transport,
    pageUrl: payload.pageUrl,
    capturedAt: payload.capturedAt,
    projectId: (meta && meta.projectId) || null, // on raw so reprocess preserves it
    runId: (meta && meta.runId) || null,
    geo: (meta && meta.geo) || null, // ditto: tracking provenance must survive reprocess

    gz: await gzipString(rawText),
    rawSchema: 1,
  };
  await db.put("raw", rawRow);

  const record = await deriveAndStore(rawRow, rawText, settings);
  await enforceRetention(settings);
  return { captureId, record };
}

// Build a derived record from a raw row. `rawText` optional (avoids re-gunzip).
/**
 * Optional on-device AI enrichment, AFTER the capture is already saved.
 *
 * This used to run inside the adapter, so storeCapture() could not finish —
 * and the panel had nothing to show — until Chrome's on-device model had
 * finished an inference over up to 6000 characters. On a machine where that
 * model is available it is the difference between a capture appearing at once
 * and appearing ~20 seconds after the answer was already fully written.
 *
 * Best-effort by construction: it only ever ADDS or upgrades names (see
 * mergeAiNames in lib/ai-brands.js), and the record it improves is already
 * durable. If it finds nothing, times out, throws, or the service worker is
 * torn down before it lands, the stored record simply stays as the
 * deterministic detector produced it — which is exactly what every machine
 * without the on-device model gets anyway.
 */
async function enrichCaptureWithAI(record) {
  try {
    if (!record || !record.answerText) return;
    // Each adapter counts mentions against its own cleaned text; match that
    // here so the AI merge verifies names against the same string.
    const plain = record.platform === "chatgpt"
      ? cleanPassage(record.answerText)
      : record.answerText;
    const improved = await enrichBrandsWithAI(record.brandMentions || [], plain);
    if (!improved) return;

    // Re-read rather than reusing the in-memory copy: a reprocess or a delete
    // may have landed while the model was thinking.
    const current = await db.get("derived", record.captureId);
    if (!current) return;
    current.brandMentions = improved;
    await db.put("derived", current);
    try {
      chrome.runtime.sendMessage(
        { type: "capture-updated", captureId: record.captureId },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  } catch (_) {
    /* enrichment is optional; never let it surface as a capture failure */
  }
}

async function deriveAndStore(rawRow, rawText, settings) {
  const raw = rawText ?? (await gunzipToString(rawRow.gz));
  const cfg = settings || (await getSettings());
  const adapter = ADAPTERS[rawRow.platform] || ADAPTERS.chatgpt;
  const record = await adapter(
    {
      captureId: rawRow.captureId,
      raw,
      reqBody: rawRow.reqBody,
      capturedAt: rawRow.capturedAt,
      pageUrl: rawRow.pageUrl,
    },
    { tracked: trackedFrom(cfg) }
  );
  record.projectId = rawRow.projectId || null;
  record.runId = rawRow.runId || null;
  record.geo = rawRow.geo || null;
  await db.put("derived", record);
  return record;
}

// Keep the store bounded: prune the oldest AD-HOC captures beyond the
// retention limit. Campaign captures are never pruned — see
// isPrunableCapture() in lib/geo.js for why (short version: pruning by age
// alone made a large campaign run delete its own earlier results once the
// store filled, so prompts went missing and it looked like a capture bug).
async function enforceRetention(settings) {
  const cfg = settings || (await getSettings());
  const limit = Math.max(50, cfg.retentionMax || DEFAULT_SETTINGS.retentionMax);
  const count = await db.count("derived");
  if (count <= limit) return;
  const keys = await db.getOldestPrunableKeys("derived", count - limit, isPrunableCapture);
  for (const id of keys) {
    await db.delete("raw", id);
    await db.delete("derived", id);
  }
}

// Re-derive every stored capture. Uses a cursor + chunking so a large store
// doesn't pull every gzipped blob into memory at once (SW OOM risk).
async function reprocessAll() {
  const settings = await getSettings();
  const ids = await db.getAllKeys("raw");
  let ok = 0;
  for (const id of ids) {
    try {
      const row = await db.get("raw", id);
      if (row) {
        await deriveAndStore(row, undefined, settings);
        ok++;
      }
    } catch (_) {
      /* keep going; one bad payload shouldn't stop the batch */
    }
  }
  return { total: ids.length, reprocessed: ok };
}

/* ---------- Loader orchestration ----------
 * Fires a list of prompts, one per fresh chat. A capture WITH SIGNAL from the
 * loader tab is the "turn done" signal. Empty race-loser captures are ignored,
 * and a watchdog advances the run if a turn never completes (rate limit, error,
 * closed tab) instead of hanging forever.
 *
 * SURVIVING SERVICE-WORKER RESTARTS. MV3 kills this service worker after
 * ~30s idle, which used to silently drop the entire in-memory `loader`
 * object and every pending setTimeout watchdog with zero recovery: a run
 * would just stop, sometimes resuming oddly if some unrelated event happened
 * to wake the worker back up (its old timers were already gone, so nothing
 * had actually been advancing it), then stop again for good. Three pieces
 * fix this:
 *   1. `persistLoaderState()` writes a serializable snapshot of `loader` to
 *      chrome.storage.local (survives worker restarts AND a browser
 *      session — no new permission needed, it's part of the same "storage"
 *      permission already declared) after every state change.
 *   2. A `chrome.alarms` heartbeat (`HEARTBEAT_ALARM`, fires every minute —
 *      alarms, unlike setTimeout, wake a terminated service worker) notices
 *      when persisted state says a run should be active but this worker
 *      instance has no memory of it, and resumes it.
 *   3. Resuming never trusts the persisted `idx` blindly — it reconciles
 *      against the derived captures actually stored for this run
 *      (`countCompletedForRun`, lib/geo.js), the one thing that can't have
 *      desynced. This is what closes the duplicate/skipped-prompt class of
 *      bugs: a completion that landed right as the worker died is counted
 *      from the real data, not from a counter that might be stale by
 *      exactly that one step.
 */
/* Turn budget: adaptive, calibrated from each engine's own rolling turn
 * durations. See src/lib/pacing.js for why a single fixed 90s was wrong in
 * both directions (idle time on failures, fabricated failures on slow turns).
 */
/* CONCURRENCY. `loader.platforms[plat]` used to BE one leg: one tab, one
 * prompt list, one idx. It is now `{ legs: [leg, leg, …] }` — one entry per
 * concurrent tab, CONCURRENT_TABS_PER_ENGINE of them (src/lib/pacing.js).
 * Every function below that used to read a platform's tabId/idx/prompts
 * directly now takes the specific LEG it's operating on; nothing here still
 * assumes one tab per engine. A leg has the same shape the old flat object
 * did — tabId, prompts (its own shard), idx (local to that shard),
 * startOffset (this shard's position in the ORIGINAL prompt list, needed to
 * look up the right tracked-prompt provenance for a GEO campaign capture),
 * failed, lastAdvanceAt, startedAt, token, expectedPrompt, durations,
 * outcomes, watchdog.
 */
const MIN_ADVANCE_GAP_MS = 2500; // ignore a second "done" arriving right after one
/* Every failure gets recorded somewhere durable. See src/lib/errorlog.js for
 * why (the old DEBUG buffer died with the service worker) and for the privacy
 * rules it enforces on what may be written. `logErr` is fire-and-forget on
 * purpose: no call site should ever await, or be able to fail because of,
 * logging. */
const errorLog = createErrorLog(db);
const logErr = (where, err, ctx, trace) => { try { errorLog.record(where, err, ctx, trace); } catch (_) {} };

const LOADER_STATE_KEY = "lcfcLoaderState";
const HEARTBEAT_ALARM = "lcfcHeartbeat";
const DURATION_WINDOW = 10; // per-platform rolling window of turn durations, for Phase 2's ETA

let loader = newLoaderState();
function newLoaderState() {
  return { running: false, paused: false, options: {}, done: 0, errors: 0, total: 0, platforms: {}, runId: null, interrupted: null };
}

// Best-effort: a persistence failure must never break a run already in
// progress, so every call site fires this and moves on rather than awaiting
// a hard guarantee.
async function persistLoaderState() {
  try {
    const snap = {
      // Written on every state change, so this doubles as "when did this run
      // last make a move" — which is what LOADER_STATE_MAX_AGE_MS below
      // needs to tell a resumable run from an abandoned one.
      savedAt: Date.now(),
      running: loader.running,
      paused: loader.paused,
      // Must survive the restart too — it is the whole reason the run is
      // paused, and without it a resumed run just looks inexplicably stopped.
      interrupted: loader.interrupted || null,
      options: loader.options,
      done: loader.done,
      errors: loader.errors,
      total: loader.total,
      runId: loader.runId,
      platforms: Object.fromEntries(
        Object.entries(loader.platforms).map(([plat, pd]) => [
          plat,
          {
            legs: (pd.legs || []).map((leg) => ({
              tabId: leg.tabId,
              startOffset: leg.startOffset || 0,
              prompts: leg.prompts,
              idx: leg.idx,
              failed: leg.failed || 0,
              lastAdvanceAt: leg.lastAdvanceAt || 0,
              startedAt: leg.startedAt || 0,
              token: leg.token || null,
              expectedPrompt: leg.expectedPrompt || null,
              durations: leg.durations || [],
              outcomes: leg.outcomes || [],
              // Set only on a rate-limit hit — see loader-rate-limited — so
              // this one engine's legs sit out while a sibling platform's
              // legs (different account, different limit) keep running.
              // Must survive a restart or a resumed run would silently
              // un-pause a leg that was deliberately cooling down.
              paused: leg.paused || false,
            })),
          },
        ])
      ),
    };
    // storage.LOCAL, not .session. chrome.storage.session is cleared when the
    // browser closes, so any run longer than one browsing session — a
    // thousand prompts is several hours per engine — lost its entire state on
    // restart and could never be resumed. Local persists to disk.
    await chrome.storage.local.set({ [LOADER_STATE_KEY]: snap });
  } catch (err) {
    // Still best-effort — a persistence failure must not break a run in
    // flight — but no longer silent: this is exactly the failure that makes a
    // run unresumable later, and it used to leave no trace at all.
    logErr("persistLoaderState", err, { running: loader.running, total: loader.total });
  }
}
/* Moving to storage.local bought resumability across a browser restart, but
 * it also means an abandoned run no longer disappears on its own the way a
 * storage.session snapshot did. Without an expiry, a run the user closed the
 * browser on and never came back to would still be sitting in the Campaigns
 * tab as "paused — resume?" weeks later, and would block starting a fresh
 * one. A week is far longer than any real run needs to survive a restart or a
 * rate-limit window, and short enough that a forgotten run clears itself.
 * Completed and stopped runs are already handled — they persist with
 * running:false, which every caller checks — so this only ever catches a run
 * that was genuinely mid-flight when it was abandoned.
 */
const LOADER_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function loadPersistedLoaderState() {
  try {
    const got = await chrome.storage.local.get(LOADER_STATE_KEY);
    const snap = got[LOADER_STATE_KEY] || null;
    if (!snap) return null;
    // No savedAt means a snapshot written by a build before this field
    // existed. Treat it as current rather than dropping it — the worst case
    // is one extra expiry cycle, whereas discarding it would throw away a
    // real in-flight run on upgrade.
    if (snap.savedAt && Date.now() - snap.savedAt > LOADER_STATE_MAX_AGE_MS) {
      try { await chrome.storage.local.remove(LOADER_STATE_KEY); } catch (_) { /* best-effort */ }
      return null;
    }
    return snap;
  } catch (err) {
    logErr("loadPersistedLoaderState", err);
    return null;
  }
}

// Created once per worker instance. chrome.alarms.create overwrites an
// existing alarm of the same name rather than duplicating it, but calling it
// unconditionally on every worker startup would keep resetting the 1-minute
// schedule — check first so a worker that restarts often doesn't keep
// pushing the heartbeat further into the future.
(async () => {
  try {
    const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
    if (!existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  } catch (err) {
    // Degrades to setTimeout-only scheduling, which cannot survive the worker
    // being terminated — so a run may stall with no other symptom. Worth a
    // log line even though it only happens in unusual environments.
    logErr("alarms.create(heartbeat)", err);
  }
})();

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) heartbeatTick().catch(() => {});
});

async function heartbeatTick() {
  if (!loader.running) {
    // This worker instance has no memory of an active run. If persisted
    // state disagrees, a previous instance died mid-run — resume it.
    const snap = await loadPersistedLoaderState();
    if (snap && snap.running) await resumeFromSnapshot(snap);
    return;
  }
  if (loader.paused) return;
  // This instance already believes it's mid-run, with a setTimeout watchdog
  // armed per platform — those survive as long as THIS instance stays
  // alive, so there's normally nothing to do here. This loop is the safety
  // net for the rarer case where a turn is well past its timeout with no
  // watchdog armed (the timer itself got lost some other way, not the whole
  // worker) — the same recovery the watchdog itself would have done.
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    for (const leg of pd.legs || []) {
      if (leg.idx >= leg.prompts.length || !leg.startedAt || leg.watchdog || leg.paused) continue;
      if (Date.now() - leg.startedAt >= turnBudgetMs(leg) + 5000) failTurnAndAdvance(plat, leg, "watchdog lost");
    }
  }
}

// Reusable so the freshly-armed path (loaderRunLeg) and the recovered-
// after-restart path (resumeFromSnapshot) can never drift apart. Takes the
// LEG directly (not looked up by plat) because a platform can now have more
// than one concurrent leg.
function armWatchdog(plat, leg, ms) {
  if (!leg) return;
  leg.watchdog = setTimeout(() => {
    if (!loader.running || loader.paused || leg.paused) return;
    if (leg.idx >= leg.prompts.length) return;
    failTurnAndAdvance(plat, leg, "timeout");
  }, ms);
}

// The one place a turn is counted as failed and the run moves on — shared by
// the watchdog, the tab-closed path, and both restart-recovery paths below,
// so "what counts as a failure" can never quietly diverge between them.
// Takes the LEG directly, same reason as armWatchdog above.
// `retryDelayMs` defaults to immediate (matching the original watchdog
// behaviour); the tab-closed path passes a short delay to avoid hammering
// chrome.tabs.update in a tight loop if every remaining prompt in the list
// would also fail against the same closed tab.
function failTurnAndAdvance(plat, leg, reason, retryDelayMs = 0, trace = "") {
  if (!leg) return;
  loader.errors++;
  leg.failed = (leg.failed || 0) + 1;
  leg.outcomes = leg.outcomes || [];
  leg.outcomes[leg.idx] = { status: "failed", reason, at: Date.now() };
  leg.idx++;
  leg.lastAdvanceAt = Date.now();
  leg.lastFailReason = reason;
  /* A failed prompt is the breakage the user actually cares about — "prompts
   * missing from the results" is how it gets reported. The reason already
   * lands in the run's own histogram, but that is per-campaign and gets
   * summarised; the error log keeps the individual occurrences with which
   * engine and which position in the queue, which is what distinguishes "one
   * bad prompt" from "everything after number 340 failed".
   *
   * No prompt text: the index (leg-local, plus its startOffset so it still
   * locates the prompt in the original list even with concurrency splitting
   * it across tabs) is enough to find it, and the log is deliberately free
   * of user content (see lib/errorlog.js).
   */
  logErr(`run:turn-failed:${plat}`, reason, {
    platform: plat,
    promptIndex: (leg.startOffset || 0) + leg.idx - 1,
    totalPrompts: platformTotal(plat),
    failedSoFar: leg.failed,
    // Whether the content script ever reported anything for this turn. A
    // timeout with reported=false means the page-side script went quiet,
    // which is a different bug from one that tried and failed.
    reported: !!trace,
    elapsedMs: leg.startedAt ? Date.now() - leg.startedAt : 0,
  }, trace);
  persistLoaderState();
  syncGeoRun(undefined, reason);
  if (retryDelayMs > 0) setTimeout(() => loaderRunLeg(plat, leg), retryDelayMs);
  else loaderRunLeg(plat, leg);
}

// A snapshot written before concurrency shipped has the OLD flat shape —
// {tabId, prompts, idx, ...} directly on the platform, no `legs` array.
// LOADER_STATE_MAX_AGE_MS is 7 days, so a real in-flight run written by the
// previous build can still be sitting in storage the moment this build
// starts. Reading it as-is would find `pd.legs` undefined and silently lose
// the whole run; wrapping it as a single leg instead makes the upgrade
// transparent — the run resumes as one tab, exactly as it was running
// before, and the NEXT run it starts gets the new concurrency.
function legsOf(pd) {
  if (!pd) return [];
  if (Array.isArray(pd.legs)) return pd.legs;
  if (pd.tabId !== undefined || pd.prompts) return [pd];
  return [];
}

/**
 * Rebuild `loader` from a persisted snapshot after this worker instance
 * turns out to have no memory of an active run — i.e. a previous instance
 * died mid-run. Never trusts a leg's `idx` alone: reconciles against what's
 * actually in the derived store first (see the header comment above),
 * scoped to that leg's OWN shard of the prompt list (countCompletedForLeg,
 * lib/geo.js) — the whole-platform count isn't enough once a platform can
 * have more than one concurrent tab.
 */
async function resumeFromSnapshot(snap) {
  const platEntries = Object.entries(snap.platforms || {});
  const all = platEntries.length ? await db.getAll("derived") : [];

  loader = {
    running: true,
    paused: !!snap.paused,
    interrupted: snap.interrupted || null,
    options: snap.options || {},
    done: 0,
    errors: snap.errors || 0,
    total: snap.total || 0,
    runId: snap.runId,
    platforms: {},
  };

  for (const [plat, sp] of platEntries) {
    const legs = legsOf(sp).map((sl) => {
      const legPrompts = sl.prompts || [];
      const trueIdx = countCompletedForLeg(all, snap.runId, plat, legPrompts);
      const idx = Math.max(sl.idx || 0, Math.min(trueIdx, legPrompts.length));
      // Reconciliation can move idx forward past what this snapshot's own
      // outcomes array covers (the completion(s) happened in the instance
      // that died, before it got a chance to persist them) — backfill those
      // slots as "done" so the per-prompt status list stays accurate instead
      // of silently having gaps for prompts that did in fact complete.
      const outcomes = (sl.outcomes || []).slice();
      for (let i = sl.idx || 0; i < idx; i++) {
        if (!outcomes[i]) outcomes[i] = { status: "done", reason: null, at: Date.now() };
      }
      return {
        tabId: sl.tabId,
        startOffset: sl.startOffset || 0,
        prompts: legPrompts,
        idx,
        failed: sl.failed || 0,
        lastAdvanceAt: sl.lastAdvanceAt || 0,
        startedAt: sl.startedAt || Date.now(),
        token: sl.token || null,
        expectedPrompt: sl.expectedPrompt || null,
        durations: sl.durations || [],
        outcomes,
        watchdog: null,
        paused: !!sl.paused,
      };
    });
    loader.platforms[plat] = { legs };
  }
  loader.done = Object.values(loader.platforms)
    .reduce((n, pd) => n + pd.legs.reduce((m, leg) => m + leg.idx, 0), 0);

  if (loader.paused) {
    await persistLoaderState();
    return;
  }

  for (const [plat, pd] of Object.entries(loader.platforms)) {
    for (const leg of pd.legs) {
      if (leg.idx >= leg.prompts.length) continue; // this leg's shard already finished
      // Deliberately cooling down from a rate limit — don't touch its tab or
      // treat its silence as a crash; loader-resume clears this explicitly.
      if (leg.paused) continue;

      let tabAlive = true;
      try {
        await chrome.tabs.get(leg.tabId);
      } catch (_) {
        tabAlive = false;
      }

      if (!tabAlive) {
        // The tab is gone. It still must not be silently recreated — a
        // surprise tab navigating itself is exactly what the original code
        // was right to avoid — but marking every remaining prompt FAILED is
        // worse, and after a browser restart the tabs are ALWAYS gone, so a
        // long run would lose its whole remainder the moment it was
        // reloaded. That made runs longer than one browsing session
        // impossible.
        //
        // Instead the run is parked: still running, paused, flagged
        // resumable, nothing failed. The UI surfaces "interrupted — N left,
        // Resume?" and the user's explicit Resume recreates the tab (see
        // loader-resume). Deliberate, reversible, and no tab appears without
        // a click. Any ONE leg being gone parks the WHOLE run, same as
        // before concurrency — a partial resume (some tabs alive, some not)
        // would need its own "which legs are still going" UI, and simply
        // parking everything keeps one predictable recovery path.
        leg.tabId = null;
        loader.paused = true;
        loader.interrupted = { at: Date.now(), reason: "browser or tab closed mid-run" };
        continue;
      }

      const elapsed = Date.now() - (leg.startedAt || 0);
      const budget = turnBudgetMs(leg);
      if (elapsed >= budget) {
        // The turn that was in flight when the worker died has now definitely
        // timed out.
        failTurnAndAdvance(plat, leg, "timeout during restart");
      } else {
        armWatchdog(plat, leg, budget - elapsed);
      }
    }
  }

  if (Object.values(loader.platforms).every((pd) => pd.legs.every((leg) => leg.idx >= leg.prompts.length))) {
    loader.running = false;
    syncGeoRun("done");
    notifyRunComplete();
  }
  await persistLoaderState();
}

// Keeps the durable `geoRuns` record (src/lib/geo.js's makeGeoRun shape) in
// sync with the in-memory run as it progresses — previously this record was
// written once at creation and never touched again, so `status`/`captured`/
// `failed`/`finishedAt` were permanently stuck at their initial values and
// `geo-run-list` had nothing real to show. Only applies to GEO Campaign runs
// (loader.options.geo set); a plain ad-hoc Loader/Project run has no
// geoRuns record to update. Best-effort and fire-and-forget like
// persistLoaderState — a failure here must never affect the run itself.
// `reason`/`reasonCount`: tallies into the run's durable failure-reason
// histogram (makeGeoRun's `reasons`, lib/geo.js) — the one place a failure
// reason survives past this run's chrome.storage.local state, so a
// diagnostic report (see the "Copy diagnostic report" action in the About
// tab) can say WHY things failed without shipping any prompt/answer/URL
// content. `reasonCount` > 1 covers the bulk-fail path in
// resumeFromSnapshot (a whole platform's remaining leg failing at once).
// Chained through a single promise rather than each call firing
// independently. Callers routinely trigger two of these back to back for
// the SAME record — e.g. a failure (reason update) immediately followed by
// the "every platform's prompt list is now exhausted" completion check
// (status update) — and each does its own read-modify-write. Without
// serializing them, the second call's read can land before the first
// call's write finishes, and its write then silently clobbers the first's
// (a lost-update race — this is exactly how a failure-reason update was
// found, via a live test, being overwritten by the very next "done" status
// update). Chaining guarantees call N's read only happens after call N-1's
// write has actually landed.
let syncGeoRunChain = Promise.resolve();
function syncGeoRun(statusOverride, reason, reasonCount = 1) {
  syncGeoRunChain = syncGeoRunChain.then(() => syncGeoRunOnce(statusOverride, reason, reasonCount));
  return syncGeoRunChain;
}
async function syncGeoRunOnce(statusOverride, reason, reasonCount) {
  const g = loader.options && loader.options.geo;
  if (!g || !g.runId) return;
  try {
    const run = await db.get("geoRuns", g.runId);
    if (!run) return;
    const patch = { ...run, captured: loader.done, failed: loader.errors };
    if (reason) {
      const reasons = { ...(run.reasons || {}) };
      reasons[reason] = (reasons[reason] || 0) + reasonCount;
      patch.reasons = reasons;
    }
    if (statusOverride) {
      patch.status = statusOverride;
      patch.finishedAt = Date.now();
    }
    await db.put("geoRuns", patch);
  } catch (_) {
    /* best-effort */
  }
}

// Fires once a run finishes naturally (every platform's prompt list
// exhausted) — never on an explicit user-initiated stop, since the user is
// already right there for that. Two channels, per the agreed tradeoff:
//   - the toolbar badge needs no extra permission and is always available;
//   - chrome.notifications needs the "notifications" manifest permission
//     (and therefore a Chrome Web Store re-review before this can ship),
//     which was an explicit, accepted decision — see the PR description.
// Both are best-effort: a user on a build that hasn't picked up the new
// permission yet, or with notifications blocked at the OS level, still gets
// a working extension, just without this signal.
// A paused run is otherwise invisible until the user happens to look. A
// rate limit can arrive hours into a long run, so this is exactly the moment
// a notification earns its place — same best-effort contract as
// notifyRunComplete below (blocked notifications must never break a run).
async function notifyRateLimited(detail) {
  try {
    await chrome.action.setBadgeText({ text: "wait" });
    await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  } catch (err) { logErr("action.setBadgeText", err); }
  try {
    if (chrome.notifications) {
      await chrome.notifications.create(`lcfc-limit-${loader.runId || Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Run paused — usage limit reached",
        message: detail
          ? `The engine reported: "${detail}". Nothing was lost. Resume from the Campaigns tab once the limit clears.`
          : "The engine reported a usage limit. Nothing was lost. Resume from the Campaigns tab once it clears.",
      });
    }
  } catch (err) {
    // Blocked notifications are a legitimate user choice, not a bug — but if
    // someone reports "the alarm never fired", this is where the answer is.
    logErr("notifications.create", err);
  }
}

async function notifyRunComplete() {
  const total = loader.total;
  const done = loader.done;
  const errors = loader.errors;
  try {
    await chrome.action.setBadgeText({ text: `${done}/${total}` });
    await chrome.action.setBadgeBackgroundColor({ color: errors ? "#b91c1c" : "#16a34a" });
  } catch (_) {
    /* action.setBadgeText unavailable in some test/mock contexts */
  }
  try {
    if (chrome.notifications) {
      await chrome.notifications.create(`lcfc-run-${loader.runId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Campaign finished",
        message: `${done} of ${total} succeeded${errors ? `, ${errors} failed` : ""}.`,
      });
    }
  } catch (_) {
    /* notifications permission not yet granted on this build, or unavailable in test contexts */
  }
}

// Average completed-turn duration and remaining-time estimate for one
// platform, from its rolling window of real durations (populated in
// loaderOnCapture). null until at least one turn has completed — an ETA
// guessed from zero data would be worse than admitting it isn't known yet.
function turnEta(p) {
  // Delegates to lib/pacing.js, which adds the inter-prompt gap the recorded
  // durations exclude. Without it the estimate ran ~4.5s short PER remaining
  // prompt — three quarters of an hour of optimism across a 1000-prompt run,
  // on the one number whose job is telling the user when to come back.
  const e = legEta(p);
  return e ? { avgMs: e.avgTurnMs, remainingMs: e.remainingMs } : null;
}

// Diagnostic ring buffer (in-memory) for the Debug view.
const DEBUG = [];
function pushDebug(event) {
  DEBUG.push(event);
  if (DEBUG.length > 200) DEBUG.shift();
}

function loaderStatus() {
  // runId is included even in the idle/finished shape — the UI dedupes its
  // one-time badge-clearing ack per runId (see loaderAckedRunId in
  // panel.js), which needs it to tell "this finished run has already been
  // acknowledged" from "a *different* run just finished since".
  if (!loader.running) return { running: false, total: loader.total, done: loader.done, errors: loader.errors, runId: loader.runId };
  // Surfaced so the UI can say "interrupted — N left, Resume?" instead of a
  // run that merely looks paused for no stated reason after a restart.
  const interrupted = loader.interrupted || null;
  let totalTasks = 0;
  let totalIdx = 0;
  const platStats = {};
  const now = Date.now();
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    const legs = pd.legs || [];
    let done = 0, total = 0, failed = 0;
    const legStats = [];
    // Concatenated in original prompt order (legs are contiguous shards, so
    // this is just the shards back to back) — the per-prompt status list
    // needs to read the same regardless of how many tabs are working it.
    const prompts = [];
    let bestAvg = null, worstEta = null, etaKnownForPlat = true, anyRemaining = false;

    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      total += leg.prompts.length;
      done += leg.idx;
      failed += leg.failed || 0;
      const inFlight = leg.idx < leg.prompts.length;
      if (inFlight) anyRemaining = true;
      // CONCURRENCY: a leg with a non-empty shard is "inFlight" (has work
      // left) from the moment it's created — idx starts at 0 — but with
      // staggered starts (LEG_START_STAGGER_MS) it may not actually have
      // been kicked off yet. `leg.startedAt` is only ever set inside
      // loaderRunLeg, right before the tab is navigated, so it's the true
      // "has this leg's current turn actually begun" signal. Without this
      // distinction, status reporting showed tab 2's target prompt as
      // already "running" during the stagger window it hadn't started yet —
      // misleading, and it defeats the point of staggering being visible.
      const started = inFlight && !!leg.startedAt;
      const eta = turnEta(leg);
      if (inFlight && eta == null) etaKnownForPlat = false;
      if (eta) worstEta = Math.max(worstEta || 0, eta.remainingMs);
      if (eta) bestAvg = bestAvg == null ? eta.avgMs : (bestAvg + eta.avgMs) / 2;

      // Per-prompt status list — previously nothing tracked this at all, only
      // an aggregate done/total count and one truncated "current" string
      // that silently dropped every platform but the first with something
      // in flight. `outcomes[i]` is set the moment prompt i finishes
      // (success or failure, including during restart recovery — see
      // resumeFromSnapshot); anything before idx with no recorded outcome
      // falls back to "done" as a safe default rather than showing a hole.
      leg.prompts.forEach((text, i) => {
        const outcome = (leg.outcomes || [])[i];
        let status;
        if (outcome) status = outcome.status;
        else if (i === leg.idx && started) status = "running";
        else if (i < leg.idx) status = "done";
        else status = "pending";
        prompts.push({ text, status, reason: outcome ? outcome.reason : null, at: outcome ? outcome.at : null });
      });

      // One entry per tab, so with concurrency the UI can show "Tab 1:
      // prompt X (12s/45s)" and "Tab 2: prompt Y" instead of a single
      // "current" that only ever had room for one tab's work.
      legStats.push({
        tab: li + 1,
        current: started ? leg.prompts[leg.idx] : null,
        elapsedMs: started && leg.startedAt ? Math.min(now - leg.startedAt, turnBudgetMs(leg)) : null,
        turnTimeoutMs: turnBudgetMs(leg),
      });
    }

    totalTasks += total;
    totalIdx += done;
    platStats[plat] = {
      done, total, failed,
      legs: legStats,
      avgTurnMs: bestAvg != null ? Math.round(bestAvg) : null,
      etaMs: anyRemaining && etaKnownForPlat && worstEta != null ? Math.round(worstEta) : null,
      prompts,
      // True once this platform's legs were paused by loader-rate-limited —
      // scoped per platform (different engine, different account) rather
      // than reading the global loader.paused, which now only reflects a
      // user-initiated pause. Lets the UI show which engine is actually
      // sitting out a cooldown instead of implying the whole run stopped.
      paused: legs.length > 0 && legs.every((l) => l.paused),
    };
  }
  // Aggregate: true if the user paused the run OR any platform is sitting
  // out a rate limit — either way there's something for Resume to clear, so
  // this is what gates the Resume button and the "Paused" header, same as
  // before concurrency existed. Per-platform detail (which engine, whether
  // a sibling is still going) lives in platStats[plat].paused above.
  const anyPlatformPaused = Object.values(platStats).some((s) => s.paused);
  // Overall ETA: the run isn't done until the SLOWEST platform finishes (they
  // run in parallel), so it's the max across platforms that still have work
  // left — and honestly null, not a guess, if any of those hasn't completed
  // even one turn yet to estimate from.
  let etaMs = 0;
  let etaKnown = true;
  for (const s of Object.values(platStats)) {
    if (s.total - s.done <= 0) continue;
    if (s.etaMs == null) { etaKnown = false; break; }
    etaMs = Math.max(etaMs, s.etaMs);
  }
  return {
    running: loader.running,
    paused: loader.paused || anyPlatformPaused,
    total: totalTasks,
    done: loader.done,
    idx: totalIdx,
    errors: loader.errors,
    runId: loader.runId,
    etaMs: etaKnown ? etaMs : null,
    // An absolute clock time, not just a duration. "~2h 40m remaining" still
    // makes the user do arithmetic against a wall clock to answer the actual
    // question, which is when to come back. Computed here so every consumer
    // agrees on it, and null whenever the ETA is unknown rather than showing
    // a confidently wrong time.
    etaAt: etaKnown ? Date.now() + etaMs : null,
    interrupted,
    platStats,
  };
}

function clearWatchdog(p) {
  if (p && p.watchdog) {
    clearTimeout(p.watchdog);
    p.watchdog = null;
  }
}

// Runs the next prompt in ONE leg (one tab). With concurrency this is called
// once per tab, independently — each leg advances on its own schedule, only
// sharing the platform's overall done/failed totals via loaderStatus's
// aggregation, not any per-turn coordination with its sibling legs.
async function loaderRunLeg(plat, leg) {
  if (!loader.running || loader.paused) return;
  if (!leg) return;
  // Rate-limited: this leg's engine is deliberately sitting out a cooldown
  // while its sibling platform's legs (a different account) keep going.
  // loader-resume clears this and calls loaderRunLeg again explicitly.
  if (leg.paused) return;

  clearWatchdog(leg);

  if (leg.idx >= leg.prompts.length) {
    const allDone = Object.values(loader.platforms)
      .every((pd) => pd.legs.every((l) => l.idx >= l.prompts.length));
    if (allDone) {
      loader.running = false;
      syncGeoRun("done");
      notifyRunComplete();
    }
    await persistLoaderState();
    return;
  }

  const prompt = leg.prompts[leg.idx];
  const q = encodeURIComponent(prompt);
  // A one-time token proves to the content script that THIS navigation came from
  // the Loader — so a crafted ?lcfc=1&q=… link can't make ChatGPT run a prompt.
  leg.token = crypto.randomUUID();
  leg.expectedPrompt = prompt;
  leg.startedAt = Date.now();
  await persistLoaderState();

  const search = plat === "chatgpt" && loader.options.forceSearch ? "&lcfcsearch=1" : "";
  let base = "https://chatgpt.com/";
  if (plat === "gemini") base = "https://gemini.google.com/app";
  else if (plat === "perplexity") base = "https://www.perplexity.ai/";
  else if (plat === "grok") base = "https://grok.com/";
  else if (plat === "claude") base = "https://claude.ai/new";
  const url = `${base}?q=${q}&lcfc=1&lcfctok=${leg.token}${search}`;

  try {
    await chrome.tabs.update(leg.tabId, { url });
  } catch (_) {
    // Tab was closed — fail this prompt and move on rather than hanging.
    failTurnAndAdvance(plat, leg, "tab closed", 500);
    return;
  }

  // Watchdog: if no signal-bearing capture arrives in time, record a failure and
  // continue. Without this a rate-limited or errored turn stalls the whole run.
  armWatchdog(plat, leg, turnBudgetMs(leg));
}

async function loaderStart(prompts, options) {
  // Guard against a second run stomping the first: `loader` is one shared
  // in-memory object, so without this a double-click on "Start run" (or any
  // other overlapping loader-start/geo-run-start call while one is already
  // active) would silently discard the first run's in-flight state via the
  // `loader = newLoaderState()` reset below — orphaning its tabs/watchdogs
  // while a second run starts fresh on top of it. This is one concrete way
  // "2 prompts run together" could happen: not just a service-worker
  // restart race (Phase 1), but two starts landing in the same live worker.
  if (loader.running) {
    return { ok: false, error: "A run is already in progress. Wait for it to finish, or stop it, before starting another." };
  }
  const clean = (prompts || []).map((p) => String(p).trim()).filter(Boolean);
  if (!clean.length) return { ok: false, error: "No prompts provided." };

  const platforms = (options && options.platforms) || ["chatgpt"];
  const supported = platforms.filter((p) => ["chatgpt", "gemini", "perplexity", "grok", "claude"].includes(p));
  if (!supported.length) return { ok: false, error: "Select at least one supported AI engine." };

  loader = newLoaderState();
  loader.running = true;
  loader.options = options || {};
  loader.total = clean.length * supported.length;
  loader.runId = crypto.randomUUID();
  // Clear any badge left over from a previous run's completion so it never
  // reads as this run's status by mistake.
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch (_) {}

  let windowId;
  if (options && options.incognito) {
    const allowed = await new Promise((res) => chrome.extension.isAllowedIncognitoAccess(res));
    if (!allowed) {
      loader.running = false;
      return { ok: false, error: "Enable 'Allow in Incognito' for this extension at chrome://extensions first." };
    }
    try {
      const win = await chrome.windows.create({ incognito: true });
      windowId = win.id;
    } catch (_) {
      loader.running = false;
      return { ok: false, error: "Failed to create Incognito window." };
    }
  }

  // Record the run so the Compare view can diff it later.
  await db.put("runs", {
    id: loader.runId,
    projectId: (options && options.projectId) || null,
    startedAt: Date.now(),
    platforms: supported,
    promptCount: clean.length,
  });

  // CONCURRENCY: split each platform's prompt list into
  // CONCURRENT_TABS_PER_ENGINE contiguous shards (src/lib/pacing.js), one
  // tab per shard, instead of one tab handling the whole list in sequence.
  // A shard can come back empty (more concurrency than prompts — e.g. 2 tabs
  // requested for 1 prompt), and an empty shard gets no tab at all: opening
  // a second automated tab with nothing to do would be pure extra footprint
  // on the account for zero benefit.
  for (const plat of supported) {
    const shards = shardPrompts(clean, CONCURRENT_TABS_PER_ENGINE).filter((s) => s.prompts.length > 0);
    const legs = [];
    for (const shard of shards) {
      const created = windowId
        ? await chrome.tabs.create({ windowId, url: "about:blank" })
        : await chrome.tabs.create({ url: "about:blank", active: false });
      legs.push({
        tabId: created.id, startOffset: shard.startOffset, prompts: shard.prompts,
        idx: 0, failed: 0, lastAdvanceAt: 0, durations: [], outcomes: [],
      });
    }
    loader.platforms[plat] = { legs };
  }
  await persistLoaderState();
  // Staggered rather than all at once: the first submission across tabs
  // landing in the exact same instant is a much stronger automation signal
  // than the same volume spread a couple of seconds apart (see pacing.js).
  // Every turn after this first one is already paced by the normal
  // inter-prompt gap, so the stagger only ever matters once, here.
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    pd.legs.forEach((leg, i) => {
      const delay = i * LEG_START_STAGGER_MS + Math.random() * 1000;
      if (delay > 0) setTimeout(() => loaderRunLeg(plat, leg), delay);
      else loaderRunLeg(plat, leg);
    });
  }

  return { ok: true, total: loader.total, runId: loader.runId };
}

/*
 * Start a GEO tracking run for one profile.
 *
 * This deliberately REUSES the Loader rather than building a second automation
 * path: the Loader already has the pieces that took real debugging to get
 * right — the hasSignal advance guard (so a race-loser capture doesn't skip a
 * prompt), the per-turn watchdog, human-paced jitter, and pause/resume. A
 * parallel implementation would re-earn all of those bugs.
 *
 * The only addition is provenance: `options.geo` + `options.geoPrompts` (index-
 * aligned with the prompt list) so each capture is stamped with the profile,
 * run, prompt and tags it belongs to.
 */
async function geoRunStart(profileId) {
  const profile = await db.get("profiles", profileId);
  if (!profile) return { ok: false, error: "Profile not found." };
  if (!profile.brand || !profile.brand.name) {
    return { ok: false, error: "Set your brand name on this profile before running." };
  }

  const all = await db.getAll("trackedPrompts");
  const prompts = all
    .filter((p) => p.profileId === profileId && p.active !== false)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!prompts.length) return { ok: false, error: "Add at least one tracked prompt first." };

  const engines = (profile.engines || []).filter((e) => ["chatgpt", "gemini", "perplexity", "grok", "claude"].includes(e));
  if (!engines.length) return { ok: false, error: "Select at least one engine with an active adapter." };

  const vol = runVolume(prompts, engines);
  const geoRunId = crypto.randomUUID();

  const res = await loaderStart(
    prompts.map((p) => p.text),
    {
      platforms: engines,
      geo: { profileId, runId: geoRunId },
      geoPrompts: prompts.map((p) => ({ id: p.id, tags: p.tags || [] })),
    }
  );
  if (!res.ok) return res;

  await db.put("geoRuns", makeGeoRun({
    id: geoRunId,
    profileId,
    engines,
    promptIds: prompts.map((p) => p.id),
    expected: vol.submissions,
    status: "running",
  }));
  // Stamp the cadence clock now rather than on completion: the "run due today"
  // reminder should not keep nagging through a run that is already in flight.
  await db.put("profiles", { ...profile, lastRunAt: Date.now() });

  return { ok: true, geoRunId, ...vol, loaderRunId: res.runId };
}

// Finds the (platform, leg) that owns a given tab, across every platform and
// every concurrent leg within it. The single seam every tabId-keyed message
// handler goes through, so "which leg is this" is answered the same way
// everywhere rather than each handler re-implementing the nested search.
function legForTab(tabId) {
  if (tabId == null) return null;
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    for (const leg of pd.legs || []) {
      if (leg.tabId === tabId) return { plat, leg };
    }
  }
  return null;
}

// The whole platform's prompt count — every leg's shard summed — as opposed
// to leg.prompts.length, which is just ONE tab's shard. Reported alongside
// promptIndex (leg.startOffset + leg.idx, already campaign-wide via
// startOffset) in the error log: pairing a campaign-wide index with a
// per-shard total read as nonsensical ("promptIndex=23, totalPrompts=374"
// when the platform's real total across both legs was 747) once concurrency
// could split one platform across more than one leg.
function platformTotal(plat) {
  return (loader.platforms[plat]?.legs || []).reduce((n, l) => n + l.prompts.length, 0);
}

// Called after each capture; advances the loader only for a real, completed turn.
function loaderOnCapture(tabId, record) {
  if (!loader.running) return;
  const found = legForTab(tabId);
  if (!found) return;
  const { plat, leg } = found;

  // Ignore empty race-loser captures — advancing on those silently SKIPS prompts.
  if (!hasSignal(record)) return;
  // Ignore a second completion arriving immediately after one we already counted.
  if (leg.lastAdvanceAt && Date.now() - leg.lastAdvanceAt < MIN_ADVANCE_GAP_MS) return;

  /* The capture must be for the prompt this leg is actually waiting on.
   *
   * Without this, a capture that arrives LATE — after its own turn already
   * timed out and the run moved on — is counted against whatever prompt is
   * now in flight. That does two bad things at once: it inflates the run's
   * captured count (the diagnostic report showed "14/12 captured" and
   * "11/12 captured, 7 failed", both arithmetically impossible for a
   * 12-task run), and it advances `idx` past a prompt that was never
   * actually asked. The second is the serious one — it is a silently
   * SKIPPED prompt, which is precisely the "prompts missing from the
   * results" complaint, and it is invisible because the run reports it as a
   * success.
   *
   * ChatGPT is where this bites: a turn that times out at 90s often does
   * finish streaming afterwards, so the late capture lands while the next
   * prompt is mid-flight.
   *
   * Loose comparison, and only when both sides are known: adapters
   * normalise whitespace differently from the string we navigated with, and
   * an older persisted snapshot may carry no expectedPrompt at all. When
   * either side is missing the old behaviour stands, so this can only ever
   * reject a capture it is certain does not belong.
   */
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const wantPrompt = norm(leg.expectedPrompt);
  const gotPrompt = norm(record && record.userPrompt);
  if (wantPrompt && gotPrompt) {
    const head = wantPrompt.slice(0, 60);
    if (!gotPrompt.includes(head) && !wantPrompt.includes(gotPrompt.slice(0, 60))) {
      logErr(`run:late-capture:${plat}`, "capture did not match the prompt in flight", {
        platform: plat,
        promptIndex: (leg.startOffset || 0) + leg.idx,
        totalPrompts: platformTotal(plat),
      });
      return;
    }
  }

  clearWatchdog(leg);
  if (leg.startedAt) leg.durations = [...(leg.durations || []), Date.now() - leg.startedAt].slice(-DURATION_WINDOW);
  leg.outcomes = leg.outcomes || [];
  leg.outcomes[leg.idx] = { status: "done", reason: null, at: Date.now() };
  leg.lastAdvanceAt = Date.now();
  loader.done++;
  leg.idx++;
  // Persisted synchronously, before scheduling the next turn — this is the
  // step that closes the restart-duplicate window: if the worker dies
  // between here and the next capture, a resume will see this completion
  // already reflected in storage rather than reconciling against a
  // count that doesn't yet include it (which would resubmit this prompt).
  persistLoaderState();
  syncGeoRun();
  // Same constants the ETA is computed from (lib/pacing.js), so the pace the
  // run actually keeps and the pace it predicts can never drift apart. Each
  // leg paces itself independently — concurrency divides wall-clock time by
  // running more of these gaps in parallel, not by making any one of them
  // shorter (see pacing.js's header comment).
  const delay = INTER_PROMPT_MIN_MS + Math.random() * (INTER_PROMPT_MAX_MS - INTER_PROMPT_MIN_MS);
  if (!loader.paused && !leg.paused) setTimeout(() => loaderRunLeg(plat, leg), delay);
}

// Strip heavy fields for list/aggregate views. The full record (with answerText)
// is fetched per capture by `get-record` when Analyze opens it.
function toLight(r) {
  const { answerText, platformSpecific, ...rest } = r;
  const ps = platformSpecific || {};
  const { reasoning, ...psLight } = ps;
  return { ...rest, platformSpecific: psLight, hasAnswerText: !!(answerText && answerText.length) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "raw-conversation": {
          const tabId = sender?.tab?.id;
          let meta = null;
          if (loader.running) {
            const found = legForTab(tabId);
            if (found) {
              const { leg } = found;
              meta = { projectId: loader.options.projectId || null, runId: loader.runId };
              // A GEO tracking run stamps per-prompt provenance so the metrics
              // engine can attribute each response to the right tracked prompt
              // and its tags. loader.options.geoPrompts is index-aligned with
              // the ORIGINAL, pre-sharding prompt list — leg.idx is local to
              // this leg's own shard, so it has to be added to the shard's
              // startOffset to land on the right entry. Getting this wrong
              // doesn't fail loudly: it silently attributes the capture to
              // the WRONG tracked prompt, corrupting that prompt's mention
              // rate and this one's alike.
              const g = loader.options.geo;
              if (g) {
                const originalIdx = (leg.startOffset || 0) + leg.idx;
                const tp = (loader.options.geoPrompts || [])[originalIdx] || {};
                meta.geo = {
                  profileId: g.profileId,
                  runId: g.runId,
                  promptId: tp.id || null,
                  tags: tp.tags || [],
                };
              }
            }
          }
          const res = await storeCapture(msg.payload, meta);
          if (res && res.captureId) {
            loaderOnCapture(tabId, res.record);
            // Notify the popup if it's open. Use a callback so a missing receiver
            // doesn't surface as an unhandled promise rejection.
            try {
              chrome.runtime.sendMessage({ type: "new-capture", captureId: res.captureId }, () => void chrome.runtime.lastError);
            } catch (_) {}
            // Deliberately NOT awaited: the capture is already saved and shown.
            enrichCaptureWithAI(res.record);
          }
          sendResponse({ ok: true, captureId: res?.captureId || null, skipped: res?.skipped || null });
          break;
        }

        // Content script asks whether this ?lcfc=1 navigation is a genuine Loader
        // run for this tab. Without this, any link could auto-submit a prompt.
        case "loader-verify": {
          let ok = false;
          const tabId = sender?.tab?.id;
          if (loader.running && tabId != null) {
            const found = legForTab(tabId);
            ok = !!(found && found.leg.token && found.leg.token === msg.token);
          }
          sendResponse({ ok });
          break;
        }

        // The content script saw an upstream limit ("you've reached your
        // limit", "too many requests"…). Independent platform cooldown: pause
        // the rate-limited engine legs and arm an auto-resume timer, while
        // allowing any other active engine to continue running uninterrupted.
        case "loader-rate-limited": {
          const tabId = sender?.tab?.id;
          let matched = null;
          if (loader.running && tabId != null) {
            const found = legForTab(tabId);
            if (found && found.leg.token && found.leg.token === msg.token) matched = found.plat;
          }
          if (matched) {
            const p = loader.platforms[matched];
            const cooldownMs = parseCooldownFromNotice(msg.detail);
            const resumeAt = Date.now() + cooldownMs;
            p.rateLimitedUntil = resumeAt;
            p.cooldownReason = typeof msg.detail === "string" ? msg.detail.slice(0, 160) : "rate limit";

            for (const leg of p.legs || []) {
              clearWatchdog(leg);
              leg.paused = true;
            }

            // Arm an auto-resume timer for this specific platform
            if (p.cooldownTimer) clearTimeout(p.cooldownTimer);
            p.cooldownTimer = setTimeout(() => {
              p.rateLimitedUntil = null;
              p.cooldownTimer = null;
              if (loader.running) {
                for (const leg of p.legs || []) {
                  leg.paused = false;
                }
                logErr(`run:auto-resume:${matched}`, "Cooldown expired, auto-resuming platform queue", { platform: matched });
                (p.legs || []).forEach((l) => loaderAdvanceLeg(p, l));
                persistLoaderState();
                syncGeoRun();
              }
            }, cooldownMs);

            loader.interrupted = {
              at: Date.now(),
              reason: "rate limit",
              platform: matched,
              detail: p.cooldownReason,
              autoResumeAt: resumeAt,
            };

            await persistLoaderState();
            syncGeoRun(undefined, `cooldown: ${matched} (${formatCooldown(cooldownMs)})`);
            notifyRateLimited(`${matched}: ${p.cooldownReason} (Auto-resuming in ${formatCooldown(cooldownMs)})`);
          }
          sendResponse({ ok: !!matched });
          break;
        }

        // The content script tried to type and submit this turn's prompt and
        // couldn't (composer never mounted, or the send control never accepted
        // it). Previously it just stopped trying and said nothing, so the run
        // sat idle until the 90s per-turn watchdog fired — ten prompts meant a
        // quarter of an hour of a run that looked hung. Fail the turn now and
        // move to the next prompt. Token-and-tab checked exactly as
        // loader-verify does, so an arbitrary page can't derail a run.
        case "loader-submit-failed": {
          const tabId = sender?.tab?.id;
          let found = null;
          if (loader.running && tabId != null) {
            const f = legForTab(tabId);
            if (f && f.leg.token && f.leg.token === msg.token) found = f;
          }
          if (found) {
            const why = typeof msg.reason === "string" && msg.reason ? msg.reason : "submit failed";
            const trace = typeof msg.trace === "string" ? msg.trace : "";
            failTurnAndAdvance(found.plat, found.leg, `submit: ${why}`.slice(0, 120), 800, trace);
          }
          sendResponse({ ok: !!found });
          break;
        }

        case "settings-get":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "settings-set":
          sendResponse({ ok: true, settings: await setSettings(msg.patch) });
          break;

        case "project-save": {
          const id = msg.id || crypto.randomUUID();
          const existing = msg.id ? await db.get("projects", msg.id) : null;
          await db.put("projects", {
            id,
            name: msg.name || "Untitled",
            prompts: msg.prompts || [],
            createdAt: existing ? existing.createdAt : Date.now(),
            updatedAt: Date.now(),
          });
          sendResponse({ ok: true, id });
          break;
        }
        case "project-list": {
          const projects = await db.getAll("projects");
          projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          sendResponse({ ok: true, projects });
          break;
        }
        case "project-delete":
          await db.delete("projects", msg.id);
          sendResponse({ ok: true });
          break;

        /* ---------- GEO brand tracking ---------- */
        case "geo-profile-list": {
          // Lazy sweep: anything soft-deleted past the retention window gets
          // purged for real right here, so there's no need for a background
          // alarm just to expire trash. Runs on every list call, which is
          // cheap at MAX_PROFILES-scale data.
          const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400000;
          const all = await db.getAll("profiles");
          for (const p of all) {
            if (p.deletedAt && p.deletedAt < cutoff) {
              const prompts = await db.getAll("trackedPrompts");
              for (const pr of prompts) if (pr.profileId === p.id) await db.delete("trackedPrompts", pr.id);
              await db.delete("profiles", p.id);
            }
          }
          const profiles = (await db.getAll("profiles")).filter((p) => msg.includeDeleted || !p.deletedAt);
          profiles.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          sendResponse({ ok: true, profiles });
          break;
        }
        case "geo-profile-save": {
          const all = await db.getAll("profiles");
          const existing = msg.profile?.id ? all.find((p) => p.id === msg.profile.id) : null;
          // Cap enforced in the service worker, not just the UI — the UI is not
          // a security or integrity boundary and a stale popup could resubmit.
          // Soft-deleted profiles don't count against the live cap.
          if (!existing && all.filter((p) => !p.deletedAt).length >= MAX_PROFILES) {
            sendResponse({ ok: false, error: `You can track at most ${MAX_PROFILES} brand profiles.` });
            break;
          }
          if (existing && existing.locked && !msg.unlockOverride) {
            sendResponse({ ok: false, error: "This profile is locked. Unlock it before editing." });
            break;
          }
          const profile = makeProfile({ ...(existing || {}), ...msg.profile });
          await db.put("profiles", profile);
          sendResponse({ ok: true, profile });
          break;
        }
        // Soft delete: recoverable for TRASH_RETENTION_DAYS (see the sweep in
        // geo-profile-list above). Prompts and captures are left alone either
        // way — deleting a profile has never deleted its data, only detached it.
        // Excluding an inferred competitor is not editing the campaign's
        // measurement definition, so unlike geo-profile-save it is allowed on
        // a locked profile: the locked definition is "own brand + configured
        // competitors", and an inferred brand was never part of it. It only
        // ever touches excludedBrands.
        case "geo-brand-exclude": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const name = String(msg.name || "").trim();
          if (!name) { sendResponse({ ok: false, error: "No brand given." }); break; }
          const current = profile.excludedBrands || [];
          const key = normName(name);
          const next = msg.restore
            ? current.filter((n) => normName(n) !== key)
            : (current.some((n) => normName(n) === key) ? current : current.concat(name));
          const saved = makeProfile({ ...profile, excludedBrands: next });
          await db.put("profiles", saved);
          sendResponse({ ok: true, profile: saved });
          break;
        }

        case "geo-profile-trash": {
          const profile = await db.get("profiles", msg.id);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          await db.put("profiles", { ...profile, deletedAt: Date.now() });
          sendResponse({ ok: true });
          break;
        }
        case "geo-profile-restore": {
          const profile = await db.get("profiles", msg.id);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const live = (await db.getAll("profiles")).filter((p) => !p.deletedAt && p.id !== msg.id);
          if (live.length >= MAX_PROFILES) {
            sendResponse({ ok: false, error: `You can track at most ${MAX_PROFILES} brand profiles — trash or delete one first.` });
            break;
          }
          await db.put("profiles", { ...profile, deletedAt: null });
          sendResponse({ ok: true });
          break;
        }
        case "geo-profile-delete": {
          // Immediate, permanent delete — used for "delete forever" from the
          // trash. Prompts go with it; captures are LEFT ALONE deliberately —
          // real captured data the user may still want.
          const prompts = await db.getAll("trackedPrompts");
          for (const p of prompts) if (p.profileId === msg.id) await db.delete("trackedPrompts", p.id);
          await db.delete("profiles", msg.id);
          sendResponse({ ok: true });
          break;
        }

        case "geo-prompt-list": {
          const prompts = await db.getAll("trackedPrompts");
          const scoped = msg.profileId ? prompts.filter((p) => p.profileId === msg.profileId) : prompts;
          scoped.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          sendResponse({ ok: true, prompts: scoped });
          break;
        }
        case "geo-prompt-save": {
          const existing = msg.prompt?.id ? await db.get("trackedPrompts", msg.prompt.id) : null;
          const prompt = makeTrackedPrompt({ ...(existing || {}), ...msg.prompt });
          if (!prompt.text) { sendResponse({ ok: false, error: "Prompt text is required." }); break; }
          await db.put("trackedPrompts", prompt);
          sendResponse({ ok: true, prompt });
          break;
        }
        case "geo-prompt-bulk-add-rows": {
          // One prompt per row with its OWN tags — used by both the CSV/XLSX
          // import path and manual entry (each line parsed client-side into
          // {text, tags}). Duplicate prompt text (case/whitespace-insensitive)
          // is skipped rather than added twice — both against what's already
          // tracked on this profile AND within the same batch — and reported
          // back so the UI can tell the user what got skipped and why.
          const rows = Array.isArray(msg.rows) ? msg.rows : [];
          const existingPrompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId);
          const seen = new Set(existingPrompts.map((p) => normPromptText(p.text)));
          const added = [];
          const duplicates = [];
          // A bulk import (CSV/XLSX, or a multi-line paste) puts() every row
          // in one tight loop — fast enough on a real IndexedDB that many
          // rows land in the SAME millisecond. Every place that orders
          // prompts (this list, geo-prompt-list, and geoRunStart's campaign
          // run order) sorts by createdAt, and db.getAll()'s underlying
          // order is the primary key (a random UUID), not insertion order —
          // so a tied createdAt silently falls back to that random order
          // instead of the order the user pasted/imported. A campaign then
          // runs its prompts in a different order than entered, and
          // "prompt 3" in a report doesn't match the user's own third
          // prompt. Stamping a strictly increasing createdAt within this
          // batch (real time plus the row's position) costs nothing and
          // guarantees the batch always sorts back into paste/import order.
          const batchAt = Date.now();
          let seq = 0;
          for (const row of rows) {
            const text = String(row?.text || "").trim();
            if (!text) continue;
            const key = normPromptText(text);
            if (seen.has(key)) { duplicates.push(text); continue; }
            seen.add(key);
            const p = makeTrackedPrompt({ profileId: msg.profileId, text, tags: row.tags || [], createdAt: batchAt + seq++ });
            await db.put("trackedPrompts", p);
            added.push(p);
          }
          sendResponse({ ok: true, added: added.length, duplicates });
          break;
        }
        case "geo-prompt-delete":
          await db.delete("trackedPrompts", msg.id);
          sendResponse({ ok: true });
          break;
        case "geo-tag-delete": {
          // Removes the tag from every prompt that carries it — the prompts
          // themselves are untouched. Distinct from deleting prompts by tag.
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId);
          let changed = 0;
          for (const p of prompts) {
            if (!(p.tags || []).includes(msg.tag)) continue;
            await db.put("trackedPrompts", { ...p, tags: p.tags.filter((t) => t !== msg.tag) });
            changed++;
          }
          sendResponse({ ok: true, changed });
          break;
        }
        case "geo-tag-rename": {
          const newTag = String(msg.newTag || "").trim();
          if (!newTag) { sendResponse({ ok: false, error: "New tag name can't be empty." }); break; }
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId);
          let changed = 0;
          for (const p of prompts) {
            if (!(p.tags || []).includes(msg.oldTag)) continue;
            const tags = [...new Set(p.tags.map((t) => (t === msg.oldTag ? newTag : t)))];
            await db.put("trackedPrompts", { ...p, tags });
            changed++;
          }
          sendResponse({ ok: true, changed });
          break;
        }

        /* The whole campaign as one workbook.
         *
         * Assembled and rendered HERE rather than in the panel: the raw
         * material is every derived record for the campaign, which for a
         * thousand-prompt run is tens of megabytes of sources and mentions.
         * Shipping that across the message boundary so the UI could format it
         * would be slow and pointless — the worker already has the database
         * open. One XML string goes back instead.
         */
        case "geo-export-workbook": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const records = selectTracked(all, {
            profileId: msg.profileId,
            runId: msg.runId || undefined,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });
          const prompts = (await db.getAll("trackedPrompts")).filter((t) => t.profileId === msg.profileId);
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId);
          const brands = effectiveTrackedBrands(profile, records);
          const metrics = computeMetrics(records, profile, brands);
          // answerText is the single biggest field on a record and no sheet
          // uses it, so it is dropped before aggregation rather than carried
          // through and ignored.
          const lite = records.map(({ answerText, platformSpecific, _extraction, ...rest }) => rest);
          const xml = buildCampaignWorkbook({
            profile, prompts, runs, records: lite, brands, metrics,
            errors: await errorLog.summary(60),
            generatedAt: Date.now(),
          });
          const slug = String(profile.name || "campaign").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
          sendResponse({ ok: true, xml, filename: `citoskeleton-${slug || "campaign"}-${Date.now()}.xls` });
          break;
        }

        case "geo-run-list": {
          const runs = await db.getAll("geoRuns");
          const scoped = msg.profileId ? runs.filter((r) => r.profileId === msg.profileId) : runs;
          scoped.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
          sendResponse({ ok: true, runs: scoped });
          break;
        }
        case "geo-run-start": {
          sendResponse(await geoRunStart(msg.profileId));
          break;
        }
        case "geo-metrics": {
          // Computed HERE, not in the panel, because Position needs the full
          // answerText to rank brands by first appearance — and `get-records`
          // deliberately strips answerText to keep the popup fast. Computing
          // this UI-side would have silently produced null/─ positions for
          // every brand. Only the small aggregate crosses the message boundary.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Profile not found." }); break; }
          const all = await db.getAll("derived");
          const scoped = selectTracked(all, {
            profileId: msg.profileId,
            // Scope to ONE run when asked. Reported: "if I run the same
            // campaign multiple times and want to open one, how?" The
            // all-runs aggregate is the right default, but it averages a run
            // that went badly together with ones that went well, and there
            // was no way to look at a single run at all. selectTracked has
            // always filtered on runId — nothing ever passed one.
            runId: msg.runId || undefined,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });
          // Same shape of aggregate the ad-hoc Dashboard shows (captures /
          // with-search / fan-out queries / unique domains / cited / fetched),
          // but over THIS campaign's tracked responses — lets the Dashboard
          // merge "Performance Overview" and campaign KPIs into one section
          // once a campaign is selected, instead of two disconnected cards.
          let fanTotal = 0, searched = 0, citedTotal = 0, fetchedTotal = 0;
          const domainSet = new Set();
          for (const r of scoped) {
            if (r.searched) searched++;
            for (const b of ["search", "shopping", "image"]) fanTotal += (r.fanout?.[b] || []).length;
            for (const s of r.sources || []) {
              if (s.outcome === "cited") citedTotal++;
              else if (s.outcome === "fetched") fetchedTotal++;
              if (s.domain) domainSet.add(s.domain);
            }
          }
          // With no competitors configured, every brand-facing number here
          // would be the own brand talking to itself. Fall back to the brands
          // the answers themselves name, flagged `auto` so the UI can say so.
          const brands = effectiveTrackedBrands(profile, scoped);
          // The same metrics per engine, over the same brand set. "We're
          // strong on ChatGPT and invisible on Gemini" is one of the few
          // findings that changes what you'd actually do about it, and the
          // profile-wide average hides it completely. Computed with the
          // campaign-wide brand set so the columns stay comparable — resolved
          // per engine, a brand could exist in one column and not the other.
          const byEngine = {};
          for (const id of new Set(scoped.map((r) => r.platform).filter(Boolean))) {
            const only = scoped.filter((r) => r.platform === id);
            byEngine[id] = { responses: only.length, metrics: computeMetrics(only, profile, brands) };
          }
          sendResponse({
            ok: true,
            metrics: computeMetrics(scoped, profile, brands),
            series: computeSeries(scoped, profile, msg.bucket || "day", brands),
            byEngine,
            responses: scoped.length,
            autoCompetitors: brands.filter((b) => b.auto).map((b) => b.name),
            excludedBrands: profile.excludedBrands || [],
            overview: { captures: scoped.length, searched, fanTotal, domainCount: domainSet.size, citedTotal, fetchedTotal },
          });
          break;
        }

        case "geo-prompt-performance": {
          // Per-response detail grouped by prompt (not just the profile-wide
          // aggregate geo-metrics returns): for each run of each tracked
          // prompt, was the FOCUS brand mentioned (and at what rank among
          // tracked brands), was its domain cited, plus that run's sources —
          // so the Dashboard can show a per-prompt performance table instead
          // of a generic ad-hoc conversation list, without shipping full
          // answerText across the message boundary.
          //
          // `msg.focusBrand` (a brand NAME, matched loosely via normName)
          // picks which tracked brand this is computed for. Omitted/unmatched
          // falls back to the campaign's own brand — every existing caller
          // that doesn't pass it keeps getting exactly what it got before.
          // This is what lets the UI answer "how is MY brand doing" and
          // "how is this COMPETITOR doing" through the same endpoint, so a
          // competitor's row in the Campaign Performance table can open the
          // same kind of per-prompt breakdown the campaign's own brand gets.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const scoped = selectTracked(all, {
            profileId: msg.profileId,
            // Scope to ONE run when asked. Reported: "if I run the same
            // campaign multiple times and want to open one, how?" The
            // all-runs aggregate is the right default, but it averages a run
            // that went badly together with ones that went well, and there
            // was no way to look at a single run at all. selectTracked has
            // always filtered on runId — nothing ever passed one.
            runId: msg.runId || undefined,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });
          const brands = effectiveTrackedBrands(profile, scoped);
          const focusKey = msg.focusBrand ? normName(msg.focusBrand) : null;
          const focus = focusKey ? brands.find((b) => normName(b.name) === focusKey) : brands.find((b) => b.isOwn);

          const byPrompt = new Map();
          for (const rec of scoped) {
            const promptId = rec.geo && rec.geo.promptId;
            if (!promptId) continue;
            let mentioned = false, position = null, cited = false;
            if (focus) {
              const pres = brandPresence(rec, brands);
              const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
              const focusPres = pres.find((p) => normName(p.name) === normName(focus.name));
              if (focusPres) {
                mentioned = focusPres.present;
                cited = focusPres.citedSource;
                const rankIdx = ranked.findIndex((p) => normName(p.name) === normName(focus.name));
                position = rankIdx >= 0 ? rankIdx + 1 : null;
              }
            }
            const run = {
              captureId: rec.captureId,
              capturedAt: rec.capturedAt,
              platform: rec.platform,
              mentioned, position, cited,
              sources: (rec.sources || []).map((s) => ({ domain: s.domain, url: s.url, outcome: s.outcome })),
            };
            if (!byPrompt.has(promptId)) byPrompt.set(promptId, []);
            byPrompt.get(promptId).push(run);
          }
          for (const runs of byPrompt.values()) runs.sort((a, b) => b.capturedAt - a.capturedAt);

          sendResponse({
            ok: true,
            hasBrand: !!focus,
            focusBrand: focus ? focus.name : null,
            focusIsOwn: !!focus?.isOwn,
            prompts: Object.fromEntries(byPrompt),
          });
          break;
        }

        case "geo-brand-detail": {
          // Everything about ONE brand, own or competitor, in a single round
          // trip: its own metrics, the same metrics per engine, a per-response
          // head-to-head against the campaign's own brand, the sources cited
          // in the answers that name it, and its per-prompt results.
          //
          // Assembled here rather than in the panel because all of it needs
          // answerText — brandPresence ranks by where a name first appears in
          // the prose — and `get-records` strips answerText to keep the popup
          // fast. Computing it UI-side produced null positions for everything.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const scoped = selectTracked(all, {
            profileId: msg.profileId,
            // Scope to ONE run when asked. Reported: "if I run the same
            // campaign multiple times and want to open one, how?" The
            // all-runs aggregate is the right default, but it averages a run
            // that went badly together with ones that went well, and there
            // was no way to look at a single run at all. selectTracked has
            // always filtered on runId — nothing ever passed one.
            runId: msg.runId || undefined,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });

          const brands = effectiveTrackedBrands(profile, scoped);
          const key = normName(msg.brand);
          const brand = brands.find((b) => normName(b.name) === key);
          if (!brand) { sendResponse({ ok: false, error: "That brand isn't tracked on this campaign." }); break; }
          const ownBrand = brands.find((b) => b.isOwn);

          const rowFor = (recs) => {
            const m = computeMetrics(recs, profile, brands);
            return m.brands.find((b) => normName(b.name) === key) || null;
          };

          const byEngine = {};
          for (const id of new Set(scoped.map((r) => r.platform).filter(Boolean))) {
            const only = scoped.filter((r) => r.platform === id);
            byEngine[id] = { responses: only.length, row: rowFor(only) };
          }

          // Per prompt, so the drill-down can show WHERE this brand wins and
          // loses rather than only how often.
          const promptsAll = await db.getAll("trackedPrompts");
          const promptById = new Map(promptsAll.map((p) => [p.id, p]));
          const byPrompt = new Map();
          for (const rec of scoped) {
            const promptId = rec.geo && rec.geo.promptId;
            if (!promptId) continue;
            const pres = brandPresence(rec, brands);
            const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
            const mine = pres.find((p) => p.key === key);
            const theirs = ownBrand ? pres.find((p) => p.isOwn) : null;
            const rankIdx = ranked.findIndex((p) => p.key === key);
            const ownRankIdx = ranked.findIndex((p) => p.isOwn);
            if (!byPrompt.has(promptId)) {
              const p = promptById.get(promptId);
              byPrompt.set(promptId, {
                promptId,
                promptText: p ? p.text : "(prompt no longer tracked)",
                tags: p ? p.tags || [] : [],
                runs: [],
              });
            }
            byPrompt.get(promptId).runs.push({
              captureId: rec.captureId,
              capturedAt: rec.capturedAt,
              platform: rec.platform,
              present: !!mine?.present,
              position: rankIdx >= 0 ? rankIdx + 1 : null,
              mentions: mine?.mentions || 0,
              cited: !!mine?.citedSource,
              // The own brand's result on the same response, so a row reads as
              // a comparison instead of an isolated fact.
              ownPresent: theirs ? !!theirs.present : null,
              ownPosition: ownRankIdx >= 0 ? ownRankIdx + 1 : null,
            });
          }
          const prompts = [...byPrompt.values()];
          for (const p of prompts) p.runs.sort((a, b) => b.capturedAt - a.capturedAt);
          prompts.sort((a, b) => {
            // Prompts where this brand appears and the own brand does not come
            // first: that is the list the reader is here for.
            const gap = (x) => x.runs.some((run) => run.present && run.ownPresent === false);
            return (gap(b) ? 1 : 0) - (gap(a) ? 1 : 0)
              || a.promptText.localeCompare(b.promptText);
          });

          sendResponse({
            ok: true,
            brand: brand.name,
            isOwn: !!brand.isOwn,
            auto: !!brand.auto,
            ownBrand: ownBrand ? ownBrand.name : "",
            responses: scoped.length,
            row: rowFor(scoped),
            byEngine,
            headToHead: ownBrand && !brand.isOwn
              ? headToHead(scoped, brands, brand.name, ownBrand.name)
              : null,
            sourceDomains: brandSourceDomains(scoped, brands, brand.name),
            prompts,
          });
          break;
        }

        case "geo-url-detail": {
          // One URL can surface under several different prompts (or several
          // times for the same prompt) — this answers "which prompts pulled
          // in this exact URL, how each response used it, and which brands
          // showed up in that response," for the modal opened by clicking a
          // URL in the Source Domains breakdown.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const campaign = selectTracked(all, {
            profileId: msg.profileId,
            runId: msg.runId || undefined,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });
          const scoped = campaign.filter((rec) => (rec.sources || []).some((s) => s.url === msg.url));

          // Inferred from the WHOLE campaign, not from the handful of
          // responses that happen to cite this one URL — otherwise the brand
          // set would change from URL to URL and the Brands column would mean
          // something different in every modal.
          const brands = effectiveTrackedBrands(profile, campaign);
          const own = brands.find((b) => b.isOwn);
          const promptsAll = await db.getAll("trackedPrompts");
          const promptById = new Map(promptsAll.map((p) => [p.id, p]));

          const rows = scoped.map((rec) => {
            const pres = brandPresence(rec, brands);
            const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
            const ownPres = own ? pres.find((p) => p.isOwn) : null;
            const prompt = promptById.get(rec.geo && rec.geo.promptId);
            const hit = (rec.sources || []).find((s) => s.url === msg.url) || {};
            const rankIdx = ownPres ? ranked.findIndex((p) => p.isOwn) : -1;
            return {
              captureId: rec.captureId,
              capturedAt: rec.capturedAt,
              platform: rec.platform,
              promptText: prompt ? prompt.text : "(prompt no longer tracked)",
              mentioned: ownPres ? ownPres.present : null,
              position: rankIdx >= 0 ? rankIdx + 1 : null,
              cited: ownPres ? ownPres.citedSource : null,
              // How this URL was used in THIS response — cited in the answer,
              // or only fetched while researching it. The same URL is often
              // one in some responses and the other in others, which is the
              // whole reason to open this modal.
              outcome: hit.outcome || "",
              title: hit.title || "",
              // Ordered by where each brand FIRST appears in the answer, so
              // the modal can show who led and who trailed. A brand present
              // only in a carousel has no position in the prose — it is still
              // present, so it is appended rather than dropped.
              brands: ranked.map((p) => p.name)
                .concat(pres.filter((p) => p.present && p.firstIndex === null).map((p) => p.name)),
            };
          }).sort((a, b) => b.capturedAt - a.capturedAt);

          sendResponse({
            ok: true,
            rows,
            hasBrand: !!own,
            ownBrand: own ? own.name : "",
            autoCompetitors: brands.filter((b) => b.auto).map((b) => b.name),
          });
          break;
        }

        case "run-list": {
          const runs = await db.getAll("runs");
          runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
          sendResponse({ ok: true, runs });
          break;
        }

        case "loader-start":
          sendResponse(await loaderStart(msg.prompts, msg.options));
          break;
        case "loader-pause":
          loader.paused = true;
          for (const pd of Object.values(loader.platforms)) {
            for (const leg of pd.legs) clearWatchdog(leg);
          }
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-resume": {
          // Resume clears BOTH kinds of pause with one click: a manual pause
          // (loader.paused) and any platform sitting out a rate-limit
          // cooldown (leg.paused) — there's only one Resume button, and the
          // user reaching for it means "let everything that can run, run."
          const anyLegPaused = Object.values(loader.platforms).some((pd) => pd.legs.some((l) => l.paused));
          if (loader.running && (loader.paused || anyLegPaused)) {
            // A run parked by rehydrate (browser closed mid-run) has no tabs
            // left. Recreate one per LEG here, on the user's explicit click,
            // rather than anywhere automatic — that keeps the original "no
            // surprise tab" guarantee while making a long run resumable, now
            // for however many concurrent tabs this run actually has.
            for (const [plat, pd] of Object.entries(loader.platforms)) {
              for (const leg of pd.legs) {
                leg.paused = false;
                if (leg.idx >= leg.prompts.length) continue; // this leg already finished
                let alive = false;
                if (leg.tabId != null) {
                  try { await chrome.tabs.get(leg.tabId); alive = true; } catch (_) { alive = false; }
                }
                if (!alive) {
                  try {
                    const base = plat === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/";
                    const tab = await chrome.tabs.create({ url: base, active: false });
                    leg.tabId = tab.id;
                  } catch (_) {
                    // Couldn't open a tab — leave the run paused rather than
                    // spinning; the user can retry Resume.
                    sendResponse({ ok: false, error: "Couldn't open a tab to resume in. Check Chrome isn't blocking new tabs, then try Resume again." });
                    return;
                  }
                }
              }
            }
            loader.paused = false;
            loader.interrupted = null;
            await persistLoaderState();
            for (const [plat, pd] of Object.entries(loader.platforms)) {
              for (const leg of pd.legs) loaderRunLeg(plat, leg);
            }
          }
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        }
        case "loader-stop":
          for (const pd of Object.values(loader.platforms)) {
            for (const leg of pd.legs) clearWatchdog(leg);
          }
          loader.running = false;
          loader.paused = false;
          // "stopped" here, not "done" — deliberately no badge/notification:
          // the user just clicked Stop, they're already right there.
          await syncGeoRun("stopped");
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-status":
          sendResponse({ ok: true, ...loaderStatus() });
          break;

        /* The error log. Read grouped by default — the same failure repeating
         * 400 times in one run is one problem, and a flat list of identical
         * lines is what makes a log unreadable exactly when it matters. */
        case "error-log": {
          const [entries, grouped] = await Promise.all([
            errorLog.list(msg.limit || 200),
            errorLog.summary(msg.groupLimit || 40),
          ]);
          sendResponse({ ok: true, entries, grouped, cap: errorLog.MAX_ENTRIES });
          break;
        }
        case "error-log-clear":
          sendResponse({ ok: await errorLog.clear() });
          break;
        /* The panel and content scripts report here. Errors thrown in the UI
         * never reached the service worker before, so a render that blew up in
         * the popup left no trace anywhere the user could find — which is
         * precisely how the blank-tab bugs stayed invisible. */
        case "error-report":
          logErr(
            `ui:${typeof msg.where === "string" ? msg.where : "unknown"}`,
            { name: msg.name, message: msg.message, stack: msg.stack },
            msg.context
          );
          sendResponse({ ok: true });
          break;
        // The popup calls this once it has shown the user the completion
        // banner/badge, so the badge doesn't linger stale on the toolbar
        // icon indefinitely after they've already seen it.
        case "loader-ack-complete":
          try {
            await chrome.action.setBadgeText({ text: "" });
          } catch (_) {}
          sendResponse({ ok: true });
          break;

        case "debug":
          pushDebug(msg.event);
          sendResponse({ ok: true });
          break;
        case "get-debug":
          sendResponse({ ok: true, events: DEBUG.slice(-120) });
          break;
        case "clear-debug":
          DEBUG.length = 0;
          sendResponse({ ok: true });
          break;

        case "get-records": {
          const records = await db.getAll("derived");
          records.sort((a, b) => b.capturedAt - a.capturedAt);
          sendResponse({ ok: true, records: records.map(toLight) });
          break;
        }
        case "get-record": {
          const rec = await db.get("derived", msg.captureId);
          sendResponse({ ok: true, record: rec || null });
          break;
        }

        case "get-raw": {
          const row = await db.get("raw", msg.captureId);
          const raw = row ? await gunzipToString(row.gz) : null;
          sendResponse({ ok: true, raw, meta: row ? { url: row.url, reqBody: row.reqBody } : null });
          break;
        }
        case "reprocess-all":
          sendResponse({ ok: true, ...(await reprocessAll()) });
          break;
        case "delete-record":
          await db.delete("raw", msg.captureId);
          await db.delete("derived", msg.captureId);
          sendResponse({ ok: true });
          break;
        case "clear-all":
          await db.clear("raw");
          await db.clear("derived");
          await db.clear("runs");
          sendResponse({ ok: true });
          break;
        case "stats": {
          let usage = null;
          try {
            if (navigator.storage && navigator.storage.estimate) {
              const est = await navigator.storage.estimate();
              usage = { usedBytes: est.usage || 0, quotaBytes: est.quota || 0 };
            }
          } catch (_) {}
          sendResponse({
            ok: true,
            raw: await db.count("raw"),
            derived: await db.count("derived"),
            usage,
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      // The single most valuable log line in the extension: every UI action
      // funnels through this switch, so anything that throws here is a
      // feature the user just watched fail. The reply already surfaced the
      // message; this makes it survivable to diagnose afterwards, with the
      // message type that caused it.
      logErr(`message:${msg && msg.type ? msg.type : "unknown"}`, e);
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});
