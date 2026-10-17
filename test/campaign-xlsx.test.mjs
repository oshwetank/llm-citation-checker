/*
 * campaign-xlsx.test.mjs — the campaign export (0.52.0): the .xlsx writer,
 * the workbook built on it, and the CSV tables.
 * Run: node test/campaign-xlsx.test.mjs
 *
 * The data is synthetic (three made-up brands, three prompts, two runs) and
 * small enough that every number below can be checked by hand against it.
 * Each formula the workbook writes carries the value it computes, so a
 * spreadsheet shows numbers before it recalculates; the checks here hold the
 * workbook to that, and to every name a formula uses being defined.
 */
import { buildCampaignXlsx, campaignFacts, campaignCsvFiles, campaignExportCounts, csvCell, Q, RAW } from "../src/lib/campaignXlsx.js";
import { Workbook, esc, colName, parseRef } from "../src/lib/xlsxWrite.js";
import { makeZip } from "../src/lib/zipWrite.js";
import { parseXlsx, parseCsv } from "../src/lib/xlsxLite.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- synthetic campaign ---------- */
const profile = { id: "p1", name: "Budget headphones", brand: { name: "Zento", url: "https://zento.in" }, competitors: [{ name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }] };
const brands = [{ name: "Zento", url: "https://zento.in", isOwn: true }, { name: "Kovo", url: "https://kovo.com" }, { name: "Lumi", url: "" }];
const prompts = [
  { id: "q1", text: "best headphones under 4000", tags: ["buying"], createdAt: 1 },
  { id: "q2", text: "zento vs kovo battery life", tags: ["comparison", "battery"], createdAt: 2 },
  { id: "q3", text: "headphones with the best mic for calls", tags: ["calls"], createdAt: 3 },
];
const runs = [{ id: "r2", profileId: "p1", startedAt: 2000 }, { id: "r1", profileId: "p1", startedAt: 1000 }];
let n = 0;
const m = (brand, count, firstIndex, passages = []) => ({ brand, count, firstIndex, passages });
const src = (domain, outcome = "cited", title = domain) => ({ url: `https://${domain}/${++n}`, domain, title, outcome, snippet: "" });
const rec = (runId, platform, promptId, extra) => ({
  captureId: `${runId}-${platform}-${promptId}`, platform, capturedAt: (runId === "r2" ? 2000 : 1000) + n++,
  geo: { profileId: "p1", runId, promptId, tags: prompts.find((p) => p.id === promptId).tags },
  searched: true, userPrompt: prompts.find((p) => p.id === promptId).text, answerText: "",
  fanout: { search: [], shopping: [], image: [] }, sources: [], brandMentions: [], products: [], images: [], ...extra,
});
const r2 = [
  rec("r2", "chatgpt", "q1", {
    answerText: "The Zento Pulse is best for long commutes. Kovo Air is cheaper.",
    brandMentions: [m("Zento", 3, 10, ["The Zento Pulse is best for long commutes, with great battery life."]), m("Kovo", 1, 80)],
    sources: [src("zento.in"), src("smartprix.com", "cited", "Zento Pulse vs Kovo Air"), src("reddit.com", "fetched")],
    products: [{ name: "Zento Pulse", merchant: "Amazon.in + others", price: "₹3,499", rating: 4.3 }, { name: "Kovo Air", merchant: "Flipkart" }, { name: "Zento Mini", merchant: "zento.in" }],
    fanout: { search: [{ query: "best headphones under 4000 india 2026" }, { query: "zento pulse review reddit" }], shopping: [], image: [] },
  }),
  rec("r2", "gemini", "q1", { brandMentions: [m("Kovo", 2, 5), m("Zento", 1, 60)], sources: [src("91mobiles.com"), src("kovo.com")], products: [{ name: "Kovo Air", merchant: "Croma" }] }),
  rec("r2", "perplexity", "q1", { brandMentions: [m("Zento", 2, 3), m("Lumi", 1, 50)], sources: [src("smartprix.com")], fanout: { search: [{ query: "best headphones under 4000 india 2026" }], shopping: [], image: [] } }),
  rec("r2", "chatgpt", "q2", { brandMentions: [m("Kovo", 2, 4), m("Zento", 2, 30)], sources: [src("rtings.com", "cited", "=HYPERLINK(\"http://x\",\"Kovo, \"\"Air\"\" review\")")] }),
  rec("r2", "gemini", "q2", { brandMentions: [m("Kovo", 1, 2)], sources: [src("rtings.com", "cited", "Kovo Air review\u0001")] }),
  rec("r2", "chatgpt", "q3", { searched: false, brandMentions: [m("Lumi", 1, 1)] }),
];
const r1 = [
  rec("r1", "chatgpt", "q1", { brandMentions: [m("Kovo", 1, 2), m("Zento", 1, 40)], sources: [src("smartprix.com")] }),
  rec("r1", "gemini", "q1", { brandMentions: [m("Kovo", 1, 2)] }),
  rec("r1", "chatgpt", "q2", { brandMentions: [m("Kovo", 1, 2)] }),
];
const bundle = (over = {}) => ({ profile, prompts, runs, records: [...r2, ...r1], brands, generatedAt: Date.UTC(2026, 9, 3), ...over });

/* ---------- a minimal XML well-formedness check ----------
 * Node has no XML parser. Every tag must close in order, attributes must be
 * quoted, and no raw control characters or stray ampersands may appear. */
function xmlProblem(text) {
  const body = text.replace(/^<\?xml[^>]*\?>\s*/, "");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) return "control character";
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body)) return "bare ampersand";
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
  let mt;
  while ((mt = re.exec(body))) {
    if (mt[0].startsWith("<![CDATA[")) continue;
    if (mt[2] === undefined) return `bad tag ${mt[0].slice(0, 60)}`;
    if (mt[1]) { const top = stack.pop(); if (top !== mt[2]) return `</${mt[2]}> closes <${top}>`; }
    else if (!mt[4]) stack.push(mt[2]);
  }
  return stack.length ? `unclosed <${stack.pop()}>` : null;
}

/* ---------- the writer ---------- */
console.log("xlsxWrite");
check("colName: 1 → A, 26 → Z, 27 → AA, 703 → AAA", colName(1) === "A" && colName(26) === "Z" && colName(27) === "AA" && colName(703) === "AAA");
check("parseRef reads $-anchored refs", eq(parseRef("$AB$12"), { r: 12, c: 28 }), JSON.stringify(parseRef("$AB$12")));
check("esc escapes markup and drops control characters", esc("a<b>&\"c\u0001") === "a&lt;b&gt;&amp;&quot;c", esc("a<b>&\"c\u0001"));
{
  const wb = new Workbook({ title: "t", created: new Date(Date.UTC(2026, 0, 1)) });
  const sh = wb.addSheet("Data: one/two");
  sh.row(1, ["Name", "Value"], { font: { bold: true } });
  sh.row(2, ["x", 3]);
  sh.set("B3", { f: "SUM(B2:B2)", v: 3 });
  check("sheet names lose the characters Excel forbids", sh.name === "Data  one two", sh.name);
  let threw = false;
  try { wb.addSheet("data  ONE two"); } catch (_) { threw = true; }
  check("a duplicate sheet name (any case) is refused", threw);
  const files = wb.files();
  const names = files.map((f) => f.name);
  check("the package has its required parts", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"].every((p) => names.includes(p)), names.join(", "));
  const sheetXml = files.find((f) => f.name === "xl/worksheets/sheet1.xml").text;
  check("a formula cell is written with its cached value", /<c r="B3"[^>]*><f>SUM\(B2:B2\)<\/f><v>3<\/v><\/c>/.test(sheetXml), sheetXml.match(/<c r="B3".*?<\/c>/)?.[0]);
  check("the workbook asks to recalculate on open", /fullCalcOnLoad="1"/.test(files.find((f) => f.name === "xl/workbook.xml").text));
}

/* ---------- the facts ---------- */
console.log("campaignFacts");
const F = campaignFacts(bundle());
const col = (key, name) => RAW.find((r) => r.key === key).cols.indexOf(name);
const rowOf = (run, prompt, engine) => F.A.find((r) => r[1] === run && r[3] === prompt && r[7] === engine);
check("one answer row per prompt × engine × run (6 + 3)", F.A.length === 9, F.A.length);
check("runs are numbered by start time, oldest first", eq(F.runs.map((r) => r.label), ["Run 1", "Run 2"]) && rowOf("Run 1", "P01", "Gemini"), JSON.stringify(F.runs));
check("engines in a fixed order", eq(F.engines, ["ChatGPT", "Gemini", "Perplexity"]), F.engines);
{
  const a = rowOf("Run 2", "P01", "ChatGPT");
  check("ChatGPT, run 2, P01: Zento named first with 3 mentions", a[col("A", "You named")] === 1 && a[col("A", "Your position")] === 1 && a[col("A", "Your mentions")] === 3 && a[col("A", "Named first")] === 1, JSON.stringify(a));
  check("… read 3 pages, cited 2, one of them zento.in", a[col("A", "Pages read")] === 3 && a[col("A", "Pages cited")] === 2 && a[col("A", "Cites your site")] === 1);
  check("… 2 searches and 3 product cards, 2 of them Zento's", a[col("A", "Searches")] === 2 && a[col("A", "Product cards")] === 3 && a[col("A", "Your cards")] === 2);
  const g = rowOf("Run 2", "P01", "Gemini");
  check("Gemini, run 2, P01: Kovo first, so Zento is second", g[col("A", "Your position")] === 2 && g[col("A", "Named first")] === 0);
  const q3 = rowOf("Run 2", "P03", "ChatGPT");
  check("an answer that didn't name Zento has no position", q3[col("A", "You named")] === 0 && q3[col("A", "Your position")] === null);
}
check("one mention row per tracked brand named (2+2+2+2+1+1 + 2+1+1)", F.M.length === 14, F.M.length);
check("one head-to-head row per answer × rival", F.H.length === 18, F.H.length);
{
  const h = F.H.find((r) => r[1] === "Run 2" && r[2] === "Gemini" && r[3] === "P01" && r[4] === "Kovo");
  check("head to head: Kovo ahead of Zento on Gemini reads Behind", h && h[7] === "Kovo first" && h[8] === "Behind", JSON.stringify(h));
}
{
  const reddit = F.Q.find((r) => r[5] === "zento pulse review reddit");
  check("searches: brand, own-brand and Reddit flags", reddit && reddit[col("Q", "Names a brand")] === 1 && reddit[col("Q", "Names you")] === 1 && reddit[col("Q", "Asks Reddit")] === 1 && reddit[col("Q", "Has a year")] === 0);
  const year = F.Q.find((r) => r[5] === "best headphones under 4000 india 2026");
  check("searches: a year in the search is flagged", year && year[col("Q", "Has a year")] === 1 && year[col("Q", "Words")] === 6);
}
{
  const p = F.P.find((r) => r[5] === "Zento Pulse");
  check("product card: price as a number and the stores it lists, without 'others'", p && p[col("P", "Price")] === 3499 && p[col("P", "Stores listed")] === 1 && p[col("P", "Rating")] === 4.3, JSON.stringify(p));
  check("store offers: one row per store a card lists (1+1+1+1)", F.O.length === 4, F.O.length);
}

/* ---------- Q: formula and value from one rule ---------- */
console.log("Q");
{
  const run2 = new Q(F, "A").where("Run", { f: "\"Run 2\"", v: "Run 2" });
  const c = run2.count();
  check("COUNTIFS text and its value", c.f === 'COUNTIFS(A_Run,"Run 2")' && c.v === 6, JSON.stringify(c));
  const s = run2.sum("You named");
  check("SUMIFS: Zento named in 4 of run 2's answers", s.f === 'SUMIFS(A_YouNamed,A_Run,"Run 2")' && s.v === 4, JSON.stringify(s));
  const av = run2.where("You named", { f: "1", v: 1 }).avg("Your position");
  check("AVERAGEIFS: Zento's average position when named in run 2 = (1+2+1+2)/4", av.v === 1.5, JSON.stringify(av));
  check("an average over nothing is blank, not 0", new Q(F, "A").where("Run", { f: "\"Run 9\"", v: "Run 9" }).avg("Your position").v === "");
}

/* ---------- the workbook ---------- */
console.log("buildCampaignXlsx");
function audit(wb) {
  const defined = new Set(wb.names.map((x) => x.name));
  const sheets = new Set(wb.sheets.map((s) => s.name));
  const missingName = new Set(), missingSheet = new Set(), noCache = [];
  for (const sh of wb.sheets) for (const c of sh.cells.values()) {
    if (!c.value || typeof c.value !== "object" || !("f" in c.value)) continue;
    if (c.value.v === undefined || (typeof c.value.v === "number" && !Number.isFinite(c.value.v))) noCache.push(`${sh.name}!${colName(c.c)}${c.r}`);
    const f = String(c.value.f).replace(/"([^"]|"")*"/g, "\"\"");
    for (const x of f.matchAll(/'((?:[^']|'')+)'!/g)) if (!sheets.has(x[1].replace(/''/g, "'"))) missingSheet.add(x[1]);
    for (const x of f.matchAll(/(?<![\w.!$'])([A-Za-z_][\w.]*)(?![\w.(!])/g)) {
      const name = x[1];
      if (/^[A-Z]{1,3}\$?\d+$/.test(name) || /^(TRUE|FALSE)$/i.test(name)) continue;
      if (!defined.has(name)) missingName.add(name);
    }
  }
  // Formulas mostly reach the raw tables through names, so where each name
  // points matters as much as the formulas themselves.
  for (const x of wb.names) for (const r of String(x.ref).matchAll(/'((?:[^']|'')+)'!/g)) if (!sheets.has(r[1].replace(/''/g, "'"))) missingSheet.add(r[1]);
  return { missingName: [...missingName], missingSheet: [...missingSheet], noCache };
}
const SUMMARY = ["Start here", "Overview", "Trends", "Brands", "Prompts", "Answer types", "Sources", "Products", "Searches", "Run over run", "Actions"];
const RAWS = ["Answers", "Mentions", "Sources data", "Engine searches", "Product cards", "Store offers", "Images", "Head to head"];
const full = buildCampaignXlsx(bundle());
check("every summary and raw sheet, in order", eq(full.wb.sheets.map((s) => s.name), [...SUMMARY, ...RAWS]), full.wb.sheets.map((s) => s.name).join(", "));
{
  const a = audit(full.wb);
  check("every name a formula uses is defined", a.missingName.length === 0, a.missingName.join(", "));
  check("every sheet a formula points at exists", a.missingSheet.length === 0, a.missingSheet.join(", "));
  check("every formula carries a cached value", a.noCache.length === 0, a.noCache.slice(0, 5).join(", "));
  check("hundreds of formulas, not a static dump", full.stats.formulas > 200, full.stats.formulas);
  // The audit itself has to be able to fail: drop one name and a sheet.
  const broken = buildCampaignXlsx(bundle()).wb;
  broken.names = broken.names.filter((x) => x.name !== "RunKey");
  broken.sheets = broken.sheets.filter((s) => s.name !== "Answers");
  const b = audit(broken);
  check("the audit notices a missing name and a missing sheet", b.missingName.includes("RunKey") && b.missingSheet.includes("Answers"), JSON.stringify(b).slice(0, 200));
}
const tables = full.wb.sheets.flatMap((s) => s.tables.map((t) => t.name));
check("each raw table is an Excel table", eq(tables, RAW.map((r) => r.table)), tables.join(", "));
{
  const answers = full.wb.sheet("Answers");
  const t = answers.tables[0];
  check("the Answers table spans its header and 9 rows", t && /^A\d+:[A-Z]+\d+$/.test(t.ref) && Number(t.ref.split(":")[1].match(/\d+$/)[0]) - Number(t.ref.split(":")[0].match(/\d+$/)[0]) === 9, t && t.ref);
}
const files = full.wb.files();
{
  const bad = files.map((f) => [f.name, xmlProblem(f.text)]).filter(([, p]) => p);
  check(`all ${files.length} parts are well-formed XML`, bad.length === 0, bad.slice(0, 3).map((b) => b.join(": ")).join("; "));
  check("a page title's control character never reaches the file", !files.some((f) => f.text.includes("\u0001")));
  check("charts are packaged", files.filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f.name)).length >= 6, files.filter((f) => f.name.startsWith("xl/charts/")).length);
}
{
  const blob = await makeZip(files, new Date(Date.UTC(2026, 9, 3)));
  const rows = await parseXlsx(await blob.arrayBuffer());
  check("zipped, it opens: the first sheet names the campaign", rows.flat().some((v) => String(v).includes("Budget headphones")), JSON.stringify(rows.slice(0, 3)));
}
{
  const none = buildCampaignXlsx(bundle({ include: { pages: false, searches: false, products: false, images: false, h2h: false } }));
  const names = none.wb.sheets.map((s) => s.name);
  check("with every optional table left out, their sheets go too", eq(names, ["Start here", "Overview", "Trends", "Brands", "Prompts", "Answer types", "Run over run", "Actions", "Answers", "Mentions"]), names.join(", "));
  const a = audit(none.wb);
  check("… and nothing points at a missing name or sheet", a.missingName.length === 0 && a.missingSheet.length === 0 && a.noCache.length === 0, JSON.stringify(a).slice(0, 200));
}
{
  const one = buildCampaignXlsx(bundle({ runs: runs.filter((r) => r.id === "r2"), records: r2 }));
  const names = one.wb.sheets.map((s) => s.name);
  check("one run: no Trends and no Run over run", !names.includes("Trends") && !names.includes("Run over run") && names.includes("Overview"), names.join(", "));
  const a = audit(one.wb);
  check("… and nothing points at a missing name or sheet", a.missingName.length === 0 && a.missingSheet.length === 0 && a.noCache.length === 0, JSON.stringify(a).slice(0, 200));
}
{
  const long = "word ".repeat(9000);
  const big = campaignFacts(bundle({ records: [{ ...r2[0], answerText: long }], answerText: "full" }));
  const ex = campaignFacts(bundle({ records: [{ ...r2[0], answerText: long }] }));
  check("full answer text stops below Excel's 32,767-character cell limit", big.A[0][col("A", "Answer text")].length === 32000);
  check("the excerpt is the first 300 characters", ex.A[0][col("A", "Answer text")].length === 300);
}

/* ---------- CSV ---------- */
console.log("CSV");
check("csvCell quotes commas, quotes and line breaks", csvCell('a,"b"\nc') === '"a,""b""\nc"', csvCell('a,"b"\nc'));
check("csvCell defuses text a spreadsheet would run as a formula", csvCell("=1+1") === "'=1+1" && csvCell("+44") === "'+44" && csvCell("@x") === "'@x" && csvCell("-a") === "'-a");
check("csvCell leaves numbers alone, negative ones too", csvCell(-3) === "-3" && csvCell(0) === "0" && csvCell(null) === "");
check("csvCell writes dates as ISO", csvCell(new Date(Date.UTC(2026, 9, 3))) === "2026-10-03T00:00:00.000Z");
{
  const cf = campaignCsvFiles(bundle());
  check("eight tables and a README", eq(cf.map((f) => f.name), ["answers.csv", "mentions.csv", "pages.csv", "searches.csv", "products.csv", "stores.csv", "images.csv", "head_to_head.csv", "README.txt"]), cf.map((f) => f.name).join(", "));
  const pages = parseCsv(cf.find((f) => f.name === "pages.csv").text);
  check("pages.csv: header row then one row per page opened", eq(pages[0], RAW.find((r) => r.key === "S").cols) && pages.length - 1 === F.S.length, pages.length);
  const evil = pages.find((r) => String(r[col("S", "Page title")]).includes("HYPERLINK"));
  check("a page title written as a formula comes back as text, intact", evil && evil[col("S", "Page title")] === "'=HYPERLINK(\"http://x\",\"Kovo, \"\"Air\"\" review\")", evil && evil[col("S", "Page title")]);
  const readme = cf.find((f) => f.name === "README.txt").text;
  check("the README names the campaign and counts each file", readme.startsWith("Budget headphones") && readme.includes(`answers.csv: One row per prompt × engine × run. 9 rows.`), readme.slice(0, 120));
  const some = campaignCsvFiles(bundle({ include: { pages: false, searches: true, products: false, images: false, h2h: false } }));
  check("left-out tables leave no file behind", eq(some.map((f) => f.name), ["answers.csv", "mentions.csv", "searches.csv", "README.txt"]), some.map((f) => f.name).join(", "));
}
{
  const c = campaignExportCounts(bundle());
  check("counts match the rows built", c.answers === 9 && c.mentions === F.M.length && c.pages === F.S.length && c.searches === F.Q.length && c.products === F.P.length && c.stores === F.O.length && c.h2h === 18 && c.runs === 2, JSON.stringify(c));
  check("counts carry each table's column count", c.cols.answers === RAW[0].cols.length && c.cols.h2h === RAW.find((r) => r.key === "H").cols.length);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
