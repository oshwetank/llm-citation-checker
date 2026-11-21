# Ask, and every "smart" feature, on one data foundation

*Design for review, 21 Nov 2026. Nothing here is built yet.*

The owner's brief: "There should be a structure and logic behind how the smaller AI elements interact with the data in the Dashboard and the Campaigns. If there are thousands of prompts across many campaigns, how does the model know which campaign, prompt or query is meant? Without that, Ask is a fake thing with no logical backing."

This document explains:
1. why Ask breaks today;
2. what the research says about how working products solve this;
3. the structure proposed for CitoSkeleton;
4. how it would be built and tested, in stages.

Examples use made-up brands (Zento, Kovo, Lumora), never the owner's data.

---

## 1. In plain words

Today the small AI model is asked to do three hard jobs at once:
- understand the question;
- work out *which* data it is about (which campaign, run, engine, prompts or dates);
- choose one of 22 tools and fill in its settings.

It does the second and third jobs by guessing from names. With one campaign that mostly works. With many campaigns and thousands of prompts, it guesses wrong and nobody can tell.

Working products (Looker, ThoughtSpot, dbt's semantic layer, the text-to-database research) all solve this the same way: **the model never decides what the data is or how a number is counted.** The tool keeps a map of what exists (campaigns, brands, prompts, tags, runs, engines, sites) and a fixed list of measures with exact definitions. The model's only job is to turn the question into a short, structured request. Ordinary code checks every name in that request against the map, fetches the numbers, and the answer is written from those numbers alone.

The proposal applies that pattern here. In short:
1. **A map of everything** the user has: the Catalog.
2. **One small, fast table** with a row for every prompt × engine × run: the Facts.
3. **A question becomes a fixed-form request**, the Query plan, filled mostly by rules and only partly by the model, from choices that really exist.
4. **The scope is always shown and editable**, for example *Zento campaign · latest run · all engines · 120 answers*. When the question is ambiguous, Ask asks back instead of guessing.
5. **Code runs the request** with the same calculations as the boards.
6. **For questions about wording**, a proper search over the answers' passages, inside the chosen scope.
7. **The model writes the reply from the results only.** Every number is checked and every claim links to the answers it came from.
8. **Ask, Continue in…, Dashboard search and the campaign insights all use this one foundation**, so they always agree.

---

## 2. Why Ask breaks today (what the code does)

All of this is in `src/lib/assistant.js`, `assistantTools.js` and `askKnowledge.js`.

| What happens | Where | Why it breaks |
|---|---|---|
| The campaign is matched by name, exactly or as a substring. With no name given, it **silently uses the campaign run last**. | `findCampaign`, `latestCampaign` | "How is Zento doing?" with campaigns *Zento India* and *Zento US* picks one without saying so. A brand name that is also a campaign name is never told apart. |
| Dashboard history (questions asked by hand) has no place of its own; only `query_answers` reaches it. | `runTool` | "What did I ask last week?" or "my manual questions about linen" have no scope to land in. |
| Prompts are found by words that must **all** appear, literally. | `query_answers`, `prompt_detail`, `answerSearch.matchesTokens` | "battery" doesn't find "long-lasting charge". A typo, a plural or another language finds nothing. Out of thousands of matches, the newest are taken, not the most relevant. |
| The model chooses among 22 tools, trimmed to 8 by keywords, and invents the arguments. | `toolsFor`, `TOOLS` | Research shows that selection accuracy falls as tools are added (§3.3). A 2–4B model on the user's computer is at the low end. |
| No run, tag, date range, signed-in/out or prompt-group scope in most tools. | `TOOLS` parameters | "Battery prompts on Gemini since October" can't be expressed. |
| Results are clipped and capped (8 refs, 12 brands) with no note of what was left out. | `withRefs`, `slice(0, 12)` | Ask can't say "based on 120 of 3,400 answers" and the user can't judge the answer. |
| A follow-up ("and on Gemini?") has no memory of the scope used. | `ask({history})` passes text only | Each turn guesses the scope again. |
| Continue in…, Dashboard search, Insights and Ask each choose data their own way. | `contextPack.js`, `answerSearch.js`, `insights.js` | The same question can give different numbers in different places. |

What already works and stays:
- The tools compute with the boards' own code (`computeMetrics`, `campaignInsights`), not the model.
- `checkNumbers` flags any number no tool returned.
- Answers link to their captures.

Those are exactly the habits the research recommends. The missing parts are the map, the scope logic and the search.

---

## 3. What the research says

### 3.1 Let the model choose, never compute: the semantic layer
- dbt, Cube, Looker and ThoughtSpot all put a "semantic layer" between the question and the data. It is a fixed list of measures (visibility, share of voice…) and of the ways to slice them (engine, run, topic…). The model's job "shrinks to mapping a question onto those metrics and dimensions", and the engine produces the query deterministically.
- dbt's own 2026 benchmark found models answered more questions correctly through the semantic layer than by writing raw queries (98.2% against 90.0%, and 100% against 84.1%). It is the vendor testing its own product, so read the figures as indicative.
- Looker states that "the LLM interacts with the semantic layer via APIs", and that its semantic layer cuts errors in natural-language queries "by as much as two thirds" (also a vendor claim).
- ThoughtSpot's Spotter turns questions into tokens grounded in its model, and "only the SQL that ThoughtSpot generates runs".
- **For CitoSkeleton:** keep every number in code (already true), and make the *choice of data* a fixed, checkable request.

### 3.2 Turning a question into filters plus a search: the "self-query" pattern
- LangChain's self-query retriever has the model write a structured query: a free-text part, plus **metadata filters** on described fields (for us: campaign, run, engine, tag, date, brand). The filters are applied *before* searching.
- Elastic's write-up warns that it depends on the model reading the filters right, and that vague questions or loosely defined fields give incomplete results.
- **For CitoSkeleton:** check every filter against the Catalog, and ask back when a filter is ambiguous.

### 3.3 Fewer tools, strict formats
- A study cited in the function-calling literature found that decisions "degrade significantly as the number of available tools increases"; cutting 46 tools to 19 improved selection accuracy.
- A 2025 survey of small models for agents: with "explicit tool schemas and robust validators, SLMs frequently match or even surpass larger LLMs in function-calling reliability".
- The Hammer paper (ICLR 2025, on-device models of 1.5–7B) adds two lessons:
  - train the model to rely on *descriptions* rather than names;
  - teach it to say "no tool fits" (irrelevance detection) rather than force a wrong call.
- **For CitoSkeleton:**
  - replace 22 tools with **one request form** (plus a passage search);
  - make the model fill it from **choices that exist**;
  - let it answer "this isn't something the tool records".

### 3.4 Holding a small model to a format: constrained output
- Chrome's built-in Prompt API takes a JSON Schema as `responseConstraint` (Chrome 137 and later), so Gemini Nano's reply *must* fit the form.
- XGrammar shows the same can be enforced token by token for other models.
- For the downloaded Qwen model (Transformers.js), where no such constraint is available: validate, repair and retry once, then fall back to the rule-based request.

### 3.5 Matching loose words to real names: "value retrieval"
- Text-to-database systems (CHESS, Stanford 2024; XiYan-SQL) found that users' questions "might not have the exact database value". They look up the user's words against the real values first, by keyword and fuzzy matching (LSH) plus similarity.
- CHESS also prunes what the model sees to what is relevant. In one large database that gave 2% more accuracy at a fifth of the tokens.
- **For CitoSkeleton:** look up names in the Catalog *before* the model runs, and show it only the matching campaigns, brands, tags and prompts. That also keeps the prompt within Chrome's small window.

### 3.6 Finding passages: hybrid search fused by rank
- Current practice combines keyword search (BM25) with embedding similarity, merged by **Reciprocal Rank Fusion** (RRF, usually k = 60).
- Orama runs full-text, vector and hybrid search in the browser.
- A multilingual-e5-small model runs offline for 100+ languages, and Transformers.js runs embedding models inside a Chrome extension (WebGPU in the offscreen document, which CitoSkeleton already uses).
- Caveat: keyword search needs a tokenizer per language, or recall drops silently outside English.

### 3.7 Questions that span several things: decomposition
- LlamaIndex's *router* sends a question to the one source it fits.
- Its *sub-question* engine splits a comparison ("Zento vs Kovo on Gemini and ChatGPT") into sub-queries and joins the answers.
- **For CitoSkeleton:** a request may carry a short list of sub-requests, which the code runs and joins. The model never adds numbers up itself.

Sources are listed in §11.

---

## 4. The design

```
 question ──► 1 Understand ──► 2 Resolve scope ──► 3 Execute ──► 4 Write ──► answer
               rules first       Catalog lookup      Facts +        from results    + scope line
               model fills       ask back if         metrics        only, numbers   + coverage
               the rest          ambiguous           (+ passages)   checked         + links
                  ▲                    ▲                  ▲
                  └──── Catalog ───────┴──── Facts ───────┴──── Passage index
                        (names)          (one row per           (answer text,
                                          prompt×engine×run)     searchable)
```

### 4.1 The data map: what exists and how it relates

| Thing | What it is | Key |
|---|---|---|
| **Collection** | A campaign, or **My questions** (everything asked by hand: the Dashboard history) | `profileId`, or `history` |
| **Prompt** | A tracked prompt with its tags (campaign), or a distinct normalised question (history) | `promptId` / normalised text |
| **Run** | One campaign run (start, engines, signed in or out, status) | `geoRunId` |
| **Turn** | One prompt asked on one engine in one run | (`run`, `prompt`, `engine`) |
| **Answer** | The stored answer for a turn (a derived record) | `captureId` |
| **Mention** | A brand named in an answer, with its order and count | (`captureId`, brand) |
| **Source** | A site cited or only read by an answer | (`captureId`, url) |
| **Search** | A search the engine ran (fan-out) | (`captureId`, query) |
| **Card** | A product or place card shown | (`captureId`, name) |

**Grain matters.** Visibility is counted per answer, position per mention, and a prompt-level result ("named on 3 of 4 engines") per prompt. Every measure in the catalog states its grain, so the code never mixes them.

### 4.2 The Catalog: a map of every name

A small index, rebuilt as captures arrive:
- **Collections**, with display names, own brand, competitors and date range.
- **Brands**, with every spelling seen ("realme", "Realme", "realme 14 Pro → realme"), the collections they appear in, and counts. This is also where the owner's open question on "also written as" lands.
- **Tags/topics** per campaign.
- **Prompts**, by text, with collection, tags and language.
- **Engines** and their aliases ("GPT" → ChatGPT, "Bard" → Gemini, "pplx" → Perplexity) in all six interface languages.
- **Sites** (domains, with their kind: review, retailer, forum…) and **products**.

**Lookup.** A question's words are matched against the Catalog by exact, normalised and fuzzy (trigram) matching, in that order, plus aliases. Each match carries a score and what kind of thing it is. This runs in code in milliseconds, before any model.

### 4.3 The Facts table: one row per turn

A flat table in IndexedDB, updated when an answer is stored or re-read:

`collection · run · prompt · tags · engine · date · signedIn · answered · limit · ownNamed · ownPosition · firstBrand · brandsNamed[] · brandPositions{} · citedDomains[] · ownSiteCited · cardsShown · searchesRun · captureId`

- **Why:** every measure the boards show can be computed from these rows, quickly, without opening thousands of full answers.
- **Size:** 10,000 turns × ~400 bytes ≈ 4 MB, fine for IndexedDB and for filtering in under 50 ms.
- **The same functions as the boards** compute from it (`computeMetrics` and `insights` are fed the rows). A test checks that board and Facts give identical numbers on every fixture.

### 4.4 Understanding: the Query plan

Every question becomes one fixed-form request:

```json
{
  "intent": "metric | rank | compare | trend | gaps | why | find_answers | sources | searches | cards | define | data_status | not_recorded",
  "scope": {
    "collections": ["<id>"] , "runs": "latest | all | [<id>] | {from,to}",
    "engines": [], "tags": [], "prompts": [], "dates": {"from": null, "to": null}, "signedIn": null
  },
  "subject": { "brands": [], "sites": [], "products": [] },
  "measure": ["visibility", "share_of_voice", "position", "mentions", "citations", "first_place"],
  "by": "engine | tag | prompt | run | brand | site | none",
  "sort": "desc", "limit": 10,
  "text": "words left for a passage search, if any",
  "parts": [ /* sub-requests for comparisons, same shape */ ]
}
```

It is filled in three passes:
1. **Rules, no model.**
   - Catalog matches fill names: collections, brands, tags, engines, sites, prompts.
   - Date words ("last week", "since October", "latest run") fill dates and runs.
   - Measure words ("share of voice", "rank", "cited") fill `measure`.
   - Shapes ("vs", "compared with", "trend", "why") fill `intent`.
   - All of it in six languages.
   - Most questions are complete after this pass.
2. **The model, only for what's left.**
   - It sees the question, the plan so far, and **only the matching Catalog entries as choices**. For example, campaign ∈ {"Zento India", "Zento US"}, never a free name.
   - Its reply is held to the plan's schema: `responseConstraint` on Chrome's model; validate, repair and retry once on Qwen.
   - It may answer `not_recorded` (clicks, traffic, Google rankings, spend), in which case Ask says what the tool does record.
3. **Checks.** Every id must exist, the measure must fit the intent and the grain, and the engines must be ones the scope ran. Anything that fails goes back to pass 1's value, or becomes a question to the user.

### 4.5 Deciding the scope: which campaign, run, prompts

This is the heart of the brief. Fixed rules, in this order:

1. **Named wins.** A campaign, tag, engine or date named in the question is used.
2. **Where the user is.** Asked from a campaign's page, or with one open, Ask starts there. Asked from the Dashboard, it starts on *My questions* and all campaigns. The page passes this in; today it doesn't.
3. **The conversation.** A follow-up keeps the last scope and changes only what it names: "and on Gemini?" keeps the campaign and run and swaps the engine.
4. **Brand ≠ campaign.**
   - A brand name is a *subject*, not a scope, unless it is also a campaign's name and no other campaign tracks that brand.
   - "How is Kovo doing?" is answered across the campaigns that track Kovo, listed per campaign.
5. **Weighing several matches.**
   - Each candidate collection scores on: named in the question (strong), open in the page (strong), its tags or prompts match the question's words (medium), it tracks the brands named (medium), recency (weak).
   - A clear winner, meaning the best score is more than twice the next, is used.
   - Otherwise **Ask asks back** with clickable choices: *"Zento India or Zento US?"*. It never guesses silently.
6. **Run defaults.** Measures use the latest *finished* run per engine, the same as the board's "Latest answers". Trends and "since…" use all runs. Run in progress is never mixed in without saying so.
7. **Prompts by meaning.** "Battery prompts" matches a tag called battery first. Failing that, prompts are matched by passage search on the prompt text (§4.7), and Ask lists which prompts it took ("I used these 14 prompts about battery") so the user can correct it.
8. **Always shown.** Above every answer is the scope line: *Zento India · latest run (12 Nov) · ChatGPT, Gemini · tag: battery · 56 answers*. Each part is a chip the user can change, which re-runs the plan without asking the model again.

### 4.6 Running it: the Executor

Code only, no model. It:
- filters Facts by the scope;
- computes the measures with the boards' functions;
- groups by `by` and sorts;
- runs `parts` and joins them.

It returns a typed result:
- the table;
- the exact scope used;
- **coverage**: answers used, answers in scope with no answer or a usage limit, engines missing, runs;
- the capture ids behind each figure.

Coverage is what lets Ask say "based on 56 answers; Perplexity was signed out and limited in this run".

### 4.7 Questions about wording: the passage index

For "what do the engines say about Zento's battery?" or "which answers mention a warranty?":
- **Units:** each answer is split into passages (paragraph, list item, table row), each tagged with collection, run, prompt, engine, date and the brands in it.
- **Search:**
  - BM25 keyword search with per-language tokenizing (Orama, or the existing search widened);
  - plus, as an optional download, multilingual embeddings (multilingual-e5-small, run in the offscreen document like Laya), so "long-lasting charge" finds "battery";
  - the two are merged by Reciprocal Rank Fusion.
- **Always inside the scope.** Filters come first, as in self-query (§3.2), so thousands of other campaigns' passages never compete.
- **Kept fresh:** the index updates when an answer is stored or re-read. The Dashboard's search uses the same index, so it gets typo tolerance and ranking too.

### 4.8 Writing the reply

- The model gets the question, the scope line and the Executor's result (a few rows, never raw answers), and writes a short reply in the user's language.
- `checkNumbers` stays. Any number not in the result is flagged.
- For headline numbers there is a **template sentence that needs no model** ("Zento was named in 41% of answers (23 of 56), up 6 points on the previous run"). With the AI off or slow, Ask still answers.
- Links: every figure's answers stay one click away.
- **Honest limits:** small coverage ("only 3 answers") is said; `not_recorded` gets a fixed explanation of what the tool can and can't see.

### 4.9 Remembering the conversation

Each Ask turn stores its resolved plan, not just its text. A follow-up starts from that plan (§4.5, rule 3). "Clear" resets it. The chat shows when a follow-up inherited a scope.

### 4.10 One foundation for every smart feature

| Feature | Today | With this design |
|---|---|---|
| **Ask** | 22 tools, guessed scope | Query plan, scope rules, Executor, passages |
| **Continue in…** | `contextPack` picks its own data | Packs the Executor's result for the scope shown; the share pack and Ask agree |
| **Dashboard search** | All words must appear literally | Same passage index: ranked, typo-tolerant, any language |
| **Campaign insights / What to do next** | `insights.js` over full records | Same Facts and functions; faster on big campaigns |
| **AI check / Laya labels** | Per answer, unchanged | Labels become Facts columns (stance, intent), so Ask can filter by them ("answers that recommend Kovo") |

---

## 5. Scale

| Data | Today | With Facts + index |
|---|---|---|
| 10 campaigns × 1,000 prompts × 4 engines × 5 runs = 200,000 turns | Every Ask question reads all full records (tens to hundreds of MB) in the service worker | Facts ≈ 80 MB at the top end; per question, only the scope's rows (usually thousands) are read, via IndexedDB indexes on collection, run and engine |
| Passage search over 50,000 answers | Linear scan, all words required | Keyword index ≈ 10–20% of the text size; embeddings optional (≈ 1.5 KB per passage at 384 dimensions) |
| The model's context | Up to 8 tool schemas plus results, near Chrome's limit | One schema plus a handful of Catalog choices plus a small result table |

---

## 6. Worked examples

1. **"How are we doing on Gemini?"**, asked from the *Zento India* campaign page.
   - Rules: intent = metric, engine = Gemini, own brand.
   - Scope: Zento India (the open page), latest finished run.
   - Model: not needed.
   - Reply: template sentence plus scope line.
2. **"Is Kovo beating us in the battery prompts since October?"**, from the Dashboard, with two campaigns tracking Kovo.
   - Rules: compare, subject Kovo plus own brand, tag battery, from 1 Oct, all runs.
   - Two campaigns match equally, so Ask asks back: *Zento India or Zento US, or both?*
   - On "both", the plan gets two parts, one per campaign, joined in one table.
3. **"Which sites should we get onto?"**: intent gaps (source gaps), scope as above, with the list and the answers behind each site.
4. **"What do the engines say about our warranty?"**: intent find_answers, with `text` = warranty. The passage search runs inside scope and the reply quotes passages with links.
5. **"How many clicks did ChatGPT send us?"**: intent not_recorded. Ask explains that it records answers, not traffic, and offers what it has (citations of your site).
6. **"And on Perplexity?"** after example 1: the scope is inherited, the engine swapped.

---

## 7. How it would be tested

- **A gold set of 200+ questions** in the six languages, over the synthetic campaigns in `training/synth.mjs` (with several campaigns sharing brands and tags on purpose). Each question carries its expected plan and expected numbers.
- **Measured:**
  - scope right;
  - intent right;
  - numbers exact;
  - asks back when it should, and only then;
  - `not_recorded` when it should.
- Run in CI with the rule pass only, which must be deterministic. Run with the real models on a machine with network (`scripts/eval-llm.mjs`, extended).
- **Parity tests:** for every fixture, the Facts-based numbers equal the boards' numbers.
- **Browser tests:**
  - the scope chips;
  - an ask-back with choices;
  - a follow-up inheriting scope;
  - Dashboard search finding a paraphrase;
  - Continue in… carrying the same numbers as Ask.
- As always: each fix gets a test that fails on the old code.

---

## 8. Building it in stages

Each stage is a release of its own and is useful on its own.

| Stage | What the user gets | Built |
|---|---|---|
| **1. Foundation** | Ask shows its scope and asks back instead of guessing; answers the common questions even with the AI off; numbers match the boards | Catalog, Facts (+ parity tests), Query plan, rule pass, scope rules, Executor, template replies, scope chips |
| **2. The model, on rails** | Harder wording understood; follow-ups keep their scope; "not recorded" handled | Model pass with constrained choices, plan memory, gold set and eval |
| **3. Search that understands** | Dashboard search and Ask find paraphrases, in any language | Passage index (keyword first, then optional embeddings), self-query filtering |
| **4. Everything on one foundation** | Continue in…, insights and Ask always agree; labels usable as filters | Rewire `contextPack`, `insights`, Dashboard search; Laya labels as Facts columns |

Stage 1 alone removes the "fake" behaviour: wrong campaigns, silent guesses, numbers without a stated scope.

---

## 9. Decisions for the owner

1. **Ask back, or best guess with the scope shown?** Recommended: ask back only when two matches are close (§4.5, rule 5); otherwise use the best one and show it as an editable chip.
2. **My questions (Dashboard history) as its own collection** in Ask and Continue in…: yes or no?
3. **Embeddings download (Stage 3):** an optional ~100–120 MB download (multilingual-e5-small; size to confirm on its model page) for "search by meaning". Or keyword search only.
4. **Order:** Stage 1 first, as above, or Stage 3 (search) first if Dashboard search matters more right now.

---

## 10. What this does not change

- Everything stays on the user's computer: no server, no data out.
- The boards' numbers and definitions stay as they are; the Facts table is checked against them.
- The existing tools stay available to the code. The model stops choosing among them.

---

## 11. Sources

- LangChain, self-query retrieval: https://python.langchain.com/docs/how_to/self_query · https://js.langchain.com/docs/how_to/self_query
- Elastic, self-querying retrievers and their limits: https://www.elastic.co/search-labs/blog/self-querying-retrievers
- dbt Labs, semantic layer vs text-to-SQL (2026 benchmark): https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026
- Atlan, semantic layer for text-to-SQL: https://atlan.com/know/ai-agent/semantic-layer/semantic-layer-for-text-to-sql/
- Google Cloud, Looker conversational analytics: https://cloud.google.com/blog/products/business-intelligence/looker-conversational-analytics-now-ga · https://cloud.google.com/blog/products/business-intelligence/how-lookers-semantic-layer-enhances-gen-ai-trustworthiness
- ThoughtSpot, Spotter and its semantic layer: https://www.thoughtspot.com/blog/introducing-spotter-ai-analyst · https://docs.thoughtspot.com/cloud/latest/semantic-layer
- Berkeley Function-Calling Leaderboard: https://gorilla.cs.berkeley.edu/leaderboard.html
- Small Language Models for Agentic Systems (survey, 2025): https://arxiv.org/pdf/2510.03847
- TinyLLM, small models for agentic tasks on edge devices: https://arxiv.org/pdf/2511.22138
- Hammer, robust function-calling for on-device models (ICLR 2025): https://arxiv.org/abs/2410.04587
- Chrome Prompt API, structured output: https://developer.chrome.com/docs/ai/structured-output-for-prompt-api
- XGrammar, structured generation: https://arxiv.org/abs/2411.15100
- CHESS, value retrieval and schema pruning: https://arxiv.org/abs/2405.16755
- XiYan-SQL: https://arxiv.org/pdf/2411.08599
- LlamaIndex router and sub-question engines: https://developers.llamaindex.ai/python/examples/query_engine/routerqueryengine/ · https://developers.llamaindex.ai/python/examples/query_engine/sub_question_query_engine/
- Orama (in-browser full-text, vector and hybrid search): https://github.com/oramasearch/orama
- Hybrid BM25 + vectors with RRF: https://dev.to/gabrielanhaia/hybrid-search-in-100-lines-bm25-pgvector-with-rrf-merge-58cn
- Offline multilingual-e5-small hybrid search: https://forum.obsidian.md/t/hybrid-search-hybrid-search-mcp-server-cli-for-ai-assistants-bm25-semantic-obsidian-native/112491
- Transformers.js in a Chrome extension: https://huggingface.co/blog/transformersjs-chrome-extension · https://huggingface.co/docs/transformers.js/guides/webgpu
