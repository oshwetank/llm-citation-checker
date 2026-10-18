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

  const isThirdParty = (url) => {
    try {
      const u = new URL(url, location.href);
      return !u.hostname.includes("perplexity.ai") &&
             !u.hostname.includes("chatgpt.com") &&
             !u.hostname.includes("openai.com") &&
             !u.hostname.includes("google.com") &&
             !u.hostname.includes("grok.com") &&
             !u.hostname.includes("x.com");
    } catch (_) {
      return false;
    }
  };

  // NOTE: this intentionally only matches the OUTBOUND subscribe frame's
  // PascalCase GraphQL operation name, not the INBOUND push's camelCase data
  // field ("sidebarRecentThreads") — investigated making this case-
  // insensitive so it would also reject inbound sidebarRecentThreads pushes,
  // but that push is NOT pure noise: it's the only source this adapter has
  // for a query's own answer on captures where no other network answer
  // stream ever arrives (see extractAnswer in adapters/perplexity.js, and
  // test/multi-engine.test.mjs's "GraphQL thread" case, both built from a
  // real user capture). Blocking it here would silently disable that
  // fallback. The real bug it was chosen to fix (an unrelated OTHER thread's
  // preview outranking the current query's own preview by raw length) is
  // fixed at the adapter level instead, where the current query's title is
  // actually known and can be matched against.
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

  // backend-anon is the same stream for someone not signed in (0.66.0).
  // unauth-mweb: signed out, the answer comes from conversation/updates as
  // ndjson (0.69.0; lib/chatgptSource.js reads it).
  const CHATGPT_RE = /\/backend-(?:api|anon)\/(?:f\/)?conversation(?:\?|$)|\/unauth-mweb\/conversation\/updates(?:\?|$)/i;
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
  // perplexity.ai URLs. The NOISE_RE filter just below still applies first.
  const PERPLEXITY_RE = /\/p\/api\/|\/api\/sse\/|\/rest\/(?:sse|threads|queries|answers|conversations)|perplexity_ask|\/api\/thread|\/socket\.io\//i;
  const GROK_RE = /\/api\/rpc|\/rest\/app-chat\/conversations|\/i\/api\/(?:graphql\/[^\/]+\/)?(?:Create)?Grok|\/2\/grok/i;

  // Endpoints that are never an answer, regardless of which engine matches
  // above — autocomplete/typeahead, navigation prediction, and auth pings.
  //
  // NAMED as a const (not inlined in CONV_RE.test, where it used to live)
  // because background.js's storeCapture() carries its OWN copy of this
  // exact pattern as a second safety net over the already-filtered stream —
  // this file's execution context (MAIN world, non-module IIFE, injected at
  // document_start) can't `import` a shared module the way two ordinary ES
  // modules could, so the two copies can't be unified into one file. What
  // CAN be enforced is that they stay identical: naming it here (rather than
  // leaving it anonymous inline) is what lets
  // test/interception-endpoints.test.mjs pull the literal source text of
  // both copies and assert byte-for-byte parity. If you change this line,
  // change background.js's copy to match, or that test fails on purpose.
  const NOISE_RE = /suggest\.perplexity\.ai|\/navigate\b|\/autocomplete\b|\/api\/auth|\/rest\/sse\/notifications\b/i;

  const CONV_RE = {
    test: (url) => {
      const u = url || "";
      if (isThirdParty(u)) return false;
      if (NOISE_RE.test(u)) return false;
      if (IS_GEMINI) return GEMINI_RE.test(u);
      if (IS_CHATGPT) return CHATGPT_RE.test(u);
      if (IS_PERPLEXITY) return PERPLEXITY_RE.test(u);
      if (IS_GROK) return GROK_RE.test(u);
      return false;
    },
  };

  const IS_TARGET = IS_GEMINI || IS_CHATGPT || IS_PERPLEXITY || IS_GROK;

  const CHANNEL = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  try {
    document.documentElement.setAttribute("data-lcfc-ch", CHANNEL);
  } catch (_) {
    /* ignore */
  }

  /* The engine's own "answer this prompt" request, as it leaves the page:
   * proof a prompt went out that doesn't depend on page markup. The content
   * script's other signals (the URL moving to a conversation, a stop button,
   * the prompt in the transcript) all read markup, and on Grok none of them
   * matched — the script kept re-entering a prompt that had already gone.
   * Stricter than CONV_RE, which also matches Perplexity's GraphQL sidebar
   * calls: only the request that starts an answer. Grok's gateway sends its
   * prompt over a WebSocket instead — see the WebSocket patch. */
  const SUBMIT_RE = IS_CHATGPT ? CHATGPT_RE
    : IS_GEMINI ? GEMINI_RE
    : IS_PERPLEXITY ? /\/rest\/sse\/perplexity_ask(?:\?|$)/i
    : IS_GROK ? /\/rest\/app-chat\/conversations\/(?:new|[^/?]+\/responses)(?:\?|$)/i
    : null;
  const signalSubmit = (via) => {
    try { window.postMessage({ __LCFC__: CHANNEL, type: "engine-submit", via }, location.origin); } catch (_) { /* ignore */ }
  };

  // What ChatGPT loads after an answer (0.62.0). A product card's stores are
  // not in the answer stream: ChatGPT fetches them when someone opens the
  // card. After this page has given us an answer, its own later requests to
  // /backend-api/ are looked at (never made by us), and a JSON reply that
  // reads like shopping data (merchants, offers, sellers, prices) is passed
  // on. Account, settings and model paths are never looked at.
  let answerSeen = false;
  const INTERACTION_DENY = /\/backend-api\/(?:me|accounts?|settings|user|models|conversations?(?:\/|\?|$)|conversation\/init|sentinel|memories|files|gizmos|subscriptions|payments|billing|auth|beacons|lat\/|aip\/)/i;
  const SHOPPING_KEYS = /"(?:merchants?|offers?|sellers?|retailers?|store_name|merchant_name|seller_name|price_display|buy_url|checkout_url)"\s*:/i;
  // What opening a product card loads (0.62.1, from the owner's recording):
  // its stores (search/product_update) and its "why" and reviews
  // (sidebar/conversation), both event streams whose request body says which
  // product and which answer; and the follow-up form's choices
  // (…/dil/view_state). Known by path, so they're kept whether or not this
  // page load saw the answer (a card opened on a reloaded conversation).
  const PANEL_PATHS = /^\/backend-api\/(?:search\/product_update|sidebar\/conversation|conversation\/[^/]+\/message\/[^/]+\/dil\/view_state|bazaar\/conversation\/[^/]+\/ads)(?:\?|$)/;
  async function requestText(input, init) {
    try {
      if (init && typeof init.body === "string") return init.body;
      if (input instanceof Request) return await input.clone().text();
    } catch (_) { /* unreadable: the reply still says what it can */ }
    return "";
  }
  function watchInteraction(url, method, resp, input, init) {
    if (!IS_CHATGPT || !resp) return;
    let path = "";
    try { const u = new URL(url, location.href); if (u.origin !== location.origin) return; path = u.pathname + u.search; } catch (_) { return; }
    if (!/^\/backend-api\//.test(path)) return;
    const panel = PANEL_PATHS.test(path);
    if (!panel && (!answerSeen || INTERACTION_DENY.test(path))) return;
    const type = (resp.headers && resp.headers.get("content-type")) || "";
    if (!/json|event-stream/i.test(type)) return;
    Promise.all([resp.clone().text(), panel ? requestText(input, init) : ""]).then(([body, reqBody]) => {
      if (!body || body.length > 2000000 || (!panel && !SHOPPING_KEYS.test(body))) return;
      window.postMessage({ __LCFC__: CHANNEL, type: "page-interaction", path: path.slice(0, 500), method, status: resp.status, body, reqBody: String(reqBody || "").slice(0, 200000), at: Date.now() }, location.origin);
    }).catch(() => {});
  }

  function emit(record) {
    answerSeen = true;
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

  // The network recorder (0.62.0, Debug capture only). When an engine moves
  // its answer to a path the patterns above don't match, the extension sees
  // nothing and can't say why. With Debug capture on, every request this page
  // makes is logged, already stripped here so nothing private leaves the page:
  // host, path with ids and prompt-like slugs masked, query key names (never
  // values), status, content type, size, time to response, whether it was
  // captured, and the key names in a response's first 2 KB. The same rules
  // are in src/lib/netlog.js (which masks again on the way in); this file
  // can't import it.
  const NET_VALUE_KEYS = /^(?:rpcids|rt|TYPE|VER|CI|source-path-kind)$/;
  const NET_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|\d{4,}|[A-Za-z0-9_-]{20,})$/i;
  const netMask = (pathname) => String(pathname || "/").split("/").map((seg) => {
    if (!seg) return seg;
    let s = seg;
    try { s = decodeURIComponent(seg); } catch (_) { /* keep raw */ }
    // A uuid first (its dashes would read as a slug), then slugs, then ids.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ":id";
    if (s.length > 40 || /\s/.test(s) || (s.match(/-/g) || []).length >= 3) return ":text";
    if (NET_ID.test(s) || (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 10)) return ":id";
    return s;
  }).join("/").slice(0, 200);
  const netShape = (text) => {
    const head = String(text || "").slice(0, 2048);
    if (!head.trim()) return null;
    const t = head.trimStart();
    const form = /^\)\]\}'/.test(t) ? "xssi" : /^(?:data|event|id):/m.test(t) ? "sse" : /^4\d/.test(t) ? "socket.io" : /^[[{]/.test(t) ? "json" : "text";
    const keys = [];
    const re = /"([A-Za-z_$][\w$-]{0,40})"\s*:/g;
    let m;
    while ((m = re.exec(head)) && keys.length < 40) if (!keys.includes(m[1])) keys.push(m[1]);
    return { form, keys };
  };
  function netlog(kind, method, url, extra) {
    if (!IS_TARGET || !debugOn()) return;
    try {
      const u = new URL(url, location.href);
      if (!/^(?:https?|wss?):$/.test(u.protocol)) return;
      const q = [];
      const qv = {};
      u.searchParams.forEach((v, k) => {
        if (!q.includes(k) && /^[\w.[\]-]{1,40}$/.test(k)) q.push(k);
        // A few keys name the call rather than carry anything of the user's
        // (Gemini's batchexecute rpcids, WebChannel's TYPE): their values
        // are kept, so the report can tell the calls apart.
        if (NET_VALUE_KEYS.test(k) && /^[\w.,:-]{1,60}$/.test(v)) qv[k] = v;
      });
      window.postMessage({ __LCFC__: CHANNEL, type: "netlog", entry: {
        t: Date.now(), page: location.hostname, kind, method: String(method || "GET").toUpperCase(),
        host: u.host, path: netMask(u.pathname), q: q.sort().slice(0, 20), qv, matched: CONV_RE.test(String(url)), ...extra,
      } }, location.origin);
    } catch (_) { /* never in the page's way */ }
  }
  // The first 2 KB of a response the capture didn't take, read from a clone
  // so the page's own copy is untouched, then the clone is dropped.
  async function headOf(resp) {
    try {
      const c = resp.clone();
      if (!c.body) return "";
      const reader = c.body.getReader();
      const dec = new TextDecoder();
      let out = "";
      while (out.length < 2048) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      return out;
    } catch (_) { return ""; }
  }
  function netlogFetch(url, method, resp, started, matched) {
    if (!IS_TARGET || !debugOn()) return;
    const type = (resp && resp.headers && resp.headers.get("content-type")) || "";
    const len = resp && resp.headers && Number(resp.headers.get("content-length"));
    const base = { matched: !!matched, status: resp ? resp.status : 0, type, size: isFinite(len) && len > 0 ? len : null, ms: Date.now() - started };
    if (!matched && resp && /json|event-stream|text\/plain|x-ndjson|octet-stream/i.test(type)) {
      headOf(resp).then((head) => netlog("fetch", method, url, { ...base, shape: netShape(head) }));
    } else {
      netlog("fetch", method, url, base);
    }
  }

  // Gemini's answer moved off StreamGenerate (0.62.1, from the owner's
  // network report: no StreamGenerate at all; a WebChannel stream on
  // geminiweb-pa.clients6.google.com/v1/processSession and many batchexecute
  // calls). Until its shape is known, with Debug capture on these replies
  // are kept as probes: stored apart from captures (never shown as answers),
  // for the owner to save and send ("Payloads it couldn't read").
  const GEMINI_PROBE_RE = /\/v1\/processSession\b|\/batchexecute\b/;
  let geminiUpload = ""; // the last WebChannel upload that carried a prompt
  function probe(url, method, reqBody, body) {
    if (!IS_GEMINI || !debugOn() || !body) return;
    try {
      window.postMessage({ __LCFC__: CHANNEL, type: "probe", url: String(url || "").slice(0, 2000), method: String(method || "GET"), reqBody: typeof reqBody === "string" ? reqBody.slice(0, 50000) : "", body: String(body).slice(0, 300000), at: Date.now() }, location.origin);
    } catch (_) { /* never in the page's way */ }
  }

  // Drain a cloned stream to text without disturbing the branch the page reads.
  // `quietMs`: also hand it over whenever it goes quiet that long, for a
  // stream that may stay open after its answer (ChatGPT's signed-out
  // conversation/updates, 0.69.0); the copies are folded into one answer.
  async function drain(stream, meta, { quietMs = 0 } = {}) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = "", sent = 0, timer = null;
    const hand = () => {
      timer = null;
      if (raw.length > sent && !isBackgroundSubscription(raw)) { sent = raw.length; emit({ ...meta, raw, capturedAt: Date.now() }); }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        if (quietMs) { if (timer) clearTimeout(timer); timer = setTimeout(hand, quietMs); }
      }
    } catch (_) {
      /* partial capture is still useful */
    }
    if (timer) clearTimeout(timer);
    raw += decoder.decode();
    if (raw && raw.length > sent && !isBackgroundSubscription(raw)) {
      emit({ ...meta, raw, capturedAt: Date.now() });
    }
  }

  // --- fetch patch (ChatGPT, Perplexity REST stream via fetch) ---
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

    if (method === "POST" && SUBMIT_RE && SUBMIT_RE.test(url || "")) signalSubmit("fetch");
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

    const started = Date.now();
    let resp;
    try {
      resp = await origFetch.apply(this, args);
    } catch (err) {
      netlog("fetch", method, url, { status: 0, ms: Date.now() - started, type: "failed" });
      throw err;
    }
    if (method === "POST") {
      dbg("fetch", { url: (url || "").slice(0, 140), status: resp && resp.status, matched: isConv });
    }
    netlogFetch(url, method, resp, started, isConv);
    if (IS_GEMINI && !isConv && resp && GEMINI_PROBE_RE.test(url || "") && debugOn()) {
      resp.clone().text().then((body) => { if (body && body.length >= 2000) probe(url, method, init && typeof init.body === "string" ? init.body : "", body); }).catch(() => {});
    }
    if (isConv && resp) {
      try {
        const cloned = resp.clone();
        if (cloned.body) {
          drain(cloned.body, { url, reqBody, transport: "fetch" }, { quietMs: /\/unauth-mweb\//.test(url || "") ? 3000 : 0 });
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
    } else {
      try { watchInteraction(url, method, resp, input, init); } catch (_) { /* never in the page's way */ }
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
      this.__lcfc_method = String(method || "GET");
      this.__lcfc_post = String(method || "").toUpperCase() === "POST";
      this.__lcfc_conv = this.__lcfc_post && CONV_RE.test(this.__lcfc_url);
      return open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (body) {
      // A Gemini WebChannel stream (processSession) never "loads" while the
      // conversation is open: its reply is read as it grows, and handed over
      // a piece at a time once it goes quiet for a moment.
      if (IS_GEMINI && !this.__lcfc_conv && GEMINI_PROBE_RE.test(this.__lcfc_url || "")) {
        const xhr = this, reqBody = typeof body === "string" ? body : "";
        let sent = 0, timer = null, upSent = false;
        // The reply as text whatever its responseType (an arraybuffer or JSON
        // reply has no responseText, and reading it throws).
        const replyText = () => {
          try {
            const t = xhr.responseType;
            if (!t || t === "text") return xhr.responseText || "";
            if (t === "arraybuffer" && xhr.response) return new TextDecoder().decode(xhr.response);
            if (t === "json" && xhr.response != null) return JSON.stringify(xhr.response);
          } catch (_) { /* not readable yet */ }
          return "";
        };
        const flush = (final) => {
          if (timer) { clearTimeout(timer); timer = null; }
          const text = replyText();
          // What went up (the prompt, as WebChannel's base64 protobuf) is
          // kept once even when its reply is a few bytes of acknowledgement.
          if (!upSent && /req\d+___data__=/.test(reqBody)) { upSent = true; probe(xhr.__lcfc_url, xhr.__lcfc_method, reqBody, text || "(no reply)"); sent = text.length; return; }
          if (text.length - sent < (final ? 1 : 200)) return;
          probe(xhr.__lcfc_url, xhr.__lcfc_method, reqBody, text.slice(sent));
          sent = text.length;
        };
        const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => flush(false), 1500); };
        if (debugOn()) {
          this.addEventListener("progress", later);
          this.addEventListener("readystatechange", () => { if (xhr.readyState === 3) later(); });
          this.addEventListener("loadend", () => flush(true));
        }
        // The answer itself (0.66.0). The prompt goes up in a POST; its
        // reply comes down the RID=rpc GET, every frame repeating the
        // answer so far. Frames run ~50 KB each, so only the newest data
        // frame and the largest are kept, never the whole stream, and they
        // are handed over once the stream has gone quiet.
        if (this.__lcfc_post && /req\d+___data__=/.test(reqBody) && reqBody.length > 100) geminiUpload = reqBody; // not an acknowledgement (~40 chars)
        if (!this.__lcfc_post && /[?&]RID=rpc\b/.test(this.__lcfc_url)) {
          let read = 0, lastData = "", bigData = "", fresh = false, quiet = null;
          const scan = () => {
            const s = replyText();
            while (read < s.length) {
              const m = /^\s*(\d+)\n/.exec(s.slice(read, read + 24));
              if (!m) break;
              const end = read + m[0].length + Number(m[1]);
              if (end > s.length) break; // the rest of this frame is still coming
              const frame = s.slice(read + m[0].length, end);
              read = end;
              if (frame.length < 200 || /^\[\[\d+,\["noop"\]\]\]$/.test(frame.trim())) continue;
              lastData = frame;
              if (frame.length >= bigData.length) bigData = frame;
              fresh = true;
            }
          };
          const hand = () => {
            if (quiet) { clearTimeout(quiet); quiet = null; }
            scan();
            if (!fresh) return;
            fresh = false;
            const frames = bigData && bigData !== lastData ? [bigData, lastData] : [lastData];
            const raw = frames.map((f) => `${f.length}\n${f}`).join("");
            lastData = ""; bigData = "";
            emit({ url: xhr.__lcfc_url, reqBody: geminiUpload || "", transport: "webchannel", raw, capturedAt: Date.now() });
          };
          const grew = () => { scan(); if (quiet) clearTimeout(quiet); quiet = setTimeout(hand, 2500); };
          this.addEventListener("progress", grew);
          this.addEventListener("readystatechange", () => { if (xhr.readyState === 3) grew(); });
          this.addEventListener("loadend", hand);
        }
      }
      // Listened for whatever the setting says now: a page's first requests
      // go out before content-iso.js has read it; netlog() checks it later.
      if (IS_TARGET) {
        const started = Date.now();
        this.addEventListener("loadend", () => {
          if (!debugOn()) return;
          let head = "";
          const type = this.getResponseHeader ? (this.getResponseHeader("content-type") || "") : "";
          try { if (!this.__lcfc_conv && (this.responseType === "" || this.responseType === "text")) head = (this.responseText || "").slice(0, 2048); } catch (_) { head = ""; }
          let size = null;
          try { size = this.responseType === "" || this.responseType === "text" ? (this.responseText || "").length : null; } catch (_) { size = null; }
          netlog("xhr", this.__lcfc_method, this.__lcfc_url, { matched: !!this.__lcfc_conv, status: this.status, type, size, ms: Date.now() - started, shape: head ? netShape(head) : null });
        });
      }
      if (this.__lcfc_post) dbg("xhr", { url: this.__lcfc_url.slice(0, 140), matched: !!this.__lcfc_conv });
      if (this.__lcfc_post && SUBMIT_RE && SUBMIT_RE.test(this.__lcfc_url)) signalSubmit("xhr");
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
      // NOISE_RE first: Perplexity's typeahead socket (suggest.perplexity.ai)
      // matched "perplexity.ai" and every keystroke's suggestions were stored
      // as a capture (0.62.0's network report: 44 raw captures, 5 answers).
      const isTargetWs = !NOISE_RE.test(wsUrl) && ((IS_PERPLEXITY && (/socket\.io|perplexity\.ai/i.test(wsUrl) || !isThirdParty(wsUrl))) ||
                         (IS_GROK && /rpc|grok/i.test(wsUrl)));
      if (IS_TARGET) {
        // One line when it opens; one when it closes (or after 50 frames),
        // with the frame count and the keys of the first sizeable frame.
        const opened = Date.now();
        let inFrames = 0, outFrames = 0, bytes = 0, shape = null, told = false;
        const tell = () => {
          if (told) return;
          told = true;
          netlog("ws", "WS", wsUrl, { status: 101, matched: isTargetWs, frames: inFrames + outFrames, size: bytes, ms: Date.now() - opened, shape });
        };
        netlog("ws-open", "WS", wsUrl, { matched: isTargetWs });
        ws.addEventListener("message", (ev) => {
          inFrames++;
          const d = typeof ev.data === "string" ? ev.data : "";
          bytes += d.length;
          if (!shape && d.length >= 40 && !isBackgroundSubscription(d)) shape = netShape(d);
          if (inFrames >= 50) tell();
        });
        const sendRef = ws.send;
        ws.send = function (data) { outFrames++; return sendRef.apply(this, arguments); };
        ws.addEventListener("close", tell);
      }

      if (isTargetWs) {
        let lastReqBody = null;
        let frames = [];
        let emitTimer = null;

        // grok.com's chat gateway (wss://grok.com/ws/mgw/ — see the Grok
        // adapter for the protocol) keeps ONE socket per conversation and
        // pings it; only frames about a response are an answer. Anything
        // else emitted would be a 0-signal capture dropped downstream.
        const worthEmitting = (raw) =>
          !isBackgroundSubscription(raw) && (!IS_GROK || !raw.includes('"event"') || raw.includes('"response.'));

        const flush = () => {
          if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
          if (!frames.length) return;
          const raw = frames.join("\n");
          if (worthEmitting(raw)) {
            emit({ url: wsUrl, reqBody: lastReqBody, transport: "websocket", raw, capturedAt: Date.now() });
          }
        };

        const scheduleEmit = () => {
          // Grok's gateway pauses between its searches and its answer; a
          // capture handed over in that pause had the prompt and the search
          // results but no answer, and a campaign counted the turn done on
          // it (0.62.2). On Grok the answer is handed over on response.done,
          // or when the socket closes; the timer is for Perplexity.
          if (IS_GROK) return;
          if (emitTimer) clearTimeout(emitTimer);
          emitTimer = setTimeout(flush, 1200);
        };

        const origSend = ws.send;
        ws.send = function (data) {
          try {
            if (typeof data === "string") {
              if (!isBackgroundSubscription(data)) {
                // A new turn: a Socket.IO/GraphQL query, or the Grok
                // gateway's conversation.item.create (which carries the
                // prompt — the adapter reads it from here).
                if ((IS_GROK && data.includes('"conversation.item.create"')) || (IS_PERPLEXITY && /^42\["perplexity_ask"/.test(data))) {
                  signalSubmit("ws");
                }
                if (/^4[0-9]/.test(data) || (data.startsWith("{") && (data.includes('"query"') || data.includes('"variables"') ||
                    (IS_GROK && data.includes('"conversation.item.create"'))))) {
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
              // The gateway says when an answer is complete. Hand it over on
              // that frame rather than on the debounce timer: in a background
              // campaign tab Chrome can hold page timers for up to a minute,
              // and an answer waiting on one can miss its turn's deadline.
              if (IS_GROK && d.includes('"response.done"')) {
                flush();
                frames = [];
              } else {
                scheduleEmit();
              }
            }
          } catch (_) {}
        });

        ws.addEventListener("close", flush);
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

  // --- EventSource (logged only; no engine sends its answer this way today,
  // and if one starts to, the network recorder is where it will show up) ---
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    function PatchedEventSource(url) {
      const es = Reflect.construct(OrigEventSource, arguments, PatchedEventSource);
      if (IS_TARGET) {
        const opened = Date.now();
        let n = 0, bytes = 0, shape = null, told = false;
        const tell = () => { if (told) return; told = true; netlog("sse", "GET", String(url || ""), { status: 200, type: "text/event-stream", frames: n, size: bytes, ms: Date.now() - opened, shape }); };
        es.addEventListener("message", (ev) => {
          n++;
          const d = typeof ev.data === "string" ? ev.data : "";
          bytes += d.length;
          if (!shape && d.length >= 20) shape = netShape(d);
          if (n >= 50) tell();
        });
        es.addEventListener("error", tell);
        const closeRef = es.close;
        es.close = function () { tell(); return closeRef.apply(this, arguments); };
      }
      return es;
    }
    PatchedEventSource.prototype = OrigEventSource.prototype;
    PatchedEventSource.CONNECTING = OrigEventSource.CONNECTING;
    PatchedEventSource.OPEN = OrigEventSource.OPEN;
    PatchedEventSource.CLOSED = OrigEventSource.CLOSED;
    Object.setPrototypeOf(PatchedEventSource, OrigEventSource);
    window.EventSource = PatchedEventSource;
  }
})();
