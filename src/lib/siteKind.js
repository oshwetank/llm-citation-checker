/*
 * siteKind.js — what kind of site a cited page lives on.
 *
 * The popup's "Pages cited" section (0.47.0) answers the question a GEO
 * practitioner asks first about a citation list: is the engine leaning on
 * my site, on rivals' own sites, on independent reviewers, on stores, or on
 * forums? The six groups and their order match the campaign PDF report and
 * the Excel workbook's Sources sheet, so a page counted as a "Review site"
 * here is counted the same way there.
 *
 * Deliberately conservative: a domain is only called a retailer, review site
 * or forum when it is on a known list (shared with brand detection in
 * brands.js, so the two never disagree) or carries an unmistakable marker in
 * its name. Everything else is "Other" — an honest unknown beats a confident
 * mislabel, because the owner acts on these groups ("get onto the review
 * sites that cite rivals").
 */
import { MARKETPLACE_DOMAINS, EDITORIAL_DOMAINS } from "./brands.js";

export const KIND_GROUPS = ["Your site", "Rival brand sites", "Review sites", "Retailers", "Forums & social", "Other"];

// Discussion and social platforms. Kept apart from EDITORIAL_DOMAINS's review
// and news sites (that list mixes both, because for brand detection they are
// all "not a product brand"); for citations the difference matters — a
// Reddit thread and a Gadgets360 review are won in different ways.
const FORUM_DOMAINS = new Set([
  "reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "x.com", "twitter.com",
  "facebook.com", "instagram.com", "linkedin.com", "pinterest.com", "tiktok.com", "youtube.com",
  "threads.net", "medium.com", "team-bhp.com", "xda-developers.com", "tripadvisor.com", "tripadvisor.in",
]);

// Retail markers beyond the shared marketplace list: Indian and global
// electronics and fashion chains the captures cite as places to buy.
const RETAIL_DOMAINS = new Set([
  "croma.com", "reliancedigital.in", "vijaysales.com", "tatacliq.com", "ajio.com", "nykaa.com",
  "bestbuy.com", "target.com", "costco.com", "argos.co.uk", "currys.co.uk", "newegg.com",
  "bigbasket.com", "blinkit.com", "zeptonow.com", "swiggy.com", "zomato.com",
]);

// Booking and travel sites: where a hotel, flight or stay is booked, so
// counted with the stores. Matched by name, whatever the country suffix
// (trivago.in, trivago.com). On a real "budget hotels" answer every one of
// these was "Other", or "Rival brand sites" once the answer named it, which
// read as if MakeMyTrip were a hotel chain competing with the owner's.
const BOOKING_SLUGS = new Set([
  "makemytrip", "goibibo", "booking", "agoda", "trivago", "ixigo", "oyorooms", "momondo", "hotelscombined",
  "hotels", "kayak", "cleartrip", "easemytrip", "expedia", "yatra", "airbnb", "skyscanner", "priceline",
  "hostelworld", "travelguru", "orbitz", "travelocity", "hotwire", "vrbo",
]);

export function normDomain(d) {
  return String(d || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^(www|m|en|in|amp)\./, "");
}

// The registrable part, minus the public suffix: "boat-lifestyle.com" ->
// "boatlifestyle", "sony.co.in" -> "sony", "in.jbl.com" -> "jbl".
function siteSlug(domain) {
  const parts = normDomain(domain).split(".").filter(Boolean);
  if (parts.length <= 1) return (parts[0] || "").replace(/[^a-z0-9]/g, "");
  const twoPartSuffix = /^(co|com|net|org|gov|ac|edu)$/.test(parts[parts.length - 2]) && parts.length >= 3;
  const label = twoPartSuffix ? parts[parts.length - 3] : parts[parts.length - 2];
  return label.replace(/[^a-z0-9]/g, "");
}

function inSet(set, domain) {
  const d = normDomain(domain);
  if (set.has(d)) return true;
  // Subdomains of a listed site ("old.reddit.com", "in.pinterest.com").
  for (const s of set) if (d.endsWith("." + s)) return true;
  return false;
}

/** Does this domain belong to the brand? Name-based, word-safe. */
export function isBrandSite(domain, brand, brandUrl) {
  const d = normDomain(domain);
  if (!d || !brand) return false;
  if (brandUrl) {
    const own = normDomain(brandUrl);
    if (own && (d === own || d.endsWith("." + own) || own.endsWith("." + d))) return true;
  }
  const slug = siteSlug(d);
  const key = String(brand).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key.length < 3 || !slug) return false;
  // "boat" in "boatlifestyle", "noise" in "gonoise", "sony" == "sony". The
  // slug must START or END with the brand so "apple" does not claim
  // "pineappleexpress".
  return slug === key || slug.startsWith(key) || slug.endsWith(key);
}

/**
 * @param {string} domain
 * @param {{ ownBrand?: string, ownUrl?: string, brands?: string[] }} ctx
 *   brands: every brand named or shown in this answer (rival brand sites).
 */
export function siteKindOf(domain, ctx = {}) {
  const d = normDomain(domain);
  if (!d) return "Other";
  if (ctx.ownBrand && isBrandSite(d, ctx.ownBrand, ctx.ownUrl)) return "Your site";
  if (inSet(FORUM_DOMAINS, d)) return "Forums & social";
  if (inSet(MARKETPLACE_DOMAINS, d) || inSet(RETAIL_DOMAINS, d) || BOOKING_SLUGS.has(siteSlug(d))) return "Retailers";
  if (inSet(EDITORIAL_DOMAINS, d)) return "Review sites";
  if ((ctx.brands || []).some((b) => b && b !== ctx.ownBrand && isBrandSite(d, b))) return "Rival brand sites";
  if (/(^|[.-])(forum|forums|community|discuss)\./.test(d)) return "Forums & social";
  if (/review|rating|gadget|tech|news|times|magazine|guide|digit|smartprix|mobile/i.test(siteSlug(d))) return "Review sites";
  return "Other";
}
