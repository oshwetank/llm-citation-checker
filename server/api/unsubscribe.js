/*
 * POST /api/unsubscribe {email, token} — stop update news. The token is the
 * one /api/subscribe returned, so nobody can unsubscribe someone else.
 */
import { handler, send, readJson } from "../lib/http.js";
import { rest } from "../lib/supabase.js";
import { deps } from "../lib/deps.js";

export default handler("POST", async (req, res) => {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const token = String(body.token || "");
  if (!email || !token) return send(res, 400, { error: "Email and token are needed." });
  const rows = await rest("subscribers", `email=eq.${encodeURIComponent(email)}&token=eq.${encodeURIComponent(token)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { unsubscribed_at: new Date(deps.now()).toISOString() },
  });
  if (!Array.isArray(rows) || !rows.length) return send(res, 404, { error: "That email isn't subscribed." });
  send(res, 200, { ok: true });
});
