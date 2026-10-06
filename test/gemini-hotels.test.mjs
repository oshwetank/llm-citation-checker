/*
 * gemini-hotels.test.mjs — Gemini's Google Hotels card (adapters/gemini.js
 * collectHotels, stripCardPlaceholders).
 *
 * Reported on a real "budget hotels in <town> under 3000" answer: Gemini
 * showed five hotels in a Google Hotels card (photos, rating, reviews, price
 * a night, a link to each listing) after searching Google Hotels for the
 * town, dates and guests. The report said "From memory · no search", "No
 * map", "nothing opened", and the answer ended in a bare
 * "http://googleusercontent.com/hotel_content/<id>" line.
 *
 * test/fixtures/gemini-hotels.txt is a made-up answer in that capture's
 * shape. Fails on 0.56.0: no places, no search, the placeholder in the text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { adapt } from "../src/adapters/gemini.js";
import { answerKind, searchesView } from "../src/lib/analyzeView.js";
import { answerReport } from "../src/lib/answerReport.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const lines = readFileSync(path.join(HERE, "fixtures", "gemini-hotels.txt"), "utf8").split(/\r?\n/);
const reqBody = (lines.find((l) => l.startsWith("# reqBody: ")) || "").slice(11);
const raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
const rec = await adapt({ captureId: "gem-hotels", raw, reqBody, capturedAt: Date.UTC(2026, 9, 6, 19, 0), pageUrl: "https://gemini.google.com/app/0123456789abcdef" });

console.log("\nThe hotels on the card");
{
  const names = rec.places.map((p) => p.name);
  check("all five hotels are places", rec.places.length === 5, names.join(" | "));
  const p = rec.places.find((x) => x.name === "Hotel Pinecrest, By Aspenwood") || {};
  check("with rating and review count", p.rating === 4.1 && p.reviews === 1980, `${p.rating} ${p.reviews}`);
  check("its class as the kind, 'Hotel' when the card gives none", p.category === "3-star hotel" && (rec.places.find((x) => x.name === "Hotel Rock 'N' Pine") || {}).category === "Hotel");
  check("the price a night", p.priceRange === "₹1,540", p.priceRange);
  check("the link to its listing", /^https:\/\/www\.google\.com\/travel\/search\?q=Hotel\+Pinecrest/.test(p.listingUrl || ""), p.listingUrl);
  check("a photo", /^https:\/\/lh3\.googleusercontent\.com\//.test(p.image || ""));
  check("and the card's description when it has one", /rooftop cafe/.test((rec.places.find((x) => x.name === "Hotel Summit 9") || {}).description || ""));
  check("no shape-drift warning", rec._extraction.usedFallback === false, rec._extraction.notes.join("; "));
}

console.log("\nThe search behind it");
{
  const q = rec.fanout.search[0] || {};
  check("Gemini searched: not 'From memory'", rec.searched === true && answerKind(rec).id === "local", `${rec.searched} ${answerKind(rec).label}`);
  check("the Google Hotels search is listed", rec.fanout.search.length === 1 && q.query === "Budget hotels in Lakeport", JSON.stringify(rec.fanout.search));
  check("with its dates and guests", q.tool === "Google Hotels" && q.checkIn === "12 Nov" && q.checkOut === "13 Nov" && q.guests === "2 adults", JSON.stringify(q));
  const row = searchesView(rec).rows[0] || {};
  check("Analyze says which tool ran it, and for when", row.tag === "Google Hotels" && row.detail === "Google Hotels · 12 Nov – 13 Nov · 2 adults", JSON.stringify(row));
}

console.log("\nThe answer text");
{
  check("the card's placeholder address is gone", !/googleusercontent\.com\/hotel_content/.test(rec.answerText), rec.answerText.slice(-80));
  check("and the text before it is intact", /Open a hotel's name for today's price\.$/.test(rec.answerText), JSON.stringify(rec.answerText.slice(-60)));
  const card = (rec.platformSpecific.cards || [])[0] || {};
  check("where the card sat is kept", card.kind === "hotel" && card.at > 0 && card.at <= rec.answerText.length, JSON.stringify(rec.platformSpecific.cards));
  check("brands are still the hotels", ["Hotel Pinecrest, By Aspenwood", "Hotel Summit 9", "Bluebell Homestay Lakeport"].every((n) => rec.brandMentions.some((b) => b.brand === n)), rec.brandMentions.map((b) => b.brand).join(" | "));
}

console.log("\nThe answer report");
{
  const m = answerReport(rec, {});
  const chipText = m.chips.map((c) => c.text).join(" | ");
  check("says it searched, with one search", /Searched the web · 1 search/.test(chipText) && !/From memory/.test(chipText), chipText);
  check("shows the map of five places", /Map · 5 places/.test(chipText), chipText);
  check("its searches table carries the dates", m.searches.rows[0] && m.searches.rows[0].detail === "Google Hotels · 12 Nov – 13 Nov · 2 adults", JSON.stringify(m.searches.rows));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
