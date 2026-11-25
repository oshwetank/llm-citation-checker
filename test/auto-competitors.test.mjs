/*
 * auto-competitors.test.mjs — a campaign with no competitors configured must
 * still measure something.
 *
 * Reported: "if i have not added competition should not the cited brands
 * become my competition automatically?"
 *
 * Every brand-facing number in the Dashboard (Share of Voice, Position, the
 * Brands column in the source drill-down) is computed against the tracked
 * brand set. With only the own brand in that set, Share of Voice is 100% by
 * construction, Position is always #1, and the Brands column shows one name —
 * an empty campaign that looks like a winning one.
 *
 * The rules asserted here are the ones that make the inference safe to trust:
 * it ranks by how many RESPONSES a brand appears in (not raw mentions), it
 * never overrides competitors the user actually typed, and it never writes
 * anything back into the profile.
 */
import {
  autoCompetitorsFrom, effectiveTrackedBrands, trackedBrandsOf, computeMetrics, computeSeries,
} from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const rec = (capturedAt, brands, answerText = "") => ({
  captureId: `c${capturedAt}`,
  capturedAt,
  platform: "chatgpt",
  answerText: answerText || brands.map((b) => (typeof b === "string" ? b : b.brand)).join(" then "),
  sources: [],
  brandMentions: brands.map((b) => (typeof b === "string" ? { brand: b, count: 1 } : b)),
});

const profile = { id: "p1", name: "Test", brand: { name: "Acme", url: "acme.com" }, competitors: [] };

console.log("\ninferring competitors from the captures");
{
  const records = [
    rec(1, ["Acme", "Globex", "Initech"]),
    rec(2, ["Globex", "Initech"]),
    rec(3, ["Globex"]),
    rec(4, ["Umbrella"]),
  ];
  const auto = autoCompetitorsFrom(records, profile);
  const names = auto.map((c) => c.name);

  check("the own brand is never proposed as its own competitor",
    !names.includes("Acme"), names.join(", "));
  check("ranked by responses appeared in, most first",
    names.join("|") === "Globex|Initech|Umbrella", names.join("|"));
  check("response counts are per response, not per mention",
    auto[0].responses === 3 && auto[2].responses === 1,
    auto.map((c) => `${c.name}=${c.responses}`).join(", "));
  check("every inferred entry is flagged auto", auto.every((c) => c.auto === true));
  check("none is flagged as the own brand", auto.every((c) => c.isOwn === false));
}

console.log("\na brand named many times in ONE answer is not a top competitor");
{
  // The distinction the ranking exists for: consistency across answers beats
  // volume inside a single one.
  const records = [
    rec(1, [{ brand: "Loud", count: 40 }]),
    rec(2, [{ brand: "Steady", count: 1 }]),
    rec(3, [{ brand: "Steady", count: 1 }]),
  ];
  const names = autoCompetitorsFrom(records, profile).map((c) => c.name);
  check("the brand in two answers outranks the one shouted in a single answer",
    names[0] === "Steady", names.join("|"));
}

console.log("\na competitor is a brand, not a SKU");
{
  // Detection legitimately returns both spellings from the same corpus.
  // Counted separately they split one competitor's share of voice in two, and
  // the SKU row under-matches — brandPresence looks for that exact string, so
  // a plain "Vivo" mention would not count towards "vivo X200 FE".
  const records = [rec(1, ["Vivo"]), rec(2, ["vivo X200 FE"]), rec(3, ["Vivo"])];
  const auto = autoCompetitorsFrom(records, profile);
  check("Vivo and vivo X200 FE collapse to one entry", auto.length === 1, String(auto.length));
  check("kept the brand, which is the spelling that matches everywhere",
    auto[0].name === "Vivo", auto[0].name);
  check("all three responses counted towards it", auto[0].responses === 3, String(auto[0].responses));

  // …but only a genuine prefix collapses. "Vivid" is not "Vivo", and
  // "Applebee's" is not "Apple".
  const distinct = autoCompetitorsFrom([rec(1, ["Apple", "Applebees"])], profile);
  check("a name that merely starts with the same letters stays separate",
    distinct.length === 2, distinct.map((c) => c.name).join("|"));
}

console.log("\nconfigured competitors always win");
{
  const configured = { ...profile, competitors: [{ name: "Globex", url: "globex.com" }] };
  const records = [rec(1, ["Acme", "Globex", "Initech", "Umbrella"])];

  const auto = autoCompetitorsFrom(records, configured);
  check("a competitor the user typed is not re-proposed",
    !auto.some((c) => c.name === "Globex"), auto.map((c) => c.name).join(", "));

  const eff = effectiveTrackedBrands(configured, records);
  check("with any competitor configured, nothing is inferred at all",
    eff.length === 2 && !eff.some((b) => b.auto), eff.map((b) => b.name).join(", "));
  check("it is exactly what the profile configures",
    JSON.stringify(eff) === JSON.stringify(trackedBrandsOf(configured)));
}

console.log("\neffectiveTrackedBrands fills the gap only when there is one");
{
  const records = [rec(1, ["Acme", "Globex"]), rec(2, ["Globex", "Initech"])];
  const eff = effectiveTrackedBrands(profile, records);
  check("the own brand is still first and still flagged own",
    eff[0].name === "Acme" && eff[0].isOwn === true);
  check("inferred competitors were appended", eff.length === 3, String(eff.length));
  check("each inferred one is distinguishable from a configured one",
    eff.slice(1).every((b) => b.auto === true));

  const noRecords = effectiveTrackedBrands(profile, []);
  check("no captures means no invented competitors", noRecords.length === 1, String(noRecords.length));
}

console.log("\nnothing is written back to the profile");
{
  const records = [rec(1, ["Acme", "Globex"])];
  const before = JSON.stringify(profile);
  autoCompetitorsFrom(records, profile);
  effectiveTrackedBrands(profile, records);
  check("the profile object is untouched", JSON.stringify(profile) === before);
}

console.log("\nthe metrics actually change once the set is wider");
{
  const records = [rec(1, ["Acme", "Globex"]), rec(2, ["Globex"])];

  const narrow = computeMetrics(records, profile);
  check("with the own brand alone, Share of Voice is 100% by construction",
    Math.round(narrow.own.shareOfVoice) === 100, String(narrow.own.shareOfVoice));

  const wide = computeMetrics(records, profile, effectiveTrackedBrands(profile, records));
  check("with inferred competitors it becomes a real number",
    wide.own.shareOfVoice < 100 && wide.own.shareOfVoice > 0, String(wide.own.shareOfVoice));
  check("the competitor appears in the brand table",
    wide.brands.some((b) => b.name === "Globex"), wide.brands.map((b) => b.name).join(", "));
  check("the inferred flag survives into the metrics rows",
    wide.brands.find((b) => b.name === "Globex").auto === true);
  check("the own brand row is not flagged auto",
    wide.brands.find((b) => b.isOwn).auto === false);
}

console.log("\nthe trend series uses ONE brand set across every bucket");
{
  // Resolved per bucket, "Globex" would exist on day 1 and vanish on day 2,
  // and the trend line would move for reasons unrelated to the trend.
  const day = 86400000;
  const records = [
    rec(day * 1, ["Acme", "Globex"]),
    rec(day * 2, ["Acme"]),
  ];
  const brands = effectiveTrackedBrands(profile, records);
  const series = computeSeries(records, profile, "day", brands);
  check("two buckets", series.length === 2, String(series.length));
  check("both buckets carry the same brand set",
    series.every((s) => s.brands.length === brands.length),
    series.map((s) => s.brands.length).join("|"));
  check("the competitor is present-but-zero in the bucket it is absent from",
    series[1].brands.find((b) => b.name === "Globex")?.mentions === 0);
}

console.log("\na group is shown by the spelling the answers use most (1.0.7)");
{
  // Couriers campaign, live test of 25 Nov 2026: "India Post" (31 answers)
  // folded onto a one-off "India" and was offered as "+ India".
  const records = [
    rec(1, ["India Post"]), rec(2, ["India Post"]), rec(3, ["India Post"]), rec(4, ["India"]),
    rec(5, ["Ecom Express"]), rec(6, ["Ecom Express"]), rec(7, ["Ecom"]),
    rec(8, ["Vivo"]), rec(9, ["Vivo"]), rec(10, ["vivo X200 FE"]),
  ];
  const names = autoCompetitorsFrom(records, profile).map((b) => b.name);
  check("India Post, not India", names.includes("India Post") && !names.includes("India"), names.join("|"));
  check("Ecom Express, not Ecom", names.includes("Ecom Express") && !names.includes("Ecom"), names.join("|"));
  check("Vivo still absorbs its model", names.includes("Vivo") && !names.some((n) => /X200/.test(n)), names.join("|"));
  check("the group still counts every answer", autoCompetitorsFrom(records, profile).find((b) => b.name === "India Post")?.responses === 4);
  // R3 paints campaign: a page title, used more often, is not a better name.
  const long = autoCompetitorsFrom([rec(1, ["Starshield- Smart Paints & Coatings"]), rec(2, ["Starshield- Smart Paints & Coatings"]), rec(3, ["Starshield"])], profile).map((b) => b.name);
  check("a much longer spelling never takes over", long.includes("Starshield"), long.join("|"));
}

console.log("\ndegenerate input never throws");
{
  check("null records", autoCompetitorsFrom(null, profile).length === 0);
  check("null profile", Array.isArray(autoCompetitorsFrom([rec(1, ["A"])], null)));
  check("records with no brandMentions",
    autoCompetitorsFrom([{ captureId: "x", capturedAt: 1 }], profile).length === 0);
  check("blank brand names are dropped",
    autoCompetitorsFrom([rec(1, [{ brand: "  ", count: 1 }])], profile).length === 0);
  check("limit is respected",
    autoCompetitorsFrom([rec(1, ["A", "B", "C", "D"])], profile, 2).length === 2);
  check("a zero limit yields nothing",
    autoCompetitorsFrom([rec(1, ["A", "B"])], profile, 0).length === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
