/*
 * cloud.js — the extension's side of accounts and shared campaigns (0.82.0).
 *
 * Asked: "profiles and login … transfer a campaign to another person who can
 * then run it on their own system". Sign-in is an emailed code (Supabase
 * Auth, no password). Sharing uploads the same .cito file campaignBundle.js
 * writes and hands back a short code; whoever has the code, signed in, gets
 * the file and imports it as their own campaign.
 *
 * Nothing here runs unless the person signs in, shares, opens a code, or has
 * left an email for updates. Captures are never sent: only a campaign
 * someone chose to share. fetch, the clock and storage are passed in, so
 * the whole flow is unit tested (cloud.test) without a network.
 */
export const CLOUD_SESSION_KEY = "citoCloudSession";
const SKEW_MS = 60 * 1000;

export function cloudReady(cfg) {
  return !!(cfg && cfg.apiBase && cfg.supabaseUrl && cfg.supabaseAnonKey);
}

export class CloudError extends Error {
  constructor(message, status = 0, code = "") { super(message); this.status = status; this.code = code; }
}

const trimSlash = (s) => String(s || "").replace(/\/+$/, "");
// Codes leave out I, O, 0 and 1, so nothing in one can be misread. Typed
// spaces, dashes and lower case are forgiven.
export const SHARE_CODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;
export function normCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

export function makeCloud(cfg, { fetch = globalThis.fetch, now = () => Date.now(), load, save } = {}) {
  const auth = `${trimSlash(cfg.supabaseUrl)}/auth/v1`;
  const api = trimSlash(cfg.apiBase);
  const anon = { apikey: cfg.supabaseAnonKey, "content-type": "application/json" };

  async function call(url, { method = "GET", headers = {}, body } = {}) {
    let res;
    try { res = await fetch(url, { method, headers, body }); } catch (_) { throw new CloudError("Couldn't reach the server. Check the connection and try again.", 0, "offline"); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && (data.error_description || data.msg || data.message || data.error)) || `The server said ${res.status}.`;
      throw new CloudError(res.status === 401 ? "Your sign-in has run out. Sign in again." : String(msg), res.status, (data && (data.error_code || data.code)) || "");
    }
    return data;
  }

  const toSession = (d) => ({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at ? d.expires_at * 1000 : now() + (d.expires_in || 3600) * 1000,
    user: { id: d.user && d.user.id, email: d.user && d.user.email, name: (d.user && d.user.user_metadata && d.user.user_metadata.display_name) || "" },
  });

  // A session good for at least another minute, refreshed when it isn't.
  async function session() {
    const s = await load();
    if (!s || !s.refresh_token) return null;
    if (s.expires_at - SKEW_MS > now()) return s;
    try {
      const d = await call(`${auth}/token?grant_type=refresh_token`, { method: "POST", headers: anon, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      const next = { ...toSession(d), user: { ...toSession(d).user, name: s.user && s.user.name } };
      await save(next);
      return next;
    } catch (e) {
      if (e.status >= 400 && e.status < 500) { await save(null); return null; }
      throw e;
    }
  }

  async function authed(path, opts = {}) {
    const s = await session();
    if (!s) throw new CloudError("Sign in first: About → Account.", 401, "signed_out");
    return call(`${api}${path}`, { ...opts, headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}`, ...(opts.headers || {}) } });
  }

  return {
    session,
    async requestCode(email) {
      await call(`${auth}/otp`, { method: "POST", headers: anon, body: JSON.stringify({ email, create_user: true }) });
      return { ok: true };
    },
    async verifyCode(email, code) {
      const d = await call(`${auth}/verify`, { method: "POST", headers: anon, body: JSON.stringify({ type: "email", email, token: String(code || "").replace(/\s+/g, "") }) });
      const s = toSession(d);
      await save(s);
      return s;
    },
    async signOut() {
      const s = await load();
      await save(null);
      if (s && s.access_token) { try { await call(`${auth}/logout`, { method: "POST", headers: { ...anon, authorization: `Bearer ${s.access_token}` } }); } catch (_) { /* signed out here either way */ } }
      return { ok: true };
    },
    async getProfile() { return authed("/api/profile"); },
    async saveProfile(displayName) {
      const p = await authed("/api/profile", { method: "POST", body: JSON.stringify({ display_name: String(displayName || "").trim().slice(0, 60) }) });
      const s = await load();
      if (s) await save({ ...s, user: { ...s.user, name: p.display_name || "" } });
      return p;
    },
    // Share: ask for a code and a one-time upload address, send the file
    // straight to storage (it can be larger than a function accepts), then
    // say it's there.
    async shareUpload(bytes, { name = "", counts = null } = {}) {
      const size = bytes.byteLength;
      const start = await authed("/api/share", { method: "POST", body: JSON.stringify({ name, bytes: size, counts }) });
      let put;
      try { put = await fetch(start.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "false" }, body: bytes }); } catch (_) { put = null; }
      if (!put || !put.ok) throw new CloudError("The upload didn't finish. Try again.", put ? put.status : 0, "upload");
      await authed(`/api/share?code=${encodeURIComponent(start.code)}&done=1`, { method: "POST", body: "{}" });
      return { code: start.code, expiresAt: start.expiresAt || null };
    },
    async shareFetch(code) {
      const c = normCode(code);
      if (!SHARE_CODE_RE.test(c)) throw new CloudError("That code doesn't look right: it's 10 letters and numbers.", 400, "bad_code");
      const meta = await authed(`/api/share?code=${encodeURIComponent(c)}`);
      let res;
      try { res = await fetch(meta.downloadUrl); } catch (_) { res = null; }
      if (!res || !res.ok) throw new CloudError("The campaign couldn't be downloaded. Try again.", res ? res.status : 0, "download");
      return { meta, bytes: await res.arrayBuffer() };
    },
    // Campaigns saved to the profile (0.85.0): the same three steps as a
    // share, but the address replaces the last save, so whoever opens it
    // gets the latest copy.
    async profileSave(bytes, { localId, name = "", counts = null } = {}) {
      const start = await authed("/api/campaigns", { method: "POST", body: JSON.stringify({ localId, name, bytes: bytes.byteLength, counts }) });
      let put;
      try { put = await fetch(start.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-upsert": "true" }, body: bytes }); } catch (_) { put = null; }
      if (!put || !put.ok) throw new CloudError("The upload didn't finish. Try again.", put ? put.status : 0, "upload");
      const done = await authed(`/api/campaigns?id=${encodeURIComponent(start.id)}&done=1`, { method: "POST", body: "{}" });
      return { id: start.id, version: done.version, savedAt: done.savedAt };
    },
    async profileList() { return authed("/api/campaigns"); },
    async profileFetch(id) {
      const meta = await authed(`/api/campaigns?id=${encodeURIComponent(id)}`);
      let res;
      try { res = await fetch(meta.downloadUrl); } catch (_) { res = null; }
      if (!res || !res.ok) throw new CloudError("The campaign couldn't be downloaded. Try again.", res ? res.status : 0, "download");
      return { meta, bytes: await res.arrayBuffer() };
    },
    async profilePeople(id, emails) { return authed(`/api/campaigns?id=${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ emails }) }); },
    async profileRemove(id) { return authed(`/api/campaigns?id=${encodeURIComponent(id)}`, { method: "DELETE" }); },
    async shareList() { return (await authed("/api/share")).shares || []; },
    async shareRevoke(code) { return authed(`/api/share?code=${encodeURIComponent(normCode(code))}`, { method: "DELETE" }); },
    // Update news: no account needed.
    async subscribe(email, { source = "extension" } = {}) {
      return call(`${api}/api/subscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, consent: true, source }) });
    },
    async unsubscribe(email, token) {
      return call(`${api}/api/unsubscribe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, token }) });
    },
  };
}
