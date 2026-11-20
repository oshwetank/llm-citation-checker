/*
 * The capture check's record and verdicts (src/lib/captureHealth.js, 0.73.1).
 * Run: node test/capture-health.test.mjs
 */
import { emptyHealth, noteHealth, verdict, healthReport , missedAnswers, MISSED_AFTER_MS } from "../src/lib/captureHealth.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const now = Date.now();

console.log("the record");
let h = emptyHealth();
h = noteHealth(h, "chatgpt", { kind: "conv", path: "/backend-api/f/conversation", method: "POST", status: 200, at: now - 5000 });
h = noteHealth(h, "chatgpt", { kind: "stored", captureId: "c1", at: now - 4000 });
check("a request and a stored answer", h.chatgpt.conv.path === "/backend-api/f/conversation" && h.chatgpt.stored.captureId === "c1");
for (let i = 0; i < 12; i++) h = noteHealth(h, "gemini", { kind: "drop", reason: `r${i}`, at: now - i });
check("drops keep the last 8, newest first", h.gemini.drops.length === 8 && h.gemini.drops[0].reason === "r11");
h = noteHealth(h, "gemini", { kind: "drop", reason: "r11", at: now });
check("a repeat replaces its older copy", h.gemini.drops.filter((d) => d.reason === "r11").length === 1);
check("an unknown engine changes nothing", JSON.stringify(noteHealth(h, "bing", { kind: "stored" })) === JSON.stringify(h));
check("a broken stored value starts afresh", noteHealth("junk", "grok", { kind: "stored", captureId: "x" }).grok.stored.captureId === "x");

console.log("\nverdicts");
check("saved recently: ok", verdict("chatgpt", h.chatgpt, []).status === "ok");
check("paused wins", /paused/i.test(verdict("chatgpt", h.chatgpt, [], { paused: true }).line));
check("a tab cut off from the extension: refresh it", /Refresh/.test(verdict("chatgpt", h.chatgpt, [{ engine: "chatgpt", alive: false }]).line) && verdict("chatgpt", h.chatgpt, [{ engine: "chatgpt", alive: false }]).status === "bad");
check("a tab with no marker", /link to the extension/.test(verdict("perplexity", {}, [{ engine: "perplexity", alive: true, marker: false }]).line));
const dropped = noteHealth(emptyHealth(), "grok", { kind: "drop", reason: "empty", at: now });
check("dropped after the last save: says why", /no prompt, answer or sources/.test(verdict("grok", dropped.grok, []).line));
// 1.0.0, from the owner's report of 16 Nov 2026: Perplexity's empty side
// calls after a saved answer read "bad"; ChatGPT's page copy giving up read "idle".
{
  let hp = noteHealth(emptyHealth(), "perplexity", { kind: "stored", at: now - 60000 });
  hp = noteHealth(hp, "perplexity", { kind: "drop", reason: "empty", path: "/rest/sse/related-queries/:id", at: now - 30000 });
  hp = noteHealth(hp, "perplexity", { kind: "drop", reason: "empty", path: "/rest/perplexity_ask/graphql/ws", at: now });
  check("an empty side call after a saved answer is not a lost answer", verdict("perplexity", hp.perplexity, []).status === "ok", JSON.stringify(verdict("perplexity", hp.perplexity, [])));
  const hl = noteHealth(hp, "perplexity", { kind: "drop", reason: "empty", path: "/rest/sse/perplexity_ask", at: now + 1 });
  check("an empty answer stream still is", verdict("perplexity", hl.perplexity, []).status === "bad");
  const v = verdict("chatgpt", {}, [{ engine: "chatgpt", alive: true, marker: true, copy: { stage: "gave up after 6 minutes", at: now } }]);
  check("the page copy giving up is bad, not idle", v.status === "bad" && /wasn't found/.test(v.line), JSON.stringify(v));
}
const asked = noteHealth(emptyHealth(), "chatgpt", { kind: "conv", path: "/x", at: now });
check("a request with nothing saved: warn", verdict("chatgpt", asked.chatgpt, []).status === "warn");
const unknown = noteHealth(emptyHealth(), "chatgpt", { kind: "unknown", ev: "stream-unknown", path: "/new/stream", at: now });
check("an unrecognised stream, nothing saved: warn", verdict("chatgpt", unknown.chatgpt, []).status === "warn");
check("nothing yet, no tab: idle", verdict("gemini", {}, []).status === "idle");

console.log("\nthe report");
const rep = healthReport({ version: "0.73.1", health: h, tabs: [{ engine: "chatgpt", alive: true, marker: true, conv: 2, forwarded: 2, url: "https://chatgpt.com/c/:id", ageMs: 120000 }], counts: { derived: 10, manual: 4 }, retentionMax: 2000 });
check("names the version, counts and each engine", /v0\.73\.1/.test(rep) && /stored: 10 answers \(4 asked by hand\)/.test(rep) && ["chatgpt", "gemini", "perplexity", "grok"].every((e) => rep.includes(`## ${e}`)));
check("the tab line", /tab https:\/\/chatgpt\.com\/c\/:id: connected · marker ok · requests seen 2/.test(rep), rep);

console.log("\nan answer asked by hand that never arrived (0.84.0)");
{
  const T = 1_000_000_000;
  let h = noteHealth(null, "gemini", { kind: "asked", at: T, tabId: 7 });
  check("not yet: the answer may still be coming", missedAnswers(h, T + 30_000).length === 0);
  const m = missedAnswers(h, T + MISSED_AFTER_MS + 1);
  check("after 90 s with nothing stored, it's missed, with its tab", m.length === 1 && m[0].engine === "gemini" && m[0].tabId === 7, JSON.stringify(m));
  h = noteHealth(h, "gemini", { kind: "stored", at: T + 20_000, captureId: "c" });
  check("stored after the question: not missed", missedAnswers(h, T + 200_000).length === 0);
  h = noteHealth(h, "chatgpt", { kind: "stored", at: T - 5000, captureId: "old" });
  h = noteHealth(h, "chatgpt", { kind: "asked", at: T, tabId: 3 });
  check("an older answer doesn't count for a newer question", missedAnswers(h, T + 120_000).map((x) => x.engine).join() === "chatgpt");
  check("dismissed: left alone", missedAnswers(h, T + 120_000, { chatgpt: T + 1 }).length === 0);
  check("half an hour on: no longer news", missedAnswers(h, T + 31 * 60_000).length === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
