/*
 * campaign-diagnostics-export.test.mjs — "get-campaign-diagnostics" (the
 * "share all the issues and data of a campaign with you in one go" export)
 * against a real service worker and a real IndexedDB.
 *
 * Requested: "I need ONE error/problem detection tool... I would like to be
 * able to share all the issue and data of a campaign with you in one go."
 * Everything this handler touches (errorLog.listByRunIds, the gunzip
 * round-trip on raw payloads, summarizeRunDiagnostics) already has unit
 * coverage in isolation — errorlog.test.mjs and diagnostics-summary.test.mjs.
 * What's new and untested by either is the WIRING: does the real handler,
 * given a real campaign's rows across five different IndexedDB stores, pull
 * them all together into one correct response. That's what this file drives,
 * seeding the database directly the way concurrency-live.test.mjs does
 * rather than running a full submit-to-capture cycle, which is a separate,
 * already-covered mechanism (see that file's header for why).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(HERE, "..");
const PROFILE_BASE = process.env.UI_TEST_PROFILE_DIR || "/tmp/citoskeleton-diag-export-test";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

let chromium;
try {
  const req = await import("node:module").then((m) => m.createRequire(import.meta.url));
  let pw = null;
  for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
    try { pw = req(c); break; } catch (_) { /* next */ }
  }
  if (!pw) throw new Error("playwright not resolvable");
  chromium = pw.chromium;
} catch (err) {
  console.log("\ncampaign-diagnostics-export: CANNOT RUN — playwright is not installed.");
  console.log(`This guards new wiring, so it fails rather than skips. Reason: ${err.message}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(`${PROFILE_BASE}-${Date.now()}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/ui/panel.html?mode=tab`);
  await page.waitForTimeout(1000);

  // Bounded: an over-size reply is never delivered at all (the old export
  // hung exactly this way), and a hang must fail this test, not stall CI.
  const ask = (msg) => page.evaluate((m) => new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, error: "no reply within 60s" }), 60000);
    chrome.runtime.sendMessage(m, (r) => { clearTimeout(t); res(r); });
  }), msg);

  const seeded = await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, v) => new Promise((res, rej) => {
      const r = dbh.transaction(store, "readwrite").objectStore(store).put(v);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    const gzip = async (str) => {
      const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
      return await new Response(stream).arrayBuffer();
    };

    const profileId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    // What a real run made before the loader adopted the geo run's id looks
    // like: the campaign's run record under one id, every log entry under the
    // loader's OWN id, and nothing linking the two except the captures, which
    // carry both. This test used to seed the log under the geo id — a link the
    // real code never made — which is how an export whose log section was
    // empty for every real run passed here for its whole life.
    const loaderRunId = crypto.randomUUID();
    const captureId = crypto.randomUUID();
    const now = Date.now();

    await put("profiles", {
      id: profileId, name: "Diag Export Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["chatgpt"], locked: true, createdAt: now, lastRunAt: now, deletedAt: null,
    });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId, text: "prompt one", tags: [], active: true, createdAt: now });
    await put("trackedPrompts", { id: crypto.randomUUID(), profileId, text: "prompt two", tags: [], active: true, createdAt: now });
    // One prompt captured (below), one not — expected:2, stored:1, missing:1.
    await put("geoRuns", {
      id: runId, profileId, startedAt: now, status: "done",
      expected: 2, failed: 1, reasons: { timeout: 1 },
    });
    await put("derived", {
      captureId, platform: "chatgpt", model: "gpt-5", capturedAt: now,
      userPrompt: "prompt one", answerText: "the answer", brandMentions: [], sources: [], fanout: {},
      runId: loaderRunId,
      geo: { profileId, runId },
    });
    await put("raw", {
      captureId, platform: "chatgpt", capturedAt: now,
      url: "https://chatgpt.com/backend-api/f?lcfc=1", reqBody: "{}",
      gz: await gzip("RAW-PAYLOAD-MARKER prompt one"),
    });
    // Seeded directly against the same "errors" store shape errorlog.js
    // writes, one per category — this is what proves the handler actually
    // reads across all three rather than just the ones it wrote itself.
    await put("errors", {
      id: `${now}-e1`, at: now, cat: "error", where: "run:turn-failed:chatgpt", kind: "Error",
      message: "timeout", stack: "", context: { platform: "chatgpt", runId: loaderRunId }, trace: "1:run 5:composer 38:giveup",
    });
    await put("errors", {
      id: `${now}-e2`, at: now, cat: "turn", where: "run:turn:chatgpt", kind: "turn",
      message: "ok", stack: "", context: { platform: "chatgpt", runId: loaderRunId, captureId, status: "ok" }, trace: "",
    });
    await put("errors", {
      id: `${now}-e3`, at: now, cat: "capture", where: "capture:fetch", kind: "capture",
      message: "chatgpt.com", stack: "", context: { runId: loaderRunId, status: 200 }, trace: "",
    });
    // A decoy entry from an unrelated run — must NOT show up in the export.
    await put("errors", {
      id: `${now}-e4`, at: now, cat: "error", where: "run:turn-failed:gemini", kind: "Error",
      message: "unrelated failure", stack: "", context: { platform: "gemini", runId: "some-other-run" }, trace: "",
    });

    return { profileId, runId, captureId };
  });

  const r = await ask({ type: "get-campaign-diagnostics", profileId: seeded.profileId });

  check("the handler responds ok", r && r.ok === true, JSON.stringify(r && r.error));
  check("campaign metadata names the right profile", r.campaign?.profileId === seeded.profileId, JSON.stringify(r.campaign));
  check("campaign metadata counts both tracked prompts", r.campaign?.promptCount === 2, String(r.campaign?.promptCount));

  const run = (r.perRun || [])[0];
  check("exactly one run comes back", (r.perRun || []).length === 1, String((r.perRun || []).length));
  check("expected/stored/missing arithmetic matches the seeded rows",
    run && run.expected === 2 && run.stored === 1 && run.missing === 1, JSON.stringify(run));
  check("failure reasons travel through", run && run.reasons.timeout === 1, JSON.stringify(run && run.reasons));

  check("exactly the one matching error entry comes back, not the decoy",
    (r.errors || []).length === 1 && r.errors[0].message === "timeout", JSON.stringify(r.errors));
  check("exactly one turn entry comes back", (r.turns || []).length === 1 && r.turns[0].context.captureId === seeded.captureId, JSON.stringify(r.turns));
  check("exactly one capture-breadcrumb entry comes back", (r.captures || []).length === 1, JSON.stringify(r.captures));

  // Records and raw payloads are fetched after the index, never inline —
  // see the large-campaign section below for why.
  check("the index names the capture's record", (r.recordIds || []).includes(seeded.captureId), JSON.stringify(r.recordIds));
  check("and carries no inline records or payloads", r.records === undefined && r.raw === undefined);
  const recs = await ask({ type: "get-diagnostics-records", captureIds: r.recordIds || [] });
  check("the capture's record keeps its answer text — the export promises everything",
    !!recs && (recs.records || []).some((x) => x.captureId === seeded.captureId && x.answerText === "the answer"),
    JSON.stringify(recs && (recs.records || []).map((x) => Object.keys(x))));
  const raw = await ask({ type: "get-raw", captureId: seeded.captureId });
  check("the raw payload round-trips through gzip intact",
    !!raw && typeof raw.raw === "string" && raw.raw.includes("RAW-PAYLOAD-MARKER"), JSON.stringify(raw && raw.raw));
  check("raw payload metadata (url/reqBody) travels with it",
    !!raw && raw.meta && raw.meta.url.includes("chatgpt.com"), JSON.stringify(raw && raw.meta));

  check("environment info is present for whoever reads the export",
    !!r.env && typeof r.env.version === "string" && typeof r.env.userAgent === "string", JSON.stringify(r.env));

  const missing = await ask({ type: "get-campaign-diagnostics", profileId: "does-not-exist" });
  check("an unknown campaign fails cleanly instead of throwing", missing && missing.ok === false);

  // A real ten-prompt, four-engine campaign's export failed outright with
  // "Message exceeded maximum allowed size of 64MiB": the handler put every
  // record and raw payload into one message, and Perplexity's answer stream
  // alone is 150-430 KB a capture. This campaign's payloads total ~72 MB and
  // go through the panel's real Export button and a real download.
  console.log("\nA campaign whose payloads total more than Chrome's 64 MiB message cap");
  const big = await page.evaluate(async () => {
    const dbh = await new Promise((res, rej) => {
      const r = indexedDB.open("lcfc");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (store, v) => new Promise((res, rej) => {
      const r = dbh.transaction(store, "readwrite").objectStore(store).put(v);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
    const gzip = async (str) => {
      const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
      return await new Response(stream).arrayBuffer();
    };
    const profileId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const now = Date.now();
    await put("profiles", {
      id: profileId, name: "Big Export Test", brand: { name: "Acme", url: "acme.example" },
      competitors: [], engines: ["perplexity"], locked: true, createdAt: now, lastRunAt: now, deletedAt: null,
    });
    await put("geoRuns", { id: runId, profileId, startedAt: now, status: "done", expected: 9, failed: 0, reasons: {} });
    const filler = "x".repeat(8 * 1000 * 1000);
    const ids = [];
    for (let i = 0; i < 9; i++) {
      const captureId = crypto.randomUUID();
      ids.push(captureId);
      await put("trackedPrompts", { id: crypto.randomUUID(), profileId, text: `big prompt ${i}`, tags: [], active: true, createdAt: now });
      await put("derived", {
        captureId, platform: "perplexity", model: "sonar", capturedAt: now + i,
        userPrompt: `big prompt ${i}`, answerText: `answer ${i}`, brandMentions: [], sources: [], fanout: {},
        runId, geo: { profileId, runId },
      });
      await put("raw", {
        captureId, platform: "perplexity", capturedAt: now + i, url: "https://www.perplexity.ai/rest/sse/perplexity_ask",
        reqBody: "{}", gz: await gzip(`BIG-MARKER-${i} ${filler}`),
      });
    }
    // Two unreadable payloads of the same kind, and one of another: the
    // export keeps one sample per kind.
    const unreadable = [];
    for (const [i, endpoint] of [[0, "/rest/sse/perplexity_ask"], [1, "/rest/sse/perplexity_ask"], [2, "/rest/sse/related-queries/:id"]]) {
      const captureId = crypto.randomUUID();
      unreadable.push(captureId);
      await put("raw", { captureId, platform: "perplexity", capturedAt: now, url: `https://www.perplexity.ai${endpoint}`, reqBody: "{}", gz: await gzip(`UNREADABLE-${i}`) });
      await put("errors", {
        id: `${now}-u${i}`, at: now + i, cat: "capture", where: "capture:unreadable:perplexity", kind: "capture",
        message: "the adapter found no prompt, answer or sources in this payload", stack: "",
        context: { platform: "perplexity", runId, captureId, endpoint, shape: "keys=a,b" }, trace: "",
      });
    }
    return { profileId, ids, unreadable };
  });

  const index = await ask({ type: "get-campaign-diagnostics", profileId: big.profileId });
  check("the index still answers for a campaign this size", index && index.ok === true, JSON.stringify(index && index.error));
  check("and lists every record", (index.recordIds || []).length === 9, (index.recordIds || []).length);
  check("one unreadable sample per kind, not one per payload", (index.unreadable || []).length === 2, JSON.stringify(index.unreadable));

  await page.evaluate((profileId) => {
    const sel = document.getElementById("diagExportProfile");
    const opt = document.createElement("option");
    opt.value = profileId; opt.textContent = "Big Export Test";
    sel.append(opt); sel.value = profileId;
  }, big.profileId);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }).catch(() => null),
    page.evaluate(() => document.getElementById("diagExportBtn").click()),
  ]);
  const zipPath = path.join(os.tmpdir(), `diag-export-${Date.now()}.zip`);
  if (download) await download.saveAs(zipPath);
  const listing = download ? execFileSync("unzip", ["-l", zipPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }) : "";
  const rawFiles = big.ids.filter((id) => listing.includes(`captures/${id}-raw.txt`));
  const recFiles = big.ids.filter((id) => listing.includes(`captures/${id}.json`));
  check("the real Export button produces the zip", fs.existsSync(zipPath));
  check("with every capture's record", recFiles.length === 9, `${recFiles.length}/9`);
  check("and every raw payload, ~72 MB of them", rawFiles.length === 9, `${rawFiles.length}/9`);
  let one = "";
  try { one = execFileSync("unzip", ["-p", zipPath, `captures/${big.ids[4]}-raw.txt`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch (_) { /* missing — checked below */ }
  check("a payload arrives whole", one.includes("BIG-MARKER-4") && one.length > 8 * 1000 * 1000, one.length);
  check("the unreadable samples are included", (listing.match(/unreadable\/perplexity-/g) || []).length === 2, listing.split("\n").filter((l) => l.includes("unreadable")).join(" | "));
  check("nothing was skipped", !!download && !listing.includes("skipped.txt"));
  fs.rmSync(zipPath, { force: true });
} finally {
  await context.close();
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
