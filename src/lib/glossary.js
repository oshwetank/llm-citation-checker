/*
 * glossary.js — one definition per term, for the whole tool.
 *
 * Provides a unified dictionary with structured entries across all metrics,
 * grounding signals, and engine intelligence features:
 *
 *   group     which family it belongs to (Brand metrics, Source metrics, Grounding & Veracity, etc.)
 *   term      the label as it appears in the UI
 *   what      one sentence: what it measures, in plain words
 *   formula   the arithmetic, or null when the term is a qualitative category
 *   howToUse  actionable strategic guidance for GEO / SEO optimization
 *   note      the caveat that stops it being misread
 */

export const GLOSSARY = {
  /* ---- brand metrics ---- */
  visibility: {
    group: "Brand metrics",
    term: "Brand Visibility",
    what: "How often a brand gets named at all, across the answers in view.",
    formula: "responses mentioning the brand ÷ total responses × 100",
    howToUse: "Target prompts where your visibility is under 50%. Create targeted informational content addressing those prompt topics to earn inclusion in LLM recommendations.",
    note: "Being named once and being named ten times count the same here — this is reach, not volume. Share of Voice is the volume measure.",
  },
  shareOfVoice: {
    group: "Brand metrics",
    term: "Share of Voice",
    what: "How much of the total brand talk belongs to one brand.",
    formula: "this brand's mentions ÷ mentions of all tracked brands × 100",
    howToUse: "A high Share of Voice (>40%) indicates category leadership. If Share of Voice is lower than visibility, competitors are being discussed with more depth or product variants.",
    note: "The denominator is only the brands this campaign tracks, so adding or removing a competitor changes everyone's number.",
  },
  avgPosition: {
    group: "Brand metrics",
    term: "Average position",
    what: "How early a brand tends to appear in an answer, ranked against the other tracked brands.",
    formula: "mean rank by first appearance, over responses where the brand appears",
    howToUse: "Brands mentioned 1st enjoy higher click-through on cited URLs. Aim for an average position between 1.0 and 1.5 by leading in clear category comparisons.",
    note: "Responses that don't mention the brand are left out rather than scored as a penalty — otherwise a brand that appears once, first, would rank worse than one that never appears.",
  },
  mentions: {
    group: "Brand metrics",
    term: "Mentions",
    what: "Total times a brand was named across every answer in view.",
    formula: "sum of every occurrence, all responses",
    howToUse: "Monitor changes in mention counts after PR campaigns or new product launches to gauge LLM conversational adoption.",
    note: "One answer naming a brand five times contributes five.",
  },
  citations: {
    group: "Brand metrics",
    term: "Citations",
    what: "Responses that used the brand's own website as a source and credited it in the written answer.",
    formula: "count of responses citing the brand's domain",
    howToUse: "If visibility is high but citations are zero, the LLM is learning about you from third-party aggregators rather than your direct domain. Strengthen technical GEO schema markup.",
    note: "This is about the brand's website being read, which is a different thing from the brand being mentioned.",
  },
  sourceVisibility: {
    group: "Brand metrics",
    term: "Source visibility",
    what: "How often a brand's own website turns up as a source at all — whether or not the answer credits it.",
    formula: "responses where the brand's domain appeared ÷ total responses × 100",
    howToUse: "High source visibility with low citations means your pages are read for research but deemed not authoritative enough to cite in the final text.",
    note: "Counts pages that were merely read as well as pages that were cited, so it is always at least as large as Citations.",
  },
  mentionPool: {
    group: "Brand metrics",
    term: "Tracked mentions",
    what: "Every mention of every tracked brand in view, added together.",
    formula: "sum of all tracked brands' mentions",
    howToUse: "Represents total conversation volume for your tracked competitive landscape.",
    note: "This is the denominator behind Share of Voice.",
  },

  /* ---- source metrics ---- */
  domainVisibility: {
    group: "Source metrics",
    term: "Source visibility",
    what: "How many of the answers in view cited this source at least once.",
    formula: "responses citing the source ÷ total responses × 100",
    howToUse: "Identify the top 5 domains with >40% visibility. These are the kingmaker publishers in your vertical. Secure reviews or editorial coverage on them.",
    note: "Cited three times inside one answer is still one response. Reach, not volume — Citations is the volume measure.",
  },
  domainCitations: {
    group: "Source metrics",
    term: "Citations",
    what: "Every time this source was cited in a written answer.",
    formula: "sum of every citation, all responses",
    howToUse: "Use domain citation counts to prioritize your digital PR and co-marketing outreach.",
    note: "Cited three times inside one answer counts three. Volume, not reach — Source visibility is the reach measure.",
  },
  readOnly: {
    group: "Source metrics",
    term: "Read-only",
    what: "Times a page was pulled in as a source but never credited in the written answer.",
    formula: "count of retrieved-but-uncited appearances",
    howToUse: "If your own site is frequently read-only, simplify your page structure so key takeaways and product specs are instantly extractable by AI scrapers.",
    note: "This is NOT “never retrieved”. Every count here was actually read by the engine; it just didn't earn a citation.",
  },
  citedOutcome: {
    group: "Source metrics",
    term: "Cited",
    what: "The page was credited as a source in the written answer.",
    formula: null,
    howToUse: "Pages that earn citations contain concise summary tables, bullet points, and authoritative pricing data.",
    note: "The same page is often cited in one response and only read in the next, which is why both are tracked separately.",
  },
  distinctPrompts: {
    group: "Source metrics",
    term: "Prompts",
    what: "How many different tracked prompts led to this source being cited.",
    formula: "count of distinct prompts with at least one citation",
    howToUse: "Sources cited across many different prompts are universal topical authorities.",
    note: "With two engines the same prompt produces two responses, so this is smaller than the response count.",
  },
  distinctUrls: {
    group: "Source metrics",
    term: "URLs",
    what: "How many different pages on this domain appeared as a source.",
    formula: "count of distinct page URLs",
    howToUse: "A high distinct URL count indicates broad topical depth across an entire website rather than a single viral article.",
    note: "One page cited ten times is one URL — this measures how much of a site the engines reach, not how often.",
  },

  /* ---- Grounding & Veracity (2026 Innovation) ---- */
  verbatimGrounding: {
    group: "Grounding & Veracity",
    term: "Verbatim Grounding Score",
    what: "How accurately the AI's answer reflects the actual text found in its cited web sources.",
    formula: "grounded claim sentences ÷ total answer claims × 100",
    howToUse: "A score above 85% means the model faithfully cited source facts. A low score (<50%) indicates high hallucination or synthesis unsupported by the cited web pages.",
    note: "Verified via Chrome Scroll-to-Text Fragments and exact source snippet matching.",
  },
  hallucinationGap: {
    group: "Grounding & Veracity",
    term: "Hallucination Gap Index",
    what: "Percentage of statements where the AI cited a URL that does not actually substantiate its claim.",
    formula: "unsubstantiated claims ÷ total claims × 100",
    howToUse: "If your brand is mischaracterized due to a hallucination gap, publish clear FAQ Schema markup to correct the AI's understanding.",
    note: "Calculated by cross-referencing answer entities against source document contents.",
  },
  exactPassage: {
    group: "Grounding & Veracity",
    term: "Exact Grounding Passage",
    what: "The exact sentence in the source webpage that grounded the AI's generated statement.",
    formula: "Chrome Scroll-to-Text Fragment match (#:~:text=...)",
    howToUse: "Review these exact passages to see which specific sentences on your site are being quoted verbatim by LLMs.",
    note: "Extracted natively from modern Gemini and search-grounded citation anchors.",
  },

  /* ---- Engine Intelligence (2026 Innovation) ---- */
  queryPlan: {
    group: "Engine Intelligence",
    term: "Query Plan Deconstruction",
    what: "The multi-hop sub-queries an engine formulated to break down a complex prompt before answering.",
    formula: "sub-queries extracted from query_plan / search_model_queries",
    howToUse: "Incorporate these exact sub-queries into your H2/H3 headings and content outlines to match the AI's internal research decomposition.",
    note: "Surfaced by Perplexity Sonar, ChatGPT SonicBrowser, and Grok DeepSearch.",
  },
  socialAuthoritySplit: {
    group: "Engine Intelligence",
    term: "Social vs. Web Authority Split",
    what: "Ratio of citations originating from real-time social posts (e.g. X/Twitter) vs. traditional web publishers.",
    formula: "social citations ÷ total citations × 100",
    howToUse: "If social authority is high (>30%), your brand needs an active executive presence on X and Reddit to influence AI recommendations.",
    note: "Unique to xAI Grok and real-time social-grounded LLM searches.",
  },
  thinkingBudget: {
    group: "Engine Intelligence",
    term: "Extended Thinking Depth",
    what: "The internal reasoning and synthesis steps executed by the model before generating its final answer.",
    formula: "reasoning tokens / thinking block character length",
    howToUse: "Analyze thinking traces to understand WHY the model chose a competitor over your brand and what trade-offs it weighed.",
    note: "Extracted from Grok DeepSearch reasoning blocks.",
  },
  domainExclusivity: {
    group: "Engine Intelligence",
    term: "Domain Exclusivity",
    what: "Web domains that are exclusively cited by a single AI platform and ignored by others.",
    formula: "domains cited in Engine A but not in Engines B, C, D",
    howToUse: "Identifies platform-specific bias. For example, if a key review site is only used by Gemini, optimizing for it will boost your Gemini GEO rank specifically.",
    note: "Reveals indexing and partnership differences between OpenAI, Google, Anthropic, and xAI.",
  },
  brandSourceMatrix: {
    group: "Engine Intelligence",
    term: "Brand URL Content Matrix",
    what: "Identifies which cited URLs mention which specific brands, highlighting critical competitor blind spots.",
    formula: "co-occurrence mapping of brands inside cited URL content",
    howToUse: "Look for 'Competitor Blind Spots': URLs where all your competitors are mentioned but your brand is missing. Pitch these publishers immediately.",
    note: "Scans cited source contents across all runs to find omitted brand opportunities.",
  },
  fanoutIntent: {
    group: "Engine Intelligence",
    term: "Search Fan-Out Intent",
    what: "The strategic intent category of the search queries formulated by the AI (Comparison, Pricing, Specs, Reviews).",
    formula: "intent classification of fan-out sub-queries",
    howToUse: "Align your landing pages with the dominant fan-out intent observed for your key commercial prompts.",
    note: "Shows how AI reinterprets a short prompt into high-intent sub-searches.",
  },

  /* ---- comparison ---- */
  onlyThem: {
    group: "Comparing brands",
    term: "Only this brand",
    what: "Answers that named the competitor and did not name your brand at all.",
    formula: "responses with them present and you absent",
    howToUse: "Your top priority blind spot. Inspect the sources cited in these answers to see where the competitor is winning coverage.",
    note: "This is the gap: the questions where they are the answer and you aren't in the conversation.",
  },
  bothNamed: {
    group: "Comparing brands",
    term: "Both named",
    what: "Answers that named your brand and the competitor.",
    formula: "responses with both present",
    howToUse: "Competitive battleground queries. Focus on improving your average position so you are recommended first.",
    note: "Within these, order matters — see who was named first.",
  },
  onlyYou: {
    group: "Comparing brands",
    term: "Only your brand",
    what: "Answers that named your brand and not the competitor.",
    formula: "responses with you present and them absent",
    howToUse: "Your strongest competitive moats. Ensure the sources cited in these answers stay fresh and updated.",
    note: "Ground you hold that they don't.",
  },
  neitherNamed: {
    group: "Comparing brands",
    term: "Neither",
    what: "Answers that named neither brand.",
    formula: "responses with both absent",
    howToUse: "White-space opportunities in your vertical. First-mover advantage: create content to capture these unbranded prompts.",
    note: "Often the most interesting bucket: a question in your category where nobody in it was mentioned.",
  },
  namedFirst: {
    group: "Comparing brands",
    term: "Named first",
    what: "Of the answers naming both brands, which one appears earlier in the text.",
    formula: "compare each brand's first appearance in the answer",
    howToUse: "Winning the 'Named First' metric correlates directly with top-of-mind brand authority in generative search.",
    note: "A brand shown only in a product card has no place in the prose, so those count as unranked rather than a loss for either side.",
  },
  brandSources: {
    group: "Comparing brands",
    term: "Sources cited when a brand is named",
    what: "The domains cited in the answers that mention this brand.",
    formula: "citations grouped by domain, over responses mentioning the brand",
    howToUse: "Reveals which publishers and websites are directly powering your competitor's AI visibility.",
    note: "Not proof those pages are about the brand — a source can be cited for a reason unrelated to a name further down the answer. It is what the engine had in front of it.",
  },

  /* ---- capture terms ---- */
  responses: {
    group: "What was captured",
    term: "Responses",
    what: "One answer from one engine to one prompt.",
    formula: null,
    howToUse: "Run multi-engine prompt audits across at least 10–20 responses to achieve statistically robust GEO benchmarks.",
    note: "Asking the same prompt on two engines produces two responses. Most percentages here are measured over responses.",
  },
  captures: {
    group: "What was captured",
    term: "Captures",
    what: "Answers recorded by the extension in this view.",
    formula: null,
    howToUse: "Filter captures by engine or date to analyze historical AI response evolution.",
  },
  withSearch: {
    group: "What was captured",
    term: "With search",
    what: "Captures where the engine actually went and searched the web rather than answering from memory.",
    formula: null,
    howToUse: "Search-grounded responses can be directly influenced via SEO/GEO. Memory-only answers rely on training cutoff data.",
    note: "An answer with no search has no sources to cite, so it can't contribute citations to anyone.",
  },
  fanout: {
    group: "What was captured",
    term: "Fan-out queries",
    what: "The searches an engine ran behind the scenes to answer one prompt.",
    formula: "count of queries issued across search, shopping and image",
    howToUse: "Use these AI-generated sub-queries as your target keyword roadmap for SEO content expansion.",
    note: "These are the engine's own words, not yours — they show how it reinterpreted the question.",
  },
  uniqueDomains: {
    group: "What was captured",
    term: "Unique domains",
    what: "How many different websites turned up as sources across these answers.",
    formula: "count of distinct domains",
    howToUse: "A high unique domain count indicates a fragmented media landscape where diverse coverage is essential.",
  },
  autoCompetitor: {
    group: "What was captured",
    term: "Inferred competitor",
    what: "A brand taken from your own captures because the campaign has no competitors configured.",
    formula: "brands ranked by how many responses each appears in",
    howToUse: "Accept inferred competitors to immediately begin tracking Head-to-Head win rates against them.",
    note: "Nothing is saved to the campaign until you accept it, and any one of them can be dismissed.",
  },
  sentiment: {
    group: "What was captured",
    term: "Sentiment",
    what: "Whether an answer speaks about a brand favourably.",
    formula: null,
    howToUse: "Review verbatim answer passages to audit whether your brand was recommended with positive or negative sentiment.",
    note: "Not measured algorithmically with a synthetic score to prevent misleading approximations.",
  },
};

/**
 * The tooltip text for a term, as a single string.
 *
 * Used where a structured tooltip isn't available — the `title` attribute,
 * and the exported HTML report.
 */
export function glossaryText(key) {
  const g = GLOSSARY[key];
  if (!g) return "";
  return [
    g.term,
    "—",
    g.what,
    g.formula ? `Formula: ${g.formula}.` : "",
    g.howToUse ? `How to use: ${g.howToUse}` : "",
    g.note ? `Note: ${g.note}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every term, for the reference list in the About tab. */
export function glossaryEntries() {
  return Object.entries(GLOSSARY).map(([key, g]) => ({ key, ...g }));
}

/** The reference list, grouped — see the `group` note above. */
export function glossaryGroups() {
  const order = [
    "Brand metrics",
    "Source metrics",
    "Grounding & Veracity",
    "Engine Intelligence",
    "Comparing brands",
    "What was captured",
  ];
  const by = new Map(order.map((g) => [g, []]));
  for (const e of glossaryEntries()) {
    if (!by.has(e.group)) by.set(e.group, []);
    by.get(e.group).push(e);
  }
  return [...by.entries()].filter(([, list]) => list.length).map(([group, terms]) => ({ group, terms }));
}
