/*
 * handoff.js — puts a "Continue in…" message into another AI's chat box and
 * sends it (0.76.0).
 *
 * Injected by the service worker (chrome.scripting) only into a tab it has
 * just opened for a hand-off, never into any other page. It asks the worker
 * for this tab's message (handoff-claim: the text never travels in the
 * address), waits for the chat box, fills it, and presses send unless the
 * user chose to review it there first. ChatGPT, Gemini, Perplexity and Grok
 * use the same kinds of boxes as the campaign runner (content-iso.js);
 * Claude's is a ProseMirror editor too.
 */
(() => {
  if (window.__citoHandoff) return;
  window.__citoHandoff = true;

  const BOX = {
    "chatgpt.com": ["#prompt-textarea", 'div[contenteditable="true"]', "textarea"],
    "claude.ai": ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', "textarea"],
    "gemini.google.com": ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]', "textarea"],
    "perplexity.ai": ["textarea", 'div[contenteditable="true"]'],
    "grok.com": ['[data-testid="chat-input"] [contenteditable="true"]', '.ProseMirror[contenteditable="true"]', "textarea"],
  };
  const SEND = {
    "chatgpt.com": ["#composer-submit-button", '[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
    "claude.ai": ['button[aria-label*="Send" i]', 'button[type="submit"]'],
    "gemini.google.com": ['button[aria-label*="Send" i]', "button.send-button"],
    "perplexity.ai": ['button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]', 'button[type="submit"]'],
    "grok.com": ['[data-testid="chat-submit"]', 'button[aria-label*="Submit" i]', 'button[type="submit"]'],
  };
  const host = Object.keys(BOX).find((h) => location.hostname === h || location.hostname.endsWith(`.${h}`)) || "chatgpt.com";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.getAttribute("aria-hidden") !== "true"; };
  const find = (sels) => { for (const s of sels) for (const el of document.querySelectorAll(s)) if (visible(el)) return el; return null; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el.value != null && el.tagName === "TEXTAREA" ? el.value : el.innerText || el.textContent || "");
  const report = (r) => { try { chrome.runtime.sendMessage({ type: "handoff-result", ...r }, () => void chrome.runtime.lastError); } catch (_) { /* gone */ } };

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); }
    return null;
  }

  // Into the box, the ways that box accepts: an editing command first (both
  // textareas and rich editors take it and their frameworks see the input),
  // then a paste event (rich editors read it), then setting the value.
  function fill(box, text) {
    box.focus();
    try { document.execCommand("selectAll", false, null); } catch (_) { /* nothing selected */ }
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
    if (ok && textOf(box).length >= Math.min(text.length, 200) * 0.9) return "typed";
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      if (textOf(box).length >= Math.min(text.length, 200) * 0.9) return "pasted";
    } catch (_) { /* no paste */ }
    if (box.tagName === "TEXTAREA") {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      set.call(box, text);
    } else box.textContent = text;
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return textOf(box).length ? "set" : null;
  }

  async function send(box) {
    const btn = await waitFor(() => { const b = find(SEND[host]); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null; }, 8000);
    if (btn) btn.click();
    else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    // Sent when the box empties or the page moves to the new conversation.
    const start = location.href;
    return !!(await waitFor(() => !textOf(box).trim() || location.href !== start, 8000));
  }

  chrome.runtime.sendMessage({ type: "handoff-claim" }, async (job) => {
    void chrome.runtime.lastError;
    if (!job || !job.ok || !job.text) return;
    const box = await waitFor(() => find(BOX[host]), 25000);
    if (!box) { report({ ok: false, error: "no chat box found (signed out, or the page changed)" }); return; }
    await sleep(300);
    const how = fill(box, job.text);
    if (!how) { report({ ok: false, error: "the chat box didn't take the text" }); return; }
    if (!job.autoSend) { report({ ok: true, sent: false, how }); return; }
    const sent = await send(box);
    report({ ok: sent, sent, how, ...(sent ? {} : { error: "the message is in the box but couldn't be sent; press send" }) });
  });
})();
