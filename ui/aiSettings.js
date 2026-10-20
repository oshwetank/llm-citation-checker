/*
 * aiSettings.js — the Built-in AI block in About → Settings (0.70.0).
 *
 * Off until "Download AI model" is clicked. Shows the hardware check and
 * the size it suggests (and why), download progress, then what the model
 * checks. Every switch saves at once, outside Save / Undo, like Display.
 * The model and its queue live in the background (src/aiService.js).
 */
import { tr } from "./i18n.js";
import { TIERS, TIER_ORDER, sizeLabel } from "../src/lib/llmTiers.js";
import { importFiles } from "../src/lib/llmEngine.js";

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
const GB = 1024 ** 3;
const gb = (b) => (b == null ? "?" : `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`);

function sw(id, label, note, checked, onChange) {
  const input = h("input", { type: "checkbox", id, role: "switch", checked: !!checked });
  const text = h("span", { className: "ab-switch-text" }, checked ? "On" : "Off");
  input.onchange = () => { text.textContent = input.checked ? "On" : "Off"; onChange(input.checked); };
  return h("div", { className: "ab-row ai-row" },
    h("label", { className: "ab-row-text", for: id }, h("b", {}, label), h("span", {}, note)),
    h("label", { className: "ab-switch" }, input, h("span", { className: "ab-switch-track", "aria-hidden": "true" }, h("span", { className: "ab-switch-knob" })), text));
}

export function initAiSettings(slot) {
  if (!slot) return;
  let st = null, chosen = null, poll = null, hwAsked = false;

  const draw = () => {
    const s = st || {};
    const pick = s.pick || null;
    const tier = chosen || s.tier || (pick && pick.tier) || "standard";
    slot.replaceChildren();
    const chip = s.downloading ? h("span", { className: "ai-chip busy" }, s.progress && s.progress.pct != null ? `Downloading ${Math.round(s.progress.pct)}%` : "Downloading…")
      : s.ready && s.engine && s.engine.id === "nano" ? h("span", { className: "ai-chip ok" }, "Ready · Chrome's built-in AI")
      : s.ready ? h("span", { className: "ai-chip ok" }, `Ready · ${s.model ? (s.model.params ? `${s.model.label} (${s.model.params})` : s.model.label) : ""}${s.device ? ` · ${s.device === "webgpu" ? "graphics chip" : "processor"}` : ""}`)
      : s.error ? h("span", { className: "ai-chip bad" }, "Download failed")
      : h("span", { className: "ai-chip" }, "Off");
    slot.append(h("div", { className: "ab-row ai-head" },
      h("div", { className: "ab-row-text", id: "aiLabel" },
        h("b", {}, "Built-in AI ", chip),
        h("span", {}, `AI that runs on this computer: Chrome's own built-in model where Chrome has it, or an open-source model (${s.family || "Qwen3.5"}, ${s.licence || "Apache-2.0"}, 201 languages) downloaded once from Hugging Face. It reads each answer's language, market, intent and audience, and checks each brand's type, owner and how the answer treats it, quoting the answer. Nothing you capture is ever sent anywhere. Your counts don't change unless you turn that on below.`))));
    slot.append(engineBlock(s));

    // The hardware check, and the sizes.
    const hw = s.hardware;
    if (hw) {
      const bits = [hw.webgpu ? `graphics chip found${hw.adapter ? ` (${hw.adapter})` : ""}` : "no graphics-chip access (WebGPU)", hw.deviceMemory ? `${hw.deviceMemory}+ GB memory` : null, hw.freeBytes != null ? `${gb(hw.freeBytes)} free for the extension` : null].filter(Boolean);
      slot.append(h("p", { className: "ai-hw", id: "aiHw" }, h("b", {}, "This computer: "), bits.join(" · "), pick ? h("span", { className: "ai-why" }, `. Suggested: ${pick.tier ? TIERS[pick.tier].label : "none"}. ${pick.reason}`) : null));
    } else slot.append(h("p", { className: "ai-hw", id: "aiHw" }, "Checking this computer…"));

    const seg = h("div", { className: "ab-seg ai-seg", role: "radiogroup", "aria-labelledby": "aiLabel", id: "aiTier" });
    for (const id of TIER_ORDER) {
      const t = TIERS[id];
      const ok = !pick || pick.possible.includes(id);
      const b = h("button", { type: "button", role: "radio", className: "ab-seg-btn", "data-tier": id, "aria-checked": String(tier === id), disabled: !!s.downloading,
        title: `${t.label}: Qwen3.5 ${t.params}, about ${sizeLabel(id)} once. ${t.for}.${ok ? "" : " This computer is below what it needs."}` },
        `${t.label} · ${sizeLabel(id)}`, !ok ? h("span", { className: "ai-warn" }, " !") : null);
      b.onclick = () => { chosen = id; draw(); };
      seg.append(b);
    }
    const isCurrent = s.qwenReady && s.tier === tier;
    const dl = h("button", { type: "button", className: "btn sm primary", id: "aiDownload", disabled: !!s.downloading || isCurrent },
      s.downloading ? "Downloading…" : isCurrent ? "Downloaded" : s.qwenReady ? `Switch to ${TIERS[tier].label}` : "Download AI model");
    dl.onclick = async () => { await send({ type: "ai-download", tier, device: pick ? pick.device : undefined }); refresh(); };
    const rm = h("button", { type: "button", className: "btn sm ghost", id: "aiRemove", disabled: !s.qwenReady || !!s.downloading }, "Remove model");
    rm.onclick = async () => { if (!confirm("Remove the built-in AI model from this computer? The checks already made are kept.")) return; await send({ type: "ai-remove" }); chosen = null; refresh(); };
    // Load from a folder: for computers that can't reach huggingface.co. The
    // folder is the model's files as Hugging Face lists them (config.json,
    // tokenizer files, onnx/…), downloaded on another computer.
    const pickDir = h("input", { type: "file", id: "aiFolder", hidden: true, multiple: true });
    pickDir.setAttribute("webkitdirectory", "");
    pickDir.onchange = async () => {
      const files = [...(pickDir.files || [])].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
      if (!files.length) return;
      folderNote.textContent = `Adding ${files.length} files…`;
      try {
        const r = await importFiles({ repo: TIERS[tier].repo, files });
        folderNote.textContent = `Added ${r.imported} files. Loading the model…`;
        await send({ type: "ai-download", tier, device: pick ? pick.device : undefined });
        refresh();
      } catch (e) { folderNote.textContent = `Couldn't add them: ${e && e.message || e}`; }
    };
    const folder = h("button", { type: "button", className: "btn sm ghost", id: "aiFolderBtn", disabled: !!s.downloading, title: `A folder with ${TIERS[tier].repo}'s files, downloaded elsewhere` }, "Load from a folder");
    folder.onclick = () => pickDir.click();
    const folderNote = h("span", { className: "ai-hw", id: "aiFolderNote", role: "status" }, "");
    slot.append(h("div", { className: "ab-row ai-actions" },
      h("div", { className: "ab-row-text" }, h("b", {}, "Model size"), h("span", {}, `${TIERS[tier].label}: Qwen3.5 ${TIERS[tier].params}, about ${sizeLabel(tier)} once. ${TIERS[tier].for}.`)),
      seg, h("div", { className: "ai-btns" }, dl, folder, rm, pickDir), folderNote));

    if (s.downloading) {
      const pct = s.progress && s.progress.pct != null ? Math.max(0, Math.min(100, s.progress.pct)) : null;
      slot.append(h("div", { className: "ai-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct == null ? null : String(Math.round(pct)), "aria-label": "Download progress" },
        h("i", { style: `width:${pct == null ? 5 : pct}%` }),
        h("span", {}, s.progress && s.progress.total ? `${gb(s.progress.loaded)} of ${gb(s.progress.total)}` : "Starting…")));
    }
    if (s.error && !s.downloading) slot.append(h("p", { className: "ai-err", role: "alert" }, `The last download failed: ${s.error}. Check the connection, or that huggingface.co isn't blocked here, and try again.`));

    if (s.ready) {
      const set = (patch) => send({ type: "settings-set", patch });
      slot.append(
        sw("aiCampaigns", "Check campaign answers", "Each answer a campaign captures is checked in the background, one at a time.", s.settings && s.settings.onCampaigns, (v) => set({ aiOnCampaigns: v })),
        sw("aiEveryday", "Check everyday answers", "Answers you get by asking the engines yourself. Nothing leaves this computer.", s.settings && s.settings.onEveryday, (v) => set({ aiOnEveryday: v })),
        sw("aiCounts", "Use AI-checked brands in counts", "Adds the names the AI found, each quoted from the answer, to share of voice and visibility. Off keeps counts the same on every computer.", s.settings && s.settings.inCounts, (v) => set({ aiInCounts: v })));
      slot.append(h("p", { className: "ai-hw", id: "aiQueue" }, s.checking ? `Checking an answer now · ${s.queued} waiting` : s.queued ? `${s.queued} answers waiting` : "Nothing waiting.",
        s.model ? ` Model: ${s.model.repo}.` : ""));
    }
  };

  // Which engine answers (0.74.0): Chrome's own model, the downloaded one,
  // or automatic (the fastest that passed "Test this computer").
  let benchBusy = false;
  function engineBlock(s) {
    const box = h("div", { className: "ai-engine", id: "aiEngine" });
    const nano = s.nano || "unavailable";
    const nanoLine = nano === "available" ? "Ready on this computer. It runs on the graphics chip, and Chrome keeps it up to date."
      : nano === "downloadable" ? "Chrome can fetch it (Chrome's own download, shared by every site and extension that uses it)."
      : nano === "downloading" || s.nanoFetching ? `Chrome is fetching it${s.progress && s.progress.status === "nano" && s.progress.pct != null ? ` (${s.progress.pct}%)` : ""}…`
      : "Not on this computer: Chrome offers it only with a capable graphics chip and enough free space.";
    const useNano = h("button", { type: "button", className: "btn sm", id: "aiUseNano", hidden: nano !== "downloadable" || !!s.nanoFetching }, "Use Chrome's built-in AI");
    useNano.onclick = async () => { useNano.disabled = true; await send({ type: "ai-use-nano" }); refresh(); };
    box.append(h("div", { className: "ab-row ai-row" },
      h("div", { className: "ab-row-text" }, h("b", {}, "Chrome's built-in AI"), h("span", { id: "aiNanoLine" }, nanoLine), s.nanoError ? h("span", { className: "ai-err" }, s.nanoError) : null),
      h("div", { className: "ai-btns" }, useNano)));

    const choice = s.engineChoice || "auto";
    const seg = h("div", { className: "ab-seg", role: "radiogroup", "aria-label": "Answered by", id: "aiEngineSeg" });
    for (const [id, label, ok] of [["auto", "Automatic", true], ["nano", "Chrome's built-in AI", nano === "available"], ["qwen", "Downloaded model", !!s.qwenReady]]) {
      const b = h("button", { type: "button", role: "radio", className: "ab-seg-btn", "data-engine": id, "aria-checked": String(choice === id), disabled: !ok }, label);
      b.onclick = async () => { await send({ type: "ai-set-engine", engine: id }); refresh(); };
      seg.append(b);
    }
    const test = h("button", { type: "button", className: "btn sm", id: "aiBench", disabled: benchBusy || (!s.qwenReady && nano !== "available") }, benchBusy ? "Testing…" : "Test this computer");
    test.onclick = async () => { benchBusy = true; draw(); await send({ type: "ai-benchmark" }); benchBusy = false; refresh(); };
    box.append(h("div", { className: "ab-row ai-row" },
      h("div", { className: "ab-row-text" }, h("b", {}, "Answered by"), h("span", {}, s.engine ? `Now: ${s.engine.label}.${s.paused ? " Waiting while a campaign runs." : ""}` : "Nothing set up yet.")),
      seg, h("div", { className: "ai-btns" }, test)));
    const b = s.bench;
    if (b) {
      const row = (name, r) => !r ? null : h("tr", {}, h("td", {}, name),
        h("td", {}, r.ok != null && r.ms != null ? `${(r.ms / 1000).toFixed(1)} s` : "—"),
        h("td", {}, r.score != null ? `${r.score}/${r.of}${r.ok ? "" : " (not good enough)"}` : r.notDownloaded ? "not downloaded" : r.availability ? `not ready (${r.availability})` : r.error ? "failed" : "—"),
        h("td", {}, r.threads ? `${r.device === "webgpu" ? "graphics chip" : `processor, ${r.threads} threads`}` : name.startsWith("Chrome") ? "graphics chip" : r.device || ""));
      box.append(h("table", { className: "ai-bench", id: "aiBenchTable" },
        h("thead", {}, h("tr", {}, h("th", {}, "Engine"), h("th", {}, "One answer"), h("th", {}, "Quality"), h("th", {}, "Runs on"))),
        h("tbody", {}, row("Chrome's built-in AI", b.nano), row("Downloaded model", b.qwen))));
    }
    return box;
  }

  const refresh = async () => {
    st = await send({ type: "ai-status" });
    draw();
    if (st && st.downloading) { if (!poll) poll = setInterval(refresh, 1000); }
    else if (poll) { clearInterval(poll); poll = null; }
  };
  // The hardware check opens the AI page and asks Chrome for a graphics
  // adapter, so it waits until the card is on screen: never on a popup or
  // tab that doesn't show Settings (0.70.0).
  const askHardware = async () => {
    if (hwAsked) return;
    hwAsked = true;
    const r = await send({ type: "ai-hardware" });
    if (r && r.ok) { st = await send({ type: "ai-status" }); draw(); }
  };
  if (typeof IntersectionObserver === "function") {
    // A huge margin: what counts is that Settings is shown (a hidden page
    // never intersects), not that the card is scrolled into view.
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); askHardware(); } }, { rootMargin: "100000px 0px" });
    io.observe(slot);
  } else askHardware();
  try {
    chrome.runtime.onMessage.addListener((m) => { if (m && (m.type === "ai-state")) refresh(); });
  } catch (_) { /* not in the extension */ }
  refresh();
}
