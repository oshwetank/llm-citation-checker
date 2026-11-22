/*
 * gemini-places.test.mjs — the businesses on Gemini's map cards are places,
 * and its section headings are not brands (1.0.2).
 *
 * A live run on 22 Nov 2026 asked Gemini for coworking spaces in Bangalore.
 * The answer showed a map and eight place cards with ratings; the record had
 * no places, was not marked as searched, and its brand list was the section
 * headings "Startup & Community-Focused" and "Design-Forward &". The cards
 * were read since 0.84 (platformSpecific.cards) but never became places.
 * The answer below is written for this test in that shape.
 */
import { adapt, stripCardPlaceholders } from "../src/adapters/gemini.js";
import { channelStream, uploadBody } from "./helpers/gemini-channel.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const answer = [
  "Lakeport's coworking scene is spread across a few hubs, each suited to a different stage.",
  "",
  "### Startup & Community-Focused Hubs",
  "",
  '<EntityCard entity_id="p1" entity_type="place" title="Hivebase, Harbour Road"/>',
  "[Hivebase, Harbour Road](_link) is a long-standing hub for founders.",
  "",
  "<Carousel>",
  '  <UgcReview entity_id="p1" review_id="r1" review_type="place"/>',
  '  <UgcReview entity_id="p1" review_id="r2" review_type="place"/>',
  "</Carousel>",
  "",
  '<EntityCard entity_id="p2" entity_type="place" title="Nestwork Old Town"/>',
  "[Nestwork Old Town](_link) runs community events every week.",
  "",
  "### Design-Forward & Client-Facing Spaces",
  "",
  '<EntityCard entity_id="p3" entity_type="place" title="Loftly Studios"/>',
  "[Loftly Studios](_link) suits teams that meet clients.",
  "",
  '<FollowUp label="Want a cost comparison?" query="Compare day-pass prices for these spaces."/>',
].join("\n");

const rec = await adapt({
  captureId: "g1",
  raw: channelStream({ answer, steps: 1 }),
  reqBody: uploadBody("top coworking spaces in Lakeport for startups"),
  url: "https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&RID=rpc&SID=abc&TYPE=xmlhttp",
  capturedAt: 1,
  pageUrl: "https://gemini.google.com/app/abc",
});

console.log("\nmap cards");
{
  const names = (rec.places || []).map((p) => p.name);
  check("each place card is a place", ["Hivebase, Harbour Road", "Nestwork Old Town", "Loftly Studios"].every((n) => names.includes(n)), names.join(" | "));
  check("and means Gemini searched", rec.searched === true, String(rec.searched));
  check("a local answer", rec.turnUseCase === "local", rec.turnUseCase);
}

console.log("\nlayout tags");
{
  check("no review carousel or follow-up left in the answer text", !/<\/?(?:Carousel|UgcReview|FollowUp)\b/.test(rec.answerText), rec.answerText.slice(-200));
  check("the carousel is kept as a card", (rec.platformSpecific.cards || []).some((c) => c.kind === "reviews" && c.count === 2), JSON.stringify(rec.platformSpecific.cards));
}

console.log("\nbrands");
{
  const b = (rec.brandMentions || []).map((x) => x.brand);
  check("the places are the brands", b.includes("Loftly Studios") && b.some((x) => /^Hivebase/.test(x)), b.join(" | "));
  check("no section heading is a brand", !b.some((x) => /Focused|Forward|Facing/.test(x)), b.join(" | "));
}

console.log("\na place's rating and kind, from the stream (1.0.2)");
{
  // Live run, 22 Nov 2026: a Jaipur hotel answer's six places were stored by
  // name only, while the stream carried "4.7 stars rating" and "🏨 Resort
  // hotel" before each "places/<id>", then its phone, address, links, a
  // description and its reviews. A protobuf message with one text field per
  // piece, in the order the stream sends them, in its own WebChannel frame.
  const pieces = [
    "https://lh3.googleusercontent.com/gps-cs-s/AbCdEf123=w1500-h1000-k-no",
    "Hivebase, Harbour Road", "4.7", "4.7 stars rating", "☕ Coworking space", "places/p1",
    "0141 667 1234", "12 Harbour Rd, Old Town, Lakeport 400001",
    "https://www.google.com/maps/place//data=!4m2!3m1!19sp1", "https://hivebase.example/",
    "Open 24 hours", "Busy founder hub with private cabins, a podcast room & weekly demo nights.",
    "places/p1/reviews/r1", "3 years ago", "Great community and fast Wi-Fi; the events helped us find our first customers.",
  ];
  const vint = (n) => { const out = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
  const msg = Buffer.concat(pieces.map((s) => { const t = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([0x0a, ...vint(t.length)]), t]); }));
  const b64 = msg.toString("base64");
  const frame = JSON.stringify([[99, [b64]]]);
  const withPlace = await adapt({
    captureId: "g2",
    raw: channelStream({ answer, steps: 1 }) + `${frame.length}\n${frame}`,
    reqBody: uploadBody("top coworking spaces in Lakeport for startups"),
    url: "https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&RID=rpc&SID=abc&TYPE=xmlhttp",
    capturedAt: 1,
    pageUrl: "https://gemini.google.com/app/abc",
  });
  const p = (withPlace.places || []).find((x) => x.name === "Hivebase, Harbour Road") || {};
  check("its rating", p.rating === 4.7, JSON.stringify(p));
  check("its kind", p.category === "Coworking space", JSON.stringify(p));
  check("its phone and address", p.phone === "0141 667 1234" && p.address === "12 Harbour Rd, Old Town, Lakeport 400001", JSON.stringify(p));
  check("its website and Maps link", p.website === "https://hivebase.example/" && /maps\/place/.test(p.mapsUrl || ""), JSON.stringify(p));
  check("its hours", p.hours === "Open 24 hours", JSON.stringify(p));
  check("its photo", /googleusercontent\.com\/gps-cs-s\//.test(p.image || ""), JSON.stringify(p));
  check("its description", /^Busy founder hub/.test(p.description || ""), JSON.stringify(p));
  check("its review, with its age", (p.reviewQuotes || [])[0] && /^Great community/.test(p.reviewQuotes[0].text) && p.reviewQuotes[0].age === "3 years ago", JSON.stringify(p.reviewQuotes));
  const q = (withPlace.places || []).find((x) => x.name === "Loftly Studios") || {};
  check("a place the stream says nothing more about keeps just its name", q.rating === undefined && q.category === undefined, JSON.stringify(q));
}

console.log("\na comparison table (1.0.2)");
{
  // Live run, 22 Nov 2026: the tag and its JSON were the stored answer text.
  const t = [
    "Here is how they compare.",
    "",
    '<ProductComparisonTable title="Compare Espresso Machines">',
    '[{"product_id": "1", "display_name": "Brewline Pro 2", "Water Tank": "1.8L", "Grinder": "Yes"}, {"product_id": "2", "display_name": "Crema Duo", "Water Tank": "1.1L", "Grinder": "No"}]',
    "</ProductComparisonTable>",
    "",
    "### Quick picks",
  ].join("\n");
  const { text, cards } = stripCardPlaceholders(t);
  check("no tag or JSON is left", !/ProductComparisonTable|product_id|\[\{/.test(text), text);
  check("it is a table, names first", /\| Product \| Water Tank \| Grinder \|/.test(text) && /\| \*\*Brewline Pro 2\*\* \| 1\.8L \| Yes \|/.test(text), text);
  check("under its title", /\*\*Compare Espresso Machines\*\*/.test(text), text);
  check("and kept as a card", cards.some((c) => c.kind === "comparison" && c.count === 2), JSON.stringify(cards));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
