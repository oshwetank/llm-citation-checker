# Citely — v1 Architecture

**Date:** 2026-07-14
**Status:** Approved for build (pending final go-ahead)
**Companion:** see [RESEARCH.md](RESEARCH.md) for the feasibility research this builds on.

## Locked decisions (from scoping)

| Decision | Choice | Rationale |
|---|---|---|
| v1 engine coverage | **ChatGPT only** | Richest, best-understood payload; ship fastest. Add Perplexity → Gemini → Grok → Claude later. |
| Distribution | **Public Chrome Web Store product** | Freemium GEO tool for practitioners. Drives all privacy/trust/review constraints below. |
| Capture mode | **Passive only** | Reads traffic the browser already receives. Low ToS risk. |
| Loader / automation | **Deferred** (Phase 5, gated) | Active prompt-firing = ToS/ban risk. Not in v1. |
| Foundation | **Multi-platform-ready** | Raw store + adapter seam + normalized schema now, so engines 2–5 drop in without a rewrite. |

## The load-bearing constraint: no remote code in MV3

Chrome Web Store **prohibits remotely-hosted executable code**. Our adapter parsing logic ships *inside* the package. So when OpenAI changes the SSE payload shape, we cannot server-push a fix — it requires a new store submission (hours–days of review latency). 

**Consequence (this drives the whole design):** store the **raw payload immutably** and derive every view on top. Users keep capturing during a parser outage; when the fixed parser ships, **"Reprocess all"** re-derives everything from the raw store. This is not a nice-to-have; it is what makes a public MV3 product survivable. (RESONEO's "Debug: raw conversation" + "Reprocess all conversations" confirm they do exactly this.)

## Component architecture

```
manifest.json (MV3, host_permissions: https://chatgpt.com/* only)
│
├─ content-main.js   world: MAIN   → patches window.fetch + XMLHttpRequest before page JS;
│                                     tees SSE stream from /backend-api/conversation;
│                                     posts RAW blob out (no parsing here)
├─ content-iso.js    world: ISOLATED → relays raw blob via chrome.runtime.sendMessage
│
├─ service-worker.js → receives raw blob → writes to IndexedDB (raw store, immutable, versioned)
│                       → runs adapter to derive normalized record → writes derived store
│                       → handles "reprocess all", export, aggregate queries
│
├─ adapters/
│   └─ chatgpt.js     → hybrid extraction: try known key-paths first (fast),
│                        fall back to shape-based scan on miss;
│                        emit local telemetry flag when fallback fires (format drift signal)
│   (perplexity.js, gemini.js, grok.js, claude.js added later behind same interface)
│
├─ schema.js         → normalized cross-engine record (below)
│
└─ ui/  (side panel or popup)
    ├─ Analyze    → current conversation detail
    ├─ Dashboard  → aggregates across raw/derived store + export
    └─ (Projects, Loader → deferred)
```

## Resolved technical tensions

1. **Storage → IndexedDB** (thin wrapper e.g. Dexie), request `unlimitedStorage`. `chrome.storage.local` is a whole-value KV store — wrong for thousands of blobs + aggregate queries. Gzip raw SSE via `CompressionStream` (highly compressible). Add a retention policy + "Backup Database" export.
2. **Adapters → hybrid.** Known key-paths first; shape-based fallback scan; local telemetry flag on fallback so drift is visible. Version the raw store so old blobs remain reprocessable.
3. **Service-worker-routed fetch → monitored risk, NOT a v1 build item.** Ship fetch/XHR patching (works today, proven by RESONEO). Keep interception behind a swappable seam. **Do NOT ship `chrome.debugger`** in a public product — it shows a "started debugging this browser" banner (kills trust) and draws heavy review scrutiny.
4. **Trust / privacy positioning.**
   - `host_permissions`: `https://chatgpt.com/*` only (+ `chat.openai.com` if live). Never `<all_urls>`.
   - Single narrow purpose declaration; truthful "no data transmitted off-device" disclosure.
   - Local-first storage by default.
   - **Open-source the capture core** — provable no-exfiltration is the differentiator in a space polluted by chat-stealing extensions.
5. **Normalized schema** — fetched/cited/mentioned enum is the core; keep a `platformSpecific` bag so engine-only fields aren't lost.

## Normalized schema (v1 draft)

```jsonc
{
  "captureId": "uuid",
  "platform": "chatgpt",            // enum: chatgpt|perplexity|gemini|grok|claude
  "model": "gpt-5-5",
  "capturedAt": "2026-07-14T…Z",
  "rawRef": "idb-key",              // pointer to immutable raw blob
  "schemaVersion": 1,
  "conversationId": "…",
  "turnId": "…",
  "userPrompt": "best camera phone under 40000",
  "turnUseCase": "shopping",        // nullable; ChatGPT-specific but generalizable
  "fanout": {
    "search":   [ { "query": "…", "round": 1 } ],
    "shopping": [ { "query": "…" } ],
    "image":    [ { "query": "…" } ]
  },
  "sources": [
    {
      "url": "https://…",
      "domain": "smartprix.com",
      "title": "…",
      "snippet": "…",
      "outcome": "cited",           // enum: fetched | cited | mentioned
      "type": "citation",           // citation|other|product|news|image|hidden
      "platformSpecific": { "result_source": "labrador" }
    }
  ],
  "products": [ { "name": "…", "price": "₹39,999", "merchant": "amazon.in", "rating": 4.6, "reviews": 70000 } ],
  "entities":  [ { "text": "Samsung", "category": "Company" } ],
  "brandMentions": [ { "brand": "Samsung", "type": "competitor", "count": 4, "passages": ["…"] } ],
  "platformSpecific": { "clusterRegion": "…", "toolName": "SonicBrowserTool" }
}
```

## v1 build sequence

- **Step 0 (before any adapter code):** open DevTools on a live ChatGPT search and confirm the *current* payload shape and exact JSON paths myself. The field names in RESEARCH.md (`search_model_queries`, `result_source`, `turn_use_case`) are second-hand from blog posts; the screenshots confirm the fields exist, but exact paths must come from live traffic.
- **Step 1:** MV3 skeleton + MAIN-world fetch patch + relay + IndexedDB **raw store** (capture works, no parsing).
- **Step 2:** ChatGPT adapter (hybrid extraction) → normalized record → derived store. Sanity-check the schema against Perplexity's known SSE shape so it won't need a rewrite at engine #2 — but **do not** build the 5-engine abstraction yet. Build the seam, not the framework.
- **Step 3:** Analyze view (current conversation).
- **Step 4:** Dashboard aggregates + JSON/CSV export + "Reprocess all."
- **Step 5:** Trust polish — privacy policy, data disclosure, open-source capture core — then Web Store submission.

## Explicitly deferred

- Engines 2–5 (Perplexity, Gemini, Grok, Claude) and the cross-engine comparison UI.
- Projects + Loader (automation).
- `chrome.debugger` fallback.
- Categorized NER / advanced entity work beyond basic extraction.

## Honest framing of v1's goal

ChatGPT-first + public means v1 launches head-to-head with RESONEO (free, established, ~3k users). Our differentiation lives entirely in later phases (multi-engine + normalized export + trust). **v1's job is parity + a migration-proof foundation** (raw store, normalized schema, open-source trust story) that RESONEO users would switch *to* once engines are added — not to win on day one.
