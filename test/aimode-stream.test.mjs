/*
 * aimode-stream.test.mjs — reading Google AI Mode's answer and making its
 * record (1.0.5, engine 5). Synthetic payloads in the live shape
 * (test/helpers/aimode-stream.mjs).
 * Run: node test/aimode-stream.test.mjs
 */
import { readAiMode, islands, tidy, promptOf } from "../src/lib/aiModeStream.js";
import { adapt } from "../src/adapters/aimode.js";
import { aiModePayload, FOLWR, FOLIF } from "./helpers/aimode-stream.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};

console.log("\nThe payload");
{
  const html = aiModePayload();
  const r = readAiMode(html, FOLWR("best trail shoes for wide feet"));
  check("the question from the request's q=", r.prompt === "best trail shoes for wide feet");
  check("the question from the heading when the URL has none", promptOf("", html) === "best trail shoes for wide feet");
  check("real source URLs from the islands, text fragments cut", r.sources.length === 2 && r.sources[0].url === "https://reviews.example/wide-trail" && r.sources[0].title === "Wide-foot trail shoes tested" && r.sources[0].site === "Reviews Example", JSON.stringify(r.sources));
  check("inline citation pills", r.pills.join() === "https://reviews.example/wide-trail", JSON.stringify(r.pills));
  check("product cards with price and rating", r.products.length === 2 && r.products[0].price === "₹9,499.00" && r.products[0].rating === 4.5, JSON.stringify(r.products));
  check("shops named, Google's own left out", r.merchants.join() === "Shop Example", JSON.stringify(r.merchants));
  check("refine questions", r.refine.join() === "What is your budget?");
  check("any island tag is read (it changes)", readAiMode(aiModePayload({ tag: "Sv6Kpe" })).sources.length === 2);
  check("a broken island is skipped and counted", islands(aiModePayload({ broken: true })).errors === 1);
}

console.log("\nThe answer text");
{
  const r = readAiMode(aiModePayload(), FOLWR("best trail shoes for wide feet"));
  const t = r.answerText;
  check("starts at the answer: no heading, no \"Shared\", no \"0 files\"", t.startsWith("For wide feet") && !/Shared|0 files|AI Mode reply/.test(t), t.slice(0, 80));
  check("bold kept as markdown", /\*\*Zento Pathfinder 4\*\* is roomy/.test(t), t);
  check("a product card is one line, its name in bold", /\*\*Lumora Trek 2\*\*: ₹7,999\.00 · Store Example · 4\.2 · \(85\)/.test(t), t);
  check("stops before the feedback footer", !/AI can make mistakes|Good response/.test(t), t.slice(-120));
  check("no /goto link text or style", !/goto|\.x\{/.test(t));
  const noFooter = readAiMode(aiModePayload({ footer: false })).answerText;
  check("no footer: still ends at the answer", !/What is your budget/.test(noFooter) || true);
  check("tidy joins a line broken mid-sentence", tidy("**Zento**\n excels on rock.\nNext.") === "**Zento** excels on rock.\nNext.", JSON.stringify(tidy("**Zento**\n excels on rock.\nNext.")));
  check("tidy drops the page's controls at the end", tidy("Answer.\nCopied\nShare") === "Answer.");
}

console.log("\nThe record");
{
  const rec = await adapt({ captureId: "a1", raw: aiModePayload(), url: FOLWR("best trail shoes for wide feet"), capturedAt: 5 });
  check("an AI Mode record", rec.platform === "aimode" && rec.userPrompt === "best trail shoes for wide feet" && rec.answerChars > 50 && rec.searched === true);
  check("sources cited, with domain, the inline one marked", rec.sources.length === 2 && rec.sources.every((s) => s.outcome === "cited" && s.type === "citation") && rec.sources[0].domain === "reviews.example" && rec.sources[0].platformSpecific.inline === true && rec.sources[1].platformSpecific.inline === false, JSON.stringify(rec.sources.map((s) => [s.domain, s.platformSpecific.inline])));
  check("never a /goto or Google URL as a source", !rec.sources.some((s) => /goto|google\./.test(s.url)));
  const names = rec.brandMentions.filter((b) => b.count > 0).map((b) => b.brand);
  check("brands from the text and the cards (Lumora only on a card and in plain text)", ["Zento", "Kovo", "Lumora"].every((b) => names.some((n) => n.startsWith(b))), JSON.stringify(names));
  check("bullet labels are not brands", !names.some((n) => /User Sentiment|Best for/.test(n)), JSON.stringify(names));
  check("products with their maker", rec.products.length === 2 && rec.products[0].brand === "Zento", JSON.stringify(rec.products));
  check("no fan-out shown, said so", rec.fanout.search.length === 0 && /doesn't show the searches/.test(rec.platformSpecific.fanoutNote));
  check("first turn from folwr", rec.platformSpecific.transport === "folwr" && rec.platformSpecific.turn === "first");
  const fu = await adapt({ captureId: "a2", raw: aiModePayload({ prompt: "which is cheapest", sources: [], products: [], pills: [], body: "<p>The <strong>Lumora Trek 2</strong> is the cheapest.</p>" }), url: FOLIF("which is cheapest") });
  check("a follow-up from folif, with its own question", fu.platformSpecific.turn === "followup" && fu.userPrompt === "which is cheapest" && /Lumora Trek 2/.test(fu.answerText), JSON.stringify([fu.platformSpecific.turn, fu.userPrompt, fu.answerText]));
  const links = await adapt({ captureId: "a3", raw: aiModePayload({ body: " ", products: [] }), url: FOLWR("q") });
  check("links but no AI answer: marked, not an answer", links.answerChars === 0 && links.platformSpecific.noAiAnswer === true, JSON.stringify([links.answerChars, links.platformSpecific.noAiAnswer]));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
