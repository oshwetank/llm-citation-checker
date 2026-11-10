/*
 * over-time-view.test.mjs — one prompt's answers, run by run (0.60.0).
 *
 * The Over time view (the canvas's OverTime board) shows where each brand
 * came in each run, which sites were cited in each run, what the searches
 * were after and in how many runs, the ads, and what changed between the
 * first run and the latest. Until 0.60.0 the Compare page had no positions
 * at all ("Not shown here: your brand's rank position per run") and counted
 * every search as "[object Object]". Every brand, site and prompt here is
 * made up.
 */
import { overTimeView } from "../src/lib/overTimeView.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const T = (d) => Date.UTC(2026, 8, d, 9, 0);
const m = (brand, count, firstIndex) => ({ brand, count, firstIndex, passages: [] });
const s = (domain, outcome = "cited") => ({ url: `https://${domain}/p`, domain, title: domain, snippet: "", outcome });
const run = (d, brands, sources, extra = {}) => ({
  captureId: `c${d}`, platform: "chatgpt", capturedAt: T(d), searched: true, userPrompt: "best headphones under 3000",
  brandMentions: brands, sources, fanout: { search: [{ query: "Zento vs Kovo headphones" }, { query: "best headphones under 3000 price" }] }, ...extra,
});
const caps = [
  run(1, [m("Kovo", 2, 5), m("Lumi", 1, 50), m("Zento", 1, 90)], [s("smartprix.com"), s("kovo.com"), s("reddit.com", "fetched")]),
  run(8, [m("Zento", 2, 5), m("Kovo", 2, 60)], [s("smartprix.com"), s("zento.in")], { ads: [{ advertiser: "Phonekart", targetDomain: "phonekart.example" }] }),
  run(15, [m("Zento", 3, 5), m("Kovo", 1, 70), m("Arvo", 1, 120)], [s("smartprix.com"), s("zento.in"), s("91mobiles.com")], { platformSpecific: { wordCount: 240 } }),
];
const own = { name: "Zento" };
const v = overTimeView(caps, { own });

console.log("\nrun by run");
check("a row per run, oldest first", v.runs.map((r) => r.n).join() === "1,2,3" && v.runs[0].at < v.runs[2].at);
check("each with searches, pages read and cited, and brands", v.runs[0].searches === 2 && v.runs[0].read === 3 && v.runs[0].cited === 2 && v.runs[0].brands === 3, JSON.stringify(v.runs[0]));
check("your brand's place in each run", v.runs.map((r) => r.you).join() === "3,1,1", v.runs.map((r) => r.you).join());
check("the ad shown in a run, and none in the others", v.runs[1].ads.join() === "Phonekart" && !v.runs[0].ads.length && v.anyAds);

console.log("\nwhere each brand came, run by run");
const z = v.brandLines.find((b) => b.name === "Zento");
const l = v.brandLines.find((b) => b.name === "Lumi");
const a = v.brandLines.find((b) => b.name === "Arvo");
check("positions per run, 0 where it wasn't named", z.positions.join() === "3,1,1" && l.positions.join() === "2,0,0", JSON.stringify(v.brandLines));
check("its movement in words", z.trend === "3rd → 1st" && l.trend === "gone" && a.trend === "new", v.brandLines.map((b) => `${b.name}:${b.trend}`).join(" "));
check("your brand is marked", z.isYou && !l.isYou);

console.log("\nsites cited, run by run");
const site = (d) => v.sites.find((x) => x.domain === d);
check("a site cited every run says so", site("smartprix.com").trend === "every run" && site("smartprix.com").cells.every(Boolean));
check("a site that stopped being cited is 'dropped'", site("kovo.com").trend === "dropped");
check("one that started is 'new'", site("91mobiles.com").trend === "new");
check("a page only read is not a cited site", !site("reddit.com"));

console.log("\nsearches, by what they were after");
check("each search counted, not '[object Object]'", v.intents.reduce((t, i) => t + i.count, 0) === 2, JSON.stringify(v.intents));
check("with the runs that had them", v.intents.every((i) => i.inRuns === 3), JSON.stringify(v.intents.map((i) => i.inRuns)));

console.log("\nwhat changed, first run to latest");
check("your place then and now", v.changed.you.from === 3 && v.changed.you.to === 1);
check("share of the first run's cited sites still cited", v.changed.kept === 50, v.changed.kept);
check("sites gained and lost", v.changed.gained === 2 && v.changed.lost === 1, `${v.changed.gained}/${v.changed.lost}`);
check("and the change list in words", v.changed.items.some((x) => /Zento/.test(x.text)), JSON.stringify(v.changed.items));
check("one run: nothing to compare", overTimeView([caps[0]], { own }).changed === null);
check("no runs: null", overTimeView([]) === null);

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
