/*
 * campaignBundle.js — a campaign packed into one file, and unpacked on
 * another computer (0.82.0).
 *
 * Asked: "transfer a campaign to another person who can then run it on their
 * own system". The bundle carries the setup (brand, competitors, engines,
 * measures), the prompts with their tags, every finished run, the answers as
 * read, and the raw captures behind them, so Reprocess works on the other
 * side too. It works with no server: a .cito file. The 0.82 server only
 * stores the same bytes behind a short code.
 *
 * On import every id is new — campaign, prompts, runs, captures — so a bundle
 * can be imported twice, or into the computer it came from, without
 * overwriting anything. The links between them are kept.
 */
import { gzipString, gunzipToString } from "./gzip.js";
import { scrubUrls } from "./safeUrl.js";

export const BUNDLE_FORMAT = "citoskeleton-campaign";
export const BUNDLE_VERSION = 1;
// What the server takes, and a sane ceiling for a file: about 2,000 answers
// with their raw captures.
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const BUNDLE_EXT = ".cito";
// The most a campaign file may unpack to. Answers and settings pack about
// 10 to 1 and the raw captures inside are already packed, so a real 25 MB
// file stays well under this; see gunzipToString for why there is a limit.
export const MAX_UNPACKED_BYTES = 16 * MAX_BUNDLE_BYTES;

// ArrayBuffer ↔ base64 without Buffer, so it runs in the worker and in Node.
export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBuf(b64) {
  const s = atob(String(b64 || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

// Which records belong to a campaign: its answers, and the raw captures each
// answer was read from (merged copies included).
export function campaignParts(profileId, { prompts = [], runs = [], records = [], raws = [] } = {}) {
  const recs = records.filter((r) => r && r.geo && r.geo.profileId === profileId);
  const want = new Set(recs.flatMap((r) => [r.captureId, ...(r.mergedFrom || [])]));
  return {
    prompts: prompts.filter((p) => p.profileId === profileId),
    runs: runs.filter((r) => r.profileId === profileId),
    records: recs,
    raws: raws.filter((r) => want.has(r.captureId)),
  };
}

// The bundle as plain JSON. A run still going is sent as stopped: its answers
// so far are kept, and the other side can continue it.
export function makeBundle({ profile, prompts = [], runs = [], records = [], raws = [], appVersion = "", from = null, includeRaw = true }) {
  if (!profile || !profile.id) throw new Error("No campaign to share.");
  const { deletedAt, importedFrom, ...setup } = profile;
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    appVersion,
    exportedAt: Date.now(),
    from: from || null,
    profile: { ...setup, importedFrom: importedFrom || null },
    prompts,
    runs: runs.map((r) => (r.status === "running" ? { ...r, status: "stopped", finishedAt: r.finishedAt || Date.now() } : r)),
    records,
    raws: includeRaw ? raws.map(({ gz, ...row }) => ({ ...row, gz: gz ? bufToB64(gz) : null })) : [],
    counts: { prompts: prompts.length, runs: runs.length, answers: records.length, raws: includeRaw ? raws.length : 0 },
  };
}

export async function encodeBundle(bundle) {
  const gz = await gzipString(JSON.stringify(bundle));
  if (gz.byteLength > MAX_BUNDLE_BYTES) throw new Error(`This campaign is ${Math.ceil(gz.byteLength / 1048576)} MB packed, over the ${MAX_BUNDLE_BYTES / 1048576} MB limit. Share it without the raw captures.`);
  return gz;
}

// Reads a .cito file (gzipped JSON) or the JSON itself.
export async function decodeBundle(buf) {
  let text;
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer || buf);
  if (bytes.byteLength > MAX_BUNDLE_BYTES * 8) throw new Error("This file is too large to be a campaign.");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) text = await gunzipToString(bytes, MAX_UNPACKED_BYTES);
  else text = new TextDecoder().decode(bytes);
  let obj;
  try { obj = JSON.parse(text); } catch (_) { throw new Error("This isn't a CitoSkeleton campaign file."); }
  return checkBundle(obj);
}

export function checkBundle(obj) {
  if (!obj || obj.format !== BUNDLE_FORMAT) throw new Error("This isn't a CitoSkeleton campaign file.");
  if (!(obj.version >= 1)) throw new Error("This campaign file is damaged.");
  if (obj.version > BUNDLE_VERSION) throw new Error("This campaign was shared from a newer CitoSkeleton. Update the extension, then import it again.");
  if (!obj.profile || !obj.profile.id) throw new Error("This campaign file is damaged.");
  for (const k of ["prompts", "runs", "records", "raws"]) if (!Array.isArray(obj[k])) obj[k] = [];
  return obj;
}

/*
 * A record as the views expect it, whatever the file held (0.84.1).
 *
 * A campaign file is someone else's data. Records made here go through
 * schema.js (http(s) addresses only, known shapes); an imported one was
 * stored exactly as it came. In the 10 Nov 2026 audit a record whose source
 * address was "javascript:alert(document.domain)" survived import and came
 * out as a link in the exported HTML report, and one with no fan-out lists
 * crashed that export ("Cannot read properties of undefined"). So: every
 * address field that isn't http(s) is blanked (lib/safeUrl.js), and the
 * lists every view reads are lists.
 */
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
export function cleanImportedRecord(r) {
  const rec = JSON.parse(JSON.stringify(r)); // our own copy, plain data only
  scrubUrls(rec);
  rec.sources = listOf(rec.sources);
  const f = rec.fanout && typeof rec.fanout === "object" && !Array.isArray(rec.fanout) ? rec.fanout : {};
  rec.fanout = { ...f, search: listOf(f.search), shopping: listOf(f.shopping), image: listOf(f.image) };
  for (const k of ["products", "images", "places", "entities", "brandMentions"]) if (k in rec) rec[k] = listOf(rec[k]);
  for (const k of ["userPrompt", "answerText", "platform", "model"]) if (rec[k] != null && typeof rec[k] !== "string") rec[k] = String(rec[k]);
  if (rec.platformSpecific == null || typeof rec.platformSpecific !== "object" || Array.isArray(rec.platformSpecific)) rec.platformSpecific = {};
  return rec;
}
// The setup, prompts and runs: plain data, addresses checked the same way.
const cleanImported = (o) => { const c = JSON.parse(JSON.stringify(o)); scrubUrls(c); return c; };

// Unpacks with fresh ids. `newId` is injectable for tests.
export function readBundle(bundle, { newId = () => crypto.randomUUID(), now = Date.now(), name = null } = {}) {
  const b = checkBundle(bundle);
  b.records = b.records.filter((r) => r && typeof r === "object").map(cleanImportedRecord);
  b.profile = cleanImported(b.profile);
  b.prompts = b.prompts.filter((p) => p && typeof p === "object").map(cleanImported);
  b.runs = b.runs.filter((r) => r && typeof r === "object").map(cleanImported);
  b.raws = b.raws.filter((r) => r && typeof r === "object");
  const profileId = newId();
  const promptMap = new Map(b.prompts.map((p) => [p.id, newId()]));
  const runMap = new Map(b.runs.map((r) => [r.id, newId()]));
  const capMap = new Map();
  for (const r of [...b.records, ...b.raws]) if (r.captureId && !capMap.has(r.captureId)) capMap.set(r.captureId, newId());
  const geoOf = (g) => (g ? { ...g, profileId, runId: g.runId ? runMap.get(g.runId) || null : null, promptId: g.promptId ? promptMap.get(g.promptId) || null : null } : g);

  const profile = {
    ...b.profile,
    id: profileId,
    name: name || b.profile.name,
    deletedAt: null,
    importedFrom: { name: b.profile.name || "", by: (b.from && b.from.name) || "", exportedAt: b.exportedAt || null, importedAt: now, appVersion: b.appVersion || "" },
  };
  const prompts = b.prompts.map((p) => ({ ...p, id: promptMap.get(p.id), profileId }));
  const runs = b.runs.map((r) => ({ ...r, id: runMap.get(r.id), profileId, promptIds: (r.promptIds || []).map((id) => promptMap.get(id)).filter(Boolean) }));
  const records = b.records.map((r) => ({
    ...r,
    captureId: capMap.get(r.captureId),
    geo: geoOf(r.geo),
    // The other side's project runs mean nothing here.
    runId: null,
    projectId: null,
    ...(r.mergedFrom ? { mergedFrom: r.mergedFrom.map((id) => capMap.get(id)).filter(Boolean) } : {}),
  }));
  const raws = b.raws.filter((r) => r.gz).map((r) => ({ ...r, captureId: capMap.get(r.captureId), geo: geoOf(r.geo), runId: null, projectId: null, gz: b64ToBuf(r.gz) }));
  return { profile, prompts, runs, records, raws };
}

// A file name a person would recognise.
export function bundleFileName(profile, at = new Date()) {
  const base = String((profile && profile.name) || "campaign").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "campaign";
  return `${base}-${at.toISOString().slice(0, 10)}${BUNDLE_EXT}`;
}
