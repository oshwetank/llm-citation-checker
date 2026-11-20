/*
 * onboarding.js — helping someone who has never seen this version use it
 * (1.0.0).
 *
 * The store's version was 0.36: five tabs, English only, no guide. 1.0 is a
 * different tool, and the owner asked for help "to better understand and use
 * the tool properly". Four pieces live here, as plain functions so they are
 * unit tested (test/getting-started.test.mjs); panel.js and campaignView.js draw
 * them.
 *
 *   checklist()       Get started: five steps from a first answer to reading
 *                     a campaign's results, each ticked off by what the person
 *                     has actually done, not by clicking "done".
 *   margin(), sureness()  How far a campaign's percentage could move by chance,
 *                     from how many answers it rests on. AI answers vary run to
 *                     run (docs/platform/01-RESEARCH.md §5), so 40% from 12
 *                     answers is a hint, not a measurement.
 *   campaignAdvice()  What to do next, from the campaign's own numbers: at
 *                     most three plain sentences, each pointing at the section
 *                     that shows why.
 *   examplePrompts()  Prompts to start a campaign from, built from what the
 *                     person sells, their brand and a competitor.
 *
 * Every sentence is an English template with {slots}; the page fills it with
 * ui/i18n.js fmt(), so each is translated like the rest of the interface.
 */

/* ---------- Get started ---------- */

export const CHECKLIST_STEPS = [
  { id: "capture", label: "Ask an AI something", hint: "Open ChatGPT, Gemini, Perplexity or Grok in a tab and ask what your customers would ask. CitoSkeleton reads the answer as it arrives.", go: "engine" },
  { id: "analyze", label: "Read the answer in Analyze", hint: "See which brands it named, in what order, and which sites it cited or only read.", go: "analyze" },
  { id: "campaign", label: "Create a campaign", hint: "Your brand, a few competitors, the engines, and the questions that matter to you.", go: "loader" },
  { id: "run", label: "Run it", hint: "CitoSkeleton asks every question on every engine, at a human pace, in your own browser.", go: "loader" },
  { id: "results", label: "Read the results", hint: "Share of voice, visibility, the sites engines trust, and what changed since the last run.", go: "loader" },
];

/**
 * @param {{captured:boolean, analyzed:boolean, campaigns:number, ran:boolean, sawResults:boolean}} s
 * @returns {{steps:Array, done:number, total:number, next:object|null, complete:boolean}}
 */
export function checklist(s = {}) {
  const doneBy = {
    capture: !!s.captured,
    analyze: !!s.analyzed,
    campaign: (s.campaigns || 0) > 0,
    run: !!s.ran,
    results: !!s.sawResults,
  };
  const steps = CHECKLIST_STEPS.map((x) => ({ ...x, done: doneBy[x.id] }));
  const done = steps.filter((x) => x.done).length;
  return { steps, done, total: steps.length, next: steps.find((x) => !x.done) || null, complete: done === steps.length };
}

/* ---------- How sure a number is ---------- */

/**
 * The 95% margin, in percentage points, of a share measured over n answers
 * (normal approximation; p in percent). 30% over 1,000 answers is about
 * ±2.8 points, over 12 answers about ±26.
 */
export function margin(pct, n) {
  if (!(n > 0) || pct == null || !Number.isFinite(Number(pct))) return null;
  const p = Math.min(1, Math.max(0, Number(pct) / 100));
  // A share of 0% or 100% still isn't certain on few answers: use the
  // "rule of three" floor so 0 of 5 doesn't read as ±0.
  const sd = Math.sqrt(Math.max(p * (1 - p), 0.75 / n) / n);
  return Math.round(196 * sd * 10) / 10;
}

/** "few" under 30 answers, "some" under 100, else "good". */
export function sureness(n) {
  if (!(n >= 30)) return "few";
  if (n < 100) return "some";
  return "good";
}

/* ---------- What to do next ---------- */

export const ADVICE = {
  rival: "{rival} is named in more answers than {brand} ({theirs}% against {ours}%). Compare shows the prompts where it wins.",
  noOwnSite: "No answer cited {brand}'s own site. Sources lists the sites the engines do trust: being on those is the way in.",
  gaps: "In {n} answers {brand} is missing while two or more rivals are named. Start there: Signals lists them.",
  gapsOne: "In {n} answer {brand} is missing while two or more rivals are named. Start there: Signals lists it.",
  leading: "{brand} is ahead on visibility. Run vs run shows whether that holds from one run to the next.",
};

/**
 * @param {{brand:string, answered:number, ownVis:number|null, rival:{name:string, vis:number}|null,
 *          ownSiteCitations:number|null, gaps:number|null}} c
 * @returns {Array<{id:string, template:string, one?:string, vars:object, go:string|null}>} at most three, most useful first
 */
export function campaignAdvice(c = {}) {
  const out = [];
  const brand = c.brand || "";
  const n = c.answered || 0;
  // How sure the numbers are is said beside them (campaignView.js), not here.
  if (c.rival && c.ownVis != null && c.rival.vis > c.ownVis) out.push({ id: "rival", template: ADVICE.rival, vars: { rival: c.rival.name, brand, theirs: Math.round(c.rival.vis), ours: Math.round(c.ownVis) }, go: "cv-compare" });
  if (c.gaps > 0) out.push({ id: "gaps", template: ADVICE.gaps, one: ADVICE.gapsOne, vars: { n: c.gaps, brand }, go: "cv-signals" });
  if (c.ownSiteCitations === 0 && n > 0) out.push({ id: "noOwnSite", template: ADVICE.noOwnSite, vars: { brand }, go: "cv-sources" });
  if (!out.some((x) => x.id === "rival") && c.rival && c.ownVis != null && c.ownVis >= c.rival.vis && c.ownVis > 0) out.push({ id: "leading", template: ADVICE.leading, vars: { brand }, go: "cv-runs" });
  return out.slice(0, 3);
}

/* ---------- Prompts to start from ---------- */

// What people ask an AI before they buy: discovery, comparison, price, trust,
// a specific need. {category} is what the person sells, in their words.
export const PROMPT_TEMPLATES = [
  { t: "best {category}", tags: "discovery" },
  { t: "best {category} in {year}", tags: "discovery" },
  { t: "top {category} brands", tags: "discovery" },
  { t: "best {category} for beginners", tags: "need" },
  { t: "best budget {category}", tags: "price" },
  { t: "best premium {category}, worth the money?", tags: "price" },
  { t: "which {category} brand has the best reviews?", tags: "trust" },
  { t: "is {brand} a good choice for {category}?", tags: "brand", needs: "brand" },
  { t: "{brand} vs {rival}: which is better?", tags: "comparison", needs: "rival" },
  { t: "alternatives to {rival}", tags: "comparison", needs: "rival" },
];

/**
 * Example prompts for a campaign, as English templates with their values
 * (the page translates and fills them). Templates that need a brand or a
 * competitor the person hasn't given are left out.
 */
export function examplePrompts({ category, brand, rival, year = new Date().getFullYear() } = {}) {
  const cat = String(category || "").trim();
  if (!cat) return [];
  return PROMPT_TEMPLATES
    .filter((x) => (x.needs === "brand" ? !!brand : x.needs === "rival" ? !!(brand && rival) : true))
    // The year as text: fmt() writes numbers in the language's style, and a
    // year isn't a quantity ("2,026").
    .map((x) => ({ template: x.t, vars: { category: cat, brand: brand || "", rival: rival || "", year: String(year) }, tags: x.tags }));
}

/* ---------- For people coming from 0.36 ---------- */

/** Shown once to people who update from a version before 0.80 (the
 * redesign), and in Help. Each line: what they knew, and where it is now. */
export const WHATS_CHANGED = [
  { was: "Analyze", now: "Analyze shows the answer as the engine showed it, beside the analysis: the brands in the order they were named, the pages cited and the ones only read, the searches it ran." },
  { was: "Dashboard", now: "The Dashboard is your prompt history: one row per prompt, grouped by day, searchable. A campaign's totals are on its own results board." },
  { was: "Compare", now: "The Compare tab is gone. Engines on the same prompt are side by side in Analyze; brands are compared in Campaigns → Compare." },
  { was: "Campaigns", now: "A campaign keeps its setup, and each run's results are one board: brands, sources, citations, prompts, run against run, and a page for each competitor." },
  { was: "New", now: "Ask questions about your own captures, answered on this computer; share a campaign as a file; a glossary of every metric; and the interface in Spanish, Portuguese, French, Hindi and Arabic." },
  { was: "Your data", now: "Everything you captured with the earlier version is still here." },
];

/** Whether an update from `previous` (a version string) should show the
 * "what's changed" step: everything before the 0.80 redesign. */
export function cameFromBeforeRedesign(previous) {
  const m = /^(\d+)\.(\d+)/.exec(String(previous || ""));
  if (!m) return false;
  return Number(m[1]) === 0 && Number(m[2]) < 80;
}

/** Help (ui/help.html): questions people ask, and short answers. */
export const HELP = [
  { q: "How does CitoSkeleton get the answers?", a: "It reads the answer your browser already received from ChatGPT, Gemini, Perplexity or Grok, in the tab where you asked. It sends no request of its own and needs no account. Signed in or signed out both work; in a private window only if you allow it in chrome://extensions." },
  { q: "An answer wasn't captured. What do I do?", a: "Refresh the engine's tab and ask again. Check capture isn't paused: the toolbar icon says \"off\" when it is. About → Diagnostics → Capture check shows each engine's state. If it still fails, press 💬 in Analyze to save a report you can send." },
  { q: "What's the difference between cited and read?", a: "Read: the engine opened the page while answering. Cited: it credited the page in the answer it wrote. A page read but not cited informed the answer without getting the credit." },
  { q: "What do Share of voice, Visibility and Position mean?", a: "Visibility: how many answers name a brand at all. Share of voice: a brand's part of all brand mentions. Position: how early it's named, against the other brands you track. About → Metric glossary explains every number, and hovering a label explains it in place." },
  { q: "Why do my numbers change between runs?", a: "AI engines don't give the same answer twice. One answer is an example, not a measurement: the more prompts and runs a number rests on, the more it means. Each campaign says how many answers its numbers rest on and how far they could move by chance." },
  { q: "How does a campaign run? Is it safe for my accounts?", a: "It opens the engines in tabs in your own browser and asks each prompt the way you would, at a human pace, waiting for each answer. If an engine says you've hit its limit, the run pauses on that engine and carries on later. Keep runs to a sensible size: the engines' own terms apply to your account." },
  { q: "Where is my data? How do I delete it?", a: "On this computer, in this browser, and nowhere else. About → Data & tools exports it or deletes it; uninstalling CitoSkeleton removes all of it." },
  { q: "What does the built-in AI do? Is anything sent?", a: "It labels answers and answers your questions in Ask, on this computer. Turning it on downloads the model once from Hugging Face; after that nothing you capture is sent anywhere." },
  { q: "Can I share a campaign with a colleague?", a: "Campaigns → ⋯ → Share campaign… saves it as one .cito file. They open it with Campaigns → Import… and can run it on their own computer, with the same answers and numbers." },
  { q: "I used the earlier version. Where did things go?", a: "" },
  { q: "How do I report a problem?", a: "Press 💬 on the answer in Analyze: it saves a .zip with what's needed to look into it, and shows you what's in it first. About → Diagnostics → Export .zip covers a whole campaign." },
];
