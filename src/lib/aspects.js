/*
 * aspects.js — what an answer rates a brand for ("best for battery", "known
 * for comfort"), from the brand's own passages. Moved out of ui/panel.js in
 * 0.50.0 so the campaign board can count, across a campaign, what the
 * engines recommend each brand for; the panel still uses it for the chips
 * under each brand in Analyze. No DOM or chrome.* use.
 */
import { sanitizeText, trimLabel } from "./text-sanitize.js";

// Takes the brand's OWN passages (b.passages — each already a tight, correctly
// scoped ±110-char window around one real mention, computed by the adapter/
// src/lib/brands.js) instead of re-deriving a window from the full answer
// text. The previous version re-scanned a fresh 350-char slice of raw text
// and cut it off at the next hardcoded smartphone-brand name it could find —
// in dense side-by-side comparisons (several brands named within a couple of
// sentences of each other, e.g. a TV shootout) that cutoff landed almost
// immediately, so real aspects a few words later were silently missed. Using
// the passage(s) already scoped to THIS brand's own mentions avoids that
// failure mode entirely, and scanning every passage (not just the first)
// catches aspects raised at a brand's later mentions too.
//
// Aspects come from two places, in order of trust:
//
//  1. What the answer SAYS it rates the brand for — "best for <x>", "known for
//     <x>", "stands out for <x>". The label is lifted from the sentence, so it
//     works in any vertical without knowing a single industry word ("low
//     processing fees", "same-day delivery", "crack resistance").
//  2. A curated dimension map, as a fallback for answers that describe a brand
//     without ever labelling why. This used to be phone specs ONLY — camera,
//     battery, display, chipset — so a cement or lending answer either got
//     nothing or, worse, got "Performance" off the word "speed" and "Design"
//     off "premium". The map now spans the dimensions any category gets
//     compared on, and the phone-specific triggers only fire on words that
//     genuinely mean a phone spec.
export const ASPECT_DIMENSIONS = [
  ["Price & Value", /\b(price|pricing|cost|affordable|budget|value for money|cheaper|expensive|premium pricing|discount|emi)\b/],
  ["Fees & Rates", /\b(interest rate|interest rates|apr|processing fee|processing fees|brokerage|commission|charges|no annual fee|expense ratio)\b/],
  ["Quality", /\b(quality|grade|purity|strength|finish|craftsmanship|ingredients|material|materials)\b/],
  ["Durability", /\b(durability|durable|long[- ]lasting|weather resistant|crack resistan|warranty|wear and tear)\b/],
  ["Service & Support", /\b(customer (?:service|support|care)|after[- ]sales|helpline|turnaround time|claim settlement|onboarding)\b/],
  ["Availability", /\b(availability|widely available|in stock|distribution network|dealer network|branches|nationwide|delivery time)\b/],
  ["Trust & Reputation", /\b(trusted|reputation|reliable|legacy|established|market leader|credibility|certified|regulated|iso )\b/],
  ["Safety", /\b(safety|safe for|side effects|clinically|dermatologically|non[- ]toxic|fda|hypoallergenic)\b/],
  ["Sustainability", /\b(sustainab|eco[- ]friendly|recycl|carbon|green building|organic|cruelty[- ]free)\b/],
  ["Camera", /\b(camera|cameras|megapixel|telephoto|portrait mode|hasselblad|optical zoom)\b/],
  ["Battery", /\b(battery|mah|fast charging|wireless charging|battery backup)\b/],
  ["Display", /\b(display|screen|amoled|oled|refresh rate|120hz|ltpo|hdr|dolby vision)\b/],
  ["Performance", /\b(processor|chipset|snapdragon|dimensity|benchmark|ram|cpu|gpu|thermal throttl)\b/],
  ["Software", /\b(software update|os update|years of updates|user interface|bloatware|ecosystem)\b/],
];

// "Best for gaming and photography" → "gaming and photography". Bounded to a
// short noun phrase so a whole sentence never becomes a chip.
const ASPECT_PHRASE_RE =
  /\b(?:best|ideal|great|good|preferred|recommended|popular|known|noted|praised|valued|stands out)\s+(?:choice\s+)?for\s+(?:its\s+)?([a-z][a-z0-9 &/,'-]{2,40}?)(?=[.,;:!?)]|\band\b\s+(?:it|they|the)\b|$)/gi;
const ASPECT_PHRASE_STOP = /^(the|a|an|you|those|them|it|this|that|these|him|her|us|people|users|customers|anyone|everyone|most|some|many)\b/i;

export function extractBrandAspects(passages) {
  const raw = sanitizeText((passages || []).join(" "));
  if (!raw) return [];
  const text = raw.toLowerCase();

  const aspects = [];
  const seen = new Set();
  const push = (label) => {
    const k = label.toLowerCase();
    if (!seen.has(k)) { seen.add(k); aspects.push(label); }
  };

  // 1. aspects the answer states outright
  let m;
  ASPECT_PHRASE_RE.lastIndex = 0;
  while ((m = ASPECT_PHRASE_RE.exec(raw))) {
    // Same bounding as the list-header path, so both chip sources are
    // trimmed by one rule rather than two that drift apart.
    const phrase = trimLabel(m[1]);
    if (!phrase || ASPECT_PHRASE_STOP.test(phrase)) continue;
    push(phrase.charAt(0).toUpperCase() + phrase.slice(1));
    if (aspects.length >= 3) return aspects;
  }

  // 2. fall back to the dimension map
  for (const [label, re] of ASPECT_DIMENSIONS) {
    if (re.test(text)) push(label);
    if (aspects.length >= 3) break;
  }

  return aspects.slice(0, 3);
}
