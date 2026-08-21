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
import { gzipString, gunzipToString } from "./lib/gzip.js";
import { adapt as adaptChatGpt } from "./adapters/chatgpt.js";
import { adapt as adaptGemini } from "./adapters/gemini.js";
import {
  MAX_PROFILES, TRASH_RETENTION_DAYS, makeProfile, makeTrackedPrompt, makeGeoRun, runVolume,
  selectTracked, computeMetrics, computeSeries, brandPresence, trackedBrandsOf,
  hasSignal, countCompletedForRun,
} from "./lib/geo.js";
export { hasSignal };

// Loose match for duplicate-prompt detection: trim, lowercase, collapse
// whitespace. Deliberately NOT as aggressive as geo.js's normName() (which
// strips all punctuation) — "40,000" and "40000" should probably stay
// distinct prompts, just exact-text-modulo-whitespace duplicates should not.
function normPromptText(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

const ADAPTERS = { chatgpt: adaptChatGpt, gemini: adaptGemini };

const AI_TAB_MATCHES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
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
  if (/gemini\.google\.com|BardChatUi|StreamGenerate/.test(url || "")) return "gemini";
  if (/chatgpt\.com|chat\.openai\.com/.test(url || "")) return "chatgpt";
  return "chatgpt";
}

/* ---------- Capture ---------- */
async function storeCapture(payload, meta) {
  const platform = platformFromUrl(payload.pageUrl || payload.url);
  const settings = await getSettings();
  const rawText = payload.raw || "";

  // Gemini emits many small RPCs; only the assistant generation is substantial.
  if (platform === "gemini" && rawText.length < 2000) return null;

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
async function deriveAndStore(rawRow, rawText, settings) {
  const raw = rawText ?? (await gunzipToString(rawRow.gz));
  const cfg = settings || (await getSettings());
  const adapter = ADAPTERS[rawRow.platform] || ADAPTERS.chatgpt;
  const record = adapter(
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

// Keep the store bounded: prune oldest captures beyond the retention limit.
async function enforceRetention(settings) {
  const cfg = settings || (await getSettings());
  const limit = Math.max(50, cfg.retentionMax || DEFAULT_SETTINGS.retentionMax);
  const count = await db.count("derived");
  if (count <= limit) return;
  const keys = await db.getAllKeysSortedByTime("derived", count - limit);
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
 *      chrome.storage.session (survives worker restarts within a browser
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
const TURN_TIMEOUT_MS = 90000; // give a turn this long before declaring it failed
const MIN_ADVANCE_GAP_MS = 2500; // ignore a second "done" arriving right after one
const LOADER_STATE_KEY = "lcfcLoaderState";
const HEARTBEAT_ALARM = "lcfcHeartbeat";
const DURATION_WINDOW = 10; // per-platform rolling window of turn durations, for Phase 2's ETA

let loader = newLoaderState();
function newLoaderState() {
  return { running: false, paused: false, options: {}, done: 0, errors: 0, total: 0, platforms: {}, runId: null };
}

// Best-effort: a persistence failure must never break a run already in
// progress, so every call site fires this and moves on rather than awaiting
// a hard guarantee.
async function persistLoaderState() {
  try {
    const snap = {
      running: loader.running,
      paused: loader.paused,
      options: loader.options,
      done: loader.done,
      errors: loader.errors,
      total: loader.total,
      runId: loader.runId,
      platforms: Object.fromEntries(
        Object.entries(loader.platforms).map(([plat, p]) => [
          plat,
          {
            tabId: p.tabId,
            prompts: p.prompts,
            idx: p.idx,
            failed: p.failed || 0,
            lastAdvanceAt: p.lastAdvanceAt || 0,
            startedAt: p.startedAt || 0,
            token: p.token || null,
            expectedPrompt: p.expectedPrompt || null,
            durations: p.durations || [],
          },
        ])
      ),
    };
    await chrome.storage.session.set({ [LOADER_STATE_KEY]: snap });
  } catch (_) {
    /* best-effort */
  }
}
async function loadPersistedLoaderState() {
  try {
    const got = await chrome.storage.session.get(LOADER_STATE_KEY);
    return got[LOADER_STATE_KEY] || null;
  } catch (_) {
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
  } catch (_) {
    /* alarms API unavailable in some test/mock contexts — degrade silently */
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
  for (const plat of Object.keys(loader.platforms)) {
    const p = loader.platforms[plat];
    if (p.idx >= p.prompts.length || !p.startedAt || p.watchdog) continue;
    if (Date.now() - p.startedAt >= TURN_TIMEOUT_MS + 5000) failTurnAndAdvance(plat, "watchdog lost");
  }
}

// Reusable so the freshly-armed path (loaderRunPlatform) and the recovered-
// after-restart path (resumeFromSnapshot) can never drift apart.
function armWatchdog(plat, ms) {
  const p = loader.platforms[plat];
  if (!p) return;
  p.watchdog = setTimeout(() => {
    if (!loader.running || loader.paused) return;
    if (p.idx >= p.prompts.length) return;
    failTurnAndAdvance(plat, "timeout");
  }, ms);
}

// The one place a turn is counted as failed and the run moves on — shared by
// the watchdog, the tab-closed path, and both restart-recovery paths below,
// so "what counts as a failure" can never quietly diverge between them.
// `retryDelayMs` defaults to immediate (matching the original watchdog
// behaviour); the tab-closed path passes a short delay to avoid hammering
// chrome.tabs.update in a tight loop if every remaining prompt in the list
// would also fail against the same closed tab.
function failTurnAndAdvance(plat, reason, retryDelayMs = 0) {
  const p = loader.platforms[plat];
  if (!p) return;
  loader.errors++;
  p.failed = (p.failed || 0) + 1;
  p.idx++;
  p.lastAdvanceAt = Date.now();
  p.lastFailReason = reason;
  persistLoaderState();
  if (retryDelayMs > 0) setTimeout(() => loaderRunPlatform(plat), retryDelayMs);
  else loaderRunPlatform(plat);
}

/**
 * Rebuild `loader` from a persisted snapshot after this worker instance
 * turns out to have no memory of an active run — i.e. a previous instance
 * died mid-run. Never trusts the snapshot's `idx` alone: reconciles against
 * what's actually in the derived store first (see the header comment above).
 */
async function resumeFromSnapshot(snap) {
  const platEntries = Object.entries(snap.platforms || {});
  const all = platEntries.length ? await db.getAll("derived") : [];

  loader = {
    running: true,
    paused: !!snap.paused,
    options: snap.options || {},
    done: 0,
    errors: snap.errors || 0,
    total: snap.total || 0,
    runId: snap.runId,
    platforms: {},
  };

  for (const [plat, sp] of platEntries) {
    const trueIdx = countCompletedForRun(all, snap.runId, plat);
    const idx = Math.max(sp.idx || 0, Math.min(trueIdx, (sp.prompts || []).length));
    loader.platforms[plat] = {
      tabId: sp.tabId,
      prompts: sp.prompts || [],
      idx,
      failed: sp.failed || 0,
      lastAdvanceAt: sp.lastAdvanceAt || 0,
      startedAt: sp.startedAt || Date.now(),
      token: sp.token || null,
      expectedPrompt: sp.expectedPrompt || null,
      durations: sp.durations || [],
      watchdog: null,
    };
  }
  loader.done = Object.values(loader.platforms).reduce((n, p) => n + p.idx, 0);

  if (loader.paused) {
    await persistLoaderState();
    return;
  }

  for (const plat of Object.keys(loader.platforms)) {
    const p = loader.platforms[plat];
    if (p.idx >= p.prompts.length) continue; // this platform's leg already finished

    let tabAlive = true;
    try {
      await chrome.tabs.get(p.tabId);
    } catch (_) {
      tabAlive = false;
    }

    if (!tabAlive) {
      // Deliberately conservative: don't auto-recreate a closed tab and start
      // navigating it without the user around to notice — count the rest of
      // this platform's leg as failed instead of risking a surprise tab.
      const remaining = p.prompts.length - p.idx;
      loader.errors += remaining;
      p.failed = (p.failed || 0) + remaining;
      p.idx = p.prompts.length;
      continue;
    }

    const elapsed = Date.now() - (p.startedAt || 0);
    if (elapsed >= TURN_TIMEOUT_MS) {
      // The turn that was in flight when the worker died has now definitely
      // timed out.
      failTurnAndAdvance(plat, "timeout during restart");
    } else {
      armWatchdog(plat, TURN_TIMEOUT_MS - elapsed);
    }
  }

  if (Object.values(loader.platforms).every((p) => p.idx >= p.prompts.length)) loader.running = false;
  await persistLoaderState();
}

// Diagnostic ring buffer (in-memory) for the Debug view.
const DEBUG = [];
function pushDebug(event) {
  DEBUG.push(event);
  if (DEBUG.length > 200) DEBUG.shift();
}

function loaderStatus() {
  if (!loader.running) return { running: false, total: loader.total, done: loader.done, errors: loader.errors };
  let totalTasks = 0;
  let totalIdx = 0;
  const platStats = {};
  const current = [];
  for (const plat of Object.keys(loader.platforms)) {
    const p = loader.platforms[plat];
    totalTasks += p.prompts.length;
    totalIdx += p.idx;
    platStats[plat] = { done: p.idx, total: p.prompts.length, failed: p.failed || 0 };
    if (p.idx < p.prompts.length) current.push(p.prompts[p.idx]);
  }
  return {
    running: loader.running,
    paused: loader.paused,
    total: totalTasks,
    done: loader.done,
    idx: totalIdx,
    errors: loader.errors,
    current: current.length ? current[0] : null,
    runId: loader.runId,
    platStats,
  };
}

function clearWatchdog(p) {
  if (p && p.watchdog) {
    clearTimeout(p.watchdog);
    p.watchdog = null;
  }
}

async function loaderRunPlatform(plat) {
  if (!loader.running || loader.paused) return;
  const p = loader.platforms[plat];
  if (!p) return;

  clearWatchdog(p);

  if (p.idx >= p.prompts.length) {
    if (Object.values(loader.platforms).every((x) => x.idx >= x.prompts.length)) loader.running = false;
    await persistLoaderState();
    return;
  }

  const prompt = p.prompts[p.idx];
  const q = encodeURIComponent(prompt);
  // A one-time token proves to the content script that THIS navigation came from
  // the Loader — so a crafted ?lcfc=1&q=… link can't make ChatGPT run a prompt.
  p.token = crypto.randomUUID();
  p.expectedPrompt = prompt;
  p.startedAt = Date.now();
  await persistLoaderState();

  const search = plat === "chatgpt" && loader.options.forceSearch ? "&lcfcsearch=1" : "";
  const base = plat === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/";
  const url = `${base}?q=${q}&lcfc=1&lcfctok=${p.token}${search}`;

  try {
    await chrome.tabs.update(p.tabId, { url });
  } catch (_) {
    // Tab was closed — fail this prompt and move on rather than hanging.
    failTurnAndAdvance(plat, "tab closed", 500);
    return;
  }

  // Watchdog: if no signal-bearing capture arrives in time, record a failure and
  // continue. Without this a rate-limited or errored turn stalls the whole run.
  armWatchdog(plat, TURN_TIMEOUT_MS);
}

async function loaderStart(prompts, options) {
  const clean = (prompts || []).map((p) => String(p).trim()).filter(Boolean);
  if (!clean.length) return { ok: false, error: "No prompts provided." };

  const platforms = (options && options.platforms) || ["chatgpt"];
  const supported = platforms.filter((p) => p === "chatgpt" || p === "gemini");
  if (!supported.length) return { ok: false, error: "Select ChatGPT and/or Gemini." };

  loader = newLoaderState();
  loader.running = true;
  loader.options = options || {};
  loader.total = clean.length * supported.length;
  loader.runId = crypto.randomUUID();

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

  for (const plat of supported) {
    const created = windowId
      ? await chrome.tabs.create({ windowId, url: "about:blank" })
      : await chrome.tabs.create({ url: "about:blank", active: false });
    loader.platforms[plat] = { tabId: created.id, prompts: clean, idx: 0, failed: 0, lastAdvanceAt: 0, durations: [] };
  }
  await persistLoaderState();
  for (const plat of supported) loaderRunPlatform(plat);

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

  const engines = (profile.engines || []).filter((e) => e === "chatgpt" || e === "gemini");
  if (!engines.length) return { ok: false, error: "Select at least one engine that has an adapter." };

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

// Called after each capture; advances the loader only for a real, completed turn.
function loaderOnCapture(tabId, record) {
  if (!loader.running) return;
  for (const plat of Object.keys(loader.platforms)) {
    const p = loader.platforms[plat];
    if (p.tabId !== tabId) continue;

    // Ignore empty race-loser captures — advancing on those silently SKIPS prompts.
    if (!hasSignal(record)) return;
    // Ignore a second completion arriving immediately after one we already counted.
    if (p.lastAdvanceAt && Date.now() - p.lastAdvanceAt < MIN_ADVANCE_GAP_MS) return;

    clearWatchdog(p);
    if (p.startedAt) p.durations = [...(p.durations || []), Date.now() - p.startedAt].slice(-DURATION_WINDOW);
    p.lastAdvanceAt = Date.now();
    loader.done++;
    p.idx++;
    // Persisted synchronously, before scheduling the next turn — this is the
    // step that closes the restart-duplicate window: if the worker dies
    // between here and the next capture, a resume will see this completion
    // already reflected in storage rather than reconciling against a
    // count that doesn't yet include it (which would resubmit this prompt).
    persistLoaderState();
    const delay = 3000 + Math.random() * 3000; // human-paced gap
    if (!loader.paused) setTimeout(() => loaderRunPlatform(plat), delay);
    return;
  }
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
            for (const p of Object.values(loader.platforms)) {
              if (p.tabId === tabId) {
                meta = { projectId: loader.options.projectId || null, runId: loader.runId };
                // A GEO tracking run stamps per-prompt provenance so the metrics
                // engine can attribute each response to the right tracked prompt
                // and its tags. p.idx is the prompt this tab is currently on.
                const g = loader.options.geo;
                if (g) {
                  const tp = (loader.options.geoPrompts || [])[p.idx] || {};
                  meta.geo = {
                    profileId: g.profileId,
                    runId: g.runId,
                    promptId: tp.id || null,
                    tags: tp.tags || [],
                  };
                }
                break;
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
            for (const p of Object.values(loader.platforms)) {
              if (p.tabId === tabId && p.token && p.token === msg.token) {
                ok = true;
                break;
              }
            }
          }
          sendResponse({ ok });
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
          for (const row of rows) {
            const text = String(row?.text || "").trim();
            if (!text) continue;
            const key = normPromptText(text);
            if (seen.has(key)) { duplicates.push(text); continue; }
            seen.add(key);
            const p = makeTrackedPrompt({ profileId: msg.profileId, text, tags: row.tags || [] });
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
          sendResponse({
            ok: true,
            metrics: computeMetrics(scoped, profile),
            series: computeSeries(scoped, profile, msg.bucket || "day"),
            responses: scoped.length,
            overview: { captures: scoped.length, searched, fanTotal, domainCount: domainSet.size, citedTotal, fetchedTotal },
          });
          break;
        }

        case "geo-prompt-performance": {
          // Per-response detail grouped by prompt (not just the profile-wide
          // aggregate geo-metrics returns): for each run of each tracked
          // prompt, was the campaign's own brand mentioned (and at what rank
          // among tracked brands), was its domain cited, plus that run's
          // sources — so the Dashboard can show a per-prompt performance
          // table instead of a generic ad-hoc conversation list, without
          // shipping full answerText across the message boundary.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const scoped = selectTracked(all, {
            profileId: msg.profileId,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          });
          const brands = trackedBrandsOf(profile);
          const own = brands.find((b) => b.isOwn);

          const byPrompt = new Map();
          for (const rec of scoped) {
            const promptId = rec.geo && rec.geo.promptId;
            if (!promptId) continue;
            let mentioned = false, position = null, cited = false;
            if (own) {
              const pres = brandPresence(rec, brands);
              const ranked = pres.filter((p) => p.firstIndex !== null).sort((a, b) => a.firstIndex - b.firstIndex);
              const ownPres = pres.find((p) => p.isOwn);
              if (ownPres) {
                mentioned = ownPres.present;
                cited = ownPres.citedSource;
                const rankIdx = ranked.findIndex((p) => p.isOwn);
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

          sendResponse({ ok: true, hasBrand: !!own, prompts: Object.fromEntries(byPrompt) });
          break;
        }

        case "geo-url-detail": {
          // One URL can surface under several different prompts (or several
          // times for the same prompt) — this answers "which prompts pulled
          // in this exact URL, and which brands showed up in that response,"
          // for the modal opened by clicking a URL in the Source Domains
          // breakdown.
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = await db.getAll("derived");
          const scoped = selectTracked(all, {
            profileId: msg.profileId,
            engines: msg.engines,
            tags: msg.tags,
            since: msg.since,
            until: msg.until,
          }).filter((rec) => (rec.sources || []).some((s) => s.url === msg.url));

          const brands = trackedBrandsOf(profile);
          const own = brands.find((b) => b.isOwn);
          const promptsAll = await db.getAll("trackedPrompts");
          const promptById = new Map(promptsAll.map((p) => [p.id, p]));

          const rows = scoped.map((rec) => {
            const pres = brandPresence(rec, brands);
            const ownPres = own ? pres.find((p) => p.isOwn) : null;
            const prompt = promptById.get(rec.geo && rec.geo.promptId);
            return {
              captureId: rec.captureId,
              capturedAt: rec.capturedAt,
              platform: rec.platform,
              promptText: prompt ? prompt.text : "(prompt no longer tracked)",
              mentioned: ownPres ? ownPres.present : null,
              brands: pres.filter((p) => p.present).map((p) => p.name),
            };
          }).sort((a, b) => b.capturedAt - a.capturedAt);

          sendResponse({ ok: true, rows });
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
          for (const p of Object.values(loader.platforms)) clearWatchdog(p);
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-resume":
          if (loader.running && loader.paused) {
            loader.paused = false;
            await persistLoaderState();
            for (const plat of Object.keys(loader.platforms)) loaderRunPlatform(plat);
          }
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-stop":
          for (const p of Object.values(loader.platforms)) clearWatchdog(p);
          loader.running = false;
          loader.paused = false;
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-status":
          sendResponse({ ok: true, ...loaderStatus() });
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
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async response
});
