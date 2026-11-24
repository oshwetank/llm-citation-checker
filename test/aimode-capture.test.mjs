/*
 * aimode-capture.test.mjs — capturing Google AI Mode in the page (1.0.5).
 *
 * Runs the REAL src/content-main.js on mock www.google.com pages: on an AI
 * Mode page (/search?udm=50) Google's GET /async/folwr is reported as the
 * send (with its q) and its answer is handed over; on an ordinary results
 * page the script does nothing at all. The answer is a synthetic payload
 * (test/helpers/aimode-stream.mjs), read here by the real adapter.
 * Run: node test/aimode-capture.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { aiModePayload } from "./helpers/aimode-stream.mjs";
import { adapt } from "../src/adapters/aimode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(path.resolve(HERE, "..", "src", "content-main.js"), "utf8");
let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const req = createRequire(import.meta.url);
let pw = null;
for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
if (!pw) { console.log("aimode-capture: CANNOT RUN — playwright is not installed."); process.exit(1); }
const browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] });
const PROMPT = "best trail shoes for wide feet";
const PAYLOAD = aiModePayload({ prompt: PROMPT });

async function run(pageUrl) {
  const page = await browser.newPage();
  await page.route("**/*", (r) => {
    const u = r.request().url();
    if (/\/async\/folwr/.test(u)) return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAYLOAD });
    return r.fulfill({ status: 200, contentType: "text/html", body: "<body><div id='x'></div></body>" });
  });
  await page.goto(pageUrl);
  return page.evaluate(async ({ main, prompt }) => {
    const got = [];
    window.addEventListener("message", (e) => { if (e.data && e.data.__LCFC__) got.push(e.data); });
    eval(main); // eslint-disable-line no-eval
    await fetch(`/async/folwr?q=${encodeURIComponent(prompt)}&udm=50&ei=SECRET`).then((r) => r.text());
    await fetch("/async/bgasy?q=x").then((r) => r.text());
    await new Promise((r) => setTimeout(r, 1500));
    return got.map((m) => ({ type: m.type, via: m.via, q: m.q, url: m.url, raw: m.raw }));
  }, { main: MAIN, prompt: PROMPT });
}

console.log("\nAn AI Mode page (/search?udm=50)");
{
  const got = await run(`https://www.google.com/search?udm=50&q=${encodeURIComponent(PROMPT)}`);
  const sent = got.filter((m) => m.type === "engine-submit");
  const raw = got.filter((m) => m.type === "raw-conversation");
  check("Google's answer request is the send, with its question", sent.length === 1 && sent[0].via === "fetch" && sent[0].q === PROMPT, JSON.stringify(sent));
  check("its answer is handed over once", raw.length === 1 && /folwr/.test(raw[0].url) && raw[0].raw.length > 500, JSON.stringify(raw.map((m) => [m.url, (m.raw || "").length])));
  check("other /async calls are not answers", !raw.some((m) => /bgasy/.test(m.url)));
  check("Google's tracking parameters are not kept", raw.length === 1 && !/ei=|SECRET/.test(raw[0].url) && /q=/.test(raw[0].url), raw[0] && raw[0].url);
  if (raw[0]) {
    const rec = await adapt({ captureId: "c1", raw: raw[0].raw, url: raw[0].url });
    check("and the adapter makes the record from it", rec.platform === "aimode" && rec.userPrompt === PROMPT && rec.sources.length === 2 && rec.answerChars > 50, JSON.stringify([rec.userPrompt, rec.sources.length, rec.answerChars]));
  }
}

console.log("\nAn ordinary Google results page");
{
  const got = await run(`https://www.google.com/search?q=${encodeURIComponent(PROMPT)}`);
  check("nothing at all: no send, no capture", got.length === 0, JSON.stringify(got.map((m) => m.type)));
}

await browser.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
