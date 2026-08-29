/*
 * content-main.js — runs in the page's MAIN world at document_start.
 *
 * Responsibility: intercept the engine's conversation network calls and hand the
 * RAW response out untouched. It does NO parsing — parsing happens in the service
 * worker against the immutable raw store, so it can be re-run ("Reprocess all")
 * after we improve an adapter without re-capturing.
 *
 * It must be installed before the page's own JS runs, hence world:MAIN +
 * document_start. Because MAIN world has no chrome.* APIs, it hands data to the
 * ISOLATED world over postMessage — see the privacy note on emit().
 */
(() => {
  if (window.__LCFC_INSTALLED__) return;
  window.__LCFC_INSTALLED__ = true;

  const IS_GEMINI = /(^|\.)gemini\.google\.com$/i.test(location.hostname);
  const IS_CHATGPT = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(location.hostname);
  const IS_PERPLEXITY = /(^|\.)perplexity\.ai$/i.test(location.hostname);
  const IS_GROK = /(^|\.)grok\.com$|(^|\.)x\.com$/i.test(location.hostname);
  const IS_CLAUDE = /(^|\.)claude\.ai$/i.test(location.hostname);

  const isThirdParty = (url) => {
    try {
      const u = new URL(url, location.href);
      return !u.hostname.includes("perplexity.ai") &&
             !u.hostname.includes("chatgpt.com") &&
             !u.hostname.includes("openai.com") &&
             !u.hostname.includes("google.com") &&
             !u.hostname.includes("grok.com") &&
             !u.hostname.includes("x.com") &&
             !u.hostname.includes("claude.ai");
    } catch (_) {
      return false;
    }
  };

  const isBackgroundSubscription = (str) => {
    if (typeof str !== "string") return false;
    return str.includes("SidebarRecentThreads") ||
           str.includes("SidebarPinnedThreads") ||
           str.includes("SpaceUpdatesSubscription") ||
           str.includes("CollectionThreadsSubscription") ||
           str.includes("NotificationSubscription") ||
           str.includes("ViewerUserQuery") ||
           str.includes('"type":"ping"') ||
           str.includes('"type":"pong"');
  };

  const CHATGPT_RE = /\/backend-api\/(?:f\/)?conversation(?:\?|$)/i;
  const GEMINI_RE = /assistant\.lamda\.BardFrontendService\/StreamGenerate|\/StreamGenerate\b/i;
  // NOTE: `sse` is in the /rest/ alternation deliberately. The previous
  // pattern had `\/api\/sse\/` and `\/rest\/(threads|queries|answers|
  // conversations)` but NOT `/rest/sse/` — so a request to
  // /rest/sse/perplexity_ask matched no branch at all and was never
  // intercepted. That is a capture-nothing failure, not a parse failure:
  // the adapter can be perfect and still see zero bytes.
  //
  // Widening here is safe for the other engines: CONV_RE dispatches on
  // hostname first, so this pattern is only ever tested against
  // perplexity.ai URLs. The noise filter just below (suggest./search/v2/
  // /api/predict) still applies.
  const PERPLEXITY_RE = /\/p\/api\/|\/api\/sse\/|\/rest\/(?:sse|threads|queries|answers|conversations)|perplexity_ask|\/api\/thread|\/socket\.io\//i;
  const GROK_RE = /\/api\/rpc|\/rest\/app-chat\/conversations|\/i\/api\/(?:graphql\/[^\/]+\/)?(?:Create)?Grok|\/2\/grok/i;
  const CLAUDE_RE = /\/api\/organizations\/[^\/]+\/(?:chat_conversations|messages|retry|completion)|\/api\/append_message/i;

  const CONV_RE = {
    test: (url) => {
      const u = url || "";
      if (isThirdParty(u)) return false;
      if (/suggest\.perplexity\.ai|\/search\/v2\/|\/api\/predict/i.test(u)) return false;
      if (IS_GEMINI) return GEMINI_RE.test(u);
      if (IS_CHATGPT) return CHATGPT_RE.test(u);
      if (IS_PERPLEXITY) return PERPLEXITY_RE.test(u);
      if (IS_GROK) return GROK_RE.test(u);
      if (IS_CLAUDE) return CLAUDE_RE.test(u);
      return false;
    },
  };

  const IS_TARGET = IS_GEMINI || IS_CHATGPT || IS_PERPLEXITY || IS_GROK || IS_CLAUDE;

  const CHANNEL = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  try {
    document.documentElement.setAttribute("data-lcfc-ch", CHANNEL);
  } catch (_) {
    /* ignore */
  }

  function emit(record) {
    try {
      window.postMessage({ __LCFC__: CHANNEL, type: "raw-conversation", ...record }, location.origin);
    } catch (_) {
      /* ignore */
    }
  }

  function debugOn() {
    try {
      return document.documentElement.getAttribute("data-lcfc-dbg") === "1";
    } catch (_) {
      return false;
    }
  }
  function dbg(kind, data) {
    if (!IS_TARGET || !debugOn()) return;
    try {
      window.postMessage(
        { __LCFC__: CHANNEL, type: "debug", kind, data, host: location.hostname, t: Date.now() },
        location.origin
      );
    } catch (_) {
      /* ignore */
    }
  }

  // Drain a cloned stream to text without disturbing the branch the page reads.
  async function drain(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
    } catch (_) {
      /* partial capture is still useful */
    }
    raw += decoder.decode();
    if (raw && !isBackgroundSubscription(raw)) {
      emit({ ...meta, raw, capturedAt: Date.now() });
    }
  }

  // --- fetch patch (ChatGPT, Claude, Perplexity REST stream via fetch) ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1];
    let url = "";
    let method = "GET";
    try {
      url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      method = String(
        (init && init.method) || (input instanceof Request ? input.method : "GET") || "GET"
      ).toUpperCase();
    } catch (_) {
      url = "";
    }

    const isConv = (method === "POST" || (IS_PERPLEXITY && /socket\.io|sse/i.test(url))) && CONV_RE.test(url || "");
    let reqBody = null;
    if (isConv) {
      try {
        if (init && typeof init.body === "string") {
          if (isBackgroundSubscription(init.body)) return origFetch.apply(this, args);
          reqBody = init.body;
        } else if (input instanceof Request) {
          reqBody = await input.clone().text();
          if (isBackgroundSubscription(reqBody)) return origFetch.apply(this, args);
        }
      } catch (_) {
        reqBody = null;
      }
    }

    const resp = await origFetch.apply(this, args);
    if (method === "POST") {
      dbg("fetch", { url: (url || "").slice(0, 140), status: resp && resp.status, matched: isConv });
    }
    if (isConv && resp) {
      try {
        const cloned = resp.clone();
        if (cloned.body) {
          drain(cloned.body, { url, reqBody, transport: "fetch" });
        } else if (typeof cloned.text === "function") {
          cloned.text().then((raw) => {
            if (raw && !isBackgroundSubscription(raw)) {
              emit({ url, reqBody, transport: "fetch", raw, capturedAt: Date.now() });
            }
          }).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
    }
    return resp;
  };

  // --- XHR patch (Gemini's StreamGenerate is XHR, not fetch) ---
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__lcfc_url = String(url || "");
      this.__lcfc_post = String(method || "").toUpperCase() === "POST";
      this.__lcfc_conv = this.__lcfc_post && CONV_RE.test(this.__lcfc_url);
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      if (this.__lcfc_post) dbg("xhr", { url: this.__lcfc_url.slice(0, 140), matched: !!this.__lcfc_conv });
      if (this.__lcfc_conv) {
        this.__lcfc_body = typeof body === "string" ? body : null;
        if (isBackgroundSubscription(this.__lcfc_body)) return send.call(this, body);
        this.addEventListener("load", () => {
          let raw = "";
          try {
            raw = this.responseText || "";
          } catch (_) {
            raw = "";
          }
          dbg("xhr-done", { url: this.__lcfc_url.slice(0, 100), len: raw.length, rt: this.responseType || "text" });
          if (raw && !isBackgroundSubscription(raw)) {
            try {
              emit({ url: this.__lcfc_url, reqBody: this.__lcfc_body, transport: "xhr", raw, capturedAt: Date.now() });
            } catch (_) {
              /* ignore */
            }
          }
        });
      }
      return send.call(this, body);
    };
  }

  // --- WebSocket patch (Perplexity & Grok stream queries and search results over WebSocket/Socket.IO) ---
  const OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    function PatchedWebSocket(url, protocols) {
      const ws = Reflect.construct(OrigWebSocket, arguments, PatchedWebSocket);
      const wsUrl = String(url || "");
      const isTargetWs = (IS_PERPLEXITY && (/socket\.io|perplexity\.ai/i.test(wsUrl) || !isThirdParty(wsUrl))) ||
                         (IS_GROK && /rpc|grok/i.test(wsUrl));

      if (isTargetWs) {
        let lastReqBody = null;
        let frames = [];
        let emitTimer = null;

        const scheduleEmit = () => {
          if (emitTimer) clearTimeout(emitTimer);
          emitTimer = setTimeout(() => {
            if (frames.length && lastReqBody) {
              const raw = frames.join("\n");
              if (!isBackgroundSubscription(raw)) {
                emit({ url: wsUrl, reqBody: lastReqBody, transport: "websocket", raw, capturedAt: Date.now() });
              }
            }
          }, 1500);
        };

        const origSend = ws.send;
        ws.send = function (data) {
          try {
            if (typeof data === "string") {
              if (!isBackgroundSubscription(data)) {
                if (/^4[0-9]/.test(data) || (data.startsWith("{") && (data.includes('"query"') || data.includes('"variables"')))) {
                  lastReqBody = data;
                  frames = [];
                }
              }
            }
          } catch (_) {}
          return origSend.apply(this, arguments);
        };

        ws.addEventListener("message", (event) => {
          try {
            const d = typeof event.data === "string" ? event.data : "";
            if (d && !isBackgroundSubscription(d) && (/^4[0-9]/.test(d) || d.startsWith("{") || d.startsWith("["))) {
              frames.push(d);
              scheduleEmit();
            }
          } catch (_) {}
        });

        ws.addEventListener("close", () => {
          if (emitTimer) clearTimeout(emitTimer);
          if (frames.length && lastReqBody) {
            const raw = frames.join("\n");
            if (!isBackgroundSubscription(raw)) {
              emit({ url: wsUrl, reqBody: lastReqBody, transport: "websocket", raw, capturedAt: Date.now() });
            }
          }
        });
      }
      return ws;
    }
    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
    Object.setPrototypeOf(PatchedWebSocket, OrigWebSocket);
    window.WebSocket = PatchedWebSocket;
  }
})();
