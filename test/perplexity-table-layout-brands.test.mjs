/*
 * perplexity-table-layout-brands.test.mjs — a comparison table whose first
 * column is a USE-CASE label, not the product name, must not report that
 * label as a "brand mention."
 *
 * Real bug, reported from a real capture (fixtures/perplexity-cameraPhoneTableLayout.txt,
 * "best camera phone under 30000"): "if the layout of the answer changes
 * the tool is not able to tell the exact brand." The exported PDF's Brand
 * Mentions section read:
 *
 *   #1 Optical Zoom — 3 mentions
 *   #2 Versatile Triple Camera — 1 mention
 *   #3 High-Resolution Still Photos — 1 mention
 *   #4 Balanced All-Rounder — 1 mention
 *
 * — the table's "Best For" column, not a single real phone brand (Nothing,
 * Motorola, Redmi, Realme, CMF all went completely undetected, even though
 * they're right there in the table's "Phone" column, one column over).
 *
 * Root cause: parseMarkdownTables() (src/lib/brands.js) always took column 0
 * as the name, unless it looked like a bare rank cell (a medal/digit/#) — in
 * which case it took column 1. Column 0 here is prose ("Optical Zoom"), not
 * a rank cell, so the old rule confidently, silently picked the wrong
 * column on every single row. Fixed by preferring whichever column's own
 * header says it holds the name ("Phone", "Product", "Model", ...).
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(new URL("./fixtures/perplexity-cameraPhoneTableLayout.txt", import.meta.url), "utf8");
const json = raw.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();

console.log("\nperplexity-table-layout-brands: a use-case-led table reports the real brands, not the use-case column");

const rec = await adapt({
  captureId: "test-camera-phone-table-layout",
  raw: json,
  reqBody: JSON.stringify({ query: "best camera phone under 30000" }),
  capturedAt: Date.now(),
  pageUrl: "https://www.perplexity.ai",
});

const brandNames = rec.brandMentions.map((b) => b.brand.toLowerCase());

for (const real of ["nothing", "motorola", "redmi", "realme", "cmf"]) {
  check(`real brand "${real}" (from the table's 'Phone' column) is detected`, brandNames.some((n) => n.includes(real)), brandNames.join(", "));
}

for (const fake of ["optical zoom", "versatile triple camera", "high-resolution still photos", "balanced all-rounder", "budget zoom option"]) {
  check(`the use-case label "${fake}" (the table's 'Best For' column) is NOT reported as a brand`,
    !brandNames.some((n) => n === fake), brandNames.join(", "));
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
