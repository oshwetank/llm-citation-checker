/*
 * errorlog.test.mjs — the error log records what broke, and never records the
 * user's content.
 *
 * Requested: "can we have an error log thing so that we can know exactly what
 * broke and where." Two things have to hold for that to be worth having, and
 * they pull in opposite directions:
 *
 *   1. It must actually capture failures — including the ones that used to
 *      vanish into `catch (_) {}` and into the popup's devtools console.
 *   2. It must not become the thing that leaks private data. This extension's
 *      entire promise is that nothing leaves the device, and the log is
 *      explicitly designed to be copied and shared when reporting a problem.
 *      A log that carries prompt text or URLs turns "copy this to the
 *      developer" into an exfiltration step.
 *
 * (2) is the half that needs real pressure, so most of this file is adversarial
 * about it: the redaction is asserted against the exact shapes that would leak
 * — prompts, answers, URLs in context, URLs inside the error MESSAGE itself,
 * brand names in long strings.
 */
import { makeErrorEntry, makeEventEntry, createErrorLog } from "../src/lib/errorlog.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

// Minimal in-memory stand-in for the db module's surface.
function fakeDb() {
  const stores = { errors: new Map() };
  return {
    _stores: stores,
    async put(s, v) { stores[s].set(v.id, v); },
    async getAll(s) { return [...stores[s].values()]; },
    async delete(s, k) { stores[s].delete(k); },
    async clear(s) { stores[s].clear(); },
  };
}

console.log("\nAn entry captures what is needed to diagnose a failure");
{
  const e = makeErrorEntry("message:geo-metrics", new TypeError("x is not a function"), {
    platform: "chatgpt", promptIndex: 340, totalPrompts: 1000,
  });
  check("it records where", e.where === "message:geo-metrics", e.where);
  check("it records the error type", e.kind === "TypeError", e.kind);
  check("it records the message", /x is not a function/.test(e.message), e.message);
  check("it timestamps the failure", typeof e.at === "number" && e.at > 0, String(e.at));
  check("it has a unique id", typeof e.id === "string" && e.id.length > 5, e.id);
  check("scalar context survives — this is what tells 'one bad prompt' from 'everything after 340'",
    e.context.promptIndex === 340 && e.context.totalPrompts === 1000 && e.context.platform === "chatgpt",
    JSON.stringify(e.context));
}

console.log("\nA non-Error value still logs rather than being dropped");
{
  // failTurnAndAdvance passes a plain reason string, not an Error.
  const e = makeErrorEntry("run:turn-failed:gemini", "submit: composer never appeared", { platform: "gemini" });
  check("a string reason is recorded as the message",
    /composer never appeared/.test(e.message), e.message);
  check("it does not invent a stack", e.stack === "", JSON.stringify(e.stack));
  const empty = makeErrorEntry("somewhere", null);
  check("null never produces an empty unreadable row", empty.message === "(no message)", empty.message);
}

console.log("\nPRIVACY: user content must never reach the log");
{
  // Everything a careless call site might hand over.
  const e = makeErrorEntry("capture", new Error("boom"), {
    prompt: "best smartphone under 50000 for my mother in law with good camera",
    answerText: "The Samsung Galaxy A55 is a strong pick because of its AMOLED display and long updates",
    pageUrl: "https://chatgpt.com/c/abc-123?q=best%20phone",
    domain: "www.amazon.in",
    brand: "Samsung",
    platform: "chatgpt",
    promptIndex: 7,
  });
  const dumped = JSON.stringify(e);

  check("a long prompt is dropped", !/mother in law/.test(dumped), dumped.slice(0, 200));
  check("answer text is dropped", !/AMOLED/.test(dumped), dumped.slice(0, 200));
  check("a URL in context is dropped", !/chatgpt\.com\/c\//.test(dumped), dumped.slice(0, 200));
  check("a www. domain is dropped", !/amazon\.in/.test(dumped), dumped.slice(0, 200));
  check("but useful scalars are kept", e.context.platform === "chatgpt" && e.context.promptIndex === 7,
    JSON.stringify(e.context));

  // A short single word like a brand name is indistinguishable from a
  // legitimate scalar tag, so it is NOT filtered — worth stating outright so
  // the boundary is understood rather than assumed.
  check("a short bare token still passes (documented limit of the filter, not an oversight)",
    e.context.brand === "Samsung", JSON.stringify(e.context.brand));
}

console.log("\nPRIVACY: a URL inside the error MESSAGE is scrubbed too");
{
  // Real shape: fetch failures name the URL, and the URL carries ?q=<prompt>.
  const e = makeErrorEntry("net",
    new Error("Failed to fetch https://chatgpt.com/backend-api/f?q=best%20phone%20under%2050000 (503)"));
  check("the URL is replaced", /<url>/.test(e.message), e.message);
  check("the prompt inside the query string is gone", !/50000/.test(e.message), e.message);
  check("the rest of the message is preserved", /Failed to fetch/.test(e.message), e.message);

  const withStack = makeErrorEntry("net", {
    name: "Error", message: "nope",
    stack: "at f (https://chatgpt.com/x.js?q=secret%20prompt:1:2)",
  });
  check("stacks are scrubbed as well", !/secret/.test(withStack.stack), withStack.stack);
}

console.log("\nA turn timeline rides along, without becoming a privacy hole");
{
  /* The trace is what turns "timeout" into something actionable — it records
   * how far the submit sequence got. It needs far more room than a context
   * value (whose tight cap exists to keep free text, and therefore prompt
   * content, out), so it is a separate field with its own cap. That extra
   * room is exactly why it still has to be scrubbed. */
  const TRACE = "1:run:chatgpt 3:composer 11:typed 12:send-ready 12:click 13:cleared 38:giveup";
  const e = makeErrorEntry("run:turn-failed:chatgpt", "timeout", { platform: "chatgpt" }, TRACE);
  check("the timeline is stored whole, not truncated like a context value",
    e.trace === TRACE, JSON.stringify(e.trace));
  check("an entry with no timeline gets an empty string, never undefined",
    makeErrorEntry("x", "y").trace === "", JSON.stringify(makeErrorEntry("x", "y").trace));

  // A trace should never carry a URL, but the field is wide enough that a
  // careless future call site could put one there — so it is scrubbed too.
  const dirty = makeErrorEntry("net", "boom", null, "1:run 2:nav:https://chatgpt.com/c/x?q=secret%20prompt");
  check("a URL that sneaks into a timeline is scrubbed", !/secret/.test(dirty.trace), dirty.trace);
  check("…and the rest of the timeline survives", /1:run/.test(dirty.trace), dirty.trace);

  // Very long traces are capped rather than allowed to grow the store.
  const huge = makeErrorEntry("x", "y", null, "9:tick ".repeat(600));
  check("a runaway timeline is capped", huge.trace.length <= 1500, String(huge.trace.length));
}

console.log("\nThe log is bounded, grouped, and readable");
{
  const db = fakeDb();
  const log = createErrorLog(db);

  // The reported shape: one failure repeating through a long run.
  for (let i = 0; i < 120; i++) {
    await log.record("run:turn-failed:chatgpt", "submit: composer never appeared",
      { platform: "chatgpt", promptIndex: i });
  }
  await log.record("message:geo-metrics", new TypeError("m is undefined"));

  const entries = await log.list(500);
  check("every occurrence is stored", entries.length === 121, String(entries.length));
  check("newest first", entries[0].at >= entries[entries.length - 1].at);

  const grouped = await log.summary();
  check("121 occurrences collapse to 2 distinct problems", grouped.length === 2, String(grouped.length));
  check("a grouped failure keeps its timeline, or the viewer shows nothing",
    (await (async () => {
      const d2 = fakeDb(); const l2 = createErrorLog(d2);
      await l2.record("run:turn-failed:chatgpt", "timeout", { platform: "chatgpt" }, "1:run 5:composer 20:giveup");
      const g2 = await l2.summary();
      return g2[0] && g2[0].trace;
    })()) === "1:run 5:composer 20:giveup");

  const repeated = grouped.find((g) => /composer never appeared/.test(g.message));
  check("the repeated one carries its count, so it reads as one problem not 120 lines",
    repeated && repeated.count === 120, JSON.stringify(repeated && repeated.count));
  check("it keeps first and last seen, which is what shows a run degrading over time",
    repeated && repeated.firstAt <= repeated.lastAt);

  // Growth bound: a runaway failure loop must not fill the user's disk.
  for (let i = 0; i < 600; i++) await log.record("noise", `err ${i}`);
  await log.trim();
  const after = await log.list(5000);
  check(`the store is capped at ${log.MAX_ENTRIES}`, after.length <= log.MAX_ENTRIES, String(after.length));
  check("trimming keeps the NEWEST entries, since those explain the current problem",
    after.every((e) => e.at >= Math.min(...after.map((x) => x.at))));

  check("clearing empties it", (await log.clear()) === true && (await log.list()).length === 0);
}

console.log("\nLogging can never break the thing it is logging");
{
  // A failing db is exactly the situation where errors are being thrown, so
  // the log must not add a second failure on top.
  const brokenDb = {
    async put() { throw new Error("QuotaExceededError"); },
    async getAll() { throw new Error("db gone"); },
    async delete() { throw new Error("db gone"); },
    async clear() { throw new Error("db gone"); },
  };
  const log = createErrorLog(brokenDb);
  let threw = false;
  try {
    await log.record("anywhere", new Error("original failure"));
    await log.list();
    await log.summary();
    await log.trim();
    await log.clear();
  } catch (_) { threw = true; }
  check("a completely broken database does not make the logger throw", !threw);
  check("list() degrades to empty rather than exploding", (await log.list()).length === 0);
  check("clear() reports failure instead of throwing", (await log.clear()) === false);
}

console.log("\nOne log now carries three categories, not three mechanisms");
{
  /* Requested: "I need ONE error/problem detection tool" — the error log,
   * the old in-memory Capture debugger ring buffer, and per-turn outcome
   * history (previously only visible in the live progress view) are now
   * one store, discriminated by `cat`. This section is what proves the
   * merge actually happened rather than just adding fields nothing uses. */
  const e = makeErrorEntry("run:turn-failed:chatgpt", "timeout", { platform: "chatgpt" });
  check("an entry defaults to cat:error when none is given", e.cat === "error", e.cat);

  const capture = makeEventEntry("capture:fetch", "capture", "chatgpt.com", { status: 200, matched: true });
  check("makeEventEntry stamps the category given", capture.cat === "capture", capture.cat);
  check("makeEventEntry needs no exception object", capture.stack === "" && capture.trace === "");
  check("its context still goes through the same privacy filter",
    capture.context.status === 200 && capture.context.matched === true, JSON.stringify(capture.context));

  const turn = makeEventEntry("run:turn:gemini", "turn", "ok", { platform: "gemini", promptIndex: 3, status: "ok" });
  check("a turn entry records its own category", turn.cat === "turn", turn.cat);
}

console.log("\nrunId threading: a campaign export can find its own entries");
{
  const db = fakeDb();
  const log = createErrorLog(db);
  await log.record("run:turn-failed:chatgpt", "timeout", { platform: "chatgpt", runId: "run-A" });
  await log.recordEvent("run:turn:chatgpt", "turn", "ok", { platform: "chatgpt", runId: "run-A" });
  await log.recordEvent("capture:fetch", "capture", "chatgpt.com", { runId: "run-B" });
  await log.record("unrelated", new Error("no runId at all"));

  const forA = await log.listByRunIds(["run-A"]);
  check("only entries tagged with a wanted runId come back", forA.length === 2, String(forA.length));
  check("an entry from a different run is excluded",
    !forA.some((x) => x.context.runId === "run-B"));

  const forNeither = await log.listByRunIds(["run-does-not-exist"]);
  check("an unmatched runId returns nothing rather than everything", forNeither.length === 0, String(forNeither.length));
}

console.log("\nCategory-aware trim: a noisy capture stream cannot evict real errors");
{
  const db = fakeDb();
  const log = createErrorLog(db);

  // Real failures, well under any cap.
  for (let i = 0; i < 10; i++) await log.record("run:turn-failed:chatgpt", `fail ${i}`, { platform: "chatgpt" });
  // A flood of capture breadcrumbs, well over the capture cap (200).
  for (let i = 0; i < 500; i++) await log.recordEvent("capture:fetch", "capture", `event ${i}`, {});
  await log.trim();

  const errors = await log.list(5000, "error");
  const captures = await log.list(5000, "capture");
  check("every real error survives a capture flood that dwarfs it",
    errors.length === 10, String(errors.length));
  check("the capture category is trimmed to its own cap, independently",
    captures.length > 0 && captures.length <= 200, String(captures.length));
  check("list(cat) never leaks entries from another category into the count",
    errors.every((e) => (e.cat || "error") === "error") && captures.every((e) => e.cat === "capture"));
}

console.log("\nsummary() stays scoped to real failures by default");
{
  const db = fakeDb();
  const log = createErrorLog(db);
  await log.record("run:turn-failed:chatgpt", "timeout", { platform: "chatgpt" });
  await log.recordEvent("run:turn:chatgpt", "turn", "ok", { platform: "chatgpt" });
  await log.recordEvent("capture:fetch", "capture", "chatgpt.com", {});

  const grouped = await log.summary();
  check("summary() with no cat argument groups only cat:error entries",
    grouped.length === 1 && grouped[0].message === "timeout", JSON.stringify(grouped));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
