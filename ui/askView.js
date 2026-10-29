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
const ENGINE = { chatgpt: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", grok: "Grok" };

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

  if (!ready) {
    const q = h("input", { type: "text", id: "askOffQ", className: "ask-input", placeholder: tr("Ask about your campaigns, brands, sites or answers…"), dir: "auto" });
    wrap.append(h("div", { className: "card ask-empty", id: "askOff" },
      h("p", {}, "Ask answers with an AI model on this computer: turn on \u201cAsk's AI model\u201d below (a one-time download), and it's ready."),
      models,
      h("p", { className: "ask-or" }, "Or, with no download, take your latest campaign's data and your question to another AI:"),
      h("div", { className: "ask-row" }, q, handoffButton({ id: "askOffHandoff", getParts: campaignPack, question: () => q.value, file: "citoskeleton-campaign.md" }))));
    return;
  }
  wrap.append(models);

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
    const box = h("div", { className: "ask-msg ai" }, meta("CitoSkeleton", m.at), h("div", { className: "ask-text", dir: "auto" }, ...mdNodes(m.content)));
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
  const go = async () => {
    const q = input.value.trim();
    if (!q || btn.disabled) return;
    input.value = "";
    grow();
    msgs.push({ role: "user", content: q, at: Date.now() });
    redraw();
    btn.disabled = true;
    typing.hidden = false;
    typing.querySelector(".ask-typing-t").textContent = tr("Thinking…");
    log.scrollTop = log.scrollHeight;
    status.textContent = "";
    const history = msgs.slice(0, -1).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    askId++;
    const r = await send({ type: "ask", question: q, history, askId: `a${askId}` });
    btn.disabled = false;
    typing.hidden = true;
    status.textContent = r && r.ok ? (r.ms ? `${(r.ms / 1000).toFixed(1)} s` : "") : "";
    msgs.push(r && r.ok ? { role: "assistant", content: r.answer, steps: r.steps, refs: r.refs, unverified: r.unverified || [], lookups: r.lookups || [], at: Date.now() } : { role: "assistant", content: `${tr("That didn't work")}: ${(r && r.error) || "no reply"}`, at: Date.now() });
    await save(msgs);
    redraw();
    input.focus();
  };
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
