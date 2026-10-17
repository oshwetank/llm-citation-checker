/*
 * interception-endpoints.test.mjs — the per-engine URL patterns in
 * content-main.js actually match the endpoints those engines stream from.
 *
 * Why this file exists: Perplexity capture was broken for six consecutive
 * "fix(perplexity): ..." commits, and none of them were wrong about parsing.
 * The bug was one branch earlier than anyone was looking. PERPLEXITY_RE
 * listed `/api/sse/` and `/rest/(threads|queries|answers|conversations)` but
 * not `/rest/sse/`, so a request to /rest/sse/perplexity_ask matched no
 * branch, was never intercepted, and produced ZERO captured bytes. Every
 * adapter fix after that was tuning a parser that was being handed nothing.
 *
 * That failure mode is invisible to the adapter tests: they feed a payload
 * straight to adapt(), so they pass whether or not the payload could ever
 * have been captured in the first place. This file covers the step those
 * tests skip — "would this URL have been recorded at all" — which is the
 * only step that was actually broken.
 *
 * The patterns are read out of content-main.js as source text rather than
 * imported, because that file is a browser-context IIFE with no exports.
 * Scraping is the tradeoff for testing it at all; the extraction below fails
 * loudly if a pattern is renamed or removed, so it cannot silently pass.
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");
const bgSrc = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");

// Pull `const NAME_RE = /.../i;` out of the source and rebuild it here.
// Returns both the compiled RegExp and the raw literal text (needed to check
// the background.js copy is byte-identical, not just behaviourally similar).
function patternFor(name, source = src) {
  const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*(/.*/)([gimsuy]*)\\s*;`));
  if (!m) return null;
  const literal = m[1] + (m[2] || "");
  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const flags = m[1].slice(m[1].lastIndexOf("/") + 1) + (m[2] || "");
  return { re: new RegExp(body, flags), literal };
}

// The noise filter CONV_RE applies before any engine branch. Endpoints that
// match it are dropped no matter what the engine pattern says, so the
// "should capture" cases below have to clear this too.
//
// PREVIOUSLY this constant was a hardcoded duplicate of an inline regex that
// used to live in content-main.js (`/suggest\.perplexity\.ai|\/search\/v2\/|
// \/api\/predict/i`). That inline regex was later narrowed (to
// `/navigate\b|\/autocomplete\b|\/api\/auth/`) without this file's copy being
// touched, so this test kept asserting against noise patterns that no longer
// existed in the source — it was passing regardless of what the real code
// did. NOISE_RE is now a named const in content-main.js specifically so it
// can be extracted here the same way the engine patterns are, instead of
// re-typed by hand.
const noise = patternFor("NOISE_RE");
check("NOISE_RE is present in content-main.js", !!noise, "pattern not found — was it renamed or inlined again?");
const NOISE_RE = noise ? noise.re : /$^/; // matches nothing if extraction failed, so capture cases below still run meaningfully

// Direct assertions on NOISE_RE itself. The combined `re.test(url) &&
// !NOISE_RE.test(url)` check used per-engine below is not enough on its own:
// for every "ignore" case in this file, the engine's OWN positive pattern
// already fails to match, so those assertions pass whether or not NOISE_RE
// does anything at all. These cases specifically need something that WOULD
// otherwise look like a real Perplexity endpoint, so NOISE_RE's own
// contribution is what is actually being exercised.
if (noise) {
  check("NOISE_RE catches www.perplexity.ai/rest/threads/navigate-suggest (contains /navigate)", NOISE_RE.test("https://www.perplexity.ai/rest/threads/navigate-suggest"));
  check("NOISE_RE catches www.perplexity.ai/api/sse/autocomplete (contains /autocomplete)", NOISE_RE.test("https://www.perplexity.ai/api/sse/autocomplete"));
  check("NOISE_RE catches suggest.perplexity.ai/anything (hostname alone is enough)", NOISE_RE.test("https://suggest.perplexity.ai/anything"));
  check("NOISE_RE does NOT catch a real thread endpoint", !NOISE_RE.test("https://www.perplexity.ai/rest/sse/perplexity_ask"));
  // 0.62.1, from the owner's network report: these were stored as captures.
  check("NOISE_RE catches Perplexity's notification stream", NOISE_RE.test("https://www.perplexity.ai/rest/sse/notifications"));
  check("NOISE_RE catches Perplexity's typeahead socket", NOISE_RE.test("wss://suggest.perplexity.ai/suggest/ws"));
  check("NOISE_RE does NOT catch a thread's own reconnect stream", !NOISE_RE.test("https://www.perplexity.ai/rest/sse/0a1b2c3d-1111-2222-3333-444455556666"));
  const pageSrc = readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");
  check("the socket patch checks NOISE_RE before taking a socket", /const isTargetWs = !NOISE_RE\.test\(wsUrl\)/.test(pageSrc));
}

// background.js keeps an independent second copy of this same pattern (it
// runs in the service worker, content-main.js runs in the page's MAIN world
// as a non-module IIFE — they cannot share a real import across that
// boundary). The two are supposed to be identical; this is what actually
// enforces it, rather than a comment asking nicely.
{
  const bgMatch = bgSrc.match(/if \((\/.*\/[a-z]*)\.test\(payload\.url \|\| ""\)\) \{\s*\n\s*return null;/);
  check("background.js's noise-filter copy is found", !!bgMatch, "storeCapture()'s noise check regex could not be located — was it restructured?");
  if (bgMatch && noise) {
    check(
      "content-main.js NOISE_RE and background.js's copy are identical",
      bgMatch[1] === noise.literal,
      `content-main.js has ${noise.literal}, background.js has ${bgMatch[1]} — these two must be edited together`
    );
  }
}

console.log("\ninterception-endpoints: engine URL patterns");

const ENGINES = {
  PERPLEXITY_RE: {
    capture: [
      // The regression this file was written for.
      "https://www.perplexity.ai/rest/sse/perplexity_ask",
      "https://www.perplexity.ai/rest/threads/abc123",
      "https://www.perplexity.ai/api/sse/stream",
      "https://www.perplexity.ai/socket.io/?EIO=4&transport=websocket",
    ],
    ignore: [
      // Autocomplete + prediction endpoints fire on every keystroke; capturing
      // them floods the store with non-answers.
      "https://suggest.perplexity.ai/api/s?q=best",
      "https://www.perplexity.ai/search/v2/typeahead",
      "https://www.perplexity.ai/api/predict",
      "https://www.perplexity.ai/_next/static/chunks/main.js",
    ],
  },
  CHATGPT_RE: {
    capture: [
      "https://chatgpt.com/backend-api/conversation",
      "https://chatgpt.com/backend-api/f/conversation",
    ],
    ignore: [
      "https://chatgpt.com/backend-api/conversations?offset=0", // history list, not a turn
      "https://chatgpt.com/_next/static/chunks/main.js",
    ],
  },
  GEMINI_RE: {
    capture: [
      "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq",
    ],
    ignore: ["https://gemini.google.com/_/BardChatUi/data/batchexecute"],
  },
  GROK_RE: {
    capture: [
      "https://grok.com/rest/app-chat/conversations/new",
      "https://x.com/i/api/graphql/abc123/CreateGrokConversation",
    ],
    ignore: ["https://x.com/i/api/graphql/xyz/HomeTimeline"],
  },
};

for (const [name, cases] of Object.entries(ENGINES)) {
  const found = patternFor(name);
  check(`${name} is present in content-main.js`, !!found, "pattern not found — was it renamed?");
  if (!found) continue;
  const re = found.re;

  for (const url of cases.capture) {
    const matched = re.test(url) && !NOISE_RE.test(url);
    check(`${name} captures ${url.replace(/^https:\/\//, "")}`, matched);
  }
  for (const url of cases.ignore) {
    const matched = re.test(url) && !NOISE_RE.test(url);
    check(`${name} ignores  ${url.replace(/^https:\/\//, "")}`, !matched);
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
