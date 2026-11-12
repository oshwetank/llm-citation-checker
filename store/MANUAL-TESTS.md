# Manual tests before publishing 1.0.0

The automated suite (about 165 test files, run on every pull request) covers the code against recorded answers. What it cannot cover is the real sites, your real accounts, and real computers. Work through this list once, on the zip you will upload. Each step says what you should see. Tick it, or note what you saw instead.

Allow about 45 minutes. You need Chrome, and accounts on ChatGPT, Gemini (a Google account), Perplexity and Grok.

## 0. Install the zip

1. Unzip `citoskeleton-1.0.0-chrome.zip` into a new folder.
2. In `chrome://extensions`, switch on Developer mode, press **Load unpacked** and pick that folder.
3. You should see CitoSkeleton 1.0.0 with no errors on its card, and a **Welcome** tab opens once.

## 1. The update from 0.36 (most important)

Your users have 0.36 today. Test with a Chrome profile that has 0.36 installed from the store and some answers captured.

1. Note how many answers 0.36 shows.
2. Install 1.0.0 over it. The real test is the store's own update, so if you can, publish 1.0.0 as **unlisted**, or to trusted testers, first and let Chrome update it.
3. Check: **no "new permissions" prompt** appears, and the extension is not switched off.
4. The welcome guide opens on **"What's changed since your last version"**.
5. Your old answers are all in the Dashboard.

## 2. Capture on each engine, signed in

On each of ChatGPT, Gemini, Perplexity and Grok, ask a question that makes it search the web, for example "best running shoes for flat feet 2026".

- The answer appears in **Analyze** within a few seconds of finishing, with its brands, cited pages and searches.
- Do one question on each engine with **an image or a product card** in the answer, and check the cards appear.

## 3. Capture signed out and in a private window

1. Sign out of ChatGPT and ask a question. It should be captured, and Analyze should say it was asked signed out.
2. In `chrome://extensions` → CitoSkeleton → Details, allow **in Incognito**. Ask on Gemini in a private window. It should be captured.

## 4. A small campaign, start to finish

1. Campaigns → **Create your first campaign**: your brand, 2 competitors, all four engines.
2. In **Add manually**, type what you sell and press **Fill in examples**. You should get about 10 prompts. Keep 5.
3. **Save & start tracking**, then run it. Tabs open in a group, prompts are typed and sent at a human pace, and each answer is stored.
4. When it ends: a notification, and the results board shows numbers, a **"Based on N answers…"** line and a **What to do next** card. Each "Show me" button opens the right section.
5. Run it a second time. **Run vs run** shows the two runs side by side.

## 5. Reports and sharing

- Analyze → **Save as PDF**: a two-page report opens and prints.
- Dashboard → **Export**: the Excel file opens in Excel or Google Sheets, with no warnings about formulas.
- Campaigns → ⋯ → **Share campaign…**: a `.cito` file downloads. In another Chrome profile, Campaigns → **Import…** opens it with the same numbers.
- Open a saved HTML report from your Downloads folder. It shows the answer and pictures. Its links open normally.

## 6. The on-device AI (optional feature)

1. Ask → **Models on this computer** → turn on **Fast labels**. It downloads about 1.2 GB once.
2. Analyze an answer: the **AI check** section shows labels.
3. Turn it off: the model is removed.
4. On a **low-memory laptop (8 GB)**, the computer should stay usable during the download and labelling.

## 7. Languages

About → Settings → Language → **Español**, then **العربية**. Every tab reads in that language, Arabic reads right to left, and nothing overlaps. Switch back to the browser's language.

## 8. Other browsers and systems

Install the same zip and repeat steps 2 and 4 (one engine is enough) on:

- [ ] Windows, Chrome
- [ ] macOS, Chrome
- [ ] Microsoft Edge (Windows)
- [ ] Brave

## 9. Slow and broken connections

1. In Chrome DevTools → Network, choose **Slow 3G**. Ask a question: it should still be captured, only later.
2. Go **offline** mid-campaign. The run should report the failed turns and carry on, or pause, without crashing. Back online, **Retry missing** fills them in.

## 10. Store listing

- [ ] Privacy policy (`store/PRIVACY.md`) published at a public address and pasted into the dashboard
- [ ] Description, screenshots and promo tile uploaded (`store/LISTING.md`)
- [ ] Permission justifications and data-use answers filled in from `store/LISTING.md`

If everything above passes, upload the zip and submit for review.
