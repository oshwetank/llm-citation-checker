/*
 * What Ask knows and how it answers (src/lib/askKnowledge.js and the
 * insight tools in assistantTools.js, 0.75.0). Run: node test/ask-knowledge.test.mjs
 */
import { PLAYBOOKS, playbooksFor, toolsFor, systemFor, checkNumbers, WHAT_IT_IS, definitions } from "../src/lib/askKnowledge.js";
import { TOOL_NAMES, runTool } from "../src/lib/assistantTools.js";
import { GLOSSARY } from "../src/lib/glossary.js";
import { profile, runs, records, Q2 } from "./helpers/campaign-fixture.mjs";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("the playbooks");
check("every playbook's tools exist", PLAYBOOKS.every((p) => p.tools.every((t) => TOOL_NAMES.includes(t))), PLAYBOOKS.flatMap((p) => p.tools.filter((t) => !TOOL_NAMES.includes(t))).join());
check("every playbook has steps and a worked example that calls a real tool", PLAYBOOKS.every((p) => p.steps.length >= 2 && /CALL (\w+)/.test(p.example) && TOOL_NAMES.includes(/CALL (\w+)/.exec(p.example)[1])));
const route = (q) => playbooksFor(q).map((p) => p.id);
const cases = [
  ["How visible is my brand in the latest campaign?", "visibility"],
  ["Which prompts am I missing from?", "gaps"],
  ["Where does Kovo beat us?", "rival"],
  ["Why did my visibility drop?", "drop"],
  ["Which sites should we get featured on?", "sources"],
  ["Which topics are we weak in?", "topics"],
  ["Do our products show up as cards?", "products"],
  ["Who advertises on our prompts?", "ads"],
  ["What should we do to win the gym prompt?", "content"],
  ["¿Por qué bajó mi visibilidad?", "drop"],
  ["Quels sites devrions-nous cibler ?", "sources"],
  ["Quais tópicos estão fracos?", "topics"],
  ["मेरे प्रतिस्पर्धी से तुलना करें", "rival"],
  ["لماذا انخفض ظهوري؟", "drop"],
];
for (const [q, want] of cases) check(`"${q}" → ${want}`, route(q)[0] === want, route(q).join());
check("an unclear question still gets the visibility playbook", route("hello")[0] === "visibility");

console.log("\nwhat is offered to the model");
for (const [q] of cases) { const t = toolsFor(q); if (t.length > 8) check(`at most 8 tools for "${q}"`, false, String(t.length)); }
check("never more than 8 tools, always the overview", cases.every(([q]) => toolsFor(q).length <= 8 && toolsFor(q).some((t) => t.function.name === "campaign_overview")));
const sys = systemFor("Why did my visibility drop?", { campaigns: ["Earbuds India"] });
check("says what isn't captured (no invented clicks or rankings)", sys.includes(WHAT_IT_IS) && /does NOT capture: clicks, traffic/.test(sys));
check("names the campaigns", /"Earbuds India"/.test(sys));
check("definitions come from the glossary, word for word", sys.includes(GLOSSARY.visibility.what) && sys.includes(GLOSSARY.shareOfVoice.formula));
check("the playbook's steps and example are in it", /usage limits/.test(sys) && /CALL data_quality/.test(sys));
check("it stays small enough for Chrome's built-in model", sys.length < 4500, String(sys.length));
check("definitions() skips unknown keys", definitions(["visibility", "nope"]).split("\n").length === 1);

console.log("\nthe new tools, on a made-up campaign");
const data = { records, profiles: [profile], runs };
const ov = runTool("campaign_overview", {}, data);
check("campaign_overview without naming the campaign (there is one)", ov.ok && ov.result.campaign === "Earbuds India" && ov.result.answers === 5 && ov.result.brands.find((b) => b.brand === "Zento").visibility === 40, JSON.stringify(ov.error || ov.result.brands));
check("…with the change since the previous run", ov.result.changeSincePrevious.find((c) => c.brand === "Zento").visibility === -60);
const ab = runTool("prompts_where_absent", { campaign: "earbuds" }, data);
check("prompts_where_absent: the gym prompt, with the answers to open", ab.ok && ab.result.count === 1 && ab.result.prompts[0].prompt === Q2 && ab.refs.length === 2, JSON.stringify(ab.result));
const rw = runTool("rival_wins", { brand: "Lumi" }, data);
check("rival_wins for one rival", rw.ok && rw.result.rivals.length === 1 && rw.result.rivals[0].aheadOfYou === 1);
const sg = runTool("source_gaps", {}, data);
check("source_gaps", sg.ok && sg.result.sites.map((x) => x.site).join() === "gadgets360.com,techradar.com");
check("own_site_share", runTool("own_site_share", {}, data).result.yourSiteShare === 14.3);
check("topic_breakdown", runTool("topic_breakdown", {}, data).result.topics[0].topic === "Earbuds");
check("engine_disagreement", runTool("engine_disagreement", {}, data).result.count === 2);
check("products_named, fanout_searches, ads_seen, data_quality", runTool("products_named", {}, data).result.answersWithCards === 1 && runTool("fanout_searches", {}, data).result.total === 2 && runTool("ads_seen", {}, data).result.advertisers[0].advertiser === "Kovo" && runTool("data_quality", {}, data).result.engines.some((e) => e.engine === "grok" && e.usageLimit === 1));
const pd = runTool("prompt_detail", { prompt: "gym earbuds" }, data);
check("prompt_detail finds the prompt by its words", pd.ok && pd.result.prompt === Q2 && pd.result.yourBrandNamedIn === "0 of 2 engines");
const gl = runTool("glossary", { term: "share of voice" }, data);
check("glossary", gl.ok && gl.result.formula === GLOSSARY.shareOfVoice.formula);
check("an unknown campaign still says which exist", /Earbuds India/.test(runTool("source_gaps", { campaign: "Shoes" }, data).error));

console.log("\nnumbers the tools didn't give are caught");
const res = [ov.result, ab.result];
check("numbers from the tools pass (40%, down 60, 66.7 written as 67)", checkNumbers("Zento was named in 40% of answers, down 60 points; Earbuds 67%.", [...res, { x: 66.7 }]).unverified.length === 0);
const bad = checkNumbers("Zento has 73% visibility and 1,250 mentions.", res);
check("an invented 73% and 1,250 are flagged", bad.unverified.join() === "73,1,250", bad.unverified.join());
check("small counts and years aren't flagged", checkNumbers("2 engines, 3 prompts, in 2026.", res).unverified.length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
