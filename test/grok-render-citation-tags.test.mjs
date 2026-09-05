/*
 * grok-render-citation-tags.test.mjs — Grok's own inline-citation markup
 * never leaks into the answer text (and from there, the exported PDF/HTML)
 * as literal, visible tags.
 *
 * Real bug, reported from a real capture (fixtures/grok-cameraPhoneRenderTags.txt,
 * "best camera phone under 80000"): the exported PDF showed things like
 *
 *   ...best camera phone under ₹80,000 in India right now.<grok:render
 *   card_id="3a8177" card_type="citation_card"
 *   type="render_inline_citation"><argument name="citation_id">4</argument>
 *   </grok:render>
 *
 * verbatim, reading as garbled "code" in the middle of ordinary sentences —
 * text that was never part of the real, visible Grok answer (the real UI
 * renders this tag as a small citation pill). Nothing in the codebase
 * converted or stripped this shape before it reached answerText.
 *
 * Fixed by converting <grok:render card_id="…">…</grok:render> into the
 * same [[cite:URL]] marker Perplexity's DOM harvester already writes —
 * card_id resolves through cardAttachmentsJson (the same objects
 * extractSources already parses for the sources list); citation_id is a
 * fallback 0-based index into webSearchResults. exportDoc.js then reuses
 * its existing Perplexity renderer for Grok too, since the marker shape is
 * now identical.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/grok.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(new URL("./fixtures/grok-cameraPhoneRenderTags.txt", import.meta.url), "utf8");
const json = raw.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();

console.log("\ngrok-render-citation-tags: <grok:render> tags never survive into answerText");

const rec = await adapt({
  captureId: "test-grok-camera-phone",
  raw: json,
  reqBody: JSON.stringify({ responseIds: ["846781c7-4c90-43aa-a742-c8f66f469f91"] }),
  capturedAt: Date.now(),
  pageUrl: "https://grok.com",
});

check("no raw <grok:render tag survives in answerText", !/<grok:render\b/.test(rec.answerText), rec.answerText.slice(0, 300));
check("no dangling </grok:render> close tag survives either", !/<\/grok:render>/.test(rec.answerText));
check("no <argument> fragment survives", !/<argument\b/.test(rec.answerText));

// The real prose around the tags must survive completely untouched.
check("real prose before the first citation survives",
  rec.answerText.includes("is the best camera phone under ₹80,000 in India"), rec.answerText.slice(0, 200));
check("real prose after a citation survives",
  rec.answerText.includes("Multiple expert tests"), rec.answerText.slice(0, 400));

// The tags are converted to the SAME marker Perplexity uses, resolved to
// the real cited URL via cardAttachmentsJson (card_id "3a8177" -> this URL,
// per the real capture).
check("converted to a [[cite:URL]] marker with the real resolved URL",
  rec.answerText.includes("[[cite:https://www.91mobiles.com/reviews/best-camera-smartphones-under-rs-80000-2025/]]"),
  rec.answerText.slice(0, 300));

// Sources themselves must be completely unaffected — this fix touches only
// the answer text, never the parsed sources list.
check("sources are still extracted", rec.sources.length > 0, String(rec.sources.length));
check("the cited 91mobiles review is a real source",
  rec.sources.some((s) => s.url === "https://www.91mobiles.com/reviews/best-camera-smartphones-under-rs-80000-2025/"));

// Brand detection must not see the raw marker text (same class of bug as
// Perplexity's cited-domain self-match) — real brands from the "Strong
// alternatives" table must still come through fine. (Vivo itself is a
// separate, pre-existing gap: its only mentions are inside an over-40-char
// bolded opening sentence and a "Why the Vivo X300..." heading whose
// leading word isn't the brand — unrelated to citation markers, not fixed
// here.)
const brandNames = rec.brandMentions.map((b) => b.brand.toLowerCase());
for (const real of ["oppo", "realme", "oneplus", "google"]) {
  check(`real brand "${real}" is still detected`, brandNames.some((n) => n.includes(real)), brandNames.join(", "));
}
check("no stray tag fragment (e.g. \"argument\") reached brand detection",
  !brandNames.some((n) => /argument|render|citation/i.test(n)), brandNames.join(", "));
check("\"Setup\" (a spec-sheet row label) is not reported as a brand",
  !brandNames.includes("setup"), brandNames.join(", "));

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
