#!/usr/bin/env node
/*
 * Vendors Transformers.js and its ONNX Runtime WebAssembly files into
 * src/vendor/transformers/ (0.70.0). The extension never loads code from
 * the network (Chrome Web Store rule), so the runtime ships inside it; only
 * the model's weights, which are data, are downloaded once.
 *
 *   node scripts/vendor-transformers.mjs            # write the files
 *   node scripts/vendor-transformers.mjs --check    # verify hashes (CI)
 *
 * Needs npm on PATH for the write step.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSFORMERS = "@huggingface/transformers@4.3.1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/vendor/transformers");
const FILES = [
  // [package, path in package, name in OUT]
  ["transformers", "dist/transformers.min.js", "transformers.min.js"],
  ["transformers", "LICENSE", "LICENSE-transformers.txt"],
  ["ort", "dist/ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.mjs"],
  ["ort", "dist/ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.wasm"],
];
// onnxruntime-web's package carries no LICENSE file; its package.json says
// MIT, under Microsoft's copyright (github.com/microsoft/onnxruntime).
const ORT_LICENSE = `MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (process.argv.includes("--check")) {
  const manifest = JSON.parse(readFileSync(join(OUT, "VENDOR.json"), "utf8"));
  let bad = 0;
  for (const [name, hash] of Object.entries(manifest.files)) {
    const p = join(OUT, name);
    if (!existsSync(p) || sha(p) !== hash) { console.log(`✗ ${name} does not match VENDOR.json`); bad++; }
  }
  // The runtime must not build code from strings. The one exception is
  // Emscripten's embind method invoker in ONNX Runtime's glue, reached only
  // through emscripten::val calls the WebGPU and WASM paths here don't make
  // (checked in Chromium under the extension's CSP, test/builtin-ai). Any
  // other eval or new Function fails the check.
  const js = readFileSync(join(OUT, "transformers.min.js"), "utf8");
  const fns = [...js.matchAll(/\bnew Function\s*\(/g)].map((m) => js.slice(m.index - 200, m.index + 40));
  const known = fns.filter((ctx) => /emval_returnValue|methodName, destructorsRef/.test(ctx));
  if (fns.length !== known.length || known.length > 1) { console.log(`✗ transformers.min.js builds code from strings (${fns.length} new Function, ${known.length} known)`); bad++; }
  if (/[^.\w]eval\s*\(/.test(js)) { console.log("✗ transformers.min.js calls eval"); bad++; }
  console.log(bad ? `\n${bad} FAILED` : "\nALL PASSED");
  process.exit(bad ? 1 : 0);
}

const work = mkdtempSync(join(tmpdir(), "vendor-tf-"));
const pack = (spec) => {
  const out = execFileSync("npm", ["pack", spec, "--silent"], { cwd: work, encoding: "utf8" }).trim().split("\n").pop();
  const dir = join(work, out.replace(/\.tgz$/, ""));
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["xzf", join(work, out), "-C", dir]);
  return join(dir, "package");
};
const tf = pack(TRANSFORMERS);
const tfPkg = JSON.parse(readFileSync(join(tf, "package.json"), "utf8"));
const ortSpec = `onnxruntime-web@${tfPkg.dependencies["onnxruntime-web"]}`;
const ort = pack(ortSpec);
mkdirSync(OUT, { recursive: true });
const files = {};
for (const [pkg, from, to] of FILES) {
  copyFileSync(join(pkg === "ort" ? ort : tf, from), join(OUT, to));
  files[to] = sha(join(OUT, to));
}
writeFileSync(join(OUT, "LICENSE-onnxruntime.txt"), ORT_LICENSE);
files["LICENSE-onnxruntime.txt"] = sha(join(OUT, "LICENSE-onnxruntime.txt"));
writeFileSync(join(OUT, "VENDOR.json"), JSON.stringify({ transformers: TRANSFORMERS, onnxruntime: ortSpec, command: "node scripts/vendor-transformers.mjs", files }, null, 2) + "\n");
console.log(`vendored ${TRANSFORMERS} and ${ortSpec} into src/vendor/transformers/`);
for (const f of readdirSync(OUT)) console.log("  " + f);
