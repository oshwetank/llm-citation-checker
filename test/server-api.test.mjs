/*
 * server-api.test.mjs — the 0.82.0 server's handlers, called directly with
 * Supabase, DNS and the clock stubbed (server/lib/deps.js). No network.
 * The stand-in Supabase below keeps tables and files in memory and answers
 * the handful of REST calls the handlers make.
 */
import { readFileSync } from "node:fs";
import { deps } from "../server/lib/deps.js";
import subscribe, { domainTakesMail } from "../server/api/subscribe.js";
import unsubscribe from "../server/api/unsubscribe.js";
import profile from "../server/api/profile.js";
import share, { newCode, MAX_LIVE_SHARES } from "../server/api/share.js";
import { allowedOrigin } from "../server/lib/http.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const SB = "https://sb.example";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const tables = { subscribers: [], profiles: [], shared_campaigns: [] };
const files = new Map();
const users = { "tok-asha": { id: "u-asha", email: "asha@zento.example" }, "tok-ravi": { id: "u-ravi", email: "ravi@kovo.example" } };
const calls = [];

// PostgREST filters this server uses: eq, gt, is.null, is.true.
const matches = (row, qs) => [...qs.entries()].every(([k, v]) => {
  if (["select", "order", "on_conflict"].includes(k)) return true;
  const [op, ...rest] = v.split(".");
  const val = decodeURIComponent(rest.join("."));
  if (op === "eq") return String(row[k]) === val;
  if (op === "gt") return String(row[k]) > val;
  if (op === "is") return val === "null" ? row[k] == null : val === "true" ? row[k] === true : row[k] === false;
  return true;
});
const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });

deps.env = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: "svc" };
let clock = Date.parse("2026-10-28T10:00:00Z");
deps.now = () => clock;
deps.resolveMx = async (d) => { if (d === "nomail.example") throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); if (d === "slow.example") throw Object.assign(new Error("x"), { code: "ETIMEOUT" }); return [{ exchange: `mx.${d}`, priority: 10 }]; };
deps.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  calls.push(`${method} ${u.pathname}`);
  const headers = opts.headers || {};
  if (u.pathname === "/auth/v1/user") { const t = (headers.authorization || "").replace("Bearer ", ""); return users[t] ? reply(200, users[t]) : reply(401, { msg: "bad jwt" }); }
  if (headers.authorization !== "Bearer svc") return reply(401, { message: "service key needed" });
  const rm = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (rm) {
    const t = tables[rm[1]];
    const qs = u.searchParams;
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET") return reply(200, t.filter((r) => matches(r, qs)));
    if (method === "POST") {
      const key = qs.get("on_conflict");
      const i = key ? t.findIndex((r) => r[key] === body[key]) : -1;
      if (i >= 0) t[i] = { ...t[i], ...body }; else t.push({ ...body });
      return reply(201);
    }
    if (method === "PATCH") { const hit = t.filter((r) => matches(r, qs)); hit.forEach((r) => Object.assign(r, body)); return reply(200, hit); }
  }
  const up = /^\/storage\/v1\/object\/upload\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (up) return reply(200, { url: `/object/upload/sign/shares/${up[1]}?token=t1` });
  const sg = /^\/storage\/v1\/object\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (sg) return files.has(sg[1]) ? reply(200, { signedURL: `/object/sign/shares/${sg[1]}?token=d1` }) : reply(400, { message: "Object not found" });
  const del = /^\/storage\/v1\/object\/shares\/(.+)$/.exec(u.pathname);
  if (del && method === "DELETE") { files.delete(del[1]); return reply(200, {}); }
  return reply(404, { message: `no route ${method} ${u.pathname}` });
};

// A minimal Node request/response pair.
async function hit(fn, { method = "GET", url = "/", body, token, origin = EXT } = {}) {
  const req = { method, url, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.text = t || ""; } };
  await fn(req, res);
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch (_) { /* not JSON */ }
  return { status: res.statusCode, headers: res.headers, json };
}

console.log("\nwho may call");
check("the extension's pages", allowedOrigin(EXT) === EXT);
check("not a web page", allowedOrigin("https://evil.example") === "");
deps.env.EXTENSION_IDS = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
check("only the published id, once EXTENSION_IDS is set", allowedOrigin(EXT) === "");
deps.env.EXTENSION_IDS = "";
const pre = await hit(subscribe, { method: "OPTIONS" });
check("preflight answered, with CORS", pre.status === 204 && pre.headers["access-control-allow-origin"] === EXT);
check("another site is refused", (await hit(subscribe, { method: "POST", origin: "https://evil.example", body: {} })).status === 403);
check("a wrong method", (await hit(subscribe, { method: "GET" })).status === 405);
deps.env.SUPABASE_URL = "";
check("unconfigured says so", (await hit(subscribe, { method: "POST", body: {} })).status === 503);
deps.env.SUPABASE_URL = SB;

console.log("\nupdate emails");
const s0 = await hit(subscribe, { method: "POST", body: { email: "asha@zento.example" } });
check("consent is required", s0.status === 400 && /Tick the box/.test(s0.json.error));
const s1 = await hit(subscribe, { method: "POST", body: { email: "lol random", consent: true } });
check("random text refused", s1.status === 400 && s1.json.reason === "shape");
const s2 = await hit(subscribe, { method: "POST", body: { email: "x@mailinator.com", consent: true } });
check("a burner inbox refused, same message as the extension", s2.status === 400 && s2.json.reason === "disposable" && /💀/.test(s2.json.error));
const s3 = await hit(subscribe, { method: "POST", body: { email: "x@nomail.example", consent: true } });
check("a domain that takes no mail refused", s3.status === 400 && s3.json.reason === "no-mx", JSON.stringify(s3.json));
check("a slow lookup lets it through", await domainTakesMail("slow.example"));
const s4 = await hit(subscribe, { method: "POST", body: { email: " Asha@Zento.example ", consent: true, source: "welcome" } });
check("a real address kept, lower-cased, with a token", s4.status === 200 && s4.json.token && tables.subscribers.length === 1 && tables.subscribers[0].email === "asha@zento.example" && tables.subscribers[0].source === "welcome");
await hit(subscribe, { method: "POST", body: { email: "asha@zento.example", consent: true } });
check("subscribing twice keeps one row", tables.subscribers.length === 1);
const tok = tables.subscribers[0].token;
check("unsubscribe needs the token", (await hit(unsubscribe, { method: "POST", body: { email: "asha@zento.example", token: "guess" } })).status === 404 && !tables.subscribers[0].unsubscribed_at);
check("and works with it", (await hit(unsubscribe, { method: "POST", body: { email: "asha@zento.example", token: tok } })).status === 200 && !!tables.subscribers[0].unsubscribed_at);

console.log("\nprofile");
check("signed out is refused", (await hit(profile)).status === 401);
check("a bad token is refused", (await hit(profile, { token: "forged" })).status === 401);
const p1 = await hit(profile, { method: "POST", token: "tok-asha", body: { display_name: "  Asha K\u0007 " } });
check("a name is set, cleaned", p1.status === 200 && p1.json.display_name === "Asha K");
const p2 = await hit(profile, { token: "tok-asha" });
check("and read back with the email", p2.json.display_name === "Asha K" && p2.json.email === "asha@zento.example");

console.log("\nsharing a campaign");
check("signed out can't share", (await hit(share, { method: "POST", body: { bytes: 10 } })).status === 401);
check("over 25 MB is refused", (await hit(share, { method: "POST", token: "tok-asha", body: { bytes: 26 * 1048576 } })).status === 413);
const st = await hit(share, { method: "POST", token: "tok-asha", body: { name: "Zento lamps", bytes: 4096, counts: { prompts: 12, runs: 2, answers: 40 } } });
const code = st.json && st.json.code;
check("a code and an upload address", st.status === 200 && /^[A-HJ-NP-Z2-9]{10}$/.test(code) && st.json.uploadUrl === `${SB}/storage/v1/object/upload/sign/shares/u-asha/${code}.cito?token=t1`, JSON.stringify(st.json));
check("the file goes straight to storage, not through the function", !calls.some((c) => c.includes("/object/shares/") && c.startsWith("POST")));
check("not openable before the file arrives", (await hit(share, { url: `/api/share?code=${code}`, token: "tok-ravi" })).status === 404);
check("confirming before the upload says so", (await hit(share, { method: "POST", url: `/api/share?code=${code}&done=1`, token: "tok-asha" })).status === 409);
files.set(`u-asha/${code}.cito`, true);
check("someone else can't confirm it", (await hit(share, { method: "POST", url: `/api/share?code=${code}&done=1`, token: "tok-ravi" })).status === 404);
check("confirmed by its owner", (await hit(share, { method: "POST", url: `/api/share?code=${code}&done=1`, token: "tok-asha" })).status === 200);
const g = await hit(share, { url: `/api/share?code=${code.toLowerCase()}`, token: "tok-ravi" });
check("another person opens it by code, any case", g.status === 200 && g.json.name === "Zento lamps" && g.json.from === "Asha K" && g.json.counts.answers === 40 && /\/object\/sign\/shares\//.test(g.json.downloadUrl), JSON.stringify(g.json));
check("opening it needs a sign-in", (await hit(share, { url: `/api/share?code=${code}` })).status === 401);
check("downloads are counted", tables.shared_campaigns[0].downloads === 1);
check("a malformed code", (await hit(share, { url: "/api/share?code=ABC", token: "tok-ravi" })).status === 400);
const mine = await hit(share, { url: "/api/share", token: "tok-asha" });
check("the owner's list", mine.json.shares.length === 1 && mine.json.shares[0].code === code);
check("others see their own list, not hers", (await hit(share, { url: "/api/share", token: "tok-ravi" })).json.shares.length === 0);
check("only the owner can stop it", (await hit(share, { method: "DELETE", url: `/api/share?code=${code}`, token: "tok-ravi" })).status === 404);
check("stopped by the owner, file deleted", (await hit(share, { method: "DELETE", url: `/api/share?code=${code}`, token: "tok-asha" })).status === 200 && !files.has(`u-asha/${code}.cito`));
check("and the code no longer opens", (await hit(share, { url: `/api/share?code=${code}`, token: "tok-ravi" })).status === 404);

console.log("\nlimits");
for (let i = 0; i < MAX_LIVE_SHARES; i++) tables.shared_campaigns.push({ code: `X${i}`, owner: "u-ravi", ready: true, revoked_at: null, expires_at: new Date(clock + 864e5).toISOString() });
check(`at most ${MAX_LIVE_SHARES} live shares each`, (await hit(share, { method: "POST", token: "tok-ravi", body: { bytes: 10 } })).status === 429);
const st2 = await hit(share, { method: "POST", token: "tok-asha", body: { name: "Old", bytes: 10 } });
files.set(`u-asha/${st2.json.code}.cito`, true);
await hit(share, { method: "POST", url: `/api/share?code=${st2.json.code}&done=1`, token: "tok-asha" });
clock += 91 * 864e5;
check("a share runs out after 90 days", (await hit(share, { url: `/api/share?code=${st2.json.code}`, token: "tok-ravi" })).status === 404);
let n = 0; deps.randomInt = () => (n++ % 32);
check("codes use letters that can't be misread", newCode() === "ABCDEFGHJK" && !/[IO01]/.test(Array.from({ length: 4 }, newCode).join("")));

console.log("\nthe server's email check is the extension's");
check("identical copies", readFileSync(new URL("../server/lib/emailCheck.js", import.meta.url), "utf8") === readFileSync(new URL("../src/lib/emailCheck.js", import.meta.url), "utf8"));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
