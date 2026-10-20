#!/usr/bin/env node
/*
 * eval.mjs — how well a model answers Ask's questions (0.75.0).
 *
 *   node training/eval.mjs --data training/data/test.jsonl --oracle
 *   node training/eval.mjs --data training/data/test.jsonl --openai http://localhost:11434/v1 --model citoskeleton-qwen
 *
 * The model is run the way the extension runs it (lib/assistant.js): the
 * same system prompt and tools, its tool calls executed by the extension's
 * own code on the same made-up campaign, up to four rounds. Each answer is
 * scored on what the owner asked for — answers that are thorough and right:
 *   tools      the calls a complete answer needs were made (share of them)
 *   args       every call it made worked (a real campaign, brand, term)
 *   faithful   no number in the answer that its tools didn't return
 *   complete   the key numbers of the reference answer are in it
 *   language   it answered in the question's language
 *   honest     for what isn't captured (clicks, rankings): no tool, says so
 * --oracle replays the reference answers, so it must score 100%: a check on
 * the scorer itself. --openai talks to any OpenAI-compatible server (Ollama,
 * LM Studio, llama.cpp, vLLM), so a base model and a fine-tuned one can be
 * compared on this computer. Reports per kind of question and per language.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { rng, makeCampaign } from "./synth.mjs";
import { campSeed } from "./gen.mjs";
import { runTool, TOOL_NAMES } from "../src/lib/assistantTools.js";
import { parseToolCalls, finalText } from "../src/lib/assistant.js";
import { checkNumbers, numbersIn } from "../src/lib/askKnowledge.js";

/** The language an answer is written in, roughly. */
export function langOf(text) {
  // Quoted prompts and site names are in whatever language they were written in.
  const t = String(text || "").replace(/“[^”]*”|«[^»]*»|"[^"]*"|\S+\.example\b/g, " ");
  if (/[ऀ-ॿ]/.test(t)) return "hi";
  if (/[؀-ۿ]/.test(t)) return "ar";
  const w = ` ${t.toLowerCase().replace(/[^\p{L}\s]/gu, " ")} `;
  const score = (words) => words.reduce((n, x) => n + (w.split(` ${x} `).length - 1), 0);
  const s = { es: score(["de", "las", "respuestas", "con", "que", "en", "una", "los", "y"]), pt: score(["de", "das", "respostas", "com", "que", "em", "uma", "os", "não"]), fr: score(["de", "des", "réponses", "avec", "que", "dans", "une", "les", "et"]), en: score(["the", "of", "answers", "with", "and", "in", "is", "was", "on"]) };
  // Portuguese and Spanish share words; their own words decide.
  if (/\b(não|você|são|também)\b/.test(w)) s.pt += 3;
  if (/\b(también|está|según)\b/.test(w)) s.es += 3;
  return Object.entries(s).sort((a, b) => b[1] - a[1])[0][0];
}

/** Score one finished conversation against its reference. */
export function score(ex, run) {
  const gold = ex.meta.calls.map((c) => c.name);
  const called = run.steps.map((s) => s.tool);
  const goldAnswer = ex.messages.at(-1).content;
  const keyNums = numbersIn(goldAnswer).filter((x) => !(Number.isInteger(x.n) && x.n <= 10) && !(x.n >= 1990 && x.n <= 2100));
  const got = numbersIn(run.answer).map((x) => x.n);
  const found = keyNums.filter((k) => got.some((g) => Math.abs(g - k.n) <= 0.15 || Math.round(k.n) === g)).length;
  const s = {
    tools: gold.length ? gold.filter((g) => called.includes(g)).length / gold.length : 1,
    args: run.steps.length ? run.steps.filter((x) => x.ok).length / run.steps.length : 1,
    faithful: checkNumbers(run.answer, run.results).unverified.length === 0 ? 1 : 0,
    complete: keyNums.length ? found / keyNums.length : (run.answer.trim().length > 20 ? 1 : 0),
    language: langOf(run.answer) === ex.meta.lang ? 1 : 0,
  };
  if (ex.meta.kind === "notCaptured") s.honest = called.length === 0 && /captur|captura|capture|कैप्चर|يلتقط/i.test(run.answer) ? 1 : 0;
  const vals = Object.values(s);
  s.overall = vals.reduce((a, b) => a + b, 0) / vals.length;
  return s;
}

/** Run one question through a model the way Ask does. */
export async function runOne(ex, generate, { maxSteps = 4 } = {}) {
  const [seed, ci] = ex.meta.campaign || [];
  const camp = makeCampaign(rng(campSeed(seed, ci)), ci);
  const data = { records: camp.records, profiles: [camp.profile], runs: camp.runs };
  const messages = ex.messages.slice(0, 2).map((m) => ({ ...m }));
  const tools = ex.tools.map((f) => ({ type: "function", function: f }));
  const steps = [], results = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = await generate({ messages, tools, ex, step: i });
    const calls = r.toolCalls || parseToolCalls(r.text);
    if (!calls.length) return { answer: finalText(r.text), steps, results };
    messages.push({ role: "assistant", content: r.text || "", tool_calls: calls.map((c) => ({ type: "function", function: { name: c.name, arguments: c.args } })) });
    for (const c of calls.slice(0, 3)) {
      const res = TOOL_NAMES.includes(c.name) ? runTool(c.name, c.args || {}, data) : { ok: false, error: `Unknown tool ${c.name}` };
      steps.push({ tool: c.name, ok: !!res.ok });
      if (res.ok) results.push(res.result);
      messages.push({ role: "tool", name: c.name, content: JSON.stringify(res.ok ? res.result : { error: res.error }).slice(0, 6000) });
    }
  }
  messages.push({ role: "user", content: "Answer now from the tool results above, without calling more tools." });
  const r = await generate({ messages, tools: null, ex, step: maxSteps });
  return { answer: finalText(r.text), steps, results };
}

/** The reference conversation, replayed. */
export function oracle() {
  return async ({ ex, step }) => {
    const asst = ex.messages.filter((m) => m.role === "assistant");
    const m = asst[step] || asst.at(-1);
    if (m.tool_calls && m.tool_calls.length) return { text: "", toolCalls: m.tool_calls.map((t) => ({ name: t.function.name, args: t.function.arguments })) };
    return { text: m.content };
  };
}

/** Any OpenAI-compatible server. */
export function openai(base, model, apiKey = "") {
  return async ({ messages, tools }) => {
    const body = {
      model, temperature: 0, max_tokens: 700,
      messages: messages.map((m) => (m.tool_calls ? { role: "assistant", content: m.content || "", tool_calls: m.tool_calls.map((t, i) => ({ id: `c${i}`, type: "function", function: { name: t.function.name, arguments: JSON.stringify(t.function.arguments) } })) } : m.role === "tool" ? { role: "tool", tool_call_id: "c0", name: m.name, content: m.content } : m)),
      ...(tools ? { tools } : {}),
    };
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const j = await res.json();
    const msg = j.choices[0].message;
    const toolCalls = (msg.tool_calls || []).map((t) => ({ name: t.function.name, args: (() => { try { return JSON.parse(t.function.arguments || "{}"); } catch (_) { return {}; } })() }));
    return { text: msg.content || "", toolCalls: toolCalls.length ? toolCalls : null };
  };
}

/** Mean scores per group. */
export function summarize(rows) {
  const by = (key) => {
    const g = {};
    for (const r of rows) (g[key(r)] = g[key(r)] || []).push(r.score);
    return Object.fromEntries(Object.entries(g).map(([k, xs]) => [k, mean(xs)]));
  };
  return { all: mean(rows.map((r) => r.score)), byKind: by((r) => r.kind), byLang: by((r) => r.lang), n: rows.length };
}
function mean(xs) {
  const keys = [...new Set(xs.flatMap((x) => Object.keys(x)))];
  return Object.fromEntries(keys.map((k) => { const v = xs.map((x) => x[k]).filter((x) => x != null); return [k, Math.round((v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)) * 1000) / 10]; }));
}

async function main() {
  const a = Object.fromEntries(process.argv.slice(2).map((x, i, xs) => (x.startsWith("--") ? [x.slice(2), xs[i + 1] && !xs[i + 1].startsWith("--") ? xs[i + 1] : true] : null)).filter(Boolean));
  const rows = readFileSync(a.data || "training/data/test.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, Number(a.limit || 1e9));
  const gen = a.oracle ? oracle() : a.openai ? openai(a.openai, a.model || "default", process.env.OPENAI_API_KEY || "") : null;
  if (!gen) { console.error("usage: eval.mjs --data test.jsonl (--oracle | --openai URL --model NAME) [--limit N] [--out report.json]"); process.exit(1); }
  const out = [];
  for (const ex of rows) {
    try {
      const run = await runOne(ex, gen);
      out.push({ kind: ex.meta.kind, lang: ex.meta.lang, score: score(ex, run) });
    } catch (e) {
      out.push({ kind: ex.meta.kind, lang: ex.meta.lang, score: { overall: 0, error: 1 } });
    }
    if (out.length % 50 === 0) process.stderr.write(`${out.length}/${rows.length}\n`);
  }
  const sum = summarize(out);
  console.log(JSON.stringify(sum, null, 2));
  if (a.out) writeFileSync(a.out, JSON.stringify(sum, null, 2));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
