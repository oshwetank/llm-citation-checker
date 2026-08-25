/*
 * mention-list.test.mjs — what the Brand Mentions card is allowed to show.
 *
 * Reported, with a screenshot: the card listed "Google Pixel 10a ×5" and
 * "Google ×9" as two separate brands, in a five-brand list where two of the
 * five were the same company. One company's mention count was split across two
 * rows and the reader saw the same name twice.
 *
 * The same SKU-collapse rule the campaign competitor list uses applies here:
 * a name whose leading words are another detected name IS that name. The SKU
 * isn't discarded — it becomes a model chip on the parent's row, which is what
 * that row already exists to show.
 */
import { normalizeMentions } from "../src/lib/mention-list.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const m = (brand, count = 1, extra = {}) => ({ brand, count, passages: [`about ${brand}`], ...extra });

console.log("\nthe reported case: a SKU listed beside its own maker");
{
  const out = normalizeMentions([
    m("Google Pixel 10a", 5),
    m("Google", 9),
    m("OnePlus 13R", 4),
    m("vivo V60", 4),
    m("iQOO 13", 2),
  ]);
  const names = out.map((b) => b.brand);
  check("five detections become four brands", out.length === 4, names.join(", "));
  check("the SKU is gone from the top level",
    !names.includes("Google Pixel 10a"), names.join(", "));
  check("its maker is kept", names.includes("Google"), names.join(", "));
  const g = out.find((b) => b.brand === "Google");
  check("the counts are added, not split", g.count === 14, String(g.count));
  check("the SKU is preserved as a model of the parent",
    g.skus.includes("Google Pixel 10a"), g.skus.join(", "));
  check("a SKU with no maker in the answer stays on its own",
    names.includes("OnePlus 13R") && names.includes("vivo V60"), names.join(", "));
}

console.log("\norder is first appearance, and a merge takes the earliest");
{
  // The card ranks by this order, so a merge must not shuffle the list.
  const out = normalizeMentions([m("Acme", 1), m("Globex Ultra 5", 1), m("Globex", 1), m("Initech", 1)]);
  // Globex was first seen at position 2, as "Globex Ultra 5". A company is
  // first named the moment any of its names appears, so the merged row holds
  // that slot — but it is LABELLED "Globex", the maker's own spelling, which
  // was detected later in the same answer.
  check("the order of the survivors is preserved",
    out.map((b) => b.brand).join("|") === "Acme|Globex|Initech",
    out.map((b) => b.brand).join("|"));
  const g = out[1];
  check("the merged row sits where its earliest part appeared", g.count === 2, String(g.count));
  check("and is labelled with the maker's name, not the SKU", g.brand === "Globex", g.brand);
  check("the SKU is kept as a model chip", g.skus.join(",") === "Globex Ultra 5", g.skus.join(","));
}

console.log("\nonly a whole-word prefix collapses");
{
  const out = normalizeMentions([m("Apple"), m("Applebees"), m("Applied Materials")]);
  check("a name that merely starts with the same letters is left alone",
    out.length === 3, out.map((b) => b.brand).join(", "));
}

console.log("\naliases still work, and feed the SKU pass");
{
  const out = normalizeMentions([m("Galaxy", 3), m("Samsung", 2)]);
  check("a sub-brand with no shared words folds into its parent",
    out.length === 1 && out[0].brand === "Samsung", out.map((b) => b.brand).join(", "));
  check("with the counts added", out[0].count === 5, String(out[0].count));

  // The alias runs FIRST so the prefix pass can see the real parent:
  // "Google Pixel" -> "Google", which "Google Pixel 10a" then collapses onto.
  const chained = normalizeMentions([m("Google Pixel", 1), m("Google Pixel 10a", 1)]);
  check("an aliased parent still absorbs its own SKUs",
    chained.length === 1 && chained[0].brand === "Google",
    chained.map((b) => b.brand).join(", "));
}

console.log("\nheadings the detector mistook for brands are dropped");
{
  const out = normalizeMentions([m("Battery"), m("Sony"), m("Overall"), m("Performance")]);
  check("generic section words are removed", out.length === 1, out.map((b) => b.brand).join(", "));
  // The bug this list once caused: "sony" was in it, so every genuine Sony
  // mention vanished from this card for every industry, permanently.
  check("a real brand is never treated as noise", out[0].brand === "Sony", out[0].brand);
}

console.log("\nwhat a merged row carries forward");
{
  const out = normalizeMentions([
    m("Acme Widget Pro", 2, { relation: "own" }),
    m("Acme", 1),
  ]);
  check("one row", out.length === 1, String(out.length));
  check("the own-brand flag survives the merge", out[0].relation === "own", String(out[0].relation));
  check("passages from both parts are kept", out[0].passages.length === 2, String(out[0].passages.length));
  check("and the SKU is listed once", out[0].skus.length === 1, out[0].skus.join(", "));
}

console.log("\na carousel-only appearance keeps its zero");
{
  // count 0 means "shown in a product card but never named in the prose" —
  // a real signal, distinct from absence, and it must not become a 1.
  const out = normalizeMentions([m("Acme", 0)]);
  check("zero stays zero", out[0].count === 0, String(out[0].count));
}

console.log("\ndegenerate input never throws");
{
  check("nothing at all", normalizeMentions(null).length === 0);
  check("an empty list", normalizeMentions([]).length === 0);
  check("a nameless entry", normalizeMentions([{ count: 3 }]).length === 0);
  check("a null entry", normalizeMentions([null, m("Acme")]).length === 1);
  check("missing passages", normalizeMentions([{ brand: "Acme", count: 1 }])[0].passages.length === 0);
  check("a non-numeric count", normalizeMentions([{ brand: "Acme", count: "x" }])[0].count === 0);
}

console.log("\nvendor names the capture states outright are used as roots");
{
  // Reported: "Brand Mention and the Products & Entities section is not
  // matching with brands." The card listed SKUs — "Realme P4", "iQOO Z11x",
  // "OnePlus Nord CE6 Lite" — while the Entities card right below it listed
  // the vendors ChatGPT itself had tagged: Realme, iQOO, OnePlus.
  const vendors = ["Realme", "iQOO", "OnePlus"];
  const out = normalizeMentions([
    m("Realme P4", 9),
    m("iQOO Z11x", 2),
    m("OnePlus Nord CE6 Lite", 1),
    m("Motorola Edge 70 Fusion", 1),
  ], vendors);
  const names = out.map((b) => b.brand);

  check("rows are labelled with the vendor, not the SKU",
    names.slice(0, 3).join("|") === "Realme|iQOO|OnePlus", names.join("|"));
  check("the SKU is kept as a model of its maker",
    out[0].skus.includes("Realme P4"), out[0].skus.join(", "));
  check("counts follow the maker", out[0].count === 9, String(out[0].count));

  // A brand with no product card is still a real mention. It stays, and it
  // stays under its own name — the absence from Products is information (the
  // engine wrote about it without carding it), not something to paper over.
  check("a brand with no vendor entity is not dropped",
    names.includes("Motorola Edge 70 Fusion"), names.join("|"));
  check("order of first appearance survives", names.length === 4, names.join("|"));
}

console.log("\na known vendor that was never mentioned gets no row");
{
  // The list must agree with the Entities card, not invent mentions from it.
  const out = normalizeMentions([m("Realme P4", 3)], ["Realme", "Samsung", "Nokia"]);
  check("only the mentioned vendor appears", out.length === 1, out.map((b) => b.brand).join(", "));
  check("and it is named correctly", out[0].brand === "Realme", out[0].brand);
}

console.log("\nvendor roots are held to the same rules as any other name");
{
  check("a noise word passed in as a vendor is ignored",
    normalizeMentions([m("Battery Pack Pro", 1)], ["Battery"]).length === 1);
  check("whole-word prefixes only",
    normalizeMentions([m("Applebees", 1)], ["Apple"])[0].brand === "Applebees",
    normalizeMentions([m("Applebees", 1)], ["Apple"])[0].brand);
  check("an empty vendor list changes nothing",
    normalizeMentions([m("Realme P4", 1)], [])[0].brand === "Realme P4");
  check("a null vendor list is safe",
    normalizeMentions([m("Realme P4", 1)], null)[0].brand === "Realme P4");
  check("blank vendor entries are skipped",
    normalizeMentions([m("Realme P4", 1)], ["", "  "])[0].brand === "Realme P4");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
