/*
 * feedback-bundle.test.mjs — the "report a problem with this capture" bundle.
 *
 * Two things have to be true or the feature is worse than useless:
 *
 *   1. The archive must be a REAL zip. A bundle that only this code can open
 *      is a bug report nobody can read, and a hand-rolled zip writer is
 *      exactly where that goes wrong — so the archive written here is
 *      unpacked again with Node's own inflate, byte for byte, rather than
 *      with anything from src/.
 *   2. It must carry what a diagnosis actually needs, and NOTHING the
 *      reporter didn't agree to. Each part is individually optional, so
 *      unticking one has to genuinely leave it out.
 */
import { inflateRawSync } from "node:zlib";
import { makeZip, crc32 } from "../src/lib/zipWrite.js";
import { buildFeedbackFiles, buildNoteFile, bundleFilename, BUNDLE_PARTS } from "../src/lib/feedbackBundle.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

/* An independent zip reader: central directory only, the way a real
 * unzipper finds entries. Deliberately not xlsxLite's reader — a writer and
 * a reader from the same head can agree with each other and both be wrong. */
function unzip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = view.getUint16(at + 10, true);
    const storedCrc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const rawSize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen));
    // Follow the offset into the local header, as an unzipper does.
    if (view.getUint32(localAt, true) !== 0x04034b50) throw new Error("bad local header for " + name);
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataAt, dataAt + compSize);
    const bytes = method === 8 ? inflateRawSync(body) : body;
    out.push({ name, method, text: new TextDecoder().decode(bytes), rawSize, storedCrc, bytes });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const RECORD = {
  captureId: "abc12345-0000-0000-0000-000000000000",
  platform: "perplexity",
  model: null,
  capturedAt: 1756700000000,
  userPrompt: "best camera phone under 30000",
  answerText: "The Nothing Phone (3a) Pro leads on zoom.",
  brandMentions: [{ brand: "Nothing", count: 3 }, { brand: "Motorola", count: 5 }],
  sources: [{ url: "https://example.com/a", domain: "example.com", outcome: "cited" }],
  fanout: { search: [{ query: "best camera phone under 30000" }] },
};
const ENV = { version: "0.35.0", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/141" };

console.log("\nfeedback-bundle: crc32 matches the known reference value");
{
  // The standard CRC-32 of "123456789" — if the table or the loop is wrong,
  // every entry in every archive is silently corrupt to a strict unzipper.
  check("crc32('123456789') === 0xCBF43926",
    crc32(new TextEncoder().encode("123456789")) === 0xcbf43926,
    "0x" + crc32(new TextEncoder().encode("123456789")).toString(16));
  check("crc32 of empty input is 0", crc32(new Uint8Array()) === 0);
}

console.log("\nfeedback-bundle: the archive is a real zip, unpacked with Node's own inflate");
{
  const files = buildFeedbackFiles({
    note: "the brand list shows Optical Zoom instead of the phones",
    record: RECORD,
    raw: "# CitoSkeleton raw capture abc12345\n\n{\"query\":\"best camera phone under 30000\"}",
    reportHtml: "<!doctype html><title>report</title><body>Nothing Phone (3a) Pro</body>",
    env: ENV,
  });
  const blob = await makeZip(files, new Date("2026-09-01T12:00:00Z"));
  const buf = new Uint8Array(await blob.arrayBuffer());

  check("the blob is served as application/zip", blob.type === "application/zip", blob.type);
  check("it starts with the local-file-header signature 'PK\\x03\\x04'",
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04);

  let entries = [];
  let threw = null;
  try { entries = unzip(buf); } catch (e) { threw = e; }
  check("an independent reader can walk it end to end", !threw, threw && threw.message);

  const names = entries.map((e) => e.name).sort();
  check("all four parts are inside",
    JSON.stringify(names) === JSON.stringify(["analysis.json", "feedback.txt", "raw-capture.txt", "report.html"]),
    names.join(", "));

  for (const e of entries) {
    check(`${e.name}: the stored CRC matches the bytes that came out`,
      crc32(e.bytes) === e.storedCrc, `${e.name} crc mismatch`);
    check(`${e.name}: the stored size matches the bytes that came out`,
      e.bytes.length === e.rawSize, `${e.bytes.length} vs ${e.rawSize}`);
  }

  const byName = Object.fromEntries(entries.map((e) => [e.name, e.text]));
  check("report.html survives round-trip intact",
    byName["report.html"].includes("Nothing Phone (3a) Pro"));
  check("raw-capture.txt keeps its header line",
    byName["raw-capture.txt"].startsWith("# CitoSkeleton raw capture abc12345"));
  check("analysis.json is valid JSON and is the derived record",
    JSON.parse(byName["analysis.json"]).captureId === RECORD.captureId);
  check("feedback.txt carries what the reporter typed",
    byName["feedback.txt"].includes("shows Optical Zoom instead of the phones"));
}

console.log("\nfeedback-bundle: unticking a part genuinely leaves it out");
{
  const only = buildFeedbackFiles({
    note: "n", record: RECORD, raw: "RAW", reportHtml: "<html>", env: ENV,
    include: { report: false, raw: false, analysis: false },
  });
  check("just the note is left", only.length === 1 && only[0].name === "feedback.txt",
    only.map((f) => f.name).join(", "));
  // The note must SAY so, or the developer can't tell "left out" from "lost".
  check("the note records which parts were declined",
    only[0].text.includes("[ ] raw-capture.txt") && only[0].text.includes("[ ] report.html"),
    only[0].text);

  const noRaw = buildFeedbackFiles({ note: "n", record: RECORD, reportHtml: "<html>", env: ENV });
  check("a capture whose raw payload was pruned still sends the rest",
    noRaw.map((f) => f.name).join(",") === "feedback.txt,report.html,analysis.json",
    noRaw.map((f) => f.name).join(","));
}

console.log("\nfeedback-bundle: the note is enough to triage from on its own");
{
  const text = buildNoteFile({ note: "brands are wrong", record: RECORD, env: ENV, include: { report: true, raw: true, analysis: true } });
  check("it names the engine", text.includes("engine    : perplexity"));
  check("it quotes the prompt", text.includes("best camera phone under 30000"));
  check("it lists the brands actually reported", text.includes("Nothing, Motorola"), text);
  check("it counts the sources", text.includes("sources   : 1"));
  check("it records the extension version", text.includes("0.35.0"));
  check("it records the browser", text.includes("Chrome/141"));
  check("an empty note is called out rather than left blank",
    buildNoteFile({ record: RECORD, env: ENV, include: {} }).includes("did not write anything"));
}

console.log("\nfeedback-bundle: filename and part list");
{
  const name = bundleFilename(RECORD, new Date("2026-09-01T13:45:00"));
  check("the filename names the engine and the time",
    /^citoskeleton-feedback-perplexity-20260901-1345\.zip$/.test(name), name);
  check("a record with no platform still yields a usable name",
    /^citoskeleton-feedback-capture-\d{8}-\d{4}\.zip$/.test(bundleFilename({}, new Date())), bundleFilename({}, new Date()));
  check("every declared part has a file, a label and an explanation",
    BUNDLE_PARTS.every((p) => p.key && p.file && p.label && p.detail));
}

console.log("\nfeedback-bundle: degenerate input never throws");
{
  const empty = await makeZip([], new Date());
  check("an empty archive is still a valid zip", (await empty.arrayBuffer()).byteLength === 22);
  check("null-ish file lists are safe", (await makeZip(null)) instanceof Blob);
  check("a file with no name is skipped, not written as ''",
    unzip(new Uint8Array(await (await makeZip([{ name: "", text: "x" }, { name: "ok.txt", text: "y" }])).arrayBuffer()))
      .map((e) => e.name).join(",") === "ok.txt");
  check("buildFeedbackFiles with nothing at all still returns the note",
    buildFeedbackFiles().length === 1);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
