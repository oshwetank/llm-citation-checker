/*
 * campaignView.js — the campaign board as the 0.64.0 canvas lays it out.
 *
 * The owner asked for a board that opens with share of voice, visibility,
 * position, mentions and responses, then breaks them down engine by engine,
 * then goes deeper: a leaderboard, a head-to-head against any rival, every
 * citation in detail, prompt rankings, products and topics, the searches the
 * engines ran (site: included), ads, and signals about the data itself.
 *
 * Campaigns are run by hand, not daily, so everything here is about one run
 * (or all runs combined): no trends that need a calendar. Numbers are over
 * the answers that came back with text; a prompt an engine never answered
 * (Grok's usage limit in the owner's Motorola run) is counted under data
 * quality instead of as an answer that named nobody.
 *
 * Asked not to: say which source led to which brand being named. A page being
 * cited doesn't show which brand it was cited for, so citations here carry
 * the answer's context (your place in it, who came first), never a link
 * from a page to a brand.
 *
 * Pure: the background calls it over full records and the panel draws it.
 */
import { wordRe } from "./textMatch.js";
import { hasPrice } from "./money.js";
import { computeMetrics, normName, usageLimitOf } from "./geo.js";
import { ranksIn, cardIsBrand, ENGINE_ORDER } from "./campaignBoard.js";
import { siteKindOf, normDomain } from "./siteKind.js";
import { answerKind, adsView, resultPositions } from "./analyzeView.js";
import { parseQueryOperators } from "./fanout.js";

const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pctOf = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const answered = (r) => (r.answerChars || 0) > 0;
const queriesOf = (rec) => ["search", "shopping", "image"].flatMap((lane) => (((rec.fanout || {})[lane]) || [])
  .map((q) => ({ lane, text: String(typeof q === "string" ? q : (q && q.query) || "").trim() }))).filter((q) => q.text);
const countBy = (xs, f) => xs.reduce((m, x) => { const k = f(x); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());

/**
 * A prompt the page typed twice ("best phonebest phone", the 0.62.2 bug) is
 * stored as typed; for grouping and display it reads as the prompt it was.
 */
export function promptText(p) {
  const s = String(p || "").trim();
  const h = s.length / 2;
  return s.length % 2 === 0 && h > 0 && s.slice(0, h) === s.slice(h) ? s.slice(0, h) : s;
}

/**
 * What kind of page a cited URL is, from its address alone. The engines lean
 * on "best X under Y" lists far more than on reviews or shop pages, and
 * this is how that shows up.
 */
export function pageTypeOf(url) {
  let p = "";
  try { p = new URL(url).pathname.toLowerCase(); } catch (_) { return "Article"; }
  if (p === "/" || p === "") return "Homepage";
  if (/-vs-|\/vs\/|compare|comparison/.test(p)) return "Comparison";
  // Shop pages in any market: /dp/, /p/, /item/, /products/, /shop/, "-price".
  if (/\/dp\/|\/p\/|\/products?\b|\/item\/|\/itm\/|\/shop\/|\/buy\/|\/sku\/|-price(?:-in-[a-z-]+)?(?:[/.]|$)/.test(p)) return "Product page";
  if (/\/news\/|articleshow|\/story\/|\/press(?:-releases?)?\/|\/noticias\/|\/actualites\//.test(p)) return "News";
  if (/review/.test(p) && !/best|top-|list/.test(p)) return "Review";
  if (/best|top-|list-of|under-|guide/.test(p)) return "List of picks";
  if (/forum|thread|\/r\/|\/comments\//.test(p)) return "Discussion";
  return "Article";
}

// When the prompts carry no tags, group them by what they ask for. These
// are intents, not product features, so they fit any brand: a phone, a
// payroll tool, a bank, a city council (0.69.0; the phone-only themes
// before it put most B2B and public-sector prompts under "Other"). The ids
// are the ones the built-in AI uses, so the two never disagree. The first
// match wins; the order puts the narrow asks before the broad "best".
export const THEMES = [
  ["comparison", "Comparisons & alternatives", /\bvs\.?\b|\bversus\b|\bcompar|\balternatives?\b|\binstead of\b|\bcompetitors?\b|\bdifference between\b|\bor\s+[\p{L}\d]+\s*\?|\bfrente a\b|\bcomparação\b|\bcomparatif\b|\bvergleich|तुलना|比較|对比|مقارنة/iu],
  ["local", "Local & near me", /\bnear me\b|\bnearby\b|\bclosest\b|\bopen now\b|\bnear\s+[\p{Lu}]|\bcerca de mí|\bperto de mim\b|\bprès de chez moi\b|\bin der nähe\b|मेरे पास|近く|附近|بالقرب/iu],
  ["price_value", "Price, cost & value", /\bcheap|\bbudget\b|\baffordable\b|\bvalue for money\b|\bprice|\bpricing\b|\bcost|\bfees?\b|\bdeals?\b|\bunder\s*\S?\d|\bbelow\s*\S?\d|\bfree\b|\bprecio|\bbarato|\bpreço|\bprix\b|\bpas cher\b|\bpreis|\bgünstig|कीमत|सस्ता|価格|安い|价格|便宜|سعر|رخيص/iu],
  ["trust", "Trust, safety & compliance", /\bsafe\b|\bsafety\b|\bsecur|\btrust|\blegit|\bscam|\breliab|\bcomplian|\bcertif|\bgdpr\b|\bhipaa\b|\biso\s?\d|\bregulat|\bprivacy\b|\bwarranty\b|\blicen[cs]ed\b|\bseguro\b|\bconfiable\b|\bconfiável\b|\bfiable\b|\bsicher|सुरक्षित|安全|安心|آمن/iu],
  ["careers", "Jobs & careers", /\bjobs?\b|\bcareers?\b|\bhiring\b|\bsalar(y|ies)\b|\bwork at\b|\binternships?\b|\bemployers?\b|\bempleo\b|\bemprego\b|\bemploi\b|\bstellen|नौकरी|求人|招聘|وظائف/iu],
  ["howto", "How-to & information", /\bhow (?:to|do|does|can|much|many)\b|\bwhat (?:is|are)\b|\bwhy\b|\bguide\b|\btutorial\b|\bexplain|\bsteps?\b|\bmeaning\b|\bcómo\b|\bqué es\b|\bcomo\b|\bo que é|\bcomment\b|\bqu'est-ce\b|\bwie\b|\bwas ist\b|कैसे|क्या है|方法|とは|如何|什么是|كيف|ما هو/iu],
  ["for_use", "For a person or use", /\bfor\s+(?:a\s+|an\s+|my\s+|the\s+)?(?!\d)[\p{L}]{3,}|\bpara\s+[\p{L}]{3,}|\bpour\s+[\p{L}]{3,}|\bfür\s+[\p{L}]{3,}|के लिए|向け|适合|لل/iu],
  ["best_top", "Best, top & reviews", /\bbest\b|\btop\b|\breviews?\b|\bratings?\b|\brecommend|\bleading\b|\bpopular\b|\bmejor|\bmelhor|\bmeilleur|\bbeste|सबसे अच्छा|बेस्ट|おすすめ|最好|推荐|أفضل/iu],
];
export const THEME_OTHER = ["other", "Other"];
export function themeIdOf(text) {
  const hit = THEMES.find(([, , re]) => re.test(String(text || "")));
  return hit ? hit[0] : THEME_OTHER[0];
}
export function themeLabel(id) {
  const hit = THEMES.find(([k]) => k === id);
  return hit ? hit[1] : THEME_OTHER[1];
}
export function themeOf(text) {
  return themeLabel(themeIdOf(text));
}

const AGE_BANDS = [["Under a month", 31], ["1–3 months", 92], ["3–6 months", 183], ["6–12 months", 366], ["Over a year", Infinity]];

/**
 * @param {object[]} recs  the answers in view (one per prompt, engine and run)
 * @param {object} o  profile, brands (own flagged), prompts (tracked prompts),
 *   engineFilter (engines the board is limited to)
 */
export function campaignView(recs, { profile, brands, prompts = [], engineFilter = [], asked = null } = {}) {
  const own = brands.find((b) => b.isOwn) || brands[0] || { name: "" };
  const rivals = brands.filter((b) => b !== own);
  const engines = ENGINE_ORDER.filter((e) => (recs.some((r) => r.platform === e) || ((profile && profile.engines) || []).includes(e))
    && (!engineFilter.length || engineFilter.includes(e)));
  const ok = recs.filter(answered);
  const byEngine = (list, e) => list.filter((r) => r.platform === e);
  const metrics = (list) => {
    const m = computeMetrics(list, profile, brands);
    return Object.fromEntries(m.brands.map((b) => [b.name, {
      sov: r1(b.shareOfVoice), vis: r1(b.visibility), pos: r1(b.avgPosition), mentions: b.mentions, present: b.responsesPresent,
    }]));
  };
  const all = metrics(ok);
  const perEngine = Object.fromEntries(engines.map((e) => { const l = byEngine(ok, e); return [e, l.length ? metrics(l) : null]; }));

  // Each answer's brand order, computed once.
  const orderOf = new Map(ok.map((r) => {
    const { rank } = ranksIn(r, brands);
    const names = brands.filter((b) => rank.has(normName(b.name))).sort((a, b) => rank.get(normName(a.name)) - rank.get(normName(b.name))).map((b) => b.name);
    return [r, names];
  }));
  const placeOf = (r, name) => { const o = orderOf.get(r) || []; const i = o.indexOf(name); return i >= 0 ? i + 1 : null; };
  const firstOf = (r) => (orderOf.get(r) || [])[0] || null;

  // ---- prompts (rows by prompt, cells by engine)
  const promptKey = (r) => (r.geo && r.geo.promptId) || promptText(r.userPrompt);
  const promptMeta = new Map(prompts.map((p) => [p.id, p]));
  const pmap = new Map();
  for (const r of recs) {
    const k = promptKey(r);
    if (!pmap.has(k)) {
      const meta = promptMeta.get(k);
      const text = promptText((meta && meta.text) || r.userPrompt);
      pmap.set(k, { id: k, text, tags: (meta && meta.tags) || [], cells: {}, queries: [] });
    }
    const p = pmap.get(k);
    const prev = p.cells[r.platform];
    if (prev && prev.answered && !answered(r)) continue;
    p.cells[r.platform] = answered(r)
      ? { answered: true, pos: placeOf(r, own.name), first: firstOf(r), captureId: r.captureId || null, rec: r }
      : { answered: false, limit: !!usageLimitOf(r), captureId: r.captureId || null };
    for (const q of queriesOf(r)) if (!p.queries.some((x) => x.text === q.text && x.engine === r.platform)) p.queries.push({ engine: r.platform, ...q });
  }
  const useTags = [...pmap.values()].some((p) => p.tags.length);
  const topicOf = (p) => (useTags ? (p.tags[0] || "Untagged") : themeOf(p.text));
  const promptRows = [...pmap.values()].map((p) => {
    const cells = engines.map((e) => p.cells[e] || null);
    const done = cells.filter((c) => c && c.answered);
    const named = done.filter((c) => c.pos);
    const topCard = done.flatMap((c) => c.rec.products || []).find((c) => cardIsBrand(c, own.name));
    return {
      id: p.id, text: p.text, tags: p.tags, topic: topicOf(p), topicId: useTags ? null : themeIdOf(p.text),
      cells: cells.map((c) => (c ? { answered: c.answered, limit: !!c.limit, pos: c.pos || null, first: c.first || null, captureId: c.captureId } : null)),
      visibility: done.length ? pctOf(named.length, done.length) : null,
      avgPos: named.length ? r1(named.reduce((s, c) => s + c.pos, 0) / named.length) : null,
      firsts: [...new Set(done.map((c) => c.first).filter(Boolean))],
      topProduct: topCard ? topCard.name : null,
      queries: p.queries,
    };
  }).sort((a, b) => (b.visibility ?? -1) - (a.visibility ?? -1) || (a.avgPos ?? 99) - (b.avgPos ?? 99));
  const topicByAnswer = new Map();
  for (const p of pmap.values()) for (const c of Object.values(p.cells)) if (c.rec) topicByAnswer.set(c.rec, topicOf(p));

  // ---- overview
  // What was asked, not only what came back (1.0.2): a turn that failed left
  // no record, so a partial run read "12 answers from 12 prompts sent" and
  // ChatGPT "2/2" when 15 went out and ChatGPT was asked 5 (live campaign,
  // 22 Nov 2026). `asked` is the shown run's own plan (the one "Retry
  // missing" reads), engine by engine; without it, what was stored.
  const engineRows = engines.map((e) => {
    const sent = byEngine(recs, e), got = byEngine(ok, e);
    const firsts = countBy(got.map(firstOf).filter(Boolean), (x) => x);
    const top = [...firsts].sort((a, b) => b[1] - a[1])[0];
    const limited = sent.filter((r) => !answered(r) && usageLimitOf(r)).length;
    const planned = asked && Number.isFinite(asked[e]) ? asked[e] : 0;
    return {
      id: e, label: ENGINE_LABEL[e], sent: Math.max(sent.length, planned), answered: got.length, limited,
      own: perEngine[e] ? perEngine[e][own.name] : null,
      searches: got.reduce((n, r) => n + queriesOf(r).length, 0),
      read: got.reduce((n, r) => n + (r.sources || []).length, 0),
      cited: got.reduce((n, r) => n + (r.sources || []).filter((s) => s.outcome === "cited").length, 0),
      firstMost: top ? { name: top[0], n: top[1] } : null,
    };
  });
  const rankOn = (key, low) => {
    const list = Object.entries(all).filter(([, m]) => m[key] != null).sort((a, b) => (low ? a[1][key] - b[1][key] : b[1][key] - a[1][key]));
    const i = list.findIndex(([n]) => n === own.name);
    return i >= 0 ? { rank: i + 1, of: list.length } : null;
  };
  const split = (key) => engines.map((e) => ({ engine: e, value: perEngine[e] ? perEngine[e][own.name][key] : null }));
  const o = all[own.name] || {};
  const overview = {
    own: own.name, sent: Math.max(recs.length, engineRows.reduce((n, x) => n + x.sent, 0)), answered: ok.length,
    kpis: [
      { id: "sov", label: "Share of voice", value: o.sov ?? 0, unit: "%", ...rankOn("sov"), split: split("sov") },
      { id: "vis", label: "Visibility", value: o.vis ?? 0, unit: "%", ...rankOn("vis"), split: split("vis") },
      { id: "pos", label: "Average position", value: o.pos, unit: "", ...rankOn("pos", true), split: split("pos") },
      { id: "mentions", label: "Mentions", value: o.mentions ?? 0, unit: "", ...rankOn("mentions"), split: split("mentions") },
      { id: "responses", label: "Responses", value: ok.length, unit: "", of: Math.max(recs.length, engineRows.reduce((n, x) => n + x.sent, 0)), split: engineRows.map((x) => ({ engine: x.id, value: x.answered, of: x.sent })) },
    ],
    engines: engineRows,
  };

  // ---- brands
  const firstsIn = (list) => Object.fromEntries([...countBy(list.map(firstOf).filter(Boolean), (x) => x)]);
  const autoOf = new Set(brands.filter((b) => b.auto).map((b) => b.name));
  const board = (m, list) => Object.entries(m).map(([name, x]) => ({ name, isOwn: name === own.name, auto: autoOf.has(name), ...x, firsts: firstsIn(list)[name] || 0 }))
    .sort((a, b) => b.sov - a.sov || b.vis - a.vis);
  const brandsSection = {
    all: board(all, ok),
    byEngine: Object.fromEntries(engines.map((e) => [e, perEngine[e] ? board(perEngine[e], byEngine(ok, e)) : null])),
    grid: Object.entries(all).sort((a, b) => b[1].vis - a[1].vis).map(([name, m]) => ({ name, isOwn: name === own.name, all: m.vis, cells: engines.map((e) => (perEngine[e] ? perEngine[e][name].vis : null)) })),
  };

  // ---- products (cards)
  const pm = new Map();
  for (const r of ok) (r.products || []).forEach((c, i) => {
    const name = String(c.name || "").trim(); if (!name) return;
    const b = brands.find((x) => cardIsBrand(c, x.name));
    const k = name.toLowerCase();
    const x = pm.get(k) || { name, brand: b ? b.name : null, cards: 0, first: 0, engines: new Set() };
    x.cards++; if (i === 0) x.first++; x.engines.add(r.platform); pm.set(k, x);
  });
  const productRows = [...pm.values()].sort((a, b) => b.cards - a.cards || b.first - a.first).map((x) => ({ ...x, engines: [...x.engines] }));
  const cardsBy = (name) => productRows.filter((p) => p.brand === name).reduce((s, p) => s + p.cards, 0);
  const firstCardsBy = (name) => productRows.filter((p) => p.brand === name).reduce((s, p) => s + p.first, 0);
  const cardTotal = productRows.reduce((s, p) => s + p.cards, 0);
  const products = {
    rows: productRows.slice(0, 30), total: cardTotal, answersWithCards: ok.filter((r) => (r.products || []).length).length,
    share: brands.map((b) => ({ name: b.name, isOwn: b === own, cards: cardsBy(b.name), first: firstCardsBy(b.name), pct: pctOf(cardsBy(b.name), cardTotal) }))
      .filter((x) => x.cards).sort((a, b) => b.cards - a.cards),
  };

  // ---- topics
  const topicNames = [...new Set(promptRows.map((p) => p.topic))];
  const topics = topicNames.map((t) => {
    const list = ok.filter((r) => topicByAnswer.get(r) === t);
    const m = list.length ? metrics(list) : null;
    const rival = m ? Object.entries(m).filter(([n]) => n !== own.name).sort((a, b) => b[1].sov - a[1].sov)[0] : null;
    return { topic: t, prompts: promptRows.filter((p) => p.topic === t).length, answers: list.length, own: m ? m[own.name] : null, rival: rival ? { name: rival[0], ...rival[1] } : null, all: m };
  }).filter((t) => t.answers).sort((a, b) => b.answers - a.answers);

  // ---- searches, site:
  const allQ = recs.flatMap((r) => queriesOf(r).map((q) => ({ ...q, engine: r.platform, prompt: promptText(r.userPrompt), answered: answered(r) })));
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const promptsSent = (e) => new Set(byEngine(recs, e).map(promptKey)).size;
  const searchStats = engines.map((e) => {
    const qs = allQ.filter((q) => q.engine === e); const n = qs.length; const has = (re) => pctOf(qs.filter((q) => (typeof re === "function" ? re(q.text) : re.test(q.text))).length, n);
    return {
      // Gemini doesn't publish the searches it runs: none captured is not none run.
      engine: e, label: ENGINE_LABEL[e], published: e !== "gemini" || n > 0, n, perPrompt: promptsSent(e) ? r1(n / promptsSent(e)) : 0,
      avgWords: n ? r1(qs.reduce((s, q) => s + words(q.text), 0) / n) : 0,
      unanswered: qs.filter((q) => !q.answered).length,
      traits: [
        ["price", "Price or budget", has((q) => hasPrice(q) || /\bprice\b|\bunder\b|\bbudget\b|\bcheap|\bcost\b/i.test(q))],
        ["year", "Says the year", has(/\b20\d\d\b/)],
        ["month", "Says the month", has(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)],
        ["brand", "Names a brand", pctOf(qs.filter((q) => brands.some((b) => wordRe(b.name, "i").test(q.text))).length, n)],
        ["review", "Reviews or \"vs\"", has(/review|\bvs\b|versus|compar/i)],
        ["site", "Uses site:", has(/\bsite:/i)],
      ].map(([id, label, pct]) => ({ id, label, pct })),
    };
  });
  const brandInQueries = brands.map((b) => ({ name: b.name, isOwn: b === own, n: allQ.filter((q) => wordRe(b.name, "i").test(q.text)).length }))
    .filter((x) => x.n).sort((a, b) => b.n - a.n);
  const ownDomain = normDomain((own.url || "").replace(/^https?:\/\//, "").split("/")[0]);
  const citedDomainsFor = (prompt, engine) => new Set(ok.filter((r) => r.platform === engine && promptText(r.userPrompt) === prompt)
    .flatMap((r) => (r.sources || []).filter((s) => s.outcome === "cited").map((s) => normDomain(s.domain || s.url))));
  const siteSearches = allQ.map((q) => ({ q, ops: parseQueryOperators(q.text) })).filter((x) => x.ops.siteIncludes.length || x.ops.siteExcludes.length)
    .map(({ q, ops }) => {
      const cited = q.answered ? citedDomainsFor(q.prompt, q.engine) : null;
      return { engine: q.engine, text: q.text, prompt: q.prompt, answered: q.answered, include: ops.siteIncludes, exclude: ops.siteExcludes,
        laterCited: cited ? ops.siteIncludes.filter((d) => [...cited].some((c) => c === d || c.endsWith("." + d))) : null };
    });
  const siteDomains = [...countBy(siteSearches.flatMap((s) => s.include), (d) => d)].sort((a, b) => b[1] - a[1]).map(([domain, n]) => ({ domain, n, own: !!ownDomain && (domain === ownDomain || domain.endsWith("." + ownDomain)) }));
  const examplePrompt = promptRows.filter((p) => new Set(p.queries.map((q) => q.engine)).size >= Math.min(3, engines.length))
    .sort((a, b) => b.queries.length - a.queries.length)[0] || null;
  const searches = {
    total: allQ.length, byEngine: searchStats, brands: brandInQueries,
    example: examplePrompt ? { prompt: examplePrompt.text, byEngine: engines.map((e) => ({ engine: e, queries: examplePrompt.queries.filter((q) => q.engine === e).map((q) => q.text).slice(0, 4) })).filter((x) => x.queries.length) } : null,
    site: { count: siteSearches.length, rows: siteSearches, domains: siteDomains, ownTargeted: siteDomains.some((d) => d.own), byEngine: engines.map((e) => ({ engine: e, n: siteSearches.filter((s) => s.engine === e).length, of: allQ.filter((q) => q.engine === e).length })) },
  };

  // ---- citations
  const kindCtx = { ownBrand: own.name, ownUrl: own.url || "", brands: brands.map((b) => b.name) };
  const citedRows = [];
  for (const r of ok) {
    const cited = (r.sources || []).filter((s) => s.outcome === "cited");
    const ranks = resultPositions(r);
    cited.forEach((s, i) => {
      const domain = normDomain(s.domain || s.url);
      if (!domain) return;
      const ps = s.platformSpecific || {};
      const pub = typeof ps.pubDate === "number" && ps.pubDate > 0 ? (ps.pubDate < 1e12 ? ps.pubDate * 1000 : ps.pubDate) : null;
      citedRows.push({
        url: String(s.url || "").replace(/#.*$/, ""), domain, title: String(s.title || "").replace(/^\S+ › .*?› \S*?(?=[A-Z])/, "").trim() || domain,
        snippet: String(s.snippet || "").replace(/\s+/g, " ").slice(0, 280),
        kind: siteKindOf(domain, kindCtx), pageType: pageTypeOf(s.url),
        engine: r.platform, prompt: promptText(r.userPrompt), promptId: promptKey(r), captureId: r.captureId || null,
        n: i + 1, of: cited.length, read: (r.sources || []).length,
        rank: r.platform === "chatgpt" ? (ranks.get(s.url) || null) : null,
        lane: ps.resultSource || ps.refType || (r.platform === "perplexity" ? "search" : null),
        published: pub, at: r.capturedAt || null,
        ownPlace: placeOf(r, own.name), first: firstOf(r), answerKind: answerKind(r).id,
      });
    });
  }
  const pageTimes = countBy(citedRows, (c) => c.url);
  const siteEngines = new Map();
  citedRows.forEach((c) => { const k = c.promptId + "|" + c.domain; const s = siteEngines.get(k) || new Set(); s.add(c.engine); siteEngines.set(k, s); });
  citedRows.forEach((c) => { c.times = pageTimes.get(c.url); c.bothEngines = siteEngines.get(c.promptId + "|" + c.domain).size > 1; });
  const latest = Math.max(0, ...ok.map((r) => r.capturedAt || 0));
  const dated = citedRows.filter((c) => c.published);
  const ages = dated.map((c) => (latest - c.published) / 864e5).sort((a, b) => a - b);
  const mix = (m) => [...m].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n, pct: pctOf(n, citedRows.length) }));
  const citations = {
    rows: citedRows, total: citedRows.length,
    pages: new Set(citedRows.map((c) => c.url)).size, sites: new Set(citedRows.map((c) => c.domain)).size,
    bothEngines: citedRows.filter((c) => c.bothEngines).length,
    ownSite: citedRows.filter((c) => c.kind === "Your site").length,
    medianAgeDays: ages.length ? Math.round(ages[ages.length >> 1]) : null,
    byEngine: engines.map((e) => ({ engine: e, n: citedRows.filter((c) => c.engine === e).length })),
    pageTypes: mix(countBy(citedRows, (c) => c.pageType)),
    kinds: mix(countBy(citedRows, (c) => c.kind)),
    freshness: [...AGE_BANDS.map(([label, max], i) => ({ label, n: ages.filter((d) => d < max && d >= (i ? AGE_BANDS[i - 1][1] : -Infinity)).length })), { label: "No date sent", n: citedRows.length - dated.length }],
    lanes: mix(countBy(citedRows, (c) => `${ENGINE_LABEL[c.engine]} ${c.lane === "news" ? "news results" : c.lane ? (c.lane === "search" ? "search" : c.lane) : "(not sent)"}`)),
  };

  // ---- sources (by site)
  const sm = new Map();
  for (const c of citedRows) {
    const x = sm.get(c.domain) || { domain: c.domain, kind: c.kind, citations: 0, answers: new Set(), engines: new Set() };
    x.citations++; x.answers.add(c.captureId || c.prompt + c.engine); x.engines.add(c.engine); sm.set(c.domain, x);
  }
  const pageMap = new Map();
  citedRows.forEach((c) => { const x = pageMap.get(c.url) || { url: c.url, title: c.title, domain: c.domain, citations: 0 }; x.citations++; pageMap.set(c.url, x); });
  const sources = {
    total: citedRows.length, sites: sm.size,
    domains: [...sm.values()].sort((a, b) => b.citations - a.citations).map((x) => ({ domain: x.domain, kind: x.kind, citations: x.citations, answers: x.answers.size, pct: pctOf(x.answers.size, ok.length), engines: [...x.engines] })),
    pages: [...pageMap.values()].sort((a, b) => b.citations - a.citations).slice(0, 15),
    read: ok.reduce((n, r) => n + (r.sources || []).length, 0),
  };

  // ---- compare: own brand against each rival
  const compare = Object.fromEntries(rivals.map((rv) => {
    let both = 0, onlyMe = 0, onlyThem = 0, neither = 0, meFirst = 0, themFirst = 0;
    for (const r of ok) {
      const a = placeOf(r, own.name), b = placeOf(r, rv.name);
      if (a && b) { both++; a < b ? meFirst++ : themFirst++; } else if (a) onlyMe++; else if (b) onlyThem++; else neither++;
    }
    const firstCount = (n) => ok.filter((r) => firstOf(r) === n).length;
    const side = (n) => ({ ...(all[n] || {}), firsts: firstCount(n), cards: cardsBy(n), firstCards: firstCardsBy(n), inQueries: (brandInQueries.find((x) => x.name === n) || { n: 0 }).n });
    const quotes = (n) => ok.flatMap((r) => (r.brandMentions || []).filter((m) => normName(m.brand).startsWith(normName(n)) && (m.passages || [])[0])
      .map((m) => { const s = m.passages[0].replace(/[#*|]+/g, " ").replace(/\s+/g, " ").trim(); const i = s.toLowerCase().indexOf(n.toLowerCase());
        return { engine: r.platform, prompt: promptText(r.userPrompt), text: s.slice(Math.max(0, i - 40), i + 170).trim(), captureId: r.captureId || null }; })).slice(0, 3);
    return [rv.name, {
      name: rv.name, me: side(own.name), them: side(rv.name),
      together: { answers: ok.length, both, onlyMe, onlyThem, neither, meFirst, themFirst },
      engines: engines.map((e) => ({ engine: e, answers: byEngine(ok, e).length, me: perEngine[e] ? perEngine[e][own.name] : null, them: perEngine[e] ? perEngine[e][rv.name] : null })),
      topics: topics.map((t) => ({ topic: t.topic, answers: t.answers, me: t.all ? t.all[own.name] : null, them: t.all ? t.all[rv.name] : null })),
      prompts: promptRows.map((p) => ({ id: p.id, text: p.text, cells: engines.map((e) => {
        const c = pmap.get(p.id).cells[e];
        return c ? (c.answered ? { me: c.pos || null, them: placeOf(c.rec, rv.name), captureId: c.captureId } : { noAnswer: true }) : null;
      }) })),
      products: { me: productRows.filter((x) => x.brand === own.name).slice(0, 5), them: productRows.filter((x) => x.brand === rv.name).slice(0, 5) },
      quotes: { me: quotes(own.name), them: quotes(rv.name) },
    }];
  }));

  // ---- ads
  const adRecs = ok.filter((r) => (r.ads || []).length);
  const adRows = adRecs.flatMap((r) => adsView(r, { knownBrands: brands.map((b) => b.name) }).map((a) => ({ ...a, engine: r.platform, prompt: promptText(r.userPrompt), captureId: r.captureId || null, ownPlace: placeOf(r, own.name) })));
  const sameAs = (adv, name) => normName(adv).startsWith(normName(name));
  const advertisers = [...countBy(adRows, (a) => a.advertiser)].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({
    name, n, domain: (adRows.find((a) => a.advertiser === name) || {}).domain || "",
    isOwn: sameAs(name, own.name), isRival: rivals.some((b) => sameAs(name, b.name)),
    prompts: new Set(adRows.filter((a) => a.advertiser === name).map((a) => a.prompt)).size,
  }));
  const adEngines = engines.filter((e) => e === "chatgpt");
  const ads = {
    answers: adEngines.reduce((n, e) => n + byEngine(ok, e).length, 0), withAd: adRecs.length,
    advertisers, rows: adRows,
    own: advertisers.filter((a) => a.isOwn).length, rival: advertisers.filter((a) => a.isRival).length,
    named: adRows.filter((a) => a.namedInAnswer).length, cited: adRows.filter((a) => a.siteCited).length,
    engines: adEngines,
  };

  // ---- signals
  const two = promptRows.filter((p) => p.cells.filter((c) => c && c.answered && c.first).length >= 2);
  const differ = two.filter((p) => new Set(p.cells.filter((c) => c && c.answered && c.first).map((c) => c.first)).size > 1)
    .map((p) => ({ text: p.text, firsts: engines.map((e, i) => ({ engine: e, first: p.cells[i] && p.cells[i].answered ? p.cells[i].first : null })) }));
  const gaps = promptRows.filter((p) => engines.some((e) => { const c = pmap.get(p.id).cells[e]; return c && c.answered && !c.pos && (orderOf.get(c.rec) || []).length >= 2; }))
    .map((p) => ({ text: p.text, id: p.id }));
  const doubled = (e) => byEngine(recs, e).filter((r) => promptText(r.userPrompt) !== String(r.userPrompt || "").trim()).length;
  const signals = {
    agreement: { same: two.length - differ.length, of: two.length, differ },
    breadth: engineRows.filter((e) => e.answered).map((e) => ({ engine: e.id, searches: r1(e.searches / e.answered), read: r1(e.read / e.answered), cited: r1(e.cited / e.answered), totals: { searches: e.searches, read: e.read, cited: e.cited } })),
    kinds: [...countBy(ok, (r) => answerKind(r).id)].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n })),
    ownSite: { citations: citations.ownSite, of: citations.total },
    gaps,
    firstCard: { own: firstCardsBy(own.name), of: products.answersWithCards },
    quality: engineRows.map((e) => ({ engine: e.id, sent: e.sent, answered: e.answered, limited: e.limited, missing: e.sent - e.answered, doubled: doubled(e.id) })),
  };

  return {
    own: own.name, engines, rivals: rivals.map((b) => b.name).sort((a, b) => (all[b] ? all[b].sov : 0) - (all[a] ? all[a].sov : 0)),
    overview, brands: brandsSection, compare, sources, citations,
    prompts: promptRows.map(({ queries, ...p }) => ({ ...p, queries: queries.map((q) => ({ engine: q.engine, text: q.text })) })),
    products, topics: topics.map(({ all: _a, ...t }) => t), searches, ads, signals,
  };
}
