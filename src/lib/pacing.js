/* pacing.js — how long to give one automated turn before calling it failed.
 *
 * Split out of background.js purely so it can be unit-tested: everything here
 * is arithmetic over observed turn durations, with no chrome.* dependency.
 *
 * Context. A campaign run fires one prompt at a time per engine and waits for
 * a capture. If none arrives within the turn budget the turn is recorded as
 * FAILED and the run advances. That budget used to be a single fixed 90s,
 * which is wrong in both directions and expensive both ways on a long run:
 *
 *   Too long — every failure costs the full budget doing nothing. At a 5%
 *   failure rate over 1000 prompts, a 90s budget is 75 minutes of a run
 *   sitting idle waiting out turns that were never coming.
 *
 *   Too short — an engine genuinely taking longer than the budget on a heavy
 *   search-and-synthesise answer has its turn killed while it is still
 *   working, and the result is recorded as a failure that never happened.
 *   That is the worse direction: a slow run is an annoyance, a fabricated
 *   failure silently loses a measurement.
 *
 * Since the runner already keeps a rolling window of completed turn durations
 * per engine (for the ETA), the budget can calibrate itself against what this
 * engine has actually been doing, instead of one guess covering every engine
 * on every network.
 */

export const TURN_TIMEOUT_MS = 90000;      // fallback until enough samples exist
export const TURN_TIMEOUT_MIN_MS = 45000;  // floor: never below a healthy slow turn
export const TURN_TIMEOUT_MAX_MS = 150000; // ceiling: above the old fixed value
export const TURN_TIMEOUT_FACTOR = 3;      // budget = 3x the typical turn
export const TURN_TIMEOUT_MIN_SAMPLES = 3; // fewer than this and the mean is noise

/* Median rather than mean, deliberately.
 *
 * The duration window includes turns that ran long, and a single 90s outlier
 * in a window of ten drags a mean up by ~5s — enough to re-inflate the very
 * budget this exists to bring down. The median ignores it. It also protects
 * the other way: a couple of freak-fast turns can't collapse the budget and
 * start killing healthy ones.
 */
export function medianOf(values) {
  const nums = (values || []).filter((v) => typeof v === "number" && isFinite(v) && v > 0);
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* `p` is a platform leg: { durations: number[] } — the rolling window of
 * completed turn durations in ms. Returns the ms budget for its next turn.
 */
export function turnBudgetMs(p) {
  const durations = (p && p.durations) || [];
  const median = durations.length >= TURN_TIMEOUT_MIN_SAMPLES ? medianOf(durations) : null;
  if (median == null) return TURN_TIMEOUT_MS;
  return Math.min(
    TURN_TIMEOUT_MAX_MS,
    Math.max(TURN_TIMEOUT_MIN_MS, Math.round(median * TURN_TIMEOUT_FACTOR))
  );
}

/* ---------------- Run duration estimate ----------------
 *
 * The run fires one prompt at a time per engine, waits for a capture, then
 * waits a deliberately human-paced gap before the next. Wall-clock time per
 * prompt is therefore (turn duration + gap), and the gap is NOT part of the
 * recorded durations: those are measured from just before navigation to the
 * capture landing, so they stop before the pause that follows.
 *
 * Leaving the gap out is not a rounding error. At a mean 4.5s gap and 600
 * prompts remaining it is 45 minutes of optimism — on the one number whose
 * entire job is answering "when can I come back". Reported as: "I don't get
 * to know when all the prompts will finish running."
 */
export const INTER_PROMPT_MIN_MS = 3000;
export const INTER_PROMPT_MAX_MS = 6000;
export const INTER_PROMPT_MEAN_MS = (INTER_PROMPT_MIN_MS + INTER_PROMPT_MAX_MS) / 2;

/* Mean, not median, here — unlike turnBudgetMs.
 *
 * They answer different questions. A budget asks "how long before this ONE
 * turn is clearly stuck", where an outlier must not drag the threshold up. An
 * ETA asks "how long will the REMAINING turns take in total", which is a sum,
 * and slow turns genuinely are part of that sum. Using a median here would
 * quietly under-promise on exactly the runs that are running slow.
 */
/* From measured pace, once there is one (0.79.0).
 *
 * The durations window holds successful turns only, so the old estimate left
 * out every failed turn (a full turn budget each), every cooldown and the
 * time the extension took to record an answer — on a run with ChatGPT
 * failing, the time left fell further behind the clock with every prompt.
 * `finishTimes` stamps every prompt that finished, answered or failed; the
 * spacing between the last ones is what one prompt really costs, with all of
 * that in it. Until THROUGHPUT_MIN_FINISHES have finished, the old sum of
 * turn time and pacing gap stands in.
 */
export const THROUGHPUT_MIN_FINISHES = 3;
export const THROUGHPUT_WINDOW = 11; // 10 gaps

export function perPromptFromFinishes(finishTimes) {
  const t = (finishTimes || []).filter((v) => typeof v === "number" && isFinite(v)).slice(-THROUGHPUT_WINDOW);
  if (t.length < THROUGHPUT_MIN_FINISHES) return null;
  const span = t[t.length - 1] - t[0];
  return span > 0 ? span / (t.length - 1) : null;
}

export function legEta(p) {
  const durations = (p && p.durations) || [];
  const prompts = (p && p.prompts) || [];
  const idx = (p && typeof p.idx === "number") ? p.idx : 0;
  const remaining = Math.max(0, prompts.length - idx);
  const avgTurnMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const measured = perPromptFromFinishes(p && p.finishTimes);
  if (measured != null) return { avgTurnMs: avgTurnMs != null ? avgTurnMs : measured, perPromptMs: measured, remaining, remainingMs: measured * remaining, measured: true };
  if (avgTurnMs == null) return null;
  const perPromptMs = avgTurnMs + INTER_PROMPT_MEAN_MS;
  return { avgTurnMs, perPromptMs, remaining, remainingMs: perPromptMs * remaining };
}

/* How long a finished run took: its working time when recorded (0.79.0),
 * otherwise start to finish. */
export function runTookMs(run) {
  if (!run) return null;
  if (typeof run.activeMs === "number" && run.activeMs >= 0) return run.activeMs;
  return run.finishedAt && run.startedAt ? Math.max(0, run.finishedAt - run.startedAt) : null;
}

/* "45s", "3m 5s", "1h 42m", "2d 3h" — a 42-hour run read "2529m" before. */
export function formatDuration(ms) {
  if (ms == null || !isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

/* Engines run concurrently, one tab each, so the run finishes when its
 * SLOWEST leg does — not when their total work is done. Summing would roughly
 * double the estimate for a two-engine run.
 */
export function runEta(platforms) {
  const legs = Object.values(platforms || {});
  if (!legs.length) return null;
  let worst = 0;
  for (const p of legs) {
    const e = legEta(p);
    if (!e) return null;            // one unknown leg makes the whole ETA a guess
    worst = Math.max(worst, e.remainingMs);
  }
  return { remainingMs: worst, finishAt: Date.now() + worst };
}

/* ---------------- Concurrency: multiple tabs per engine ----------------
 *
 * One tab per engine was the whole reason a 1000-prompt campaign took ~11
 * hours per engine — every prompt waited for the previous one to fully
 * finish before the next could even navigate. Running more than one tab
 * divides that wall-clock time, but it also directly multiplies simultaneous
 * automated activity on one logged-in account, which is the actual thing
 * that gets an account flagged. That trade was put to the user rather than
 * decided here: 2 tabs per engine, chosen over 3 (faster but more
 * conspicuous) and over a configurable-default-off setting (safer to ship,
 * slower to benefit from). Nothing else about pacing changes — the
 * per-prompt human-paced gap (INTER_PROMPT_MIN/MAX_MS above) still applies
 * to each tab independently, so concurrency divides time without making any
 * single tab's request rate look less human.
 */
export const CONCURRENT_TABS_PER_ENGINE = 2;

/* ChatGPT runs in one tab (0.79.0, the owner's choice). Its tabs share one
 * session — one account signed in, one anonymous allowance signed out — so a
 * second tab doesn't add capacity: it halves the time to ChatGPT's limit and
 * puts two answer streams on one session at once. In runs next to Gemini,
 * ChatGPT failed far more often than Gemini did. */
export const TABS_PER_ENGINE = { chatgpt: 1 };
export function tabsForEngine(plat) {
  return TABS_PER_ENGINE[plat] || CONCURRENT_TABS_PER_ENGINE;
}

// Tabs are started this far apart rather than all at once, so the very first
// submissions across tabs don't land in the same instant — a burst is a much
// stronger automation signal than the same volume spread out even slightly.
// Applies once, at the start of a leg's very first turn; every turn after
// that is already paced by the normal inter-prompt gap.
export const LEG_START_STAGGER_MS = 2500;

/* Split a prompt list into `concurrency` contiguous shards, one per tab.
 *
 * Contiguous rather than round-robin (leg 0 gets prompts[0..k), leg 1 gets
 * prompts[k..n)) on purpose: it keeps "prompt 340 of 1000" meaning the same
 * thing regardless of which tab is handling it, and makes reconciliation
 * after a restart a matter of "how many of THIS shard completed" rather than
 * untangling an interleaved order.
 *
 * The front legs get the extra prompt(s) when the count doesn't divide
 * evenly (7 prompts / 2 legs -> 4, 3), so no leg is ever silently starved.
 * `startOffset` is carried on each shard because campaign runs need to map a
 * leg-local index back to the ORIGINAL prompt list — that is what lines a
 * capture up with the right tracked prompt's provenance (profile/tags), and
 * getting it wrong silently mis-attributes brand-mention data rather than
 * failing loudly.
 *
 * A shard can be empty (more legs requested than prompts exist); callers are
 * expected to skip creating a tab for an empty shard rather than opening one
 * with nothing to do.
 */
export function shardPrompts(prompts, concurrency = CONCURRENT_TABS_PER_ENGINE) {
  const list = prompts || [];
  const n = Math.max(1, Math.floor(concurrency) || 1);
  const base = Math.floor(list.length / n);
  const extra = list.length % n;
  const legs = [];
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    legs.push({
      startOffset: offset,
      legIndex: i,
      prompts: list.slice(offset, offset + size),
      idx: 0,
      tabId: null,
      token: null,
      turnCount: 0,
    });
    offset += size;
  }
  return legs;
}

export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 1800000; // 30 minutes default

/**
 * Extracts cooldown duration in milliseconds from a rate-limit notice string.
 * Supports patterns: "try again in 45 minutes", "in 1 hour", "after 4:30 PM", etc.
 */
export function parseCooldownFromNotice(text, now = new Date()) {
  if (!text || typeof text !== "string") return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const str = text.toLowerCase();

  // Pattern: "in X minute(s)"
  const minMatch = str.match(/(?:in|wait|after)\s+(\d+)\s*(?:m|min|minute)/i);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    if (mins > 0 && mins <= 360) return mins * 60 * 1000;
  }

  // Pattern: "in X hour(s)"
  const hrMatch = str.match(/(?:in|wait|after)\s+(\d+(?:\.\d+)?)\s*(?:h|hr|hour)/i);
  if (hrMatch) {
    const hrs = parseFloat(hrMatch[1]);
    if (hrs > 0 && hrs <= 12) return Math.round(hrs * 3600 * 1000);
  }

  // Pattern: "after 4:30 PM" / "after 16:30"
  const timeMatch = str.match(/after\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (timeMatch) {
    let hrs = parseInt(timeMatch[1], 10);
    const mins = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (meridiem === "pm" && hrs < 12) hrs += 12;
    if (meridiem === "am" && hrs === 12) hrs = 0;

    const target = new Date(now);
    target.setHours(hrs, mins, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1); // next day
    }
    const diff = target.getTime() - now.getTime();
    if (diff > 0 && diff < 86400000) return diff;
  }

  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Format milliseconds into a human-readable countdown string e.g. "42m 15s" or "1h 12m"
 */
export function formatCooldown(ms) {
  if (!ms || ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
