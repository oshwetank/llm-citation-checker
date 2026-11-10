/*
 * supabase.js — Supabase over its REST API (no client library), with the
 * service key, which never leaves the server. Tables and storage are closed
 * to everyone else by row-level security (supabase/schema.sql).
 */
import { deps } from "./deps.js";

const base = () => String(deps.env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = () => deps.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = (extra = {}) => ({ apikey: key(), authorization: `Bearer ${key()}`, ...extra });
export const BUCKET = "shares";

async function call(url, opts) {
  const res = await deps.fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error || data.msg)) || `Supabase ${res.status}`);
    err.upstream = res.status;
    throw err;
  }
  return data;
}

// The person behind an access token, or null.
export async function getUser(jwt) {
  try {
    const u = await call(`${base()}/auth/v1/user`, { headers: { apikey: key(), authorization: `Bearer ${jwt}` } });
    return u && u.id ? { id: u.id, email: u.email || "" } : null;
  } catch (_) { return null; }
}

// PostgREST: table, query string, method, body.
export function rest(table, query = "", { method = "GET", body, prefer } = {}) {
  return call(`${base()}/rest/v1/${table}${query ? `?${query}` : ""}`, {
    method,
    headers: svc({ "content-type": "application/json", ...(prefer ? { prefer } : {}) }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// A one-time address the extension uploads the file to directly.
export async function signedUploadUrl(path) {
  const d = await call(`${base()}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: "POST", headers: svc({ "content-type": "application/json" }), body: "{}" });
  return `${base()}/storage/v1${d.url}`;
}

// A short-lived download address. Fails when the file isn't there, which is
// also how an upload is confirmed.
export async function signedDownloadUrl(path, expiresIn = 600) {
  const d = await call(`${base()}/storage/v1/object/sign/${BUCKET}/${path}`, { method: "POST", headers: svc({ "content-type": "application/json" }), body: JSON.stringify({ expiresIn }) });
  return `${base()}/storage/v1${d.signedURL || d.signedUrl}`;
}

export async function removeObject(path) {
  try { await call(`${base()}/storage/v1/object/${BUCKET}/${path}`, { method: "DELETE", headers: svc() }); } catch (_) { /* already gone */ }
}
