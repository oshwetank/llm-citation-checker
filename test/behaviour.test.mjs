/*
 * Regression tests for the non-adapter behaviour that previously broke silently.
 * Run: node test/behaviour.test.mjs
 */
import { adapt as adaptChatGpt, cleanPassage, tokenizeAnswerMarkup } from "../src/adapters/chatgpt.js";
import { adapt as adaptGemini } from "../src/adapters/gemini.js";
import { makeRecord, ANSWER_TEXT_CAP } from "../src/schema.js";
import { buildExportModel, renderStandaloneHtml } from "../src/lib/exportDoc.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}  ${detail}`);
  }
}
async function load(name, adapter, opts) {
  const txt = readFileSync(join(FIX, name), "utf8");
  const lines = txt.split(/\r?\n/);
  const reqBody = (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") || "{}";
  const raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
  return adapter({ captureId: name, raw, reqBody, capturedAt: Date.now() }, opts);
}

// --- answerText must survive into the record (the UI reads it for rank/aspects) ---
console.log("answerText persistence");
{
  const c = await load("chatgpt-search-40k.txt", adaptChatGpt);
  const g = await load("gemini-streamgenerate.txt", adaptGemini);
  check("chatgpt record carries answerText", typeof c.answerText === "string" && c.answerText.length > 100, `got ${c.answerText?.length}`);
  check("gemini record carries answerText", typeof g.answerText === "string" && g.answerText.length > 100, `got ${g.answerText?.length}`);
  check("answerChars agrees with answerText", c.answerChars === c.answerText.length);
  const huge = makeRecord({ answerText: "x".repeat(ANSWER_TEXT_CAP + 5000) });
  check("answerText is capped", huge.answerText.length === ANSWER_TEXT_CAP, `got ${huge.answerText.length}`);
}

/* --- Detection must be AUTOMATIC and industry-agnostic ---
 * The tool cannot be phone-centric and cannot depend on the user supplying a word
 * list. These assert real brands are found with ZERO configuration in verticals
 * with nothing in common.
 */
console.log("\nautomatic detection across industries (no configuration)");
{
  const fin = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  const finNames = fin.brandMentions.map((b) => b.brand);
  check("finance: brokers detected", ["Zerodha", "Groww", "Upstox"].every((n) => finNames.includes(n)), finNames.join(","));
  check("finance: multi-word name kept whole", finNames.includes("Angel One"), finNames.join(","));
  check("finance: model entity category used", fin.brandMentions.some((b) => b.category === "Company"));

  const phone = await load("chatgpt-search-40k.txt", adaptChatGpt, {});
  const phoneNames = phone.brandMentions.map((b) => b.brand);
  check("phones: vendors detected", phoneNames.includes("OnePlus") && phoneNames.includes("Google"), phoneNames.join(","));
  check("phones: names are brand-level, not model-level", !phoneNames.some((n) => /\d/.test(n)), phoneNames.join(","));

  const local = await load("gemini-local-places.txt", adaptGemini, {});
  check("local: business names detected", local.brandMentions.length > 0, local.brandMentions.map((b) => b.brand).join(","));

  const jewel = await load("gemini-jewellery-shopping.txt", adaptGemini, {});
  const jNames = jewel.brandMentions.map((b) => b.brand);
  check("jewellery: category headings are not brands",
    !jNames.some((n) => /Necklaces|Rings|Contemporary|Chunky/i.test(n)), jNames.join(","));
}

console.log("\ntracked brands label results (they do not drive detection)");
{
  const tracked = [
    { name: "Groww", url: "groww.in", relation: "own" },
    { name: "Zerodha", url: "zerodha.com", relation: "competitor" },
  ];
  const r = await load("chatgpt-finance-trading.txt", adaptChatGpt, { tracked });
  const own = r.brandMentions.find((b) => b.brand === "Groww");
  const comp = r.brandMentions.find((b) => b.brand === "Zerodha");
  check("own brand labelled", own && own.relation === "own", JSON.stringify(own?.relation));
  check("competitor labelled", comp && comp.relation === "competitor", JSON.stringify(comp?.relation));
  const untracked = r.brandMentions.find((b) => b.brand === "Dhan");
  check("untracked brand still detected, unlabelled", untracked && !untracked.relation);
  const bare = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  check("same brands found with no config at all", bare.brandMentions.length === r.brandMentions.length);
}

/* --- Loader advance rule ---
 * ChatGPT races parallel requests per turn; the loser streams almost nothing.
 * Advancing on those empty captures silently SKIPPED prompts, so the run reported
 * success while omitting part of the prompt set. Mirror of background.hasSignal.
 */
console.log("\nloader advance guard (hasSignal)");
{
  const hasSignal = (r) => {
    if (!r) return false;
    const f = r.fanout || {};
    const fan = (f.search?.length || 0) + (f.shopping?.length || 0) + (f.image?.length || 0);
    return !!(r.userPrompt || fan || r.sources?.length || r.products?.length || r.places?.length || r.answerChars);
  };
  const real = await load("chatgpt-search-40k.txt", adaptChatGpt);
  check("a real turn advances the loader", hasSignal(real) === true);
  check("an empty race-loser does NOT advance", hasSignal(makeRecord({})) === false);
  check("null capture does NOT advance", hasSignal(null) === false);
  check("a prompt-only capture still counts", hasSignal(makeRecord({ userPrompt: "hi" })) === true);
}

// --- CSV must not hand Excel a formula from an untrusted page title ---
console.log("\nCSV formula-injection escaping");
{
  const csvCell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  check("= is neutralised", csvCell('=cmd|calc').startsWith(`"'=`));
  check("+ is neutralised", csvCell("+1").startsWith(`"'+`));
  check("@ is neutralised", csvCell("@SUM(A1)").startsWith(`"'@`));
  check("quotes are doubled", csvCell('say "hi"') === '"say ""hi"""');
  check("ordinary text untouched", csvCell("gadgets360.com") === '"gadgets360.com"');
}

/* --- Regression: the 40-char length cap silently dropped real brands ---
 * Business names with location qualifiers routinely exceed 40 chars
 * ("Malabar Gold and Diamonds - Andheri West - Mumbai" = 51). The bug: ALL
 * candidates shared one length cap, so 4 of 11 real businesses in a jewellery
 * capture vanished with zero indication. Structured sources (entity markers,
 * place listings) must not be capped like a freeform text guess.
 */
console.log("\nlong business names are not dropped (was: 40-char cap silently ate them)");
{
  const jewel = await load("chatgpt-jewellery-wedding.txt", adaptChatGpt, {});
  const names = jewel.brandMentions.map((b) => b.brand);
  check("all 11 businesses found, not just the short-named ones", names.length === 11, `got ${names.length}: ${names.join(" | ")}`);
  const longOnes = [
    "Malabar Gold and Diamonds - Andheri West - Mumbai",
    "CaratLane Jewellery Phoenix Palladium Mall, Mumbai",
    "Divyaaishwarya Jewellers - Best Bridal Store in Mumbai | 22kt Real Gold Temple Jewellery",
    "Silver Queen Jewellery - Imitation, Costume and Art Jewellery Shop in Santacruz",
  ];
  longOnes.forEach((n) => check(`kept: "${n.slice(0, 30)}…" (${n.length} chars)`, names.includes(n)));
}

/* --- Regression: cleanPassage must strip ALL three PUA marker kinds ---
 * A prior fix regressed this: rebuilding cleanPassage dropped the required
 * invisible PUA anchors for entity/product/cite, so passages showed raw
 * `entity["turn1business1","Name"]` JSON to the user instead of "[Name]".
 */
console.log("\npassages are human-readable, not raw entity/product/cite JSON");
{
  const jewel = await load("chatgpt-jewellery-wedding.txt", adaptChatGpt, {});
  const passages = jewel.brandMentions.map((b) => b.passages[0]).join(" ");
  check("no raw entity[ markup leaks into passages", !/entity\[/.test(passages), passages.slice(0, 80));
  check("no raw product[ markup leaks into passages", !/product\[/.test(passages));
  check("no stray citeturnN markup leaks into passages", !/cite ?turn\d/.test(passages));
  const phone = await load("chatgpt-search-40k.txt", adaptChatGpt, {});
  const pp = phone.brandMentions.map((b) => b.passages[0]).join(" ");
  check("product markers cleaned to [Name] form on a second fixture", pp.includes("["), pp.slice(0, 60));
}

/* --- Regression: a leading rank emoji/medal counted as a "word" and broke
 * both the proper-name check and the vendor-fallback's first-token extraction,
 * so headings like "🥇 Best Overall: iQOO Neo 10" and "🥈 Realme GT 7" were
 * silently dropped.
 */
console.log("\nemoji-prefixed and colon-labelled headings are handled");
{
  const r = await load("chatgpt-phone-which.txt", adaptChatGpt, {});
  const names = r.brandMentions.map((b) => b.brand);
  check("iQOO found despite '🥇 Best Overall: iQOO Neo 10' heading", names.includes("iQOO"), names.join(","));
  check("Realme found despite plain '🥈 Realme GT 7' heading", names.includes("Realme"), names.join(","));
  check("Vivo, Poco, Motorola also found", ["Vivo", "Poco", "Motorola"].every((n) => names.includes(n)), names.join(","));
}

/* --- New: ChatGPT local-business extraction (was Gemini-only before) ---
 * ChatGPT's local search results carry a full structured record — rating,
 * review count, address, phone, hours, coordinates, and a Google Place id —
 * nested under {category:"local_business", entity_data:{...}}. None of this
 * was extracted for ChatGPT previously (places[] was always empty).
 */
console.log("\nChatGPT local-business places (rating/hours/phone/maps — new)");
{
  const jewel = await load("chatgpt-jewellery-wedding.txt", adaptChatGpt, {});
  check("places extracted", jewel.places.length === 11, `got ${jewel.places.length}`);
  const p = jewel.places.find((x) => x.name === "Manubhai Jewellers - Flagship Store");
  check("place found by name", !!p);
  if (p) {
    check("rating present", typeof p.rating === "number" && p.rating > 0, p.rating);
    check("review count present", typeof p.reviews === "number" && p.reviews > 0, p.reviews);
    check("phone present", /^\+?\d[\d+]{6,}$/.test(p.phone || ""), p.phone);
    check("address present", typeof p.address === "string" && p.address.length > 10);
    check("hours formatted as readable text, not raw day/start/end objects", typeof p.hours === "string" && /AM|PM/.test(p.hours), p.hours);
    check("coordinates present", typeof p.lat === "number" && typeof p.lng === "number");
    check("maps deep-link built from the Google Place id", /^https:\/\/www\.google\.com\/maps\/place\/\?q=place_id:/.test(p.mapsUrl || ""), p.mapsUrl);
  }
  check("map carousel flag reflects real places, not a heuristic that never matched", jewel.carousels.map === true);
  check("non-local captures have zero places (no false positives)", (await load("chatgpt-search-40k.txt", adaptChatGpt, {})).places.length === 0);
}

/* --- Regression: the bulk "products{selections}" marker was silently dropped ---
 * ChatGPT's product-carousel widget uses a DIFFERENT marker shape than the
 * singular per-product one: an OBJECT body {"selections":[[id,name],...]}, not
 * an array. parseMarkers required an array and `continue`d past it entirely —
 * so EVERY product named only in this marker (not narrated in bold prose)
 * vanished with zero indication. This was the single biggest cause of "few
 * brands are not getting named" across watches/perfume/TV captures.
 */
console.log("\nbulk products{} carousel marker is parsed (was silently skipped)");
{
  const watches = await load("chatgpt-watches.txt", adaptChatGpt, {});
  const names = watches.brandMentions.map((b) => b.brand);
  check("Samsung found (narrated + in carousel)", names.includes("Samsung"));
  check("CMF found (narrated + in carousel)", names.includes("CMF"));
  check("Noise found (carousel-only, never narrated in prose)", names.includes("Noise"), names.join(","));
  check("NoiseFit found (carousel-only, never narrated in prose)", names.includes("NoiseFit"), names.join(","));
  const tv = await load("chatgpt-tv.txt", adaptChatGpt, {});
  check("Acer found on a second fixture (was missing before this fix)", tv.brandMentions.some((b) => b.brand === "Acer"));
  check("bulk marker JSON does not leak into any passage", !/selections/.test(JSON.stringify(watches.brandMentions)));
}

/* --- Regression: a product shown in a carousel but never named in prose was
 * indistinguishable from "not detected" — both looked like nothing happened.
 * Now it's reported explicitly with count=0 and an honest passage, so the user
 * can tell "ChatGPT considered this but didn't write it up" from "not found at
 * all". Retailers (Amazon, Croma — who SELLS it, not who MAKES it) must NOT get
 * this treatment, or Brand Mentions fills with sellers instead of brands.
 */
console.log("\n\"shown but not narrated\" products get count=0, not silently dropped");
{
  const watches = await load("chatgpt-watches.txt", adaptChatGpt, {});
  const noise = watches.brandMentions.find((b) => b.brand === "Noise");
  check("carousel-only brand has count=0, not omitted", noise && noise.count === 0, noise);
  check("carousel-only brand gets an honest, non-empty passage", noise && noise.passages[0].length > 0);
  const tvBrands = watches.brandMentions.map((b) => b.brand);
  check("retailers/merchants are NOT injected as 0-count brand noise", !tvBrands.some((n) => /^(Amazon|Croma|Flipkart|Vijay Sales|Reliance Digital)/i.test(n)), tvBrands.join(","));
}

/* --- Regression: "by" wasn't a recognized connector, so "Wallet by
 * BudgetBakers" failed the every-word-capitalized check entirely (lowercase
 * "by" isn't capitalized) and was dropped with no fallback (no digit to trigger
 * the vendor-extraction path either).
 */
console.log('\n"by"-joined brand names are kept ("Wallet by BudgetBakers")');
{
  const r = await load("chatgpt-expense-apps.txt", adaptChatGpt, {});
  const names = r.brandMentions.map((b) => b.brand);
  check('"Wallet by BudgetBakers" kept whole, not dropped', names.includes("Wallet by BudgetBakers"), names.join(","));
}

/* --- Regression: the plural-noun category-heading filter used a blanket "any
 * word ending in s" rule, which also rejects real company names that happen to
 * end in s (BudgetBakers, Motors, Brothers). Narrowed to a curated list of
 * actual category nouns (Necklaces, Rings, Options, …) so brand names ending in
 * s survive while genuine category headings ("Contemporary Gold Necklaces")
 * are still correctly rejected.
 */
console.log("\ncategory-noun filter no longer rejects brand names ending in s");
{
  const r = await load("chatgpt-expense-apps.txt", adaptChatGpt, {});
  check('"BudgetBakers"-style name not rejected as a fake plural category', r.brandMentions.some((b) => b.brand.includes("BudgetBakers")));
  const jewel = await load("chatgpt-jewellery-wedding.txt", adaptChatGpt, {});
  check("genuine category headings still filtered (jewellery count unaffected)", jewel.brandMentions.length === 11, jewel.brandMentions.length);
}

/* --- Regression: a heading naming two alternatives ("Google Sheets / Excel")
 * was evaluated as ONE phrase, which fails every structural check (too many
 * words, slash counted as a token) and both real products were dropped.
 */
console.log('\nslash-separated heading alternatives are split ("Google Sheets / Excel")');
{
  const r = await load("chatgpt-expense-apps.txt", adaptChatGpt, {});
  const names = r.brandMentions.map((b) => b.brand);
  check("Google Sheets found", names.includes("Google Sheets"), names.join(","));
  check("Excel found as a separate brand, not merged", names.includes("Excel"), names.join(","));
}

/* --- Regression guard: cleanPassage's "cite" pattern used to be unanchored
 * (`cite(?:[^]*)*`), which matched "cite" then greedily consumed EVERYTHING to
 * the end of the string — found while building the conversation-export
 * feature. On this fixture it silently cut a 1603-char answer down to 169
 * chars. Named guard (not just a passing suite) per the incident: this has
 * already shipped through two rounds of "missing brands" debugging without
 * being caught, so assert the exact fix, not just that nothing crashes.
 */
console.log("\nregression guard: cleanPassage no longer truncates at the first citation marker");
{
  const c = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  const cleaned = cleanPassage(c.answerText);
  check(
    "text after the first citation marker survives cleaning",
    cleaned.includes("Groww has a very simple interface"),
    JSON.stringify(cleaned.slice(0, 80)) + "…"
  );
  check("cleaned text retains most of the answer (not collapsed to the first sentence)", cleaned.length > c.answerText.length * 0.5, `${cleaned.length}/${c.answerText.length}`);
  check("entity markers become readable [Name], not raw JSON", cleaned.includes("[Zerodha]") && !cleaned.includes('entity["company"'), cleaned.slice(0, 120));
}

/* --- markerIds: each source now carries the literal inline-citation-marker id
 * (turn0search3 etc.) it corresponds to, built from ref_id/refs[]
 * {turn_index, ref_type, ref_index}. This is what lets an export document
 * turn a "citeturn0search2" run in the answer into a numbered footnote
 * pointing at the right source, instead of just a reference-type count.
 */
console.log("\nsource markerIds join inline citation markers to a specific source");
{
  const c = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  const zerodha = c.sources.find((s) => s.domain === "zerodha.com");
  const groww = c.sources.find((s) => s.domain === "groww.in");
  check("zerodha.com carries markerIds", !!(zerodha && zerodha.platformSpecific.markerIds && zerodha.platformSpecific.markerIds.length), zerodha && JSON.stringify(zerodha.platformSpecific.markerIds));
  check("groww.in carries markerIds", !!(groww && groww.platformSpecific.markerIds && groww.platformSpecific.markerIds.length), groww && JSON.stringify(groww.platformSpecific.markerIds));

  // Every inline cite id in the answer must resolve to some source's markerIds
  // (the join is the whole point — an unresolved id means a silently broken footnote).
  const known = new Set(c.sources.flatMap((s) => s.platformSpecific.markerIds || []));
  const segs = tokenizeAnswerMarkup(c.answerText);
  const citeIds = segs.filter((s) => s.type === "cite").flatMap((s) => s.ids);
  check("every inline cite id resolves to a source", citeIds.length > 0 && citeIds.every((id) => known.has(id)), citeIds.filter((id) => !known.has(id)).join(","));
}

/* --- tokenizeAnswerMarkup: the export renderer's source of truth for turning
 * marker-laden answerText into ordered segments. Must losslessly account for
 * every character (data integrity) and never leak a raw PUA delimiter into a
 * text segment (would render as a tofu box in the exported document).
 */
console.log("\ntokenizeAnswerMarkup segments losslessly and leaks no PUA characters");
{
  for (const [name, opts] of [["chatgpt-jewellery-wedding.txt", {}], ["chatgpt-watches.txt", {}], ["chatgpt-tv.txt", {}]]) {
    const r = await load(name, adaptChatGpt, opts);
    const segs = tokenizeAnswerMarkup(r.answerText);
    const reassembled = segs.reduce((n, s) => n + (s.type === "text" ? s.value.length : s.end - s.start), 0);
    check(`${name}: segments cover the full answer length`, reassembled === r.answerText.length, `${reassembled}/${r.answerText.length}`);
    const leaked = segs.some((s) => s.type === "text" && [...s.value].some((ch) => ch.codePointAt(0) >= 0xe000 && ch.codePointAt(0) <= 0xf8ff));
    check(`${name}: no PUA characters leak into text segments`, !leaked);
  }
  // The bare OPEN+"map"+CLOSE flag marker (local/places carousel indicator,
  // has no MID-delimited body unlike entity/product/cite) must be recognized
  // as its own segment type, not leaked as literal "map" text.
  const jewel = await load("chatgpt-jewellery-wedding.txt", adaptChatGpt, {});
  const jewelSegs = tokenizeAnswerMarkup(jewel.answerText);
  check("bare 'map' marker recognized as its own segment", jewelSegs.some((s) => s.type === "map"));
}

/* --- buildExportModel: ChatGPT gets numbered footnotes resolved to real
 * sources; Gemini has no inline citation positions at all (platform
 * limitation, not a bug) so it must still surface a full, non-empty source
 * list without claiming footnotes it can't back up.
 */
console.log("\nbuildExportModel: ChatGPT footnotes vs Gemini's footnote-free source list");
{
  const c = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  const cModel = buildExportModel(c);
  check("ChatGPT export model resolves footnotes", cModel.footnotes.length >= 2, cModel.footnotes.length);
  check("ChatGPT export model flags no unresolved citations on a fresh capture", cModel.unresolvedCitations === false);
  check("ChatGPT export body contains rendered HTML (not raw markdown)", cModel.bodyHtml.includes("<table>") && !cModel.bodyHtml.includes("|---|"), cModel.bodyHtml.slice(0, 60));

  const g = await load("gemini-streamgenerate.txt", adaptGemini, {});
  const gModel = buildExportModel(g);
  check("Gemini export model has NO inline footnotes (documented platform limitation)", gModel.footnotes.length === 0);
  check("Gemini export model still lists sources for the appendix", gModel.sources.length > 0, gModel.sources.length);
  check("Gemini export model is flagged as not having inline citations", gModel.hasInlineCitations === false);
}

/* --- Regression guard: a product/entity marker whose NAME contains a literal
 * quote character (a monitor/TV size like 27") broke both cleanPassage and
 * tokenizeAnswerMarkup — found via a real user-generated PDF export. The old
 * capture group `"([^"]*)"` doesn't understand JSON's `\"` escape and
 * truncates right at it, leaving a stray backslash ("Lenovo Legion R27qe
 * Gen 2 27\" instead of "...27" QHD..."). Fixed by parsing the marker's
 * array body with JSON.parse instead of a hand-rolled capture group.
 */
console.log('\nregression guard: marker names containing a literal quote (27") parse correctly');
{
  const PUA_OPEN = String.fromCodePoint(0xe200);
  const PUA_MID = String.fromCodePoint(0xe202);
  const PUA_CLOSE = String.fromCodePoint(0xe201);
  const name = 'Lenovo Legion R27qe Gen 2 27" QHD 200Hz Gaming Monitor';
  const marker = PUA_OPEN + "product" + PUA_MID + JSON.stringify(["turn0product0", name]) + PUA_CLOSE;
  const text = `Check out this monitor: ${marker} — great pick.`;

  const cleaned = cleanPassage(text);
  check("cleanPassage keeps the full name including the quote", cleaned.includes(`[${name}]`), cleaned);
  check("cleanPassage leaves no stray backslash", !cleaned.includes("27\\"), cleaned);

  const segs = tokenizeAnswerMarkup(text);
  const seg = segs.find((s) => s.type === "product");
  check("tokenizeAnswerMarkup captures the full name including the quote", seg && seg.name === name, seg && seg.name);
}

/* --- buildExportModel now surfaces images (product thumbnails + the
 * carousel images[] array) — previously dropped entirely, so a user asking
 * "can we add images where there was an image" had nothing to add to.
 */
console.log("\nbuildExportModel surfaces product/carousel images");
{
  const phone = await load("chatgpt-phone-under.txt", adaptChatGpt, {});
  const model = buildExportModel(phone);
  check("export model carries product images", model.products.some((p) => p.image), model.products.map((p) => !!p.image));
  check("export model carries the carousel images[] array", model.images.length > 0, model.images.length);
  const html = renderStandaloneHtml([model]);
  check("rendered HTML includes product thumbnail <img> tags", (html.match(/class="thumb"/g) || []).length > 0);
  check("rendered HTML includes an Images section", html.includes("<h3>Images</h3>"));
}

/* --- Regression guard: a single-conversation export repeated the prompt —
 * once as the document's top <h1>, again as the conversation section's
 * heading — found in a real export. Bulk exports (2+) still need the top
 * <h1> as a generic label since each section's own prompt differs.
 */
console.log("\nregression guard: single-conversation export doesn't repeat the prompt");
{
  const c = await load("chatgpt-finance-trading.txt", adaptChatGpt, {});
  const model = buildExportModel(c);
  const single = renderStandaloneHtml([model]);
  check("single export has no top-level <h1>", !single.includes("<h1>"));
  // Count only within <body> — <title> legitimately also carries the prompt
  // (drives the tab title / print-dialog default filename), that's not the
  // "shown twice on the page" duplication bug this guards against.
  const bodyOnly = single.slice(single.indexOf("<body>"));
  const promptEsc = model.prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const occurrences = (bodyOnly.match(new RegExp(promptEsc, "g")) || []).length;
  check("prompt appears exactly once in the visible body", occurrences === 1, occurrences);

  const bulk = renderStandaloneHtml([model, model], { docTitle: "two" });
  check("bulk export DOES have a top-level <h1>", bulk.includes("<h1>"));
}

console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
