/*
 * senderGate.js — who may ask the worker for what (0.84.1, from the
 * pre-release security audit of 10 Nov 2026).
 *
 * The worker answers about 117 kinds of message: store a capture, but also
 * hand back any stored answer, export a campaign, delete everything. It
 * took all of them from any sender. In normal running that is only this
 * extension's own code, but two kinds of sender are not equal:
 *
 *   - the extension's own pages (the panel, the report, the offscreen
 *     page), which the user drives;
 *   - the scripts it puts into ChatGPT, Gemini, Perplexity, Grok and x.com.
 *     Those live inside someone else's page. Chrome's own guidance is to
 *     treat a message from a content script as something a page could have
 *     forged, because a browser bug in that site's process gets exactly
 *     that power.
 *
 * So a message that comes from a web page's tab may only be one of the
 * kinds those scripts really send. Everything else (reading stored answers
 * from another engine, deleting, exporting, signing in) is for the
 * extension's own pages only. No imports, so the rules are unit tested.
 */

// Every `type` src/content-iso.js and src/handoff.js send. The test reads
// both files and fails if one of them sends a kind that isn't listed.
export const PAGE_MESSAGE_TYPES = new Set([
  "raw-conversation", "capture-drop", "capture-health", "capture-stored-since",
  "conversation-source", "debug", "netlog", "page-interaction", "probe", "user-asked",
  "loader-claim", "loader-rate-limited", "loader-sent", "loader-submit-failed", "loader-verify",
  "handoff-claim", "handoff-result",
]);

/**
 * True when the message came from one of the extension's own pages, not
 * from a script inside a web page. `extBase` is chrome.runtime.getURL("").
 */
export function fromExtensionPage(sender, extBase) {
  const url = sender && typeof sender.url === "string" ? sender.url : "";
  if (url) return !!extBase && url.startsWith(extBase);
  // No address at all: not a web page's tab (those always carry one).
  return !(sender && sender.tab);
}

/** Whether the worker should act on this message from this sender. */
export function mayHandle(msg, sender, extBase) {
  if (fromExtensionPage(sender, extBase)) return true;
  return !!msg && PAGE_MESSAGE_TYPES.has(msg.type);
}

/**
 * "Continue in…" (0.76.0): whether a tab is still on the AI site it was
 * opened for. The message was put into whatever page the tab had finished
 * loading. With site access granted for every site (the cited-pages
 * setting asks for it), a tab that had been redirected somewhere else
 * would have had the user's data typed into that site's first text box and
 * sent. https only, the same site or a subdomain of it ("www." aside).
 */
export function onEngineSite(tabUrl, engineUrl) {
  let t, e;
  try { t = new URL(tabUrl); e = new URL(engineUrl); } catch (_) { return false; }
  if (t.protocol !== "https:") return false;
  const bare = (h) => h.toLowerCase().replace(/^www\./, "");
  const th = bare(t.hostname), eh = bare(e.hostname);
  return th === eh || th.endsWith(`.${eh}`);
}
