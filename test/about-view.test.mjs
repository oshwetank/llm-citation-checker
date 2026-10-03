/*
 * about-view.test.mjs — the rules behind the About tab (0.51.0).
 *
 * About is five pages now (Overview, Metric glossary, Settings, Data & tools,
 * Diagnostics) and the popup opens on a "Get started" checklist. The parts
 * with rules in them are in src/lib/aboutView.js; this pins them. The glossary
 * itself is the real one (src/lib/glossary.js), so the search is checked
 * against the terms the tool actually defines.
 */
import { glossaryView, pickedTerm, startProgress, settingsState, settingValue, storageMeter, logView, buildStatus, ABOUT_STEPS, ABOUT_NEWS, GLOSSARY_GROUPS } from "../src/lib/aboutView.js";
import { glossaryEntries } from "../src/lib/glossary.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const entries = glossaryEntries();

console.log("\nThe metric glossary");
{
  const all = glossaryView(entries);
  check("every term is listed", all.total === entries.length && all.matches.length === entries.length, `${all.matches.length} of ${entries.length}`);
  check("in the glossary's own groups, in reading order",
    all.groups.map((g) => g.name).join("|") === GLOSSARY_GROUPS.filter((g) => entries.some((e) => e.group === g)).join("|"), all.groups.map((g) => g.name).join(" | "));
  check("a chip per group, plus All, each with its count",
    all.chips[0].id === "all" && all.chips[0].count === entries.length && all.chips.slice(1).reduce((a, c) => a + c.count, 0) === entries.length,
    all.chips.map((c) => `${c.label} ${c.count}`).join(", "));
  check("All is the chip that's on", all.chips.filter((c) => c.on).map((c) => c.id).join() === "all");

  const cited = glossaryView(entries, { query: "cited" });
  check("a search keeps the terms that mention it", cited.matches.length > 0 && cited.matches.length < entries.length
    && cited.matches.every((e) => `${e.term} ${e.what} ${e.formula || ""}`.toLowerCase().includes("cited")), cited.matches.map((e) => e.key).join(", "));
  check("it finds Cited % by name", cited.matches.some((e) => e.key === "citedRate"));
  const two = glossaryView(entries, { query: "Cited ANSWERS" });
  check("every word has to match, in any case", two.matches.length > 0 && two.matches.length <= cited.matches.length
    && two.matches.every((e) => /answers/i.test(`${e.term} ${e.what} ${e.formula}`)), two.matches.map((e) => e.key).join(", "));
  const none = glossaryView(entries, { query: "zebra" });
  check("a word that's nowhere empties the list", none.matches.length === 0 && none.groups.length === 0);

  const src = glossaryView(entries, { group: "Source metrics" });
  check("a group chip keeps that group only", src.matches.length > 0 && src.matches.every((e) => e.group === "Source metrics") && src.groups.length === 1);
  check("and is the chip that's on", src.chips.find((c) => c.on).id === "Source metrics");
  const both = glossaryView(entries, { query: "visibility", group: "Source metrics" });
  check("search and group together", both.matches.every((e) => e.group === "Source metrics") && both.matches.some((e) => e.key === "domainVisibility"), both.matches.map((e) => e.key).join(", "));

  check("the picked term stays picked while it's listed", pickedTerm(cited, "citedRate").key === "citedRate");
  check("and falls back to the first listed when filtered out", pickedTerm(src, "visibility").key === src.matches[0].key);
  check("nothing to pick from an empty list", pickedTerm(none, "visibility") === null);
}

console.log("\nGet started (the popup's home)");
{
  const fresh = startProgress({});
  check("a fresh install is welcomed, with nothing done", fresh.title === "Welcome to CitoSkeleton" && fresh.done === 0 && fresh.text === "0 of 3 done");
  const sampleOnly = startProgress({ realCaptures: 0, analyzed: true, campaigns: 0 });
  check("opening the sample in Analyze doesn't count", sampleOnly.done === 0, JSON.stringify(sampleOnly.steps.map((s) => s.done)));
  const asked = startProgress({ realCaptures: 3 });
  check("a real capture is step one", asked.steps.map((s) => s.done).join() === "true,false,false" && asked.title === "CitoSkeleton");
  const read = startProgress({ realCaptures: 3, analyzed: true });
  check("opening it in Analyze is step two", read.steps.map((s) => s.done).join() === "true,true,false" && read.text === "2 of 3 done");
  const all = startProgress({ realCaptures: 3, analyzed: true, campaigns: 1 });
  check("a campaign is step three, and then it's all done", all.allDone && all.done === 3);
}

console.log("\nSettings");
{
  const saved = { retentionMax: 2000, maxCaptureMB: 8, debugCapture: false };
  check("unchanged reads as saved", !settingsState(saved, { ...saved }).dirty && settingsState(saved, { ...saved }).status === "All settings saved");
  const edit = settingsState(saved, { ...saved, retentionMax: 2050 });
  check("any change is unsaved", edit.dirty && edit.status === "Unsaved changes" && edit.tone === "warn");
  check("the debugger switch counts as a change", settingsState(saved, { ...saved, debugCapture: true }).dirty);
  check("right after a save it says so", settingsState(saved, { ...saved }, { justSaved: true }).status === "Settings saved");
  check("changing back is not a change", !settingsState(saved, { ...saved, maxCaptureMB: 8 }).dirty);
  check("typed values keep to their minimum", settingValue("retentionMax", "10") === 50 && settingValue("maxCaptureMB", "0") === 1 && settingValue("retentionMax", "abc") === 50 && settingValue("retentionMax", "3000") === 3000);
}

console.log("\nStorage");
{
  const m = storageMeter({ stored: 1240, keep: 2000, usedBytes: 38.6 * 1024 * 1024 });
  check("how full, against the limit", m.pct === 62 && m.text === "1,240 of 2,000 kept" && !m.warn, JSON.stringify(m));
  check("and how much disk", /^38\.6 MB on disk\./.test(m.sub), m.sub);
  check("warns from 90%, before the oldest start going", storageMeter({ stored: 1800, keep: 2000 }).warn && !storageMeter({ stored: 1799, keep: 2000 }).warn);
  check("never past 100%", storageMeter({ stored: 2600, keep: 2000 }).pct === 100);
}

console.log("\nThe activity log");
{
  const log = [{ cat: "error" }, { cat: "turn" }, { cat: "turn" }, { cat: "capture" }, {}];
  const v = logView(log);
  check("counts per kind, with an entry missing its kind counted as an error",
    v.chips.map((c) => `${c.id}=${c.count}`).join() === "all=5,error=2,turn=2,capture=1" && v.errors === 2, v.chips.map((c) => `${c.id}=${c.count}`).join());
  check("a filter keeps that kind", logView(log, "turn").rows.length === 2 && logView(log, "turn").chips.find((c) => c.on).id === "turn");
}

console.log("\nIs every part the same version");
{
  const ok = buildStatus({ ok: true, build: "0.51.0" }, "0.51.0");
  check("same build: up to date, with the version", !ok.stale && ok.title === "Up to date" && ok.sub === "Version 0.51.0");
  const old = buildStatus({ ok: true, build: "0.50.0" }, "0.51.0");
  check("another build: needs a reload, naming both", old.stale && old.title === "Needs a reload" && /0\.51\.0/.test(old.line) && /0\.50\.0/.test(old.line), old.line);
  const ancient = buildStatus({ ok: false, error: "unknown message type" }, "0.51.0");
  check("a background too old to answer is out of date too", ancient.stale && /an older version/.test(ancient.line));
  const down = buildStatus({ ok: false, error: "no connection" }, "0.51.0");
  check("a broken connection isn't called out of date", !down.stale && !down.known);
}

console.log("\nThe Overview's words");
{
  check("four steps, one tab each, and no Compare tab (it opens from an answer since 0.47.0)",
    ABOUT_STEPS.length === 4 && ABOUT_STEPS.slice(1).map((s) => s.tab).join() === "analyze,dashboard,loader" && !ABOUT_STEPS.some((s) => /compare/i.test(s.where)));
  check("what's new is written out", ABOUT_NEWS.length >= 3 && ABOUT_NEWS.every((n) => n.head && n.body));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
