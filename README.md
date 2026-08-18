# Citely

A Chrome (MV3) extension that **passively** captures what ChatGPT and Gemini actually do
behind an answer — the hidden search queries they fire, every source they read, which of
those they *cite* versus merely *fetch*, and which brands they name — then measures your
brand's visibility against competitors over time.

Everything is stored **locally in your browser**. The extension makes **no network requests
of its own**; nothing leaves your device.

> **v0.25.0** — ChatGPT and Gemini. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design
> and [RESEARCH.md](RESEARCH.md) for the original feasibility research.

## Two modes, deliberately kept apart

The extension does two different jobs, and their data never mixes.

**1. Ad-hoc analysis** — just browse. Every ChatGPT/Gemini answer you run is captured and
broken down in **Analyze** (one conversation) and **Dashboard** (aggregates across all of
them). Nothing to configure.

**2. Campaigns** — a repeatable measurement surface. You define a brand, its competitors,
a fixed prompt set and which engines to run, then re-run it on a cadence and watch the
metrics move.

These are isolated on purpose. A campaign response carries a `geo` provenance bag
(`profileId` / `runId` / `promptId` / `tags`); an ordinary browsing capture does not. The
ad-hoc views filter campaign responses out, and campaign metrics only ever read campaign
responses. Without that split, one stray manual query about an unrelated topic would move
a brand's Visibility — and the numbers would stop being reproducible.

## What it extracts

- **Fan-out queries** — the sub-searches the model issues before answering. ChatGPT
  exposes these; Gemini does not (a platform limitation, not a gap in the adapter).
- **Sources**, split into `cited` / `fetched` / `mentioned`. The gap between what a model
  *read* and what it *credited* is usually where the optimisation opportunity is.
- **Brand mentions** — automatic and industry-agnostic. No word list to maintain; it works
  the same for banking, jewellery, hospitals or phones.
- **Products, prices, ratings, merchants** from shopping carousels.
- **Local businesses** — name, rating, review count, address, phone, hours, Place ID.
- **Entities**, reference-type breakdown, carousel flags, and the reconstructed answer text.

## Campaign metrics

| Metric | Definition |
|---|---|
| **Visibility** | responses mentioning the brand ÷ total responses |
| **Share of Voice** | brand's mentions ÷ all tracked brands' mentions |
| **Position** | average rank by first appearance, over responses where the brand appears |
| **Citations** | responses citing the brand's own domain |
| **Source Visibility** | responses where the brand's domain appeared as a source at all |

Visibility and Share of Voice implement [Peec.ai's published formulas](https://docs.peec.ai/metrics/brand-metrics/visibility)
verbatim, so the numbers are comparable with that tool; the test suite reproduces their own
worked examples.

**Sentiment is deliberately not implemented.** The published definition gives a 0–100 scale
but neither a formula nor an aggregation method. In a tool whose value is trustworthy
measurement, a fabricated score is worse than a visible gap — so the UI reports it as
"not measured" and says why. It needs an LLM-judge pass or a documented lexicon first.

## Engine support

| Engine | Status |
|---|---|
| **ChatGPT** | Full — fan-out, cited/fetched split, products, places, brands, answer text |
| **Gemini** | Full except fan-out — citations, shopping, local/places, answer text |
| Perplexity · Claude · Grok | Not built. Shown disabled in the UI rather than hidden, so a metric can never silently under-count because a checkbox did nothing |

## Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin it, then open ChatGPT or Gemini in a **new** tab — the network patch has to install
   before the page loads — and run a prompt.

## Running a campaign

1. **Campaigns** tab → create a campaign (up to 3).
2. Set your brand + URL and your competitors + URLs. The URLs are what let cited domains be
   attributed to the right brand.
3. Add prompts — type them, or import a CSV/XLSX. Columns are matched by header name
   (`Prompt`/`Query`, and `Tags`/`Industry`/`Category`/`Topic`…), so a real client sheet
   usually imports as-is. Tag prompts to filter metrics by theme later.
4. Pick engines, then **Lock** the campaign. Locking freezes the brand and prompt set —
   changing either mid-stream changes what the metrics are measured *against*, and the
   time series stops being comparable.
5. Run it. The run fires prompts at a human pace and can be paused, resumed or stopped.

Deleted campaigns go to a trash with a 7-day restore window; their captured responses are
kept either way.

### Automation and account safety

A run submits prompts through **your logged-in ChatGPT/Gemini session**. Volume is shown
before you commit (prompts × engines), with a warning past 60 submissions in one run.
Nothing ever fires unattended — a run needs your click; the extension only reminds you when
a day has passed. At meaningful scale, consider a dedicated account rather than a personal
one. This is real automation of a service whose terms discourage it; treat it accordingly.

## Exports

- **Conversation → HTML / PDF** — a clean, readable document with ChatGPT's inline citations
  rendered as numbered footnotes linked to the right source, plus product images, sources,
  fan-out queries and brand mentions. PDF uses the browser's own print engine, so the text
  stays selectable. One conversation, or many composed into a single document with a
  contents page.
- **Excel (.xls)** — 11 worksheets covering every captured field: summary, audit log, source
  analysis, domains, full sources, fan-out queries, brand mentions, products, local
  businesses, entities and full answer text.
- **Detailed CSV**, **bulk JSON**, and a per-drill-down CSV from any Dashboard metric.
- **Campaign metrics CSV** from the Campaigns tab.

## Tests

```bash
for t in test/*.test.mjs; do node "$t"; done
```

282 assertions across five suites, all fixture-backed by real captured payloads:

| Suite | Covers |
|---|---|
| `adapter.test.mjs` | Both adapters against real capture fixtures |
| `behaviour.test.mjs` | Regressions that once broke silently — answer-text persistence, marker parsing, export rendering |
| `brands.test.mjs` | Industry-agnostic brand detection across many verticals |
| `geo.test.mjs` | Campaign metrics, including Peec's published worked examples, and the ad-hoc/campaign isolation |
| `xlsxlite.test.mjs` | The dependency-free XLSX reader |

Because raw payloads are kept, **↻ Reprocess all captures** (About tab) re-derives every
stored record after an adapter fix — no re-capturing. This matters: MV3 forbids remote code,
so a parser fix means a new store submission, and your history has to survive the gap.

## Project layout

```
manifest.json            MV3 manifest (chatgpt.com, chat.openai.com, gemini.google.com)
src/
  content-main.js        MAIN world: patches fetch + XHR, tees the response (no parsing)
  content-iso.js         ISOLATED world: relays raw captures, drives campaign runs
  background.js          service worker: storage, adapter dispatch, campaign
                         orchestration, metrics computation, message API
  schema.js              the normalized cross-engine record
  adapters/chatgpt.js    ChatGPT extraction (SSE delta reconstruction, marker parsing)
  adapters/gemini.js     Gemini extraction (batchexecute / StreamGenerate)
  lib/geo.js             campaign shapes + the metrics engine
  lib/brands.js          industry-agnostic brand/entity detection
  lib/exportDoc.js       conversation → HTML/PDF renderer
  lib/xlsxLite.js        dependency-free XLSX reader for prompt import
  lib/db.js              IndexedDB wrapper (v4: raw, derived, projects, runs,
                         profiles, trackedPrompts, geoRuns)
  lib/gzip.js            CompressionStreams helpers
  lib/deep.js            deep-walk / shape-search utilities
ui/
  panel.html/.css/.js    Analyze · Dashboard · Campaigns · Compare · About
  export.html/.js        the print-to-PDF page
test/                    five suites + real capture fixtures
```

## Privacy

Everything stays in your browser's IndexedDB. The extension makes no network requests and
asks for host access to ChatGPT and Gemini only. Raw payloads are gzipped; storage is capped
(default 2,000 captures, 8 MB per payload) with oldest-first pruning. Clear everything from
the Dashboard at any time.

## Not built yet

Perplexity / Claude / Grok adapters · Google AI Mode (the other real fan-out surface) ·
sentiment · trend charts (the series is computed and tested, just not drawn) · per-prompt
drill-down showing which prompts a brand is losing on.
