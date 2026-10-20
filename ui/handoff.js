/*
 * handoff.js (UI) — the "Continue in…" button and its preview (0.76.0).
 *
 * One click on an engine opens a preview of exactly what will be sent: the
 * context pack (src/lib/contextPack.js) for that engine, a task, the user's
 * own question, and the size against the engine's budget. The text can be
 * edited. Send opens the engine in a new tab and the extension puts the
 * message in its chat box and sends it (src/handoff.js). "Skip this preview
 * next time" makes later clicks send straight away. Copy and Download .md
 * are there for any other AI.
 *
 * Claude isn't one of the sites CitoSkeleton reads, so the first time it is
 * chosen Chrome asks the user to allow claude.ai (an optional permission).
 */
import { tr } from "./i18n.js";
import { ENGINES, TASKS, buildPack } from "../src/lib/contextPack.js";

const DIRECT_KEY = "cito-handoff-direct";
const LAST_KEY = "cito-handoff-engine";
const ORDER = ["chatgpt", "claude", "gemini", "perplexity", "grok"];

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
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* per-viewer nicety */ } } };

async function permit(engine) {
  const origin = new URL(ENGINES[engine].url).origin + "/*";
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) { return false; }
}

/** Send a finished text to an engine. Must run inside the click. */
export async function sendTo(engine, text, { autoSend = true } = {}) {
  if (!(await permit(engine))) return { ok: false, error: tr("Permission not given for this site.") };
  ls.set(LAST_KEY, engine);
  return (await send({ type: "handoff-open", engine, text, autoSend })) || { ok: false, error: "no reply" };
}

function download(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * @param {{getParts: () => Promise<{title, text}[]>|{title, text}[], task?: string, question?: () => string, label?: string, id?: string, file?: string}} o
 */
export function handoffButton(o) {
  const wrap = h("span", { className: "ho-wrap" });
  const btn = h("button", { type: "button", className: "btn sm ho-btn", id: o.id || null, "aria-haspopup": "menu", "aria-expanded": "false", "data-tip": tr("Take this data, your question and a request to another AI in one click") }, o.label || "Continue in…");
  const menu = h("div", { className: "ho-menu", role: "menu", hidden: true });
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const pack = async (engine, task, question) => buildPack({ engine, task, question, parts: await o.getParts() });
  for (const e of ORDER) {
    const it = h("button", { type: "button", role: "menuitem", className: "ho-item", "data-engine": e }, ENGINES[e].label);
    it.onclick = async () => {
      close();
      const q = (o.question && o.question()) || "";
      const task = o.task || (q ? "custom" : "explain");
      if (ls.get(DIRECT_KEY) === "1") {
        const p = await pack(e, task, q);
        const r = await sendTo(e, p.text);
        if (!r.ok) openPreview(o, e, { error: r.error });
      } else openPreview(o, e, {});
    };
    menu.append(it);
  }
  menu.append(h("div", { className: "ho-sep", role: "separator" }));
  const copy = h("button", { type: "button", role: "menuitem", className: "ho-item", "data-act": "copy" }, "Copy for any AI");
  copy.onclick = async () => { close(); const p = await pack("claude", o.task || "explain", (o.question && o.question()) || ""); try { await navigator.clipboard.writeText(p.text); copy.textContent = tr("Copied"); } catch (_) { openPreview(o, "claude", {}); } };
  const dl = h("button", { type: "button", role: "menuitem", className: "ho-item", "data-act": "download" }, "Download as .md");
  dl.onclick = async () => { close(); const p = await pack("claude", o.task || "explain", (o.question && o.question()) || ""); download(o.file || "citoskeleton-context.md", p.text); };
  menu.append(copy, dl);
  btn.onclick = (ev) => { ev.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  document.addEventListener("click", (ev) => { if (!wrap.contains(ev.target)) close(); });
  wrap.append(btn, menu);
  return wrap;
}

/** The preview: what will be sent, editable, with the task and question. */
export async function openPreview(o, engine, { error } = {}) {
  document.getElementById("hoBackdrop")?.remove();
  const back = h("div", { className: "modal-backdrop ho-backdrop", id: "hoBackdrop" });
  const card = h("div", { className: "modal-content modal-wide ho-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "hoTitle" });
  const engSel = h("select", { id: "hoEngine", className: "ho-select" }, ...ORDER.map((e) => h("option", { value: e, selected: e === engine }, ENGINES[e].label)));
  const taskSel = h("select", { id: "hoTask", className: "ho-select" }, ...Object.entries(TASKS).map(([k, t]) => h("option", { value: k, selected: k === (o.task || "explain") }, t.label)));
  const q = h("input", { type: "text", id: "hoQuestion", className: "ho-q", placeholder: tr("Your question (optional)"), value: (o.question && o.question()) || "", dir: "auto" });
  const area = h("textarea", { id: "hoText", className: "ho-text", rows: 16, dir: "auto", spellcheck: false });
  const size = h("div", { className: "ho-size", id: "hoSize", role: "status" });
  const auto = h("input", { type: "checkbox", id: "hoAuto", checked: true });
  const skip = h("input", { type: "checkbox", id: "hoSkip" });
  const msg = h("div", { className: "ho-msg", id: "hoMsg", role: "alert" }, error || "");
  const go = h("button", { type: "button", className: "btn primary", id: "hoSend" }, "Open and send");
  const cancel = h("button", { type: "button", className: "btn ghost", id: "hoCancel" }, "Cancel");
  let edited = false;
  area.oninput = () => { edited = true; showSize(); };
  const showSize = () => {
    const b = ENGINES[engSel.value].budget;
    size.textContent = `${area.value.length.toLocaleString()} ${tr("characters")} · ${ENGINES[engSel.value].label} ${tr("takes about")} ${b.toLocaleString()}${area.dataset.dropped ? ` · ${tr("left out to fit")}: ${area.dataset.dropped}` : ""}`;
    size.classList.toggle("over", area.value.length > b);
  };
  const rebuild = async () => {
    if (edited) return showSize();
    const p = await buildPack({ engine: engSel.value, task: taskSel.value, question: q.value, parts: await o.getParts() });
    area.value = p.text;
    area.dataset.dropped = p.dropped.join("; ");
    showSize();
  };
  engSel.onchange = () => { edited = false; rebuild(); go.textContent = tr("Open and send"); };
  taskSel.onchange = () => { edited = false; rebuild(); };
  q.oninput = () => { edited = false; rebuild(); };
  const shut = () => back.remove();
  cancel.onclick = shut;
  back.onclick = (e) => { if (e.target === back) shut(); };
  card.onkeydown = (e) => { if (e.key === "Escape") shut(); };
  go.onclick = async () => {
    go.disabled = true;
    if (skip.checked) ls.set(DIRECT_KEY, "1");
    const r = await sendTo(engSel.value, area.value, { autoSend: auto.checked });
    go.disabled = false;
    if (r.ok) shut(); else msg.textContent = r.error || tr("Couldn't open it.");
  };
  card.append(
    h("div", { className: "modal-header" }, h("h3", { className: "modal-title", id: "hoTitle" }, "Continue in another AI"), h("button", { type: "button", className: "modal-close-btn", title: tr("Close"), onclick: shut }, "×")),
    h("div", { className: "modal-body ho-body" },
      h("p", { className: "ho-sub" }, "This is exactly what will be sent: what CitoSkeleton measured and how, the data, and your request. You can edit it."),
      h("div", { className: "ho-row" }, h("label", { for: "hoEngine" }, "Send to"), engSel, h("label", { for: "hoTask" }, "Task"), taskSel),
      h("div", { className: "ho-row" }, q),
      area, size, msg,
      h("div", { className: "ho-foot" },
        h("label", { className: "ho-check" }, auto, " ", tr("Send it straight away (otherwise it's left in the chat box)")),
        h("label", { className: "ho-check" }, skip, " ", tr("Skip this preview next time")),
        h("span", { className: "ho-btns" }, cancel, go))));
  back.append(card);
  document.body.append(back);
  await rebuild();
  q.focus();
}
