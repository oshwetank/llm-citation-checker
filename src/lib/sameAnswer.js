/* sameAnswer.js — one answer, one record.
 *
 * An engine can send the same answer several times: Grok streamed it over its
 * live gateway (three in-progress snapshots and a completed one), then sent
 * it again over REST (the fullest copy: 2 cited pages, 46 read, five
 * searches), then once more when the page re-read the message (the text, no
 * sources). Each was stored as its own capture, so one question showed as six
 * answers, and the newest, which had no sources, was the one Analyze and the
 * report opened. Reported: "i only run 1 query but the tool captured multiple
 * responses."
 *
 * answerKey() names the answer a record belongs to; mergeAnswers() folds the
 * copies into the fullest one. Pure: background.js does the storing.
 */

// Copies of one answer arrive within seconds of each other; a few minutes
// covers a slow stream without joining a question asked again later.
export const SAME_ANSWER_WINDOW_MS = 10 * 60 * 1000;

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function parse(u) {
  try { return new URL(u); } catch (_) { return null; }
}

/* The answer a record belongs to, or null when nothing ties it to one.
 *  - a reply id in the page's address (Grok's ?rid=) names the reply itself;
 *  - else the engine's turn id;
 *  - else the conversation (its id, or the /c/… path) together with the
 *    question, so two questions in one conversation stay apart. */
export function answerKey(rec) {
  if (!rec || !rec.platform) return null;
  const p = rec.platform;
  const url = parse(rec.pageUrl);
  const rid = url && url.searchParams.get("rid");
  if (rid) return `${p}|reply:${rid}`;
  if (rec.turnId) return `${p}|turn:${rec.turnId}`;
  const q = norm(rec.userPrompt);
  if (!q) return null;
  if (rec.conversationId) return `${p}|conv:${rec.conversationId}|${q}`;
  const path = url && url.pathname.match(/^\/(?:c|chat|app|search)\/[^/]+/);
  if (path) return `${p}|path:${path[0]}|${q}`;
  return null;
}

// Whether two copies' texts can be one answer: one is still (nearly) empty,
// or the shorter is the start of the longer, letters and digits compared.
// Copies of one answer differ in how far the stream got, not in what it said;
// a regenerated or re-asked answer in the same conversation says something
// else somewhere, even when it opens the same way.
const letters = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function textsAgree(a, b) {
  const x = letters(a.answerText), y = letters(b.answerText);
  const n = Math.min(x.length, y.length);
  if (n < 40) return true;
  return x.slice(0, n) === y.slice(0, n);
}

/* Two records are copies of one answer: the same answer key, captured within
 * the window. A reply id names the reply outright; matched only by the
 * conversation and the question, their texts must agree too, so pressing
 * "regenerate" keeps its own record. */
// A reply id or turn id names one reply, however long after it a copy turns
// up: reopening a Grok conversation 44 minutes later made the page-text
// reader send it again, and the 10-minute window let it in as a new answer
// (reported: a prompt "Youbest good quality…" that was never asked).
export const SAME_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function sameAnswer(a, b, windowMs = SAME_ANSWER_WINDOW_MS) {
  const k = answerKey(a);
  if (!k || k !== answerKey(b)) return false;
  const byId = /\|(?:reply|turn):/.test(k);
  if (Math.abs((a.capturedAt || 0) - (b.capturedAt || 0)) > (byId ? Math.max(windowMs, SAME_REPLY_WINDOW_MS) : windowMs)) return false;
  return byId || textsAgree(a, b);
}

/** A copy read off the page's text rather than its network traffic. */
export const isPageCopy = (r) => !!(r && r.platformSpecific && r.platformSpecific.pageCopy);

// How complete a copy is: an answer beats none, then the longer text, then
// more cited pages, pages read and searches.
function completeness(r) {
  const text = r.answerChars || (r.answerText ? r.answerText.length : 0);
  const sources = r.sources || [];
  const cited = sources.filter((s) => s.outcome === "cited").length;
  const searches = Object.values(r.fanout || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  // A page-text copy is a fallback: its text carries the page's own labels
  // and its prompt was read off the screen, so any network copy beats it.
  return (isPageCopy(r) ? 0 : 1e15) + (text > 0 ? 1e9 : 0) + text * 1000 + cited * 100 + sources.length * 10 + searches;
}

const urlKey = (s) => {
  const u = String((s && (s.url || s.domain)) || "").replace(/[?&]utm_[^&#]*/g, "").replace(/[?#]$/, "");
  return u.toLowerCase();
};
const queryText = (q) => (typeof q === "string" ? q : q && q.query) || "";
const itemKey = (x) => norm((x && (x.name || x.title || x.url)) || "");

/* Fold copies of one answer into the fullest. The fullest copy's text,
 * brands and everything read off the text stay as they are; pages, searches
 * and cards seen in any copy are added. A page cited in any copy counts as
 * cited. The record keeps the earliest copy's id and time, so the capture
 * already on screen stays the same one, and lists which copies it absorbed. */
export function mergeAnswers(records) {
  const list = records.filter(Boolean);
  if (list.length < 2) return list[0] || null;
  const best = [...list].sort((a, b) => completeness(b) - completeness(a))[0];
  const first = [...list].sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0))[0];
  const out = { ...best, captureId: first.captureId, capturedAt: first.capturedAt };

  // Pages: the best copy's order first, then any others; cited wins.
  const pages = new Map();
  for (const r of [best, ...list.filter((r) => r !== best)]) {
    for (const s of r.sources || []) {
      const k = urlKey(s);
      if (!k) continue;
      const prev = pages.get(k);
      if (!prev) pages.set(k, { ...s });
      else if (s.outcome === "cited" && prev.outcome !== "cited") pages.set(k, { ...prev, ...s, outcome: "cited" });
    }
  }
  out.sources = [...pages.values()];

  // Searches, lane by lane. A copy whose only "search" is the question itself
  // is echoing it, not reporting a search (Grok's late REST copy did): it
  // adds nothing when another copy has the real ones.
  const prompt = norm(best.userPrompt || first.userPrompt);
  const lanes = new Set(list.flatMap((r) => Object.keys(r.fanout || {})));
  const fanout = {};
  for (const lane of lanes) {
    const seen = new Map();
    for (const r of [best, ...list.filter((r) => r !== best)]) {
      const qs = (r.fanout && r.fanout[lane]) || [];
      const echoOnly = qs.length === 1 && norm(queryText(qs[0])) === prompt;
      for (const q of qs) {
        const k = norm(queryText(q));
        if (!k || seen.has(k)) continue;
        if (echoOnly && list.some((o) => o !== r && ((o.fanout && o.fanout[lane]) || []).some((x) => norm(queryText(x)) !== prompt))) continue;
        seen.set(k, q);
      }
    }
    fanout[lane] = [...seen.values()];
  }
  out.fanout = { ...(best.fanout || {}), ...fanout };

  // Cards: the fullest list, then anything only another copy had.
  for (const field of ["products", "places", "images", "ads"]) {
    const lists = list.map((r) => r[field] || []);
    if (!lists.some((l) => l.length)) continue;
    const base = [...lists].sort((a, b) => b.length - a.length)[0];
    const keys = new Set(base.map(itemKey));
    const extra = lists.flat().filter((x) => { const k = itemKey(x); if (!k || keys.has(k)) return false; keys.add(k); return true; });
    out[field] = [...base, ...extra];
  }

  out.searched = list.some((r) => r.searched) || out.sources.length > 0;
  if (!out.geo) out.geo = (list.find((r) => r.geo) || {}).geo || null;
  if (!out.runId) out.runId = (list.find((r) => r.runId) || {}).runId || null;
  if (!out.projectId) out.projectId = (list.find((r) => r.projectId) || {}).projectId || null;
  const absorbed = new Set([...(out.mergedFrom || []), ...list.flatMap((r) => [r.captureId, ...(r.mergedFrom || [])])]);
  absorbed.delete(out.captureId);
  out.mergedFrom = [...absorbed];
  return out;
}
