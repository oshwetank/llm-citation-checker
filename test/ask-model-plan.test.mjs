/*
 * ask-model-plan.test.mjs — the model's part of an Ask plan, on rails
 * (1.0.5, Stage 2 of ASK-ARCHITECTURE.md): only what the rules left open,
 * only values that exist, a fixed JSON form, one retry, then the rules'
 * plan stands. Scripted replies stand in for the model.
 * Run: node test/ask-model-plan.test.mjs
 */
import { buildCatalog } from "../src/lib/askCatalog.js";
import { modelFill, jsonIn, checkReply, planSchema } from "../src/lib/askModelPlan.js";
import { askPlanned } from "../src/lib/assistant.js";
import { data } from "./fixtures/ask-data.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? `  ${detail}` : ""}`); }
};
const catalog = buildCatalog(data);
const ids = catalog.collections.map((c) => c.id);
// A model that plays back replies, and remembers what it was asked.
const scripted = (...replies) => {
  const calls = [];
  const fn = async (o) => { calls.push(o); const x = replies.shift(); if (x instanceof Error) throw x; return { text: x === undefined ? "" : x }; };
  fn.calls = calls;
  return fn;
};

console.log("\nReading the reply");
{
  check("JSON inside a code fence and a thinking block", jsonIn('<think>hmm {"a":1}</think>```json\n{"intent":"trend","collections":[]}\n```').intent === "trend");
  check("no JSON: nothing", jsonIn("I think it's about trends.") === null);
  const c = checkReply({ intent: "metric", collections: ["pIN", "made-up", "pIN"], measure: ["visibility", "clicks"], by: "sideways" }, ids);
  check("only real campaigns, once each; only real measures; an unknown slice is none", c.collections.join() === "pIN" && c.measure.join() === "visibility" && c.by === "none", JSON.stringify(c));
  check("an intent that isn't one: rejected", checkReply({ intent: "dance", collections: [] }, ids) === null);
  const s = planSchema(ids);
  check("the schema lists the real campaigns and intents", s.properties.collections.items.enum.join() === ids.join() && s.properties.intent.enum.includes("not_recorded"));
}

console.log("\nAsking the model");
{
  const g = scripted('{"intent":"metric","collections":["pIN"]}');
  const m = await modelFill({ question: "Are we winning in the Indian campaign?", catalog, generate: g });
  check("a valid reply is used", m && m.intent === "metric" && m.collections.join() === "pIN", JSON.stringify(m));
  check("Chrome's model is held to the form by a schema", g.calls[0].schema && g.calls[0].schema.properties.intent.enum.length > 5);
  check("it is shown the campaigns, their brands and topics", /pIN: "Zento India", tracks Zento vs Kovo, Lumora, topics: battery, camera/.test(g.calls[0].messages[0].content), g.calls[0].messages[0].content.slice(0, 400));
  const g2 = scripted("It's about the Indian one.", '{"intent":"metric","collections":["pIN"]}');
  check("a reply that isn't the form is asked again once", (await modelFill({ question: "x", catalog, generate: g2 })).collections.join() === "pIN" && g2.calls.length === 2);
  const g3 = scripted("no", "still no");
  check("twice wrong: nothing, so the rules' plan stands", (await modelFill({ question: "x", catalog, generate: g3 })) === null && g3.calls.length === 2);
  check("a model that fails: nothing", (await modelFill({ question: "x", catalog, generate: scripted(new Error("busy")) })) === null);
}

console.log("\nIn Ask: the model fills only what the rules left open");
{
  const g = scripted('{"intent":"metric","collections":["pIN"]}', "Zento is doing fine.");
  const r = await askPlanned({ question: "Are we winning in the Indian campaign?", data, generate: g });
  check("\"the Indian campaign\" is Zento India", r.plan.scope.collections.join() === "pIN" && !r.askBack, JSON.stringify(r.plan.scope));
  check("and it says so, so the user can change it", r.notes.some((n) => /Took Zento India from how you put it/.test(n)), JSON.stringify(r.notes));
  const t = scripted('{"intent":"trend","collections":[]}', "Down a little.");
  const r2 = await askPlanned({ question: "Has Zento been slipping lately in Zento India?", data, generate: t });
  check("an intent no rule knows (\"slipping\"): the model's, and a trend spans all runs", r2.plan.intent === "trend" && r2.plan.scope.runs === "all" && r2.plan.scope.collections.join() === "pIN", JSON.stringify(r2.plan));
  const bogus = scripted('{"intent":"metric","collections":["nope"]}', "");
  const r3 = await askPlanned({ question: "How visible are we?", data, generate: bogus });
  check("a campaign that doesn't exist is ignored: still asks back", !!r3.askBack, JSON.stringify(r3.plan.scope));
  const one = scripted("Zento India: fine.");
  await askPlanned({ question: "How is Zento India doing?", data, generate: one });
  check("not asked when the rules filled everything (one call: the reply)", one.calls.length === 1, String(one.calls.length));
  const ctx = scripted("Fine.");
  await askPlanned({ question: "How visible are we?", data, generate: ctx, context: { collectionId: "pUS" } });
  check("not asked when the page says which campaign", ctx.calls.length === 1, String(ctx.calls.length));
  const off = await askPlanned({ question: "Are we winning in the Indian campaign?", data });
  check("with no model, the rules' plan: asks back rather than guess", !!off.askBack);
}

console.log("\na model that never answers (1.0.7: Ask sat over five minutes on 'Working out the numbers…')");
{
  let calls = 0; const seen = [];
  const never = (o) => { calls++; seen.push(o.timeLimitMs); return new Promise(() => {}); };
  const t0 = Date.now();
  const r = await askPlanned({ question: "How is Zento India doing?", data, generate: never, limits: { understandMs: 200, writeMs: 300 } });
  const ms = Date.now() - t0;
  check("the plain reply stands", r.by === "template" && !!r.answer && !/couldn't work/.test(r.answer), `${r.by}: ${r.answer}`);
  check("within the limits, not minutes", ms < 3000, `${ms} ms`);
  check("the engine was told the limit, so it can stop", seen.length > 0 && seen.every((x) => x === 200 || x === 300), seen.join(","));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
