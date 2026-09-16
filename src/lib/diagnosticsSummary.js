/* diagnosticsSummary.js — the per-run expected/stored/missing/failed
 * counts and failure-reason histogram, computed once so the campaign
 * workbook's Diagnostics sheet and the campaign-diagnostics export (see
 * "get-campaign-diagnostics" in background.js) read the same numbers
 * instead of two independent implementations quietly drifting apart.
 *
 * Pulled out of campaignWorkbook.js's sheetDiagnostics, which built this
 * same data inline before also formatting it as XML rows in the same
 * breath — this file keeps only the arithmetic.
 */

/**
 * @param {object} bundle - { runs, records, errors }
 * @param {Map<string, number>} runNo - run id -> its 1-based display number
 *   (campaignWorkbook.js's buildIndexes already computes this; the new
 *   export handler that has no workbook `idx` can pass an empty Map and
 *   get `undefined` run numbers rather than recomputing the same ordering).
 */
export function summarizeRunDiagnostics(bundle, runNo = new Map()) {
  const runs = bundle.runs || [];
  const orderedRuns = [...runs].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const perRun = orderedRuns.map((r) => {
    const stored = (bundle.records || []).filter((x) => x.geo && x.geo.runId === r.id).length;
    const missing = Math.max(0, (r.expected || 0) - stored);
    return {
      runId: r.id,
      runNo: runNo.get(r.id),
      startedAt: r.startedAt,
      status: r.status || "",
      expected: r.expected || 0,
      stored,
      missing,
      failed: r.failed || 0,
      reasons: r.reasons || {},
    };
  });
  return { perRun, errors: bundle.errors || [] };
}
