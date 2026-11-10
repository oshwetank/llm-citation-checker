# CitoSkeleton Cloud — planning pack

**Status:** Proposal / pre-build · **Date:** 2026-10-29, updated 2026-11-10 · **Base:** the CitoSkeleton Chrome extension in this repository (v0.84.0)

This folder is the full planning set for turning the CitoSkeleton extension into a **hosted,
multi-brand prompt-tracking platform** — profiles, brand accounts under each profile, a fixed
prompt set per brand, scheduled runs against AI engines, and an API + MCP server so AI agents can
manage prompts and pull the data on a user's behalf.

It is written so that it can be moved, unchanged, into a new repository (proposed name:
`citoskeleton-cloud`) as that repo's `docs/` folder. See [09-ROADMAP.md](09-ROADMAP.md#phase-0--new-repository)
for how the new repo is seeded from this one.

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 0 | [00-EXECUTIVE-SUMMARY.md](00-EXECUTIVE-SUMMARY.md) | One page: is it feasible, what does it cost, what do we build first |
| 1 | [01-RESEARCH.md](01-RESEARCH.md) | How Peec AI, Profound, Otterly, Scrunch and open-source trackers work; API-vs-UI data; answer variability; academic work |
| 2 | [02-FEASIBILITY-AND-COSTS.md](02-FEASIBILITY-AND-COSTS.md) | 1,000 prompts/platform: per-engine unit costs, monthly totals per cadence, hosting on free tiers, build cost |
| 3 | [03-PRD.md](03-PRD.md) | Product requirements: users, jobs-to-be-done, features, MVP scope, acceptance criteria |
| 4 | [04-ARCHITECTURE.md](04-ARCHITECTURE.md) | System design: components, data flow, run pipeline, what is reused from the extension |
| 5 | [05-DATA-MODEL.md](05-DATA-MODEL.md) | Postgres schema (DDL), row-level security, storage-size budget |
| 6 | [06-API-AND-AGENT-ACCESS.md](06-API-AND-AGENT-ACCESS.md) | REST API, API keys and scopes, MCP server tools for AI agents, webhooks |
| 7 | [07-ENGINE-COLLECTORS.md](07-ENGINE-COLLECTORS.md) | Per-engine collection strategy (official API, UI-scrape vendor, own browser worker) and the collector interface |
| 8 | [08-SECURITY-AND-COMPLIANCE.md](08-SECURITY-AND-COMPLIANCE.md) | Secrets, BYOK key storage, ToS risk per collection method, privacy, abuse limits |
| 9 | [09-ROADMAP.md](09-ROADMAP.md) | Phased build plan with milestones, the new-repo migration, and the go/no-go checks |
| 10 | [10-OPERATIONS.md](10-OPERATIONS.md) | Deploy, environments, monitoring, free-tier limit watch-list, runbook |

## The decisions this pack recommends (short version)

1. **Feasible at ~$0 fixed cost and roughly $25–$75/month variable** for 1,000 prompts × 4 engines
   run once a week (or spread as ~143/day on a 7-day rotation). Running all 1,000 *every day* on
   every engine is feasible too but costs roughly $230–$490/month — see the cost tables.
2. **Don't scrape ChatGPT/Gemini/Perplexity yourself from a server.** Use a pluggable *collector*
   layer with three backends: official grounded APIs (stable, ToS-clean; cheap except OpenAI web search), a UI-scrape
   data vendor (closest to what users see, vendor carries the scraping risk), and the existing
   extension as an opt-in "browser worker" for validation and engines nothing else covers.
3. **Reuse the extension's pure-JS analysis core** (`brands.js`, `geo.js`, `glossary.js`,
   `sources.js`, `fanout.js`, `schema.js`, `deep.js`, `campaignBoard.js`, `campaignXlsx.js`) server-side, unchanged where possible — it
   already computes Visibility, Share of Voice, Position, Citations and Source Visibility without
   an LLM, which is what keeps the analysis cost at zero.
4. **Stack:** build on the `server/` added in v0.82.0 (Vercel functions over Supabase) · Supabase Postgres +
   Auth (derived metrics only) · Cloudflare R2 (compressed raw answers) · a plain Node worker that
   runs on GitHub Actions or an always-free VM.
5. **Agent access from day one:** scoped, hashed API keys + a remote MCP server exposing the same
   operations, so Claude/ChatGPT/any agent can add prompts, trigger runs and pull SOV.
