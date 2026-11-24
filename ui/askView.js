/*
 * askView.js — the Ask tab (0.73.0): questions about your own captures,
 * answered by the built-in AI on this computer (src/lib/assistant.js).
 *
 * The conversation is kept in this browser (chrome.storage.local
 * "lcfcAsk", the last 40 messages). Each answer lists what it looked up
 * and links the captures it used; they open in Analyze.
 */
import { tr } from "./i18n.js";
import { handoffButton } from "./handoff.js";
import { askParts, campaignParts } from "../src/lib/contextPack.js";
import { mountModelSwitches } from "./modelSwitches.js";

const KEY = "lcfcAsk";
let stepListener = null; // the one live "ask-step" listener (renderAsk replaces it)
const MAX = 40;
const SUGGEST = [
  "How visible is my brand in my latest campaign?",
  "Which sites are cited most?",
  "Compare my brand with its closest rival",
  "Which answers named a rival first this week?",
];

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("data-") || k.startsWith("aria-") || k === "for" || k === "role") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of kids) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(tr(String(c))));
  return n;
}
const send = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x || null); }); } catch (_) { r(null); } });
const load = async () => { try { return (await chrome.storage.local.get(KEY))[KEY] || []; } catch (_) { return []; } };
const save = async (msgs) => { try { await chrome.storage.local.set({ [KEY]: msgs.slice(-MAX) }); } catch (_) { /* this session only */ } };
const ENGINE = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok", aimode: "AI Mode" };

/**
 * @param {HTMLElement} root  the #ask section
 * @param {{openCapture: (id: string) => void, openSettings: () => void}} hooks
 */
let renderGen = 0;
export async function renderAsk(root, hooks = {}) {
  if (!root) return;
  // Only the latest call draws (0.84.0): two that overlap (a model coming
  // on fires both its poll and the "ai-state" broadcast) drew Ask twice.
  const gen = ++renderGen;
  const st = await send({ type: "ai-status" });
  let msgs = await load();
  if (gen !== renderGen) return;
  root.replaceChildren();
  const wrap = h("div", { className: "ask" });
  root.append(wrap);
  wrap.append(h("div", { className: "card ask-head" },
    h("h2", { className: "ask-title" }, "Ask about your captures"),
    h("p", { className: "ask-sub" }, "Questions about your campaigns and the answers you captured, answered by the built-in AI on this computer. It looks the numbers up rather than guessing, and links the answers it used. Nothing is sent anywhere.")));

  // Another AI, with this campaign's data and the question (0.76.0): works
  // with or without the built-in AI.
  const campaignPack = async () => {
    const r = await send({ type: "campaign-insights" });
    return r && r.ok ? campaignParts(r.insights) : [];
  };

  // The models, as switches, right here (0.84.0; asked: "the model
  // download needs to be in the Ask section only, otherwise the new users
  // will never know about it"). Open when Ask can't answer yet; folded
  // away under "Models" once it can. Ask redraws when one becomes ready.
  const ready = !!(st && st.ready);
  const models = h("details", { className: "card ask-models", id: "askModels", open: !ready },
    h("summary", {}, h("b", {}, "Models on this computer"), h("span", { className: "ask-models-sum" }, ready ? (st.engine ? `Ask uses ${st.engine.label}` : "") : "Turn one on to ask questions here")));
  const slot = h("div", {});
  models.append(slot);
  let redrawn = false;
  mountModelSwitches(slot, { compact: true, onChange: (s) => { if (!redrawn && s && !!s.ready !== ready && root.isConnected) { redrawn = true; renderAsk(root, hooks); } } });

  // 1.0.5: Ask answers from your data with or without a model (the numbers
  // come from the boards' own code, the reply from a template); a model on
  // this computer writes the reply in your words and your language.
  if (!ready) slot.before(h("p", { className: "ask-off-note", id: "askOffNote" }, "Ask already answers from your data. Turn on “Ask's AI model” below (a one-time download) for replies in your own words and language."));
  wrap.append(models);
  // The collections a scope chip can switch to.
  const profs = await send({ type: "geo-profile-list" });
  if (gen !== renderGen) return;
  const collections = [...((profs && profs.profiles) || []).map((p) => ({ id: p.id, name: p.name })), { id: "history", name: "My questions" }];

  // A chat (0.78.0, asked: "the Ask UI is not quite like a chat
  // interface"): the conversation fills the page, the box to type in stays
  // at the bottom, each message is a bubble with who said it and when, and
  // while it works a bubble says what it's looking up.
  wrap.classList.add("ask-chat");
  const log = h("div", { className: "ask-log", id: "askLog", role: "log", "aria-live": "polite" });
  const when = (t) => { try { return t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; } catch (_) { return ""; } };
  const meta = (who, t) => h("div", { className: "ask-meta" }, h("b", {}, who), t ? h("span", {}, when(t)) : "");
  const drawMsg = (m) => {
    if (m.role === "user") return h("div", { className: "ask-msg you" }, meta(tr("You"), m.at), h("div", { className: "ask-text", dir: "auto" }, m.content));
    const box = h("div", { className: "ask-msg ai" }, meta("CitoSkeleton", m.at));
    // What the answer is about, as chips that can be changed (1.0.5): a
    // change runs the same question on the new scope, with no model asked.
    if (m.scope && m.plan) box.append(scopeChips(m));
    box.append(h("div", { className: "ask-text", dir: "auto" }, ...mdNodes(m.content)));
    // Asked back (1.0.5): the question could mean several campaigns.
    if (m.askBack && m.plan) {
      const row = h("div", { className: "ask-choices", role: "group", "aria-label": tr("Choose one") });
      m.askBack.choices.forEach((c) => {
        const b = h("button", { type: "button", className: "db-chip ask-choice" }, c.label);
        b.onclick = () => rerun(m, { ...m.plan, scope: { ...m.plan.scope, collections: c.collections }, by: c.collections.length > 1 && m.plan.by === "none" ? "collection" : m.plan.by });
        row.append(b);
      });
      box.append(row);
    }
    if (m.notes && m.notes.length) box.append(h("div", { className: "ask-notes", role: "note" }, ...m.notes.map((x) => h("div", {}, x))));
    // Numbers in the reply that no lookup returned (0.75.0): flagged, not trusted.
    if (m.unverified && m.unverified.length) box.append(h("div", { className: "ask-unverified", role: "note" }, `${tr("Not in your data — check these numbers")}: `, m.unverified.join(", ")));
    if (m.steps && m.steps.length) box.append(h("div", { className: "ask-steps x-only" }, `${tr("Looked up")}: `, m.steps.map((s) => `${s.tool}${s.ok ? "" : " ✗"}`).join(", ")));
    if (m.refs && m.refs.length) {
      const refs = h("div", { className: "ask-refs" }, h("span", { className: "ask-refs-l" }, "From these answers"));
      m.refs.slice(0, 8).forEach((r) => {
        const a = h("button", { type: "button", className: "ask-ref", title: r.prompt }, `${ENGINE[r.engine] || r.engine} · ${r.prompt}`);
        a.onclick = () => hooks.openCapture && hooks.openCapture(r.id);
        refs.append(a);
      });
      box.append(refs);
    }
    // Take this reply, what it looked up and the question to another AI.
    if (m.lookups || m.steps) {
      const at = msgs.indexOf(m);
      const question = at > 0 && msgs[at - 1].role === "user" ? msgs[at - 1].content : "";
      box.append(h("div", { className: "ask-ho" }, handoffButton({ getParts: () => askParts({ question, answer: m.content, steps: m.steps || [], results: (m.lookups || []).map((x) => { try { return JSON.parse(x); } catch (_) { return x; } }) }), question: () => question, task: "custom", file: "citoskeleton-ask.md" })));
    }
    return box;
  };
  const typing = h("div", { className: "ask-typing", id: "askTyping", role: "status", hidden: true },
    h("span", { className: "ask-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { className: "ask-typing-t" }, tr("Thinking…")));
  const sug = h("div", { className: "ask-suggest" });
  SUGGEST.forEach((q) => { const b = h("button", { type: "button", className: "db-chip ask-chip" }, q); b.onclick = () => { input.value = tr(q); go(); }; sug.append(b); });
  const empty = h("div", { className: "ask-empty-chat" }, h("p", { className: "ask-hint" }, "Ask about your campaigns, brands, sites or answers. Try one of these:"), sug);
  const redraw = () => {
    // Suggestions only on an empty chat.
    log.replaceChildren(...(msgs.length ? msgs.map(drawMsg) : [empty]), typing);
    log.scrollTop = log.scrollHeight;
  };
  const input = h("textarea", { id: "askInput", className: "ask-input", rows: 1, placeholder: tr("Ask about your campaigns, brands, sites or answers…"), dir: "auto", "aria-label": tr("Your question") });
  // The box grows with what's typed, up to a few lines.
  const grow = () => { input.style.height = "auto"; input.style.height = `${Math.min(160, input.scrollHeight)}px`; };
  input.oninput = grow;
  const btn = h("button", { type: "button", className: "btn primary", id: "askSend", "aria-label": tr("Send") }, "Ask");
  const clear = h("button", { type: "button", className: "btn sm ghost", id: "askClear" }, "New chat");
  const status = h("span", { className: "ask-status", id: "askStatus", role: "status" });
  let askId = 0;
  // What it's looking up, as each lookup starts (background "ask-step").
  const onStep = (m) => {
    if (!m || m.type !== "ask-step" || m.askId !== `a${askId}` || typing.hidden) return;
    typing.querySelector(".ask-typing-t").textContent = stepText(m.tool);
  };
  try {
    if (stepListener) chrome.runtime.onMessage.removeListener(stepListener);
    stepListener = onStep;
    chrome.runtime.onMessage.addListener(onStep);
  } catch (_) { /* no runtime in a test page */ }
  // The last answer's plan: a follow-up ("and on Gemini?") keeps its scope.
  const lastPlan = () => { for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m.role === "assistant" && m.plan && m.scope) return m.plan; } return null; };
  const ask = async (q, extra = {}) => {
    btn.disabled = true;
    typing.hidden = false;
    typing.querySelector(".ask-typing-t").textContent = tr("Thinking…");
    log.scrollTop = log.scrollHeight;
    status.textContent = "";
    askId++;
    let context = {};
    try { context = (hooks.context && hooks.context()) || {}; } catch (_) { /* no page context */ }
    const r = await send({ type: "ask", question: q, askId: `a${askId}`, context, previous: lastPlan(), ...extra });
    btn.disabled = false;
    typing.hidden = true;
    status.textContent = r && r.ok ? (r.ms ? `${(r.ms / 1000).toFixed(1)} s` : "") : "";
    msgs.push(r && r.ok
      ? { role: "assistant", content: r.answer, steps: r.steps, refs: r.refs, unverified: r.unverified || [], lookups: r.lookups || [], plan: r.plan || null, scope: r.scope || null, askBack: r.askBack || null, notes: r.notes || [], question: q, at: Date.now() }
      : { role: "assistant", content: `${tr("That didn't work")}: ${(r && r.error) || "no reply"}`, at: Date.now() });
    await save(msgs);
    redraw();
    input.focus();
  };
  const go = async () => {
    const q = input.value.trim();
    if (!q || btn.disabled) return;
    input.value = "";
    grow();
    msgs.push({ role: "user", content: q, at: Date.now() });
    redraw();
    await ask(q);
  };
  // The same question on a changed plan (a chip, an ask-back choice).
  function rerun(m, plan) {
    if (btn.disabled) return;
    const q = m.question || (() => { const at = msgs.indexOf(m); return at > 0 && msgs[at - 1].role === "user" ? msgs[at - 1].content : ""; })();
    ask(q, { plan });
  }
  function scopeChips(m) {
    const row = h("div", { className: "ask-scope", role: "group", "aria-label": tr("What this answer is about") });
    const ENG = ["chatgpt", "gemini", "perplexity", "grok", "aimode"];
    for (const c of m.scope.chips || []) {
      let opts = null;
      if (c.kind === "collection") opts = [...collections.map((x) => ({ label: x.name, value: JSON.stringify([x.id]) })), ...(collections.length > 2 ? [{ label: tr("All campaigns"), value: JSON.stringify(collections.filter((x) => x.id !== "history").map((x) => x.id)) }] : [])];
      if (c.kind === "runs") opts = [{ label: tr("latest run"), value: "latest" }, { label: tr("all runs"), value: "all" }];
      if (c.kind === "engines") opts = [{ label: tr("all engines"), value: "[]" }, ...ENG.map((e) => ({ label: ENGINE[e], value: JSON.stringify([e]) }))];
      if (!opts) {
        // Tags, prompts, signed in: a chip to take off.
        const b = h("button", { type: "button", className: "ask-scope-chip", title: tr("Remove") }, c.label, h("span", { "aria-hidden": "true" }, " ×"));
        b.onclick = () => rerun(m, { ...m.plan, scope: { ...m.plan.scope, [c.kind]: c.kind === "signedIn" ? null : [] } });
        row.append(b);
        continue;
      }
      const sel = h("select", { className: "ask-scope-chip", "aria-label": tr(c.kind === "collection" ? "Campaign" : c.kind === "runs" ? "Runs" : "Engines") });
      const cur = c.kind === "runs" ? String(c.value) : JSON.stringify(c.value);
      if (!opts.some((o) => o.value === cur)) opts.unshift({ label: c.label, value: cur });
      for (const o of opts) { const op = h("option", { value: o.value }, o.label); if (o.value === cur) op.selected = true; sel.append(op); }
      sel.onchange = () => {
        const v = sel.value;
        const scope = { ...m.plan.scope };
        if (c.kind === "runs") { scope.runs = v; if (v === "latest") scope.dates = null; }
        else scope[c.kind === "collection" ? "collections" : "engines"] = JSON.parse(v);
        rerun(m, { ...m.plan, scope, by: c.kind === "collection" && scope.collections.length > 1 && m.plan.by === "none" ? "collection" : m.plan.by });
      };
      row.append(sel);
    }
    if (m.scope.answers != null) row.append(h("span", { className: "ask-scope-n" }, `${m.scope.answers} ${tr("answers")}`));
    return row;
  }
  btn.onclick = go;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } };
  clear.onclick = async () => { msgs = []; await save(msgs); redraw(); input.focus(); };
  // The question being typed, with the campaign's data, to another AI.
  const ho = handoffButton({ id: "askHandoff", getParts: campaignPack, question: () => input.value, file: "citoskeleton-campaign.md" });
  wrap.append(log, h("div", { className: "ask-form" }, h("div", { className: "ask-row" }, input, btn), h("div", { className: "ask-foot" }, status, ho, clear)));
  redraw();
}

/* What a lookup is, in words, while it runs. */
const STEP_WORDS = {
  campaign_overview: "Looking up the campaign's numbers…", campaign_metrics: "Looking up the campaign's numbers…",
  prompts_where_absent: "Finding the prompts you're missing from…", prompts_behind: "Finding where a rival comes first…",
  rival_wins: "Looking at where each rival wins…", source_gaps: "Comparing the sites cited for you and your rivals…",
  own_site_share: "Counting your own site's citations…", topic_breakdown: "Looking at topics…",
  engine_compare: "Comparing the engines…", engine_disagreement: "Finding where the engines disagree…",
  products_named: "Looking at the products named…", fanout_searches: "Reading the engines' own searches…",
  ads_seen: "Looking at the ads shown…", data_quality: "Checking for gaps in the data…", glossary: "Looking up a definition…",
  query_answers: "Searching your answers…", get_answer: "Reading an answer…", compare_brands: "Comparing brands…",
  top_sources: "Counting the sites cited…", brand_trend: "Looking at the trend across runs…", list_campaigns: "Listing your campaigns…",
};
export function stepText(tool) {
  if (/^plan:/.test(String(tool || ""))) return tr("Working out the numbers from your data…");
  return tr(STEP_WORDS[tool] || `Looking up ${String(tool || "").replace(/_/g, " ")}…`);
}

/* A reply's light markdown — paragraphs, - and 1. lists, **bold**, `code`
 * and links — as DOM nodes, never parsed HTML (the reply is model text). */
export function mdNodes(text) {
  const out = [];
  const inline = (line) => {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) frag.append(line.slice(last, m.index));
      const t = m[0];
      if (t.startsWith("**")) { const b = document.createElement("b"); b.textContent = t.slice(2, -2); frag.append(b); }
      else if (t.startsWith("`")) { const c = document.createElement("code"); c.textContent = t.slice(1, -1); frag.append(c); }
      else { const a = document.createElement("a"); a.href = t; a.textContent = t; a.target = "_blank"; a.rel = "noopener noreferrer"; frag.append(a); }
      last = m.index + t.length;
    }
    if (last < line.length) frag.append(line.slice(last));
    return frag;
  };
  let list = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /^\s*\d/.test(line);
      if (!list || list.tagName !== (ordered ? "OL" : "UL")) { list = document.createElement(ordered ? "ol" : "ul"); out.push(list); }
      const item = document.createElement("li"); item.append(inline(li[1])); list.append(item);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const head = /^#{1,4}\s+(.*)$/.exec(line);
    const p = document.createElement(head ? "h4" : "p");
    p.append(inline(head ? head[1] : line));
    out.push(p);
  }
  return out.length ? out : [document.createTextNode(String(text || ""))];
}
