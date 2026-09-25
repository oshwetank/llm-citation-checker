/*
 * diagnostics-summary.test.mjs — the per-run expected/stored/missing/failed
 * arithmetic, pulled out of campaignWorkbook.js so the workbook's
 * Diagnostics sheet and the campaign-diagnostics export (get-campaign-
 * diagnostics in background.js) compute the same numbers from the same
 * code, instead of two implementations that could quietly drift apart.
 *
 * campaign-workbook.test.mjs already proves the workbook's OWN output is
 * correct after this extraction (same rows, same numbers). This file tests
 * the extracted function directly and in isolation, since it now has a
 * second caller with no workbook `idx` to hand it.
 */
import { summarizeRunDiagnostics } from "../src/lib/diagnosticsSummary.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nPer-run counts: missing is expected minus what actually got stored");
{
  const bundle = {
    runs: [
      { id: "r1", startedAt: 100, status: "done", expected: 10, failed: 2, reasons: { timeout: 2 } },
      { id: "r2", startedAt: 200, status: "done", expected: 5, failed: 0, reasons: {} },
    ],
    records: [
      { geo: { runId: "r1" } }, { geo: { runId: "r1" } }, { geo: { runId: "r1" } },
      { geo: { runId: "r2" } }, { geo: { runId: "r2" } }, { geo: { runId: "r2" } },
      { geo: { runId: "r2" } }, { geo: { runId: "r2" } },
    ],
    errors: [{ where: "run:turn-failed:chatgpt", message: "timeout", count: 2, lastAt: 150 }],
  };
  const { perRun, errors } = summarizeRunDiagnostics(bundle, new Map([["r1", 1], ["r2", 2]]));

  check("two runs in, two rows out, oldest first", perRun.length === 2 && perRun[0].runId === "r1", JSON.stringify(perRun.map((r) => r.runId)));
  check("run 1 stored count matches its own records only", perRun[0].stored === 3, String(perRun[0].stored));
  check("run 1 missing = expected(10) - stored(3)", perRun[0].missing === 7, String(perRun[0].missing));
  check("run 2 is fully stored, so nothing is missing", perRun[1].stored === 5 && perRun[1].missing === 0, JSON.stringify(perRun[1]));
  check("failure reasons travel through untouched", perRun[0].reasons.timeout === 2, JSON.stringify(perRun[0].reasons));
  check("runNo is looked up from the map passed in", perRun[0].runNo === 1 && perRun[1].runNo === 2);
  check("the error summary passes through unchanged", errors === bundle.errors);
}

console.log("\nA record for a DIFFERENT run never gets counted against this one");
{
  // The bug this arithmetic exists to prevent: over-counting "stored" by
  // matching records loosely instead of by runId.
  const bundle = {
    runs: [{ id: "r1", startedAt: 100, expected: 3, failed: 0, reasons: {} }],
    records: [{ geo: { runId: "r1" } }, { geo: { runId: "OTHER-RUN" } }, { geo: null }],
  };
  const { perRun } = summarizeRunDiagnostics(bundle);
  check("only the matching run's records are counted", perRun[0].stored === 1, String(perRun[0].stored));
}

console.log("\nRuns are always ordered oldest-first, regardless of input order");
{
  const bundle = {
    runs: [
      { id: "late", startedAt: 900, expected: 1, reasons: {} },
      { id: "early", startedAt: 100, expected: 1, reasons: {} },
    ],
    records: [],
  };
  const { perRun } = summarizeRunDiagnostics(bundle);
  check("oldest run comes first even when the input array doesn't",
    perRun[0].runId === "early" && perRun[1].runId === "late", JSON.stringify(perRun.map((r) => r.runId)));
}

console.log("\nDegenerate input never throws");
{
  check("an empty bundle yields empty output", (() => {
    const r = summarizeRunDiagnostics({});
    return r.perRun.length === 0 && r.errors.length === 0;
  })());
  check("no runNo map still returns a defined shape, just undefined run numbers", (() => {
    const r = summarizeRunDiagnostics({ runs: [{ id: "x", expected: 1, reasons: {} }], records: [] });
    return r.perRun.length === 1 && r.perRun[0].runNo === undefined;
  })());
  check("a run with no `reasons` field defaults to an empty object, not a throw", (() => {
    const r = summarizeRunDiagnostics({ runs: [{ id: "x", expected: 1 }], records: [] });
    return typeof r.perRun[0].reasons === "object";
  })());
}

// A real export read "expected 40 stored 67 missing 0": Gemini and
// Perplexity deliver several captures per prompt, and every one was counted.
console.log("\nSeveral captures of one prompt are one answered prompt");
{
  const cap = (platform, promptId) => ({ platform, geo: { runId: "r1", promptId } });
  const { perRun } = summarizeRunDiagnostics({
    runs: [{ id: "r1", expected: 4, reasons: {} }],
    records: [cap("gemini", "a"), cap("gemini", "a"), cap("gemini", "a"), cap("gemini", "b"), cap("perplexity", "a"), cap("perplexity", "a")],
  });
  check("three prompt-engine pairs answered, from six captures", perRun[0].stored === 3 && perRun[0].captures === 6, JSON.stringify(perRun[0]));
  check("so one is missing, not a surplus", perRun[0].missing === 1, perRun[0].missing);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
