/*
 * GET /api/profile — the signed-in person's profile.
 * POST /api/profile {display_name} — set the name shown on what they share.
 */
import { handler, send, readJson, signedInUser } from "../lib/http.js";
import { rest } from "../lib/supabase.js";
import { deps } from "../lib/deps.js";

export default handler("GET, POST", async (req, res) => {
  const user = await signedInUser(req);
  if (!user) return send(res, 401, { error: "Sign in first." });
  if (req.method === "GET") {
    const rows = await rest("profiles", `id=eq.${user.id}&select=display_name,created_at`);
    const p = (Array.isArray(rows) && rows[0]) || {};
    return send(res, 200, { id: user.id, email: user.email, display_name: p.display_name || "", created_at: p.created_at || null });
  }
  const body = await readJson(req);
  const name = String(body.display_name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  await rest("profiles", "on_conflict=id", { method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: { id: user.id, display_name: name, updated_at: new Date(deps.now()).toISOString() } });
  send(res, 200, { id: user.id, email: user.email, display_name: name });
});
