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
import { isConversationSource, readConversationSource, limitOfSource, promptOfSourceRequest } from "../src/lib/chatgptSource.js";
import { adapt } from "../src/adapters/chatgpt.js";
import { turnAnswered, usageLimitOf } from "../src/lib/geo.js";

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
  // 0.79.0: the answer keeps its lines, so a list reaches brand detection as
  // a list; folded onto one line, "Lumora" (named only in a list item, and
  // not tracked) was missed.
  check("the answer keeps its lines", rec.answerText.split("\n").length >= 3 && /^- \*\*Kovo Weave\*\*/m.test(rec.answerText), JSON.stringify(rec.answerText));
  check("an untracked brand named only in a list item is found", brands.includes("Lumora"), brands.join(", "));
  check("marked signed out, and tied to its message", rec.platformSpecific.signedOut === true && rec.turnId === "m-1" && rec.conversationId === "c-0a1b", JSON.stringify([rec.turnId, rec.conversationId]));
  const partial = await adapt({ captureId: "so2", raw: stream.split("\n").slice(0, 2).join("\n"), url: "https://chatgpt.com/unauth-mweb/conversation/updates", pageUrl: "https://chatgpt.com/", capturedAt: 1 });
  check("a snapshot still being written doesn't finish a campaign turn", !turnAnswered(partial) && turnAnswered(rec), JSON.stringify(partial.platformSpecific.status));
  // 0.79.0: the in-progress words are matched whole; a finished word that
  // merely contains one ("stream_complete", "generated") is done.
  const withStatus = (status) => ({ ...rec, platformSpecific: { ...rec.platformSpecific, status } });
  check("'resolved', 'stream_complete' and 'generated' finish a turn; 'streaming' and 'pending' don't",
    ["resolved", "stream_complete", "generated", "complete"].every((x) => turnAnswered(withStatus(x))) && ["streaming", "pending", "in_progress"].every((x) => !turnAnswered(withStatus(x))));
}

// 0.78.1, from the owner's Sunban campaign: 39% of signed-out ChatGPT
// captures were ChatGPT's "Message limit reached" card, stored as answers;
// and no signed-out capture had its prompt. The stream below has the same
// shape as theirs (a 429 diagnostic, then the gate inside the card's html),
// with made-up ids; the form fields are the ones the signed-out page posts.
console.log("\nChatGPT's message limit, and the prompt from the form");
{
  const esc = (o) => JSON.stringify(o).replace(/"/g, "&quot;");
  const limitStream = [
    JSON.stringify({ version: 2, type: "control", detail: { operationId: "op-9", streamType: "initial", kind: "started" } }),
    JSON.stringify({ version: 2, type: "diagnostic", kind: "source_submission_unavailable", payload: JSON.stringify({ status: 429, recoveredPendingTurn: false, hasUpstreamBody: true }) }),
    JSON.stringify({ version: 2, type: "shared", html: `<template for="conversation-partial-control"><span data-conversation-safety="${esc({ dismissedInterventionIds: [], gate: { body: "You have reached the anonymous message limit.", kind: "rate_limited", title: "Message limit reached" } })}" hidden=""><section><h2>Message limit reached</h2><p>You have reached the anonymous message limit.</p><button>New chat</button><a>Log in or sign up</a></section></span></template>` }),
  ].join("\n");
  const form = new URLSearchParams({ conversationState: JSON.stringify({ messages: [], parentMessageId: "client-created-root" }), prompt: PROMPT, timezone: "Asia/Kolkata" }).toString();
  check("the limit card is recognised", limitOfSource(limitStream) === "anonymous message limit", limitOfSource(limitStream));
  check("an ordinary answer is not", limitOfSource(stream) === null);
  check("a 429 on its own is a limit too", limitOfSource(JSON.stringify({ version: 2, type: "diagnostic", payload: "{\"status\":429}" })) === "rate_limited");
  check("the prompt is the form's prompt field", promptOfSourceRequest(form) === PROMPT && promptOfSourceRequest("{}") === null);
  const rec = await adapt({ captureId: "so3", raw: limitStream, url: "https://chatgpt.com/unauth-mweb/conversation/updates?operationId=op-9", reqBody: form, pageUrl: "https://chatgpt.com/", capturedAt: 1 }, { tracked: [{ name: "Zento" }] });
  check("the card is not an answer: no text, no brands", rec.answerText === "" && rec.answerChars === 0 && !rec.brandMentions.length, JSON.stringify(rec.answerText));
  check("it carries the limit, so a campaign pauses and asks again", usageLimitOf(rec) === "anonymous message limit" && !turnAnswered(rec));
  check("and its prompt", rec.userPrompt === PROMPT, rec.userPrompt);
  const ok = await adapt({ captureId: "so4", raw: stream, url: "https://chatgpt.com/unauth-mweb/conversation/updates", reqBody: form, pageUrl: "https://chatgpt.com/", capturedAt: 1 }, { tracked: [] });
  check("a real answer keeps its prompt from the form too", ok.userPrompt === PROMPT && ok.answerText.includes("Lumora") && !usageLimitOf(ok));
}

// 0.80.0: the answer's own cards. Signed out, ChatGPT's answer carries its
// products, local businesses and pictures as generative-UI components
// (Entity, AsyncImage); they were all dropped, so campaign answers showed none.
console.log("\nproducts, places and pictures");
{
  const comp = (componentName, state) => ({ componentName, status: "resolved", state });
  const cards = [
    ev({ role: "user", messageId: "u-9", markdown: "linen shirt shops near Pune" }),
    ev({ messageId: "m-9", revision: 1, status: "resolved", markdown: "**Zento Linen** sells the **Zento Breeze** shirt; try **Kovo Store Pune**.",
      components: {
        a: comp("Entity", { value: "Zento Breeze", action_payload: { category: "product", extraParams: { disambiguation: "linen shirt" } }, image_url: null }),
        b: comp("Entity", { value: "Kovo Store Pune", action_payload: { category: "local_business", extraParams: { location: "Baner, Pune" } }, directions_url: "https://maps.example/kovo-pune", image_url: "https://img.example/kovo.jpg" }),
        c: comp("Entity", { value: "Zento Linen", action_payload: { category: "brand" } }),
        d: comp("AsyncImage", { images: [{ url: "https://stylelab.example/zento-breeze", thumbnail_url: "https://img.example/zb-thumb.jpg", content_url: "https://img.example/zb.jpg", title: "Zento Breeze" }] }),
      } }),
  ].join("\n");
  const rec = await adapt({ captureId: "so9", raw: cards, url: "https://chatgpt.com/unauth-mweb/conversation/updates?operationId=op-9", reqBody: "{}", pageUrl: "https://chatgpt.com/", capturedAt: 1 }, { tracked: [{ name: "Zento" }] });
  check("a product card", rec.products.length === 1 && rec.products[0].name === "Zento Breeze", JSON.stringify(rec.products));
  check("a place, with where it is and its directions", rec.places.length === 1 && rec.places[0].name === "Kovo Store Pune" && rec.places[0].address === "Baner, Pune" && rec.places[0].mapsUrl === "https://maps.example/kovo-pune", JSON.stringify(rec.places));
  check("a picture, with the page it came from", rec.images.length === 1 && rec.images[0].url === "https://img.example/zb-thumb.jpg" && rec.images[0].sourceUrl === "https://stylelab.example/zento-breeze", JSON.stringify(rec.images));
  check("a brand entity is not a product or place", !rec.products.some((p) => p.name === "Zento Linen") && !rec.places.some((p) => p.name === "Zento Linen"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
