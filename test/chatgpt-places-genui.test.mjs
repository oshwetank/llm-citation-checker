/*
 * chatgpt-places-genui.test.mjs — the businesses in a generated-layout local
 * answer are places, and their first words are not brands (1.0.2).
 *
 * A live run on 22 Nov 2026 asked ChatGPT for dental clinics in Mumbai. The
 * answer was a generated layout: each clinic an <Entity ref="…businessN">,
 * its listing a component whose state reads { value, action_payload:
 * { category: "local_business" }, entity_data: { name, rating, … } }. The
 * reader looked for the category beside entity_data, so the record had no
 * places, and its brands were "Bombay", "Hi", "Om", "Dr" and "Clinic
 * locations". Names and numbers below are made up for this test.
 */
import { adapt } from "../src/adapters/chatgpt.js";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const clinic = (id, name, rating, reviews) => ({
  value: name,
  action_payload: { query: name, category: "local_business", extraParams: { location: "Lakeport", provider: "bright-feed" } },
  entity_data: { id, name, rating, review_count: reviews, address: "1 Harbour Road, Lakeport", provider: "bright-feed" },
});
const text = [
  "Here are well-reviewed clinics for a root canal in Lakeport.",
  "",
  "### Hi Tech Dental Clinic",
  "",
  "- Root canal and crown treatments.",
  "- Dr. Mira Sen is an endodontist.",
  "",
  "### Om Smile Dental Clinic",
  "",
  "- Re-root canal management.",
  "",
  "### The Root Canal Room",
  "",
  "- Single-sitting root canals.",
  "",
  "### Clinic locations",
  "",
  "All three are near the station.",
].join("\n");
const sse = [
  `data: ${JSON.stringify({ message: { id: "u1", author: { role: "user" }, content: { content_type: "text", parts: ["best dental clinics in Lakeport for a root canal"] }, metadata: {} }, conversation_id: "conv-1" })}`,
  "",
  `data: ${JSON.stringify({ message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [text] }, status: "finished_successfully", end_turn: true, recipient: "all", metadata: {} }, conversation_id: "conv-1" })}`,
  "",
  `data: ${JSON.stringify({ v: { "c-1": { status: "resolved", state: clinic("P1", "Hi Tech Dental Clinic Harbourside", 4.9, 1037) }, "c-2": { status: "resolved", state: clinic("P2", "Om Smile Dental Clinic", 4.8, 912) }, "c-3": { status: "resolved", state: clinic("P3", "The Root Canal Room", 5, 82) } } })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const rec = await adapt({ captureId: "p1", raw: sse, reqBody: null, url: "https://chatgpt.com/backend-api/f/conversation", capturedAt: 1, pageUrl: "https://chatgpt.com/c/conv-1" });

console.log("\nplace listings in a generated layout");
{
  const names = (rec.places || []).map((p) => p.name);
  check("each listed clinic is a place", ["Hi Tech Dental Clinic Harbourside", "Om Smile Dental Clinic", "The Root Canal Room"].every((n) => names.includes(n)), names.join(" | "));
  const p = (rec.places || []).find((x) => x.name === "The Root Canal Room") || {};
  check("with its rating and reviews", p.rating === 5 && p.reviews === 82, JSON.stringify(p));
}

console.log("\nbrands");
{
  // The same call the adapter makes with what it read (this hand-made stream
  // carries the listings, not ChatGPT's full message encoding).
  const b = detectBrands(text, text, { places: rec.places, prompt: "best dental clinics in Lakeport for a root canal" }).brands.map((x) => x.brand);
  check("no first-word fragment of a listed clinic", !b.some((x) => /^(Hi|Om)$/.test(x)), b.join(" | "));
  check("no honorific", !b.includes("Dr"), b.join(" | "));
  check("no \"Clinic locations\"", !b.includes("Clinic locations"), b.join(" | "));
  check("a name starting with \"The\" from a listing is kept", b.includes("The Root Canal Room"), b.join(" | "));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
