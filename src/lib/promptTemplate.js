/*
 * promptTemplate.js — the prompt template to download and fill in (0.77.0).
 *
 * The owner: "an option to download a temple excel file in which you can
 * upload the prompt and mapped tags … 1 primary tag and then a seconday tag".
 * Columns: Prompt · Primary tag · Secondary tag. rowsToPrompts
 * (xlsxLite.js) reads them back into tags[], primary first; a prompt's
 * primary tag is tags[0] everywhere (the board's Topic, filters, exports).
 * The Primary tag column offers the campaign's existing tags as a dropdown
 * (any other value is still accepted). Example rows are made up.
 */
import { Workbook } from "./xlsxWrite.js";

export const TEMPLATE_HEADERS = ["Prompt", "Primary tag", "Secondary tag"];
export const TEMPLATE_EXAMPLES = [
  ["best running shoes for flat feet", "Buying guide", "Footwear, Comparison"],
  ["which running shoe brands last the longest", "Durability", ""],
  ["is Northwind better than Contoso for trail running", "Comparison", "Trail"],
];

/** The CSV version: the same columns and rows. */
export function promptTemplateCsv() {
  const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLES].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

/**
 * The .xlsx version: a Prompts sheet (frozen header, wide columns, a
 * dropdown of the campaign's tags on Primary tag) and a How to fill it sheet.
 * @param {{tags?: string[]}} o  the campaign's tags so far
 */
export function promptTemplateWorkbook({ tags = [] } = {}) {
  const wb = new Workbook({ title: "CitoSkeleton prompt template" });
  const th = { font: { bold: true, color: "FFFFFF" }, fill: "1E293B", align: { v: "center" } };
  const s = wb.addSheet("Prompts");
  s.row(1, TEMPLATE_HEADERS, th);
  TEMPLATE_EXAMPLES.forEach((r, i) => s.row(i + 2, r));
  s.width(1, 70).width(2, 24).width(3, 32).freeze("A2");
  const list = [...new Set(tags.map((t) => String(t).trim()).filter((t) => t && !/[",]/.test(t)))].slice(0, 40);
  // A list typed into the validation is capped at 255 characters by Excel.
  let fit = [];
  for (const t of list) { if ([...fit, t].join(",").length > 250) break; fit.push(t); }
  if (fit.length) s.dropdown("B2:B1000", fit, { prompt: "Pick one of this campaign's tags, or type a new one." });
  const h = wb.addSheet("How to fill it");
  [
    ["How to fill in this template", { font: { bold: true, size: 14 } }],
    ["One prompt per row, in the Prompt column: the question as a person would ask an AI engine."],
    ["Primary tag: one tag, the prompt's main topic. The campaign board groups prompts by it."],
    ["Secondary tag: any further tags, separated by commas. Optional."],
    ["Delete the example rows, save, then upload the file in the campaign's Prompts section."],
    ["Prompts already in the campaign are skipped, so the same file can be uploaded again after adding rows."],
  ].forEach(([t, st], i) => h.set([i + 1, 1], t, st));
  h.width(1, 100);
  return wb;
}
