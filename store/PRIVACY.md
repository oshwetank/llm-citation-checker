# CitoSkeleton privacy policy

_Last updated: 12 November 2026 · applies to version 1.0.0_

CitoSkeleton is a browser extension that shows how AI answer engines (ChatGPT, Gemini, Perplexity and Grok) answer questions: the searches they run, the pages they read and cite, and the brands they name. This policy says what it handles, where that goes, and what you control.

## The short version

Everything CitoSkeleton captures stays in your browser, on your computer. There is no account, no tracking and no analytics. CitoSkeleton does not sell, share or send your data to anyone.

## What CitoSkeleton handles

- **Answers from AI engines.** When you use ChatGPT, Gemini, Perplexity or Grok, CitoSkeleton reads the answer your browser receives on those sites: the prompt you asked, the answer text, the sources and searches in it, and the brands named. It reads nothing on any other site.
- **Your campaigns.** The brand, competitors, prompts and settings you enter.
- **Whether you're signed in to an engine.** Before a campaign runs, CitoSkeleton checks that a sign-in cookie exists for each engine, so a run doesn't type prompts into a login page. It never stores or sends the cookie's value.
- **Your email address, only if you give it** for news about updates. In version 1.0.0 it is kept on your computer; nothing is sent while accounts are switched off. You can remove it in About → Settings.

## Where it is kept

In your browser's own storage on your computer (IndexedDB and extension storage). It is not uploaded anywhere. Uninstalling CitoSkeleton deletes all of it, and About → Data & tools lets you export or delete it at any time.

## When CitoSkeleton connects to the internet

CitoSkeleton makes no network requests of its own, except in these cases:

- **A ChatGPT question you just asked:** once ChatGPT has answered a question you asked in a tab, CitoSkeleton reads that one conversation from chatgpt.com, from that tab, the same way ChatGPT's own page loads it to show it to you: with the cookies your browser already sends to chatgpt.com and the device and account identifiers ChatGPT's page sends. It asks for, reads and sends no sign-in token. This is how the answer is recorded when the page itself can't be read (for example when another extension takes over the page's connections). It reads only the conversation you just asked in, only until that answer is recorded, and the request goes to chatgpt.com and nowhere else. An old conversation you merely open is never read.

The rest happen only when you turn them on:

- **Read the cited pages** (off by default): it fetches the pages an answer cited, without your cookies, to see which brands they name. It skips addresses on your own computer or local network.
- **On-device AI** (off until you turn it on): it downloads the model's files once from huggingface.co. The model then runs on your computer; your captures are never sent.
- **A Google Font** (only if you pick one in Settings → Display): your browser asks fonts.googleapis.com for that font, and Google sees that request.
- **Campaign runs:** CitoSkeleton opens the AI sites in tabs in your browser and asks your prompts there, as you would yourself.
- **"Continue in…":** when you choose to send your data to another AI's chat, it is typed into that site's chat box, in a tab you see.

## Sharing

A campaign is shared only when you choose to: it is saved as a file you send yourself. CitoSkeleton has no server receiving data in version 1.0.0.

## Children

CitoSkeleton is not directed at children under 13 and does not knowingly collect their information.

## Changes

If this policy changes, the new version will be published at the same address with a new date, and noted in the extension's What's new.

## Contact

Questions about privacy: use the contact details on the CitoSkeleton store listing, or the developer's site linked from the extension (About).
