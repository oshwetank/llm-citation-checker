/*
 * synth.mjs — made-up campaigns for training and evaluating Ask (0.75.0).
 *
 * Every brand, site and answer here is invented (brand names are built from
 * syllables no real company uses as a whole; sites end in .example), so the
 * training data carries nothing of anyone's. The shapes are the real ones:
 * records as the extension stores them (brandMentions with positions,
 * sources with outcomes, products, the engines' searches, ads, usage
 * limits), profiles and runs as the Campaigns page keeps them. So the tools
 * the model learns to call run on this data exactly as they run on a user's.
 *
 * Deterministic: the same seed gives the same campaigns.
 */

/** A small fast PRNG (mulberry32), so a seed reproduces a dataset. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    shuffle: (xs) => { const a2 = [...xs]; for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
    sample: (xs, n) => r.shuffle(xs).slice(0, n),
  };
  return r;
}

const HEADS = ["Zen", "Kov", "Lum", "Vant", "Orb", "Quil", "Brisk", "Tav", "Nim", "Pell", "Rov", "Sal", "Tel", "Ulm", "Vex", "Wyn", "Yar", "Cor", "Dax", "Fen", "Gal", "Hux", "Ivo", "Jun", "Kel", "Mir", "Nox", "Oda", "Pax", "Riv"];
const TAILS = ["to", "o", "a", "ex", "ia", "ora", "ix", "en", "ari", "um", "ly", "ova", "eo", "ana", "is", "eto", "ica", "ux", "ery", "ondo"];
/** A brand name no real company has (asserted in the generator's test). */
export function brandName(r, taken) {
  for (let i = 0; i < 200; i++) {
    const n = r.pick(HEADS) + r.pick(TAILS);
    if (!taken.has(n)) { taken.add(n); return n; }
  }
  const n = `${r.pick(HEADS)}${r.int(10, 99)}`;
  taken.add(n);
  return n;
}

// Kinds of business, so the questions and sites vary the way users' do:
// consumer goods, software, finance, travel, education, public services, local.
export const VERTICALS = [
  { id: "earbuds", label: "Earbuds", topics: ["Budget", "Sport", "Noise cancelling", "Gaming"], prompts: ["best wireless earbuds under {price}", "earbuds for the gym", "noise cancelling earbuds for travel", "{brand} vs {rival} earbuds", "earbuds with the best battery life", "cheap earbuds for calls"], products: ["Pulse", "Air", "Beat", "Flow"], reviews: ["soundcheck.example", "gearlab.example"], retail: ["shopmart.example", "buyzone.example"], forum: ["talkboard.example"] },
  { id: "crm", label: "CRM software", topics: ["Small business", "Enterprise", "Pricing", "Integrations"], prompts: ["best CRM for a small business", "CRM with the best email integration", "{brand} alternatives", "is {brand} worth the price", "CRM for real estate agents", "cheapest CRM for startups"], products: [], reviews: ["saasreview.example", "stackcompare.example"], retail: [], forum: ["devtalk.example"] },
  { id: "banking", label: "Savings accounts", topics: ["Rates", "Fees", "Trust", "Apps"], prompts: ["best savings account interest rate", "bank with no monthly fees", "is {brand} bank safe", "best banking app", "{brand} vs {rival} savings", "high yield savings account for students"], products: [], reviews: ["moneyguide.example", "ratewatch.example"], retail: [], forum: ["financeforum.example"], public: ["centralbank.example"] },
  { id: "hotels", label: "Hotels", topics: ["Budget", "Family", "Business", "Near the airport"], prompts: ["best family hotels in {city}", "cheap hotels near the airport in {city}", "business hotel in {city} city centre", "{brand} hotel reviews", "hotels with a pool in {city}"], products: [], reviews: ["staycritic.example", "tripnotes.example"], retail: ["bookfast.example"], forum: ["travelboard.example"] },
  { id: "universities", label: "Universities", topics: ["Rankings", "Fees", "Courses", "Scholarships"], prompts: ["best university for computer science in {city}", "affordable MBA programs", "{brand} university reviews", "universities with scholarships for international students", "online degree from a good university"], products: [], reviews: ["uniguide.example"], retail: [], forum: ["studentroom.example"], public: ["education.gov.example"] },
  { id: "govservices", label: "Public services", topics: ["How-to", "Fees", "Online", "Trust"], prompts: ["how to renew a passport online", "how to register a business", "which agency handles tax refunds", "is {brand} the official site", "how long does a driving licence take"], products: [], reviews: ["civicguide.example"], retail: [], forum: ["citizenforum.example"], public: ["services.gov.example", "help.gov.example"] },
  { id: "laptops", label: "Laptops", topics: ["Students", "Gaming", "Battery", "Budget"], prompts: ["best laptop for students under {price}", "gaming laptop with good cooling", "lightest laptop with long battery", "{brand} vs {rival} laptop", "laptop for video editing"], products: ["Book", "Pro", "Air", "Edge"], reviews: ["techverdict.example", "benchmarks.example"], retail: ["shopmart.example", "electrohub.example"], forum: ["talkboard.example"] },
  { id: "coffee", label: "Coffee shops", topics: ["Near me", "Price", "Work-friendly", "Quality"], prompts: ["best coffee shop near me in {city}", "quiet cafe to work in {city}", "cheapest good coffee in {city}", "{brand} coffee reviews", "specialty coffee in {city}"], products: [], reviews: ["localbites.example"], retail: ["maps.example"], forum: ["citytalk.example"] },
  { id: "insurance", label: "Car insurance", topics: ["Price", "Claims", "Young drivers", "Trust"], prompts: ["cheapest car insurance for young drivers", "car insurance with the best claims service", "{brand} insurance reviews", "{brand} vs {rival} car insurance", "is {brand} insurance legit"], products: [], reviews: ["coverguide.example", "ratewatch.example"], retail: [], forum: ["financeforum.example"], public: ["regulator.example"] },
  { id: "running", label: "Running shoes", topics: ["Beginners", "Trail", "Price", "Marathon"], prompts: ["best running shoes for beginners", "trail running shoes for wet ground", "{brand} vs {rival} running shoes", "running shoes under {price}", "best marathon shoes"], products: ["Glide", "Trail", "Swift", "Max"], reviews: ["runnersnote.example", "gearlab.example"], retail: ["shopmart.example", "sportzone.example"], forum: ["runclub.example"] },
];
const CITIES = ["Lisbon", "Pune", "Austin", "Lyon", "Monterrey", "Cairo", "Leeds", "Osaka", "Porto", "Jaipur"];
const PRICES = ["5000", "$100", "€80", "£60", "₹20000", "R$300"];
export const ENGINES = ["chatgpt", "gemini", "perplexity", "grok"];

/**
 * One campaign with its runs and records.
 * @returns {{profile, runs, records, vertical, own, rivals}}
 */
export function makeCampaign(r, i, { minPrompts = 6, maxPrompts = 24 } = {}) {
  const v = r.pick(VERTICALS);
  const taken = new Set();
  const own = brandName(r, taken);
  const rivals = Array.from({ length: r.int(1, 6) }, () => brandName(r, taken));
  const unlisted = Array.from({ length: r.int(0, 3) }, () => brandName(r, taken)); // brands the answers name that the campaign doesn't track
  const listed = r.chance(0.85) ? rivals : []; // some campaigns never set competitors (the tool infers them)
  const profile = {
    id: `p${i}`, name: `${own} ${v.label}${r.chance(0.3) ? ` ${r.pick(CITIES)}` : ""}`,
    brand: { name: own, url: `https://${own.toLowerCase()}.example` },
    competitors: listed.map((n) => ({ name: n, url: r.chance(0.5) ? `https://${n.toLowerCase()}.example` : "" })),
  };
  const engines = r.sample(ENGINES, r.int(1, 4));
  const nRuns = r.int(1, 6);
  const base = Date.UTC(2026, r.int(0, 8), r.int(1, 25));
  const runs = Array.from({ length: nRuns }, (_, k) => ({ id: `${profile.id}r${k + 1}`, profileId: profile.id, startedAt: base + k * 7 * 864e5, status: "done" }));
  // Distinct prompt texts, as a real campaign has: a repeat gets a qualifier.
  const seen = new Set();
  const QUAL = ["in 2026", "for beginners", "with reviews", "near me", "this year", "for families", "on a budget", "for professionals"];
  const prompts = Array.from({ length: r.int(minPrompts, maxPrompts) }, (_, k) => {
    let t = r.pick(v.prompts).replace("{price}", r.pick(PRICES)).replace("{city}", r.pick(CITIES)).replace("{brand}", r.pick([own, ...rivals])).replace("{rival}", r.pick(rivals));
    for (let j = 0; seen.has(t) && j < 20; j++) t = `${t.replace(/ \((?:[^)]*)\)$/, "")} (${r.pick(QUAL)})`;
    if (seen.has(t)) t = `${t} #${k + 1}`;
    seen.add(t);
    const tags = r.chance(0.8) ? [r.pick(v.topics), ...(r.chance(0.4) ? [r.pick(v.topics)] : [])].filter((x, j, a) => a.indexOf(x) === j) : [];
    return { id: `${profile.id}q${k + 1}`, text: t, tags };
  });
  // How likely each brand is to be named, and how early; drifting per run so
  // there are real changes between runs to explain.
  const all = [own, ...rivals, ...unlisted];
  let strength = Object.fromEntries(all.map((b) => [b, r.next()]));
  const records = [];
  let n = 0;
  for (const run of runs) {
    strength = Object.fromEntries(all.map((b) => [b, Math.min(1, Math.max(0.02, strength[b] + (r.next() - 0.5) * 0.35))]));
    for (const p of prompts) for (const e of engines) {
      const id = `${run.id}c${++n}`;
      const limit = e === "grok" && r.chance(0.08);
      const named = all.filter((b) => r.next() < strength[b] * (e === "perplexity" ? 0.9 : 1)).sort((a, b) => strength[b] * r.next() - strength[a] * r.next());
      const parts = named.map((b, k) => `${k === 0 ? "I'd recommend" : "Also consider"} ${b}${v.products.length && r.chance(0.5) ? ` ${r.pick(v.products)} ${r.int(2, 9)}` : ""}.`);
      const answerText = limit ? "" : (parts.join(" ") || "There is no single best option; it depends on what you need.");
      const brandMentions = [];
      let at = 0;
      for (const b of named) { const k = answerText.indexOf(b, at); if (k >= 0) { brandMentions.push({ brand: b, count: r.int(1, 3), firstIndex: k }); at = k + b.length; } }
      const pool = [...v.reviews, ...v.retail, ...v.forum, ...(v.public || [])];
      const sources = limit ? [] : r.sample(pool, r.int(0, Math.min(4, pool.length))).map((d) => ({ domain: d, url: `https://${d}/${p.id}`, outcome: r.chance(0.7) ? "cited" : "read" }));
      if (!limit && named.includes(own) && r.chance(0.3)) sources.push({ domain: `${own.toLowerCase()}.example`, url: `https://${own.toLowerCase()}.example/`, outcome: "cited" });
      const products = !limit && v.products.length && r.chance(0.4) ? named.slice(0, 3).map((b) => ({ name: `${b} ${r.pick(v.products)} ${r.int(2, 9)}` })) : [];
      const fanout = !limit && r.chance(0.6) ? { search: Array.from({ length: r.int(1, 3) }, () => r.chance(0.3) ? `${r.pick(all)} review` : r.chance(0.1) ? `site:${r.pick(pool)} ${p.text}` : p.text) } : undefined;
      const ads = e === "chatgpt" && !limit && r.chance(0.1) ? [{ advertiser: r.pick([own, ...rivals]) }] : undefined;
      records.push({
        captureId: id, platform: e, userPrompt: p.text, answerText, brandMentions, sources, products, ...(fanout ? { fanout } : {}), ...(ads ? { ads } : {}),
        geo: { profileId: profile.id, runId: run.id, promptId: p.id, tags: p.tags }, runId: run.id, capturedAt: run.startedAt + n * 1000,
        ...(limit ? { platformSpecific: { gatewayError: "usage_limit_reached" } } : {}),
      });
    }
  }
  return { profile, runs, records, vertical: v, own, rivals, prompts };
}
