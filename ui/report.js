/* report.js — the PDF reports (0.53.0), laid out as A4 pages.
 *
 * ?kind=campaign&profileId=…&runId=…&sections=brands,prompts,…&engines=chatgpt,…
 *   a campaign's run, on the engines chosen (default: all of them);
 * ?kind=answer&captureId=…  one captured answer, two pages;
 * &print=1 opens the print dialog once the pages are laid out.
 *
 * The numbers come from the background (campaign-report), worked out by
 * src/lib/campaignReport.js; this file only lays them out. Every value that
 * came from a capture (brand names, page titles, searches, prompts) goes
 * through esc() — the markup is built as strings, and a page title is
 * whatever the web said it was.
 *
 * Pages are fixed A4 boxes. When a page's content is taller than the page,
 * paginate() moves the last rows of a long table (or the last block) onto a
 * continuation page, so nothing is ever cut off at the bottom.
 */

import { answerReport } from "../src/lib/answerReport.js";
import { dayLabel } from "../src/lib/campaignReport.js";

/* ---------- markup ---------- */
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : v === null || v === undefined || v === false ? "" : esc(v));
/** Template tag: interpolations are escaped unless they are raw() or html``. */
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return raw(out);
}

/* ---------- numbers ---------- */
const P = (x) => (x == null ? "—" : `${Math.round(x)}%`);
const D1 = (x) => (x == null ? "—" : Number(x).toFixed(1));
const N = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));
const money = (x) => (x == null ? "—" : `₹${Math.round(x).toLocaleString("en-IN")}`);

/* ---------- colours ----------
 * The panel's categorical hues, in its fixed order: your brand is always
 * the blue, each rival keeps its colour on every chart in the report. */
const RIVAL_COLORS = ["#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#64748b", "#c2410c"];
const KIND_COLORS = { "Your site": "#2a78d6", "Rival brand sites": "#eb6834", "Review sites": "#1baf7a", "Retailers": "#eda100", "Forums & social": "#e87ba4", "Other": "#94a3b8" };
let colorOf = () => "#64748b";
function setBrandColors(model) {
  const map = new Map([[model.own.name.toLowerCase(), "#2a78d6"]]);
  const names = [...model.competitors];
  const brands = model.pages.find((p) => p.key === "summary").sov.map((b) => b.name);
  brands.forEach((b) => { if (!names.includes(b)) names.push(b); });
  names.filter((b) => b.toLowerCase() !== model.own.name.toLowerCase()).forEach((b, i) => map.set(b.toLowerCase(), RIVAL_COLORS[i % RIVAL_COLORS.length]));
  colorOf = (name) => map.get(String(name).toLowerCase()) || "#64748b";
}
function heatCell(v) {
  if (v == null) return { bg: "#ffffff", fg: "#cbd5e1", t: "—" };
  const steps = [[75, "#1b5fb4", "#ffffff"], [65, "#2a78d6", "#ffffff"], [50, "#5b94e3", "#0f172a"], [35, "#8db6ef", "#0f172a"], [20, "#b8d1f5", "#0f172a"], [1, "#dbe8fb", "#0f172a"]];
  const s = steps.find(([min]) => v >= min);
  return s ? { bg: s[1], fg: s[2], t: `${v}%` } : { bg: "#f8fafc", fg: "#94a3b8", t: "0%" };
}

/* ---------- charts (SVG strings) ---------- */
function lineChart(trend) {
  const W = 380, H = 190, x0 = 36, x1 = 284, yTop = 12, yBot = 166;
  const n = trend.runs.length;
  const xs = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1));
  const ys = (v) => yBot - ((yBot - yTop) * v) / 100;
  let s = "";
  [0, 25, 50, 75, 100].forEach((t) => { s += `<line x1="${x0}" x2="${x1}" y1="${ys(t)}" y2="${ys(t)}" stroke="#eef2f7" stroke-width="1"/><text x="30" y="${ys(t) + 3}" font-size="9" fill="#64748b" text-anchor="end">${t}%</text>`; });
  trend.runs.forEach((r, i) => { s += `<text x="${xs(i)}" y="184" font-size="9" fill="#475569" text-anchor="middle">${esc(r)}</text>`; });
  const series = [...trend.series].sort((a, b) => (a.isOwn ? 1 : 0) - (b.isOwn ? 1 : 0)); // yours drawn last, on top
  series.forEach((se) => {
    const c = colorOf(se.name);
    const pts = se.values.map((v, i) => (v == null ? null : [xs(i), ys(v)])).filter(Boolean);
    if (pts.length > 1) s += `<polyline fill="none" stroke="${c}" stroke-width="${se.isOwn ? 2.6 : 2}" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((p) => p.join(",")).join(" ")}"/>`;
    pts.forEach(([x, y]) => { s += `<circle cx="${x}" cy="${y}" r="3.6" fill="${c}" stroke="#ffffff" stroke-width="2"/>`; });
  });
  // End labels, nudged apart so none overlap.
  const labels = trend.series.map((se) => {
    const last = [...se.values].reverse().find((v) => v != null);
    return { se, v: last, y: ys(last ?? 0) + 3 };
  }).filter((l) => l.v != null).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 11);
  const over = labels.length ? labels[labels.length - 1].y - (H - 4) : 0;
  if (over > 0) labels.forEach((l) => { l.y -= over; });
  labels.forEach((l) => {
    s += `<text x="292" y="${l.y}" font-size="9.5" fill="#0f172a" font-weight="${l.se.isOwn ? 800 : 500}"><tspan fill="${colorOf(l.se.name)}">●</tspan> ${esc(l.se.name)} ${Math.round(l.v)}%</text>`;
  });
  return raw(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Visibility by run, line chart">${s}</svg>`);
}

/** Horizontal bars: rows of { label, value (0-100), color, bold, text }. */
function barList(rows, { width = 520, labelW = 70, max } = {}) {
  const top = max || Math.max(1, ...rows.map((r) => r.value || 0));
  const track = width - labelW - 40;
  let s = "";
  rows.forEach((r, i) => {
    const y = 5 + i * 15;
    const w = Math.max(0, (track * (r.value || 0)) / top);
    s += `<text x="0" y="${y + 8}" font-size="9" fill="#0f172a" font-weight="${r.bold ? 800 : 500}">${esc(clip(r.label, Math.floor(labelW / 5.4)))}</text>`;
    s += `<rect x="${labelW}" y="${y}" width="${track}" height="9" rx="2" fill="#eef2f7"/>`;
    if (w > 0) s += `<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="9" rx="2" fill="${r.color}"/>`;
    s += `<text x="${labelW + track + 5}" y="${y + 8}" font-size="9" fill="#0f172a" font-weight="700">${esc(r.text ?? P(r.value))}</text>`;
  });
  return raw(`<svg viewBox="0 0 ${width} ${rows.length * 15 + 4}" width="100%" role="img">${s}</svg>`);
}

/** Stacked bars: rows of { label, parts: [{ n, color, dark }] } (counts). */
function stackedBars(rows, { width = 340, labelW = 64 } = {}) {
  const total = Math.max(1, ...rows.map((r) => r.parts.reduce((a, p) => a + p.n, 0)));
  const track = width - labelW - 6;
  let s = "";
  rows.forEach((r, i) => {
    const y = 5 + i * 21;
    s += `<text x="0" y="${y + 9}" font-size="9" fill="#0f172a" font-weight="600">${esc(clip(r.label, 12))}</text>`;
    let x = labelW;
    r.parts.forEach((p) => {
      if (!p.n) return;
      const w = (track * p.n) / total;
      s += `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, w - 2).toFixed(1)}" height="12" fill="${p.color}"/>`;
      if (w >= 12) s += `<text x="${(x + (w - 2) / 2).toFixed(1)}" y="${y + 9}" font-size="8" fill="${p.dark ? "#ffffff" : "#0f172a"}" text-anchor="middle" font-weight="700">${p.n}</text>`;
      x += w;
    });
  });
  return raw(`<svg viewBox="0 0 ${width} ${rows.length * 21 + 4}" width="100%" role="img">${s}</svg>`);
}
const legend = (items) => html`<div class="legend">${items.map(([c, t]) => html`<span><span class="sw" style="background:${raw(c)}"></span>${t}</span>`)}</div>`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/* ---------- blocks ---------- */
let blkSeq = 0;
/** A block the paginator can move; split = a long table it may split by rows. */
const blk = (content, { split = false } = {}) => html`<div class="blk" data-blk="${String(++blkSeq)}"${raw(split ? " data-splittable" : "")}>${content}</div>`;
const card = (title, ...kids) => html`<div class="card"><h3>${title}</h3>${kids}</div>`;
const table = (head, rows, { split = false, cls = "" } = {}) => html`<table${raw(cls ? ` class="${cls}"` : "")}${raw(split ? " data-split" : "")}><thead><tr>${head.map((h) => (Array.isArray(h) ? html`<th class="${h[1]}">${h[0]}</th>` : html`<th>${h}</th>`))}</tr></thead><tbody>${rows}</tbody></table>`;
const note = (t) => html`<p class="note">${t}</p>`;
const pos = (c) => {
  if (!c) return html`<span class="pos pn">·</span>`;
  if (c.pos === 0) return html`<span class="pos p0">✕</span>`;
  if (c.pos === "shown") return html`<span class="pos p3">card</span>`;
  return html`<span class="pos ${c.pos === 1 ? "p1" : c.pos === 2 ? "p2" : "p3"}">#${c.pos}</span>`;
};

/* ---------- the campaign report's pages ---------- */
function summaryPage(m, p) {
  const k = p.kpis.map((t) => html`<div class="kpi"><span class="l">${t.label}</span><span class="v">${t.value}</span><span class="d ${t.delta ? (t.delta.tone > 0 ? "up" : t.delta.tone < 0 ? "down" : "flat") : "flat"}">${t.delta ? t.delta.text : t.sub}</span></div>`);
  return {
    titles: html`<div class="titles"><span class="eyebrow">Campaign report · ${m.run.label} of ${String(m.run.of)}</span><h1>${m.campaign}</h1>
      <p class="lede">${m.lede}</p>
      <div class="meta"><span>Your brand <b>${m.own.name}</b>${m.own.domain ? ` · ${m.own.domain}` : ""}</span>${m.competitors.length ? html`<span>Competitors <b>${m.competitors.join(", ")}</b></span>` : ""}<span>Runs <b>${m.runDates.length > 4 ? `${m.runDates.length} runs, ${m.runDates[0]} – ${m.runDates[m.runDates.length - 1]}` : m.runDates.join(" · ")}</b></span><span>Answers <b>${N(m.answers.all)}</b></span></div></div>`,
    blocks: [
      blk(html`<div class="kpis">${k}</div>`),
      blk(html`<div class="grid32">${card("Visibility by run", note("Share of answers that named each brand. All engines."), lineChart(p.trend))}${card("What the numbers say", html`<ul class="find">${p.findings.map((f, i) => html`<li><b class="k">${String(i + 1)}</b><span>${f}</span></li>`)}</ul>`)}</div>`),
      blk(card(`Share of voice, ${m.run.label.toLowerCase()}`, note("A brand’s mentions ÷ mentions of every tracked brand."),
        barList(p.sov.map((b) => ({ label: b.name, value: b.value, color: colorOf(b.name), bold: b.isOwn }))))),
    ],
  };
}

function brandsPage(m, p) {
  const run = m.run.label.toLowerCase();
  const own = m.own.name;
  const rows = p.scorecard.map((b) => html`<tr${raw(b.isOwn ? ' class="you"' : "")}><td><span class="sw" style="background:${raw(colorOf(b.name))}"></span>${b.name}${b.auto ? html` <span class="small muted">found in answers</span>` : ""}</td><td class="n">${P(b.visibility)}</td><td class="n">${P(b.shareOfVoice)}</td><td class="n">${D1(b.avgPosition)}</td><td class="n">${N(b.namedFirst)}</td><td class="n">${P(b.backedPct)}</td><td class="n">${N(b.ownCitations)}</td><td class="n">${P(b.cardShare)}</td></tr>`);
  const heat = p.heat.rows.map((r) => html`<tr><td>${r.isOwn ? html`<b>${r.name}</b>` : r.name}</td>${r.cells.map((v) => { const c = heatCell(v); return html`<td class="c" style="background:${raw(c.bg)};color:${raw(c.fg)};font-weight:700">${c.t}</td>`; })}</tr>`);
  const H2H = [["ahead", "#047857", `${own} ahead`, true], ["onlyYou", "#86efac", `Only ${own}`], ["both", "#e2e8f0", "Both, no order"], ["neither", "#cbd5e1", "Neither named"], ["onlyThem", "#fca5a5", "Only rival"], ["behind", "#be123c", "Rival ahead", true]];
  const BACK = [["independent", "#1b5fb4", "Independent pages", true], ["ownOnly", "#8db6ef", "Own site only"], ["nothing", "#f4a8a8", "Nothing behind it"], ["memory", "#cbd5e1", "From memory"]];
  const used = (defs, list) => defs.filter(([key]) => list.some((r) => r[key]));
  const h2hDefs = used(H2H, p.h2h);
  const backDefs = used(BACK, p.backing);
  return {
    titles: html`<div class="titles"><span class="eyebrow">Brands</span><h2>Who gets named, how often, and what backs them</h2></div>`,
    blocks: [
      blk(html`${table(["Brand", ["Visibility", "n"], ["Share of voice", "n"], ["Avg position", "n"], ["Named first", "n"], ["Backed by independent pages", "n"], ["Own-site citations", "n"], ["Card share", "n"]], rows, { split: true })}${note("Backed by independent pages = a cited page other than the brand’s own site mentions it. Avg position: 1 = named first.")}`, { split: true }),
      blk(html`<div class="grid2">${card(`Visibility on each engine, ${run}`, table(["Brand", ...p.heat.engines.map((e) => [e, "c"])], heat), note(`Darker = named more often.${p.heat.note ? ` ${p.heat.note}` : ""}`))}${p.h2h.length ? card(`${own} head to head, ${run}`, legend(h2hDefs.map(([, c, t]) => [c, t])), stackedBars(p.h2h.map((r) => ({ label: r.name, parts: h2hDefs.map(([key, color, , dark]) => ({ n: r[key], color, dark })) }))), note(`Count of the ${p.answers} answers. Green = ${own} ahead, red = rival ahead.`)) : card("Head to head", note("No competitors on this campaign yet."))}</div>`),
      blk(html`<div class="grid32">${card(`What backs each brand, ${run}`, legend(backDefs.map(([, c, t]) => [c, t])), stackedBars(p.backing.map((r) => ({ label: r.name, parts: backDefs.map(([key, color, , dark]) => ({ n: r[key], color, dark })) }))), note("Count of answers naming the brand, by what stands behind the mention. Independent pages are the strongest backing."))}${card("What the engines recommend each brand for", p.recommend.length
        ? table(["Brand", "Most-given reasons (times)"], p.recommend.map((r) => html`<tr${raw(r.isOwn ? ' class="you"' : "")}><td>${r.name}</td><td>${r.aspects.map((a, i) => html`${i ? " · " : ""}${a.label} <b>${String(a.n)}</b>`)}</td></tr>`))
        : note("The answers gave no reasons often enough to list."))}</div>`),
    ],
  };
}

function promptsPage(m, p) {
  const own = m.own.name;
  const head = ["ID", "Prompt", ...p.engines.map((e) => [e, "c"]), ...(p.hasPrevious ? [["Change", "c"]] : []), "Strongest rival", [`Cites ${own} site`, "c"]];
  const rows = p.rows.map((r) => html`<tr><td><b>${r.id}</b></td><td class="wrap">${r.text}<br><span class="small muted">${[r.tags.join(", "), r.kind].filter(Boolean).join(" · ")}</span></td>${r.cells.map((c) => html`<td class="c">${pos(c)}</td>`)}${p.hasPrevious ? html`<td class="c">${r.change == null ? html`<span class="small muted">new</span>` : html`<span class="pill ${r.change > 0 ? "good" : r.change < 0 ? "bad" : "neutral"}">${r.change > 0 ? `+${r.change}` : r.change < 0 ? String(r.change) : "="}</span>`}</td>` : ""}<td>${r.rival ? html`${r.rival.name} <span class="small muted">${P(r.rival.pct)}</span>` : "—"}</td><td class="c">${String(r.citesOwn)}</td></tr>`);
  const never = card("Never first: where to push", p.neverFirst.length
    ? table(["Prompt", [`Engines naming ${own}`, "n"]], p.neverFirst.map((r) => html`<tr><td><b>${r.id}</b> ${clip(r.text, 70)}</td><td class="n">${r.naming} of ${r.asked}</td></tr>`), { split: true })
    : note(`${own} came first wherever it was named.`));
  const missing = card(`Missing on an engine, ${m.run.label.toLowerCase()}`, p.missing.length
    ? table(["Prompt", "Engine", "Named first instead"], p.missing.map((x) => html`<tr><td>${x.id}</td><td>${x.engine}</td><td>${x.firstInstead ? html`<b>${x.firstInstead}</b>` : html`<span class="muted">no tracked brand</span>`}</td></tr>`), { split: true })
    : note(`Every engine named ${own} on every prompt.`));
  const long = p.neverFirst.length > 8 || p.missing.length > 8;
  return {
    titles: html`<div class="titles"><span class="eyebrow">Prompts</span><h2>Where ${own} came, prompt by prompt, ${m.run.label.toLowerCase()}</h2></div>`,
    blocks: [
      blk(html`<div class="legend"><span><span class="pos p1">#1</span> named first</span><span><span class="pos p2">#2</span> second</span><span><span class="pos p3">#3</span> lower</span><span><span class="pos p3">card</span> only on a product card</span><span><span class="pos p0">✕</span> not named</span>${p.hasPrevious ? html`<span>Change = engines naming ${own} vs ${m.run.previous}</span>` : ""}</div>`),
      blk(table(head, rows, { split: true }), { split: true }),
      ...(long ? [blk(never, { split: true }), blk(missing, { split: true })] : [blk(html`<div class="grid2">${never}${missing}</div>`)]),
    ],
  };
}

function sourcesPage(m, p) {
  const run = m.run.label.toLowerCase();
  const own = m.own.name;
  const maxCited = Math.max(1, ...p.sites.map((s) => s.cited));
  return {
    titles: html`<div class="titles"><span class="eyebrow">Sources</span><h2>Which sites the engines cite, and where ${own} is absent</h2></div>`,
    blocks: [
      blk(card(`Citations by kind of site, ${run}`,
        p.citedTotal ? html`<div class="kindbar">${p.kinds.filter((k) => k.cited).map((k) => html`<i style="flex:${raw(String(k.cited))} 1 0;background:${raw(KIND_COLORS[k.label] || "#94a3b8")}"></i>`)}</div>` : "",
        table(["Kind of site", ["Read", "n"], ["Cited", "n"], ["Cited rate", "n"], ["Share of citations", "n"]], p.kinds.map((k) => html`<tr${raw(k.label === "Your site" ? ' class="you"' : "")}><td><span class="sw" style="background:${raw(KIND_COLORS[k.label] || "#94a3b8")}"></span>${k.label}</td><td class="n">${N(k.read)}</td><td class="n">${N(k.cited)}</td><td class="n">${P(k.citedRate)}</td><td class="n">${P(k.share)}</td></tr>`)),
        note(`Read = every page the engines opened (${N(p.read)}); cited = linked in the answer (${N(p.citedTotal)}).`))),
      blk(card(`Most-cited sites, ${run}`,
        p.sites.length ? table(["Site", "Kind", "Citations", ["Cited", "n"], ["Read", "n"], [`Cited pages naming ${own}`, "n"], ""], p.sites.map((s) => html`<tr${raw(s.kind === "Your site" ? ' class="you"' : "")}><td>${s.site}</td><td class="small muted">${s.kind}</td><td><div class="bar" style="width:30mm"><i style="width:${raw(String(Math.round((s.cited / maxCited) * 100)))}%;background:${raw(KIND_COLORS[s.kind] || "#94a3b8")}"></i></div></td><td class="n">${N(s.cited)}</td><td class="n">${N(s.read)}</td><td class="n">${N(s.namingYou)}</td><td>${s.rivalsOnly ? html`<span class="pill bad">Rivals only</span>` : ""}</td></tr>`), { split: true }) : note("No page was cited in this run."),
        p.sites.some((s) => s.rivalsOnly) ? note(`“Rivals only” = an independent site whose cited pages name a rival but never ${own}: the clearest places to win coverage.`) : ""), { split: true }),
      ...(p.pagesCited.length ? [blk(card(`Pages cited most, ${run}`, table(["Page", "Kind", ["Times cited", "n"], [`Names ${own}`, "c"]], p.pagesCited.map((x) => html`<tr${raw(x.kind === "Your site" ? ' class="you"' : "")}><td class="wrap"><b>${clip(x.title, 90)}</b><br><span class="url">${clip(String(x.url || x.site).replace(/^https?:\/\/(www\.)?/, ""), 90)}</span></td><td class="small muted">${x.kind}</td><td class="n">${N(x.cited)}</td><td class="c">${x.namesYou ? html`<span class="pill good">yes</span>` : html`<span class="pill neutral">no</span>`}</td></tr>`), { split: true })), { split: true })] : []),
    ],
  };
}

function productsPage(m, p) {
  const run = m.run.label.toLowerCase();
  const own = m.own.name;
  const blocks = [
    blk(html`${table(["Kind of answer", ["Answers", "n"], ["Searched web", "n"], [`${own} named`, "n"], [`Cites ${own} site`, "n"], [`${own} card share`, "n"]], p.kinds.map((k) => html`<tr><td><b>${k.label}</b></td><td class="n">${N(k.answers)}</td><td class="n">${P(k.searched)}</td><td class="n">${P(k.named)}</td><td class="n">${P(k.citesOwn)}</td><td class="n">${k.cardShare == null ? "—" : P(k.cardShare)}</td></tr>`))}${note("Shopping answers are won in the carousel, informational ones on the pages quoted, answers from memory over time.")}`),
  ];
  if (p.cardsTotal) {
    blocks.push(blk(html`<div class="grid2">${card(`Product card share, ${run}`, barList(p.cardShare.map((b) => ({ label: b.name, value: b.share, color: colorOf(b.name), bold: b.isOwn })), { width: 300, labelW: 64 }), note(`Of ${N(p.cardsTotal)} product cards shown.`))}${card(`Where ${own}’s cards send buyers`, p.destinations.length
      ? html`${barList(p.destinations.map((d) => ({ label: d.name, value: d.pct, color: d.own ? "#2a78d6" : "#94a3b8" })), { width: 300, labelW: 110, max: 100 })}${note(`First store in each ${own} card’s store list. Blue = ${own}’s own store; grey = someone else’s.`)}`
      : note(`No product card in these answers is ${own}’s.`))}</div>`));
    blocks.push(blk(card(`Products shown most, ${run}`, table(["Product", ["Cards", "n"], ["Avg card position", "n"], ["Avg price", "n"], "Card sends buyers to", ["Brand store offered", "c"]], p.products.map((x) => html`<tr${raw(x.isOwn ? ' class="you"' : "")}><td>${x.name}</td><td class="n">${N(x.cards)}</td><td class="n">${D1(x.avgPos)}</td><td class="n">${money(x.avgPrice)}</td><td>${x.dest || "—"}</td><td class="c">${P(x.brandStore)}</td></tr>`)))));
  } else {
    blocks.push(blk(card(`Product cards, ${run}`, note("No answer in this run showed product cards."))));
  }
  if (p.images.length) {
    blocks.push(blk(card(`Images in answers, ${run}`, table(["Who supplied the image", "Kind of site", ["Images", "n"], "Shows"], p.images.map((x) => html`<tr><td>${x.site}</td><td class="small muted">${x.kind}</td><td class="n">${N(x.images)}</td><td>${x.shows || html`<span class="muted">no tracked brand</span>`}</td></tr>`)), note(`${N(p.imagesTotal)} images in all. The engine’s own copy = served from the engine’s image proxy, so the original site isn’t named.`))));
  }
  return { titles: html`<div class="titles"><span class="eyebrow">Kinds of answer and products</span><h2>Different questions, different ways in</h2></div>`, blocks };
}

function searchesPage(m, p) {
  const run = m.run.label.toLowerCase();
  const own = m.own.name;
  const rows = p.perEngine.map((e) => e.hidden
    ? html`<tr><td><b>${e.engine}</b></td><td colspan="8" class="muted small">Searched the web but doesn’t show what it searched for.</td></tr>`
    : html`<tr><td><b>${e.engine}</b></td><td class="n">${D1(e.perAnswer)}</td><td class="n">${N(e.web)}</td><td class="n">${N(e.shopping)}</td><td class="n">${N(e.image)}</td><td class="n">${D1(e.avgWords)}</td><td class="n">${P(e.nameBrand)}</td><td class="n">${P(e.year)}</td><td class="n">${P(e.reddit)}</td></tr>`);
  const kinds = [["web", "#2a78d6", "Web", true], ["shopping", "#eb6834", "Shopping", true], ["image", "#1baf7a", "Image", true]];
  const shown = p.perEngine.filter((e) => !e.hidden && e.searches);
  return {
    titles: html`<div class="titles"><span class="eyebrow">Engine searches</span><h2>What the engines searched before answering</h2></div>`,
    blocks: [
      blk(table(["Engine", ["Searches per answer", "n"], ["Web", "n"], ["Shopping", "n"], ["Image", "n"], ["Avg words", "n"], ["Name a brand", "n"], ["Have a year", "n"], ["Ask Reddit", "n"]], rows)),
      blk(html`<div class="grid32">${card(`Most repeated searches, ${run}`, p.top.length
        ? table(["Search", ["Times", "n"], "Engines", ...(p.ownSite ? [[`Led to ${own} site`, "c"]] : [])], p.top.map((q) => html`<tr><td class="wrap">${q.text}</td><td class="n">${N(q.times)}</td><td class="small">${q.engines}</td>${p.ownSite ? html`<td class="c">${q.ledToOwn ? "✓" : ""}</td>` : ""}</tr>`), { split: true })
        : note("No engine showed its searches in this run."))}${card("Searches by kind", legend(kinds.map(([, c, t]) => [c, t])), shown.length ? stackedBars(shown.map((e) => ({ label: e.engine, parts: kinds.map(([key, color, , dark]) => ({ n: e[key], color, dark })) })), { width: 260, labelW: 62 }) : note("Nothing to chart."), note("Shopping searches query product feeds; that is where carousels come from."))}</div>`),
    ],
  };
}

function methodPage(m, p) {
  const own = m.own.name;
  return {
    titles: html`<div class="titles"><span class="eyebrow">Method</span><h2>How this report is measured</h2></div>`,
    blocks: [
      blk(card("How these numbers are measured", html`<div class="defs">${p.definitions.map(([t, d]) => html`<div><b>${t}</b>${d}</div>`)}</div>`)),
      blk(card("Runs in this campaign", table(["Run", "Date", ["Answers", "n"], ["Searched web", "n"], [`${own} visibility`, "n"], ["Share of voice", "n"], ["Avg position", "n"], ["Source visibility", "n"]], p.runs.map((r) => html`<tr${raw(r.current ? ' class="you"' : "")}><td><b>${r.label}</b></td><td>${r.date}</td><td class="n">${N(r.answers)}</td><td class="n">${P(r.searched)}</td><td class="n">${P(r.visibility)}</td><td class="n">${P(r.shareOfVoice)}</td><td class="n">${D1(r.avgPosition)}</td><td class="n">${P(r.sourceVisibility)}</td></tr>`), { split: true })), { split: true }),
      blk(html`<div class="card"><h3>The prompts <span class="note" style="font-weight:400">· every row behind this report is in the Excel workbook</span></h3>${table(["ID", "Prompt, as sent", "Tags", "Main kind"], p.prompts.map((x) => html`<tr><td><b>${x.id}</b></td><td class="wrap">${x.text}</td><td class="small muted">${x.tags}</td><td class="small nw">${x.kind}</td></tr>`), { split: true })}</div>`, { split: true }),
    ],
  };
}

/* ---------- the answer report's pages ---------- */
function answerPage1(m) {
  const own = m.own && m.own.name;
  const blocks = [
    blk(html`<div class="kpis" style="grid-template-columns:repeat(${raw(String(m.kpis.length))},1fr)">${m.kpis.map((t) => html`<div class="kpi"><span class="l">${t.label}</span><span class="v">${t.value}</span><span class="d flat">${t.sub}</span></div>`)}</div>`),
  ];
  if (m.you) blocks.push(blk(html`<div class="card tint"><h3>${m.you.name} in this answer</h3><div class="strip">${m.you.tiles.map((t) => html`<span class="chip${t.tone === "bad" ? " off" : ""}">${t.label} · ${t.value}</span>`)}</div></div>`));
  if (m.products.length) {
    blocks.push(blk(card("Product cards and where to buy", table(["#", "Product", ["Price", "n"], "Rating", "Card sends buyers to", "Image from", "Stores listed"], m.products.map((p) => html`<tr${raw(p.isYou ? ' class="you"' : "")}><td><b>${String(p.n)}</b></td><td><b>${p.name}</b>${p.brand ? html`<br><span class="small muted">${p.brand}</span>` : ""}</td><td class="n">${p.price || "—"}</td><td class="nw">${p.rating != null ? `★ ${p.rating}${p.reviews != null ? ` (${p.reviews})` : ""}` : "—"}</td><td>${p.sendsTo || "—"}</td><td>${p.imageFrom || "—"}</td><td class="small">${p.stores || "—"}</td></tr>`), { split: true }),
      note(`The store list is what ${m.engine} shows when someone opens the card.${m.productNote ? ` ${m.productNote}` : ""}`)), { split: true }));
  }
  const tone = (t) => (t === "good" ? "good" : t === "bad" ? "bad" : "warn");
  const backs = card("What backs each brand", m.brands.length
    ? table(["#", "Brand", ["Mentions", "n"], "Picked for", "Backing"], m.brands.map((b) => html`<tr${raw(b.isYou ? ' class="you"' : "")}><td><b>${b.position ? String(b.position) : "–"}</b></td><td>${b.name}${b.shownOnly ? html` <span class="small muted">card only</span>` : ""}</td><td class="n">${b.count ? `×${b.count}` : "—"}</td><td>${b.pickedFor || "—"}</td><td><span class="pill ${tone(b.backing.tone)}">${b.backing.label}</span></td></tr>`), { split: true })
    : note("The answer named no brand."), m.brandNote ? note(m.brandNote) : "");
  const icon = { added: ["good", "+"], up: ["good", "↑"], down: ["bad", "↓"], dropped: ["bad", "−"], same: ["neutral", "="], site: ["neutral", "↻"] };
  const since = m.changes
    ? html`<div class="card tint"><h3>Since you last asked (${m.changes.at})</h3><ul class="find">${m.changes.items.map((c) => html`<li><b class="k"><span class="pill ${(icon[c.kind] || icon.same)[0]}">${(icon[c.kind] || icon.same)[1]}</span></b><span>${c.text}</span></li>`)}</ul></div>`
    : card("Since you last asked", note(`This is the first time this prompt was captured on ${m.engine}, so there is nothing to compare with yet.`));
  blocks.push(blk(html`<div class="grid32">${backs}${since}</div>`));
  const long = String(m.prompt).length > 140;
  return {
    titles: html`<div class="titles" style="gap:1.6mm"><span class="eyebrow">Answer report · ${m.engine} · ${m.captured}</span><h1 style="font-size:${raw(long ? "14pt" : "22pt")};line-height:1.2">${m.prompt}</h1><div class="strip">${m.chips.map((c) => html`<span class="chip${c.kind === "type" ? " type" : c.off ? " off" : ""}">${c.text}</span>`)}</div></div>`,
    blocks,
  };
}

function answerPage2(m) {
  const words = String(m.answerText || "").split(/\s+/).length;
  const answerCard = m.answer.hasText
    ? html`<div class="card"><h3>The answer, as ${m.engine} showed it</h3><div class="answer" data-splitbox>${raw(m.answer.html)}</div>${note(`Brand names highlighted; grey chips are ${m.engine}’s own source links.${m.answer.truncated ? " The answer was long; the capture keeps its first 30,000 characters." : ""}`)}</div>`
    : card(`The answer, as ${m.engine} showed it`, note("The answer text wasn’t captured for this answer; the rest of the report comes from its searches, pages and cards."));
  const tech = card("Technical details", html`<table class="tight"><tbody>${m.technical.map(([k, v]) => html`<tr><td class="small muted nw">${k}</td><td class="wrap">${v}</td></tr>`)}</tbody></table>`);
  const searches = card("Searches it ran", m.searches.rows.length
    ? table(["Kind", "Search", "Looks for"], m.searches.rows.map((r) => html`<tr><td><span class="pill neutral">${r.lane}</span></td><td class="wrap">${r.text}${r.detail ? html`<br><span class="small muted">${r.detail}</span>` : ""}</td><td class="small muted">${r.tag}</td></tr>`), { split: true })
    : note(m.searches.unpublished ? `${m.engine} searched the web but doesn’t show what it searched for.` : "It answered without searching."));
  const opened = card("Every page it opened", m.opened.length
    ? table(["", "Page", "Site · kind", "Brands on the page"], m.opened.map((p) => html`<tr><td class="nw"><span class="pill ${p.cited ? "good" : "neutral"}">${p.cited ? "Cited" : "Read only"}</span></td><td class="wrap">${clip(p.title, 110)}${p.url ? html`<br><span class="small muted url">${clip(p.url, 120)}</span>` : ""}</td><td class="small muted">${p.domain} · ${p.kind}</td><td class="small">${p.brands.join(", ") || "—"}</td></tr>`), { split: true })
    : note("It opened no pages."), note(`Read only = ${m.engine} opened the page while searching but did not link it.${m.silentRead.length && m.own ? ` ${clip(m.silentRead.join(", "), 120)} ${m.silentRead.length === 1 ? "mentions" : "mention"} ${m.own.name} yet ${m.silentRead.length === 1 ? "was" : "were"} not cited.` : ""}`));
  // The engine's ad sat with the answer, so it follows the answer here.
  const ads = (m.ads || []).length ? [blk(adsCard(m))] : [];
  const short = !m.answer.hasText || words < 320;
  return {
    titles: null,
    blocks: short
      ? [blk(html`<div class="grid32" style="align-items:start">${answerCard}<div style="display:flex;flex-direction:column;gap:4mm">${tech}${searches}</div></div>`), ...ads, blk(opened, { split: true })]
      : [blk(answerCard, { split: true }), ...ads, blk(html`<div class="grid2" style="align-items:start">${tech}${searches}</div>`), blk(opened, { split: true })],
  };
}

function adsCard(m) {
  const rows = m.ads.map((a) => html`<tr><td class="nw"><b>${a.advertiser}</b><br><span class="pill warn">${a.label}</span></td><td class="wrap">${a.preamble ? html`<span class="small muted">${a.preamble}</span><br>` : ""}${a.title ? html`<b>${a.title}</b>` : ""}${a.body ? html`<br>${a.body}` : ""}</td><td class="wrap small">${a.domain || "—"}${a.url ? html`<br><span class="muted url">${clip(a.url, 90)}</span>` : ""}</td><td class="small">${[a.placement, a.namedInAnswer ? "named in the answer too" : "not named in the answer", a.siteCited ? `its site cited ${a.siteCited}×` : a.siteRead ? `its site read ${a.siteRead}×, not cited` : ""].filter(Boolean).join(" · ")}</td></tr>`);
  return card(`Ad shown with the answer`, table(["Advertiser", "What it said", "Links to", "Where · ties to the answer"], rows),
    note(`${m.engine} placed this paid card with its answer. It isn’t part of the answer: the ad alone doesn’t count as the answer naming its advertiser.`));
}

/* Citations become site chips and brand names are marked, as in Analyze. */
function decorateAnswer(root, m) {
  const fn = new Map(m.answer.footnotes.map((f) => [String(f.n), f]));
  root.querySelectorAll(".answer sup.fn").forEach((sup) => {
    const n = (sup.textContent.match(/\d+/) || [""])[0];
    const f = fn.get(n);
    const chip = document.createElement("span");
    chip.className = "cite";
    chip.textContent = f ? f.domain.replace(/\.(com|in|org|net|co\.in|co\.uk|io)$/, "") : n;
    sup.replaceWith(chip);
  });
  const names = [...new Set(m.brandNames.filter((x) => x && x.length > 1))].sort((a, b) => b.length - a.length);
  if (!names.length) return;
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(reEsc).join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  root.querySelectorAll(".answer").forEach((box) => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest("mark, .cite") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const t = node.nodeValue;
      re.lastIndex = 0;
      if (!re.test(t)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, mm;
      while ((mm = re.exec(t))) {
        const start = mm.index + mm[1].length;
        frag.append(document.createTextNode(t.slice(last, start)));
        const mark = document.createElement("mark");
        mark.textContent = mm[2];
        frag.append(mark);
        last = start + mm[2].length;
      }
      frag.append(document.createTextNode(t.slice(last)));
      node.replaceWith(frag);
    }
  });
}

const BUILDERS = { summary: summaryPage, brands: brandsPage, prompts: promptsPage, sources: sourcesPage, products: productsPage, searches: searchesPage, method: methodPage };

/* ---------- pages ---------- */
function pageShell(header, foot, titles) {
  const page = document.createElement("section");
  page.className = "page";
  page.innerHTML = `${header.s}${titles ? titles.s : ""}${foot.s}`;
  return page;
}
const fits = (page) => page.scrollHeight <= page.clientHeight + 1;
// What a long block can be split by: a table's rows, or an answer's paragraphs.
const SPLIT_BOX = "table[data-split] tbody, [data-splitbox]";

/** Move what doesn't fit onto continuation pages, recursively. */
function paginate(page, header, foot, contTitle) {
  let cont = null;
  const contPage = () => {
    if (!cont) {
      cont = pageShell(header, foot, contTitle);
      page.after(cont);
    }
    return cont;
  };
  // Insert into the continuation right after its titles (before blocks
  // moved earlier, which came later on the page).
  const insertTop = (node) => {
    const c = contPage();
    const anchor = c.querySelector(".blk");
    if (anchor) anchor.before(node); else c.querySelector(".foot").before(node);
  };
  let guard = 2000;
  while (!fits(page) && guard-- > 0) {
    const blocks = [...page.querySelectorAll(":scope > .blk")];
    const last = blocks[blocks.length - 1];
    if (!last) break;
    const box = last.hasAttribute("data-splittable") ? last.querySelector(SPLIT_BOX) : null;
    if (box && box.children.length > 2) {
      let copy = cont && cont.querySelector(`:scope > .blk[data-blk="${last.dataset.blk}"]`);
      if (!copy) {
        copy = last.cloneNode(true);
        copy.querySelector(SPLIT_BOX).textContent = "";
        // The block's notes stay with its first part.
        copy.querySelectorAll(".note").forEach((x) => x.remove());
        const h = copy.querySelector("h3");
        if (h && !h.querySelector(".cont")) h.insertAdjacentHTML("beforeend", ' <span class="cont">(continued)</span>');
        insertTop(copy);
      }
      copy.querySelector(SPLIT_BOX).prepend(box.lastElementChild);
    } else if (blocks.length > 1) {
      // Moving the rest of a block that already continues on the next page:
      // take its moved rows back first, so it stays one block there.
      const copy = cont && cont.querySelector(`:scope > .blk[data-blk="${last.dataset.blk}"]`);
      if (copy) {
        const from = copy.querySelector(SPLIT_BOX), to = last.querySelector(SPLIT_BOX);
        while (from && to && from.firstElementChild) to.append(from.firstElementChild);
        copy.remove();
      }
      insertTop(last);
    } else break; // one block taller than a page and nothing to split: leave it
  }
  if (cont) paginate(cont, header, foot, contTitle);
}

const stamp = (t) => `${dayLabel(t)}, ${new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

function render(model, root) {
  root.textContent = "";
  const answer = model.kind === "answer";
  if (!answer) setBrandColors(model);
  const generated = stamp(model.generatedAt);
  const foot = answer
    ? html`<div class="foot"><span>CitoSkeleton · answer report</span><span>Generated ${generated}</span></div>`
    : html`<div class="foot"><span>CitoSkeleton · ${model.campaign} campaign report</span><span>Generated ${generated}</span></div>`;
  const header = answer
    ? html`<div class="run"><span class="mark">C</span><b>CitoSkeleton</b><span>· Answer report · ${clip(model.prompt, 80)}</span><span class="pg"></span></div>`
    : html`<div class="run"><span class="mark">C</span><b>CitoSkeleton</b><span>· ${model.campaign} · Campaign report · ${model.run.label}, ${model.run.date}</span><span class="pg"></span></div>`;
  // An answer's report is one flow: whatever doesn't fit on the first page
  // shares the next with the answer itself, rather than a page of its own.
  const sections = answer ? [{ key: "answer", title: "Answer report" }] : model.pages;
  for (const p of sections) {
    const built = answer
      ? (() => { const a = answerPage1(model), b = answerPage2(model); return { titles: a.titles, blocks: [...a.blocks, ...b.blocks] }; })()
      : BUILDERS[p.key](model, p);
    const page = pageShell(header, foot, built.titles);
    page.dataset.key = p.key;
    const footEl = page.querySelector(".foot");
    footEl.insertAdjacentHTML("beforebegin", built.blocks.map((b) => b.s).join(""));
    root.append(page);
    if (answer) decorateAnswer(page, model);
    const contTitle = p.key === "summary" || answer ? null : html`<div class="titles"><span class="eyebrow">${p.title} <span class="cont">(continued)</span></span></div>`;
    paginate(page, header, foot, contTitle);
  }
  const pages = [...root.querySelectorAll(".page")];
  pages.forEach((pg, i) => { pg.querySelector(".pg").textContent = `${i + 1} / ${pages.length}`; });
  return pages.length;
}

/* ---------- start ---------- */
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message })));
const slug = (s) => String(s || "campaign").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "campaign";

async function start() {
  const q = new URLSearchParams(location.search);
  const root = document.getElementById("pages");
  const fail = (text) => { root.innerHTML = html`<div class="state"><h1>No report</h1><p>${text}</p></div>`.s; };
  let model;
  if (q.get("kind") === "answer") {
    const r = await send({ type: "answer-report-data", captureId: q.get("captureId") });
    if (!r || !r.ok) return fail((r && r.error) || "That answer couldn’t be found.");
    model = { ...answerReport(r.record, { previous: r.previous, profiles: r.profiles }), kind: "answer", answerText: r.record.answerText || "" };
    model.captured = stamp(model.capturedAt);
    // The file name Chrome suggests in "Save as PDF" comes from the title.
    document.title = `citoskeleton-answer-${slug(model.engine)}-${slug(String(model.prompt).split(/\s+/).slice(0, 6).join(" "))}`;
  } else if (q.get("kind") === "campaign") {
    const list = (k) => (q.get(k) ? q.get(k).split(",").filter(Boolean) : undefined);
    const r = await send({ type: "campaign-report", profileId: q.get("profileId"), runId: q.get("runId") || undefined, sections: list("sections"), engines: list("engines") });
    if (!r || !r.ok) return fail((r && r.error) || "The report couldn’t be built.");
    model = r.report;
    document.title = `citoskeleton-${slug(model.campaign)}-run${model.run.no}`;
  } else return fail("This page opens from a campaign’s Export dialog, or from Analyze.");
  await document.fonts.ready;
  const count = render(model, root);
  document.getElementById("tbTitle").textContent = model.kind === "answer" ? `${model.engine} answer` : `${model.campaign} · ${model.run.label}`;
  document.getElementById("tbPages").textContent = `${count} A4 page${count === 1 ? "" : "s"}`;
  document.getElementById("toolbar").hidden = false;
  document.getElementById("printBtn").onclick = () => window.print();
  document.body.dataset.ready = "1";
  if (q.get("print") === "1") setTimeout(() => window.print(), 300);
}
start();
