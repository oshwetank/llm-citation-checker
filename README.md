# CitoSkeleton

_Formerly listed on the Chrome Web Store as "LLM Citation & Fan-Out Checker."_

A Chrome (MV3) extension that **passively** captures what ChatGPT, Gemini, Perplexity and Grok actually do
behind an answer — the hidden search queries they fire, every source they read, which of
those they *cite* versus merely *fetch*, and which brands they name — then measures your
brand's visibility against competitors over time.

Everything is stored **locally in your browser**. The extension makes **no network requests
of its own**, except, if you turn on **Read the cited pages**, to the pages an answer cited;
if you download the **built-in AI**, a one-time download of the model's files from
Hugging Face; and, once accounts are switched on, when you sign in, share a campaign by
code, open a code, or leave an email for updates. Nothing you capture ever leaves your
device unless you choose to share that campaign: the AI runs on your computer.

> **v1.0.4** — ChatGPT, Gemini, Perplexity and Grok. See
> [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [RESEARCH.md](RESEARCH.md)
> for the original feasibility research. Taking over development? Start with
> [HANDOFF.md](HANDOFF.md).
>
> **Recent changes:**
> - **Next (1.0.5, in progress).**
>   - **Ask knows which data you mean.** It works out the campaign, run, engines and tags from your question, shows them above the answer as chips you can change, asks back when two campaigns fit equally, and answers from the boards' own numbers, even with no AI model turned on.
>   - **Gemini asked once.** Gemini's new way of sending a question wasn't recognised, so the extension pressed send again and Gemini got each question 2 or 3 times. It now sees Gemini's send and waits for it.
>   - **Google AI Mode, the fifth engine (beta).** Capture its answers and run campaigns on it, slowly: turn it on in Settings.
> - **1.0.4** (23 November 2026). ChatGPT turns that showed the question but never sent it.
>   - **No more silent ChatGPT timeouts.** On some accounts ChatGPT shows a new conversation at a temporary address (/c/local-…) before its servers have it. That no longer counts as sent: the turn waits for ChatGPT's own request, a real conversation or the answer, and otherwise fails in ~10 s saying the question never left, so "Retry missing" can ask it again.
> - **1.0.3** (23 November 2026). Fixes from a 530-question campaign run (CRM software and running shoes) on ChatGPT, Gemini and Perplexity.
>   - **Gemini asked once.** Each campaign question was sent to Gemini 3 to 5 times, each a new conversation in your history; it is now sent once.
>   - **No false limits.** A Perplexity source card that mentions "rate limits" no longer pauses Perplexity for 30 minutes.
>   - **Queue and controls.** Run stays on every other campaign's page while one runs, and queues it; one engine cooling down no longer makes the run say "Paused".
>   - **Smoother while a run goes.** Setting up a campaign no longer loses what you typed, and the panel no longer floods the extension with background checks.
>   - **Board and brands.** An empty copy never replaces an answer; names in "**Name:**" bullets (Gemini's usual layout) are found, and "CRM", "However", plan tiers and bullet labels are no longer brands. Share of voice counts every written mention.
> - **1.0.2** (22 November 2026). Fixes from typing 151 questions across industries into all four engines and checking every stored answer against the engine's page.
>   - **Brands in short answers.** Perplexity now often answers in two or three sentences of plain prose; those answers listed no brands at all. Names in a list ("Swiggy and Zomato"), names put forward as the pick ("Jio is the strongest starting point") and names bolded side by side are now found, and half names are made whole ("Asit Mehta & Associates", "Jeeva Pet Hospital"). A word of the question ("Seoul", "Insurance") and a map listing's keyword tail are no longer brands.
>   - **What the answer showed, kept.** ChatGPT's "Official website" links, Gemini's comparison tables, its places' ratings and kinds and its product pictures, Perplexity's page dates, its "trusted" marks and every snippet it sent, and the full thread of its newer `/session/` pages. ChatGPT's section headings are no longer stored as products.
>   - **More on screen.** Perplexity's "✓ Trusted" mark on each site; Gemini's places with their photo, address, hours, links and review quotes; how fast the answer began ("First words after 1.9 s"); company cards shown as the answer's "Picks", not as products; and a campaign run's totals count every question it sent, a failed one included.
>   - **Campaigns ask once and send for sure.** Gemini answers `?q=` by itself now, so each campaign question went to it twice; and ChatGPT's pre-filled question could sit unsent until the turn timed out. Both fixed. Analyze lists your brand and your competitors wherever the answer names them, as the campaign board counts them.
>   - **A usage limit is not an answer from memory.** When Grok's free tier ran out, each refused question was stored as an empty answer and Analyze called it "From memory", as if Grok had stopped searching. It now reads "No answer · usage limit" everywhere, and campaigns leave it out of the numbers.
>   - **Gemini's question, once.** Gemini added a hidden "You said …" heading to each question, and the question was stored twice over ("Q Q"), so answers didn't match their prompts. Reprocess all repairs answers already stored.
>   - **One answer, one record.** A ChatGPT card answer was stored up to three times while it was being laid out, and each Perplexity answer twice (its threads moved to /session/…). Copies now join into one answer.
>   - **Local answers keep their places.** Gemini's map cards and ChatGPT's newer business listings are kept as places, with ratings and reviews, and the businesses are the brands — no longer "Hi", "Om", "Dr" or a section heading.
>   - **Brands read the way you would, in more layouts.** Makers of more than one word (Follow Up Boss, Royal Canin, New Balance, Red Tape), names after a heading's label ("Best Overall: **Zoho CRM**"), bold lists of names, names bolded again and again, lists in a sentence ("options from ASICS, Brooks, New Balance, Adidas and Puma"), lender tables ("Central Bank of India"), lowercase makers (adidas) and acronyms that spell a word (TVS). Not brands any more: list labels ("Team features", "Privacy/Security"), chip names (RTX, Ryzen), honorifics, questions, category headings and publishers being quoted ("CNET and AARP note…").
>   - **A card the reader can't follow no longer loses the answer.** One ChatGPT product card written slightly differently made "Reading the reply failed" and nothing was stored; now that card stays as text and the answer is kept. Reprocess all recovers answers lost this way.
>   - **No layout code in answers.** Gemini's review carousels and suggested follow-ups, and ChatGPT's unfilled form options ("{v}"), no longer show as text.
>   - **The capture report says where Gemini's page copy stopped**, as ChatGPT's already did, and the diagnostics log no longer fills with Perplexity's empty side requests (the same one is noted once per 10 minutes), so other engines' notes stay in it.
> - **1.0.1** (19 November 2026).
>   - **Product cards show their pictures.** A ChatGPT card answer whose products came without a picture (every card an empty cart, while "Images shown" had the phones) now gives each card the image titled with its name. Answers already captured show them too.
> - **1.0.0: the release after 0.36** (November 2026).
>   - **Help to get going.** A Get started checklist on the Dashboard, a Help & FAQ page (About → Help & FAQ), example prompts when you set up a campaign, and on each campaign's results how many answers its numbers rest on and what to do next. Updating from an earlier version, the guide opens on what changed.
>   - **No new permissions when updating.** The extension no longer asks for access to google.com.
>   - **Translations are marked beta** until a native speaker has reviewed them.
  - **Brands read the way you would.** A word the answer also uses as an ordinary word (sugar, oats, ragi) is no longer a brand; a table of nutrients or criteria names nothing; a list item's bold name, an "e.g." list and a set of product headings are read as brands, trimmed to the maker ("Cremica High Bran Biscuits" is Cremica). Shops such as Zepto and Blinkit count as shops.
  - **Chrome's built-in AI finishes, and can correct the list.** Its reply is bounded and read as it arrives, so a slow computer no longer runs out of time on every answer. It can say a name isn't one, and which brand a product belongs to; with "Let the AI correct brands in counts" on, it fixes the counts, and Analyze shows what it changed.
  - **ChatGPT's generated-layout answers, signed in and signed out.** A product card whose name was a reference no longer shows as "**2. **" with its maker missed; a signed-out answer that arrives as layout code is read from ChatGPT's own markdown version instead of coming out empty, and the product names in its data feed the brand list. Makers named in a product's title (boAt, JBL, realme) are found when a seller's card names only the seller, and a seller's website or "What's" is not a brand.
  - **The prompt as you asked it.** A question pasted into ChatGPT as bold text no longer shows its asterisks.
  - **Gemini keeps the question.** Gemini's session-setup upload no longer replaces the upload that carried your question, so the prompt is stored.
  - **ChatGPT answers are read from the conversation.** After you ask ChatGPT a question in a tab, CitoSkeleton reads that conversation from chatgpt.com once it's answered, the way ChatGPT's page loads it (the browser's own cookies and the page's device and account identifiers; no sign-in token is asked for). Another extension holding the page's connections, or ChatGPT changing its page, no longer stops the answer being recorded. The capture report says when another extension holds the page's connections.
  - **Signed-out runs.** Perplexity's "Sign up and repeat your request" (in any language) is no longer stored as an answer: it is a usage limit, so the run pauses Perplexity and, if it doesn't lift, marks the rest "usage limit" for Retry missing. ChatGPT's first, still-searching copy of a signed-out answer is no longer kept as an empty answer beside the real one. The signed-out confirmation counts only the engines that run (Grok needs an account).
  - **Gemini's suggested follow-ups** are no longer part of the answer text, and products named in bold inside a sentence ("devices like the **Realme P4 Power**") add their maker to the brands.
  - **ChatGPT's question and answer in one turn.** Since 16 Nov 2026 ChatGPT can draw both in one block of its page; the page copy found only the question and gave up. Each message is now found from its own heading. The capture check says when an answer wasn't found, instead of "idle", and Perplexity's empty side calls after a saved answer no longer read as a lost answer.
  - **ChatGPT's card answers copied off the page.** A card's number and name, bold apart, no longer run together ("**1.****Titan Eye+**"), a price is no longer a heading, and the copy keeps its lines for brand detection, so the stores and phones named are the brands, not "Preferred" or "Excellent". Answers already copied are read again on update.
  - **Reading the conversation without identifier cookies.** Where the browser doesn't set ChatGPT's device and account cookies, the identifiers are read from the page itself, as ChatGPT's own page sends them; every read had come back "not found". The capture check says which identifiers it had.
  - **Select all on the Dashboard.** One tick selects every prompt in the list as filtered, for export, a campaign or removal.
  - **ChatGPT and Gemini, as they changed in November 2026.** ChatGPT's new send and composer are recognised, and the capture report says how far the page copy got; Gemini's prompt is read from its new upload.
> - **The campaign results in your language too** (0.84.3). Spanish, Portuguese (Brazil), French, Hindi and Arabic.
>   - **Campaigns.** Every section of a campaign's results (overview, brands, compare, sources, citations, prompts, run vs run, products, searches and ads, signals), the run history and the setup page are translated: about 260 more phrases each.
>   - **Lines with a name in them.** "Show boAt in the answer", "Compare Samsung with Google", "Tracking Google" and the like now follow the language, with the name kept as it is. What you typed yourself is never translated.
>   - **Dates and counts.** Dates on Analyze, the Dashboard and Campaigns are written in the chosen language. "1 prompts" now reads "1 prompt", in English too.
>   - **What's new** is translated, and lists these changes.
> - **Much more of the interface in your language** (0.84.2). Spanish, Portuguese (Brazil), French, Hindi and Arabic.
>   - **About 400 more phrases each.** The Dashboard, Analyze, starting a campaign, Ask, and About (overview, the metric glossary, settings, diagnostics) were largely English in the other five languages. They are translated now.
>   - **Sentences with numbers and engine names.** Lines such as "3 of 6", "Asked Perplexity" and "6 pages read · 3 cited" used to stay English whatever the language. They follow it now.
>   - **Still English for now.** Lines with a brand or site name inside them, the campaign results board, the What's new list, and dates on Analyze. The translations are drafts and want a native speaker's review.
> - **Safety fixes before release** (0.84.1). From a security review of the whole extension; nothing was found being misused.
>   - **Shared campaigns are checked on import.** A campaign file or share code from someone else is no longer trusted as it comes: any link in it that isn't a normal web address is removed, and a damaged answer can't break the export. A file made to unpack into gigabytes is refused.
>   - **Saved reports are locked down.** The HTML report you save can show pictures and print itself, and nothing else: no script from the text in it can run.
>   - **Read the cited pages only reads public sites.** Addresses on your own computer or home/office network (localhost, 192.168.x.x, a router) are skipped. Opening a page in a hidden tab, which uses your own sign-ins, now happens only when you press Read pages on an answer yourself, not automatically.
>   - **Continue in… checks the site.** Your data is typed only into the AI site you chose; if the tab was sent somewhere else, nothing is typed.
>   - **Engine pages can only send captures.** The scripts inside ChatGPT, Gemini, Perplexity and Grok pages can hand over an answer; they can no longer ask the extension for stored data or to delete it.
>   - **Chrome 111 or newer.** Older versions installed the extension but captured nothing, without saying so; they are now told it needs an update.
> - **Models as switches, and capture that holds when a site changes** (0.84.0).
>   - **Models in Ask.** Ask → Models on this computer: one switch for the AI model and one for Laya. On downloads it; off stops a download or removes the model. The popup has Ask too. The download's progress shows in the app bar.
>   - **Uninstalling removes them.** The models are kept in the extension's own storage, which Chrome deletes with the extension. Gemini Nano is Chrome's own and stays.
>   - **Capture when an engine changes its format.** A question asked by hand on ChatGPT, Gemini, Perplexity or Grok is read off the page when no readable network copy of the answer is stored: the prompt, the answer, its brands and its links. A network copy, when it arrives, still wins.
>   - **Said, not lost.** If a question still isn't captured after 90 seconds, Analyze says so, with Refresh the tab and Copy capture report.
>   - **Clicks and scroll.** Every clickable thing shows it, with press feedback and 24px targets. Jumps scroll smoothly, unless Motion is off. Rows that scroll sideways fade at the edge.
> - **Fast labels with Laya** (0.83.0).
>   - **What it does.** About → Settings → Built-in AI → **Fast labels: Laya**. Laya is an open decision model (Apache-2.0, many languages). Download it once and it labels every answer: what it asks, its stage, who it's for, how far its market reaches, and for each brand what it is and how the answer treats it. It picks among fixed options in one pass of the model and writes no text, so it's much quicker than the AI model and can't invent a name or a quote. A quote is always the answer's own words.
>   - **Unsure labels.** The multilingual Laya isn't calibrated, so a label is kept only when Laya is clearly sure. The rest are left blank and listed as unsure.
>   - **Ask still uses the AI model.** "Label answers with" chooses Laya or the AI model; Automatic uses Laya once it's there.
>   - **Size.** The download is 1.2 GB (1.3 billion bytes). `training/laya-quantize.py` makes an int8 copy about a quarter of that.
> - **Share a campaign, so someone else can run it** (0.82.0).
>   - **As a file.** Campaigns → ⋯ → Share campaign… saves the whole campaign as one `.cito` file: its setup, prompts and tags, every run, the answers, and the raw captures behind them. Whoever gets it opens it from Campaigns → Import… and has the same campaign, with the same numbers, ready to run on their own computer. Nothing of theirs is overwritten: an import is always a new campaign.
>   - **By code, with an account.** Sign in under About → Account with a code sent by email (no password). Then Share gives a 10-letter code that opens the campaign for anyone signed in, for 90 days, and About → Account lists what you've shared, with Stop sharing.
>   - **Accounts aren't switched on in this build.** The server is in `server/` (Vercel + Supabase) with its setup steps; until it's deployed, every place that offers a code says so, and sharing by file works regardless. The update email from 0.81.0 is sent once the server is live.
> - **A welcome guide and email sign-up** (0.81.0).
>   - **A full-page welcome, once.** When CitoSkeleton is installed, or updated by someone who hasn't seen it, it opens a page of its own, in pictures with little text. It covers what the tool does, Analyze, the Dashboard, Campaigns, and Ask and share. It replaces the tour that was drawn over the panel and kept coming back. About → "Open the guide" shows it again.
>   - **Email for updates.** The last step asks for an email, with a plain note: it's only for news about updates and offers, never sold or shared with anyone, and only the developer sees it.
>     - The address is checked properly. Random text is refused, and so are throwaway inboxes, Gen Z style ("A burner inbox? Not the vibe 💀"). A slip like "gmial.com" gets a "did you mean".
>     - Skip is allowed: it says once what you'd miss, then never asks again.
>     - The email can be changed or removed in About → Settings → Data and capture.
>     - It's kept on this computer until the developer's server is live (0.82.0).
> - **Campaigns that make sense** (0.80.0).
>   - **Engines run on different days, one view.** Run ChatGPT on Monday and Gemini on Tuesday, and the campaign shows each engine's newest answers together ("Latest answers · every engine"). Before, the board showed only the newest run, so the Gemini run hid the ChatGPT one.
>   - **Run vs run.** A new tab sets two runs side by side, over the prompts both answered on the same engine. It shows each brand's visibility and place, and the change. Prompt by prompt, it shows where your brand moved, who was named first, and which brands came in or dropped out. It also lists the sites cited in each run.
>   - **Two campaigns, one after the other.** Starting a campaign while another runs queues it ("Queued · starts when … finishes", with Cancel). It starts by itself when that run finishes or is stopped.
>   - **Carry on a stopped run.** After Stop, the campaign offers "Continue this run · N left", which asks only what's left and adds the answers to the same run.
>   - **A calmer header.** One **Run** button, with a ▾ for "Run signed out". While a run goes, Pause or Resume and Stop. Everything else (Edit setup, Export…, Delete) is under **⋯**.
>   - **Share icon instead of "Continue in…" everywhere.** One share icon at the top right sends what's on screen to another AI: the answer in Analyze, the campaign, or the prompts picked on the Dashboard. Ask keeps its own "Continue in…".
>   - **Brand on every tab.** The campaign's brand picker (now labelled "Brand") points every tab, including Run vs run, at the brand you pick.
>   - **Pictures, places and products in signed-out answers.** ChatGPT's own cards in signed-out answers are read now: pictures with the page they came from, local businesses with where they are and directions, and products. On the owner's signed-out captures, 112 of 122 answers now show pictures, where none did. Answers already stored are read again once. Answers read off the page keep their pictures too.
>   - **The welcome guide shows once.** It used to come back every time if it was closed partway. The extension now remembers it was opened.
> - **ChatGPT fast and reliable next to Gemini** (0.79.0).
>   - **ChatGPT answers read off the page when the network can't be seen.** Your 0.78.1 report showed ChatGPT pages making no conversation request the extension could see, only a WebSocket per prompt, so ChatGPT turns timed out while Gemini's were captured. When a ChatGPT answer finishes and no network capture arrives, CitoSkeleton now reads it straight off the page: the prompt, the answer with its lists and headings, and its links as cited sources. This works for campaign turns and for questions asked by hand, but never for a conversation you only open. These copies are labelled as page copies, because searches and pages read can't be seen this way. With Debug capture on, ChatGPT's socket messages are kept for a proper reader.
>   - **Signed-out answers keep their structure.** Their lines were folded into one, which hid lists from brand detection. On the owner's signed-out captures, brands found per answer go from 4.05 to 5.67. Stored answers are read again once, on update.
>   - **Recorded the moment the answer ends.** ChatGPT keeps its answer stream open after the answer, sending small keep-alive messages, and CitoSkeleton waited for it to close, which took a minute or two. It now records the answer as soon as ChatGPT says it's done.
>   - **Long signed-out answers kept.** Signed-out answers can be over 8 MB, mostly page markup, and the longest were dropped as too large. The size limit now applies to the compressed copy.
>   - **The run carries on after a usage limit.** When the cooldown ended, ChatGPT never actually restarted, and the prompt that hit the limit was failed. Now that prompt is asked again. "Try again in 1 minute" is read too, where every limit used to wait 30 minutes.
>   - **One ChatGPT tab per run.** ChatGPT's tabs share one session, so two tabs hit its limit twice as fast. Gemini keeps two.
>   - **Honest times.** Time left comes from how fast prompts have actually been finishing, failures and pauses included. Each prompt shows how long it has really been going. The run shows its working time, and "took" leaves out paused time, in hours and days.
> - **Fixes from the Sunban Windows campaign** (0.78.1).
>   - **Limit cards are no longer answers.** Signed out, about 4 in 10 of ChatGPT's replies were its "Message limit reached" card, and CitoSkeleton had stored them as answers that named no brand, which pulled ChatGPT's numbers down. They're now marked as ChatGPT refusing the turn:
>     - they're left out of the numbers;
>     - the run pauses and asks again after a cooldown;
>     - after four cooldowns in a row it gives up on ChatGPT for the rest of the run, so the run can finish.
>
>     Captures already stored are read again once, on update.
>   - **Prompts restored.** Signed-out ChatGPT captures now keep their prompt (it was always empty).
>   - **Retry missing.** When the last run has prompts with no answer, the campaign header says how many and on which engine. **Retry N missing** asks only those, each on the engine that has no answer for it, and adds the answers to the same run.
>   - **Clearer diagnostics.** They now list each failure reason by engine, and count refusals separately from answers.
> - **Smoother, tighter, clearer** (0.78.0).
>   - **Definitions.** Pause on any button, tab or setting for 2.5 seconds (or reach it with the keyboard) and its definition appears, the same way everywhere.
>   - **Logo and name.** The logo opens the CitoSkeleton web page; the name opens the Dashboard, in the popup too.
>   - **Dashboard.** It starts with the history: search and a **Filters** button on one row (with the number of filters on), recent searches while you search, and the totals in one strip. The "stored on this computer" line is gone.
>   - **Settings in groups.** Display (theme, light or dark, typeface, sizes, density and the new **Motion** on/off) is closed until you open it.
>   - **Motion and spacing.** Soft transitions when a page opens. Tighter gaps between boxes.
>   - **Ask is a chat.** The box stays at the bottom, there are bubbles with who said what and when, and it shows what it's looking up while it works. Replies are formatted, and New chat starts over.
>   - **Raw breakdown.** Fields no rule recognises open by default, with their count, and it says what wasn't listed.
> - **Campaigns without the friction** (0.77.0).
>   - **One-click competitors.** The brands the answers name that aren't on your list are offered on the board, each with **+ Add**, plus Add all. They're on the leaderboard too. No unlocking.
>   - **Edit in place.** A set-up campaign is edited in place: prompts, tags, competitors, engines and what the board measures save as you change them. Only the brand and its website ask first, because they change every number.
>   - **Change log.** Every change is listed on the board, so you can see which runs came before it.
>   - **Shorter setup.** Competitors come right after your brand, engines and measures are one row each, and the one-line explanations became hover tips.
>   - **Excel template.** It has **Primary tag** and **Secondary tag** columns, and the Primary column offers your campaign's tags as a dropdown. CSV still works.
>   - **Tags.** The prompt list shows primary and secondary tags apart. You can take one tag off one prompt or make a secondary one primary, and filter by either. Exports get both columns.
> - **Continue in another AI, in one click** (0.76.0). When a question is bigger than the
>   built-in AI, **Continue in…** takes the data, your question and the request to ChatGPT,
>   Claude, Gemini, Perplexity or Grok. It's on each Ask reply, Ask's question box (even with the
>   built-in AI off), Analyze and the campaign board. It opens the AI in a new tab and puts the
>   message in its chat box and sends it. The message holds:
>   - what CitoSkeleton measured and how, with the definitions of the measures used;
>   - the data: headline numbers, prompts, sites, rivals, quotes from the answers;
>   - a task (explain, why it changed, a content brief, a competitor teardown, an outreach list,
>     an executive summary, a 30-day plan) or your own question.
>
>   A preview shows exactly what will be sent, with its size against that AI's limit, and can be
>   edited; "Skip this preview next time" sends straight away. What doesn't fit is left out from
>   the least important end, and the message says what. **Copy for any AI** and **Download as .md**
>   are there for anything else. Claude asks for permission for claude.ai the first time. Those
>   chats are you talking about your own data, so they aren't captured as engine answers
>   (About → Settings can keep them). The text is handed over inside the browser, never in an address.
> - **Ask, trained on the tool** (0.75.0). Ask now looks up 22 things, not 7:
>   - prompts you're missing from, and those where a rival comes first;
>   - where each rival wins;
>   - sites cited for rivals but never for you, and your own site's share;
>   - topics, engines compared and where they disagree;
>   - product cards, the engines' own searches and ads;
>   - data gaps such as usage limits.
>
>   Every model is given what the tool does and doesn't capture, the definitions of its
>   measures, and how a complete answer of each kind reads, in six languages. A number in a reply
>   that no lookup returned is flagged under the answer. `training/` fine-tunes the model on
>   made-up campaigns to answer this way (Colab notebook included). Then **About → Settings → Built-in
>   AI → Your trained model** loads it from your Hugging Face account.
> - **A faster, lighter built-in AI** (0.74.0). Chrome's own AI where Chrome has it (on the
>   graphics chip; Chrome downloads and updates it: About → Settings → Built-in AI → **Use
>   Chrome's built-in AI**). The downloaded model now uses several processor cores at once
>   instead of one, and reads each answer in one go instead of three. **Test this computer**
>   times each engine on the same made-up answer and scores how well it read it; Automatic then
>   uses the fastest one that read it correctly, and you can pick one yourself. The AI waits while a
>   campaign runs, gives its memory back after a couple of minutes idle, and the panel no longer
>   reloads every capture each time an answer is checked.
> - **Capture first** (0.73.1). Questions asked by hand were not being saved, in two ways:
>   - on a page that rebuilds itself after loading (ChatGPT does), the link between the page
>     and the extension was lost, so every answer was thrown away unseen;
>   - once campaigns filled the storage limit, each new hand-asked answer was deleted the
>     moment it arrived.
>
>   Both are fixed. ChatGPT answers are now also caught when they come on a follow-up or
>   unfamiliar stream. **About → Diagnostics → Capture check** shows, for each engine, whether
>   answers are being saved, and if not, where it stops: paused, tab needs a refresh, a reply
>   it couldn't read. **Copy capture report** gives addresses, counts and reasons, never your
>   prompts.
> - **Ask** (0.73.0). A new tab in the full-tab view: ask questions about your own campaigns
>   and captured answers ("How visible is my brand in my latest campaign?", "Which sites are
>   cited most?") and the built-in AI answers on your computer. It looks the numbers up with
>   read-only tools that compute them the same way the boards do, says which lookups it made,
>   and links the answers it used (they open in Analyze). The conversation stays in this
>   browser; Clear removes it. Needs the built-in AI (About → Settings → Built-in AI); the
>   Strong size answers best. Not in the popup, which is too small for a conversation.
> - **Any browser, any screen** (0.72.0). A Firefox version (`node scripts/build-firefox.mjs`,
>   Firefox 128+, desktop and Android) and steps for Safari on a Mac (see "Other browsers"
>   under Install). Edge, Brave, Opera, Vivaldi and Arc run the Chrome version as it is. About
>   shows what works in the browser you're using. Every tab fits from a 360 px phone to a 2560 px
>   screen and at 200% zoom; wide tables scroll inside their card; on touch screens buttons are
>   at least 32 px high. The toolbar icons are drawn at their real sizes.
> - **The interface in six languages** (0.71.0). About → Settings → **Language**: English,
>   Spanish, Portuguese (Brazil), French, Hindi and Arabic, or "Same as the browser" (the
>   default). Arabic lays the whole interface out right to left, while answers, prompts and
>   searches keep the direction of their own language. Dates and numbers follow the chosen
>   language. About 530 labels, headings, buttons and settings are translated; longer
>   sentences built from numbers and names are still English for now. The translations are
>   drafts and need a native speaker's review. The Chrome Web Store name and description come
>   in all six.
> - **A built-in AI model, on your computer** (0.70.0). About → Settings → **Built-in AI**
>   downloads an open-source model once (Qwen3.5 from Alibaba, Apache-2.0, 201 languages:
>   Light 0.5 GB, Standard 1.4 GB, Strong 2.8 GB; the extension checks the computer and
>   suggests one) and runs it in the browser, on the graphics chip when there is one, else on
>   the processor. No account, no cost, nothing sent anywhere. It reads each answer's
>   **language, market** (country, currency), **what it asks**, the stage and who it is for,
>   and labels each brand the rules found — brand, product, store, publisher, institution —
>   with its **owner** and **how the answer treats it**, quoting the answer; it also lists
>   names the rules missed. Every claim is checked against the answer before it is kept, and
>   what isn't backed is left out and counted. Analyze has a new **AI check** section; the
>   Dashboard filters by language and market. Your counts never change unless you turn on
>   "Let the AI correct brands in counts". Checks are kept, so Reprocess doesn't run the model
>   again. Brand names in any script (Japanese, Hindi, Arabic, Thai…) are now matched, and
>   Gemini Nano's extra names no longer change the counts silently.
> - **For any brand, anywhere** (0.69.0). Prices are read in any currency, before or after the
>   number ($, €, £, ¥, ₹, R$, kr, zł, CHF, AED, ₩ and more), and shown in their own currency in
>   the reports and the workbook (a new Currency column); averages never mix currencies. Topics
>   without tags are grouped by what the prompt asks for (Comparisons & alternatives, Local & near
>   me, Price, cost & value, Trust, safety & compliance, Jobs & careers, How-to & information, For
>   a person or use, Best, top & reviews), in several languages, so B2B, services and public-sector
>   prompts no longer all land in "Other". Shops, marketplaces and review sites from many more
>   countries are known, and a new site group, **Public & reference**, holds government and public
>   bodies, universities, research, encyclopedias and analyst firms. Country and currency names are
>   never taken for brands.
> - **Signed-out ChatGPT and Gemini fixes** (0.69.0). Signed-out ChatGPT answers (its
>   `unauth-mweb` stream) are captured. A Gemini hand-over made mid-search, with no answer yet, no
>   longer finishes the turn. Gemini answers say whether you were signed in (this needs the new
>   `google.com` site access, where Google keeps its sign-in). A card whose large title is only a
>   price is named by the product, and its store is kept. Private-window runs leave Grok out and
>   say so (Grok sends nothing signed out). Debug capture no longer keeps Gemini replies the reader
>   already reads.
> - **Dashboard filters, laid out** (0.68.1). The filters are four labelled rows (Look in,
>   Engines, When, Show) instead of one run of chips that wrapped anywhere, with one style for
>   "on" and the duplicate caption gone.
> - **Dashboard: campaign prompts in their own block** (0.68.0). A campaign's prompts are grouped
>   under the campaign's name, after what you asked by hand (its five latest, with "Show all").
>   **Campaign prompts: Grouped · Left out · Only** shows the Dashboard with them, without them,
>   or only them, and is remembered. The same words asked by hand and by a campaign are now two
>   rows.
> - **Side by side, rebuilt** (0.68.0). Comparing engines on one prompt is tabs: Summary (how
>   far they agree, and each engine in numbers: answer kind and length, brands, mentions,
>   products, searches, `site:` searches, pages read and cited, ads), Brands (place, mentions or
>   share of mentions in each answer), Sources (kinds of site each engine cited, every cited page
>   in order, and the site grid with each site's kind), Products (cards matched across engines
>   with place and price), Searches and Ads. Long lists page.
> - **Campaign page as tabs** (0.67.0). A campaign's results are nine tabs (Overview, Brands,
>   Compare, Sources, Citations, Prompts, Products & topics, Searches & ads, Signals & data), one
>   shown at a time, instead of one long page; long lists page through 10–20 rows at a time.
>   Every prompt on the board opens its answer in Analyze, and Back (the page's, the browser's,
>   or the Campaigns tab) returns to the same tab, filters, page and scroll.
> - **Filters and comparison** (0.67.0). Filter by one, several or all engines; by tags, matching
>   any or all of the ones picked; and put **any brand in view**, yours or a rival's, so the whole
>   board measures it. **Compare** sets up to four brands beside the one in view, a column each,
>   with the best figure in every row marked: eight measures, engine by engine, topic by topic,
>   named together, prompt by prompt, product cards and how the answers word each brand.
> - **Gemini captured again** (0.66.0). Gemini now sends its answers over a different channel,
>   so 0.65.0 saw none of them and every Gemini prompt in a campaign timed out. This release
>   reads it: the answer, the pages under "Searched the web", and product cards with their store
>   and price.
> - **Pause capture** (0.66.0). A switch beside the logo, in the popup and the full tab. While
>   paused nothing from ChatGPT, Gemini, Perplexity or Grok is kept, and the toolbar icon says
>   "off". A campaign run you start still records its own tabs.
> - **Signed-out and private-window answers** (0.66.0). Answers asked in a private (Incognito)
>   window or while signed out are captured and marked so in Analyze; ChatGPT's signed-out
>   stream is read too. A campaign can **Run signed out**, in a new private window, for answers
>   without your account's history or memory. Allow CitoSkeleton in Incognito at
>   chrome://extensions first.
> - **Display settings** (0.65.0, planned as 0.63.0). About → Settings → Display: fifteen bundled
>   typefaces (Geist, IBM Plex Sans, Inter, Roboto, Open Sans, Lato, Source Sans 3, Noto Sans,
>   Nunito, Work Sans, Manrope, DM Sans, Atkinson Hyperlegible Next, Merriweather, Lora; all SIL
>   OFL, in `fonts/`), any Google Font by name, a code font, and sliders for text size,
>   brightness, contrast and line spacing, plus Comfortable / Compact density. It applies before
>   the first paint and in both the popup and the full tab. Only a Google Font makes a request
>   (to fonts.googleapis.com), and the setting says so.
> - **Campaign board, rebuilt** (0.64.0). A campaign's results open on the five headline numbers
>   (share of voice, visibility, average position, mentions, responses), each split by engine and
>   with the change since the run before, then: a brand leaderboard per engine; **you vs any rival**
>   on eight measures, engine by engine, topic by topic and prompt by prompt; sources; **every
>   citation in detail** (kind of page, its place in the answer, its rank in ChatGPT's results, how
>   old it is, whether both engines cited it), with search and filters; prompt rankings; products
>   and topics; **the searches the engines ran, `site:` searches and ads**; and signals about the
>   data itself (engine agreement, gaps, usage limits). Engines, brands and sites carry logos;
>   site icons come from Chrome's own favicon cache, so nothing is fetched. The workbook export
>   gains the same citation detail, `site:` columns and the ad shown with each answer.
> - **Campaigns while a run goes** (0.62.2). The page no longer jumps back to the top with each
>   capture: it holds still while the run goes, its progress keeps updating, and the results
>   are drawn once the run finishes or is stopped. The board only ever shows finished runs.
> - **ChatGPT prompts sent twice** (0.62.2). In a campaign, ChatGPT sometimes got the prompt
>   doubled ("Best gaming phones under 30000Best gaming phones under 30000"): its own pre-fill
>   landed on top of the typed prompt. The box is now checked before sending and the prompt
>   typed again. Answers already captured from a doubled prompt stay as they were asked.
> - **Grok in campaigns** (0.62.2). A Grok turn counts only once Grok has finished its answer;
>   before, a capture with just the search results ended the turn and no answer was kept. When
>   Grok says the account hit its usage limit, its prompts pause on a cooldown instead of
>   being logged as answered.
> - **Gemini** (0.62.2): its answers now travel over a Google WebChannel carrying protobuf. The
>   extension reads the prompt out of it and keeps the stream (Debug capture on) for the
>   reader that comes next.
> - **No more phantom prompts** (0.62.1). Reopening a Grok conversation stored its answer again
>   as a new one, under a prompt nobody asked ("Youbest good quality…": Grok's hidden "You"
>   label glued to the question). The page reader now runs only after a prompt was sent from
>   that page, and a copy of an answer joins its first capture however late it arrives. On
>   updating, stored duplicates are folded in once, automatically.
> - **What opening a ChatGPT card loads** (0.62.1). Open a product card on ChatGPT and
>   "Products and where to buy" shows each store with its price, stock and delivery and
>   ChatGPT's tag ("Best price"), why ChatGPT recommends it, what reviews say (theme,
>   sentiment, source) and the pages behind that panel. If ChatGPT's lookup returned
>   something else (a case instead of the earbuds) it says so. The follow-up form's choices
>   are kept too. Card prices and stores that ChatGPT binds by name are filled in, and a card
>   and its shopping listing are one product, not two.
> - **"Where it came from" says only what was checked** (0.62.1). A brand no cited page names
>   reads "Not in what the engine sent" until the pages themselves are read (with the button
>   right there), then "No cited page names it". Each brand lists its products and the pages
>   naming each; the Products table links to it.
> - Junk brands are gone ("Up", "IP55", "AI", "Dual-driver", "Buy", "Choose", "Save").
>   Perplexity's typeahead and notifications are no longer stored as captures; a page it
>   opened directly is shown as opened, not as a search. "Searches it ran" always says
>   whether any search was limited with site:.
> - The list of sections folds to a strip of icons and opens on hover; pin it to keep it open.
>   "Which page backs each part" is in Details.
> - **Gemini** (0.62.1): Gemini no longer sends the request CitoSkeleton reads, so nothing is
>   captured yet. With Debug capture on, what it sends now is kept apart, and About → "Payloads
>   it couldn't read" saves it to send to the developer. The diagnostic report names each
>   Gemini call.
> - **Read the cited pages** (0.62.0, off until you turn it on in Settings). The extension
>   opens the pages an answer cited, and only those, reads their text on this computer
>   (Mozilla Readability, with a background tab for pages that need one) and checks which
>   brands each page really names. "Which sources name which brands" then says, row by row,
>   whether it comes from the page text or from the title and snippet the engine sent. A
>   page behind a bot check says so. Pages are kept for 7 days.
> - **Where to buy, from the card you opened** (0.62.0). ChatGPT loads a product's stores
>   only when someone opens its card. After an answer, the extension now watches what the
>   ChatGPT page itself loads, and when a card is opened its stores, prices and links appear
>   under "Products and where to buy". The raw breakdown has a "Loaded after the answer"
>   section.
> - **Network recorder** (0.62.0, Debug capture only). Every request an engine page makes is
>   logged with ids masked, query values dropped and only the key names of replies, and
>   "Copy diagnostic report" lists them by engine. This is for finding why an engine stops
>   being captured.
> - Expert says plainly that ChatGPT hasn't sent which index served each page (labrador,
>   bright, oxylabs, serp) since 21 July 2026.
> - **ChatGPT's card answers look like ChatGPT's** (0.60.2). "The answer, as ChatGPT showed
>   it" now draws each card as ChatGPT does: picture on the left, its badge, the product
>   name, the spec line, the text with its source chips and the grey note. The follow-up
>   form shows each question with the choice ChatGPT had selected. Cards are named by their
>   product even when the large title is a spec ("Snapdragon 8 Gen 5"), and a price is found
>   wherever the card puts it. The same view is in the PDF and the HTML export.
> - The News chip only appears when ChatGPT actually showed a news block. The answer report no
>   longer says a brand is "easy to lose next time".
> - The raw payload breakdown keeps every value whole: every query, long values, and streamed
>   text put back together, with Show all and Copy.
> - **Images shown** is rebuilt: wider cards, pictures that fill their frame, the kind of site
>   as a dot and a word, and the page each picture came from.
> - Dashboard: "Ran for your prompt" shows every prompt in full, each one a link; a **Custom…**
>   period picks any span of days.
> - The top bar centres Analyze, Dashboard, Campaigns and About; Simple/Expert is one small
>   switch; Analyze no longer has a search box (the pager stays).
> - Studio and Classic now share one typeface (Geist) and one set of sizes; they differ in
>   colour and shape only.
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

### Other browsers (0.72.0)

| Browser | How | What differs |
|---|---|---|
| **Chrome, Edge, Brave, Opera, Vivaldi, Arc** (Windows, macOS, Linux, ChromeOS) | Load this folder unpacked, as above (Edge: `edge://extensions`, Brave: `brave://extensions`, Opera: `opera://extensions`) | Nothing. Gemini Nano exists only in Chrome; the built-in AI works in all of them. |
| **Firefox 128+** (Windows, macOS, Linux; Firefox for Android) | `node scripts/build-firefox.mjs`, then `about:debugging` → This Firefox → **Load Temporary Add-on** → `dist/firefox/manifest.json` | Runs as a background page: reading cited pages and the built-in AI run there. No tab groups for campaign tabs; site icons are letter badges. The built-in AI uses the graphics chip on Firefox 141+ (Windows) and 145+ (macOS); on Linux it runs on the processor (Light size). |
| **Safari 18+** (macOS; iOS/iPadOS) | On a Mac with Xcode: `node scripts/build-firefox.mjs`, then `xcrun safari-web-extension-converter dist/firefox --app-name CitoSkeleton`, open the generated project in Xcode, run it, and enable the extension in Safari → Settings → Extensions (allow unsigned extensions in the Develop menu while testing). Publishing needs an Apple developer account. | No notifications (the run's end shows in the panel instead), no tab groups, no private-window runs. Safari 26 has WebGPU for the built-in AI. Safari may clear storage of sites not visited for weeks, so export campaigns you want to keep. |

Chrome on Android and Safari before 18 don't run extensions like this one.

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

Everything stays in your browser's IndexedDB. The extension makes no network requests of its
own, except, if you turn on Read the cited pages, to the pages an answer cited (without your
cookies; that setting asks for access to all sites, and nothing is sent anywhere else). It
asks for host access to the supported engines only (ChatGPT, Gemini, Perplexity and Grok).
The built-in AI (Settings → Built-in AI, off until you click Download) fetches the model's
files once from huggingface.co into the browser's cache and runs them on this computer; the
answers it reads are never sent anywhere, and after the download it works offline.
If you pick a Google Font in Settings → Display, the page asks fonts.googleapis.com (and
fonts.gstatic.com) for that one font; the bundled typefaces load from the extension.
Site icons on the campaign board come from Chrome's own favicon cache (the "favicon"
permission); brand and engine marks are bundled (Simple Icons, CC0). Neither fetches anything.
The network recorder (Debug capture) keeps only hosts, masked paths, query key names and
reply key names, in session storage, cleared when the browser closes. Raw payloads are gzipped; storage is capped
(default 2,000 captures, 8 MB per payload) with oldest-first pruning. Clear everything from
the Dashboard at any time.

## Not built yet

Google AI Mode (the other real fan-out surface) ·
sentiment · trend charts (the series is computed and tested, just not drawn) · per-prompt
drill-down showing which prompts a brand is losing on.
