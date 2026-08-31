/*
 * content-iso.js — runs in the ISOLATED world (has chrome.* APIs).
 * Bridges raw captures from the MAIN-world interceptor to the service worker,
 * and performs Loader auto-submit (only for navigations the worker vouches for).
 */
(() => {
  // Shared marker published by the MAIN-world script for this page load. Read it
  // LAZILY: both content scripts run at document_start and their relative order
  // across worlds isn't guaranteed, so reading it eagerly can race and silently
  // kill all capture. By first-message time MAIN has definitely set it.
  //
  // Note on what this does and doesn't buy: the marker lives on the DOM, which the
  // page can also read, so it does not defeat a determined page script. It stops
  // accidental/broad `message` listeners (third-party analytics) from ingesting
  // conversations and raises the bar on forged captures. The real protections are
  // the origin-scoped postMessage and keeping this channel narrow.
  let CHANNEL = null;
  function channel() {
    if (CHANNEL) return CHANNEL;
    try {
      CHANNEL = document.documentElement.getAttribute("data-lcfc-ch");
      if (CHANNEL) document.documentElement.removeAttribute("data-lcfc-ch");
    } catch (_) {}
    return CHANNEL;
  }

  // Turn the MAIN-world diagnostic channel on only if the user enabled it.
  chrome.storage.local.get("lcfcSettings", (got) => {
    if (got && got.lcfcSettings && got.lcfcSettings.debugCapture) {
      try {
        document.documentElement.setAttribute("data-lcfc-dbg", "1");
      } catch (_) {}
    }
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data;
    const ch = channel();
    if (!data || !ch || data.__LCFC__ !== ch) return;

    if (data.type === "debug") {
      try {
        chrome.runtime.sendMessage(
          { type: "debug", event: { kind: data.kind, data: data.data, host: data.host, t: data.t } },
          () => void chrome.runtime.lastError
        );
      } catch (_) {}
      return;
    }

    if (data.type !== "raw-conversation") return;

    try {
      chrome.runtime.sendMessage(
        {
          type: "raw-conversation",
          payload: {
            url: data.url || "",
            reqBody: data.reqBody || null,
            transport: data.transport || "fetch",
            raw: data.raw || "",
            capturedAt: data.capturedAt || Date.now(),
            pageUrl: location.href,
          },
        },
        () => void chrome.runtime.lastError
      );
    } catch (_) {
      // Service worker asleep or context invalidated after an extension reload;
      // the tab reloads itself on update, so the next capture will land.
    }
  });

  /* ---------- Loader auto-submit ----------
   * The Loader navigates its own tab to ?q=…&lcfc=1&lcfctok=<token>. We only type
   * and submit if the service worker confirms an active run for THIS tab with
   * THIS token — otherwise any crafted link could silently make the user's
   * logged-in assistant run an attacker's prompt.
   */
  const SEL = {
    chatgpt: {
      composer: ["#prompt-textarea", 'div[contenteditable="true"]', "textarea"],
      send: ["#composer-submit-button", '[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
      streaming: ['[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
      searchPill: ['[data-system-hint-type="search"]', 'button[aria-label*="Search" i]'],
      searchActive: ['[data-inline-selection-pill-selected="true"]', '.bg-black.text-white[data-system-hint-type="search"]'],
      // Where a SENT prompt appears in the transcript. Used to confirm a turn
      // actually went out — on a short answer the streaming indicator can come
      // and go between poll ticks, so "is the prompt now in the conversation"
      // is the more durable signal. Several selectors because this markup
      // changes; querySelectorAll on an unsupported one just yields nothing.
      userTurn: '[data-message-author-role="user"], [data-testid^="conversation-turn"] [data-message-author-role="user"]',
      // Conversation content, EXCLUDED when scanning the page for upstream
      // limit notices — see limitHit(). Any node carrying an author role is
      // prompt or answer text; a cap notice never has one.
      turns: "[data-message-author-role]",
    },
    gemini: {
      composer: ['rich-textarea div[contenteditable="true"]', "rich-textarea", 'div[contenteditable="true"]', "textarea"],
      send: ['button[aria-label*="Send message" i]', 'button[aria-label*="Send" i]', ".send-button"],
      streaming: ['button[aria-label*="Stop" i]', 'button[mattooltip*="Stop" i]', ".stop-button"],
      userTurn: "user-query, .user-query-bubble-with-background, [data-test-id='user-query']",
      turns: "user-query, model-response, message-content",
    },
    perplexity: {
      composer: ['textarea[placeholder*="Ask" i]', 'textarea[placeholder*="anything" i]', "textarea", 'div[contenteditable="true"]'],
      send: ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]', 'button[type="submit"]', "button.bg-super"],
      streaming: ['button[aria-label*="Stop" i]', ".animate-pulse"],
      userTurn: '[data-testid="user-query"], .font-display, h1',
      turns: ".prose, [data-testid='thread-message']",
    },
    grok: {
      composer: ['textarea[placeholder*="Ask" i]', 'div[contenteditable="true"]', "textarea"],
      send: ['button[aria-label*="Send" i]', 'button[aria-label*="Grok" i]', 'button[type="submit"]'],
      streaming: ['button[aria-label*="Stop" i]'],
      userTurn: '.user-message, [data-message-author="user"]',
      turns: ".message-row, [data-message-author]",
    },
    claude: {
      composer: ['div[contenteditable="true"]', "div.ProseMirror", "textarea"],
      send: ['button[aria-label*="Send" i]', 'button[aria-label*="Send Message" i]'],
      streaming: ['button[aria-label*="Stop" i]'],
      userTurn: '[data-testid="user-message"], .font-user-message',
      turns: '[data-testid="chat-message"], .font-claude-message',
    },
  };

  const pick = (list) => {
    if (!list) return null;
    for (const s of list) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const getPlatform = () => {
    const h = location.hostname;
    if (h.includes("gemini")) return "gemini";
    if (h.includes("perplexity")) return "perplexity";
    if (h.includes("grok") || h.includes("x.com")) return "grok";
    if (h.includes("claude")) return "claude";
    return "chatgpt";
  };

  (function loaderAutoSubmit() {
    const params = new URLSearchParams(location.search);
    if (params.get("lcfc") !== "1") return;
    const q = params.get("q") || "";
    const token = params.get("lcfctok") || "";
    const wantSearch = params.get("lcfcsearch") === "1";
    if (!q || !token) return;

    /* Strip OUR markers immediately — a crafted ?lcfc=1&lcfctok=… link must
     * not be replayable — but deliberately KEEP ?q= for now.
     *
     * This used to strip the whole query string at document_start, which was
     * the single biggest cause of ChatGPT turns failing: chatgpt.com reads
     * ?q= itself on boot and auto-submits it natively (their own deeplink
     * path). This script runs at document_start, i.e. BEFORE their app JS,
     * so wiping the query removed the prompt before ChatGPT ever saw it —
     * every turn then depended entirely on the DOM-typing fallback below,
     * which races a React composer and breaks whenever their markup shifts.
     * That is why runs failed at six prompts, not just at forty.
     *
     * Native submit is the reliable path when it fires, so it gets first
     * chance; ?q= is removed once it has clearly been consumed (or after a
     * short grace period) so a manual reload can't re-fire the prompt.
     * Whether it fires at all is not assumed: OpenAI gated auto-submit on
     * the sec-fetch-site header after a 2025 prompt-injection disclosure, and
     * Gemini has no native prefill at all (extensions do it), so the typing
     * path below remains fully supported and is the only path on Gemini.
     */
    const keepQ = new URLSearchParams(location.search);
    ["lcfc", "lcfctok", "lcfcsearch"].forEach((k) => keepQ.delete(k));
    const qOnlyUrl = location.pathname + (keepQ.toString() ? `?${keepQ}` : "");
    const bareUrl = location.pathname;
    try { history.replaceState(null, "", qOnlyUrl); } catch (_) {}

    // Per-tab, per-token guard. The re-fire protection used to come from
    // stripping the URL; now that ?q= lingers briefly, this is what stops a
    // double-run if this script somehow evaluates twice for one navigation.
    try {
      const fired = sessionStorage.getItem("lcfcFired");
      if (fired === token) return;
      sessionStorage.setItem("lcfcFired", token);
    } catch (_) { /* sessionStorage unavailable — proceed, the token check still gates us */ }

    chrome.runtime.sendMessage({ type: "loader-verify", token }, (res) => {
      if (chrome.runtime.lastError) return;
      if (!res || !res.ok) return; // not a genuine Loader navigation — do nothing
      begin();
    });

    function begin() {
      const plat = getPlatform();
      const sel = SEL[plat];

      // Reading "is this control usable" correctly matters more than it looks.
      // ChatGPT's send button is frequently present but inert, marked with
      // aria-disabled rather than the disabled property — so a plain
      // `!send.disabled` check reads it as clickable, clicks nothing, and the
      // old code then cleared its timer as if the prompt had been sent. The
      // turn only failed 90s later when the background watchdog gave up.
      const isUsable = (node) => {
        if (!node) return false;
        if (node.disabled) return false;
        if (node.getAttribute && node.getAttribute("aria-disabled") === "true") return false;
        if (node.closest && node.closest("[aria-disabled='true']")) return false;
        return true;
      };

      const composerText = (box) => {
        if (!box) return "";
        return /^(textarea|input)$/i.test(box.tagName) ? String(box.value || "") : String(box.innerText || "");
      };

      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const want = norm(q);

      // Did the turn actually go out? Either the page is streaming a reply,
      // or the user's prompt is now rendered in the conversation. Checking
      // both matters because streaming can finish faster than a poll tick on
      // a short answer, which would otherwise read as "never submitted".
      /* A compact, privacy-safe timeline of what this turn actually did.
       *
       * Reported: ChatGPT failed all six prompts with a bare "timeout", which
       * says only that no capture arrived — not whether the composer was
       * found, whether the text landed, whether the send control was usable,
       * or whether the prompt ever reached the conversation. Six identical
       * opaque failures gave nothing to act on, and reasoning about the cause
       * without data had already produced two fixes that did not hold.
       *
       * Entries are "<tick>:<event>" or "<tick>:<event>:<detail>", where the
       * detail is always a number or a fixed keyword. Prompt text, answer
       * text and URLs are never recorded — the whole log is meant to be
       * copied and shared, so it has to stay free of user content by
       * construction rather than by care.
       */
      const trace = [];
      const T = (ev, detail) => {
        if (trace.length >= 60) return;               // bounded; a stuck loop can't grow it
        trace.push(detail === undefined ? `${ticks}:${ev}` : `${ticks}:${ev}:${detail}`);
      };

      /* The path this tab started on, for the submit detector below. */
      const startPath = location.pathname;

      /* Which signal proves the prompt actually went out — or null.
       *
       * The URL check is first because it is the one signal that does not
       * depend on markup. Both engines move the tab to a per-conversation
       * path the moment a turn is really sent (chatgpt.com/ -> /c/<id>,
       * gemini.google.com/app -> /app/<id>), and that behaviour is part of
       * how the products work rather than an implementation detail of their
       * DOM. The two selector-based signals below are kept as corroboration,
       * but they are exactly the kind of thing that goes stale silently —
       * which is how a turn could look "sent" while nothing had happened.
       *
       * The length guard matters: a redirect to a SHORTER path (a sign-out
       * bouncing the tab to a login page) must not read as success.
       */
      const submittedWhy = () => {
        const path = location.pathname;
        if (path !== startPath && path.length > startPath.length) return "url";
        if (pick(sel.streaming)) return "stream";
        try {
          const turns = document.querySelectorAll(sel.userTurn || "[data-message-author-role='user']");
          for (const t of turns) if (norm(t.innerText).includes(want.slice(0, 40))) return "turn";
        } catch (_) { /* selector unsupported — fall through */ }
        return null;
      };
      const submitted = () => submittedWhy() !== null;

      /* Signed out is a distinct, common, and completely silent failure: the
       * tab lands on a login page, no composer ever appears, and the turn
       * dies as a generic timeout 90 seconds later. Worth naming outright. */
      const signedOut = () => /\/auth\/|\/login|accounts\.google\.com/i.test(location.pathname + location.host);

      const dropQ = () => { try { history.replaceState(null, "", bareUrl); } catch (_) {} };

      // ChatGPT also pre-fills the composer from ?q= without submitting.
      // Typing on top of that produced the prompt twice in one turn, so the
      // composer is always cleared before this script inserts anything.
      const clearComposer = (box) => {
        try {
          box.focus();
          if (/^(textarea|input)$/i.test(box.tagName)) { box.value = ""; return; }
          const r = document.createRange();
          r.selectNodeContents(box);
          const s2 = window.getSelection();
          s2.removeAllRanges();
          s2.addRange(r);
          document.execCommand("delete", false, null);
        } catch (_) { /* best effort */ }
      };

      const insertText = (box, text) => {
        box.focus();
        let ok = false;
        try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
        if (!ok) {
          // ProseMirror (ChatGPT's composer) ignores a raw textContent write,
          // so try a real paste event before falling back to it.
          try {
            const dt = new DataTransfer();
            dt.setData("text/plain", text);
            ok = !box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
          } catch (_) { /* ignore */ }
        }
        if (!ok) {
          if (/^(textarea|input)$/i.test(box.tagName)) box.value = text;
          else box.textContent = text;
        }
        box.dispatchEvent(new InputEvent("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const pressEnter = (box) => {
        const base = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
        box.dispatchEvent(new KeyboardEvent("keydown", base));
        box.dispatchEvent(new KeyboardEvent("keypress", base));
        box.dispatchEvent(new KeyboardEvent("keyup", base));
      };

      // Tell the run to move on instead of silently dying and leaving the
      // background watchdog to burn its full 90s per prompt — with ten
      // prompts that was fifteen minutes of a run looking "stuck".
      const giveUp = (reason) => {
        dropQ();
        T("giveup");
        try {
          // The trace is the point of this message now: a reason alone says
          // WHAT failed, the trace says WHERE in the sequence it stopped.
          chrome.runtime.sendMessage(
            { type: "loader-submit-failed", token, reason, trace: trace.join(" ") },
            () => void chrome.runtime.lastError
          );
        } catch (_) { /* worker may be gone; the watchdog still covers us */ }
      };

      /* Upstream limits and hard errors.
       *
       * Previously a rate-limited turn just sat there until the background
       * watchdog gave up 90s later and marked it FAILED — so hitting a limit
       * burned through the rest of the queue at 90s each, converting a
       * temporary block into permanent data loss across hundreds of prompts.
       * Detecting it lets the run PAUSE and be resumed once the window
       * clears, losing nothing.
       *
       * Matched on visible page text rather than network status codes: the
       * capture path sees responses, but this script only has the DOM, and
       * the wording below is what both engines actually render. Deliberately
       * narrow — a false positive pauses a healthy run, so generic words like
       * "error" alone are not enough.
       *
       * CRITICALLY, the scan excludes the conversation itself (sel.turns).
       * Scanning document.body.innerText would read the model's own answer,
       * so a perfectly healthy campaign asking "how do OpenAI rate limits
       * work" would pause itself on its own output — the exact failure this
       * feature exists to prevent, inverted. Only chrome around the
       * transcript (banners, toasts, the composer area) is eligible.
       */
      const LIMIT_PATTERNS = [
        /you'?ve (?:reached|hit) (?:your|the) .{0,40}limit/i,
        /you'?ve (?:reached|hit) the .{0,30}(?:usage )?cap/i,
        /(?:usage|message|request) (?:cap|limit|quota) (?:reached|exceeded)/i,
        /exceeded your .{0,30}quota/i,
        /rate.?limit(?:ed|s)?\b/i,
        /too many requests/i,
        /please (?:wait|try again) (?:a|in) .{0,20}(?:moment|minute|hour)/i,
      ];

      /* Visible text OUTSIDE the transcript, capped for cost.
       *
       * A TreeWalker rather than cloning the DOM: this runs on a poll tick,
       * and it must not allocate a copy of a long conversation. Nodes inside
       * a turn container are skipped wholesale (FILTER_REJECT prunes the
       * subtree), as are <script>/<style>, whose textContent is never visible
       * but would otherwise match happily.
       */
      const chromeText = (cap = 4000) => {
        if (!document.body) return "";
        let out = "";
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              if (node.nodeType === 1) {
                const tag = node.tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
                if (sel.turns && node.matches && node.matches(sel.turns)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_SKIP;
              }
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          let n;
          while ((n = walker.nextNode())) {
            const t = n.nodeValue;
            if (!t || !t.trim()) continue;
            out += t + " ";
            if (out.length >= cap) break;
          }
        } catch (_) {
          // TreeWalker or the selector failed. Returning "" (rather than
          // falling back to body.innerText) keeps the false-positive
          // guarantee: better to miss a limit banner, which the watchdog
          // still catches, than to pause a healthy run on answer text.
          return "";
        }
        return out.slice(0, cap);
      };

      const limitHit = () => {
        const text = chromeText();
        if (!text) return null;
        for (const re of LIMIT_PATTERNS) {
          const m = text.match(re);
          if (m) return m[0].replace(/\s+/g, " ").slice(0, 120);
        }
        return null;
      };

      const TICK_MS = 400;
      /* Grace period for the page's OWN auto-submit before this script starts
       * typing. Two things about it were costing hours on a long run.
       *
       * It was a flat ~7s counted from document_start, on BOTH engines. Gemini
       * has no native ?q= handling whatsoever — that is why third-party
       * "Gemini URL prompt" extensions exist at all — so on Gemini the wait
       * could never do anything but elapse in full. At ~7s a prompt that is
       * 2 hours of pure dead waiting across a 1000-prompt leg.
       *
       * Counting from document_start was also the wrong origin even on
       * ChatGPT: it spent the budget on SPA boot rather than on watching for
       * the native submit. A fast boot burned ~6s of needless wait, while a
       * slow one left barely a second of actual observation — the worst of
       * both. The clock now starts when the composer first appears, i.e. when
       * the app is up and native submit becomes possible, so the budget is
       * spent watching rather than waiting.
       *
       * Gemini still gets a couple of ticks: a freshly mounted composer may
       * not be hydrated yet, and typing into it would be dropped. That is
       * already survivable — the "did the text actually land" check below
       * re-inserts — but a short settle avoids the thrash.
       */
      const GRACE_AFTER_COMPOSER = plat === "gemini" ? 2 : 8;  // ~0.8s / ~3.2s
      const MAX_WAIT_TICKS = 75;       // ~30s for the composer to appear
      const MAX_SEND_TICKS = 20;       // ~8s of submit attempts once text is in
      // After the prompt goes out, keep watching for a limit notice — on
      // ChatGPT the model cap typically appears INSTEAD of the answer, i.e.
      // strictly after submission. Stopping at submit (what the code did)
      // meant the most common rate-limit shape was never detected and the
      // turn died 90s later as a generic FAILED. Bounded, and every navigation
      // to the next prompt tears the interval down anyway.
      const POST_SUBMIT_WATCH_TICKS = 150;  // ~60s
      const POST_SUBMIT_EVERY = 5;          // scan every ~2s, not every tick
      let ticks = 0;
      let sendTicks = 0;
      let searchDone = false;
      let injected = false;
      let submitTried = 0;
      let sentOk = false;
      let watchTicks = 0;
      let composerSeenTick = 0;   // tick the composer first existed; 0 = not yet
      let clearedTick = 0;        // tick the composer emptied after a send attempt
      // How long to wait for POSITIVE proof after the composer empties. A send
      // that worked shows the conversation URL, a stop button, or the prompt in
      // the transcript well inside this; one that silently did nothing shows
      // none of them, and is reported rather than left to the 90s watchdog.
      const CONFIRM_TICKS = 25;   // ~10s

      const dismissLimitModals = () => {
        try {
          const modals = document.querySelectorAll('[role="dialog"], [data-testid="error-modal"], .modal, [data-testid="modal-container"]');
          for (const m of modals) {
            const btns = m.querySelectorAll("button");
            for (const b of btns) {
              const txt = (b.innerText || b.textContent || "").toLowerCase().trim();
              if (/^(ok|dismiss|got it|close|stay on free|continue|understand)$/i.test(txt) || b.getAttribute("aria-label") === "Close") {
                b.click();
                break;
              }
            }
          }
        } catch (_) { /* ignore */ }
      };

      const reportLimit = (detail) => {
        clearInterval(timer);
        dismissLimitModals();
        dropQ();
        try {
          chrome.runtime.sendMessage({ type: "loader-rate-limited", token, detail },
            () => void chrome.runtime.lastError);
        } catch (_) { /* worker gone; the watchdog still covers us */ }
      };

      const timer = setInterval(() => {
        ticks++;

        // Prompt already sent: nothing left to do but watch for a cap notice
        // landing in place of the answer.
        if (sentOk) {
          watchTicks++;
          if (watchTicks > POST_SUBMIT_WATCH_TICKS) { clearInterval(timer); return; }
          if (watchTicks % POST_SUBMIT_EVERY !== 0) return;
          const late = limitHit();
          if (late) reportLimit(late);
          return;
        }

        if (ticks === 1) T("run", plat);

        // An upstream limit outranks everything else: stop, and tell the run
        // to pause rather than letting this turn time out as a failure.
        const limit = limitHit();
        if (limit) { T("limit"); reportLimit(limit); return; }

        // A tab bounced to a login page never grows a composer, so it would
        // otherwise sit out the full timeout and report "composer never
        // appeared" — true, but it hides the actual cause.
        if (signedOut()) {
          clearInterval(timer);
          giveUp("not signed in to this engine — the tab was redirected to a login page");
          return;
        }

        // Positive proof the turn went out — native auto-submit landed, or our
        // own send did. Nothing left for this script but the limit watch.
        const why = submittedWhy();
        if (why) { T("sent", why); sentOk = true; dropQ(); return; }

        if (ticks > MAX_WAIT_TICKS) {
          clearInterval(timer);
          giveUp(injected ? "prompt typed but never submitted" : "composer never appeared");
          return;
        }

        if (plat === "chatgpt" && wantSearch && !searchDone && !pick(sel.searchActive)) {
          const pill = pick(sel.searchPill);
          if (pill) { pill.click(); searchDone = true; return; }
        }

        const box = pick(sel.composer);
        if (!box) return;
        if (!composerSeenTick) { composerSeenTick = ticks; T("composer"); }

        // Hold off typing while the page still might submit ?q= itself.
        // Exception: if it has already pre-filled the composer with the right
        // text, it clearly consumed ?q= and chose not to submit — no reason
        // to keep waiting, so fall straight through to sending.
        const prefilled = norm(composerText(box)) === want;
        if (ticks - composerSeenTick < GRACE_AFTER_COMPOSER && !prefilled) return;

        if (!injected) {
          if (prefilled) T("prefilled");
          else { clearComposer(box); insertText(box, q); T("typed"); }
          injected = true;
          dropQ(); // whichever path filled it, ?q= has served its purpose
          return;  // give the framework a tick to enable its send control
        }

        // Confirm the text actually landed. A contenteditable can accept focus
        // and still hold nothing if the editor rejected the write, and
        // submitting an empty composer is what produced "ran but nothing
        // happened" turns. Re-insert rather than pressing on — but only while
        // no submit has been attempted: after one, an empty composer means the
        // send WORKED, and re-filling it would submit the prompt twice.
        const text = norm(composerText(box));
        if (submitTried === 0) {
          if (!text) { T("text-empty"); injected = false; return; }
          if (text !== want && text.length < Math.min(12, want.length)) { T("text-short", text.length); injected = false; return; }
        } else if (!text) {
          /* The composer emptied after we pressed send. That is NOT proof the
           * prompt went anywhere, and treating it as proof is what made every
           * ChatGPT turn fail as a silent 90s "timeout" with no submit failure
           * ever reported: React clearing or re-rendering its own composer
           * looks byte-for-byte identical to a successful send, so the script
           * declared victory and went quiet for the rest of the turn.
           *
           * Proof has to be positive — the conversation URL, a stop button, or
           * the prompt in the transcript, all checked at the top of this loop.
           * So: note when it cleared, keep polling, and if none of those ever
           * appear, say exactly that instead of leaving the watchdog to report
           * a generic timeout a minute and a half later.
           */
          if (!clearedTick) { clearedTick = ticks; T("cleared"); }
          if (ticks - clearedTick > CONFIRM_TICKS) {
            clearInterval(timer);
            giveUp("send emptied the composer but the prompt never reached the conversation");
          }
          return;
        }

        // Submit. Button first, then Enter — ChatGPT accepts Enter in its
        // composer just as Gemini does, and only Gemini had that fallback
        // before, which is the asymmetry that made ChatGPT runs fail outright
        // whenever its send button stayed inert.
        sendTicks++;
        const send = pick(sel.send);
        // Traced separately: "the send button is missing" and "the send button
        // is present but inert" are different bugs with different fixes, and a
        // generic failure conflates them.
        if (sendTicks === 1) T(send ? (isUsable(send) ? "send-ready" : "send-inert") : "send-missing");
        if (isUsable(send) && submitTried === 0) {
          (send.closest ? send.closest("button") || send : send).click();
          submitTried = 1;
          T("click");
          return; // verify on the next tick instead of assuming it worked
        }
        if (submitTried <= 1) {
          pressEnter(box);
          submitTried = 2;
          T("enter");
          return;
        }

        if (sendTicks > MAX_SEND_TICKS) {
          clearInterval(timer);
          giveUp("send control never accepted the prompt");
          return;
        }
        if (sendTicks % 2 === 0) {
          const s3 = pick(sel.send);
          if (isUsable(s3)) { (s3.closest ? s3.closest("button") || s3 : s3).click(); T("reclick"); }
        } else {
          pressEnter(box);
          T("reenter");
        }
      }, TICK_MS);
    }
  })();

  /* ---------- Live DOM Harvester (Fall-safe capture layer for Perplexity / Claude / Grok) ---------- */
  /*
   * domToMarkdown — serialize an answer element to MARKDOWN, not flat text.
   *
   * This is load-bearing for brand detection, not a formatting nicety.
   * lib/brands.js derives its candidates almost entirely from STRUCTURE:
   * bold list headers, markdown headings, and the first column of markdown
   * tables (see its file header — that design is what makes detection work
   * across any industry without a hardcoded vocabulary). ChatGPT's payload
   * arrives as markdown natively, so that worked from day one there.
   *
   * Perplexity has no usable answer stream, so its capture comes from the
   * DOM harvester below — which called `innerText` and threw every one of
   * those signals away. Measured on the same content: markdown in yields
   * "boAt, Sony, Noise"; the innerText-flattened version of the SAME answer
   * yields nothing at all. That is the real reason Perplexity captures show
   * empty or junk Brand Mentions, and it's a textbook case of ChatGPT-shaped
   * assumptions leaking into an engine that works differently.
   *
   * The structure is right there in the DOM (<strong>, <h2>, <table>), so
   * this rebuilds the markdown the detector already knows how to read,
   * rather than adding a second, prose-based detection path that would need
   * its own heuristics and its own false positives.
   */
  const domToMarkdown = (root) => {
    if (!root) return "";
    const MAX_DEPTH = 40;

    const inline = (node, d = 0) => {
      if (!node || d > MAX_DEPTH) return "";
      let out = "";
      const kids = node.childNodes || [];
      for (const c of kids) {
        if (c.nodeType === 3) { out += c.nodeValue || ""; continue; }
        if (c.nodeType !== 1) continue;
        const tag = (c.tagName || "").toLowerCase();
        // An inline citation. Perplexity puts the exact source URL on the
        // span (data-pplx-citation-url), so instead of letting the visible
        // badge label fall into the prose — which is how answers ended up
        // reading "...around 2,999.boat-lifestyle" — emit a positional
        // marker carrying the URL. The exporter turns that into a numbered
        // footnote at exactly the point the answer cited it, which is what
        // makes a real replica of the answer possible. Not descended into:
        // the badge text is chrome, not part of the sentence.
        const citeUrl = c.getAttribute && c.getAttribute("data-pplx-citation-url");
        if (citeUrl) { out += `[[cite:${citeUrl}]]`; continue; }
        if (tag === "strong" || tag === "b") {
          const t = inline(c, d + 1).trim();
          out += t ? `**${t}**` : "";
        } else if (tag === "em" || tag === "i") {
          const t = inline(c, d + 1).trim();
          out += t ? `*${t}*` : "";
        } else if (tag === "br") {
          out += "\n";
        } else {
          out += inline(c, d + 1);
        }
      }
      return out;
    };

    const cellText = (td) => inline(td).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

    const tableToMd = (table) => {
      const rows = Array.from(table.querySelectorAll ? table.querySelectorAll("tr") : []);
      if (!rows.length) return "";
      const rowCells = (tr) => Array.from(tr.children || []).map(cellText);
      const head = rowCells(rows[0]);
      if (!head.length) return "";
      // The separator row is what makes parseMarkdownTables() recognise this
      // as a real table rather than two lines that happen to contain pipes.
      const out = [
        `| ${head.join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
      ];
      for (let i = 1; i < rows.length; i++) {
        const cells = rowCells(rows[i]);
        if (cells.length) out.push(`| ${cells.join(" | ")} |`);
      }
      return out.join("\n");
    };

    const block = (node, d = 0) => {
      if (!node || d > MAX_DEPTH) return "";
      let out = "";
      const kids = node.childNodes || [];
      for (const c of kids) {
        if (c.nodeType === 3) {
          const t = (c.nodeValue || "").trim();
          if (t) out += t + "\n";
          continue;
        }
        if (c.nodeType !== 1) continue;
        const tag = (c.tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          out += `\n${"#".repeat(Number(tag[1]))} ${inline(c).trim()}\n\n`;
        } else if (tag === "p") {
          const t = inline(c).trim();
          if (t) out += t + "\n\n";
        } else if (tag === "li") {
          const t = inline(c).trim();
          if (t) out += `- ${t}\n`;
        } else if (tag === "table") {
          const t = tableToMd(c);
          if (t) out += `\n${t}\n\n`;
        } else if (tag === "script" || tag === "style") {
          continue;
        } else {
          out += block(c, d + 1);
        }
      }
      return out;
    };

    const flat = () => String((root && (root.innerText || root.textContent)) || "").trim();
    try {
      const md = block(root).replace(/\n{3,}/g, "\n\n").trim();
      // An EMPTY serialization must never cost us the capture. The walk can
      // legitimately come back with nothing on markup this doesn't model
      // (an unexpected wrapper, content behind a shadow root, a node handed
      // to us without childNodes), and returning "" there would be strictly
      // worse than the innerText behaviour this replaced — it would turn a
      // partially-understood answer into no answer at all. Structure is an
      // upgrade when we can get it, never a precondition for capturing.
      return md || flat();
    } catch (_) {
      return flat();
    }
  };

  /*
   * Perplexity fan-out (sub-query) harvesting.
   *
   * Fan-out is the set of searches an engine actually ran to answer one
   * prompt, and it is core GEO data: it's where you see that "best gaming
   * phone under 50000" became four separate searches, and which of them
   * surfaced which source. Perplexity exposes this in its answer UI as a
   * steps disclosure ("Finished 1 step" / "Searched the web"), but it has
   * ALWAYS reported 0 here, because the DOM harvester never looked for it
   * and the network payload that would carry query_plan never arrives (of
   * the 20 fields adapters/perplexity.js can read, only 3 ever do).
   *
   * The plumbing below needs no adapter change: extractFanout() already
   * accepts `query_plan`, `sub_queries`, `related_queries` and `queries`,
   * and extractSources() already attaches `queryPlanQuery` to each source
   * inside a query_plan entry. Those are dead paths purely because nothing
   * ever supplied the field. Emitting `query_plan` here lights all of it up.
   */
  // No  after the verb: the REAL button text is "Finished2 steps" — no space
  // between label and count (confirmed against live markup) — and  can never
  // match between "d" and "2", since both are word characters. The first
  // version of this regex was therefore a silent no-op against the real page.
  // TWO regexes, because these answer different questions.
  //
  // PPLX_STEP_LABEL_RE identifies the OUTER "Finished N steps" disclosure —
  // the one whose region contains the whole steps panel. Kept narrow so
  // harvestPerplexitySteps anchors on the right element.
  //
  // No word-boundary after the verb: the real button reads "Finished2 steps"
  // with NO space between label and count (confirmed against live markup),
  // and a boundary can never match between "d" and "2" since both are word
  // characters. The first version of this regex used one and was a silent
  // no-op on every real page.
  const PPLX_STEP_LABEL_RE = /^(finished|searched)|[0-9]+\s*steps?|^steps?$/;

  // PPLX_EXPAND_LABEL_RE is broader and decides only what to CLICK. Each
  // individual step is its own nested disclosure ("Searching the web",
  // "Checking headphone reviews"), and a step left collapsed has no results
  // in the DOM to read. Every candidate carries aria-expanded, so it is a
  // disclosure widget by definition and clicking it cannot navigate away.
  const PPLX_EXPAND_LABEL_RE = /^(finished|search|read|brows|think|check|analy|compar|review|look|find)/;

  /*
   * Step harvesting, written against a REAL expanded-steps capture
   * (test/fixtures/perplexity-steps-expanded.html) rather than guessed
   * selectors. The previous version of this used three invented selectors
   * and found nothing on a live page.
   *
   * What the real panel contains, per step:
   *   - a nested disclosure button carrying the step NAME
   *     ("Searching the web", "Checking headphone reviews")
   *   - one or more sub-query rows (the magnifier lines) — the actual query
   *     or URL that step ran
   *   - the step's RESULTS: <a rel="noopener" target="_blank" href="...">
   *     with a title in .text-secondary and a domain label in .text-tertiary
   *
   * Structure is walked in document order rather than matched by class,
   * because the only stable landmarks here are semantic ones (a disclosure
   * button, an anchor). Perplexity's class names are Tailwind soup that has
   * already churned under this project more than once.
   *
   * Results are worth as much as the queries: on the captured answer, step 1
   * alone lists ~10 retrieved sources ("+7 more") against just 3 inline
   * citations. Retrieved-vs-cited is exactly the distinction this tool
   * exists to measure.
   */
  // `answerText` (optional) is the ANSWER cross-check: reported live, a
  // markdown table's own header row and a table cell reached the fan-out
  // list ("PhoneWhy it's great for photosTrade-offsTypical price...",
  // "OnePlus 12 (16GB+512GB)", "~69,998") the same run the clock-prompt bug
  // came from — content that lives in the rendered ANSWER, not anything the
  // engine searched FOR. A real sub-query is essentially never an exact
  // verbatim substring of the answer's own prose; answer content routinely
  // is. Optional and defaulted so the existing tests that call this with
  // just `doc` (no answer to cross-check against) keep working unchanged.
  const harvestPerplexitySteps = (doc, answerText = "") => {
    const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const normAnswer = norm(answerText).toLowerCase();
    const steps = [];
    try {
      const buttons = Array.from(doc.querySelectorAll("button[aria-expanded]") || []);
      const outer = buttons.find((b) => PPLX_STEP_LABEL_RE.test(norm(b.textContent).toLowerCase().replace(/\s+/g, "")));
      if (!outer) return steps;

      // Climb to the smallest ancestor that actually holds result links —
      // that is the steps region. Bounded so a detached node can't loop.
      let region = outer;
      for (let i = 0; i < 8 && region && region.parentNode; i++) {
        region = region.parentNode;
        let hits = [];
        try { hits = region.querySelectorAll('a[target="_blank"]') || []; } catch (_) { hits = []; }
        if (hits.length) break;
      }
      if (!region || !region.querySelectorAll) return steps;

      // Flatten to an ordered sequence of the three things that matter.
      // Descent stops at each of them so nothing is counted twice.
      const seq = [];
      const walk = (n, d) => {
        if (!n || d > 40) return;
        for (const c of n.childNodes || []) {
          if (!c || c.nodeType !== 1) continue;
          const tag = String(c.tagName || "").toLowerCase();
          if (tag === "button") {
            if (c !== outer && c.getAttribute && c.getAttribute("aria-expanded") !== null) {
              seq.push({ t: "step", text: norm(c.textContent) });
            }
            continue;
          }
          if (tag === "a") {
            const href = c.getAttribute && c.getAttribute("href");
            if (href && /^https?:\/\//i.test(href)) {
              const grab = (sel) => {
                let el = null;
                try { el = c.querySelector(sel); } catch (_) {}
                return el ? norm(el.textContent) : "";
              };
              seq.push({
                t: "result",
                url: href,
                title: grab('[class*="text-secondary"]'),
                label: grab('[class*="text-tertiary"]'),
                trusted: (() => {
                  try { return !!c.querySelector('[data-testid="trusted-citation-check"]'); } catch (_) { return false; }
                })(),
              });
            }
            continue;
          }
          // A leaf-ish text row with no link or button inside it: candidate
          // sub-query line. Not descended into, so one row yields one entry.
          let inner = 0;
          try { inner = (c.querySelectorAll("a") || []).length + (c.querySelectorAll("button") || []).length; } catch (_) { inner = 1; }
          if (inner === 0) {
            const txt = norm(c.textContent);
            if (txt) { seq.push({ t: "text", text: txt }); continue; }
          }
          walk(c, d + 1);
        }
      };
      walk(region, 0);

      // Fold the sequence into steps. A step button opens a step; text rows
      // seen BEFORE that step's first result are its sub-queries; anchors
      // are its results.
      let cur = null;
      const open = (name) => {
        cur = { name: name || "", subQueries: [], results: [] };
        steps.push(cur);
      };
      for (const item of seq) {
        if (item.t === "step") { open(item.text); continue; }
        if (!cur) open("");
        if (item.t === "result") {
          if (!cur.results.some((r) => r.url === item.url)) {
            cur.results.push({ url: item.url, name: item.title || item.label || "", snippet: "", trusted: item.trusted || undefined });
          }
          continue;
        }
        // text
        if (cur.results.length) continue;                 // trailing chrome ("+7 more")
        // Reported (same real capture as the clock-prompt bug above): the
        // fan-out list ended up with "21:51 · 1s" as its own entry, the
        // answer's full opening paragraph (~260 chars — under the old 300
        // cap) as another, and a markdown table header row whose cells had
        // been joined with no space between them ("PhoneWhy it's great for
        // photosTrade-offsTypical price..."). None of these are a real
        // sub-query the engine ran.
        //
        // A follow-up real capture showed the SAME clock element can glue
        // onto the END of an otherwise-real row with no separator at all —
        // "best camera phone under 8000023:47" is "80000" + "23:47" with
        // nothing between them. Rejecting the whole row (what the bare-clock
        // check below does) would have thrown away a perfectly good query;
        // stripped instead, salvaging the real text before it.
        let t = item.text.replace(/(\d{1,2}:\d{2}(\s*[·•]\s*\d+\s*s)?)$/i, "").trim();
        // Same capture: the fan-out list also picked up the answer's own
        // heading ("Top camera phones under ₹80,000...") and several table
        // cells verbatim (a product name, a price, a spec list) — content
        // that lives in the rendered ANSWER, not anything searched for. A
        // real sub-query is essentially never an exact verbatim substring
        // of the answer's own prose; answer content routinely is.
        if (normAnswer && t.length >= 6 && normAnswer.includes(t.toLowerCase())) continue;
        // Tightened the length cap to something a real query (fanout.js's
        // own benchmark: ~12-15 words, well under 160 chars) can still
        // clear but a full sentence can't; a bare clock/duration reading
        // (the same UI element behind the prompt bug) is rejected outright;
        // two or more missing-space word joins in one string is the
        // concatenation artifact's own signature — a real query with one
        // camelCase brand name in it (OnePlus, PhonePe) never produces more
        // than one such transition.
        if (t.length < 3 || t.length > 160) continue;      // prose or a bare glyph
        if (/^\+\d+\s*more$/i.test(t)) continue;
        if (/^(finished|sources?|steps?|searched)$/i.test(t)) continue;
        if (/^\d{1,2}:\d{2}(\s*[·•]\s*\d+\s*s)?$/i.test(t)) continue;
        if ((t.match(/[a-z][A-Z]/g) || []).length >= 2) continue;
        if (t === cur.name) continue;
        if (!cur.subQueries.includes(t)) cur.subQueries.push(t);
      }

      // Emit the query_plan shape the adapter already understands. The
      // sub-query is preferred when present because it is the real query the
      // engine ran; the step NAME is the fallback, since it is confirmed
      // markup while the sub-query rows are not.
      const out = [];
      const seen = new Set();
      for (const st of steps) {
        const queries = st.subQueries.length ? st.subQueries : (st.name ? [st.name] : []);
        for (const q of queries) {
          const k = q.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ query: q, results: st.results, step: st.name || null });
        }
      }
      return out;
    } catch (_) {
      // Fan-out is additive. Never let it cost us the capture.
      return [];
    }
  };

  (function initDomHarvester() {
    let lastHarvestedSig = "";
    let harvestTimer = null;
    // Capped retry budget for expanding Perplexity's collapsible "Sources"
    // panel (see the perplexity branch below) — reset once a harvest
    // actually succeeds, so every new answer gets a fresh budget, but a
    // stuck/broken trigger can't retry forever.
    let sourcesExpandAttempts = 0;

    const tryHarvest = () => {
      const plat = getPlatform();
      if (plat !== "perplexity" && plat !== "grok" && plat !== "claude") return;

      // x.com maps to "grok", so without this the harvester treated the ENTIRE
      // site as a Grok conversation — running a full document querySelectorAll
      // sweep on the timeline, profiles and DMs, driven by a MutationObserver
      // on a feed that never stops mutating. Grok on X lives only under
      // /i/grok, so everywhere else there is nothing to harvest and the work
      // was pure overhead on one of the busiest pages a user might have open.
      //
      // Checked HERE rather than by narrowing the manifest match pattern,
      // because X is a single-page app: content scripts are injected from the
      // INITIAL url, so a narrower pattern would fail to inject at all when
      // the user navigates to Grok from within X, silently breaking capture.
      // Re-checking per harvest is correct for client-side routing and costs
      // one string comparison.
      if (/(^|\.)x\.com$/i.test(location.hostname) && !/^\/i\/grok/i.test(location.pathname)) return;

      let promptText = "";
      let answerText = "";
      // Declared HERE, not inside the perplexity branch. It is read further
      // down in the shared syntheticRaw payload, which runs for every
      // platform — a `let` inside `if (plat === "perplexity")` is scoped to
      // that block, so reading it below threw
      // "ReferenceError: generatedTitle is not defined" on EVERY successful
      // harvest, for Perplexity, Grok and Claude alike. The throw escaped
      // from a setTimeout callback (the try/catch further down only wraps
      // sendMessage, not the payload construction), so the harvest failed
      // silently with no capture and nothing in the page console to notice.
      let generatedTitle = "";
      const sources = [];
      // Perplexity's sub-query breakdown, when its steps disclosure exposes
      // one. Empty on every other platform and whenever the steps panel
      // isn't present — see harvestPerplexitySteps().
      let queryPlan = [];

      if (plat === "perplexity") {
        // LAST bubble, not first. A Perplexity thread keeps every turn mounted,
        // so querySelector() (which returns the FIRST match) always returned
        // turn 1's prompt no matter how many follow-ups the user asked — one
        // half of why follow-up questions in an existing chat were never
        // captured as their own turn. See the sig note further down for the
        // other half.
        // `[class*="user-bubble"]` FIRST — it is the only one of these
        // confirmed against real Perplexity markup, where the query sits in
        // <div class="group group/user-bubble ...">. None of the others
        // (data-testid="user-query", .user-query, userMessage, queryBubble)
        // appear on the live page at all; they were guesses, and their
        // missing is exactly why the prompt used to fall through to the
        // answer's own h1/h2 and record a section heading as the user's
        // question. Kept anyway, after the real one, since a Set-union of
        // selectors costs nothing and Perplexity's markup does churn.
        const userBubbles = document.querySelectorAll('[class*="user-bubble"], [data-testid="user-query"], .user-query, [data-message-author="user"], div[class*="userMessage"], div[class*="UserMessage"], div[class*="queryBubble"]');
        if (userBubbles.length) promptText = (userBubbles[userBubbles.length - 1].textContent || "").trim();

        // h1 ONLY — not "h1, h2, .font-display". Perplexity renders the
        // ANSWER's own section headings as h2 (and its design font class is
        // used all over the answer body), so the old selector's first match
        // was routinely a heading from inside the answer rather than the
        // thread title. That heading then became the user's "prompt" via the
        // fallback below whenever the query-bubble selectors missed.
        // Confirmed against every real capture in test/fixtures: "Key Paint
        // Characteristics", "Top picks (August 2026)", "What to prioritize
        // for gaming + editing" were all recorded as the user's prompt, and
        // all three appear verbatim as a heading LINE inside their own
        // answer body — the real questions were about bathroom paint, phones
        // and laptops respectively.
        const headingEl = document.querySelector("h1");
        if (headingEl) generatedTitle = (headingEl.textContent || "").trim();

        const proseEls = document.querySelectorAll('.prose, [data-testid="thread-message"], [data-testid="answer-content"], div[dir="auto"].select-text, .answer-content');
        if (proseEls.length) {
          // When each turn's answer is its own block and the block count
          // lines up with the number of user bubbles, capture only the LAST
          // turn — otherwise every follow-up re-sent the whole thread
          // concatenated as one giant "answer". When the counts don't line
          // up (one answer split across several blocks), fall back to
          // joining everything, which is the pre-existing behaviour and
          // still correct for a single-turn thread.
          const els = Array.from(proseEls);
          const perTurn = userBubbles.length > 0 && els.length === userBubbles.length;
          const chosen = perTurn ? [els[els.length - 1]] : els;
          // Markdown, not innerText — see domToMarkdown's header. The structural
          // signals brand detection depends on (bold, headings, table columns)
          // are present in the DOM and destroyed by innerText.
          answerText = chosen.map((p) => domToMarkdown(p)).filter(Boolean).join("\n\n").trim();
        }

        // Reported: the prompt was captured as "21:51" — a bare clock time.
        // Perplexity's answer-page presentation (its fullscreen/immersive
        // reader view, distinct from the normal threaded chat this harvester
        // is built against) apparently shows a timestamp somewhere near
        // where these selectors look for the query, and every fallback below
        // (user bubble, tab title, h1) can end up reading it. Scrubbed out
        // HERE, unconditionally, before the fallback chain even runs — a
        // clock time must never be the "last resort, better than nothing"
        // answer either, unlike an answer heading (below), which is at least
        // real text the model wrote.
        const looksLikeClock = (s) => /^\d{1,2}:\d{2}(\s*[·•]\s*\d+\s*s)?$/i.test(String(s || "").trim());
        if (looksLikeClock(promptText)) promptText = "";

        // Prompt fallbacks, in order of how much they can be trusted. This
        // runs AFTER answerText is known so the heading guard below can
        // actually check against it.
        let titleFromDoc = document.title
          ? document.title.replace(/\s*-\s*Perplexity.*$/i, "").replace(/^Perplexity\s*-\s*/i, "").trim()
          : "";
        if (looksLikeClock(titleFromDoc)) titleFromDoc = "";
        if (looksLikeClock(generatedTitle)) generatedTitle = "";
        // A candidate that appears verbatim as its own LINE inside the answer
        // is a section heading the model wrote, not something the user typed.
        // This is the check that would have caught all four bad real captures.
        const isAnswerHeading = (s) =>
          !!s && answerText.split("\n").some((line) => line.trim() === s.trim());
        if (!promptText || isAnswerHeading(promptText)) {
          if (titleFromDoc && !isAnswerHeading(titleFromDoc)) promptText = titleFromDoc;
          else if (generatedTitle && !isAnswerHeading(generatedTitle)) promptText = generatedTitle;
          else promptText = promptText || titleFromDoc || generatedTitle;
        }

        // Perplexity's "Sources" panel is a collapsible disclosure (a
        // <button aria-expanded="true|false">Sources</button> whose actual
        // <a href> list is a sibling that only carries real content once
        // expanded). Real evidence (a user-provided DevTools capture): the
        // answer's inline citations only ever named 2-5 of the ~10 sources
        // Perplexity's own "Sources (10)" panel lists — the link scan below
        // only ever finds what's ALREADY in the DOM, so if this panel
        // hadn't been expanded yet when harvest ran, most of the source
        // list was never there to find at all. Expanding it here closes
        // that gap; it's a no-op if already open.
        //
        // Matched by visible TEXT ("Sources"), not a class name — Perplexity's
        // own class names in this markup are Tailwind-generated utility
        // soup with no semantic hook, and this project's own house rule
        // (see brands.js's file header) is to key detection off structure/
        // semantics wherever a real content signal exists, not a guessed
        // class string that churns on the next redeploy.
        //
        // There is more than one "Sources"-labelled control on a real
        // Perplexity page (a compact top-right pill, a bottom-of-answer
        // "N sources" line, and the actual accordion trigger whose sibling
        // mounts the <a> list) — `.find()` would click whichever happens to
        // come first in DOM order, which is not guaranteed to be the one
        // that actually gates the link list. `button[aria-expanded]` is a
        // disclosure-widget attribute by definition, never present on an
        // ordinary navigation link, so clicking every collapsed match this
        // finds is safe (nothing here can navigate away) and strictly more
        // likely to hit the right one than picking just the first.
        try {
          // Both disclosures we need to read are the same widget: a
          // <button aria-expanded> whose content only mounts once open.
          // "Sources" hides the full ~10-source list; the steps disclosure
          // ("Finished 1 step", "Searched the web") hides Perplexity's
          // sub-query breakdown, which is the fan-out this tool reports and
          // which currently always reads 0.
          const sourcesTriggers = Array.from(document.querySelectorAll("button[aria-expanded]")).filter((btn) => {
            const t = (btn.textContent || "").trim().toLowerCase();
            return t.startsWith("sources") || PPLX_STEP_LABEL_RE.test(t.replace(/\s+/g, "")) || PPLX_EXPAND_LABEL_RE.test(t);
          });
          const collapsed = sourcesTriggers.filter((btn) => btn.getAttribute("aria-expanded") === "false");
          if (collapsed.length && sourcesExpandAttempts < 3) {
            collapsed.forEach((btn) => btn.click());
            sourcesExpandAttempts++;
            // Bail out of THIS pass rather than reading the DOM in the same
            // synchronous tick: a click doesn't guarantee React has
            // reconciled and mounted the newly-visible <a> nodes yet. Defer
            // to a fresh tryHarvest() shortly after, which (a) gives the
            // expand time to settle and (b) is a NEW call that hasn't set
            // lastHarvestedSig for this answer yet, so it won't be blocked
            // by the dedup guard below the way a MutationObserver-triggered
            // re-run of THIS same signature would be.
            setTimeout(tryHarvest, 400);
            return;
          }
        } catch (_) {}

        const seen = new Set();
        const addSource = (url, title, snippet, isCited = false) => {
          if (!url || typeof url !== "string" || !url.startsWith("http")) return;
          if (url.includes("perplexity.ai") || url.includes("google.com/search") || url.includes("twitter.com/intent")) return;
          if (seen.has(url)) return;
          seen.add(url);
          sources.push({
            url,
            title: String(title || "").trim(),
            name: String(title || "").trim(),
            snippet: String(snippet || "").trim(),
            outcome: isCited ? "cited" : "fetched"
          });
        };

        // 1. Scan script tags (e.g. Next.js / Relay state) for complete web_results arrays
        try {
          const scripts = document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
          scripts.forEach((s) => {
            const txt = s.textContent || "";
            if (txt.includes('"web_results"') || (txt.includes('"url"') && txt.includes('"name"'))) {
              try {
                const data = JSON.parse(txt);
                const walk = (obj) => {
                  if (!obj || typeof obj !== "object") return;
                  if (Array.isArray(obj.web_results)) {
                    obj.web_results.forEach((item) => {
                      if (item && item.url) addSource(item.url, item.name || item.title, item.snippet);
                    });
                  }
                  if (Array.isArray(obj.sources)) {
                    obj.sources.forEach((item) => {
                      if (item && item.url) addSource(item.url, item.name || item.title, item.snippet);
                    });
                  }
                  if (Array.isArray(obj.search_results)) {
                    obj.search_results.forEach((item) => {
                      if (item && item.url) addSource(item.url, item.name || item.title, item.snippet);
                    });
                  }
                  Object.values(obj).forEach(walk);
                };
                walk(data);
              } catch (_) {}
            }
          });
        } catch (_) {}

        // 2. Scan all links and source cards on the page (carousel, Links tab, footnotes)
        const linkNodes = document.querySelectorAll('a[href^="http"], [data-url^="http"], [data-href^="http"], [data-testid*="source"] a, [data-testid*="citation"] a');
        linkNodes.forEach((node) => {
          const u = node.href || node.getAttribute("data-url") || node.getAttribute("data-href");
          const title = (node.getAttribute("title") || node.getAttribute("aria-label") || node.innerText || node.textContent || "").trim();
          addSource(u, title, "");
        });

        // 3. Mark sources as cited if their domain/name appears in inline citation pills in the prose.
        //
        // The `[class*="citation"]`-family selectors below are a guess at
        // Perplexity's markup, not something confirmed against real DOM —
        // keeping them (rather than deleting) costs nothing since this is a
        // Set union, but do not assume they match anything today. A REAL
        // captured badge (2026-08-29) looked like this and matched NONE of
        // them:
        //   <span class="inline-block relative !mt-0 ![vertical-align:unset]
        //     max-w-[25ch] overflow-hidden"
        //     style="mask-image: linear-gradient(to right, black 70%,
        //     transparent 100%);">gadgets.beebom</span>
        // — no "citation" anywhere in its class list. The `max-w-[Nch] +
        // overflow-hidden` + fade-mask combination is what actually
        // identifies this shape: it is a deliberate compact-label
        // truncation affordance, unlikely to appear on ordinary prose,
        // so it is added as its own selector below.
        const citeBadges = new Set();
        const badgeNodes = document.querySelectorAll(
          '[data-testid*="citation"], [class*="citation"], .citation, a[class*="citation"], ' +
          '[class*="max-w-"][class*="overflow-hidden"][style*="mask-image"]'
        );
        badgeNodes.forEach((b) => {
          const bText = (b.innerText || b.textContent || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          if (bText && bText.length >= 3) citeBadges.add(bText);
        });

        // Badge text is compared against the FULL host (dots stripped), not
        // just its first label, and as a prefix rather than requiring exact
        // equality. Two real, separately-confirmed reasons:
        //   1. host.split(".")[0] alone is wrong for any multi-label domain:
        //      "gadgets.beebom.com" -> hostName "gadgets", but the badge
        //      above strips to "gadgetsbeebom" — those can never be equal,
        //      so the old code silently failed to mark ANY two-part-plus
        //      domain as cited, regardless of the selector problem above.
        //   2. The badge's own `max-w-[25ch]` + mask-image fade is a visual
        //      truncation cue — the real label may be shorter than the true
        //      domain even where the DOM text itself isn't cut (as seen
        //      above: "gadgets.beebom" with the ".com" already dropped by
        //      Perplexity's own label formatting, not by this code).
        sources.forEach((s) => {
          const d = (s.url || "").toLowerCase();
          const host = (d.split("/")[2] || "").replace(/^www\./, "");
          const hostNoDots = host.replace(/\./g, "");
          const titleStripped = s.title ? s.title.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
          const cited = [...citeBadges].some((b) =>
            b === hostNoDots || (hostNoDots && hostNoDots.startsWith(b)) || (b && b.startsWith(hostNoDots))
          ) || (titleStripped && citeBadges.has(titleStripped));
          if (cited) s.outcome = "cited";
        });

        // EXACT cited-source URLs, straight from Perplexity's own markup.
        //
        // Every inline citation carries the full source URL in a data
        // attribute: <span class="citation inline" data-pplx-citation-url="...">.
        // That is a far better signal than anything this file was doing
        // before — it is exact (no domain-label guessing), complete (every
        // claim's citation, not just what the Sources panel had rendered),
        // and it is a stable data attribute rather than a Tailwind class
        // name that churns. Confirmed against real captured markup; see
        // test/fixtures/perplexity-answer-dom.html.
        //
        // These are `cited` by definition — the answer is pointing at them
        // mid-sentence — which is a stronger claim than the badge-text
        // matching below can make, so they are marked cited outright.
        try {
          document.querySelectorAll("[data-pplx-citation-url]").forEach((node) => {
            const u = node.getAttribute("data-pplx-citation-url");
            if (!u) return;
            // Perplexity flags sources it considers reputable with its own
            // shield marker. No other engine this tool supports exposes a
            // per-source trust judgement, so it is worth carrying through
            // rather than discarding as decoration.
            const trusted = !!node.querySelector('[data-testid="trusted-citation-check"]');
            const label = (node.textContent || "").replace(/\+\d+\s*$/, "").trim();
            addSource(u, label, "", true);
            const rec = sources.find((x) => x.url === u);
            if (rec) {
              rec.outcome = "cited";
              if (trusted) rec.trusted = true;
            }
          });
        } catch (_) {}

        // Sub-queries from the steps disclosure (expanded above alongside
        // Sources). Additive: when the steps panel isn't present or the
        // selectors miss, this stays empty and fan-out reports 0 exactly as
        // it does today — it never degrades an otherwise good capture.
        queryPlan = harvestPerplexitySteps(document, answerText);

        // Every source a STEP retrieved is a real source, whether or not the
        // answer went on to cite it. On the captured answer the steps list
        // ~14 retrieved results against just 3 inline citations, and
        // retrieved-vs-cited is precisely the distinction this tool exists
        // to measure — a source the engine read and then ignored is a
        // different GEO signal from one it quoted.
        //
        // Added as "fetched". Anything the answer actually cites was already
        // marked "cited" above by the data-pplx-citation-url pass, and
        // addSource() de-dupes on URL, so a source appearing in both keeps
        // the stronger claim rather than being downgraded here.
        try {
          for (const st of queryPlan) {
            for (const r of st.results || []) {
              addSource(r.url, r.name, r.snippet, false);
              if (r.trusted) {
                const rec = sources.find((x) => x.url === r.url);
                if (rec) rec.trusted = true;
              }
            }
          }
        } catch (_) {}
      } else if (plat === "grok") {
        // LAST turn, not first — same follow-up bug as the Perplexity branch
        // above. Reported on Grok too.
        const userEls = document.querySelectorAll('.user-message, [data-message-author="user"]');
        if (userEls.length) promptText = (userEls[userEls.length - 1].textContent || "").trim();

        const msgEls = document.querySelectorAll('.message-row, [data-message-author="assistant"]');
        if (msgEls.length) {
          const els = Array.from(msgEls);
          const perTurn = userEls.length > 0 && els.length === userEls.length;
          const chosen = perTurn ? [els[els.length - 1]] : els;
          // Markdown, not innerText — see domToMarkdown's header. The structural
          // signals brand detection depends on (bold, headings, table columns)
          // are present in the DOM and destroyed by innerText.
          answerText = chosen.map((p) => domToMarkdown(p)).filter(Boolean).join("\n\n").trim();
        }
      } else if (plat === "claude") {
        // Same last-turn handling as the other two. Claude is currently
        // blocked as an engine (see lib/geo.js), but this harvester branch
        // stays correct so it isn't a landmine whenever Claude is enabled.
        const userEls = document.querySelectorAll('[data-testid="user-message"], .font-user-message');
        if (userEls.length) promptText = (userEls[userEls.length - 1].textContent || "").trim();

        const msgEls = document.querySelectorAll('[data-testid="chat-message"], .font-claude-message');
        if (msgEls.length) {
          const els = Array.from(msgEls);
          const perTurn = userEls.length > 0 && els.length === userEls.length;
          const chosen = perTurn ? [els[els.length - 1]] : els;
          // Markdown, not innerText — see domToMarkdown's header. The structural
          // signals brand detection depends on (bold, headings, table columns)
          // are present in the DOM and destroyed by innerText.
          answerText = chosen.map((p) => domToMarkdown(p)).filter(Boolean).join("\n\n").trim();
        }
      }

      if (promptText && answerText && answerText.length > 50) {
        // The dedup signature has to change when a FOLLOW-UP arrives, or the
        // guard below silently drops it. It used to be
        // `plat::promptText::answerText.slice(0,100)`, and in a multi-turn
        // thread NEITHER of those two moved: promptText was always turn 1's
        // (querySelector returns the first match) and the first 100 chars of
        // the concatenated thread are always the START of turn 1's answer,
        // no matter how many turns get appended after it. So every follow-up
        // in an existing chat produced a byte-identical sig to the turn
        // before it and was thrown away — reported on both Perplexity and
        // Grok, and it would have behaved the same on Claude.
        //
        // Length plus the answer's TAIL both move on every new turn, which
        // is what makes each follow-up its own capture.
        const tail = answerText.slice(-160);
        const sig = `${plat}::${promptText}::${answerText.length}::${tail}`;
        if (sig === lastHarvestedSig) return;
        lastHarvestedSig = sig;
        sourcesExpandAttempts = 0; // fresh retry budget for the NEXT answer

        const syntheticRaw = JSON.stringify({
          query: promptText,
          generatedTitle: (generatedTitle && generatedTitle !== promptText) ? generatedTitle : undefined,
          text: answerText,
          web_results: sources,
          // extractFanout()/extractSources() in adapters/perplexity.js
          // already understand this shape (query + per-step results); it
          // has simply never been supplied before, which is why fan-out
          // has always reported 0. Omitted entirely when empty so a record
          // never claims a fan-out it didn't observe.
          query_plan: queryPlan.length ? queryPlan : undefined,
          status: "COMPLETED",
          harvestSource: "dom"
        });

        try {
          chrome.runtime.sendMessage(
            {
              type: "raw-conversation",
              payload: {
                url: location.href,
                reqBody: JSON.stringify({ query: promptText }),
                transport: "dom_harvest",
                raw: syntheticRaw,
                capturedAt: Date.now(),
                pageUrl: location.href,
              },
            },
            () => void chrome.runtime.lastError
          );
        } catch (_) {}
      }
    };

    const observer = new MutationObserver(() => {
      if (harvestTimer) clearTimeout(harvestTimer);
      harvestTimer = setTimeout(tryHarvest, 1200);
    });

    try {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        setTimeout(tryHarvest, 1500);
        setTimeout(tryHarvest, 3000);
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(tryHarvest, 1500);
            setTimeout(tryHarvest, 3000);
          }
        });
      }
    } catch (_) {}
  })();
})();
