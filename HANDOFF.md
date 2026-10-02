# CitoSkeleton handoff

Read this before changing anything. It is the working context from the sessions that built v0.38 to v0.45, written so another developer or model can take over without the chat history. For what each change does and why, see PR #26's description and the commit messages. Those are detailed and accurate.

Last updated 2 October 2026, at v0.46.0.

## Where things stand

- **Product.** CitoSkeleton is a Chrome MV3 extension for GEO (generative engine optimisation) practitioners. It reads the traffic that ChatGPT, Gemini, Perplexity and Grok send to the browser, keeps it raw, and derives each answer's fan-out queries, fetched and cited sources, products, places and brand mentions.
  - **Campaigns** (the "Loader") send a list of prompts to several engines in background tabs and compute visibility metrics across them.
  - See `README.md` for the user-facing description and `ARCHITECTURE.md` / `RESEARCH.md` for the original design.
- **Branch.** Work happens on `claude/blank-screen-prompts-issue-qnma6w`. **PR #26** targets `master`, is **open**; check its CI before building on it. If it has since been merged, start from `master`.
- **Version.** 0.46.0, which only redesigns the campaign setup screen (see below). 0.45.1 was never released; 0.45.2 was another model's commit (`c866508`) whose Grok change is undone in 0.45.3 — see open problem 1.
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
4. **Bump the version in five places together:**
   - `manifest.json` `version`
   - `src/lib/build.js` `BUILD` (`build-id.test.mjs` enforces that these two match)
   - both `version-badge` spans in `ui/panel.html`
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
| `ui/panel.js` / `.css` / `.html` | Analyze · Dashboard · Campaigns · Compare · About (Diagnostics). |

**Campaign setup screen (0.46.0).** `renderCampaignSetup` in `ui/panel.js`, styles under "Campaign setup" in `panel.css`, guarded by `test/campaign-setup.test.mjs`. The owner approved it from a design canvas first.

- A bar pinned at the top holds Delete, **Save draft** and **Save & start tracking** (lock), plus the five required items (`SETUP_REQUIRED`: campaign name, brand name, website, an AI engine, an active prompt). Pressing Save & start tracking with gaps turns each missing item red in the bar, on its box, and in an error summary. Competitors are recommended, never required.
- Cards: details (name, brand, website, engines), prompts (Upload a file / Add manually, then the existing table), competitors (an add form and compact chips, so adding competitors never pushes the engine picker down).
- Two columns when the setup is at least 880px wide, using a container query on `.cs`, not the window width. The popup and narrow tabs get one column with the required things first.
- Unsaved typing survives re-renders through `setupDraft`. Every prompt add, filter click and search keystroke rebuilds the tab, and that used to wipe it.
- 0.46.0 also fixed sticky positioning in full-tab mode. `body` was a scroll container that never scrolls, so the header and Analyze's context bar scrolled away. It is now `overflow-x: clip`.

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
