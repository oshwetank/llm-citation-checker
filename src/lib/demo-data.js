/*
 * demo-data.js — a realistic, self-contained sample capture so a new user can
 * explore every part of this tool before ever running a real prompt.
 *
 * Why this exists: nothing in the panel means anything on an empty install.
 * Brand Mentions, the citation matrix, fan-out breadth, retrieved-vs-cited —
 * all of it renders as zeros, so a first-time user has no way to tell what the
 * tool measures or whether it is working. Asking them to go run a campaign
 * first, on an engine they may not be signed into, just to see what the
 * screens do, is a poor first five minutes.
 *
 * TWO PROPERTIES THIS MUST HAVE, and both are about not lying to the user:
 *
 *  1. Every demo record is stamped `isDemo: true` and shares the DEMO_PREFIX
 *     capture id. The UI labels them, and clearRecords() can remove exactly
 *     these and nothing else. Demo data must never be mistakable for a real
 *     capture, and must never quietly skew a real brand's share of voice.
 *
 *  2. The content is SHAPED like real captured data, not idealised. It is
 *     modelled on genuine captures in test/fixtures: a comparison table, a
 *     brand cited by its own domain, sources that were retrieved but never
 *     cited, and multi-step fan-out. A demo where everything is perfectly
 *     cited would teach the wrong mental model of what these numbers mean.
 *
 * Deliberately NOT written into the `raw` store: there is no raw payload
 * behind it, and inventing one would make "Reprocess all captures" re-derive
 * a fabricated capture as though it were real.
 */

export const DEMO_PREFIX = "demo-";
export const DEMO_NOTICE =
  "Sample data — shows what a captured answer looks like. Remove it any time from the About tab.";

// One realistic answer, in the markdown shape the DOM harvester now produces
// (headings, a comparison table, bold product names) plus the positional
// citation markers Perplexity supplies. Keeping the markers in means the demo
// also exercises the export's numbered-footnote path.
const DEMO_ANSWER = `For under ₹4,000 in India, the **boAt Rockerz 512 ANC** is the best overall value: strong ANC, 80-hour battery, and consistently good reviews at around ₹2,999.[[cite:https://www.boat-lifestyle.com/collections/wireless-headphones-under-4000]]

## Top Picks Under ₹4,000

| Model | Price | Key Strengths | Best For |
| --- | --- | --- | --- |
| **boAt Rockerz 512 ANC** | ₹2,999 | 40dB hybrid ANC, 80hr battery | Best overall value |
| **Sony WH-CH520** | ₹3,990 | 50hr battery, BT 5.2 multipoint | Best big-brand pick |
| **Noise Airwave Max XR** | ₹3,499 | 120hr battery, spatial audio | Best battery life |
| **Spigen SA-HP P10** | ₹2,499 | 43dB ANC, 60hr battery | Best budget ANC |

## Quick Recommendations

- **Commuting:** boAt Rockerz 512 ANC — effective hybrid ANC under ₹3,000.[[cite:https://www.smartprix.com/headphones/under-4000]]
- **Brand trust:** Sony WH-CH520 — balanced sound and multipoint pairing.[[cite:https://www.sony.co.in/headphones/wh-ch520]]
- **Marathon battery:** Noise Airwave Max XR — 120 hours between charges.`;

const src = (url, domain, title, outcome, extra = {}) => ({
  url,
  domain,
  title,
  snippet: "",
  outcome,
  type: "citation",
  platformSpecific: { queryPlanQuery: extra.query || null, sourceIndex: null, trusted: extra.trusted || null },
});

export function buildDemoRecords(now = Date.now()) {
  const record = {
    captureId: `${DEMO_PREFIX}perplexity-1`,
    isDemo: true,
    schemaVersion: 2,
    platform: "perplexity",
    // No invented model name — Perplexity captures genuinely carry none, and
    // the demo should show what a real one looks like, blanks included.
    model: null,
    capturedAt: now - 1000 * 60 * 45,
    pageUrl: "https://www.perplexity.ai/",
    rawRef: null,
    conversationId: null, turnId: null, projectId: null, runId: null, geo: null,
    userPrompt: "Best headphone under 4000",
    generatedTitle: null,
    turnUseCase: "shopping",
    searched: true,

    // Two named steps with their own sub-queries — the fan-out shape
    // Perplexity's steps panel exposes.
    fanout: {
      search: [
        { query: "Best headphone under 4000", search_type: "search" },
        { query: "boAt Rockerz 512 ANC review battery", search_type: "search" },
        { query: "Sony WH-CH520 vs boAt Rockerz 512", search_type: "search" },
      ],
      shopping: [],
      image: [],
    },

    // Deliberately mixed: cited AND merely-retrieved. That contrast is the
    // whole point of the metric, and a demo where everything is cited would
    // teach the wrong thing.
    sources: [
      src("https://www.boat-lifestyle.com/collections/wireless-headphones-under-4000", "boat-lifestyle.com",
        "Buy boAt Wireless Headphones Under ₹4000 for Quality Sound", "cited",
        { query: "Best headphone under 4000", trusted: true }),
      src("https://www.smartprix.com/headphones/under-4000", "smartprix.com",
        "Best Headphones Under ₹4000 — Compare Prices & Features", "cited",
        { query: "Best headphone under 4000" }),
      src("https://www.sony.co.in/headphones/wh-ch520", "sony.co.in",
        "Sony WH-CH520 Wireless Headphones", "cited",
        { query: "Sony WH-CH520 vs boAt Rockerz 512" }),
      src("https://savedelete.com/article/headphones-under-4000/", "savedelete.com",
        "Best Headphones Under Rs.4000 in 2026: Ultimate Buying Guide", "fetched",
        { query: "boAt Rockerz 512 ANC review battery" }),
      src("https://www.pricekeeda.com/headphones/headphones-under-4000/", "pricekeeda.com",
        "Best Headphones Under ₹4000 — Price Comparison", "fetched",
        { query: "Best headphone under 4000" }),
      src("https://etadviser.com/electronics/headphones/best-headphones-under-4000/", "etadviser.com",
        "Best Headphones under 4000 in India (2026) — ET Adviser", "fetched",
        { query: "boAt Rockerz 512 ANC review battery" }),
    ],

    products: [], places: [], entities: [], images: [],

    brandMentions: [
      { brand: "boAt", count: 3, firstIndex: 40, category: null, description: null, relation: null,
        passages: ["the boAt Rockerz 512 ANC is the best overall value: strong ANC, 80-hour battery"] },
      { brand: "Sony", count: 2, firstIndex: 320, category: null, description: null, relation: null,
        passages: ["Sony WH-CH520 — balanced sound and multipoint pairing"] },
      { brand: "Noise", count: 2, firstIndex: 400, category: null, description: null, relation: null,
        passages: ["Noise Airwave Max XR — 120 hours between charges"] },
      { brand: "Spigen", count: 1, firstIndex: 460, category: null, description: null, relation: null,
        passages: ["Spigen SA-HP P10 | ₹2,499 | 43dB ANC, 60hr battery"] },
    ],

    carousels: { products: false, images: false, news: false, map: false },
    referenceTypes: { search: 6 },
    answerChars: DEMO_ANSWER.length,
    answerText: DEMO_ANSWER,
    platformSpecific: { adapterVersion: "demo", nodeCount: 0 },
    _extraction: { adapterVersion: "demo", usedFallback: false, notes: ["Sample data — not a real capture."] },
  };

  return [record];
}

export const isDemoRecord = (r) => !!(r && (r.isDemo === true || String(r.captureId || "").startsWith(DEMO_PREFIX)));
