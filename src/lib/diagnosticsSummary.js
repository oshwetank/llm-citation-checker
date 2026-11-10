/* diagnosticsSummary.js — the per-run expected/stored/missing/failed
 * counts and failure-reason histogram for the campaign-diagnostics export
 * (see "get-campaign-diagnostics" in background.js).
 *
 * Pulled out of the old .xls campaign workbook's Diagnostics sheet, which
 * built this inline; that workbook gave way to the .xlsx export in 0.52.0
 * and this file keeps only the arithmetic.
 */

/**
 * @param {object} bundle - { runs, records, errors }
 * @param {Map<string, number>} runNo - run id -> its 1-based display number
 *   (a caller without one can pass an empty Map and get `undefined` run
 *   numbers rather than recomputing the same ordering).
 */
export function summarizeRunDiagnostics(bundle, runNo = new Map()) {
  const runs = bundle.runs || [];
  const orderedRuns = [...runs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const perRun = orderedRuns.map((r) => {
    // Prompts answered, not captures: one prompt can arrive as several
    // captures (see oneCapturePerPrompt in geo.js), and counting those read
    // "stored 67" against 40 expected in a real export.
    const runRecords = (bundle.records || []).filter((x) => x.geo && x.geo.runId === r.id);
    // An engine's refusal (ChatGPT's "Message limit reached" card, a usage
    // limit) is a capture but not an answer (0.78.1): it is counted apart.
    const isAnswer = (x) => !(x.platformSpecific && x.platformSpecific.gatewayError) || (x.answerChars || 0) > 0;
    const key = (x) => (x.geo.promptId ? `${x.platform}|${x.geo.promptId}` : x);
    const answeredKeys = new Set(runRecords.filter(isAnswer).map(key));
    const stored = answeredKeys.size;
    const limited = new Set(runRecords.filter((x) => !isAnswer(x)).map(key).filter((k) => !answeredKeys.has(k))).size;
    const missing = Math.max(0, (r.expected || 0) - stored);
    const byEngine = {};
    for (const e of r.engines || []) {
      const mine = runRecords.filter((x) => x.platform === e);
      const ans = new Set(mine.filter(isAnswer).map(key));
      byEngine[e] = { answered: ans.size, limited: new Set(mine.filter((x) => !isAnswer(x)).map(key).filter((k) => !ans.has(k))).size, reasons: (r.reasonsBy || {})[e] || {} };
    }
    return {
      runId: r.id,
      runNo: runNo.get(r.id),
      startedAt: r.startedAt,
      status: r.status || "",
      expected: r.expected || 0,
      stored,
      captures: runRecords.length,
      missing,
      failed: r.failed || 0,
      reasons: r.reasons || {},
      limited,
      byEngine,
    };
  });
  return { perRun, errors: bundle.errors || [] };
}
