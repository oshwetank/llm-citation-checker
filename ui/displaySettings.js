/*
 * displaySettings.js — the Display block in About → Settings (0.63.0).
 *
 * The rules (what's allowed, how it's applied) live in ui/display-boot.js,
 * which runs before the first paint; this draws the controls and saves each
 * change at once, like Light / Dark. The other view (popup or tab) follows
 * through the storage event.
 */
const CD = globalThis.CitoDisplay;
let googleList = null; // [[family, category, weights]], loaded on first search

const CAT = { s: "Sans serif", r: "Serif", d: "Display", h: "Handwriting", m: "Monospace" };
// Made-up brand and an amount with no market assumed (0.69.0).
const SAMPLE = "Aa Zento 1st 29,999";

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("data-") || k.startsWith("aria-") || k === "for" || k === "role") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of kids) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

function current() { return CD.read(localStorage); }
function save(patch) {
  const next = CD.normalize({ ...current(), ...patch });
  try { localStorage.setItem(CD.KEY, JSON.stringify(next)); } catch (_) { /* storage off: this view only */ }
  CD.apply(document, next);
  return next;
}

function slider(id, label, key, ticks, fmt) {
  const [min, max, step] = CD.LIMITS[key];
  const s = current();
  const input = h("input", { type: "range", className: "ds-range", id, min, max, step, value: s[key], "aria-valuetext": fmt(s[key]) });
  const out = h("output", { for: id }, fmt(s[key]));
  const paint = () => { input.style.setProperty("--p", `${((input.value - min) * 100) / (max - min)}%`); out.textContent = fmt(Number(input.value)); input.setAttribute("aria-valuetext", fmt(Number(input.value))); };
  input.oninput = () => { paint(); save({ [key]: Number(input.value) }); };
  paint();
  return h("div", { className: "ds-slider" },
    h("div", { className: "ds-slider-top" }, h("label", { for: id }, label), out),
    input,
    h("div", { className: "ds-ticks", "aria-hidden": "true" }, ...ticks.map((t) => h("span", {}, t))));
}

function seg(id, label, items, cur, onPick) {
  const g = h("div", { className: "ab-seg", role: "radiogroup", "aria-label": label, id });
  items.forEach(([v, text]) => {
    const b = h("button", { type: "button", className: "ab-seg-btn", role: "radio", "aria-checked": String(v === cur), "data-value": v }, text);
    b.onclick = () => onPick(v);
    g.append(b);
  });
  return g;
}

async function loadGoogle() {
  if (googleList) return googleList;
  try {
    const r = await fetch(chrome.runtime.getURL("ui/google-fonts.json"));
    googleList = await r.json();
  } catch (_) { googleList = []; }
  return googleList;
}

function googlePicker(box, s, redraw) {
  const input = h("input", { type: "search", id: "dsGoogle", placeholder: "Search Google Fonts, e.g. Poppins", autocomplete: "off", value: s.font === "google" ? s.gfont : "", "aria-label": "Search Google Fonts", role: "combobox", "aria-expanded": "false", "aria-controls": "dsGoogleList", "aria-autocomplete": "list" });
  const list = h("ul", { className: "ds-glist", id: "dsGoogleList", role: "listbox", hidden: true });
  let items = [], active = -1;
  const pick = (row) => { save({ font: "google", gfont: row[0], gweights: row[2] }); redraw(); };
  const show = async () => {
    const q = input.value.trim().toLowerCase();
    const all = await loadGoogle();
    items = q ? all.filter((r) => r[0].toLowerCase().includes(q)).sort((a, b) => (a[0].toLowerCase().startsWith(q) ? 0 : 1) - (b[0].toLowerCase().startsWith(q) ? 0 : 1)).slice(0, 8) : [];
    active = items.length ? 0 : -1;
    list.replaceChildren(...items.map((r, i) => {
      const li = h("li", { role: "option", id: `dsG${i}`, "aria-selected": String(i === active) }, r[0], h("span", {}, CAT[r[1]] || ""));
      li.onmousedown = (e) => { e.preventDefault(); pick(r); };
      return li;
    }));
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", String(!!items.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", "dsG0"); else input.removeAttribute("aria-activedescendant");
  };
  input.oninput = show;
  input.onkeydown = (e) => {
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
      input.setAttribute("aria-activedescendant", `dsG${active}`);
    } else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
  };
  input.onblur = () => setTimeout(() => { list.hidden = true; input.setAttribute("aria-expanded", "false"); }, 120);
  const on = s.font === "google";
  box.append(h("div", { className: "ds-google" },
    h("div", { className: "ds-gsearch" }, input, list),
    h("span", { className: `ds-note${on ? " on" : ""}`, id: "dsGoogleNote" },
      on ? `${s.gfont} loads from Google Fonts: your browser asks fonts.googleapis.com for it, and Google sees that request. Pick a bundled face to stop it.`
        : "Bundled faces load from the extension. A Google Font is fetched from fonts.googleapis.com, so Google sees that request.")));
}

/** Draws the Display block into its slot and keeps it in step with the other view. */
export function initDisplaySettings(slot) {
  if (!slot || !CD) return;
  const redraw = () => {
    const s = current();
    slot.replaceChildren();
    const reset = h("button", { type: "button", className: "btn sm ghost ds-reset", id: "dsReset", disabled: CD.isDefault(s) }, "Reset display");
    reset.onclick = () => { try { localStorage.removeItem(CD.KEY); } catch (_) { /* nothing stored */ } CD.apply(document, CD.normalize({})); redraw(); };
    slot.append(h("div", { className: "ds-head" }, h("b", { id: "setDisplayLabel" }, "Display"), h("span", {}, "Typeface, size and contrast. Applies straight away, in the popup and the full tab."), reset));

    const fonts = h("div", { className: "ds-fonts", role: "radiogroup", "aria-label": "Typeface", id: "dsFonts" });
    CD.FONTS.forEach(([id, name, stack]) => {
      const b = h("button", { type: "button", className: "ds-font", role: "radio", "aria-checked": String(s.font === id), "data-font": id },
        h("span", { className: "ds-aa", style: `font-family:${stack}, system-ui, sans-serif` }, SAMPLE), h("span", { className: "ds-fname" }, name));
      b.onclick = () => { save({ font: id }); redraw(); };
      fonts.append(b);
    });
    if (s.font === "google") {
      const g = h("button", { type: "button", className: "ds-font", role: "radio", "aria-checked": "true", "data-font": "google" },
        h("span", { className: "ds-aa", style: `font-family:"${s.gfont}", system-ui, sans-serif` }, SAMPLE), h("span", { className: "ds-fname" }, `${s.gfont} · Google Fonts`));
      fonts.prepend(g);
    }
    slot.append(fonts);
    googlePicker(slot, s, redraw);

    slot.append(h("div", { className: "ab-row" }, h("div", { className: "ab-row-text" }, h("b", {}, "Code font"), h("span", {}, "Searches, addresses and ids.")),
      seg("dsMono", "Code font", CD.MONO.map(([id, name]) => [id, name]), s.mono, (v) => { save({ mono: v }); redraw(); })));

    const pct = (v) => `${v}%`;
    slot.append(h("div", { className: "ds-sliders" },
      slider("dsSize", "Text size", "size", ["85%", "100%", "130%"], pct),
      slider("dsBrightness", "Brightness", "brightness", ["80%", "100%", "110%"], pct),
      slider("dsContrast", "Contrast", "contrast", ["80%", "100%", "130%"], pct),
      slider("dsLeading", "Line spacing", "leading", ["Tight", "Normal", "Airy"], (v) => (v === 100 ? "Normal" : `${(1.5 * v / 100).toFixed(2)}×`))));

    slot.append(h("div", { className: "ab-row" }, h("div", { className: "ab-row-text" }, h("b", {}, "Density"), h("span", {}, "Compact fits more rows on screen.")),
      seg("dsDensity", "Density", [["comfortable", "Comfortable"], ["compact", "Compact"]], s.density, (v) => { save({ density: v }); redraw(); })));

    slot.append(h("div", { className: "ds-preview", "aria-label": "Preview" },
      h("div", { className: "ds-pk" }, h("div", {}, h("b", {}, "37.4%"), h("span", {}, "Share of voice")), h("div", {}, h("b", {}, "96.6%"), h("span", {}, "Visibility")), h("div", {}, h("b", {}, "1.6"), h("span", {}, "Average position"))),
      h("p", {}, "Zento Nova was named first in 10 of ChatGPT's 29 answers, ahead of Kovo Air."),
      h("p", {}, "Searched: ", h("code", {}, "best project management software site:reviews.example"))));
    // Keep any slider the user is dragging focused across a redraw from elsewhere.
  };
  redraw();
  window.addEventListener("storage", (e) => {
    if (e.key !== CD.KEY && e.key !== null) return;
    CD.apply(document, current());
    const focused = document.activeElement && slot.contains(document.activeElement) ? document.activeElement.id : null;
    redraw();
    if (focused) document.getElementById(focused)?.focus();
  });
}
