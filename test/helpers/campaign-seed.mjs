/*
 * campaign-seed.mjs — a campaign seeded from the test fixtures, for the
 * campaign board's browser tests: an own brand, two typed competitors,
 * tagged prompts and two runs (run 1 is run 2 with the own brand taken out,
 * so the runs differ). Shared by campaign-view-ui.test.mjs; the older board
 * tests carry their own copy of the same seed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const SEEDS = [
  ["chatgpt-phone-under.txt", "chatgpt", "best smartphone under 50000", ["buying"]],
  ["gemini-streamgenerate.txt", "gemini", "best smartphone under 50000", ["buying"]],
  ["chatgpt-tv.txt", "chatgpt", "best tv to buy", ["buying", "tv"]],
  ["chatgpt-watches.txt", "chatgpt", "new trending watch", ["watches"]],
];

/* Runs in the panel page: turns the stored captures into a campaign with two
 * runs. Run 1 is the same answers with the own brand taken out, so the two
 * runs differ and the board has a change to report. */
export const SEED_CAMPAIGN = async (seeds) => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await open();
  const tx = (s, m) => db.transaction(s, m).objectStore(s);
  const all = (s) => new Promise((res) => { const r = tx(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
  const put = (s, v) => new Promise((res) => { const r = tx(s, "readwrite").put(v); r.onsuccess = () => res(); });
  const derived = (await all("derived")).filter((r) => r.userPrompt);
  if (!derived.length) return { error: "no captures were stored" };
  const counts = new Map();
  derived.forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  if (ranked.length < 3) return { error: `only ${ranked.length} brands in the captures` };
  const own = ranked[1];
  const competitors = ranked.filter((n) => n !== own).slice(0, 2);
  const profileId = crypto.randomUUID();
  await put("profiles", { id: profileId, name: "Board Test", brand: { name: own, url: own.toLowerCase().replace(/\W+/g, "") + ".com" },
    competitors: competitors.map((n) => ({ name: n, url: "" })), engines: ["chatgpt", "gemini"], locked: true,
    createdAt: Date.now() - 9e8, lastRunAt: Date.now(), deletedAt: null });
  const prompts = new Map();
  for (const [, , text, tags] of seeds) {
    if (prompts.has(text)) continue;
    const id = crypto.randomUUID();
    prompts.set(text, id);
    await put("trackedPrompts", { id, profileId, text, tags, active: true, createdAt: Date.now() - 9e8 + prompts.size });
  }
  const r1 = crypto.randomUUID(), r2 = crypto.randomUUID();
  const t1 = Date.now() - 7 * 864e5, t2 = Date.now() - 3600e3;
  for (const [id, t] of [[r1, t1], [r2, t2]]) {
    await put("geoRuns", { id, profileId, startedAt: t, finishedAt: t + 6e5, status: "done", engines: ["chatgpt", "gemini"],
      promptIds: [...prompts.values()], expected: 6, captured: derived.length, failed: 0, reasons: {} });
  }
  for (const rec of derived) {
    const promptId = prompts.get(rec.userPrompt);
    const tags = (seeds.find((s) => s[2] === rec.userPrompt) || [])[3] || [];
    await put("derived", { ...rec, capturedAt: t2 + 1000, geo: { profileId, runId: r2, promptId, tags } });
    await put("derived", { ...rec, captureId: `${rec.captureId}-r1`, capturedAt: t1 + 1000,
      brandMentions: (rec.brandMentions || []).filter((m) => m.brand !== own), geo: { profileId, runId: r1, promptId, tags } });
  }
  return { own, competitors, answers: derived.length, prompts: prompts.size };
};


/** Loads the fixtures as captures in a fresh profile, then turns them into the campaign. */
export async function seedCampaign(context, fixdir) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const seedPage = await context.newPage();
  await seedPage.goto(`chrome-extension://${extId}/ui/panel.html`);
  await seedPage.evaluate(() => localStorage.setItem("cito-tour-seen", "1"));
  await seedPage.waitForTimeout(600);
  await seedPage.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "demo-clear" }, r)));
  const gpt = (p) => JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [p] } }] });
  const gem = (p) => "f.req=" + encodeURIComponent(`[null,"[[\\"${p}\\",0,null]]"]`);
  for (const [file, engine, prompt] of SEEDS) {
    const raw = readFileSync(path.join(fixdir, file), "utf8");
    await seedPage.evaluate(({ raw, reqBody, pageUrl }) => new Promise((res) =>
      chrome.runtime.sendMessage({ type: "raw-conversation", payload: { raw, reqBody, pageUrl, capturedAt: Date.now() } }, res)),
    { raw, reqBody: engine === "gemini" ? gem(prompt) : gpt(prompt), pageUrl: engine === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/" });
    await seedPage.waitForTimeout(100);
  }
  const seeded = await seedPage.evaluate(SEED_CAMPAIGN, SEEDS);
  return { extId, seeded, seedPage };
}
