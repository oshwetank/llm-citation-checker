# CitoSkeleton

_Formerly listed on the Chrome Web Store as "LLM Citation & Fan-Out Checker."_

A Chrome (MV3) extension that **passively** captures what ChatGPT, Gemini, Perplexity and Grok actually do
behind an answer — the hidden search queries they fire, every source they read, which of
those they *cite* versus merely *fetch*, and which brands they name — then measures your
brand's visibility against competitors over time.

Everything is stored **locally in your browser**. The extension makes **no network requests
of its own**; nothing leaves your device.

> **v0.40.0** — ChatGPT, Gemini, Perplexity and Grok. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [RESEARCH.md](RESEARCH.md)
> for the original feasibility research.

## Two modes, deliberately kept apart

The extension does two different jobs, and their data never mixes.

**1. Ad-hoc analysis** — just browse. Every answer you run on a supported engine is captured and
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
  the same for banking, jewellery, hospitals or phones. Detection is tied to how a name is
  *written* — a capitalized proper noun in prose, not a category word from the prompt — so it
  holds up whichever way an answer happens to be laid out: a table with a use-case column
  instead of a name column, plain prose, headings, or bullet lists all report the same
  brands.
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

Every metric has exactly one definition, in [`src/lib/glossary.js`](src/lib/glossary.js):
the term, what it measures, the formula, and the caveat that stops it being misread. The UI
marks an element with `data-term` and the tooltip is built from that table, so a metric
cannot end up explained three different ways on three different screens. The test suite
checks the arithmetic against worked examples.

**Sentiment is deliberately not implemented.** Scoring whether an answer speaks about a
brand favourably needs either a language model reading every answer or a documented word
list. In a tool whose value is trustworthy measurement, a fabricated score is worse than a
visible gap — so the UI reports it as "not measured" and says why.

## Engine support

| Engine | Status |
|---|---|
| **ChatGPT** | Full — fan-out, cited/fetched split, products, places, brands, answer text |
| **Gemini** | Full except fan-out — citations, shopping, local/places, answer text |
| **Perplexity** | Fan-out, query plan, sources, brands, answer text (network + DOM-harvest capture) |
| **Grok** | Fan-out, sources, brands, answer text (network + DOM-harvest capture) |

## Install (unpacked)

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin it, then open ChatGPT, Gemini, Perplexity or Grok in a **new** tab — the network patch has to install
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
   Its engine tabs open grouped and collapsed under one "CitoSkeleton" tab group instead of
   spreading across the window, and close on their own once every prompt has finished — unless
   you've reclaimed one for your own browsing mid-run, or you stop the run yourself (Stop leaves
   the tabs open, since you're probably reaching for one of them).

Deleted campaigns go to a trash with a 7-day restore window; their captured responses are
kept either way.

### Automation and account safety

A run submits prompts through **your own logged-in sessions**. Volume is shown
before you commit (prompts × engines), with a warning past 60 submissions in one run.
Nothing ever fires unattended — a run needs your click; the extension only reminds you when
a day has passed. At meaningful scale, consider a dedicated account rather than a personal
one. This is real automation of a service whose terms discourage it; treat it accordingly.

## Exports

- **Conversation → HTML / PDF** — a clean, readable document with inline citations
  rendered as numbered footnotes linked to the right source (ChatGPT, Perplexity and Grok
  alike — a raw `<grok:render>` citation tag or a `[[cite:URL]]` marker never leaks into the
  page as garbled text), plus product images, sources, fan-out queries and brand mentions.
  PDF uses the browser's own print engine, so the text stays selectable. One conversation, or
  many composed into a single document with a contents page.
- **Excel (.xls)** — 11 worksheets covering every captured field: summary, audit log, source
  analysis, domains, full sources, fan-out queries, brand mentions, products, local
  businesses, entities and full answer text.
- **Detailed CSV**, **bulk JSON**, and a per-drill-down CSV from any Dashboard metric.
- **Campaign metrics CSV** from the Campaigns tab.

## Reporting a problem

A small icon in the Analyze context bar opens a report dialog that builds one archive from
the four things a real bug is actually diagnosed from: your note, the same HTML report
**Save as PDF** produces, the raw captured payload, and the derived record. Unlike the About
tab's diagnostic report, this bundle *does* contain prompt/answer/URL text — the dialog says
so before anything is written, and each part can be unticked. Nothing is transmitted by the
extension itself: the archive is built in the page and handed to you (via the OS share sheet
where available, or a downloaded file) to send however you choose.

## Reliability & safety

A Campaign run is real automation sitting on your own logged-in session, so it's held to a
higher bar than a normal feature:

- **A tab you've reclaimed for your own use is never silently driven.** Every navigation a
  run makes to a Loader-owned tab is checked first — the tab must still exist and still be on
  the expected engine — before it's touched. Click a source link, check something else, or
  come back after a browser restart (which reassigns tab IDs) and the run parks itself with an
  honest reason instead of navigating whatever page now holds that ID.
- **An engine opening the conversation it just created is success, not a reload.**
  Every supported engine moves the tab to a new URL once it accepts a prompt —
  which is exactly how the content script knows the submit worked. The run's
  mid-turn reload detector was reading that same navigation as a tab that had
  come back without its prompt, re-navigating (killing the answer already on
  its way), and failing the turn after a few rounds; because each retry
  re-issued the navigation, the retry produced the next detection. A turn is
  now only treated as lost when nothing ever claims it — evidence, not a
  stopwatch, since how long an engine takes to open a conversation isn't a
  constant this extension gets to pick.
- **A run's engine tabs can't be silently unloaded by Chrome's Memory Saver.**
  Four heavy chat SPAs sitting backgrounded for an entire run is exactly what
  automatic tab discarding targets to save memory — and a discarded tab
  reloads itself the instant the run next touches it, which used to read as
  a spurious mid-turn failure and could sink the large majority of a run's
  prompts across every engine at once. Every tab a run opens now opts itself
  out of auto-discarding the moment it's created.
- **A stuck run no longer fails silently forever.** Recovery after a worker restart or a
  browser restart is logged, not swallowed, and a degraded database read no longer turns into
  a repeating, invisible failure on every heartbeat tick.
- **Brand tracking survives being renamed mid-answer.** The on-device enrichment layer can
  upgrade a detected brand to a fuller form ("Ant" → "Ant Esports"), including more than once
  in the same answer — a brand tracked under any of those forms (original, current, or a form
  in between) still counts, in both the live metrics and the Excel export.

## Tests

```bash
for t in test/*.test.mjs; do node "$t"; done
```

55 test files, 1,500+ assertions, all fixture-backed by real captured payloads. A CI job
(`every test file is wired into CI`) fails the build if a test file exists but isn't wired
into the suite, so this can't quietly drift. Representative suites:

| Suite | Covers |
|---|---|
| `adapter.test.mjs` | All four adapters against real capture fixtures |
| `brand-context.test.mjs` | Brand detection that survives the answer's layout changing (table columns, prose, headings, bullet lists) |
| `behaviour.test.mjs` | Regressions that once broke silently — answer-text persistence, marker parsing, export rendering |
| `brands.test.mjs` | Industry-agnostic brand detection across many verticals |
| `geo.test.mjs` | Campaign metrics, worked examples for each formula, and the ad-hoc/campaign isolation |
| `feedback-bundle.test.mjs` | The problem-report archive, unpacked and verified with an independent zip reader |
| `xlsxlite.test.mjs` | The dependency-free XLSX reader |

Because raw payloads are kept, **↻ Reprocess all captures** (About tab) re-derives every
stored record after an adapter fix — no re-capturing. This matters: MV3 forbids remote code,
so a parser fix means a new store submission, and your history has to survive the gap.

## Project layout

```
manifest.json           MV3 manifest — chatgpt.com, chat.openai.com, gemini.google.com,
                        perplexity.ai, grok.com/x.com
src/
  content-main.js       MAIN world: patches fetch + XHR, tees the response (no parsing)
  content-iso.js        ISOLATED world: relays raw captures, drives campaign runs
  background.js         service worker: storage, adapter dispatch, campaign
                        orchestration (tab ownership, heartbeat recovery),
                        metrics computation, message API
  schema.js             the normalized cross-engine record
  adapters/
    chatgpt.js          SSE delta reconstruction, marker parsing
    gemini.js           batchexecute / StreamGenerate
    perplexity.js       network + DOM-harvest capture, citation markers
    grok.js             network + DOM-harvest capture, <grok:render> tags
  lib/
    geo.js              campaign shapes + the metrics engine
    brands.js           industry-agnostic brand/entity detection (Tier C, always on)
    ai-brands.js        on-device AI enrichment layered on top of brands.js
    funnel-omitted.js   "retrieved but never written" — brands/models a source
                        named that the answer dropped
    mention-list.js     SKU → parent-brand collapsing for the mention list
    fanout.js           fan-out query classification
    grounding-score.js  verbatim grounding score
    campaignWorkbook.js the multi-sheet campaign Excel export
    exportDoc.js        conversation → HTML/PDF renderer
    feedbackBundle.js   builds the problem-report archive
    zipWrite.js         dependency-free zip writer (CompressionStream, STORED fallback)
    xlsxLite.js         dependency-free XLSX reader for prompt import
    errorlog.js         the one durable diagnostics log — errors, capture
                        breadcrumbs and per-turn outcomes, privacy-scrubbed
    diagnosticsSummary.js  per-run expected/stored/missing/failed counts,
                        shared by the workbook and the campaign export
    auth-check.js       pre-flight session check before a Campaign run submits
    pacing.js           human-paced submission timing
    glossary.js         the one definition per metric the UI's tooltips read from
    demo-data.js        first-run sample data
    db.js               IndexedDB wrapper (raw, derived, projects, runs,
                        profiles, trackedPrompts, geoRuns, errors)
    nano.js             Chrome's on-device Gemini Nano hook
    gzip.js             CompressionStreams helpers
    deep.js             deep-walk / shape-search utilities
    sources.js, text-sanitize.js   shared source/text helpers
ui/
  panel.html/.css/.js   Analyze · Dashboard · Campaigns · Compare · About
  export.html/.js       the print-to-PDF page
test/                   55 suites + real capture fixtures
```

## Privacy

Everything stays in your browser's IndexedDB. The extension makes no network requests and
asks for host access to the supported engines only (ChatGPT, Gemini, Perplexity and
Grok). Raw payloads are gzipped; storage is capped
(default 2,000 captures, 8 MB per payload) with oldest-first pruning. Clear everything from
the Dashboard at any time.

## Not built yet

Google AI Mode (the other real fan-out surface) ·
sentiment · trend charts (the series is computed and tested, just not drawn) · per-prompt
drill-down showing which prompts a brand is losing on.
