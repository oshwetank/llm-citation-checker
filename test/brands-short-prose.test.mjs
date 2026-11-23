/*
 * brands-short-prose.test.mjs — brands in short, plain-prose answers (1.0.2).
 *
 * Perplexity's answers changed shape: in a live run of 22 Nov 2026, 66 of 151
 * were two or three sentences with no list, table or heading, naming each pick
 * once, often first in its sentence. Brand detection keyed off structure, and
 * its prose fallback needed a name written twice or with a model number, so
 * every one of them reported no brands at all. These are those answers'
 * shapes (texts from the run, trimmed), and the cases the change must not
 * turn into brands.
 */
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const brandsOf = (text, prompt, sources = []) => detectBrands(text, text, { prompt, sources }).brands.map((b) => b.brand);
const has = (b, names) => names.every((n) => b.includes(n));

console.log("\nnames in a list");
{
  const b = brandsOf("Groww is likely the easiest app for a beginner to get started with, thanks to its simple interface. If you want more research tools, compare Zerodha and Upstox before you open an account.", "which stock trading app is best for beginners in India");
  check("Zerodha and Upstox, named once each in a list", has(b, ["Zerodha", "Upstox"]), b.join(", "));
  const s = brandsOf("No app consistently has the best discounts: compare Swiggy and Zomato's offers for your area before you order.", "which food delivery app gives the best discounts in India");
  check("Swiggy and Zomato", has(s, ["Swiggy", "Zomato"]), s.join(", "));
  const t = brandsOf("There's no single best tyre brand for every SUV: Michelin, Continental, Bridgestone and Yokohama all make strong all-terrain options.", "which tyre brand is best for SUVs in India");
  check("a comma list keeps each name apart", has(t, ["Continental", "Bridgestone", "Yokohama"]) && !t.some((x) => /,| and /.test(x)), t.join(", "));
  const h = brandsOf("In India, Hawkins and Prestige are strong all-round choices, with broad service and spare-parts availability.", "best pressure cooker brands");
  check("\"Hawkins and Prestige\" is two names, not one", has(h, ["Hawkins", "Prestige"]), h.join(", "));
  check("\"In India\" opening the sentence is not a name", !h.some((x) => /^In\b/.test(x)), h.join(", "));
}

console.log("\nput forward as the answer");
{
  const j = brandsOf("Jio is often the strongest starting point for rural coverage overall, but check the signal in your village first.", "which mobile network has the best coverage in rural India");
  check("\"Jio is often the strongest starting point\"", j.includes("Jio"), j.join(", "));
  const p = brandsOf("Pampers Pure Protection is a good first option: it's fragrance-free and made for sensitive skin.", "best baby diapers for sensitive skin");
  check("a name opening the answer, framed as the pick", p.includes("Pampers Pure Protection"), p.join(", "));
  const f = brandsOf("For most people, HelloFresh is the best all-around choice: it's highly customizable.", "which meal kit delivery service is best");
  check("a CamelCase name framed as the pick (HelloFresh)", f.includes("HelloFresh"), f.join(", "));
}

console.log("\nbold inside a sentence, exactly the name");
{
  const b = brandsOf("For most families, the **Tata Nexon** is a strong all-round pick under ₹15 lakh. The **Maruti Brezza** is also a top option.", "best car for a family under 15 lakh");
  check("Tata Nexon and Maruti Brezza", has(b, ["Tata Nexon", "Maruti Brezza"]), b.join(", "));
  const e = brandsOf("For most children, choose an **EPA-registered repellent containing picaridin** and apply it sparingly.", "best mosquito repellent for kids");
  check("bold emphasis over a phrase is not a name", !e.some((x) => /EPA/.test(x)), e.join(", "));
}

console.log("\nwhat stays out");
{
  const g = brandsOf("For most Chennai households, a weekly order works best; compare delivery slots before you subscribe.", "best online grocery delivery in Chennai");
  check("a word of the question, written once, is not an answer", !g.includes("Chennai"), g.join(", "));
  const c = brandsOf("Delivery is fastest in cities such as Pune, Delhi and Mumbai, so plan around them.", "fastest courier");
  check("a list of places", !c.some((x) => /^(Pune|Delhi|Mumbai)$/.test(x)), c.join(", "));
  const d = brandsOf("Down to Earth All Purpose Mix is another good choice for mixed plantings.", "best organic fertilizer for vegetable garden", [{ url: "https://x.example/a", domain: "x.example", title: "Review", snippet: "we tried Down to Earth mixes" }]);
  check("the first word of a longer name is not a name of its own", !d.includes("Down"), d.join(", "));
}

console.log("\na table of conditions, not names");
{
  // ChatGPT's protein-powder answer, same run: "Lactose", "Strict" and
  // "Budget-friendly" were reported as brands from its guidance table.
  const t = "| If you are | What to buy |\n|---|---|\n| Lactose intolerance | Whey isolate |\n| Strict vegan | Pea + rice protein |\n| Budget-friendly | Whey concentrate |\n\nGood picks are **MuscleBlaze Biozyme** and **Nakpro**.";
  const b = brandsOf(t, "best protein powder for beginners");
  check("no condition is a brand", !b.some((x) => /^(Lactose|Strict|Budget)/.test(x)), b.join(", "));
  check("the real ones stay", b.includes("Nakpro"), b.join(", "));
}

console.log("\nhalf a name made whole");
{
  // Same run: "Asit Mehta &", "IIM" for IIM Ahmedabad's kind, and the
  // reported "Blue" for Blue Dart.
  const a = brandsOf("For startup accounting in Mumbai, **CA Vijay Singh** and **Asit Mehta & Associates** handle compliance; **Lad & Associates** suits audits.", "top chartered accountant firms for startups in Mumbai");
  check("a name is not cut at its \"&\"", a.includes("Asit Mehta & Associates") && !a.includes("Asit Mehta &"), a.join(", "));
  const h = brandsOf("For complex surgery, **Jeeva Pet Hospital** and **Cessna Lifeline** are strong. Jeeva Pet Hospital runs a 24-hour ICU.", "top veterinary hospitals in Bangalore");
  check("an organisation word stays with its name", h.some((x) => /^Jeeva Pet Hospital$/.test(x)), h.join(", "));
  const b = brandsOf("Ship with **Blue Dart** for speed. Blue Dart covers 35,000 pin codes, while **Delhivery** is cheaper and blue packaging is free.", "best courier for ecommerce");
  check("an ordinary word that is always the first half of the name (Blue Dart)", b.includes("Blue Dart") && !b.includes("Blue"), b.join(", "));
  const n = brandsOf("| Model | Price |\n|---|---|\n| Noise Airwave Max XR | 3,499 |\n| Sony WF-C700N | 7,990 |\n\nStrong noise cancellation on both.", "best earbuds");
  check("a maker followed by its product line stays the maker", n.includes("Noise"), n.join(", "));
}

console.log("\nnames bolded side by side in a sentence");
{
  const t = "Strong options include **Refine Labs** for demand generation, **Directive Consulting** for enterprise SEO, and **Kalungi** for early-stage SaaS.";
  const b = brandsOf(t, "top digital marketing agencies for B2B SaaS");
  check("each is a name", has(b, ["Refine Labs", "Directive Consulting", "Kalungi"]), b.join(", "));
  const u = brandsOf("| Phone | Best for |\n|---|---|\n| **Pixel 10** | **Low Light** |\n| **Galaxy S26** | **Zoom Shots** |\n\nBoth take great photos.", "best camera phone");
  check("but not a table's use-case column", !u.some((x) => /Low Light|Zoom Shots/.test(x)), u.join(", "));
}

console.log("\ntwo names joined by \"&\"");
{
  const t = "| Courier | Why |\n|---|---|\n| **DTDC & Delhivery** | cheapest surface |\n| **Shiprocket** | aggregator |\n\nDTDC is cheapest for small parcels, while Delhivery covers more PIN codes.";
  const b = brandsOf(t, "cheapest courier in India");
  check("are two brands when each is also written alone", has(b, ["DTDC", "Delhivery"]) && !b.includes("DTDC & Delhivery"), b.join(", "));
  const j = brandsOf("| Brand | Why |\n|---|---|\n| **Johnson & Johnson** | baby care |\n| **Himalaya** | herbal |\n\nJohnson & Johnson and Himalaya both make gentle shampoos.", "best baby shampoo");
  check("but one name when its halves never are (Johnson & Johnson)", j.includes("Johnson & Johnson"), j.join(", "));
}

console.log("\nan abbreviation the answer spells out");
{
  const b = brandsOf("For cash-on-delivery (COD) orders, **Delhivery** and **Blue Dart** lead. **COD** remittance takes 2 days; keep your Return to Origin (RTO) rate low with **Shiprocket**.", "which courier is most reliable for cash on delivery orders");
  check("is a term, not a brand (COD, RTO)", !b.includes("COD") && !b.includes("RTO") && has(b, ["Delhivery", "Blue Dart"]), b.join(", "));
}

console.log("\nthe engine's pages as evidence");
{
  const src = [{ url: "https://groww.in/blog/x", domain: "groww.in", title: "Groww app review", snippet: "" }];
  const b = brandsOf("Groww suits a first-time investor because its app is simple.", "which stock trading app is best for beginners in India", src);
  check("a name that is a source's site (groww.in)", b.includes("Groww"), b.join(", "));
}

console.log("\na name opening on its number, and a brand's short name");
{
  // The coworking answer of the same run: "91springboard" (a table row and
  // the bold list) was dropped, and "BHIVE" — named four times, "BHIVE
  // Workspace" once — was counted once and placed fourth.
  const t = [
    "For startups, the strongest Bangalore choices are **BHIVE, 91springboard, Urban Vault, and WeWork**.",
    "",
    "| Space | Best for |",
    "|---|---|",
    "| **BHIVE Workspace** | Early-stage teams |",
    "| **91springboard** | Indie founders |",
    "| **Urban Vault** | Tech teams |",
    "| **WeWork India** | Funded teams |",
    "",
    "BHIVE has the most centres; BHIVE and WeWork both offer day passes.",
  ].join("\n");
  const r = detectBrands(t, t, { prompt: "top coworking spaces in Bangalore for startups", sources: [] }).brands;
  const by = (n) => r.find((b) => b.brand === n);
  check("91springboard is a brand", !!by("91springboard"), r.map((b) => b.brand).join(", "));
  check("BHIVE's short name counts for BHIVE Workspace", by("BHIVE Workspace") && by("BHIVE Workspace").count >= 4, JSON.stringify(by("BHIVE Workspace")));
  check("and BHIVE is named first", r[0] && r[0].brand === "BHIVE Workspace", r.map((b) => b.brand).join(", "));
  const tata = detectBrands("| Car | Why |\n|---|---|\n| **Tata Nexon** | safety |\n| **Tata Curvv** | style |\n\nTata has the wider service network.", null, { prompt: "best SUV", sources: [] }).brands;
  check("a short name two brands share counts for neither", tata.every((b) => b.count === 1), tata.map((b) => `${b.brand}×${b.count}`).join(", "));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
