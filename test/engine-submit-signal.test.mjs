/*
 * engine-submit-signal.test.mjs — the page interceptor reports each engine's
 * own "answer this prompt" request, and nothing else.
 *
 * content-iso.js decides whether a prompt went out from page markup — the URL
 * moving to a conversation, a stop button, the prompt in the transcript — and
 * on Grok none of those matched: the script kept re-entering a prompt that
 * had already gone, then reported it as never sent. content-main.js sees the
 * engine's submit request itself and now posts "engine-submit", which
 * content-iso.js takes as proof (prompt-submit.test.mjs covers that side).
 *
 * The signal has to be strict: Perplexity's GraphQL sidebar calls match the
 * broader capture pattern, and reading one as a send would stop a turn before
 * its prompt was ever typed. content-main.js runs here in a vm with a fake
 * page for each engine.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const SRC = readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");

function loadPage(hostname) {
  const posted = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = {}; }
    send() {}
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
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
    fetch: async () => ({ status: 200 }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    URL, Request: globalThis.Request, Response: globalThis.Response, TextDecoder, TextEncoder, console,
    postMessage: (msg) => posted.push(msg),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const submits = () => posted.filter((m) => m && m.type === "engine-submit");
  return { w: sandbox, submits };
}

const post = (w, url) => w.fetch(url, { method: "POST", body: "{}" }).catch(() => {});

console.log("\nEach engine's submit request is reported");
{
  const { w, submits } = loadPage("chatgpt.com");
  await post(w, "/backend-api/f/conversation");
  check("ChatGPT: POST /backend-api/f/conversation", submits().length === 1 && submits()[0].via === "fetch", JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("gemini.google.com");
  const x = new w.XMLHttpRequest();
  x.open("POST", "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=x");
  x.send("f.req=...");
  check("Gemini: StreamGenerate over XHR", submits().length === 1 && submits()[0].via === "xhr", JSON.stringify(submits()));
}
{
  // 1.0.5: Gemini's send is now an upload to its WebChannel. Unseen, the
  // submit loop pressed send again: 2–3 conversations per question (live,
  // 24 Nov 2026). The channel's housekeeping posts there too, and is not a send.
  const { w, submits } = loadPage("gemini.google.com");
  const ping = new w.XMLHttpRequest();
  ping.open("POST", "https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&RID=12&SID=x");
  ping.send("count=1&ofs=3&req0___data__=%5B%5D");
  check("Gemini: the channel's small housekeeping post is not a send", submits().length === 0, JSON.stringify(submits()));
  const up = new w.XMLHttpRequest();
  up.open("POST", "https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&RID=13&SID=x");
  up.send(`count=1&ofs=4&req0___data__=${"Q".repeat(2400)}`);
  check("Gemini: the question's upload to processSession is the send", submits().length === 1 && submits()[0].via === "xhr", JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("www.perplexity.ai");
  await post(w, "/rest/sse/perplexity_ask");
  check("Perplexity: POST /rest/sse/perplexity_ask", submits().length === 1, JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("grok.com");
  const ws = new w.WebSocket("wss://grok.com/ws/mgw/?uid=u-1");
  ws.send(JSON.stringify({ event: { type: "session.create", session: {} } }));
  check("Grok: opening the gateway session is not a send", submits().length === 0, JSON.stringify(submits()));
  ws.send(JSON.stringify({ session_id: "s", event: { type: "conversation.item.create", item: { role: "user", x_grok: { input_chunks: [{ text: { text: "hi" } }] } } } }));
  check("Grok: the gateway's conversation.item.create", submits().length === 1 && submits()[0].via === "ws", JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("grok.com");
  await post(w, "/rest/app-chat/conversations/new");
  check("Grok: the REST conversations/new request", submits().length === 1, JSON.stringify(submits()));
}

console.log("\nOther traffic on the same endpoints is not");
{
  const { w, submits } = loadPage("www.perplexity.ai");
  await post(w, "/rest/perplexity_ask/graphql");
  await post(w, "/rest/sse/related-queries/abc");
  check("Perplexity: GraphQL and related-queries calls", submits().length === 0, JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("chatgpt.com");
  await post(w, "/backend-api/conversation/init");
  await w.fetch("/backend-api/conversation", {}).catch(() => {});
  check("ChatGPT: /conversation/init, and a GET", submits().length === 0, JSON.stringify(submits()));
}
{
  const { w, submits } = loadPage("grok.com");
  await post(w, "/rest/app-chat/conversations/abc/load-responses");
  check("Grok: loading an existing conversation", submits().length === 0, JSON.stringify(submits()));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
