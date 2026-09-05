/*
 * dom-harvest-multiturn.test.mjs — follow-up questions in an EXISTING chat
 * are captured as their own turn, and an answer's section heading is never
 * recorded as the user's prompt.
 *
 * Two real, user-reported bugs, both in the DOM harvester's per-platform
 * extraction, both confirmed against real captured data:
 *
 * 1. FOLLOW-UPS WERE SILENTLY DROPPED (reported on Perplexity and Grok).
 *    Three compounding causes:
 *      - `document.querySelector(...)` for the user's prompt returns the
 *        FIRST match, and these threads keep every turn mounted — so the
 *        prompt was always turn 1's, forever.
 *      - `querySelectorAll(...)` for the answer joined EVERY turn into one
 *        blob, so a follow-up re-sent the whole thread as its "answer".
 *      - the dedup signature was
 *        `plat::promptText::answerText.slice(0, 100)`. In a multi-turn
 *        thread neither half moves: the prompt is pinned to turn 1 by the
 *        first bug, and the first 100 characters of a concatenated thread
 *        are always the start of turn 1's answer regardless of how many
 *        turns follow. Every follow-up therefore produced a byte-identical
 *        sig and hit the `if (sig === lastHarvestedSig) return;` guard.
 *
 * 2. AN ANSWER'S OWN SECTION HEADING BECAME THE "USER PROMPT". The heading
 *    selector was `h1, h2, .font-display` and took the first match —
 *    routinely a heading from inside the answer body, since Perplexity
 *    renders answer sections as h2. That value then became the prompt via
 *    the empty-prompt fallback. Every real Perplexity capture in
 *    test/fixtures shows this: "Key Paint Characteristics" is recorded as
 *    the user's prompt and appears verbatim as a heading line inside its
 *    own answer (the real question was about bathroom paint).
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const src = readFileSync(new URL("../src/content-iso.js", import.meta.url), "utf8");

// tryHarvest calls domToMarkdown(), which lives in content-iso.js's enclosing
// scope rather than inside tryHarvest itself — so a body executed in
// isolation has to be handed the REAL implementation, not a stub. Extracted
// from source the same way tryHarvest is, so this stays honest if it changes.
function extractDomToMarkdown(source) {
  const start = source.indexOf("const domToMarkdown = (root) => {");
  if (start === -1) return "const domToMarkdown = (n) => (n && (n.innerText || n.textContent)) || \"\";";
  const bodyStart = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return "const domToMarkdown = (root) => " + source.slice(bodyStart, i + 1) + ";";
    }
  }
  return "const domToMarkdown = (n) => (n && (n.innerText || n.textContent)) || \"\";";
}
const DOM2MD = extractDomToMarkdown(src);

// tryHarvest also calls harvestPerplexitySteps(), another enclosing-scope
// sibling. Same rule as domToMarkdown: hand the body the REAL one, pulled
// from source, so this harness can't quietly diverge from shipped code.
function extractStepsHelper(source) {
  const grab = (decl, open, close) => {
    const at = source.indexOf(decl);
    if (at === -1) return "";
    const s = source.indexOf(open, at);
    let d = 0;
    for (let i = s; i < source.length; i++) {
      if (source[i] === open) d++;
      else if (source[i] === close) { d--; if (d === 0) return source.slice(at, i + 1) + ";"; }
    }
    return "";
  };
  const reLine = (source.match(/const PPLX_STEP_LABEL_RE = .*;/) || [""])[0];
  const selectors = grab("const PPLX_STEP_SELECTORS = [", "[", "]");
  const fn = grab("const harvestPerplexitySteps = (doc) => {", "{", "}");
  if (!fn) return "const harvestPerplexitySteps = () => [];";
  return [reLine, selectors, fn].filter(Boolean).join(String.fromCharCode(10));
}
const STEPS = extractStepsHelper(src);


function extractTryHarvest() {
  const start = src.indexOf("const tryHarvest = () => {");
  if (start === -1) return null;
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(bodyStart + 1, i);
    }
  }
  return null;
}

const body = extractTryHarvest();
check("tryHarvest() found in content-iso.js", !!body, "function renamed or removed?");

const node = (text, extra = {}) => ({ textContent: text, innerText: text, getAttribute: () => null, ...extra });

// A stub thread with `turns` Q&A pairs, each turn its own block — the real
// shape of a Perplexity/Grok conversation.
function makeThread(plat, turns, { docTitle, h1 } = {}) {
  const userSel = {
    perplexity: '[data-testid="user-query"]',
    grok: ".user-message",
  }[plat];
  const answerSel = { perplexity: ".prose", grok: ".message-row" }[plat];

  const users = turns.map((t) => node(t.q));
  const answers = turns.map((t) => node(t.a));
  const sent = [];
  const scope = {
    getPlatform: () => plat,
    document: {
      title: docTitle !== undefined ? docTitle : `${turns[0].q} - Perplexity`,
      querySelector: (sel) => (sel === "h1" ? (h1 ? node(h1) : null) : null),
      querySelectorAll: (sel) => {
        if (sel.includes(userSel)) return users;
        if (sel.includes(answerSel)) return answers;
        return [];
      },
    },
    location: { href: `https://${plat}.example/thread/1` },
    setTimeout: () => 0,
    chrome: { runtime: { sendMessage: (m) => sent.push(m), get lastError() { return undefined; } } },
  };
  return { scope, sent };
}

// Run tryHarvest repeatedly against a growing thread, sharing lastHarvestedSig
// across calls exactly like the real long-lived harvester does.
function runThread(plat, turnSets, opts) {
  const allSent = [];
  const shared = { sig: null };
  for (const turns of turnSets) {
    const { scope, sent } = makeThread(plat, turns, opts);
    const names = Object.keys(scope);
    const fn = new Function(
      ...names,
      "__sigBox",
      `${DOM2MD}
${STEPS}\nlet lastHarvestedSig = __sigBox.sig;\nlet sourcesExpandAttempts = 99;\nconst tryHarvest = () => {};\n${body}\n__sigBox.sig = lastHarvestedSig;`
    );
    fn(...names.map((n) => scope[n]), shared);
    allSent.push(...sent);
  }
  return allSent;
}

if (body) {
  console.log("\ndom-harvest-multiturn: follow-up turns are captured, not deduped away");

  for (const plat of ["perplexity", "grok"]) {
    const t1 = { q: "best gaming phone under 50000", a: "A".repeat(200) + " first answer about phones" };
    const t2 = { q: "what about under 30000", a: "B".repeat(200) + " second answer about cheaper phones" };
    const t3 = { q: "which has the best battery", a: "C".repeat(200) + " third answer about battery life" };

    const sent = runThread(plat, [[t1], [t1, t2], [t1, t2, t3]]);
    check(`${plat}: all 3 turns produce a capture (follow-ups not dropped)`, sent.length === 3, `got ${sent.length}`);

    if (sent.length === 3) {
      const parsed = sent.map((s) => JSON.parse(s.payload.raw));
      check(`${plat}: turn 2 captures the FOLLOW-UP prompt, not turn 1's`, parsed[1].query === t2.q, `got: ${JSON.stringify(parsed[1].query)}`);
      check(`${plat}: turn 3 captures the newest prompt`, parsed[2].query === t3.q, `got: ${JSON.stringify(parsed[2].query)}`);
      check(`${plat}: turn 2's answer is that turn's own, not the whole thread`, parsed[1].text.includes("second answer") && !parsed[1].text.includes("first answer"));
      check(`${plat}: turn 3's answer is that turn's own`, parsed[2].text.includes("third answer") && !parsed[2].text.includes("second answer"));
    }

    // Re-running with no new turn must still dedup (the guard's real job).
    const repeat = runThread(plat, [[t1], [t1]]);
    check(`${plat}: an unchanged thread still dedups to a single capture`, repeat.length === 1, `got ${repeat.length}`);
  }

  // DEGRADED PATH — the one only the dedup-signature fix rescues, and quite
  // possibly the REAL path on live Perplexity: the query-bubble selectors in
  // this harvester are guesses that have been wrong before (see the citation-
  // badge selector history in content-iso.js), so when they all miss, the
  // prompt falls back to the page title — which does NOT change between
  // turns. With no per-turn pairing either (one answer split across several
  // blocks, so everything is joined), the ONLY thing that moves as a
  // follow-up lands is the answer text growing at the END. The old
  // `answerText.slice(0, 100)` sig read only the START of that blob, which
  // is pinned to turn 1 forever, so every follow-up was deduped away.
  console.log("\ndom-harvest-multiturn: follow-ups still detected when selectors miss and the prompt can't change");
  {
    const sent = [];
    let answerBlocks = ["First answer about phones. " + "A".repeat(120)];
    const scope = {
      getPlatform: () => "perplexity",
      document: {
        title: "best gaming phone under 50000 - Perplexity", // constant across turns
        querySelector: () => null,
        querySelectorAll: (sel) => {
          if (sel.includes(".prose")) return answerBlocks.map((t) => node(t));
          return []; // every user-bubble selector misses
        },
      },
      location: { href: "https://perplexity.ai/thread/1" },
      setTimeout: () => 0,
      chrome: { runtime: { sendMessage: (m) => sent.push(m), get lastError() { return undefined; } } },
    };
    const names = Object.keys(scope);
    const shared = { sig: null };
    const runOnce = () => {
      const fn = new Function(
        ...names,
        "__sigBox",
        `${DOM2MD}
${STEPS}\nlet lastHarvestedSig = __sigBox.sig;\nlet sourcesExpandAttempts = 99;\nconst tryHarvest = () => {};\n${body}\n__sigBox.sig = lastHarvestedSig;`
      );
      fn(...names.map((n) => scope[n]), shared);
    };

    runOnce();
    // A follow-up lands: a second answer block is appended. There is still
    // no user bubble to pair against, so everything gets joined — the start
    // of the blob is unchanged, only its tail and length move.
    answerBlocks = [answerBlocks[0], "Second answer about cheaper phones. " + "B".repeat(120)];
    runOnce();

    check("the follow-up is captured despite an unchanged prompt and unchanged answer prefix", sent.length === 2, `got ${sent.length}`);
    if (sent.length === 2) {
      const second = JSON.parse(sent[1].payload.raw);
      check("the follow-up capture contains the new turn's content", second.text.includes("Second answer"));
    }
  }

  console.log("\ndom-harvest-multiturn: an answer's section heading is never the prompt");

  // The exact real-capture failure: query-bubble selectors miss, and the
  // answer contains a heading line. The heading must NOT become the prompt.
  {
    const heading = "Key Paint Characteristics";
    const answer = `The best wall paint for bathrooms is a 100% acrylic latex paint.\n${heading}\nAcrylic latex is the best choice for bathrooms due to moisture resistance.`;
    const sent = [];
    const scope = {
      getPlatform: () => "perplexity",
      document: {
        title: "best paint for bathroom walls - Perplexity",
        querySelector: (sel) => (sel === "h1" ? node(heading) : null),
        querySelectorAll: (sel) => (sel.includes(".prose") ? [node(answer)] : []),
      },
      location: { href: "https://perplexity.ai/thread/1" },
      setTimeout: () => 0,
      chrome: { runtime: { sendMessage: (m) => sent.push(m), get lastError() { return undefined; } } },
    };
    const names = Object.keys(scope);
    const fn = new Function(...names, `${DOM2MD}
${STEPS}\nlet lastHarvestedSig = null;\nlet sourcesExpandAttempts = 99;\nconst tryHarvest = () => {};\n${body}`);
    fn(...names.map((n) => scope[n]));

    check("a capture is still produced", sent.length === 1, `got ${sent.length}`);
    if (sent.length) {
      const parsed = JSON.parse(sent[0].payload.raw);
      check("the answer's own heading is NOT recorded as the user prompt", parsed.query !== heading, `got: ${JSON.stringify(parsed.query)}`);
      check("the real question (from the page title) is used instead", parsed.query === "best paint for bathroom walls", `got: ${JSON.stringify(parsed.query)}`);
    }
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log("\nALL PASSED");
