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

  // Per-engine turn-submission endpoints, kept tight so history/title/telemetry
  // calls don't flood the store with empty rows.
  //   ChatGPT: POST /backend-api/conversation (or /f/conversation)
  //   Gemini:  the answer is a single large StreamGenerate XHR. Its many
  //            batchexecute RPCs are state/history/telemetry — several are also
  //            large, so matching those would fill the store with junk.
  const IS_GEMINI = /(^|\.)gemini\.google\.com$/.test(location.hostname);
  const CHATGPT_RE = /\/backend-api\/(?:f\/)?conversation(?:\?|$)/;
  const GEMINI_RE = /assistant\.lamda\.BardFrontendService\/StreamGenerate|\/StreamGenerate\b/i;
  const CONV_RE = {
    test: (url) => (IS_GEMINI ? GEMINI_RE.test(url || "") : CHATGPT_RE.test(url || "")),
  };

  const IS_TARGET =
    IS_GEMINI || /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname);

  // Per-load marker shared with our ISOLATED-world listener. Captured conversation
  // text must cross worlds via window.postMessage (MAIN world has no chrome.* APIs),
  // and every script on the page can observe that — including third-party analytics,
  // which do run on these hosts. We reduce exposure by:
  //   1. targeting location.origin rather than "*", so cross-origin frames can't read it;
  //   2. tagging messages with this marker, so a broad `message` listener that isn't
  //      specifically targeting us ignores them, and casual forgery is rejected.
  // This is defence in depth, not a guarantee: the marker is passed via a DOM
  // attribute (the only channel the two worlds share) which the page can also read.
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

  // Diagnostic channel — OFF unless the user enables it in Settings. The ISOLATED
  // world sets this attribute when the setting is on. Left always-on it posts a
  // message for every POST on the page (50-70 per Gemini prompt), which wakes the
  // service worker constantly for no user benefit.
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
    if (raw) emit({ ...meta, raw, capturedAt: Date.now() });
  }

  // --- fetch patch (ChatGPT streams the conversation via fetch) ---
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

    // Only the POST that submits a turn — never history GETs.
    const isConv = method === "POST" && CONV_RE.test(url || "");
    let reqBody = null;
    if (isConv) {
      try {
        if (init && typeof init.body === "string") reqBody = init.body;
        else if (input instanceof Request) reqBody = await input.clone().text();
      } catch (_) {
        reqBody = null;
      }
    }

    const resp = await origFetch.apply(this, args);
    if (method === "POST") {
      dbg("fetch", { url: (url || "").slice(0, 140), status: resp && resp.status, matched: isConv });
    }
    if (isConv && resp && resp.body) {
      try {
        // clone() leaves the original untouched for the page; we read the copy.
        drain(resp.clone().body, { url, reqBody, transport: "fetch" });
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
        this.addEventListener("load", () => {
          let raw = "";
          try {
            raw = this.responseText || "";
          } catch (_) {
            raw = "";
          }
          dbg("xhr-done", { url: this.__lcfc_url.slice(0, 100), len: raw.length, rt: this.responseType || "text" });
          if (raw) {
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
})();
