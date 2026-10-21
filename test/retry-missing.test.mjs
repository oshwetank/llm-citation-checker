/*
 * retry-missing.test.mjs — what a finished run is missing, and how the
 * diagnostics count it (0.78.1).
 *
 * From the owner's Sunban Windows campaign: 752 turns, 101 with no answer
 * (65 the send button never accepted, 28 sent with no answer), and on top of
 * those, ChatGPT's "Message limit reached" card stored as if it were an
 * answer. "Retry missing" asks only the prompts each engine has no answer
 * for, into the same run; a refusal is not an answer, so it is missing too.
 * Made-up prompts and brands.
 */
import { missingTurns } from "../src/lib/geo.js";
import { summarizeRunDiagnostics } from "../src/lib/diagnosticsSummary.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const prompts = ["p1", "p2", "p3", "p4"].map((id, i) => ({ id, text: `prompt ${i + 1}`, tags: [], createdAt: i }));
const run = { id: "r1", profileId: "c1", engines: ["chatgpt", "gemini"], promptIds: ["p1", "p2", "p3", "p4"], expected: 8, failed: 3, captured: 5, status: "done", startedAt: 1,
  reasons: { "submit: send control never accepted the prompt": 2, "timeout: sent, no answer captured": 1 },
  reasonsBy: { gemini: { "submit: send control never accepted the prompt": 2 }, chatgpt: { "timeout: sent, no answer captured": 1 } } };
const rec = (platform, promptId, o = {}) => ({ platform, geo: { profileId: "c1", runId: "r1", promptId }, answerChars: 500, answerText: "Zento is the pick.", ...o });
const limitCard = (promptId) => rec("chatgpt", promptId, { answerChars: 0, answerText: "", platformSpecific: { gatewayError: "anonymous message limit" } });
const records = [
  rec("chatgpt", "p1"), rec("chatgpt", "p2"), limitCard("p3"),
  rec("gemini", "p1"), rec("gemini", "p4"),
  rec("gemini", "p2", { geo: { profileId: "c1", runId: "OTHER", promptId: "p2" } }),
];

console.log("\nwhat the run is missing, engine by engine");
{
  const m = missingTurns(run, prompts, records);
  check("ChatGPT: the limit card and the prompt never answered", JSON.stringify(m.only.chatgpt) === JSON.stringify([2, 3]), JSON.stringify(m.only.chatgpt));
  check("Gemini: the two it has nothing for (an answer from another run doesn't count)", JSON.stringify(m.only.gemini) === JSON.stringify([1, 2]), JSON.stringify(m.only.gemini));
  check("four turns in all, positions in the run's own prompt order", m.count === 4 && m.prompts.map((p) => p.id).join() === "p1,p2,p3,p4");
  const fewer = missingTurns(run, prompts.filter((p) => p.id !== "p4"), records);
  check("a prompt deleted since isn't asked again", fewer.prompts.length === 3 && !fewer.only.chatgpt.includes(3), JSON.stringify(fewer.only));
  check("nothing missing, nothing to retry", missingTurns(run, prompts, [...records, limitCard("x"), rec("chatgpt", "p3"), rec("chatgpt", "p4"), rec("gemini", "p2"), rec("gemini", "p3")]).count === 0);
}

console.log("\nthe diagnostics: refusals apart, reasons by engine");
{
  const { perRun } = summarizeRunDiagnostics({ runs: [run], records });
  const r = perRun[0];
  check("answered counts answers only, not the limit card", r.stored === 4, String(r.stored));
  check("the refusal is counted on its own", r.limited === 1, String(r.limited));
  check("missing is what has no answer", r.missing === 4, String(r.missing));
  check("per engine: answered, refused, and which reasons happened there", r.byEngine.chatgpt.answered === 2 && r.byEngine.chatgpt.limited === 1 && r.byEngine.gemini.answered === 2 && r.byEngine.gemini.reasons["submit: send control never accepted the prompt"] === 2, JSON.stringify(r.byEngine));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
