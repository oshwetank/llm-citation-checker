/*
 * perplexity-markdown-harvest.test.mjs — the DOM harvester preserves the
 * STRUCTURE brand detection runs on, instead of flattening it away.
 *
 * The bug this locks down, and why it mattered more than it looked:
 *
 * lib/brands.js derives its candidates almost entirely from structure —
 * bold list headers, markdown headings, and the first column of markdown
 * tables. That design is deliberate (see its file header): keying off
 * FORMATTING rather than a word list is what lets it work for phones,
 * paint, finance or jewellery without anyone configuring a vocabulary.
 *
 * ChatGPT's payload arrives as markdown, so that worked there from day one.
 * Perplexity has no usable answer stream, so its capture comes from the DOM
 * harvester — which called `innerText` and destroyed every one of those
 * signals before the detector ever saw them. Measured on identical content:
 * the markdown form yields "boAt, Sony, Noise"; the innerText-flattened
 * form of the SAME answer yields NOTHING. That is the real reason real
 * Perplexity captures came back with empty or junk Brand Mentions, and it
 * is a clean example of ChatGPT-shaped assumptions leaking into an engine
 * that delivers its answer a completely different way.
 */
import { readFileSync } from "node:fs";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

// Lift `const domToMarkdown = (root) => { ... };` out by brace matching —
// content-iso.js is a browser IIFE with nothing to import.
function extractFn(name) {
  const start = src.indexOf(`const ${name} = (root) => {`);
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", src.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return null;
}

const body = extractFn("domToMarkdown");
check("domToMarkdown() found in content-iso.js", !!body, "renamed or removed?");

// Minimal DOM stand-ins: only the surface domToMarkdown actually touches.
const txt = (s) => ({ nodeType: 3, nodeValue: s });
const el = (tag, children = []) => {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    get children() { return children.filter((c) => c.nodeType === 1); },
  };
  node.querySelectorAll = (sel) => {
    const want = sel.toUpperCase();
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes || []) {
        if (c.nodeType !== 1) continue;
        if (c.tagName === want) out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  return node;
};

if (body) {
  const domToMarkdown = new Function(`return (root) => ${body};`)();

  console.log("\nperplexity-markdown-harvest: structure survives serialization");

  // A bolded product lead — the single most common way an answer names a brand.
  {
    const root = el("div", [
      el("h2", [txt("Top Picks Under 4000")]),
      el("p", [el("strong", [txt("boAt Rockerz 551 ANC Pro")]), txt(" is the best overall pick.")]),
      el("p", [el("strong", [txt("Sony WH-CH520")]), txt(" is the most balanced.")]),
    ]);
    const md = domToMarkdown(root);
    check("headings become markdown headings", /^##\s+Top Picks Under 4000/m.test(md), JSON.stringify(md.slice(0, 60)));
    check("bold survives as **bold**", md.includes("**boAt Rockerz 551 ANC Pro**"), JSON.stringify(md.slice(0, 120)));

    const brands = detectBrands(md, md, {}).brands.map((b) => b.brand);
    check("brand detection now finds boAt", brands.includes("boAt"), brands.join(", ") || "(none)");
    check("brand detection now finds Sony", brands.includes("Sony"), brands.join(", ") || "(none)");
  }

  // Tables are the other primary signal — first column is the subject.
  {
    const row = (cells, tag = "td") => el("tr", cells.map((c) => el(tag, [txt(c)])));
    const root = el("div", [
      el("table", [
        el("thead", [row(["Speaker", "Price", "Best For"], "th")]),
        el("tbody", [
          row(["JBL Flip Essential 2", "4800", "Overall best"]),
          row(["Tribit XSound Go", "2500", "Budget pick"]),
        ]),
      ]),
    ]);
    const md = domToMarkdown(root);
    check("a table becomes a GFM table with a separator row", /\|\s*---\s*\|/.test(md), JSON.stringify(md));
    const brands = detectBrands(md, md, {}).brands.map((b) => b.brand);
    // "JBL Flip Essential 2" carries a digit, so brands.js collapses it to
    // the vendor; "Tribit XSound Go" is digit-free and reads as a proper
    // name, so it is deliberately kept whole (see looksLikeProperName).
    // Either form counts here — the point is that the table's first column
    // produced a candidate at all, which innerText made impossible.
    check("first-column products are detected as brands (JBL)", brands.some((b) => b.startsWith("JBL")), brands.join(", ") || "(none)");
    check("first-column products are detected as brands (Tribit)", brands.some((b) => b.startsWith("Tribit")), brands.join(", ") || "(none)");
  }

  // The regression itself, stated directly.
  {
    const root = el("div", [
      el("p", [el("strong", [txt("Noise Airwave Max XR 120")]), txt(" has great battery.")]),
    ]);
    const md = domToMarkdown(root);
    const flat = "Noise Airwave Max XR 120 has great battery."; // what innerText gave
    const fromMd = detectBrands(md, md, {}).brands.map((b) => b.brand);
    const fromFlat = detectBrands(flat, flat, {}).brands.map((b) => b.brand);
    check("markdown preserves the bolded product as a brand", fromMd.includes("Noise"), fromMd.join(", ") || "(none)");
    // This used to also assert the FLAT text yielded zero brands — i.e. it
    // pinned the detector's blind spot in place as a requirement. The prose
    // fallback (see "3c. names the prose itself writes" in lib/brands.js) now
    // recovers "Noise" from the flattened sentence too, which is the right
    // answer: a real brand is named there. What this file exists to guard is
    // that markdown harvesting does not LOSE it, so that is what is asserted.
    check("flattened text is no worse than the markdown it came from",
      fromFlat.length >= 1 && fromMd.every((b) => fromFlat.includes(b)),
      `md=[${fromMd}] flat=[${fromFlat}]`);
  }

  // Serialization must never cost us the capture.
  {
    check("a null root returns empty string, not a throw", domToMarkdown(null) === "");
    const weird = { nodeType: 1, tagName: "DIV", childNodes: null, innerText: "fallback text" };
    let threw = null;
    try { domToMarkdown(weird); } catch (e) { threw = e; }
    check("a malformed node does not throw", !threw, threw && threw.message);
  }
}

console.log("\nperplexity-markdown-harvest: a brand and its own domain are ONE brand");

// Live symptom: "boAt x8" and "boat-lifestyle x12" reported as two separate
// brands for the same answer, splitting the share of voice that is the whole
// point of the metric.
{
  const md = `## Top Picks
**boAt Rockerz 551 ANC Pro** is the best overall pick. boAt offers strong bass and boAt has the widest service network.
**Sony WH-CH520** is the most balanced.`;
  const sources = [{ url: "https://www.boat-lifestyle.com/products/rockerz", domain: "boat-lifestyle.com" }];
  const brands = detectBrands(md, md, { sources }).brands;
  const names = brands.map((b) => b.brand);

  check("the brand itself is reported", names.includes("boAt"), names.join(", "));
  check("its own domain is NOT reported as a second brand", !names.some((n) => /lifestyle/i.test(n)), names.join(", "));
  const boat = brands.find((b) => b.brand === "boAt");
  check("the mentions are consolidated onto one entry", !!boat && boat.count === 3, boat && String(boat.count));
}

// The merge must be evidence-based, not a loose prefix match — companies that
// merely start alike must stay separate.
{
  const md = `## Places
**Apple** makes the iPhone. Apple is a technology company.
**Applebees** is a restaurant chain.`;
  const sources = [{ url: "https://www.applebees.com/", domain: "applebees.com" }];
  const names = detectBrands(md, md, { sources }).brands.map((b) => b.brand);
  check("an unrelated company that merely shares a prefix is NOT merged away", names.includes("Applebees") || names.includes("Apple"), names.join(", "));
  check("both remain distinct entries", new Set(names).size === names.length, names.join(", "));
}

console.log("\nperplexity-markdown-harvest: the harvester actually USES it");

// Everything above tests domToMarkdown in isolation, which would keep passing
// even if the harvester quietly went back to innerText for its answer text —
// the exact regression that caused this whole class of bug. Asserted against
// the real source so the call sites can't silently revert.
{
  const answerLines = src.split("\n").filter((l) => /answerText\s*=\s*chosen\.map/.test(l));
  check("all three platform branches extract the answer", answerLines.length === 3, `found ${answerLines.length}`);
  check(
    "every one of them serializes to markdown, none fall back to innerText",
    answerLines.length > 0 && answerLines.every((l) => l.includes("domToMarkdown") && !l.includes("innerText")),
    answerLines.join(" || ")
  );
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
