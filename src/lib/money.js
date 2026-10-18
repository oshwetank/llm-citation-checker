/*
 * money.js — prices in any currency (0.69.0).
 *
 * Before this, every price reader assumed rupees, dollars or euros and the
 * reports printed every amount as "₹… en-IN". The tool is used for brands in
 * every market, so a price is read with its own currency and shown in it.
 *
 * parsePrice("R$ 1.299,90")  -> { amount: 1299.9, currency: "BRL", raw }
 * parsePrice("12,50 €")      -> { amount: 12.5,   currency: "EUR", raw }
 * parsePrice("₹1.2 lakh")    -> { amount: 120000, currency: "INR", raw }
 * formatMoney(1299.9, "BRL") -> "R$ 1,299.90" (in the reader's locale)
 *
 * A bare "$" is read as USD, "¥" as JPY and "kr" as SEK: the symbol alone
 * can't say more, and the raw text is always kept beside the amount.
 */

// Prefixed dollar and yen variants first, so "R$" never reads as "$".
const SYMBOLS = [
  ["US$", "USD"], ["CA$", "CAD"], ["C$", "CAD"], ["A$", "AUD"], ["AU$", "AUD"], ["NZ$", "NZD"],
  ["HK$", "HKD"], ["S$", "SGD"], ["NT$", "TWD"], ["MX$", "MXN"], ["R$", "BRL"], ["CN¥", "CNY"],
  ["RMB", "CNY"], ["Rs.", "INR"], ["Rs", "INR"], ["₹", "INR"], ["$", "USD"], ["€", "EUR"],
  ["£", "GBP"], ["¥", "JPY"], ["円", "JPY"], ["元", "CNY"], ["₩", "KRW"], ["₽", "RUB"],
  ["₺", "TRY"], ["₫", "VND"], ["₱", "PHP"], ["฿", "THB"], ["₪", "ILS"], ["₦", "NGN"],
  ["₴", "UAH"], ["₸", "KZT"], ["৳", "BDT"], ["zł", "PLN"], ["Kč", "CZK"], ["kr", "SEK"],
  ["Ft", "HUF"], ["lei", "RON"], ["RM", "MYR"], ["Rp", "IDR"], ["د.إ", "AED"], ["ر.س", "SAR"],
];
const CODES = [
  "USD", "EUR", "GBP", "INR", "JPY", "CNY", "KRW", "BRL", "CAD", "AUD", "NZD", "MXN", "CHF",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "TRY", "RUB", "UAH", "ZAR", "NGN", "KES",
  "EGP", "MAD", "AED", "SAR", "QAR", "KWD", "ILS", "SGD", "HKD", "TWD", "THB", "VND", "PHP",
  "IDR", "MYR", "PKR", "BDT", "LKR", "ARS", "CLP", "COP", "PEN", "KZT",
];
const SYMBOL_TO_CODE = new Map(SYMBOLS);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so the alternation never stops at a shorter prefix.
const markers = [...SYMBOLS.map((s) => s[0]), ...CODES].sort((a, b) => b.length - a.length);
// Letter markers ("kr", "Rs", "USD") need a word edge; symbols don't.
const MARK = `(?:${markers.map((m) => (/^[A-Za-z]/.test(m) ? `(?<![A-Za-z])${esc(m)}(?![A-Za-z])` : esc(m))).join("|")})`;
const NUM = String.raw`\d{1,3}(?:[,.   ]\d{2,3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SUFFIX = String.raw`(?:\s?(?:lakhs?|lacs?|crores?|cr|k|K|mn|m|M|bn|B)(?![A-Za-z]))?`;

// A price with its currency before or after the number. Exported for
// readers that only need to find one (genui.js, the Gemini adapter).
export const PRICE_RE = new RegExp(`${MARK}\\s?(?:${NUM})${SUFFIX}|(?:${NUM})${SUFFIX}\\s?${MARK}`, "u");
const PRICE_RE_G = new RegExp(PRICE_RE.source, "gu");
const MARK_RE = new RegExp(MARK, "u");

function codeOf(marker) {
  const m = String(marker || "").trim();
  if (SYMBOL_TO_CODE.has(m)) return SYMBOL_TO_CODE.get(m);
  const up = m.toUpperCase();
  return CODES.includes(up) ? up : null;
}

// "1,299.00" / "1.299,00" / "1 299" / "1,00,000" / "12,50" -> a number.
export function parseNumber(s) {
  let t = String(s || "").replace(/[   ]/g, " ").trim();
  if (!/\d/.test(t)) return null;
  t = t.replace(/ /g, "");
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both used: the last one is the decimal mark.
    const dec = lastComma > lastDot ? "," : ".";
    const grp = dec === "," ? "." : ",";
    t = t.split(grp).join("").replace(dec, ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = t.split(sep);
    const tail = parts[parts.length - 1];
    // One separator kind: three digits after it means grouping ("1,299",
    // "1.299", "1,00,000"); otherwise it is the decimal mark ("12,50").
    if (parts.length > 2 || tail.length === 3) t = parts.join("");
    else t = parts.join(".");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MULT = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3, mn: 1e6, m: 1e6, bn: 1e9, b: 1e9 };

function readMatch(raw) {
  const mark = MARK_RE.exec(raw);
  const currency = mark ? codeOf(mark[0]) : null;
  const rest = mark ? raw.slice(0, mark.index) + " " + raw.slice(mark.index + mark[0].length) : raw;
  const num = new RegExp(`(${NUM})`).exec(rest);
  if (!num) return null;
  let amount = parseNumber(num[1]);
  if (amount == null) return null;
  const suf = /(lakhs?|lacs?|crores?|cr|k|mn|m|bn|b)(?![a-z])/i.exec(rest.slice(num.index + num[1].length));
  if (suf) amount *= MULT[suf[1].toLowerCase()] || 1;
  return { amount, currency, raw: raw.trim() };
}

// The first price in a text, or null.
export function parsePrice(text) {
  const m = PRICE_RE.exec(String(text || ""));
  return m ? readMatch(m[0]) : null;
}

// Every price in a text, in order.
export function parsePrices(text) {
  return [...String(text || "").matchAll(PRICE_RE_G)].map((m) => readMatch(m[0])).filter(Boolean);
}

export const hasPrice = (text) => PRICE_RE.test(String(text || ""));

// An amount in its own currency, written the reader's way.
export function formatMoney(amount, currency, locale) {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  const n = Number(amount);
  const whole = Math.abs(n - Math.round(n)) < 1e-9;
  if (currency) {
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: "currency", currency, maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2,
      }).format(n);
    } catch { /* an unknown code: fall through to a plain number */ }
  }
  const plain = new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 2 }).format(n);
  return currency ? `${currency} ${plain}` : plain;
}

// Averages per currency: amounts in different currencies are never added.
export function averageByCurrency(prices) {
  const by = new Map();
  for (const p of prices || []) {
    if (!p || p.amount == null) continue;
    const k = p.currency || "";
    const e = by.get(k) || { currency: p.currency || null, sum: 0, count: 0 };
    e.sum += p.amount;
    e.count++;
    by.set(k, e);
  }
  return [...by.values()].map((e) => ({ currency: e.currency, average: e.sum / e.count, count: e.count }))
    .sort((a, b) => b.count - a.count);
}
