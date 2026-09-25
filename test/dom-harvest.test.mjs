/*
 * dom-harvest.test.mjs — the DOM harvester actually runs to completion.
 *
 * Perplexity has no usable answer stream on the network path (its GraphQL
 * WebSocket carries the sidebar's recent-threads subscription, not the
 * answer), so the DOM harvester in content-iso.js is the ONLY thing that
 * captures a Perplexity answer at all. When it breaks, Perplexity capture
 * goes to zero silently.
 *
 * It broke exactly that way: `generatedTitle` was declared `let` INSIDE
 * `if (plat === "perplexity") { ... }` but read from the shared payload
 * block below the platform branches, so every successful harvest threw
 * "ReferenceError: generatedTitle is not defined" — for Grok and Claude too,
 * since the read is on the common path. The throw escaped from a setTimeout
 * callback (the try/catch there wraps only sendMessage, not the payload
 * construction), so there was no capture, no error toast, and nothing in the
 * page console anyone was watching.
 *
 * Why a normal syntax check does not catch this: it is valid JavaScript.
 * `node --check` passes, the CI ESM parse passes. Only EXECUTING the
 * function surfaces it. So this test executes it — the real function body,
 * lifted out of content-iso.js and run against a minimal DOM stub, once per
 * platform. Any ReferenceError from block-scoping fails the test.
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

// tryHarvest calls domToMarkdown(), which lives in content-iso.js's enclosing
// scope rather than inside tryHarvest itself — so a body executed in
// isolation has to be handed the REAL implementation, not a stub. Extracted
// from source the same way tryHarvest is, so this stays honest if it changes.
function extractDomToMarkdown(source) {
  const start = source.indexOf("const domToMarkdown = (root) => {");
  if (start === -1) return "const domToMarkdown = (n) => (n && (n.innerText || n.textContent)) || \"\";";
  const bodyStart = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return "const domToMarkdown = (root) => " + source.slice(bodyStart, i + 1) + ";";
    }
  }
  return "const domToMarkdown = (n) => (n && (n.innerText || n.textContent)) || \"\";";
}
const DOM2MD = extractDomToMarkdown(src);

// tryHarvest also calls harvestPerplexitySteps(), another enclosing-scope
// sibling. Same rule as domToMarkdown: hand the body the REAL one, pulled
// from source, so this harness can't quietly diverge from shipped code.
function extractStepsHelper(source) {
  const grab = (decl, open, close) => {
    const at = source.indexOf(decl);
    if (at === -1) return "";
    const s = source.indexOf(open, at);
    let d = 0;
    for (let i = s; i < source.length; i++) {
      if (source[i] === open) d++;
      else if (source[i] === close) { d--; if (d === 0) return source.slice(at, i + 1) + ";"; }
    }
    return "";
  };
  const reLine = (source.match(/const PPLX_STEP_LABEL_RE = .*;/) || [""])[0];
  const selectors = grab("const PPLX_STEP_SELECTORS = [", "[", "]");
  const fn = grab("const harvestPerplexitySteps = (doc) => {", "{", "}");
  if (!fn) return "const harvestPerplexitySteps = () => [];";
  return [reLine, selectors, fn].filter(Boolean).join(String.fromCharCode(10));
}
const STEPS = extractStepsHelper(src);


// Lift `const tryHarvest = () => { ... };` out by brace matching.
function extractTryHarvest() {
  const start = src.indexOf("const tryHarvest = () => {");
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart + 1, i);
    }
  }
  return null;
}

const body = extractTryHarvest();
check("tryHarvest() found in content-iso.js", !!body, "function renamed or removed?");

console.log("\ndom-harvest: harvester runs without throwing");

if (body) {
  // Minimal DOM stub: enough shape for the selectors the harvester uses,
  // returning content substantial enough to reach the payload block (which
  // is the part that was throwing).
  function makeEnv(plat) {
    const sent = [];
    const node = (text) => ({
      textContent: text,
      innerText: text,
      href: "https://example.com/a",
      getAttribute: () => null,
    });
    const doc = {
      title: "Some Thread - Perplexity",
      querySelector: () => node("a heading or bubble"),
      querySelectorAll: () => [node("A".repeat(80))],
    };
    return {
      sent,
      scope: {
        getPlatform: () => plat,
        document: doc,
        location: { href: `https://${plat}.example/thread/1` },
        chrome: {
          runtime: {
            sendMessage: (msg) => { sent.push(msg); },
            get lastError() { return undefined; },
          },
        },
      },
    };
  }

  for (const plat of ["perplexity", "grok"]) {
    const { sent, scope } = makeEnv(plat);
    const names = Object.keys(scope);
    const fn = new Function(...names, `${DOM2MD}
${STEPS}\nlet lastHarvestedSig = null;\n${body}`);
    let threw = null;
    try {
      fn(...names.map((n) => scope[n]));
    } catch (e) {
      threw = e;
    }
    check(
      `${plat}: harvest completes without throwing`,
      !threw,
      threw && `${threw.constructor.name}: ${threw.message}`
    );
    check(`${plat}: a capture was sent`, sent.length > 0, "no raw-conversation message emitted");

    if (sent.length) {
      const payload = sent[0]?.payload;
      let parsed = null;
      try { parsed = JSON.parse(payload.raw); } catch (_) {}
      check(`${plat}: payload carries answer text`, !!(parsed && parsed.text), "raw had no .text");
      check(`${plat}: payload marked as dom harvest`, parsed?.harvestSource === "dom");
    }
  }
}

// --- Sources-panel auto-expand (real bug: a collapsed <button
// aria-expanded="false">Sources</button> means its <a href> list siblings
// carry no real content yet — the harvester used to just read whatever
// happened to already be in the DOM, so a collapsed panel meant most of
// Perplexity's ~10 sources were simply never there to find. See a real
// DevTools capture of this exact markup in the bug report this fixes.) ---
if (body) {
  console.log("\ndom-harvest: Perplexity Sources-panel auto-expand");

  const promptNode = { textContent: "best wireless speakers under 5000", innerText: "best wireless speakers under 5000", getAttribute: () => null };
  const proseNode = { textContent: "X".repeat(80), innerText: "X".repeat(80), getAttribute: () => null };
  const linkNode = (href) => ({ href, textContent: "A real source title", innerText: "A real source title", getAttribute: () => null });

  function makeSourcesEnv(expandedAtStart) {
    // Two "Sources"-labelled controls, modelling a real Perplexity page: a
    // compact top-right pill (decoy — never gates the link list, but IS a
    // disclosure button and DOES start collapsed) and the actual accordion
    // trigger whose sibling mounts the <a> list. Both must get clicked; the
    // fix must not stop after the first (decoy) match.
    let expanded = expandedAtStart;
    let decoyExpanded = expandedAtStart;
    const clicks = [];
    const pillBtn = {
      textContent: "Sources10", // the compact "Sources [icons] 10 >" pill
      getAttribute: (name) => (name === "aria-expanded" ? String(decoyExpanded) : null),
      click: () => { clicks.push("pill"); decoyExpanded = true; },
    };
    const sourcesBtn = {
      textContent: "Sources", // the real accordion trigger gating the <a> list
      getAttribute: (name) => (name === "aria-expanded" ? String(expanded) : null),
      click: () => { clicks.push("accordion"); expanded = true; },
    };
    const scheduled = [];
    const doc = {
      title: "best wireless speakers under 5000 - Perplexity",
      querySelector: () => promptNode,
      querySelectorAll: (sel) => {
        if (sel === "button[aria-expanded]") return [pillBtn, sourcesBtn];
        if (sel.startsWith("a[href")) return expanded ? [linkNode("https://a.example/1"), linkNode("https://b.example/2")] : [];
        if (sel.includes(".prose")) return [proseNode];
        return [];
      },
    };
    const scope = {
      getPlatform: () => "perplexity",
      document: doc,
      location: { href: "https://perplexity.ai/thread/1" },
      setTimeout: (fn) => { scheduled.push(fn); return scheduled.length; },
      // The follow-up goes through the harvester's scheduleHarvest (a due time
      // the run's clock also checks, so a throttled page timer can't strand
      // it) — record it the same way a bare setTimeout was recorded before.
      scheduleHarvest: (ms) => { scheduled.push(ms); },
      chrome: { runtime: { sendMessage: (msg) => sent.push(msg), get lastError() { return undefined; } } },
    };
    const sent = [];
    scope.chrome.runtime.sendMessage = (msg) => sent.push(msg);
    const names = [...Object.keys(scope), "tryHarvest"];
    const fn = new Function(...names, `${DOM2MD}
${STEPS}\nlet lastHarvestedSig = null;\nlet sourcesExpandAttempts = 0;\n${body}`);
    return { fn, names, scope, sent, scheduled, clicks, isExpanded: () => expanded };
  }

  // Case 1: panel starts collapsed.
  {
    const { fn, names, scope, sent, scheduled, clicks, isExpanded } = makeSourcesEnv(false);
    let threw = null;
    try {
      fn(...names.map((n) => (n === "tryHarvest" ? fn : scope[n])));
    } catch (e) { threw = e; }
    check("collapsed panel: harvest completes without throwing", !threw, threw && `${threw.constructor.name}: ${threw.message}`);
    check("collapsed panel: BOTH matching controls get clicked, not just the first", clicks.length === 2 && clicks.includes("pill") && clicks.includes("accordion"), `clicked: ${clicks.join(", ")}`);
    check("collapsed panel: aria-expanded flips as a result", isExpanded() === true);
    check("collapsed panel: no capture is sent on this pass (bails to let the expand settle)", sent.length === 0, `sent ${sent.length}`);
    check("collapsed panel: a follow-up harvest is scheduled instead", scheduled.length === 1);
  }

  // Case 2: panel already expanded — normal harvest, links are found.
  {
    const { fn, names, scope, sent, clicks } = makeSourcesEnv(true);
    let threw = null;
    try {
      fn(...names.map((n) => (n === "tryHarvest" ? fn : scope[n])));
    } catch (e) { threw = e; }
    check("expanded panel: harvest completes without throwing", !threw, threw && `${threw.constructor.name}: ${threw.message}`);
    check("expanded panel: the trigger is left alone (already open)", clicks.length === 0);
    check("expanded panel: a capture is sent", sent.length === 1);
    if (sent.length) {
      let parsed = null;
      try { parsed = JSON.parse(sent[0].payload.raw); } catch (_) {}
      check("expanded panel: both sources are captured", (parsed?.web_results || []).length === 2, `got ${(parsed?.web_results || []).length}`);
    }
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
