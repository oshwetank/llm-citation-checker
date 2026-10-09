/*
 * image-url.js — a second address for ChatGPT's product images.
 *
 * ChatGPT serves product thumbnails from images.openai.com/thumbnails/url/…,
 * and those were reported as blank boxes in the Analyze tab: the card drew its
 * border and background, and no picture. The path segment after "/url/" is
 * not opaque, though. It is a 4-character prefix, then base64url of one byte
 * followed by a zlib stream, and that stream holds the ORIGINAL image URL
 * (in every capture seen so far, a Google Shopping image on
 * encrypted-tbn*.gstatic.com). So when the thumbnail will not load, the page
 * can fall back to the image it was made from.
 *
 * Never throws: anything that does not decode cleanly returns null, and the
 * caller shows its no-image placeholder instead.
 */

const THUMB_RE = /^https:\/\/images\.openai\.com\/thumbnails\/url\/([A-Za-z0-9_-]+)/;

/**
 * @param {string} url  an images.openai.com thumbnail URL
 * @returns {Promise<string|null>} the https URL it was made from, or null
 */
export async function originalImageUrl(url) {
  try {
    const m = THUMB_RE.exec(String(url || ""));
    if (!m || typeof DecompressionStream === "undefined") return null;
    const bytes = base64UrlToBytes(m[1].slice(4));
    if (!bytes || bytes.length < 3) return null;
    const stream = new Blob([bytes.subarray(1)]).stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    // The URL follows a two-byte header; scan for it rather than trusting the
    // offset, and stop at the first byte that cannot be part of a URL.
    let text = "";
    for (const b of buf) text += b >= 0x21 && b <= 0x7e ? String.fromCharCode(b) : " ";
    const found = /https:\/\/[^\s]+/.exec(text);
    if (!found) return null;
    const out = new URL(found[0]);
    return out.protocol === "https:" ? out.href : null;
  } catch (_) {
    return null;
  }
}

function base64UrlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
