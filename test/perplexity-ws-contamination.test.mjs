/*
 * perplexity-ws-contamination.test.mjs — a sidebarRecentThreads push must
 * never let an UNRELATED thread's preview stand in for the current query's
 * own answer.
 *
 * Real bug, reproduced from a real user capture
 * (fixtures/perplexity-sidebarRecentThreadsNoise.txt): Perplexity's
 * sidebarRecentThreads push is a list of the user's thread history — often
 * the ONLY source this adapter has for a query's own answer, when no other
 * network answer stream ever arrives (see test/multi-engine.test.mjs's
 * "GraphQL thread" case, which is why this data is deliberately flattened
 * into `nodes`, not filtered out). But the list also contains OTHER,
 * unrelated past threads, each with its own answerPreview. extractAnswer()
 * used to pick whichever preview was textually longest, with no idea which
 * one belonged to the actual query. In the real capture, the CORRECT entry
 * ("best gaming phone under 50000 with good battery", an iQOO 15R
 * recommendation) was present and its own title matched the query exactly —
 * but a DIFFERENT, older thread ("best gaming phone under 6000 with good
 * battery") had a longer answerPreview and won by raw length, so the panel
 * showed that unrelated thread's brands (BGMI, Free Fire, COD Mobile,
 * Unisoc, Snapdragon 680) as the answer to a totally different question,
 * with zero real sources.
 *
 * The fix: only ever select an answerPreview whose OWN title matches the
 * query being captured; if nothing matches, return an empty answer rather
 * than guess by length. Empty is a visible, honest miss — a confidently
 * wrong answer is the bug.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/perplexity.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nperplexity-ws-contamination: current-query preview wins, unrelated threads never do");

// --- Case 1: the real capture, title inferred from node[0] (no reqBody) ---
{
  const raw = readFileSync(new URL("./fixtures/perplexity-sidebarRecentThreadsNoise.txt", import.meta.url), "utf8");
  const json = raw.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();

  const rec = await adapt({
    captureId: "test-sidebar-1",
    raw: json,
    reqBody: null,
    capturedAt: Date.now(),
    pageUrl: "https://www.perplexity.ai",
  });

  check("userPrompt resolves to the query actually asked", rec.userPrompt === "best gaming phone under 50000 with good battery", `got: ${JSON.stringify(rec.userPrompt)}`);
  check("answer is the MATCHING thread's preview (mentions iQOO 15R)", /iQOO 15R/.test(rec.answerText), `got: ${JSON.stringify(rec.answerText.slice(0, 80))}`);
  // "BGMI" alone isn't a safe marker here: the CORRECT (₹50000) thread's own
  // preview legitimately mentions it too ("long BGMI/CoD sessions" as a
  // battery-endurance benchmark). Free Fire / COD Mobile / Unisoc are unique
  // to the WRONG (₹6000) thread's preview.
  check(
    "the unrelated ₹6000 thread's content does not leak through (Free Fire/COD Mobile/Unisoc)",
    !/Free Fire|COD Mobile|Unisoc/i.test(rec.answerText),
    `answerText: ${JSON.stringify(rec.answerText.slice(0, 200))}`
  );
  // This fallback tier never carries real web_results — no sources is the
  // honest state here, not a separate bug. (Flagged to the user: getting a
  // full capture with sources for a Perplexity query depends on the DOM
  // harvester path, not this WS fallback.)
  check("no sources are fabricated for a preview-only capture", rec.sources.length === 0);
}

// --- Case 2: reqBody supplies a DIFFERENT prompt than node[0]'s title, and
// a longer, unrelated node is present — this is the case that actually
// exercises title-matching (case 1 alone would pass even with plain
// "longest wins", since node[0]'s title happens to equal the inferred
// prompt trivially). ---
{
  const raw = JSON.stringify({
    payload: {
      data: {
        sidebarRecentThreads: {
          threads: {
            edges: [
              {
                node: {
                  name: "best laptop for coding under 60000",
                  status: "COMPLETED",
                  answerPreview: "For coding under ₹60,000, the ASUS Vivobook Pro with a Ryzen 7 and 16GB RAM is the strongest pick.",
                },
              },
              {
                // Deliberately the LONGER preview, and deliberately NOT the
                // query being asked — this is what used to win under
                // "longest wins".
                node: {
                  name: "spiritual places to visit near nainital",
                  status: "COMPLETED",
                  answerPreview:
                    "Nainital and its surrounding Kumaon hills form one of North India's richest spiritual belts, blending Shakti Peeth temples, Shiva shrines, and a globally known ashram tied to Neem Karoli Baba. Here is a full list, organized by location, covering every major site worth visiting on a multi-day trip through the region.",
                },
              },
            ],
          },
        },
      },
    },
  });

  const rec = await adapt({
    captureId: "test-sidebar-2",
    raw,
    reqBody: JSON.stringify({ query: "best laptop for coding under 60000" }),
    capturedAt: Date.now(),
    pageUrl: "https://www.perplexity.ai",
  });

  check("userPrompt is taken from reqBody", rec.userPrompt === "best laptop for coding under 60000");
  check(
    "the MATCHING (shorter) node's preview wins, not the longer unrelated one",
    /ASUS Vivobook Pro/.test(rec.answerText),
    `got: ${JSON.stringify(rec.answerText)}`
  );
  check(
    "the unrelated, longer thread's content does not leak through",
    !/Nainital|Kumaon|Shakti Peeth/i.test(rec.answerText)
  );
}

// --- Case 3: no node's title matches the query at all — must return empty,
// never guess by length. ---
{
  const raw = JSON.stringify({
    payload: {
      data: {
        sidebarRecentThreads: {
          threads: {
            edges: [
              {
                node: {
                  name: "completely unrelated older question",
                  status: "COMPLETED",
                  answerPreview: "This is a long unrelated preview about something else entirely, long enough to win any length contest.",
                },
              },
            ],
          },
        },
      },
    },
  });

  const rec = await adapt({
    captureId: "test-sidebar-3",
    raw,
    reqBody: JSON.stringify({ query: "best noise cancelling headphones under 5000" }),
    capturedAt: Date.now(),
    pageUrl: "https://www.perplexity.ai",
  });

  check("no title matches the query -> answer is empty, not a guess", rec.answerText === "", `got: ${JSON.stringify(rec.answerText)}`);
  check("no brand mentions are derived from an empty/unmatched answer", rec.brandMentions.length === 0);
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
