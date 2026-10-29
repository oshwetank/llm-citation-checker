# 10 — Operations

## 1. Environments

| Env | API | DB | Worker | Purpose |
|---|---|---|---|---|
| local | `wrangler dev` | Supabase CLI (local Postgres in Docker) | `pnpm worker:once` | Development with recorded fixtures (no paid calls) |
| staging | `api-staging.<domain>` | Supabase free project #2 | manual dispatch | Pre-release; collectors in "fixture" mode unless a flag is set |
| prod | `api.<domain>` | Supabase free project #1 → Pro when needed | GitHub Actions cron | |

Supabase free allows 2 projects — exactly staging + prod.

## 2. Deploy

- `deploy.yml`: on push to `main` → run tests → `wrangler deploy` (API) → Pages deploy (web) →
  `supabase db push` (migrations, prod requires manual approval via GitHub environment protection).
- `worker-cron.yml`:
  ```yaml
  on:
    schedule: [{ cron: "15 */3 * * *" }]   # every 3h; scheduler + drain
    workflow_dispatch: {}
  concurrency: { group: worker, cancel-in-progress: false }
  jobs:
    run:
      runs-on: ubuntu-latest
      timeout-minutes: 50
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
        - run: pnpm i --frozen-lockfile && pnpm --filter worker start -- --max-minutes 45
          env: { SUPABASE_URL: ..., SUPABASE_SERVICE_ROLE: ..., R2_*: ..., DATAFORSEO_*: ..., GEMINI_API_KEY: ... }
  ```
  The worker exits when the queue is empty or after `--max-minutes`, so minutes are only used when there is work.
- GitHub Actions cron can be delayed during busy periods — acceptable because runs are daily batches.

## 3. Monitoring (free)

| Signal | How |
|---|---|
| API errors/latency | Cloudflare Workers analytics + `console` logs (Workers Logs) |
| Worker run summary | Worker writes a `worker_runs` row (jobs done/failed, cost, duration); dashboard "System" page |
| Job failure rate per collector | SQL view; alert if > 5% in a run |
| Adapter drift | Count of `fallback_fired` per engine per day (existing extension telemetry flag) |
| Spend | `cost_ledger` vs caps; email at 80% / 100% |
| DB size | `pg_database_size` daily; alert at 400 MB on free tier |
| Uptime | Free external pinger (e.g. UptimeRobot / Better Stack free) on `/v1/health` |
| Supabase pause risk | `/v1/health` touches DB; daily scheduler writes |

Alerts go to email (Resend free tier) and optionally a Slack/Telegram webhook.

## 4. Free-tier watch-list (re-check quarterly — these change)

| Service | Limit that matters | Our headroom at 1 brand, 7-day rotation |
|---|---|---|
| Supabase Free | 500 MB DB; pauses after 7 days inactivity; 2 projects | ~85 MB/month before retention |
| Cloudflare Workers Free | 100k req/day; low CPU per request | ~5k req/day |
| Cloudflare R2 | 10 GB storage; 1M Class A ops/month | ~70 MB & ~20k writes/month |
| GitHub Actions (private) | 2,000 min/month | ~300 min/month |
| Gemini grounding | 5,000 free grounded prompts/month (Gemini 3) | 4,330 used — **close to the line**; add 2nd brand → paid |
| OpenRouter `:free` | 20 rpm; 50/day (1,000/day after $10 lifetime credit) | Only for optional sentiment |

## 5. Runbook

| Situation | Action |
|---|---|
| Run stuck "running" | Check `worker_runs`; stale locks auto-requeue after 15 min; `workflow_dispatch` the worker |
| Collector failing > 20% | Inspect 3 raw payloads in R2; if vendor shape changed → patch mapper, bump `version`, `reprocess --collector X --since D`; mark day on charts |
| Engine outage | Leave jobs in `retry`; they expire after 24 h as `failed: engine_unavailable`; metrics show reduced `n` |
| Spend cap hit | Jobs marked `skipped_cap`; owner notified; raise cap or reduce schedule |
| DB near limit | Lower retention, run rollup, or upgrade to Pro |
| Key leaked | Revoke in UI (effective ≤ 60 s); review `audit_log` for `actor_key` |
| Provider key compromised | Delete BYOK credential; rotate at provider; jobs fall back to platform key or pause |
| Analysis bug fixed | Bump `analysis_version`; `reprocess --brand X --since D` rebuilds responses + `daily_metrics` from R2 |

## 6. Backups
- Supabase free has no PITR: nightly `pg_dump` from the worker → R2 (`backups/`, keep 14).
- R2 raw store is itself the long-term backup of all results (reprocessable).
