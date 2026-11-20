/* welcome.js — the first-run guide and the email sign-up (0.81.0).
 *
 * Asked: on first install, a full-screen guide to what the tool is and how to
 * use each part, "with clear graphical representation, not too much text
 * heavy"; then an email for update news, checked properly (lib/emailCheck.js),
 * temp mail refused in a Gen Z voice, a plain statement of what the email is
 * used for, and a skip that is respected — shown once, never pushed again.
 *
 * The pictures are drawn here as SVG (no images to download, and they follow
 * light and dark). The email is kept on this computer (chrome.storage.local,
 * SIGNUP_KEY) and sent to the developer's server by the worker once that
 * exists (0.82.0); nothing is sent from this page.
 */
import { checkEmail } from "../src/lib/emailCheck.js";
import { loadLang, chosenLang, tr, translatePage } from "./i18n.js";
import { WHATS_CHANGED, cameFromBeforeRedesign } from "../src/lib/onboarding.js";

// The version someone updated from (background.js records it, 1.0.0). From
// before the 0.80 redesign, the guide starts with what changed.
export const UPDATED_FROM_KEY = "citoUpdatedFrom";

export const SIGNUP_KEY = "citoSignup";
export const WELCOME_KEY = "citoWelcomeDone";

const NS = "http://www.w3.org/2000/svg";
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "className") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : (typeof v === "string" && /^(?:aria-label|placeholder|title)$/.test(k) ? tr(v) : v));
  }
  // Text is translated here (1.0.0), as panel.js's el() does.
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(tr(String(c))));
  return e;
};
// A small SVG from a list of [tag, attrs] shapes, sized by its viewBox.
const svg = (w, hgt, shapes, label) => {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  s.setAttribute("class", "wl-art");
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", tr(label));
  for (const [tag, a, text] of shapes) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
    if (text) n.textContent = tr(text);
    s.append(n);
  }
  return s;
};
const R = (x, y, w, hh, cls, rx = 10) => ["rect", { x, y, width: w, height: hh, rx, class: cls }];
const T = (x, y, text, cls = "t") => ["text", { x, y, class: cls }, text];
const C = (cx, cy, r, cls) => ["circle", { cx, cy, r, class: cls }];
const L = (x1, y1, x2, y2, cls = "ln") => ["line", { x1, y1, x2, y2, class: cls }];

// The pictures. Made-up brands (Zento, Kovo, Lumora), as everywhere in the tool.
const ART = {
  changed: () => svg(420, 240, [
    R(30, 40, 150, 150, "card"), T(50, 72, "0.36", "t b"), R(50, 90, 110, 12, "bar"), R(50, 112, 90, 12, "bar"), R(50, 134, 100, 12, "bar"),
    ["path", { d: "M192 115 L232 115", class: "arrow" }], ["path", { d: "M224 107 L234 115 L224 123", class: "arrow" }],
    R(244, 30, 150, 170, "card"), T(264, 62, "1.0", "t b"), R(264, 80, 110, 12, "bar a"), R(264, 102, 80, 12, "bar"), R(264, 124, 100, 12, "bar"), R(264, 146, 70, 12, "bar"), C(370, 176, 12, "lens"),
  ], "The earlier version on the left, this version on the right"),
  hello: () => svg(420, 240, [
    R(20, 30, 210, 150, "card"), T(40, 62, "You asked an AI:", "t s"), T(40, 86, "“best linen shirt?”", "t b"),
    R(40, 104, 150, 14, "bar a"), R(40, 126, 120, 14, "bar"), R(40, 148, 90, 14, "bar"),
    ["path", { d: "M238 105 L282 105", class: "arrow" }], ["path", { d: "M274 97 L284 105 L274 113", class: "arrow" }],
    C(340, 105, 62, "lens"), T(305, 92, "Zento #1", "t chip1"), T(305, 114, "Kovo #2", "t chip2"), T(305, 136, "3 sites cited", "t s"),
    L(386, 150, 410, 178, "handle"),
  ], "An AI answer goes in; the brands it named and the sites it cited come out"),
  analyze: () => svg(420, 240, [
    R(20, 20, 380, 200, "card"), T(40, 50, "One answer, taken apart", "t b"),
    R(40, 66, 160, 64, "tile"), T(52, 90, "Brands named", "t s"), T(52, 116, "Zento · Kovo · Lumora", "t"),
    R(220, 66, 160, 64, "tile"), T(232, 90, "Sites cited", "t s"), T(232, 116, "stylelab · fabricdesk", "t"),
    R(40, 144, 160, 60, "tile"), T(52, 168, "Searches it ran", "t s"), T(52, 192, "“linen shirt 2026”", "t"),
    R(220, 144, 160, 60, "tile"), T(232, 168, "Pictures & places", "t s"), R(232, 178, 30, 18, "pic", 4), R(268, 178, 30, 18, "pic", 4), R(304, 178, 30, 18, "pic", 4),
  ], "Analyze shows the brands, sites, searches and pictures behind one answer"),
  dashboard: () => svg(420, 240, [
    R(20, 20, 380, 200, "card"), T(40, 50, "Everything you've asked", "t b"),
    ...[0, 1, 2, 3].map((i) => R(40, 66 + i * 36, 340, 28, i === 0 ? "row on" : "row", 8)),
    T(54, 85, "best linen shirt", "t"), T(54, 121, "linen vs cotton", "t"), T(54, 157, "summer shirt brands", "t"), T(54, 193, "breathable fabrics", "t"),
    C(330, 80, 6, "eng1"), C(346, 80, 6, "eng2"), C(330, 116, 6, "eng1"), C(330, 152, 6, "eng2"), C(346, 152, 6, "eng3"), C(330, 188, 6, "eng1"),
  ], "The Dashboard lists every prompt you've asked, on every engine"),
  campaigns: () => svg(420, 240, [
    R(20, 20, 380, 200, "card"), T(40, 50, "A campaign: your prompts × engines", "t b"),
    R(40, 66, 100, 26, "pill a", 13), T(56, 84, "ChatGPT", "t w"), R(150, 66, 100, 26, "pill b", 13), T(170, 84, "Gemini", "t w"),
    T(40, 122, "Your brand’s visibility, run after run", "t s"),
    ["polyline", { points: "40,196 110,176 180,182 250,150 320,138 380,120", class: "spark" }],
    ...[[40, 196], [110, 176], [180, 182], [250, 150], [320, 138], [380, 120]].map(([x, y]) => C(x, y, 4, "dot")),
  ], "Campaigns run your prompts on several engines and track your brand run by run"),
  ask: () => svg(420, 240, [
    R(20, 20, 380, 200, "card"), R(40, 44, 230, 40, "bubble me", 14), T(56, 69, "Where am I losing to Kovo?", "t w"),
    R(120, 98, 260, 56, "bubble", 14), T(136, 122, "On 4 prompts, mostly on Gemini —", "t"), T(136, 142, "fabricdesk cites Kovo, not you.", "t"),
    R(40, 170, 340, 34, "row", 10), T(56, 192, "Share it with any AI", "t s"),
    ["path", { d: "M342 196 v-14 m-6 6 l6 -6 l6 6", class: "arrow" }],
  ], "Ask questions about your own data, or share it with your favourite AI"),
};

let STEPS = [
  { id: "hello", title: "See how AI talks about your brand", sub: "CitoSkeleton reads the answers ChatGPT, Gemini, Perplexity and Grok give you, right in your browser, and shows which brands they name and which sites they trust." },
  { id: "analyze", title: "Analyze: one answer, taken apart", sub: "Brands in the order they were named, the pages cited and the ones only read, the searches the engine ran, and its pictures and places." },
  { id: "dashboard", title: "Dashboard: every prompt you've asked", sub: "Search everything you've captured, by engine, date or kind of answer." },
  { id: "campaigns", title: "Campaigns: your prompts, every engine, every run", sub: "Run a list of prompts on several engines at a human pace, then compare runs to see what moved." },
  { id: "ask", title: "Ask, and share", sub: "Ask questions of your own data, or take it to your favourite AI with the share icon." },
];

const store = {
  async get(k) { try { return (await chrome.storage.local.get(k))[k]; } catch (_) { return null; } },
  async set(k, v) { try { await chrome.storage.local.set({ [k]: v }); } catch (_) { /* nothing to keep it in */ } },
};

let at = 0;
const root = document.getElementById("welcome");

function dots() {
  const total = STEPS.length + 1;
  return h("div", { className: "wl-dots", role: "tablist", "aria-label": "Steps" },
    ...Array.from({ length: total }, (_, i) => h("button", { type: "button", role: "tab", className: `wl-dot${i === at ? " on" : ""}`, "aria-selected": String(i === at), "aria-label": `Step ${i + 1} of ${total}`, onclick: () => go(i) })));
}

function stepView(s) {
  const next = h("button", { type: "button", className: "wl-btn primary", id: "wlNext", onclick: () => go(at + 1) }, at === STEPS.length - 1 ? "Almost done →" : "Next →");
  const back = at ? h("button", { type: "button", className: "wl-btn ghost", onclick: () => go(at - 1) }, "← Back") : h("span");
  return h("section", { className: "wl-step", "data-step": s.id },
    h("div", { className: "wl-pic" }, ART[s.id]()),
    h("div", { className: "wl-copy" },
      h("p", { className: "wl-kicker" }, `${at + 1} of ${STEPS.length + 1}`),
      h("h1", { className: "wl-h" }, s.title),
      h("p", { className: "wl-sub" }, s.sub),
      s.id === "changed" ? h("dl", { className: "wl-changed" }, ...WHATS_CHANGED.flatMap((x) => [h("dt", {}, x.was), h("dd", {}, x.now)])) : null,
      h("div", { className: "wl-nav" }, back, next)));
}

function emailView() {
  const input = h("input", { type: "email", id: "wlEmail", className: "wl-input", placeholder: "you@example.com", autocomplete: "email", "aria-describedby": "wlMsg", required: true });
  const msg = h("p", { id: "wlMsg", className: "wl-msg", role: "status" });
  const consent = h("input", { type: "checkbox", id: "wlConsent", checked: true });
  const send = h("button", { type: "submit", className: "wl-btn primary", id: "wlSend" }, "Keep me posted");
  const skip = h("button", { type: "button", className: "wl-btn ghost", id: "wlSkip" }, "Skip for now");
  const form = h("form", { className: "wl-form", novalidate: true },
    h("label", { className: "wl-label", for: "wlEmail" }, "Your email"),
    h("div", { className: "wl-row" }, input, send),
    msg,
    h("label", { className: "wl-check" }, consent, h("span", {}, "Send me news about updates and offers for CitoSkeleton.")),
    h("p", { className: "wl-privacy", id: "wlPrivacy" },
      h("b", {}, "Your email is only for this. "),
      "We use it to tell you about CitoSkeleton's updates and offers, and to hear back about problems you report. It is never sold, shared with or passed to any other company or person: only the developer sees it. Unsubscribe any time from any email we send, or remove it in About → Settings."));
  let suggested = null;
  const show = (text, kind) => { msg.textContent = tr(text); msg.className = `wl-msg ${kind || ""}`; };
  input.addEventListener("input", () => { suggested = null; show("", ""); });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = checkEmail(input.value);
    if (!r.ok) { show(r.message, r.reason === "disposable" ? "bad gz" : "bad"); input.focus(); return; }
    // A likely slip ("gmial.com"): offered once; a second press keeps what was typed.
    if (r.reason === "typo" && suggested !== r.email) {
      suggested = r.email;
      show("", "warn");
      const use = h("button", { type: "button", className: "wl-link", onclick: () => { input.value = `${r.email.split("@")[0]}@${r.suggestion}`; suggested = null; show("Fixed ✨ Press Keep me posted.", "ok"); } }, `@${r.suggestion}`);
      msg.replaceChildren(document.createTextNode("Did you mean "), use, document.createTextNode("? No judgement, we all fat-finger 🫶 (Press again to keep yours.)"));
      return;
    }
    if (!consent.checked) { show("Tick the box so we're allowed to write to you ✅", "bad"); return; }
    await store.set(SIGNUP_KEY, { email: r.email, at: Date.now(), consent: true, sent: false, source: "welcome" });
    try { chrome.runtime.sendMessage({ type: "signup-saved" }, () => void chrome.runtime.lastError); } catch (_) { /* the worker sends it later */ }
    await finish("in");
  });
  skip.onclick = async () => {
    // Said once, plainly; then never asked again.
    if (skip.dataset.sure !== "1") {
      skip.dataset.sure = "1";
      skip.textContent = tr("Skip anyway");
      show("No worries. Just so you know: without an email you won't hear about new features and fixes, and things change fast in AI search. You can add it later in About → Settings.", "warn");
      return;
    }
    await store.set(SIGNUP_KEY, { skipped: true, at: Date.now() });
    await finish("skipped");
  };
  form.append(h("div", { className: "wl-nav" }, h("button", { type: "button", className: "wl-btn ghost", onclick: () => go(at - 1) }, "← Back"), skip));
  // Replayed later (About → Replay the guide): an email already given is
  // said, not asked for again.
  store.get(SIGNUP_KEY).then((got) => {
    if (got && got.email && form.isConnected) form.replaceChildren(h("p", { className: "wl-msg ok" }, `${tr("You're signed up as")} ${got.email} ✨`), h("div", { className: "wl-nav" }, h("button", { type: "button", className: "wl-btn primary", onclick: () => finish("in") }, "Done")));
  });
  return h("section", { className: "wl-step wl-email", "data-step": "email" },
    h("div", { className: "wl-pic" }, svg(420, 240, [
      R(60, 50, 300, 150, "card"), ["path", { d: "M60 60 L210 150 L360 60", class: "env" }], C(330, 66, 26, "badge"), T(318, 74, "✨", "t big"),
    ], "An envelope with a sparkle: news about updates")),
    h("div", { className: "wl-copy" },
      h("p", { className: "wl-kicker" }, `${STEPS.length + 1} of ${STEPS.length + 1}`),
      h("h1", { className: "wl-h" }, "Stay in the loop"),
      h("p", { className: "wl-sub" }, "AI search changes every week, and CitoSkeleton changes with it. Leave your email to hear about new features and fixes first."),
      form));
}

async function finish(how) {
  await store.set(WELCOME_KEY, { at: Date.now(), how });
  root.replaceChildren(h("section", { className: "wl-step wl-done" },
    h("div", { className: "wl-copy" },
      h("h1", { className: "wl-h" }, how === "in" ? "You're in ✨" : "All set"),
      h("p", { className: "wl-sub" }, how === "in" ? "We'll only write when there's something new. Now open ChatGPT or Gemini and ask something: CitoSkeleton reads the answer as it arrives." : "Open ChatGPT or Gemini and ask something: CitoSkeleton reads the answer as it arrives. Click the CitoSkeleton icon in your toolbar to see it."),
      h("div", { className: "wl-nav" }, h("button", { type: "button", className: "wl-btn primary", id: "wlOpen", onclick: () => { location.href = "panel.html?mode=tab"; } }, "Open CitoSkeleton")))));
}

function go(i) {
  at = Math.max(0, Math.min(STEPS.length, i));
  const view = at < STEPS.length ? stepView(STEPS[at]) : emailView();
  root.replaceChildren(view, dots());
  const f = root.querySelector("#wlEmail, #wlNext");
  if (f) f.focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowRight") go(at + 1);
  if (e.key === "ArrowLeft") go(at - 1);
});

// The language first, then the steps (1.0.0).
(async () => {
  await loadLang(chosenLang());
  translatePage();
  document.title = tr("Welcome to CitoSkeleton");
  const from = await store.get(UPDATED_FROM_KEY);
  if (cameFromBeforeRedesign(from)) STEPS = [{ id: "changed", title: "What's changed since your last version", sub: "CitoSkeleton has been rebuilt. Here is where everything you knew went." }, ...STEPS];
  go(0);
})();
