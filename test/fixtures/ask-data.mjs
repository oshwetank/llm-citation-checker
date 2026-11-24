/*
 * ask-data.mjs — made-up campaigns for the Ask tests (1.0.5). Two campaigns
 * share a brand on purpose ("Zento India", "Zento US"); a third has its own;
 * a few questions were asked by hand (My questions). Made-up brands only.
 */
export const DAY = 86400000;
export const NOW = Date.UTC(2026, 10, 20, 12);
export const profiles = [
  { id: "pIN", name: "Zento India", brand: { name: "Zento", url: "https://zento.example" }, competitors: [{ name: "Kovo" }, { name: "Lumora" }],
    prompts: [{ id: "in1", text: "Best phone for battery life", tags: ["battery"] }, { id: "in2", text: "Best camera phone under 30000", tags: ["camera"] }, { id: "in3", text: "Phone with long-lasting charge for travel", tags: [] }] },
  { id: "pUS", name: "Zento US", brand: { name: "Zento", url: "https://zento.example" }, competitors: [{ name: "Kovo" }],
    prompts: [{ id: "us1", text: "Best phone for battery life in the US", tags: ["battery"] }, { id: "us2", text: "Best budget phone 2026", tags: ["budget"] }] },
  { id: "pHM", name: "Lumora Home", brand: { name: "Lumora", url: "https://lumora.example" }, competitors: [{ name: "Pexa" }],
    prompts: [{ id: "hm1", text: "Best air purifier for dust", tags: ["purifier"] }] },
];
export const runs = [
  { id: "rIN1", profileId: "pIN", startedAt: NOW - 14 * DAY, status: "done", platforms: ["chatgpt", "gemini"] },
  { id: "rIN2", profileId: "pIN", startedAt: NOW - 2 * DAY, status: "done", platforms: ["chatgpt", "gemini"] },
  { id: "rUS1", profileId: "pUS", startedAt: NOW - 3 * DAY, status: "done", platforms: ["chatgpt", "gemini"] },
  { id: "rHM1", profileId: "pHM", startedAt: NOW - 20 * DAY, status: "done", platforms: ["chatgpt"] },
];
let n = 0;
const rec = (profileId, runId, promptId, platform, brands, extra = {}) => {
  const p = profiles.find((x) => x.id === profileId);
  const prompt = p ? p.prompts.find((x) => x.id === promptId) : null;
  const run = runs.find((g) => g.id === runId);
  const text = brands.map((b) => `${b} is a good choice.`).join(" ");
  return {
    captureId: `c${++n}`, platform, userPrompt: prompt ? prompt.text : promptId, answerText: text,
    brandMentions: brands.map((b, i) => ({ brand: b, count: 1, firstIndex: i * 30 })),
    sources: [{ outcome: "cited", domain: brands.includes("Zento") ? "zento.example" : "reviews.example", url: "https://reviews.example/a" }],
    capturedAt: (run ? run.startedAt : NOW - DAY) + n * 1000,
    ...(p ? { runId, geo: { profileId, runId, promptId, tags: prompt.tags } } : {}),
    session: { signedIn: "in" },
    ...extra,
  };
};
export const records = [
  // Zento India, run 1 (older): Zento in 1 of 4.
  rec("pIN", "rIN1", "in1", "chatgpt", ["Kovo", "Zento"]), rec("pIN", "rIN1", "in1", "gemini", ["Kovo"]),
  rec("pIN", "rIN1", "in2", "chatgpt", ["Lumora", "Kovo"]), rec("pIN", "rIN1", "in2", "gemini", ["Kovo"]),
  // Zento India, run 2 (latest): Zento in 3 of 6.
  rec("pIN", "rIN2", "in1", "chatgpt", ["Zento", "Kovo"]), rec("pIN", "rIN2", "in1", "gemini", ["Zento"]),
  rec("pIN", "rIN2", "in2", "chatgpt", ["Kovo", "Lumora"]), rec("pIN", "rIN2", "in2", "gemini", ["Kovo", "Zento"]),
  rec("pIN", "rIN2", "in3", "chatgpt", ["Kovo", "Lumora"]), rec("pIN", "rIN2", "in3", "gemini", [], { answerText: "", brandMentions: [] }),
  // Zento US, one run.
  rec("pUS", "rUS1", "us1", "chatgpt", ["Kovo"]), rec("pUS", "rUS1", "us1", "gemini", ["Zento", "Kovo"]),
  rec("pUS", "rUS1", "us2", "chatgpt", ["Zento"]), rec("pUS", "rUS1", "us2", "gemini", ["Kovo"]),
  // Lumora Home.
  rec("pHM", "rHM1", "hm1", "chatgpt", ["Lumora", "Pexa"]),
  // Asked by hand on the Dashboard (no campaign).
  rec(null, null, "Is Kovo good for gaming?", "chatgpt", ["Kovo"]), rec(null, null, "Which phone has the best warranty?", "perplexity", ["Zento", "Kovo"]),
];
export const data = { records, profiles, runs, now: NOW };
