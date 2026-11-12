# Chrome Web Store listing — CitoSkeleton 1.0.0

Everything the store's developer dashboard asks for, ready to paste. The
upload itself is `dist/citoskeleton-1.0.0-chrome.zip`, built with
`node scripts/build-store.mjs` (never a zip of the whole repository).

## Store listing tab

**Name** (from `_locales/*/messages.json`): CitoSkeleton

**Summary** (132 characters max; already in `_locales/en/messages.json`):
See what ChatGPT, Gemini, Perplexity and Grok search, fetch and cite — and which brands they name. Local-only, no account.

**Category:** Productivity → Tools (or Developer Tools; Productivity is where SEO/GEO tools are usually found)

**Language:** English (the interface also comes in Spanish, Portuguese (Brazil), French, Hindi and Arabic, marked beta)

**Description:**

> CitoSkeleton shows you what AI engines actually do behind an answer: the searches ChatGPT, Gemini, Perplexity and Grok run, the pages they read, the sources they cite, and which brands make it into the reply, and in what order.
>
> Everything happens in your own browser. CitoSkeleton reads the answers your browser already receives when you use these engines. It sends no request of its own, needs no account, and keeps your data on your computer.
>
> **Analyze one answer.** The answer as the engine showed it, beside the analysis: brands in the order they were named, the pages cited and the ones only read, the searches behind it, products, places and pictures. Put several engines side by side on the same prompt.
>
> **Find anything again.** Every prompt you've asked, on every engine, grouped by day and searchable, including the engines' own searches.
>
> **Track your brand with campaigns.** Set your brand, competitors, engines and prompts once. CitoSkeleton asks every prompt on every engine in tabs in your own browser, at a human pace, and shows share of voice, visibility, average position, the sites engines trust, each competitor head to head, and what changed since the last run. Each number says how many answers it rests on.
>
> **Ask your own data.** An optional AI model that runs on your computer answers questions about your captures and labels each answer's intent and audience. Nothing you capture is sent anywhere.
>
> **Share and export.** Excel workbooks, CSV, PDF reports, and a campaign file a colleague can open and run on their own computer.
>
> New to it? A short guide opens on install, a Get started checklist sits on the Dashboard, and About → Help & FAQ answers the common questions.
>
> Campaigns type prompts into the AI sites for you. Keep runs to a sensible size: each engine's own terms of use apply to your account.

**Screenshots** (1280×800, in `store/screenshots/`): `1-analyze.png`, `6-analyze-sources.png`, `2-dashboard.png`, `3-campaign-overview.png`, `4-campaign-compare.png`, `5-campaign-sources.png`, `7-help.png`. They use the extension's sample answer and test fixtures, which name real brands (boAt, Sony, Google, Samsung…). If you'd rather not show real brand names in a store listing, take new ones from a campaign of your own.

**Small promo tile** (440×280): not generated. The store needs one; the icon on a plain background works.

## Privacy practices tab

**Single purpose:**
Show users how AI answer engines (ChatGPT, Gemini, Perplexity, Grok) answer questions: the searches they run, the sources they read and cite, and the brands they name, and track a brand's visibility in those answers over time.

**Permission justifications:**

| Permission | Why |
|---|---|
| Host access: chatgpt.com, chat.openai.com, gemini.google.com, perplexity.ai, www.perplexity.ai, grok.com, x.com | The extension reads the answers these AI sites send to the user's browser, on those sites only, and types campaign prompts into them when the user runs a campaign. x.com is where Grok also runs. |
| Content scripts on those sites | Capture the answer stream as the page receives it (main world) and pass it to the extension (isolated world). |
| `storage`, `unlimitedStorage` | Captured answers and campaigns are stored locally in the browser; a campaign of several hundred answers, and the optional on-device AI model, exceed the default quota. |
| `tabs` | Open the AI sites in tabs to run a campaign's prompts, and find the user's open engine tabs to report whether capture works there. |
| `tabGroups` | Group a campaign run's tabs together so they don't mix with the user's own tabs. |
| `scripting` | Put the "Continue in…" message into the chosen AI site's chat box; and, only if the user turns on "Read the cited pages" and grants access to sites, read a cited page's text in a background tab. |
| `cookies` | Before a campaign starts, check that the user is signed in to each engine (whether a session cookie exists; the value is never stored or sent), so a run doesn't type every prompt into a login page. |
| `alarms` | Keep a long campaign run alive and resume it on schedule. |
| `notifications` | Tell the user when a campaign run ends or an engine's usage limit pauses it. |
| `offscreen` | Turn a cited page's HTML into text, and run the optional on-device AI model, outside the service worker. |
| `languageModel` | Use Chrome's own built-in AI (Gemini Nano) on devices that have it, instead of downloading a model. |
| `favicon` | Show site icons on the campaign board from Chrome's own favicon cache, with no network request. |
| Optional: access to all sites | Asked only when the user turns on "Read the cited pages", to read the text of pages an answer cited. Off by default. |
| `incognito: spanning` | Lets a campaign run signed out in a private window when the user chooses that (and allows the extension in incognito). |

**Remote code:** No. All code ships in the package. The optional on-device AI downloads model *weights* (data, not code) from huggingface.co, run by the ONNX runtime bundled in the package. An optional Google Font is a stylesheet and font file.

**Data usage** (what to tick):

- **Website content:** Yes. The text of AI answers, the sources and searches in them, from the AI sites listed above. Stored on the user's computer only.
- **Personally identifiable information:** Yes, only if the user chooses to give an email address for update news. With accounts off, as they are in 1.0.0, it stays on the user's computer.
- **Authentication information:** No. The sign-in check looks at whether a session cookie exists; its value is never read into storage or sent.
- Everything else (health, financial, location, personal communications, web history beyond the AI sites, user activity): No.

**Certify:** the data is not sold, not used or transferred for purposes unrelated to the single purpose, and not used to determine creditworthiness or for lending.

**Privacy policy URL:** host `store/PRIVACY.md` (or its text) at a public address, for example your site or the file's page on GitHub, and paste that address here.

## Before you press Submit

1. Build the zip with `node scripts/build-store.mjs` and upload `dist/citoskeleton-1.0.0-chrome.zip`.
2. Work through `store/MANUAL-TESTS.md` on a real machine with real accounts.
3. Keep accounts off (`src/lib/cloudConfig.js` empty) for this release.
