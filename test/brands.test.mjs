/*
 * brands.test.mjs — guards the industry-agnostic promise in src/lib/brands.js.
 *
 * Every case here comes from a real failure found while auditing a 231-capture
 * run across 20 industries: whole verticals (lending, cement, healthcare, real
 * estate) were detecting ZERO brands because a cited domain's squashed label
 * ("hdfcbank") never matched the prose spelling ("HDFC Bank"), and because the
 * public-suffix logic both lost every non-listed ccTLD and invented companies
 * called "Club" / "Store" / "Realty" out of modern generic TLDs.
 */
import { detectBrands, brandFromDomain, matchCompressedLabel } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const names = (answer, ctx) => detectBrands(answer, answer, ctx).brands.map((b) => b.brand);

console.log("\nbrandFromDomain: registrable label, not the public suffix");
{
  check("plain .com", brandFromDomain("zerodha.com") === "Zerodha");
  check("subdomain ignored", brandFromDomain("gadgets.beebom.com") === "Beebom");
  check("www stripped", brandFromDomain("www.groww.in") === "Groww");
  // Regression: an allow-list of suffixes returned null for anything not on it.
  check("ccTLD .de kept", brandFromDomain("siemens.de") === "Siemens");
  check("ccTLD .fr kept", brandFromDomain("loreal.fr") === "Loreal");
  check("ccTLD .ch kept", brandFromDomain("nestle.ch") === "Nestle");
  // Regression: unknown generic TLDs became the "brand" themselves.
  check("generic TLD is not the brand", brandFromDomain("cred.club") === "Cred", brandFromDomain("cred.club"));
  check(".store is not a brand called Store", brandFromDomain("acme.store") === "Acme");
  check(".realty is not a brand called Realty", brandFromDomain("props.realty") === "Props");
  // Two-label public suffixes still resolve past the registry label.
  check("co.uk", brandFromDomain("example.co.uk") === "Example");
  check("com.au", brandFromDomain("woolworths.com.au") === "Woolworths");
  check("com.sg", brandFromDomain("dbs.com.sg") === "Dbs");
  check("bare host with no dot", brandFromDomain("localhost") === null);
  check("too-short label rejected", brandFromDomain("a.blog") === null);
  check("empty input", brandFromDomain("") === null);
}

console.log("\nmatchCompressedLabel: squashed domain label ↔ spaced prose");
{
  check("two words", matchCompressedLabel("Try HDFC Bank today", "hdfcbank").length === 1);
  check("camel-case run", matchCompressedLabel("UltraTech Cement leads", "ultratechcement").length === 1);
  check("hyphenated label", matchCompressedLabel("Siemens Healthineers imaging", "siemens-healthineers").length === 1);
  check("single word still matches", matchCompressedLabel("Paytm and others", "paytm").length === 1);
  check("counts every occurrence", matchCompressedLabel("HDFC Bank beat HDFC Bank", "hdfcbank").length === 2);
  // Precision: a prefix must not be accepted as the whole name.
  check("prefix is not a match", matchCompressedLabel("Prestige Estates grew", "prestigeconstructions").length === 0);
  check("unrelated text", matchCompressedLabel("nothing relevant here", "hdfcbank").length === 0);
  check("span is exact", (() => {
    const t = "See HDFC Bank now";
    const [h] = matchCompressedLabel(t, "hdfcbank");
    return t.slice(h.start, h.end) === "HDFC Bank";
  })());
}

console.log("\ncited domains resolve to brands across verticals (the 231-capture bug)");
{
  const lending = names(
    "HDFC Bank and ICICI Bank lead, though Bajaj Finserv disburses faster than Tata Capital.",
    { sources: [{ domain: "hdfcbank.com" }, { domain: "icicibank.com" }, { domain: "bajajfinserv.in" }, { domain: "tatacapital.com" }] }
  );
  check("lending: all four found", lending.length === 4, lending.join(", "));
  check("lending: spelled as the answer writes them", lending.includes("HDFC Bank") && lending.includes("Bajaj Finserv"), lending.join(", "));

  const cement = names("UltraTech Cement is largest; Ambuja Cement follows.", {
    sources: [{ domain: "ultratechcement.com" }, { domain: "ambujacement.com" }],
  });
  check("cement: multi-word names found", cement.includes("UltraTech Cement") && cement.includes("Ambuja Cement"), cement.join(", "));

  const health = names("Apollo Hospitals and Fortis Healthcare run the largest networks.", {
    sources: [{ domain: "apollohospitals.com" }, { domain: "fortishealthcare.com" }],
  });
  check("healthcare: multi-word names found", health.length === 2, health.join(", "));

  // Casing comes from the answer, not from title-casing the domain label.
  const realty = names("DLF is the largest listed developer.", { sources: [{ domain: "dlf.in" }] });
  check("acronym keeps its real casing (DLF, not Dlf)", realty[0] === "DLF", realty.join(", "));
  const fintech = names("PhonePe leads UPI volume.", { sources: [{ domain: "phonepe.com" }] });
  check("intercaps preserved (PhonePe, not Phonepe)", fintech[0] === "PhonePe", fintech.join(", "));

  // A domain whose brand is never written about must not be invented.
  const absent = names("Only Mamaearth is discussed here.", {
    sources: [{ domain: "mamaearth.in" }, { domain: "nykaa.com" }],
  });
  check("uncited brand is not fabricated", !absent.some((n) => /nykaa/i.test(n)), absent.join(", "));
}

console.log("\none company is reported once, not split by spelling");
{
  const out = detectBrands(
    "**HDFC Bank** offers the lowest rate. HDFC Bank also has the widest branch network.",
    "HDFC Bank offers the lowest rate. HDFC Bank also has the widest branch network.",
    { sources: [{ domain: "hdfcbank.com" }] }
  ).brands;
  const hdfc = out.filter((b) => /hdfc/i.test(b.brand));
  check("no duplicate entry from domain + structure", hdfc.length === 1, out.map((b) => b.brand).join(", "));
  check("mentions are summed, not halved", hdfc[0] && hdfc[0].count === 2, hdfc[0] && String(hdfc[0].count));
}

console.log("\nstructural candidates: table first column vs. heading (real capture — gaming mouse under ₹1,000)");
{
  // Trimmed down from an actual captured ChatGPT answer that reproduced two
  // real bugs: "Zebronics Transformer M Plus" (row 4 of the table) never
  // appeared in Brand Mentions at all, and "CS2"/"BGMI" — game names from a
  // "For Valorant / CS2 / BGMI → Kreo Harpy" recommendation heading — showed
  // up as fake brand cards instead.
  const answer =
    "### Best gaming mice under ₹1,000\n\n" +
    "| Mouse | Approx. price | Best for |\n" +
    "|---|---:|---|\n" +
    "| **EvoFox Blaze Ultra** | ₹600–700 | Best overall |\n" +
    "| **Kreo Harpy** | ₹600–700 | FPS / fast aim |\n" +
    "| **daWg Slay 25** | ₹850–900 | Best sensor |\n" +
    "| **Zebronics Transformer M Plus** | ₹500–600 | Best value |\n" +
    "| **EvoFox Phantom Air** | ₹550–650 | Lightweight gaming |\n" +
    "| **Ant Esports GM100 V2** | ₹300–400 | Cheapest decent option |\n\n" +
    "The **EvoFox Blaze Ultra** stands out as the safest all-round choice.\n\n" +
    "### My recommendation\n\n" +
    "**For Valorant / CS2 / BGMI → Kreo Harpy**  \n" +
    "Its ~55g weight makes it particularly attractive for quick FPS movements.\n\n" +
    "**For mixed gaming → EvoFox Blaze Ultra**\n\n" +
    "If you can stretch further, look at the **Logitech G102** or **Razer DeathAdder Essential**.";

  const found = names(answer, {});
  check(
    "Zebronics Transformer M Plus is NOT missing (4-word, digit-free table cell)",
    found.some((n) => /zebronics/i.test(n)),
    found.join(", ")
  );
  check("daWg still detected (table cell, has a digit)", found.includes("daWg"), found.join(", "));
  check("Ant still detected (table cell, has a digit)", found.includes("Ant"), found.join(", "));
  check(
    "EvoFox Blaze Ultra and EvoFox Phantom Air both kept whole",
    found.includes("EvoFox Blaze Ultra") && found.includes("EvoFox Phantom Air"),
    found.join(", ")
  );
  check("Kreo Harpy still detected", found.includes("Kreo Harpy"), found.join(", "));
  check(
    "CS2 is NOT a fake brand (bare token from a game list before the arrow)",
    !found.some((n) => /^cs2$/i.test(n)),
    found.join(", ")
  );
  check(
    "BGMI is NOT a fake brand (bare token from a game list before the arrow)",
    !found.some((n) => /^bgmi$/i.test(n)),
    found.join(", ")
  );
  check(
    "'For Valorant' is NOT a fake brand (starts with the noise word 'for')",
    !found.some((n) => /valorant/i.test(n)),
    found.join(", ")
  );

  // Mention order should follow the table's real row order, not skip/shuffle
  // around the now-fixed Zebronics gap.
  const order = detectBrands(answer, answer, {}).brands.map((b) => b.brand);
  // Word-boundary match, not a bare substring search — "Ant" is a substring
  // of "phANTom", which would otherwise match the wrong entry.
  const idx = (needle) => order.findIndex((n) => new RegExp(`\\b${needle}\\b`, "i").test(n));
  check(
    "mention order matches the table: Blaze Ultra, Kreo Harpy, daWg, Zebronics, Phantom Air, Ant",
    idx("Blaze Ultra") < idx("Kreo Harpy") &&
      idx("Kreo Harpy") < idx("daWg") &&
      idx("daWg") < idx("Zebronics") &&
      idx("Zebronics") < idx("Phantom Air") &&
      idx("Phantom Air") < idx("Ant"),
    order.join(", ")
  );
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
