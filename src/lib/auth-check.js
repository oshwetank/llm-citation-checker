/*
 * auth-check.js — pre-flight "is the user actually signed in?" check, run
 * BEFORE a campaign opens any tabs.
 *
 * The problem this exists for: firing a run while signed out of one or more
 * engines is close to the worst failure this tool has, because it fails
 * QUIETLY and expensively. Tabs open, prompts get typed into a login wall
 * instead of a chat box, every one of those turns records as a failure or an
 * empty capture, and the run burns its whole prompt list before anyone
 * notices. The user only finds out afterwards, with a campaign's worth of
 * junk data already stored.
 *
 * Detection is by SESSION COOKIE, deliberately, because it's the only signal
 * available without opening a tab — which is the entire point. Anything that
 * required loading the page would already have done the thing we're trying
 * to avoid.
 *
 * THREE-STATE, not two. Cookie names are the engines' private implementation
 * detail and they DO churn; treating "I didn't recognise a cookie" as "you
 * are logged out" would hard-block a perfectly good run the first time a
 * vendor renames one. So:
 *   "in"      — a known session cookie is present. Run.
 *   "out"     — NO cookies at all for that host. Nobody who has ever signed
 *               in looks like this, so this is safe to block on.
 *   "unknown" — cookies exist but none matched. Warn, and let the user
 *               decide; never hard-block on a guess.
 * Only "out" stops a run. That asymmetry is the whole safety design: a false
 * "out" is impossible-ish (it needs a completely cookie-less host), while a
 * false "unknown" costs the user one dismissible warning.
 */

// Candidate session cookies per engine, most authoritative first. Several
// per engine on purpose — these are vendor internals, so the list is a net,
// not a contract. A host may legitimately serve cookies on either the bare
// domain or a dot-prefixed parent, hence `domains`.
export const AUTH_COOKIES = {
  chatgpt: {
    label: "ChatGPT",
    loginUrl: "https://chatgpt.com/auth/login",
    domains: ["chatgpt.com", "chat.openai.com"],
    names: [
      "__Secure-next-auth.session-token",
      "__Secure-next-auth.session-token.0",
      "next-auth.session-token",
    ],
  },
  gemini: {
    label: "Gemini",
    loginUrl: "https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app",
    // Gemini rides the shared Google account session, whose cookies live on
    // the parent google.com domain. Reading them needs access to all of
    // google.com, even when asked by gemini.google.com's address (checked in
    // Chrome for 1.0.0: both return nothing without it). That permission is
    // not asked for: adding it would switch the extension off for every 0.36
    // user until they approved it, and the store reviews it closely next to
    // "cookies". So Gemini can be seen signed in only where the browser
    // happens to show us its cookies, and is never judged signed out: seeing
    // no cookies here says nothing about the account.
    domains: [],
    urls: ["https://gemini.google.com/"],
    neverOut: true,
    names: ["__Secure-1PSID", "__Secure-3PSID", "SID", "SSID"],
  },
  perplexity: {
    label: "Perplexity",
    loginUrl: "https://www.perplexity.ai/",
    domains: ["perplexity.ai", "www.perplexity.ai"],
    names: [
      "__Secure-next-auth.session-token",
      "next-auth.session-token",
      "__Secure-next-auth.session-token.0",
    ],
  },
  grok: {
    label: "Grok",
    loginUrl: "https://grok.com/",
    domains: ["grok.com", "x.com"],
    names: ["sso", "sso-rw", "auth_token"],
  },
};

/**
 * Check one engine. `getAll` is chrome.cookies.getAll, injected so this is
 * testable outside a browser.
 * @returns {Promise<{engine:string,label:string,status:"in"|"out"|"unknown",loginUrl:string}>}
 */
export async function checkEngineAuth(engine, getAll) {
  const spec = AUTH_COOKIES[engine];
  if (!spec) return { engine, label: engine, status: "unknown", loginUrl: null };

  let any = 0;
  let matched = false;
  // By domain, or by a page's address (the cookies Chrome would send there).
  const queries = [...(spec.domains || []).map((domain) => ({ domain })), ...(spec.urls || []).map((url) => ({ url }))];
  for (const q of queries) {
    let cookies = [];
    try {
      cookies = (await getAll(q)) || [];
    } catch (_) {
      // A thrown getAll (permission missing, API unavailable) must never be
      // read as "logged out" — that would block a run over a problem on OUR
      // side. Fall through to "unknown".
      return { engine, label: spec.label, status: "unknown", loginUrl: spec.loginUrl };
    }
    any += cookies.length;
    if (cookies.some((c) => spec.names.includes(c.name) && c.value)) {
      matched = true;
      break;
    }
  }

  if (matched) return { engine, label: spec.label, status: "in", loginUrl: spec.loginUrl };
  // Zero cookies across every candidate domain is the only confident
  // "signed out" — see the three-state note in the file header.
  // Not for an engine whose session cookies are out of our reach (neverOut).
  if (any === 0 && !spec.neverOut) return { engine, label: spec.label, status: "out", loginUrl: spec.loginUrl };
  return { engine, label: spec.label, status: "unknown", loginUrl: spec.loginUrl };
}

/**
 * Check every engine a run is about to use.
 * @returns {Promise<{ok:boolean, signedOut:Array, unknown:Array, results:Array, message:string|null}>}
 *   ok === false ONLY when at least one engine is confidently signed out.
 */
export async function checkEnginesAuth(engines, getAll) {
  const results = [];
  for (const e of engines || []) results.push(await checkEngineAuth(e, getAll));

  const signedOut = results.filter((r) => r.status === "out");
  const unknown = results.filter((r) => r.status === "unknown");

  let message = null;
  if (signedOut.length) {
    const names = signedOut.map((r) => r.label).join(", ");
    message =
      `You're not signed in to ${names}. ` +
      `Sign in first — otherwise the run types every prompt into a login page and the whole campaign records as failures.`;
  }
  return { ok: signedOut.length === 0, signedOut, unknown, results, message };
}
