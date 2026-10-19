#!/usr/bin/env node
/*
 * Builds the Firefox version into dist/firefox/ (0.72.0).
 *
 *   node scripts/build-firefox.mjs
 *   # then about:debugging → This Firefox → Load Temporary Add-on → dist/firefox/manifest.json
 *   # or: npx web-ext lint --source-dir dist/firefox
 *
 * The code is the same; only the manifest differs:
 *   - background: Firefox runs a background page, not a service worker. The
 *     page (background.html) loads Readability and ui/offscreen.js too, so
 *     reading cited pages and the built-in AI run in it directly — Firefox
 *     has no offscreen documents (src/background.js inPage(), aiService.llm).
 *   - permissions Firefox doesn't know are left out: offscreen, tabGroups,
 *     favicon, languageModel (Gemini Nano is Chrome-only). The code already
 *     checks for each before use; site icons fall back to letter badges.
 *   - browser_specific_settings.gecko: an add-on id, and Firefox 128 or
 *     later (content scripts in the page's own world need it).
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist/firefox");
const COPY = ["src", "ui", "fonts", "icons", "_locales"];
const DROP_PERMS = new Set(["offscreen", "tabGroups", "favicon", "languageModel"]);

export function firefoxManifest(m) {
  const out = JSON.parse(JSON.stringify(m));
  out.background = { page: "background.html" };
  out.permissions = (out.permissions || []).filter((p) => !DROP_PERMS.has(p));
  out.browser_specific_settings = { gecko: { id: "citoskeleton@citoskeleton.app", strict_min_version: "128.0" } };
  // Firefox takes the same CSP key; WebAssembly needs 'wasm-unsafe-eval' there too.
  return out;
}

export const BACKGROUND_HTML = `<!doctype html>
<!-- Firefox's background page (scripts/build-firefox.mjs). It loads what the
     offscreen document holds in Chrome (the page reader and the AI model)
     before the background itself. -->
<meta charset="utf-8">
<script src="src/vendor/Readability.js"></script>
<script type="module" src="ui/offscreen.js"></script>
<script type="module" src="src/background.js"></script>
`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const d of COPY) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });
  const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(firefoxManifest(m), null, 2) + "\n");
  writeFileSync(join(OUT, "background.html"), BACKGROUND_HTML);
  console.log(`Firefox build in ${OUT}`);
}
