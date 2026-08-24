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
    },
    gemini: {
      composer: ['rich-textarea div[contenteditable="true"]', "rich-textarea", 'div[contenteditable="true"]', "textarea"],
      send: ['button[aria-label*="Send message" i]', 'button[aria-label*="Send" i]', ".send-button"],
      streaming: ['button[aria-label*="Stop" i]', 'button[mattooltip*="Stop" i]', ".stop-button"],
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

  const getPlatform = () => (location.hostname.includes("gemini") ? "gemini" : "chatgpt");

  (function loaderAutoSubmit() {
    const params = new URLSearchParams(location.search);
    if (params.get("lcfc") !== "1") return;
    const q = params.get("q") || "";
    const token = params.get("lcfctok") || "";
    const wantSearch = params.get("lcfcsearch") === "1";
    // Strip markers so a manual reload can't re-fire the prompt.
    try {
      history.replaceState(null, "", location.pathname);
    } catch (_) {}
    if (!q || !token) return;

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

      // ChatGPT also reads ?q= itself and can pre-fill the composer from it.
      // Inserting on top of that produced the prompt twice in one turn, which
      // is one of the ways a run "ran but not properly". Always clear first.
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
        try {
          chrome.runtime.sendMessage({ type: "loader-submit-failed", token, reason }, () => void chrome.runtime.lastError);
        } catch (_) { /* worker may be gone; the watchdog still covers us */ }
      };

      // ChatGPT is a heavy SPA and can take well over the old 12s budget to
      // mount its composer on a cold navigation; Gemini was usually quicker,
      // which is part of why this only ever looked broken on ChatGPT.
      const TICK_MS = 400;
      const MAX_WAIT_TICKS = 75;    // ~30s for the composer to appear
      const MAX_SEND_TICKS = 20;    // ~8s of submit attempts once text is in
      let ticks = 0;
      let sendTicks = 0;
      let searchDone = false;
      let injected = false;
      let submitTried = 0;

      const timer = setInterval(() => {
        if (++ticks > MAX_WAIT_TICKS) {
          clearInterval(timer);
          giveUp(injected ? "prompt typed but never submitted" : "composer never appeared");
          return;
        }

        // Already answering — either our submit landed, or the page was
        // mid-stream when we arrived. Either way we're done here.
        if (pick(sel.streaming)) { clearInterval(timer); return; }

        if (plat === "chatgpt" && wantSearch && !searchDone && !pick(sel.searchActive)) {
          const pill = pick(sel.searchPill);
          if (pill) { pill.click(); searchDone = true; return; }
        }

        const box = pick(sel.composer);
        if (!box) return;

        if (!injected) {
          clearComposer(box);
          insertText(box, q);
          injected = true;
          return; // give the framework a tick to enable its send control
        }

        // Confirm the text actually landed. A contenteditable can accept focus
        // and still hold nothing if the editor rejected the write, and
        // submitting an empty composer is what produced "ran but nothing
        // happened" turns. Re-insert rather than pressing on.
        const text = composerText(box).replace(/\s+/g, " ").trim();
        const want = q.replace(/\s+/g, " ").trim();
        // Only re-type while we have not yet tried to send. Once a submit has
        // been attempted, an empty composer means the send WORKED — re-filling
        // it there would submit the same prompt a second time, which is its
        // own bug (duplicate turns) and worse than the one being fixed.
        if (submitTried === 0) {
          if (!text) { injected = false; return; }
          if (text !== want && text.length < Math.min(12, want.length)) { injected = false; return; }
        } else if (!text) {
          clearInterval(timer); // composer emptied after a submit: it went through
          return;
        }

        // Submit. Try the button first, then Enter — ChatGPT accepts Enter in
        // its composer just as Gemini does, and only Gemini had that fallback
        // before, which is the asymmetry that made ChatGPT runs fail outright
        // whenever its send button stayed inert.
        sendTicks++;
        const send = pick(sel.send);
        if (isUsable(send) && submitTried === 0) {
          (send.closest ? send.closest("button") || send : send).click();
          submitTried = 1;
          return; // verify on the next tick instead of assuming it worked
        }
        if (submitTried <= 1) {
          pressEnter(box);
          submitTried = 2;
          return;
        }

        // Neither took effect yet. Keep alternating for a few ticks — the
        // composer clearing or the stop button appearing is the real proof.
        if (!composerText(box).trim()) { clearInterval(timer); return; }
        if (sendTicks > MAX_SEND_TICKS) {
          clearInterval(timer);
          giveUp("send control never accepted the prompt");
          return;
        }
        if (sendTicks % 2 === 0) {
          const s3 = pick(sel.send);
          if (isUsable(s3)) (s3.closest ? s3.closest("button") || s3 : s3).click();
        } else {
          pressEnter(box);
        }
      }, TICK_MS);
    }
  })();
})();
