/*
 * campaign-edit.test.mjs — campaigns without the friction (0.77.0).
 *
 * The owner: adding the competitors a run found meant opening the campaign
 * and unlocking it, and making changes was tedious. Now:
 *   - a locked campaign is edited in place; only the brand and its website
 *     still need the unlock (needsUnlock);
 *   - every change to a locked campaign is logged (profileChanges, changeText);
 *   - one call adds a competitor: never the own brand, never twice, and it
 *     undoes leaving that brand out (addCompetitor);
 *   - the prompt template has Primary and Secondary tag columns, and reading
 *     a file puts the primary tag first (promptTemplate.js, rowsToPrompts).
 * Made-up brands only.
 */
import { makeProfile, needsUnlock, profileChanges, addCompetitor, changeText, autoCompetitorsFrom } from "../src/lib/geo.js";
import { promptTemplateWorkbook, promptTemplateCsv, TEMPLATE_HEADERS } from "../src/lib/promptTemplate.js";
import { parseXlsx, parseCsv, rowsToPrompts } from "../src/lib/xlsxLite.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const base = makeProfile({ id: "p1", name: "Run shoes", brand: { name: "Zento", url: "zento.example" }, competitors: [{ name: "Kovo", url: "" }], engines: ["chatgpt", "gemini"], locked: true, excludedBrands: ["Lumi"] });

console.log("\nwhat a locked campaign lets you change");
check("a new competitor, engines or measures: no unlock", !needsUnlock(base, { ...base, competitors: [...base.competitors, { name: "Lumora" }], engines: ["chatgpt"], measure: { citations: true } }));
check("the brand name: unlock", needsUnlock(base, { ...base, brand: { name: "Zento Labs", url: "zento.example" } }));
check("the website: unlock", needsUnlock(base, { ...base, brand: { name: "Zento", url: "zento.example.org" } }));
check("the same brand in other case or spacing: no unlock", !needsUnlock(base, { ...base, brand: { name: " zento ", url: "ZENTO.example" } }));
check("a patch without a brand: no unlock", !needsUnlock(base, { name: "Renamed" }));
check("an unlocked campaign: never", !needsUnlock({ ...base, locked: false }, { ...base, brand: { name: "Other", url: "o.example" } }));

console.log("\nthe change log");
const after = makeProfile({ ...base, competitors: [{ name: "Lumora", url: "" }], engines: ["chatgpt", "perplexity"], measure: { citations: true, products: true } });
const ch = profileChanges(base, after, 1000);
check("added and removed competitors", ch.some((c) => c.kind === "competitor-added" && c.name === "Lumora") && ch.some((c) => c.kind === "competitor-removed" && c.name === "Kovo"), JSON.stringify(ch));
check("engines, with before and after", ch.some((c) => c.kind === "engines" && c.detail === "chatgpt, gemini → chatgpt, perplexity"));
check("what the board measures", ch.some((c) => c.kind === "measure"));
check("no entry when nothing changed", profileChanges(base, makeProfile({ ...base }), 1).length === 0);
check("each entry has its time", ch.every((c) => c.at === 1000));
check("in words", changeText(ch.find((c) => c.kind === "competitor-added")) === "Added competitor Lumora" && changeText({ kind: "prompts-added", count: 3 }) === "Added 3 prompts");
check("makeProfile keeps the log", makeProfile({ ...base, changes: ch }).changes.length === ch.length);
check("and caps it", makeProfile({ ...base, changes: Array.from({ length: 400 }, (_, i) => ({ at: i, kind: "measure" })) }).changes.length === 300);

console.log("\nadding a competitor in one click");
const a1 = addCompetitor(base, { name: "Lumi" }, 5);
check("added, on a locked campaign", a1.added && a1.profile.competitors.map((c) => c.name).join() === "Kovo,Lumi");
check("which undoes leaving it out", !a1.profile.excludedBrands.includes("Lumi"));
check("and is logged", a1.profile.changes.at(-1).kind === "competitor-added" && a1.profile.changes.at(-1).name === "Lumi" && a1.profile.changes.at(-1).at === 5);
check("still locked", a1.profile.locked === true);
check("never twice (any case)", addCompetitor(a1.profile, { name: "lumi" }).added === false);
check("never the own brand", !!addCompetitor(base, { name: "ZENTO" }).error);
check("needs a name", !!addCompetitor(base, { name: "  " }).error);
check("an unlocked campaign isn't logged", addCompetitor({ ...base, locked: false }, { name: "Lumi" }).profile.changes.length === 0);

console.log("\nsuggestions stay once the campaign has competitors");
const recs = [
  { brandMentions: [{ brand: "Zento", count: 2 }, { brand: "Kovo", count: 1 }, { brand: "Lumora", count: 1 }, { brand: "Nimbo", count: 1 }] },
  { brandMentions: [{ brand: "Lumora", count: 1 }] },
];
const sugg = autoCompetitorsFrom(recs, a1.profile).map((x) => x.name);
check("brands named but not on the list are still offered", sugg.join() === "Lumora,Nimbo", sugg.join());

console.log("\nthe template: Prompt, Primary tag, Secondary tag");
check("the CSV has the three columns", promptTemplateCsv().split("\n")[0] === "Prompt,Primary tag,Secondary tag");
const fromCsv = rowsToPrompts(parseCsv(promptTemplateCsv()));
check("and reads back, primary first", fromCsv.length === 3 && fromCsv[0].tags.join("|") === "Buying guide|Footwear|Comparison" && fromCsv[0].primary === "Buying guide", JSON.stringify(fromCsv[0]));
check("a row without a secondary tag", fromCsv[1].tags.join("|") === "Durability");
const wb = promptTemplateWorkbook({ tags: ["Buying guide", "Trail", 'Has "quotes"'] });
const files = wb.files();
const sheet1 = files.find((f) => f.name === "xl/worksheets/sheet1.xml").text;
check("the .xlsx offers the campaign's tags as a dropdown on Primary tag", /<dataValidation type="list"[^>]*sqref="B2:B1000"><formula1>&quot;Buying guide,Trail&quot;<\/formula1>/.test(sheet1), sheet1.match(/<dataValidations[\s\S]*?<\/dataValidations>/)?.[0]);
check("with a sheet saying how to fill it", files.some((f) => /workbook\.xml$/.test(f.name) && /How to fill it/.test(f.text)));
const rows = await parseXlsx(await (await wb.toBlob()).arrayBuffer());
check("the .xlsx reads back with the same headers", rows[0].join("|") === TEMPLATE_HEADERS.join("|"), rows[0].join("|"));
const fromXlsx = rowsToPrompts(rows);
check("and the same prompts and tags", JSON.stringify(fromXlsx.map((p) => p.tags)) === JSON.stringify(fromCsv.map((p) => p.tags)), JSON.stringify(fromXlsx));

console.log("\nreading other files");
check("Primary and Secondary columns anywhere, with a Tags column too", JSON.stringify(rowsToPrompts([["S.No", "Secondary tag", "Prompt", "Primary tag", "Tags"], ["1", "b; c", "q one", "a", "d"]])) === JSON.stringify([{ text: "q one", tags: ["a", "b", "c", "d"], primary: "a" }]));
check("the old Tags column still works", JSON.stringify(rowsToPrompts([["Prompt", "Tags"], ["q", "x, y"]])) === JSON.stringify([{ text: "q", tags: ["x", "y"] }]));
check("no header at all still works", rowsToPrompts([["q", "x"]])[0].tags[0] === "x");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
