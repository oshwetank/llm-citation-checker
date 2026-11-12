#!/usr/bin/env node
/*
 * Builds the zip to upload to the Chrome Web Store (1.0.0).
 *
 *   node scripts/build-store.mjs
 *   # → dist/citoskeleton-<version>-chrome.zip
 *
 * Until now every build was `git archive HEAD`: the whole repository, with
 * 33 MB of test fixtures, the account server's code, the training scripts
 * and the planning documents. None of that runs in the extension, and some
 * of it (the server code, internal notes) has no business on users'
 * computers. This takes only what the extension loads, and refuses to build
 * when something it loads is missing or something that must never ship is
 * there. The same checks run in CI (test/build-store.test.mjs).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// What the extension is made of. Everything else in the repository stays out.
export const INCLUDE = ["manifest.json", "_locales", "icons", "fonts", "src", "ui"];

// Never in the package, whatever folder it sits in.
const NEVER = [/(^|\/)\.[^/]+/, /\.(?:md|map|test\.mjs|log|zip|crx|pem)$/i, /(^|\/)(?:node_modules|test|tests|docs|server|training|scripts|dist)\//];
// Licence files are kept: the vendored code's licences must ship with it.
const KEEP_ANYWAY = /(?:^|\/)(?:LICENSE[^/]*|[^/]*-LICENSE\.md)$/i;

// Text that would mean a secret had been committed into the extension.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The files that go into the package, as paths relative to the root (forward slashes). */
export function packageFiles(root = ROOT) {
  const files = [];
  for (const entry of INCLUDE) {
    const p = join(root, entry);
    if (!existsSync(p)) continue;
    const list = statSync(p).isDirectory() ? walk(p) : [p];
    for (const f of list) {
      const rel = relative(root, f).split("\\").join("/");
      if (NEVER.some((re) => re.test(rel)) && !KEEP_ANYWAY.test(rel)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

/**
 * Everything the package refers to that isn't in it: the manifest's files,
 * each page's scripts and styles, each module's imports, and the pages and
 * scripts the code opens by name. Returns a list of "file → missing" lines.
 */
export function missingReferences(files, root = ROOT) {
  const have = new Set(files);
  const missing = [];
  const need = (from, path) => {
    const clean = path.split(/[?#]/)[0].replace(/^\//, "");
    if (!clean || /^(?:https?:|data:|chrome:|about:|_favicon)/.test(clean)) return;
    if (!have.has(clean)) missing.push(`${from} → ${clean}`);
  };
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (m.background && m.background.service_worker) need("manifest.json", m.background.service_worker);
  for (const cs of m.content_scripts || []) for (const js of cs.js || []) need("manifest.json", js);
  if (m.action && m.action.default_popup) need("manifest.json", m.action.default_popup);
  for (const icon of Object.values(m.icons || {})) need("manifest.json", icon);
  if (m.default_locale) need("manifest.json", `_locales/${m.default_locale}/messages.json`);

  for (const f of files) {
    const dir = posix.dirname(f);
    const rel = (p) => posix.normalize(posix.join(dir, p));
    if (f.endsWith(".html")) {
      const text = readFileSync(join(root, f), "utf8");
      for (const [, p] of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        if (/^(?:https?:|#|data:|mailto:)/.test(p)) continue;
        need(f, p.startsWith("/") ? p : rel(p));
      }
    }
    if (/\.(?:js|mjs)$/.test(f)) {
      const text = readFileSync(join(root, f), "utf8");
      for (const [, p] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) need(f, rel(p));
      // Pages and scripts opened by name from the extension's root.
      for (const [, p] of text.matchAll(/(?:getURL\(|files:\s*\[|url:\s*)["']((?:ui|src|icons)\/[^"'<>${}]+)["']/g)) need(f, p);
    }
  }
  return [...new Set(missing)];
}

/** Files in the package that look like they hold a secret. */
export function secretsFound(files, root = ROOT) {
  const hits = [];
  for (const f of files) {
    if (!/\.(?:js|mjs|json|html|css|txt)$/.test(f)) continue;
    const text = readFileSync(join(root, f), "utf8");
    for (const re of SECRET) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
  return hits;
}

export async function buildStoreZip({ root = ROOT, outDir = join(ROOT, "dist") } = {}) {
  const files = packageFiles(root);
  const missing = missingReferences(files, root);
  if (missing.length) throw new Error(`The package would be missing files:\n  ${missing.join("\n  ")}`);
  const secrets = secretsFound(files, root);
  if (secrets.length) throw new Error(`Refusing to package what looks like a secret:\n  ${secrets.join("\n  ")}`);
  const { makeZip } = await import("../src/lib/zipWrite.js");
  const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;
  const blob = await makeZip(files.map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(root, name))) })), new Date());
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `citoskeleton-${version}-chrome.zip`);
  writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
  return { out, files: files.length, bytes: statSync(out).size, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await buildStoreZip();
  console.log(`${r.out}\n${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB, version ${r.version}`);
}
