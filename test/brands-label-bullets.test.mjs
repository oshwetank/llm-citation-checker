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

console.log("\nNames listed beside a found brand (1.0.4, stress run)");
{
  const p = "Painting cost per sq ft in Hyderabad in 2026";
  const b = names("| Tier | Cost |\n|---|---|\n| **Economy** | ₹12 |\n| **Standard** | ₹18 |\n\n**Asian Paints** is the most used. I can estimate the total cost for Asian Paints, Berger and Nerolac.", p);
  check("the rest of a list that holds a brand are brands", has(b, "Berger") && has(b, "Nerolac"), JSON.stringify(b));
  check("price bands in a cost table are not", !b.includes("Economy") && !b.includes("Standard"), JSON.stringify(b));
  const v = names("**Asian Paints** leads on reviews. Would you like me to compare Asian Paints vs Berger vs Nerolac?", p);
  check("so are names compared with \"vs\"", has(v, "Berger") && has(v, "Nerolac"), JSON.stringify(v));
  const c = names("**Asian Paints** has painters in Mumbai, Pune and Delhi.", p);
  check("a list of cities beside a brand is not", !c.some((x) => /Mumbai|Pune|Delhi/.test(x)), JSON.stringify(c));
  const n = names("Painters in Mumbai, Pune and Delhi charge more.", p);
  check("a list with no brand in it adds nothing", !n.some((x) => /Mumbai|Pune|Delhi/.test(x)), JSON.stringify(n));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
