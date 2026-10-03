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
    const stored = new Set(runRecords.map((x) => (x.geo.promptId ? `${x.platform}|${x.geo.promptId}` : x))).size;
    const missing = Math.max(0, (r.expected || 0) - stored);
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
    };
  });
  return { perRun, errors: bundle.errors || [] };
}
