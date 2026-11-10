/*
 * run-compare.test.mjs — one campaign run against another, and the newest
 * answers across runs (0.80.0).
 *
 * Asked: running the same campaign on the same engine again should show
 * what changed; and running ChatGPT on one day and Gemini on another should
 * read as one campaign, not each run hiding the one before. Made-up
 * Zento/Kovo/Lumora answers.
 */
import { compareRuns } from "../src/lib/runCompare.js";
import { latestAnswers } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const brands = [{ name: "Zento", isOwn: true }, { name: "Kovo" }, { name: "Lumora" }];
const prompts = [{ id: "p1", text: "best linen shirt" }, { id: "p2", text: "linen shirt for summer" }];
let at = 1000;
const rec = (runId, promptId, platform, answerText, cited = []) => ({
  captureId: `${runId}-${promptId}-${platform}`, platform, capturedAt: at++, answerText,
  userPrompt: prompts.find((p) => p.id === promptId).text,
  geo: { profileId: "c1", runId, promptId },
  brandMentions: [], sources: cited.map((d) => ({ domain: d, url: `https://${d}/x`, outcome: "cited" })),
});

console.log("\nrun against run, same engine");
{
  const run1 = [
    rec("r1", "p1", "chatgpt", "Kovo is the pick. Zento is close behind.", ["stylelab.example"]),
    rec("r1", "p2", "chatgpt", "Zento leads, then Kovo.", ["stylelab.example"]),
  ];
  const run2 = [
    rec("r2", "p1", "chatgpt", "Zento is the pick. Kovo and Lumora follow.", ["fabricdesk.example"]),
    rec("r2", "p2", "chatgpt", "Kovo leads. Lumora is cheaper.", ["stylelab.example"]),
    rec("r2", "p1", "gemini", "Lumora first.", []),
  ];
  const c = compareRuns(run1, run2, { brands, prompts });
  check("only prompt × engine pairs both runs answered are compared", c.compared === 2 && c.onlyB === 1, JSON.stringify([c.compared, c.onlyA, c.onlyB]));
  const p1 = c.rows.find((r) => r.prompt === "best linen shirt");
  const p2 = c.rows.find((r) => r.prompt === "linen shirt for summer");
  check("your brand moved up on one prompt (2nd → 1st)", p1 && p1.a.pos === 2 && p1.b.pos === 1 && p1.change === "better", JSON.stringify(p1));
  check("and dropped out on the other", p2 && p2.a.pos === 1 && p2.b.pos === null && p2.change === "worse", JSON.stringify(p2));
  check("worse first in the list", c.rows[0].change === "worse");
  check("brands that came in and went", p1.gained.join() === "Lumora" && p2.lost.join() === "Zento" && p2.gained.join() === "Lumora");
  check("who came first changed on both", c.summary.firstChanged === 2 && p1.a.first === "Kovo" && p1.b.first === "Zento");
  const z = c.brands.find((b) => b.name === "Zento");
  check("your brand's visibility in each run, and the change", z.a.visibility === 100 && z.b.visibility === 50 && z.dVisibility === -50, JSON.stringify(z));
  check("own brand listed first", c.brands[0].name === "Zento");
  const l = c.brands.find((b) => b.name === "Lumora");
  check("a brand absent from the first run reads 0 → 100", l && l.a.visibility === 0 && l.b.visibility === 100);
  const fd = c.sites.find((s) => s.domain === "fabricdesk.example");
  check("sites cited in each run", fd && fd.a === 0 && fd.b === 1 && c.sites.find((s) => s.domain === "stylelab.example").a === 2);
}

console.log("\nthe newest answers across runs");
{
  const mon = [rec("m", "p1", "chatgpt", "Zento."), rec("m", "p2", "chatgpt", "Kovo.")];
  const tue = [rec("t", "p1", "gemini", "Lumora."), rec("t", "p2", "gemini", "Zento.")];
  const wed = [rec("w", "p1", "chatgpt", "Kovo again.")];
  const l = latestAnswers([...mon, ...tue, ...wed]);
  check("one answer per prompt and engine: 2 prompts × 2 engines", l.length === 4, l.length);
  check("ChatGPT from Monday stays beside Gemini from Tuesday", l.some((r) => r.captureId === "m-p2-chatgpt") && l.some((r) => r.captureId === "t-p1-gemini"));
  check("the newer ChatGPT answer replaces the older one", l.some((r) => r.captureId === "w-p1-chatgpt") && !l.some((r) => r.captureId === "m-p1-chatgpt"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
