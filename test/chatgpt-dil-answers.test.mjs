/*
 * chatgpt-dil-answers.test.mjs — ChatGPT's generated-layout answers, and the
 * prompt as asked (1.0.0). From the owner's captures of 15 Nov 2026, the
 * question "best wireless headphone under 4000" signed in and signed out.
 *
 *   1. Signed in: headings 2, 3 and 4 of the answer read "### **2. **" and the
 *      products were stored under those names. The card's name is a binding
 *      ("value={turn700368product13.title}"); written back without quotes, the
 *      Entity's own name was lost. Only JBL was found of three makers.
 *   2. Signed out: no answer at all was read from 2.3 MB of data. The stream's
 *      `markdown` was empty in all 26 events and the answer was in `dil`
 *      (layout code), whose `fallbackMarkdown` is ChatGPT's own plain version.
 *      Also read: the product names in its data bindings, without the
 *      `image_group{…}` and chatgpt.com link text the second copy carries.
 *   3. The prompt "**top 3 phones under ₹30,000**": ChatGPT's request had the
 *      asterisks (a bold line pasted into its box arrives as markdown).
 *   4. Brands: a seller written as a website, "What's" from a follow-up
 *      question, and a maker whose product only a seller's card named.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { adapt } from "../src/adapters/chatgpt.js";
import { readGenUi } from "../src/lib/genui.js";
import { fallbackToMarkdown } from "../src/lib/chatgptSource.js";
import { cleanPrompt } from "../src/lib/promptText.js";
import { makeRecord } from "../src/schema.js";
import { detectBrands } from "../src/lib/brands.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const load = async (name, pageUrl) => {
  const lines = readFileSync(path.join(HERE, "fixtures", name), "utf8").split(/\r?\n/);
  const hdr = (k) => (lines.find((l) => l.startsWith(`# ${k}:`)) || "").replace(`# ${k}: `, "");
  return adapt({ captureId: name, raw: lines.filter((l) => !l.startsWith("# ")).join("\n"), reqBody: hdr("reqBody"), url: hdr("url"), pageUrl, capturedAt: Date.now() });
};
const names = (r) => (r.brandMentions || []).map((b) => b.brand);
const has = (r, re) => names(r).some((b) => re.test(b));

console.log("\n1. a card whose name is a binding");
{
  const code = `<box gap={3}>\n  <row align=start gap={3}>\n    <AsyncImage query="boAt Nirvana 751 ANC headphones" aspectRatio="1:1"/>\n    <box flex="1" gap={1}>\n      **2. <Entity ref="turn1product13" value={turn1product13.title}/>**\n      <badge color="success">Best ANC alternative</badge>\n      <title size="lg">{turn1product13.displayed_price}</title>\n      - Hybrid ANC\n    </box>\n  </row>\n</box>`;
  const bound = readGenUi(code, { bindings: { turn1product13: { title: "Boat Nirvana 751 ANC Premium Wireless Headphone", displayed_price: "₹3,499" } } });
  check("the bound name is the card's name", bound.cards[0] && bound.cards[0].name === "Boat Nirvana 751 ANC Premium Wireless Headphone", JSON.stringify(bound.cards.map((c) => c.name)));
  check("and its heading", /### Boat Nirvana 751 ANC Premium Wireless Headphone/.test(bound.markdown), bound.markdown.slice(0, 80));
  const missing = readGenUi(code, { bindings: {} });
  check("a name that never came is the image's caption, never \"**2. **\"", missing.cards[0] && /Nirvana/.test(missing.cards[0].name) && !/\*\*/.test(missing.cards[0].name), JSON.stringify(missing.cards.map((c) => c.name)));
}
{
  const r = await load("chatgpt-genui-headphones.txt", "https://chatgpt.com/c/6af944eb-7f58-83e8-9321-f43b5fb9a5b0");
  check("signed in: the prompt", r.userPrompt === "best wireless headphone under 4000", JSON.stringify(r.userPrompt));
  check("no heading or product named \"**2. **\"", !/\*\*\d+\. \*\*/.test(r.answerText) && !(r.products || []).some((p) => /^\*\*/.test(p.name)), (r.products || []).map((p) => p.name).join(" | "));
  check("every card has its name in the answer", /### boAt Rockerz 551/.test(r.answerText) && /### Realme TechLife Studio H1/.test(r.answerText) && /### Boat Nirvana 751/.test(r.answerText), r.answerText.split("\n").filter((l) => /^###/.test(l)).join(" | "));
  check("three makers found, not only JBL", has(r, /^JBL$/) && has(r, /^bo?at$/i) && has(r, /^realme$/i), names(r).join(", "));
}

console.log("\n2. signed out: the answer is in `dil`");
{
  const r = await load("chatgpt-signed-out-dil.txt", "https://chatgpt.com/");
  check("an answer is read at all", r.answerChars > 800, String(r.answerChars));
  check("the prompt", r.userPrompt === "best wireless headphone under 4000", JSON.stringify(r.userPrompt));
  check("its products by name", /realme TechLife Studio H1/.test(r.answerText) && /JBL Tune 520BT/.test(r.answerText) && /Boat Nirvana 751/.test(r.answerText) && /JBL Tune 510BT/.test(r.answerText));
  check("no layout directive or chatgpt.com link text in it", !/image_group|hints=search|urlCheck/.test(r.answerText), r.answerText.slice(0, 200));
  check("prices written once (₹3,999, not ₹₹3,999)", /₹3,999/.test(r.answerText) && !/₹₹/.test(r.answerText));
  check("four products, none cut short next to its full name", (r.products || []).length === 4 && !(r.products || []).some((p) => /…$/.test(p.name)), (r.products || []).map((p) => p.name).join(" | "));
  check("brands: realme, JBL, Boat", has(r, /^realme$/i) && has(r, /^JBL$/) && has(r, /^boat/i), names(r).join(", "));
  check("not: chatgpt, What's, a seller's website", !has(r, /chatgpt|^what/i) && !has(r, /\.com$/), names(r).join(", "));
  check("marked as read from the signed-out stream", r.platformSpecific && r.platformSpecific.signedOut === true);
  // A product card's click payload (query: "JBL Tune 520BT") and a product's
  // own data (query: "deprecated") are not searches ChatGPT ran.
  check("no product name or \"deprecated\" listed as a search", !(r.fanout.search || []).some((q) => /deprecated|JBL|realme|Boat/i.test(q.query)), JSON.stringify(r.fanout.search));
}
check("ChatGPT's escapes and doubled currency are undone", fallbackToMarkdown("**1\\. Which?**\n\nAudio\\, 40mm\n\n## ₹₹3,999") === "**1. Which?**\n\nAudio, 40mm\n\n## ₹3,999", JSON.stringify(fallbackToMarkdown("**1\\. Which?**\n\nAudio\\, 40mm\n\n## ₹₹3,999")));

console.log("\n3. the prompt as asked");
{
  check("a bold line pasted into ChatGPT", cleanPrompt("**top 3 phones under ₹30,000**") === "top 3 phones under ₹30,000");
  check("italic, underscore and code too", cleanPrompt("*why is the sky blue*") === "why is the sky blue" && cleanPrompt("__best phone__") === "best phone" && cleanPrompt("`x`") === "x");
  check("a question with its own asterisks is left alone", cleanPrompt("what is 2*3*4") === "what is 2*3*4" && cleanPrompt("what is *args") === "what is *args" && cleanPrompt("**a** and **b**") === "**a** and **b**");
  check("every engine's record gets it", makeRecord({ userPrompt: "**top 3 phones under ₹30,000**" }).userPrompt === "top 3 phones under ₹30,000" && makeRecord({ userPrompt: "plain" }).userPrompt === "plain" && makeRecord({}).userPrompt === null);
}

console.log("\n4. brands");
{
  const t = "### Best picks\n\nHere's what I'd shortlist.\n\n**1. What's most important to you?**";
  check("a contraction of a noise word is not a brand", !detectBrands(t, t, {}).brands.some((b) => /^(what|here)/i.test(b.brand)), detectBrands(t, t, {}).brands.map((b) => b.brand).join(", "));
  const answer = "The **boAt Rockerz 551 ANC Pro** is a good pick, also sold by EMI Snapmint.";
  const b = detectBrands(answer, answer, { products: [{ name: "boAt Rockerz 551 ANC Pro Bluetooth Headphone", merchant: "boat-lifestyle.com + others" }, { name: "Realme TechLife Studio H1", merchant: "Scoffco + others" }] }).brands.map((x) => x.brand);
  check("a seller's website is not a brand, the maker in the product's name is", !b.some((x) => /\.com/.test(x)) && b.some((x) => /^boat$/i.test(x)) && b.includes("Realme"), b.join(", "));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
