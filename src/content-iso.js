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
      let tries = 0;
      let searchDone = false;
      const timer = setInterval(() => {
        if (++tries > 30) return clearInterval(timer);
        if (pick(sel.streaming)) return clearInterval(timer); // already answering

        if (plat === "chatgpt" && wantSearch && !searchDone && !pick(sel.searchActive)) {
          const pill = pick(sel.searchPill);
          if (pill) {
            pill.click();
            searchDone = true;
            return;
          }
        }

        const box = pick(sel.composer);
        if (!box) return;

        if (!box.dataset.lcfcInjected) {
          box.focus();
          const isField = /^(textarea|input)$/i.test(box.tagName);
          if (!(document.execCommand && document.execCommand("insertText", false, q))) {
            if (isField) box.value = q;
            else box.textContent = q;
          }
          box.dispatchEvent(new InputEvent("input", { bubbles: true }));
          box.dispatchEvent(new Event("change", { bubbles: true }));
          box.dataset.lcfcInjected = "true";
          return; // let the send button enable on the next tick
        }

        const send = pick(sel.send);
        if (send && !send.disabled) {
          (send.closest ? send.closest("button") || send : send).click();
          clearInterval(timer);
        } else if (plat === "gemini") {
          // Gemini's send button state is framework-driven; Enter is more reliable.
          const ev = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
          box.dispatchEvent(new KeyboardEvent("keydown", ev));
          box.dispatchEvent(new KeyboardEvent("keyup", ev));
          clearInterval(timer);
        }
      }, 400);
    }
  })();
})();
