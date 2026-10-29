# 09 — Roadmap

Effort estimates assume one person building with Claude Code, part-time-to-focused. Each phase
ends with a go/no-go check so money is only spent once the previous step proves out.

## Phase 0 — New repository (≈ 2–3 days)

1. Create `citoskeleton-cloud` (private to start; see open question on public worker repo in 03 §10).
2. Seed `packages/core` **with history** from this repo:
   ```bash
   git clone https://github.com/oshwetank/llm-citation-checker core-src && cd core-src
   git filter-repo --path src/lib --path src/adapters --path src/schema.js \
                   --path test --path-rename src/:packages/core/src/ --path-rename test/:packages/core/test/
   # then in the new repo: git remote add core ../core-src && git merge --allow-unrelated-histories core/master
   ```
   (Or a plain copy if history isn't wanted.)
3. Make `packages/core` runtime-neutral: remove/abstract the few browser-only bits (`db.js`
   IndexedDB, `nano.js` Chrome `languageModel` (`ai-brands.js` already takes it by injection), `gzip.js`/`zipWrite.js` `CompressionStream`
   — available in Node 18+ anyway). Keep the extension's tests green in Node.
4. pnpm + turbo workspace, TypeScript config allowing JS, Vitest running the ported `*.test.mjs`.
5. Copy this `docs/platform/` folder to `docs/`.
6. Plan for the extension to consume `@cito/core` (npm package or a sync script) — not in the
   critical path.

**Exit:** `pnpm test` runs the extension's existing test suite inside `packages/core` and passes.

## Phase 1 — Collection spike & cost validation (≈ 1 week)

1. Implement collectors: `gemini_api_grounding`, `dataforseo_chatgpt_ui`, `sonar_api` (or Apify),
   `dataforseo_ai_mode` — CLI only, no DB.
2. Run **100 real prompts** from an actual client sheet through each; store raw to disk; run
   `toRecord` → `detectBrands` → `brandPresence`.
3. Compare 20 of them against the extension's own browser captures (calibration, 07 §4).
4. Record real unit cost per engine and latency.

**Go/no-go:** cost per 1,000 responses within 1.5× of the 02 estimate; own-brand presence agreement
with browser captures ≥ 75% on ChatGPT. If ChatGPT vendor quality is poor, switch default to
OpenAI API and re-run the cost table.

## Phase 2 — MVP platform (≈ 4–6 weeks)

| Week | Deliverable |
|---|---|
| 1 | Supabase project, migrations (05), RLS, Auth; Hono API skeleton on Workers; OpenAPI generation |
| 2 | Profiles, members, brand accounts, competitors, engines, prompts + CSV/XLSX import (reuse header matching) |
| 3 | Scheduler + Postgres job queue + worker on GitHub Actions; R2 raw store; analysis stage; cost ledger + spend cap |
| 4 | `daily_metrics` rollup with intervals; REST results endpoints; API keys + scopes |
| 5 | Web dashboard: overview, prompts, sources, competitors, response viewer; XLSX export (reuse `campaignWorkbook.js`) |
| 6 | MCP server (tools in 06 §3); `llms.txt`; hardening, tenancy tests, docs |

**Exit = PRD §8 acceptance criteria.** Then run one real brand at 1,000 prompts × 4 engines on the
7-day rotation for 2 weeks and compare actual vs estimated spend.

## Phase 3 — v1 (≈ 4–6 weeks)

- Webhooks, alerts, weekly email digest.
- Stability metric UI, gap-prompt analysis, source categories.
- Extension cloud connector (browser worker + push manual captures), opt-in.
- OAuth 2.1 for MCP (claude.ai / ChatGPT connector one-click add).
- Claude and Grok engines; calibration runs scheduled monthly.
- Shareable read-only report links; optional model-estimated sentiment (labelled).
- Retention/rollup job; DB size monitoring.

## Phase 4 — Growth options (only if there are external users)

- Billing (Stripe / Razorpay) with plans by prompt-engine-runs; BYOK discount.
- Prompt suggestions from brand + category; prompt-volume proxy using DataForSEO AI keyword data.
- Multi-country runs per brand; Hindi and regional-language prompts.
- Copilot and more engines; agency white-label reports.
- Move worker to a dedicated VM / Fly.io when Actions minutes run out.

## Milestone summary

| Milestone | Target date (if started 2026-11-03) | Cash spent to date |
|---|---|---|
| M0 repo seeded, tests green | 2026-11-06 | $0 |
| M1 collectors validated on 100 prompts | 2026-11-14 | ~$1–$5 in API/vendor credits |
| M2 MVP live for own brands | 2026-12-26 | ~$10 domain + ~$25–$75/month collection |
| M3 v1 | 2027-02 | same |
