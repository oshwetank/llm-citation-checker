/*
 * promptText.js — the question as the person asked it (1.0.0).
 *
 * The owner's ChatGPT capture of 15 Nov 2026 stored the prompt as
 * "**top 3 phones under ₹30,000**". ChatGPT's own request had it that way:
 * text copied from a formatted page and pasted into ChatGPT's box arrives as
 * markdown, so a bold line becomes **…**. The asterisks are formatting, not
 * part of the question, and showed in every list and heading and kept the
 * same question from matching a campaign prompt typed without them.
 *
 * Only a question wrapped whole in one emphasis mark is unwrapped, and only
 * when nothing of that mark is inside it ("2*3*4" and "what is *args" are
 * left alone). No other character is touched.
 */
export function cleanPrompt(text) {
  if (typeof text !== "string") return text;
  let s = text.trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(\*{1,3}|_{1,3}|`)(?=\S)([\s\S]*?\S)\1$/.exec(s);
    if (!m) break;
    const mark = m[1][0];
    if (m[2].includes(mark)) break; // the mark is part of the question
    s = m[2].trim();
  }
  return s;
}
