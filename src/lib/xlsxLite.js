/*
 * lib/xlsxLite.js — dependency-free reader for the "column A = prompt,
 * column B = tags" import sheet, in either .csv/.tsv or real .xlsx.
 *
 * No npm/build step exists in this repo (see ARCHITECTURE.md), so this
 * hand-rolls just enough of the XLSX/ZIP format to read cell text out of the
 * first worksheet — no formulas, styles, or multi-sheet support needed for a
 * two-column import list. ZIP inflate uses the browser's native
 * DecompressionStream('deflate-raw') instead of vendoring a zip/inflate
 * library.
 */

/** "A1" -> "A", "AB12" -> "AB" */
function colLetters(ref) {
  const m = /^([A-Z]+)\d+$/.exec(ref || "");
  return m ? m[1] : "";
}

/** Very small CSV/TSV parser: quoted fields, escaped quotes, CRLF/LF. */
export function parseDelimited(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === delimiter) { pushField(); continue; }
    if (c === "\n") { pushRow(); continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field || row.length) pushRow();
  return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
}

export function parseCsv(text) {
  // Sniff a tab-separated file (Excel "Save as .txt" / true .tsv) by comparing
  // delimiter counts on the first line rather than assuming by extension.
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  return parseDelimited(text, delim);
}

/* ---------------- minimal ZIP reader ---------------- */

function readU16(view, off) { return view.getUint16(off, true); }
function readU32(view, off) { return view.getUint32(off, true); }

/** Locate every named entry's { offset, compMethod, compSize, uncompSize } via the central directory. */
function zipEntries(buf) {
  const view = new DataView(buf);
  // Find End Of Central Directory record (0x06054b50), scanning from the end —
  // it's a fixed 22-byte record plus an optional comment, so search backwards.
  let eocd = -1;
  const maxBack = Math.min(buf.byteLength, 65557);
  for (let i = buf.byteLength - 22; i >= buf.byteLength - maxBack && i >= 0; i--) {
    if (readU32(view, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx (zip) file.");
  const entryCount = readU16(view, eocd + 10);
  let cdOffset = readU32(view, eocd + 16);

  const entries = {};
  const dec = new TextDecoder();
  for (let i = 0; i < entryCount; i++) {
    if (readU32(view, cdOffset) !== 0x02014b50) break; // central directory signature
    const compMethod = readU16(view, cdOffset + 10);
    const compSize = readU32(view, cdOffset + 20);
    const uncompSize = readU32(view, cdOffset + 24);
    const nameLen = readU16(view, cdOffset + 28);
    const extraLen = readU16(view, cdOffset + 30);
    const commentLen = readU16(view, cdOffset + 32);
    const localHeaderOffset = readU32(view, cdOffset + 42);
    const name = dec.decode(new Uint8Array(buf, cdOffset + 46, nameLen));
    entries[name] = { compMethod, compSize, uncompSize, localHeaderOffset };
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buf, entry) {
  const view = new DataView(buf);
  const off = entry.localHeaderOffset;
  if (readU32(view, off) !== 0x04034b50) throw new Error("Corrupt zip entry.");
  const nameLen = readU16(view, off + 26);
  const extraLen = readU16(view, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compressed = new Uint8Array(buf, dataStart, entry.compSize);
  if (entry.compMethod === 0) return compressed; // stored, no compression
  if (entry.compMethod === 8) return inflateRaw(compressed);
  throw new Error(`Unsupported zip compression method ${entry.compMethod}.`);
}

/* ---------------- XLSX cell/sheet parsing ---------------- */

function textOfSharedStringNode(xml) {
  // A shared-string item is <si>...</si>, possibly with multiple <r><t>...</t></r>
  // runs (rich text) instead of one plain <t>. Concatenate every <t>.
  let out = "";
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return decodeXmlEntities(out);
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const items = [];
  const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) items.push(textOfSharedStringNode(m[1]));
  return items;
}

/** Parse the first worksheet's rows into a 2D array of column-A/column-B strings. */
function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const byCol = {};
    // Match attrs generically (t= can appear before or after r=) rather than
    // assuming attribute order.
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(rowMatch[1]))) {
      const attrs = cm[1];
      const body = cm[2];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\st="([a-z]+)"/.exec(attrs)?.[1] || "n";
      let value = "";
      if (type === "inlineStr") {
        value = textOfSharedStringNode(body);
      } else {
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? decodeXmlEntities(v[1]) : "";
        value = type === "s" ? (sharedStrings[Number(raw)] ?? "") : raw;
      }
      byCol[colLetters(ref)] = value;
    }
    rows.push(byCol);
  }
  return rows.map((r) => [r.A || "", r.B || ""]);
}

/** Read an .xlsx ArrayBuffer, return rows as [[colA, colB], ...] from the first sheet. */
export async function parseXlsx(arrayBuffer) {
  const entries = zipEntries(arrayBuffer);
  const dec = new TextDecoder();

  let sheetName = Object.keys(entries)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error("No worksheet found in this .xlsx file.");

  let sharedStrings = [];
  if (entries["xl/sharedStrings.xml"]) {
    const bytes = await readZipEntry(arrayBuffer, entries["xl/sharedStrings.xml"]);
    sharedStrings = parseSharedStrings(dec.decode(bytes));
  }

  const sheetBytes = await readZipEntry(arrayBuffer, entries[sheetName]);
  return parseSheetRows(dec.decode(sheetBytes), sharedStrings);
}

/* ---------------- rows -> prompt objects ---------------- */

const HEADER_HINTS = /^(prompt|prompts|query|queries)$/i;

/** [[promptText, tagsText], ...] -> [{ text, tags: [] }, ...], skipping a header row and blank prompts. */
export function rowsToPrompts(rows) {
  const out = [];
  rows.forEach(([a, b], i) => {
    const text = String(a ?? "").trim();
    if (!text) return;
    if (i === 0 && HEADER_HINTS.test(text)) return; // skip "Prompt" / "Tags" header row
    const tags = String(b ?? "")
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean);
    out.push({ text, tags });
  });
  return out;
}
