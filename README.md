# LLM Citation & Fan-Out Checker

A Chrome (MV3) extension that **passively** captures ChatGPT's search **query fan-out**
and the **sources it cites/fetches/mentions** — storing everything **locally on your
device**. Built on a multi-engine-ready foundation so Perplexity, Gemini, Grok, and
Claude can be added later without a rewrite.

> **v0.1 — ChatGPT only, passive capture.** No automated prompt-firing. Nothing leaves
> your device. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [RESEARCH.md](RESEARCH.md)
> for the feasibility research.

## How it works

1. A MAIN-world content script patches `window.fetch` before ChatGPT's own code runs.
2. When ChatGPT streams a conversation response (SSE from `/backend-api/conversation`),
   it copies the stream and hands the **raw** text to the service worker — untouched.
3. The service worker gzips and stores the raw payload (immutable), then runs the
   ChatGPT **adapter** to derive a normalized record (fan-out, sources, metadata).
4. The popup shows a per-conversation **Analyze** view and an aggregate **Dashboard**,
   with JSON/CSV export.

Because raw payloads are kept, **"Reprocess all"** re-derives every record after an
adapter update — no re-capturing needed. This matters because MV3 store rules forbid
remote code, so a parser fix means a new store submission; your data survives the gap.

## Load it (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this folder (`LLM Citation Checker`).
4. Pin the extension. Open **ChatGPT in a NEW tab** (the patch must install before the
   page loads), run a query that triggers a web search, then click the extension icon.

## Adapter calibration (done once; repeat when OpenAI changes the format)

The ChatGPT adapter (`chatgpt@0.2.0`) is calibrated against real gpt-5-5 traffic and
covered by a regression test:

```bash
node test/adapter.test.mjs
```

Fixtures live in `test/fixtures/*.txt` (raw debug exports). When a capture starts
coming back empty or the Analyze view shows `⚠ shape-fallback used`, OpenAI likely
moved a field — drop a fresh raw export into `test/fixtures`, add an expectation
block, and repair `src/adapters/chatgpt.js`. To re-derive stored captures after a
fix, hit **Reprocess all**. To confirm paths against live traffic:

1. On ChatGPT, open DevTools → **Network** → filter `conversation`.
2. Run a search prompt. Open the `conversation` request → **Response** (the SSE stream).
3. Compare the real JSON field locations to those in
   [`src/adapters/chatgpt.js`](src/adapters/chatgpt.js) and fix the fast-path selectors.
4. Reload the extension and use **Reprocess all** to re-derive from stored raw payloads.

The **Analyze** view flags `⚠ shape-fallback used` when a fast path missed and the
adapter fell back to a heuristic scan — that's your signal a path needs updating.

## Project layout

```
manifest.json           MV3 manifest (host_permissions: chatgpt.com only)
src/
  content-main.js       MAIN world: fetch/XHR patch, tees SSE (no parsing)
  content-iso.js        ISOLATED world: relays raw capture to the worker
  background.js         service worker: raw store, adapter dispatch, message API
  schema.js             normalized cross-engine record (fetched|cited|mentioned)
  adapters/chatgpt.js   hybrid extraction (key-path first, shape fallback)
  lib/db.js             minimal IndexedDB wrapper (raw + derived stores)
  lib/gzip.js           Compression Streams helpers
  lib/deep.js           deep-walk / shape-search utilities
ui/                     panel.html + panel.css + panel.js (Analyze / Dashboard / export)
icons/                  generated PNG icons
```

## Privacy

All captured data stays in your browser's IndexedDB. The extension makes **no network
requests** and requests host access to `chatgpt.com` only. Clear all data anytime with
the **Clear** button.

## Status by engine

- **ChatGPT** — calibrated. Fan-out, cited vs fetched sources, products, brand
  mentions, reference types, carousels, answer reconstruction. Tested.
- **Gemini** — capture plumbing live; adapter is a **scaffold** (shape-based) that
  needs calibration against a real Gemini payload (export a Gemini turn and repair
  `src/adapters/gemini.js`). Small telemetry RPCs are size-gated out.

## Loader (automated audit) — opt-in, use with care

The **Loader** tab fires a list of prompts, one per fresh ChatGPT chat, with an
optional *Force web search* toggle. A completed capture is the "turn done" signal,
so it advances at a human pace. **This automates ChatGPT and can risk your account** —
it's off by default and never runs unattended without you starting it. The composer
selectors in `src/content-iso.js` (`SEL`) may need calibration against the live UI.

## Deferred

Perplexity/Grok/Claude adapters · cross-engine comparison view · Projects ·
`chrome.debugger` fallback · loader progress persistence across SW restarts.
