/*
 * meaningEngine.js — the "search by meaning" model, in the offscreen page
 * beside the built-in AI (1.0.5; lib/meaning.js has the arithmetic).
 *
 * multilingual-e5-small, quantized (~135 MB with its tokenizer), fetched
 * once from Hugging Face at a fixed revision into Cache Storage and read
 * from there after: data, never code. It runs on ONNX Runtime (WebGPU, else
 * the processor), with the tokenizer from Transformers.js, both vendored.
 * Passage vectors are kept in this page's own IndexedDB ("cito-meaning"),
 * so each passage is embedded once. Unloaded after two minutes idle.
 */
import { MEANING_SPEC, meanPool, rankByMeaning } from "./meaning.js";

const VENDOR = "../vendor/transformers/";
const CACHE_NAME = "meaning-cache";
const IDLE_MS = 2 * 60 * 1000;
const MAX_TOKENS = 256;

let ort = null, tf = null, current = null, loading = null, idleTimer = null;
let busy = Promise.resolve();

const vendorUrl = (p) => chrome.runtime.getURL(`src/vendor/transformers/${p}`);
const fileUrl = (spec, file) => `${String(spec.host || "https://huggingface.co/").replace(/\/?$/, "/")}${spec.repo}/resolve/${spec.rev || "main"}/${file}`;

async function runtime() {
  if (!ort) {
    ort = await import(VENDOR + "ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = { mjs: vendorUrl("ort-wasm-simd-threaded.asyncify.mjs"), wasm: vendorUrl("ort-wasm-simd-threaded.asyncify.wasm") };
    const cores = Number(navigator.hardwareConcurrency) || 2;
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor(cores / 2))) : 1;
  }
  if (!tf) tf = await import(VENDOR + "transformers.min.js");
  return { ort, tf };
}

async function getFile(spec, file, onProgress, { asText = false } = {}) {
  const url = fileUrl(spec, file);
  const cache = await caches.open(CACHE_NAME);
  let res = await cache.match(url);
  if (!res) {
    // A dropped or slow connection is tried again, three times in all, a few
    // seconds apart (1.0.6: "Failed to fetch" four times in a row, one per
    // click, on one computer).
    let r = null;
    for (let i = 0; ; i++) {
      try { r = await fetch(url); break; } catch (e) {
        if (i >= 2) throw e;
        await new Promise((ok) => setTimeout(ok, (i + 1) * 3000));
      }
    }
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
      if (onProgress && Date.now() - last > 300) { last = Date.now(); onProgress({ status: "progress", file, loaded, total, pct: total ? Math.round((loaded * 100) / total) : null }); }
    }
    const blob = new Blob(parts);
    await cache.put(url, new Response(blob, { headers: { "content-length": String(blob.size), "content-type": "application/octet-stream" } }));
    res = await cache.match(url);
  }
  return asText ? res.text() : new Uint8Array(await res.arrayBuffer());
}

function touch() { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { unload(); }, IDLE_MS); }

/** Download (the first time) and load. */
export async function load(spec = {}) {
  const s = { ...MEANING_SPEC, ...spec };
  if (current) { touch(); return info(); }
  if (loading) return loading;
  loading = (async () => {
    const { ort: o, tf: t } = await runtime();
    const prog = (x) => { try { s.onProgress && s.onProgress(x); } catch (_) { /* ignore */ } };
    const tokJson = JSON.parse(await getFile(s, "tokenizer.json", prog, { asText: true }));
    const tokCfg = JSON.parse(await getFile(s, "tokenizer_config.json", prog, { asText: true }));
    await getFile(s, "config.json", prog, { asText: true });
    const graph = await getFile(s, s.model, prog);
    const tok = new t.PreTrainedTokenizer(tokJson, tokCfg);
    let device = s.device || "webgpu";
    if (device === "webgpu") { let a = null; try { a = navigator.gpu ? await navigator.gpu.requestAdapter() : null; } catch (_) { a = null; } if (!a) device = "wasm"; }
    let session;
    try { session = await o.InferenceSession.create(graph, { executionProviders: [device], graphOptimizationLevel: "all" }); } catch (e) {
      if (device !== "webgpu") throw e;
      device = "wasm";
      session = await o.InferenceSession.create(graph, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    }
    current = { session, tok, device, loadedAt: Date.now() };
    prog({ status: "ready", pct: 100 });
    touch();
    return info();
  })();
  try { return await loading; } finally { loading = null; }
}

function info() { return current ? { loaded: true, device: current.device, loadedAt: current.loadedAt } : { loaded: false }; }
export const status = () => ({ ...info(), loading: !!loading });

export async function unload() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const c = current;
  current = null;
  if (c && c.session && c.session.release) { try { await c.session.release(); } catch (_) { /* gone */ } }
}

/** Vectors for texts (already prefixed "query: " or "passage: "). */
async function embed(texts) {
  if (!current) await load();
  touch();
  const { session, tok } = current;
  const enc = texts.map((x) => tok.encode(x).slice(0, MAX_TOKENS));
  const len = Math.max(...enc.map((e) => e.length));
  const ids = new BigInt64Array(texts.length * len), mask = new BigInt64Array(texts.length * len);
  enc.forEach((e, r) => e.forEach((id, c) => { ids[r * len + c] = BigInt(id); mask[r * len + c] = 1n; }));
  const feeds = { input_ids: new ort.Tensor("int64", ids, [texts.length, len]), attention_mask: new ort.Tensor("int64", mask, [texts.length, len]) };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(texts.length * len), [texts.length, len]);
  const out = await session.run(feeds);
  const hidden = out.last_hidden_state || out[session.outputNames[0]];
  const dims = hidden.dims[2];
  const m = Array.from(mask, (x) => Number(x));
  return texts.map((_, r) => meanPool(hidden.data, dims, m, len, r));
}

// This page's store of passage vectors.
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => { const r = indexedDB.open("cito-meaning", 1); r.onupgradeneeded = () => r.result.createObjectStore("vec"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return dbp;
}
const idb = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction("vec", mode); const st = tx.objectStore("vec"); const r = fn(st); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }); };
const getVec = async (id) => { const x = await idb("readonly", (st) => st.get(id)); return x ? { h: x.h, v: new Float32Array(x.v) } : null; };
const putVec = (id, rec) => idb("readwrite", (st) => st.put({ h: rec.h, v: rec.v.buffer.slice(0) }, id));

/** Rank passages by meaning (one job at a time). */
export function rank({ query, docs, cap, min }) {
  const job = busy.then(() => rankByMeaning(docs || [], query, { embed, get: getVec, put: putVec, cap, min }));
  busy = job.catch(() => {});
  return job;
}

export async function cachedBytes(spec = {}) {
  const s = { ...MEANING_SPEC, ...spec };
  try {
    const c = await caches.open(CACHE_NAME);
    let bytes = 0, files = 0;
    for (const f of s.files) { const r = await c.match(fileUrl(s, f)); if (!r) continue; files++; bytes += Number(r.headers.get("content-length")) || 0; }
    return { files, bytes, complete: files === s.files.length };
  } catch (_) { return { files: 0, bytes: 0, complete: false }; }
}

/** Remove the model and every stored vector. */
export async function removeCached(spec = {}) {
  const s = { ...MEANING_SPEC, ...spec };
  await unload();
  let n = 0;
  try { const c = await caches.open(CACHE_NAME); for (const f of s.files) if (await c.delete(fileUrl(s, f))) n++; } catch (_) { /* nothing cached */ }
  try { if (dbp) { (await dbp).close(); dbp = null; } await new Promise((r) => { const q = indexedDB.deleteDatabase("cito-meaning"); q.onsuccess = q.onerror = q.onblocked = () => r(); }); } catch (_) { /* no store */ }
  return { removed: n };
}
