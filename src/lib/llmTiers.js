/*
 * llmTiers.js — which built-in AI model this computer gets (0.70.0).
 *
 * The built-in AI is Qwen3.5 (Alibaba, Apache-2.0, 201 languages), run on
 * the user's own computer through Transformers.js. It comes in three sizes;
 * the hardware check below picks one and says why, and the user can choose
 * another. Sizes are the 4-bit files the browser downloads once, from the
 * onnx-community builds on Hugging Face (text only: no vision files).
 */

const GB = 1024 ** 3;

export const TIERS = {
  light: {
    id: "light", label: "Light", params: "0.8B",
    repo: "onnx-community/Qwen3.5-0.8B-Text-ONNX",
    // model_q4f16.onnx(+_data) or model_q4 on CPU, plus the tokenizer.
    bytes: 0.49 * GB,
    dtype: { webgpu: "q4f16", wasm: "q4" },
    for: "Older or weaker computers, and computers without graphics-chip access",
  },
  standard: {
    id: "standard", label: "Standard", params: "2B",
    repo: "onnx-community/Qwen3.5-2B-ONNX-OPT",
    // decoder_model_merged_q4f16 (1.09 GB) + embed_tokens_q4f16 (0.29 GB) + tokenizer.
    bytes: 1.40 * GB,
    dtype: {
      webgpu: { embed_tokens: "q4f16", decoder_model_merged: "q4f16" },
      wasm: { embed_tokens: "q4", decoder_model_merged: "q4" },
    },
    for: "Most laptops",
  },
  strong: {
    id: "strong", label: "Strong", params: "4B",
    repo: "onnx-community/Qwen3.5-4B-ONNX-OPT",
    // decoder q4f16 (2.07 + 0.37 GB) + embed_tokens q4f16 (0.37 GB) + tokenizer.
    bytes: 2.83 * GB,
    dtype: {
      webgpu: { embed_tokens: "q4f16", decoder_model_merged: "q4f16" },
      wasm: { embed_tokens: "q4", decoder_model_merged: "q4" },
    },
    for: "Powerful computers, and the Ask assistant",
  },
};
export const TIER_ORDER = ["light", "standard", "strong"];
export const MODEL_LICENCE = "Apache-2.0";
export const MODEL_FAMILY = "Qwen3.5";

const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;
export const sizeLabel = (tierId) => (TIERS[tierId] ? fmtGB(TIERS[tierId].bytes) : "");

/**
 * The tier for this computer, and why.
 * @param {{webgpu?: boolean, maxBufferSize?: number, deviceMemory?: number, freeBytes?: number}} hw
 *   webgpu: a graphics adapter was found; maxBufferSize: its largest buffer;
 *   deviceMemory: navigator.deviceMemory (GB, Chrome caps it at 8);
 *   freeBytes: storage quota left (navigator.storage.estimate()).
 * @returns {{tier: string|null, reason: string, possible: string[], device: "webgpu"|"wasm"}}
 */
export function pickTier(hw = {}) {
  const gpu = !!hw.webgpu;
  const mem = Number.isFinite(hw.deviceMemory) ? hw.deviceMemory : null;
  const free = Number.isFinite(hw.freeBytes) ? hw.freeBytes : null;
  const buf = Number.isFinite(hw.maxBufferSize) ? hw.maxBufferSize : null;
  // Room for the files plus a margin: the browser keeps them in its cache.
  const fits = (t) => free == null || free >= TIERS[t].bytes * 1.25;
  const memOk = (t) => mem == null || mem >= (t === "strong" ? 8 : t === "standard" ? 4 : 2);
  // The 2B and 4B embedding tables are single buffers of ~0.3–0.4 GB.
  const bufOk = (t) => t === "light" || buf == null || buf >= 0.45 * GB;
  // 0.74.0: on the processor the model now gets several threads (extension
  // pages are cross-origin isolated), so a computer with enough cores and
  // memory runs Standard there too, instead of being held to Light.
  const cores = Number.isFinite(hw.cores) ? hw.cores : null;
  const cpuStrong = !gpu && cores != null && cores >= 8 && (mem == null || mem >= 8) && hw.isolated !== false;
  const possible = TIER_ORDER.filter((t) => fits(t) && memOk(t) && (t === "light" || (gpu && bufOk(t)) || (cpuStrong && t === "standard")));
  const device = gpu ? "webgpu" : "wasm";
  if (!possible.length) {
    return { tier: null, device, possible, reason: free != null && !fits("light")
      ? `Not enough free space: the smallest model needs about ${fmtGB(TIERS.light.bytes * 1.25)}, ${fmtGB(Math.max(0, free))} is free.`
      : "This computer is below what the smallest model needs." };
  }
  if (!gpu) {
    if (possible.includes("standard")) return { tier: "standard", device, possible, reason: `No graphics-chip access here (WebGPU), so the model runs on the processor — on ${Math.min(8, cores - 1)} of its ${cores} cores at once, enough for Standard. "Test this computer" times it.` };
    return { tier: "light", device, possible, reason: `No graphics-chip access here (WebGPU), so the model runs on the processor${cores ? ` (${cores} cores)` : ""}. Light is the size that is quick enough that way. Chrome's own built-in AI, where available, is faster still.` };
  }
  // Standard is the default; Strong is offered, not picked, because it is
  // twice the download and slower, and only the Ask assistant needs it.
  if (possible.includes("standard")) {
    return { tier: "standard", device, possible, reason: possible.includes("strong")
      ? "Graphics chip found with plenty of memory: Standard fits well. Strong also fits, if you plan to use Ask."
      : "Graphics chip found: Standard fits this computer." };
  }
  return { tier: "light", device, possible, reason: !memOk("standard") ? "This computer has under 4 GB of memory, so Light is the safe size."
    : !bufOk("standard") ? "The graphics chip can't hold the Standard model's largest piece, so Light is the safe size."
    : `Not enough free space for Standard (${sizeLabel("standard")}), so Light.` };
}
