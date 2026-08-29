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

  for (const plat of ["perplexity", "grok", "claude"]) {
    const { sent, scope } = makeEnv(plat);
    const names = Object.keys(scope);
    const fn = new Function(...names, `let lastHarvestedSig = null;\n${body}`);
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

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
