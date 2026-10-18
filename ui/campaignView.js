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

let D = null;           // { el, engineIcon, openCapture, openDomain, openFullCompare, runHistory }
let V = null;           // the view (src/lib/campaignView.js)
const S = { brandEng: "all", brandSort: "sov", rival: null, pf: "all", cq: "", ce: "all", ck: "All", ct: "All", cboth: false, cpage: 0, copen: -1, prf: "all", prt: "All", propen: -1 };
export function resetCampaignViewState() { Object.assign(S, { brandEng: "all", brandSort: "sov", rival: null, pf: "all", cq: "", ce: "all", ck: "All", ct: "All", cboth: false, cpage: 0, copen: -1, prf: "all", prt: "All", propen: -1 }); }

const ENG = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };
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
    b.append(text);
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
    b.append(text);
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
const KIND_COLOR = { "Your site": "var(--you)", "Review sites": "var(--kind-review)", "Retailers": "var(--kind-retail)", "Rival brand sites": "var(--kind-rival)", "Forums & social": "var(--kind-forum)", "Other": "var(--kind-other)" };
const empty = (text, icon) => h("div", { className: "cv-empty" }, icon || "", h("span", {}, text));
const tile = (label, value, sub, extra) => h("div", { className: "cv-tile" }, h("span", { className: "cv-tile-l" }, label), h("span", { className: "cv-tile-v" }, value), sub ? h("span", { className: "cv-tile-s" }, sub) : "", extra || "");
function replace(id, fn) { const old = document.getElementById(id); if (old) old.replaceWith(fn()); }

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
    kpis.append(card("cv-kpi",
      h("div", { className: "cv-kpi-top" }, h("span", { className: "cv-kpi-l", ...(TERM[k.id] ? { "data-term": TERM[k.id] } : {}) }, k.label), k.rank ? h("span", { className: "cv-badge", title: `${ord(k.rank)} of ${k.of} brands` }, `${ord(k.rank)} of ${k.of}`) : h("span", { className: "cv-badge" }, `of ${k.of}`)),
      h("div", { className: "cv-kpi-v" }, k.value == null ? "—" : String(k.value), h("span", { className: "cv-kpi-u" }, k.id === "responses" ? ` / ${k.of}` : k.unit)),
      delta(k.id), rows));
  }
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
  return section("cv-overview", `${V.own} in this run`, `${o.answered} answers from ${o.sent} prompts sent`, notes, kpis,
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
  rows.forEach((r, i) => {
    const name = h("button", { type: "button", className: "cv-who cv-link cb-brand-btn", title: r.isOwn ? "" : `Compare ${r.name} with ${V.own}` }, brandMark(r.name), r.name);
    if (!r.isOwn) name.onclick = () => { S.rival = r.name; replace("cv-compare", compareSec); document.getElementById("cv-compare")?.scrollIntoView({ block: "start", behavior: "smooth" }); };
    // A brand found in the answers rather than typed in setup says so, and
    // can be left out (geo-brand-exclude), as on the board before 0.64.0.
    const who = h("span", { role: "cell", className: "cv-who" }, name, r.isOwn ? h("span", { className: "cv-badge you" }, "You") : "",
      r.auto ? h("span", { className: "cv-badge auto-tag", "data-term": "autoCompetitor" }, "found in answers") : "");
    if (r.auto && D.excludeBrand) {
      const x = h("button", { type: "button", className: "row-x", title: `Leave out ${r.name}`, "aria-label": `Leave out ${r.name}` }, "×");
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
  V.brands.grid.forEach((r) => grid.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, brandMark(r.name, "s"), r.name),
    ...[r.all, ...r.cells].map((x) => h("span", { role: "cell", className: `cv-cell${x == null ? " na" : ""}`, style: x == null ? "" : `--a:${(0.08 + x / 100 * 0.72).toFixed(2)}` }, x == null ? "—" : pct(x))))));
  return section("cv-brands", "Brands", `${rows.length} brands over ${answers} answers`, tools,
    list ? card("", h("div", { className: "cv-scroll" }, t)) : empty("No answers from this engine."),
    card("", h("h4", { className: "cv-h4" }, "Visibility, brand by engine"), h("div", { className: "cv-scroll" }, grid)));
}

/* ---------- 3. You vs rival ---------- */

function compareSec() {
  if (!V.rivals.length) return section("cv-compare", "You vs a rival", "", empty("No other brands in these answers yet."));
  if (!S.rival || !V.compare[S.rival]) S.rival = V.rivals[0];
  const c = V.compare[S.rival];
  const me = c.me, th = c.them;
  const picker = chips("Rival", V.rivals.map((n) => [n, n, null, brandMark(n, "s")]), S.rival, (n) => { S.rival = n; S.pf = "all"; replace("cv-compare", compareSec); });
  const M = [
    ["Share of voice", me.sov, th.sov, pct], ["Visibility", me.vis, th.vis, pct], ["Average position", me.pos, th.pos, num, true], ["Mentions", me.mentions, th.mentions, num],
    ["Named first", me.firsts, th.firsts, num], ["Product cards", me.cards, th.cards, num], ["First product card", me.firstCards, th.firstCards, num], ["In the engines’ searches", me.inQueries, th.inQueries, num],
  ];
  let mw = 0, tw = 0;
  const duel = h("div", { className: "cv-duel" });
  M.forEach(([label, a, b, f, low]) => {
    const A = a ?? (low ? 99 : 0), B = b ?? (low ? 99 : 0);
    const meBetter = low ? A < B : A > B, tie = A === B;
    if (!tie) meBetter ? mw++ : tw++;
    const w = (x) => (low ? (x >= 99 ? 4 : Math.min(A, B) / x * 100) : Math.max(A, B) ? x * 100 / Math.max(A, B) : 0);
    duel.append(h("div", { className: "cv-div" },
      h("span", { className: "l" }, h("span", { className: `cv-num${meBetter && !tie ? " win" : ""}` }, f(a)), h("i", { className: `me${meBetter || tie ? "" : " dim"}`, style: `width:${Math.max(3, w(A))}%` })),
      h("span", { className: "m" }, label),
      h("span", { className: "r" }, h("i", { className: `them${!meBetter || tie ? "" : " dim"}`, style: `width:${Math.max(3, w(B))}%` }), h("span", { className: `cv-num${!meBetter && !tie ? " win" : ""}` }, f(b)))));
  });
  const head = h("div", { className: "cv-vs" },
    h("div", { className: "cv-vs-side me" }, h("div", {}, h("b", {}, V.own), h("span", { className: "cv-muted" }, `ahead on ${mw} of ${M.length}`)), brandMark(V.own, "xl")),
    h("span", { className: "cv-vs-mid" }, "vs"),
    h("div", { className: "cv-vs-side" }, brandMark(S.rival, "xl"), h("div", {}, h("b", {}, S.rival), h("span", { className: "cv-muted" }, `ahead on ${tw} of ${M.length}`))));
  const tg = c.together;
  const [mb, ml] = mixBar([{ label: "Both named", n: tg.both, c: "var(--cv-ink)" }, { label: `Only ${V.own}`, n: tg.onlyMe, c: "var(--you)" }, { label: `Only ${S.rival}`, n: tg.onlyThem, c: "var(--cv-them)" }, { label: "Neither", n: tg.neither, c: "var(--cv-dim)" }]);
  const together = card("", h("h4", { className: "cv-h4" }, "Named in the same answers", h("span", { className: "cv-sub" }, `of ${tg.answers}`)), mb, ml,
    h("p", { className: "cv-line" }, h("span", { className: "cv-lgroup" }, brandMark(V.own, "s"), brandMark(S.rival, "s")), `When both are named, ${V.own} comes first in ${tg.meFirst} and ${S.rival} in ${tg.themFirst}.`));
  const eng = card("", h("h4", { className: "cv-h4" }, "Engine by engine"));
  c.engines.forEach((e) => {
    const row = h("div", { className: "cv-eng-duel" }, h("div", { className: "cv-who" }, engineMark(e.engine), ENG[e.engine], h("span", { className: "cv-muted" }, `${e.answers} answers`)));
    if (!e.me) row.append(h("span", { className: "cv-muted" }, "No answers"));
    else [["Share of voice", e.me.sov, e.them.sov, pct], ["Visibility", e.me.vis, e.them.vis, pct], ["Position", e.me.pos, e.them.pos, num, true]].forEach(([l, a, b, f, low]) => {
      const A = a ?? 0, B = b ?? 0, max = Math.max(A, B) || 1;
      const wa = low ? (A ? Math.min(A, B || A) / A * 100 : 0) : A * 100 / max, wb = low ? (B ? Math.min(A || B, B) / B * 100 : 0) : B * 100 / max;
      row.append(h("div", { className: "cv-div sm" }, h("span", { className: "l" }, h("span", { className: "cv-num" }, f(a)), h("i", { className: "me", style: `width:${Math.max(3, wa)}%` })), h("span", { className: "m" }, l), h("span", { className: "r" }, h("i", { className: "them", style: `width:${Math.max(3, wb)}%` }), h("span", { className: "cv-num" }, f(b)))));
    });
    eng.append(row);
  });
  const topics = card("", h("h4", { className: "cv-h4" }, "Topic by topic", h("span", { className: "cv-sub" }, "share of voice")));
  const tmax = Math.max(10, ...c.topics.flatMap((t) => [t.me ? t.me.sov : 0, t.them ? t.them.sov : 0]));
  c.topics.filter((t) => t.me && t.them).forEach((t) => {
    const a = t.me.sov, b = t.them ? t.them.sov : 0, sc = (x) => x * 100 / tmax, gap = Math.round((a - b) * 10) / 10;
    topics.append(h("div", { className: "cv-dumb" }, h("span", { className: "cv-ell" }, t.topic), h("span", { className: "cv-num cv-muted" }, String(t.answers)),
      h("span", { className: "cv-dumb-track" }, h("i", { className: "line", style: `left:${Math.min(sc(a), sc(b))}%;width:${Math.abs(sc(a) - sc(b))}%` }), h("i", { className: "dot them", style: `left:${sc(b)}%`, title: `${S.rival} ${pct(b)}` }), h("i", { className: "dot me", style: `left:${sc(a)}%`, title: `${V.own} ${pct(a)}` })),
      h("span", { className: `cv-badge ${gap >= 0 ? "good" : "bad"}` }, `${gap >= 0 ? "+" : ""}${gap} pts`)));
  });
  const lead = (x) => (x.me && (!x.them || x.me < x.them) ? "me" : x.them && (!x.me || x.them < x.me) ? "them" : "none");
  const P = c.prompts.map((p) => ({ ...p, leads: p.cells.filter((x) => x && !x.noAnswer).map(lead) }));
  const PF = [["all", "All", () => true], ["them", `${S.rival} ahead`, (p) => p.leads.includes("them")], ["only", `Only ${S.rival} named`, (p) => p.cells.some((x) => x && !x.noAnswer && x.them && !x.me)], ["me", `${V.own} ahead everywhere`, (p) => p.leads.length && p.leads.every((l) => l === "me")]];
  const prompts = card("", h("div", { className: "cv-tools" }, h("h4", { className: "cv-h4" }, "Prompt by prompt", h("span", { className: "cv-sub" }, `place in each answer, ${V.own} · ${S.rival}`)),
    chips("Show", PF.map(([id, l, f]) => [id, l, P.filter(f).length]), S.pf, (id) => { S.pf = id; replace("cv-compare", compareSec); })));
  const pt = h("div", { className: "cv-table cv-pduel", role: "table", "aria-label": "Prompt by prompt", style: `--n-eng:${V.engines.length}` });
  pt.append(h("div", { className: "cv-tr cv-th", role: "row" }, h("span", { role: "columnheader" }, "Prompt"), ...V.engines.map((e) => h("span", { role: "columnheader", className: "cv-who" }, engineMark(e, "s"), ENG[e]))));
  P.filter((PF.find((f) => f[0] === S.pf) || PF[0])[2]).forEach((p) => pt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-ell" }, p.text),
    ...p.cells.map((x, i) => {
      if (!x) return h("span", { role: "cell", className: "cv-pc na" }, "—");
      if (x.noAnswer) return h("span", { role: "cell", className: "cv-pc na" }, "no answer");
      const b = h("button", { type: "button", role: "cell", className: `cv-pc ${lead(x)}`, title: `Open this ${ENG[V.engines[i]]} answer` }, h("b", {}, x.me ? String(x.me) : "–"), " · ", x.them ? String(x.them) : "–");
      b.onclick = () => D.openCapture(x.captureId);
      return b;
    }))));
  prompts.append(h("div", { className: "cv-scroll" }, pt));
  const prodCol = (name, list) => h("div", { className: "cv-col" }, h("div", { className: "cv-who" }, brandMark(name), h("b", {}, name)),
    ...(list.length ? list.map((p) => h("div", { className: "cv-prod" }, h("span", { className: "cv-ell" }, p.name), h("span", { className: "cv-badge" }, `×${p.cards}`), p.first ? h("span", { className: "cv-badge gold" }, `1st ×${p.first}`) : "")) : [empty("No product cards")]));
  const quoteCol = (name, list) => h("div", { className: "cv-col" }, h("div", { className: "cv-who" }, brandMark(name), h("b", {}, name)),
    ...(list.length ? list.map((q) => h("figure", { className: "cv-quote" }, h("blockquote", {}, `…${q.text}…`), h("figcaption", { className: "cv-who" }, engineMark(q.engine, "s"), h("span", { className: "cv-ell" }, q.prompt)))) : [empty("No lines to quote")]));
  const full = h("button", { type: "button", className: "cv-link cv-more" }, `Full comparison with ${S.rival} ›`);
  full.onclick = () => D.openFullCompare(S.rival);
  return section("cv-compare", "You vs a rival", picker, card("cv-vs-card", head, duel), h("div", { className: "cv-grid2" }, together, eng), topics, prompts,
    h("div", { className: "cv-grid2" }, card("", h("h4", { className: "cv-h4" }, "Product cards"), h("div", { className: "cv-cols" }, prodCol(V.own, c.products.me), prodCol(S.rival, c.products.them))),
      card("", h("h4", { className: "cv-h4" }, "How the answers word it"), h("div", { className: "cv-cols" }, quoteCol(V.own, c.quotes.me), quoteCol(S.rival, c.quotes.them)))), full);
}

/* ---------- 4. Sources ---------- */

function sourcesSec(drill) {
  const s = V.sources;
  const tiles = h("div", { className: "cv-tiles" },
    tile("Citations", String(s.total), V.citations.byEngine.map((e) => `${ENG[e.engine]} ${e.n}`).join(" · "), h("span", { className: "cv-lgroup" }, ...V.engines.map((e) => engineMark(e, "s")))),
    tile("Sites cited", String(s.sites), s.domains.length ? `top 5 hold ${Math.round(s.domains.slice(0, 5).reduce((n, d) => n + d.citations, 0) * 100 / Math.max(1, s.total))}%` : ""),
    tile("Pages the engines read", String(s.read), "cited or not"),
    tile("Your own site", String(V.citations.ownSite), `of ${s.total} citations`, brandMark(V.own, "s")));
  const [kb, kl] = mixBar(V.citations.kinds.map((k) => ({ label: k.label, n: k.n, c: KIND_COLOR[k.label] || "var(--kind-other)" })));
  const dl = h("div", { className: "cv-table cv-doms", role: "table", "aria-label": "Most cited sites" });
  dl.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["#", "Site", "Kind", "Citations", "Answers citing it", "Cited by"].map((x) => h("span", { role: "columnheader" }, x))));
  const max = Math.max(1, ...s.domains.map((d) => d.citations));
  s.domains.slice(0, 15).forEach((d, i) => {
    const b = h("button", { type: "button", className: "cv-who cv-link", title: "Its pages and the prompts that cited them" }, siteMark(d.domain, "m"), h("span", { className: "cv-ell" }, d.domain));
    b.onclick = () => D.openDomain(d.domain);
    dl.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-num cv-muted" }, String(i + 1)), h("span", { role: "cell" }, b),
      h("span", { role: "cell" }, h("span", { className: "cv-pill" }, d.kind)),
      h("span", { role: "cell", className: "cv-barcell" }, bar(d.citations * 100 / max, "var(--cv-ink)"), h("span", { className: "cv-num" }, String(d.citations))),
      h("span", { role: "cell", className: "cv-num" }, `${d.answers} · ${pct(d.pct)}`), h("span", { role: "cell", className: "cv-lgroup" }, ...d.engines.map((e) => engineMark(e, "s")))));
  });
  const pages = card("", h("h4", { className: "cv-h4" }, "Most cited pages"));
  s.pages.slice(0, 10).forEach((p) => pages.append(h("div", { className: "cv-page" }, siteMark(p.domain, "m"), h("a", { href: p.url, target: "_blank", rel: "noopener", className: "cv-ell" }, p.title || p.url), h("span", { className: "cv-badge" }, `×${p.citations}`))));
  return section("cv-sources", "Sources", `${s.total} citations from ${s.sites} sites`, tiles, card("", h("h4", { className: "cv-h4" }, "Kinds of sites cited"), kb, kl),
    card("", h("h4", { className: "cv-h4" }, "Most cited sites"), h("div", { className: "cv-scroll" }, dl)), pages, drill || "");
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
    tile("Typical page age", C.medianAgeDays == null ? "—" : `${C.medianAgeDays} days`, "median of dated pages"), tile("Your own site", String(C.ownSite), `of ${C.total}`, brandMark(V.own, "s")));
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
  t.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Page", "Prompt", "Engine", "Source no.", "Search result", "Published", "In run", `${V.own} there`, ""].map((x) => h("span", { role: "columnheader" }, x))));
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
          kv("Named first", r.first || "no brand"), kv("Kind of answer", r.answerKind === "info" ? "Informational" : r.answerKind), go)));
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
    ...["Visibility", "Position", "Named first", `${V.own}'s card`, "Searches"].map((x) => h("span", { role: "columnheader" }, x))));
  shown.forEach((p) => {
    const open = S.propen === p.i;
    const cells = p.cells.map((c, i) => {
      if (!c) return h("span", { role: "cell", className: "cv-pc na" }, "—");
      if (!c.answered) return h("span", { role: "cell", className: "cv-pc na", title: c.limit ? "Usage limit reached" : "No answer" }, c.limit ? "limit" : "no answer");
      const b = h("button", { type: "button", role: "cell", className: `cv-pc ${c.pos === 1 ? "first" : c.pos ? (c.pos <= 3 ? "mid" : "low") : "out"}`, title: c.pos ? `${ord(c.pos)} · ${c.first} first · open the answer` : `Not named · ${c.first || "no brand"} first · open the answer` }, c.pos ? String(c.pos) : "✕");
      b.onclick = (ev) => { ev.stopPropagation(); D.openCapture(c.captureId); };
      return b;
    });
    const toggle = h("button", { type: "button", className: "cv-link cv-ell cv-ptext", "aria-expanded": open ? "true" : "false" }, h("span", { className: `cv-chev${open ? " open" : ""}`, "aria-hidden": "true" }, "›"), p.text);
    toggle.onclick = () => { S.propen = open ? -1 : p.i; redo(); };
    t.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell" }, toggle), h("span", { role: "cell" }, h("span", { className: "cv-pill" }, p.topic)), ...cells,
      h("span", { role: "cell", className: "cv-num" }, p.visibility == null ? "—" : pct(p.visibility)), h("span", { role: "cell", className: "cv-num" }, num(p.avgPos)),
      h("span", { role: "cell", className: "cv-lgroup" }, ...p.firsts.map((n) => brandMark(n, "s"))), h("span", { role: "cell", className: "cv-ell cv-muted" }, p.topProduct || "—"),
      h("span", { role: "cell", className: "cv-num cv-muted" }, String(p.queries.length))));
    if (open) t.append(h("div", { className: "cv-detail", role: "row" }, h("div", { className: "cv-stack" }, h("span", { className: "cv-muted" }, "Searches the engines ran for it"),
      ...(p.queries.length ? p.queries.map((x) => h("span", { className: "cv-who cv-mono" }, engineMark(x.engine, "s"), x.text)) : [h("span", { className: "cv-muted" }, "No searches were sent.")]))));
  });
  return section("cv-prompts", "Prompt rankings", `${V.own}'s place in each answer · ${P.length} prompts`,
    h("div", { className: "cv-tools" }, chips("Show", PF.map(([id, l, f]) => [id, l, P.filter(f).length]), S.prf, (id) => { S.prf = id; redo(); }), chips("Topic", [["All", "All topics"], ...topics.map((x) => [x, x])], S.prt, (id) => { S.prt = id; redo(); })),
    card("", h("div", { className: "cv-scroll" }, t), h("p", { className: "cv-legend cv-foot" }, h("span", { className: "cv-pc first" }, "1"), " named first ", h("span", { className: "cv-pc mid" }, "2"), " 2nd–3rd ", h("span", { className: "cv-pc low" }, "4"), " lower ", h("span", { className: "cv-pc out" }, "✕"), " not named")));
}

/* ---------- 7. Products & topics ---------- */

function productsSec() {
  const p = V.products;
  const pt = h("div", { className: "cv-table cv-prodt", role: "table", "aria-label": "Product cards" });
  pt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["#", "Product", "Cards · first card", "Brand"].map((x) => h("span", { role: "columnheader" }, x))));
  const max = Math.max(1, ...p.rows.map((x) => x.cards));
  p.rows.slice(0, 15).forEach((x, i) => pt.append(h("div", { className: `cv-tr${x.brand === V.own ? " you" : ""}`, role: "row" }, h("span", { role: "cell", className: "cv-num cv-muted" }, String(i + 1)),
    h("span", { role: "cell", className: "cv-ell" }, x.name),
    h("span", { role: "cell", className: "cv-barcell" }, h("span", { className: "cv-mix sm" }, h("i", { style: `width:${x.first * 100 / max}%;background:var(--you)` }), h("i", { style: `width:${(x.cards - x.first) * 100 / max}%;background:var(--you-soft)` })), h("span", { className: "cv-num" }, `${x.cards} · ${x.first}`)),
    h("span", { role: "cell", className: "cv-who" }, x.brand ? brandMark(x.brand, "s") : "", x.brand || "—"))));
  const share = card("", h("h4", { className: "cv-h4" }, "Card share by brand", h("span", { className: "cv-sub" }, `of ${p.total} cards`)));
  p.share.forEach((x) => share.append(h("div", { className: `cv-bl${x.isOwn ? " you" : ""}` }, brandMark(x.name, "s"), h("span", { className: "cv-ell" }, x.name), bar(x.pct, x.isOwn ? "var(--you)" : "var(--cv-dim)"), h("span", { className: "cv-num" }, pct(x.pct)), h("span", { className: "cv-num cv-muted" }, `${x.first} first`))));
  const tt = h("div", { className: "cv-table cv-topics", role: "table", "aria-label": "Topics" });
  tt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Topic", "Prompts · answers", `${V.own}: share · visibility`, "Strongest rival", ""].map((x) => h("span", { role: "columnheader" }, x))));
  V.topics.forEach((x) => {
    const ahead = !x.rival || (x.own && x.own.sov >= x.rival.sov);
    tt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-strong" }, x.topic), h("span", { role: "cell", className: "cv-num cv-muted" }, `${x.prompts} · ${x.answers}`),
      h("span", { role: "cell", className: "cv-barcell" }, bar(x.own ? x.own.sov * 1.5 : 0, "var(--you)"), h("span", { className: "cv-num" }, x.own ? `${pct(x.own.sov)} · ${pct(x.own.vis)}` : "—")),
      h("span", { role: "cell", className: "cv-who" }, x.rival ? brandMark(x.rival.name, "s") : "", x.rival ? `${x.rival.name} ${pct(x.rival.sov)}` : "—"),
      h("span", { role: "cell" }, h("span", { className: `cv-badge ${ahead ? "good" : "bad"}` }, ahead ? `${V.own} ahead` : `${x.rival.name} ahead`))));
  });
  return section("cv-products", "Products & topics", p.total ? `${p.total} product cards in ${p.answersWithCards} answers` : "",
    p.total ? h("div", { className: "cv-grid2" }, card("", h("h4", { className: "cv-h4" }, "Products shown as cards"), h("div", { className: "cv-scroll" }, pt)), share) : empty("No answer in this view showed product cards."),
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
  const ex = card("", h("h4", { className: "cv-h4" }, "Same prompt, each engine"), s.example ? h("p", { className: "cv-muted" }, `“${s.example.prompt}”`) : "");
  if (s.example) s.example.byEngine.forEach((x) => ex.append(h("div", { className: "cv-ex" }, engineMark(x.engine), h("div", { className: "cv-stack" }, ...x.queries.map((q) => h("span", { className: "cv-mono" }, q))))));
  else ex.append(empty("No prompt has searches from more than one engine."));
  const site = s.site;
  const sr = h("div", { className: "cv-stack" });
  site.rows.forEach((r) => sr.append(h("div", { className: "cv-site-row" }, engineMark(r.engine), h("div", { className: "cv-stack" }, h("span", { className: "cv-mono" }, r.text), h("span", { className: "cv-muted" }, `for “${r.prompt}”`)),
    h("div", { className: "cv-chips" }, ...r.include.map((d) => h("span", { className: "cv-pill cv-who" }, siteMark(d, "s"), d)), ...r.exclude.map((d) => h("span", { className: "cv-pill cv-who ex" }, siteMark(d, "s"), `not ${d}`)),
      r.laterCited == null ? h("span", { className: "cv-pill cv-muted" }, "no answer to check") : h("span", { className: `cv-pill ${r.laterCited.length ? "good" : ""}` }, r.laterCited.length ? `cited: ${r.laterCited.join(", ")}` : "none cited later")))));
  const siteCard = card("cv-site", h("div", { className: "cv-who" }, h("span", { className: "cv-op" }, "site:"), h("span", { className: "cv-stack" }, h("b", {}, "Searches limited to chosen sites"), h("span", { className: "cv-muted" }, "With site: in a search, the engine only looks inside the sites it names."))),
    h("div", { className: "cv-tiles" }, tile("site: searches", String(site.count), `of ${s.total}`), tile("Sites named", String(site.domains.length), site.domains.slice(0, 3).map((d) => d.domain).join(", ")),
      tile("Your site named", site.ownTargeted ? "Yes" : "0", site.ownTargeted ? "" : "never targeted")),
    site.rows.length ? sr : "",
    h("div", { className: "cv-grid3" }, ...site.byEngine.filter((e) => !e.n).map((e) => empty(e.engine === "gemini" && !e.of ? "Gemini doesn't publish its searches." : `${ENG[e.engine]} ran no site: searches in ${e.of}.`, engineMark(e.engine)))));
  const a = V.ads;
  const adsCard = card("cv-ads", h("div", { className: "cv-who" }, h("span", { className: "cv-op ad" }, "AD"), h("span", { className: "cv-stack" }, h("b", {}, "Ads shown with the answers"), h("span", { className: "cv-muted" }, "ChatGPT can show a sponsored card after an answer. The other engines have no ad format."))),
    h("div", { className: "cv-tiles" }, tile("Answers with an ad", `${a.withAd}/${a.answers}`), tile("Advertisers", String(a.advertisers.length)), tile("Your brand advertising", String(a.own)), tile("Rivals advertising", String(a.rival)),
      tile("Advertiser named in the answer", a.rows.length ? `${a.named}/${a.rows.length}` : "—"), tile("Advertiser’s site cited", a.rows.length ? `${a.cited}/${a.rows.length}` : "—")));
  if (!a.rows.length) adsCard.append(empty(a.answers ? `No ads in this run. None of ChatGPT's ${a.answers} answers carried one.` : "No ChatGPT answers in this view.", a.engines.length ? engineMark("chatgpt") : ""));
  else {
    const at = h("div", { className: "cv-table cv-adt", role: "table", "aria-label": "Ads" });
    at.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Advertiser", "Ad", "Prompt", "Named in answer", "Site cited", `${V.own} there`].map((x) => h("span", { role: "columnheader" }, x))));
    a.rows.forEach((x) => {
      const b = h("button", { type: "button", className: "cv-tr cv-rowbtn", role: "row", title: "Open the answer" }, h("span", { role: "cell", className: "cv-who" }, siteMark(x.domain || x.advertiser, "m"), x.advertiser),
        h("span", { role: "cell", className: "cv-stack" }, h("span", { className: "cv-ell cv-strong" }, x.title || x.label), h("span", { className: "cv-ell cv-muted" }, x.domain)),
        h("span", { role: "cell", className: "cv-ell" }, x.prompt), h("span", { role: "cell" }, h("span", { className: `cv-badge ${x.namedInAnswer ? "good" : ""}` }, x.namedInAnswer ? "Yes" : "No")),
        h("span", { role: "cell" }, h("span", { className: "cv-badge" }, x.siteCited ? "Yes" : "No")), h("span", { role: "cell", className: "cv-num" }, x.ownPlace ? ord(x.ownPlace) : "not named"));
      b.onclick = () => D.openCapture(x.captureId);
      at.append(b);
    });
    adsCard.append(h("div", { className: "cv-scroll" }, at));
  }
  return section("cv-searches", "Searches, site: and ads", `${s.total} searches across ${s.byEngine.filter((e) => e.published).length} engines`, eng, h("div", { className: "cv-grid2" }, brands, ex), siteCard, adsCard);
}

/* ---------- 9. Signals ---------- */

function signalsSec(runHistory) {
  const g = V.signals;
  const ag = card("", h("h4", { className: "cv-h4" }, "Engine agreement", h("span", { className: "cv-sub" }, "the same brand named first")),
    h("div", { className: "cv-big-row" }, h("span", { className: "cv-big" }, String(g.agreement.same)), h("span", { className: "cv-muted" }, ` of ${g.agreement.of} prompts`)), bar(g.agreement.of ? g.agreement.same * 100 / g.agreement.of : 0, "var(--cv-ink)"));
  g.agreement.differ.slice(0, 12).forEach((d) => ag.append(h("div", { className: "cv-differ" }, h("span", { className: "cv-ell" }, d.text), ...d.firsts.filter((f) => f.first).map((f) => h("span", { className: "cv-who" }, engineMark(f.engine, "s"), brandMark(f.first, "s"), f.first)))));
  const br = card("", h("h4", { className: "cv-h4" }, "Search breadth", h("span", { className: "cv-sub" }, "per answer")));
  const bt = h("div", { className: "cv-table cv-breadth", role: "table", "aria-label": "Search breadth" });
  bt.append(h("div", { className: "cv-tr cv-th", role: "row" }, ...["Engine", "Searches", "Pages read", "Pages cited"].map((x) => h("span", { role: "columnheader" }, x))));
  g.breadth.forEach((x) => bt.append(h("div", { className: "cv-tr", role: "row" }, h("span", { role: "cell", className: "cv-who" }, engineMark(x.engine), ENG[x.engine]), ...[["searches"], ["read"], ["cited"]].map(([k]) => h("span", { role: "cell", className: "cv-num" }, `${x[k]} (${x.totals[k]})`)))));
  br.append(bt);
  const KL = { shopping: "Shopping", info: "Informational", local: "Local", images: "Image-led", memory: "From memory" };
  const [kb, kl] = mixBar(g.kinds.map((k) => ({ label: KL[k.id] || k.id, n: k.n, c: `var(--ak-${k.id}, var(--kind-other))` })));
  const tiles = h("div", { className: "cv-tiles" },
    tile("Your own site", `${g.ownSite.citations}`, `of ${g.ownSite.of} citations`, brandMark(V.own, "s")),
    tile("Coverage gaps", String(g.gaps.length), "answers without you that name two or more rivals"),
    tile("First product card", `${g.firstCard.own}`, `of ${g.firstCard.of} answers with cards`));
  const gaps = g.gaps.length ? card("", h("h4", { className: "cv-h4" }, "Prompts with a gap"), ...g.gaps.map((x) => h("div", { className: "cv-differ" }, h("span", { className: "cv-ell" }, x.text)))) : "";
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
  return section("cv-signals", "Signals and data quality", "", h("div", { className: "cv-grid2" }, ag, h("div", { className: "cv-stack gap" }, br, card("", h("h4", { className: "cv-h4" }, "Kinds of answer"), kb, kl))), tiles, gaps,
    card("", h("h4", { className: "cv-h4" }, "Data quality"), h("div", { className: "cv-scroll" }, qt)), runHistory ? card("", runHistory) : "");
}

/* ---------- the board ---------- */

export const CV_SECTIONS = [
  ["cv-overview", "Overview"], ["cv-brands", "Brands"], ["cv-compare", "You vs rival"], ["cv-sources", "Sources"], ["cv-citations", "Citations"],
  ["cv-prompts", "Prompts"], ["cv-products", "Products & topics"], ["cv-searches", "Searches, site: & ads"], ["cv-signals", "Signals"],
];
/** The count shown on each section link. */
export function sectionCounts(v) {
  return { "cv-brands": v.brands.all.length, "cv-sources": v.sources.sites, "cv-citations": v.citations.total, "cv-prompts": v.prompts.length, "cv-searches": v.searches.total };
}

export function renderCampaignView(box, view, deps, { sourcesDrill, runHistory } = {}) {
  D = deps; V = view;
  box.append(overviewSec(), brandsSec(), compareSec(), sourcesSec(sourcesDrill), citationsSec(), promptsSec(), productsSec(), searchesSec(), signalsSec(runHistory));
}
