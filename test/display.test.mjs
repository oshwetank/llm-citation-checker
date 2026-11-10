/*
 * display.test.mjs — the rules behind Settings → Display (0.63.0):
 * ui/display-boot.js, run here the way panel.html runs it (a plain script
 * that publishes globalThis.CitoDisplay). On 0.64.0 the file doesn't exist.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A document with just what apply() touches.
function fakeDoc() {
  const nodes = {};
  const el = (tag) => ({ tag, attrs: {}, style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } }, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { c.parentNode = this; if (c.id) nodes[c.id] = c; return c; }, removeChild(c) { c.parentNode = null; delete nodes[c.id]; } });
  const root = el("html"), head = el("head");
  return { documentElement: root, head, createElement: el, getElementById: (id) => nodes[id] || null };
}
const store = (v) => ({ getItem: () => v });

const src = readFileSync(new URL("../ui/display-boot.js", import.meta.url), "utf8");
const sandbox = { globalThis: null };
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox);
const CD = sandbox.CitoDisplay;
check("the boot script publishes its rules", !!CD && typeof CD.apply === "function");

console.log("\nwhat is stored is made safe");
eq("nothing stored gives the defaults", CD.read(store(null)), CD.DEFAULTS);
eq("garbage gives the defaults", CD.read(store("{not json")), CD.DEFAULTS);
const n = CD.normalize({ font: "nope", size: 999, brightness: 10, contrast: "112", leading: 101, density: "huge", mono: "jetbrains-mono" });
eq("unknown font falls back, numbers clamp to range and step", [n.font, n.size, n.brightness, n.contrast, n.leading, n.density, n.mono], ["geist", 130, 80, 110, 100, "comfortable", "jetbrains-mono"]);
eq("a Google family needs a plain name", [CD.normalize({ font: "google", gfont: "Poppins" }).font, CD.normalize({ font: "google", gfont: "x\"} body{" }).font], ["google", "geist"]);
check("defaults are recognised as defaults", CD.isDefault({}) && !CD.isDefault({ size: 110 }));

console.log("\nthe Google Fonts address");
eq("family with weights", CD.googleUrl("Playfair Display", "400;500;700"), "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;700&display=swap");
eq("family with one weight", CD.googleUrl("Lobster", ""), "https://fonts.googleapis.com/css2?family=Lobster&display=swap");

console.log("\napplied to a page");
{
  const d = fakeDoc();
  CD.apply(d, { font: "inter", size: 115, brightness: 95, contrast: 100, leading: 120, density: "compact", mono: "ibm-plex-mono" });
  const v = d.documentElement.style.vars, a = d.documentElement.attrs;
  check("the typeface leads the sans stack, with the Devanagari fallback after it", /^"Inter", "IBM Plex Sans Devanagari"/.test(v["--font-sans"]), v["--font-sans"]);
  check("the code font leads the mono stack", /^"IBM Plex Mono"/.test(v["--font-mono"]), v["--font-mono"]);
  eq("size, brightness, contrast and spacing as factors", [v["--ui-zoom"], v["--ui-bright"], v["--ui-contrast"], v["--ui-leading"]], ["1.15", "0.95", "1", "1.2"]);
  eq("density as an attribute; the filter flag only when one is off 100%", [a["data-density"], "data-display-filter" in a], ["compact", true]);
  check("a bundled face adds no link", !d.getElementById("cito-gfont"));
  CD.apply(d, { font: "google", gfont: "Poppins", gweights: "400;600" });
  const link = d.getElementById("cito-gfont");
  check("a Google Font adds one stylesheet link", link && link.attrs.href === "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" && link.rel === "stylesheet", link && link.attrs.href);
  check("and no filter flag at 100%", !("data-display-filter" in d.documentElement.attrs));
  CD.apply(d, { font: "lora" });
  check("going back to a bundled face removes the link", !d.getElementById("cito-gfont"));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
