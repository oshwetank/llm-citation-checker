/* campaignReport.js — the campaign PDF report (0.53.0), as data.
 *
 * Release 6b of the canvas redesign: up to seven A4 pages about one run of a
 * campaign — a summary, then brands, prompts, sources, kinds of answer and
 * products, the engines' searches, and what to do next with how it was
 * measured. ui/report.js lays the pages out and the browser prints them, so
 * the PDF has real, selectable text and no PDF library ships with the
 * extension (the same choice exportDoc.js made).
 *
 * Pure: records in, a plain object out. The headline numbers come from the
 * campaign board (campaignBoard.js) for the run reported on, so the report
 * and the board agree; the tables come from the raw rows the Excel workbook
 * writes (campaignFacts in campaignXlsx.js), so "every row behind this
 * report is in the workbook" stays true.
 */

import { averageByCurrency } from "./money.js";
import { campaignBoard } from "./campaignBoard.js";
import { campaignFacts, RAW } from "./campaignXlsx.js";
import { computeMetrics, normName, domainOfUrl } from "./geo.js";
import { siteKindOf, KIND_GROUPS } from "./siteKind.js";

/** The pages, in order. The summary always prints; the rest can be left out. */
export const REPORT_PAGES = [
  ["summary", "Summary", "Headline numbers, visibility by run, findings"],
  ["brands", "Brands", "Scorecard, visibility per engine, head to head, backing"],
  ["prompts", "Prompts", "Position on every prompt and engine; where you are missing"],
  ["sources", "Sources", "Kinds of site, most-cited sites and pages, gaps"],
  ["products", "Kinds of answer and products", "Card share, where cards send buyers, images"],
  ["searches", "Engine searches", "Searches per engine and the most repeated ones"],
  ["method", "Method", "Definitions, runs and the full prompt list"],
];

/** How each number is measured, as the last page prints it. */
export const REPORT_DEFINITIONS = [
  ["Visibility", "Share of answers that named the brand at least once."],
  ["Share of voice", "The brand’s mentions ÷ mentions of every tracked brand in the same answers."],
  ["Average position", "Order of first mention; 1 = named first. Only answers that name the brand count."],
  ["Source visibility", "Share of answers that cited the brand’s own website."],
  ["Backing", "Independent pages, own site only, nothing behind it, or from memory (no web search)."],
  ["Card share", "The brand’s product cards ÷ all product cards shown."],
  ["Cited / read only", "Cited = linked in the answer. Read only = opened while searching, never linked."],
  ["How it was run", "A fresh chat per prompt on each engine, one engine at a time; answers read from the engine’s own stream."],
];

const pct = (a, b) => (b ? (a / b) * 100 : 0);
const round = (x) => Math.round(x);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const listOf = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sat 26 Sep 2026", as the design writes dates (en-GB would say "Sept"). */
export const dayLabel = (t) => { const d = new Date(t); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const sameName = (a, b) => normName(a || "") === normName(b || "");
const wordRe = (w) => new RegExp(`(^|[^\\p{L}\\p{N}])${String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");

/** A raw table's rows as objects keyed by column name. */
function rowsOf(F, key) {
  const cols = RAW.find((d) => d.key === key).cols;
  return F[key].map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

/** One brand's headline numbers in one set of answers. */
function brandNumbers(recs, profile, brands, name) {
  const m = computeMetrics(recs, profile, brands).brands.find((b) => sameName(b.name, name)) || {};
  return {
    visibility: m.visibility || 0, shareOfVoice: m.shareOfVoice || 0, avgPosition: m.avgPosition ?? null,
    sourceVisibility: m.sourceVisibility || 0, present: m.responsesPresent || 0,
  };
}

/** A store that belongs to the brand: its site's name or the brand's name. */
function isBrandStore(store, brand, domain) {
  const s = String(store || "").toLowerCase();
  if (!s || !brand) return false;
  if (domain && s.includes(domain.split(".")[0])) return true;
  return wordRe(brand).test(store);
}

/**
 * bundle: { profile, prompts, runs, records, brands, runId, sections, engines, generatedAt }
 *   runId     the run to report on (default: the latest with answers)
 *   sections  page keys to include besides the summary (default: all)
 *   engines   engine ids the records were narrowed to (default: all); the
 *             report's engine columns follow it
 */
export function campaignReport(bundle = {}) {
  const { profile = {}, prompts = [], runs = [], records = [], brands = [], generatedAt = Date.now() } = bundle;
  const runsWith = runs.filter((r) => records.some((x) => x.geo && x.geo.runId === r.id)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!runsWith.length) return { ok: false, error: "This campaign has no answers to report on yet." };
  const run = runsWith.find((r) => r.id === bundle.runId) || runsWith[runsWith.length - 1];
  const idx = runsWith.indexOf(run);
  const prev = idx > 0 ? runsWith[idx - 1] : null;
  const runNo = idx + 1;
  const recs = records.filter((x) => x.geo && x.geo.runId === run.id);
  const prevRecs = prev ? records.filter((x) => x.geo && x.geo.runId === prev.id) : [];
  const own = brands.find((b) => b.isOwn) || brands[0] || { name: (profile.brand && profile.brand.name) || "Your brand", url: "" };
  const OWN = own.name;
  const ownDom = domainOfUrl(own.url);
  const rivals = brands.filter((b) => !b.isOwn);
  const domOf = (name) => domainOfUrl((brands.find((b) => sameName(b.name, name)) || {}).url || "");

  const board = campaignBoard(recs, { profile, brands, prompts, runs, runId: run.id, all: records, engineFilter: bundle.engines || [] });
  const F = campaignFacts({ profile, prompts, runs: [run], records: recs, brands });
  const A = rowsOf(F, "A"), M = rowsOf(F, "M"), S = rowsOf(F, "S"), Q = rowsOf(F, "Q"), P = rowsOf(F, "P"), O = rowsOf(F, "O"), I = rowsOf(F, "I"), H = rowsOf(F, "H");
  const n = recs.length;
  const engines = board.engines;
  // The workbook's prompt IDs (P01, P02, … by when each prompt was added),
  // so a prompt has the same ID in the report and the workbook.
  const pidOf = new Map([...prompts].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((p, i) => [p.id, `P${String(i + 1).padStart(2, "0")}`]));
  const activePrompts = prompts.filter((p) => p.active !== false && recs.some((r) => r.geo && r.geo.promptId === p.id));
  const expected = run.expected || activePrompts.length * engines.length || n;
  const runLabel = `Run ${runNo}`;
  const runWord = `run ${runNo}`;
  const prevLabel = prev ? `run ${runNo - 1}` : null;
  // "actions" is the page's key before 0.59.0, when it led with next steps;
  // a saved or old link asking for it gets the method page.
  const want = new Set((bundle.sections || REPORT_PAGES.map(([k]) => k)).map((k) => (k === "actions" ? "method" : k)));
  want.add("summary");
  const ansById = new Map(A.map((a) => [a["Answer ID"], a]));
  const siteCtx = { ownBrand: OWN, ownUrl: own.url || "", brands: brands.map((b) => b.name) };

  /* ---------- page 1: summary ---------- */
  const tile = (list, label) => (list || []).find((t) => t.label === label) || null;
  const vsPrev = (d) => (d ? { text: d.text.replace(" since ", " vs "), tone: d.tone } : null);
  const namedFirstPct = (rows) => pct(rows.filter((r) => r["Named first"] === 1).length, rows.length);
  const prevA = prev ? rowsOf(campaignFacts({ profile, prompts, runs: [prev], records: prevRecs, brands }), "A") : [];
  const firstDelta = (() => {
    if (!prev || !prevA.length) return null;
    const d = round(namedFirstPct(A) - namedFirstPct(prevA));
    if (d === 0) return { text: `= same as ${prevLabel}`, tone: 0 };
    return { text: `${d > 0 ? "▲" : "▼"} ${plural(Math.abs(d), "pt")} vs ${prevLabel}`, tone: d > 0 ? 1 : -1 };
  })();
  const fm = board.focus.mentions, fp = board.focus.products;
  const searched = A.filter((r) => r["Searched web"] === 1).length;
  const kpi = (label, t) => ({ label, value: t ? t.value : "—", sub: t ? t.sub : "", delta: t ? vsPrev(t.delta) : null });
  const kpis = [
    kpi(`${OWN} visibility`, tile(fm, "Visibility")),
    kpi("Share of voice", tile(fm, "Share of voice")),
    kpi("Average position", tile(fm, "Avg position")),
    { label: "Named first", value: `${round(namedFirstPct(A))}%`, sub: `${A.filter((r) => r["Named first"] === 1).length} of ${n} answers`, delta: firstDelta },
    kpi("Source visibility", tile(fm, "Source visibility")),
    kpi("Product card share", tile(fp, "Card share")),
    { label: "Answers searched the web", value: `${round(pct(searched, n))}%`, sub: `${searched} of ${n} answers`, delta: null },
    { label: "Answers captured", value: `${n} / ${expected}`, sub: `${plural(activePrompts.length, "prompt")} × ${plural(engines.length, "engine")}`, delta: null },
  ];
  const trend = {
    runs: board.acrossRuns.runs.map((r) => r.label),
    series: board.acrossRuns.rows.map((r) => ({ name: r.name, isOwn: sameName(r.name, OWN), values: r.cells })),
  };
  const sov = [...board.brandRows].sort((a, b) => b.shareOfVoice - a.shareOfVoice).map((b) => ({ name: b.name, isOwn: !!b.isOwn, value: b.shareOfVoice }));

  const h2h = rivals.map((b) => {
    const rows = H.filter((r) => r.Competitor === b.name);
    const c = (t) => rows.filter((r) => r.Result === t).length;
    return { name: b.name, ahead: c("Ahead"), onlyYou: c("Only you"), neither: c("Neither"), both: c("Both"), onlyThem: c("Only them"), behind: c("Behind"), answers: rows.length };
  });

  const ownRow = board.brandRows.find((b) => sameName(b.name, OWN)) || { visibility: 0 };
  const topRival = [...board.brandRows].filter((b) => !sameName(b.name, OWN)).sort((a, b) => b.visibility - a.visibility)[0];
  const findings = [];
  {
    const mine = round(ownRow.visibility), theirs = topRival ? round(topRival.visibility) : -1;
    const before = prevRecs.length ? brandNumbers(prevRecs, profile, brands, OWN) : null;
    // The same rounding as the tile's "▲ N pts", so the two agree.
    const d = before ? round(ownRow.visibility - before.visibility) : null;
    const change = d == null ? "" : d === 0 ? `, the same as ${prevLabel}` : `, ${d > 0 ? "up" : "down"} ${plural(Math.abs(d), "point")} from ${prevLabel}`;
    const standing = mine > theirs ? " — the most of any brand" : mine === theirs ? `, level with ${topRival.name}` : `; ${topRival.name} was named most (${theirs}%)`;
    findings.push(`${OWN} was named in ${mine}% of ${runWord} answers${change}${standing}.`);
  }
  if (topRival) {
    const h = h2h.find((x) => x.name === topRival.name) || { behind: 0, onlyThem: 0 };
    findings.push(`${topRival.name} is the closest rival (${round(topRival.visibility)}% visibility). It came before ${OWN}, or was named without it, in ${h.behind + h.onlyThem} of ${n} answers.`);
  }
  {
    const eng = board.byEngine.filter((e) => e.answers);
    if (eng.length >= 2) {
      const sorted = [...eng].sort((a, b) => b.visibility - a.visibility);
      const hi = sorted[0], lo = sorted[sorted.length - 1];
      findings.push(round(hi.visibility) === round(lo.visibility)
        ? `${OWN} is named equally often on every engine (${round(hi.visibility)}%).`
        : `Strongest engine for ${OWN}: ${hi.label} (${round(hi.visibility)}%). Weakest: ${lo.label} (${round(lo.visibility)}%).`);
    }
  }
  {
    const gaps = board.gapSites.length;
    const sv = round(board.asSource.sourceVisibility);
    const site = !ownDom ? `${OWN} has no website on this campaign, so its own pages can't be counted.` : sv ? `${ownDom} was cited in ${sv}% of answers.` : `No answer cited ${ownDom}.`;
    findings.push(`${site}${gaps ? ` ${plural(gaps, "independent site")} cited rivals but never ${OWN}.` : ""}`);
  }
  if (board.products.total) {
    const share = tile(fp, "Card share");
    const m = /^(\d+) of (\d+)$/.exec((tile(fp, "Own store offered") || {}).value || "");
    const store = !m || !Number(m[2]) ? ""
      : m[1] === "0" ? `; ${Number(m[2]) === 1 ? "its one card doesn't" : `none of its ${m[2]} cards`} list its own store`
      : `; its own store is listed on ${m[1]} of its ${plural(Number(m[2]), "card")}`;
    findings.push(`${OWN} holds ${share ? share.value : "0%"} of product cards${store}.`);
  } else if (board.searches.total) {
    findings.push(`${round(pct(searched, n))}% of answers searched the web first, ${board.searches.perAnswer.toFixed(1)} searches each on average.`);
  } else {
    findings.push(`${round(pct(searched, n))}% of answers searched the web first; none of the engines showed what it searched for.`);
  }

  const pages = [{ key: "summary", title: "Summary", kpis, trend, findings, sov }];

  /* ---------- page 2: brands ---------- */
  if (want.has("brands")) {
    // What backs each mention: a cited page other than the brand's own site
    // that names it, only its own site, nothing, or no search at all.
    const backing = board.brandRows.map((b) => {
      const dom = domOf(b.name);
      const named = M.filter((m) => m.Brand === b.name);
      let independent = 0, ownOnly = 0, nothing = 0, memory = 0;
      for (const m of named) {
        if ((ansById.get(m["Answer ID"]) || {})["Searched web"] !== 1) { memory++; continue; }
        const cited = S.filter((s) => s["Answer ID"] === m["Answer ID"] && s.Cited === 1);
        const site = (s) => s["Site of brand"] === b.name;
        if (cited.some((s) => !site(s) && String(s["Brands on page"] || "").split(", ").includes(b.name))) independent++;
        else if (dom && cited.some(site)) ownOnly++;
        else nothing++;
      }
      return { name: b.name, isOwn: !!b.isOwn, answers: named.length, independent, ownOnly, nothing, memory };
    }).filter((x) => x.answers);
    const cardsAll = P.length;
    pages.push({
      key: "brands", title: "Brands",
      scorecard: board.brandRows.map((b) => {
        const bk = backing.find((x) => x.name === b.name);
        return {
          name: b.name, isOwn: !!b.isOwn, auto: !!b.auto, visibility: b.visibility, shareOfVoice: b.shareOfVoice, avgPosition: b.avgPosition,
          namedFirst: M.filter((m) => m.Brand === b.name && m["Named first"] === 1).length,
          backedPct: bk ? pct(bk.independent, bk.answers) : null, ownCitations: b.citations || 0,
          cardShare: cardsAll ? pct(P.filter((p) => p.Brand === b.name).length, cardsAll) : null,
        };
      }),
      heat: { engines: board.heat.engines.map((e) => e.label), rows: board.heat.rows.map((r) => ({ name: r.name, isOwn: sameName(r.name, OWN), cells: r.cells })), note: board.heat.note },
      h2h, backing, answers: n,
      recommend: board.recommend.map((r) => ({ name: r.name, isOwn: sameName(r.name, OWN), aspects: r.aspects })),
    });
  }

  /* ---------- page 3: prompts ---------- */
  if (want.has("prompts")) {
    const firstIn = (aid) => (M.find((m) => m["Answer ID"] === aid && m.Position === 1) || {}).Brand || null;
    const rows = board.prompts.rows.map((r) => {
      const id = pidOf.get(r.id) || `P${String(r.n).padStart(2, "0")}`;
      const mine = A.filter((a) => a["Prompt ID"] === id);
      const kinds = new Map();
      mine.forEach((a) => kinds.set(a["Kind of answer"], (kinds.get(a["Kind of answer"]) || 0) + 1));
      const naming = (cells) => cells.filter((c) => c && (c.pos === "shown" || c.pos > 0)).length;
      const before = prevLabel ? r.history.find((h) => h.label.toLowerCase() === prevLabel) : null;
      const rivalPct = rivals.map((b) => ({ name: b.name, v: pct(new Set(M.filter((m) => m.Brand === b.name && m["Prompt ID"] === id).map((m) => m["Answer ID"])).size, mine.length) }))
        .sort((a, b) => b.v - a.v)[0];
      return {
        id, text: r.text, tags: r.tags, kind: kinds.size ? [...kinds.entries()].sort((a, b) => b[1] - a[1])[0][0] : "", status: r.status,
        cells: r.cells.map((c) => (c ? { pos: c.pos, cited: c.cited } : null)),
        naming: naming(r.cells), asked: r.cells.filter(Boolean).length,
        change: before ? naming(r.cells) - naming(before.cells) : null,
        rival: rivalPct && rivalPct.v > 0 ? { name: rivalPct.name, pct: rivalPct.v } : null,
        citesOwn: r.citedYou,
      };
    });
    const missing = [];
    rows.forEach((r) => r.cells.forEach((c, i) => {
      if (!c || c.pos !== 0) return;
      const a = A.find((x) => x["Prompt ID"] === r.id && x.Engine === engines[i].label);
      missing.push({ id: r.id, engine: engines[i].label, firstInstead: a ? firstIn(a["Answer ID"]) : null });
    }));
    pages.push({
      key: "prompts", title: "Prompts", engines: engines.map((e) => e.label), rows, hasPrevious: !!prevLabel,
      counts: board.prompts.counts, avgWhenNamed: board.prompts.avgWhenNamed,
      neverFirst: rows.filter((r) => r.status === "lower").map((r) => ({ id: r.id, text: r.text, naming: r.naming, asked: r.asked })),
      missing,
    });
  }

  /* ---------- page 4: sources ---------- */
  if (want.has("sources")) {
    const cited = S.filter((s) => s.Cited === 1);
    const kinds = KIND_GROUPS.map((label) => {
      const all = S.filter((s) => s["Kind of site"] === label);
      const c = all.filter((s) => s.Cited === 1).length;
      return { label, read: all.length, cited: c, citedRate: pct(c, all.length), share: pct(c, cited.length) };
    }).filter((k) => k.read);
    const bySite = new Map();
    for (const s of S) {
      if (!bySite.has(s.Domain)) bySite.set(s.Domain, { site: s.Domain, kind: s["Kind of site"], cited: 0, read: 0, namingYou: 0 });
      const x = bySite.get(s.Domain);
      x.read++;
      if (s.Cited === 1) { x.cited++; if (s["Names you"]) x.namingYou++; }
    }
    // "Rivals only" marks the same sites the findings and actions name: the
    // board's independent sites that cite rivals but never the brand.
    const gapSet = new Set(board.gapSites.map((g) => g.site));
    const sites = [...bySite.values()].filter((x) => x.cited).sort((a, b) => b.cited - a.cited || a.site.localeCompare(b.site)).slice(0, 8)
      .map((x) => ({ ...x, rivalsOnly: gapSet.has(x.site) }));
    const byPage = new Map();
    for (const s of cited) {
      // A text fragment (#:~:text=…) points into the same page; count it once.
      const url = String(s.URL || "").replace(/#.*$/, "");
      const key = url || `${s.Domain}|${s["Page title"]}`;
      if (!byPage.has(key)) byPage.set(key, { title: s["Page title"] || s.Domain, url, site: s.Domain, kind: s["Kind of site"], cited: 0, namesYou: false });
      const x = byPage.get(key);
      x.cited++;
      if (s["Names you"]) x.namesYou = true;
    }
    pages.push({
      key: "sources", title: "Sources", citedTotal: cited.length, read: S.length, kinds, sites,
      pagesCited: [...byPage.values()].sort((a, b) => b.cited - a.cited || String(a.title).localeCompare(String(b.title))).slice(0, 6),
      gaps: board.gapSites,
    });
  }

  /* ---------- page 5: kinds of answer and products ---------- */
  if (want.has("products")) {
    const kindRows = ["Shopping", "Informational", "Images", "From memory", "Local"].map((label) => {
      const list = A.filter((a) => a["Kind of answer"] === label);
      if (!list.length) return null;
      const sum = (col) => list.reduce((s, a) => s + (Number(a[col]) || 0), 0);
      return {
        label, answers: list.length, searched: pct(list.filter((a) => a["Searched web"] === 1).length, list.length),
        named: pct(sum("You named"), list.length), citesOwn: pct(sum("Cites your site"), list.length),
        cardShare: sum("Product cards") ? pct(sum("Your cards"), sum("Product cards")) : null,
      };
    }).filter(Boolean);
    const cardShare = brands.map((b) => ({ name: b.name, isOwn: !!b.isOwn, share: pct(P.filter((p) => p.Brand === b.name).length, P.length) }))
      .filter((x) => x.share > 0 || x.isOwn).sort((a, b) => (b.isOwn ? 1 : 0) - (a.isOwn ? 1 : 0) || b.share - a.share);
    const mine = P.filter((p) => p.Yours === 1);
    const dest = new Map();
    mine.forEach((p) => { const d = p["Card sends buyers to"] || "No store named"; dest.set(d, (dest.get(d) || 0) + 1); });
    const byProduct = new Map();
    for (const p of P) {
      const key = String(p.Product).toLowerCase();
      if (!byProduct.has(key)) byProduct.set(key, { name: p.Product, brand: p.Brand, cards: 0, pos: [], prices: [], dest: new Map(), brandStore: 0 });
      const x = byProduct.get(key);
      x.cards++;
      x.pos.push(p["Card position"]);
      if (typeof p.Price === "number") x.prices.push({ amount: p.Price, currency: p.Currency || null });
      if (p["Card sends buyers to"]) x.dest.set(p["Card sends buyers to"], (x.dest.get(p["Card sends buyers to"]) || 0) + 1);
      const stores = O.filter((o) => o["Answer ID"] === p["Answer ID"] && o.Product === p.Product).map((o) => o.Store);
      if (stores.some((s) => isBrandStore(s, p.Brand, domOf(p.Brand)))) x.brandStore++;
    }
    const byImgHost = new Map();
    for (const im of I) {
      const host = im["Image from"] || "unknown";
      if (!byImgHost.has(host)) byImgHost.set(host, { site: host, images: 0, shows: new Set(), proxied: !!im["Served by the engine"] });
      const x = byImgHost.get(host);
      x.images++;
      if (im["Brand shown"]) x.shows.add(im["Brand shown"]);
    }
    pages.push({
      key: "products", title: "Kinds of answer and products", kinds: kindRows,
      cardsTotal: P.length, cardShare,
      destinations: [...dest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, c]) => ({ name, pct: pct(c, mine.length), own: isBrandStore(name, OWN, ownDom) })),
      products: [...byProduct.values()].sort((a, b) => b.cards - a.cards || avg(a.pos) - avg(b.pos)).slice(0, 6).map((x) => ({
        name: x.name, brand: x.brand, isOwn: sameName(x.brand, OWN), cards: x.cards, avgPos: avg(x.pos), ...(() => { const a = averageByCurrency(x.prices)[0]; return { avgPrice: a ? a.average : null, avgCurrency: a ? a.currency : null }; })(),
        dest: [...x.dest.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)[0] || "", brandStore: pct(x.brandStore, x.cards),
      })),
      images: [...byImgHost.values()].sort((a, b) => b.images - a.images).slice(0, 5).map((x) => ({
        site: x.site, kind: x.proxied ? "The engine’s own copy" : siteKindOf(x.site, siteCtx), images: x.images, shows: [...x.shows].join(", "),
      })),
      imagesTotal: I.length,
    });
  }

  /* ---------- page 6: searches ---------- */
  if (want.has("searches")) {
    const perEngine = engines.map((e) => {
      const ans = A.filter((a) => a.Engine === e.label);
      const qs = Q.filter((q) => q.Engine === e.label);
      const share = (col) => pct(qs.filter((q) => q[col] === 1).length, qs.length);
      return {
        engine: e.label, answers: ans.length, searches: qs.length, perAnswer: ans.length ? qs.length / ans.length : 0,
        web: qs.filter((q) => q["Kind of search"] === "Web").length, shopping: qs.filter((q) => q["Kind of search"] === "Shopping").length, image: qs.filter((q) => q["Kind of search"] === "Image").length,
        avgWords: avg(qs.map((q) => q.Words)), nameBrand: share("Names a brand"), year: share("Has a year"), reddit: share("Asks Reddit"),
        // Gemini doesn't publish its searches; say so rather than print zeros.
        hidden: !qs.length && ans.some((a) => a["Searched web"] === 1),
      };
    });
    const byText = new Map();
    for (const q of Q) {
      const key = String(q["Search text"]).toLowerCase();
      if (!byText.has(key)) byText.set(key, { text: q["Search text"], times: 0, engines: new Set(), ledToOwn: false });
      const x = byText.get(key);
      x.times++;
      x.engines.add(q.Engine);
      if ((ansById.get(q["Answer ID"]) || {})["Cites your site"] === 1) x.ledToOwn = true;
    }
    pages.push({
      key: "searches", title: "Engine searches", total: Q.length, perAnswer: n ? Q.length / n : 0, perEngine,
      top: [...byText.values()].sort((a, b) => b.times - a.times || a.text.localeCompare(b.text)).slice(0, 14).map((x) => ({ text: x.text, times: x.times, engines: [...x.engines].join(", "), ledToOwn: x.ledToOwn })),
      ownSite: !!ownDom,
    });
  }

  /* ---------- page 7: method ----------
     Until 0.59.0 this page opened with "Where to act next": four lines of
     advice worked out from the numbers ("Get onto …", "List the store on
     product feeds", "Watch Gemini"). The owner asked for the data without
     the advice, so the page keeps only how the numbers are measured, the
     runs and the prompt list. */
  if (want.has("method")) {
    const runRows = runsWith.map((r, i) => {
      const list = records.filter((x) => x.geo && x.geo.runId === r.id);
      return { label: `Run ${i + 1}`, date: dayLabel(r.startedAt || 0), answers: list.length, searched: pct(list.filter((x) => x.searched || (x.sources || []).length).length, list.length), ...brandNumbers(list, profile, brands, OWN), current: r.id === run.id };
    });
    const kindOf = new Map();
    A.forEach((a) => { const m = kindOf.get(a["Prompt ID"]) || new Map(); m.set(a["Kind of answer"], (m.get(a["Kind of answer"]) || 0) + 1); kindOf.set(a["Prompt ID"], m); });
    pages.push({
      key: "method", title: "Method", definitions: REPORT_DEFINITIONS, runs: runRows,
      prompts: F.prompts.map((p) => ({ id: p.id, text: p.text, tags: p.tags, kind: kindOf.has(p.id) ? [...kindOf.get(p.id).entries()].sort((a, b) => b[1] - a[1])[0][0] : "" })),
    });
  }

  const engineNames = engines.map((e) => e.label);
  return {
    ok: true,
    campaign: profile.name || "Campaign",
    own: { name: OWN, domain: ownDom },
    competitors: rivals.filter((b) => !b.auto).map((b) => b.name),
    run: { label: runLabel, no: runNo, of: runsWith.length, date: dayLabel(run.startedAt || 0), previous: prevLabel },
    runDates: runsWith.map((r) => dayLabel(r.startedAt || 0)),
    engines: engineNames,
    lede: `How ${listOf(engineNames)} answered ${plural(activePrompts.length, "prompt")} in ${runWord}, and where ${OWN} showed up.`,
    answers: { run: n, all: records.filter((x) => x.geo && runsWith.some((r) => r.id === x.geo.runId)).length },
    generatedAt,
    pages,
  };
}
