/*
 * geminiChannel.js — Gemini's answer read from its WebChannel (0.66.0).
 *
 * Gemini stopped sending StreamGenerate. The answer now comes down a
 * long-lived GET to geminiweb-pa.clients6.google.com/v1/processSession
 * (RID=rpc, TYPE=xmlhttp) as "<length>\n<JSON>" frames, each data frame
 * [[id, ["<base64 protobuf>"]]]. The text is cumulative: every frame repeats
 * the answer so far, so the last frame of a response holds all of it. The
 * prompt goes up in a POST to the same path, as base64 protobuf in the form
 * field req0___data__.
 *
 * There is no schema, so the fields were mapped from the owner's probes (18
 * Oct 2026, a shopping answer with sources and product cards). Paths are
 * dotted field numbers from the frame's root:
 *
 *   2.7.1.4.4            the response
 *     .2.1 / .2.2        conversation c_… / response r_…
 *     .5.2.1             answer markdown
 *     .5.13.16           a product card: .1.1 placeholder address, .4.11 name,
 *                        .4.13 Google Shopping address, .4.14 price,
 *                        .4.15 description, .4.17 rating, .4.21 brand,
 *                        .4.24.1 offers (.1 store, .5 price, .7 was, .11 address)
 *     .5.38.2            "Searched the web": .2 label, .8 pages (.2 address, .3 title)
 *     .6.1               the place Gemini thinks you are in
 *     .9                 country
 *     .43                model ("3.6 Flash")
 *   upload 1.8.5.1.1.1   the prompt
 *
 * Anything that doesn't read as one of these is left alone; an answer that
 * reads as nothing returns null, so the caller can keep it as a probe.
 */

const dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: true }) : null;

/** One level of a protobuf message: [[field, wireType, value]], or null if it isn't one. */
export function protoFields(bytes) {
  const b = bytes;
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0, shift = 0;
    for (;;) {
      if (i >= b.length || shift > 63) throw new Error("varint");
      const x = b[i++];
      v += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return v;
      shift += 7;
    }
  };
  try {
    while (i < b.length) {
      const key = varint();
      const f = Math.floor(key / 8), t = key % 8;
      if (f < 1) return null;
      if (t === 0) out.push([f, 0, varint()]);
      else if (t === 1) { if (i + 8 > b.length) return null; i += 8; }
      else if (t === 5) { if (i + 4 > b.length) return null; i += 4; }
      else if (t === 2) {
        const len = varint();
        if (i + len > b.length) return null;
        out.push([f, 2, b.subarray(i, i + len)]);
        i += len;
      } else return null;
    }
  } catch (_) { return null; }
  return out;
}

const text = (v) => {
  if (!(v instanceof Uint8Array) || !dec) return null;
  try { return dec.decode(v); } catch (_) { return null; }
};

/** Every value at a dotted path ("2.7.1"), as raw bytes or numbers. Repeated fields give several. */
export function protoAt(bytes, path) {
  const steps = String(path).split(".").map(Number);
  let level = [bytes];
  for (const f of steps) {
    const next = [];
    for (const node of level) {
      if (!(node instanceof Uint8Array)) continue;
      const fields = protoFields(node);
      if (!fields) continue;
      for (const [n, , v] of fields) if (n === f) next.push(v);
    }
    level = next;
    if (!level.length) break;
  }
  return level;
}

const str = (bytes, path) => {
  for (const v of protoAt(bytes, path)) { const s = text(v); if (s) return s; }
  return null;
};
const strs = (bytes, path) => protoAt(bytes, path).map(text).filter(Boolean);

function b64(s) {
  try {
    const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
  } catch (_) { return null; }
}

/** WebChannel frames, "<length>\n<JSON>" one after another; a cut-off last frame is skipped. */
export function channelFrames(raw) {
  const s = String(raw || "");
  const frames = [];
  let i = 0;
  while (i < s.length) {
    const m = /^\s*(\d+)\n/.exec(s.slice(i, i + 24));
    if (!m) break;
    i += m[0].length;
    const n = Number(m[1]);
    try { frames.push(JSON.parse(s.slice(i, i + n))); } catch (_) { /* partial */ }
    i += n;
  }
  return frames;
}

/** True when a capture's raw text is WebChannel frames rather than StreamGenerate. */
export function isChannelText(raw) {
  return /^\s*\d+\n\[\[\d+,/.test(String(raw || "").slice(0, 64));
}

/** The base64 protobuf payloads of the data frames, in order ("noop" and control frames skipped). */
export function channelPayloads(raw) {
  const out = [];
  for (const frame of channelFrames(raw)) {
    for (const entry of Array.isArray(frame) ? frame : []) {
      const arr = Array.isArray(entry) ? entry[1] : null;
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        if (typeof v !== "string" || v === "noop" || v.length < 16) continue;
        const bytes = b64(v);
        if (bytes && protoFields(bytes)) out.push(bytes);
      }
    }
  }
  return out;
}

/*
 * A map card's place, read off the stream (1.0.2). Gemini's answer names a
 * place with <EntityCard entity_id="ChIJ…" entity_type="place" title="…"/>;
 * its rating and kind come in the same stream just before "places/<that id>"
 * ("4.7 stars rating", "🏨 Resort hotel"). Only the title was kept, so a
 * hotel answer's six places had no rating or kind (live run, 22 Nov 2026).
 * Read as text from the decoded payloads, not by field number: these
 * records' layout isn't mapped, and the words are what the card shows.
 */
// Every text field of a protobuf payload, in order, at any depth: a field
// that decodes as clean text is a string, any other one a message to open.
// Exact strings, without the length and tag bytes a loose decode leaves on
// them ("LBhawani Singh Rd…302015b").
function protoStrings(bytes, out = [], depth = 0) {
  const fields = depth < 40 ? protoFields(bytes) : null;
  if (!fields) return out;
  for (const [, t, v] of fields) {
    if (t !== 2) continue;
    const s = text(v);
    if (s && s.length && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) { out.push(s); continue; }
    protoStrings(v, out, depth + 1);
  }
  return out;
}

export function channelPlaceDetails(raw) {
  let text = "";
  try { text = channelPayloads(raw).map((b) => protoStrings(b).join("\u0001")).join("\u0001"); } catch (_) { text = ""; }
  return (id) => {
    if (!text || !id) return {};
    const marker = `places/${id}`;
    for (let k = text.indexOf(marker); k >= 0; k = text.indexOf(marker, k + 1)) {
      const win = text.slice(Math.max(0, k - 900), k);
      const ratings = [...win.matchAll(/(\d(?:\.\d)?) stars rating/g)];
      if (!ratings.length) continue;
      const rating = Number(ratings[ratings.length - 1][1]);
      const kinds = [...win.slice(ratings[ratings.length - 1].index).matchAll(/\p{Extended_Pictographic}️?\s([\p{L}][\p{L}\p{N} &'’/-]{1,40}?)(?=[^\p{L}\p{N} &'’/-]|$)/gu)];
      const category = kinds.length ? kinds[0][1].trim() : null;
      return { rating: rating >= 0 && rating <= 5 ? rating : null, category, ...placeExtras(text, k, id, win) };
    }
    return {};
  };
}

/*
 * The rest of a map card (1.0.2): its photo (just before the name), then
 * after "places/<id>" its phone, address, Maps link, website and one-line
 * description, its hours, and the reviews filed under "places/<id>/reviews/…"
 * (age, then text). Same live run: all of it was in the stream and none was
 * stored. Text pieces are separated by protobuf's control bytes; a piece's
 * first character can be its own length byte, which is dropped when it isn't
 * part of a word.
 */
const PIECE_SPLIT = /[\x00-\x1f\x7f-\x9f\ufffd]+/;
const pieceText = (p) => String(p || "").replace(/^[^\p{L}\p{N}"“(]+/u, "").trim();
function placeExtras(text, k, id, before) {
  const out = {};
  const photo = [...before.matchAll(/https:\/\/lh\d\.googleusercontent\.com\/(?:p|gps-cs-s|gps-proxy)\/[A-Za-z0-9_\-=]+/g)].pop();
  if (photo) out.photo = photo[0].replace(/(=w\d+-h\d+(?:-k-no)?)[\s\S]*$/, "$1");
  const reviewsAt = text.indexOf(`places/${id}/reviews/`, k);
  const head = text.slice(k, reviewsAt > k && reviewsAt - k < 4000 ? reviewsAt : k + 2500);
  const pieces = head.split(PIECE_SPLIT).map(pieceText).filter(Boolean);
  const phone = head.match(/(?:\+\d{1,3}[ -]?)?\(?\d{2,5}\)?[ -]?\d{3,5}[ -]?\d{3,5}/);
  if (phone) out.phone = phone[0].trim();
  const address = pieces.find((p) => (p.match(/,/g) || []).length >= 2 && p.length >= 15 && p.length <= 200 && !/^https?:/.test(p));
  if (address) out.address = address.replace(/^[\d +()-]{7,}\D?(?=\p{L})/u, "").replace(/[^\p{L}\p{N})]+$/u, "");
  const urls = head.match(/https?:\/\/[^\s\x00-\x1f"·]+/g) || [];
  const maps = urls.find((u) => /google\.[a-z.]+\/maps\/place/.test(u));
  if (maps) out.mapsUrl = maps;
  const site = urls.find((u) => !/google\.|gstatic\.|googleusercontent\./.test(u));
  if (site) out.website = site;
  const hours = head.match(/Open 24 hours|Opens? (?:at )?\d{1,2}(?::\d{2})?\s?[AP]M(?: \w{3})?|Closes? (?:at )?\d{1,2}(?::\d{2})?\s?[AP]M(?: \w{3})?|Closed(?: now| today)?/);
  if (hours) out.hours = hours[0];
  // The description: the last sentence-like piece before the reviews. A
  // week's hours ("Mon-Sat: 10AM - 6PM, Sun: Closed") are the hours; the
  // name said again is not a description. A lone framing letter stuck to
  // the front ("bUpscale hotel…") is dropped.
  const unframe = (s) => s.replace(/^[A-Za-z](?=\p{Lu}\p{Ll})/u, "");
  const earlier = new Set(pieces.slice(0, -1).map((p) => p.toLowerCase()));
  for (const p of pieces.filter((x) => x.length >= 20 && /\s/.test(x) && !/^https?:|places\//.test(x) && x !== address).reverse()) {
    const s = unframe(p);
    if (/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s*[-–:]/.test(s) && /\d\s?[AP]M/i.test(s)) { out.hours = s.slice(0, 120); continue; }
    if (earlier.has(s.toLowerCase()) || /\|/.test(s)) continue;
    out.description = s.slice(0, 300);
    break;
  }
  if (reviewsAt > k) {
    const reviews = [];
    const tail = text.slice(reviewsAt, reviewsAt + 12000);
    for (const m of tail.matchAll(new RegExp(`places/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/reviews/[A-Za-z0-9_-]+`, "g"))) {
      const after = tail.slice(m.index + m[0].length, m.index + m[0].length + 2500).split(PIECE_SPLIT).map(pieceText).filter(Boolean);
      const age = after.find((p) => /^(?:\d+|a|an) (?:years?|months?|weeks?|days?|hours?) ago/.test(p));
      const body = after.find((p) => p.length >= 40 && /\s/.test(p) && !/^https?:/.test(p));
      if (body) reviews.push({ text: body.slice(0, 400), ...(age ? { age: age.match(/^(?:\d+|a|an) \w+ ago/)[0] } : {}) });
      if (reviews.length >= 3) break;
    }
    if (reviews.length) out.reviews = reviews;
  }
  return out;
}

const RESP = "2.7.1.4.4";

function readProducts(resp) {
  const out = [];
  for (const card of protoAt(resp, "5.13.16")) {
    const name = str(card, "4.11");
    if (!name) continue;
    const offers = protoAt(card, "4.24.1").map((o) => ({
      merchant: str(o, "1"),
      price: str(o, "5"),
      originalPrice: str(o, "7"),
      url: str(o, "11"),
    })).filter((o) => o.merchant || o.url);
    const rating = Number(str(card, "4.17"));
    out.push({
      name,
      price: str(card, "4.14"),
      brand: str(card, "4.21"),
      rating: isFinite(rating) && rating > 0 ? rating : null,
      description: str(card, "4.15"),
      shoppingUrl: str(card, "4.13"),
      placeholder: str(card, "1.1"),
      merchant: str(card, "4.28") || (offers[0] && offers[0].merchant) || null,
      offers,
      images: strs(card, "4.16.1.1.1").filter((u) => /^https?:/.test(u)).slice(0, 4),
    });
  }
  return out;
}

function readSources(resp) {
  const out = [];
  const seen = new Set();
  const groups = protoAt(resp, "5.38.2");
  for (const g of groups) {
    const label = str(g, "2") || str(g, "6");
    for (const page of protoAt(g, "8")) {
      const url = str(page, "2");
      if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, title: str(page, "3"), favicon: str(page, "1"), via: label });
    }
  }
  return { sources: out, searchLabels: [...new Set(groups.map((g) => str(g, "2") || str(g, "6")).filter(Boolean))] };
}

/** One response read from a payload, or null when it carries no answer. */
export function readResponse(payload) {
  const resp = protoAt(payload, RESP)[0];
  if (!(resp instanceof Uint8Array)) return null;
  const answer = str(resp, "5.2.1");
  if (!answer) return null;
  const { sources, searchLabels } = readSources(resp);
  return {
    conversationId: str(resp, "2.1"),
    responseId: str(resp, "2.2") || str(payload, "2.7.1.2.1"),
    candidateId: str(resp, "5.1"),
    answer,
    sources,
    searchLabels,
    products: readProducts(resp),
    location: str(resp, "6.1"),
    country: str(resp, "9"),
    model: str(resp, "43"),
  };
}

/**
 * The finished answer in a stretch of the down-channel. A stream can carry
 * more than one response; the last response's longest frame wins, since the
 * text only grows.
 */
export function readGeminiChannel(raw) {
  let last = null;
  for (const p of channelPayloads(raw)) {
    const r = readResponse(p);
    if (!r) continue;
    if (last && r.responseId && last.responseId && r.responseId !== last.responseId) { last = r; continue; }
    if (!last || r.answer.length >= last.answer.length || r.sources.length > last.sources.length) last = r;
  }
  return last;
}

// Every length-delimited field that reads as text, depth first.
function longestText(bytes, depth = 0) {
  let best = null;
  if (depth > 8) return null;
  let fields;
  try { fields = protoFields(bytes); } catch (_) { return null; }
  for (const [, , value] of fields || []) {
    if (!(value instanceof Uint8Array)) continue;
    // The innermost text wins: an outer field's bytes can decode too, with
    // the inner field's length byte in front ("$which biscuit…").
    const inner = longestText(value, depth + 1);
    const t = inner ? null : text(value);
    const found = inner || (t && /\s/.test(t.trim()) && /^[^\u0000-\u001f\ufffd]+$/.test(t) ? t : null);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

/** The prompt in an up-channel form body ("count=…&req0___data__=<base64>"). */
export function channelPrompt(body) {
  let prompt = null;
  try {
    new URLSearchParams(String(body || "")).forEach((v, k) => {
      if (prompt || !/^req\d+___data__$/.test(k)) return;
      const bytes = b64(v);
      if (!bytes) return;
      // 1.8.5.1.1.1 until Nov 2026; then 2.9.1 (the owner's capture of 13
      // Nov 2026 had no prompt). Failing both, the longest piece of text in
      // the upload with a space in it: a question, not an id or a token.
      prompt = str(bytes, "1.8.5.1.1.1") || str(bytes, "2.9.1") || longestText(bytes);
    });
  } catch (_) { /* not a form */ }
  return prompt ? prompt.trim() : null;
}

/**
 * Is this Debug-capture probe one the reader already understands (0.69.0)?
 * Since 0.66.0 the WebChannel's prompt upload and its RID=rpc answer stream
 * are read into answers, so keeping them as "payloads it couldn't read" only
 * buried the probes that matter (batchexecute calls, unknown shapes). A
 * stream whose frames don't read as an answer is still kept.
 */
export function probeIsRead(p) {
  const url = String((p && p.url) || "");
  if (!/\/v1\/processSession\b/.test(url)) return false;
  const method = String((p && p.method) || "GET").toUpperCase();
  if (method === "POST") return !!channelPrompt(p.reqBody) || !/req\d+___data__=/.test(String(p.reqBody || ""));
  if (!/[?&]RID=rpc\b/.test(url)) return false;
  const r = readGeminiChannel(String(p.body || ""));
  return !!(r && r.answer);
}
