# 03 — Product Requirements Document (PRD)

**Product:** CitoSkeleton Cloud · **Owner:** Shwetank · **Status:** Draft v1 · **Date:** 2026-10-29

## 1. Problem

Brands and the agencies serving them need to know *whether AI assistants recommend them*, against
whom, and on the back of which web sources — tracked over time, across hundreds or thousands of
buyer prompts. Today:

- CitoSkeleton does this deeply, but **only inside one person's browser**, at human pace, with a
  cap of 3 campaigns, and nothing runs unless that person clicks Run.
- Commercial tools (Peec, Profound, Scrunch…) cost ~$0.60+ per prompt-engine-month, so 1,000
  prompts × 4 engines is a $2,500+/month line item — out of reach for small agencies and
  individual consultants.
- Neither lets an **AI agent** operate the tool end-to-end on the user's behalf with a simple key.

## 2. Goals and non-goals

**Goals (v1)**
1. Multi-tenant: profiles → brand accounts → prompt sets, with members and roles.
2. Unattended scheduled runs of ≥1,000 prompts per engine per brand account.
3. Same metric definitions as the extension (one glossary), plus confidence intervals and stability.
4. Full REST API + MCP server with scoped API keys — every UI action is available to agents.
5. Variable cost ≤ $75/month per 1,000 prompts × 4 engines at the default cadence; $0 fixed.

**Non-goals (v1)**
- Building/operating our own scraping fleet with proxies and account farms.
- Generating "GEO recommendations" content (later; measurement first — see C-SEO Bench in 01 §7).
- Prompt-volume estimates (we track the user's prompts, not market demand).
- Billing/paid plans (design for it; don't build it until there are external users).

## 3. Users and personas

| Persona | Description | Primary jobs |
|---|---|---|
| **Owner / consultant** (you) | Runs GEO for several brands | Set up brands, import prompt sheets, read SOV weekly, export client reports |
| **Agency member** | Works on assigned brands | Add/edit prompts, review results, annotate |
| **Client viewer** | Brand stakeholder | Read-only dashboard and shared report link |
| **AI agent** | Claude / ChatGPT / custom bot with an API key | Add prompts, trigger runs, pull daily results, compute analysis, write summaries |

## 4. Concepts (glossary of the product)

| Term | Meaning |
|---|---|
| **Profile** (= workspace / organisation) | Billing and membership boundary. A person or an agency. Owns API keys and provider keys. |
| **Brand account** | One tracked brand inside a profile: name, domain(s), aliases, country, language, competitors, engines, collector per engine, schedule. (The extension's "campaign"/"profile".) |
| **Competitor** | Named brand + domains, explicit or auto-suggested from answers (`autoCompetitorsFrom`). |
| **Prompt** | A question text with tags/topic, intent (informational / commercial / transactional / local), optional `core` flag. |
| **Prompt set version** | Prompts are versioned; a change creates a new version so time series stay comparable (the extension's **Lock** concept). |
| **Run** | One scheduled execution batch for a brand account on a given day. |
| **Job** | One prompt × engine × sample within a run. |
| **Response** | The normalised answer for a job (`schema.js` record) + raw payload pointer. |
| **Collector** | How a job is executed for an engine: `api`, `vendor_ui`, `browser_worker`. |

## 5. Functional requirements

### 5.1 Accounts, profiles, members
- FR-1 Sign up / sign in by email magic link and Google OAuth.
- FR-2 A user can own or belong to multiple profiles; roles: `owner`, `admin`, `editor`, `viewer`.
- FR-3 Invite by email; revoke; transfer ownership.
- FR-4 Profile settings: name, default country/language, timezone, retention.

### 5.2 Brand accounts
- FR-5 CRUD brand accounts (limit per profile configurable; default 25).
- FR-6 Brand: name, primary domain, extra domains, aliases (e.g. "Angel One", "AngelOne"), excluded brands.
- FR-7 Competitors: add manually; accept/reject auto-suggested competitors after the first run.
- FR-8 Engines: choose from registry; for each engine choose a collector (default per 07) — **collector is locked** once a run has happened (changing it starts a new series).
- FR-9 Country + language per brand account (passed to collectors supporting location).
- FR-10 Schedule: `daily`, `rotation_7d` (default), `weekly` (weekday), `manual`; optional daily `core` subset; `samples_per_run` 1–5.
- FR-11 Cost preview before saving: runs/month and estimated $/month from the collector price table.

### 5.3 Prompts
- FR-12 Add one, paste many (one per line), import CSV/XLSX using the extension's header matching (`Prompt`/`Query`, `Tags`/`Topic`/…).
- FR-13 Tags (many) and topic (one) per prompt; intent; `core` flag; active/paused.
- FR-14 Up to 5,000 active prompts per brand account (v1 target 1,000 tested).
- FR-15 Edits create a new prompt-set version; dashboards can filter by version; a banner flags mixed-version ranges.
- FR-16 Dedupe on normalised text; warn on near-duplicates.
- FR-17 Optional: "suggest prompts" via LLM from brand + category (v1.1).

### 5.4 Runs
- FR-18 Scheduler creates runs at the profile's local time; jobs are queued per engine with per-collector concurrency and rate limits.
- FR-19 Manual "Run now" (whole set, a tag, or selected prompts), with cost preview and confirmation.
- FR-20 Retries: up to 3 with exponential backoff; final failure recorded with reason — **failures are never silently dropped** (same rule as the extension's pacing logic).
- FR-21 Run status page: queued/running/done/failed counts per engine, ETA, spend so far.
- FR-22 Monthly spend cap per profile and per brand; the scheduler stops enqueuing at the cap and notifies.

### 5.5 Analysis & metrics
- FR-23 Per response: brands mentioned with rank, cited/fetched/mentioned sources, fan-out queries (where exposed), products, places — produced by the reused extension core.
- FR-24 Metrics per brand × engine × day/week × tag/topic: **Visibility, Share of Voice, Position, Citations, Source Visibility**, each with `n` and 95% Wilson interval.
- FR-25 **Stability**: share of prompts whose presence outcome is unchanged vs previous run.
- FR-26 Top cited domains and URLs; **source category** (editorial / UGC / reference / corporate-own / competitor / retailer / other) by a maintained domain list + heuristics.
- FR-27 Competitor matrix: which competitors appear on prompts where the brand is absent ("gap prompts").
- FR-28 Stance **optional and labelled as model-estimated**, off by default (keeps the extension's honesty rule). Reuse the extension's stance labels (`laya.js` output shape, `source: "laya"`) so the cloud and the extension label brands the same way.
- FR-29 Reprocess: re-derive all responses from raw when the analysis core changes.

### 5.6 Dashboard (web)
- FR-30 Overview: KPI tiles with interval bars and week-over-week deltas; trend lines; engine split.
- FR-31 Prompts table: per prompt latest presence per engine, position, sources; drill into the answer.
- FR-32 Sources view: domains/URLs, category, which prompts cite them, own vs competitor.
- FR-33 Competitors view: SOV ranking, head-to-head, gap prompts.
- FR-34 Response viewer: answer text with highlighted brand mentions and footnoted citations (reuse `exportDoc.js`).
- FR-35 Exports: CSV, XLSX workbook (reuse `campaignXlsx.js` + `xlsxWrite.js`), HTML/PDF report.
- FR-36 Shareable read-only report link (tokenised, revocable).

### 5.7 API & agent access (details in 06)
- FR-37 Every UI action has a REST endpoint; OpenAPI 3.1 spec published.
- FR-38 API keys per profile with scopes (`read`, `prompts:write`, `brands:write`, `runs:write`, `admin`), optional brand restriction, expiry; shown once; revocable; last-used timestamp.
- FR-39 Remote MCP server exposing the same operations as tools; works with API key (bearer) in v1, OAuth in v1.1.
- FR-40 Webhooks: `run.completed`, `run.failed`, `metric.alert` (signed HMAC).
- FR-41 `llms.txt` and an agent guide describing tools and metric caveats.

### 5.8 Provider keys (BYOK)
- FR-42 A profile can store its own OpenAI / Gemini / Perplexity / Anthropic / DataForSEO / Bright Data / Apify credentials; encrypted at rest; never returned by the API.
- FR-43 If BYOK is set for a collector, jobs use it (cost lands on the user's provider bill); otherwise the platform key is used, subject to the spend cap.

### 5.9 Alerts & reports
- FR-44 Weekly email digest per brand account.
- FR-45 Threshold alerts: visibility drop > X pp (outside interval), new competitor in top 5, own domain lost from top cited.

### 5.10 Extension integration
- FR-46 The extension gets an **opt-in** "Connect to CitoSkeleton Cloud" setting: paste an API key with `runs:write`; then (a) it can pull `browser_worker` jobs and execute them in the user's logged-in session, and (b) push manual captures into a chosen brand account. Off by default, so the local-only promise of the store build is unchanged. It should reuse the sign-in the extension already has since 0.82.0 (Supabase emailed code, `src/lib/cloudConfig.js`) rather than add a second login.

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Scale | 1,000 prompts × 4 engines × 10 brand accounts at 7-day rotation without paid infra other than DB |
| Latency | Dashboard p95 < 1.5 s on pre-aggregated tables; API p95 < 800 ms for reads |
| Freshness | Daily aggregates available by 09:00 profile-local time |
| Reliability | ≥ 98% jobs succeed per run excluding engine outages; every failure has a reason |
| Reproducibility | Raw payload stored for every response; metrics recomputable from raw |
| Security | RLS tenant isolation; hashed API keys; encrypted provider keys; audit log of writes |
| Cost | Fixed ≤ $0–$25/month; variable within cost preview ±25% |
| Portability | Worker runs anywhere Node 20+ runs (Docker image) |

## 7. MVP scope (Phase 1–2 in the roadmap)

**In:** 1 profile with members, brand accounts, prompts + CSV import, 7-day rotation + manual run,
engines ChatGPT (vendor UI) + Gemini (API grounding) + Perplexity (Sonar or vendor) + AI Mode,
the five metrics with intervals, overview/prompts/sources/competitors pages, CSV/XLSX export,
API keys + REST + MCP (read + prompts write + run trigger), spend cap.

**Out until v1:** webhooks, alerts, sentiment, shared links, browser-worker integration, OAuth for
MCP, prompt suggestions, Claude/Grok/Copilot engines.

## 8. Acceptance criteria (MVP)

1. A 1,000-prompt CSV imports in < 30 s with tags preserved.
2. A 7-day rotation run for 1,000 prompts × 4 engines completes each day with ≥ 98% success and actual spend within ±25% of the preview.
3. Metrics on the dashboard equal those computed by the extension's `geo.js` on the same records (golden test).
4. An agent with a `read`+`prompts:write`+`runs:write` key can, via MCP only: create 20 prompts, trigger a run on them, and retrieve SOV for the brand once complete.
5. A key scoped to brand A gets 404 on brand B; a `read` key gets 403 on writes.
6. Revoking a key takes effect within 60 s.

## 9. Success metrics

- Weekly active brand accounts; prompts tracked; % runs completing on time.
- Cost per 1,000 responses (target ≤ $1.50 at default mix).
- Agent usage: % of write operations coming from API/MCP.

## 10. Open questions

1. Which country/language markets first (India-first suggests `IN`/`en` + Hindi prompts)?
2. Keep the cloud product open-source (like the extension core) or closed? (Affects whether the worker repo can be public for free Actions minutes.)
3. Will other people/agencies use it (→ billing in v1.x), or is it internal?
4. Acceptable divergence between API-based and UI-based results for Gemini/Perplexity before switching them to vendor UI collectors?
