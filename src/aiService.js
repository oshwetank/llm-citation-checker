/*
 * aiService.js — the built-in AI, seen from the service worker (0.70.0).
 *
 * The model runs in the offscreen document (src/lib/llmEngine.js through
 * ui/offscreen.js); this file decides what it checks and keeps the results.
 *   - State (chrome.storage.local "lcfcAi"): which size was downloaded, when,
 *     and the last hardware check.
 *   - Queue (IndexedDB "aiQueue"): answers waiting for a check, so a browser
 *     restart loses nothing. One at a time.
 *   - Results (IndexedDB "ai"): keyed by the answer's text, the model and the
 *     prompt version, so a duplicate answer is checked once and Reprocess
 *     never runs the model again — attach() puts the result back on the
 *     record on every derive.
 * Counts never change unless the user turned on "Use AI-checked brands in
 * counts" (applyAi in lib/aiCheck.js).
 */
import { TIERS, pickTier, MODEL_FAMILY, MODEL_LICENCE } from "./lib/llmTiers.js";
import { aiCheckRecord, applyAi, aiKey } from "./lib/aiCheck.js";
import { textMatches } from "./lib/textMatch.js";
import { ask as runAsk } from "./lib/assistant.js";
import { isPlausibleProseName } from "./lib/brands.js";

const STATE_KEY = "lcfcAi";
const MAX_TRIES = 2;

export function createAiService({ db, getSettings, ensureOffscreen, resetOffscreen = async () => {}, logErr = () => {}, broadcast = () => {} }) {
  async function getState() {
    try { return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {}; } catch (_) { return {}; }
  }
  async function setState(patch) {
    const next = { ...(await getState()), ...patch };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }

  // The model in use: a size from TIERS, or (tests only) a stand-in served
  // from a local address.
  function specOf(state) {
    if (state.custom && state.custom.repo) return { id: "custom", label: state.custom.label || "Test model", params: "", ...state.custom };
    const t = TIERS[state.tier];
    return t ? { id: t.id, label: t.label, params: t.params, repo: t.repo, dtype: t.dtype, host: null, bytes: t.bytes } : null;
  }
  const modelIdOf = (spec) => (spec ? spec.repo : null);

  async function llm(op, args = {}, timeoutMs = 10 * 60 * 1000) {
    let timer;
    // Firefox and Safari: the model runs in this background page (0.72.0).
    const direct = !chrome.offscreen && globalThis.citoOffscreen;
    if (direct) globalThis.citoOffscreen.onProgress = onProgress;
    else await ensureOffscreen();
    const reply = await Promise.race([
      direct ? globalThis.citoOffscreen.llmOp(op, args).then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: String(e && e.message || e) }))
        : chrome.runtime.sendMessage({ target: "llm", op, args }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the AI model took too long (${op})`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (!reply) throw new Error("no reply from the AI page");
    if (!reply.ok) throw new Error(reply.error || "AI error");
    return reply.result;
  }

  let downloading = null;
  let progress = null;
  let running = false;
  let current = null; // captureId being checked

  async function hardware() {
    const hw = await llm("hardware", {}, 30000);
    const pick = pickTier(hw);
    await setState({ hardware: hw, pick, hardwareAt: Date.now() });
    return { hardware: hw, pick };
  }

  async function status() {
    const state = await getState();
    const spec = specOf(state);
    const settings = await getSettings();
    let queued = 0;
    try { queued = await db.count("aiQueue"); } catch (_) { /* store missing */ }
    return {
      ok: true,
      family: MODEL_FAMILY, licence: MODEL_LICENCE,
      tier: state.tier || null, model: spec ? { id: spec.id, label: spec.label, params: spec.params, repo: spec.repo } : null,
      ready: !!state.downloadedAt && !!spec, downloadedAt: state.downloadedAt || null,
      device: state.device || null, error: state.error || null,
      downloading: !!downloading, progress,
      hardware: state.hardware || null, pick: state.pick || null,
      queued, checking: current,
      settings: { onCampaigns: settings.aiOnCampaigns !== false, onEveryday: settings.aiOnEveryday !== false, inCounts: !!settings.aiInCounts },
    };
  }

  function onProgress(p) { progress = p; }

  /** Download (or load from the cache) the chosen size. Returns at once. */
  async function download({ tier, device } = {}) {
    if (downloading) return { ok: true, already: true };
    let state = await getState();
    if (tier && TIERS[tier] && !state.custom) state = await setState({ tier, downloadedAt: null, error: null });
    const spec = specOf(state);
    if (!spec) return { ok: false, error: "Pick a size first." };
    const dev = device || (state.pick && state.pick.device) || "webgpu";
    progress = { status: "initiate", pct: 0 };
    downloading = (async () => {
      try {
        let info;
        try {
          info = await llm("load", { repo: spec.repo, dtype: spec.dtype, device: dev, host: spec.host || undefined }, 6 * 60 * 60 * 1000);
        } catch (e) {
          // The graphics chip couldn't run it. That page's runtime won't try
          // anything else now, so it is reopened and the model loaded on the
          // processor; the files already fetched come from the cache.
          if (dev !== "webgpu" || !/webgpu|gpu|adapter|backend/i.test(String(e && e.message))) throw e;
          await resetOffscreen();
          info = await llm("load", { repo: spec.repo, dtype: spec.dtype, device: "wasm", host: spec.host || undefined }, 6 * 60 * 60 * 1000);
        }
        await setState({ downloadedAt: Date.now(), device: info.device, error: null });
        progress = { status: "done", pct: 100 };
        broadcast({ type: "ai-state" });
        kick();
      } catch (e) {
        await setState({ error: String(e && e.message || e) });
        progress = null;
        logErr("ai-download", e);
        broadcast({ type: "ai-state" });
      } finally { downloading = null; }
    })();
    return { ok: true, started: true };
  }

  async function remove() {
    const state = await getState();
    const spec = specOf(state);
    if (spec) { try { await llm("remove", { repo: spec.repo, host: spec.host || undefined }, 120000); } catch (e) { logErr("ai-remove", e); } }
    await setState({ downloadedAt: null, error: null });
    try { await db.clear("aiQueue"); } catch (_) { /* none */ }
    broadcast({ type: "ai-state" });
    return { ok: true };
  }

  const isCampaign = (rec) => !!(rec && (rec.runId || (rec.geo && rec.geo.profileId)));

  /** Queue an answer for a check, if the settings say this kind is checked. */
  async function enqueue(rec, { force = false } = {}) {
    if (!rec || !rec.captureId || !String(rec.answerText || "").trim()) return { ok: false, reason: "no answer text" };
    const state = await getState();
    if (!state.downloadedAt || !specOf(state)) return { ok: false, reason: "The built-in AI isn't downloaded." };
    if (!force) {
      const s = await getSettings();
      if (isCampaign(rec) ? s.aiOnCampaigns === false : s.aiOnEveryday === false) return { ok: false, reason: "off for this kind of answer" };
    }
    await db.put("aiQueue", { captureId: rec.captureId, at: Date.now(), tries: 0, force: !!force });
    // The stored record says so at once ("queued", never blank).
    const stored = await db.get("derived", rec.captureId);
    if (stored && stored.aiStatus !== "done") { stored.aiStatus = "queued"; await db.put("derived", stored); broadcast({ type: "capture-updated", captureId: rec.captureId }); }
    kick();
    return { ok: true, queued: true };
  }

  /** Work through the queue, one answer at a time. */
  function kick() {
    if (running) return;
    running = true;
    (async () => {
      try {
        for (;;) {
          const items = (await db.getAll("aiQueue")).sort((a, b) => a.at - b.at);
          if (!items.length) break;
          const state = await getState();
          if (!state.downloadedAt) break;
          await processOne(items[0], state);
        }
      } catch (e) { logErr("ai-queue", e); }
      finally { running = false; current = null; broadcast({ type: "ai-state" }); }
    })();
  }

  async function processOne(item, state) {
    const spec = specOf(state);
    const rec = await db.get("derived", item.captureId);
    if (!rec || !spec) { await db.delete("aiQueue", item.captureId); return; }
    current = item.captureId;
    broadcast({ type: "ai-state" });
    const key = aiKey(rec, modelIdOf(spec));
    try {
      if (!(await db.get("ai", key))) {
        await llm("load", { repo: spec.repo, dtype: spec.dtype, device: state.device || "webgpu", host: spec.host || undefined }, 30 * 60 * 1000);
        const ai = await aiCheckRecord(rec, (o) => llm("generate", o, 5 * 60 * 1000), { model: `${MODEL_FAMILY} ${spec.params || spec.label}`.trim(), isPlausible: isPlausibleProseName });
        ai.modelRepo = spec.repo;
        await db.put("ai", { key, captureId: rec.captureId, ...ai });
      }
      const fresh = await db.get("derived", item.captureId);
      await db.delete("aiQueue", item.captureId);
      if (fresh) { await attach(fresh); await db.put("derived", fresh); }
      broadcast({ type: "capture-updated", captureId: item.captureId });
    } catch (e) {
      logErr("ai-check", e, { captureId: item.captureId });
      const tries = (item.tries || 0) + 1;
      if (tries >= MAX_TRIES) {
        await db.delete("aiQueue", item.captureId);
        const fresh = await db.get("derived", item.captureId);
        if (fresh) { fresh.aiStatus = "failed"; fresh.aiError = String(e && e.message || e).slice(0, 200); await db.put("derived", fresh); }
        broadcast({ type: "capture-updated", captureId: item.captureId });
      } else await db.put("aiQueue", { ...item, tries, at: Date.now() });
    }
  }

  const countIn = (text, name) => { const m = textMatches(text, name); return { count: m.length, firstIndex: m.length ? m[0].index : null }; };

  /**
   * Put the stored check (built-in model first, else Gemini Nano's) back on
   * a record, and say where it stands: done, queued, not checked, or off.
   */
  async function attach(record) {
    if (!record) return record;
    delete record.ai; delete record.aiStatus;
    const state = await getState();
    const spec = specOf(state);
    const settings = await getSettings();
    let ai = null;
    try {
      if (spec) ai = await db.get("ai", aiKey(record, modelIdOf(spec)));
      if (!ai) ai = await db.get("ai", aiKey(record, "nano"));
    } catch (_) { /* store missing on an old database */ }
    if (ai) {
      // Nano annotated brand rows with `stance` before 0.70.0; keep that.
      if (ai.source === "nano") for (const m of record.brandMentions || []) {
        const e = (ai.entities || []).find((x) => x.name.toLowerCase() === String(m.brand || "").toLowerCase());
        if (e && e.nanoStance) m.stance = e.nanoStance;
      }
      applyAi(record, ai, { inCounts: !!settings.aiInCounts, countIn });
      record.aiStatus = "done";
    } else {
      let queued = null;
      try { queued = await db.get("aiQueue", record.captureId); } catch (_) { /* none */ }
      record.aiStatus = queued ? "queued" : state.downloadedAt ? "not-checked" : "off";
    }
    return record;
  }

  /** Gemini Nano's result (Chrome only), kept like the built-in model's. */
  async function saveNano(record, { added = [], stances = new Map() } = {}) {
    const entities = [...stances.entries()].map(([name, nanoStance]) => ({ name, type: "brand", nanoStance, stance: "mentioned" }));
    const missed = added.map((m) => ({ name: m.brand, type: "brand", quote: (m.passages || [])[0] || m.brand }));
    if (!entities.length && !missed.length) return null;
    const ai = { v: 1, source: "nano", model: "Gemini Nano", at: Date.now(), entities, missed };
    await db.put("ai", { key: aiKey(record, "nano"), captureId: record.captureId, ...ai });
    return ai;
  }

  /** Check a record without storing anything (the eval script, and Ask). */
  async function checkNow(rec) {
    const state = await getState();
    const spec = specOf(state);
    if (!state.downloadedAt || !spec) throw new Error("The built-in AI isn't downloaded.");
    await llm("load", { repo: spec.repo, dtype: spec.dtype, device: state.device || "webgpu", host: spec.host || undefined }, 30 * 60 * 1000);
    const t0 = Date.now();
    const ai = await aiCheckRecord(rec, (o) => llm("generate", o, 5 * 60 * 1000), { model: `${MODEL_FAMILY} ${spec.params || spec.label}`.trim(), isPlausible: isPlausibleProseName });
    return { ...ai, wallMs: Date.now() - t0 };
  }

  /**
   * Ask (0.73.0): a question about the user's own captures, answered by the
   * built-in model with the read-only tools in lib/assistantTools.js.
   * A test stand-in may carry a script of replies instead of a model.
   */
  async function askQuestion({ question, history = [], data }) {
    const state = await getState();
    const spec = specOf(state);
    if (!state.downloadedAt || !spec) throw new Error("The built-in AI isn't downloaded.");
    let generate;
    if (state.custom && Array.isArray(state.custom.script)) {
      const script = [...state.custom.script];
      generate = async () => ({ text: script.length ? script.shift() : "" });
    } else {
      await llm("load", { repo: spec.repo, dtype: spec.dtype, device: state.device || "webgpu", host: spec.host || undefined }, 30 * 60 * 1000);
      generate = (o) => llm("generate", o, 5 * 60 * 1000);
    }
    const t0 = Date.now();
    const r = await runAsk({ question, history, generate, data });
    return { ...r, ms: Date.now() - t0, model: `${MODEL_FAMILY} ${spec.params || spec.label}`.trim() };
  }

  return { askQuestion, checkNow, getState, setState, status, hardware, download, remove, enqueue, kick, attach, saveNano, onProgress, specOf, llm };
}
