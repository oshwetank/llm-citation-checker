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
  // 12-hour clocks. The first real capture was 24-hour ("21:51") and the
  // pattern was written for exactly that; a later campaign run on an en-IN
  // Windows machine recorded its question as "2:16 PM" and sailed through.
  check('rejects "2:16 PM" (the real bad prompt from a 12-hour locale)', re.test("2:16 PM"));
  check('rejects "2:16 pm", "2:16PM", "11:05 a.m."', re.test("2:16 pm") && re.test("2:16PM") && re.test("11:05 a.m."));
  check('rejects "2:16 PM · 3s"', re.test("2:16 PM · 3s"));
  // Real prompts/queries must never be mistaken for a clock reading.
  check('accepts "best camera phone under 58000" (a real prompt)', !re.test("best camera phone under 58000"));
  check('accepts "Samsung Galaxy S24 camera review 2026" (a real sub-query)', !re.test("Samsung Galaxy S24 camera review 2026"));
  check('accepts "OnePlus 13" (a real short answer)', !re.test("OnePlus 13"));
  check('accepts a prompt that merely mentions a time, "best phone for 7:30 pm meetings"',
    !re.test("best phone for 7:30 pm meetings"));
}

console.log("\nperplexity-clock-contamination: prompt extraction scrubs a clock reading before it can be used");

check("promptText is scrubbed with looksLikeClock before the fallback chain runs",
  /if \(looksLikeClock\(promptText\)\) promptText = "";/.test(src));
check("titleFromDoc is scrubbed the same way", /if \(looksLikeClock\(titleFromDoc\)\) titleFromDoc = "";/.test(src));
check("generatedTitle is scrubbed the same way", /if \(looksLikeClock\(generatedTitle\)\) generatedTitle = "";/.test(src));

console.log("\nperplexity-clock-contamination: fan-out sub-query rows reject the same garbage");

check("the fan-out length cap was tightened off the old 300 (a ~260-char answer paragraph slipped under it)",
  !/if \(t\.length < 3 \|\| t\.length > 300\)/.test(src));
// The fan-out filter is a separate copy of the same pattern (it lives in a
// different scope from looksLikeClock). Pinning its literal text here is what
// let the 12-hour gap sit unnoticed in one place once fixed in another — so
// instead it must be the SAME pattern the prompt scrub uses, character for
// character, and the strip variant is checked by what it actually does.
check("fan-out rows reject a bare clock reading with exactly the prompt scrub's pattern",
  !!clockLit && src.includes(`if (${clockLit}.test(t)) continue;`));
const stripLit = (src.match(/let t = item\.text\.replace\((\/.*\/i), ""\)\.trim\(\);/) || [])[1];
check("the trailing-clock strip on fan-out rows was found", !!stripLit);
if (stripLit) {
  const strip = new RegExp(stripLit.slice(1, stripLit.lastIndexOf("/")), stripLit.slice(stripLit.lastIndexOf("/") + 1));
  check("a trailing 24-hour badge is stripped, keeping the real query",
    "Samsung S24 camera review21:51 · 1s".replace(strip, "").trim() === "Samsung S24 camera review");
  check("a trailing 12-hour badge is stripped the same way",
    "Samsung S24 camera review 2:16 PM · 1s".replace(strip, "").trim() === "Samsung S24 camera review");
}
check("fan-out rows reject the missing-space concatenation artifact (2+ lowerCase-to-UpperCase joins)",
  /\(t\.match\(\/\[a-z\]\[A-Z\]\/g\) \|\| \[\]\)\.length >= 2/.test(src));

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
