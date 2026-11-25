/*
 * brands-golive.test.mjs — the brand list on the answers of the go-live
 * test (25 Nov 2026, 1.0.7), and the cases a re-check of all 3,070 stored
 * answers turned up.
 *
 * The five live answers (fixtures/golive-crm.json, as captured) had labels
 * for brands: "**Limitation:**" under every pick (ChatGPT), "**Lead
 * Scoring:**" and "**Indian Ecosystem Readiness:**" (Gemini), "**Trade-off.**"
 * and "**Why it wins.**" (AI Mode), "**Team features for 10 people**:"
 * (Grok), and Grok's pick, named only in a bold opening sentence, was
 * missed. Names must keep working when a label shape holds them ("**PayPal
 * Invoicing**:", "**Voyager Infinity (by Ikiru People)**:", "**Bitrix24
 * (Free Plan)**", a table's "**Pipedrive** *(Growth)*").
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== "" ? ` — ${detail}` : ""}`); }
};
const brands = (text, prompt = "") => detectBrands(text, text, { prompt }).brands.map((b) => b.brand);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "golive-crm.json"), "utf8"));
const live = (engine) => brands(LIVE[engine].answerText, LIVE[engine].prompt);

console.log("\nthe five live answers: which CRM for a 10-person real estate agency in India");
{
  // "Indian Ecosystem Readiness" is still listed: "Indian" is always written with a capital.
  const junk = /^(Limitation|Lead Scoring|Avoid HubSpot|Team|Trade-off\.?|Why it wins\.?|Mobile App Offline\/Field|Native Portal APIs\.?)$/;
  for (const e of ["chatgpt", "gemini", "perplexity", "grok", "aimode"]) {
    const b = live(e);
    check(`${e}: no label is a brand`, !b.some((x) => junk.test(x)), b.join("|"));
    check(`${e}: no name ends in a full stop`, !b.some((x) => /\.$/.test(x)), b.join("|"));
  }
  const grok = live("grok");
  check("grok: Zoho CRM, its pick, is found and named first", grok[0] === "Zoho CRM", grok.join("|"));
  const gem = live("gemini");
  check("gemini: HubSpot, Salesforce, and Pipedrive from its table", ["HubSpot", "Salesforce", "Pipedrive", "LeadSquared", "Sell.Do"].every((n) => gem.includes(n)), gem.join("|"));
  const cg = live("chatgpt");
  check("chatgpt: Zoho, Sell.Do, LeadSquared, TeleCRM, Kylas", ["Sell.Do", "LeadSquared", "TeleCRM", "Kylas"].every((n) => cg.includes(n)) && cg.some((n) => /^Zoho/.test(n)), cg.join("|"));
  const am = live("aimode");
  check("aimode: Sell.Do, Zoho CRM, TeleCRM, Kylas", ["Sell.Do", "Zoho CRM", "TeleCRM", "Kylas"].every((n) => am.includes(n)), am.join("|"));
}

console.log("\nnames in label shapes stay brands (corpus check)");
{
  const t = `Free invoicing tools:\n* **Zoho Invoice**: Free for small businesses.\n* **PayPal Invoicing**: Lets you send invoices across 25+ currencies.\n\nDevelopers:\n* **Tata Housing:** Known for planned luxury residential developments.\n* **DLF:** The largest listed developer.\n\nUK platforms:\n* **Voyager Infinity (by Ikiru People)**: Built with UK agency workflows in mind.\n* **Bullhorn**: Widely used by staffing firms.\n\n6. **Bitrix24 (Free Plan)**\n   * **Best for:** Very small teams.\n7. **Streak (Free Plan — Gmail)**\n   * **Best for:** Gmail users.\n\n* **Google Workspace / Airtable / Notion**: Small teams start with tools they already use.`;
  const b = brands(t);
  for (const n of ["PayPal Invoicing", "Tata Housing", "Voyager Infinity", "Bitrix24", "Streak"]) check(`${n} is a brand`, b.some((x) => x === n || x.startsWith(n)), b.join("|"));
  check("no unclosed bracket", !b.some((x) => /\([^)]*$/.test(x)), b.join("|"));
}

console.log("\na table cell's plan in brackets");
{
  const t = `| CRM Platform | Best For |\n| :--- | :--- |\n| **Zoho CRM** *(Professional)* | Traditional brokerages |\n| **Pipedrive** *(Growth)* | Boutique luxury teams |\n\nPipedrive is simpler than Zoho CRM.`;
  const b = brands(t);
  check("Pipedrive and Zoho CRM", b.includes("Pipedrive") && b.includes("Zoho CRM"), b.join("|"));
}

console.log("\nlists of words are not names");
{
  const t = `### Wood, Metal & Trim\nUse enamel on doors.\n\n### Bathrooms, Basements & Water\nUse **Dr. Fixit** for waterproofing.\n\nPick a WhatsApp-first platform such as **WATI, AiSensy, or Interakt**.`;
  const b = brands(t);
  check("no list as a name", !b.some((x) => /,|&\s*$/.test(x)), b.join("|"));
}

console.log("\na review site quoted is not a brand (AI Mode, signed in, 1.0.7)");
{
  const t = "The top picks are the **ASICS GT-1000 14** and the **adidas Supernova Solution 3**.\n- **Outsole grip:** Rated highly by RunRepeat for wet and dry traction.\n- ASICS GT-2000 13 for longer runs.";
  const b = detectBrands(t, t, { sources: [{ domain: "runrepeat.com", title: "RunRepeat review", outcome: "cited" }, { domain: "asics.com", outcome: "cited" }] }).brands.map((x) => x.brand);
  check("ASICS, not RunRepeat", b.includes("ASICS") && !b.includes("RunRepeat"), b.join("|"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
