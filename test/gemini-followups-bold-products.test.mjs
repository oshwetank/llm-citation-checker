/*
 * gemini-followups-bold-products.test.mjs — two things in the owner's Gemini
 * answer of 15 Nov 2026 ("dead phone buy"):
 *  - its suggested follow-ups, "<ElicitationsGroup …><Elicitation …/>…", were
 *    kept as answer text;
 *  - "Devices like the **Realme P4 Power** and **Redmi Note 17 Pro Max** pack…"
 *    named two brands that weren't found: only a line's first bold was read.
 * The text is a shortened copy of that answer.
 */
import { stripCardPlaceholders } from "../src/adapters/gemini.js";
import { detectBrands } from "../src/lib/brands.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const brandsOf = (t) => { const d = detectBrands(t, t, {}); return (d.brands || d).map((b) => b.brand || b.name); };

const ANSWER = `### Scenario B: Buying a Phone with a "Dead-Battery Proof" Battery Life
If you meant you want a smartphone with a massive battery that never seems to die:

* **Massive Battery Powerhouses (10,000mAh Class):** Devices like the **Realme P4 Power** and **Redmi Note 17 Pro Max** pack staggering 10,000mAh+ batteries.
* **Flagship Battery Kings:**
  * **OnePlus 15** (featuring a massive 7,300mAh battery and ultra-fast charging).
  * **Xiaomi Poco F9 Ultra** (boasting an 8,050mAh battery).

---

<ElicitationsGroup message="Which type of phone purchase were you looking for?">
  <Elicitation label="Tips and risks for buying broken phones" query="What are the main risks when buying broken phones?"/>
  <Elicitation label="Explore the smartphones with the biggest battery life" query="What are the best smartphones with the largest battery?"/>
</ElicitationsGroup>`;

console.log("\nfollow-ups");
const { text } = stripCardPlaceholders(ANSWER);
check("no follow-up markup left", !/Elicitation/.test(text), text.slice(-200));
check("no rule left dangling at the end", !/-{3,}\s*$/.test(text), JSON.stringify(text.slice(-40)));
check("the answer itself is kept", /Xiaomi Poco F9 Ultra\*\* \(boasting an 8,050mAh battery\)\.$/.test(text), JSON.stringify(text.slice(-80)));

console.log("\nbrands named in bold inside a sentence");
{
  const b = brandsOf(text);
  for (const name of ["Realme", "Redmi", "OnePlus", "Xiaomi"]) check(`${name} found`, b.includes(name), b.join(", "));
}

console.log("\nbold emphasis is not a brand");
{
  const t = "If you meant a phone with **incredible battery life**, look for **Step 2** and **Under 15000** options with **5,000mAh** cells.\n\nThe **Best 5G** pick depends on budget. Prices as of **November 2026**; it runs the **Snapdragon 8 Gen 5** chip.";
  const b = brandsOf(t);
  check("nothing found", b.length === 0, b.join(", "));
}

console.log("\nan answer whose brands come from its prose keeps them");
{
  // fd5e719a in the owner's campaign: brands only in prose, plus two bold
  // names mid-sentence. Reading those as structure switched the prose pass off.
  const t = "Here are the best phones of 2026.\n\n### 1. Best Overall: **Apple iPhone 18 Pro Max**\nThe iPhone 18 Pro Max is fast.\n\n### 2. Best Android: **Samsung Galaxy S26 Ultra**\nThe Galaxy S26 Ultra has a great screen.\n\n### 3. Best Camera: **Google Pixel 11 Pro**\nThe Pixel 11 Pro takes great photos with Google's processing.\n\nIf you want both, the **Apple iPhone 18 Pro Max** or the **Samsung Galaxy S26 Ultra** are safe picks, and custom Leica optics make the Xiaomi 17 Ultra a camera pick.";
  const before = brandsOf(t.replace(/\*\*/g, ""));
  const after = brandsOf(t);
  check("nothing the prose found is lost", before.every((b) => after.includes(b)), `${before.join(", ")} → ${after.join(", ")}`);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
