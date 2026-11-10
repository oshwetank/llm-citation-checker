/*
 * server-campaigns.test.mjs — /api/campaigns (0.85.0): campaigns saved to a
 * profile and shared with named people, called directly with Supabase and
 * the clock stubbed (server/lib/deps.js). No network. The stand-in Supabase
 * keeps tables and files in memory, like server-api.test.mjs, and answers
 * the extra PostgREST filters this handler uses (in, not.is.null, DELETE).
 */
import { deps } from "../server/lib/deps.js";
import campaigns, { MAX_PROFILE_BYTES, MAX_PROFILE_CAMPAIGNS, MAX_PEOPLE } from "../server/api/campaigns.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const SB = "https://sb.example";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const tables = { profiles: [{ id: "u-asha", display_name: "Asha K" }], cloud_campaigns: [], campaign_people: [] };
const files = new Map();
const users = {
  "tok-asha": { id: "u-asha", email: "asha@zento.example" },
  "tok-ravi": { id: "u-ravi", email: "Ravi@Kovo.example" }, // mixed case: matched lower-cased
  "tok-mei": { id: "u-mei", email: "mei@lumen.example" },
};
const signs = [];

const matches = (row, qs) => [...qs.entries()].every(([k, v]) => {
  if (["select", "order", "on_conflict"].includes(k)) return true;
  const not = v.startsWith("not.");
  const [op, ...rest] = (not ? v.slice(4) : v).split(".");
  const val = decodeURIComponent(rest.join("."));
  let ok = true;
  if (op === "eq") ok = String(row[k]) === val;
  else if (op === "gt") ok = String(row[k]) > val;
  else if (op === "is") ok = val === "null" ? row[k] == null : val === "true" ? row[k] === true : row[k] === false;
  else if (op === "in") ok = val.replace(/^\(|\)$/g, "").split(",").includes(String(row[k]));
  return not ? !ok : ok;
});
const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) });

deps.env = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: "svc" };
let clock = Date.parse("2026-11-10T10:00:00Z");
deps.now = () => clock;
let uuidN = 0;
deps.randomUUID = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;
deps.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  if (u.pathname === "/auth/v1/user") { const t = (headers.authorization || "").replace("Bearer ", ""); return users[t] ? reply(200, users[t]) : reply(401, { msg: "bad jwt" }); }
  if (headers.authorization !== "Bearer svc") return reply(401, { message: "service key needed" });
  const rm = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (rm) {
    const name = rm[1];
    const qs = u.searchParams;
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET") return reply(200, tables[name].filter((r) => matches(r, qs)));
    if (method === "POST") { for (const b of Array.isArray(body) ? body : [body]) tables[name].push({ ...b }); return reply(201); }
    if (method === "PATCH") { const hit = tables[name].filter((r) => matches(r, qs)); hit.forEach((r) => Object.assign(r, body)); return reply(200, hit); }
    if (method === "DELETE") { tables[name] = tables[name].filter((r) => !matches(r, qs)); return reply(204); }
  }
  const up = /^\/storage\/v1\/object\/upload\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (up) { signs.push({ path: up[1], upsert: headers["x-upsert"] === "true" }); return reply(200, { url: `/object/upload/sign/shares/${up[1]}?token=t1` }); }
  const sg = /^\/storage\/v1\/object\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (sg) return files.has(sg[1]) ? reply(200, { signedURL: `/object/sign/shares/${sg[1]}?token=d1` }) : reply(400, { message: "Object not found" });
  const del = /^\/storage\/v1\/object\/shares\/(.+)$/.exec(u.pathname);
  if (del && method === "DELETE") { files.delete(del[1]); return reply(200, {}); }
  return reply(404, { message: `no route ${method} ${u.pathname}` });
};

async function hit({ method = "GET", url = "/api/campaigns", body, token, origin = EXT } = {}) {
  const req = { method, url, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.text = t || ""; } };
  await campaigns(req, res);
  let json = null;
  try { json = res.text ? JSON.parse(res.text) : null; } catch (_) { /* not JSON */ }
  return { status: res.statusCode, json };
}
// What the extension does: ask, upload to the address, confirm.
async function save(token, owner, body) {
  const st = await hit({ method: "POST", token, body });
  if (st.status !== 200) return st;
  files.set(`${owner}/profile/${st.json.id}.cito`, body.bytes);
  const done = await hit({ method: "POST", url: `/api/campaigns?id=${st.json.id}&done=1`, token });
  return { ...done, id: st.json.id, uploadUrl: st.json.uploadUrl };
}

console.log("\nsaving to a profile");
check("signed out is refused", (await hit({ method: "POST", body: { localId: "c1", bytes: 10 } })).status === 401);
check("a campaign id is needed", (await hit({ method: "POST", token: "tok-asha", body: { bytes: 10 } })).status === 400);
check("an empty file is refused", (await hit({ method: "POST", token: "tok-asha", body: { localId: "c1", bytes: 0 } })).status === 400);
check("over 25 MB is refused", (await hit({ method: "POST", token: "tok-asha", body: { localId: "c1", bytes: 26 * 1048576 } })).status === 413);
const first = await hit({ method: "POST", token: "tok-asha", body: { localId: "c1", name: "Zento lamps", bytes: 4000, counts: { prompts: 300, runs: 2, answers: 1200 } } });
const cid = first.json && first.json.id;
check("an id and an upload address, under the owner's folder", first.status === 200 && first.json.uploadUrl === `${SB}/storage/v1/object/upload/sign/shares/u-asha/profile/${cid}.cito?token=t1`, JSON.stringify(first.json));
check("the address replaces the last save (upsert)", signs.at(-1).upsert === true);
check("not listed before the file arrives", (await hit({ token: "tok-asha" })).json.mine.length === 0);
check("confirming before the upload says so", (await hit({ method: "POST", url: `/api/campaigns?id=${cid}&done=1`, token: "tok-asha" })).status === 409);
files.set(`u-asha/profile/${cid}.cito`, 4000);
check("someone else can't confirm it", (await hit({ method: "POST", url: `/api/campaigns?id=${cid}&done=1`, token: "tok-ravi" })).status === 404);
const d1 = await hit({ method: "POST", url: `/api/campaigns?id=${cid}&done=1`, token: "tok-asha" });
check("confirmed: version 1", d1.status === 200 && d1.json.version === 1);
let l = await hit({ token: "tok-asha" });
check("listed on the owner's profile, with its counts and name", l.json.mine.length === 1 && l.json.mine[0].name === "Zento lamps" && l.json.mine[0].counts.answers === 1200 && l.json.mine[0].from === "Asha K" && l.json.mine[0].localId === "c1", JSON.stringify(l.json));
check("the space used is reported", l.json.usedBytes === 4000 && l.json.maxBytes === MAX_PROFILE_BYTES);

console.log("\nsaving again replaces it");
clock += 3600e3;
const again = await save("tok-asha", "u-asha", { localId: "c1", name: "Zento lamps (AU)", bytes: 5000, counts: { prompts: 300, runs: 3, answers: 1800 } });
check("the same id", again.id === cid && tables.cloud_campaigns.length === 1);
l = await hit({ token: "tok-asha" });
check("version 2, new counts, name and size", l.json.mine[0].version === 2 && l.json.mine[0].counts.runs === 3 && l.json.mine[0].name === "Zento lamps (AU)" && l.json.mine[0].bytes === 5000);
await hit({ method: "POST", token: "tok-asha", body: { localId: "c1", name: "Half-saved", bytes: 7000 } });
check("a save that never uploads changes nothing shown", (await hit({ token: "tok-asha" })).json.mine[0].name === "Zento lamps (AU)");

console.log("\nopening it");
const o = await hit({ url: `/api/campaigns?id=${cid}`, token: "tok-asha" });
check("the owner opens it, on any computer", o.status === 200 && o.json.mine === true && /\/object\/sign\/shares\/u-asha\/profile\//.test(o.json.downloadUrl));
check("a stranger can't", (await hit({ url: `/api/campaigns?id=${cid}`, token: "tok-ravi" })).status === 404);
check("nor see it in their list", (await hit({ token: "tok-ravi" })).json.shared.length === 0);
check("a malformed id", (await hit({ url: "/api/campaigns?id=nope", token: "tok-asha" })).status === 400);

console.log("\nsharing with people");
check("only the owner sets the people", (await hit({ method: "PUT", url: `/api/campaigns?id=${cid}`, token: "tok-ravi", body: { emails: ["ravi@kovo.example"] } })).status === 404);
const bad = await hit({ method: "PUT", url: `/api/campaigns?id=${cid}`, token: "tok-asha", body: { emails: ["ravi@kovo.example", "not an email", "x@mailinator.com"] } });
check("bad addresses are named, nothing saved", bad.status === 400 && bad.json.bad.length === 2 && tables.campaign_people.length === 0, JSON.stringify(bad.json));
const pp = await hit({ method: "PUT", url: `/api/campaigns?id=${cid}`, token: "tok-asha", body: { emails: [" RAVI@kovo.example", "mei@lumen.example", "ravi@kovo.example", "asha@zento.example"] } });
check("lower-cased, de-duplicated, the owner left out", pp.status === 200 && pp.json.people.join(",") === "mei@lumen.example,ravi@kovo.example".split(",").sort().join(",") && pp.json.people.length === 2, JSON.stringify(pp.json));
const rl = await hit({ token: "tok-ravi" });
check("Ravi sees it under Shared with me, with who it's from", rl.json.shared.length === 1 && rl.json.shared[0].id === cid && rl.json.shared[0].from === "Asha K" && rl.json.mine.length === 0, JSON.stringify(rl.json));
check("and only the latest save's details", rl.json.shared[0].version === 2);
const ro = await hit({ url: `/api/campaigns?id=${cid}`, token: "tok-ravi" });
check("Ravi opens it, but isn't shown the people list", ro.status === 200 && ro.json.mine === false && ro.json.people === undefined && !!ro.json.downloadUrl);
check("the owner's list shows the people", (await hit({ token: "tok-asha" })).json.mine[0].people.length === 2);
check("Ravi can't delete it", (await hit({ method: "DELETE", url: `/api/campaigns?id=${cid}`, token: "tok-ravi" })).status === 404);
check("nor save over it", (await save("tok-ravi", "u-ravi", { localId: "c1", bytes: 10 })).id !== cid);
await hit({ method: "PUT", url: `/api/campaigns?id=${cid}`, token: "tok-asha", body: { emails: ["mei@lumen.example"] } });
check("removing someone takes it from their list", (await hit({ token: "tok-ravi" })).json.shared.length === 0 && (await hit({ url: `/api/campaigns?id=${cid}`, token: "tok-ravi" })).status === 404);
check("and Mei still has it", (await hit({ token: "tok-mei" })).json.shared.length === 1);
const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => `p${i}@team.example`);
check(`at most ${MAX_PEOPLE} people`, (await hit({ method: "PUT", url: `/api/campaigns?id=${cid}`, token: "tok-asha", body: { emails: many } })).status === 400);

console.log("\nlimits");
for (let i = 0; i < MAX_PROFILE_CAMPAIGNS - 1; i++) tables.cloud_campaigns.push({ id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, owner: "u-mei", local_id: `m${i}`, name: "x", bytes: 100, saved_at: new Date(clock).toISOString() });
check("the last campaign that fits", (await save("tok-mei", "u-mei", { localId: "last", bytes: 100 })).status === 200);
check(`at most ${MAX_PROFILE_CAMPAIGNS} campaigns a profile`, (await hit({ method: "POST", token: "tok-mei", body: { localId: "one-more", bytes: 100 } })).status === 429);
check("saving one already there still works at the limit", (await save("tok-mei", "u-mei", { localId: "last", bytes: 200 })).status === 200);
check("the space limit counts what's already saved", (await hit({ method: "POST", token: "tok-asha", body: { localId: "big", bytes: MAX_PROFILE_BYTES - 1000 } })).status === 413);

console.log("\nremoving from the profile");
const del = await hit({ method: "DELETE", url: `/api/campaigns?id=${cid}`, token: "tok-asha" });
check("the owner removes it: row, people and file go", del.status === 200 && !tables.cloud_campaigns.some((r) => r.id === cid) && !tables.campaign_people.some((r) => r.campaign === cid) && !files.has(`u-asha/profile/${cid}.cito`));
check("and it leaves Mei's list", (await hit({ token: "tok-mei" })).json.shared.length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
