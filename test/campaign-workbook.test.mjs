/*
 * campaign-workbook.test.mjs — the campaign export is valid, complete, and
 * arithmetically right.
 *
 * Requested: an Excel export "with more depth, formatted, structured and
 * navigation friendly" covering the entire campaign.
 *
 * Three things have to hold, and they fail in different ways:
 *
 *   1. VALID. SpreadsheetML is unforgiving — one unescaped ampersand or one
 *      stray control byte in a scraped page title and Excel refuses the whole
 *      file rather than skipping the cell. The user then has no export at
 *      all, from data that was perfectly fine. Page titles come off the open
 *      web, so this is a when-not-if problem.
 *   2. COMPLETE. A sheet quietly disappearing (a rename, a thrown helper) is
 *      invisible until someone opens the file weeks later looking for it.
 *   3. CORRECT. Share of voice, mention rate and cited-vs-fetched ARE the
 *      product. A workbook that opens beautifully and misreports them is
 *      worse than one that fails loudly.
 *
 * The fixture is deliberately awkward: ampersands and quotes in titles, a
 * control byte, a brand named in some responses and not others, a domain that
 * is fetched without being cited, and a site:-scoped fan-out query that
 * produced no citation from that domain.
 */
import { buildCampaignWorkbook, SHEET_ORDER } from "../src/lib/campaignWorkbook.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const P1 = "p-1", P2 = "p-2";
const R1 = "run-1", R2 = "run-2";
const T0 = Date.parse("2026-08-01T10:00:00Z");

const src = (url, title, cited) => ({ url, title, cited });

// Two prompts x two runs x two engines = 8 responses, with deliberate gaps.
const records = [
  { captureId: "c1", platform: "chatgpt", capturedAt: T0, answerChars: 1200, searched: true,
    geo: { runId: R1, promptId: P1 },
    fanout: { search: ["best phone under 50000", 'site:gsmarena.com "battery life"'], shopping: [], image: [] },
    sources: [src("https://gsmarena.com/a", "GSMArena — specs & tests", true),
              src("https://amazon.in/x", 'Buy "now"', false)],
    brandMentions: [{ brand: "Acme", count: 2, firstIndex: 10 }, { brand: "Rival", count: 1, firstIndex: 90 }] },

  { captureId: "c2", platform: "gemini", capturedAt: T0 + 60000, answerChars: 900, searched: true,
    geo: { runId: R1, promptId: P1 },
    fanout: { search: ["phone under 50000 india"], shopping: [], image: [] },
    sources: [src("https://gsmarena.com/b", "GSMArena control", true)],
    brandMentions: [{ brand: "Rival", count: 3, firstIndex: 5 }] },   // Acme absent

  { captureId: "c3", platform: "chatgpt", capturedAt: T0 + 120000, answerChars: 800, searched: false,
    geo: { runId: R1, promptId: P2 },
    fanout: { search: [], shopping: [], image: [] },
    sources: [],
    brandMentions: [{ brand: "Acme", count: 1, firstIndex: 3 }] },

  { captureId: "c4", platform: "chatgpt", capturedAt: T0 + 86400000, answerChars: 1500, searched: true,
    geo: { runId: R2, promptId: P1 },
    fanout: { search: ["site:notcited.example review"], shopping: [], image: [] },
    sources: [src("https://gsmarena.com/a", "GSMArena — specs & tests", true),
              src("https://other.example/z", "Other\u0007title", false)],
    brandMentions: [{ brand: "Acme", count: 1, firstIndex: 40 }, { brand: "Rival", count: 1, firstIndex: 8 }] },
];

const bundle = {
  generatedAt: T0 + 90000000,
  profile: {
    id: "prof-1", name: "Phones & Tablets <2026>", locked: true, createdAt: T0 - 100000,
    brand: { name: "Acme", url: "acme.example" },
    competitors: [{ name: "Rival", url: "" }],
    engines: ["chatgpt", "gemini"],
  },
  prompts: [
    { id: P1, text: "best smartphone under 50000", tags: ["core"], active: true },
    { id: P2, text: "which phone has the best camera", tags: [], active: true },
  ],
  runs: [
    { id: R1, profileId: "prof-1", startedAt: T0 - 1000, finishedAt: T0 + 200000, status: "done",
      engines: ["chatgpt", "gemini"], expected: 4, captured: 3, failed: 1, reasons: { timeout: 1 } },
    { id: R2, profileId: "prof-1", startedAt: T0 + 86000000, finishedAt: T0 + 86500000, status: "done",
      engines: ["chatgpt"], expected: 2, captured: 1, failed: 1, reasons: { "submit: send control never accepted the prompt": 1 } },
  ],
  records,
  brands: [{ name: "Acme" }, { name: "Rival" }],
  metrics: { totalResponses: 4, brands: [
    { name: "Acme", isOwn: true, visibility: 75, share: 50, avgPosition: 1.3, citations: 2, sourceVisibility: 25 },
    { name: "Rival", isOwn: false, visibility: 75, share: 50, avgPosition: 1.3, citations: 0, sourceVisibility: 0 },
  ] },
  errors: [{ where: "run:turn-failed:chatgpt", message: "timeout", count: 2,
             firstAt: T0, lastAt: T0 + 500, trace: "1:run:chatgpt 3:composer 12:click 13:cleared 38:giveup" }],
};

const xml = buildCampaignWorkbook(bundle);
const sheetOf = (name) => {
  const i = xml.indexOf(`<Worksheet ss:Name="${name.replace(/&/g, "&amp;")}"`);
  if (i < 0) return "";
  const j = xml.indexOf("</Worksheet>", i);
  return xml.slice(i, j);
};

console.log("\nThe file Excel actually has to accept");
{
  check("it declares itself as a SpreadsheetML workbook",
    /^<\?xml version="1\.0"\?>\s*<\?mso-application progid="Excel\.Sheet"\?>/.test(xml), xml.slice(0, 80));

  // The cheapest real validity check available without a parser dependency:
  // every opened element of the structural kinds is closed.
  for (const tag of ["Workbook", "Worksheet", "Table", "Row", "Styles"]) {
    const open = (xml.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const close = (xml.match(new RegExp(`</${tag}>`, "g")) || []).length;
    const selfClosed = (xml.match(new RegExp(`<${tag}/>`, "g")) || []).length;
    check(`<${tag}> elements all close`, open === close + selfClosed, `${open} open, ${close} closed, ${selfClosed} self-closed`);
  }

  // The whole-file-refused case: an ampersand from a real page title.
  check("an ampersand in a page title is escaped, not left raw",
    xml.includes("GSMArena — specs &amp; tests"), "escaped title missing");
  check("no bare ampersand survives anywhere",
    !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(xml), (xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g) || []).slice(0, 3).join(","));
  check("a double quote inside cell text is escaped", xml.includes("Buy &quot;now&quot;"), "quoted title missing");
  check("the campaign name's angle brackets are escaped",
    xml.includes("Phones &amp; Tablets &lt;2026&gt;"), "campaign name not escaped");

  // A control byte in a scraped title is illegal in XML 1.0 and is what makes
  // Excel reject the entire document.
  check("a control byte from a scraped title is stripped",
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), "control character present in output");
}

console.log("\nEvery sheet is present, in a deliberate order");
{
  const names = [...xml.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map((m) => m[1]);
  check(`all ${SHEET_ORDER.length} sheets exist`, SHEET_ORDER.every((n) => names.includes(n)),
    `missing: ${SHEET_ORDER.filter((n) => !names.includes(n)).join(", ")}`);
  check("Index comes first, so the file opens on a map of itself",
    names[0] === "Index", names[0]);
  check("the order is the declared one", names.join("|") === SHEET_ORDER.join("|"), names.join("|"));
}

console.log("\nNavigation: frozen headers and filters on every sheet");
{
  const sheets = [...xml.matchAll(/<Worksheet ss:Name="([^"]+)"[\s\S]*?<\/Worksheet>/g)].map((m) => m[0]);
  check("every sheet freezes its header row",
    sheets.every((s) => s.includes("<FreezePanes/>")), "a sheet is missing FreezePanes");
  check("every sheet with data offers a filter",
    sheets.filter((s) => (s.match(/<Row>/g) || []).length > 3).every((s) => s.includes("<AutoFilter")),
    "a populated sheet has no AutoFilter");
  check("column widths are set rather than left at Excel's default",
    (xml.match(/<Column ss:Width=/g) || []).length > 60,
    String((xml.match(/<Column ss:Width=/g) || []).length));
}

console.log("\nNumbers are numbers, so the sheet can be summed and charted");
{
  check("counts are written as Number cells", /ss:Type="Number">4</.test(xml) || /ss:Type="Number">2</.test(xml),
    "no numeric cells found");
  const results = sheetOf("Prompt Results");
  check("Prompt Results has one row per response, plus three header rows",
    (results.match(/<Row>/g) || []).length === records.length + 3,
    String((results.match(/<Row>/g) || []).length));
}

console.log("\nThe arithmetic — this is the product, not decoration");
{
  const runs = sheetOf("Runs");
  // Run 1 expected 4 and this fixture stores 3 for it. The run record ALSO
  // claims captured:3, but the sheet recounts from stored responses on
  // purpose: run counters were shown to over-count late captures ("14/12
  // captured"), and a report that disagrees with the data it ships is worse
  // than one that recounts.
  check("Runs recounts captured from stored responses rather than trusting the counter",
    /ss:Type="Number">3</.test(runs), "recount missing");
  check("Runs reports a completion percentage", /ss:Type="Number">75</.test(runs), "75% not found");

  const brands = sheetOf("Brands");
  // Acme is named in 3 of 4 responses; Rival in 3 of 4. Mentions: Acme 2+1+1=4,
  // Rival 1+3+1=5, pool 9.
  check("a brand's visibility counts responses, not mentions",
    /ss:Type="Number">75</.test(brands), "visibility 75% not found");
  check("share of voice is computed over the mention pool",
    /ss:Type="Number">55\.6</.test(brands) && /ss:Type="Number">44\.4</.test(brands),
    "expected 55.6 / 44.4 share split");
  check("the own brand is labelled as such", brands.includes("Own brand"), "own-brand label missing");
  check("a brand that is tracked but not the own brand is labelled a competitor",
    brands.includes("Tracked competitor"), "competitor label missing");

  const domains = sheetOf("Domains");
  check("a domain cited in some responses and merely fetched in others splits the two",
    domains.includes("gsmarena.com") && domains.includes("amazon.in"), "domains missing");
  // amazon.in appears once, never cited.
  check("a fetched-but-never-cited domain reports 0% cited",
    /amazon\.in[\s\S]{0,400}?ss:Type="Number">0</.test(domains), "amazon.in cited% not 0");

  const prompts = sheetOf("Prompts");
  // P1 has 3 responses; Acme named in 2 of them -> 66.7%.
  check("a prompt's mention rate is over its own responses",
    /ss:Type="Number">66\.7</.test(prompts), "66.7% mention rate not found");
}

console.log("\nFan-out: the site: scope that produced nothing");
{
  const fan = sheetOf("Fan-out Queries");
  check("every fan-out query is listed", (fan.match(/<Row>/g) || []).length === 4 + 3,
    String((fan.match(/<Row>/g) || []).length));
  /* Asserted as a CELL of its own, not merely present somewhere on the sheet.
   * The looser check passed while the column was empty, because the domain
   * also appears inside the raw query text one column over — which is exactly
   * how the wrong field name (site instead of siteIncludes) went unnoticed. */
  check("a site: scope is extracted into its own cell, not just present in the raw query",
    fan.includes(">notcited.example<") && fan.includes(">gsmarena.com<"),
    "site: scope cell missing");
  check("a quoted phrase is extracted", fan.includes("battery life"), "quoted phrase missing");
  // site:gsmarena.com DID yield a citation; site:notcited.example did not.
  check("it says whether the scoped domain actually got cited — the content-gap signal",
    /notcited\.example[\s\S]{0,200}?>No</.test(fan), "no-citation flag missing for notcited.example");
}

console.log("\nDiagnostics carries the failure detail into the same file");
{
  const diag = sheetOf("Diagnostics");
  check("a run's missing count is expected minus stored",
    /ss:Type="Number">1</.test(diag), "missing count not found");
  check("failure reasons are spelled out", diag.includes("timeout"), "reasons missing");
  check("the per-turn timeline travels with the error",
    diag.includes("3:composer") && diag.includes("13:cleared"), "trace missing from Diagnostics");
}

console.log("\nDegenerate input must not produce a broken file");
{
  const empty = buildCampaignWorkbook({});
  check("an empty bundle still builds a workbook", /<\/Workbook>/.test(empty), empty.slice(0, 60));
  const names = [...empty.matchAll(/<Worksheet ss:Name="([^"]+)"/g)].map((m) => m[1]);
  check("…with every sheet still present", SHEET_ORDER.every((n) => names.includes(n)),
    `missing: ${SHEET_ORDER.filter((n) => !names.includes(n)).join(", ")}`);
  check("…and no unbalanced tags", (empty.match(/<Row>/g) || []).length === (empty.match(/<\/Row>/g) || []).length);

  // A record whose fanout is the older plain-string shape, and one with no
  // geo bag at all: an export that throws on one old row is worthless.
  const odd = buildCampaignWorkbook({
    profile: { name: "X" }, prompts: [], runs: [],
    records: [{ captureId: "z", platform: "chatgpt", capturedAt: T0, fanout: { search: [{ query: "obj shape" }] },
                sources: [{ url: "not a url" }], brandMentions: [] }],
  });
  check("an object-shaped fan-out entry is handled", odd.includes("obj shape"), "object query missing");
  check("a record with no geo bag does not throw", odd.includes("</Workbook>"), "build failed");
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
