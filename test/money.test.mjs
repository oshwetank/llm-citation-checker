/*
 * Prices in any currency (src/lib/money.js, 0.69.0). Run: node test/money.test.mjs
 *
 * Reported: the tool is used for brands in every market, but every price
 * reader assumed ₹/$/€ and the reports printed every amount as rupees.
 */
import { parsePrice, parsePrices, parseNumber, formatMoney, averageByCurrency, hasPrice } from "../src/lib/money.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const eq = (label, got, amount, currency) =>
  check(label, got && Math.abs(got.amount - amount) < 1e-6 && got.currency === currency, JSON.stringify(got));

console.log("currencies before and after the number");
eq("$1,299.00", parsePrice("Now $1,299.00 at most stores"), 1299, "USD");
eq("€45", parsePrice("From €45"), 45, "EUR");
eq("12,50 €", parsePrice("costs 12,50 € a month"), 12.5, "EUR");
eq("£899", parsePrice("£899"), 899, "GBP");
eq("¥128,000", parsePrice("¥128,000"), 128000, "JPY");
eq("₹23,999", parsePrice("₹23,999"), 23999, "INR");
eq("Rs. 1,00,000", parsePrice("Rs. 1,00,000"), 100000, "INR");
eq("R$ 1.299,90", parsePrice("R$ 1.299,90"), 1299.9, "BRL");
eq("1 299 kr", parsePrice("1 299 kr"), 1299, "SEK");
eq("49,99 zł", parsePrice("49,99 zł"), 49.99, "PLN");
eq("CHF 79", parsePrice("CHF 79"), 79, "CHF");
eq("AED 2,499", parsePrice("AED 2,499"), 2499, "AED");
eq("₩1,500,000", parsePrice("₩1,500,000"), 1500000, "KRW");
eq("A$349", parsePrice("A$349"), 349, "AUD");
eq("1.299 €", parsePrice("1.299 €"), 1299, "EUR");
eq("₹1.2 lakh", parsePrice("₹1.2 lakh"), 120000, "INR");
eq("$5k", parsePrice("under $5k"), 5000, "USD");
eq("USD 12.5m", parsePrice("USD 12.5m contract"), 12500000, "USD");

console.log("no price where there is none");
check("plain number", parsePrice("Top 10 picks for 2026") === null);
check("model name with numbers", parsePrice("Zento Nova 8 Pro 5G") === null);
check("a word starting with kr", parsePrice("Kraków office 2026") === null);
check("hasPrice", hasPrice("only €9") && !hasPrice("version 2.5"));

console.log("several prices");
const many = parsePrices("Kovo at $299, Zento at €279 and Lumi at £249.");
check("three prices in order", many.length === 3 && many.map((p) => p.currency).join() === "USD,EUR,GBP", JSON.stringify(many));

console.log("numbers");
check("1,00,000", parseNumber("1,00,000") === 100000);
check("1.234.567,8", parseNumber("1.234.567,8") === 1234567.8);
check("12,5", parseNumber("12,5") === 12.5);

console.log("formatting in the price's own currency");
const f1 = formatMoney(1299.9, "BRL", "en-US");
check("BRL", /R\$/.test(f1) && /1,299\.90/.test(f1), f1);
const f2 = formatMoney(23999, "INR", "en-IN");
check("INR en-IN", f2 === "₹23,999", f2);
const f3 = formatMoney(899, "GBP", "de-DE");
check("GBP in German", /899/.test(f3) && /£/.test(f3), f3);
check("no currency", formatMoney(42, null, "en-US") === "42");
{ const b = formatMoney(5, "XXQ", "en-US"); check("unknown code still shown", /XXQ/.test(b) && /5/.test(b), b); }
check("null amount", formatMoney(null, "USD") === "—");

console.log("averages never mix currencies");
const av = averageByCurrency([{ amount: 100, currency: "USD" }, { amount: 300, currency: "USD" }, { amount: 50, currency: "EUR" }]);
check("two groups", av.length === 2 && av[0].currency === "USD" && av[0].average === 200 && av[1].average === 50, JSON.stringify(av));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
