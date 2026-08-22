/*
 * Tests for the GEO tracking metrics engine (src/lib/geo.js).
 * Run: node test/geo.test.mjs
 *
 * The Visibility and Share-of-Voice cases below reproduce the worked examples
 * published in Peec.ai's own docs, so the numbers this tool reports are
 * verifiably the same calculation and not a lookalike.
 */
import {
  makeProfile, makeTrackedPrompt, makeGeoRun,
  computeMetrics, computeSeries, brandPresence, trackedBrandsOf,
  isTracked, partitionRecords, selectTracked,
  normName, domainOfUrl, domainMatches, bucketKey, runDue, runVolume,
  allTags, availableEngines, ENGINES, MAX_PROFILES,
  hasSignal, countCompletedForRun,
} from "../src/lib/geo.js";
import { adapt as adaptChatGpt } from "../src/adapters/chatgpt.js";
import { makeRecord } from "../src/schema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Minimal record factory — only the fields the metrics engine reads.
function rec({ answerText = "", brands = [], sources = [], geo = null, at = Date.now(), platform = "chatgpt" } = {}) {
  return {
    captureId: Math.random().toString(36).slice(2),
    platform,
    capturedAt: at,
    answerText,
    brandMentions: brands,
    sources,
    geo,
  };
}
const G = (extra = {}) => ({ profileId: "p1", runId: "r1", promptId: "q1", tags: [], ...extra });

/* ---------------- normalisation ---------------- */
console.log("normalisation helpers");
{
  check("normName folds case/punctuation", normName("Angel One!") === normName("angel-one"));
  check("normName collapses spacing", normName("  Zerodha  ") === "zerodha");
  check("domainOfUrl strips protocol + www", domainOfUrl("https://www.Zerodha.com/charges") === "zerodha.com");
  check("domainOfUrl accepts a bare host", domainOfUrl("groww.in") === "groww.in");
  check("domainOfUrl survives junk", domainOfUrl("::::") === "" || typeof domainOfUrl("::::") === "string");
  check("domainMatches exact", domainMatches("zerodha.com", "zerodha.com"));
  check("domainMatches subdomain", domainMatches("support.zerodha.com", "zerodha.com"));
  // The bug a naive endsWith() check would introduce:
  check("domainMatches rejects a lookalike suffix", !domainMatches("notzerodha.com", "zerodha.com"));
  check("domainMatches rejects unrelated", !domainMatches("groww.in", "zerodha.com"));
}

/* ---------------- engine registry ---------------- */
console.log("\nengine registry reflects what can actually run");
{
  const avail = availableEngines().map((e) => e.id);
  check("chatgpt + gemini are available", avail.includes("chatgpt") && avail.includes("gemini"), avail.join(","));
  check("engines without an adapter are marked unavailable, not omitted",
    ENGINES.some((e) => e.id === "perplexity" && !e.available));
  check("every unavailable engine explains itself",
    ENGINES.filter((e) => !e.available).every((e) => !!e.note));
  check("a profile can never select an engine that cannot run",
    makeProfile({ engines: ["chatgpt", "perplexity"] }).engines.every((id) => avail.includes(id)));
}

/* ---------------- isolation ---------------- */
console.log("\nisolation: tracking data and ad-hoc browsing data never mix");
{
  const tracked = rec({ geo: G() });
  const adhoc = rec({ geo: null });
  check("isTracked distinguishes the two", isTracked(tracked) && !isTracked(adhoc));
  const { tracked: t, adhoc: a } = partitionRecords([tracked, adhoc, adhoc]);
  check("partitionRecords splits correctly", t.length === 1 && a.length === 2);

  const mixed = [
    rec({ geo: G({ profileId: "p1" }) }),
    rec({ geo: G({ profileId: "p2" }) }),
    rec({ geo: null }),
  ];
  check("selectTracked scopes to one profile", selectTracked(mixed, { profileId: "p1" }).length === 1);
  check("selectTracked never returns ad-hoc records",
    selectTracked(mixed, {}).every(isTracked));

  const tagged = [
    rec({ geo: G({ tags: ["brand", "top-funnel"] }) }),
    rec({ geo: G({ tags: ["competitor"] }) }),
    rec({ geo: G({ tags: [] }) }),
  ];
  check("selectTracked filters by tag", selectTracked(tagged, { tags: ["competitor"] }).length === 1);
  check("selectTracked matches ANY supplied tag",
    selectTracked(tagged, { tags: ["brand", "competitor"] }).length === 2);
  check("selectTracked filters by engine",
    selectTracked([rec({ geo: G(), platform: "chatgpt" }), rec({ geo: G(), platform: "gemini" })],
      { engines: ["gemini"] }).length === 1);
  check("selectTracked filters by time window",
    selectTracked([rec({ geo: G(), at: 1000 }), rec({ geo: G(), at: 9000 })],
      { since: 5000 }).length === 1);
}

/* ---------------- Visibility (Peec's published worked example) ---------------- */
console.log("\nVisibility — reproduces Peec's worked example (45 of 100 = 45%)");
{
  const profile = makeProfile({ brand: { name: "Acme", url: "acme.com" } });
  const records = [];
  for (let i = 0; i < 45; i++) records.push(rec({ answerText: "Acme is good", brands: [{ brand: "Acme", count: 1 }] }));
  for (let i = 0; i < 55; i++) records.push(rec({ answerText: "no brand here", brands: [] }));
  const m = computeMetrics(records, profile);
  check("total responses counted", m.totalResponses === 100, m.totalResponses);
  check("visibility = 45%", near(m.own.visibility, 45), m.own.visibility);
  check("responsesPresent = 45", m.own.responsesPresent === 45, m.own.responsesPresent);
}

/* ---------------- Share of Voice (Peec's published worked example) ---------------- */
console.log("\nShare of Voice — reproduces Peec's worked example (4 vs 12 = 25%)");
{
  const profile = makeProfile({
    brand: { name: "Acme", url: "acme.com" },
    competitors: [{ name: "Rival", url: "rival.com" }],
  });
  const records = [
    rec({ answerText: "Acme and Rival", brands: [{ brand: "Acme", count: 4 }, { brand: "Rival", count: 12 }] }),
  ];
  const m = computeMetrics(records, profile);
  check("mention pool = 16", m.mentionPool === 16, m.mentionPool);
  check("own SoV = 25%", near(m.own.shareOfVoice, 25), m.own.shareOfVoice);
  const rival = m.brands.find((b) => b.name === "Rival");
  check("competitor SoV = 75%", near(rival.shareOfVoice, 75), rival.shareOfVoice);
  check("SoV across all tracked brands sums to 100%",
    near(m.brands.reduce((n, b) => n + b.shareOfVoice, 0), 100, 1e-6));
  // The distinction Peec's docs make explicit — both brands appear in the one
  // response, so both are 100% visible even though SoV splits 25/75.
  check("visibility and SoV are genuinely different metrics",
    near(m.own.visibility, 100) && near(m.own.shareOfVoice, 25));
}

/* ---------------- Visibility counts carousel-only appearances ---------------- */
console.log("\nVisibility counts a shown-but-not-named brand; SoV does not");
{
  const profile = makeProfile({ brand: { name: "Noise", url: "gonoise.com" } });
  // count:0 is this project's "shown in a product carousel, never written in
  // the prose" case — a real appearance the user saw, worth 0 mentions.
  const records = [rec({ answerText: "some answer", brands: [{ brand: "Noise", count: 0 }] })];
  const m = computeMetrics(records, profile);
  check("counts toward visibility", near(m.own.visibility, 100), m.own.visibility);
  check("contributes nothing to the mention pool", m.mentionPool === 0, m.mentionPool);
  check("no position (never appears in the prose)", m.own.avgPosition === null, m.own.avgPosition);
}

/* ---------------- Position ---------------- */
console.log("\nPosition — average rank among tracked brands, over responses where it appears");
{
  const profile = makeProfile({
    brand: { name: "Beta", url: "beta.com" },
    competitors: [{ name: "Alpha", url: "alpha.com" }],
  });
  const records = [
    rec({ answerText: "Alpha first, then Beta.", brands: [{ brand: "Alpha", count: 1 }, { brand: "Beta", count: 1 }] }),
    rec({ answerText: "Beta leads, Alpha follows.", brands: [{ brand: "Alpha", count: 1 }, { brand: "Beta", count: 1 }] }),
  ];
  const m = computeMetrics(records, profile);
  check("own avg position = 1.5 (2nd then 1st)", near(m.own.avgPosition, 1.5), m.own.avgPosition);
  const alpha = m.brands.find((b) => b.name === "Alpha");
  check("competitor avg position = 1.5 (1st then 2nd)", near(alpha.avgPosition, 1.5), alpha.avgPosition);

  // Peec states position averages only over responses where the brand appears.
  const sparse = [
    rec({ answerText: "Beta only.", brands: [{ brand: "Beta", count: 1 }] }),
    rec({ answerText: "nothing relevant", brands: [] }),
  ];
  const m2 = computeMetrics(sparse, profile);
  check("absent responses are excluded, not scored as a penalty rank",
    near(m2.own.avgPosition, 1), m2.own.avgPosition);
  check("but they still drag visibility down to 50%", near(m2.own.visibility, 50), m2.own.visibility);
}

/* ---------------- Citations + Source Visibility ---------------- */
console.log("\nCitations and Source Visibility key off the brand's own domain");
{
  const profile = makeProfile({ brand: { name: "Zerodha", url: "https://zerodha.com" } });
  const records = [
    rec({ answerText: "Zerodha charges…", brands: [{ brand: "Zerodha", count: 1 }],
      sources: [{ domain: "zerodha.com", outcome: "cited" }] }),
    rec({ answerText: "Zerodha again…", brands: [{ brand: "Zerodha", count: 1 }],
      sources: [{ domain: "support.zerodha.com", outcome: "fetched" }] }),
    rec({ answerText: "Zerodha thrice…", brands: [{ brand: "Zerodha", count: 1 }],
      sources: [{ domain: "groww.in", outcome: "cited" }] }),
  ];
  const m = computeMetrics(records, profile);
  check("citations count only CITED own-domain sources", m.own.citations === 1, m.own.citations);
  check("source visibility counts cited OR fetched own-domain", near(m.own.sourceVisibility, (2 / 3) * 100), m.own.sourceVisibility);
  check("a competitor's domain never counts as ours", m.own.sourceResponses === 2, m.own.sourceResponses);
}

/* ---------------- empty / degenerate input ---------------- */
console.log("\ndegenerate input never divides by zero or throws");
{
  const profile = makeProfile({ brand: { name: "Acme", url: "acme.com" } });
  const m = computeMetrics([], profile);
  check("no responses → 0 visibility, not NaN", m.own.visibility === 0 && !Number.isNaN(m.own.visibility));
  check("no responses → 0 SoV, not NaN", m.own.shareOfVoice === 0 && !Number.isNaN(m.own.shareOfVoice));
  check("no responses → null position", m.own.avgPosition === null);
  const noBrand = computeMetrics([rec({})], makeProfile({}));
  check("a profile with no brand set doesn't throw", noBrand.brands.length === 0 && noBrand.own === null);
}

/* ---------------- sentiment is deliberately absent ---------------- */
console.log("\nsentiment is reported as unmeasured rather than fabricated");
{
  const m = computeMetrics([rec({})], makeProfile({ brand: { name: "Acme", url: "acme.com" } }));
  check("sentiment is null, not a made-up number", m.sentiment === null);
}

/* ---------------- trend series ---------------- */
console.log("\ntrend series buckets by day");
{
  const profile = makeProfile({ brand: { name: "Acme", url: "acme.com" } });
  const day1 = Date.UTC(2026, 0, 1, 10);
  const day2 = Date.UTC(2026, 0, 2, 10);
  const records = [
    rec({ at: day1, answerText: "Acme", brands: [{ brand: "Acme", count: 1 }] }),
    rec({ at: day1, answerText: "nope", brands: [] }),
    rec({ at: day2, answerText: "Acme", brands: [{ brand: "Acme", count: 1 }] }),
  ];
  const s = computeSeries(records, profile, "day");
  check("two day buckets", s.length === 2, s.length);
  check("buckets are chronological", s[0].key < s[1].key, s.map((x) => x.key).join(","));
  check("day 1 visibility 50%", near(s[0].own.visibility, 50), s[0].own.visibility);
  check("day 2 visibility 100%", near(s[1].own.visibility, 100), s[1].own.visibility);
  check("bucketKey is stable for the same day", bucketKey(day1) === bucketKey(day1 + 3600000));
}

/* ---------------- run cadence + volume ---------------- */
console.log("\nrun cadence and volume disclosure");
{
  check("a never-run profile is due", runDue(makeProfile({}), Date.now()));
  const now = Date.UTC(2026, 0, 2, 10);
  check("a profile run today is not due", !runDue(makeProfile({ lastRunAt: Date.UTC(2026, 0, 2, 1) }), now));
  check("a profile last run yesterday is due", runDue(makeProfile({ lastRunAt: Date.UTC(2026, 0, 1, 23) }), now));

  const prompts = [
    makeTrackedPrompt({ text: "a" }), makeTrackedPrompt({ text: "b" }),
    makeTrackedPrompt({ text: "c", active: false }),
  ];
  const v = runVolume(prompts, ["chatgpt", "gemini"]);
  check("volume counts only active prompts", v.prompts === 2, v.prompts);
  check("volume multiplies prompts × engines", v.submissions === 4, v.submissions);
}

/* ---------------- prompts + tags ---------------- */
console.log("\ntracked prompts and tags");
{
  const p = makeTrackedPrompt({ text: "  best broker  ", tags: ["Brand", "Brand", " money "] });
  check("prompt text is trimmed", p.text === "best broker", JSON.stringify(p.text));
  check("tags are de-duplicated and trimmed", p.tags.length === 2 && p.tags.includes("money"), JSON.stringify(p.tags));
  check("prompts default to active", p.active === true);
  check("allTags collects across prompts",
    allTags([makeTrackedPrompt({ tags: ["b"] }), makeTrackedPrompt({ tags: ["a", "b"] })]).join(",") === "a,b");
}

/* ---------------- profile guards ---------------- */
console.log("\nprofile shape");
{
  check("MAX_PROFILES is 3", MAX_PROFILES === 3);
  const pr = makeProfile({ competitors: [{ name: "A", url: "a.com" }, { name: "" }, null] });
  check("competitors without a name are dropped", pr.competitors.length === 1);
  check("profiles start unlocked", makeProfile({}).locked === false);
  check("a run records what it expected to do", makeGeoRun({ expected: 40 }).expected === 40);
  check("trackedBrandsOf puts the own brand first",
    trackedBrandsOf(makeProfile({ brand: { name: "Me" }, competitors: [{ name: "Them" }] }))[0].isOwn === true);
}

/* ---------------- against a REAL captured record ---------------- */
console.log("\nreal capture: metrics run end-to-end on actual adapter output");
{
  const txt = readFileSync(join(FIX, "chatgpt-finance-trading.txt"), "utf8");
  const lines = txt.split(/\r?\n/);
  const reqBody = (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "") || "{}";
  const raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
  const real = await adaptChatGpt({ captureId: "fin", raw, reqBody, capturedAt: Date.now() }, {});
  real.geo = G();

  const profile = makeProfile({
    brand: { name: "Zerodha", url: "zerodha.com" },
    competitors: [{ name: "Groww", url: "groww.in" }, { name: "Upstox", url: "upstox.com" }],
  });
  const m = computeMetrics([real], profile);
  check("own brand detected in a real answer", m.own.responsesPresent === 1, JSON.stringify(m.own));
  check("real mention count is non-zero", m.own.mentions > 0, m.own.mentions);
  check("real capture yields a position", m.own.avgPosition !== null, m.own.avgPosition);
  check("own domain citation detected from real sources", m.own.citations >= 1, m.own.citations);
  check("competitors also measured", m.brands.length === 3, m.brands.length);
  check("SoV still totals 100% on real data",
    near(m.brands.reduce((n, b) => n + b.shareOfVoice, 0), 100, 1e-6));
  check("the record is correctly seen as tracked, not ad-hoc", isTracked(real));
}

/* ---------------- schema wiring ----------------
 * The isolation guarantee is only real if `geo` actually survives into the
 * stored record. makeRecord is an explicit allow-list — a field not named
 * there is silently dropped, which is exactly how `answerText` went missing
 * for weeks earlier in this project. Guard it.
 */
console.log("\nschema carries the geo provenance bag (allow-list regression guard)");
{
  const geo = { profileId: "p1", runId: "r1", promptId: "q1", tags: ["brand"] };
  const withGeo = makeRecord({ geo });
  check("makeRecord preserves geo", withGeo.geo && withGeo.geo.profileId === "p1", JSON.stringify(withGeo.geo));
  check("geo tags survive", (withGeo.geo.tags || []).includes("brand"));
  const without = makeRecord({});
  check("an ordinary capture has geo === null", without.geo === null, JSON.stringify(without.geo));
  check("a record with no geo reads as ad-hoc", !isTracked(without));
  check("a record with geo reads as tracked", isTracked(withGeo));
  // Pre-v4 records predate the field entirely — they must degrade to ad-hoc,
  // not throw or be mistaken for tracking data.
  check("a legacy record with no geo key at all is treated as ad-hoc",
    !isTracked({ captureId: "old", capturedAt: 1, sources: [], brandMentions: [] }));
}

/*
 * brandPresence located brands with a plain indexOf(), so any tracked brand
 * whose name is a substring of ordinary English inflated its own Visibility
 * and took rank 1. "HP" matched inside "shipping"; the brand "Nothing" matched
 * the word "nothing". Both are real brands a user would track.
 */
console.log("\nbrand presence does not fire on substrings or ordinary words");
{
  const mk = (answerText, brandMentions = []) => ({
    geo: { profileId: "p" }, platform: "chatgpt", capturedAt: Date.now(),
    answerText, brandMentions, sources: [],
  });
  const brands = [{ name: "HP", url: "hp.com", isOwn: true }, { name: "Nothing", url: "nothing.tech" }];

  const trap = brandPresence(mk("There is nothing better; free shipping on all orders."), brands);
  check("'HP' does not match inside 'shipping'", trap[0].present === false, JSON.stringify(trap[0]));
  check("'Nothing' does not match the lowercase word", trap[1].present === false, JSON.stringify(trap[1]));
  check("no bogus position is assigned", trap.every((p) => p.firstIndex === null));

  const real = brandPresence(mk("The Nothing Phone 3 beats the HP Omen on battery life."), brands);
  check("a genuine 'HP Omen' mention still counts", real[0].present === true);
  check("a genuine 'Nothing Phone' mention still counts", real[1].present === true);
  check("positions reflect real order", real[1].firstIndex < real[0].firstIndex);

  // The substring bug doubled Visibility; both brands appear in 1 of 2 answers.
  const m = computeMetrics(
    [mk("There is nothing better; free shipping on all orders."), mk("The Nothing Phone 3 beats the HP Omen.")],
    { brand: { name: "HP", url: "hp.com" }, competitors: [{ name: "Nothing", url: "nothing.tech" }] }
  );
  check("visibility is 50%, not 100%", m.brands.every((b) => near(b.visibility, 50)),
    m.brands.map((b) => `${b.name}:${b.visibility}`).join(" "));

  // A count-0 carousel hit is "present" but has no place in the prose, so it
  // must not be handed a rank — its firstIndex is a sort sentinel, not an offset.
  const shown = brandPresence(
    mk("Only Samsung is discussed here.", [{ brand: "Noise", count: 0, firstIndex: Number.MAX_SAFE_INTEGER, passages: [] }]),
    [{ name: "Noise", url: "gonoise.com" }]
  )[0];
  check("carousel-only brand is present", shown.present === true);
  check("carousel-only brand has no position", shown.firstIndex === null, String(shown.firstIndex));
}

{
  console.log("\nhasSignal (mirror of the loader's advance guard — background.js re-exports this same function)");
  const real = makeRecord({ userPrompt: "hi", sources: [{ url: "https://x.com" }] });
  check("a real turn has signal", hasSignal(real) === true);
  check("an empty race-loser has no signal", hasSignal(makeRecord({})) === false);
  check("null capture has no signal", hasSignal(null) === false);
  check("a prompt-only capture still counts", hasSignal(makeRecord({ userPrompt: "hi" })) === true);
}

{
  // countCompletedForRun is the ground-truth check a restarted service worker
  // uses instead of trusting a possibly-stale persisted `idx` (see the
  // "SURVIVING SERVICE-WORKER RESTARTS" section of background.js). It must
  // count real completions from the derived store itself, and nothing else —
  // not other runs, not other platforms, not signal-less race-losers.
  console.log("\ncountCompletedForRun: service-worker-restart reconciliation");
  const done = (runId, platform, i) => ({
    ...makeRecord({ runId, platform, userPrompt: `p${i}`, answerChars: 10 }),
  });
  const raceLoser = (runId, platform) => ({ ...makeRecord({ runId, platform }) }); // no signal

  const records = [
    done("run-A", "chatgpt", 1),
    done("run-A", "chatgpt", 2),
    raceLoser("run-A", "chatgpt"), // must not be counted
    done("run-A", "gemini", 1), // different platform, same run
    done("run-B", "chatgpt", 1), // different run entirely
  ];

  check("counts only real completions for the given run+platform",
    countCompletedForRun(records, "run-A", "chatgpt") === 2);
  check("a signal-less race-loser is not counted", countCompletedForRun(records, "run-A", "chatgpt") !== 3);
  check("platforms within the same run are counted independently",
    countCompletedForRun(records, "run-A", "gemini") === 1);
  check("a different run's captures never leak in",
    countCompletedForRun(records, "run-B", "chatgpt") === 1);
  check("an unknown/missing runId counts nothing", countCompletedForRun(records, null, "chatgpt") === 0);
  check("a run with zero completions counts as zero",
    countCompletedForRun(records, "run-C", "chatgpt") === 0);
}

console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
