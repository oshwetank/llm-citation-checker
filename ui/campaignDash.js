/*
 * campaignDash.js — the campaign dashboard (1.0.6) in the full tab.
 *
 * The background gives the campaign's answers once, as small rows
 * ("campaign-dash", src/lib/campaignDash.js dashRecords); every filter, tab,
 * sort and page after that is worked out here by dashModel() and drawn from
 * ui/campaignDashTemplate.js, so nothing waits on a round trip. Answer search
 * is the one exception: it reads the answer text, which only the background
 * holds ("campaign-dash-search").
 *
 * panel.js owns the page around it (the campaign header with Run, Export and
 * Edit setup, and the switch back to the classic board).
 */
import { DASH_TEMPLATE } from "./campaignDashTemplate.js";
import { renderTemplate } from "./dcRender.js";
import { dashModel, DASH_DEFAULTS } from "../src/lib/campaignDash.js";

let D = null;          // { send, openCapture, toast }
let host = null;       // the element the dashboard lives in
let profileId = null;
let data = null;       // dashRecords() for profileId
let S = DASH_DEFAULTS();
let searching = null;  // the query being searched
let keysOn = false;
const FOCUSABLE = "button, input, [tabindex]";

/** Forget the page state (another campaign was opened). */
export function resetCampaignDash() { S = DASH_DEFAULTS(); data = null; profileId = null; searching = null; }

/**
 * Draw the dashboard for one campaign into `box`.
 * @param {HTMLElement} box
 * @param {object} profile
 * @param {object} deps  { send, openCapture, toast }
 * @returns {Promise<{ ok: boolean, runs?: object[], engines?: string[], answers?: number }>} what panel.js needs for Export
 */
export async function renderCampaignDash(box, profile, deps) {
  D = deps;
  if (profileId !== profile.id) { resetCampaignDash(); profileId = profile.id; }
  host = box;
  host.classList.add("cdash-host");
  host.textContent = "";
  host.append(Object.assign(document.createElement("div"), { className: "card", textContent: "Loading the dashboard…" }));
  const r = await D.send({ type: "campaign-dash", profileId: profile.id });
  if (host !== box) return { ok: false };
  if (!r || !r.ok) {
    host.textContent = "";
    host.append(Object.assign(document.createElement("div"), { className: "card empty", textContent: (r && r.error) || "Couldn't load this campaign's results." }));
    return { ok: false };
  }
  data = r.data;
  if (!keysOn) {
    keysOn = true;
    // Escape closes the open menu, then the answers drawer. On the document:
    // each redraw replaces the button that had focus, so the host may not.
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !host || !host.isConnected) return;
      if (S.open) set({ open: null }); else if (S.drawer != null) set({ drawer: null });
    });
  }
  draw();
  return { ok: true, runs: data.runs, engines: data.engines, answers: data.recs.length };
}

function set(patch) {
  S = Object.assign({}, S, patch);
  draw();
}

function draw() {
  if (!host || !data) return;
  if (!data.recs.length) {
    host.textContent = "";
    host.append(Object.assign(document.createElement("div"), { className: "card empty", textContent: "No answers yet. Run the campaign, and its results show here once the run finishes." }));
    return;
  }
  // Keyboard place: the same control gets focus back after the redraw.
  const active = document.activeElement && host.contains(document.activeElement) ? document.activeElement : null;
  const focusAt = active ? [...host.querySelectorAll(FOCUSABLE)].indexOf(active) : -1;
  let vals;
  try {
    vals = dashModel(data, S, { set, toast: (m) => D.toast(m, "info"), openCapture: (id) => D.openCapture(id) });
  } catch (e) {
    // A page that can't be worked out goes back to the overview rather than leaving the tab blank.
    console.error("campaign dashboard:", e);
    if (S.page !== "overview") { S = Object.assign({}, S, { page: "overview", drawer: null, open: null }); return draw(); }
    host.textContent = "";
    host.append(Object.assign(document.createElement("div"), { className: "card empty", textContent: "This campaign's results couldn't be drawn. Switch to the classic board, or send a problem report." }));
    return;
  }
  const frag = renderTemplate(DASH_TEMPLATE, vals);
  host.replaceChildren(frag);
  if (focusAt >= 0) { const el = host.querySelectorAll(FOCUSABLE)[focusAt]; if (el) el.focus({ preventScroll: true }); }
  // Answer search reads the answer text, which only the background has.
  const q = String(S.q || "").trim();
  if (S.page === "search" && q && (!data.search || data.search.q !== q) && searching !== q) {
    searching = q;
    D.send({ type: "campaign-dash-search", profileId, q }).then((res) => {
      if (searching !== q || !data) return;
      searching = null;
      data.search = { q, hits: (res && res.ok && res.hits) || [] };
      draw();
    });
  }
}
