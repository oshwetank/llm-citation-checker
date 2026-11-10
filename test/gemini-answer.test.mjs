/*
 * gemini-answer.test.mjs — the Gemini adapter must read the answer the model
 * actually wrote, and the prompt the user actually typed.
 *
 * Both cases are real, reported as "there are lots of issues with gemini"
 * against two live captures (cement, water heaters):
 *
 *   1. answerText was scraped product marketing copy, not the answer. The old
 *      extractor took "the longest markdown-ish string in the largest frame",
 *      which only works when the answer is the longest text present. A Gemini
 *      reply that renders shopping cards also carries each product's marketing
 *      blurb, and those are longer — so one capture's answerText was a V-Guard
 *      Luxecube advert and another's was ACC "Product Highlights" boilerplate.
 *      Every brand count and passage downstream was computed from text the
 *      model never wrote.
 *
 *   2. The prompt kept its wire escaping ("…utterpredesh\\n"), because the
 *      f.req payload is double-encoded. Prompt text is the key a campaign
 *      matches on, and the same prompt run on ChatGPT came back clean — so the
 *      two engines' rows could not line up.
 *
 * Synthetic payloads are used rather than a 1.4MB fixture: the point is the
 * shape (answer at a known slot, longer text elsewhere), and a minimal payload
 * states that far more clearly than a megabyte of real traffic.
 */
import { adapt } from "../src/adapters/gemini.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

// One StreamGenerate frame: a wrb.fr entry whose 3rd element is a
// double-encoded JSON string.
const frame = (payload) => JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]]);

// The answer lives at payload[4][0][1][0].
const withAnswer = (answer, extra = {}) => {
  const p = [null, null, null, null, [[null, [answer]]]];
  if (extra.filler) p[5] = extra.filler;
  return p;
};

const ANSWER =
  "When choosing the best water heater (geyser) for winter, the ideal model " +
  "depends on your **usage needs**.\n\n* **Storage Geysers (10L-25L):** Best for full baths.\n" +
  "* **Instant Geysers (3L-6L):** Best for quick sink use.";

// Longer than the answer, markdown-ish, and exactly the kind of scraped
// product copy that used to win.
const AD =
  "Luxecube, Hotter than Hot Water: If you have ever stood under a shower " +
  "waiting for the water to turn hot, dealt with inconsistent temperatures, " +
  "or had to replace a heater way too soon, you already know the pain.\n" +
  "- Presenting the Luxecube Avo Water Heaters, a masterpiece of luxury.\n".repeat(12);

console.log("\nthe answer comes from its own slot, not from whatever text is longest");
{
  const raw = [frame(withAnswer(ANSWER, { filler: AD }))].join("\n");
  const rec = await adapt({ captureId: "t1", raw, capturedAt: Date.now(), pageUrl: "https://gemini.google.com/app" });
  check("answerText is the model's answer", rec.answerText.startsWith("When choosing the best water heater"), JSON.stringify(rec.answerText.slice(0, 60)));
  check("the longer marketing blob did NOT win", !/Luxecube, Hotter than Hot Water/.test(rec.answerText));
  check("answerChars matches the answer, not the ad", rec.answerChars === ANSWER.length, `${rec.answerChars} vs ${ANSWER.length}`);
}

console.log("\nthe answer streams, so the longest value across frames is the finished one");
{
  const raw = [
    frame(withAnswer("When choosing the best")),
    frame(withAnswer("When choosing the best water heater (geyser)")),
    frame(withAnswer(ANSWER)),
    // A later frame can carry a shorter/partial value; it must not win.
    frame(withAnswer("When choosing")),
  ].join("\n");
  const rec = await adapt({ captureId: "t2", raw, capturedAt: Date.now(), pageUrl: "https://gemini.google.com/app" });
  check("the complete streamed answer is kept", rec.answerText === ANSWER, `len=${rec.answerText.length}`);
}

console.log("\nthe shape scan still covers a payload with no answer slot");
{
  // No [4][0][1][0] at all — a future reshuffle must degrade to the old
  // behaviour, not to an empty answer, and must say that it did.
  const p = [null, null, null, null, null];
  p[5] = AD;
  const rec = await adapt({ captureId: "t3", raw: frame(p), capturedAt: Date.now(), pageUrl: "https://gemini.google.com/app" });
  check("falls back rather than returning nothing", rec.answerText.length > 0);
  check("and records that it fell back",
    (rec._extraction.notes || []).some((n) => /stable slot missing/i.test(n)),
    JSON.stringify(rec._extraction.notes));
}

console.log("\nthe prompt is stored as typed, not as wire-escaped text");
{
  const promptRaw = "Best quality cement to buy for new home in utterpredesh\\\\n";
  const reqBody = "f.req=" + encodeURIComponent(`[null,"[[\\"${promptRaw}\\",0,null,null,null,null,0],[\\"en\\"]]"]`);
  const rec = await adapt({
    captureId: "t4", raw: frame(withAnswer(ANSWER)), reqBody,
    capturedAt: Date.now(), pageUrl: "https://gemini.google.com/app",
  });
  check("no escaped newline survives into the prompt",
    !/\\n/.test(rec.userPrompt), JSON.stringify(rec.userPrompt));
  check("the prompt reads exactly as typed",
    rec.userPrompt === "Best quality cement to buy for new home in utterpredesh",
    JSON.stringify(rec.userPrompt));
}

console.log("\nmodern Gemini grounding claims & Chrome text-fragment decoding");
{
  import("node:fs").then(async ({ readFileSync }) => {
    try {
      const raw = readFileSync("test/fixtures/gemini-streamgenerate.txt", "utf8");
      const rec = await adapt({
        captureId: "t5",
        raw,
        capturedAt: Date.now(),
        pageUrl: "https://gemini.google.com/app"
      });

      check("sources extracted from StreamGenerate fixture", rec.sources.length > 0);
      const textFragSource = rec.sources.find(s => s.platformSpecific && s.platformSpecific.exactPassage);
      check("exactPassage decoded from #:~:text= anchor", Boolean(textFragSource && textFragSource.platformSpecific.exactPassage.length > 5));

      const claims = rec.platformSpecific && rec.platformSpecific.groundingClaims;
      check("sentence grounding claims extracted into platformSpecific", Boolean(claims && claims.length > 0));
      if (claims && claims.length) {
        check("claim carries character offset tuple", Array.isArray(claims[0].offsets) && claims[0].offsets.length === 2);
        check("claim links to citation url", Boolean(claims[0].url && claims[0].url.startsWith("http")));
      }
    } catch (e) {
      check("failed to load fixture", false, e.message);
    }
  });
}

// Wait for any async fs promise
await new Promise(r => setTimeout(r, 100));

console.log("\na shopping card priced in pounds is kept (0.69.0: any currency, not only ₹ $ €)");
{
  const card = (name, price) => {
    const v = new Array(30).fill(null);
    v[1] = "https://www.google.com/search?q=" + encodeURIComponent(name) + "&prds=abc";
    v[10] = name; v[13] = price; v[16] = "4.5"; v[20] = name.split(" ")[0]; v[27] = "Lumi Store";
    return v;
  };
  const p = withAnswer(ANSWER);
  p[6] = [card("Lumi Kettle 2", "£49.99"), card("Kovo Toaster", "2.499 kr"), card("Zento Fan", "₩89,000")];
  const rec = await adapt({ raw: frame(p), pageUrl: "https://gemini.google.com/app", captureId: "g-gbp" });
  const names = (rec.products || []).map((x) => x.name + " " + x.price);
  check("£, kr and ₩ cards all read", names.length === 3 && names[0] === "Lumi Kettle 2 £49.99", JSON.stringify(names));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);

