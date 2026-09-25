/*
 * grok-gateway.test.mjs — Grok answers arrive over grok.com's WebSocket
 * gateway, and are read.
 *
 * grok.com moved its web text chat off the REST stream the Grok adapter was
 * written for (rest/app-chat/conversations/new) onto a WebSocket gateway,
 * wss://grok.com/ws/mgw/. Every campaign since recorded Grok as 0 of N: the
 * page script did capture the socket, but no frame had the top-level
 * message/token fields the adapter reads, so each capture read as empty and
 * was dropped as "0-signal" without a word in any log.
 *
 * The transcripts below are SYNTHETIC — no real Grok conversation is copied
 * into this repository. Their shapes follow two independent open-source
 * bridges for authenticated grok.com sessions: anojndr/grok.com-to-openai
 * (grok_gateway.py: session.create, conversation.item.create with
 * x_grok.input_chunks, response.chunk with chunk.text.{text,channel},
 * response.output_text.delta, response.grok.output with tool_usage_card and
 * stream_error, response.search.result, response.done) and the gateway change
 * in stabey/Aether-upstream-fork. When a diagnostics export carries a real
 * gateway capture, it should replace these.
 *
 * Two halves: the adapter reading gateway frames, and the page script's
 * socket hook (content-main.js, run in a vm with a fake grok.com socket)
 * cutting one capture per answer — started by the prompt the page sends,
 * handed over on response.done without waiting on a page timer.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { adapt } from "../src/adapters/grok.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const PROMPT = "best budget phone for photography";
const CARD_URL = "https://reviews.example/phones/budget-camera";
const RESULT_URL = "https://shop.example/phones";

const frame = (event, extra = {}) => JSON.stringify({ session_id: "sess-1", ...extra, event });
const itemCreate = (text) => frame({
  type: "conversation.item.create",
  event_id: "evt_msg_1",
  item: { type: "message", role: "user", x_grok: { client_message_id: "m1", input_chunks: [{ text: { text } }] } },
});

const chunkTurn = [
  frame({ type: "conversation.item.added", item: { id: "u1", role: "user" } }),
  frame({ type: "response.output_item.added", item: { id: "a1", role: "assistant" } }),
  frame({ type: "response.chunk", chunk: { text: { text: "Thinking about your request", channel: "NOTETAKER_HEADER" } } }),
  frame({ type: "response.chunk", chunk: { text: { text: "Let me weigh sensor size first.", channel: "THINKING" } } }),
  frame({ type: "response.grok.output", output: { tool_usage_card: { web_search: { args: { query: "budget camera phone 2026 review" } } } } }),
  frame({ type: "response.search.result", result: { web_results: [{ url: RESULT_URL, title: "Phones on sale" }] } }),
  frame({ type: "response.chunk", chunk: { card_attachment: { id: "c1", url: CARD_URL, title: "Budget camera phones tested" } } }),
  frame({ type: "response.chunk", chunk: { text: { text: "The Pixel 9a is the pick", channel: "FINAL" } } }),
  frame({ type: "response.chunk", chunk: { text: { text: '<grok:render card_id="c1" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">0</argument></grok:render>', channel: "FINAL" } } }),
  frame({ type: "response.chunk", chunk: { text: { text: " for photos under budget.", channel: "FINAL" } } }),
  frame({ type: "response.done", response: { id: "a1", status: "completed" } }),
].join("\n");

console.log("\nAdapter: a gateway answer streamed as response.chunk frames");
{
  const r = await adapt({ captureId: "t1", raw: chunkTurn, reqBody: itemCreate(PROMPT), capturedAt: 1, pageUrl: "https://grok.com/c/x" });
  check("the prompt is read from the conversation.item.create the page sent", r.userPrompt === PROMPT, r.userPrompt);
  check("the answer text is read", /The Pixel 9a is the pick/.test(r.answerText) && /for photos under budget\./.test(r.answerText), r.answerText);
  check("reasoning is not mistaken for the answer", !/sensor size/.test(r.answerText), r.answerText);
  check("the timeline header is not mistaken for the answer", !/Thinking about your request/.test(r.answerText), r.answerText);
  check("reasoning is kept as thoughts", (r.platformSpecific.thoughts || []).join(" ").includes("sensor size"), JSON.stringify(r.platformSpecific.thoughts));
  check("the inline citation becomes the shared [[cite:URL]] marker", r.answerText.includes(`[[cite:${CARD_URL}]]`), r.answerText);
  check("no raw <grok:render> markup survives", !r.answerText.includes("<grok:render"), r.answerText);
  const byUrl = new Map(r.sources.map((s) => [s.url, s]));
  check("the cited card is a cited source", byUrl.get(CARD_URL)?.outcome === "cited", JSON.stringify(byUrl.get(CARD_URL)));
  check("a search result is a fetched source", byUrl.get(RESULT_URL)?.outcome === "fetched", JSON.stringify(byUrl.get(RESULT_URL)));
  check("the search query is fan-out", r.fanout.search.some((q) => q.query === "budget camera phone 2026 review"), JSON.stringify(r.fanout.search));
  check("it counts as searched", r.searched === true);
  check("it has signal, so it is stored rather than dropped as 0-signal", r.answerChars > 0);
  check("the record says it came from the gateway", r.platformSpecific.transport === "gateway" && r.platformSpecific.gatewayStatus === "completed",
    JSON.stringify({ t: r.platformSpecific.transport, s: r.platformSpecific.gatewayStatus }));
}

console.log("\nAdapter: a gateway answer streamed as output_text deltas");
{
  const raw = [
    frame({ type: "response.reasoning_text.delta", delta: "Considering options. " }),
    frame({ type: "response.output_text.delta", delta: "Short " }),
    frame({ type: "response.output_text.delta", delta: "answer." }),
    frame({ type: "response.done", response: { status: "completed" } }),
  ].join("\n");
  const r = await adapt({ captureId: "t2", raw, reqBody: itemCreate(PROMPT), capturedAt: 1 });
  check("deltas are joined in order", r.answerText === "Short answer.", JSON.stringify(r.answerText));
  check("reasoning deltas stay out of the answer", !/Considering/.test(r.answerText));
}

console.log("\nAdapter: a build that sends both chunk and delta frames");
{
  const raw = [
    frame({ type: "response.chunk", chunk: { text: { text: "Once.", channel: "FINAL" } } }),
    frame({ type: "response.output_text.delta", delta: "Once." }),
    frame({ type: "response.done", response: { status: "completed" } }),
  ].join("\n");
  const r = await adapt({ captureId: "t3", raw, reqBody: itemCreate(PROMPT), capturedAt: 1 });
  check("the answer is not doubled", r.answerText === "Once.", JSON.stringify(r.answerText));
}

console.log("\nAdapter: a usage limit reported by the gateway");
{
  const raw = [
    frame({ type: "response.grok.output", output: { stream_error: { kind: "usage_limit_exceeded", message: "limit" } } }),
    frame({ type: "response.done", response: { status: "incomplete" } }),
  ].join("\n");
  const r = await adapt({ captureId: "t4", raw, reqBody: itemCreate(PROMPT), capturedAt: 1 });
  check("the error kind is recorded", r.platformSpecific.gatewayError === "usage_limit_exceeded", r.platformSpecific.gatewayError);
  check("and the prompt is still known", r.userPrompt === PROMPT);
}

console.log("\nAdapter: the REST format still reads as before");
{
  const fixture = readFileSync(new URL("./fixtures/grok-cameraPhoneRenderTags.txt", import.meta.url), "utf8");
  const body = fixture.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  const reqBody = (fixture.match(/^# reqBody: (.*)$/m) || [])[1] || null;
  const r = await adapt({ captureId: "t5", raw: body, reqBody, capturedAt: 1 });
  check("a load-responses capture still yields its answer", r.answerChars > 200, r.answerChars);
  check("and is marked as REST", r.platformSpecific.transport === "rest", r.platformSpecific.transport);
}

// ---------------------------------------------------------------------------
// The page script's socket hook.
// ---------------------------------------------------------------------------
function loadPageScript(hostname) {
  const posted = [];
  const timers = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = {}; }
    send(d) { this.sent.push(d); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    receive(data) { for (const fn of this.listeners.message || []) fn({ data }); }
    close() { for (const fn of this.listeners.close || []) fn({}); }
  }
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};
  const sandbox = {
    location: { hostname, href: `https://${hostname}/`, origin: `https://${hostname}` },
    document: { documentElement: { setAttribute() {}, getAttribute() { return null; } } },
    crypto: webcrypto,
    fetch: async () => ({}),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    URL, Response: globalThis.Response, TextDecoder, TextEncoder, console,
    postMessage: (msg) => posted.push(msg),
    // Page timers are recorded, never run on their own: in a background tab
    // Chrome can hold them for a minute, so a hand-over must not need them.
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1] = null; },
    setInterval: () => 0, clearInterval: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8"), sandbox);
  const captures = () => posted.filter((m) => m && m.type === "raw-conversation");
  const runTimers = () => { const t = timers.splice(0); t.forEach((fn) => fn && fn()); };
  return { sandbox, captures, runTimers };
}

console.log("\nPage script: one capture per Grok answer, handed over on response.done");
{
  const { sandbox, captures, runTimers } = loadPageScript("grok.com");
  const ws = new sandbox.WebSocket("wss://grok.com/ws/mgw/?uid=u-1");
  // Connection chatter before any prompt: not an answer.
  ws.receive(frame({ type: "session.created", session: { model: "grok-4" } }, { session_id: "sess-1" }));
  ws.receive(frame({ type: "conversation.attached" }));
  runTimers();
  check("session chatter alone is not handed over", captures().length === 0, captures().length);

  ws.send(itemCreate(PROMPT));
  ws.send(frame({ type: "response.create", event_id: "evt_resp_1" }));
  for (const line of chunkTurn.split("\n")) ws.receive(line);
  const first = captures();
  check("the answer is handed over on response.done, with no page timer run", first.length === 1, first.length);
  check("it carries the prompt frame as its request body", first[0] && first[0].reqBody && first[0].reqBody.includes(PROMPT), first[0] && first[0].reqBody);
  check("it starts at the prompt, not at the session chatter", first[0] && !first[0].raw.includes("session.created"), first[0] && first[0].raw.slice(0, 120));
  check("it is marked as a websocket capture from grok.com", first[0] && first[0].transport === "websocket" && /grok\.com/.test(first[0].url));

  runTimers();
  ws.receive(frame({ type: "pong" }));
  runTimers();
  check("a keepalive after the answer is not handed over", captures().length === 1, captures().length);

  const SECOND = "which of those has the best night mode";
  ws.send(itemCreate(SECOND));
  ws.receive(frame({ type: "response.chunk", chunk: { text: { text: "Night mode answer.", channel: "FINAL" } } }));
  ws.receive(frame({ type: "response.done", response: { status: "completed" } }));
  const all = captures();
  check("a second prompt on the same socket is a second capture", all.length === 2, all.length);
  check("which holds only the second answer", all[1] && all[1].raw.includes("Night mode answer.") && !all[1].raw.includes("Pixel 9a"), all[1] && all[1].raw.slice(0, 200));
  check("and the second prompt", all[1] && all[1].reqBody.includes(SECOND));

  ws.close();
  check("closing the socket does not hand the last answer over twice", captures().length === 2, captures().length);

  const rec = await adapt({ captureId: "e2e", raw: first[0].raw, reqBody: first[0].reqBody, capturedAt: 1 });
  check("end to end: the handed-over capture reads as the right prompt and answer",
    rec.userPrompt === PROMPT && /Pixel 9a/.test(rec.answerText), JSON.stringify({ p: rec.userPrompt, a: rec.answerText.slice(0, 60) }));
}

console.log("\nPage script: Perplexity's socket still hands over on its debounce");
{
  const { sandbox, captures, runTimers } = loadPageScript("www.perplexity.ai");
  const ws = new sandbox.WebSocket("wss://www.perplexity.ai/socket.io/?EIO=4&transport=websocket");
  ws.send('420["perplexity_ask","q"]');
  ws.receive('430[{"text":"an answer"}]');
  check("nothing before the debounce fires", captures().length === 0);
  runTimers();
  check("one capture once it fires", captures().length === 1, captures().length);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
