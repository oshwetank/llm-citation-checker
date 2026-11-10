/* emailCheck.js — is this a real, reachable email address? (0.81.0)
 *
 * The first-run screen asks for an email for update news. The owner: "there
 * should be a proper way to validate the email. It should not be like add any
 * random string … temp mail IDs should not be allowed. It should be flagged
 * immediately … in a very Gen Z style way". Three checks, on the computer:
 *   1. the shape of an address (one @, a dotted domain with a real-looking
 *      ending, nothing a mail server would refuse);
 *   2. throwaway inboxes: a bundled list of disposable-mail domains, plus
 *      names that announce themselves (temp-, trash-, 10minute-…);
 *   3. common slips in the big providers' names ("gmial.com"), offered as a
 *      suggestion rather than refused.
 * Whether the domain receives mail at all is asked of the server when it is
 * reachable (0.82.0); this file never touches the network.
 * Pure: unit test email-check.
 */

// Disposable-mail services, the ones seen most. Lower case, no "www.".
export const DISPOSABLE_DOMAINS = new Set(`
0-mail.com 0815.ru 10minutemail.com 10minutemail.net 10minutemail.co.uk 10minmail.com 20minutemail.com 33mail.com
anonbox.net anonymbox.com binkmail.com bobmail.info burnermail.io byom.de chacuo.net cuvox.de deadaddress.com
discard.email discardmail.com discardmail.de dispostable.com dodgit.com dropmail.me dayrep.com einrot.com
emailfake.com emailondeck.com emailtemporanea.com emailtemporanea.net email-temp.com fakeinbox.com fakemail.net
fakemailgenerator.com fleckens.hu getairmail.com getnada.com gishpuppy.com guerrillamail.biz guerrillamail.com
guerrillamail.de guerrillamail.info guerrillamail.net guerrillamail.org guerrillamailblock.com gustr.com
harakirimail.com hidemail.de inboxbear.com inboxkitten.com incognitomail.com jetable.org jourrapide.com
mail-temp.com mail.tm mail7.io mailcatch.com maildrop.cc maildu.de mailexpire.com mailforspam.com mailinator.com
mailinator.net mailinator2.com mailnesia.com mailnull.com mailpoof.com mailsac.com mailtemp.net meltmail.com
mintemail.com moakt.com moakt.cc mohmal.com mt2015.com mvrht.com mytemp.email mytrashmail.com nada.email
nowmymail.com objectmail.com one-time.email onetimemail.org pokemail.net rhyta.com rcpt.at sharklasers.com
smashmail.de snapmail.cc sogetthis.com spam4.me spambog.com spambox.us spamgourmet.com spamherelots.com
spaml.com spammotel.com superrito.com suremail.info teleworm.us temp-mail.io temp-mail.org temp-mail.ru
tempail.com tempemail.net tempinbox.com tempmail.com tempmail.dev tempmail.net tempmail.plus tempmailo.com
tempmailaddress.com tempr.email tempsky.com throwam.com throwawaymail.com tmail.ws tmailor.com tmpmail.net
tmpmail.org trash-mail.com trashmail.com trashmail.de trashmail.io trashmail.me trashmail.net trbvm.com
tyldd.com uroid.com wegwerfmail.de wegwerfmail.net yopmail.com yopmail.fr yopmail.net zetmail.com
emltmp.com dropmail.pro minuteinbox.com fexpost.com fexbox.org mailbox.in.ua tempmailbox.net crazymailing.com
`.split(/\s+/).filter(Boolean));

// A domain that says what it is.
const DISPOSABLE_WORDS = /(?:^|[.-])(?:temp|tmp|trash|throwaway|disposable|fake|burner|spam|junk|10min|minute|guerrilla|yopmail|mailinator|wegwerf|jetable)(?:mail|inbox|box|email)?(?:[.-]|$)|(?:temp|trash|throwaway|disposable|fake|burner)(?:mail|inbox|email)/i;

const PROVIDERS = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "protonmail.com", "live.com", "aol.com", "yahoo.co.in", "rediffmail.com", "zoho.com"];
const TYPOS = {
  "gmial.com": "gmail.com", "gamil.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com",
  "gmal.com": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com", "gmail.cm": "gmail.com", "gmail.om": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmal.com": "hotmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "yhoo.com": "yahoo.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.co": "outlook.com", "iclod.com": "icloud.com", "icloud.co": "icloud.com",
};

// Edit distance, small strings only.
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Is the domain a throwaway inbox? A subdomain of one counts. */
export function isDisposable(domain) {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!d) return false;
  const parts = d.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  return DISPOSABLE_WORDS.test(parts.slice(0, -1).join("."));
}

/** A likely slip in a big provider's name, or null. */
export function suggestDomain(domain) {
  const d = String(domain || "").toLowerCase();
  if (TYPOS[d]) return TYPOS[d];
  if (PROVIDERS.includes(d)) return null;
  let best = null, bestD = 3;
  for (const p of PROVIDERS) { const n = distance(d, p); if (n < bestD) { bestD = n; best = p; } }
  return bestD === 1 ? best : null;
}

// What the screen says. Kept short; the owner asked for a Gen Z voice.
export const EMAIL_MESSAGES = {
  empty: "Pop your email in first ✍️",
  shape: "Hmm, that doesn't look like an email 👀 Double-check it?",
  disposable: "A burner inbox? Not the vibe 💀 Drop your real email so the updates actually reach you.",
  typo: (s) => `Did you mean @${s}? No judgement, we all fat-finger 🫶`,
  ok: "You're in ✨ We'll only write when there's something new.",
};

/**
 * @returns {{ ok: boolean, reason: "empty"|"shape"|"disposable"|"typo"|null, email: string, domain: string|null, suggestion: string|null, message: string }}
 * "typo" is not fatal: ok stays true, with a suggestion the screen offers.
 */
export function checkEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  const out = (ok, reason, extra = {}) => ({ ok, reason, email, domain: extra.domain || null, suggestion: extra.suggestion || null, message: extra.message || (reason ? EMAIL_MESSAGES[reason] : EMAIL_MESSAGES.ok) });
  if (!email) return out(false, "empty");
  const at = email.lastIndexOf("@");
  if (at < 1 || email.indexOf("@") !== at || email.length > 254) return out(false, "shape");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || /^\.|\.$|\.\./.test(local)) return out(false, "shape", { domain });
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return out(false, "shape", { domain });
  if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1])) return out(false, "shape", { domain });
  if (isDisposable(domain)) return out(false, "disposable", { domain });
  const suggestion = suggestDomain(domain);
  if (suggestion) return out(true, "typo", { domain, suggestion, message: EMAIL_MESSAGES.typo(suggestion) });
  return out(true, null, { domain });
}
