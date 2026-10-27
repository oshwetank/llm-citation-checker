/*
 * email-check.test.mjs — the first-run screen's email check (0.81.0).
 *
 * Asked: a proper check, not "any random string"; temp-mail inboxes flagged
 * at once, in a Gen Z voice.
 */
import { checkEmail, isDisposable, suggestDomain, EMAIL_MESSAGES } from "../src/lib/emailCheck.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nreal addresses pass");
for (const e of ["asha.k@gmail.com", "Team+updates@Zento.example.in", "ravi_99@company.co.uk", "o'neil@proton.me"]) {
  const r = checkEmail(e);
  check(`${e}`, r.ok && !r.reason, JSON.stringify(r));
}
check("trimmed and lower-cased", checkEmail("  Asha@Gmail.com ").email === "asha@gmail.com");

console.log("\nnot an email");
for (const e of ["", "asha", "asha@", "@gmail.com", "asha@gmail", "asha@@gmail.com", "as ha@gmail.com", "asha@gmail.c", "asha..k@gmail.com", ".asha@gmail.com", "asha@-gmail.com", "asha@gmail.123", "lol random text"]) {
  const r = checkEmail(e);
  check(`refused: ${JSON.stringify(e)}`, !r.ok && (r.reason === "shape" || r.reason === "empty"), JSON.stringify(r));
}
check("an empty box asks for it", checkEmail("").message === EMAIL_MESSAGES.empty);

console.log("\nthrowaway inboxes");
for (const e of ["x@mailinator.com", "x@yopmail.com", "x@guerrillamail.com", "x@10minutemail.com", "x@temp-mail.org", "x@sub.mailinator.com", "x@my-tempmail.example", "x@trashinbox.io", "x@burnermail.io"]) {
  const r = checkEmail(e);
  check(`flagged: ${e}`, !r.ok && r.reason === "disposable", JSON.stringify(r));
}
check("in a Gen Z voice", /burner|vibe|💀/i.test(checkEmail("x@yopmail.com").message), checkEmail("x@yopmail.com").message);
check("an ordinary domain with 'mail' in it is fine", !isDisposable("gmail.com") && !isDisposable("hotmail.com") && !isDisposable("mailchimp.com") && !isDisposable("zento.example"));

console.log("\nslips in the big providers' names");
const t = checkEmail("asha@gmial.com");
check("gmial.com: accepted, with a suggestion", t.ok && t.reason === "typo" && t.suggestion === "gmail.com" && /gmail\.com/.test(t.message), JSON.stringify(t));
check("hotmial.com → hotmail.com", suggestDomain("hotmial.com") === "hotmail.com");
check("outlok.com → outlook.com", suggestDomain("outlok.com") === "outlook.com");
check("gmail.com itself has no suggestion", suggestDomain("gmail.com") === null);
check("a company's own domain has none", suggestDomain("zento.example") === null);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
