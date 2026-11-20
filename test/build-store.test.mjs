/*
 * build-store.test.mjs — the zip uploaded to the Chrome Web Store holds the
 * extension and nothing else (1.0.0). Run: node test/build-store.test.mjs
 *
 * Builds were `git archive HEAD`: the whole repository, 33 MB of test
 * fixtures, the account server's code, the training scripts and the internal
 * notes included. scripts/build-store.mjs packages only what the extension
 * loads; this checks it does, and that nothing the extension loads is left
 * out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageFiles, missingReferences, secretsFound, ROOT, buildStoreZip } from "../scripts/build-store.mjs";
import { tmpdir } from "node:os";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nwhat goes into the store zip");
const files = packageFiles();
const top = new Set(files.map((f) => f.split("/")[0]));
check("only the extension's own folders and the manifest", [...top].sort().join() === "_locales,fonts,icons,manifest.json,src,ui", [...top].sort().join());
const banned = files.filter((f) => /^(?:test|docs|server|training|scripts|dist|\.github)\//.test(f) || /(?:^|\/)(?:HANDOFF|ARCHITECTURE|RESEARCH|README)\.md$/.test(f) || /\.(?:map|zip|pem|crx)$/.test(f));
check("no tests, server code, training scripts, notes or keys", banned.length === 0, banned.slice(0, 5).join(", "));
check("the vendored code's licences ship with it", files.includes("src/vendor/transformers/LICENSE-onnxruntime.txt") && files.includes("src/vendor/Readability-LICENSE.md") && files.includes("fonts/OFL.txt"));
check("every language's dictionary is in it", ["ar", "es", "fr", "hi", "pt-BR"].every((l) => files.includes(`ui/i18n/${l}.json`)));

console.log("\nnothing it loads is missing");
const missing = missingReferences(files);
check("the manifest's files, each page's scripts and styles, each module's imports", missing.length === 0, missing.slice(0, 5).join(" | "));
const without = files.filter((f) => f !== "src/handoff.js" && f !== "src/lib/db.js");
const caught = missingReferences(without);
check("and a file taken out is caught", caught.some((x) => x.endsWith("src/handoff.js")) && caught.some((x) => x.endsWith("src/lib/db.js")), caught.join(" | "));

console.log("\nno secrets");
check("no private key, service key or access token in any packaged file", secretsFound(files).length === 0, secretsFound(files).join(" | "));

console.log("\nthe zip itself");
const r = await buildStoreZip({ outDir: join(tmpdir(), `cito-store-test-${process.pid}`) });
const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
check("named after the manifest's version", r.out.endsWith(`citoskeleton-${m.version}-chrome.zip`), r.out);
check("well under the store's size limit, and smaller than the old whole-repository zip", r.bytes > 1e6 && r.bytes < 14 * 1048576, `${(r.bytes / 1048576).toFixed(1)} MB`);
const buf = readFileSync(r.out);
check("a real zip, with the manifest at its root", buf.readUInt32LE(0) === 0x04034b50 && buf.includes(Buffer.from("manifest.json")));

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
