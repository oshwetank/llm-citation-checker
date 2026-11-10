/*
 * protoStrings.js — the text inside Gemini's WebChannel traffic (0.62.2).
 *
 * Gemini moved its answer off StreamGenerate onto a Google WebChannel at
 * geminiweb-pa.clients6.google.com/v1/processSession (the owner's HAR, 18
 * Oct 2026): the prompt goes up as a form field "req0___data__" holding
 * base64 protobuf ("best 5star ac for home" decodes out of it), and the
 * answer comes down a long-lived GET whose frames are "<length>\n<JSON>"
 * arrays carrying more of the same. There is no schema to read the protobuf
 * with, so this walks its wire format and keeps what reads as text: the
 * prompt, answer pieces and addresses. It is the groundwork for a Gemini
 * reader; content-main.js keeps the traffic as probes until that lands.
 */

/** Every protobuf field's printable string, in order, recursing into nested messages. */
export function protoStrings(bytes, { min = 3, depth = 0 } = {}) {
  const out = [];
  if (!bytes || depth > 12) return out;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dec = new TextDecoder("utf-8", { fatal: true });
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0;
    for (;;) {
      if (i >= b.length || shift > 49) throw new Error("bad varint");
      const x = b[i++];
      v += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return v;
      shift += 7;
    }
  };
  try {
    while (i < b.length) {
      const key = varint();
      const type = key % 8;
      if (key < 8) throw new Error("bad field");
      if (type === 0) varint();
      else if (type === 1) i += 8;
      else if (type === 5) i += 4;
      else if (type === 2) {
        const len = varint();
        if (len < 0 || i + len > b.length) throw new Error("bad length");
        const part = b.subarray(i, i + len);
        i += len;
        // A nested message reads cleanly to its end; anything else may be text.
        const inner = (() => { try { return protoStrings(part, { min, depth: depth + 1 }); } catch (_) { return null; } })();
        if (inner && inner.length) { out.push(...inner); continue; }
        let text = null;
        try { text = dec.decode(part); } catch (_) { text = null; }
        if (text && text.length >= min && printable(text)) out.push(text);
      } else throw new Error("bad wire type");
    }
  } catch (e) {
    if (depth > 0) throw e; // not a message after all; the caller reads it as text
  }
  return out;
}

const printable = (t) => {
  let ok = 0;
  for (const ch of t) if (/[\p{L}\p{N}\p{P}\p{Zs}\n\t₹$€£]/u.test(ch)) ok++;
  return ok / [...t].length > 0.9;
};

const fromBase64 = (s) => {
  try {
    const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch (_) { return null; }
};

/** The strings in a WebChannel upload ("count=1&ofs=1&req0___data__=<base64>"). */
export function formStrings(body) {
  const out = [];
  try {
    new URLSearchParams(String(body || "")).forEach((v, k) => {
      if (!/^req\d+___data__$/.test(k)) return;
      const bytes = fromBase64(v);
      if (bytes) out.push(...protoStrings(bytes));
    });
  } catch (_) { /* not a form */ }
  return out;
}

/** WebChannel down-channel frames: "<length>\n<JSON>" one after another. */
export function webChannelFrames(text) {
  const frames = [];
  const s = String(text || "");
  let i = 0;
  while (i < s.length) {
    const m = /^\s*(\d+)\n/.exec(s.slice(i, i + 20));
    if (!m) break;
    i += m[0].length;
    const n = Number(m[1]);
    const chunk = s.slice(i, i + n);
    i += n;
    try { frames.push(JSON.parse(chunk)); } catch (_) { /* a partial frame at the end of a slice */ }
  }
  return frames;
}

/** Every string in the frames: plain ones, and those inside base64 protobuf. */
export function channelStrings(text) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const bytes = v.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) ? fromBase64(v) : null;
      const inner = bytes ? protoStrings(bytes) : [];
      if (inner.length) out.push(...inner);
      else if (v.length >= 3) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  webChannelFrames(text).forEach(walk);
  return out;
}
