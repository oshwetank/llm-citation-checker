/**
 * aboutView.js — what the About tab shows, worked out without the DOM
 * (release 5 of the canvas redesign, 0.51.0).
 *
 * About became five pages — Overview, Metric glossary, Settings, Data & tools,
 * Diagnostics — with a side menu in the full tab and a home screen with a
 * "Get started" checklist in the popup. The parts with rules in them (which
 * glossary terms a search finds, when the checklist is done, when settings
 * have unsaved changes, how full storage is, what the activity log counts)
 * live here so test/about-view.test.mjs can pin them.
 */

/** The four tabs, one job each — the Overview's "How it works". */
export const ABOUT_STEPS = [
  { n: 1, title: "Ask as usual", text: "Type a prompt in an open ChatGPT, Gemini, Perplexity or Grok tab. CitoSkeleton reads the answer your browser already received. It never sends a request of its own.", where: "Any engine tab", tab: null },
  { n: 2, title: "Read one answer", text: "The searches the engine ran, the sources it cited and the ones it only read, plus products, places and brand mentions. Several engines on the same prompt can be compared side by side.", where: "Analyze", tab: "analyze" },
  { n: 3, title: "Find it again", text: "Every prompt you've asked, on every engine, grouped by day. Search your prompts, the answers and what the engines searched for.", where: "Dashboard", tab: "dashboard" },
  { n: 4, title: "Track a brand", text: "Run a fixed set of prompts and get visibility, Share of Voice, average position and every competitor, measured the same way every run.", where: "Campaigns", tab: "loader" },
];

/** What's new — the redesign, newest first. */
export const ABOUT_NEWS = [
  { head: "Share a campaign.", body: "Campaigns → ⋯ → Share campaign… saves it as one file someone else opens with Import… and runs on their own computer, with the same answers and numbers." },
  { head: "About, rebuilt.", body: "An overview, a searchable glossary of every metric, settings you can undo, data & tools, and diagnostics, each on its own page." },
  { head: "A campaign's results are one board.", body: "Pick a run, an engine, tags and a brand; see it by kind of answer, product cards, every competitor, each engine, each run and every prompt." },
  { head: "A page for each competitor.", body: "Head to head against your brand, engine by engine and prompt by prompt, with the sites that cite one and not the other." },
  { head: "The Dashboard is your prompt history.", body: "One row per prompt, grouped by day, searchable in your prompts, the answers and the engines' own searches." },
  { head: "Analyze shows the answer as the engine did.", body: "The answer sits beside the analysis, with brands marked and citations named, and engines on the same prompt compared." },
];

/* ---------- Metric glossary ---------- */

/** Group names as the glossary stores them, in reading order. */
export const GLOSSARY_GROUPS = ["Brand metrics", "Source metrics", "Grounding & Veracity", "Engine Intelligence", "Comparing brands", "What was captured"];

/**
 * The glossary filtered by a search and a group.
 *
 * Every word typed must appear somewhere in the term's name, its one-line
 * definition or its formula — so "cited rate" finds Cited % through its
 * definition, and a word that appears nowhere empties the list rather than
 * being ignored.
 *
 * @param {Array<{key,group,term,what,formula,note}>} entries glossaryEntries()
 * @param {{query?: string, group?: string}} opts group "all" or a group name
 * @returns {{ total, matches, chips: [{id,label,count,on}], groups: [{name, rows}] }}
 */
export function glossaryView(entries, { query = "", group = "all" } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const inGroup = (e) => group === "all" || e.group === group;
  const hit = (e) => {
    const hay = `${e.term} ${e.what} ${e.formula || ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const matches = entries.filter((e) => inGroup(e) && hit(e));
  const order = [...GLOSSARY_GROUPS, ...new Set(entries.map((e) => e.group).filter((g) => !GLOSSARY_GROUPS.includes(g)))];
  const chips = [{ id: "all", label: "All", count: entries.length }]
    .concat(order.filter((g) => entries.some((e) => e.group === g)).map((g) => ({ id: g, label: g, count: entries.filter((e) => e.group === g).length })))
    .map((c) => ({ ...c, on: c.id === group }));
  const groups = order.map((name) => ({ name, rows: matches.filter((e) => e.group === name) })).filter((g) => g.rows.length);
  return { total: entries.length, matches, chips, groups };
}

/** The term to show beside the list: the one picked if it's still listed, else the first. */
export function pickedTerm(view, key) {
  return view.matches.find((e) => e.key === key) || view.matches[0] || null;
}

/* ---------- The popup's "Get started" ---------- */

/**
 * Three steps, each done by doing it, not by ticking it off: a real capture
 * (sample data doesn't count), a real answer opened in Analyze, a campaign.
 */
export function startProgress({ realCaptures = 0, analyzed = false, campaigns = 0 } = {}) {
  const steps = [
    { id: "ask", title: "Ask an AI engine anything", text: "CitoSkeleton reads the answer as it arrives in that tab.", done: realCaptures > 0 },
    { id: "analyze", title: "See what it read", text: "The searches it ran, sources it cited, and ones it only read.", done: realCaptures > 0 && !!analyzed },
    { id: "campaign", title: "Track your brand", text: "Run a set of prompts and measure Share of Voice over time.", done: campaigns > 0 },
  ];
  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    allDone: done === steps.length,
    title: done === 0 ? "Welcome to CitoSkeleton" : "CitoSkeleton",
    text: `${done} of ${steps.length} done`,
  };
}

/* ---------- Settings ---------- */

export const SETTING_LIMITS = { retentionMax: { min: 50, step: 50 }, maxCaptureMB: { min: 1, step: 1 } };

/** A typed value clamped to its minimum; anything unreadable falls back to it. */
export function settingValue(key, raw) {
  const lim = SETTING_LIMITS[key];
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(lim.min, n) : lim.min;
}

/**
 * Whether the form differs from what is stored, and what the footer says.
 * justSaved only shows "Settings saved" until the next edit.
 */
export function settingsState(saved, draft, { justSaved = false } = {}) {
  const keys = ["retentionMax", "maxCaptureMB", "debugCapture", "readCitedPages", "keepHandoffCaptures"];
  const changed = !!saved && !!draft && keys.some((k) => saved[k] !== draft[k]);
  return {
    dirty: changed,
    status: changed ? "Unsaved changes" : justSaved ? "Settings saved" : "All settings saved",
    tone: changed ? "warn" : "ok",
  };
}

/**
 * How full the store is against the "captures to keep" limit. Warns from 90%,
 * the point past which the next run starts dropping the oldest captures.
 */
export function storageMeter({ stored = 0, keep = 0, usedBytes = null } = {}) {
  const pct = keep > 0 ? Math.min(100, Math.round((stored / keep) * 100)) : 0;
  const mb = usedBytes == null ? null : (usedBytes / 1024 / 1024).toFixed(1);
  return {
    pct,
    warn: keep > 0 && stored / keep >= 0.9,
    text: `${stored.toLocaleString(undefined)} of ${keep.toLocaleString(undefined)} kept`,
    sub: `${mb == null ? "" : `${mb} MB on disk. `}Past the limit, the oldest captures are dropped first.`,
  };
}

/* ---------- Diagnostics ---------- */

const LOG_CATS = [["all", "All"], ["error", "Errors"], ["turn", "Turns"], ["capture", "Captures"]];

/** The activity log's filter chips with counts, and the rows the filter keeps. */
export function logView(entries, filter = "all") {
  const cat = (e) => e.cat || "error";
  const chips = LOG_CATS.map(([id, label]) => ({ id, label, on: id === filter, count: id === "all" ? entries.length : entries.filter((e) => cat(e) === id).length }));
  return { chips, rows: entries.filter((e) => filter === "all" || cat(e) === filter), errors: entries.filter((e) => cat(e) === "error").length };
}

/**
 * Whether the screens and the background that runs campaigns are the same
 * build — the same rule as the out-of-date banner (see checkBuildMatch in
 * panel.js and src/lib/build.js).
 */
export function buildStatus(reply, build) {
  if (!reply) return { known: false, stale: false, title: "Checking…", sub: "" };
  const stale = (reply.ok && reply.build !== build) || reply.error === "unknown message type";
  if (stale) {
    const running = reply.ok ? reply.build : null;
    return { known: true, stale: true, running, title: "Needs a reload", sub: "See Diagnostics",
      line: `These screens are version ${build}, but the part that runs campaigns is still ${running ? `version ${running}` : "an older version"}. Campaign runs use the old code until this is fixed.` };
  }
  if (!reply.ok) return { known: false, stale: false, title: "Couldn't check", sub: "The background didn't answer" };
  return { known: true, stale: false, title: "Up to date", sub: `Version ${build}`,
    line: `Up to date. These screens and the part that runs campaigns are both version ${build}.` };
}

/**
 * What works in this browser (0.72.0, About → Overview → "This browser").
 * @param {{offscreen?: boolean, tabGroups?: boolean, notifications?: boolean, nano?: boolean, webgpu?: boolean, incognito?: boolean, ua?: string}} env
 */
export function browserSupport(env = {}) {
  const ua = String(env.ua || "");
  const name = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? "Safari" : /Chrome\//.test(ua) ? "Chrome" : "This browser";
  const rows = [
    { id: "capture", label: "Capturing ChatGPT, Gemini, Perplexity and Grok", on: true },
    { id: "pages", label: "Reading the cited pages", on: true, note: env.offscreen ? "" : "in the background page" },
    { id: "ai", label: "Built-in AI", on: true, note: env.webgpu ? "on the graphics chip" : "on the processor (Light size suggested)" },
    { id: "nano", label: "Gemini Nano", on: !!env.nano, note: env.nano ? "" : "Chrome only" },
    { id: "groups", label: "Campaign tabs grouped", on: !!env.tabGroups, note: env.tabGroups ? "" : "not in this browser" },
    { id: "notify", label: "A notification when a run ends", on: !!env.notifications, note: env.notifications ? "" : "shown in the panel instead" },
    { id: "private", label: "Runs signed out, in a private window", on: env.incognito !== false, note: env.incognito === false ? "not in this browser" : "" },
  ];
  return { name, rows, all: rows.every((r) => r.on) };
}
