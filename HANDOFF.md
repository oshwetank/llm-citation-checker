# CitoSkeleton handoff

Read this before changing anything. It is the working context from the sessions that built v0.38 to v0.45, written so another developer or model can take over without the chat history. For what each change does and why, see PR #26's description and the commit messages. Those are detailed and accurate.

Last updated 2 October 2026, at v0.47.0.

## Where things stand

- **Product.** CitoSkeleton is a Chrome MV3 extension for GEO (generative engine optimisation) practitioners. It reads the traffic that ChatGPT, Gemini, Perplexity and Grok send to the browser, keeps it raw, and derives each answer's fan-out queries, fetched and cited sources, products, places and brand mentions.
  - **Campaigns** (the "Loader") send a list of prompts to several engines in background tabs and compute visibility metrics across them.
  - See `README.md` for the user-facing description and `ARCHITECTURE.md` / `RESEARCH.md` for the original design.
- **Branch.** Work happens on `claude/blank-screen-prompts-issue-qnma6w`. **PR #26** targets `master`, is **open**; check its CI before building on it. If it has since been merged, start from `master`.
- **Version.** 0.55.0: Campaigns, the competitor page, setup's "What this campaign should measure" and the one-row top bar rebuilt to the canvas (see 7 under "UI redesign, release by release"). 0.54.0: full-tab Analyze rebuilt to match the canvas board section by section (reported: "the new layout has not completily and properly been implemented at all"); the next releases do the same for Campaigns and the popup header (see "UI redesign, release by release", 7). 0.53.0: the designed PDF reports, for a campaign's run and for one answer (see below). It is release 6b, the last of the owner's canvas redesign; 0.52.0 was release 6a (the export dialog with a real .xlsx workbook and CSV tables), 0.51.0 release 5 (About as five pages), 0.50.0 release 4 (a campaign's results as one board, and a page for each competitor against you), 0.49.0 release 3 (the Dashboard as a searchable history of prompts, and a campaign's results moved to Campaigns), 0.48.0 release 2 (the full tab's new Analyze, with engine tabs and an engine comparison) and 0.47.0 release 1 (the bundled IBM Plex typeface, the popup's new Analyze screen, Compare out of the top menu); the rest is planned release by release (see "UI redesign, release by release"). 0.46.0 redesigned the campaign setup screen. 0.45.1 was never released; 0.45.2 was another model's commit (`c866508`) whose Grok change is undone in 0.45.3 — see open problem 1.
- **Tests.** 46 unit and 31 browser test files, all passing locally and in CI.
- **Last real run: v0.45.4 (Gemini + Grok only), 10/20.** Gemini 10/10; Grok 0/10, fixed in 0.45.5, not yet run (0.46.0 carries the same fix). The last real run was on v0.43.0 (see the run history).

## How the owner works

- The owner runs the extension unpacked on **Windows, without git**. Every build is delivered as a zip of the committed tree:

  ```bash
  git archive --format=zip -o citoskeleton-latest.zip HEAD
  ```

  They extract it over `C:\Users\shwet\LLM Citation Checker`, replacing all files.
- **They must then press the reload ↻ button on the extension at `chrome://extensions`.** Restarting Chrome is not enough: a reused profile keeps running the old service worker across relaunches. This was proven locally, and it is why `src/lib/build.js` exists: the panel warns when the background and the interface builds disagree. Say this every time you hand over a zip.
- **After a run**, they send the text "CitoSkeleton diagnostic report" and the campaign diagnostics zip. The zip comes from About → Diagnostics → Export campaign diagnostics, and holds the log, per-capture records, the raw payloads and unreadable samples. These exports are the main evidence for every fix. Read the per-turn `trace` and `context` fields.
- **Explain things in plain language.** The owner is a GEO/SEO practitioner, not a developer. Lead with what changed for them, keep jargon out, and be honest about what is and isn't fixed.
- **Research outward, not just inward.** The owner has asked more than once that fixes be grounded in how the engines and Chrome actually behave: public write-ups, open-source clients of each engine's endpoints, Chrome documentation. Don't rely on guessing from our own code alone.

## Rules that are in force

1. **Never commit the owner's real data.** That covers prompts, answers, Perplexity thread titles, brand or campaign names from their runs, and their diagnostics zips. Tests use synthetic payloads in the documented shape, or the fixtures already in `test/fixtures/`.
2. **Every fix gets a test that fails on the old code and passes on the new.** Run it against the old code to prove it. Each test file prints `ALL PASSED` and exits non-zero on failure.
3. **Wire every new test file into `.github/workflows/tests.yml`**, in the unit or the browser job. The `every test file is wired into CI` job fails otherwise.
4. **Bump the version in four places together:**
   - `manifest.json` `version`
   - `src/lib/build.js` `BUILD` (`build-id.test.mjs` enforces that these two match)
   - the header's `version-badge` span in `ui/panel.html` (About's badges are drawn from `BUILD` since 0.51.0)
   - line 13 of `README.md`

   Add a README bullet for each user-visible fix.
5. **Run the full suite before every push, from fresh browser profiles.** Delete `/tmp/citoskeleton-*` first: a reused profile runs a stale service worker and gives false results. Push only when everything passes.
6. **Don't `pkill -f` with a pattern that matches your own shell command.** Doing so killed the suite runner twice.
7. **Match the code's style.** Comments explain *why*, with the evidence: which run, which export, which source. The existing ones are long on purpose, and new code should read like its neighbours.
8. **Commits and PR text:** describe the change and the evidence. Don't put AI model names or identifiers in commits, PRs or code.

## Running the tests

```bash
rm -rf /tmp/citoskeleton-*                     # fresh profiles
for t in test/*.test.mjs; do node "$t" || echo "FAILED: $t"; done
```

- **Unit tests** are plain Node 22.
- **Browser tests** launch Playwright's Chromium with the unpacked extension (`--load-extension`, `--headless=new`, persistent context). They look for `playwright` in `node_modules` or at `/opt/node22/lib/node_modules/playwright`. CI installs it with `npm install --no-save playwright` and runs `npx playwright install chromium`.
- **Runtime.** The full browser job takes about 16 minutes in CI.

## Architecture in one screen

| File | Role |
|---|---|
| `src/content-main.js` | **MAIN-world interceptor.** Patches `fetch`, XHR and `WebSocket` before page JS runs, tees engine responses and posts the raw text out without parsing it. It also posts `engine-submit` when the engine's own "answer this prompt" request leaves the page (`SUBMIT_RE` per engine; for Grok, the WS `conversation.item.create`; for Perplexity, `perplexity_ask`). |
| `src/content-iso.js` | **ISOLATED world.** Relays captures to the background and drives a campaign turn in its tab: waits for the composer, types, then runs the submit loop. Retries are at least `RETRY_GAP_MS` 3000 apart, at most `MAX_SEND_ATTEMPTS` 5, and stop on `engine-submit`. The loop is ticked by the service worker over the `lcfc-clock` port, because Chrome throttles hidden-tab timers. It answers `loader-probe` with its stage, trace, tick gaps and page facts, even when it has no turn. |
| `src/background.js` | **Service worker.** Raw store, adapter dispatch and campaign orchestration. Each engine has one or more *legs*; each leg walks its prompts. A turn is armed with a watchdog (`turnBudgetMs`) plus up to 2×60s extensions while still streaming, and probes the tab before failing (`PROBE_WAIT_MS` 4000). `describeTimeout` turns probe, tab facts and nav log into a reason. Only the turn in flight (`leg.inFlightIdx`) can be completed by a capture, which stops phantom turns. It also holds the diagnostics message API. |
| `src/adapters/{chatgpt,gemini,perplexity,grok}.js` | Raw payload → normalised record (`src/schema.js`). Raw is kept immutably, so **Reprocess all captures** re-derives everything after an adapter fix. |
| `src/lib/geo.js` | Campaign metrics. `selectTracked` keeps **one capture per run × engine × prompt** (most sources, then longest answer, then earliest). Pass `{allCaptures:true}` for diagnostics. |
| `src/lib/retrieval.js` | ChatGPT retrieval labels: the 69-engine registry, `pipelineOf`, `typeLabel`, `supplierOf`, `retrievalMix`, `enginesNamedIn`. |
| `src/lib/errorlog.js`, `diagnosticsSummary.js` | The single diagnostics log and per-run counts. The export is assembled in `ui/panel.js` in batches, because one Chrome message is capped at 64 MiB. |
| `ui/panel.js` / `.css` / `.html` | Analyze · Dashboard · Campaigns · About (Diagnostics). Compare is a page reached from Analyze, not a top-menu tab, since 0.47.0. |
| `src/lib/analyzeView.js`, `siteKind.js` | The popup Analyze screen's content as plain data (searches, brands and what backs them, pages cited and their kind of site, your brand, changes since the previous answer). `ui/panel.js` `renderAnalyzePopup` only draws it. |
| `fonts/` | IBM Plex Sans (variable), Sans Devanagari and Mono, Latin/Latin Extended/Devanagari subsets only, with `OFL.txt`. Loaded by `@font-face` at the top of `panel.css`; never fetched from the web. |

**Campaign setup screen (0.46.0).** `renderCampaignSetup` in `ui/panel.js`, styles under "Campaign setup" in `panel.css`, guarded by `test/campaign-setup.test.mjs`. The owner approved it from a design canvas first.

- A bar pinned at the top holds Delete, **Save draft** and **Save & start tracking** (lock), plus the five required items (`SETUP_REQUIRED`: campaign name, brand name, website, an AI engine, an active prompt). Pressing Save & start tracking with gaps turns each missing item red in the bar, on its box, and in an error summary. Competitors are recommended, never required.
- Cards: details (name, brand, website, engines), prompts (Upload a file / Add manually, then the existing table), competitors (an add form and compact chips, so adding competitors never pushes the engine picker down).
- Two columns when the setup is at least 880px wide, using a container query on `.cs`, not the window width. The popup and narrow tabs get one column with the required things first.
- Unsaved typing survives re-renders through `setupDraft`. Every prompt add, filter click and search keystroke rebuilds the tab, and that used to wipe it.
- 0.46.0 also fixed sticky positioning in full-tab mode. `body` was a scroll container that never scrolls, so the header and Analyze's context bar scrolled away. It is now `overflow-x: clip`.

**UI redesign, release by release (from 0.47.0).** The owner designed and approved a full redesign on a design canvas (popup and full-tab Analyze, Dashboard, Campaigns, About, Excel/PDF exports) and asked for it to be built "release by release". Each release is its own version, tested and zipped:

1. **0.47.0 (done):** IBM Plex bundled and the type scale tidied (sizes 11/12/13/14/16, weights 400/500/600); the popup Analyze rebuilt (`renderAnalyzePopup`; tests `analyze-view`, `analyze-popup`); Compare out of the top menu, opened from an answer instead.
2. **0.48.0 (done):** full-tab Analyze rebuilt (`renderAnalyzeTab`; test `analyze-tab`): the analysis on the left, the answer as the engine showed it pinned on the right (`atRenderAnswer`, from `buildExportModel(rec).bodyHtml`, brands marked, citations as site chips), adapting to the kind of answer. Engine tabs and "Compare N engines" when one prompt has answers from several engines (`src/lib/compareView.js`; test `compare-view`). The old cards are still built, by `renderAnalyzeLegacy` into a detached div, and the Details tabs take them by id, so their behaviour didn't have to be rewritten.
3. **0.49.0 (done):** the Dashboard (tab and popup) rebuilt as a search-first prompt history (`renderDashboardImpl`; `src/lib/historyView.js` works it out, test `history-view`; browser test `dashboard`). One row per prompt (`historyRows`: `asked` = times on the engine asked most, so a 4-engine run counts once), periods, engines, kinds of answer including "task", the week chart, the searches the engines ran, select → side by side / add to a campaign / export / remove with Undo. Searching answers goes through the background (`search-answers`, `src/lib/answerSearch.js`) because the panel holds light rows only. A campaign's results (the old Dashboard's campaign section, unchanged) now render in Campaigns under the campaign (`renderCampaignResults`) until release 4 redesigns them.
4. **0.50.0 (done):** a campaign's results as one board (`renderCampaignBoard`), and a brand's page against yours (`renderCampaignBrandDetail`, opened from the brand table; it replaces the board until "←"). Both are worked out in the background (`campaign-board`, `campaign-brand-detail`) by `src/lib/campaignBoard.js` (test `campaign-board`), because positions need the answer text. Scope: run (latest with answers by default, compared with the run before; or all runs), engine (`engineFilter` also narrows the engine columns), tags (`promptsInScope` narrows the prompt grid to match the numbers), and "viewing as" any tracked brand. Sections: focus tabs (mentions, citations, product cards, images, map listings; tiles name the viewed brand, never "you"), by kind of answer, product cards and destinations, brands (remove/restore, inferred competitors stated in a banner and never saved silently), as a source, by engine, data collected, across runs, engine heatmap, topics, what each brand is recommended for (`src/lib/aspects.js`, moved out of panel.js), kinds of sites, sites that cite rivals but not you, searches, prompt grid (cells open the answer), sources (the old table and its drill-downs, `renderCampaignSources`). Browser tests: `campaign-board-ui` (new) and `campaign-drilldown` (moved onto the board; its "four headline numbers" rule became the focus tabs, and the test says why).
5. **0.51.0 (done):** About as five pages (`renderAbout` and the `renderAbout*` functions; rules in `src/lib/aboutView.js`, test `about-view`; browser test `about`): Overview, Metric glossary (search + group chips over `glossaryEntries()`, the term beside the list in the tab, a page of its own in the popup), Settings (steppers, a switch, "Unsaved changes" / Undo / Save, the storage meter), Data & tools, Diagnostics (the version check from `checkBuildMatch`, the report and campaign zip, the activity log with per-kind chips). The tab has a side menu (`#abNav`) with the version status under it; the popup opens on a home screen with "Get started": a real capture, a real answer seen in Analyze (`cito-analyzed-real` in localStorage, set only when Analyze is the active tab and the answer isn't the sample) and a campaign. The form controls kept their ids (`setRetention`, `demoToggle`, `diagExportBtn`, …), which other tests use. `withBusy` no longer overwrites a label the action itself changed.
6. Exports, in two parts:
   - **6a, 0.52.0 (done):** the export dialog (`openExportDialog` in panel.js, opened by the board's `#cbExport`) and a real .xlsx. `src/lib/xlsxWrite.js` is a dependency-free OOXML writer: shared strings, styles, formulas written with their cached value, charts (bar, column, line, pie, doughnut), Excel tables, defined names, dropdowns, conditional formats, print setup; it zips with `makeZip`. `src/lib/campaignXlsx.js` builds the campaign on it: `campaignFacts` turns records into eight raw tables (`RAW`), the `Q` class writes each COUNTIFS/SUMIFS/AVERAGEIFS and computes its value from the same rows, so the file shows correct numbers before a spreadsheet recalculates. Overview's run and engine pickers write their criteria to hidden cells (`RunCrit`, `EngCrit`, `PrevCrit`) that every summary formula reads, which also works in Google Sheets. One run drops Trends and Run over run; a table left out drops the sheets that need it. `campaignCsvFiles` writes the same tables as CSV (text starting = + - @ gets a leading `'`), `campaignExportCounts` the dialog's row counts. The background (`geo-export`) returns the parts as text and the panel zips them, so nothing binary crosses the message channel. Tests: `campaign-xlsx` (numbers, every name and sheet a formula uses exists, every formula has a cached value, well-formed XML, CSV quoting) and the browser test `export-dialog` (counts, choices, both downloads opened, popup layout). Checked by hand too: LibreOffice recalculating a synthetic workbook gave the same value as every cached one. The old SpreadsheetML campaign workbook (`campaignWorkbook.js`, `geo-export-workbook`) is gone; the Dashboard's own .xls export is untouched.
   - **6b, 0.53.0 (done):** the designed PDF reports. `ui/report.html` + `report.js` + `report.css` lay out A4 pages from the canvas and call `window.print()` (with `print=1`); Chrome's "Save as PDF" writes the file, so the text is real and no PDF library ships. `?kind=campaign&profileId&runId&sections&engines` is a campaign's run, from the export dialog's third format (pick the run and the pages); its numbers come from `src/lib/campaignReport.js` (on the board and the workbook's raw tables; background `campaign-report`). `?kind=answer&captureId` is one answer, from Analyze's "Save as PDF" (`openAnswerReport`; the bulk "Save as PDF" in the Dashboard still uses `export.html`); `src/lib/answerReport.js` composes Analyze's views (background `answer-report-data` sends the record, the previous answer and the campaigns). Pages are fixed A4 boxes; `paginate()` moves a long table's last rows (or an answer's last paragraphs, `[data-splitbox]`) onto a "(continued)" page, and folds a moved block back into its continuation so a table never appears twice on a page. The answer report is one flow, so overflow shares a page with the answer. Every captured string goes through `esc()` (the markup is built as strings). The @font-face rules moved from panel.css to `ui/fonts.css`, which the panel and the report both link. Tests: `pdf-report` (unit: every number on a synthetic campaign, worked out by hand) and `pdf-report-ui` (browser: the dialog's PDF option, the report tab and its print call, a 40-prompt campaign whose prompt table carries over, every page fitting A4, page numbers, Chrome's own PDF having one page per report page, Analyze's Save as PDF, no network).
7. **Canvas fidelity.** Reported after 6b: "the new layout has not completily and properly been implemented at all." An audit against the boards (render them from the published artifact `E9ZfebbsGUxed1DLxLhqLL`, `project/*.dc.html`) found the Dashboard and About match, and three screens didn't:
   - **0.54.0 (done):** full-tab Analyze, one answer (`atRenderSingle` and the `at*` helpers after `KIND_GROUPS_UI`; styles under "Full-tab Analyze, one answer (0.54.0)" in panel.css). Order: lead line, `#at-glance` (brands named with rank, ×count and a backing dot; pages cited, click to light the citation; searches with lane tags), the memory box (memory answers only; they skip "What backs each brand"), the "your brand" strip, products (`.at-prod-table` rows + `.at-buy`), places, images (`.at-img-card`: who supplied it, kind, where a click leads; no network images), parts (info answers), `#at-backing` (verdict per brand, backer chips coloured by site kind, `.at-todo`), Since/Kinds, `#at-built`, `#at-details` (`.at-seg` switch: tech tiles, grounding, parts, then every page read as the full `#card-sources` card with its index/kind chips and filters, then the earlier layout's other cards when present: search details, brand & page matrix, reasoning, entities — keep them; dropping them lost the Labrador/external labels, caught by `source-pipeline-ui`). The answer panel adds the engine's own line above the answer (`.at-ans-step`; only what the capture holds, no invented "thought for" times) and Perplexity's source cards. The page gutter is the canvas's 20px (`.app-wrapper`), and the answer column 400–590px. Near the page end the pinned answer shrinks (`--at-end-cut`, set in `atCompactOnScroll`) rather than sliding under the header. Tests: `analyze-tab`, `analyze-layout`.
   - **0.55.0 (done):** Campaigns. A locked campaign opens on `renderCampaignHead` (`#cpHead`): a slim switcher line, the name and a counts line, Edit setup / Export… (`#cbExport`, wired once the board loads) / Run again, the run controls (`.cp-live` buttons shown by `.live`/`.paused`, which `renderLoaderStatus` sets), `#loaderStatus`, and `#cpFilters`, which `renderCampaignBoard` fills with the run, engine, brand and tag filters and the scope line. The summary and run cards are gone; run history (`renderRunHistory`) is under "Data collected". Delete is in the header while Edit setup is open. The board's section links go to the app bar's `#headerPage` in the tab (`setHeaderPage`, cleared on every tab switch; the Dashboard puts its note there) and under the filters in the popup. A competitor's page (`renderCampaignBrandDetail`) hides the header and draws `brandDetail()` as the canvas does: KPI strip, one head-to-head stack, a dot track per engine, mirrored kind bars, diverging per-site bars with verdict pills, and verdict cells with a score and filters (`cbVsFilter`). Setup's "What this campaign should measure" saves `profile.measure` (`makeProfile` keeps it; null for older campaigns = every view); the board offers only those views. An unlocked campaign's setup bar carries a breadcrumb and the switcher instead of a chooser card. The top bar is one row in both modes (`.header-brand` is `display: contents`; text-only tabs; the popup's Theme and Full tab are icon buttons). Tests: `campaign-board-ui`, `campaign-drilldown`, `campaign-setup`, `geo`, `app-header` (new).
   - **Not yet matched:** the Analyze tab's top bar search box from the canvas; the brand page's "Mentions" tile (brandDetail() has no mention count).

- The popup's details sheet says what the capture can't: a product card names its stores but not each store's price, and Gemini doesn't publish its searches. Keep it that way; don't fill gaps.
- Engine comparison: a campaign answer is compared within its own run (same campaign, prompt and run); an ad-hoc answer with each engine's latest ad-hoc answer to the same prompt (`answersToPrompt`). The "All N answers to this prompt" link still opens the run-by-run Compare panel.
- The Dashboard's kind-of-answer colours (`--ak-*`) are the reference categorical hues ordered so neighbours in the stacked bar pass the validator; "task" is a deliberate neutral grey. Each kind also has its glyph and label.
- Don't write `scrollTop` unless it changed. A write, even of the same value, cancels a smooth scroll in Chrome 153, and the Campaigns tab's 1.5s status poll restores the scroll after every tick: board section links stopped short until 0.52.0. `withScrollPreserved`, `refreshFromBroadcast` and `renderCampaignResults` compare first; `campaign-board-ui` counts the writes on an idle Campaigns tab. CI installs the latest Playwright and so the latest Chrome; this machine's is older (141), so a CI-only browser failure is worth reproducing on the CI version (Chrome for Testing downloads from storage.googleapis.com).
- The popup's frame (`body.popup .app-wrapper`) is `overflow: clip`, not `hidden`: a hidden box is still a scroll container, and `scrollIntoView()` inside the popup (section links, a run's "View results") scrolled it — absolutely positioned screen-reader labels deep in the content gave it thousands of pixels to scroll — so the header covered the content and the footer floated mid-popup. Keep it `clip`.
- `.app-wrapper` has its own layer (`position: relative; z-index: 1`) so the logo watermark (`body::before`) stays behind the cards; the watermark is inverted in dark mode because the icon sits on an opaque white square.
- `sanitizeText()` drops the rest of a line after a complete ChatGPT cite marker (U+E200…U+E201); `answerSearch.js` strips whole sequences first. A separate fix for `sanitizeText` itself was suggested as its own task (it affects `extractBrandModels`).
- Panels must not keep a transform. `.panel.active`'s fade-in used `forwards`, which held `translateY(0)`; any transform makes the panel the containing block for `position: fixed` descendants and turns fixed backgrounds into scrolling ones. The popup's details sheet opened half below the footer, and the full tab's header strip (`.at-hero::before/::after`, painted with `--page-backdrop`, two layers because html and body each paint it) couldn't match the page. Both are tested (`analyze-popup`, `analyze-tab`).
- Brand marks in the answer use a `/u` regex. `escapeRegExp()` escapes "-", which is a syntax error under `/u`; a place called "X - Y" crashed the page until `atMarkBrands` got its own escape.
- "Your brand" in an ad-hoc answer comes from the campaigns (`ownBrandFor`): the capture's own campaign, a brand tagged as yours, a tracked brand the answer names, or the only campaign.

**Engine specifics worth knowing**

- **ChatGPT.** An SSE delta stream on `/backend-api/f/conversation`. It carries `search_result_groups`, `content_references`, `ref_id.ref_type` and product/place entities.
  - `result_source` (the pipeline: labrador, bright, oxylabs, serp) was sent only from 21 May to 21 July 2026. Current traffic has none, and nothing is inferred.
  - The A/B flag is kept from `analytics_meta["ab_test.search_engine_all.allocated_experiment"]`.
- **Gemini.** `StreamGenerate` over XHR, in batchexecute framing.
- **Perplexity.** SSE `/rest/sse/perplexity_ask`, arriving as `blocks`:
  - `markdown_block` chunks placed by `chunk_starting_offset`, or a `workflow_block` patched by JSON-Patch `diff_block`s
  - sources in `web_result_block.web_results`, the prompt in `query_str`
  - `[n]` markers become `[[cite:URL]]`

  This reading follows `henrique-coder/perplexity-webui-scraper`. Beware: the account-wide GraphQL sidebar calls match the broad capture pattern.
- **Grok.** grok.com moved chat to a WebSocket gateway, `wss://grok.com/ws/mgw/`. Events: `conversation.item.create`, `response.chunk`, `response.output_text.delta`, `response.search.result`, `response.done`. The adapter folds the frames into the old REST node shape. Sources: `anojndr/grok.com-to-openai` (`grok_gateway.py`) and `stabey/Aether-upstream-fork`.

## Real-run history

All runs are the owner's, on Windows Chrome 153. Captured counts are per prompt × engine.

| Build | Result | What it exposed | Fixed in |
|---|---|---|---|
| 0.38 / 0.39 | 3/80, then 3/80 | Almost all "tab reloaded repeatedly": the engine's own post-submit navigation was read as a lost prompt | `ea8adc7` |
| 0.40 / 0.41 | 12/40, all failures bare `timeout` | Every engine died at about 5 minutes, which is Chrome's hidden-tab timer throttling. The prompt lists also jumped to the top during runs | 0.42 (`bf49c5c`) |
| 0.42 | "35/40" (inflated) | Phantom turns completed prompts that were never asked. The 64 MiB export failure. Perplexity's stream was unreadable. Grok "page script not responding" | 0.43 (`215f04a`, `4d14c4b`) |
| 0.43 | **27/40**: ChatGPT 10, Perplexity 10, Gemini 7, **Grok 0** | Gemini got up to 9 identical sends per prompt. Duplicate captures skewed metrics. Grok tabs never answered the probe | 0.44 (`fe31348`) |
| 0.45.3 | **25/40**: ChatGPT 10, Perplexity 10, Gemini 5, **Grok 0** | All 15 failures "Chrome froze the tab", each ~60s after the page stopped loading. Every Grok turn bounced `grok.com/?q=…` → `/tos-gate` → bare `grok.com/`, losing the prompt | 0.45.4 |
| 0.45.4 | **10/20** (Gemini + Grok only): Gemini **10**, Grok 0 | The freeze fix held (Gemini 5 → 10). Every Grok turn read `composer … sent:url` with nothing typed: the `/tos-gate` hop happens in the same document and counted as a send | 0.45.5 |
| 0.45.5 / 0.46.0 | not run yet | | |

## Open problems, in priority order

1. **Grok has never captured an answer in a real run.**
   - **v0.45.3 export.** Tab logs read `… 6.9s:L,grok.com/tos-gate 7.0s:C 7.1s:L,grok.com/ … 67.5s:frozen`.
   - **v0.45.4 export (the real cause).** Every turn's page trace read `composer … sent:url` with no `typed`, and the tab log put `sent` at the instant of the `/tos-gate` hop. The hop is a **same-document** route change: the submit loop's "path changed and got longer = sent" rule fired on it during the native-`?q=` grace period, so nothing was ever typed. 0.45.4's cross-document `loader-claim` (below) was built on the wrong reading of the tab log and never engaged: `L` entries don't distinguish same-document route changes from page loads.
   - **Fixed in 0.45.5**, from outside evidence rather than our own code:
     - **grok-brain** (github.com/ops120/grok-brain, `references/site-map.md` and `scripts/grb/src/site.mjs`, selectors verified on the live site 2026-09) and four open-source multi-AI extensions (PromptCast, Mosaic, GenAIPromptExtension, Parallel AI) agree that the composer is a Tiptap/ProseMirror contenteditable in `[data-testid="chat-input"]`, and that the send control is `[data-testid="chat-submit"]`, labelled "Submit".
     - The page also has a hidden `aria-hidden` textarea with an "Ask Grok…" placeholder, which was our first composer match. `pick()` now skips aria-hidden and unlaid-out elements.
     - The URL "sent" signal needs a conversation path (`/c/<id>`, `/app/<id>`, `/search/…`), and only counts after the script has typed.
     - `/tos-gate` that doesn't clear within ~10s gives up with "accept Grok's updated terms". It never clicks accept for the owner.
     - The DOM harvester reads `.message-bubble` outside `[data-testid="user-message"]`.
     - Tests: `prompt-submit` ("Grok: the app hops through /tos-gate…"), `dom-harvest-multiturn` (today's layout).
   - **Still unproven: capture.** grok-brain records the answer on `/rest/app-chat/conversations/…`, which `GROK_RE` already intercepts, as well as the WebSocket gateway. If the next run sends Grok prompts but captures nothing, look in `unreadable/`.
   - **Watch for:** grok-brain notes that opening grok.com can restore the last conversation. Our tab stays on `/` after the hop, so it isn't handled; if Grok answers look like follow-ups, click `[data-testid="new-chat"]` first.
   - **`loader-claim` (0.45.4).** A page without markers in a run's tab asks for its unsent turn. It is kept because it covers real reloads, but it was not what Grok needed.
   - **About 0.45.2.** It spotted the `/tos-gate` hop, but reloaded the tab on every Grok address change, re-sending healthy turns; 0.45.3 undid it (`test/grok-navigation-timeout.test.mjs`).
2. **Chrome froze every turn still waiting at about a minute (v0.45.3: 5 Gemini, 10 Grok).**
   - **Why.** Chromium calls a page that never goes quiet "loaded" at most one minute after it stops loading (`kWaitingForIdleTimeout` in `page_load_tracker_decorator.h`); a hidden tab is freezable from then unless something exempts it. Holding a Web Lock does (`CannotFreezeReason::kHoldingWebLock`). The turn's lock was released when the post-send watch ended, a minute after the send.
   - **Fixed in 0.45.4.** The lock is held until the turn gives up, the page goes away, or 5 minutes pass (longer than any turn). `prompt-submit` checks it is still held after the post-send watch ends.
   - **Confirmed by the v0.45.4 run:** Gemini 10/10 (from 5/10), every turn 12–16s, no freezes.
3. **ChatGPT pipeline labels.** These are not a bug: current traffic doesn't carry them. Captures from 21 May to 21 July 2026 do, and pick them up via Reprocess all.
4. **Freeze coverage.** Chrome's actual freeze decision can't be exercised in the harness. The Web Lock is tested as held for the right span, not as preventing a freeze; Chromium's source is the evidence it does.

**When the next export arrives:** read `unreadable/` and the per-turn trace and context for every failed turn. The tab log (`| tab:` in the trace) now also records `claimed`, `claim:sent`, `claim:refused` and `sent`. Tie each fix to what the export shows.

## Feature backlog

The owner asked for these after the Peec AI and Konitzny articles. **1 and 2 are built (first versions, 0.45.2–0.45.3)**; confirm with the owner before starting the next.

1. **Title vs search-query match.** In Ahrefs' 1.4M-prompt study, cited pages' titles matched ChatGPT's hidden search queries more closely than uncited ones (0.602 vs 0.484). Fan-out queries are in `record.fanout`, and sources have outcome `fetched` or `cited`. **Built:** Analyze tags a read-only source "title mismatch" when its title shares no meaningful word with any fan-out query (`titleMatchesQueries` in `src/lib/fanout.js`; plurals folded, filler words and `site:` ignored). Word overlap, not semantic similarity, so it flags only the clear case.
2. **Fetched → cited rate per domain.** ChatGPT cites about half of what it retrieves, and Reddit is read but rarely cited. **Built:** "Cited %" in Source Domains = answers citing the domain ÷ answers it appeared in (`citedRate` in `src/lib/sources.js`, glossary `citedRate`). Counted per answer on both sides, never citations ÷ pages.
3. **Source freshness.** Labrador has separate news indexes (last day, last 7 days, older). Search results carry `pub_date`, kept as `pubDate`. Show the age of cited sources.
4. **Local listings considered vs shown.** ChatGPT's `raw_search_entities` lists the local businesses it considered. The adapter extracts only the displayed `local_business` entities (supplier b1) today.
5. **Fast vs thinking mode.** Thinking-mode (`system2-*`) engines reach Reddit, PDFs and YouTube. A campaign option could run ChatGPT in Thinking mode to compare.
6. **Shopping experiments.** Surface the recorded A/B flag when a product answer came from one of the index experiments, for example `prefer-index-over-serp-v3`.

**Research used.** The owner pasted both Peec articles because peec.ai is blocked from the sandbox.

- Peec AI, "ChatGPT built its own search index"
- David Konitzny, "The Complete List: Every Search Engine Hidden Inside ChatGPT's Retrieval Leak" (Peec AI, 17 Sep 2026): 69 engines, 47 internal and 22 external
- RESONEO, think.resoneo.com/chatgpt-retrieval
- Search Engine Land on hidden pipelines and the retrieval stack
- suganthan.com, "How ChatGPT picks sources" part 2
- Ahrefs, "Why ChatGPT cites pages"
- `nkindschi-ld/seo-wiki` PR #1, the registry

## Environment notes for cloud agents

- **Blocked by the egress proxy:** peec.ai, searchengineland.com, suganthan.com, dev.to, grok.com and others.
- **Reachable:** WebSearch works, and so do github.com and raw.githubusercontent.com. Open-source clients of the engines' endpoints are the most reliable outside evidence.
- **Chromium** is preinstalled for Playwright at `/opt/pw-browsers`. Don't run `playwright install` there.
