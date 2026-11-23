/*
 * brands-label-bullets.test.mjs — brands in "* **Name:** description"
 * bullets, and the labels and words that are not brands.
 *
 * Live run of 23 Nov 2026 (530 CRM and running-shoe questions): Gemini's
 * commonest layout lost every brand, because the part after the colon was
 * kept and nothing comes after it in "**TaxDome:**". Instead the list held
 * "CRM", "Traditional" (from "**Traditional sales & relationship CRMs**"),
 * "However", "Widely", "Popular" and plan tiers. Synthetic text in the
 * shapes the run produced.
 * Run: node test/brands-label-bullets.test.mjs
 */
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const names = (text, prompt = "Which CRM do most accounting firms use?") =>
  detectBrands(text, text, { prompt }).brands.filter((b) => b.count > 0).map((b) => b.brand);
const has = (list, n) => list.some((b) => b.toLowerCase().startsWith(n.toLowerCase()));

console.log("\n\"* **Name:** description\" bullets are the names");
{
  const b = names("Firms differ.\n\n* **TaxDome:** Widely used by solo practitioners.\n* **Karbon:** Popular with mid-sized firms.\n* **Canopy:** Good for tax work.");
  check("every bullet's name is found", ["TaxDome", "Karbon", "Canopy"].every((n) => has(b, n)), JSON.stringify(b));
  check("the word after the label is not a brand", !b.includes("Widely") && !b.includes("Popular"), JSON.stringify(b));
}
{
  const b = names("* **HubSpot CRM & Zoho CRM:** Popular options for lead tracking.\n* **Pipedrive:** visual pipelines.");
  check("two names in one label are both found", has(b, "HubSpot") && has(b, "Zoho") && has(b, "Pipedrive"), JSON.stringify(b));
}
{
  const b = names("* **Marks & Spencer:** a retailer.\n* **Barnes & Noble:** books.");
  check("a one-word pair is one brand", b.includes("Marks & Spencer") && b.includes("Barnes & Noble"), JSON.stringify(b));
}

console.log("\nLabels, headings and plain words are not brands");
{
  const b = names("1. **Practice-management CRMs** (portals)\n2. **Traditional sales & relationship CRMs** (business development)\n\n* **TaxDome:** strong portal.\n* **Karbon:** workflow.");
  check("headings ending in a kind of software are left out", !b.includes("Practice-management") && !b.includes("Traditional"), JSON.stringify(b));
  check("and the bullets under them are still found", has(b, "TaxDome") && has(b, "Karbon"), JSON.stringify(b));
}
{
  const b = names("* **Key Features:** the features you need.\n* **Sales & Marketing:** sales and marketing tools.\n* **Watch-out:** pricing rises.\n* **Pricing:** free.\n* **Pipedrive:** visual pipelines.");
  check("section labels are not brands", !b.some((x) => /Key Features|Sales & Marketing|Watch-out|Pricing/.test(x)), JSON.stringify(b));
  check("the real name among them is", has(b, "Pipedrive"), JSON.stringify(b));
}
{
  const b = names("There is no single CRM that dominates every practice. CRM adoption varies.\n\n* **Karbon:** common.");
  check("\"CRM\", the kind of software asked about, is not a brand", !b.includes("CRM"), JSON.stringify(b));
}
{
  const b = names("Paid plans come in tiers like **Basic**, **Professional**, and **Enterprise**.\n\n* **Pipedrive:** simple.");
  check("plan tiers are not brands", !b.some((x) => /^(Basic|Professional|Enterprise)$/.test(x)), JSON.stringify(b));
}
{
  const b = names("**HubSpot** combines marketing and sales.\n\nHowever, **Salesforce can be better** for complex needs.");
  check("a sentence opener is not a brand", !b.includes("However"), JSON.stringify(b));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
