/*
 * llmEngine.js — the built-in AI model itself (0.70.0). Runs where the model
 * lives: Chrome's offscreen document (ui/offscreen.js), or a background page
 * in browsers that have one. Never in the service worker: WebGPU there is
 * unreliable and a worker restart would drop a 1.4 GB model mid-answer.
 *
 * One model at a time, one job at a time. The weights are fetched once from
 * Hugging Face (the only network use, data not code) into the browser's
 * Cache Storage, and every later load reads them from there. Nothing the
 * user captured ever leaves this page: prompts are built and answered here.
 *
 * The runtime is Transformers.js 4.3.1 with ONNX Runtime Web, vendored in
 * src/vendor/transformers/ (scripts/vendor-transformers.mjs).
 */
const VENDOR = "../vendor/transformers/";
const CACHE_NAME = "transformers-cache";
const IDLE_MS = 2 * 60 * 1000;

let tf = null;          // the library, imported on first use
let current = null;     // { key, repo, device, dtype, tok, model, loadedAt }
let loading = null;     // the load in flight
let idleTimer = null;
let busy = Promise.resolve();

const url = (p) => (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
  ? chrome.runtime.getURL(`src/vendor/transformers/${p}`) : new URL(VENDOR + p, import.meta.url).href);

async function lib(host) {
  if (!tf) tf = await import(VENDOR + "transformers.min.js");
  const env = tf.env;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = false; // Cache Storage can't key chrome-extension:// URLs
  env.remoteHost = host || "https://huggingface.co/";
  env.remotePathTemplate = "{model}/resolve/{revision}/";
  env.backends.onnx.wasm.wasmPaths = { mjs: url("ort-wasm-simd-threaded.asyncify.mjs"), wasm: url("ort-wasm-simd-threaded.asyncify.wasm") };
  // Threads need cross-origin isolation, which extension pages don't have.
  env.backends.onnx.wasm.numThreads = 1;
  return tf;
}

/** What this computer offers the model: graphics chip, memory, free space. */
export async function hardware() {
  const out = { webgpu: false, maxBufferSize: null, maxStorageBufferBindingSize: null, deviceMemory: null, freeBytes: null, adapter: null };
  try {
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (a) {
        out.webgpu = true;
        out.maxBufferSize = a.limits.maxBufferSize;
        out.maxStorageBufferBindingSize = a.limits.maxStorageBufferBindingSize;
        const info = a.info || {};
        out.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || null;
        out.fallback = !!(info.isFallbackAdapter || a.isFallbackAdapter);
      }
    }
  } catch (_) { /* no graphics chip access */ }
  try { out.deviceMemory = navigator.deviceMemory || null; } catch (_) { /* not exposed */ }
  try {
    const est = await navigator.storage.estimate();
    out.freeBytes = Math.max(0, (est.quota || 0) - (est.usage || 0));
  } catch (_) { /* unknown */ }
  return out;
}

const keyOf = (o) => JSON.stringify([o.repo, o.device, o.dtype, o.host || ""]);

/**
 * Load a model (downloading it the first time).
 * @param {{repo: string, dtype: any, device?: "webgpu"|"wasm", host?: string, onProgress?: Function}} o
 */
export async function load(o) {
  const key = keyOf(o);
  if (current && current.key === key) { touch(); return info(); }
  if (loading && loading.key === key) return loading.p;
  const p = (async () => {
    const t = await lib(o.host);
    await unload();
    const progress = (e) => { try { o.onProgress && o.onProgress(e); } catch (_) { /* ignore */ } };
    const opts = { progress_callback: progress };
    const tok = await t.AutoTokenizer.from_pretrained(o.repo, opts);
    let device = o.device || "webgpu", model;
    // No adapter, no WebGPU: once ONNX Runtime has failed to start WebGPU it
    // keeps asking for it on this page, so the processor is chosen up front.
    if (device === "webgpu") {
      let adapter = null;
      try { adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (_) { adapter = null; }
      if (!adapter) device = "wasm";
    }
    try {
      model = await t.AutoModelForCausalLM.from_pretrained(o.repo, { ...opts, device, dtype: o.dtype[device] || o.dtype });
    } catch (e) {
      // A graphics chip that can't run it: fall back to the processor.
      if (device !== "webgpu") throw e;
      device = "wasm";
      model = await t.AutoModelForCausalLM.from_pretrained(o.repo, { ...opts, device, dtype: o.dtype.wasm || o.dtype });
    }
    current = { key, repo: o.repo, device, tok, model, loadedAt: Date.now() };
    touch();
    return info();
  })();
  loading = { key, p };
  try { return await p; } finally { if (loading && loading.key === key) loading = null; }
}

function info() {
  return current ? { loaded: true, repo: current.repo, device: current.device, loadedAt: current.loadedAt } : { loaded: false };
}
export const status = () => ({ ...info(), loading: !!loading });

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { unload(); }, IDLE_MS);
}

export async function unload() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const c = current;
  current = null;
  if (c && c.model && c.model.dispose) { try { await c.model.dispose(); } catch (_) { /* gone */ } }
}

// Qwen3.5 may still open a thinking block; only what follows is the reply.
export function stripThinking(s) {
  return String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}

/**
 * One reply. Greedy decoding (no sampling), so the same answer always gives
 * the same result; non-thinking mode for speed.
 * @param {{messages: {role: string, content: string}[], maxTokens?: number}} o
 */
export function generate(o) {
  const run = busy.then(async () => {
    if (!current) throw new Error("model not loaded");
    touch();
    const { tok, model } = current;
    const t0 = performance.now();
    // Tools (Ask, 0.73.0) go into Qwen's chat template, which lists them
    // for the model and reads its <tool_call> replies.
    const inputs = tok.apply_chat_template(o.messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false, ...(o.tools ? { tools: o.tools } : {}) });
    const n = inputs.input_ids.dims[1];
    const out = await model.generate({ ...inputs, max_new_tokens: o.maxTokens || 384, do_sample: false, repetition_penalty: 1.05 });
    const ids = out.slice(null, [n, null]);
    // Tool calls are written with special tokens; keep them when tools were offered.
    const text = tok.batch_decode(ids, { skip_special_tokens: !o.tools })[0] || "";
    touch();
    return { text: stripThinking(text), ms: Math.round(performance.now() - t0), inTokens: n, outTokens: ids.dims[1] };
  });
  busy = run.catch(() => {});
  return run;
}

/** Bytes of this repo's files already in the browser's cache. */
export async function cachedBytes(repo, host) {
  try {
    const c = await caches.open(CACHE_NAME);
    let total = 0, files = 0;
    const prefix = `${host || "https://huggingface.co/"}${repo}/`;
    for (const req of await c.keys()) {
      if (!req.url.startsWith(prefix)) continue;
      files++;
      const r = await c.match(req);
      const len = Number(r && r.headers.get("content-length"));
      total += Number.isFinite(len) ? len : 0;
    }
    return { files, bytes: total };
  } catch (_) { return { files: 0, bytes: 0 }; }
}

/** Remove this repo's files from the cache (Settings → Remove model). */
export async function removeCached(repo, host) {
  await unload();
  try {
    const c = await caches.open(CACHE_NAME);
    const prefix = `${host || "https://huggingface.co/"}${repo}/`;
    let n = 0;
    for (const req of await c.keys()) if (req.url.startsWith(prefix)) { await c.delete(req); n++; }
    return { removed: n };
  } catch (e) { return { removed: 0, error: String(e && e.message || e) }; }
}

/**
 * Put files the user picked from a folder into the cache under the
 * addresses the loader asks for, so a computer that can't reach Hugging Face
 * can still load the model ("Load from a folder").
 * @param {{repo: string, host?: string, files: {path: string, blob: Blob}[]}} o
 */
export async function importFiles(o) {
  const c = await caches.open(CACHE_NAME);
  const base = `${o.host || "https://huggingface.co/"}${o.repo}/resolve/main/`;
  let n = 0;
  for (const f of o.files || []) {
    // "Qwen3.5-2B-ONNX-OPT/onnx/x.onnx" -> "onnx/x.onnx"; "…/config.json" -> "config.json".
    const p = String(f.path || "").replace(/\\/g, "/");
    const at = p.lastIndexOf("onnx/");
    const path = at >= 0 && (at === 0 || p[at - 1] === "/") ? p.slice(at) : p.split("/").pop();
    await c.put(base + path, new Response(f.blob, { headers: { "content-length": String(f.blob.size), "content-type": "application/octet-stream" } }));
    n++;
  }
  return { imported: n };
}
