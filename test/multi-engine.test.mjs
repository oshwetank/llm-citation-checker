/*
 * multi-engine.test.mjs — verify Perplexity, Grok, and Claude adapters.
 *
 * Tests that all 3 new adapters normalize synthetic and real-world network
 * payloads into the standard CitoSkeleton schema:
 *   - Perplexity: SSE stream, query plan, sub-searches, cited sources.
 *   - Grok: Social X/Twitter posts, like metrics, web sources, DeepSearch thinking.
 *   - Claude: Web search tool use/results, citations, extended thinking trace.
 */

import { adapt as adaptPerplexity } from "../src/adapters/perplexity.js";
import { adapt as adaptGrok } from "../src/adapters/grok.js";
import { adapt as adaptClaude } from "../src/adapters/claude.js";
import { ENGINES, availableEngines } from "../src/lib/geo.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
};

console.log("\n--- Engine Registry & URL Attribution ---");
{
  const available = availableEngines();
  check("all 5 engines are now available in ENGINES registry", available.length === 5, `count=${available.length}`);
  check("perplexity is registered and available", available.some((e) => e.id === "perplexity"));
  check("grok is registered and available", available.some((e) => e.id === "grok"));
  check("claude is registered and available", available.some((e) => e.id === "claude"));

  // Check URL attribution
  const platformFromUrl = (url) => {
    const u = String(url || "");
    if (/gemini\.google\.com|BardChatUi|StreamGenerate/i.test(u)) return "gemini";
    if (/perplexity\.ai|\/api\/sse\/query|\/api\/thread|\/rest\/queries/i.test(u)) return "perplexity";
    if (/grok\.com|x\.com\/i\/grok|app-chat\/conversations/i.test(u)) return "grok";
    if (/claude\.ai|chat_conversations/i.test(u)) return "claude";
    if (/chatgpt\.com|chat\.openai\.com|backend-api/i.test(u)) return "chatgpt";
    return "chatgpt";
  };

  check("perplexity url correctly resolved", platformFromUrl("https://www.perplexity.ai/search/123") === "perplexity");
  check("grok url correctly resolved", platformFromUrl("https://grok.com/chat/abc") === "grok");
  check("x.com grok url correctly resolved", platformFromUrl("https://x.com/i/grok") === "grok");
  check("claude url correctly resolved", platformFromUrl("https://claude.ai/chat/xyz") === "claude");
  check("chatgpt url correctly resolved", platformFromUrl("https://chatgpt.com/c/123") === "chatgpt");
  check("gemini url correctly resolved", platformFromUrl("https://gemini.google.com/app/456") === "gemini");
}

console.log("\n--- Perplexity AI Adapter ---");
{
  const sseRaw = [
    'data: {"text": "When comparing smartphones, **Apple iPhone 16** and **Samsung Galaxy S24** are top choices [1]."}',
    'data: {"web_results": [{"name": "Apple iPhone 16 Review", "url": "https://theverge.com/iphone-16", "snippet": "A powerful flagship with A18 chip."}]}',
    'data: {"query_plan": [{"query": "best smartphones 2026", "results": [{"name": "Samsung Galaxy S24 Ultra", "url": "https://cnet.com/galaxy-s24", "snippet": "Top tier display and cameras."}]}]}',
    'data: {"related_queries": ["Which phone has best battery life?", "iPhone 16 vs Galaxy S24 cameras"]}',
  ].join("\n");

  const rec = await adaptPerplexity({
    captureId: "perp-1",
    raw: sseRaw,
    reqBody: JSON.stringify({ query: "best smartphones to buy in 2026" }),
    capturedAt: Date.now(),
    pageUrl: "https://www.perplexity.ai/search/test",
  }, {
    tracked: [{ name: "Apple" }, { name: "Samsung" }],
  });

  check("platform is perplexity", rec.platform === "perplexity");
  check("userPrompt extracted from reqBody", rec.userPrompt === "best smartphones to buy in 2026");
  check("answerText normalized", rec.answerText.includes("Apple iPhone 16"));
  check("sources extracted from web_results & query_plan", rec.sources.length === 2, `sources=${rec.sources.length}`);
  check("source domain normalized", rec.sources.some((s) => s.domain === "theverge.com"));
  check("fanout search queries populated from query_plan and related_queries", rec.fanout.search.length >= 2);
  check("brands detected in Perplexity answer", rec.brandMentions.some((b) => b.brand.toLowerCase() === "apple" || b.brand.toLowerCase() === "samsung"));

  // Test Socket.IO Perplexity frames
  const wsRaw = [
    '42["query_progress", {"text": "Perplexity is a conversational answer engine using **Google** and **Bing** search indices.", "display_model": "sonar-pro"}]',
    '42["query_progress", {"web_results": [{"name": "Perplexity AI Features", "url": "https://techcrunch.com/perplexity-review", "snippet": "Live citations and multi-query search."}]}]',
  ].join("\n");

  const wsRec = await adaptPerplexity({
    captureId: "perp-ws-1",
    raw: wsRaw,
    reqBody: '42["perplexity_query", {"query": "how does perplexity work"}]',
    pageUrl: "https://www.perplexity.ai",
  });

  check("perplexity websocket prompt extracted", wsRec.userPrompt === "how does perplexity work");
  check("perplexity websocket model extracted", wsRec.model === "sonar-pro");
  check("perplexity websocket answer extracted", wsRec.answerText.includes("conversational answer engine"));
  check("perplexity websocket sources extracted", wsRec.sources.length === 1);
  check("perplexity websocket domain extracted", wsRec.sources[0].domain === "techcrunch.com");

  // Test Socket.IO 430 ACK response frames
  const ackRaw = [
    '430[{"text": "The latest results for smartphone rankings show top devices in 2026.", "sources": [{"url": "https://gsmarena.com/phones", "title": "GSMArena"}]}]',
  ].join("\n");

  const ackRec = await adaptPerplexity({
    captureId: "perp-ack-1",
    raw: ackRaw,
    reqBody: '420["perplexity_query", {"query": "smartphone rankings 2026"}]',
    pageUrl: "https://www.perplexity.ai",
  });

  check("perplexity ACK prompt extracted", ackRec.userPrompt === "smartphone rankings 2026");
  check("perplexity ACK answer extracted", ackRec.answerText.includes("latest results for smartphone rankings"));
  check("perplexity ACK sources extracted", ackRec.sources.length === 1);
}

console.log("\n--- xAI Grok Adapter ---");
{
  const grokRaw = [
    JSON.stringify({
      message: "Tesla and Waymo are leading autonomous vehicle deployment in 2026.",
      web_search_results: [
        { title: "Tesla FSD v13 Rollout", url: "https://electrek.co/tesla-fsd", snippet: "Unsupervised rollout begins." },
        {
          title: "Elon Musk on Robotaxi",
          url: "https://x.com/elonmusk/status/123456789",
          snippet: "FSD v13 deployment expanding rapidly.",
          author: "elonmusk",
          likes: 45200,
          is_x_post: true,
        },
      ],
      queries: ["tesla autonomous rollout 2026", "waymo commercial expansion"],
      thought: "Analyzing latest NHTSA reports and official autonomous vehicle fleet updates.",
    }),
  ].join("\n");

  const rec = await adaptGrok({
    captureId: "grok-1",
    raw: grokRaw,
    reqBody: JSON.stringify({ message: "autonomous vehicles update 2026" }),
    capturedAt: Date.now(),
    pageUrl: "https://grok.com",
  }, {
    tracked: [{ name: "Tesla" }, { name: "Waymo" }],
  });

  check("platform is grok", rec.platform === "grok");
  check("userPrompt extracted", rec.userPrompt === "autonomous vehicles update 2026");
  check("answerText normalized", rec.answerText.includes("Tesla and Waymo"));
  check("web and social sources extracted", rec.sources.length === 2);
  check("social citation extracted with X metrics", Boolean(rec.platformSpecific?.socialCitations?.length === 1 && rec.platformSpecific.socialCitations[0].author === "elonmusk"));
  check("social citation likes count parsed", rec.platformSpecific.socialCitations[0].likes === 45200);
  check("DeepSearch thinking thoughts extracted", Boolean(rec.platformSpecific?.thoughts?.length > 0));
  check("brands detected in Grok answer", rec.brandMentions.some((b) => b.brand.toLowerCase() === "tesla"));

  // Test real-world grok.com load-responses payload structure
  const grokRealPayload = JSON.stringify({
    responses: [
      {
        responseId: "ed9e77b9-be20-4e87-935e-f6f9b7ea3d8a",
        message: "best camera phone under 40000 in india",
        sender: "human",
      },
      {
        responseId: "6e00071b-5667-4bca-8b69-508764e03ce4",
        message: "**Tecno Camon 50 Ultra (around ₹39,999) is currently one of the strongest camera-focused picks under ₹40,000 in India**",
        sender: "assistant",
        model: "grok-3",
        webSearchResults: [
          { url: "https://www.91mobiles.com/list-of-phones/top-10-camera-mobiles-below-40000-in-india", title: "91mobiles", preview: "Review preview text" }
        ],
        cardAttachmentsJson: [
          JSON.stringify({ id: "64481f", type: "render_inline_citation", url: "https://www.91mobiles.com/list-of-phones/top-10-camera-mobiles-below-40000-in-india" })
        ],
        steps: [
          {
            toolUsageCards: [
              { webSearch: { args: { query: "best camera phone under 40000 in India 2026" } } }
            ]
          }
        ]
      }
    ]
  });

  const realRec = await adaptGrok({
    captureId: "grok-real-1",
    raw: grokRealPayload,
    pageUrl: "https://grok.com/chat/123",
  }, {
    tracked: [{ name: "Tecno" }],
  });

  check("real grok payload prompt extracted", realRec.userPrompt === "best camera phone under 40000 in india");
  check("real grok payload model extracted", realRec.model === "grok-3");
  check("real grok payload answer extracted", realRec.answerText.includes("Tecno Camon 50 Ultra"));
  check("real grok payload source extracted with preview", realRec.sources.length === 1);
  check("real grok payload inline citation marked cited", realRec.sources[0].outcome === "cited");
  check("real grok payload sub-query extracted into fanout", realRec.fanout.search.some((s) => s.query.includes("best camera phone under 40000")));
}

console.log("\n--- Anthropic Claude Adapter ---");
{
  const claudeRaw = [
    'data: {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "First let us check market share for cloud providers AWS, Azure, and Google Cloud."}}',
    'data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "In enterprise cloud infrastructure, Amazon AWS and Microsoft Azure hold the largest market share."}}',
    JSON.stringify({
      content: [
        {
          type: "tool_use",
          name: "web_search",
          input: { query: "cloud market share Q1 2026" },
        },
        {
          type: "tool_result",
          content: [
            {
              url: "https://synergyrg.com/cloud-market-share",
              title: "Cloud Ecosystem Report 2026",
              snippet: "AWS holds 31%, Microsoft Azure 25%, Google Cloud 11%.",
            },
          ],
        },
      ],
    }),
  ].join("\n");

  const rec = await adaptClaude({
    captureId: "claude-1",
    raw: claudeRaw,
    reqBody: JSON.stringify({ prompt: "Who leads the enterprise cloud market?" }),
    capturedAt: Date.now(),
    pageUrl: "https://claude.ai/chat/123",
  }, {
    tracked: [{ name: "Amazon" }, { name: "Microsoft" }],
  });

  check("platform is claude", rec.platform === "claude");
  check("userPrompt extracted", rec.userPrompt.includes("enterprise cloud market"));
  check("answerText normalized from text_delta", rec.answerText.includes("Amazon AWS"));
  check("thinking trace extracted from thinking_delta", Boolean(rec.platformSpecific?.thinkingTrace && rec.platformSpecific.thinkingTrace.includes("cloud providers")));
  check("tool_use search query extracted into fanout", rec.fanout.search.some((s) => (s.query || s) === "cloud market share Q1 2026"));
  check("tool_result sources extracted", rec.sources.some((s) => s.domain === "synergyrg.com"));
  check("brands detected in Claude answer", rec.brandMentions.some((b) => b.brand.toLowerCase() === "amazon" || b.brand.toLowerCase() === "microsoft"));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);

