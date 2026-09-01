/*
 * zipWrite.js — the smallest ZIP WRITER that produces an archive every OS
 * unzips: local headers, a central directory, and an end-of-central-directory
 * record. No zip64, no encryption, no directory entries.
 *
 * It exists because the feedback bundle (lib/feedbackBundle.js) has to reach
 * the developer as ONE attachment holding four different things — a printable
 * report, the raw payload, the derived analysis, and the reporter's note.
 * Handing someone four separate downloads and asking them to keep the set
 * together is how half a bug report goes missing.
 *
 * xlsxLite.js already reads zips, and deliberately leans on the platform's
 * DecompressionStream rather than vendoring an inflate. This is the mirror
 * image: CompressionStream('deflate-raw') does the compression, and when it
 * isn't available the entry is STORED instead. A stored entry is still a
 * perfectly valid zip — the archive gets bigger, never broken.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  // Chrome has had CompressionStream since 80; this keeps working (uncompressed)
  // anywhere it is missing rather than failing the whole bundle.
  if (typeof CompressionStream !== "function") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch (_) {
    return null;
  }
}

// DOS date/time. Anything before 1980 is unrepresentable, so it is clamped
// rather than written as a negative year that some unzippers reject.
function dosDateTime(date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/**
 * @param {Array<{name:string, text?:string, bytes?:Uint8Array}>} files
 * @param {Date} [now]
 * @returns {Promise<Blob>} a zip archive
 */
export async function makeZip(files, now) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks = [];      // archive body, in order
  const central = [];     // central-directory records
  let offset = 0;

  for (const f of files || []) {
    const name = String((f && f.name) || "").replace(/^\/+/, "");
    if (!name) continue;
    const raw = f.bytes instanceof Uint8Array ? f.bytes : enc.encode(String(f.text ?? ""));
    const nameBytes = enc.encode(name);
    const sum = crc32(raw);

    const packed = await deflateRaw(raw);
    // Only worth compressing if it actually came out smaller.
    const useDeflate = !!packed && packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0, true);           // flags
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);          // extra length
    chunks.push(new Uint8Array(local.buffer), nameBytes, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);             // version made by
    cd.setUint16(6, 20, true);             // version needed
    cd.setUint16(8, 0, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, sum, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);             // extra
    cd.setUint16(32, 0, true);             // comment
    cd.setUint16(34, 0, true);             // disk number start
    cd.setUint16(36, 0, true);             // internal attrs
    cd.setUint32(38, 0, true);             // external attrs
    cd.setUint32(42, offset, true);        // offset of local header
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = central.length / 2;
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}
