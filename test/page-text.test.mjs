/*
 * The cited pages, read (src/lib/pageText.js, 0.62.0).
 * Run: node test/page-text.test.mjs
 *
 * Reported: "Which sources name which brands" was unreliable. It judged a
 * page by the title and snippet the engine sent, so a review comparing five
 * phones could read as naming one. This checks the parts with no browser:
 * which pages are read (cited only, once each, at most 15), when text is a
 * wall rather than the page, which brands the text names, and that the brand
 * grid switches to the page text for a page that was read and says so.
 */
import { citedUrls, pageVerdict, pageBrands, pageSummary, wordCount } from "../src/lib/pageText.js";
import { computeBrandMatrix } from "../src/lib/funnel-omitted.js";
import { sourceBrandMatrix } from "../src/lib/analyzeView.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

const src = (url, outcome, title = "", snippet = "") => ({ url, domain: new URL(url).hostname, outcome, title, snippet, platformSpecific: {} });
const rec = {
  captureId: "p1",
  answerText: "Zento Nova 8 and Kovo Edge 5 are the picks; Lumora Pix 3 is the budget one.",
  brandMentions: [{ brand: "Zento", count: 2 }, { brand: "Kovo", count: 1 }, { brand: "Lumora", count: 1 }],
  sources: [
    src("https://review.example/best-phones", "cited", "Best phones of 2026", "Our top pick this year."),
    src("https://review.example/best-phones#comments", "cited"),
    src("https://blog.example/kovo", "cited", "Kovo Edge 5 review", "Kovo's camera is good."),
    src("https://other.example/x", "fetched", "Lumora Pix 3 deals", ""),
  ],
};

console.log("which pages are read");
{
  check("cited pages only, once each (an #anchor is the same page)", JSON.stringify(citedUrls(rec)) === JSON.stringify(["https://review.example/best-phones", "https://blog.example/kovo"]), JSON.stringify(citedUrls(rec)));
  const many = { sources: Array.from({ length: 30 }, (_, i) => src(`https://s${i}.example/`, "cited")) };
  check("at most 15 per answer", citedUrls(many).length === 15);
}

console.log("a page, or a wall");
{
  const long = "Phones compared. ".repeat(10) + Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  check("a real page is ok", pageVerdict({ title: "Best phones", text: long }) === "ok");
  check("a bot check is a wall", pageVerdict({ title: "Just a moment...", text: "Checking your browser before accessing the site. Enable JavaScript and cookies to continue." }) === "blocked");
  check("an empty JavaScript shell is too thin", pageVerdict({ title: "App", text: "Loading" }) === "thin");
  check("words are counted across scripts", wordCount("Kovo एज 5 — 12GB") === 4, wordCount("Kovo एज 5 — 12GB"));
}

console.log("which brands the page names");
{
  const text = "We tested twelve phones. The Zento Nova 8 won on low light. Kovo Edge 5 was close, and Zento's battery lasted longest. Lumora was not tested.";
  const b = pageBrands(text, rec);
  const zento = b.find((x) => x.brand === "Zento");
  check("every brand the text names, most often first", b[0].brand === "Zento" && zento.count === 2 && b.some((x) => x.brand === "Kovo") && b.some((x) => x.brand === "Lumora"), JSON.stringify(b));
  check("with the words around its first mention", /The Zento Nova 8 won/.test(zento.context), zento.context);
  check("no text, no brands", pageBrands("", rec).length === 0);
  const sum = pageSummary({ status: "ok", method: "fetch", words: 30, fetchedAt: 1, text }, rec);
  check("the record keeps status, words and brands, not the text", sum.status === "ok" && sum.words === 30 && sum.brands.length === 3 && !("text" in sum), JSON.stringify(sum));
  const blocked = pageSummary({ status: "blocked", method: "fetch", words: 12, text: "" }, rec);
  check("a page not read keeps why, and no brands", blocked.status === "blocked" && !blocked.brands);
}

console.log("the brand grid uses the page when it was read");
{
  const before = computeBrandMatrix(rec).sources[0];
  check("before: the review's title and snippet name no brand", before.presentBrands.length === 0 && before.basis === "snippet", JSON.stringify(before));
  const read = JSON.parse(JSON.stringify(rec));
  read.sources[0].platformSpecific.page = pageSummary({ status: "ok", words: 900, text: "The Zento Nova 8 and the Kovo Edge 5 were the two best." }, read);
  const after = computeBrandMatrix(read).sources[0];
  check("after: it names Zento and Kovo, from the page", after.presentBrands.includes("Zento") && after.presentBrands.includes("Kovo") && after.basis === "page", JSON.stringify(after));
  const m = sourceBrandMatrix(read, {});
  const row = m && m.rows.find((r) => r.domain === "review.example");
  check("and the site's grid row says the cells come from page text", row && row.basis === "page" && m.pagesRead === 1, JSON.stringify(row));
  const blog = m.rows.find((r) => r.domain === "blog.example");
  check("a site not read stays on its snippet", blog && blog.basis === "snippet", JSON.stringify(blog));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
