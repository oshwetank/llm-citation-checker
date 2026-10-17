/*
 * brands-local.test.mjs — brands in local answers (hotels, places to stay,
 * shops), where a table lists the businesses beside the AREA they are in.
 *
 * Reported on a real "budget hotels in <town> under 3000" run: "All the
 * brands which got mentioned in the llm answer did not appear in the brand
 * section, lot of location names were taken as the brand name." Three causes,
 * each reproduced here on made-up answers in the engines' shapes:
 *
 *   - ChatGPT's table was "Hotel | Approx. rate | Area | Why consider it".
 *     No header word the detector knew, so it picked the column the prose
 *     repeats most, and the prose says "mainly around Lowerside and Upper
 *     Bazaar": every neighbourhood became a brand, and the hotels written as
 *     plain text in the Hotel column were never considered.
 *   - Grok's was "Hotel / Stay | … | Location / Distance to lake | …": same
 *     thing, plus fragments of the location cells ("near", "Central").
 *   - Gemini bolds linked names, "**[Hotel Pinecrest](https://…)**": the
 *     link markup made each one an unreadable label, and "Hotel X" was cut
 *     to the bare word "Hotel".
 * And a cited site's name matched the plain word: "the booking
 * listings" counted as a mention of booking.com, "budget hotels" of
 * hotels.com.
 *
 * Fails on 0.56.0.
 */
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const names = (text, ctx) => detectBrands(text, text, ctx).brands.map((b) => b.brand);
const src = (domain, outcome = "cited") => ({ domain, url: `https://www.${domain}/x`, outcome });
const PLACES = ["Lowerside", "Upper Bazaar", "Ridge Road", "Upper Ridge Road", "Near Snow Point", "Mall", "near", "Central"];
const E = (id, name) => `\u{E200}entity\u{E202}["${id}","${name}"]\u{E201}`;

console.log("\nA ChatGPT hotel table with an Area column");
{
  const text = [
    "Lakeport has plenty of **budget stays under ₹3,000 a night**; most of what I found sits between **₹900 and ₹2,400**, mainly around Lowerside and Upper Bazaar.",
    "",
    "### Worth a look",
    "",
    "| Hotel | Approx. current rate | Area | Why consider it |",
    "|---|---:|---|---|",
    `| ${E("turn0business4", "Hotel Pinecrest")} | ~₹1,350 | Lowerside/Upper Bazaar | Short walk to Ridge Road |`,
    `| ${E("turn0business9", "Hotel Morning Mist")} | ~₹950 | Upper Bazaar | Cheapest of the hotels, close to the water |`,
    "| Hotel Lakeside View | ~₹1,450 | Lowerside | A few minutes from the lake |",
    "| Cedar Guest House | ~₹1,250 | Lowerside | Quiet, near Ridge Road |",
    "| Trekkers Hostel 12 | ~₹800 | Lowerside | Dorm beds; lowest price |",
    `| ${E("turn0business2", "Hotel Summit 9")} | ~₹1,700–2,100 | Ridge Road | Central |`,
    `| ${E("turn0business5", "Hilltop Stays (Snow Range)")} | ~₹2,200+ | Near Snow Point | Lively common areas |`,
    "",
    "Rates move with your dates; the booking listings I checked showed these for their own dates.",
    "",
    "**Quick picks:**",
    "- **Most central:** Hotel Summit 9 / Hotel Pinecrest",
    "- **Near Ridge Road and the lake:** Cedar Guest House",
  ].join("\n");
  const got = names(text, { prompt: "Budget hotels in Lakeport under 3000", sources: [src("booking.com", "fetched"), src("hotels.com", "fetched"), src("makemytrip.com")] });
  for (const h of ["Hotel Pinecrest", "Hotel Morning Mist", "Hotel Lakeside View", "Cedar Guest House", "Trekkers Hostel 12", "Hotel Summit 9"]) {
    check(`finds ${h}`, got.includes(h), got.join(" | "));
  }
  const junk = got.filter((n) => PLACES.some((p) => n === p || n.split("/").includes(p)));
  check("no neighbourhood or road is a brand", junk.length === 0, junk.join(" | "));
  check("'booking listings' is not a mention of booking.com", !got.some((n) => /^booking$/i.test(n)), got.join(" | "));
  check("a hostel keeps its number: not cut to 'Trekkers'", !got.includes("Trekkers"), got.join(" | "));
}

console.log("\nA Grok hotel table headed 'Hotel / Stay' with a Location column");
{
  const text = [
    "Lakeport has many budget hotels under ₹3,000 a night. Rates differ by site (book direct, or compare on MakeMyTrip, Goibibo, Booking.com or Trivago).",
    "",
    "| Hotel / Stay | Approx. Starting Price | Location / Distance to the lake | Highlights | Notes |",
    "|---|---|---|---|---|",
    "| Hotel Pine Inn | ₹1,650–2,000 | Ridge Road, ~250 m | Breakfast included | Good value |",
    "| Upper Bazaar Lake View Lodge | ₹1,400–1,800 | Upper Bazaar, near the jetty | Some lake views | Central and cheap |",
    "| Lowerside Budget Guesthouse | From ₹750 | Lowerside near bus stand | Simple rooms | Lowest prices |",
    "| Hotel Summit 9, Hotel Kestrel | Under ₹2,000 | Central / near Ridge Road | Basics covered | Frequently listed |",
    "",
    "Also worth a look: Hotel Happy Haven, and guesthouses in Lowerside under ₹3,000.",
  ].join("\n");
  const got = names(text, { prompt: "Budget hotels in Lakeport under 3000", sources: [src("makemytrip.com"), src("goibibo.com", "fetched"), src("booking.com", "fetched"), src("trivago.in", "fetched")] });
  check("finds the hotels in the Hotel / Stay column", ["Hotel Pine Inn", "Upper Bazaar Lake View Lodge"].every((h) => got.includes(h)), got.join(" | "));
  check("and the booking sites the prose names", ["MakeMyTrip", "Goibibo", "Trivago"].every((h) => got.includes(h)) && got.some((n) => /^Booking(\.com)?$/.test(n)), got.join(" | "));
  const junk = got.filter((n) => PLACES.includes(n));
  check("no location fragment is a brand ('Mall', 'near', 'Central', areas)", junk.length === 0, junk.join(" | "));
}

console.log("\nGemini's bold, linked hotel names");
{
  const link = (n) => `**[${n}](https://www.google.com/travel/search?q=${encodeURIComponent(n)}&qs=Mh123)**`;
  const text = [
    "A few well-rated hotels in Lakeport that stay under ₹3,000 a night:",
    "",
    `* ${link("Hotel Pinecrest, By Aspenwood")}`,
    "  * **Price:** About ₹1,540 a night",
    "  * **Rating:** 4.1 / 5 (1,900+ reviews)",
    "",
    `* ${link("Hotel Summit 9")}`,
    "  * **Price:** About ₹1,760 a night",
    "",
    `* ${link("Bluebell Homestay Lakeport")}`,
    "  * **Price:** About ₹1,690 a night",
    "",
    `* ${link("Hotel Rock 'N' Pine")}`,
    "  * **Price:** About ₹2,150 a night",
  ].join("\n");
  const got = names(text, { prompt: "Budget hotels in Lakeport under 3000" });
  for (const h of ["Hotel Pinecrest, By Aspenwood", "Hotel Summit 9", "Bluebell Homestay Lakeport", "Hotel Rock 'N' Pine"]) check(`finds ${h}`, got.includes(h), got.join(" | "));
  check("the bare word 'Hotel' is never a brand", !got.includes("Hotel"), got.join(" | "));
  check("no link text leaks into a name", !got.some((n) => /https?:|\]\(/.test(n)), got.join(" | "));
}

console.log("\nWhat already worked still works");
{
  const phones = [
    "| Phone | Price | Why |",
    "|---|---|---|",
    "| Vivo V70 | ₹34,999 | Camera |",
    "| Samsung Galaxy A57 | ₹39,999 | Display |",
    "",
    "The Vivo V70 has the better camera; the Samsung Galaxy A57 the brighter screen.",
  ].join("\n");
  const got = names(phones, { prompt: "best phone under 40000" });
  check("a phone table still yields the makers", got.includes("Vivo") && got.some((n) => /Samsung/.test(n)), got.join(" | "));
  const boat = names("The boAt Airdopes 141 is the cheapest pick; boAt's app is basic.", { sources: [src("boat-lifestyle.com")] });
  check("a cited brand written with odd capitals still counts (boAt)", boat.some((n) => /^boat/i.test(n)), boat.join(" | "));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
