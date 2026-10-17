// Applies the saved theme to <html> before the panel paints (see the comment
// where panel.html loads this). Two independent choices, both kept in this
// browser's localStorage so the popup and the full tab share them:
//   data-style — "studio" (the default since 0.59.0) or "classic" (the
//                0.47–0.58 look);
//   data-theme — "light" (default) or "dark".
// panel.js keeps them in step afterwards (applyTheme / applyStyle and the
// storage listener). Anything unreadable falls back to the defaults.
(function () {
  var style = "studio", theme = "light";
  try {
    if (localStorage.getItem("cito-style") === "classic") style = "classic";
    if (localStorage.getItem("cito-theme") === "dark") theme = "dark";
  } catch (_) { /* storage blocked: defaults */ }
  document.documentElement.setAttribute("data-style", style);
  document.documentElement.setAttribute("data-theme", theme);
})();
