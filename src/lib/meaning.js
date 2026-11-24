/*
 * meaning.js — search by meaning, the parts that are plain arithmetic
 * (1.0.5, Stage 3 of ASK-ARCHITECTURE.md §4.7). The model runs in the
 * offscreen page (lib/meaningEngine.js); this file is what both it and the
 * tests share.
 *
 * The model is multilingual-e5-small (384 numbers per text, 100+ languages):
 * a question is embedded as "query: …", a passage as "passage: …", both
 * mean-pooled and scaled to length 1, so their dot product is how alike they
 * are. A passage's vector is kept with a hash of its text, so an answer
 * re-read with different text is embedded again.
 */
export const MEANING_SPEC = {
  repo: "Xenova/multilingual-e5-small",
  rev: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  files: ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json", "config.json"],
  model: "onnx/model_quantized.onnx",
  bytes: 135_500_000,
  dims: 384,
};
// Passages embedded in one call at most (the rest wait for the next search
// or the background indexing): ~2,000 short passages is about a minute on a
// laptop processor.
export const EMBED_CAP = 2000;

/** A short, stable hash of a text (FNV-1a). */
export function textHash(s) {
  let h = 0x811c9dc5;
  const t = String(s || "");
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Mean of the token vectors where the mask is 1, scaled to length 1. */
export function meanPool(data, dims, mask, seqLen, row) {
  const out = new Float32Array(dims);
  let n = 0;
  for (let t = 0; t < seqLen; t++) {
    if (!mask[row * seqLen + t]) continue;
    n++;
    const off = (row * seqLen + t) * dims;
    for (let d = 0; d < dims; d++) out[d] += data[off + d];
  }
  let norm = 0;
  for (let d = 0; d < dims; d++) { out[d] /= n || 1; norm += out[d] * out[d]; }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d++) out[d] /= norm;
  return out;
}

export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/**
 * Rank passages by meaning.
 * @param {{id: string, text: string}[]} docs  the pool, in order of preference for embedding (newest first)
 * @param {string} query
 * @param {{embed: (texts: string[]) => Promise<Float32Array[]>, get: (id: string) => Promise<{h: string, v: Float32Array}|null>, put: (id: string, rec: {h: string, v: Float32Array}) => Promise<void>, cap?: number, min?: number}} store
 * @returns {Promise<{ids: string[], embedded: number, skipped: number}>} ids best first, only those alike enough (min)
 */
export async function rankByMeaning(docs, query, { embed, get, put, cap = EMBED_CAP, min = 0.78 } = {}) {
  const [q] = await embed([`query: ${String(query || "").slice(0, 500)}`]);
  const scored = [];
  const missing = [];
  for (const d of docs) {
    const h = textHash(d.text);
    const rec = await get(d.id);
    if (rec && rec.h === h) scored.push({ id: d.id, s: dot(q, rec.v) });
    else missing.push({ ...d, h });
  }
  const todo = missing.slice(0, cap);
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16);
    const vs = await embed(batch.map((d) => `passage: ${d.text.slice(0, 1200)}`));
    for (let j = 0; j < batch.length; j++) { await put(batch[j].id, { h: batch[j].h, v: vs[j] }); scored.push({ id: batch[j].id, s: dot(q, vs[j]) }); }
  }
  scored.sort((a, b) => b.s - a.s);
  return { ids: scored.filter((x) => x.s >= min).map((x) => x.id), embedded: todo.length, skipped: missing.length - todo.length };
}
