/* panel.js — UI. Talks to the service worker; never touches storage directly. */

// The one exception to "never touches storage directly": exportDoc.js is a
// pure rendering module (record[] -> HTML string), no chrome.* / storage
// calls of its own — see src/lib/exportDoc.js header. Data still only ever
// arrives here via send()/hydrate() through the service worker.
import { handoffButton } from "./handoff.js";
import { applyDefs } from "./defs.js";
import { campaignParts, answerParts } from "../src/lib/contextPack.js";
import { buildExportModel, renderStandaloneHtml } from "../src/lib/exportDoc.js";
import {
  ENGINES, availableEngines, MAX_PROFILES, SENTIMENT_NOTE, TRASH_RETENTION_DAYS,
  partitionRecords, allTags, runDue, runVolume, makeProfile, changeText,
} from "../src/lib/geo.js";
import { parseCsv, parseXlsx, rowsToPrompts } from "../src/lib/xlsxLite.js";
import { promptTemplateWorkbook, promptTemplateCsv } from "../src/lib/promptTemplate.js";
import { makeZip } from "../src/lib/zipWrite.js";
import { pictureProducts } from "../src/lib/productImages.js";
import { BUNDLE_PARTS, buildFeedbackFiles, bundleFilename } from "../src/lib/feedbackBundle.js";
import { computeSearchFunnel, computeBrandMatrix } from "../src/lib/funnel-omitted.js";
import { GLOSSARY, glossaryEntries } from "../src/lib/glossary.js";
import { ABOUT_STEPS, ABOUT_NEWS, glossaryView, pickedTerm, startProgress, settingsState, settingValue, SETTING_LIMITS, storageMeter, logView, buildStatus, browserSupport } from "../src/lib/aboutView.js";
import { normalizeMentions } from "../src/lib/mention-list.js";
import {
  answerKind, searchesView, brandsView, pagesView, domainsView, ownBrandFor, yourBrandView, findPrevious, changesView, knownVendors, adsView,
  resultPositions, sourceBrandMatrix, productsView,
} from "../src/lib/analyzeView.js";
import { originalImageUrl } from "../src/lib/image-url.js";
import { rawBreakdown, SECTIONS as RAW_SECTIONS } from "../src/lib/rawBreakdown.js";
import { isNanoAvailable, labelRawFieldsWithNano } from "../src/lib/nano.js";
import { answersToPrompt, compareView } from "../src/lib/compareView.js";
import { overTimeView } from "../src/lib/overTimeView.js";
import { historyRows, historyView, highlightRuns, dayDiff, shortDate, PERIODS, KINDS, ENGINE_ORDER, rangeLabel, setDateLocale } from "../src/lib/historyView.js";
import { loadLang, chosenLang, tr, fmt, dateLocale, translatePage, uiLang, LANGS, LANG_KEY } from "./i18n.js";
import { checklist, examplePrompts } from "../src/lib/onboarding.js";
import { extractBrandAspects } from "../src/lib/aspects.js";
import { siteKindOf } from "../src/lib/siteKind.js";
import { renderCampaignView, CV_SECTIONS, sectionCounts, resetCampaignViewState } from "./campaignView.js";
import { initDisplaySettings } from "./displaySettings.js";
import { initAiSettings } from "./aiSettings.js";
import { renderAsk } from "./askView.js";
import { aggregateSources } from "../src/lib/sources.js";
import { analyzeFanout, FANOUT_BENCHMARK, titleMatchesQueries } from "../src/lib/fanout.js";
import { sanitizeText, trimLabel } from "../src/lib/text-sanitize.js";
import { pipelineOf, typeLabel, supplierOf, retrievalMix } from "../src/lib/retrieval.js";
import { formatCooldown, formatDuration, runTookMs } from "../src/lib/pacing.js";
import { checkEmail } from "../src/lib/emailCheck.js";
import { bufToB64, b64ToBuf } from "../src/lib/campaignBundle.js";
import { BUILD } from "../src/lib/build.js";
import { netlogReportLines } from "../src/lib/netlog.js";
import {
  computeVerbatimGrounding,
  computeAuthoritySplit,
  computeDomainExclusivity,
  computeSearchIntentGraph,
} from "../src/lib/grounding-score.js";

// The interface's language (0.71.0, ui/i18n.js), before anything is drawn.
await loadLang(chosenLang());
translatePage(document);
setDateLocale(uiLang());

// chrome.runtime.sendMessage throws SYNCHRONOUSLY — not via the callback —
// when this page's connection to the extension is dead ("Extension context
// invalidated"), which happens to every already-open popup/tab the instant
// the extension is reloaded or updated from chrome://extensions. That throw
// happens inside the Promise executor below, so without the try/catch it
// silently rejects the returned promise; every caller does `await send(...)`
// with no try/catch of its own (see load()), so the rejection was an
// unhandled promise rejection that aborted the entire load — leaving the
// popup completely blank, not even the "No captures yet" placeholder, since
// nothing ever got the chance to render. Resolving with {ok:false} instead
// means callers see an ordinary failed response and load() can show a real
// message instead of silently doing nothing.
const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false }));
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

/* A half-updated install: these screens, and the background that actually
 * runs campaigns, loaded from different builds. The manifest can't reveal it
 * (see src/lib/build.js) — a real browser reported 0.41.0 everywhere while
 * its runs failed with a bug two versions gone. Said up front, on every tab,
 * before a run is wasted on the old code. Only a genuine mismatch shows it: a
 * background that reports another build, or one too old to know the question
 * ("unknown message type"). A broken connection is load()'s to explain.
 *
 * Reproduced, not guessed: a Chrome profile that had loaded the extension
 * before kept running the old background across relaunches after the files
 * (and manifest version) on disk changed — its Preferences still recorded the
 * old service-worker version. Only the chrome://extensions reload button
 * replaced it, and the fix then held across relaunches. Hence the wording.
 */
async function checkBuildMatch() {
  const r = await send({ type: "build-info" });
  // About shows the same check, as a status on every page (0.51.0).
  abBuildReply = r || { ok: false };
  if ($("#about")?.classList.contains("active")) renderAbout(); else renderAboutBuild();
  const stale = (r && r.ok && r.build !== BUILD) || (r && r.error === "unknown message type");
  if (!stale) return;
  const host = document.querySelector(".app-content");
  if (!host || host.querySelector(".build-mismatch")) return;
  const running = r.ok ? `version ${r.build}` : "an older version";
  const li = (text) => { const n = document.createElement("li"); n.textContent = text; return n; };
  const list = document.createElement("ol");
  list.append(
    li("Open chrome://extensions and click the reload ↻ icon on CitoSkeleton. Restarting Chrome is not enough — Chrome keeps the old background running until this button is pressed."),
    li("If this message is still here after that, some files were not replaced: close Chrome, extract the update over the folder again (replacing every file), reopen Chrome and press reload ↻ once more."));
  const note = document.createElement("div");
  note.className = "build-mismatch";
  note.setAttribute("role", "alert");
  const title = document.createElement("b");
  title.textContent = "Part of CitoSkeleton is out of date";
  note.append(title,
    `These screens are version ${BUILD}, but the part that runs campaigns is still ${running}. Campaign runs will use the old code until this is fixed.`,
    list);
  host.prepend(note);
}
checkBuildMatch();

// Synchronize full-tab vs popup mode in DOM for responsive layout and zoom stability
function syncViewportMode() {
  const isFullTab = window.innerWidth >= 620 || (typeof window !== "undefined" && window.location && window.location.search.includes("tab"));
  if (document.documentElement) {
    document.documentElement.classList.toggle("tab", isFullTab);
    document.documentElement.classList.toggle("popup", !isFullTab);
  }
  if (document.body) {
    document.body.classList.toggle("tab", isFullTab);
    document.body.classList.toggle("popup", !isFullTab);
  }
}
syncViewportMode();
window.addEventListener("resize", syncViewportMode);


/* Report UI errors to the durable log in the service worker.
 *
 * Every blank-tab bug this app has shipped threw a ReferenceError in a render
 * path and left no trace anywhere the user could reach — the message went to
 * the popup's devtools console, which closes with the popup. These two
 * listeners mean a render that blows up is recorded with its message and
 * stack, so "the Compare tab is blank" becomes "ENGINE_ICONS is not defined
 * in renderCompare".
 *
 * Deliberately not a try/catch around each render: the point is to catch what
 * was NOT anticipated. Failures here are swallowed — an error reporter that
 * throws would replace the error being reported.
 */
function reportUiError(where, err, context) {
  try {
    send({
      type: "error-report",
      where,
      name: err && err.name ? String(err.name) : "Error",
      message: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack) : "",
      context,
    });
  } catch (_) { /* never let reporting throw */ }
}
window.addEventListener("error", (ev) => {
  reportUiError("window.onerror", ev.error || { message: ev.message }, {
    line: ev.lineno, column: ev.colno,
    tab: document.querySelector(".panel.active")?.id || "unknown",
  });
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason;
  reportUiError("unhandledrejection", r && r.message ? r : { message: String(r) }, {
    tab: document.querySelector(".panel.active")?.id || "unknown",
  });
});

// Detect popup vs full-tab so the layout adapts (and survives browser zoom).
function applyMode() {
  const isTab = window.innerWidth > 640 || window.location.href.includes("mode=tab");
  document.documentElement.classList.toggle("tab", isTab);
  document.documentElement.classList.toggle("popup", !isTab);
  document.body.classList.toggle("tab", isTab);
  document.body.classList.toggle("popup", !isTab);
  // Analyze's sticky prompt/engine bar needs to stick BELOW .app-header, not
  // at the true viewport top, or the two would overlap. .app-header's own
  // height differs by mode (tab mode adds its own margin/padding via
  // body.tab .app-header, popup mode is a stacked two-row header) and isn't
  // a fixed number in either — so it's measured here, where mode changes are
  // already funneled through, rather than guessed as a magic-number `top`
  // in CSS that would drift the next time the header's own layout changes.
  const header = document.querySelector(".app-header");
  if (header) {
    document.documentElement.style.setProperty("--analyze-bar-top", `${header.offsetHeight}px`);
    // The bar's right-hand slot changes with the page (setHeaderPage) and
    // can wrap it onto a second line, so keep measuring.
    if (!headerObs && "ResizeObserver" in window) {
      headerObs = new ResizeObserver(() => document.documentElement.style.setProperty("--analyze-bar-top", `${header.offsetHeight}px`));
      headerObs.observe(header);
    }
  }
}
let headerObs = null;
/* The page's own items in the app bar's right-hand slot (full tab only, as
   on the canvas; the popup's bar has no room). Cleared on every tab switch,
   so a page that has nothing to add leaves it empty. */
function setHeaderPage(tab, ...nodes) {
  const slot = document.getElementById("headerPage");
  if (!slot) return;
  const active = document.querySelector(".panel.active")?.id;
  if (tab !== active) return;
  slot.textContent = "";
  if (document.body.classList.contains("tab")) slot.append(...nodes.filter(Boolean));
}
applyMode();
window.addEventListener("resize", applyMode);

// The header's version badge used to be a hardcoded string in panel.html
// ("v0.25") that silently went stale the next time manifest.json's version
// bumped (it was already showing v0.25 while the manifest said 0.26.0).
// Reading it from the manifest — the single source of truth chrome.runtime
// already exposes — means it can't drift out of sync again.
(function syncVersionBadge() {
  // querySelectorAll, not querySelector: there are two badges (the header
  // and the About hero). Only syncing the first left the About one frozen at
  // whatever was hardcoded in panel.html, which is exactly how it drifted to
  // "v0.26" while the manifest said 0.27.0.
  const v = chrome.runtime.getManifest().version;
  document.querySelectorAll(".version-badge").forEach((el) => { el.textContent = `v${v}`; });
})();

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (let [k, v] of Object.entries(props)) {
    // data-*/aria-* aren't real IDL properties — Object.assign used to just
    // stash them as plain JS properties on the element (no attribute, so
    // `[data-tip]` selectors and dataset reads never saw them). setAttribute
    // is what actually makes them queryable/CSS-selectable.
    // Visible words go through the dictionary (0.71.0): an English label
    // with a translation shows translated, anything else as it is.
    if (k === "aria-label" || k === "title" || k === "placeholder") v = tr(v);
    if (k.startsWith("data-") || k.startsWith("aria-")) n.setAttribute(k, v);
    else n[k] = k === "textContent" ? tr(v) : v;
  }
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(tr(k ?? "")));
  return n;
};
const esc = (s) => (s == null ? "" : String(s));

// showToast() (below, near the other "New capture" notification code) is
// extended with error/info variants and reused for every bare alert(...)
// call in this file — a native alert() freezes this whole (already small)
// popup window and looks nothing like the rest of the UI's own banner
// styling. Genuinely destructive actions still go through the browser's
// confirm() as a deliberate blocking gate; that's a different, intentional
// use of native dialogs and is left alone.

// Disables a button (and optionally swaps its label to a busy state) for the
// duration of an async action, so an impatient double-click can't fire a
// slow send() round trip twice — this is exactly how "2 prompts run
// together" could happen at the UI layer, not just from a service-worker
// restart race (see loaderStart's own guard in background.js for the
// authoritative fix; this is the client-side half of the same defense).
function withBusy(btn, busyLabel, fn) {
  return async (...args) => {
    if (!btn || btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    if (busyLabel) btn.textContent = busyLabel;
    try {
      return await fn(...args);
    } finally {
      btn.disabled = false;
      // Put the label back only if it still says the busy text: an action
      // that relabels its own button ("Load sample" -> "Remove sample") used
      // to have its new label overwritten here with the old one.
      if (!busyLabel || btn.textContent === busyLabel) btn.textContent = original;
    }
  };
}

// Shared dismiss wiring for the app's modal-backdrop/-content popups: Escape
// closes the topmost modal, clicking the backdrop (outside modal-content)
// closes it, and focus moves into the modal on open and back to whatever
// triggered it on close. Previously each of the 4 modal-opening functions
// hand-rolled its own subset of this (one had no backdrop-click-to-close at
// all, and none had Escape or focus management) — factored out so all of
// them behave the same way.
function wireModalDismiss(backdrop, modal) {
  const opener = document.activeElement;
  const onKeydown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  const onBackdropClick = (e) => {
    if (e.target === backdrop) close();
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
    if (opener && opener.focus) opener.focus();
  }
  document.addEventListener("keydown", onKeydown, true);
  backdrop.onclick = onBackdropClick;
  // Move focus into the modal so Escape/Tab work immediately without a
  // click first — prefer an explicit close button, fall back to the modal
  // itself (given tabindex below) if one isn't present yet.
  if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");
  const closeBtn = modal.querySelector(".modal-close-btn");
  (closeBtn || modal).focus();
  return close;
}

/*
 * Sign-in gate dialog. Shown when the background's pre-flight auth check
 * (src/lib/auth-check.js) finds an engine the user isn't signed in to, which
 * it does BEFORE any tab is opened — so at this point nothing has happened
 * yet and there is nothing to unwind.
 *
 * Deliberately NOT a bare "you're logged out" error. The whole reason this
 * failure was worth building a gate for is that it's expensive and quiet, so
 * the dialog has to also be the fix: it opens the right login pages, waits
 * while the user signs in, and then re-runs the same check rather than
 * making them find their way back to the Campaigns tab and start over.
 *
 * `onProceed(skipAuthCheck)` re-attempts the run. The override exists
 * because the cookie names this is built on are vendor internals that churn
 * (see the three-state note in auth-check.js) — the user must always be able
 * to say "I really am signed in, go".
 */
function showSignInGate({ signedOut = [], unknown = [], message, onProceed }) {
  document.getElementById("signin-gate-backdrop")?.remove();
  const backdrop = el("div", { id: "signin-gate-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content signin-gate" });

  const header = el("div", { className: "modal-header" });
  header.append(
    el("h3", { className: "modal-title" }, "Sign in before running"),
    el("button", { className: "modal-close-btn", title: "Close" }, "×")
  );

  const body = el("div", { className: "modal-body" });
  body.append(el("p", {}, message || "Some engines need you to sign in first."));

  const list = el("div", { className: "signin-engine-list" });
  const needed = [...signedOut, ...unknown];
  for (const eng of signedOut) {
    list.append(el("div", { className: "signin-engine" },
      el("span", { className: "signin-engine-name" }, eng.label),
      el("span", { className: "signin-engine-state is-out" }, "Not signed in")));
  }
  for (const eng of unknown) {
    list.append(el("div", { className: "signin-engine" },
      el("span", { className: "signin-engine-name" }, eng.label),
      el("span", { className: "signin-engine-state is-unknown" }, "Couldn't verify")));
  }
  if (needed.length) body.append(list);
  body.append(el("p", { className: "muted small" },
    "Opening these signs you in on the engine's own page — this extension never sees or handles your password."));

  const footer = el("div", { className: "modal-footer" });
  const openBtn = el("button", { className: "btn primary" },
    needed.length > 1 ? `Open ${needed.length} sign-in pages` : "Open sign-in page");
  openBtn.onclick = async () => {
    for (const eng of needed) {
      if (eng.loginUrl) { try { await send({ type: "open-url", url: eng.loginUrl }); } catch (_) {} }
    }
    openBtn.textContent = "Sign in, then click Re-check";
    openBtn.disabled = true;
    recheckBtn.style.display = "";
    recheckBtn.focus();
  };
  const recheckBtn = el("button", { className: "btn" }, "Re-check & start run");
  recheckBtn.style.display = "none";
  recheckBtn.onclick = () => { close(); onProceed(false); };

  const anywayBtn = el("button", { className: "btn ghost" }, "Run anyway");
  anywayBtn.title = "Skip this check — use if you know you're signed in";
  anywayBtn.onclick = () => { close(); onProceed(true); };

  const cancelBtn = el("button", { className: "btn ghost" }, "Cancel");
  cancelBtn.onclick = () => close();

  footer.append(openBtn, recheckBtn, anywayBtn, cancelBtn);
  modal.append(header, body, footer);
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = wireModalDismiss(backdrop, modal);
  header.querySelector(".modal-close-btn").onclick = () => close();
}

let RECORDS = [];
// Every capture's light row, campaign ones included. Analyze reads it to find
// the previous answer to a campaign prompt, which RECORDS (ad-hoc only) lacks.
let ALL_RECORDS = [];
// The record Analyze last drew, so opening the tab can tell About's
// "Get started" that a real answer was read (see abNoteAnalyzed).
let ANALYZE_SHOWN = null;
let PROJECTS = [];
let viewingId = (() => {
  // ?capture=<id>: the popup's "Full analysis" link opens the full tab on the
  // answer that was on screen, not on whatever is latest.
  try { return new URLSearchParams(location.search).get("capture") || null; } catch (_) { return null; }
})(); // which capture the Analyze tab shows (null = latest)
// Which tab to return to from Analyze, and what to call it in the "← Back
// to X" link. Set by openCapture() from whichever tab was active when a
// capture link was clicked (a Dashboard row, a campaign's Prompt
// Performance table in Campaigns, Compare's run
// links…), so following a link and coming back doesn't require re-finding
// whatever filter/scroll state was on that screen — combined with
// TAB_SCROLL below, showTab() restores it exactly as it was left.
let returnTab = null;
// Back from an answer opened elsewhere (0.67.0): the page it came from is
// still built (a capture arriving meanwhile refreshes it in place), so it is
// shown as it was left, not rebuilt.
window.addEventListener("popstate", () => {
  if (document.querySelector(".panel.active")?.id !== "analyze" || !returnTab) return;
  const to = returnTab;
  returnTab = null;
  if (to === "loader" && !document.getElementById("cpHead")) loadGeo();
  showTab(to);
});
const TAB_LABELS = { dashboard: "Dashboard", loader: "Campaigns", compare: "Compare", about: "About" };
// Per-tab scroll position, keyed by panel id. All tabs share one physical
// scroll container (see withScrollPreserved below), so switching tabs via
// showTab() used to leave the scroll offset wherever the PREVIOUS tab left
// it — landing you somewhere unrelated to where you were on the tab you're
// switching TO (often clamped near the top if the other tab's content is
// shorter). This is what actually restores "come back to where you were."
const TAB_SCROLL = {};
// Tracking-run captures are hidden from the ad-hoc views by default so brand
// measurements and casual browsing never contaminate each other's numbers.
let includeTrackedInAdhoc = false;
let TRACKED_COUNT = 0;
// GEO tab state
let GEO_PROFILES = [];
let TRASHED_PROFILES = []; // soft-deleted campaigns, still within the recovery window
let GEO_PROMPTS = [];
let geoActiveId = null;
// The engine the campaign's results are narrowed to ([] = every engine).
// The rest of the results' state lives with renderCampaignResults (cb*).
let geoEngineFilter = [];
// Campaigns tab (formerly Tracking + Loader) state
let promptTagFilter = []; // tag chips selected in the prompt table sidebar
let promptOnlyUnassigned = false;
let promptSearch = "";
let promptTagRole = "any"; // the prompt list's tag filter matches primary, secondary or either (0.77.0)
let campaignManageOpen = false; // collapsible setup/prompts panel once a campaign is locked
let cbNeedsReload = false; // the open setup saved a change the board hasn't loaded yet
let selectedPromptIds = new Set(); // checked rows in the prompt table, for bulk pause/enable/remove
// Campaign setup state that has to outlive a re-render — every add, filter
// click and search keystroke in this tab rebuilds it from the database:
//   setupDraft — what's typed in the setup form but not saved yet;
//   setupAttemptedFor — the campaign whose "Save & start tracking" was pressed
//     with gaps, so its missing items stay red until they're filled;
//   promptAddMode / promptAddNote — which way of adding prompts is open, and
//     what the last add did.
let setupDraft = null;
let setupAttemptedFor = null;
let promptAddMode = null;
let promptAddNote = null;
const ONBOARD_KEY = "lcfc.onboarding.campaignsDismissed";
let campaignOnboardDismissed = true; // flips to false once we've checked storage, if unset
chrome.storage.local.get(ONBOARD_KEY, (r) => { campaignOnboardDismissed = !!r[ONBOARD_KEY]; });

// A capture with no prompt AND no fan-out/sources/products/places/answer text.
// ChatGPT's client races requests in parallel (force_parallel_switch:"auto",
// auto_switcher_race_winner) and retries — a losing/interrupted request still
// hits our capture endpoint but streams almost nothing. These are legitimate
// captures (raw data is kept, nothing is discarded), just not useful to browse,
// so they are never the answer Analyze opens on by default. (The Dashboard
// lists prompts, and these have none.)
function hasSignal(r) {
  if (!r) return false;
  const fan = ((r.fanout?.search?.length || 0) + (r.fanout?.shopping?.length || 0) + (r.fanout?.image?.length || 0));
  return !!(r.userPrompt || fan || (r.sources && r.sources.length) || (r.products && r.products.length) || (r.places && r.places.length) || r.answerChars);
}

// Which capture Analyze opens by default: the newest one that actually HAS
// something in it, not just the newest one, period. A losing racer (see the
// hasSignal note above) can finish streaming AFTER the real answer and land
// as RECORDS[0] — without this, opening the panel right after running a
// prompt would silently show an all-"—"/all-zero card instead of the answer
// that's sitting right below it, which reads as "the tool is broken" rather
// than "an empty duplicate capture exists". Falls back to the literal newest
// capture if every stored capture is signal-less. This is only for the
// *default*, no-selection landing — an explicit viewingId (a clicked link,
// or "Go to latest" below) always honors the exact capture asked for.
function defaultRecordId() {
  const withSignal = RECORDS.find(hasSignal);
  return (withSignal || RECORDS[0] || null)?.captureId || null;
}

/* ---------- Smooth section swaps ----------
 * Reported: "when you apply a filter the layout change effect is like a
 * sudden glitch."
 *
 * It was: a re-render clears the card (`node.textContent = ""`) and rebuilds
 * it. Between those two the card is zero-height, so the whole page below
 * jumps up and then back down within a single frame — the flash reads as a
 * glitch even though nothing is wrong.
 *
 * The fix is to hold the old height as a floor across the swap and release it
 * on the next frame, once the new content has laid out, so the card resizes
 * from its real old height to its real new one instead of via zero. The new
 * content fades in over that.
 *
 * Called immediately before the `textContent = ""` that starts a rebuild.
 * Everything the caller then appends is synchronous, so by the time the first
 * rAF runs the new layout exists and the floor can go.
 */
function beginSwap(node) {
  if (!node) return;
  const h = node.offsetHeight;
  if (h) node.style.minHeight = `${h}px`;
  node.classList.remove("swap-in");
  requestAnimationFrame(() => {
    node.classList.add("swap-in");
    requestAnimationFrame(() => { node.style.minHeight = ""; });
  });
}

/* ---------- Delayed tooltip ----------
 * `title` attributes are already used throughout this app to explain what a
 * number or badge actually means (e.g. "distinct prompts whose answer cited
 * this source") — but the native browser tooltip fires almost immediately,
 * fights for attention on a screen that's mostly numbers, and doesn't exist
 * at all on touch. This is a slow, deliberate replacement: it only appears
 * after a real pause (2s), so it never competes with the eye scanning the
 * page, and it's opt-in per element rather than a blanket upgrade of every
 * `title` in the app — reserved for the things worth a pause to read (metric
 * definitions, badge semantics), not routine buttons.
 *
 * Two flavours:
 *   data-term="visibility"  a metric from src/lib/glossary.js, rendered in a
 *                           fixed format — name, what it measures, the
 *                           formula, and the caveat that stops it being
 *                           misread. One definition per term, tool-wide, so
 *                           the same metric can't be explained three
 *                           different ways on three different screens.
 *   data-tip="free text"    a one-off explanation of something local.
 *
 * One delegated listener on `document` (set up once, survives every
 * render's full DOM teardown) rather than per-node handlers that would need
 * re-wiring on every re-render.
 */
// 2.5 s (0.78.0, asked for): long enough not to pop up while moving the
// pointer across the page, short enough to find when you pause on something.
const TOOLTIP_DELAY = 2500;
let tipTimer = null;
let tipEl = null;
function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = el("div", { className: "app-tooltip", role: "tooltip" });
  document.body.appendChild(tipEl);
  return tipEl;
}
function showTooltip(target) {
  const key = target.getAttribute("data-term");
  const text = target.getAttribute("data-tip");
  const g = key ? GLOSSARY[key] : null;
  if (!g && !text) return;
  const tip = ensureTipEl();
  tip.textContent = "";
  if (g) {
    // Always the same structured slots: term, what it measures, how it is
    // counted, and what it can't see. The "How to use" advice slot went in
    // 0.59.0: definitions, not instructions.
    tip.append(el("div", { className: "tip-term" }, g.term));
    tip.append(el("div", { className: "tip-what" }, g.what));
    if (g.formula) tip.append(el("div", { className: "tip-formula" }, g.formula));
    if (g.note) tip.append(el("div", { className: "tip-note" }, g.note));
  } else {
    tip.append(el("div", { className: "tip-what" }, text));
  }
  tip.classList.toggle("is-term", !!g);
  tip.style.display = "block";
  tip.style.visibility = "hidden";
  const r = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = r.top - tipRect.height - 9;
  let placement = "top";
  if (top < 4) { top = r.bottom + 9; placement = "bottom"; }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top + window.scrollY)}px`;
  tip.dataset.placement = placement;
  const arrowX = Math.max(12, Math.min(r.left + r.width / 2 - left, tipRect.width - 12));
  tip.style.setProperty("--tip-arrow-x", `${Math.round(arrowX)}px`);
  tip.style.visibility = "visible";
  tip.classList.add("show");
}
function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  if (tipEl) { tipEl.classList.remove("show"); tipEl.style.display = "none"; }
}
// A native title becomes our tooltip (0.78.0): the same look and delay
// everywhere, and never two tooltips at once. Moved the moment the pointer
// or focus arrives, before the browser's own tooltip could show. A control
// with no other label keeps the text as its accessible name.
function adoptTitle(n) {
  if (!n || !n.hasAttribute || !n.hasAttribute("title")) return;
  const t = n.getAttribute("title");
  n.removeAttribute("title");
  if (!t) return;
  if (!n.hasAttribute("data-tip") && !n.hasAttribute("data-term")) n.setAttribute("data-tip", t);
  if (!n.hasAttribute("aria-label") && !n.textContent.trim()) n.setAttribute("aria-label", t);
}
const TIP_SEL = "[data-tip],[data-term],[title]";
function tipTarget(ev) {
  const t = ev.target.closest?.(TIP_SEL);
  if (t) adoptTitle(t);
  return t && (t.hasAttribute("data-tip") || t.hasAttribute("data-term")) ? t : null;
}
document.addEventListener("mouseover", (ev) => {
  const target = tipTarget(ev);
  if (!target) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTooltip(target), TOOLTIP_DELAY);
});
// Keyboard users get the same definitions, after the same pause.
document.addEventListener("focusin", (ev) => {
  const target = tipTarget(ev);
  if (!target || !target.matches(":focus-visible")) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { if (document.activeElement === target) showTooltip(target); }, TOOLTIP_DELAY);
});
document.addEventListener("focusout", hideTooltip);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideTooltip(); });
// The logo and the name (0.78.0, asked: the icon lands on the web page,
// the name on the Dashboard).
const SITE_URL = "https://www.oshwetank.com/tools/citoskeleton";
document.getElementById("brandIcon")?.addEventListener("click", () => {
  try { chrome.tabs.create({ url: SITE_URL }); } catch (_) { window.open(SITE_URL, "_blank", "noopener"); }
});
document.getElementById("brandTitle")?.addEventListener("click", () => document.querySelector('.nav-tab[data-tab="dashboard"]')?.click());
// Definitions for the controls that have none of their own (ui/defs.js).
let defsQueued = false;
new MutationObserver(() => {
  if (defsQueued) return;
  defsQueued = true;
  requestAnimationFrame(() => { defsQueued = false; applyDefs(document); });
}).observe(document.documentElement, { childList: true, subtree: true });
applyDefs(document);
document.addEventListener("mouseout", (ev) => {
  const target = ev.target.closest?.("[data-tip],[data-term]");
  if (!target || (ev.relatedTarget && target.contains(ev.relatedTarget))) return;
  hideTooltip();
});
document.addEventListener("mousedown", hideTooltip);
document.addEventListener("scroll", hideTooltip, true);

// NOTE: engine badges (chatgpt/gemini/etc icon rendering) are handled by
// engineIconEl()/engineChip() further down this file — real brand marks
// (not abstract placeholders), covering all four engines including
// perplexity/grok, added in the fan-out/blank-UI-fix work. The
// original local-work-backup ENGINE_BADGE/engineIcon() here only covered
// chatgpt+gemini with deliberately generic shapes and referenced the old
// ENGINE_ICONS emoji map, which no longer exists — superseded, not merged.

/* Free-text search across prompt text.
 *
 * Every search box in this app used to do one literal `includes()` of the
 * whole query, which meant "phone 50k" matched nothing at all unless the
 * prompt happened to contain that exact string — you effectively had to
 * retype the prompt verbatim for it to show up. A search box promises the
 * opposite, so the query is split into tokens and EVERY token has to appear
 * somewhere in the text (AND, not OR — narrowing as you type is what makes a
 * search box feel responsive). Order and adjacency don't matter.
 */
function matchesSearch(text, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = String(text || "").toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

/* Wraps the matched tokens in <mark> so it's obvious WHY a row matched — with
 * token matching the hit is often not the string you typed. Returns a
 * DocumentFragment, never HTML, so page-derived text is never parsed as
 * markup. */
function highlightMatch(text, query) {
  const frag = document.createDocumentFragment();
  const src = String(text ?? "");
  const toks = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) { frag.append(document.createTextNode(src)); return frag; }
  const re = new RegExp(`(${toks.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})`, "gi");
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) frag.append(document.createTextNode(src.slice(last, m.index)));
    frag.append(el("mark", { className: "search-hit" }, m[0]));
    last = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-length matches
  }
  if (last < src.length) frag.append(document.createTextNode(src.slice(last)));
  return frag;
}

function fanoutRows(records) {
  const rows = [["platform", "prompt", "bucket", "query", "capturedAt"]];
  records.forEach((r) =>
    ["search", "shopping", "image"].forEach((b) =>
      (r.fanout[b] || []).forEach((q) =>
        rows.push([r.platform, r.userPrompt || "", b, q.query, new Date(r.capturedAt).toISOString()])
      )
    )
  );
  return rows;
}
// Cell values come from web page titles/snippets, which we don't control. A value
// starting with = + - @ (or a lone tab/CR) is executed as a FORMULA by Excel and
// Sheets, so prefix those with an apostrophe. Quotes are doubled and every cell is
// quoted so embedded commas/newlines can't break the row structure.
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
function csvOf(rows) {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}
function fanoutCsv(records) {
  return csvOf(fanoutRows(records));
}
// Whichever container actually scrolls: the popup's capped-height
// .app-content, or the page itself in the full-tab view.
// How a jump the user asked for scrolls (0.84.0): smoothly, unless Motion
// is off (Display) or the system asks for reduced motion.
function jumpBehavior() {
  if (document.documentElement.dataset.motion === "off") return "auto";
  return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
function activeScroller() {
  return document.body.classList.contains("popup") ? $(".app-content") : (document.scrollingElement || document.documentElement);
}

// Every render*() function tears down and rebuilds its whole tab's DOM from
// scratch (no diffing) — the simplest, most robust option for a codebase
// this size, but a full teardown mid-scroll otherwise snaps the view back to
// the top on every filter/search change, which reads as a jarring "glitch"
// rather than a filtered update. This restores the scroll position around
// a same-tab re-render (a filter changing, a poll tick, …). It does NOT
// cover switching to a DIFFERENT tab and back — that's TAB_SCROLL in
// showTab() below, a related but distinct problem (there the scroll
// position needs to be remembered PER TAB, not just held steady around one
// tab's own re-render).
//
// Only written back when the render actually moved it. Writing scrollTop,
// even to the value it already has, cancels a smooth scroll in progress in
// current Chrome (153), and the Campaigns tab's 1.5s status poll runs
// through here: a board section link stopped wherever the next poll landed.
function withScrollPreserved(renderFn) {
  const scroller = activeScroller();
  const y = scroller ? scroller.scrollTop : 0;
  renderFn();
  if (scroller && scroller.scrollTop !== y) scroller.scrollTop = y;
}

/* The share icon (0.80.0). Asked: "Continue in… could have been a share
 * icon at the very top corner", not a button on Analyze, the campaign page
 * and the Dashboard. One icon in the app bar sends what the page in view
 * holds — the answer, the campaign, the prompts picked — to another AI; Ask
 * keeps its own "Continue in…". Each page says what it would share. */
const SHARE_BY_TAB = {};
function setShare(tab, src) { SHARE_BY_TAB[tab] = src; syncShareIcon(); }
function activeTabName() { return (document.querySelector(".panel.active") || {}).id || ""; }
function syncShareIcon() {
  const wrap = document.getElementById("appShareWrap");
  if (wrap) wrap.hidden = !SHARE_BY_TAB[activeTabName()];
}
function mountShareIcon() {
  const bar = document.querySelector(".header-actions");
  if (!bar || document.getElementById("appShare")) return;
  const ho = handoffButton({
    id: "appShare", icon: true,
    getParts: async () => { const s = SHARE_BY_TAB[activeTabName()]; return s ? await s.getParts() : []; },
    file: () => { const s = SHARE_BY_TAB[activeTabName()]; return (s && s.file) || "citoskeleton.md"; },
  });
  ho.id = "appShareWrap";
  bar.prepend(ho);
  syncShareIcon();
}
function dashboardParts(rows, picked) {
  const list = rows.slice(0, 200).map((r) => `- "${String(r.text || "").slice(0, 300)}"${(r.engines || []).length ? ` — ${r.engines.map(atEngineLabel).join(", ")}` : ""}${r.latestAt ? ` (${new Date(r.latestAt).toISOString().slice(0, 10)})` : ""}`);
  return [{ title: picked ? `Prompts I picked (${rows.length})` : `Prompts I've asked AI engines (${rows.length}${rows.length > 200 ? ", first 200" : ""})`, text: list.join("\n") }];
}

function showTab(name) {
  const scroller = activeScroller();
  const current = document.querySelector(".panel.active")?.id;
  // Save the tab being left, not the one being entered — entering a tab
  // whose scroll hasn't been recorded yet (first visit) correctly falls
  // through to 0 below rather than inheriting whatever the outgoing tab's
  // offset happened to be.
  if (current && scroller) TAB_SCROLL[current] = scroller.scrollTop;

  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`[data-tab="${name}"]`);
  if (btn) btn.classList.add("active");
  const panel = document.getElementById(name);
  if (panel) {
    panel.classList.add("active");
    // One entrance animation per page opened (0.78.0; nothing when Motion is off).
    panel.classList.remove("panel-enter");
    void panel.offsetWidth;
    panel.classList.add("panel-enter");
    clearTimeout(panel._enterT);
    panel._enterT = setTimeout(() => panel.classList.remove("panel-enter"), 500);
  }
  const slot = document.getElementById("headerPage");
  if (slot) slot.textContent = "";
  // The Dashboard's "Everything you've captured · stored on this computer"
  // note went in 0.78.0 (asked: "Don't add this everywhere"); where the data
  // lives is said once, in About.
  if (name === "loader" && cbHeaderNav) setHeaderPage("loader", cbHeaderNav);
  // The full tab's tools, whenever the full-tab Analyze is what's showing (it
  // may have its answer panel hidden, 0.60.0).
  if (name === "analyze" && atHeaderNodes && document.querySelector("#analyze .at-grid")) setHeaderPage("analyze", ...atHeaderNodes);
  if (name === "about") aboutEnter();
  if (name === "ask") renderAsk(document.getElementById("ask"), { openCapture, openSettings: () => { showTab("about"); abGo("settings"); setTimeout(() => document.getElementById("setAi")?.scrollIntoView({ block: "start" }), 50); } });
  if (name === "analyze") abNoteAnalyzed(ANALYZE_SHOWN);
  syncShareIcon();

  // Switching tabs changes the document's total scrollable height (each
  // tab's content is a different length), so the browser clamps whatever
  // scrollTop carried over from the outgoing tab to fit — landing
  // somewhere on the new tab that has nothing to do with where it was last
  // left, often near the top if the outgoing tab's content was taller.
  // Restoring the INCOMING tab's own remembered offset (0 on first visit)
  // is what actually returns you to where you were.
  if (scroller) scroller.scrollTop = TAB_SCROLL[name] || 0;
}
// List records omit heavy fields (answerText, reasoning) to keep the popup fast.
// Analyze needs the full record, so hydrate just the one being viewed and cache it.
const FULL = new Map();
async function hydrate(captureId) {
  if (!captureId) return null;
  if (FULL.has(captureId)) return FULL.get(captureId);
  const r = await send({ type: "get-record", captureId });
  const rec = r.ok ? r.record : null;
  // Product cards stored without their picture (before 1.0.1) take the image
  // titled with their name, so they show it without being read again.
  // Gemini's cards carry their pictures as a list (`images`), and Analyze
  // drew none of them: 569 product pictures over 33 answers of a live run
  // (22 Nov 2026) never showed (1.0.2). The first is the card's picture.
  if (rec && Array.isArray(rec.products)) rec.products = rec.products.map((p) => (p && !p.image && Array.isArray(p.images) && typeof p.images[0] === "string" && /^https?:\/\//.test(p.images[0]) ? { ...p, image: p.images[0] } : p));
  if (rec && Array.isArray(rec.products) && rec.products.some((p) => p && !p.image)) rec.products = pictureProducts(rec.products, rec.images);
  if (rec) FULL.set(captureId, rec);
  return rec;
}

async function openCapture(captureId) {
  // Hydrate BEFORE switching tabs. A capture can legitimately be gone by the
  // time it is clicked — retention prunes the oldest ones — and if it is,
  // renderAnalyze() falls through to RECORDS[0] and silently shows a
  // completely unrelated capture. Every "click a prompt / URL / domain to
  // open it in Analyze" path lands here, so the guard belongs here.
  const rec = await hydrate(captureId);
  if (!rec) {
    showToast("That capture is no longer stored — it was pruned by the retention limit.");
    return;
  }
  // Remember where this click came from, UNLESS it came from Analyze itself
  // (re-opening a different capture while already there isn't "arriving
  // from" anywhere new — leave whatever return path was already set alone,
  // so a chain of Analyze -> another link -> Analyze doesn't lose the
  // original tab you actually want "back" to return to).
  const current = document.querySelector(".panel.active")?.id;
  if (current && current !== "analyze") {
    returnTab = current;
    // The browser's Back (or the mouse's back button) returns there too.
    try { history.pushState({ cito: "analyze", from: current }, ""); } catch (_) { /* no history here */ }
  }
  viewingId = captureId;
  // A different answer starts with its details sheet and menus closed.
  apSheet = null; apMenuOpen = false; apFanAll = false; apPromptOpen = false;
  atResetState();
  showTab("analyze");
  renderAnalyze();
}

async function load() {
  // Every fetch below is a full chrome.runtime.sendMessage round trip to the
  // service worker (which may need to cold-start after being idle — MV3
  // service workers get killed after ~30s), and get-records specifically
  // scans the ENTIRE derived store on every call with no cap or pagination.
  // These four calls are mutually independent (none reads another's result),
  // but used to run strictly one-after-another via sequential awaits — 4-6
  // chained round trips before anything painted. That's exactly what "won't
  // open on one click" feels like, and get-records' cost grows with total
  // captures stored, so it also gets slower the more the extension is used.
  // Firing them concurrently caps the wait at the slowest ONE of them
  // instead of the sum of all of them.
  const recordsP = send({ type: "get-records" });
  const projectsP = send({ type: "project-list" });
  const statsP = send({ type: "stats" });
  const geoP = loadGeo(); // self-contained: fetches its own data, renders Campaigns itself

  const res = await recordsP;
  // res.error (set by send()'s catch, not a normal "no records yet" reply)
  // means this page's connection to the extension is actually broken — most
  // commonly "Extension context invalidated", which happens to every already
  // -open popup/tab the instant the extension gets reloaded or updated from
  // chrome://extensions. Falling through to `all = []` here would render the
  // ordinary "No captures yet" placeholder, which is actively misleading —
  // there may be plenty of captures, this page just can't reach them anymore.
  // The fix for the user is simple (close and reopen the popup, or refresh
  // the tab) but only if they're told that's what's wrong.
  if (!res.ok && res.error) {
    const root = $("#analyze");
    if (root) {
      root.textContent = "";
      root.append(
        el("div", { className: "card warn-box", style: "margin: 20px; color: var(--red-fg);" },
          el("h3", {}, "Couldn't connect to the extension"),
          el("p", {}, "This usually happens right after the extension is reloaded or updated while this popup/tab was already open."),
          el("p", { style: "font-weight:500;" }, "Close this popup and reopen it (or refresh the page, if you're in Full tab view)."),
          el("p", { className: "muted", style: "font-size: 11px;" }, `Details: ${esc(res.error)}`)
        )
      );
    }
    return;
  }
  // ISOLATION — the one place tracking data is separated from browsing data.
  // Everything downstream (Analyze, Dashboard, Compare, every export, the
  // drill-downs) reads RECORDS, so filtering here means a brand-tracking run
  // can never inflate the ad-hoc Dashboard's counts or pollute the Compare
  // prompt list. Tracking responses are reached only through the Tracking tab,
  // which asks the service worker for computed metrics instead. Do not add a
  // second filter downstream; add it here or it will drift.
  const all = res.ok ? res.records : [];
  const parts = partitionRecords(all);
  RECORDS = includeTrackedInAdhoc ? all : parts.adhoc;
  ALL_RECORDS = all;
  TRACKED_COUNT = parts.tracked.length;

  // Paint Analyze — the default-visible tab — the moment ITS OWN data
  // (RECORDS + the hydrated capture) is ready. renderAnalyze() reads only
  // RECORDS/FULL, never PROJECTS or GEO_*, so there's no reason the very
  // first thing a user sees should wait on project-list/geo/stats too.
  const showing = viewingId || defaultRecordId();
  await hydrate(showing);
  renderAnalyze();

  const pr = await projectsP;
  PROJECTS = pr.ok ? pr.projects : [];
  await geoP; // populates GEO_PROFILES/GEO_PROMPTS: the Dashboard names each prompt's campaign
  renderDashboard();

  const s = await statsP;
  const st = $("#status");
  if (st) st.textContent = s.ok ? `${s.derived} captures stored` : "";
  renderStorageInfo(s);
  // After PROJECTS is populated, so the project picker can be filled.
  refreshComparePickers();
  renderCompare();
}

// The storage meter lives in About's Settings (see renderStorageMeter).
function renderStorageInfo(s) {
  abStats = s;
  renderStorageMeter();
}

function projectName(id) {
  const p = PROJECTS.find((x) => x.id === id);
  return p ? p.name : null;
}

function downloadData(filename, content) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function cleanPassage(p) {
  if (!p) return "";
  let text = sanitizeText(p);
  if (text.length > 180) {
    text = text.slice(0, 180) + "…";
  }
  return text;
}

function escapeRegExp(s) {
  return (s || "").replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}

// Rejects table scaffolding and listicle boilerplate captured instead of a real
// "Best for …" category. It used to reject any text containing "price" or
// "phone", which threw away legitimate categories in both directions — a phone
// answer could not have a phone category, and "price transparency" was dropped
// in every vertical. The tests below are about shape and filler, not subject.
function isGenericHeaderOrNoise(str) {
  if (!str) return true;
  const s = String(str).trim();
  if (s.length < 3 || s.length > 60) return true;
  if (/^[\s\-—–|:.]+$/.test(s)) return true; // a separator row, not a category
  if (/-{4,}|\|{2,}/.test(s)) return true; // markdown table scaffolding
  // Fragments that restate the listicle rather than naming a use case.
  if (/^(you can buy|right now|approx\.?|approximately|overall|today|in \d{4})\b/i.test(s)) return true;
  return false;
}

// Words that can legitimately start the NEXT SENTENCE right after a brand
// name is narrated ("...Kreo Harpy.  \nIts ~55g weight makes it particularly
// attractive...") but can never legitimately start a real model name.
// sanitizeText() collapses all whitespace — including the line break that
// visually separated the sentences — into a single space before the model
// regex below ever runs, so by then there's no line-break signal left to
// tell "start of a new sentence" apart from "next word of the model name".
// Without this, a capitalized word beginning that next sentence reads as if
// it were part of the model: "Its" became a phantom model tag on Kreo Harpy.
const SENTENCE_START_STOPWORDS = new Set([
  "the", "a", "an", "it", "its", "this", "that", "these", "those", "they",
  "their", "he", "his", "she", "her", "we", "our", "you", "your", "i",
  "if", "and", "but", "so", "as", "also", "however", "meanwhile", "still",
  "overall", "in", "at", "for", "with", "while", "when", "then",
]);

/**
 * Vendor names this capture states outright, rather than infers.
 *
 * Two sources, both structured: the engine's own "Product Vendor" entity
 * annotations, and the maker of each carded product. Neither is guesswork, so
 * they are the right roots to file loose SKU mentions under.
 */
// knownVendors() moved to src/lib/analyzeView.js in 0.48.0 (shared with the compare view).

// Bare spec and qualifier tokens that are never a model on their own. A chip
// reading just "5G" or "Fast" says nothing — these turned up in a real capture
// as models of "Realme P4" alongside "Power 80W 10".
const MODEL_STOP_TOKENS = new Set([
  "5g", "4g", "3g", "lte", "wifi", "wi-fi", "nfc", "gb", "tb", "mah", "hz", "mp",
  "pro", "plus", "max", "ultra", "lite", "mini", "fast", "power", "series",
  "edition", "new", "latest", "phone", "phones", "model", "models",
]);

function extractBrandModels(brandName, products, rawText) {
  const models = new Set();
  const lowerBrand = brandName.toLowerCase();
  
  // 1. Check products list first
  for (const p of products || []) {
    if (p.name && p.name.toLowerCase().includes(lowerBrand)) {
      let m = sanitizeText(p.name).replace(new RegExp(`^${escapeRegExp(brandName)}\\s*`, "i"), "").trim();
      if (m && m.length > 1 && m.length < 50) models.add(m);
    }
  }
  
  // 2. Extract model phrases following brand name in sanitized text
  const clean = sanitizeText(rawText);
  if (clean) {
    const escaped = escapeRegExp(brandName);
    const lineRegex = new RegExp(`\\b${escaped}\\s+([A-Za-z0-9\\-\\(\\)]+(?:\\s+[A-Za-z0-9\\-\\+\\(\\)]+){0,4})`, "gi");
    let match;
    while ((match = lineRegex.exec(clean)) !== null) {
      let phrase = match[1].trim();
      const words = phrase.split(/\s+/);
      const modelWords = [];
      for (const w of words) {
        // A model name is a proper noun or a part number — "Nord CE6 5G",
        // "Galaxy S25 Ultra", "OPC 53 Grade". An all-lowercase word is ordinary
        // prose, so the name ended at the previous word.
        //
        // Without this the regex just swallowed the next five words of the
        // sentence, which only looked acceptable on phone answers because model
        // names happen to follow the brand there. In other verticals it
        // produced flatly wrong output — "HDFC Bank" was credited with a model
        // called "offers personal loans at competitive", "Apollo Hospitals"
        // with "runs cardiac centres nationwide" — and it leaked on phones too
        // ("Galaxy S25 Ultra leads").
        if (!/^[A-Z]/.test(w) && !/\d/.test(w)) break;
        // A capitalized word is also how the NEXT SENTENCE starts, and that
        // sentence-boundary capital is indistinguishable from a model-name
        // capital once whitespace is flattened (see SENTENCE_START_STOPWORDS
        // above) — so reject a would-be first model word that's actually a
        // common pronoun/article/connective, e.g. "Its" in "Kreo Harpy Its
        // ~55g weight makes it particularly attractive...".
        if (modelWords.length === 0 && SENTENCE_START_STOPWORDS.has(w.replace(/[^\w]/g, "").toLowerCase())) break;
        modelWords.push(w);
      }
      let modelName = modelWords.join(" ").trim();
      modelName = modelName.replace(/[\(\)]/g, " ").replace(/\s+/g, " ").trim();
      if (modelName && modelName.length > 1 && modelName.length < 45) {
        models.add(modelName);
      }
    }
  }
  
  // A chip reading just "5G" or "Fast" says nothing, and a model already
  // contained in a longer one is the same model twice. Both showed up in a
  // real capture as models of "Realme P4": 5G, Fast, Power, Power 80W 10.
  const list = [...models].filter((m) => {
    const words = m.toLowerCase().split(/\s+/);
    return !words.every((w) => MODEL_STOP_TOKENS.has(w.replace(/[^a-z0-9-]/g, "")));
  });
  const longestFirst = list.sort((a, b) => b.length - a.length);
  const out = [];
  for (const m of longestFirst) {
    if (!out.some((kept) => kept.toLowerCase().includes(m.toLowerCase()))) out.push(m);
  }
  return out.slice(0, 5);
}

function extractRankAndCategory(brandName, passage, text) {
  const fullText = sanitizeText((text || "") + "\n" + (passage || ""));
  const escapedBrand = escapeRegExp(brandName);
  
  let rank = null;
  let category = null;

  // 1. Match numbered list header: e.g. "1. OnePlus 13 (Best Overall)" or "1. OnePlus 13 - Overall flagship value"
  const listRegex = new RegExp(
    `(?:^|\\n)\\s*(\\d+)\\.\\s+.*?\\b${escapedBrand}\\b.*?(?:[\\(–\\-—:]\\s*([^\\n\\)]+))?`,
    "i"
  );
  const listMatch = fullText.match(listRegex);
  if (listMatch) {
    rank = `#${listMatch[1]}`;
    if (listMatch[2]) {
      // Bounded before the generic-noise check: the capture runs to end of
      // line, and sanitizeText() has already flattened the table pipes, so
      // without this the next column comes along for the ride ("Video &
      // Long-Term Reliability Approx").
      const candidate = trimLabel(listMatch[2]);
      if (candidate && !isGenericHeaderOrNoise(candidate)) {
        category = candidate;
      }
    }
  }

  // 2. Match summary callout: e.g. "Best for: Gaming, photography..." or "Best overall: OnePlus 13"
  if (!category) {
    const summaryRegex = new RegExp(
      `(?:Best\\s+for|Best\\s+overall|Best\\s+camera|Best\\s+gaming|Best\\s+compact)[\\s:]+.*?\\b${escapedBrand}\\b|(?:^|\\n)\\s*Best\\s+for:\\s*([^\\n.,]+)`,
      "i"
    );
    const summaryMatch = fullText.match(summaryRegex);
    if (summaryMatch && summaryMatch[1]) {
      const candidate = trimLabel(summaryMatch[1]);
      if (candidate && !isGenericHeaderOrNoise(candidate)) category = candidate;
    }
  }

  return { rank, category };
}

// extractBrandAspects() and its vocabulary live in src/lib/aspects.js (since
// 0.50.0), shared with the campaign board.

// The vocabulary the Search-Funnel card scans source snippets with.
//
// This used to be a hardcoded list of 20 phone/laptop makers, which meant the
// whole "Evaluated vs. Omitted" card silently found nothing outside consumer
// electronics — lending, cement, healthcare, beverages and every other vertical
// got an empty card that looked like "nothing was omitted" rather than "this
// never ran". The names now come from what the automatic detector already found
// in THIS capture (src/lib/brands.js — entity markers, product/place data and
// cited domains), so it carries no industry vocabulary of its own.
//

function openDomainModal(domainName, rec) {
  const existing = document.getElementById("domain-modal-backdrop");
  if (existing) existing.remove();

  const domainSources = rec.sources.filter((s) => s.domain === domainName);
  const citedCount = domainSources.filter((s) => s.outcome === "cited").length;
  const fetchedCount = domainSources.filter((s) => s.outcome === "fetched").length;
  const newsCount = domainSources.filter((s) => s.type === "news").length;

  const backdrop = el("div", { id: "domain-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content" });

  const header = el("div", { className: "modal-header" });
  header.append(
    el("div", { style: "display:flex;align-items:center;gap:8px;" },
      el("h3", { style: "margin:0;font-size:15px;color:var(--fg-primary);" }, domainName),
      el("span", { className: "tag cited" }, `${domainSources.length} URLs`)
    )
  );

  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  header.append(closeBtn);
  modal.append(header);

  const body = el("div", { className: "modal-body" });

  const statsRow = el("div", { className: "modal-stats-row" },
    el("span", { className: "chip active" }, `Cited: ${citedCount}`),
    el("span", { className: "chip" }, `Fetched: ${fetchedCount}`),
    el("span", { className: "chip" }, `News: ${newsCount}`)
  );
  body.append(statsRow);

  const ul = el("ul", { className: "srclist", style: "margin-top:12px;" });
  domainSources.forEach((s, idx) => {
    const li = el("li", { className: "src-item" });
    const h = el("div", { className: "src-header" });
    h.append(el("span", { className: "url-rank-badge" }, `#${idx + 1}`));
    h.append(el("span", { className: `tag ${s.outcome}` }, s.outcome));
    if (s.type === "news") h.append(el("span", { className: "tag news" }, "news"));
    
    const a = el("a", { href: s.url, target: "_blank", rel: "noreferrer", className: "src-title" }, s.title || s.url);
    h.append(a);
    li.append(h);

    if (s.snippet) {
      const snip = el("div", { className: "url-snippet-box" }, s.snippet.trim());
      snip.append(el("span", { className: "char-badge" }, `[${s.snippet.length}c]`));
      li.append(snip);
    }
    ul.append(li);
  });
  body.append(ul);

  const doneBtn = el("button", { className: "btn sm primary" }, "Done");
  const footer = el("div", { className: "modal-footer" },
    el("button", { className: "btn sm ghost", onclick: () => downloadData(`domain_${domainName}.json`, JSON.stringify(domainSources, null, 2)) }, "Export Domain JSON"),
    doneBtn
  );
  body.append(footer);

  modal.append(body);
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = wireModalDismiss(backdrop, modal);
  closeBtn.onclick = close;
  doneBtn.onclick = close;
}

function openProductModal(product, rec) {
  const existing = document.getElementById("product-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "product-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content" });

  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  const header = el("div", { className: "modal-header" },
    el("h3", {}, `📦 ${product.name}`),
    closeBtn
  );

  const body = el("div", { className: "modal-body" });

  // Price & Merchant Breakdown
  // Was overriding .card's own theme-aware var(--card-bg) with a hardcoded
  // translucent WHITE. In dark mode this card stayed a near-white box while
  // .card's default text color (inherited var(--fg-primary), near-white in
  // dark mode) never changed — near-white text on a near-white background,
  // genuinely illegible. Dropping the override lets .card's real background
  // apply, the same as every other card in the app.
  const priceInfo = el("div", { className: "card", style: "margin-bottom: 12px;" },
    el("div", { style: "font-weight: 500; font-size: 14px; color: var(--accent);" }, product.price || "Price specified in response text"),
    el("div", { className: "muted", style: "font-size: 12px; margin-top: 4px;" }, `E-Commerce Merchant: ${product.merchant || "Multiple E-Commerce Retailers"}`),
    el("div", { className: "muted", style: "font-size: 11px; margin-top: 2px;" }, `Rating Source: ${product.rating ? product.rating + " ★ rating aggregated from store metadata & search snippets" : "Rating derived from user evaluation in response"}`)
  );
  body.append(priceInfo);

  // Mentioned Passages & Sources for this Product
  const firstKeyword = (product.name || "").split(/\s+/)[0];
  const matchingSources = (rec.sources || []).filter(s => 
    (s.title || "").toLowerCase().includes(firstKeyword.toLowerCase()) ||
    (s.snippet || "").toLowerCase().includes(firstKeyword.toLowerCase())
  );

  if (matchingSources.length) {
    const srcHeader = el("h4", { style: "margin: 12px 0 6px; font-size: 12px;" }, `Contributing E-Commerce & Web Sources (${matchingSources.length}):`);
    body.append(srcHeader);

    const srcList = el("ul", { className: "srclist" });
    matchingSources.forEach(s => {
      const li = el("li", { className: "src-item" });
      const h = el("div", { className: "src-header" },
        el("span", { className: `tag ${s.outcome}` }, s.outcome),
        el("a", { href: s.url, target: "_blank", rel: "noreferrer", style: "font-weight: 500; font-size: 12px; text-decoration: none; color: var(--accent);" }, s.domain || s.url)
      );
      li.append(h);
      if (s.title) li.append(el("div", { style: "font-size: 11px; font-weight: 500; margin-top: 4px;" }, s.title));
      if (s.snippet) li.append(el("div", { className: "brand-quote", style: "margin-top: 4px;" }, `"${cleanPassage(s.snippet)}"`));
      srcList.append(li);
    });
    body.append(srcList);
  } else {
    body.append(el("div", { className: "muted", style: "font-size: 11px;" }, "Product mentioned directly in ChatGPT's answer text. No external store domain was directly linked."));
  }

  modal.append(header, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  closeBtn.onclick = wireModalDismiss(backdrop, modal);
}

function scrollToCard(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.scrollIntoView({ behavior: jumpBehavior(), block: "center" });
  target.classList.add("card-highlight");
  setTimeout(() => target.classList.remove("card-highlight"), 1800);
}

// variant: "success" (default — original green-dot look, unchanged) |
// "error" (red dot, longer-lived, has its own dismiss button — this is
// what every alert(...) in this file now goes through instead) | "info".
function showToast(text, variant = "success", ms = variant === "error" ? 7000 : 3500) {
  const old = $(".app-toast");
  if (old) old.remove();

  const toast = el("div", { className: `app-toast toast-${variant}` },
    el("div", { className: "toast-dot" }),
    el("span", { className: "toast-msg" }, text)
  );
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  if (variant === "error") {
    const closeBtn = el("button", { className: "toast-close", title: "Dismiss" }, "×");
    closeBtn.onclick = () => { toast.classList.remove("show"); setTimeout(() => toast.remove(), 300); };
    toast.append(closeBtn);
  }
  document.body.append(toast);

  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, ms);
}

// Listen for captured items broadcasted from background worker
/* Reported: during a run the panel "glitches" and the prompt list keeps
 * jumping back to the top, so there is no way to scroll down and watch the
 * prompts that are still to come.
 *
 * These broadcasts arrive once per captured prompt, plus again when the
 * on-device enrichment pass improves that same record — so a long run fires
 * hundreds of them. Each one called load(), which refetches everything and
 * rebuilds every tab's DOM from scratch; that rebuild resets scrollTop, so
 * any attempt to scroll was undone by the next captured prompt. Two things
 * are needed, and withScrollPreserved supplies neither: load() is async, so
 * a synchronous save/restore around it would restore before the DOM it is
 * meant to hold steady has even been built; and a burst of broadcasts has to
 * collapse into one rebuild rather than several back-to-back.
 */
let refreshPending = null;
function refreshFromBroadcast() {
  if (refreshPending) return; // a refresh is already queued — it will pick this up too
  refreshPending = setTimeout(async () => {
    refreshPending = null;
    const scroller = activeScroller();
    const y = scroller ? scroller.scrollTop : 0;
    cpFromBroadcast = true;
    try { await load(); } finally { cpFromBroadcast = false; } // awaits geoP, so the Campaigns tab has rendered before we restore
    if (scroller && scroller.scrollTop !== y) scroller.scrollTop = y; // see withScrollPreserved
  }, 400);
}

const patchIds = new Set();
let patchTimer = null;
function patchFromBroadcast(captureId) {
  patchIds.add(captureId);
  if (patchTimer) return;
  patchTimer = setTimeout(async () => {
    patchTimer = null;
    const ids = [...patchIds];
    patchIds.clear();
    if (refreshPending) { ids.forEach((id) => FULL.delete(id)); return; } // a full refresh is already coming
    for (const id of ids) {
      FULL.delete(id);
      const r = await send({ type: "get-record-light", captureId: id });
      const i = ALL_RECORDS.findIndex((x) => x.captureId === id);
      if (!r.ok || !r.record || i < 0) { refreshFromBroadcast(); return; } // new or gone: the whole list
      ALL_RECORDS[i] = r.record;
    }
    RECORDS = includeTrackedInAdhoc ? ALL_RECORDS : partitionRecords(ALL_RECORDS).adhoc;
    const active = document.querySelector(".panel.active")?.id;
    const scroller = activeScroller();
    const y = scroller ? scroller.scrollTop : 0;
    if (active === "analyze") {
      const showing = viewingId || defaultRecordId();
      if (!ids.includes(showing)) return; // the answer on screen didn't change
      await hydrate(showing);
      renderAnalyze();
    } else if (active === "dashboard") renderDashboard();
    if (scroller && scroller.scrollTop !== y) scroller.scrollTop = y;
  }, 400);
}

const announced = new Set();
let lastAnnounced = 0;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "new-capture") {
    refreshFromBroadcast();
    // Once per answer, and at most one notice every 15 s however many come.
    if (!msg.duringRun && msg.captureId && !announced.has(msg.captureId) && Date.now() - lastAnnounced > 15000) {
      lastAnnounced = Date.now();
      showToast("New LLM citation captured!");
    }
    if (msg.captureId) announced.add(msg.captureId);
  }
  // The optional on-device AI pass finished and improved a record that is
  // already on screen. Refresh silently: the capture was announced moments
  // ago, and a second toast for the same prompt reads like a second capture.
  // 0.74.0: only that record is fetched and patched in, and only the tab on
  // screen is redrawn (the AI queue sends several of these per capture; each
  // used to refetch every capture and rebuild three tabs).
  if (msg?.type === "capture-updated") {
    if (msg.captureId) patchFromBroadcast(msg.captureId);
    else refreshFromBroadcast();
  }
});

/* ---------- Analyze (most recent capture) ---------- */
/* ---------- Analyze, popup layout (0.47.0) ----------
 * The popup gets its own Analyze, built from src/lib/analyzeView.js. (The
 * full tab got its own too in 0.48.0: renderAnalyzeTab.)
 *
 * Why a separate layout. Reported on the design canvas: the popup's Analyze
 * "provides less information", the box under the product cards was "half cut
 * from the bottom", and the searches (fan-out) were "getting cut". The old
 * popup was the full-tab card stack squeezed to 540px: General Information
 * first, searches far down the page, and each search ellipsised. This one
 * reads top to bottom in the order the owner asked for — the searches the
 * engine ran directly under the prompt, then what led the answer (product
 * cards, map or images), your brand, every brand with what backs it, every
 * cited page, and what changed since the last time.
 *
 * Nothing in it squeezes: .ap is a plain column inside the scrolling
 * .app-content, so a tall section makes the popup scroll instead of being
 * shrunk to fit and cut off. analyze-popup.test.mjs measures that.
 */
let apSheet = null;        // which details tab is open in the popup's sheet, or null
let apSheetProduct = 0;    // the product the "Where to buy" tab shows
let apFanAll = false;      // "Show all N searches"
let apPromptOpen = false;  // long prompt expanded
let apMenuOpen = false;
let apTab = "overview";    // the popup's tab (0.60.0)

const AP_FAN_MAX = 5;
const AP_KIND_VAR = {
  "Your site": "--kind-you", "Rival brand sites": "--kind-rival", "Review sites": "--kind-review",
  "Retailers": "--kind-retail", "Forums & social": "--kind-forum", "Public & reference": "--kind-public", "Other": "--kind-other",
};
const apOrd = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const apDate = (t) => new Date(t).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
const apTime = (t) => new Date(t).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });

function apSection(id, title, count, extra) {
  const head = el("div", { className: "ap-sec-head" });
  const h = el("h2", { className: "ap-h", id: `${id}-h` }, title);
  if (count != null && count !== "") h.append(el("span", { className: "ap-h-count" }, ` · ${count}`));
  head.append(h);
  if (extra) head.append(extra);
  return el("section", { className: "ap-sec", id, "aria-labelledby": `${id}-h` }, head);
}

function apPill(text, tone, title) {
  return el("span", { className: `ap-pill tone-${tone || "neutral"}`, ...(title ? { title } : {}) }, text);
}

function renderAnalyzePopup(rec, root) {
  if (rec && !abIsDemo(rec)) gsMark("analyzed"); // Get started (1.0.0)
  const knownBrands = knownVendors(rec);
  const own = ownBrandFor(rec, GEO_PROFILES);
  const previous = findPrevious(rec, ALL_RECORDS);
  const kind = answerKind(rec);
  const engineLabel = ENGINES.find((e) => e.id === rec.platform)?.label || rec.platform || "Unknown engine";
  const mentions = normalizeMentions(rec.brandMentions || [], knownBrands);
  const brandNames = mentions.map((b) => b.brand);
  const searches = searchesView(rec, brandNames);
  const brands = brandsView(rec, { own, knownBrands, previous });
  const pages = pagesView(rec, { own, knownBrands });
  const you = yourBrandView(rec, own, { knownBrands, previous });
  const changes = changesView(rec, previous, { knownBrands });
  const cited = pages.rows.length;

  const wrap = el("div", { className: "ap" });
  root.append(wrap);

  if (rec.isDemo || String(rec.captureId || "").startsWith("demo-")) {
    wrap.append(el("div", { className: "demo-banner" },
      el("span", { className: "demo-banner-label" }, "Sample"),
      el("span", {}, "Example data showing what a captured answer looks like — not a real capture. Remove it any time from the About tab.")));
  }

  /* --- sticky head: engine, time, kind, capture paging, menu; the prompt; the strip --- */
  const head = el("header", { className: `ap-head kind-${kind.id}` });
  const row = el("div", { className: "ap-head-row" });
  const eng = engineIconEl(rec.platform);
  eng.classList.add("ap-engine-icon");
  row.append(eng, el("span", { className: "ap-engine" }, engineLabel),
    el("span", { className: "ap-when", title: new Date(rec.capturedAt).toLocaleString(dateLocale()) }, `· ${apDate(rec.capturedAt)}, ${apTime(rec.capturedAt)}`),
    el("span", { className: `ap-kind kind-${kind.id}` }, kind.label));
  const spacer = el("span", { className: "ap-head-spacer" });
  row.append(spacer);
  const idx = RECORDS.findIndex((r) => r.captureId === rec.captureId);
  if (idx >= 0 && RECORDS.length > 1) {
    const go = (j) => { const t = RECORDS[j]; if (!t) return; apSheet = null; apFanAll = false; apPromptOpen = false; apTab = "overview"; openCapture(t.captureId); };
    const newer = el("button", { className: "ap-icon-btn", type: "button", title: "Newer capture", "aria-label": "Newer capture" }, "‹");
    newer.disabled = idx === 0;
    newer.onclick = () => go(idx - 1);
    const older = el("button", { className: "ap-icon-btn", type: "button", title: "Older capture", "aria-label": "Older capture" }, "›");
    older.disabled = idx === RECORDS.length - 1;
    older.onclick = () => go(idx + 1);
    row.append(newer, el("span", { className: "ap-paging" }, `${idx + 1} of ${RECORDS.length}`), older);
  } else if (rec.geo) {
    row.append(el("span", { className: "ap-paging", title: "A campaign capture — open others from the campaign's results" }, "Campaign"));
  }
  const menuBtn = el("button", { className: "ap-icon-btn ap-menu-btn", type: "button", title: "More actions", "aria-label": "More actions", "aria-expanded": apMenuOpen ? "true" : "false" }, "⋯");
  menuBtn.onclick = () => { apMenuOpen = !apMenuOpen; renderAnalyze(); };
  row.append(menuBtn);
  head.append(row);
  if (apMenuOpen) {
    const menu = el("div", { className: "ap-menu", role: "menu" });
    const item = (label, fn, danger) => {
      const b = el("button", { className: `ap-menu-item${danger ? " danger" : ""}`, type: "button", role: "menuitem" }, label);
      b.onclick = async () => { apMenuOpen = false; await fn(); };
      menu.append(b);
    };
    item("Copy the prompt", async () => { try { await navigator.clipboard.writeText(rec.userPrompt || ""); showToast("Prompt copied"); } catch (_) { showToast("Couldn't copy — select the prompt text instead", "error"); } renderAnalyze(); });
    item("Save as PDF", () => { openAnswerReport(rec); renderAnalyze(); });
    item("Save as HTML", () => { exportRecordsAsHtml([rec]); renderAnalyze(); });
    item("Download raw payload", () => { downloadRaw(rec.captureId, "analyze"); renderAnalyze(); });
    item("Report a wrong reading", () => { renderAnalyze(); openFeedbackModal(rec); });
    item("Remove from my history", async () => {
      if (!confirm("Remove this answer from your history? This can't be undone.")) { renderAnalyze(); return; }
      await send({ type: "delete-record", captureId: rec.captureId });
      FULL.delete(rec.captureId);
      viewingId = null;
      showToast("Removed from your history");
      load();
    }, true);
    head.append(menu);
  }
  const promptText = rec.userPrompt || "(no prompt text)";
  const words = promptText.trim().split(/\s+/).length;
  const isLong = words > 28 || promptText.length > 180;
  const h1 = el("h1", { className: `ap-prompt${isLong ? " long" : ""}${isLong && !apPromptOpen ? " clamped" : ""}`, title: promptText }, promptText);
  head.append(h1);
  if (isLong) {
    const t = el("button", { className: "ap-link", type: "button", "aria-expanded": apPromptOpen ? "true" : "false" }, `${apPromptOpen ? "Show less" : "Show all"} · ${words} words`);
    t.onclick = () => { apPromptOpen = !apPromptOpen; renderAnalyze(); };
    head.append(t);
  }
  const strip = el("div", { className: "ap-strip" });
  const chip = (text, on, title, cls) => strip.append(el("span", { className: `ap-chip${on ? " on" : ""}${cls ? " " + cls : ""}`, title }, text));
  if (rec.searched) chip(searches.count ? `Searched the web · ${searches.count} search${searches.count === 1 ? "" : "es"}` : "Searched the web", true, "The engine searched the web before answering", "searched");
  // An empty answer (1.0.2) didn't answer from memory either: say what it was.
  else if (answerKind(rec).id === "noanswer") chip(answerKind(rec).limit ? "No answer · usage limit" : "No answer", true, answerKind(rec).limit ? "The engine refused: its usage limit was reached" : "No answer text came back", "memory");
  else chip("No web search", true, "Answered from what the model already knows", "memory");
  chip(rec.sources.length ? `${rec.sources.length} read · ${cited} cited` : "No pages", rec.sources.length > 0, "Pages the engine opened, and how many it cited");
  if ((rec.products || []).length) chip(`${rec.products.length} products`, true, "Product cards in the answer");
  if ((rec.places || []).length) chip(`Map · ${rec.places.length}`, true, "Places on a map");
  if ((rec.images || []).length) chip(`${rec.images.length} images`, true, "Images from the web");
  if ((rec.ads || []).length) chip(`Ad · ${adAdvertisers(rec)}`, true, "A sponsored card shown with the answer", "ad");
  head.append(strip);
  // The engines that answered this prompt, and the two lenses (0.60.0).
  const answers = answersToPrompt(rec, ALL_RECORDS);
  const cv = compareView(answers, { own });
  const engs = el("div", { className: "ap-engs", role: "group", "aria-label": "Answers to this prompt" });
  cv.engines.forEach((e) => {
    const on = e.captureId === rec.captureId && apTab !== "engines";
    const b = el("button", { className: `ap-eng${on ? " on" : ""}`, type: "button", "aria-pressed": String(on), title: `${e.label}'s answer` },
      el("span", { className: "ap-eng-l" }, el("i", { className: `at-eng-dot e-${e.id}`, "aria-hidden": "true" }), e.label), el("span", { className: "ap-eng-s" }, e.stat));
    b.onclick = () => { if (e.captureId === rec.captureId) { apTab = apTab === "engines" ? "overview" : apTab; renderAnalyze(); return; } apSheet = null; apTab = "overview"; openCapture(e.captureId); };
    engs.append(b);
  });
  if (answers.length > 1) {
    const b = el("button", { className: `ap-eng lens${apTab === "engines" ? " on" : ""}`, type: "button", "aria-pressed": String(apTab === "engines") },
      el("span", { className: "ap-eng-l" }, "Side by side"), el("span", { className: "ap-eng-s" }, `${answers.length} engines`));
    b.onclick = () => { apTab = apTab === "engines" ? "overview" : "engines"; renderAnalyze(); };
    engs.append(b);
  }
  head.append(engs);
  const TABS = {
    shopping: [["overview", "Overview"], ["products", "Products"], ["stores", "Stores"], ["sources", "Sources"], ["ads", "Ads"], ["answer", "Answer"]],
    local: [["overview", "Overview"], ["places", "Places"], ["facts", "Facts"], ["sources", "Sources"], ["ads", "Ads"], ["answer", "Answer"]],
    images: [["overview", "Overview"], ["pictures", "Pictures"], ["sources", "Sources"], ["ads", "Ads"], ["answer", "Answer"]],
    info: [["overview", "Overview"], ["parts", "Parts"], ["sources", "Sources"], ["ads", "Ads"], ["answer", "Answer"]],
    memory: [["overview", "Overview"], ["answer", "Answer"]],
    noanswer: [["overview", "Overview"]],
  }[kind.id].filter(([id]) => id !== "ads" || (rec.ads || []).length);
  if (apTab !== "engines" && !TABS.some(([id]) => id === apTab)) apTab = "overview";
  const tl = el("nav", { className: "ap-tabs", role: "tablist", "aria-label": "Parts of this answer" });
  TABS.forEach(([id, label]) => {
    const b = el("button", { className: `ap-tab${apTab === id ? " on" : ""}`, type: "button", role: "tab", id: `ap-tab-${id}`, "aria-selected": String(apTab === id) }, label);
    b.onclick = () => { apTab = id; apSheet = null; renderAnalyze(); };
    tl.append(b);
  });
  head.append(tl);
  wrap.append(head);
  if (apTab !== "overview") {
    apRenderTab(wrap, rec, { kind, own, knownBrands, brands, pages, cv, answers, mentions, engineLabel });
    return;
  }

  /* --- 1. searches it ran, right under the prompt --- */
  if (searches.count) {
    const extra = el("span", { className: "ap-sec-meta" });
    if (searches.breadth) extra.append(apPill(searches.breadth.short, searches.breadth.band === "narrow" ? "warn" : searches.breadth.band === "broad" ? "good" : "neutral", `Breadth: ${searches.breadth.label}`));
    extra.append(el("span", { className: "ap-muted" }, `avg ${searches.avgWords} words · ${searches.namingBrand} name${searches.namingBrand === 1 ? "s" : ""} a brand`));
    const sec = apSection("ap-searches", "Searches it ran", searches.count, extra);
    const ol = el("ol", { className: "ap-fan" });
    const shown = apFanAll ? searches.rows : searches.rows.slice(0, AP_FAN_MAX);
    shown.forEach((q) => {
      ol.append(el("li", { className: "ap-fan-row" },
        el("span", { className: `ap-lane lane-${q.lane}`, title: q.laneLabel, "aria-label": q.laneLabel }, { web: "W", shopping: "S", image: "I" }[q.lane] || "•"),
        el("span", { className: "ap-fan-text" }, q.text),
        q.tag ? el("span", { className: "ap-tag" }, q.tag) : el("span", {})));
    });
    sec.append(ol);
    if (searches.rows.length > AP_FAN_MAX) {
      const more = el("button", { className: "ap-link", type: "button", "aria-expanded": apFanAll ? "true" : "false" }, apFanAll ? "Show fewer" : `Show all ${searches.rows.length} searches`);
      more.onclick = () => { apFanAll = !apFanAll; renderAnalyze(); };
      sec.append(more);
    }
    wrap.append(sec);
  } else if (searches.unpublished) {
    const sec = apSection("ap-searches", "Searches it ran", "");
    sec.append(el("p", { className: "ap-note" }, `${engineLabel} confirms it searched the web for this answer but doesn't publish what it searched for, so there is no list to show. That's the engine, not a failed capture.`));
    wrap.append(sec);
  }

  /* --- 2. what led the answer --- */
  if ((rec.products || []).length) {
    const sec = apSection("ap-products", "Product cards", rec.products.length, el("span", { className: "ap-muted" }, "click one to see where it's sold"));
    const strip2 = el("div", { className: "ap-cards" });
    rec.products.forEach((p, i) => {
      const mine = own && you && new RegExp(`^${escapeRegExp(own.name)}\\b`, "i").test(String(p.name || ""));
      // The product's picture, as on the engine's card (0.58.0: the cards
      // were reported as coloured boxes with no image).
      const b = el("button", { className: `ap-card${mine ? " mine" : ""}`, type: "button", title: p.name || "" },
        withImage(el("span", { className: "ap-card-thumb" }, glyphEl("cart", 22)), p.image, p.name),
        el("span", { className: "ap-card-n" }, String(i + 1)),
        el("span", { className: "ap-card-name" }, p.name || "—"),
        el("span", { className: "ap-card-price" }, p.price || "price not shown"),
        el("span", { className: "ap-card-meta" }, [p.rating != null ? `★ ${p.rating}` : "", p.merchant || ""].filter(Boolean).join(" · ") || "no store named"));
      b.onclick = () => { apSheet = "buy"; apSheetProduct = i; renderAnalyze(); };
      strip2.append(b);
    });
    sec.append(strip2);
    wrap.append(sec);
  }
  if ((rec.places || []).length) {
    const sec = apSection("ap-places", "On the map", rec.places.length);
    const ol = el("ol", { className: "ap-places" });
    rec.places.slice(0, 5).forEach((p, i) => {
      const mine = own && String(p.name || "").toLowerCase().startsWith(own.name.toLowerCase());
      ol.append(el("li", { className: `ap-place${mine ? " mine" : ""}` },
        el("span", { className: "ap-pin" }, String(i + 1)),
        el("span", { className: "ap-place-name" }, p.name || "—"),
        el("span", { className: "ap-muted" }, [p.rating != null ? `★ ${p.rating}` : "", p.category || ""].filter(Boolean).join(" · "))));
    });
    sec.append(ol);
    if (rec.places.length > 5) {
      const more = el("button", { className: "ap-link", type: "button" }, `All ${rec.places.length} places`);
      more.onclick = () => { apSheet = "places"; renderAnalyze(); };
      sec.append(more);
    }
    wrap.append(sec);
  }
  if ((rec.images || []).length) {
    const sec = apSection("ap-images", "Images shown", rec.images.length);
    const grid = el("div", { className: "ap-imgs" });
    // Every image, three to a row at a size you can see (0.58.0: six to a
    // row at 54px tall read as a strip of coloured chips).
    rec.images.forEach((im) => {
      let host = "";
      try { host = new URL(im.url).hostname.replace(/^www\./, ""); } catch (_) {}
      grid.append(el("a", { className: "ap-img", href: im.url, target: "_blank", rel: "noreferrer", title: im.title || host },
        withImage(el("span", { className: "ap-img-frame" }, el("span", { className: "ap-img-ph" }, im.title || host || "image")), im.url, im.title),
        el("span", { className: "ap-img-from" }, im.title || im.attribution || host)));
    });
    sec.append(grid);
    wrap.append(sec);
  }
  if ((rec.ads || []).length) {
    const ads = adsView(rec);
    const sec = apSection("ap-ads", "Ad shown with the answer", ads.length > 1 ? ads.length : "", apPill("Sponsored", "warn", "Paid placement, not part of the answer"));
    ads.forEach((a) => sec.append(adCardEl(a)));
    wrap.append(sec);
  }
  if (kind.id === "noanswer") {
    wrap.append(el("section", { className: "ap-sec ap-memory", id: "ap-noanswer" },
      el("b", {}, kind.limit ? "No answer: usage limit reached" : "No answer"),
      el("span", {}, kind.limit
        ? `${engineLabel} refused this question because its usage limit was reached, so there is no answer, search or citation to show. It is left out of a campaign's numbers.`
        : `${engineLabel} sent no answer text for this question, so there is nothing to show. Ask it again, or use "Retry missing" in a campaign.`)));
  }
  if (kind.id === "memory") {
    wrap.append(el("section", { className: "ap-sec ap-memory", id: "ap-memory" },
      el("b", {}, "Answered from memory"),
      el("span", {}, `${engineLabel} didn't search the web, so there are no pages or citations. The brands below come from what the model already knows.`)));
  }

  /* --- 3. your brand --- */
  if (you) {
    const extra = you.since ? el("span", { className: "ap-muted" }, `vs ${apDate(you.previousAt)}: ${you.since}`) : null;
    const sec = apSection("ap-you", "Your brand", "", extra);
    sec.classList.add("ap-you");
    sec.querySelector(".ap-h").append(el("span", { className: "ap-you-name" }, ` · ${you.name}`));
    const tiles = el("div", { className: "ap-tiles" });
    you.tiles.forEach((t) => tiles.append(el("div", { className: "ap-tile", title: t.label },
      el("span", { className: "ap-tile-label" }, t.label),
      el("span", { className: `ap-tile-value tone-${t.tone}` }, t.value),
      el("span", { className: "ap-tile-sub" }, t.sub))));
    sec.append(tiles);
    wrap.append(sec);
  } else if (mentions.length) {
    wrap.append(el("p", { className: "ap-note ap-you-hint", id: "ap-you" },
      "Set up a campaign with your brand and this answer will show how your brand did in it."));
  }

  /* --- 4. every brand, and what backs it --- */
  if (brands.rows.length) {
    const title = kind.id === "local" ? "Places named" : "Brands named";
    const extra = brands.hasPrevious ? null : el("span", { className: "ap-muted" }, previous ? "" : "no earlier answer to compare");
    const sec = apSection("ap-brands", title, brands.rows.filter((r) => !r.shownOnly).length, extra);
    const table = el("div", { className: `ap-table ap-brand-table${brands.hasPrevious ? " has-change" : ""}`, role: "table", "aria-labelledby": "ap-brands-h" });
    table.append(el("div", { className: "ap-tr ap-th", role: "row" },
      el("span", { role: "columnheader", className: "ap-sr" }, "Position"),
      el("span", { role: "columnheader" }, kind.id === "local" ? "Place" : "Brand"),
      el("span", { role: "columnheader", className: "num" }, "Mentions"),
      brands.hasPrevious ? el("span", { role: "columnheader" }, `vs ${apDate(previous.capturedAt).replace(/^\w+,?\s*/, "")}`) : null));
    brands.rows.forEach((r) => {
      const m = mentions.find((x) => x.brand === r.name);
      const models = [...new Set([...(m && m.skus) || [], ...extractBrandModels(r.name, rec.products, rec.answerText || "")])].slice(0, 2);
      const aspects = r.count > 0 && m ? extractBrandAspects(m.passages || []).slice(0, 2) : [];
      const sub = [...models, ...aspects].join(" · ");
      const ch = r.change;
      const chText = !ch ? "—" : ch.kind === "added" ? "New" : ch.kind === "same" ? "= Same" : ch.kind === "up" ? `↑ from ${apOrd(ch.from)}` : `↓ from ${apOrd(ch.from)}`;
      const rowEl = el("div", { className: `ap-tr${r.isYou ? " mine" : ""}${r.shownOnly ? " shown-only" : ""}`, role: "row", title: `${r.backing.label}${r.backing.readOnly ? ` · also in ${r.backing.readOnly} page(s) read but not cited` : ""}` },
        el("span", { role: "cell", className: `ap-rank${r.position === 1 ? " first" : ""}` }, r.position ? String(r.position) : "–"),
        el("span", { role: "cell", className: "ap-brand-cell" },
          el("span", { className: "ap-brand-name" }, r.name + (r.isYou ? " · you" : "")),
          sub ? el("span", { className: "ap-brand-sub" }, sub) : null),
        el("span", { role: "cell", className: "num" }, r.shownOnly ? "card only" : `×${r.count}`),
        brands.hasPrevious ? el("span", { role: "cell", className: `ap-change ch-${ch ? ch.kind : "none"}` }, chText) : null);
      table.append(rowEl);
    });
    brands.dropped.forEach((d) => {
      table.append(el("div", { className: "ap-tr dropped", role: "row", title: "Named last time, missing from this answer" },
        el("span", { role: "cell", className: "ap-rank" }, "–"),
        el("span", { role: "cell", className: "ap-brand-cell" },
          el("span", { className: "ap-brand-name" }, d.name),
          el("span", { className: "ap-brand-sub" }, `was ${apOrd(d.was)} last time`)),
        el("span", { role: "cell", className: "num" }, "×0"),
        el("span", { role: "cell", className: "ap-change ch-dropped" }, "Dropped")));
    });
    sec.append(table);
    wrap.append(sec);
  }

  /* --- 5. every site it used (0.58.0) --- */
  // Was "Pages cited": cited domains as a list, and every site read but not
  // cited squeezed onto one line. Reported: the cited domains and URLs had
  // all but disappeared. Now every site, cited first, each opening to every
  // page the engine read there.
  const sites = domainsView(rec, { own, knownBrands });
  if (sites.rows.length) {
    const sec = apSection("ap-sites", "Sites it used", sites.rows.length,
      el("span", { className: "ap-muted" }, `${sites.citedSites} cited · ${sites.readOnlySites} read only`));
    if (cited) {
      const bar = el("div", { className: "ap-kindbar", role: "img", "aria-label": `${tr("Cited pages by kind")}: ` + pages.kinds.map((k) => `${k.n} ${tr(k.label).toLowerCase()}`).join(", ") });
      pages.kinds.forEach((k) => bar.append(el("span", { title: `${k.label} · ${k.n}`, style: `flex:${k.n} 1 0; background:var(${AP_KIND_VAR[k.label]})` })));
      const legend = el("div", { className: "ap-legend" });
      pages.kinds.forEach((k) => legend.append(el("span", {}, el("i", { style: `background:var(${AP_KIND_VAR[k.label]})` }), `${tr(k.label)} · ${k.n}`)));
      sec.append(bar, legend);
    }
    sec.append(sitesListEl(sites));
    if (own && pages.silent.length) sec.append(el("p", { className: "ap-foot accent" }, `Cited without naming ${own.name}: ${pages.silent.join(", ")}`));
    wrap.append(sec);
  }

  /* --- 6. since last time --- */
  if (changes) {
    const sec = apSection("ap-changes", `Since ${apDate(changes.at)}`, "", el("span", { className: "ap-muted" }, "same prompt, same engine"));
    const SIGN = { added: "+", dropped: "−", up: "↑", down: "↓", same: "=", site: "↻" };
    const ul = el("ul", { className: "ap-changes" });
    changes.items.forEach((x) => ul.append(el("li", {}, el("span", { className: `ap-sign s-${x.kind}`, "aria-hidden": "true" }, SIGN[x.kind] || "•"), x.text)));
    sec.append(ul);
    wrap.append(sec);
  }

  /* --- 7. what backs each brand, at the bottom (0.58.0) --- */
  // Requested: this reads which brands appear in the cited pages' titles and
  // search snippets, so it's an inference, and it sat in the brands table as a
  // "Backed by: Nothing" column. It is the last section now.
  if (rec.searched && kind.id !== "memory" && brands.rows.some((r) => r.position > 0)) {
    const sec = apSection("ap-backing", kind.id === "local" ? "What backs each place" : "What backs each brand", "",
      el("span", { className: "ap-muted" }, "the cited pages that mention it"));
    brands.rows.filter((r) => r.position > 0).sort((x, y) => x.position - y.position).forEach((r) => {
      sec.append(el("div", { className: `ap-backing-row${r.isYou ? " mine" : ""}` },
        el("span", { className: `ap-rank${r.position === 1 ? " first" : ""}` }, String(r.position)),
        el("span", { className: "ap-brand-name" }, r.name + (r.isYou ? " · you" : "")),
        apPill(r.backing.label, r.backing.tone),
        el("span", { className: "ap-muted ap-backing-pages" }, r.backing.backers.map((x) => x.domain + (x.own ? " (own site)" : "")).join(", ") || "no cited page mentions it")));
    });
    wrap.append(sec);
  }

  /* --- 8. facts, and the way into the details --- */
  const ps = rec.platformSpecific || {};
  const wordsN = ps.wordCount || (rec.answerText ? rec.answerText.trim().split(/\s+/).length : 0);
  const vg = rec.sources.length && rec.answerText ? computeVerbatimGrounding(rec.answerText, rec.sources) : null;
  const facts = el("div", { className: "ap-facts" });
  const fact = (k, v) => facts.append(el("span", {}, el("span", { className: "ap-muted" }, k + " "), el("b", {}, v)));
  if (wordsN) fact("Answer", `${wordsN} words`);
  if (vg && vg.totalClaims) fact("Quoted word for word", `${vg.groundedClaims} of ${vg.totalClaims} claims`);
  fact("Model", rec.model || "not reported");
  fact("Captured", `${apDate(rec.capturedAt)}, ${apTime(rec.capturedAt)}`);
  wrap.append(facts);

  const tabs = apSheetTabs(rec);
  const links = el("div", { className: "ap-links" });
  tabs.filter((t) => t.id !== "searches").forEach((t) => {
    const b = el("button", { className: "ap-btn", type: "button" }, t.label);
    b.onclick = () => { apSheet = t.id; renderAnalyze(); };
    links.append(b);
  });
  const key = normPrompt(rec.userPrompt);
  // Counted over RECORDS because that is what the Compare page lists (campaign
  // captures stay out of it unless "include campaign captures" is on).
  const others = key && RECORDS.some((r) => r.captureId === rec.captureId) ? RECORDS.filter((r) => normPrompt(r.userPrompt) === key).length : 0;
  if (others > 1) {
    const b = el("button", { className: "ap-btn", type: "button", "data-open": "compare", title: "Every captured answer to this prompt, run by run and engine by engine" }, `All ${others} answers to this prompt`);
    b.onclick = () => openCompareFor(rec);
    links.append(b);
  }
  const full = el("button", { className: "ap-link ap-full", type: "button", title: "Open this answer in a full browser tab" }, "Full analysis ↗");
  full.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL(`ui/panel.html?mode=tab&capture=${encodeURIComponent(rec.captureId)}`) });
  links.append(full);
  wrap.append(links);

  if (apSheet && tabs.some((t) => t.id === apSheet)) renderApSheet(rec, wrap, tabs, { own, brands, pages, searches, knownBrands });
}

/* The popup's tabs other than Overview (0.60.0, the canvas's popup boards):
 * one focused view each, by the kind of answer. Overview keeps the sections
 * the popup has always had. */
function apRenderTab(wrap, rec, { kind, own, knownBrands, brands, pages, cv, answers, mentions, engineLabel }) {
  const body = el("section", { className: "ap-sec ap-tabview", id: `ap-view-${apTab}`, role: "tabpanel", "aria-labelledby": `ap-tab-${apTab}` });
  wrap.append(body);
  const note = (t) => body.append(el("p", { className: "ap-muted ap-tabnote" }, t));
  const positions = resultPositions(rec);
  if (apTab === "products") {
    const pv = productsView(rec, { own, knownBrands });
    note("In the order shown · price and rating from the card");
    pv.rows.forEach((r) => body.append(el("div", { className: `ap-pc${r.isYou ? " mine" : ""}` },
      el("span", { className: "ap-pc-img" }, withImage(el("span", { className: "ap-card-thumb" }, glyphEl("cart", 20)), r.image, r.name), el("span", { className: "ap-card-n" }, String(r.n))),
      el("span", { className: "ap-pc-body" },
        el("span", { className: "ap-pc-top" }, el("b", {}, r.name || "—"), el("span", { className: "ap-pc-price" }, r.price || "")),
        el("span", { className: "ap-muted" }, [r.rating != null ? `★ ${r.rating}` : "", r.reviews ? atCompact(r.reviews) : "", r.isYou ? "your brand" : r.brand].filter(Boolean).join(" · ")),
        el("span", { className: "ap-chips" }, ...r.stores.map((st, j) => el("span", { className: `at-store-chip${st.own ? " own" : ""}` }, el("b", {}, String(j + 1)), ` ${st.name}`)),
          el("span", { className: "ap-muted" }, "cited by"), ...(r.pages.length ? r.pages.map((d) => el("span", { className: "at-page-chip" }, atShortDomain(d))) : [el("span", { className: "at-page-chip none" }, "none")]))))));
  } else if (apTab === "stores") {
    const pv = productsView(rec, { own, knownBrands });
    note(`Where the cards send buyers · ${plural(pv.rows.length, "card")}, ${plural(pv.storeLinks, "store link")}`);
    const bar = el("div", { className: "at-store-bar" });
    pv.firstStores.forEach((x) => bar.append(el("span", { className: x.own ? "own" : "", style: `flex:${x.n} 1 0; --h:${atHue(x.name)}`, title: `${x.name} · first on ${x.n}` })));
    body.append(bar);
    const by = new Map();
    pv.rows.forEach((r) => r.stores.forEach((st, j) => { const x = by.get(st.name) || { name: st.name, own: false, cards: [], places: [] }; x.own = x.own || st.own; x.cards.push(r.n); x.places.push(j + 1); by.set(st.name, x); }));
    [...by.values()].sort((a, b) => b.cards.length - a.cards.length).forEach((x) => body.append(el("div", { className: "ap-li" },
      atFav(x.name), el("span", {}, el("b", {}, x.name), el("span", { className: "ap-muted" }, x.own ? " · the brand’s own store" : "")),
      el("span", { className: "ap-muted" }, `${plural(x.cards.length, "card")} · first on ${x.places.filter((p) => p === 1).length}`))));
    note("Price at each store: not captured — the card shows one price.");
  } else if (apTab === "sources") {
    note(`Pages ${rec.platform === "chatgpt" || rec.platform === "perplexity" ? "· position in its results " : ""}· date · the brands they name`);
    const present = new Map((computeBrandMatrix(rec).sources || []).map((x) => [x.sourceIdx, x.presentBrands]));
    const names = mentions.map((b) => b.brand);
    const rows = rec.sources.map((x, i) => ({ x, i })).sort((a, b) => (b.x.outcome === "cited") - (a.x.outcome === "cited"));
    rows.forEach(({ x, i }) => {
      const d = normDomainLabel(x.domain || x.url);
      const xp = x.platformSpecific || {};
      const named = (present.get(i) || []).filter((n) => names.some((b) => b.toLowerCase() === String(n).toLowerCase()));
      const meta = [atKindOne(siteKindOf(d, { ownBrand: own ? own.name : "", brands: names })), positions.get(x.url) ? `#${positions.get(x.url)}` : "", xp.pubDate ? atShortDay(xp.pubDate < 1e12 ? xp.pubDate * 1000 : xp.pubDate) : "", named.length ? `names ${named.join(", ")}` : ""].filter(Boolean).join(" · ");
      body.append(el("div", { className: "ap-li ap-page-row" }, atFav(d),
        el("span", { className: "ap-li-main" }, el("a", { href: x.url || "#", target: "_blank", rel: "noreferrer", title: x.url }, d), el("span", { className: "ap-muted" }, meta)),
        apPill(x.outcome === "cited" ? "cited" : "read only", x.outcome === "cited" ? "good" : "warn")));
    });
    const m = sourceBrandMatrix(rec, { own, knownBrands, maxBrands: 5, maxSites: 8 });
    if (m && m.rows.length) {
      body.append(el("h3", { className: "ap-h3" }, "Sources × brands"));
      const grid = el("div", { className: "at-matrix", style: `grid-template-columns: minmax(96px, 1.3fr) repeat(${m.brands.length}, minmax(0, 1fr)); min-width: 0` });
      grid.append(el("span", {}), ...m.brands.map((b) => el("span", { role: "columnheader", className: b.isYou ? "you" : "" }, b.name)));
      m.rows.forEach((r) => grid.append(el("span", { className: "at-matrix-site" }, r.domain), ...r.cells.map((c) => el("span", { className: `at-mx ${c || "none"}` }, c))));
      body.append(grid);
    }
  } else if (apTab === "ads") {
    adsView(rec, { knownBrands }).forEach((a) => body.append(adCardEl(a, { products: (rec.products || []).length })));
    note("Not captured: clicks, impressions and what the ad cost.");
  } else if (apTab === "places") {
    rec.places.forEach((p, i) => {
      const links = el("div", { className: "ap-chips" });
      placeLinkChips(p, links);
      const sup = supplierOf(p.supplier);
      body.append(el("div", { className: "ap-sheet-row" },
        el("div", { className: "ap-sheet-row-head" }, el("span", { className: "ap-pin" }, String(i + 1)), el("b", {}, p.name || "—")),
        el("span", { className: "ap-muted" }, [p.rating != null ? `★ ${p.rating}${p.reviews ? ` (${Number(p.reviews).toLocaleString()})` : ""}` : "", p.category, p.priceRange].filter(Boolean).join(" · ")),
        p.address ? el("span", { className: "ap-muted" }, p.address) : null, links,
        el("span", { className: "ap-muted" }, `Listing from: ${sup ? sup.code : "not captured"}`)));
    });
  } else if (apTab === "facts") {
    note("What each place's card carries. Which source supplied each field is not captured.");
    const t = el("div", { className: "ap-facts-grid" });
    t.append(...["Place", "Rating", "Hours", "Website", "Phone", "Listing"].map((h) => el("span", { className: "ap-muted" }, h)));
    rec.places.forEach((p) => {
      const sup = supplierOf(p.supplier);
      const cell = (v) => el("span", { className: `ap-fact-cell${v ? " on" : ""}` }, v ? "on card" : "—");
      t.append(el("b", {}, p.name || "—"), el("span", { className: `ap-fact-cell${p.rating != null ? " on" : ""}` }, p.rating != null ? `★ ${p.rating}` : "—"), cell(p.hours), cell(p.website), cell(p.phone), el("span", { className: "ap-fact-cell" }, sup ? sup.code : "not captured"));
    });
    body.append(t);
  } else if (apTab === "pictures") {
    const grid = el("div", { className: "ap-imgs" });
    rec.images.forEach((im) => {
      const host = atHost(im.sourceUrl || im.link || "") || atHost(im.url);
      grid.append(el("a", { className: "ap-img", href: im.url, target: "_blank", rel: "noreferrer", title: im.title || host },
        withImage(el("span", { className: "ap-img-frame" }, el("span", { className: "ap-img-ph" }, im.title || host || "image")), im.url, im.title),
        el("span", { className: "ap-img-from" }, atProxied(im.url) && !im.sourceUrl ? "the engine’s copy" : host)));
    });
    body.append(grid);
    note("Where a click on a picture takes the reader: not captured unless the engine sent the source page.");
  } else if (apTab === "parts" || apTab === "answer") {
    const panel = atRenderAnswer(rec, { brandNames: mentions.map((b) => b.brand), own });
    if (apTab === "answer") {
      const t = panel.el.querySelector(".at-answer-body");
      if (t) { t.classList.add("ap-answer-body", "hl-brands", "hl-cites"); body.append(t); }
    } else if (panel.blocks.length) {
      note("The pages each paragraph cites");
      atPartsRows(panel.blocks.slice(0, 12)).forEach((r) => body.append(r));
    } else {
      note("The answer text wasn't captured, so its parts can't be shown.");
    }
  } else if (apTab === "engines") {
    body.append(el("h2", { className: "ap-h" }, `How the ${answers.length} answers differ`));
    cv.diffs.forEach((d) => body.append(el("div", { className: "ap-li" }, el("span", { className: "at-diff-k" }, d.k), el("span", {}, d.v))));
    cv.engines.forEach((e) => body.append(el("div", { className: "ap-li" }, el("i", { className: `at-eng-dot e-${e.id}` }),
      el("span", { className: "ap-li-main" }, el("b", {}, e.label), el("span", { className: "ap-muted" }, `${e.first} first · ${e.brands} brands · ${e.searches} searches · ${e.read} read · ${e.cited} cited`)),
      el("span", { className: "ap-muted" }, e.ads.length ? `Ad: ${e.ads.join(", ")}` : e.adFormat ? "no ad" : "no ad format"))));
  }
  const links = el("div", { className: "ap-links" });
  const full = el("button", { className: "ap-link ap-full", type: "button", title: "Open this answer in a full browser tab" }, "Full analysis ↗");
  full.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL(`ui/panel.html?mode=tab&capture=${encodeURIComponent(rec.captureId)}`) });
  links.append(full);
  wrap.append(links);
}

function apSheetTabs(rec) {
  const t = [];
  if (rec.searched) t.push({ id: "backing", label: "What backs each brand" });
  if ((rec.products || []).length) t.push({ id: "buy", label: "Where to buy" });
  if ((rec.places || []).length) t.push({ id: "places", label: "All places" });
  if ((rec.images || []).length) t.push({ id: "images", label: "All images" });
  if ((rec.sources || []).length) t.push({ id: "pages", label: "Every page it opened" });
  if (((rec.fanout?.search?.length || 0) + (rec.fanout?.shopping?.length || 0) + (rec.fanout?.image?.length || 0)) > 0) t.push({ id: "searches", label: "Search details" });
  t.push({ id: "tech", label: "Technical" });
  return t;
}

function renderApSheet(rec, wrap, tabs, ctx) {
  const close = () => { apSheet = null; renderAnalyze(); };
  const scrim = el("div", { className: "ap-scrim", "aria-hidden": "true" });
  scrim.onclick = close;
  const sheet = el("section", { className: "ap-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Details" });
  const top = el("div", { className: "ap-sheet-top" });
  const tl = el("div", { className: "ap-sheet-tabs", role: "tablist" });
  tabs.forEach((t) => {
    const b = el("button", { className: `ap-sheet-tab${t.id === apSheet ? " on" : ""}`, type: "button", role: "tab", "aria-selected": t.id === apSheet ? "true" : "false" }, t.label);
    b.onclick = () => { apSheet = t.id; renderAnalyze(); };
    tl.append(b);
  });
  const x = el("button", { className: "ap-icon-btn ap-sheet-close", type: "button", "aria-label": "Close details", title: "Close" }, "×");
  x.onclick = close;
  top.append(tl, x);
  const body = el("div", { className: "ap-sheet-body" });
  const col = el("div", { className: "ap-sheet-col" });
  body.append(col);
  sheet.append(top, body);

  if (apSheet === "backing") {
    col.append(el("p", { className: "ap-note" }, "Each brand and the cited pages that name it, in the page’s title or snippet."));
    ctx.brands.rows.forEach((r) => {
      const chips = el("div", { className: "ap-chips" });
      r.backing.backers.forEach((b) => chips.append(el("span", { className: `ap-bchip${b.own ? " own" : ""}` }, `${b.domain} · ${b.own ? "own site" : "independent"}`)));
      if (!r.backing.backers.length) chips.append(el("span", { className: "ap-muted" }, r.backing.verdict === "read" ? "only in pages it read without citing" : r.backing.verdict === "unchecked" ? "not in the titles and snippets the engine sent" : r.backing.verdict === "nocited" ? "the answer cited no page" : "no cited page names it"));
      col.append(el("div", { className: "ap-sheet-row" },
        el("div", { className: "ap-sheet-row-head" }, el("b", {}, `${r.position || "–"}. ${r.name}`), apPill(r.backing.label, r.backing.tone)),
        chips,
        r.backing.readOnly ? el("span", { className: "ap-foot warn" }, `also in ${r.backing.readOnly} page${r.backing.readOnly === 1 ? "" : "s"} read but not cited`) : null));
    });
  } else if (apSheet === "buy") {
    const ps = rec.products;
    const pick = el("div", { className: "ap-chips" });
    ps.forEach((p, i) => {
      const b = el("button", { className: `ap-pick${i === apSheetProduct ? " on" : ""}`, type: "button" }, (p.name || "—").split(/\s+/).slice(0, 3).join(" "));
      b.onclick = () => { apSheetProduct = i; renderAnalyze(); };
      pick.append(b);
    });
    const p = ps[Math.min(apSheetProduct, ps.length - 1)];
    const kv = el("dl", { className: "ap-kv" });
    const add = (k, v) => { if (v) kv.append(el("div", {}, el("dt", {}, k), el("dd", {}, v))); };
    add("Price on the card", p.price || "not shown");
    add("Stores the card names", p.merchant || "none named");
    add("Rating", p.rating != null ? `★ ${p.rating}${p.reviews ? ` (${Number(p.reviews).toLocaleString()} reviews)` : ""}` : "");
    const sup = supplierOf(p.supplier);
    add("Listing feed", sup ? sup.code : "");
    const word = String(p.name || "").split(/\s+/).slice(0, 2).join(" ").toLowerCase();
    const about = word ? rec.sources.filter((s) => `${s.title || ""} ${s.snippet || ""}`.toLowerCase().includes(word)) : [];
    col.append(pick, el("h3", { className: "ap-h3" }, p.name || "—"), kv,
      el("p", { className: "ap-note" }, "The card names its stores but the capture doesn't carry each store's price, so only the card's own price is shown."));
    if (about.length) {
      col.append(el("h3", { className: "ap-h3" }, `Pages that mention it · ${about.length}`));
      about.slice(0, 8).forEach((s) => col.append(el("a", { className: "ap-sheet-link", href: s.url, target: "_blank", rel: "noreferrer" }, `${s.domain || ""} — ${s.title || s.url}`)));
    }
  } else if (apSheet === "places") {
    rec.places.forEach((p, i) => {
      const links = el("div", { className: "ap-chips" });
      placeLinkChips(p, links);
      col.append(el("div", { className: "ap-sheet-row" },
        el("div", { className: "ap-sheet-row-head" }, el("span", { className: "ap-pin" }, String(i + 1)), el("b", {}, p.name || "—")),
        el("span", { className: "ap-muted" }, [p.rating != null ? `★ ${p.rating}${p.reviews ? ` (${Number(p.reviews).toLocaleString()})` : ""}` : "", p.category, p.priceRange, p.hours].filter(Boolean).join(" · ")),
        p.address ? el("span", { className: "ap-muted" }, p.address) : null,
        links));
    });
  } else if (apSheet === "images") {
    rec.images.forEach((im) => {
      let host = "";
      try { host = new URL(im.url).hostname.replace(/^www\./, ""); } catch (_) {}
      const img = el("img", { src: im.url, alt: im.title || "", loading: "lazy" });
      img.onerror = () => img.replaceWith(el("span", { className: "ap-img-ph" }, ""));
      col.append(el("a", { className: "ap-sheet-img", href: im.url, target: "_blank", rel: "noreferrer" },
        img,
        el("span", {}, el("b", {}, im.title || "Untitled image"), el("span", { className: "ap-muted" }, [im.attribution || host, im.price].filter(Boolean).join(" · ")))));
    });
  } else if (apSheet === "pages") {
    // Every page, cited first, with its full address: reported "i am not
    // able to see all the cited, fetched domain and there urls".
    const rows = [...rec.sources].sort((a, b) => (b.outcome === "cited") - (a.outcome === "cited"));
    col.append(el("p", { className: "ap-note" }, `${plural(rows.length, "page")} opened · ${rows.filter((s) => s.outcome === "cited").length} cited. Read only = opened while searching, not linked in the answer.`));
    rows.forEach((s) => col.append(sourceRowEl(s, { pill: (t, tone) => apPill(t, tone), cls: "ap-sheet-row ap-page-row" })));
  } else if (apSheet === "searches") {
    const all = [].concat(rec.fanout.search || [], rec.fanout.shopping || [], rec.fanout.image || []);
    const fa = analyzeFanout(all, rec.sources || []);
    const kv = el("dl", { className: "ap-kv" });
    const add = (k, v) => kv.append(el("div", {}, el("dt", {}, k), el("dd", {}, v)));
    add("Searches", `${fa.count} · ${fa.benchmark.label}`);
    add("Average length", `${fa.avgWords} words (longest ${fa.maxWords})`);
    add("With a year or 'latest'", String(fa.temporalCount));
    add("Scoped to a site (site:)", fa.scopedDomains.length ? fa.scopedDomains.map((d) => `${d.domain}${d.cited ? " ✓ cited" : " — not cited"}`).join(", ") : "none");
    if (fa.excludedDomains.length) add("Excluded (-site:)", fa.excludedDomains.map((d) => d.domain).join(", "));
    add("What the searches were after", fa.intents.length ? fa.intents.map((i) => `${i.key} ${i.count}`).join(", ") : "—");
    col.append(kv);
  } else if (apSheet === "tech") {
    const ps = rec.platformSpecific || {};
    const kv = el("dl", { className: "ap-kv two" });
    const add = (k, v) => { if (v) kv.append(el("div", {}, el("dt", {}, k), el("dd", { title: String(v) }, String(v)))); };
    add("Captured", new Date(rec.capturedAt).toLocaleString(dateLocale()));
    add("Engine", ENGINES.find((e) => e.id === rec.platform)?.label || rec.platform);
    add("Model", rec.model || "not reported");
    add("Engine's own label", rec.turnUseCase || "");
    add("Searched the web", rec.searched ? "Yes" : "No");
    add("Kind of answer", answerKind(rec).label);
    add("Pages read · cited", `${rec.sources.length} · ${ctx.pages.rows.length}`);
    add("Products · places · images", `${(rec.products || []).length} · ${(rec.places || []).length} · ${(rec.images || []).length}`);
    add("Plan type", ps.planType || "");
    add("Time to first token", ps.ttfvtMs ? `${(ps.ttfvtMs / 1000).toFixed(2)}s` : "");
    add("Reference types", Object.entries(rec.referenceTypes || {}).map(([k, v]) => `${k} (${v})`).join(", "));
    add("Read from", rec._extraction?.usedFallback ? "Page fallback (stream unreadable)" : "The engine's own response");
    add("Conversation", rec.conversationId || "");
    add("Capture id", rec.captureId);
    col.append(kv);
    const raw = el("button", { className: "ap-btn", type: "button" }, "Download raw payload");
    raw.onclick = () => downloadRaw(rec.captureId, "analyze");
    col.append(raw);
  }
  wrap.append(scrim, sheet);
}

// Compare left the top menu in 0.47.0 — comparing answers to one prompt now
// starts from the answer itself. Same page as before, opened on this prompt.
function openCompareFor(rec) {
  cmpProjectFilter = "";
  cmpModelFilter = "";
  ["#cmpProject", "#cmpModel"].forEach((id) => { const n = $(id); if (n) n.value = ""; });
  cmpSearch = "";
  const si = $("#cmpSearch");
  if (si) si.value = "";
  refreshComparePickers();
  const sel = $("#cmpPrompt");
  const key = normPrompt(rec.userPrompt);
  if (sel && [...sel.options].some((o) => o.value === key)) sel.value = key;
  showTab("compare");
  renderCompare();
}

/* ---------- Analyze, full tab (0.48.0) ----------
 * Release 2 of the canvas redesign. The owner's brief for the full tab: the
 * old page "has lot of white spaces", and the answer itself, as the engine
 * showed it, belongs on the far right with the analysis down the left. So: a
 * prompt header,
 * then two columns — the analysis (searches first, as in the popup; your
 * brand; what led the answer; every brand and what backs it; every cited
 * page; what changed; kinds of sites; details) and, pinned on the right, the
 * answer as the engine showed it, with brands and citations highlighted.
 * Clicking a brand or a page on the left lights it up in the answer.
 *
 * When the same prompt has answers from more than one engine, tabs switch
 * between them and "Compare engines" lays them side by side
 * (src/lib/compareView.js) — the comparison that used to need the Compare tab.
 *
 * The detailed cards the page always had (every page read with its index and
 * kind chips, search details, the brand/page matrix, claim grounding,
 * technical) are kept, built by renderAnalyzeLegacy() and shown in Details.
 */
let atFocusBrand = null;   // brand lit up in the answer
let atFocusCite = null;    // citation number lit up in the answer
let atHlBrands = true;
let atHlCites = true;
let atCompare = false;     // the "Compare engines" view
// Side by side's open tab, its pagers and the brand measure (0.68.0).
let atCmpPane = "sum";
const atCmpPg = {};
let atCmpMeasure = "place";
let atCompareRead = null;  // whose answer the compare view shows on the right
let atDetails = "tech";    // which Details tab
let atProduct = 0;         // product row selected for "Where to buy"
let atPromptOpen = false;
let atMenuOpen = false;
let atHeroObs = null;      // keeps --at-hero-h in step with the pinned header
let atSiteFilter = "all";  // "Every site it read": all | cited | read | silent
let atScrollFocus = false; // after re-rendering to show the answer, scroll to what was picked
// "Read the answer beside" (0.60.0, the canvas's rail toggle): the answer as
// the engine showed it, pinned beside the analysis, or hidden so the analysis
// gets the whole width. A per-viewer convenience, so browser storage.
let atSplit = (() => { try { return localStorage.getItem("cito-at-split") !== "0"; } catch (_) { return true; } })();
// The rail of sections is a slim strip of icons that opens over the page on
// hover (0.62.1, asked: it took width from the answer and At a glance); the
// pin keeps it open beside the page, and is remembered per viewer.
let atRailPinned = (() => { try { return localStorage.getItem("cito-rail-pinned") === "1"; } catch (_) { return false; } })();

function atResetState() {
  atFocusBrand = null; atFocusCite = null; atCompare = false; atCompareRead = null;
  atProduct = 0; atPromptOpen = false; atMenuOpen = false; atSiteFilter = "all";
  atCmpPane = "sum"; atCmpMeasure = "place"; Object.keys(atCmpPg).forEach((k) => delete atCmpPg[k]);
}

function atSetSplit(on) {
  atSplit = on;
  try { localStorage.setItem("cito-at-split", on ? "1" : "0"); } catch (_) { /* storage off: this view only */ }
}

// Each section's icon tile, from the canvas: a glyph on a soft tint.
const AT_SEC_ICON = {
  "at-glance": ["bars", "teal"], "at-you": ["tag", "ind"], "at-products": ["cart", "coral"], "at-places": ["pin", "coral"],
  "at-images": ["image", "pink"], "at-parts": ["pages", "amber"], "at-memory": ["noglobe", "amber"], "at-ads": ["ad", "amber"],
  "at-backing": ["link", "amber"], "at-sites": ["globe", "sky"], "at-built": ["search", "vio"], "at-changes": ["clock", "amber"],
  "at-details": ["chip", "slate"], "at-ai": ["spark", "vio"],
  "at-cmp-diffs": ["spark", "vio"], "at-cmp-table": ["bars", "teal"], "at-cmp-brands": ["tag", "ind"], "at-cmp-sites": ["globe", "sky"],
  "at-cmp-searches": ["search", "amber"], "at-cmp-ads": ["ad", "amber"],
};
function atIconTile(id, size = 15) {
  const [g, tone] = AT_SEC_ICON[id] || ["info", "slate"];
  return el("span", { className: `at-ico i-${tone}`, "aria-hidden": "true" }, glyphEl(g, size));
}

function atSection(id, title, count, extra) {
  const head = el("div", { className: "at-sec-head" });
  const h = el("h2", { className: "at-h", id: `${id}-h` }, title);
  if (count != null && count !== "") h.append(el("span", { className: "ap-h-count" }, ` · ${count}`));
  head.append(atIconTile(id), h);
  if (extra) head.append(extra);
  return el("section", { className: "at-sec", id, "aria-labelledby": `${id}-h` }, head);
}

function atEngineLabel(id) { return ENGINES.find((e) => e.id === id)?.label || id || "Unknown engine"; }

function renderAnalyzeTab(rec, root) {
  if (rec && !abIsDemo(rec)) gsMark("analyzed"); // Get started (1.0.0)
  const knownBrands = knownVendors(rec);
  const own = ownBrandFor(rec, GEO_PROFILES);
  const previous = findPrevious(rec, ALL_RECORDS);
  const kind = answerKind(rec);
  const engineLabel = atEngineLabel(rec.platform);
  const mentions = normalizeMentions(rec.brandMentions || [], knownBrands);
  const searches = searchesView(rec, mentions.map((b) => b.brand));
  const brands = brandsView(rec, { own, knownBrands, previous });
  const pages = pagesView(rec, { own, knownBrands });
  const you = yourBrandView(rec, own, { knownBrands, previous, max: 6 });
  const changes = changesView(rec, previous, { knownBrands });
  const answers = answersToPrompt(rec, ALL_RECORDS);
  if (answers.length < 2) atCompare = false;
  const cv = compareView(answers, { own });

  // The cards renderAnalyzeLegacy() builds, taken by id for Details.
  const legacy = el("div");
  try { renderAnalyzeLegacy(rec, legacy); } catch (err) { console.error("legacy Analyze cards failed:", err); }
  const legacyCard = (id) => legacy.querySelector(`#${id}`);

  /* --- the prompt header: sticky, so which answer this is never scrolls away --- */
  // Tinted by the kind of answer, as on the canvas (0.60.0): shopping green,
  // local coral, pictures pink, informational blue, from memory amber.
  const hero = el("div", { className: `analyze-context-bar at-hero kind-${kind.id}${(rec.ads || []).length ? " has-ad" : ""}` });
  const row = el("div", { className: "at-hero-row" });
  const backTo = returnTab || "dashboard";
  const backBtn = el("button", { className: "analyze-context-back", type: "button", title: `Back to ${TAB_LABELS[backTo] || backTo}` },
    el("span", { "aria-hidden": "true" }, "←"), el("span", { className: "analyze-context-back-label" }, TAB_LABELS[backTo] || backTo));
  backBtn.onclick = () => {
    if (history.state && history.state.cito === "analyze") { history.back(); return; } // popstate goes back
    returnTab = null; showTab(backTo);
  };
  const eng = engineIconEl(rec.platform);
  eng.classList.add("ap-engine-icon");
  // Which campaign this answer came from, or that it was asked by hand, and
  // whose brand the page measures.
  const profile = rec.geo && rec.geo.profileId ? GEO_PROFILES.find((p) => p.id === rec.geo.profileId) : null;
  row.append(backBtn, el("span", { className: `ap-kind kind-${kind.id}` }, kind.label),
    rec.geo ? el("span", { className: "at-chip at-chip-campaign", title: "Captured by a campaign run" }, `Campaign · ${profile ? profile.name : "removed campaign"}`)
      : el("span", { className: "at-chip", title: "Asked by hand, not by a campaign" }, "Ad-hoc"),
    own ? el("span", { className: "at-chip", title: own.source === "settings" ? "Your brand, from Settings" : `The brand of the campaign ${own.campaign || ""}`.trim() }, `Tracking ${own.name}`) : "", // "" not null: the DOM's own append() writes null out as text
    sessionChip(rec),
    eng,
    el("span", { className: "at-asked" }, `Asked ${engineLabel}`),
    el("span", { className: "ap-when", title: new Date(rec.capturedAt).toLocaleString(dateLocale()) }, `· ${rec.model ? `${rec.model} · ` : ""}${apDate(rec.capturedAt)}, ${apTime(rec.capturedAt)}`));
  const promptText = rec.userPrompt || "(no prompt text)";
  const words = promptText.trim().split(/\s+/).length;
  const isLong = words > 40 || promptText.length > 260;
  if (isLong) row.append(el("span", { className: "ap-tag" }, `${words}-word prompt`));
  row.append(el("span", { className: "ap-head-spacer" }));
  // Finding another capture and paging through them live in the app bar,
  // as on the canvas (atHeaderTools).
  atHeaderNodes = atHeaderTools(rec);
  setHeaderPage("analyze", ...atHeaderNodes);
  const pdf = el("button", { className: "at-btn", type: "button", title: "A two-page report on this answer, to print or save as PDF" }, "Save as PDF");
  pdf.onclick = () => openAnswerReport(rec);
  const raw = el("button", { className: "at-btn", type: "button", title: "The engine's response exactly as captured" }, "Raw data");
  raw.onclick = () => downloadRaw(rec.captureId, "analyze");
  const menuBtn = el("button", { className: "ap-icon-btn", type: "button", title: "More actions", "aria-label": "More actions", "aria-expanded": atMenuOpen ? "true" : "false" }, "⋯");
  menuBtn.onclick = () => { atMenuOpen = !atMenuOpen; renderAnalyze(); };
  const feedbackBtn = el("button", { className: "analyze-context-feedback", type: "button", title: "Report a problem with this capture", "aria-label": "Report a problem with this capture" }, "💬");
  feedbackBtn.onclick = () => openFeedbackModal(rec);
  row.append(pdf, raw, menuBtn, feedbackBtn);
  hero.append(row);
  if (atMenuOpen) {
    const menu = el("div", { className: "ap-menu at-menu", role: "menu" });
    const item = (label, fn, danger) => {
      const b = el("button", { className: `ap-menu-item${danger ? " danger" : ""}`, type: "button", role: "menuitem" }, label);
      b.onclick = async () => { atMenuOpen = false; await fn(); };
      menu.append(b);
    };
    item("Copy the prompt", async () => { try { await navigator.clipboard.writeText(rec.userPrompt || ""); showToast("Prompt copied"); } catch (_) { showToast("Couldn't copy — select the prompt text instead", "error"); } renderAnalyze(); });
    item("Save as HTML", () => { exportRecordsAsHtml([rec]); renderAnalyze(); });
    item("Report a wrong reading", () => { renderAnalyze(); openFeedbackModal(rec); });
    item("Remove from my history", async () => {
      if (!confirm("Remove this answer from your history? This can't be undone.")) { renderAnalyze(); return; }
      await send({ type: "delete-record", captureId: rec.captureId });
      FULL.delete(rec.captureId);
      viewingId = null;
      atResetState();
      showToast("Removed from your history");
      load();
    }, true);
    hero.append(menu);
  }
  const h1 = el("h1", { className: `at-prompt analyze-context-prompt${isLong && !atPromptOpen ? " clamped" : ""}`, title: promptText }, promptText);
  hero.append(h1);
  if (isLong) {
    const t = el("button", { className: "ap-link", type: "button", "aria-expanded": atPromptOpen ? "true" : "false" }, atPromptOpen ? "Show less" : "Show the whole prompt");
    t.onclick = () => { atPromptOpen = !atPromptOpen; renderAnalyze(); };
    hero.append(t);
  }
  const strip = el("div", { className: "ap-strip at-strip" });
  const chip = (text, on, title, cls) => strip.append(el("span", { className: `ap-chip${on ? " on" : ""}${cls ? " " + cls : ""}`, title }, text));
  if (rec.searched) chip(searches.count ? `Searched the web · ${searches.count} search${searches.count === 1 ? "" : "es"}` : "Searched the web", true, "The engine searched the web before answering", "searched");
  // An empty answer (1.0.2) didn't answer from memory either: say what it was.
  else if (answerKind(rec).id === "noanswer") chip(answerKind(rec).limit ? "No answer · usage limit" : "No answer", true, answerKind(rec).limit ? "The engine refused: its usage limit was reached" : "No answer text came back", "memory");
  else chip("No web search", true, "Answered from what the model already knows", "memory");
  chip(rec.sources.length ? `${rec.sources.length} pages read · ${pages.rows.length} cited` : "No pages", rec.sources.length > 0, "Pages the engine opened, and how many it cited");
  // The same count the products section shows (1.0.2): the chip counted every
  // stored copy of a card, "8 product cards" over a list of 6.
  if ((rec.products || []).length) { const pc = (productsView(rec) || { rows: [] }).rows.length || rec.products.length; if (atCardsArePicks(rec)) chip(`${pc} picks`, true, "The answer's picks, as cards"); else chip(`${pc} product cards`, true, "Product cards in the answer"); }
  if ((rec.places || []).length) chip(`Map · ${rec.places.length} places`, true, "Places on a map");
  // How fast the answer began (1.0.2): the engine's own server figure, which
  // only sat in Technical details as "Time to first token".
  {
    const ttf = rec.platformSpecific && rec.platformSpecific.ttfvtMs;
    if (Number.isFinite(ttf) && ttf > 0) chip(`First words after ${(ttf / 1000).toFixed(1)} s`, false, "How long the engine took to start answering, as it reported it");
  }
  if ((rec.images || []).length) chip(`${rec.images.length} images`, true, "Images from the web");
  if ((rec.ads || []).length) chip(`Ad · ${adAdvertisers(rec)}`, true, "A sponsored card shown with the answer", "ad");
  hero.append(strip);
  hero.append(atAnswerStrip(rec, { answers, cv, own, profile }));
  root.append(hero);
  // Under the header, not above it: the band above the pinned header is
  // covered by .at-hero::before so scrolled text can't show through.
  if (rec.isDemo || String(rec.captureId || "").startsWith("demo-")) {
    root.append(el("div", { className: "demo-banner at-demo" },
      el("span", { className: "demo-banner-label" }, "Sample"),
      el("span", {}, "This is example data showing what a captured answer looks like — not a real capture. Remove it any time from the About tab.")));
  }

  // Three columns, as on the canvas: the rail of sections, the analysis, and
  // the answer as the engine showed it (unless "Hide the answer" is on).
  const grid = el("div", { className: `at-grid${atSplit ? "" : " no-answer"}${atRailPinned ? " rail-pinned" : ""}` });
  const rail = el("nav", { className: "at-rail", id: "at-rail", "aria-label": atCompare ? "Parts of the comparison" : "Parts of this answer" });
  const main = el("div", { className: "at-main" });
  grid.append(rail, main);
  root.append(grid);

  // The answer panel is built first, shown or not: "which page backs each
  // part" and the citation numbers read it.
  const reading = atCompare && atCompareRead ? (FULL.get(atCompareRead) || null) : rec;
  const readingLight = atCompare && atCompareRead ? (ALL_RECORDS.find((r) => r.captureId === atCompareRead) || rec) : rec;
  if (atCompare && atCompareRead && !reading) hydrate(atCompareRead).then(() => renderAnalyze());
  const answerPanel = atRenderAnswer(reading || readingLight, {
    loading: atCompare && atCompareRead && !reading,
    tabs: atCompare ? answers : null,
    currentId: atCompareRead || rec.captureId,
    brandNames: mentions.map((b) => b.brand),
    own,
  });
  if (atSplit) grid.append(answerPanel.el);

  if (atCompare) {
    atRenderCompare(main, cv, answers, { own });
  } else {
    atRenderSingle(main, rec, { searches, brands, pages, you, changes, previous, kind, own, mentions, answerPanel, legacyCard, engineLabel, knownBrands });
  }
  atBuildRail(rail, main, { label: atCompare ? `Comparing ${answers.length} answers` : `${engineLabel}’s answer`, kind });
  atApplyHighlights(atScrollFocus);
  atScrollFocus = false;
  const setH = () => document.documentElement.style.setProperty("--at-hero-h", `${hero.offsetHeight}px`);
  requestAnimationFrame(setH);
  // One observer for the page's life: every re-render replaces the header.
  if (atHeroObs) atHeroObs.disconnect();
  if (window.ResizeObserver) { atHeroObs = new ResizeObserver(setH); atHeroObs.observe(hero); }
  atCompactOnScroll();
}

/* The canvas's answer strip (0.60.0): a card for each engine's answer to this
 * prompt (in a campaign, the same run; otherwise each engine's latest ad-hoc
 * answer), then the two lenses: Side by side and Over time. A campaign engine
 * that has no answer in the run gets a dashed card saying so. Class names are
 * the 0.48.0 engine tabs', which the tests and the compact header use. */
function atAnswerStrip(rec, { answers, cv, own, profile }) {
  const strip = el("div", { className: "at-engines", role: "group", "aria-label": "Answers to this prompt" });
  const youRow = own ? cv.brandGrid.find((b) => b.isYou) : null;
  cv.engines.forEach((e, i) => {
    const on = !atCompare && e.captureId === rec.captureId;
    const pos = youRow ? youRow.cells[i] : 0;
    const b = el("button", { className: `at-engine-tab${on ? " on" : ""}`, type: "button", "aria-pressed": on ? "true" : "false", title: `${e.label}'s answer` },
      el("span", { className: "at-engine-tab-label" }, el("i", { className: `at-eng-dot e-${e.id}`, "aria-hidden": "true" }), e.label,
        e.model ? el("span", { className: "at-engine-model" }, e.model) : null),
      el("span", { className: "at-engine-tab-sub" }, e.stat),
      own ? el("span", { className: `at-rank-chip${pos === 1 ? " first" : pos ? "" : " none"}` }, pos ? `${own.name} ${tr(apOrd(pos))}` : fmt("{brand} not named", { brand: own.name })) : null);
    b.onclick = () => {
      if (e.captureId === rec.captureId) { atCompare = false; renderAnalyze(); return; }
      atResetState();
      openCapture(e.captureId);
    };
    strip.append(b);
  });
  ((profile && profile.engines) || []).filter((id) => !answers.some((a) => a.platform === id)).forEach((id) => {
    strip.append(el("span", { className: "at-engine-tab missing", title: `${atEngineLabel(id)} is in this campaign but has no answer in this run` },
      el("span", { className: "at-engine-tab-label" }, el("i", { className: "at-eng-dot none", "aria-hidden": "true" }), atEngineLabel(id)),
      el("span", { className: "at-engine-tab-sub" }, "no answer in this run")));
  });
  const cmp = el("button", { className: `at-engine-tab at-lens cmp${atCompare ? " on" : ""}`, type: "button", "aria-pressed": atCompare ? "true" : "false", disabled: answers.length < 2 },
    el("span", { className: "at-engine-tab-label" }, "Side by side"),
    el("span", { className: "at-engine-tab-sub" }, answers.length > 1 ? `${answers.length} engines, ${rec.geo ? "same run" : "same prompt"}` : "needs a second engine"));
  cmp.onclick = () => { atCompare = !atCompare; atFocusBrand = null; atFocusCite = null; renderAnalyze(); };
  strip.append(cmp);
  // Over time: an ad-hoc prompt's answers in the Compare page; a campaign
  // prompt's runs on the campaign's own results.
  const key = normPrompt(rec.userPrompt);
  const adhoc = key && RECORDS.some((r) => r.captureId === rec.captureId) ? RECORDS.filter((r) => normPrompt(r.userPrompt) === key).length : 0;
  const runs = rec.geo && profile ? new Set(ALL_RECORDS.filter((r) => r.geo && r.geo.profileId === rec.geo.profileId && r.geo.promptId === rec.geo.promptId && r.platform === rec.platform).map((r) => r.geo.runId)).size : 0;
  const ot = el("button", { className: "at-engine-tab at-lens at-overtime", type: "button", "data-open": rec.geo ? "campaign" : "compare", disabled: adhoc < 2 && runs < 2,
    title: rec.geo ? "This prompt run by run, in the campaign's results" : "Every captured answer to this prompt, run by run" },
    el("span", { className: "at-engine-tab-label" }, "Over time"),
    el("span", { className: "at-engine-tab-sub" }, adhoc > 1 ? `All ${adhoc} answers to this prompt` : runs > 1 ? `${runs} runs · in the campaign` : "first time asked"));
  ot.onclick = () => {
    if (!rec.geo) { openCompareFor(rec); return; }
    cbProfileId = profile.id; geoActiveId = profile.id; cbDetail = null; cbRun = null;
    loadGeo();
    showTab("loader");
  };
  strip.append(ot);
  return strip;
}

/* The rail of sections (0.60.0). Built from the sections the page actually
 * rendered, so it never offers one that isn't there; a memory answer lists
 * what it has none of as disabled rows that say why. Clicking scrolls to the
 * section; the row of the section being read stays lit as the page scrolls. */
function atBuildRail(rail, main, { label, kind }) {
  const pin = el("button", { className: "at-rail-pin", type: "button", "aria-pressed": atRailPinned ? "true" : "false",
    title: atRailPinned ? "Let the list fold away" : "Keep the list open", "aria-label": atRailPinned ? "Let the list of sections fold away" : "Keep the list of sections open" },
    el("span", { className: "at-rail-pin-ico", "aria-hidden": "true" }, atRailPinned ? "«" : "»"), el("span", { className: "lbl" }, atRailPinned ? "Fold away" : "Keep open"));
  pin.onclick = () => {
    atRailPinned = !atRailPinned;
    try { localStorage.setItem("cito-rail-pinned", atRailPinned ? "1" : "0"); } catch (_) { /* storage off: this view only */ }
    renderAnalyze();
  };
  const split = el("button", { className: `at-split-btn${atSplit ? " on" : ""}`, type: "button", "aria-pressed": atSplit ? "true" : "false", title: atSplit ? "Hide the answer" : "Read the answer beside" },
    glyphEl("answer", 15), el("span", { className: "lbl" }, atSplit ? "Hide the answer" : "Read the answer beside"));
  split.onclick = () => { atSetSplit(!atSplit); renderAnalyze(); };
  rail.append(pin, split, el("span", { className: "at-rail-label" }, label));
  main.querySelectorAll(":scope > section[id], :scope > .at-pair > section[id]").forEach((sec) => {
    const h = sec.querySelector(".at-h, h2");
    const title = sec.dataset.rail || (h ? h.firstChild && h.firstChild.nodeType === 3 ? h.firstChild.nodeValue : h.textContent : sec.id);
    const b = el("button", { className: "at-rail-item", type: "button", "data-target": sec.id, title: String(title).trim() },
      atIconTile(sec.id, 14), el("span", { className: "t" }, String(title).trim()), el("span", { className: "n" }, sec.dataset.count || ""));
    b.onclick = () => {
      const behavior = jumpBehavior();
      sec.scrollIntoView({ block: "start", behavior });
    };
    rail.append(b);
  });
  if (kind && kind.id === "memory" && !atCompare) {
    [["Searches", "none run"], ["Sites", "none read"], ["Where it came from", "nothing cited"]].forEach(([t, why]) =>
      rail.append(el("span", { className: "at-rail-item off", title: `${t}: ${why}, because the engine answered from memory` }, el("span", { className: "at-ico i-slate" }, glyphEl("noglobe", 14)), el("span", { className: "t" }, `${t} · ${why}`))));
  }
  atRailSpy();
}

// Lights the rail row of the section at the top of the reading area. Runs on
// scroll (atCompactOnScroll) and after each render; it only touches a row
// whose state changes.
function atRailSpy() {
  const rail = document.getElementById("at-rail");
  if (!rail) return;
  const items = [...rail.querySelectorAll(".at-rail-item[data-target]")];
  if (!items.length) return;
  const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--analyze-bar-top")) || 64) + (document.querySelector("#analyze .at-hero")?.offsetHeight || 0) + 40;
  let current = items[0].dataset.target;
  for (const b of items) {
    const sec = document.getElementById(b.dataset.target);
    if (sec && sec.getBoundingClientRect().top <= line) current = b.dataset.target;
  }
  // At the very bottom the last sections can't reach the line: the last one wins.
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = items[items.length - 1].dataset.target;
  items.forEach((b) => {
    const on = b.dataset.target === current;
    if (b.classList.contains("on") !== on) {
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    }
  });
}

// Once the page scrolls, the pinned header drops to one line (engine, prompt,
// actions) so it doesn't take a fifth of the screen; scrolling back up
// restores the chips and engine tabs.
let atScrollBound = false;
/* The app bar's Analyze tools (0.56.0, the canvas's TabAnalyze): "Find a
 * captured prompt" and Newer / Older with "n of N". The search looks through
 * every capture's prompt, campaign captures included, newest first; arrow
 * keys move through the matches and Enter opens one. Paging steps through
 * your own captures, as the popup's arrows do. */
let atHeaderNodes = null;
function atHeaderTools(rec) {
  // The "Find a captured prompt" box left the bar in 0.60.2 (reported: a
  // search box makes no sense on Analyze; the Dashboard is where prompts are
  // found). The pager stays.
  // Simple / Expert as one small switch (0.60.2; reported: the two-button
  // segment took too much of the bar). Off is Simple, on is Expert.
  const on = document.documentElement.getAttribute("data-detail") === "expert";
  const sw = el("button", { className: `at-detail-switch${on ? " on" : ""}`, type: "button", role: "switch", "aria-checked": String(on), "data-detail-switch": "", title: "Expert adds raw ids, listing feeds, a grounding figure and the raw payload" },
    el("span", { className: "at-switch-track", "aria-hidden": "true" }, el("span", { className: "at-switch-dot" })), el("span", { className: "at-switch-label" }, "Expert"));
  sw.onclick = () => setDetail(document.documentElement.getAttribute("data-detail") === "expert" ? "simple" : "expert");
  // This answer, a task and a question, to another AI: through the app
  // bar's share icon (0.80.0), not a button of its own.
  setShare("analyze", { getParts: async () => answerParts(await hydrate(rec.captureId) || rec, { ownBrand: (ownBrandFor(rec, GEO_PROFILES) || {}).name || null }), file: "citoskeleton-answer.md" });
  const nodes = [sw];
  const idx = RECORDS.findIndex((r) => r.captureId === rec.captureId);
  if (idx >= 0 && RECORDS.length > 1) {
    const go = (j) => { const t = RECORDS[j]; if (t) { atResetState(); openCapture(t.captureId); } };
    const newer = el("button", { className: "at-page-btn", type: "button", title: "Newer capture", "aria-label": "Newer capture" }, "‹");
    newer.disabled = idx === 0;
    newer.onclick = () => go(idx - 1);
    const older = el("button", { className: "at-page-btn", type: "button", title: "Older capture", "aria-label": "Older capture" }, "›");
    older.disabled = idx === RECORDS.length - 1;
    older.onclick = () => go(idx + 1);
    nodes.push(el("div", { className: "at-pager" }, newer, el("span", { className: "ap-paging" }, `${idx + 1} of ${RECORDS.length}`), older));
  }
  return nodes;
}

function atCompactOnScroll() {
  const apply = () => {
    const hero = document.querySelector("#analyze .at-hero");
    // Shrinking the header frees ~100px, and the browser keeps the content
    // in place by moving the scroll position up by as much. With one
    // threshold (140px until 0.60.0) that moved the page back above it, the
    // header grew again, and the two flipped every frame — the page shook
    // (reported in 0.60.0, whose header is taller). So it shrinks only well
    // down the page and grows back only near the top: the jump in between
    // can't cross both.
    if (hero) {
      const compact = hero.classList.contains("compact");
      if (!compact && window.scrollY > 220) hero.classList.add("compact");
      else if (compact && window.scrollY < 24) hero.classList.remove("compact");
    }
    // Near the end of the page the grid stops above the footer, and a
    // pinned panel taller than what's left gets pushed up under the header.
    // Shorten it by that much instead, so its top stays put.
    const grid = document.querySelector("#analyze .at-grid");
    const cut = grid ? Math.max(0, Math.round(window.innerHeight - 12 - grid.getBoundingClientRect().bottom)) : 0;
    const root = document.documentElement.style;
    if (root.getPropertyValue("--at-end-cut") !== `${cut}px`) root.setProperty("--at-end-cut", `${cut}px`);
    atRailSpy();
  };
  apply();
  if (atScrollBound) return;
  atScrollBound = true;
  window.addEventListener("scroll", apply, { passive: true });
  window.addEventListener("resize", apply, { passive: true });
}

/* The answer as the engine showed it, with brands and citations marked. */
function atRenderAnswer(rec, { loading, tabs, currentId, brandNames, own }) {
  const aside = el("aside", { className: "at-answer", id: "at-answer", "aria-labelledby": "at-answer-h" });
  const head = el("div", { className: "at-answer-head" });
  const icon = engineIconEl(rec.platform);
  icon.classList.add("at-answer-icon");
  const words = rec.answerText ? rec.answerText.trim().split(/\s+/).length : (rec.platformSpecific || {}).wordCount || 0;
  head.append(icon, el("div", { className: "at-answer-title" },
    el("h2", { className: "at-h", id: "at-answer-h" }, `The answer, as ${atEngineLabel(rec.platform)} showed it`),
    el("span", { className: "ap-muted" }, [apDate(rec.capturedAt) + ", " + apTime(rec.capturedAt), words ? `${words} words` : "", answerKind(rec).label.toLowerCase() + " answer"].filter(Boolean).join(" · "))));
  if (rec.pageUrl && /^https?:\/\//.test(rec.pageUrl)) {
    let host = "";
    try { host = new URL(rec.pageUrl).hostname.replace(/^www\./, ""); } catch (_) {}
    head.append(el("a", { className: "at-open", href: rec.pageUrl, target: "_blank", rel: "noreferrer", title: "Open the conversation where it was captured" }, fmt("Open on {site} ↗", { site: host })));
  }
  aside.append(head);
  if (tabs) {
    const t = el("div", { className: "at-ans-tabs", role: "tablist", "aria-label": "Whose answer to read" });
    tabs.forEach((a) => {
      const on = a.captureId === currentId;
      const ic = engineIconEl(a.platform);
      ic.classList.add("ap-engine-icon");
      const b = el("button", { className: `ap-sheet-tab${on ? " on" : ""}`, type: "button", role: "tab", "aria-selected": on ? "true" : "false" }, ic, ` ${atEngineLabel(a.platform)}`);
      b.onclick = () => { atCompareRead = a.captureId; atFocusBrand = null; atFocusCite = null; renderAnalyze(); };
      t.append(b);
    });
    aside.append(t);
  }
  const hl = el("div", { className: "at-hl" }, el("span", { className: "ap-muted" }, "Highlight"));
  const toggle = (label, getOn, set) => {
    const b = el("button", { className: `at-hl-btn${getOn() ? " on" : ""}`, type: "button", "aria-pressed": getOn() ? "true" : "false" }, label);
    b.onclick = () => { set(!getOn()); b.classList.toggle("on", getOn()); b.setAttribute("aria-pressed", getOn() ? "true" : "false"); atApplyHighlights(); };
    return b;
  };
  hl.append(toggle("Brands", () => atHlBrands, (v) => { atHlBrands = v; }), toggle("Citations", () => atHlCites, (v) => { atHlCites = v; }));
  const clear = el("button", { className: "at-hl-clear", type: "button", hidden: true }, "");
  clear.onclick = () => { atFocusBrand = null; atFocusCite = null; atApplyHighlights(); };
  hl.append(clear);
  aside.append(hl);

  // The answer reads in its own direction, whatever the interface's (0.71.0).
  const body = el("div", { className: "at-answer-body", dir: "auto" });
  aside.append(body);
  if (loading) {
    body.append(el("p", { className: "ap-note" }, "Loading this answer…"));
    return { el: aside, blocks: [], footnotes: [] };
  }
  // The line each engine shows above its answer, and Perplexity's source
  // cards, so the panel reads like the engine's own page. Only what the
  // capture holds: no made-up "thought for" times.
  const sources = rec.sources || [];
  const cited = sources.filter((s) => s.outcome === "cited");
  const nSearch = searchesView(rec, brandNames).count;
  const didSearch = !!(rec.searched || sources.length);
  const empty = answerKind(rec).id === "noanswer";
  const step = empty ? [answerKind(rec).limit ? "No answer: usage limit reached" : "No answer", "memory"]
    : !didSearch ? ["Answered without searching the web", "memory"]
    : rec.platform === "perplexity" ? [[nSearch ? `Searched ${plural(nSearch, "query", "queries")}` : "", `Reviewed ${plural(sources.length, "source")}`].filter(Boolean).join(" · "), "plain"]
    : rec.platform === "chatgpt" ? [sources.length ? `Searched ${plural(sources.length, "site")}` : "Searched the web", "pill"]
    : rec.platform === "grok" ? [[nSearch ? `Searched ${plural(nSearch, "time")}` : "Searched", plural(sources.length, "web page and post", "web pages and posts")].join(" · "), "plain"]
    : null;
  if (step) body.append(el("span", { className: `at-ans-step ${step[1]}` }, step[0]));
  const model = rec.answerText ? buildExportModel(rec) : null;
  const fnN = new Map(model ? model.footnotes.map((f) => [f.source.url, String(f.n)]) : []);
  if (didSearch && rec.platform === "perplexity" && cited.length) {
    const top = el("div", { className: "at-ans-sources", "aria-label": "Sources, as Perplexity lists them above the answer" });
    cited.slice(0, 4).forEach((s) => {
      const n = fnN.get(s.url) || "";
      const b = el("button", { className: "at-ans-source", type: "button", "data-focus-cite": n, "aria-pressed": "false", disabled: !n, title: s.url || "" },
        el("span", { className: "at-ans-source-t" }, s.title || normDomainLabel(s.domain || s.url)),
        el("span", { className: "ap-muted" }, [atShortDomain(normDomainLabel(s.domain || s.url)), n].filter(Boolean).join(" · ")));
      if (n) b.onclick = () => atFocusCiteBtn(n);
      top.append(b);
    });
    body.append(top);
  }
  // A card answer draws its own cards in the text, as ChatGPT did (0.60.2),
  // so the carousel strip above it would show them twice.
  const genUiCards = !!(rec.platformSpecific && Array.isArray(rec.platformSpecific.genUiBlocks) && rec.platformSpecific.genUiBlocks.some((b) => b.type === "card"));
  if ((rec.products || []).length && !genUiCards) {
    const cards = el("div", { className: "at-ans-cards", "aria-label": "Product cards, in the order the carousel showed them" });
    rec.products.forEach((p, i) => cards.append(el("div", { className: `at-ans-card${own && new RegExp(`^${escapeRegExp(own.name)}\\b`, "i").test(String(p.name || "")) ? " mine" : ""}` },
      el("span", { className: "at-ans-wrap" }, withImage(el("span", { className: "at-ans-thumb" }, glyphEl("cart", 30)), p.image, p.name), el("span", { className: "ap-card-n" }, String(i + 1))),
      el("span", { className: "ap-card-name" }, p.name || "—"),
      el("span", { className: "ap-card-price" }, p.price || ""),
      el("span", { className: "ap-card-meta" }, [p.rating != null ? `★ ${p.rating}` : "", p.merchant || ""].filter(Boolean).join(" · ")))));
    body.append(cards);
  }
  if ((rec.places || []).length) {
    const ol = el("ol", { className: "ap-places at-ans-places" });
    rec.places.forEach((p, i) => ol.append(el("li", { className: "ap-place" }, el("span", { className: "ap-pin" }, String(i + 1)), el("span", { className: "ap-place-name" }, p.name || "—"), el("span", { className: "ap-muted" }, p.rating != null ? `★ ${p.rating}` : ""))));
    body.append(ol);
  }
  if ((rec.images || []).length && !(rec.products || []).length) {
    const g = el("div", { className: "ap-imgs at-ans-imgs" });
    rec.images.slice(0, 8).forEach((im) => {
      g.append(el("a", { className: "ap-img", href: im.url, target: "_blank", rel: "noreferrer", title: im.title || "" },
        withImage(el("span", { className: "ap-img-frame" }, el("span", { className: "ap-img-ph" }, im.title || "image")), im.url, im.title)));
    });
    body.append(g);
  }
  if (!rec.answerText) {
    body.append(el("p", { className: "ap-note" }, empty
      ? (answerKind(rec).limit ? `${atEngineLabel(rec.platform)} sent its usage-limit notice instead of an answer, so there is no text to show.` : "The engine sent no answer text for this question.")
      : rec.hasAnswerText === false || !rec.answerChars
      ? "The answer text wasn't captured for this answer — the analysis on the left comes from its searches, pages and cards."
      : "Loading the answer text…"));
    return { el: aside, blocks: [], footnotes: [] };
  }
  const text = el("div", { className: "at-answer-text" });
  // bodyHtml is built by exportDoc.js from escaped text plus a fixed set of
  // our own tags (see markdownToHtml there), the same HTML the export writes.
  text.innerHTML = model.bodyHtml;
  // A card picture that won't load leaves its frame empty rather than a
  // broken-image icon.
  text.querySelectorAll(".gu-pic img").forEach((img) => { img.onerror = () => img.remove(); });
  const fnByN = new Map(model.footnotes.map((f) => [String(f.n), f.source]));
  text.querySelectorAll("sup.fn a").forEach((a) => {
    const n = (a.textContent.match(/\d+/) || [""])[0];
    const s = fnByN.get(n);
    const label = s ? normDomainLabel(s.domain || s.url) : n;
    const chipEl = el("button", { className: "at-cite", type: "button", "data-n": n, title: s ? `${s.title || ""} — ${s.url || ""}` : `Citation ${n}` }, label);
    chipEl.onclick = () => { atFocusCite = atFocusCite === n ? null : n; atFocusBrand = null; atApplyHighlights(true); };
    a.parentNode.replaceWith(chipEl);
  });
  atMarkBrands(text, brandNames);
  body.append(text);
  if (model.footnotes.length) {
    const list = el("ol", { className: "at-fn-list", "aria-label": "Sources cited in the answer" });
    model.footnotes.forEach((f) => list.append(el("li", { "data-n": String(f.n) },
      el("a", { href: f.source.url || "#", target: "_blank", rel: "noreferrer" }, normDomainLabel(f.source.domain || f.source.url)),
      el("span", { className: "ap-muted" }, ` ${f.source.title || ""}`))));
    body.append(el("h3", { className: "at-h3" }, rec.platform === "gemini" ? "Sources and related content" : "Sources"), list);
  }
  // The engine's ad, where it showed it: under the answer.
  if ((rec.ads || []).length) adsView(rec).forEach((a) => body.append(adCardEl(a, { compact: true })));
  // Blocks with the citations inside them, for "which page backs each part".
  const blocks = [...text.querySelectorAll("p, li")].map((b) => ({
    text: b.textContent.replace(/\s+/g, " ").trim(),
    cites: [...new Set([...b.querySelectorAll(".at-cite")].map((c) => c.textContent))],
  })).filter((b) => b.text);
  return { el: aside, blocks, footnotes: model.footnotes };
}

function normDomainLabel(d) {
  return String(d || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/* Wrap every mention of a known brand in a <mark>, outside links and chips. */
function atMarkBrands(container, names) {
  const list = [...new Set(names.filter((n) => n && n.length > 1))].sort((a, b) => b.length - a.length);
  if (!list.length) return;
  // Escaped for a /u pattern: escapeRegExp() also escapes "-", which is a
  // syntax error under /u ("CaratLane - Phoenix Mall" crashed the page).
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${list.map(reEsc).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    // Inside the answer's own links too (Gemini links every hotel it names);
    // not inside citation chips, footnotes or a mark already made.
    acceptNode: (n) => (n.parentElement && n.parentElement.closest("button, mark, sup, .at-fn-list") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const t = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(t)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(t))) {
      const start = m.index + m[1].length;
      frag.append(document.createTextNode(t.slice(last, start)));
      const canon = list.find((n) => n.toLowerCase() === m[2].toLowerCase()) || m[2];
      const mark = el("mark", { className: "at-mark", "data-brand": canon, title: fmt("{brand} — click to show only this brand", { brand: canon }) }, m[2]);
      // In a link, the click picks the brand rather than leaving the page.
      mark.onclick = (e) => { e.preventDefault(); atFocusBrand = atFocusBrand === canon ? null : canon; atFocusCite = null; atApplyHighlights(); };
      frag.append(mark);
      last = start + m[2].length;
    }
    frag.append(document.createTextNode(t.slice(last)));
    node.replaceWith(frag);
  }
}

/* Highlights change in place — no re-render, so the answer keeps its scroll. */
function atApplyHighlights(scroll) {
  const body = document.querySelector("#at-answer .at-answer-body");
  if (!body) return;
  body.classList.toggle("hl-brands", atHlBrands);
  body.classList.toggle("hl-cites", atHlCites);
  body.classList.toggle("has-focus", !!(atFocusBrand || atFocusCite));
  body.querySelectorAll(".at-mark").forEach((m) => m.classList.toggle("focus", m.dataset.brand === atFocusBrand));
  body.querySelectorAll(".at-cite").forEach((c) => c.classList.toggle("focus", c.dataset.n === atFocusCite));
  body.querySelectorAll(".at-fn-list li").forEach((li) => li.classList.toggle("focus", li.dataset.n === atFocusCite));
  document.querySelectorAll("#analyze [data-focus-brand]").forEach((r) => r.setAttribute("aria-pressed", r.dataset.focusBrand === atFocusBrand ? "true" : "false"));
  document.querySelectorAll("#analyze [data-focus-cite]").forEach((r) => r.setAttribute("aria-pressed", r.dataset.focusCite === atFocusCite ? "true" : "false"));
  const clear = document.querySelector("#at-answer .at-hl-clear");
  if (clear) {
    clear.hidden = !(atFocusBrand || atFocusCite);
    clear.textContent = atFocusBrand ? `Showing ${atFocusBrand} ×` : atFocusCite ? `Showing citation ${atFocusCite} ×` : "";
  }
  if (scroll !== false && (atFocusBrand || atFocusCite)) {
    const first = body.querySelector(".at-mark.focus, .at-cite.focus");
    const behavior = jumpBehavior();
    if (!first) return;
    // Scroll the pinned answer panel only. scrollIntoView() also scrolls the
    // page, so the row just clicked on the left jumped away.
    if (body.scrollHeight > body.clientHeight + 1) {
      const y = first.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - body.clientHeight / 2;
      body.scrollTo({ top: Math.max(0, y), behavior });
    } else {
      first.scrollIntoView({ block: "center", behavior });
    }
  }
}

const KIND_GROUPS_UI = ["Your site", "Rival brand sites", "Review sites", "Retailers", "Forums & social", "Public & reference", "Other"];

/* The single answer, laid out as the canvas's Answer board (0.60.0).
 *
 * The owner's brief for this release: where each recommendation came from
 * matters for every kind of answer, not just shopping, and the page needs
 * real depth while staying simple and organised enough for anyone from an
 * SEO to an industry researcher. So the sections follow the canvas and the
 * rail beside them lists them: at a glance; your brand; what led the answer
 * (product cards and where to buy, the map, the pictures, the page behind
 * each part, or "answered from memory"); the ad shown with it; where it came
 * from; every site it read; the searches it ran; since the last time; and
 * Details. What the capture doesn't hold is said ("not captured") rather
 * than left blank, where a blank would read as zero. */
const AT_LANE_SHORT = { web: "web", shopping: "shop", image: "img" };
const AT_TONE_DOT = { good: "var(--green-fg)", warn: "var(--amber-fg)", bad: "var(--red-fg)", neutral: "var(--fg-muted)" };
const AT_VERDICT = {
  independent: ["Backed by independent pages", "good"],
  own: ["Backed only by its own site", "warn"],
  read: ["Read, not cited", "warn"],
  // Said only as far as it was checked (0.62.1): "none" means the cited
  // pages were read and none names it; "unchecked" that the titles and
  // snippets the engine sent don't, and the pages themselves weren't read.
  none: ["No cited page names it", "bad"],
  unchecked: ["Not in what the engine sent", "neutral"],
  nocited: ["Nothing cited", "neutral"],
  memory: ["From memory", "warn"],
};
const atShortDomain = (d) => String(d || "").replace(/^www\./, "").replace(/\.(co\.in|co\.uk|com|in|org|net|io|ai|app)$/i, "");
// Picking a brand or a citation shows it in the answer; with the answer
// hidden, picking one brings the answer back first (as on the canvas).
const atShowAnswerFor = () => {
  if (document.getElementById("at-answer")) return false;
  atSetSplit(true);
  atScrollFocus = true;
  renderAnalyze();
  return true;
};
const atFocusCiteBtn = (n) => { atFocusCite = atFocusCite === n ? null : n; atFocusBrand = null; if (!atShowAnswerFor()) atApplyHighlights(); };
const atFocusBrandBtn = (name) => { atFocusBrand = atFocusBrand === name ? null : name; atFocusCite = null; if (!atShowAnswerFor()) atApplyHighlights(); };
// "A, B and C"
const atList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
// The date the engine sent with a page: "2 Oct" this year, "2 Oct 2024" before.
function atShortDay(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(dateLocale(), d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
// A small square with a site's first letter, its colour picked from the name.
function atFav(domain) {
  const d = String(domain || "").replace(/^www\./, "");
  return el("span", { className: "at-fav", style: `--h:${atHue(d)}`, "aria-hidden": "true" }, (d[0] || "?").toUpperCase());
}

function atRenderSingle(main, rec, ctx) {
  const { searches, brands, pages, you, changes, previous, kind, own, mentions, answerPanel, engineLabel, legacyCard, knownBrands } = ctx;
  const fnByUrl = new Map(answerPanel.footnotes.map((f) => [f.source.url, String(f.n)]));
  const searchedWeb = !!(rec.searched || rec.sources.length);
  const ctxKinds = { ownBrand: own ? own.name : "", ownUrl: own ? own.url : "", brands: mentions.map((b) => b.brand) };
  const positions = resultPositions(rec);
  // Each section carries the count its rail row shows.
  const add = (sec, count) => {
    if (!sec) return;
    if (count != null && count !== "") sec.dataset.count = String(count);
    main.append(sec);
  };
  const named = brands.rows.filter((r) => r.position > 0).sort((a, b) => a.position - b.position);

  /* 0. the raw payload, Expert only, closed until asked for */
  main.append(atRawPanel(rec, engineLabel));

  /* 1. at a glance */
  add(atGlance(rec, { brands, pages, searches, fnByUrl, kind, engineLabel, answerPanel, searchedWeb, knownBrands }));

  /* 2. your brand */
  if (you) {
    const placed = you.tiles.find((t) => t.key === "answer");
    add(atYouSection(rec, { you, brands, searches, own }), placed ? placed.value.replace(/^Named /, "") : "");
  }

  /* 2b. the built-in AI's check (0.70.0) */
  add(atAiSection(rec), rec.ai && rec.aiStatus === "done" ? ((rec.ai.entities || []).length + (rec.ai.missed || []).length) || "" : "");

  /* 3. what led the answer */
  if (kind.id === "memory") add(atMemorySection(rec, { brands, mentions, engineLabel }));
  if (kind.id === "noanswer") add(el("section", { className: "at-memory", id: "at-noanswer", "data-rail": "No answer" },
    el("div", { className: "at-memory-note" },
      el("div", { className: "at-memory-head" }, glyphEl("noglobe", 20), el("h2", { className: "at-h" }, kind.limit ? "No answer: usage limit reached" : "No answer")),
      el("p", {}, kind.limit
        ? `${engineLabel} refused this question because its usage limit was reached. Nothing was searched, read or cited, and this is not an answer from memory.`
        : `${engineLabel} sent no answer text for this question. Nothing was searched, read or cited.`))));
  const products = productsView(rec, { own, knownBrands });
  if (products) add(atProductsSection(rec, products, { engineLabel, own }), products.rows.length);
  if ((rec.places || []).length) add(atPlacesSection(rec, own), rec.places.length);
  // Every answer that showed images gets them here. This used to need three or
  // more, and more images than products, so a shopping answer — whose
  // pictures are its product shots — never showed them in the full tab; only
  // the popup did (reported, 0.58.0).
  if ((rec.images || []).length) add(atImagesSection(rec, own, ctxKinds), rec.images.length);
  // "Which page backs each part" lives in Details only, for every engine
  // (0.62.1, asked): here it sat right under the brand card on Grok,
  // Perplexity and Gemini answers.

  /* 4. the ad shown with the answer */
  if ((rec.ads || []).length) add(atAdsSection(rec, { knownBrands }), rec.ads.length);

  /* 5. where it came from */
  if (named.length && kind.id !== "memory") add(atBackingSection(rec, brands, { own, pages, kind, ctxKinds, knownBrands, products }), `${named.filter((r) => r.backing.backers.length).length}/${named.length}`);

  /* 6. every site it read */
  const sites = domainsView(rec, { own, knownBrands });
  if (sites.rows.length) add(atSitesSection(rec, sites, { fnByUrl, pages, own, ctxKinds, positions, knownBrands }), `${sites.citedSites}/${sites.rows.length}`);

  /* 7. the searches it ran */
  if (searchedWeb) add(atBuiltSection(rec, { searches, pages, mentions, kind, engineLabel }), searches.unpublished ? "?" : searches.count);

  /* 8. since the last time */
  add(atChangesSection(changes, { engineLabel, previous }), changes ? changes.items.filter((x) => x.kind !== "same").length || "" : "");

  /* 9. details */
  add(atDetailsSection(rec, { searches, pages, kind, engineLabel, answerPanel, ctxKinds, mentions, legacyCard }));
}

/* At a glance: what the answer led with, the numbers that sum it up, then
 * the brands named, the pages cited and the searches, each in full and each
 * clickable to show it in the answer. */
function atGlance(rec, { brands, pages, searches, fnByUrl, kind, engineLabel, answerPanel, searchedWeb }) {
  const sec = atSection("at-glance", "At a glance", "");
  sec.classList.add("at-glance-sec");
  // What the answer led with, as a fact. Until 0.59.0 each line went on to
  // say what "matters most"; the owner asked for the data without the
  // interpretation ("we are not spoonfeeding here").
  sec.append(el("p", { className: "at-lead" }, {
    shopping: "Product cards came first, then the text.",
    local: "A map came first, then the text.",
    images: "Pictures came first, then the text.",
    info: "Text only, no cards, map or pictures.",
    memory: "No web search: nothing was read or cited.",
    noanswer: kind.limit ? "No answer: the engine's usage limit was reached." : "No answer text came back.",
  }[kind.id] || ""));
  const named = brands.rows.filter((r) => r.position > 0).sort((a, b) => a.position - b.position);
  const tiles = el("div", { className: "at-kpis" });
  const tile = (label, value, sub, tone, cls) => tiles.append(el("div", { className: `at-kpi${cls ? ` ${cls}` : ""}` },
    el("span", { className: "at-kpi-k" }, label), el("span", { className: "at-kpi-v" }, value),
    sub ? el("span", { className: `at-kpi-s${tone ? ` tone-${tone}` : ""}` }, sub) : null));
  const first = named[0];
  if (first) {
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const card = (rec.products || []).findIndex((p) => new RegExp(`^${esc(first.name)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(String(p.name || "")));
    const place = (rec.places || []).find((p) => String(p.name || "").toLowerCase().startsWith(first.name.toLowerCase()));
    const sub = card >= 0 ? `card ${card + 1} of ${rec.products.length}` : place && place.address ? place.address : `named ×${first.count}`;
    tile("Named first", first.name, `${sub}${first.isYou ? " · your brand" : ""}`, first.isYou ? "good" : "");
  } else {
    tile("Named first", "No brand named", "");
  }
  if (kind.id === "shopping") {
    const stores = new Set((rec.products || []).flatMap((p) => atMerchants(p)));
    tile("Product cards", String(rec.products.length), stores.size ? `listing ${plural(stores.size, "store")}` : "no store named");
  } else if (kind.id === "local") {
    const feeds = new Map();
    rec.places.forEach((p) => { const s = supplierOf(p.supplier); if (s) feeds.set(s.code, (feeds.get(s.code) || 0) + 1); });
    const answer = String(rec.answerText || "").toLowerCase();
    const inText = rec.places.filter((p) => p.name && answer.includes(String(p.name).toLowerCase())).length;
    tile("Places on the map", String(rec.places.length), feeds.size ? `listings: ${[...feeds].map(([c, n]) => `${c} ${n}`).join(" · ")}` : `${inText} named in the text`);
  } else if (kind.id === "images") {
    const hosts = new Set(rec.images.map((im) => atHost(im.sourceUrl || im.link || "") || atHost(im.url)).filter(Boolean));
    tile("Pictures", String(rec.images.length), `from ${plural(hosts.size, "site")}`);
  } else if (kind.id === "info" && answerPanel.blocks.length) {
    const parts = answerPanel.blocks.slice(0, 12);
    const withPage = parts.filter((b) => b.cites.length).length;
    tile("Parts with a cited page", `${withPage} of ${parts.length}`, withPage === parts.length ? "every part" : `${parts.length - withPage} cite nothing`, withPage === parts.length ? "good" : "warn");
  }
  if (named.length && kind.id !== "memory") {
    const none = named.filter((r) => !r.backing.backers.length).map((r) => r.name);
    tile(kind.id === "local" ? "Places with a cited page" : "Brands with a cited page", `${named.length - none.length} of ${named.length}`,
      none.length ? fmt("{names} have none", { names: `${atList(none.slice(0, 3))}${none.length > 3 ? ` +${none.length - 3}` : ""}`, n: none.length }, "{names} has none") : "every one", none.length ? "bad" : "good");
  }
  tile("Pages cited", rec.sources.length ? `${pages.rows.length} of ${pages.sourceCount}` : "None",
    rec.sources.length ? "of the pages it read" : kind.id === "memory" ? "answered from memory" : "no page read");
  tile("Searches", searches.unpublished ? "Not shown" : String(searches.count),
    searches.unpublished ? `${engineLabel} doesn’t publish them` : searches.breadth ? searches.breadth.short.toLowerCase() : searchedWeb ? "" : "none run",
    searches.breadth && searches.breadth.band === "narrow" ? "warn" : "");
  if ((rec.ads || []).length) {
    const a = adsView(rec)[0];
    tile("Ad shown", a.advertiser, a.place ? `also named ${apOrd(a.place)} in the answer` : "not named in the answer", "", "at-kpi-ad");
  }
  // Expert: how much of the answer's wording is found on a page it read.
  const vg = rec.sources.length && rec.answerText ? computeVerbatimGrounding(rec.answerText, rec.sources) : null;
  if (vg && vg.totalClaims) tile("Grounding", `${vg.score}%`, `${vg.groundedClaims} of ${vg.totalClaims} sentences match a page it read`, "", "x-only");
  sec.append(tiles);
  if (!searchedWeb) return sec;

  const cols = el("div", { className: "at-glance" });
  const colB = el("div", { className: "at-glance-col" }, el("h2", {}, "Brands named ", el("span", {}, `· ${named.length}`)));
  // Every brand, every cited page, every search, in full (0.58.0: reported
  // "the very first section … is getting truncated").
  named.forEach((r) => {
    const b = el("button", { className: `at-glance-brand${r.isYou ? " mine" : ""}`, type: "button", "data-focus-brand": r.name, "aria-pressed": "false", title: fmt("{brand}: {verdict} — show it in the answer", { brand: r.name, verdict: tr((AT_VERDICT[r.backing.verdict] || [r.backing.label])[0]).toLowerCase() }) },
      el("span", { className: `at-rank${r.position === 1 ? " first" : ""}` }, String(r.position)),
      el("span", { className: "at-glance-name" }, r.name),
      el("span", { className: "at-glance-n" }, `×${r.count}`),
      el("span", { className: "at-dot", style: `background:${AT_TONE_DOT[(AT_VERDICT[r.backing.verdict] || [, r.backing.tone])[1]] || AT_TONE_DOT.neutral}` }));
    b.onclick = () => atFocusBrandBtn(r.name);
    colB.append(b);
  });
  if (!named.length) colB.append(el("span", { className: "ap-muted" }, "No brand named."));
  const colP = el("div", { className: "at-glance-col" }, el("h2", {}, "Pages cited ", el("span", {}, `· ${pages.rows.length} of ${pages.sourceCount} read`)));
  pages.rows.forEach((p) => {
    const n = fnByUrl.get(p.url) || null;
    const b = el("button", { className: "at-glance-page", type: "button", "data-focus-cite": n || "", "aria-pressed": "false", title: p.title || p.domain, disabled: !n },
      el("span", { className: "at-site-chip" }, atShortDomain(p.domain)), el("span", { className: "at-glance-kind" }, `${p.domain} · ${atKindOne(p.kind).toLowerCase()}`));
    if (n) b.onclick = () => atFocusCiteBtn(n);
    colP.append(b);
  });
  if (pages.readOnly.length) {
    const more = el("button", { className: "at-glance-warn at-glance-jump", type: "button", title: "Every site it read, below" },
      `+ ${pages.readOnly.length} site${pages.readOnly.length === 1 ? "" : "s"} read but not cited ↓`);
    more.onclick = () => document.getElementById("at-sites")?.scrollIntoView({ behavior: jumpBehavior(), block: "start" });
    colP.append(more);
  }
  if (!pages.rows.length) colP.append(el("span", { className: "ap-muted" }, "It cited no page."));
  const colS = el("div", { className: "at-glance-col" }, el("h2", {}, "Searches it ran ", el("span", {}, `· ${searches.unpublished ? "not shown" : searches.count}`)));
  searches.rows.forEach((q) => colS.append(el("span", { className: "at-glance-q" }, el("span", { className: `at-lane-tag l-${q.lane}` }, AT_LANE_SHORT[q.lane] || q.lane), el("span", { className: "at-glance-qt", title: q.text }, q.text))));
  if (searches.unpublished) colS.append(el("span", { className: "ap-muted" }, "This engine searched but doesn’t publish its searches."));
  cols.append(colB, colP, colS);
  sec.append(cols);
  return sec;
}

/* Your brand in this answer, as tiles: where it was named, what backs it,
 * its cards and own store, its images, the searches that named it. */
function atYouSection(rec, { you, brands, searches, own }) {
  const since = you.since ? el("span", { className: "at-chip at-chip-since", title: `Compared with ${new Date(you.previousAt).toLocaleString(dateLocale())}` }, `vs ${apDate(you.previousAt)}: ${you.since}`) : null;
  const sec = atSection("at-you", `${you.name} in this answer`, "", since);
  sec.classList.add("at-you");
  sec.dataset.rail = `${you.name} in this answer`;
  const grid = el("div", { className: "at-you-tiles" });
  const tile = (label, value, sub, tone) => grid.append(el("div", { className: "at-you-tile" },
    el("span", { className: "at-you-label" }, label), el("span", { className: `at-you-value tone-${tone || "neutral"}` }, value), el("span", { className: "at-you-sub" }, sub || "")));
  you.tiles.forEach((t) => tile(t.label, t.value, t.sub, t.tone));
  const row = brands.rows.find((r) => r.isYou);
  if (row && row.position > 0 && rec.searched) {
    const [label, tone] = AT_VERDICT[row.backing.verdict] || [row.backing.label, row.backing.tone];
    tile("Backed by", row.backing.backers.length ? row.backing.label : label, row.backing.backers.length ? atList(row.backing.backers.slice(0, 2).map((b) => b.domain)) + (row.backing.backers.length > 2 ? ` +${row.backing.backers.length - 2}` : "") : row.backing.readOnly ? `in ${plural(row.backing.readOnly, "page")} read, not cited` : "no cited page names it", tone);
  }
  if (searches.count) tile(`Searches naming ${own.name}`, `${searches.namingBrand ? searchesNaming(searches, own.name) : 0} of ${searches.count}`, "", "neutral");
  sec.append(grid);
  return sec;
}
// How many of the searches name this one brand (searchesView counts any brand).
function searchesNaming(searches, name) {
  const w = String(name).toLowerCase().split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!w) return 0;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, "iu");
  return searches.rows.filter((q) => re.test(q.text)).length;
}

function atMemorySection(rec, { brands, mentions, engineLabel }) {
  const sec = el("section", { className: "at-memory", id: "at-memory", "aria-labelledby": "at-memory-h", "data-rail": "Answered from memory" });
  sec.append(el("div", { className: "at-memory-note" },
    el("div", { className: "at-memory-head" }, glyphEl("noglobe", 20), el("h2", { id: "at-memory-h", className: "at-h" }, "Answered from memory")),
    el("p", {}, `${engineLabel} didn’t search the web, so nothing was read or cited. Every brand below comes from what the model learned in training.`)));
  const list = el("div", { className: "at-memory-brands" }, el("h2", {}, "How the model describes each brand"));
  brands.rows.filter((r) => r.position > 0).sort((a, b) => a.position - b.position).slice(0, 8).forEach((r) => {
    const m = mentions.find((x) => x.brand === r.name);
    const why = m ? extractBrandAspects(m.passages || []).slice(0, 3).join(", ") : "";
    list.append(el("div", { className: "at-memory-row" }, el("span", { className: "at-rank" }, String(r.position)), el("span", { className: "at-memory-name" }, r.name), el("span", { className: "ap-muted" }, why || "named without a reason")));
  });
  sec.append(list);
  return sec;
}

/* The ad ChatGPT showed with the answer: the card as it was, and the facts
 * that tie it to the answer. What an ad cost or did is not in the capture. */
/* The built-in AI's check (0.70.0): what the answer is (language, market,
 * intent, audience, topics), each brand's type, owner and how the answer
 * treats it with the quote that shows it, and names the rules missed. Every
 * claim here was checked against the answer before it was kept (lib/
 * aiValidate.js); what wasn't backed is counted at the foot. Counts change
 * only with "Let the AI correct brands in counts" on. */
const AI_LABEL = {
  comparison: "Comparisons & alternatives", local: "Local & near me", price_value: "Price, cost & value", trust: "Trust, safety & compliance",
  careers: "Jobs & careers", howto: "How-to & information", for_use: "For a person or use", best_top: "Best, top & reviews", other: "Other",
  awareness: "Learning about options", consideration: "Comparing options", decision: "Ready to choose", post_purchase: "After buying",
  consumer: "Consumers", business: "Businesses", public_sector: "Public sector", mixed: "Mixed",
  local_scope: "Local", national: "National", regional: "Regional", global: "Global",
  brand: "Brand", product: "Product", retailer: "Store", publisher: "Publisher", institution: "Institution", place: "Place", person: "Person", not_a_name: "Not a name",
  recommended: "Recommended", positive: "Positive", neutral: "Neutral", negative: "Negative", advised_against: "Advised against", mentioned: "Mentioned",
};
const AI_STANCE_TONE = { recommended: "ok", positive: "ok", neutral: "neutral", negative: "bad", advised_against: "bad", mentioned: "neutral" };
function aiName(kind, code) {
  if (!code) return "";
  try { return new Intl.DisplayNames([navigator.language || "en"], { type: kind }).of(code) || code; } catch (_) { return code; }
}
function atAiSection(rec) {
  const ai = rec.aiStatus === "done" ? rec.ai : null;
  const st = rec.aiStatus || "off";
  const chip = ai ? apPill(ai.source === "nano" ? "Gemini Nano" : ai.source === "laya" ? "Laya" : "Built-in AI", "info", ai.model || "")
    : apPill({ queued: "Queued", "not-checked": "Not checked", failed: "Check failed", off: "AI check off" }[st] || "AI check off", st === "failed" ? "warn" : "neutral");
  const sec = atSection("at-ai", "AI check", "", chip);
  sec.dataset.rail = "AI check";
  const lang = (ai && ai.lang) || rec.answerLang || null;
  const facts = el("div", { className: "at-ai-facts" });
  const fact = (k, v, title) => { if (v) facts.append(el("div", { className: "at-ai-fact", ...(title ? { title } : {}) }, el("span", { className: "k" }, k), el("b", { className: "v" }, v))); };
  fact("Language", lang ? aiName("language", lang) : "", ai && ai.lang ? "Read by the AI" : "Chrome’s language detector");
  if (ai && ai.market) {
    const m = ai.market;
    fact("Market", [m.country ? aiName("region", m.country) : "", m.currency || "", m.scope ? AI_LABEL[m.scope === "local" ? "local_scope" : m.scope] : ""].filter(Boolean).join(" · "),
      m.evidence && m.evidence.length ? `From: ${m.evidence.join(", ")}` : "");
  }
  if (ai) {
    fact("What it asks", AI_LABEL[ai.intent] || "");
    fact("Stage", AI_LABEL[ai.funnel] || "");
    fact("For", AI_LABEL[ai.audience] || "");
    fact("Industry", ai.vertical || "");
    if (ai.topics && (ai.topics.en.length || ai.topics.orig.length)) {
      const same = ai.topics.orig.join("|").toLowerCase() === ai.topics.en.join("|").toLowerCase();
      fact("Topics", [ai.topics.en.join(", "), !same && ai.topics.orig.length ? `(${ai.topics.orig.join(", ")})` : ""].filter(Boolean).join(" "));
    }
  }
  if (facts.childNodes.length) sec.append(facts);

  if (!ai) {
    const why = {
      off: "No AI model is on yet. Turn on “Fast labels” in Ask to have each answer’s intent, audience and how it treats each brand labelled, on this computer.",
      queued: "Waiting its turn: answers are checked one at a time, in the background.",
      "not-checked": "Not checked yet: checks for this kind of answer are off in Settings.",
      failed: `The check didn’t finish${rec.aiError ? ` (${rec.aiError})` : ""}.`,
    }[st] || "";
    sec.append(el("p", { className: "ap-muted at-ai-why" }, why));
    if (st === "off") {
      const b = el("button", { className: "at-btn sm", type: "button", id: "atAiTurnOn" }, "Open the switches in Ask");
      b.onclick = () => showTab("ask");
      sec.append(b);
    }
    if (st === "not-checked" || st === "failed") {
      const b = el("button", { className: "at-btn sm", type: "button", id: "atAiCheck" }, "Check with built-in AI");
      b.onclick = async () => { b.disabled = true; b.textContent = "Queued…"; await send({ type: "ai-check-capture", captureId: rec.captureId }); };
      sec.append(b);
    }
    return sec;
  }

  const ents = ai.entities || [];
  if (ents.length) {
    const t = el("table", { className: "at-tbl at-ai-tbl" });
    t.append(el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "What it is"), el("th", {}, "Owner"), el("th", {}, "How the answer treats it"))));
    const tb = el("tbody");
    ents.forEach((e) => tb.append(el("tr", {},
      el("td", {}, el("bdi", {}, e.name)), el("td", {}, AI_LABEL[e.type] || e.type || ""), el("td", {}, e.owner ? el("bdi", {}, e.owner) : el("span", { className: "ap-muted" }, "—")),
      el("td", {}, apPill(AI_LABEL[e.stance] || e.stance || "Mentioned", AI_STANCE_TONE[e.stance] || "neutral"), e.quote ? el("q", { className: "at-ai-q" }, e.quote) : ""))));
    t.append(tb);
    sec.append(el("h3", { className: "at-h3" }, "Brands the rules found, labelled"), el("div", { className: "at-tbl-wrap" }, t));
  }
  const missed = ai.missed || [];
  if (missed.length) {
    const inCounts = (rec.brandMentions || []).some((m) => m.aiAdded);
    sec.append(el("h3", { className: "at-h3" }, "Also found by AI", el("span", { className: "ap-muted" }, inCounts ? " · in your counts" : " · not in your counts")));
    const ul = el("ul", { className: "at-ai-missed" });
    missed.forEach((x) => ul.append(el("li", {}, el("b", {}, el("bdi", {}, x.name)), el("span", { className: "ap-muted" }, ` · ${AI_LABEL[x.type] || x.type}`), x.quote ? el("q", { className: "at-ai-q" }, x.quote) : "")));
    sec.append(ul);
  }
  // What the AI corrected (1.0.0), or would with the setting on.
  const removed = rec.aiRemoved || [];
  const notNames = ents.filter((e) => e.type === "not_a_name");
  if (removed.length) {
    sec.append(el("h3", { className: "at-h3" }, "Corrected by AI", el("span", { className: "ap-muted" }, " · in your counts")));
    const ul = el("ul", { className: "at-ai-missed" });
    removed.forEach((x) => ul.append(el("li", {}, el("b", {}, el("bdi", {}, x.brand)), el("span", { className: "ap-muted" }, " · ", x.why === "not_a_name" ? "not a name, taken out" : fmt("counted under {brand}", { brand: x.into || "" })))));
    sec.append(ul);
  } else if (notNames.length) {
    sec.append(el("h3", { className: "at-h3" }, "Not names, says the AI", el("span", { className: "ap-muted" }, " · still in your counts")));
    const ul = el("ul", { className: "at-ai-missed" });
    notNames.forEach((x) => ul.append(el("li", {}, el("b", {}, el("bdi", {}, x.name)))));
    sec.append(ul, el("p", { className: "ap-muted" }, "Turn on “Let the AI correct brands in counts” in About → Settings → Built-in AI to take them out."));
  }
  if (!ents.length && !missed.length) sec.append(el("p", { className: "ap-muted" }, "The AI found nothing it could back with a quote from the answer."));
  const ch = ai.checks || {};
  const dropped = (ch.dropped || []).length;
  sec.append(el("p", { className: "ap-muted at-foot" }, `Checked by ${ai.model || "the built-in AI"} on this computer, ${new Date(ai.at).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" })}. `,
    dropped ? `${plural(dropped, "claim")} left out because the answer didn’t back ${dropped === 1 ? "it" : "them"}. ` : "Every claim above is backed by the answer. ",
    ch.unreadable ? `${plural(ch.unreadable, "reply", "replies")} couldn’t be read. ` : ""));
  if (dropped) {
    const det = el("details", { className: "at-ai-dropped x-only" }, el("summary", {}, "What was left out"));
    const ul = el("ul");
    ch.dropped.slice(0, 40).forEach((d) => ul.append(el("li", {}, `${d.field}: ${typeof d.value === "string" ? d.value : JSON.stringify(d.value)} — ${d.why}`)));
    det.append(ul);
    sec.append(det);
  }
  return sec;
}

function atAdsSection(rec, { knownBrands }) {
  const ads = adsView(rec, { knownBrands });
  const sec = atSection("at-ads", "Ad shown with the answer", ads.length > 1 ? ads.length : "", apPill("Sponsored", "warn", "Paid placement, not part of the answer"));
  sec.dataset.rail = "Ad shown";
  ads.forEach((a) => sec.append(adCardEl(a, { products: (rec.products || []).length })));
  sec.append(el("p", { className: "ap-muted at-foot" }, "Not captured: clicks, impressions and what the ad cost. Of the engines this tool reads, only ChatGPT shows ads like this."));
  return sec;
}

/* Where it came from (0.60.0, the canvas's lineage): for each brand the
 * answer named, the cited pages that name it, each with where it came in the
 * engine's results and its date when the capture holds them, what the answer
 * said about the brand, and how it is backed; then which sites name which
 * brands. "Backed" is read from the pages' titles and snippets, so the method
 * is stated above the rows. */
function atBackingSection(rec, brands, { own, pages, kind, ctxKinds, knownBrands, products }) {
  const sec = atSection("at-backing", "Where it came from", "", el("span", { className: "ap-muted" }, "search → page found → page read → cited"));
  // How "backed" is counted, not what to make of it (0.59.0).
  sec.append(el("p", { className: "at-backing-lead" }, `A ${kind.id === "local" ? "place" : "brand"} counts as backed by a page when the answer cited that page and the page names it: its own text when it was read, otherwise the title and snippet the engine sent. `,
    el("b", {}, "Independent"), " means any site that isn’t the brand’s own. ",
    el("b", {}, "#N"), rec.platform === "chatgpt" || rec.platform === "perplexity" ? " is where the page came in the engine’s results." : ` is where a page came in the results; ${atEngineLabel(rec.platform)} doesn’t say, so it isn’t shown.`));
  const rows = brands.rows.filter((r) => r.position > 0).sort((a, b) => a.position - b.position);
  rows.forEach((r) => {
    const [label, tone] = AT_VERDICT[r.backing.verdict] || [r.backing.label, r.backing.tone];
    const chips = el("span", { className: "at-backers" });
    r.backing.pages.forEach((p) => {
      const k = p.own ? "Your site" : siteKindOf(p.domain, ctxKinds);
      const meta = [p.pos ? `#${p.pos}` : "", atShortDay(p.date)].filter(Boolean).join(" · ");
      chips.append(el("a", { className: `at-backer${p.own ? " own" : ""}`, href: p.url || "#", target: "_blank", rel: "noreferrer", title: [p.title, p.url].filter(Boolean).join(" — ") },
        el("span", { className: "at-backer-dot", style: `background:var(${AP_KIND_VAR[k] || "--kind-other"})` }),
        p.domain, el("span", { className: "ap-muted" }, ` · ${p.own ? "own site" : atKindOne(k).toLowerCase()}${meta ? ` · ${meta}` : ""}`)));
    });
    if (!r.backing.pages.length) {
      const v = r.backing.verdict;
      chips.append(el("span", { className: "ap-muted" },
        v === "memory" ? "answered without searching"
        : v === "nocited" ? "the answer cited no page"
        : v === "unchecked" ? `not in the titles and snippets ${atEngineLabel(rec.platform)} sent · ${plural(r.backing.citedTotal - r.backing.citedRead, "cited page")} not read`
        : `none of the ${plural(r.backing.citedTotal, "cited page")} names it (pages read)`));
      if (v === "unchecked") chips.append(atReadPagesButton(rec, "Read the cited pages"));
    }
    if (r.backing.readPages.length) chips.append(el("span", { className: "at-glance-warn", title: r.backing.readPages.map((p) => p.domain).join(", ") }, `also named in ${plural(r.backing.readPages.length, "page")} read but not cited`));
    const name = el("button", { className: "at-backing-name", type: "button", "data-focus-brand": r.name, "aria-pressed": "false", title: fmt("Show {brand} in the answer", { brand: r.name }) }, r.name + (r.isYou ? " · you" : ""));
    name.onclick = () => atFocusBrandBtn(r.name);
    // This brand's products, each with the cited pages that name it (0.62.1:
    // what the Products table's "Pages naming it" column showed).
    const mine = products ? products.rows.filter((p) => p.brand && sameBrandUi(p.brand, r.name)) : [];
    const prodLine = mine.length ? el("div", { className: "at-backing-products" }, el("span", { className: "at-eyebrow" }, mine.length === 1 ? "Its product" : `Its products · ${mine.length}`),
      ...mine.map((p) => el("span", { className: "at-backing-product" }, el("b", {}, p.name),
        p.pages.length ? el("span", { className: "ap-muted" }, ` · named on ${p.pages.map(atShortDomain).join(", ")}`) : el("span", { className: "ap-muted" }, " · no cited page names this product")))) : null;
    sec.append(el("div", { className: `at-backing-row${r.isYou ? " mine" : ""}`, "data-brand": r.name },
      el("span", { className: `at-rank${r.position === 1 ? " first" : ""}` }, String(r.position)),
      name,
      el("span", { className: "at-backing-verdict" }, apPill(label, tone)),
      el("span", { className: "at-backing-took" }, r.took.length ? r.took.join(" · ") : ""),
      chips,
      prodLine));
  });
  brands.dropped.forEach((d) => sec.append(el("div", { className: "at-backing-row dropped" }, el("span", { className: "at-rank" }, "–"), el("span", { className: "at-backing-name" }, d.name), el("span", { className: "at-backing-verdict" }, apPill("Not named this time", "neutral")), el("span", { className: "at-backing-took" }, ""), el("span", { className: "ap-muted at-backers" }, `was ${apOrd(d.was)} last time`))));
  // The "What to do" line that closed this section until 0.59.0 is gone: the
  // owner wants the tool to show what the engine did, and leave the reading
  // of it to the person using it. The pages cited without naming your brand
  // are still listed, as a fact.
  const silent = (pages.silent || []);
  if (own && silent.length) sec.append(el("p", { className: "at-backing-silent" }, `Cited without naming ${own.name}: ${silent.join(", ")}`));

  // Which sites name which brands.
  const m = sourceBrandMatrix(rec, { own, knownBrands });
  if (m && m.rows.length) {
    const box = el("div", { className: "at-matrix-box" }, el("h3", { className: "at-h3" }, "Which sources name which brands"));
    const grid = el("div", { className: "at-matrix", role: "table", "aria-label": "Sites against brands", style: `grid-template-columns: minmax(130px, 1.4fr) repeat(${m.brands.length}, minmax(52px, 1fr))` });
    const row = (...cells) => el("div", { className: "at-grid-row", role: "row" }, ...cells);
    grid.append(row(el("span", { role: "columnheader" }, "Site"), ...m.brands.map((b) => el("span", { role: "columnheader", className: `c${b.isYou ? " you" : ""}`, title: b.name }, b.name))));
    m.rows.forEach((r) => grid.append(row(
      el("span", { role: "rowheader", className: "at-matrix-site" }, r.domain,
        el("span", { className: `at-mx-basis b-${r.basis}`, title: r.basis === "snippet" ? "From the titles and snippets the engine sent" : r.basis === "page" ? "From the text of the pages themselves" : "Some pages read, the rest from their snippets" }, r.basis === "page" ? "page text" : r.basis === "mixed" ? "partly read" : "snippet")),
      ...r.cells.map((c, j) => el("span", { role: "cell", className: `at-mx ${c || "none"}`, "aria-label": `${r.domain}, ${m.brands[j].name}: ${tr(c === "cited" ? "cited, names it" : c === "read" ? "read only, names it" : "doesn't name it")}` }, c === "cited" ? "cited" : c === "read" ? "read" : "")))));
    box.append(el("div", { className: "at-scroll" }, grid));
    box.append(el("div", { className: "ap-legend at-mx-legend" },
      el("span", {}, el("i", { className: "at-mx cited" }), "cited, names the brand"), el("span", {}, el("i", { className: "at-mx read" }), "read only, names it"), el("span", {}, el("i", { className: "at-mx none" }), "doesn’t name it"),
      m.more ? el("span", {}, `+ ${m.more} more sites`) : null,
      el("span", { className: "ap-muted" }, m.pagesRead ? "“page text”: found in the page itself; “snippet”: only in what the engine showed" : "From the titles and snippets the engine sent; read the cited pages above for the pages themselves")));
    sec.append(box);
  }
  return sec;
}

function atChangesSection(changes, { engineLabel, previous }) {
  const sec = atSection("at-changes", changes ? `Since ${apDate(changes.at)}` : "Since you last asked this", "", el("span", { className: "ap-muted" }, changes ? "the last answer to this prompt from the same engine" : ""));
  sec.dataset.rail = "Since last time";
  if (changes) {
    const SIGN = { added: "+", dropped: "−", up: "↑", down: "↓", same: "=", site: "↻", ad: "$" };
    const ul = el("ul", { className: "ap-changes" });
    changes.items.forEach((x) => ul.append(el("li", {}, el("span", { className: `ap-sign s-${x.kind}`, "aria-hidden": "true" }, SIGN[x.kind] || "•"), x.text)));
    sec.append(ul);
  } else {
    sec.append(el("p", { className: "ap-note" }, `First time this prompt was captured on ${engineLabel}. Ask it again later and the changes will show here.`));
  }
  return sec;
}

function atBuiltSection(rec, { searches, pages, mentions, kind, engineLabel }) {
  const extra = searches.breadth ? apPill(`${searches.breadth.short} · ${plural(searches.count, "search", "searches")}`, searches.breadth.band === "narrow" ? "warn" : searches.breadth.band === "broad" ? "good" : "neutral", `Breadth: ${searches.breadth.label}`) : null;
  const sec = atSection("at-built", "Searches it ran", "", extra);
  sec.dataset.rail = "Searches it ran";
  // How the answer was built, as four numbers: searched, read, cited, named.
  const steps = el("ol", { className: "at-steps", "aria-label": "How the answer was built" });
  [[searches.unpublished ? "?" : searches.count, "searches it ran"], [rec.sources.length, "pages it read"], [pages.rows.length, "pages it cited"], [mentions.filter((b) => b.count > 0).length, kind.id === "local" ? "places it named" : "brands it named"]]
    .forEach(([v, l]) => steps.append(el("li", {}, el("b", {}, String(v)), el("span", {}, l))));
  sec.append(steps);
  if (searches.count) {
    const lanes = el("div", { className: "at-lanes" });
    [["web", "Web searches", "globe"], ["shopping", "Shopping searches", "cart"], ["image", "Image searches", "image"]].forEach(([lane, label, g]) => {
      const qs = searches.rows.filter((q) => q.lane === lane);
      if (!qs.length) return;
      const col = el("div", { className: "at-lane" }, el("h3", { className: "at-lane-h" }, glyphEl(g, 13), `${label} · ${qs.length}`));
      qs.forEach((q) => col.append(el("span", { className: "at-lane-q" }, el("span", {}, q.text, q.detail ? el("span", { className: "ap-muted at-lane-detail" }, q.detail) : null), q.tag ? el("span", { className: "ap-tag" }, q.tag) : null)));
      lanes.append(col);
    });
    sec.append(lanes);
    const perPage = searches.count ? (rec.sources.length / searches.count).toFixed(1) : "0";
    const yr = searches.rows.filter((q) => /\b20\d\d\b/.test(q.text)).length;
    const rd = searches.rows.filter((q) => /reddit/i.test(q.text)).length;
    sec.append(el("p", { className: "ap-muted at-foot" }, `Average ${searches.avgWords} words per search · ${perPage} pages read per search · ${yr} with a year · ${rd} asking Reddit · ${searches.namingBrand} naming a brand`));
    // site: searches, stated even when there are none.
    const sc = searches.scoped;
    sec.append(el("p", { className: "at-scoped" }, sc.count
      ? `${plural(sc.count, "search", "searches")} limited to a site with site:: ${sc.sites.map((x) => `${x.domain}${x.count > 1 ? ` ×${x.count}` : ""}`).join(", ") || "—"}${sc.excluded.length ? ` · excluded with -site:: ${sc.excluded.map((x) => x.domain).join(", ")}` : ""}`
      : "No search was limited to a site (site:) in this answer."));
    sec.append(el("p", { className: "ap-muted at-foot" }, "Not captured: which search found which page, and how many results each search returned."));
  } else if (searches.unpublished) {
    sec.append(el("p", { className: "ap-note" }, `${engineLabel} confirms it searched the web but doesn't publish what it searched for, so there is no list to show. That's the engine, not a failed capture.`));
  }
  if (searches.opened.length) {
    const box = el("div", { className: "at-opened" }, el("h3", { className: "at-lane-h" }, glyphEl("link", 13), `Opened directly · ${searches.opened.length}`));
    searches.opened.forEach((u) => box.append(el("a", { className: "at-lane-q", href: u, target: "_blank", rel: "noopener noreferrer" }, u)));
    box.append(el("p", { className: "ap-muted at-foot" }, `${engineLabel} went to these addresses itself; they weren't search results.`));
    sec.append(box);
  }
  return sec;
}

function atPartsRows(blocks) {
  return blocks.map((b, i) => el("div", { className: "at-part" },
    el("span", { className: "at-part-head" }, i === 0 ? "Opening" : `Part ${i + 1}`),
    el("span", { className: "at-part-text" }, b.text.length > 160 ? b.text.slice(0, 158) + "…" : b.text),
    el("span", { className: "ap-chips" }, ...(b.cites.length ? b.cites.map((c) => el("span", { className: "at-part-src" }, c)) : [el("span", { className: "at-glance-warn" }, "no page cited for this part")]))));
}

function atDetailsSection(rec, { searches, pages, kind, engineLabel, answerPanel, ctxKinds, mentions, legacyCard = () => null }) {
  const words = rec.answerText ? rec.answerText.trim().split(/\s+/).length : (rec.platformSpecific || {}).wordCount || 0;
  const ex = rec._extraction || {};
  const vg = rec.sources.length && rec.answerText ? computeVerbatimGrounding(rec.answerText, rec.sources) : null;
  const TABS = [
    ["tech", "Technical details"],
    vg ? ["ground", "Grounding check"] : null,
    answerPanel.blocks.length ? ["parts", "Page behind each part"] : null,
    rec.sources.length ? ["pages", "Every page it read"] : null,
    // The detailed cards the earlier layout kept here, after the canvas's
    // four, so nothing it showed is lost: each source's index and kind with
    // filters (inside "Every page it read"), the search breakdown, the
    // brand & page matrix, the model's reasoning and the entities.
    ...[["search", "Search details", "card-fanout"], ["matrix", "Brand & page matrix", "card-omitted-analysis"],
      ["reasoning", "Reasoning", "card-reasoning"], ["entities", "Entities", "card-entities"]].filter(([, , id]) => legacyCard(id)).map(([k, l]) => [k, l]),
    // Expert (0.60.0): the fields the capture read, as data.
    isExpert() ? ["raw", "Raw"] : null,
  ].filter(Boolean);
  const LEGACY = { search: ["card-fanout"], matrix: ["card-omitted-analysis"], reasoning: ["card-reasoning"], entities: ["card-entities"] };
  if (!TABS.some((t) => t[0] === atDetails)) atDetails = "tech";
  const tl = el("div", { className: "at-seg", role: "tablist", "aria-label": "Details" });
  TABS.forEach(([id, label]) => {
    const b = el("button", { className: `at-seg-btn${id === atDetails ? " on" : ""}${id === "raw" ? " x-only" : ""}`, type: "button", role: "tab", "aria-selected": id === atDetails ? "true" : "false" }, label);
    b.onclick = () => { atDetails = id; renderAnalyze(); };
    tl.append(b);
  });
  const sec = atSection("at-details", "Details", "", tl);
  const panel = el("div", { className: "at-det-panel", role: "tabpanel" });
  if (atDetails === "tech") {
    const conv = rec.pageUrl ? String(rec.pageUrl).replace(/^https?:\/\/(www\.)?/, "") : "—";
    const id = String(rec.captureId || "");
    const rows = [
      ["Captured", `${apDate(rec.capturedAt)}, ${apTime(rec.capturedAt)}`],
      ["Engine", `${engineLabel} · ${rec.model || `${engineLabel} default`}`],
      ["Engine's own label", rec.turnUseCase || (rec.platformSpecific || {}).useCase || "—"],
      ["Searched the web", searched(rec) ? `Yes${searches.count ? ` · ${plural(searches.count, "search", "searches")}` : ""}` : "No"],
      ["Kind of answer", kind.label],
      ["Answer length", words ? `${words.toLocaleString()} words` : "not captured"],
      ["Pages read · cited", `${rec.sources.length} · ${pages.rows.length}`],
      ["Products · places · images", `${(rec.products || []).length} · ${(rec.places || []).length} · ${(rec.images || []).length}`],
      ["Read from", ex.usedFallback ? "The page itself (the stream wasn’t readable)" : "Network stream, checked against the page"],
      ["Fallback used", ex.usedFallback ? "Yes" : "No"],
      ["Conversation", conv.length > 34 ? `${conv.slice(0, 22)}…${conv.slice(-6)}` : conv],
      ["Capture id", id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id],
    ];
    const dl = el("dl", { className: "at-tech" });
    rows.forEach(([k, v]) => dl.append(el("div", {}, el("dt", {}, k), el("dd", { title: v }, v))));
    panel.append(dl);
  } else if (atDetails === "ground") {
    panel.append(el("p", { className: "at-det-lead" }, `${vg.groundedClaims} of ${vg.totalClaims} sentences share most of their words with a page it read (${vg.score}%). A sentence with no match isn’t wrong — it just isn’t quoted from a page the capture holds.`));
    vg.claimMatches.slice(0, 10).forEach((c) => panel.append(el("div", { className: "at-claim" }, el("span", {}, `“${c.sentence}”`),
      el("span", { className: c.isGrounded ? "at-claim-ok" : "at-claim-no" }, c.isGrounded ? fmt("Matches {site} ({pct}% of its words)", { site: c.sourceDomain, pct: c.confidence }) : c.sourceDomain ? fmt("No page matches · closest {site} ({pct}%)", { site: c.sourceDomain, pct: c.confidence }) : tr("No page matches")))));
  } else if (atDetails === "parts") {
    atPartsRows(answerPanel.blocks.slice(0, 20)).forEach((r) => panel.append(r));
  } else if (LEGACY[atDetails]) {
    LEGACY[atDetails].forEach((id) => { const c = legacyCard(id); if (c) panel.append(c); });
  } else if (atDetails === "pages" && legacyCard("card-sources")) {
    // The full sources card: which index each came from, its kind, filters,
    // and pages read whose title echoes no search.
    ["card-sources", "card-top-domains"].forEach((id) => { const c = legacyCard(id); if (c) panel.append(c); });
  } else if (atDetails === "pages") {
    const list = el("div", { className: "at-allpages" });
    const fnByUrl = new Map(answerPanel.footnotes.map((f) => [f.source.url, String(f.n)]));
    const rows = [...rec.sources].sort((a, b) => (b.outcome === "cited") - (a.outcome === "cited"));
    rows.forEach((s) => {
      const d = (s.domain || s.url || "").replace(/^www\./, "");
      const n = fnByUrl.get(s.url);
      list.append(el("div", { className: "at-allpage" },
        apPill(s.outcome === "cited" ? (n ? `Cited · ${n}` : "Cited") : "Read only", s.outcome === "cited" ? "good" : "neutral"),
        el("a", { className: "at-allpage-title", href: s.url || "#", target: "_blank", rel: "noreferrer" }, s.title || d || s.url),
        el("span", { className: "ap-muted" }, `${d} · ${siteKindOf(d, ctxKinds).toLowerCase()}`),
        s.url ? el("span", { className: "src-url", title: s.url }, displayUrl(s.url)) : null));
    });
    panel.append(list);
  } else if (atDetails === "raw") {
    const data = rawSummary(rec);
    const json = JSON.stringify(data, null, 2);
    panel.append(el("p", { className: "at-det-lead" }, "What the capture read from the engine’s response, field by field. The full response is in the raw download."),
      el("pre", { className: "at-raw" }, json));
    const copy = el("button", { className: "at-btn sm", type: "button" }, "Copy JSON");
    copy.onclick = async () => { try { await navigator.clipboard.writeText(json); showToast("Copied"); } catch (_) { showToast("Couldn't copy — select the text instead", "error"); } };
    const dl = el("button", { className: "at-btn sm", type: "button" }, "Download raw stream");
    dl.onclick = () => downloadRaw(rec.captureId, "analyze");
    panel.append(el("div", { className: "at-raw-actions" }, copy, dl));
  }
  sec.append(panel);
  return sec;
}
const isExpert = () => document.documentElement.getAttribute("data-detail") === "expert";

/*
 * The raw payload, broken down (0.60.1). Researchers asked for the engine's
 * response itself under the prompt, readable, not as a multi-megabyte
 * download. Expert only and closed by default: nothing is fetched or parsed
 * until it is opened, and each section's rows are only drawn when that
 * section is opened (a Gemini map answer has over a thousand fields).
 * src/lib/rawBreakdown.js does the reading and says why it can't assume a
 * schema. The page edits this block in place rather than re-rendering, so
 * opening it never moves the page.
 */
const RAW_CACHE = new Map(); // captureId → breakdown (the last few)
let atRawOpen = false;
function atRawPanel(rec, engineLabel) {
  const box = el("details", { className: "at-rawx x-only", id: "at-rawx" });
  if (atRawOpen) box.open = true;
  const meta = el("span", { className: "ap-muted at-rawx-meta" }, "the engine’s response, field by field");
  box.append(el("summary", { className: "at-rawx-sum" }, el("b", {}, "Raw payload breakdown"), el("span", { className: "at-chip" }, "Expert"), meta));
  const body = el("div", { className: "at-rawx-body" });
  box.append(body);
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    let b = RAW_CACHE.get(rec.captureId);
    if (!b) {
      body.append(el("p", { className: "ap-muted" }, "Reading the raw response…"));
      const r = await send({ type: "get-raw", captureId: rec.captureId });
      if (!r || !r.ok || r.raw == null) {
        body.replaceChildren(el("p", { className: "ap-muted" }, "No raw response is stored for this capture (sample data, or a capture too large to keep)."));
        return;
      }
      await new Promise((res) => setTimeout(res, 0));
      b = rawBreakdown(r.raw, { reqBody: r.meta && r.meta.reqBody });
      b.interactions = r.interactions || [];
      RAW_CACHE.set(rec.captureId, b);
      if (RAW_CACHE.size > 4) RAW_CACHE.delete(RAW_CACHE.keys().next().value);
    }
    meta.textContent = `${b.format} · ${atBytes(b.bytes)} · ${b.frames} frames · ${b.fieldCount} fields in ${b.sections.length} sections`;
    body.replaceChildren(...atRawBody(b, rec, engineLabel));
  };
  box.addEventListener("toggle", () => { atRawOpen = box.open; if (box.open) start(); });
  if (atRawOpen) start();
  return box;
}
function atBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`; }
function atRawBody(b, rec, engineLabel) {
  const out = [];
  const facts = el("div", { className: "at-rawx-facts" });
  facts.append(el("span", {}, el("b", {}, "Framing "), b.format));
  if (b.events.length) facts.append(el("span", {}, el("b", {}, "Events "), b.events.map((e) => `${e.event} ×${e.count}`).join(" · ")));
  if (b.truncated) facts.append(el("span", { className: "at-rawx-warn" }, `Only the first ${b.fieldCount} distinct fields are listed; the download has everything.`));
  out.push(facts);
  if (b.objectTypes.length) {
    const types = el("div", { className: "at-rawx-types", "aria-label": "Kinds of object in the response" });
    b.objectTypes.slice(0, 40).forEach((t) => types.append(el("span", { className: "at-page-chip", title: `first seen at ${t.at}` }, `${t.type} ×${t.count}`)));
    out.push(el("div", { className: "at-rawx-row" }, el("span", { className: "at-eyebrow" }, "Objects by type"), types));
  }
  b.sections.forEach((sec) => out.push(atRawSection(sec, b, rec, engineLabel)));
  // What ChatGPT loaded after the answer (0.62.0), each reply in full.
  if ((b.interactions || []).length) {
    const d = el("details", { className: "at-rawx-sec sec-interactions", "data-section": "interactions" });
    d.append(el("summary", {}, el("b", {}, "Loaded after the answer"), el("span", { className: "n" }, String(b.interactions.length)), el("span", { className: "ap-muted" }, "replies ChatGPT fetched later in this conversation, e.g. a product card’s stores")));
    b.interactions.forEach((x) => {
      let pretty = x.body;
      try { pretty = JSON.stringify(JSON.parse(x.body), null, 2); } catch (_) { /* keep as sent */ }
      const row = el("div", { className: "at-rawx-full" },
        el("div", { className: "at-rawx-full-h" }, el("code", {}, x.path), el("span", { className: "ap-muted" }, `${x.status} · ${apTime(x.at)}`)),
        el("pre", {}, pretty.slice(0, 200000)));
      d.append(row);
    });
    out.push(d);
  }
  const json = () => JSON.stringify(b, null, 2);
  const copy = el("button", { className: "at-btn sm", type: "button" }, "Copy the breakdown");
  copy.onclick = async () => { try { await navigator.clipboard.writeText(json()); showToast("Copied"); } catch (_) { showToast("Couldn't copy", "error"); } };
  const dlB = el("button", { className: "at-btn sm", type: "button" }, "Download the breakdown");
  dlB.onclick = () => download(`citoskeleton-raw-breakdown-${rec.captureId}.json`, json(), "application/json");
  const dlR = el("button", { className: "at-btn sm", type: "button" }, "Download the raw stream");
  dlR.onclick = () => downloadRaw(rec.captureId, "analyze");
  out.push(el("div", { className: "at-raw-actions" }, copy, dlB, dlR));
  return out;
}
function atRawSection(sec, b, rec, engineLabel) {
  const d = el("details", { className: `at-rawx-sec sec-${sec.id}`, "data-section": sec.id });
  d.append(el("summary", {}, el("b", {}, sec.label), el("span", { className: "n" }, String(sec.fields.length)), el("span", { className: "ap-muted" }, sec.note)));
  // Fields no rule knows (0.78.0, asked: "will the tool ignore it and not
  // include it in the raw data breakdown?"). Nothing is dropped: they're
  // here, open by default, and the section says what wasn't listed and why.
  if (sec.id === "other") {
    const notes = [];
    if (sec.emptyFields) notes.push(`${plural(sec.emptyFields, "empty field")} not listed`);
    if (b.truncated) notes.push(`fields past the first ${b.fieldCount.toLocaleString()} weren’t listed here; Download the raw stream has everything`);
    if (notes.length) d.append(el("p", { className: "at-rawx-note ap-muted", role: "note" }, `${notes.join(" · ")}.`));
  }
  let drawn = false;
  d.addEventListener("toggle", () => {
    if (!d.open || drawn) return;
    drawn = true;
    // Rows grouped under the object they sit in, so a hundred user-agent
    // flags read as one group, not a hundred lines.
    const groups = new Map();
    sec.fields.forEach((f) => {
      const at = f.path.lastIndexOf(".");
      const parent = at > 0 ? f.path.slice(0, at) : "";
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(f);
    });
    const list = el("div", { className: "at-rawx-list", role: "table", "aria-label": sec.label });
    for (const [parent, fields] of groups) {
      if (parent) list.append(el("div", { className: "at-rawx-group", role: "row" }, el("span", { role: "cell", title: parent }, parent), el("span", { role: "cell", className: "ap-muted" }, plural(fields.length, "field"))));
      fields.forEach((f) => {
        const leaf = parent ? f.path.slice(parent.length + 1) : f.path;
        const show = (x) => (typeof x === "string" ? JSON.stringify(x) : String(x));
        const first = f.samples.length ? show(f.samples[0]) : "—";
        const more = f.samples.length - 1;
        // Values wrap to three lines; "Show all" opens every distinct value
        // in full, the longest one and, for streamed text, the pieces put
        // back together (reported: queries were cut off).
        const cell = el("span", { role: "cell", className: "at-rawx-sample" }, el("span", { className: "at-rawx-val" }, first));
        const full = f.joined || f.longest || f.samples.some((x) => typeof x === "string" && x.length > 160) || more > 0;
        if (full) {
          const btn = el("button", { className: "ap-link at-rawx-more", type: "button", "aria-expanded": "false" },
            more > 0 ? `Show all ${f.distinct > f.samples.length ? `${f.samples.length} of ${f.distinct}` : f.samples.length} values` : "Show all");
          btn.onclick = () => {
            const open = btn.getAttribute("aria-expanded") === "true";
            btn.setAttribute("aria-expanded", open ? "false" : "true");
            btn.textContent = open ? (more > 0 ? `Show all ${f.samples.length} values` : "Show all") : "Show less";
            const prev = row.querySelector(".at-rawx-full");
            if (open) { prev && prev.remove(); return; }
            const box = el("div", { className: "at-rawx-full", role: "cell" });
            const add = (label, text) => {
              const pre = el("pre", {}, text);
              const copy = el("button", { className: "at-btn sm", type: "button" }, "Copy");
              copy.onclick = async () => { try { await navigator.clipboard.writeText(text); showToast("Copied"); } catch (_) { showToast("Couldn't copy", "error"); } };
              box.append(el("div", { className: "at-rawx-full-h" }, el("span", { className: "ap-muted" }, label), copy), pre);
            };
            if (f.joined) add(`The streamed pieces put together · ${f.joined.length.toLocaleString()} characters`, f.joined);
            if (f.longest) add(`Longest value · ${f.longest.length.toLocaleString()} characters`, f.longest);
            add(f.samples.length > 1 ? `${f.samples.length} distinct values${f.distinct > f.samples.length ? ` (first ${f.samples.length} of ${f.distinct})` : ""}` : "Value", f.samples.map(show).join("\n"));
            row.append(box);
          };
          cell.append(btn);
        }
        const row = el("div", { className: "at-rawx-field", role: "row", "data-path": f.path },
          el("code", { role: "cell", title: f.path }, leaf),
          el("span", { role: "cell", className: "ap-muted" }, `×${f.count}`, f.ops.length ? ` · ${f.ops.join("/")}` : "", ` · ${f.kinds.join("/")}`),
          cell);
        list.append(row);
      });
    }
    d.append(list);
    if (sec.emptyFields) d.append(el("p", { className: "ap-muted" }, `${plural(sec.emptyFields, "more field")} never held a value in this response.`));
    if (sec.id === "other" && sec.fields.length) d.append(atRawLabeller(sec, list, rec, engineLabel));
    const copy = el("button", { className: "at-btn sm", type: "button" }, "Copy this section");
    copy.onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(sec, null, 2)); showToast("Copied"); } catch (_) { showToast("Couldn't copy", "error"); } };
    d.append(el("div", { className: "at-raw-actions" }, copy));
  });
  if (sec.id === "other" && sec.fields.length) d.open = true;
  return d;
}
// Names for what no rule knows, from the on-device model when Chrome has it.
// Only asked for on a click, and every label is marked as a guess.
function atRawLabeller(sec, list, rec, engineLabel) {
  const wrap = el("div", { className: "at-rawx-ai" });
  const btn = el("button", { className: "at-btn sm", type: "button" }, "Suggest labels with on-device AI");
  const note = el("span", { className: "ap-muted" }, "Runs in Chrome on this computer; nothing is sent anywhere. Labels are guesses.");
  btn.onclick = async () => {
    btn.disabled = true;
    if (!(await isNanoAvailable())) { note.textContent = "Chrome’s on-device model isn’t available in this browser, so there are no suggestions. The samples beside each field are what it holds."; return; }
    note.textContent = "Asking the on-device model…";
    const ask = sec.fields.slice(0, 40).map((f) => ({ path: f.path, sample: f.longest || f.samples[0] }));
    const labels = await labelRawFieldsWithNano(ask, engineLabel);
    if (!labels || !labels.length) { note.textContent = "The on-device model gave no usable labels."; btn.disabled = false; return; }
    const secLabel = new Map(RAW_SECTIONS.map((s) => [s.id, s.label]));
    labels.forEach((l) => {
      const row = [...list.querySelectorAll(".at-rawx-field")].find((r) => r.dataset.path === l.path);
      if (row) row.append(el("span", { className: "at-rawx-guess", title: "Suggested by Chrome’s on-device model — a guess" }, `AI guess: ${l.label}${l.section !== "other" ? ` · ${secLabel.get(l.section)}` : ""}`));
    });
    note.textContent = `${plural(labels.length, "label")} suggested for the first ${ask.length} fields. Guesses, not readings.`;
  };
  wrap.append(btn, note);
  return wrap;
}
// The fields a capture holds, for the Expert "Raw" tab: ids, the engine's own
// labels and refs as it sent them. Not the answer text or the stream itself.
function rawSummary(rec) {
  const ps = rec.platformSpecific || {};
  const q = (k) => ((rec.fanout && rec.fanout[k]) || []).map((x) => (typeof x === "string" ? x : x && x.query)).filter(Boolean);
  return {
    platform: rec.platform, model: rec.model || null, turnUseCase: rec.turnUseCase || ps.useCase || null,
    searched: !!rec.searched, capturedAt: new Date(rec.capturedAt).toISOString(),
    searches: { web: q("search"), shopping: q("shopping"), image: q("image") },
    referenceTypes: rec.referenceTypes || null,
    sources: (rec.sources || []).map((s) => ({
      url: s.url, outcome: s.outcome, type: s.type || null,
      refs: (s.platformSpecific && s.platformSpecific.markerIds) || undefined,
      refType: (s.platformSpecific && s.platformSpecific.refType) || undefined,
      pipeline: (s.platformSpecific && s.platformSpecific.pipeline) || undefined,
      pubDate: (s.platformSpecific && s.platformSpecific.pubDate) || undefined,
    })),
    products: (rec.products || []).map((p) => ({ name: p.name, price: p.price || null, merchant: p.merchant || null, supplier: p.supplier || null, cite: p.cite || null })),
    places: (rec.places || []).map((p) => ({ name: p.name, supplier: p.supplier || null, rating: p.rating ?? null })),
    images: (rec.images || []).length,
    ads: (rec.ads || []).map((a) => ({ advertiser: a.advertiser || null, format: a.format || null, unit: a.unit || null, placement: a.placement || null, targetDomain: a.targetDomain || null })),
    conversationId: rec.conversationId || null, captureId: rec.captureId,
  };
}
const searched = (rec) => !!(rec.searched || (rec.sources || []).length);
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

/*
 * Put the captured picture into a thumbnail box.
 *
 * Reported (0.58.0): product cards in the full tab "just present a colour
 * around them". They were never given the picture: every thumbnail was a
 * gradient picked from the brand name with a cart icon on it, while the popup
 * showed the same images. The box keeps its icon underneath; the picture covers
 * it once it has loaded. If the engine's copy won't load, the original it was
 * made from is tried (an images.openai.com thumbnail encodes it, see
 * src/lib/image-url.js), and only then does the box stay an icon on a plain,
 * colourless ground. No referrer: the extension's address means nothing to an
 * image host and only gives it a reason to refuse.
 */
function withImage(box, url, alt) {
  box.classList.add("img-box");
  if (!url) { box.classList.add("img-missing"); return box; }
  const img = el("img", { alt: alt || "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" });
  let retried = false;
  img.onload = () => box.classList.add("img-loaded");
  img.onerror = async () => {
    const orig = retried ? null : await originalImageUrl(url);
    retried = true;
    if (orig && orig !== img.src) img.src = orig;
    else { img.remove(); box.classList.add("img-missing"); }
  };
  img.src = url;
  box.append(img);
  return box;
}

/*
 * Every site the answer used, one expandable row each (domainsView).
 *
 * Reported (0.58.0): the cited domains and URLs had all but disappeared —
 * the at-a-glance column showed five pages and "+ 6 pages read but not
 * cited", the popup a list of cited domains and the rest on one line. This
 * lists every site, cited ones first, each opening to every page the engine
 * read there with its full title and address. Cited sites start open: they
 * are the answer's evidence. A cited page's number is the one in the answer,
 * and clicking it highlights that citation where the answer shows it.
 */
function sitesListEl(dv, { fnByUrl = new Map(), openCited = false, onCite = null, info = null } = {}) {
  const list = el("div", { className: "site-list" });
  dv.rows.forEach((d, i) => {
    const extra = info ? info(d) : null;
    const row = el("details", { className: `site-row${d.cited ? " is-cited" : ""}${d.kind === "Your site" ? " mine" : ""}`, "data-status": extra ? extra.status : d.cited ? "cited" : "read" });
    if (openCited && d.cited) row.open = true;
    const bar = el("span", { className: "site-bar", title: `${d.cited} cited · ${d.read} read, not cited` },
      el("span", { className: "c", style: `width:${(d.cited / dv.maxPages) * 100}%` }),
      el("span", { className: "r", style: `width:${(d.read / dv.maxPages) * 100}%` }));
    const counts = [d.cited ? `${d.cited} cited` : "", d.read ? `${d.read} read` : ""].filter(Boolean).join(" · ");
    row.append(el("summary", { className: "site-head" },
      el("span", { className: "site-rank" }, String(i + 1)),
      el("span", { className: "site-name" },
        el("b", {}, d.domain),
        d.trusted ? el("span", { className: "site-pill", title: "Perplexity marks this site as trusted" }, "✓ Trusted") : null,
        el("span", { className: "site-kind" }, el("i", { style: `background:var(${AP_KIND_VAR[d.kind] || "--kind-other"})` }), d.kind,
          extra && extra.pos ? el("span", { className: "site-pos", title: "Its best place in the engine's results" }, ` · #${extra.pos}`) : null),
        extra && extra.names.length ? el("span", { className: "site-names", title: "Brands its pages name, in their titles or snippets" }, `names ${atList(extra.names.slice(0, 3))}${extra.names.length > 3 ? ` +${extra.names.length - 3}` : ""}`) : null),
      bar,
      el("span", { className: "site-counts" }, counts, extra && extra.status === "silent" ? el("span", { className: "site-silent" }, extra.silentLabel) : null),
      el("span", { className: "site-chev", "aria-hidden": "true" }, "▸")));
    const ul = el("ul", { className: "site-pages" });
    d.pages.forEach((pg) => {
      const n = pg.cited ? (fnByUrl.get(pg.url) || null) : null;
      const pill = pg.cited
        ? el("button", { className: "site-pill cited", type: "button", "data-focus-cite": n || "", "aria-pressed": "false", disabled: !(n && onCite), title: n && onCite ? "Show this citation in the answer" : "Cited in the answer" }, n ? `Cited · ${n}` : "Cited")
        : el("span", { className: "site-pill" }, "Read only");
      if (n && onCite) pill.onclick = () => onCite(n);
      const meta = extra && extra.pageMeta ? extra.pageMeta(pg) : null;
      ul.append(el("li", {}, pill,
        el("span", { className: "site-page" },
          el("a", { href: pg.url || "#", target: "_blank", rel: "noreferrer", title: pg.url }, pg.title || displayUrl(pg.url) || d.domain),
          pg.url ? el("span", { className: "src-url" }, displayUrl(pg.url)) : null,
          meta && meta.text ? el("span", { className: "site-page-meta" }, meta.text) : null,
          meta && meta.expert ? el("span", { className: "site-page-meta x-only" }, meta.expert) : null)));
    });
    // Hidden outright while closed: Chrome still lays out a closed
    // <details>'s content, so it measured as spilling past its section.
    ul.hidden = !row.open;
    row.addEventListener("toggle", () => { ul.hidden = !row.open; });
    row.append(ul);
    list.append(row);
  });
  return list;
}

/* Every site it read (0.60.0): every domain, cited first, each opening to
 * every page the engine read there (0.58.0), now with what the canvas adds:
 * the kinds of site it cited as one bar, where each site came in the
 * engine's results, the brands its pages name, and filters for cited, read
 * only and cited without naming your brand. In Expert, each page's index and
 * ref as the engine sent them. */
// What reading one cited page found (0.62.0): "page read · 2,340 words, names
// Samsung, HONOR", or why it couldn't be read.
const PAGE_FAIL = { blocked: "a bot check stood in the way", thin: "too little text to be the page", failed: "couldn’t be fetched", "not-html": "not a web page", "too-large": "too large to read" };
function atPageLine(pg) {
  if (!pg) return "";
  if (pg.status !== "ok") return `page not read: ${PAGE_FAIL[pg.status] || pg.status}${pg.httpStatus && pg.httpStatus >= 400 ? ` (${pg.httpStatus})` : ""}`;
  const names = (pg.brands || []).slice(0, 3).map((b) => b.brand);
  return `page read · ${(pg.words || 0).toLocaleString()} words${pg.method === "tab" ? " (in a hidden tab)" : ""}${names.length ? ` · names ${names.join(", ")}${pg.brands.length > 3 ? ` +${pg.brands.length - 3}` : ""}` : " · names none of the brands"}`;
}
// The bar at the top of "Every site it read": how many cited pages were read,
// and a button to read them now (asking for site access first if needed).
// The same "Read the cited pages" action as the bar in "Every site it read".
function atReadPagesButton(rec, text) {
  const btn = el("button", { className: "at-btn sm at-read-inline", type: "button" }, text);
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (chrome.permissions && !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    } catch (_) { /* reading still tries; pages that refuse say so */ }
    btn.textContent = "Reading…";
    const r = await send({ type: "read-cited-pages", captureId: rec.captureId, force: false });
    if (!r || !r.ok) { btn.textContent = "Couldn’t read them"; btn.disabled = false; return; }
    FULL.delete(rec.captureId);
    await hydrate(rec.captureId);
    renderAnalyze();
  };
  return btn;
}
const sameBrandUi = (a, b) => atNorm(a) === atNorm(b) || atNorm(a).startsWith(atNorm(b) + " ") || atNorm(b).startsWith(atNorm(a) + " ");

function atPagesBar(rec) {
  const pr = rec.pagesRead;
  const cited = new Set((rec.sources || []).filter((x) => x.outcome === "cited" && x.url).map((x) => x.url.replace(/#.*$/, ""))).size;
  if (!cited) return null;
  const bar = el("div", { className: "at-pages-bar" });
  const line = el("span", {}, pr
    ? `Cited pages read: ${pr.read} of ${Math.min(cited, 15)}. Brands below come from the page text where a page was read, otherwise from the title and snippet the engine sent.`
    : "Brands below come from the title and snippet the engine sent with each result. Read the cited pages to check what each page itself says.");
  const btn = el("button", { className: "at-btn sm", type: "button" }, pr ? "Read them again" : "Read the cited pages");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (chrome.permissions && !(await chrome.permissions.contains({ origins: ["<all_urls>"] }))) await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    } catch (_) { /* reading still tries; pages that refuse say so */ }
    btn.textContent = "Reading…";
    const r = await send({ type: "read-cited-pages", captureId: rec.captureId, force: !!pr });
    if (!r || !r.ok) { btn.textContent = "Couldn’t read them"; btn.disabled = false; return; }
    FULL.delete(rec.captureId);
    await hydrate(rec.captureId);
    renderAnalyze();
  };
  bar.append(line, btn);
  return bar;
}

function atSitesSection(rec, dv, { fnByUrl, pages, own, ctxKinds, positions, knownBrands }) {
  const sec = atSection("at-sites", "Every site it read", "",
    el("span", { className: "ap-chips" },
      apPill(`${dv.citedSites} cited`, "good", "Sites with at least one page the answer cites"),
      dv.readOnlySites ? apPill(`${dv.readOnlySites} read, not cited`, "neutral", "Sites the engine opened but didn’t cite") : null));
  sec.dataset.rail = "Every site it read";
  const pagesBar = atPagesBar(rec);
  if (pagesBar) sec.append(pagesBar);
  // Which index served each page (labrador, bright, oxylabs, serp) is asked
  // for often. ChatGPT sent it only from 21 May to 21 July 2026; said plainly
  // in Expert rather than leaving a blank column. A capture that does carry
  // it shows it on each page (pageMeta, below).
  if (rec.platform === "chatgpt" && (rec.sources || []).length && !(rec.sources || []).some((x) => x.platformSpecific && x.platformSpecific.pipeline)) {
    sec.append(el("p", { className: "at-sites-note x-only" }, "Which index served each page: not sent. ChatGPT hasn’t sent it (labrador, bright, oxylabs, serp) since 21 July 2026."));
  }
  // Cited pages by kind of site, as one bar.
  if (pages.kinds.length) {
    const bar = el("div", { className: "ap-kindbar at-kindbar", role: "img", "aria-label": `${tr("Cited pages by kind")}: ` + pages.kinds.map((k) => `${k.n} ${tr(k.label).toLowerCase()}`).join(", ") });
    pages.kinds.forEach((k) => bar.append(el("span", { title: `${k.label} · ${k.n}`, style: `flex:${k.n} 1 0; background:var(${AP_KIND_VAR[k.label]})` })));
    const legend = el("div", { className: "ap-legend" }, el("span", { className: "ap-muted" }, "Cited pages by kind:"));
    pages.kinds.forEach((k) => legend.append(el("span", {}, el("i", { style: `background:var(${AP_KIND_VAR[k.label]})` }), `${tr(k.label)} · ${k.n}`)));
    sec.append(bar, legend);
  }
  // The brands each site's pages name, from their titles and snippets.
  const brands = new Set(ctxKinds.brands.map((b) => b.toLowerCase()));
  const present = new Map((computeBrandMatrix(rec).sources || []).map((x) => [x.sourceIdx, x.presentBrands]));
  const namesBy = new Map();
  rec.sources.forEach((src, i) => {
    const d = normDomainLabel(src.domain || src.url).toLowerCase();
    const set = namesBy.get(d) || new Set();
    (present.get(i) || []).forEach((n) => { const hit = ctxKinds.brands.find((b) => b.toLowerCase() === String(n).toLowerCase()); if (hit && brands.has(hit.toLowerCase())) set.add(hit); });
    namesBy.set(d, set);
  });
  const silent = new Set(pages.silent || []);
  const srcBy = new Map(rec.sources.map((x) => [x.url, x]));
  const info = (d) => {
    const ps = d.pages.map((pg) => positions.get(pg.url)).filter(Boolean);
    return {
      pos: ps.length ? Math.min(...ps) : null,
      names: [...(namesBy.get(d.domain.toLowerCase()) || [])],
      status: d.cited ? (own && silent.has(d.domain) ? "silent" : "cited") : "read",
      silentLabel: own ? `silent on ${own.name}` : "",
      pageMeta: (pg) => {
        const x = srcBy.get(pg.url) || {};
        const xp = x.platformSpecific || {};
        const date = xp.pubDate ? atShortDay(xp.pubDate < 1e12 ? xp.pubDate * 1000 : xp.pubDate) : "";
        const pos = positions.get(pg.url);
        return {
          text: [pos ? `#${pos} in its results` : "", date, atPageLine(xp.page)].filter(Boolean).join(" · "),
          expert: [xp.pipeline, xp.refType, (xp.markerIds || []).join(" ")].filter(Boolean).join(" · "),
        };
      },
    };
  };
  const counts = { all: dv.rows.length, cited: dv.citedSites, read: dv.readOnlySites, silent: own ? dv.rows.filter((d) => d.cited && silent.has(d.domain)).length : 0 };
  const filters = el("div", { className: "at-filters", role: "group", "aria-label": "Show" });
  const list = sitesListEl(dv, { fnByUrl, openCited: true, onCite: atFocusCiteBtn, info });
  const apply = () => {
    list.querySelectorAll(".site-row").forEach((r) => {
      const st = r.dataset.status;
      r.hidden = !(atSiteFilter === "all" || st === atSiteFilter || (atSiteFilter === "cited" && st === "silent"));
    });
    filters.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === atSiteFilter)));
  };
  [["all", `All ${counts.all}`], ["cited", `Cited ${counts.cited}`], ["read", `Read only ${counts.read}`], own && counts.silent ? ["silent", `Cited, silent on ${own.name} ${counts.silent}`] : null].filter(Boolean)
    .forEach(([f, label]) => {
      const b = el("button", { className: "at-filter", type: "button", "data-f": f, "aria-pressed": "false" }, label);
      b.onclick = () => { atSiteFilter = f; apply(); };
      filters.append(b);
    });
  sec.append(filters, el("p", { className: "ap-muted at-sites-lead" }, "Cited sites first. Open one for every page the engine read there; a cited page's number is its citation in the answer."), list);
  apply();
  return sec;
}

/* Products and where to buy (0.60.0, the canvas's product table): each card
 * in carousel order with its picture, price and rating, the cited pages that
 * name it, and the stores it lists in the order it lists them (the brand's
 * own store marked). Then where the cards send buyers first, and what the
 * capture doesn't hold: each store's own price. */
// ChatGPT's answer cards for companies (insurers, banks, coworking spaces)
// carry no price, seller or offers: they are the answer's picks, and were
// listed under "Products and where to buy" (1.0.2).
function atCardsArePicks(rec) {
  const ps = (rec.products || []).filter(Boolean);
  return ps.length > 0 && ps.every((p) => p.renderAs === "answer-card" && !p.price && !p.merchant && !(p.offers || []).length);
}

function atProductsSection(rec, pv, { engineLabel, own }) {
  const picks = atCardsArePicks(rec);
  const title = picks ? "Picks in the answer" : "Products and where to buy";
  const sec = atSection("at-products", title, pv.rows.length, el("span", { className: "ap-muted" }, `in the order ${engineLabel} showed them`));
  sec.classList.add("at-products-sec");
  sec.dataset.rail = title;
  const table = el("div", { className: "at-prod-table", role: "table", "aria-labelledby": "at-products-h" });
  table.append(el("div", { className: "at-prod-row at-th", role: "row" }, ...["#", picks ? "Pick" : "Product", "Price", "Rating", "Brand", picks ? "Listing" : "Where to buy"].map((h) => el("span", { role: "columnheader" }, h))));
  pv.rows.forEach((r, i) => {
    const p = rec.products[i] || {};
    const imgHost = atProxied(r.image) ? "the engine’s copy" : atHost(r.image);
    const sup = supplierOf(p.supplier);
    const stores = el("span", { role: "cell", className: "at-prod-stores" });
    // The stores ChatGPT listed when the card was opened (0.62.0): each with
    // its price and link, in ChatGPT's order. Without that, the stores the
    // answer stream names ("Motorola India + others").
    if ((p.offers || []).length) {
      p.offers.forEach((o, j) => stores.append(el(o.url ? "a" : "span", { className: `at-store-chip at-offer${o.tag ? " tagged" : ""}`, ...(o.url ? { href: o.url, target: "_blank", rel: "noopener noreferrer" } : {}), title: [o.tag, o.availability, o.delivery].filter(Boolean).join(" · ") }, el("b", {}, String(j + 1)), ` ${o.merchant}`, o.price ? el("span", { className: "at-offer-price" }, ` ${o.price}`) : null, o.tag ? el("span", { className: "at-offer-tag" }, o.tag) : null)));
      stores.append(el("span", { className: "ap-muted at-offer-note" }, "as listed when the card was opened"));
    } else {
    r.stores.forEach((st, j) => stores.append(el("span", { className: `at-store-chip${st.own ? " own" : ""}`, title: st.own ? `${r.brand}’s own store` : "" }, el("b", {}, String(j + 1)), ` ${st.name}`)));
    if (r.otherStores) stores.append(el("span", { className: "ap-muted" }, "+ others"));
    // A card ChatGPT drew in the answer without a shopping listing behind it
    // (generative-UI answers) names no store by design.
    if (!r.stores.length) stores.append(el("span", { className: "ap-muted" }, p.listing === false ? "a card in the answer · no shopping listing" : "no store named"));
    if (rec.platform === "chatgpt" && p.listing !== false) stores.append(el("span", { className: "ap-muted at-offer-note" }, "open this card on ChatGPT to record every store"));
    }
    // The pages naming a product are listed under its brand in "Where it
    // came from" (0.62.1, asked: the two said the same thing); here the
    // brand links there.
    const brandCell = el("span", { role: "cell", className: "at-prod-brand" });
    if (r.brand) {
      const go = el("button", { className: "at-brand-link", type: "button", title: `What backs ${r.brand}, in "Where it came from"` }, r.brand, el("span", { "aria-hidden": "true" }, " ↓"));
      go.onclick = () => atJumpToBrand(r.brand);
      brandCell.append(go);
    } else brandCell.append(el("span", { className: "ap-muted" }, "—"));
    const op = p.opened || null;
    table.append(el("div", { className: `at-prod-row${r.isYou ? " mine" : ""}`, role: "row" },
      el("span", { role: "cell", className: "ap-muted" }, String(r.n)),
      el("span", { role: "cell", className: "at-prod-name" },
        withImage(el("span", { className: "at-thumb" }, glyphEl("cart", 18)), r.image, r.name),
        el("span", { className: "at-prod-text" },
          el("b", {}, r.name || "—"),
          el("span", { className: r.isYou ? "at-mine-sub" : "ap-muted" }, [r.isYou ? `${r.brand} · your brand` : r.brand, imgHost ? `image from ${imgHost}` : ""].filter(Boolean).join(" · ")),
          sup ? el("span", { className: "ap-muted x-only", title: sup.note || "" }, `listing feed: ${sup.code}`) : null)),
      el("span", { role: "cell" }, r.price || (op && op.price) || "—"),
      el("span", { role: "cell" }, (r.rating ?? (op && op.rating)) != null ? `★ ${r.rating ?? op.rating}` : "—", (r.reviews || (op && op.reviews)) ? el("span", { className: "ap-muted" }, ` (${atCompact(r.reviews || op.reviews)})`) : null),
      brandCell,
      stores));
    const more = atOpenedCard(p, engineLabel);
    if (more) table.append(more);
  });
  sec.append(el("div", { className: "at-scroll" }, table));
  const facts = el("div", { className: "at-prod-facts" });
  if (pv.firstStores.length) {
    const total = pv.firstStores.reduce((t, x) => t + x.n, 0);
    const bar = el("div", { className: "at-store-bar", role: "img", "aria-label": "First store on each card: " + pv.firstStores.map((x) => `${x.name} ${x.n}`).join(", ") });
    pv.firstStores.forEach((x) => bar.append(el("span", { className: x.own ? "own" : "", style: `flex:${x.n} 1 0; --h:${atHue(x.name)}`, title: `${x.name} · ${x.n}` })));
    facts.append(el("div", { className: "at-fact" }, el("span", { className: "at-eyebrow" }, "First store on each card"), bar,
      el("span", { className: "ap-muted" }, pv.firstStores.map((x) => `${x.name} ${x.n}${x.own ? " (brand’s own)" : ""}`).join(" · ") + ` · ${total} of ${pv.rows.length} cards name a store`)));
  }
  const opened = (rec.products || []).filter((x) => x.opened || x.panel).length;
  facts.append(el("div", { className: "at-fact" }, el("span", { className: "at-eyebrow" }, opened ? "Opened on ChatGPT" : "Not captured"),
    el("span", {}, opened
      ? `${opened} of ${pv.rows.length} cards were opened on ${engineLabel}: their stores, each store’s price, and why ${engineLabel} recommends them are recorded below each card.`
      : rec.platform === "chatgpt"
        ? "Each store’s own price and why ChatGPT recommends a card load only when the card is opened on ChatGPT. Open a card there and it appears here."
        : "Each store’s own price. The capture keeps the card’s price and the stores it names, in its order.")));
  sec.append(facts);
  return sec;
}
// What opening a card on ChatGPT loaded (0.62.1): the product its lookup
// returned (which can differ from the card), why ChatGPT recommends it, what
// reviews say, and the pages behind that panel. One row under the card.
function atOpenedCard(p, engineLabel) {
  const op = p.opened, pn = p.panel;
  if (!op && !pn) return null;
  const box = el("div", { className: "at-prod-more", role: "row" });
  const cell = el("div", { role: "cell", className: "at-prod-more-in" });
  box.append(cell);
  // The lookup can return something other than the card: in the owner's
  // recording, opening "OnePlus Nord Buds 4 Pro" returned a silicone case
  // for it. Said when the title doesn't start with the card's name, or names
  // an accessory the card doesn't.
  const ACCESSORY = /\b(case|cover|protector|charger|cable|strap|skin|tempered|guard|adapter|stand|mount|holder|pouch|sleeve|refill|replacement)\b/;
  const lookedUp = op && op.title ? atNorm(op.title) : "", card = atNorm(p.name);
  if (lookedUp && lookedUp !== card && (!lookedUp.startsWith(card) || (ACCESSORY.test(lookedUp) && !ACCESSORY.test(card)))) {
    cell.append(el("p", { className: "at-prod-mismatch" }, `${engineLabel}’s lookup for this card returned “${op.title}”${op.price ? ` (${op.price})` : ""}.`));
  }
  if (pn && pn.rationale) cell.append(el("div", { className: "at-prod-why" }, el("span", { className: "at-eyebrow" }, `Why ${engineLabel} recommends it`), el("p", {}, pn.rationale)));
  if (pn && pn.reviews && pn.reviews.length) {
    const list = el("ul", { className: "at-reviews" });
    pn.reviews.forEach((rv) => list.append(el("li", { className: `at-review ${rv.sentiment || ""}` },
      el("span", { className: "at-review-dot", title: rv.sentiment || "" }),
      el("b", {}, rv.theme || "Review"),
      rv.source ? (rv.url ? el("a", { href: rv.url, target: "_blank", rel: "noopener noreferrer", className: "at-review-src" }, rv.source) : el("span", { className: "at-review-src" }, rv.source)) : null,
      rv.summary ? el("span", { className: "at-review-sum" }, rv.summary) : null)));
    cell.append(el("div", { className: "at-prod-reviews" }, el("span", { className: "at-eyebrow" }, "What reviews say"), pn.summary ? el("p", { className: "ap-muted" }, pn.summary) : null, list));
  }
  if (pn && pn.pages && pn.pages.length) {
    const pages = el("div", { className: "ap-chips at-prod-pages-behind" });
    pn.pages.forEach((pg) => pages.append(el("a", { className: "at-page-chip", href: pg.url, target: "_blank", rel: "noopener noreferrer", title: pg.title || pg.url }, atShortDomain(pg.domain || atHost(pg.url)))));
    cell.append(el("div", {}, el("span", { className: "at-eyebrow" }, `Pages behind this panel · ${pn.pages.length}`), pages));
  }
  return box;
}
const atNorm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// From a product's brand to its row in "Where it came from".
function atJumpToBrand(brand) {
  const row = [...document.querySelectorAll("#at-backing [data-brand]")].find((r) => atNorm(r.dataset.brand) === atNorm(brand));
  const target = row || document.getElementById("at-backing");
  if (!target) return;
  const behavior = jumpBehavior();
  target.scrollIntoView({ block: "center", behavior });
  if (row) { row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1600); }
}
function atMerchants(p) {
  return String((p && p.merchant) || "").split(/\s*(?:\+|·|,|\band\b)\s*/i).map((x) => x.trim()).filter((x) => x && !/^others?$/i.test(x));
}
// One site's kind, for a chip: "Retailers" → "Retailer".
function atKindOne(k) { return k === "Forums & social" ? "Forum or social" : k === "Rival brand sites" ? "Rival brand site" : k === "Public & reference" ? "Public or reference site" : k === "Served by the engine" ? k : String(k).replace(/s$/, ""); }
// Images the engine serves from its own servers say nothing about the site.
function atProxied(u) { return /(^|\.)(images\.openai\.com|gstatic\.com|googleusercontent\.com|bing\.net|perplexity\.ai|x\.ai|grok\.com)$/i.test(atHost(u)); }
function atHost(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
function atHue(s) { let h = 0; for (const c of String(s).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function atCompact(n) { const v = Number(n); return !Number.isFinite(v) ? String(n) : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v); }

function atImagesSection(rec, own, ctxKinds) {
  const sec = atSection("at-images", "Images shown", rec.images.length, el("span", { className: "ap-muted" }, "who supplied each image, and where a click takes the reader"));
  sec.dataset.rail = "Pictures";
  const grid = el("div", { className: "at-imgs" });
  const kinds = new Map();
  rec.images.forEach((im) => {
    const host = atHost(im.sourceUrl || im.link || "") || atHost(im.url);
    const proxied = atProxied(im.url);
    const from = im.attribution || (proxied && !im.sourceUrl ? "the engine’s copy" : host);
    const k = proxied && !im.sourceUrl ? "Served by the engine" : siteKindOf(host, ctxKinds);
    kinds.set(k, (kinds.get(k) || 0) + 1);
    const brand = ctxKinds.brands.find((b) => new RegExp(`\\b${escapeRegExp(b)}\\b`, "i").test(`${im.title || ""} ${im.attribution || ""}`));
    const mine = own && brand && brand.toLowerCase() === own.name.toLowerCase();
    grid.append(el("div", { className: `at-img-card${mine ? " mine" : ""}` },
      withImage(el("span", { className: "at-img-thumb" }, glyphEl("image", 26)), im.url, im.title || brand || from),
      el("span", { className: "at-img-from", title: from }, from),
      el("span", { className: "at-img-kind" }, el("i", { style: `background:var(${AP_KIND_VAR[k] || "--kind-other"})` }), atKindOne(k)),
      el("span", { className: "at-img-lead" }, glyphEl("link", 12), im.sourceUrl || im.link ? `${atHost(im.sourceUrl || im.link)} page` : "no click destination captured"),
      el("span", { className: "ap-muted at-img-brand" }, [brand || "no brand", im.price].filter(Boolean).join(" · "))));
  });
  const legend = el("div", { className: "at-img-kinds" }, el("span", { className: "at-eyebrow" }, "Images by kind of site"),
    ...[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => el("span", {}, el("i", { style: `background:var(${AP_KIND_VAR[k] || "--kind-other"})` }), `${k} `, el("b", {}, String(n)))));
  sec.append(grid, legend);
  return sec;
}


/* A page's address as people read it: no scheme, no "www.", no tracking
 * tags. The full address stays on the element's title and its link. */
function displayUrl(u) {
  return String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/([?&])utm_[^&#]*&?/g, "$1").replace(/[?&]$/, "");
}

// One page the engine opened: cited or read only, its title linked, its
// site and its full address.
function sourceRowEl(s, { cls = "", pill = apPill } = {}) {
  const d = (s.domain || s.url || "").replace(/^www\./, "");
  const cited = s.outcome === "cited";
  return el("div", { className: cls },
    el("div", { className: "ap-sheet-row-head" }, pill(cited ? "Cited" : "Read only", cited ? "good" : "neutral"),
      el("a", { href: s.url || "#", target: "_blank", rel: "noreferrer" }, s.title || d || s.url || "—")),
    el("span", { className: "ap-muted" }, d),
    s.url ? el("span", { className: "src-url", title: s.url }, displayUrl(s.url)) : null);
}

/* An ad shown with the answer (adsView): who paid, what the card said,
 * where it sends people, and what ties it to the answer. Compact is the
 * version under the answer text, as the engine showed it. */
function adAdvertisers(rec) {
  return [...new Set((rec.ads || []).map((a) => a.advertiser || a.targetDomain).filter(Boolean))].join(", ") || "sponsored";
}
function adCardEl(a, { compact = false, products = 0 } = {}) {
  const card = el("div", { className: `ad-card${compact ? " compact" : ""}` });
  card.append(el("div", { className: "ad-head" },
    el("b", {}, a.advertiser),
    el("span", { className: "ad-label" }, a.label),
    a.placement && !compact ? el("span", { className: "ap-muted" }, a.placement) : null));
  if (a.preamble) card.append(el("p", { className: "ad-pre" }, a.preamble));
  if (a.title || a.body) card.append(el("div", { className: "ad-body" }, a.title ? el("b", {}, a.title) : null, a.body ? el("span", {}, a.body) : null));
  if (a.url || a.domain) {
    const link = /^https?:\/\//.test(a.url) ? el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", title: a.url }, a.domain || a.url) : el("span", {}, a.domain);
    card.append(el("div", { className: "ad-link" }, el("span", { className: "ap-muted" }, "Links to "), link,
      !compact && a.url ? el("span", { className: "ad-url", title: a.url }, a.url) : null));
  }
  if (!compact) {
    const site = a.siteCited ? [`Its site cited ${a.siteCited}×`, "good"] : a.siteRead ? [`Its site read ${a.siteRead}×, not cited`, "neutral"] : ["Its site not opened", "neutral"];
    // What ties it to the answer (0.60.0): where the answer named the
    // advertiser, and whether any product card already lists it as a store.
    const named = a.place ? `Also named ${apOrd(a.place)} in the answer` : a.namedInAnswer ? "Also named in the answer" : "Not named in the answer";
    const cards = a.onCards && a.onCards.length ? `A store on card ${atList(a.onCards.map((c) => String(c.n)))}` : products ? "Not a store on any card" : "";
    card.append(el("div", { className: "ap-chips" },
      apPill(named, a.namedInAnswer ? "good" : "neutral"),
      apPill(site[0], site[1]),
      cards ? apPill(cards, a.onCards && a.onCards.length ? "info" : "neutral") : null,
      a.format ? el("span", { className: "ap-muted" }, a.format.replace(/_/g, " ")) : null));
  }
  return card;
}

// The links a place's card carries. A hotel from Gemini's Google Hotels card
// has its listing there (rates and booking) rather than a website or phone.
function placeLinkChips(p, links) {
  if (p.listingUrl && /^https:\/\//.test(p.listingUrl)) {
    links.append(el("a", { className: "ap-bchip", href: p.listingUrl, target: "_blank", rel: "noopener noreferrer", title: "Its listing on the card, with rates" }, "Listing"));
  }
  [["Website", p.website], ["Directions", p.mapsUrl], ["Call", p.phone]].forEach(([k, v]) => links.append(el("span", { className: `ap-bchip${v ? "" : " missing"}`, title: v ? "" : `No ${k.toLowerCase()} on this listing` }, k)));
}

/* Places on the map, in pin order: each listing's rating, kind, the links its
 * card carries, whether the text names it, and which listing feed supplied
 * it (0.60.0). The feed is the one source the capture keeps per place; which
 * source supplied each field (the rating, the hours, the picture) is not
 * captured, and the section says so rather than drawing a per-field grid. */
function atPlacesSection(rec, own) {
  const sec = atSection("at-places", "Places on the map", rec.places.length, el("span", { className: "ap-muted" }, "pin order as shown"));
  sec.dataset.rail = "Places on the map";
  const table = el("div", { className: "at-table at-place-table", role: "table", "aria-labelledby": "at-places-h" });
  table.append(el("div", { className: "at-tr at-th", role: "row" },
    el("span", { role: "columnheader" }, "Pin"), el("span", { role: "columnheader" }, "Place"), el("span", { role: "columnheader" }, "Rating"),
    el("span", { role: "columnheader" }, "Kind"), el("span", { role: "columnheader" }, "Links on its card"), el("span", { role: "columnheader" }, "Named in the text"),
    el("span", { role: "columnheader" }, "Listing from")));
  const answer = String(rec.answerText || "").toLowerCase();
  const feeds = new Map();
  rec.places.forEach((p, i) => {
    const mine = own && String(p.name || "").toLowerCase().startsWith(own.name.toLowerCase());
    const links = el("span", { className: "ap-chips" });
    placeLinkChips(p, links);
    const inText = p.name && answer.includes(String(p.name).toLowerCase());
    const sup = supplierOf(p.supplier);
    if (sup) feeds.set(sup.code, (feeds.get(sup.code) || 0) + 1);
    table.append(el("div", { className: `at-tr${mine ? " mine" : ""}`, role: "row" },
      el("span", { role: "cell" }, el("span", { className: "ap-pin" }, String(i + 1))),
      // Its photo, description and a review quote too, when the card had
      // them (Gemini's, 1.0.2).
      el("span", { role: "cell", className: "ap-brand-cell", title: p.description || "" },
        p.image ? withImage(el("span", { className: "at-thumb" }, glyphEl("pin", 18)), p.image, p.name) : null,
        el("span", { className: "ap-brand-name" }, p.name || "—"),
        el("span", { className: "ap-brand-sub" }, [p.address, p.hours].filter(Boolean).join(" · ")),
        p.description && !String(p.description).toLowerCase().startsWith(String(p.name || "").toLowerCase().slice(0, 20)) ? el("span", { className: "ap-brand-sub" }, p.description) : null,
        (p.reviewQuotes || []).length ? el("span", { className: "ap-brand-sub ap-muted", title: p.reviewQuotes.map((q) => `${q.age ? q.age + ": " : ""}${q.text}`).join("\n\n") },
          `“${p.reviewQuotes[0].text.slice(0, 140)}${p.reviewQuotes[0].text.length > 140 ? "…" : ""}”${p.reviewQuotes[0].age ? ` — ${p.reviewQuotes[0].age}` : ""}${p.reviewQuotes.length > 1 ? ` · +${p.reviewQuotes.length - 1} more` : ""}`) : null),
      el("span", { role: "cell" }, p.rating != null ? `★ ${p.rating}${p.reviews ? ` (${Number(p.reviews).toLocaleString()})` : ""}` : "—"),
      el("span", { role: "cell", className: "at-ellipsis" }, [p.category, p.priceRange].filter(Boolean).join(" · ") || "—"),
      el("span", { role: "cell" }, links),
      el("span", { role: "cell", className: inText ? "ap-tile-value tone-good at-small" : "ap-muted" }, inText ? "Yes" : "No"),
      el("span", { role: "cell", className: sup ? "at-feed" : "ap-muted", title: sup && sup.note ? sup.note : sup ? "" : "The capture holds no listing source for this place" }, sup ? sup.code : "not captured")));
  });
  sec.append(el("div", { className: "at-scroll" }, table));
  sec.append(el("p", { className: "ap-muted at-foot" },
    [feeds.size ? `Listings from ${[...feeds].map(([c, n]) => `${c} (${n})`).join(", ")}.` : "", "Not captured: which source supplied each field on a card (the rating, the hours, the picture)."].filter(Boolean).join(" ")));
  return sec;
}

/* Side by side (0.60.0, the canvas's Engines board): how the answers differ
 * in sentences, each engine in numbers (its ad included), where each brand
 * came on each engine, which sites each one used, the searches each ran, and
 * the ads. The answer panel beside it switches between the engines' answers.
 * Gemini publishes neither its searches nor an ad format, and that is said as
 * "not published" and "no ad format", not as zero. */
// Side by side, as tabs (0.68.0). Asked for: "the current side by side
// comparison provides very little information … much more, a lot like in
// campaign, in a proper well structured format, and please don't have an
// infinite scroll layout". One part at a time; long lists page.
const AT_CMP_PANES = [["sum", "Summary"], ["brands", "Brands"], ["sources", "Sources"], ["products", "Products"], ["searches", "Searches"], ["ads", "Ads"]];
function atCmpPaged(key, list, per) {
  const pages = Math.max(1, Math.ceil(list.length / per));
  const at = Math.min(atCmpPg[key] || 0, pages - 1);
  atCmpPg[key] = at;
  const rows = list.slice(at * per, at * per + per);
  if (list.length <= per) return { rows, pager: "" };
  const prev = el("button", { type: "button", className: "cv-pg", "aria-label": "Previous page", disabled: at === 0 }, "‹");
  const next = el("button", { type: "button", className: "cv-pg", "aria-label": "Next page", disabled: at >= pages - 1 }, "›");
  prev.onclick = () => { atCmpPg[key] = at - 1; renderAnalyze(); };
  next.onclick = () => { atCmpPg[key] = at + 1; renderAnalyze(); };
  return { rows, pager: el("div", { className: "cv-pager", "data-pager": key }, el("span", { className: "cv-muted" }, `${at * per + 1}–${Math.min(list.length, at * per + per)} of ${list.length}`), prev, next) };
}
function atRenderCompare(main, cv, answers, { own } = {}) {
  const panes = AT_CMP_PANES.filter(([id]) => id !== "ads" || cv.engines.some((e) => e.ads.length));
  if (!panes.some(([id]) => id === atCmpPane)) atCmpPane = "sum";
  const counts = { brands: cv.brandGrid.length, sources: cv.siteGrid.filter((x) => x.citedBy).length, products: cv.productGrid.length, searches: cv.searchRows.reduce((a, r) => a + r.queries.length, 0) };
  const tabs = el("div", { className: "cv-tabs at-cmp-tabs", role: "tablist", "aria-label": "Parts of the comparison" });
  panes.forEach(([id, label]) => {
    const on = id === atCmpPane;
    const b = el("button", { type: "button", role: "tab", className: `cv-tab${on ? " on" : ""}`, "aria-selected": on ? "true" : "false", "data-pane": id }, label);
    if (counts[id] != null) b.append(el("span", { className: "cv-cnt" }, String(counts[id])));
    b.onclick = () => { atCmpPane = id; renderAnalyze(); };
    tabs.append(b);
  });
  main.append(tabs);
  const head = () => cv.engines.map((e) => el("span", { role: "columnheader", className: "c", title: e.label }, e.label));
  const gridRow = (...cells) => el("div", { className: "at-grid-row", role: "row" }, ...cells);
  const n = cv.engines.length;
  ({ sum: atCmpSummary, brands: atCmpBrands, sources: atCmpSources, products: atCmpProducts, searches: atCmpSearches, ads: atCmpAds })[atCmpPane](main, cv, { own, head, gridRow, n, answers });
}

function atCmpSummary(main, cv, { own, n }) {
  const DIFF_TONE = { "Who came first": "info", Agreement: "good", Sources: "warn", Searching: "sky", "From memory": "warn", Ads: "warn" };
  const o = cv.overlap;
  const tiles = el("div", { className: "cv-tiles at-cmp-tiles" },
    ...[["Same brand first", o.sameFirst ? "Yes" : "No", n > 1 ? `across ${n} engines` : ""],
      ["Brands named by all", `${o.brandsAll} of ${o.brands}`, "brands in any answer"],
      ["Sites cited by more than one", `${o.sitesShared} of ${o.sitesCited}`, "sites cited"],
      ["Similar searches", String(o.searchesShared), "run by more than one engine"],
      ["Products shown by more than one", `${o.productsShared} of ${o.products}`, "product cards"]].map(([l, v, sub]) =>
      el("div", { className: "cv-tile" }, el("span", { className: "cv-tile-l" }, l), el("span", { className: "cv-tile-v" }, v), el("span", { className: "cv-tile-s" }, sub))));
  const diffs = atSection("at-cmp-diffs", `How the ${n} answers differ`, "");
  diffs.dataset.rail = "How they differ";
  const ul = el("ul", { className: "at-diffs" });
  cv.diffs.forEach((d) => ul.append(el("li", {}, el("span", { className: `at-diff-k tone-${DIFF_TONE[d.k] || "vio"}` }, d.k), el("span", {}, d.v))));
  diffs.append(tiles, ul);
  main.append(diffs);

  const t = atSection("at-cmp-table", "Each engine in numbers", "");
  t.dataset.rail = "Each engine in numbers";
  const youRow = own ? cv.brandGrid.find((b) => b.isYou) : null;
  const heads = ["Engine", "Named first", own ? own.name : null, "Answer", "Brands", "Mentions", "Products", "Searches", "site:", "Read", "Cited", "Ad"].filter(Boolean);
  const NUM = ["Brands", "Mentions", "Products", "Searches", "site:", "Read", "Cited"];
  const table = el("div", { className: `at-table at-cmp-engines wide${own ? " has-you" : ""}`, role: "table", "aria-labelledby": "at-cmp-table-h" });
  table.append(el("div", { className: "at-tr at-th", role: "row" }, ...heads.map((h) => el("span", { role: "columnheader", className: NUM.includes(h) ? "num" : "" }, h))));
  cv.engines.forEach((e, i) => {
    const d = cv.detail[i];
    const pos = youRow ? youRow.cells[i] : 0;
    table.append(el("div", { className: "at-tr", role: "row" },
      el("span", { role: "rowheader", className: "ap-brand-name" }, el("i", { className: `at-eng-dot e-${e.id}`, "aria-hidden": "true" }), ` ${e.label}`, e.model ? el("span", { className: "ap-muted at-small" }, ` ${e.model}`) : null),
      el("span", { role: "cell" }, e.first),
      own ? el("span", { role: "cell" }, el("span", { className: `at-rank-chip${pos === 1 ? " first" : pos ? "" : " none"}` }, pos ? apOrd(pos) : "not named")) : null,
      el("span", { role: "cell", className: "ap-muted" }, `${e.kind}${d.chars ? ` · ${Math.max(1, Math.round(d.chars / 6))} words` : ""}${e.had.length ? ` · ${e.had.join(", ")}` : ""}`),
      ...[e.brands, d.mentionTotal, d.products, e.searches, e.searches === "none" ? "—" : d.siteSearches, e.read, e.cited].map((x) => el("span", { role: "cell", className: "num" }, String(x))),
      el("span", { role: "cell", className: e.ads.length ? "at-ad-cell" : "ap-muted" }, e.ads.length ? e.ads.join(", ") : e.adFormat ? "none" : "no ad format")));
  });
  t.append(el("div", { className: "at-scroll" }, table),
    el("p", { className: "ap-muted at-foot" }, "Answer: the kind of answer and its length. Mentions: times any brand was named. site: searches limited to chosen sites."));
  main.append(t);
}

function atCmpBrands(main, cv, { head, gridRow, n }) {
  const M = [["place", "Place"], ["mentions", "Mentions"], ["share", "Share of mentions"]];
  const seg = el("div", { className: "cv-seg", role: "group", "aria-label": "Measure" });
  M.forEach(([id, l]) => { const b = el("button", { type: "button", className: atCmpMeasure === id ? "on" : "", "aria-pressed": atCmpMeasure === id ? "true" : "false" }, l); b.onclick = () => { atCmpMeasure = id; renderAnalyze(); }; seg.append(b); });
  const bsec = atSection("at-cmp-brands", "Where each brand came", "", seg);
  bsec.dataset.rail = "Where each brand came";
  const cols = `minmax(140px, 1.4fr) repeat(${n}, minmax(64px, 1fr)) 76px 64px`;
  const bg = el("div", { className: "at-grid-table", role: "table", style: `grid-template-columns:${cols}` });
  bg.append(gridRow(el("span", { role: "columnheader" }, "Brand"), ...head(), el("span", { role: "columnheader", className: "num" }, "Named by"), el("span", { role: "columnheader", className: "num" }, "First in")));
  const { rows, pager } = atCmpPaged("brands", cv.brandGrid, 15);
  rows.forEach((b) => bg.append(gridRow(
    el("span", { role: "rowheader", className: `ap-brand-name${b.isYou ? " you" : ""}` }, b.name + (b.isYou ? " · you" : "")),
    ...b.cells.map((c, i) => {
      const txt = atCmpMeasure === "mentions" ? (b.mentions[i] ? `×${b.mentions[i]}` : "—") : atCmpMeasure === "share" ? (b.share[i] ? `${b.share[i]}%` : "—") : (c ? apOrd(c) : "—");
      return el("span", { role: "cell", className: `c pos${c === 1 ? " first" : c && c <= 3 ? " top" : c ? "" : " none"}`, "aria-label": `${cv.engines[i].label}: ${c ? apOrd(c) : "not named"}` }, txt);
    }),
    el("span", { role: "cell", className: "num" }, `${b.namedBy} of ${n}`),
    el("span", { role: "cell", className: "num" }, String(b.firsts)))));
  bsec.append(el("div", { className: "at-scroll" }, bg), pager,
    el("p", { className: "ap-muted at-foot" }, "Gold: named first in that answer. Share of mentions: that brand's mentions out of every brand mention in the answer."));
  main.append(bsec);
}

const AT_KIND_COLOR = { "Your site": "var(--you)", "Review sites": "var(--kind-review)", "Retailers": "var(--kind-retail)", "Rival brand sites": "var(--kind-rival)", "Forums & social": "var(--kind-forum)", "Public & reference": "var(--kind-public)", "Other": "var(--kind-other)" };
function atCmpSources(main, cv, { head, gridRow, n }) {
  const k = atSection("at-cmp-kinds", "Kinds of site each engine cited", "");
  k.dataset.rail = "Kinds of site";
  cv.kindMix.forEach((e) => {
    const bar = el("div", { className: "cv-mix", "aria-hidden": "true" });
    e.parts.forEach((p) => bar.append(el("i", { style: `width:${(p.n * 100 / Math.max(1, e.total)).toFixed(1)}%;background:${AT_KIND_COLOR[p.label]}` })));
    k.append(el("div", { className: "at-cmp-kindrow" }, el("span", { className: "ap-brand-name" }, el("i", { className: `at-eng-dot e-${e.id}`, "aria-hidden": "true" }), ` ${e.label}`, el("span", { className: "ap-muted" }, ` · ${e.total} cited`)),
      e.total ? bar : el("span", { className: "ap-muted" }, "cited nothing"),
      el("span", { className: "cv-legend" }, ...e.parts.map((p) => el("span", {}, el("i", { style: `background:${AT_KIND_COLOR[p.label]}` }), p.label, el("b", {}, String(p.n)))))));
  });
  main.append(k);

  const ssec = atSection("at-cmp-sites", "Which sites each engine used", "", el("span", { className: "ap-legend" }, el("span", {}, el("i", { className: "dot cited" }), "cited (pages)"), el("span", {}, el("i", { className: "dot read" }), "read only")));
  ssec.dataset.rail = "Sites each engine used";
  const cols = `minmax(140px, 1.3fr) 110px repeat(${n}, minmax(64px, 96px)) 72px`;
  const sg = el("div", { className: "at-grid-table", role: "table", style: `grid-template-columns:${cols}` });
  sg.append(gridRow(el("span", { role: "columnheader" }, "Site"), el("span", { role: "columnheader" }, "Kind"), ...head(), el("span", { role: "columnheader", className: "num" }, "Cited by")));
  const { rows, pager } = atCmpPaged("sites", cv.siteGrid, 15);
  rows.forEach((x) => sg.append(gridRow(
    el("span", { role: "rowheader", className: "at-ellipsis" }, x.domain),
    el("span", { role: "cell" }, el("span", { className: "cv-pill" }, x.kind)),
    ...x.cells.map((c, i) => el("span", { role: "cell", className: "c", "aria-label": `${cv.engines[i].label}: ${c || "not used"}` }, el("i", { className: c === "cited" ? "dot cited" : c === "read" ? "dot read" : "dot none" }), x.pages[i] > 1 ? el("span", { className: "ap-muted at-small" }, ` ${x.pages[i]}`) : "")),
    el("span", { role: "cell", className: "num" }, String(x.citedBy)))));
  ssec.append(el("div", { className: "at-scroll" }, sg), pager);
  main.append(ssec);

  const c = atSection("at-cmp-cites", "What each engine cited", "", el("span", { className: "ap-muted" }, "in the order the answer cited them"));
  c.dataset.rail = "What each cited";
  const colsBox = el("div", { className: "at-cmp-qcols" });
  cv.detail.forEach((d, i) => {
    const col = el("div", { className: "at-cmp-q" }, el("span", { className: "ap-brand-name" }, el("i", { className: `at-eng-dot e-${d.id}`, "aria-hidden": "true" }), ` ${d.label} · ${d.citations.length}`));
    const { rows: rs, pager: pg } = atCmpPaged(`cites${i}`, d.citations, 8);
    rs.forEach((x) => col.append(el("div", { className: "at-cmp-cite" }, el("span", { className: "at-cmp-n" }, String(x.n)),
      el("span", { className: "at-cmp-cite-t" }, el("a", { href: x.url, target: "_blank", rel: "noopener" }, x.title), el("span", { className: "ap-muted at-small" }, `${x.domain} · ${x.pageType}`)))));
    if (!d.citations.length) col.append(el("span", { className: "at-cmp-none" }, "Cited no page."));
    if (pg) col.append(pg);
    colsBox.append(col);
  });
  c.append(colsBox);
  main.append(c);
}

function atCmpProducts(main, cv, { head, gridRow, n }) {
  const p = atSection("at-cmp-products", "Product cards in each answer", "", el("span", { className: "ap-muted" }, "matched by name; the card's place and price"));
  p.dataset.rail = "Product cards";
  if (!cv.productGrid.length) { p.append(el("p", { className: "ap-muted" }, "No answer showed product cards.")); main.append(p); return; }
  const cols = `minmax(160px, 1.6fr) repeat(${n}, minmax(84px, 1fr)) 72px`;
  const g = el("div", { className: "at-grid-table", role: "table", style: `grid-template-columns:${cols}` });
  g.append(gridRow(el("span", { role: "columnheader" }, "Product"), ...head(), el("span", { role: "columnheader", className: "num" }, "Shown by")));
  const { rows, pager } = atCmpPaged("products", cv.productGrid, 12);
  rows.forEach((x) => g.append(gridRow(el("span", { role: "rowheader", className: "at-ellipsis" }, x.name),
    ...x.cells.map((c, i) => el("span", { role: "cell", className: `c${c && c.place === 1 ? " pos first" : ""}`, title: c && c.merchant ? c.merchant : "", "aria-label": `${cv.engines[i].label}: ${c ? `card ${c.place}` : "not shown"}` }, c ? `#${c.place}${c.price ? ` · ${c.price}` : ""}` : "—")),
    el("span", { role: "cell", className: "num" }, `${x.shownBy} of ${n}`))));
  p.append(el("div", { className: "at-scroll" }, g), pager);
  main.append(p);
}

function atCmpSearches(main, cv) {
  const q = atSection("at-cmp-searches", "Searches each engine ran", "", el("span", { className: "ap-muted" }, "highlighted = another engine ran a similar search"));
  q.dataset.rail = "Searches each ran";
  const qcols = el("div", { className: "at-cmp-qcols" });
  cv.searchRows.forEach((r, i) => {
    const d = cv.detail[i];
    const col = el("div", { className: "at-cmp-q" }, el("span", { className: "ap-brand-name" }, el("i", { className: `at-eng-dot e-${r.id}`, "aria-hidden": "true" }), ` ${r.label}${r.queries.length ? ` · ${r.queries.length}` : ""}`));
    if (r.queries.length) {
      col.append(el("span", { className: "ap-muted at-small" }, `${d.avgWords} words each · ${r.queries.filter((x) => x.shared).length} like another engine's${d.siteSearches ? ` · ${d.siteSearches} with site:` : ""}`));
      const { rows, pager } = atCmpPaged(`q${i}`, r.queries, 10);
      rows.forEach((x) => col.append(el("span", { className: `ap-bchip${x.shared ? " shared" : ""}` }, x.text)));
      if (pager) col.append(pager);
    } else col.append(el("span", { className: "at-cmp-none" }, r.searched ? `${r.label} doesn’t publish the searches it runs. Shown as unknown, not zero.` : "Didn’t search the web."));
    qcols.append(col);
  });
  q.append(qcols);
  main.append(q);
}

function atCmpAds(main, cv) {
  const a = atSection("at-cmp-ads", "Ads shown with the answers", "", apPill("Sponsored", "warn"));
  a.dataset.rail = "Ads";
  cv.engines.forEach((e) => a.append(el("div", { className: "at-cmp-ad" },
    el("span", { className: "ap-brand-name" }, el("i", { className: `at-eng-dot e-${e.id}`, "aria-hidden": "true" }), ` ${e.label}`),
    el("span", { className: e.ads.length ? "" : "ap-muted" }, e.ads.length ? `An ad from ${atList(e.ads)}` : e.adFormat ? "No ad with this answer" : "No ad format"))));
  a.append(el("p", { className: "ap-muted at-foot" }, "Not captured: clicks, impressions and what an ad cost."));
  main.append(a);
}

/* The card-by-card Analyze that both views used up to 0.46.0. Since 0.48.0
 * it is built into a detached container and the full tab's Details panel
 * takes the cards it wants from it by id (renderAnalyzeTab), so none of their
 * behaviour — pipeline chips, title-mismatch tags, site: scoping, the
 * brand/page matrix, claim grounding — had to be rewritten to move. */
function renderAnalyzeLegacy(rec, root) {
  // Sticky prompt/engine identity bar — the first thing in #analyze, before
  // even the context banner below. On a long Analyze view (Verbatim
  // Grounding is now the LAST card, so this page can run long) scrolling
  // down used to lose all track of WHICH prompt and WHICH engine's answer
  // you were looking at; this stays glued to the top of the scroll area so
  // that's always visible. Sticks below .app-header (--analyze-bar-top,
  // measured by applyMode()) in the full-tab view, where both are sticky in
  // the SAME scrolling context; in the popup, .app-header is a non-scrolling
  // flex sibling of .app-content rather than part of its scrollport, so
  // top:0 there is already correct without an offset — see the CSS.
  // Sample data must announce itself wherever it's shown. A user who forgot
  // they loaded it should never mistake these numbers for their own — see the
  // note in src/lib/demo-data.js.
  if (rec.isDemo || String(rec.captureId || "").startsWith("demo-")) {
    root.append(el("div", { className: "demo-banner" },
      el("span", { className: "demo-banner-label" }, "Sample"),
      el("span", {}, "This is example data showing what a captured answer looks like — not a real capture. Remove it any time from the About tab.")));
  }

  {
    const promptBar = el("div", { className: "analyze-context-bar" });

    // Back control lives HERE rather than only in the .viewing banner below,
    // because this bar is the one thing that stays on screen at every scroll
    // position — reaching the banner's back link meant scrolling back to the
    // top of a long Analyze view first. When this capture was opened from
    // another tab (returnTab) it returns exactly there; otherwise Dashboard
    // is the sane home, so the control is never a dead end.
    const backTo = returnTab || "dashboard";
    const backBtn = el("button", {
      className: "analyze-context-back",
      title: `Back to ${TAB_LABELS[backTo] || backTo}`,
    });
    backBtn.append(
      el("span", { "aria-hidden": "true" }, "←"),
      el("span", { className: "analyze-context-back-label" }, TAB_LABELS[backTo] || backTo)
    );
    backBtn.onclick = () => {
    if (history.state && history.state.cito === "analyze") { history.back(); return; } // popstate goes back
    returnTab = null; showTab(backTo);
  };

    // Report-this-capture, in the corner of the one bar that stays on screen
    // at every scroll position. Small and unlabelled on purpose: it is a
    // permanent fixture next to a prompt that can be long, so it gets an icon,
    // a title and an aria-label rather than width.
    const feedbackBtn = el("button", {
      className: "analyze-context-feedback",
      title: "Report a problem with this capture",
      "aria-label": "Report a problem with this capture",
    }, "💬");
    feedbackBtn.onclick = () => openFeedbackModal(rec);

    // Compare left the top menu in 0.47.0; it opens from here instead, on
    // this answer's prompt, whenever there is more than one answer to it.
    const cmpKey = normPrompt(rec.userPrompt);
    const cmpN = cmpKey && RECORDS.some((r) => r.captureId === rec.captureId)
      ? RECORDS.filter((r) => normPrompt(r.userPrompt) === cmpKey).length : 0;
    const cmpBtn = cmpN > 1 ? el("button", {
      className: "analyze-context-back analyze-context-compare",
      type: "button",
      "data-open": "compare",
      title: "Every captured answer to this prompt, run by run and engine by engine",
    }, `Compare ${cmpN} answers`) : null;
    if (cmpBtn) cmpBtn.onclick = () => openCompareFor(rec);

    promptBar.append(
      backBtn,
      el("span", { className: "analyze-context-label muted small" }, "Analyzing"),
      el("span", {
        className: "analyze-context-prompt",
        title: rec.userPrompt || "",
      }, rec.userPrompt || "(no prompt text)"),
      engineChip(rec.platform, ENGINES.find((e) => e.id === rec.platform)?.label || rec.platform || "Unknown"),
      ...(cmpBtn ? [cmpBtn] : []),
      feedbackBtn
    );
    root.append(promptBar);
  }

  // Context banner — two independent signals, shown together when both
  // apply, and deliberately the FIRST thing appended so it's visible
  // without scrolling even on a long Analyze view (previously the only way
  // back was the sticky header's nav tabs, which combined with tab
  // switching not remembering scroll position — see showTab() — meant
  // "back" never actually returned you to where you'd been):
  //  1. returnTab: this capture was opened via a link from another tab
  //     (Dashboard, Campaigns, Compare, a brand row, a domain drill-down…)
  //     — offer a direct way back to it.
  //  2. this isn't the latest AD-HOC capture. Only meaningful for ad-hoc
  //     captures — a campaign/tracked capture (opened via Prompt
  //     Performance, which is exactly the flow returnTab exists for) has
  //     no position in RECORDS at all, since RECORDS deliberately excludes
  //     tracked captures (see the isolation note in load()); the old
  //     unconditional findIndex here returned -1 and would have rendered
  //     the nonsensical "viewing capture 0 of N" for that exact flow.
  {
    // NOTE: no back link here any more — it moved into the sticky context
    // bar above, which is reachable from every scroll position. Repeating it
    // here would just be a second copy of the same control a few pixels
    // apart.
    const parts = [];
    const adhocIdx = RECORDS.findIndex((r) => r.captureId === rec.captureId);
    if (adhocIdx > 0) {
      parts.push(el("span", {}, `Viewing capture ${adhocIdx + 1} of ${RECORDS.length} (${new Date(rec.capturedAt).toLocaleString(dateLocale())})`));
      const latestBtn = el("button", { className: "linkbtn" }, "Go to latest →");
      // Explicit id, not `viewingId = null` — null would re-run the same
      // signal-preferring default above (defaultRecordId()) and land right
      // back here if the literal newest capture is the signal-less one
      // being skipped. returnTab is also cleared: jumping to latest isn't
      // "returning" anywhere, so any pending back-link no longer applies.
      latestBtn.onclick = () => {
        viewingId = (RECORDS[0] && RECORDS[0].captureId) || null;
        returnTab = null;
        renderAnalyze();
      };
      parts.push(latestBtn);
    } else if (adhocIdx === -1 && rec.geo) {
      parts.push(el("span", {}, `Viewing a campaign capture — ${rec.platform || "unknown"}${rec.model ? " · " + rec.model : ""} · ${new Date(rec.capturedAt).toLocaleString(dateLocale())}`));
    }
    if (parts.length) {
      const banner = el("div", { className: "viewing" });
      parts.forEach((p, i) => { if (i > 0) banner.append(el("span", { className: "viewing-sep" }, "·")); banner.append(p); });
      root.append(banner);
    }
  }

  const fanCount =
    ((rec.fanout?.search?.length || 0) + (rec.fanout?.shopping?.length || 0) + (rec.fanout?.image?.length || 0));
  // News by either signal: a publication date, or the engine calling the
  // result news (ref_type) — the kind chip and this count must agree.
  const isNews = (s) => s.type === "news" || typeLabel((s.platformSpecific || {}).refType || (s.platformSpecific || {}).resultSource) === "News";
  const newsCount = rec.sources.filter(isNews).length;
  const citedN = rec.sources.filter((s) => s.outcome === "cited").length;
  const fetchedN = rec.sources.filter((s) => s.outcome === "fetched").length;

  // Split Layout Grid
  const grid = el("div", { className: "analyze-grid" });
  
  // Column 1: Sidebar Cards (General, Technical, Global Stats, Brand Mentions, Summary)
  const sidebar = el("div", { className: "analyze-sidebar" });
  
  // 1. General Information Card
  const meta = el("div", { className: "card", id: "card-general" }, el("h3", {}, "General Information"));
  const kv = el("dl", { className: "kv" });
  const addKv = (k, v) => { kv.append(el("dt", {}, k), el("dd", {}, v)); };
  addKv("User prompt", esc(rec.userPrompt) || "—");
  if (rec.generatedTitle) addKv("Generated Title", esc(rec.generatedTitle));
  addKv("Searched", rec.searched ? "Yes" : "No");
  addKv("Fan-out", String(fanCount));
  addKv("Sources", `${rec.sources.length} (${citedN} cited / ${fetchedN} fetched)`);
  addKv("Captured", new Date(rec.capturedAt).toLocaleString(dateLocale()));
  meta.append(kv);
  
  // Carousel Indicators Box
  const carouselBox = el("div", { className: "chips", style: "margin-top:10px;" });
  const car = rec.carousels || {};
  carouselBox.append(
    el("span", { className: `chip ${car.products ? "active" : ""}` }, `Products: ${car.products ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.images ? "active" : ""}` }, `Images: ${car.images ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.news ? "active" : ""}` }, `News: ${car.news ? "YES" : "NO"}`),
    el("span", { className: `chip ${car.map ? "active" : ""}` }, `Map: ${car.map ? "YES" : "NO"}`)
  );
  meta.append(carouselBox);

  const saveRow = el("div", { className: "chips", style: "margin-top:10px; gap:6px;" });
  const saveHtmlBtn = el("button", { className: "btn sm ghost", style: "flex:1" }, "💾 Save as HTML");
  saveHtmlBtn.onclick = () => exportRecordsAsHtml([rec]);
  const savePdfBtn = el("button", { className: "btn sm ghost", style: "flex:1" }, "🖨️ Save as PDF");
  savePdfBtn.onclick = () => exportRecordsAsPdf([rec]);
  saveRow.append(saveHtmlBtn, savePdfBtn);
  meta.append(saveRow);

  const rawBtn = el("button", { className: "btn sm ghost", style: "margin-top:6px; width: 100%;" }, "Download raw payload");
  rawBtn.onclick = () => downloadRaw(rec.captureId, "analyze");
  meta.append(rawBtn);
  meta.classList.add("analyze-meta");
  sidebar.append(meta);

  // 2. Technical Information Card (RESONEO parity)
  const ps = rec.platformSpecific || {};
  const techCard = el("div", { className: "card", id: "card-technical" }, el("h3", {}, "Technical Information"));
  const techKv = el("dl", { className: "kv" });
  const addTechKv = (k, v) => { if (v) techKv.append(el("dt", {}, k), el("dd", {}, String(v))); };
  addTechKv("Author", ps.author || (rec.searched ? "tool:web" : "assistant"));
  const tools = {
    "chatgpt": "ChatGPT Web Search Engine (SonicBrowserTool)",
    "gemini": "Google Search Tool (Gemini)",
    "perplexity": "Perplexity Search Engine",
    "grok": "Grok X Search Engine"
  };
  addTechKv("Tool Name", rec.searched ? (tools[rec.platform] || "Web Search Tool") : "—");
  
  // No invented model. This used to fall back to "gpt-4o" for every
  // non-Gemini platform — so a Perplexity or Grok capture with no reported
  // model displayed a ChatGPT model name as though it were fact, and a
  // reader had no way to tell a genuinely-reported model from a filled-in
  // guess. Perplexity captures come from the DOM harvester and carry no
  // model field at all, so that guess was being shown on essentially every
  // one of them. Same reasoning for Plan Type, which defaulted to "free"
  // with nothing behind it. Unknown is shown as unknown.
  addTechKv("Model", rec.model || "—");
  addTechKv("Plan Type", ps.planType || "—");
  if (ps.clusterRegion) addTechKv("Cluster Region", ps.clusterRegion);
  addTechKv("Turn Use Case", rec.turnUseCase || "shopping");
  if (ps.ttfvtMs) addTechKv("TTFVT", `${(ps.ttfvtMs / 1000).toFixed(2)}s`);
  if (ps.wordCount) addTechKv("Response Word Count", `${ps.wordCount} words`);
  if (ps.abExperiment) addTechKv("AB Test", ps.abExperiment);
  
  const refStr = Object.entries(rec.referenceTypes || {})
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");
  if (refStr) addTechKv("Ref Types", refStr);
  techCard.append(techKv);
  techCard.classList.add("analyze-ref");
  sidebar.append(techCard);

  // 3. Global Statistics Card
  const uniqueDomains = new Set(rec.sources.map((s) => s.domain).filter(Boolean)).size;
  const uniqueUrls = new Set(rec.sources.map((s) => s.url).filter(Boolean)).size;
  const avUrlsPerFan = fanCount > 0 ? (uniqueUrls / fanCount).toFixed(1) : String(uniqueUrls);
  const ratio = rec.sources.length > 0 ? (citedN / rec.sources.length).toFixed(2) : "0.00";
  const diversity = uniqueUrls > 0 ? ((uniqueDomains / uniqueUrls) * 100).toFixed(1) + "%" : "0%";

  const globCard = el("div", { className: "card", id: "card-global-stats" }, el("h3", {}, "Global Statistics"));
  const statBox = (num, lbl, tip) => el("div", { className: "stat-box", ...(tip ? { "data-tip": tip } : {}) }, el("div", { className: "num" }, num), el("div", { className: "lbl" }, lbl));
  const globGrid = el("div", { className: "stat-row-grid" },
    statBox(String(uniqueDomains), "Domains"),
    statBox(String(uniqueUrls), "URLs"),
    statBox(avUrlsPerFan, "URLs / Fan-out", "Unique URLs ÷ number of fan-out sub-queries — roughly how many pages each search query pulled in."),
    statBox(ratio, "Cited Ratio", "Cited sources ÷ all sources — what fraction of everything read actually got cited in the written answer."),
    statBox(diversity, "Domain Diversity", "Unique domains ÷ unique URLs — closer to 100% means sources are spread across many publishers; closer to 0% means a few sites dominate.")
  );
  globCard.append(globGrid);
  globCard.classList.add("analyze-ref");
  sidebar.append(globCard);

  // 4. Brand Mentions (with model extraction, ranking, and aspect context)
  //
  // Held in a variable rather than appended straight into the sidebar: this
  // card is the single most important thing on the page for GEO work, so in
  // the full-screen (tab) layout it is placed at the TOP of the wide column
  // — where Query Fan-Out used to sit — instead of being squeezed into the
  // 360px sidebar. It is a direct child of .analyze-grid so CSS can position
  // it per breakpoint (see .analyze-brand-slot in panel.css); the narrow
  // popup layout keeps it in normal reading order via flex `order`.
  let brandCard = null;
  if (rec.brandMentions && rec.brandMentions.length) {
    // Noise removal, aliasing and SKU collapsing all live in
    // src/lib/mention-list.js so the merge rules are testable. A capture that
    // named "Google Pixel 10a" and "Google" used to show both as separate
    // brands, splitting one company's count across two rows.
    // The capture already knows the real vendor names for certain: ChatGPT
    // tags them as "Product Vendor" entities, and every product card carries
    // one. Reported as "Brand Mention and the Products & Entities section is
    // not matching with brands" — the card was listing SKUs ("Realme P4")
    // while the Entities card right below it listed the vendors ("Realme").
    // Feeding those in as collapse roots makes the two agree.
    const cleanMentions = normalizeMentions(rec.brandMentions, knownVendors(rec));
    const bc = el("div", { className: "card", id: "card-brand-mentions" },
      el("h3", {}, `Brand Mentions (${cleanMentions.length})`));

    // One row per brand instead of a card per brand.
    //
    // Reported: "Brand Mention section doesn't need snippet information for
    // each mentioned brand. The brand mention UI needs to be fixed."
    //
    // The quote is gone. It was the tallest thing in each card and the least
    // reliable: passages are lifted from the answer verbatim, so a brand
    // introduced inside a markdown table arrived as a wall of ⭐ rating cells,
    // and two brands named in the same sentence showed the identical block of
    // text. Everything it was there to convey — who, how often, in what order,
    // for what — is on the row itself.
    //
    // Without it the rows are short and uniform, so they read as a ranking:
    // a bar scaled to the most-mentioned brand makes the distribution visible
    // at a glance, which a column of "×5 ×9 ×4" never did.
    const list = el("div", { className: "brand-list" });
    const maxCount = Math.max(1, ...cleanMentions.map((b) => b.count || 0));

    // rec.brandMentions arrives sorted by first appearance in the answer, and
    // a "shown but not named" entry carries MAX_SAFE_INTEGER so it sorts last.
    // That order is the single most asked-for thing on this card — "which
    // brand was mentioned 1st and which was last".
    const narratedCount = cleanMentions.filter((b) => b.count > 0).length;
    cleanMentions.forEach((b, bIdx) => {
      const item = el("div", { className: "brand-item" });
      const head = el("div", { className: "brand-head" });

      if (b.count > 0) {
        const pos = bIdx + 1;
        const label = pos === 1 ? "Named first in the answer"
          : pos === narratedCount ? "Named last in the answer"
          : `Named ${pos}${["th","st","nd","rd"][(pos % 100 - 20) % 10] || ["th","st","nd","rd"][pos % 100] || "th"} in the answer`;
        head.append(el("span", {
          className: `brand-ordinal${pos === 1 ? " first" : ""}`,
          title: label,
        }, String(pos)));
      } else {
        head.append(el("span", { className: "brand-ordinal muted-ordinal", title: "Shown in a card but never named in the answer" }, "–"));
      }

      const { rank, category } = extractRankAndCategory(b.brand, (b.passages || []).join(" "), rec.answerText || "");
      const brandTitle = el("span", { className: "brand-name" });
      if (rank) brandTitle.append(el("span", { className: "tag rank-tag" }, rank), " ");
      brandTitle.append(b.brand);
      // Label the user's own brand / tracked competitors so share of voice is
      // readable at a glance. Detection itself is automatic and unaffected.
      if (b.relation === "own") {
        brandTitle.append(" ", el("span", { className: "tag cited", title: "Your brand" }, "YOU"));
      } else if (b.relation === "competitor") {
        brandTitle.append(" ", el("span", { className: "tag fetched", title: "Tracked competitor" }, "COMP"));
      }
      head.append(brandTitle);

      // count=0 means "shown in a product/place card, but the model never named
      // it in prose" — a real, useful signal distinct from actual absence, so
      // it gets its own badge instead of a confusing "×0" and no bar.
      if (b.count > 0) {
        head.append(el("div", { className: "brand-meter", title: `Named ${b.count} time${b.count === 1 ? "" : "s"} in this answer` },
          el("div", { className: "brand-meter-fill", style: `width:${Math.round((b.count / maxCount) * 100)}%` })));
        head.append(el("span", { className: "brand-count" }, `×${b.count}`));
      } else {
        head.append(el("span", { className: "tag fetched brand-shown-tag", title: "Appeared in a product/place card but was not named in the written answer" }, "Shown, not named"));
      }
      item.append(head);

      // Models and aspects share one wrapping line: two half-empty rows of
      // chips per brand was most of the old card's height.
      const chips = el("div", { className: "brand-chips" });
      // The SKUs folded in by normalizeMentions are models by definition, and
      // are the most specific thing known about this brand in this answer.
      const models = [...new Set([
        ...(b.skus || []),
        ...extractBrandModels(b.brand, rec.products, rec.answerText || b.passages[0] || ""),
      ])];
      if (models.length) {
        chips.append(el("span", { className: "brand-label" }, "Models"));
        models.forEach((mName) => chips.append(el("span", { className: "tag model-tag" }, mName)));
      }
      if (b.count > 0) {
        const aspects = extractBrandAspects(b.passages);
        const shown = [];
        if (category) shown.push(category);
        aspects.forEach((asp) => {
          if (!category || !category.toLowerCase().includes(asp.toLowerCase())) shown.push(asp);
        });
        if (shown.length) {
          chips.append(el("span", { className: "brand-label" }, "Cited for"));
          shown.forEach((asp, i) => chips.append(
            el("span", { className: `tag aspect-tag${i === 0 && category ? " highlight-aspect" : ""}` }, asp)));
        }
      }
      // Stance, when the on-device model assessed it. Only "recommended" and
      // "negative" are shown: a plain mention is the default reading already,
      // and `stance: null` means NOT ASSESSED (no Gemini Nano on this device)
      // — rendering that as "neutral" would report a verdict nobody made.
      if (b.stance === "recommended" || b.stance === "negative") {
        chips.append(el("span", {
          className: `tag stance-tag stance-${b.stance}`,
          title: b.stance === "recommended"
            ? "This answer puts the brand forward as a good choice"
            : "This answer advises against the brand or calls it out as a poor choice",
        }, b.stance === "recommended" ? "Recommended" : "Advised against"));
      }
      if (chips.childNodes.length) item.append(chips);
      list.append(item);
    });
    bc.append(list);
    bc.classList.add("analyze-brand-slot");
    brandCard = bc;
  }

  // 4b. Search Funnel — what the engine RETRIEVED vs. what it actually wrote.
  //
  // Held in a variable (not appended to the sidebar) so it can be placed
  // directly beneath Brand Mentions in both layouts: this only makes sense
  // read second, as the counterpart to "who did get mentioned". It used to
  // live in the sidebar, which in the narrow popup renders BEFORE the brand
  // card — the reverse of the intended reading order.
  //
  // All of the analysis lives in src/lib/funnel-omitted.js; this is rendering
  // only. It was moved out because every bug this section has had was a logic
  // bug unreachable by tests while it sat inside a DOM-building function.
  let funnelCard = null;
  const brandMatrixData = computeBrandMatrix(rec);
  if (rec.sources && rec.sources.length) {
    const { omittedBrands: omittedBrandsList, omittedModels: omittedModelsList } =
      computeSearchFunnel(rec);
    const mentionedMatrixBrands = (brandMatrixData.brands || []).filter((b) => b.mentioned);
    const domainMatrixList = brandMatrixData.domains || [];

    if (omittedBrandsList.length || omittedModelsList.length || mentionedMatrixBrands.length || domainMatrixList.length) {
      const fc = el("div", { className: "card", id: "card-omitted-analysis" });
      fc.append(
        el("div", { className: "card-header" },
          el("h3", {}, "Brand & Domain Citation Matrix"),
          el("span", { className: "tag fetched", style: "font-size:10px" },
            `${omittedBrandsList.length} dropped · ${mentionedMatrixBrands.length} mentioned · ${domainMatrixList.length} domains`)
        ),
        el("div", { className: "muted", style: "font-size:11px; margin-bottom:10px; line-height:1.45" },
          "Cross-references which cited sources and domains contain each brand vs where blind spots occur. " +
          "Click any row to expand details.")
      );

      // Reusable expandable row builder
      const rowFor = (label, badge, badgeClass, sourceIdxs, models, accent, subLabel, missingIdxs) => {
        const row = el("div", { className: "funnel-row" });
        const head = el("button", { className: "funnel-head", type: "button" });
        head.append(
          el("span", { className: "funnel-dot", style: `background:${accent}` }),
          el("span", { className: "funnel-name" }, label),
          el("span", { className: `tag ${badgeClass} funnel-badge` }, badge)
        );
        const body = el("div", { className: "funnel-body", style: "display:none" });
        if (subLabel) {
          body.append(el("div", { className: "muted small", style: "margin-bottom:4px" }, subLabel));
        }
        if (models && models.length) {
          const mr = el("div", { className: "funnel-models" });
          mr.append(el("span", { className: "brand-label" }, "In snippets:"));
          models.forEach((m) => mr.append(el("span", { className: "tag model-tag" }, m.model || m)));
          body.append(mr);
        }
        if (sourceIdxs && sourceIdxs.length) {
          const secTitle = el("div", { className: "brand-label", style: "font-size:11px; margin-top:3px" }, "Supporting citations:");
          body.append(secTitle);
          sourceIdxs.forEach((idx) => {
            const s = rec.sources[idx];
            if (!s) return;
            body.append(el("a", {
              href: s.url, target: "_blank", rel: "noreferrer", className: "omit-source-link",
            }, s.title || s.domain || s.url));
          });
        }
        if (missingIdxs && missingIdxs.length) {
          const secTitle = el("div", { className: "brand-label", style: "font-size:11px; margin-top:5px; color:var(--fg-muted)" }, "Citations omitting this brand:");
          body.append(secTitle);
          missingIdxs.slice(0, 5).forEach((idx) => {
            const s = rec.sources[idx];
            if (!s) return;
            body.append(el("a", {
              href: s.url, target: "_blank", rel: "noreferrer", className: "omit-source-link", style: "opacity:0.75"
            }, `(Omitted) ${s.title || s.domain || s.url}`));
          });
        }
        head.onclick = () => {
          const open = body.style.display !== "none";
          body.style.display = open ? "none" : "flex";
          row.classList.toggle("open", !open);
        };
        row.append(head, body);
        return row;
      };

      const list = el("div", { className: "funnel-list" });

      // 1. Mentioned Brands Citation Support
      if (mentionedMatrixBrands.length) {
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:600; margin:6px 0 2px 4px; color:var(--fg-secondary)" }, "MENTIONED BRANDS ATTRIBUTION"));
        mentionedMatrixBrands.forEach((mb) => {
          const pct = Math.round(mb.attributionRate * 100);
          list.append(rowFor(
            mb.brand,
            `${mb.supportedSourceIdxs.length}/${rec.sources.length} sources (${pct}%)`,
            "cited", mb.supportedSourceIdxs, null, "#10b981",
            `Appears in ${mb.supportedSourceIdxs.length} of ${rec.sources.length} cited sources.`,
            mb.missingSourceIdxs
          ));
        });
      }

      // 2. Omitted Brands & Skipped Models
      if (omittedBrandsList.length || omittedModelsList.length) {
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:600; margin:10px 0 2px 4px; color:var(--fg-secondary)" }, "SEARCH FUNNEL DROPOUTS (RETRIEVED BUT NOT WRITTEN)"));
        omittedBrandsList.forEach((ob) => {
          list.append(rowFor(
            ob.brand,
            `${ob.sourceIdxs.length} source${ob.sourceIdxs.length === 1 ? "" : "s"}`,
            "danger", ob.sourceIdxs, ob.models, "#ef4444",
            "Found in search snippets but never written into the final response."
          ));
        });
        omittedModelsList.forEach((om) => {
          const idxs = [...new Set(om.omittedModels.flatMap((m) => [...m.sourceIdxs]))];
          list.append(rowFor(
            om.brand,
            `${om.omittedModels.length} model${om.omittedModels.length === 1 ? "" : "s"} skipped`,
            "fetched", idxs, om.omittedModels, "#f59e0b",
            "Parent brand was mentioned, but these specific models from snippets were omitted."
          ));
        });
      }

      // 3. Domain Coverage & Blind Spots
      if (domainMatrixList.length) {
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:600; margin:10px 0 2px 4px; color:var(--fg-secondary)" }, "DOMAIN-LEVEL BRAND COVERAGE & BLIND SPOTS"));
        domainMatrixList.forEach((dm) => {
          const pct = Math.round(dm.coverageRate * 100);
          const subText = `Domain covers ${dm.coveredBrands.length} brands: ${dm.coveredBrands.join(", ") || "None"}. ` +
            (dm.missingBrands.length ? `Blind spots: ${dm.missingBrands.join(", ")}.` : "Full brand coverage.");
          list.append(rowFor(
            dm.domain,
            `${pct}% coverage (${dm.urlCount} URL${dm.urlCount === 1 ? "" : "s"})`,
            dm.coverageRate >= 0.6 ? "cited" : "fetched", dm.sourceIdxs, null,
            dm.coverageRate >= 0.6 ? "#3b82f6" : "#8b5cf6",
            subText
          ));
        });
      }

      fc.append(list);
      funnelCard = fc;
    }
  }

  // 5. Clickable Summary Card in Sidebar
  {
    const rows = [
      ["Cited (sidebar top)", citedN, "card-sources"],
      ["Fetched (more)", fetchedN, "card-sources"],
      ["News", newsCount, "card-sources"],
      ["Products", rec.products.length, "card-products"],
      ["Images", rec.images.length, "card-images"],
      ["Entities", rec.entities.length, "card-entities"],
      ["Brand mentions", rec.brandMentions.length, "card-brand-mentions"],
    ].filter((r) => r[1] > 0);
    
    if (rows.length) {
      const summaryCard = el("div", { className: "card", id: "card-summary" }, el("h3", {}, "Summary by Type"));
      const t = el("table", { className: "summary-table" });
      t.append(el("tr", {}, el("th", {}, "Link type"), el("th", { className: "num" }, "Count")));
      rows.forEach(([k, v, targetId]) => {
        const rowEl = el("tr", { className: "summary-row", title: `Click to jump to ${k}` });
        rowEl.append(el("td", {}, k), el("td", { className: "num" }, String(v)));
        rowEl.onclick = () => scrollToCard(targetId);
        t.append(rowEl);
      });
      // Total Row
      const totalRow = el("tr", { style: "font-weight:600; border-top:1px solid var(--border);" },
        el("td", {}, "TOTAL"),
        el("td", { className: "num" }, String(rec.sources.length))
      );
      t.append(totalRow);
      summaryCard.append(t);
      summaryCard.classList.add("analyze-ref");
  sidebar.append(summaryCard);
    }
  }

  // Column 2: Main Area (Fan-outs, Top Domains, Top URLs, Places, Products)
  const mainCol = el("div", { className: "analyze-main" });

  // Extended Thinking & Reasoning Trace (Gemini / Grok)
  if (ps.thinkingTrace || (ps.thoughts && ps.thoughts.length)) {
    const traceText = ps.thinkingTrace || (Array.isArray(ps.thoughts) ? ps.thoughts.join("\n\n") : String(ps.thoughts));
    const thinkCard = el("div", { className: "card", id: "card-thinking" },
      el("div", { className: "card-header" },
        el("h3", {}, "Extended Thinking & Reasoning Trace"),
        el("span", { className: "tag" }, "🧠 Model Internal Logic")
      ),
      el("div", { className: "muted small", style: "margin-bottom:8px" },
        "Verbatim reasoning trace captured during response generation, showing synthesis steps and retrieval evaluation."),
      el("pre", {
        style: "white-space:pre-wrap; font-family:var(--font-mono, monospace); font-size:11px; line-height:1.4; max-height:220px; overflow-y:auto; background:var(--bg-subtle); padding:10px 12px; border-radius:8px; border:1px solid var(--border);"
      }, traceText)
    );
    mainCol.append(thinkCard);
  }

  // Real-Time Social Citations (Grok X/Twitter Posts)
  if (ps.socialCitations && ps.socialCitations.length) {
    const socCard = el("div", { className: "card", id: "card-social-citations" },
      el("div", { className: "card-header" },
        el("h3", {}, "Social Media & X Citations"),
        el("span", { className: "tag cited" }, `🐦 ${ps.socialCitations.length} Posts Cited`)
      )
    );
    const socList = el("ul", { className: "src-list" });
    ps.socialCitations.forEach((sc) => {
      const li = el("li", { className: "src-item" });
      const row = el("div", { className: "src-row", style: "display:flex; justify-content:space-between; align-items:center;" },
        el("a", { href: sc.url, target: "_blank", rel: "noreferrer", className: "src-title" },
          sc.author ? `@${sc.author}` : sc.url
        ),
        el("div", { style: "display:flex; gap:6px;" },
          sc.likes != null ? el("span", { className: "tag" }, `❤️ ${sc.likes.toLocaleString()} likes`) : "",
          sc.reposts != null ? el("span", { className: "tag" }, `🔁 ${sc.reposts.toLocaleString()} reposts`) : ""
        )
      );
      li.append(row);
      if (sc.snippet) li.append(el("div", { className: "src-snip muted small", style: "margin-top:4px" }, sc.snippet));
      socList.append(li);
    });
    socCard.append(socList);
    mainCol.append(socCard);
  }

// Social vs. Editorial Authority Split
  if (rec.sources && rec.sources.length) {
    const auth = computeAuthoritySplit(rec.sources, ps.socialCitations);
    if (auth.socialCount > 0) {
      const authCard = el("div", { className: "card", id: "card-authority-split" },
        el("div", { className: "card-header" },
          el("h3", { "data-term": "socialAuthoritySplit" }, "Social vs. Web Authority Split"),
          el("span", { className: "tag" }, `${auth.socialCount} Social · ${auth.webCount} Editorial Web`)
        ),
        el("div", { className: "muted small", style: "margin-bottom:8px" },
          "Measures what fraction of the model's grounding came from live peer social posts (e.g. X/Twitter) versus traditional web editorial articles."),
        el("div", {
          style: "display:flex; height:20px; border-radius:6px; overflow:hidden; border:1px solid var(--border); margin-bottom:8px;",
        },
          el("div", {
            style: `width:${auth.socialPct}%; background:#1d9bf0; color:#fff; font-size:10px; font-weight:600; display:flex; align-items:center; justify-content:center;`,
            title: `Social Authority (X/Twitter): ${auth.socialPct}%`,
          }, auth.socialPct > 15 ? `🐦 ${auth.socialPct}% Social` : ""),
          el("div", {
            style: `width:${auth.webPct}%; background:#10b981; color:#fff; font-size:10px; font-weight:600; display:flex; align-items:center; justify-content:center;`,
            title: `Editorial Web Authority: ${auth.webPct}%`,
          }, auth.webPct > 15 ? `🌐 ${auth.webPct}% Web` : "")
        )
      );
      mainCol.append(authCard);
    }
  }

  // Search Funnel goes first in the main column so it reads immediately after
  // Brand Mentions in BOTH layouts — the popup stacks brand slot then main,
  // and the full-screen grid puts the brand card at the top of this same
  // column. It answers the follow-up question to Brand Mentions ("who got
  // left out"), so anywhere else breaks the narrative.
  if (funnelCard) mainCol.append(funnelCard);

  // 1. Query Fan-Out queries card
  //
  // An empty card used to be hidden outright, which reads as "this answer ran
  // no searches" — misleading on Gemini, which runs them but never publishes
  // the sub-queries (see extractFanout in src/adapters/gemini.js). Say which
  // of the two it is rather than showing nothing.
  //
  // The badge used to say ONLY "not exposed by Gemini" — read on its own
  // (which is how a badge usually gets read, before the paragraph below it)
  // that sounds like doubt about whether a search happened at all. It did:
  // `rec.searched` here is set from Gemini's own tool-use signal in the raw
  // payload (a "Google Search" / "Searching the web" marker), the same
  // signal that drives "Tool Name" in Technical Information. So the
  // confirmation leads, and the limitation is the second, explanatory tag.
  if (!fanCount && rec.searched && rec.platform === "gemini") {
    mainCol.append(el("div", { className: "card", id: "card-fanout" },
      el("div", { className: "card-header" },
        el("h3", {}, "Query Fan-Out"),
        el("span", { className: "tag cited" }, "🔍 Searched the web"),
        el("span", {
          className: "tag", "data-tip":
            "Confirmed by Gemini's own tool-use signal in the raw response, the same one that drives “Tool Name” above — this isn't a guess.",
        }, "sub-queries not published")
      ),
      el("p", { className: "muted", style: "margin:0" },
        "Gemini confirms it searched the web for this answer, but — unlike ChatGPT — it doesn't " +
        "publish the specific sub-queries it ran, so there's nothing to list below. That's a " +
        "platform limitation on Gemini's side, not a failed or incomplete capture.")
    ));
  }
  if (fanCount) {
    const fc = el("div", { className: "card", id: "card-fanout" },
      el("div", { className: "card-header" },
        el("h3", {}, "Query Fan-Out"),
        el("span", { className: "tag cited" }, `${rec.model || rec.platform || "unknown model"}`)
      )
    );
    // Retrieval-strategy read-out. The raw sub-queries were already listed
    // below; this surfaces what's IN them — which sites the engine scoped
    // its searches to, how long/specific the queries are, and what angles it
    // researched. See src/lib/fanout.js for why each of these is tracked.
    const allQ = []
      .concat(rec.fanout.search || [], rec.fanout.shopping || [], rec.fanout.image || []);
    const fa = analyzeFanout(allQ, rec.sources || []);

    const stats = el("div", { className: "fanout-stats" });
    const statTile = (n, label, title) =>
      el("div", { className: "fanout-stat", title: title || "" },
        el("div", { className: "fanout-stat-n" }, String(n)),
        el("div", { className: "fanout-stat-l" }, label));
    stats.append(statTile(fa.count, "sub-queries",
      `Typical is ${FANOUT_BENCHMARK.typicalBandLow}-${FANOUT_BENCHMARK.typicalBandHigh} per prompt (mean ~${FANOUT_BENCHMARK.meanPerPrompt}); longest chain observed in published study data is ${FANOUT_BENCHMARK.maxObserved}.`));
    stats.append(statTile(fa.avgWords, "avg words/query",
      `Fan-out queries have grown from ~${FANOUT_BENCHMARK.priorMeanWords} words to ~${FANOUT_BENCHMARK.meanWords}. Longer queries reward pages matching specific detail over broad head terms.`));
    stats.append(statTile(fa.scopedDomains.length, "site: domains",
      "Domains the engine restricted a search to with the site: operator — a direct read on which sources it treats as authoritative here."));
    stats.append(statTile(fa.temporalCount, "time-qualified",
      "Sub-queries carrying a year or a recency word — the engine explicitly wanted current information."));
    fc.append(stats);

    const verdict = el("div", { className: `fanout-verdict band-${fa.benchmark.band}` },
      `Breadth: ${fa.benchmark.label}.`);
    fc.append(verdict);

    // site: is the headline operator — ChatGPT has moved to using it heavily
    // to curate which sources it pulls from, so which domains it scoped to
    // (and whether they actually earned a citation) is the useful part.
    if (fa.scopedDomains.length) {
      fc.append(el("div", { className: "fanout-sub" }, "Searches scoped to specific sites (site:)"));
      const sd = el("div", { className: "chips" });
      fa.scopedDomains.forEach((d) => {
        const chip = el("span", {
          className: `chip site-chip${d.cited ? " site-cited" : " site-uncited"}`,
          title: d.cited
            ? `${d.domain} was searched directly and something from it was used in the answer.`
            : `${d.domain} was searched directly, but nothing from it made it into the answer — the engine looked there and wasn't satisfied.`,
        }, `${d.cited ? "✓" : "○"} ${d.domain}${d.count > 1 ? ` ×${d.count}` : ""}`);
        sd.append(chip);
      });
      fc.append(sd);
      if (fa.scopedNotCited.length) {
        fc.append(el("div", { className: "muted small", style: "margin-top:6px" },
          `${fa.scopedNotCited.length} of ${fa.scopedDomains.length} scoped ${fa.scopedNotCited.length === 1 ? "domain was" : "domains were"} searched but not cited — the engine went looking there and used nothing.`));
      }
    } else {
      // A bare "0" tile says nothing. Zero site:-scoped searches is itself a
      // finding for GEO work — it means the engine went to the open web for
      // this prompt instead of restricting to domains it already trusts, so
      // ranking in open search is what decides whether you appear.
      fc.append(el("div", { className: "muted small", style: "margin-top:2px" },
        "No site:-scoped searches: the engine queried the open web rather than restricting to " +
        "domains it already treats as authoritative. Ranking in ordinary search is what decides " +
        "inclusion here."));
    }

    if (fa.excludedDomains.length) {
      fc.append(el("div", { className: "fanout-sub" }, "Explicitly excluded (-site:)"));
      const ed = el("div", { className: "chips" });
      fa.excludedDomains.forEach((d) => ed.append(el("span", { className: "chip site-excluded" }, `− ${d.domain}`)));
      fc.append(ed);
    }

    if (fa.intents.length) {
      fc.append(el("div", { className: "fanout-sub" }, "What the engine researched"));
      const ic2 = el("div", { className: "chips" });
      fa.intents.forEach((i) => ic2.append(el("span", { className: "chip" }, `${i.key} ×${i.count}`)));
      fc.append(ic2);
    }

    if (fa.operators.length) {
      fc.append(el("div", { className: "fanout-sub" }, "Search operators used"));
      const oc = el("div", { className: "chips" });
      fa.operators.forEach((o) => oc.append(el("span", { className: "chip" }, `${o.key} ×${o.count}`)));
      fc.append(oc);
    }

    let qIdx = 1;
    for (const [bucket, arr] of Object.entries(rec.fanout || {})) {
      if (!arr || !arr.length) continue;
      fc.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, bucket));
      const chips = el("div", { className: "chips" });
      arr.forEach((q) => {
        const qStr = typeof q === "string" ? q : q?.query || "";
        if (qStr) chips.append(el("span", { className: "chip" }, `${qIdx++}. ${qStr}`));
      });
      fc.append(chips);
    }

    if (rec.products && rec.products.length) {
      fc.append(el("div", { className: "muted", style: "margin-top:10px;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, "Shopping Carousel Products"));
      const pChips = el("div", { className: "chips" });
      rec.products.forEach((p, idx) => {
        const renderTag = (p.renderAs || "block").toUpperCase();
        if (renderTag === "HERO") {
          pChips.append(el("span", {
            className: "chip active",
            style: "background: #f59e0b; color: #fff; font-weight: 500; border: 1px solid #d97706; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
          }, `⭐ HERO PICK: ${p.name}`));
        } else {
          pChips.append(el("span", { className: "chip" }, `${idx + 1}. BLOCK · ${p.name}`));
        }
      });
      fc.append(pChips);
    }
    mainCol.append(fc);
  }

  // 2. Top Domains Card
  if (rec.sources.length) {
    const domCount = new Map();
    const domTypes = new Map();
    rec.sources.forEach((s) => {
      if (!s.domain) return;
      domCount.set(s.domain, (domCount.get(s.domain) || 0) + 1);
      const set = domTypes.get(s.domain) || new Set();
      set.add(s.outcome);
      if (s.type === "news") set.add("news");
      domTypes.set(s.domain, set);
    });

    const topDomHead = el("div", { className: "card-header" }, el("h3", {}, `Top Domains (${domCount.size})`));
    const topDomCard = el("div", { className: "card", id: "card-top-domains" }, topDomHead);
    const dt = el("table", {});
    dt.append(el("tr", {}, el("th", {}, "Domain"), el("th", {}, "Type"), el("th", { className: "num" }, "URLs")));
    
    [...domCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([d, count]) => {
      const tagGroup = el("div", { className: "type-tag-group" });
      [...(domTypes.get(d) || [])].forEach((typ) =>
        tagGroup.append(el("span", { className: `tag ${typ === "news" ? "news" : typ}` }, typ))
      );
      const tagCell = el("td", {}, tagGroup);
      
      const domLink = el("button", { className: "linkbtn td-domain-btn", title: fmt("Click for detailed URLs under {site}", { site: d }) }, d);
      domLink.onclick = () => openDomainModal(d, rec);

      dt.append(el("tr", {}, el("td", { className: "td-domain" }, domLink), tagCell, el("td", { className: "num" }, String(count))));
    });
    topDomCard.append(dt);
    mainCol.append(topDomCard);
  }

  // 3. Top URLs Card (Merged list with Rank, Snippets & Char Counts)
  if (rec.sources.length) {
    const sc = el("div", { className: "card", id: "card-sources" });
    // Snippets are off by default: they are what the engine's search returned
    // for a page, not the sentence that justified the citation, and at ~27
    // sources they were the single biggest block of text on the page. The
    // toggle keeps the jump-to-passage links one click away rather than
    // deleting them.
    let showSnippets = false;
    let showAllSources = false;
    const snipToggle = el("button", { className: "linkbtn", type: "button" }, "Show snippets");
    const srcHead = el("div", { className: "card-header" },
      el("h3", {}, `Sources (${rec.sources.length})`),
      snipToggle
    );
    sc.append(srcHead);

    // Filter Pills
    const filterBar = el("div", { className: "filter-bar" });
    let activeSrcFilter = "all";
    const renderSrcList = () => {
      ul.textContent = "";
      const filtered = rec.sources.filter((s) => {
        if (activeSrcFilter === "all") return true;
        if (activeSrcFilter === "cited") return s.outcome === "cited";
        if (activeSrcFilter === "fetched") return s.outcome === "fetched";
        if (activeSrcFilter === "news") return isNews(s);
        const pipe = pipelineOf(s.platformSpecific && s.platformSpecific.pipeline);
        if (activeSrcFilter === "labrador") return !!pipe && pipe.kind === "openai";
        if (activeSrcFilter === "external") return !!pipe && pipe.kind !== "openai";
        return true;
      });

      const order = { cited: 0, fetched: 1, mentioned: 2, unknown: 3 };
      const ranked = [...filtered].sort((a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9));
      // Cited sources sort first, so the first ten are the ones that actually
      // shaped the answer — the long fetched-but-unused tail is one click away
      // instead of running the card to several screens.
      const SRC_PREVIEW = 10;
      const visible = showAllSources ? ranked : ranked.slice(0, SRC_PREVIEW);

      // Every sub-query the engine ran, for the title check on read-only
      // sources below (fanout.js titleMatchesQueries).
      const allQueries = Object.values(rec.fanout || {}).flatMap((arr) => arr || []);

      visible.forEach((s, idx) => {
        const li = el("li", { className: "src-item" });
        const header = el("div", { className: "src-header" });
        
        header.append(el("span", { className: "url-rank-badge" }, `#${idx + 1}`));
        header.append(el("span", { className: `tag ${s.outcome}` }, s.outcome));

        // Where it came from (lib/retrieval.js): the pipeline, when ChatGPT
        // named one, then the kind of result. The kind replaces the old
        // "news" tag wherever the engine states it.
        const sps = s.platformSpecific || {};
        const pipe = pipelineOf(sps.pipeline);
        if (pipe) {
          header.append(el("span", {
            className: `tag ${pipe.kind === "openai" ? "pipe-openai" : "pipe-external"}`,
            title: pipe.note,
          }, pipe.kind === "openai" ? pipe.label : `Web · ${pipe.label}`));
        }
        const kind = typeLabel(sps.refType || sps.resultSource);
        if (kind) header.append(el("span", { className: "tag src-type", title: "The kind of result, as the engine labelled it" }, kind));
        else if (s.type === "news") header.append(el("span", { className: "tag news" }, "news"));
        
        if (s.outcome === "fetched" && titleMatchesQueries(s.title, allQueries) === false) {
          header.append(el("span", {
            className: "tag src-mismatch",
            title: "Read but not cited, and the title shares no word with anything the engine searched. Cited pages tend to have titles closer to the searches — try retitling it in the searcher's words.",
          }, "title mismatch"));
        }

        const titleLink = el("a", { href: s.url, target: "_blank", rel: "noreferrer", className: "src-title" }, s.title || s.url);
        header.append(titleLink);
        li.append(header);
        
        const snippetText = showSnippets && s.snippet ? s.snippet.trim() : null;
        if (snippetText) {
          const snipBox = el("div", { className: "url-snippet-box" });
          // Text-fragment deep link: jumps to where this exact text appears
          // on the SOURCE page (not the ChatGPT conversation) if the browser
          // can find it verbatim — quietly does nothing if it can't, rather
          // than erroring, since this snippet is what ChatGPT's search
          // returned for the page and isn't guaranteed to be present
          // word-for-word (see the card's note above).
          const textTarget = encodeURIComponent(snippetText.slice(0, 120).trim());
          const fragUrl = s.url ? `${s.url}#:~:text=${textTarget}` : null;
          if (fragUrl) {
            snipBox.append(el("a", {
              href: fragUrl, target: "_blank", rel: "noreferrer", className: "url-snippet-link",
              title: "Try to jump to this text on the source page",
            }, snippetText));
          } else {
            snipBox.append(snippetText);
          }
          snipBox.append(el("span", { className: "char-badge" }, `[${snippetText.length}c]`));
          li.append(snipBox);
        }

        const d = s.platformSpecific && s.platformSpecific.pubDate;
        const dMs = d ? (d > 1e12 ? d : d * 1000) : null; // auto-detect seconds vs milliseconds
        const dateStr = dMs ? new Date(dMs).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : null;
        const meta = el("div", { className: "src-meta" });
        meta.append(el("span", { className: "src-domain" }, s.domain || "—"));
        if (dateStr) {
          meta.append(el("span", { className: "src-dot" }, "·"), el("span", {}, dateStr));
        }
        li.append(meta);
        // The page's own address, not just its site: which page on
        // makemytrip.com was read is the actionable part.
        if (s.url) li.append(el("span", { className: "src-url", title: s.url }, displayUrl(s.url)));

        const sm = brandMatrixData && brandMatrixData.sources && brandMatrixData.sources.find((src) => src.url === s.url || src.sourceIdx === rec.sources.indexOf(s));
        if (sm && ((sm.presentBrands && sm.presentBrands.length) || (showSnippets && sm.missingBrands && sm.missingBrands.length))) {
          const brandsRow = el("div", { className: "src-brand-row", style: "display:flex; flex-wrap:wrap; gap:3px; margin-top:4px" });
          (sm.presentBrands || []).forEach((pb) => {
            brandsRow.append(el("span", {
              className: "tag",
              // Was a hardcoded light-mode-only green (bg rgba(16,185,129,.12)
              // + text #059669) — a translucent tint blended over whatever
              // sits behind it, so in dark mode it inherited the dark card
              // background underneath and the same medium-dark green text
              // read as low-contrast on it. --green-bg/--green-fg are the
              // same semantic color, already redefined per theme (dark mode
              // brightens the text and deepens the tint), and are what
              // .tag.cited already uses elsewhere for this identical
              // "present/positive" meaning.
              style: "font-size:10px; padding:1px 5px; background:var(--green-bg); color:var(--green-fg); border:1px solid var(--green-border); border-radius:4px"
            }, `+ ${pb}`));
          });
          if (showSnippets && sm.missingBrands && sm.missingBrands.length) {
            sm.missingBrands.slice(0, 4).forEach((mb) => {
              brandsRow.append(el("span", {
                className: "tag",
                style: "font-size:10px; padding:1px 5px; background:rgba(100, 116, 139, 0.08); color:var(--fg-muted); border:1px solid rgba(100, 116, 139, 0.2); border-radius:4px"
              }, `- ${mb}`));
            });
          }
          li.append(brandsRow);
        }

        
        ul.append(li);
      });

      if (ranked.length > visible.length) {
        const more = el("button", { className: "linkbtn src-more", type: "button" },
          `Show all ${ranked.length} sources`);
        more.onclick = () => { showAllSources = true; renderSrcList(); };
        ul.append(el("li", { className: "src-more-row" }, more));
      } else if (showAllSources && ranked.length > 10) {
        const less = el("button", { className: "linkbtn src-more", type: "button" }, "Show fewer");
        less.onclick = () => { showAllSources = false; renderSrcList(); };
        ul.append(el("li", { className: "src-more-row" }, less));
      }
    };
    snipToggle.onclick = () => {
      showSnippets = !showSnippets;
      snipToggle.textContent = showSnippets ? "Hide snippets" : "Show snippets";
      renderSrcList();
    };

    const mix = retrievalMix(rec.sources);
    const filters = [
      { id: "all", label: `All (${rec.sources.length})` },
      { id: "cited", label: `Cited (${citedN})` },
      { id: "fetched", label: `Fetched (${fetchedN})` },
      { id: "news", label: `News (${newsCount})` },
      ...(mix.openai ? [{ id: "labrador", label: `Labrador (${mix.openai})` }] : []),
      ...(mix.external ? [{ id: "external", label: `External web (${mix.external})` }] : []),
    ];

    // Where this answer's sources came from. The pipeline is shown only when
    // ChatGPT named it; see lib/retrieval.js for why nothing is inferred.
    if (rec.platform === "chatgpt" && rec.sources.length) {
      const line = el("div", { className: "retrieval-mix" });
      line.append(el("span", { className: "mix-label" }, "Pipeline"));
      if (mix.pipelines.length) {
        mix.pipelines.forEach(({ label, kind, count }) => {
          line.append(el("span", { className: `tag ${kind === "openai" ? "pipe-openai" : "pipe-external"}` }, `${label} ${count}`));
        });
        if (mix.unlabelled) line.append(el("span", {}, `${mix.unlabelled} not labelled`));
      } else {
        line.append(el("span", { title: "ChatGPT sent result_source, naming the index behind each result, only from 21 May to 21 July 2026." },
          "not labelled — ChatGPT only named it from 21 May to 21 July 2026"));
      }
      if (mix.types.length) {
        line.append(el("span", { className: "mix-label", style: "margin-left:8px" }, "Types"));
        line.append(el("span", {}, mix.types.map(({ label, count }) => `${label} ${count}`).join(" · ")));
      }
      sc.append(line);

      // Which of ChatGPT's retrieval engines this answer's stream names —
      // OpenAI's own (Labrador) apart from external ones. Only present when
      // the stream carries the engine data (see lib/retrieval.js).
      const engines = (rec.platformSpecific && rec.platformSpecific.enginesNamed) || [];
      if (engines.length) {
        const eline = el("div", { className: "retrieval-mix engines-named" });
        eline.append(el("span", { className: "mix-label" }, "Engines in stream"));
        engines.forEach(({ name, count }) => {
          const p = pipelineOf(name);
          eline.append(el("span", {
            className: `tag ${p && p.kind === "openai" ? "pipe-openai" : "pipe-external"}`,
            title: p ? p.note : name,
          }, count > 1 ? `${name} ×${count}` : name));
        });
        sc.append(eline);
      }
    }

    filters.forEach((f) => {
      const p = el("button", { className: `filter-pill ${f.id === "all" ? "active" : ""}` }, f.label);
      p.onclick = () => {
        filterBar.querySelectorAll(".filter-pill").forEach((b) => b.classList.remove("active"));
        p.classList.add("active");
        activeSrcFilter = f.id;
        renderSrcList();
      };
      filterBar.append(p);
    });

    sc.append(filterBar);
    const ul = el("ul", { className: "srclist" });
    sc.append(ul);
    renderSrcList();
    mainCol.append(sc);
  }

  // Places list card
  if (rec.places && rec.places.length) {
    const plc = el("div", { className: "card", id: "card-places" }, el("h3", {}, `Places (${rec.places.length})`));
    const ul = el("ul", { className: "itemlist" });
    rec.places.forEach((p) => {
      const li = el("li", {});
      const head = el("div", { className: "item-head" });
      head.append(el("span", { className: "item-name" }, p.name || "—"));
      if (p.rating != null) {
        const label = p.reviews ? `${p.rating} ★ (${p.reviews.toLocaleString()})` : `${p.rating} ★`;
        head.append(el("span", { className: "tag cited" }, label));
      }
      li.append(head);
      const meta = [p.category, p.priceRange].filter(Boolean).join("  ·  ");
      if (meta) li.append(el("div", { className: "dom" }, meta));
      if (p.address) li.append(el("div", { className: "muted item-sub" }, p.address));
      if (p.hours) li.append(el("div", { className: "muted item-sub" }, `🕒 ${p.hours}`));
      // Contact/verification row: exactly the "is this business represented
      // correctly?" signals a GEO audit cares about — phone, website, map listing.
      const links = el("div", { className: "chips", style: "margin-top:4px" });
      if (p.isOpen != null) links.append(el("span", { className: `tag ${p.isOpen ? "cited" : "fetched"}` }, p.isOpen ? "Open now" : "Closed now"));
      if (p.phone) links.append(el("span", { className: "chip" }, `📞 ${p.phone}`));
      if (p.website) links.append(el("a", { className: "chip", href: p.website, target: "_blank", rel: "noreferrer" }, "🌐 Website"));
      if (p.mapsUrl) links.append(el("a", { className: "chip", href: p.mapsUrl, target: "_blank", rel: "noreferrer" }, "📍 Maps"));
      const sup = supplierOf(p.supplier);
      if (sup) links.append(el("span", { className: "tag src-type", title: sup.note || "The feed ChatGPT names for this listing" }, `via ${sup.code}`));
      if (links.childNodes.length) li.append(links);
      ul.append(li);
    });
    plc.append(ul);
    mainCol.append(plc);
  }

  // Products list card
  const allProducts = [...(rec.products || [])];

  // Flag a hero pick when the answer text calls one out by name — but ONLY on
  // a product that's already in the captured shopping data. This used to
  // fabricate a brand-new product (invented price/merchant/rating) whenever
  // the regex match didn't line up with a real product, e.g. matching a
  // stray word like "camera" out of "camera quality is your #1 priority" and
  // presenting it as a ₹44,999 "Official Brand Store" pick that was never in
  // the actual response. An export must never show data the model didn't
  // actually provide, so a miss here just means no hero badge — never a
  // synthesized product.
  if (rec.answerText && /best overall|#1 recommendation|my #1|my pick/i.test(rec.answerText)) {
    const heroMatch = rec.answerText.match(/(?:best overall|#1 recommendation|my #1|my pick)[:\s\-]*\s*\*?\*?([A-Za-z0-9][a-zA-Z0-9\s\-]{2,40})\*?\*?/i);
    if (heroMatch && heroMatch[1]) {
      const heroWords = heroMatch[1].trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      // Require a real product name to share at least two meaningful words
      // with the matched phrase (not just one generic word like "camera" or
      // "phone") before trusting the match.
      const existingHero = allProducts.find((p) => {
        if (!p.name) return false;
        const nameWords = p.name.toLowerCase().split(/\s+/);
        const overlap = heroWords.filter((w) => nameWords.some((nw) => nw.includes(w) || w.includes(nw)));
        return overlap.length >= Math.min(2, heroWords.length);
      });
      if (existingHero) existingHero.isHero = true;
    }
  }

  if (allProducts.length) {
    const pc = el("div", { className: "card", id: "card-products" }, el("h3", {}, `Products (${allProducts.length})`));
    // Same point as the Entities card below: this is the engine's shopping
    // carousel, not the written answer. A brand it recommended in prose
    // without carding a product simply isn't here.
    pc.append(el("div", { className: "muted small", style: "margin-top:-2px" },
      "From the engine's product cards — not everything it recommended in the answer gets carded."));
    const ul = el("ul", { className: "itemlist" });
    allProducts.forEach((p) => {
      const isHero = !!p.isHero;
      const li = el("li", {
        className: `product-item-card ${isHero ? "hero-product-card" : ""}`,
        style: `cursor: pointer; transition: all 0.2s ease; ${isHero ? "border: 1.5px solid #f59e0b; background: rgba(254,243,199,0.4);" : ""}`,
        title: "Click for merchant details, rating sources, and citation breakdown",
        onclick: () => openProductModal(p, rec)
      });

      const head = el("div", { className: "item-head" });
      const nameSpan = el("span", { className: "item-name", style: "font-weight: 500;" });
      if (isHero) {
        // Was a hand-picked pale yellow (#fef3c7/#b45309/#fde68a) that
        // happens to be close to the amber tokens but isn't wired to them —
        // stayed bright light-yellow in dark mode regardless, a jarring lit
        // patch against the rest of the dark UI. Same semantic meaning as
        // every other amber highlight in this app, so it should use the
        // same tokens and adapt with them.
        nameSpan.append(el("span", { className: "tag rank-tag", style: "background: var(--amber-bg); color: var(--amber-fg); border: 1px solid var(--amber-border); margin-right: 6px;" }, "⭐ HERO PICK"));
      }
      nameSpan.append(p.name || "—");
      head.append(nameSpan);

      if (p.rating != null) head.append(el("span", { className: "tag cited" }, `${p.rating} ★`));
      li.append(head);

      const meta = [p.price, p.merchant].filter(Boolean).join("  ·  ");
      if (meta) li.append(el("div", { className: "dom", style: "margin-top: 4px; font-size: 11px; color: var(--fg-muted);" }, `${meta}  ·  Click for e-commerce sources ↗`));
      ul.append(li);
    });
    pc.append(ul);
    mainCol.append(pc);
  }

  // Model reasoning trace
  if (rec.platformSpecific && rec.platformSpecific.reasoning) {
    const rc = el("div", { className: "card", id: "card-reasoning" }, el("h3", {}, "Model reasoning (thinking trace)"));
    rc.append(el("div", { className: "muted", style: "white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px;font-family:var(--font-mono);background:var(--bg-subtle);padding:8px 12px;border-radius:6px;border:1px solid var(--border);" }, rec.platformSpecific.reasoning));
    mainCol.append(rc);
  }

  // Entities card
  if (rec.entities && rec.entities.length) {
    const ec = el("div", { className: "card", id: "card-entities" }, el("h3", {}, `Entities (${rec.entities.length})`));
    // Reported as a mismatch with Brand Mentions: a brand the engine WROTE
    // about but never put in a product card is absent here, and that gap is
    // the finding, not a bug. Saying where this data comes from is what makes
    // it readable as one.
    ec.append(el("div", { className: "muted small", style: "margin-top:-2px" },
      "Tagged by the engine in its product cards — a brand it only wrote about won't appear here."));
    const byCat = {};
    rec.entities.forEach((e) => (byCat[e.category] = byCat[e.category] || []).push(e.text));
    Object.entries(byCat).forEach(([cat, list]) => {
      ec.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:500;font-size:11px;" }, cat));
      const chips = el("div", { className: "chips" });
      list.forEach((t) => chips.append(el("span", { className: "chip" }, t)));
      ec.append(chips);
    });
    mainCol.append(ec);
  }

  // Carousel images card
  if (rec.images && rec.images.length) {
    const ic = el("div", { className: "card", id: "card-images" }, el("h3", {}, `Images (${rec.images.length})`));
    const grid = el("div", { className: "imggrid" });
    rec.images.forEach((im) => {
      const fig = el("a", { href: im.url, target: "_blank", rel: "noreferrer", className: "imgcell" });
      fig.append(el("img", { src: im.url, alt: im.title || "", loading: "lazy" }));
      if (im.title) fig.append(el("div", { className: "imgcap" }, im.title));
      grid.append(fig);
    });
    ic.append(grid);
    mainCol.append(ic);
  }

  // Verbatim Grounding & Claim Integrity (2026 Grounding Innovation).
  //
  // Moved to be the LAST card in mainCol (was near the top, right after the
  // social-post card) — requested placement: a synthesized cross-check
  // against every OTHER section above it (sources, fan-out, products,
  // places, entities, images) reads better as a closing verdict than as the
  // first thing shown before any of what it's cross-referencing has been
  // seen.
  if (rec.sources && rec.sources.length && rec.answerText) {
    const vg = computeVerbatimGrounding(rec.answerText, rec.sources);
    const scoreColor = vg.score >= 70 ? "var(--accent-emerald, #10b981)" : vg.score >= 40 ? "#f59e0b" : "#ef4444";
    const grdCard = el("div", { className: "card", id: "card-grounding-integrity" },
      el("div", { className: "card-header" },
        el("h3", { "data-term": "verbatimGrounding" }, "Verbatim Grounding & Claim Integrity"),
        el("span", {
          className: "tag cited",
          style: `background:${scoreColor}18; color:${scoreColor}; border:1px solid ${scoreColor}40; font-weight:600;`,
          "data-term": "verbatimGrounding",
        }, `${vg.score}% Grounded`),
        el("span", { className: "tag", "data-term": "hallucinationGap" }, `${vg.groundedClaims}/${vg.totalClaims} Claims Substantiated`)
      ),
      el("div", { className: "muted small", style: "margin-bottom:10px" },
        `Verdict: `, el("strong", { style: `color:${scoreColor};` }, vg.verdict),
        ` — Cross-referenced against ${rec.sources.length} cited source passages and scroll-to-text anchors.`)
    );

    if (vg.claimMatches && vg.claimMatches.length) {
      const claimList = el("div", { style: "display:flex; flex-direction:column; gap:6px;" });
      vg.claimMatches.slice(0, 4).forEach((cm) => {
        const item = el("div", {
          style: "background:var(--bg-subtle, rgba(255,255,255,0.03)); border:1px solid var(--border); border-radius:6px; padding:7px 10px; font-size:12px;",
        },
          el("div", { style: "display:flex; justify-content:space-between; margin-bottom:3px; gap:8px;" },
            el("span", {
              className: "tag",
              style: `font-size:10px; padding:1px 5px; font-weight:500; background:${cm.isGrounded ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)"}; color:${cm.isGrounded ? "#10b981" : "#ef4444"};`,
            }, cm.isGrounded ? `✓ Grounded (${cm.confidence}%)` : `⚠ Unsubstantiated`),
            cm.sourceDomain ? el("span", { className: "muted small" }, `via ${cm.sourceDomain}`) : ""
          ),
          el("div", { style: "line-height:1.4;" }, `“${cm.sentence}…”`)
        );
        claimList.append(item);
      });
      grdCard.append(claimList);
    }
    mainCol.append(grdCard);
  }

  // Append columns to layout grid
  // Order matters for the narrow popup (a plain flex column); the tab layout
  // overrides placement explicitly with grid-area rules.
  grid.append(sidebar);
  if (brandCard) grid.append(brandCard);
  grid.append(mainCol);
  root.append(grid);
}

function renderAnalyze() {
  try {
    const root = $("#analyze");
    root.textContent = "";
    // The full tab's single-answer view puts its tools back (atHeaderTools);
    // every other state of Analyze leaves the bar empty.
    atHeaderNodes = null;
    setHeaderPage("analyze");
    // A specifically-requested, already-hydrated capture (viewingId) wins
    // outright — even a TRACKED one not present in the ad-hoc RECORDS list
    // (e.g. opened via Prompt Performance's "click a prompt" link). Without
    // this, RECORDS.find() below would silently miss it (tracked captures
    // are deliberately excluded from RECORDS — see the isolation note in
    // load()) and fall back to RECORDS[0], opening the wrong, most-recent
    // AD-HOC capture instead of the one actually clicked.
    let rec = viewingId ? FULL.get(viewingId) : null;
    if (!rec) {
      // Prefer the hydrated full record (carries answerText, which drives brand rank,
      // "cited for" aspects and hero-product detection). Falls back to the light row.
      const targetId = viewingId || defaultRecordId();
      const light = targetId ? RECORDS.find((r) => r.captureId === targetId) || RECORDS[0] : RECORDS[0];
      rec = light ? FULL.get(light.captureId) || light : null;
    }
    ANALYZE_SHOWN = rec;
    abNoteAnalyzed(rec);
    if (!rec) {
      /* Two different empty states, because they need different answers.
       *
       * RECORDS deliberately excludes campaign captures (see the isolation
       * note in load()), so a user who only ever runs campaigns has an empty
       * RECORDS and used to be told "No captures yet — run a prompt", while
       * a thousand captures sat in storage. Telling someone their data does
       * not exist when it does is worse than showing nothing, and it is the
       * reported "I ran a campaign, where did my results go".
       */
      if (TRACKED_COUNT > 0) {
        const box = el("div", { className: "empty" },
          el("div", {}, `Nothing selected to analyse — but ${TRACKED_COUNT} capture${TRACKED_COUNT === 1 ? "" : "s"} ${TRACKED_COUNT === 1 ? "is" : "are"} stored against your campaigns.`),
          el("div", { className: "muted small", style: "margin-top:6px" },
            "Campaign captures are kept separate from ad-hoc browsing so a tracking run can't skew your ad-hoc numbers. Open one from the Dashboard (turn on “From a campaign”) or from a prompt in the campaign's results."));
        const go = el("button", { className: "btn sm primary", style: "margin-top:10px" }, "Go to campaign results →");
        go.onclick = () => { showTab("loader"); document.getElementById("campaignResults")?.scrollIntoView({ block: "start", behavior: jumpBehavior() }); };
        box.append(go);
        root.append(box);
        return;
      }
      root.append(
        el("div", { className: "empty" },
          "No captures yet. Open ChatGPT, Gemini, Perplexity or Grok in a tab, run a prompt, then reopen this panel.")
      );
      return;
    }

  // Each view has its own layout: the popup since 0.47.0 (renderAnalyzePopup),
  // the full tab since 0.48.0 (renderAnalyzeTab). The full tab reuses the
  // detailed cards renderAnalyzeLegacy() builds — every page read, search
  // details, the brand/page matrix, grounding, technical — in its Details.
  if (document.body.classList.contains("popup")) {
    renderAnalyzePopup(rec, root);
    return;
  }
  renderAnalyzeTab(rec, root);
  } catch (err) {
    console.error("renderAnalyze failed:", err);
    const root = $("#analyze");
    if (root) {
      root.textContent = "";
      root.append(
        el("div", { className: "card warn-box", style: "margin: 20px; color: var(--red-fg);" },
          el("h3", {}, "Render Warning"),
          el("p", {}, `Could not render capture details: ${err.message}`),
          el("p", { className: "muted", style: "font-size: 11px;" }, "Try selecting another capture from the Dashboard.")
        )
      );
    }
  }
}

// The captures the Dashboard lists right now; About's export and delete
// buttons act on these.
let currentFilteredRecs = [];

/* ---------- Dashboard (0.49.0) ----------
 * Release 3 of the canvas redesign. The owner's feedback on the old
 * Dashboard: it must not be brand-centric; it "is a record of prompts,
 * search is central, and the right-hand side should go". So it is now a
 * searchable history of everything captured (src/lib/historyView.js works
 * it out): one row per prompt, grouped by day, with the engines that answered
 * it, how often it was asked and what the answer held; filters for the
 * period, the engines, the kind of answer and the week; and a second view of
 * the searches the engines ran. The search looks in the prompts, in the
 * searches the engines ran and, through the background ("search-answers"),
 * in the answers themselves.
 *
 * A campaign's results moved to the Campaigns tab with it (see
 * renderCampaignResults), ahead of that tab's own redesign.
 */

// The canvas's line glyphs (Glyph.dc.html): 24×24, stroked in currentColor.
// Static markup, never built from data.
const GLYPH_PATHS = {
  user: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  noglobe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/><path d="M4 4l16 16" stroke-width="2.6"/>',
  pages: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6"/><path d="M10 17h6"/>',
  cart: '<path d="M3 4h2l2.4 11h10.2L20 8H6.2"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 4h5v15H6a2 2 0 0 0-2 1.5z"/><path d="M20 5.5A2 2 0 0 0 18 4h-5v15h5a2 2 0 0 1 2 1.5z"/>',
  task: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M8.5 11l2 2 4-4"/><path d="M8.5 17h7"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10.5 11v5.5"/><path d="M13.5 11v5.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  // About's pages (0.51.0)
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.5h.01"/>',
  sliders: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>',
  tools: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  // Full-tab Analyze (0.54.0): where an image or card leads
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  // The full tab's section rail (0.60.0), from the canvas's Answer board
  bars: '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M21 19H3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5V6"/><path d="M15 2.5V6"/><path d="M9 18v3.5"/><path d="M15 18v3.5"/>',
  answer: '<path d="M4 5h16v11H8l-4 4z"/>',
  ad: '<path d="M4 10v4h3l6 4V6l-6 4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
};
function glyphEl(name, size = 16) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  svg.innerHTML = GLYPH_PATHS[name] || "";
  svg.classList.add("glyph");
  return svg;
}
const AK_GLYPH = { shopping: "cart", info: "book", local: "pin", images: "image", memory: "noglobe", task: "task" };

let dbQuery = "";
let dbScope = { prompts: true, answers: true, fan: true };
let dbFiltersOpen = false; // the full tab's Filters panel (0.78.0), closed by default
let dbEngines = { chatgpt: true, gemini: true, perplexity: true, grok: true };
let dbPeriod = null;         // null until picked: the view's default, widened if that would show nothing
let dbRange = null;          // { from, to } as "YYYY-MM-DD" when the period is "custom"
let dbRepeat = false;
// The answers' language and market (0.70.0), null = any.
let dbLang = null, dbMarket = null;
// Campaign prompts on the Dashboard (0.68.0): "group" (a block per
// campaign, after the prompts asked by hand), "hide" or "only". Kept in this
// browser, so the Dashboard opens the way it was left.
let dbCampaigns = (() => { try { const v = localStorage.getItem("cito-db-campaigns"); return ["group", "hide", "only"].includes(v) ? v : "group"; } catch (_) { return "group"; } })();
const dbOpenCampaigns = new Set(); // campaign blocks showing every prompt
function setDbCampaigns(v) { dbCampaigns = v; try { localStorage.setItem("cito-db-campaigns", v); } catch (_) { /* this view only */ } renderDashboard(); }
function dbCampaignSeg() {
  const g = el("div", { className: "db-seg db-campseg", role: "group", "aria-label": "Campaign prompts" });
  [["group", "Grouped"], ["hide", "Left out"], ["only", "Only"]].forEach(([v, l]) => {
    const b = el("button", { className: `db-seg-btn${dbCampaigns === v ? " on" : ""}`, type: "button", "aria-pressed": dbCampaigns === v ? "true" : "false", "data-campaigns": v }, l);
    b.onclick = () => setDbCampaigns(v);
    g.append(b);
  });
  return el("div", { className: "db-group" }, el("span", { className: "db-label" }, "Campaign prompts"), g);
}
let dbKinds = {};
let dbWeek = null;
let dbView = "prompts";      // "prompts" | "fan"
let dbSort = "newest";
let dbSelected = new Set();  // row keys
let dbMenu = null;           // "export" | "campaign" | null
let dbAnswerHits = new Map(); // captureId -> snippet, for dbAnswerFor
let dbAnswerFor = "";
let dbAnswerTimer = null;
let dbRecentTimer = null;
let dbPending = null;        // removal waiting out its Undo: { keys, ids, timer }

// Recent searches: a per-viewer convenience, so browser storage is enough.
const DB_RECENT_KEY = "cito-recent-searches";
function dbRecent() {
  try { const v = JSON.parse(localStorage.getItem(DB_RECENT_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 6) : []; } catch (_) { return []; }
}
function dbRememberSearch(q) {
  const t = String(q || "").trim();
  if (t.length < 3) return;
  try { localStorage.setItem(DB_RECENT_KEY, JSON.stringify([t, ...dbRecent().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 6))); } catch (_) { /* storage off: nothing to keep */ }
}

// The answer search runs in the background (the panel has no answer text);
// a beat after typing stops, and only the latest query's results are kept.
function dbRequestAnswers() {
  clearTimeout(dbAnswerTimer);
  const q = dbQuery.trim();
  if (!q || !dbScope.answers) { dbAnswerHits = new Map(); dbAnswerFor = ""; return; }
  if (q === dbAnswerFor) return;
  dbAnswerHits = new Map();
  dbAnswerTimer = setTimeout(async () => {
    const r = await send({ type: "search-answers", query: q });
    if (dbQuery.trim() !== q) return;
    dbAnswerHits = new Map(((r && r.ok && r.hits) || []).map((h) => [h.captureId, h.snippet]));
    dbAnswerFor = q;
    renderDashboard();
  }, 250);
}

function dbSetQuery(q) {
  dbQuery = q;
  dbWeek = null;
  dbSelected.clear();
  dbRequestAnswers();
  clearTimeout(dbRecentTimer);
  dbRecentTimer = setTimeout(() => dbRememberSearch(dbQuery), 1500);
}

// The default period: the view's own (the canvas's 7 days in a tab, 3 in the
// popup) unless that would open on an empty list, then the next wider one.
function dbDefaultPeriod(rows, popup) {
  const order = popup ? ["3d", "7d", "30d", "all"] : ["7d", "30d", "all"];
  const base = { query: "", scope: dbScope, engines: dbEngines, kinds: {}, week: null };
  return order.find((p) => historyView(rows, { ...base, period: p }).list.length) || "all";
}

/* Remove with Undo: the rows go at once; the records are deleted when the
 * Undo window closes, or straight away if the panel is closing. */
function dbRemove(rows) {
  if (dbPending) dbCommitRemoval();
  const keys = new Set(rows.map((r) => r.key));
  const ids = rows.flatMap((r) => r.captureIds);
  rows.forEach((r) => dbSelected.delete(r.key));
  dbPending = { keys, ids, n: rows.length, timer: setTimeout(dbCommitRemoval, 7000) };
  renderDashboard();
}
async function dbCommitRemoval() {
  const p = dbPending;
  if (!p) return;
  dbPending = null;
  clearTimeout(p.timer);
  for (const id of p.ids) { FULL.delete(id); send({ type: "delete-record", captureId: id }); }
  if (p.ids.includes(viewingId)) viewingId = null;
  // load() re-reads the store; the messages above are queued ahead of it.
  load();
}
function dbUndoRemoval() {
  if (!dbPending) return;
  clearTimeout(dbPending.timer);
  dbPending = null;
  renderDashboard();
}
addEventListener("pagehide", () => { if (dbPending) dbCommitRemoval(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dbPending) dbCommitRemoval(); });

function dbChip(label, on, onclick, { cls = "", title = "", pressed = true } = {}) {
  const b = el("button", { className: `db-chip${on ? " on" : ""}${cls ? " " + cls : ""}`, type: "button", title }, ...[].concat(label));
  if (pressed) b.setAttribute("aria-pressed", on ? "true" : "false");
  b.onclick = onclick;
  return b;
}
function dbHighlight(text, toks) {
  const span = el("span", {});
  highlightRuns(text, toks).forEach((x) => span.append(x.hit ? el("mark", { className: "db-hit" }, x.t) : document.createTextNode(x.t)));
  return span;
}
const dbEngineLabel = (id) => ENGINES.find((e) => e.id === id)?.label || id;
const DB_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dbWhen(t) {
  const dd = dayDiff(Date.now(), t);
  if (dd < 2) return apTime(t);
  return `${DB_DOW[new Date(t).getDay()]} ${shortDate(t)}`;
}

function dbTokens(r, max) {
  const out = [];
  const tok = (g, n, title) => out.push(el("span", { className: "db-tok", title }, glyphEl(g, 14), n === "" ? null : el("span", {}, String(n))));
  if (r.searches) tok("globe", r.searches, `${r.searches} search${r.searches === 1 ? "" : "es"} the engines ran`);
  else if (r.unpublished) tok("globe", "?", "Searched the web, but the engine doesn't publish what for");
  else tok("noglobe", "", "No web search");
  if (r.pages) tok("pages", r.pages, `${r.pages} page${r.pages === 1 ? "" : "s"} read`);
  if (r.products) tok("cart", r.products, `${r.products} product card${r.products === 1 ? "" : "s"}`);
  if (r.places) tok("pin", r.places, `A map with ${r.places} place${r.places === 1 ? "" : "s"}`);
  if (r.images) tok("image", r.images, `${r.images} image${r.images === 1 ? "" : "s"}`);
  return el("span", { className: "db-toks" }, ...out.slice(0, max || out.length));
}

function dbEngineMarks(r) {
  const box = el("span", { className: "db-engines" });
  r.engines.forEach((id) => {
    const ic = engineIconEl(id);
    const b = el("button", { className: "db-engine", type: "button", "data-engine": id, title: `Open ${dbEngineLabel(id)}'s answer`, "aria-label": `Open ${dbEngineLabel(id)}'s answer` }, ic, el("span", { className: "ap-sr" }, dbEngineLabel(id)));
    b.onclick = () => openCapture(r.latestByEngine[id]);
    box.append(b);
  });
  return box;
}

// The second line under a prompt: why it matched, or what's worth knowing.
function dbMuted(r, toks) {
  if (r.hitAnswer && !r.hitPrompt) return el("span", { className: "db-muted" }, "In the answer: ", dbHighlight(r.hitAnswer.snippet, toks));
  if (r.hitFan && !r.hitPrompt) return el("span", { className: "db-muted" }, "An engine searched “", dbHighlight(r.hitFan.text, toks), "”");
  const parts = [];
  if (r.asked > 1) parts.push(`asked ${r.asked}×`);
  if (r.campaign) parts.push(`${r.campaign} campaign`);
  if (r.words > 30) parts.push(`${r.words}-word prompt`);
  if (r.sample) parts.push("sample data");
  return parts.length ? el("span", { className: "db-muted" }, parts.join(" · ")) : null;
}

function dbRow(r, v, popup) {
  const kind = KINDS.find((k) => k.id === r.kind) || KINDS[1];
  const long = r.words > 30;
  const openId = r.hitAnswer ? r.hitAnswer.captureId : r.latestId;
  const prompt = el("button", { className: `db-prompt${long ? " long" : ""}`, type: "button", title: r.text }, dbHighlight(r.text, dbScope.prompts ? v.tokens : []));
  prompt.onclick = () => openCapture(openId);
  const text = el("div", { className: "db-text" }, prompt);
  const muted = dbMuted(r, v.tokens);
  if (r.kind === "task") {
    const rm = el("button", { className: "db-link danger", type: "button" }, "Remove it");
    rm.onclick = () => dbRemove([r]);
    text.append(el("span", { className: "db-muted" }, "Looks like a task, not research. ", rm));
  } else if (muted) text.append(muted);
  const tile = el("span", { className: `db-kind k-${r.kind}`, title: kind.label, "aria-label": kind.label }, glyphEl(AK_GLYPH[r.kind], popup ? 14 : 15));
  const trash = el("button", { className: `db-trash${r.kind === "task" ? " task" : ""}`, type: "button", title: "Remove from my history", "aria-label": fmt("Remove “{prompt}” from my history", { prompt: r.text.slice(0, 40) }) }, glyphEl("trash", 15));
  trash.onclick = () => dbRemove([r]);
  if (popup) {
    return el("li", { className: `db-row k-${r.kind}`, "data-key": r.key },
      tile,
      el("div", { className: "db-main" }, text, el("span", { className: "db-meta" }, el("span", { className: "db-when" }, dbWhen(r.latestAt)), dbTokens(r, 4))),
      dbEngineMarks(r), trash);
  }
  const cb = el("input", { type: "checkbox", "aria-label": fmt("Select “{prompt}”", { prompt: r.text.slice(0, 40) }) });
  cb.checked = dbSelected.has(r.key);
  cb.onchange = () => { if (cb.checked) dbSelected.add(r.key); else dbSelected.delete(r.key); renderDashboard(); };
  return el("li", { className: `db-row k-${r.kind}${cb.checked ? " selected" : ""}`, "data-key": r.key },
    el("label", { className: "db-check" }, cb),
    el("span", { className: "db-when" }, dbWhen(r.latestAt)),
    tile, text, dbEngineMarks(r), dbTokens(r), trash);
}

function dbExportMenu(rows, label) {
  const wrap = el("div", { className: "menu-wrap" });
  const btn = el("button", { className: "at-btn sm", type: "button", "aria-expanded": dbMenu === "export" ? "true" : "false", "aria-haspopup": "menu" }, label);
  btn.onclick = (e) => { e.stopPropagation(); dbMenu = dbMenu === "export" ? null : "export"; renderDashboard(); };
  wrap.append(btn);
  if (dbMenu === "export") {
    const recs = rows.flatMap((r) => r.captureIds).map((id) => ALL_RECORDS.find((x) => x.captureId === id)).filter(Boolean);
    const menu = el("div", { className: "menu-pop db-menu", role: "menu" });
    [["excel", "Excel", ".xls spreadsheet"], ["csv", "Detailed CSV", "one row per source"], ["html", "Conversations", "readable HTML document"], ["json", "Raw data", "full JSON payloads"]].forEach(([k, l, sub]) => {
      const it = el("button", { className: "menu-item", type: "button", role: "menuitem" }, el("span", { className: "menu-item-label" }, l), el("span", { className: "menu-item-sub muted small" }, sub));
      it.onclick = async () => {
        dbMenu = null;
        renderDashboard();
        if (k === "json") download(`citoskeleton-selected-${Date.now()}.json`, JSON.stringify(recs, null, 2), "application/json");
        else if (k === "html") await exportRecordsAsHtml(recs);
        else downloadDetailedFormat(recs, k);
      };
      menu.append(it);
    });
    menu.append(el("div", { className: "menu-note muted small" }, `${recs.length} answer${recs.length === 1 ? "" : "s"} to ${rows.length} prompt${rows.length === 1 ? "" : "s"}`));
    wrap.append(menu);
  }
  return wrap;
}

function dbCampaignMenu(rows) {
  const wrap = el("div", { className: "menu-wrap" });
  const btn = el("button", { className: "at-btn sm", type: "button", "aria-expanded": dbMenu === "campaign" ? "true" : "false", "aria-haspopup": "menu" }, "Add to a campaign");
  btn.onclick = (e) => { e.stopPropagation(); dbMenu = dbMenu === "campaign" ? null : "campaign"; renderDashboard(); };
  wrap.append(btn);
  if (dbMenu === "campaign") {
    const menu = el("div", { className: "menu-pop db-menu", role: "menu" });
    // A campaign that has started tracking is locked, so its prompts stay
    // comparable run to run; only campaigns still being set up take more.
    const open = GEO_PROFILES.filter((p) => !p.locked);
    open.forEach((p) => {
      const it = el("button", { className: "menu-item", type: "button", role: "menuitem" }, el("span", { className: "menu-item-label" }, p.name || "Untitled"));
      it.onclick = async () => {
        dbMenu = null;
        const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: p.id, rows: rows.map((x) => ({ text: x.text, tags: [] })) });
        if (r && r.ok) {
          const dup = (r.duplicates || []).length;
          showToast(`Added ${r.added} prompt${r.added === 1 ? "" : "s"} to ${p.name || "the campaign"}${dup ? ` (${dup} already there)` : ""}`);
          dbSelected.clear();
          loadGeo();
        } else showToast((r && r.error) || "Couldn't add them to the campaign", "error");
        renderDashboard();
      };
      menu.append(it);
    });
    if (!open.length) menu.append(el("div", { className: "menu-note muted small" }, GEO_PROFILES.length ? "Campaigns lock once they start tracking. Start a new one in Campaigns to track these prompts." : "No campaigns yet. Start one in Campaigns to track these prompts."));
    const go = el("button", { className: "menu-item", type: "button", role: "menuitem" }, el("span", { className: "menu-item-label" }, "Go to Campaigns →"));
    go.onclick = () => { dbMenu = null; showTab("loader"); };
    menu.append(go);
    wrap.append(menu);
  }
  return wrap;
}

// One row per prompt, rebuilt only when the records or campaigns change:
// load() replaces ALL_RECORDS and GEO_PROFILES, so identity is enough, and
// typing in the search box doesn't re-read every capture on each key.
let dbRowsCache = null;
function dbHistoryRows() {
  if (!dbRowsCache || dbRowsCache.recs !== ALL_RECORDS || dbRowsCache.profiles !== GEO_PROFILES) {
    dbRowsCache = { recs: ALL_RECORDS, profiles: GEO_PROFILES, rows: historyRows(ALL_RECORDS, { profiles: GEO_PROFILES }) };
  }
  return dbRowsCache.rows;
}

/* Get started (1.0.0, src/lib/onboarding.js). The store's version was 0.36,
 * a different tool; a person updating, or installing for the first time,
 * gets five steps from a first answer to a campaign's results, at the top
 * of the Dashboard. Each is ticked off by what they have done, and the card
 * goes once all five are, or when they hide it. */
const GS_KEY = { analyzed: "cito-gs-analyzed", results: "cito-gs-results", hidden: "cito-gs-hidden" };
const gsGet = (k) => { try { return localStorage.getItem(GS_KEY[k]); } catch (_) { return null; } };
function gsMark(k) { try { if (!localStorage.getItem(GS_KEY[k])) localStorage.setItem(GS_KEY[k], String(Date.now())); } catch (_) { /* private mode */ } }
function getStartedCard() {
  if (gsGet("hidden")) return null;
  const c = checklist({
    captured: ALL_RECORDS.some((r) => !abIsDemo(r)),
    analyzed: !!gsGet("analyzed"),
    campaigns: GEO_PROFILES.length,
    ran: GEO_PROFILES.some((p) => p.lastRunAt),
    sawResults: !!gsGet("results"),
  });
  if (c.complete) return null;
  // Compact (1.0.0): only the next step shows; the full list is folded away
  // so the card doesn't push the history down the page.
  const list = el("ol", { className: "gs-list" });
  let nextRow = null;
  c.steps.forEach((s, i) => {
    const isNext = c.next && c.next.id === s.id;
    let go = null;
    if (!s.done && isNext) {
      go = s.go === "engine"
        ? el("a", { className: "btn sm primary gs-go", href: "https://chatgpt.com/", target: "_blank", rel: "noopener noreferrer" }, "Open ChatGPT")
        : el("button", { type: "button", className: "btn sm primary gs-go", onclick: () => showTab(s.go) }, "Go there");
    }
    const row = el("li", { className: `gs-step${s.done ? " done" : ""}${isNext ? " next" : ""}` },
      el("span", { className: "gs-tick", "aria-hidden": "true" }, s.done ? "✓" : String(i + 1)),
      el("div", { className: "gs-text" }, el("b", {}, s.label), isNext ? el("span", { className: "gs-hint" }, s.hint) : null),
      go);
    if (isNext) nextRow = row; else list.append(row);
  });
  const all = el("details", { className: "gs-all" }, el("summary", {}, "All steps"), list);
  const hide = el("button", { type: "button", className: "linkbtn gs-hide" }, "Hide");
  hide.onclick = () => { try { localStorage.setItem(GS_KEY.hidden, "1"); } catch (_) { /* private mode */ } renderDashboard(); };
  const help = el("a", { className: "linkbtn gs-help", href: chrome.runtime.getURL("ui/help.html"), target: "_blank", rel: "noopener" }, "Help & FAQ");
  return el("section", { className: "db-card gs", "aria-label": "Get started" },
    el("div", { className: "gs-head" }, el("b", { className: "gs-title" }, "Get started"),
      el("span", { className: "gs-count" }, fmt("{done} of {total} done", { done: c.done, total: c.total })), el("span", { className: "gs-sp" }), help, hide),
    nextRow ? el("ol", { className: "gs-list" }, nextRow) : null, all);
}

function renderDashboard() { withScrollPreserved(renderDashboardImpl); }
function dbCodeName(kind, code) {
  try { return new Intl.DisplayNames([navigator.language || "en"], { type: kind }).of(code) || code; } catch (_) { return code; }
}

function renderDashboardImpl() {
  const root = $("#dashboard");
  if (!root) return;
  beginSwap(root);
  root.textContent = "";
  const popup = document.body.classList.contains("popup");
  const removing = dbPending ? dbPending.keys : new Set();
  const all = dbHistoryRows().filter((r) => !removing.has(r.key));
  const wrap = el("div", { className: `db ${popup ? "db-popup" : "db-tab"}` });
  root.append(wrap);
  if (dbPending) root.append(dbToast());
  const gs = getStartedCard();
  if (gs) wrap.append(gs);
  if (!all.length) {
    currentFilteredRecs = [];
    wrap.append(el("div", { className: "empty" }, "Nothing captured yet. Ask ChatGPT, Gemini, Perplexity or Grok something in a tab and it shows up here, with the searches it ran and the pages it read."));
    return;
  }
  const period = dbPeriod || dbDefaultPeriod(all, popup);
  const v = historyView(all, { query: dbQuery, scope: dbScope, engines: dbEngines, period, from: dbRange && dbRange.from, to: dbRange && dbRange.to, kinds: dbKinds, week: dbWeek, repeat: dbRepeat, campaigns: dbCampaigns, sort: dbSort, lang: dbLang, market: dbMarket }, { now: Date.now(), answerHits: dbAnswerHits });
  currentFilteredRecs = v.list.flatMap((r) => r.captureIds).map((id) => ALL_RECORDS.find((x) => x.captureId === id)).filter(Boolean);
  const periodPhrase = period === "custom" ? (dbRange ? `in ${rangeLabel(dbRange.from, dbRange.to)}` : "between the dates you picked") : (PERIODS.find((p) => p.id === period) || PERIODS[5]).phrase;

  /* --- search --- */
  const search = el("div", { className: "db-search" });
  const inp = el("input", { id: "dashboardSearch", type: "search", className: "db-input", value: dbQuery, autocomplete: "off", spellcheck: "false",
    placeholder: popup ? "Search prompts, answers and searches" : "Search your prompts, the answers, and what the engines searched for",
    "aria-label": "Search your history" });
  inp.oninput = () => {
    const cursor = inp.selectionStart;
    dbSetQuery(inp.value);
    renderDashboard();
    const next = $("#dashboardSearch");
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") dbRememberSearch(dbQuery); if (e.key === "Escape" && dbQuery) { dbSetQuery(""); renderDashboard(); } };
  search.append(glyphEl("search", 16), inp);
  if (dbQuery) {
    const x = el("button", { className: "db-clear", type: "button", title: "Clear the search", "aria-label": "Clear the search" }, "×");
    x.onclick = () => { dbSetQuery(""); renderDashboard(); $("#dashboardSearch")?.focus(); };
    search.append(x);
  }
  const top = el("section", { className: "db-card db-top", "aria-label": "Search and filters" });
  wrap.append(top);
  // The app bar already says what this is (0.68.1: it was said twice).
  // 0.78.0, asked: the search and filters took so much room that the history
  // started 60–70% down the page. In the tab they're one row now: the search,
  // and a Filters button that opens the filters and counts the ones on.
  let fpanel = null;
  if (popup) top.append(search);
  else {
    const on = [
      ["prompts", "answers", "fan"].some((k) => !dbScope[k]),
      ENGINE_ORDER.some((id) => dbEngines[id] === false),
      !!dbPeriod && dbPeriod !== dbDefaultPeriod(all, popup),
      dbRepeat, dbCampaigns !== "group", !!dbLang, !!dbMarket,
      Object.values(dbKinds || {}).some(Boolean), !!dbWeek,
    ].filter(Boolean).length;
    const fbtn = el("button", { type: "button", className: `db-fbtn${on ? " on" : ""}`, id: "dbFiltersBtn", "aria-expanded": String(dbFiltersOpen), "aria-controls": "dbFilters", "data-tip": "Where to look, which engines, when, and what to show" },
      glyphEl("filter", 14), "Filters", on ? el("span", { className: "db-n" }, String(on)) : "");
    fbtn.onclick = () => { dbFiltersOpen = !dbFiltersOpen; renderDashboard(); };
    top.append(el("div", { className: "db-toprow" }, search, fbtn));
    fpanel = el("div", { className: "db-fpanel", id: "dbFilters", hidden: !dbFiltersOpen });
    top.append(fpanel);
  }

  /* --- filters --- */
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const setPeriod = (p) => {
    // Custom starts on the last seven days, which the two dates then change.
    if (p === "custom" && !dbRange) dbRange = { from: ymd(Date.now() - 6 * 86400000), to: ymd(Date.now()) };
    dbPeriod = p; dbWeek = null; renderDashboard();
  };
  // Two themed date fields for a custom period (0.60.2, asked for).
  const rangeBox = () => {
    const box = el("div", { className: "db-range", role: "group", "aria-label": "Custom dates" });
    const field = (key, label) => {
      const input = el("input", { type: "date", className: "db-date", value: (dbRange && dbRange[key]) || "", max: ymd(Date.now()), "aria-label": label });
      input.onchange = () => { dbRange = { ...(dbRange || {}), [key]: input.value }; renderDashboard(); };
      return el("label", { className: "db-date-field" }, el("span", { className: "db-label" }, label), input);
    };
    box.append(field("from", "From"), field("to", "To"));
    return box;
  };
  const engineToggle = (id) => () => { dbEngines = { ...dbEngines, [id]: dbEngines[id] === false }; renderDashboard(); };
  const recent = dbRecent();
  if (popup) {
    const row = el("div", { className: "db-filters" });
    const sel = el("select", { className: "db-select", "aria-label": "When" });
    PERIODS.forEach((p) => { const o = el("option", { value: p.id }, p.id === "custom" && period === "custom" && dbRange ? rangeLabel(dbRange.from, dbRange.to) : p.label); if (p.id === period) o.selected = true; sel.append(o); });
    sel.onchange = () => setPeriod(sel.value);
    row.append(sel);
    const eng = el("span", { className: "db-engine-toggles" });
    ENGINE_ORDER.forEach((id) => {
      const on = dbEngines[id] !== false;
      const b = el("button", { className: `db-etoggle${on ? " on" : ""}`, type: "button", "aria-pressed": on ? "true" : "false", title: `${dbEngineLabel(id)}: ${on ? "shown" : "hidden"}`, "aria-label": dbEngineLabel(id) }, engineIconEl(id));
      b.onclick = engineToggle(id);
      eng.append(b);
    });
    row.append(eng);
    const camp = el("select", { className: "db-select db-campsel", "aria-label": "Campaign prompts" });
    [["group", "Campaigns grouped"], ["hide", "Without campaigns"], ["only", "Campaigns only"]].forEach(([v, l]) => { const o = el("option", { value: v }, l); if (v === dbCampaigns) o.selected = true; camp.append(o); });
    camp.onchange = () => setDbCampaigns(camp.value);
    row.append(camp);
    top.append(row);
    if (period === "custom") top.append(rangeBox());
    const kinds = el("div", { className: "db-kindchips", role: "group", "aria-label": "Kind of answer" });
    KINDS.forEach((k) => {
      const n = v.kindCounts[k.id] || 0;
      const on = !!dbKinds[k.id];
      const c = dbChip([glyphEl(AK_GLYPH[k.id], 13), `${k.label.split(" ·")[0]} · ${n}`], on, () => { dbKinds = { ...dbKinds, [k.id]: !on }; renderDashboard(); }, { cls: `k-${k.id}${n ? "" : " zero"}` });
      kinds.append(c);
    });
    top.append(kinds);
  } else {
    // 0.68.1, reported as "a mess": the filters are labelled rows, a label
    // column on the left and each row's controls beside it, instead of one
    // run of chips that wrapped wherever the width ran out.
    const row = el("div", { className: "db-filters db-fgrid" });
    const scope = el("div", { className: "db-group", role: "group", "aria-label": "Look in" });
    [["prompts", "Prompts"], ["answers", "Answers"], ["fan", "Searches engines ran"]].forEach(([k, l]) => scope.append(dbChip(l, !!dbScope[k], () => {
      dbScope = { ...dbScope, [k]: !dbScope[k] };
      if (k === "answers") { dbAnswerFor = ""; dbRequestAnswers(); }
      renderDashboard();
    }, { cls: "scope" })));
    const eng = el("div", { className: "db-group", role: "group", "aria-label": "Engines" });
    ENGINE_ORDER.forEach((id) => eng.append(dbChip([engineIconEl(id), dbEngineLabel(id), el("span", { className: "db-n" }, String(v.engineCounts[id] || 0))], dbEngines[id] !== false, engineToggle(id), { cls: "engine" })));
    const seg = el("div", { className: "db-seg", role: "group", "aria-label": "When" });
    PERIODS.forEach((p) => { const b = el("button", { className: `db-seg-btn${p.id === period ? " on" : ""}`, type: "button", "aria-pressed": p.id === period ? "true" : "false" }, p.id === "custom" && period === "custom" && dbRange ? rangeLabel(dbRange.from, dbRange.to) : p.label); b.onclick = () => setPeriod(p.id); seg.append(b); });
    const when = el("div", { className: "db-group" }, seg);
    if (period === "custom") when.append(rangeBox());
    const show = el("div", { className: "db-group" },
      dbChip(`${dbRepeat ? "✓ " : ""}Asked more than once`, dbRepeat, () => { dbRepeat = !dbRepeat; renderDashboard(); }, { cls: "toggle" }),
      el("span", { className: "db-sep", "aria-hidden": "true" }), dbCampaignSeg());
    const line = (label, ctl) => row.append(el("span", { className: "db-flabel" }, label), ctl);
    line("Look in", scope);
    line("Engines", eng);
    line("When", when);
    line("Show", show);
    // Language and market (0.70.0): only when there is a choice to make.
    const pickRow = (list, cur, kind, set) => {
      const g = el("div", { className: "db-group", role: "group", "aria-label": kind === "language" ? "Language" : "Market" });
      g.append(dbChip("Any", !cur, () => { set(null); renderDashboard(); }, { cls: "scope" }));
      list.slice(0, 12).forEach((x) => g.append(dbChip([dbCodeName(kind, x.code), el("span", { className: "db-n" }, String(x.n))], cur === x.code, () => { set(cur === x.code ? null : x.code); renderDashboard(); }, { cls: "scope" })));
      return g;
    };
    if (v.langCounts.length > 1 || dbLang) line("Language", pickRow(v.langCounts, dbLang, "language", (c) => { dbLang = c; }));
    if (v.marketCounts.length > 1 || dbMarket) line("Market", pickRow(v.marketCounts, dbMarket, "region", (c) => { dbMarket = c; }));
    fpanel.append(row);
  }
  if (recent.length && !dbQuery) {
    const rr = el("div", { className: "db-recent" }, el("span", { className: "db-label" }, popup ? "Recent" : "Your recent searches"));
    // Shown only while the search box has focus (0.78.0); a press keeps focus
    // in the box so the click lands.
    recent.forEach((q) => { const c = dbChip(q, false, () => { dbSetQuery(q); renderDashboard(); }, { cls: "recent", pressed: false }); c.onmousedown = (e) => e.preventDefault(); rr.append(c); });
    top.append(rr);
  }

  /* --- summary: how many, when, what kind --- */
  const maxW = Math.max(1, ...v.weeks.map((w) => w.n));
  const bars = el("div", { className: "db-weeks", role: "group", "aria-label": "Prompts by week — pick one to see only that week" });
  v.weeks.forEach((w) => {
    const on = dbWeek === w.start;
    const b = el("button", { className: `db-week${on ? " on" : ""}${dbWeek && !on ? " dim" : ""}`, type: "button", "aria-pressed": on ? "true" : "false",
      title: fmt("{n} prompts in the week of {week}", { n: w.n, week: shortDate(w.start) }, "{n} prompt in the week of {week}"), "aria-label": fmt("{week}: {n} prompts", { n: w.n, week: w.label }, "{week}: {n} prompt") });
    if (!popup) b.append(el("span", { className: "db-week-n" }, w.n ? String(w.n) : ""));
    b.append(el("span", { className: "db-week-bar", style: `height:${Math.max(w.n ? 2 : 0, Math.round((w.n / maxW) * (popup ? 30 : 26)))}px` }));
    if (!popup) b.append(el("span", { className: "db-week-l" }, w.label));
    b.onclick = () => { dbWeek = on ? null : w.start; renderDashboard(); };
    bars.append(b);
  });
  const t = v.totals;
  // "1 prompt", not "1 prompts" (1.0.0).
  const totalLabel = dbQuery ? `match “${dbQuery.trim()}” ${periodPhrase}` : `${t.prompts === 1 ? "prompt" : "prompts"} captured ${periodPhrase}`;
  const span = t.from ? `from ${shortDate(t.from)} to ${dayDiff(Date.now(), t.to) === 0 ? "today" : shortDate(t.to)}` : "nothing here yet";
  if (popup) {
    const sum = el("section", { className: "db-card db-summary", "aria-label": "Summary" },
      el("div", { className: "db-total-line" }, el("b", {}, String(t.prompts)), ` ${totalLabel}`,
        el("span", { className: "db-muted" }, ` · ${t.answers} answer${t.answers === 1 ? "" : "s"}${t.kindLine ? ` · ${t.kindLine}` : ""}`)),
      bars);
    wrap.append(sum);
  } else {
    const total = el("div", { className: "db-total" },
      el("div", { className: "db-total-n" }, String(t.prompts)),
      el("div", { className: "db-total-l" }, totalLabel),
      el("div", { className: "db-muted" }, `${t.answers} answer${t.answers === 1 ? "" : "s"} on ${t.engines} engine${t.engines === 1 ? "" : "s"}`),
      el("div", { className: "db-muted" }, span));
    const when = el("div", { className: "db-when-box" },
      el("div", { className: "db-box-head" }, el("h2", { className: "db-h" }, "When you asked"), el("span", { className: "db-muted" }, dbWeek ? `Week of ${shortDate(dbWeek)} · click again to clear` : "Click a week to see only those prompts")),
      bars);
    const kindBox = el("div", { className: "db-kinds" },
      el("div", { className: "db-box-head" }, el("h2", { className: "db-h" }, "Kind of answer"), el("span", { className: "db-muted" }, "click to filter")));
    const stack = el("div", { className: "db-stack", role: "img", "aria-label": KINDS.map((k) => `${v.kindCounts[k.id] || 0} ${tr(k.label)}`).join(", ") });
    KINDS.forEach((k) => { const n = v.kindCounts[k.id] || 0; if (n) stack.append(el("span", { className: `k-${k.id}${v.anyKind && !dbKinds[k.id] ? " dim" : ""}`, style: `flex:${n} 1 0`, title: `${k.label} · ${n}` })); });
    const kl = el("div", { className: "db-kindlist" });
    KINDS.forEach((k) => {
      const n = v.kindCounts[k.id] || 0;
      const on = !!dbKinds[k.id];
      const b = el("button", { className: `db-kindbtn k-${k.id}${on ? " on" : ""}${n ? "" : " zero"}`, type: "button", "aria-pressed": on ? "true" : "false" },
        el("span", { className: "db-kind-ic" }, glyphEl(AK_GLYPH[k.id], 14)), el("span", { className: "db-kind-l" }, k.label), el("span", { className: "db-n" }, String(n)));
      b.onclick = () => { dbKinds = { ...dbKinds, [k.id]: !on }; renderDashboard(); };
      kl.append(b);
    });
    kindBox.append(stack, kl);
    // One strip, not three tall cards (0.78.0).
    wrap.append(el("section", { className: "db-summary db-strip db-card", "aria-label": "Summary" }, total, when, kindBox));
  }

  /* --- the list --- */
  const list = el("section", { className: "db-card db-list", "aria-label": "Your prompts" });
  wrap.append(list);
  const head = el("div", { className: "db-list-head" });
  const views = el("div", { className: "db-views", role: "tablist", "aria-label": "Show" });
  [["prompts", "Prompts", v.list.length], ["fan", popup ? "Searches" : "Searches the engines ran", v.fan.length]].forEach(([id, label, n]) => {
    const on = dbView === id;
    const b = el("button", { className: `db-view${on ? " on" : ""}`, type: "button", role: "tab", "aria-selected": on ? "true" : "false" }, label, el("span", { className: "db-n" }, String(n)));
    b.onclick = () => { dbView = id; renderDashboard(); };
    views.append(b);
  });
  head.append(views);
  // Select every prompt shown at once (1.0.0, asked: "an option to select all
  // prompts in one go"), as the filters and search leave the list, including
  // a campaign's rows folded under "Show all". Partly ticked when some are.
  if (!popup && dbView === "prompts" && v.list.length) {
    const picked = v.list.filter((r) => dbSelected.has(r.key)).length;
    const all = el("input", { type: "checkbox", "aria-label": `Select all ${v.list.length} prompts shown` });
    all.checked = picked === v.list.length;
    all.indeterminate = picked > 0 && picked < v.list.length;
    all.onchange = () => {
      if (all.checked) v.list.forEach((r) => dbSelected.add(r.key));
      else v.list.forEach((r) => dbSelected.delete(r.key));
      renderDashboard();
    };
    head.append(el("label", { className: "db-selall", title: "Select every prompt in this list, as filtered" }, all, el("span", {}, `Select all (${v.list.length})`)));
  }
  if (!popup && dbView === "prompts") {
    const sort = el("select", { className: "db-select", "aria-label": "Sort" });
    [["newest", "Newest first"], ["asked", "Asked most often"], ["engines", "Most engines"]].forEach(([k, l]) => { const o = el("option", { value: k }, l); if (k === dbSort) o.selected = true; sort.append(o); });
    sort.onchange = () => { dbSort = sort.value; renderDashboard(); };
    head.append(el("span", { className: "db-spacer" }), el("label", { className: "db-sort" }, el("span", { className: "db-label" }, "Sort"), sort));
    if (!dbSelected.size) head.append(dbExportMenu(v.list, "Export"));
  }
  list.append(head);

  const selRows = v.list.filter((r) => dbSelected.has(r.key));
  // The share icon sends the prompts picked, or the list as filtered (0.80.0).
  setShare("dashboard", { getParts: () => dashboardParts(selRows.length ? selRows : v.list, !!selRows.length), file: "citoskeleton-prompts.md" });
  if (!popup && selRows.length) {
    const bar = el("div", { className: "db-selbar", role: "toolbar", "aria-label": "Selected prompts" });
    const one = selRows.length === 1 && selRows[0].engines.length > 1;
    const side = el("button", { className: "at-btn sm", type: "button", title: one ? "Each engine's answer to this prompt, side by side" : "Pick one prompt that more than one engine answered" }, "Open side by side");
    side.disabled = !one;
    // After openCapture() has finished: it resets Analyze's view state.
    side.onclick = async () => { await openCapture(selRows[0].latestId); atCompare = true; renderAnalyze(); };
    const rm = el("button", { className: "at-btn sm danger", type: "button" }, "Remove");
    rm.onclick = () => dbRemove(selRows);
    const x = el("button", { className: "db-clear", type: "button", title: "Clear the selection", "aria-label": "Clear the selection" }, "×");
    x.onclick = () => { dbSelected.clear(); renderDashboard(); };
    bar.append(el("b", {}, `${selRows.length} selected`), side, dbCampaignMenu(selRows), dbExportMenu(selRows, "Export"), rm, el("span", { className: "db-spacer" }), x);
    list.append(bar);
  }

  if (dbView === "fan") {
    if (!v.fan.length) list.append(el("p", { className: "ap-note" }, dbQuery ? "No search the engines ran matches." : "The engines didn't search the web for these prompts, or didn't publish what they searched for."));
    else {
      list.append(el("p", { className: "db-muted db-intro" }, `${v.fan.length} search${v.fan.length === 1 ? "" : "es"} the engines ran for ${v.list.length === 1 ? "this prompt" : `these ${v.list.length} prompts`} — how they rephrased what you asked.`));
      const table = el("div", { className: "db-fan", role: "table", "aria-label": "Searches the engines ran" });
      if (!popup) table.append(el("div", { className: "db-fan-row db-th", role: "row" }, ...["Search the engine ran", "Times", "Engines", "Ran for your prompt"].map((h) => el("span", { role: "columnheader" }, h))));
      v.fan.forEach((f) => {
        // Every prompt the search ran for, in full and each one a link
        // (reported: cut at 60 characters, with the rest only in a tooltip
        // and only the first one clickable). Two show; "+N more" opens the rest.
        const from = el("span", { className: "db-from" });
        const link = (text) => {
          const b = el("button", { className: "db-link db-from-link", type: "button", title: text }, text);
          b.onclick = () => { const r = v.list.find((x) => x.text === text); if (r) openCapture(r.latestId); };
          return b;
        };
        f.from.slice(0, 2).forEach((t) => from.append(link(t)));
        if (f.from.length > 2) {
          const more = el("button", { className: "ap-link db-from-more", type: "button", "aria-expanded": "false" }, `+${f.from.length - 2} more`);
          more.onclick = () => { f.from.slice(2).forEach((t) => from.insertBefore(link(t), more)); more.remove(); };
          from.append(more);
        }
        const eng = el("span", { className: "db-engines" }, ...f.engines.map((id) => { const ic = engineIconEl(id); ic.setAttribute("title", dbEngineLabel(id)); return ic; }));
        table.append(el("div", { className: "db-fan-row", role: "row" },
          el("span", { role: "cell", className: "db-fan-q" }, dbHighlight(f.text, v.tokens), f.lane !== "web" ? el("span", { className: "ap-tag" }, f.lane) : null),
          el("span", { role: "cell", className: "num" }, `×${f.n}`), el("span", { role: "cell" }, eng), el("span", { role: "cell" }, from)));
      });
      list.append(table);
    }
    return;
  }
  if (!v.list.length) {
    const msg = dbQuery ? "Nothing you’ve captured matches. Try a shorter word, or look in answers too." : "Nothing here for these filters. Try a longer period.";
    const p = el("p", { className: "ap-note db-empty" }, msg);
    if (period !== "all") { const b = el("button", { className: "db-link", type: "button" }, " Show all time"); b.onclick = () => setPeriod("all"); p.append(b); }
    list.append(p);
    return;
  }
  v.groups.forEach((g) => {
    const sec = el("div", { className: `db-group-block${g.campaign ? " db-campaign-block" : ""}`, ...(g.campaign ? { "data-campaign": g.profileId || g.label } : {}) },
      el("h3", { className: "db-group-h" }, g.campaign ? el("span", { className: "db-camp-tag" }, "Campaign") : "", g.label, el("span", { className: "db-muted" }, `${g.sub ? ` ${g.sub} ·` : ""} ${g.rows.length} prompt${g.rows.length === 1 ? "" : "s"}`)));
    // A campaign's block shows its five latest prompts until opened, so a
    // 40-prompt run doesn't bury what was asked by hand.
    const open = !g.campaign || dbOpenCampaigns.has(g.id) || g.rows.length <= 5 || dbCampaigns === "only";
    const ul = el("ul", { className: "db-rows" });
    (open ? g.rows : g.rows.slice(0, 5)).forEach((r) => ul.append(dbRow(r, v, popup)));
    sec.append(ul);
    if (g.campaign) {
      const foot = el("div", { className: "db-camp-foot" });
      if (g.rows.length > 5 && dbCampaigns !== "only") {
        const more = el("button", { className: "db-link", type: "button", "aria-expanded": open ? "true" : "false" }, open ? "Show fewer" : `Show all ${g.rows.length} prompts`);
        more.onclick = () => { if (open) dbOpenCampaigns.delete(g.id); else dbOpenCampaigns.add(g.id); renderDashboard(); };
        foot.append(more);
      }
      if (g.profileId && GEO_PROFILES.some((x) => x.id === g.profileId)) {
        const go = el("button", { className: "db-link", type: "button" }, "Open the campaign ›");
        go.onclick = () => { geoActiveId = g.profileId; loadGeo(); showTab("loader"); };
        foot.append(go);
      }
      if (foot.childNodes.length) sec.append(foot);
    }
    list.append(sec);
  });
  if (!popup) {
    const wipe = el("button", { className: "db-link danger", type: "button" }, "Delete everything captured…");
    wipe.onclick = async () => {
      if (!confirm("Delete every captured answer, ad-hoc and from campaigns? This can't be undone.")) return;
      await send({ type: "clear-all" });
      FULL.clear();
      viewingId = null;
      load();
    };
    list.append(el("div", { className: "db-foot" }, wipe));
  }
}

function dbToast() {
  const undo = el("button", { className: "db-link", type: "button" }, "Undo");
  undo.onclick = dbUndoRemoval;
  return el("div", { className: "db-toast", role: "status" }, dbPending.n === 1 ? "Removed from your history." : `${dbPending.n} prompts removed from your history.`, undo);
}

// One open menu at a time; a click anywhere else closes it.
document.addEventListener("click", (e) => {
  if (dbMenu && !e.target.closest(".db-menu, .menu-wrap")) { dbMenu = null; renderDashboard(); }
});

/* ---------- exports ---------- */
function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Save conversation" — HTML download. `records` are LIGHT rows (from
// RECORDS/visibleRecs), so each one is hydrated to its full record (with
// answerText) via the same cache used by the Analyze tab before rendering —
// a light record would silently produce an empty answer body otherwise.
async function exportRecordsAsHtml(records) {
  if (!records.length) return;
  const full = [];
  for (const r of records) {
    const rec = await hydrate(r.captureId);
    if (rec) full.push(rec);
  }
  if (!full.length) {
    showToast("Couldn't load the selected conversation(s) — try again.", "error");
    return;
  }
  const models = full.map(buildExportModel);
  const docTitle = full.length === 1 ? models[0].prompt : `${full.length} conversations`;
  const html = renderStandaloneHtml(models, { docTitle });
  const name = full.length === 1
    ? `citoskeleton-conversation-${full[0].captureId.slice(0, 8)}.html`
    : `citoskeleton-conversations-${full.length}-${Date.now()}.html`;
  download(name, html, "text/html");
}

// One answer's designed report (0.53.0, release 6b): ui/report.html lays
// out two A4 pages and opens the print dialog, where "Save as PDF" writes
// the file. Several answers at once still go to export.html below.
function openAnswerReport(rec) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/report.html?kind=answer&captureId=${encodeURIComponent(rec.captureId)}&print=1`) });
}

// "Print / Save as PDF" — opens ui/export.html in a new tab, which fetches
// its own full records via captureId (see ui/export.js); no need to hydrate
// here. Bulk-composes into one document with a table of contents.
function exportRecordsAsPdf(records) {
  if (!records.length) return;
  if (records.length > 30 && !confirm(`Open a print-ready document for all ${records.length} selected conversations? This can take a moment to load.`)) {
    return;
  }
  const ids = records.map((r) => r.captureId).join(",");
  chrome.tabs.create({ url: chrome.runtime.getURL(`ui/export.html?ids=${encodeURIComponent(ids)}`) });
}
function sanitizeXML(s) {
  return String(s || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function downloadDetailedFormat(records, format) {
  if (format === "csv") {
    // Domains alone didn't say which page: reported "i am not able to see all
    // the cited, fetched domain and their urls". Each page's full address is
    // in its own column now, one per line inside the cell, with the brands
    // the answer named, the places on its map and any ad shown with it.
    const HEAD = ["#", "Date", "Time", "Platform", "User Prompt", "Search Used", "Cited Sources", "Cited Count", "Cited URLs", "Fetched Sources", "Fetched Count", "Fetched URLs", "Total Sources", "Fan-Out Query", "Brands Named", "Places", "Ad Shown"];
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const pad = ",".repeat(HEAD.length - 1);
    let output = `CitoSkeleton Audit Log${pad}\n"Prompt-level tracking of AI search behaviour, cited vs. fetched sources, and query fan-out"${pad}\n${pad}\n${HEAD.join(",")}\n`;
    records.forEach((r, i) => {
      const d = new Date(r.capturedAt);
      const dateStr = d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-');
      const timeStr = d.toLocaleTimeString("en-GB");
      const citedS = r.sources.filter(s => s.outcome === "cited");
      const fetchedS = r.sources.filter(s => s.outcome !== "cited");
      const fan = [...(r.fanout?.search||[]), ...(r.fanout?.shopping||[]), ...(r.fanout?.image||[])].map(f => typeof f === "string" ? f : f?.query || "").filter(Boolean).join(" | ");
      const brands = (r.brandMentions || []).filter((b) => b.count > 0).map((b) => b.brand).join("; ");
      const places = (r.places || []).map((p) => [p.name, p.priceRange].filter(Boolean).join(" ")).join("; ");
      const ads = (r.ads || []).map((a) => [a.advertiser, a.title, a.targetUrl || a.targetDomain].filter(Boolean).join(" — ")).join("; ");
      const row = [i + 1, dateStr, timeStr, r.platform || "chatgpt", q(r.userPrompt), r.searched ? "Yes" : "No",
        q(citedS.map(s => s.domain).join("; ")), citedS.length, q(citedS.map(s => s.url || s.domain).join("\n")),
        q(fetchedS.map(s => s.domain).join("; ")), fetchedS.length, q(fetchedS.map(s => s.url || s.domain).join("\n")),
        r.sources.length, q(fan), q(brands), q(places), q(ads)];
      output += row.join(",") + "\n";
    });
    download(`citoskeleton-audit-${Date.now()}.csv`, output, "text/csv");
    return;
  }
  
  if (format !== "excel") return;

  // Aggregations
  const totalPrompts = records.length;
  const uniquePromptsMap = new Map();
  let searchedCount = 0;
  let totalCited = 0;
  let totalFetched = 0;
  let minTime = Infinity;
  let maxTime = 0;

  const domainStats = new Map();

  records.forEach(r => {
    if (r.searched) searchedCount++;
    if (r.capturedAt < minTime) minTime = r.capturedAt;
    if (r.capturedAt > maxTime) maxTime = r.capturedAt;

    const p = (r.userPrompt || "(No prompt)").toLowerCase().trim();
    if (!uniquePromptsMap.has(p)) uniquePromptsMap.set(p, { orig: r.userPrompt || "(No prompt)", runs: 0, cited: 0, fetched: 0, total: 0 });
    const pStat = uniquePromptsMap.get(p);
    pStat.runs++;

    r.sources.forEach(s => {
      pStat.total++;
      if (!domainStats.has(s.domain)) domainStats.set(s.domain, { cited: 0, fetched: 0, total: 0 });
      const dStat = domainStats.get(s.domain);
      dStat.total++;
      
      if (s.outcome === "cited") {
        totalCited++;
        pStat.cited++;
        dStat.cited++;
      } else {
        totalFetched++;
        pStat.fetched++;
        dStat.fetched++;
      }
    });
  });

  const uniqueDomainsCount = domainStats.size;
  const totalMentions = totalCited + totalFetched;
  const searchRate = totalPrompts ? ((searchedCount / totalPrompts) * 100).toFixed(1) + "%" : "0%";
  const avgCited = totalPrompts ? (totalCited / totalPrompts).toFixed(1) : "0.0";
  const avgFetched = totalPrompts ? (totalFetched / totalPrompts).toFixed(1) : "0.0";
  const avgTotal = totalPrompts ? (totalMentions / totalPrompts).toFixed(1) : "0.0";

  let mostCited = "", mostCitedCount = 0;
  let mostFetched = "", mostFetchedCount = 0;
  for (const [dom, st] of domainStats.entries()) {
    if (st.cited > mostCitedCount) { mostCitedCount = st.cited; mostCited = dom; }
    if (st.fetched > mostFetchedCount) { mostFetchedCount = st.fetched; mostFetched = dom; }
  }

  const fmtDate = (ts) => {
    if (!ts || ts === Infinity) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-') + " " + d.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit"});
  };

  const pad = (n) => n.toString().padStart(2, '0');
  let durationStr = "0:00:00";
  if (maxTime > minTime) {
    const diff = maxTime - minTime;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    durationStr = `${h}:${pad(m)}:${pad(s)}`;
  }

  // XML Builder
  let xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="14"/></Style>
  <Style ss:ID="sHeader"><Font ss:Bold="1"/><Interior ss:Color="#E2EFDA" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sPlatform"><Interior ss:Color="#D9E1F2" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sFanout"><Interior ss:Color="#BDD7EE" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sPct"><NumberFormat ss:Format="0.0%"/></Style>
  <Style ss:ID="sFloat"><NumberFormat ss:Format="0.0"/></Style>
 </Styles>
`;

  // SHEET 1: Summary
  xml += ` <Worksheet ss:Name="Summary">
  <Table>
   <Column ss:Width="170"/><Column ss:Width="90"/><Column ss:Width="30"/><Column ss:Width="250"/><Column ss:Width="70"/><Column ss:Width="70"/><Column ss:Width="70"/><Column ss:Width="70"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">CitoSkeleton Audit | Summary</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Session-level rollup of search behaviour.</Data></Cell></Row>
   <Row></Row>
   <Row>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">SESSION METRICS</Data></Cell>
    <Cell ss:StyleID="sHeader"></Cell>
    <Cell></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">PROMPT RUN FREQUENCY</Data></Cell>
   </Row>
   <Row>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Metric</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Value</Data></Cell>
    <Cell></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">User Prompt</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Times Run</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Cited</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Fetched</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">Avg. Total</Data></Cell>
   </Row>
`;

  const smList = [
    ["Total prompts logged", totalPrompts, "Number"],
    ["Unique prompts tested", uniquePromptsMap.size, "Number"],
    ["Prompts with search enabled", searchedCount, "Number"],
    ["Search usage rate", searchRate, "String"],
    ["Unique domains observed", uniqueDomainsCount, "Number"],
    ["Total source mentions", totalMentions, "Number"],
    ["Avg. cited sources / prompt", avgCited, "Number"],
    ["Avg. fetched sources / prompt", avgFetched, "Number"],
    ["Avg. total sources / prompt", avgTotal, "Number"],
    ["Most cited domain", mostCited, "String"],
    ["Most fetched domain", mostFetched, "String"],
    ["Session start", fmtDate(minTime), "String"],
    ["Session end", fmtDate(maxTime), "String"],
    ["Session duration", durationStr, "String"]
  ];

  const promptsArr = Array.from(uniquePromptsMap.values()).sort((a,b) => b.runs - a.runs);
  
  const maxRows = Math.max(smList.length, promptsArr.length);
  for (let i = 0; i < maxRows; i++) {
    xml += `   <Row>\n`;
    if (i < smList.length) {
      xml += `    <Cell><Data ss:Type="String">${sanitizeXML(smList[i][0])}</Data></Cell>\n    <Cell><Data ss:Type="${smList[i][2]}">${sanitizeXML(smList[i][1])}</Data></Cell>\n`;
    } else {
      xml += `    <Cell></Cell>\n    <Cell></Cell>\n`;
    }
    
    xml += `    <Cell></Cell>\n`;
    
    if (i < promptsArr.length) {
      const p = promptsArr[i];
      xml += `    <Cell><Data ss:Type="String">${sanitizeXML(p.orig)}</Data></Cell>\n    <Cell><Data ss:Type="Number">${p.runs}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.cited/p.runs).toFixed(1)}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.fetched/p.runs).toFixed(1)}</Data></Cell>\n    <Cell ss:StyleID="sFloat"><Data ss:Type="Number">${(p.total/p.runs).toFixed(1)}</Data></Cell>\n`;
    }
    xml += `   </Row>\n`;
  }
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 2: Audit Log
  xml += ` <Worksheet ss:Name="Audit Log">
  <Table>
   <Column ss:Width="30"/><Column ss:Width="80"/><Column ss:Width="60"/><Column ss:Width="80"/>
   <Column ss:Width="250"/><Column ss:Width="60"/><Column ss:Width="250"/><Column ss:Width="50"/>
   <Column ss:Width="250"/><Column ss:Width="50"/><Column ss:Width="50"/><Column ss:Width="250"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">CitoSkeleton Audit | Audit Log</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Prompt-level tracking of search behaviour</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">#</Data></Cell>
    <Cell><Data ss:Type="String">Date</Data></Cell>
    <Cell><Data ss:Type="String">Time</Data></Cell>
    <Cell><Data ss:Type="String">Platform</Data></Cell>
    <Cell><Data ss:Type="String">User Prompt</Data></Cell>
    <Cell><Data ss:Type="String">Search Used</Data></Cell>
    <Cell><Data ss:Type="String">Cited Sources</Data></Cell>
    <Cell><Data ss:Type="String">Cited Count</Data></Cell>
    <Cell><Data ss:Type="String">Fetched Sources</Data></Cell>
    <Cell><Data ss:Type="String">Fetched Count</Data></Cell>
    <Cell><Data ss:Type="String">Total Sources</Data></Cell>
    <Cell><Data ss:Type="String">Fan-Out Query</Data></Cell>
   </Row>
`;
  records.forEach((r, i) => {
    const d = new Date(r.capturedAt);
    const dateStr = d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-');
    const timeStr = d.toLocaleTimeString("en-GB");
    const cited = r.sources.filter(s => s.outcome === "cited").map(s => s.domain).join("; ");
    const fetched = r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").map(s => s.domain).join("; ");
    const fan = [...(r.fanout?.search||[]), ...(r.fanout?.shopping||[]), ...(r.fanout?.image||[])].map(f => typeof f === "string" ? f : f?.query || "").filter(Boolean).join(" | ");
    
    xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${dateStr}</Data></Cell>
    <Cell><Data ss:Type="String">${timeStr}</Data></Cell>
    <Cell><Data ss:Type="String">${r.platform || "chatgpt"}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(r.userPrompt)}</Data></Cell>
    <Cell ss:StyleID="sHeader"><Data ss:Type="String">${r.searched ? "Yes" : "No"}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(cited)}</Data></Cell>
    <Cell><Data ss:Type="Number">${r.sources.filter(s => s.outcome === "cited").length}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(fetched)}</Data></Cell>
    <Cell><Data ss:Type="Number">${r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").length}</Data></Cell>
    <Cell ss:StyleID="sPlatform"><Data ss:Type="Number">${r.sources.length}</Data></Cell>
    <Cell ss:StyleID="sFanout"><Data ss:Type="String">${sanitizeXML(fan)}</Data></Cell>
   </Row>\n`;
  });
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 3: Source Analysis
  xml += ` <Worksheet ss:Name="Source Analysis">
  <Table>
   <Column ss:Width="40"/><Column ss:Width="180"/><Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="100"/><Column ss:Width="90"/><Column ss:Width="90"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">CitoSkeleton Audit | Source Analysis</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Domain-level frequency across every cited and fetched source</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">Rank</Data></Cell>
    <Cell><Data ss:Type="String">Domain</Data></Cell>
    <Cell><Data ss:Type="String">Times Cited</Data></Cell>
    <Cell><Data ss:Type="String">Times Fetched</Data></Cell>
    <Cell><Data ss:Type="String">Total Appearances</Data></Cell>
    <Cell><Data ss:Type="String">Share of Cited</Data></Cell>
    <Cell><Data ss:Type="String">Share of All</Data></Cell>
   </Row>
`;
  const domainArr = Array.from(domainStats.entries()).map(([domain, stats]) => ({ domain, ...stats }));
  domainArr.sort((a, b) => b.total - a.total);
  
  domainArr.forEach((d, i) => {
    const shareCited = totalCited > 0 ? (d.cited / totalCited) : 0;
    const shareAll = totalMentions > 0 ? (d.total / totalMentions) : 0;
    xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(d.domain)}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.cited}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.fetched}</Data></Cell>
    <Cell><Data ss:Type="Number">${d.total}</Data></Cell>
    <Cell ss:StyleID="sPct"><Data ss:Type="Number">${shareCited}</Data></Cell>
    <Cell ss:StyleID="sPct"><Data ss:Type="Number">${shareAll}</Data></Cell>
   </Row>\n`;
  });
  xml += `  </Table>\n </Worksheet>\n`;

  // SHEET 4: Domain Data
  xml += ` <Worksheet ss:Name="Domain Data">
  <Table>
   <Column ss:Width="60"/><Column ss:Width="80"/><Column ss:Width="200"/><Column ss:Width="250"/>
   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">CitoSkeleton Audit | Domain Data</Data></Cell></Row>
   <Row><Cell><Data ss:Type="String">Raw extract — one row per domain appearance.</Data></Cell></Row>
   <Row></Row>
   <Row ss:StyleID="sHeader">
    <Cell><Data ss:Type="String">Prompt #</Data></Cell>
    <Cell><Data ss:Type="String">Type</Data></Cell>
    <Cell><Data ss:Type="String">Domain</Data></Cell>
    <Cell><Data ss:Type="String">User Prompt</Data></Cell>
   </Row>
`;
  records.forEach((r, i) => {
    r.sources.forEach(s => {
      xml += `   <Row>
    <Cell><Data ss:Type="Number">${i + 1}</Data></Cell>
    <Cell><Data ss:Type="String">${s.outcome === "news" ? "Fetched" : s.outcome.charAt(0).toUpperCase() + s.outcome.slice(1)}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(s.domain)}</Data></Cell>
    <Cell><Data ss:Type="String">${sanitizeXML(r.userPrompt)}</Data></Cell>
   </Row>\n`;
    });
  });
  xml += `  </Table>\n </Worksheet>\n`;

  /* ---- Generic sheet builder for the remaining detail tables ----
   * Everything the extension extracts should be in the workbook, one row per
   * item, each row carrying the prompt + timestamp so any sheet can be pivoted
   * or filtered on its own without cross-referencing another tab.
   */
  const addSheet = (name, subtitle, widths, headers, rows) => {
    xml += ` <Worksheet ss:Name="${sanitizeXML(name)}">\n  <Table>\n`;
    widths.forEach((w) => (xml += `   <Column ss:Width="${w}"/>`));
    xml += `\n   <Row><Cell ss:StyleID="sTitle"><Data ss:Type="String">CitoSkeleton Audit | ${sanitizeXML(name)}</Data></Cell></Row>\n`;
    xml += `   <Row><Cell><Data ss:Type="String">${sanitizeXML(subtitle)}</Data></Cell></Row>\n   <Row></Row>\n`;
    xml += `   <Row ss:StyleID="sHeader">\n`;
    headers.forEach((h) => (xml += `    <Cell><Data ss:Type="String">${sanitizeXML(h)}</Data></Cell>\n`));
    xml += `   </Row>\n`;
    if (!rows.length) {
      xml += `   <Row><Cell><Data ss:Type="String">No data of this type in the selected captures.</Data></Cell></Row>\n`;
    }
    rows.forEach((row) => {
      xml += `   <Row>\n`;
      row.forEach((cell) => {
        const isNum = typeof cell === "number" && Number.isFinite(cell);
        xml += `    <Cell><Data ss:Type="${isNum ? "Number" : "String"}">${isNum ? cell : sanitizeXML(cell)}</Data></Cell>\n`;
      });
      xml += `   </Row>\n`;
    });
    xml += `  </Table>\n </Worksheet>\n`;
  };

  const stamp = (r) => new Date(r.capturedAt).toLocaleString(uiLang());

  // Full source detail — the Domain Data sheet only carries the domain, which
  // loses the actual page that was cited.
  const sourceRows = [];
  records.forEach((r, i) => {
    (r.sources || []).forEach((s) => {
      sourceRows.push([
        i + 1, r.userPrompt || "", stamp(r), s.outcome || "", s.type || "",
        s.domain || "", s.title || "", s.url || "",
        (s.platformSpecific && s.platformSpecific.resultSource) || "",
        (pipelineOf(s.platformSpecific && s.platformSpecific.pipeline) || {}).label || "",
        (s.snippet || "").slice(0, 400),
      ]);
    });
  });
  addSheet("Sources (full)", "Every cited and fetched source with its page title, URL and snippet. Pipeline is the index ChatGPT named for it (only sent 21 May to 21 July 2026).",
    [60, 200, 120, 70, 70, 140, 240, 300, 90, 90, 400],
    ["Prompt #", "Prompt", "Captured", "Outcome", "Type", "Domain", "Page title", "URL", "Retrieval", "Pipeline", "Snippet"],
    sourceRows);

  // Fan-out queries, one row each.
  const fanRows = [];
  records.forEach((r, i) => {
    ["search", "shopping", "image"].forEach((bucket) => {
      (r.fanout[bucket] || []).forEach((q) => fanRows.push([i + 1, r.userPrompt || "", stamp(r), bucket, q.query || ""]));
    });
  });
  addSheet("Fan-Out Queries", "Each sub-query the model issued behind the original prompt.",
    [60, 200, 120, 80, 320], ["Prompt #", "Prompt", "Captured", "Type", "Fan-out query"], fanRows);

  // Brand mentions — count 0 means shown in a card but never named in prose.
  const brandRows = [];
  records.forEach((r, i) => {
    (r.brandMentions || []).forEach((b) => {
      brandRows.push([
        i + 1, r.userPrompt || "", stamp(r), b.brand || "", b.category || "",
        b.relation || "", typeof b.count === "number" ? b.count : 0,
        (b.count || 0) === 0 ? "Shown, not named" : "Named in answer",
        (b.passages && b.passages[0] ? b.passages[0] : "").slice(0, 400),
      ]);
    });
  });
  addSheet("Brand Mentions", "Brands the model named, how often, and the surrounding sentence.",
    [60, 200, 120, 180, 110, 90, 60, 130, 400],
    ["Prompt #", "Prompt", "Captured", "Brand", "Category", "Relation", "Mentions", "Status", "Context"],
    brandRows);

  // Products.
  const productRows = [];
  records.forEach((r, i) => {
    (r.products || []).forEach((p) => {
      productRows.push([
        i + 1, r.userPrompt || "", stamp(r), p.name || "", p.brand || "",
        p.price || "", p.merchant || "",
        typeof p.rating === "number" ? p.rating : "", typeof p.reviews === "number" ? p.reviews : "",
      ]);
    });
  });
  addSheet("Products", "Product cards the model surfaced, with price, merchant and rating.",
    [60, 200, 120, 240, 120, 90, 160, 60, 80],
    ["Prompt #", "Prompt", "Captured", "Product", "Brand", "Price", "Merchant", "Rating", "Reviews"],
    productRows);

  // Local businesses.
  const placeRows = [];
  records.forEach((r, i) => {
    (r.places || []).forEach((p) => {
      placeRows.push([
        i + 1, r.userPrompt || "", stamp(r), p.name || "", p.category || "",
        typeof p.rating === "number" ? p.rating : "", typeof p.reviews === "number" ? p.reviews : "",
        p.phone || "", p.address || "", p.website || "", p.hours || "", p.mapsUrl || "",
      ]);
    });
  });
  addSheet("Local Businesses", "Business listings the engine returned, with contact and rating data.",
    [60, 200, 120, 220, 120, 60, 80, 120, 320, 240, 260, 260],
    ["Prompt #", "Prompt", "Captured", "Business", "Category", "Rating", "Reviews", "Phone", "Address", "Website", "Hours", "Maps link"],
    placeRows);

  // Entities.
  const entityRows = [];
  records.forEach((r, i) => {
    (r.entities || []).forEach((e) => entityRows.push([i + 1, r.userPrompt || "", stamp(r), e.text || "", e.category || ""]));
  });
  addSheet("Entities", "Named entities detected in each answer, with their category.",
    [60, 200, 120, 220, 130], ["Prompt #", "Prompt", "Captured", "Entity", "Category"], entityRows);

  // Full answer text, so the workbook is self-contained for reading back.
  const answerRows = records.map((r, i) => [
    i + 1, r.userPrompt || "", stamp(r), r.platform || "", r.model || "",
    r.generatedTitle || "", r.answerChars || 0, (r.answerText || "").slice(0, 30000),
  ]);
  addSheet("Answers", "The full answer text behind every capture.",
    [60, 200, 120, 80, 90, 200, 70, 600],
    ["Prompt #", "Prompt", "Captured", "Platform", "Model", "Conversation title", "Chars", "Answer text"],
    answerRows);

  xml += `</Workbook>`;
  download(`citoskeleton-audit-${Date.now()}.xls`, xml, "application/vnd.ms-excel");
}

// One raw-capture header format, used everywhere a raw payload is handed
// over (the standalone "Download raw payload" button, the feedback bundle,
// and the campaign diagnostics export) — this used to be built inline in
// two separate places with the same three lines, which is exactly how the
// two copies would eventually drift.
function formatRawCapture(captureId, meta, rawText) {
  return (
    `# CitoSkeleton raw capture ${captureId}\n` +
    `# url: ${(meta && meta.url) || ""}\n` +
    `# reqBody: ${(meta && meta.reqBody) || ""}\n\n` + rawText
  );
}

async function downloadRaw(captureId, label) {
  const r = await send({ type: "get-raw", captureId });
  if (!r.ok || r.raw == null) { showToast("No raw payload stored for this capture.", "error"); return; }
  download(`citoskeleton-raw-${label || captureId}.txt`, formatRawCapture(captureId, r.meta, r.raw), "text/plain");
}
function toCsv(records) {
  const rows = [["capturedAt", "platform", "model", "prompt", "searched", "fanoutCount", "sourceCount"]];
  records.forEach((r) => {
    const fan = ((r.fanout?.search?.length || 0) + (r.fanout?.shopping?.length || 0) + (r.fanout?.image?.length || 0));
    rows.push([
      new Date(r.capturedAt).toISOString(), r.platform, r.model || "",
      r.userPrompt || "", r.searched, fan, r.sources.length,
    ]);
  });
  return csvOf(rows); // csvCell handles quoting + formula-injection escaping
}

/* ==================================================================
 * GEO brand tracking — the "tool under the tool".
 *
 * Deliberately separate from the ad-hoc capture views: a fixed brand set +
 * prompt set + engine set, re-run on a cadence, so the numbers are comparable
 * over time. Its responses never enter RECORDS (see the isolation note in
 * load()), and its metrics are computed in the service worker (see the
 * "geo-metrics" handler) because Position needs the full answer text.
 * ================================================================== */

const geoActive = () => GEO_PROFILES.find((p) => p.id === geoActiveId) || GEO_PROFILES[0] || null;
/* Compact "3d ago" style stamp. A full locale timestamp in a table column
   ("11/08/2026 19:13:28") is both unreadable at a glance and wide enough to
   push everything else off the edge of the 540px popup; the exact time stays
   available as the cell's title. */
function relTime(ts) {
  if (!ts) return "\u2014";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(dateLocale(), { month: "short", day: "numeric" });
}
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(Number(n) >= 10 ? 0 : 1)}%`);

async function loadGeo() {
  const pr = await send({ type: "geo-profile-list", includeDeleted: true });
  const all = pr.ok ? pr.profiles : [];
  GEO_PROFILES = all.filter((p) => !p.deletedAt);
  TRASHED_PROFILES = all.filter((p) => p.deletedAt);
  if (!geoActiveId || !GEO_PROFILES.some((p) => p.id === geoActiveId)) geoActiveId = GEO_PROFILES[0]?.id || null;
  const active = geoActive();
  GEO_PROMPTS = [];
  if (active) {
    const qs = await send({ type: "geo-prompt-list", profileId: active.id });
    if (qs.ok) GEO_PROMPTS = qs.prompts;
  }
  selectedPromptIds = new Set();
  // While this campaign's run is going, a new capture changes nothing the
  // page shows (the board leaves the running run out), so the page isn't
  // rebuilt: rebuilding it on every capture bounced the reader back to the
  // top (0.62.2, reported). Progress keeps updating on its own poll.
  if (cpFromBroadcast && cpHolding(active) && document.getElementById("cpHead")) return;
  // A new capture never changes a setup form either. While a run went on,
  // setting up or editing another campaign was rebuilt every 2–3 s by the
  // run's captures: a half-typed competitor, prompts pasted but not yet
  // added, and the cursor were all lost (live run, 23 Nov 2026).
  if (cpFromBroadcast && cpSetupOnScreen()) return;
  renderCampaigns();
}
function cpSetupOnScreen() { return !!document.querySelector("#loader .cs-card-details"); }
// A run for this campaign is in progress (renderLoaderStatus keeps cpLive).
let cpFromBroadcast = false; // set while refreshFromBroadcast's load() runs
function cpHolding(profile) { return !!(profile && cpLive.live && cpLive.profileId === profile.id); }

/* ---------- Campaigns tab (setup + prompts + LLMs + run, formerly
   Tracking + Loader) ---------- */

function renderCampaigns() { withScrollPreserved(renderCampaignsImpl); }
// Where the reader was, read before the page is emptied: read after, the
// page is one line tall and the value comes back clamped to the top.
let cpScrollY = 0;
function renderCampaignsImpl() {
  const root = $("#loader");
  if (!root) return;
  const sc = activeScroller();
  cpScrollY = sc ? sc.scrollTop : 0;
  root.textContent = "";
  const profile = geoActive();
  cbHeaderNav = null;
  setHeaderPage("loader");

  // A set-up campaign opens on its own header card (renderCampaignHead), which
  // carries the switcher; the chooser card is for setting one up.
  if (profile && profile.locked) {
    // A brand's page against yours stands on its own, with a way back.
    const detail = cbDetail && cbProfileId === profile.id;
    if (!detail && TRASHED_PROFILES.length) root.append(renderTrashedCampaigns());
    if (!detail) root.append(renderCampaignHead(profile));
    if (!detail && campaignManageOpen) root.append(renderCampaignSetup(profile, false));
    if (profile.lastRunAt || ALL_RECORDS.some((r) => r.geo && r.geo.profileId === profile.id)) root.append(renderCampaignResults(profile));
    return;
  }

  if (!profile) {
    const bar = el("div", { className: "card" });
    const barHead = el("div", { className: "card-header" }, el("h3", {}, "Campaigns"));
    barHead.append(el("span", { className: "muted small" }, `${GEO_PROFILES.length} of ${MAX_PROFILES} used`));
    bar.append(barHead, renderCampaignSwitcher());
    root.append(bar);
    if (TRASHED_PROFILES.length) root.append(renderTrashedCampaigns());
    root.append(renderCampaignEmptyState());
    return;
  }

  if (TRASHED_PROFILES.length) root.append(renderTrashedCampaigns());
  if (!campaignOnboardDismissed) root.append(renderOnboardingBanner());
  // As on the canvas: a breadcrumb in the setup's own bar, with the other
  // campaigns beside it, instead of a chooser card above.
  const setup = renderCampaignSetup(profile, false);
  setup.querySelector(".cs-bar-title")?.prepend(el("div", { className: "cs-crumb" },
    el("nav", { className: "cs-crumb-path", "aria-label": "Breadcrumb" }, el("span", {}, "Campaigns"), el("span", { "aria-hidden": "true" }, "/"), el("span", { "aria-current": "page" }, profile.createdAt && profile.lastRunAt ? "Edit campaign" : "New campaign")),
    renderCampaignSwitcher()));
  root.append(setup);
  if (profile.lastRunAt || ALL_RECORDS.some((r) => r.geo && r.geo.profileId === profile.id)) root.append(renderCampaignResults(profile));
}

function renderCampaignSwitcher() {
  const switcher = el("div", { className: "geo-switcher" });
  GEO_PROFILES.forEach((p) => {
    const b = el("button", { className: `geo-chip${p.id === geoActiveId ? " active" : ""}` }, p.name || "Untitled");
    if (p.locked) b.append(el("span", { className: "lock" }, " 🔒"));
    b.onclick = () => { geoActiveId = p.id; campaignManageOpen = false; loadGeo(); };
    switcher.append(b);
  });
  if (GEO_PROFILES.length < MAX_PROFILES) {
    const add = el("button", { className: "geo-chip add" }, "+ New campaign");
    add.onclick = async () => {
      const r = await send({ type: "geo-profile-save", profile: makeProfile({ name: `Campaign ${GEO_PROFILES.length + 1}` }) });
      if (r.ok) { geoActiveId = r.profile.id; campaignManageOpen = false; loadGeo(); } else showToast(r.error, "error");
    };
    switcher.append(add);
    const imp = el("button", { className: "geo-chip add", type: "button", id: "cpImport", title: "Open a campaign someone shared with you" }, "Import…");
    imp.onclick = () => openImportDialog();
    switcher.append(imp);
  }
  return switcher;
}

/* ---------- A campaign's results (0.50.0) ----------
 * Release 4 of the canvas redesign: the campaign board. One brand at a time
 * ("viewing as", your own by default): how it shows up by kind of answer,
 * against each competitor, on each engine, run by run, topic by topic and
 * prompt by prompt, and which sites the engines lean on, including the ones
 * that cite rivals and never mention it. The figures come from
 * src/lib/campaignBoard.js through the background's "campaign-board"
 * message (positions need the answer text). Clicking a brand opens its
 * detail against yours (renderCampaignBrandDetail).
 *
 * It opens on the latest run, so the KPIs can say what changed since the run
 * before; "All runs combined" is one pick away.
 */
let cbRun = null;            // null or "latest": each prompt's newest answer per engine (0.80.0); "all"; or a run id
let cbViewAs = null;         // brand name; null: your own brand
let cbFocus = "mentions";    // which KPI view
let cbTags = [];
let cbTagMode = "any";       // with several tags: "any" or "all" of them (0.67.0)
let cbPromptFilter = "all";
let cbOpenPrompts = new Set();
let cbDetail = null;         // brand whose detail is open
let cbProfileId = null;      // the campaign the state above belongs to
let cbHeaderNav = null;      // the board's section links, shown in the app bar

// Setup's names for the board's views ("What this campaign should measure").
const CS_MEASURE = {
  mentions: ["Brand named in answers", "Visibility, share of voice, position"],
  citations: ["Your site cited", "Pages the engines cite, and the gaps"],
  products: ["Product cards and stores", "Card share, card position, where cards send buyers"],
  images: ["Images", "Which sites supply images, where clicks land"],
  local: ["Map listings", "Pin position and listing details, for places"],
};
const CB_FOCUS = [
  ["mentions", "Mentions", "book", "Named in the answer text"],
  ["citations", "Citations", "pages", "Its site used as a source"],
  ["products", "Product cards", "cart", "Product carousels, and where each card sends buyers"],
  ["images", "Images", "image", "Images in answers, and where a click lands"],
  ["local", "Map listings", "pin", "Map pins and listing details"],
];
// Glossary keys for the tiles that have a definition (src/lib/glossary.js).
const CB_TERMS = { "Visibility": "visibility", "Share of voice": "shareOfVoice", "Avg position": "avgPosition", "Mentions": "mentions", "Citations": "citations", "Source visibility": "sourceVisibility" };
// Whole percents, except a small non-zero share keeps one decimal so 0.4% of
// answers doesn't read as none at all.
const cbPct = (x) => (x == null ? "—" : x > 0 && x < 10 && Math.round(x * 10) % 10 ? `${x.toFixed(1)}%` : `${Math.round(x)}%`);
const cbPos = (x) => (x == null ? "—" : x.toFixed(1));

function cbSection(id, title, sub, ...kids) {
  const head = el("div", { className: "cb-sec-head" }, el("h3", { className: "cb-h", id: `${id}-h` }, title));
  if (sub) head.append(typeof sub === "string" ? el("span", { className: "muted small" }, sub) : sub);
  return el("section", { className: "cb-sec", id, "aria-labelledby": `${id}-h` }, head, ...kids);
}
function cbBar(pctValue, cls = "") {
  return el("span", { className: `cb-bar ${cls}`, "aria-hidden": "true" }, el("span", { style: `width:${Math.max(0, Math.min(100, pctValue || 0))}%` }));
}

function renderCampaignResults(profile) {
  if (cbProfileId !== profile.id) {
    cbProfileId = profile.id; cbRun = null; cbViewAs = null; cbTags = []; cbFocus = "mentions";
    cbPromptFilter = "all"; cbOpenPrompts = new Set(); cbDetail = null;
    resetCampaignViewState();
  }
  const box = el("section", { className: "campaign-results", id: "campaignResults", "aria-labelledby": "campaignResultsH" });
  box.append(el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", { id: "campaignResultsH" }, "Results")), el("div", { className: "muted small" }, "Loading results…")));
  // Filled once the box is in the page. It starts as one line, so the scroll
  // position (read before the page was emptied) is put back once the board
  // reaches its real height.
  const scroller = activeScroller();
  const y = cpScrollY;
  const running = cpHolding(profile);
  setTimeout(async () => {
    if (cbDetail) await renderCampaignBrandDetail(box, profile);
    else await renderCampaignBoard(box, profile);
    // A run in progress isn't on the board yet (0.62.2, asked): say so.
    if (running) box.prepend(el("p", { className: "cb-run-wait", role: "status" }, "A run is in progress. Its answers appear here when it finishes or is stopped; the board below is the runs already finished."));
    if (scroller && y > 0 && scroller.scrollTop !== y) scroller.scrollTop = y;
  }, 0);
  return box;
}

/* Which kinds of site an answer kind cited (0.59.0, replacing the advice
   column): one thin stacked bar in the site-kind colours and the shares as
   text, so colour is never the only carrier. */
function cbSourceMix(k) {
  const cell = el("span", { role: "cell", className: "cb-mix small" });
  if (!k.answers) { cell.append(el("span", { className: "muted" }, k.id === "local" ? "No local answers in this campaign" : "")); return cell; }
  if (k.id === "memory" || !k.citedPages) { cell.append(el("span", { className: "muted" }, k.id === "memory" ? "No search, so nothing cited" : "Nothing cited")); return cell; }
  const bar = el("span", { className: "cb-mix-bar", "aria-hidden": "true" });
  k.sources.forEach((x) => bar.append(el("i", { style: `width:${x.pct.toFixed(1)}%;background:var(${AP_KIND_VAR[x.label] || "--kind-other"})` })));
  cell.append(bar, el("span", { className: "cb-mix-text" }, `${k.citedPages} cited · ` + k.sources.map((x) => `${x.label.toLowerCase()} ${Math.round(x.pct)}%`).join(", ")));
  return cell;
}

async function renderCampaignBoard(box, profile) {
  const r = await send({ type: "campaign-board", profileId: profile.id, runId: cbRun || undefined, viewAs: cbViewAs || undefined, engines: geoEngineFilter, tags: cbTags, tagMode: cbTagMode });
  box.textContent = "";
  if (!r || !r.ok) { box.append(el("div", { className: "card" }, el("div", { className: "empty" }, (r && r.error) || "Couldn't load this campaign's results."))); return; }
  const b = r.board;
  const rerender = () => renderCampaigns();
  const view = b.view;
  const you = view.isOwn ? "you" : view.name;

  /* --- the filters, under the campaign's header (renderCampaignHead) --- */
  // A campaign that isn't set up has no header card; the filters get one.
  const slot = document.getElementById("cpFilters");
  const head = slot || el("div", { className: "card cb-head" });
  if (slot) slot.textContent = "";
  const runsWithAnswers = r.runs.filter((x) => x.hasAnswers);
  const runsAsc = [...r.runs].sort((a, c) => (a.startedAt || 0) - (c.startedAt || 0));
  const runNo = (id) => runsAsc.findIndex((x) => x.id === id) + 1;
  const runDate = (t) => new Date(t).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
  const scope = el("span", { className: "muted small cp-scope", id: "campaignResultsH" }, `${r.answers} answer${r.answers === 1 ? "" : "s"} · ${b.runLabel}${b.previousLabel ? ` · compared with ${b.previousLabel}` : ""}`);
  if (!slot) head.append(el("div", { className: "card-header" }, el("h3", {}, "Results"), scope));
  const controls = el("div", { className: "cb-controls" });
  const runSel = el("select", { className: "filter", id: "cbRun", "aria-label": "Run", title: "The newest answer for each prompt on each engine, one run, or every run combined" });
  // The default (0.80.0): each engine's newest answers, from whichever run,
  // so engines run on different days read as one campaign.
  // Offered when engines ran in different runs (r.mixedRuns).
  if (r.mixedRuns) runSel.append(el("option", { value: "latest" }, "Latest answers · every engine"));
  runsWithAnswers.forEach((x, i) => runSel.append(el("option", { value: x.id }, `Run ${runNo(x.id)} · ${runDate(x.startedAt)}${r.mixedRuns && (x.engines || []).length ? ` · ${x.engines.map(atEngineLabel).join(", ")}` : ""}${i === 0 ? ` ${tr("(latest)")}` : ""}`)));
  runSel.append(el("option", { value: "all" }, "All runs combined"));
  runSel.value = r.runId;
  runSel.onchange = () => { cbRun = runSel.value; rerender(); };
  // Engines (0.67.0): one, several or all, asked for as "a single or more
  // than 1 and all llms". Toggle chips; none on means every engine.
  const engine = el("div", { className: "cb-engs", role: "group", "aria-label": "Engines" });
  const engAll = el("button", { type: "button", className: `db-chip${geoEngineFilter.length ? "" : " on scope"}`, "aria-pressed": geoEngineFilter.length ? "false" : "true" }, "All");
  engAll.onclick = () => { geoEngineFilter = []; rerender(); };
  engine.append(engAll);
  (profile.engines && profile.engines.length ? availableEngines().filter((e) => profile.engines.includes(e.id)) : availableEngines()).forEach((e) => {
    const on = geoEngineFilter.includes(e.id);
    const c = el("button", { type: "button", className: `db-chip cb-eng${on ? " on scope" : ""}`, "aria-pressed": on ? "true" : "false", "data-engine": e.id }, engineIconEl(e.id), e.label);
    c.onclick = () => { geoEngineFilter = on ? geoEngineFilter.filter((x) => x !== e.id) : [...geoEngineFilter, e.id]; rerender(); };
    engine.append(c);
  });
  // A dropdown, not chips: a campaign can track twenty brands. Each option
  // carries its visibility so the list still reads as a ranking.
  const picker = el("select", { className: "filter brand-picker", "aria-label": "Viewing as", title: "Point the whole board at one brand" });
  const rowOf = (name) => b.brandRows.find((x) => x.name === name);
  const groups = [["Your brand", r.brands.filter((x) => x.isOwn)], [`Competitors (${r.brands.filter((x) => !x.isOwn && !x.auto).length})`, r.brands.filter((x) => !x.isOwn && !x.auto)], [`Found in the answers (${r.brands.filter((x) => x.auto).length})`, r.brands.filter((x) => x.auto)]];
  groups.forEach(([label, list]) => {
    if (!list.length) return;
    const g = el("optgroup", { label });
    list.forEach((x) => g.append(el("option", { value: x.name, selected: x.name === view.name }, `${x.isOwn ? fmt("{brand} (you)", { brand: x.name }) : x.name} · ${cbPct(rowOf(x.name) ? rowOf(x.name).visibility : 0)}`)));
    picker.append(g);
  });
  picker.onchange = () => { const x = r.brands.find((y) => y.name === picker.value); cbViewAs = x && x.isOwn ? null : picker.value; rerender(); };
  const wb = document.getElementById("cbExport") || el("button", { className: "btn sm ghost", type: "button", id: "cbExport", title: "The campaign as an Excel workbook or CSV tables" }, "Export…");
  wb.disabled = false;
  wb.onclick = () => openExportDialog(profile, {
    engines: b.engines, runs: runsWithAnswers.length, answers: r.answers, latestDate: runsWithAnswers[0] ? runDate(runsWithAnswers[0].startedAt) : "",
    // Newest first, as the run picker lists them; the PDF reports on one.
    runList: runsWithAnswers.map((x) => ({ id: x.id, no: runNo(x.id), date: runDate(x.startedAt) })),
  });
  // 0.67.0: back, asked for as "the entire data for not just my brand but
  // other competition as well": the whole board, measured for the brand
  // picked here.
  controls.append(
    el("label", { className: "cb-ctl" }, el("span", { className: "muted small" }, "Run"), runSel),
    el("label", { className: "cb-ctl" }, el("span", { className: "muted small" }, "Brand"), picker),
    el("div", { className: "cb-ctl" }, el("span", { className: "muted small" }, "Engines"), engine));
  if (!wb.isConnected) controls.append(wb);
  head.append(controls);
  if (geoEngineFilter.length) head.append(el("span", { className: "scope-note muted small" }, `${geoEngineFilter.map((id) => (availableEngines().find((e) => e.id === id) || {}).label || id).join(" and ")} only`));
  if (r.tags.length) {
    const tw = el("div", { className: "cb-tags", role: "group", "aria-label": "Tags" }, el("span", { className: "muted small" }, "Tags"));
    r.tags.forEach((t) => {
      const on = cbTags.includes(t);
      const c = el("button", { className: `db-chip${on ? " on scope" : ""}`, type: "button", "aria-pressed": on ? "true" : "false" }, t);
      c.onclick = () => { cbTags = on ? cbTags.filter((x) => x !== t) : [...cbTags, t]; rerender(); };
      tw.append(c);
    });
    // With two or more tags: prompts carrying any of them, or all of them.
    if (cbTags.length > 1) {
      const mode = el("div", { className: "cv-seg cb-tagmode", role: "group", "aria-label": "Match" });
      [["any", "Any of these"], ["all", "All of these"]].forEach(([v, l]) => {
        const b = el("button", { type: "button", className: cbTagMode === v ? "on" : "", "aria-pressed": cbTagMode === v ? "true" : "false" }, l);
        b.onclick = () => { cbTagMode = v; rerender(); };
        mode.append(b);
      });
      tw.append(mode);
    }
    if (cbTags.length) { const c = el("button", { className: "linkbtn", type: "button" }, "Clear"); c.onclick = () => { cbTags = []; rerender(); }; tw.append(c); }
    head.append(tw);
  }
  // The sections are tabs above the board itself now (ui/campaignView.js),
  // not links in the app bar, where they wrapped onto two rows.
  cbHeaderNav = null;
  if (slot) head.append(scope);
  if (!slot) box.append(head);

  if (!r.answers) {
    // Run history lives under "Data collected", which needs answers; a run
    // that captured nothing is exactly when it matters, so it shows here too.
    box.append(el("div", { className: "card" }, el("div", { className: "empty" }, "No answers for these filters yet. Run the campaign, or widen the filters above."), renderRunHistory(profile)));
    return;
  }

  /* --- competitors inferred from the answers, stated, never applied silently --- */
  // One click adds one (0.77.0, asked: adding the competition found by a run
  // shouldn't need the campaign opened and unlocked). The suggestions stay
  // after one is added: the rest are still named in the answers.
  const counted = new Set(r.brands.filter((x) => x.auto).map((x) => x.name));
  const suggested = (r.suggested || []).map((x) => x.name);
  const addCompetitors = async (names, btn) => {
    if (btn) btn.disabled = true;
    const res = await send({ type: "geo-competitor-add", profileId: profile.id, names });
    if (!res || !res.ok) { if (btn) btn.disabled = false; showToast((res && res.error) || "Couldn't add that competitor", "error"); return; }
    const n = (res.added || []).length;
    showToast(n ? `Added ${n === 1 ? res.added[0] : `${n} competitors`} to ${profile.name || "this campaign"}` : "Already on the list");
    loadGeo();
  };
  // The banner only while the found brands are being counted (no competitors
  // of the campaign's own): it says so, and offers to save them. Once the
  // campaign has competitors the rest are offered in the Brands tab.
  const countedNames = suggested.filter((n) => counted.has(n));
  if (countedNames.length || r.excludedBrands.length) {
    const banner = el("div", { className: "card auto-comp-banner" });
    if (countedNames.length) {
      banner.append(el("div", { className: "small" },
        el("strong", { "data-term": "autoCompetitor" }, "Also named often, but not on your competitor list. "),
        el("span", { className: "muted" }, `These ${countedNames.length} brand${countedNames.length === 1 ? " is" : "s are"} counted as competitors because the answers named ${countedNames.length === 1 ? "it" : "them"} most. Nothing has been saved to the campaign.`)));
      const chips = el("div", { className: "tagline" });
      countedNames.forEach((n) => {
        const chip = el("span", { className: "tag tag-removable cb-sugg" }, n);
        chip.dataset.name = n;
        const add = el("button", { className: "tag-add", type: "button", title: fmt("Add {brand} as a competitor", { brand: n }), "aria-label": fmt("Add {brand} as a competitor", { brand: n }) }, "+ Add");
        add.onclick = () => addCompetitors([n], add);
        const x = el("button", { className: "tag-x", type: "button", title: `Leave out ${n}`, "aria-label": `Leave out ${n}` }, "×");
        x.onclick = async () => {
          x.disabled = true;
          const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name: n });
          if (!res.ok) { x.disabled = false; showToast(res.error || "Couldn't leave that brand out", "error"); return; }
          if (cbViewAs === n) cbViewAs = null;
          showToast(`${n} is no longer counted as a competitor`);
          loadGeo();
        };
        chip.append(add, x);
        chips.append(chip);
      });
      // One click, on a locked campaign too (0.77.0: this used to fail there).
      const save = el("button", { className: "btn sm ghost", type: "button", id: "cbAddAll" }, "Save these as competitors");
      save.onclick = () => addCompetitors(countedNames, save);
      banner.append(chips, save);
    }
    if (r.excludedBrands.length) {
      const row = el("div", { className: "excluded-row muted small" }, el("span", {}, "Left out:"));
      r.excludedBrands.forEach((n) => {
        const chip = el("span", { className: "tag tag-removable is-excluded" }, n);
        const undo = el("button", { className: "tag-x", type: "button", title: `Count ${n} as a competitor again`, "aria-label": `Bring back ${n}` }, "↺");
        undo.onclick = async () => {
          undo.disabled = true;
          const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name: n, restore: true });
          if (!res.ok) { undo.disabled = false; showToast(res.error || "Couldn't bring that brand back", "error"); return; }
          loadGeo();
        };
        chip.append(undo);
        row.append(chip);
      });
      banner.append(row);
    }
    box.append(banner);
  }

  /* --- what changed since the campaign was locked (0.77.0) --- */
  if ((r.changes || []).length) {
    const list = el("ul", { className: "cb-changes-list" });
    [...r.changes].reverse().slice(0, 50).forEach((c) => list.append(el("li", {},
      el("span", { className: "muted" }, new Date(c.at).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })), " ", changeText(c))));
    const firstAt = r.changes[0].at;
    const runsAfter = (r.runs || []).filter((x) => x.startedAt > firstAt).length;
    box.append(el("details", { className: "card cb-changes", id: "cbChanges" },
      el("summary", {}, el("b", {}, `Changed since it was set up: ${r.changes.length} change${r.changes.length === 1 ? "" : "s"}`),
        el("span", { className: "muted small" }, ` · runs before ${new Date(firstAt).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })} were measured against the earlier setup${runsAfter ? "" : "; no run since"}`)),
      list));
  }

  /* --- the board (0.64.0): src/lib/campaignView.js, drawn by ui/campaignView.js --- */
  // The sources table with its drill-downs stays, at the foot of Sources.
  const srcBox = cbSection("cb-sources", "Every site, with its pages", "", el("div", { className: "muted small" }, "Loading sources…"));
  // For Run vs run (0.80.0): the runs with answers, newest first, and the
  // comparison of any two, worked out by the worker over the same engines
  // and tags as the board.
  const runsAscAll = [...r.runs].sort((a, c) => (a.startedAt || 0) - (c.startedAt || 0));
  const runsForCompare = [...r.runs].filter((x) => x.hasAnswers).sort((a, c) => (c.startedAt || 0) - (a.startedAt || 0)).map((x) => ({
    id: x.id, hasAnswers: true, engines: x.engines || [],
    label: `Run ${runsAscAll.findIndex((y) => y.id === x.id) + 1} · ${new Date(x.startedAt).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })}${(x.engines || []).length ? ` · ${x.engines.map(atEngineLabel).join(", ")}` : ""}`,
  }));
  if ((r.runs || []).some((x) => x.hasAnswers)) gsMark("results"); // Get started (1.0.0)
  renderCampaignView(box, r.view, {
    el, engineIcon: engineIconEl, openCapture, realOwn: r.ownBrand,
    runs: runsForCompare,
    compareRuns: async (a, c) => {
      const res = await send({ type: "campaign-run-compare", profileId: profile.id, runA: a, runB: c, engines: geoEngineFilter, tags: cbTags, tagMode: cbTagMode, viewAs: cbViewAs || undefined });
      return res && res.ok ? res.compare : null;
    },
    deltas: Object.fromEntries(((b.focus && b.focus.mentions) || []).map((k) => [k.label, k.delta])),
    openDomain: (d) => openCampaignDomain(profile, d),
    openFullCompare: (name) => { cbDetail = name; renderCampaigns(); },
    addCompetitor: (name, btn) => addCompetitors([name], btn),
    // Offered in the Brands tab once the campaign has competitors of its own.
    suggested: suggested.filter((n) => !counted.has(n)),
    addAll: (btn) => addCompetitors(suggested.filter((n) => !counted.has(n)), btn),
    excludeBrand: async (name, btn) => {
      btn.disabled = true;
      const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name });
      if (!res.ok) { btn.disabled = false; showToast(res.error || "Couldn't leave that brand out", "error"); return; }
      showToast(`${name} is no longer counted as a competitor`);
      loadGeo();
    },
  }, { sourcesDrill: srcBox, runHistory: renderRunHistory(profile) });
  renderCampaignSources(srcBox, profile, { runId: r.runId === "all" ? undefined : r.runId });
}

/* The sources table: domains or URLs, reach before volume, each row drilling
 * down (openDomainDetailModal / openUrlDetailModal). Unchanged from the
 * Prompt Performance card it lived in before 0.50.0; it reads the same
 * geo-prompt-performance aggregate. */
async function renderCampaignSources(sec, profile, { runId, focusBrand } = {}) {
  const r = await send({ type: "geo-prompt-performance", profileId: profile.id, focusBrand, tags: cbTags, engines: geoEngineFilter, runId });
  [...sec.children].forEach((n, i) => { if (i > 0) n.remove(); });
  if (!r || !r.ok) { sec.append(el("div", { className: "empty" }, (r && r.error) || "Couldn't load the sources.")); return; }
  const rerender = () => renderCampaignSources(sec, profile, { runId, focusBrand });
  // Citation VOLUME and REACH are different numbers and must not be one
  // column: a domain cited three times in a single answer scores three
  // citations but one response of visibility. See src/lib/sources.js for the
  // definitions and test/sources.test.mjs for the worked example.
  const promptTextById = new Map((GEO_PROMPTS || []).map((p) => [p.id, p.text]));
  const { domains: domainAgg, urls: urlAgg, totalResponses: srcResponses } = aggregateSources(r.prompts || {}, promptTextById);
  const head = sec.querySelector(".cb-sec-head");
  head.querySelector(".src-head-tools")?.remove();
  const modeToggle = el("div", { className: "filter-bar", style: "margin:0" });
  [["domain", "Domains"], ["url", "URLs"]].forEach(([v, l]) => {
    const pill = el("button", { className: `filter-pill${sourceViewMode === v ? " active" : ""}`, type: "button" }, l);
    pill.onclick = () => { sourceViewMode = v; rerender(); };
    modeToggle.append(pill);
  });
  const search = el("input", { id: "sourceSearch", type: "text", className: "filter search-input", placeholder: sourceViewMode === "domain" ? "Filter domains…" : "Filter URLs…", value: sourceSearch, "aria-label": "Filter sources" });
  search.oninput = () => {
    sourceSearch = search.value;
    const cursor = search.selectionStart;
    rerender().then(() => { const next = $("#sourceSearch"); if (next) { next.focus(); next.setSelectionRange(cursor, cursor); } });
  };
  head.append(el("div", { className: "src-head-tools" }, modeToggle, search));
  head.querySelector(".muted.small")?.replaceChildren(`from ${srcResponses} answer${srcResponses === 1 ? "" : "s"}`);
  // Sorted by reach first, volume second: a domain cited nine times inside a
  // single answer is less useful to know about than one cited once in every
  // answer, and only the visibility ordering says so.
  const activeMap = sourceViewMode === "domain" ? domainAgg : urlAgg;
  const rows = [...activeMap.values()].filter((row) => matchesSearch(row.key, sourceSearch))
    .sort((a, b) => b.visibility - a.visibility || b.citations - a.citations || b.fetched - a.fetched || a.key.localeCompare(b.key));
  const shown = rows.slice(0, 50);
  if (!shown.length) { sec.append(el("div", { className: "empty" }, sourceSearch ? `No sources match "${sourceSearch}".` : "No sources captured yet for these filters.")); return; }
  const t = el("table", { className: "drill-table src-table" });
  const hdr = [el("th", { className: "src-col-idx" }, "#"), el("th", {}, sourceViewMode === "domain" ? "Domain" : "URL")];
  if (sourceViewMode === "domain") hdr.push(el("th", { className: "num", "data-term": "distinctUrls" }, "URLs"));
  hdr.push(
    // The bar is on Visibility, not Citations: a percentage has a fixed 0-100
    // scale a bar can honestly show.
    el("th", { "data-term": "domainVisibility" }, "Visibility"),
    el("th", { className: "num", "data-term": "domainCitations" }, "Citations"),
    el("th", { className: "num", "data-term": "distinctPrompts" }, "Prompts"),
    el("th", { className: "num", "data-term": "readOnly" }, "Read-only"),
    el("th", { className: "num", "data-term": "citedRate" }, "Cited %"));
  t.append(el("tr", {}, ...hdr));
  shown.forEach((row, i) => {
    const key = el("button", { className: "linkbtn td-domain-btn", type: "button", title: sourceViewMode === "domain" ? "Click for this domain's URLs and the prompts they came from" : "Click to see which prompts cited this URL" });
    key.append(highlightMatch(row.key, sourceSearch));
    key.onclick = () => (sourceViewMode === "domain" ? openDomainDetailModal(row, `Source breakdown · ${profile.name || "Untitled campaign"}`, "prompt") : openUrlDetailModal(row.key, profile));
    const bar = el("div", { className: "src-bar", title: `Cited in ${row.citedResponses} of ${srcResponses} responses` },
      el("div", { className: "src-bar-fill", style: `width:${Math.round(row.visibility)}%` }), el("span", { className: "src-bar-n" }, fmtPct(row.visibility)));
    const cells = [el("td", { className: "src-col-idx muted" }, String(i + 1)), el("td", { className: "td-domain" }, key)];
    if (sourceViewMode === "domain") cells.push(el("td", { className: "num" }, String(row.urls.size)));
    cells.push(el("td", { className: "src-bar-cell" }, bar), el("td", { className: "num" }, String(row.citations || 0)), el("td", { className: "num" }, String(row.citedPromptIds.size)),
      el("td", { className: "num muted" }, String(row.fetched || 0)), el("td", { className: "num" }, fmtPct(row.citedRate)));
    t.append(el("tr", {}, ...cells));
  });
  sec.append(el("div", { className: "drill-scroll" }, t));
  if (rows.length > shown.length) sec.append(el("div", { className: "muted small", style: "margin-top:6px" }, `Showing the top ${shown.length} of ${rows.length} — narrow it with the filter above.`));
}

/* ---------- One brand against yours (0.50.0) ----------
 * The canvas's brand detail, in place of the board: the headline numbers
 * side by side, head to head across the answers, each engine, which kinds of
 * site write about each, which sites cite one and not the other, the sites
 * the engines read when they named it, and prompt by prompt who came first.
 * Background: "campaign-brand-detail" (brandDetail() + brandSourceDomains()).
 */
/* A brand's page against yours (0.50.0; laid out as the canvas's
 * TabBrandDetail in 0.55.0): the two brands' numbers, one head-to-head bar,
 * where each is placed on each engine, which kinds of site and which sites
 * back each, and every prompt's verdict per engine with a score. The figures
 * are campaignBoard.js's brandDetail(); this only draws them. */
async function renderCampaignBrandDetail(box, profile) {
  const r = await send({ type: "campaign-brand-detail", profileId: profile.id, brand: cbDetail, runId: cbRun || undefined, engines: geoEngineFilter, tags: cbTags });
  box.textContent = "";
  const back = el("button", { className: "analyze-context-back", type: "button", title: "Back to the campaign" }, el("span", { "aria-hidden": "true" }, "‹"), ` ${profile.name || "Campaign"}`);
  back.onclick = () => { cbDetail = null; cbVsFilter = "all"; renderCampaigns(); };
  if (!r || !r.ok || !r.detail) {
    box.append(el("div", { className: "card" }, back, el("div", { className: "empty" }, (r && r.error) || "That brand has no detail on this campaign.")));
    return;
  }
  const d = r.detail;
  const them = d.them.name, you = d.you.name;
  const youLabel = d.you.isOwn ? fmt("{brand} (you)", { brand: you }) : you;
  const pct = (v) => (v == null ? "—" : `${Math.round(v)}%`);

  /* --- header: back, "X against Y", the other brands as tabs, the numbers --- */
  const others = el("div", { className: "cb-vs-switch", role: "tablist", "aria-label": "Another brand" });
  r.brands.filter((x) => !x.isOwn).forEach((x) => {
    const on = x.name === them;
    const c = el("button", { className: `cb-vs-tab${on ? " on" : ""}`, type: "button", role: "tab", "aria-selected": on ? "true" : "false" }, x.name);
    c.onclick = () => { cbDetail = x.name; cbVsFilter = "all"; renderCampaigns(); };
    others.append(c);
  });
  const head = el("section", { className: "card cb-head cb-detail-head", "aria-labelledby": "cb-detail-h" },
    el("div", { className: "cb-detail-top" }, back,
      el("h2", { className: "cb-detail-title", id: "cb-detail-h" }, them, el("span", { className: "muted" }, " against "), youLabel),
      el("span", { className: `cb-tag${d.them.auto ? " found auto-tag" : ""}` }, d.them.auto ? "found by us" : "competitor"),
      others),
    el("span", { className: "muted small cb-detail-scope" }, `${r.answers} answers · ${r.runLabel}`));
  const fmtVal = (k, v) => (v == null ? "—" : k.unit === "%" ? `${Math.round(v)}%` : k.unit === "rank" ? v.toFixed(1) : String(v));
  const kp = el("div", { className: "cb-vs" });
  d.kpis.forEach((k) => kp.append(el("div", { className: "cb-vs-kpi" },
    el("div", { className: "k-label", ...(CB_TERMS[k.label] ? { "data-term": CB_TERMS[k.label] } : {}) }, k.label),
    el("div", { className: "k-value" }, fmtVal(k, k.them)),
    el("div", { className: `k-sub${k.better === "them" ? " t-bad" : ""}` }, `${you} ${fmtVal(k, k.you)}${k.better === "them" ? ` · ${them} ahead` : ""}`))));
  head.append(kp);
  box.append(head);

  /* --- head to head: one bar --- */
  const h = d.h2h;
  const parts = [["them", h.themOnly, `Only ${them}`, `${you} missing from these answers`, "onlyThem"], ["both", h.both, "Both named", "shared answers", "bothNamed"],
    ["you", h.youOnly, `Only ${you}`, `${them} missing`, "onlyYou"], ["none", h.neither, "Neither", "other brands only", "neitherNamed"]];
  const bar = el("div", { className: "cb-stack", role: "img", "aria-label": parts.map(([, n, l]) => `${l}: ${n}`).join(", ") });
  parts.forEach(([cls, n]) => { if (n) bar.append(el("span", { className: `vs-${cls}`, style: `flex:${n} 1 0` }, String(n))); });
  const legend = el("div", { className: "cb-stack-legend" });
  parts.forEach(([cls, n, label, sub, term]) => legend.append(el("div", { className: `cb-h2h-row ${cls}` },
    el("span", { className: "cb-leg-l", "data-term": term }, el("i", { className: `vs-${cls}` }), label), el("span", { className: "num" }, String(n)), el("span", { className: "muted small" }, sub))));
  if (h.both) legend.append(el("div", { className: "cb-h2h-first" }, el("span", { className: "cb-leg-l", "data-term": "namedFirst" }, el("i", { className: "vs-first" }), `Named first · ${h.firstThem} vs ${h.firstYou}`), el("span", { className: "muted small" }, `${them} vs ${you}, when both appear`)));
  box.append(cbSection("cb-h2h", `Head to head, across ${h.answers} answers`, h.line, bar, legend));

  /* --- on each engine: where each is placed, and how often named --- */
  const pair = el("div", { className: "cb-pair" });
  const maxPos = Math.max(5, ...d.byEngine.flatMap((e) => [e.them.avgPosition || 0, e.you.avgPosition || 0]).map(Math.ceil));
  const at = (v) => `${((v - 1) / (maxPos - 1)) * 100}%`;
  const et = el("div", { className: "cb-dots", role: "table", "aria-label": "On each engine" });
  et.append(el("div", { className: "cb-tr cb-th", role: "row" }, el("span", { role: "columnheader" }, "Engine"), el("span", { role: "columnheader" }, "Named in"),
    el("span", { role: "columnheader", className: "cb-dots-axis" }, el("span", {}, "Average position · 1st"), el("span", {}, ORDINAL(maxPos))), el("span", { role: "columnheader" })));
  d.byEngine.forEach((e) => {
    const tp = e.them.avgPosition, yp = e.you.avgPosition;
    const track = el("span", { className: "cb-dots-track", "aria-hidden": "true" });
    if (tp && yp) track.append(el("span", { className: "cb-dots-line", style: `left:${at(Math.min(tp, yp))};width:calc(${at(Math.max(tp, yp))} - ${at(Math.min(tp, yp))})` }));
    if (tp) track.append(el("span", { className: "cb-dot vs-them", style: `left:${at(tp)}`, title: `${them} ${tp.toFixed(1)}` }));
    if (yp) track.append(el("span", { className: "cb-dot vs-you", style: `left:${at(yp)}`, title: `${you} ${yp.toFixed(1)}` }));
    const themAhead = tp && (!yp || tp < yp);
    et.append(el("div", { className: "cb-tr", role: "row" },
      el("span", { role: "rowheader", className: "cb-engine-name" }, engineIconEl(e.id), e.label),
      el("span", { role: "cell", className: "cb-named" }, el("b", { className: "you" }, `${you} ${pct(e.you.visibility)}`), el("span", {}, `${them} ${pct(e.them.visibility)}`)),
      el("span", { role: "cell" }, track),
      el("span", { role: "cell", className: `num small ${themAhead ? "t-bad" : "t-good"}` }, `${you} ${cbPos(yp)} · ${them} ${cbPos(tp)}`)));
  });
  pair.append(cbSection("cb-vs-engines", "On each engine", el("span", { className: "ap-legend" }, el("span", {}, el("i", { className: "vs-you" }), you), el("span", {}, el("i", { className: "vs-them" }), them)),
    et, d.engineLine ? el("p", { className: "muted small" }, `${d.engineLine} Further left is better.`) : null));

  /* --- where each brand's citations come from: mirrored bars --- */
  if (d.kinds.length) {
    const max = Math.max(1, ...d.kinds.flatMap((k) => [k.them, k.you]));
    const list = el("div", { className: "cb-mirror", role: "table", "aria-label": "Cited pages that mention each brand, by kind of site" });
    list.append(el("div", { className: "cb-mirror-row cb-th", role: "row" }, el("span", { role: "columnheader" }, "Kind of site"), el("span", { role: "columnheader", className: "num" }, them), el("span", { role: "columnheader" }, you)));
    d.kinds.forEach((k) => list.append(el("div", { className: "cb-mirror-row", role: "row" },
      el("span", { role: "rowheader" }, k.label),
      el("span", { role: "cell", className: "cb-mirror-l" }, el("span", { className: "num" }, String(k.them)), el("span", { className: "cb-mbar vs-them", style: `width:${(k.them / max) * 100}%` })),
      el("span", { role: "cell", className: "cb-mirror-r" }, el("span", { className: "cb-mbar vs-you", style: `width:${(k.you / max) * 100}%` }), el("span", { className: "num" }, String(k.you))))));
    pair.append(cbSection("cb-vs-kinds", "Where each brand’s citations come from", "pages that mention the brand", list, d.kindsLine ? el("p", { className: "muted small" }, d.kindsLine) : null));
  }
  box.append(pair);

  /* --- who cites whom: a diverging bar per site, and a verdict --- */
  const smax = Math.max(1, ...d.sites.flatMap((x) => [x.them, x.you]));
  const VERDICT = (x) => (x.them && !x.you ? [`Only ${them}`, "bad"] : x.you && !x.them ? [`Only ${you}`, "good"] : x.them > x.you ? [`${them} ahead`, "warn"] : x.you > x.them ? [`${you} ahead`, "good"] : ["Even", "neutral"]);
  const st = el("div", { className: "cb-whom", role: "table", "aria-label": "Who cites whom" });
  st.append(el("div", { className: "cb-whom-row cb-th", role: "row" }, ...["Site", "Kind", `Cites ${them}`, `${them} ◂▸ ${you}`, `Cites ${you}`, "Verdict"].map((x, i) => el("span", { role: "columnheader", className: i === 2 || i === 4 ? "num" : i === 3 ? "c" : "" }, x))));
  d.sites.forEach((x) => {
    const [v, tone] = VERDICT(x);
    const own = !!(profile.brand && profile.brand.url && x.site.includes(normDomainLabel(profile.brand.url).replace(/^www\./, "")));
    st.append(el("div", { className: "cb-whom-row", role: "row" },
      el("span", { role: "rowheader" }, el("b", {}, x.site), own ? el("span", { className: "cb-tag you-tag" }, "your site") : null),
      el("span", { role: "cell", className: "muted small" }, atKindOne(x.kind)),
      el("span", { role: "cell", className: "num" }, String(x.them)),
      el("span", { role: "cell", className: "cb-div" }, el("span", { className: "cb-div-l" }, el("span", { className: "cb-mbar vs-them", style: `width:${(x.them / smax) * 100}%` })), el("span", { className: "cb-div-r" }, el("span", { className: "cb-mbar vs-you", style: `width:${(x.you / smax) * 100}%` }))),
      el("span", { role: "cell", className: "num" }, String(x.you)),
      el("span", { role: "cell" }, apPill(v, tone))));
  });
  box.append(cbSection("cb-whom", "Who cites whom", d.gapLine, d.sites.length ? el("div", { className: "cb-scroll" }, st) : el("p", { className: "ap-note" }, "No cited page mentions either brand.")));

  /* --- what the engines read when they named it --- */
  if (r.sourceDomains && r.sourceDomains.length) {
    const list = el("div", { className: "cb-barlist brand-sources", "data-term": "brandSources" });
    r.sourceDomains.forEach((x) => {
      const btn = el("button", { className: "linkbtn td-domain-btn", type: "button", title: `${x.domain}: its pages and the prompts that cited them` }, x.domain);
      btn.onclick = () => openCampaignDomain(profile, x.domain);
      list.append(el("div", { className: "cb-barrow" }, btn, cbBar(x.visibility, "src"), el("span", { className: "num" }, `${cbPct(x.visibility)} · ${x.citations}`)));
    });
    box.append(cbSection("cb-vs-sources", `What the engines read when they named ${them}`, "share of the answers naming it that cited the site · citations", list));
  }

  /* --- prompt by prompt: a verdict per engine, and a score --- */
  const ORD = (n) => (n === "shown" ? "shown" : ORDINAL(n));
  const verdictOf = (c) => {
    if (!c) return null;
    const pos = [c.you ? `${you} ${ORD(c.you)}` : "", c.them ? `${them} ${ORD(c.them)}` : ""].filter(Boolean).join(", ");
    if (c.winner === "neither") return { k: "none", label: "Neither", sub: "not named" };
    if (c.winner === "both") return { k: "both", label: "Both, no order", sub: pos };
    const only = c.winner === "them" ? !c.you : !c.them;
    const who = c.winner === "them" ? them : you;
    return { k: c.winner, label: only ? `Only ${who}` : `${who} ahead`, sub: pos };
  };
  const rows = d.prompts.rows.map((p) => {
    const v = p.cells.map(verdictOf);
    return { p, v, you: v.filter((x) => x && x.k === "you").length, them: v.filter((x) => x && x.k === "them").length, none: v.some((x) => x && x.k === "none") };
  });
  const cells = rows.flatMap((x) => x.v.filter(Boolean));
  const tally = { you: cells.filter((x) => x.k === "you").length, them: cells.filter((x) => x.k === "them").length, both: cells.filter((x) => x.k === "both").length, none: cells.filter((x) => x.k === "none").length };
  const FILTERS = [["all", "All prompts", rows.length], ["them", `Where ${them} beats ${you}`, rows.filter((x) => x.them > 0).length], ["none", "Where neither is named", rows.filter((x) => x.none).length]];
  if (!FILTERS.some((f) => f[0] === cbVsFilter)) cbVsFilter = "all";
  const chips = el("div", { className: "cb-vs-filters", role: "group", "aria-label": "Show prompts" });
  FILTERS.forEach(([id, label, n]) => {
    const c = el("button", { className: `db-chip${cbVsFilter === id ? " on scope" : ""}`, type: "button", "aria-pressed": cbVsFilter === id ? "true" : "false" }, `${label} `, el("b", {}, String(n)));
    c.onclick = () => { cbVsFilter = id; renderCampaigns(); };
    chips.append(c);
  });
  const sbar = el("div", { className: "cb-stack thin", role: "img", "aria-label": `${you} ahead in ${tally.you}, ${them} ahead in ${tally.them}, neither named in ${tally.none}` });
  [["you", tally.you], ["them", tally.them], ["both", tally.both], ["none", tally.none]].forEach(([k, n]) => { if (n) sbar.append(el("span", { className: `vv-${k}`, style: `flex:${n} 1 0` }, String(n))); });
  const sleg = el("div", { className: "cb-stack-legend inline" },
    el("span", {}, el("i", { className: "vv-you" }), el("b", {}, `${you} ahead`), ` in ${tally.you} of ${cells.length} answers`),
    el("span", {}, el("i", { className: "vv-them" }), el("b", {}, `${them} ahead`), ` in ${tally.them}`),
    tally.both ? el("span", {}, el("i", { className: "vv-both" }), el("b", {}, "Both, no order"), ` in ${tally.both}`) : null,
    el("span", {}, el("i", { className: "vv-none" }), el("b", {}, "Neither named"), ` in ${tally.none}`));
  const shown = rows.filter((x) => cbVsFilter === "all" || (cbVsFilter === "them" ? x.them > 0 : x.none));
  const cols = `28px minmax(200px, 1fr) repeat(${d.engines.length}, 112px) 64px`;
  const g = el("div", { className: "cb-grid cb-prompt-grid cb-verdicts", role: "table", style: `grid-template-columns:${cols};min-width:${28 + d.engines.length * 112 + 64 + 220}px`, "aria-label": "Prompt by prompt: who came first" });
  g.append(el("div", { className: "cb-grid-row", role: "row" }, el("span", { role: "columnheader" }, "#"), el("span", { role: "columnheader" }, "Prompt"),
    ...d.engines.map((e) => el("span", { role: "columnheader", className: "c" }, engineIconEl(e.id), ` ${e.label}`)), el("span", { role: "columnheader", className: "num" }, "Score")));
  shown.forEach(({ p, v, you: yw, them: tw }) => g.append(el("div", { className: "cb-grid-row", role: "row" },
    el("span", { role: "cell", className: "muted" }, String(p.n)), el("span", { role: "cell", className: "cb-ptitle", title: p.text }, p.text),
    ...v.map((x, i) => {
      if (!x) return el("span", { role: "cell", className: "c" }, el("span", { className: "cb-pos none" }, "·"));
      const btn = el("button", { className: `cb-win ${x.k}`, type: "button", title: `${d.engines[i].label}: ${x.label}${x.sub ? ` (${x.sub})` : ""} — open the answer` }, el("b", {}, x.label), el("span", {}, x.sub));
      btn.onclick = () => openCapture(p.cells[i].captureId);
      return el("span", { role: "cell", className: "c" }, btn);
    }),
    el("span", { role: "cell", className: "num cb-score" }, el("b", {}, `${yw} – ${tw}`), el("span", { className: "cb-score-dots", "aria-hidden": "true" }, ...v.map((x) => el("i", { className: `vv-${x ? x.k : "na"}` })))))));
  if (!shown.length) g.append(el("div", { className: "cb-grid-row", role: "row" }, el("span", { role: "cell", className: "muted small", style: "grid-column:1/-1" }, "No prompt matches.")));
  const per = d.engines.map((e, i) => { const c = rows.map((x) => x.v[i]).filter(Boolean); return `${c.filter((x) => x.k === "you").length} · ${c.filter((x) => x.k === "them").length}`; });
  g.append(el("div", { className: "cb-grid-row cb-foot", role: "row" }, el("span", { role: "cell" }), el("span", { role: "cell" }, el("b", {}, "Per engine")),
    ...per.map((x) => el("span", { role: "cell", className: "c" }, x)), el("span", { role: "cell", className: "num muted small" }, `${you} · ${them}`)));
  box.append(cbSection("cb-vs-prompts", "Prompt by prompt: who came first", chips, sbar, sleg, el("div", { className: "cb-scroll" }, g)));
}
let cbVsFilter = "all";     // the brand page's prompt filter
const ORDINAL = (n) => { const x = Math.round(n); const s = ["th", "st", "nd", "rd"], v = x % 100; return x + (s[(v - 20) % 10] || s[v] || s[0]); };

/* ---------- Export a campaign (0.52.0) ----------
 * Release 6 of the canvas redesign: one dialog for every way out of a
 * campaign. Left, the choices; right, what you will get, with row counts
 * from the background (positions need the answer text). The file is built
 * in the background as text parts and zipped here.
 */
const EX_TABLES = [
  ["answers", "Answers", "One row per prompt × engine × run", true],
  ["mentions", "Brand mentions", "Position, mentions, what it was picked for", true],
  ["pages", "Pages opened", "Every page read or cited, with its kind of site", false],
  ["searches", "Engine searches", "The searches behind each answer", false],
  ["products", "Product cards and stores", "Cards, prices, ratings and every store listed", false],
  ["images", "Images", "Who supplied each image", false],
  ["h2h", "Head to head", "You against each rival in every answer", false],
];
const EX_SUMMARY = [
  ["Start here", "Contents, definitions, how to use the pickers", null], ["Overview", "Headline numbers, brands, engines, findings", null],
  ["Trends", "Every brand across runs, line charts", "multi"], ["Brands", "Scorecard, engine heatmap, head to head", null],
  ["Prompts", "Every prompt × brand; best rival", null], ["Answer types", "Shopping, informational, images, memory, local", null],
  ["Sources", "Kinds of site, gaps, top 25 pages", "pages"], ["Products", "Card share, stores, images", "productsOrImages"],
  ["Searches", "Searches per engine; every distinct search", "searches"], ["Run over run", "Your position per prompt and engine, run by run", "multi"],
  ["Actions", "Missing prompts, gap sites, store fixes", null],
];
// The PDF report's pages (src/lib/campaignReport.js's REPORT_PAGES).
const EX_PDF_PAGES = [
  ["summary", "Summary", "Headline numbers, visibility by run, findings"],
  ["brands", "Brands", "Scorecard, visibility per engine, head to head, backing"],
  ["prompts", "Prompts", "Position on every prompt and engine; where you are missing"],
  ["sources", "Sources", "Kinds of site, most-cited sites and pages, gaps"],
  ["products", "Kinds of answer and products", "Card share, where cards send buyers, images"],
  ["searches", "Engine searches", "Searches per engine and the most repeated ones"],
  ["method", "Method", "Definitions, runs and the full prompt list"],
];
const EX_RAW = [["Answers", "answers", "tAnswers"], ["Mentions", "mentions", "tMentions"], ["Sources data", "pages", "tSources"], ["Engine searches", "searches", "tSearches"],
  ["Product cards", "products", "tProducts"], ["Store offers", "stores", "tOffers"], ["Images", "images", "tImages"], ["Head to head", "h2h", "tH2H"]];
const EX_CSV = [["answers.csv", "answers", "One row per prompt × engine × run"], ["mentions.csv", "mentions", "One row per tracked brand an answer named"],
  ["pages.csv", "pages", "Every page opened; Cited = 1 when linked"], ["searches.csv", "searches", "Every search an engine ran"], ["products.csv", "products", "One row per product card"],
  ["stores.csv", "stores", "One row per store a card lists"], ["images.csv", "images", "One row per image"], ["head_to_head.csv", "h2h", "One row per answer × rival"]];

function openExportDialog(profile, ctx) {
  document.getElementById("export-modal-backdrop")?.remove();
  const runList = ctx.runList || [];
  const st = {
    format: "xlsx", scope: "all", engines: new Set(ctx.engines.map((e) => e.id)), inc: { pages: true, searches: true, products: true, images: true, h2h: true }, text: "excerpt", counts: null, filename: null, done: false,
    pdfRun: runList[0] ? runList[0].id : null, sec: new Set(EX_PDF_PAGES.map(([k]) => k)),
  };
  const backdrop = el("div", { id: "export-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content modal-wide ex-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "ex-title" });
  const closeBtn = el("button", { className: "modal-close-btn", type: "button", title: "Close", "aria-label": "Close" }, "×");
  const sub = el("div", { className: "muted small" });
  modal.append(el("div", { className: "modal-header" }, el("div", {}, el("h3", { className: "modal-title", id: "ex-title" }, `Export ${profile.name || "campaign"}`), sub), closeBtn));
  const fmtCol = el("section", { className: "ex-col ex-formats", "aria-label": "Format" });
  const left = el("section", { className: "ex-col ex-choices", "aria-label": "Options" });
  const right = el("section", { className: "ex-col ex-get", "aria-label": "What you get" });
  modal.append(el("div", { className: "modal-body ex-body" }, fmtCol, left, right));
  const fileName = el("span", { className: "ex-file" });
  const fileMeta = el("span", { className: "muted small" });
  const done = el("span", { className: "ex-done", role: "status" });
  const cancel = el("button", { className: "btn sm ghost", type: "button" }, "Cancel");
  const go = el("button", { className: "btn sm primary", type: "button", id: "ex-go" });
  modal.append(el("div", { className: "modal-footer ex-footer" }, el("div", { className: "ex-file-box" }, fileName, fileMeta), done, el("div", { className: "ex-actions" }, cancel, go)));
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = wireModalDismiss(backdrop, modal);
  closeBtn.onclick = close;
  cancel.onclick = close;

  const num = (v) => (v || 0).toLocaleString(uiLang());
  const n = (k) => (st.counts ? num(st.counts[k]) : "…");
  const seg = (label, opts, cur, pick) => el("div", { className: "ex-seg", role: "radiogroup", "aria-label": label }, ...opts.map(([id, text]) => {
    const b = el("button", { type: "button", className: `ex-seg-btn${cur === id ? " on" : ""}`, role: "radio", "aria-checked": cur === id ? "true" : "false" }, text);
    b.onclick = () => pick(id);
    return b;
  }));
  const tick = (on, locked) => el("span", { className: `ex-tick${on ? " on" : ""}${locked ? " locked" : ""}`, "aria-hidden": "true" }, on ? "✓" : "");
  const group = (title, ...kids) => el("div", { className: "ex-group" }, el("h4", { className: "ex-h" }, title), ...kids);
  const note = (text) => el("p", { className: "muted small ex-note" }, text);

  async function refreshCounts() {
    st.counts = null;
    render();
    const r = await send({ type: "geo-export", format: "counts", profileId: profile.id, scope: st.scope, engines: [...st.engines] });
    st.counts = r && r.ok ? r.counts : null;
    if (r && r.ok) st.filename = r.filename;
    render();
  }

  function render() {
    const runs = st.counts ? st.counts.runs : ctx.runs;
    sub.textContent = `${ctx.engines.length} engine${ctx.engines.length === 1 ? "" : "s"} · ${ctx.runs} run${ctx.runs === 1 ? "" : "s"} · ${ctx.answers} answer${ctx.answers === 1 ? "" : "s"} in the run shown`;

    // Format.
    fmtCol.textContent = "";
    const fmts = [
      ["xlsx", "XLSX", "Excel workbook", ".xlsx · for analysts", "Charts, breakdowns and every raw row. Pick a run or engine inside the file and every sheet follows.", true],
      ["pdf", "PDF", "PDF report", "A4 pages · to share", "Headline numbers, brands, prompts, sources, products, searches and next steps, for one run.", false],
      ["csv", "CSV", "CSV tables", ".zip · one file per table", "The raw rows for BI tools, Python or R.", false],
    ];
    fmtCol.append(el("h4", { className: "ex-eyebrow" }, "Format"), el("div", { className: "ex-format-list", role: "radiogroup", "aria-label": "Format" }, ...fmts.map(([id, ext, name, subt, text, best]) => {
      const b = el("button", { type: "button", className: `ex-format${st.format === id ? " on" : ""}`, role: "radio", "aria-checked": st.format === id ? "true" : "false", "data-format": id },
        el("span", { className: `ex-ext ex-${id}`, "aria-hidden": "true" }, ext),
        el("span", { className: "ex-format-text" }, el("b", {}, name, best ? el("span", { className: "ex-best" }, "Most complete") : null), el("span", { className: "ex-format-sub" }, subt), el("span", { className: "muted small" }, text)));
      b.onclick = () => { st.format = id; st.done = false; render(); };
      return b;
    })));

    // Options.
    left.textContent = "";
    const pdf = st.format === "pdf";
    if (pdf) {
      // One run per report. A few runs fit as buttons; more go in a list.
      const pick = (id) => { st.pdfRun = id; st.done = false; render(); };
      const label = (x, i) => `Run ${x.no} · ${x.date}${i === 0 ? ` ${tr("(latest)")}` : ""}`;
      const picker = runList.length <= 3
        ? seg("Report on", runList.map((x, i) => [x.id, label(x, i)]), st.pdfRun, pick)
        : (() => {
          const sel = el("select", { className: "filter ex-run-select", "aria-label": "Report on" }, ...runList.map((x, i) => el("option", { value: x.id }, label(x, i))));
          sel.value = st.pdfRun;
          sel.onchange = () => pick(sel.value);
          return sel;
        })();
      const first = runList.length && runList[runList.length - 1].id === st.pdfRun;
      left.append(group("Report on", picker, note(first ? "The first run has nothing to compare with, so changes are left out." : "Each number is compared with the run before it.")));
    } else {
      left.append(group("Runs", seg("Runs", [["all", `All ${ctx.runs} run${ctx.runs === 1 ? "" : "s"}`], ["latest", "Latest run only"]], st.scope, (id) => { st.scope = id; st.done = false; refreshCounts(); }),
        note(st.format === "xlsx"
          ? (st.scope === "all" && runs > 1 ? "Trends and Run over run compare the runs." : "Trends and Run over run need more than one run, so they are left out.")
          : (st.scope === "all" ? "Every run, with a Run column to tell them apart." : `Only the latest run${ctx.latestDate ? `, ${ctx.latestDate}` : ""}.`))));
    }

    const engWrap = el("div", { className: "ex-chips", role: "group", "aria-label": "Engines" });
    ctx.engines.forEach((e) => {
      const on = st.engines.has(e.id);
      const b = el("button", { type: "button", className: `ex-chip${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false", "data-engine": e.id }, tick(on), engineIconEl(e.id), e.label);
      b.onclick = () => { if (on && st.engines.size === 1) return; if (on) st.engines.delete(e.id); else st.engines.add(e.id); st.done = false; refreshCounts(); };
      engWrap.append(b);
    });
    left.append(group("Engines", engWrap,
      note(st.engines.size === ctx.engines.length ? `All ${ctx.engines.length} engine${ctx.engines.length === 1 ? "" : "s"}.` : st.engines.size === 1 ? "At least one engine stays on." : `${st.engines.size} of ${ctx.engines.length} engines.`)));

    if (pdf) {
      const list = el("div", { className: "ex-tables" });
      EX_PDF_PAGES.forEach(([id, name, text]) => {
        const locked = id === "summary";
        const on = locked || st.sec.has(id);
        const b = el("button", { type: "button", className: `ex-table${locked ? " locked" : ""}`, role: "checkbox", "aria-checked": on ? "true" : "false", "aria-disabled": locked ? "true" : "false", "data-page": id },
          tick(on, locked), el("span", { className: "ex-table-text" }, el("b", {}, name), el("span", { className: "muted small" }, text)), el("span", { className: "ex-rows" }, locked ? "always" : on ? "" : "left out"));
        if (!locked) b.onclick = () => { if (on) st.sec.delete(id); else st.sec.add(id); st.done = false; render(); };
        list.append(b);
      });
      left.append(group("Pages in the report", list));
    }
    const tbl = el("div", { className: "ex-tables" });
    if (!pdf) EX_TABLES.forEach(([id, name, text, locked]) => {
      const on = locked || st.inc[id];
      const rows = id === "products" ? (st.counts ? `${n("products")} cards · ${n("stores")} stores` : "…") : `${n(id)} rows`;
      const b = el("button", { type: "button", className: `ex-table${locked ? " locked" : ""}`, role: "checkbox", "aria-checked": on ? "true" : "false", "aria-disabled": locked ? "true" : "false", "data-table": id },
        tick(on, locked), el("span", { className: "ex-table-text" }, el("b", {}, name), el("span", { className: "muted small" }, locked ? `${text} · every summary needs it` : text)),
        el("span", { className: "ex-rows" }, on ? rows : "left out"));
      if (!locked) b.onclick = () => { st.inc[id] = !st.inc[id]; st.done = false; render(); };
      tbl.append(b);
    });
    if (!pdf) {
      left.append(group("Data to include", tbl));
      left.append(group("Answer text", seg("Answer text", [["excerpt", "First 300 characters"], ["full", "Full answer"]], st.text, (id) => { st.text = id; st.done = false; render(); }),
        note(st.text === "full" ? "Full text makes the file larger; Excel shows the first 32,767 characters of a cell." : "Enough to recognise the answer; open it in Analyze for the rest.")));
    }

    // What you get.
    right.textContent = "";
    const multi = st.scope === "all" && runs > 1;
    const incOf = (k) => k === "answers" || k === "mentions" || (k === "stores" ? st.inc.products : st.inc[k]);
    const head = (text) => el("div", { className: "ex-get-head" }, el("h4", { className: "ex-eyebrow" }, "What you get"), el("span", { className: "ex-get-sum" }, text));
    const rowsOf = (keys) => (st.counts ? keys.reduce((a, k) => a + (st.counts[k] || 0), 0) : null);
    if (pdf) {
      const pages = EX_PDF_PAGES.filter(([id]) => id === "summary" || st.sec.has(id));
      const r = runList.find((x) => x.id === st.pdfRun) || runList[0] || { no: 1 };
      right.append(head(`${pages.length} section${pages.length === 1 ? "" : "s"}`),
        el("ol", { className: "ex-pages" }, ...pages.map(([, name, text], i) => el("li", {}, el("span", { className: "ex-page-no", "aria-hidden": "true" }, String(i + 1)), el("b", {}, name), el("span", { className: "ex-li-text" }, text)))),
        note("Each section starts on a new A4 page; a long table carries on over the next one. The report opens in a new tab and your browser’s print dialog saves it: choose “Save as PDF”."));
      fileName.textContent = `${(st.filename && st.filename.xlsx ? st.filename.xlsx.replace(/-\d{4}-\d{2}-\d{2}\.xlsx$/, "") : "citoskeleton")}-run${r.no}.pdf`;
      fileMeta.textContent = `Run ${r.no} · ${pages.length} section${pages.length === 1 ? "" : "s"} · A4`;
    } else if (st.format === "xlsx") {
      const sum = EX_SUMMARY.filter(([, , need]) => need === null || (need === "multi" ? multi : need === "productsOrImages" ? st.inc.products || st.inc.images : st.inc[need]));
      const raw = EX_RAW.filter(([, k]) => incOf(k));
      const total = rowsOf(raw.map(([, k]) => k));
      right.append(head(`${sum.length} summaries · ${raw.length} raw tables`),
        el("div", { className: "ex-list-h" }, "Summary sheets · charts and live formulas"),
        el("ul", { className: "ex-list" }, ...sum.map(([name, text]) => el("li", {}, el("span", { className: "ex-dot sum", "aria-hidden": "true" }), el("b", {}, name), el("span", { className: "ex-li-text" }, text)))),
        el("div", { className: "ex-list-h" }, "Raw tables · filter, sort, pivot"),
        el("ul", { className: "ex-list raw" }, ...raw.map(([name, k, t]) => el("li", {}, el("span", { className: "ex-dot raw", "aria-hidden": "true" }), el("b", {}, name), el("span", { className: "ex-li-text" }, `Excel table ${t}`), el("span", { className: "ex-rows" }, n(k))))),
        note("Every value is already calculated, so the file opens ready in Excel 2010 or later, Google Sheets, Numbers and LibreOffice."));
      fileName.textContent = (st.filename && st.filename.xlsx) || "citoskeleton-….xlsx";
      fileMeta.textContent = `${sum.length + raw.length} sheets${total === null ? "" : ` · ${num(total)} rows`} · opens in Excel, Google Sheets or Numbers`;
    } else {
      const files = EX_CSV.filter(([, k]) => incOf(k));
      const total = rowsOf(files.map(([, k]) => k));
      right.append(head(`${files.length} files`),
        el("ul", { className: "ex-csv" }, ...files.map(([file, k, text]) => el("li", {}, el("b", {}, file),
          el("span", { className: "ex-rows" }, st.counts ? `${n(k)} rows · ${st.counts.cols[k]} columns` : "…"), el("span", { className: "muted small ex-csv-text" }, text)))),
        note("UTF-8 with a header row; 1 = yes and 0 = no in flag columns; dates in ISO format. Answer ID joins every file to answers.csv."));
      fileName.textContent = (st.filename && st.filename.csv) || "citoskeleton-….zip";
      fileMeta.textContent = `${files.length} files and a README${total === null ? "" : ` · ${num(total)} rows`}`;
    }
    done.textContent = !st.done ? "" : pdf ? "✓ Opened in a new tab. Choose “Save as PDF” in the print dialog." : "✓ Exported. Chrome saved it to your Downloads folder.";
    done.hidden = !st.done;
    go.textContent = st.format === "xlsx" ? "Export workbook" : pdf ? "Open PDF report" : "Export CSV files";
    go.disabled = !!(st.counts && st.counts.answers === 0);
  }

  go.onclick = withBusy(go, "Building…", async () => {
    if (st.format === "pdf") {
      const q = new URLSearchParams({ kind: "campaign", profileId: profile.id, runId: st.pdfRun || "", engines: [...st.engines].join(","), sections: [...st.sec].join(","), print: "1" });
      await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/report.html?${q}`) });
      st.done = true;
      render();
      return;
    }
    const x = await send({ type: "geo-export", format: st.format, profileId: profile.id, scope: st.scope, engines: [...st.engines], include: st.inc, text: st.text });
    if (!x || !x.ok) { showToast((x && x.error) || "Couldn't build the export.", "error"); return; }
    const zip = await makeZip(x.files);
    const blob = st.format === "xlsx" ? new Blob([await zip.arrayBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) : zip;
    const a = el("a", { href: URL.createObjectURL(blob), download: x.filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    st.done = true;
    render();
  });
  render();
  refreshCounts();
}

// A domain's drill-down, from the brand detail's source list: the same
// roll-up the sources table opens, over the same filters.
async function openCampaignDomain(profile, domain) {
  const r = await send({ type: "geo-prompt-performance", profileId: profile.id, tags: cbTags, engines: geoEngineFilter, runId: cbRun && cbRun !== "all" ? cbRun : undefined });
  if (!r.ok) { showToast(r.error || "Couldn't load that domain", "error"); return; }
  const { domains } = aggregateSources(r.prompts || {}, new Map((GEO_PROMPTS || []).map((p) => [p.id, p.text])));
  const row = domains.get(domain);
  if (!row) { showToast(`No captured sources from ${domain} under the current filters.`, "error"); return; }
  openDomainDetailModal(row, `Source breakdown · ${profile.name || "Untitled campaign"}`, "prompt");
}

function renderTrashedCampaigns() {
  const box = el("div", { className: "card" });
  box.append(el("div", { className: "card-header" }, el("h3", {}, `🗑 Recently deleted (${TRASHED_PROFILES.length})`)));
  const list = el("div", { className: "itemlist" });
  TRASHED_PROFILES.forEach((p) => {
    const daysLeft = Math.max(0, Math.ceil((p.deletedAt + TRASH_RETENTION_DAYS * 86400000 - Date.now()) / 86400000));
    const row = el("div", { className: "item" });
    const head = el("div", { className: "item-head" });
    head.append(el("span", { className: "item-name" }, p.name || "Untitled"));
    const restoreBtn = el("button", { className: "linkbtn" }, "↩ restore");
    restoreBtn.onclick = async () => {
      const r = await send({ type: "geo-profile-restore", id: p.id });
      if (r.ok) { geoActiveId = p.id; loadGeo(); } else showToast(r.error, "error");
    };
    const purgeBtn = el("button", { className: "linkbtn danger" }, "delete forever");
    purgeBtn.onclick = async () => {
      if (!confirm(`Permanently delete "${p.name || "this campaign"}"?\n\nThis cannot be undone — its prompts go with it (captured responses are kept).`)) return;
      const r = await send({ type: "geo-profile-delete", id: p.id });
      if (r.ok) loadGeo(); else showToast(r.error, "error");
    };
    head.append(restoreBtn, purgeBtn);
    row.append(head);
    row.append(el("div", { className: "muted item-sub" },
      daysLeft > 0 ? `Auto-deletes in ${daysLeft} day${daysLeft === 1 ? "" : "s"} unless restored.` : "Auto-deleting soon unless restored."));
    list.append(row);
  });
  box.append(list);
  return box;
}

function renderCampaignEmptyState() {
  const box = el("div", { className: "card onboard-card" });
  box.append(el("div", { className: "card-header" }, el("h3", {}, "Start your first campaign")));
  box.append(el("p", { className: "muted" },
    "A campaign tracks how your brand and competitors show up across LLM answers, for a fixed set of prompts. Set it up once, then lock it in so every run stays comparable."));
  const steps = el("ol", { className: "onboard-steps" });
  [
    "Name the campaign and add your brand and website",
    "Pick which AI engines to track",
    "Upload a CSV/Excel of prompts, or type them in",
    "Add competitors (optional), then press Save & start tracking",
  ].forEach((s) => steps.append(el("li", {}, s)));
  box.append(steps);
  const cta = el("button", { className: "btn primary" }, "+ Create your first campaign");
  cta.onclick = async () => {
    const r = await send({ type: "geo-profile-save", profile: makeProfile({ name: "My first campaign" }) });
    if (r.ok) { geoActiveId = r.profile.id; loadGeo(); } else showToast(r.error, "error");
  };
  // Someone sent you a campaign (0.82.0): open it without making one first.
  const imp = el("button", { className: "btn ghost", type: "button", id: "cpImportFirst" }, "Import a shared campaign…");
  imp.onclick = () => openImportDialog();
  box.append(el("div", { className: "ft-actions" }, cta, imp));
  return box;
}

function renderOnboardingBanner() {
  const box = el("div", { className: "warn-box onboard-banner" });
  box.append(el("div", {},
    el("b", {}, "Setting up a campaign — "),
    "fill in the five required items listed at the top, add competitors if you like, then press Save & start tracking. That locks the setup so your results stay comparable run over run."));
  const dismiss = el("button", { className: "linkbtn" }, "Got it, don't show this again");
  dismiss.onclick = () => {
    campaignOnboardDismissed = true;
    chrome.storage.local.set({ [ONBOARD_KEY]: true });
    renderCampaigns();
  };
  box.append(dismiss);
  return box;
}

// Soft-delete: recoverable from "Recently deleted" for TRASH_RETENTION_DAYS.
function trashCampaign(profile) {
  return async () => {
    if (!confirm(`Delete "${profile.name || "this campaign"}"?\n\nIt moves to Recently deleted and can be restored for ${TRASH_RETENTION_DAYS} days, after which it's purged automatically.`)) return;
    const r = await send({ type: "geo-profile-trash", id: profile.id });
    if (r.ok) { geoActiveId = null; loadGeo(); } else showToast(r.error, "error");
  };
}

/* The five things a campaign can't be tracked without, in the order the
   setup screen asks for them. Competitors are recommended, never required:
   a campaign with none still measures the brand on its own. */
const SETUP_REQUIRED = [
  { key: "name", label: "Campaign name" },
  { key: "brand", label: "Brand name" },
  { key: "site", label: "Website" },
  { key: "engine", label: "AI engine" },
  { key: "prompt", label: "Prompt" },
];

// Line icons for the setup screen, drawn in currentColor so they follow the
// button or chip they sit in, in both themes.
const SETUP_ICON = {
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  todo: '<circle cx="12" cy="12" r="8"/>',
  upload: '<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="M9 14h6"/><path d="M9 17h4"/>',
};
const setupIcon = (name, size = 16, weight = 2) => el("span", {
  className: "cs-icon", "aria-hidden": "true",
  innerHTML: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round">${SETUP_ICON[name]}</svg>`,
});


function setupCardHead(id, title, help, { pill, count } = {}) {
  const titleRow = el("div", { className: "cs-title-row" }, el("h3", { id, className: "cs-h" }, title));
  if (pill) titleRow.append(pill);
  const text = el("div", { className: "cs-head-text" }, titleRow);
  if (help) text.append(el("p", { className: "cs-help" }, help));
  const head = el("div", { className: "cs-card-head" }, text);
  if (count) head.append(count);
  return head;
}

function setupPill(key) {
  const pill = el("span", { className: "cs-pill" }, "Required");
  pill.dataset.pill = key;
  return pill;
}

function setupField({ id, label, value, placeholder, req, msg, disabled, optional }) {
  const input = el("input", { type: "text", id, className: "cs-input", value: value || "", placeholder: placeholder || "", disabled: !!disabled, spellcheck: false });
  const labelEl = el("label", { htmlFor: id, className: "cs-label" }, label);
  if (optional) labelEl.append(el("span", { className: "cs-optional" }, " (optional)"));
  const row = el("div", { className: "cs-label-row" }, labelEl);
  if (req && !disabled) row.append(setupPill(req));
  const wrap = el("div", { className: "cs-field" }, row, input);
  let msgEl = null;
  if (msg) {
    msgEl = el("p", { className: "cs-msg", id: `${id}-msg`, hidden: true }, msg);
    wrap.append(msgEl);
  }
  return { wrap, input, msgEl };
}

/** Campaign setup: a bar with the save actions and what's still required,
 *  then three cards — details (name, brand, AI engines), prompts, and
 *  competitors. Used for the unlocked setup and, read-only (dis=true), for a
 *  locked campaign's "Manage" view.
 *
 *  The actions used to sit under the whole prompt table, and nothing said
 *  which fields a campaign needs before it can be tracked; each competitor
 *  was a full-width row, so every one added pushed the engine picker further
 *  down. Now the bar is pinned at the top, lists the five required items,
 *  and turns each missing one red — in the bar and on the box itself — when
 *  Save & start tracking is pressed with gaps. Competitors are compact chips
 *  in their own card, after the required things. */
function renderCampaignSetup(profile, dis) {
  // A locked campaign is edited in place (0.77.0): every change saves at
  // once and goes in its change log; only the brand and website ask first.
  const locked = !!profile.locked && !dis;
  let brandOpen = false;
  const draft = !dis && setupDraft && setupDraft.id === profile.id ? setupDraft : null;
  const start = draft ? { ...profile, ...draft } : profile;
  const root = el("section", { className: `cs${dis ? " cs-readonly" : ""}`, "aria-label": dis ? "Campaign setup" : "Set up your campaign" });

  // Everything typed here lives only in these inputs until it's saved, so
  // every action reads the form through collectFormValues() rather than the
  // `profile` argument — a snapshot from the last render that goes stale the
  // moment someone types. Locking against that snapshot once dropped
  // just-typed details. Reassigned below, once the inputs exist.
  let collectFormValues = () => profile;
  let refresh = () => [];
  const persistDetails = async () => {
    const r = await send({ type: "geo-profile-save", profile: { ...profile, ...collectFormValues() } });
    if (r.ok) setupDraft = null;
    return r;
  };
  // Every prompt add, filter click and search keystroke in this tab rebuilds
  // it from the database, which used to wipe whatever was typed here but not
  // saved yet. The draft carries it across those re-renders.
  let saveTimer = null;
  let savedNote = null;
  const autoSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const v = collectFormValues();
      if (!v.name || !v.engines.length || !v.brand.name || !v.brand.url) { if (savedNote) savedNote.textContent = "Not saved: a name, the brand, its website and one engine are needed."; return; }
      if (savedNote) savedNote.textContent = "Saving…";
      const r = await send({ type: "geo-profile-save", profile: { ...profile, ...v, locked: true }, unlockOverride: brandOpen });
      if (!r || !r.ok) { if (savedNote) savedNote.textContent = (r && r.error) || "Couldn't save."; return; }
      setupDraft = null;
      const i = GEO_PROFILES.findIndex((x) => x.id === profile.id);
      if (i !== -1) GEO_PROFILES[i] = r.profile;
      Object.assign(profile, r.profile);
      if (savedNote) savedNote.textContent = "Saved";
      cbNeedsReload = true;
    }, 500);
  };
  const changed = () => {
    if (!dis) setupDraft = { id: profile.id, ...collectFormValues(true) };
    refresh();
    if (locked) autoSave();
  };

  /* ---- the bar ---- */
  const bar = el("div", { className: "cs-bar" });
  const titleText = el("h2", { className: "cs-bar-name" });
  savedNote = locked ? el("span", { className: "cs-saved", role: "status", id: "csSaved" }, "Changes save as you make them") : null;
  bar.append(el("div", { className: "cs-bar-title" }, titleText,
    el("p", { className: "cs-bar-sub", "data-tip": locked ? "Each change is listed on the campaign's board, so you can see which runs were measured before it. The brand and its website ask first, because they change every number." : "Locking keeps every run measured the same way. You can still edit prompts, tags, competitors and engines afterwards." }, dis
      ? "Locked, so every run is measured the same way."
      : locked ? "Edit anything below; it's saved and logged." : "Save & start tracking locks it, so every run is measured the same way."),
    savedNote || ""));

  const reqButtons = {};
  const segs = el("div", { className: "cs-segs", "aria-hidden": "true" });
  const progText = el("span", { className: "cs-progress-text" });
  const checkText = el("span", { className: "cs-progress-text" });
  const nextBtn = el("button", { type: "button", className: "linkbtn cs-next" });
  let saveBtn = null;
  let draftBtn = null;
  let saveLabel = null;
  if (locked) {
    // Nothing to press: changes are saved as they're made.
  } else if (!dis) {
    const delBtn = el("button", { type: "button", className: "cs-delete", "aria-label": "Delete campaign", title: "Delete campaign" },
      setupIcon("trash"), el("span", { className: "cs-delete-label" }, "Delete"));
    delBtn.onclick = trashCampaign(profile);
    draftBtn = el("button", { type: "button", className: "btn ghost cs-draft" }, "Save draft");
    saveLabel = el("span", {}, "Save & start tracking");
    saveBtn = el("button", { type: "button", className: "btn primary cs-save" }, setupIcon("lock", 15, 2.2), saveLabel);
    bar.append(delBtn, el("div", { className: "cs-actions" }, draftBtn, saveBtn));

    const reqList = el("ul", { className: "cs-req-list" });
    SETUP_REQUIRED.forEach((r) => {
      const b = el("button", { type: "button", className: "cs-req" }, el("span", { className: "cs-req-icon" }), el("span", {}, r.label));
      b.dataset.req = r.key;
      b.onclick = () => goTo(r.key);
      reqButtons[r.key] = b;
      reqList.append(el("li", {}, b));
      segs.append(el("span", { className: "cs-seg" }));
    });
    bar.append(
      el("div", { className: "cs-checklist" }, el("span", { className: "cs-checklist-label" }, "Required to start tracking"), reqList, checkText),
      el("div", { className: "cs-progress" }, progText, segs, nextBtn));
  } else {
    const unlockBtn = el("button", { type: "button", className: "btn ghost cs-unlock" }, setupIcon("unlock", 15), el("span", {}, "Unlock to edit"));
    unlockBtn.onclick = async () => {
      if (!confirm("Unlock and allow edits?\n\nChanging the brand set, prompts or LLMs changes what the metrics are measured against — numbers before and after this point are NOT directly comparable.")) return;
      const r = await send({ type: "geo-profile-save", profile: { ...profile, locked: false }, unlockOverride: true });
      if (r.ok) loadGeo(); else showToast(r.error, "error");
    };
    bar.append(el("div", { className: "cs-actions" }, unlockBtn));
  }
  root.append(bar);

  const body = el("div", { className: "cs-body" });
  const errors = el("div", { className: "cs-errors", role: "alert", hidden: true });
  const grid = el("div", { className: "cs-grid" });
  body.append(errors, grid);
  root.append(body);

  /* ---- campaign details ---- */
  const details = el("section", { className: "card cs-card cs-card-details", "aria-labelledby": "cs-details-h" });
  details.append(setupCardHead("cs-details-h", "Campaign details", null));
  const nameF = setupField({ id: "cs-name", label: "Campaign name", value: start.name, placeholder: "e.g. Running shoes — Q4", req: "name", msg: "Give the campaign a name so you can find it later.", disabled: dis });
  const brandF = setupField({ id: "cs-brand", label: "Brand name", value: start.brand?.name, placeholder: "e.g. Northwind", req: "brand", msg: "Add your brand name.", disabled: dis || locked });
  const siteF = setupField({ id: "cs-site", label: "Website", value: start.brand?.url, placeholder: "e.g. northwind.com", req: "site", msg: "Add your website, e.g. northwind.com.", disabled: dis || locked });
  const brandBlock = el("div", { className: "cs-block" },
    el("div", { className: "cs-block-head" },
      el("span", { className: "cs-label cs-label-lg", "data-tip": "Answers are scanned for this name, and cited pages are matched to this website." }, "Your brand")),
    el("div", { className: "cs-pair" }, brandF.wrap, siteF.wrap));
  if (locked) {
    const change = el("button", { type: "button", className: "linkbtn cs-brand-change", id: "csBrandChange" }, "Change brand or website…");
    change.onclick = () => {
      if (!confirm("Change the brand or its website?\n\nEvery number is measured against them, so runs before and after this change are not directly comparable. The change is listed on the board.")) return;
      brandOpen = true;
      brandF.input.disabled = false;
      siteF.input.disabled = false;
      change.remove();
      brandF.input.focus();
    };
    brandBlock.append(change);
  }
  details.append(nameF.wrap, brandBlock);

  const engCount = el("span", {});
  const engMsg = el("p", { className: "cs-msg", id: "cs-engines-msg", hidden: true }, "Pick at least one AI engine to track.");
  const engLabelRow = el("div", { className: "cs-label-row" }, el("span", { className: "cs-label cs-label-lg", id: "cs-eng-label" }, "AI engines to track"));
  if (!dis) engLabelRow.append(setupPill("engine"));
  engLabelRow.firstChild.dataset.tip = "Every prompt is sent to each engine you pick.";
  engLabelRow.append(el("span", { className: "cs-count-inline" }, engCount));
  const engGroup = el("div", { className: "cs-group", id: "cs-engines", role: "group", "aria-labelledby": "cs-eng-label" },
    el("div", { className: "cs-block-head" }, engLabelRow));
  const engGrid = el("div", { className: "cs-engine-grid" });
  const startEngines = new Set(start.engines || []);
  ENGINES.forEach((e) => {
    const off = dis || !e.available;
    const tile = el("button", {
      type: "button", className: "cs-engine", disabled: off,
      "aria-pressed": String(e.available && startEngines.has(e.id)),
    });
    tile.dataset.value = e.id;
    tile.append(
      el("span", { className: "cs-engine-mark" }, engineIconEl(e.id)),
      el("span", { className: "cs-engine-text" },
        el("span", { className: "cs-engine-name" }, e.label),
        el("span", { className: "cs-engine-host" }, e.available ? e.host : (e.note || "coming soon"))),
      el("span", { className: "cs-engine-check" }, setupIcon("check", 12, 3.2)));
    if (!off) {
      tile.onclick = () => {
        tile.setAttribute("aria-pressed", String(tile.getAttribute("aria-pressed") !== "true"));
        changed();
      };
    }
    engGrid.append(tile);
  });
  engGroup.append(engGrid, engMsg);
  details.append(engGroup);

  // What the board leads with (0.55.0, the canvas's setup). Optional: every
  // answer is captured in full whatever is picked. A new campaign starts on
  // brand mentions and citations; one from before the choice shows every
  // view, so its board doesn't change under it.
  const startMeasure = start.measure || (profile.locked ? { citations: true, products: true, images: true, local: true } : { citations: true });
  const msGroup = el("div", { className: "cs-group", id: "cs-measure", role: "group", "aria-labelledby": "cs-ms-label" },
    el("div", { className: "cs-block-head" },
      el("div", { className: "cs-label-row" }, el("span", { className: "cs-label cs-label-lg", id: "cs-ms-label", "data-tip": "Sets the headline numbers on the campaign’s board. Every answer is still captured in full, and you can switch later." }, "What this campaign should measure"), el("span", { className: "cs-pill" }, "Optional"))));
  const msGrid = el("div", { className: "cs-measure-grid" });
  CB_FOCUS.forEach(([id, , glyph]) => {
    const fixed = id === "mentions";
    const on = fixed || !!startMeasure[id];
    const [label, sub] = CS_MEASURE[id];
    const tag = el("span", { className: "cs-measure-tag" }, fixed ? "Always on" : on ? "On" : "Off");
    const b = el("button", { type: "button", className: "cs-measure", disabled: dis || fixed, "aria-pressed": String(on), "data-tip": sub },
      el("span", { className: "cs-measure-icon" }, glyphEl(glyph, 18)),
      el("span", { className: "cs-measure-text" }, el("span", { className: "cs-measure-name" }, label), el("span", { className: "cs-measure-sub" }, sub)), tag);
    b.dataset.value = id;
    if (!dis && !fixed) b.onclick = () => { const v = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(v)); tag.textContent = tr(v ? "On" : "Off"); changed(); };
    msGrid.append(b);
  });
  msGroup.append(msGrid);
  details.append(msGroup);

  /* ---- prompts ---- */
  const promptsCard = el("section", { className: "card cs-card cs-card-prompts", "aria-labelledby": "cs-prompts-h" });
  promptsCard.append(renderPromptManager(profile, dis, persistDetails));

  /* ---- competitors ---- */
  let comps = (start.competitors || []).map((c) => ({ name: c.name, url: c.url || "" }));
  const compCount = el("span", { className: "cs-count" });
  const compsCard = el("div", { className: "cs-block cs-card-comps", role: "group", "aria-labelledby": "cs-comps-h" });
  const compHead = el("div", { className: "cs-block-head" }, el("div", { className: "cs-label-row" },
    el("span", { className: "cs-label cs-label-lg", id: "cs-comps-h", "data-tip": "Compared with your brand in every answer. Optional; add as many as you like." }, "Competitors"),
    dis ? "" : el("span", { className: "cs-pill cs-pill-soft" }, "Recommended"), compCount));
  compsCard.append(compHead);
  const compList = el("ul", { className: "cs-comp-list", "aria-label": "Competitors" });
  const compEmpty = el("p", { className: "cs-empty-line" }, dis ? "No competitors added." : "No competitors yet. Your brand is still tracked without them.");
  let compNameF = null;
  const drawComps = () => {
    compList.textContent = "";
    comps.forEach((c, i) => {
      const chip = el("li", { className: "cs-comp-chip" }, el("span", { className: "cs-comp-name" }, c.name));
      if (c.url) chip.append(el("span", { className: "cs-comp-site" }, c.url));
      if (!dis) {
        const rm = el("button", { type: "button", className: "cs-comp-remove", "aria-label": fmt("Remove {brand}", { brand: c.name }), title: fmt("Remove {brand}", { brand: c.name }) }, setupIcon("x", 13, 2.6));
        rm.onclick = () => {
          comps = comps.filter((_, j) => j !== i);
          drawComps();
          changed();
          compNameF.input.focus();
        };
        chip.append(rm);
      }
      compList.append(chip);
    });
    compList.hidden = !comps.length;
    compEmpty.hidden = !!comps.length;
    compCount.textContent = tr(`${comps.length} added`);
    compCount.hidden = !comps.length;
  };
  if (!dis) {
    compNameF = setupField({ id: "cs-comp-name", label: "Name", placeholder: "e.g. Contoso" });
    const compSiteF = setupField({ id: "cs-comp-site", label: "Website", optional: true, placeholder: "e.g. contoso.com" });
    const addBtn = el("button", { type: "button", className: "btn ghost cs-comp-add", disabled: true }, setupIcon("plus", 14, 2.4), el("span", {}, "Add competitor"));
    const compHint = el("p", { className: "cs-hint", role: "status", hidden: true });
    const addComp = () => {
      const name = compNameF.input.value.trim();
      if (!name) return;
      const key = name.toLowerCase();
      let why = "";
      if (comps.some((c) => c.name.toLowerCase() === key)) why = `${name} is already in the list.`;
      else if (key === brandF.input.value.trim().toLowerCase()) why = "That's your own brand — it's tracked already.";
      if (why) { compHint.textContent = why; compHint.hidden = false; return; }
      comps = comps.concat([{ name, url: compSiteF.input.value.trim() }]);
      compNameF.input.value = "";
      compSiteF.input.value = "";
      addBtn.disabled = true;
      compHint.hidden = true;
      drawComps();
      changed();
      compNameF.input.focus();
    };
    addBtn.onclick = addComp;
    const onKey = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addComp(); } };
    compNameF.input.onkeydown = onKey;
    compSiteF.input.onkeydown = onKey;
    compNameF.input.oninput = () => { addBtn.disabled = !compNameF.input.value.trim(); compHint.hidden = true; };
    compsCard.append(el("div", { className: "cs-comp-form" }, compNameF.wrap, compSiteF.wrap, addBtn), compHint);
  }
  compsCard.append(compList, compEmpty);
  drawComps();

  // Competitors sit right after the brand (0.77.0: "the competition adding
  // option is so down that people may miss it"), then engines and measures.
  brandBlock.after(compsCard);
  grid.append(details, promptsCard);

  /* ---- reading and checking the form ---- */
  collectFormValues = (raw = false) => ({
    name: raw ? nameF.input.value : (nameF.input.value.trim() || profile.name),
    brand: { name: brandF.input.value.trim(), url: siteF.input.value.trim() },
    competitors: comps.map((c) => ({ ...c })),
    engines: [...engGrid.querySelectorAll('.cs-engine[aria-pressed="true"]')].map((t) => t.dataset.value),
    measure: Object.fromEntries(["citations", "products", "images", "local"].map((k) => [k, msGrid.querySelector(`.cs-measure[data-value="${k}"]`)?.getAttribute("aria-pressed") === "true"])),
  });
  [nameF, brandF, siteF].forEach((f) => { f.input.oninput = changed; });

  const fields = { name: nameF, brand: brandF, site: siteF };
  const goTo = (key) => {
    const box = key === "engine" ? engGroup : key === "prompt" ? root.querySelector("#cs-prompts") : fields[key]?.input;
    const target = key === "engine" ? engGrid.querySelector(".cs-engine:not(:disabled)")
      : key === "prompt" ? root.querySelector(".cs-mode") : fields[key]?.input;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (box) box.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    if (target) target.focus({ preventScroll: true });
  };
  const markField = (f, bad) => {
    f.wrap.classList.toggle("is-invalid", bad);
    if (bad) { f.input.setAttribute("aria-invalid", "true"); f.input.setAttribute("aria-describedby", f.msgEl.id); }
    else { f.input.removeAttribute("aria-invalid"); f.input.removeAttribute("aria-describedby"); }
    f.msgEl.hidden = !bad;
  };
  const markGroup = (group, bad) => {
    if (!group) return;
    group.classList.toggle("is-invalid", bad);
    const msg = group.querySelector(":scope > .cs-msg");
    if (msg) msg.hidden = !bad;
  };
  let shownErrors = "";
  refresh = () => {
    const v = collectFormValues(true);
    const ok = {
      name: !!v.name.trim(),
      brand: !!v.brand.name,
      site: !!v.brand.url,
      engine: v.engines.length > 0,
      prompt: GEO_PROMPTS.some((p) => p.active !== false),
    };
    const missing = SETUP_REQUIRED.filter((r) => !ok[r.key]);
    titleText.textContent = v.name.trim() || "New campaign";
    engCount.textContent = tr(`${v.engines.length} of ${ENGINES.length} selected.`);
    if (dis || locked) return missing;

    const attempted = setupAttemptedFor === profile.id;
    SETUP_REQUIRED.forEach((r, i) => {
      const state = ok[r.key] ? "done" : attempted ? "bad" : "todo";
      const b = reqButtons[r.key];
      b.dataset.state = state;
      b.setAttribute("aria-label", `${tr(r.label)}: ${tr(state === "done" ? "done" : "still needed")}`);
      b.querySelector(".cs-req-icon").replaceChildren(setupIcon(state === "done" ? "check" : state === "bad" ? "alert" : "todo", 13, state === "done" ? 3 : 2.2));
      segs.children[i].dataset.state = state;
      root.querySelectorAll(`.cs-pill[data-pill="${r.key}"]`).forEach((p) => p.classList.toggle("is-bad", state === "bad"));
    });
    Object.entries(fields).forEach(([key, f]) => markField(f, attempted && !ok[key]));
    markGroup(engGroup, attempted && !ok.engine);
    markGroup(root.querySelector("#cs-prompts"), attempted && !ok.prompt);

    const n = SETUP_REQUIRED.length;
    const text = !missing.length ? `All ${n} required items done`
      : attempted ? `${missing.length} required item${missing.length === 1 ? "" : "s"} missing`
      : `${n - missing.length} of ${n} required items done`;
    // Set after the page was drawn, so not through el(): tr() here (0.84.2).
    progText.textContent = tr(text);
    checkText.textContent = tr(text);
    bar.dataset.state = !missing.length ? "ready" : attempted ? "bad" : "todo";
    nextBtn.hidden = !missing.length;
    if (missing.length) {
      nextBtn.textContent = `Next: ${missing[0].label}`;
      nextBtn.onclick = () => goTo(missing[0].key);
    }

    // Rebuilt only when what's missing changes: it's a live region, and
    // redrawing it on every keystroke would re-announce it each time.
    const errKey = attempted ? missing.map((m) => m.key).join() : "";
    if (errKey !== shownErrors) {
      shownErrors = errKey;
      errors.textContent = "";
      errors.hidden = !errKey;
      if (errKey) {
        const links = el("div", { className: "cs-errors-links" });
        missing.forEach((m) => {
          const b = el("button", { type: "button", className: "linkbtn" }, m.label);
          b.onclick = () => goTo(m.key);
          links.append(b);
        });
        errors.append(setupIcon("alert", 18), el("div", { className: "cs-errors-text" },
          el("p", { className: "cs-errors-title" }, `Add ${missing.length === 1 ? "1 more thing" : `${missing.length} more things`} before you start tracking:`),
          links));
      }
    }
    return missing;
  };

  if (!dis && !locked) {
    saveBtn.onclick = async () => {
      if (saveBtn.disabled) return;
      setupAttemptedFor = profile.id;
      const missing = refresh();
      if (missing.length) { goTo(missing[0].key); return; }
      saveBtn.disabled = true;
      draftBtn.disabled = true;
      saveLabel.textContent = "Saving…";
      try {
        const r = await send({ type: "geo-profile-save", profile: { ...profile, ...collectFormValues(), locked: true }, unlockOverride: true });
        if (r.ok) {
          setupAttemptedFor = null;
          setupDraft = null;
          showToast("Campaign saved and locked. Start a run whenever you're ready.");
          loadGeo();
        } else showToast(r.error, "error");
      } finally {
        saveBtn.disabled = false;
        draftBtn.disabled = false;
        saveLabel.textContent = "Save & start tracking";
      }
    };
    draftBtn.onclick = async () => {
      if (draftBtn.disabled) return;
      draftBtn.disabled = true;
      draftBtn.textContent = "Saving…";
      try {
        const r = await persistDetails();
        if (r.ok) { showToast("Draft saved. Nothing is locked yet."); loadGeo(); } else showToast(r.error, "error");
      } finally {
        draftBtn.disabled = false;
        draftBtn.textContent = "Save draft";
      }
    };
  }
  refresh();
  return root;
}

/* Real brand marks, as inline SVG, instead of the stand-in emoji this used to
   use (chatgpt was "💬" — a generic speech balloon that looks nothing like
   OpenAI's logo, which is what made the engine list read as wrong).
   Inline rather than image files so they stay crisp at any size, need no
   extra web_accessible_resources, and cost no extra requests.

   OpenAI's and xAI's marks are monochrome by design, so they use
   currentColor and follow the surrounding text in both light and dark
   themes. Gemini and Perplexity are drawn in their own brand
   colours, which hold up against both themes' backgrounds.

   These identify which engine a row or pill refers to — the marks are used
   nominatively, to name the service, not to imply any endorsement. */
const ENGINE_ICON_SVG = {
  chatgpt: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>`,
  // __UID__ is replaced with a per-instance id by engineIconEl(). An SVG
  // gradient is referenced by document-wide id, so a fixed one would be
  // duplicated by every copy of this icon — see the note there.
  gemini: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><defs><linearGradient id="__UID__" x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1C7DFF"/><stop offset=".52" stop-color="#8E6FF7"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs><path fill="url(#__UID__)" d="M12 24A14.304 14.304 0 0 0 0 12A14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12a14.305 14.305 0 0 0-12 12"/></svg>`,
  // Was a hand-drawn hourglass/compass shape that doesn't read as Perplexity
  // to anyone who knows the product — the other four marks here are each the
  // real logo, so this was the odd one out. Replaced with the actual mark,
  // exact path from simple-icons (simple-icons/simple-icons, CC0), the same
  // source most open-source projects pull verified brand SVGs from. Fill is
  // Perplexity's own published brand teal (#20808D, "True Turquoise"), which
  // the old placeholder's stroke color already had right — only the shape
  // was wrong.
  perplexity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="#20808D" aria-hidden="true"><path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/></svg>`,
  // Was the "bowtie" shape (two crossed strokes), which is not Grok's mark at
  // all — no version of it has looked like that. Replaced with the actual
  // current app icon (the twisted-loop mark used on grok.com, X, and the iOS
  // app today), sourced from lobehub/lobe-icons — simple-icons has no Grok
  // entry yet (open feature request, simple-icons/simple-icons#13853) at time
  // of writing. currentColor, like chatgpt above: this mark is genuinely
  // monochrome in Grok's own branding (no distinct brand color the way
  // Perplexity has), so it should track theme/text color rather than
  // carry a fixed hex that could go invisible in dark mode.
  grok: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>`,
};

// Builds a fresh element each call — the same node can't be appended in two
// places, and these get rendered once per pill and once per table column.
//
// Reported: "Gemini logo is missing" — in a modal, while the same icon
// rendered fine on the page behind it. Gemini's mark is the only one that
// paints with a gradient, and `fill="url(#id)"` resolves against the WHOLE
// document: every copy of the icon emitted `id="ck-gem"`, so all of them
// pointed at whichever one happened to be first in the DOM. Re-rendering a
// section (every filter change does) destroys that node, and every surviving
// copy — including one in an open modal, which lives on document.body and is
// not re-rendered — is left referencing a gradient that no longer exists.
// The path then paints with no fill: an invisible icon in a space that still
// takes up room, which is exactly what the screenshot showed.
//
// Each instance now owns its gradient, so no icon can depend on another one's
// lifetime.
let iconUid = 0;
function engineIconEl(id) {
  const svg = ENGINE_ICON_SVG[id];
  if (!svg) return el("span", { className: "llm-icon" }, "🔷");
  return el("span", {
    className: "llm-icon",
    innerHTML: svg.replaceAll("__UID__", `ck-icon-${id}-${++iconUid}`),
  });
}

// icon + label as one inline unit, for the Prompt Performance card/table
// layouts (engine badge next to which run's row this is).
function engineChip(id, label) {
  const icon = engineIconEl(id);
  icon.classList.add("engine-chip-icon");
  return el("span", { className: "engine-chip" }, icon, " " + label);
}

// After a bulk add, tell the user what got skipped as a duplicate (and why)
// rather than silently dropping it — only speaks up when there's something
// to report.
function reportAddResult(r) {
  if (!r.duplicates || !r.duplicates.length) return;
  const preview = r.duplicates.slice(0, 5).map((t) => `• ${t}`).join("\n");
  const more = r.duplicates.length > 5 ? `\n…and ${r.duplicates.length - 5} more` : "";
  showToast(
    `Added ${r.added} prompt${r.added === 1 ? "" : "s"}. Skipped ${r.duplicates.length} duplicate${r.duplicates.length === 1 ? "" : "s"} already in this campaign:\n${preview}${more}`,
    "info",
    8000
  );
}

/** The prompts card: two ways in (upload a file, or type them), then the
 *  prompts table — search, tag-filter sidebar (with per-tag rename/delete),
 *  "only unassigned" toggle, inline tag editing, and bulk select for
 *  pause/remove. Upload used to be a small button with manual entry hidden
 *  behind an "or type prompts manually" link; they're now two equal choices. */
function renderPromptManager(profile, dis, persistDetails) {
  const wrap = el("div", { className: "prompt-manager" });
  const activeCount = GEO_PROMPTS.filter((p) => p.active !== false).length;
  wrap.append(setupCardHead("cs-prompts-h", "Prompts",
    dis ? null : "The questions people ask AI engines. Add at least one.", {
      pill: dis ? null : setupPill("prompt"),
      count: el("span", { className: "cs-count" }, activeCount === GEO_PROMPTS.length
        ? `${GEO_PROMPTS.length} prompt${GEO_PROMPTS.length === 1 ? "" : "s"}`
        : `${activeCount} active of ${GEO_PROMPTS.length}`),
    }));

  if (!dis) {
    // Adding prompts re-fetches and re-renders the whole tab, so whatever is
    // still unsaved in the campaign details is saved first rather than lost.
    const addRows = async (rows, verb) => {
      const detailsSave = await persistDetails();
      if (!detailsSave.ok) { showToast(`Couldn't save campaign details: ${detailsSave.error}`, "error"); return false; }
      const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: profile.id, rows });
      if (!r.ok) { showToast(r.error, "error"); return false; }
      const dup = (r.duplicates || []).length;
      promptAddNote = {
        id: profile.id,
        text: `${verb} ${r.added} prompt${r.added === 1 ? "" : "s"}${dup ? ` · skipped ${dup} already in this campaign` : ""}`,
      };
      reportAddResult(r);
      loadGeo();
      return true;
    };

    const buildUpload = () => {
      const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.xlsx", hidden: true });
      const importFile = async (file) => {
        if (!file) return;
        if (!/\.(csv|tsv|xlsx)$/i.test(file.name)) {
          showToast("Use a .csv, .tsv or .xlsx file. An older .xls file needs saving as .xlsx first.", "error");
          return;
        }
        try {
          const rows = /\.xlsx$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
          const prompts = rowsToPrompts(rows);
          if (!prompts.length) { showToast("No prompts found in that file — make sure column A has your prompts.", "error"); return; }
          await addRows(prompts, "Imported");
        } catch (err) {
          showToast(`Couldn't read that file: ${err.message}`, "error");
        } finally {
          fileInput.value = "";
        }
      };
      fileInput.onchange = () => importFile(fileInput.files[0]);
      const choose = el("button", { type: "button", className: "btn primary" }, "Choose file");
      choose.onclick = () => fileInput.click();
      // The template (0.77.0): Excel, with Primary and Secondary tag columns
      // and the campaign's tags as a dropdown; or the same as CSV.
      const template = el("button", { type: "button", className: "linkbtn", id: "csTemplateXlsx", "data-tip": "Prompt, Primary tag and Secondary tag columns, with example rows and this campaign's tags to pick from" }, "Download the Excel template");
      template.onclick = async () => {
        const wb = promptTemplateWorkbook({ tags: [...new Set(GEO_PROMPTS.flatMap((p) => p.tags || []))] });
        const a = el("a", { href: URL.createObjectURL(await wb.toBlob()), download: "prompts-template.xlsx" });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      const templateCsv = el("button", { type: "button", className: "linkbtn", id: "csTemplateCsv" }, "or CSV");
      templateCsv.onclick = () => download("prompts-template.csv", promptTemplateCsv(), "text/csv");
      const drop = el("div", { className: "cs-drop" },
        setupIcon("file", 26, 1.6),
        el("p", { className: "cs-drop-title" }, "Drop a .csv, .tsv or .xlsx file here"),
        el("div", { className: "cs-drop-actions" }, choose, template, templateCsv),
        fileInput);
      drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add("is-over"); };
      drop.ondragleave = () => drop.classList.remove("is-over");
      drop.ondrop = (ev) => { ev.preventDefault(); drop.classList.remove("is-over"); importFile(ev.dataTransfer.files[0]); };
      const format = el("table", { className: "cs-format" },
        el("thead", {}, el("tr", {}, el("th", {}, "A · Prompt"), el("th", {}, "B · Tags (optional)"))),
        el("tbody", {}, el("tr", {}, el("td", {}, "best running shoes for flat feet"), el("td", {}, "footwear, comparison"))));
      return el("div", { className: "cs-mode-panel" }, drop, format);
    };

    const buildManual = () => {
      const ta = el("textarea", {
        id: "cs-manual", className: "cs-textarea", rows: 5,
        placeholder: "One prompt per line — add tags after a | (pipe)…\nbest accounting software for small business | software, smb\nZento vs Kovo for freelancers | comparison",
      });
      // Reported: a long prompt's own commas were being read as tag
      // separators, turning most of the sentence into tags — splitting on
      // EVERY comma in the line assumed a short "prompt, tag, tag" shape,
      // but a real prompt ("best phones under 20k, with a good camera and
      // battery") uses commas as ordinary punctuation just as often. A pipe
      // never appears in normal prose, so only an explicit `| tag, tag`
      // suffix is treated as tags now — a comma in the prompt itself is
      // just a comma, however long the prompt runs.
      const parse = () => ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const bar = line.indexOf("|");
        const text = (bar === -1 ? line : line.slice(0, bar)).trim();
        const tags = bar === -1 ? [] : line.slice(bar + 1).split(",").map((t) => t.trim()).filter(Boolean);
        return { text, tags };
      }).filter((r) => r.text);
      const count = el("span", { className: "cs-manual-count" }, "Nothing to add yet");
      const add = el("button", { type: "button", className: "btn primary", disabled: true }, "Add prompts");
      ta.oninput = () => {
        const n = parse().length;
        add.disabled = !n;
        count.textContent = n ? `${n} prompt${n === 1 ? "" : "s"} ready to add` : "Nothing to add yet";
      };
      add.onclick = async () => {
        const rows = parse();
        if (!rows.length) return;
        add.disabled = true;
        if (!(await addRows(rows, "Added"))) add.disabled = false;
      };
      // Prompts to start from (1.0.0, lib/onboarding.js): what you sell, in
      // your words, and ten questions people ask an AI before they buy, in
      // the interface's language, with the brand and first competitor in.
      const cat = el("input", { type: "text", id: "cs-example-cat", className: "cs-input cs-example-cat", placeholder: "What you sell, e.g. running shoes", "aria-label": "What you sell" });
      const fillBtn = el("button", { type: "button", className: "btn sm" }, "Fill in examples");
      fillBtn.onclick = () => {
        const brand = (profile && profile.brand && profile.brand.name) || (document.getElementById("cs-brand") || {}).value || "";
        const rival = (profile && (profile.competitors || [])[0] && profile.competitors[0].name) || "";
        const rows = examplePrompts({ category: cat.value, brand: brand.trim(), rival: rival.trim() });
        if (!rows.length) { cat.focus(); showToast(tr("Type what you sell first, e.g. running shoes."), "info"); return; }
        const lines = rows.map((r) => `${fmt(r.template, r.vars)} | ${tr(r.tags)}`);
        ta.value = (ta.value.trim() ? `${ta.value.trim()}\n` : "") + lines.join("\n");
        ta.dispatchEvent(new Event("input"));
        ta.focus();
      };
      const examples = el("div", { className: "cs-examples" }, el("span", { className: "cs-help" }, "Not sure where to start?"), cat, fillBtn);
      return el("div", { className: "cs-mode-panel" },
        el("label", { htmlFor: "cs-manual", className: "cs-label" }, "Your prompts"),
        examples,
        ta,
        el("p", { className: "cs-help" }, "One prompt per line. To tag a prompt, add ", el("b", {}, "|"), " then tags separated by commas."),
        el("div", { className: "cs-manual-foot" }, count, add));
    };

    const modeButton = (mode, icon, title, sub) => {
      const b = el("button", { type: "button", className: "cs-mode", "aria-pressed": String(promptAddMode === mode) },
        el("span", { className: "cs-mode-icon" }, setupIcon(icon, 20, 1.9)),
        el("span", { className: "cs-mode-text" },
          el("span", { className: "cs-mode-title" }, title),
          el("span", { className: "cs-mode-sub" }, sub)));
      b.dataset.mode = mode;
      return b;
    };
    const uploadBtn = modeButton("upload", "upload", "Upload a file", "CSV or Excel. Prompts in column A, tags in column B");
    const manualBtn = modeButton("manual", "pencil", "Add manually", "Type or paste, one prompt per line");
    const host = el("div", { className: "cs-mode-host" });
    const noteText = promptAddNote && promptAddNote.id === profile.id ? promptAddNote.text : "";
    const note = el("p", { className: "cs-note", role: "status", hidden: !noteText }, setupIcon("check", 14, 2.6), el("span", {}, noteText));
    // Switched in place, not by re-rendering the tab, so nothing typed in the
    // campaign details is disturbed.
    const showMode = (mode, focus) => {
      promptAddMode = mode;
      uploadBtn.setAttribute("aria-pressed", String(mode === "upload"));
      manualBtn.setAttribute("aria-pressed", String(mode === "manual"));
      host.replaceChildren(...(mode === "upload" ? [buildUpload()] : mode === "manual" ? [buildManual()] : []));
      if (focus && mode === "manual") host.querySelector("textarea").focus();
    };
    uploadBtn.onclick = () => { note.hidden = true; promptAddNote = null; showMode(promptAddMode === "upload" ? null : "upload", true); };
    manualBtn.onclick = () => { note.hidden = true; promptAddNote = null; showMode(promptAddMode === "manual" ? null : "manual", true); };
    showMode(promptAddMode, false);
    wrap.append(el("div", { className: "cs-group", id: "cs-prompts" },
      el("div", { className: "cs-modes" }, uploadBtn, manualBtn),
      host,
      note,
      el("p", { className: "cs-msg", id: "cs-prompts-msg", hidden: true }, "Add at least one prompt. Upload a file or type them in.")));
  }

  if (!GEO_PROMPTS.length) {
    wrap.append(el("div", { className: "cs-empty" },
      el("p", { className: "cs-empty-title" }, "No prompts yet"),
      el("p", {}, dis ? "This campaign has no prompts." : "Choose Upload a file or Add manually above. Your prompts will be listed here.")));
    return wrap;
  }

  const toolbar = el("div", { className: "prompt-toolbar" });
  const search = el("input", { type: "text", placeholder: "🔍 Search words in prompts…", title: "Type any words — rows matching every word are shown, in any order", value: promptSearch, className: "prompt-search" });
  search.oninput = () => {
    promptSearch = search.value;
    // renderCampaigns() tears down and rebuilds the whole tab (this codebase's
    // render pattern everywhere), which would otherwise steal focus from this
    // box after every keystroke — restore it and the cursor position.
    const cursor = search.selectionStart;
    renderCampaigns();
    const next = $(".prompt-search");
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  toolbar.append(search);
  if (!dis) {
    const unassignedInput = el("input", { type: "checkbox", checked: promptOnlyUnassigned });
    unassignedInput.onchange = (e) => { promptOnlyUnassigned = e.target.checked; renderCampaigns(); };
    toolbar.append(el("label", { className: "chk" }, unassignedInput, " Only unassigned"));
  }
  wrap.append(toolbar);

  const tags = allTags(GEO_PROMPTS);
  const filtered = GEO_PROMPTS.filter((p) => {
    if (!matchesSearch(p.text, promptSearch)) return false;
    if (promptOnlyUnassigned && (p.tags || []).length) return false;
    // Primary is tags[0] (0.77.0); the filter can look at either role.
    const pool = promptTagRole === "primary" ? (p.tags || []).slice(0, 1) : promptTagRole === "secondary" ? (p.tags || []).slice(1) : (p.tags || []);
    if (promptTagFilter.length && !promptTagFilter.some((t) => pool.includes(t))) return false;
    return true;
  });

  const body = el("div", { className: "prompt-table-layout" });
  if (tags.length) {
    const sidebar = el("div", { className: "tag-sidebar" });
    const role = el("select", { className: "tag-role", id: "csTagRole", "aria-label": "Match the tag as", title: "Match a tag as the prompt's primary tag, a secondary one, or either" },
      ...[["any", "Any tag"], ["primary", "Primary tag"], ["secondary", "Secondary tag"]].map(([v, l]) => el("option", { value: v, selected: v === promptTagRole }, l)));
    role.onchange = () => { promptTagRole = role.value; renderCampaigns(); };
    sidebar.append(el("div", { className: "muted small tag-sidebar-head", style: "margin-bottom:6px" }, "Tags", role));
    const allChip = el("button", { className: `tag clickable${promptTagFilter.length ? "" : " on"}` }, "All");
    allChip.onclick = () => { promptTagFilter = []; renderCampaigns(); };
    sidebar.append(allChip);
    // A rounded "pill" chip (the style everywhere else in this app, e.g. the
    // "All" button above) reads fine for a short word but wraps into an ugly
    // multi-line blob for a real tag like "Consumer Electronics &
    // Smartphones" in a narrow sidebar — a plain full-width list row, like
    // any sidebar filter list, wraps normally and leaves room for the
    // rename/delete icons without fighting the label for space.
    const list = el("div", { className: "tag-sidebar-list" });
    tags.forEach((t) => {
      const on = promptTagFilter.includes(t);
      const chipRow = el("div", { className: `tag-sidebar-row${on ? " on" : ""}` });
      const label = el("button", { className: "tag-sidebar-label" }, t);
      label.onclick = () => { promptTagFilter = on ? promptTagFilter.filter((x) => x !== t) : [...promptTagFilter, t]; renderCampaigns(); };
      chipRow.append(label);
      if (!dis) {
        const icons = el("div", { className: "tag-icons" });
        const renameBtn = el("button", { className: "tag-icon-btn", title: fmt("Rename tag \"{tag}\"", { tag: t }) }, "✎");
        renameBtn.onclick = async () => {
          const next = window.prompt(`Rename tag "${t}" to:`, t);
          if (!next || !next.trim() || next.trim() === t) return;
          const r = await send({ type: "geo-tag-rename", profileId: profile.id, oldTag: t, newTag: next.trim() });
          if (r.ok) { promptTagFilter = promptTagFilter.map((x) => (x === t ? next.trim() : x)); loadGeo(); } else showToast(r.error, "error");
        };
        const delBtn = el("button", { className: "tag-icon-btn danger", title: fmt("Delete tag \"{tag}\"", { tag: t }) }, "✕");
        delBtn.onclick = async () => {
          const affected = GEO_PROMPTS.filter((p) => (p.tags || []).includes(t)).length;
          if (!confirm(`Delete the tag "${t}"?\n\nThis removes it from ${affected} prompt(s) — the prompts themselves are kept, they just lose this tag.`)) return;
          const r = await send({ type: "geo-tag-delete", profileId: profile.id, tag: t });
          if (r.ok) { promptTagFilter = promptTagFilter.filter((x) => x !== t); loadGeo(); } else showToast(r.error, "error");
        };
        icons.append(renameBtn, delBtn);
        chipRow.append(icons);
      }
      list.append(chipRow);
    });
    sidebar.append(list);
    body.append(sidebar);
  }

  if (!dis) {
    // Bulk actions replace the old always-visible per-row pause/remove
    // buttons — select what you want to act on, then act on all of it at
    // once, instead of clicking pause/remove one row at a time.
    const bulkBar = el("div", { className: "prompt-bulk-bar" });
    const selAllCb = el("input", { type: "checkbox" });
    selAllCb.checked = filtered.length > 0 && filtered.every((p) => selectedPromptIds.has(p.id));
    selAllCb.onchange = () => {
      filtered.forEach((p) => (selAllCb.checked ? selectedPromptIds.add(p.id) : selectedPromptIds.delete(p.id)));
      renderCampaigns();
    };
    bulkBar.append(el("label", { className: "chk" }, selAllCb, ` Select all (${filtered.length})`));
    if (selectedPromptIds.size) {
      bulkBar.append(el("span", { className: "muted small" }, `${selectedPromptIds.size} selected`));
      const actOn = async (fn) => { for (const id of selectedPromptIds) await fn(id); loadGeo(); };
      const pauseBtn = el("button", { className: "btn sm ghost" }, "⏸ Pause selected");
      pauseBtn.onclick = () => actOn(async (id) => {
        const p = GEO_PROMPTS.find((x) => x.id === id);
        if (p && p.active !== false) await send({ type: "geo-prompt-save", prompt: { ...p, active: false } });
      });
      const enableBtn = el("button", { className: "btn sm ghost" }, "▶ Enable selected");
      enableBtn.onclick = () => actOn(async (id) => {
        const p = GEO_PROMPTS.find((x) => x.id === id);
        if (p && p.active === false) await send({ type: "geo-prompt-save", prompt: { ...p, active: true } });
      });
      const removeBtn = el("button", { className: "btn sm danger" }, "🗑 Remove selected");
      removeBtn.onclick = async () => {
        if (!confirm(`Remove ${selectedPromptIds.size} selected prompt(s)? Responses already captured for them are kept.`)) return;
        await actOn((id) => send({ type: "geo-prompt-delete", id }));
      };
      bulkBar.append(pauseBtn, enableBtn, removeBtn);
    }
    wrap.append(bulkBar);
  }

  const headerCells = [];
  if (!dis) headerCells.push(el("th", { style: "width:24px" }, ""));
  headerCells.push(el("th", {}, "Prompt"), el("th", { "data-tip": "The prompt's main topic; the campaign board groups prompts by it" }, "Primary tag"), el("th", {}, "Secondary tags"));
  const table = el("table", { className: "prompt-table" }, el("tr", {}, ...headerCells));

  filtered.forEach((p) => {
    const cells = [];
    if (!dis) {
      const cb = el("input", { type: "checkbox", checked: selectedPromptIds.has(p.id) });
      cb.onchange = () => {
        if (cb.checked) selectedPromptIds.add(p.id); else selectedPromptIds.delete(p.id);
        renderCampaigns();
      };
      cells.push(el("td", { className: "prompt-check" }, cb));
    }
    const promptCell = el("td", { className: "prompt-cell" });
    if (p.active === false) promptCell.append(el("span", { className: "tag fetched", style: "margin-right:6px" }, "⏸ paused"));
    promptCell.append(highlightMatch(p.text, promptSearch));
    cells.push(promptCell);
    // Primary (tags[0]) and secondary tags apart (0.77.0); any one tag can
    // be taken off this prompt, and a secondary one made primary.
    const saveTags = async (tags) => { await send({ type: "geo-prompt-save", prompt: { ...p, tags: [...new Set(tags)] } }); loadGeo(); };
    const chip = (t, i) => {
      const c = el("span", { className: `tag tag-removable${i === 0 ? " tag-primary" : ""}` });
      if (!dis && i > 0) {
        const up = el("button", { type: "button", className: "tag-label", title: fmt("Make \"{tag}\" the primary tag", { tag: t }) }, t);
        up.onclick = () => saveTags([t, ...(p.tags || []).filter((x) => x !== t)]);
        c.append(up);
      } else c.append(t);
      if (!dis) {
        const x = el("button", { type: "button", className: "tag-x", title: fmt("Take \"{tag}\" off this prompt", { tag: t }), "aria-label": fmt("Remove the tag {tag} from this prompt", { tag: t }) }, "×");
        x.onclick = () => saveTags((p.tags || []).filter((y) => y !== t));
        c.append(x);
      }
      return c;
    };
    const tagInput = (placeholder, primary) => {
      const ti = el("input", { type: "text", className: "taginput", placeholder });
      ti.onkeydown = async (ev) => {
        if (ev.key !== "Enter" || !ti.value.trim()) return;
        const typed = ti.value.split(",").map((s) => s.trim()).filter(Boolean);
        await saveTags(primary ? [...typed.slice(0, 1), ...(p.tags || []), ...typed.slice(1)] : [...(p.tags || []), ...typed]);
      };
      return ti;
    };
    const tags0 = p.tags || [];
    const priWrap = el("div", { className: "tagline" });
    if (tags0.length) priWrap.append(chip(tags0[0], 0));
    else if (!dis) priWrap.append(tagInput("+ primary", true));
    const secWrap = el("div", { className: "tagline" });
    tags0.slice(1).forEach((t, j) => secWrap.append(chip(t, j + 1)));
    if (!dis && tags0.length) secWrap.append(tagInput("+ tag", false));
    cells.push(el("td", { className: "prompt-pri" }, priWrap), el("td", { className: "prompt-sec" }, secWrap));
    table.append(el("tr", { className: p.active === false ? "inactive-row" : "" }, ...cells));
  });

  body.append(el("div", { className: "prompt-table-scroll" }, table));
  wrap.append(body);
  if (promptSearch || promptTagFilter.length || promptOnlyUnassigned) {
    wrap.append(el("div", { className: "muted small", style: "margin-top:6px" }, `Showing ${filtered.length} of ${GEO_PROMPTS.length} prompts.`));
  }
  return wrap;
}

/* A set-up campaign's header (0.55.0, the canvas's TabCampaign): its name
 * and what it covers, Edit setup / Export… / Run again, and under them the
 * board's filters (renderCampaignBoard fills #cpFilters once it loads). It
 * replaces three stacked cards — the chooser, a summary and the run card —
 * that pushed the results below the fold. The run controls and the live
 * status are the run card's, unchanged: Pause / Resume / Stop show only while
 * a run is going (renderLoaderStatus sets .live and .paused), and the run
 * history moved down to "Data collected". */
// The run's state as last reported, so a header rebuilt mid-run (every
// capture re-renders the tab) shows Pause / Stop straight away rather than
// "Run again" until the next status reply.
let cpLive = { live: false, paused: false, profileId: null };

/* Share a campaign, and open one someone shared (0.82.0). Asked: "transfer
 * a campaign to another person who can then run it on their own system".
 * Always as a .cito file; by a 10-character code too once accounts are
 * switched on and you're signed in (About → Account). */
function saveBytes(fileName, b64) {
  const blob = new Blob([b64ToBuf(b64)], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const fmtMB = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

async function openShareDialog(profile) {
  document.getElementById("share-modal-backdrop")?.remove();
  const backdrop = el("div", { id: "share-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content sh-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "sh-title" });
  const closeBtn = el("button", { className: "modal-close-btn", type: "button", title: "Close", "aria-label": "Close" }, "×");
  modal.append(el("div", { className: "modal-header" }, el("div", {}, el("h3", { className: "modal-title", id: "sh-title" }, `Share ${profile.name || "campaign"}`), el("div", { className: "muted small" }, "They get the setup, prompts, runs and answers, and can run it themselves.")), closeBtn));
  const raw = el("input", { type: "checkbox", id: "shRaw", checked: true });
  const status = el("p", { className: "sh-status", role: "status", id: "shStatus" });
  const fileBtn = el("button", { className: "btn primary", type: "button", id: "shFile" }, "Download file (.cito)");
  const codeBox = el("div", { className: "sh-code-box", id: "shCodeBox" });
  modal.append(el("div", { className: "modal-body sh-body" },
    el("label", { className: "sh-check" }, raw, el("span", {}, el("b", {}, "Include the raw captures"), el("span", { className: "muted small" }, " · larger, and lets them re-read the answers with a newer CitoSkeleton"))),
    el("div", { className: "sh-way" }, el("h4", { className: "sh-h" }, "As a file"), el("p", { className: "muted small" }, "Send it any way you like. They open it from Campaigns → Import."), fileBtn),
    el("div", { className: "sh-way" }, el("h4", { className: "sh-h" }, "By code"), codeBox),
    status));
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = wireModalDismiss(backdrop, modal);
  closeBtn.onclick = close;

  fileBtn.onclick = withBusy(fileBtn, "Packing…", async () => {
    const r = await send({ type: "campaign-bundle-export", profileId: profile.id, includeRaw: raw.checked });
    if (!r || !r.ok) { status.textContent = (r && r.error) || "Couldn't pack the campaign."; status.className = "sh-status bad"; return; }
    saveBytes(r.fileName, r.data);
    status.textContent = `Saved ${r.fileName} · ${fmtMB(r.bytes)} · ${plural(r.counts.prompts, "prompt")}, ${plural(r.counts.runs, "run")}, ${plural(r.counts.answers, "answer")}.`;
    status.className = "sh-status ok";
  });

  const cs = await send({ type: "cloud-status" });
  if (!cs || !cs.ready) {
    codeBox.append(el("p", { className: "muted small" }, "Accounts aren't switched on yet, so sharing by code isn't available. The file works the same."));
  } else if (!cs.signedIn) {
    const go = el("button", { className: "btn sm ghost", type: "button" }, "Sign in…");
    go.onclick = () => { close(); openAccount(); };
    codeBox.append(el("p", { className: "muted small" }, "Sign in to get a short code they can type in instead of a file."), go);
  } else {
    const get = el("button", { className: "btn ghost", type: "button", id: "shGetCode" }, "Get a code");
    codeBox.append(el("p", { className: "muted small" }, "A code that opens this campaign for anyone signed in, for 90 days. Stop it any time in About → Account."), get);
    get.onclick = withBusy(get, "Uploading…", async () => {
      const r = await send({ type: "campaign-share-upload", profileId: profile.id, includeRaw: raw.checked });
      if (!r || !r.ok) { status.textContent = (r && r.error) || "Couldn't share it."; status.className = "sh-status bad"; return; }
      const code = `${r.code.slice(0, 5)}-${r.code.slice(5)}`;
      const copy = el("button", { className: "btn sm ghost", type: "button" }, "Copy");
      copy.onclick = async () => { try { await navigator.clipboard.writeText(r.code); showToast("Code copied."); } catch (_) { showToast("Couldn't copy: select the code instead.", "error"); } };
      codeBox.replaceChildren(el("div", { className: "sh-code", id: "shCode" }, el("code", {}, code), copy), el("p", { className: "muted small" }, `They open it from Campaigns → Import → Open a code. ${fmtMB(r.bytes)}.`));
      status.textContent = "";
    });
  }
}

async function openImportDialog() {
  document.getElementById("import-modal-backdrop")?.remove();
  const backdrop = el("div", { id: "import-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content sh-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "im-title" });
  const closeBtn = el("button", { className: "modal-close-btn", type: "button", title: "Close", "aria-label": "Close" }, "×");
  modal.append(el("div", { className: "modal-header" }, el("div", {}, el("h3", { className: "modal-title", id: "im-title" }, "Import a shared campaign"), el("div", { className: "muted small" }, "It's added as a campaign of your own, beside the ones you have. Nothing of yours changes.")), closeBtn));
  const file = el("input", { type: "file", id: "imFile", accept: ".cito,.json,application/json,application/octet-stream", className: "sh-file" });
  const status = el("p", { className: "sh-status", role: "status", id: "imStatus" });
  const codeBox = el("div", { className: "sh-code-box" });
  modal.append(el("div", { className: "modal-body sh-body" },
    el("div", { className: "sh-way" }, el("h4", { className: "sh-h" }, "From a file"), el("p", { className: "muted small" }, "A .cito file someone sent you."), file),
    el("div", { className: "sh-way" }, el("h4", { className: "sh-h" }, "Open a code"), codeBox),
    status));
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = wireModalDismiss(backdrop, modal);
  closeBtn.onclick = close;
  const done = (r) => {
    if (!r || !r.ok) { status.textContent = (r && r.error) || "Couldn't import it."; status.className = "sh-status bad"; return; }
    close();
    showToast(`Imported ${r.name}: ${plural(r.counts.prompts, "prompt")}, ${plural(r.counts.answers, "answer")}.`);
    geoActiveId = r.profileId;
    campaignManageOpen = false;
    loadGeo();
  };
  file.onchange = async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    status.textContent = "Reading…";
    status.className = "sh-status";
    const buf = await f.arrayBuffer();
    done(await send({ type: "campaign-bundle-import", data: bufToB64(buf) }));
  };
  const cs = await send({ type: "cloud-status" });
  if (!cs || !cs.ready) {
    codeBox.append(el("p", { className: "muted small" }, "Accounts aren't switched on yet. Ask for the file instead."));
  } else if (!cs.signedIn) {
    const go = el("button", { className: "btn sm ghost", type: "button" }, "Sign in…");
    go.onclick = () => { close(); openAccount(); };
    codeBox.append(el("p", { className: "muted small" }, "Sign in to open a code."), go);
  } else {
    const input = el("input", { type: "text", id: "imCode", className: "filter sh-code-input", placeholder: "ABCDE-FGHJK", autocomplete: "off", spellcheck: "false", "aria-label": "Share code" });
    const open = el("button", { className: "btn primary", type: "button" }, "Open");
    open.onclick = withBusy(open, "Opening…", async () => done(await send({ type: "campaign-share-open", code: input.value })));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") open.click(); });
    codeBox.append(el("div", { className: "sh-code-row" }, input, open));
  }
}

function renderCampaignHead(profile) {
  // Live (Pause / Stop in place of Run) only on the page of the campaign that
  // is running. On every other campaign's page Run stays, and queues the run
  // behind it: with "any run going" here, Run was hidden on every page, the
  // queue could not be reached at all, and another campaign's page offered
  // Pause and Stop for a run it wasn't running (live run, 23 Nov 2026).
  const holding = cpHolding(profile);
  const head = el("section", { className: `card cp-head${holding ? " live" : ""}${holding && cpLive.paused ? " paused" : ""}`, id: "cpHead", "data-profile-id": profile.id, "aria-labelledby": "cpName" });
  head.append(el("div", { className: "cp-switch" }, el("span", { className: "muted small" }, `Campaigns · ${GEO_PROFILES.length} of ${MAX_PROFILES}`), renderCampaignSwitcher()));

  const vol = runVolume(GEO_PROMPTS, profile.engines || []);
  const due = runDue(profile);
  const fmtWhen = (t) => new Date(t).toLocaleString(dateLocale(), { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const brand = profile.brand && profile.brand.name;
  const sub = [
    brand ? fmt("Tracking {brand}", { brand }) : "",
    `${plural(vol.prompts, "prompt")} × ${plural(vol.engines, "engine")}`,
    profile.lastRunAt ? fmt("last run {when}", { when: fmtWhen(profile.lastRunAt) }) : "not run yet",
  ].filter(Boolean).join(" · ");

  const edit = el("button", { className: "btn ghost cp-btn", type: "button", "aria-expanded": campaignManageOpen ? "true" : "false" }, campaignManageOpen ? "Close setup" : "Edit setup");
  edit.onclick = () => {
    campaignManageOpen = !campaignManageOpen;
    if (!campaignManageOpen && cbNeedsReload) { cbNeedsReload = false; loadGeo(); } else renderCampaigns();
  };
  // Filled with the board's figures once it loads (renderCampaignBoard).
  const exp = el("button", { className: "btn ghost cp-btn", type: "button", id: "cbExport", disabled: true, title: "The campaign as an Excel workbook, CSV tables or a PDF report" }, "Export…");
  const runBtn = el("button", { className: "btn primary cp-btn cp-run", type: "button" }, profile.lastRunAt ? "Run again" : "Start run");
  runBtn.onclick = withBusy(runBtn, "Starting…", async () => {
    if (!confirm(`Run tracking now?\n\n${vol.submissions} submissions (${vol.prompts} prompts × ${vol.engines} engines) will be sent through your logged-in sessions at a human pace.`)) return;
    // The auth gate can bounce this back (authBlocked) before any tab opens.
    // That isn't an error to toast and forget — it's actionable, so it opens
    // the sign-in dialog, which can retry this same call once the user is in.
    const attempt = async (skipAuthCheck) => {
      const r = await send({ type: "geo-run-start", profileId: profile.id, skipAuthCheck });
      if (r.authBlocked) {
        showSignInGate({
          signedOut: r.signedOut, unknown: r.unknown, message: r.error,
          onProceed: (skip) => attempt(skip),
        });
        return;
      }
      if (!r.ok) { showToast(r.error, "error"); return; }
      if (r.queued) showToast(`Queued (${r.position === 1 ? "next" : `#${r.position}`}): it starts by itself when the run going now finishes.`);
      loadGeo();
    };
    await attempt(false);
  });
  // Signed out (0.66.0): the same run in a private window with no engine
  // session, for answers without account history or memory.
  const privBtn = el("button", { className: "btn ghost cp-btn cp-run cp-run-private", type: "button", title: "Run in a private window, signed out of every engine: answers without your account's history or memory" }, "Run signed out");
  privBtn.onclick = withBusy(privBtn, "Starting…", async () => {
    // Grok is left out signed out (it needs an account), so it isn't counted.
    const privVol = runVolume(GEO_PROMPTS, (profile.engines || []).filter((e) => e !== "grok"));
    const grokNote = (profile.engines || []).includes("grok") ? "Grok needs an account, so it is left out. " : "";
    if (!privVol.engines) { showToast("Grok needs a signed-in account, so it can't run signed out. Add another engine to this campaign.", "error"); return; }
    if (!confirm(`Run signed out?\n\n${privVol.submissions} submissions (${privVol.prompts} prompts × ${privVol.engines} engine${privVol.engines === 1 ? "" : "s"}) will be sent from a new private window, signed out of every engine, so the answers carry no account history or memory.\n\n${grokNote}Other engines may limit how much you can ask signed out: Perplexity asks you to sign up after a few questions, and those turns are marked "usage limit" so "Retry missing" can ask them later, signed in.`)) return;
    const r = await send({ type: "geo-run-start", profileId: profile.id, privateWindow: true });
    if (!r || !r.ok) { showToast((r && r.error) || "Couldn't start the run.", "error"); return; }
    if (r.queued) showToast(`Queued (${r.position === 1 ? "next" : `#${r.position}`}): it starts by itself when the run going now finishes.`);
    if (r.leftOut && r.leftOut.length) showToast("Grok is left out of signed-out runs: it needs a signed-in account.");
    loadGeo();
  });
  const pauseBtn = el("button", { className: "btn ghost cp-btn cp-live cp-pause", type: "button" }, "Pause");
  pauseBtn.onclick = async () => {
    const r = await send({ type: "loader-pause" });
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  const resumeBtn = el("button", { className: "btn primary cp-btn cp-live cp-resume", type: "button" }, "Resume");
  // Resume can genuinely fail now — a run interrupted by the browser closing
  // has no tab left, so resuming has to open one, and Chrome can refuse.
  // Rendering that {ok:false} reply as a status would blank the live panel and
  // make a paused run look finished, so it's reported and the status left be.
  resumeBtn.onclick = async () => {
    const r = await send({ type: "loader-resume" });
    if (!r || r.ok === false) { showToast(r?.error || "Couldn't resume the run.", "error"); return; }
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  const stopBtn = el("button", { className: "btn danger cp-btn cp-live", type: "button" }, "Stop");
  stopBtn.onclick = async () => {
    const r = await send({ type: "loader-stop" });
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  // The campaign's findings, a task and a question, to another AI: through
  // the app bar's share icon (0.80.0).
  setShare("loader", { getParts: async () => { const r = await send({ type: "campaign-insights", profileId: profile.id }); return r && r.ok ? campaignParts(r.insights) : []; }, file: `${String(profile.name || "campaign").replace(/[^\p{L}\p{N}]+/gu, "-")}-citoskeleton.md` });
  // Fewer buttons (0.80.0, asked: "the 4 to 6 buttons at the top are
  // creating a lot of confusion"). One Run, with signed out under its arrow;
  // while a run goes, Pause or Resume and Stop; everything else under ⋯.
  const menuOf = (btn, items, cls) => {
    const menu = el("div", { className: "cp-menu", role: "menu", hidden: true }, ...items);
    const wrap = el("span", { className: `cp-menu-wrap ${cls || ""}` }, btn, menu);
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.onclick = (ev) => { ev.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
    menu.addEventListener("click", () => close());
    document.addEventListener("click", (ev) => { if (!wrap.contains(ev.target)) close(); });
    items.forEach((b) => b.setAttribute("role", "menuitem"));
    return wrap;
  };
  privBtn.className = "btn ghost cp-btn cp-run-private";
  privBtn.replaceChildren("Run signed out", el("span", { className: "cp-menu-sub" }, "in a private window, without your accounts"));
  const caret = el("button", { className: "btn primary cp-btn cp-caret", type: "button", "aria-label": "More ways to run", title: "Run signed out" }, "▾");
  const runSplit = el("span", { className: "cp-split cp-idle" }, runBtn, menuOf(caret, [privBtn], "cp-run-menu"));
  edit.classList.remove("btn", "ghost");
  exp.classList.remove("btn", "ghost");
  const shareBtn = el("button", { className: "cp-btn cp-share-campaign", type: "button", id: "cpShareCampaign", title: "Send this campaign to someone, as a file or a code, so they can run it too" }, "Share campaign…");
  shareBtn.onclick = () => openShareDialog(profile);
  const items = [edit, exp, shareBtn];
  const del = el("button", { className: "cp-btn danger cp-del", type: "button" }, "Delete campaign");
  del.onclick = trashCampaign(profile);
  items.push(del);
  const more = el("button", { className: "btn ghost cp-btn cp-more", type: "button", "aria-label": "More", title: "Edit setup, export, delete" }, "⋯");
  const actions = el("div", { className: "cp-actions" }, runSplit, pauseBtn, resumeBtn, stopBtn, menuOf(more, items, "cp-more-menu"));
  head.append(el("div", { className: "cp-title" },
    el("div", { className: "cp-name" }, el("h1", { id: "cpName" }, profile.name || "Campaign"), el("span", { className: "cp-sub" }, sub)),
    actions));

  const notes = [];
  if (due && vol.submissions) notes.push(el("div", { className: "geo-due" }, `Today's run hasn't happened yet — last run ${profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleDateString(dateLocale()) : "never"}.`));
  if (vol.submissions > 60) notes.push(el("div", { className: "warn-box" }, el("span", {}, `${vol.submissions} automated submissions in one run is a lot of activity on one account. Consider splitting your prompts across campaigns or pausing some, and keep an eye on the run rather than leaving it unattended.`)));
  head.append(...notes);
  // Answers missing from the last finished run (0.78.1): asked again on
  // their engines only, and added to that same run.
  const missing = el("div", { className: "cp-missing", id: "cpMissing", hidden: true });
  head.append(missing);
  if (!cpLive.live) send({ type: "geo-run-missing", profileId: profile.id }).then((m) => {
    if (!m || !m.ok || !m.count || cpLive.live) return;
    const parts = Object.entries(m.byEngine || {}).filter(([, n]) => n).map(([e, n]) => `${n} on ${atEngineLabel(e)}`);
    // A run that was stopped is carried on from where it stopped (0.80.0,
    // asked: "if I stop a campaign run and want to restart it, I can't"):
    // the same call as Retry missing, named for what it does.
    const stopped = m.status === "stopped";
    const btn = el("button", { className: "btn sm primary", type: "button", id: "cpRetryMissing" }, stopped ? `Continue this run · ${m.count} left` : `Retry ${m.count} missing`);
    btn.onclick = withBusy(btn, "Starting…", async () => {
      if (!confirm(stopped
        ? `Carry on the run you stopped?\n\n${m.count} prompt${m.count === 1 ? "" : "s"} left: ${parts.join(", ")}. Only those are sent, and the answers are added to the same run.`
        : `Ask the ${m.count} missing prompt${m.count === 1 ? "" : "s"} again?\n\n${parts.join(", ")}. Only those are sent, each to the engine that has no answer for it, and the answers are added to the same run.`)) return;
      // The same sign-in check as Run, and the same way past it.
      const attempt = async (skipAuthCheck) => {
        const r = await send({ type: "geo-run-start", profileId: profile.id, retryRunId: m.runId, skipAuthCheck });
        if (r && r.authBlocked) {
          showSignInGate({ signedOut: r.signedOut, unknown: r.unknown, message: r.error, onProceed: (skip) => attempt(skip) });
          return;
        }
        if (!r || !r.ok) { showToast((r && r.error) || "Couldn't start the retry.", "error"); return; }
        loadGeo();
      };
      await attempt(false);
    });
    missing.replaceChildren(el("span", {}, el("b", {}, stopped ? fmt("The last run was stopped with {n} answers to go", { n: m.count }, "The last run was stopped with {n} answer to go") : fmt("{n} answers are missing from the last run", { n: m.count }, "{n} answer is missing from the last run")), ` · ${parts.join(", ")}`), btn);
    missing.hidden = false;
  });
  // Waiting its turn behind another campaign's run (0.80.0).
  const queued = el("div", { className: "cp-queued", id: "cpQueued", hidden: true });
  head.append(queued);
  send({ type: "run-queue" }).then((q) => {
    const i = q && q.ok ? (q.queue || []).findIndex((x) => x.profileId === profile.id) : -1;
    if (i < 0) return;
    const running = GEO_PROFILES.find((p) => p.id === q.runningProfileId);
    const cancel = el("button", { className: "btn sm ghost", type: "button" }, "Cancel");
    cancel.onclick = async () => { await send({ type: "run-queue-remove", profileId: profile.id }); queued.hidden = true; showToast("Taken out of the queue"); };
    queued.replaceChildren(el("span", {}, el("b", {}, "Queued"), ` · ${i === 0 ? "starts" : `#${i + 1} in line, starts`} when ${running ? `“${running.name}”` : "the run going now"} finishes`), cancel);
    queued.hidden = false;
  });
  head.append(el("div", { id: "loaderStatus", className: "status-msg" }));
  head.append(el("div", { className: "cp-filters", id: "cpFilters" }));
  // Paint status immediately rather than waiting for the next 1.5s poll tick
  // — this card is rebuilt from scratch (root.textContent = "" in
  // renderCampaignsImpl) every time the Campaigns tab re-renders, so
  // without this the status box would flash empty for up to 1.5s on every
  // switch back to this tab while a run is in flight.
  send({ type: "loader-status" }).then((st) => { if (st.ok) renderLoaderStatus(st); });
  return head;
}

// Durable per-run history — reads geoRuns, which background.js now keeps in
// sync (status/captured/failed/finishedAt) as a run progresses and on
// completion; previously that store was written once at creation and never
// updated again, so this had nothing real to show and wasn't called at all.
function renderRunHistory(profile) {
  const box = el("div", { className: "loader-history", id: "runHistory" });
  box.append(el("h4", { className: "cb-sub-h" }, "Run history"));
  const list = el("div", { className: "muted small" }, "Loading…");
  box.append(list);
  send({ type: "geo-run-list", profileId: profile.id }).then((r) => {
    list.textContent = "";
    const runs = (r.ok ? r.runs : []).slice(0, 10);
    if (!runs.length) { list.append("No runs yet."); return; }
    const table = el("div", { className: "loader-history-rows" });
    runs.forEach((run) => {
      const dur = run.finishedAt ? fmtDuration(runTookMs(run)) : null;
      const statusLabel = { running: "Running", done: "Done", stopped: "Stopped", failed: "Failed" }[run.status] || run.status;
      // Clickable: this list used to be read-only text, so seeing that one run
      // captured fewer than the others gave you no way to go and look at it.
      const row = el("div", {
        className: `loader-history-row status-${run.status} clickable`,
        title: "Show only this run's results, below",
        style: "cursor:pointer",
      },
        el("span", { className: "muted" }, new Date(run.startedAt).toLocaleString(dateLocale())),
        el("span", {}, statusLabel),
        el("span", {}, `${run.captured || 0}/${run.expected || 0} captured${run.failed ? `, ${run.failed} failed` : ""}`),
        el("span", { className: "muted" }, dur ? `took ${dur}` : ""),
        el("span", { className: "linkbtn" }, "View results →"));
      row.onclick = () => {
        cbRun = run.id;
        cbDetail = null;
        cbProfileId = profile.id;
        geoActiveId = profile.id;
        renderCampaigns();
        document.getElementById("campaignResults")?.scrollIntoView({ block: "start", behavior: jumpBehavior() });
      };
      table.append(row);
    });
    list.append(table);
  });
  return box;
}

// The sources table's mode and filter (renderCampaignSources). Module scope:
// every render rebuilds the section, so a local would reset on each key.
let sourceViewMode = "domain"; // "domain" | "url"
let sourceSearch = "";

/* Shared modal chrome, so the URL and domain drill-downs can't drift apart. */
// A handful of fixed gradients, picked by a cheap hash of the name — not
// meaningful data, just enough variety that the avatar isn't the same flat
// blue on every modal (which was part of what read as "dull").
const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#6366f1,#4f46e5)",
  "linear-gradient(135deg,#0ea5e9,#0369a1)",
  "linear-gradient(135deg,#f59e0b,#d97706)",
  "linear-gradient(135deg,#ec4899,#db2777)",
  "linear-gradient(135deg,#10b981,#047857)",
  "linear-gradient(135deg,#8b5cf6,#6d28d9)",
];
function avatarGradient(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

function openDetailModal(title, subtitle, opts = {}) {
  const existing = document.getElementById("url-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "url-modal-backdrop", className: "modal-backdrop" });
  // `wide` is for a modal carrying a real table. The 520px default is right
  // for a list or a confirm dialog; at seven columns everything past the
  // prompt sits off the edge behind a scrollbar nobody notices.
  const modal = el("div", { className: `modal-content${opts.wide ? " modal-wide" : ""}` });
  const header = el("div", { className: "modal-header" });
  const titles = el("div", { className: "modal-header-titles" });
  if (opts.avatarText) {
    titles.append(el("div", { className: "modal-avatar", style: `background:${avatarGradient(opts.avatarKey || title)}` }, opts.avatarText));
  }
  // A subtitle that IS a URL (openUrlDetailModal passes the page URL itself)
  // used to render as plain unclickable text — no way to actually open the
  // page it names, only to drill into the captures that cited it below.
  // Both are useful; this adds the one that was missing.
  const isUrlSubtitle = typeof subtitle === "string" && /^https?:\/\//i.test(subtitle);
  const subEl = !subtitle ? el("span", {})
    : isUrlSubtitle
      ? el("div", { className: "muted small modal-sub" },
          el("a", { href: subtitle, target: "_blank", rel: "noreferrer", title: "Open this page" }, subtitle))
      : el("div", { className: "muted small modal-sub" }, subtitle);
  titles.append(el("div", { style: "min-width:0" },
    el("h3", { className: "modal-title" }, title),
    subEl));
  header.append(titles);
  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  header.append(closeBtn);
  modal.append(header);
  const body = el("div", { className: "modal-body" });
  modal.append(body);
  backdrop.append(modal);
  document.body.append(backdrop);
  // wireModalDismiss() (top of this file) owns Escape + backdrop-click +
  // focus restore to whatever opened the modal, and detaches its own keydown
  // listener on close. But the drill-down modals built on top of this call
  // `backdrop.remove()` DIRECTLY from ~8 places (row-click navigation, the
  // × button, "open this capture in Analyze" lines), which would bypass that
  // cleanup and leak one keydown listener per modal opened. Routing the
  // native remove() through close() means every one of those paths cleans up
  // without each having to remember to.
  const closeModal = wireModalDismiss(backdrop, modal);
  closeBtn.onclick = closeModal;
  const nativeRemove = backdrop.remove.bind(backdrop);
  backdrop.remove = () => { nativeRemove(); closeModal(); };
  return { backdrop, body };
}

const modalStat = (n, l, tone, tip, term) => el(
  "div",
  {
    className: `stat${tone ? " tone-" + tone : ""}`,
    ...(term ? { "data-term": term } : tip ? { "data-tip": tip } : {}),
  },
  el("div", { className: "n" }, String(n)),
  el("div", { className: "l" }, l),
);

/** Domain drill-down: this publisher's totals, then every URL of theirs that
 *  surfaced, then — expanded per URL — the exact prompts (or, for the ad-hoc
 *  Dashboard, captures) that pulled it in. Clicking one jumps to that
 *  capture in Analyze.
 *
 *  `unit` is "prompt" for a campaign's tracked runs or "capture" for plain
 *  ad-hoc browsing — the two label their counts differently ("N prompts
 *  cited on" vs. "N captures cited in") but are otherwise the same shape.
 *  Campaign rows come from aggregateSources() (renderCampaignSources). */
function openDomainDetailModal(row, subtitle, unit = "prompt") {
  const plural = (n) => (n === 1 ? unit : `${unit}s`);
  const inOn = unit === "prompt" ? "cited on" : "cited in";
  const { backdrop, body } = openDetailModal(row.key, subtitle, { avatarText: row.key.slice(0, 1).toUpperCase(), avatarKey: row.key });

  const stats = el("div", { className: "statgrid modal-statgrid" });
  stats.append(
    // Reach first, then volume. They answer different questions and the order
    // says which one to read first: "how often do the engines reach for this
    // publisher at all" before "how hard do they lean on it when they do".
    modalStat(fmtPct(row.visibility), "Visibility", "accent", null, "domainVisibility"),
    modalStat(row.citations, "Citations", "good", null, "domainCitations"),
    modalStat(row.fetched, "Read-only", "muted", null, "readOnly"),
    modalStat(row.urls.size, "URLs", "accent", null, "distinctUrls"),
    modalStat(row.citedPromptIds.size, `${plural(row.citedPromptIds.size)} ${inOn}`, "accent", null, "distinctPrompts"),
  );
  body.append(stats);

  const urls = [...(row.urlList || [])].sort((a, b) =>
    b.citedPromptIds.size - a.citedPromptIds.size || b.citations - a.citations || b.fetched - a.fetched);

  body.append(el("div", { className: "modal-section-title" }, `Pages from ${row.key}`));
  body.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
    `"Cited" counts distinct ${unit}s whose answer cited the page; "read-only" counts every time it was pulled in without being cited. Expand a page to see the ${unit}s behind it — click one to open that capture in Analyze.`));

  if (!urls.length) {
    body.append(el("div", { className: "empty" }, "No individual page URLs were recorded for this domain."));
    return;
  }

  const list = el("div", { className: "url-drill" });
  urls.forEach((u) => {
    const item = el("div", { className: "url-drill-item" });
    const head = el("button", { className: "url-drill-head", title: `Show the ${unit}s this page came from` });
    const caret = el("span", { className: "url-drill-caret" }, "▸");
    head.append(
      caret,
      el("span", { className: "url-drill-url" }, u.key),
      el("span", { className: "url-drill-meta" },
        el("span", { className: "pp-chip cited", "data-tip": `Cited ${u.citations} time(s) across ${u.citedPromptIds.size} ${plural(u.citedPromptIds.size)}.` },
          `${u.citations} cited · ${u.citedPromptIds.size} ${plural(u.citedPromptIds.size)}`),
        el("span", {
          className: "pp-chip notcited", "data-tip":
            "Pulled in as a source this many times, but never cited in the written answer. This is NOT “never retrieved” — every appearance here was read; it just wasn't credited.",
        }, `${u.fetched} read-only`)),
    );
    // Clicking a row always routed into Analyze (correct — that's where the
    // captures live) with no way to just open the actual page. A sibling of
    // `head` rather than nested inside it: an <a> inside a <button> is
    // invalid HTML and click events would fight over which handler wins.
    const openExt = el("a", {
      className: "url-drill-openext", href: u.key, target: "_blank", rel: "noreferrer",
      title: "Open this page", "aria-label": `Open ${u.key} in a new tab`,
    }, "↗");
    openExt.onclick = (ev) => ev.stopPropagation();
    const headRow = el("div", { className: "url-drill-headrow" }, head, openExt);
    const runsWrap = el("div", { className: "url-drill-runs", style: "display:none" });
    [...u.runs.values()].sort((a, b) => b.capturedAt - a.capturedAt).forEach((run) => {
      const line = el("button", { className: "url-drill-run", title: "Open this capture in Analyze" });
      line.append(
        el("span", { className: "url-drill-prompt" }, run.promptText),
        el("span", { className: "url-drill-run-meta muted small" },
          engineChip(run.platform, `${ENGINES.find((e) => e.id === run.platform)?.label || run.platform} · ${new Date(run.capturedAt).toLocaleDateString(dateLocale())} · ${run.cited ? "cited" : "read-only"}`)),
      );
      line.onclick = () => { backdrop.remove(); openCapture(run.captureId); };
      runsWrap.append(line);
    });
    // A page that came from a single capture has nothing to choose between —
    // open it directly rather than making the user expand a list of one.
    if (u.runs.size === 1) {
      const only = [...u.runs.values()][0];
      caret.textContent = "→";
      head.title = "Open this capture in Analyze";
      head.onclick = () => { backdrop.remove(); openCapture(only.captureId); };
    } else {
      head.onclick = () => {
        const open = runsWrap.style.display !== "none";
        runsWrap.style.display = open ? "none" : "block";
        caret.textContent = open ? "▸" : "▾";
      };
    }
    item.append(headRow, runsWrap);
    list.append(item);
  });
  body.append(list);
}

/** "Rankings by Source URL" — which prompts pulled in this URL, whether the
 *  campaign's own brand was mentioned in that response, and every brand
 *  present. No trend chart — just the table (this URL's citation count over
 *  time isn't tracked at that granularity, and a fabricated chart would be
 *  worse than no chart). Rows open the capture in Analyze, the same as the
 *  domain drill-down. */
async function openUrlDetailModal(url, profile, since, until) {
  const { backdrop, body } = openDetailModal("Rankings by Source URL", url, { wide: true });
  body.append(el("div", { className: "muted small" }, "Loading…"));

  const r = await send({ type: "geo-url-detail", profileId: profile.id, url, tags: cbTags, engines: geoEngineFilter, since, until });
  body.textContent = "";
  if (!r.ok) { body.append(el("div", { className: "empty" }, r.error || "Couldn't load this URL's detail.")); return; }
  if (!r.rows.length) { body.append(el("div", { className: "empty" }, "No responses matched for this URL under the current filters.")); return; }

  const mentionedN = r.rows.filter((row) => row.mentioned).length;
  const citedN = r.rows.filter((row) => row.outcome === "cited").length;
  const stats = el("div", { className: "statgrid modal-statgrid" });
  stats.append(
    modalStat(r.rows.length, "Responses", "", null, "responses"),
    modalStat(new Set(r.rows.map((row) => row.promptText)).size, "Prompts", "", null, "distinctPrompts"),
    // The same page is often cited in one answer and merely read in the next,
    // so the split matters more than the total.
    modalStat(citedN, "Cited", "good", null, "citedOutcome"),
    modalStat(r.rows.length - citedN, "Read-only", "muted", null, "readOnly"),
    modalStat(mentionedN, r.hasBrand ? `${r.ownBrand} mentioned` : "You mentioned"),
  );
  body.append(stats);

  if (r.autoCompetitors && r.autoCompetitors.length) {
    body.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
      "No competitors configured — the brands below are the ones these answers named."));
  }

  body.append(el("div", { className: "modal-section-title" }, "Responses that pulled in this page"));

  const table = el("table", { className: "drill-table" });
  table.append(el("tr", {},
    el("th", {}, "Prompt"),
    el("th", {}, "Engine"),
    el("th", { "data-term": "citedOutcome" }, "Used as"),
    el("th", {}, "You"),
    el("th", { className: "num", "data-term": "avgPosition" }, "Position"),
    el("th", {}, "Brands in the answer"),
    el("th", {}, "Date")));
  r.rows.forEach((row) => {
    // Numbered, because the order brands appear in an answer is the thing the
    // ranking is about — an unordered chip row hides who led and who trailed.
    const brandChips = el("div", { className: "tagline" });
    row.brands.forEach((b, i) => brandChips.append(el("span", { className: "tag" }, `${i + 1}. ${b}`)));
    const promptCell = el("td", {});
    if (row.captureId) {
      const link = el("button", { className: "linkbtn td-domain-btn", title: "Open this capture in Analyze" }, row.promptText);
      link.onclick = () => { backdrop.remove(); openCapture(row.captureId); };
      promptCell.append(link);
    } else {
      promptCell.append(row.promptText);
    }
    table.append(el("tr", {},
      promptCell,
      el("td", {}, engineChip(row.platform, ENGINES.find((e) => e.id === row.platform)?.label || row.platform)),
      el("td", {}, el("span", { className: `pp-chip ${row.outcome === "cited" ? "cited" : "notcited"}` },
        row.outcome === "cited" ? "cited" : "read-only")),
      el("td", {}, row.mentioned == null
        ? el("span", { className: "pp-badge none" }, "—")
        : el("span", { className: `pp-badge ${row.mentioned ? "rank" : "miss"}` }, row.mentioned ? "mentioned" : "absent")),
      el("td", { className: "num" }, row.position == null ? "—" : `#${row.position}`),
      el("td", {}, brandChips),
      el("td", { className: "muted small", title: new Date(row.capturedAt).toLocaleString(dateLocale()) }, relTime(row.capturedAt)),
    ));
  });
  body.append(el("div", { className: "drill-scroll" }, table));
}

/**
 * Open the campaign's domain drill-down for one domain, from anywhere.
 *
 * The Source Domains table already has the aggregated row to hand; a link
 * elsewhere in the UI does not, so it re-derives it from the same
 * geo-prompt-performance data through the same aggregateSources() — the two
 * paths cannot report different numbers for the same domain.
 */
/* ---------- wiring ---------- */
document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    // A direct nav click is the user choosing to go here themselves, not
    // "returning" from a link — any "← Back to X" context from an earlier
    // openCapture() no longer applies once they've navigated on their own.
    // Back to the campaign an answer was opened from (0.67.0): the board is
    // still there, as it was left (section, filters, open rows, scroll), so
    // it is shown, not rebuilt. Asked for: "when they either press back or
    // click campaign they should reach exactly at the screen with the same
    // data where they were before going to analyze".
    const backToBoard = btn.dataset.tab === "loader" && returnTab === "loader" && document.querySelector(".panel.active")?.id === "analyze" && document.getElementById("cpHead");
    returnTab = null;
    // clicking the Analyze tab directly returns to the latest capture
    if (btn.dataset.tab === "analyze") { viewingId = null; apSheet = null; apMenuOpen = false; apFanAll = false; apPromptOpen = false; apTab = "overview"; atResetState(); renderAnalyze(); }
    if (btn.dataset.tab === "loader" && !backToBoard) loadGeo();
    showTab(btn.dataset.tab);
  })
);
$("#openTab").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/panel.html") })
);

// How the answer was asked (0.66.0): from a private window and/or signed
// out, which is when an engine answers without the account's history or
// memory. Nothing is shown for a normal signed-in answer.
function sessionChip(rec) {
  const s = rec && rec.session;
  if (!s) return "";
  const parts = [s.private ? "Private window" : "", s.signedIn === "out" ? "Signed out" : ""].filter(Boolean);
  if (!parts.length) return "";
  return el("span", { className: "at-chip at-chip-session", title: "Asked without a signed-in session's history or memory" }, parts.join(" · "));
}

// Pause capture (0.66.0). Asked for: "there are times when people don't
// want any record of their conversations". While paused the background
// stores nothing from an engine page; the popup, the tab and the toolbar
// icon all say so, and follow each other through storage.
function paintCaptureToggle(paused) {
  const b = document.getElementById("capToggle");
  if (!b) return;
  b.setAttribute("aria-checked", String(!paused));
  b.classList.toggle("paused", !!paused);
  b.querySelector(".cap-label").textContent = tr(paused ? "Paused" : "Capturing");
  b.title = tr(paused
    ? "Capture is paused: nothing from ChatGPT, Gemini, Perplexity or Grok is being kept. A campaign run still records its own tabs. Click to capture again."
    : "Capturing your engine chats. Click to pause.");
  document.body.classList.toggle("capture-paused", !!paused);
}
$("#capToggle")?.addEventListener("click", async () => {
  const paused = !document.getElementById("capToggle").classList.contains("paused");
  paintCaptureToggle(paused);
  const r = await send({ type: "settings-set", patch: { capturePaused: paused } });
  if (!r || !r.ok) { paintCaptureToggle(!paused); showToast("Couldn't change capture.", "error"); return; }
  showToast(paused ? "Capture paused. Nothing from your chats is kept until you turn it back on." : "Capturing again.");
});
send({ type: "settings-get" }).then((r) => paintCaptureToggle(!!(r && r.settings && r.settings.capturePaused))).catch(() => {});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lcfcSettings) paintCaptureToggle(!!((changes.lcfcSettings.newValue || {}).capturePaused));
  });
} catch (_) { /* no storage events in this context */ }

// Light or dark, kept in this browser (the popup and the full tab share it).
// Picked in About → Settings since 0.56.0; the top bar's button went, as on
// the canvas.
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll("#setTheme [data-theme-pick]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themePick === theme)));
}
function initTheme() {
  let current = "light";
  try { current = localStorage.getItem("cito-theme") || "light"; } catch (_) {}
  applyTheme(current);
}
document.querySelectorAll("#setTheme [data-theme-pick]").forEach((b) => b.addEventListener("click", () => {
  const next = b.dataset.themePick;
  applyTheme(next);
  try { localStorage.setItem("cito-theme", next); } catch (_) {}
}));
// Studio or Classic (0.59.0), the same way: kept in this browser, applied at
// once, outside Save / Undo. theme-boot.js already set it before the first
// paint; this keeps the Settings radios and the other view in step.
const STYLES = ["studio", "classic"];
function applyStyle(style) {
  const next = STYLES.includes(style) ? style : "studio";
  document.documentElement.setAttribute("data-style", next);
  document.querySelectorAll("#setStyle [data-style-pick]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.stylePick === next)));
}
function initStyle() {
  let current = "studio";
  try { current = localStorage.getItem("cito-style") || "studio"; } catch (_) {}
  applyStyle(current);
}
document.querySelectorAll("#setStyle [data-style-pick]").forEach((b) => b.addEventListener("click", () => {
  const next = b.dataset.stylePick;
  applyStyle(next);
  try { localStorage.setItem("cito-style", next); } catch (_) {}
}));
// Level of detail (0.60.0): Simple, or Expert, which adds the engine's raw
// ids, indexes and refs (.x-only) and the Raw tab in Details. Kept and
// applied like the theme; Analyze re-renders so its tabs follow.
function applyDetail(detail) {
  const next = detail === "expert" ? "expert" : "simple";
  const changed = document.documentElement.getAttribute("data-detail") !== next;
  document.documentElement.setAttribute("data-detail", next);
  document.querySelectorAll("[data-detail-pick]").forEach((b) => {
    const on = b.dataset.detailPick === next;
    b.setAttribute(b.getAttribute("role") === "radio" ? "aria-checked" : "aria-pressed", String(on));
    b.classList.toggle("on", on);
  });
  document.querySelectorAll("[data-detail-switch]").forEach((b) => {
    b.setAttribute("aria-checked", String(next === "expert"));
    b.classList.toggle("on", next === "expert");
  });
  return changed;
}
function setDetail(next) {
  try { localStorage.setItem("cito-detail", next); } catch (_) { /* storage off: this view only */ }
  if (applyDetail(next) && viewingRecord()) renderAnalyze();
}
// The record Analyze is showing, if it has rendered one.
function viewingRecord() { return !!document.querySelector("#analyze .at-grid, #analyze .ap"); }
function initDetail() {
  let current = "simple";
  try { current = localStorage.getItem("cito-detail") || "simple"; } catch (_) {}
  applyDetail(current);
}
document.querySelectorAll("#setDetail [data-detail-pick]").forEach((b) => b.addEventListener("click", () => setDetail(b.dataset.detailPick)));
// Motion on or off (0.78.0), applied at once in both views (display-boot.js).
function showMotion() {
  let m = "on";
  try { m = localStorage.getItem("cito-motion") === "off" ? "off" : "on"; } catch (_) {}
  document.querySelectorAll("#setMotion [data-motion-pick]").forEach((b) => { const on = b.dataset.motionPick === m; b.setAttribute("aria-checked", String(on)); b.classList.toggle("on", on); });
  return m;
}
function setMotion(m) {
  try { localStorage.setItem("cito-motion", m); } catch (_) { /* this view only */ }
  globalThis.CitoDisplay?.applyMotion(document, m);
  showMotion();
}
document.querySelectorAll("#setMotion [data-motion-pick]").forEach((b) => b.addEventListener("click", () => setMotion(b.dataset.motionPick)));
showMotion();
// The settings groups remember whether they were open (0.78.0).
(() => {
  let open = {};
  try { open = JSON.parse(localStorage.getItem("cito-settings-open") || "{}") || {}; } catch (_) {}
  document.querySelectorAll("details.ab-group[data-group]").forEach((d) => {
    if (typeof open[d.dataset.group] === "boolean") d.open = open[d.dataset.group];
    d.addEventListener("toggle", () => {
      open[d.dataset.group] = d.open;
      try { localStorage.setItem("cito-settings-open", JSON.stringify(open)); } catch (_) { /* per view */ }
    });
  });
})();
// The other view (popup or tab) follows a change made here.
window.addEventListener("storage", (e) => {
  if (e.key === "cito-theme" && e.newValue) applyTheme(e.newValue);
  if (e.key === "cito-motion") { globalThis.CitoDisplay?.applyMotion(document, e.newValue || "on"); showMotion(); }
  if (e.key === "cito-style" && e.newValue) applyStyle(e.newValue);
  if (e.key === "cito-detail" && e.newValue && applyDetail(e.newValue) && viewingRecord()) renderAnalyze();
  // The other view (popup or tab) follows a language change.
  if (e.key === "cito-lang") location.reload();
});
initTheme();
initStyle();
initDetail();
initDisplaySettings(document.getElementById("setDisplay"));
(() => {
  const sel = document.getElementById("setLang");
  if (!sel) return;
  let pref = "auto";
  try { pref = localStorage.getItem(LANG_KEY) || "auto"; } catch (_) { /* storage off */ }
  sel.append(el("option", { value: "auto" }, `${tr("Same as the browser")} (${(LANGS.find(([c]) => c === chosenLang({ getItem: () => "auto" })) || LANGS[0])[1]})`));
  // The translations are drafts until a native speaker has read them
  // (1.0.0): said in the picker, in English so it reads the same everywhere.
  LANGS.forEach(([code, name]) => sel.append(el("option", { value: code, lang: code }, code === "en" ? name : `${name} (beta)`)));
  sel.value = pref;
  sel.onchange = () => { try { localStorage.setItem(LANG_KEY, sel.value); } catch (_) { /* this view only */ } location.reload(); };
})();
initAiSettings(document.getElementById("setAi"));

$("#exportJson")?.addEventListener("click", () =>
  download(`citoskeleton-export-${Date.now()}.json`, JSON.stringify(currentFilteredRecs, null, 2), "application/json")
);
$("#exportExcel")?.addEventListener("click", () => {
  if (!currentFilteredRecs.length) return showToast("No data to export", "error");
  
  // Generate HTML table for Excel
  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="utf-8" /></head>
    <body>
      <table border="1">
        <thead>
          <tr style="background-color: #f1f5f9; color: #0f172a; font-weight: bold;">
            <th style="width: 150px">Date</th>
            <th style="width: 120px">Platform</th>
            <th style="width: 300px">User Prompt</th>
            <th style="width: 80px">Has Search</th>
            <th style="width: 300px">Sources</th>
            <th style="width: 300px">Fan-Out Queries</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  const platformColors = {
    chatgpt: "#e0f2fe",
    gemini: "#fce7f3",
    perplexity: "#fef3c7",
    grok: "#d1fae5"
  };

  currentFilteredRecs.forEach(r => {
    const bg = platformColors[r.platform] || "#ffffff";
    const srcText = r.sources.map(s => `[${s.outcome}] ${s.domain}`).join(", ");
    const fan = [...(r.fanout?.search || []), ...(r.fanout?.shopping || []), ...(r.fanout?.image || [])];
    const fanText = fan.map((f) => (typeof f === "string" ? f : f?.query || "")).filter(Boolean).join(" | ");
    
    html += `
      <tr style="background-color: ${bg};">
        <td>${new Date(r.capturedAt).toLocaleString(dateLocale())}</td>
        <td>${r.platform || "chatgpt"}</td>
        <td>${sanitizeText(r.userPrompt || "")}</td>
        <td>${r.searched ? "Yes" : "No"}</td>
        <td>${sanitizeText(srcText)}</td>
        <td>${sanitizeText(fanText)}</td>
      </tr>
    `;
  });
  
  html += `</tbody></table></body></html>`;
  download(`citoskeleton-audit-${Date.now()}.xls`, html, "application/vnd.ms-excel");
});

function fmtBytes(n) {
  if (n == null) return "?";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/*
 * Assembles a LOCAL-ONLY diagnostic summary — extension/browser info,
 * storage counts, and campaign run history (timing, outcome counts, and
 * the failure-reason histogram background.js's syncGeoRun() now keeps on
 * every geoRuns record) — for the "let the developer know something's
 * wrong" case the reliability/status work surfaced a real need for.
 * Deliberately excludes prompt text, answer content, URLs, and brand
 * names: those never cross this function at all, only counts/timestamps/
 * short fixed reason labels do. Built for the user to review (in the modal
 * below) and copy themselves into a bug report or email — nothing here is
 * ever transmitted automatically, matching the rest of the extension's
 * local-only design.
 */
async function buildDiagnosticReport() {
  const manifest = chrome.runtime.getManifest();
  const [statsRes, runsRes, buildRes, netRes] = await Promise.all([
    send({ type: "stats" }),
    send({ type: "geo-run-list" }), // no profileId = every campaign's runs
    send({ type: "build-info" }),
    send({ type: "get-netlog" }),
  ]);

  const lines = [];
  lines.push(`${/^__MSG_/.test(manifest.name) ? (chrome.i18n.getMessage("appName") || "CitoSkeleton") : manifest.name} diagnostic report`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Extension version: ${manifest.version}`);
  // The manifest can say one version while older code actually runs — see
  // lib/build.js. Both builds are printed so a half-updated install is plain
  // from the first lines of any report, instead of being inferred from
  // capture fingerprints after a wasted run.
  const bgBuild = buildRes && buildRes.ok ? buildRes.build : "older than 0.42.0 (doesn't report a build)";
  lines.push(`Code builds: interface ${BUILD} · background ${bgBuild}${bgBuild === BUILD ? "" : "  ← MISMATCH: reload the extension"}`);
  lines.push(`Browser: ${navigator.userAgent}`);
  lines.push("");
  lines.push("Storage");
  if (statsRes.ok) {
    lines.push(`  Raw captures: ${statsRes.raw}`);
    lines.push(`  Derived captures: ${statsRes.derived}`);
    if (statsRes.usage) lines.push(`  Usage: ${fmtBytes(statsRes.usage.usedBytes)} of ~${fmtBytes(statsRes.usage.quotaBytes)}`);
  } else {
    lines.push(`  (couldn't load — ${statsRes.error || "unknown error"})`);
  }
  lines.push("");
  lines.push("Campaign runs (most recent 20)");
  if (runsRes.ok && runsRes.runs.length) {
    runsRes.runs.slice(0, 20).forEach((run) => {
      const dur = run.finishedAt ? fmtDuration(runTookMs(run)) : "still running / never finished";
      lines.push(`  ${new Date(run.startedAt).toISOString()} · ${run.status} · ${(run.engines || []).join("+") || "—"} · ${run.captured || 0}/${run.expected || 0} captured${run.failed ? `, ${run.failed} failed` : ""} · took ${dur}`);
      const reasonEntries = Object.entries(run.reasons || {});
      if (reasonEntries.length) {
        lines.push(`      failure reasons — ${reasonEntries.map(([r, n]) => `${r}: ${n}`).join(", ")}`);
      }
      // By engine (0.78.1), so a reason says where it happened.
      for (const [e, rs] of Object.entries(run.reasonsBy || {})) {
        lines.push(`        ${e} — ${Object.entries(rs).map(([r, n]) => `${r}: ${n}`).join(", ")}`);
      }
    });
  } else if (runsRes.ok) {
    lines.push("  No campaign runs yet.");
  } else {
    lines.push(`  (couldn't load — ${runsRes.error || "unknown error"})`);
  }
  lines.push("");
  // What the engine pages called (0.62.0): which request carries the answer
  // when an engine stops being captured. Only with Debug capture on.
  lines.push(...netlogReportLines(netRes && netRes.ok ? netRes.entries || [] : []));
  lines.push("");
  lines.push("This report contains no prompt text, answer content, full addresses, or brand names — only counts, timing, short failure-reason labels and, from Debug capture, the hosts and paths engine pages called with ids masked, query values dropped and response key names only.");
  return lines.join("\n");
}

/*
 * Report a problem with THIS capture — the 💬 in the Analyze top bar.
 *
 * Where to send it. Set FEEDBACK_TO to the address you want reports at
 * BEFORE building a public release: with it set the dialog offers "Open email
 * draft" (subject and body prefilled, the archive attached by the reporter);
 * left empty it just says to send the saved file to the developer, so a build
 * with no address configured still works and never mails anyone by accident.
 * It is a build-time constant rather than a setting because it has to travel
 * with the copy you hand out — a per-user setting would only ever hold the
 * address on YOUR machine.
 */
const FEEDBACK_TO = "contact@oshwetank.com";

async function openFeedbackModal(rec) {
  const existing = document.getElementById("feedback-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "feedback-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content diag-modal" });
  const header = el("div", { className: "modal-header" });
  header.append(el("h3", { style: "margin:0;font-size:15px;color:var(--fg-primary);" }, "Report a problem with this capture"));
  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  header.append(closeBtn);
  modal.append(header);

  const body = el("div", { className: "modal-body" });
  body.append(el("p", { className: "muted small" },
    "One click bundles everything needed and hands it to your email. On some systems your mail app opens " +
    "with the file already attached; otherwise the file is saved and the draft tells you to attach it. " +
    "Nothing is sent from here — you choose what goes in, and you send it."));

  const note = el("textarea", {
    className: "diag-report-text",
    rows: 4,
    id: "feedbackNote",
    placeholder: "What looked wrong, and what you expected instead? (e.g. \"the brand list shows a feature name instead of the brands\")",
  });
  body.append(note);

  // Unlike the About tab's diagnostic report, this bundle carries real
  // content. Say so, itemised, with a way to leave any part out.
  body.append(el("p", { className: "small", style: "margin:12px 0 6px;font-weight:500;color:var(--fg-primary);" },
    "What gets included"));
  const boxes = {};
  const list = el("div", { style: "display:flex;flex-direction:column;gap:8px;" });
  for (const part of BUNDLE_PARTS) {
    const row = el("label", { className: "small", style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer;" });
    const cb = el("input", { type: "checkbox", checked: true, style: "margin-top:2px;flex-shrink:0;" });
    if (part.key === "note") { cb.checked = true; cb.disabled = true; }
    boxes[part.key] = cb;
    row.append(cb, el("span", {},
      el("span", { style: "font-weight:500;color:var(--fg-primary);" }, part.label),
      el("span", { className: "muted" }, ` — ${part.detail}`)));
    list.append(row);
  }
  body.append(list);

  const status = el("p", { className: "muted small", style: "margin-top:12px;min-height:18px;" }, "");
  body.append(status);
  modal.append(body);

  const footer = el("div", { className: "modal-footer" });
  const sendBtn = el("button", { className: "btn sm primary" }, "📎 Send with everything attached");
  const saveBtn = el("button", { className: "btn sm ghost" }, "💾 Just save the file");
  const hint = el("span", { className: "muted small", style: "margin-left:8px;" },
    FEEDBACK_TO ? `Goes to ${FEEDBACK_TO}.` : "");

  // Built once, on demand, and reused by both buttons so the summary in the
  // mail draft always describes the file that was actually saved.
  let built = null;
  const buildFiles = async () => {
    const include = { report: boxes.report.checked, raw: boxes.raw.checked, analysis: boxes.analysis.checked };
    status.textContent = "Collecting…";
    // The record in hand may be a LIGHT row; the report and the analysis are
    // both worthless without answerText, so hydrate exactly as the export
    // path does.
    let full = rec;
    try { full = (await hydrate(rec.captureId)) || rec; } catch (_) { /* keep what we have */ }

    let reportHtml = "";
    if (include.report) {
      try {
        reportHtml = renderStandaloneHtml([buildExportModel(full)], {
          docTitle: full.userPrompt || "CitoSkeleton capture",
        });
      } catch (err) {
        reportHtml = "";
        include.report = false;
      }
    }

    let raw = "";
    if (include.raw) {
      try {
        const r = await send({ type: "get-raw", captureId: full.captureId });
        if (r && r.ok && r.raw != null) raw = formatRawCapture(full.captureId, r.meta, r.raw);
        // Every copy this answer was merged from (lib/sameAnswer.js), not just
        // the first: a Grok answer held five, and the one sent alone couldn't
        // show where 65 sources became 55 (0.62.1).
        for (const id of full.mergedFrom || []) {
          const m = await send({ type: "get-raw", captureId: id });
          if (m && m.ok && m.raw != null) raw += `\n\n${formatRawCapture(id, m.meta, m.raw)}`;
        }
      } catch (_) { /* a capture whose raw was pruned still sends the rest */ }
      if (!raw) include.raw = false;
    }

    const manifest = chrome.runtime.getManifest();
    built = {
      files: buildFeedbackFiles({
        note: note.value,
        record: full,
        raw,
        reportHtml,
        env: { version: manifest.version, userAgent: navigator.userAgent },
        include,
      }),
      name: bundleFilename(full),
      record: full,
    };
    return built;
  };

  const saveZip = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const b = await buildFiles();
      saveZip(await makeZip(b.files), b.name);
      status.textContent = `Saved ${b.name} — ${b.files.length} file${b.files.length === 1 ? "" : "s"} inside.`;
    } catch (err) {
      status.textContent = `Couldn't build the file: ${(err && err.message) || err}`;
    } finally {
      saveBtn.disabled = false;
    }
  };

  /*
   * One button that does the whole job, because the reporter should not have
   * to know WHAT to attach — that was the point of bundling in the first place.
   *
   * mailto: cannot carry an attachment. That is the URI scheme itself
   * (RFC 6068 defines no attachment field, and browsers drop unknown
   * headers), not a gap in this code, so "open a draft with the files on it"
   * is not available anywhere. What IS available is the OS share sheet:
   * navigator.share() accepts real File objects, and Mail is one of its
   * targets — that route hands the archive over already attached, no
   * attaching step for the reporter at all. It is not on every platform, so
   * it is asked for and used when the answer is yes.
   *
   * Where it is not, the fallback does everything except the one action a
   * page is not allowed to perform for you: it builds the archive, saves it,
   * opens the addressed draft with the note already in the body, and then
   * says in plain words which file to attach and where it is. That is one
   * click and one drag, and nothing to understand.
   */
  sendBtn.onclick = async () => {
    sendBtn.disabled = true;
    const restore = () => { sendBtn.disabled = false; };
    try {
      const b = await buildFiles();
      const blob = await makeZip(b.files);
      const subject = `CitoSkeleton feedback — ${b.record.platform || "capture"}`;
      const bodyText = (b.files.find((f) => f.name === "feedback.txt") || {}).text || "";

      const file = new File([blob], b.name, { type: "application/zip" });
      const canShareFile = typeof navigator.canShare === "function" &&
        typeof navigator.share === "function" &&
        navigator.canShare({ files: [file] });

      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: subject, text: bodyText.slice(0, 1500) });
          status.textContent = "Handed to your share sheet with the file attached — pick Mail and send.";
          restore();
          return;
        } catch (err) {
          // A cancelled share sheet is not a failure; anything else falls
          // through to the save-and-draft route rather than dead-ending.
          if (err && err.name === "AbortError") { status.textContent = "Cancelled."; restore(); return; }
        }
      }

      saveZip(blob, b.name);
      if (FEEDBACK_TO) {
        // The instruction goes at the TOP OF THE DRAFT, not only in the
        // dialog behind it. By the time the reporter is looking at their mail
        // client this panel is out of sight, and the one thing still left for
        // them to do lives here — named file, named folder, and why it
        // matters, so it does not read as an optional extra.
        const attachLine =
          `[ Please attach the file "${b.name}" from your Downloads folder before sending. ]
` +
          `[ It was just saved there, and it holds everything needed to diagnose this — ]
` +
          `[ without it this report cannot be investigated.                              ]

`;
        const href = `mailto:${encodeURIComponent(FEEDBACK_TO)}?subject=${encodeURIComponent(subject)}` +
                     `&body=${encodeURIComponent(attachLine + bodyText.slice(0, 1200))}`;
        window.open(href, "_blank");
        status.textContent = `Draft opened to ${FEEDBACK_TO}. A browser is not allowed to attach a file to an email ` +
          `for you, so one step is left: attach “${b.name}” from your Downloads folder, then send. ` +
          `The draft says the same thing at the top.`;
      } else {
        status.textContent = `Saved “${b.name}” to your Downloads folder. Email that one file to the developer.`;
      }
    } catch (err) {
      status.textContent = `Couldn't build the file: ${(err && err.message) || err}`;
    } finally {
      restore();
    }
  };

  footer.append(sendBtn, saveBtn, hint);
  modal.append(footer);

  backdrop.append(modal);
  document.body.append(backdrop);
  closeBtn.onclick = wireModalDismiss(backdrop, modal);
  note.focus();
}

async function openDiagnosticReportModal() {
  const existing = document.getElementById("diag-modal-backdrop");
  if (existing) existing.remove();

  const backdrop = el("div", { id: "diag-modal-backdrop", className: "modal-backdrop" });
  const modal = el("div", { className: "modal-content diag-modal" });
  const header = el("div", { className: "modal-header" });
  header.append(el("h3", { style: "margin:0;font-size:15px;color:var(--fg-primary);" }, "Diagnostic report"));
  const closeBtn = el("button", { className: "modal-close-btn", title: "Close" }, "×");
  header.append(closeBtn);
  modal.append(header);

  const body = el("div", { className: "modal-body" });
  body.append(el("p", { className: "muted small" },
    "Review before copying — nothing here is sent anywhere automatically. Paste this into a GitHub issue or an email yourself."));
  const textarea = el("textarea", { readOnly: true, className: "diag-report-text", rows: 16 }, "Loading…");
  body.append(textarea);
  modal.append(body);

  const footer = el("div", { className: "modal-footer" });
  const copyBtn = el("button", { className: "btn sm primary" }, "📋 Copy to clipboard");
  const copyStatus = el("span", { className: "muted small", style: "margin-left:8px" }, "");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      copyStatus.textContent = "Copied!";
    } catch (_) {
      // Clipboard permission can be denied/unavailable — the text is
      // already right there and selected, so a manual copy still works.
      textarea.select();
      copyStatus.textContent = "Couldn't auto-copy — text is selected, press Ctrl/Cmd+C.";
    }
    setTimeout(() => { copyStatus.textContent = ""; }, 3000);
  };
  footer.append(copyBtn, copyStatus);
  modal.append(footer);

  backdrop.append(modal);
  document.body.append(backdrop);
  closeBtn.onclick = wireModalDismiss(backdrop, modal);

  textarea.value = await buildDiagnosticReport();
}

$("#diagReport")?.addEventListener("click", () => openDiagnosticReportModal());

// Payloads it couldn't read (0.62.1): Gemini replies kept as probes with
// Debug capture on, one file each, for the owner to look at and send.
$("#probeSave")?.addEventListener("click", async () => {
  const r = await send({ type: "get-probes" });
  const probes = (r && r.ok && r.probes) || [];
  if (!probes.length) { showToast("Nothing kept yet. Turn on Debug capture, reload Gemini or ChatGPT and ask a prompt.", "error"); return; }
  const files = probes.map((p, i) => {
    let where = "";
    try { const u = new URL(p.url); where = `${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, "_").slice(0, 80); } catch (_) { where = "unknown"; }
    return { name: `probes/${String(i + 1).padStart(2, "0")}-${where}.txt`, text: [`# url: ${p.url}`, `# method: ${p.method}`, `# page: ${p.pageUrl}`, `# at: ${new Date(p.at).toISOString()}`, `# reqBody: ${p.reqBody}`, "", p.body].join("\n") };
  });
  const zip = await makeZip([{ name: "README.txt", text: `CitoSkeleton ${BUILD}: ${probes.length} replies Gemini or ChatGPT sent with Debug capture on, which this build can't read yet.\nThey include your prompt and the answer. Look before you send.\n` }, ...files]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(zip);
  a.download = `citoskeleton-unread-${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`${probes.length} payloads saved.`);
});

const reprocessBtn = $("#reprocess");
reprocessBtn?.addEventListener("click", withBusy(reprocessBtn, "Reprocessing…", async () => {
  const st = $("#reprocessStatus");
  if (st) st.textContent = "";
  const r = await send({ type: "reprocess-all" });
  if (st) {
    st.textContent = !r.ok ? "Reprocessing failed." : r.reprocessed === r.total
      ? `Done. ${r.reprocessed.toLocaleString(uiLang())} capture${r.reprocessed === 1 ? "" : "s"} re-read.`
      : `Done. ${r.reprocessed.toLocaleString(uiLang())} of ${r.total.toLocaleString(uiLang())} captures re-read.`;
    st.classList.toggle("bad", !r.ok);
  }
  FULL.clear(); // records were re-derived; drop stale hydrated copies
  load();
}));

$("#deleteFiltered")?.addEventListener("click", async () => {
  if (!currentFilteredRecs.length) return;
  if (!confirm(`Delete ${currentFilteredRecs.length} filtered conversations? This cannot be undone.`)) return;
  
  const st = $("#status");
  if (st) st.textContent = "Deleting...";
  for (const r of currentFilteredRecs) {
    await send({ type: "delete-record", captureId: r.captureId });
  }
  if (st) st.textContent = "Deleted successfully.";
  load();
});

/* ---------- Campaigns run status ---------- */
// mm:ss for a duration; "<1s" for anything under a second so a fast turn
// doesn't read as "0s" (which looks broken, not fast).
function fmtDuration(ms) {
  return formatDuration(ms);
}

const PROMPT_STATUS_ICON = { done: "✓", failed: "✕", running: "●", pending: "…" };
const PROMPT_STATUS_LABEL = { done: "Done", failed: "Failed", running: "Running", pending: "Pending" };

// Tracks running -> not-running so the "finished" banner fires exactly once,
// right when this popup/tab first notices the transition — not on every
// 1.5s poll tick while the finished state is being displayed. Deliberately
// NOT what gates clearing the toolbar badge (see loaderAckedRunId below):
// a popup that's closed while a campaign runs — the normal case, since a
// run can take minutes and nobody leaves the popup open for that — would
// never observe a live running->finished transition at all, and the badge
// would stay stuck forever.
let loaderWasRunning = false;
// The runId last acknowledged (badge cleared for), so loader-ack-complete
// fires once per finished run per popup lifetime rather than on every poll
// tick while an idle/finished state keeps being displayed.
let loaderAckedRunId = null;

// Rebuilt into a live per-engine/per-prompt panel — previously this showed
// only a coarse done/total count and one truncated "now:" string that
// silently dropped every engine but the first with something in flight (see
// background.js's loaderStatus() for where that data now actually comes
// from). Full DOM rebuild on every poll tick, same tradeoff the rest of
// this app already makes (see the withScrollPreserved note) — the status
// box is small enough that this is cheap.
function renderLoaderStatus(s) {
  const box = $("#loaderStatus");
  if (!box) return;
  // Each engine's prompt list is its own scroll box (.loader-prompt-rows,
  // max-height 180px), and this whole status block is rebuilt on every 1.5s
  // poll — so each list came back as a new element scrolled to the top.
  // Reported as "if i scroll down they automatically scroll up after 2 sec".
  // withScrollPreserved around the poll only holds the PAGE's scroller, not
  // these; they're carried across the rebuild here, keyed by engine.
  const listScroll = {};
  box.querySelectorAll(".loader-prompt-rows[data-plat]").forEach((r) => { listScroll[r.dataset.plat] = r.scrollTop; });
  // The cooldown banner has a slide-in entrance (panelFadeIn: 4px down, then
  // up). Rebuilt every poll, it replayed that slide every 1.5s — reported as
  // "the box which shows the time is going up and down". It animates when it
  // first appears; a refresh of one already showing keeps it still.
  const hadCooldownBanner = !!box.querySelector(".cooldown-banner");
  box.textContent = "";
  const wasLive = cpLive.live;
  const wasProfile = cpLive.profileId;
  // Paused means the user pressed Pause; one engine cooling down while the
  // others run is shown on that engine (userPaused is absent from a worker
  // older than this page, so fall back to paused).
  const userPaused = s && (s.userPaused !== undefined ? s.userPaused : s.paused);
  cpLive = { live: !!(s && s.total && s.running), paused: !!(s && s.running && userPaused), profileId: (s && s.running && s.profileId) || null };
  // The run just ended: its campaign's page, held still while it ran, is
  // drawn once with the finished run on the board.
  if (wasLive && !cpLive.live && wasProfile && geoActive() && geoActive().id === wasProfile) setTimeout(() => loadGeo(), 0);
  // The run history is drawn once per render; when a run ends, redraw it so
  // it doesn't keep saying "Running".
  if (wasLive && !cpLive.live) {
    const old = document.getElementById("runHistory");
    const p = geoActive();
    if (old && p) old.replaceWith(renderRunHistory(p));
  }
  const cpHead = document.getElementById("cpHead");
  if (cpHead) {
    const ours = cpLive.live && cpHead.dataset.profileId === cpLive.profileId;
    cpHead.classList.toggle("live", ours);
    cpHead.classList.toggle("paused", ours && cpLive.paused);
  }
  if (!s || !s.total) { loaderWasRunning = false; return; }

  if (!s.running) {
    if (loaderWasRunning) {
      // Only shown when THIS popup instance actually watched the run go
      // running -> finished live — a nice-to-have flourish, not the primary
      // "you missed something" signal (that's the badge, acked below).
      const succeeded = s.done, total = s.total, failed = s.errors;
      const banner = el("div", { className: `loader-finished-banner ${failed ? "has-errors" : ""}` },
        el("b", {}, failed ? "Campaign finished with errors — " : "Campaign finished — "),
        `${succeeded} of ${total} succeeded${failed ? `, ${failed} failed` : ""}.`);
      box.append(banner);
    }
    // Clearing the badge does NOT depend on having watched that transition —
    // opening the Campaigns tab to any finished-run state at all means the
    // result has now been shown, whether that's seconds or hours after the
    // run actually finished. Deduped per runId so this fires once, not on
    // every 1.5s poll tick while this idle state keeps being redisplayed.
    if (s.runId && loaderAckedRunId !== s.runId) {
      send({ type: "loader-ack-complete" });
      loaderAckedRunId = s.runId;
    }
    loaderWasRunning = false;
    return;
  }
  loaderWasRunning = true;

  const state = cpLive.paused ? "Paused" : "Running";
  const summary = el("div", { className: "loader-summary" },
    el("b", {}, state), ` — ${s.done}/${s.total} done`,
    s.activeMs ? el("span", { className: "muted loader-active" }, ` · running ${fmtDuration(s.activeMs)}`) : "",
    s.errors ? el("span", { className: "loader-errcount" }, ` · ${s.errors} failed`) : "",
    s.etaMs != null ? el("span", { className: "muted" }, ` · ~${fmtDuration(s.etaMs)} remaining`) : (s.paused ? "" : el("span", { className: "muted" }, " · estimating time remaining…")));
  box.append(summary);

  /* When to come back.
   *
   * Reported: "I don't get to know when all the prompts will finish running."
   * A duration alone ("~2h 40m remaining") still leaves the user doing
   * arithmetic against a wall clock to answer the question they actually
   * have. This states the finishing time outright, and names the day when it
   * is not today — a thousand-prompt run genuinely can land tomorrow, and
   * "4:15" with no date would be read as four hours from now, not sixteen.
   *
   * Only shown while actually running: a paused run's finish time is a
   * function of when the user resumes, so any figure here would be a lie.
   */
  if (!s.paused && s.etaAt) {
    const finish = new Date(s.etaAt);
    const now = new Date();
    const sameDay = finish.toDateString() === now.toDateString();
    const tomorrow = new Date(now.getTime() + 86400000).toDateString() === finish.toDateString();
    const clock = finish.toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });
    const when = sameDay ? clock
      : tomorrow ? `${clock} tomorrow`
      : `${clock} on ${finish.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" })}`;
    box.append(el("div", { className: "loader-finish" },
      el("span", { className: "loader-finish-icon" }, "🕒"),
      el("span", {}, "Expected to finish around "), el("b", {}, when),
      el("div", { className: "muted small" },
        "Based on how fast this run's prompts have actually been finishing, failed ones and pauses included. You can close this panel — the run keeps going, and you'll get a notification when it's done.")));
  }

  /* Why it's paused, when it wasn't the user who paused it.
   *
   * Two things now pause a run on their own: the engine reporting a usage
   * limit, and the browser (or the automated tab) being closed mid-run. Both
   * are recoveries rather than failures — nothing is lost and Resume picks up
   * exactly where it stopped — but without saying so, the run just reads as
   * "Paused" with no explanation, which looks identical to it having broken.
   * The reassurance that no prompts were lost is the point: the alternative
   * behaviour users had before was those prompts being marked failed.
   */
  if (s.interrupted) {
    const it = s.interrupted;
    const isLimit = it.reason === "rate limit";
    const who = ENGINES.find((e) => e.id === it.platform)?.label || "The engine";
    const remaining = Math.max(0, (s.total || 0) - (s.done || 0) - (s.errors || 0));
    // A rate limit only pauses the engine that hit it (background.js scopes
    // it to that platform's legs) — a sibling engine with its own account
    // keeps going. Say so, otherwise this reads as the whole run having
    // stopped when it might only be one of two engines.
    const others = isLimit
      ? Object.entries(s.platStats || {}).filter(([p, ps]) => p !== it.platform && !ps.paused && ps.done < ps.total)
      : [];
    const othersNote = others.length
      ? ` ${others.map(([p]) => ENGINES.find((e) => e.id === p)?.label || p).join(" and ")} ${others.length > 1 ? "are" : "is"} still running.`
      : "";

    if (isLimit && it.autoResumeAt && it.autoResumeAt > Date.now()) {
      const diff = it.autoResumeAt - Date.now();
      const banner = el("div", { className: "cooldown-banner" },
        el("div", {},
          el("b", {}, `⏳ Auto-Cooldown: ${who} limit reached — `),
          `Resuming in `,
          el("span", { className: "cooldown-badge" }, formatCooldown(diff)),
          el("div", { className: "small muted" }, `The runner will wake up and resume automatically.${othersNote}`)
        ),
        el("button", { className: "btn primary small", style: "flex-shrink:0" }, "Resume Now")
      );
      // Same as the header's Resume (this called a `refresh` that only
      // exists inside another function, so the button threw instead).
      banner.querySelector("button").onclick = async () => {
        const r = await send({ type: "loader-resume" });
        if (!r || r.ok === false) { showToast(r?.error || "Couldn't resume the run.", "error"); return; }
        withScrollPreserved(() => renderLoaderStatus(r));
      };
      if (hadCooldownBanner) banner.style.animation = "none";
      box.append(banner);
    } else {
      const note = el("div", { className: "loader-interrupted" },
        el("b", {}, isLimit ? `⏸ ${who} paused — usage limit reached` : "⏸ Paused — interrupted"),
        el("div", { className: "small" },
          isLimit
            ? `${who} reported a limit${it.detail ? `: “${it.detail}”` : ""}. `
            : `${it.reason || "The run was interrupted"}. `,
          `No prompts were lost — ${remaining} still queued. Press Resume to continue`,
          isLimit ? ` once the limit clears.${othersNote}` : "; the tab will be reopened for you."),
        it.at ? el("div", { className: "muted small" }, `Paused at ${new Date(it.at).toLocaleString(dateLocale())}`) : "");
      box.append(note);
    }
  }

  const kpis = el("div", { className: "geo-kpis loader-kpis" });
  for (const [plat, ps] of Object.entries(s.platStats || {})) {
    const label = ENGINES.find((e) => e.id === plat)?.label || plat;
    const sub = [];
    if (ps.failed) sub.push(`${ps.failed} failed`);
    // One "now:" line per concurrent tab. With CONCURRENT_TABS_PER_ENGINE
    // running (src/lib/pacing.js) a platform can have more than one prompt
    // in flight at once, and showing only the first would make a run that is
    // genuinely working two prompts at a time read as stuck on one — the
    // legs array is what makes the second tab's progress visible at all.
    // `ps.legs` is guarded rather than assumed: a status object built by
    // hand (older persisted shape, or a test fixture) may not carry it.
    const activeLegs = (ps.legs || []).filter((l) => l.current);
    if (activeLegs.length) {
      for (const l of activeLegs) {
        // The real time this prompt has taken so far (0.79.0), and past its
        // limit it says so instead of freezing at "1m 30s/1m 30s".
        const elapsed = l.elapsedMs == null ? ""
          : l.elapsedMs > l.turnTimeoutMs ? `${fmtDuration(l.elapsedMs)}, past its ${fmtDuration(l.turnTimeoutMs)} limit`
          : `${fmtDuration(l.elapsedMs)} of ${fmtDuration(l.turnTimeoutMs)}`;
        const tag = activeLegs.length > 1 ? `tab ${l.tab}: ` : "";
        sub.push(`${tag}"${l.current.slice(0, 28)}${l.current.length > 28 ? "…" : ""}"${elapsed ? ` (${elapsed})` : ""}`);
      }
    } else if (ps.done >= ps.total) {
      sub.push("done");
    }
    // A rate limit now pauses only the engine that hit it (see
    // loader-rate-limited in background.js) — this tile is where that
    // becomes visible per engine, since the KPI row is the only place
    // showing each platform on its own rather than the run as a whole.
    if (ps.paused) sub.unshift(ps.cooldownUntil && ps.cooldownUntil > Date.now() ? `⏸ limit: resumes in ${fmtDuration(ps.cooldownUntil - Date.now())}` : "⏸ paused");
    kpis.append(el("div", { className: `geo-kpi${ps.paused ? " geo-kpi-paused" : ""}` },
      el("div", { className: "k-label" }, label),
      el("div", { className: "k-value" }, `${ps.done}/${ps.total}`),
      el("div", { className: "k-sub muted" }, sub.join(" · "))));
  }
  box.append(kpis);

  // Per-prompt breakdown, one list per engine, so "which prompt ran on
  // which LLM, and which is still pending" is directly visible instead of
  // needing to infer it from a single aggregate count.
  const lists = el("div", { className: "loader-prompt-lists" });
  for (const [plat, ps] of Object.entries(s.platStats || {})) {
    const label = ENGINES.find((e) => e.id === plat)?.label || plat;
    const list = el("div", { className: "loader-prompt-list" });
    list.append(el("div", { className: "loader-prompt-list-head" }, label));
    const rows = el("div", { className: "loader-prompt-rows" });
    rows.dataset.plat = plat;
    (ps.prompts || []).forEach((p, i) => {
      const row = el("div", { className: `loader-prompt-row status-${p.status}` },
        el("span", { className: "loader-prompt-icon", title: PROMPT_STATUS_LABEL[p.status] }, PROMPT_STATUS_ICON[p.status]),
        el("span", { className: "loader-prompt-idx muted" }, `${i + 1}.`),
        el("span", { className: "loader-prompt-text" }, p.text));
      if (p.status === "failed" && p.reason) row.title = `Failed: ${p.reason}`;
      rows.append(row);
    });
    list.append(rows);
    lists.append(list);
  }
  box.append(lists);
  for (const r of lists.querySelectorAll(".loader-prompt-rows[data-plat]")) {
    const y = listScroll[r.dataset.plat];
    if (y) r.scrollTop = y;
  }
}

// poll loader status while the Campaigns tab is open
//
// Reported: during a run, the page kept jumping to the top and fought any
// attempt to scroll down to watch the currently-running prompts. This is
// exactly the case withScrollPreserved's own header comment names ("a poll
// tick") but this call was bypassing it — renderLoaderStatus does a full
// box.textContent = "" + rebuild, which collapses the scroll container's
// height for an instant and lets the browser clamp scrollTop to fit (down to
// 0 if the box was most of the page). At a 1.5s poll interval, any manual
// scroll got undone within 1.5s of every attempt.
setInterval(async () => {
  if (!$("#loader")?.classList.contains("active")) return;
  const s = await send({ type: "loader-status" });
  if (s.ok) withScrollPreserved(() => renderLoaderStatus(s));
}, 1500);

/* ---------- Diagnostics log ----------
 * One merged log — replaces what used to be two disconnected mechanisms:
 * an error log (durable) and a "Capture debugger log" (in-memory, wiped on
 * every service-worker restart). Entries carry a `cat` — "error", "turn" (a
 * per-prompt outcome) or "capture" (a network-capture breadcrumb) — see
 * lib/errorlog.js's header for why these were folded into one store rather
 * than staying three separate things a user had to know to check.
 */
const DIAG_CAT_LABEL = { error: "Error", turn: "Turn", capture: "Capture" };

// Kept as plain text so "Copy log" produces something a person can paste into
// a message without any of the surrounding UI coming with it.
function diagLogText(entries) {
  if (!entries.length) return "Nothing recorded.";
  return entries.map((e) => {
    const when = new Date(e.at).toLocaleString(dateLocale());
    const cat = DIAG_CAT_LABEL[e.cat] || "Error";
    const ctx = e.context && Object.keys(e.context).length
      ? `\n    context: ${Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
    const trace = e.trace ? `\n    trace: ${e.trace}` : "";
    const stack = e.stack ? `\n    ${e.stack.slice(0, 300)}` : "";
    return `${when}\n  [${cat}] [${e.where}] ${e.message}${ctx}${trace}${stack}`;
  }).join("\n\n");
}

// The whole log, fetched once per visit; the chips filter it here, so each
// chip can say how many entries it would show.
async function renderDiagLog() {
  if (!$("#diagLog")) return;
  const r = await send({ type: "error-log", limit: 300 });
  abLogEntries = (r && r.ok && r.entries) || [];
  abLogLoaded = true;
  renderAboutNav(abCurrent());
  renderDiagRows();
}

function renderDiagRows() {
  const box = $("#diagLog");
  const chipsBox = $("#diagChips");
  if (!box || !chipsBox) return;
  const v = logView(abLogEntries, abLogFilter);
  chipsBox.textContent = "";
  v.chips.forEach((c) => {
    const b = el("button", { type: "button", className: `ab-chip-btn${c.on ? " on" : ""}`, "aria-pressed": c.on ? "true" : "false" }, c.label, el("span", { className: "ab-chip-n" }, String(c.count)));
    b.onclick = () => { abLogFilter = c.id; renderDiagRows(); };
    chipsBox.append(b);
  });
  box.textContent = "";
  if (!abLogLoaded) { box.append(el("p", { className: "ab-sub ab-log-empty" }, "Loading…")); return; }
  if (!v.rows.length) {
    box.append(el("p", { className: "ab-sub ab-log-empty" }, abLogEntries.length ? "Nothing of this kind recorded." : "The log is empty. New events appear here as they happen."));
    return;
  }
  v.rows.forEach((e) => {
    const catKey = e.cat || "error";
    const line = el("div", { className: `ab-log-row cat-${catKey}` },
      el("time", { className: "ab-log-time", dateTime: new Date(e.at).toISOString(), title: new Date(e.at).toLocaleString(dateLocale()) }, new Date(e.at).toLocaleTimeString()),
      el("span", { className: `ab-log-cat cat-${catKey}` }, DIAG_CAT_LABEL[catKey] || "Error"),
      el("span", { className: "ab-log-msg" }, e.message),
      el("code", { className: "ab-log-where" }, e.where));
    const more = el("div", { className: "ab-log-more" });
    if (e.context && Object.keys(e.context).length) {
      more.append(el("div", { className: "muted small" }, Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join("  ·  ")));
    }
    /* The turn timeline, spelled out.
     *
     * "timeout" alone says a capture never arrived; the trace says whether
     * the composer was ever found, whether the text landed, whether the send
     * control was usable, and how far the sequence got before it stopped —
     * which is the difference between a fixable report and a shrug. */
    if (e.trace) more.append(el("div", { className: "err-trace" }, el("span", { className: "muted small" }, "turn timeline: "), el("code", {}, e.trace)));
    if (e.stack) more.append(el("details", { className: "err-stack" }, el("summary", { className: "muted small" }, "stack"), el("pre", { className: "muted small" }, e.stack)));
    // Raw capture data reachable straight from the log.
    if (e.context && e.context.captureId) {
      const viewRaw = el("button", { type: "button", className: "btn sm ghost" }, "View raw capture");
      viewRaw.onclick = () => downloadRaw(e.context.captureId, "diag");
      more.append(viewRaw);
    }
    if (more.childNodes.length) line.append(more);
    box.append(line);
  });
}

$("#diagClear")?.addEventListener("click", async () => {
  await send({ type: "error-log-clear" });
  abLogFilter = "all";
  renderDiagLog();
});
$("#diagCopy")?.addEventListener("click", async () => {
  const text = diagLogText(logView(abLogEntries, abLogFilter).rows);
  try {
    await navigator.clipboard.writeText(text);
    showToast("Activity log copied.");
  } catch (_) {
    showToast("Couldn't copy — select the log text and copy manually.", "error");
  }
});

/* ---------- Export campaign diagnostics ----------
 * "Share all the issues and data of a campaign with you in one go" — one
 * zip with the full diagnostic log, every raw capture and derived record
 * for the chosen campaign, and the run-by-run completeness numbers.
 */
async function populateDiagExportProfiles() {
  const sel = $("#diagExportProfile");
  if (!sel) return;
  const r = await send({ type: "geo-profile-list" });
  const profiles = (r && r.ok && r.profiles) || [];
  sel.textContent = "";
  if (!profiles.length) {
    sel.append(el("option", { value: "" }, "No campaigns yet"));
    return;
  }
  for (const p of profiles) sel.append(el("option", { value: p.id }, p.name || p.id));
}

$("#diagExportBtn")?.addEventListener("click", async () => {
  const profileId = $("#diagExportProfile")?.value;
  if (!profileId) { showToast("No campaign selected.", "error"); return; }
  const btn = $("#diagExportBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building…";
  try {
    const r = await send({ type: "get-campaign-diagnostics", profileId });
    if (!r || !r.ok) { showToast((r && r.error) || "Couldn't build the export.", "error"); return; }
    const files = [
      { name: "summary.txt", text: buildCampaignDiagSummaryText(r) },
      { name: "campaign.json", text: JSON.stringify({ campaign: r.campaign, perRun: r.perRun, env: r.env, generatedAt: r.generatedAt }, null, 2) },
      { name: "diagnostics.json", text: JSON.stringify(r.errors, null, 2) },
      { name: "turns.json", text: JSON.stringify(r.turns, null, 2) },
      // Named for what it holds: the log's network-capture breadcrumbs, NOT
      // the captured answers (those are the captures/ folder). As
      // "captures.json" it sat empty beside 22 capture files and read as a
      // second failure.
      { name: "capture-events.json", text: JSON.stringify(r.captures, null, 2) },
    ];
    // Records in batches and raw payloads one at a time: the handler returns
    // only an index, because a whole campaign in one message overran Chrome's
    // 64 MiB message cap and the export failed for a real ten-prompt run. A
    // payload that can't be fetched is noted in the zip rather than failing it.
    const ids = r.recordIds || [];
    const unreadable = r.unreadable || [];
    const total = ids.length + unreadable.length;
    let done = 0;
    const tick = () => { btn.textContent = `Building… ${Math.min(done, total)}/${total}`; };
    const skipped = [];
    const addRaw = async (captureId, name) => {
      const raw = await send({ type: "get-raw", captureId });
      if (raw && raw.ok && raw.raw != null) files.push({ name, text: formatRawCapture(captureId, raw.meta, raw.raw) });
      else skipped.push(`${name}: ${(raw && raw.error) || "not available"}`);
    };
    for (let i = 0; i < ids.length; i += 20) {
      const batch = await send({ type: "get-diagnostics-records", captureIds: ids.slice(i, i + 20) });
      for (const rec of (batch && batch.ok && batch.records) || []) {
        files.push({ name: `captures/${rec.captureId}.json`, text: JSON.stringify(rec, null, 2) });
        await addRaw(rec.captureId, `captures/${rec.captureId}-raw.txt`);
        done++; tick();
      }
    }
    // What an engine sent that no adapter could read — the payloads behind
    // capture-events.json's "capture:unreadable" entries, one per kind.
    for (const u of unreadable) {
      await addRaw(u.captureId, `unreadable/${u.platform || "unknown"}-${u.captureId}-raw.txt`);
      done++; tick();
    }
    if (skipped.length) files.push({ name: "skipped.txt", text: skipped.join("\n") + "\n" });
    const zip = await makeZip(files);
    const slug = String(r.campaign?.name || "campaign").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zip);
    a.download = `citoskeleton-diagnostics-${slug || "campaign"}-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("Diagnostics export saved.");
  } catch (err) {
    showToast("Couldn't build the export.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

function buildCampaignDiagSummaryText(r) {
  const lines = [];
  lines.push("CitoSkeleton campaign diagnostics");
  lines.push("=================================");
  lines.push("");
  lines.push(`Campaign  : ${r.campaign?.name || "—"} (${r.campaign?.profileId || "—"})`);
  lines.push(`Engines   : ${(r.campaign?.engines || []).join(", ") || "—"}`);
  lines.push(`Runs      : ${r.campaign?.runCount ?? "—"}`);
  lines.push(`Prompts   : ${r.campaign?.promptCount ?? "—"}`);
  lines.push(`Generated : ${new Date(r.generatedAt).toISOString()}`);
  lines.push(`Extension : ${r.env?.version || "—"}`);
  lines.push(`Browser   : ${r.env?.userAgent || "—"}`);
  lines.push("");
  lines.push("Per run");
  for (const run of r.perRun || []) {
    lines.push(`  Run ${run.runNo ?? "?"}  ${new Date(run.startedAt).toLocaleString(dateLocale())}  ${run.status}`);
    lines.push(`    expected ${run.expected}  answered ${run.stored}${run.captures != null && run.captures !== run.stored ? ` (${run.captures} captures)` : ""}  missing ${run.missing}  failed ${run.failed}`);
    const reasons = Object.entries(run.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; ");
    if (reasons) lines.push(`    reasons: ${reasons}`);
    if (run.limited) lines.push(`    refused by the engine (usage or message limit, not counted as answers): ${run.limited}`);
    for (const [e, x] of Object.entries(run.byEngine || {})) {
      const rs = Object.entries(x.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; ");
      lines.push(`    ${e}: answered ${x.answered}${x.limited ? `, refused ${x.limited}` : ""}${rs ? ` · ${rs}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Errors: ${(r.errors || []).length}   Turns: ${(r.turns || []).length}   Capture events: ${(r.captures || []).length}`);
  return lines.join("\n");
}

// Painted on load rather than only on demand, so the count in the summary is
// accurate the first time the About tab is opened.
renderDiagLog();
populateDiagExportProfiles();

/* ---------- About (0.51.0) ----------
 * Release 5 of the canvas redesign. Five pages — Overview, Metric glossary,
 * Settings, Data & tools, Diagnostics — one at a time. The full tab has a
 * side menu; the popup opens on a home screen ("Get started", then a list of
 * the pages) and goes one page deep, with a glossary term as a page of its
 * own. What has rules in it (the glossary search, the checklist, unsaved
 * settings, the storage meter, the log's counts, the version check) is in
 * src/lib/aboutView.js; this file only draws it.
 */
const AB_TAB_SECTIONS = ["overview", "glossary", "settings", "account", "data", "diagnostics"];
const AB_PAGES = {
  overview: { label: "Overview", glyph: "info" },
  account: { label: "Account", glyph: "user", sub: "Sign in, your name, campaigns you've shared" },
  glossary: { label: "Metric glossary", glyph: "book", sub: "What every number means, and how to use it" },
  settings: { label: "Settings", glyph: "sliders", sub: "How much is kept on this device" },
  data: { label: "Data & tools", glyph: "tools", sub: "Reprocess captures, sample data, the tour" },
  diagnostics: { label: "Diagnostics", glyph: "pulse", sub: "Version check, report a problem" },
  news: { label: "What’s new", glyph: "spark", sub: `Changes in version ${BUILD}` },
};
const AB_POPUP_SUB = {
  glossary: "What every number in the tool means. Hover a metric anywhere to see the same text.",
  settings: "How much CitoSkeleton keeps on this device.",
  data: "Housekeeping on what’s stored. None of it touches your campaigns.",
};
// Where each engine is asked — the first "Get started" step links to them.
const AB_ENGINE_HOME = { chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/app", perplexity: "https://www.perplexity.ai/", grok: "https://grok.com/" };
const AB_ANALYZED_KEY = "cito-analyzed-real";

let abSection = null;   // null until picked: the layout's own first page
let abGlossQuery = "";
let abGlossGroup = "all";
let abTerm = "visibility";
let abLogFilter = "all";
let abLogEntries = [];
let abLogLoaded = false;
let abBuildReply = null; // the build-info reply, from checkBuildMatch()
let abStats = null;      // the "stats" reply, for the storage meter
let abSaved = null;      // settings as stored
let abJustSaved = false;
let abDemo = null;       // the demo-status reply

const abPopup = () => document.body.classList.contains("popup");
const abIsDemo = (r) => !!(r && (r.isDemo || String(r.captureId || "").startsWith("demo-")));

// The page to show, mapped onto what this layout has: the popup's home holds
// the overview, and the tab shows a glossary term and what's new in place.
function abCurrent() {
  const s = abSection || (abPopup() ? "home" : "overview");
  if (abPopup()) return s === "overview" ? "home" : s;
  if (s === "home" || s === "news") return "overview";
  return s === "term" ? "glossary" : s;
}

function abGo(section) {
  abSection = section;
  renderAbout();
  const sc = activeScroller();
  if (sc) sc.scrollTop = 0;
}

// Step two of "Get started" is done by reading a real answer in Analyze, not
// by the sample, and not by Analyze rendering in the background.
function abNoteAnalyzed(rec) {
  if (!rec || abIsDemo(rec) || !$("#analyze")?.classList.contains("active")) return;
  try { localStorage.setItem(AB_ANALYZED_KEY, "1"); } catch (_) { /* a per-viewer nicety */ }
}
function abAnalyzed() {
  try { return localStorage.getItem(AB_ANALYZED_KEY) === "1"; } catch (_) { return false; }
}

// Opening About: draw it, then fetch what can have changed since.
function aboutEnter() {
  renderAbout();
  renderDiagLog();
  refreshDemoControls();
  populateDiagExportProfiles();
  send({ type: "stats" }).then(renderStorageInfo).catch(() => {});
}

function renderAbout() {
  const root = $("#about");
  if (!root) return;
  const sec = abCurrent();
  root.dataset.ab = sec;
  root.querySelectorAll(".ab-sec").forEach((n) => { n.hidden = n.dataset.sec !== sec; });
  renderAboutNav(sec);
  renderAboutBuild();
  renderAboutSubhead(sec);
  if (sec === "home") renderAboutHome();
  if (sec === "overview") renderAboutOverview();
  if (sec === "news") { const box = $("#abNews"); box.textContent = ""; box.append(abNewsCard(false)); }
  if (sec === "glossary") renderAboutGlossary();
  if (sec === "term") renderAboutTerm();
  if (sec === "account") renderAccount();
  if (sec === "settings") { renderStorageMeter(); updateSettingsStatus(); }
  if (sec === "diagnostics") { renderDiagRows(); renderCaptureCheck(); }
}

// The capture check (0.73.1): one row per engine with what to do, and a
// "Refresh" button for a tab cut off from the extension.
const CAP_ENGINE = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
let capReport = "";
async function renderCaptureCheck() {
  const rows = $("#capCheckRows");
  if (!rows) return;
  const r = await send({ type: "capture-check" }).catch(() => null);
  rows.textContent = "";
  if (!r || !r.ok) { rows.append(el("p", { className: "cap-line bad" }, "The extension's background didn't answer. Open chrome://extensions, check CitoSkeleton has no error, and press reload ↻.")); return; }
  capReport = r.report || "";
  for (const v of r.engines || []) {
    const row = el("div", { className: `cap-row ${v.status}`, "data-engine": v.engine },
      el("span", { className: "cap-dot", "aria-hidden": "true" }),
      el("b", { className: "cap-eng" }, CAP_ENGINE[v.engine] || v.engine),
      el("span", { className: "cap-line" }, v.line));
    for (const t of (r.tabs || []).filter((x) => x.engine === v.engine && !x.alive)) {
      const b = el("button", { type: "button", className: "btn sm cap-refresh" }, "Refresh the tab");
      b.onclick = async () => { b.disabled = true; await send({ type: "capture-refresh-tab", tabId: t.tabId }).catch(() => {}); setTimeout(renderCaptureCheck, 2500); };
      row.append(b);
    }
    rows.append(row);
  }
}
document.addEventListener("click", (e) => {
  const id = e.target && e.target.id;
  if (id === "capCheckRun") renderCaptureCheck();
  if (id === "capCheckCopy") {
    const note = $("#capCheckNote");
    const done = (ok) => { if (note) note.textContent = ok ? "Copied. Paste it in a message to us." : "Couldn't copy — select the text below instead."; };
    renderCaptureCheck().then(() => navigator.clipboard.writeText(capReport)).then(() => done(true), () => {
      done(false);
      const pre = el("pre", { className: "cap-pre" }, capReport);
      $("#capCheckRows")?.append(pre);
    });
  }
});

function renderAboutNav(sec) {
  const nav = $("#abNav");
  if (!nav) return;
  nav.textContent = "";
  AB_TAB_SECTIONS.forEach((id) => {
    const p = AB_PAGES[id];
    const on = id === sec;
    const b = el("button", { type: "button", className: `ab-nav-btn${on ? " on" : ""}`, "aria-current": on ? "page" : "false" }, glyphEl(p.glyph, 18), el("span", { className: "ab-nav-label" }, p.label));
    if (id === "glossary") b.append(el("span", { className: "ab-nav-count" }, String(glossaryEntries().length)));
    const errors = logView(abLogEntries).errors;
    if (id === "diagnostics" && errors) b.append(el("span", { className: "ab-nav-badge", title: `${errors} error${errors === 1 ? "" : "s"} in the activity log` }, String(errors)));
    b.onclick = () => abGo(id);
    nav.append(b);
  });
}

function renderAboutBuild() {
  const st = buildStatus(abBuildReply, BUILD);
  const mini = $("#abBuild");
  if (mini) {
    mini.className = `ab-build${st.stale ? " stale" : st.known ? " ok" : ""}`;
    mini.textContent = "";
    mini.append(el("span", { className: "ab-dot", "aria-hidden": "true" }), el("span", { className: "ab-build-text" }, el("b", {}, st.title), el("span", {}, st.sub)));
    mini.onclick = st.stale ? () => abGo("diagnostics") : null;
    mini.style.cursor = st.stale ? "pointer" : "";
  }
  const full = $("#abBuildFull");
  if (full) {
    full.className = `ab-buildline${st.stale ? " stale" : st.known ? " ok" : ""}`;
    full.textContent = "";
    if (st.stale) {
      full.append(el("b", {}, "Part of CitoSkeleton is out of date"), el("p", {}, st.line),
        el("ol", {},
          el("li", {}, "Open chrome://extensions and press the reload ↻ icon on CitoSkeleton. Restarting Chrome is not enough."),
          el("li", {}, "Still seeing this? Close Chrome, extract the update over the folder again so every file is replaced, reopen Chrome and press reload ↻ once more.")));
    } else {
      full.append(glyphEl(st.known ? "check" : "info", 16), el("span", {}, st.line || st.title));
    }
  }
}

function renderAboutSubhead(sec) {
  const h = $("#abSubhead");
  if (!h) return;
  h.textContent = "";
  h.hidden = !abPopup() || sec === "home";
  if (h.hidden) return;
  const back = el("button", { type: "button", className: "ab-back" }, el("span", { "aria-hidden": "true" }, "←"), sec === "term" ? " Glossary" : " About");
  back.onclick = () => abGo(sec === "term" ? "glossary" : "home");
  const t = sec === "term" ? GLOSSARY[abTerm] : null;
  const title = t ? t.term : sec === "news" ? `What’s new in ${BUILD}` : AB_PAGES[sec].label;
  // Element.append() would write a null out as the text "null".
  h.append(...[back, t ? el("div", { className: "ab-eyebrow" }, t.group) : null, el("h2", { className: "ab-title" }, title),
    AB_POPUP_SUB[sec] ? el("p", { className: "ab-sub" }, AB_POPUP_SUB[sec]) : null].filter(Boolean));
}

function abEngineChips(asLinks) {
  return el("div", { className: "ab-engines" }, ...availableEngines().map((e) => (asLinks
    ? el("a", { className: "ab-engine", href: AB_ENGINE_HOME[e.id] || "#", target: "_blank", rel: "noreferrer" }, engineIconEl(e.id), e.label)
    : el("span", { className: "ab-engine" }, engineIconEl(e.id), e.label))));
}

function abGoTab(tab) {
  document.querySelector(`[data-tab="${tab}"]`)?.click();
}

function abNewsCard(withTitle) {
  const card = el("div", { className: "card ab-card" });
  if (withTitle) card.append(el("div", { className: "ab-head" }, el("div", {}, el("h2", { className: "ab-title" }, `What’s new in ${BUILD}`))));
  card.append(el("ul", { className: "ab-news" }, ...ABOUT_NEWS.map((w) => el("li", {}, el("b", {}, w.head), " ", el("span", {}, w.body)))));
  return card;
}

function renderAboutHome() {
  const box = $("#abHome");
  box.textContent = "";
  const real = ALL_RECORDS.filter((r) => !abIsDemo(r)).length;
  const prog = startProgress({ realCaptures: real, analyzed: abAnalyzed(), campaigns: (GEO_PROFILES || []).length });
  box.append(el("div", { className: "card ab-card ab-home" },
    el("div", { className: "ab-home-top" }, el("img", { src: "../icons/icon128.png", width: 36, height: 36, alt: "", className: "ab-logo" }),
      el("h2", { className: "ab-title", id: "abHomeTitle" }, prog.title), el("span", { className: "version-badge" }, `v${BUILD}`)),
    el("p", { className: "ab-lead" }, "See what ChatGPT, Gemini, Perplexity and Grok read before they answer."),
    el("p", { className: "ab-private" }, glyphEl("lock", 15), "Your captures stay on this computer. Nothing is sent unless you share a campaign or sign in.")));

  if (abDemo && abDemo.ok && abDemo.present) {
    const rm = el("button", { type: "button", className: "btn sm ghost" }, "Remove");
    rm.onclick = withBusy(rm, "Removing…", abToggleSample);
    box.append(el("div", { className: "card ab-card ab-sample" },
      el("div", { className: "ab-tool-text" }, el("b", {}, "Sample data is on"), el("span", {}, "One example answer, labelled Sample, so every tab has something to show.")), rm));
  }

  const start = el("div", { className: "card ab-card ab-start" });
  if (prog.allDone) {
    start.append(el("p", { className: "ab-alldone" }, glyphEl("check", 16), "You’re all set. The welcome guide is in Data & tools any time."));
  } else {
    start.append(el("div", { className: "ab-start-head" }, el("h3", { className: "ab-h3" }, "Get started"), el("span", { className: "ab-progress-text" }, prog.text)),
      el("div", { className: "ab-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(prog.steps.length), "aria-valuenow": String(prog.done), "aria-label": "Get started" },
        ...prog.steps.map((s) => el("span", { className: s.done ? "done" : "" }))));
    const list = el("ol", { className: "ab-steps-list" });
    prog.steps.forEach((s, i) => {
      const li = el("li", { className: `ab-step${s.done ? " done" : ""}`, "data-step": s.id },
        el("span", { className: "ab-step-mark", "aria-hidden": "true" }, s.done ? glyphEl("check", 14) : String(i + 1)),
        el("div", { className: "ab-step-body" }, el("b", {}, s.title), el("span", {}, s.done ? "Done." : s.text)));
      if (!s.done) {
        const body = li.querySelector(".ab-step-body");
        if (s.id === "ask") body.append(abEngineChips(true));
        if (s.id === "analyze") { const b = el("button", { type: "button", className: "btn sm ghost" }, "Open Analyze"); b.onclick = () => abGoTab("analyze"); body.append(b); }
        if (s.id === "campaign") { const b = el("button", { type: "button", className: "btn sm ghost" }, "Set up a campaign"); b.onclick = () => abGoTab("loader"); body.append(b); }
      }
      list.append(li);
    });
    start.append(list);
  }
  box.append(start);

  const st = buildStatus(abBuildReply, BUILD);
  const more = el("div", { className: "card ab-card ab-more" }, el("h3", { className: "ab-h3" }, "More"));
  ["glossary", "settings", "account", "data", "diagnostics", "news"].forEach((id) => {
    const p = AB_PAGES[id];
    let trail = null;
    if (id === "glossary") trail = el("span", { className: "ab-nav-count" }, String(glossaryEntries().length));
    if (id === "diagnostics") trail = el("span", { className: `ab-pill${st.stale ? " stale" : st.known ? " ok" : ""}` }, el("span", { className: "ab-dot", "aria-hidden": "true" }), st.stale ? "Needs reload" : st.known ? "Up to date" : st.title);
    const b = el("button", { type: "button", className: "ab-more-row", "data-go": id }, el("span", { className: "ab-more-ic" }, glyphEl(p.glyph, 18)),
      el("span", { className: "ab-more-text" }, el("b", {}, p.label), el("span", {}, p.sub)), trail, el("span", { className: "ab-chev", "aria-hidden": "true" }, "›"));
    b.onclick = () => abGo(id);
    more.append(b);
  });
  box.append(more);
}

function renderAboutOverview() {
  const box = $("#abOverview");
  box.textContent = "";
  box.append(el("div", { className: "card ab-card ab-hero" },
    el("div", { className: "ab-hero-row" }, el("img", { src: "../icons/icon128.png", width: 56, height: 56, alt: "", className: "ab-logo lg" }),
      el("div", { className: "ab-hero-text" },
        el("h2", { className: "ab-hero-title" }, "CitoSkeleton ", el("span", { className: "version-badge" }, `v${BUILD}`)),
        el("p", { className: "ab-lead" }, "See what ChatGPT, Gemini, Perplexity and Grok actually read before they answer: the searches they run, the pages they fetch, the sources they cite, and which brands make it into the reply."),
        el("p", { className: "ab-sub" }, "Formerly listed as ", el("em", {}, "LLM Citation & Fan-Out Checker"), "."))),
    el("div", { className: "ab-facts" },
      el("div", { className: "ab-facts-text" }, glyphEl("lock", 18), el("span", {}, el("b", {}, "Everything stays on this device"), el("span", {}, "CitoSkeleton only reads what your browser already received."))),
      el("div", { className: "ab-facts-chips" }, ...["Captures stay here", "No account needed", "Nothing sent unless you share"].map((t) => el("span", { className: "ab-fact" }, glyphEl("check", 13), t)))),
    el("div", { className: "ab-works" }, el("span", { className: "ab-label" }, "Works with"), abEngineChips(false))));

  const steps = el("ol", { className: "ab-how" });
  ABOUT_STEPS.forEach((s) => {
    const where = s.tab
      ? el("button", { type: "button", className: "linkbtn ab-where" }, `${s.where} →`)
      : el("span", { className: "ab-where muted" }, s.where);
    if (s.tab) where.onclick = () => abGoTab(s.tab);
    steps.append(el("li", {}, el("span", { className: "ab-num", "aria-hidden": "true" }, String(s.n)), el("b", {}, s.title), el("span", { className: "ab-how-text" }, s.text), where));
  });
  box.append(el("div", { className: "card ab-card" },
    el("div", { className: "ab-head" }, el("div", {}, el("h2", { className: "ab-title" }, "How it works"), el("p", { className: "ab-sub" }, "Four tabs, one job each.")),
      // Help & FAQ (1.0.0, ui/help.html).
      el("a", { className: "btn sm ghost ab-help", href: chrome.runtime.getURL("ui/help.html"), target: "_blank", rel: "noopener" }, "Help & FAQ")),
    steps,
    el("p", { className: "ab-sub" }, "Brand detection is automatic for every industry. Your brand, competitors, prompts and engines are set per campaign, in Campaigns.")));
  box.append(abNewsCard(true));
  // What works in this browser (0.72.0): the same build runs in Chrome,
  // Edge, Brave, Opera, Firefox and Safari, with a few parts missing in some.
  const sup = browserSupport({
    offscreen: !!(chrome.offscreen), tabGroups: !!(chrome.tabGroups), notifications: !!(chrome.notifications),
    nano: typeof globalThis.LanguageModel !== "undefined", webgpu: !!navigator.gpu, incognito: !!(chrome.windows && chrome.windows.create), ua: navigator.userAgent,
  });
  const list = el("ul", { className: "ab-support", id: "abSupport" });
  sup.rows.forEach((r) => list.append(el("li", { className: r.on ? "on" : "off" }, glyphEl(r.on ? "check" : "info", 13), el("span", {}, r.label), r.note ? el("span", { className: "muted" }, ` · ${r.note}`) : "")));
  box.append(el("div", { className: "card ab-card" },
    el("div", { className: "ab-head" }, el("div", {}, el("h2", { className: "ab-title" }, `This browser: ${sup.name}`), el("p", { className: "ab-sub" }, "The same extension runs in Chrome, Edge, Brave, Opera, Firefox and Safari; a few parts depend on the browser."))),
    list));
}

/* The glossary: the same entries the hover definitions come from
   (src/lib/glossary.js), so the reference and the tooltips can't disagree. */
function abTermBody(t) {
  const body = el("div", { className: "ab-term-body" }, el("p", { className: "ab-lead" }, t.what));
  if (t.formula) body.append(el("div", { className: "ab-formula" }, el("span", { className: "ab-label" }, "Formula"), el("code", {}, t.formula)));
  if (t.note) body.append(el("div", { className: "ab-term-part" }, el("span", { className: "ab-label" }, "Keep in mind"), el("p", {}, t.note)));
  return body;
}

function renderAboutGlossary() {
  const v = glossaryView(glossaryEntries(), { query: abGlossQuery, group: abGlossGroup });
  const count = $("#abGlossCount");
  if (count) count.textContent = tr(`${v.total} terms`);
  const inp = $("#abGlossSearch");
  if (inp && inp.value !== abGlossQuery) inp.value = abGlossQuery;
  const chips = $("#abGlossChips");
  chips.textContent = "";
  v.chips.forEach((c) => {
    const b = el("button", { type: "button", className: `ab-chip-btn${c.on ? " on" : ""}`, "aria-pressed": c.on ? "true" : "false" }, c.label, el("span", { className: "ab-chip-n" }, String(c.count)));
    b.onclick = () => { abGlossGroup = c.id; renderAboutGlossary(); };
    chips.append(b);
  });
  const host = $("#glossaryList");
  host.textContent = "";
  if (!v.matches.length) {
    const clear = el("button", { type: "button", className: "btn sm ghost" }, "Clear the search");
    clear.onclick = () => { abGlossQuery = ""; abGlossGroup = "all"; renderAboutGlossary(); };
    host.append(el("div", { className: "ab-empty" }, el("p", {}, `No terms match “${abGlossQuery}”`), clear));
    return;
  }
  const picked = pickedTerm(v, abTerm);
  const list = el("div", { className: "ab-gloss-list" });
  v.groups.forEach((g) => {
    list.append(el("h3", { className: "ab-gloss-group" }, g.name));
    g.rows.forEach((t) => {
      const on = !abPopup() && picked && t.key === picked.key;
      const b = el("button", { type: "button", className: `ab-term-row${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false", "data-key": t.key },
        el("b", {}, t.term), el("span", {}, t.what), abPopup() ? el("span", { className: "ab-chev", "aria-hidden": "true" }, "›") : null);
      b.onclick = () => { abTerm = t.key; if (abPopup()) abGo("term"); else renderAboutGlossary(); };
      list.append(b);
    });
  });
  if (abPopup()) { host.append(list); return; }
  host.append(list, el("aside", { className: "ab-gloss-detail", "aria-live": "polite" },
    el("div", { className: "ab-eyebrow" }, picked.group), el("h3", { className: "ab-detail-title" }, picked.term), abTermBody(picked)));
}

function renderAboutTerm() {
  const box = $("#abTerm");
  box.textContent = "";
  const t = GLOSSARY[abTerm];
  if (t) box.append(el("div", { className: "card ab-card" }, abTermBody(t)));
}

$("#abGlossSearch")?.addEventListener("input", (e) => { abGlossQuery = e.target.value; renderAboutGlossary(); });

/* ---------- Settings: saved, or changed and not yet saved ---------- */
function abDraft() {
  return {
    retentionMax: settingValue("retentionMax", $("#setRetention").value),
    maxCaptureMB: settingValue("maxCaptureMB", $("#setMaxMB").value),
    debugCapture: !!$("#setDebug").checked,
    readCitedPages: !!$("#setPages")?.checked,
    keepHandoffCaptures: !!$("#setHandoffKeep")?.checked,
  };
}
function abFillSettings(s) {
  $("#setRetention").value = s.retentionMax;
  $("#setMaxMB").value = s.maxCaptureMB;
  $("#setDebug").checked = !!s.debugCapture;
  if ($("#setPages")) $("#setPages").checked = !!s.readCitedPages;
  if ($("#setHandoffKeep")) $("#setHandoffKeep").checked = !!s.keepHandoffCaptures;
}
function updateSettingsStatus() {
  const status = $("#setStatus");
  if (!status || !abSaved) return;
  const st = settingsState(abSaved, abDraft(), { justSaved: abJustSaved });
  status.textContent = tr(st.status);
  status.className = `ab-status ${st.tone}`;
  $("#setUndo").disabled = !st.dirty;
  $("#setSave").disabled = !st.dirty;
  $("#setDebugText").textContent = tr($("#setDebug").checked ? "On" : "Off");
  if ($("#setPagesText")) $("#setPagesText").textContent = tr($("#setPages").checked ? "On" : "Off");
  if ($("#setHandoffKeepText")) $("#setHandoffKeepText").textContent = tr($("#setHandoffKeep").checked ? "On" : "Off");
}
async function loadSettings() {
  const r = await send({ type: "settings-get" });
  // Guard the PAYLOAD, not just the ok flag. An {ok:true} reply that somehow
  // carries no settings object threw here, and because loadSettings() is
  // called without a catch during boot that surfaced as an unhandled
  // rejection rather than a visible failure.
  if (!r || !r.ok || !r.settings || !$("#setRetention")) return;
  const s = r.settings;
  abSaved = { retentionMax: s.retentionMax, maxCaptureMB: s.maxCaptureMB, debugCapture: !!s.debugCapture, readCitedPages: !!s.readCitedPages, keepHandoffCaptures: !!s.keepHandoffCaptures };
  abFillSettings(abSaved);
  updateSettingsStatus();
  renderStorageMeter();
}
["#setRetention", "#setMaxMB", "#setDebug", "#setHandoffKeep"].forEach((id) => $(id)?.addEventListener(id === "#setDebug" || id === "#setHandoffKeep" ? "change" : "input", () => { abJustSaved = false; updateSettingsStatus(); }));
// Turning on "Read the cited pages" asks Chrome for access to any site,
// from this click (Chrome only shows its prompt in answer to a click). If
// it's refused the switch goes back off and says why (0.62.0).
$("#setPages")?.addEventListener("change", async (e) => {
  const box = e.target, note = $("#setPagesNote");
  if (note) { note.hidden = true; note.textContent = ""; }
  if (box.checked && chrome.permissions) {
    let ok = false;
    try { ok = await chrome.permissions.contains({ origins: ["<all_urls>"] }) || await chrome.permissions.request({ origins: ["<all_urls>"] }); } catch (_) { ok = false; }
    if (!ok) {
      box.checked = false;
      if (note) { note.hidden = false; note.textContent = "Chrome didn't allow site access, so the pages can't be read. Turn it on again to be asked again."; }
    }
  }
  abJustSaved = false;
  updateSettingsStatus();
});
document.querySelectorAll(".ab-stepbtn[data-step]").forEach((b) => b.addEventListener("click", () => {
  const input = document.getElementById(b.dataset.step);
  const key = b.dataset.step === "setRetention" ? "retentionMax" : "maxCaptureMB";
  const { step } = SETTING_LIMITS[key];
  input.value = settingValue(key, (parseInt(input.value, 10) || 0) + step * Number(b.dataset.dir));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}));
$("#setUndo")?.addEventListener("click", () => { if (abSaved) { abFillSettings(abSaved); updateSettingsStatus(); } });
$("#setSave")?.addEventListener("click", async () => {
  const patch = abDraft();
  const r = await send({ type: "settings-set", patch });
  if (!r || !r.ok) { $("#setStatus").textContent = tr("Couldn't save the settings."); $("#setStatus").className = "ab-status warn"; return; }
  abSaved = patch;
  abJustSaved = true;
  abFillSettings(patch);
  updateSettingsStatus();
  renderStorageMeter();
});

function renderStorageMeter() {
  const box = $("#storageInfo");
  if (!box) return;
  box.textContent = "";
  if (!abStats || !abStats.ok || !abSaved) return;
  const m = storageMeter({ stored: abStats.derived, keep: abSaved.retentionMax, usedBytes: abStats.usage ? abStats.usage.usedBytes : null });
  box.append(el("div", { className: "ab-meter-top" }, el("b", {}, "Captures stored"), el("span", { className: "ab-meter-num" }, m.text)),
    el("div", { className: `ab-meter-bar${m.warn ? " warn" : ""}`, role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(m.pct), "aria-label": "Captures stored, of the number kept" },
      el("span", { style: `width:${Math.max(2, m.pct)}%` })),
    el("div", { className: "ab-sub" }, m.sub));
}

/* ---------- Compare: one prompt across many timelines ----------
 * The GEO question is "for THIS query, am I gaining or losing ground over time?"
 * — so the unit of comparison is a single prompt tracked across every time it
 * ran, not two whole runs diffed against each other (which mixed unrelated
 * prompts together and made movement unreadable).
 *
 * A prompt is matched by its normalised text, so the same question captured on
 * different days / in different projects lines up into one timeline.
 */
let cmpProjectFilter = "";
let cmpModelFilter = "";

function normPrompt(p) {
  return String(p || "").toLowerCase().replace(/\s+/g, " ").replace(/[.?!,]+$/, "").trim();
}

// Every distinct prompt that has been captured, with its captures sorted oldest→newest.
function promptTimelines() {
  const byPrompt = new Map();
  for (const r of RECORDS) {
    if (!r.userPrompt) continue;
    if (cmpProjectFilter && r.projectId !== cmpProjectFilter) continue;
    if (cmpModelFilter && r.platform !== cmpModelFilter) continue;
    const key = normPrompt(r.userPrompt);
    if (!key) continue;
    if (!byPrompt.has(key)) byPrompt.set(key, { key, label: r.userPrompt, captures: [] });
    byPrompt.get(key).captures.push(r);
  }
  for (const t of byPrompt.values()) t.captures.sort((a, b) => a.capturedAt - b.capturedAt);
  return [...byPrompt.values()].sort((a, b) => b.captures.length - a.captures.length);
}

let cmpSearch = "";

function refreshComparePickers() {
  const projSel = $("#cmpProject");
  if (projSel) {
    const keep = projSel.value;
    projSel.textContent = "";
    projSel.append(el("option", { value: "" }, "All projects"));
    PROJECTS.forEach((p) => projSel.append(el("option", { value: p.id }, p.name)));
    projSel.value = keep;
  }
  const sel = $("#cmpPrompt");
  if (!sel) return;
  const keep = sel.value;
  const timelines = promptTimelines();
  // Same token matcher as every other search box in the app, so "phone 50k"
  // finds "best camera phone under 50K in India" rather than requiring the
  // prompt to be retyped verbatim.
  const matched = timelines.filter((t) => matchesSearch(t.label, cmpSearch));
  sel.textContent = "";
  sel.append(el("option", { value: "" }, matched.length ? "Choose a prompt\u2026" : "No prompt matches your search"));
  matched.forEach((t) => {
    const n = t.captures.length;
    const txt = t.label.length > 60 ? t.label.slice(0, 60) + "\u2026" : t.label;
    sel.append(el("option", { value: t.key }, `${txt}  \u2014  ${n} capture${n === 1 ? "" : "s"}`));
  });
  // A selection that the search has filtered out of the list would otherwise
  // silently reset the whole Compare view; re-add it so it survives typing.
  if (keep && !matched.some((t) => t.key === keep)) {
    const kept = timelines.find((t) => t.key === keep);
    if (kept) sel.append(el("option", { value: kept.key }, `${kept.label.slice(0, 60)}  \u2014  currently selected`));
  }
  sel.value = keep;

  const repeat = timelines.filter((t) => t.captures.length > 1).length;
  const hint = $("#cmpHint");
  if (hint) {
    const base = repeat
      ? `${repeat} prompt${repeat === 1 ? " has" : "s have"} been captured more than once \u2014 those show real movement.`
      : "Capture the same prompt again (any day, or via a campaign run) to see what changed between runs.";
    hint.textContent = cmpSearch ? `${matched.length} of ${timelines.length} prompts match. ${base}` : base;
  }
}

// Per-capture aggregate for one point on the timeline.
//
// Everything here is derived from fields that survive `get-records`' stripping
// of heavy data. Brand RANK is deliberately absent: ranking needs answerText,
// which list records don't carry (that's exactly why geo-metrics computes
// position in the service worker instead). Adding a rank column here would
// mean either hydrating every capture in the timeline or inventing a number —
// so Compare reports presence and volume, and says so.
function pointAggregate(rec) {
  const domains = new Map();
  const urls = new Map();
  let cited = 0, fetched = 0;
  (rec.sources || []).forEach((s) => {
    const isCited = s.outcome === "cited";
    if (isCited) cited++; else fetched++;
    if (s.domain) {
      const prev = domains.get(s.domain) || { cited: 0, fetched: 0 };
      if (isCited) prev.cited++; else prev.fetched++;
      domains.set(s.domain, prev);
    }
    if (s.url) {
      const prev = urls.get(s.url) || { cited: 0, fetched: 0, domain: s.domain || "" };
      if (isCited) prev.cited++; else prev.fetched++;
      urls.set(s.url, prev);
    }
  });
  const brands = new Map();
  (rec.brandMentions || []).forEach((b) => {
    // count 0 = "shown but not narrated" — still presence, tracked separately
    const prev = brands.get(b.brand) || { count: 0, shown: false };
    prev.count += b.count || 0;
    if ((b.count || 0) === 0) prev.shown = true;
    brands.set(b.brand, prev);
  });
  const queries = new Set();
  ["search", "shopping", "image"].forEach((bucket) =>
    (rec.fanout?.[bucket] || []).forEach((q) => q && q.query && queries.add(String(q.query).trim())));
  return {
    domains, urls, brands, queries,
    cited, fetched,
    answerChars: rec.answerChars || 0,
    products: (rec.products || []).length,
  };
}

function deltaTag(delta) {
  if (delta > 0) return el("span", { className: "tag cited" }, `▲ +${delta}`);
  if (delta < 0) return el("span", { className: "tag fetched" }, `▼ ${delta}`);
  return el("span", { className: "tag mentioned" }, "no change");
}

// "3 of 7 runs" — how reliably an item shows up, which is a different and
// often more useful question than "did it move between the first and last
// run". A domain in 7/7 runs is structural; one in 2/7 is noise.
function stabilityTag(seen, total) {
  const pct = total ? seen / total : 0;
  const cls = pct >= 0.8 ? "cited" : pct >= 0.4 ? "mentioned" : "fetched";
  return el("span", { className: `tag ${cls}`, title: `Appeared in ${seen} of ${total} runs` }, `${seen}/${total}`);
}

/* The Over time board (0.60.0): one prompt's runs, the movement drawn rather
 * than counted. Sections: what changed from the first run to the latest,
 * where each brand came run by run (a line per brand, 1st at the top), the
 * sites cited run by run, the searches by what they were after, the ads, and
 * the runs themselves. When the runs mix engines that is said as a fact. */
function renderOverTime(out, ot, { label, own, fmtAt, engineName }) {
  if (!ot) return;
  const sec = (id, title, sub) => {
    const c = el("section", { className: "card ot-sec", id },
      el("div", { className: "ot-head" }, atIconTile(id), el("h3", {}, title), sub ? el("span", { className: "muted small" }, sub) : null));
    out.append(c);
    return c;
  };
  const head = el("div", { className: "card ot-hero" },
    el("span", { className: "ot-chip" }, `Over time · ${plural(ot.runs.length, "run")}`),
    el("h2", { className: "ot-prompt" }, label),
    el("span", { className: "muted small" }, `${fmtAt(ot.runs[0].at)} → ${fmtAt(ot.runs[ot.runs.length - 1].at)} · ${ot.engines.map(engineName).join(", ")}`));
  if (ot.engines.length > 1) head.append(el("p", { className: "ot-note" }, `These runs come from ${atList(ot.engines.map(engineName))}, so the movement below mixes engines as well as time. The engine filter above narrows it to one.`));
  if (ot.runs.length === 1) head.append(el("p", { className: "ot-note" }, "Only one capture so far. A later answer to this prompt will be compared with it here."));
  out.append(head);

  if (ot.changed) {
    const c = ot.changed;
    const s1 = sec("ot-changed", `What changed, ${apDate(c.from)} → ${apDate(c.to)}`);
    const tiles = el("div", { className: "at-kpis" });
    const tile = (k, v) => tiles.append(el("div", { className: "at-kpi" }, el("span", { className: "at-kpi-k" }, k), el("span", { className: "at-kpi-v" }, v)));
    if (c.you) tile(`${own.name}’s place`, `${c.you.from ? apOrd(c.you.from) : "not named"} → ${c.you.to ? apOrd(c.you.to) : "not named"}`);
    tile("Cited sites kept", c.kept == null ? "—" : `${c.kept}%`);
    tile("Cited sites", `+${c.gained} · −${c.lost}`);
    tile("Searches", `${c.searches[0]} → ${c.searches[1]}`);
    if (c.words[0] && c.words[1]) tile("Answer length", `${c.words[0]} → ${c.words[1]} words`);
    s1.append(tiles);
    const SIGN = { added: "+", dropped: "−", up: "↑", down: "↓", same: "=", site: "↻", ad: "$" };
    const ul = el("ul", { className: "ap-changes" });
    c.items.forEach((x) => ul.append(el("li", {}, el("span", { className: `ap-sign s-${x.kind}`, "aria-hidden": "true" }, SIGN[x.kind] || "•"), x.text)));
    s1.append(ul);
  }

  if (ot.brandLines.length && ot.runs.length > 1) {
    const s2 = sec("ot-brands", "Where each brand came, run by run", "higher is better · a gap means not named");
    const maxPos = Math.max(3, ...ot.brandLines.flatMap((b) => b.positions));
    const W = 520, H = 40 + maxPos * 36, x0 = 40, x1 = W - 20;
    const xs = ot.runs.map((_, i) => (ot.runs.length === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (ot.runs.length - 1)));
    const y = (p) => 20 + (p - 1) * 36;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "ot-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Brand positions per run: " + ot.brandLines.map((b) => `${b.name} ${b.trend}`).join("; "));
    const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v))); if (text != null) n.textContent = text; svg.append(n); return n; };
    for (let p = 1; p <= maxPos; p++) { add("line", { x1: x0 - 8, x2: x1, y1: y(p), y2: y(p), class: "ot-grid" }); add("text", { x: 0, y: y(p) + 4, class: "ot-axis" }, apOrd(p)); }
    ot.runs.forEach((r, i) => add("text", { x: xs[i], y: H - 4, "text-anchor": "middle", class: "ot-axis" }, apDate(r.at).replace(/^\w+,?\s*/, "")));
    ot.brandLines.forEach((b, j) => {
      const cls = b.isYou ? "ot-line you" : `ot-line c${j % 6}`;
      // A gap where the brand wasn't named: one polyline per unbroken stretch.
      let seg = [];
      const flush = () => { if (seg.length > 1) add("polyline", { points: seg.join(" "), class: cls, fill: "none" }); seg = []; };
      b.positions.forEach((p, i) => { if (p) seg.push(`${xs[i]},${y(p)}`); else flush(); });
      flush();
      b.positions.forEach((p, i) => { if (p) add("circle", { cx: xs[i], cy: y(p), r: b.isYou ? 6 : 4.5, class: cls }); });
    });
    const legend = el("div", { className: "ot-legend" });
    ot.brandLines.forEach((b, j) => legend.append(el("span", { className: `ot-leg${b.isYou ? " you" : ""}` },
      el("i", { className: b.isYou ? "ot-dot you" : `ot-dot c${j % 6}` }), el("span", {}, b.name), el("b", { className: b.up > 0 ? "up" : b.up < 0 || b.trend === "gone" ? "down" : "" }, b.trend))));
    s2.append(el("div", { className: "ot-chart-wrap" }, svg, legend));
  }

  if (ot.sites.length && ot.runs.length > 1) {
    const s3 = sec("ot-sites", "Sites cited, run by run", "filled = cited in that run");
    const grid = el("div", { className: "at-grid-table ot-sites", role: "table", style: `grid-template-columns: minmax(150px, 1.4fr) repeat(${ot.runs.length}, minmax(34px, 60px)) 96px` });
    const row = (...cells) => el("div", { className: "at-grid-row", role: "row" }, ...cells);
    grid.append(row(el("span", { role: "columnheader" }, "Site"), ...ot.runs.map((r) => el("span", { role: "columnheader", className: "c", title: fmtAt(r.at) }, `#${r.n}`)), el("span", { role: "columnheader" }, "Trend")));
    ot.sites.forEach((x) => grid.append(row(el("span", { role: "rowheader", className: "at-matrix-site" }, x.domain),
      ...x.cells.map((on, i) => el("span", { role: "cell", className: "c", "aria-label": `run ${i + 1}: ${on ? "cited" : "not cited"}` }, el("i", { className: on ? "dot cited" : "dot none" }))),
      el("span", { role: "cell" }, el("span", { className: `ot-trend t-${x.trend.replace(/\s.*$/, "")}` }, x.trend)))));
    s3.append(el("div", { className: "at-scroll" }, grid));
  }

  if (ot.intents.length) {
    const s4 = sec("ot-search", "Searches over time", "grouped by what they were after");
    const g = el("div", { className: "ot-intents" });
    ot.intents.forEach((i) => g.append(el("div", { className: "ot-intent" },
      el("span", { className: "ot-intent-h" }, el("b", {}, i.label), el("span", { className: "muted small" }, `in ${i.inRuns} of ${ot.runs.length} runs`)),
      ...i.queries.map((q) => el("span", { className: "ot-q" }, q)))));
    s4.append(g);
  }

  if (ot.anyAds) {
    const s5 = sec("ot-ads", "Ads, run by run", "Not captured: clicks, impressions and cost");
    ot.runs.forEach((r) => s5.append(el("div", { className: "at-cmp-ad" }, el("span", {}, `#${r.n} · ${apDate(r.at)}`),
      el("span", { className: r.ads.length ? "" : "ap-muted" }, r.ads.length ? `An ad from ${atList(r.ads)}` : r.platform === "chatgpt" ? "No ad" : `${engineName(r.platform)}: no ad format`))));
  }

  const s6 = sec("ot-runs", "Run by run");
  const t = el("div", { className: "at-table ot-runs", role: "table" });
  const heads = ["#", "When", "Engine", "Named first", own ? own.name : null, "Searches", "Read", "Cited", "Brands", "Words", ""].filter((h) => h !== null);
  t.append(el("div", { className: `at-tr at-th${own ? " has-you" : ""}`, role: "row" }, ...heads.map((h) => el("span", { role: "columnheader" }, h))));
  ot.runs.forEach((r) => {
    const open = el("button", { className: "at-btn sm", type: "button" }, "Open");
    open.onclick = () => openCapture(r.captureId);
    t.append(el("div", { className: `at-tr${own ? " has-you" : ""}`, role: "row" },
      el("span", { role: "cell", className: "ap-muted" }, String(r.n)),
      el("span", { role: "cell" }, fmtAt(r.at)),
      el("span", { role: "cell" }, el("i", { className: `at-eng-dot e-${r.platform}` }), ` ${engineName(r.platform)}`),
      el("span", { role: "cell" }, r.first || "—"),
      own ? el("span", { role: "cell" }, el("span", { className: `at-rank-chip${r.you === 1 ? " first" : r.you ? "" : " none"}` }, r.you ? apOrd(r.you) : "not named")) : null,
      el("span", { role: "cell" }, r.searched ? (r.searches ? String(r.searches) : "not shown") : "none"),
      el("span", { role: "cell" }, String(r.read)), el("span", { role: "cell" }, String(r.cited)),
      el("span", { role: "cell" }, String(r.brands)), el("span", { role: "cell" }, r.words ? String(r.words) : "—"),
      el("span", { role: "cell" }, open)));
  });
  s6.append(el("div", { className: "at-scroll" }, t));
}

function renderCompare() {
  const out = $("#cmpOut");
  if (!out) return;
  out.textContent = "";

  const key = $("#cmpPrompt") ? $("#cmpPrompt").value : "";
  if (!key) {
    out.append(el("div", { className: "empty" }, "Choose a prompt above to see how its results changed over time."));
    return;
  }
  const timeline = promptTimelines().find((t) => t.key === key);
  if (!timeline || !timeline.captures.length) {
    out.append(el("div", { className: "empty" }, "No captures for that prompt with the current filters."));
    return;
  }

  const caps = timeline.captures;
  const points = caps.map((r) => ({ rec: r, ...pointAggregate(r) }));
  const fmtAt = (t) => new Date(t).toLocaleString(dateLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const engineName = (id) => ENGINES.find((e) => e.id === id)?.label || id;

  // --- the canvas's Over time board (0.60.0): the movement itself ---
  // Where each brand came in each run, which sites each run cited, what the
  // searches were after, the ads, and what changed from the first run to the
  // latest. The count matrices that this page had before follow, under
  // "Every count, run by run".
  const own = ownBrandFor(caps[caps.length - 1], GEO_PROFILES);
  const ot = overTimeView(caps, { own });
  renderOverTime(out, ot, { label: timeline.label, own, fmtAt, engineName });

  if (caps.length < 2) return;

  const first = points[0];
  const last = points[points.length - 1];
  const setOf = (m) => new Set(m.keys());
  const domsFirst = setOf(first.domains), domsLast = setOf(last.domains);
  const urlsFirst = setOf(first.urls), urlsLast = setOf(last.urls);
  const brandsFirst = setOf(first.brands), brandsLast = setOf(last.brands);
  const diff = (a, b) => [...b].filter((x) => !a.has(x));
  const gainedDom = diff(domsFirst, domsLast), lostDom = diff(domsLast, domsFirst);
  const gainedUrl = diff(urlsFirst, urlsLast), lostUrl = diff(urlsLast, urlsFirst);
  const gainedBrand = diff(brandsFirst, brandsLast), lostBrand = diff(brandsLast, brandsFirst);
  const gainedQ = [...last.queries].filter((q) => !first.queries.has(q));
  const lostQ = [...first.queries].filter((q) => !last.queries.has(q));
  out.append(el("h3", { className: "ot-more-h" }, "Every count, run by run"));

  // --- matrix helper: rows = item, columns = each capture in time order ---
  function matrixCard(title, subtitle, rows, opts = {}) {
    if (!rows.length) return null;
    const card = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, title)));
    if (subtitle) card.append(el("div", { className: "muted small", style: "margin-bottom:8px" }, subtitle));
    const t = el("table", { className: "drill-table cmp-matrix" });
    const hr = el("tr", {}, el("th", {}, opts.nameHeader || "Name"));
    caps.forEach((r, i) => hr.append(el("th", {
      className: "num cmp-col",
      title: `${fmtAt(r.capturedAt)} · ${engineName(r.platform)}`,
    }, engineIconEl(r.platform), String(i + 1))));
    hr.append(el("th", { className: "num", title: "How many of the runs this appeared in" }, "Seen"));
    hr.append(el("th", { className: "num" }, "Trend"));
    t.append(hr);
    rows.forEach((row) => {
      const rowEl = el("tr", {});
      rowEl.append(el("td", { title: row.name }, row.name));
      row.values.forEach((v) => {
        rowEl.append(el("td", { className: `num${v.n ? "" : " cmp-absent"}` }, v.label));
      });
      rowEl.append(el("td", { className: "num" }, stabilityTag(row.values.filter((v) => v.n > 0 || v.label !== "—").length, caps.length)));
      rowEl.append(el("td", { className: "num" }, deltaTag(row.delta)));
      t.append(rowEl);
    });
    card.append(el("div", { className: "drill-scroll" }, t));
    return card;
  }

  const buildRows = (allKeys, valueFor) => [...allKeys].map((name) => {
    const values = points.map((p) => valueFor(p, name));
    const firstN = values[0].n, lastN = values[values.length - 1].n;
    return { name, values, delta: lastN - firstN, lastN };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.lastN - a.lastN);

  // --- brand presence over time ---
  const allBrands = new Set();
  points.forEach((p) => p.brands.forEach((_, b) => allBrands.add(b)));
  const brandRows = buildRows(allBrands, (p, name) => {
    const v = p.brands.get(name);
    if (!v) return { n: 0, label: "—" };
    if (v.count === 0) return { n: 0, label: "shown" }; // present, but not narrated
    return { n: v.count, label: String(v.count) };
  });
  const bCard = matrixCard(
    "Brand mentions over time",
    "How many times each brand was named in the answer, at each run. “shown” = appeared in a product card but was never named.",
    brandRows, { nameHeader: "Brand" }
  );
  if (bCard) out.append(bCard);

  // --- domain presence over time ---
  const allDomains = new Set();
  points.forEach((p) => p.domains.forEach((_, d) => allDomains.add(d)));
  const domRows = buildRows(allDomains, (p, name) => {
    const v = p.domains.get(name);
    if (!v) return { n: 0, label: "—" };
    const total = v.cited + v.fetched;
    return { n: total, label: v.cited ? `${total} (c)` : String(total) };
  });
  const dCard = matrixCard(
    "Source domains over time",
    "Times each domain appeared per run. “(c)” marks a domain that was actually cited, not just fetched.",
    domRows.slice(0, 60), { nameHeader: "Domain" }
  );
  if (dCard) out.append(dCard);

  // --- exact pages over time ---
  // Domain-level movement hides the thing that's usually actionable: the same
  // publisher staying put while the specific ranking page swaps underneath it.
  const allUrls = new Set();
  points.forEach((p) => p.urls.forEach((_, u) => allUrls.add(u)));
  const urlRows = buildRows(allUrls, (p, name) => {
    const v = p.urls.get(name);
    if (!v) return { n: 0, label: "—" };
    const total = v.cited + v.fetched;
    return { n: total, label: v.cited ? `${total} (c)` : String(total) };
  });
  const uCard = matrixCard(
    "Exact pages over time",
    "The individual URLs behind those domains — a publisher can hold its place while the specific page that ranks changes underneath it.",
    urlRows.slice(0, 60), { nameHeader: "URL" }
  );
  if (uCard) out.append(uCard);

  // --- fan-out query churn ---
  // The sub-queries are the engine's own interpretation of the prompt; when
  // they drift, the source list usually drifts with them, and that's the
  // upstream cause worth seeing next to the effect.
  const allQueries = new Set();
  points.forEach((p) => p.queries.forEach((q) => allQueries.add(q)));
  const qRows = buildRows(allQueries, (p, name) => (p.queries.has(name) ? { n: 1, label: "✓" } : { n: 0, label: "—" }));
  const qCard = matrixCard(
    "Search fan-out over time",
    "Which sub-queries the engine ran before answering. Drift here is usually what moves the source list below it.",
    qRows.slice(0, 60), { nameHeader: "Sub-query" }
  );
  if (qCard) out.append(qCard);

  // --- explicit gained/lost lists ---
  const movement = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Gained and lost")));
  movement.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
    "Comparing the first run against the latest one only — the matrices above show everything in between."));
  const ml = el("ul", { className: "itemlist" });
  const addRow = (label, items, cls) => {
    const li = el("li", {});
    const h = el("div", { className: "item-head" });
    h.append(el("span", { className: "item-name" }, label), el("span", { className: `tag ${cls}` }, String(items.length)));
    li.append(h);
    li.append(el("div", { className: "muted item-sub" }, items.length ? items.join(", ") : "—"));
    ml.append(li);
  };
  addRow("Brands newly appearing", gainedBrand, "cited");
  addRow("Brands no longer appearing", lostBrand, "fetched");
  addRow("Domains newly appearing", gainedDom, "cited");
  addRow("Domains no longer appearing", lostDom, "fetched");
  addRow("Pages newly appearing", gainedUrl, "cited");
  addRow("Pages no longer appearing", lostUrl, "fetched");
  addRow("Sub-queries newly run", gainedQ, "cited");
  addRow("Sub-queries no longer run", lostQ, "fetched");
  movement.append(ml);
  out.append(movement);


  // --- export this timeline ---
  const bar = el("div", { className: "dlbar" });
  const dl = el("button", { className: "btn sm" }, "⬇ Export this timeline (CSV)");
  dl.onclick = () => {
    const rows = [["prompt", "type", "name", ...caps.map((r, i) => `#${i + 1} ${r.platform} ${new Date(r.capturedAt).toISOString()}`), "delta"]];
    const push = (type, list) => list.forEach((r) => rows.push([timeline.label, type, r.name, ...r.values.map((v) => v.label), r.delta]));
    push("brand", brandRows);
    push("domain", domRows);
    push("url", urlRows);
    push("fanout-query", qRows);
    points.forEach((p, i) => rows.push([timeline.label, "run-summary", `#${i + 1} ${p.rec.platform}`,
      ...points.map((_, j) => (j === i ? `cited=${p.cited} fetched=${p.fetched} domains=${p.domains.size} fanout=${p.queries.size} chars=${p.answerChars}` : "")), ""]));
    download(`citoskeleton-timeline-${Date.now()}.csv`, csvOf(rows), "text/csv");
  };
  bar.append(dl);
  out.append(el("div", { className: "card" }, bar));
}

const cmpSearchInp = $("#cmpSearch");
if (cmpSearchInp) {
  cmpSearchInp.addEventListener("input", () => {
    cmpSearch = cmpSearchInp.value;
    // Only the <option> list is rebuilt here, not the whole tab, so this
    // input keeps focus on its own and needs no selection-restore dance.
    refreshComparePickers();
  });
}

$("#cmpBack")?.addEventListener("click", () => showTab("analyze"));

["#cmpPrompt", "#cmpProject", "#cmpModel"].forEach((id) => {
  const node = $(id);
  if (!node) return;
  node.addEventListener("change", () => {
    if (id === "#cmpProject") cmpProjectFilter = node.value;
    if (id === "#cmpModel") cmpModelFilter = node.value;
    if (id !== "#cmpPrompt") refreshComparePickers();
    renderCompare();
  });
});

loadSettings();


// .catch() is the whole point here: load() is fired-and-forgotten (nothing
// awaits it), so ANY exception anywhere in its chain — not just the
// send()-throws case handled inside load() itself — becomes a silent
// unhandled promise rejection with the popup left exactly as the static
// HTML shell renders it: header and tabs present, every panel completely
// empty. That reads as "the tool is broken" with zero information to act
// on. This is the last-resort net for whatever isn't already handled
// upstream, so at least the failure is visible and includes the real error.
mountShareIcon();
load().then(maybeFirstRun).catch((err) => { // also fills the Compare pickers, after projects are known
  console.error("panel load() failed:", err);
  const root = $("#analyze");
  if (root) {
    root.textContent = "";
    root.append(
      el("div", { className: "card warn-box", style: "margin: 20px; color: var(--red-fg);" },
        el("h3", {}, "Something went wrong loading this panel"),
        el("p", {}, "Try closing this popup and reopening it. If it keeps happening, reloading the extension from chrome://extensions may help."),
        el("p", { className: "muted", style: "font-size: 11px;" }, `Details: ${esc(err && err.message ? err.message : String(err))}`)
      )
    );
  }
});

/* ==========================================================================
 * First-run tour + sample data
 *
 * On a fresh install every screen renders as zeros, so there is no way to
 * tell what the tool measures or whether it's even working. Asking someone to
 * go run a campaign first — on an engine they may not be signed into — just
 * to find out what the screens do is a poor first five minutes.
 *
 * Two halves, deliberately separable:
 *   - SAMPLE DATA: one realistic capture (src/lib/demo-data.js) so the panels
 *     have something to render. Clearly labelled, removable in one click, and
 *     never mistakable for a real capture.
 *   - THE GUIDE: since 0.81.0 a full page of its own (ui/welcome.html), in
 *     pictures, ending with the email sign-up. The worker opens it once on
 *     install; a panel that finds it never opened opens it once too. It
 *     replaced the modal tour drawn over the panel, which kept coming back.
 *
 * Shown once: the flag is kept in the extension's storage as well as this
 * page's. Re-openable from About.
 * ========================================================================== */
const TOUR_SEEN_KEY = "cito-tour-seen";

// First run: load the sample capture, so the screens have something on them,
// and make sure the welcome guide has been shown once.
// Kept in the extension's own storage as well as this page's (0.80.0), so the
// popup, the full tab and a reload all agree it has been seen.
function markTourSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, "1"); } catch (_) {}
  try { chrome.storage.local.set({ [TOUR_SEEN_KEY]: Date.now() }); } catch (_) {}
}
async function tourSeen() {
  try { if (localStorage.getItem(TOUR_SEEN_KEY) === "1") return true; } catch (_) { return true; }
  try { const got = await chrome.storage.local.get(TOUR_SEEN_KEY); if (got && got[TOUR_SEEN_KEY]) { localStorage.setItem(TOUR_SEEN_KEY, "1"); return true; } } catch (_) { /* treat as unseen */ }
  return false;
}
async function maybeFirstRun() {
  if (await tourSeen()) return;
  try {
    const status = await send({ type: "demo-status" });
    // Someone with real captures already knows what this is; don't push
    // sample rows into a store that has genuine data in it.
    if (status && status.ok && !status.present && status.real === 0) {
      await send({ type: "demo-load" });
      await load();
    }
  } catch (_) {
    // Sample data is a nicety — never block the tour, or the panel, on it.
  }
  // Asked again after the wait above: it may have been seen meanwhile (in
  // the other view, or set by a test), and it must open only once.
  if (await tourSeen()) return;
  markTourSeen();
  send({ type: "welcome-open-once" });
}
function openWelcome() {
  try { chrome.tabs.create({ url: chrome.runtime.getURL("ui/welcome.html") }); } catch (_) { window.open("welcome.html", "_blank"); }
}

/* About-tab controls for the sample data and the tour. */
/* About's sample-data and tour controls. The popup's home also says when the
   sample is on, with its own Remove. */
async function refreshDemoControls() {
  let st = null;
  try { st = await send({ type: "demo-status" }); } catch (_) {}
  abDemo = st;
  const present = !!(st && st.ok && st.present);
  const btn = $("#demoToggle");
  if (btn) btn.textContent = tr(present ? "Remove sample" : "Load sample");
  const chip = $("#demoStatus");
  if (chip) {
    chip.textContent = tr(present ? "Loaded" : "Not loaded");
    chip.className = `ab-chip${present ? " on" : ""}`;
  }
  if (abCurrent() === "home" && $("#about")?.classList.contains("active")) renderAboutHome();
}

async function abToggleSample() {
  let st = null;
  try { st = await send({ type: "demo-status" }); } catch (_) {}
  const present = !!(st && st.ok && st.present);
  await send({ type: present ? "demo-clear" : "demo-load" });
  FULL.clear();
  await load();
  await refreshDemoControls();
}

$("#demoToggle")?.addEventListener("click", withBusy($("#demoToggle"), "Working…", abToggleSample));

$("#replayTour")?.addEventListener("click", () => openWelcome());

/* About → Settings → Email for updates (0.81.0): the email given on the
 * welcome page, changed or removed here. Same checks as there
 * (lib/emailCheck.js); kept in chrome.storage.local under citoSignup. */
const SIGNUP_KEY = "citoSignup";
async function renderEmailSetting() {
  const input = $("#setEmail"), state = $("#setEmailState"), msg = $("#setEmailMsg"), rm = $("#setEmailRemove");
  if (!input) return;
  let got = null;
  try { got = (await chrome.storage.local.get(SIGNUP_KEY))[SIGNUP_KEY] || null; } catch (_) { /* nothing kept */ }
  if (got && got.email) {
    input.value = got.email;
    state.textContent = "You'll hear about updates and offers at this address. Only the developer sees it; it's never shared.";
    rm.hidden = false;
  } else {
    input.value = "";
    state.textContent = tr(got && got.skipped ? "Not given. Without it you won't hear about new features and fixes." : "Only for news about CitoSkeleton's updates and offers. Never shared with anyone else.");
    rm.hidden = true;
  }
  msg.textContent = "";
  msg.className = "ab-email-msg";
}
$("#setEmailSave")?.addEventListener("click", async () => {
  const msg = $("#setEmailMsg");
  const r = checkEmail($("#setEmail").value);
  if (!r.ok) { msg.textContent = r.message; msg.className = "ab-email-msg bad"; return; }
  const btn = $("#setEmailSave");
  if (r.reason === "typo" && btn.dataset.typo !== r.email) {
    btn.dataset.typo = r.email;
    msg.textContent = `${r.message} Press Save again to keep yours.`;
    msg.className = "ab-email-msg warn";
    return;
  }
  delete btn.dataset.typo;
  try { await chrome.storage.local.set({ [SIGNUP_KEY]: { email: r.email, at: Date.now(), consent: true, sent: false, source: "settings" } }); } catch (_) { /* nothing to keep it in */ }
  send({ type: "signup-saved" });
  await renderEmailSetting();
  const m = $("#setEmailMsg");
  m.textContent = "Saved ✨";
  m.className = "ab-email-msg ok";
});
$("#setEmailRemove")?.addEventListener("click", async () => {
  try { await chrome.storage.local.set({ [SIGNUP_KEY]: { skipped: true, removedAt: Date.now(), at: Date.now() } }); } catch (_) { /* nothing kept */ }
  send({ type: "signup-removed" });
  await renderEmailSetting();
  showToast("Email removed. You won't get update news.");
});
renderEmailSetting();
try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[SIGNUP_KEY]) renderEmailSetting(); }); } catch (_) { /* no storage events */ }

/* About → Account (0.82.0): sign in with a code sent by email (no
 * password), the name shown on campaigns you share, and those campaigns,
 * each with Stop sharing. Off, and saying so, until accounts are switched
 * on (src/lib/cloudConfig.js). */
function openAccount() {
  abGoTab("about");
  abGo("account");
}
let acctEmail = "";
async function renderAccount() {
  const box = $("#abAccount");
  if (!box) return;
  const card = el("div", { className: "card ab-card ac-card" },
    el("div", { className: "ab-head ab-tab-only" }, el("div", {}, el("h2", { className: "ab-title" }, "Account"), el("p", { className: "ab-sub" }, "Only needed to share campaigns by code. Your captures stay on this computer either way."))));
  box.replaceChildren(card);
  const st = await send({ type: "cloud-status" });
  const msg = el("p", { className: "ab-email-msg", role: "status", id: "acMsg" });
  const say = (t, cls = "") => { msg.textContent = t; msg.className = `ab-email-msg ${cls}`; };
  if (!st || !st.ready) {
    card.append(el("p", { className: "ac-off", id: "acOff" }, "Accounts aren't switched on yet. You can still share any campaign as a file: Campaigns → ⋯ → Share campaign…, and open one with Campaigns → Import…"));
    return;
  }
  if (!st.signedIn) {
    const email = el("input", { type: "email", id: "acEmail", className: "filter", placeholder: "you@company.com", autocomplete: "email", value: acctEmail });
    const sendBtn = el("button", { className: "btn sm primary", type: "button", id: "acSend" }, "Email me a code");
    const code = el("input", { type: "text", id: "acCode", className: "filter ac-code", inputMode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", maxLength: 10 });
    const verify = el("button", { className: "btn sm primary", type: "button", id: "acVerify" }, "Sign in");
    const step2 = el("div", { className: "ac-row", hidden: !acctEmail }, code, verify);
    sendBtn.onclick = withBusy(sendBtn, "Sending…", async () => {
      const r = await send({ type: "cloud-request-code", email: email.value });
      if (!r || !r.ok) return say((r && r.error) || "Couldn't send the code.", "bad");
      acctEmail = r.email;
      step2.hidden = false;
      say(`Code sent to ${r.email}. It's good for an hour.`, "ok");
      code.focus();
    });
    verify.onclick = withBusy(verify, "Checking…", async () => {
      const r = await send({ type: "cloud-verify", email: acctEmail || email.value, code: code.value });
      if (!r || !r.ok) return say((r && r.error) || "That code didn't work.", "bad");
      acctEmail = "";
      renderAccount();
    });
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") verify.click(); });
    card.append(el("div", { className: "ac-row" }, email, sendBtn), step2, msg, el("p", { className: "muted small" }, "No password: each time, we email you a code. The email is used to sign you in, nothing else."));
    return;
  }
  const u = st.user || {};
  const name = el("input", { type: "text", id: "acName", className: "filter", maxLength: 60, placeholder: "Your name or team", value: u.name || "" });
  const saveName = el("button", { className: "btn sm ghost", type: "button", id: "acNameSave" }, "Save");
  saveName.onclick = withBusy(saveName, "Saving…", async () => {
    const r = await send({ type: "cloud-profile-save", name: name.value });
    say(r && r.ok ? "Saved ✨" : (r && r.error) || "Couldn't save it.", r && r.ok ? "ok" : "bad");
  });
  const out = el("button", { className: "btn sm ghost", type: "button", id: "acSignOut" }, "Sign out");
  out.onclick = withBusy(out, "Signing out…", async () => { await send({ type: "cloud-sign-out" }); renderAccount(); });
  const list = el("div", { className: "ac-shares", id: "acShares" }, el("p", { className: "muted small" }, "Loading…"));
  card.append(
    el("div", { className: "ac-who" }, glyphEl("user", 18), el("b", { id: "acWho" }, u.email || ""), out),
    el("label", { className: "ab-label", for: "acName" }, "Name on what you share"), el("div", { className: "ac-row" }, name, saveName), msg,
    el("h3", { className: "ab-h3" }, "Campaigns you've shared"), list);
  const r = await send({ type: "cloud-shares" });
  list.textContent = "";
  if (!r || !r.ok) { list.append(el("p", { className: "muted small" }, (r && r.error) || "Couldn't load them.")); return; }
  if (!r.shares.length) { list.append(el("p", { className: "muted small" }, "None yet. Share one from Campaigns → ⋯ → Share campaign…")); return; }
  for (const s of r.shares) {
    const stop = el("button", { className: "btn sm ghost danger", type: "button" }, "Stop sharing");
    stop.onclick = withBusy(stop, "Stopping…", async () => {
      if (!confirm(`Stop sharing ${s.name}? The code ${s.code} stops working. Anyone who already imported it keeps their copy.`)) return;
      const x = await send({ type: "cloud-share-revoke", code: s.code });
      if (x && x.ok) renderAccount(); else say((x && x.error) || "Couldn't stop it.", "bad");
    });
    list.append(el("div", { className: "ac-share" },
      el("div", {}, el("b", {}, s.name), el("span", { className: "muted small" }, ` · ${s.code.slice(0, 5)}-${s.code.slice(5)} · ${fmtMB(s.bytes || 0)} · opened ${plural(s.downloads || 0, "time")} · until ${new Date(s.expires_at).toLocaleDateString(uiLang())}`)),
      stop));
  }
}

refreshDemoControls();

/* Rows that scroll sideways (a campaign's section tabs, the Dashboard's kinds
 * in the popup) fade at the edge that has more (0.84.0): their scrollbar is
 * hidden, and the popup used to cut a chip off with no sign there was more. */
const OVERFLOW_ROWS = ".cv-tabs, .db-kindchips";
function syncOverflowEdges(root = document) {
  root.querySelectorAll(OVERFLOW_ROWS).forEach((n) => {
    const more = n.scrollWidth - n.clientWidth > 2;
    n.classList.toggle("overflow-start", more && n.scrollLeft > 2);
    n.classList.toggle("overflow-end", more && n.scrollLeft < n.scrollWidth - n.clientWidth - 2);
  });
}
{
  let t = 0;
  const later = () => { clearTimeout(t); t = setTimeout(() => syncOverflowEdges(), 80); };
  try { new MutationObserver(later).observe(document.body, { childList: true, subtree: true }); } catch (_) { /* no body */ }
  document.addEventListener("scroll", (e) => { if (e.target && e.target.matches && e.target.matches(OVERFLOW_ROWS)) syncOverflowEdges(e.target.parentNode || document); }, true);
  window.addEventListener("resize", later);
  later();
  // A mouse wheel scrolls these rows sideways (1.0.4): their scrollbar is
  // hidden, so at 820 px a campaign's Searches and Signals tabs could only be
  // reached with a trackpad or the keyboard. A sideways swipe is left alone.
  document.addEventListener("wheel", (e) => {
    const row = e.target && e.target.closest && e.target.closest(OVERFLOW_ROWS);
    if (!row || Math.abs(e.deltaX) > Math.abs(e.deltaY) || row.scrollWidth - row.clientWidth <= 2) return;
    const before = row.scrollLeft;
    row.scrollLeft += e.deltaY;
    if (row.scrollLeft !== before) e.preventDefault();
  }, { passive: false });
}

/* Text cut off with "…" shows in full on hover (1.0.4): citation and page
 * titles, product names and prompts were cut with no way to read them. Any
 * element whose text overflows and has no tooltip gets its own text as one,
 * the moment the pointer reaches it. */
document.addEventListener("mouseover", (e) => {
  const n = e.target;
  if (!n || n.nodeType !== 1 || n.title || n.children.length > 3) return;
  if (n.scrollWidth <= n.clientWidth + 1) return;
  const text = (n.textContent || "").trim();
  if (text && text.length > 3) n.title = text.length > 400 ? `${text.slice(0, 397)}…` : text;
}, true);

/* A model download in progress, shown in the app bar on every page
 * (0.84.0): it used to show only in Settings, so leaving the page made it
 * look like nothing was happening. It opens Ask, where the switch is. */
{
  const chip = document.getElementById("modelDl");
  let t = 0;
  const tick = async () => {
    clearTimeout(t);
    const s = await send({ type: "ai-status" }).catch(() => null);
    // The one actually downloading: the other may be waiting its turn (1.0.0).
    const waiting = (x) => !!(x && /waiting/.test(x.status || ""));
    const llmP = s && s.downloading ? s.progress : null;
    const layaP = s && s.laya && s.laya.downloading ? s.laya.progress : null;
    const p = llmP && !waiting(llmP) ? llmP : layaP && !waiting(layaP) ? layaP : llmP || layaP;
    const busy = !!(s && (s.downloading || (s.laya && s.laya.downloading)));
    if (chip) {
      chip.hidden = !busy;
      const pct = p && p.pct != null ? Math.max(0, Math.min(100, Math.round(p.pct))) : null;
      chip.querySelector(".model-dl-pct").textContent = pct == null ? "…" : `${pct}%`;
      chip.style.setProperty("--pct", String(pct || 0));
      chip.setAttribute("aria-label", `${tr(`Downloading ${s && s.downloading ? "Ask's AI model" : "Fast labels"}`)}${pct == null ? "" : `, ${pct}%`}`);
    }
    if (busy) t = setTimeout(tick, 1500);
  };
  chip?.addEventListener("click", () => showTab("ask"));
  try { chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "ai-state") tick(); }); } catch (_) { /* not in the extension */ }
  document.addEventListener("change", (e) => { if (e.target && /^sw(AskModel|Laya)$/.test(e.target.id)) setTimeout(tick, 600); });
  tick();
}

/* "Your last question on Gemini wasn't captured" (0.84.0). Asked: the
 * everyday capture "is getting broken with each update". When it is, the
 * person should know at once, with the two things that help: refreshing
 * that tab, and the capture report to send us. */
{
  const ENGINE_NAME = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
  const box = document.getElementById("missedBanner");
  const ago = (t) => { const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m === 1 ? "a minute ago" : `${m} minutes ago`; };
  const draw = (list) => {
    if (!box) return;
    box.replaceChildren();
    box.hidden = !list.length;
    for (const m of list) {
      const name = ENGINE_NAME[m.engine] || m.engine;
      const refresh = el("button", { className: "btn sm", type: "button" }, `Refresh the ${name} tab`);
      refresh.onclick = async () => { if (m.tabId != null) await send({ type: "capture-refresh-tab", tabId: m.tabId }); await send({ type: "capture-missed-dismiss", engine: m.engine }); check(); showToast(`Refreshed. Ask ${name} again and it will be captured.`); };
      const report = el("button", { className: "btn sm ghost", type: "button" }, "Copy capture report");
      report.onclick = async () => {
        const r = await send({ type: "capture-check" });
        try { await navigator.clipboard.writeText((r && r.report) || ""); showToast("Copied. Paste it in a message to us."); } catch (_) { showToast("Couldn't copy: About → Diagnostics has the report.", "error"); }
      };
      const close = el("button", { className: "missed-x", type: "button", "aria-label": "Dismiss" }, "×");
      close.onclick = async () => { await send({ type: "capture-missed-dismiss", engine: m.engine }); check(); };
      box.append(el("div", { className: "missed-row", "data-engine": m.engine },
        el("div", { className: "missed-text" }, el("b", {}, `Your question on ${name} (${ago(m.askedAt)}) wasn't captured.`),
          el("span", {}, "The page may have lost its link to CitoSkeleton, or the site changed how it sends answers.")),
        el("div", { className: "missed-btns" }, refresh, report, close)));
    }
  };
  // One check at a time, one timer. Every capture calls check(), and two
  // checks in flight together each set a 20 s timer, so the loops multiplied
  // with every burst of captures and never stopped: after an hour of a
  // campaign run, the open panels sent hundreds of capture-missed requests
  // every few seconds and slowed the worker (live run, 23 Nov 2026).
  let t = 0;
  let inFlight = false;
  let again = false;
  const check = async () => {
    clearTimeout(t);
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      let afterMs;
      try { afterMs = Number(localStorage.getItem("cito-test-missed-after")) || undefined; } catch (_) { /* none */ }
      const r = await send({ type: "capture-missed", afterMs }).catch(() => null);
      draw((r && r.ok && r.missed) || []);
    } finally { inFlight = false; }
    if (again) { again = false; check(); return; }
    clearTimeout(t);
    t = setTimeout(check, 20000);
  };
  try { chrome.runtime.onMessage.addListener((m) => { if (m && (m.type === "new-capture" || m.type === "capture-updated")) check(); }); } catch (_) { /* not in the extension */ }
  check();
}
