/*
 * perplexity-cite-marker-brands.test.mjs — a cited domain never gets reported
 * as a "brand mention" just because its own citation marker sits in the text
 * detectBrands() scans.
 *
 * Real bug, reproduced from a real user capture (fixtures/perplexity-
 * cameraPhoneCiteMarkers.txt, "best camera phone under 58000"): the DOM
 * harvester (content-iso.js) writes each inline citation as
 * [[cite:https://full/url]] directly after the cited sentence — a DIFFERENT
 * shape from the bare-footnote-token-on-its-own-line format
 * perplexity-citation-footnote-brands.test.mjs already guards. Nothing
 * stripped these markers before brand detection ran, so the raw citation URL
 * sat right there in the scanned text — and a cited-domain candidate
 * ("mobileburn.com" -> "Mobileburn") trivially matched its OWN URL inside its
 * own citation marker, every time it was cited. Three review/listicle sites
 * (mobileburn.com, bhalophone.com, goalmoneytrack.com — none of them a phone
 * brand) reached the real campaign's Brand Mentions list this way, each with
 * a bogus mention count that was really just its citation count.
 *
 * Fixed in two layers: stripCiteMarkersForDetection() in perplexity.js
 * removes [[cite:URL]] from a detection-only copy of the text (the STORED
 * answerText keeps the markers — exportDoc.js needs them to render numbered
 * footnotes), and the three domains from the real report are also added to
 * brands.js's EDITORIAL_DOMAINS as defense-in-depth.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(new URL("./fixtures/perplexity-cameraPhoneCiteMarkers.txt", import.meta.url), "utf8");
const json = raw.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();

console.log("\nperplexity-cite-marker-brands: a domain cited via [[cite:URL]] does not match itself");

const rec = await adapt({
  captureId: "test-camera-phone",
  raw: json,
  reqBody: null,
  capturedAt: Date.now(),
  pageUrl: "https://www.perplexity.ai",
});

const brandNames = rec.brandMentions.map((b) => b.brand.toLowerCase());

// The regression itself: every review/listicle domain from the real bug
// report must be gone.
for (const falsePositive of ["mobileburn", "bhalophone", "goalmoneytrack"]) {
  check(`"${falsePositive}" (a cited review site, not a phone brand) is not in brandMentions`,
    !brandNames.some((n) => n.includes(falsePositive)), `brandMentions: ${brandNames.join(", ")}`);
}
// Already-curated editorial domains cited the same way must stay excluded too.
for (const falsePositive of ["hindustantimes", "indiatoday"]) {
  check(`"${falsePositive}" (already in EDITORIAL_DOMAINS) is not in brandMentions`,
    !brandNames.some((n) => n.includes(falsePositive)), `brandMentions: ${brandNames.join(", ")}`);
}

// Real phone brands actually being compared must still be detected —
// this is the guard against the fix being too aggressive.
for (const real of ["oneplus", "samsung"]) {
  check(`real brand "${real}" is still detected`, brandNames.some((n) => n.includes(real)), brandNames.join(", "));
}

// Sources must be completely unaffected — this fix touches only the text
// handed to brand detection, never the sources list.
check("all sources are still present", rec.sources.length > 0, String(rec.sources.length));
check("mobileburn.com is still a real source", rec.sources.some((s) => s.domain === "mobileburn.com"));

// The stored/displayed answerText must KEEP its [[cite:URL]] markers —
// exportDoc.js's PPLX_CITE_RE relies on them surviving here to render
// numbered footnotes at export time. Only the detection-only copy is cleaned.
check("stored answerText still carries [[cite:URL]] markers for export",
  /\[\[cite:https?:\/\//.test(rec.answerText));

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
