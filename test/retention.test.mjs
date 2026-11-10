/*
 * retention.test.mjs — the retention cap must never delete campaign data.
 *
 * Reported symptom: running a large prompt set, "prompts missing" from the
 * results. One real cause found in enforceRetention(): it pruned purely by
 * age, oldest first, with no idea what it was deleting. The default cap is
 * 2000 captures and a 1000-prompt run across two engines produces exactly
 * 2000 — so once the store filled, every new capture deleted the oldest,
 * which by then were that same run's OWN earlier results. The run
 * cannibalised itself, and the gap looked like a capture failure rather than
 * a deletion.
 *
 * isPrunableCapture() is the policy: only ad-hoc captures (no `geo`
 * provenance bag) are disposable. This tests the policy directly, plus the
 * arithmetic of "how many would be deleted" against a realistic mixed store,
 * because that arithmetic is what decides whether a run survives.
 */
import { isPrunableCapture, retentionVictims } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nisPrunableCapture: only ad-hoc browsing captures are disposable");
{
  check("an ad-hoc capture (geo: null) is prunable",
    isPrunableCapture({ captureId: "a", geo: null }) === true);
  check("a capture with no geo KEY at all (legacy record) is prunable",
    isPrunableCapture({ captureId: "b" }) === true);
  check("a campaign capture is NOT prunable",
    isPrunableCapture({ captureId: "c", geo: { profileId: "p1", runId: "r1", promptId: "q1" } }) === false);
  check("a campaign capture with only a runId is still NOT prunable",
    isPrunableCapture({ captureId: "d", geo: { runId: "r1" } }) === false);
  check("null/undefined input is not prunable (never delete on a bad read)",
    isPrunableCapture(null) === false && isPrunableCapture(undefined) === false);
}

console.log("\nthe reported scenario: a 1000-prompt x 2-engine run against the 2000 cap");
{
  // Exactly the shape that broke: the store already holds some ad-hoc
  // browsing captures, then a full campaign run lands on top of them.
  const CAP = 2000;
  const adhocBefore = 250;
  const campaignCaptures = 2000; // 1000 prompts x 2 engines

  const store = [];
  for (let i = 0; i < adhocBefore; i++) store.push({ captureId: `adhoc-${i}`, capturedAt: i, geo: null });
  for (let i = 0; i < campaignCaptures; i++) {
    store.push({ captureId: `run-${i}`, capturedAt: adhocBefore + i, geo: { profileId: "p1", runId: "r1", promptId: `q${i}` } });
  }

  // Reproduce enforceRetention's selection: walk oldest-first, collect only
  // prunable keys, stop once we have (count - cap) of them.
  const need = store.length - CAP;
  const selected = [];
  for (const rec of store) {                 // store is already oldest-first
    if (selected.length >= need) break;
    if (isPrunableCapture(rec)) selected.push(rec.captureId);
  }

  check("the store genuinely exceeds the cap, so pruning does run",
    store.length > CAP, `${store.length} > ${CAP}`);
  check("it wants to delete exactly the overflow count",
    need === 250, String(need));
  check("every capture it selected is ad-hoc — zero campaign captures deleted",
    selected.every((id) => id.startsWith("adhoc-")), selected.filter((id) => !id.startsWith("adhoc-")).slice(0, 5).join(","));
  check("all 2000 campaign captures survive intact (the actual bug)",
    store.filter((r) => !isPrunableCapture(r)).length === 2000,
    String(store.filter((r) => !isPrunableCapture(r)).length));

  // The old behaviour, for contrast: blind age-ordered pruning takes the
  // oldest 250 regardless — which here is all 250 ad-hoc records, so this
  // particular mix survives by luck. Shift the mix so the run is older than
  // some browsing and the loss is unavoidable without the predicate.
  const store2 = [];
  for (let i = 0; i < campaignCaptures; i++) {
    store2.push({ captureId: `run-${i}`, capturedAt: i, geo: { profileId: "p1", runId: "r1", promptId: `q${i}` } });
  }
  for (let i = 0; i < 250; i++) store2.push({ captureId: `adhoc-${i}`, capturedAt: campaignCaptures + i, geo: null });

  const blind = store2.slice(0, store2.length - CAP).map((r) => r.captureId);
  check("BLIND age-based pruning would have destroyed campaign captures here",
    blind.some((id) => id.startsWith("run-")), `blind would delete: ${blind.slice(0, 3).join(",")}…`);

  const safe = [];
  for (const rec of store2) {
    if (safe.length >= store2.length - CAP) break;
    if (isPrunableCapture(rec)) safe.push(rec.captureId);
  }
  check("the predicate skips past them and takes ad-hoc records instead",
    safe.length > 0 && safe.every((id) => id.startsWith("adhoc-")), safe.slice(0, 3).join(","));
}

console.log("\na store made up ONLY of campaign captures");
{
  // Deliberate, documented trade: nothing is deleted, the store grows past
  // the cap. Losing measurement data is worse than using disk, and
  // unlimitedStorage is already granted.
  const CAP = 50;
  const store = [];
  for (let i = 0; i < 120; i++) store.push({ captureId: `run-${i}`, capturedAt: i, geo: { runId: "r1" } });
  const need = store.length - CAP;
  const selected = [];
  for (const rec of store) {
    if (selected.length >= need) break;
    if (isPrunableCapture(rec)) selected.push(rec.captureId);
  }
  check("nothing is selected for deletion", selected.length === 0, String(selected.length));
  check("the walk terminates rather than looping (all 120 records inspected, none taken)",
    selected.length === 0 && store.length === 120);
}

console.log("\na question asked by hand when campaigns already fill the cap (0.73.1)");
{
  // The owner's report: "nothing appears at all". 60 campaign captures, cap
  // 50, then one manual capture. The old selection took (count - cap) = 11
  // prunable records, oldest first — and the only prunable record was the
  // capture just stored, so it was deleted on arrival.
  const CAP = 50;
  const store = [];
  for (let i = 0; i < 60; i++) store.push({ captureId: `run-${i}`, capturedAt: i, geo: { runId: "r1" } });
  store.push({ captureId: "manual-new", capturedAt: 61, geo: null });
  const prunable = store.filter(isPrunableCapture).map((r) => r.captureId);
  const old = prunable.slice(0, store.length - CAP);
  check("(the old selection deleted the new manual capture)", old.includes("manual-new"));
  check("the new manual capture is kept", retentionVictims(prunable, CAP, "manual-new").length === 0);
  // 55 older manual captures + the new one: the cap counts manual ones only,
  // so 6 go, oldest first, never the new one.
  const many = [...Array.from({ length: 55 }, (_, i) => `m-${i}`), "manual-new"];
  const v = retentionVictims(many, CAP, "manual-new");
  check("over the cap with manual captures: the oldest go, the new one stays", v.length === 6 && v[0] === "m-0" && !v.includes("manual-new"), v.join(","));
  check("under the cap: nothing goes", retentionVictims(["a", "b"], CAP, "b").length === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
