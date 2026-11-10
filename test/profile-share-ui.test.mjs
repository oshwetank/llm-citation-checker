/*
 * profile-share-ui.test.mjs — a campaign saved to a profile and shared with
 * named people, end to end (0.85.0).
 *
 * Asked: people run prompts on their own systems and "store that particular
 * data … share it and make it visible across a group of people", on
 * "multiple devices, multiple accounts". Two browsers, two people. Asha
 * seeds a campaign from fixture answers (made-up brands), signs in with an
 * emailed code, saves it to her profile from ⋯ → Share campaign…, and adds
 * Ravi's email. Ravi, in a fresh browser, signs in and opens it from About →
 * Account → Shared with you. Asha saves again; Ravi updates his copy, which
 * replaces it rather than adding a second one.
 *
 * The server is the real one (server/api/*.js), over HTTP on this computer,
 * with Supabase stood in for in memory: its auth (codes and tokens), its
 * tables and its file storage. The extension is pointed at it with the
 * tests-only cloud-test-config message, which takes local addresses only.
 */
import http from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deps } from "../server/lib/deps.js";
import campaignsApi from "../server/api/campaigns.js";
import profileApi from "../server/api/profile.js";
import shareApi from "../server/api/share.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const FIXDIR = path.join(HERE, "fixtures");
const BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-profile-share-test";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
    try { pw = req(c); break; } catch (_) { /* next */ }
  }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log(`\nprofile-share-ui: CANNOT RUN — playwright is not installed. ${err.message}`);
  process.exit(1);
}

/* ---------- Supabase, in memory ---------- */
const tables = { profiles: [], subscribers: [], shared_campaigns: [], cloud_campaigns: [], campaign_people: [] };
const files = new Map();
const tokens = new Map(); // access token → {id, email}
const usersByEmail = new Map();
let tokenN = 0;
const userFor = (email) => {
  const e = email.toLowerCase();
  if (!usersByEmail.has(e)) usersByEmail.set(e, { id: `00000000-0000-4000-a000-${String(usersByEmail.size + 1).padStart(12, "0")}`, email: e });
  return usersByEmail.get(e);
};
const issue = (u) => { const t = `at-${++tokenN}`; tokens.set(t, u); return { access_token: t, refresh_token: `rt-${u.email}`, expires_in: 3600, user: { id: u.id, email: u.email } }; };

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

// What the server's handlers reach (their deps.fetch): auth/v1/user, the
// tables, and the storage signing calls. In process: no network.
deps.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  if (u.pathname === "/auth/v1/user") { const t = (headers.authorization || "").replace("Bearer ", ""); return tokens.has(t) ? reply(200, tokens.get(t)) : reply(401, { msg: "bad jwt" }); }
  if (headers.authorization !== "Bearer svc") return reply(401, { message: "service key needed" });
  const rm = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
  if (rm) {
    const qs = u.searchParams;
    const body = opts.body ? JSON.parse(opts.body) : null;
    const t = rm[1];
    if (method === "GET") return reply(200, tables[t].filter((r) => matches(r, qs)));
    if (method === "POST") {
      const key = qs.get("on_conflict");
      for (const b of Array.isArray(body) ? body : [body]) {
        const i = key ? tables[t].findIndex((r) => r[key] === b[key]) : -1;
        if (i >= 0) tables[t][i] = { ...tables[t][i], ...b }; else tables[t].push({ ...b });
      }
      return reply(201);
    }
    if (method === "PATCH") { const hit = tables[t].filter((r) => matches(r, qs)); hit.forEach((r) => Object.assign(r, body)); return reply(200, hit); }
    if (method === "DELETE") { tables[t] = tables[t].filter((r) => !matches(r, qs)); return reply(204); }
  }
  const up = /^\/storage\/v1\/object\/upload\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (up) return reply(200, { url: `/object/upload/sign/shares/${up[1]}?token=up` });
  const sg = /^\/storage\/v1\/object\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (sg) return files.has(sg[1]) ? reply(200, { signedURL: `/object/sign/shares/${sg[1]}?token=dl` }) : reply(400, { message: "Object not found" });
  const del = /^\/storage\/v1\/object\/shares\/(.+)$/.exec(u.pathname);
  if (del && method === "DELETE") { files.delete(del[1]); return reply(200, {}); }
  return reply(404, { message: `no route ${method} ${u.pathname}` });
};

/* ---------- the HTTP server the extension talks to ---------- */
const apiRoutes = { "/api/campaigns": campaignsApi, "/api/profile": profileApi, "/api/share": shareApi };
const hits = [];
const corsOpen = (req, res) => {
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "apikey, authorization, content-type, x-upsert");
};
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  hits.push(`${req.method} ${u.pathname}`);
  if (apiRoutes[u.pathname]) return apiRoutes[u.pathname](req, res);
  corsOpen(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  const json = (status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (u.pathname === "/auth/v1/otp") { await readBody(req); return json(200, {}); }
  if (u.pathname === "/auth/v1/verify") {
    const b = JSON.parse((await readBody(req)).toString() || "{}");
    return b.token === "123456" ? json(200, issue(userFor(b.email))) : json(403, { msg: "Token has expired or is invalid" });
  }
  if (u.pathname === "/auth/v1/token") { const b = JSON.parse((await readBody(req)).toString() || "{}"); return json(200, issue(userFor(String(b.refresh_token).replace(/^rt-/, "")))); }
  if (u.pathname === "/auth/v1/logout") { await readBody(req); return json(204, {}); }
  const put = /^\/storage\/v1\/object\/upload\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (put && req.method === "PUT") {
    const key = decodeURIComponent(put[1]);
    if (files.has(key) && req.headers["x-upsert"] !== "true") return json(409, { message: "The resource already exists" });
    files.set(key, await readBody(req));
    return json(200, { Key: key });
  }
  const get = /^\/storage\/v1\/object\/sign\/shares\/(.+)$/.exec(u.pathname);
  if (get && req.method === "GET") {
    const key = decodeURIComponent(get[1]);
    if (!files.has(key)) return json(404, { message: "not found" });
    res.setHeader("content-type", "application/octet-stream");
    return res.end(files.get(key));
  }
  json(404, { message: `no route ${req.method} ${u.pathname}` });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HOST = `http://127.0.0.1:${server.address().port}`;
deps.env = { SUPABASE_URL: HOST, SUPABASE_SERVICE_ROLE_KEY: "svc" };

/* ---------- the browsers ---------- */
const SEEDS = [["chatgpt-phone-under.txt", "best smartphone under 50000"], ["chatgpt-tv.txt", "best tv to buy"]];

async function open(dir) {
  rmSync(dir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  });
  await context.route(/^https:\/\/chatgpt\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<body><div id="prompt-textarea" contenteditable="true"></div><button id="composer-submit-button">send</button></body>` }));
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(800);
  const ask = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  await ask({ type: "demo-clear" });
  const requests = [];
  context.on("request", (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url()) && !/chatgpt\.com/.test(r.url())) requests.push(r.url()); });
  return { context, page, ask, requests };
}

const goAccount = async (page) => {
  await page.evaluate(() => document.querySelector('[data-tab="about"]')?.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => [...document.querySelectorAll(".ab-nav-btn, .ab-more-row")].find((b) => b.textContent.includes("Account"))?.click());
};
const openCampaigns = async (page, name) => {
  await page.evaluate(() => document.querySelector('[data-tab="loader"]')?.click());
  await page.waitForFunction((n) => [...document.querySelectorAll(".geo-switcher .geo-chip")].some((b) => b.textContent.startsWith(n)), name, { timeout: 15000 }).catch(() => {});
  await page.evaluate((n) => { const b = [...document.querySelectorAll(".geo-switcher .geo-chip")].find((x) => x.textContent.startsWith(n)); if (b && !b.classList.contains("active")) b.click(); }, name);
  await page.waitForFunction((n) => document.getElementById("cpName")?.textContent === n, name, { timeout: 15000 }).catch(() => {});
};
const text = (page, id) => page.evaluate((id) => document.getElementById(id)?.textContent || "", id);
const decode = (buf) => JSON.parse(gunzipSync(buf).toString("utf8"));

let A, B;
let cid = null;
let boardA = null;
try {
  A = await open(`${BASE}-a`);

  console.log("\nsigned out, nothing changes");
  await goAccount(A.page);
  await A.page.waitForSelector("#acOff", { timeout: 5000 }).catch(() => {});
  check("before accounts are set up, Account says they're off", /aren't switched on/.test(await text(A.page, "acOff")));
  check("and nothing was sent anywhere", A.requests.length === 0, A.requests.join(", "));
  check("the test address is refused unless it's this computer", !(await A.ask({ type: "cloud-test-config", config: { apiBase: "https://evil.example", supabaseUrl: "https://evil.example" } })).ok);
  check("a local stand-in is taken", (await A.ask({ type: "cloud-test-config", config: { apiBase: HOST, supabaseUrl: HOST } })).ok);

  for (const [f, prompt] of SEEDS) {
    await A.ask({ type: "raw-conversation", payload: { raw: readFileSync(path.join(FIXDIR, f), "utf8"), reqBody: JSON.stringify({ messages: [{ author: { role: "user" }, content: { parts: [prompt] } }] }), pageUrl: "https://chatgpt.com/", capturedAt: Date.now() } });
  }
  const seeded = await A.page.evaluate(async (texts) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const st = (s, m) => db.transaction(s, m).objectStore(s);
    const all = (s) => new Promise((res) => { const r = st(s, "readonly").getAll(); r.onsuccess = () => res(r.result); });
    const put = (s, v) => new Promise((res) => { const r = st(s, "readwrite").put(v); r.onsuccess = () => res(); });
    const recs = (await all("derived")).filter((r) => r.userPrompt);
    const counts = new Map();
    recs.forEach((r) => (r.brandMentions || []).forEach((m) => counts.set(m.brand, (counts.get(m.brand) || 0) + (m.count || 0))));
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const profileId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const ids = {};
    for (const t of texts) { ids[t] = crypto.randomUUID(); await put("trackedPrompts", { id: ids[t], profileId, text: t, tags: ["phones"], active: true, createdAt: Date.now() - 1e6 + Object.keys(ids).length }); }
    await put("profiles", { id: profileId, name: "Zento Phones", brand: { name: ranked[0], url: "" }, competitors: ranked.slice(1, 3).map((n) => ({ name: n, url: "" })), engines: ["chatgpt"], locked: true, createdAt: Date.now() - 1e6, lastRunAt: Date.now() - 5e5, deletedAt: null });
    await put("geoRuns", { id: runId, profileId, startedAt: Date.now() - 6e5, finishedAt: Date.now() - 5e5, status: "done", engines: ["chatgpt"], promptIds: Object.values(ids), expected: 2, captured: 2, failed: 0, reasons: {} });
    const raws = await all("raw");
    for (const r of recs) {
      const geo = { profileId, runId, promptId: ids[r.userPrompt], tags: ["phones"] };
      await put("derived", { ...r, geo });
      const raw = raws.find((x) => x.captureId === r.captureId);
      if (raw) await put("raw", { ...raw, geo });
    }
    return { profileId };
  }, SEEDS.map(([, p]) => p));
  boardA = await A.ask({ type: "campaign-board", profileId: seeded.profileId });

  console.log("\nsigning in with an emailed code");
  await A.page.reload();
  await A.page.waitForTimeout(600);
  await goAccount(A.page);
  await A.page.waitForSelector("#acEmail", { timeout: 8000 }).catch(() => {});
  check("Account asks for an email", await A.page.evaluate(() => !!document.getElementById("acEmail")));
  await A.page.fill("#acEmail", "asha@zento.example");
  await A.page.click("#acSend");
  await A.page.waitForSelector("#acCode:not([hidden])", { timeout: 5000 }).catch(() => {});
  await A.page.fill("#acCode", "123456");
  await A.page.click("#acVerify");
  await A.page.waitForSelector("#acWho", { timeout: 8000 }).catch(() => {});
  check("signed in, as Asha", (await text(A.page, "acWho")) === "asha@zento.example");
  await A.page.fill("#acName", "Asha K");
  await A.page.click("#acNameSave");
  await A.page.waitForFunction(() => /Saved/.test(document.getElementById("acMsg")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  await A.page.waitForFunction(() => /None yet/.test(document.getElementById("acMine")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("nothing on her profile yet", /None yet/.test(await text(A.page, "acMine")));

  console.log("\nsaving to the profile");
  await openCampaigns(A.page, "Zento Phones");
  await A.page.evaluate(() => document.querySelector(".cp-more")?.click());
  await A.page.evaluate(() => document.getElementById("cpShareCampaign").click());
  await A.page.waitForSelector("#shProfileSave", { timeout: 8000 }).catch(() => {});
  check("Share campaign… offers Save to my profile", (await text(A.page, "shProfileSave")) === "Save to my profile");
  check("people can't be added before it's saved", await A.page.evaluate(() => document.getElementById("shPeople").disabled && document.getElementById("shAutoSave").disabled));
  await A.page.click("#shProfileSave");
  await A.page.waitForFunction(() => /version 1/.test(document.getElementById("shStatus")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  check("saved: version 1", /Saved to your profile · version 1/.test(await text(A.page, "shStatus")), await text(A.page, "shStatus"));
  cid = tables.cloud_campaigns[0] && tables.cloud_campaigns[0].id;
  const owner = usersByEmail.get("asha@zento.example").id;
  const fileKey = `${owner}/profile/${cid}.cito`;
  check("the file is on the server, under her profile", !!cid && files.has(fileKey), [...files.keys()].join(", "));
  const sent = decode(files.get(fileKey));
  check("with the answers, prompts and run", sent.records.length === 2 && sent.prompts.length === 2 && sent.runs.length === 1);
  check("but not the raw captures, so it stays small", sent.raws.length === 0 && sent.counts.raws === 0);
  check("and no profile link inside it", !("cloud" in sent.profile));
  check("Save again, now", (await text(A.page, "shProfileSave")) === "Save again");
  await A.page.click("#shAutoSave");
  await A.page.waitForFunction(() => /after every run/.test(document.getElementById("shStatus")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("Save after every run turns on", (await A.ask({ type: "geo-profile-list" })).profiles.find((p) => p.id === seeded.profileId).cloud.autoSave === true);
  await A.page.fill("#shPeople", "Ravi@Kovo.example, not-an-email");
  await A.page.click("#shPeopleSave");
  await A.page.waitForFunction(() => /look like email/.test(document.getElementById("shStatus")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("a bad address is named, and nothing saved", /not-an-email/.test(await text(A.page, "shStatus")) && tables.campaign_people.length === 0);
  await A.page.fill("#shPeople", "Ravi@Kovo.example");
  await A.page.click("#shPeopleSave");
  await A.page.waitForFunction(() => /Shared with 1 person/.test(document.getElementById("shStatus")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("shared with Ravi", /Shared with 1 person/.test(await text(A.page, "shStatus")) && tables.campaign_people[0].email === "ravi@kovo.example");
  const linked = (await A.ask({ type: "geo-profile-list" })).profiles.find((p) => p.id === seeded.profileId);
  await A.ask({ type: "geo-profile-save", profile: { ...linked, competitors: [...linked.competitors, { name: "Extra Co", url: "" }], cloud: null } });
  check("editing the campaign keeps its link to the profile", (await A.ask({ type: "geo-profile-list" })).profiles.find((p) => p.id === seeded.profileId).cloud.id === cid);

  B = await open(`${BASE}-b`);
  await B.ask({ type: "cloud-test-config", config: { apiBase: HOST, supabaseUrl: HOST } });

  console.log("\nanother person, another computer");
  check("Ravi signs in with his code", (await B.ask({ type: "cloud-request-code", email: "ravi@kovo.example" })).ok && (await B.ask({ type: "cloud-verify", email: "ravi@kovo.example", code: "123456" })).ok);
  await B.page.reload();
  await B.page.waitForTimeout(600);
  await goAccount(B.page);
  await B.page.waitForFunction(() => /Zento Phones/.test(document.getElementById("acSharedWithMe")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  const sharedTxt = await text(B.page, "acSharedWithMe");
  check("Shared with you lists it, from Asha K, version 1", /Zento Phones/.test(sharedTxt) && /from Asha K/.test(sharedTxt) && /version 1/.test(sharedTxt), sharedTxt);
  check("his own profile is empty", /None yet/.test(await text(B.page, "acMine")));
  await B.page.click(`#acSharedWithMe [data-open="${cid}"]`);
  await B.page.waitForFunction(() => document.getElementById("cpName")?.textContent === "Zento Phones", null, { timeout: 10000 }).catch(() => {});
  check("Open here puts it on screen", (await text(B.page, "cpName")) === "Zento Phones");
  let listB = (await B.ask({ type: "geo-profile-list" })).profiles;
  const copy = listB.find((p) => p.name === "Zento Phones");
  check("as a copy, linked to Asha's save", copy && copy.cloud && copy.cloud.copy && !copy.cloud.mine && copy.cloud.id === cid && copy.cloud.from === "Asha K", JSON.stringify(copy && copy.cloud));
  const boardB = await B.ask({ type: "campaign-board", profileId: copy.id });
  check("the same answers as Asha's", boardB.ok && boardB.answers === boardA.answers, `${boardB.answers} vs ${boardA.answers}`);
  check("the campaign says whose copy it is", /Asha K shared this with you · version 1/.test(await text(B.page, "cpCopyNote")));

  console.log("\nAsha saves again; Ravi updates");
  const again = await A.ask({ type: "campaign-profile-save", profileId: seeded.profileId });
  check("version 2", again.ok && again.link.version === 2);
  await goAccount(B.page);
  await B.page.waitForFunction(() => /Update copy/.test(document.getElementById("acSharedWithMe")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
  check("Ravi sees Update copy", /Update copy/.test(await text(B.page, "acSharedWithMe")));
  await B.page.click(`#acSharedWithMe [data-open="${cid}"]`);
  await B.page.waitForFunction(() => /Up to date here/.test(document.getElementById("acSharedWithMe")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
  listB = (await B.ask({ type: "geo-profile-list" })).profiles;
  const copies = listB.filter((p) => p.cloud && p.cloud.id === cid);
  check("the copy is replaced, not doubled", copies.length === 1 && copies[0].cloud.version === 2, JSON.stringify(listB.map((p) => [p.name, p.cloud && p.cloud.version])));
  check("with Asha's later edit in it", copies[0].competitors.some((c) => c.name === "Extra Co"));
  check("and the old copy's answers are gone, not left behind", (await B.ask({ type: "campaign-board", profileId: copies[0].id })).answers === boardA.answers);
  const strays = await B.page.evaluate(async (ids) => {
    const db = await new Promise((res) => { const r = indexedDB.open("lcfc"); r.onsuccess = () => res(r.result); });
    return new Promise((res) => { const r = db.transaction("derived").objectStore("derived").getAll(); r.onsuccess = () => res(r.result.filter((x) => x.geo && x.geo.profileId && !ids.includes(x.geo.profileId)).length); });
  }, listB.map((p) => p.id));
  check("no answers left pointing at a removed copy", strays === 0, strays);
  check("Ravi can't save over Asha's campaign: a save makes his own", (await B.ask({ type: "campaign-profile-save", profileId: copies[0].id })).link.id !== cid);

  console.log("\nauto-save after a run");
  const before = tables.cloud_campaigns.find((r) => r.id === cid).version;
  await A.ask({ type: "profile-autosave-test", profileId: seeded.profileId });
  check("a finished run saves it again, when that's on", tables.cloud_campaigns.find((r) => r.id === cid).version === before + 1);
  await A.ask({ type: "campaign-profile-autosave", profileId: seeded.profileId, on: false });
  await A.ask({ type: "profile-autosave-test", profileId: seeded.profileId });
  check("and doesn't when it's off", tables.cloud_campaigns.find((r) => r.id === cid).version === before + 1);

  console.log("\nremoving it from the profile");
  await A.ask({ type: "campaign-profile-remove", id: cid });
  check("gone from the server, file and sharing", !tables.cloud_campaigns.some((r) => r.id === cid) && !tables.campaign_people.some((r) => r.campaign === cid) && ![...files.keys()].some((k) => k.includes(cid)));
  check("still on Asha's computer, unlinked", (await A.ask({ type: "geo-profile-list" })).profiles.find((p) => p.id === seeded.profileId).cloud === null);
  check("Ravi's list no longer has it", ((await B.ask({ type: "cloud-campaigns" })).shared || []).length === 0);

  console.log("\nsigning out");
  await B.ask({ type: "cloud-sign-out" });
  await goAccount(B.page);
  await B.page.waitForSelector("#acEmail", { timeout: 5000 }).catch(() => {});
  check("Account asks for an email again", await B.page.evaluate(() => !!document.getElementById("acEmail")));
  check("his copy stays on his computer", (await B.ask({ type: "geo-profile-list" })).profiles.some((p) => p.name.startsWith("Zento Phones")));
  check("only this computer's stand-in was ever called", [...A.requests, ...B.requests].every((u) => u.startsWith(HOST)), [...A.requests, ...B.requests].filter((u) => !u.startsWith(HOST)).join(", "));
} finally {
  if (A) await A.context.close();
  if (B) await B.context.close();
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
