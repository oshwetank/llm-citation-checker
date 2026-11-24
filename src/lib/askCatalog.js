/*
 * askCatalog.js — Ask's map of everything the user has (1.0.5, Stage 1 of
 * ASK-ARCHITECTURE.md §4.2).
 *
 * Collections (each campaign, plus "My questions": everything asked by hand
 * on the Dashboard), the brands with every spelling seen, tags, prompts,
 * runs, engines with their aliases, and the sites cited. Built in code from
 * the stored records, profiles and runs, in milliseconds, before any model
 * runs. A question's words are looked up here first (exact, then
 * normalised, then fuzzy), so the scope Ask uses is always made of things
 * that exist, never a name a model made up.
 */
import { normName, trackedBrandsOf } from "./geo.js";
import { normDomain } from "./siteKind.js";

export const HISTORY_ID = "history";
export const HISTORY_NAME = "My questions";
export const ENGINES = ["chatgpt", "gemini", "perplexity", "grok", "aimode"];
export const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok", aimode: "AI Mode" };
// What people call each engine. Product names are the same in all six
// interface languages; the common nicknames are added.
export const ENGINE_ALIASES = {
  chatgpt: ["chatgpt", "chat gpt", "gpt", "openai", "open ai"],
  gemini: ["gemini", "bard"],
  perplexity: ["perplexity", "pplx"],
  grok: ["grok", "xai", "x ai"],
  aimode: ["ai mode", "google ai mode", "aimode"],
};

const answered = (r) => String(r.answerText || "").trim().length > 0;
const runOf = (r) => (r.geo && r.geo.runId) || r.runId || null;
export const collectionOf = (r) => (r.geo && r.geo.profileId) || HISTORY_ID;
const named = (r) => (r.brandMentions || []).filter((m) => m && m.brand && (m.count || 0) > 0);

/** Lower-case, accents off, punctuation to spaces, single spaces. */
export function fold(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The catalog for one set of stored data.
 * @param {{records?: object[], profiles?: object[], runs?: object[]}} data
 */
export function buildCatalog({ records = [], profiles = [], runs = [] } = {}) {
  const collections = [];
  const byId = new Map();
  const add = (c) => { collections.push(c); byId.set(c.id, c); return c; };
  for (const p of profiles) {
    const tracked = trackedBrandsOf(p);
    add({
      id: p.id, kind: "campaign", name: p.name || "Campaign",
      brand: (p.brand && p.brand.name) || null,
      site: (p.brand && (p.brand.url || p.brand.site)) || null,
      competitors: (p.competitors || []).map((c) => c && c.name).filter(Boolean),
      tracked: tracked.map((b) => b.name),
      prompts: (p.prompts || []).map((x) => ({ id: x.id, text: x.text || "", tags: x.tags || [] })),
      tags: [], runs: [], engines: new Set(), answers: 0, lastAt: 0, firstAt: 0,
    });
  }
  const history = add({ id: HISTORY_ID, kind: "history", name: HISTORY_NAME, brand: null, site: null, competitors: [], tracked: [], prompts: [], tags: [], runs: [], engines: new Set(), answers: 0, lastAt: 0, firstAt: 0 });

  for (const g of runs) {
    const c = byId.get(g.profileId);
    if (c) c.runs.push({ id: g.id, startedAt: g.startedAt || 0, status: g.status || "done", engines: g.platforms || g.engines || null });
  }
  for (const c of collections) c.runs.sort((a, b) => a.startedAt - b.startedAt);

  const brands = new Map(); // fold(name) → {name, spellings, collections, answers}
  const sites = new Map();  // domain → answers citing it
  const historyPrompts = new Map();
  const tagSets = new Map(collections.map((c) => [c.id, new Set()]));
  const brandOf = (name) => {
    const k = fold(name);
    if (!k) return null;
    let b = brands.get(k);
    if (!b) { b = { key: k, name, spellings: new Set(), collections: new Set(), answers: 0, tracked: false }; brands.set(k, b); }
    b.spellings.add(name);
    return b;
  };
  for (const c of collections) for (const n of c.tracked) { const b = brandOf(n); if (b) { b.collections.add(c.id); b.tracked = true; } }
  for (const c of collections) for (const p of c.prompts) for (const t of p.tags) tagSets.get(c.id).add(t);

  for (const r of records) {
    const c = byId.get(collectionOf(r)) || history;
    c.answers++;
    c.engines.add(r.platform);
    const t = r.capturedAt || 0;
    if (t > c.lastAt) c.lastAt = t;
    if (!c.firstAt || (t && t < c.firstAt)) c.firstAt = t;
    for (const tg of (r.geo && r.geo.tags) || []) tagSets.get(c.id).add(tg);
    if (c === history && r.userPrompt) {
      const k = fold(r.userPrompt);
      if (k && !historyPrompts.has(k)) historyPrompts.set(k, { id: `h:${k.slice(0, 80)}`, text: r.userPrompt, tags: [] });
    }
    if (!answered(r)) continue;
    for (const m of named(r)) { const b = brandOf(m.brand); if (b) { b.collections.add(c.id); b.answers++; } }
    for (const d of new Set((r.sources || []).filter((s) => s && s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean))) sites.set(d, (sites.get(d) || 0) + 1);
  }
  history.prompts = [...historyPrompts.values()];
  for (const c of collections) { c.tags = [...tagSets.get(c.id)]; c.engines = ENGINES.filter((e) => c.engines.has(e)); }
  // "My questions" only counts as a collection when there is something in it.
  const live = collections.filter((c) => c.kind !== "history" || c.answers > 0);
  return { collections: live, byId, brands, sites, engines: ENGINES };
}

/* ---------- Lookup ---------- */

const trigrams = (s) => { const t = `  ${s} `; const out = new Set(); for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3)); return out; };
/** Trigram similarity (Jaccard) of two folded strings, 0..1. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b);
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}
// Whole-word containment in a folded question.
const hasPhrase = (q, phrase) => !!phrase && (` ${q} `).includes(` ${phrase} `);
const ngrams = (words, max = 4) => { const out = []; for (let n = 1; n <= max; n++) for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" ")); return out; };
// Words too common to be a name on their own.
const STOP = new Set("the a an and or of in on for to my our we us is are was were be how what which who why when where do does did vs versus with without about than then from by at as it its this that these those all any each per me i you your".split(" "));

/**
 * Names from the catalog that a question mentions.
 * @returns {{kind: "collection"|"brand"|"engine"|"tag"|"site", id: string, name: string, score: number, how: "exact"|"fuzzy"}[]}
 */
export function lookup(question, catalog) {
  const full = fold(question);
  const original = String(question || "");
  const out = [];
  const push = (m) => { const prev = out.find((x) => x.kind === m.kind && x.id === m.id); if (!prev) out.push(m); else if (m.score > prev.score) Object.assign(prev, m); };
  const matcher = (q) => {
    const words = q.split(" ").filter(Boolean);
    const grams = ngrams(words).filter((g) => !STOP.has(g) && g.length >= 3);
    return (kind, id, name, phrases) => {
      for (const ph of phrases) {
        const f = fold(ph);
        if (!f) continue;
        if (hasPhrase(q, f)) { push({ kind, id, name, score: 1, how: "exact" }); return; }
      }
      // Fuzzy: a typo or a plural ("zentos", "zneto"). Only for names of 4+
      // letters, against word groups of about the same length.
      let best = 0;
      for (const ph of phrases) {
        const f = fold(ph);
        if (f.length < 4) continue;
        for (const g of grams) { if (Math.abs(g.length - f.length) > 3) continue; const s = similarity(g, f); if (s > best) best = s; }
      }
      if (best >= 0.5) push({ kind, id, name, score: Math.round(best * 100) / 100 * 0.8, how: "fuzzy" });
    };
  };
  const m1 = matcher(full);
  for (const c of catalog.collections) {
    if (c.kind === "history") { m1("collection", c.id, c.name, [c.name, "my questions", "dashboard", "asked by hand", "manual questions"]); continue; }
    m1("collection", c.id, c.name, [c.name]);
  }
  // The rest is read from the question with the campaign names taken out
  // (1.0.5, real data): "R2 — Small-business CRM" names a campaign, not a
  // tag "crm"; "R3 — Paints stress" holds no brand "Paints".
  let q = ` ${full} `;
  for (const m of out) if (m.how === "exact") { const f = fold(m.name); if (f) q = q.split(` ${f} `).join(" | "); }
  q = q.replace(/\s+/g, " ").trim();
  const words = q.split(" ").filter(Boolean);
  const m2 = matcher(q);
  // A brand nobody tracks counts only when the question writes it as a
  // name (a capital, or several words): the stored brands include ordinary
  // words that answers wrote in bold ("Sites", "Sources"), and "which sites
  // are cited" must not narrow to one of them (1.0.5, real data).
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Written with a capital where it appears in the question (case kept).
  const capitalised = (sp) => { const m = new RegExp(`(?:^|[^\\p{L}])(${escRe(sp)})(?![\\p{L}])`, "iu").exec(original); return !!m && /^\p{Lu}/u.test(m[1]); };
  const asName = (b) => b.tracked || [...b.spellings].some((sp) => /\s/.test(sp.trim()) || capitalised(sp.trim()));
  for (const b of catalog.brands.values()) if (asName(b)) m2("brand", b.key, b.name, [...b.spellings]);
  // A brand inside a longer brand named here ("Paints" inside "Asian Paints") is that longer one.
  const brands = out.filter((m) => m.kind === "brand");
  for (const m of brands) {
    const f = fold(m.name);
    if (brands.some((o) => o !== m && fold(o.name) !== f && hasPhrase(fold(o.name), f) && hasPhrase(q, fold(o.name)))) out.splice(out.indexOf(m), 1);
  }
  for (const [e, al] of Object.entries(ENGINE_ALIASES)) {
    // Engines are short words: exact only, so "grok" never fuzzes into "group".
    if (al.some((a) => hasPhrase(q, fold(a)))) push({ kind: "engine", id: e, name: ENGINE_LABEL[e], score: 1, how: "exact" });
  }
  // A tag counts when the question uses it as a topic ("battery prompts",
  // "about battery", "the battery tag"), not whenever its word appears
  // ("Top brands" is not the tag "brand").
  const tags = new Map();
  for (const c of catalog.collections) for (const t of c.tags) { const k = fold(t); if (k && !tags.has(k)) tags.set(k, t); }
  const asTopic = (k) => new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w{0,3} (prompts?|questions?|topics?|tag)( |$)|(^| )(about|on|for|tag|topic|tagged) (the )?${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w{0,3}( |$)`).test(q);
  for (const [k, t] of tags) {
    if (k.split(" ").length > 1 && hasPhrase(q, k)) { push({ kind: "tag", id: k, name: t, score: 1, how: "exact" }); continue; }
    if (asTopic(k)) { push({ kind: "tag", id: k, name: t, score: 1, how: "exact" }); continue; }
    // "battery prompts" for a tag "batteries".
    if (k.length >= 4 && words.some((w, i) => w.length >= 4 && (w.startsWith(k) || k.startsWith(w)) && Math.abs(w.length - k.length) <= 2 && /^(prompts?|questions?|topics?)$/.test(words[i + 1] || ""))) push({ kind: "tag", id: k, name: t, score: 0.8, how: "fuzzy" });
  }
  for (const d of catalog.sites.keys()) {
    const base = d.replace(/^www\./, "");
    if (q.includes(base) || (base.split(".")[0].length >= 4 && hasPhrase(q, base.split(".")[0]))) push({ kind: "site", id: d, name: d, score: q.includes(base) ? 1 : 0.7, how: q.includes(base) ? "exact" : "fuzzy" });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Facts: one row per turn (prompt × engine × run), for scope filters and coverage. */
export function factOf(r) {
  const ms = named(r);
  const first = [...ms].sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15))[0];
  return {
    captureId: r.captureId,
    collection: collectionOf(r),
    run: runOf(r),
    promptId: (r.geo && r.geo.promptId) || null,
    prompt: r.userPrompt || "",
    tags: (r.geo && r.geo.tags) || [],
    engine: r.platform,
    at: r.capturedAt || 0,
    signedIn: (r.session && r.session.signedIn) || "unknown",
    answered: answered(r),
    brands: ms.map((m) => fold(m.brand)),
    firstBrand: first ? fold(first.brand) : null,
    cited: [...new Set((r.sources || []).filter((s) => s && s.outcome === "cited").map((s) => normDomain(s.domain || s.url)).filter(Boolean))],
  };
}
export { normName };
