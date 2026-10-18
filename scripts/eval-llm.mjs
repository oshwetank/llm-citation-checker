#!/usr/bin/env node
/*
 * How well each built-in AI size reads answers (0.70.0).
 *
 *   node scripts/eval-llm.mjs light standard strong   # the real models (downloads them)
 *   node scripts/eval-llm.mjs --stand-in              # the 260 KB test model, offline
 *
 * Loads the extension in Chromium (Playwright), downloads each size through
 * the extension itself, runs the check on every answer in
 * test/eval/answers.json (made up: six languages, consumer, business,
 * public-sector and local), and scores it against what a careful reader
 * would say. Writes test/eval/results.md. Needs a GPU-capable Chromium for
 * realistic speed; add --gpu to pass Chrome's WebGPU flags.
 *
 * "Rules alone" is the extension without the model: it has the brand names
 * but no language, market, intent or stance, and finds no missed names.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(import.meta.url);
let pw; for (const c of ["playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) { try { pw = req(c); break; } catch (_) { /* next */ } }
if (!pw) { console.error("playwright is needed: npm i -g playwright"); process.exit(1); }

const args = process.argv.slice(2);
const standIn = args.includes("--stand-in");
const tiers = standIn ? ["stand-in"] : args.filter((a) => !a.startsWith("--"));
if (!tiers.length) { console.error("usage: node scripts/eval-llm.mjs light standard strong | --stand-in"); process.exit(1); }
const SET = JSON.parse(readFileSync(path.join(ROOT, "test/eval/answers.json"), "utf8")).answers;

let server = null, HOST = null;
if (standIn) {
  const dir = path.join(ROOT, "test/fixtures/llm-tiny");
  server = http.createServer((q, res) => {
    const m = /^\/tiny\/resolve\/main\/(.+)$/.exec(decodeURIComponent(q.url.split("?")[0]));
    const f = m && path.join(dir, m[1]);
    const h = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length" };
    if (!f || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404, h); return res.end(); }
    const b = readFileSync(f); res.writeHead(200, { ...h, "content-length": b.length }); res.end(q.method === "HEAD" ? undefined : b);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  HOST = `http://127.0.0.1:${server.address().port}/`;
}

const gpuFlags = args.includes("--gpu") ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] : [];
const ctx = await pw.chromium.launchPersistentContext(`/tmp/citoskeleton-eval-${Date.now()}`, {
  headless: false, args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, "--headless=new", "--no-sandbox", ...gpuFlags],
});
const base = (l) => (l ? String(l).toLowerCase().split("-")[0] : null);
const results = [];
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  const id = sw.url().split("/")[2];
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/ui/panel.html?mode=tab`);
  const msg = (m) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), m);
  for (const tier of tiers) {
    console.log(`\n== ${tier}`);
    if (standIn) await msg({ type: "ai-test-model", model: { repo: "tiny", host: HOST, dtype: "fp32" } });
    const d = await msg({ type: "ai-download", tier: standIn ? undefined : tier });
    if (!d || !d.ok) { console.log("download did not start", d); continue; }
    const t0 = Date.now();
    for (;;) { const s = await msg({ type: "ai-status" }); if (s.ready || s.error) { if (s.error) console.log("error:", s.error); break; } process.stdout.write(`\r  downloading ${s.progress && s.progress.pct != null ? Math.round(s.progress.pct) : 0}%   `); await page.waitForTimeout(1000); }
    console.log(`\n  loaded in ${Math.round((Date.now() - t0) / 1000)} s`);
    const score = { n: 0, lang: 0, country: 0, currency: 0, intent: 0, audience: 0, stanceN: 0, stance: 0, missedFound: 0, missedTotal: 0, missedWrong: 0, ms: 0 };
    for (const a of SET) {
      const rec = { captureId: `eval-${a.id}`, userPrompt: a.prompt, answerText: a.answer, brandMentions: a.brands.map((b) => ({ brand: b, count: 1, firstIndex: a.answer.indexOf(b) })) };
      const r = await msg({ type: "ai-check-now", record: rec });
      if (!r || !r.ok) { console.log(`  ${a.id}: failed`, r && r.error); continue; }
      const ai = r.ai, e = a.expect;
      score.n++; score.ms += ai.wallMs || 0;
      if (base(ai.lang) === base(e.lang)) score.lang++;
      if ((ai.market && ai.market.country || null) === e.country) score.country++;
      if ((ai.market && ai.market.currency || null) === e.currency) score.currency++;
      if (e.intent.includes(ai.intent)) score.intent++;
      if (ai.audience === e.audience) score.audience++;
      for (const [name, ok] of Object.entries(e.stances)) { score.stanceN++; const x = (ai.entities || []).find((q) => q.name === name); if (x && ok.includes(x.stance)) score.stance++; }
      const got = (ai.missed || []).map((x) => x.name.toLowerCase());
      score.missedTotal += e.missed.length;
      score.missedFound += e.missed.filter((m) => got.includes(m.toLowerCase())).length;
      score.missedWrong += got.filter((g) => !e.missed.some((m) => m.toLowerCase() === g)).length;
      console.log(`  ${a.id}: ${base(ai.lang) || "-"} ${(ai.market || {}).country || "-"} ${ai.intent || "-"} · ${(ai.entities || []).map((x) => `${x.name}=${x.stance}`).join(", ")} · missed ${got.join(", ") || "none"} · ${Math.round((ai.wallMs || 0) / 100) / 10} s`);
    }
    results.push({ tier, ...score });
  }
} finally { await ctx.close(); if (server) server.close(); }

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const rows = [["Rules alone", "–", "–", "–", "–", "–", "–", `0 of ${results[0] ? results[0].missedTotal : 0}`, "0", "–"],
  ...results.map((s) => [s.tier, pct(s.lang, s.n), pct(s.country, s.n), pct(s.currency, s.n), pct(s.intent, s.n), pct(s.audience, s.n), pct(s.stance, s.stanceN), `${s.missedFound} of ${s.missedTotal}`, String(s.missedWrong), s.n ? `${(s.ms / s.n / 1000).toFixed(1)} s` : "–"])];
const head = ["Model", "Language", "Country", "Currency", "Intent", "Audience", "Stance", "Missed names found", "Wrong names", "Per answer"];
const md = [`# Built-in AI eval (${new Date().toISOString().slice(0, 10)})`, "", `${SET.length} made-up answers (test/eval/answers.json).`, "",
  `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""].join("\n");
writeFileSync(path.join(ROOT, "test/eval/results.md"), md);
console.log("\n" + md);
