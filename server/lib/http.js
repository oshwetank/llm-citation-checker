/*
 * http.js — the small parts every handler shares: who may call (the
 * extension's own pages), JSON in and out, and the signed-in user.
 */
import { deps } from "./deps.js";
import { getUser } from "./supabase.js";

const EXT_ORIGIN_RE = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+$/i;

// The extension's pages and worker call from chrome-extension://<id>. Set
// EXTENSION_IDS (comma-separated) to accept only the published build;
// ALLOWED_ORIGINS adds any web origin (a site page, say).
export function allowedOrigin(origin) {
  if (!origin) return "";
  const env = deps.env;
  const extra = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return origin;
  if (!EXT_ORIGIN_RE.test(origin)) return "";
  const ids = String(env.EXTENSION_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length && !ids.includes(origin.split("://")[1])) return "";
  return origin;
}

// Returns true when the request was answered here (preflight, or refused).
export function cors(req, res, methods) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", `${methods}, OPTIONS`);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-max-age", "600");
  }
  if (req.method === "OPTIONS") { res.statusCode = origin ? 204 : 403; res.end(); return true; }
  if (req.headers.origin && !origin) { send(res, 403, { error: "This server only answers the CitoSkeleton extension." }); return true; }
  if (!methods.split(", ").includes(req.method)) { send(res, 405, { error: "Method not allowed." }); return true; }
  return false;
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

// Small JSON bodies only: campaign files go straight to storage.
export async function readJson(req, limit = 64 * 1024) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Too large."), { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function queryOf(req) {
  if (req.query) return req.query;
  return Object.fromEntries(new URL(req.url, "http://x").searchParams);
}

export async function signedInUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  return getUser(m[1]);
}

export function configured() {
  const e = deps.env;
  return !!(e.SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY);
}

// Wraps a handler: CORS, config check, thrown errors as JSON.
export function handler(methods, fn) {
  return async (req, res) => {
    if (cors(req, res, methods)) return;
    if (!configured()) return send(res, 503, { error: "The server isn't set up yet." });
    try { await fn(req, res); } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, { error: "That request wasn't valid JSON." });
      send(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server." });
    }
  };
}
