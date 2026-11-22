/*
 * brands-multiword-makers.test.mjs — makers whose names are more than one
 * word, alternatives in one cell, list-item labels, and lowercase makers
 * (1.0.2).
 *
 * From a live run on 22 Nov 2026: 151 prompts across industries, typed into
 * ChatGPT, Gemini, Perplexity and Grok, each stored answer checked against
 * what the engine's page showed. What the brand list said before:
 *   "Follow" for Follow Up Boss (a table cell "Follow Up Boss Pro"),
 *   "Royal" for Royal Canin, "Red" for Red Tape, nothing for New Balance
 *   ("New" is a noise word, so the vendor came back empty);
 *   "Real" for the cell "Real Geeks or Sierra Interactive";
 *   "Team", "Practical", "Entry-level" from list-item labels;
 *   no adidas, written lowercase before a model ("adidas Supernova Solution 3"),
 *   and none at all once adidas.co.in was among the cited sources.
 * The answers below are written for this test in the shapes those answers
 * had; none is a stored answer.
 */
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const brandsOf = (text, ctx = {}) => detectBrands(text, text, ctx).brands.map((b) => b.brand);

console.log("\na maker of more than one word, named in a table and in prose");
{
  const t = [
    "For a small agency, **Follow Up Boss** is the strongest default.",
    "",
    "| CRM | Best for | Price |",
    "|---|---|---|",
    "| **Follow Up Boss Pro** | Most teams | $499/mo |",
    "| **Wise Agent** | Budget | $49/mo |",
    "",
    "Start a trial of Follow Up Boss, then compare it with Wise Agent.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best crm for a real estate agency" });
  check("Follow Up Boss, whole", b.includes("Follow Up Boss"), b.join(", "));
  check("not the first word alone", !b.includes("Follow"), b.join(", "));
}

console.log("\nmakers whose first word is an ordinary word");
{
  const t = [
    "Strongest picks are **Royal Canin Labrador Puppy** and **Purina Pro Plan Large Breed**.",
    "",
    "| Food | Best for |",
    "|---|---|",
    "| **Royal Canin Labrador Puppy** | Purebred Labs |",
    "| **Purina Pro Plan Large Breed** | Joint support |",
    "",
    "If budget allows, **Royal Canin Labrador Puppy** is the most tailored.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best dog food for a labrador puppy" });
  check("Royal Canin, not Royal", b.includes("Royal Canin") && !b.includes("Royal"), b.join(", "));
  check("Purina stays Purina", b.includes("Purina"), b.join(", "));
}
{
  const t = [
    "Within ₹8,000 the strongest picks are the **ASICS GT-2000 13** and **New Balance 860 v14**.",
    "",
    "- **ASICS GT-2000 13**: moderate stability",
    "- **New Balance 860 v14**: firmer support",
    "- **Red Tape Arrow Pro**: a cheaper choice",
    "",
    "New Balance runs slightly wide.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best running shoes for flat feet" });
  check("New Balance is found", b.includes("New Balance"), b.join(", "));
  check("Red Tape, not Red", b.includes("Red Tape") && !b.includes("Red"), b.join(", "));
  check("ASICS stays ASICS", b.includes("ASICS"), b.join(", "));
}

console.log("\na one-word maker named once stays one word");
{
  const t = "| Model | Price |\n|---|---|\n| Skechers Arch Fit 2 | 4,999 |\n| Nike Structure 25 | 7,995 |\n\nSkechers suits walking.";
  const b = brandsOf(t, { prompt: "best walking shoes" });
  check("Skechers and Nike, not their model lines", b.includes("Skechers") && b.includes("Nike") && !b.some((x) => /Arch|Structure/.test(x)), b.join(", "));
}

console.log("\nalternatives in one cell");
{
  const t = [
    "| CRM | Situation |",
    "|---|---|",
    "| **Real Geeks or Sierra Interactive** | Lead-heavy teams |",
    "| **Lofty or BoldTrail (kvCORE)** | Past clients |",
    "",
    "Real Geeks and Sierra Interactive both bundle a website; Lofty and BoldTrail focus on nurture.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "which crm is best for real estate" });
  check("each alternative is its own name", ["Real Geeks", "Sierra Interactive", "Lofty", "BoldTrail"].every((x) => b.includes(x)), b.join(", "));
  check("no \"Real\" on its own", !b.includes("Real"), b.join(", "));
}

console.log("\nlist-item labels are not makers");
{
  const t = [
    "**Zoho CRM** is the budget pick.",
    "",
    "- **Team features**: shared pipelines and lead routing",
    "- **Practical advice**: start with a trial",
    "- **Entry-level alternative**: a spreadsheet",
    "",
    "Zoho CRM integrates with Zoho Books.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best crm for small teams" });
  check("Team, Practical and Entry-level are not brands", !b.some((x) => /^(Team|Practical|Entry-level)$/.test(x)), b.join(", "));
  check("Zoho is", b.some((x) => /^Zoho/.test(x)), b.join(", "));
}

console.log("\na maker written in lowercase before a model");
{
  const t = [
    "1. **ASICS GT-2000 14** — the best overall pick",
    "2. **adidas Supernova Solution 3** — softer support",
    "",
    "Buy from authorised sellers or the brand sites (ASICS, adidas).",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best running shoes for flat feet" });
  check("adidas is found", b.includes("adidas"), b.join(", "));
  const withSite = brandsOf(t, { prompt: "best running shoes for flat feet", sources: [{ domain: "adidas.co.in", outcome: "cited" }] });
  check("and still found when its site is cited", withSite.includes("adidas"), withSite.join(", "));
}

console.log("\nmakers listed in a sentence");
{
  const t = [
    "With a budget of **₹8,000**, you can get some very good options from ASICS, Brooks, New Balance, Adidas and Puma.",
    "",
    "1. **ASICS GT-2000 13** — the best overall value",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best running shoes for flat feet" });
  check("all five makers", ["ASICS", "Brooks", "New Balance", "Adidas", "Puma"].every((x) => b.includes(x)), b.join(", "));
  const places = brandsOf("Delivery is fastest in cities such as Pune, Delhi and Mumbai. **Blue Dart 24** is quickest.", { prompt: "fastest courier" });
  check("a list of places is not a list of makers", !places.some((x) => /^(Pune|Delhi|Mumbai)$/.test(x)), places.join(", "));
}

console.log("\nnames in bold after a heading's label");
{
  const t = [
    "### 1. Best Overall for Brokerages: **Sell.Do** (or **TeleCRM**)",
    "It pulls leads from property portals.",
    "### 2. Best Budget All-Rounder: **Zoho CRM**",
    "Predictable per-user pricing.",
    "### 3. Best for Simplicity: **Pipedrive**",
    "A visual pipeline agents actually use.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "which crm is best for a real estate agency" });
  check("each pick is found", ["Sell.Do", "TeleCRM", "Pipedrive"].every((x) => b.includes(x)) && b.some((x) => /^Zoho/.test(x)), b.join(", "));
  check("the labels are not", !b.some((x) => /Best|Overall|Simplicity/.test(x)), b.join(", "));
}

console.log("\na bold list of names");
{
  const t = "**Jira, Linear, ClickUp, Asana, and monday.com** consistently rank among the top picks.\n\n- **Linear**: fast issue tracking\n- **ClickUp**: everything in one place";
  const b = brandsOf(t, { prompt: "top project management tools" });
  check("Jira, named only in the list, is found", b.includes("Jira"), b.join(", "));
}

console.log("\nlabels and parts are not makers");
{
  const t = [
    "- **NordVPN**: fastest for streaming",
    "- **Privacy/Security**: audited no-logs policy",
    "- **Features/riders**: compare add-ons",
    "",
    "| Laptop | GPU |",
    "|---|---|",
    "| **Lenovo LOQ 15** | RTX 4050 |",
    "| **HP Victus 15** | RTX 3050 |",
    "",
    "Both pair a **Ryzen 7 7735HS** with an RTX card. NordVPN is the pick.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best gaming laptop" });
  check("no Word/Word label", !b.some((x) => x.includes("/")), b.join(", "));
  check("no RTX or Ryzen", !b.some((x) => /^(RTX|Ryzen)$/.test(x)), b.join(", "));
  check("Lenovo and HP are", b.includes("Lenovo") && b.includes("HP"), b.join(", "));
}

console.log("\nan acronym maker that spells a category word");
{
  const t = "| Model | Range |\n|---|---|\n| **Ola S1 Pro** | 320 km |\n| **TVS iQube ST** | 212 km |\n\nTVS is known for accurate range estimates.";
  const b = brandsOf(t, { prompt: "which electric scooter has the best range" });
  check("TVS is not mistaken for \"TVs\"", b.includes("TVS"), b.join(", "));
}

console.log("\npicks listed after \"include\"");
{
  const t = "Top luxury wedding-hotel picks in Lakeport include The Marlow Palace Lakeport, Fairhaven Lakeport, Orrin Grand Resort & Spa, and Vellore Rajvilas. Fairhaven is noted for large room blocks.";
  const b = brandsOf(t, { prompt: "top luxury hotels in lakeport for a wedding" });
  check("each hotel named", ["Fairhaven Lakeport", "Orrin Grand Resort & Spa", "Vellore Rajvilas"].every((x) => b.includes(x)) && b.some((x) => /^The Marlow/.test(x)), b.join(" | "));
}

console.log("\na bold question is not a name");
{
  const t = "**1. What are you hosting?**\n\n- ○ A shop\n\n**3. Expected monthly visitors?**\n\n- ○ Under 1,000\n\n**Hostinger** is the cheapest start.";
  const b = brandsOf(t, { prompt: "top cloud hosting providers" });
  check("no \"Expected\"", !b.includes("Expected"), b.join(" | "));
}

console.log("\nGemini's bold picks: a list, a label before a dash, a name bolded again");
{
  const t = [
    "The best kit depends on what you value. **Freshbox** leads for **menu variety**, while **Plateful** wins on **low prices**.",
    "",
    "* **Best for Variety — Freshbox:** Offers 90 weekly recipes. Quickbite and Homeplate note its fresh produce.",
    "* **Best Low-Cost Pick — Plateful:** Starts around $6 per serving, per Quickbite and The Pantry.",
    "",
    "Global programs such as **Lakeport Business School**, **Harbour College**, and **Vell University (Kelley)** carry the most weight.",
    "",
    "Pick **Freshbox** for families and **Plateful** to save money.",
  ].join("\n");
  const b = brandsOf(t, { prompt: "which meal kit is best", sources: [{ domain: "quickbite.com", outcome: "cited" }, { domain: "thepantry.com", outcome: "cited" }] });
  check("the picks are found", b.includes("Freshbox") && b.includes("Plateful"), b.join(" | "));
  check("each bold name in the list", ["Lakeport Business School", "Harbour College"].every((x) => b.includes(x)) && b.some((x) => /^Vell University/.test(x)), b.join(" | "));
  check("the publishers it quotes are not brands", !b.includes("Quickbite") && !b.includes("The Pantry"), b.join(" | "));
  check("no \"Best for Variety\" label", !b.some((x) => /^Best/.test(x)), b.join(" | "));
}

console.log("\na lender table with a category column");
{
  const t = [
    "### Indicative Home Loan Interest Rates (November 2026)",
    "",
    "| Lender Category | Lender | Starting Rate |",
    "| :--- | :--- | :--- |",
    "| **Public Sector Banks** | Bank of Lakeport | ~7.00% |",
    "| **Public Sector Banks** | Central Bank of Harbour | ~7.25% |",
    "| **Public Sector Banks** | Bank of Vell | ~7.35% |",
    "| **Private Sector Banks** | Orrin Bank | ~7.45% |",
  ].join("\n");
  const b = brandsOf(t, { prompt: "best home loan interest rates" });
  check("each lender by its full name", ["Bank of Lakeport", "Central Bank of Harbour", "Bank of Vell", "Orrin Bank"].every((x) => b.includes(x)), b.join(" | "));
  check("no category or heading word", !b.some((x) => /^(Bank|Central|Public Sector|Private Sector|Indicative)$/.test(x)), b.join(" | "));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
