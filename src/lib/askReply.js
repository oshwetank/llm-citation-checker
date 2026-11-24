/*
 * askReply.js — the scope line and the template replies (1.0.5, Stage 1 of
 * ASK-ARCHITECTURE.md §4.5 rule 8 and §4.8).
 *
 * Every Ask answer shows what it is about: "Zento India · latest run
 * (12 Nov) · ChatGPT, Gemini · tag: battery · 56 answers", as chips the
 * user can change. The common questions get a reply written from the
 * Executor's result by a template, with no model, so Ask answers even with
 * the AI off and its numbers are the result's own.
 */
import { ENGINE_LABEL, ENGINES } from "./askCatalog.js";

const pct = (x) => (x == null ? "–" : `${Math.round(x * 10) / 10}%`);
const pos = (x) => (x == null ? "–" : `${Math.round(x * 10) / 10}`);
const sign = (x) => (x == null ? "" : x > 0 ? `up ${Math.abs(x)} points` : x < 0 ? `down ${Math.abs(x)} points` : "no change");
const fmtDate = (s) => { try { return s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; } catch (_) { return s || ""; } };

/**
 * The scope as chips and one line of text.
 * @returns {{text: string, chips: {kind: string, label: string, value: any}[]}}
 */
export function scopeOf(plan, exec, catalog) {
  const chips = [];
  const cols = (plan.scope.collections || []).map((id) => catalog.byId.get(id)).filter(Boolean);
  chips.push({ kind: "collection", label: cols.length ? cols.map((c) => c.name).join(" + ") : "No campaign", value: plan.scope.collections });
  const run = exec && exec.parts && exec.parts.length === 1 ? exec.parts[0].coverage.run : null;
  if (plan.scope.dates && plan.scope.dates.from) chips.push({ kind: "runs", label: `since ${new Date(plan.scope.dates.from).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`, value: "all" });
  else chips.push({ kind: "runs", label: plan.scope.runs === "all" ? "all runs" : run ? `latest run (${fmtDate(run)})` : "latest run", value: plan.scope.runs });
  const engines = plan.scope.engines && plan.scope.engines.length ? plan.scope.engines : null;
  chips.push({ kind: "engines", label: engines ? engines.map((e) => ENGINE_LABEL[e] || e).join(", ") : "all engines", value: engines || [] });
  if (plan.scope.tags && plan.scope.tags.length) chips.push({ kind: "tags", label: `tag: ${plan.scope.tags.join(", ")}`, value: plan.scope.tags });
  if (plan.scope.prompts && plan.scope.prompts.length) chips.push({ kind: "prompts", label: `${plan.scope.prompts.length} prompts`, value: plan.scope.prompts });
  const stance = Array.isArray(plan.scope.stance) ? plan.scope.stance[0] : plan.scope.stance;
  if (stance) chips.push({ kind: "stance", label: `${plan.subject.brands.join(", ") || "brands"} ${stance.replace(/_/g, " ")}`, value: stance });
  if (plan.scope.signedIn) chips.push({ kind: "signedIn", label: plan.scope.signedIn === "in" ? "signed in" : "signed out", value: plan.scope.signedIn });
  const answers = exec && exec.parts ? exec.parts.reduce((s, p) => s + (p.coverage.answers || 0), 0) : null;
  const text = [...chips.map((c) => c.label), answers != null ? `${answers} answers` : null].filter(Boolean).join(" · ");
  return { text, chips, answers };
}

/** What each chip may become, for the scope editor. */
export function chipOptions(kind, catalog) {
  if (kind === "collection") return catalog.collections.map((c) => ({ label: c.name, value: [c.id] }));
  if (kind === "runs") return [{ label: "latest run", value: "latest" }, { label: "all runs", value: "all" }];
  if (kind === "engines") return [{ label: "all engines", value: [] }, ...ENGINES.map((e) => ({ label: ENGINE_LABEL[e], value: [e] }))];
  return [];
}

/** Notes on how much the answer stands on. */
export function coverageNotes(exec) {
  const out = [];
  for (const p of (exec && exec.parts) || []) {
    const c = p.coverage;
    const name = exec.parts.length > 1 ? `${p.collection.name}: ` : "";
    if (!c.answers) out.push(`${name}no answers in this scope.`);
    else if (c.answers < 5) out.push(`${name}only ${c.answers} answer${c.answers === 1 ? "" : "s"}, so read this loosely.`);
    if (c.usageLimit) out.push(`${name}${c.usageLimit} turn${c.usageLimit === 1 ? " was" : "s were"} stopped by a usage limit.`);
    else if (c.noAnswer) out.push(`${name}${c.noAnswer} turn${c.noAnswer === 1 ? "" : "s"} had no answer.`);
    if (c.enginesMissing && c.enginesMissing.length) out.push(`${name}not run on ${c.enginesMissing.map((e) => ENGINE_LABEL[e] || e).join(", ")}.`);
  }
  return out;
}

/** A reply written from the result alone. Null when a template doesn't fit. */
export function templateReply(plan, exec) {
  const r = exec && exec.result;
  if (!r) return null;
  if (r.notRecorded) return r.text;
  if (exec.intent === "define") return r.term ? `**${r.term}**: ${r.what}${r.formula ? `\n\nCounted as: ${r.formula}.` : ""}${r.note ? `\n\n${r.note}` : ""}` : r.note;
  if (!exec.parts.length) return "There are no captured answers in that scope yet.";
  const blocks = exec.parts.map((p) => partReply(plan, exec.intent, p, exec.parts.length > 1));
  return blocks.filter(Boolean).join("\n\n") || null;
}

function brandLine(b, total) {
  return `**${b.brand}**${b.yours ? " (you)" : ""}: named in ${pct(b.visibility)} of answers (${b.answersNaming}${total ? ` of ${total}` : ""}), share of voice ${pct(b.shareOfVoice)}, average position ${pos(b.avgPosition)}`;
}

function partReply(plan, intent, p, many) {
  const d = p.data, head = many ? `**${p.collection.name}**\n` : "";
  if (!p.coverage.answers && intent !== "data_status") return `${head}No answers in this scope.`;
  switch (intent) {
    case "trend": {
      const lines = d.trend.map((t) => t.runs.length ? `**${t.brand}**, run by run: ${t.runs.map((x) => `${fmtDate(x.run)} ${pct(x.visibility)}`).join(" → ")}` : `**${t.brand}**: no finished runs to compare.`);
      return head + lines.join("\n");
    }
    case "compare": {
      if (!d.brands.length) return `${head}None of those brands is in these answers.`;
      const eng = d.byEngine.filter((e) => e.brands.length).map((e) => `- ${ENGINE_LABEL[e.engine] || e.engine}: ${e.brands.map((b) => `${b.brand} ${pct(b.visibility)}`).join(", ")}`);
      return `${head}${d.brands.map((b) => `- ${brandLine(b, p.coverage.answers)}`).join("\n")}${eng.length ? `\n\nBy engine (visibility):\n${eng.join("\n")}` : ""}`;
    }
    case "gaps": {
      const a = d.promptsWhereAbsent.map((x) => `- ${x.prompt} (rivals named: ${x.rivalsNamed.slice(0, 3).join(", ")})`);
      const s = d.sourceGaps.map((x) => `- ${x.site}${x.kind ? ` (${x.kind})` : ""}: cited in ${x.answersCitingWithRivalsOnly} answers that name rivals but not you`);
      return `${head}You're missing from ${d.absentCount} of ${d.of} prompts where two or more rivals are named.${a.length ? `\n${a.slice(0, 6).join("\n")}` : ""}${s.length ? `\n\nSites to get onto:\n${s.slice(0, 6).join("\n")}` : ""}`;
    }
    case "why": {
      const own = d.changes.find((c) => c.yours);
      const lead = own ? `Since the previous run (${fmtDate(d.previousRun)}), your visibility is ${sign(own.visibility)}.` : "There is no previous run to compare with.";
      const w = d.rivalWins.filter((x) => x.namedFirst).slice(0, 3).map((x) => `- ${x.brand} is named first in ${x.namedFirst} answers${x.inAnswersWithoutYou ? `, and appears without you in ${x.inAnswersWithoutYou}` : ""}`);
      const a = d.promptsWhereAbsent.slice(0, 3).map((x) => `- ${x.prompt}`);
      return `${head}${lead}${w.length ? `\n\nWhere rivals win:\n${w.join("\n")}` : ""}${a.length ? `\n\nPrompts you're missing from:\n${a.join("\n")}` : ""}`;
    }
    case "sources": {
      const s = d.sites.slice(0, 8).map((x) => `- ${x.site}${x.kind ? ` (${x.kind})` : ""}: cited in ${x.answersCiting} answers`);
      return `${head}${d.citations} citations${d.yourSiteCitations != null ? `, ${d.yourSiteCitations} to your own site (${pct(d.yourSiteShare)})` : ""}.${s.length ? `\n\nMost cited:\n${s.join("\n")}` : ""}`;
    }
    case "data_status":
      return head + d.engines.filter((e) => e.captured).map((e) => `- ${ENGINE_LABEL[e.engine] || e.engine}: ${e.captured} captured, ${e.withAnswer} with an answer${e.usageLimit ? `, ${e.usageLimit} stopped by a usage limit` : ""}`).join("\n");
    case "find_answers":
      return d.found ? `${head}${d.found} answer${d.found === 1 ? "" : "s"} found${d.found > d.answers.length ? `; the newest ${d.answers.length}` : ""}:\n${d.answers.map((a) => `- ${a.engine}, ${a.date}: "${a.prompt}": ${a.excerpt}`).join("\n")}` : `${head}No answers in this scope match that.`;
    case "searches":
      return `${head}The engines ran ${d.total} searches (${d.perAnswer} per answer)${d.namingYou != null ? `; ${d.namingYou} named you` : ""}.`;
    case "cards":
      return `${head}${d.answersWithCards} answers showed product cards.${(d.byBrand || []).slice(0, 5).map((b) => `\n- ${b.brand}: ${b.cards} cards, first in ${b.firstCards}`).join("")}`;
    default: {
      if (d.byEngine) return head + d.byEngine.map((e) => `**${ENGINE_LABEL[e.engine] || e.engine}** (${e.answers} answers)\n${e.brands.slice(0, 5).map((b) => `- ${brandLine(b, e.answers)}`).join("\n")}`).join("\n\n");
      if (d.topics) return head + d.topics.map((t) => `- ${t.topic}: your visibility ${pct(t.yourVisibility)} in ${t.answers} answers; most often first: ${t.mostOftenFirst || "–"}`).join("\n");
      if (d.prompts) return head + d.prompts.map((x) => `- ${x.prompt}: you're named on ${x.yourBrandNamedIn} engines`).join("\n");
      if (!d.brands || !d.brands.length) return `${head}No tracked brand is named in these answers.`;
      const lines = d.brands.map((b) => `- ${brandLine(b, p.coverage.answers)}`);
      const ch = (d.changeSincePrevious || []).filter((c) => c.visibility != null && c.visibility !== 0).slice(0, 3).map((c) => `${c.brand} ${sign(c.visibility)}`);
      return `${head}${lines.join("\n")}${ch.length ? `\n\nSince the previous run (${fmtDate(d.previousRun)}): ${ch.join("; ")}.` : ""}`;
    }
  }
}
