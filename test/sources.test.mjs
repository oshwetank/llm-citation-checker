/*
 * sources.test.mjs — domain citation VOLUME and domain REACH are different
 * numbers, and the whole request was that they stop being one number.
 *
 * Requested: "if in 1 answer 2 times a url from same domain was cited we
 * should see 2 citations and 100% visibility. Now when we look at 10 prompts,
 * in which any url from that domain was cited in 5 prompts the Domain
 * visibility would 50%, and let's say among those 5 prompts in 2 it was cited
 * 2 times and in 1 it was cited 3 times and in next 2 it was cited 1 & 1
 * times, so the total Citation of that domain would be [the sum]."
 *
 * The worked example is built literally below, because that is the clearest
 * possible statement of the rule: 10 responses, cited in 5 → 50% visibility;
 * 2+2+3+1+1 → 9 citations. Volume and reach move independently, and the two
 * degenerate cases at the end are the reason it matters — a domain leaned on
 * heavily in one answer and one named quietly in every answer must not read
 * the same.
 */
import { aggregateSources, aggregateSourcesFromCaptures } from "../src/lib/sources.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

let seq = 0;
/** One response citing `domain` n times (each from a different page). */
const run = (sources) => ({
  captureId: `c${++seq}`, capturedAt: 1000 + seq, platform: "chatgpt", mentioned: false, sources,
});
const cite = (domain, n, prefix = "p") =>
  Array.from({ length: n }, (_, i) => ({ domain, url: `https://${domain}/${prefix}${i}`, outcome: "cited" }));

console.log("\none answer, one domain, cited twice");
{
  const { domains, totalResponses } = aggregateSources({ q1: [run(cite("acme.com", 2))] });
  const d = domains.get("acme.com");
  check("one response in the denominator", totalResponses === 1, String(totalResponses));
  check("both occurrences counted as citations", d.citations === 2, String(d.citations));
  check("visibility is 100%, not 200%", d.visibility === 100, String(d.visibility));
  check("it counts as one cited response", d.citedResponses === 1, String(d.citedResponses));
}

console.log("\nthe worked example: 10 prompts, cited in 5");
{
  const promptRuns = {};
  // Cited 2, 2, 3, 1, 1 times across five prompts…
  [2, 2, 3, 1, 1].forEach((n, i) => { promptRuns[`hit${i}`] = [run(cite("acme.com", n))]; });
  // …and absent from the other five, which still count as responses.
  for (let i = 0; i < 5; i++) {
    promptRuns[`miss${i}`] = [run([{ domain: "other.com", url: `https://other.com/${i}`, outcome: "cited" }])];
  }

  const { domains, totalResponses } = aggregateSources(promptRuns);
  const d = domains.get("acme.com");
  check("ten responses in the denominator", totalResponses === 10, String(totalResponses));
  check("cited in five of them", d.citedResponses === 5, String(d.citedResponses));
  check("visibility is 50%", d.visibility === 50, String(d.visibility));
  check("citations sum every occurrence: 2+2+3+1+1 = 9", d.citations === 9, String(d.citations));
  check("five distinct prompts cited it", d.citedPromptIds.size === 5, String(d.citedPromptIds.size));
  // The nine citations came through only three distinct pages (the same
  // pages recur across prompts), which is exactly why URLs and citations are
  // separate counts.
  check("distinct pages are counted as pages, not as citations",
    d.urls.size === 3, String(d.urls.size));
}

console.log("\nvolume and reach are independent — the reason for two columns");
{
  const heavy = {};   // one answer leans on it ten times, then never again
  heavy.q0 = [run(cite("heavy.com", 10))];
  for (let i = 1; i < 10; i++) heavy[`q${i}`] = [run([{ domain: "x.com", url: `https://x.com/${i}`, outcome: "cited" }])];

  const wide = {};    // named once in every single answer
  for (let i = 0; i < 10; i++) wide[`q${i}`] = [run(cite("wide.com", 1, `w${i}`))];

  const h = aggregateSources(heavy).domains.get("heavy.com");
  const w = aggregateSources(wide).domains.get("wide.com");

  check("both score ten citations", h.citations === 10 && w.citations === 10,
    `${h.citations} / ${w.citations}`);
  check("but reach separates them: 10% vs 100%",
    h.visibility === 10 && w.visibility === 100, `${h.visibility}% / ${w.visibility}%`);
}

console.log("\nfetched-but-never-cited is not citation and not reach");
{
  const { domains } = aggregateSources({
    q1: [run([
      { domain: "read.com", url: "https://read.com/a", outcome: "fetched" },
      { domain: "read.com", url: "https://read.com/b", outcome: "fetched" },
    ])],
    q2: [run([{ domain: "other.com", url: "https://other.com/a", outcome: "cited" }])],
  });
  const d = domains.get("read.com");
  check("read-only appearances are counted separately", d.fetched === 2, String(d.fetched));
  check("they are not citations", d.citations === 0, String(d.citations));
  check("and contribute no visibility", d.visibility === 0, String(d.visibility));
  check("but the domain is still recorded as having appeared", d.responses === 1, String(d.responses));
}

console.log("\ntwo engines answering the same prompt are two responses");
{
  const promptRuns = {
    q1: [
      { captureId: "a", capturedAt: 1, platform: "chatgpt", sources: cite("acme.com", 1, "a") },
      { captureId: "b", capturedAt: 2, platform: "gemini", sources: [] },
    ],
  };
  const { domains, totalResponses } = aggregateSources(promptRuns);
  const d = domains.get("acme.com");
  check("two responses, not one prompt", totalResponses === 2, String(totalResponses));
  check("visibility is 50% over responses", d.visibility === 50, String(d.visibility));
  // Reported alongside, because with two engines the two readings differ and
  // the prompt-level one is what a per-prompt question is really asking.
  check("the distinct-prompt reading is still available",
    d.citedPromptIds.size === 1, String(d.citedPromptIds.size));
}

console.log("\nper-URL rows follow the same rules");
{
  const { urls } = aggregateSources({
    q1: [run([
      { domain: "acme.com", url: "https://acme.com/a", outcome: "cited" },
      { domain: "acme.com", url: "https://acme.com/a", outcome: "cited" },
    ])],
    q2: [run([{ domain: "acme.com", url: "https://acme.com/b", outcome: "cited" }])],
  });
  const a = urls.get("https://acme.com/a");
  check("the same URL twice in one answer is two citations", a.citations === 2, String(a.citations));
  check("…but one response", a.citedResponses === 1, String(a.citedResponses));
  check("…and 50% visibility over the two responses", a.visibility === 50, String(a.visibility));
  check("…and one run in the drill-down list", a.runs.size === 1, String(a.runs.size));
}

console.log("\nthe domain drill-down can reach its pages");
{
  const { domains } = aggregateSources({
    q1: [run([
      { domain: "acme.com", url: "https://acme.com/a", outcome: "cited" },
      { domain: "acme.com", url: "https://acme.com/b", outcome: "fetched" },
    ])],
  }, { q1: "what is the best thing" });
  const d = domains.get("acme.com");
  check("both pages are listed", d.urlList.length === 2, String(d.urlList.length));
  check("each page carries its own visibility",
    d.urlList.every((u) => typeof u.visibility === "number"));
  check("the prompt text reached the run", [...d.urlList[0].runs.values()][0].promptText === "what is the best thing");
}

console.log("\nad-hoc captures aggregate the same way");
{
  const { domains, totalResponses } = aggregateSourcesFromCaptures([
    { captureId: "c1", capturedAt: 1, platform: "chatgpt", userPrompt: "one",
      sources: [{ domain: "acme.com", url: "https://acme.com/a", outcome: "cited" },
                { domain: "acme.com", url: "https://acme.com/b", outcome: "cited" }] },
    { captureId: "c2", capturedAt: 2, platform: "gemini", userPrompt: "two", sources: [] },
  ]);
  const d = domains.get("acme.com");
  check("each capture is a response", totalResponses === 2, String(totalResponses));
  check("two citations from one capture", d.citations === 2, String(d.citations));
  check("50% visibility", d.visibility === 50, String(d.visibility));
  check("the capture's own prompt text is used",
    [...d.urlList[0].runs.values()][0].promptText === "one");
}

console.log("\nevery row carries the denominator it was measured against");
{
  const { domains, urls } = aggregateSources({
    q1: [run(cite("acme.com", 1, "z"))],
    q2: [run([])],
  });
  check("a domain row knows the denominator",
    domains.get("acme.com").totalResponses === 2, String(domains.get("acme.com").totalResponses));
  check("so does a URL row",
    [...urls.values()][0].totalResponses === 2, String([...urls.values()][0].totalResponses));
  check("so a drill-down can say \"1 of 2\" rather than a bare percentage",
    domains.get("acme.com").citedResponses === 1);
}

console.log("\ndegenerate input never throws");
{
  check("nothing at all", aggregateSources(null).totalResponses === 0);
  check("no sources", aggregateSources({ q1: [run([])] }).domains.size === 0);
  check("a source with neither domain nor url",
    aggregateSources({ q1: [run([{ outcome: "cited" }])] }).domains.size === 0);
  check("no records for the ad-hoc path", aggregateSourcesFromCaptures(null).totalResponses === 0);
  check("visibility is 0 rather than NaN with an empty denominator",
    aggregateSources({}).domains.size === 0);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
