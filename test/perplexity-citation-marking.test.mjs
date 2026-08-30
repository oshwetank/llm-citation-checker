/*
 * perplexity-citation-marking.test.mjs — sources harvested from a Perplexity
 * page get outcome:"cited" when a real inline citation pill names their
 * domain, and stay "fetched" otherwise.
 *
 * This is built directly from a real captured DOM node (2026-08-29), not a
 * guess at Perplexity's markup:
 *
 *   <span class="inline-block relative !mt-0 ![vertical-align:unset]
 *     max-w-[25ch] overflow-hidden"
 *     style="mask-image: linear-gradient(to right, black 70%, transparent
 *     100%);">gadgets.beebom</span>
 *
 * Two bugs existed together, and either one alone would have kept this
 * failing silently:
 *
 *   1. The badge selector was `[class*="citation"], .citation, ...` — this
 *      real badge has no "citation" anywhere in its classes, so it was never
 *      even collected into the candidate set.
 *   2. The domain-match compared the badge text against `host.split(".")[0]`
 *      — the FIRST label only. "gadgets.beebom.com" -> hostName "gadgets",
 *      but the badge strips to "gadgetsbeebom". Those can never be equal, so
 *      even a perfect selector would still have failed to mark ANY
 *      multi-label domain as cited.
 *
 * Both were fixed together in content-iso.js. This test proves it end to
 * end by running the real tryHarvest() body against a DOM stub built from
 * the actual captured markup, rather than asserting against the regex in
 * isolation (which would pass even if the two pieces never actually connect
 * inside the real function).
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

console.log("\nperplexity-citation-marking: real captured badge markup");

if (body) {
  // A DOM stub that discriminates by selector, unlike dom-harvest.test.mjs's
  // one-size-fits-all stub — this test needs the prompt bubble, the answer
  // prose, the source links, and the citation badges to each return
  // DIFFERENT elements, since the matching logic depends on all four being
  // wired together correctly.
  function makeNode({ text = "", href = null, attrs = {}, style = "" } = {}) {
    return {
      textContent: text,
      innerText: text,
      href,
      style,
      getAttribute: (name) => (name === "style" ? style : attrs[name] ?? null),
    };
  }

  function buildDom({ includeRealBadge, sourceHost, sourceTitle }) {
    const userBubble = makeNode({ text: "best gaming phones under 30000" });
    const answerProse = makeNode({ text: "Long answer text ".repeat(10) });
    const sourceLink = makeNode({ href: `https://${sourceHost}/some-article`, text: sourceTitle });

    // The exact real markup from the capture, reproduced faithfully.
    const realBadge = makeNode({
      text: "gadgets.beebom",
      style: "mask-image: linear-gradient(to right, black 70%, transparent 100%);",
      attrs: { class: "inline-block relative !mt-0 ![vertical-align:unset] max-w-[25ch] overflow-hidden" },
    });

    return {
      title: "some thread - Perplexity",
      querySelector(sel) {
        if (/user-query|userMessage|UserMessage|queryBubble/.test(sel)) return userBubble;
        if (/^h1, h2/.test(sel)) return null;
        return null;
      },
      querySelectorAll(sel) {
        if (/prose|answer-content|thread-message/.test(sel)) return [answerProse];
        if (sel.includes('a[href^="http"]')) return [sourceLink];
        if (sel.includes("citation") || sel.includes("mask-image")) {
          return includeRealBadge ? [realBadge] : [];
        }
        return [];
      },
    };
  }

  function runHarvest({ includeRealBadge, sourceHost, sourceTitle }) {
    const sent = [];
    const scope = {
      getPlatform: () => "perplexity",
      document: buildDom({ includeRealBadge, sourceHost, sourceTitle }),
      location: { href: "https://www.perplexity.ai/search/abc123" },
      chrome: {
        runtime: {
          sendMessage: (msg) => { sent.push(msg); },
          get lastError() { return undefined; },
        },
      },
    };
    const names = Object.keys(scope);
    const fn = new Function(...names, `${DOM2MD}\nlet lastHarvestedSig = null;\n${body}`);
    fn(...names.map((n) => scope[n]));
    if (!sent.length) return null;
    return JSON.parse(sent[0].payload.raw);
  }

  // Case 1: the real badge is present, source domain matches it (multi-label,
  // TLD dropped by Perplexity's own label — exactly the captured case).
  {
    const payload = runHarvest({ includeRealBadge: true, sourceHost: "gadgets.beebom.com", sourceTitle: "Top Gaming Phones Under 30000" });
    check("harvest with the real badge produces a source", !!(payload && payload.web_results && payload.web_results.length));
    const source = payload?.web_results?.[0];
    check(
      "gadgets.beebom.com is marked cited by the real captured badge",
      source?.outcome === "cited",
      `got outcome=${source?.outcome}`
    );
  }

  // Case 2: no badge at all — the source must NOT be marked cited just
  // because it exists. Guards against a match that is too eager.
  {
    const payload = runHarvest({ includeRealBadge: false, sourceHost: "gadgets.beebom.com", sourceTitle: "Top Gaming Phones Under 30000" });
    const source = payload?.web_results?.[0];
    check(
      "same domain with NO badge present stays fetched, not cited",
      source?.outcome !== "cited",
      `got outcome=${source?.outcome}`
    );
  }

  // Case 3: the badge is present, but the source is an unrelated domain —
  // must not cross-contaminate.
  {
    const payload = runHarvest({ includeRealBadge: true, sourceHost: "digit.in", sourceTitle: "Digit" });
    const source = payload?.web_results?.[0];
    check(
      "unrelated domain.in is NOT marked cited by the gadgets.beebom badge",
      source?.outcome !== "cited",
      `got outcome=${source?.outcome}`
    );
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
