/*
 * safeUrl.js — which addresses the extension will link to, load or fetch
 * (0.84.1, from the pre-release security audit of 10 Nov 2026).
 *
 * Every address in a record comes from somewhere the user doesn't control:
 * an engine's payload, or a campaign file someone else shared. Adapters
 * already pass their sources through schema.js's makeSource, which keeps
 * http(s) only. Two paths went around it:
 *
 *   - An imported campaign (.cito file or a share code) was stored as it
 *     came. The audit imported a record whose source address was
 *     "javascript:alert(document.domain)"; it reached the exported HTML
 *     report as a link, and that file opens from disk with no extension
 *     protections around it.
 *   - "Read the cited pages" fetched whatever a cited source pointed at,
 *     including http://localhost and 192.168.x.x: a router's admin page or a
 *     service on the user's own machine, picked by whoever wrote the page an
 *     engine cited.
 *
 * No imports, so the worker, the pages and the tests all use the same rules.
 */

/** The address, trimmed, when it is http or https; otherwise null. */
export function httpUrl(u) {
  if (typeof u !== "string") return null;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

// Names that only mean something inside a home or office network.
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|onion)$/i;

/**
 * True when the address is http(s) and its host is a public site name.
 * Refused: localhost, names with no dot, home/office suffixes (.local,
 * .internal, .lan…), any address written as numbers (IPv4 or IPv6, which
 * covers 127.0.0.1, 10.x, 192.168.x, 169.254.x and ::1 without listing
 * ranges that a decimal or hex spelling could slip past), and addresses
 * carrying a user name or password.
 *
 * What this can't see: a public name that resolves to a private address.
 * The browser's own private-network checks are the guard there.
 */
export function isPublicHttpUrl(u) {
  const t = httpUrl(u);
  if (!t) return false;
  let url;
  try { url = new URL(t); } catch (_) { return false; }
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host || !host.includes(".")) return false; // "localhost", "router", and IPv6 ("[::1]" has no dot)
  if (host.startsWith("[") || host.includes(":")) return false;
  if (PRIVATE_SUFFIX.test(host)) return false;
  // new URL() has already turned 0x7f.1, 2130706433 and 127.1 into dotted
  // numbers, so one test covers every spelling of an IPv4 address.
  if (/^\d+(?:\.\d+){3}$/.test(host)) return false;
  // A real top-level name has a letter in it; "1.2.3" style leftovers don't.
  if (!/[a-z]/.test(host.split(".").pop())) return false;
  return true;
}

// Field names that hold an address somewhere in a record: url, pageUrl,
// imageUrl, listingUrl, mapsUrl, website, href, src, link, thumbnail…
const URL_KEY = /(?:url|uri|href|link)$|^(?:src|website|image|thumbnail|favicon|logo)$/i;

/**
 * Walks anything that came from outside (an imported record, profile or
 * prompt) and blanks every address field that isn't http(s). Returns the
 * number blanked. In place: the caller passes its own copy.
 *
 * Blank is "" rather than null, because the views call string methods on
 * these fields; sources are the exception, where null is what makeSource
 * (schema.js) already writes and every reader expects.
 */
export function scrubUrls(root, { maxDepth = 40 } = {}) {
  let changed = 0;
  const visit = (node, depth, inSources) => {
    if (!node || typeof node !== "object" || depth > maxDepth) return;
    if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1, inSources); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") {
        if (URL_KEY.test(k) && v && !httpUrl(v)) { node[k] = inSources && k === "url" ? null : ""; changed++; }
      } else if (v && typeof v === "object") {
        visit(v, depth + 1, k === "sources");
      }
    }
  };
  visit(root, 0, false);
  return changed;
}

/** For an href or src written into HTML: the address if http(s), else "". */
export const hrefOf = (u) => httpUrl(u) || "";
