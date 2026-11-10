/*
 * campaign-bundle.test.mjs — a campaign packed into a file and unpacked with
 * new ids, links kept (0.82.0). Made-up brands throughout.
 */
import { campaignParts, makeBundle, encodeBundle, decodeBundle, readBundle, checkBundle, bundleFileName, bufToB64, b64ToBuf, BUNDLE_VERSION } from "../src/lib/campaignBundle.js";
import { gzipString, gunzipToString } from "../src/lib/gzip.js";
import { makeProfile, cloudLink } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const P = "prof-zento";
const profile = { id: P, name: "Zento", brand: { name: "Zento", url: "zento.example" }, competitors: [{ name: "Kovo" }], engines: ["chatgpt", "gemini"], locked: true, deletedAt: null };
const prompts = [
  { id: "p1", profileId: P, text: "best lamp for reading", tags: ["lamps", "reading"] },
  { id: "p2", profileId: P, text: "zento vs kovo", tags: ["compare"] },
  { id: "px", profileId: "other", text: "not this campaign", tags: [] },
];
const runs = [
  { id: "r1", profileId: P, status: "done", promptIds: ["p1", "p2"], engines: ["chatgpt"] },
  { id: "r2", profileId: P, status: "running", promptIds: ["p1"], engines: ["gemini"] },
  { id: "rx", profileId: "other", status: "done", promptIds: ["px"] },
];
const records = [
  { captureId: "c1", platform: "chatgpt", userPrompt: "best lamp for reading", geo: { profileId: P, runId: "r1", promptId: "p1", tags: ["lamps"] }, mergedFrom: ["c1b"], runId: "proj-run", brandMentions: [{ brand: "Zento", count: 2 }] },
  { captureId: "c2", platform: "chatgpt", userPrompt: "zento vs kovo", geo: { profileId: P, runId: "r1", promptId: "p2", tags: [] } },
  { captureId: "c3", platform: "gemini", userPrompt: "best lamp for reading", geo: { profileId: P, runId: "r2", promptId: "p1", tags: [] } },
  { captureId: "cx", platform: "chatgpt", userPrompt: "manual", geo: null },
];
const raws = [];
for (const id of ["c1", "c1b", "c2", "c3", "cx"]) raws.push({ captureId: id, platform: "chatgpt", gz: await gzipString(`raw text of ${id}`), geo: id === "cx" ? null : { profileId: P, runId: "r1", promptId: "p1" } });

console.log("\nwhat belongs to the campaign");
const parts = campaignParts(P, { prompts, runs, records, raws });
check("its prompts, runs and answers only", parts.prompts.length === 2 && parts.runs.length === 2 && parts.records.length === 3);
check("the raw captures behind them, merged copies included", parts.raws.map((r) => r.captureId).sort().join() === "c1,c1b,c2,c3");

console.log("\npacking");
const bundle = makeBundle({ profile, ...parts, appVersion: "0.82.0", from: { name: "Asha" } });
check("versioned", bundle.format === "citoskeleton-campaign" && bundle.version === BUNDLE_VERSION && bundle.appVersion === "0.82.0");
check("a run still going goes as stopped", bundle.runs.find((r) => r.id === "r2").status === "stopped");
check("counts", bundle.counts.answers === 3 && bundle.counts.raws === 4);
check("raw captures as text", typeof bundle.raws[0].gz === "string");
const lite = makeBundle({ profile, ...parts, includeRaw: false });
check("raw captures can be left out", lite.raws.length === 0);
const file = await encodeBundle(bundle);
check("a gzipped file", new Uint8Array(file)[0] === 0x1f && file.byteLength < 20000, file.byteLength);
const back = await decodeBundle(file);
check("reads back", back.records.length === 3 && back.profile.name === "Zento");
const plain = await decodeBundle(new TextEncoder().encode(JSON.stringify(bundle)));
check("plain JSON reads too", plain.prompts.length === 2);

console.log("\nunpacking, with new ids");
let n = 0;
const out = readBundle(back, { newId: () => `new-${++n}`, now: 1000 });
const ids = new Set([out.profile.id, ...out.prompts.map((p) => p.id), ...out.runs.map((r) => r.id), ...out.records.map((r) => r.captureId)]);
check("every id is new", [...ids].every((id) => id.startsWith("new-")) && ids.size === 1 + 2 + 2 + 3);
check("prompts point at the new campaign, tags kept", out.prompts.every((p) => p.profileId === out.profile.id) && out.prompts[0].tags.join() === "lamps,reading");
const r1 = out.runs.find((r) => r.engines.join() === "chatgpt");
check("runs keep their prompts", r1.promptIds.length === 2 && r1.promptIds.every((id) => out.prompts.some((p) => p.id === id)));
const a1 = out.records.find((r) => r.userPrompt === "best lamp for reading" && r.platform === "chatgpt");
check("answers keep their run and prompt", a1.geo.profileId === out.profile.id && a1.geo.runId === r1.id && out.prompts.find((p) => p.id === a1.geo.promptId).text === "best lamp for reading");
check("and their merged copies", a1.mergedFrom.length === 1 && out.raws.some((r) => r.captureId === a1.mergedFrom[0]));
check("the other side's project run is dropped", a1.runId === null);
check("raw captures unpack to what was stored", (await gunzipToString(out.raws.find((r) => r.captureId === a1.captureId).gz)) === "raw text of c1");
check("says where it came from", out.profile.importedFrom.name === "Zento" && out.profile.importedFrom.by === "Asha" && out.profile.deletedAt === null);
const again = readBundle(back);
check("importing twice gives two separate campaigns", again.profile.id !== out.profile.id && again.records[0].captureId !== out.records[0].captureId);

console.log("\nbad files");
const err = async (f) => { try { await f(); return ""; } catch (e) { return e.message; } };
check("not a campaign", /isn't a CitoSkeleton campaign/.test(await err(() => decodeBundle(new TextEncoder().encode("{\"hello\":1}")))));
check("not JSON", /isn't a CitoSkeleton campaign/.test(await err(() => decodeBundle(new TextEncoder().encode("lol")))));
check("from a newer version", /newer CitoSkeleton/.test(await err(() => checkBundle({ ...bundle, version: BUNDLE_VERSION + 1 }))));
check("no campaign inside", /damaged/.test(await err(() => checkBundle({ ...bundle, profile: null }))));

console.log("\nsmall things");
check("base64 round trip", new Uint8Array(b64ToBuf(bufToB64(new Uint8Array([0, 255, 7]).buffer))).join() === "0,255,7");
check("a readable file name", bundleFileName({ name: "Zento · Lamps!" }, new Date("2026-10-27T10:00:00Z")) === "Zento-Lamps-2026-10-27.cito");

console.log("\nthe profile link (0.85.0)");
{
  const link = { id: "c-9", localId: "p-1", version: 4, savedAt: 1700000000000, mine: true, autoSave: true };
  const p = makeProfile({ id: "p-1", name: "Zento", cloud: link });
  check("a campaign keeps its link", p.cloud && p.cloud.id === "c-9" && p.cloud.version === 4 && p.cloud.autoSave === true && p.cloud.copy === false);
  check("and keeps it through an edit", makeProfile({ ...p, name: "Zento AU", competitors: [{ name: "Kovo" }] }).cloud.id === "c-9");
  check("no link, or a link without an id, is null", makeProfile({}).cloud === null && cloudLink({ version: 2 }) === null);
  const b = makeBundle({ profile: p, prompts: [], runs: [], records: [], raws: [] });
  check("a shared file never carries the link", !("cloud" in b.profile));
  check("so an imported file starts unlinked", readBundle(b, { newId: (() => { let i = 0; return () => `n${++i}`; })() }).profile.cloud === undefined);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
