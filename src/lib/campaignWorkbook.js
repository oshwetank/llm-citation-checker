/* campaignWorkbook.js — the whole of one campaign as a navigable workbook.
 *
 * Requested: "the normal dashboard has a download which gives an Excel with
 * 4-6 sub-sheets… can we have something similar with more depth, formatted,
 * structured and navigation friendly, that gives me the entire campaign
 * data."
 *
 * The ad-hoc export answers "what happened in my browsing". This answers a
 * different question — "what has this campaign measured, across every run" —
 * and the shape follows from that. Campaign data is inherently a set of
 * cross-tabs (prompt x run, brand x prompt, domain x engine), and the thing
 * that makes such an export useful rather than merely large is that each
 * cross-tab gets its OWN flat sheet with one fact per row. A single wide
 * sheet with merged cells looks tidier and cannot be pivoted, filtered or
 * charted; these can.
 *
 * Output is SpreadsheetML 2003 (.xls), the same format the existing audit
 * export uses. It is verbose but it is plain XML: no zip container, no
 * binary, no dependency, and it carries real styles, column widths, frozen
 * headers and autofilters — which is what "navigation friendly" needs. A true
 * .xlsx would mean hand-rolling a zip writer for no gain the user would see.
 *
 * This module is PURE: bundle in, XML string out. No DOM, no chrome.*, no
 * storage. That is what lets the row-building and the aggregation be tested
 * directly, which matters because the arithmetic here (share of voice,
 * mention rates, cited-vs-fetched) is the product, not decoration.
 */

import { normName, domainOfUrl } from "./geo.js";
import { parseQueryOperators, classifyQuery } from "./fanout.js";

/* ---------------------------------------------------------------- XML bits */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Control characters are illegal in XML 1.0 and make Excel refuse the
    // whole file rather than skip the cell — a single stray byte in a scraped
    // page title would otherwise cost the user the entire export.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

const isNum = (v) => typeof v === "number" && isFinite(v);

/* A cell. Numbers are written as numbers so Excel can sum and sort them —
 * exporting "12" as text is the classic reason a spreadsheet cannot be
 * charted without the reader retyping every column. */
function cell(v, style) {
  const st = style ? ` ss:StyleID="${style}"` : "";
  if (v === null || v === undefined || v === "") return `<Cell${st}/>`;
  if (isNum(v)) return `<Cell${st}><Data ss:Type="Number">${v}</Data></Cell>`;
  return `<Cell${st}><Data ss:Type="String">${esc(v)}</Data></Cell>`;
}

const row = (cells) => `   <Row>${cells}</Row>\n`;

/* One data sheet: title, header, rows — with the header frozen and filterable.
 *
 * Freezing and autofilter are the difference between a sheet you can work in
 * and one you scroll blindly. Both are set here rather than per-sheet so no
 * sheet can be built without them.
 */
function sheet({ name, title, subtitle, columns, rows: dataRows }) {
  const widths = columns.map((c) => `<Column ss:Width="${c.w || 110}"/>`).join("");
  const header = columns.map((c) => cell(c.h, "sHeader")).join("");

  let xml = ` <Worksheet ss:Name="${esc(name)}">\n  <Table>\n   ${widths}\n`;
  xml += row(cell(title, "sTitle"));
  if (subtitle) xml += row(cell(subtitle, "sNote"));
  else xml += `   <Row/>\n`;
  xml += row(header);
  for (const r of dataRows) {
    xml += row(r.map((v, i) => cell(v, columns[i] && columns[i].s)).join(""));
  }
  xml += `  </Table>\n`;
  // Row 3 is the header (title, subtitle, header), so the split is below it.
  xml += `  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">\n`;
  xml += `   <FreezePanes/><FrozenNoSplit/>\n`;
  xml += `   <SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane><ActivePane>2</ActivePane>\n`;
  xml += `  </WorksheetOptions>\n`;
  if (dataRows.length) {
    xml += `  <AutoFilter x:Range="R3C1:R3C${columns.length}" xmlns="urn:schemas-microsoft-com:office:excel"/>\n`;
  }
  xml += ` </Worksheet>\n`;
  return xml;
}

/* ------------------------------------------------------------- formatting */

const fmtDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtDur = (ms) => {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const round1 = (n) => (isNum(n) ? Math.round(n * 10) / 10 : null);

/* Engine ids are stored lowercase; nobody wants a column of "chatgpt". */
const ENGINE_LABEL = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", claude: "Claude", grok: "Grok" };
const engineName = (id) => ENGINE_LABEL[id] || id || "Unknown";

/* Every fan-out query a capture ran, flattened across the three buckets the
 * adapters keep them in. Defensive about shape: older captures stored plain
 * strings, newer ones objects, and an export that throws on one old record is
 * worse than one that renders it as best it can. */
function fanoutQueries(rec) {
  const f = (rec && rec.fanout) || {};
  const out = [];
  for (const kind of ["search", "shopping", "image"]) {
    for (const q of f[kind] || []) {
      const text = typeof q === "string" ? q : (q && (q.query || q.text || q.q)) || "";
      if (text) out.push({ kind, text: String(text) });
    }
  }
  return out;
}

const sourcesOf = (rec) => (rec && rec.sources) || [];
const isCited = (s) => !!(s && (s.cited || s.isCited || s.used));

/* ------------------------------------------------------------- aggregation */

/* Index prompts and runs so every sheet can name them rather than printing
 * opaque ids. A workbook full of UUIDs is technically complete and useless. */
function buildIndexes(bundle) {
  const promptById = new Map();
  for (const p of bundle.prompts || []) promptById.set(p.id, p);
  const runById = new Map();
  for (const r of bundle.runs || []) runById.set(r.id, r);
  // Runs numbered oldest-first, so "Run 1" means the first one, which is how
  // anyone reading a trend expects it to read.
  const ordered = [...(bundle.runs || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const runNo = new Map();
  ordered.forEach((r, i) => runNo.set(r.id, i + 1));
  return { promptById, runById, runNo, orderedRuns: ordered };
}

const recPromptText = (rec, promptById) => {
  const tp = rec && rec.geo && promptById.get(rec.geo.promptId);
  return (tp && tp.text) || (rec && rec.userPrompt) || "(unknown prompt)";
};

/* --------------------------------------------------------------- the sheets */

function sheetOverview(bundle, idx) {
  const p = bundle.profile || {};
  const recs = bundle.records || [];
  const m = bundle.metrics || { brands: [], totalResponses: 0 };
  const own = m.brands ? m.brands.find((b) => b.isOwn) : null;

  const engines = [...new Set(recs.map((r) => r.platform).filter(Boolean))];
  const first = recs.length ? Math.min(...recs.map((r) => r.capturedAt || 0)) : 0;
  const last = recs.length ? Math.max(...recs.map((r) => r.capturedAt || 0)) : 0;
  const withSearch = recs.filter((r) => r.searched).length;
  const totalFanout = recs.reduce((n, r) => n + fanoutQueries(r).length, 0);
  const allSources = recs.flatMap(sourcesOf);
  const citedCount = allSources.filter(isCited).length;
  const domains = new Set(allSources.map((s) => domainOfUrl(s.url)).filter(Boolean));

  const rows = [
    ["Campaign", p.name || "(untitled)"],
    ["Own brand", (p.brand && p.brand.name) || ""],
    ["Own domain", (p.brand && p.brand.url) || ""],
    ["Competitors tracked", (p.competitors || []).map((c) => c.name).join(", ")],
    ["Engines configured", (p.engines || []).map(engineName).join(", ")],
    ["Campaign locked", p.locked ? "Yes" : "No"],
    ["Created", fmtDate(p.createdAt)],
    [],
    ["MEASUREMENT"],
    ["Runs recorded", (bundle.runs || []).length],
    ["Tracked prompts", (bundle.prompts || []).length],
    ["Responses captured", recs.length],
    ["Engines seen in data", engines.map(engineName).join(", ")],
    ["First response", fmtDate(first)],
    ["Latest response", fmtDate(last)],
    [],
    ["RETRIEVAL"],
    ["Responses that searched", withSearch],
    ["Search rate %", pct(withSearch, recs.length)],
    ["Fan-out queries total", totalFanout],
    ["Fan-out per response (avg)", round1(recs.length ? totalFanout / recs.length : 0)],
    ["Sources seen (all)", allSources.length],
    ["…of which cited", citedCount],
    ["Cited share of sources %", pct(citedCount, allSources.length)],
    ["Distinct domains", domains.size],
    [],
    ["OWN BRAND"],
    ["Visibility % (responses mentioning it)", own ? round1(own.visibility) : 0],
    ["Share of voice %", own ? round1(own.share) : 0],
    ["Average position when mentioned", own && own.avgPosition != null ? round1(own.avgPosition) : ""],
    ["Responses citing your domain", own ? own.citations : 0],
    ["Your domain surfaced in % of responses", own ? round1(own.sourceVisibility) : 0],
  ];

  return sheet({
    name: "Overview",
    title: `Campaign: ${p.name || "(untitled)"}`,
    subtitle: `Generated ${fmtDate(bundle.generatedAt || Date.now())} · every run combined`,
    columns: [{ h: "Metric", w: 260 }, { h: "Value", w: 320 }],
    rows: rows.map((r) => (r.length ? r : ["", ""])),
  });
}

function sheetRuns(bundle, idx) {
  const rows = idx.orderedRuns.map((r) => {
    const recs = (bundle.records || []).filter((x) => x.geo && x.geo.runId === r.id);
    const reasons = Object.entries(r.reasons || {})
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; ");
    return [
      idx.runNo.get(r.id),
      fmtDate(r.startedAt),
      fmtDate(r.finishedAt),
      fmtDur(r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : 0),
      r.status || "",
      (r.engines || []).map(engineName).join(", "),
      r.expected || 0,
      // Counted from the stored responses rather than echoed from the run
      // record: the run's own counters were shown to over-count late captures
      // ("14/12 captured"), and a report that disagrees with the data it
      // ships is worse than one that simply recounts.
      recs.length,
      r.failed || 0,
      pct(recs.length, r.expected || 0),
      reasons,
    ];
  });
  return sheet({
    name: "Runs",
    title: "Run history",
    subtitle: "One row per campaign run, oldest first. Captured is recounted from the stored responses.",
    columns: [
      { h: "Run", w: 45 }, { h: "Started", w: 130 }, { h: "Finished", w: 130 }, { h: "Duration", w: 80 },
      { h: "Status", w: 70 }, { h: "Engines", w: 130 }, { h: "Expected", w: 70 },
      { h: "Captured", w: 70 }, { h: "Failed", w: 60 }, { h: "Complete %", w: 80, s: "sFloat" },
      { h: "Failure reasons", w: 320 },
    ],
    rows,
  });
}

function sheetPrompts(bundle, idx) {
  const brands = bundle.brands || [];
  const ownName = normName((bundle.profile && bundle.profile.brand && bundle.profile.brand.name) || "");

  const rows = (bundle.prompts || []).map((tp) => {
    const recs = (bundle.records || []).filter((r) => r.geo && r.geo.promptId === tp.id);
    const engines = [...new Set(recs.map((r) => r.platform))];
    const runs = new Set(recs.map((r) => r.geo && r.geo.runId).filter(Boolean));

    let mentioned = 0, positions = [], citedOwn = 0;
    for (const r of recs) {
      const hit = (r.brandMentions || []).find((m) => normName(m.brand) === ownName);
      if (hit) {
        mentioned++;
        const i = (r.brandMentions || [])
          .slice().sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15))
          .findIndex((m) => normName(m.brand) === ownName);
        if (i >= 0) positions.push(i + 1);
      }
      const dom = (bundle.profile && bundle.profile.brand && bundle.profile.brand.url) || "";
      if (dom && sourcesOf(r).some((s) => (domainOfUrl(s.url) || "").includes(normName(dom).replace(/[^a-z0-9.]/g, "")))) citedOwn++;
    }
    const fan = recs.reduce((n, r) => n + fanoutQueries(r).length, 0);
    const srcs = recs.flatMap(sourcesOf);

    return [
      tp.text || "",
      (tp.tags || []).join(", "),
      tp.active === false ? "No" : "Yes",
      runs.size,
      recs.length,
      engines.map(engineName).join(", "),
      mentioned,
      pct(mentioned, recs.length),
      positions.length ? round1(positions.reduce((a, b) => a + b, 0) / positions.length) : "",
      citedOwn,
      round1(recs.length ? fan / recs.length : 0),
      round1(recs.length ? srcs.length / recs.length : 0),
      pct(srcs.filter(isCited).length, srcs.length),
    ];
  });

  return sheet({
    name: "Prompts",
    title: "Prompt performance",
    subtitle: `One row per tracked prompt, measured for ${(bundle.profile && bundle.profile.brand && bundle.profile.brand.name) || "your brand"} across every run.`,
    columns: [
      { h: "Prompt", w: 340 }, { h: "Tags", w: 110 }, { h: "Active", w: 55 },
      { h: "Runs", w: 50 }, { h: "Responses", w: 75 }, { h: "Engines", w: 120 },
      { h: "Times mentioned", w: 100 }, { h: "Mention rate %", w: 95, s: "sFloat" },
      { h: "Avg position", w: 85, s: "sFloat" }, { h: "Your domain cited", w: 105 },
      { h: "Fan-out per response", w: 115, s: "sFloat" }, { h: "Sources per response", w: 115, s: "sFloat" },
      { h: "Cited share %", w: 90, s: "sFloat" },
    ],
    rows,
  });
}

/* The cross-tab that makes trends legible: one row per prompt PER RUN PER
 * ENGINE. Everything else in this workbook is an aggregate of this sheet, so
 * it is the one to pivot when a number elsewhere looks wrong. */
function sheetPromptResults(bundle, idx) {
  const ownName = normName((bundle.profile && bundle.profile.brand && bundle.profile.brand.name) || "");
  const rows = (bundle.records || [])
    .slice()
    .sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0))
    .map((r) => {
      const ordered = (r.brandMentions || []).slice()
        .sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15));
      const pos = ordered.findIndex((m) => normName(m.brand) === ownName);
      const srcs = sourcesOf(r);
      return [
        idx.runNo.get(r.geo && r.geo.runId) || "",
        fmtDate(r.capturedAt),
        engineName(r.platform),
        r.model || "",
        recPromptText(r, idx.promptById),
        r.searched ? "Yes" : "No",
        fanoutQueries(r).length,
        srcs.length,
        srcs.filter(isCited).length,
        new Set(srcs.map((s) => domainOfUrl(s.url)).filter(Boolean)).size,
        ordered.length,
        pos >= 0 ? "Yes" : "No",
        pos >= 0 ? pos + 1 : "",
        ordered.slice(0, 8).map((m) => m.brand).join(", "),
        r.answerChars || 0,
      ];
    });

  return sheet({
    name: "Prompt Results",
    title: "Every response, one row each",
    subtitle: "The grain of this workbook: prompt x run x engine. Pivot this sheet to rebuild any other.",
    columns: [
      { h: "Run", w: 45 }, { h: "Captured", w: 125 }, { h: "Engine", w: 80 }, { h: "Model", w: 110 },
      { h: "Prompt", w: 300 }, { h: "Searched", w: 70 }, { h: "Fan-out", w: 65 },
      { h: "Sources", w: 65 }, { h: "Cited", w: 55 }, { h: "Domains", w: 70 },
      { h: "Brands named", w: 90 }, { h: "You mentioned", w: 95 }, { h: "Your position", w: 90 },
      { h: "Brands in order of appearance", w: 320 }, { h: "Answer chars", w: 90 },
    ],
    rows,
  });
}

function sheetBrands(bundle, idx) {
  const recs = bundle.records || [];
  const agg = new Map();
  for (const r of recs) {
    const ordered = (r.brandMentions || []).slice()
      .sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15));
    ordered.forEach((m, i) => {
      const key = normName(m.brand);
      if (!key) return;
      const a = agg.get(key) || { name: m.brand, mentions: 0, responses: 0, positions: [], engines: new Set(), prompts: new Set(), first: Infinity, last: 0 };
      a.mentions += Number(m.count) || 1;
      a.responses++;
      a.positions.push(i + 1);
      a.engines.add(r.platform);
      if (r.geo && r.geo.promptId) a.prompts.add(r.geo.promptId);
      a.first = Math.min(a.first, r.capturedAt || 0);
      a.last = Math.max(a.last, r.capturedAt || 0);
      agg.set(key, a);
    });
  }
  const pool = [...agg.values()].reduce((n, a) => n + a.mentions, 0);
  const tracked = new Set((bundle.brands || []).map((b) => normName(b.name || b)));
  const ownName = normName((bundle.profile && bundle.profile.brand && bundle.profile.brand.name) || "");

  const rows = [...agg.values()]
    .sort((a, b) => b.responses - a.responses || b.mentions - a.mentions)
    .map((a) => [
      a.name,
      normName(a.name) === ownName ? "Own brand" : tracked.has(normName(a.name)) ? "Tracked competitor" : "Discovered",
      a.responses,
      pct(a.responses, recs.length),
      a.mentions,
      pct(a.mentions, pool),
      round1(a.positions.reduce((x, y) => x + y, 0) / a.positions.length),
      Math.min(...a.positions),
      a.prompts.size,
      [...a.engines].map(engineName).join(", "),
      fmtDate(a.first === Infinity ? 0 : a.first),
      fmtDate(a.last),
    ]);

  return sheet({
    name: "Brands",
    title: "Every brand the engines named",
    subtitle: "Tracked brands and ones discovered in the answers. Share of voice is of all mentions in this campaign.",
    columns: [
      { h: "Brand", w: 180 }, { h: "Type", w: 130 }, { h: "Responses", w: 80 },
      { h: "Visibility %", w: 85, s: "sFloat" }, { h: "Mentions", w: 75 },
      { h: "Share of voice %", w: 105, s: "sFloat" }, { h: "Avg position", w: 85, s: "sFloat" },
      { h: "Best position", w: 85 }, { h: "Prompts", w: 65 }, { h: "Engines", w: 120 },
      { h: "First seen", w: 125 }, { h: "Last seen", w: 125 },
    ],
    rows,
  });
}

function sheetBrandByPrompt(bundle, idx) {
  const rows = [];
  const seen = new Map();
  for (const r of bundle.records || []) {
    const promptText = recPromptText(r, idx.promptById);
    const ordered = (r.brandMentions || []).slice()
      .sort((a, b) => (a.firstIndex ?? 1e15) - (b.firstIndex ?? 1e15));
    ordered.forEach((m, i) => {
      const key = `${normName(m.brand)}||${promptText}`;
      const s = seen.get(key) || { brand: m.brand, prompt: promptText, responses: 0, positions: [], engines: new Set(), runs: new Set() };
      s.responses++;
      s.positions.push(i + 1);
      s.engines.add(r.platform);
      if (r.geo && r.geo.runId) s.runs.add(r.geo.runId);
      seen.set(key, s);
    });
  }
  for (const s of [...seen.values()].sort((a, b) => a.prompt.localeCompare(b.prompt) || b.responses - a.responses)) {
    rows.push([
      s.prompt, s.brand, s.responses, s.runs.size,
      round1(s.positions.reduce((x, y) => x + y, 0) / s.positions.length),
      Math.min(...s.positions),
      [...s.engines].map(engineName).join(", "),
    ]);
  }
  return sheet({
    name: "Brand by Prompt",
    title: "Which brands win which prompts",
    subtitle: "One row per brand per prompt. Sort by position to find the prompts where a rival consistently leads.",
    columns: [
      { h: "Prompt", w: 320 }, { h: "Brand", w: 170 }, { h: "Responses", w: 80 },
      { h: "Runs", w: 55 }, { h: "Avg position", w: 90, s: "sFloat" },
      { h: "Best position", w: 90 }, { h: "Engines", w: 130 },
    ],
    rows,
  });
}

function sheetDomains(bundle, idx) {
  const agg = new Map();
  for (const r of bundle.records || []) {
    const perRec = new Set();
    for (const s of sourcesOf(r)) {
      const d = domainOfUrl(s.url);
      if (!d) continue;
      const a = agg.get(d) || { domain: d, appearances: 0, cited: 0, responses: new Set(), prompts: new Set(), engines: new Set(), urls: new Set() };
      a.appearances++;
      if (isCited(s)) a.cited++;
      a.urls.add(s.url);
      a.engines.add(r.platform);
      if (r.geo && r.geo.promptId) a.prompts.add(r.geo.promptId);
      if (!perRec.has(d)) { a.responses.add(r.captureId); perRec.add(d); }
      agg.set(d, a);
    }
  }
  const total = (bundle.records || []).length;
  const rows = [...agg.values()]
    .sort((a, b) => b.responses.size - a.responses.size || b.cited - a.cited)
    .map((a) => [
      a.domain, a.responses.size, pct(a.responses.size, total),
      a.appearances, a.cited, a.appearances - a.cited, pct(a.cited, a.appearances),
      a.urls.size, a.prompts.size, [...a.engines].map(engineName).join(", "),
    ]);

  return sheet({
    name: "Domains",
    title: "Source domains",
    subtitle: "Cited means the answer linked to it; read-only means the engine fetched it without citing.",
    columns: [
      { h: "Domain", w: 220 }, { h: "Responses", w: 80 }, { h: "Reach %", w: 70, s: "sFloat" },
      { h: "Appearances", w: 90 }, { h: "Cited", w: 60 }, { h: "Read-only", w: 75 },
      { h: "Cited %", w: 70, s: "sFloat" }, { h: "Distinct pages", w: 90 },
      { h: "Prompts", w: 65 }, { h: "Engines", w: 120 },
    ],
    rows,
  });
}

function sheetPages(bundle, idx) {
  const agg = new Map();
  for (const r of bundle.records || []) {
    for (const s of sourcesOf(r)) {
      if (!s || !s.url) continue;
      const a = agg.get(s.url) || { url: s.url, title: s.title || "", appearances: 0, cited: 0, prompts: new Set(), engines: new Set() };
      a.appearances++;
      if (isCited(s)) a.cited++;
      if (!a.title && s.title) a.title = s.title;
      a.engines.add(r.platform);
      if (r.geo && r.geo.promptId) a.prompts.add(r.geo.promptId);
      agg.set(s.url, a);
    }
  }
  const rows = [...agg.values()]
    .sort((a, b) => b.cited - a.cited || b.appearances - a.appearances)
    .map((a) => [
      a.title || "(no title)", a.url, domainOfUrl(a.url) || "",
      a.appearances, a.cited, pct(a.cited, a.appearances),
      a.prompts.size, [...a.engines].map(engineName).join(", "),
    ]);

  return sheet({
    name: "Pages",
    title: "Individual pages the engines used",
    subtitle: "Page-level detail behind the Domains sheet — the specific URLs worth targeting.",
    columns: [
      { h: "Title", w: 300 }, { h: "URL", w: 380 }, { h: "Domain", w: 170 },
      { h: "Appearances", w: 90 }, { h: "Cited", w: 60 }, { h: "Cited %", w: 70, s: "sFloat" },
      { h: "Prompts", w: 65 }, { h: "Engines", w: 120 },
    ],
    rows,
  });
}

/* The retrieval layer: what the engine actually searched for, as opposed to
 * what the user asked. This is where site: operators show up, and they are
 * the most actionable thing in the whole export — an engine scoping a search
 * to a domain has decided that domain is authoritative for the question. */
function sheetFanout(bundle, idx) {
  const rows = [];
  for (const r of (bundle.records || []).slice().sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0))) {
    const prompt = recPromptText(r, idx.promptById);
    const citedDomains = new Set(sourcesOf(r).map((s) => domainOfUrl(s.url)).filter(Boolean));
    for (const q of fanoutQueries(r)) {
      // Field names come from parseQueryOperators: siteIncludes / phrases.
      // Guessing them (site / quoted) left both columns silently empty and the
      // content-gap flag permanently blank — caught only because the test
      // asserted the flag rather than merely that the domain appeared
      // somewhere on the sheet, which it did, in the raw query column.
      let ops = { siteIncludes: [], siteExcludes: [], phrases: [] };
      let kind = "";
      try { ops = parseQueryOperators(q.text) || ops; } catch (_) { /* keep the raw query */ }
      try { kind = classifyQuery(q.text) || ""; } catch (_) { /* optional */ }
      const sites = [...(ops.siteIncludes || []), ...(ops.siteExcludes || []).map((d) => `-${d}`)];
      const scoped = ops.siteIncludes || [];
      rows.push([
        idx.runNo.get(r.geo && r.geo.runId) || "",
        engineName(r.platform),
        prompt,
        q.kind,
        q.text,
        String(q.text).trim().split(/\s+/).filter(Boolean).length,
        kind,
        sites.join(", "),
        // The cross-check worth having: the engine scoped a search to a
        // domain and then cited nothing from it, which says the page it
        // wanted was not there to find.
        scoped.length ? (scoped.some((d) => [...citedDomains].some((c) => c.includes(d) || d.includes(c))) ? "Yes" : "No") : "",
        (ops.phrases || []).join(" | "),
      ]);
    }
  }
  return sheet({
    name: "Fan-out Queries",
    title: "What the engines searched for",
    subtitle: "Every sub-query behind every answer. A site: scope that produced no citation is a content gap on that domain.",
    columns: [
      { h: "Run", w: 45 }, { h: "Engine", w: 80 }, { h: "Prompt", w: 260 },
      { h: "Type", w: 70 }, { h: "Query", w: 340 }, { h: "Words", w: 55 },
      { h: "Intent", w: 100 }, { h: "site: scopes", w: 160 },
      { h: "Cited from that site", w: 110 }, { h: "Quoted phrases", w: 200 },
    ],
    rows,
  });
}

function sheetDiagnostics(bundle, idx) {
  const rows = [];
  for (const r of idx.orderedRuns) {
    const stored = (bundle.records || []).filter((x) => x.geo && x.geo.runId === r.id).length;
    const missing = Math.max(0, (r.expected || 0) - stored);
    rows.push([
      idx.runNo.get(r.id), fmtDate(r.startedAt), r.status || "",
      r.expected || 0, stored, missing, r.failed || 0,
      Object.entries(r.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; "),
    ]);
  }
  // The error log's own grouped view, so a run that went wrong and the reason
  // it went wrong sit in the same file.
  for (const e of bundle.errors || []) {
    rows.push(["", fmtDate(e.lastAt), "error", "", "", "", e.count || 1,
      `[${e.where}] ${e.message}${e.trace ? ` — timeline: ${e.trace}` : ""}`]);
  }
  return sheet({
    name: "Diagnostics",
    title: "What went wrong, and where",
    subtitle: "Missing = expected minus responses actually stored. Error rows carry the per-turn timeline when there is one.",
    columns: [
      { h: "Run", w: 45 }, { h: "When", w: 130 }, { h: "Status", w: 70 },
      { h: "Expected", w: 70 }, { h: "Stored", w: 65 }, { h: "Missing", w: 65 },
      { h: "Failed / count", w: 90 }, { h: "Detail", w: 560 },
    ],
    rows,
  });
}

/* The index goes first so the workbook opens on a map of itself rather than
 * on whichever sheet happened to be built first. */
function sheetIndex(entries, bundle) {
  const rows = entries.map((e) => [e.name, e.what, e.rows]);
  return sheet({
    name: "Index",
    title: `CitoSkeleton — ${(bundle.profile && bundle.profile.name) || "campaign"} export`,
    subtitle: `Generated ${fmtDate(bundle.generatedAt || Date.now())}. Every sheet has a frozen header and filters on row 3.`,
    columns: [{ h: "Sheet", w: 150 }, { h: "What it holds", w: 620 }, { h: "Rows", w: 60 }],
    rows,
  });
}

/* ------------------------------------------------------------------- entry */

export function buildCampaignWorkbook(bundle = {}) {
  const idx = buildIndexes(bundle);
  const recs = bundle.records || [];

  const built = [
    { name: "Overview", what: "Campaign identity, retrieval totals and own-brand headline numbers.", xml: sheetOverview(bundle, idx), rows: 30 },
    { name: "Runs", what: "One row per run: timing, completeness and failure reasons.", xml: sheetRuns(bundle, idx), rows: idx.orderedRuns.length },
    { name: "Prompts", what: "One row per tracked prompt, aggregated across every run.", xml: sheetPrompts(bundle, idx), rows: (bundle.prompts || []).length },
    { name: "Prompt Results", what: "The grain: one row per response (prompt x run x engine). Pivot this to rebuild any other sheet.", xml: sheetPromptResults(bundle, idx), rows: recs.length },
    { name: "Brands", what: "Every brand named, with visibility, share of voice and average position.", xml: sheetBrands(bundle, idx), rows: 0 },
    { name: "Brand by Prompt", what: "Which brands lead which prompts — where a rival consistently outranks you.", xml: sheetBrandByPrompt(bundle, idx), rows: 0 },
    { name: "Domains", what: "Source domains, split by cited versus fetched-but-not-cited.", xml: sheetDomains(bundle, idx), rows: 0 },
    { name: "Pages", what: "The individual URLs behind those domains.", xml: sheetPages(bundle, idx), rows: 0 },
    { name: "Fan-out Queries", what: "Every sub-query the engines ran, with site: scopes and whether they produced a citation.", xml: sheetFanout(bundle, idx), rows: 0 },
    { name: "Diagnostics", what: "Missing responses per run, failure reasons, and the error log with per-turn timelines.", xml: sheetDiagnostics(bundle, idx), rows: 0 },
  ];

  // Row counts on the index are read off the built XML rather than recomputed,
  // so they can never drift from what the sheet actually contains.
  for (const b of built) {
    b.rows = Math.max(0, (b.xml.match(/<Row>/g) || []).length - 3);
  }

  let xml = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n`;
  xml += `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n`;
  xml += ` xmlns:o="urn:schemas-microsoft-com:office:office"\n`;
  xml += ` xmlns:x="urn:schemas-microsoft-com:office:excel"\n`;
  xml += ` xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"\n`;
  xml += ` xmlns:html="http://www.w3.org/TR/REC-html40">\n`;
  xml += ` <Styles>\n`;
  xml += `  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>\n`;
  xml += `  <Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="14"/></Style>\n`;
  xml += `  <Style ss:ID="sNote"><Font ss:Italic="1" ss:Color="#606060"/></Style>\n`;
  xml += `  <Style ss:ID="sHeader"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2F5597" ss:Pattern="Solid"/><Alignment ss:Vertical="Bottom" ss:WrapText="1"/></Style>\n`;
  xml += `  <Style ss:ID="sFloat"><NumberFormat ss:Format="0.0"/></Style>\n`;
  xml += ` </Styles>\n`;

  xml += sheetIndex(built, bundle);
  for (const b of built) xml += b.xml;
  xml += `</Workbook>\n`;
  return xml;
}

/* Exported for tests: the sheet names, in order, that a workbook must contain.
 * A sheet quietly disappearing is exactly the kind of regression that only
 * shows up when someone opens the file weeks later. */
export const SHEET_ORDER = [
  "Index", "Overview", "Runs", "Prompts", "Prompt Results", "Brands",
  "Brand by Prompt", "Domains", "Pages", "Fan-out Queries", "Diagnostics",
];
