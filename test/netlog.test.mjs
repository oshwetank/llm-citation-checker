/*
 * The network recorder's rules (src/lib/netlog.js, 0.62.0).
 * Run: node test/netlog.test.mjs
 *
 * Reported: Gemini, Perplexity and Grok stopped being captured and the
 * diagnostic report couldn't say why: it held no network data at all. With
 * Debug capture on, every request an engine page makes is now logged, and the
 * report groups them. These check what may be kept (ids and prompt-like path
 * segments masked, query key names without values, response key names
 * without values) and that the grouping says which calls were captured.
 */
import { readFileSync } from "node:fs";
import { maskPath, queryKeys, keyShape, cleanEntry, appendRing, groupNetlog, netlogReportLines, NET_VALUE_KEYS } from "../src/lib/netlog.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

console.log("paths and queries");
{
  check("a uuid is masked", maskPath("/backend-api/conversation/6f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f/stream") === "/backend-api/conversation/:id/stream", maskPath("/backend-api/conversation/6f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f/stream"));
  check("hex and numeric ids are masked", maskPath("/app/c/8f3a2b1c9d0e/r/123456") === "/app/c/:id/r/:id", maskPath("/app/c/8f3a2b1c9d0e/r/123456"));
  check("a prompt slug is masked", maskPath("/search/best-camera-phones-under-30000-xYz") === "/search/:text", maskPath("/search/best-camera-phones-under-30000-xYz"));
  check("an encoded prompt with spaces is masked", maskPath("/ask/best%20phone%20for%20me") === "/ask/:text");
  check("ordinary words stay", maskPath("/_/BardChatUi/data/batchexecute") === "/_/BardChatUi/data/batchexecute");
  check("query keys, never values", JSON.stringify(queryKeys("?q=best+phone&rpcids=abc&f.sid=-123&q=again")) === JSON.stringify(["f.sid", "q", "rpcids"]), JSON.stringify(queryKeys("?q=best+phone&rpcids=abc&f.sid=-123")));
}

console.log("response shapes");
{
  const s = keyShape('data: {"message":{"content":{"parts":["Zento Nova 8 is best"]}},"conversation_id":"abc"}\n\n');
  check("an event stream's keys, without its text", s.form === "sse" && s.keys.join() === "message,content,parts,conversation_id" && !JSON.stringify(s).includes("Zento"), JSON.stringify(s));
  check("Gemini's guarded JSON is named", keyShape(")]}'\n[[\"wrb.fr\",null]]").form === "xssi");
  check("a socket.io frame is named", keyShape('42["perplexity_ask",{"query_str":"x"}]').form === "socket.io");
  check("empty is nothing", keyShape("") === null);
  check("only the first 2 KB is looked at", !keyShape(`{"a":"${"x".repeat(3000)}","late":1}`).keys.includes("late"));
}

console.log("what is stored");
{
  const e = cleanEntry({ page: "gemini.google.com", kind: "fetch", method: "post", host: "gemini.google.com", path: "/api/v2/conversations/1a2b3c4d5e6f7a8b/answers", q: ["prompt", "best phone="], status: 200, type: "application/json; charset=utf-8", size: 1234.4, ms: 88, matched: false, shape: { form: "json", keys: ["answer_text", "Zento Nova 8 secret"] }, body: "secret", url: "https://x/?prompt=secret" });
  check("only bounded fields, re-masked", e.path === "/api/v2/conversations/:id/answers" && e.method === "POST" && e.type === "application/json" && e.size === 1234 && !("body" in e) && !("url" in e), JSON.stringify(e));
  check("query and key names that aren't names are dropped", e.q.join() === "prompt" && e.shape.keys.join() === "answer_text", JSON.stringify(e));
  const ring = appendRing(Array.from({ length: 5 }, (_, i) => cleanEntry({ path: `/a${i}` })), [{ path: "/new" }], 3);
  check("the ring keeps the newest", ring.length === 3 && ring[2].path === "/new" && ring[0].path === "/a3", JSON.stringify(ring.map((r) => r.path)));
}

console.log("grouped for the report");
{
  const mk = (o) => cleanEntry({ page: "gemini.google.com", host: "gemini.google.com", method: "POST", type: "application/json", ...o });
  const entries = [
    mk({ path: "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate", kind: "xhr", matched: true, size: 9000 }),
    mk({ path: "/_/BardChatUi/data/batchexecute", q: ["rpcids"], kind: "fetch", size: 300, shape: { form: "xssi", keys: [] } }),
    mk({ path: "/_/BardChatUi/data/batchexecute", q: ["rpcids", "bl"], kind: "fetch", size: 900 }),
    mk({ page: "www.perplexity.ai", host: "www.perplexity.ai", path: "/rest/sse/perplexity_ask", kind: "fetch", matched: true }),
  ];
  const g = groupNetlog(entries);
  const gem = g.find((x) => x.page === "gemini.google.com");
  const be = gem.rows[0];
  check("by engine page, then path, busiest first", g[0].page === "gemini.google.com" && gem.total === 3 && be.path === "/_/BardChatUi/data/batchexecute" && be.count === 2, JSON.stringify(g));
  check("with how many were captured, the query keys and the size range", be.matched === 0 && be.q.join() === "bl,rpcids" && be.size === "300 B–900 B" && gem.rows[1].matched === 1, JSON.stringify(be));
  const text = netlogReportLines(entries).join("\n");
  check("the report names uncaptured calls and their shape", /batchexecute\?bl&rpcids · 2× · not captured/.test(text) && /starts as xssi/.test(text) && /StreamGenerate · 1× · captured 1/.test(text), text);
  check("an empty log says how to fill it", /Turn on Debug capture/.test(netlogReportLines([]).join("\n")));
}

console.log("values that name the call (0.62.1)");
{
  // Gemini's answer moved; its batchexecute calls differ only by rpcids, so
  // the report needs that value (a method name, nothing of the user's).
  const e = cleanEntry({ page: "gemini.google.com", host: "gemini.google.com", path: "/_/BardChatUi/data/batchexecute", q: ["rpcids", "f.sid", "q"], qv: { rpcids: "ESY5D", "f.sid": "-4242", q: "best phone" } });
  check("rpcids keeps its value; nothing else does", JSON.stringify(e.qv) === JSON.stringify({ rpcids: "ESY5D" }), JSON.stringify(e.qv));
  check("a value that isn't a plain name is dropped", JSON.stringify(cleanEntry({ qv: { rpcids: "best phone under 30000?" } }).qv) === "{}");
  const g = groupNetlog([e, cleanEntry({ ...e, qv: { rpcids: "hNvQHb" } }), cleanEntry({ ...e, qv: { rpcids: "ESY5D" } })]);
  check("calls with different rpcids are separate rows", g[0].rows.length === 2 && g[0].rows[0].count === 2, JSON.stringify(g[0].rows.map((r) => [r.qvs, r.count])));
  check("and the report shows the value", /batchexecute\?f\.sid&q&rpcids=ESY5D · 2×/.test(netlogReportLines([e, e]).join("\n")), netlogReportLines([e, e]).join("\n"));
  const src = readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");
  const page = (src.match(/const NET_VALUE_KEYS = (\/.*\/);/) || [])[1];
  check("the page keeps the same keys", page === String(NET_VALUE_KEYS), `${page} vs ${NET_VALUE_KEYS}`);
}

console.log("the page's copy of the rules");
{
  // content-main.js can't import this module, so it carries its own copy;
  // run that copy on the same paths and it must agree.
  const src = readFileSync(new URL("../src/content-main.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("const NET_ID"), src.indexOf("const netShape"));
  const pageMask = new Function(`${body}; return netMask;`)();
  const paths = ["/backend-api/conversation/6f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f/stream", "/app/c/8f3a2b1c9d0e/r/123456", "/search/best-camera-phones-under-30000-xYz", "/ask/best%20phone%20for%20me", "/_/BardChatUi/data/batchexecute", "/rest/sse/perplexity_ask", "/i/api/graphql/AbCdEf123456GhIjKl/CreateGrokConversation"];
  const differ = paths.filter((p) => pageMask(p) !== maskPath(p));
  check("masks every path the same way", body.length > 100 && differ.length === 0, JSON.stringify(differ.map((p) => [pageMask(p), maskPath(p)])));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
