/* runCompare.js — one campaign run against another (0.80.0).
 *
 * Asked: "if I were to run same campaign, same prompt on same LLM, I should
 * also be able to see the difference between them". The campaign board shows
 * one run (or the newest answers) with a change figure on its tiles; this
 * lays two runs side by side:
 *   - every brand's visibility and position in each run, and the change;
 *   - each prompt on each engine both runs answered: where the brand stood,
 *     who came first, and which brands came in or dropped out;
 *   - the sites cited in each run, and the change.
 * Only prompt × engine pairs both runs answered are compared, so a run that
 * covered another engine, or fewer prompts, doesn't read as a drop.
 * Pure: records in, numbers out, no chrome.* (unit test: run-compare).
 */
import { ranksIn } from "./campaignBoard.js";
import { normName } from "./geo.js";

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const keyOf = (r) => `${(r.geo && r.geo.promptId) || String(r.userPrompt || "").trim().toLowerCase()}|${r.platform}`;

// Newest answer per prompt and engine within one run (a retry can add a copy).
function byPair(recs) {
  const m = new Map();
  for (const r of recs || []) {
    const k = keyOf(r);
    const cur = m.get(k);
    if (!cur || (r.capturedAt || 0) > (cur.capturedAt || 0)) m.set(k, r);
  }
  return m;
}

function brandsIn(r, brands) {
  const { pres, rank } = ranksIn(r, brands);
  const named = pres.filter((p) => p.present).map((p) => {
    const b = brands.find((x) => normName(x.name) === p.key);
    return { key: p.key, name: b ? b.name : p.key, pos: rank.get(p.key) || null };
  });
  const first = named.filter((x) => x.pos === 1)[0] || null;
  return { named, first: first ? first.name : null, rank };
}

function citedDomains(recs) {
  const m = new Map();
  for (const r of recs) {
    const seen = new Set();
    for (const s of r.sources || []) {
      if (s.outcome !== "cited" || !s.domain || seen.has(s.domain)) continue;
      seen.add(s.domain);
      m.set(s.domain, (m.get(s.domain) || 0) + 1);
    }
  }
  return m;
}

/**
 * @param recsA  answers of the earlier run
 * @param recsB  answers of the later run
 * @param opts   { brands: [{name, isOwn}], prompts: [{id, text}] }
 */
export function compareRuns(recsA, recsB, { brands = [], prompts = [] } = {}) {
  const A = byPair(recsA), B = byPair(recsB);
  const shared = [...A.keys()].filter((k) => B.has(k));
  const own = brands.find((b) => b.isOwn) || null;
  const ownKey = own ? normName(own.name) : null;
  const textOf = (r) => {
    const p = prompts.find((x) => r.geo && x.id === r.geo.promptId);
    return (p && p.text) || r.userPrompt || "";
  };

  // Per brand, over the pairs both runs answered.
  const brandRows = brands.map((b) => {
    const key = normName(b.name);
    const side = (M) => {
      let named = 0;
      const pos = [];
      for (const k of shared) {
        const { named: list } = brandsIn(M.get(k), brands);
        const hit = list.find((x) => x.key === key);
        if (hit) { named++; if (hit.pos) pos.push(hit.pos); }
      }
      return { named, visibility: pct(named, shared.length), avgPos: avg(pos), first: pos.filter((p) => p === 1).length };
    };
    const a = side(A), bb = side(B);
    return {
      name: b.name, isOwn: !!b.isOwn, a, b: bb,
      dVisibility: Math.round((bb.visibility - a.visibility) * 10) / 10,
      dPos: a.avgPos != null && bb.avgPos != null ? Math.round((bb.avgPos - a.avgPos) * 10) / 10 : null,
    };
  }).filter((r) => r.a.named || r.b.named)
    .sort((x, y) => (y.isOwn - x.isOwn) || Math.max(y.a.visibility, y.b.visibility) - Math.max(x.a.visibility, x.b.visibility));

  // Per prompt and engine.
  const rows = shared.map((k) => {
    const ra = A.get(k), rb = B.get(k);
    const ia = brandsIn(ra, brands), ib = brandsIn(rb, brands);
    const namesA = new Set(ia.named.map((x) => x.name)), namesB = new Set(ib.named.map((x) => x.name));
    const ownA = ownKey ? (ia.named.find((x) => x.key === ownKey) || null) : null;
    const ownB = ownKey ? (ib.named.find((x) => x.key === ownKey) || null) : null;
    // Lower is better; absent counts as worse than any place.
    const score = (o) => (o ? o.pos || 50 : 99);
    const change = !ownKey ? "same" : score(ownB) < score(ownA) ? "better" : score(ownB) > score(ownA) ? "worse" : "same";
    return {
      prompt: textOf(rb) || textOf(ra), engine: rb.platform,
      a: { pos: ownA ? ownA.pos || "named" : null, first: ia.first, brands: [...namesA], captureId: ra.captureId },
      b: { pos: ownB ? ownB.pos || "named" : null, first: ib.first, brands: [...namesB], captureId: rb.captureId },
      gained: [...namesB].filter((n) => !namesA.has(n)),
      lost: [...namesA].filter((n) => !namesB.has(n)),
      firstChanged: ia.first !== ib.first,
      change,
    };
  }).sort((x, y) => ({ worse: 0, better: 1, same: 2 }[x.change] - { worse: 0, better: 1, same: 2 }[y.change]) || x.prompt.localeCompare(y.prompt));

  const sA = citedDomains(shared.map((k) => A.get(k))), sB = citedDomains(shared.map((k) => B.get(k)));
  const sites = [...new Set([...sA.keys(), ...sB.keys()])]
    .map((d) => ({ domain: d, a: sA.get(d) || 0, b: sB.get(d) || 0, d: (sB.get(d) || 0) - (sA.get(d) || 0) }))
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d) || (y.a + y.b) - (x.a + x.b))
    .slice(0, 30);

  return {
    compared: shared.length,
    onlyA: A.size - shared.length,
    onlyB: B.size - shared.length,
    summary: {
      better: rows.filter((r) => r.change === "better").length,
      worse: rows.filter((r) => r.change === "worse").length,
      same: rows.filter((r) => r.change === "same").length,
      firstChanged: rows.filter((r) => r.firstChanged).length,
    },
    brands: brandRows,
    rows,
    sites,
  };
}
