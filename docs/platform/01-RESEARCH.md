# 01 — Research: how AI-visibility trackers work

**Date:** 2026-10-29. Method: web search across vendor docs, review sites, developer forums,
GitHub and the Hugging Face paper index. Several primary sites (docs.peec.ai, surfer.ai) could not be
fetched directly from the research environment, so some findings come via search-result summaries of
those pages. **Most quantitative claims in this space come from vendors selling a tool** — each is
labelled with its source and should be read as a claim, not a fact. Prices are as reported in
Aug–Oct 2026 and move often.

---

## 1. The category in one paragraph

"AI visibility" / GEO (generative engine optimisation) / AEO tools all do the same core loop:
take a **fixed list of prompts** a buyer might ask, **submit them to AI engines on a schedule**,
store each answer, and compute **how often and how prominently a brand appears** versus
competitors, plus **which web sources the engine cited**. Differences between vendors come down to
(a) *how* they collect answers (official API vs driving the real web UI), (b) which engines and
countries they cover, (c) prompt volume per dollar, and (d) analysis layers on top (sentiment,
source categorisation, recommendations, agent/MCP access).

CitoSkeleton already does (a) via the user's own browser, (b) for ChatGPT/Gemini/Perplexity/Grok,
and most of (d) except sentiment. What it lacks is the **hosted, scheduled, multi-tenant** part.

---

## 2. Peec AI — how it is built and run

*("Beck AI" in the brief is taken to be Peec AI, peec.ai, the Berlin-based AI search analytics tool.)*

### 2.1 Collection

- **Runs every tracked prompt once every 24 hours** (Peec help centre: "Getting started — Part 1:
  Understanding prompts"; agency page: "metrics are updated daily").
- **Collects through the engines' public web interfaces, not their APIs.** Peec's own docs argue
  API responses differ from the interface and that API sources differ from what users see
  ([docs.peec.ai/intro-to-peec-ai](https://docs.peec.ai/intro-to-peec-ai),
  [peec.ai/ai-instructions](https://peec.ai/ai-instructions)). A third-party guide describes this as
  browser automation that "interacts with the actual UI" (metehan.ai). Profound — the main
  competitor — also uses front-end collection.
- **Location fidelity:** Peec says it runs dedicated infrastructure in each supported country,
  contrasting with competitors that inject location hints into the prompt
  ([peec.ai/comparison/peec-vs-profound](https://peec.ai/comparison/peec-vs-profound) — vendor claim).
- **Engines:** ChatGPT, Perplexity, Gemini, Microsoft Copilot, Google AI Mode, Google AI Overviews
  (Claude/Grok/others on higher tiers). Self-serve plans include three engines; a fourth is an add-on.
- **Prompts are user-supplied.** Peec does not generate prompts from search data; you add them
  (or they are suggested in onboarding).
- Independent review (trakkr.ai) notes UI collection is closer to a *logged-out* user's view, still
  varies day to day, and covers only the controlled prompt set. UI scrapers break when layouts change.

### 2.2 Data model (inferred from docs and MCP tool list)

`Project` (one per brand/client) → `Brands` (own + competitors, with domains/aliases) →
`Prompts` (with **Tags** and **Topics**, country) → per-day **Chats** (one answer per prompt ×
model × day) → extracted **Mentions** and **Sources** → aggregated **Reports**.

### 2.3 Metrics

| Peec metric | Definition (Peec docs) | CitoSkeleton equivalent |
|---|---|---|
| Visibility | % of chats where the brand is mentioned | **Visibility** (identical) |
| Position | Average rank of the brand within the answer | **Position** (identical: first-appearance rank) |
| Sentiment | 0–100; ~85 clearly positive, ~65 neutral, <65 critical | Deliberately not measured (see `SENTIMENT_NOTE`) |
| Share of Voice | Brand mentions ÷ all tracked brands' mentions | **Share of Voice** (identical) |
| Source visibility — *used* | Your content contributed to the answer, even uncited | **Source Visibility** (domain appeared as any source) |
| Source visibility — *cited* | Your domain was cited | **Citations** |
| Source types | Editorial (TechCrunch, Forbes), UGC (Reddit, YouTube), reference (Wikipedia), corporate | Not yet — proposed in PRD as `source_category` |

Peec tracks Perplexity citation rate separately from mention rate because Perplexity often cites a
domain without naming the brand — CitoSkeleton's cited/fetched/mentioned split already captures that.

### 2.4 API and agent access

- **MCP server:** `https://api.peec.ai/mcp`, Streamable HTTP, OAuth 2.0. The tools reference lists
  **33 read tools** (projects, brands, prompts, reports, sources…) and **43 write tools** (create /
  update / archive / delete brands, prompts, tags, topics). One older page says "read-only"; the
  tools reference supersedes it — write tools ask for confirmation.
- **REST API:** beta, Enterprise-only, per a third-party listing. A community MCP server
  (`mcp-server-peecai`) uses an API key from *Settings → API Keys*.
- Docs index for agents is published at `docs.peec.ai/llms.txt`.

**Takeaway for us:** agent access is now table stakes — Peec ships it as MCP-first. We should ship
REST + MCP over the same service layer from the first release, and publish an `llms.txt`.

### 2.5 Pricing (conflicting sources; verify)

| Plan | Price | Prompts | Source |
|---|---|---|---|
| Starter | $95/mo (or €89) | 50 (or 25) | Capterra / G2 vs Toolradar |
| Pro | $245/mo (or €199) | 150 (or 100) | Capterra vs Toolradar |
| Advanced | $495/mo | 350 | Capterra |
| Agency Essential / Growth / Scale | $245 / $495 / $795 | 111 / 277 / 722 across 3 / 10 / 25 projects | rework.com |
| Extra engine | $35–$165/mo | — | gtm8020.com |

**≈ $1.10–$2.00 per prompt per month** at daily cadence on three engines.

---

## 3. Other commercial tools

| Tool | Collection | Entry price | Notes |
|---|---|---|---|
| **Profound** | Front-end browsers; "Conversation Explorer" prompt-volume dataset | Enterprise only since ~Sep 2026 (median contract ~$35k/yr per Vendr, via pinggy.io) | Market leader for enterprise |
| **Otterly.AI** | Not disclosed | $29/mo, ~15 prompts | Gemini / AI Mode / Claude are add-ons |
| **Scrunch AI** | Not disclosed | $250/mo (annual) | All 7 engines on every plan; SOC 2 Type II |
| **Ahrefs Brand Radar** | Large prompt database | ~$828+/mo | Prompt-volume estimates rather than your own prompts |
| **Semrush / SE Ranking (SE Visible)** | Mixed | Bundled with SEO suites | |
| **DataForSEO LLM Mentions** | Pre-collected database | $0.10/request + $0.001/row | Data provider, not a dashboard |

Pricing trend in 2026: entry tiers are being removed (Profound) or engines unbundled (Otterly,
Peec) — the per-prompt cost of commercial tools is not falling. That's the gap a low-cost
self-hosted tool fills.

---

## 4. Open-source and self-hosted trackers

| Project | What it does | Collection | Relevance |
|---|---|---|---|
| **geo-aeo-tracker** (github.com/danishashko/geo-aeo-tracker; mirrored under brightdata) | Dashboard for 6 engines (ChatGPT, Perplexity, Gemini, Grok, AI Mode, Copilot); mention scoring, citation gaps | Bright Data's paid AI Scraper API (dataset IDs per engine) | Closest reference architecture: thin app over a scraping vendor |
| **Ansvisor** | MIT, TypeScript, self-hostable; mentions, citations, sentiment, SOV | Not verified | Licence allows reuse of ideas |
| **AiCMO** | MIT; mentions, citations, SOV benchmarking | API | Low activity |
| **PromptBeacon** (PyPI) | Local-first Python toolkit; visibility score, mention counts, sentiment | Provider APIs (OpenAI/Anthropic/Google) | Shows the API-only approach |
| **OneGlanse** | Records real UI answers from ChatGPT, Gemini, Perplexity, Claude, AI Overviews | Browser | UI-first like CitoSkeleton |
| **Canonry** | Self-hosted AEO stack, citation tracking | Not verified | |
| **open-geo** | Agent skill measuring rendered answers in a logged-in browser, portable JSON | Logged-in browser | Same idea as our "browser worker" |

Claims above are from directory listings / READMEs and were not code-audited.

**Takeaway:** none of these has CitoSkeleton's depth of extraction (fan-out queries, cited vs fetched
vs mentioned, products, places, industry-agnostic brand detection with tests). The defensible asset
is the analysis core; collection can be bought cheaply.

---

## 5. Answer variability — why one run is not a measurement

| Evidence | Finding | Source type |
|---|---|---|
| "Don't Measure Once: Measuring Visibility in AI Search" — Schulte, Bleeker, Kaufmann, Univ. St. Gallen (arXiv 2604.07585, 2026) | 4 engines × 4 verticals, 45 days daily + same-day simultaneous re-runs; visibility must be treated as a **distribution**, with **stability** as a second metric | Academic |
| Conductor | Same prompts × 50 runs per LLM; purchase-intent prompts had ~40% brand-list overlap between runs | Vendor |
| arXiv 2605.27440 ("Paraphrase Brittleness…") | Paraphrasing an intent moved recommendation sets far more (14–29% Jaccard) than re-running the same prompt (50–61%) | Academic |
| Texta | 10,000 identical ChatGPT queries: materially different answers 34% of the time; brand citations changed in 28% | Vendor |

**Design consequences** (carried into the PRD and architecture):

1. **Breadth beats repetition.** Many paraphrased prompts per topic (which 1,000 prompts gives you)
   reduce error more than re-running one prompt many times.
2. **Report intervals, not just points.** Every metric in the API returns `n` and a 95% Wilson
   interval. At n = 1,000 and p = 0.30 the interval is ±2.8 pp; at n = 50 it is ±12.7 pp.
3. **Add a Stability metric:** share of prompts whose brand-present/absent outcome is the same as
   the previous run (or across k repeats).
4. **Optional repeats** (`samples_per_run`, default 1, max 5) for small, high-stakes prompt sets.

---

## 6. API answers vs UI answers

| Study | Finding |
|---|---|
| Promptwatch | ChatGPT UI answered 84% of prompts with sources vs 26% via API; only 25.6% source overlap |
| Surfer (1,000 prompts) | 24% brand overlap UI vs API. Cited sources: ChatGPT 12.1 (UI) vs 3.1 (API); Perplexity API 19.5 vs app 10.27; Gemini API 6.5 vs app 3.4 |
| Paprik (35 prompts) | ChatGPT UI surfaced 845 unique brands vs 135 from the API *without* web search |
| Gumshoe (rebuttal) | The gap is mostly system-prompt/configuration and whether search is on — not "API vs UI" per se |

All are vendors with a stake. The consistent signal: **an API call without web search measures
training-data recall, not AI search** — never use that. An API call *with* search narrows the gap
but does not close it, especially for ChatGPT. So:

- Label every response with its `collector` (`api`, `vendor_ui`, `browser_worker`) and **never mix
  collectors inside one time series**. A brand account picks one collector per engine and keeps it
  (the same "lock" principle the extension already applies to prompt sets).
- Use the browser worker (real UI) to periodically calibrate the cheaper collector.

---

## 7. Academic GEO work worth knowing

- **GEO: Generative Engine Optimization** — Aggarwal et al., arXiv 2311.09735 (KDD 2024). Defines
  position-adjusted word-count and subjective-impression visibility metrics; GEO-bench.
- **E-GEO** — arXiv 2511.20867. 7,000+ e-commerce queries; compares 15 rewriting heuristics.
- **C-SEO Bench** — arXiv 2506.11097 (NeurIPS 2025 D&B). Most GEO tactics *don't* reliably work
  (3 of 54 method-domain cases significant). Good reason to sell measurement, not magic.
- **SAGEO Arena** — arXiv 2602.12187. End-to-end retrieval + rerank environment.
- **Manipulating LLMs to Increase Product Visibility** — arXiv 2404.07981; **SafeGEO** (2606.28356) and
  **Counter-GEO-Bench** (2609.02316) on adversarial GEO — relevant for why we report sources.
- **Don't Measure Once** — arXiv 2604.07585 (see §5).

---

## 8. Collection-method economics (summary; full tables in 02)

| Engine | Official API w/ search | UI-scrape vendor | Own browser |
|---|---|---|---|
| ChatGPT | OpenAI Responses `web_search`: ~$10/1k calls + tokens (one measured answer ≈ $0.058 on a large model) | DataForSEO ChatGPT scraper from ~$0.0012/page | Extension |
| Gemini | Grounding w/ Google Search: **5,000 free prompts/month** (Gemini 3), then ~$14/1k search queries | Bright Data ~$1.50/1k records | Extension |
| Perplexity | Sonar: $5/1k requests (low context) + ~$1/M tokens. **Possible deprecation (one source: supported until 27 Sep 2026, Agent API recommended) — verify** | Apify ~$3.72/1k | Extension |
| Google AI Mode / AI Overviews | none | DataForSEO AI Mode ~$1.20–$4/1k; SERP ~$0.60–$2/1k | — |
| Claude | Web search $10/1k searches + tokens (Anthropic docs) | some vendors | — |
| Grok | xAI live search (price not found — verify) | Bright Data | Extension |
| Copilot | none | Bright Data | — |

## 9. Automation & ToS facts

- OpenAI's terms (as quoted by third-party trackers) prohibit automatically or programmatically
  extracting data from its services except via the API; violations can lead to suspension.
  Perplexity's terms were not retrieved — assume similar.
- ChatGPT sits behind Cloudflare; headless Playwright from datacenter IPs is commonly blocked
  before any challenge. Stealth workarounds reportedly break every few weeks. This is the reason
  **not** to build a self-run scraping fleet.

## Sources

- Peec: [product/ai-visibility](https://peec.ai/product/ai-visibility) · [for-agencies](https://peec.ai/for-agencies) · [help: understanding prompts](https://help.peec.ai/article/part-1-understanding-prompts-72stgax8rzyzm0tydlk2c92r) · [docs intro](https://docs.peec.ai/intro-to-peec-ai) · [understanding metrics](https://docs.peec.ai/understanding-your-metrics) · [MCP tools](https://docs.peec.ai/mcp/tools.md) · [ai-instructions](https://peec.ai/ai-instructions) · [peec vs profound](https://peec.ai/comparison/peec-vs-profound) · [Glama community MCP](https://glama.ai/mcp/servers/qehkunhsl8)
- Peec reviews/pricing: [SE Ranking review](https://visible.seranking.com/blog/peec-ai-review/) · [metehan.ai guide](https://metehan.ai/articles/how-to-track-brand-visibility-in-ai-search/) · [trakkr data accuracy](https://trakkr.ai/reviews/peec-review/data-accuracy) · [rankdots](https://rankdots.com/blog/peec-ai) · [Capterra pricing](https://capterra.com/p/10030058/Peec-AI/pricing) · [Toolradar](https://toolradar.com/tools/peec-ai/pricing) · [rework.com](https://resources.rework.com/tools/aeo-ai-visibility/best-peec-ai-alternatives) · [gtm8020](https://www.gtm8020.com/blog/ai-visibility-tool-pricing) · [G2](https://www.g2.com/compare/peec-ai-vs-profound)
- Competitors: [pinggy Profound alternatives](https://pinggy.io/blog/best_profound_alternatives/) · [debutify](https://debutify.com/blog/best-profound-alternatives-for-ai-search) · [DataDab comparison](https://www.datadab.com/research/profound-vs-hubspot-aeo-vs-scrunch-vs-otterly-vs-peec-vs-athenahq) · [Profound vs Peec](https://www.tryprofound.com/articles/profound-vs-peec-ai)
- Open source: [geo-aeo-tracker](https://github.com/danishashko/geo-aeo-tracker) · [Bright Data blog](https://brightdata.com/blog/ai/ai-visibility-tracker) · [PromptBeacon](https://pypi.org/project/promptbeacon/) · [openalternative AI visibility](https://openalternative.co/categories/ai-visibility-tracking/using/github) · [GitHub topic brand-monitoring](https://github.com/topics/brand-monitoring)
- API vs UI: [Promptwatch](https://promptwatch.com/blog/ui-vs-api-for-ai-search-visibility) · [Surfer](https://surfer.ai/blog/llm-scraped-ai-answers-vs-api-results/) · [Paprik](https://paprik.ai/blog/accurate-api-based-ai-visibility-tracking-chatgpt-ui) · [Gumshoe](https://gumshoe.ai/blog/how-apis-unlock-better-insights-into-ai-search-visibility/) · [Superlines](https://www.superlines.io/articles/api-vs-ui-data-ai-visibility-tools)
- Variability: [arXiv 2604.07585](https://arxiv.org/abs/2604.07585) · [Conductor](https://www.conductor.com/academy/ai-recommendation-consistency-analysis/) · [arXiv 2605.27440](https://arxiv.org/html/2605.27440) · [Texta](https://www.texta.ai/blog/answer-variability-study-why-chatgpt-gives-different-answers) · [SEJ on Peec prompt variance](https://www.searchenginejournal.com/ai-prompt-intent-keywords-peec-spa/576201/)
- Papers: [GEO 2311.09735](https://arxiv.org/abs/2311.09735) · [E-GEO 2511.20867](https://arxiv.org/abs/2511.20867) · [SAGEO 2602.12187](https://huggingface.co/papers/2602.12187) · [2404.07981](https://arxiv.org/abs/2404.07981) · [SafeGEO 2606.28356](https://arxiv.org/abs/2606.28356) · [Counter-GEO-Bench 2609.02316](https://arxiv.org/abs/2609.02316) · [2605.25517](https://arxiv.org/html/2605.25517)
- Pricing: [querying.ai OpenAI web search cost](https://querying.ai/en/blog/openai-api-web-search-cost) · [parallel.ai](https://parallel.ai/articles/openai-web-search-vs-parallel-vs-exa-vs-tavily-how-to-choose) · [Gemini grounding forum](https://discuss.ai.google.dev/t/grounding-free-quota-clarifying-2026-rules-for-gemini-2-5-flash-paid-tier-1/144593) · [Google dev blog](https://developers.googleblog.com/gemini-api-and-ai-studio-now-offer-grounding-with-google-search/) · [Perplexity pricing (puter)](https://developer.puter.com/tutorials/perplexity-api-pricing/) · [activepieces Sonar](https://www.activepieces.com/blog/perplexity-sonar-api-cost-per-search-2026-guide) · [Anthropic pricing](https://docs.claude.com/ko/docs/about-claude/pricing) · [DataForSEO AI Optimization](https://dataforseo.com/apis/ai-optimization-api) · [DataForSEO ChatGPT scraper](https://dataforseo.com/chatgpt-scraper-api) · [DataForSEO SERP pricing](https://dataforseo.com/pricing/serp/serp-api) · [DataForSEO AI Mode](https://dataforseo.com/pricing/serp/google-ai-mode-serp-api) · [Bright Data Gemini scrapers](https://brightdata.com/blog/ai/best-gemini-scrapers) · [Apify Perplexity](https://apify.com/automation-lab/perplexity-search-scraper)
- ToS/automation: [ConductAtlas OpenAI provision](https://conductatlas.com/platform/openai/terms-of-use-row/provision/CA-P-017130/prohibition-on-automated-data-or-output-extraction/) · [OpenAI community thread](https://community.openai.com/t/is-it-against-tos-to-scrape-a-conversation-with-chatgpt/74678) · [Latenode Cloudflare thread](https://community.latenode.com/t/playwright-automation-getting-blocked-by-cloudflare-when-accessing-chatgpt/21831) · [browseract](https://www.browseract.com/blog/why-does-your-ai-agent-fail-on-cloudflare-sites-and-how-to-fix-it)
- Hosting: [Supabase free limits](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) · [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-your-products/managing-billing-for-github-actions) · [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits)
