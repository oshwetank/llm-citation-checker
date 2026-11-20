/*
 * auth-check.test.mjs — the pre-flight sign-in gate blocks a run ONLY when
 * it is genuinely confident the user is signed out.
 *
 * Why this gate exists: firing a campaign while signed out is a quiet,
 * expensive failure — tabs open, prompts get typed into a login wall, every
 * turn records as a failure or an empty capture, and the whole prompt list
 * is burned before anyone notices.
 *
 * Why it is THREE-state rather than a boolean: the cookie names it keys off
 * are vendor internals that churn. Treating "I didn't recognise a cookie" as
 * "signed out" would hard-block a perfectly good run the first time an
 * engine renames one. So only a host with NO cookies at all counts as
 * signed out; anything ambiguous warns instead. These tests exist mostly to
 * pin down that asymmetry, since getting it wrong in the safe-looking
 * direction (block on ambiguity) is the more tempting mistake.
 */
import { checkEngineAuth, checkEnginesAuth, AUTH_COOKIES } from "../src/lib/auth-check.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

// Fake chrome.cookies.getAll over a { domain: [ {name,value}, ... ] } map.
const fakeGetAll = (byDomain) => async ({ domain, url }) => byDomain[domain || url] || [];

console.log("\nauth-check: per-engine detection");

{
  const signedIn = await checkEngineAuth("chatgpt", fakeGetAll({
    "chatgpt.com": [{ name: "__Secure-next-auth.session-token", value: "abc123" }],
  }));
  check("a known session cookie reads as signed IN", signedIn.status === "in", signedIn.status);

  const noCookies = await checkEngineAuth("chatgpt", fakeGetAll({}));
  check("no cookies at all reads as signed OUT", noCookies.status === "out", noCookies.status);

  // The asymmetry that keeps a churned cookie name from blocking a real run.
  const otherCookies = await checkEngineAuth("chatgpt", fakeGetAll({
    "chatgpt.com": [{ name: "oai-did", value: "x" }, { name: "_cfuvid", value: "y" }],
  }));
  check("cookies present but none recognised reads as UNKNOWN, not out", otherCookies.status === "unknown", otherCookies.status);

  // A cookie whose name matches but is empty is not a session.
  const emptyValue = await checkEngineAuth("chatgpt", fakeGetAll({
    "chatgpt.com": [{ name: "__Secure-next-auth.session-token", value: "" }],
  }));
  check("a recognised cookie with an EMPTY value is not treated as signed in", emptyValue.status !== "in", emptyValue.status);
}

{
  // Gemini rides the shared Google session on the PARENT domain, not on
  // gemini.google.com — a check that only looked at the engine's own host
  // would report every signed-in Gemini user as signed out.
  // Asked by gemini.google.com's address (1.0.0). Without access to
  // google.com, which isn't asked for, Chrome returns nothing there; where
  // it does show the cookie, Gemini reads as signed in.
  const g = await checkEngineAuth("gemini", fakeGetAll({
    "https://gemini.google.com/": [{ name: "__Secure-1PSID", value: "tok" }],
  }));
  check("gemini is detected via the Google session cookie sent to gemini.google.com", g.status === "in", g.status);
  const asked = [];
  const none = await checkEngineAuth("gemini", async (q) => { asked.push(q); return []; });
  // No cookies seen is what every Gemini user looks like without google.com
  // access: it must never block a run as "signed out".
  check("gemini with no cookies seen is unknown, never signed out", none.status === "unknown", none.status);
  check("and it never asks about google.com itself (no permission for it)", asked.every((q) => !q.domain && q.url && new URL(q.url).hostname === "gemini.google.com"), JSON.stringify(asked));
}

{
  // A thrown getAll is OUR problem (missing permission, API unavailable) and
  // must never present as the user being signed out.
  const thrower = async () => { throw new Error("no permission"); };
  const r = await checkEngineAuth("chatgpt", thrower);
  check("a thrown getAll degrades to UNKNOWN, never to 'out'", r.status === "unknown", r.status);
}

console.log("\nauth-check: whole-run gate");

{
  const cookies = fakeGetAll({
    "chatgpt.com": [{ name: "__Secure-next-auth.session-token", value: "a" }],
    "https://gemini.google.com/": [{ name: "__Secure-1PSID", value: "b" }],
    // perplexity.ai deliberately absent -> confidently signed out
  });

  const blocked = await checkEnginesAuth(["chatgpt", "gemini", "perplexity"], cookies);
  check("a run with one signed-out engine is blocked", blocked.ok === false);
  check("the blocked engine is named", blocked.signedOut.length === 1 && blocked.signedOut[0].engine === "perplexity");
  check("the message names the engine so the user knows what to fix", /Perplexity/.test(blocked.message || ""), blocked.message);
  check("a login URL is supplied so the dialog can offer to open it", !!blocked.signedOut[0].loginUrl);

  const allowed = await checkEnginesAuth(["chatgpt", "gemini"], cookies);
  check("a run with every engine signed in proceeds", allowed.ok === true);
  check("nothing is reported as signed out", allowed.signedOut.length === 0);
}

{
  // Ambiguity alone must never stop a run — it warns.
  const ambiguous = fakeGetAll({ "chatgpt.com": [{ name: "_cfuvid", value: "x" }] });
  const r = await checkEnginesAuth(["chatgpt"], ambiguous);
  check("an UNKNOWN engine does not block the run", r.ok === true);
  check("but it is surfaced so the UI can warn", r.unknown.length === 1 && r.unknown[0].engine === "chatgpt");
}

console.log("\nauth-check: registry sanity");

{
  const ids = Object.keys(AUTH_COOKIES);
  check("every supported engine has an auth spec", ["chatgpt", "gemini", "perplexity", "grok"].every((e) => ids.includes(e)), ids.join(","));
  const bad = ids.filter((k) => {
    const s = AUTH_COOKIES[k];
    return !s.label || !s.loginUrl || !((Array.isArray(s.domains) && s.domains.length) || (Array.isArray(s.urls) && s.urls.length)) || !Array.isArray(s.names) || !s.names.length;
  });
  check("every spec has a label, login URL, domains and cookie names", bad.length === 0, bad.join(","));
  // The login URLs double as an allowlist for the background's "open-url"
  // handler, so they must be real https URLs and nothing else.
  const badUrl = ids.filter((k) => !/^https:\/\//.test(AUTH_COOKIES[k].loginUrl));
  check("every login URL is https (they gate the open-url allowlist)", badUrl.length === 0, badUrl.join(","));
}

console.log("\nauth-check: the gate is wired in BEFORE anything is created");

// The whole value of a pre-flight check is that nothing has happened yet
// when it refuses. If the gate ever drifts below tab creation, the run would
// already have opened windows/tabs and written itself to the "runs" store
// before being told no — leaving exactly the orphaned mess it exists to
// prevent. Asserted against the real source, positionally.
{
  const { readFileSync } = await import("node:fs");
  const bg = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");

  const fnStart = bg.indexOf("async function loaderStart(");
  check("loaderStart() found in background.js", fnStart !== -1);

  if (fnStart !== -1) {
    // Bound the search to loaderStart's own body so a later unrelated
    // chrome.tabs.create elsewhere in the file can't satisfy this.
    const fnEnd = bg.indexOf("\nasync function ", fnStart + 10);
    const body = bg.slice(fnStart, fnEnd === -1 ? bg.length : fnEnd);

    const gateAt = body.indexOf("checkEnginesAuth");
    // Match the STATEMENT, not the mention of it in the comment above the gate.
    const newStateAt = body.indexOf("loader = newLoaderState();");
    const tabCreateAt = body.indexOf("chrome.tabs.create");
    const runsPutAt = body.indexOf('db.put("runs"');

    check("the auth gate is called inside loaderStart", gateAt !== -1);
    check("the gate runs BEFORE loader state is reset", gateAt !== -1 && newStateAt !== -1 && gateAt < newStateAt);
    check("the gate runs BEFORE any tab is created", gateAt !== -1 && tabCreateAt !== -1 && gateAt < tabCreateAt);
    check("the gate runs BEFORE the run is written to the store", gateAt !== -1 && runsPutAt !== -1 && gateAt < runsPutAt);
    check("the user's explicit override is honoured", /skipAuthCheck/.test(body));
  }

  // The open-url handler must never become a general "open anything" hole.
  check(
    "background's open-url handler validates against the known login URLs",
    /case "open-url"[\s\S]{0,400}AUTH_COOKIES[\s\S]{0,200}includes\(msg\.url\)/.test(bg)
  );
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
