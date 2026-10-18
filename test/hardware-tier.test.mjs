/*
 * Which built-in AI model a computer gets (src/lib/llmTiers.js, 0.70.0).
 * Run: node test/hardware-tier.test.mjs
 */
import { pickTier, TIERS, TIER_ORDER, sizeLabel } from "../src/lib/llmTiers.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const GB = 1024 ** 3;
const t = (hw) => pickTier(hw);

console.log("the three sizes");
check("Light, Standard, Strong, smallest first", TIER_ORDER.join() === "light,standard,strong" && TIERS.light.bytes < TIERS.standard.bytes && TIERS.standard.bytes < TIERS.strong.bytes);
check("all Qwen3.5 builds from onnx-community", TIER_ORDER.every((k) => /^onnx-community\/Qwen3\.5-/.test(TIERS[k].repo)));
check("sizes read in GB", sizeLabel("standard") === "1.4 GB" && sizeLabel("light") === "0.5 GB", sizeLabel("standard") + " " + sizeLabel("light"));

console.log("picking");
{
  const a = t({ webgpu: true, maxBufferSize: 4 * GB, deviceMemory: 8, freeBytes: 50 * GB });
  check("a laptop with a graphics chip: Standard, Strong offered", a.tier === "standard" && a.possible.includes("strong") && a.device === "webgpu", JSON.stringify(a));
  const b = t({ webgpu: false, deviceMemory: 8, freeBytes: 50 * GB });
  check("no graphics chip: Light, on the processor, and it says why", b.tier === "light" && b.device === "wasm" && /processor/.test(b.reason), JSON.stringify(b));
  const c = t({ webgpu: true, maxBufferSize: 4 * GB, deviceMemory: 2, freeBytes: 50 * GB });
  check("2 GB of memory: Light", c.tier === "light" && /memory/.test(c.reason), JSON.stringify(c));
  const d = t({ webgpu: true, maxBufferSize: 256 * 1024 * 1024, deviceMemory: 8, freeBytes: 50 * GB });
  check("a graphics chip with small buffers: Light", d.tier === "light" && /largest piece/.test(d.reason), JSON.stringify(d));
  const e = t({ webgpu: true, maxBufferSize: 4 * GB, deviceMemory: 8, freeBytes: 1 * GB });
  check("1 GB free: Light, since Standard doesn't fit", e.tier === "light" && !e.possible.includes("standard"), JSON.stringify(e));
  const f = t({ webgpu: true, deviceMemory: 8, freeBytes: 0.2 * GB });
  check("almost no space: nothing, and it says how much is needed", f.tier === null && /free/.test(f.reason), JSON.stringify(f));
  const g = t({});
  check("nothing known: Light on the processor", g.tier === "light" && g.device === "wasm");
  const h = t({ webgpu: true, maxBufferSize: 2 * GB, deviceMemory: 4, freeBytes: 50 * GB });
  check("4 GB of memory: Standard, but Strong not offered", h.tier === "standard" && !h.possible.includes("strong"), JSON.stringify(h));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
