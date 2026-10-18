/*
 * chatgpt-signed-out.test.mjs — ChatGPT's answer when nobody is signed in (0.69.0).
 *
 * Reported in the owner's "Run signed out" campaign: every ChatGPT prompt
 * timed out "sent, no answer captured". Signed out, chatgpt.com serves a
 * lighter app whose answer comes from /unauth-mweb/conversation/updates as
 * ndjson; 0.68.1 only listened for the signed-in stream. Only the key names
 * of that stream are known (from the network recorder), so the events here
 * are made up around them, with made-up brands and sites; the reader is
 * written to read by name and to say so when it finds nothing.
 */
import { isConversationSource, readConversationSource } from "../src/lib/chatgptSource.js";
import { adapt } from "../src/adapters/chatgpt.js";
import { turnAnswered } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "best linen shirt brands for summer";
const PARTS = [
  "**Zento Linen** is the pick for hot days: breathable and well cut.",
  "\n\n- **Kovo Weave**: softer, a little pricier.\n- **Lumora**: the budget choice.",
];
const ev = (detail) => JSON.stringify({ version: 1, type: "conversation-source", detail: { operationId: "op-1", streamType: "conversation", kind: "message", conversationId: "c-0a1b", canonicalPath: "/c/c-0a1b", ...detail } });
const refs = [{ url: "https://stylelab.example/best-linen-shirts?utm_source=chatgpt.com", title: "Best linen shirts — StyleLab" }, { url: "https://fabricdesk.example/kovo-weave-review", title: "Kovo Weave review" }];
const stream = [
  ev({ role: "user", messageId: "u-1", markdown: PROMPT }),
  ev({ messageId: "m-1", revision: 1, status: "in_progress", markdown: PARTS[0], html: `<p>${PARTS[0]}</p>`, items: [{ activity: { query: "best linen shirt brands 2026" } }] }),
  ev({ messageId: "m-1", revision: 2, status: "finished", markdown: PARTS[0] + PARTS[1], references: refs, approvedUrls: ["https://lumora.example/shirts"] }),
].join("\n");

console.log("\nthe stream");
{
  check("told apart from the signed-in SSE", isConversationSource(stream) && !isConversationSource("event: delta\ndata: {}") && isConversationSource("", "https://chatgpt.com/unauth-mweb/conversation/updates?operationId=x"));
  const r = readConversationSource(stream);
  check("the answer is the newest revision's markdown", r && r.answer === PARTS[0] + PARTS[1], r && r.answer);
  check("the question comes from the user's message", r && r.prompt === PROMPT, r && r.prompt);
  check("references and approved addresses are its sources, tracking tags dropped", r && r.sources.length === 3 && r.sources[0].url === "https://stylelab.example/best-linen-shirts" && r.sources.every((x) => x.cited), JSON.stringify(r && r.sources.map((x) => x.url)));
  check("a search named in its activity", r && r.queries[0] === "best linen shirt brands 2026", JSON.stringify(r && r.queries));
  check("pieces rather than snapshots are joined in order", readConversationSource([ev({ messageId: "m", markdown: "Hello " }), ev({ messageId: "m", markdown: "world, with more words here to pass the check." })].join("\n")).answer.startsWith("Hello world"));
  check("html when there is no markdown", readConversationSource(ev({ messageId: "m", html: "<p>Only <b>html</b> here.</p><ul><li>One</li></ul>" })).answer === "Only html here.\n- One");
  check("nothing readable reads as nothing", readConversationSource(ev({ messageId: "m" })) === null && readConversationSource("") === null);
}

console.log("\nthe record");
{
  const rec = await adapt({ captureId: "so1", raw: stream, url: "https://chatgpt.com/unauth-mweb/conversation/updates?operationId=op-1", reqBody: "{}", pageUrl: "https://chatgpt.com/c/c-0a1b", capturedAt: 1 }, { tracked: [{ name: "Zento" }, { name: "Kovo" }] });
  check("a ChatGPT answer with its prompt and text", rec.platform === "chatgpt" && rec.userPrompt === PROMPT && rec.answerText.includes("Lumora"), rec.userPrompt);
  check("three cited sources and one search", rec.sources.filter((x) => x.outcome === "cited").length === 3 && rec.fanout.search.length === 1, JSON.stringify([rec.sources.length, rec.fanout.search.length]));
  const brands = rec.brandMentions.map((b) => b.brand);
  check("brands named in the answer", brands.includes("Zento") && brands.includes("Kovo"), brands.join(", "));
  check("marked signed out, and tied to its message", rec.platformSpecific.signedOut === true && rec.turnId === "m-1" && rec.conversationId === "c-0a1b", JSON.stringify([rec.turnId, rec.conversationId]));
  const partial = await adapt({ captureId: "so2", raw: stream.split("\n").slice(0, 2).join("\n"), url: "https://chatgpt.com/unauth-mweb/conversation/updates", pageUrl: "https://chatgpt.com/", capturedAt: 1 });
  check("a snapshot still being written doesn't finish a campaign turn", !turnAnswered(partial) && turnAnswered(rec), JSON.stringify(partial.platformSpecific.status));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
