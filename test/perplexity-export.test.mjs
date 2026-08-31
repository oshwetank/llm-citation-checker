/*
 * perplexity-export.test.mjs — the exported document is a faithful replica of
 * what Perplexity actually showed: real tables, real headings, and numbered
 * footnotes sitting at the exact point in the sentence the answer cited.
 *
 * Before this, a Perplexity export was flat prose. Two causes, both fixed
 * upstream of the exporter and verified end-to-end here:
 *
 *  1. The harvester flattened the answer with innerText, so the comparison
 *     table, headings and bold product names never survived to the document
 *     at all. domToMarkdown now rebuilds them.
 *
 *  2. Perplexity's inline citations were dropped into the prose as raw badge
 *     text, which is why exported answers read "...around 2,999.boat-lifestyle".
 *     The harvester now emits a positional [[cite:URL]] marker instead, and
 *     renderPerplexityAnswer turns each into a numbered footnote link.
 *
 * The renderer is deliberately NOT a reuse of the ChatGPT one: that path is
 * built on ChatGPT's `turnNkindM` marker ids and a per-source markerIds
 * lookup, neither of which Perplexity has. Perplexity puts the exact source
 * URL on the citation element, so the URL itself is the key. Forcing it
 * through ChatGPT's shape is the assumption-leak this codebase keeps undoing.
 *
 * Everything runs against test/fixtures/perplexity-answer-dom.html — a real
 * DevTools capture — rather than hand-built markup.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "./helpers/mini-dom.mjs";
import { buildExportModel } from "../src/lib/exportDoc.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

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

const mdBody = extractArrow("domToMarkdown", "root");
check("domToMarkdown() found", !!mdBody);

const doc = parseHTML(readFileSync(new URL("./fixtures/perplexity-answer-dom.html", import.meta.url), "utf8"));
const domToMarkdown = mdBody ? new Function(`return (root) => ${mdBody};`)() : null;
const answerMd = domToMarkdown ? domToMarkdown(doc.querySelector(".prose")) : "";

const baseRecord = (over = {}) => ({
  captureId: "exp-1",
  platform: "perplexity",
  answerText: answerMd,
  answerChars: answerMd.length,
  capturedAt: Date.now(),
  userPrompt: "Best headphone under 4000",
  sources: [
    { url: "https://www.boat-lifestyle.com/collections/wireless-headphones-under-4000", domain: "boat-lifestyle.com", title: "Buy boAt Wireless Headphones Under 4000", outcome: "cited" },
    { url: "https://www.smartprix.com/headphones/under-4000", domain: "smartprix.com", title: "Headphones under 4000", outcome: "cited" },
  ],
  fanout: { search: [], shopping: [], image: [] },
  brandMentions: [], products: [], places: [], entities: [],
  ...over,
});

console.log("\nperplexity-export: the answer's structure survives into the document");

if (answerMd) {
  const m = buildExportModel(baseRecord());

  check("the comparison table is a real HTML table", /<table>/.test(m.bodyHtml));
  check("its header cells are rendered", /<th>Model<\/th>/.test(m.bodyHtml), m.bodyHtml.slice(0, 200));
  check("its data cells are rendered", /<td>.*boAt Rockerz 512 ANC.*<\/td>/.test(m.bodyHtml));
  check("section headings are rendered", /<h[23]>Top Picks Under/.test(m.bodyHtml));
  check("bold product names are rendered", /<strong>boAt Rockerz 512 ANC<\/strong>/.test(m.bodyHtml));
  check("the bulleted recommendations are a real list", /<ul>[\s\S]*<li>/.test(m.bodyHtml));
}

console.log("\nperplexity-export: inline numbered citations");

if (answerMd) {
  const m = buildExportModel(baseRecord());

  check("the export reports that it has inline citations", m.hasInlineCitations === true);
  check("footnotes are numbered from the answer's own citations", m.footnotes.length === 3, `got ${m.footnotes.length}`);
  check("numbering starts at 1 and is contiguous",
    m.footnotes.every((f, i) => f.n === i + 1), JSON.stringify(m.footnotes.map((f) => f.n)));
  // FOUR markers, three footnotes: boat-lifestyle is cited twice and correctly
  // reuses number [1]. The count was 3 while a citation alone in its own
  // paragraph silently failed to substitute — see the placeholder note below.
  check("every citation marker becomes a superscript link",
    (m.bodyHtml.match(/<sup class="fn"/g) || []).length === 4,
    String((m.bodyHtml.match(/<sup class="fn"/g) || []).length));
  check("a repeated source reuses its original number rather than adding one",
    (m.bodyHtml.match(/#fn-exp-1-1"/g) || []).length === 2,
    String((m.bodyHtml.match(/#fn-exp-1-1"/g) || []).length));
  check("each links to its own footnote anchor", /href="#fn-exp-1-1"/.test(m.bodyHtml));

  // The exact defect this fixes: the raw badge label used to land in the prose.
  check('the citation sits at the end of the sentence it belongs to',
    /2,999\.<sup class="fn">/.test(m.bodyHtml),
    m.bodyHtml.slice(0, 260));
  check("the raw badge label no longer leaks into the prose",
    !/2,999\.boat-lifestyle/.test(m.bodyHtml));
  check("no [[cite:...]] marker leaks into the document", !/\[\[cite:/.test(m.bodyHtml));
  // Checked by DELIMITER, not by " P<n> ": the answer legitimately contains
  // "Spigen SA-HP P10", and a whitespace-based check would flag real content.
  check("no unsubstituted placeholder token is left behind",
    !/⟦P\d+⟧/.test(m.bodyHtml), m.bodyHtml.slice(0, 200));

  // A source the record doesn't carry must still get a footnote, because the
  // marker itself holds a real URL — Perplexity citations cannot be
  // "unresolved" the way ChatGPT's can.
  const sony = m.footnotes.find((f) => /sony\.co\.in/.test(f.source.url || ""));
  check("a cited URL missing from record.sources still becomes a footnote", !!sony,
    JSON.stringify(m.footnotes.map((f) => f.source.url)));
  check("and it gets a readable domain label", !!sony && sony.source.domain === "sony.co.in", sony && sony.source.domain);
  check("nothing is reported as an unresolved citation", m.unresolvedCitations === false);
}

console.log("\nperplexity-export: captures without citation markers");

{
  // An older capture, taken before positional citations were harvested. It
  // must render plainly and must NOT advertise footnotes it doesn't have.
  const m = buildExportModel(baseRecord({
    captureId: "exp-2",
    answerText: "## Top Picks\n**boAt Rockerz 512 ANC** is the best value.\nNo citations in this one.",
  }));
  check("it still renders the answer", /<strong>boAt Rockerz 512 ANC<\/strong>/.test(m.bodyHtml));
  check("it does not claim inline citations", m.hasInlineCitations === false);
  check("it produces no footnotes", m.footnotes.length === 0);
}

console.log("\nperplexity-export: real content is never mistaken for a placeholder");

// The placeholder token used to be whitespace-delimited (" P0 "), which meant
// any answer text containing that shape was substituted away. Product model
// names make this common, not theoretical: this fixture's own table contains
// "Spigen SA-HP P10", and the old pattern silently deleted the "P10",
// exporting a corrupted product name. Realme P3, Vivo T3 and similar would
// have hit it too — and it applied to ChatGPT exports as well, since the
// substitution is shared.
if (answerMd) {
  const m = buildExportModel(baseRecord());
  check('a product name containing "P10" survives intact',
    /Spigen SA-HP P10/.test(m.bodyHtml),
    (m.bodyHtml.match(/.{0,30}Spigen[^<]*/) || [""])[0]);

  // Same shape, forced through a record with many placeholders so a numeric
  // collision is actually possible.
  const collide = buildExportModel(baseRecord({
    captureId: "exp-5",
    answerText: "The **Realme P3** and **Vivo T3** both beat the P10 and P2 models.[[cite:https://example.com/a]]",
  }));
  check("bare model numbers in prose are untouched",
    /P3/.test(collide.bodyHtml) && /P10/.test(collide.bodyHtml) && /P2/.test(collide.bodyHtml),
    collide.bodyHtml);
  check("and the real citation still renders", /<sup class="fn"/.test(collide.bodyHtml));
}

console.log("\nperplexity-export: other platforms are unaffected");

{
  const gem = buildExportModel(baseRecord({ captureId: "exp-3", platform: "gemini" }));
  check("Gemini still renders without inline citations", gem.hasInlineCitations === false);
  check("Gemini still gets its answer body", gem.bodyHtml.length > 0);

  // The shared placeholder fix must not have broken ChatGPT's own path.
  const cg = buildExportModel({
    captureId: "exp-4", platform: "chatgpt",
    answerText: "A plain ChatGPT answer with **bold** text and a table:\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
    answerChars: 80, capturedAt: Date.now(), userPrompt: "q",
    sources: [], fanout: { search: [], shopping: [], image: [] },
    brandMentions: [], products: [], places: [], entities: [],
  });
  check("ChatGPT still renders bold and tables", /<strong>bold<\/strong>/.test(cg.bodyHtml) && /<table>/.test(cg.bodyHtml));
  check("ChatGPT leaves no placeholder tokens behind", !/⟦P\d+⟧/.test(cg.bodyHtml));
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
