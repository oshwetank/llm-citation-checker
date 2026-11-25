/*
 * modelSwitches.js — the AI models as switches (0.84.0).
 *
 * Asked (29 Oct): the model download "needs to be in the Ask section …
 * otherwise new users will never know about it", and installing or
 * removing a model should be "as easy as a switch". One block, used in Ask
 * (popup and full tab), at the top of Settings → Built-in AI, and wherever
 * an "AI is off" note needs a way to turn it on:
 *   - "Ask's AI model" (Qwen3.5, the size this computer suits);
 *   - "Fast labels" (Laya).
 * On downloads it once; off while downloading cancels; off when downloaded
 * removes the files. Each says its size, where it runs, and that removing
 * CitoSkeleton removes it too (Chrome deletes an extension's stored data
 * when it is uninstalled). Chrome's own built-in AI, where Chrome has it,
 * is Chrome's to manage and is only reported here.
 */
import { tr } from "./i18n.js";
import { TIERS } from "../src/lib/llmTiers.js";

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (let [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    // Words a person reads or hears go through tr() like the text does
    // (0.84.2): aria-label, title and placeholder were set as written, so
    // "Typeface", "Density" and the size buttons' tooltips stayed English.
    if (typeof v === "string" && (k === "aria-label" || k === "title" || k === "placeholder" || k === "textContent")) v = tr(v);
    if (k.startsWith("data-") || k.startsWith("aria-") || k === "for" || k === "role") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of kids) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(tr(String(c))));
  return n;
}
const send = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, (x) => { void chrome.runtime.lastError; r(x || null); }); } catch (_) { r(null); } });
const GB = 1024 ** 3;
const size = (b) => (b == null ? "" : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);
const where = (d) => (d === "webgpu" ? "on the graphics chip" : d === "wasm" ? "on the processor" : "");

/** The state of one switch, from ai-status. */
export function switchState(s, kind) {
  if (!s) return { on: false, busy: false, ready: false };
  if (kind === "meaning") {
    const M = s.meaning || {};
    return { on: !!(M.ready || M.downloading), busy: !!M.downloading, ready: !!M.ready, error: M.error || null, progress: M.progress || null, device: M.device || null, bytes: M.bytes || 135500000, label: "Search by meaning" };
  }
  if (kind === "laya") {
    const L = s.laya || {};
    return { on: !!(L.ready || L.downloading), busy: !!L.downloading, ready: !!L.ready, error: L.error || null, progress: L.progress || null, device: L.device || null, bytes: L.bytes || null, label: L.label || "Laya" };
  }
  const tier = (s.model && s.model.id && TIERS[s.model.id]) ? s.model.id : (s.pick && s.pick.tier) || "standard";
  return { on: !!(s.qwenReady || s.downloading), busy: !!s.downloading, ready: !!s.qwenReady, error: s.error || null, progress: s.progress || null, device: s.device || null, bytes: TIERS[tier] ? TIERS[tier].bytes : null, tier, label: s.model ? s.model.label : TIERS[tier] && TIERS[tier].label };
}

/**
 * Draw the switches into `slot`, and keep them current while it's on screen.
 * @param {HTMLElement} slot
 * @param {{compact?: boolean, onChange?: (s: object) => void}} opts
 */
export function mountModelSwitches(slot, opts = {}) {
  if (!slot) return;
  let st = null, poll = null, alive = true;
  const row = (kind, title, what) => {
    const x = switchState(st, kind);
    const id = kind === "laya" ? "swLaya" : kind === "meaning" ? "swMeaning" : "swAskModel";
    const input = h("input", { type: "checkbox", id, role: "switch", checked: x.on, "aria-checked": String(x.on) });
    const pct = x.progress && x.progress.pct != null ? Math.max(0, Math.min(100, x.progress.pct)) : null;
    const line = x.busy ? `Downloading${pct != null ? ` ${Math.round(pct)}%` : "…"}${x.progress && x.progress.total ? ` · ${size(x.progress.loaded)} of ${size(x.progress.total)}` : ""}. Turn off to cancel.`
      : x.ready ? `On · downloaded${x.device ? `, runs ${where(x.device)}` : ""}.`
      : x.error ? `Off · ${plainError(x.error)}`
      : `Off · ${size(x.bytes)} download, once.`;
    input.onchange = async () => {
      input.disabled = true;
      if (input.checked) {
        if (kind === "laya") await send({ type: "laya-download" });
        else if (kind === "meaning") await send({ type: "meaning-download" });
        else await send({ type: "ai-download", tier: x.tier, device: st && st.pick ? st.pick.device : undefined });
      } else if (x.busy && kind === "meaning") {
        input.checked = true; // it finishes; turn it off after to remove it
      } else if (x.busy) {
        await send({ type: "ai-cancel-download", kind: kind === "laya" ? "laya" : "llm" });
      } else if (confirm(tr(`Remove ${title} from this computer? You can turn it on again any time; what it already labelled is kept.`))) {
        await send({ type: kind === "laya" ? "laya-remove" : kind === "meaning" ? "meaning-remove" : "ai-remove" });
      } else input.checked = true;
      refresh();
    };
    const box = h("div", { className: `ms-row${x.on ? " on" : ""}${x.busy ? " busy" : ""}`, "data-model": kind },
      h("label", { className: "ms-text", for: id }, h("b", {}, title), h("span", { className: "ms-what" }, what), h("span", { className: `ms-state${x.error && !x.busy ? " bad" : ""}`, role: "status" }, line)),
      h("label", { className: "ab-switch ms-switch" }, input, h("span", { className: "ab-switch-track", "aria-hidden": "true" }, h("span", { className: "ab-switch-knob" })), h("span", { className: "ab-switch-text" }, x.on ? "On" : "Off")));
    if (x.busy) box.append(h("div", { className: "ai-progress ms-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct == null ? null : String(Math.round(pct)), "aria-label": `${title} download` }, h("i", { style: `width:${pct == null ? 4 : pct}%` })));
    return box;
  };
  const draw = () => {
    if (!alive) return;
    slot.replaceChildren();
    const nano = st && st.nano === "available";
    slot.append(h("div", { className: `ms${opts.compact ? " compact" : ""}`, id: "modelSwitches" },
      row("llm", "Ask's AI model", `Answers questions about your captures, on this computer${st && st.pick && st.pick.tier ? ` (${TIERS[st.pick.tier].label} size suits it)` : ""}.`),
      row("laya", "Fast labels", "Laya labels each answer — what it asks, who it's for, how each brand is treated — quickly, without writing text."),
      row("meaning", "Search by meaning", "Ask and the Dashboard search also find answers that say it in other words, in any language (“long-lasting charge” for “battery”)."),
      nano ? h("p", { className: "ms-note" }, "Chrome's own built-in AI is ready here too, and Ask can use it with no download (Chrome manages it).") : null,
      h("p", { className: "ms-note" }, "Models stay on this computer. Uninstalling CitoSkeleton removes them with it.")));
    if (opts.onChange) opts.onChange(st);
  };
  let drawn = false;
  const refresh = async () => {
    if (!alive) return;
    // Gone from the page (its tab was redrawn): stop. Not checked before
    // the first draw, which runs before the caller has placed the slot.
    if (drawn && !slot.isConnected) { alive = false; if (poll) clearInterval(poll); return; }
    st = await send({ type: "ai-status" });
    drawn = true;
    draw();
    const busy = st && (st.downloading || (st.laya && st.laya.downloading) || (st.meaning && st.meaning.downloading));
    if (busy && !poll) poll = setInterval(refresh, 1000);
    else if (!busy && poll) { clearInterval(poll); poll = null; }
  };
  try { chrome.runtime.onMessage.addListener((m) => { if (alive && m && m.type === "ai-state") refresh(); }); } catch (_) { /* not in the extension */ }
  refresh();
  return { refresh };
}

/* A download's failure, in words a person can act on (1.0.6): "Failed to
 * fetch" said nothing (reported four times in a row from one computer). */
export function plainError(e) {
  const t = String(e || "");
  if (/failed to fetch|networkerror|network error|load failed|ERR_|ECONN|timed? ?out/i.test(t)) return "Couldn't reach huggingface.co, where the AI is downloaded from. Check the internet connection, or whether this network blocks that site, then try again.";
  if (/quota|storage|space/i.test(t)) return "Not enough room on this computer for the download. Free some disk space, then try again.";
  if (/abort|cancel/i.test(t)) return "The download was stopped.";
  return t;
}

/*
 * The built-in AI in one button (1.0.6; asked: "it has become there are
 * three things to download … it feels so restrictive"). Ask and every
 * number work with no download; one button fetches the two models Ask uses
 * (the writer, then search by meaning), one after the other, with one bar.
 * The models one by one are still there, folded, for whoever wants them.
 */
export function mountAiSetup(slot, opts = {}) {
  if (!slot) return null;
  let st = null, poll = null, alive = true, drawn = false;
  const parts = () => {
    const w = switchState(st, "llm"), m = switchState(st, "meaning");
    const total = (w.ready ? 0 : (w.bytes || 0)) + (m.ready ? 0 : (m.bytes || 0));
    return { w, m, ready: w.ready && m.ready, busy: w.busy || m.busy, error: (!w.busy && !w.ready && w.error) || (!m.busy && !m.ready && m.error) || null, total };
  };
  const start = async () => {
    const p = parts();
    if (!p.w.ready && !p.w.busy) await send({ type: "ai-download", tier: p.w.tier, device: st && st.pick ? st.pick.device : undefined });
    if (!p.m.ready && !p.m.busy) await send({ type: "meaning-download" });
    refresh();
  };
  const draw = () => {
    if (!alive) return;
    const p = parts();
    const box = h("div", { className: `ai-setup${opts.compact ? " compact" : ""}${p.ready ? " ready" : ""}${p.busy ? " busy" : ""}`, id: opts.id || null });
    if (p.ready) {
      box.append(h("span", { className: "ai-setup-dot", "aria-hidden": "true" }), h("span", { className: "ai-setup-text" }, h("b", {}, "Built-in AI is on."), h("span", {}, " Replies in plain words, and search that understands meaning.")));
    } else if (p.busy) {
      const cur = p.w.busy ? p.w : p.m;
      const pct = cur.progress && cur.progress.pct != null ? Math.max(0, Math.min(100, cur.progress.pct)) : null;
      const step = p.w.busy ? (p.m.ready ? "" : " (1 of 2)") : (p.w.ready ? " (2 of 2)" : "");
      const cancel = h("button", { type: "button", className: "btn sm ghost" }, "Cancel");
      cancel.onclick = async () => { cancel.disabled = true; if (p.w.busy) await send({ type: "ai-cancel-download", kind: "llm" }); refresh(); };
      box.append(h("span", { className: "ai-setup-text", role: "status" }, h("b", {}, `Setting up the built-in AI${step}`), h("span", {}, ` ${pct != null ? `${Math.round(pct)}%` : "…"}${cur.progress && cur.progress.total ? ` · ${size(cur.progress.loaded)} of ${size(cur.progress.total)}` : ""}. You can keep using CitoSkeleton meanwhile.`)),
        p.w.busy ? cancel : "",
        h("div", { className: "ai-progress ms-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct == null ? null : String(Math.round(pct)), "aria-label": "Download" }, h("i", { style: `width:${pct == null ? 4 : pct}%` })));
    } else {
      const go = h("button", { type: "button", className: "btn sm primary" }, p.error ? "Try again" : "Set up the built-in AI");
      go.onclick = async () => { go.disabled = true; go.textContent = tr("Starting…"); await start(); };
      box.append(h("span", { className: "ai-setup-text" },
        h("b", {}, p.error ? "The download didn't finish." : opts.lead || "Optional: the built-in AI."),
        h("span", {}, p.error ? ` ${plainError(p.error)}` : ` Everything works without it. With it, Ask replies in plain words and finds answers that say things differently. One download of about ${size(p.total)}, kept on this computer.`)), go);
    }
    if (opts.details !== false) {
      const more = h("details", { className: "ai-setup-more" }, h("summary", {}, "Choose the models one by one"));
      const inner = h("div", {});
      more.append(inner);
      more.addEventListener("toggle", () => { if (more.open && !inner.childNodes.length) mountModelSwitches(inner, { compact: true }); }, { once: false });
      box.append(more);
    }
    slot.replaceChildren(box);
    if (opts.onChange) opts.onChange(st, p);
  };
  const refresh = async () => {
    if (!alive) return;
    if (drawn && !slot.isConnected) { alive = false; if (poll) clearInterval(poll); return; }
    st = await send({ type: "ai-status" });
    drawn = true;
    // A details panel the reader opened stays open across redraws.
    const wasOpen = slot.querySelector(".ai-setup-more")?.open;
    if (!wasOpen) draw();
    const p = parts();
    if (p.busy && !poll) poll = setInterval(refresh, 1000);
    else if (!p.busy && poll) { clearInterval(poll); poll = null; }
  };
  try { chrome.runtime.onMessage.addListener((m) => { if (alive && m && m.type === "ai-state") refresh(); }); } catch (_) { /* not in the extension */ }
  refresh();
  return { refresh };
}
