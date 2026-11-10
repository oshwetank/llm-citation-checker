/*
 * The Firefox version (scripts/build-firefox.mjs, 0.72.0).
 * Run: node test/firefox-build.test.mjs
 *
 * Firefox runs a background page, not a service worker, and has no
 * offscreen documents: the build swaps the manifest's background for a page
 * that loads the page reader and the AI model first, and drops the
 * permissions Firefox doesn't know. In that page the AI model is called
 * directly instead of by message.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { firefoxManifest, BACKGROUND_HTML } from "../scripts/build-firefox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("the manifest");
const m = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const f = firefoxManifest(m);
check("a background page, no service worker", f.background.page === "background.html" && !f.background.service_worker);
check("Chrome-only permissions left out", !["offscreen", "tabGroups", "favicon", "languageModel"].some((p) => f.permissions.includes(p)), f.permissions.join());
check("the rest kept", ["storage", "tabs", "alarms", "cookies", "scripting"].every((p) => f.permissions.includes(p)));
check("an add-on id and Firefox 128 or later", f.browser_specific_settings.gecko.id && f.browser_specific_settings.gecko.strict_min_version === "128.0");
check("same version, hosts and content scripts", f.version === m.version && JSON.stringify(f.host_permissions) === JSON.stringify(m.host_permissions) && JSON.stringify(f.content_scripts) === JSON.stringify(m.content_scripts));
check("WebAssembly allowed for the AI model", /wasm-unsafe-eval/.test(f.content_security_policy.extension_pages));
check("the Chrome manifest is not changed", m.background.service_worker === "src/background.js" && m.permissions.includes("offscreen"));

console.log("\nthe background page");
const at = (s) => BACKGROUND_HTML.indexOf(s);
check("loads Readability, then the page reader and AI, then the background", at("Readability.js") >= 0 && at("Readability.js") < at("ui/offscreen.js") && at("ui/offscreen.js") < at("src/background.js"));

console.log("\nthe AI model, called in the page");
{
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { sendMessage: () => { throw new Error("must not message itself"); } } };
  const calls = [];
  globalThis.citoOffscreen = { llmOp: async (op, args) => { calls.push(op); if (op === "boom") throw new Error("broken"); return { op, args }; }, onProgress: null };
  const { createAiService } = await import("../src/aiService.js");
  let ensured = 0;
  const svc = createAiService({ db: {}, getSettings: async () => ({}), ensureOffscreen: async () => { ensured++; } });
  const r = await svc.llm("status", { a: 1 });
  check("the call goes straight to the page's engine", r.op === "status" && calls.join() === "status" && ensured === 0, JSON.stringify(r));
  check("progress is wired to the service", typeof globalThis.citoOffscreen.onProgress === "function");
  let err = null;
  try { await svc.llm("boom"); } catch (e) { err = e.message; }
  check("an error comes back as an error", err === "broken", String(err));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
