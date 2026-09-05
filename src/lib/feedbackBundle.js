/*
 * feedbackBundle.js — assembles what someone sends the developer when a
 * capture looks wrong.
 *
 * Every real bug in this tool so far was diagnosed from exactly three things
 * put side by side: the RAW payload the engine returned, the DERIVED record
 * built from it, and a sentence about what looked wrong. The exported report
 * is the fourth, because it shows what the reporter was actually looking at
 * (the Grok citation-tag bug was visible only in the PDF). Anything less and
 * the first reply is always "can you send the raw capture too".
 *
 * NOTHING here is transmitted. The bundle is built in the page, saved by the
 * person who chose to save it, and sent by them — the same rule the
 * diagnostic report in the About tab follows, and the reason this extension
 * can keep saying nothing leaves your device. The trade-off is stated plainly
 * in the dialog: unlike the diagnostic report, this bundle DOES contain the
 * prompt, the answer and the URLs, because that is the evidence. Each part is
 * individually optional so the reporter decides.
 */

/** What each part of the bundle contains, in the reporter's words. */
export const BUNDLE_PARTS = [
  { key: "note", file: "feedback.txt", label: "Your note + app version",
    detail: "What you typed, the extension version, and the browser's user-agent string." },
  { key: "report", file: "report.html", label: "The report you were looking at",
    detail: "The same document Save as PDF produces — open it and print to PDF. Contains the prompt and the answer text." },
  { key: "raw", file: "raw-capture.txt", label: "Raw engine payload",
    detail: "Exactly what the engine returned, unmodified. Contains the prompt, the full answer and every source URL." },
  { key: "analysis", file: "analysis.json", label: "What the tool made of it",
    detail: "The derived record: brand mentions, sources, fan-out. This is what a wrong result is visible in." },
];

const stamp = (d) => {
  const x = d instanceof Date && !isNaN(d) ? d : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}-${p(x.getHours())}${p(x.getMinutes())}`;
};

/** A stable, human-readable filename for the archive. */
export function bundleFilename(record, now) {
  const platform = String((record && record.platform) || "capture").replace(/[^a-z0-9]+/gi, "-");
  return `citoskeleton-feedback-${platform}-${stamp(now)}.zip`;
}

export function buildNoteFile({ note, record, env, include }) {
  const lines = [];
  lines.push("CitoSkeleton feedback");
  lines.push("=====================");
  lines.push("");
  lines.push("What looked wrong:");
  lines.push((note || "").trim() || "(the reporter did not write anything here)");
  lines.push("");
  lines.push("Capture");
  lines.push(`  id        : ${(record && record.captureId) || "—"}`);
  lines.push(`  engine    : ${(record && record.platform) || "—"}`);
  lines.push(`  model     : ${(record && record.model) || "—"}`);
  lines.push(`  captured  : ${record && record.capturedAt ? new Date(record.capturedAt).toISOString() : "—"}`);
  lines.push(`  prompt    : ${(record && record.userPrompt) || "—"}`);
  // The three numbers that make a wrong result obvious at a glance, so the
  // note alone is often enough to tell which subsystem to look at.
  const brands = (record && record.brandMentions) || [];
  const sources = (record && record.sources) || [];
  const fan = (record && record.fanout && record.fanout.search) || [];
  lines.push(`  brands    : ${brands.length}${brands.length ? " — " + brands.map((b) => b.brand).join(", ") : ""}`);
  lines.push(`  sources   : ${sources.length}`);
  lines.push(`  fan-out   : ${fan.length}${fan.length ? " — " + fan.map((f) => (typeof f === "string" ? f : f && f.query) || "").filter(Boolean).join(" | ") : ""}`);
  lines.push("");
  lines.push("Environment");
  lines.push(`  extension : ${(env && env.version) || "—"}`);
  lines.push(`  browser   : ${(env && env.userAgent) || "—"}`);
  lines.push("");
  lines.push("Included in this bundle");
  for (const part of BUNDLE_PARTS) {
    if (part.key === "note") continue;
    lines.push(`  ${include && include[part.key] ? "[x]" : "[ ]"} ${part.file} — ${part.label}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The file list for makeZip(). Pure: every input is passed in, so this is
 * testable without a browser and without touching storage.
 *
 * @param {object} o
 * @param {string} o.note        what the reporter typed
 * @param {object} o.record      the derived record
 * @param {string} [o.raw]       raw engine payload (already header-prefixed)
 * @param {string} [o.reportHtml] standalone report document
 * @param {object} [o.env]       { version, userAgent }
 * @param {object} [o.include]   { report, raw, analysis } — note is always in
 */
export function buildFeedbackFiles({ note, record, raw, reportHtml, env, include } = {}) {
  const want = { report: true, raw: true, analysis: true, ...(include || {}) };
  const files = [{ name: "feedback.txt", text: buildNoteFile({ note, record, env, include: want }) }];
  if (want.report && reportHtml) files.push({ name: "report.html", text: reportHtml });
  if (want.raw && raw) files.push({ name: "raw-capture.txt", text: raw });
  if (want.analysis && record) {
    files.push({ name: "analysis.json", text: JSON.stringify(record, null, 2) });
  }
  return files;
}
