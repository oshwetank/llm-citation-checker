/*
 * glossary.test.mjs — one definition per term, tool-wide.
 *
 * Requested: "add a proper definition and formula... let's make this properly
 * in a proper format and consistent across the tool. Don't mention peec.ai or
 * any other tool name please."
 *
 * The definitions used to be written inline at each call site, so the same
 * metric was explained three different ways on three different screens and a
 * wording fix had to be made in all three. Centralising them only helps if the
 * table stays disciplined, which is what this file enforces: every entry has
 * the same shape, every key the UI asks for exists, and no vendor names.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GLOSSARY, glossaryText, glossaryEntries, glossaryGroups } from "../src/lib/glossary.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const entries = glossaryEntries();

console.log("\nevery entry has the same shape");
{
  check("there are entries", entries.length > 15, String(entries.length));
  const badTerm = entries.filter((g) => !g.term || typeof g.term !== "string");
  check("every term has a display name", !badTerm.length, badTerm.map((g) => g.key).join(", "));

  // The point of a fixed shape: a definition that is sometimes a formula and
  // sometimes a sentence teaches nothing.
  const badWhat = entries.filter((g) => !g.what || !/^[A-Z]/.test(g.what) || !/[.?]$/.test(g.what.trim()));
  check("every 'what' is a complete sentence", !badWhat.length, badWhat.map((g) => g.key).join(", "));

  const badFormula = entries.filter((g) => g.formula !== null && g.formula !== undefined
    && (typeof g.formula !== "string" || !g.formula.trim()));
  check("a formula is either a real string or explicitly null",
    !badFormula.length, badFormula.map((g) => g.key).join(", "));

  const withFormula = entries.filter((g) => g.formula);
  check("most terms carry a formula", withFormula.length >= entries.length / 2,
    `${withFormula.length}/${entries.length}`);

  const badNote = entries.filter((g) => g.note !== undefined
    && (typeof g.note !== "string" || !g.note.trim()));
  check("a note, where present, is real text", !badNote.length, badNote.map((g) => g.key).join(", "));

  const badHowToUse = entries.filter((g) => !g.howToUse || typeof g.howToUse !== "string" || !g.howToUse.trim());
  check("every term carries actionable howToUse guidance", !badHowToUse.length, badHowToUse.map((g) => g.key).join(", "));
}

console.log("\nthe reference list is grouped, because names legitimately repeat");
{
  const groups = glossaryGroups();
  check("there are groups", groups.length >= 3, groups.map((g) => g.group).join(", "));
  check("every term lands in one", groups.reduce((n, g) => n + g.terms.length, 0) === entries.length,
    `${groups.reduce((n, g) => n + g.terms.length, 0)} of ${entries.length}`);
  const ungrouped = entries.filter((g) => !g.group);
  check("no entry is missing its group", !ungrouped.length, ungrouped.map((g) => g.key).join(", "));

  // The reason grouping exists: "Citations" means a brand's own site being
  // cited in one place and a source being cited in another. Both are correct
  // labels; a flat list showed the same word twice with no way to tell them
  // apart.
  const dupes = entries.filter((g, i) => entries.findIndex((x) => x.term === g.term) !== i);
  check("terms that repeat are in different groups",
    dupes.every((d) => entries.filter((x) => x.term === d.term)
      .map((x) => x.group).filter((v, i, a) => a.indexOf(v) === i).length > 1),
    dupes.map((d) => d.term).join(", "));

  const perGroup = groups.every((g) => new Set(g.terms.map((t) => t.term)).size === g.terms.length);
  check("and no group repeats a term within itself", perGroup,
    groups.map((g) => `${g.group}:${g.terms.length}`).join(", "));
}

console.log("\nno third-party product names");
{
  // Explicitly requested. These are definitions of what THIS tool measures.
  const banned = /peec|profound|otterly|ziptie|semrush|ahrefs|scrunch|athena|seoclarity|nectiv/i;
  const hits = entries.filter((g) => banned.test(JSON.stringify(g)));
  check("no competitor tool is named in any definition",
    !hits.length, hits.map((g) => g.key).join(", "));

  // …and not in the source files that feed the UI either.
  for (const f of ["src/lib/glossary.js", "src/lib/geo.js", "src/lib/sources.js",
                   "src/lib/fanout.js", "ui/panel.js"]) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    // Word-boundary: "speech" contains the letters but is not the vendor.
    const found = src.match(/\bpeec(?:\.ai)?\b/gi);
    check(`${f} names no vendor`, !found, found && found.join(", "));
  }
}

console.log("\nevery key the UI asks for exists");
{
  // A data-term pointing at a missing key renders no tooltip at all, which
  // fails silently — exactly the sort of thing that survives to production.
  const panel = readFileSync(path.join(ROOT, "ui/panel.js"), "utf8");
  const used = [...panel.matchAll(/"data-term":\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  check("the panel uses data-term at all", used.length > 10, String(used.length));

  const missing = [...new Set(used)].filter((k) => !GLOSSARY[k]);
  check("every data-term key resolves to a definition",
    !missing.length, missing.join(", "));

  // Variable keys (`"data-term": term`) can't be checked statically, so the
  // count above is a floor, not the whole set.
  const unused = Object.keys(GLOSSARY).filter((k) => !used.includes(k));
  console.log(`  · ${unused.length} term(s) reached only through variables or the About reference: ${unused.join(", ") || "none"}`);
}

console.log("\nthe headline metrics are all defined");
{
  ["visibility", "shareOfVoice", "avgPosition", "mentions", "citations", "sourceVisibility",
   "domainVisibility", "domainCitations", "readOnly", "responses"].forEach((k) =>
    check(`"${k}" is defined`, !!GLOSSARY[k], k));
}

console.log("\nreach and volume are defined as different things");
{
  // The distinction the source table exists to make. If both definitions read
  // the same, the two columns are indefensible.
  const vis = GLOSSARY.domainVisibility;
  const cit = GLOSSARY.domainCitations;
  check("visibility is described per response",
    /response/i.test(vis.formula) && /at least once/i.test(vis.what),
    `${vis.what} / ${vis.formula}`);
  check("citations is described per occurrence",
    /every time|sum of every/i.test(`${cit.what} ${cit.formula}`), `${cit.what} / ${cit.formula}`);
  check("each note points at the other, so neither can be misread alone",
    /volume/i.test(vis.note) && /reach/i.test(cit.note), `${vis.note} || ${cit.note}`);
}

console.log("\nread-only is not described as 'never retrieved'");
{
  // The single most misread number in the tool: these pages WERE fetched.
  const ro = GLOSSARY.readOnly;
  check("the note says so explicitly", /never retrieved/i.test(ro.note), ro.note);
  check("and says the page was actually read", /actually read|was read/i.test(ro.note), ro.note);
}

console.log("\nthe flat text form is usable as a title attribute");
{
  const t = glossaryText("visibility");
  check("it names the term", t.startsWith("Brand Visibility"), t);
  check("it includes the formula", /Formula:/.test(t), t);
  check("it is a single line", !/\n/.test(t));
  check("an unknown key returns empty rather than throwing", glossaryText("nope") === "");
  check("no key returns empty", glossaryText() === "");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
