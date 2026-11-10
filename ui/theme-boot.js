// Applies the saved theme to <html> before the panel paints (see the comment
// where panel.html loads this). Two independent choices, both kept in this
// browser's localStorage so the popup and the full tab share them:
//   data-style — "studio" (the default since 0.59.0) or "classic" (the
//                0.47–0.58 look);
//   data-theme — "light" (default) or "dark";
//   data-detail — "simple" (default) or "expert" (0.60.0): Expert adds the
//                engine's raw ids, indexes and refs (.x-only elements).
// panel.js keeps them in step afterwards (applyTheme / applyStyle and the
// storage listener). Anything unreadable falls back to the defaults.
(function () {
  var style = "studio", theme = "light", detail = "simple";
  try {
    if (localStorage.getItem("cito-style") === "classic") style = "classic";
    if (localStorage.getItem("cito-theme") === "dark") theme = "dark";
    if (localStorage.getItem("cito-detail") === "expert") detail = "expert";
  } catch (_) { /* storage blocked: defaults */ }
  document.documentElement.setAttribute("data-style", style);
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-detail", detail);
  // Right-to-left before the first paint (0.71.0); ui/i18n.js settles the
  // language itself a moment later. Only languages with a dictionary count.
  try {
    var pref = localStorage.getItem("cito-lang") || "auto";
    var lang = pref === "auto" ? ((navigator.languages && navigator.languages[0]) || navigator.language || "en") : pref;
    if (/^ar\b/i.test(lang)) document.documentElement.setAttribute("dir", "rtl");
  } catch (_) { /* storage blocked: left to right */ }
})();
