/*
 * Tests for the CSV/XLSX prompt importer (src/lib/xlsxLite.js).
 * Run: node test/xlsxlite.test.mjs
 *
 * The XLSX cases build real, valid (STORED/uncompressed) zip fixtures byte by
 * byte rather than depending on a system `zip` binary or a checked-in binary
 * fixture — this file has no dependencies beyond Node itself, same as the
 * rest of this repo. Two of these reproduce real bugs found by importing an
 * actual client prompt sheet: a mixed-case `t="inlineStr"` cell-type
 * attribute that a lowercase-only regex silently misread as numeric (every
 * text cell came through blank), and a numeric XML character reference
 * (`&#8377;` for ₹) that wasn't being decoded at all.
 */
import { parseCsv, parseXlsx, rowsToPrompts } from "../src/lib/xlsxLite.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------- pure-Node ZIP writer (STORED entries only) ----------------
 * Just enough to build a valid .xlsx for parseXlsx() to read back — no
 * compression needed since the STORED method (0) is valid ZIP and this
 * reader's own inflate path is exercised separately in production use. */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...localParts, centralBuf, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

/** Build a minimal one-sheet .xlsx (inline strings only — no sharedStrings.xml,
 *  same as real Excel/Google Sheets exports that use t="inlineStr"). */
function buildXlsx(sheetXml) {
  return makeZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "xl/workbook.xml", data: WORKBOOK },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
  ]);
}

console.log("CSV parsing");
{
  const rows = parseCsv(`Prompt,Tags\n"best camera phone, under 40000",camera,budget\nplain prompt,\n`);
  check("quoted field with embedded comma kept as one field", eq(rows[1], ["best camera phone, under 40000", "camera", "budget"]));
  check("blank tags cell reads as empty string, not dropped", rows[2][0] === "plain prompt");
}

console.log("\nrowsToPrompts: plain two-column, no header");
{
  const prompts = rowsToPrompts([["best trading app in India", "finance,beginner"], ["best broker", "finance"]]);
  check("both rows kept (no header to skip)", prompts.length === 2, JSON.stringify(prompts));
  check("tags split on comma", eq(prompts[0].tags, ["finance", "beginner"]));
}

console.log("\nrowsToPrompts: two-column WITH a 'Prompt'/'Tags' header");
{
  const prompts = rowsToPrompts([["Prompt", "Tags"], ["best trading app", "finance"]]);
  check("header row skipped, 1 prompt kept", prompts.length === 1, JSON.stringify(prompts));
  check("prompt text correct", prompts[0].text === "best trading app");
}

console.log("\nrowsToPrompts: header-name column detection (regression — real file had Prompt in column D)");
{
  // S.No, Industry, Industry Category, Prompt, Search-Trigger Type — the
  // exact shape of the real 200-prompt import sheet that surfaced this bug.
  // A positional (column A/B) reader would have imported "1"/"2" as prompts.
  const header = ["S. No.", "Industry", "Industry Category", "Prompt", "Search-Trigger Type"];
  const row1 = ["1", "Consumer Electronics & Smartphones", "Client Portfolio", "What are the latest smartphones launched in India this month?", "Latest launch / new arrival"];
  const row2 = ["2", "Cement & Construction Materials", "Client Portfolio", "Has any new type of cement launched this year?", "Latest launch / new arrival"];
  const prompts = rowsToPrompts([header, row1, row2]);
  check("2 prompts extracted", prompts.length === 2, JSON.stringify(prompts));
  check("prompt text pulled from column D (not column A's S.No)", prompts[0].text.startsWith("What are the latest smartphones"), prompts[0].text);
  check("tag pulled from the 'Industry' column, not the adjacent column", eq(prompts[0].tags, ["Consumer Electronics & Smartphones"]));
  check("second row's industry tag correct", eq(prompts[1].tags, ["Cement & Construction Materials"]));
}

console.log("\nparseXlsx: mixed-case t=\"inlineStr\" (regression — lowercase-only regex read every text cell as blank)");
{
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Prompt</t></is></c><c r="B1" t="inlineStr"><is><t>Tags</t></is></c></row>
<row r="2"><c r="A2" t="n"><v>1</v></c><c r="B2" t="inlineStr"><is><t>finance</t></is></c></row>
<row r="3" s="4"><c r="A3" s="4" t="inlineStr"><is><t>best broker for beginners</t></is></c><c r="B3" s="2" t="inlineStr"><is><t>finance,beginner</t></is></c></row>
</sheetData>
</worksheet>`;
  const rows = await parseXlsx(buildXlsx(sheet));
  check("3 rows read", rows.length === 3, JSON.stringify(rows));
  check("header row text NOT blank (the actual bug: inlineStr misread as numeric type)", rows[0][0] === "Prompt" && rows[0][1] === "Tags", JSON.stringify(rows[0]));
  check("numeric cell (t=\"n\") still reads correctly", rows[1][0] === "1", JSON.stringify(rows[1]));
  check("inline string cell with a style attr before t= reads correctly", rows[2][0] === "best broker for beginners", JSON.stringify(rows[2]));
}

console.log("\nparseXlsx: numeric XML character reference (regression — ₹ via &#8377; wasn't decoded)");
{
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>best smartphones under &#8377;20,000</t></is></c><c r="B1" t="inlineStr"><is><t>tax &amp; duty</t></is></c></row>
</sheetData>
</worksheet>`;
  const rows = await parseXlsx(buildXlsx(sheet));
  check("decimal numeric entity (&#8377;) decoded to the actual ₹ character", rows[0][0] === "best smartphones under ₹20,000", rows[0][0]);
  check("&amp; still decodes correctly alongside a numeric entity in the same cell", rows[0][1] === "tax & duty", rows[0][1]);
}

console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
