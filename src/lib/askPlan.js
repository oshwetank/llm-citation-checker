/*
 * askPlan.js — a question as a fixed-form request, and the scope it is
 * about (1.0.5, Stage 1 of ASK-ARCHITECTURE.md §4.4–4.5).
 *
 * The rule pass fills the plan with no model: names from the catalog,
 * dates, measures, the shape of the question. resolveScope then decides
 * which collections (campaigns, "My questions"), runs, engines, tags and
 * prompts the answer is about, by fixed rules:
 *   1. named in the question wins;
 *   2. then where the user is (the campaign open on the page);
 *   3. a follow-up keeps the last scope and changes only what it names;
 *   4. a brand is a subject, not a scope (unless it is also the name of the
 *      only campaign tracking it);
 *   5. several candidates are scored; a clear winner (more than twice the
 *      next) is used, otherwise Ask asks back with the choices;
 *   6. measures use each engine's latest finished run, trends all runs;
 *   7. "battery prompts" is a tag first, then prompts whose wording matches;
 *   8. the scope is always returned so it can be shown and edited.
 * The model never decides any of this.
 */
import { lookup, fold, HISTORY_ID, ENGINES } from "./askCatalog.js";

export const INTENTS = ["metric", "rank", "compare", "trend", "gaps", "why", "find_answers", "sources", "searches", "cards", "define", "data_status", "not_recorded"];
export const MEASURES = ["visibility", "share_of_voice", "position", "mentions", "citations", "first_place"];
const DAY = 24 * 60 * 60 * 1000;

// The shapes of questions, in the six interface languages where the words
// differ (English, Spanish, Portuguese, French, Hindi, Arabic). First match wins.
const INTENT_RULES = [
  ["not_recorded", /\b(clicks?|traffic|visits?|visitors|impressions|ctr|spend|budget|revenue|sales figures|conversions?|backlinks?|serp|google rank(?:ing)?s?|organic rank)\b|clics|tr[aá]fico|tr[aá]fego|visitas|ingresos|receita|revenus|क्लिक|ट्रैफ़िक|نقرات|زيارات/i],
  ["define", /\b(what (?:does|do|is meant by) .{2,40} mean|what is (?:a |an |the )?(?:visibility|share of voice|sov|average position|position|mentions?|citations?|fan-?out)\b|define|definition of|meaning of|how is .{2,30} (?:counted|calculated|measured))|qu[eé] (?:es|significa)|o que (?:é|significa)|que veut dire|qu'est-ce que|का मतलब|ماذا يعني|ما معنى/i],
  ["data_status", /\b(data quality|missing data|failed|usage limits?|rate limit|how many answers (?:were )?captured|gaps in the data|signed out|not captured|errors?)\b/i],
  ["compare", /\b(vs\.?|versus|compare[ds]?|comparison|compared (?:with|to)|against|beating|beat us|better than|ahead of|head to head)\b|comparar|contra|comparer|तुलना|مقارنة/i],
  ["trend", /\b(trend|over time|since|across runs|run (?:by|to|over) run|week (?:by|over|on) week|month (?:by|over|on) month|changed?|history of|progress|improv(?:e|ed|ing)|declin(?:e|ed|ing))\b|tendencia|evoluci[oó]n|desde|tend[eê]ncia|evolu[cç][aã]o|tendance|[ée]volution|depuis|रुझान|اتجاه|منذ/i],
  ["why", /\b(why|reason|how come|what caused|dropp?ed|fell|went down|lost)\b|por qu[eé]|porque|pourquoi|क्यों|لماذا/i],
  ["gaps", /\b(gaps?|missing from|(?:are we|am i|is my brand|we'?re) missing|but not (?:us|me|ours?)|without us|absent|not (?:named|mentioned|cited)|never (?:named|mentioned|cited)|where (?:am i|are we|is my brand) not|get onto|should (?:we|i) (?:be|get) on|opportunit(?:y|ies))\b|ausente|lacunas?|absent|manquant|غائب/i],
  ["searches", /\b(fan-?out|searches|search queries|queries (?:the engines? )?(?:ran|run|used)|what did (?:they|the engines?) search)\b|b[uú]squedas|pesquisas|recherches/i],
  ["cards", /\b(product cards?|shopping cards?|cards|products? (?:shown|named|listed)|which products)\b|productos|produtos|produits/i],
  ["sources", /\b(sources?|sites? (?:cited|they cite|that cite)|which sites|domains?|websites? cited|cited (?:sites|pages|most)|links)\b|fuentes|sitios|fontes|sites|sources|स्रोत|مصادر/i],
  ["find_answers", /\b(show (?:me )?(?:the )?answers|which answers|what do (?:the )?(?:engines?|ais?|chatgpt|gemini|perplexity|grok) say|what did (?:i|we) ask|find answers|answers (?:that|which) (?:mention|name|say)|quote|example answers?)\b|mu[eé]strame|mostre|montre-moi/i],
  ["rank", /\b(rank(?:ing|ed)?|top brands?|who(?:'s| is) (?:first|leading|winning|on top)|leaders?|leading|most visible|best placed|named first)\b|clasificaci[oó]n|classement|ranking|रैंक|ترتيب/i],
  ["metric", /\b(how (?:are|is|am) (?:we|i|my|our|it)|how visible|visibility|share of voice|sov|position|mentions?|doing|perform(?:ing|ance)?)\b|visibilidad|visibilidade|visibilit[eé]|दृश्यता|ظهور/i],
];
const MEASURE_RULES = [
  ["share_of_voice", /\b(share of voice|sov|voice share)\b|cuota de voz|participa[cç][aã]o de voz|part de voix/i],
  ["first_place", /\b(named first|first place|top spot|number one|#1)\b/i],
  ["position", /\b(position|rank(?:ed|ing)?|placed|place)\b|posici[oó]n|posi[cç][aã]o/i],
  ["citations", /\b(cit(?:ed|es|ation|ations)|sources?)\b|citas|cita[cç][oõ]es/i],
  ["mentions", /\b(mentions?|mentioned|how many times|times named)\b|menciones|men[cç][oõ]es/i],
  ["visibility", /\b(visib(?:le|ility)|named in|appear(?:s|ing)? in|how (?:are|is) .{0,20} doing)\b|visibilidad|visibilidade|visibilit[eé]/i],
];
const BY_RULES = [
  ["engine", /\b(by|per|on each|each|for each|across) engines?\b|engine by engine|side by side/i],
  ["tag", /\b(by|per|each) (?:topic|tag|theme)s?\b/i],
  ["prompt", /\b(by|per|each) (?:prompt|question)s?\b|which prompts|which questions/i],
  ["run", /\b(by|per|each) runs?\b|run by run/i],
  ["site", /\b(by|per|each) (?:site|domain)s?\b/i],
  ["brand", /\b(by|per|each) brands?\b/i],
];
// How an answer treats a brand (Laya / the AI check labels, Stage 4).
const STANCE_RULES = [
  ["advised_against", /\b(advises? against|warns? against|says? to avoid|tells? (?:people|users) to avoid)\b/i],
  ["negative", /\b(negative(?:ly)?|criticis(?:e|es|ed|ing)|criticiz(?:e|es|ed|ing)|bad things)\b/i],
  ["recommended", /\b(recommend(?:s|ed|ing)?|suggest(?:s|ed)? buying|put(?:s)? first|top pick)\b|recomiend|recomend|recommand/i],
  ["positive", /\b(positive(?:ly)?|praise[sd]?|speaks? well)\b/i],
];
const OWN = /\b(we|us|our|ours|my brand|my company|my business|am i)\b|nosotros|nuestra?|nossa?|n[oó]s|notre|nous|हम|हमारा|نحن/i;
const FOLLOW_UP = /^\s*(and|what about|how about|also|same (?:for|on)|now|then|e|y|et|और|و)\b|^\s*(on|for|in) (chatgpt|gemini|perplexity|grok|the )\b/i;
const LATEST_CAMPAIGN = /\b(latest|last|newest|most recent|recent) campaign\b/i;
const ALL_CAMPAIGNS = /\b(all|every|each|both) (?:of )?(?:my |the )?campaigns?\b|across (?:all )?(?:my )?campaigns\b|\bboth\b/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Date words to a {from, to} range (ms), or null. */
export function datesIn(question, now = Date.now()) {
  const q = String(question || "").toLowerCase();
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  let m;
  if (/\btoday\b|\bhoy\b|\bhoje\b|aujourd/.test(q)) return { from: startOfDay(now), to: null };
  if (/\byesterday\b|\bayer\b|\bontem\b|\bhier\b/.test(q)) return { from: startOfDay(now) - DAY, to: startOfDay(now) };
  if ((m = /\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/.exec(q))) return { from: now - Number(m[1]) * { day: 1, week: 7, month: 30 }[m[2]] * DAY, to: null };
  if (/\b(?:last|past) week\b|\bthis week\b|semana pasada|[uú]ltima semana|semaine derni/.test(q)) return { from: now - 7 * DAY, to: null };
  if (/\b(?:last|past) month\b|mes pasado|[uú]ltimo m[eê]s|mois dernier/.test(q)) return { from: now - 30 * DAY, to: null };
  if (/\bthis month\b/.test(q)) { const d = new Date(now); return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: null }; }
  if ((m = /\bsince (\d{4})-(\d{2})-(\d{2})\b/.exec(q))) return { from: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), to: null };
  if ((m = new RegExp(`\\b(?:since|from|after) (${MONTHS.join("|")})\\b`).exec(q))) {
    const mi = MONTHS.indexOf(m[1]);
    const d = new Date(now);
    const y = mi > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear();
    return { from: new Date(y, mi, 1).getTime(), to: null };
  }
  return null;
}

/** An empty plan. */
export function emptyPlan() {
  return { intent: null, scope: { collections: [], runs: "latest", engines: [], tags: [], prompts: [], dates: null, signedIn: null, stance: null }, subject: { own: false, brands: [], sites: [] }, measure: [], by: "none", sort: "desc", limit: 10, text: "", parts: [] };
}

// Words of the question that are left for a passage search.
const FILLER = new Set("show me the answers which what do does did say says about find that mention mentions name names quote example engines engine ais ai chatgpt gemini perplexity grok in on for of to a an and or is are my our we i".split(" "));

/**
 * Pass 1: rules only.
 * @returns {{plan: object, matches: object[]}}
 */
export function rulePlan(question, catalog, { now = Date.now() } = {}) {
  const plan = emptyPlan();
  const q = String(question || "");
  const matches = lookup(q, catalog);
  plan.intent = (INTENT_RULES.find(([, re]) => re.test(q)) || [null])[0];
  plan.intentFrom = plan.intent ? "rule" : "default"; // the model may fill a default (askModelPlan)
  plan.measure = MEASURE_RULES.filter(([, re]) => re.test(q)).map(([m]) => m);
  plan.by = (BY_RULES.find(([, re]) => re.test(q)) || ["none"])[0];
  plan.subject.own = OWN.test(q);
  plan.subject.brands = matches.filter((m) => m.kind === "brand").map((m) => m.name);
  plan.subject.sites = matches.filter((m) => m.kind === "site").map((m) => m.id);
  plan.scope.engines = matches.filter((m) => m.kind === "engine").map((m) => m.id);
  plan.scope.tags = matches.filter((m) => m.kind === "tag").map((m) => m.name);
  plan.scope.dates = datesIn(q, now);
  const stance = (STANCE_RULES.find(([, re]) => re.test(q)) || [null])[0];
  if (stance && plan.subject.brands.length) plan.scope.stance = stance;
  const stanceSet = !!plan.scope.stance;
  // A comparison of brands is a compare even without "vs" ("Zento or Kovo?").
  if (!plan.intent && plan.subject.brands.length >= 2) plan.intent = "compare";
  if (!plan.intent && (plan.subject.brands.length || plan.subject.own)) plan.intent = "metric";
  if (plan.intent === "compare" && plan.subject.brands.length === 1) plan.subject.own = true;
  if (plan.intent === "trend" || plan.scope.dates) plan.scope.runs = "all";
  if (plan.intent === "find_answers") {
    const named = new Set(matches.map((m) => fold(m.name)).join(" ").split(" "));
    plan.text = fold(q).split(" ").filter((w) => w.length > 2 && !FILLER.has(w) && !named.has(w)).join(" ");
    if (stanceSet) plan.text = ""; // the stance is the filter, not words to find
  }
  // "battery prompts", "prompts about battery": the topic, if no tag matched.
  const topic = /([\p{L}][\p{L}\s-]{2,30}?)\s+(?:prompts|questions)\b/iu.exec(q) || /(?:prompts|questions)\s+(?:about|on|for|with|mentioning)\s+([^?.,;]+)/i.exec(q);
  if (topic && !plan.scope.tags.length) {
    const words = fold(topic[1]).split(" ").filter((w) => w.length >= 4 && !FILLER.has(w) && !["which", "where", "those", "these", "their"].includes(w));
    if (words.length) plan.topicWords = words;
  }
  return { plan, matches };
}

/** Is this a follow-up that keeps the last scope? */
export function isFollowUp(question, previous) {
  if (!previous || !previous.scope) return false;
  const q = String(question || "").trim();
  return FOLLOW_UP.test(q) || (q.split(/\s+/).length <= 4 && !INTENT_RULES.some(([, re]) => re.test(q)));
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const HISTORY_INTENTS = new Set(["find_answers", "sources", "searches", "cards", "data_status", "rank", "compare", "metric"]);

/**
 * Decide the scope.
 * @param {object} plan     from rulePlan
 * @param {object[]} matches from rulePlan
 * @param {object} catalog  from buildCatalog
 * @param {{context?: {collectionId?: string|null}, previous?: object|null, question?: string}} o
 * @returns {{plan: object, askBack: null|{question: string, choices: {label: string, collections: string[]}[]}, notes: string[]}}
 */
export function resolveScope(plan, matches, catalog, { context = {}, previous = null, question = "", named: extraNamed = [] } = {}) {
  const p = clone(plan);
  const notes = [];
  const cols = catalog.collections;
  const byId = new Map(cols.map((c) => [c.id, c]));

  // 3. A follow-up starts from the last plan and changes only what it names.
  if (isFollowUp(question, previous)) {
    const base = clone(previous);
    if (p.scope.engines.length) base.scope.engines = p.scope.engines;
    if (p.scope.tags.length) base.scope.tags = p.scope.tags;
    if (p.scope.dates) { base.scope.dates = p.scope.dates; base.scope.runs = "all"; }
    if (p.subject.brands.length) base.subject = p.subject;
    if (p.intent && p.intent !== "metric") base.intent = p.intent;
    if (p.measure.length) base.measure = p.measure;
    if (p.by !== "none") base.by = p.by;
    const namedCols = matches.filter((m) => m.kind === "collection" && m.score >= 0.8).map((m) => m.id);
    if (namedCols.length) base.scope.collections = namedCols;
    base.inherited = true;
    return { plan: finish(base, catalog, notes), askBack: null, notes };
  }
  if (!p.intent) p.intent = "metric";
  // Nothing to scope: what the tool doesn't record, what a measure means.
  if (p.intent === "not_recorded" || p.intent === "define") return { plan: p, askBack: null, notes };

  // 4. A brand named in the question is a subject. A collection match that
  // is only the brand's name counts as naming the campaign when no other
  // campaign tracks that brand.
  const brandKeys = new Set(matches.filter((m) => m.kind === "brand").map((m) => m.id));
  let named = [...new Set([...matches.filter((m) => m.kind === "collection" && m.score >= 0.8).map((m) => m.id), ...extraNamed.filter((id) => byId.has(id))])];
  named = named.filter((id) => {
    const c = byId.get(id);
    if (!c || !brandKeys.has(fold(c.name))) return true;
    const tracking = cols.filter((x) => x.kind === "campaign" && x.tracked.some((n) => fold(n) === fold(c.name)));
    return tracking.length <= 1;
  });

  // 1. Named wins.
  if (named.length) { p.scope.collections = named; return { plan: finish(p, catalog, notes), askBack: null, notes }; }
  if (ALL_CAMPAIGNS.test(question)) { p.scope.collections = cols.filter((c) => c.kind === "campaign").map((c) => c.id); if (p.by === "none" && p.scope.collections.length > 1) p.by = "collection"; return { plan: finish(p, catalog, notes), askBack: null, notes }; }

  // A wording search with nothing named looks everywhere: My questions and
  // every campaign (where the user is still narrows it, below).
  if (p.intent === "find_answers" && !(context && context.collectionId)) { p.scope.collections = cols.map((c) => c.id); return { plan: finish(p, catalog, notes), askBack: null, notes }; }
  const candidates = cols.filter((c) => c.kind === "campaign" || (HISTORY_INTENTS.has(p.intent) && !p.subject.own));
  if (!candidates.length) return { plan: finish(p, catalog, notes), askBack: null, notes };
  if (candidates.length === 1) { p.scope.collections = [candidates[0].id]; return { plan: finish(p, catalog, notes), askBack: null, notes }; }

  // A rival named with no campaign: every campaign that tracks it, one row
  // each ("How is Kovo doing?").
  // Several brands named: the one campaign that tracks all of them, if
  // there is exactly one ("Compare Lumora and Pexa").
  const tracksAll = cols.filter((c) => c.kind === "campaign" && p.subject.brands.length > 1 && p.subject.brands.every((b) => c.tracked.some((t) => fold(t) === fold(b))));
  if (tracksAll.length === 1 && !(context && context.collectionId)) { p.scope.collections = [tracksAll[0].id]; return { plan: finish(p, catalog, notes), askBack: null, notes }; }
  const brandCols = cols.filter((c) => c.kind === "campaign" && p.subject.brands.some((b) => c.tracked.some((t) => fold(t) === fold(b))));
  if (p.subject.brands.length && !p.subject.own && brandCols.length > 1 && !(context && context.collectionId)) {
    p.scope.collections = brandCols.map((c) => c.id);
    if (p.by === "none") p.by = "collection";
    return { plan: finish(p, catalog, notes), askBack: null, notes };
  }

  // 5. Score the candidates.
  const qWords = new Set(fold(question).split(" ").filter((w) => w.length >= 4));
  const latest = Math.max(...candidates.map((c) => Math.max(c.lastAt, ...c.runs.map((g) => g.startedAt), 0)));
  const scored = candidates.map((c) => {
    let s = 0;
    if (context && context.collectionId === c.id) s += 4;                                                   // open on the page: strong
    if (p.scope.tags.some((t) => c.tags.some((x) => fold(x) === fold(t)))) s += 2;                           // its tags match: medium
    else if (c.prompts.some((x) => fold(x.text).split(" ").filter((w) => qWords.has(w)).length >= 2)) s += 1.5; // its prompts match
    if (p.subject.brands.some((b) => c.tracked.some((t) => fold(t) === fold(b)))) s += 2;                    // tracks the brands named: medium
    const last = Math.max(c.lastAt, ...c.runs.map((g) => g.startedAt), 0);
    s += last && last === latest ? (LATEST_CAMPAIGN.test(question) ? 4 : 1) : 0.5;                            // recency: weak (strong if asked)
    if (c.kind === "history" && context && context.collectionId === HISTORY_ID) s += 4;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const [best, next] = scored;
  if (best.s > 2 * next.s) { p.scope.collections = [best.c.id]; return { plan: finish(p, catalog, notes), askBack: null, notes }; }

  // Close: ask back, with the close ones and "all of them".
  const close = scored.filter((x) => x.s * 2 >= best.s).slice(0, 4);
  const choices = close.map((x) => ({ label: x.c.name, collections: [x.c.id] }));
  const allIds = scored.filter((x) => x.c.kind === "campaign").map((x) => x.c.id);
  if (allIds.length > 1) choices.push({ label: allIds.length === 2 ? "Both" : "All campaigns", collections: allIds });
  return { plan: p, askBack: { question: `Which do you mean: ${close.map((x) => x.c.name).join(" or ")}?`, choices }, notes };
}

// 6–7. Runs, engines, tags and prompts for the chosen collections.
function finish(p, catalog, notes) {
  const cols = p.scope.collections.map((id) => catalog.byId.get(id)).filter(Boolean);
  const engines = new Set(cols.flatMap((c) => c.engines));
  const unknownEngines = p.scope.engines.filter((e) => !engines.has(e));
  if (unknownEngines.length && engines.size) notes.push(`not run on ${unknownEngines.join(", ")} in this scope`);
  p.scope.engines = p.scope.engines.filter((e) => ENGINES.includes(e));
  const tags = new Set(cols.flatMap((c) => c.tags.map(fold)));
  p.scope.tags = p.scope.tags.filter((t) => tags.has(fold(t)));
  if (!p.scope.tags.length && p.topicWords && p.topicWords.length) {
    // A tag spelled like the topic first, then prompts whose wording has it.
    const tag = cols.flatMap((c) => c.tags).find((t) => p.topicWords.some((w) => fold(t).startsWith(w.slice(0, -1)) || w.startsWith(fold(t))));
    if (tag) p.scope.tags = [tag];
    else {
      const stem = (w) => w.replace(/(ies|es|s)$/, "");
      const ids = cols.flatMap((c) => c.prompts.filter((x) => { const t = fold(x.text); return p.topicWords.every((w) => t.includes(stem(w))); }).map((x) => x.id));
      if (ids.length) { p.scope.prompts = ids; p.promptsByWording = true; }
    }
  }
  delete p.topicWords;
  return p;
}

/** Check a plan's ids against the catalog (a model's or an edited one). */
export function validPlan(plan, catalog) {
  if (!plan || typeof plan !== "object" || !plan.scope) return false;
  if (plan.intent && !INTENTS.includes(plan.intent)) return false;
  if (!Array.isArray(plan.scope.collections) || plan.scope.collections.some((id) => !catalog.byId.has(id))) return false;
  if ((plan.scope.engines || []).some((e) => !ENGINES.includes(e))) return false;
  if ((plan.measure || []).some((m) => !MEASURES.includes(m))) return false;
  return true;
}
