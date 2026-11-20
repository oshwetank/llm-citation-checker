/*
 * model-download-load.test.mjs — downloading the models doesn't swing the
 * bar or overload the computer (1.0.0).
 *
 * Reported: "when I'm downloading the models the download bar goes back and
 * forth multiple times", and "when I was trying to download both models my
 * laptop crashed and started heating a lot".
 *   - A model is several files; each file's own 0–100% went to the bar, and
 *     the larger model mixed in an overall figure too. combineProgress adds
 *     the files up against the model's known size and never goes back.
 *   - Each model ran on every core but one, both at once, each loaded into
 *     memory as it downloaded, and the queue then checked answers back to
 *     back. Now: half the cores (at most 4), one download at a time with the
 *     other model unloaded first, and a pause between checks.
 */
import { readFileSync } from "node:fs";
import { combineProgress } from "../src/aiService.js";
import { threadCount } from "../src/lib/llmEngine.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\none bar for the whole model, never going back");
{
  const bar = { files: new Map(), pct: 0 };
  const MB = 1e6, SIZE = 420 * MB;
  const seen = [];
  const send = (p) => seen.push(combineProgress(bar, p, SIZE).pct);
  // The order a real download reports in: small files done at once, the
  // weights in steps, and an overall figure mixed in.
  send({ status: "progress", file: "config.json", loaded: 1000, total: 1000, pct: 100 });
  send({ status: "progress", file: "model.onnx", loaded: 100 * MB, total: 400 * MB, pct: 25 });
  send({ status: "progress", file: "tokenizer.json", loaded: 2 * MB, total: 2 * MB, pct: 100 });
  send({ status: "progress_total", pct: 10 });
  send({ status: "progress", file: "model.onnx", loaded: 300 * MB, total: 400 * MB, pct: 75 });
  send({ status: "progress", file: "model.onnx", loaded: 400 * MB, total: 400 * MB, pct: 100 });
  send({ status: "ready" });
  check("it only ever goes up", seen.every((v, i) => i === 0 || v >= seen[i - 1]), seen.join(" → "));
  check("a small file finishing doesn't show the model as done", seen[0] < 5 && seen[2] < 30, seen.join(" → "));
  check("and it ends at 100", seen[seen.length - 1] === 100);
}

console.log("\nthe processor is shared, not taken");
{
  const g = (cores) => ({ crossOriginIsolated: true, navigator: { hardwareConcurrency: cores } });
  check("8 cores: 4 threads", threadCount(g(8)) === 4);
  check("4 cores: 2 threads", threadCount(g(4)) === 2);
  check("16 cores: still 4", threadCount(g(16)) === 4);
  check("2 cores: 1", threadCount(g(2)) === 1);
  const laya = readFileSync(new URL("../src/lib/layaEngine.js", import.meta.url), "utf8");
  check("Laya the same", /Math\.min\(4, Math\.floor\(cores \/ 2\)\)/.test(laya));
}

console.log("\none model at a time, with a pause between checks");
{
  const svc = readFileSync(new URL("../src/aiService.js", import.meta.url), "utf8");
  const laya = svc.slice(svc.indexOf("async function downloadLaya"), svc.indexOf("async function downloadLaya") + 1400);
  const qwen = svc.slice(svc.indexOf("async function download({"), svc.indexOf("async function download({") + 1400);
  check("Laya waits for the AI model's download, and unloads it first", /await downloading/.test(laya) && /llm\("unload"/.test(laya));
  check("the AI model waits for Laya's, and unloads Laya first", /await layaDownloading/.test(qwen) && /llm\("laya-unload"/.test(qwen));
  check("the queue pauses between answers", /QUEUE_PAUSE_MS = \d{4,}/.test(svc) && /setTimeout\(r, QUEUE_PAUSE_MS\)/.test(svc));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
