/*
 * security-hardening.test.mjs — the fixes from the pre-release security
 * audit of 10 Nov 2026 (0.84.1). Plain Node, no browser.
 *
 * Each block is one finding, written as the attack the audit made, so each
 * fails on 0.84.0:
 *
 *   1. A shared campaign file was stored as it came. A source address of
 *      "javascript:…" survived import and was a live link in the exported
 *      HTML report; a record with no fan-out lists crashed that export.
 *   2. "Read the cited pages" would fetch http://localhost and 192.168.x.x.
 *   3. The worker took every kind of message from scripts inside web pages.
 *   4. "Continue in…" typed the user's data into whatever page the tab had
 *      ended up on.
 *   5. A file made to unpack into gigabytes was unpacked in full.
 *   7. No minimum Chrome version: older Chrome installed it and captured
 *      nothing.
 *
 * Every payload here is made up.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readBundle, decodeBundle, cleanImportedRecord, BUNDLE_FORMAT, MAX_UNPACKED_BYTES } from "../src/lib/campaignBundle.js";
import { buildExportModel, renderStandaloneHtml, EXPORT_CSP, EXPORT_PRINT_HANDLER, EXPORT_IMG_HANDLER } from "../src/lib/exportDoc.js";
import { httpUrl, isPublicHttpUrl, scrubUrls } from "../src/lib/safeUrl.js";
import { citedUrls } from "../src/lib/pageText.js";
import { PAGE_MESSAGE_TYPES, fromExtensionPage, mayHandle, onEngineSite } from "../src/lib/senderGate.js";
import { gunzipToString } from "../src/lib/gzip.js";
import { firefoxManifest } from "../scripts/build-firefox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* ---------- 1. imported campaigns ---------- */
console.log("\n1. a shared campaign is checked on import");
const hostile = {
  captureId: "c1", platform: "perplexity", capturedAt: 1762750000000, userPrompt: "best phone", answerText: "Zento Nova 8 is the pick.",
  sources: [
    { url: "javascript:alert(document.domain)", domain: "example.com", title: "Trusted source", outcome: "cited" },
    { url: "https://phonereview.example/best", domain: "phonereview.example", title: "Real page", outcome: "cited" },
    "not an object",
  ],
  // no fanout at all, and lists that aren't lists
  products: { name: "x" },
  images: [{ url: "data:text/html,<script>alert(1)</script>", title: "pic" }, { url: "https://img.example/a.png" }],
  pageUrl: "file:///etc/passwd",
  platformSpecific: { places: [{ website: "javascript:alert(2)", mapsUrl: "https://maps.example/x" }] },
};
const bundle = () => ({ format: BUNDLE_FORMAT, version: 1, profile: { id: "p1", name: "Shared", website: "javascript:alert(3)" }, prompts: [{ id: "q1", text: "best phone" }, null], runs: [], records: [JSON.parse(JSON.stringify(hostile)), null, "junk"], raws: [] });
{
  const out = readBundle(bundle());
  const r = out.records[0];
  check("only real records are kept", out.records.length === 1 && out.prompts.length === 1, `${out.records.length} records, ${out.prompts.length} prompts`);
  check("a javascript: source address is removed", r.sources[0].url === null, String(r.sources[0].url));
  check("a normal address is kept as it was", r.sources[1].url === "https://phonereview.example/best");
  check("a source that isn't an object is dropped", r.sources.length === 2);
  check("data: and file: addresses are blanked", r.images[0].url === "" && r.pageUrl === "", JSON.stringify([r.images[0].url, r.pageUrl]));
  check("addresses deep inside are checked too", r.platformSpecific.places[0].website === "" && r.platformSpecific.places[0].mapsUrl === "https://maps.example/x");
  check("the campaign's own setup is checked", out.profile.website === "");
  check("missing lists are lists", Array.isArray(r.fanout.search) && Array.isArray(r.fanout.shopping) && Array.isArray(r.fanout.image) && Array.isArray(r.products) && r.products.length === 0);

  let html = "";
  const err = await throws(() => { html = renderStandaloneHtml([buildExportModel(r)], {}); });
  check("the export of it doesn't crash", !err, err && err.message);
  check("no javascript:, data: or file: address is a link or picture in the report", !/(?:href|src)="\s*(?:javascript|data|file|vbscript):/i.test(html), (html.match(/(?:href|src)="\s*(?:javascript|data|file):[^"]*"/i) || [""])[0]);
  check("the real link is still there", html.includes('href="https://phonereview.example/best"'));
}
{
  // A record that went around import (an older database, a future bug):
  // the report still writes no such link.
  const raw = { ...JSON.parse(JSON.stringify(hostile)), fanout: { search: [], shopping: [], image: [] }, products: [{ name: "Zento", imageUrl: "javascript:alert(4)" }] };
  const html = renderStandaloneHtml([buildExportModel(raw)], { withPrintBar: true });
  check("the report checks addresses itself, whatever the record holds", !/(?:href|src)="\s*javascript:/i.test(html), (html.match(/(?:href|src)="\s*javascript:[^"]*"/i) || [""])[0]);

  const meta = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1] || "";
  check("the saved report carries a content policy", meta === EXPORT_CSP && meta.includes("default-src 'none'"), meta.slice(0, 60));
  check("which allows no script by address and no inline script", !/script-src[^;]*'unsafe-inline'/.test(meta) && !/script-src[^;]*https?:/.test(meta));
  const hash = (t) => `'sha256-${createHash("sha256").update(t).digest("base64")}'`;
  check("only its own two one-line handlers, by hash", meta.includes(hash(EXPORT_PRINT_HANDLER)) && meta.includes(hash(EXPORT_IMG_HANDLER)));
  const handlers = [...html.matchAll(/\son[a-z]+="([^"]*)"/g)].map((m) => m[1]);
  check("and those are the only handlers written", handlers.length > 0 && handlers.every((h) => h === EXPORT_PRINT_HANDLER || h === EXPORT_IMG_HANDLER), [...new Set(handlers)].join(" | "));
}
{
  const rec = cleanImportedRecord({ userPrompt: 42, sources: "nope", fanout: [], platformSpecific: "x" });
  check("wrong types are put right", rec.userPrompt === "42" && rec.sources.length === 0 && Array.isArray(rec.fanout.search) && typeof rec.platformSpecific === "object");
  const o = { a: { link: "JaVaScRiPt:alert(1)", imageUrl: " https://ok.example/x ", note: "javascript: in plain text is left alone" } };
  check("scrubUrls counts what it blanked and ignores case", scrubUrls(o) === 1 && o.a.link === "" && o.a.imageUrl === " https://ok.example/x " && o.a.note.startsWith("javascript:"));
  check("httpUrl", httpUrl(" https://a.example ") === "https://a.example" && httpUrl("//a.example") === null && httpUrl(null) === null);
}

/* ---------- 2. cited pages ---------- */
console.log("\n2. Read the cited pages reads public sites only");
{
  const no = ["http://localhost:8080/admin", "http://127.0.0.1/", "http://0x7f.1/", "http://2130706433/", "http://127.1/", "http://[::1]/", "http://[fd00::1]/", "http://192.168.1.1/", "http://10.0.0.5/x", "http://169.254.169.254/latest/meta-data", "http://8.8.8.8/", "http://router/", "http://printer.local/", "http://nas.lan/", "http://build.internal/", "https://user:pw@bank.example/", "javascript:alert(1)", "ftp://files.example/", "", null];
  const yes = ["https://phonereview.example/best", "http://sony.co.in/x", "https://www.smartprix.com/a?b=1#c", "https://xn--80ak6aa92e.com/"];
  const wrongNo = no.filter((u) => isPublicHttpUrl(u)), wrongYes = yes.filter((u) => !isPublicHttpUrl(u));
  check("private, numeric and non-web addresses are refused", wrongNo.length === 0, wrongNo.join(", "));
  check("ordinary sites pass", wrongYes.length === 0, wrongYes.join(", "));
  const rec = { sources: [
    { url: "http://192.168.1.1/status", outcome: "cited" }, { url: "http://localhost:3000/", outcome: "cited" },
    { url: "https://phonereview.example/best#top", outcome: "cited" }, { url: "https://other.example/", outcome: "fetched" },
  ] };
  check("citedUrls leaves them out", citedUrls(rec).join() === "https://phonereview.example/best", citedUrls(rec).join());
  const bg = readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  check("the reader checks again where it reads", /async function readOnePage\([^)]*manual = false[^)]*\) \{\s*if \(!isPublicHttpUrl\(url\)\)/.test(bg));
  check("a redirect to a private address isn't kept", /if \(res\.url && !isPublicHttpUrl\(res\.url\)\) return/.test(bg));
  check("the signed-in hidden tab is used only when the person asked", /const canScript = manual && /.test(bg) && /readOnePage\(u, \{ force, manual \}\)/.test(bg));
}

/* ---------- 3. who may send what ---------- */
console.log("\n3. scripts inside web pages can only send captures");
{
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
  const page = { tab: { id: 7 }, url: "https://chatgpt.com/c/123", frameId: 0 };
  const panel = { url: `${EXT}ui/panel.html` };
  const panelInTab = { tab: { id: 9 }, url: `${EXT}ui/panel.html?mode=tab` };
  const offscreen = { url: `${EXT}ui/offscreen.html` };
  const privileged = ["get-record", "get-records", "clear-all", "campaign-bundle-export", "campaign-bundle-import", "cloud-verify", "read-cited-pages", "handoff-open", "save-settings", "demo-load", undefined];
  const let_ = privileged.filter((t) => mayHandle({ type: t }, page, EXT));
  check("a page script can't read, export, delete or sign in", let_.length === 0, let_.join(", "));
  check("nor with no message at all", mayHandle(null, page, EXT) === false);
  check("it can still hand over a capture", mayHandle({ type: "raw-conversation" }, page, EXT) && mayHandle({ type: "loader-claim" }, page, EXT));
  check("the extension's own pages can send anything", privileged.every((t) => mayHandle({ type: t }, panel, EXT)) && mayHandle({ type: "clear-all" }, panelInTab, EXT) && mayHandle({ type: "ai-status" }, offscreen, EXT));
  check("another extension's page is not ours", fromExtensionPage({ url: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/x.html" }, EXT) === false);
  check("a look-alike address is not ours", fromExtensionPage({ tab: { id: 1 }, url: `https://evil.example/${EXT}` }, EXT) === false);
  check("Firefox's addresses work the same", mayHandle({ type: "clear-all" }, { url: "moz-extension://1b2c/ui/panel.html" }, "moz-extension://1b2c/") && !mayHandle({ type: "clear-all" }, { tab: { id: 1 }, url: "https://grok.com/" }, "moz-extension://1b2c/"));

  // Every kind the two page scripts send is on the list, or capture breaks.
  const sent = new Set();
  for (const f of ["src/content-iso.js", "src/handoff.js"]) for (const m of readFileSync(path.join(ROOT, f), "utf8").matchAll(/\btype: "([a-z-]+)"/g)) sent.add(m[1]);
  const missing = [...sent].filter((t) => !PAGE_MESSAGE_TYPES.has(t));
  check("everything content-iso.js and handoff.js send is allowed", sent.size >= 15 && missing.length === 0, missing.join(", "));
  const extra = [...PAGE_MESSAGE_TYPES].filter((t) => !sent.has(t));
  check("and nothing is allowed that they don't send", extra.length === 0, extra.join(", "));
  const bg = readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  check("the worker asks before it does anything", /onMessage\.addListener\(\(msg, sender, sendResponse\) => \{[\s\S]{0,400}?if \(!mayHandle\(msg, sender, EXT_BASE\)\) \{[\s\S]{0,400}?return false;/.test(bg));
}

/* ---------- 4. Continue in… ---------- */
console.log("\n4. Continue in… types only into the AI site that was chosen");
{
  check("the site itself", onEngineSite("https://claude.ai/new", "https://claude.ai/new") && onEngineSite("https://chatgpt.com/c/abc", "https://chatgpt.com/"));
  check("www. and subdomains of it", onEngineSite("https://perplexity.ai/", "https://www.perplexity.ai/") && onEngineSite("https://www.perplexity.ai/x", "https://perplexity.ai/"));
  const no = ["https://accounts.google.com/signin", "https://evil.example/?https://claude.ai/", "https://claude.ai.evil.example/", "https://notclaude.ai/", "http://claude.ai/new", "chrome://newtab/", "", "about:blank"];
  const wrong = no.filter((u) => onEngineSite(u, "https://claude.ai/new"));
  check("not a login page elsewhere, a look-alike, or plain http", wrong.length === 0, wrong.join(", "));
  const bg = readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  check("checked before the script goes in", /onUpdated\.addListener\(\(tabId, info, tab\) => \{[\s\S]{0,700}?if \(!engine \|\| !onEngineSite\(\(tab && tab\.url\) \|\| "", engine\.url\)\) return;[\s\S]{0,200}?executeScript/.test(bg));
  check("and before the text is handed over", /case "handoff-claim": \{[\s\S]{0,500}?!onEngineSite\(\(sender && sender\.url\)/.test(bg));
}

/* ---------- 5. unpacking ---------- */
console.log("\n5. a file made to unpack into gigabytes is refused");
{
  const small = gzipSync(Buffer.from("hello ".repeat(1000)));
  check("an ordinary file still unpacks", (await gunzipToString(small)) === "hello ".repeat(1000));
  const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)); // 8 MB of spaces, a few KB packed
  check("the test file is tiny packed", bomb.byteLength < 64 * 1024, `${bomb.byteLength} bytes`);
  const err = await throws(() => gunzipToString(bomb, 1024 * 1024));
  check("past the limit it stops, and says why", !!err && /unpacks to more than it should/.test(err.message), err ? err.message : "no error");
  check("a campaign file has a limit of its own", MAX_UNPACKED_BYTES > 0 && /gunzipToString\(bytes, MAX_UNPACKED_BYTES\)/.test(readFileSync(path.join(ROOT, "src/lib/campaignBundle.js"), "utf8")));
  const good = gzipSync(Buffer.from(JSON.stringify(bundle())));
  const b = await decodeBundle(good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength));
  check("a real campaign file still opens", b.format === BUNDLE_FORMAT && b.records.length === 3);
}

/* ---------- 7. minimum Chrome ---------- */
console.log("\n7. Chrome too old to capture is told so");
{
  const m = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  // world: "MAIN" content scripts arrived in Chrome 111; before it the
  // capture script runs in the wrong world and sees nothing.
  check("the manifest names the oldest Chrome that works", Number(m.minimum_chrome_version) >= 111, String(m.minimum_chrome_version));
  check("because it does use a MAIN-world script", m.content_scripts.some((c) => c.world === "MAIN"));
  check("Firefox's build leaves Chrome's key out", !("minimum_chrome_version" in firefoxManifest(m)) && !!firefoxManifest(m).browser_specific_settings.gecko.strict_min_version);
}

/* ---------- 8. no new site access for existing users ---------- */
console.log("\n8. updating from the store version asks for no new site access");
{
  // The live store version is 0.36. A host it didn't have makes Chrome switch
  // the extension off for everyone on update until they approve it, so a new
  // one is a decision, not a side effect. 1.0.0 dropped google.com, added in
  // 0.69 only to see that a Google sign-in cookie exists (lib/auth-check.js
  // now reads it by gemini.google.com's address).
  // 1.0.6, the owner's decision: Google AI Mode on from install, with no
  // switch and no prompt ("a person need to switch on for them to use the AI
  // mode. That's not right"). www.google.com is added knowingly; store users
  // approve it once on update.
  const LIVE_HOSTS = ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.perplexity.ai/*", "https://perplexity.ai/*", "https://grok.com/*", "https://x.com/*", "https://www.google.com/*"];
  const m = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const added = (m.host_permissions || []).filter((h) => !LIVE_HOSTS.includes(h));
  check("no host beyond the live version's", added.length === 0, added.join(", "));
  check("all sites stays optional, asked for only when the setting is turned on", (m.optional_host_permissions || []).includes("<all_urls>") && !(m.host_permissions || []).includes("<all_urls>"));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
