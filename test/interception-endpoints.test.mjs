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

// Pull `const NAME_RE = /.../i;` out of the source and rebuild it here.
function patternFor(name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(/.*/)([gimsuy]*)\\s*;`));
  if (!m) return null;
  const body = m[1].slice(1, m[1].lastIndexOf("/"));
  const flags = m[1].slice(m[1].lastIndexOf("/") + 1) + (m[2] || "");
  return new RegExp(body, flags);
}

// The noise filter CONV_RE applies before any engine branch. Endpoints that
// match it are dropped no matter what the engine pattern says, so the
// "should capture" cases below have to clear this too.
const NOISE_RE = patternFor("__never__") || /suggest\.perplexity\.ai|\/search\/v2\/|\/api\/predict/i;

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
  CLAUDE_RE: {
    capture: [
      "https://claude.ai/api/organizations/org-1/chat_conversations/c-1/completion",
      "https://claude.ai/api/append_message",
    ],
    ignore: ["https://claude.ai/api/bootstrap"],
  },
};

for (const [name, cases] of Object.entries(ENGINES)) {
  const re = patternFor(name);
  check(`${name} is present in content-main.js`, !!re, "pattern not found — was it renamed?");
  if (!re) continue;

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
