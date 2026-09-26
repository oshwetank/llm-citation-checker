# CitoSkeleton

_Formerly listed on the Chrome Web Store as "LLM Citation & Fan-Out Checker."_

A Chrome (MV3) extension that **passively** captures what ChatGPT, Gemini, Perplexity and Grok actually do
behind an answer — the hidden search queries they fire, every source they read, which of
those they *cite* versus merely *fetch*, and which brands they name — then measures your
brand's visibility against competitors over time.

Everything is stored **locally in your browser**. The extension makes **no network requests
of its own**; nothing leaves your device.

> **v0.45.3** — ChatGPT, Gemini, Perplexity and Grok. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [RESEARCH.md](RESEARCH.md)
> for the original feasibility research. Taking over development? Start with
> [HANDOFF.md](HANDOFF.md).
>
> **Recent changes:**
> - Undid 0.45.2's Grok change, which re-sent prompts whenever Grok moved to its new
>   conversation after a send.
> - Read-only sources whose title shares no word with any search the engine ran are
>   tagged "title mismatch" in Analyze.
> - Source Domains shows each domain's "Cited %": of the answers that read it, the share
>   that cited it.

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
- **A run keeps working after its tabs have been in the background for five
  minutes.** Chrome slows timers in hidden tabs, to once a second immediately
  and to once a *minute* after five minutes, and a run's engine tabs are always
  hidden. The prompt-submitting loop ran on the page's own timer, so it crawled
  from the start and all but stopped at the five-minute mark: two real runs in
  two browsers stopped succeeding at 4.96 and 4.97 minutes, on every engine at
  once. The loop's clock now comes from the extension's service worker, whose
  timers and messages Chrome doesn't throttle. Each tab also holds a Web Lock
  while its prompt is in flight, one of Chrome's documented exemptions from
  freezing background tabs under Energy Saver.
- **A timed-out prompt says why.** A failure used to be the bare word "timeout",
  which can mean opposite things. The run now asks the tab where the prompt got
  to before giving up on it. It records *never went out*, *sent but no answer
  captured*, *signed out* or *page script not responding*, together with the
  step it reached, how far apart its timer ticks really were (proof of
  throttling if there was any), and its step-by-step trace, all in the
  diagnostics export.
- **Grok answers are captured again.** grok.com moved its chat from a REST
  stream onto a WebSocket gateway (`wss://grok.com/ws/mgw/`), which two
  independent open-source grok.com bridges document. The page script already
  caught the socket, but the Grok reader only knew the old format, so every
  answer read as empty and was silently dropped. Grok scored 0 in every
  campaign export. The reader now understands the gateway's events: the
  prompt the page sends, streamed answer text (reasoning kept separate),
  inline citation cards, search results and search queries. Each answer is
  handed over the moment the gateway says it's done, not on a timer Chrome
  can delay in a background tab.
- **An answer that can't be read is reported, not dropped.** When a campaign
  capture yields nothing readable, the log records where it came from and its
  shape (event types or field names, never content). The timed-out prompt says
  *engine replied, but the reply couldn't be read*, and the diagnostics export includes the
  payload itself under `unreadable/`. The next format change will show up in
  the first export.
- **See which index each ChatGPT source came from.** ChatGPT runs its own
  search index, internally called Labrador (a family of vertical indexes:
  web, news, arXiv, Wikipedia, Reddit, YouTube, PDF, local, finance, legal,
  medical, images), alongside external providers: Bing, SerpAPI (Google
  results), Microsoft's grounding service, Bright Data, Oxylabs, Yelp and
  Foursquare. Each source in a capture now shows its pipeline when ChatGPT
  names it: **Labrador** in teal, external ones as *Web · provider*. There
  are filters for each, and a summary line. The tool recognises all 69
  engines in the leaked retrieval registry, and lists any the answer's
  stream names, OpenAI's own apart from external ones. ChatGPT sent
  `result_source` only from 21 May to 21 July 2026, so for other captures
  the pipeline is shown as not labelled rather than guessed. Every source
  also shows its type (web, news, scientific, forum, video, local,
  product), and local listings show their supplier code (b1, b3, serp…).
  The workbook's *Sources (full)* sheet gains a Pipeline column. Research:
  Peec AI, "ChatGPT built its own search index" and "The Complete List:
  Every Search Engine Hidden Inside ChatGPT's Retrieval Leak"; RESONEO,
  "What ChatGPT pulls, what it shows, what it cites".
- **One prompt is sent once.** In a background tab an engine can take seconds
  to act on a click, while the run retried every 0.4 seconds. Every retry
  the page later accepted became another submission: one real run sent the
  same prompt to Gemini up to nine times. Retries are now at least 3 seconds
  apart, with at most five per prompt, and stop as soon as the engine's own
  request is seen.
- **Each prompt counts once in the results.** An engine can deliver several
  captures of one answer: Gemini streams it in parts, and Perplexity is read
  from both its stream and its page. Every copy used to count as a separate
  response, so 7 answered Gemini prompts counted as 30. The campaign numbers
  now use the most complete capture of each prompt, per engine, per run. The
  diagnostics export still includes every copy.
- **A tab that stops responding is described from outside.** When an engine's
  page doesn't answer at all, the timeout reports what Chrome says about
  the tab: frozen, discarded, still loading, on a verification page, or
  where it ended up. It also includes a log of the tab's loads during that
  prompt. Only the host and path are recorded, never the prompt.
- **A prompt is never skipped by a duplicate answer.** Gemini sends several
  captures per answer. A second one arriving during the pause before the next
  prompt was counted as that next prompt's answer, so the prompt was marked
  done without ever being asked. One real run reported 35/40 this way. A turn
  can now only be completed while it is actually in flight.
- **Perplexity's live answer stream is read.** Its answers now arrive as
  `blocks` (markdown chunks, or a workflow patched by diffs) with sources in a
  separate block, and the prompt in `query_str`. The reader only knew the older
  format, so every stream was dropped and Perplexity relied on the slower page
  harvest. Inline `[n]` citations become links to the source they name, and
  only sources the answer cites count as cited.
- **A sent prompt is recognised from the engine's own request.** Whether a
  prompt went out used to be judged only from the page: the address changing,
  a stop button, the prompt showing in the conversation. On Grok none of those
  matched, so the extension kept retyping a prompt that had already gone and
  then reported it as never sent. The page's own "answer this" request (the
  conversation POST, Gemini's StreamGenerate, Perplexity's `perplexity_ask`,
  Grok's `conversation.item.create`) now counts as proof on its own.
- **Long answers get time to finish.** When a prompt's 90 seconds run out while
  the engine is still visibly writing, it gets up to two more minutes rather
  than being failed mid-answer.
- **"Page script not responding" is explained.** The page now answers the
  run's check even when it holds no prompt, saying whether it was reloaded or
  navigated away, whether it still had the run's markers, and whether a
  verification page is showing. A timeout then reads, for example, *page
  reloaded and lost the prompt*.
- **The diagnostics export works for real campaigns.** It used to send
  everything in one internal message, which Chrome caps at 64 MiB, and a
  ten-prompt campaign already exceeded that. It now fetches records and
  payloads a piece at a time.
- **A half-updated install is called out.** Windows can skip files Chrome has
  open when an update is extracted over the folder, leaving new screens running
  on top of an old engine that every screen still labels as the new version.
  The panel now checks which code is actually running and shows how to fix a
  mismatch before a run is wasted on the old code.
- **Every campaign capture is filed under the prompt it actually answers.** A slow
  answer used to be labelled with whatever prompt its tab had moved on to by the
  time it arrived — so one prompt's answer was quietly counted in another's
  Visibility and Position. The label now comes from the question the capture
  itself carries.
- **Perplexity's thread history can't pose as this run's answer.** When no live
  answer stream is caught, Perplexity's recent-threads list is often all a
  capture holds — and that list is account-wide and full of earlier runs of the
  very same prompts. A campaign now keeps a thread's preview only when it is that
  tab's own prompt, updated during this run, and logs every one it refuses.
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
