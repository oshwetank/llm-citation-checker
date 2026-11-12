/*
 * getting-started.test.mjs — the help a first-time user gets (1.0.0): the Get
 * started checklist, how sure a campaign number is, what to do next, and
 * prompts to start a campaign from. Run: node test/getting-started.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checklist, CHECKLIST_STEPS, margin, sureness, campaignAdvice, ADVICE, examplePrompts, PROMPT_TEMPLATES } from "../src/lib/onboarding.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nGet started");
{
  const none = checklist({});
  check("five steps, none done on a fresh install", none.total === 5 && none.done === 0 && none.next.id === "capture");
  const some = checklist({ captured: true, analyzed: true, campaigns: 1 });
  check("ticked off by what was done, in order", some.done === 3 && some.next.id === "run", JSON.stringify(some.next));
  check("complete once a campaign's results were read", checklist({ captured: true, analyzed: true, campaigns: 2, ran: true, sawResults: true }).complete);
  check("each step says where to go", CHECKLIST_STEPS.every((s) => s.label && s.hint && s.go));
}

console.log("\nhow sure a number is");
{
  const big = margin(30, 1000), small = margin(30, 12);
  check("30% over 1,000 answers: about ±2.8 points", big > 2.6 && big < 3.0, String(big));
  check("30% over 12 answers: about ±26 points", small > 24 && small < 28, String(small));
  check("0 of 5 isn't certain either", margin(0, 5) > 10, String(margin(0, 5)));
  check("nothing to say without answers", margin(30, 0) === null && margin(null, 10) === null);
  check("few under 30, some under 100, good from 100", sureness(12) === "few" && sureness(30) === "some" && sureness(99) === "some" && sureness(100) === "good" && sureness(undefined) === "few");
}

console.log("\nwhat to do next");
{
  const a = campaignAdvice({ brand: "Zento", answered: 12, ownVis: 25, rival: { name: "Kovo", vis: 58 }, ownSiteCitations: 0, gaps: 3 });
  check("at most three, the rival first", a.length === 3 && a[0].id === "rival", a.map((x) => x.id).join());
  check("the sample size is not repeated as advice (it is said beside the numbers)", !a.some((x) => x.id === "few"));
  check("one answer reads as one", a.find((x) => x.id === "gaps").one.includes("{n} answer "));
  check("a rival named in more answers is said with both numbers", a.some((x) => x.id === "rival" && x.vars.theirs === 58 && x.vars.ours === 25 && x.go === "cv-compare"));
  check("each points at the section that shows why", a.every((x) => /^cv-/.test(x.go)));
  const lead = campaignAdvice({ brand: "Zento", answered: 400, ownVis: 70, rival: { name: "Kovo", vis: 40 }, ownSiteCitations: 5, gaps: 0 });
  check("ahead, with plenty of answers: one line, about keeping it", lead.length === 1 && lead[0].id === "leading", lead.map((x) => x.id).join());
  check("no answers, no advice", campaignAdvice({ brand: "Zento", answered: 0 }).length === 0);
  const slots = Object.entries(ADVICE).filter(([id]) => id !== "gapsOne").filter(([id, t]) => { const r = campaignAdvice({ brand: "B", answered: id === "few" ? 5 : 500, ownVis: id === "leading" ? 60 : 10, rival: { name: "R", vis: id === "leading" ? 20 : 50 }, ownSiteCitations: id === "noOwnSite" ? 0 : 1, gaps: id === "gaps" ? 2 : 0 }).find((x) => x.id === id); return !r || [...t.matchAll(/\{(\w+)\}/g)].some((m) => !(m[1] in r.vars)); }).map(([id]) => id);
  check("every sentence can be produced, with a value for each of its slots", slots.length === 0, slots.join());
}

console.log("\nprompts to start from");
{
  const all = examplePrompts({ category: "running shoes", brand: "Zento", rival: "Kovo", year: 2026 });
  check("ten prompts, with tags", all.length === PROMPT_TEMPLATES.length && all.every((p) => p.template && p.tags), String(all.length));
  check("the brand and competitor ones only when both are given", examplePrompts({ category: "running shoes" }).every((p) => !/\{brand\}|\{rival\}/.test(p.template)) && examplePrompts({ category: "running shoes", brand: "Zento" }).some((p) => /\{brand\}/.test(p.template)));
  check("nothing without a category", examplePrompts({ brand: "Zento" }).length === 0);
  check("the year is text, so it is never written as 2,026", examplePrompts({ category: "x", year: 2026 }).every((p) => typeof p.vars.year === "string"));
}

console.log("\nevery sentence is in every language");
{
  const dicts = Object.fromEntries(["es", "pt-BR", "fr", "hi", "ar"].map((l) => [l, JSON.parse(readFileSync(path.join(ROOT, "ui/i18n", `${l}.json`), "utf8"))]));
  const keys = [...CHECKLIST_STEPS.flatMap((s) => [s.label, s.hint]), ...Object.values(ADVICE), ...PROMPT_TEMPLATES.map((p) => p.t)];
  for (const [l, d] of Object.entries(dicts)) {
    const missing = keys.filter((k) => !(k in d));
    check(`${l}: all ${keys.length}`, missing.length === 0, missing.slice(0, 3).join(" | "));
  }
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
