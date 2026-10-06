/*
 * chatgpt-ads.test.mjs — the sponsored card ChatGPT shows with an answer
 * (adapters/chatgpt.js extractAds, analyzeView.js adsView).
 *
 * Reported: "The chatgpt pushed an ad in the bottom, we should have a
 * section to show that and its data." The ad arrives as its own SSE event,
 * { type: "ads", content: { type: "single_advertiser_ad_unit", preamble,
 * advertiser_brand, ad_cards: [...] }, placement_name: "conversational_bottom" },
 * after the answer has finished; the adapter ignored it.
 *
 * test/fixtures/chatgpt-ad-event.json is a made-up ad in that event's shape
 * (advertiser "Phonekart", an .example address), added to the committed
 * phone answer. Fails on 0.56.0: no ads on the record.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { adapt } from "../src/adapters/chatgpt.js";
import { adsView } from "../src/lib/analyzeView.js";
import { answerReport } from "../src/lib/answerReport.js";
import { mergeAnswers } from "../src/lib/sameAnswer.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

function load(withAd, event = readFileSync(path.join(FIX, "chatgpt-ad-event.json"), "utf8").trim()) {
  const lines = readFileSync(path.join(FIX, "chatgpt-phone-under.txt"), "utf8").split(/\r?\n/);
  const reqBody = (lines.find((l) => l.startsWith("# reqBody: ")) || "").slice(11);
  let raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
  if (withAd) raw = raw.replace("data: [DONE]", `data: ${event}\n\ndata: [DONE]`);
  return adapt({ captureId: withAd ? "with-ad" : "no-ad", raw, reqBody, capturedAt: Date.UTC(2026, 9, 6, 18, 0), pageUrl: "https://chatgpt.com/c/test-ad" });
}

const rec = await load(true);
const plain = await load(false);

console.log("\nThe ad is read off the stream");
{
  const a = (rec.ads || [])[0] || {};
  check("one ad on the record", (rec.ads || []).length === 1, JSON.stringify(rec.ads));
  check("who advertised, and the label it carried", a.advertiser === "Phonekart" && a.advertiserUrl === "www.phonekart.example" && a.label === "Sponsored", JSON.stringify(a));
  check("ChatGPT's lead-in line", a.preamble === "For phones under 50,000, here's one store with current deals.", a.preamble);
  check("the card's title and text", a.title === "Phones under 50,000" && a.body === "Free delivery on today's top picks");
  check("where it sends people", a.targetUrl === "https://www.phonekart.example/deals/phones-under-50000?cip=123&oppref=gAAAAABTESTTOKEN" && a.targetDomain === "phonekart.example", `${a.targetUrl} ${a.targetDomain}`);
  check("where it sat, in words", a.placement === "Below the answer", a.placement);
  check("its format and unit", a.format === "image_card_v2" && a.unit === "single_advertiser_ad_unit");
  check("the card image (an https address)", a.imageUrl === "https://images.openai.com/static-rsc-5/test-ad-image");
  const json = JSON.stringify(rec.ads);
  check("no inline logo kept (data: URLs)", !/data:image/.test(json));
  check("no tracking tokens kept", !/ad_data_token|eyJwYXlsb2Fk|ads_spam_integrity|gAAAAABTESTSPAM/.test(json));
  check("one ad, though the event lists the card twice (ad_cards and carousel_cards)", rec.ads.length === 1);
}

console.log("\nThe answer itself is unchanged");
{
  check("same answer text", rec.answerText === plain.answerText);
  check("same pages", rec.sources.length === plain.sources.length);
  check("the advertiser is not counted as a brand the answer named", !rec.brandMentions.some((b) => /phonekart/i.test(b.brand)), rec.brandMentions.map((b) => b.brand).join(", "));
  check("an answer with no ad has an empty list", Array.isArray(plain.ads) && plain.ads.length === 0, JSON.stringify(plain.ads));
}

console.log("\nAn ad ChatGPT did not show is not recorded");
{
  const hidden = await load(true, JSON.stringify({ ...JSON.parse(readFileSync(path.join(FIX, "chatgpt-ad-event.json"), "utf8")), visibility: { status: "suppressed", reason: "test" } }));
  check("visibility other than 'allowed' leaves no ad", hidden.ads.length === 0, JSON.stringify(hidden.ads));
}

console.log("\nWhat ties the ad to the answer");
{
  const v = adsView(rec)[0] || {};
  check("not named in the answer, its site not opened", v.namedInAnswer === false && v.siteRead === 0, JSON.stringify(v));
  const named = adsView({ answerText: "Phonekart often has the best price.", sources: [{ domain: "phonekart.example", url: "https://phonekart.example/p", outcome: "cited" }], ads: rec.ads })[0];
  check("named in the answer and its site cited, when they are", named.namedInAnswer && named.siteRead === 1 && named.siteCited === 1, JSON.stringify(named));
  const word = adsView({ answerText: "Phonekarts everywhere.", ads: rec.ads })[0];
  check("a longer word containing the name is not the name", word.namedInAnswer === false);
}

console.log("\nThe answer report shows it");
{
  const m = answerReport(rec, {});
  check("a chip says there was an ad, and whose", m.chips.some((c) => c.text === "Ad · Phonekart"), m.chips.map((c) => c.text).join(" | "));
  check("the report carries the ad's details", m.ads.length === 1 && m.ads[0].url.startsWith("https://www.phonekart.example/") && m.ads[0].placement === "Below the answer", JSON.stringify(m.ads));
  check("no ad chip when there was none", !answerReport(plain, {}).chips.some((c) => /^Ad ·/.test(c.text)));
}

console.log("\nCopies of one answer keep its ad");
{
  const late = { ...plain, captureId: "late", capturedAt: rec.capturedAt + 3000, pageUrl: rec.pageUrl, ads: [] };
  const m = mergeAnswers([{ ...rec, pageUrl: "https://chatgpt.com/c/test-ad" }, late]);
  check("the merged record still has the ad", (m.ads || []).length === 1 && m.ads[0].advertiser === "Phonekart");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
