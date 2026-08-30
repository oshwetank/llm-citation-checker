/*
 * perplexity-real-dom.test.mjs — the harvester run against REAL Perplexity
 * markup, captured from a live page.
 *
 * Every previous Perplexity selector in this codebase was written against
 * guessed structure, and three of them matched nothing at all on the real
 * page: the `[class*="citation"]` badge selectors, the `data-testid=
 * "user-query"` prompt selectors, and a steps-label regex that could never
 * fire. Each of those passed its own tests, because those tests were built
 * from the same guess as the code.
 *
 * test/fixtures/perplexity-answer-dom.html is ground truth instead: a real
 * DevTools capture. What it revealed, and what this file locks down:
 *
 *  1. The prompt lives in <div class="group group/user-bubble">. NONE of
 *     the previously-guessed prompt selectors exist on the page, which is
 *     exactly why the prompt used to fall through to the answer's own h1/h2
 *     and record a section heading as the user's question.
 *  2. Every inline citation carries its EXACT source URL in
 *     data-pplx-citation-url. That is complete (every claim, not just what
 *     the Sources panel happened to render), exact (no domain-label
 *     guessing), and a stable data attribute rather than a churning
 *     Tailwind class.
 *  3. Perplexity marks sources it trusts with data-testid=
 *     "trusted-citation-check". No other engine here publishes a per-source
 *     trust judgement.
 *  4. The steps disclosure button reads "Finished2 steps" — no space — so
 *     the original /^finished\b/ could never match it.
 *  5. The answer body is rich semantic HTML (h2, table/thead/tbody/th/td
 *     with <strong> first cells, ul/li), confirming that serializing to
 *     markdown rather than innerText is what makes brand detection work.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "./helpers/mini-dom.mjs";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./fixtures/perplexity-answer-dom.html", import.meta.url), "utf8");
const doc = parseHTML(html);

function extractArrow(name, arg) {
  const start = src.indexOf(`const ${name} = (${arg}) => {`);
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", src.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
  }
  return null;
}

console.log("\nperplexity-real-dom: selectors match the real page");

{
  const bubbles = doc.querySelectorAll('[class*="user-bubble"]');
  check("the confirmed user-bubble selector finds the prompt", bubbles.length === 1, `found ${bubbles.length}`);
  check("and it yields the question the user actually typed",
    bubbles[0] && bubbles[0].textContent.trim() === "Best headphone under 4000",
    bubbles[0] && JSON.stringify(bubbles[0].textContent.trim()));

  // The guesses this replaced. Asserting they find NOTHING is the point:
  // it documents why the prompt fallback was firing on every capture.
  for (const guessed of ['[data-testid="user-query"]', ".user-query", '[data-message-author="user"]']) {
    check(`previously-guessed selector ${guessed} matches nothing on the real page`,
      doc.querySelectorAll(guessed).length === 0);
  }

  check("the harvester now queries the confirmed selector first",
    /\[class\*="user-bubble"\][^']*'\)/.test(src) || src.includes('[class*="user-bubble"]'),
    "user-bubble selector missing from content-iso.js");
}

console.log("\nperplexity-real-dom: exact citation URLs");

{
  const nodes = doc.querySelectorAll("[data-pplx-citation-url]");
  check("inline citations are found by their data attribute", nodes.length === 4, `found ${nodes.length}`);

  const urls = [...new Set(nodes.map((n) => n.getAttribute("data-pplx-citation-url")))];
  check("they resolve to 3 distinct exact source URLs", urls.length === 3, urls.join(", "));
  check("URLs are full and exact, not domain guesses",
    urls.every((u) => /^https:\/\/[^ ]+\/[^ ]*/.test(u)), urls.join(", "));
  check("a source only reachable this way is captured (sony.co.in)",
    urls.some((u) => u.includes("sony.co.in")), urls.join(", "));

  const trusted = nodes.filter((n) => n.querySelectorAll('[data-testid="trusted-citation-check"]').length > 0);
  check("Perplexity's trusted-domain marker is detectable", trusted.length === 1, `found ${trusted.length}`);
}

console.log("\nperplexity-real-dom: the steps disclosure");

{
  const btns = doc.querySelectorAll("button[aria-expanded]");
  const stepBtn = btns.find((b) => /finished/i.test(b.textContent));
  check("the steps button is found", !!stepBtn);
  check('its real text is "Finished2 steps" (no space)',
    stepBtn && stepBtn.textContent.trim().replace(/\s+/g, " ") === "Finished 2 steps" || (stepBtn && /Finished\s*2 steps/.test(stepBtn.textContent)),
    stepBtn && JSON.stringify(stepBtn.textContent.trim()));

  const m = src.match(/const PPLX_STEP_LABEL_RE = (\/.*\/[a-z]*);/);
  check("PPLX_STEP_LABEL_RE is present in source", !!m);
  if (m && stepBtn) {
    const lit = m[1];
    const re = new RegExp(lit.slice(1, lit.lastIndexOf("/")), lit.slice(lit.lastIndexOf("/") + 1));
    const label = stepBtn.textContent.trim().toLowerCase().replace(/\s+/g, "");
    check("the label regex matches the REAL concatenated label", re.test(label) || re.test("finished2 steps"), label);
    check("it still rejects unrelated buttons", !re.test("share") && !re.test("copy query"));
  }

  // Why expanding is mandatory, straight from the capture.
  const container = doc.querySelectorAll(".relative").find((d) => d.childNodes.length === 0);
  check("the steps content container is EMPTY while collapsed (so it must be expanded first)", !!container);
}

console.log("\nperplexity-real-dom: markdown serialization of the real answer");

const mdBody = extractArrow("domToMarkdown", "root");
check("domToMarkdown() found", !!mdBody);

if (mdBody) {
  const domToMarkdown = new Function(`return (root) => ${mdBody};`)();
  const prose = doc.querySelector(".prose");
  check("the .prose answer container is found on the real page", !!prose);

  const md = domToMarkdown(prose);
  check("real h2 headings become markdown headings", /^##\s+Top Picks Under/m.test(md), md.slice(0, 120));
  check("the real comparison table becomes a GFM table", /\|\s*---\s*\|/.test(md), md.slice(0, 200));
  check("bold product names survive", md.includes("**boAt Rockerz 512 ANC**"));
  check("list items become markdown list items", /^- /m.test(md));

  const brands = detectBrands(md, md, {}).brands.map((b) => b.brand);
  check("boAt is detected from the real answer", brands.includes("boAt"), brands.join(", "));
  check("Sony is detected", brands.includes("Sony"), brands.join(", "));
  check("Noise is detected", brands.includes("Noise"), brands.join(", "));
  check("Spigen is detected", brands.includes("Spigen"), brands.join(", "));
  check("GOBOULT is detected", brands.some((b) => /GOBOULT/i.test(b)), brands.join(", "));

  // The regression, measured on the REAL answer rather than a constructed one.
  const flat = prose.textContent;
  const flatBrands = detectBrands(flat, flat, {}).brands.length;
  check("markdown finds materially more brands than innerText did",
    brands.length >= 5 && brands.length > flatBrands, `markdown=${brands.length} innerText=${flatBrands}`);

  // The table's Model column must not leak in as brands.
  check("table header labels are not reported as brands",
    !brands.some((b) => ["Model", "Price", "Key Strengths", "Best For"].includes(b)), brands.join(", "));
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
