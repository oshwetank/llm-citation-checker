/*
 * Tests for src/lib/funnel-omitted.js — the "Search Funnel" analysis.
 * Run: node test/funnel-omitted.test.mjs
 *
 * Both headline cases below are real, reported against a live capture
 * ("best camera phone under 55000"), and neither was reachable by a test
 * while this logic lived inside renderAnalyze()'s DOM-building code.
 */
import { computeSearchFunnel, sameBrand, modelAfterBrand } from "../src/lib/funnel-omitted.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nsameBrand: word-granular identity, not exact strings");
{
  check("a fuller product name is the same brand", sameBrand("vivo X200 FE", "Vivo"));
  check("order does not matter", sameBrand("Vivo", "vivo X200 FE"));
  check("case and punctuation folded", sameBrand("OnePlus 13s", "oneplus"));
  check("different brands stay different", !sameBrand("Vivo", "Oppo"));
  // "Vivo" must not swallow an unrelated company that merely starts alike.
  check("a longer first word is not a prefix match", !sameBrand("Vivobook", "Vivo"));
  check("empty input is never a match", !sameBrand("", "Vivo") && !sameBrand("Vivo", ""));
}

/*
 * The inverted card. With Chrome's on-device AI tier available,
 * src/lib/ai-brands.js upgrades a detected brand to its full product name in
 * place ("Vivo" -> "vivo X200 FE"). The funnel scans source titles and finds
 * the bare "Vivo". An exact-string comparison matched neither, so a capture
 * where all five brands were mentioned listed all five as OMITTED.
 */
console.log("\na mentioned brand is never reported as omitted, even when the AI tier renamed it");
{
  const rec = {
    answerText: "The vivo X200 FE leads, with the OnePlus 13s close behind.",
    brandMentions: [
      { brand: "vivo X200 FE", count: 5 },
      { brand: "OnePlus 13s", count: 4 },
    ],
    products: [],
    places: [],
    entities: [],
    // The engine's own fan-out query — the only place Xiaomi is named
    // besides the sources, and what makes "searched for, then dropped"
    // detectable at all.
    fanout: {
      search: [{ query: "best camera phones under 55000 India 2026 Vivo X200 FE Xiaomi 15 Pixel 9" }],
      shopping: [], image: [],
    },
    sources: [
      { title: "Vivo X200 FE review", snippet: "Vivo X200 FE camera test" },
      { title: "OnePlus 13s vs rivals", snippet: "OnePlus 13s price in India" },
      { title: "Xiaomi 15 first look", snippet: "Xiaomi 15 camera samples" },
    ],
  };
  const { omittedBrands } = computeSearchFunnel(rec);
  const names = omittedBrands.map((b) => b.brand);
  check("Vivo is NOT omitted (it was mentioned as 'vivo X200 FE')", !names.some((n) => /vivo/i.test(n)), names.join(", "));
  check("OnePlus is NOT omitted", !names.some((n) => /oneplus/i.test(n)), names.join(", "));
  check("a genuinely absent brand IS reported", names.some((n) => /xiaomi/i.test(n)), names.join(", "));
  check("exactly one omission found", omittedBrands.length === 1, names.join(", "));
  // "X200" is a model designation, "Pixel" is Google's sub-brand and Google
  // was mentioned — neither is an omitted BRAND.
  check("a model token from the query is not reported as a brand",
    !names.some((n) => /^x200$/i.test(n)), names.join(", "));
  check("a sub-brand of a mentioned parent is not reported",
    !names.some((n) => /^pixel$/i.test(n)), names.join(", "));
}

/*
 * Garbled models. The old extractor took up to five capitalised words after
 * the brand name in a source headline; on the reported capture that produced
 * twenty-one chips under "Vivo" alone, including these exact strings.
 */
console.log("\nmodel extraction rejects headline fragments and spec values");
{
  const good = modelAfterBrand("Vivo X200 FE review and price in India", "Vivo");
  check("a real designation is kept", good.includes("X200 FE"), JSON.stringify(good));
  check("the headline's trailing words are not part of it",
    !good.some((m) => /review|price|india/i.test(m)), JSON.stringify(good));

  const junkPhrases = [
    ["Vivo X200 FE with us to Udaipur", "Vivo"],
    ["Vivo Makes Premium X-Series Phones", "Vivo"],
    ["OnePlus 13s. We tested it", "OnePlus"],
    ["Vivo 612 GB 18 GB comparison", "Vivo"],
  ];
  for (const [text, brand] of junkPhrases) {
    const got = modelAfterBrand(text, brand);
    const bad = got.filter((m) => /\b(with|us|to|makes|premium|we|gb)\b/i.test(m));
    check(`no prose leaks from ${JSON.stringify(text)}`, bad.length === 0, JSON.stringify(got));
  }
  check("a letters-only fragment is rejected outright",
    modelAfterBrand("Vivo Makes Premium Phones", "Vivo").length === 0);
  check("a digits-only spec value is rejected",
    !modelAfterBrand("Vivo 612 GB storage", "Vivo").includes("612"));
  check("'13s' survives as a genuine designation",
    modelAfterBrand("OnePlus 13s. We tested it", "OnePlus").includes("13s"));
}

console.log("\npublishers and retailers are not part of the scan vocabulary");
{
  const rec = {
    answerText: "The vivo X200 FE leads.",
    brandMentions: [{ brand: "vivo X200 FE", count: 3 }],
    products: [], places: [], entities: [],
    sources: [
      { title: "Gadgets 360 best camera phones", snippet: "Gadgets 360 rounds up" },
      { title: "91mobiles top picks", snippet: "91mobiles rated them" },
    ],
  };
  const names = computeSearchFunnel(rec).omittedBrands.map((b) => b.brand);
  check("no publisher is reported as an omitted brand", names.length === 0, names.join(", "));
}

console.log("\nomitted MODELS are reported for a brand that was mentioned");
{
  const rec = {
    answerText: "The Vivo X200 FE is our pick.",
    brandMentions: [{ brand: "Vivo", count: 2 }],
    products: [], places: [], entities: [],
    sources: [{ title: "Vivo X300 Pro launch", snippet: "Vivo X300 Pro specs" }],
  };
  const { omittedBrands, omittedModels } = computeSearchFunnel(rec);
  check("the brand itself is not omitted", omittedBrands.length === 0);
  check("its unwritten model is surfaced",
    omittedModels.some((m) => m.omittedModels.some((x) => /X300/i.test(x.model))),
    JSON.stringify(omittedModels));
}

console.log("\ndegenerate input never throws");
{
  check("no sources", computeSearchFunnel({ sources: [] }).omittedBrands.length === 0);
  check("null record", computeSearchFunnel(null).omittedBrands.length === 0);
  check("missing fields", computeSearchFunnel({ sources: [{}] }).omittedBrands.length === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
