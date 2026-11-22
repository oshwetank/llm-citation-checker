/*
 * answer-links.test.mjs — links in an answer, and the kind of site a
 * booking page is (exportDoc.js markdownToHtml, siteKind.js).
 *
 * Reported on a real "budget hotels" run: "the format in which the answer
 * came, it was not captured". Gemini linked every hotel it named,
 * "**[Hotel X](https://www.google.com/travel/search?q=…)**", and the report
 * printed that as "[ Hotel X ](https://www.google.com/travel/search?q=…" in
 * plain text. And every booking site the engines read (MakeMyTrip, Goibibo,
 * Booking.com, Trivago, ixigo, …) was "Other", or a "Rival brand site" once
 * the answer named it.
 *
 * Made-up answers. Fails on 0.56.0.
 */
import { buildExportModel } from "../src/lib/exportDoc.js";
import { siteKindOf } from "../src/lib/siteKind.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const html = (answerText, platform = "gemini") => buildExportModel({ captureId: "t", platform, answerText, sources: [] }).bodyHtml;

console.log("\nA linked name is a link");
{
  const url = "https://www.google.com/travel/search?q=Hotel+Pinecrest&qs=Mh_ab_cd&ts=CAES";
  const out = html(`* **[Hotel Pinecrest](${url})**\n  * **Price:** About ₹1,540 a night`);
  check("the name is the link's text", /<a href="https:\/\/www\.google\.com\/travel\/search\?q=Hotel\+Pinecrest&amp;qs=Mh_ab_cd&amp;ts=CAES" target="_blank" rel="noopener noreferrer">Hotel Pinecrest<\/a>/.test(out), out);
  check("still bold, as the engine showed it", /<strong><a [^>]+>Hotel Pinecrest<\/a><\/strong>/.test(out), out);
  check("no bracket or address left in the text", !/\[Hotel|\]\(|\(https/.test(out.replace(/<a [^>]+>/g, "")), out);
  check("an underscore inside the address is not read as emphasis", !/<em>/.test(out) && /qs=Mh_ab_cd/.test(out), out);
  const paren = html("See [the guide](https://en.wikipedia.org/wiki/Lakeport_(town)) first.");
  check("an address with brackets in it keeps them", /href="https:\/\/en\.wikipedia\.org\/wiki\/Lakeport_\(town\)"/.test(paren), paren);
  check("ChatGPT's answers get links too", /<a href="https:\/\/a\.example\/x"/.test(html("Book at [A](https://a.example/x).", "chatgpt")));
}

console.log("\nOnly web addresses become links");
{
  const js = html("Click [here](javascript:alert(1)) now.");
  check("a javascript: link stays text", !/<a /.test(js) && /\[here\]/.test(js), js);
  const data = html("[x](data:text/html,hi)");
  check("so does a data: link", !/<a /.test(data), data);
  const quote = html('[q](https://a.example/"onmouseover="x)');
  check("a quote in the address cannot leave the attribute", !/"onmouseover/.test(quote) && /&quot;onmouseover=&quot;x/.test(quote), quote);
  const tag = html("[<img src=x onerror=alert(1)>](https://a.example/)");
  check("markup in the link text stays text", !/<img/.test(tag) && /&lt;img/.test(tag), tag);
  check("plain brackets are left alone", /\[sic\] \(really\)/.test(html("He said [sic] (really).")));
}

console.log("\nBooking sites are where people book, not 'Other'");
{
  const ctx = { brands: ["MakeMyTrip", "Trivago", "Hotel Pinecrest"] };
  for (const d of ["makemytrip.com", "www.goibibo.com", "booking.com", "trivago.in", "ixigo.com", "oyorooms.com", "momondo.in", "hotelscombined.in", "agoda.com", "cleartrip.com"]) {
    check(`${d} is a booking site, counted with the stores`, siteKindOf(d, ctx) === "Retailers", siteKindOf(d, ctx));
  }
  check("a hotel's own site named in the answer is still a rival's", siteKindOf("hotelpinecrest.com", ctx) === "Rival brand sites", siteKindOf("hotelpinecrest.com", ctx));
  check("a travel blog is not a store", siteKindOf("lakeport-travel-diary.example", ctx) === "Other", siteKindOf("lakeport-travel-diary.example", ctx));
  check("the owner's own booking site is theirs", siteKindOf("makemytrip.com", { ...ctx, ownBrand: "MakeMyTrip" }) === "Your site");
}

console.log("\nA line break written as <br> (1.0.2)");
{
  // Gemini's term-insurance table, live run of 22 Nov 2026: Analyze printed
  // "<br>" fifteen times.
  const out = html("| Insurer & Plan | CSR |\n| :--- | :--- |\n| **HDFC Life** <br>*Click 2 Protect* | 99.72% |\n| **Axis Max Life**<br/>*Smart Term* | 99.80% |");
  check("it is a line break", (out.match(/<br>/g) || []).length === 2, out);
  check("never printed as text", !/&lt;br/.test(out), out);
  const other = html("Use <b>bold</b> and <script>x</script> here.");
  check("no other tag is let through", !/<script>|<b>/.test(other) && /&lt;script&gt;/.test(other), other);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
