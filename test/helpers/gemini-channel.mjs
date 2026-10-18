/*
 * gemini-channel.mjs — made-up Gemini WebChannel traffic for the tests.
 *
 * Builds protobuf by hand in the shape lib/geminiChannel.js reads (mapped
 * from the owner's probes; none of their content is used here): the upload
 * that carries the prompt, and down-channel frames that repeat a growing
 * answer, with "Searched the web" pages and product cards. Brands, stores
 * and sites are invented.
 */

const enc = new TextEncoder();
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

/** A message from [field, value] pairs: a string, a number (varint) or a nested message (Uint8Array). */
export function msg(...fields) {
  const parts = [];
  for (const [f, v] of fields) {
    if (v == null) continue;
    if (typeof v === "number") { parts.push(Uint8Array.from(varint(f * 8)), Uint8Array.from(varint(v))); continue; }
    const bytes = typeof v === "string" ? enc.encode(v) : v;
    parts.push(Uint8Array.from(varint(f * 8 + 2)), Uint8Array.from(varint(bytes.length)), bytes);
  }
  return cat(parts);
}
/** The same field number again and again (a repeated field). */
const many = (f, list) => list.map((v) => [f, v]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

export const CONVERSATION = "c_0a1b2c3d4e5f6071";
export const RESPONSE = "r_9f8e7d6c5b4a3921";

export const SOURCES = [
  { url: "https://phonelab.example/best-waterproof-phones", title: "Best waterproof phones (Oct 2026) - PhoneLab" },
  { url: "https://gadgetdesk.example/zento-x9-review", title: "Zento X9 review: IP69 and a big battery" },
  { url: "https://pricewatch.example/phones-under-60000", title: "Phones under 60,000 - PriceWatch" },
];

export const PRODUCTS = [
  { name: "Zento X9 5G", price: "₹49,999.00", brand: "Zento", rating: "4.6", store: "MegaMart", storeUrl: "https://megamart.example/p/zento-x9", was: "₹54,999.00" },
  { name: "Kovo Aqua Pro", price: "₹57,499.00", brand: "Kovo", rating: "4.4", store: "CityPhones", storeUrl: "https://cityphones.example/kovo-aqua-pro" },
];

export const ANSWER = [
  "For a **waterproof phone under ₹60,000**, look for an **IP68 or IP69 rating**.",
  "",
  "1. **Zento X9 5G**: IP69, a 6,500 mAh battery and the brightest screen here.",
  "",
  "http://googleusercontent.com/shopping_content/1001",
  "",
  "2. **Kovo Aqua Pro**: IP68 with a smaller body; Lumi Note 4 is the cheaper pick.",
  "",
  "http://googleusercontent.com/shopping_content/1002",
].join("\n");

function card(p, i) {
  return msg(
    [1, msg([1, `http://googleusercontent.com/shopping_content/100${i + 1}`])],
    [4, msg(
      [11, p.name],
      [13, `https://google.com/search?q=${encodeURIComponent(p.name)}&prds=catalogid%3A${i + 1}`],
      [14, p.price],
      [15, `${p.name}: a made-up phone for the tests.`],
      [16, msg([1, msg([1, msg([1, `https://img.example/${i + 1}.jpg`])])])],
      [17, p.rating],
      [21, p.brand],
      [24, msg([1, msg([1, p.store], [5, p.price], [7, p.was || null], [11, p.storeUrl])])],
      [28, p.store],
    )],
  );
}

/** One down-channel payload with the answer cut at `upTo` characters. */
export function responsePayload(upTo = ANSWER.length, { response = RESPONSE, answer = ANSWER } = {}) {
  const pages = SOURCES.map((s) => msg([1, `https://favicon.example/${new URL(s.url).hostname}`], [2, s.url], [3, s.title]));
  const searched = msg([2, "Searched the web"], [3, "Google Search"], ...many(8, pages));
  const candidate = msg(
    [1, "rc_1234567890abcdef"],
    [2, msg([1, answer.slice(0, upTo)])],
    [10, "en"],
    [13, msg(...many(16, PRODUCTS.map(card)))],
    [38, msg([2, searched])],
  );
  // The real frames also carry a long topic list (field 25); padding of the
  // same kind keeps these frames a realistic size.
  const noise = msg([25, msg([5, msg(...many(1, Array.from({ length: 60 }, (_, k) => `topic-${k}`)))])]);
  const resp = msg([2, msg([1, CONVERSATION], [2, response])], [5, candidate], [6, msg([1, "Pune, Maharashtra, India"])], [9, "IN"], noise, [43, "3.6 Flash"]);
  return msg([2, msg([7, msg([1, msg([2, msg([1, response])], [4, msg([4, resp])])])])]);
}

/** Down-channel text: noops, a "Searching the web" status frame, then the answer growing over `steps` frames. */
export function channelStream({ steps = 4, firstId = 10, response = RESPONSE, answer = ANSWER } = {}) {
  const frames = [];
  let id = firstId;
  frames.push(JSON.stringify([[id++, ["noop"]]]));
  // As on the wire, the status frame carries the long topic list too.
  const noise = msg([25, msg([5, msg(...many(1, Array.from({ length: 60 }, (_, k) => `topic-${k}`)))])]);
  const status = msg([2, msg([7, msg([1, msg([2, msg([1, response])], [4, msg([4, msg([2, msg([1, CONVERSATION], [2, response])], [7, msg([2, msg([1, "google"], [2, msg([6, "Searching the web"])])])], noise)])])])])]);
  frames.push(JSON.stringify([[id++, [b64(status)]]]));
  for (let k = 1; k <= steps; k++) frames.push(JSON.stringify([[id++, [b64(responsePayload(Math.ceil((answer.length * k) / steps), { response, answer }))]]]));
  return frames.map((f) => `${f.length}\n${f}`).join("");
}

/** The up-channel form body carrying the prompt (and a second request, as Gemini sends). */
export function uploadBody(prompt) {
  const turn = msg([1, msg([1, prompt], [2, 0])], [2, msg([1, "en"])]); // 1.8.5.1
  const req0 = msg([1, msg([1, msg([1, 1], [3, "en"], [4, "00000000-0000-4000-8000-000000000000"])], [8, msg([5, msg([1, turn])])])]);
  const req1 = msg([2, msg([1, 1], [9, prompt])]);
  return `count=2&ofs=0&req0___data__=${encodeURIComponent(b64(req0))}&req1___data__=${encodeURIComponent(b64(req1))}`;
}
