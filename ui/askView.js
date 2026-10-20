/*
 * askView.js — the Ask tab (0.73.0): questions about your own captures,
 * answered by the built-in AI on this computer (src/lib/assistant.js).
 *
 * The conversation is kept in this browser (chrome.storage.local
 * "lcfcAsk", the last 40 messages). Each answer lists what it looked up
 * and links the captures it used; they open in Analyze.
 */
import { tr } from "./i18n.js";

const KEY = "lcfcAsk";
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
export async function renderAsk(root, hooks = {}) {
  if (!root) return;
  root.replaceChildren();
  const st = await send({ type: "ai-status" });
  let msgs = await load();
  const wrap = h("div", { className: "ask" });
  root.append(wrap);
  wrap.append(h("div", { className: "card ask-head" },
    h("h2", { className: "ask-title" }, "Ask about your captures"),
    h("p", { className: "ask-sub" }, "Questions about your campaigns and the answers you captured, answered by the built-in AI on this computer. It looks the numbers up rather than guessing, and links the answers it used. Nothing is sent anywhere.")));

  if (!st || !st.ready) {
    const b = h("button", { type: "button", className: "btn sm primary", id: "askSetup" }, "Set up the built-in AI");
    b.onclick = () => hooks.openSettings && hooks.openSettings();
    wrap.append(h("div", { className: "card ask-empty", id: "askOff" },
      h("p", {}, "Ask needs the built-in AI. Download it once in About → Settings → Built-in AI; the Strong size answers best."), b));
    return;
  }

  const log = h("div", { className: "card ask-log", id: "askLog", role: "log", "aria-live": "polite" });
  const drawMsg = (m) => {
    if (m.role === "user") return h("div", { className: "ask-msg you", dir: "auto" }, m.content);
    const box = h("div", { className: "ask-msg ai" }, h("div", { className: "ask-text", dir: "auto" }, m.content));
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
    return box;
  };
  const redraw = () => {
    log.replaceChildren(...(msgs.length ? msgs.map(drawMsg) : [h("p", { className: "ask-hint" }, "Try one of these, or ask your own:")]));
    log.scrollTop = log.scrollHeight;
  };
  const sug = h("div", { className: "ask-suggest" });
  SUGGEST.forEach((q) => { const b = h("button", { type: "button", className: "db-chip ask-chip" }, q); b.onclick = () => { input.value = tr(q); go(); }; sug.append(b); });
  const input = h("textarea", { id: "askInput", className: "ask-input", rows: 2, placeholder: tr("Ask about your campaigns, brands, sites or answers…"), dir: "auto" });
  const btn = h("button", { type: "button", className: "btn primary", id: "askSend" }, "Ask");
  const clear = h("button", { type: "button", className: "btn sm ghost", id: "askClear" }, "Clear the conversation");
  const status = h("span", { className: "ask-status", id: "askStatus", role: "status" });
  const go = async () => {
    const q = input.value.trim();
    if (!q || btn.disabled) return;
    input.value = "";
    msgs.push({ role: "user", content: q });
    redraw();
    btn.disabled = true;
    status.textContent = tr("Looking it up…");
    const history = msgs.slice(0, -1).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const r = await send({ type: "ask", question: q, history });
    btn.disabled = false;
    status.textContent = r && r.ok ? (r.ms ? `${(r.ms / 1000).toFixed(1)} s` : "") : "";
    msgs.push(r && r.ok ? { role: "assistant", content: r.answer, steps: r.steps, refs: r.refs, unverified: r.unverified || [] } : { role: "assistant", content: `${tr("That didn't work")}: ${(r && r.error) || "no reply"}` });
    await save(msgs);
    redraw();
  };
  btn.onclick = go;
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } };
  clear.onclick = async () => { msgs = []; await save(msgs); redraw(); };
  wrap.append(log, h("div", { className: "card ask-form" }, sug, h("div", { className: "ask-row" }, input, btn), h("div", { className: "ask-foot" }, status, clear)));
  redraw();
}
