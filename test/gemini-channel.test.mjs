/*
 * gemini-channel.test.mjs — Gemini answers read from its WebChannel (0.66.0).
 *
 * Reported: "gemini … did not run". Gemini no longer sends StreamGenerate;
 * the answer comes down geminiweb-pa.clients6.google.com/v1/processSession as
 * base64 protobuf frames, and 0.65.0 only kept those as probes, so every
 * Gemini turn in a campaign timed out with "sent, no answer captured". The
 * frames here are made up in the shape mapped from the owner's probes
 * (test/helpers/gemini-channel.mjs).
 */
import { readGeminiChannel, channelPrompt, isChannelText, protoAt, channelPayloads } from "../src/lib/geminiChannel.js";
import { adapt } from "../src/adapters/gemini.js";
import { channelStream, uploadBody, responsePayload, ANSWER, SOURCES, PRODUCTS, RESPONSE, CONVERSATION } from "./helpers/gemini-channel.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "waterproof phone under 60000 in India";

console.log("\nthe frames");
{
  const raw = channelStream();
  check("WebChannel text is told apart from StreamGenerate", isChannelText(raw) && !isChannelText(")]}'\n\n123\n[[\"wrb.fr\"") && !isChannelText(""));
  check("noops are skipped; the status frame and the four answer frames are read", channelPayloads(raw).length === 5, String(channelPayloads(raw).length));
  const r = readGeminiChannel(raw);
  check("the last frame's answer is the whole answer", r && r.answer === ANSWER, r && r.answer.slice(-60));
  check("conversation and reply ids", r && r.conversationId === CONVERSATION && r.responseId === RESPONSE, JSON.stringify(r && [r.conversationId, r.responseId]));
  check("the pages under Searched the web, in order", r && JSON.stringify(r.sources.map((s) => s.url)) === JSON.stringify(SOURCES.map((s) => s.url)) && r.sources[1].title === SOURCES[1].title && r.searchLabels[0] === "Searched the web", JSON.stringify(r && r.sources));
  const p = r && r.products[0];
  check("product cards: name, price, brand, rating", p && p.name === "Zento X9 5G" && p.price === "₹49,999.00" && p.brand === "Zento" && p.rating === 4.6, JSON.stringify(p));
  check("with the store, its price, the old price and the address", p && p.merchant === "MegaMart" && p.offers.length === 1 && p.offers[0].originalPrice === "₹54,999.00" && p.offers[0].url === "https://megamart.example/p/zento-x9", JSON.stringify(p && p.offers));
  check("and its pictures", p && p.images[0] === "https://img.example/1.jpg", JSON.stringify(p && p.images));
  check("model, place and country", r && r.model === "3.6 Flash" && r.location === "Pune, Maharashtra, India" && r.country === "IN", JSON.stringify(r && [r.model, r.location, r.country]));
}

console.log("\na stream cut short, and two replies in one stream");
{
  const raw = channelStream();
  const cut = raw.slice(0, raw.length - 500);
  const r = readGeminiChannel(cut);
  check("a half-arrived last frame is skipped, the frame before it read", r && r.answer.length > 0 && r.answer.length < ANSWER.length && ANSWER.startsWith(r.answer), r && String(r.answer.length));
  const two = channelStream({ steps: 2 }) + channelStream({ steps: 2, firstId: 40, response: "r_second00000000", answer: "Lumi Note 4 is the one to buy." });
  const r2 = readGeminiChannel(two);
  check("the newest reply wins, even when shorter", r2 && r2.responseId === "r_second00000000" && r2.answer === "Lumi Note 4 is the one to buy.", JSON.stringify(r2 && [r2.responseId, r2.answer]));
  check("a frame with no answer reads as nothing", readGeminiChannel(`15\n[[10,["noop"]]]`) === null);
  check("protoAt follows repeated fields", protoAt(responsePayload(), "2.7.1.4.4.5.38.2.8").length === 3);
}

console.log("\nthe prompt");
{
  check("comes out of the upload", channelPrompt(uploadBody(PROMPT)) === PROMPT, channelPrompt(uploadBody(PROMPT)));
  check("and nothing out of an acknowledgement", channelPrompt("count=1&ofs=2&req0___data__=IgIIAQ%3D%3D") === null);
}

console.log("\nthe adapter");
{
  const rec = await adapt({ captureId: "g1", raw: channelStream(), reqBody: uploadBody(PROMPT), pageUrl: "https://gemini.google.com/app/0a1b2c3d4e5f6071", capturedAt: 1 }, { tracked: [{ name: "Zento" }, { name: "Kovo" }] });
  check("a Gemini record with the prompt", rec.platform === "gemini" && rec.userPrompt === PROMPT, rec.userPrompt);
  check("the answer without the card placeholders", rec.answerText.startsWith("For a **waterproof phone") && !/googleusercontent/.test(rec.answerText) && (rec.platformSpecific.cards || []).length === 2, rec.answerText.slice(-80));
  check("three cited sources", rec.sources.length === 3 && rec.sources.every((s) => s.outcome === "cited"), JSON.stringify(rec.sources.map((s) => [s.domain, s.outcome])));
  check("two products with their store", rec.products.length === 2 && rec.products[1].merchant === "CityPhones" && rec.products[0].offers[0].merchant === "MegaMart", JSON.stringify(rec.products.map((p) => p.name)));
  const brands = rec.brandMentions.map((b) => b.brand);
  check("brands named in the answer", brands.includes("Zento") && brands.includes("Kovo"), brands.join(", "));
  check("searched, shopping, the model and the reply id", rec.searched === true && rec.turnUseCase === "shopping" && rec.model === "Gemini 3.6 Flash" && rec.turnId === RESPONSE, JSON.stringify([rec.searched, rec.turnUseCase, rec.model, rec.turnId]));
  const fromUrl = await adapt({ captureId: "g2", raw: channelStream(), reqBody: "", pageUrl: `https://gemini.google.com/app?q=${encodeURIComponent(PROMPT)}`, capturedAt: 1 });
  check("with no upload seen, the prompt comes from the page's ?q=", fromUrl.userPrompt === PROMPT, fromUrl.userPrompt);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
