# Executive summary

## What we're building

A hosted version of CitoSkeleton:

- **Profiles** (a person or an agency workspace) contain **brand accounts**.
- Each brand account has a brand + domain, competitors, a **prompt set** (target: 1,000+ prompts),
  tags/topics, the engines to track, a country/language, and a schedule.
- A scheduler **runs the prompts** against each engine, stores the answer, sources and fan-out
  queries, and computes **Visibility, Share of Voice (SOV), Position, Citations, Source
  Visibility** — the same definitions the extension already ships in `src/lib/glossary.js`.
- A **REST API and an MCP server**, authenticated with per-profile API keys, let AI agents do
  everything a user can: add prompts, trigger runs, read daily results, pull SOV, and run their
  own analysis on the data.

## Is 1,000 prompts per platform feasible?

**Yes.** The question is not "can we" but "how often, and through which collection method."

| Cadence (1,000 prompts × 4 engines) | Runs / month | Est. variable cost / month |
|---|---|---|
| Weekly (or 7-day rotation, ~143 prompts/engine/day) | ~17,300 | **≈ $25–$75** |
| Every 2.5 days | ~48,600 | ≈ $95–$205 |
| Daily, every prompt, every engine | ~121,600 | ≈ $230–$490 |

Ranges depend on which collector you choose per engine (cheapest: Gemini API free grounding
allowance + a UI-scrape vendor for ChatGPT/AI Mode; dearest: OpenAI web-search API). Full
derivation in [02-FEASIBILITY-AND-COSTS.md](02-FEASIBILITY-AND-COSTS.md). All third-party prices
were gathered from secondary sources in October 2026 and must be re-checked on each vendor's
pricing page before committing.

**Hosting:** $0/month on free tiers (Cloudflare Workers + R2, Supabase free, GitHub Actions) up to
roughly a few brand accounts at 1,000 prompts weekly. The first paid step is Supabase Pro
($25/month) once derived data passes ~400 MB or you need no-pause guarantees.

**Build cost:** $0 cash if you build it yourself with Claude Code (≈ 6–10 focused weeks for the
MVP in [09-ROADMAP.md](09-ROADMAP.md)); a domain is ~$10/year. If you hire, budget roughly
300–450 engineering hours for the MVP.

## Why the statistics favour 1,000 prompts

AI answers are stochastic. A St. Gallen study ("Don't Measure Once", arXiv 2604.07585) and several
vendor studies show the same prompt yields different brand lists across runs, so a single answer
is unreliable. But **aggregate** visibility over many prompts is stable: at 1,000 prompts, a 30%
visibility rate has a 95% confidence interval of about ±2.8 percentage points. So 1,000 prompts
run once a week gives you a trustworthy weekly number; per-prompt conclusions need repeats
(see [01-RESEARCH.md §5](01-RESEARCH.md#5-answer-variability--why-one-run-is-not-a-measurement)).

## The biggest decision: how answers are collected

| Method | Matches what users see | Cost | Stability | ToS risk to you |
|---|---|---|---|---|
| Official APIs with web search (OpenAI, Gemini grounding, Perplexity Sonar, Claude) | Partially — studies find large source/brand gaps vs the UI | Low–medium | High | None |
| UI-scrape data vendor (DataForSEO, Bright Data, Apify) | Yes | Very low per answer | Medium (vendor absorbs breakage) | Low (vendor's) |
| Own headless browser fleet scraping the UIs | Yes | Proxies + accounts + constant maintenance | Low | **High** — account bans, ToS breach |
| The existing extension as an opt-in browser worker | Yes (logged-in, real session) | $0 | Medium | Medium — your own account |

**Recommendation:** a pluggable collector layer, default **vendor UI-scrape for ChatGPT and Google
AI Mode/Overviews, official API for Gemini/Perplexity/Claude**, and keep the extension as the
free "ground-truth" worker for spot-checks. Never build a self-run scraping fleet for MVP.

## What Peec AI does (the system you asked to study)

Peec AI runs each tracked prompt once every 24 hours, collects answers by **driving the engines'
public web interfaces rather than their APIs** (per its own docs), with in-country infrastructure
for location fidelity. It reports Visibility (% of chats mentioning the brand), Position (average
rank), Sentiment (0–100), and source "used"/"cited" visibility, and it exposes an MCP server
(`api.peec.ai/mcp`, Streamable HTTP, OAuth) with read + write tools over projects, brands,
prompts, tags and topics. Pricing is ~$95/month for 50 prompts — i.e. **~$2 per prompt per
month**. At that rate, 1,000 prompts on 4 engines would cost ~$2,500/month; this plan targets the
same load for ~$25–$75/month on a 7-day rotation, or ~$230–$490/month daily. Details in [01-RESEARCH.md §2](01-RESEARCH.md#2-peec-ai--how-it-is-built-and-run).

## What to do next

1. Approve the collector choice per engine (§7) and cadence (§2).
2. Create the new repo `citoskeleton-cloud` and seed it per [09-ROADMAP.md Phase 0](09-ROADMAP.md#phase-0--new-repository).
3. Build Phase 1 (single brand, two engines, API + MCP read-only) and validate costs on 100 real
   prompts before scaling to 1,000.
