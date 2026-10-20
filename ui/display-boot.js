// Display settings (0.63.0): typeface, text size, brightness, contrast, line
// spacing and density, kept in this browser's localStorage so the popup and
// the full tab share them. Asked for: a font picker with bundled and Google
// fonts, and sliders for size, brightness, contrast, spacing and density.
//
// A plain script, not a module, so panel.html can run it in <head> and the
// settings are in place before the first paint (like theme-boot.js). It also
// publishes globalThis.CitoDisplay, which panel.js's Settings page and the
// unit test use, so there is one copy of the rules.
//
// Nothing here makes a network request, except when the person picks a
// Google Font: then one stylesheet link to fonts.googleapis.com is added, and
// the Settings page says so next to the picker.
(function (g) {
  var KEY = "cito-display";
  // Bundled faces (fonts.css, fonts/display/; SIL OFL). id -> [name, CSS stack].
  var FONTS = [
    ["geist", "Geist", '"Geist"'],
    ["ibm-plex-sans", "IBM Plex Sans", '"IBM Plex Sans"'],
    ["inter", "Inter", '"Inter"'],
    ["roboto", "Roboto", '"Roboto"'],
    ["open-sans", "Open Sans", '"Open Sans"'],
    ["lato", "Lato", '"Lato"'],
    ["source-sans-3", "Source Sans 3", '"Source Sans 3"'],
    ["noto-sans", "Noto Sans", '"Noto Sans"'],
    ["nunito", "Nunito", '"Nunito"'],
    ["work-sans", "Work Sans", '"Work Sans"'],
    ["manrope", "Manrope", '"Manrope"'],
    ["dm-sans", "DM Sans", '"DM Sans"'],
    ["atkinson-hyperlegible-next", "Atkinson Hyperlegible Next", '"Atkinson Hyperlegible Next"'],
    ["merriweather", "Merriweather", '"Merriweather"'],
    ["lora", "Lora", '"Lora"'],
  ];
  var MONO = [
    ["geist-mono", "Geist Mono", '"Geist Mono"'],
    ["jetbrains-mono", "JetBrains Mono", '"JetBrains Mono"'],
    ["ibm-plex-mono", "IBM Plex Mono", '"IBM Plex Mono"'],
  ];
  var SANS_TAIL = ', "IBM Plex Sans Devanagari", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var MONO_TAIL = ", ui-monospace, SFMono-Regular, Consolas, monospace";
  var DEFAULTS = { font: "geist", gfont: "", gweights: "", mono: "geist-mono", size: 100, brightness: 100, contrast: 100, leading: 100, density: "comfortable" };
  // [min, max, step] in percent.
  var LIMITS = { size: [85, 130, 5], brightness: [80, 110, 5], contrast: [80, 130, 5], leading: [90, 140, 5] };

  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i]; return null; }
  function clamp(v, l) {
    var n = Math.round(Number(v) / l[2]) * l[2];
    if (!isFinite(n)) return null;
    return Math.min(l[1], Math.max(l[0], n));
  }
  // A Google family name as the CSS2 API takes it: letters, digits, spaces.
  function familyOk(f) { return typeof f === "string" && /^[A-Za-z0-9 ]{2,60}$/.test(f.trim()); }

  /** Any stored value made safe: unknown ids fall back, numbers are clamped to their range and step. */
  function normalize(s) {
    s = s && typeof s === "object" ? s : {};
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (s.font === "google" && familyOk(s.gfont)) { out.font = "google"; out.gfont = s.gfont.trim(); out.gweights = /^[0-9;]{3,24}$/.test(s.gweights || "") ? s.gweights : ""; }
    else if (find(FONTS, s.font)) out.font = s.font;
    if (find(MONO, s.mono)) out.mono = s.mono;
    for (var key in LIMITS) { var v = s[key] == null ? null : clamp(s[key], LIMITS[key]); if (v != null) out[key] = v; }
    if (s.density === "compact") out.density = "compact";
    return out;
  }
  function read(storage) {
    try { return normalize(JSON.parse(storage.getItem(KEY) || "{}")); } catch (_) { return normalize({}); }
  }
  function isDefault(s) { var n = normalize(s); for (var k in DEFAULTS) if (n[k] !== DEFAULTS[k]) return false; return true; }
  function fontStack(s) {
    if (s.font === "google") return '"' + s.gfont + '"' + SANS_TAIL;
    return (find(FONTS, s.font) || FONTS[0])[2] + SANS_TAIL;
  }
  function monoStack(s) { return (find(MONO, s.mono) || MONO[0])[2] + MONO_TAIL; }
  /** The one stylesheet a Google Font needs (CSS2 API), weights where the family has them. */
  function googleUrl(family, weights) {
    var f = String(family).trim().replace(/ +/g, "+");
    return "https://fonts.googleapis.com/css2?family=" + f + (weights ? ":wght@" + weights : "") + "&display=swap";
  }

  /** Applies settings to a document: CSS variables and attributes on <html>, and the Google Font link. */
  function apply(doc, s) {
    s = normalize(s);
    var root = doc.documentElement;
    root.style.setProperty("--font-sans", fontStack(s));
    root.style.setProperty("--font-mono", monoStack(s));
    root.style.setProperty("--ui-zoom", String(s.size / 100));
    root.style.setProperty("--ui-bright", String(s.brightness / 100));
    root.style.setProperty("--ui-contrast", String(s.contrast / 100));
    root.style.setProperty("--ui-leading", String(s.leading / 100));
    root.setAttribute("data-density", s.density);
    // A filter makes its element the containing block for fixed children,
    // so it is only set when it changes something.
    if (s.brightness !== 100 || s.contrast !== 100) root.setAttribute("data-display-filter", "");
    else root.removeAttribute("data-display-filter");
    var link = doc.getElementById("cito-gfont");
    if (s.font === "google") {
      var href = googleUrl(s.gfont, s.gweights);
      if (!link) {
        link = doc.createElement("link");
        link.id = "cito-gfont";
        link.rel = "stylesheet";
        (doc.head || root).appendChild(link);
      }
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    } else if (link && link.parentNode) link.parentNode.removeChild(link);
    return s;
  }

  // Motion (0.78.0): "on" or "off", and off whenever the system asks for
  // reduced motion. On <html> as data-motion before the first paint.
  var MOTION_KEY = "cito-motion";
  function readMotion(store) { try { return store.getItem(MOTION_KEY) === "off" ? "off" : "on"; } catch (_) { return "on"; } }
  function applyMotion(doc, m) {
    var reduce = false;
    try { reduce = !!(g.matchMedia && g.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_) {}
    doc.documentElement.setAttribute("data-motion", m === "off" || reduce ? "off" : "on");
    return m;
  }
  try { if (g.document && g.localStorage) applyMotion(g.document, readMotion(g.localStorage)); } catch (_) { /* storage blocked: on */ }

  g.CitoDisplay = { MOTION_KEY: MOTION_KEY, readMotion: readMotion, applyMotion: applyMotion, KEY: KEY, FONTS: FONTS, MONO: MONO, DEFAULTS: DEFAULTS, LIMITS: LIMITS, normalize: normalize, read: read, isDefault: isDefault, fontStack: fontStack, googleUrl: googleUrl, apply: apply };
  try { if (g.document && g.localStorage) apply(g.document, read(g.localStorage)); } catch (_) { /* storage blocked: defaults */ }
})(globalThis);
