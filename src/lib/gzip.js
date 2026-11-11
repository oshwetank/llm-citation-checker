/*
 * gzip.js — compress/decompress strings with the native Compression Streams API.
 * Raw SSE text is highly compressible, so we store it gzipped to keep the raw
 * store small even with thousands of captures.
 */

export async function gzipString(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return buf; // ArrayBuffer — storable directly in IndexedDB
}

// The most one unpacked item may be: far above any real capture (a long
// answer's raw stream is a few MB) or campaign file.
export const MAX_GUNZIP_BYTES = 256 * 1024 * 1024;

/*
 * Unpacks to text, stopping at `maxBytes` (0.84.1).
 *
 * Before the limit this read the whole stream however large it grew. Gzip
 * packs repeated bytes about 1000 to 1, so a campaign file of a few MB, or
 * one raw capture inside it, could be written to unpack into gigabytes and
 * take the extension down on import or Reprocess (the 10 Nov 2026 audit).
 * The stream is read a piece at a time and cancelled the moment it passes
 * the limit, so the memory is never taken.
 */
export async function gunzipToString(arrayBuffer, maxBytes = MAX_GUNZIP_BYTES) {
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* already closed */ }
      throw new Error("This file unpacks to more than it should. It may be damaged, or made to overload the extension.");
    }
    chunks.push(value);
  }
  return await new Blob(chunks).text();
}
