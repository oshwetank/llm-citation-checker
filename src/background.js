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

import { probeIsRead } from "./lib/geminiChannel.js";
import { createAiService } from "./aiService.js";
import { db } from "./lib/db.js";
import {
  turnBudgetMs, legEta, runTookMs, INTER_PROMPT_MIN_MS, INTER_PROMPT_MAX_MS, nextGapMs,
  CONCURRENT_TABS_PER_ENGINE, tabsForEngine, LEG_START_STAGGER_MS, shardPrompts,
  parseCooldownFromNotice, formatCooldown, needsFreshTab, tabRecycleEvery,
} from "./lib/pacing.js";
import { createErrorLog } from "./lib/errorlog.js";
import { compareRuns } from "./lib/runCompare.js";
import { BUILD } from "./lib/build.js";
import { noteHealth, emptyHealth, healthReport, verdict, missedAnswers, shouldNoteDrop, ENGINES as HEALTH_ENGINES } from "./lib/captureHealth.js";
import { checkEnginesAuth, checkEngineAuth, AUTH_COOKIES } from "./lib/auth-check.js";
import { buildDemoRecords, isDemoRecord } from "./lib/demo-data.js";
import { buildCampaignXlsx, campaignCsvFiles, campaignExportCounts } from "./lib/campaignXlsx.js";
import { campaignReport } from "./lib/campaignReport.js";
import { findPrevious } from "./lib/analyzeView.js";
import { summarizeRunDiagnostics } from "./lib/diagnosticsSummary.js";
import { gzipString, gunzipToString } from "./lib/gzip.js";
import { campaignParts, makeBundle, encodeBundle, decodeBundle, readBundle, bundleFileName, bufToB64, b64ToBuf } from "./lib/campaignBundle.js";
import { makeCloud, cloudReady, CLOUD_SESSION_KEY } from "./lib/cloud.js";
import { CLOUD } from "./lib/cloudConfig.js";
import { checkEmail } from "./lib/emailCheck.js";
import { citedUrls, pageVerdict, pageSummary, wordCount, PAGE_TTL_MS } from "./lib/pageText.js";
import { isPublicHttpUrl } from "./lib/safeUrl.js";
import { mayHandle, onEngineSite } from "./lib/senderGate.js";
import { appendRing, cleanEntry } from "./lib/netlog.js";
import { offersFrom, attachOffers, productUpdateFrom, productPanelFrom, formChoicesFrom, cardIndexFor } from "./lib/offers.js";
import { searchAnswers } from "./lib/answerSearch.js";
import { indexFor } from "./lib/passages.js";
import { answerKey, sameAnswer, mergeAnswers, SAME_ANSWER_WINDOW_MS, SAME_REPLY_WINDOW_MS } from "./lib/sameAnswer.js";
import { campaignBoard, brandDetail } from "./lib/campaignBoard.js";
import { campaignView } from "./lib/campaignView.js";
import { campaignInsights } from "./lib/insights.js";
import { ENGINES as HANDOFF_ENGINES } from "./lib/contextPack.js";
import { adapt as adaptChatGpt, cleanPassage } from "./adapters/chatgpt.js";
import { enrichBrandsWithAI, enrichBrandStance } from "./lib/ai-brands.js";
import { adapt as adaptGemini } from "./adapters/gemini.js";
import { adapt as adaptPerplexity } from "./adapters/perplexity.js";
import { adapt as adaptGrok } from "./adapters/grok.js";
import { adapt as adaptAiMode } from "./adapters/aimode.js";
import { adaptPageCopy, isPageCopy } from "./adapters/pageCopy.js";
import { cleanPrompt } from "./lib/promptText.js";
import {
  MAX_PROFILES, TRASH_RETENTION_DAYS, makeProfile, makeTrackedPrompt, makeGeoRun, runVolume,
  needsUnlock, profileChanges, addCompetitor, autoCompetitorsFrom, missingTurns,
  selectTracked, latestAnswers, computeMetrics, computeSeries, brandPresence, normName,
  effectiveTrackedBrands, headToHead, brandSourceDomains, availableEngines,
  hasSignal, turnAnswered, usageLimitOf, countCompletedForRun, countCompletedForLeg, isPrunableCapture, retentionVictims,
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
  aimode: adaptAiMode,
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
  "https://www.google.com/search*",
];

/* ---------- Settings ---------- */
const DEFAULT_SETTINGS = {
  // Who the user is tracking. This does NOT drive brand detection — detection is
  // automatic and industry-agnostic (see lib/brands.js). These entries only LABEL
  // detected brands as own/competitor so share-of-voice can be reported, and the
  // URLs let cited domains be attributed to the right brand.
  myBrand: { name: "", url: "" },
  competitors: [], // [{ name, url }]
  debugCapture: false,
  // The slower, safer pace (lib/pacing.js, 1.0.5): off = every engine fast.
  carefulPace: false,
  // Pause capture (0.66.0): the switch at the top of the popup and the tab.
  // While on, nothing from an engine page is stored: no answers, no
  // after-answer requests, no probes, no network log. A campaign run's own
  // tabs still record, since starting a run asks for exactly that.
  capturePaused: false,
  keepHandoffCaptures: false, // 0.76.0: capture the "Continue in…" chats too
  // Read the cited pages (0.62.0): off until asked for, since it is the one
  // thing that makes requests beyond the engines' own pages.
  readCitedPages: false, // diagnostic channel is OFF by default (it is chatty)
  // The built-in AI (0.70.0): what it checks once downloaded, and whether
  // the names it finds join the counts (off: counts stay the same on every
  // computer, model or not).
  aiOnCampaigns: true,
  aiOnEveryday: true,
  aiInCounts: false,
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
  if (area === "local" && changes.lcfcSettings) { settingsCache = null; idleBadge(); }
});

// The toolbar icon says "off" while capture is paused, on every page, so a
// paused recorder is never mistaken for a working one. A run's progress
// badge takes the icon while it runs.
async function idleBadge() {
  if (loader && loader.running) return;
  try {
    const paused = !!(await getSettings()).capturePaused;
    await chrome.action.setBadgeText({ text: paused ? "off" : "" });
    if (paused) await chrome.action.setBadgeBackgroundColor({ color: "#57534e" });
    await chrome.action.setTitle({ title: paused ? "CitoSkeleton: capture paused" : "CitoSkeleton" });
  } catch (_) { /* no action API in some test contexts */ }
}

/* ---------- "Continue in…" (0.76.0) ----------
 * A tab opened to take CitoSkeleton's data to another AI. Its message waits
 * here until the page script (src/handoff.js) claims it; the tab is
 * remembered (also across a worker restart) so the conversation there — the
 * user talking about their own data — isn't captured as an engine answer. */
const handoffJobs = new Map(); // tabId -> {text, engine, autoSend, at}
const HANDOFF_TABS_KEY = "lcfcHandoffTabs";
async function handoffTabs() {
  try { return new Set((await chrome.storage.session.get(HANDOFF_TABS_KEY))[HANDOFF_TABS_KEY] || []); } catch (_) { return new Set(); }
}
async function setHandoffTab(tabId, on) {
  const s = await handoffTabs();
  if (on) s.add(tabId); else s.delete(tabId);
  try { await chrome.storage.session.set({ [HANDOFF_TABS_KEY]: [...s] }); } catch (_) { /* best effort */ }
}
// A change to a locked campaign's prompts goes in its change log (0.77.0).
async function logCampaignChange(profileId, entry) {
  const p = profileId ? await db.get("profiles", profileId) : null;
  if (!p || !p.locked) return;
  await db.put("profiles", makeProfile({ ...p, changes: [...(p.changes || []), { at: Date.now(), ...entry }] }));
}
async function handoffOpen({ engine, text, autoSend = true }) {
  const e = HANDOFF_ENGINES[engine];
  if (!e) return { ok: false, error: `No engine ${engine}.` };
  if (!text || typeof text !== "string") return { ok: false, error: "Nothing to send." };
  const origin = new URL(e.url).origin + "/*";
  if (!(await chrome.permissions.contains({ origins: [origin] }).catch(() => false))) return { ok: false, error: `CitoSkeleton needs permission for ${new URL(e.url).hostname} first.`, needsPermission: origin };
  const tab = await chrome.tabs.create({ url: e.url, active: true });
  handoffJobs.set(tab.id, { text: text.slice(0, 200000), engine, autoSend: autoSend !== false, at: Date.now() });
  await setHandoffTab(tab.id, true);
  return { ok: true, tabId: tab.id };
}
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !handoffJobs.has(tabId)) return;
  // Only while the tab is still on the AI site it was opened for (0.84.1,
  // lib/senderGate.js onEngineSite). A tab redirected elsewhere keeps its
  // message waiting: the script goes in if it comes back.
  const job = handoffJobs.get(tabId);
  const engine = HANDOFF_ENGINES[job.engine];
  if (!engine || !onEngineSite((tab && tab.url) || "", engine.url)) return;
  chrome.scripting.executeScript({ target: { tabId }, files: ["src/handoff.js"] }).catch((e) => logErr("handoff:inject", e));
});
chrome.tabs.onRemoved.addListener((tabId) => { handoffJobs.delete(tabId); setHandoffTab(tabId, false); });
// A run's tab closed while its question was out (1.0.5): a new tab takes over
// at once, instead of the question timing out 90 s later.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!loader.running || loader.paused) return;
  const found = legForTab(tabId);
  if (!found) return;
  const { plat, leg } = found;
  if (leg.paused || leg.idx >= leg.prompts.length || leg.inFlightIdx !== leg.idx) return;
  replaceLegTab(plat, leg).then((ok) => { if (ok) retryTurn(plat, leg, "its tab was closed; a new one took over"); }).catch((e) => logErr("run:tab-removed", e));
});

/* Google AI Mode (1.0.5, engine 5).
 *
 * Its page scripts are registered here, not in manifest.json: google.com is
 * not a site the extension may read until the user turns AI Mode on and
 * Chrome grants it (optional permission, inside the existing optional
 * <all_urls>), so turning AI Mode on can't switch the extension off for
 * anyone. Both scripts leave every Google page alone but AI Mode's
 * (/search?udm=50, checked first thing in each).
 */
const AIMODE_MATCHES = ["https://www.google.com/search*"];
const AIMODE_SCRIPTS = [
  { id: "aimode-main", matches: AIMODE_MATCHES, js: ["src/content-main.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
  { id: "aimode-iso", matches: AIMODE_MATCHES, js: ["src/content-iso.js"], runAt: "document_start", persistAcrossSessions: true },
];
/** Register or remove AI Mode's page scripts to match the setting and the permission. */
async function syncAiModeScripts() {
  try {
    const { aimodeOn } = await chrome.storage.local.get("aimodeOn");
    const granted = await chrome.permissions.contains({ origins: AIMODE_MATCHES });
    const have = (await chrome.scripting.getRegisteredContentScripts({ ids: AIMODE_SCRIPTS.map((x) => x.id) })).map((x) => x.id);
    if (aimodeOn && granted) {
      const missing = AIMODE_SCRIPTS.filter((x) => !have.includes(x.id));
      if (missing.length) await chrome.scripting.registerContentScripts(missing);
    } else if (have.length) {
      await chrome.scripting.unregisterContentScripts({ ids: have });
    }
    return { ok: true, on: !!(aimodeOn && granted), granted };
  } catch (e) { logErr("aimode:scripts", e); return { ok: false, error: String(e && e.message || e) }; }
}
chrome.permissions?.onAdded?.addListener(() => { syncAiModeScripts(); });
chrome.permissions?.onRemoved?.addListener(() => { syncAiModeScripts(); });
chrome.runtime.onStartup?.addListener(() => { syncAiModeScripts(); });

// Google's robot check: an AI Mode run tab that lands on /sorry/ pauses AI
// Mode only, until a person answers it and presses Resume. Never solved or
// worked around.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || (tab && tab.url) || "";
  if (!loader.running || !/^https:\/\/www\.google\.[a-z.]+\/sorry\//i.test(url)) return;
  const found = legForTab(tabId);
  if (!found || found.plat !== "aimode") return;
  logEvent("run:captcha:aimode", "turn", "Google asked to confirm you're not a robot", { platform: "aimode", runId: loader.runId });
  pauseForLimit("aimode", "Google asked to confirm you're not a robot", { manual: true }).catch((e) => logErr("aimode:captcha", e));
});

// Whether a message from an engine page is dropped because capture is
// paused. A campaign run's tab is exempt. A "Continue in…" tab is never
// captured (0.76.0), unless the user chose to keep those.
async function capturePausedFor(sender) {
  const settings = await getSettings();
  const tid = sender && sender.tab && sender.tab.id;
  if (tid != null && !settings.keepHandoffCaptures && (await handoffTabs()).has(tid)) return true;
  if (!settings.capturePaused) return false;
  const tabId = sender && sender.tab && sender.tab.id;
  return !(loader && loader.running && tabId != null && legForTab(tabId));
}

// How the answer was asked (0.66.0): from a private (incognito) window, and
// whether the engine had a signed-in session in that window's cookie store.
// Signed-out and private answers carry no account history or memory, which
// is why they're worth telling apart.
async function sessionOf(sender, platform, url) {
  const tab = sender && sender.tab;
  const out = { private: !!(tab && tab.incognito), signedIn: "unknown" };
  if (platform === "chatgpt" && /\/backend-anon\//.test(url || "")) { out.signedIn = "out"; return out; }
  try {
    let storeId;
    if (tab && tab.id != null && chrome.cookies.getAllCookieStores) {
      const stores = await chrome.cookies.getAllCookieStores();
      const st = stores.find((x) => (x.tabIds || []).includes(tab.id));
      if (st) storeId = st.id;
    }
    // The cookies the engine's page itself is sent (0.69.0). For Gemini this
    // finds nothing without access to google.com, which 1.0.0 doesn't ask
    // for (see AUTH_COOKIES.gemini), so a Gemini answer reads "unknown"
    // rather than a wrong "signed out".
    const spec = AUTH_COOKIES[platform];
    const pageUrl = tab && tab.url && /^https:/.test(tab.url) ? new URL(tab.url).origin + "/" : null;
    if (spec && pageUrl) {
      const got = (await chrome.cookies.getAll(storeId ? { url: pageUrl, storeId } : { url: pageUrl })) || [];
      if (got.some((c) => spec.names.includes(c.name) && c.value)) out.signedIn = "in";
      else if (got.length && !spec.neverOut) out.signedIn = "out";
    } else {
      const r = await checkEngineAuth(platform, (q) => chrome.cookies.getAll(storeId ? { ...q, storeId } : q));
      out.signedIn = r.status;
    }
  } catch (_) { /* unknown */ }
  return out;
}

// Reloading the extension orphans content scripts already running in open tabs
// (they can no longer reach the new service worker — capture goes silent).
// Auto-refresh the AI tabs on install/update so their scripts re-inject.
//
// Also re-arms the heartbeat alarm here. The top-level ensureHeartbeatAlarm()
// call further down already runs on every fresh worker evaluation, which
// install/update always trigger — so in practice this is redundant with
// that call. It's kept anyway because onInstalled is the exact event
// Chrome's own docs point to for "an update may have cleared alarms,
// re-create them," and calling ensureHeartbeatAlarm() is itself idempotent
// (checks before creating), so there's no cost to being explicit here
// rather than relying on load-order coincidence.
/* The welcome guide (0.81.0, ui/welcome.html): opened once, full page, when
 * the extension is installed, and once on the update that brings it to
 * someone who already had the extension. Asked: "this landing page … only
 * pops up one time". Never in an automated browser (a test run is a fresh
 * install every time), unless a test asks for it. */
const WELCOME_OFFERED_KEY = "citoWelcomeOffered";
async function openWelcomeOnce({ evenAutomated = false } = {}) {
  try {
    // Test browsers run headless; the worker's navigator.webdriver isn't set.
    const automated = !!navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent || "");
    if (automated && !evenAutomated) return false;
    const got = await chrome.storage.local.get([WELCOME_OFFERED_KEY, "citoWelcomeDone", "citoSignup"]);
    if (got[WELCOME_OFFERED_KEY] || got.citoWelcomeDone) return false;
    await chrome.storage.local.set({ [WELCOME_OFFERED_KEY]: Date.now() });
    await chrome.tabs.create({ url: chrome.runtime.getURL("ui/welcome.html"), active: true });
    return true;
  } catch (e) {
    logErr("welcome", e);
    return false;
  }
}

/* Accounts and update emails (0.82.0, lib/cloud.js). Off while
 * lib/cloudConfig.js is empty: nothing is sent and the panel says so. */
const cloudOn = () => cloudReady(CLOUD);
const cloud = makeCloud(CLOUD, {
  load: async () => (await chrome.storage.local.get(CLOUD_SESSION_KEY))[CLOUD_SESSION_KEY] || null,
  save: async (s) => (s ? chrome.storage.local.set({ [CLOUD_SESSION_KEY]: s }) : chrome.storage.local.remove(CLOUD_SESSION_KEY)),
});

// The email left on the welcome page or in Settings goes to the server once
// there is one; what was sent, and its unsubscribe token, is kept apart from
// citoSignup so Remove can still unsubscribe after the address is cleared.
const SIGNUP_SENT_KEY = "citoSignupSent";
async function syncSignup() {
  if (!cloudOn()) return { ok: true, sent: false, reason: "off" };
  const got = await chrome.storage.local.get(["citoSignup", SIGNUP_SENT_KEY]);
  const want = got.citoSignup && got.citoSignup.email && got.citoSignup.consent ? got.citoSignup.email : "";
  const sent = got[SIGNUP_SENT_KEY] || null;
  try {
    if (sent && sent.email !== want) {
      await cloud.unsubscribe(sent.email, sent.token).catch((e) => { if (e.status !== 404) throw e; });
      await chrome.storage.local.remove(SIGNUP_SENT_KEY);
    }
    if (want && (!sent || sent.email !== want)) {
      const r = await cloud.subscribe(want, { source: got.citoSignup.source || "extension" });
      await chrome.storage.local.set({ [SIGNUP_SENT_KEY]: { email: want, token: r.token, at: Date.now() }, citoSignup: { ...got.citoSignup, sent: true } });
    }
    return { ok: true, sent: !!want };
  } catch (e) {
    // Tried again at the next start; the address stays on this computer.
    logErr("signup", e);
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onStartup?.addListener(() => { syncSignup(); });

/* A campaign as a .cito file (0.82.0, lib/campaignBundle.js). Its raw
 * captures are read one by one, by key: the raw store can be large. */
async function exportCampaignFile(profileId, { includeRaw = true } = {}) {
  const profile = await db.get("profiles", profileId);
  if (!profile) return { ok: false, error: "Campaign not found." };
  const parts = campaignParts(profile.id, {
    prompts: await db.getAll("trackedPrompts"),
    runs: await db.getAll("geoRuns"),
    records: await db.getAll("derived"),
  });
  if (includeRaw) {
    const ids = [...new Set(parts.records.flatMap((r) => [r.captureId, ...(r.mergedFrom || [])]))];
    for (const id of ids) { const row = await db.get("raw", id); if (row) parts.raws.push(row); }
  }
  const s = (await chrome.storage.local.get(CLOUD_SESSION_KEY))[CLOUD_SESSION_KEY];
  const bundle = makeBundle({ profile, ...parts, includeRaw, appVersion: chrome.runtime.getManifest().version, from: s && s.user && s.user.name ? { name: s.user.name } : null });
  try {
    const file = await encodeBundle(bundle);
    return { ok: true, file, fileName: bundleFileName(profile), name: profile.name || "Campaign", counts: bundle.counts };
  } catch (e) {
    return { ok: false, error: e.message, tooLarge: true };
  }
}

async function importCampaignBundle(bundle, { from = "" } = {}) {
  const live = (await db.getAll("profiles")).filter((p) => !p.deletedAt);
  if (live.length >= MAX_PROFILES) return { ok: false, error: `You can track at most ${MAX_PROFILES} campaigns. Delete one, then import this again.` };
  const taken = new Set(live.map((p) => (p.name || "").trim().toLowerCase()));
  const base = (bundle.profile.name || "Shared campaign").trim();
  let name = base;
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = i === 1 ? `${base} (shared)` : `${base} (shared ${i})`;
  if (from && !(bundle.from && bundle.from.name)) bundle = { ...bundle, from: { name: from } };
  const out = readBundle(bundle, { name });
  for (const p of out.prompts) await db.put("trackedPrompts", p);
  for (const r of out.runs) await db.put("geoRuns", r);
  for (const r of out.raws) await db.put("raw", r);
  for (const r of out.records) await db.put("derived", r);
  // The campaign last, so a half-finished import never shows up as one.
  await db.put("profiles", out.profile);
  broadcast({ type: "capture-updated" });
  return { ok: true, profileId: out.profile.id, name: out.profile.name, counts: { prompts: out.prompts.length, runs: out.runs.length, answers: out.records.length } };
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === "update") repairOnce().catch((e) => logErr("repair", e));
  // An update or reload of the extension is the same browser session: its
  // tabs keep their ids. Chrome clears session storage all the same, so the
  // run's session nonce no longer matched and a run in flight was restored
  // as if the browser had restarted: its tabs forgotten, new ones opened on
  // Resume and the old ones left open (stress run, 23 Nov 2026, 1.0.4). The
  // new worker takes over the run's nonce. Not on "chrome_update": that is a
  // browser restart.
  if (details && details.reason === "update") adoptRunSessionNonce().catch((e) => logErr("adoptRunSessionNonce", e));
  syncSignup();
  // The version updated from (1.0.0): the guide starts with what changed for
  // people coming from before the redesign (ui/welcome.js).
  if (details && details.reason === "update" && details.previousVersion) chrome.storage.local.set({ citoUpdatedFrom: details.previousVersion }).catch(() => {});
  if (details && (details.reason === "install" || details.reason === "update")) openWelcomeOnce();
  // A run's own tabs are left alone (1.0.4): reloading them dropped the
  // question each was on ("page reloaded and lost the prompt"), and the run
  // loads its next question in them anyway, with the new scripts.
  const runTabs = new Set();
  chrome.storage.local.get(LOADER_STATE_KEY).then((got) => {
    const snap = got[LOADER_STATE_KEY];
    if (snap && snap.running) for (const pd of Object.values(snap.platforms || {})) for (const leg of legsOf(pd)) if (leg.tabId != null) runTabs.add(leg.tabId);
  }).catch(() => {}).finally(() => chrome.tabs.query({ url: AI_TAB_MATCHES }, (tabs) => {
    for (const t of tabs || []) {
      if (runTabs.has(t.id)) continue;
      try {
        chrome.tabs.reload(t.id);
      } catch (_) {
        /* tab may be discarded/closed */
      }
    }
  }));
  ensureHeartbeatAlarm();
});

/* ---------- The capture check (0.73.1) ----------
 * What happened on the way from an engine page to the store, per engine
 * (lib/captureHealth.js). Updates are chained so two arriving together
 * don't overwrite each other. */
const HEALTH_KEY = "lcfcCaptureHealth";
let healthChain = Promise.resolve();
function noteCapture(engine, e) {
  healthChain = healthChain.then(async () => {
    const got = await chrome.storage.local.get(HEALTH_KEY);
    await chrome.storage.local.set({ [HEALTH_KEY]: noteHealth(got[HEALTH_KEY], engine, e) });
  }).catch(() => {});
  // The same empty side request again and again is one note (shouldNoteDrop).
  if (e && e.kind === "drop" && shouldNoteDrop(lastDropNote, engine, e)) logEvent(`capture:drop:${engine}`, "capture", `capture not saved: ${e.reason}`, { platform: engine, reason: e.reason, path: e.path || "" });
  return healthChain;
}
const lastDropNote = new Map();
const MISSED_DISMISSED_KEY = "citoMissedDismissed";
const ENGINE_TAB_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.perplexity.ai/*", "https://perplexity.ai/*", "https://grok.com/*"];
// Each open engine tab, asked how capture stands there. No answer within
// 1.5 s means its script is cut off from the extension.
async function engineTabsHealth() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ENGINE_TAB_URLS }); } catch (_) { return []; }
  return Promise.all(tabs.map(async (t) => {
    const engine = platformFromUrl(t.url);
    const base = { tabId: t.id, engine, url: (() => { try { const u = new URL(t.url); return u.origin + u.pathname.replace(/\/[^/]{12,}/g, "/:id"); } catch (_) { return ""; } })(), discarded: !!t.discarded };
    if (t.discarded || t.status === "unloaded") return { ...base, alive: false, asleep: true };
    const reply = await new Promise((res) => {
      const timer = setTimeout(() => res(null), 1500);
      try {
        chrome.tabs.sendMessage(t.id, { type: "cs-ping" }, { frameId: 0 }, (r) => { clearTimeout(timer); void chrome.runtime.lastError; res(r || null); });
      } catch (_) { clearTimeout(timer); res(null); }
    });
    return reply && reply.ok ? { ...base, alive: true, ...reply, url: base.url } : { ...base, alive: false };
  }));
}

function platformFromUrl(url) {
  const u = String(url || "");
  if (/gemini\.google\.com|BardChatUi|StreamGenerate/i.test(u)) return "gemini";
  if (/perplexity\.ai|\/api\/sse\/query|\/api\/thread|\/rest\/queries/i.test(u)) return "perplexity";
  if (/grok\.com|x\.com\/i\/grok|app-chat\/conversations/i.test(u)) return "grok";
  if (/chatgpt\.com|chat\.openai\.com|backend-api/i.test(u)) return "chatgpt";
  // Google AI Mode (1.0.5): its page and its answer requests.
  if (/^https?:\/\/(?:www\.)?google\.[a-z.]+\/(?:search|async\/fol)/i.test(u)) return "aimode";
  return "chatgpt";
}

/* ---------- Capture ---------- */
const unreadableKindsLogged = new Set();

// The path of a captured request with ids folded to ":id" — which endpoint a
// payload came from, without the conversation it belongs to. Pages often
// request a relative path, so it's resolved against the page it came from.
function endpointShape(url, pageUrl) {
  try {
    return new URL(url, pageUrl || "https://page.invalid/").pathname
      .replace(/[0-9a-f][0-9a-f-]{15,}/gi, ":id").slice(0, 80);
  } catch (_) { return null; }
}

// What a payload is made of, never what it says: the gateway event types it
// carries, or the top-level keys of its JSON frames. Compact (no spaces) so
// the log's context filter keeps it.
function payloadShape(rawText) {
  const types = new Set();
  const keys = new Set();
  const lines = String(rawText || "").split(/\r?\n/).slice(0, 400);
  for (const line of lines) {
    let t = line.trim();
    if (t.startsWith("data:")) t = t.slice(5).trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.event && typeof o.event.type === "string") types.add(o.event.type);
      else if (o && typeof o === "object") Object.keys(o).slice(0, 6).forEach((k) => keys.add(k));
    } catch (_) { /* not one JSON object per line */ }
  }
  const out = types.size ? `types=${[...types].join(",")}` : keys.size ? `keys=${[...keys].join(",")}` : "unparsed";
  return out.replace(/\s+/g, "").slice(0, 120);
}

// Raw text past this is never read, whatever the stored-size setting: the
// copy alone would hold that much memory twice over.
const RAW_HARD_CAP_BYTES = 64 * 1024 * 1024;
const gzBytes = (gz) => (gz && typeof gz.byteLength === "number" ? gz.byteLength : 0);

async function storeCapture(payload, meta) {
  const platform = platformFromUrl(payload.pageUrl || payload.url);
  const settings = await getSettings();
  const rawText = payload.raw || "";

  // Gemini emits many small RPCs; only the assistant generation is substantial.
  // A copy read off the page (0.84.0) is the answer itself, however short.
  if (platform === "gemini" && rawText.length < 2000 && !isPageCopy(rawText)) return null;

  // Reject autocomplete, suggest, and navigation prediction requests (they are not answers).
  //
  // KEEP THIS IDENTICAL to NOISE_RE in content-main.js. Both files reject the
  // same shape of noise, but this file is a service-worker ES module and
  // content-main.js is a non-module IIFE injected into the page's MAIN world
  // at document_start — they cannot share a real import across that boundary,
  // so this is a second, independent copy rather than a shared constant.
  // test/interception-endpoints.test.mjs asserts the two copies are
  // byte-for-byte identical; a change to one without the other fails CI.
  if (/suggest\.perplexity\.ai|\/navigate\b|\/autocomplete\b|\/api\/auth|\/rest\/sse\/notifications\b/i.test(payload.url || "")) {
    return null;
  }

  // Perplexity background sidebar subscriptions shouldn't create dummy captures.
  if (rawText.includes("SidebarRecentThreadsUpdatesRelaySubscription") && !rawText.includes('"web_results"') && !rawText.includes('"sources"') && !rawText.includes('"chunks"')) {
    return null;
  }

  // Guard against pathological payloads (Gemini local/map answers have been seen
  // at 25MB raw / ~5MB stored). Without a cap the store grows ~1GB per 1k captures.
  // The cap is on what is stored, the compressed copy (0.79.0). Signed-out
  // ChatGPT answers arrive as 5–8 MB of mostly page markup that compresses
  // tenfold; capped on raw length, the longest of them were dropped whole,
  // and their campaign turns then timed out with the answer on screen.
  const capBytes = Math.max(1, settings.maxCaptureMB) * 1024 * 1024;
  if (rawText.length > RAW_HARD_CAP_BYTES) {
    return { skipped: "too-large", bytes: rawText.length };
  }
  const gz = await gzipString(rawText);
  if (gzBytes(gz) > capBytes) {
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
    session: (meta && meta.session) || null, // private window / signed in (0.66.0)
    // The question as the page showed it (1.0.0; content-iso pagePromptNow),
    // kept on the raw row so Reprocess reads it the same way.
    pagePrompt: typeof payload.pagePrompt === "string" ? payload.pagePrompt.slice(0, 4000) : null,

    gz,
    rawSchema: 1,
  };
  try { await db.put("raw", rawRow); } catch (e) { if (isQuota(e)) { pauseForStorage(e); return { ok: false, error: "storage full" }; } throw e; }

  // Not yet merged with other copies of this answer: a campaign capture is
  // judged and attributed on its own first (rejectCapture, attributeGeo),
  // then settled.
  let record = await deriveAndStore(rawRow, rawText, settings, { settle: false });

  // A campaign capture the adapter could read nothing from is dropped by
  // deriveAndStore as 0-signal — and until now that was silent. It is how
  // every Grok answer vanished once grok.com moved chat onto a WebSocket
  // gateway this adapter didn't know: captured, dropped, never logged, and
  // the turn reported only as a timeout. The entry names the payload's shape
  // (event types or top-level keys, never values) and keeps its id, so the
  // diagnostics export can include the payload itself.
  if (!record && meta && meta.runId) {
    const endpoint = endpointShape(payload.url, payload.pageUrl);
    const shape = payloadShape(rawText);
    // Once per kind per run: a real run logged ~80 identical Perplexity
    // entries, which pushed everything else out of the 200-entry capture log.
    const kind = `${meta.runId}|${platform}|${endpoint}|${shape}`;
    if (!unreadableKindsLogged.has(kind)) {
      unreadableKindsLogged.add(kind);
      if (unreadableKindsLogged.size > 500) unreadableKindsLogged.clear();
      logEvent(`capture:unreadable:${platform}`, "capture", "the adapter found no prompt, answer or sources in this payload", {
        platform,
        runId: meta.runId,
        captureId,
        transport: payload.transport || null,
        bytes: rawText.length,
        endpoint,
        shape,
      });
    }
    if (typeof meta.onUnreadable === "function") meta.onUnreadable(shape);
  }

  // Some campaign captures can only be judged once the adapter has read them
  // (see isUnusableCampaignPreview). A rejected one is removed outright and
  // the reason logged, so the diagnostics export shows what was dropped and
  // why rather than it silently never having existed.
  if (record && meta && typeof meta.rejectCapture === "function") {
    const reason = meta.rejectCapture(record);
    if (reason) {
      await db.delete("derived", captureId);
      await db.delete("raw", captureId);
      logEvent(`capture:discarded:${record.platform}`, "capture", reason, {
        platform: record.platform, runId: (meta && meta.runId) || null,
      });
      return null;
    }
  }

  // Which prompt a campaign capture answers can only be read off the capture
  // itself, and its question text doesn't exist until the adapter has run —
  // so meta.geo arrives as a guess from the tab's position and is corrected
  // here. The raw row is rewritten too: reprocessing rebuilds geo from it,
  // and would otherwise quietly restore the wrong prompt. Done on this
  // capture alone, before it merges with other copies of its answer, so
  // every raw copy carries its own corrected prompt.
  if (record && record.geo && meta && typeof meta.attributeGeo === "function") {
    const fixed = meta.attributeGeo(record);
    if (fixed && fixed.promptId !== record.geo.promptId) {
      record.geo = { ...record.geo, promptId: fixed.promptId, tags: fixed.tags };
      rawRow.geo = record.geo;
      await db.put("raw", rawRow);
      await db.put("derived", record);
    }
  }

  if (record) record = await settleSameAnswer(record);

  // Not awaited (0.79.0): with a full store it scans every capture, and a
  // campaign turn waited on it before it could move on. It never removes the
  // capture just stored.
  enforceRetention(settings, record ? record.captureId : captureId).catch(() => {});
  // A copy of an answer already stored is merged into that record, which
  // keeps its id; that is the capture the panel should show. `isNew` says
  // whether this was an answer not stored before (1.0.0: the "captured"
  // notice went up for every page request saved, answer or not).
  return { captureId: record ? record.captureId : captureId, record, isNew: !!record && record.captureId === captureId };
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
    // 0.74.0: one on-device model per capture. With the built-in AI set up
    // (Chrome's model or Qwen) its queue reads the brands; and nothing runs
    // beside a campaign's tabs.
    if (loader && loader.running) return;
    if (await aiSvc.engine(await aiSvc.getState())) return;
    // Each adapter counts mentions against its own cleaned text; match that
    // here so the AI merge verifies names against the same string.
    const plain = record.platform === "chatgpt"
      ? cleanPassage(record.answerText)
      : record.answerText;
    // Two independent on-device passes. The first decides WHICH brands are
    // present; the second annotates how the answer treats each one. Either
    // can come back null (no model, or nothing useful) without affecting the
    // other, and the record is only rewritten if at least one produced
    // something — so a device without Gemini Nano ends up byte-identical to
    // one that never ran this at all.
    const improved = await enrichBrandsWithAI(record.brandMentions || [], plain, record.userPrompt);
    const withStance = await enrichBrandStance(improved || record.brandMentions || [], plain, record.userPrompt);
    const finalBrands = withStance || improved;
    if (!finalBrands) return;

    // Re-read rather than reusing the in-memory copy: a reprocess or a delete
    // may have landed while the model was thinking.
    const current = await db.get("derived", record.captureId);
    if (!current) return;
    // 0.70.0: Nano's names no longer go into the counts directly (that made
    // share of voice differ between a computer with Nano and one without,
    // and Reprocess erased it). They are kept as an AI check, put back on
    // every derive, and join the counts only with "Let the AI correct brands in
    // counts" on.
    const have = new Set((record.brandMentions || []).map((m) => String(m.brand || "").toLowerCase()));
    const added = finalBrands.filter((m) => !have.has(String(m.brand || "").toLowerCase()));
    const stances = new Map(finalBrands.filter((m) => m.stance).map((m) => [m.brand, m.stance]));
    if (!(await aiSvc.saveNano(current, { added, stances }))) return;
    await aiSvc.attach(current);
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

// The answer's language, from Chrome's own detector (0.70.0); no model needed.
async function detectAnswerLang(record) {
  const text = String(record.answerText || "").slice(0, 4000);
  if (text.trim().length < 20 || !chrome.i18n || !chrome.i18n.detectLanguage) return null;
  try {
    const r = await chrome.i18n.detectLanguage(text);
    const top = r && r.languages && r.languages[0];
    if (top && top.language && top.language !== "und" && (r.isReliable || top.percentage >= 60)) return top.language;
  } catch (_) { /* not available */ }
  return null;
}

const withTimeout = (p, ms, fallback) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(fallback), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
});

async function deriveAndStore(rawRow, rawText, settings, { settle = true } = {}) {
  const raw = rawText ?? (await gunzipToString(rawRow.gz));
  const cfg = settings || (await getSettings());
  // An answer read off the page (0.84.0, adapters/pageCopy.js): one shape
  // for every engine, whatever its network format is this week.
  const adapter = isPageCopy(raw) ? adaptPageCopy : ADAPTERS[rawRow.platform] || ADAPTERS.chatgpt;
  const record = await adapter(
    {
      captureId: rawRow.captureId,
      raw,
      url: rawRow.url,
      reqBody: rawRow.reqBody,
      capturedAt: rawRow.capturedAt,
      pageUrl: rawRow.pageUrl,
    },
    { tracked: trackedFrom(cfg) }
  );
  record.projectId = rawRow.projectId || null;
  record.runId = rawRow.runId || null;
  record.geo = rawRow.geo || null;
  if (rawRow.session) record.session = rawRow.session;

  // Don't store 0-signal captures (empty autocomplete, failed navigation, etc.)
  if (!record.userPrompt && !record.answerChars && (!record.sources || !record.sources.length)) {
    return null;
  }
  // A Gemini stream handed over before the answer began (0.69.0): only its
  // "Searching the web" frames had come when the stream went quiet. It is no
  // answer yet; the next hand-over brings it. Stored, it was an empty answer
  // that finished the campaign turn.
  if (record.platform === "gemini" && (record.platformSpecific || {}).transport === "webchannel" && !record.answerChars) {
    return null;
  }
  // The same for ChatGPT signed out (1.0.0): its stream is handed over while
  // it still says "Searching the web", then again with the answer. The owner's
  // private-window campaign of 15 Nov 2026 kept 11 of those first copies as
  // empty answers beside the real ones (the real copy is keyed by its reply
  // id, the empty one has none, so they weren't joined). A limit is kept.
  if (record.platform === "chatgpt" && (record.platformSpecific || {}).transport === "conversation-source"
    && !record.answerChars && !(record.sources || []).length && !(record.platformSpecific || {}).gatewayError) {
    return null;
  }
  // No question in the engine's own request: the one the page showed, once
  // there is an answer (so it can never turn an empty capture into a record).
  if (!record.userPrompt && rawRow.pagePrompt && record.answerChars) {
    // A question read twice over ("Q\n\nQ": Gemini's hidden "You said Q"
    // heading before Q, read by builds up to 1.0.1) is the question once, so
    // Reprocess all repairs what those builds stored.
    const p = cleanPrompt(rawRow.pagePrompt);
    const twice = typeof p === "string" && p.match(/^([\s\S]{3,}?)\s*\n\s*\n\s*([\s\S]+)$/);
    record.userPrompt = twice && twice[1].trim() === twice[2].trim() ? twice[1].trim() : p;
    if (record._extraction && Array.isArray(record._extraction.notes)) record._extraction.notes.push("prompt: read off the page; the engine's request didn't carry it");
  }

  await attachPages(record);
  await attachInteractions(record);
  // Neither may hold the record back (0.73.1): each gets 3 s, then the
  // record is saved without it.
  const lang = await withTimeout(detectAnswerLang(record), 3000, null);
  if (lang) record.answerLang = lang;
  // The built-in AI's stored check, put back on every derive and Reprocess
  // without running the model (0.70.0).
  await withTimeout(aiSvc.attach(record).catch(() => {}), 3000, null);
  await db.put("derived", record);
  return settle ? settleSameAnswer(record) : record;
}

/* ------------------------------------------------------------------
 * The cited pages, read (0.62.0). Only with "Read the cited pages" on, and
 * only the pages an answer cited: fetched as the browser would, turned into
 * readable text in the offscreen document (Mozilla Readability), and kept
 * in the "pages" store. A page that comes back as a wall or an empty
 * JavaScript shell is opened once in a hidden tab and read from there. The
 * record carries what was found (status, words, the brands the text names)
 * and gets it back on every reprocess from the stored text.
 * ------------------------------------------------------------------ */
const PAGE_FETCH_MS = 10000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;

async function attachPages(record) {
  const urls = citedUrls(record);
  if (!urls.length) return;
  let read = 0;
  for (const s of record.sources || []) {
    if (s.outcome !== "cited" || !s.url) continue;
    const row = await db.get("pages", s.url.replace(/#.*$/, "")).catch(() => null);
    if (!row) continue;
    s.platformSpecific = { ...(s.platformSpecific || {}), page: pageSummary(row, record) };
    if (row.status === "ok") read++;
  }
  const tried = (record.sources || []).filter((s) => s.platformSpecific && s.platformSpecific.page).length;
  if (tried) record.pagesRead = { read, tried, cited: urls.length };
}

/* What ChatGPT loaded after an answer (0.62.0, content-main.js): a product
 * card's stores, seen only when someone opens the card. Stored per reply and
 * put back on the record on every derive. */
// The network recorder's ring (0.62.0). Session storage, not IndexedDB: it
// is diagnostics for the report, cleared when the browser closes, and never
// part of a capture. Appends are chained so two tabs' batches arriving
// together can't overwrite each other.
const NETLOG_KEY = "lcfcNetlog";
let netlogChain = Promise.resolve();
async function netlogLoad() {
  try { const got = await chrome.storage.session.get(NETLOG_KEY); return got[NETLOG_KEY] || []; } catch (_) { return []; }
}
function netlogAppend(entries) {
  if (!entries.length) return netlogChain;
  netlogChain = netlogChain.then(async () => {
    const ring = appendRing(await netlogLoad(), entries);
    await chrome.storage.session.set({ [NETLOG_KEY]: ring });
  }).catch((e) => logErr("netlog", e));
  return netlogChain;
}

/* ChatGPT's own requests, seen by the browser (1.0.4, Debug capture only).
 * The page hook only sees requests made through the page's fetch. On some
 * accounts ChatGPT shows a question at /c/local-… and no send is ever seen
 * there, so whether the send left the tab at all (and what came back) was
 * unknowable. chrome.webRequest sees every request the tab makes. It is an
 * optional permission, asked for when Debug capture is turned on, so an
 * update asks nobody for anything; and it only reads, method, path (ids
 * masked), status and error, into the same ring as the page's entries. */
const WEBREQUEST_FILTER = { urls: ["https://chatgpt.com/backend-api/*"] };
let webRequestArmed = false;
async function armWebRequestLog() {
  if (webRequestArmed || !chrome.webRequest || !chrome.webRequest.onCompleted) return;
  webRequestArmed = true;
  const note = async (d, error) => {
    if (!(await getSettings()).debugCapture) return;
    let u; try { u = new URL(d.url); } catch (_) { return; }
    netlogAppend([cleanEntry({ t: d.timeStamp, page: "chatgpt.com", kind: "webRequest", method: d.method, host: u.host, path: u.pathname, status: error ? 0 : d.statusCode, type: error ? `error: ${error}`.slice(0, 60) : d.type })]);
  };
  chrome.webRequest.onCompleted.addListener((d) => { note(d).catch(() => {}); }, WEBREQUEST_FILTER);
  chrome.webRequest.onErrorOccurred.addListener((d) => { note(d, d.error || "failed").catch(() => {}); }, WEBREQUEST_FILTER);
}
armWebRequestLog().catch(() => {});
chrome.permissions?.onAdded?.addListener(() => { armWebRequestLog().catch(() => {}); });

// Gemini replies kept as probes (0.62.1, Debug capture only; content-main.js
// GEMINI_PROBE_RE): the newest 20, in session storage, never derived into an
// answer. "Payloads it couldn't read" in About saves them for the owner to
// send, so a reader for Gemini's new traffic can be written from the real
// shape.
const PROBE_KEY = "lcfcProbes";
let probeChain = Promise.resolve();
async function probesLoad() {
  try { const got = await chrome.storage.session.get(PROBE_KEY); return got[PROBE_KEY] || []; } catch (_) { return []; }
}
function probeAppend(p) {
  probeChain = probeChain.then(async () => {
    const list = (await probesLoad()).concat([{ at: p.at || Date.now(), url: String(p.url || "").slice(0, 2000), method: String(p.method || ""), pageUrl: String(p.pageUrl || "").slice(0, 500), reqBody: String(p.reqBody || "").slice(0, 50000), body: String(p.body || "").slice(0, 300000) }]);
    await chrome.storage.session.set({ [PROBE_KEY]: list.slice(-20) });
  }).catch((e) => logErr("probe", e));
  return probeChain;
}

async function attachInteractions(record) {
  const rows = await db.getAllByIndex("interactions", "captureId", record.captureId).catch(() => []);
  if (!rows.length) return;
  rows.sort((a, b) => a.at - b.at);
  const products = (record.products || []).map((p) => ({ ...p }));
  let formChoices = null;
  record.interactions = rows.map((r) => {
    const kind = /\/search\/product_update/.test(r.path) ? "stores" : /\/sidebar\/conversation/.test(r.path) ? "panel" : /\/dil\/view_state/.test(r.path) ? "form" : /\/bazaar\//.test(r.path) ? "ads" : "other";
    const row = { id: r.id, at: r.at, path: r.path, status: r.status, kind, offers: 0, cards: 0 };
    if (kind === "stores") {
      // What the card's lookup returned, kept on the card it was opened
      // from (matched by its listing id, then the name it was opened with).
      const u = productUpdateFrom(r.body, r.reqBody);
      const i = cardIndexFor(products, { ids: u.lookupIds, name: u.query });
      if (i >= 0 && u.products.length) {
        const got = u.products[0];
        products[i] = { ...products[i], opened: { at: r.at, query: u.query, ...got } };
        row.cards = attachOffers(products, [{ id: null, title: products[i].name, offers: got.offers.map((o) => ({ merchant: o.merchant, price: o.price, url: o.url, availability: o.available === false ? "Out of stock" : o.details, delivery: null, tag: o.tag })) }]);
        row.offers = got.offers.length;
      }
    } else if (kind === "panel") {
      const pnl = productPanelFrom(r.body, r.reqBody);
      const i = cardIndexFor(products, { name: pnl.name });
      if (i >= 0 && (pnl.rationale || pnl.reviews.length)) {
        products[i] = { ...products[i], panel: { at: r.at, rationale: pnl.rationale, summary: pnl.summary, reviews: pnl.reviews, pages: pnl.pages } };
        row.cards = 1;
      }
    } else if (kind === "form") {
      formChoices = formChoicesFrom(r.reqBody) || formChoices;
    } else {
      let json = null;
      try { json = JSON.parse(r.body); } catch (_) { /* not JSON after all */ }
      const found = json ? offersFrom(json) : [];
      row.cards = attachOffers(products, found, { path: r.path });
      row.offers = found.reduce((n, f) => n + f.offers.length, 0);
    }
    return row;
  });
  record.products = products;
  if (formChoices) record.followUpChoices = formChoices;
}

/* Which answer something loaded after it belongs to. A product panel names
 * its message (and conversation) in the request; that is matched against
 * the assistant messages each record keeps (platformSpecific.messageIds).
 * Otherwise: the latest ChatGPT answer in the page's conversation from
 * before it, within a week (cards get opened when someone comes back). */
async function recordForInteraction(p) {
  let req = {};
  try { req = JSON.parse(p.reqBody || "{}"); } catch (_) { /* not JSON */ }
  const fromPath = (/\/conversation\/([0-9a-f][0-9a-f-]{7,})\/message\/([0-9a-f][0-9a-f-]{7,})\//i.exec(p.path || "") || []);
  const conv = (typeof req.conversation_id === "string" && req.conversation_id) || fromPath[1] || (/\/c\/([0-9a-f][0-9a-f-]{7,})/i.exec(p.pageUrl || "") || [])[1];
  const msg = (typeof req.message_id === "string" && req.message_id) || fromPath[2] || null;
  if (!conv) return { conv: null, rec: null };
  const recs = (await db.getAllByIndex("derived", "conversationId", conv).catch(() => [])).filter((r) => r.platform === "chatgpt");
  if (msg) {
    const exact = recs.find((r) => ((r.platformSpecific && r.platformSpecific.messageIds) || []).includes(msg));
    if (exact) return { conv, rec: exact };
  }
  const at = p.at || Date.now();
  const rec = recs.filter((r) => at - r.capturedAt < 7 * 24 * 3600 * 1000 && at >= r.capturedAt - 5000).sort((a, b) => b.capturedAt - a.capturedAt)[0];
  return { conv, rec: rec || null };
}

async function onPageInteraction(p) {
  const { conv, rec } = await recordForInteraction(p);
  if (!conv) return { ok: false, reason: "no conversation" };
  if (!rec) return { ok: false, reason: "no capture of this conversation" };
  const at = p.at || Date.now();
  const id = `${rec.captureId}:${at}:${Math.random().toString(36).slice(2, 8)}`;
  await db.put("interactions", { id, captureId: rec.captureId, conversationId: conv, at, path: p.path, method: p.method, status: p.status, body: String(p.body || "").slice(0, 2000000), reqBody: String(p.reqBody || "").slice(0, 200000) });
  const current = await db.get("derived", rec.captureId);
  if (!current) return { ok: false };
  await attachInteractions(current);
  await db.put("derived", current);
  try { chrome.runtime.sendMessage({ type: "capture-updated", captureId: rec.captureId }, () => void chrome.runtime.lastError); } catch (_) {}
  return { ok: true, captureId: rec.captureId };
}

let offscreenReady = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error("no offscreen API");
  // The page closes itself when idle (0.74.0, ui/offscreen.js), which frees
  // the AI model's memory; then it is opened again here on demand.
  if (offscreenReady && chrome.runtime.getContexts) {
    try { if (!(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) offscreenReady = null; } catch (_) { /* keep */ }
  }
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = chrome.runtime.getContexts ? (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0 : false;
    if (!has) await chrome.offscreen.createDocument({ url: "ui/offscreen.html", reasons: ["DOM_PARSER"], justification: "Read the text of the pages an answer cited" });
  })();
  try { await offscreenReady; } catch (e) { offscreenReady = null; throw e; }
  return offscreenReady;
}
// Close and reopen the offscreen document (0.70.0): the AI runtime there
// can't change from the graphics chip to the processor once it has tried.
async function resetOffscreen() {
  try { if (chrome.offscreen && chrome.offscreen.closeDocument) await chrome.offscreen.closeDocument(); } catch (_) { /* none open */ }
  offscreenReady = null;
  await ensureOffscreen();
}
// Firefox and Safari have no offscreen documents; there the background is a
// page (scripts/build-firefox.mjs) that loads ui/offscreen.js itself, and
// its functions are called directly (0.72.0).
const inPage = () => !chrome.offscreen && globalThis.citoOffscreen;
async function extractPage(html, url) {
  if (inPage()) return { ok: true, ...globalThis.citoOffscreen.extract(html, url) };
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "extract-page", html, url });
  if (!r || !r.ok) throw new Error((r && r.error) || "no reply from the page reader");
  return r;
}

async function fetchPage(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_FETCH_MS);
  try {
    const res = await fetch(url, { credentials: "omit", redirect: "follow", signal: ctl.signal });
    // A public address can answer with a redirect to a private one; what
    // came back from there is not kept (0.84.1).
    if (res.url && !isPublicHttpUrl(res.url)) return { status: "failed", error: "redirected to a private address" };
    const type = res.headers.get("content-type") || "";
    if (!res.ok) return { status: "failed", httpStatus: res.status };
    if (!/html|xml|text\/plain/i.test(type)) return { status: "not-html", httpStatus: res.status };
    const len = Number(res.headers.get("content-length") || 0);
    if (len > PAGE_MAX_BYTES) return { status: "too-large", httpStatus: res.status };
    const html = (await res.text()).slice(0, PAGE_MAX_BYTES);
    const page = await extractPage(html, res.url || url);
    return { status: pageVerdict(page), httpStatus: res.status, ...page };
  } catch (e) {
    return { status: "failed", error: String((e && e.name === "AbortError") ? "timed out" : (e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// One hidden tab at a time: a page that only fills in with JavaScript, or
// sits behind a check that a real browser passes. Needs the site access the
// setting asked for (scripting a page needs host permission).
let tabReadChain = Promise.resolve();
function readInTab(url) {
  const run = async () => {
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_) {}
      await new Promise((resolve) => {
        const done = setTimeout(resolve, 15000);
        const on = (id, info) => { if (id === tabId && info.status === "complete") { clearTimeout(done); chrome.tabs.onUpdated.removeListener(on); setTimeout(resolve, 1500); } };
        chrome.tabs.onUpdated.addListener(on);
      });
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, text: document.body ? document.body.innerText : "", lang: document.documentElement.lang || null }) });
      const page = (res && res.result) || { title: "", text: "" };
      page.text = String(page.text || "").slice(0, 200000);
      return { status: pageVerdict(page), method: "tab", ...page };
    } catch (e) {
      return { status: "failed", method: "tab", error: String((e && e.message) || e) };
    } finally {
      if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
    }
  };
  const p = tabReadChain.then(run, run);
  tabReadChain = p.catch(() => {});
  return p;
}

/*
 * 0.84.1, from the 10 Nov 2026 security audit. Two limits on what is read:
 *
 *   - Public sites only (lib/safeUrl.js). citedUrls already leaves private
 *     addresses out; this is the same check where the reading happens, so
 *     no other caller can skip it.
 *   - The hidden-tab reading only when the person asked for this answer's
 *     pages themselves (`manual`: the "Read pages" button). The plain fetch
 *     sends no cookies; a tab is the user's own browser, signed in to
 *     whatever they are signed in to. Run automatically on every capture, a
 *     cited address that points at a signed-in page (webmail, a dashboard)
 *     would have had that page's text saved here and carried into exports
 *     and shared campaigns, with nobody having chosen to open it.
 */
async function readOnePage(url, { force = false, manual = false } = {}) {
  if (!isPublicHttpUrl(url)) return { url, fetchedAt: Date.now(), status: "failed", method: "fetch", httpStatus: null, title: "", lang: null, words: 0, text: "", error: "not a public address" };
  const cached = await db.get("pages", url).catch(() => null);
  if (!force && cached && cached.status === "ok" && Date.now() - (cached.fetchedAt || 0) < PAGE_TTL_MS) return cached;
  let page = await fetchPage(url);
  let method = "fetch";
  if (page.status === "blocked" || page.status === "thin" || page.status === "failed") {
    const canScript = manual && !!(chrome.scripting && (await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false)));
    if (canScript) {
      const viaTab = await readInTab(url);
      if (viaTab.status === "ok" || (page.status !== "ok" && wordCount(viaTab.text) > wordCount(page.text))) { page = viaTab; method = "tab"; }
    }
  }
  const row = {
    url, fetchedAt: Date.now(), status: page.status, method: page.method === "tab" ? "tab" : method,
    httpStatus: page.httpStatus || null, title: page.title || "", lang: page.lang || null,
    words: wordCount(page.text), text: page.status === "ok" ? page.text : "", error: page.error || null,
  };
  await db.put("pages", row);
  return row;
}

// Three pages at a time; the record is rewritten once, when all are read.
const pagesInFlight = new Set();
async function readCitedPages(captureId, { force = false, manual = false } = {}) {
  if (pagesInFlight.has(captureId)) return { ok: true, busy: true };
  const settings = await getSettings();
  if (!settings.readCitedPages && !manual) return { ok: false, off: true };
  const rec = await db.get("derived", captureId);
  if (!rec) return { ok: false, error: "no such capture" };
  const urls = citedUrls(rec);
  if (!urls.length) return { ok: true, read: 0, tried: 0 };
  pagesInFlight.add(captureId);
  try {
    const queue = [...urls];
    const work = async () => { while (queue.length) { const u = queue.shift(); try { await readOnePage(u, { force, manual }); } catch (e) { logErr("pages", e, { url: u.slice(0, 120) }); } } };
    await Promise.all([work(), work(), work()]);
    const current = await db.get("derived", captureId);
    if (!current) return { ok: false, error: "capture removed" };
    await attachPages(current);
    await db.put("derived", current);
    try { chrome.runtime.sendMessage({ type: "capture-updated", captureId }, () => void chrome.runtime.lastError); } catch (_) {}
    return { ok: true, ...(current.pagesRead || {}) };
  } finally {
    pagesInFlight.delete(captureId);
  }
}

/* One answer, one record (lib/sameAnswer.js). Another copy of this answer
 * captured within a few minutes (same reply id, or same conversation,
 * question and opening words) is merged with this one into a single record
 * under the earliest copy's id; the copies it absorbed are dropped from
 * "derived". Every raw copy stays, so a reprocess rebuilds the same merge,
 * and deleting or pruning the record removes them with it (dropCapture). */
async function settleSameAnswer(record) {
  const key = answerKey(record);
  if (!key || !record.capturedAt) return record;
  // A reply id joins copies however far apart (lib/sameAnswer.js).
  const span = /\|(?:reply|turn):/.test(key) ? SAME_REPLY_WINDOW_MS : SAME_ANSWER_WINDOW_MS;
  const near = await db.getByTimeRange("derived", record.capturedAt - span, record.capturedAt + span);
  const same = near.filter((r) => r.captureId !== record.captureId && sameAnswer(r, record));
  if (!same.length) return record;
  const merged = mergeAnswers([...same, record]);
  for (const r of [...same, record]) if (r.captureId !== merged.captureId) await db.delete("derived", r.captureId);
  await db.put("derived", merged);
  return merged;
}

// A record and every raw copy it holds (see settleSameAnswer).
async function dropCapture(captureId) {
  const rec = await db.get("derived", captureId);
  for (const id of [captureId, ...((rec && rec.mergedFrom) || [])]) await db.delete("raw", id);
  await db.delete("derived", captureId);
  // What loaded after the answer goes with it (0.62.0). Read pages stay:
  // they belong to the address, and other answers cite the same pages.
  for (const row of await db.getAllByIndex("interactions", "captureId", captureId).catch(() => [])) await db.delete("interactions", row.id);
}

// Keep the store bounded: prune the oldest AD-HOC captures beyond the
// retention limit. Campaign captures are never pruned — see
// isPrunableCapture() in lib/geo.js for why (short version: pruning by age
// alone made a large campaign run delete its own earlier results once the
// store filled, so prompts went missing and it looked like a capture bug).
async function enforceRetention(settings, keepId) {
  const cfg = settings || (await getSettings());
  const limit = Math.max(50, cfg.retentionMax || DEFAULT_SETTINGS.retentionMax);
  const count = await db.count("derived");
  if (count <= limit) return;
  // The cap counts manual captures only (retentionVictims, 0.73.1).
  const prunable = await db.getOldestPrunableKeys("derived", Number.MAX_SAFE_INTEGER, isPrunableCapture);
  for (const id of retentionVictims(prunable, limit, keepId)) await dropCapture(id);
}

// Re-derive every stored capture. Uses a cursor + chunking so a large store
// doesn't pull every gzipped blob into memory at once (SW OOM risk).
/* Once, on updating to 0.62.1: re-derive every stored capture, so page-text
 * copies already stored as answers of their own (Grok's "Youbest good
 * quality…") fold into the network capture of the same reply, and the
 * Dashboard counts each question once. Raw copies are all kept. */
const REPAIR_KEY = "lcfcRepaired0621";
const REPAIR_KEY_0781 = "lcfcRepaired0781";
// 0.79.0: signed-out ChatGPT answers keep their lines (adaptSource), so their
// lists and headings reach brand detection: read once more on update.
// 0.80.0: and once more, for their products, places and pictures, on
// installs that already ran the 0.79.0 pass.
const REPAIR_KEY_0790 = "lcfcRepaired0800";
// 1.0.0: ChatGPT answers copied off the page before 16 Nov 2026 wrote card
// titles as "**1.****Titan Eye+**" and missed their brands; read once more.
const REPAIR_KEY_PAGECOPY = "lcfcRepaired100pc";
async function repairOnce() {
  const got = await chrome.storage.local.get([REPAIR_KEY, REPAIR_KEY_0781, REPAIR_KEY_0790]);
  if (!got || !got[REPAIR_KEY]) {
    await reprocessAll();
    await chrome.storage.local.set({ [REPAIR_KEY]: Date.now(), [REPAIR_KEY_0781]: Date.now(), [REPAIR_KEY_0790]: Date.now() });
    return;
  }
  if (!got[REPAIR_KEY_0781] || !got[REPAIR_KEY_0790]) {
    await reprocessSignedOutChatGpt().catch((e) => logErr("repair:0790", e));
    await chrome.storage.local.set({ [REPAIR_KEY_0781]: Date.now(), [REPAIR_KEY_0790]: Date.now() });
  }
  const pc = await chrome.storage.local.get(REPAIR_KEY_PAGECOPY);
  if (!pc || !pc[REPAIR_KEY_PAGECOPY]) {
    await reprocessChatGptPageCopies().catch((e) => logErr("repair:pagecopy", e));
    await chrome.storage.local.set({ [REPAIR_KEY_PAGECOPY]: Date.now() });
  }
}

async function reprocessChatGptPageCopies() {
  const settings = await getSettings();
  let n = 0;
  for (const id of await db.getAllKeys("raw")) {
    try {
      const row = await db.get("raw", id);
      if (!row || row.platform !== "chatgpt" || row.transport !== "page-copy") continue;
      await deriveAndStore(row, undefined, settings);
      n++;
    } catch (_) { /* keep going */ }
  }
  logEvent("repair:chatgpt-page-copy", "capture", `read ${n} ChatGPT page copies again`, { count: n });
  return n;
}

/* 0.78.1: signed-out ChatGPT captures read again. Until now ChatGPT's
 * "Message limit reached" card was stored as an answer (39% of the owner's
 * signed-out ChatGPT captures), and every signed-out capture had no prompt.
 * Read again, the card is a refusal with no answer (left out of the numbers,
 * listed as "usage limit") and every capture gets its prompt back. */
async function reprocessSignedOutChatGpt() {
  const settings = await getSettings();
  let n = 0;
  for (const id of await db.getAllKeys("raw")) {
    try {
      const row = await db.get("raw", id);
      if (!row || row.platform !== "chatgpt" || !/\/unauth-mweb\/conversation\/updates\b/.test(row.url || "")) continue;
      await deriveAndStore(row, undefined, settings);
      n++;
    } catch (_) { /* keep going */ }
  }
  logEvent("repair:signed-out-chatgpt", "capture", `read ${n} signed-out ChatGPT captures again`, { count: n });
  return n;
}

async function reprocessAll() {
  const settings = await getSettings();
  // Oldest first, so copies of one answer merge in the order they arrived
  // (a row without a capture time isn't in that index; it goes last).
  const timed = await db.getAllKeysSortedByTime("raw", Number.MAX_SAFE_INTEGER);
  const seen = new Set(timed);
  const ids = [...timed, ...(await db.getAllKeys("raw")).filter((k) => !seen.has(k))];
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

// The built-in AI (0.70.0, src/aiService.js): the model runs in the
// offscreen document; this keeps its queue, results and state.
const broadcast = (m) => { try { chrome.runtime.sendMessage(m, () => void chrome.runtime.lastError); } catch (_) { /* no page open */ } };
const aiSvc = createAiService({ db, getSettings, ensureOffscreen, resetOffscreen, logErr: (w, e, c) => logErr(w, e, c), broadcast, isBusy: () => !!(loader && loader.running) });
// The "capture" (network-trace breadcrumbs, replacing the old in-memory
// DEBUG ring buffer) and "turn" (per-prompt outcome history, previously
// only visible in the live progress view) categories of the same durable
// log — see lib/errorlog.js's header for why these were folded in here
// instead of staying three disconnected mechanisms.
const logEvent = (where, cat, message, ctx) => { try { errorLog.recordEvent(where, cat, message, ctx); } catch (_) {} };

const LOADER_STATE_KEY = "lcfcLoaderState";
const HEARTBEAT_ALARM = "lcfcHeartbeat";
const DURATION_WINDOW = 10; // per-platform rolling window of turn durations, for Phase 2's ETA

// A value that exists only for the CURRENT browser session — chrome.storage
// .session is wiped by Chrome on every browser restart, unlike storage.local
// (which the loader snapshot itself uses, deliberately, so a run can survive
// one — see persistLoaderState below). Comparing a persisted snapshot's nonce
// against this one is how resumeFromSnapshot tells "the service worker
// restarted within the same browser session" (safe — the snapshot's tabIds
// are still valid) from "the browser itself restarted" (unsafe — Chrome
// reassigns tab ids from scratch, and a persisted id can silently resolve to
// a completely unrelated tab that happens to inherit it; chrome.tabs.get
// resolving without throwing is not proof the tab is still ours).
const SESSION_NONCE_KEY = "lcfcSessionNonce";
let sessionNonceCache = null;
// After an extension update/reload (see onInstalled): the run's own nonce,
// when this session hasn't been given one yet by anything else.
async function adoptRunSessionNonce() {
  const snap = (await chrome.storage.local.get(LOADER_STATE_KEY))[LOADER_STATE_KEY];
  if (!snap || !snap.running || !snap.sessionNonce) return;
  const got = await chrome.storage.session.get(SESSION_NONCE_KEY);
  if (got[SESSION_NONCE_KEY] && got[SESSION_NONCE_KEY] !== sessionNonceCache) return;
  if (sessionNonceCache && sessionNonceCache !== snap.sessionNonce && loader.running) return; // already restored
  await chrome.storage.session.set({ [SESSION_NONCE_KEY]: snap.sessionNonce });
  sessionNonceCache = snap.sessionNonce;
}
async function ensureSessionNonce() {
  if (sessionNonceCache) return sessionNonceCache;
  try {
    const got = await chrome.storage.session.get(SESSION_NONCE_KEY);
    if (got[SESSION_NONCE_KEY]) {
      sessionNonceCache = got[SESSION_NONCE_KEY];
      return sessionNonceCache;
    }
    const fresh = crypto.randomUUID();
    await chrome.storage.session.set({ [SESSION_NONCE_KEY]: fresh });
    sessionNonceCache = fresh;
    return fresh;
  } catch (err) {
    logErr("ensureSessionNonce", err);
    // Fail toward treating this as a new session: a null returned here never
    // equals a real stored nonce, so a mismatch is assumed and the run parks
    // rather than silently trusting tabIds it can no longer vouch for.
    return null;
  }
}

let loader = newLoaderState();
function newLoaderState() {
  return { running: false, paused: false, options: {}, done: 0, errors: 0, total: 0, platforms: {}, runId: null, interrupted: null };
}

// The window a resumed run's new tabs open in: its own private window when it
// runs signed out (reopened if it was closed), otherwise wherever Chrome puts
// them.
async function resumeWindowId() {
  if (!(loader.options && loader.options.incognito)) return null;
  if (loader.windowId != null) {
    try { const w = await chrome.windows.get(loader.windowId); if (w && w.incognito) return w.id; } catch (_) { /* closed */ }
  }
  const win = await chrome.windows.create({ incognito: true });
  loader.windowId = win.id;
  return win.id;
}

// Every pause and resume of the whole run goes through here, so the time a
// run spent stopped can be left out of how long it took (0.79.0).
function setLoaderPaused(v) {
  const now = Date.now();
  if (v && !loader.paused) loader.pausedAt = now;
  if (!v && loader.paused && loader.pausedAt) {
    loader.pausedMs = (loader.pausedMs || 0) + (now - loader.pausedAt);
    loader.pausedAt = null;
  }
  loader.paused = v;
}

// How long the run has been working, without the time it sat paused.
function loaderActiveMs(now = Date.now()) {
  if (!loader.startedAt) return 0;
  const paused = (loader.pausedMs || 0) + (loader.paused && loader.pausedAt ? now - loader.pausedAt : 0);
  return Math.max(0, now - loader.startedAt - paused);
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
      // What "during this run" means when judging whether a Perplexity
      // thread-list preview is this run's answer or an older run's — see
      // isUnusableCampaignPreview. Has to survive a restart like the rest.
      startedAt: loader.startedAt || null,
      pausedMs: loader.pausedMs || 0,
      pausedAt: loader.pausedAt || null,
      windowId: loader.windowId != null ? loader.windowId : null,
      // Stamped fresh on every write so a resume always compares against the
      // CURRENT session's nonce, not a stale one cached from before this
      // worker instance's own restart.
      sessionNonce: await ensureSessionNonce(),
      platforms: Object.fromEntries(
        Object.entries(loader.platforms).map(([plat, pd]) => [
          plat,
          {
            rateLimitedUntil: pd.rateLimitedUntil || null,
            cooldownReason: pd.cooldownReason || null,
            legs: (pd.legs || []).map((leg) => ({
              tabId: leg.tabId,
              startOffset: leg.startOffset || 0,
              ...(Array.isArray(leg.geoIdx) ? { geoIdx: leg.geoIdx } : {}),
              prompts: leg.prompts,
              idx: leg.idx,
              failed: leg.failed || 0,
              lastAdvanceAt: leg.lastAdvanceAt || 0,
              startedAt: leg.startedAt || 0,
              token: leg.token || null,
              expectedPrompt: leg.expectedPrompt || null,
              inFlightIdx: Number.isInteger(leg.inFlightIdx) ? leg.inFlightIdx : -1,
              // The turn whose prompt has gone out — see loader-claim. Kept
              // across a restart so a resumed turn can't be handed out twice.
              sentToken: leg.sentToken || null,
              durations: leg.durations || [],
              finishTimes: leg.finishTimes || [],
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
    logErr("persistLoaderState", err, { running: loader.running, total: loader.total, runId: loader.runId });
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
//
// Chrome's own docs are explicit that alarms are NOT guaranteed to survive
// an extension update or a browser restart, and recommend re-creating them
// on every worker start rather than assuming a prior registration still
// exists — this top-level IIFE already runs on every fresh worker
// evaluation, and ensureHeartbeatAlarm is also called explicitly from
// onStartup below, so a missing alarm gets caught from either direction.
async function ensureHeartbeatAlarm() {
  try {
    const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
    if (!existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  } catch (err) {
    // Degrades to setTimeout-only scheduling, which cannot survive the worker
    // being terminated — so a run may stall with no other symptom. Worth a
    // log line even though it only happens in unusual environments.
    logErr("alarms.create(heartbeat)", err);
  }
}
ensureHeartbeatAlarm();
idleBadge();

// Fires once, as soon as the browser itself starts (not just this worker) —
// the earliest possible chance to notice a run left mid-flight by the
// previous browser session, rather than waiting up to a minute for the next
// periodic alarm tick. Re-arming the alarm here too closes the specific gap
// Chrome's docs warn about: an alarm can be dropped across a restart, and
// onStartup is the one guaranteed signal that a restart just happened.
chrome.runtime.onStartup?.addListener(() => {
  ensureHeartbeatAlarm();
  heartbeatTick().catch((err) => logErr("heartbeatTick:onStartup", err));
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // Previously `.catch(() => {})` — a resume that throws once (a null
    // tabId reaching chrome.tabs.get unguarded, a corrupted snapshot, a
    // schema mismatch after an update) repeated that same silent failure
    // every single minute forever, with zero trace anywhere: this is the
    // best-evidenced explanation for a run that stops for good with no
    // visible error. Routing it through logErr doesn't fix the underlying
    // throw, but it turns "silently stuck forever" into "visible in the
    // error log," which is the difference between an unfixable mystery and
    // a reportable bug.
    heartbeatTick().catch((err) => logErr("heartbeatTick", err));
    // Answers left in the AI queue by a closed browser are picked up again.
    aiSvc.kick();
  }
});

// A sleeping worker woken by something other than the heartbeat — an answer
// arriving — first picks its run back up, so that answer counts for its turn
// (0.79.0; it was stored without its run and the turn then timed out).
// Shared, so the heartbeat and a capture can't restore the run twice.
let restoring = null;
function restoreRunIfAny() {
  if (loader.running) return Promise.resolve();
  if (!restoring) {
    restoring = (async () => {
      const snap = await loadPersistedLoaderState();
      if (snap && snap.running && !loader.running) await resumeFromSnapshot(snap);
    })().finally(() => { restoring = null; });
  }
  return restoring;
}

async function heartbeatTick() {
  if (!loader.running) {
    // This worker instance has no memory of an active run. If persisted
    // state disagrees, a previous instance died mid-run — resume it.
    await restoreRunIfAny();
    return;
  }
  if (isOffline()) { await pauseForOffline(); return; }
  if (loader.offline) resumeAfterOffline();
  if (loader.paused) return;
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    if (pd.rateLimitedUntil && Date.now() >= pd.rateLimitedUntil) resumeAfterCooldown(plat);
  }
  // This instance already believes it's mid-run, with a setTimeout watchdog
  // armed per platform — those survive as long as THIS instance stays
  // alive, so there's normally nothing to do here. This loop is the safety
  // net for the rarer case where a turn is well past its timeout with no
  // watchdog armed (the timer itself got lost some other way, not the whole
  // worker) — the same recovery the watchdog itself would have done.
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    for (const leg of pd.legs || []) {
      if (leg.idx >= leg.prompts.length || !leg.startedAt || leg.watchdog || leg.paused) continue;
      const over = Date.now() - leg.startedAt - turnBudgetMs(leg);
      // Far over: the computer slept, or the browser was gone; ask again.
      if (over >= SLEEP_GAP_MS) retryTurn(plat, leg, "the computer slept during this turn");
      else if (over >= 5000) failTurnAndAdvance(plat, leg, "watchdog lost");
    }
  }
}

// Reusable so the freshly-armed path (loaderRunLeg) and the recovered-
// after-restart path (resumeFromSnapshot) can never drift apart. Takes the
// LEG directly (not looked up by plat) because a platform can now have more
// than one concurrent leg.
// A turn whose answer is still streaming when its watchdog fires gets this
// much more time, at most this many times — see armWatchdog.
const STREAM_EXTENSION_MS = 60 * 1000;
const MAX_STREAM_EXTENSIONS = 2;
const ANSWER_SHOWN_MIN_CHARS = 40;
const ANSWER_SHOWN_GRACE_MS = 15000;

function armWatchdog(plat, leg, ms) {
  if (!leg) return;
  leg.watchdog = setTimeout(async () => {
    if (!loader.running || loader.paused || leg.paused) return;
    if (leg.idx >= leg.prompts.length) return;
    // Fired far later than set: the computer slept through the turn.
    if (leg.startedAt && Date.now() - leg.startedAt > ms + SLEEP_GAP_MS) { leg.watchdog = null; retryTurn(plat, leg, "the computer slept during this turn"); return; }
    if (isOffline()) { leg.watchdog = null; pauseForOffline(); return; }
    // Ask the tab where the turn got to before calling it — see
    // probeLoaderTab. The turn may complete while the probe is in flight
    // (an answer landing in the last second), so it's re-checked after.
    const idxAtFire = leg.idx;
    const tokenAtFire = leg.token;
    const probe = await probeLoaderTab(leg);
    if (!loader.running || loader.paused || leg.paused) return;
    if (leg.idx !== idxAtFire || leg.token !== tokenAtFire) return;
    // A ChatGPT copy held for its stream's end (loaderOnCapture): the answer
    // is here, so it completes the turn rather than a timeout failing it.
    const held = quietHolds.get(leg);
    if (held) {
      clearTimeout(held.timer);
      quietHolds.delete(leg);
      completeTurn(plat, leg, held.record);
      return;
    }
    // The answer is on the page and finished, but its capture hasn't landed:
    // a short wait more, once (0.79.0). Before, this turn failed as "no
    // answer" while the answer sat on screen.
    if (probe && probe.ok && probe.stage === "sent" && !probe.streaming && (probe.answerChars || 0) > ANSWER_SHOWN_MIN_CHARS && leg.answerGraceToken !== leg.token) {
      leg.answerGraceToken = leg.token;
      armWatchdog(plat, leg, ANSWER_SHOWN_GRACE_MS);
      return;
    }
    // Still streaming its answer: not a failure yet. Two real ChatGPT turns
    // were failed at 90s with the stop button still showing — a long answer,
    // not a lost one. The extensions are capped so a stuck indicator can't
    // hold a turn forever.
    if (probe && probe.ok && probe.stage === "sent" && probe.streaming && (leg.streamExtensions || 0) < MAX_STREAM_EXTENSIONS) {
      leg.streamExtensions = (leg.streamExtensions || 0) + 1;
      armWatchdog(plat, leg, STREAM_EXTENSION_MS);
      return;
    }
    const unreadable = leg.unreadable && leg.unreadable.token === leg.token ? leg.unreadable : null;
    const tab = probe && probe.ok ? null : await tabFacts(leg.tabId);
    const nav = leg.navLogToken === leg.token ? leg.navLog || [] : [];
    if (tab && tab.status === "gone" && !unreadable && await replaceLegTab(plat, leg)) { leg.watchdog = null; retryTurn(plat, leg, "its tab was closed; a new one took over"); return; }
    const { reason, trace, ctx } = describeTimeout(probe, unreadable, tab, nav);
    if (leg.streamExtensions) {
      ctx.streamExtensions = leg.streamExtensions;
    }
    const shown = !unreadable && probe && probe.ok && (probe.answerChars || 0) > ANSWER_SHOWN_MIN_CHARS;
    if (shown) ctx.answerChars = probe.answerChars;
    failTurnAndAdvance(plat, leg, shown ? "timeout: answer shown on the page, but its capture never arrived" : reason, 0, trace, ctx);
  }, ms);
}

/* What a timed-out tab says about itself.
 *
 * A watchdog timeout used to be recorded as the bare word "timeout", which
 * covers opposite failures: a prompt that never went out, and one that went
 * out and was answered but whose answer the extension never caught. Across
 * two real runs 57 of 57 failures were bare timeouts, so nothing in the
 * export could say which. The content script answers with its stage, how it
 * confirmed a send, its tick timing and its clock (a hidden tab on the page
 * clock shows ~1000ms or ~60000ms gaps instead of 400ms), whether it's
 * visible, and its event trace. No answer at all within a moment is itself
 * informative: the script never started in that tab, or the tab is frozen.
 */
// 4s, not less: a hidden engine tab under load can take a moment to get to
// the message, and "no answer" must mean the page is gone or hung, not busy.
const PROBE_WAIT_MS = 4000;
function probeLoaderTab(leg) {
  const sentAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, probeMs: Date.now() - sentAt }); } };
    setTimeout(() => done({ ok: false, error: "no answer" }), PROBE_WAIT_MS);
    try {
      chrome.tabs.sendMessage(leg.tabId, { type: "loader-probe", token: leg.token }, { frameId: 0 }, (res) => {
        if (chrome.runtime.lastError) done({ ok: false, error: "unreachable" });
        else done(res && res.ok ? res : { ok: false, error: "no answer" });
      });
    } catch (_) {
      done({ ok: false, error: "unreachable" });
    }
  });
}

// `unreadable` — this turn's tab delivered an answer payload the adapter
// could read nothing from (storeCapture). That outranks what the probe says:
// the prompt went out and an answer came back; the reader is what failed.
// It is exactly how every Grok turn failed once grok.com changed transport,
// while the log said only "timeout".
function describeTimeout(probe, unreadable = null, tab = null, nav = []) {
  const unreadableCtx = unreadable ? { unreadableShape: unreadable.shape } : {};
  const unreadableReason = "timeout: engine replied, but the reply couldn't be read";
  const navTrace = nav.length ? ` | tab: ${nav.join(" ")}` : "";
  if (!probe || !probe.ok) {
    const t = tab || {};
    const reason = unreadable ? unreadableReason
      : t.frozen ? "timeout: Chrome froze the tab"
      : t.discarded ? "timeout: Chrome discarded the tab"
      : t.challenge ? "timeout: blocked by a verification page"
      : t.status === "loading" ? "timeout: page never finished loading"
      : t.status === "gone" ? "timeout: the tab was closed"
      : "timeout: page script not responding";
    return {
      reason,
      trace: `probe:${(probe && probe.error) || "none"}${probe && probe.probeMs != null ? ` after ${probe.probeMs}ms` : ""}`
        + ` tab=${t.status || "?"}${t.frozen ? " frozen" : ""}${t.discarded ? " discarded" : ""}${t.challenge ? " challenge" : ""} at=${t.where || "?"}`
        + `${unreadable ? ` unreadable=${unreadable.shape}` : ""}${navTrace}`,
      ctx: {
        stage: (probe && probe.error) || "none",
        probeMs: probe && probe.probeMs,
        tabStatus: t.status,
        frozen: !!t.frozen,
        discarded: !!t.discarded,
        where: t.where,
        ...unreadableCtx,
      },
    };
  }
  // No turn is running in the page that answered (see pageFacts in
  // content-iso.js): the document the prompt was sent to is gone.
  if (probe.stage === "no-turn" && !unreadable) {
    const reason = probe.challenge ? "timeout: blocked by a verification page"
      : !probe.hadMarkers ? (probe.navType === "reload" ? "timeout: page reloaded and lost the prompt" : "timeout: page navigated away from the prompt")
      : probe.verify === "rejected" ? "timeout: run did not recognise this tab"
      : probe.verify === "already-fired" ? "timeout: prompt already used in this tab"
      : "timeout: page never confirmed the prompt with the run";
    return {
      reason,
      trace: `probe stage=no-turn nav=${probe.navType} markers=${probe.hadMarkers ? "yes" : "no"} verify=${probe.verify}`
        + ` path=${probe.path} age=${probe.docAgeMs}ms ready=${probe.readyState}${probe.challenge ? " challenge" : ""} vis=${probe.visibility}${navTrace}`,
      ctx: {
        stage: "no-turn",
        navType: probe.navType,
        hadMarkers: !!probe.hadMarkers,
        verify: probe.verify,
        path: probe.path,
        docAgeMs: probe.docAgeMs,
        challenge: !!probe.challenge,
        visibility: probe.visibility,
      },
    };
  }
  if (probe.stage === "probe-error") {
    return {
      reason: unreadable ? unreadableReason : "timeout: page script failed while reporting",
      trace: `probe stage=probe-error ${probe.error || ""} | ${probe.trace || ""}`,
      ctx: { stage: "probe-error", ...unreadableCtx },
    };
  }
  const reason = probe.signedOut ? "timeout: signed out"
    : unreadable ? unreadableReason
    : probe.stage === "sent" ? "timeout: sent, no answer captured"
    : "timeout: prompt never went out";
  const head = `probe stage=${probe.stage}${probe.sentWhy ? ` via=${probe.sentWhy}` : ""} ticks=${probe.ticks}`
    + ` maxgap=${probe.maxTickGap}ms clock=${probe.clock} vis=${probe.visibility}`
    + `${probe.streaming ? " streaming" : ""}${unreadable ? ` unreadable=${unreadable.shape}` : ""}`;
  return {
    reason,
    trace: `${head} | ${probe.trace || ""}${navTrace}`,
    ctx: {
      stage: probe.stage,
      ticks: probe.ticks,
      maxTickGapMs: probe.maxTickGap,
      clock: probe.clock,
      visibility: probe.visibility,
      streaming: !!probe.streaming,
      ...unreadableCtx,
    },
  };
}

// Every finished prompt, answered or failed, stamps when it finished: the
// time-left estimate reads the spacing between them (pacing.js legEta).
function noteFinish(leg) {
  leg.finishTimes = [...(leg.finishTimes || []), Date.now()].slice(-12);
}

// The one place a turn is counted as failed and the run moves on — shared by
// the watchdog, the tab-closed path, and both restart-recovery paths below,
// so "what counts as a failure" can never quietly diverge between them.
// Takes the LEG directly, same reason as armWatchdog above.
// `retryDelayMs` defaults to immediate (matching the original watchdog
// behaviour); the tab-closed path passes a short delay to avoid hammering
// chrome.tabs.update in a tight loop if every remaining prompt in the list
// would also fail against the same closed tab.
/* Pause one engine's legs on a cooldown, then resume them (a limit seen on
 * the page, or reported by the engine itself — Grok's gateway, 0.62.2). Other
 * engines keep running. */
/* An engine's cooldown is over: its legs ask the prompt that met the limit
 * again. Until 0.79.0 this called a function that didn't exist, so the legs
 * were un-paused but never restarted, and the heartbeat then failed the
 * waiting prompt as "watchdog lost" — every ChatGPT limit card cost a prompt
 * and stalled that engine for the rest of the run. */
function resumeAfterCooldown(plat) {
  const p = loader.platforms[plat];
  if (!p) return;
  if (p.cooldownTimer) { clearTimeout(p.cooldownTimer); p.cooldownTimer = null; }
  if (!p.rateLimitedUntil) return; // already resumed (timer and heartbeat both fire)
  p.rateLimitedUntil = null;
  if (!loader.running) return;
  logErr(`run:auto-resume:${plat}`, "Cooldown expired, auto-resuming platform queue", { platform: plat, runId: loader.runId });
  for (const leg of p.legs || []) {
    if (!leg.paused) continue;
    leg.paused = false;
    if (leg.idx < leg.prompts.length && !loader.paused) loaderRunLeg(plat, leg);
  }
  if (loader.interrupted && loader.interrupted.reason === "rate limit" && loader.interrupted.platform === plat) loader.interrupted = null;
  persistLoaderState();
  syncGeoRun();
}

/* Run guard (1.0.5): what the computer and its connection do to a run.
 *
 * - The internet drops: every engine waits (nothing is sent into an error
 *   page, no turn is failed), and goes on by itself once it is back; the
 *   question that was in flight is asked again.
 * - The computer sleeps: a turn whose time ran out while it slept is asked
 *   again (twice at most), not failed; the run carries on.
 * - Power lost or browser closed: the run is saved after every turn and
 *   comes back paused at the same question (restoreRunIfAny).
 * - Storage full: the run pauses and says so, instead of losing answers.
 */
const SLEEP_GAP_MS = 3 * 60 * 1000;
const MAX_TURN_RETRIES = 2;
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
async function notifyGuard(title, message) {
  try {
    if (chrome.notifications) await chrome.notifications.create(`lcfc-guard-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message, priority: 1 });
  } catch (err) { logErr("guard:notify", err); }
}
async function pauseForOffline() {
  if (!loader.running || loader.offline) return;
  loader.offline = { at: Date.now() };
  for (const pd of Object.values(loader.platforms)) {
    for (const leg of pd.legs || []) {
      clearWatchdog(leg);
      if (!leg.paused) { leg.paused = true; leg.offlinePaused = true; }
    }
  }
  loader.interrupted = { at: Date.now(), reason: "offline", detail: "The internet connection dropped. The run waits and goes on by itself when it's back." };
  logEvent("run:offline", "turn", "connection lost; the run waits", { runId: loader.runId });
  await persistLoaderState();
  syncGeoRun(undefined, "waiting for the internet");
  notifyGuard("Run waiting for the internet", "The connection dropped. Nothing was lost: the run goes on by itself when it's back.");
}
function resumeAfterOffline() {
  if (!loader.running || !loader.offline || isOffline()) return;
  loader.offline = null;
  for (const [plat, pd] of Object.entries(loader.platforms)) {
    for (const leg of pd.legs || []) {
      if (!leg.offlinePaused) continue;
      leg.offlinePaused = false;
      leg.paused = false;
      // The question in flight when it dropped is asked again, not failed.
      if (leg.idx < leg.prompts.length && !loader.paused && !pd.rateLimitedUntil) loaderRunLeg(plat, leg);
    }
  }
  if (loader.interrupted && loader.interrupted.reason === "offline") loader.interrupted = null;
  logEvent("run:online", "turn", "connection back; the run goes on", { runId: loader.runId });
  persistLoaderState();
  syncGeoRun();
}
self.addEventListener?.("offline", () => { pauseForOffline().catch((e) => logErr("guard:offline", e)); });
self.addEventListener?.("online", () => { resumeAfterOffline(); });
/** Ask the same question again (a sleep or a dropped connection ate it), at most twice. */
function retryTurn(plat, leg, why) {
  clearWatchdog(leg);
  leg.turnRetries = leg.turnRetryIdx === leg.idx ? (leg.turnRetries || 0) + 1 : 1;
  leg.turnRetryIdx = leg.idx;
  if (leg.turnRetries > MAX_TURN_RETRIES) return failTurnAndAdvance(plat, leg, why, 0, "", { guard: true });
  logEvent(`run:retry:${plat}`, "turn", `asked again: ${why}`, { platform: plat, promptIndex: geoIdxOf(leg, leg.idx), runId: loader.runId });
  if (isOffline()) { pauseForOffline(); return; }
  setTimeout(() => { if (loader.running && !loader.paused && !leg.paused) loaderRunLeg(plat, leg); }, 2000);
}
/* A run tab closed mid-run (by hand, or its page crashed): a new tab takes
 * over and the question is asked again, at most 3 times per tab in a run;
 * after that the old behaviour (fail the question, move on). */
const MAX_TAB_REPLACEMENTS = 3;
async function replaceLegTab(plat, leg) {
  if ((leg.tabReplacements || 0) >= MAX_TAB_REPLACEMENTS) return false;
  try {
    let windowId = loader.windowId || null;
    if (windowId != null) { try { await chrome.windows.get(windowId); } catch (_) { windowId = null; } }
    const t = await chrome.tabs.create({ url: "about:blank", active: false, ...(windowId != null ? { windowId } : {}) });
    chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    leg.tabId = t.id;
    leg.turnsInTab = 0;
    leg.tabReplacements = (leg.tabReplacements || 0) + 1;
    logEvent(`run:tab-replaced:${plat}`, "turn", "the run's tab was closed; a new one took over", { platform: plat, runId: loader.runId });
    await persistLoaderState();
    return true;
  } catch (e) { logErr("run:tab-replace", e); return false; }
}

/** Storage full: pause, keep what's there, say what to do. */
async function pauseForStorage(err) {
  if (!loader.running || loader.paused) return;
  setLoaderPaused(true);
  for (const pd of Object.values(loader.platforms)) for (const leg of pd.legs || []) clearWatchdog(leg);
  loader.interrupted = { at: Date.now(), reason: "storage", detail: "This computer's browser storage is full, so answers couldn't be saved." };
  logErr("run:storage-full", err);
  await persistLoaderState().catch(() => {});
  syncGeoRun(undefined, "paused: storage full");
  notifyGuard("Run paused: storage is full", "Answers couldn't be saved. Free some disk space or lower the answers kept in Settings, then press Resume.");
}
const isQuota = (e) => /quota|QuotaExceeded|disk/i.test(String((e && (e.name || e.message)) || e));

async function pauseForLimit(matched, detail, { manual = false } = {}) {
  const p = loader.platforms[matched];
  if (!p) return;
  // Manual: a day, so neither the timer nor the heartbeat resumes it; Resume does.
  const cooldownMs = manual ? 24 * 60 * 60 * 1000 : parseCooldownFromNotice(detail);
  const resumeAt = Date.now() + cooldownMs;
  p.rateLimitedUntil = resumeAt;
  p.cooldownReason = typeof detail === "string" ? detail.slice(0, 160) : "rate limit";

  for (const leg of p.legs || []) {
    clearWatchdog(leg);
    leg.paused = true;
  }

  // Arm an auto-resume timer for this specific platform
  if (p.cooldownTimer) clearTimeout(p.cooldownTimer);
  // The worker can sleep through a 30-minute timer, so the heartbeat also
  // resumes an engine whose cooldown has passed (see heartbeatTick).
  p.cooldownTimer = setTimeout(() => resumeAfterCooldown(matched), cooldownMs);

  loader.interrupted = {
    at: Date.now(),
    reason: "rate limit",
    platform: matched,
    detail: p.cooldownReason,
    autoResumeAt: resumeAt,
  };

  await persistLoaderState();
  syncGeoRun(undefined, `cooldown: ${matched} (${formatCooldown(cooldownMs)})`);
  notifyRateLimited(manual ? `${matched}: ${p.cooldownReason}. Paused: press Resume once you've answered it in that tab.` : `${matched}: ${p.cooldownReason} (Auto-resuming in ${formatCooldown(cooldownMs)})`);
}

function failTurnAndAdvance(plat, leg, reason, retryDelayMs = 0, trace = "", extraCtx = null) {
  if (!leg) return;
  if (isOffline() && loader.running && !(extraCtx && extraCtx.guard)) { pauseForOffline(); return; }
  loader.errors++;
  leg.failed = (leg.failed || 0) + 1;
  leg.outcomes = leg.outcomes || [];
  leg.outcomes[leg.idx] = { status: "failed", reason, at: Date.now() };
  noteFinish(leg);
  leg.inFlightIdx = -1;
  leg.idx++;
  leg.lastAdvanceAt = Date.now();
  leg.lastFailReason = reason;
  const reloadRetriesAtFailure = leg.reloadRetries || 0;
  // This leg is genuinely moving to a new prompt now — the reload-retry
  // budget (chrome.tabs.onUpdated listener below) is per-prompt, not
  // per-leg, so it resets here rather than carrying over to whatever comes
  // next.
  leg.reloadRetries = 0;
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
  const promptIndex = geoIdxOf(leg, leg.idx - 1);
  const elapsedMs = leg.startedAt ? Date.now() - leg.startedAt : 0;
  logErr(`run:turn-failed:${plat}`, reason, {
    platform: plat,
    promptIndex,
    totalPrompts: platformTotal(plat),
    failedSoFar: leg.failed,
    // Whether the content script ever reported anything for this turn. A
    // timeout with reported=false means the page-side script went quiet,
    // which is a different bug from one that tried and failed.
    reported: !!trace,
    elapsedMs,
    runId: loader.runId,
    ...(extraCtx || {}),
  }, trace);
  // A durable per-turn outcome, alongside the error entry above — this is
  // what lets a campaign export show a full turn-by-turn timeline (status,
  // timing, retries) after the run view is long closed, not just the
  // aggregated "N failed" count the live progress view already had.
  logEvent(`run:turn:${plat}`, "turn", reason, {
    platform: plat, promptIndex, status: "failed", elapsedMs,
    retries: reloadRetriesAtFailure, runId: loader.runId,
    ...(extraCtx || {}),
  });
  persistLoaderState();
  syncGeoRun(undefined, reason, 1, plat);
  if (retryDelayMs < 0) return; // the caller moves the leg on itself
  if (retryDelayMs > 0) setTimeout(() => loaderRunLeg(plat, leg), retryDelayMs);
  else loaderRunLeg(plat, leg);
}

const MAX_LIMIT_STREAK = 4;

// A snapshot written before concurrency shipped has the OLD flat shape —
// {tabId, prompts, idx, ...} directly on the platform, no `legs` array.
// LOADER_STATE_MAX_AGE_MS is 7 days, so a real in-flight run written by the
// previous build can still be sitting in storage the moment this build
// starts. Reading it as-is would find `pd.legs` undefined and silently lose
// the whole run; wrapping it as a single leg instead makes the upgrade
// transparent — the run resumes as one tab, exactly as it was running
// before, and the NEXT run it starts gets the new concurrency.
// Where prompt i of this leg sits in the run's full prompt list (and so in
// loader.options.geoPrompts). A leg normally holds a contiguous shard
// (startOffset + i); a "Retry missing" leg (0.78.1) holds a chosen subset,
// so it carries the original positions itself (leg.geoIdx).
function geoIdxOf(leg, i) {
  return Array.isArray(leg.geoIdx) && leg.geoIdx[i] != null ? leg.geoIdx[i] : (leg.startOffset || 0) + i;
}

function legsOf(pd) {
  if (!pd) return [];
  if (Array.isArray(pd.legs)) return pd.legs;
  if (pd.tabId !== undefined || pd.prompts) return [pd];
  return [];
}

// One place for "what is this platform's home URL" — shared by loaderRunLeg
// (the URL it navigates to), checkTabOwnership (the hostnames a tab must be
// on to still count as ours) and loader-resume's tab recreation. Previously
// loader-resume had its own, separate, incomplete copy of this ladder
// (gemini vs. a chatgpt.com fallback for everything else), so recreating a
// dead Perplexity or Grok tab after a park silently sent it to chatgpt.com
// instead — fixed here by giving both call sites one source of truth.
function engineBaseUrl(plat) {
  if (plat === "gemini") return "https://gemini.google.com/app";
  if (plat === "perplexity") return "https://www.perplexity.ai/";
  if (plat === "grok") return "https://grok.com/";
  if (plat === "aimode") return "https://www.google.com/search?udm=50";
  return "https://chatgpt.com/";
}

// Hostnames each platform's Loader-owned tab is expected to be on.
// about:blank (a tab's state before its first-ever navigation) always
// passes — there is nothing to have navigated away from yet.
const ENGINE_HOSTS = {
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  gemini: ["gemini.google.com"],
  perplexity: ["perplexity.ai", "www.perplexity.ai"],
  grok: ["grok.com", "x.com"],
  aimode: ["www.google.com", "google.com"],
};

/**
 * The single seam every leg-owning tab navigation goes through before
 * touching that tab. Confirms the tab still exists AND is still showing
 * this leg's engine — or hasn't navigated yet — before the caller may act.
 *
 * Without this, a user who clicks a source link or a related question, or
 * just switches to something else in a Loader tab, has that tab silently
 * navigated back to the engine (with the next prompt auto-submitted into
 * it) the moment the Loader schedules its next turn or a stale run
 * resumes — the extension acting on a page the user has reclaimed for
 * their own use. That's a trust-boundary problem, not a data-quality one:
 * `loader-verify` (see that message handler) only stops a THIRD PARTY page
 * from spoofing a submit; it does nothing here, because the Loader's own
 * fresh token for this leg is exactly what would pass it.
 */
async function checkTabOwnership(plat, leg) {
  let tab;
  try {
    tab = await chrome.tabs.get(leg.tabId);
  } catch (_) {
    return { ok: false, reason: "tab_closed" };
  }
  const url = tab && tab.url;
  if (!url || url === "about:blank") return { ok: true };
  let host;
  try {
    host = new URL(url).hostname;
  } catch (_) {
    return { ok: false, reason: "user_navigated" };
  }
  const allowed = ENGINE_HOSTS[plat] || [];
  if (allowed.some((h) => host === h || host.endsWith(`.${h}`))) return { ok: true };
  return { ok: false, reason: "user_navigated" };
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
  // Compared BEFORE anything else touches a tab. A mismatch means this is a
  // different browser session than the one that wrote the snapshot — tab ids
  // may have been reassigned to unrelated tabs — so every leg is treated as
  // if its tab were gone (see checkTabOwnership's header) without a single
  // chrome.tabs.get call spent finding that out the hard way.
  const liveNonce = await ensureSessionNonce();
  const restarted = !!(snap.sessionNonce && snap.sessionNonce !== liveNonce);

  const platEntries = Object.entries(snap.platforms || {});
  let all = [];
  if (platEntries.length) {
    try {
      all = await db.getAll("derived");
    } catch (err) {
      // A read failing here must never become a permanent throw-loop: this
      // function runs from the heartbeat alarm every single minute for as
      // long as `loader.running` stays false in memory, so an uncaught
      // throw at this exact line would repeat identically forever — the
      // run stays "running" in storage but never actually resumes, and
      // nothing about that is visible beyond the same error-log entry
      // repeating every tick. Degrade instead of aborting: proceed without
      // reconciliation, trusting each leg's own persisted `idx` as-is.
      // Under-reconciled is recoverable (worst case one duplicate capture,
      // or a prompt that did complete showing as still pending); stuck
      // invisibly forever is not.
      logErr("resumeFromSnapshot:getAll", err, { runId: snap.runId });
      all = [];
    }
  }

  loader = {
    running: true,
    paused: restarted ? true : !!snap.paused,
    interrupted: restarted
      ? { at: Date.now(), reason: "browser restarted" }
      : (snap.interrupted || null),
    options: snap.options || {},
    done: 0,
    errors: snap.errors || 0,
    total: snap.total || 0,
    runId: snap.runId,
    startedAt: snap.startedAt || null,
    // Time the browser was closed counts as paused, not as work (0.79.0).
    pausedMs: (snap.pausedMs || 0) + (snap.savedAt && !snap.pausedAt && Date.now() - snap.savedAt > 2 * 60 * 1000 ? Date.now() - snap.savedAt : 0),
    pausedAt: snap.pausedAt || null,
    windowId: restarted ? null : (snap.windowId != null ? snap.windowId : null),
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
        // A restarted browser session may have reassigned this id to an
        // unrelated tab — null it out so nothing (including a later Resume
        // click) mistakes it for still being ours; Resume already creates a
        // fresh tab whenever tabId is null.
        tabId: restarted ? null : sl.tabId,
        startOffset: sl.startOffset || 0,
        ...(Array.isArray(sl.geoIdx) ? { geoIdx: sl.geoIdx } : {}),
        prompts: legPrompts,
        idx,
        failed: sl.failed || 0,
        lastAdvanceAt: sl.lastAdvanceAt || 0,
        startedAt: sl.startedAt || Date.now(),
        token: sl.token || null,
        expectedPrompt: sl.expectedPrompt || null,
        // The prompt that was in flight is still in flight only if the
        // restored position is still on it. A snapshot from before this field
        // existed keeps the old behaviour: a token meant a turn was running.
        inFlightIdx: idx === (sl.idx || 0) && (Number.isInteger(sl.inFlightIdx) ? sl.inFlightIdx === sl.idx : !!sl.token) ? idx : -1,
        sentToken: sl.sentToken || null,
        durations: sl.durations || [],
        finishTimes: sl.finishTimes || [],
        outcomes,
        watchdog: null,
        paused: !!sl.paused,
      };
    });
    loader.platforms[plat] = { legs, rateLimitedUntil: sp.rateLimitedUntil || null, cooldownReason: sp.cooldownReason || null };
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

      const ownership = await checkTabOwnership(plat, leg);
      if (!ownership.ok) {
        // The tab is gone, OR it exists but has been navigated away from the
        // engine (the user reclaimed it for their own browsing) — either way
        // it must not be silently recreated or renavigated. Marking every
        // remaining prompt FAILED is worse, and after a browser restart the
        // tabs are ALWAYS gone, so a long run would lose its whole remainder
        // the moment it was reloaded. That made runs longer than one
        // browsing session impossible.
        //
        // Instead the run is parked: still running, paused, flagged
        // resumable, nothing failed. The UI surfaces "interrupted — N left,
        // Resume?" and the user's explicit Resume recreates the tab (see
        // loader-resume). Deliberate, reversible, and no tab appears without
        // a click, and no page the user is using gets navigated out from
        // under them. Any ONE leg being gone or reclaimed parks the WHOLE
        // run, same as before concurrency — a partial resume (some tabs
        // alive, some not) would need its own "which legs are still going"
        // UI, and simply parking everything keeps one predictable recovery
        // path.
        leg.tabId = null;
        setLoaderPaused(true);
        loader.interrupted = {
          at: Date.now(),
          reason: ownership.reason === "tab_closed"
            ? "browser or tab closed mid-run"
            : "a Loader tab was navigated away from the engine",
        };
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
    startNextQueued();
    notifyRunComplete();
    closeRunTabs();
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
function syncGeoRun(statusOverride, reason, reasonCount = 1, plat = null) {
  syncGeoRunChain = syncGeoRunChain.then(() => syncGeoRunOnce(statusOverride, reason, reasonCount, plat));
  return syncGeoRunChain;
}
async function syncGeoRunOnce(statusOverride, reason, reasonCount, plat) {
  const g = loader.options && loader.options.geo;
  if (!g || !g.runId) return;
  try {
    const run = await db.get("geoRuns", g.runId);
    if (!run) return;
    // A "Retry missing" pass (0.78.1) adds to the run it retries: what it
    // recovers is taken off that run's failures.
    const base = g.retryBase;
    const patch = base
      ? { ...run, captured: base.captured + loader.done, failed: Math.max(0, base.failed - loader.done) }
      : { ...run, captured: loader.done, failed: loader.errors };
    if (reason) {
      const key = base ? `retry ${reason}` : reason;
      const reasons = { ...(run.reasons || {}) };
      reasons[key] = (reasons[key] || 0) + reasonCount;
      patch.reasons = reasons;
      // Which engine each reason came from (0.78.1): the diagnostics said
      // "send control never accepted the prompt: 65" without saying where.
      if (plat) {
        const by = { ...(run.reasonsBy || {}) };
        by[plat] = { ...(by[plat] || {}), [key]: ((by[plat] || {})[key] || 0) + reasonCount };
        patch.reasonsBy = by;
      }
    }
    if (base && statusOverride === "done") patch.retries = [...(run.retries || []), { at: Date.now(), asked: loader.total, answered: loader.done }];
    if (statusOverride) {
      patch.status = statusOverride;
      patch.finishedAt = Date.now();
      // How long the run worked, without the time it sat paused or the
      // browser was closed; a retry adds its own working time (0.79.0).
      // finishedAt − startedAt spanned days once a run was retried later.
      patch.activeMs = (base ? base.activeMs || 0 : 0) + loaderActiveMs();
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

// Every engine tab this run opened, closed once every prompt across every
// platform has actually finished — never on an explicit user-initiated stop
// (see notifyRunComplete above), since the user stopping a run is usually
// them wanting to go look at one of those tabs, not have it vanish under
// them. Unlike a bare chrome.tabs.remove, this reuses checkTabOwnership —
// the same "is this still our tab, on the expected engine, not navigated
// away" check the run's own navigation path is gated on — so a tab the user
// has reclaimed mid-run for their own browsing gets left alone instead of
// silently destroyed out from under them; only a tab still genuinely idle on
// the engine (or never navigated past about:blank) is closed. Best-effort
// per tab either way: a tab already closed by the user just rejects.
async function closeRunTabs() {
  const closes = [];
  for (const [plat, pd] of Object.entries(loader.platforms || {})) {
    for (const leg of pd.legs) {
      if (leg.tabId == null) continue;
      closes.push(
        checkTabOwnership(plat, leg).then((ownership) => {
          if (!ownership.ok) return;
          return chrome.tabs.remove(leg.tabId).catch(() => {});
        })
      );
    }
  }
  await Promise.all(closes);
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
    let worstEta = null, etaKnownForPlat = true, anyRemaining = false;
    const avgs = [];

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
      if (eta && eta.avgMs != null) avgs.push(eta.avgMs);

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
        // The real time this prompt has been going, not capped at its budget
        // (0.79.0: it froze at "1m 30s/1m 30s" through every extension and
        // through a whole cooldown). A leg sitting out a limit has no turn
        // running; the platform's cooldownUntil says how long is left.
        elapsedMs: started && !leg.paused && leg.startedAt ? now - leg.startedAt : null,
        sinceSentMs: started && !leg.paused && leg.sentAt ? now - leg.sentAt : null,
        turnTimeoutMs: turnBudgetMs(leg),
      });
    }

    totalTasks += total;
    totalIdx += done;
    platStats[plat] = {
      done, total, failed,
      legs: legStats,
      avgTurnMs: avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
      cooldownUntil: pd.rateLimitedUntil || null,
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
    // Which campaign this run is for: the Campaigns page holds that one still
    // while it runs (0.62.2).
    profileId: (loader.options && loader.options.geo && loader.options.geo.profileId) || null,
    running: loader.running,
    paused: loader.paused || anyPlatformPaused,
    // Paused by the user, not one engine sitting out a limit: the header's
    // Pause/Resume reads this, so a cooldown on one engine no longer says
    // "Paused" (and hides Pause) while the others keep running.
    userPaused: !!loader.paused,
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
    // Working time so far, paused time left out (0.79.0).
    activeMs: loaderActiveMs(now),
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
      startNextQueued();
      notifyRunComplete();
      closeRunTabs();
    }
    await persistLoaderState();
    return;
  }

  // Confirmed BEFORE this turn's state is committed — a user who has
  // reclaimed this tab for their own browsing must not have their page
  // silently replaced by the next scheduled prompt. See checkTabOwnership's
  // header for why loader-verify alone doesn't cover this.
  const ownership = await checkTabOwnership(plat, leg);
  if (!ownership.ok) {
    if (ownership.reason === "tab_closed") {
      if (await replaceLegTab(plat, leg)) { retryTurn(plat, leg, "its tab was closed; a new one took over"); return; }
      failTurnAndAdvance(plat, leg, "tab closed", 500);
    } else {
      leg.tabId = null;
      setLoaderPaused(true);
      loader.interrupted = { at: Date.now(), reason: "a Loader tab was navigated away from the engine" };
      await persistLoaderState();
    }
    return;
  }

  // A fresh tab every N prompts (1.0.4, see pacing.js needsFreshTab). The new
  // tab becomes this leg's before the old one closes, so the close is never
  // read as "tab closed" for the turn. If Chrome refuses, the old tab carries on.
  if (needsFreshTab(plat, leg.turnsInTab)) {
    const old = leg.tabId;
    try {
      const prev = await chrome.tabs.get(old);
      const fresh = await chrome.tabs.create({ windowId: prev.windowId, url: "about:blank", active: false, index: prev.index + 1 });
      chrome.tabs.update(fresh.id, { autoDiscardable: false }).catch(() => {});
      leg.tabId = fresh.id;
      leg.turnsInTab = 0;
      leg.tabsOpened = (leg.tabsOpened || 0) + 1;
      chrome.tabs.remove(old).catch(() => {});
      logEvent(`run:fresh-tab:${plat}`, "turn", `a fresh ${plat} tab after ${tabRecycleEvery(plat)} prompts`, { platform: plat, runId: loader.runId });
    } catch (_) { leg.turnsInTab = 0; }
  }
  leg.turnsInTab = (leg.turnsInTab || 0) + 1;

  if (isOffline()) { pauseForOffline(); return; }
  const prompt = leg.prompts[leg.idx];
  const q = encodeURIComponent(prompt);
  // A one-time token proves to the content script that THIS navigation came from
  // the Loader — so a crafted ?lcfc=1&q=… link can't make ChatGPT run a prompt.
  leg.token = crypto.randomUUID();
  leg.expectedPrompt = prompt;
  leg.startedAt = Date.now();
  leg.sentAt = 0;
  // The one prompt this leg can currently complete — see loaderOnCapture.
  leg.inFlightIdx = leg.idx;
  leg.streamExtensions = 0;
  await persistLoaderState();

  const search = plat === "chatgpt" && loader.options.forceSearch ? "&lcfcsearch=1" : "";
  // Gemini gets the question in lcfcq, which it doesn't read (1.0.5). From
  // ?q= Gemini sends the question itself, and the q stays in its address as
  // it moves to /app/<id>?q=…, so one turn went out 2 or 3 times, each a
  // new conversation within ~1 s (stress run, 23 Nov 2026: 187 of 549
  // questions). Now only the content script sends it, once.
  const qKey = plat === "gemini" ? "lcfcq" : "q";
  const base = engineBaseUrl(plat);
  const url = `${base}${base.includes("?") ? "&" : "?"}${qKey}=${q}&lcfc=1&lcfctok=${leg.token}${search}`;
  if (plat === "aimode") leg.sentTimes = [...(leg.sentTimes || []).filter((t) => Date.now() - t < 3600000), Date.now()];

  // Marks how long to IGNORE this tab's own navigation events for — see the
  // chrome.tabs.onUpdated listener below for why this has to be time-based
  // rather than counting discrete "loading" ticks. Set immediately before
  // the navigation THIS call is about to cause.
  leg.navGraceUntil = Date.now() + RELOAD_DETECT_GRACE_MS;
  try {
    await chrome.tabs.update(leg.tabId, { url });
  } catch (_) {
    // Tab was closed: a new one takes over (replaceLegTab), else fail this
    // prompt and move on rather than hanging.
    if (await replaceLegTab(plat, leg)) { retryTurn(plat, leg, "its tab was closed; a new one took over"); return; }
    failTurnAndAdvance(plat, leg, "tab closed", 500);
    return;
  }

  // Watchdog: if no signal-bearing capture arrives in time, record a failure and
  // continue. Without this a rate-limited or errored turn stalls the whole run.
  armWatchdog(plat, leg, turnBudgetMs(leg));
}

// Reported: Gemini (and, less predictably, other engines) prompts start
// failing specifically when the user opens/looks at the tab a run is using.
// Best-evidenced explanation: Chrome auto-discards long-backgrounded tabs
// under memory pressure — exactly what a multi-engine Campaign run creates,
// since only one tab can be foreground at a time and the rest sit
// backgrounded for the run's whole duration — and switching back to a
// discarded tab reloads it from scratch. A reload wipes the ?q=/lcfc
// querystring loaderAutoSubmit depends on (already stripped from history
// the moment it was first read) and all in-page state, so the turn was
// silently dead from that instant — previously undetectable until the full
// 90s watchdog gave up on it, indistinguishable from any other timeout.
//
// This turns that ~90s dead wait into a fast retry: a "loading" event on an
// in-flight leg's own tab, arriving well after the navigation loaderRunLeg
// itself just issued, means the tab left and came back on its own — so
// re-submit the same prompt right away rather than waiting out a watchdog
// that can no longer resolve.
//
// Why time-based rather than counting "this is the Nth loading event since
// we navigated": measured directly against a real Chromium instance
// (launchPersistentContext + the real extension, see the PR discussion) —
// ONE chrome.tabs.update() call reliably produces TWO separate
// loading-then-complete cycles back to back, roughly 10-50ms apart, not
// one. Counting ticks (even "the first loading after a complete") reads the
// second, entirely expected cycle as a reload and fires a spurious retry —
// confirmed as a real regression this way: a live run advanced two prompts
// deep within milliseconds, `failTurnAndAdvance` racking up "tab reloaded
// repeatedly" almost instantly. A grace window sidesteps the question of
// how many ticks one real navigation produces entirely: nothing inside it
// is ever treated as a reload, however noisy. 3s is enormous headroom over
// the ~50ms of measured noise while remaining a ~30x improvement over the
// 90s watchdog it replaces.
const RELOAD_DETECT_GRACE_MS = 3000;
// checkTabOwnership (inside loaderRunLeg) still runs on the retry, so this
// composes safely with the existing trust-boundary protections: if what
// actually happened is the user navigating this tab to something else
// entirely (not a reload back to the same engine), that still parks the
// run instead of resubmitting into a page the user is using.
/* The clock for a campaign turn running in a hidden tab.
 *
 * Chrome throttles timers in hidden pages — to once a second at once, and to
 * once a MINUTE after five minutes — and a run's engine tabs are always
 * hidden. The content script's submit loop is tick-driven, so it opens a port
 * here and this worker, whose timers aren't throttled, supplies the ticks;
 * message delivery into the page isn't throttled either. See startClock in
 * content-iso.js. The page disconnects when its turn ends, and navigating
 * away disconnects it too, so an interval can't outlive the turn it serves.
 */
chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== "lcfc-clock") return;
  let iv = null;
  const stop = () => { if (iv) { clearInterval(iv); iv = null; } };
  port.onMessage.addListener((m) => {
    if (iv || !m || !m.everyMs) return;
    const ms = Math.min(5000, Math.max(100, Number(m.everyMs) || 400));
    iv = setInterval(() => {
      try { port.postMessage(1); } catch (_) { stop(); }
    }, ms);
  });
  port.onDisconnect.addListener(stop);
});

const MAX_RELOAD_RETRIES = 2;
// How many pages may pick up one turn after redirects (see loader-claim).
// Grok's bounce is two pages (/tos-gate, then home); this leaves headroom
// without letting a page that bounces forever hold a turn.
const MAX_TURN_CLAIMS = 4;
// How long a load event gets to prove itself before it counts as a lost
// prompt. This is NOT "how long an engine takes to answer" — that is
// unknowable and is what the 90s watchdog is for. It is only how long the
// content script needs to run at document_start and call `loader-verify`,
// which is bounded by extension injection rather than by the site, so it
// stays stable across engines, machines and network conditions.
const RELOAD_VERIFY_WAIT_MS = 8000;
/* What a loader tab did during its turn, seen from outside the page: each
 * load start (L) and finish (C), where it went, and whether Chrome froze or
 * discarded it. Every Grok turn in a real v0.43 run timed out with the page
 * not answering at all — no page-side report can explain a page that isn't
 * running — so the timeout carries this instead. Host and path only (ids
 * folded): the query string holds the prompt.
 */
function tabPlace(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return u.protocol.replace(":", "");
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/[0-9a-f][0-9a-f-]{15,}/gi, ":id")).slice(0, 60);
  } catch (_) { return "?"; }
}
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (!loader.running) return;
  const found = legForTab(tabId);
  if (!found || !found.leg.startedAt) return;
  const { leg } = found;
  const bits = [];
  if (changeInfo.status === "loading") bits.push("L");
  if (changeInfo.status === "complete") bits.push("C");
  if (changeInfo.url) bits.push(tabPlace(changeInfo.url));
  if (changeInfo.discarded) bits.push("discarded");
  if (changeInfo.frozen !== undefined) bits.push(changeInfo.frozen ? "frozen" : "unfrozen");
  if (!bits.length) return;
  noteTabEvent(leg, bits.join(","));
});

// One entry in the turn's tab log, timed from the turn's start. Also carries
// the run's own events for the tab (a page claiming the turn, the send), so
// the log reads as one sequence.
function noteTabEvent(leg, what) {
  if (!leg || !leg.startedAt) return;
  if (leg.navLogToken !== leg.token) { leg.navLog = []; leg.navLogToken = leg.token; }
  if (leg.navLog.length < 24) leg.navLog.push(`${((Date.now() - leg.startedAt) / 1000).toFixed(1)}s:${what}`);
}

// The tab itself, when its page doesn't answer: frozen, discarded, still
// loading, a verification page (judged from the title, which is not kept),
// or where it ended up.
async function tabFacts(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      status: tab.status || "?",
      frozen: !!tab.frozen,
      discarded: !!tab.discarded,
      where: tabPlace(tab.url || tab.pendingUrl || ""),
      challenge: /just a moment|attention required|verify you are human|checking your browser|are you a robot/i.test(tab.title || ""),
    };
  } catch (_) {
    return { status: "gone", frozen: false, discarded: false, where: "?", challenge: false };
  }
}

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const found = legForTab(tabId);
  if (!found) return;
  const { plat, leg } = found;
  if (!loader.running || loader.paused || leg.paused) return;
  if (!leg.startedAt || leg.idx >= leg.prompts.length) return; // no turn in flight on this leg
  if (Date.now() < (leg.navGraceUntil || 0)) return; // still settling our own navigation

  /* Positive evidence beats elapsed time.
   *
   * `loader-verify` fires from the content script on every real document
   * load carrying this turn's token — so once it has matched, the prompt is
   * demonstrably in the content script's hands and this turn is under way.
   * Every navigation after that point is the engine doing its normal job:
   * accepting the prompt and moving the tab to the conversation it just
   * created. Treating those as a spontaneous reload is what made two
   * consecutive real runs lose the large majority of their prompts to "tab
   * reloaded repeatedly" across all four engines at once — and because each
   * retry re-issues the navigation, which produces the next late load event,
   * the retry caused the next detection and the turn burned its whole budget
   * in seconds. A verified turn that then genuinely dies is still covered:
   * the content script reports its own submit failures, and the watchdog
   * closes out anything that goes quiet.
   */
  if (leg.verifiedToken && leg.verifiedToken === leg.token) return;

  // Not yet verified. This is still far more likely to be our own navigation
  // (slow engine, or the second load cycle one chrome.tabs.update produces)
  // than a lost prompt, so give the content script its window to claim the
  // turn rather than retrying into the same cycle. One pending check per
  // turn: a slow load emits several loading events, and letting each arm its
  // own timer would spend the whole retry budget in a single burst.
  if (leg.reloadCheckPending) return;
  leg.reloadCheckPending = true;
  const token = leg.token;
  setTimeout(() => {
    leg.reloadCheckPending = false;
    if (!loader.running || loader.paused || leg.paused) return;
    if (leg.token !== token) return; // this turn is already over
    if (leg.verifiedToken === token) return; // the content script claimed it

    // Nothing ever claimed this turn: the tab really did land somewhere
    // without the prompt, which is the case this recovery path exists for.
    leg.reloadRetries = (leg.reloadRetries || 0) + 1;
    if (leg.reloadRetries > MAX_RELOAD_RETRIES) {
      // Reloading repeatedly without ever completing isn't a one-off
      // discard-and-reactivate — stop retrying and let it fail normally
      // rather than looping on a tab that will apparently never hold still.
      failTurnAndAdvance(plat, leg, "tab reloaded repeatedly", 500);
      return;
    }
    logErr(`run:tab-reloaded:${plat}`, "Loader tab reloaded mid-turn — retrying", {
      platform: plat,
      promptIndex: geoIdxOf(leg, leg.idx),
      totalPrompts: platformTotal(plat),
      attempt: leg.reloadRetries,
      runId: loader.runId,
    });
    loaderRunLeg(plat, leg);
  }, RELOAD_VERIFY_WAIT_MS);
});

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
  // Was a hardcoded literal list of all 5 engine ids, so blocking one in the
  // ENGINES registry (available:false) only hid it from the picker UI —
  // anything already in `platforms` (a stale saved profile, a hand-built
  // message) still ran here regardless of the registry. Deriving from
  // availableEngines() makes the registry the actual gate, not just cosmetic.
  const ids = availableEngines().map((e) => e.id);
  const supported = platforms.filter((p) => ids.includes(p));
  if (!supported.length) return { ok: false, error: "Select at least one supported AI engine." };

  // PRE-FLIGHT AUTH GATE — before newLoaderState(), before any window or tab
  // is created, and before the run is written to the "runs" store. Running
  // while signed out is a quiet, expensive failure: prompts get typed into a
  // login wall, every turn records as a failure or an empty capture, and the
  // whole prompt list is burned before anyone notices. Checking here (by
  // session cookie — the only signal available WITHOUT opening a tab, which
  // is the entire point) means nothing has happened yet when we refuse, so
  // there is nothing to unwind.
  //
  // `options.skipAuthCheck` is the user's explicit override from the warning
  // dialog. It is honoured because our cookie names are vendor internals
  // that can churn — see the three-state note in lib/auth-check.js — so the
  // user must always be able to say "I really am signed in, proceed."
  if (!(options && options.skipAuthCheck)) {
    try {
      const auth = await checkEnginesAuth(supported, (q) => chrome.cookies.getAll(q));
      if (!auth.ok) {
        return {
          ok: false,
          error: auth.message,
          authBlocked: true,
          signedOut: auth.signedOut.map((r) => ({ engine: r.engine, label: r.label, loginUrl: r.loginUrl })),
          unknown: auth.unknown.map((r) => ({ engine: r.engine, label: r.label, loginUrl: r.loginUrl })),
        };
      }
    } catch (_) {
      // Our own check failing must never block the user's run — fall through
      // and let it proceed exactly as it did before this gate existed.
    }
  }

  loader = newLoaderState();
  loader.running = true;
  loader.options = options || {};
  // Careful pace (Settings) for the whole run (lib/pacing.js).
  if (loader.options.careful === undefined) { try { loader.options.careful = !!(await getSettings()).carefulPace; } catch (_) { loader.options.careful = false; } }
  loader.total = clean.length * supported.length;
  // A campaign run passes its geo run id through so the run is known by ONE
  // id everywhere. It used to mint a second, unrelated one here — every log
  // entry and capture got this one, the campaign's run record got the other,
  // and nothing linked them, so the campaign diagnostics export (which looks
  // runs up by the campaign's id) could never find a single log entry.
  loader.runId = (options && options.geo && options.geo.runId) || crypto.randomUUID();
  loader.startedAt = Date.now();
  loader.pausedMs = 0;
  loader.pausedAt = null;
  loader.windowId = null;
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
      return { ok: false, incognitoBlocked: true, error: "To run signed out, allow CitoSkeleton in private windows first: chrome://extensions → CitoSkeleton → Details → Allow in Incognito." };
    }
    try {
      const win = await chrome.windows.create({ incognito: true });
      windowId = win.id;
      loader.windowId = windowId;
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
  const runTabIds = [];
  // "Retry missing" (0.78.1): each engine asks only the prompts it is
  // missing, given as positions in the full list.
  const only = options && options.only;
  for (const plat of supported) {
    const pick = only ? (only[plat] || []).filter((i) => Number.isInteger(i) && i >= 0 && i < clean.length) : null;
    if (pick && !pick.length) continue;
    const list = pick ? pick.map((i) => clean[i]) : clean;
    const shards = shardPrompts(list, tabsForEngine(plat, { careful: !!loader.options.careful })).filter((s) => s.prompts.length > 0);
    const legs = [];
    for (const shard of shards) {
      const created = windowId
        ? await chrome.tabs.create({ windowId, url: "about:blank" })
        : await chrome.tabs.create({ url: "about:blank", active: false });
      runTabIds.push(created.id);
      // Loader tabs sit backgrounded for the whole run — 4 heavy engine SPAs
      // at once is exactly what Chrome's Memory Saver targets for automatic
      // discarding, and a discarded tab reloads itself the instant anything
      // touches it, which the chrome.tabs.onUpdated listener below reads as
      // "Loader tab reloaded mid-turn" and retries, then fails after
      // MAX_RELOAD_RETRIES. Opting each tab out up front is what stops the
      // browser from ever unloading it mid-run in the first place — this is
      // a real, observed failure mode (a run losing the large majority of
      // its prompts to "tab reloaded repeatedly" across every engine within
      // minutes of starting), not a defensive guess.
      chrome.tabs.update(created.id, { autoDiscardable: false }).catch(() => {});
      legs.push({
        tabId: created.id, startOffset: shard.startOffset, prompts: shard.prompts,
        ...(pick ? { geoIdx: pick.slice(shard.startOffset, shard.startOffset + shard.prompts.length) } : {}),
        idx: 0, failed: 0, lastAdvanceAt: 0, durations: [], outcomes: [],
      });
    }
    loader.platforms[plat] = { legs };
  }
  if (only) loader.total = Object.values(loader.platforms).reduce((n, pd) => n + pd.legs.reduce((m, l) => m + l.prompts.length, 0), 0);
  if (only && !loader.total) { loader.running = false; return { ok: false, error: "Nothing is missing from this run." }; }
  // Every engine tab this run owns, grouped and collapsed so they don't take
  // over the window — one shared group for the whole run rather than one per
  // engine, since the point is minimizing footprint, not organizing by
  // platform. Best-effort: a browser too old for chrome.tabGroups, or a
  // grouping call that races a tab the user already closed, must never fail
  // the run over a footprint nicety.
  try {
    if (runTabIds.length && chrome.tabs.group) {
      const groupId = await chrome.tabs.group({ tabIds: runTabIds });
      if (chrome.tabGroups && chrome.tabGroups.update) {
        await chrome.tabGroups.update(groupId, { title: "CitoSkeleton", collapsed: true });
      }
    }
  } catch (_) { /* footprint nicety only — never block the run over it */ }
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
async function geoRunRetry(profileId, runId, runOpts = {}) {
  const run = await db.get("geoRuns", runId);
  if (!run || run.profileId !== profileId) return { ok: false, error: "Run not found." };
  if (run.status === "running") return { ok: false, error: "That run is still going." };
  const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === profileId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const m = missingTurns(run, prompts, await db.getAll("derived"));
  for (const e of Object.keys(m.only)) if (!availableEngines().some((a) => a.id === e)) delete m.only[e];
  if (!m.count) return { ok: false, error: "Nothing is missing from this run." };
  const res = await loaderStart(m.prompts.map((p) => p.text), {
    platforms: Object.keys(m.only).filter((e) => m.only[e].length),
    only: m.only,
    geo: { profileId, runId, retryBase: { captured: run.captured || 0, failed: run.failed || 0, activeMs: runTookMs(run) || 0 } },
    geoPrompts: m.prompts.map((p) => ({ id: p.id, tags: p.tags || [] })),
    skipAuthCheck: !!runOpts.skipAuthCheck || !!run.privateWindow,
    incognito: !!run.privateWindow,
  });
  if (!res.ok) return res;
  await db.put("geoRuns", { ...run, status: "running", finishedAt: null });
  return { ok: true, geoRunId: runId, retrying: m.count, loaderRunId: res.runId };
}

/* Campaigns waiting their turn (0.80.0). Asked: two campaigns for two brands
 * should both run and each keep its own answers. One run drives the engine
 * tabs at a time (two at once would double the automated traffic on the
 * same accounts), so a campaign started during another's run is queued and
 * starts by itself when that run finishes or is stopped. Kept in storage so
 * a restart doesn't lose the queue. */
const RUN_QUEUE_KEY = "lcfcRunQueue";
async function loadRunQueue() {
  try { const got = await chrome.storage.local.get(RUN_QUEUE_KEY); return Array.isArray(got[RUN_QUEUE_KEY]) ? got[RUN_QUEUE_KEY] : []; } catch (_) { return []; }
}
async function enqueueRun(profileId, runOpts) {
  const profile = await db.get("profiles", profileId);
  if (!profile) return { ok: false, error: "Campaign not found." };
  const running = loader.options && loader.options.geo && loader.options.geo.profileId;
  if (running === profileId && !runOpts.retryRunId) return { ok: false, error: "This campaign is already running." };
  const q = await loadRunQueue();
  if (!q.some((x) => x.profileId === profileId)) q.push({ profileId, runOpts, name: profile.name || "", queuedAt: Date.now() });
  await chrome.storage.local.set({ [RUN_QUEUE_KEY]: q });
  return { ok: true, queued: true, position: q.findIndex((x) => x.profileId === profileId) + 1 };
}
let startingQueued = false;
function startNextQueued() {
  if (startingQueued) return;
  startingQueued = true;
  // A moment for the finished run's tabs to close first.
  setTimeout(async () => {
    try {
      while (!loader.running) {
        const q = await loadRunQueue();
        if (!q.length) break;
        const [next, ...rest] = q;
        await chrome.storage.local.set({ [RUN_QUEUE_KEY]: rest });
        // The sign-in check was offered when it was queued; a gate now would
        // have no one to answer it, so it isn't repeated.
        const res = await geoRunStart(next.profileId, { ...(next.runOpts || {}), skipAuthCheck: true });
        if (res && res.ok) {
          logEvent("run:queue-start", "turn", `started the queued campaign "${next.name || next.profileId}"`, { profileId: next.profileId });
          break;
        }
        logErr("run:queue-start", (res && res.error) || "couldn't start", { profileId: next.profileId });
      }
    } catch (e) {
      logErr("run:queue-start", e);
    } finally {
      startingQueued = false;
    }
  }, 3000);
}

async function geoRunStart(profileId, runOpts = {}) {
  if (runOpts.retryRunId) return geoRunRetry(profileId, runOpts.retryRunId, runOpts);
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

  // Same fix as loaderStart's `supported` above and for the same reason:
  // this used to be a hardcoded literal list of all 5 ids, which is not a
  // real gate — a campaign saved before an engine got blocked keeps it in
  // profile.engines (makeProfile() only re-filters on the NEXT save), and
  // this line would have happily run it anyway. availableEngines() is the
  // one place that decides "can this actually run", enforced here where the
  // run is kicked off, not just in the picker UI.
  let engines = (profile.engines || []).filter((e) => availableEngines().some((a) => a.id === e));
  if (!engines.length) return { ok: false, error: "Select at least one engine with an active adapter." };
  // Signed out, Grok's page sent no chat request at all for any prompt in
  // the owner's run (0.69.0): it needs an account. It is left out and the
  // run says so rather than timing out on every prompt.
  const leftOut = runOpts.privateWindow ? engines.filter((e) => e === "grok") : [];
  if (leftOut.length) engines = engines.filter((e) => !leftOut.includes(e));
  if (!engines.length) return { ok: false, error: "Grok needs a signed-in account, so it can't run signed out. Pick another engine for this campaign." };

  const vol = runVolume(prompts, engines);
  const geoRunId = crypto.randomUUID();

  const res = await loaderStart(
    prompts.map((p) => p.text),
    {
      platforms: engines,
      geo: { profileId, runId: geoRunId },
      geoPrompts: prompts.map((p) => ({ id: p.id, tags: p.tags || [] })),
      // Forwarded so the user's "Run anyway" override from the sign-in
      // dialog reaches loaderStart's pre-flight gate. Campaign runs go
      // through here rather than calling loaderStart directly, so without
      // this the override would be silently dropped and the dialog would
      // reappear forever.
      skipAuthCheck: !!runOpts.skipAuthCheck || !!runOpts.privateWindow,
      // Signed out (0.66.0): the run opens its own private window, whose
      // cookie store has no engine session, so the answers carry no
      // account history or memory. Being signed out there is the point, so
      // the sign-in check is skipped.
      incognito: !!runOpts.privateWindow,
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
    ...(runOpts.privateWindow ? { privateWindow: true } : {}),
  }));
  // Stamp the cadence clock now rather than on completion: the "run due today"
  // reminder should not keep nagging through a run that is already in flight.
  await db.put("profiles", { ...profile, lastRunAt: Date.now() });

  return { ok: true, geoRunId, ...vol, loaderRunId: res.runId, ...(leftOut.length ? { leftOut } : {}) };
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
// One comparison, shared by the two places that ask "is this capture's
// question this prompt?" — crediting a capture to the run (loaderOnCapture)
// and deciding which prompt it's filed under (attributeCaptureToPrompt) —
// so they can never disagree. Loose on purpose: adapters normalise
// whitespace differently from the string the run navigated with.
// Folded hard enough that the same question still matches after an engine
// echoes it back escaped or re-punctuated (0.79.0): signed-out ChatGPT reads
// it from page markup, where quotes and ampersands arrive as entities, and a
// real answer was dropped as a "late capture" over a curly apostrophe.
const ENTITY = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function normPrompt(t) {
  return String(t || "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITY[e.toLowerCase()] ?? m;
    })
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function promptTextMatches(a, b) {
  const x = normPrompt(a), y = normPrompt(b);
  if (!x || !y) return false;
  return y.includes(x.slice(0, 60)) || x.includes(y.slice(0, 60));
}

/* Which of this leg's prompts a campaign capture actually answers.
 *
 * The capture handler files each capture under the prompt the tab is on WHEN
 * THE ANSWER ARRIVES. That's right for an answer that lands in time, and
 * wrong for every one that doesn't: a turn that times out often finishes
 * afterwards, by which point the leg has moved on, so its answer was stored
 * under the NEXT prompt — and once a leg had finished its batch, under the
 * first prompt of another batch entirely. A real 40-prompt run showed several
 * of these, silently feeding one prompt's answer into another's metrics.
 * The run itself already refused to COUNT such captures (loaderOnCapture);
 * it just filed them wrong.
 *
 * Returns null to keep the position-based guess, which it does whenever it
 * can't be sure: no usable question text, the text agrees with the position
 * anyway, or it matches no prompt (or several) in this tab's batch. Only
 * this leg's own prompts are searched — the answer came from this tab, and
 * this tab only ever ran this batch.
 */
function attributeCaptureToPrompt(leg, record) {
  const got = record && record.userPrompt;
  // Too short to outweigh the tab's position — a scraped clock ("2:16 PM")
  // or a stray fragment would otherwise match whatever happened to contain it.
  if (normPrompt(got).length < 12) return null;
  const geoPrompts = loader.options.geoPrompts || [];
  const atPosition = leg.prompts[leg.idx];
  if (atPosition && promptTextMatches(atPosition, got)) return null;
  const hits = [];
  leg.prompts.forEach((text, i) => { if (promptTextMatches(text, got)) hits.push(geoIdxOf(leg, i)); });
  if (hits.length === 1) {
    const tp = geoPrompts[hits[0]] || {};
    return tp.id ? { promptId: tp.id, tags: tp.tags || [] } : null;
  }
  // Past the end of its batch, the position guess names another batch's
  // prompt — certainly wrong — so leave the capture unattributed instead.
  if (leg.idx >= leg.prompts.length) return { promptId: null, tags: [] };
  return null;
}

/* Whether a campaign capture built from Perplexity's thread LIST should be
 * thrown away rather than stored. Returns the reason, or null to keep it.
 *
 * Perplexity pushes the account's recent-threads list over its GraphQL
 * socket, and when no real answer stream is intercepted that list is all a
 * capture holds: the adapter takes the newest thread's title as the question
 * and that thread's truncated preview as the answer. In a real 40-prompt run
 * every network capture from Perplexity was this, and it goes wrong in three
 * ways a campaign can't afford:
 *   - the list is ACCOUNT-WIDE, so with two Perplexity tabs running, one
 *     tab's capture is usually the OTHER tab's newest thread;
 *   - campaigns re-ask identical prompts every run, so last week's thread
 *     with the same title is indistinguishable by title alone;
 *   - with no preview for the thread it names, the "capture" is empty.
 * Only a preview for one of this tab's own prompts, from a thread updated
 * during this run, is kept. Ad-hoc browsing captures never reach this.
 */
const PREVIEW_CLOCK_SLACK_MS = 60 * 1000; // thread times are Perplexity's clock, not this machine's
function isUnusableCampaignPreview(leg, record) {
  const ps = record && record.platformSpecific;
  const src = ps && ps.answerSource;
  if (!src || src === "real") return null;
  if (src === "none") return record.sources && record.sources.length ? null : "thread list only, no answer for the thread it names";
  if (!leg.prompts.some((t) => promptTextMatches(t, record.userPrompt))) return "thread list names another tab's prompt";
  const at = Date.parse(ps.previewUpdatedAt || "");
  if (Number.isFinite(at) && loader.startedAt && at < loader.startedAt - PREVIEW_CLOCK_SLACK_MS) {
    return "thread list preview is from before this run";
  }
  return null;
}

// A ChatGPT copy handed over because the stream went quiet may be an answer
// paused mid-search (0.79.0). The turn waits this long for the stream's end
// line or its close; a later copy replaces it, and without one this copy
// completes the turn. Before 0.79.0 such a copy completed the turn at once,
// the next prompt navigated the tab away, and the rest of the answer was lost.
const QUIET_SETTLE_MS = 6000;
const quietHolds = new WeakMap(); // leg -> { timer, record }

function loaderOnCapture(tabId, record, end) {
  if (!loader.running) return;
  const found = legForTab(tabId);
  if (!found) return;
  const { plat, leg } = found;

  /* Only a turn that is actually in flight can be completed.
   *
   * After a turn completes, the next prompt is only sent 2-8s later (the
   * pacing gap), and until then the leg still expects the OLD prompt. Gemini
   * sends several captures per answer, so a second capture of the answer
   * just counted landed in that gap, matched the old prompt, and "completed"
   * the next prompt before it was ever asked — skipping it while the run
   * logged it as ok. A real run had four such phantom turns on Gemini alone,
   * two past the end of their legs ("prompt 10" of 10), and reported 35/40
   * captured with far fewer prompts actually asked. MIN_ADVANCE_GAP_MS
   * couldn't catch it: the second capture came 3-4s after the first.
   */
  if (leg.idx >= leg.prompts.length || leg.inFlightIdx !== leg.idx) return;

  // The engine says this account has hit its limit (Grok's gateway sends it
  // as a stream_error). Pause this engine's legs on the same cooldown a limit
  // seen on the page gets; the prompt is asked again when it resumes. Until
  // 0.62.2 these turns were logged "ok" with no answer.
  const limit = usageLimitOf(record);
  if (limit) {
    logErr(`run:usage-limit:${plat}`, `${plat}: usage limit reached`, { platform: plat, promptIndex: geoIdxOf(leg, leg.idx), runId: loader.runId, detail: limit });
    // A limit that doesn't lift (0.78.1): signed out, ChatGPT's anonymous
    // limit can last the day, and each cooldown only met it again. After
    // MAX_LIMIT_STREAK cooldowns in a row with no answer between them, this
    // engine's remaining prompts are marked "usage limit" so the run can
    // finish; "Retry missing" asks them again later.
    const pd = loader.platforms[plat];
    pd.limitStreak = (pd.limitStreak || 0) + 1;
    if (pd.limitStreak > MAX_LIMIT_STREAK) {
      for (const l of pd.legs || []) {
        clearWatchdog(l);
        l.paused = false;
        while (l.idx < l.prompts.length) failTurnAndAdvance(plat, l, `usage limit: ${plat} still limited after ${MAX_LIMIT_STREAK} cooldowns`, -1);
      }
      loaderRunLeg(plat, leg);
      return;
    }
    pauseForLimit(plat, `usage limit reached (${limit})`);
    return;
  }
  // Ignore empty race-loser captures — advancing on those silently SKIPS
  // prompts — and, on Grok's gateway, captures of an answer still on its way.
  if (!turnAnswered(record)) return;
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
  const wantPrompt = normPrompt(leg.expectedPrompt);
  const gotPrompt = normPrompt(record && record.userPrompt);
  if (wantPrompt && gotPrompt) {
    if (!promptTextMatches(wantPrompt, gotPrompt)) {
      logErr(`run:late-capture:${plat}`, "capture did not match the prompt in flight", {
        platform: plat,
        promptIndex: geoIdxOf(leg, leg.idx),
        totalPrompts: platformTotal(plat),
        runId: loader.runId,
      });
      return;
    }
  }

  const held = quietHolds.get(leg);
  if (held) { clearTimeout(held.timer); quietHolds.delete(leg); }
  if (plat === "chatgpt" && end === "quiet") {
    const token = leg.token, idx = leg.idx;
    quietHolds.set(leg, {
      record,
      timer: setTimeout(() => {
        quietHolds.delete(leg);
        if (!loader.running || leg.token !== token || leg.idx !== idx || leg.inFlightIdx !== idx) return;
        completeTurn(plat, leg, record);
      }, QUIET_SETTLE_MS),
    });
    return;
  }
  completeTurn(plat, leg, record);
}

function completeTurn(plat, leg, record) {
  clearWatchdog(leg);
  const turnElapsedMs = leg.startedAt ? Date.now() - leg.startedAt : 0;
  if (leg.startedAt) leg.durations = [...(leg.durations || []), turnElapsedMs].slice(-DURATION_WINDOW);
  leg.outcomes = leg.outcomes || [];
  leg.outcomes[leg.idx] = { status: "done", reason: null, at: Date.now() };
  noteFinish(leg);
  leg.lastAdvanceAt = Date.now();
  loader.done++;
  if (loader.platforms[plat]) loader.platforms[plat].limitStreak = 0;
  leg.inFlightIdx = -1;
  const donePromptIndex = geoIdxOf(leg, leg.idx);
  const reloadRetriesAtSuccess = leg.reloadRetries || 0;
  leg.idx++;
  // This leg is genuinely moving to a new prompt now — the reload-retry
  // budget (chrome.tabs.onUpdated listener below) is per-prompt, not
  // per-leg, so it resets here rather than carrying over to whatever comes
  // next.
  leg.reloadRetries = 0;
  // The success half of the durable per-turn timeline — see the matching
  // "turn" event in failTurnAndAdvance for why this exists as its own
  // category rather than living only in the live progress view.
  logEvent(`run:turn:${plat}`, "turn", "ok", {
    platform: plat, promptIndex: donePromptIndex, status: "ok", elapsedMs: turnElapsedMs,
    retries: reloadRetriesAtSuccess, runId: loader.runId, captureId: record.captureId,
  });
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
  // No gap after a leg's last question: AI Mode's minute or two of waiting
  // kept a finished run "running" for nothing.
  const delay = leg.idx >= leg.prompts.length ? 0 : nextGapMs(plat, leg.sentTimes || [], Date.now(), Math.random(), { careful: !!loader.options.careful });
  if (!loader.paused && !leg.paused) setTimeout(() => loaderRunLeg(plat, leg), delay);
}

// Which of a campaign's answers a view shows: one run (`runId`), every
// answer ("all"), or by default the newest per prompt and engine (0.80.0).
// When the newest answers all come from one run (every engine ran together),
// that run is shown, with its change since the run before; only when engines
// ran in different runs is the default a mix of runs (`mixed`).
function pickCampaignAnswers(all, runs, want) {
  if (want === "all") return { runId: null, recs: all, latestMode: false, mixed: latestRunsOf(all) > 1 };
  if (want && want !== "latest" && runs.some((r) => r.id === want)) return { runId: want, recs: all.filter((r) => r.geo && r.geo.runId === want), latestMode: false, mixed: latestRunsOf(all) > 1 };
  const latest = latestAnswers(all);
  const from = [...new Set(latest.map((r) => r.geo && r.geo.runId).filter(Boolean))];
  if (from.length === 1) return { runId: from[0], recs: all.filter((r) => r.geo && r.geo.runId === from[0]), latestMode: false, mixed: false };
  return { runId: null, recs: latest, latestMode: true, mixed: true };
}
function latestRunsOf(all) {
  return new Set(latestAnswers(all).map((r) => r.geo && r.geo.runId).filter(Boolean)).size;
}

// Strip heavy fields for list/aggregate views. The full record (with answerText)
// is fetched per capture by `get-record` when Analyze opens it.
function toLight(r) {
  const { answerText, platformSpecific, ...rest } = r;
  const ps = platformSpecific || {};
  const { reasoning, ...psLight } = ps;
  return { ...rest, platformSpecific: psLight, hasAnswerText: !!(answerText && answerText.length) };
}

const EXT_BASE = chrome.runtime.getURL("");
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A script inside a web page may send only what those scripts really
  // send (0.84.1, lib/senderGate.js): never "give me a stored answer" or
  // "delete everything".
  if (!mayHandle(msg, sender, EXT_BASE)) {
    logEvent("message:refused", "capture", "a page script sent a message only the extension's own pages may send", { type: String((msg && msg.type) || "").slice(0, 40) });
    try { sendResponse({ ok: false, error: "not allowed from a web page" }); } catch (_) { /* closed */ }
    return false;
  }
  (async () => {
    try {
      switch (msg?.type) {
        // "Continue in…" (0.76.0).
        case "handoff-open":
          try { sendResponse(await handoffOpen(msg)); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        case "handoff-claim": {
          const tid = sender && sender.tab && sender.tab.id;
          let job = tid != null ? handoffJobs.get(tid) : null;
          // The text is given only to the AI site it was meant for (0.84.1).
          if (job && !onEngineSite((sender && sender.url) || "", (HANDOFF_ENGINES[job.engine] || {}).url || "")) job = null;
          if (job) handoffJobs.delete(tid);
          sendResponse(job ? { ok: true, text: job.text, autoSend: job.autoSend, engine: job.engine } : { ok: false });
          break;
        }
        case "handoff-result": {
          const r = { ok: !!msg.ok, sent: !!msg.sent, how: String(msg.how || ""), error: msg.error ? String(msg.error).slice(0, 200) : null, at: Date.now() };
          if (!r.ok) logEvent("handoff:failed", "capture", r.error || "hand-off failed", {});
          try { await chrome.storage.session.set({ lcfcHandoffLast: r }); } catch (_) { /* best effort */ }
          broadcast({ type: "handoff-result", ...r });
          sendResponse({ ok: true });
          break;
        }
        // A campaign's findings (lib/insights.js), for the hand-off pack.
        case "campaign-insights": {
          const [records, profiles, runs] = await Promise.all([db.getAll("derived"), db.getAll("profiles"), db.getAll("geoRuns")]);
          // The campaign asked for, else the one run most recently.
          const lastRun = (p) => runs.filter((g) => g.profileId === p.id).reduce((m, g) => Math.max(m, g.startedAt || 0), 0);
          const profile = profiles.find((p) => p.id === msg.profileId) || [...profiles].sort((a, b) => lastRun(b) - lastRun(a))[0];
          const I = profile ? campaignInsights({ records, profile, runs, runId: msg.runId || null, engines: msg.engines || null }) : null;
          sendResponse({ ok: !!I, insights: I ? { ...I, refs: undefined } : null });
          break;
        }

        // The capture check (0.73.1): what each engine page saw, and why a
        // capture went nowhere.
        case "capture-health": {
          const row = msg.row || {};
          const engine = platformFromUrl(msg.pageUrl || (sender && sender.tab && sender.tab.url));
          noteCapture(engine, row.ev === "conv" ? { kind: "conv", path: row.path, method: row.method, status: row.status, at: row.at } : { kind: "unknown", ev: row.ev, path: row.path, method: row.method, ctype: row.ctype, at: row.at });
          sendResponse({ ok: true });
          break;
        }
        case "capture-drop": {
          const engine = platformFromUrl(msg.pageUrl || (sender && sender.tab && sender.tab.url));
          noteCapture(engine, { kind: "drop", reason: String(msg.reason || "unknown").slice(0, 40) });
          sendResponse({ ok: true });
          break;
        }
        case "capture-check": {
          const [got, tabs, settings] = await Promise.all([chrome.storage.local.get(HEALTH_KEY), engineTabsHealth(), getSettings()]);
          const health = got[HEALTH_KEY] || emptyHealth();
          const paused = !!settings.capturePaused;
          let derived = null, manual = null;
          try {
            const recs = await db.getAll("derived");
            derived = recs.length;
            manual = recs.filter((r) => !r.geo).length;
          } catch (_) { /* counts unknown */ }
          const counts = { derived, manual };
          const engines = HEALTH_ENGINES.map((e) => verdict(e, health[e], tabs, { paused }));
          sendResponse({ ok: true, version: BUILD, paused, tabs, health, engines, counts, retentionMax: settings.retentionMax, report: healthReport({ version: BUILD, health, tabs, paused, counts, retentionMax: settings.retentionMax }) });
          break;
        }
        // A question sent by hand in an engine tab (0.84.0), for the missed-
        // answer notice. A campaign's own tabs are left out: the run reports
        // its misses itself.
        case "user-asked": {
          const tabId = sender && sender.tab && sender.tab.id;
          if (tabId != null && !legForTab(tabId)) await noteCapture(platformFromUrl(sender.tab.url || ""), { kind: "asked", tabId });
          sendResponse({ ok: true });
          break;
        }
        // Was an answer stored for this engine since the question (0.84.0)?
        // The page copies ask this rather than trusting that something was
        // forwarded: after a format change the traffic still goes through,
        // it just can't be read.
        case "capture-stored-since": {
          const engine = platformFromUrl((sender && sender.tab && sender.tab.url) || "");
          const h = ((await chrome.storage.local.get(HEALTH_KEY))[HEALTH_KEY] || {})[engine] || {};
          sendResponse({ ok: true, stored: !!(h.stored && h.stored.at > Number(msg.since || 0)) });
          break;
        }
        case "capture-missed": {
          const got = await chrome.storage.local.get([HEALTH_KEY, MISSED_DISMISSED_KEY]);
          // afterMs: tests only, to wait less than the real 90 s.
          const afterMs = Number(msg.afterMs) >= 1000 ? Number(msg.afterMs) : undefined;
          sendResponse({ ok: true, missed: missedAnswers(got[HEALTH_KEY], Date.now(), got[MISSED_DISMISSED_KEY] || {}, afterMs ? { afterMs } : {}) });
          break;
        }
        case "capture-missed-dismiss": {
          const got = (await chrome.storage.local.get(MISSED_DISMISSED_KEY))[MISSED_DISMISSED_KEY] || {};
          await chrome.storage.local.set({ [MISSED_DISMISSED_KEY]: { ...got, [String(msg.engine)]: Date.now() } });
          sendResponse({ ok: true });
          break;
        }
        case "capture-refresh-tab": {
          try { await chrome.tabs.reload(Number(msg.tabId)); sendResponse({ ok: true }); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        }

        case "raw-conversation": {
          const tabId = sender?.tab?.id;
          const capEngine = platformFromUrl((msg.payload || {}).pageUrl || (msg.payload || {}).url);
          if (await capturePausedFor(sender)) { noteCapture(capEngine, { kind: "drop", reason: "paused" }); sendResponse({ ok: true, captureId: null, skipped: "paused" }); break; }
          let meta = null;
          if (!loader.running) await restoreRunIfAny().catch((err) => logErr("restoreRunIfAny", err));
          if (loader.running) {
            const found = legForTab(tabId);
            if (found) {
              const { leg } = found;
              meta = { projectId: loader.options.projectId || null, runId: loader.runId };
              // An answer that arrives but can't be read still ends in a
              // timeout — this lets that timeout say so (see describeTimeout).
              const turnToken = leg.token;
              meta.onUnreadable = (shape) => { leg.unreadable = { token: turnToken, shape }; };
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
                const originalIdx = geoIdxOf(leg, leg.idx);
                const tp = (loader.options.geoPrompts || [])[originalIdx] || {};
                meta.geo = {
                  profileId: g.profileId,
                  runId: g.runId,
                  promptId: tp.id || null,
                  tags: tp.tags || [],
                };
                // The position above is only a first guess — storeCapture
                // corrects it once the adapter has read the capture's question.
                meta.attributeGeo = (record) => attributeCaptureToPrompt(leg, record);
                meta.rejectCapture = (record) => isUnusableCampaignPreview(leg, record);
              }
            }
          }
          meta = { ...(meta || {}), session: await sessionOf(sender, platformFromUrl((msg.payload || {}).pageUrl || (msg.payload || {}).url), (msg.payload || {}).url) };
          let res;
          try {
            res = await storeCapture(msg.payload, meta);
          } catch (e) {
            noteCapture(capEngine, { kind: "drop", reason: "error" });
            throw e;
          }
          // The capture check: saved, or why not (0.73.1).
          if (res && res.skipped) noteCapture(capEngine, { kind: "drop", reason: res.skipped });
          else if (res && res.captureId && !res.record) noteCapture(capEngine, { kind: "drop", reason: "empty", path: endpointShape((msg.payload || {}).url, (msg.payload || {}).pageUrl) });
          else if (res && res.record) noteCapture(capEngine, { kind: "stored", captureId: res.captureId });
          if (res && res.captureId) {
            loaderOnCapture(tabId, res.record, (msg.payload || {}).end);
            // Notify the popup if it's open. Use a callback so a missing receiver
            // doesn't surface as an unhandled promise rejection.
            try {
              // duringRun lets the panel tell an expected campaign capture
              // from an ad-hoc browsing one. For a browsing capture the toast
              // IS the notification; during a run the progress card already
              // counts every prompt, so one toast per prompt is noise layered
              // over the thing the user is trying to read.
              // Only a new answer is announced (1.0.0). The owner saw "New
              // LLM citation captured!" again and again with nothing asked:
              // a Perplexity tab left open keeps making requests (related
              // questions, live updates) that are saved raw but hold no
              // answer, and a page re-sending an answer already stored was
              // announced again too. Those refresh the panel silently.
              chrome.runtime.sendMessage(
                res.record && res.isNew
                  ? { type: "new-capture", captureId: res.captureId, duringRun: !!loader.running }
                  : { type: "capture-updated", captureId: res.captureId },
                () => void chrome.runtime.lastError);
            } catch (_) {}
            // Deliberately NOT awaited: the capture is already saved and shown.
            enrichCaptureWithAI(res.record);
            // The built-in AI, when downloaded (0.70.0): queued, checked one at a time.
            await aiSvc.enqueue(res.record).catch(() => {});
            // Also not awaited, and only with the setting on (0.62.0).
            readCitedPages(res.captureId).catch(() => {});
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
            // Doubles as the run's proof that this turn's prompt reached the
            // page and the content script has taken it on — which is what
            // the reload detector (chrome.tabs.onUpdated, above) reads to
            // tell the engine's own post-submit navigation apart from a tab
            // that genuinely came back without the prompt. Recorded against
            // the token, so it can never carry over to a later turn.
            if (ok) found.leg.verifiedToken = msg.token;
          }
          sendResponse({ ok });
          break;
        }

        // The page this turn is running in saw its prompt go out: the
        // engine's own submit request, or the conversation moving on. From
        // here the turn is never handed to another page (loader-claim).
        case "loader-sent": {
          const tabId = sender?.tab?.id;
          const found = loader.running && tabId != null ? legForTab(tabId) : null;
          const ok = !!(found && found.leg.token && found.leg.token === msg.token);
          if (ok && found.leg.sentToken !== msg.token) {
            found.leg.sentToken = msg.token;
            found.leg.sentAt = Date.now();
            noteTabEvent(found.leg, "sent");
            persistLoaderState();
          }
          sendResponse({ ok });
          break;
        }

        /* A page without the run's markers, in a tab that had them, asking
         * whether a turn is waiting for it.
         *
         * The prompt reached the engine only in the tab's address, and a
         * reload or a cross-page redirect drops it. (Written after grok.com's
         * /tos-gate hop, which a later run showed happens inside the same
         * document — that one was a false "sent", fixed in content-iso.js.)
         * The run holds the prompt, so it hands the turn to the page the tab
         * ended up on — the same checks loader-verify makes, plus two of its own:
         * the page must be on this tab's engine, and the prompt must not
         * have gone out yet, so a redirect after a send can't send it twice.
         * Capped per turn, so a page that keeps bouncing can't loop.
         */
        case "loader-claim": {
          const tabId = sender?.tab?.id;
          const found = loader.running && !loader.paused && tabId != null && (sender.frameId || 0) === 0
            ? legForTab(tabId) : null;
          const leg = found && found.leg;
          let host = "";
          try { host = new URL(sender.url || "").hostname; } catch (_) { /* no host */ }
          const onEngine = !!found && (ENGINE_HOSTS[found.plat] || []).includes(host);
          const claims = leg && leg.claimToken === leg.token ? leg.claims || 0 : 0;
          const grant = !!leg && onEngine && !leg.paused && !!leg.token
            && leg.idx < leg.prompts.length && leg.inFlightIdx === leg.idx
            && leg.sentToken !== leg.token && claims < MAX_TURN_CLAIMS
            && typeof leg.expectedPrompt === "string" && !!leg.expectedPrompt;
          if (grant) {
            leg.claimToken = leg.token;
            leg.claims = claims + 1;
            leg.verifiedToken = leg.token; // the turn is in a page's hands again
            noteTabEvent(leg, "claimed");
            sendResponse({
              ok: true,
              token: leg.token,
              q: leg.expectedPrompt,
              search: found.plat === "chatgpt" && !!loader.options.forceSearch,
            });
          } else {
            if (leg && onEngine && leg.inFlightIdx === leg.idx) noteTabEvent(leg, leg.sentToken === leg.token ? "claim:sent" : "claim:refused");
            sendResponse({ ok: false });
          }
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
          if (matched) await pauseForLimit(matched, msg.detail);
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
          // A locked campaign is edited in place (0.77.0): only a new brand
          // or website still needs the explicit unlock. What changed is logged.
          if (existing && needsUnlock(existing, msg.profile) && !msg.unlockOverride) {
            sendResponse({ ok: false, error: "Changing the brand or website needs the campaign unlocked first.", needsUnlock: true });
            break;
          }
          const merged = { ...(existing || {}), ...msg.profile };
          const logged = existing && existing.locked && merged.locked !== false ? profileChanges(existing, makeProfile(merged)) : [];
          const profile = makeProfile({ ...merged, changes: [...(existing?.changes || []), ...logged] });
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
        // One click from the board (0.77.0): a brand the answers named becomes
        // a competitor, on a locked campaign too, logged in its changes.
        case "geo-competitor-add": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const names = Array.isArray(msg.names) ? msg.names : [msg.name];
          let cur = profile, added = [];
          for (const n of names) {
            const r = addCompetitor(cur, { name: n, url: msg.url || "" });
            if (r.error) { if (names.length === 1) { sendResponse({ ok: false, error: r.error }); cur = null; } break; }
            if (r.added) added.push(String(n).trim());
            cur = r.profile;
          }
          if (!cur) break;
          if (added.length) await db.put("profiles", cur);
          sendResponse({ ok: true, profile: cur, added });
          break;
        }
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

        // Share a campaign as a file, and open one (0.82.0). The file is the
        // whole campaign: setup, prompts, runs, answers and raw captures.
        case "campaign-bundle-export": {
          const r = await exportCampaignFile(msg.profileId, { includeRaw: msg.includeRaw !== false });
          sendResponse(r.ok ? { ok: true, data: bufToB64(r.file), bytes: r.file.byteLength, fileName: r.fileName, counts: r.counts } : r);
          break;
        }
        case "campaign-bundle-import": {
          let bundle;
          try { bundle = await decodeBundle(b64ToBuf(msg.data)); } catch (e) { sendResponse({ ok: false, error: e.message }); break; }
          sendResponse(await importCampaignBundle(bundle));
          break;
        }

        // Accounts and shared codes (0.82.0). Each says plainly when accounts
        // aren't switched on, rather than failing somewhere later.
        case "cloud-status": {
          const s = cloudOn() ? await cloud.session().catch(() => null) : null;
          sendResponse({ ok: true, ready: cloudOn(), signedIn: !!s, user: s ? s.user : null });
          break;
        }
        case "cloud-request-code":
        case "cloud-verify":
        case "cloud-sign-out":
        case "cloud-profile-save":
        case "cloud-shares":
        case "cloud-share-revoke":
        case "campaign-share-upload":
        case "campaign-share-open": {
          if (!cloudOn()) { sendResponse({ ok: false, off: true, error: "Accounts aren't switched on yet. Share the campaign as a file instead." }); break; }
          try {
            if (msg.type === "cloud-request-code") {
              const r = checkEmail(msg.email);
              if (!r.ok) { sendResponse({ ok: false, error: r.message }); break; }
              await cloud.requestCode(r.email);
              sendResponse({ ok: true, email: r.email });
            } else if (msg.type === "cloud-verify") {
              const s = await cloud.verifyCode(msg.email, msg.code);
              const p = await cloud.getProfile().catch(() => null);
              if (p && p.display_name) await chrome.storage.local.set({ [CLOUD_SESSION_KEY]: { ...s, user: { ...s.user, name: p.display_name } } });
              sendResponse({ ok: true, user: { ...s.user, name: (p && p.display_name) || "" } });
            } else if (msg.type === "cloud-sign-out") {
              sendResponse(await cloud.signOut());
            } else if (msg.type === "cloud-profile-save") {
              sendResponse({ ok: true, profile: await cloud.saveProfile(msg.name) });
            } else if (msg.type === "cloud-shares") {
              sendResponse({ ok: true, shares: await cloud.shareList() });
            } else if (msg.type === "cloud-share-revoke") {
              sendResponse(await cloud.shareRevoke(msg.code));
            } else if (msg.type === "campaign-share-upload") {
              const r = await exportCampaignFile(msg.profileId, { includeRaw: msg.includeRaw !== false });
              if (!r.ok) { sendResponse(r); break; }
              const up = await cloud.shareUpload(r.file, { name: r.name, counts: r.counts });
              sendResponse({ ok: true, code: up.code, expiresAt: up.expiresAt, bytes: r.file.byteLength });
            } else {
              const got = await cloud.shareFetch(msg.code);
              sendResponse(await importCampaignBundle(await decodeBundle(got.bytes), { from: got.meta.from }));
            }
          } catch (e) {
            sendResponse({ ok: false, error: e.message, signedOut: e.status === 401 });
          }
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
          if (existing && existing.text !== prompt.text) await logCampaignChange(prompt.profileId, { kind: "prompt-edited", name: existing.text.slice(0, 120) });
          else if (existing && (existing.tags || []).join("\u0001") !== (prompt.tags || []).join("\u0001")) await logCampaignChange(prompt.profileId, { kind: "tags", name: prompt.text.slice(0, 120) });
          else if (!existing) await logCampaignChange(prompt.profileId, { kind: "prompts-added", count: 1 });
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
          if (added.length) await logCampaignChange(msg.profileId, { kind: "prompts-added", count: added.length });
          sendResponse({ ok: true, added: added.length, duplicates });
          break;
        }
        case "geo-prompt-delete": {
          const gone = await db.get("trackedPrompts", msg.id);
          await db.delete("trackedPrompts", msg.id);
          if (gone) await logCampaignChange(gone.profileId, { kind: "prompt-removed", name: String(gone.text || "").slice(0, 120) });
          sendResponse({ ok: true });
          break;
        }
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

        /* The export dialog (0.52.0): an Excel workbook or CSV tables, or just
         * the row counts its "What you get" shows. Built here because
         * positions need the answer text the panel's rows don't carry. The
         * reply is the file's parts as text — the panel zips them — so no
         * binary has to cross the message channel. */
        case "geo-export": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          let records = selectTracked(await db.getAll("derived"), { profileId: msg.profileId, engines: msg.engines && msg.engines.length ? msg.engines : undefined });
          let runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId)
            .filter((r) => records.some((x) => x.geo && x.geo.runId === r.id))
            .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          // Each run's number in the whole campaign, before any narrowing, so
          // an export of the latest run says "Run 2" as the board does (1.0.2).
          const runNumbers = Object.fromEntries(runs.map((r, i) => [r.id, i + 1]));
          if (msg.scope === "latest" && runs.length) {
            const last = runs[runs.length - 1];
            runs = [last];
            records = records.filter((x) => x.geo && x.geo.runId === last.id);
          }
          const prompts = (await db.getAll("trackedPrompts")).filter((t) => t.profileId === msg.profileId);
          const bundle = {
            profile, prompts, runs, records, runNumbers, brands: effectiveTrackedBrands(profile, records),
            include: msg.include, answerText: msg.text === "full" ? "full" : "excerpt", generatedAt: Date.now(),
          };
          const slug = String(profile.name || "campaign").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "campaign";
          const day = new Date().toISOString().slice(0, 10);
          const filename = { csv: `citoskeleton-${slug}-${day}-tables.zip`, xlsx: `citoskeleton-${slug}-${day}.xlsx` };
          if (msg.format === "counts") { sendResponse({ ok: true, counts: campaignExportCounts(bundle), filename }); break; }
          if (!records.length) { sendResponse({ ok: false, error: "No answers to export for these choices." }); break; }
          if (msg.format === "csv") {
            sendResponse({ ok: true, files: campaignCsvFiles(bundle), filename: filename.csv });
          } else {
            const { wb, stats } = buildCampaignXlsx(bundle);
            sendResponse({ ok: true, files: wb.files(), filename: filename.xlsx, stats });
          }
          break;
        }

        /* The campaign PDF report (0.53.0): one run, laid out by
         * ui/report.html. Worked out here for the same reason as the board:
         * positions need the answer text. */
        case "campaign-report": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const engines = msg.engines && msg.engines.length ? msg.engines : undefined;
          const records = selectTracked(await db.getAll("derived"), { profileId: msg.profileId, engines });
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId);
          const prompts = (await db.getAll("trackedPrompts")).filter((t) => t.profileId === msg.profileId);
          const report = campaignReport({
            profile, prompts, runs, records, brands: effectiveTrackedBrands(profile, records),
            runId: msg.runId, sections: msg.sections, engines, generatedAt: Date.now(),
          });
          sendResponse(report.ok ? { ok: true, report } : report);
          break;
        }

        /* Everything about one campaign, in one message — "share all the
         * issues and data of a campaign with you in one go." Built here
         * rather than the panel fetching pieces one at a time (as the old
         * per-capture "Download raw payload" button did): a campaign can
         * have hundreds of captures, and gunzipping each raw payload in the
         * service worker and returning them all at once avoids hundreds of
         * round trips. The panel turns this into a zip (see
         * ui/panel.js's Export Diagnostics action) — the same makeZip()
         * the feedback bundle already uses, just fed more files.
         */
        case "get-campaign-diagnostics": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId);
          const runIds = runs.map((r) => r.id);
          const all = await db.getAll("derived");
          // Every capture, duplicates included: they are evidence here.
          const records = selectTracked(all, { profileId: msg.profileId, allCaptures: true });
          const prompts = (await db.getAll("trackedPrompts")).filter((t) => t.profileId === msg.profileId);

          const runNo = new Map([...runs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((r, i) => [r.id, i + 1]));
          const { perRun } = summarizeRunDiagnostics({ runs, records }, runNo);

          // The diagnostic log, split back into its three categories for the
          // zip's separate files — see lib/errorlog.js's header for why one
          // store carries all three.
          //
          // Runs started before the loader adopted the geo run's id (see
          // loaderStart) are known to the log only by the loader's own id,
          // which the campaign's run records never stored. Every capture still
          // carries both, so that id is recovered from this campaign's own
          // captures — without it the log section of this export was empty
          // for every run, which is most of what the export is for. A run
          // that captured nothing at all can't be recovered this way.
          const logRunIds = new Set(runIds);
          for (const r of records) if (r.runId) logRunIds.add(r.runId);
          const diagEntries = await errorLog.listByRunIds([...logRunIds], 5000);
          const errorEntries = diagEntries.filter((e) => (e.cat || "error") === "error");
          const turnEntries = diagEntries.filter((e) => e.cat === "turn");
          const captureEntries = diagEntries.filter((e) => e.cat === "capture");

          // Records and raw payloads are NOT in this response. A message
          // between the service worker and a page is capped at 64 MiB, and a
          // real ten-prompt, four-engine campaign crossed it (Perplexity's
          // answer stream alone is 150-430 KB a capture, Gemini's up to
          // several MB): the export failed outright with "Message exceeded
          // maximum allowed size". This returns an index; the panel fetches
          // the records in batches (get-diagnostics-records) and each raw
          // payload on its own (get-raw), so no one message grows with the
          // campaign. Each capture's file still carries the WHOLE record,
          // answer text included — see get-diagnostics-records.
          const recordIds = records.map((r) => r.captureId);

          // Payloads the adapters couldn't read (see storeCapture). They have
          // no record — that's the problem — so they are found through their
          // log entries. One sample per endpoint and shape: a run can log a
          // hundred of the same unreadable stream, and one is enough to read
          // the format. Capped: this is for seeing a format, not archiving.
          const unreadable = [];
          const unreadableKinds = new Set();
          for (const e of captureEntries) {
            if (unreadable.length >= 20) break;
            const c = e.context || {};
            if (!c.captureId || !String(e.where || "").startsWith("capture:unreadable:")) continue;
            const kind = `${c.platform}|${c.endpoint}|${c.shape}`;
            if (unreadableKinds.has(kind)) continue;
            try {
              const row = await db.get("raw", c.captureId);
              if (!row) continue;
              unreadableKinds.add(kind);
              unreadable.push({ captureId: c.captureId, platform: row.platform, endpoint: c.endpoint || null });
            } catch (_) { /* gone — the log entry still says what it was */ }
          }

          const manifest = chrome.runtime.getManifest();
          sendResponse({
            ok: true,
            unreadable,
            campaign: {
              profileId: profile.id,
              name: profile.name,
              brand: profile.brand,
              competitors: profile.competitors,
              engines: profile.engines,
              promptCount: prompts.length,
              runCount: runs.length,
            },
            perRun,
            errors: errorEntries,
            turns: turnEntries,
            captures: captureEntries,
            recordIds,
            env: { version: manifest.version, userAgent: navigator.userAgent },
            generatedAt: Date.now(),
          });
          break;
        }

        case "geo-run-list": {
          const runs = await db.getAll("geoRuns");
          const scoped = msg.profileId ? runs.filter((r) => r.profileId === msg.profileId) : runs;
          scoped.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
          sendResponse({ ok: true, runs: scoped });
          break;
        }
        // A campaign's whole results board (0.50.0), in one round trip.
        // Computed here, not in the panel, for the reason geo-metrics gives:
        // positions need the answer text, which the panel's rows don't carry.
        case "campaign-board": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const records = await db.getAll("derived");
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId)
            .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
          // A run still going isn't on the board (0.62.2, asked: "only show
          // the data of the campaign when it's done or stopped"): its answers
          // are left out of every view, the default and "all runs" included.
          const live = new Set(runs.filter((r) => r.status === "running").map((r) => r.id));
          const all = selectTracked(records, { profileId: msg.profileId, engines: msg.engines, tags: msg.tags, tagMode: msg.tagMode }).filter((x) => !(x.geo && live.has(x.geo.runId)));
          // What's shown (0.80.0): by default the newest answer for each
          // prompt on each engine, whichever run it came from; or one run;
          // or "all", every answer of every run.
          const { runId, recs, latestMode, mixed } = pickCampaignAnswers(all, runs, msg.runId);
          const brands = effectiveTrackedBrands(profile, recs);
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId)
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          // What one run asked, engine by engine (1.0.2), so its totals count
          // a turn that failed: the same plan "Retry missing" reads.
          const shownRun = runId ? runs.find((r) => r.id === runId) : null;
          const asked = shownRun && Array.isArray(shownRun.promptIds)
            ? Object.fromEntries((shownRun.engines || []).map((e) => [e, shownRun.promptIds.length])) : null;
          sendResponse({
            mixedRuns: mixed,
            ok: true,
            board: campaignBoard(recs, { profile, brands, viewAs: msg.viewAs, prompts, runs: runs.filter((r) => !live.has(r.id)), runId, latest: latestMode, all, engineFilter: msg.engines || [], tags: msg.tags || [] }),
            // The 0.64.0 board's sections, over the same answers.
            // Seen from any brand (0.67.0, asked: "look at the entire data
            // for not just my brand but other competition as well"): the
            // board measures whichever brand is picked against the rest.
            view: campaignView(recs, { profile, brands: msg.viewAs && brands.some((b) => b.name === msg.viewAs) ? brands.map((b) => ({ ...b, isOwn: b.name === msg.viewAs })) : brands, prompts, asked, engineFilter: msg.engines || [] }),
            ownBrand: (brands.find((b) => b.isOwn) || {}).name || null,
            runId: runId || (latestMode ? "latest" : "all"),
            runs: runs.filter((r) => !live.has(r.id)).map((r) => ({ id: r.id, startedAt: r.startedAt, status: r.status, captured: r.captured || 0, expected: r.expected || 0, hasAnswers: all.some((x) => x.geo && x.geo.runId === r.id), engines: [...new Set(all.filter((x) => x.geo && x.geo.runId === r.id).map((x) => x.platform))] })),
            brands: brands.map((b) => ({ name: b.name, isOwn: !!b.isOwn, auto: !!b.auto })),
            excludedBrands: profile.excludedBrands || [],
            // Named in the answers and not on the list (0.77.0): offered to
            // add even once the campaign has competitors of its own.
            suggested: autoCompetitorsFrom(recs, profile).map((b) => ({ name: b.name, responses: b.responses })),
            changes: profile.changes || [],
            tags: [...new Set(prompts.flatMap((p) => p.tags || []))],
            answers: recs.length,
          });
          break;
        }
        // Two runs of a campaign side by side (0.80.0, lib/runCompare.js).
        case "campaign-run-compare": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const all = selectTracked(await db.getAll("derived"), { profileId: msg.profileId, engines: msg.engines, tags: msg.tags, tagMode: msg.tagMode });
          const recsA = all.filter((x) => x.geo && x.geo.runId === msg.runA);
          const recsB = all.filter((x) => x.geo && x.geo.runId === msg.runB);
          let brands = effectiveTrackedBrands(profile, [...recsA, ...recsB]);
          if (msg.viewAs && brands.some((b) => b.name === msg.viewAs)) brands = brands.map((b) => ({ ...b, isOwn: b.name === msg.viewAs }));
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId);
          sendResponse({ ok: true, compare: compareRuns(recsA, recsB, { brands, prompts }) });
          break;
        }
        // One brand against yours (0.50.0): the brand detail the board opens.
        // Same scope as the board (run, engine, tags), so the two agree.
        case "campaign-brand-detail": {
          const profile = await db.get("profiles", msg.profileId);
          if (!profile) { sendResponse({ ok: false, error: "Campaign not found." }); break; }
          const records = await db.getAll("derived");
          const all = selectTracked(records, { profileId: msg.profileId, engines: msg.engines, tags: msg.tags, tagMode: msg.tagMode });
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId)
            .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          const { runId, recs, latestMode } = pickCampaignAnswers(all, runs, msg.runId);
          const brands = effectiveTrackedBrands(profile, recs);
          const own = brands.find((b) => b.isOwn);
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId)
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          const detail = own ? brandDetail(recs, { profile, brands, them: msg.brand, you: msg.you || own.name, prompts, tags: msg.tags || [] }) : null;
          sendResponse({
            ok: true, detail,
            error: detail ? undefined : "That brand isn't tracked on this campaign.",
            sourceDomains: detail ? brandSourceDomains(recs, brands, detail.them.name) : [],
            brands: brands.map((b) => ({ name: b.name, isOwn: !!b.isOwn, auto: !!b.auto })),
            answers: recs.length,
            runLabel: runId ? `Run ${runs.findIndex((r) => r.id === runId) + 1}` : latestMode ? "Latest answers" : "All runs combined",
          });
          break;
        }
        // What the last finished run is missing (0.78.1), for "Retry missing".
        case "geo-run-missing": {
          const runs = (await db.getAll("geoRuns")).filter((r) => r.profileId === msg.profileId).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
          const run = runs.find((r) => r.status !== "running");
          if (!run || runs[0] !== run) { sendResponse({ ok: true, count: 0 }); break; }
          const prompts = (await db.getAll("trackedPrompts")).filter((p) => p.profileId === msg.profileId).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          const m = missingTurns(run, prompts, await db.getAll("derived"));
          const byEngine = Object.fromEntries(Object.entries(m.only).map(([e, l]) => [e, l.length]));
          sendResponse({ ok: true, runId: run.id, count: m.count, byEngine, startedAt: run.startedAt || null, status: run.status || null });
          break;
        }
        case "geo-run-start": {
          const runOpts = { skipAuthCheck: !!msg.skipAuthCheck, privateWindow: !!msg.privateWindow, retryRunId: msg.retryRunId || null };
          // Another campaign running (0.80.0): this one waits its turn
          // instead of being refused, and starts when that run ends.
          if (loader.running && !msg.noQueue) { sendResponse(await enqueueRun(msg.profileId, runOpts)); break; }
          sendResponse(await geoRunStart(msg.profileId, runOpts));
          break;
        }
        case "welcome-open-once":
          sendResponse({ ok: true, opened: await openWelcomeOnce({ evenAutomated: !!msg.evenAutomated }) });
          break;
        // The email given on the welcome page or in Settings (0.81.0). Kept on
        // this computer; sent to the developer's server once accounts are
        // switched on (0.82.0), and unsubscribed from there on Remove.
        case "signup-saved":
        case "signup-removed":
          sendResponse(await syncSignup());
          break;
        case "run-queue":
          sendResponse({ ok: true, queue: await loadRunQueue(), runningProfileId: (loader.running && loader.options && loader.options.geo && loader.options.geo.profileId) || null });
          break;
        case "run-queue-remove": {
          const q = (await loadRunQueue()).filter((x) => x.profileId !== msg.profileId);
          await chrome.storage.local.set({ [RUN_QUEUE_KEY]: q });
          sendResponse({ ok: true, queue: q });
          break;
        }
        // Opens an engine's own sign-in page for the pre-flight auth gate.
        // Restricted to the exact login URLs in lib/auth-check.js — this is a
        // message handler, so it must not become a general "open any URL the
        // caller names" primitive.
        case "open-url": {
          const allowed = Object.values(AUTH_COOKIES).map((s) => s.loginUrl).filter(Boolean);
          if (!allowed.includes(msg.url)) {
            sendResponse({ ok: false, error: "Refused: not a known sign-in URL." });
            break;
          }
          try {
            await chrome.tabs.create({ url: msg.url, active: true });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
          }
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
            tagMode: msg.tagMode,
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
            tagMode: msg.tagMode,
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
            tagMode: msg.tagMode,
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
            tagMode: msg.tagMode,
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
          setLoaderPaused(true);
          for (const pd of Object.values(loader.platforms)) {
            for (const leg of pd.legs) clearWatchdog(leg);
          }
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          break;
        case "loader-resume": {
          // A run saved before the worker restarted is picked up first, so
          // Resume works at once instead of after the next heartbeat (1.0.4).
          if (!loader.running) await restoreRunIfAny().catch((err) => logErr("restoreRunIfAny", err));
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
                    // A signed-out run resumes in a private window, never
                    // in the signed-in one (0.79.0).
                    const winId = await resumeWindowId();
                    const tab = winId != null
                      ? await chrome.tabs.create({ windowId: winId, url: engineBaseUrl(plat), active: false })
                      : await chrome.tabs.create({ url: engineBaseUrl(plat), active: false });
                    leg.tabId = tab.id;
                    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
                  } catch (_) {
                    // Couldn't open a tab — leave the run paused rather than
                    // spinning; the user can retry Resume.
                    sendResponse({ ok: false, error: "Couldn't open a tab to resume in. Check Chrome isn't blocking new tabs, then try Resume again." });
                    return;
                  }
                }
              }
            }
            setLoaderPaused(false);
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
          setLoaderPaused(false);
          // "stopped" here, not "done" — deliberately no badge/notification:
          // the user just clicked Stop, they're already right there.
          await syncGeoRun("stopped");
          await persistLoaderState();
          sendResponse({ ok: true, ...loaderStatus() });
          startNextQueued();
          break;
        case "loader-status":
          // Same for the status the panel polls: a run in flight before an
          // update shows (paused, "interrupted") instead of nothing (1.0.4).
          if (!loader.running) await restoreRunIfAny().catch((err) => logErr("restoreRunIfAny", err));
          sendResponse({ ok: true, ...loaderStatus() });
          break;

        /* The error log. Read grouped by default — the same failure repeating
         * 400 times in one run is one problem, and a flat list of identical
         * lines is what makes a log unreadable exactly when it matters. */
        case "error-log": {
          // cat lets the unified Diagnostics view filter to one category
          // (error/capture/turn) — omitted, it returns everything, newest
          // first, same as before this became a merged log.
          const [entries, grouped] = await Promise.all([
            errorLog.list(msg.limit || 200, msg.cat),
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
          idleBadge();
          sendResponse({ ok: true });
          break;

        // Network-capture breadcrumbs — used to live in an in-memory ring
        // buffer the MV3 service worker wiped every ~30s idle (see
        // lib/errorlog.js's header). Now durable, folded into the one
        // diagnostics log as cat:"capture" entries instead of a second,
        // disconnected mechanism. `data.url` is deliberately never
        // forwarded — it can carry `?q=<the prompt>` — only the small
        // scalar fields the content script already separates it into.
        case "debug": {
          const event = msg.event || {};
          const data = event.data || {};
          logEvent(`capture:${event.kind || "event"}`, "capture", event.host || event.kind || "capture", {
            status: typeof data.status === "number" ? data.status : undefined,
            matched: typeof data.matched === "boolean" ? data.matched : undefined,
            len: typeof data.len === "number" ? data.len : undefined,
            rt: typeof data.rt === "string" ? data.rt : undefined,
            runId: loader.runId,
          });
          sendResponse({ ok: true });
          break;
        }

        // The network recorder (0.62.0, Debug capture only; content-main.js).
        case "netlog": {
          if (await capturePausedFor(sender)) { sendResponse({ ok: true, skipped: "paused" }); break; }
          await netlogAppend(Array.isArray(msg.entries) ? msg.entries.slice(0, 200) : []);
          sendResponse({ ok: true });
          break;
        }
        case "probe": {
          if (await capturePausedFor(sender)) { sendResponse({ ok: true, skipped: "paused" }); break; }
          // A reply the Gemini reader already turns into an answer isn't kept (0.69.0).
          if (probeIsRead(msg.payload || {})) { sendResponse({ ok: true, skipped: "read" }); break; }
          await probeAppend(msg.payload || {});
          sendResponse({ ok: true });
          break;
        }
        case "get-probes": {
          sendResponse({ ok: true, probes: await probesLoad() });
          break;
        }
        case "get-netlog": {
          sendResponse({ ok: true, entries: await netlogLoad() });
          break;
        }

        case "get-records": {
          const records = await db.getAll("derived");
          records.sort((a, b) => b.capturedAt - a.capturedAt);
          sendResponse({ ok: true, records: records.map(toLight) });
          break;
        }
        // 0.74.0: one record as the list holds it, so the panel can patch the
        // record a broadcast names instead of refetching every capture.
        case "get-record-light": {
          const rec = await db.get("derived", msg.captureId);
          sendResponse({ ok: true, record: rec ? toLight(rec) : null });
          break;
        }
        case "get-record": {
          const rec = await db.get("derived", msg.captureId);
          sendResponse({ ok: true, record: rec || null });
          break;
        }

        // One answer's PDF report (0.53.0): the answer, the previous answer
        // to the same prompt on the same engine (for "since you last
        // asked"), and the campaigns (for "your brand"). ui/report.js lays
        // it out with src/lib/answerReport.js.
        case "answer-report-data": {
          const rec = await db.get("derived", msg.captureId);
          if (!rec) { sendResponse({ ok: false, error: "That answer is no longer stored." }); break; }
          const previous = findPrevious(rec, await db.getAll("derived"));
          sendResponse({ ok: true, record: rec, previous: previous || null, profiles: await db.getAll("profiles") });
          break;
        }

        // The Dashboard's "Answers" search (0.49.0). The panel holds light
        // rows without answer text, so the words are looked for here and only
        // the matching ids come back, each with a snippet around the match.
        case "search-answers": {
          const records = await db.getAll("derived");
          const query = String(msg.query || "").slice(0, 200);
          const hits = searchAnswers(records, query);
          // 1.0.5: with search by meaning on, answers that say it in other
          // words come after the ones holding every word.
          try {
            const docs = indexFor(records).docs.filter((d) => !d.isPrompt).sort((a, b) => b.at - a.at).map((d) => ({ id: d.id, text: d.text }));
            const ids = query.trim() ? await aiSvc.meaningRank(query, docs) : null;
            if (ids && ids.length) {
              const have = new Set(hits.map((h) => h.captureId));
              const byId = new Map(indexFor(records).docs.map((d) => [d.id, d]));
              for (const id of ids) {
                const d = byId.get(id);
                if (!d || have.has(d.captureId)) continue;
                have.add(d.captureId);
                hits.push({ captureId: d.captureId, snippet: d.text.length > 180 ? `${d.text.slice(0, 179)}…` : d.text, byMeaning: true });
                if (hits.length >= 300) break;
              }
            }
          } catch (e) { logErr("search-meaning", e); }
          sendResponse({ ok: true, hits });
          break;
        }

        // Whole derived records for the diagnostics export, a batch at a
        // time — see get-campaign-diagnostics for why they aren't inline.
        case "get-diagnostics-records": {
          const ids = Array.isArray(msg.captureIds) ? msg.captureIds.slice(0, 100) : [];
          const out = [];
          for (const id of ids) {
            const rec = await db.get("derived", id);
            if (rec) out.push(rec);
          }
          sendResponse({ ok: true, records: out });
          break;
        }
        case "page-interaction":
          if (await capturePausedFor(sender)) { sendResponse({ ok: true, skipped: "paused" }); break; }
          sendResponse(await onPageInteraction(msg.payload || {}));
          break;
        // Read (or re-read) one answer's cited pages now, from Analyze.
        case "read-cited-pages":
          sendResponse(await readCitedPages(msg.captureId, { force: !!msg.force, manual: true }));
          break;
        case "get-raw": {
          const row = await db.get("raw", msg.captureId);
          const raw = row ? await gunzipToString(row.gz) : null;
          const inter = await db.getAllByIndex("interactions", "captureId", msg.captureId).catch(() => []);
          sendResponse({ ok: true, raw, meta: row ? { url: row.url, reqBody: row.reqBody } : null, interactions: inter.sort((x, y) => x.at - y.at).map((x) => ({ at: x.at, path: x.path, status: x.status, body: x.body })) });
          break;
        }
        case "reprocess-all":
          sendResponse({ ok: true, ...(await reprocessAll()) });
          break;
        // Sample data so a new install isn't a wall of zeros. Written ONLY to
        // "derived" — there is no raw payload behind it, and inventing one
        // would make "Reprocess all captures" re-derive a fabricated capture
        // as though it were real.
        case "demo-load": {
          const recs = buildDemoRecords();
          for (const r of recs) await db.put("derived", r);
          sendResponse({ ok: true, added: recs.length });
          break;
        }
        // Removes exactly the demo rows and nothing else, so a user who has
        // since captured real answers can clear the samples without touching
        // their own data.
        case "demo-clear": {
          const all = await db.getAll("derived");
          const demo = all.filter(isDemoRecord);
          for (const r of demo) await db.delete("derived", r.captureId);
          sendResponse({ ok: true, removed: demo.length });
          break;
        }
        case "demo-status": {
          const all = await db.getAll("derived");
          sendResponse({ ok: true, present: all.some(isDemoRecord), real: all.filter((r) => !isDemoRecord(r)).length });
          break;
        }
        // The built-in AI (0.70.0).
        case "ai-progress":
          aiSvc.onProgress(msg.progress || null);
          break;
        case "ai-status":
          sendResponse(await aiSvc.status());
          break;
        case "ai-hardware":
          try { sendResponse({ ok: true, ...(await aiSvc.hardware()) }); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        case "ai-download":
          sendResponse(await aiSvc.download({ tier: msg.tier, device: msg.device }));
          break;
        case "ai-remove":
          sendResponse(await aiSvc.remove());
          break;
        // Google AI Mode on or off (1.0.5). The page asks Chrome for the
        // google.com permission first (a user's click); this stores the
        // choice and registers or removes AI Mode's page scripts.
        case "aimode-set": {
          await chrome.storage.local.set({ aimodeOn: !!msg.on });
          sendResponse(await syncAiModeScripts());
          break;
        }
        case "aimode-status":
          sendResponse(await syncAiModeScripts());
          break;
        // Laya, for the labels (0.83.0).
        case "laya-download":
          sendResponse(await aiSvc.downloadLaya({ device: msg.device }));
          break;
        case "laya-remove":
          sendResponse(await aiSvc.removeLaya());
          break;
        // Search by meaning (1.0.5): an optional download for Ask and search.
        case "meaning-download":
          sendResponse(await aiSvc.downloadMeaning({ device: msg.device }));
          break;
        case "meaning-remove":
          sendResponse(await aiSvc.removeMeaning());
          break;
        case "ai-cancel-download":
          sendResponse(await aiSvc.cancelDownload(msg.kind === "laya" ? "laya" : "llm"));
          break;
        case "ai-set-labeller":
          sendResponse(await aiSvc.setLabeller(msg.labeller));
          break;
        // Tests only: a stand-in Laya bundle served from this computer.
        case "laya-test-model": {
          const host = String((msg.model || {}).host || "");
          if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/$/.test(host)) { sendResponse({ ok: false, error: "local addresses only" }); break; }
          const st = await aiSvc.getState();
          await aiSvc.setState({ laya: { ...(st.laya || {}), custom: { repo: String(msg.model.repo), rev: String(msg.model.rev || "main"), sub: String(msg.model.sub || ""), host, label: "Test Laya" }, downloadedAt: null } });
          sendResponse({ ok: true });
          break;
        }
        // 0.74.0: which engine answers, Chrome's own model, and the speed test.
        case "ai-set-engine":
          sendResponse(await aiSvc.setEngine(msg.engine));
          break;
        case "ai-use-nano":
          sendResponse(await aiSvc.useNano());
          break;
        case "ai-benchmark":
          try { sendResponse(await aiSvc.benchmark()); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        case "ai-check-capture": {
          const rec = await db.get("derived", msg.captureId);
          const r = await aiSvc.enqueue(rec, { force: true });
          if (r.ok && rec) { await aiSvc.attach(rec); await db.put("derived", rec); broadcast({ type: "capture-updated", captureId: rec.captureId }); }
          sendResponse(r);
          break;
        }
        // Ask (0.73.0): the model reads the user's own data through tools.
        case "ask": {
          try {
            const [records, profiles, runs] = await Promise.all([db.getAll("derived"), db.getAll("profiles"), db.getAll("geoRuns")]);
            // Each lookup is broadcast as it starts (0.78.0): Ask shows it.
            const onStep = (st) => broadcast({ type: "ask-step", askId: msg.askId || null, tool: st.tool });
            // 1.0.5: where the user is (the campaign open on the page), the
            // last answer's plan (a follow-up keeps its scope) and an edited
            // plan (a scope chip changed, an ask-back choice) go with it.
            const obj = (x) => (x && typeof x === "object" ? x : null);
            const context = { collectionId: typeof (obj(msg.context) || {}).collectionId === "string" ? msg.context.collectionId : null };
            sendResponse({ ok: true, ...(await aiSvc.askQuestion({ question: String(msg.question || ""), data: { records, profiles, runs }, onStep, context, previous: obj(msg.previous), plan: obj(msg.plan) })) });
          } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        }
        case "ai-check-now":
          try { sendResponse({ ok: true, ai: await aiSvc.checkNow(msg.record || {}) }); } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        // 0.75.0: a model the user trained (training/), from their own
        // Hugging Face repository. Only huggingface.co, only "owner/name".
        case "ai-custom-model": {
          if (msg.clear) { await aiSvc.setState({ custom: null, downloadedAt: null }); sendResponse({ ok: true }); break; }
          const repo = String(msg.repo || "").trim();
          if (!/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(repo)) { sendResponse({ ok: false, error: "Give the repository as owner/name." }); break; }
          await aiSvc.setState({ custom: { repo, host: null, dtype: { webgpu: "q4f16", wasm: "q4" }, label: `Your model (${repo})`, params: "" }, tier: null, downloadedAt: null });
          sendResponse({ ok: true });
          break;
        }
        // Tests only: a stand-in model served from this computer.
        case "ai-test-offscreen-idle": {
          await ensureOffscreen();
          sendResponse(await chrome.runtime.sendMessage({ target: "offscreen", type: "set-idle", ms: msg.ms }));
          break;
        }
        case "ai-test-model": {
          const host = String((msg.model || {}).host || "");
          if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/$/.test(host)) { sendResponse({ ok: false, error: "local addresses only" }); break; }
          await aiSvc.setState({ custom: { repo: String(msg.model.repo), host, dtype: msg.model.dtype || "fp32", label: "Test model", ...(Array.isArray(msg.model.script) ? { script: msg.model.script.map(String) } : {}) }, tier: null, downloadedAt: null });
          sendResponse({ ok: true });
          break;
        }
        case "delete-record":
          await dropCapture(msg.captureId);
          sendResponse({ ok: true });
          break;
        case "clear-all":
          await db.clear("raw");
          await db.clear("derived");
          await db.clear("runs");
          await db.clear("pages").catch(() => {});
          await db.clear("interactions").catch(() => {});
          await db.clear("ai").catch(() => {});
          await db.clear("aiQueue").catch(() => {});
          await chrome.storage.session.remove([NETLOG_KEY, PROBE_KEY]).catch(() => {});
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
        // The build THIS script was loaded with — not the manifest's version,
        // which can be new while the running code is old. See lib/build.js.
        case "build-info":
          sendResponse({ ok: true, build: BUILD });
          break;

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
