/*
 * chatgptConversation.js — a finished ChatGPT turn, from the conversation
 * ChatGPT's own page loads (1.0.0).
 *
 * Why this exists. The owner's ChatGPT answers stopped being recorded, and
 * each fix to how the page or its stream was read held for a day. Their
 * recording of 13 Nov 2026 showed the real cause on their computer: another
 * extension (inject.js, "patchedFetch") takes over the page's fetch so that
 * CitoSkeleton's network hook is never called, and ChatGPT's thread markup
 * changes from one week to the next. Neither is in our control.
 *
 * What is: the conversation itself. ChatGPT's page loads it from
 * /backend-api/conversation(s)/<id> to draw the chat, with the same message
 * objects its answer stream carries (content parts, content_references,
 * search_result_groups, search_model_queries). Once a question asked in the
 * tab has been answered, content-iso.js asks for that conversation the same
 * way the page does (its cookies and its device and account identifiers; the
 * page itself sends no Authorization header, so none is used), from the
 * extension's side, where another extension's fetch hook can't reach, and
 * this file turns its latest turn into the stream lines the ChatGPT adapter
 * already reads. One adapter, two ways in.
 *
 * Pure: no browser, no network.
 */

/** The conversation's messages in order, from either response shape. */
export function conversationMessages(conv) {
  if (!conv || typeof conv !== "object") return [];
  if (Array.isArray(conv.messages)) return conv.messages.filter((m) => m && typeof m === "object");
  // The classic shape: a tree in `mapping`, walked from current_node to the root.
  const map = conv.mapping;
  if (!map || typeof map !== "object") return [];
  const out = [];
  const seen = new Set();
  let id = conv.current_node;
  while (id && map[id] && !seen.has(id)) {
    seen.add(id);
    if (map[id].message) out.push(map[id].message);
    id = map[id].parent;
  }
  return out.reverse();
}

const roleOf = (m) => (m && m.author && m.author.role) || null;
const textOf = (m) => {
  const parts = m && m.content && Array.isArray(m.content.parts) ? m.content.parts : [];
  return parts.filter((p) => typeof p === "string").join("\n").trim();
};

/**
 * The latest turn: the last question and everything after it. Null while
 * the answer isn't finished (no final assistant text yet, or still
 * streaming), so the caller asks again later.
 * @returns {{prompt: string, messages: object[], finalText: string, userMessageId: string|null, createTime: number|null}|null}
 */
export function latestTurn(conv) {
  const msgs = conversationMessages(conv);
  let u = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (roleOf(msgs[i]) === "user" && textOf(msgs[i])) { u = i; break; }
  if (u < 0) return null;
  const after = msgs.slice(u + 1);
  const finals = after.filter((m) => roleOf(m) === "assistant" && (m.content || {}).content_type === "text" && textOf(m) && (!m.recipient || m.recipient === "all"));
  const last = finals[finals.length - 1];
  if (!last) return null;
  if (last.status && last.status !== "finished_successfully") return null;
  return {
    prompt: textOf(msgs[u]),
    messages: [msgs[u], ...after],
    finalText: textOf(last),
    userMessageId: msgs[u].id || null,
    createTime: Number(msgs[u].create_time) || null,
  };
}

/**
 * The turn as the stream the ChatGPT adapter reads: one `data:` line per
 * message, then [DONE]; and the request body it reads the prompt from.
 */
export function turnAsCapture(conv, turn = latestTurn(conv)) {
  if (!turn) return null;
  const cid = conv.conversation_id || conv.id || null;
  // The stream's own form for a whole message ({"o":"add","v":{message}},
  // its channel beside it), which the adapter reads message by message.
  const lines = turn.messages.map((m, i) => `data: ${JSON.stringify({ p: "", o: "add", v: { message: m, conversation_id: cid }, c: i, ...(m.channel ? { channel: m.channel } : {}) })}`);
  lines.push("data: [DONE]");
  return {
    raw: lines.join("\n\n") + "\n\n",
    reqBody: JSON.stringify({ action: "next", conversation_id: cid, messages: [{ id: turn.userMessageId, author: { role: "user" }, content: { content_type: "text", parts: [turn.prompt] } }], model: conv.default_model_slug || null }),
    conversationId: cid,
    prompt: turn.prompt,
  };
}

/** Is this capture a conversation as ChatGPT's page loads it (JSON, not a stream)? */
export function isConversationJson(raw, url = "") {
  const t = String(raw || "").trimStart();
  if (!t.startsWith("{")) return false;
  if (!/\/backend-(?:api|anon)\/conversations?\//.test(String(url || ""))) return false;
  return /"(?:mapping|messages)"\s*:/.test(t.slice(0, 200000));
}
