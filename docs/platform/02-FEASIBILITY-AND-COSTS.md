# 02 — Feasibility and costs

**Target load:** 1,000 prompts per engine, for each brand account. Four engines assumed for the
tables: **ChatGPT, Gemini, Perplexity, Google AI Mode** (swap AI Overviews in at a lower price).
**Constraint:** minimum-to-zero spend.

> All unit prices below come from secondary sources found in October 2026 (see
> [01-RESEARCH.md §8 and Sources](01-RESEARCH.md#sources)). They change frequently — Phase 1 of the
> roadmap includes measuring real unit cost on 100 prompts before scaling.

## 1. Volume arithmetic

| Cadence | Runs / engine / month | 4 engines | Runs / day (all engines) |
|---|---|---|---|
| Weekly — or a **7-day rotation** (1/7 of prompts each day) | 4,330 | 17,320 | ~577 |
| Every 2.5 days | 12,160 | 48,640 | ~1,620 |
| Daily, every prompt | 30,400 | 121,600 | ~4,000 |

**The 7-day rotation is the recommended default.** It costs the same as weekly, but every day has
fresh data (≈143 prompts/engine/day), so dashboards move daily and a 7-day rolling window always
covers the full prompt set exactly once. A configurable **"core" subset** (e.g. 100 most important
prompts) can additionally run daily for ~10% more cost.

## 2. Unit cost per answer, by engine and collector

| Engine | Collector | Unit cost (USD) | Notes |
|---|---|---|---|
| ChatGPT | DataForSEO ChatGPT scraper (UI) | $0.0012 (std queue, ≤45 min) – ~$0.004 (live) | Closest to real ChatGPT UI; vendor carries scraping risk |
| ChatGPT | OpenAI Responses API + `web_search` | ~$0.012–$0.06 | $10/1k tool calls + search content billed as input tokens; one measured answer ≈ $0.058 |
| Gemini | Gemini API + Grounding with Google Search | **$0 for first 5,000 prompts/month** (Gemini 3 family), then ~$14/1k *search queries* (a prompt can issue several) + tokens ≈ $0.002 | Gemini 2.5 billing differs (per-prompt, $35/1k after 1,500/day free) |
| Gemini | Bright Data Gemini scraper (UI) | ~$0.0015 | 1,000 free records one-time trial |
| Perplexity | Sonar API (low context) | ~$0.0065 | $5/1k requests + ~$1/M tokens. **Check deprecation / Agent API status first** |
| Perplexity | Apify Perplexity scraper (UI) | ~$0.0037 | Third-party actor; quality varies by actor |
| Google AI Mode | DataForSEO AI Mode SERP | $0.0012 (std) – $0.004 (live) | |
| Google AI Overviews | DataForSEO SERP (Google organic, AIO block) | ~$0.0006–$0.002 | Async AIO loading may add cost |
| Claude | Anthropic API + web search | ~$0.01 + tokens ≈ $0.015–$0.04 | $10/1k searches |
| Any | Own extension as browser worker | $0 | Human-paced, needs a machine + logged-in account |
| Analysis | CitoSkeleton deterministic core (brands, SOV, sources) | **$0** | No LLM needed — reused from the extension |
| Analysis (optional) | LLM sentiment/stance per answer | ~$0.0001–$0.0005 | Flash-Lite class model; or OpenRouter `:free` models (≤1,000 req/day with $10 lifetime credit) |

## 3. Monthly variable cost — 1,000 prompts × 4 engines, one brand account

### 3a. Recommended "cheapest-faithful" mix
ChatGPT → DataForSEO UI · Gemini → Gemini API grounding (weekly) / Bright Data (daily) ·
Perplexity → Apify UI or Sonar · AI Mode → DataForSEO.

| Cadence | ChatGPT | Gemini | Perplexity | AI Mode | **Total / month** |
|---|---|---|---|---|---|
| Weekly / 7-day rotation | $5–$17 | $0–$10 | $16–$28 | $5–$17 | **≈ $25–$75** |
| Every 2.5 days | $15–$50 | $18–$25 | $45–$80 | $15–$50 | **≈ $95–$205** |
| Daily | $36–$122 | ~$46 | $113–$198 | $36–$122 | **≈ $230–$490** |

Low end = standard (queued) vendor tiers; high end = live tiers / official API.

### 3b. Official-API-only mix (most stable, least UI-faithful for ChatGPT)

| Cadence | ChatGPT (OpenAI web_search) | Gemini | Perplexity Sonar | Claude | **Total** |
|---|---|---|---|---|---|
| Weekly | $52–$260 | $0–$10 | ~$28 | $65–$170 | **≈ $145–$470** |

The OpenAI web-search tool is the single biggest cost driver; that's why ChatGPT defaults to the
vendor UI collector.

### 3c. Zero-cash mode
Gemini API free grounding (≤5,000 prompts/month — exactly fits 1,000 prompts weekly) + the
extension as a browser worker for ChatGPT/Perplexity/Grok at human pace. Feasible for **one
brand at weekly cadence**, but the browser worker needs ~1 minute per prompt per engine
(≈ 50 hours/week for 3 engines × 1,000 prompts), which means an always-on machine and dedicated
accounts. Treat this as a bootstrap/validation mode, not the production default.

## 4. Comparison with buying

Peec AI ≈ $95/month for 50 prompts on 3 engines, daily → **≈ $0.63 per prompt-engine-month**.

| Option | Cost per prompt-engine-month | 1,000 prompts × 4 engines |
|---|---|---|
| Peec AI (daily) | ~$0.63 | ~$2,530/month (plus engine add-ons) |
| This plan, daily | ~$0.06–$0.12 | ~$230–$490 |
| This plan, 7-day rotation | ~$0.006–$0.019 | ~$25–$75 |

## 5. Hosting on free tiers

| Component | Service (free tier) | Free allowance (verify) | Our usage @ 1 brand, 7-day rotation |
|---|---|---|---|
| Web app + REST API + MCP | Cloudflare Workers / Pages | 100k requests/day; ~10 ms CPU per request | < 5k req/day. CPU-heavy analysis is kept **out** of Workers |
| Database (derived data) + Auth | Supabase Free | 500 MB DB, 50k MAU, **pauses after 7 days idle** | ~85 MB/month (≈5 KB per response incl. mentions, sources, indexes). Daily jobs keep it awake |
| Raw answers (gzip JSON) | Cloudflare R2 | 10 GB, 1M writes/month | ~4 KB/answer → ~70 MB/month |
| Worker (collect + analyse) | GitHub Actions cron | Private repo 2,000 min/month; public repo unlimited | ~300 min/month at concurrency 20 |
| Worker (alternative) | Any always-free VM (e.g. Oracle Cloud Always Free) or a home machine | — | Also hosts the browser worker if used |
| Email (alerts, reports) | Resend / Brevo free tiers | ~3k/month | Weekly digests |
| Domain | Any registrar | ~$10/year | The only unavoidable cost |

### When free stops being enough

| Trigger | Upgrade | Cost |
|---|---|---|
| Derived DB > ~400 MB (≈ 4–5 months for 1 brand weekly; sooner with more brands or daily) | Supabase Pro (8 GB) — or self-host Postgres on the free VM; or roll old rows into daily aggregates (keeps ~95% less) | $25/month (or $0) |
| > 2,000 Actions minutes (daily cadence on several brands) | Move worker to the free VM, or make the worker repo public (code only; secrets stay in GitHub secrets) | $0 |
| Need SLA / team features | Workers Paid | $5/month |

**Retention plan built in from day one:** response-level rows kept 120 days on the free tier (180–365 on Pro); daily aggregates kept
forever; raw answers kept in R2 indefinitely (cheap) so anything can be **reprocessed** — the same
"immutable raw, derived views" principle as the extension (see root `ARCHITECTURE.md`).

## 6. Build cost

| Path | Effort | Cash |
|---|---|---|
| Build yourself with Claude Code, following [09-ROADMAP.md](09-ROADMAP.md) | MVP ≈ 6–10 focused weeks; v1 ≈ +6 weeks | ~$0 (+ domain) |
| Hire (MVP ≈ 300–450 engineering hours) | — | ~$7k–$18k at $20–$40/h; ~$20k–$45k at $60–$100/h |

Why it's cheap: the hard, differentiating code — adapters, brand detection, metric definitions,
export — **already exists and is tested** (≈14k lines in this repo, ~60 test files). The new work
is mostly plumbing: tenancy, scheduler, collectors, API, dashboard.

## 7. Feasibility verdict

| Question | Answer |
|---|---|
| Can 1,000 prompts/engine be run? | **Yes**, comfortably, via APIs/vendors. Not via a self-run scraping fleet. |
| Can it be hosted for ~$0? | **Yes** for the platform itself; you pay only per-answer collection costs. |
| Can it be done daily? | Yes at ~$230–$490/month per 1,000×4; the 7-day rotation gives 90%+ of the insight for ~10–15% of that. |
| Can agents use it? | Yes — REST + MCP with scoped API keys (see 06). |
| Biggest risks | (1) Vendor price/API changes; (2) API-vs-UI divergence; (3) engine ToS for any UI automation you run yourself; (4) free-tier policy changes. Mitigations in 07, 08, 10. |
