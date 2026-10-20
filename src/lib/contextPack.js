/*
 * contextPack.js — what "Continue in…" sends to another AI (0.76.0).
 *
 * The owner: when the built-in AI can't do something, "take the data from
 * the tool to a specific LLM of their choice in one click — not only the
 * data but also the prompt, question and request". A pack is one markdown
 * message the other AI can work from with nothing else:
 *   1. what CitoSkeleton is and how it measured (so the numbers aren't
 *      misread), with the definitions of the measures it uses;
 *   2. the data — the campaign's findings from insights.js, an answer, or
 *      what Ask looked up — as tables and short lists;
 *   3. the request: a task (explain, why it dropped, a content brief, …),
 *      the user's own question, and how the reply should be laid out;
 *   4. what was left out to fit, if anything.
 * Each engine gets a size budget; parts are dropped from the least to the
 * most important until it fits, and the pack says what was dropped.
 *
 * Pure: plain objects in, a string out. No ids, cookies or account data.
 */
import { GLOSSARY } from "./glossary.js";

export const ENGINES = {
  chatgpt: { label: "ChatGPT", url: "https://chatgpt.com/", budget: 40000 },
  claude: { label: "Claude", url: "https://claude.ai/new", budget: 60000 },
  gemini: { label: "Gemini", url: "https://gemini.google.com/app", budget: 60000 },
  perplexity: { label: "Perplexity", url: "https://www.perplexity.ai/", budget: 14000 },
  grok: { label: "Grok", url: "https://grok.com/", budget: 30000 },
};

export const TASKS = {
  explain: { label: "Explain these results", ask: "Explain what these results say about my brand's visibility in AI answers: where I'm strong, where I'm weak, and who is beating me where." },
  drop: { label: "Why did it change", ask: "Explain why my numbers changed since the previous run, using the prompt-level and engine-level detail. Say what could be missing data rather than a real change." },
  brief: { label: "Content brief to win a prompt", ask: "Write a content brief that would make my brand a strong answer to the prompts I'm missing from: the page to create or improve, the questions it must answer, the facts and comparisons to include, and the sites the AI engines already cite that I should get onto." },
  rival: { label: "Competitor teardown", ask: "Compare my brand with the competitors in this data: where each one wins, the prompts and engines that favour them, the sites cited for them, and what that suggests about their positioning." },
  outreach: { label: "Source outreach list", ask: "Turn the sites the AI engines cite into an outreach list: for each site, why it matters (how often it is cited, for whom), what kind of coverage to aim for, and the angle to pitch." },
  summary: { label: "Executive summary", ask: "Write a one-page executive summary of these results for a marketing lead: the headline numbers, what changed, the three biggest gaps, and the three actions that matter most." },
  plan: { label: "30-day GEO plan", ask: "Draft a 30-day generative-engine-optimisation plan from these results: weekly priorities, the content and outreach for each, and how to measure progress with the next campaign run." },
  custom: { label: "My own question", ask: "" },
};

const FORMAT = "Answer in the language of my question. Use headings and short lists. Quote numbers exactly as given above and don't invent any; say clearly when something isn't in the data.";
const ABOUT = "This data comes from CitoSkeleton, a browser extension that records what AI assistants (ChatGPT, Gemini, Perplexity, Grok) answered on my computer: the prompt, which brands each answer named and in what order, which sites it searched, read and cited, product cards, the engines' own web searches, and ChatGPT's ads. It does not capture clicks, traffic, impressions, search volume or rankings.";

const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map((c) => String(c ?? "—").replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ")} |`)].join("\n") : "");
const pct = (x) => (x == null ? "—" : `${x}%`);
const sign = (x) => (x == null ? "—" : `${x > 0 ? "+" : ""}${x}`);
const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };

function defs(keys) {
  return keys.map((k) => GLOSSARY[k]).filter(Boolean).map((g) => `- **${g.term}**: ${g.what}${g.formula ? ` (${g.formula})` : ""}`).join("\n");
}

/**
 * The data parts of a campaign pack, most important first. Each part is
 * {title, text}; build() drops from the end until the pack fits.
 * @param {object} I  campaignInsights() output
 */
export function campaignParts(I) {
  if (!I) return [];
  const parts = [];
  const head = `Campaign "${I.campaign.name}" — my brand: ${I.campaign.brand || "?"}${I.campaign.site ? ` (${I.campaign.site})` : ""}; competitors: ${[...I.campaign.competitors, ...I.campaign.inferredCompetitors.map((x) => `${x} (found in answers)`)].join(", ") || "none set"}.\nLatest run: ${I.run.date || "?"}, ${I.run.answers} answers on ${I.run.engines.map((e) => ENGINE_LABEL[e] || e).join(", ")}${I.previousRun ? `; previous run ${I.previousRun.date}` : ""}.`;
  parts.push({ title: "Campaign", text: head });
  parts.push({ title: "Brands in the latest run", text: table(["Brand", "Visibility", "Share of voice", "Avg position", "Mentions", "Answers citing its site"], I.overview.map((b) => [`${b.brand}${b.yours ? " (mine)" : ""}`, pct(b.visibility), pct(b.shareOfVoice), b.avgPosition ?? "—", b.mentions, b.answersCitingSite])) });
  if (I.changes.length) parts.push({ title: "Change since the previous run (points)", text: table(["Brand", "Visibility", "Share of voice", "Avg position"], I.changes.map((c) => [c.brand, sign(c.visibility), sign(c.shareOfVoice), sign(c.avgPosition)])) });
  if (I.absent.length) parts.push({ title: `Prompts where I'm never named but 2+ competitors are (${I.absent.length} of ${I.prompts.length})`, text: I.absent.slice(0, 25).map((p) => `- "${p.prompt}" — named: ${p.rivalsNamed.join(", ")}${p.tags.length ? ` [${p.tags.join(", ")}]` : ""}`).join("\n") });
  if (I.rivalWins.length) parts.push({ title: "Where competitors win", text: table(["Competitor", "Named first", "In answers without me", "Before me"], I.rivalWins.map((r) => [r.brand, r.namedFirst, r.inAnswersWithoutYou, r.aheadOfYou])) });
  if (I.sources.gaps.length) parts.push({ title: "Sites cited for competitors but never with me", text: table(["Site", "Kind", "Answers (competitors only)", "Engines"], I.sources.gaps.map((s) => [s.site, s.kind, s.withRivalsOnly, s.engines.map((e) => ENGINE_LABEL[e] || e).join(", ")])) });
  parts.push({ title: "Most cited sites", text: `${table(["Site", "Kind", "Answers citing", "With me", "Competitors only"], I.sources.top.slice(0, 15).map((s) => [s.site, s.kind, s.answersCiting, s.withYou, s.withRivalsOnly]))}\nMy own site: ${I.sources.ownSiteCitations} of ${I.sources.citations} citations (${pct(I.sources.ownSiteShare)}).` });
  if (I.topics.length) parts.push({ title: "By topic", text: table(["Topic", "Answers", "My visibility", "Most often first"], I.topics.map((t) => [t.topic, t.answers, pct(t.yourVisibility), t.mostOftenFirst])) });
  if (I.byEngine.length > 1) parts.push({ title: "By engine", text: I.byEngine.map((e) => `**${ENGINE_LABEL[e.engine] || e.engine}** (${e.answers} answers)\n${table(["Brand", "Visibility", "Share of voice", "Avg position"], e.brands.slice(0, 8).map((b) => [b.brand, pct(b.visibility), pct(b.shareOfVoice), b.avgPosition ?? "—"]))}`).join("\n\n") });
  if (I.behind.length) parts.push({ title: "Prompts where I'm named but a competitor comes first", text: I.behind.slice(0, 20).map((p) => `- "${p.prompt}" — first: ${Object.entries(p.engines).map(([e, v]) => `${ENGINE_LABEL[e] || e}: ${v.first || "—"}${v.yours ? ` (me #${v.rank || "?"})` : ""}`).join("; ")}`).join("\n") });
  if (I.disagreements.length) parts.push({ title: "Prompts where the engines disagree on who comes first", text: I.disagreements.slice(0, 15).map((d) => `- "${d.prompt}" — ${Object.entries(d.first).map(([e, b]) => `${ENGINE_LABEL[e] || e}: ${b || "—"}`).join("; ")}`).join("\n") });
  if (I.products.answersWithCards) parts.push({ title: "Product cards", text: `${I.products.answersWithCards} answers showed product cards.\n${table(["Brand", "Cards", "First card", "Products"], I.products.byBrand.map((b) => [b.brand, b.cards, b.firstCards, b.top.map((x) => x.name).join(", ")]))}` });
  if (I.searches.total) parts.push({ title: "The engines' own web searches", text: `${I.searches.total} searches (${I.searches.perAnswer} per answer); ${I.searches.namingYou} named my brand, ${I.searches.namingRivals} named competitors, ${I.searches.siteScoped} were site: searches. Examples:\n${I.searches.examples.map((x) => `- ${ENGINE_LABEL[x.engine] || x.engine}: "${x.query}"`).join("\n")}` });
  if (I.ads.answersWithAds) parts.push({ title: "Ads shown (ChatGPT)", text: `${I.ads.answersWithAds} answers showed an ad: ${I.ads.advertisers.map((a) => `${a.advertiser} (${a.n})`).join(", ")}.` });
  const gaps = I.quality.filter((q) => q.withAnswer < q.captured);
  if (gaps.length) parts.push({ title: "Data gaps", text: gaps.map((q) => `- ${ENGINE_LABEL[q.engine] || q.engine}: ${q.withAnswer} of ${q.captured} prompts answered${q.usageLimit ? `, ${q.usageLimit} stopped by a usage limit` : ""}`).join("\n") });
  parts.push({ title: "Every prompt", text: table(["Prompt", "Tags", "Engines naming me", "First per engine"], I.prompts.map((p) => [p.prompt, p.tags.join(", "), `${p.yoursIn} of ${p.answers}`, Object.entries(p.engines).map(([e, v]) => `${ENGINE_LABEL[e] || e}: ${v.first || "—"}`).join("; ")])) });
  return parts;
}

/** The data parts for one captured answer. */
export function answerParts(rec, { ownBrand = null } = {}) {
  if (!rec) return [];
  const eng = ENGINE_LABEL[rec.platform] || rec.platform;
  const parts = [{ title: "The question and engine", text: `${eng}, ${rec.capturedAt ? new Date(rec.capturedAt).toISOString().slice(0, 10) : "?"}: "${String(rec.userPrompt || "").slice(0, 1000)}"${ownBrand ? `\nMy brand: ${ownBrand}.` : ""}` }];
  const brands = [...(rec.brandMentions || [])].filter((m) => (m.count || 0) > 0).sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15));
  if (brands.length) parts.push({ title: "Brands named, in order", text: table(["#", "Brand", "Mentions"], brands.map((m, i) => [i + 1, m.brand, m.count])) });
  const cited = (rec.sources || []).filter((s) => s.outcome === "cited");
  if (cited.length) parts.push({ title: "Sites cited", text: cited.slice(0, 30).map((s) => `- ${s.title ? `${s.title} — ` : ""}${s.url || s.domain}`).join("\n") });
  const q = [].concat((rec.fanout && rec.fanout.search) || []).map((x) => (typeof x === "string" ? x : x && x.query)).filter(Boolean);
  if (q.length) parts.push({ title: "Searches the engine ran", text: q.slice(0, 20).map((x) => `- "${x}"`).join("\n") });
  if ((rec.products || []).length) parts.push({ title: "Product cards", text: rec.products.slice(0, 12).map((p, i) => `${i + 1}. ${p.name}${p.price ? ` — ${p.price}` : ""}${p.merchant ? ` (${p.merchant})` : ""}`).join("\n") });
  if (rec.answerText) parts.push({ title: "The answer", text: String(rec.answerText).slice(0, 30000) });
  const read = (rec.sources || []).filter((s) => s.outcome !== "cited");
  if (read.length) parts.push({ title: "Sites read but not cited", text: read.slice(0, 30).map((s) => `- ${s.url || s.domain}`).join("\n") });
  return parts;
}

/** The data parts from an Ask conversation: the question, the reply, and what was looked up. */
export function askParts({ question, answer, steps = [], results = [] }) {
  const parts = [];
  if (question) parts.push({ title: "What I asked CitoSkeleton's assistant", text: question });
  if (answer) parts.push({ title: "Its reply", text: answer });
  results.forEach((r, i) => parts.push({ title: `Looked up: ${(steps[i] && steps[i].tool) || "data"}`, text: "```json\n" + JSON.stringify(r, null, 1).slice(0, 12000) + "\n```" }));
  return parts;
}

const DEF_KEYS = ["visibility", "shareOfVoice", "avgPosition", "mentions", "citations"];

/**
 * The whole message for one engine.
 * @param {{engine: string, task?: string, question?: string, parts: {title, text}[], defsFor?: string[]}} o
 * @returns {{text: string, chars: number, budget: number, dropped: string[]}}
 */
export function buildPack({ engine = "chatgpt", task = "explain", question = "", parts = [], defsFor = DEF_KEYS }) {
  const budget = (ENGINES[engine] || ENGINES.chatgpt).budget;
  const t = TASKS[task] || TASKS.explain;
  const request = [t.ask, question ? `My question: ${question}` : "", FORMAT].filter(Boolean).join("\n\n");
  const top = ["# Context from CitoSkeleton", ABOUT, "## How the numbers are counted", defs(defsFor)].join("\n\n");
  const tail = (dropped) => ["## What I need from you", request, dropped.length ? `_Left out to fit this message: ${dropped.join("; ")}._` : ""].filter(Boolean).join("\n\n");
  const keep = [...parts];
  const dropped = [];
  const render = () => [top, "## The data", ...keep.map((p) => `### ${p.title}\n${p.text}`), tail(dropped)].join("\n\n");
  let text = render();
  // Drop the least important parts (the last ones) until it fits; the first
  // part (what this is) always stays, cut if it has to be.
  while (text.length > budget && keep.length > 1) { dropped.unshift(keep.pop().title); text = render(); }
  if (text.length > budget) {
    const over = text.length - budget + 40;
    keep[0] = { ...keep[0], text: keep[0].text.slice(0, Math.max(200, keep[0].text.length - over)) + " …" };
    text = render();
  }
  return { text, chars: text.length, budget, dropped };
}
