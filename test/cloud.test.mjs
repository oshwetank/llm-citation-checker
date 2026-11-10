/*
 * cloud.test.mjs — the extension's account and sharing client (0.82.0),
 * against a stand-in server: sign in with a code, the session refreshed when
 * it runs out, share a file and open it by code, errors in plain words.
 */
import { makeCloud, cloudReady, normCode, CloudError } from "../src/lib/cloud.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const cfg = { apiBase: "https://api.example/", supabaseUrl: "https://sb.example", supabaseAnonKey: "anon" };
let clock = 1_000_000;
let stored = null;
const log = [];
const store = new Map();
let offline = false;
const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), arrayBuffer: async () => body });
let issued = 0;
const fetch = async (url, opts = {}) => {
  if (offline) throw new TypeError("Failed to fetch");
  const u = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
  log.push({ method, path: u.pathname + u.search, auth: (opts.headers || {}).authorization || "", apikey: (opts.headers || {}).apikey || "" });
  // 0.85.0: campaigns saved to the profile.
  if (u.pathname === "/api/campaigns" && method === "POST" && !u.searchParams.get("done")) return json(200, { id: "c-1", uploadUrl: "https://sb.example/storage/v1/object/upload/sign/shares/u1/profile/c-1.cito?token=t" });
  if (u.pathname.endsWith("/profile/c-1.cito") && method === "PUT") { store.set("c-1", opts.body); store.set("c-1-upsert", (opts.headers || {})["x-upsert"]); return json(200, {}); }
  if (u.pathname === "/api/campaigns" && method === "POST") return json(200, { ok: true, version: 3, savedAt: "2026-11-10T10:00:00.000Z" });
  if (u.pathname === "/api/campaigns" && method === "GET" && u.searchParams.get("id")) return json(200, { id: "c-1", name: "Zento", mine: false, downloadUrl: "https://sb.example/storage/v1/object/sign/shares/u1/profile/c-1.cito?token=d" });
  if (u.pathname.endsWith("/profile/c-1.cito")) return json(200, store.get("c-1"));
  if (u.pathname === "/api/campaigns" && method === "GET") return json(200, { mine: [{ id: "c-1" }], shared: [], usedBytes: 4 });
  if (u.pathname === "/api/campaigns" && method === "PUT") return json(200, { id: "c-1", people: body.emails });
  if (u.pathname === "/api/campaigns" && method === "DELETE") return json(200, { ok: true });
  if (u.pathname === "/auth/v1/otp") return body.email.includes("@") ? json(200, {}) : json(400, { msg: "Unable to validate email address: invalid format" });
  if (u.pathname === "/auth/v1/verify") return body.token === "123456" ? json(200, { access_token: `at${++issued}`, refresh_token: "rt1", expires_in: 3600, user: { id: "u1", email: body.email } }) : json(403, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
  if (u.pathname === "/auth/v1/token") return body.refresh_token === "rt1" ? json(200, { access_token: `at${++issued}`, refresh_token: "rt1", expires_in: 3600, user: { id: "u1", email: "asha@zento.example" } }) : json(400, { msg: "Invalid Refresh Token" });
  if (u.pathname === "/auth/v1/logout") return json(204, {});
  if (u.pathname === "/api/profile") return method === "POST" ? json(200, { display_name: body.display_name }) : json(200, { display_name: "Asha", email: "asha@zento.example" });
  if (u.pathname === "/api/share" && method === "POST" && !u.searchParams.get("done")) return json(200, { code: "ABCDEFGHJK", uploadUrl: "https://sb.example/storage/v1/object/upload/sign/shares/u1/ABCDEFGHJK.cito?token=t" });
  if (u.pathname.startsWith("/storage/v1/object/upload/sign/")) { store.set("ABCDEFGHJK", opts.body); return json(200, {}); }
  if (u.pathname === "/api/share" && method === "POST") return json(200, { ok: true });
  if (u.pathname === "/api/share" && method === "GET" && u.searchParams.get("code")) return u.searchParams.get("code") === "ABCDEFGHJK" ? json(200, { name: "Zento", from: "Asha", downloadUrl: "https://sb.example/storage/v1/object/sign/shares/u1/ABCDEFGHJK.cito?token=d" }) : json(404, { error: "That code doesn't open a campaign." });
  if (u.pathname.startsWith("/storage/v1/object/sign/")) return json(200, store.get("ABCDEFGHJK"));
  if (u.pathname === "/api/share" && method === "GET") return json(200, { shares: [{ code: "ABCDEFGHJK", name: "Zento" }] });
  if (u.pathname === "/api/share" && method === "DELETE") return json(200, { ok: true });
  if (u.pathname === "/api/subscribe") return json(200, { ok: true, token: "unsub-1" });
  return json(404, { error: "no route" });
};
const cloud = makeCloud(cfg, { fetch, now: () => clock, load: async () => stored, save: async (s) => { stored = s; } });
const err = async (f) => { try { await f(); return null; } catch (e) { return e; } };

console.log("\nswitched on only when configured");
check("empty config is off", !cloudReady({ apiBase: "", supabaseUrl: "", supabaseAnonKey: "" }));
check("full config is on", cloudReady(cfg));

console.log("\nsign in with an emailed code");
check("a code is asked for, with the public key", (await cloud.requestCode("asha@zento.example")).ok && log.at(-1).path === "/auth/v1/otp" && log.at(-1).apikey === "anon");
const bad = await err(() => cloud.verifyCode("asha@zento.example", "000000"));
check("a wrong code says so", bad instanceof CloudError && /expired or is invalid/.test(bad.message) && stored === null);
const s = await cloud.verifyCode("asha@zento.example", " 123 456 ");
check("the right code signs in (spaces forgiven)", s.access_token === "at1" && stored.user.email === "asha@zento.example" && stored.expires_at === clock + 3600e3);
check("still fresh: no refresh", (await cloud.session()).access_token === "at1" && !log.some((l) => l.path.startsWith("/auth/v1/token")));
clock += 3590e3;
check("near expiry it refreshes", (await cloud.session()).access_token === "at2" && log.some((l) => l.path.startsWith("/auth/v1/token")));

console.log("\nprofile");
await cloud.saveProfile("  Asha K  ");
check("the name is saved and kept with the session", stored.user.name === "Asha K" && log.at(-1).auth === "Bearer at2");

console.log("\nshare and open by code");
const file = new Uint8Array([0x1f, 0x8b, 1, 2, 3]).buffer;
const up = await cloud.shareUpload(file, { name: "Zento", counts: { answers: 3 } });
const order = log.slice(-3).map((l) => `${l.method} ${l.path.split("?")[0]}`);
check("code, upload straight to storage, confirm", up.code === "ABCDEFGHJK" && order.join(" | ") === "POST /api/share | PUT /storage/v1/object/upload/sign/shares/u1/ABCDEFGHJK.cito | POST /api/share", order.join(" | "));
check("the storage upload carries no sign-in token", log.at(-2).auth === "");
const got = await cloud.shareFetch("abcde-fghjk");
check("opened by code, typed loosely", got.meta.name === "Zento" && got.bytes === file);
check("a short code is caught before asking", /10 letters/.test((await err(() => cloud.shareFetch("abc"))).message));
check("an unknown code says so", /doesn't open a campaign/.test((await err(() => cloud.shareFetch("ZZZZZZZZZZ"))).message));
check("my shares", (await cloud.shareList()).length === 1);
check("stop sharing", (await cloud.shareRevoke("ABCDEFGHJK")).ok);

console.log("\nsaved to the profile (0.85.0)");
{
  const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const r = await cloud.profileSave(bytes, { localId: "local-1", name: "Zento", counts: { prompts: 3 } });
  const start = log.find((l) => l.path === "/api/campaigns" && l.method === "POST");
  check("asks for an address, signed in", !!start && /^Bearer at/.test(start.auth));
  check("uploads the bytes straight to storage, replacing the last save", store.get("c-1") === bytes && store.get("c-1-upsert") === "true");
  check("confirms, and returns the version", r.id === "c-1" && r.version === 3 && !!r.savedAt && log.some((l) => l.path === "/api/campaigns?id=c-1&done=1"));
  check("the list", (await cloud.profileList()).mine[0].id === "c-1");
  const got = await cloud.profileFetch("c-1");
  check("opens the latest copy", got.meta.name === "Zento" && got.bytes === bytes);
  check("sets the people", (await cloud.profilePeople("c-1", ["ravi@kovo.example"])).people[0] === "ravi@kovo.example" && log.at(-1).method === "PUT");
  check("removes it", (await cloud.profileRemove("c-1")).ok && log.at(-1).method === "DELETE");
}

console.log("\nupdates");
check("subscribe needs no sign-in", (await cloud.subscribe("asha@zento.example")).token === "unsub-1" && log.at(-1).auth === "");

console.log("\nwhen things go wrong");
offline = true;
check("offline, in plain words", /Couldn't reach the server/.test((await err(() => cloud.shareList())).message));
offline = false;
stored = { ...stored, refresh_token: "revoked", expires_at: 0 };
check("a dead session signs out", (await cloud.session()) === null && stored === null);
check("signed out, sharing says where to sign in", /About → Account/.test((await err(() => cloud.shareList())).message));
await cloud.verifyCode("asha@zento.example", "123456");
await cloud.signOut();
check("sign out forgets the session", stored === null && log.at(-1).path === "/auth/v1/logout");
check("codes normalised", normCode(" ab-cd efgh jk ") === "ABCDEFGHJK");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
