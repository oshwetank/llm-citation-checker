/*
 * ask-gold.mjs — questions Ask must understand, with the plan each should
 * get (1.0.5, ASK-ARCHITECTURE.md §7), over test/fixtures/ask-data.mjs.
 *
 * Fields: q (the question), context (the page Ask was opened from), and the
 * expected intent, collections (sorted ids), askBack (true when it should
 * ask which campaign), engines, tags. A field left out is not checked.
 * `rules: false` marks a question the rule pass is not expected to get on its
 * own: the model pass (Stage 2) is measured on those.
 *
 * Campaigns: pIN "Zento India" (Zento; rivals Kovo, Lumora; tags battery,
 * camera), pUS "Zento US" (Zento; Kovo; battery, budget), pHM "Lumora Home"
 * (Lumora; Pexa; purifier), and "history" (My questions).
 */
export const GOLD = [
  // ---- named campaigns ----
  { q: "How is Zento India doing?", intent: "metric", collections: ["pIN"] },
  { q: "How is Zento US doing on Gemini?", intent: "metric", collections: ["pUS"], engines: ["gemini"] },
  { q: "Share of voice in Lumora Home", intent: "metric", collections: ["pHM"] },
  { q: "Zento India visibility by engine", intent: "metric", collections: ["pIN"] },
  { q: "Top brands in Zento US", intent: "rank", collections: ["pUS"] },
  { q: "Who is named first most often in Lumora Home?", intent: "rank", collections: ["pHM"] },
  { q: "Which sites are cited most in Zento India?", intent: "sources", collections: ["pIN"] },
  { q: "Where are we missing in Zento India?", intent: "gaps", collections: ["pIN"] },
  { q: "Why did our visibility drop in Zento India?", intent: "why", collections: ["pIN"] },
  { q: "Zento trend over time in Zento India", intent: "trend", collections: ["pIN"] },
  { q: "Did any usage limits hit Zento US?", intent: "data_status", collections: ["pUS"] },
  { q: "What did the engines search for in Zento India?", intent: "searches", collections: ["pIN"] },
  { q: "Which products were shown in Zento US?", intent: "cards", collections: ["pUS"] },
  { q: "Battery prompts in Zento India", collections: ["pIN"], tags: ["battery"] },
  { q: "How is Zento India doing on ChatGPT and Gemini?", collections: ["pIN"], engines: ["chatgpt", "gemini"] },
  { q: "How is Zento India doing on GPT?", collections: ["pIN"], engines: ["chatgpt"] },
  // ---- where the user is ----
  { q: "How visible are we?", context: "pUS", intent: "metric", collections: ["pUS"] },
  { q: "Which sites cite our rivals but not us?", context: "pIN", intent: "gaps", collections: ["pIN"] },
  { q: "How are we doing on Perplexity?", context: "pIN", collections: ["pIN"], engines: ["perplexity"] },
  { q: "Top brands", context: "pHM", intent: "rank", collections: ["pHM"] },
  // ---- ambiguous: ask back, never a silent guess ----
  { q: "How visible are we?", askBack: true },
  { q: "What is our share of voice?", askBack: true },
  { q: "Are we beating our rivals?", askBack: true },
  // ---- brands are subjects ----
  { q: "How is Kovo doing?", intent: "metric", collections: ["pIN", "pUS"] },
  { q: "How is Pexa doing?", intent: "metric", collections: ["pHM"] },
  { q: "Is Kovo beating us in Zento US?", intent: "compare", collections: ["pUS"] },
  { q: "Zento vs Kovo in Zento India", intent: "compare", collections: ["pIN"] },
  { q: "Compare Lumora and Pexa", intent: "compare", collections: ["pHM"] },
  { q: "How is my brand doing in my latest campaign?", collections: ["pIN"] },
  // ---- many campaigns ----
  { q: "How visible are we across all campaigns?", collections: ["pHM", "pIN", "pUS"] },
  { q: "Compare both Zento campaigns", rules: false, collections: ["pIN", "pUS"] },
  // ---- wording ----
  { q: "Show me answers that mention warranty", intent: "find_answers", collections: ["history", "pHM", "pIN", "pUS"] },
  { q: "What do the engines say about gaming?", intent: "find_answers" },
  { q: "Which answers mention Kovo?", intent: "find_answers" },
  { q: "What did I ask about warranty?", intent: "find_answers" },
  // ---- dates ----
  { q: "How is Zento India doing since October?", collections: ["pIN"] },
  { q: "Zento India visibility in the last 7 days", collections: ["pIN"] },
  // ---- not recorded, definitions ----
  { q: "How many clicks did ChatGPT send us?", intent: "not_recorded" },
  { q: "How much traffic do we get from Gemini?", intent: "not_recorded" },
  { q: "What is our Google ranking for best phone?", intent: "not_recorded" },
  { q: "What does share of voice mean?", intent: "define" },
  { q: "How is average position calculated?", intent: "define" },
  { q: "What is visibility?", intent: "define" },
  // ---- other languages ----
  { q: "¿Cómo le va a Zento India en Gemini?", collections: ["pIN"], engines: ["gemini"] },
  { q: "¿Qué fuentes cita más Zento US?", intent: "sources", collections: ["pUS"] },
  { q: "Comparar Zento y Kovo en Zento India", intent: "compare", collections: ["pIN"] },
  { q: "Quais fontes são mais citadas em Zento India?", intent: "sources", collections: ["pIN"] },
  { q: "Qual é a visibilidade da Zento US?", intent: "metric", collections: ["pUS"] },
  { q: "Quelles sources sont les plus citées dans Lumora Home ?", intent: "sources", collections: ["pHM"] },
  { q: "Pourquoi Zento India a baissé ?", intent: "why", collections: ["pIN"] },
  { q: "Zento India में दृश्यता कैसी है?", intent: "metric", collections: ["pIN"] },
  { q: "Zento US की तुलना Kovo से करें", intent: "compare", collections: ["pUS"] },
  { q: "ما هي المصادر في Zento India؟", intent: "sources", collections: ["pIN"] },
  { q: "كم عدد النقرات من ChatGPT؟", intent: "not_recorded" },
  // ---- lessons from the owner's real data (1.0.5) ----
  // A tag's word used as a plain word is not the tag ("budget" is a tag of Zento US).
  { q: "Which budget phones are named most in Zento US?", collections: ["pUS"], tags: [] },
  // A wording search searches the words, not the prompts tagged with them.
  { q: "Show me answers that mention camera", intent: "find_answers", tags: [] },
  // As a topic, it is the tag.
  { q: "How do we do on the camera prompts in Zento India?", collections: ["pIN"], tags: ["camera"] },
  // ---- harder wording (the model pass's job) ----
  { q: "Are we winning in the Indian campaign?", rules: false, collections: ["pIN"] },
  { q: "Where do the bots send people when they ask about air purifiers?", rules: false, intent: "sources", collections: ["pHM"] },
  { q: "Which rival keeps showing up ahead of us in Zento US?", rules: false, intent: "rank", collections: ["pUS"] },
  { q: "Has Zento been slipping lately in Zento India?", rules: false, intent: "trend", collections: ["pIN"] },
  { q: "Give me the big picture for Zento US", rules: false, intent: "metric", collections: ["pUS"] },
];
