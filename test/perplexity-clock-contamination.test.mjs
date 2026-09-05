/*
 * perplexity-clock-contamination.test.mjs — a bare clock time or duration
 * badge from Perplexity's UI never becomes the captured prompt or a fake
 * fan-out sub-query.
 *
 * Real bug, reported from a real capture: the prompt was recorded as "21:51"
 * (a literal clock time, not "best camera phone under 58000" — the question
 * actually asked), and the fan-out list included "21:51 · 1s" and
 * "21:51 · 2s" as if they were real sub-queries the engine ran, plus the
 * answer's own opening paragraph (~260 chars, under the old 300-char cap)
 * and a markdown table header whose cells had been DOM-joined with no space
 * between them ("PhoneWhy it's great for photosTrade-offsTypical price
 * (Aug 2026)"). The capture happened while Perplexity was shown in its
 * fullscreen/immersive reader presentation — a different surface than the
 * normal threaded chat view content-iso.js's selectors are built against —
 * so the exact DOM element responsible isn't known; this guards the
 * SYMPTOMS defensively rather than a specific selector.
 *
 * Extracts the actual regex/logic added to content-iso.js by source-string
 * matching, the same technique perplexity-fanout.test.mjs already uses for
 * PPLX_STEP_LABEL_RE — a full DOM-fixture test isn't possible here since the
 * real fullscreen-mode markup was never captured.
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

console.log("\nperplexity-clock-contamination: the clock-rejection pattern rejects only clock/duration text");

const clockLit = (src.match(/const looksLikeClock = \(s\) => (\/.*\/i)\.test/) || [])[1];
check("looksLikeClock's regex literal was found in content-iso.js", !!clockLit);

if (clockLit) {
  const re = new RegExp(clockLit.slice(1, clockLit.lastIndexOf("/")), clockLit.slice(clockLit.lastIndexOf("/") + 1));
  // The exact bad values from the real capture.
  check('rejects "21:51" (the real bad prompt)', re.test("21:51"));
  check('rejects "21:51 · 1s" (the real bad fan-out entry)', re.test("21:51 · 1s"));
  check('rejects "21:51 · 2s"', re.test("21:51 · 2s"));
  check('rejects a bare duration alone, "9:05"', re.test("9:05"));
  // Real prompts/queries must never be mistaken for a clock reading.
  check('accepts "best camera phone under 58000" (a real prompt)', !re.test("best camera phone under 58000"));
  check('accepts "Samsung Galaxy S24 camera review 2026" (a real sub-query)', !re.test("Samsung Galaxy S24 camera review 2026"));
  check('accepts "OnePlus 13" (a real short answer)', !re.test("OnePlus 13"));
}

console.log("\nperplexity-clock-contamination: prompt extraction scrubs a clock reading before it can be used");

check("promptText is scrubbed with looksLikeClock before the fallback chain runs",
  /if \(looksLikeClock\(promptText\)\) promptText = "";/.test(src));
check("titleFromDoc is scrubbed the same way", /if \(looksLikeClock\(titleFromDoc\)\) titleFromDoc = "";/.test(src));
check("generatedTitle is scrubbed the same way", /if \(looksLikeClock\(generatedTitle\)\) generatedTitle = "";/.test(src));

console.log("\nperplexity-clock-contamination: fan-out sub-query rows reject the same garbage");

check("the fan-out length cap was tightened off the old 300 (a ~260-char answer paragraph slipped under it)",
  !/if \(t\.length < 3 \|\| t\.length > 300\)/.test(src));
check("fan-out rows also reject a bare clock/duration reading",
  /if \(\/\^\\d\{1,2\}:\\d\{2\}\(\\s\*\[·•\]\\s\*\\d\+\\s\*s\)\?\$\/i\.test\(t\)\) continue;/.test(src));
check("fan-out rows reject the missing-space concatenation artifact (2+ lowerCase-to-UpperCase joins)",
  /\(t\.match\(\/\[a-z\]\[A-Z\]\/g\) \|\| \[\]\)\.length >= 2/.test(src));

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
