/*
 * chatgpt-page-copy-cards.test.mjs — ChatGPT's card answers copied off the
 * page (16 Nov 2026). The owner's four feedback captures had card titles
 * written "**1.****Titan Eye+****– Bandra West**" and prices as headings
 * ("# **₹1,85,900**"); the brands came out as "Preferred", "Excellent",
 * "Strong", "Mumbai" instead of the stores and phones named. The texts are
 * shortened copies of those answers, as an older build stored them; the
 * adapter mends them on re-read (tidyPageCopy).
 */
import { tidyPageCopy } from "../src/adapters/chatgpt.js";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const brandsOf = (t) => { const d = detectBrands(t, t, {}); return (d.brands || d).map((b) => b.brand); };

const GLASSES = `If you're looking to buy new prescription glasses in **Mumbai**, I'd recommend checking out these optical stores.

## **Best optical stores in Mumbai**

**1.****Titan Eye+****– Bandra West**

Best overall choice
- Large collection of branded frames
- Good after-sales support
Linking Road, opposite Shoppers Stop

**2.****Lenskart****– Powai**

Budget-friendly options
- Wide range of frames

## **Let me narrow it down for you**

**1. Budget**

Under ₹1,000
Above ₹10,000
**3. Preferred area**

Mumbai – anywhere
Bandra / Andheri`;

const PHONES = `My top recommendations in India for 2026 are:

## **Best phones for club and concert videos**

Best overall for video
**1.****iPhone 17 Pro Max**

# **₹1,85,900**

Amazon.in + others

- Consistent video quality in changing light
- Excellent stabilisation and colour
- Strong video recording features
Best for distant stages
**2.****Samsung Galaxy S26 Ultra**

# **₹1,21,999**

- Useful for recording performers from a distance`;

console.log("\ntidied");
const g = tidyPageCopy(GLASSES), p = tidyPageCopy(PHONES);
check("a bold number and a bold name: a numbered item", /^1\. \*\*Titan Eye\+\*\* \*\*– Bandra West\*\*$/m.test(g), g.split("\n").find((l) => /Titan/.test(l)));
check("a price is not a heading", /^₹1,85,900$/m.test(p) && !/^# /m.test(p), p.split("\n").find((l) => /1,85,900/.test(l)));
check("real headings stay", /^## \*\*Best phones for club and concert videos\*\*$/m.test(p));
check("tidying twice changes nothing", tidyPageCopy(g) === g && tidyPageCopy(p) === p);

console.log("\nbrands");
{
  const b = brandsOf(g);
  check("the stores are found", b.includes("Titan Eye+") && b.includes("Lenskart"), b.join(", "));
  check("the question form's labels are not brands", !b.some((x) => /Preferred|Budget|Mumbai/.test(x)), b.join(", "));
}
{
  const b = brandsOf(p);
  check("the phones' makers are found", b.includes("iPhone") || b.includes("Apple"), b.join(", "));
  check("Samsung is found", b.includes("Samsung"), b.join(", "));
  check("the bullets' adjectives are not brands", !b.some((x) => /Excellent|Strong|Useful|Consistent/.test(x)), b.join(", "));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
