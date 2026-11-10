/*
 * onboarding.test.mjs — the first-run experience, and the guarantee that
 * sample data can never be mistaken for (or mixed into) real captures.
 *
 * On a fresh install every screen renders as zeros, so a new user has no way
 * to tell what the tool measures or whether it works at all. The fix is one
 * realistic sample capture plus a short tour. The risk that creates is
 * obvious and is what most of this file guards: fabricated data sitting in
 * the same store as real captures, silently skewing a real brand's share of
 * voice. Every property below exists to make that impossible.
 */
import { readFileSync } from "node:fs";
import { buildDemoRecords, isDemoRecord, DEMO_PREFIX } from "../src/lib/demo-data.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nonboarding: sample data is always identifiable as sample data");

const recs = buildDemoRecords();

check("at least one sample record is produced", recs.length >= 1);
check("every record is flagged isDemo", recs.every((r) => r.isDemo === true));
check("every capture id carries the demo prefix", recs.every((r) => r.captureId.startsWith(DEMO_PREFIX)));
check("isDemoRecord() recognises them", recs.every(isDemoRecord));

// Both halves matter independently: the flag could be lost by a round-trip
// through storage, and the id could collide with nothing else. Either alone
// must be enough to identify a demo row.
check("the flag alone is enough to identify one", isDemoRecord({ captureId: "abc", isDemo: true }));
check("the id prefix alone is enough to identify one", isDemoRecord({ captureId: `${DEMO_PREFIX}x` }));
check("a real capture is never mistaken for demo data",
  !isDemoRecord({ captureId: "3a8be08e-1c6b-4eec-90e7-f1e38eb50de3", platform: "perplexity" }));
check("a null/undefined record does not throw or match", !isDemoRecord(null) && !isDemoRecord(undefined));

console.log("\nonboarding: the sample is SHAPED like a real capture");

{
  const r = recs[0];
  // A demo where everything is perfectly cited would teach the wrong mental
  // model of the one metric this tool exists to report.
  const cited = r.sources.filter((s) => s.outcome === "cited").length;
  const fetched = r.sources.filter((s) => s.outcome === "fetched").length;
  check("it has BOTH cited and merely-retrieved sources", cited > 0 && fetched > 0, `cited=${cited} fetched=${fetched}`);
  check("retrieved outnumber cited, as in real captures", fetched >= 2 && r.sources.length >= 5, `${cited}/${r.sources.length}`);

  check("it has multi-step fan-out", r.fanout.search.length >= 2, String(r.fanout.search.length));
  check("sources are attributed to the sub-query that surfaced them",
    r.sources.some((s) => s.platformSpecific && s.platformSpecific.queryPlanQuery),
    "no queryPlanQuery on any source");
  check("it has brand mentions with real counts", r.brandMentions.length >= 3 && r.brandMentions.every((b) => b.count > 0));

  // The answer must exercise the rendering paths a real one does.
  check("the answer contains a markdown table", /\|\s*---\s*\|/.test(r.answerText));
  check("the answer contains headings", /^##\s/m.test(r.answerText));
  check("the answer contains bold product names", /\*\*[^*]+\*\*/.test(r.answerText));
  check("the answer contains positional citation markers", /\[\[cite:https?:\/\//.test(r.answerText));

  // Honesty properties carried over from the metadata work.
  check("no model name is invented", r.model === null, String(r.model));
  check("it is not attributed to a campaign", r.geo === null);
  check("it has no rawRef, since no raw payload exists behind it", !r.rawRef, String(r.rawRef));
  check("its extraction notes say plainly that it is not real",
    (r._extraction.notes || []).some((n) => /sample/i.test(n)), JSON.stringify(r._extraction.notes));
}

console.log("\nonboarding: wiring");

{
  const bg = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../ui/panel.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");

  check("background handles demo-load", /case "demo-load"/.test(bg));
  check("background handles demo-clear", /case "demo-clear"/.test(bg));
  check("background handles demo-status", /case "demo-status"/.test(bg));

  // Written ONLY to "derived": there is no raw payload, and inventing one
  // would make "Reprocess all captures" re-derive a fabricated capture as if
  // it were real.
  const loadBlock = bg.slice(bg.indexOf('case "demo-load"'), bg.indexOf('case "demo-clear"'));
  check("sample data is never written to the raw store",
    !/db\.put\("raw"/.test(loadBlock), "demo-load must not touch the raw store");

  // Clearing must be surgical.
  const clearBlock = bg.slice(bg.indexOf('case "demo-clear"'), bg.indexOf('case "demo-status"'));
  check("clearing removes only demo rows", /filter\(isDemoRecord\)/.test(clearBlock));
  check("clearing never clears the whole store", !/db\.clear\(/.test(clearBlock));

  // 0.81.0: the guide is a page of its own (ui/welcome.html), re-opened from About.
  check("the guide exists and can be opened again", /welcome\.html/.test(panel) && /replayTour/.test(panel));
  check("first-run runs once, guarded by a persisted flag", /TOUR_SEEN_KEY/.test(panel));
  check("sample data is shown with a visible banner", /demo-banner/.test(panel));
  check("About exposes load/remove and replay controls",
    /id="demoToggle"/.test(html) && /id="replayTour"/.test(html));

  // First run must not push samples into a store that already has real data.
  const firstRun = panel.slice(panel.indexOf("async function maybeFirstRun"));
  check("sample data is only auto-loaded on a genuinely empty install",
    /status\.real === 0/.test(firstRun), "must check for existing real captures first");
}

console.log("\nonboarding: the version shown to users matches the manifest");

{
  // These drifted: the manifest read 0.32.0 while both badges still said
  // 0.31.0, so the About tab reported a version the user was not running.
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
  const badges = [...html.matchAll(/version-badge">v([\d.]+)</g)].map((m) => m[1]);
  check("at least one version badge is rendered", badges.length > 0);
  check("every badge matches the manifest version",
    badges.every((b) => b === manifest.version),
    `manifest=${manifest.version} badges=${badges.join(",")}`);
}

console.log("\nonboarding: engine lists are complete");

{
  const html = readFileSync(new URL("../ui/panel.html", import.meta.url), "utf8");
  // The Compare filter offered only ChatGPT and Gemini, so a Perplexity or
  // Grok capture could never be filtered to — another two-engine leftover
  // from when there were two.
  for (const e of ["chatgpt", "gemini", "perplexity", "grok"]) {
    check(`the Compare engine filter includes ${e}`, html.includes(`option value="${e}"`));
  }
  check("the header names more than two engines",
    /ChatGPT, Gemini, Perplexity/.test(html), "brand-sub is stale");
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
