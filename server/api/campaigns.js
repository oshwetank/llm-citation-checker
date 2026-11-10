/*
 * /api/campaigns — campaigns saved to a person's profile, and the people
 * they're shared with (0.85.0). Signed in, all of it.
 *
 * Asked: people run prompts on their own computers, and "store that
 * particular data … share it and make it visible across a group of people",
 * on "multiple devices, multiple accounts". So a campaign is saved from the
 * computer that runs it, and opened anywhere its owner signs in, or by
 * anyone whose email the owner added. Saving again replaces the file, so
 * everyone opens the latest copy. Prompts still run in each person's own
 * browser: nothing here runs them.
 *
 *   POST {localId, name, bytes, counts}   → {id, uploadUrl}
 *        the extension PUTs the .cito file to uploadUrl (straight into
 *        storage, replacing the last save), then:
 *   POST ?id=X&done=1                     → {ok, version, savedAt}
 *   GET                                   → {mine, shared, usedBytes, maxBytes}
 *   GET ?id=X                             → {…, downloadUrl}: owner or a person on it
 *   PUT ?id=X {emails}                    → {people}: replaces who it's shared with (owner)
 *   DELETE ?id=X                          → {ok}: owner; the file and the sharing go
 *
 * The 0.82.0 share codes (/api/share) are separate and unchanged: a code is
 * a one-off copy for anyone holding it; this is a living copy for named people.
 */
import { handler, send, readJson, queryOf, signedInUser } from "../lib/http.js";
import { rest, signedUploadUrl, signedDownloadUrl, removeObject } from "../lib/supabase.js";
import { checkEmail } from "../lib/emailCheck.js";
import { deps } from "../lib/deps.js";

export const MAX_CAMPAIGN_BYTES = 25 * 1024 * 1024;
// Supabase's free plan stores 1 GB in all. Saved copies leave the raw
// captures out (campaignBundle includeRaw:false): measured on the fixture
// answers that is ~3.5 KB an answer packed, so a run of 300 prompts on four
// engines is ~4 MB and of 1,000 prompts ~14 MB. A campaign over 25 MB is
// saved with its latest runs that fit. 60 MB a person keeps the free plan
// enough for the extension's users today; past that, Supabase Pro.
export const MAX_PROFILE_BYTES = 60 * 1024 * 1024;
export const MAX_PROFILE_CAMPAIGNS = 20;
export const MAX_PEOPLE = 25;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pathOf = (row) => `${row.owner}/profile/${row.id}.cito`;
const iso = (ms) => new Date(ms).toISOString();
const COLS = "id,local_id,name,bytes,counts,from_name,version,saved_at,created_at";

async function byId(id) {
  const rows = await rest("cloud_campaigns", `id=eq.${id}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function peopleOf(id) {
  const rows = await rest("campaign_people", `campaign=eq.${id}&select=email&order=email.asc`);
  return (Array.isArray(rows) ? rows : []).map((r) => r.email);
}
const view = (row, extra = {}) => ({
  id: row.id, localId: row.local_id, name: row.name, bytes: row.bytes, counts: row.counts || null,
  from: row.from_name || "", version: row.version || 0, savedAt: row.saved_at || null, createdAt: row.created_at || null, ...extra,
});

export default handler("GET, POST, PUT, DELETE", async (req, res) => {
  const user = await signedInUser(req);
  if (!user) return send(res, 401, { error: "Sign in first." });
  const q = queryOf(req);
  const id = q.id ? String(q.id).toLowerCase() : "";
  if (id && !ID_RE.test(id)) return send(res, 400, { error: "That isn't a saved campaign." });
  const email = String(user.email || "").toLowerCase();
  const now = deps.now();

  if (req.method === "POST" && id && q.done) {
    const row = await byId(id);
    if (!row || row.owner !== user.id) return send(res, 404, { error: "No such campaign on your profile." });
    try { await signedDownloadUrl(pathOf(row), 30); } catch (_) { return send(res, 409, { error: "The file hasn't arrived yet." }); }
    const next = { version: (row.version || 0) + 1, saved_at: iso(now), bytes: row.pending_bytes || row.bytes, counts: row.pending_counts || row.counts, name: row.pending_name || row.name };
    await rest("cloud_campaigns", `id=eq.${id}`, { method: "PATCH", body: { ...next, pending_bytes: null, pending_counts: null, pending_name: null } });
    return send(res, 200, { ok: true, id, version: next.version, savedAt: next.saved_at });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const localId = String(body.localId || "").slice(0, 100);
    if (!localId) return send(res, 400, { error: "Which campaign? (no localId)" });
    const bytes = Number(body.bytes);
    if (!(bytes > 0)) return send(res, 400, { error: "The file is empty." });
    if (bytes > MAX_CAMPAIGN_BYTES) return send(res, 413, { error: `A saved campaign can be up to ${MAX_CAMPAIGN_BYTES / 1048576} MB.` });
    const name = String(body.name || "Campaign").replace(/[\u0000-\u001f]/g, "").slice(0, 120);
    const counts = body.counts && typeof body.counts === "object" ? { prompts: +body.counts.prompts || 0, runs: +body.counts.runs || 0, answers: +body.counts.answers || 0 } : null;
    const mine = await rest("cloud_campaigns", `owner=eq.${user.id}&select=id,local_id,bytes`);
    const list = Array.isArray(mine) ? mine : [];
    let row = list.find((r) => r.local_id === localId);
    const others = list.filter((r) => r !== row).reduce((s, r) => s + (+r.bytes || 0), 0);
    if (!row && list.length >= MAX_PROFILE_CAMPAIGNS) return send(res, 429, { error: `Your profile holds up to ${MAX_PROFILE_CAMPAIGNS} campaigns. Remove one first (About → Account).` });
    if (others + bytes > MAX_PROFILE_BYTES) return send(res, 413, { error: `Your profile has room for ${MAX_PROFILE_BYTES / 1048576} MB of campaigns, and this would go over. Remove a campaign from your profile first.` });
    const prof = await rest("profiles", `id=eq.${user.id}&select=display_name`);
    const from = (Array.isArray(prof) && prof[0] && prof[0].display_name) || "";
    if (!row) {
      row = { id: deps.randomUUID(), owner: user.id, local_id: localId, name, bytes: 0, counts, from_name: from, version: 0, saved_at: null, created_at: iso(now), pending_bytes: bytes, pending_counts: counts, pending_name: name };
      await rest("cloud_campaigns", "", { method: "POST", prefer: "return=minimal", body: row });
    } else {
      row = { ...row, owner: user.id };
      await rest("cloud_campaigns", `id=eq.${row.id}`, { method: "PATCH", body: { from_name: from, pending_bytes: bytes, pending_counts: counts, pending_name: name } });
    }
    // Replaces the last save: the file at this path is overwritten.
    const uploadUrl = await signedUploadUrl(pathOf(row), { upsert: true });
    return send(res, 200, { id: row.id, uploadUrl });
  }

  if (req.method === "GET" && !id) {
    const mineRows = await rest("cloud_campaigns", `owner=eq.${user.id}&saved_at=not.is.null&order=saved_at.desc&select=${COLS}`);
    const mine = [];
    for (const r of Array.isArray(mineRows) ? mineRows : []) mine.push(view(r, { people: await peopleOf(r.id) }));
    const access = email ? await rest("campaign_people", `email=eq.${encodeURIComponent(email)}&select=campaign`) : [];
    const ids = (Array.isArray(access) ? access : []).map((a) => a.campaign).filter((x) => ID_RE.test(String(x)));
    let shared = [];
    if (ids.length) {
      const rows = await rest("cloud_campaigns", `id=in.(${ids.join(",")})&saved_at=not.is.null&order=saved_at.desc&select=${COLS},owner`);
      shared = (Array.isArray(rows) ? rows : []).filter((r) => r.owner !== user.id).map((r) => view(r));
    }
    const usedBytes = mine.reduce((s, r) => s + (+r.bytes || 0), 0);
    return send(res, 200, { mine, shared, usedBytes, maxBytes: MAX_PROFILE_BYTES, maxCampaigns: MAX_PROFILE_CAMPAIGNS });
  }

  const row = id ? await byId(id) : null;
  const isOwner = !!row && row.owner === user.id;

  if (req.method === "GET") {
    const people = row ? await peopleOf(row.id) : [];
    if (!row || !row.saved_at || !(isOwner || (email && people.includes(email)))) return send(res, 404, { error: "That campaign isn't on your profile or shared with you." });
    const downloadUrl = await signedDownloadUrl(pathOf(row));
    return send(res, 200, view(row, { mine: isOwner, ...(isOwner ? { people } : {}), downloadUrl }));
  }

  if (!isOwner) return send(res, 404, { error: "No such campaign on your profile." });

  if (req.method === "PUT") {
    const body = await readJson(req);
    const raw = Array.isArray(body.emails) ? body.emails : [];
    const bad = [];
    const emails = [];
    for (const e of raw) {
      const c = checkEmail(e);
      if (!c.ok) { bad.push(String(e).slice(0, 80)); continue; }
      if (c.email !== email && !emails.includes(c.email)) emails.push(c.email);
    }
    if (bad.length) return send(res, 400, { error: `These don't look like email addresses: ${bad.join(", ")}`, bad });
    emails.sort();
    if (emails.length > MAX_PEOPLE) return send(res, 400, { error: `A campaign can be shared with up to ${MAX_PEOPLE} people.` });
    await rest("campaign_people", `campaign=eq.${row.id}`, { method: "DELETE" });
    if (emails.length) await rest("campaign_people", "", { method: "POST", prefer: "return=minimal", body: emails.map((e) => ({ campaign: row.id, email: e, added_at: iso(now) })) });
    return send(res, 200, { id: row.id, people: emails });
  }

  // DELETE
  await rest("campaign_people", `campaign=eq.${row.id}`, { method: "DELETE" });
  await rest("cloud_campaigns", `id=eq.${row.id}`, { method: "DELETE" });
  await removeObject(pathOf(row));
  send(res, 200, { ok: true });
});
