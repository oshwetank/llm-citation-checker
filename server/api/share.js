/*
 * /api/share — campaigns shared by code (0.82.0). Signed in, all of it.
 *
 *   POST {name, bytes, counts}       → {code, uploadUrl, expiresAt}
 *        the extension PUTs the .cito file to uploadUrl (straight into
 *        storage: a function takes at most 4.5 MB, a campaign can be 25)
 *   POST ?code=X&done=1              → {ok}: the file arrived, the code works
 *   GET  ?code=X                     → {name, counts, from, downloadUrl}
 *   GET                              → {shares}: what I've shared
 *   DELETE ?code=X                   → {ok}: stop sharing (owner only)
 *
 * Codes are 10 characters from 32 that can't be misread (about 50 bits),
 * expire after 90 days, and need a signed-in person to open.
 */
import { handler, send, readJson, queryOf, signedInUser } from "../lib/http.js";
import { rest, signedUploadUrl, signedDownloadUrl, removeObject } from "../lib/supabase.js";
import { deps } from "../lib/deps.js";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MAX_SHARE_BYTES = 25 * 1024 * 1024;
export const MAX_LIVE_SHARES = 50;
export const SHARE_DAYS = 90;
const CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

export function newCode() {
  let s = "";
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[deps.randomInt(CODE_ALPHABET.length)];
  return s;
}
const pathOf = (row) => `${row.owner}/${row.code}.cito`;
const iso = (ms) => new Date(ms).toISOString();
const live = (row, now) => row && !row.revoked_at && row.ready && (!row.expires_at || Date.parse(row.expires_at) > now);

async function byCode(code) {
  const rows = await rest("shared_campaigns", `code=eq.${code}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export default handler("GET, POST, DELETE", async (req, res) => {
  const user = await signedInUser(req);
  if (!user) return send(res, 401, { error: "Sign in first." });
  const q = queryOf(req);
  const code = q.code ? String(q.code).toUpperCase() : "";
  if (code && !CODE_RE.test(code)) return send(res, 400, { error: "That code doesn't look right." });
  const now = deps.now();

  if (req.method === "POST" && code && q.done) {
    const row = await byCode(code);
    if (!row || row.owner !== user.id) return send(res, 404, { error: "No such share." });
    try { await signedDownloadUrl(pathOf(row), 30); } catch (_) { return send(res, 409, { error: "The file hasn't arrived yet." }); }
    await rest("shared_campaigns", `code=eq.${code}`, { method: "PATCH", body: { ready: true } });
    return send(res, 200, { ok: true, code });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const bytes = Number(body.bytes);
    if (!(bytes > 0)) return send(res, 400, { error: "The file is empty." });
    if (bytes > MAX_SHARE_BYTES) return send(res, 413, { error: `Campaigns up to ${MAX_SHARE_BYTES / 1048576} MB can be shared. Share it without the raw captures, or as a file.` });
    const mine = await rest("shared_campaigns", `owner=eq.${user.id}&revoked_at=is.null&expires_at=gt.${iso(now)}&select=code`);
    if (Array.isArray(mine) && mine.length >= MAX_LIVE_SHARES) return send(res, 429, { error: `You have ${MAX_LIVE_SHARES} campaigns shared. Stop sharing one first (About → Account).` });
    const counts = body.counts && typeof body.counts === "object" ? { prompts: +body.counts.prompts || 0, runs: +body.counts.runs || 0, answers: +body.counts.answers || 0 } : null;
    const profile = await rest("profiles", `id=eq.${user.id}&select=display_name`);
    const from = (Array.isArray(profile) && profile[0] && profile[0].display_name) || "";
    const row = { code: newCode(), owner: user.id, name: String(body.name || "Campaign").slice(0, 120), bytes, counts, from_name: from, ready: false, created_at: iso(now), expires_at: iso(now + SHARE_DAYS * 864e5) };
    await rest("shared_campaigns", "", { method: "POST", prefer: "return=minimal", body: row });
    const uploadUrl = await signedUploadUrl(pathOf(row));
    return send(res, 200, { code: row.code, uploadUrl, expiresAt: row.expires_at });
  }

  if (req.method === "GET" && !code) {
    const rows = await rest("shared_campaigns", `owner=eq.${user.id}&revoked_at=is.null&ready=is.true&order=created_at.desc&select=code,name,bytes,counts,created_at,expires_at,downloads`);
    return send(res, 200, { shares: (Array.isArray(rows) ? rows : []).filter((r) => !r.expires_at || Date.parse(r.expires_at) > now) });
  }

  const row = await byCode(code);
  if (req.method === "GET") {
    if (!live(row, now)) return send(res, 404, { error: "That code doesn't open a campaign. It may have been stopped or run out." });
    const downloadUrl = await signedDownloadUrl(pathOf(row));
    await rest("shared_campaigns", `code=eq.${code}`, { method: "PATCH", body: { downloads: (row.downloads || 0) + 1 } });
    return send(res, 200, { code, name: row.name, counts: row.counts, from: row.from_name || "", createdAt: row.created_at, bytes: row.bytes, downloadUrl });
  }

  // DELETE
  if (!row || row.owner !== user.id) return send(res, 404, { error: "No such share." });
  await rest("shared_campaigns", `code=eq.${code}`, { method: "PATCH", body: { revoked_at: iso(now) } });
  await removeObject(pathOf(row));
  send(res, 200, { ok: true });
});
