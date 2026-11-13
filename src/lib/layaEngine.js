/*
 * layaEngine.js — Laya itself, in the offscreen page beside the built-in AI
 * model (0.83.0; src/lib/laya.js asks it the questions).
 *
 * Laya is a plain ONNX graph (mmBERT encoder plus a decision head) that
 * Transformers.js has no class for, so it runs on ONNX Runtime's own API
 * (src/vendor/transformers/ort.webgpu.min.mjs, the same build and .wasm as
 * the rest), with the tokenizer from Transformers.js. Its five files are
 * fetched once from Hugging Face into the browser's Cache Storage, and read
 * from there after: data, never code. One job at a time; unloaded after two
 * minutes idle to give the memory back.
 */
const VENDOR = "../vendor/transformers/";
const CACHE_NAME = "laya-cache";
const IDLE_MS = 2 * 60 * 1000;
// Sequences per run of the model: a 1,024-token sequence through 22 layers
// is heavy on the processor, so an answer's questions go a few at a time.
const BATCH = 4;
export const LAYA_FILES = ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"];

let ort = null;
let tf = null;
let current = null; // { key, session, tok, cfg, device, loadedAt }
let loading = null;
let idleTimer = null;
let busy = Promise.resolve();

const vendorUrl = (p) => (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
  ? chrome.runtime.getURL(`src/vendor/transformers/${p}`) : new URL(VENDOR + p, import.meta.url).href);

/** Where a file of the bundle lives. */
export function fileUrl(spec, file) {
  const host = String(spec.host || "https://huggingface.co/").replace(/\/?$/, "/");
  const sub = spec.sub ? `${String(spec.sub).replace(/^\/|\/$/g, "")}/` : "";
  return `${host}${spec.repo}/resolve/${spec.rev || "main"}/${sub}${file}`;
}

async function runtime() {
  if (!ort) {
    ort = await import(VENDOR + "ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = { mjs: vendorUrl("ort-wasm-simd-threaded.asyncify.mjs"), wasm: vendorUrl("ort-wasm-simd-threaded.asyncify.wasm") };
    const cores = Number(globalThis.navigator && navigator.hardwareConcurrency) || 2;
    // Half the cores, at most 4, as for the AI model (lib/llmEngine.js).
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
  }
  if (!tf) tf = await import(VENDOR + "transformers.min.js");
  return { ort, tf };
}

// One file, from the cache or fetched into it, with progress.
async function getFile(spec, file, onProgress, { asText = false } = {}) {
  const url = fileUrl(spec, file);
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(url);
  if (!res) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${file}: ${r.status} from ${new URL(url).host}`);
    const total = Number(r.headers.get("content-length")) || 0;
    const reader = r.body.getReader();
    const parts = [];
    let loaded = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      const now = Date.now();
      if (onProgress && now - last > 300) { last = now; onProgress({ status: "progress", file, loaded, total, pct: total ? Math.round((loaded * 100) / total) : null }); }
    }
    const blob = new Blob(parts);
    await cache.put(url, new Response(blob, { headers: { "content-length": String(blob.size), "content-type": "application/octet-stream" } }));
    if (onProgress) onProgress({ status: "done", file, loaded: blob.size, total: blob.size, pct: 100 });
    res = await cache.match(url);
  }
  return asText ? res.text() : new Uint8Array(await res.arrayBuffer());
}

const keyOf = (spec) => JSON.stringify([spec.host || "", spec.repo, spec.rev || "main", spec.sub || ""]);

/**
 * Download (the first time) and load the model.
 * @param {{repo: string, rev?: string, sub?: string, host?: string, device?: "webgpu"|"wasm", onProgress?: Function}} spec
 */
export async function load(spec) {
  const key = keyOf(spec);
  if (current && current.key === key) { touch(); return info(); }
  if (loading && loading.key === key) return loading.p;
  const p = (async () => {
    const { ort: o, tf: t } = await runtime();
    await unload();
    const prog = (x) => { try { spec.onProgress && spec.onProgress(x); } catch (_) { /* ignore */ } };
    const cfg = JSON.parse(await getFile(spec, "laya_config.json", prog, { asText: true }));
    const tokJson = JSON.parse(await getFile(spec, "tokenizer/tokenizer.json", prog, { asText: true }));
    const tokCfg = JSON.parse(await getFile(spec, "tokenizer/tokenizer_config.json", prog, { asText: true }));
    const graph = await getFile(spec, "laya.onnx", prog);
    const data = await getFile(spec, "laya.onnx.data", prog);
    const tok = new t.PreTrainedTokenizer(tokJson, tokCfg);
    let device = spec.device || "webgpu";
    if (device === "webgpu") {
      let adapter = null;
      try { adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (_) { adapter = null; }
      if (!adapter) device = "wasm";
    }
    const opts = (d) => ({ executionProviders: [d], externalData: [{ path: "laya.onnx.data", data }], graphOptimizationLevel: "all" });
    let session;
    try { session = await o.InferenceSession.create(graph, opts(device)); } catch (e) {
      if (device !== "webgpu") throw e;
      device = "wasm";
      session = await o.InferenceSession.create(graph, opts(device));
    }
    current = { key, session, tok, cfg, device, repo: spec.repo, loadedAt: Date.now() };
    prog({ status: "ready", pct: 100 });
    touch();
    return info();
  })();
  loading = { key, p };
  try { return await p; } finally { if (loading && loading.key === key) loading = null; }
}

function info() {
  return current ? { loaded: true, repo: current.repo, device: current.device, loadedAt: current.loadedAt, maxLen: current.cfg.max_len, headMaxLen: current.cfg.head_max_len, temperature: current.cfg.temperature || [1, 1, 1] }
    : { loaded: false };
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
  if (c && c.session && c.session.release) { try { await c.session.release(); } catch (_) { /* gone */ } }
}

/** Token ids for some text, without [CLS] and [SEP]: laya.js builds those. */
export function encoder() {
  if (!current) throw new Error("Laya isn't loaded");
  const { tok } = current;
  // The bundle renames mmBERT's <bos> <eos> <mask> <pad> to these (ids 2 1 4 0).
  const id = (s) => tok.convert_tokens_to_ids(s);
  return { cls: id("[CLS]"), sep: id("[SEP]"), mask: id("[MASK]"), pad: id("[PAD]") ?? 0, maskToken: "[MASK]", encode: (s) => tok.encode(s, { add_special_tokens: false }) };
}

/**
 * Run the model on built sequences.
 * @param {{ids: number[], markers: number[], qtype: number}[]} items
 * @returns {Promise<{logits: number[][], ms: number}>}
 */
export function run(items) {
  const job = busy.then(async () => {
    if (!current) throw new Error("Laya isn't loaded");
    touch();
    const { session } = current;
    const pad = encoder().pad;
    const t0 = performance.now();
    const out = new Array(items.length);
    // Similar lengths together, so little is padding.
    const order = items.map((_, i) => i).sort((a, b) => items[a].ids.length - items[b].ids.length);
    for (let s = 0; s < order.length; s += BATCH) {
      const idx = order.slice(s, s + BATCH);
      const B = idx.length;
      const L = Math.max(...idx.map((i) => items[i].ids.length));
      const K = Math.max(...idx.map((i) => items[i].markers.length));
      const ids = new BigInt64Array(B * L).fill(BigInt(pad));
      const att = new BigInt64Array(B * L);
      const mpos = new BigInt64Array(B * K);
      const mmask = new Uint8Array(B * K);
      const qt = new BigInt64Array(B);
      idx.forEach((i, r) => {
        const it = items[i];
        it.ids.forEach((v, j) => { ids[r * L + j] = BigInt(v); att[r * L + j] = 1n; });
        it.markers.forEach((m, k) => { mpos[r * K + k] = BigInt(m); mmask[r * K + k] = 1; });
        qt[r] = BigInt(it.qtype || 0);
      });
      const feeds = {
        input_ids: new ort.Tensor("int64", ids, [B, L]),
        attention_mask: new ort.Tensor("int64", att, [B, L]),
        marker_pos: new ort.Tensor("int64", mpos, [B, K]),
        marker_mask: new ort.Tensor("bool", mmask, [B, K]),
        qtype: new ort.Tensor("int64", qt, [B]),
      };
      const res = await session.run(feeds);
      const lg = res.logits.data;
      idx.forEach((i, r) => { out[i] = Array.from(lg.slice(r * K, r * K + items[i].markers.length)); });
    }
    touch();
    return { logits: out, ms: Math.round(performance.now() - t0) };
  });
  busy = job.catch(() => {});
  return job;
}

/** Bytes of the bundle already in the cache. */
export async function cachedBytes(spec) {
  try {
    const c = await caches.open(CACHE_NAME);
    let bytes = 0, files = 0;
    for (const f of LAYA_FILES) {
      const r = await c.match(fileUrl(spec, f));
      if (!r) continue;
      files++;
      bytes += Number(r.headers.get("content-length")) || 0;
    }
    return { files, bytes, complete: files === LAYA_FILES.length };
  } catch (_) { return { files: 0, bytes: 0, complete: false }; }
}

export async function removeCached(spec) {
  await unload();
  try {
    const c = await caches.open(CACHE_NAME);
    let n = 0;
    for (const f of LAYA_FILES) if (await c.delete(fileUrl(spec, f))) n++;
    return { removed: n };
  } catch (e) { return { removed: 0, error: String(e && e.message || e) }; }
}

/**
 * "Load from a folder": the bundle's files picked from disk (a copy of the
 * repository's multilingual/ folder), put under the addresses load() reads.
 */
export async function importFiles(spec, files) {
  const c = await caches.open(CACHE_NAME);
  let n = 0;
  for (const f of files || []) {
    const p = String(f.path || "").replace(/\\/g, "/");
    const name = LAYA_FILES.find((x) => p === x || p.endsWith(`/${x}`));
    if (!name) continue;
    await c.put(fileUrl(spec, name), new Response(f.blob, { headers: { "content-length": String(f.blob.size), "content-type": "application/octet-stream" } }));
    n++;
  }
  return { imported: n };
}
