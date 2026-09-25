/* panel.js — UI. Talks to the service worker; never touches storage directly. */

// The one exception to "never touches storage directly": exportDoc.js is a
// pure rendering module (record[] -> HTML string), no chrome.* / storage
// calls of its own — see src/lib/exportDoc.js header. Data still only ever
// arrives here via send()/hydrate() through the service worker.
import { buildExportModel, renderStandaloneHtml } from "../src/lib/exportDoc.js";
import {
  ENGINES, availableEngines, MAX_PROFILES, SENTIMENT_NOTE, TRASH_RETENTION_DAYS,
  partitionRecords, allTags, runDue, runVolume, makeProfile,
} from "../src/lib/geo.js";
import { parseCsv, parseXlsx, rowsToPrompts } from "../src/lib/xlsxLite.js";
import { makeZip } from "../src/lib/zipWrite.js";
import { BUNDLE_PARTS, buildFeedbackFiles, bundleFilename } from "../src/lib/feedbackBundle.js";
import { computeSearchFunnel, computeBrandMatrix } from "../src/lib/funnel-omitted.js";
import { GLOSSARY, glossaryGroups } from "../src/lib/glossary.js";
import { normalizeMentions } from "../src/lib/mention-list.js";
import { aggregateSources, aggregateSourcesFromCaptures } from "../src/lib/sources.js";
import { analyzeFanout, FANOUT_BENCHMARK } from "../src/lib/fanout.js";
import { sanitizeText, trimLabel } from "../src/lib/text-sanitize.js";
import { formatCooldown } from "../src/lib/pacing.js";
import {
  computeVerbatimGrounding,
  computeAuthoritySplit,
  computeDomainExclusivity,
  computeSearchIntentGraph,
} from "../src/lib/grounding-score.js";

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
  }
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
  for (const [k, v] of Object.entries(props)) {
    // data-*/aria-* aren't real IDL properties — Object.assign used to just
    // stash them as plain JS properties on the element (no attribute, so
    // `[data-tip]` selectors and dataset reads never saw them). setAttribute
    // is what actually makes them queryable/CSS-selectable.
    if (k.startsWith("data-") || k.startsWith("aria-")) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ""));
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
      btn.textContent = original;
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
let PROJECTS = [];
let dashboardCampaignId = ""; // "" = no campaign selected
let dashboardGeoPrompts = []; // tracked prompts for dashboardCampaignId (tag chips only — independent of the Campaigns tab's own GEO_PROMPTS)
let dashboardSearch = ""; // filters Saved Conversations (and the ad-hoc stat grid) by prompt text
let viewingId = null; // which capture the Analyze tab shows (null = latest)
// Which tab to return to from Analyze, and what to call it in the "← Back
// to X" link. Set by openCapture() from whichever tab was active when a
// capture link was clicked (Dashboard's Saved Conversations or Prompt
// Performance table, Campaigns' own Prompt Performance, Compare's run
// links…), so following a link and coming back doesn't require re-finding
// whatever filter/scroll state was on that screen — combined with
// TAB_SCROLL below, showTab() restores it exactly as it was left.
let returnTab = null;
const TAB_LABELS = { dashboard: "Dashboard", loader: "Campaigns", compare: "Compare", about: "About" };
// Per-tab scroll position, keyed by panel id. All tabs share one physical
// scroll container (see withScrollPreserved below), so switching tabs via
// showTab() used to leave the scroll offset wherever the PREVIOUS tab left
// it — landing you somewhere unrelated to where you were on the tab you're
// switching TO (often clamped near the top if the other tab's content is
// shorter). This is what actually restores "come back to where you were."
const TAB_SCROLL = {};
let selectedIds = new Set(); // captures ticked in the Saved Conversations table
let showEmptyCaptures = false; // reveal zero-signal rows (see hasSignal note below)
// Tracking-run captures are hidden from the ad-hoc views by default so brand
// measurements and casual browsing never contaminate each other's numbers.
let includeTrackedInAdhoc = false;
let TRACKED_COUNT = 0;
// GEO tab state
let GEO_PROFILES = [];
let TRASHED_PROFILES = []; // soft-deleted campaigns, still within the recovery window
let GEO_PROMPTS = [];
let geoActiveId = null;
let geoTagFilter = [];
let geoEngineFilter = [];
// Reported: a campaign with many auto-generated tags (a 747-prompt import
// produced 20+) rendered every one of them, unconditionally, above the KPI
// tiles — three lines of pills before any actual number was visible. This
// caps the row until the user asks for more; resets each panel load (not
// persisted) since it's a display convenience, not a filter setting.
let geoTagsExpanded = false;
/* Which run the campaign view is scoped to. "" = every run of this campaign
   averaged together, which stays the default. Set by the run picker in the
   campaign header and by clicking a row in Run history. */
let geoRunFilter = "";
let geoRunsCache = [];
// Which brand the campaign view is pointed at. null = the campaign's own
// brand. Everything brand-shaped on the Dashboard — the KPI row, the
// per-engine split, the Prompt Performance columns — answers for THIS brand,
// so a competitor can be analysed with the same depth as your own brand
// instead of being a row you can only read across.
let geoFocusBrand = null;
// Whether the campaign card's supporting-detail disclosure is open. Kept
// across re-renders so changing a filter doesn't close it mid-read.
let geoDetailOpen = false;
// Campaigns tab (formerly Tracking + Loader) state
let promptTagFilter = []; // tag chips selected in the prompt table sidebar
let promptOnlyUnassigned = false;
let promptSearch = "";
let campaignManageOpen = false; // collapsible setup/prompts panel once a campaign is locked
let selectedPromptIds = new Set(); // checked rows in the prompt table, for bulk pause/enable/remove
const ONBOARD_KEY = "lcfc.onboarding.campaignsDismissed";
let campaignOnboardDismissed = true; // flips to false once we've checked storage, if unset
chrome.storage.local.get(ONBOARD_KEY, (r) => { campaignOnboardDismissed = !!r[ONBOARD_KEY]; });

// A capture with no prompt AND no fan-out/sources/products/places/answer text.
// ChatGPT's client races requests in parallel (force_parallel_switch:"auto",
// auto_switcher_race_winner) and retries — a losing/interrupted request still
// hits our capture endpoint but streams almost nothing. These are legitimate
// captures (raw data is kept, nothing is discarded), just not useful to browse,
// so the list hides them by default with a toggle to reveal.
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
const TOOLTIP_DELAY = 1500;
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
    // Always the same structured slots: term, what it measures, formula, howToUse guidance, and caveat note.
    tip.append(el("div", { className: "tip-term" }, g.term));
    tip.append(el("div", { className: "tip-what" }, g.what));
    if (g.formula) tip.append(el("div", { className: "tip-formula" }, g.formula));
    if (g.howToUse) {
      tip.append(el("div", { className: "tip-how-to-use" }, el("span", { className: "tip-how-to-use-badge" }, "💡 How to Use: "), g.howToUse));
    }
    if (g.note) tip.append(el("div", { className: "tip-note" }, g.note));
  } else {
    tip.append(el("div", { className: "tip-what" }, text));
  }
  tip.classList.toggle("is-term", !!g);
  tip.style.display = "block";
  tip.style.visibility = "hidden";
  const r = target.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = r.top - tr.height - 9;
  let placement = "top";
  if (top < 4) { top = r.bottom + 9; placement = "bottom"; }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top + window.scrollY)}px`;
  tip.dataset.placement = placement;
  const arrowX = Math.max(12, Math.min(r.left + r.width / 2 - left, tr.width - 12));
  tip.style.setProperty("--tip-arrow-x", `${Math.round(arrowX)}px`);
  tip.style.visibility = "visible";
  tip.classList.add("show");
}
function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  if (tipEl) { tipEl.classList.remove("show"); tipEl.style.display = "none"; }
}
document.addEventListener("mouseover", (ev) => {
  const target = ev.target.closest?.("[data-tip],[data-term]");
  if (!target) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTooltip(target), TOOLTIP_DELAY);
});
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
function withScrollPreserved(renderFn) {
  const scroller = activeScroller();
  const y = scroller ? scroller.scrollTop : 0;
  renderFn();
  if (scroller) scroller.scrollTop = y;
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
  if (panel) panel.classList.add("active");

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
  if (current && current !== "analyze") returnTab = current;
  viewingId = captureId;
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
          el("p", { style: "font-weight:600;" }, "Close this popup and reopen it (or refresh the page, if you're in Full tab view)."),
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
  await geoP; // populates GEO_PROFILES/GEO_PROMPTS so Dashboard can show campaign performance
  renderDashboard();

  const s = await statsP;
  const st = $("#status");
  if (st) st.textContent = s.ok ? `${s.derived} captures stored` : "";
  renderStorageInfo(s);
  // After PROJECTS is populated, so the project picker can be filled.
  refreshComparePickers();
  renderCompare();
}

function renderStorageInfo(s) {
  const box = $("#storageInfo");
  if (!box) return;
  if (!s || !s.ok) { box.textContent = ""; return; }
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
  box.textContent = s.usage
    ? `Storage: ${mb(s.usage.usedBytes)} used of ~${mb(s.usage.quotaBytes)} available · ${s.raw} raw / ${s.derived} derived captures`
    : `${s.raw} raw / ${s.derived} derived captures`;
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
function knownVendors(rec) {
  const out = [];
  for (const e of rec.entities || []) {
    if (e && e.text && /vendor|manufacturer|brand/i.test(e.category || "")) out.push(e.text);
  }
  for (const p of rec.products || []) {
    // "Realme P4 5G" -> "Realme". Only the first word, and only when it looks
    // like a name rather than a spec, so a product called "5G Router" can't
    // invent a vendor called "5G".
    const first = String(p.name || "").trim().split(/\s+/)[0];
    if (first && first.length > 1 && /^[A-Za-z][A-Za-z.&'-]*$/.test(first)) out.push(first);
  }
  return [...new Set(out)];
}

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

// Takes the brand's OWN passages (b.passages — each already a tight, correctly
// scoped ±110-char window around one real mention, computed by the adapter/
// src/lib/brands.js) instead of re-deriving a window from the full answer
// text. The previous version re-scanned a fresh 350-char slice of raw text
// and cut it off at the next hardcoded smartphone-brand name it could find —
// in dense side-by-side comparisons (several brands named within a couple of
// sentences of each other, e.g. a TV shootout) that cutoff landed almost
// immediately, so real aspects a few words later were silently missed. Using
// the passage(s) already scoped to THIS brand's own mentions avoids that
// failure mode entirely, and scanning every passage (not just the first)
// catches aspects raised at a brand's later mentions too.
//
// Aspects come from two places, in order of trust:
//
//  1. What the answer SAYS it rates the brand for — "best for <x>", "known for
//     <x>", "stands out for <x>". The label is lifted from the sentence, so it
//     works in any vertical without knowing a single industry word ("low
//     processing fees", "same-day delivery", "crack resistance").
//  2. A curated dimension map, as a fallback for answers that describe a brand
//     without ever labelling why. This used to be phone specs ONLY — camera,
//     battery, display, chipset — so a cement or lending answer either got
//     nothing or, worse, got "Performance" off the word "speed" and "Design"
//     off "premium". The map now spans the dimensions any category gets
//     compared on, and the phone-specific triggers only fire on words that
//     genuinely mean a phone spec.
const ASPECT_DIMENSIONS = [
  ["Price & Value", /\b(price|pricing|cost|affordable|budget|value for money|cheaper|expensive|premium pricing|discount|emi)\b/],
  ["Fees & Rates", /\b(interest rate|interest rates|apr|processing fee|processing fees|brokerage|commission|charges|no annual fee|expense ratio)\b/],
  ["Quality", /\b(quality|grade|purity|strength|finish|craftsmanship|ingredients|material|materials)\b/],
  ["Durability", /\b(durability|durable|long[- ]lasting|weather resistant|crack resistan|warranty|wear and tear)\b/],
  ["Service & Support", /\b(customer (?:service|support|care)|after[- ]sales|helpline|turnaround time|claim settlement|onboarding)\b/],
  ["Availability", /\b(availability|widely available|in stock|distribution network|dealer network|branches|nationwide|delivery time)\b/],
  ["Trust & Reputation", /\b(trusted|reputation|reliable|legacy|established|market leader|credibility|certified|regulated|iso )\b/],
  ["Safety", /\b(safety|safe for|side effects|clinically|dermatologically|non[- ]toxic|fda|hypoallergenic)\b/],
  ["Sustainability", /\b(sustainab|eco[- ]friendly|recycl|carbon|green building|organic|cruelty[- ]free)\b/],
  ["Camera", /\b(camera|cameras|megapixel|telephoto|portrait mode|hasselblad|optical zoom)\b/],
  ["Battery", /\b(battery|mah|fast charging|wireless charging|battery backup)\b/],
  ["Display", /\b(display|screen|amoled|oled|refresh rate|120hz|ltpo|hdr|dolby vision)\b/],
  ["Performance", /\b(processor|chipset|snapdragon|dimensity|benchmark|ram|cpu|gpu|thermal throttl)\b/],
  ["Software", /\b(software update|os update|years of updates|user interface|bloatware|ecosystem)\b/],
];

// "Best for gaming and photography" → "gaming and photography". Bounded to a
// short noun phrase so a whole sentence never becomes a chip.
const ASPECT_PHRASE_RE =
  /\b(?:best|ideal|great|good|preferred|recommended|popular|known|noted|praised|valued|stands out)\s+(?:choice\s+)?for\s+(?:its\s+)?([a-z][a-z0-9 &/,'-]{2,40}?)(?=[.,;:!?)]|\band\b\s+(?:it|they|the)\b|$)/gi;
const ASPECT_PHRASE_STOP = /^(the|a|an|you|those|them|it|this|that|these|him|her|us|people|users|customers|anyone|everyone|most|some|many)\b/i;

function extractBrandAspects(passages) {
  const raw = sanitizeText((passages || []).join(" "));
  if (!raw) return [];
  const text = raw.toLowerCase();

  const aspects = [];
  const seen = new Set();
  const push = (label) => {
    const k = label.toLowerCase();
    if (!seen.has(k)) { seen.add(k); aspects.push(label); }
  };

  // 1. aspects the answer states outright
  let m;
  ASPECT_PHRASE_RE.lastIndex = 0;
  while ((m = ASPECT_PHRASE_RE.exec(raw))) {
    // Same bounding as the list-header path, so both chip sources are
    // trimmed by one rule rather than two that drift apart.
    const phrase = trimLabel(m[1]);
    if (!phrase || ASPECT_PHRASE_STOP.test(phrase)) continue;
    push(phrase.charAt(0).toUpperCase() + phrase.slice(1));
    if (aspects.length >= 3) return aspects;
  }

  // 2. fall back to the dimension map
  for (const [label, re] of ASPECT_DIMENSIONS) {
    if (re.test(text)) push(label);
    if (aspects.length >= 3) break;
  }

  return aspects.slice(0, 3);
}

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
    el("div", { style: "font-weight: 600; font-size: 14px; color: var(--accent);" }, product.price || "Price specified in response text"),
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
        el("a", { href: s.url, target: "_blank", rel: "noreferrer", style: "font-weight: 600; font-size: 12px; text-decoration: none; color: var(--accent);" }, s.domain || s.url)
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
  target.scrollIntoView({ behavior: "smooth", block: "center" });
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
    await load(); // awaits geoP, so the Campaigns tab has rendered before we restore
    if (scroller) scroller.scrollTop = y;
  }, 400);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "new-capture") {
    refreshFromBroadcast();
    if (!msg.duringRun) showToast("New LLM citation captured!");
  }
  // The optional on-device AI pass finished and improved a record that is
  // already on screen. Refresh silently: the capture was announced moments
  // ago, and a second toast for the same prompt reads like a second capture.
  if (msg?.type === "capture-updated") {
    refreshFromBroadcast();
  }
});

/* ---------- Analyze (most recent capture) ---------- */
function renderAnalyze() {
  try {
    const root = $("#analyze");
    root.textContent = "";
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
            "Campaign captures are kept separate from ad-hoc browsing so a tracking run can't skew your ad-hoc numbers. Open one from the Dashboard's campaign view — click any prompt in the performance table."));
        const go = el("button", { className: "btn sm primary", style: "margin-top:10px" }, "Go to campaign results →");
        go.onclick = () => { showTab("dashboard"); renderDashboard(); };
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
    backBtn.onclick = () => { returnTab = null; showTab(backTo); };

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

    promptBar.append(
      backBtn,
      el("span", { className: "analyze-context-label muted small" }, "Analyzing"),
      el("span", {
        className: "analyze-context-prompt",
        title: rec.userPrompt || "",
      }, rec.userPrompt || "(no prompt text)"),
      engineChip(rec.platform, ENGINES.find((e) => e.id === rec.platform)?.label || rec.platform || "Unknown"),
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
      parts.push(el("span", {}, `Viewing capture ${adhocIdx + 1} of ${RECORDS.length} (${new Date(rec.capturedAt).toLocaleString()})`));
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
      parts.push(el("span", {}, `Viewing a campaign capture — ${rec.platform || "unknown"}${rec.model ? " · " + rec.model : ""} · ${new Date(rec.capturedAt).toLocaleString()}`));
    }
    if (parts.length) {
      const banner = el("div", { className: "viewing" });
      parts.forEach((p, i) => { if (i > 0) banner.append(el("span", { className: "viewing-sep" }, "·")); banner.append(p); });
      root.append(banner);
    }
  }

  const fanCount =
    ((rec.fanout?.search?.length || 0) + (rec.fanout?.shopping?.length || 0) + (rec.fanout?.image?.length || 0));
  const newsCount = rec.sources.filter((s) => s.type === "news").length;
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
  addKv("Captured", new Date(rec.capturedAt).toLocaleString());
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
          const secTitle = el("div", { className: "brand-label", style: "font-size:10.5px; margin-top:3px" }, "Supporting citations:");
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
          const secTitle = el("div", { className: "brand-label", style: "font-size:10.5px; margin-top:5px; color:var(--fg-muted)" }, "Citations omitting this brand:");
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
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:700; margin:6px 0 2px 4px; color:var(--fg-secondary)" }, "MENTIONED BRANDS ATTRIBUTION"));
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
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:700; margin:10px 0 2px 4px; color:var(--fg-secondary)" }, "SEARCH FUNNEL DROPOUTS (RETRIEVED BUT NOT WRITTEN)"));
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
        list.append(el("div", { className: "card-subtitle", style: "font-size:11px; font-weight:700; margin:10px 0 2px 4px; color:var(--fg-secondary)" }, "DOMAIN-LEVEL BRAND COVERAGE & BLIND SPOTS"));
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
        const tr = el("tr", { className: "summary-row", title: `Click to jump to ${k}` });
        tr.append(el("td", {}, k), el("td", { className: "num" }, String(v)));
        tr.onclick = () => scrollToCard(targetId);
        t.append(tr);
      });
      // Total Row
      const totalRow = el("tr", { style: "font-weight:700; border-top:1px solid var(--border);" },
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
        style: "white-space:pre-wrap; font-family:var(--font-mono, monospace); font-size:11.5px; line-height:1.4; max-height:220px; overflow-y:auto; background:var(--bg-subtle); padding:10px 12px; border-radius:8px; border:1px solid var(--border);"
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
            style: `width:${auth.socialPct}%; background:#1d9bf0; color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center;`,
            title: `Social Authority (X/Twitter): ${auth.socialPct}%`,
          }, auth.socialPct > 15 ? `🐦 ${auth.socialPct}% Social` : ""),
          el("div", {
            style: `width:${auth.webPct}%; background:#10b981; color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center;`,
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
      fc.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, bucket));
      const chips = el("div", { className: "chips" });
      arr.forEach((q) => {
        const qStr = typeof q === "string" ? q : q?.query || "";
        if (qStr) chips.append(el("span", { className: "chip" }, `${qIdx++}. ${qStr}`));
      });
      fc.append(chips);
    }

    if (rec.products && rec.products.length) {
      fc.append(el("div", { className: "muted", style: "margin-top:10px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;" }, "Shopping Carousel Products"));
      const pChips = el("div", { className: "chips" });
      rec.products.forEach((p, idx) => {
        const renderTag = (p.renderAs || "block").toUpperCase();
        if (renderTag === "HERO") {
          pChips.append(el("span", {
            className: "chip active",
            style: "background: #f59e0b; color: #fff; font-weight: 600; border: 1px solid #d97706; box-shadow: 0 1px 3px rgba(0,0,0,0.1);"
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
      
      const domLink = el("button", { className: "linkbtn td-domain-btn", title: `Click for detailed URLs under ${d}` }, d);
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
        if (activeSrcFilter === "news") return s.type === "news";
        return true;
      });

      const order = { cited: 0, fetched: 1, mentioned: 2, unknown: 3 };
      const ranked = [...filtered].sort((a, b) => (order[a.outcome] ?? 9) - (order[b.outcome] ?? 9));
      // Cited sources sort first, so the first ten are the ones that actually
      // shaped the answer — the long fetched-but-unused tail is one click away
      // instead of running the card to several screens.
      const SRC_PREVIEW = 10;
      const visible = showAllSources ? ranked : ranked.slice(0, SRC_PREVIEW);
      visible.forEach((s, idx) => {
        const li = el("li", { className: "src-item" });
        const header = el("div", { className: "src-header" });
        
        header.append(el("span", { className: "url-rank-badge" }, `#${idx + 1}`));
        header.append(el("span", { className: `tag ${s.outcome}` }, s.outcome));
        
        if (s.type === "news") {
          header.append(el("span", { className: "tag news" }, "news"));
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
        const dateStr = dMs ? new Date(dMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
        const rs = s.platformSpecific && s.platformSpecific.resultSource;
        
        const meta = el("div", { className: "src-meta" });
        meta.append(el("span", { className: "src-domain" }, s.domain || "—"));
        if (dateStr) {
          meta.append(el("span", { className: "src-dot" }, "·"), el("span", {}, dateStr));
        }
        if (rs) {
          meta.append(el("span", { className: "src-dot" }, "·"), el("span", {}, `src: ${rs}`));
        }
        li.append(meta);

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
              style: "font-size:9.5px; padding:1px 5px; background:var(--green-bg); color:var(--green-fg); border:1px solid var(--green-border); border-radius:4px"
            }, `+ ${pb}`));
          });
          if (showSnippets && sm.missingBrands && sm.missingBrands.length) {
            sm.missingBrands.slice(0, 4).forEach((mb) => {
              brandsRow.append(el("span", {
                className: "tag",
                style: "font-size:9.5px; padding:1px 5px; background:rgba(100, 116, 139, 0.08); color:var(--fg-muted); border:1px solid rgba(100, 116, 139, 0.2); border-radius:4px"
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

    const filters = [
      { id: "all", label: `All (${rec.sources.length})` },
      { id: "cited", label: `Cited (${citedN})` },
      { id: "fetched", label: `Fetched (${fetchedN})` },
      { id: "news", label: `News (${newsCount})` },
    ];

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
      const nameSpan = el("span", { className: "item-name", style: "font-weight: 600;" });
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
    rc.append(el("div", { className: "muted", style: "white-space:pre-wrap;max-height:220px;overflow:auto;font-size:12px;font-family:'JetBrains Mono',monospace;background:var(--bg-subtle);padding:8px 12px;border-radius:6px;border:1px solid var(--border);" }, rec.platformSpecific.reasoning));
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
      ec.append(el("div", { className: "muted", style: "margin-top:6px;font-weight:600;font-size:11px;" }, cat));
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
          style: `background:${scoreColor}18; color:${scoreColor}; border:1px solid ${scoreColor}40; font-weight:700;`,
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
              style: `font-size:10px; padding:1px 5px; font-weight:600; background:${cm.isGrounded ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)"}; color:${cm.isGrounded ? "#10b981" : "#ef4444"};`,
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

let dashboardModelFilter = ""; 
let dashboardTimeFilter = "";
let customStartTime = 0;
let customEndTime = 0;
let currentFilteredRecs = [];
let dashboardDrill = null; // which Performance Overview metric is expanded

/* Detail view behind each Performance Overview metric. Always built from the
 * already-filtered records, so the project / model / timeframe selections apply
 * here too rather than silently showing everything. */
function renderDrilldown(recs) {
  if (!dashboardDrill) return null;

  const card = el("div", { className: "drilldown" });
  const titles = {
    captures: "Every capture",
    searched: "Captures that triggered a web search",
    fanout: "Every fan-out query the model issued",
    domains: "Every domain seen",
    cited: "Sources the model actually cited",
    fetched: "Sources fetched but not cited",
  };
  const headRow = el("div", { className: "card-header" }, el("h3", {}, titles[dashboardDrill] || "Details"));
  const close = el("button", { className: "linkbtn" }, "close ✕");
  close.onclick = () => { dashboardDrill = null; renderDashboard(); };
  headRow.append(close);
  card.append(headRow);

  const tableWrap = (rows, headers, exportName) => {
    if (!rows.length) {
      card.append(el("div", { className: "empty" }, "Nothing here for the current filters."));
      return;
    }
    const bar = el("div", { className: "dlbar" });
    bar.append(el("span", { className: "muted" }, `${rows.length} row${rows.length === 1 ? "" : "s"}`));
    const dl = el("button", { className: "btn sm ghost" }, "⬇ CSV");
    dl.onclick = () => download(`citoskeleton-${exportName}-${Date.now()}.csv`, csvOf([headers, ...rows]), "text/csv");
    bar.append(dl);
    card.append(bar);

    const wrap = el("div", { className: "drill-scroll" });
    const t = el("table", { className: "drill-table" });
    // Right-align ONLY genuinely numeric cells. This used to be
    // `i === 0 ? "" : "num"` — i.e. every column but the first — which
    // right-aligned text columns like "Original prompt"/"Platform" and made
    // the table read as ragged nonsense. Testing `typeof` instead of a column
    // index also can't drift when a column is added or reordered.
    const isNum = (c) => typeof c === "number";
    t.append(el("tr", {}, ...headers.map((h, i) =>
      el("th", { className: rows.length && isNum(rows[0][i]) ? "num" : "" }, h))));
    rows.slice(0, 500).forEach((r) =>
      t.append(el("tr", {}, ...r.map((c) => el("td", { className: isNum(c) ? "num" : "" }, String(c))))));
    wrap.append(t);
    card.append(wrap);
    if (rows.length > 500) card.append(el("div", { className: "muted" }, `Showing first 500 of ${rows.length} — export the CSV for all.`));
  };

  const when = (t) => new Date(t).toLocaleString();

  if (dashboardDrill === "captures" || dashboardDrill === "searched") {
    const list = dashboardDrill === "searched" ? recs.filter((r) => r.searched) : recs;
    const rows = list.map((r) => [
      r.userPrompt || "(no prompt)",
      r.platform || "",
      r.model || "",
      when(r.capturedAt),
      ((r.fanout?.search?.length || 0) + (r.fanout?.shopping?.length || 0) + (r.fanout?.image?.length || 0)),
      (r.sources || []).length,
      (r.sources || []).filter((s) => s.outcome === "cited").length,
      (r.brandMentions || []).length,
    ]);
    tableWrap(rows, ["Prompt", "Platform", "Model", "Captured", "Fan-out", "Sources", "Cited", "Brands"], "captures");
  }

  if (dashboardDrill === "fanout") {
    const rows = [];
    recs.forEach((r) => {
      ["search", "shopping", "image"].forEach((bucket) => {
        (r.fanout?.[bucket] || []).forEach((q) => {
          const qStr = typeof q === "string" ? q : q?.query || "";
          rows.push([qStr, bucket, r.userPrompt || "", r.platform || "", when(r.capturedAt)]);
        });
      });
    });
    tableWrap(rows, ["Fan-out query", "Type", "Original prompt", "Platform", "Captured"], "fanout-queries");
  }

  if (dashboardDrill === "domains" || dashboardDrill === "cited" || dashboardDrill === "fetched") {
    // Domain-level rollup. For cited/fetched we scope to that outcome so the
    // numbers reconcile with the metric that was clicked.
    const want = dashboardDrill === "domains" ? null : dashboardDrill;
    const agg = new Map();
    recs.forEach((r) => {
      (r.sources || []).forEach((s) => {
        if (!s.domain) return;
        if (want && s.outcome !== want) return;
        const cur = agg.get(s.domain) || { cited: 0, fetched: 0, prompts: new Set(), sample: "" };
        if (s.outcome === "cited") cur.cited++;
        else cur.fetched++;
        if (r.userPrompt) cur.prompts.add(r.userPrompt);
        if (!cur.sample && s.url) cur.sample = s.url;
        agg.set(s.domain, cur);
      });
    });
    const rows = [...agg.entries()]
      .map(([domain, v]) => [domain, v.cited, v.fetched, v.cited + v.fetched, v.prompts.size, v.sample])
      .sort((a, b) => b[3] - a[3]);
    tableWrap(rows, ["Domain", "Cited", "Read-only", "Total", "Prompts", "Example URL"], `${dashboardDrill}-domains`);
  }

  return card;
}

/* ---------- Dashboard (aggregates across all captures) ---------- */
function renderDashboard() { withScrollPreserved(renderDashboardImpl); }
function renderDashboardImpl() {
  const root = $("#dashboard");
  beginSwap(root);
  root.textContent = "";

  const now = Date.now();
  let timeLimit = dashboardTimeFilter === "1h" ? now - 3600000 :
                  dashboardTimeFilter === "24h" ? now - 86400000 :
                  dashboardTimeFilter === "7d" ? now - 604800000 : 0;

  const recs = RECORDS.filter((r) => {
    if (!matchesSearch(r.userPrompt, dashboardSearch)) return false;
    if (dashboardModelFilter && r.platform !== dashboardModelFilter) return false;
    if (dashboardTimeFilter === "custom") {
      if (customStartTime && r.capturedAt < customStartTime) return false;
      if (customEndTime && r.capturedAt > customEndTime) return false;
    } else if (timeLimit && r.capturedAt < timeLimit) {
      return false;
    }
    return true;
  });
  currentFilteredRecs = recs;
  if (!recs.length && !RECORDS.length && !GEO_PROFILES.length) {
    root.append(el("div", { className: "empty" }, "No data captured yet. Open ChatGPT, Gemini, Perplexity or Grok in a tab and run a query."));
    return;
  }

  let fanTotal = 0, searched = 0, citedTotal = 0, fetchedTotal = 0;
  const domainCount = new Map();
  const domainTypes = new Map();
  const termCount = new Map();
  recs.forEach((r) => {
    if (r.searched) searched++;
    ["search", "shopping", "image"].forEach((b) =>
      (r.fanout[b] || []).forEach((q) => {
        fanTotal++;
        q.query.toLowerCase().split(/\s+/).forEach((w) => {
          if (w.length > 2) termCount.set(w, (termCount.get(w) || 0) + 1);
        });
      })
    );
    r.sources.forEach((s) => {
      if (s.outcome === "cited") citedTotal++;
      else if (s.outcome === "fetched") fetchedTotal++;
      if (s.domain) {
        domainCount.set(s.domain, (domainCount.get(s.domain) || 0) + 1);
        const set = domainTypes.get(s.domain) || new Set();
        set.add(s.outcome);
        if (s.type === "news") set.add("news");
        domainTypes.set(s.domain, set);
      }
    });
  });

  // Top Metric KPI Grid Card
  const overviewCard = el("div", { className: "card" });
  const ovHeader = el("div", { className: "card-header" }, el("h3", {}, "Performance Overview"));
  
  const filterRow = el("div", { className: "header-brand", style: "display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;" });

  // 0. Search — filters captures by prompt text (affects the stat grid,
  // drilldown, and Saved Conversations list below, same as the other filters).
  const searchInp = el("input", { id: "dashboardSearch", type: "text", placeholder: "🔍 Search words in prompts…", title: "Type any words — rows matching every word are shown, in any order", value: dashboardSearch, className: "filter", style: "min-width:140px" });
  searchInp.oninput = () => {
    dashboardSearch = searchInp.value;
    const cursor = searchInp.selectionStart;
    renderDashboard();
    const next = $("#dashboardSearch");
    if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
  };
  filterRow.append(searchInp);

  // 1. Timeframe Filter Container
  const timeContainer = el("div", { style: "display: flex; gap: 8px; align-items: center;" });
  
  const timeSel = el("select", { className: "filter" });
  const timeOpts = [
    { v: "", l: "All Time" },
    { v: "1h", l: "Last Hour" },
    { v: "24h", l: "Last 24 Hours" },
    { v: "7d", l: "Last 7 Days" },
    { v: "custom", l: "Custom..." }
  ];
  timeOpts.forEach(o => {
    const opt = el("option", { value: o.v }, o.l);
    if (o.v === dashboardTimeFilter) opt.selected = true;
    timeSel.append(opt);
  });
  timeSel.onchange = () => { dashboardTimeFilter = timeSel.value; renderDashboard(); };
  timeContainer.append(timeSel);

  if (dashboardTimeFilter === "custom") {
    const startInp = el("input", { type: "datetime-local", className: "filter", style: "width: 140px; padding: 2px 6px;" });
    if (customStartTime) {
      const d = new Date(customStartTime);
      startInp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }
    startInp.onchange = (e) => { customStartTime = e.target.value ? new Date(e.target.value).getTime() : 0; renderDashboard(); };
    
    const endInp = el("input", { type: "datetime-local", className: "filter", style: "width: 140px; padding: 2px 6px;" });
    if (customEndTime) {
      const d = new Date(customEndTime);
      endInp.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
    }
    endInp.onchange = (e) => { customEndTime = e.target.value ? new Date(e.target.value).getTime() : 0; renderDashboard(); };

    timeContainer.append(el("span", { className: "muted" }, "from"), startInp, el("span", { className: "muted" }, "to"), endInp);
  }
  
  filterRow.append(timeContainer);

  // 2. Model Filter — the single engine control for this whole tab, campaign
  // section included. Re-synced on every render so no other code path can
  // leave the campaign reading a different engine than the one shown here.
  geoEngineFilter = dashboardModelFilter ? [dashboardModelFilter] : [];
  const modelSel = el("select", { className: "filter", title: "Limit every number on this tab — including the campaign below — to one engine" });
  // Built from the engines that actually have adapters rather than a hardcoded
  // pair, so adding one doesn't leave a filter that can never select it.
  [{ id: "", label: "All Models" }, ...availableEngines()].forEach((o) => {
    const opt = el("option", { value: o.id }, o.label);
    if (o.id === dashboardModelFilter) opt.selected = true;
    modelSel.append(opt);
  });
  // Reported: "when I change the model the data in the campaign doesn't
  // change at all." It didn't: this select drove only the ad-hoc record list,
  // while the campaign section read a SEPARATE geoEngineFilter set by its own
  // dropdown. Two controls, same word, one of them silently inert over the
  // section people were actually looking at.
  //
  // Unified rather than merely connected — the campaign card's duplicate
  // dropdown is gone, the same way the "Last 7/30/90 days" selector was
  // removed when the time filter was unified. One control, one meaning.
  modelSel.onchange = () => {
    dashboardModelFilter = modelSel.value;
    geoEngineFilter = modelSel.value ? [modelSel.value] : [];
    renderDashboard();
  };
  filterRow.append(modelSel);

  // 3. Campaign Filter — picks which campaign's performance shows below.
  // Nothing selected means no campaign section is shown at all (see the
  // "No campaign selected" note further down), rather than silently
  // defaulting to one.
  if (GEO_PROFILES.length) {
    const sel = el("select", { className: "filter" });
    sel.append(el("option", { value: "" }, "No campaign selected"));
    GEO_PROFILES.forEach((p) => {
      const o = el("option", { value: p.id }, p.name || "Untitled");
      if (p.id === dashboardCampaignId) o.selected = true;
      sel.append(o);
    });
    sel.onchange = async () => {
      dashboardCampaignId = sel.value;
      expandedPromptRuns = new Set();
      geoTagFilter = [];
      // A prompt/source filter typed for one campaign is meaningless against
      // another and would silently hide most of the new campaign's rows.
      geoPromptSearch = "";
      sourceSearch = "";
      if (dashboardCampaignId) {
        const qs = await send({ type: "geo-prompt-list", profileId: dashboardCampaignId });
        dashboardGeoPrompts = qs.ok ? qs.prompts : [];
      } else {
        dashboardGeoPrompts = [];
      }
      renderDashboard();
    };
    filterRow.append(sel);
  }

  ovHeader.append(filterRow);
  overviewCard.append(ovHeader);
  // Always in the DOM — this is what used to disappear once a campaign was
  // selected, taking the only way to change or clear the selection with it.
  root.append(overviewCard);

  const selectedCampaign = dashboardCampaignId ? GEO_PROFILES.find((p) => p.id === dashboardCampaignId) : null;
  // Same timeframe the ad-hoc filters above use — campaign performance used
  // to have its OWN separate "Last 7/30/90 days" dropdown, which was a second,
  // inconsistent time filter instead of reusing this one.
  const geoSince = dashboardTimeFilter === "custom" ? (customStartTime || undefined) : (timeLimit || undefined);
  const geoUntil = dashboardTimeFilter === "custom" ? (customEndTime || undefined) : undefined;

  if (!selectedCampaign) {
    // Every metric is clickable and opens a detail view built from the SAME
    // filtered `recs`, so the model / timeframe filters above always apply
    // to the drill-down too. Only shown when no campaign is selected — once
    // one is, this and the campaign KPIs below merge into a single section
    // (see refreshGeoMetrics) instead of two disconnected cards.
    const stats = el("div", { className: "statgrid" });
    const stat = (n, l, key) => {
      const node = el(
        "div",
        { className: `stat clickable-stat${dashboardDrill === key ? " stat-active" : ""}`, title: `Click to break down: ${l}` },
        el("div", { className: "n" }, String(n)),
        el("div", { className: "l" }, l)
      );
      node.onclick = () => {
        dashboardDrill = dashboardDrill === key ? null : key;
        renderDashboard();
      };
      return node;
    };
    stats.append(
      stat(recs.length, "Captures", "captures"),
      stat(searched, "With search", "searched"),
      stat(fanTotal, "Fan-out queries", "fanout"),
      stat(domainCount.size, "Unique domains", "domains"),
      stat(citedTotal, "Cited", "cited"),
      stat(fetchedTotal, "Read-only", "fetched")
    );
    overviewCard.append(stats);
    const drill = renderDrilldown(recs);
    if (drill) overviewCard.append(drill);

    if (GEO_PROFILES.length) {
      root.append(el("div", { className: "empty" }, "No campaign selected — pick one above to see its performance."));
    }
  } else {
    // A campaign is selected: merge its own captures/fan-out/domain overview
    // together with its brand KPIs into the one card refreshGeoMetrics builds,
    // instead of showing the generic ad-hoc overview above it.
    const gc = el("div", { className: "card", id: "geoMetrics" });
    gc.append(el("div", { className: "card-header" }, el("h3", {}, "Campaign Performance")), el("div", { className: "muted small" }, "loading…"));
    root.append(gc);

    const pp = el("div", { className: "card", id: "geoPromptTable" });
    pp.append(el("div", { className: "card-header" }, el("h3", {}, "Prompt Performance")), el("div", { className: "muted small" }, "loading…"));
    root.append(pp);

    // Reported: scrolled down into a campaign's Source Domains/URLs table
    // (which lives inside #geoPromptTable, filled in below), the page kept
    // jumping back to the top. beginSwap()'s minHeight hold on #dashboard
    // (above) only lasts two animation frames, but these two panels start
    // out as a one-line "loading…" placeholder and only reach their real,
    // tall size after their own chrome.runtime.sendMessage round trip
    // resolves — which routinely outlasts those two frames, especially
    // during a live run competing for the service worker's attention. In
    // that gap #dashboard is genuinely shorter than it was, so the browser
    // clamps scrollTop back up on its own — the same class of bug already
    // named and fixed below for the loader-status poll, just triggered here
    // by every "new-capture" broadcast during a run instead of a timer.
    // Re-apply the pre-rebuild position once both panels have actually
    // finished filling back in, undoing that clamp.
    const scroller = activeScroller();
    const y = scroller ? scroller.scrollTop : 0;
    Promise.all([
      refreshGeoMetrics(selectedCampaign, dashboardGeoPrompts, geoSince, geoUntil),
      refreshPromptPerformance(selectedCampaign, dashboardGeoPrompts, geoSince, geoUntil),
    ]).then(() => { if (scroller) scroller.scrollTop = y; });
  }

  // Saved Conversations + Top Domains are ad-hoc-only (per the isolation rule
  // in geo.js — tracked runs never mix into this data), so they don't apply
  // once a campaign is selected. Prompt Performance + the domain/URL toggle
  // above replace them for that view instead of showing an empty/irrelevant
  // ad-hoc list underneath a campaign's data.
  if (selectedCampaign) return;

  // Split Grid Container
  const grid = el("div", { className: "dashboard-grid" });

  // Main Column: Saved Conversations Card
  const savedCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Saved Conversations")));
  const emptyCount = recs.filter((r) => !hasSignal(r)).length;
  const visibleRecs = showEmptyCaptures ? recs : recs.filter(hasSignal);
  if (emptyCount) {
    const note = el("div", { className: "muted", style: "margin-bottom:8px; font-size:11px;" });
    const toggle = el("button", { className: "linkbtn" }, showEmptyCaptures ? "hide them" : "show them");
    toggle.onclick = () => { showEmptyCaptures = !showEmptyCaptures; renderDashboard(); };
    note.append(
      `${emptyCount} capture${emptyCount === 1 ? "" : "s"} with no prompt/fan-out/sources hidden — `,
      toggle
    );
    savedCard.append(note);
  }

  // Unified Download Toolbar
  const bar = el("div", { className: "dlbar" });
  const sel = () => (selectedIds.size ? visibleRecs.filter((r) => selectedIds.has(r.captureId)) : visibleRecs);
  const lbl = el("span", { className: "muted" });
  const updLbl = () => (lbl.textContent = selectedIds.size ? `${selectedIds.size} Selected` : `All ${visibleRecs.length}`);
  updLbl();
  
  // A native <select> sizes itself to its LONGEST option ("Conversations
  // (HTML)"), so no amount of max-width tightening made it compact — it just
  // clipped. A button plus its own popover is as wide as the word "Export"
  // and nothing else. The old hardcoded #10b981 green also made it read as a
  // foreign control; it uses the accent token like every other action now.
  const dlWrap = el("div", { className: "menu-wrap" });
  const dlBtn = el("button", { className: "btn sm ghost menu-btn", title: "Export the shown or selected conversations" },
    el("span", {}, "\u2913"), el("span", {}, "Export"), el("span", { className: "menu-caret" }, "\u25be"));
  const dlMenu = el("div", { className: "menu-pop", style: "display:none" });
  const runExport = async (val) => {
    dlMenu.style.display = "none";
    if (val === "json") download(`citoskeleton-selected-${Date.now()}.json`, JSON.stringify(sel(), null, 2), "application/json");
    else if (val === "excel" || val === "csv") downloadDetailedFormat(sel(), val);
    else if (val === "html") await exportRecordsAsHtml(sel());
  };
  // Trimmed to the formats people actually reach for: a spreadsheet (Excel),
  // structured data for further analysis (CSV), a readable document (HTML),
  // and the raw underlying data for bulk-selected conversations (JSON) — vs.
  // the previous 6-option list where Fan-outs TXT and Print/PDF saw little
  // use. Print/PDF is still available per-conversation from the Analyze tab.
  [
    ["excel", "Excel", ".xls spreadsheet"],
    ["csv", "Detailed CSV", "one row per source"],
    ["html", "Conversations", "readable HTML document"],
    ["json", "Raw data", "full JSON payloads"],
  ].forEach(([v, label, sub]) => {
    const item = el("button", { className: "menu-item" },
      el("span", { className: "menu-item-label" }, label),
      el("span", { className: "menu-item-sub muted small" }, sub));
    item.onclick = () => runExport(v);
    dlMenu.append(item);
  });
  dlBtn.onclick = (ev) => {
    ev.stopPropagation();
    dlMenu.style.display = dlMenu.style.display === "none" ? "block" : "none";
  };
  // Click-away close. Registered once per render alongside the menu it closes,
  // and removed on the same click, so these don't stack up across re-renders.
  const closeDlMenu = () => { dlMenu.style.display = "none"; document.removeEventListener("click", closeDlMenu); };
  dlBtn.addEventListener("click", () => { if (dlMenu.style.display === "block") setTimeout(() => document.addEventListener("click", closeDlMenu), 0); });
  dlWrap.append(dlBtn, dlMenu);

  const deleteSelected = el("button", { className: "btn sm danger", style: selectedIds.size ? "margin-left: auto;" : "display:none;" }, `🗑 Delete Selected`);
  deleteSelected.onclick = async () => {
    if (!confirm(`Delete the ${selectedIds.size} selected conversation(s)?`)) return;
    for (const id of selectedIds) {
      await send({ type: "delete-record", captureId: id });
      FULL.delete(id);
    }
    selectedIds.clear();
    load();
  };

  const deleteAll = el("button", { className: "btn sm danger ghost", style: selectedIds.size ? "" : "margin-left: auto;" }, "🗑 Delete All");
  deleteAll.onclick = async () => {
    if (!confirm("Delete all captured conversations? This action cannot be undone.")) return;
    await send({ type: "clear-all" });
    FULL.clear();
    viewingId = null;
    load();
  };

  const clearSel = el("button", { className: "linkbtn", style: selectedIds.size ? "" : "display:none;" }, "clear selection");
  clearSel.onclick = () => { selectedIds.clear(); renderDashboard(); };
  
  const rightGroup = el("div", { style: "display: flex; gap: 8px; margin-left: auto; align-items: center;" });
  rightGroup.append(dlWrap, deleteSelected, deleteAll);

  bar.append(lbl, clearSel, rightGroup);
  savedCard.append(bar);

  const listHeader = el("div", { className: "capture-list-header" });
  const head = el("input", { type: "checkbox", title: "Select all shown" });
  head.checked = visibleRecs.length > 0 && visibleRecs.slice(0, 100).every((r) => selectedIds.has(r.captureId));
  head.onchange = () => {
    visibleRecs.slice(0, 100).forEach((r) => (head.checked ? selectedIds.add(r.captureId) : selectedIds.delete(r.captureId)));
    renderDashboard();
  };
  const selectAllLabel = el("label", { className: "chk", style: "margin: 0;" }, head, "Select all shown");
  listHeader.append(selectAllLabel);
  savedCard.append(listHeader);

  const ul = el("ul", { className: "capture-list" });
  const grouped = new Map();
  visibleRecs.slice(0, 100).forEach((r) => {
    const d = new Date(r.capturedAt).toLocaleDateString();
    const p = (r.userPrompt || "(No prompt)").toLowerCase().trim();
    const key = d + "|" + p;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  });

  Array.from(grouped.values()).forEach((cluster) => {
    cluster.sort((a,b) => a.capturedAt - b.capturedAt);
    let activeIdx = 0;
    
    const card = el("li", { className: "capture-item", style: "flex-direction: column; align-items: stretch; gap: 8px; cursor: default;" });
    
    const renderClusterContent = () => {
      card.textContent = "";
      const activeRecord = cluster[activeIdx];
      const fan = ((activeRecord.fanout?.search?.length || 0) + (activeRecord.fanout?.shopping?.length || 0) + (activeRecord.fanout?.image?.length || 0));
      
      const rawB = el("button", { title: "Download raw payload" }, "Raw");
      rawB.onclick = (e) => { e.stopPropagation(); downloadRaw(activeRecord.captureId, (activeRecord.userPrompt || "capture").slice(0, 24).replace(/\W+/g, "_")); };
      
      const del = el("button", { className: "del-btn", title: "Delete capture" }, "Delete");
      del.onclick = async (e) => {
         e.stopPropagation();
         await send({ type: "delete-record", captureId: activeRecord.captureId });
         load();
      };

      const promptDiv = el("div", { className: "capture-prompt", title: "Open this capture", style: "cursor: pointer; font-weight: 500;" }, highlightMatch(activeRecord.userPrompt || "(No prompt text)", dashboardSearch));
      promptDiv.onclick = () => openCapture(activeRecord.captureId);
      
      const cb = el("input", { type: "checkbox" });
      cb.checked = cluster.every(r => selectedIds.has(r.captureId));
      cb.onchange = (e) => { 
        cluster.forEach(r => {
           if (e.target.checked) selectedIds.add(r.captureId);
           else selectedIds.delete(r.captureId);
        });
        updLbl(); 
        if (typeof mchk !== 'undefined') mchk.checked = false; 
        renderClusterContent(); 
      };

      // Reported: "if same prompt is not run on both the llms you won't know
      // which one was run on which platform." The platform pills below only
      // ever appeared when a cluster held more than one run — the common case
      // of a prompt captured on just ONE engine showed no engine at all
      // anywhere on the row. This badge is unconditional: every saved
      // conversation states which engine produced it, whether or not its
      // prompt was also run elsewhere.
      const engineLabel = ENGINES.find((e) => e.id === activeRecord.platform)?.label || activeRecord.platform || "Unknown";
      const engineBadge = el("span", { className: "capture-engine", title: `Captured on ${engineLabel}` },
        engineChip(activeRecord.platform, engineLabel));

      const metaRow = el("div", { className: "capture-meta", style: "margin-top: 4px;" },
        el("label", { className: "capture-select" }, cb),
        el("span", { className: "capture-date" }, new Date(activeRecord.capturedAt).toLocaleString()),
        engineBadge,
        el("span", { className: "tag cited" }, `${fan} fan-out`),
        el("span", { className: "tag fetched" }, `${activeRecord.sources.length} src`),
        el("div", { className: "row-actions", style: "margin-left: auto;" }, rawB, del)
      );

      let tabsRow = null;
      if (cluster.length > 1) {
        tabsRow = el("div", { style: "display:flex; align-items: center; gap: 8px; margin-top: 6px; margin-bottom: 4px; flex-wrap: wrap;" });
        
        // Group cluster items by platform
        const byPlatform = {};
        cluster.forEach(r => {
          const p = r.platform || "chatgpt";
          if (!byPlatform[p]) byPlatform[p] = [];
          byPlatform[p].push(r);
        });

        let currentPlat = activeRecord.platform || "chatgpt";
        if (!byPlatform[currentPlat]) currentPlat = Object.keys(byPlatform)[0];

        // Platform Selector Pills
        Object.keys(byPlatform).forEach(plat => {
          const count = byPlatform[plat].length;
          const label = `${plat.charAt(0).toUpperCase() + plat.slice(1)} (${count})`;
          const isSelected = plat === currentPlat;
          
          const btn = el("button", {
            className: `btn sm ${isSelected ? "primary" : "ghost"}`,
            style: "padding: 2px 8px; font-size: 11px; text-transform: capitalize;"
          }, label);
          
          btn.onclick = (e) => {
            e.stopPropagation();
            const firstRec = byPlatform[plat][0];
            activeIdx = cluster.indexOf(firstRec);
            renderClusterContent();
          };
          tabsRow.append(btn);
        });

        // Time Dropdown for current platform if > 1 run
        const platRuns = byPlatform[currentPlat] || [];
        if (platRuns.length > 1) {
          const timeSel = el("select", { className: "filter", style: "padding: 1px 6px; font-size: 11px; height: 24px;" });
          platRuns.forEach(r => {
            const timeStr = new Date(r.capturedAt).toLocaleTimeString("en-GB");
            const opt = el("option", { value: r.captureId }, `Run @ ${timeStr}`);
            if (r.captureId === activeRecord.captureId) opt.selected = true;
            timeSel.append(opt);
          });
          timeSel.onchange = (e) => {
            e.stopPropagation();
            const targetId = timeSel.value;
            const targetIdx = cluster.findIndex(r => r.captureId === targetId);
            if (targetIdx !== -1) {
              activeIdx = targetIdx;
              renderClusterContent();
            }
          };
          tabsRow.append(timeSel);
        }
      }

      card.append(promptDiv);
      if (tabsRow) card.append(tabsRow);
      card.append(metaRow);
    };

    renderClusterContent();
    ul.append(card);
  });
  savedCard.append(ul);
  grid.append(savedCard);

  // Sidebar Column: Top Domains Card
  const topDomains = [...domainCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topDomains.length) {
    // Card list, not a 3-column table: in the narrow sidebar the "Types" column
    // (up to 3 badges) pushed the table wider than its card, squashing long
    // domains like gadgetsnow.indiatimes.com into an unreadable column.
    const sideCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Top Domains")));
    const ul = el("ul", { className: "itemlist" });
    topDomains.forEach(([d, n]) => {
      const li = el("li", { className: "itemlist-clickable" });
      const head = el("div", { className: "item-head" });
      // Clickable, the same as a campaign's Source Domains table — opens the
      // identical drill-down modal (citations vs. read-only, every URL, and
      // which of your OWN captures pulled each one in), built from the same
      // filtered `recs` this whole card is already computed from.
      const nameBtn = el("button", { className: "linkbtn td-domain-btn item-name domain-name", title: `Click for detailed URLs under ${d}` }, d);
      nameBtn.onclick = () => openAdhocDomainDetailModal(d, recs);
      head.append(
        nameBtn,
        el("span", { className: "muted", style: "white-space:nowrap" }, `${n} src`)
      );
      li.append(head);
      const tagGroup = el("div", { className: "type-tag-group" });
      [...(domainTypes.get(d) || [])].forEach((typ) =>
        tagGroup.append(el("span", { className: `tag ${typ === "news" ? "news" : typ}` }, typ))
      );
      if (tagGroup.childNodes.length) li.append(tagGroup);
      ul.append(li);
    });
    sideCard.append(ul);
    grid.append(sideCard);
  }

  root.append(grid);
}

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
    let output = `CitoSkeleton Audit Log,,,,,,,,,,\n"Prompt-level tracking of ChatGPT search behaviour, cited vs. fetched sources, and query fan-out",,,,,,,,,,\n,,,,,,,,,,\n#,Date,Time,Platform,User Prompt,Search Used,Cited Sources,Cited Count,Fetched Sources,Fetched Count,Total Sources,Fan-Out Query\n`;
    records.forEach((r, i) => {
      const d = new Date(r.capturedAt);
      const dateStr = d.toLocaleDateString("en-GB", {day:"2-digit", month:"short", year:"numeric"}).replace(/ /g, '-');
      const timeStr = d.toLocaleTimeString("en-GB");
      const cited = r.sources.filter(s => s.outcome === "cited").map(s => s.domain).join("; ");
      const fetched = r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").map(s => s.domain).join("; ");
      const fan = [...(r.fanout?.search||[]), ...(r.fanout?.shopping||[]), ...(r.fanout?.image||[])].map(f => typeof f === "string" ? f : f?.query || "").filter(Boolean).join(" | ");
      const row = [i + 1, dateStr, timeStr, r.platform || "chatgpt", `"${(r.userPrompt || "").replace(/"/g, '""')}"`, r.searched ? "Yes" : "No", `"${cited}"`, r.sources.filter(s => s.outcome === "cited").length, `"${fetched}"`, r.sources.filter(s => s.outcome === "fetched" || s.outcome === "news").length, r.sources.length, `"${fan.replace(/"/g, '""')}"`];
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

  const stamp = (r) => new Date(r.capturedAt).toLocaleString("en-GB");

  // Full source detail — the Domain Data sheet only carries the domain, which
  // loses the actual page that was cited.
  const sourceRows = [];
  records.forEach((r, i) => {
    (r.sources || []).forEach((s) => {
      sourceRows.push([
        i + 1, r.userPrompt || "", stamp(r), s.outcome || "", s.type || "",
        s.domain || "", s.title || "", s.url || "",
        (s.platformSpecific && s.platformSpecific.resultSource) || "",
        (s.snippet || "").slice(0, 400),
      ]);
    });
  });
  addSheet("Sources (full)", "Every cited and fetched source with its page title, URL and snippet.",
    [60, 200, 120, 70, 70, 140, 240, 300, 90, 400],
    ["Prompt #", "Prompt", "Captured", "Outcome", "Type", "Domain", "Page title", "URL", "Retrieval", "Snippet"],
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
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
const fmtPct = (n) => (n == null ? "—" : `${Number(n).toFixed(Number(n) >= 10 ? 0 : 1)}%`);
const fmtPos = (n) => (n == null ? "—" : `#${Number(n).toFixed(1)}`);

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
  renderCampaigns();
}

/* ---------- Campaigns tab (setup + prompts + LLMs + run, formerly
   Tracking + Loader) ---------- */

function renderCampaigns() { withScrollPreserved(renderCampaignsImpl); }
function renderCampaignsImpl() {
  const root = $("#loader");
  if (!root) return;
  root.textContent = "";
  const profile = geoActive();

  const bar = el("div", { className: "card" });
  const barHead = el("div", { className: "card-header" }, el("h3", {}, "Campaigns"));
  barHead.append(el("span", { className: "muted small" }, `${GEO_PROFILES.length} of ${MAX_PROFILES} used`));
  bar.append(barHead);

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
  }
  bar.append(switcher);
  root.append(bar);

  if (TRASHED_PROFILES.length) root.append(renderTrashedCampaigns());

  if (!profile) {
    root.append(renderCampaignEmptyState());
    return;
  }

  if (!profile.locked) {
    if (!campaignOnboardDismissed) root.append(renderOnboardingBanner());
    root.append(renderCampaignSetup(profile, false));
  } else {
    root.append(renderCampaignSummary(profile));
    if (campaignManageOpen) root.append(renderCampaignSetup(profile, true));
    root.append(renderRunCard(profile));
  }
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
    "Name the campaign and set your brand + competitors",
    "Upload a CSV/Excel of prompts (or type them) and tag them",
    "Choose which LLMs to track",
    "Lock the campaign to start measuring",
  ].forEach((s) => steps.append(el("li", {}, s)));
  box.append(steps);
  const cta = el("button", { className: "btn primary" }, "+ Create your first campaign");
  cta.onclick = async () => {
    const r = await send({ type: "geo-profile-save", profile: makeProfile({ name: "My first campaign" }) });
    if (r.ok) { geoActiveId = r.profile.id; loadGeo(); } else showToast(r.error, "error");
  };
  box.append(el("div", { className: "ft-actions" }, cta));
  return box;
}

function renderOnboardingBanner() {
  const box = el("div", { className: "warn-box onboard-banner" });
  box.append(el("div", {},
    el("b", {}, "Setting up a campaign — "),
    "add prompts (upload a CSV/Excel or type them), tag them so you can filter later, pick which LLMs to track, then lock the campaign. Locking freezes the setup so your results stay comparable run over run."));
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

/** Setup card: name/brand/competitors/LLMs + the embedded prompt manager.
 *  Used both for the unlocked wizard and the locked "Manage" panel (dis=true). */
function renderCampaignSetup(profile, dis) {
  const card = el("div", { className: "card" });
  const head = el("div", { className: "card-header" }, el("h3", {}, dis ? "Manage campaign" : "Set up your campaign"));
  // Everything typed into this form (name/brand/url/competitors/engines)
  // lives only in these DOM inputs until "Save details" is clicked — reading
  // collectFormValues() (defined below, once the inputs exist) is how every
  // OTHER action in this card that touches the profile gets the values the
  // user can actually see, instead of the `profile` argument, which is a
  // snapshot from whenever this card was last rendered and goes stale the
  // moment someone types. Locking against the stale snapshot silently
  // dropped just-typed details (and could reject a just-picked engine pill
  // as "none selected" because it was reading the old profile.engines);
  // adding a prompt triggered loadGeo() -> a full re-render from the DB,
  // which wiped anything typed here that had never been saved. Both are
  // fixed by routing through collectFormValues() instead of `profile`.
  let collectFormValues = () => profile; // reassigned below once inputs exist
  const persistDetails = async () => send({ type: "geo-profile-save", profile: { ...profile, ...collectFormValues() } });
  if (!dis) {
    const delBtn = el("button", { className: "btn sm ghost danger" }, "🗑 Delete campaign");
    delBtn.onclick = trashCampaign(profile);
    const lockBtn = el("button", { className: "btn sm primary" }, "🔒 Lock & start tracking");
    lockBtn.onclick = async () => {
      const current = collectFormValues();
      if (!GEO_PROMPTS.length) return showToast("Add at least one prompt before locking.", "error");
      if (!current.engines.length) return showToast("Choose at least one LLM to track before locking.", "error");
      if (!confirm("Lock this campaign?\n\nLocking freezes the brand set, competitors, prompts and LLMs so your trend data stays comparable day to day. You can unlock any time.")) return;
      const r = await send({ type: "geo-profile-save", profile: { ...profile, ...current, locked: true }, unlockOverride: true });
      if (r.ok) loadGeo(); else showToast(r.error, "error");
    };
    head.append(delBtn, lockBtn);
  } else {
    const unlockBtn = el("button", { className: "btn sm ghost" }, "🔓 Unlock to edit");
    unlockBtn.onclick = async () => {
      if (!confirm("Unlock and allow edits?\n\nChanging the brand set, prompts or LLMs changes what the metrics are measured against — numbers before and after this point are NOT directly comparable.")) return;
      const r = await send({ type: "geo-profile-save", profile: { ...profile, locked: false }, unlockOverride: true });
      if (r.ok) loadGeo(); else showToast(r.error, "error");
    };
    head.append(unlockBtn);
  }
  card.append(head);

  const nameIn = el("input", { type: "text", value: profile.name || "", placeholder: "Campaign name", disabled: dis });
  const brandIn = el("input", { type: "text", value: profile.brand?.name || "", placeholder: "Your brand name", disabled: dis });
  const urlIn = el("input", { type: "text", value: profile.brand?.url || "", placeholder: "yourbrand.com", disabled: dis });
  card.append(el("div", { className: "proj-row" }, nameIn));
  card.append(el("label", { className: "muted", style: "display:block;margin-top:8px" }, "Your brand"));
  card.append(el("div", { className: "proj-row" }, brandIn, urlIn));

  // Competitors: a repeatable name+url row per competitor, rather than a
  // freeform "name, url per line" textarea — less error-prone to fill in and
  // to read back.
  card.append(el("label", { className: "muted", style: "display:block;margin-top:14px" }, "Competitors"));
  const compWrap = el("div", { className: "competitor-rows" });
  const addCompetitorRow = (name = "", url = "") => {
    const row = el("div", { className: "proj-row competitor-row" });
    row.append(
      el("input", { type: "text", placeholder: "Competitor name", value: name, disabled: dis, className: "comp-name" }),
      el("input", { type: "text", placeholder: "competitor.com", value: url, disabled: dis, className: "comp-url" }),
    );
    if (!dis) {
      const rm = el("button", { className: "btn sm ghost danger", title: "Remove competitor" }, "✕");
      rm.onclick = () => row.remove();
      row.append(rm);
    }
    compWrap.append(row);
  };
  (profile.competitors || []).forEach((c) => addCompetitorRow(c.name, c.url));
  if (dis && !(profile.competitors || []).length) compWrap.append(el("div", { className: "muted small" }, "No competitors added."));
  card.append(compWrap);
  if (!dis) {
    const addCompBtn = el("button", { className: "btn sm ghost", style: "margin-top:8px" }, "➕ Add competitor");
    addCompBtn.onclick = () => addCompetitorRow();
    card.append(addCompBtn);
  }

  // LLMs to track: an icon-forward selectable grid instead of plain checkboxes.
  card.append(el("label", { className: "muted", style: "display:block;margin-top:16px" }, "LLMs to track"));
  const engCount = el("div", { className: "muted small", style: "margin-top:6px" });
  const engGrid = el("div", { className: "llm-grid" });
  ENGINES.forEach((e) => {
    const selected = (profile.engines || []).includes(e.id);
    const pillDisabled = dis || !e.available;
    const pill = el("div", {
      className: `llm-pill${selected ? " selected" : ""}${pillDisabled ? " disabled" : ""}`,
      role: "checkbox", "aria-checked": String(selected), tabIndex: pillDisabled ? -1 : 0,
    });
    pill.dataset.value = e.id;
    pill.append(engineIconEl(e.id));
    pill.append(el("span", { className: "llm-label" }, e.label));
    // Unavailable engines are shown disabled rather than hidden: the roadmap
    // stays visible, and a metric can never silently under-count because a
    // pill looked selectable but drove nothing.
    if (!e.available) pill.append(el("span", { className: "soon" }, e.note || "coming soon"));
    else pill.append(el("span", { className: "llm-check" }, "✓"));
    if (!pillDisabled) {
      const toggle = () => {
        pill.classList.toggle("selected");
        pill.setAttribute("aria-checked", String(pill.classList.contains("selected")));
        engCount.textContent = `${engGrid.querySelectorAll(".llm-pill.selected").length} of ${ENGINES.length} selected`;
      };
      pill.onclick = toggle;
      pill.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } };
    }
    engGrid.append(pill);
  });
  engCount.textContent = `${(profile.engines || []).length} of ${ENGINES.length} selected`;
  card.append(engGrid, engCount);

  // Now that every input exists, collectFormValues can read what's actually
  // on screen — this is what lockBtn (above) and persistDetails (used by
  // both Save and, below, adding a prompt) both call instead of trusting
  // the possibly-stale `profile` argument.
  collectFormValues = () => ({
    name: nameIn.value.trim() || profile.name,
    brand: { name: brandIn.value.trim(), url: urlIn.value.trim() },
    competitors: [...compWrap.querySelectorAll(".competitor-row")]
      .map((row) => ({ name: row.querySelector(".comp-name").value.trim(), url: row.querySelector(".comp-url").value.trim() }))
      .filter((c) => c.name),
    engines: [...engGrid.querySelectorAll(".llm-pill.selected")].map((p) => p.dataset.value),
  });

  if (!dis) {
    const save = el("button", { className: "btn sm" }, "💾 Save details");
    save.onclick = async () => {
      const r = await persistDetails();
      if (r.ok) loadGeo(); else showToast(r.error, "error");
    };
    card.append(el("div", { className: "ft-actions", style: "margin-top:10px" }, save));
  }

  card.append(el("div", { className: "wizard-divider" }));
  card.append(renderPromptManager(profile, dis, persistDetails));
  return card;
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

/** The prompts table: CSV/Excel upload (primary), manual entry (fallback),
 *  search, tag-filter sidebar (with per-tag rename/delete), "only unassigned"
 *  toggle, inline tag editing, and bulk select for pause/remove. */
function renderPromptManager(profile, dis, persistDetails) {
  const wrap = el("div", { className: "prompt-manager" });
  wrap.append(el("div", { className: "card-header", style: "margin-top:0" },
    el("h3", {}, "Prompts"),
    el("span", { className: "muted small" }, `${GEO_PROMPTS.filter((p) => p.active !== false).length} active of ${GEO_PROMPTS.length}`)));

  if (!dis) {
    const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.xlsx", style: "display:none" });
    const uploadBtn = el("button", { className: "btn sm" }, "⬆ Upload prompts (CSV/Excel)");
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        const rows = /\.xlsx$/i.test(file.name) ? await parseXlsx(await file.arrayBuffer()) : parseCsv(await file.text());
        const prompts = rowsToPrompts(rows);
        if (!prompts.length) { showToast("No prompts found in that file — make sure column A has your prompts.", "error"); return; }
        // Adding prompts triggers loadGeo() below, a full re-fetch-and-render
        // — which used to silently wipe any campaign name/brand/url/
        // competitor/engine edits still sitting unsaved in this same card's
        // inputs. Persist them first so nothing typed but not yet saved is
        // lost just because the user uploaded a prompt list next.
        const detailsSave = await persistDetails();
        if (!detailsSave.ok) { showToast(`Couldn't save campaign details: ${detailsSave.error}`, "error"); return; }
        const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: profile.id, rows: prompts });
        fileInput.value = "";
        if (r.ok) { reportAddResult(r); loadGeo(); } else showToast(r.error, "error");
      } catch (err) {
        showToast(`Couldn't read that file: ${err.message}`, "error");
      }
    };
    wrap.append(el("div", { className: "proj-row" },
      uploadBtn,
      el("span", { className: "muted small" }, "Column A = prompt, column B = tags (comma-separated)"),
      fileInput));

    const manualToggle = el("button", { className: "linkbtn" }, "or type prompts manually");
    const manualBox = el("div", { style: "display:none; margin-top:8px" });
    const ta = el("textarea", {
      rows: 4,
      placeholder: "One prompt per line — add tags after a | (pipe)…\nbest trading app in India | finance, beginner\nbest broker for beginners | finance",
    });
    const addBtn = el("button", { className: "btn sm" }, "➕ Add prompts");
    addBtn.onclick = async () => {
      // Reported: a long prompt's own commas were being read as tag
      // separators, turning most of the sentence into tags — splitting on
      // EVERY comma in the line assumed a short "prompt, tag, tag" shape,
      // but a real prompt ("best phones under 20k, with a good camera and
      // battery") uses commas as ordinary punctuation just as often. A pipe
      // never appears in normal prose, so only an explicit `| tag, tag`
      // suffix is treated as tags now — a comma in the prompt itself is
      // just a comma, however long the prompt runs.
      const rows = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const bar = line.indexOf("|");
        const text = (bar === -1 ? line : line.slice(0, bar)).trim();
        const tags = bar === -1 ? [] : line.slice(bar + 1).split(",").map((t) => t.trim()).filter(Boolean);
        return { text, tags };
      }).filter((r) => r.text);
      if (!rows.length) return;
      // Same reasoning as the upload path above: save whatever's currently
      // in the campaign-details fields before the loadGeo() a successful
      // add triggers, so it isn't wiped out unsaved.
      const detailsSave = await persistDetails();
      if (!detailsSave.ok) { showToast(`Couldn't save campaign details: ${detailsSave.error}`, "error"); return; }
      const r = await send({ type: "geo-prompt-bulk-add-rows", profileId: profile.id, rows });
      if (r.ok) { ta.value = ""; reportAddResult(r); loadGeo(); } else showToast(r.error, "error");
    };
    manualBox.append(ta, el("div", { className: "proj-row", style: "margin-top:6px" }, addBtn));
    manualToggle.onclick = () => { manualBox.style.display = manualBox.style.display === "none" ? "block" : "none"; };
    wrap.append(manualToggle, manualBox);
  }

  if (!GEO_PROMPTS.length) {
    wrap.append(el("div", { className: "empty" }, "No prompts yet — upload a CSV/Excel or add them manually above."));
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
    if (promptTagFilter.length && !promptTagFilter.some((t) => (p.tags || []).includes(t))) return false;
    return true;
  });

  const body = el("div", { className: "prompt-table-layout" });
  if (tags.length) {
    const sidebar = el("div", { className: "tag-sidebar" });
    sidebar.append(el("div", { className: "muted small", style: "margin-bottom:6px" }, "Tags"));
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
        const renameBtn = el("button", { className: "tag-icon-btn", title: `Rename tag "${t}"` }, "✎");
        renameBtn.onclick = async () => {
          const next = window.prompt(`Rename tag "${t}" to:`, t);
          if (!next || !next.trim() || next.trim() === t) return;
          const r = await send({ type: "geo-tag-rename", profileId: profile.id, oldTag: t, newTag: next.trim() });
          if (r.ok) { promptTagFilter = promptTagFilter.map((x) => (x === t ? next.trim() : x)); loadGeo(); } else showToast(r.error, "error");
        };
        const delBtn = el("button", { className: "tag-icon-btn danger", title: `Delete tag "${t}"` }, "✕");
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
  headerCells.push(el("th", {}, "Prompt"), el("th", {}, "Tags"));
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
    const tagWrap = el("div", { className: "tagline" });
    (p.tags || []).forEach((t) => tagWrap.append(el("span", { className: "tag" }, t)));
    if (!dis) {
      const ti = el("input", { type: "text", className: "taginput", placeholder: "+ tag" });
      ti.onkeydown = async (ev) => {
        if (ev.key !== "Enter" || !ti.value.trim()) return;
        const newTags = [...new Set([...(p.tags || []), ...ti.value.split(",").map((s) => s.trim()).filter(Boolean)])];
        await send({ type: "geo-prompt-save", prompt: { ...p, tags: newTags } });
        loadGeo();
      };
      tagWrap.append(ti);
    }
    cells.push(el("td", {}, tagWrap));
    table.append(el("tr", { className: p.active === false ? "inactive-row" : "" }, ...cells));
  });

  body.append(el("div", { className: "prompt-table-scroll" }, table));
  wrap.append(body);
  if (promptSearch || promptTagFilter.length || promptOnlyUnassigned) {
    wrap.append(el("div", { className: "muted small", style: "margin-top:6px" }, `Showing ${filtered.length} of ${GEO_PROMPTS.length} prompts.`));
  }
  return wrap;
}

function renderCampaignSummary(profile) {
  const card = el("div", { className: "card campaign-summary" });
  const delBtn = el("button", { className: "btn sm ghost danger" }, "🗑 Delete");
  delBtn.onclick = trashCampaign(profile);
  card.append(el("div", { className: "card-header" }, el("h3", {}, profile.name || "Campaign"), el("span", { className: "muted small" }, "🔒 locked"), delBtn));
  const meta = el("div", { className: "campaign-meta" });
  const engLabels = ENGINES.filter((e) => (profile.engines || []).includes(e.id)).map((e) => e.label);
  meta.append(
    el("span", {}, `Brand: ${profile.brand?.name || "—"}`),
    el("span", {}, `${GEO_PROMPTS.filter((p) => p.active !== false).length} active prompts`),
    el("span", {}, `LLMs: ${engLabels.join(", ") || "—"}`),
    el("span", {}, `Last run: ${profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleDateString() : "never"}`),
  );
  card.append(meta);
  const toggle = el("button", { className: "linkbtn" }, campaignManageOpen ? "Hide setup & prompts" : "Manage setup & prompts");
  toggle.onclick = () => { campaignManageOpen = !campaignManageOpen; renderCampaigns(); };
  card.append(el("div", { style: "margin-top:8px" }, toggle));
  return card;
}

function renderRunCard(profile) {
  const rc = el("div", { className: "card" });
  rc.append(el("div", { className: "card-header" }, el("h3", {}, "Run")));
  const vol = runVolume(GEO_PROMPTS, profile.engines || []);
  const due = runDue(profile);

  if (due && vol.submissions) {
    rc.append(el("div", { className: "geo-due" },
      `Today's run hasn't happened yet — last run ${profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleDateString() : "never"}.`));
  }
  rc.append(el("p", { className: "muted" },
    `This run will submit ${vol.submissions} prompt${vol.submissions === 1 ? "" : "s"} (${vol.prompts} prompt${vol.prompts === 1 ? "" : "s"} × ${vol.engines} engine${vol.engines === 1 ? "" : "s"}) through your logged-in accounts, paced with human-like gaps.`));
  if (vol.submissions > 60) {
    rc.append(el("div", { className: "warn-box" },
      el("span", {}, `${vol.submissions} automated submissions in one run is a lot of activity on one account. Consider splitting your prompts across campaigns or pausing some, and keep an eye on the run rather than leaving it unattended.`)));
  }
  const runBtn = el("button", { className: "btn primary" }, "▶ Start run");
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
      loadGeo();
    };
    await attempt(false);
  });
  const pauseBtn = el("button", { className: "btn ghost" }, "⏸ Pause");
  pauseBtn.onclick = async () => {
    const r = await send({ type: "loader-pause" });
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  const resumeBtn = el("button", { className: "btn ghost" }, "▶ Resume");
  // Resume can genuinely fail now — a run interrupted by the browser closing
  // has no tab left, so resuming has to open one, and Chrome can refuse.
  // Rendering that {ok:false} reply as a status would blank the live panel and
  // make a paused run look finished, so it's reported and the status left be.
  resumeBtn.onclick = async () => {
    const r = await send({ type: "loader-resume" });
    if (!r || r.ok === false) { showToast(r?.error || "Couldn't resume the run.", "error"); return; }
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  const stopBtn = el("button", { className: "btn danger" }, "■ Stop");
  stopBtn.onclick = async () => {
    const r = await send({ type: "loader-stop" });
    withScrollPreserved(() => renderLoaderStatus(r));
  };
  rc.append(el("div", { className: "ft-actions" }, runBtn, pauseBtn, resumeBtn, stopBtn));
  rc.append(el("div", { id: "loaderStatus", className: "status-msg" }));
  // Paint status immediately rather than waiting for the next 1.5s poll tick
  // — this card is rebuilt from scratch (root.textContent = "" in
  // renderCampaignsImpl) every time the Campaigns tab re-renders, so
  // without this the status box would flash empty for up to 1.5s on every
  // switch back to this tab while a run is in flight.
  send({ type: "loader-status" }).then((s) => { if (s.ok) renderLoaderStatus(s); });
  rc.append(renderRunHistory(profile));
  return rc;
}

// Durable per-run history — reads geoRuns, which background.js now keeps in
// sync (status/captured/failed/finishedAt) as a run progresses and on
// completion; previously that store was written once at creation and never
// updated again, so this had nothing real to show and wasn't called at all.
function renderRunHistory(profile) {
  const box = el("div", { className: "card loader-history", id: "runHistory" });
  box.append(el("div", { className: "card-header" }, el("h3", {}, "Run history")));
  const list = el("div", { className: "muted small" }, "Loading…");
  box.append(list);
  send({ type: "geo-run-list", profileId: profile.id }).then((r) => {
    list.textContent = "";
    const runs = (r.ok ? r.runs : []).slice(0, 10);
    if (!runs.length) { list.append("No runs yet."); return; }
    const table = el("div", { className: "loader-history-rows" });
    runs.forEach((run) => {
      const dur = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : null;
      const statusLabel = { running: "Running", done: "Done", stopped: "Stopped", failed: "Failed" }[run.status] || run.status;
      // Clickable: this list used to be read-only text, so seeing that one run
      // captured fewer than the others gave you no way to go and look at it.
      const row = el("div", {
        className: `loader-history-row status-${run.status} clickable`,
        title: "Show only this run's results in the Dashboard",
        style: "cursor:pointer",
      },
        el("span", { className: "muted" }, new Date(run.startedAt).toLocaleString()),
        el("span", {}, statusLabel),
        el("span", {}, `${run.captured || 0}/${run.expected || 0} captured${run.failed ? `, ${run.failed} failed` : ""}`),
        el("span", { className: "muted" }, dur ? `took ${dur}` : ""),
        el("span", { className: "linkbtn" }, "View results →"));
      row.onclick = () => {
        geoRunFilter = run.id;
        geoActiveId = profile.id;
        showTab("dashboard");
        renderDashboard();
      };
      table.append(row);
    });
    list.append(table);
  });
  return box;
}

/* ---------- Campaign performance metrics (rendered from the Dashboard) ---------- */

async function refreshGeoMetrics(profile, prompts = [], since, until) {
  const mc = $("#geoMetrics");
  if (!mc || !profile) return;

  // Run list feeds the run picker below. Fetched here rather than in the
  // picker so switching runs doesn't refetch it on every change, and so a
  // failure to load it degrades to "All runs" instead of an empty control.
  if (!geoRunsCache.length || geoRunsCache[0]?.profileId !== profile.id) {
    const rl = await send({ type: "geo-run-list", profileId: profile.id });
    geoRunsCache = rl && rl.ok ? (rl.runs || []) : [];
    // A run scope from a previous campaign must not survive into this one.
    if (geoRunFilter && !geoRunsCache.some((r) => r.id === geoRunFilter)) geoRunFilter = "";
  }

  const r = await send({
    type: "geo-metrics",
    profileId: profile.id,
    tags: geoTagFilter,
    engines: geoEngineFilter,
    runId: geoRunFilter || undefined,
    since, until,
  });
  beginSwap(mc);
  mc.textContent = "";
  const head = el("div", { className: "card-header" }, el("h3", {}, `Campaign Performance — ${profile.name || "Untitled"}`));
  mc.append(head);

  if (!r.ok) { mc.append(el("div", { className: "empty" }, r.error || "Couldn't load metrics.")); return; }
  const m = r.metrics;

  // The card is ordered by what the campaign is FOR: who am I looking at,
  // how visible are they, how does that compare. Everything else — the
  // capture/crawl counts, the per-engine split, whether your own site got
  // cited — is supporting detail and lives in one disclosure at the bottom.
  // Twelve tiles of numbers above the fold was the reported clutter.
  //
  // Timeframe is the same filter as the rest of the Dashboard (see
  // renderDashboardImpl) — no separate "Last 7/30/90 days" selector here, so
  // there's only ever one time filter to reason about.
  const controls = el("div", { className: "campaign-controls" });
  head.append(controls);

  /* Run scope.
   *
   * Reported: "if I run the same campaign multiple times and I want to open
   * one, how would I do that in the dashboard — I don't always want the
   * overall result." Every campaign number here used to be pooled across all
   * runs with no way to separate them, which is the wrong default for the
   * question "did last night's run go worse than the one before". The
   * aggregate stays the default; this narrows it to a single run.
   */
  {
    const runSel = el("select", { className: "filter", id: "geoRunPick",
      title: "Show results from every run of this campaign, or just one" });
    runSel.append(el("option", { value: "" }, "All runs (combined)"));
    // Raw toLocaleString() renders as "16/09/2026, 15:50:29" on an en-GB/
    // en-IN locale — ambiguous day/month order, second-level precision
    // nobody needs, and a comma-separated run-on that reads as unformatted
    // debug output rather than a product's own UI. Explicit month name and
    // no seconds reads the same regardless of the browser's locale, and
    // matches the timestamp style already used in every exported report
    // (see exportDoc.js's fmtDate).
    const fmtRunWhen = (ts) => new Date(ts).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    for (const run of geoRunsCache) {
      const when = fmtRunWhen(run.startedAt);
      const outcome = run.failed ? `${run.captured || 0} ok, ${run.failed} failed` : `${run.captured || 0} captured`;
      runSel.append(el("option", { value: run.id }, `${when} — ${outcome}`));
    }
    runSel.value = geoRunFilter || "";
    runSel.onchange = () => {
      geoRunFilter = runSel.value;
      refreshGeoMetrics(profile, prompts, since, until);
      refreshPromptPerformance(profile, prompts, since, until);
    };
    controls.append(runSel);

    /* The whole campaign, as a workbook.
     *
     * Sits beside the run picker so it exports exactly what is on screen: no
     * run selected means every run, a run selected means that run. An export
     * button whose scope differs from the view above it is a reliable way to
     * hand someone the wrong numbers. */
    const wbBtn = el("button", { className: "btn sm ghost",
      title: "Download every sheet of this campaign's data as an Excel workbook" }, "⬇ Full workbook");
    wbBtn.onclick = withBusy(wbBtn, "Building…", async () => {
      const r = await send({
        type: "geo-export-workbook",
        profileId: profile.id,
        runId: geoRunFilter || undefined,
        tags: geoTagFilter,
        engines: geoEngineFilter,
        since, until,
      });
      if (!r || !r.ok) { showToast((r && r.error) || "Couldn't build the workbook.", "error"); return; }
      download(r.filename || `citoskeleton-campaign-${Date.now()}.xls`, r.xml, "application/vnd.ms-excel");
      showToast("Workbook downloaded — 11 sheets.");
    });
    controls.append(wbBtn);
    if (geoRunFilter) {
      const clear = el("button", { className: "linkbtn" }, "show all runs");
      clear.onclick = () => {
        geoRunFilter = "";
        refreshGeoMetrics(profile, prompts, since, until);
        refreshPromptPerformance(profile, prompts, since, until);
      };
      controls.append(clear);
    }
  }

  // The engine filter lives in the Dashboard's own filter row, above — one
  // control for the whole tab. A second one here read a different variable
  // and was the reported "changing the model changes nothing" bug.
  if (geoEngineFilter.length) {
    const only = availableEngines().find((e) => e.id === geoEngineFilter[0]);
    head.append(el("span", { className: "scope-note muted small" },
      `${only ? only.label : geoEngineFilter[0]} only`));
  }

  const tags = allTags(prompts);
  if (tags.length) {
    const tw = el("div", { className: "tagline", style: "margin-top:8px" });
    tw.append(el("span", { className: "muted small" }, "Tags: "));
    // Cap the row so a campaign with many tags doesn't push the actual KPI
    // numbers off screen. A tag the user has ACTIVELY filtered on always
    // shows regardless of the cap — collapsing it out of view would hide the
    // very thing "clear" needs to be visible to undo.
    const CAP = 10;
    const shown = geoTagsExpanded ? tags : tags.filter((t, i) => i < CAP || geoTagFilter.includes(t));
    const hiddenCount = tags.length - shown.length;
    shown.forEach((t) => {
      const on = geoTagFilter.includes(t);
      const chip = el("button", { className: `tag clickable${on ? " on" : ""}` }, t);
      chip.onclick = () => {
        geoTagFilter = on ? geoTagFilter.filter((x) => x !== t) : [...geoTagFilter, t];
        refreshGeoMetrics(profile, prompts, since, until);
        refreshPromptPerformance(profile, prompts, since, until);
      };
      tw.append(chip);
    });
    if (hiddenCount > 0) {
      const more = el("button", { className: "linkbtn" }, `+${hiddenCount} more`);
      more.onclick = () => { geoTagsExpanded = true; refreshGeoMetrics(profile, prompts, since, until); refreshPromptPerformance(profile, prompts, since, until); };
      tw.append(more);
    } else if (geoTagsExpanded && tags.length > CAP) {
      const less = el("button", { className: "linkbtn" }, "show fewer");
      less.onclick = () => { geoTagsExpanded = false; refreshGeoMetrics(profile, prompts, since, until); refreshPromptPerformance(profile, prompts, since, until); };
      tw.append(less);
    }
    if (geoTagFilter.length) {
      const clr = el("button", { className: "linkbtn" }, "clear");
      clr.onclick = () => {
        geoTagFilter = [];
        refreshGeoMetrics(profile, prompts, since, until);
        refreshPromptPerformance(profile, prompts, since, until);
      };
      tw.append(clr);
    }
    mc.append(tw);
  }

  if (!m.totalResponses) {
    mc.append(el("div", { className: "empty", style: "margin-top:10px" },
      "No tracked responses yet for these filters. Head to the Campaigns tab to start a run."));
    return;
  }

  /* Brand switcher — the campaign view points at one brand at a time.
     A row in a table can be read but not analysed; pointing the whole view at
     a brand is what makes a competitor's numbers as inspectable as your own. */
  const focusRow = geoFocusBrand
    ? m.brands.find((b) => b.name === geoFocusBrand)
    : null;
  // A brand can vanish between renders (filters narrowed, exclusion applied).
  // Falling back to the own brand beats rendering an empty KPI row.
  const own = focusRow || m.own;
  if (!focusRow) geoFocusBrand = null;

  // A dropdown, not chips: a campaign can legitimately end up tracking twenty
  // brands, and a wrapping chip row would push the numbers off the screen at
  // exactly the point the campaign gets interesting. Each option carries its
  // visibility so the list is still a ranking you can read.
  const picker = el("select", { className: "filter brand-picker", title: "Point the whole campaign view at one brand" });
  const ownGroup = el("optgroup", { label: "Your brand" });
  const compGroup = el("optgroup", { label: `Competitors (${m.brands.filter((b) => !b.isOwn).length})` });
  m.brands.forEach((b) => {
    const opt = el("option", {
      value: b.name,
      selected: !!(own && b.name === own.name),
    }, `${b.isOwn ? `${b.name} (you)` : b.name} · ${fmtPct(b.visibility)}`);
    (b.isOwn ? ownGroup : compGroup).append(opt);
  });
  if (ownGroup.childNodes.length) picker.append(ownGroup);
  if (compGroup.childNodes.length) picker.append(compGroup);
  picker.onchange = () => {
    const chosen = m.brands.find((b) => b.name === picker.value);
    geoFocusBrand = chosen && chosen.isOwn ? null : picker.value;
    refreshGeoMetrics(profile, prompts, since, until);
    refreshPromptPerformance(profile, prompts, since, until);
  };
  controls.append(picker);

  /* KPI row */
  const kpis = el("div", { className: "geo-kpis" });
  // `term` is a key into src/lib/glossary.js — the definition, formula and
  // caveat all come from there so the same metric reads identically wherever
  // it appears.
  const kpi = (label, value, sub, term) => {
    const b = el("div", { className: "geo-kpi" });
    b.append(el("div", { className: "k-label", ...(term ? { "data-term": term } : {}) }, label));
    b.append(el("div", { className: "k-value" }, value));
    if (sub) b.append(el("div", { className: "k-sub muted" }, sub));
    return b;
  };
  // Whose numbers these are. "your" is right for the own brand and actively
  // misleading once the view is pointed at a competitor.
  const whose = own?.isOwn ? "your" : `${own?.name || "this brand"}'s`;
  const Whose = own?.isOwn ? "Your" : `${own?.name || "This brand"}'s`;
  // Four headline numbers, not six. Source Visibility and Citations are about
  // whether YOUR WEBSITE got used as a source — a different question from
  // whether the brand got mentioned, and one most campaigns can't act on
  // until the first one is answered. They move into the detail below.
  kpis.append(
    // The brand is named here rather than on every tile: four big numbers
    // floating under a dropdown you have already scrolled past need one
    // anchor, not four repetitions.
    kpi("Brand Visibility", fmtPct(own?.visibility),
      `${own?.name || "—"} in ${own?.responsesPresent || 0} of ${m.totalResponses} responses`, "visibility"),
    kpi("Share of Voice", fmtPct(own?.shareOfVoice),
      el("span", { "data-term": "mentionPool" }, `${own?.mentions || 0} of ${m.mentionPool} tracked mentions`),
      "shareOfVoice"),
    kpi("Avg position", fmtPos(own?.avgPosition), "rank among tracked brands", "avgPosition"),
    kpi("Mentions", String(own?.mentions ?? 0), "times named in answers", "mentions"),
  );
  mc.append(kpis);

  /* Competitors the user never typed.
     A campaign with no competitors configured measures nothing: Share of
     Voice, Position and the Brands columns are all computed against the
     tracked set, which would be the own brand talking to itself. So when the
     user hasn't said who they compete with, the answers are asked instead —
     but the inference is stated out loud, and never written into the profile
     without the user clicking to accept it. */
  if (r.autoCompetitors && r.autoCompetitors.length) {
    const banner = el("div", { className: "auto-comp-banner" });
    banner.append(el("div", { className: "small" },
      el("strong", { "data-term": "autoCompetitor" }, "Competitors inferred from your captures. "),
      el("span", { className: "muted" },
        `You haven't set any competitors on this campaign, so the ${r.autoCompetitors.length} brand${r.autoCompetitors.length === 1 ? "" : "s"} `
        + "these answers named most often are being used instead. Nothing has been saved to the campaign.")));
    // Each chip can be dismissed. Detection is industry-agnostic and will
    // sometimes surface a publisher, a retailer, or one of your own
    // sub-brands; without a way to say "not a competitor" the only options
    // were to accept a wrong denominator or ignore the feature.
    const chips = el("div", { className: "tagline" });
    r.autoCompetitors.forEach((n) => {
      const chip = el("span", { className: "tag tag-removable" }, n);
      const x = el("button", { className: "tag-x", title: `Don't treat ${n} as a competitor` }, "×");
      x.onclick = async () => {
        x.disabled = true;
        const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name: n });
        if (!res.ok) { x.disabled = false; showToast(res.error || "Couldn't exclude that brand", "error"); return; }
        showToast(`${n} is no longer counted as a competitor`);
        if (geoFocusBrand === n) geoFocusBrand = null;
        refreshGeoMetrics(res.profile, prompts, since, until);
        refreshPromptPerformance(res.profile, prompts, since, until);
      };
      chip.append(x);
      chips.append(chip);
    });
    banner.append(chips);
    const save = el("button", { className: "btn sm ghost" }, "Save these as competitors");
    save.onclick = async () => {
      save.disabled = true;
      const res = await send({
        type: "geo-profile-save",
        profile: { ...profile, competitors: r.autoCompetitors.map((n) => ({ name: n, url: "" })) },
      });
      save.disabled = false;
      if (!res.ok) { showToast(res.error || "Couldn't save competitors", "error"); return; }
      showToast(`Saved ${r.autoCompetitors.length} competitors to ${profile.name || "this campaign"}`);
      loadGeo();
      refreshGeoMetrics(res.profile, prompts, since, until);
      refreshPromptPerformance(res.profile, prompts, since, until);
    };
    banner.append(save);
    mc.append(banner);
  }

  /* Anything the user has said is not a competitor, with a way back — an
     exclusion you can't see and can't undo is a trap. */
  if (r.excludedBrands && r.excludedBrands.length) {
    const box = el("div", { className: "excluded-row muted small" });
    box.append(el("span", {}, "Not counted as competitors:"));
    r.excludedBrands.forEach((n) => {
      const chip = el("span", { className: "tag tag-removable is-excluded" }, n);
      const undo = el("button", { className: "tag-x", title: `Count ${n} as a competitor again` }, "↺");
      undo.onclick = async () => {
        undo.disabled = true;
        const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name: n, restore: true });
        if (!res.ok) { undo.disabled = false; showToast(res.error || "Couldn't restore that brand", "error"); return; }
        refreshGeoMetrics(res.profile, prompts, since, until);
        refreshPromptPerformance(res.profile, prompts, since, until);
      };
      chip.append(undo);
      box.append(chip);
    });
    mc.append(box);
  }

  /* competitor table — every row is clickable, own brand included, so a
     competitor's numbers can be broken down per-prompt exactly the same way
     the campaign's own brand can be in the full Prompt Performance table
     below (see openBrandDetailModal). */
  const wrap = el("div", { className: "drill-scroll", style: "margin-top:14px" });
  const t = el("table", { className: "drill-table" });
  t.append(el("tr", {},
    el("th", {}, "Brand"),
    el("th", { className: "num", "data-term": "visibility" }, "Visibility"),
    el("th", { className: "num", "data-term": "shareOfVoice" }, "Share of Voice"),
    el("th", { className: "num", "data-term": "mentions" }, "Mentions"),
    el("th", { className: "num", "data-term": "avgPosition" }, "Avg position"),
    el("th", { className: "num", "data-term": "citations" }, "Citations"),
    el("th", { className: "num", "data-term": "sourceVisibility" }, "Source vis.")));
  m.brands.forEach((b) => {
    const focused = own && b.name === own.name;
    const tr = el("tr", {
      className: `clickable-row${b.isOwn ? " own-brand" : ""}${focused ? " focused-brand" : ""}`,
      title: `Click for ${b.name}'s per-prompt performance`,
    });
    tr.onclick = () => openBrandDetailModal(profile, b, prompts, since, until);
    const nameCell = el("td", { className: "td-domain" }, b.isOwn ? `${b.name} (you)` : b.name);
    if (b.auto) nameCell.append(el("span", { className: "auto-tag", title: "Detected in your captures — not a competitor you configured" }, "auto"));
    if (b.auto) {
      // Only inferred rows can be excluded here. A competitor the user typed
      // is removed by editing the campaign, where they put it.
      const drop = el("button", { className: "row-x", title: `Don't treat ${b.name} as a competitor` }, "×");
      drop.onclick = async (ev) => {
        ev.stopPropagation();          // the row itself opens the drill-down
        drop.disabled = true;
        const res = await send({ type: "geo-brand-exclude", profileId: profile.id, name: b.name });
        if (!res.ok) { drop.disabled = false; showToast(res.error || "Couldn't exclude that brand", "error"); return; }
        showToast(`${b.name} is no longer counted as a competitor`);
        if (geoFocusBrand === b.name) geoFocusBrand = null;
        refreshGeoMetrics(res.profile, prompts, since, until);
        refreshPromptPerformance(res.profile, prompts, since, until);
      };
      nameCell.append(drop);
    }
    tr.append(nameCell);
    tr.append(el("td", { className: "num" }, fmtPct(b.visibility)));
    tr.append(el("td", { className: "num" }, fmtPct(b.shareOfVoice)));
    tr.append(el("td", { className: "num" }, String(b.mentions)));
    tr.append(el("td", { className: "num" }, fmtPos(b.avgPosition)));
    tr.append(el("td", { className: "num" }, String(b.citations)));
    tr.append(el("td", { className: "num" }, fmtPct(b.sourceVisibility)));
    t.append(tr);
  });
  wrap.append(t);
  mc.append(wrap);

  /* Supporting detail, in one disclosure rather than three toggles.
     Everything here is real and sometimes wanted — it just isn't the answer
     the campaign exists to give, and above the fold it was burying the answer
     under twelve tiles of numbers. Open state is remembered across re-renders
     so changing a filter doesn't shut it while you're reading it. */
  const more = el("details", { className: "more-detail", ...(geoDetailOpen ? { open: "open" } : {}) });
  more.append(el("summary", {}, "More detail",
    el("span", { className: "muted small" }, " — your site as a source, by engine, data collected")));
  more.addEventListener("toggle", () => { geoDetailOpen = more.open; });

  // 1. Your site as a source. A different question from brand visibility:
  //    "did anyone get MENTIONED" vs "did MY PAGES get used".
  const siteBox = el("div", { className: "detail-block" });
  siteBox.append(el("div", { className: "detail-title muted small" }, `${own?.name || "This brand"} as a source`));
  const siteStats = el("div", { className: "statgrid" });
  [[fmtPct(own?.sourceVisibility), "Source visibility", "sourceVisibility"],
   [String(own?.citations ?? 0), "Citations", "citations"],
   [String(own?.sourceResponses ?? 0), "Responses with your site", "responses"],
  ].forEach(([n, l, term]) => siteStats.append(
    el("div", { className: "stat", "data-term": term },
      el("div", { className: "n" }, n), el("div", { className: "l" }, l))));
  siteBox.append(siteStats);
  if (!own?.url) {
    siteBox.append(el("div", { className: "muted small", style: "margin-top:6px" },
      own?.isOwn
        ? "No website set on this campaign, so there is nothing to match sources against — add one in the Campaigns tab."
        : `No website on record for ${own?.name}, so its pages can't be recognised in the source list.`));
  }
  more.append(siteBox);

  /* 2. Per-engine split for the focused brand.
     "Strong on ChatGPT, invisible on Gemini" is one of the few findings that
     changes what you would actually do, and a profile-wide average hides it
     completely. Only shown when there is more than one engine to compare —
     with one engine these numbers are the KPI row again. */
  const engineIdsWithData = Object.keys(r.byEngine || {});
  if (engineIdsWithData.length > 1 && own) {
    const box = el("div", { className: "detail-block engine-split" });
    box.append(el("div", { className: "detail-title muted small" }, `${own.name} by engine`));
    const grid = el("div", { className: "engine-split-grid" });
    engineIdsWithData.forEach((id) => {
      const engRow = r.byEngine[id];
      const row = engRow.metrics.brands.find((b) => b.name === own.name);
      const cell = el("div", { className: "engine-split-cell" });
      cell.append(el("div", { className: "engine-split-head" },
        engineChip(id, ENGINES.find((e) => e.id === id)?.label || id),
        el("span", { className: "muted small" }, `${engRow.responses} response${engRow.responses === 1 ? "" : "s"}`)));
      cell.append(el("div", { className: "engine-split-nums" },
        el("div", {}, el("strong", {}, fmtPct(row?.visibility)), el("span", { className: "muted small" }, "Visibility")),
        el("div", {}, el("strong", {}, fmtPct(row?.shareOfVoice)), el("span", { className: "muted small" }, "Share of Voice")),
        el("div", {}, el("strong", {}, fmtPos(row?.avgPosition)), el("span", { className: "muted small" }, "Avg position")),
        el("div", {}, el("strong", {}, String(row?.mentions ?? 0)), el("span", { className: "muted small" }, "Mentions"))));
      grid.append(cell);
    });
    box.append(grid);
    more.append(box);
  }

  // 3. What was collected. Diagnostics about the crawl, not about the brand —
  //    which is why it used to be the first thing on screen and shouldn't be.
  if (r.overview) {
    const ov = r.overview;
    const box = el("div", { className: "detail-block" });
    box.append(el("div", { className: "detail-title muted small" }, "Data collected"));
    const ovStats = el("div", { className: "statgrid" });
    [[ov.captures, "Captures", "captures"], [ov.searched, "With search", "withSearch"],
     [ov.fanTotal, "Fan-out queries", "fanout"], [ov.domainCount, "Unique domains", "uniqueDomains"],
     [ov.citedTotal, "Cited", "citedOutcome"], [ov.fetchedTotal, "Read-only", "readOnly"]].forEach(([n, l, term]) =>
      ovStats.append(el("div", { className: "stat", "data-term": term },
        el("div", { className: "n" }, String(n)), el("div", { className: "l" }, l))));
    box.append(ovStats);
    more.append(box);
  }
  mc.append(more);

  /* honest gap, stated in the UI rather than left for the user to discover */
  mc.append(el("div", { className: "geo-note muted small", "data-term": "sentiment" },
    `Sentiment: not measured. ${SENTIMENT_NOTE}`));

  const dl = el("button", { className: "btn sm ghost", style: "margin-top:10px" }, "⬇ Export metrics CSV");
  dl.onclick = () => {
    const rows = [["Brand", "Is own", "Auto-detected", "Visibility %", "Share of Voice %", "Mentions", "Avg position", "Citations", "Source visibility %", "Responses present", "Total responses"]];
    m.brands.forEach((b) => rows.push([b.name, b.isOwn ? "yes" : "no", b.auto ? "yes" : "no", b.visibility.toFixed(2), b.shareOfVoice.toFixed(2), b.mentions, b.avgPosition == null ? "" : b.avgPosition.toFixed(2), b.citations, b.sourceVisibility.toFixed(2), b.responsesPresent, m.totalResponses]));
    download(`citoskeleton-tracking-${profile.name.replace(/\W+/g, "-")}-${Date.now()}.csv`, csvOf(rows), "text/csv");
  };
  mc.append(dl);
}

// Per-run detail toggle state, keyed by promptId — which prompts' run
// history is expanded beyond just the latest run.
let expandedPromptRuns = new Set();
let sourceViewMode = "domain"; // "domain" | "url"
// Both live at module scope, not inside refreshPromptPerformance: every
// render tears the tab down and rebuilds it, so anything held in a local
// would reset on the next keystroke / filter change.
let geoPromptSearch = "";
let sourceSearch = "";

const posLabel = (n) => (n == null ? "—" : `#${n}`);

/* One engine's result for one prompt, as two glanceable badges instead of the
 * old "✓ #1 / Domain cited ✕" string — a tick and a cross answering two
 * different questions in the same cell read as one verdict and were easy to
 * misparse.
 *
 * Both badges are individually clickable, opening THAT run's capture in
 * Analyze — previously only the prompt's own title link opened anything, and
 * it always opened whichever run happened to be most recent, so there was no
 * way to specifically check "what did Gemini say" once ChatGPT had run more
 * recently. Attaching the click handler directly to each badge (rather than
 * a wrapping element) matters because promptPerfCards() below lifts these
 * exact badge nodes out of their <td> into a card layout in the popup — the
 * handler has to travel with the node itself to survive that move.
 *
 * `whose` names whose result this is, for the tooltip copy — "Your brand" /
 * "your own domain" by default (the campaign's own brand, the only caller
 * this used to have), but openBrandDetailModal passes an actual competitor
 * name so a Samsung row doesn't get told "Your brand was not named" about
 * Samsung.
 */
function resultCell(run, whose = { subject: "Your brand", domain: "Your own domain" }) {
  if (!run) return el("td", { className: "pp-cell" }, el("span", { className: "pp-badge none", "data-tip": "This prompt has not been run on this engine yet." }, "no run"));
  const cell = el("td", { className: "pp-cell" });
  const stack = el("div", { className: "pp-stack" });
  const openThis = (ev) => { ev.stopPropagation(); openCapture(run.captureId); };
  const clickable = (node, tip) => {
    node.classList.add("pp-clickable");
    node.setAttribute("data-tip", tip);
    node.title = "Open this capture in Analyze";
    node.onclick = openThis;
    return node;
  };
  if (!run.mentioned) {
    stack.append(clickable(el("span", { className: "pp-badge miss" }, "not mentioned"), `${whose.subject} was not named in this answer.`));
  } else if (run.position == null) {
    // Present but unrankable — a product-card/carousel appearance with no
    // position in the prose. The old "✓ —" implied a missing rank; this says
    // what actually happened.
    stack.append(clickable(el("span", { className: "pp-badge shown" }, "shown"), `${whose.subject} appeared, but not in the written answer, so it has no rank.`));
  } else {
    stack.append(clickable(
      el("span", { className: `pp-badge rank${run.position <= 3 ? " top" : ""}` }, posLabel(run.position)),
      `Ranked ${posLabel(run.position)} among the brands tracked on this campaign.`,
    ));
  }
  stack.append(clickable(
    run.cited ? el("span", { className: "pp-chip cited" }, "domain cited") : el("span", { className: "pp-chip notcited" }, "not cited"),
    run.cited ? `${whose.domain} was cited as a source in this answer.` : `${whose.domain} was not cited as a source in this answer.`,
  ));
  cell.append(stack);
  return cell;
}

// `whose` follows the brand switcher: once the view is pointed at a
// competitor, "your brand" and "your own site" are the wrong words for what
// these badges mean.
const promptPerfLegend = (whose = "your") => el("div", { className: "pp-legend muted small" },
  `#n = ${whose} rank among the brands tracked on this campaign · `,
  el("span", { className: "pp-badge shown" }, "shown"), " = appeared without a rank (product card) · ",
  el("span", { className: "pp-chip cited" }, "domain cited"), ` = ${whose} own site was used as a source`);

/* Popup layout for the same data.
 *
 * A table with a prompt column plus one column per engine needs ~530px; the
 * popup gives it ~444px, so in the popup it was always going to be a
 * sideways-scrolling table with half its columns off-screen. Same numbers,
 * stacked vertically instead — nothing scrolls sideways and nothing is
 * hidden behind a scrollbar. The full-tab view keeps the table, where the
 * width is genuinely there and scanning a column beats reading cards.
 */
function promptPerfCards(filteredPrompts, engineIds, engineLabel, runsOf, rerender, whose) {
  const wrap = el("div", { className: "pp-cards" });
  filteredPrompts.forEach((p, i) => {
    const runs = runsOf(p);
    const card = el("div", { className: `pp-card${runs.length ? "" : " idle"}` });
    const titleRow = el("div", { className: "pp-card-title" });
    titleRow.append(el("span", { className: "pp-card-idx" }, `${i + 1}`));
    if (runs.length) {
      const link = el("a", { href: "#", className: "prompt-link", title: "Open the latest capture of this prompt in Analyze" });
      link.append(highlightMatch(p.text, geoPromptSearch));
      link.onclick = (ev) => { ev.preventDefault(); openCapture(runs[0].captureId); };
      titleRow.append(link);
    } else {
      titleRow.append(el("span", { className: "muted" }, highlightMatch(p.text, geoPromptSearch)));
    }
    card.append(titleRow);

    if ((p.tags || []).length) {
      const tagWrap = el("div", { className: "tagline" });
      p.tags.forEach((t) => tagWrap.append(el("span", { className: "tag" }, t)));
      card.append(tagWrap);
    }

    const engRows = el("div", { className: "pp-card-engines" });
    engineIds.forEach((id) => {
      const run = runs.find((x) => x.platform === id) || null;
      const row = el("div", { className: "pp-card-engine" });
      row.append(el("span", { className: "pp-card-engine-name" }, engineChip(id, engineLabel(id))));
      // resultCell builds a <td>; lift its badges out so the same markup and
      // the same wording drive both layouts.
      const cell = resultCell(run, whose);
      const stack = cell.firstElementChild;
      row.append(stack && stack.classList.contains("pp-stack")
        ? el("span", { className: "pp-card-badges" }, ...stack.childNodes)
        : el("span", { className: "pp-card-badges" }, ...cell.childNodes));
      engRows.append(row);
    });
    card.append(engRows);

    const foot = el("div", { className: "pp-card-foot" });
    foot.append(el("span", { className: "muted small", title: runs.length ? new Date(runs[0].capturedAt).toLocaleString() : "" },
      runs.length ? `Last run ${relTime(runs[0].capturedAt)}` : "Never run"));
    if (runs.length > 1) {
      const expanded = expandedPromptRuns.has(p.id);
      const toggle = el("button", { className: "linkbtn" }, expanded ? "hide earlier runs" : `${runs.length - 1} earlier run${runs.length === 2 ? "" : "s"}`);
      toggle.onclick = () => {
        if (expanded) expandedPromptRuns.delete(p.id); else expandedPromptRuns.add(p.id);
        rerender();
      };
      foot.append(toggle);
    }
    card.append(foot);

    if (runs.length > 1 && expandedPromptRuns.has(p.id)) {
      const hist = el("div", { className: "pp-card-history" });
      runs.slice(1).forEach((run) => {
        const row = el("div", { className: "pp-card-engine" });
        row.append(el("span", { className: "pp-card-engine-name muted" }, engineChip(run.platform, relTime(run.capturedAt))));
        const cell = resultCell(run, whose);
        const stack = cell.firstElementChild;
        row.append(el("span", { className: "pp-card-badges" }, ...(stack && stack.classList.contains("pp-stack") ? stack.childNodes : cell.childNodes)));
        hist.append(row);
      });
      card.append(hist);
    }
    wrap.append(card);
  });
  return wrap;
}

/** Replaces Saved Conversations once a campaign is selected: prompts grouped
 *  with their own-brand mention/position/citation per run (merging reruns
 *  of the same prompt instead of listing every response separately), plus a
 *  domain/URL source breakdown for the same filtered response set. */
async function refreshPromptPerformance(profile, prompts, since, until) {
  const root = $("#geoPromptTable");
  if (!root || !profile) return;

  const r = await send({
    type: "geo-prompt-performance",
    profileId: profile.id,
    // Follows the brand switcher above, so mentioned/position/cited in this
    // table are about whichever brand the campaign view is pointed at.
    focusBrand: geoFocusBrand || undefined,
    tags: geoTagFilter,
    engines: geoEngineFilter,
    runId: geoRunFilter || undefined,
    since, until,
  });
  beginSwap(root);
  root.textContent = "";
  const rerender = () => refreshPromptPerformance(profile, prompts, since, until);

  // Whose performance this table is about, once the brand switcher can point
  // it at a competitor.
  const focused = r.focusBrand && !r.focusIsOwn ? r.focusBrand : null;
  const ppSubject = focused || "your brand";   // "mention your brand" / "mention OnePlus"
  const ppPoss = focused ? `${focused}'s` : "your";
  // resultCell's badge tooltips default to "Your brand was not named" — right
  // for the own brand, wrong the moment the table is pointed at a competitor.
  const ppWhoseTip = focused
    ? { subject: focused, domain: `${focused}'s domain` }
    : { subject: "Your brand", domain: "Your own domain" };
  const head = el("div", { className: "card-header" },
    el("h3", {}, r.focusBrand && !r.focusIsOwn ? `Prompt Performance — ${r.focusBrand}` : "Prompt Performance"));
  root.append(head);

  if (!r.ok) { root.append(el("div", { className: "empty" }, r.error || "Couldn't load prompt performance.")); return; }
  if (!r.hasBrand) {
    root.append(el("div", { className: "empty" }, "Set your brand name on this campaign (Campaigns tab) to see per-prompt mention/citation results."));
    return;
  }

  const filteredPrompts = (geoTagFilter.length
    ? prompts.filter((p) => geoTagFilter.some((t) => (p.tags || []).includes(t)))
    : prompts
  ).filter((p) => matchesSearch(p.text, geoPromptSearch));

  // Search sits in the card header next to the title, the same place the
  // Dashboard puts its filters — this table can run to hundreds of prompts
  // and previously had no way to narrow it at all.
  const searchInp = el("input", {
    id: "geoPromptSearch", type: "text", className: "filter search-input",
    placeholder: "Search words in prompts…",
    title: "Type any words — prompts containing every word are shown, in any order",
    value: geoPromptSearch,
  });
  searchInp.oninput = () => {
    geoPromptSearch = searchInp.value;
    const cursor = searchInp.selectionStart;
    rerender().then(() => {
      const next = $("#geoPromptSearch");
      if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
    });
  };
  head.append(searchInp);

  // --- roll-up of the table below, so the headline answer ("how many of my
  // prompts actually mention me?") doesn't have to be counted by eye ---
  const engineIds = (profile.engines && profile.engines.length) ? profile.engines : [];
  const engineLabel = (id) => ENGINES.find((e) => e.id === id)?.label || id;
  const runsOf = (p) => (r.prompts && r.prompts[p.id]) || [];
  let withRuns = 0, anyMention = 0, anyCite = 0, rankSum = 0, rankN = 0;
  filteredPrompts.forEach((p) => {
    const runs = runsOf(p);
    if (!runs.length) return;
    withRuns++;
    if (runs.some((x) => x.mentioned)) anyMention++;
    if (runs.some((x) => x.cited)) anyCite++;
    runs.forEach((x) => { if (x.position != null) { rankSum += x.position; rankN++; } });
  });
  const summary = el("div", { className: "pp-summary" });
  const sChip = (n, l, tone) => el("div", { className: `pp-sum ${tone || ""}` },
    el("span", { className: "pp-sum-n" }, String(n)), el("span", { className: "pp-sum-l" }, l));
  summary.append(
    sChip(`${withRuns}/${filteredPrompts.length}`, "prompts with runs"),
    sChip(anyMention, `mention ${ppSubject}`, anyMention ? "good" : ""),
    sChip(anyCite, `cite ${ppPoss} domain`, anyCite ? "good" : ""),
    sChip(rankN ? `#${(rankSum / rankN).toFixed(1)}` : "—", "average rank"),
  );
  root.append(summary);

  if (!filteredPrompts.length) {
    root.append(el("div", { className: "empty" },
      geoPromptSearch ? `No prompts match "${geoPromptSearch}".` : "No prompts match the current filters."));
  } else {
    // One column per tracked engine (not a single ambiguous "latest run")
    // so it's clear whether a brand showed up on ChatGPT vs. Gemini rather
    // than one merged result that could be from either.
    if (document.body.classList.contains("popup")) {
      root.append(promptPerfCards(filteredPrompts, engineIds, engineLabel, runsOf, rerender, ppWhoseTip));
      root.append(promptPerfLegend(ppPoss));
    } else {
      const headerCells = [el("th", { className: "pp-col-idx" }, "#"), el("th", {}, "Prompt")];
      engineIds.forEach((id) => headerCells.push(el("th", {}, engineChip(id, engineLabel(id)))));
      headerCells.push(el("th", {}, "Last run"), el("th", { className: "pp-col-more" }, ""));
      const table = el("table", { className: "drill-table prompt-perf-table" }, el("tr", {}, ...headerCells));

      filteredPrompts.forEach((p, i) => {
        const runs = runsOf(p);
        // Clicking a prompt opens its most recent capture in Analyze so the
        // full answer/sources/fan-out can be studied there instead of just
        // the summarized mention/position/citation flags here.
        const promptCell = el("td", { className: "prompt-cell" });
        if (runs.length) {
          const promptLink = el("a", { href: "#", className: "prompt-link", title: "Open the latest capture of this prompt in Analyze" });
          promptLink.append(highlightMatch(p.text, geoPromptSearch));
          promptLink.onclick = (ev) => { ev.preventDefault(); openCapture(runs[0].captureId); };
          promptCell.append(promptLink);
        } else {
          promptCell.append(el("span", { className: "muted" }, highlightMatch(p.text, geoPromptSearch)));
        }
        const tagWrap = el("div", { className: "tagline" });
        (p.tags || []).forEach((t) => tagWrap.append(el("span", { className: "tag" }, t)));
        if (tagWrap.childNodes.length) promptCell.append(tagWrap);

        const cells = [el("td", { className: "pp-col-idx muted" }, String(i + 1)), promptCell];
        if (!runs.length) {
          engineIds.forEach(() => cells.push(resultCell(null, ppWhoseTip)));
          cells.push(el("td", { className: "muted small" }, "never"), el("td", {}));
          table.append(el("tr", { className: "pp-row-idle" }, ...cells));
          return;
        }

        engineIds.forEach((id) => cells.push(resultCell(runs.find((run) => run.platform === id) || null, ppWhoseTip)));
        cells.push(el("td", { className: "pp-time", title: new Date(runs[0].capturedAt).toLocaleString() }, relTime(runs[0].capturedAt)));

        const expandCell = el("td", { className: "pp-col-more" });
        if (runs.length > 1) {
          const expanded = expandedPromptRuns.has(p.id);
          const toggle = el("button", { className: "linkbtn" }, expanded ? "hide" : `+${runs.length - 1}`);
          toggle.title = expanded ? "Hide earlier runs" : `Show ${runs.length - 1} earlier run(s)`;
          toggle.onclick = () => {
            if (expanded) expandedPromptRuns.delete(p.id); else expandedPromptRuns.add(p.id);
            rerender();
          };
          expandCell.append(toggle);
        }
        cells.push(expandCell);
        table.append(el("tr", {}, ...cells));

        if (runs.length > 1 && expandedPromptRuns.has(p.id)) {
          runs.slice(1).forEach((run) => {
            const subCells = [el("td", { className: "pp-col-idx" }), el("td", { className: "muted small" }, "earlier run")];
            engineIds.forEach((id) => subCells.push(run.platform === id ? resultCell(run, ppWhoseTip) : el("td", {})));
            subCells.push(el("td", { className: "pp-time muted small", title: new Date(run.capturedAt).toLocaleString() }, relTime(run.capturedAt)), el("td", {}));
            table.append(el("tr", { className: "prompt-perf-subrow" }, ...subCells));
          });
        }
      });
      root.append(el("div", { className: "drill-scroll" }, table));
      root.append(promptPerfLegend(ppPoss));
    }
  }

  // --- source domains, aggregated from this same filtered response set ---
  // Citation VOLUME and REACH are different numbers and must not be one
  // column: a domain cited three times in a single answer scores three
  // citations but one response of visibility. See src/lib/sources.js for the
  // definitions and test/sources.test.mjs for the worked example.
  const promptTextById = new Map((prompts || []).map((p) => [p.id, p.text]));
  const { domains: domainAgg, urls: urlAgg, totalResponses: srcResponses } =
    aggregateSources(r.prompts || {}, promptTextById);

  root.append(el("div", { className: "wizard-divider" }));
  const srcHead = el("div", { className: "card-header", style: "margin-top:0" }, el("h3", {}, "Source Domains"));
  const modeToggle = el("div", { className: "filter-bar", style: "margin:0" });
  [["domain", "Domains"], ["url", "URLs"]].forEach(([v, l]) => {
    const pill = el("button", { className: `filter-pill${sourceViewMode === v ? " active" : ""}` }, l);
    pill.onclick = () => { sourceViewMode = v; rerender(); };
    modeToggle.append(pill);
  });
  const srcSearchInp = el("input", {
    id: "sourceSearch", type: "text", className: "filter search-input",
    placeholder: sourceViewMode === "domain" ? "Filter domains…" : "Filter URLs…",
    value: sourceSearch,
  });
  srcSearchInp.oninput = () => {
    sourceSearch = srcSearchInp.value;
    const cursor = srcSearchInp.selectionStart;
    rerender().then(() => {
      const next = $("#sourceSearch");
      if (next) { next.focus(); next.setSelectionRange(cursor, cursor); }
    });
  };
  srcHead.append(el("div", { className: "src-head-tools" }, modeToggle, srcSearchInp));
  root.append(srcHead);

  const activeMap = sourceViewMode === "domain" ? domainAgg : urlAgg;
  // Sorted by REACH first, volume second. A domain cited nine times inside a
  // single answer used to outrank one cited once in every answer; the second
  // is the more useful source to know about, and only the visibility ordering
  // says so.
  const rows = [...activeMap.values()]
    .filter((row) => matchesSearch(row.key, sourceSearch))
    .sort((a, b) => b.visibility - a.visibility || b.citations - a.citations
      || b.fetched - a.fetched || a.key.localeCompare(b.key));
  const shown = rows.slice(0, 50);

  if (!shown.length) {
    root.append(el("div", { className: "empty" },
      sourceSearch ? `No sources match "${sourceSearch}".` : "No sources captured yet for these filters."));
  } else {
    const unit = sourceViewMode === "domain" ? "domain" : "page";
    const srcTable = el("table", { className: "drill-table src-table" });
    const hdr = [el("th", { className: "src-col-idx" }, "#"), el("th", {}, sourceViewMode === "domain" ? "Domain" : "URL")];
    if (sourceViewMode === "domain") hdr.push(el("th", { className: "num", "data-term": "distinctUrls" }, "URLs"));
    hdr.push(
      // The bar is on Visibility, not Citations: a percentage has a fixed 0-100
      // scale a bar can honestly represent, where a bar over an unbounded count
      // only ever shows the ratio to whatever the top row happens to be.
      el("th", { "data-term": "domainVisibility" }, "Visibility"),
      el("th", { className: "num", "data-term": "domainCitations" }, "Citations"),
      el("th", { className: "num", "data-term": "distinctPrompts" }, "Prompts"),
      el("th", { className: "num", "data-term": "readOnly" }, "Read-only"));
    srcTable.append(el("tr", {}, ...hdr));

    shown.forEach((row, i) => {
      // Both views drill down now. A domain used to be plain text, with a
      // comment claiming it had "no single source to drill into" — but the
      // domain roll-up is exactly what people want first (how much of my
      // citation volume is this publisher, and through which pages), so it
      // opens a breakdown of its own URLs, each of which opens the prompts.
      const keyCell = el("button", {
        className: "linkbtn td-domain-btn",
        title: sourceViewMode === "domain" ? "Click for this domain's URLs and the prompts they came from" : "Click to see which prompts cited this URL",
      });
      keyCell.append(highlightMatch(row.key, sourceSearch));
      keyCell.onclick = () => (sourceViewMode === "domain"
        ? openDomainDetailModal(row, `Source breakdown · ${profile.name || "Untitled campaign"}`, "prompt")
        : openUrlDetailModal(row.key, profile, since, until));

      const bar = el("div", { className: "src-bar", title: `Cited in ${row.citedResponses} of ${srcResponses} responses` },
        el("div", { className: "src-bar-fill", style: `width:${Math.round(row.visibility)}%` }),
        el("span", { className: "src-bar-n" }, fmtPct(row.visibility)));

      const cells = [el("td", { className: "src-col-idx muted" }, String(i + 1)), el("td", { className: "td-domain" }, keyCell)];
      if (sourceViewMode === "domain") cells.push(el("td", { className: "num" }, String(row.urls.size)));
      cells.push(
        el("td", { className: "src-bar-cell" }, bar),
        el("td", { className: "num" }, String(row.citations || 0)),
        el("td", { className: "num" }, String(row.citedPromptIds.size)),
        el("td", { className: "num muted" }, String(row.fetched || 0)));
      srcTable.append(el("tr", {}, ...cells));
    });
    root.append(el("div", { className: "drill-scroll" }, srcTable));
    if (rows.length > shown.length) {
      root.append(el("div", { className: "muted small", style: "margin-top:6px" }, `Showing the top ${shown.length} of ${rows.length} — narrow it with the filter above.`));
    }
  }
}

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

/** Build the same drill-down row shape openDomainDetailModal expects, but
 *  from ad-hoc (non-campaign) capture data instead of a campaign's tracked
 *  runs — this is what lets the plain Dashboard's "Top Domains" list open
 *  the identical drill-down a campaign's Source Domains table does, instead
 *  of being permanently plain text. Same aggregation, same definitions of
 *  citations and visibility (src/lib/sources.js), so the two paths cannot
 *  drift into reporting different numbers for the same data. */
function adhocDomainRow(domain, recs) {
  const { domains, totalResponses } = aggregateSourcesFromCaptures(recs);
  const row = domains.get(domain);
  if (!row) {
    return { key: domain, citations: 0, fetched: 0, citedResponses: 0, visibility: 0,
             totalResponses, urls: new Set(), citedPromptIds: new Set(), urlList: [] };
  }
  return { ...row, totalResponses };
}

function openAdhocDomainDetailModal(domain, recs) {
  openDomainDetailModal(adhocDomainRow(domain, recs), "Source breakdown · across your captures", "capture");
}

/** Domain drill-down: this publisher's totals, then every URL of theirs that
 *  surfaced, then — expanded per URL — the exact prompts (or, for the ad-hoc
 *  Dashboard, captures) that pulled it in. Clicking one jumps to that
 *  capture in Analyze.
 *
 *  `unit` is "prompt" for a campaign's tracked runs or "capture" for plain
 *  ad-hoc browsing — the two label their counts differently ("N prompts
 *  cited on" vs. "N captures cited in") but are otherwise the same shape,
 *  built by either refreshPromptPerformance's aggregation or adhocDomainRow
 *  above. */
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
          engineChip(run.platform, `${ENGINES.find((e) => e.id === run.platform)?.label || run.platform} · ${new Date(run.capturedAt).toLocaleDateString()} · ${run.cited ? "cited" : "read-only"}`)),
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

  const r = await send({ type: "geo-url-detail", profileId: profile.id, url, tags: geoTagFilter, engines: geoEngineFilter, since, until });
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
      el("td", { className: "muted small", title: new Date(row.capturedAt).toLocaleString() }, relTime(row.capturedAt)),
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
async function openCampaignDomainModal(profile, domain, prompts, since, until) {
  const r = await send({
    type: "geo-prompt-performance", profileId: profile.id,
    tags: geoTagFilter, engines: geoEngineFilter, since, until,
  });
  if (!r.ok) { showToast(r.error || "Couldn't load that domain", "error"); return; }
  const { domains } = aggregateSources(r.prompts || {},
    new Map((prompts || []).map((p) => [p.id, p.text])));
  const row = domains.get(domain);
  if (!row) { showToast(`No captured sources from ${domain} under the current filters.`, "error"); return; }
  openDomainDetailModal(row, `Source breakdown · ${profile.name || "Untitled campaign"}`, "prompt");
}

/**
 * Everything about ONE brand on this campaign — own brand or any competitor.
 *
 * Reported: "when I click on any brand I don't get to know much about that
 * competition's visibility, I don't get data to analyse it."
 *
 * It used to show four chips and a per-prompt list. The chips were already on
 * the table behind the modal, so opening it added almost nothing. What a
 * competitor actually raises is a comparative question the aggregate metrics
 * can't answer, because computeMetrics reduces each brand to its own column
 * and throws the PAIRING away:
 *
 *   - which answers let them in and kept you out          (headToHead)
 *   - when you both appear, who gets named first          (headToHead)
 *   - what the engine was reading when it named them      (brandSourceDomains)
 *   - whether that differs by engine                      (byEngine)
 *   - and then, per prompt, both brands side by side
 *
 * All of it needs answerText to rank by first appearance, so it is assembled
 * in one geo-brand-detail round trip rather than reconstructed here.
 */
async function openBrandDetailModal(profile, brand, prompts, since, until) {
  const { backdrop, body } = openDetailModal(
    brand.isOwn ? `${brand.name} (you)` : brand.name,
    `Brand analysis · ${profile.name || "Untitled campaign"}`,
    { avatarText: brand.name.slice(0, 1).toUpperCase(), avatarKey: brand.name, wide: true },
  );
  body.append(el("div", { className: "muted small" }, "Loading…"));

  const r = await send({
    type: "geo-brand-detail", profileId: profile.id, brand: brand.name,
    tags: geoTagFilter, engines: geoEngineFilter, since, until,
  });
  body.textContent = "";
  if (!r.ok) { body.append(el("div", { className: "empty" }, r.error || "Couldn't load this brand's analysis.")); return; }
  const row = r.row;
  if (!row) { body.append(el("div", { className: "empty" }, `${brand.name} couldn't be matched against the tracked runs.`)); return; }

  const engineLabel = (id) => ENGINES.find((e) => e.id === id)?.label || id;

  /* --- headline --- */
  const stats = el("div", { className: "statgrid modal-statgrid" });
  stats.append(
    modalStat(fmtPct(row.visibility), "Visibility", "accent", null, "visibility"),
    modalStat(fmtPct(row.shareOfVoice), "Share of Voice", "accent", null, "shareOfVoice"),
    modalStat(fmtPos(row.avgPosition), "Avg position", "", null, "avgPosition"),
    modalStat(row.mentions, "Mentions", "", null, "mentions"),
    modalStat(row.citations, "Citations", row.citations ? "good" : "muted", null, "citations"),
  );
  body.append(stats);
  if (r.auto) {
    body.append(el("div", { className: "muted small", style: "margin-bottom:10px" },
      "Inferred from your captures — not a competitor you configured."));
  }

  /* --- head to head: the question a competitor actually raises --- */
  if (r.headToHead && r.ownBrand) {
    const h = r.headToHead;
    body.append(el("div", { className: "modal-section-title" }, `${r.brand} vs ${r.ownBrand}`));
    const h2h = el("div", { className: "h2h" });
    const seg = (n, label, tone, term) => {
      const pct = h.responses ? (n / h.responses) * 100 : 0;
      const cell = el("div", { className: `h2h-seg tone-${tone}`, "data-term": term });
      cell.append(el("div", { className: "h2h-n" }, String(n)));
      cell.append(el("div", { className: "h2h-l muted small" }, label));
      cell.append(el("div", { className: "h2h-bar" }, el("div", { className: "h2h-fill", style: `width:${pct}%` })));
      return cell;
    };
    h2h.append(
      // Listed first on purpose: this is the gap you can act on.
      seg(h.aOnly, `Only ${r.brand}`, "bad", "onlyThem"),
      seg(h.both, "Both named", "neutral", "bothNamed"),
      seg(h.bOnly, `Only ${r.ownBrand}`, "good", "onlyYou"),
      seg(h.neither, "Neither", "muted", "neitherNamed"),
    );
    body.append(h2h);

    if (h.both) {
      const lead = el("div", { className: "h2h-lead muted small" });
      lead.append(el("span", { "data-term": "namedFirst" }, "When both appear: "));
      lead.append(el("strong", {}, `${r.brand} first in ${h.aheadA}`));
      lead.append(el("span", {}, " · "));
      lead.append(el("strong", {}, `${r.ownBrand} first in ${h.aheadB}`));
      if (h.bothUnranked) {
        lead.append(el("span", {},
          ` · ${h.bothUnranked} with no order (shown in a product card rather than written about, so neither is "first")`));
      }
      body.append(lead);
    }
  }

  /* --- by engine --- */
  const engineIds = Object.keys(r.byEngine || {});
  if (engineIds.length > 1) {
    body.append(el("div", { className: "modal-section-title" }, "By engine"));
    const grid = el("div", { className: "engine-split-grid" });
    engineIds.forEach((id) => {
      const e = r.byEngine[id];
      const cell = el("div", { className: "engine-split-cell" });
      cell.append(el("div", { className: "engine-split-head" },
        engineChip(id, engineLabel(id)),
        el("span", { className: "muted small" }, `${e.responses} response${e.responses === 1 ? "" : "s"}`)));
      cell.append(el("div", { className: "engine-split-nums" },
        el("div", {}, el("strong", {}, fmtPct(e.row?.visibility)), el("span", { className: "muted small" }, "Visibility")),
        el("div", {}, el("strong", {}, fmtPct(e.row?.shareOfVoice)), el("span", { className: "muted small" }, "Share of Voice")),
        el("div", {}, el("strong", {}, fmtPos(e.row?.avgPosition)), el("span", { className: "muted small" }, "Avg position")),
        el("div", {}, el("strong", {}, String(e.row?.mentions ?? 0)), el("span", { className: "muted small" }, "Mentions"))));
      grid.append(cell);
    });
    body.append(grid);
  }

  /* --- what the engine was reading --- */
  if (r.sourceDomains && r.sourceDomains.length) {
    body.append(el("div", { className: "modal-section-title", "data-term": "brandSources" },
      `Sources cited when ${r.brand} is named`));
    // Named for what it measures. This is NOT "sites that write about this
    // brand" — a source can be cited for a reason unrelated to a name three
    // paragraphs later. It is "when the engine says this name, what was it
    // reading", which is the honest version and still the useful one.
    body.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
      `Domains cited in the ${row.responsesPresent} answer${row.responsesPresent === 1 ? "" : "s"} that mention ${r.brand}. `
      + "Not proof the page is about them — but it is what the engine had in front of it."));
    const t = el("table", { className: "drill-table" });
    t.append(el("tr", {}, el("th", {}, "Domain"),
      el("th", { className: "num", "data-tip": `Share of the answers mentioning ${r.brand} that cited this domain.` }, "Share"),
      el("th", { className: "num", "data-term": "domainCitations" }, "Citations")));
    r.sourceDomains.forEach((d) => {
      // Clickable, exactly like the campaign's Source Domains table — the
      // question "which pages on this host, under which prompts" is the same
      // question wherever a domain is shown, so it gets the same answer.
      // Aggregated over the whole campaign, not just this brand's answers,
      // because the drill-down is about the SOURCE; the brand context is the
      // list you arrived from.
      const btn = el("button", {
        className: "linkbtn td-domain-btn",
        title: `Click for ${d.domain}'s pages and the prompts they came from`,
      }, d.domain);
      btn.onclick = () => { backdrop.remove(); openCampaignDomainModal(profile, d.domain, prompts, since, until); };
      t.append(el("tr", {},
        el("td", { className: "td-domain" }, btn),
        el("td", { className: "num" }, fmtPct(d.visibility)),
        el("td", { className: "num" }, String(d.citations))));
    });
    body.append(el("div", { className: "drill-scroll" }, t));
  }

  /* --- per prompt, both brands side by side --- */
  if (!r.prompts.length) {
    body.append(el("div", { className: "empty" }, "No tracked prompts matched the current filters."));
    return;
  }
  body.append(el("div", { className: "modal-section-title" }, "Prompt by prompt"));
  body.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
    r.isOwn
      ? "Prompts are listed with the runs behind them — click one to open that capture in Analyze."
      : `Prompts where ${r.brand} appears and ${r.ownBrand || "your brand"} does not are listed first — that is the gap. Click a prompt to open the capture.`));

  const table = el("table", { className: "drill-table" });
  table.append(el("tr", {},
    el("th", {}, "Prompt"),
    el("th", {}, "Engine"),
    el("th", {}, r.brand),
    ...(r.isOwn ? [] : [el("th", {}, r.ownBrand || "You")]),
    el("th", {}, "Date")));

  const verdict = (present, position) => {
    if (!present) return el("span", { className: "pp-badge miss" }, "absent");
    if (position == null) return el("span", { className: "pp-badge shown" }, "shown");
    return el("span", { className: "pp-badge rank" }, `#${position}`);
  };

  r.prompts.forEach((p) => {
    p.runs.forEach((run, i) => {
      const promptCell = el("td", { className: "prompt-cell" });
      if (i === 0) {
        const link = el("a", { href: "#", className: "prompt-link" }, p.promptText);
        link.onclick = (ev) => { ev.preventDefault(); backdrop.remove(); openCapture(run.captureId); };
        promptCell.append(link);
        if (p.tags.length) {
          const tw = el("div", { className: "tagline" });
          p.tags.forEach((t) => tw.append(el("span", { className: "tag" }, t)));
          promptCell.append(tw);
        }
      }
      // A row where they are in and you are out is the one to notice.
      const gap = !r.isOwn && run.present && run.ownPresent === false;
      const cells = [
        promptCell,
        el("td", {}, engineChip(run.platform, engineLabel(run.platform))),
        el("td", {}, verdict(run.present, run.position)),
      ];
      if (!r.isOwn) cells.push(el("td", {}, run.ownPresent == null
        ? el("span", { className: "pp-badge none" }, "—")
        : verdict(run.ownPresent, run.ownPosition)));
      cells.push(el("td", { className: "muted small", title: new Date(run.capturedAt).toLocaleString() }, relTime(run.capturedAt)));
      table.append(el("tr", { className: gap ? "h2h-gap-row" : "" }, ...cells));
    });
  });
  body.append(el("div", { className: "drill-scroll" }, table));
}

/* ---------- wiring ---------- */
document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    // A direct nav click is the user choosing to go here themselves, not
    // "returning" from a link — any "← Back to X" context from an earlier
    // openCapture() no longer applies once they've navigated on their own.
    returnTab = null;
    // clicking the Analyze tab directly returns to the latest capture
    if (btn.dataset.tab === "analyze") { viewingId = null; renderAnalyze(); }
    if (btn.dataset.tab === "loader") loadGeo();
    showTab(btn.dataset.tab);
  })
);
$("#openTab").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/panel.html") })
);

function updateThemeIcon(theme) {
  const btn = $("#themeToggle");
  if (!btn) return;
  const label = btn.querySelector(".theme-label");
  if (label) label.textContent = theme === "dark" ? "Dark" : "Light";
}

function initTheme() {
  try {
    const current = localStorage.getItem("cito-theme") || "light";
    document.documentElement.setAttribute("data-theme", current);
    updateThemeIcon(current);
  } catch (_) {}
}

$("#themeToggle")?.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("cito-theme", next); } catch (_) {}
  updateThemeIcon(next);
});
initTheme();

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
        <td>${new Date(r.capturedAt).toLocaleString()}</td>
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
  const [statsRes, runsRes] = await Promise.all([
    send({ type: "stats" }),
    send({ type: "geo-run-list" }), // no profileId = every campaign's runs
  ]);

  const lines = [];
  lines.push(`${manifest.name} diagnostic report`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Extension version: ${manifest.version}`);
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
      const dur = run.finishedAt ? fmtDuration(run.finishedAt - run.startedAt) : "still running / never finished";
      lines.push(`  ${new Date(run.startedAt).toISOString()} · ${run.status} · ${(run.engines || []).join("+") || "—"} · ${run.captured || 0}/${run.expected || 0} captured${run.failed ? `, ${run.failed} failed` : ""} · took ${dur}`);
      const reasonEntries = Object.entries(run.reasons || {});
      if (reasonEntries.length) {
        lines.push(`      failure reasons — ${reasonEntries.map(([r, n]) => `${r}: ${n}`).join(", ")}`);
      }
    });
  } else if (runsRes.ok) {
    lines.push("  No campaign runs yet.");
  } else {
    lines.push(`  (couldn't load — ${runsRes.error || "unknown error"})`);
  }
  lines.push("");
  lines.push("This report contains no prompt text, answer content, URLs, or brand names — only counts, timing, and short failure-reason labels.");
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
    placeholder: "What looked wrong, and what you expected instead? (e.g. \"the brand list shows Optical Zoom instead of the phones\")",
  });
  body.append(note);

  // Unlike the About tab's diagnostic report, this bundle carries real
  // content. Say so, itemised, with a way to leave any part out.
  body.append(el("p", { className: "small", style: "margin:12px 0 6px;font-weight:600;color:var(--fg-primary);" },
    "What gets included"));
  const boxes = {};
  const list = el("div", { style: "display:flex;flex-direction:column;gap:8px;" });
  for (const part of BUNDLE_PARTS) {
    const row = el("label", { className: "small", style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer;" });
    const cb = el("input", { type: "checkbox", checked: true, style: "margin-top:2px;flex-shrink:0;" });
    if (part.key === "note") { cb.checked = true; cb.disabled = true; }
    boxes[part.key] = cb;
    row.append(cb, el("span", {},
      el("span", { style: "font-weight:600;color:var(--fg-primary);" }, part.label),
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

const reprocessBtn = $("#reprocess");
reprocessBtn?.addEventListener("click", withBusy(reprocessBtn, "Reprocessing…", async () => {
  const st = $("#setStatus"); // was "#status" — that id doesn't exist, so this never showed
  if (st) st.textContent = "Reprocessing…";
  const r = await send({ type: "reprocess-all" });
  if (st) st.textContent = r.ok ? `Reprocessed ${r.reprocessed}/${r.total} captures.` : "Reprocess failed";
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
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
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
  box.textContent = "";
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

  const state = s.paused ? "Paused" : "Running";
  const summary = el("div", { className: "loader-summary" },
    el("b", {}, state), ` — ${s.done}/${s.total} done`,
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
    const clock = finish.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const when = sameDay ? clock
      : tomorrow ? `${clock} tomorrow`
      : `${clock} on ${finish.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
    box.append(el("div", { className: "loader-finish" },
      el("span", { className: "loader-finish-icon" }, "🕒"),
      el("span", {}, "Expected to finish around "), el("b", {}, when),
      el("div", { className: "muted small" },
        "Based on how long this run's prompts have actually been taking, including the pause between them. You can close this panel — the run keeps going, and you'll get a notification when it's done.")));
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
      banner.querySelector("button").onclick = () => send({ type: "loader-resume" }).then(refresh);
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
        it.at ? el("div", { className: "muted small" }, `Paused at ${new Date(it.at).toLocaleString()}`) : "");
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
        const elapsed = l.elapsedMs != null ? `${fmtDuration(l.elapsedMs)}/${fmtDuration(l.turnTimeoutMs)}` : "";
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
    if (ps.paused) sub.unshift("⏸ paused");
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
    const when = new Date(e.at).toLocaleString();
    const cat = DIAG_CAT_LABEL[e.cat] || "Error";
    const ctx = e.context && Object.keys(e.context).length
      ? `\n    context: ${Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
    const trace = e.trace ? `\n    trace: ${e.trace}` : "";
    const stack = e.stack ? `\n    ${e.stack.slice(0, 300)}` : "";
    return `${when}\n  [${cat}] [${e.where}] ${e.message}${ctx}${trace}${stack}`;
  }).join("\n\n");
}

async function renderDiagLog() {
  const box = $("#diagLog");
  if (!box) return;
  box.textContent = "Loading…";
  const cat = $("#diagCatFilter")?.value || undefined;
  const r = await send({ type: "error-log", cat, limit: 300 });
  const entries = (r && r.ok && r.entries) || [];
  const countEl = $("#diagCount");
  if (countEl) countEl.textContent = entries.length ? `— ${entries.length} recorded` : "— nothing recorded";
  // Open itself when there is a real error to see, so a user who has hit a
  // problem doesn't have to know this disclosure exists to find it — but
  // not for every routine "turn ok" breadcrumb, which would defeat the
  // point of starting closed.
  const details = $("#diagBox");
  if (details && !cat && entries.some((e) => (e.cat || "error") === "error")) details.open = true;

  box.textContent = "";
  if (!entries.length) {
    box.append(el("div", { className: "muted small" }, "Nothing recorded yet."));
    return;
  }
  entries.forEach((e) => {
    const catKey = e.cat || "error";
    const head = `${new Date(e.at).toLocaleString()}  [${DIAG_CAT_LABEL[catKey] || "Error"}]  [${e.where}]  ${e.message}`;
    const line = el("div", { className: "dbgline" }, el("div", {}, head));
    if (e.context && Object.keys(e.context).length) {
      line.append(el("div", { className: "muted small" },
        Object.entries(e.context).map(([k, v]) => `${k}=${v}`).join("  ·  ")));
    }
    /* The turn timeline, spelled out.
     *
     * "timeout" alone says a capture never arrived; the trace says whether
     * the composer was ever found, whether the text landed, whether the send
     * control was usable, and how far the sequence got before it stopped —
     * which is the difference between a fixable report and a shrug. */
    if (e.trace) {
      line.append(el("div", { className: "err-trace" },
        el("span", { className: "muted small" }, "turn timeline: "),
        el("code", {}, e.trace)));
    }
    if (e.stack) {
      const st = el("details", { className: "err-stack" },
        el("summary", { className: "muted small" }, "stack"),
        el("pre", { className: "muted small" }, e.stack));
      line.append(st);
    }
    // Raw capture data reachable straight from the diagnostics view, not
    // only via a separate one-off button elsewhere.
    if (e.context && e.context.captureId) {
      const viewRaw = el("button", { className: "btn sm ghost", style: "margin-top:4px;" }, "View raw capture");
      viewRaw.onclick = () => downloadRaw(e.context.captureId, "diag");
      line.append(viewRaw);
    }
    box.append(line);
  });
}

$("#diagCatFilter")?.addEventListener("change", renderDiagLog);
$("#diagRefresh")?.addEventListener("click", renderDiagLog);
$("#diagClear")?.addEventListener("click", async () => {
  await send({ type: "error-log-clear" });
  renderDiagLog();
});
$("#diagCopy")?.addEventListener("click", async () => {
  const cat = $("#diagCatFilter")?.value || undefined;
  const r = await send({ type: "error-log", cat, limit: 300 });
  const text = diagLogText((r && r.ok && r.entries) || []);
  try {
    await navigator.clipboard.writeText(text);
    showToast("Diagnostics log copied.");
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
    for (const rec of r.records || []) {
      files.push({ name: `captures/${rec.captureId}.json`, text: JSON.stringify(rec, null, 2) });
      const raw = r.raw && r.raw[rec.captureId];
      if (raw) files.push({ name: `captures/${rec.captureId}-raw.txt`, text: formatRawCapture(rec.captureId, raw, raw.text) });
    }
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
    lines.push(`  Run ${run.runNo ?? "?"}  ${new Date(run.startedAt).toLocaleString()}  ${run.status}`);
    lines.push(`    expected ${run.expected}  stored ${run.stored}  missing ${run.missing}  failed ${run.failed}`);
    const reasons = Object.entries(run.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; ");
    if (reasons) lines.push(`    reasons: ${reasons}`);
  }
  lines.push("");
  lines.push(`Errors: ${(r.errors || []).length}   Turns: ${(r.turns || []).length}   Capture events: ${(r.captures || []).length}`);
  return lines.join("\n");
}

// Painted on load rather than only on demand, so the count in the summary is
// accurate the first time the About tab is opened.
renderDiagLog();
populateDiagExportProfiles();

/* ---------- Settings ---------- */
async function loadSettings() {
  const r = await send({ type: "settings-get" });
  // Guard the PAYLOAD, not just the ok flag. An {ok:true} reply that somehow
  // carries no settings object threw here, and because loadSettings() is
  // called without a catch during boot that surfaced as an unhandled
  // rejection rather than a visible failure — the class of thing that leaves
  // a user staring at a half-rendered panel with nothing in the console they
  // would think to look at.
  if (!r || !r.ok || !r.settings) return;
  const s = r.settings;
  if ($("#setDebug")) $("#setDebug").checked = !!s.debugCapture;
  if ($("#setRetention")) $("#setRetention").value = s.retentionMax;
  if ($("#setMaxMB")) $("#setMaxMB").value = s.maxCaptureMB;
}
if ($("#setSave")) {
  $("#setSave").addEventListener("click", async () => {
    const patch = {
      debugCapture: $("#setDebug").checked,
      retentionMax: Math.max(50, parseInt($("#setRetention").value, 10) || 2000),
      maxCaptureMB: Math.max(1, parseInt($("#setMaxMB").value, 10) || 8),
    };
    const r = await send({ type: "settings-set", patch });
    $("#setStatus").textContent = r.ok ? "Saved." : "Failed to save.";
  });
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
  const fmt = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const engineName = (id) => ENGINES.find((e) => e.id === id)?.label || id;

  // --- header: the prompt + its timeline ---
  const head = el("div", { className: "card" });
  head.append(el("div", { className: "card-header" }, el("h3", {}, timeline.label)));
  if (caps.length === 1) {
    head.append(el("div", { className: "muted" },
      "Only one capture so far — run this prompt again later and this page will show what moved."));
  }
  const tl = el("div", { className: "chips", style: "margin-top:6px" });
  caps.forEach((r, i) => {
    // engineIconEl() returns a DOM node, so the label is assembled from
    // parts rather than one template string (the old ENGINE_ICONS emoji map
    // interpolated as text; it no longer exists — see the note near
    // engineIconEl).
    tl.append(el("span", { className: "chip" },
      `${i + 1}. ${fmt(r.capturedAt)} · `,
      engineIconEl(r.platform),
      ` ${engineName(r.platform)}${r.model ? " · " + r.model : ""}`));
  });
  head.append(tl);
  out.append(head);

  // --- run-by-run detail: the shape of each individual answer ---
  // Previously Compare jumped straight from "here are the captures" to a
  // first-vs-last diff, so the runs in between were invisible unless an item
  // happened to appear in one of the matrices. This is each run's own
  // profile: how much searching it did, how much of what it read it actually
  // cited, and how long the answer was.
  const runCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "Run by run")));
  const runTable = el("table", { className: "drill-table cmp-run-table" });
  runTable.append(el("tr", {},
    el("th", { className: "src-col-idx" }, "#"),
    el("th", {}, "When"),
    el("th", {}, "Engine"),
    el("th", { className: "num", title: "Sub-queries the engine ran before answering" }, "Fan-out"),
    el("th", { className: "num", title: "Distinct domains that appeared as a source" }, "Domains"),
    el("th", { className: "num", title: "Sources actually cited in the answer" }, "Cited"),
    el("th", { className: "num", title: "Sources read but not cited" }, "Read-only"),
    el("th", { className: "num", title: "Share of the sources it read that it went on to cite" }, "Cite rate"),
    el("th", { className: "num", title: "Distinct brands named or shown" }, "Brands"),
    el("th", { className: "num", title: "Length of the written answer, in characters" }, "Answer")));
  points.forEach((p, i) => {
    const read = p.cited + p.fetched;
    const row = el("tr", {},
      el("td", { className: "src-col-idx muted" }, String(i + 1)),
      el("td", { className: "muted small", title: new Date(p.rec.capturedAt).toLocaleString() }, fmt(p.rec.capturedAt)),
      el("td", {}, engineChip(p.rec.platform, engineName(p.rec.platform))),
      el("td", { className: "num" }, String(p.queries.size)),
      el("td", { className: "num" }, String(p.domains.size)),
      el("td", { className: "num" }, String(p.cited)),
      el("td", { className: "num muted" }, String(p.fetched)),
      el("td", { className: "num" }, read ? `${Math.round((p.cited / read) * 100)}%` : "—"),
      el("td", { className: "num" }, String(p.brands.size)),
      el("td", { className: "num muted" }, p.answerChars ? `${(p.answerChars / 1000).toFixed(1)}k` : "—"));
    runTable.append(row);
  });
  runCard.append(el("div", { className: "drill-scroll" }, runTable));
  out.append(runCard);

  // --- per-engine split, when the timeline spans more than one engine ---
  // Merging ChatGPT and Gemini into a single series makes movement unreadable:
  // a "lost domain" is usually just the other engine's turn in the sequence.
  const byEngine = new Map();
  points.forEach((p) => {
    const list = byEngine.get(p.rec.platform) || [];
    list.push(p);
    byEngine.set(p.rec.platform, list);
  });
  if (byEngine.size > 1) {
    const engCard = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "By engine")));
    engCard.append(el("div", { className: "muted small", style: "margin-bottom:8px" },
      "The same prompt behaves differently on each engine, so the totals above are split out here rather than averaged together."));
    const grid = el("div", { className: "geo-kpis" });
    [...byEngine.entries()].forEach(([id, ps]) => {
      const doms = new Set();
      let cited = 0, fetched = 0, fan = 0;
      ps.forEach((p) => { p.domains.forEach((_, d) => doms.add(d)); cited += p.cited; fetched += p.fetched; fan += p.queries.size; });
      const box = el("div", { className: "geo-kpi" });
      box.append(el("div", { className: "k-label" }, engineChip(id, engineName(id))));
      box.append(el("div", { className: "k-value" }, String(ps.length)));
      box.append(el("div", { className: "k-sub muted" }, `run${ps.length === 1 ? "" : "s"} · ${doms.size} domains · ${cited} cited · ${fetched} fetched · ${fan} fan-out`));
      grid.append(box);
    });
    engCard.append(grid);
    out.append(engCard);
  }

  // --- Cross-LLM Search Fan-Out Intent Graph (2026 Innovation) ---
  const intentBuckets = computeSearchIntentGraph(caps);
  const activeIntents = Object.entries(intentBuckets).filter(([, b]) => b.count > 0);
  if (activeIntents.length > 0) {
    const intentCard = el("div", { className: "card", id: "card-cmp-intent-graph" },
      el("div", { className: "card-header" },
        el("h3", { "data-term": "fanoutIntent" }, "Cross-LLM Search Fan-Out Intent Graph"),
        el("span", { className: "tag cited" }, `${activeIntents.length} Intent Angles Detected`)
      ),
      el("div", { className: "muted small", style: "margin-bottom:10px" },
        "Visual breakdown of how different AI engines decompose this prompt into distinct commercial and technical search intents.")
    );

    const intentGrid = el("div", {
      style: "display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px;",
    });

    activeIntents.forEach(([key, b]) => {
      const bCard = el("div", {
        style: "background:var(--bg-subtle, rgba(255,255,255,0.03)); border:1px solid var(--border); border-radius:8px; padding:10px;",
      },
        el("div", { style: "display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;" },
          el("strong", { style: "font-size:12px;" }, b.label),
          el("span", { className: "tag", style: "font-size:10.5px;" }, `${b.count} queries`)
        )
      );
      const qList = el("ul", { style: "list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:4px;" });
      b.queries.slice(0, 4).forEach((q) => {
        const item = el("li", {
          style: "display:flex; align-items:center; gap:6px; font-size:11px; line-height:1.35; background:rgba(0,0,0,0.1); padding:4px 6px; border-radius:4px;",
        },
          engineIconEl(q.engine),
          el("span", { style: "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" }, q.query)
        );
        qList.append(item);
      });
      bCard.append(qList);
      intentGrid.append(bCard);
    });
    intentCard.append(intentGrid);
    out.append(intentCard);
  }

  // --- Cross-Engine Domain Exclusivity Heatmap ---
  if (byEngine.size > 1) {
    const exclData = computeDomainExclusivity(caps);
    if (exclData.exclusiveDomains.length > 0) {
      const exclCard = el("div", { className: "card", id: "card-cmp-domain-exclusivity" },
        el("div", { className: "card-header" },
          el("h3", { "data-term": "domainExclusivity" }, "Cross-Engine Domain Exclusivity"),
          el("span", { className: "tag" }, `${exclData.exclusiveDomains.length} Engine-Exclusive Domains`)
        ),
        el("div", { className: "muted small", style: "margin-bottom:10px" },
          "Domains that are cited exclusively by one model and ignored by others for this prompt.")
      );

      const exclTable = el("table", { className: "drill-table" });
      exclTable.append(el("tr", {},
        el("th", {}, "Domain"),
        el("th", {}, "Exclusive Engine"),
        el("th", { className: "num" }, "Status")
      ));

      exclData.exclusiveDomains.slice(0, 10).forEach((ed) => {
        exclTable.append(el("tr", {},
          el("td", { style: "font-weight:600;" }, ed.domain),
          el("td", {}, engineChip(ed.exclusiveEngine, engineName(ed.exclusiveEngine))),
          el("td", { className: "num" }, el("span", { className: "tag cited", style: "font-size:10px;" }, "Exclusive"))
        ));
      });
      exclCard.append(el("div", { className: "drill-scroll" }, exclTable));
      out.append(exclCard);
    }
  }

  if (caps.length < 2) return;

  const first = points[0];
  const last = points[points.length - 1];

  // --- headline movement between first and last capture ---
  const sum = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, "What changed (first → latest)")));
  if (first.rec.platform !== last.rec.platform) {
    // Stated rather than silently diffed: comparing a ChatGPT run against a
    // Gemini run measures the difference between two engines, not movement
    // over time, and the numbers below would be read as the latter.
    sum.append(el("div", { className: "cmp-warn" },
      `Heads up — the first run was on ${engineName(first.rec.platform)} and the latest on ${engineName(last.rec.platform)}. ` +
      "Most of the movement below is probably the difference between the two engines. Filter to one model above for a clean comparison."));
  }
  const sgrid = el("div", { className: "statgrid" });
  const stat = (n, l) => el("div", { className: "stat" }, el("div", { className: "n" }, String(n)), el("div", { className: "l" }, l));
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
  // Jaccard on the domain sets: 100% means the engine reached for exactly the
  // same publishers both times, 0% means a completely different source list.
  const union = new Set([...domsFirst, ...domsLast]).size;
  const overlap = [...domsLast].filter((d) => domsFirst.has(d)).length;
  sgrid.append(
    stat(caps.length, "Captures"),
    stat(union ? `${Math.round((overlap / union) * 100)}%` : "—", "Source overlap"),
    stat(gainedBrand.length, "Brands gained"),
    stat(lostBrand.length, "Brands lost"),
    stat(gainedDom.length, "Domains gained"),
    stat(lostDom.length, "Domains lost"),
    stat(gainedUrl.length, "URLs gained"),
    stat(lostUrl.length, "URLs lost"),
    stat(domsLast.size, "Domains now"),
    stat(last.cited, "Cited now"),
    stat(last.queries.size, "Fan-out now"),
    stat(last.answerChars ? `${(last.answerChars / 1000).toFixed(1)}k` : "—", "Answer length"),
  );
  sum.append(sgrid);
  out.append(sum);

  // --- matrix helper: rows = item, columns = each capture in time order ---
  function matrixCard(title, subtitle, rows, opts = {}) {
    if (!rows.length) return null;
    const card = el("div", { className: "card" }, el("div", { className: "card-header" }, el("h3", {}, title)));
    if (subtitle) card.append(el("div", { className: "muted small", style: "margin-bottom:8px" }, subtitle));
    const t = el("table", { className: "drill-table cmp-matrix" });
    const hr = el("tr", {}, el("th", {}, opts.nameHeader || "Name"));
    caps.forEach((r, i) => hr.append(el("th", {
      className: "num cmp-col",
      title: `${fmt(r.capturedAt)} · ${engineName(r.platform)}`,
    }, engineIconEl(r.platform), String(i + 1))));
    hr.append(el("th", { className: "num", title: "How many of the runs this appeared in" }, "Seen"));
    hr.append(el("th", { className: "num" }, "Trend"));
    t.append(hr);
    rows.forEach((row) => {
      const tr = el("tr", {});
      tr.append(el("td", { title: row.name }, row.name));
      row.values.forEach((v) => {
        tr.append(el("td", { className: `num${v.n ? "" : " cmp-absent"}` }, v.label));
      });
      tr.append(el("td", { className: "num" }, stabilityTag(row.values.filter((v) => v.n > 0 || v.label !== "—").length, caps.length)));
      tr.append(el("td", { className: "num" }, deltaTag(row.delta)));
      t.append(tr);
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

  out.append(el("div", { className: "card" },
    el("div", { className: "muted small" },
      "Not shown here: your brand's rank position per run. Ranking needs the full answer text, which the fast list view doesn't load — " +
      "the Dashboard's Campaign Performance computes it properly for tracked campaigns instead of estimating it here.")));

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

/* The metric reference in About, generated from the same glossary the hover
   definitions come from — a reference that can drift from the tooltips is
   worse than none. Rendered once; the table is static. */
(function renderGlossary() {
  const host = $("#glossaryList");
  if (!host) return;
  // Grouped, because two different things are legitimately both called
  // "Citations" — a brand's own site being cited, and a source being cited.
  // A flat list showed the same word twice with no way to tell them apart.
  glossaryGroups().forEach(({ group, terms }) => {
    host.append(el("div", { className: "glossary-group-title muted small" }, group));
    const grid = el("div", { className: "glossary-list" });
    terms.forEach((g) => {
      const item = el("div", { className: "glossary-item" });
      item.append(el("div", { className: "glossary-term" }, g.term));
      item.append(el("div", { className: "glossary-what" }, g.what));
      if (g.formula) item.append(el("div", { className: "glossary-formula" }, g.formula));
      if (g.note) item.append(el("div", { className: "glossary-note muted small" }, g.note));
      grid.append(item);
    });
    host.append(grid);
  });
})();
// .catch() is the whole point here: load() is fired-and-forgotten (nothing
// awaits it), so ANY exception anywhere in its chain — not just the
// send()-throws case handled inside load() itself — becomes a silent
// unhandled promise rejection with the popup left exactly as the static
// HTML shell renders it: header and tabs present, every panel completely
// empty. That reads as "the tool is broken" with zero information to act
// on. This is the last-resort net for whatever isn't already handled
// upstream, so at least the failure is visible and includes the real error.
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
 *   - THE TOUR: a short walkthrough of what each tab answers. Steps that
 *     point at a tab actually switch to it, so the user sees the real screen
 *     rather than a description of it.
 *
 * Shown once. The flag lives in localStorage rather than extension storage
 * because it is per-view chrome, not user data, and losing it costs one
 * dismissible dialog rather than anything real. Re-runnable from About.
 * ========================================================================== */
const TOUR_SEEN_KEY = "cito-tour-seen";

const TOUR_STEPS = [
  {
    tab: null,
    title: "Welcome to CitoSkeleton",
    body: "This tracks how AI answer engines talk about brands — which ones they name, which sources they cite, and what they searched to get there. Everything stays on your machine.",
  },
  {
    tab: "analyze",
    title: "Analyze — one answer, in full",
    body: "The full captured answer, plus the brands it named and the sources behind them. 'Sources cited' vs 'retrieved' is the key number: a source the engine read but never quoted is a very different signal from one it built its answer on.",
  },
  {
    tab: "dashboard",
    title: "Dashboard — everything you've captured",
    body: "Every saved conversation, with share of voice across brands and the domains that keep getting cited. This is where patterns show up that a single answer can't tell you.",
  },
  {
    tab: "loader",
    title: "Campaigns — run prompts on a schedule",
    body: "Give it a list of prompts and the engines to run them on, and it drives your own logged-in sessions at a human pace. It now checks you're signed in before opening anything, so a run can't quietly fail into a login page.",
  },
  {
    tab: "compare",
    title: "Compare — engines side by side",
    body: "The same prompt across ChatGPT, Gemini, Perplexity and Grok. Each engine retrieves and cites differently, and that difference is usually the actionable part.",
  },
  {
    tab: "about",
    title: "You're set",
    body: "Sample data is loaded so these screens have something to show. Remove it whenever you like from this tab — your real captures aren't touched. You can replay this tour from here too.",
  },
];

function runTour(startAt = 0) {
  document.getElementById("tour-backdrop")?.remove();
  let i = startAt;

  const backdrop = el("div", { id: "tour-backdrop", className: "modal-backdrop tour-backdrop" });
  const card = el("div", { className: "modal-content tour-card", tabindex: "-1" });
  backdrop.append(card);
  document.body.append(backdrop);

  const finish = () => {
    try { localStorage.setItem(TOUR_SEEN_KEY, "1"); } catch (_) {}
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
  };
  document.addEventListener("keydown", onKey, true);

  function go(next) {
    if (next < 0) return;
    if (next >= TOUR_STEPS.length) return finish();
    i = next;
    const step = TOUR_STEPS[i];
    // Switch to the tab the step is about, so the user is looking at the real
    // screen while reading about it rather than at a description of one.
    if (step.tab) { try { showTab(step.tab); } catch (_) {} }
    render();
  }

  function render() {
    const step = TOUR_STEPS[i];
    card.textContent = "";

    const dots = el("div", { className: "tour-dots" });
    TOUR_STEPS.forEach((_, n) => dots.append(el("span", { className: "tour-dot" + (n === i ? " is-on" : "") })));

    const header = el("div", { className: "modal-header" },
      el("h3", { className: "modal-title" }, step.title),
      el("button", { className: "modal-close-btn", title: "Skip tour" }, "×"));
    header.querySelector(".modal-close-btn").onclick = finish;

    const body = el("div", { className: "modal-body" },
      el("p", {}, step.body),
      el("p", { className: "muted small" }, `Step ${i + 1} of ${TOUR_STEPS.length}`));

    const footer = el("div", { className: "modal-footer tour-footer" });
    footer.append(dots);
    const spacer = el("span", { style: "flex:1" });
    footer.append(spacer);
    if (i > 0) {
      const back = el("button", { className: "btn ghost" }, "Back");
      back.onclick = () => go(i - 1);
      footer.append(back);
    }
    const next = el("button", { className: "btn primary" }, i === TOUR_STEPS.length - 1 ? "Done" : "Next");
    next.onclick = () => go(i + 1);
    footer.append(next);

    card.append(header, body, footer);
    next.focus();
  }

  render();
}

// First run: load the sample capture, then walk through what the screens mean.
// Sample data is loaded FIRST so the tabs the tour switches to have something
// on them — a tour of five empty screens explains nothing.
async function maybeFirstRun() {
  let seen = false;
  try { seen = localStorage.getItem(TOUR_SEEN_KEY) === "1"; } catch (_) { seen = true; }
  if (seen) return;
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
  runTour(0);
}

/* About-tab controls for the sample data and the tour. */
async function refreshDemoControls() {
  const btn = $("#demoToggle");
  const status = $("#demoStatus");
  if (!btn) return;
  let st = null;
  try { st = await send({ type: "demo-status" }); } catch (_) {}
  const present = !!(st && st.ok && st.present);
  btn.textContent = present ? "Remove sample" : "Load sample";
  if (status) {
    status.textContent = present
      ? `Sample data is loaded. You have ${st.real} real capture${st.real === 1 ? "" : "s"}.`
      : "";
  }
}

$("#demoToggle")?.addEventListener("click", withBusy($("#demoToggle"), "Working…", async () => {
  let st = null;
  try { st = await send({ type: "demo-status" }); } catch (_) {}
  const present = !!(st && st.ok && st.present);
  await send({ type: present ? "demo-clear" : "demo-load" });
  FULL.clear();
  await load();
  await refreshDemoControls();
}));

$("#replayTour")?.addEventListener("click", () => runTour(0));

refreshDemoControls();
