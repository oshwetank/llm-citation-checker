/*
 * export.js — the print-to-PDF page. Opened by panel.js as
 * chrome.runtime.getURL("ui/export.html?ids=<id,id,...>") in a new tab. Reads
 * its own conversation ids from the URL (rather than a handoff channel like
 * chrome.storage.session) so it works even though the popup that opened it
 * closes the instant focus moves to the new tab — this page fetches its own
 * data straight from the service worker, independently reloadable/bookmarkable.
 *
 * Saving as PDF is just the browser's native print dialog (Ctrl+P / the Print
 * button below) — no vendored PDF library, no remote code, real selectable
 * text in the output.
 */
import { buildExportModel, renderStandaloneHtml } from "../src/lib/exportDoc.js";

function getRecord(captureId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-record", captureId }, (r) => resolve(r && r.ok ? r.record : null));
  });
}

async function main() {
  const root = document.getElementById("root");
  const ids = (new URLSearchParams(location.search).get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!ids.length) {
    root.textContent = "No conversation selected. Open this page from the extension's Save/Export button.";
    return;
  }

  const records = [];
  for (const id of ids) {
    const rec = await getRecord(id);
    if (rec) records.push(rec);
  }
  if (!records.length) {
    root.textContent = "Couldn't load the selected conversation(s) — they may have been deleted.";
    return;
  }

  // Warn (don't fail) on hollow answer text — should not happen since we
  // always fetch the FULL record via get-record, but this is the one place
  // an empty export would be silently indistinguishable from "it worked".
  const hollow = records.filter((r) => !r.answerText && (r.answerChars || 0) > 0);
  if (hollow.length) {
    console.warn("CitoSkeleton export: some records had no answerText despite answerChars > 0", hollow.map((r) => r.captureId));
  }

  const models = records.map(buildExportModel);
  const html = renderStandaloneHtml(models, { withPrintBar: true });

  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.title = parsed.title;
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;

  // The shared HTML template's print button uses an inline onclick attribute
  // so the plain downloaded .html file (opened via file://, no CSP) works
  // standalone. MV3's CSP blocks that inline handler on this extension page,
  // so wire a real listener here instead.
  document.querySelector(".print-bar button")?.addEventListener("click", () => window.print());
}

main().catch((err) => {
  console.error("CitoSkeleton export failed", err);
  const root = document.getElementById("root");
  if (root) root.textContent = "Something went wrong building the export. Check the console for details.";
});
