/*
 * defs.js — one plain definition for each control (0.78.0).
 *
 * The owner: "can we have like a hovering defination thing for each tool and
 * thing … this need to trigger after 2.5second". Controls that carry no
 * data-tip / data-term / title of their own get theirs from here, by
 * selector, as they appear (applyDefs, run by the panel on every render).
 * Glossary terms keep their own structured tooltip (data-term).
 */
export const DEFS = [
  ['[data-tab="analyze"]', "Analyze: one captured answer at a time — the brands it named, the sites it used, the searches it ran."],
  ['[data-tab="dashboard"]', "Dashboard: everything you've captured, searchable, with filters for engine, date and campaign."],
  ['[data-tab="loader"]', "Campaigns: a list of prompts sent to several AI engines, measured the same way each run."],
  ['[data-tab="ask"]', "Ask: questions about your own captured data, answered on this computer."],
  ['[data-tab="about"]', "About: settings, display, the glossary of measures, and diagnostics."],
  [".brand-icon", "Open the CitoSkeleton web page in a new tab"],
  [".brand-title", "Go to the Dashboard"],
  ["#capToggle", "Pause or resume capturing your engine chats"],
  ["#openTab", "Open CitoSkeleton in a full browser tab"],
  ["#cbExport", "Export the campaign as an Excel workbook, CSV tables or a PDF report"],
  [".cp-run", "Send every prompt to every engine in this campaign now"],
  [".ho-btn", "Take this data, your question and a request to another AI in one click"],
  ["#askSend", "Send your question to the built-in AI"],
  ["#askClear", "Start a new conversation"],
  [".prompt-search", "Rows matching every word are shown, in any order"],
  [".db-search, #dbSearch", "Search your captured prompts, answers and the engines' own searches"],
  ["#setSave", "Save the settings above"],
  ["#setUndo", "Put the settings back as they were saved"],
];

/** Gives every matching control without a tip its definition. */
export function applyDefs(root = document) {
  for (const [sel, text] of DEFS) {
    for (const n of root.querySelectorAll(sel)) {
      if (!n.hasAttribute("data-tip") && !n.hasAttribute("data-term")) n.setAttribute("data-tip", text);
    }
  }
}
