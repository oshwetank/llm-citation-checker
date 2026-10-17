/*
 * xlsxWrite.js — writes a real .xlsx (Office Open XML) workbook: sheets,
 * styles, live formulas with their values already filled in, frozen panes,
 * filters, merged cells, named ranges, dropdowns, conditional formatting,
 * links and charts. Release 6 of the canvas redesign (the analyst workbook).
 *
 * Until now the campaign export was SpreadsheetML 2003 (.xls): plain XML,
 * which carries styles and filters but not charts, conditional formatting,
 * named ranges or a dropdown that drives formulas — the things that make a
 * workbook something you work in rather than read. An .xlsx is a zip of XML
 * parts; zipWrite.js already writes zips, so this only has to write the
 * parts.
 *
 * Every formula is written WITH its value. Excel recalculates on open
 * (fullCalcOnLoad), but LibreOffice by default does not recalculate an .xlsx
 * on load, and a file previewer never does — without a cached value they
 * would show every formula cell as 0 or blank. The caller computes the value
 * from the same rows the formula reads, so the two can only disagree if the
 * caller's arithmetic is wrong, and the tests check that.
 *
 * PURE: no DOM, no chrome.*. files() returns the parts as text for tests;
 * toBlob() zips them.
 */
import { makeZip } from "./zipWrite.js";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_R = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument";

/** XML text, with the control characters XML 1.0 forbids removed (one stray
 *  byte in a scraped page title would otherwise make Excel refuse the file). */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 1 -> A, 27 -> AA. */
export function colName(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
/** "AB12" -> { r: 12, c: 28 }. */
export function parseRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref).toUpperCase());
  if (!m) throw new Error(`Bad cell reference: ${ref}`);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]), c };
}
export const cellRef = (r, c) => `${colName(c)}${r}`;
/** A sheet name as it appears in a formula: quoted, inner quotes doubled. */
export const sheetRef = (name) => `'${String(name).replace(/'/g, "''")}'`;
/** An absolute range on a sheet: 'Answers'!$B$2:$B$40. */
export function absRange(sheet, c1, r1, c2 = c1, r2 = r1) {
  return `${sheetRef(sheet)}!$${colName(c1)}$${r1}:$${colName(c2)}$${r2}`;
}

const excelSerial = (d) => d.getTime() / 86400000 + 25569;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const hex = (c) => `FF${String(c || "000000").replace(/^#/, "").toUpperCase()}`;

/* ---------- styles ---------- */

const BUILTIN_FMT = { General: 0, "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10, "yyyy-mm-dd": null };

class Styles {
  constructor(defaultFont) {
    this.font0 = defaultFont;
    this.fonts = [this.fontXml({})];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.borders = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
    this.numFmts = [];      // [id, code]
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.xfIndex = new Map([["{}", 0]]);
    this.dxfs = [];
    this.dxfIndex = new Map();
  }
  fontXml(f) {
    const d = this.font0;
    return `<font>${f.bold ? "<b/>" : ""}${f.italic ? "<i/>" : ""}${f.underline ? "<u/>" : ""}<sz val="${f.size || d.size}"/><color rgb="${hex(f.color || d.color)}"/><name val="${esc(f.name || d.name)}"/></font>`;
  }
  idx(list, xml) {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  }
  fmtId(code) {
    if (code == null) return 0;
    if (BUILTIN_FMT[code] != null) return BUILTIN_FMT[code];
    const hit = this.numFmts.find((x) => x[1] === code);
    if (hit) return hit[0];
    const id = 164 + this.numFmts.length;
    this.numFmts.push([id, code]);
    return id;
  }
  borderXml(b) {
    const side = (name, v) => (v ? `<${name} style="${v.style || "thin"}"><color rgb="${hex(v.color || "D5DDE8")}"/></${name}>` : `<${name}/>`);
    return `<border>${side("left", b.left)}${side("right", b.right)}${side("top", b.top)}${side("bottom", b.bottom)}<diagonal/></border>`;
  }
  /** A style object -> its cellXfs index, shared by every equal style. */
  xf(st) {
    if (!st) return 0;
    const key = JSON.stringify(st);
    if (this.xfIndex.has(key)) return this.xfIndex.get(key);
    const fontId = st.font ? this.idx(this.fonts, this.fontXml(st.font)) : 0;
    const fillId = st.fill ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = st.border ? this.idx(this.borders, this.borderXml(st.border)) : 0;
    const numFmtId = this.fmtId(st.numFmt);
    const al = st.align || {};
    const alignXml = Object.keys(al).length
      ? `<alignment${al.h ? ` horizontal="${al.h}"` : ""}${al.v ? ` vertical="${al.v}"` : ""}${al.wrap ? ' wrapText="1"' : ""}${al.indent ? ` indent="${al.indent}"` : ""}/>`
      : "";
    const xml = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${alignXml ? ' applyAlignment="1">' + alignXml + "</xf>" : "/>"}`;
    this.xfs.push(xml);
    const i = this.xfs.length - 1;
    this.xfIndex.set(key, i);
    return i;
  }
  /** A conditional format's look -> its dxfs index. */
  dxf(st) {
    const key = JSON.stringify(st || {});
    if (this.dxfIndex.has(key)) return this.dxfIndex.get(key);
    const f = st.font || {};
    const font = st.font ? `<font>${f.bold ? "<b/>" : ""}${f.color ? `<color rgb="${hex(f.color)}"/>` : ""}</font>` : "";
    const fill = st.fill ? `<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor rgb="${hex(st.fill)}"/></patternFill></fill>` : "";
    this.dxfs.push(`<dxf>${font}${fill}</dxf>`);
    this.dxfIndex.set(key, this.dxfs.length - 1);
    return this.dxfs.length - 1;
  }
  xml() {
    const nf = this.numFmts.length ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS_MAIN}">${nf}`
      + `<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts>`
      + `<fills count="${this.fills.length}">${this.fills.join("")}</fills>`
      + `<borders count="${this.borders.length}">${this.borders.join("")}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + `<dxfs count="${this.dxfs.length}">${this.dxfs.join("")}</dxfs>`
      + "</styleSheet>";
  }
}

/* ---------- a sheet ---------- */

export class Sheet {
  constructor(wb, name, opts = {}) {
    this.wb = wb;
    this.name = name;
    this.opts = opts;
    this.cells = new Map();   // "r,c" -> { v, f, s, t }
    this.maxR = 0; this.maxC = 0;
    this.colW = new Map();
    this.rowH = new Map();
    this.merges = [];
    this.frozen = null;
    this.filter = null;
    this.validations = [];
    this.cfs = [];
    this.links = [];
    this.charts = [];
    this.tables = [];
  }
  /**
   * Set one cell. value: number | string | boolean | Date | null, or
   * { f: "formula without =", v: cached value }. style: a style object
   * ({ font, fill, border, numFmt, align }).
   */
  set(ref, value, style) {
    const { r, c } = typeof ref === "string" ? parseRef(ref) : { r: ref[0], c: ref[1] };
    this.cells.set(`${r},${c}`, { r, c, value, s: this.wb.styles.xf(style) });
    if (r > this.maxR) this.maxR = r;
    if (c > this.maxC) this.maxC = c;
    return this;
  }
  /** A row of values from a column (1-based), one style for all or one per value. */
  row(r, values, style, c0 = 1) {
    values.forEach((v, i) => this.set([r, c0 + i], v, Array.isArray(style) ? style[i] : style));
    return this;
  }
  width(col, w, { hidden = false } = {}) { this.colW.set(typeof col === "string" ? parseRef(`${col}1`).c : col, { w, hidden }); return this; }
  height(r, h) { this.rowH.set(r, h); return this; }
  merge(range) { this.merges.push(range); return this; }
  /** Freeze the rows above and the columns left of this cell. */
  freeze(ref) { this.frozen = parseRef(ref); return this; }
  autoFilter(range) { this.filter = range; return this; }
  /** A dropdown: list is an array of choices (or a range formula as a string). */
  dropdown(ref, list, { prompt = "" } = {}) { this.validations.push({ ref, list, prompt }); return this; }
  /**
   * Conditional formatting. rule:
   *   { type: "cellIs", op: "greaterThan" | "lessThan" | "equal" | …, formula: "0", style }
   *   { type: "expression", formula: "M8>G8", style }
   *   { type: "dataBar", color, min = 0, max }        (max undefined = the range's max)
   *   { type: "colorScale", colors: [lo, (mid,) hi], values: [lo, (mid,) hi] }  (undefined = min/max)
   */
  cond(range, rule) { this.cfs.push({ range, rule }); return this; }
  /** A link: { location: "'Sheet'!A1" } inside the workbook, or { url }. */
  link(ref, target) { this.links.push({ ref, ...target }); return this; }
  /**
   * A chart anchored on this sheet.
   * { type: "bar" (horizontal) | "col" | "line" | "pie" | "doughnut", title,
   *   from: "K17", cols = 8, rows = 15,
   *   series: [{ name, cats, vals, catCache: [], valCache: [], color }],
   *   valFmt = "General", min, max, stacked: "stacked" | "percent", reverse (categories top-down),
   *   legend = true, colors (pie/doughnut slices) }
   */
  chart(spec) { this.charts.push(spec); return this; }
  /**
   * An Excel table over a range whose first row is the header: filter
   * buttons, banded rows, and a name PivotTables and formulas can use.
   * { ref: "A3:AE123", name: "tAnswers", columns: [header names], style }
   */
  table(spec) { this.tables.push(spec); return this; }

  xml(sheetIdx, rels) {
    const ss = this.wb.strings;
    const rows = new Map();
    for (const cell of this.cells.values()) {
      if (!rows.has(cell.r)) rows.set(cell.r, []);
      rows.get(cell.r).push(cell);
    }
    const body = [...rows.keys()].sort((a, b) => a - b).map((r) => {
      const cs = rows.get(r).sort((a, b) => a.c - b.c).map((cell) => cellXml(cell, ss)).join("");
      const h = this.rowH.get(r);
      return `<row r="${r}"${h ? ` ht="${h}" customHeight="1"` : ""}>${cs}</row>`;
    }).join("");
    const view = (() => {
      const sel = sheetIdx === 0 ? ' tabSelected="1"' : "";
      const grid = this.opts.gridlines === false ? ' showGridLines="0"' : "";
      const zoom = this.opts.zoom ? ` zoomScale="${this.opts.zoom}" zoomScaleNormal="${this.opts.zoom}"` : "";
      let pane = "";
      if (this.frozen && (this.frozen.r > 1 || this.frozen.c > 1)) {
        const xs = this.frozen.c - 1, ys = this.frozen.r - 1;
        const active = xs && ys ? "bottomRight" : ys ? "bottomLeft" : "topRight";
        pane = `<pane${xs ? ` xSplit="${xs}"` : ""}${ys ? ` ySplit="${ys}"` : ""} topLeftCell="${cellRef(this.frozen.r, this.frozen.c)}" activePane="${active}" state="frozen"/><selection pane="${active}" activeCell="${cellRef(this.frozen.r, this.frozen.c)}" sqref="${cellRef(this.frozen.r, this.frozen.c)}"/>`;
      }
      return `<sheetViews><sheetView workbookViewId="0"${sel}${grid}${zoom}>${pane}</sheetView></sheetViews>`;
    })();
    const cols = this.colW.size
      ? `<cols>${[...this.colW.entries()].sort((a, b) => a[0] - b[0]).map(([c, w]) => `<col min="${c}" max="${c}" width="${w.w}" customWidth="1"${w.hidden ? ' hidden="1"' : ""}/>`).join("")}</cols>`
      : "";
    const dim = this.maxR ? `<dimension ref="A1:${cellRef(this.maxR, Math.max(1, this.maxC))}"/>` : "";
    const filter = this.filter ? `<autoFilter ref="${this.filter}"/>` : "";
    const merges = this.merges.length ? `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    let prio = 1;
    const cf = this.cfs.map(({ range, rule }) => `<conditionalFormatting sqref="${range}">${cfRuleXml(rule, prio++, this.wb.styles)}</conditionalFormatting>`).join("");
    const dv = this.validations.length
      ? `<dataValidations count="${this.validations.length}">${this.validations.map((v) => {
        const f = Array.isArray(v.list) ? `"${v.list.map((x) => String(x).replace(/"/g, "")).join(",")}"` : v.list;
        return `<dataValidation type="list" allowBlank="0" showInputMessage="${v.prompt ? 1 : 0}" showErrorMessage="1"${v.prompt ? ` prompt="${esc(v.prompt)}"` : ""} sqref="${v.ref}"><formula1>${esc(f)}</formula1></dataValidation>`;
      }).join("")}</dataValidations>`
      : "";
    const links = this.links.length
      ? `<hyperlinks>${this.links.map((l) => {
        if (l.location) return `<hyperlink ref="${l.ref}" location="${esc(l.location)}" display="${esc(l.display || "")}"/>`;
        const id = rels.add(`${REL}/hyperlink`, l.url, true);
        return `<hyperlink ref="${l.ref}" r:id="${id}"/>`;
      }).join("")}</hyperlinks>`
      : "";
    const drawing = this.charts.length ? `<drawing r:id="${rels.add(`${REL}/drawing`, `../drawings/drawing${this.drawingNo}.xml`)}"/>` : "";
    const tables = this.tables.length ? `<tableParts count="${this.tables.length}">${this.tables.map((t) => `<tablePart r:id="${rels.add(`${REL}/table`, `../tables/table${t.no}.xml`)}"/>`).join("")}</tableParts>` : "";
    // Printing: landscape A4, one page wide, as long as it needs.
    const pr = this.opts.print || {};
    const fit = pr.fitWidth !== false;
    const sheetPr = this.opts.tabColor || fit ? `<sheetPr>${this.opts.tabColor ? `<tabColor rgb="${hex(this.opts.tabColor)}"/>` : ""}${fit ? '<pageSetUpPr fitToPage="1"/>' : ""}</sheetPr>` : "";
    const page = `<pageSetup paperSize="9" orientation="${pr.portrait ? "portrait" : "landscape"}"${fit ? ' fitToWidth="1" fitToHeight="0"' : ""}/>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_R}">${sheetPr}${dim}${view}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${filter}${merges}${cf}${dv}${links}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>${page}${drawing}${tables}</worksheet>`;
  }
}

function cellXml(cell, ss) {
  const { r, c, value: v, s } = cell;
  const ref = cellRef(r, c);
  const st = s ? ` s="${s}"` : "";
  if (v === null || v === undefined || v === "") return s ? `<c r="${ref}"${st}/>` : "";
  if (typeof v === "object" && !(v instanceof Date) && "f" in v) {
    const cached = v.v;
    const f = `<f>${esc(String(v.f).replace(/^=/, ""))}</f>`;
    if (isNum(cached)) return `<c r="${ref}"${st}>${f}<v>${cached}</v></c>`;
    if (typeof cached === "boolean") return `<c r="${ref}"${st} t="b">${f}<v>${cached ? 1 : 0}</v></c>`;
    if (cached == null) return `<c r="${ref}"${st}>${f}</c>`;
    return `<c r="${ref}"${st} t="str">${f}<v>${esc(cached)}</v></c>`;
  }
  if (isNum(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}"${st} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (v instanceof Date) return `<c r="${ref}"${st}><v>${excelSerial(v)}</v></c>`;
  return `<c r="${ref}"${st} t="s"><v>${ss.id(String(v))}</v></c>`;
}

function cfvo(v, fallback) {
  return v === undefined || v === null ? `<cfvo type="${fallback}"/>` : `<cfvo type="num" val="${v}"/>`;
}
function cfRuleXml(rule, priority, styles) {
  if (rule.type === "cellIs") return `<cfRule type="cellIs" dxfId="${styles.dxf(rule.style)}" priority="${priority}" operator="${rule.op}"><formula>${esc(rule.formula)}</formula></cfRule>`;
  if (rule.type === "expression") return `<cfRule type="expression" dxfId="${styles.dxf(rule.style)}" priority="${priority}"><formula>${esc(rule.formula)}</formula></cfRule>`;
  if (rule.type === "dataBar") return `<cfRule type="dataBar" priority="${priority}"><dataBar>${cfvo(rule.min ?? 0, "min")}${cfvo(rule.max, "max")}<color rgb="${hex(rule.color)}"/></dataBar></cfRule>`;
  if (rule.type === "colorScale") {
    const vals = rule.values || [];
    const n = rule.colors.length;
    // An unset end is the range's min or max; an unset middle is its median.
    const vos = rule.colors.map((_, i) => (vals[i] != null ? cfvo(vals[i])
      : i === 0 ? cfvo(null, "min") : i === n - 1 ? cfvo(null, "max") : '<cfvo type="percentile" val="50"/>')).join("");
    return `<cfRule type="colorScale" priority="${priority}"><colorScale>${vos}${rule.colors.map((c) => `<color rgb="${hex(c)}"/>`).join("")}</colorScale></cfRule>`;
  }
  throw new Error(`Unknown conditional format: ${rule.type}`);
}

/* ---------- charts ---------- */

const PALETTE = ["2A78D6", "1BAF7A", "EB6834", "4A3AA7", "EDA100", "64748B"];
const solid = (c) => `<c:spPr><a:solidFill><a:srgbClr val="${String(c).replace(/^#/, "").toUpperCase()}"/></a:solidFill></c:spPr>`;
const lineSp = (c) => `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${String(c).replace(/^#/, "").toUpperCase()}"/></a:solidFill><a:round/></a:ln></c:spPr>`;
function strCache(f, vals) {
  return `<c:strRef><c:f>${esc(f)}</c:f><c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache></c:strRef>`;
}
function numCache(f, vals, fmt) {
  return `<c:numRef><c:f>${esc(f)}</c:f><c:numCache><c:formatCode>${esc(fmt || "General")}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (isNum(v) ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : "")).join("")}</c:numCache></c:numRef>`;
}
function textXml(text, size, bold) {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

export function chartXml(spec) {
  const type = spec.type;
  const pie = type === "pie" || type === "doughnut";
  const fmt = spec.valFmt || "General";
  const series = spec.series.map((s, i) => {
    const color = s.color || PALETTE[i % PALETTE.length];
    const tx = s.nameRef ? `<c:tx>${strCache(s.nameRef, [s.name])}</c:tx>` : `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`;
    const cat = `<c:cat>${strCache(s.cats, s.catCache || [])}</c:cat>`;
    const val = `<c:val>${numCache(s.vals, s.valCache || [], fmt)}</c:val>`;
    if (pie) {
      const colors = spec.colors || PALETTE;
      const dpts = (s.catCache || []).map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/>${solid(colors[k % colors.length])}</c:dPt>`).join("");
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${dpts}${cat}${val}</c:ser>`;
    }
    if (type === "line") return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${lineSp(color)}<c:marker><c:symbol val="circle"/><c:size val="6"/>${solid(color)}</c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
    // One colour per bar (a brand keeps its colour in every chart).
    const dpts = (s.pointColors || []).map((pc, k) => (pc ? `<c:dPt><c:idx val="${k}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/>${solid(pc)}</c:dPt>` : "")).join("");
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${solid(color)}<c:invertIfNegative val="0"/>${dpts}${cat}${val}</c:ser>`;
  }).join("");
  let plot;
  const ax = '<c:axId val="500001"/><c:axId val="500002"/>';
  if (type === "pie") plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (type === "doughnut") plot = `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`;
  else if (type === "line") plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${ax}</c:lineChart>`;
  else {
    const grouping = spec.stacked === "percent" ? "percentStacked" : spec.stacked ? "stacked" : "clustered";
    plot = `<c:barChart><c:barDir val="${type === "bar" ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:gapWidth val="60"/>${spec.stacked ? '<c:overlap val="100"/>' : ""}${ax}</c:barChart>`;
  }
  let axes = "";
  if (!pie) {
    const horiz = type === "bar";
    const scaling = `<c:scaling><c:orientation val="${spec.valReverse ? "maxMin" : "minMax"}"/>${spec.max != null ? `<c:max val="${spec.max}"/>` : ""}${spec.min != null ? `<c:min val="${spec.min}"/>` : ""}</c:scaling>`;
    // Counts get whole-number steps; a 0.5 tick on a count reads as a half page.
    const unit = spec.majorUnit ? `<c:majorUnit val="${spec.majorUnit}"/>` : "";
    const tick = '<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>';
    const axLine = '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln></c:spPr>';
    const grid = '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>';
    axes = `<c:catAx><c:axId val="500001"/><c:scaling><c:orientation val="${spec.reverse ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/>${tick}${axLine}<c:crossAx val="500002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="500002"/>${scaling}<c:delete val="0"/><c:axPos val="${horiz ? "b" : "l"}"/>${grid}<c:numFmt formatCode="${esc(fmt)}" sourceLinked="0"/>${tick}${axLine}<c:crossAx val="500001"/><c:crosses val="${spec.reverse ? "max" : "autoZero"}"/><c:crossBetween val="between"/>${unit}</c:valAx>`;
  }
  const legend = spec.legend === false ? "" : `<c:legend><c:legendPos val="${pie ? "r" : "b"}"/><c:overlay val="0"/></c:legend>`;
  const title = spec.title ? `<c:title>${textXml(spec.title, 1200, true)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="334155"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;
}

function drawingXml(sheet, firstChartNo) {
  const anchors = sheet.charts.map((spec, i) => {
    const from = parseRef(spec.from || "A1");
    const cols = spec.cols || 8, rows = spec.rows || 15;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${from.c - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.r - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${from.c - 1 + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.r - 1 + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${firstChartNo + i}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${anchors}</xdr:wsDr>`;
}

function tableXml(t) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="${NS_MAIN}" id="${t.no}" name="${esc(t.name)}" displayName="${esc(t.name)}" ref="${t.ref}" totalsRowShown="0"><autoFilter ref="${t.ref}"/><tableColumns count="${t.columns.length}">${t.columns.map((c, i) => `<tableColumn id="${i + 1}" name="${esc(c)}"/>`).join("")}</tableColumns><tableStyleInfo name="${t.style || "TableStyleLight9"}" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
}

/* ---------- the workbook ---------- */

class SharedStrings {
  constructor() { this.list = []; this.map = new Map(); }
  id(s) {
    if (this.map.has(s)) return this.map.get(s);
    this.list.push(s);
    this.map.set(s, this.list.length - 1);
    return this.list.length - 1;
  }
  xml(uses) {
    const items = this.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS_MAIN}" count="${uses}" uniqueCount="${this.list.length}">${items}</sst>`;
  }
}

class Rels {
  constructor() { this.items = []; }
  add(type, target, external = false) {
    const id = `rId${this.items.length + 1}`;
    this.items.push({ id, type, target, external });
    return id;
  }
  xml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_R}">${this.items.map((x) => `<Relationship Id="${x.id}" Type="${x.type}" Target="${esc(x.target)}"${x.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  }
}

export class Workbook {
  constructor({ title = "", creator = "CitoSkeleton", font = { name: "Arial", size: 10, color: "0F172A" }, created = new Date() } = {}) {
    this.title = title;
    this.creator = creator;
    this.created = created;
    this.styles = new Styles(font);
    this.strings = new SharedStrings();
    this.sheets = [];
    this.names = [];
    this.activeTab = 0;
  }
  addSheet(name, opts = {}) {
    // Excel's limits: 31 characters, none of : \ / ? * [ ]
    const clean = String(name).replace(/[:\\/?*[\]]/g, " ").slice(0, 31);
    if (this.sheets.some((s) => s.name.toLowerCase() === clean.toLowerCase())) throw new Error(`Duplicate sheet name: ${clean}`);
    const s = new Sheet(this, clean, opts);
    this.sheets.push(s);
    return s;
  }
  sheet(name) { return this.sheets.find((s) => s.name === name) || null; }
  /** A workbook-level name, e.g. defineName("RunKey", "'Overview'!$M$7"). */
  defineName(name, ref) { this.names.push({ name, ref }); return this; }

  /** Every part of the package as { name, text }. */
  files() {
    const out = [];
    const ct = [
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
      `<Default Extension="xml" ContentType="application/xml"/>`,
      `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/>`,
      `<Override PartName="/xl/styles.xml" ContentType="${CT}.spreadsheetml.styles+xml"/>`,
      `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.spreadsheetml.sharedStrings+xml"/>`,
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
      `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>`,
    ];
    const wbRels = new Rels();
    let chartNo = 0, drawingNo = 0, tableNo = 0;
    const sheetEntries = [];
    const localNames = [];
    this.sheets.forEach((sh, i) => {
      const rels = new Rels();
      if (sh.charts.length) sh.drawingNo = ++drawingNo;
      sh.tables.forEach((t) => {
        t.no = ++tableNo;
        out.push({ name: `xl/tables/table${t.no}.xml`, text: tableXml(t) });
        ct.push(`<Override PartName="/xl/tables/table${t.no}.xml" ContentType="${CT}.spreadsheetml.table+xml"/>`);
      });
      const titles = sh.opts.print && sh.opts.print.titleRows;
      if (titles) localNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${sheetRef(sh.name)}!$${titles.replace(":", ":$")}</definedName>`);
      const xml = sh.xml(i, rels);
      out.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: xml });
      ct.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`);
      if (rels.items.length) out.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, text: rels.xml() });
      if (sh.charts.length) {
        const dRels = new Rels();
        const first = chartNo + 1;
        sh.charts.forEach((spec) => {
          chartNo += 1;
          dRels.add(`${REL}/chart`, `../charts/chart${chartNo}.xml`);
          out.push({ name: `xl/charts/chart${chartNo}.xml`, text: chartXml(spec) });
          ct.push(`<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="${CT}.drawingml.chart+xml"/>`);
        });
        out.push({ name: `xl/drawings/drawing${sh.drawingNo}.xml`, text: drawingXml(sh, first) });
        out.push({ name: `xl/drawings/_rels/drawing${sh.drawingNo}.xml.rels`, text: dRels.xml() });
        ct.push(`<Override PartName="/xl/drawings/drawing${sh.drawingNo}.xml" ContentType="${CT}.drawing+xml"/>`);
      }
      sheetEntries.push(`<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="${wbRels.add(`${REL}/worksheet`, `worksheets/sheet${i + 1}.xml`)}"/>`);
    });
    wbRels.add(`${REL}/styles`, "styles.xml");
    wbRels.add(`${REL}/sharedStrings`, "sharedStrings.xml");
    const names = this.names.length || localNames.length
      ? `<definedNames>${localNames.join("")}${this.names.map((n) => `<definedName name="${esc(n.name)}">${esc(n.ref)}</definedName>`).join("")}</definedNames>` : "";
    out.push({ name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_R}"><workbookPr/><bookViews><workbookView activeTab="${this.activeTab}"/></bookViews><sheets>${sheetEntries.join("")}</sheets>${names}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` });
    out.push({ name: "xl/_rels/workbook.xml.rels", text: wbRels.xml() });
    // Styles and strings last: the sheets above are what fill them.
    let uses = 0;
    for (const sh of this.sheets) for (const c of sh.cells.values()) if (typeof c.value === "string" && c.value !== "") uses++;
    out.push({ name: "xl/sharedStrings.xml", text: this.strings.xml(uses) });
    out.push({ name: "xl/styles.xml", text: this.styles.xml() });
    const iso = this.created.toISOString().replace(/\.\d+Z$/, "Z");
    out.push({ name: "docProps/core.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(this.title)}</dc:title><dc:creator>${esc(this.creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>` });
    out.push({ name: "docProps/app.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${esc(this.creator)}</Application></Properties>` });
    out.push({ name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_R}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>` });
    out.unshift({ name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct.join("")}</Types>` });
    return out;
  }

  /** The .xlsx file. */
  async toBlob() {
    const blob = await makeZip(this.files(), this.created);
    return new Blob([await blob.arrayBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
}
