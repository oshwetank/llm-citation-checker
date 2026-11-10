# 07 — Engine collectors

A **collector** turns a job (prompt × engine × country/language) into a raw payload and a
normalised `schema.js` record. Collectors are the only engine-specific moving part of the cloud
platform; the analysis is shared.

## 1. Interface

```ts
export interface Collector {
  id: string;                         // 'dataforseo_chatgpt_ui'
  engine: EngineId;                   // 'chatgpt'
  kind: 'api' | 'vendor_ui' | 'browser_worker';
  mode: 'sync' | 'async';             // async = submit now, poll/callback later
  limits: { concurrency: number; rpm: number; dailyCap?: number };
  estimateCostUsd(job: JobSpec): number;
  submit(job: JobSpec, ctx: CollectorCtx): Promise<
    | { status: 'done'; raw: unknown; costUsd: number }
    | { status: 'pending'; vendorTaskId: string }>;
  poll?(vendorTaskId: string, ctx: CollectorCtx): Promise<
    | { status: 'done'; raw: unknown; costUsd: number }
    | { status: 'pending' } | { status: 'failed'; error: string }>;
  toRecord(raw: unknown, job: JobSpec): NormalizedRecord;   // → packages/core schema
  version: string;                    // stored with raw for reprocessing
}

interface JobSpec { prompt: string; country: string; language: string; engine: EngineId; sampleNo: number; }
interface CollectorCtx { credentials: Record<string,string>; fetch: typeof fetch; log: Logger; }
```

Rules:
- **Every** collector must request web search / grounding. An answer without retrieval measures
  training-data recall and is rejected (`searched=false` + no sources → flagged, not counted in
  Source metrics; still counted for Visibility with a `no_search` tag so the gap is visible).
- `toRecord` must fill `sources[].outcome` honestly: API annotations → `cited`; search results
  returned but not annotated → `fetched`; URLs in text only → `mentioned`.
- Location: pass country/language using the collector's native parameter (vendor location codes,
  Gemini/OpenAI `user_location`); **never** inject "I am in India" into the prompt — it changes the answer.
- No conversation memory: each job is a fresh, logged-out-equivalent session.

## 2. Engine matrix and defaults

| Engine | Default collector | Alternatives | Fan-out queries available? | Notes |
|---|---|---|---|---|
| ChatGPT | `dataforseo_chatgpt_ui` (vendor UI) | `openai_responses_websearch` (API), `browser_worker` | Vendor: check fields; API: `web_search_call.action.query` items; browser: yes (existing adapter) | API diverges most from UI for ChatGPT — default to UI |
| Gemini | `gemini_api_grounding` | `brightdata_gemini_ui`, `browser_worker` | Yes: `groundingMetadata.webSearchQueries` | 5,000 free grounded prompts/month (Gemini 3) — fits 1,000 prompts weekly |
| Perplexity | `sonar_api` (or `apify_perplexity_ui`) | `browser_worker` | API: limited; browser: yes | Verify Sonar status (one source says superseded by Agent API after 27 Sep 2026) |
| Google AI Mode | `dataforseo_ai_mode` | — | No | |
| Google AI Overviews | `dataforseo_serp_aio` | `serpapi_aio` | No | AIO appears only for some queries — "no AIO" is a valid outcome, recorded as such |
| Claude | `anthropic_websearch` | — | Yes: `server_tool_use` web_search inputs | v1 |
| Grok | `browser_worker` | `xai_api_search` (verify price), Bright Data | Browser: yes | v1 |
| Copilot | `brightdata_copilot_ui` | — | No | v1.x |

## 3. Collector notes

### 3.1 `openai_responses_websearch`
- `POST /v1/responses` with `tools:[{type:"web_search"}]`, `tool_choice:"required"` (force a search),
  `user_location` from country, a small model to keep token cost down.
- Map `output[].type=="web_search_call"` → fan-out; `message.content[].annotations[type=url_citation]` → cited sources.
- Cost: tool call fee ($10/1k) + search content as input tokens. Record actual usage from the response.

### 3.2 `gemini_api_grounding`
- `generateContent` with `tools:[{google_search:{}}]`.
- `groundingMetadata.webSearchQueries` → fan-out; `groundingChunks[].web.uri` → sources;
  `groundingSupports` → which chunks back which answer spans (→ `cited`). Grounding URIs are
  Google redirect links: resolve with a HEAD request (cached per URL) to get the real domain.
- Google requires showing "Search Suggestions" when displaying grounded results to end users —
  our dashboard shows the stored `searchEntryPoint` HTML in the response viewer.

### 3.3 `sonar_api`
- `POST /chat/completions` with `model: sonar`, `search_context_size: low`; `citations` /
  `search_results` arrays → sources. Request a short answer to keep tokens low.

### 3.4 `dataforseo_*` (ChatGPT scraper, AI Mode, SERP AIO)
- Async "task_post" → "task_get" using standard queue (cheapest; ≤45 min) in scheduled runs;
  "live" endpoints for manual runs. Postback URL supported → `/internal/vendor-callback/dataforseo`.
- The DataForSEO MCP server is already connected in this workspace, which makes manual
  verification of payload shapes easy during Phase 1.

### 3.5 `brightdata_*` / `apify_*`
- Dataset/actor trigger → poll snapshot. Map per engine. Treat actor output schemas as unstable:
  keep the raw, version the mapper.

### 3.6 `browser_worker` (the extension)
- The extension, when connected with a `collector:browser` key, polls `/v1/worker/lease` while the
  user has opted in and the browser is open, runs the prompt in a Loader-owned tab using the
  **existing campaign runner** (pacing, tab-reclaim safety, auth checks), and posts the raw capture
  + adapter output back.
- It inherits the extension's safety rules: human pace, visible volume warnings, never drives a
  tab the user reclaimed. Throughput ≈ 1 prompt/min/engine — suited to validation samples and
  engines no other collector covers, not to 1,000 prompts/day.

## 4. Calibration: keeping cheap collectors honest

Monthly (or on demand) **calibration run**: a fixed 50-prompt sample is executed through both the
default collector and the browser worker for each engine. Report per engine:
- brand-set Jaccard overlap, own-brand presence agreement, cited-domain overlap.

If agreement for own-brand presence drops below an agreed threshold (proposal: 80%), the dashboard
shows a warning on that engine and the PRD's open question #4 is revisited.

## 5. Adding a collector — checklist
1. Implement the interface in `packages/collectors/<engine>/<id>.ts`.
2. Add 3+ recorded raw fixtures to `fixtures/` and golden tests for `toRecord` (follow the
   extension's `test/fixtures` pattern).
3. Add price to `collector_prices` config with `verified_at` date.
4. Register in the engine registry with `available: true` only once tests pass.
