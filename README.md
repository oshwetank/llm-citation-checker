# CitoSkeleton

_Formerly listed on the Chrome Web Store as "LLM Citation & Fan-Out Checker."_

A Chrome (MV3) extension that **passively** captures what ChatGPT, Gemini, Perplexity and Grok actually do
behind an answer — the hidden search queries they fire, every source they read, which of
those they *cite* versus merely *fetch*, and which brands they name — then measures your
brand's visibility against competitors over time.

Everything is stored **locally in your browser**. The extension makes **no network requests
of its own**; nothing leaves your device.

> **v0.60.1** — ChatGPT, Gemini, Perplexity and Grok. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [RESEARCH.md](RESEARCH.md)
> for the original feasibility research. Taking over development? Start with
> [HANDOFF.md](HANDOFF.md).
>
> **Recent changes:**
> - **ChatGPT's card answers read properly** (0.60.1). Some ChatGPT answers now arrive as
>   layout code for cards. They used to show every sentence twice, lose the intro, print the
>   tags, count no page as cited, keep one product of three and one image of three, take
>   words like "Around" and "Triple" for brands, and show a News chip with no news. Now the
>   answer reads as ChatGPT showed it, with every card as a product in its order, one picture
>   per card, the cited pages counted, and the follow-up choices it offered listed.
> - **Raw payload breakdown** (Expert only). Under the prompt, closed until you open it: the
>   engine's response laid out field by field in sections (what was sent, answer text, model
>   and settings, messages, searches, sources, products/places/images, ads, layout). Every
>   field shows how often it came and sample values. Fields no rule knows are listed under
>   "Not recognised" rather than dropped, and Chrome's on-device AI can suggest labels for
>   them on request; those labels are marked as guesses. It works on any engine's format,
>   because it doesn't assume one.
> - Scrolling a little no longer makes the Analyze page shake: the header used to shrink and
>   grow every frame near the point where it compacts.
> - Analyze in the full tab is rebuilt to the new design. The header is tinted by the kind
>   of answer and says whether it came from a campaign or was asked by hand, and whose brand
>   it tracks. Under the prompt sits a card for each engine that answered it, with that
>   engine's model, who it named first and where your brand came, then **Side by side** and
>   **Over time**. A rail on the left lists the page's sections and keeps the one you're
>   reading lit; "Hide the answer" gives the analysis the whole width, and picking a brand
>   brings the answer back with that brand lit.
> - **Where it came from**: for each brand, every cited page that names it, with where that
>   page came in ChatGPT's or Perplexity's results (#N) and the date the engine sent with it,
>   what the answer said about the brand, and a grid of which sites name which brands.
>   **Every site it read** adds the same position and date to each page, the brands each
>   site's pages name, and filters for cited, read only and "cited, silent on your brand".
> - **Products and where to buy**: each card's stores in the order it lists them, the
>   brand's own store marked, the cited pages that name that product, and where the cards
>   send buyers first. A store's own price isn't in the capture, and the page says so.
>   Places get the listing feed each one came from.
> - **ChatGPT ads** get their own place: a tile at the top, a section in the rail, and on
>   each ad whether the answer also named the advertiser (and in what place), whether its
>   site was read or cited, and whether any product card lists it as a store. Side by side
>   and Over time show which runs and engines had an ad; the others say "no ad format".
> - **Simple / Expert** in the top bar and in Settings. Expert adds each page's index and ref
>   ids, the listing feeds, a grounding figure, and a Raw tab with the fields the capture read.
> - **Over time** is redrawn: what changed from the first run to the latest, a line per brand
>   across the runs, the sites cited in each run, the searches by what they were after, and
>   the runs themselves with your brand's place in each. It used to count every search as
>   "[object Object]", and the line telling you to filter to one engine is gone.
> - The popup gets an engine strip and tabs by kind of answer: Overview, then Products,
>   Stores, Sources and Answer for shopping; Places, Facts, Sources and Answer for local;
>   Pictures, Parts and Sources for the others; Ads when ChatGPT showed one.
> - A new look, and the old one kept. CitoSkeleton opens in **Studio**, the new design: the
>   Geist typeface, a warm off-white page, solid white cards and one indigo accent. The look
>   from 0.47 to 0.58 is still there as **Classic** (IBM Plex, glass cards, blue). Pick
>   either in About → Settings → Theme, with Light or Dark for each; the choice applies at
>   once in the popup and the full tab, and is set before the page draws, so it never flashes
>   the other look. Both typefaces ship inside the extension; nothing is fetched. Classic's
>   blue is one shade darker than before, so links and buttons pass the 4.5:1 contrast that
>   small text needs.
> - The tool shows what the engines did and leaves the judgement to you. Everything that
>   told you what to do is gone: the "What to do" line under "What backs each brand", the
>   "what matters most" line that opened Analyze, "the pages to get onto", "The lever that
>   matters here" in a campaign's kinds of answer, "the places to get reviewed or listed",
>   the glossary's "How to use it" advice on all 36 terms, and the PDF report's "Where to act
>   next" (its last page is now "Method": the definitions, the runs and the prompt list). Where
>   advice used to sit, the facts it was drawn from stay, e.g. "Cited without naming X: …".
> - A campaign's "By kind of answer" now shows which kinds of site each kind of answer cited
>   (review sites, retailers, forums, brand sites…), as a bar and as percentages, in place of
>   the advice column.
> - Settings that followed the computer's dark mode instead of yours: a few labels (search
>   breadth, site: chips, cited/read tags, head-to-head cells) used the operating system's
>   setting, so a light panel on a dark desktop showed pale dark-mode colours. They follow the
>   theme you picked now.
> - Analyze shows every site the answer used. A new "Sites it used" section, right after the
>   "at a glance" card (and in the popup after the brands), lists every domain, cited ones
>   first, with a bar for cited and read-only pages; open a site for every page the engine
>   read there, its full title and address, and the citation number it has in the answer.
>   The "at a glance" card no longer cuts anything off: every brand, every cited page and
>   every search, in full. "What backs each brand" is an inference from the pages' titles
>   and search snippets, so it moves to the very bottom, in the full tab and the popup (the
>   popup's "Backed by" column is gone).
> - Product and image pictures show. The full tab drew every product as a coloured box with
>   a cart icon and never showed the images at all on a shopping answer; the popup squeezed
>   them into a strip of tiny tiles. Product cards (table, answer panel and popup) now carry
>   the picture, the full tab always has its Images section, and the popup shows images
>   three to a row. If ChatGPT's copy of an image won't load, the original it was made from
>   is tried before the tile falls back to a plain icon.
> - Text after a ChatGPT citation is no longer lost. Removing ChatGPT's citation markers ate
>   the rest of the line after each one, so a model named after a citation never reached
>   the brand's model list.
> - One question, one answer. Grok sends the same reply several times (while it streams,
>   when it finishes, and again when the page re-reads it), and each copy was stored as its
>   own answer: one question showed up to six times, and the newest copy, which had no pages
>   and only one search, was the one Analyze and the report opened. Copies of one reply are
>   now merged into a single answer that keeps every page, cited page and search any copy
>   had (the `site:` searches included). A regenerated answer stays separate. Use About →
>   Data & tools → Reprocess to merge the copies already stored.
> - Brands in local answers (hotels, places to stay, shops). The detector picked the wrong
>   column of an answer's table, so neighbourhoods, roads and words like "near" and
>   "Central" were listed as brands and the hotels were missed. It now reads the column the
>   table names as hotels, stays, places or shops, keeps a name whole ("Hotel Summit 9", not
>   "Hotel"), reads names Gemini links, and stops counting the plain words "booking" or
>   "hotels" as mentions of Booking.com or Hotels.com.
> - Gemini's Google Hotels card is read: each hotel with its rating, reviews, price a night,
>   photo and listing link becomes a place, and the hotel search it ran (with dates and
>   guests) is listed. Before, such an answer said "From memory · no search" and "No map".
> - ChatGPT's ads. When ChatGPT shows a sponsored card with its answer, Analyze (full tab and
>   popup), the answer report and the CSV export now show it: who advertised, what the card
>   said, where it links, where it sat, and whether the answer itself names the advertiser
>   or cites its site.
> - Every page's address. Analyze's "Every page it read", a new "Every page it opened" sheet
>   in the popup, and the answer report list each page with its full address, not only its
>   site. The detailed CSV has the cited and read addresses, the brands named, the places
>   and any ad.
> - Links in answers are links, in Analyze, the report and the exports, instead of
>   "[name](address)" text; booking sites (MakeMyTrip, Booking.com, Trivago, Goibibo,
>   ixigo…) count with the stores instead of "Other".
> - The last pieces of the design. In the full tab, Analyze's top bar has "Find a captured
>   prompt" (type a few words, pick a match or press Enter) and the newer/older arrows. A
>   competitor's page shows mentions too. Light or dark is now in About → Settings and
>   applies everywhere (the top bar keeps only the logo, the pages and, in the popup, the
>   pop-out icon).
> - Checked that the campaign runner still works from the new Campaigns header: Start run,
>   the sign-in check, Pause, Resume and Stop all reach the background and the header
>   follows. Two fixes from that check: during a run, the header no longer flashes "Run
>   again" when it redraws, and the run history refreshes when a run ends and still shows
>   when a run captured nothing.
> - Campaigns now follow the design too. A set-up campaign opens on one header: its name and
>   what it covers, Edit setup, Export… and Run again, and the run, engine, brand and tag
>   filters right under them, with the results straight below (no more separate summary,
>   run and results cards). Pause, Resume and Stop appear only while a run is going; the
>   run history is under "Data collected". In the full tab the section links sit in the
>   top bar.
> - A competitor's page is laid out as designed: their numbers with yours under each, one
>   head-to-head bar, each engine's average position as two dots on a track, mirrored bars
>   for where each brand's citations come from, a bar per site in "who cites whom" with a
>   verdict, and every prompt's verdict per engine ("Sony ahead", "Only boAt", "Neither")
>   with a score, a summary bar and filters.
> - Setup has "What this campaign should measure": brand mentions (always on), your site
>   cited, product cards, images and map listings. The campaign's board offers the views you
>   pick. Campaigns set up before this keep every view.
> - The top bar is one row: the logo, the four pages as words in a pill, and in the popup a
>   pop-out icon. New campaigns show a breadcrumb in their setup bar.
> - Analyze in the full tab now follows the design properly. It opens on one "at a glance"
>   card: the brands named (with a dot for what backs each), the pages cited and the
>   searches it ran. Product cards are a table with "where to buy" beside it; click a card
>   to see its stores. Image answers show who supplied each image and where a click leads.
>   Every named brand gets a row in "What backs each brand" with a plain verdict and a
>   "What to do" line. Details is one switch between technical details, the grounding
>   check, the page behind each part and every page it read. The answer panel shows the
>   line the engine shows above its answer (for example "Searched 12 sites"), and the page
>   has much narrower side margins, so the analysis gets the width instead of white space.
> - PDF reports. In a campaign's Export…, choose PDF report and a run: up to seven A4 pages
>   with the headline numbers and what they say, brands, every prompt on every engine,
>   sources, kinds of answer and product cards, the engines' searches, and what to do next.
>   Pick which pages to include. In Analyze, Save as PDF now gives a two-page report on the
>   answer: how your brand did, the product cards and where they send buyers, what backs
>   each brand, what changed since you last asked, then the answer itself and every page the
>   engine opened. Both open in a tab and Chrome's print dialog saves them ("Save as PDF");
>   a long table carries over onto the next page instead of being cut off.
> - Export… on a campaign's board opens one dialog for every way out of it. Choose an Excel
>   workbook (.xlsx) or CSV tables, all runs or the latest one, which engines, and which
>   tables to include; it shows how many rows each holds before you export. The workbook
>   has 11 summary sheets with charts and live formulas (pick a run or engine at the top of
>   Overview and every sheet follows) and every raw row as an Excel table you can filter,
>   sort and pivot. It opens in Excel, Google Sheets, Numbers and LibreOffice with every
>   value already worked out. The CSV tables come as one .zip with a README. This replaces
>   the old "Export workbook" (.xls) button.
> - Fixed: on current Chrome, the section links at the top of a campaign's board stopped
>   partway down instead of reaching the section.
> - About is five pages: an overview, a searchable glossary of every metric (formula, how to
>   use it, what to keep in mind), settings that say when a change isn't saved yet and can be
>   undone, data & tools (reprocess, sample data, the tour), and diagnostics (whether every
>   part is the same version, the two things to send when reporting a problem, and the
>   activity log with a count for each kind). The full tab has a side menu; the popup opens
>   on a "Get started" checklist that ticks itself off as you capture an answer, read it in
>   Analyze and set up a campaign.
> - Fixed: after Load sample or Remove sample, the button kept its old label.
> - A campaign's results are one board under the campaign. Pick a run (it's compared with
>   the run before), an engine, tags, and the brand you're looking at (yours or any
>   competitor). The headline numbers come in five groups: mentions, citations, product
>   cards, images and map listings. Below them: how the brand does in each kind of answer,
>   the product cards and where they send buyers, all the brands side by side, the brand as a
>   source, each engine, each run, each tag, what the engines recommend each brand for, the
>   kinds of sites cited, the sites that cite rivals but not you, the searches the engines
>   ran, every prompt on every engine (click a cell to open that answer) and the sources.
> - Click a competitor for its own page against yours: who's ahead on each number, head to
>   head across the answers, each engine, which sites cite one and not the other, what the
>   engines read when they named it, and who came first on each prompt.
> - The Dashboard is now a history of everything you've asked, on every engine. One row per
>   prompt, grouped by day, showing the engines that answered it, how often you asked it,
>   and what the answer held (searches, pages, product cards, a map, images). Search looks
>   in your prompts, in the answers and in what the engines searched for. Filter by period,
>   engine, kind of answer (shopping, informational, local, images, from memory, or a task
>   that isn't research), or a week on the chart. "Searches the engines ran" lists how they
>   rephrased you. Select prompts to open them side by side, add them to a campaign, export
>   them or remove them (with Undo). Your recent searches are kept for you.
> - A campaign's results (its performance and prompt tables) moved from the Dashboard to
>   Campaigns, under the campaign, with their own period and engine filters.
> - Fixed: the faint logo in the middle of the page drew on top of the cards, and showed as a
>   pale square in dark mode.
> - Analyze in the full browser tab is redesigned. The analysis sits on the left and the
>   answer, as the engine showed it, stays pinned on the right while you scroll: product
>   cards or map pins first, then the text with every brand and citation marked. Click a
>   brand or "Show in answer" on a cited page to light it up in the answer. The searches the
>   engine ran come first, then your brand, the products or places, every brand, every cited
>   page, what changed since last time and the kinds of sites it used. The older detailed
>   cards are under Details, one at a time. The header shrinks to one line as you scroll, and
>   a long prompt is cut to two lines with "Show the whole prompt".
> - When the same prompt was answered by more than one engine, tabs under the prompt switch
>   between their answers, and "Compare N engines" shows how they differ: who came first,
>   which brands every engine named, which sites each one cited, each engine in numbers and
>   the searches each one ran. You can read each engine's answer beside the comparison.
> - Fixed: in the popup, the details sheet (Technical, Where to buy and the rest) opened
>   half below the footer if you had scrolled down first. It now always sits at the bottom
>   of the window. In the full tab, text scrolling under the top menu no longer shows
>   through it.
> - A new typeface, IBM Plex, chosen for this kind of screen: "I", "l" and "1" never look
>   alike in site names and model numbers, digits line up in columns, and it has the ₹ sign
>   and a matching Hindi version. It ships inside the extension, so nothing is downloaded.
>   Text sizes and weights are tidied to a short, consistent scale.
> - The popup's Analyze screen is rebuilt. The searches the engine ran come first, right
>   under the prompt, each one in full. Then the product cards, map or images; your brand
>   as four numbers; every brand with its mentions, what backs it and how it moved since
>   last time; every cited page with its kind of site and the brands it mentions; and what
>   changed since the previous answer to the same prompt. Details (what backs each brand,
>   where to buy, places, images, search details, technical) open in a sheet. No box is
>   cut off at the bottom any more: the popup scrolls instead.
> - Compare has left the top menu. It opens from an answer instead ("All N answers to
>   this prompt"), on that prompt.
> - The campaign setup screen is redesigned. Save draft and Save & start tracking sit in a bar
>   pinned at the top, which lists the five things a campaign needs and turns any missing one
>   red. Prompts are added with two clear buttons (Upload a file / Add manually). Competitors
>   are compact chips in their own card. The popup gets its own one-column layout.
> - Grok prompts are actually typed and sent. grok.com's momentary hop through `/tos-gate`
>   was being read as "sent" before anything was typed, and the composer list could land on
>   a hidden decoy textbox. Selectors now follow grok.com's current page, as mapped by
>   open-source projects that drive it.
> - A turn's tab can't be frozen by Chrome until the turn is over (Gemini went from 5/10 to
>   10/10 with this).
> - Read-only sources whose title shares no word with any search the engine ran are
>   tagged "title mismatch" in Analyze; Source Domains shows each domain's "Cited %".

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
    xlsxWrite.js        dependency-free .xlsx writer: styles, formulas, charts, tables
    campaignXlsx.js     the campaign workbook and CSV tables the export dialog builds
    campaignReport.js   the campaign PDF report's numbers (ui/report.html lays it out)
    answerReport.js     one answer's PDF report, from Analyze's own views
    exportDoc.js        conversation → HTML/PDF renderer
    feedbackBundle.js   builds the problem-report archive
    zipWrite.js         dependency-free zip writer (CompressionStream, STORED fallback)
    xlsxLite.js         dependency-free XLSX reader for prompt import
    errorlog.js         the one durable diagnostics log — errors, capture
                        breadcrumbs and per-turn outcomes, privacy-scrubbed
    diagnosticsSummary.js  per-run expected/stored/missing/failed counts,
                        shared by the campaign diagnostics export
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
