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

export async function gunzipToString(arrayBuffer) {
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}
