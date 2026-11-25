/*
 * campaignView.js — the campaign board's sections, drawn from
 * src/lib/campaignView.js (0.64.0, built from the canvas the owner approved).
 *
 * Nine sections, in the order the owner asked for: the headline numbers
 * first, then each engine, then the detail. Logos stand in for names where a
 * logo reads faster (engines, brands, sites), and numbers always carry what
 * they are out of. panel.js owns the page (header, filters, run history);
 * this draws the board inside it and keeps each section's own state, so a
 * filter in one section redraws only that section.
 */
import { brandSlug, siteSlug, markSvg } from "../src/lib/logos.js";
import { fmt, tr } from "./i18n.js";
import { campaignAdvice, margin, sureness } from "../src/lib/onboarding.js";

let D = null;           // { el, engineIcon, openCapture, openDomain, openFullCompare, runHistory }
let V = null;           // the view (src/lib/campaignView.js)
// Each section's own state. It outlives a redraw of the board, so coming
// back from an answer opened in Analyze finds every section as it was left.
const FRESH = () => ({ section: "cv-overview", brandEng: "all", brandSort: "sov", rivals: [], cmpEng: null, cmpMetric: "sov", pf: "all", cq: "", ce: "all", ck: "All", ct: "All", cboth: false, cpage: 0, copen: -1, prf: "all", prt: "All", propen: -1, pg: {} });
const S = FRESH();
export function resetCampaignViewState() { Object.assign(S, FRESH()); }
export function campaignViewSection() { return S.section; }

const ENG = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok", aimode: "AI Mode" };
const pct = (x) => (x == null ? "—" : `${x >= 10 || x === 0 ? Math.round(x) : x.toFixed(1)}%`);
const num = (x) => (x == null ? "—" : String(x));
const ord = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const h = (...a) => D.el(...a);

/* ---------- logos ---------- */

function engineMark(id, size = "") {
  const i = D.engineIcon(id);
  i.classList.add("cv-lg", "cv-eng");
  if (size) i.classList.add(size);
  i.title = ENG[id] || id;
  return i;
}
function brandMark(name, size = "") {
  return h("span", { className: `cv-lg ${size}`, title: name, innerHTML: markSvg({ slug: brandSlug(name), text: name }, 32) });
}
// Site icons come from Chrome's favicon cache ("favicon" permission), so
// nothing leaves the browser. Chrome answers every request, with a grey globe
// for a site it has never seen; that globe is told apart by comparing it with
// the icon of an address that can't exist, and a letter badge shows instead.
let globeSig = null;
const iconSig = (img) => { try { const c = document.createElement("canvas"); c.width = c.height = 16; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 16, 16); return c.toDataURL(); } catch (_) { return null; } };
const faviconUrl = (domain) => {
  try {
    if (!(globalThis.chrome && chrome.runtime && chrome.runtime.getManifest && (chrome.runtime.getManifest().permissions || []).includes("favicon"))) return null;
    const u = new URL(chrome.runtime.getURL("/_favicon/"));
    u.searchParams.set("pageUrl", `https://${domain}/`);
    u.searchParams.set("size", "32");
    return u.toString();
  } catch (_) { return null; }
};
function globe() {
  if (!globeSig) globeSig = new Promise((resolve) => {
    const u = faviconUrl("cito-none.invalid");
    if (!u) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(iconSig(img));
    img.onerror = () => resolve(null);
    img.src = u;
  });
  return globeSig;
}
function siteMark(domain, size = "") {
  const slug = siteSlug(domain);
  const box = h("span", { className: `cv-lg ${size}`, title: domain, innerHTML: markSvg({ slug, text: domain }, 32) });
  if (slug) return box;
  const u = faviconUrl(domain);
  if (!u) return box;
  const img = h("img", { alt: "", width: 32, height: 32, decoding: "async" });
  img.onload = async () => { const g = await globe(); const s = iconSig(img); if (s && s !== g) { box.classList.add("fav"); box.replaceChildren(img); } };
  img.src = u;
  return box;
}

/* ---------- small parts ---------- */

function section(id, title, sub, ...kids) {
  const head = h("div", { className: "cv-head" }, h("h3", { className: "cv-h", id: `${id}-h` }, title));
  if (sub) head.append(typeof sub === "string" ? h("span", { className: "cv-sub" }, sub) : sub);
  return h("section", { className: "cv-sec", id, "aria-labelledby": `${id}-h` }, head, ...kids);
}
const card = (cls, ...kids) => h("div", { className: `cv-card ${cls || ""}` }, ...kids);
const bar = (w, color, cls = "") => h("span", { className: `cv-track ${cls}`, "aria-hidden": "true" }, h("span", { style: `width:${Math.max(0, Math.min(100, w || 0))}%;${color ? `background:${color}` : ""}` }));
function seg(label, items, cur, onPick) {
  const g = h("div", { className: "cv-seg", role: "group", "aria-label": label });
  items.forEach(([id, text, icon, count]) => {
    const b = h("button", { type: "button", className: id === cur ? "on" : "", "aria-pressed": id === cur ? "true" : "false" });
    if (icon) b.append(icon);
    b.append(typeof text === "string" ? tr(text) : text);
    if (count != null) b.append(h("span", { className: "cv-cnt" }, String(count)));
    b.onclick = () => onPick(id);
    g.append(b);
  });
  return g;
}
function chips(label, items, cur, onPick) {
  const g = h("div", { className: "cv-chips", role: "group", "aria-label": label });
  items.forEach(([id, text, count, icon]) => {
    const b = h("button", { type: "button", className: `cv-chip${id === cur ? " on" : ""}`, "aria-pressed": id === cur ? "true" : "false" });
    if (icon) b.append(icon);
    b.append(typeof text === "string" ? tr(text) : text);
    if (count != null) b.append(h("span", { className: "cv-cnt" }, String(count)));
    b.onclick = () => onPick(id);
    g.append(b);
  });
  return g;
}
function mixBar(parts) {
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  const b = h("div", { className: "cv-mix", "aria-hidden": "true" });
  parts.forEach((p) => p.n && b.append(h("i", { style: `width:${(p.n * 100 / total).toFixed(2)}%;background:${p.c}` })));
  const legend = h("div", { className: "cv-legend" });
  parts.forEach((p) => legend.append(h("span", {}, h("i", { style: `background:${p.c}` }), p.label, h("b", {}, String(p.n)), h("span", { className: "cv-muted" }, `${Math.round(p.n * 100 / total)}%`))));
  return [b, legend];
}
const RAMP = ["var(--cv-c1)", "var(--cv-c2)", "var(--cv-c3)", "var(--cv-c4)", "var(--cv-c5)", "var(--cv-c6)", "var(--cv-c7)"];
const KIND_COLOR = { "Your site": "var(--you)", "Review sites": "var(--kind-review)", "Retailers": "var(--kind-retail)", "Rival brand sites": "var(--kind-rival)", "Forums & social": "var(--kind-forum)", "Public & reference": "var(--kind-public)", "Other": "var(--kind-other)" };
const empty = (text, icon) => h("div", { className: "cv-empty" }, icon || "", h("span", {}, text));
const tile = (label, value, sub, extra) => h("div", { className: "cv-tile" }, h("span", { className: "cv-tile-l" }, label), h("span", { className: "cv-tile-v" }, value), sub ? h("span", { className: "cv-tile-s" }, sub) : "", extra || "");
function replace(id, fn) { const old = document.getElementById(id); if (old) old.replaceWith(fn()); }

// A page of a long list (0.67.0, asked: "please don't have infinite scroll
// layout"): `per` rows at a time with ‹ › and where you are.
function paged(key, list, per, redo) {
  const pages = Math.max(1, Math.ceil(list.length / per));
  const at = Math.min(S.pg[key] || 0, pages - 1);
  S.pg[key] = at;
  const rows = list.slice(at * per, at * per + per);
  if (list.length <= per) return { rows, pager: "" };
  const prev = h("button", { type: "button", className: "cv-pg", "aria-label": "Previous page", disabled: at === 0 }, "‹");
  const next = h("button", { type: "button", className: "cv-pg", "aria-label": "Next page", disabled: at >= pages - 1 }, "›");
  prev.onclick = () => { S.pg[key] = at - 1; redo(); };
  next.onclick = () => { S.pg[key] = at + 1; redo(); };
  return { rows, pager: h("div", { className: "cv-pager", "data-pager": key }, h("span", { className: "cv-muted" }, `${at * per + 1}–${Math.min(list.length, at * per + per)} of ${list.length}`), prev, next) };
}

// Every prompt on the board opens its answer in Analyze (0.67.0). The answer
// opened is the one in view: the engine's when a cell is clicked, else the
// first engine that answered.
function answerFor(text) {
  const p = V.prompts.find((x) => x.text === text || x.id === text);
  const c = p && p.cells.find((x) => x && x.answered && x.captureId);
  return c ? c.captureId : null;
}
function promptLink(text, captureId, cls = "") {
  const id = captureId || answerFor(text);
  if (!id) return h("span", { className: `cv-ell ${cls}` }, text);
  const b = h("button", { type: "button", className: `cv-plink cv-ell ${cls}`, title: "Open this answer in Analyze" }, text);
  b.onclick = (ev) => { ev.stopPropagation(); D.openCapture(id); };
  return b;
}
const youBadge = () => h("span", { className: "cv-badge you" }, V.own === D.realOwn || !D.realOwn ? "You" : "Viewing");
const ownSiteLabel = () => (V.own === D.realOwn || !D.realOwn ? "Your own site" : fmt("{brand}'s own site", { brand: V.own }));

/* ---------- 1. Overview ---------- */

// The change since the run before, from campaignBoard()'s KPI tiles
// (panel.js passes them in); none on a campaign's first run.
// Glossary keys (src/lib/glossary.js): hovering a label explains it.
const TERM = { sov: "shareOfVoice", vis: "visibility", pos: "avgPosition", mentions: "mentions" };
const DELTA_LABEL = { sov: "Share of voice", vis: "Visibility", pos: "Avg position", mentions: "Mentions" };
function delta(id) {
  const d = D.deltas && D.deltas[DELTA_LABEL[id]];
  if (!d) return "";
  return h("div", { className: `k-delta cv-delta tone-${d.tone > 0 ? "up" : d.tone < 0 ? "down" : "flat"}` }, d.text);
}

function overviewSec() {
  const o = V.overview;
  const kpis = h("div", { className: "cv-kpis" });
  for (const k of o.kpis) {
    const max = Math.max(1, ...k.split.map((s) => (k.id === "pos" ? 0 : s.value || 0)));
    const rows = h("div", { className: "cv-split" });
    k.split.forEach((s) => {
      const w = s.value == null ? 0 : k.id === "pos" ? Math.max(8, 100 - (s.value - 1) * 25) : k.id === "responses" ? (s.of ? s.value * 100 / s.of : 0) : s.value * 100 / max;
      const txt = s.value == null ? "no answers" : k.id === "responses" ? `${s.value}/${s.of}` : k.unit === "%" ? pct(s.value) : num(s.value);
      rows.append(h("span", { className: "cv-split-row" }, engineMark(s.engine, "s"), bar(w, `var(--eng-${s.engine})`), h("span", { className: `cv-num${s.value == null ? " cv-muted" : ""}` }, txt)));
    });
    // 1.0.6: each engine's figures are the By engine table below, so the
    // cards show the headline only ("15 / 15" no longer has "of 15" too).
    void rows;
    kpis.append(card("cv-kpi",
      h("div", { className: "cv-kpi-top" }, h("span", { className: "cv-kpi-l", ...(TERM[k.id] ? { "data-term": TERM[k.id] } : {}) }, k.label), k.rank ? h("span", { className: "cv-badge", title: fmt("{place} of {n} brands", { place: tr(ord(k.rank)), n: k.of }) }, `${ord(k.rank)} of ${k.of}`) : ""),
      h("div", { className: "cv-kpi-v" }, k.value == null ? "—" : String(k.value), h("span", { className: "cv-kpi-u" }, k.id === "responses" ? ` / ${k.of}` : k.unit)),
      delta(k.id)));
  }
  // How sure the headline numbers are (1.0.0, lib/onboarding.js): AI answers
  // vary from run to run, so a share is shown with the answers it rests on
  // and how far it could move by chance.
  const visK = o.kpis.find((k) => k.id === "vis");
  const sure = sureness(o.answered);
  const m = visK && visK.value != null ? margin(visK.value, o.answered) : null;
  const sureLine = m == null ? null : h("p", { className: `cv-sure s-${sure}` },
    fmt("Based on {n} answers: a share could be about {m} points either way by chance.", { n: o.answered, m: Math.round(m) }, "Based on {n} answer: a share could be about {m} points either way by chance."),
    sure === "few" ? h("b", {}, ` ${tr("Too few to trust small changes.")}`) : "");
  // What to do next, from the campaign's own numbers.
  const rival = (V.brands.all || []).filter((r) => !r.isOwn && r.vis != null).sort((a, b) => b.vis - a.vis)[0] || null;
  const advice = campaignAdvice({
    brand: V.own, answered: o.answered, ownVis: visK ? visK.value : null,
    rival: rival ? { name: rival.name, vis: rival.vis } : null,
    ownSiteCitations: V.citations ? V.citations.ownSite : null,
    gaps: V.signals && V.signals.gaps ? V.signals.gaps.length : null,
  });
  const adviceCard = advice.length ? card("cv-advice", h("h4", { className: "cv-h4" }, "What to do next"),
    h("ul", { className: "cv-advice-list" }, ...advice.map((a) => h("li", {}, h("span", {}, fmt(a.template, a.vars, a.one || null)),
      a.go && SECTION_FN[a.go] ? h("button", { type: "button", className: "cv-link", onclick: () => goSection(a.go) }, "Show me ›") : "")))) : null;
  const notes = h("div", { className: "cv-notes" });
  o.engines.filter((e) => e.sent && e.answered < e.sent).forEach((e) => notes.append(h("div", { className: "cv-note" }, engineMark(e.id, "s"),
    h("span", {}, h("b", {}, `${e.label}: ${e.answered} of ${e.sent} answered. `), e.limited ? "It hit its usage limit; the numbers below leave it out." : "Prompts without an answer are left out of the numbers."))));
  const t = h("div", { className: "cv-table cv-eng-table", role: "table", "aria-label": "By engine" });
  t.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Engine", "Answered", "Share of voice", "Visibility", "Position", "Mentions", "Searches", "Pages read · cited", "Named first most"].map((x) => h("span", { role: "columnheader" }, x))));
  o.engines.forEach((e) => {
    const ok = !!e.own;
    t.append(h("div", { className: "cv-tr", role: "row" },
      h("span", { role: "cell", className: "cv-who" }, engineMark(e.id), e.label),
      h("span", { role: "cell", className: "cv-num" }, `${e.answered}/${e.sent}`),
      ...(ok ? [pct(e.own.sov), pct(e.own.vis), num(e.own.pos), num(e.own.mentions), e.id === "gemini" && !e.searches ? "not published" : `${e.searches} · ${(e.searches / e.answered).toFixed(1)}/answer`, `${e.read} · ${e.cited}`].map((x) => h("span", { role: "cell", className: "cv-num" }, x))
        : [h("span", { role: "cell", className: "cv-span cv-muted" }, e.limited ? "No answers: usage limit reached" : "No answers")]),
      ok ? h("span", { role: "cell", className: "cv-who" }, e.firstMost ? brandMark(e.firstMost.name, "s") : "", e.firstMost ? `${e.firstMost.name} · ${e.firstMost.n}` : "—") : ""));
  });
  const mult = h("div", { className: "cv-mult" });
  const lists = [["all", "All engines", V.brands.all], ...V.engines.map((e) => [e, ENG[e], V.brands.byEngine[e]])];
  lists.forEach(([id, label, rows]) => {
    const c = card("cv-mini", h("div", { className: "cv-who cv-mini-h" }, id === "all" ? h("span", { className: "cv-lgroup" }, ...V.engines.map((e) => engineMark(e, "s"))) : engineMark(id), label));
    if (!rows) { c.append(empty("No answers")); mult.append(c); return; }
    const max = Math.max(1, ...rows.map((r) => r.sov));
    rows.forEach((r) => c.append(h("div", { className: `cv-bl${r.isOwn ? " you" : ""}` }, brandMark(r.name, "s"), h("span", { className: "cv-ell" }, r.name), bar(r.sov * 100 / max, r.isOwn ? "var(--you)" : "var(--cv-dim)"), h("span", { className: "cv-num" }, pct(r.sov)))));
    mult.append(c);
  });
  return section("cv-overview", fmt("{brand} in this run", { brand: V.own }), `${o.answered} answer${o.answered === 1 ? "" : "s"} from ${o.sent} prompt${o.sent === 1 ? "" : "s"} sent`, notes, kpis, sureLine, adviceCard,
    card("", h("h4", { className: "cv-h4" }, "By engine"), h("div", { className: "cv-scroll" }, t)),
    h("h4", { className: "cv-h4" }, "Share of voice, engine by engine"), mult);
}

/* ---------- 2. Brands ---------- */

function brandsSec() {
  const list = (S.brandEng === "all" ? V.brands.all : V.brands.byEngine[S.brandEng]) || null;
  const sorters = { sov: (a, b) => b.sov - a.sov, vis: (a, b) => b.vis - a.vis, pos: (a, b) => (a.pos ?? 99) - (b.pos ?? 99), mentions: (a, b) => b.mentions - a.mentions };
  const rows = list ? [...list].sort(sorters[S.brandSort]) : [];
  const answers = S.brandEng === "all" ? V.overview.answered : (V.overview.engines.find((e) => e.id === S.brandEng) || {}).answered || 0;
  const tools = h("div", { className: "cv-tools" },
    seg("Engine", [["all", "All", null], ...V.engines.map((e) => [e, ENG[e], engineMark(e, "s")])], S.brandEng, (id) => { S.brandEng = id; replace("cv-brands", brandsSec); }),
    seg("Sort by", [["sov", "Share of voice"], ["vis", "Visibility"], ["pos", "Position"], ["mentions", "Mentions"]], S.brandSort, (id) => { S.brandSort = id; replace("cv-brands", brandsSec); }));
  const t = h("div", { className: "cv-table cv-lead", role: "table", "aria-label": "Brand leaderboard" });
  t.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["#", "Brand", "Share of voice", "Visibility", "Position", "Mentions", "Named first"].map((x) => h("span", { role: "columnheader" }, x))));
  const max = Math.max(1, ...rows.map((r) => r.sov));
  const pg = paged("brands", rows, 15, () => replace("cv-brands", brandsSec));
  const start = (S.pg.brands || 0) * 15;
  pg.rows.forEach((r, j) => {
    const i = start + j;
    const name = h("button", { type: "button", className: "cv-who cv-link cb-brand-btn", title: r.isOwn ? "" : fmt("Compare {brand} with {own}", { brand: r.name, own: V.own }) }, brandMark(r.name), r.name);
    if (!r.isOwn) name.onclick = () => { if (!S.rivals.includes(r.name)) S.rivals = [...S.rivals, r.name].slice(-MAX_RIVALS); goSection("cv-compare"); };
    // A brand found in the answers rather than typed in setup says so, and
    // can be left out (geo-brand-exclude), as on the board before 0.64.0.
    const who = h("span", { role: "cell", className: "cv-who" }, name, r.isOwn ? youBadge() : "",
      r.auto ? h("span", { className: "cv-badge auto-tag", "data-term": "autoCompetitor" }, "found in answers") : "");
    // One click makes it a competitor (0.77.0), locked campaign or not.
    if (r.auto && D.addCompetitor) {
      const add = h("button", { type: "button", className: "row-add", title: fmt("Add {brand} as a competitor", { brand: r.name }), "aria-label": fmt("Add {brand} as a competitor", { brand: r.name }) }, "+ Add");
      add.onclick = () => D.addCompetitor(r.name, add);
      who.append(add);
    }
    if (r.auto && D.excludeBrand) {
      const x = h("button", { type: "button", className: "row-x", title: fmt("Leave out {brand}", { brand: r.name }), "aria-label": fmt("Leave out {brand}", { brand: r.name }) }, "×");
      x.onclick = () => D.excludeBrand(r.name, x);
      who.append(x);
    }
    t.append(h("div", { className: `cv-tr${r.isOwn ? " you own-brand" : ""}`, role: "row", "data-brand": r.name },
      h("span", { role: "cell", className: "cv-num cv-muted" }, String(i + 1)), who,
      h("span", { role: "cell", className: "cv-barcell" }, bar(r.sov * 100 / max, r.isOwn ? "var(--you)" : "var(--cv-dim)"), h("span", { className: "cv-num" }, pct(r.sov))),
      ...[pct(r.vis), num(r.pos), num(r.mentions), `${r.firsts} of ${answers}`].map((x) => h("span", { role: "cell", className: "cv-num" }, x))));
  });
  const grid = h("div", { className: "cv-table cv-heat", role: "table", "aria-label": "Visibility, brand by engine", style: `--cols:1.3fr repeat(${V.engines.length + 1}, 1fr)` });
  grid.append(h("div", { className: "cv-tr cv-th", role: "row" }, h("span", { role: "columnheader" }, "Brand"), h("span", { role: "columnheader" }, "All"), ...V.engines.map((e) => h("span", { role: "columnheader", className: "cv-who" }, engineMark(e, "s"), ENG[e]))));
  const gpg = paged("grid", V.brands.grid, 15, () => replace("cv-brands", brandsSec));
  gpg.rows.forEach((r) => grid.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, brandMark(r.name, "s"), r.name),
    ...[r.all, ...r.cells].map((x) => h("span", { role: "cell", className: `cv-cell${x == null ? " na" : ""}`, style: x == null ? "" : `--a:${(0.08 + x / 100 * 0.72).toFixed(2)}` }, x == null ? "—" : pct(x))))));
  // Brands the answers name that aren't on the campaign's list (0.77.0): one
  // click adds one. Here, beside the leaderboard, so the board's first screen
  // stays the numbers.
  let sugg = "";
  if ((D.suggested || []).length && D.addCompetitor) {
    sugg = h("div", { className: "cv-sugg", id: "cbSuggest", role: "group", "aria-label": "Also named in the answers" },
      h("span", { className: "cv-muted", "data-term": "autoCompetitor" }, "Also named in the answers, not on your list:"));
    D.suggested.forEach((n) => {
      const add = h("button", { type: "button", className: "tag-add cb-sugg", "data-name": n, title: `Add ${n} as a competitor` }, `+ ${n}`);
      add.onclick = () => D.addCompetitor(n, add);
      sugg.append(add);
    });
    if (D.suggested.length > 1 && D.addAll) {
      const all = h("button", { type: "button", className: "linkbtn", id: "cbAddAll" }, `Add all ${D.suggested.length}`);
      all.onclick = () => D.addAll(all);
      sugg.append(all);
    }
  }
  return section("cv-brands", "Brands", `${rows.length} brands over ${answers} answers`, tools, sugg,
    list ? card("", h("div", { className: "cv-scroll" }, t), pg.pager) : empty("No answers from this engine."),
    card("", h("h4", { className: "cv-h4" }, "Visibility, brand by engine"), h("div", { className: "cv-scroll" }, grid), gpg.pager));
}

/* ---------- 3. Compare: you and one or more brands ---------- */

// Asked for (0.67.0): "the option to compare with 1 or more brands", laid out
// cleanly. Up to four rivals beside the brand in view; each table has one
// column per brand, and the best figure in a row is marked.
const MAX_RIVALS = 4;
const CMP_MEASURES = [
  ["sov", "Share of voice", pct], ["vis", "Visibility", pct], ["pos", "Average position", num, true], ["mentions", "Mentions", num],
  ["firsts", "Named first", num], ["cards", "Product cards", num], ["firstCards", "First product card", num], ["inQueries", "In the engines’ searches", num],
];
function bestOf(vals, low) {
  const xs = vals.filter((v) => v != null);
  if (!xs.length) return null;
  return low ? Math.min(...xs) : Math.max(...xs);
}
function compareSec() {
  if (!V.rivals.length) return section("cv-compare", "Compare brands", "", empty("No other brands in these answers yet."));
  S.rivals = S.rivals.filter((n) => V.compare[n]);
  if (!S.rivals.length) S.rivals = [V.rivals[0]];
  if (!S.cmpEng || !V.engines.includes(S.cmpEng)) S.cmpEng = V.engines[0];
  const redo = () => replace("cv-compare", compareSec);
  const C = S.rivals.map((n) => V.compare[n]);
  const names = [V.own, ...S.rivals];
  const sideOf = (i, key) => (i === 0 ? C[0].me[key] : C[i - 1].them[key]);

  const pick = h("div", { className: "cv-chips", role: "group", "aria-label": "Brands to compare" });
  V.rivals.forEach((n) => {
    const on = S.rivals.includes(n);
    const full = !on && S.rivals.length >= MAX_RIVALS;
    const b = h("button", { type: "button", className: `cv-chip${on ? " on" : ""}`, "aria-pressed": on ? "true" : "false", disabled: full, title: full ? `Up to ${MAX_RIVALS} at once` : "" }, brandMark(n, "s"), n);
    b.onclick = () => { S.rivals = on ? S.rivals.filter((x) => x !== n) : [...S.rivals, n]; S.pg.cmpP = 0; redo(); };
    pick.append(b);
  });
  const tools = h("div", { className: "cv-tools" }, h("span", { className: "cv-muted" }, fmt("Compare {brand} with", { brand: V.own })), pick,
    h("span", { className: "cv-muted" }, `${S.rivals.length} of ${MAX_RIVALS}`));

  const colStyle = `--n:${names.length};--cols:minmax(150px,1.4fr) repeat(${names.length}, minmax(84px,1fr))`;
  const headRow = (first) => h("div", { className: "cv-tr cv-th", role: "row" }, h("span", { role: "columnheader" }, first),
    ...names.map((n, i) => h("span", { role: "columnheader", className: `cv-who${i === 0 ? " cv-me" : ""}` }, brandMark(n, "s"), h("span", { className: "cv-ell" }, n))));
  const cell = (v, f, best, i) => h("span", { role: "cell", className: `cv-num${v != null && v === best ? " cv-best" : ""}${i === 0 ? " cv-me" : ""}` }, v == null ? "—" : f(v));

  // Measures
  const mt = h("div", { className: "cv-table cv-cmp", role: "table", "aria-label": "Measures", style: colStyle });
  mt.append(headRow("Measure"));
  CMP_MEASURES.forEach(([key, label, f, low]) => {
    const vals = names.map((_, i) => sideOf(i, key));
    const best = bestOf(vals, low);
    mt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-strong" }, label), ...vals.map((v, i) => cell(v, f, best, i))));
  });
  const wins = names.map((_, i) => CMP_MEASURES.filter(([key, , , low]) => { const vals = names.map((__, j) => sideOf(j, key)); const best = bestOf(vals, low); return best != null && vals[i] === best; }).length);
  mt.append(h("div", { className: "cv-tr cv-foot-row", role: "row" }, h("span", { role: "cell", className: "cv-muted" }, "Best on"), ...wins.map((w, i) => h("span", { role: "cell", className: `cv-num${i === 0 ? " cv-me" : ""}` }, `${w} of ${CMP_MEASURES.length}`))));

  // Engine by engine, one measure at a time
  const MET = [["sov", "Share of voice", pct], ["vis", "Visibility", pct], ["pos", "Position", num, true], ["mentions", "Mentions", num]];
  const met = MET.find((m) => m[0] === S.cmpMetric) || MET[0];
  const et = h("div", { className: "cv-table cv-cmp", role: "table", "aria-label": "Engine by engine", style: colStyle });
  et.append(headRow("Engine"));
  C[0].engines.forEach((e, k) => {
    const vals = names.map((_, i) => { const x = i === 0 ? e.me : C[i - 1].engines[k].them; return x ? x[met[0]] : null; });
    const best = bestOf(vals, met[3]);
    et.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, engineMark(e.engine, "s"), ENG[e.engine], h("span", { className: "cv-muted" }, ` · ${e.answers}`)),
      ...(e.me ? vals.map((v, i) => cell(v, met[2], best, i)) : [h("span", { role: "cell", className: "cv-span cv-muted" }, "No answers")])));
  });
  const engCard = card("", h("div", { className: "cv-tools" }, h("h4", { className: "cv-h4" }, "Engine by engine"),
    seg("Measure", MET.map(([id, l]) => [id, l]), met[0], (id) => { S.cmpMetric = id; redo(); })), h("div", { className: "cv-scroll" }, et));

  // Topic by topic
  const tt = h("div", { className: "cv-table cv-cmp", role: "table", "aria-label": "Topic by topic", style: colStyle });
  tt.append(headRow("Topic · answers"));
  C[0].topics.forEach((t, k) => {
    const vals = names.map((_, i) => { const x = i === 0 ? t.me : C[i - 1].topics[k].them; return x ? x[met[0]] : null; });
    const best = bestOf(vals, met[3]);
    tt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-ell" }, t.topic, h("span", { className: "cv-muted" }, ` · ${t.answers}`)), ...vals.map((v, i) => cell(v, met[2], best, i))));
  });
  const topicCard = card("", h("h4", { className: "cv-h4" }, "Topic by topic", h("span", { className: "cv-sub" }, met[1].toLowerCase())), h("div", { className: "cv-scroll" }, tt));

  // Named together
  const tog = card("", h("h4", { className: "cv-h4" }, fmt("Named in the same answers as {brand}", { brand: V.own }), h("span", { className: "cv-sub" }, `of ${C[0].together.answers}`)));
  C.forEach((c) => {
    const tg = c.together;
    const [mb] = mixBar([{ label: "Both", n: tg.both, c: "var(--cv-ink)" }, { label: fmt("Only {brand}", { brand: V.own }), n: tg.onlyMe, c: "var(--you)" }, { label: fmt("Only {brand}", { brand: c.name }), n: tg.onlyThem, c: "var(--cv-them)" }, { label: "Neither", n: tg.neither, c: "var(--cv-dim)" }]);
    tog.append(h("div", { className: "cv-tog" }, h("span", { className: "cv-who" }, brandMark(c.name, "s"), h("b", {}, c.name)), mb,
      h("span", { className: "cv-muted small" }, fmt("both {both} · only {own} {onlyMe} · only {rival} {onlyThem} · neither {neither}. Both named: {own} first in {meFirst}, {rival} in {themFirst}.", { both: tg.both, own: V.own, onlyMe: tg.onlyMe, rival: c.name, onlyThem: tg.onlyThem, neither: tg.neither, meFirst: tg.meFirst, themFirst: tg.themFirst }))));
  });
  tog.append(h("div", { className: "cv-legend" }, ...[["var(--cv-ink)", "Both"], ["var(--you)", fmt("Only {brand}", { brand: V.own })], ["var(--cv-them)", "Only the rival"], ["var(--cv-dim)", "Neither"]].map(([c, l]) => h("span", {}, h("i", { style: `background:${c}` }), l))));

  // Prompt by prompt, one engine at a time
  const P = C[0].prompts.map((p, k) => {
    const e = V.engines.indexOf(S.cmpEng);
    const base = p.cells[e];
    const places = base && !base.noAnswer ? [base.me, ...C.map((c) => (c.prompts[k].cells[e] || {}).them || null)] : null;
    return { text: p.text, captureId: base && base.captureId, places, noAnswer: !base || base.noAnswer };
  });
  const lead = (pl) => { const xs = pl.map((v, i) => [v, i]).filter(([v]) => v); return xs.length ? xs.sort((a, b2) => a[0] - b2[0])[0][1] : -1; };
  const PF = [["all", "All", () => true], ["ahead", fmt("A rival ahead of {brand}", { brand: V.own }), (p) => p.places && lead(p.places) > 0], ["missing", fmt("{brand} not named", { brand: V.own }), (p) => p.places && !p.places[0] && p.places.some(Boolean)], ["first", fmt("{brand} first", { brand: V.own }), (p) => p.places && lead(p.places) === 0]];
  const f = (PF.find((x) => x[0] === S.pf) || PF[0])[2];
  const shown = P.filter(f);
  const { rows, pager } = paged("cmpP", shown, 12, redo);
  const pt = h("div", { className: "cv-table cv-cmp", role: "table", "aria-label": "Prompt by prompt", style: colStyle });
  pt.append(headRow("Prompt"));
  rows.forEach((p) => {
    if (!p.places) { pt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell" }, promptLink(p.text, p.captureId)), h("span", { role: "cell", className: "cv-span cv-muted" }, p.noAnswer ? "No answer from this engine" : "—"))); return; }
    const best = bestOf(p.places, true);
    pt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell" }, promptLink(p.text, p.captureId)),
      ...p.places.map((v, i) => h("span", { role: "cell", className: `cv-num${v && v === best ? " cv-best" : ""}${i === 0 ? " cv-me" : ""}` }, v ? ord(v) : h("span", { className: "cv-muted" }, "not named")))));
  });
  const promptCard = card("", h("div", { className: "cv-tools" }, h("h4", { className: "cv-h4" }, "Prompt by prompt", h("span", { className: "cv-sub" }, "place in the answer; a prompt opens it")),
    seg("Engine", V.engines.map((e) => [e, ENG[e], engineMark(e, "s")]), S.cmpEng, (id) => { S.cmpEng = id; S.pg.cmpP = 0; redo(); })),
    chips("Show", PF.map(([id, l, g]) => [id, l, P.filter(g).length]), S.pf, (id) => { S.pf = id; S.pg.cmpP = 0; redo(); }),
    shown.length ? h("div", { className: "cv-scroll" }, pt) : empty("No prompt matches."), pager);

  // Products and wording, a column per brand
  const prodsOf = (i) => (i === 0 ? C[0].products.me : C[i - 1].products.them);
  const quotesOf = (i) => (i === 0 ? C[0].quotes.me : C[i - 1].quotes.them);
  const cols = (fn) => h("div", { className: "cv-cols", style: `--n:${names.length}` }, ...names.map((n, i) => h("div", { className: "cv-col" }, h("div", { className: "cv-who" }, brandMark(n), h("b", {}, n)), ...fn(i))));
  const prodCard = card("", h("h4", { className: "cv-h4" }, "Product cards"), cols((i) => (prodsOf(i).length ? prodsOf(i).map((p) => h("div", { className: "cv-prod" }, h("span", { className: "cv-ell" }, p.name), h("span", { className: "cv-badge" }, `×${p.cards}`), p.first ? h("span", { className: "cv-badge gold" }, `1st ×${p.first}`) : "")) : [empty("No product cards")])));
  const quoteCard = card("", h("h4", { className: "cv-h4" }, "How the answers word it"), cols((i) => (quotesOf(i).length ? quotesOf(i).map((q) => h("figure", { className: "cv-quote" }, h("blockquote", {}, `…${q.text}…`), h("figcaption", { className: "cv-who" }, engineMark(q.engine, "s"), promptLink(q.prompt, q.captureId)))) : [empty("No lines to quote")])));
  const more = h("div", { className: "cv-tools" }, ...S.rivals.map((n) => { const b = h("button", { type: "button", className: "cv-link cv-more" }, `Full comparison with ${n} ›`); b.onclick = () => D.openFullCompare(n); return b; }));
  return section("cv-compare", "Compare brands", S.rivals.length === 1 ? fmt("{brand} and {rival}", { brand: V.own, rival: S.rivals[0] }) : fmt("{brand} and {n} others", { brand: V.own, n: S.rivals.length }), tools,
    card("", h("h4", { className: "cv-h4" }, "Measures", h("span", { className: "cv-sub" }, "best in each row marked")), h("div", { className: "cv-scroll" }, mt)),
    engCard, topicCard, tog, promptCard, prodCard, quoteCard, more);
}

/* ---------- 4. Sources ---------- */

function sourcesSec(drill) {
  const s = V.sources;
  const tiles = h("div", { className: "cv-tiles" },
    tile("Citations", String(s.total), V.citations.byEngine.map((e) => `${ENG[e.engine]} ${e.n}`).join(" · "), h("span", { className: "cv-lgroup" }, ...V.engines.map((e) => engineMark(e, "s")))),
    tile("Sites cited", String(s.sites), s.domains.length ? `top 5 hold ${Math.round(s.domains.slice(0, 5).reduce((n, d) => n + d.citations, 0) * 100 / Math.max(1, s.total))}%` : ""),
    tile("Pages the engines read", String(s.read), "cited or not"),
    tile(ownSiteLabel(), String(V.citations.ownSite), `of ${s.total} citations`, brandMark(V.own, "s")));
  const [kb, kl] = mixBar(V.citations.kinds.map((k) => ({ label: k.label, n: k.n, c: KIND_COLOR[k.label] || "var(--kind-other)" })));
  const dl = h("div", { className: "cv-table cv-doms", role: "table", "aria-label": "Most cited sites" });
  dl.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["#", "Site", "Kind", "Citations", "Answers citing it", "Cited by"].map((x) => h("span", { role: "columnheader" }, x))));
  const max = Math.max(1, ...s.domains.map((d) => d.citations));
  const dpg = paged("doms", s.domains, 15, () => replace("cv-sources", () => sourcesSec(SRC_DRILL)));
  dpg.rows.forEach((d, j) => {
    const i = (S.pg.doms || 0) * 15 + j;
    const b = h("button", { type: "button", className: "cv-who cv-link", title: "Its pages and the prompts that cited them" }, siteMark(d.domain, "m"), h("span", { className: "cv-ell" }, d.domain));
    b.onclick = () => D.openDomain(d.domain);
    dl.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-num cv-muted" }, String(i + 1)), h("span", { role: "cell" }, b),
      h("span", { role: "cell" }, h("span", { className: "cv-pill" }, d.kind)),
      h("span", { role: "cell", className: "cv-barcell" }, bar(d.citations * 100 / max, "var(--cv-ink)"), h("span", { className: "cv-num" }, String(d.citations))),
      h("span", { role: "cell", className: "cv-num" }, `${d.answers} · ${pct(d.pct)}`), h("span", { role: "cell", className: "cv-lgroup" }, ...d.engines.map((e) => engineMark(e, "s")))));
  });
  const pages = card("", h("h4", { className: "cv-h4" }, "Most cited pages"));
  s.pages.slice(0, 15).forEach((p) => pages.append(h("div", { className: "cv-page" }, siteMark(p.domain, "m"), h("a", { href: p.url, target: "_blank", rel: "noopener", className: "cv-ell" }, p.title || p.url), h("span", { className: "cv-badge" }, `×${p.citations}`))));
  return section("cv-sources", "Sources", `${s.total} citations from ${s.sites} sites`, tiles, card("", h("h4", { className: "cv-h4" }, "Kinds of sites cited"), kb, kl),
    card("", h("h4", { className: "cv-h4" }, "Most cited sites"), h("div", { className: "cv-scroll" }, dl), dpg.pager), pages, drill || "");
}

/* ---------- 5. Citations ---------- */

function citationsSec() {
  const C = V.citations;
  const rows = C.rows.map((r, i) => ({ ...r, i }));
  const match = (r) => (S.ce === "all" || r.engine === S.ce) && (S.ck === "All" || r.kind === S.ck) && (S.ct === "All" || r.pageType === S.ct) && (!S.cboth || r.bothEngines)
    && (!S.cq || `${r.domain} ${r.title} ${r.prompt} ${r.url}`.toLowerCase().includes(S.cq.toLowerCase()));
  const F = rows.filter(match);
  const PER = 20, pages = Math.max(1, Math.ceil(F.length / PER)); S.cpage = Math.min(S.cpage, pages - 1);
  const latest = Math.max(0, ...rows.map((r) => r.at || 0));
  const age = (t) => { if (!t) return "—"; const d = (latest - t) / 864e5; return d < 14 ? `${Math.max(1, Math.round(d))}d` : d < 60 ? `${Math.round(d / 7)}w` : d < 730 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`; };
  const redo = () => replace("cv-citations", citationsSec);
  const mixes = h("div", { className: "cv-grid3" },
    ...[["Kind of page", C.pageTypes.map((x, i) => ({ label: x.label, n: x.n, c: RAMP[i % RAMP.length] }))],
      ["How recent", C.freshness.map((x, i) => ({ label: x.label, n: x.n, c: i === C.freshness.length - 1 ? "var(--cv-dim)" : RAMP[i] }))],
      ["Where the engine found it", C.lanes.map((x, i) => ({ label: x.label, n: x.n, c: RAMP[(i * 2) % RAMP.length] }))]].map(([t, parts]) => { const [b, l] = mixBar(parts); return card("", h("h4", { className: "cv-h4" }, t), b, l); }));
  const tiles = h("div", { className: "cv-tiles" }, tile("Citations", String(C.total), `${C.pages} different pages`), tile("Cited by both engines", String(C.bothEngines), "same site, same prompt", h("span", { className: "cv-lgroup" }, ...V.engines.slice(0, 2).map((e) => engineMark(e, "s")))),
    tile("Typical page age", C.medianAgeDays == null ? "—" : `${C.medianAgeDays} days`, "median of dated pages"), tile(ownSiteLabel(), String(C.ownSite), `of ${C.total}`, brandMark(V.own, "s")));
  const q = h("input", { type: "search", id: "cvCitQ", className: "cv-search", placeholder: "Site, page or prompt", value: S.cq, "aria-label": "Filter citations" });
  q.oninput = () => { S.cq = q.value; S.cpage = 0; const pos = q.selectionStart; redo(); const n = document.getElementById("cvCitQ"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  const cnt = (f) => rows.filter(f).length;
  const typeVals = C.pageTypes.map((x) => x.label), kindVals = C.kinds.map((x) => x.label);
  const both = h("button", { type: "button", className: `cv-chip${S.cboth ? " on" : ""}`, "aria-pressed": S.cboth ? "true" : "false" }, h("span", { className: "cv-lgroup" }, ...V.engines.slice(0, 2).map((e) => engineMark(e, "s"))), "Cited by both");
  both.onclick = () => { S.cboth = !S.cboth; S.cpage = 0; redo(); };
  const tools = h("div", { className: "cv-tools" }, q, seg("Engine", [["all", "All", null, rows.length], ...V.engines.filter((e) => cnt((r) => r.engine === e)).map((e) => [e, ENG[e], engineMark(e, "s"), cnt((r) => r.engine === e)])], S.ce, (id) => { S.ce = id; S.cpage = 0; redo(); }));
  const filters = h("div", { className: "cv-tools" }, h("span", { className: "cv-muted" }, "Site"), chips("Kind of site", [["All", "All"], ...kindVals.map((k) => [k, k])], S.ck, (id) => { S.ck = id; S.cpage = 0; redo(); }),
    h("span", { className: "cv-muted" }, "Page"), chips("Kind of page", [["All", "All"], ...typeVals.map((k) => [k, k])], S.ct, (id) => { S.ct = id; S.cpage = 0; redo(); }), both);
  const t = h("div", { className: "cv-table cv-cits", role: "table", "aria-label": "All citations" });
  t.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Page", "Prompt", "Engine", "Source no.", "Search result", "Published", "In run", fmt("{brand} there", { brand: V.own }), ""].map((x) => h("span", { role: "columnheader" }, x))));
  F.slice(S.cpage * PER, S.cpage * PER + PER).forEach((r) => {
    const open = S.copen === r.i;
    const row = h("button", { type: "button", className: "cv-tr cv-rowbtn", role: "row", "aria-expanded": open ? "true" : "false" },
      h("span", { role: "cell", className: "cv-who" }, siteMark(r.domain, "m"), h("span", { className: "cv-stack" }, h("span", { className: "cv-ell cv-strong" }, r.title), h("span", { className: "cv-ell cv-muted" }, r.domain, " · ", h("span", { className: "cv-pill" }, r.pageType)))),
      h("span", { role: "cell", className: "cv-ell" }, r.prompt),
      h("span", { role: "cell", className: "cv-who" }, engineMark(r.engine, "s"), r.bothEngines ? h("span", { className: "cv-faded", title: "Also cited by another engine for this prompt" }, engineMark(V.engines.find((e) => e !== r.engine && e !== "grok") || r.engine, "s")) : ""),
      h("span", { role: "cell", className: "cv-num" }, `${r.n} of ${r.of}`),
      h("span", { role: "cell", className: "cv-num" }, r.rank ? `#${r.rank}` : "—"),
      h("span", { role: "cell", className: "cv-num" }, age(r.published)),
      h("span", { role: "cell", className: "cv-num" }, `×${r.times}`),
      h("span", { role: "cell", className: "cv-who" }, r.ownPlace ? h("span", { className: `cv-badge${r.ownPlace === 1 ? " first" : " you"}` }, ord(r.ownPlace)) : h("span", { className: "cv-badge bad" }, "not named"),
        r.first && r.first !== V.own ? brandMark(r.first, "s") : ""),
      h("span", { role: "cell", className: `cv-chev${open ? " open" : ""}`, "aria-hidden": "true" }, "›"));
    row.onclick = () => { S.copen = open ? -1 : r.i; redo(); };
    t.append(row);
    if (open) {
      const go = h("button", { type: "button", className: "cv-link" }, "Open the answer ›");
      go.onclick = () => D.openCapture(r.captureId);
      const kv = (k, v) => h("span", { className: "cv-kv" }, h("span", { className: "cv-muted" }, k), h("span", {}, v));
      t.append(h("div", { className: "cv-detail", role: "row" },
        h("div", { className: "cv-stack" }, h("span", { className: "cv-muted" }, "What the engine was shown"), h("p", {}, r.snippet || "No snippet was sent."), h("a", { href: r.url, target: "_blank", rel: "noopener", className: "cv-ell cv-mono" }, r.url)),
        h("div", { className: "cv-stack" }, kv("Pages this answer read", String(r.read)), kv("Pages it cited", String(r.of)), kv("Found through", r.lane === "news" ? "News results" : r.lane ? "Web search" : "Not sent"), kv("Kind of site", r.kind),
          kv("Named first", r.first || "no brand"), kv("Kind of answer", r.answerKind === "info" ? "Informational" : r.answerKind), kv("Prompt", promptLink(r.prompt, r.captureId)), go)));
    }
  });
  const prev = h("button", { type: "button", className: "cv-pg", "aria-label": "Previous page", disabled: S.cpage === 0 }, "‹");
  const next = h("button", { type: "button", className: "cv-pg", "aria-label": "Next page", disabled: S.cpage >= pages - 1 }, "›");
  prev.onclick = () => { S.cpage--; redo(); }; next.onclick = () => { S.cpage++; redo(); };
  const pager = h("div", { className: "cv-pager" }, h("span", { className: "cv-muted" }, F.length ? `${S.cpage * PER + 1}–${Math.min(F.length, S.cpage * PER + PER)} of ${F.length}` : "0 of 0"), prev, next);
  return section("cv-citations", "All citations", `${F.length} of ${C.total} · open a row for the snippet and the answer`, tiles, mixes, card("", tools, filters,
    F.length ? h("div", { className: "cv-scroll" }, t) : empty("No citation matches these filters."), pager,
    h("p", { className: "cv-foot" }, "Source no.: the page's place in that answer's citations. Search result: where it ranked in ChatGPT's results. Published: the page's date as the engine sent it. In run: answers in this run citing the same page.")));
}

/* ---------- 6. Prompts ---------- */

function promptsSec() {
  const P = V.prompts.map((p, i) => ({ ...p, i }));
  const rivalFirst = (p) => p.firsts.some((f) => f !== V.own);
  const missing = (p) => p.cells.some((c) => c && c.answered && !c.pos);
  const allFirst = (p) => p.cells.filter((c) => c && c.answered).length > 0 && p.cells.filter((c) => c && c.answered).every((c) => c.pos === 1);
  const PF = [["all", "All prompts", () => true], ["rival", "A rival named first", rivalFirst], ["missing", "Missing on an engine", missing], ["first", "First everywhere", allFirst]];
  const topics = [...new Set(P.map((p) => p.topic))];
  const redo = () => replace("cv-prompts", promptsSec);
  const shown = P.filter((p) => PF.find((f) => f[0] === S.prf)[2](p) && (S.prt === "All" || p.topic === S.prt));
  const t = h("div", { className: "cv-table cv-prompts", role: "table", "aria-label": "Prompt rankings", style: `--n-eng:${V.engines.length}` });
  t.append(h("div", { className: "cv-tr cv-th", role: "row" }, h("span", { role: "columnheader" }, "Prompt"), h("span", { role: "columnheader" }, "Topic"),
    ...V.engines.map((e) => h("span", { role: "columnheader", className: "cv-who" }, engineMark(e, "s"), ENG[e])),
    ...["Visibility", "Position", "Named first", fmt("{brand}'s card", { brand: V.own }), "Searches"].map((x) => h("span", { role: "columnheader" }, x))));
  const ppg = paged("prompts", shown, 15, redo);
  ppg.rows.forEach((p) => {
    const open = S.propen === p.i;
    const cells = p.cells.map((c, i) => {
      if (!c) return h("span", { role: "cell", className: "cv-pc na" }, "—");
      if (!c.answered) return h("span", { role: "cell", className: "cv-pc na", title: c.limit ? "Usage limit reached" : "No answer" }, c.limit ? "limit" : "no answer");
      const b = h("button", { type: "button", role: "cell", className: `cv-pc ${c.pos === 1 ? "first" : c.pos ? (c.pos <= 3 ? "mid" : "low") : "out"}`, title: c.pos ? fmt("{place} · {brand} first · open the answer", { place: tr(ord(c.pos)), brand: c.first }) : c.first ? fmt("Not named · {brand} first · open the answer", { brand: c.first }) : fmt("Not named · no brand first · open the answer") }, c.pos ? String(c.pos) : "✕");
      b.onclick = (ev) => { ev.stopPropagation(); D.openCapture(c.captureId); };
      return b;
    });
    // The prompt opens its answer; the arrow beside it, its searches.
    const toggle = h("button", { type: "button", className: "cv-ptoggle", "aria-expanded": open ? "true" : "false", "aria-label": open ? "Hide its searches" : "Show its searches" }, h("span", { className: `cv-chev${open ? " open" : ""}`, "aria-hidden": "true" }, "›"));
    toggle.onclick = () => { S.propen = open ? -1 : p.i; redo(); };
    t.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-ptext" }, toggle, promptLink(p.text)), h("span", { role: "cell" }, h("span", { className: "cv-pill" }, p.topic)), ...cells,
      h("span", { role: "cell", className: "cv-num" }, p.visibility == null ? "—" : pct(p.visibility)), h("span", { role: "cell", className: "cv-num" }, num(p.avgPos)),
      h("span", { role: "cell", className: "cv-lgroup" }, ...p.firsts.map((n) => brandMark(n, "s"))), h("span", { role: "cell", className: "cv-ell cv-muted" }, p.topProduct || "—"),
      h("span", { role: "cell", className: "cv-num cv-muted" }, String(p.queries.length))));
    if (open) t.append(h("div", { className: "cv-detail", role: "row" }, h("div", { className: "cv-stack" }, h("span", { className: "cv-muted" }, "Searches the engines ran for it"),
      ...(p.queries.length ? p.queries.map((x) => h("span", { className: "cv-who cv-mono" }, engineMark(x.engine, "s"), x.text)) : [h("span", { className: "cv-muted" }, "No searches were sent.")]))));
  });
  return section("cv-prompts", "Prompt rankings", fmt("{brand}'s place in each answer · {n} prompts", { brand: V.own, n: P.length }, "{brand}'s place in each answer · {n} prompt"),
    h("div", { className: "cv-tools" }, chips("Show", PF.map(([id, l, f]) => [id, l, P.filter(f).length]), S.prf, (id) => { S.prf = id; S.pg.prompts = 0; redo(); }), chips("Topic", [["All", "All topics"], ...topics.map((x) => [x, x])], S.prt, (id) => { S.prt = id; S.pg.prompts = 0; redo(); })),
    card("", h("div", { className: "cv-scroll" }, t), ppg.pager, h("p", { className: "cv-legend cv-foot" }, h("span", { className: "cv-pc first" }, "1"), " named first ", h("span", { className: "cv-pc mid" }, "2"), " 2nd–3rd ", h("span", { className: "cv-pc low" }, "4"), " lower ", h("span", { className: "cv-pc out" }, "✕"), " not named")));
}

/* ---------- 7. Products & topics ---------- */

function productsSec() {
  const p = V.products;
  const pt = h("div", { className: "cv-table cv-prodt", role: "table", "aria-label": "Product cards" });
  pt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["#", "Product", "Cards · first card", "Brand"].map((x) => h("span", { role: "columnheader" }, x))));
  const max = Math.max(1, ...p.rows.map((x) => x.cards));
  const prpg = paged("prods", p.rows, 10, () => replace("cv-products", productsSec));
  prpg.rows.forEach((x, j) => { const i = (S.pg.prods || 0) * 10 + j; pt.append(h("div", { className: `cv-tr${x.brand === V.own ? " you" : ""}`, role: "row" }, h("span", { role: "cell", className: "cv-num cv-muted" }, String(i + 1)),
    h("span", { role: "cell", className: "cv-ell" }, x.name),
    h("span", { role: "cell", className: "cv-barcell" }, h("span", { className: "cv-mix sm" }, h("i", { style: `width:${x.first * 100 / max}%;background:var(--you)` }), h("i", { style: `width:${(x.cards - x.first) * 100 / max}%;background:var(--you-soft)` })), h("span", { className: "cv-num" }, `${x.cards} · ${x.first}`)),
    h("span", { role: "cell", className: "cv-who" }, x.brand ? brandMark(x.brand, "s") : "", x.brand || "—"))); });
  const share = card("", h("h4", { className: "cv-h4" }, "Card share by brand", h("span", { className: "cv-sub" }, `of ${p.total} cards`)));
  p.share.forEach((x) => share.append(h("div", { className: `cv-bl${x.isOwn ? " you" : ""}` }, brandMark(x.name, "s"), h("span", { className: "cv-ell" }, x.name), bar(x.pct, x.isOwn ? "var(--you)" : "var(--cv-dim)"), h("span", { className: "cv-num" }, pct(x.pct)), h("span", { className: "cv-num cv-muted" }, `${x.first} first`))));
  const tt = h("div", { className: "cv-table cv-topics", role: "table", "aria-label": "Topics" });
  tt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Topic", "Prompts · answers", fmt("{brand}: share · visibility", { brand: V.own }), "Strongest rival", ""].map((x) => h("span", { role: "columnheader" }, x))));
  V.topics.forEach((x) => {
    const ahead = !x.rival || (x.own && x.own.sov >= x.rival.sov);
    tt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-strong" }, x.topic), h("span", { role: "cell", className: "cv-num cv-muted" }, `${x.prompts} · ${x.answers}`),
      h("span", { role: "cell", className: "cv-barcell" }, bar(x.own ? x.own.sov * 1.5 : 0, "var(--you)"), h("span", { className: "cv-num" }, x.own ? `${pct(x.own.sov)} · ${pct(x.own.vis)}` : "—")),
      h("span", { role: "cell", className: "cv-who" }, x.rival ? brandMark(x.rival.name, "s") : "", x.rival ? `${x.rival.name} ${pct(x.rival.sov)}` : "—"),
      h("span", { role: "cell" }, h("span", { className: `cv-badge ${ahead ? "good" : "bad"}` }, fmt("{brand} ahead", { brand: ahead ? V.own : x.rival.name })))));
  });
  return section("cv-products", "Products & topics", p.total ? `${p.total} product cards in ${p.answersWithCards} answers` : "",
    p.total ? h("div", { className: "cv-grid2" }, card("", h("h4", { className: "cv-h4" }, "Products shown as cards"), h("div", { className: "cv-scroll" }, pt), prpg.pager), share) : empty("No answer in this view showed product cards."),
    card("", h("h4", { className: "cv-h4" }, "Topics", h("span", { className: "cv-sub" }, "prompts grouped by their tags, or by what they ask about")), h("div", { className: "cv-scroll" }, tt)));
}

/* ---------- 8. Searches, site: and ads ---------- */

function searchesSec() {
  const s = V.searches;
  const eng = h("div", { className: "cv-grid3" });
  s.byEngine.forEach((e) => {
    if (!e.published) { eng.append(card("cv-eng-card", h("div", { className: "cv-who" }, engineMark(e.engine, "l"), h("span", { className: "cv-stack" }, h("b", {}, e.label), h("span", { className: "cv-muted" }, "Doesn't publish the searches it runs"))), empty("Not published. This is not zero searches."))); return; }
    const c = card("cv-eng-card", h("div", { className: "cv-who" }, engineMark(e.engine, "l"), h("span", { className: "cv-stack" }, h("b", {}, e.label), h("span", { className: "cv-muted" }, `${e.perPrompt} per prompt · ${e.avgWords} words each`)), h("span", { className: "cv-big" }, String(e.n))));
    e.traits.forEach((t) => c.append(h("div", { className: "cv-bl" }, h("span", { className: "cv-ell" }, t.label), bar(t.pct, `var(--eng-${e.engine})`), h("span", { className: "cv-num" }, pct(t.pct)))));
    if (e.unanswered) c.append(h("span", { className: "cv-note sm" }, `${e.unanswered} of these searches have no answer: the prompt never came back.`));
    eng.append(c);
  });
  const brands = card("", h("h4", { className: "cv-h4" }, "Brands named in the searches", h("span", { className: "cv-sub" }, "the engine had them in mind before reading anything")));
  const bmax = Math.max(1, ...s.brands.map((b) => b.n));
  s.brands.length ? s.brands.forEach((b) => brands.append(h("div", { className: `cv-bl${b.isOwn ? " you" : ""}` }, brandMark(b.name, "s"), h("span", { className: "cv-ell" }, b.name), bar(b.n * 100 / bmax, b.isOwn ? "var(--you)" : "var(--cv-dim)"), h("span", { className: "cv-num" }, String(b.n))))) : brands.append(empty("No search named a tracked brand."));
  const ex = card("", h("h4", { className: "cv-h4" }, "Same prompt, each engine"), s.example ? h("p", { className: "cv-muted" }, "For ", promptLink(s.example.prompt)) : "");
  if (s.example) s.example.byEngine.forEach((x) => ex.append(h("div", { className: "cv-ex" }, engineMark(x.engine), h("div", { className: "cv-stack" }, ...x.queries.map((q) => h("span", { className: "cv-mono" }, q))))));
  else ex.append(empty("No prompt has searches from more than one engine."));
  const site = s.site;
  const sr = h("div", { className: "cv-stack" });
  const spg = paged("site", site.rows, 8, () => replace("cv-searches", searchesSec));
  spg.rows.forEach((r) => sr.append(h("div", { className: "cv-site-row" }, engineMark(r.engine), h("div", { className: "cv-stack" }, h("span", { className: "cv-mono" }, r.text), h("span", { className: "cv-muted" }, "for ", promptLink(r.prompt))),
    h("div", { className: "cv-chips" }, ...r.include.map((d) => h("span", { className: "cv-pill cv-who" }, siteMark(d, "s"), d)), ...r.exclude.map((d) => h("span", { className: "cv-pill cv-who ex" }, siteMark(d, "s"), `not ${d}`)),
      r.laterCited == null ? h("span", { className: "cv-pill cv-muted" }, "no answer to check") : h("span", { className: `cv-pill ${r.laterCited.length ? "good" : ""}` }, r.laterCited.length ? `cited: ${r.laterCited.join(", ")}` : "none cited later")))));
  const siteCard = card("cv-site", h("div", { className: "cv-who" }, h("span", { className: "cv-op" }, "site:"), h("span", { className: "cv-stack" }, h("b", {}, "Searches limited to chosen sites"), h("span", { className: "cv-muted" }, "With site: in a search, the engine only looks inside the sites it names."))),
    h("div", { className: "cv-tiles" }, tile("site: searches", String(site.count), `of ${s.total}`), tile("Sites named", String(site.domains.length), site.domains.slice(0, 3).map((d) => d.domain).join(", ")),
      tile("Your site named", site.ownTargeted ? "Yes" : "0", site.ownTargeted ? "" : "never targeted")),
    site.rows.length ? sr : "", spg.pager,
    h("div", { className: "cv-grid3" }, ...site.byEngine.filter((e) => !e.n).map((e) => empty(e.engine === "gemini" && !e.of ? "Gemini doesn't publish its searches." : `${ENG[e.engine]} ran no site: searches in ${e.of}.`, engineMark(e.engine)))));
  const a = V.ads;
  const adsCard = card("cv-ads", h("div", { className: "cv-who" }, h("span", { className: "cv-op ad" }, "AD"), h("span", { className: "cv-stack" }, h("b", {}, "Ads shown with the answers"), h("span", { className: "cv-muted" }, "ChatGPT can show a sponsored card after an answer. The other engines have no ad format."))),
    h("div", { className: "cv-tiles" }, tile("Answers with an ad", `${a.withAd}/${a.answers}`), tile("Advertisers", String(a.advertisers.length)), tile("Your brand advertising", String(a.own)), tile("Rivals advertising", String(a.rival)),
      tile("Advertiser named in the answer", a.rows.length ? `${a.named}/${a.rows.length}` : "—"), tile("Advertiser’s site cited", a.rows.length ? `${a.cited}/${a.rows.length}` : "—")));
  if (!a.rows.length) adsCard.append(empty(a.answers ? `No ads in this run. None of ChatGPT's ${a.answers} answers carried one.` : "No ChatGPT answers in this view.", a.engines.length ? engineMark("chatgpt") : ""));
  else {
    const at = h("div", { className: "cv-table cv-adt", role: "table", "aria-label": "Ads" });
    at.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Advertiser", "Ad", "Prompt", "Named in answer", "Site cited", fmt("{brand} there", { brand: V.own })].map((x) => h("span", { role: "columnheader" }, x))));
    const apg = paged("ads", a.rows, 10, () => replace("cv-searches", searchesSec));
    apg.rows.forEach((x) => {
      const b = h("button", { type: "button", className: "cv-tr cv-rowbtn", role: "row", title: "Open the answer" }, h("span", { role: "cell", className: "cv-who" }, siteMark(x.domain || x.advertiser, "m"), x.advertiser),
        h("span", { role: "cell", className: "cv-stack" }, h("span", { className: "cv-ell cv-strong" }, x.title || x.label), h("span", { className: "cv-ell cv-muted" }, x.domain)),
        h("span", { role: "cell", className: "cv-ell" }, x.prompt), h("span", { role: "cell" }, h("span", { className: `cv-badge ${x.namedInAnswer ? "good" : ""}` }, x.namedInAnswer ? "Yes" : "No")),
        h("span", { role: "cell" }, h("span", { className: "cv-badge" }, x.siteCited ? "Yes" : "No")), h("span", { role: "cell", className: "cv-num" }, x.ownPlace ? ord(x.ownPlace) : "not named"));
      b.onclick = () => D.openCapture(x.captureId);
      at.append(b);
    });
    adsCard.append(h("div", { className: "cv-scroll" }, at), apg.pager);
  }
  return section("cv-searches", "Searches, site: and ads", fmt("{searches} searches across {n} engines", { searches: s.total, n: s.byEngine.filter((e) => e.published).length }, "{searches} searches across {n} engine"), eng, h("div", { className: "cv-grid2" }, brands, ex), siteCard, adsCard);
}

/* ---------- 9. Signals ---------- */

function signalsSec(runHistory) {
  const g = V.signals;
  const ag = card("", h("h4", { className: "cv-h4" }, "Engine agreement", h("span", { className: "cv-sub" }, "the same brand named first")),
    h("div", { className: "cv-big-row" }, h("span", { className: "cv-big" }, String(g.agreement.same)), h("span", { className: "cv-muted" }, ` ${fmt("of {n} prompts", { n: g.agreement.of }, "of {n} prompt")}`)), bar(g.agreement.of ? g.agreement.same * 100 / g.agreement.of : 0, "var(--cv-ink)"));
  const dfp = paged("differ", g.agreement.differ, 8, () => replace("cv-signals", () => signalsSec(RUN_HISTORY)));
  dfp.rows.forEach((d) => ag.append(h("div", { className: "cv-differ" }, promptLink(d.text), ...d.firsts.filter((f) => f.first).map((f) => h("span", { className: "cv-who" }, engineMark(f.engine, "s"), brandMark(f.first, "s"), f.first)))));
  ag.append(dfp.pager);
  const br = card("", h("h4", { className: "cv-h4" }, "Search breadth", h("span", { className: "cv-sub" }, "per answer")));
  const bt = h("div", { className: "cv-table cv-breadth", role: "table", "aria-label": "Search breadth" });
  bt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Engine", "Searches", "Pages read", "Pages cited"].map((x) => h("span", { role: "columnheader" }, x))));
  // Gemini doesn't publish its searches: "not published", as the overview
  // says, not "0 (0)", which read as "never searched" (1.0.2).
  g.breadth.forEach((x) => bt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, engineMark(x.engine), ENG[x.engine]), ...[["searches"], ["read"], ["cited"]].map(([k]) => h("span", { role: "cell", className: "cv-num" }, k === "searches" && x.engine === "gemini" && !x.totals[k] ? "not published" : `${x[k]} (${x.totals[k]})`)))));
  br.append(bt);
  const KL = { shopping: "Shopping", info: "Informational", local: "Local", images: "Image-led", memory: "From memory" };
  const [kb, kl] = mixBar(g.kinds.map((k) => ({ label: KL[k.id] || k.id, n: k.n, c: `var(--ak-${k.id}, var(--kind-other))` })));
  const tiles = h("div", { className: "cv-tiles" },
    // Your own site is on Sources (1.0.6: it was on both).
    tile("Coverage gaps", String(g.gaps.length), "answers without you that name two or more rivals"),
    tile("First product card", `${g.firstCard.own}`, `of ${g.firstCard.of} answers with cards`));
  const gpp = paged("gaps", g.gaps, 8, () => replace("cv-signals", () => signalsSec(RUN_HISTORY)));
  const gaps = g.gaps.length ? card("", h("h4", { className: "cv-h4" }, "Prompts with a gap"), ...gpp.rows.map((x) => h("div", { className: "cv-differ" }, promptLink(x.text))), gpp.pager) : "";
  const qt = h("div", { className: "cv-table cv-quality", role: "table", "aria-label": "Data quality" });
  qt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Engine", "Answered", "", "Notes"].map((x) => h("span", { role: "columnheader" }, x))));
  g.quality.forEach((x) => {
    const notes = [];
    if (x.limited) notes.push(`${x.limited} stopped by the engine's usage limit`);
    if (x.missing && x.missing > x.limited) notes.push(`${x.missing - x.limited} came back without an answer`);
    if (x.doubled) notes.push(`${x.doubled} prompts were typed in twice by the page; read as asked`);
    qt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, engineMark(x.engine), ENG[x.engine]), h("span", { role: "cell", className: "cv-num" }, `${x.answered}/${x.sent}`),
      h("span", { role: "cell" }, bar(x.sent ? x.answered * 100 / x.sent : 0, `var(--eng-${x.engine})`)),
      h("span", { role: "cell" }, h("span", { className: `cv-badge ${notes.length ? (x.answered ? "warn" : "bad") : "good"}` }, notes.length ? notes.join(" · ") : "All answered"))));
  });
  return section("cv-signals", "Signals and data quality", "", h("div", { className: "cv-grid2" }, ag, h("div", { className: "cv-stack gap" }, /* search breadth: the By engine table on Overview (1.0.6) */ void br || "", card("", h("h4", { className: "cv-h4" }, "Kinds of answer"), kb, kl))), tiles, gaps,
    card("", h("h4", { className: "cv-h4" }, "Data quality"), h("div", { className: "cv-scroll" }, qt)), runHistory ? card("", runHistory) : "");
}

/* ---------- Run vs run (0.80.0) ----------
 *
 * Asked: "if I were to run same campaign, same prompt on same LLM, I should
 * also be able to see the difference between them". Two runs side by side,
 * over the prompt × engine pairs both answered (lib/runCompare.js). The runs
 * and the comparison come from the panel (D.runs, D.compareRuns), which asks
 * the worker; this tab draws them.
 */
const posText = (p) => (p == null ? "—" : p === "named" ? "named" : `#${p}`);
function runsSec() {
  const runs = (D.runs || []).filter((r) => r.hasAnswers);
  if (runs.length < 2) return section("cv-runs", "Run vs run", "", card("", empty("Run this campaign again to compare one run with another. Until then there is one run to show.")));
  // Newest first; by default the newest against the one before it.
  if (!S.runB || !runs.some((r) => r.id === S.runB)) S.runB = runs[0].id;
  // The earlier run defaults to the last one before it on the same engines:
  // a ChatGPT run set against a Gemini-only run has nothing to compare.
  if (!S.runA || !runs.some((r) => r.id === S.runA) || S.runA === S.runB) {
    const b = runs.find((r) => r.id === S.runB) || {};
    const older = runs.slice(runs.indexOf(b) + 1);
    const same = older.find((r) => (r.engines || []).some((e) => (b.engines || []).includes(e)));
    S.runA = (same || older[0] || runs.find((r) => r.id !== S.runB) || {}).id;
  }
  const pick = (which, label) => {
    const sel = h("select", { className: "filter", id: `cvRun${which}`, "aria-label": label });
    runs.forEach((r) => sel.append(h("option", { value: r.id }, r.label)));
    sel.value = which === "A" ? S.runA : S.runB;
    sel.onchange = () => { S[`run${which}`] = sel.value; replace("cv-runs", runsSec); };
    return sel;
  };
  const body = h("div", { className: "cv-stack gap", id: "cvRunsBody" }, h("div", { className: "cv-muted" }, "Comparing…"));
  const head = card("cv-runpick", h("div", { className: "cv-runpick-row" }, h("span", { className: "cv-muted" }, "Earlier"), pick("A", "Earlier run"), h("span", { "aria-hidden": "true" }, "→"), h("span", { className: "cv-muted" }, "Later"), pick("B", "Later run")));
  const want = `${S.runA}|${S.runB}`;
  Promise.resolve(D.compareRuns ? D.compareRuns(S.runA, S.runB) : null).then((c) => {
    if (`${S.runA}|${S.runB}` !== want || !body.isConnected) return;
    body.replaceChildren();
    if (!c || !c.compared) { body.append(card("", empty("These two runs have no prompt answered on the same engine in both, so there is nothing to set side by side."))); return; }
    body.append(h("div", { className: "cv-tiles" },
      tile("Compared", String(c.compared), "prompt × engine answered in both"),
      tile("Better for you", String(c.summary.better), "placed higher, or newly named"),
      tile("Worse for you", String(c.summary.worse), "placed lower, or dropped"),
      tile("First place changed", String(c.summary.firstChanged), "a different brand named first")));
    const bt = h("div", { className: "cv-table cv-runbrands", role: "table", "aria-label": "Brands in each run" });
    bt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Brand", "Visibility", "", "Change", "Avg place", ""].map((x) => h("span", { role: "columnheader" }, x))));
    c.brands.forEach((b) => {
      const sign = b.dVisibility > 0 ? "up" : b.dVisibility < 0 ? "down" : "";
      bt.append(h("div", { className: "cv-tr", role: "row" },
        h("span", { role: "cell", className: "cv-who" }, brandMark(b.name, "s"), b.name, b.isOwn ? youBadge() : ""),
        h("span", { role: "cell", className: "cv-num" }, `${b.a.visibility}% → ${b.b.visibility}%`),
        h("span", { role: "cell" }, bar(b.b.visibility, b.isOwn ? "var(--you)" : "")),
        h("span", { role: "cell", className: `cv-num cv-delta ${sign}` }, `${b.dVisibility > 0 ? "+" : ""}${b.dVisibility} pts`),
        h("span", { role: "cell", className: "cv-num" }, `${b.a.avgPos ?? "—"} → ${b.b.avgPos ?? "—"}`),
        h("span", { role: "cell", className: "cv-muted" }, b.dPos == null ? "" : b.dPos < 0 ? "higher" : b.dPos > 0 ? "lower" : "same")));
    });
    body.append(card("", h("h4", { className: "cv-h4" }, "Brands", h("span", { className: "cv-sub" }, "on the prompts both runs answered")), h("div", { className: "cv-scroll" }, bt)));
    const filt = S.runRows || "changed";
    const rows = c.rows.filter((r) => filt === "all" || r.change !== "same" || r.firstChanged || r.gained.length || r.lost.length);
    const pg = paged("runrows", rows, 12, () => replace("cv-runs", runsSec));
    const pt = h("div", { className: "cv-table cv-runrows", role: "table", "aria-label": "Prompts in each run" });
    pt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Prompt", "Engine", "You", "Named first", "Came in / dropped"].map((x) => h("span", { role: "columnheader" }, x))));
    pg.rows.forEach((r) => pt.append(h("div", { className: `cv-tr cv-run-${r.change}`, role: "row" },
      h("span", { role: "cell" }, promptLink(r.prompt, r.b.captureId)),
      h("span", { role: "cell", className: "cv-who" }, engineMark(r.engine, "s"), ENG[r.engine] || r.engine),
      h("span", { role: "cell", className: "cv-num" }, `${posText(r.a.pos)} → ${posText(r.b.pos)}`),
      h("span", { role: "cell" }, r.firstChanged ? `${r.a.first || "—"} → ${r.b.first || "—"}` : (r.b.first || "—")),
      h("span", { role: "cell" }, ...r.gained.map((n) => h("span", { className: "cv-badge good" }, `+ ${n}`)), ...r.lost.map((n) => h("span", { className: "cv-badge bad" }, `− ${n}`))))));
    body.append(card("", h("div", { className: "cv-head-row" }, h("h4", { className: "cv-h4" }, "Prompt by prompt"),
      chips("Show", [["changed", "What changed"], ["all", "All"]], filt, (id) => { S.runRows = id; S.pg.runrows = 0; replace("cv-runs", runsSec); })),
      rows.length ? h("div", { className: "cv-scroll" }, pt) : empty("Nothing changed between these runs."), pg.pager));
    if (c.sites.length) {
      const st = h("div", { className: "cv-table cv-runsites", role: "table", "aria-label": "Sites cited in each run" });
      st.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Site", "Earlier", "Later", "Change"].map((x) => h("span", { role: "columnheader" }, x))));
      c.sites.slice(0, 12).forEach((x) => st.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell" }, x.domain), h("span", { role: "cell", className: "cv-num" }, String(x.a)), h("span", { role: "cell", className: "cv-num" }, String(x.b)), h("span", { role: "cell", className: `cv-num cv-delta ${x.d > 0 ? "up" : x.d < 0 ? "down" : ""}` }, `${x.d > 0 ? "+" : ""}${x.d}`))));
      body.append(card("", h("h4", { className: "cv-h4" }, "Sites cited", h("span", { className: "cv-sub" }, "answers citing each")), h("div", { className: "cv-scroll" }, st)));
    }
    if (c.onlyA || c.onlyB) body.append(h("p", { className: "cv-muted small" }, `Left out: ${c.onlyA} answer${c.onlyA === 1 ? "" : "s"} only in the earlier run, ${c.onlyB} only in the later one (another engine or prompt).`));
  }).catch(() => { body.replaceChildren(card("", empty("Couldn't compare these runs."))); });
  return section("cv-runs", "Run vs run", "the same prompts on the same engine, two runs side by side", head, body);
}

/* ---------- the board ---------- */

// One section at a time behind a row of tabs (0.67.0). Asked for: "why is
// all the things in one infinite scroll … FIX the campaign layout"; the
// section links had sat in the app bar, where they wrapped.
export const CV_SECTIONS = [
  ["cv-overview", "Overview"], ["cv-brands", "Brands"], ["cv-compare", "Compare"], ["cv-sources", "Sources"], ["cv-citations", "Citations"],
  ["cv-prompts", "Prompts"], ["cv-runs", "Run vs run"], ["cv-products", "Products & topics"], ["cv-searches", "Searches & ads"], ["cv-signals", "Signals & data"],
];
const SECTION_FN = {
  "cv-overview": () => overviewSec(), "cv-brands": () => brandsSec(), "cv-compare": () => compareSec(), "cv-sources": () => sourcesSec(SRC_DRILL),
  "cv-citations": () => citationsSec(), "cv-prompts": () => promptsSec(), "cv-products": () => productsSec(), "cv-searches": () => searchesSec(), "cv-signals": () => signalsSec(RUN_HISTORY), "cv-runs": () => runsSec(),
};
/** The count shown on each tab. */
export function sectionCounts(v) {
  return { "cv-brands": v.brands.all.length, "cv-sources": v.sources.sites, "cv-citations": v.citations.total, "cv-prompts": v.prompts.length, "cv-searches": v.searches.total };
}
let SRC_DRILL = null, RUN_HISTORY = null, PANEL = null, TABS = null, restoredTab = false;

function tabBar() {
  const counts = sectionCounts(V);
  const bar = h("div", { className: "cv-tabs", role: "tablist", "aria-label": "Sections", "aria-orientation": document.body.classList.contains("tab") ? "vertical" : "horizontal", });
  CV_SECTIONS.forEach(([id, label]) => {
    const on = id === S.section;
    const b = h("button", { type: "button", role: "tab", className: `cv-tab${on ? " on" : ""}`, id: `${id}-tab`, "aria-selected": on ? "true" : "false", "aria-controls": "cvPanel", tabIndex: on ? 0 : -1, "data-section": id }, label);
    if (counts[id] != null) b.append(h("span", { className: "cv-cnt" }, String(counts[id])));
    b.onclick = () => goSection(id);
    bar.append(b);
  });
  // Arrow keys move between tabs, as a tab list does.
  bar.onkeydown = (e) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = CV_SECTIONS.findIndex(([id]) => id === S.section);
    const n = e.key === "Home" ? 0 : e.key === "End" ? CV_SECTIONS.length - 1 : (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + CV_SECTIONS.length) % CV_SECTIONS.length;
    goSection(CV_SECTIONS[n][0]);
    document.getElementById(`${CV_SECTIONS[n][0]}-tab`)?.focus();
  };
  // The open section's tab in sight (1.0.4). The bar is rebuilt on every
  // pick and starts scrolled to the left, so in the popup picking a tab past
  // the edge hid it again, and a board reopened on "Signals" showed no tab
  // as open. Only the bar scrolls, never the page.
  requestAnimationFrame(() => {
    const on = bar.querySelector(".cv-tab.on");
    if (!on || bar.scrollWidth <= bar.clientWidth) return;
    const left = on.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
    bar.scrollLeft = Math.max(0, left - (bar.clientWidth - on.offsetWidth) / 2);
  });
  return bar;
}

/** Shows one section; the page above it (header, filters, tabs) stays put. */
export function goSection(id) {
  if (!SECTION_FN[id] || !PANEL) return;
  const changed = S.section !== id;
  S.section = id;
  try { localStorage.setItem("cito-cv-section", id); } catch (_) { /* this view only */ }
  const tabs = tabBar();
  TABS.replaceWith(tabs);
  TABS = tabs;
  PANEL.replaceChildren(SECTION_FN[id]());
  PANEL.setAttribute("aria-labelledby", `${id}-tab`);
  // A new section starts at its top, with the tabs still in sight (in the
  // side menu, the page goes back to the section's top).
  if (changed && TABS.closest(".cv-layout")) { const top = PANEL.getBoundingClientRect().top; if (top < 0) PANEL.scrollIntoView({ block: "start" }); }
  else if (changed) {
    const top = TABS.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) TABS.scrollIntoView({ block: "start" });
  }
}

export function renderCampaignView(box, view, deps, { sourcesDrill, runHistory } = {}) {
  D = deps; V = view; SRC_DRILL = sourcesDrill || null; RUN_HISTORY = runHistory || null;
  if (!S.section || !SECTION_FN[S.section]) S.section = "cv-overview";
  // The tab last open, once per page load; after that S remembers it.
  if (!restoredTab) { restoredTab = true; try { const saved = localStorage.getItem("cito-cv-section"); if (saved && SECTION_FN[saved]) S.section = saved; } catch (_) { /* default */ } }
  TABS = tabBar();
  PANEL = h("div", { className: "cv-panel", id: "cvPanel", role: "tabpanel", "aria-labelledby": `${S.section}-tab` }, SECTION_FN[S.section]());
  // The full tab lists the sections down the side of the results (1.0.6),
  // left or right; the popup keeps them in a row above.
  if (document.body.classList.contains("tab")) box.append(h("div", { className: "cv-layout" }, TABS, PANEL));
  else box.append(TABS, PANEL);
}
