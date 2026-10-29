# 06 — API and agent access

Goal: **anything a person can do in the dashboard, an AI agent can do with an API key** — add
prompts, run them, read daily results, pull SOV, and fetch raw answers to do its own analysis.

Two surfaces over one service layer:
- **REST** at `https://api.<domain>/v1` (OpenAPI 3.1 at `/v1/openapi.json`)
- **MCP** at `https://api.<domain>/mcp` (Streamable HTTP), for Claude, ChatGPT connectors, Cursor, custom agents

Plus `https://<domain>/llms.txt` describing both for agents.

## 1. API keys

| Property | Design |
|---|---|
| Format | `cs_live_` + 32 bytes base62 (test keys: `cs_test_`). Shown **once** at creation. |
| Storage | `sha256(key)` only; UI shows `prefix` (first 12 chars) and `last_used_at` |
| Owner | A **profile** (not a user), so keys survive staff changes; `created_by` recorded |
| Scopes | `read` · `prompts:write` · `brands:write` · `runs:write` · `admin` (keys, members, webhooks, provider creds) · `collector:browser` (extension worker) |
| Brand restriction | Optional list of brand account IDs; everything else is 404 |
| Expiry | Optional; default none; rotation reminder at 90 days |
| Limits | 60 req/min and 10,000 req/day per key (Workers rate-limit binding or KV counter); `runs:write` additionally bounded by the spend cap |
| Revocation | Immediate in DB; edge cache of key lookups TTL 60 s |
| Audit | Every write logged with `actor_key` |

Header: `Authorization: Bearer cs_live_…`. Errors are RFC 9457 problem+json.

**Recommended agent key:** `read` + `prompts:write` + `runs:write`, restricted to the brands the
agent works on. Never give agents `admin`.

## 2. REST endpoints (v1)

Conventions: cursor pagination (`?cursor=&limit=` ≤ 200), `?fields=` sparse fields, ISO dates,
idempotency via `Idempotency-Key` header on POSTs.

### Profiles & keys
| Method | Path | Scope |
|---|---|---|
| GET | `/v1/me` — key/profile identity, scopes, brand restriction, spend this month | read |
| GET/POST/DELETE | `/v1/api-keys` | admin |
| PUT/DELETE | `/v1/provider-credentials/{provider}` | admin |

### Brand accounts
| Method | Path | Scope |
|---|---|---|
| GET | `/v1/brands` | read |
| POST | `/v1/brands` | brands:write |
| GET/PATCH | `/v1/brands/{id}` | read / brands:write |
| GET/POST/DELETE | `/v1/brands/{id}/competitors` | read / brands:write |
| GET | `/v1/brands/{id}/competitors/suggested` | read |
| GET/PUT | `/v1/brands/{id}/engines` — engine + collector + enabled | read / brands:write |
| GET | `/v1/brands/{id}/cost-estimate?schedule=&engines=` | read |

### Prompts
| Method | Path | Scope |
|---|---|---|
| GET | `/v1/brands/{id}/prompts?tag=&topic=&q=&active=` | read |
| POST | `/v1/brands/{id}/prompts` — body: `{ prompts: [{text, tags?, topic?, intent?, core?}] }` (≤ 1,000 per call) | prompts:write |
| POST | `/v1/brands/{id}/prompts/import` — CSV/XLSX upload | prompts:write |
| PATCH/DELETE | `/v1/brands/{id}/prompts/{pid}` (delete = deactivate in new version) | prompts:write |
| GET | `/v1/brands/{id}/prompt-versions` | read |

### Runs
| Method | Path | Scope |
|---|---|---|
| GET | `/v1/brands/{id}/runs?from=&to=` | read |
| POST | `/v1/brands/{id}/runs` — `{ prompt_ids? , tag?, engines?, samples? , dry_run? }` → returns cost estimate when `dry_run` | runs:write |
| GET | `/v1/runs/{run_id}` — status, counts per engine, cost | read |
| POST | `/v1/runs/{run_id}/cancel` | runs:write |

### Results & metrics
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/brands/{id}/metrics?from=&to=&engine=&tag=&granularity=day\|week&brand=` | Visibility, SOV, Position, Citations, Source Visibility, Stability; each `{value, n, ci95:[lo,hi]}` |
| GET | `/v1/brands/{id}/share-of-voice?from=&to=&engine=` | Ranked list of tracked + top untracked brands |
| GET | `/v1/brands/{id}/sources?from=&to=&outcome=cited&category=` | Domains/URLs with counts, prompts citing them |
| GET | `/v1/brands/{id}/gaps?from=&to=` | Prompts where competitors appear and the brand does not |
| GET | `/v1/brands/{id}/prompts/{pid}/history` | Presence/position per engine per day |
| GET | `/v1/brands/{id}/responses?from=&to=&engine=&prompt_id=&present=` | Paginated normalised responses |
| GET | `/v1/responses/{rid}` | Full normalised record (answer text, mentions, sources, fan-out) |
| GET | `/v1/responses/{rid}/raw` | Signed R2 URL, 10 min |
| POST | `/v1/brands/{id}/exports` — `{format: csv\|xlsx\|html}` | Async; returns export id + URL when ready |
| GET | `/v1/glossary` | Every metric's definition, formula, caveat (from `glossary.js`) |

### Browser worker (extension)
| Method | Path | Scope |
|---|---|---|
| POST | `/v1/worker/lease` — `{engines:[...], max:5}` → jobs for `browser_worker` collector | collector:browser |
| POST | `/v1/worker/jobs/{job_id}/result` — raw payload + adapter output | collector:browser |
| POST | `/v1/worker/jobs/{job_id}/fail` | collector:browser |

### Webhooks (v1)
`run.completed`, `run.failed`, `metric.alert`, `spend.cap_reached`. Body JSON, header
`X-Cito-Signature: t=…,v1=HMAC_SHA256(secret, t + "." + body)`; retries with backoff for 24 h.

### Example
```bash
curl -s https://api.example.com/v1/brands/BRAND/metrics?from=2026-10-01\&to=2026-10-28\&granularity=week \
  -H "Authorization: Bearer cs_live_..." | jq '.data[] | {week, engine, visibility}'
```
```json
{ "week":"2026-W43", "engine":"chatgpt",
  "visibility": { "value":0.312, "n":1000, "ci95":[0.284,0.341] },
  "share_of_voice": { "value":0.147, "n":3820 } }
```

## 3. MCP server

Transport: Streamable HTTP at `/mcp`. Auth v1: `Authorization: Bearer <api key>` (supported by
Claude Code, Cursor and most SDK clients via custom headers). v1.1: OAuth 2.1 with dynamic client
registration so claude.ai / ChatGPT connectors can add it with a login instead of a pasted key.

Tool design rules:
- Tools mirror REST operations 1:1 and are thin wrappers over the SDK.
- Descriptions include the metric caveats (from the glossary), so an agent doesn't over-read a ±13 pp interval.
- Write tools return what changed and the new cost estimate; destructive tools (`delete_*`) require `confirm: true`.
- Results are compact JSON with IDs; large lists are paginated with a `next_cursor`.
- Tool annotations: `readOnlyHint` on reads, `destructiveHint` on deletes.

### Tools (MVP)

| Tool | Scope | Purpose |
|---|---|---|
| `whoami` | read | Profile, scopes, brand access, month-to-date spend and cap |
| `list_brands` | read | Brand accounts with engines and schedule |
| `get_brand` | read | Full config incl. competitors |
| `create_brand` | brands:write | Brand, domains, country, engines |
| `update_competitors` | brands:write | Add/remove competitors; accept suggested |
| `list_prompts` | read | Filter by tag/topic/text |
| `add_prompts` | prompts:write | Bulk add (≤ 1,000) with tags/topic/intent |
| `update_prompt` / `deactivate_prompts` | prompts:write | |
| `estimate_cost` | read | For a schedule/engine set or an ad-hoc run |
| `run_prompts` | runs:write | Trigger a run for prompt IDs / a tag; returns run id + estimate |
| `get_run_status` | read | |
| `get_metrics` | read | Visibility, SOV, Position, Citations, Source Visibility, Stability with CIs |
| `get_share_of_voice` | read | Ranked brands |
| `get_top_sources` | read | Cited/fetched domains & URLs, categories |
| `get_gap_prompts` | read | Where competitors win and the brand is absent |
| `get_prompt_history` | read | Per-prompt timeline |
| `search_responses` | read | Filter responses; returns excerpts |
| `get_response` | read | Full answer, mentions, sources, fan-out |
| `get_glossary` | read | Metric definitions |
| `export_report` | read | XLSX/CSV/HTML link |

### Resources & prompts (MCP features)
- Resources: `cito://brands/{id}/summary` (latest weekly KPIs), `cito://glossary`.
- Prompt templates: `weekly_brand_review`, `competitor_gap_analysis`, `prompt_set_expansion` — packaged
  instructions an agent can invoke to produce a standard analysis from the tools.

### Example agent flow (Claude)
1. `whoami` → sees brand "Acme Brokerage", 812 prompts.
2. `add_prompts` with 188 new prompts tagged `mutual-funds` → `estimate_cost` → `run_prompts(tag:"mutual-funds")`.
3. Next day: `get_metrics(granularity:"week")`, `get_gap_prompts`, `get_top_sources(outcome:"cited")`.
4. Writes a summary: "Visibility on ChatGPT 31% (±2.8), down 4 pp WoW — outside the interval;
   lost citations from moneycontrol.com on 37 prompts…"

## 4. Server-side LLM analysis (optional, v1.1)

`POST /v1/brands/{id}/insights` runs a server-side analysis job (BYOK model) over aggregates and
returns a structured summary. Agents with their own model don't need it — the data endpoints are
enough — so it's optional and off by default to keep costs at zero.

## 5. Versioning and stability promises
- `/v1` is additive-only; breaking changes go to `/v2` with 6-month overlap.
- Metric definitions changes bump `glossary_version`, returned in every metrics payload.
