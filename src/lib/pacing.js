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
