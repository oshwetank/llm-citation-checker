# CitoSkeleton — Deep Research

**Date:** 2026-07-14
**Question:** Can we build a browser extension that captures query fan-out, cited/referenced sources, and related signals across ChatGPT, Gemini, Claude, Grok, and Perplexity — like RESONEO's "ChatGPT Search & Fan-outs Capture" but multi-platform?

**Short answer:** Yes, but the platforms are *not* equally crackable. ChatGPT and Perplexity are highly feasible today. Gemini is feasible but painful. Grok is moderately feasible. Claude.ai is the weakest — it exposes citations but little-to-no fan-out. The winning product is not "another single-platform fan-out grabber" (that market is already crowded and free); it's a **unified, cross-platform capture + normalization layer** that turns five different network formats into one schema for GEO analysis.

---

## 1. How the target product (RESONEO 3.4) actually works

The extension you referenced is a passive network-capture tool, not a scraper that sends prompts. Confirmed mechanics:

- Runs a content script on `chatgpt.com` at `document_start` and injects a script into the page's **MAIN world**.
- The injected script **monkey-patches `window.fetch`**. When ChatGPT POSTs to `/backend-api/.../conversation`, it **tees the streaming (SSE) response**, parses the events, and pulls out the `search_model_queries` array plus citation/source objects.
- Data flows: injected script → `window.postMessage` → content script → `chrome.runtime.sendMessage` → service worker → `chrome.storage.local`. Everything stays local ("no API calls, no external servers").
- ~3,000 users, v3.4.1 (June 2026), 104 KB, by RESONEO (Paris).

**What it extracts** (this is the feature bar to match/beat):
- Query fan-outs, split into search / shopping / image query types
- All cited links, including from thinking-mode responses
- Reference-type breakdown (products, search results, news, images)
- **Sourcing pipeline** — which provider fetched each result (Bright Data, Oxylabs, Licensed/Labrador, SERP)
- `turn_use_case` — the server-side intent category ChatGPT assigns each turn
- Named entities, product data (prices/ratings), news entities
- Carousels (product/image/news/map) with metadata
- Brand & competitor mention tracking with context passages
- Excel/TSV export, local project management, top-domains analytics

The open-source **Fanout-harvester** (LeaderCoreAI, GitHub, MV3) is a minimal reference implementation of the same technique — `manifest.json` / `background.js` / `content.js` / `injected.js` / `popup.*`, extracting user prompts, query counts, queries joined by `||`, conversation/message IDs, model slug, and a fan-out flag. Good starting skeleton.

### 1a. The four surfaces of RESONEO (verified from live screenshots, July 2026)

The tool has four tabs, and they map cleanly onto the architecture we should build:

- **Analyze** — per-conversation view of the *currently open* ChatGPT search. Shows General Info (prompt, generated title, carousels present y/n), Query Fan-Out (split Search / Shopping / Image), Technical Info (raw internal fields lifted from the SSE JSON: `Author: tool:web`, `Tool Name: SonicBrowserTool`, `Model: gpt-5-5`, `Plan Type`, `Cluster Region`, `Turn Use Case`, `Reference Types` breakdown, and a **"Debug: raw conversation"** link), Global Statistics, Entities detected (Turn Products tagged HERO/BLOCK, inline mentions, explore-more), a Products table (price/merchant/rating/reviews/scraping-metadata), Top Domains (typed: citations/other/products/news/hidden), Top URLs (ranked, with snippet), Brand Mentions (typed Competitor with context passages), and a Summary-by-Type table.
- **Dashboard** — the aggregate/history layer across all stored captures. Overview bar (Total/Fan-out/Images/News/Shopping/Entities/Map with % penetration), headline counters (151 conversations, 789 fan-out queries, 1833 links, 1346 domains, 86 carousels), a searchable **Saved Conversations** table (Date, Model, Prompt, Title, Fan-outs shown as `search + shopping` e.g. `1 + 42`, Domains, URLs, Project, bulk actions, pagination), a **Fan-out Tag Cloud** (weighted terms across all fan-out queries), aggregate **Top Domains** (Top-20 by URL count with a "Conversations" frequency column), aggregate **Top URLs / Products / Images / News** carousels, categorized **Top Entities** NER (Company / Mobile_app / Mobile_phone / Organization / Product / Software), aggregate **Top Brand Mentions** (share-of-voice: Samsung 397 mentions / 93 convs), a **"Reprocess all conversations"** button, and a **Download bar** (per-entity CSV: Conversations/Fan-outs/Domains/Links/Products/Images/Maps/Entities/Mentions + **Export All Data (JSON)** + **Backup Database**).
- **Projects** — grouping of saved conversations into a named "prompt universe."
- **Loader** — automated audit. Paste N prompts (one per line), save/load the list, Start → it submits each prompt to ChatGPT, waits for the response, captures, opens a fresh conversation, and moves to the next; pause/resume; auto-saves; assign all results to a project. This is the batch-tracking engine.

### 1b. Two architectural decisions from RESONEO worth copying verbatim

1. **Store the raw payload immutably; derive every view on top.** The "Debug: raw conversation" link + the "Reprocess all conversations" button prove they persist the raw SSE blob and re-run the parser over history when it improves. This is essential for us: our per-platform adapters *will* break on model/UI updates, so we must keep raw captures and re-derive, never store only the parsed stats.
2. **The JSON export is the real integration surface.** Serious GEO users pipe "Export All Data (JSON)" into their own analysis. Our differentiator lands exactly here: one *normalized* JSON across five engines vs. a ChatGPT-only dump.

### 1c. Passive vs. active — the risk boundary runs through the Loader

- **Analyze + Dashboard = passive.** They only read traffic the browser already received (equivalent to having DevTools open). Low ToS risk; this is why existing extensions operate openly.
- **Loader = active automation.** It *generates* traffic by programmatically submitting prompts and refreshing conversations — exactly the "bots/scrapers/automation" pattern platform ToS name for bans. Highest value (it's what enables prompt-universe tracking over time) **and** highest risk. In our build: keep it, but make it opt-in, human-paced (randomized delays/jitter, not rapid-fire), clearly warned, and never the default.

---

## 2. The two visibility types you're actually measuring

From Suganthan's teardown ("How ChatGPT Picks Sources," 24 Jun 2026, based on ~1,240 source records read from raw network traffic) and Search Engine Land's `web.run` analysis, there's a critical framing:

- **Parametric visibility** — what the model "knows" from training. Stable, measurable via one-shot API audits, shifts only at knowledge-cutoff updates ("the Google Dance of LLMs"). If a brand isn't in parametric memory, it's *invisible before the search even starts.*
- **Dynamic visibility** — what gets retrieved and cited at query time. Volatile, model-version-dependent, can "collapse overnight with a model update" (e.g., cited unique domains dropped from 19→15 per response after GPT-5.3, a 20% decline that never recovered).

**An extension measures dynamic visibility** — the retrieval/citation layer, in the wild, on real logged-in sessions. That's its unique value vs. API-based tools that only see parametric or synthetic behavior.

### ChatGPT's source pipeline (the rich signals worth capturing)
- `result_source` field classifies each fetched page into a pipeline: **Labrador** (licensed publishers — Reuters/WSJ/Wikipedia), **Bright** (commercial scraper — shopping/finance/weather), **Oxylabs** (regional/local), **SERP** (open-web/news baseline).
- `turn_use_case` buckets the query *before* searching: Text (no search, training only), Shopping, Local, Image, Thinking (15–40 sub-queries). **Wording decides the bucket, not the topic.**
- Three distinct outcomes worth separating in the data model: **Fetched** (pulled into context, invisible to user) vs. **Cited** (footnote) vs. **Mentioned** (brand named but not the source).
- `web.run` now has 12 operations (search_query, open, find, click, screenshot, product_query, widgets…). A `browse_rewritten_queries` fan-out type appears only for product queries. GPT-5.4 Thinking chains 5–10+ search rounds; 5.3 Instant runs 2–3.

---

## 3. Per-platform feasibility

Feasibility = how much of {fan-out sub-queries, cited sources, retrieval metadata} is recoverable from client-side network traffic without server-side scraping.

| Platform | Transport | Fan-out queries | Citations/sources | Rich metadata | Difficulty | Verdict |
|---|---|---|---|---|---|---|
| **ChatGPT** | SSE via `fetch` to `/backend-api/conversation` | ✅ `search_model_queries` (when it searches) | ✅ full | ✅ `result_source`, `turn_use_case`, carousels, entities | Low–Med | **Best target.** Reference impls exist. |
| **Perplexity** | SSE (UI) + separate WebSocket | ⚠️ query strings often in POST body | ✅ `search_results` with URLs/titles/snippets, `[n]` markers | ✅ most transparent payloads | Low | **Best target.** Cleanest citation data. |
| **Gemini** | `batchexecute` RPC (`/_/BardChatUi/data/batchexecute`), SSE | ⚠️ AI Mode can print internal queries; web app buries them in nested RPC arrays | ⚠️ grounding metadata present but deeply nested | ⚠️ obfuscated array-index payloads, CSRF `SNlM0e` | High | Feasible but brittle; heaviest parsing. Highest fan-out volume (up to ~28). |
| **Grok** | SSE / `fetch` on grok.com | ⚠️ DeepSearch splits into sub-queries (up to 10 steps), partial exposure | ✅ citations when web/x search invoked | ⚠️ X + web mixed | Med | Moderate. Under-served by existing tools = opportunity. |
| **Claude.ai** | SSE via `fetch` | ❌ little/no explicit fan-out array; searches are agentic + server-side | ✅ citations in response | ❌ search results encrypted before reaching model; sparse client metadata | Med–High | **Weakest.** Can get citations, mostly not fan-out. Set expectations. |

**Key nuance:** the *consumer web apps* (what an extension sees) expose different data than the *APIs* (what SaaS tools poll). Claude's API encrypts search results and passes them back as opaque blobs — that same opacity shows up in the web client, which is why fan-out is hard there. Gemini's grounding metadata is real but wrapped in Google's positional-array RPC format that has no stable field names, so parsers break on every UI change.

---

## 4. Technical architecture (MV3 reality check)

**The core technique is well-established and legal-to-implement, but MV3 constrains you:**

- **You cannot read response bodies with `webRequest` in MV3** (removed) and `declarativeNetRequest` can only block/redirect, not read. The **only** viable path is **MAIN-world content-script injection** (`world: "MAIN"`, Chrome 111+) that **monkey-patches `window.fetch` and `XMLHttpRequest`** before page JS runs, then tees the stream.
- **Service-worker-routed requests bypass `window.fetch`.** If any platform moves its API calls into a service worker, `fetch` patching goes blind and you'd need the `chrome.debugger` API (shows a scary "started debugging this browser" banner — bad UX, heavier permissions). Today the five targets stream to the page, but this is a standing risk.
- **Fragility is inherent.** Every capture depends on undocumented field locations ("field location can drift" — even the reference extensions warn about this). You need a **per-platform adapter layer** with resilient extraction (search by shape, not just by key path) and fast update cadence. Budget for maintenance, not just a build.
- **Streaming caveat:** to tee an SSE body you consume and re-emit it; be careful with very large streams and with not breaking the page's own reader.

**Recommended architecture:**
```
manifest.json (MV3)
 ├─ content-main.js   world:MAIN  → patches fetch/XHR, tees SSE, raw-emits
 ├─ content-iso.js    world:ISOLATED → relays via chrome.runtime
 ├─ adapters/         one normalizer per platform (chatgpt, perplexity, gemini, grok, claude)
 │     → map raw payload → unified schema
 ├─ service-worker.js → dedupe, store (chrome.storage.local or IndexedDB), export
 └─ panel/            side panel: fan-out view, source breakdown, domain analytics, export
```

**Unified schema (the actual product moat):** normalize all five into one record —
`{platform, model, conversationId, turnId, userPrompt, turnUseCase?, fanoutQueries[]{text,type,round}, sources[]{url,domain,title,snippet,resultSource?,outcome: fetched|cited|mentioned}, carousels?, entities?, capturedAt}`.
This normalization is what nobody sells well yet.

---

## 5. Competitive landscape

**Single-platform fan-out extensions (free, crowded):**
- RESONEO ChatGPT Search & Fan-outs Capture 3.4 — richest, ChatGPT-only, ~3k users
- AI Search Fan-out Tracker (Find Real Friends) — **ChatGPT + Gemini**, ~1k users, free, has cloud sync
- SE Ranking, Quolity, XLR8, GEO Metrics (ChatGPT + Bing Webmaster + GSC), Fanout-harvester (OSS)

**SaaS AI-visibility platforms (paid, API/synthetic-poll based):**
- Profound (~$1,499/mo, category leader, up to 10 engines, $1B valuation), Peec (~$89/mo, 6 engines), Otterly ($29/mo), ZipTie ($69/mo, real-user simulation, 3 engines), Semrush AI Toolkit, Athena, seoClarity, Ahrefs Brand Radar, Scrunch.

**The gap in the market:**
1. **No extension does all five** (ChatGPT + Gemini + Claude + Grok + Perplexity) with normalized output. Best existing does two.
2. **Extensions capture real logged-in dynamic behavior**; SaaS tools mostly poll APIs / synthetic queries and *miss* the actual fetched-vs-cited-vs-mentioned distinction and real `result_source` pipeline data. That first-party, real-session data is the differentiator.
3. **Grok and Claude are under-served** — almost nobody captures them client-side.
4. Bridging extension-captured ground truth → a dashboard/GEO workflow (the "does it help you fix the gap" axis the SaaS reviews call the real differentiator) is open.

---

## 6. Risks & constraints (read before building)

- **ToS / account risk (Medium).** Passive read of your *own* traffic ≠ automated scraping, and existing extensions operate openly. But OpenAI et al. ban for "bots, scrapers, automation." If you add **auto-prompting / batch automation** (like RESONEO's batch feature), you cross into automation territory and raise ban risk. Keep the default mode passive.
- **Chrome Web Store policy (Medium).** Reading AI chat content is allowed, but you must (a) declare a **single narrow purpose**, (b) justify `host_permissions` for five AI domains, (c) have a real privacy policy, (d) keep data local by default. Note: this whole space is reputationally polluted — multiple malicious extensions have exfiltrated ChatGPT/Gemini/Claude/Perplexity conversations (one VPN extension hit 8M+ users; 16+ credential-stealing ChatGPT extensions). **"Local-only, no external servers" must be a provable, auditable selling point,** not just a claim. Consider open-sourcing the capture core.
- **Maintenance burden (High).** Five undocumented, frequently-changing payload formats. Expect breakage on model/UI updates (the GPT-5.3 transition changed the fan-out format from `fast|query|recency` pipes to structured JSON, and hid fan-out on some models entirely). This is an ongoing ops commitment.
- **Data completeness (inherent).** Not every prompt fans out (Text bucket = no search). Claude fan-out largely unavailable. Gemini parsing brittle. The UI must clearly say "no search performed" vs. "capture failed."
- **Privacy (High bar, but an asset).** You're reading the user's private chats. Local-first, explicit opt-in per platform, no PII in exports, clear data-retention controls.

---

## 7. Recommendation

**Build it — but position it as a cross-platform GEO ground-truth capture tool, not "yet another fan-out grabber."**

**Suggested MVP scope (fastest path to differentiated value):**
1. **Phase 1 — ChatGPT + Perplexity, passive only** (highest data quality, lowest effort/risk). Ship the MAIN-world fetch-patch + **immutable raw store** + per-platform adapters + unified schema + a per-conversation view (RESONEO "Analyze" equivalent) + JSON/CSV export. This alone matches the best free tools and adds Perplexity's clean citation data.
2. **Phase 2 — Dashboard/aggregate layer** — Saved Conversations store, cross-conversation Top Domains/URLs, fan-out term cloud, brand/competitor share-of-voice, "reprocess all" over the raw store. This is where retained captures become GEO intelligence.
3. **Phase 3 — Grok + Gemini** (under-served / high fan-out volume). Accept Gemini brittleness; build shape-based (not key-path) extraction against the `batchexecute` payload.
4. **Phase 4 — Claude** (citations only; be honest about no-fan-out) + **the cross-platform moat**: same prompt fired across engines → compare fan-out/sources/citations side by side. Beats both the free ChatGPT-only extensions and the API-based SaaS (which can't see real fetched-vs-cited-vs-mentioned client data).
5. **Phase 5 (gated) — Projects + Loader** (prompt-universe tracking over time). High value, but active automation = ToS/ban risk. Opt-in, human-paced with jitter, explicit warning, never default. Consider whether to ship at all, or offer only a "manual guided" mode.

**Deliberately defer / gate behind warnings:** auto-prompting/batch automation (ToS risk), any cloud upload of chat content (trust + policy risk).

**Design principles to lock in now:**
- Passive capture only by default; local-first storage; provable no-exfiltration (open-source the capture core).
- Per-platform adapter architecture with resilient, shape-based extraction and a fast patch cadence.
- One normalized schema across all engines — that's the product, the capture is just plumbing.
- Model the three outcomes explicitly: fetched vs. cited vs. mentioned.

---

## Sources
- [How ChatGPT Picks Sources — Suganthan (24 Jun 2026)](https://suganthan.com/blog/how-chatgpt-picks-sources/)
- [Inside ChatGPT Search: web.run and fan-out — Search Engine Land](https://searchengineland.com/inside-chatgpt-search-web-run-fan-out-queries-ai-visibility-477339)
- [RESONEO ChatGPT Search & Fan-outs Capture — Chrome Web Store](https://chromewebstore.google.com/detail/chatgpt-search-fan-outs-c/hlpghnnocnclmnkhmoacpoejpebfeifm) / [feature page](https://think.resoneo.com/scrap-chatgpt-plugin/)
- [Fanout-harvester (open-source MV3 reference) — GitHub](https://github.com/LeaderCoreAI/Fanout-harvester)
- [AI Search Fan-out Tracker (ChatGPT+Gemini) — Chrome Web Store](https://chromewebstore.google.com/detail/ai-search-fan-out-tracker/nflpppciongpooakaahfdjgioideblkd)
- [Query Fan-Out Extension / GEO Metrics](https://www.trygeometrics.com/blog/query-fan-out-extension-geo-metrics)
- [How Perplexity AI Answers Work — ZipTie](https://ziptie.dev/blog/how-perplexity-ai-answers-work/) / [Streaming Citation Parsing — Perplexity docs](https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README)
- [How Gemini Works: agent architecture (batchexecute) — Discovered Labs](https://discoveredlabs.com/blog/how-gemini-works-ai-agent-architecture-deepdive)
- [Understanding Grok DeepSearch — Profound](https://www.tryprofound.com/blog/understanding-grok-a-comprehensive-guide-to-grok-websearch-grok-deepsearch)
- [Query Fan-Out Explained: see the actual queries — Medium](https://medium.com/@maxvincet391/query-fan-out-explained-how-to-see-the-actual-queries-an-llm-fires-behind-your-search-420fedcc3bfe)
- [How to Intercept SSE in Chrome Extensions (MV3) — DEV](https://dev.to/wilow445/how-to-intercept-server-sent-events-in-chrome-extensions-mv3-guide-23kb)
- [Best AI Visibility Tools 2026 — Surmado](https://www.surmado.com/blog/best-ai-visibility-tools-2026)
- [Malicious extension stole ChatGPT/AI conversations — ClearPhish](https://www.clearphish.ai/news/vpn-browser-extension-stole-chatgpt-ai-conversations)
