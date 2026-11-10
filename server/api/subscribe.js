/*
 * POST /api/subscribe {email, consent, source} — an email for update news
 * (0.82.0). The same checks as the extension (lib/emailCheck.js, a copy kept
 * identical by a test), plus one only a server can make: does the domain
 * take mail at all (an MX lookup). Returns a token the extension keeps, so
 * the same person, and only they, can unsubscribe.
 */
import { handler, send, readJson } from "../lib/http.js";
import { rest } from "../lib/supabase.js";
import { deps } from "../lib/deps.js";
import { checkEmail } from "../lib/emailCheck.js";

export async function domainTakesMail(domain) {
  try {
    const mx = await Promise.race([deps.resolveMx(domain), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 4000))]);
    return Array.isArray(mx) && mx.length > 0 ? true : false;
  } catch (e) {
    // Only a clear "no such domain / no mail here" refuses; a slow or broken
    // lookup lets the address through rather than turn a real person away.
    return e && (e.code === "ENOTFOUND" || e.code === "ENODATA") ? false : true;
  }
}

export default handler("POST", async (req, res) => {
  const body = await readJson(req);
  if (body.consent !== true) return send(res, 400, { error: "Tick the box to say we may email you." });
  const r = checkEmail(body.email);
  if (!r.ok) return send(res, 400, { error: r.message, reason: r.reason });
  const domain = r.email.split("@")[1];
  if (!(await domainTakesMail(domain))) return send(res, 400, { error: `${domain} doesn't receive email. Check the spelling?`, reason: "no-mx" });
  const token = deps.randomBytes(18).toString("base64url");
  await rest("subscribers", "on_conflict=email", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: { email: r.email, consent: true, source: String(body.source || "extension").slice(0, 40), token, unsubscribed_at: null, updated_at: new Date(deps.now()).toISOString() },
  });
  send(res, 200, { ok: true, email: r.email, token });
});
