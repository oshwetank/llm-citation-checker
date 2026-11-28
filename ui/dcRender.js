/*
 * dcRender.js — draws a template like ui/campaignDashTemplate.js (1.0.6).
 *
 * The campaign dashboard's markup was designed and checked on the design
 * canvas; rather than rewrite it as el() calls, this draws the same markup:
 *   {{a.b}}                  a value, looked up from the innermost loop out
 *   <sc-for list as>          repeats its children for each item ($index too)
 *   <sc-if value>             keeps its children when the value is true
 *   onClick="{{fn}}"          an event handler (click, change, mouseenter…)
 * Values only ever become text or attribute values (textContent and
 * setAttribute), never HTML, so a page title or an answer's text can't
 * inject markup. The template itself is parsed once with DOMParser.
 */
const HOLE = /\{\{\s*([\w$.]+)\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*([\w$.]+)\s*\}\}\s*$/;
const cache = new Map();

function compile(tpl) {
  if (!cache.has(tpl)) {
    const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${tpl}</body></html>`, "text/html");
    cache.set(tpl, doc.body);
  }
  return cache.get(tpl);
}

function lookup(scope, path) {
  if (path === "true") return true;
  if (path === "false") return false;
  const parts = path.split(".");
  for (let i = scope.length - 1; i >= 0; i--) {
    const s = scope[i];
    if (s && typeof s === "object" && Object.prototype.hasOwnProperty.call(s, parts[0])) {
      let v = s[parts[0]];
      for (let k = 1; k < parts.length && v != null; k++) v = v[parts[k]];
      return v;
    }
  }
  return undefined;
}
const text = (v) => (v == null || v === false ? "" : String(v));
const fill = (str, scope) => str.replace(HOLE, (_, p) => text(lookup(scope, p)));

function setAttr(el, name, raw, scope) {
  if (name.startsWith("hint-")) return;
  const whole = raw.match(WHOLE);
  if (name.startsWith("on") && whole) {
    const fn = lookup(scope, whole[1]);
    if (typeof fn === "function") el.addEventListener(name.slice(2), fn);
    return;
  }
  if (!whole) { el.setAttribute(name, fill(raw, scope)); return; }
  const v = lookup(scope, whole[1]);
  if (name === "value" && "value" in el) { el.value = text(v); return; }
  if (name.startsWith("aria-")) { if (v != null) el.setAttribute(name, String(v)); return; }
  if (v == null || v === false) return;
  el.setAttribute(name, v === true ? "" : String(v));
}

function draw(node, scope, out) {
  if (node.nodeType === 3) {
    const t = node.nodeValue;
    out.appendChild(document.createTextNode(t.includes("{{") ? fill(t, scope) : t));
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.localName;
  if (tag === "sc-for") {
    const m = (node.getAttribute("list") || "").match(WHOLE);
    const list = m ? lookup(scope, m[1]) : null;
    const as = node.getAttribute("as") || "item";
    if (Array.isArray(list)) list.forEach((item, i) => { const frame = { [as]: item, $index: i }; for (const c of node.childNodes) draw(c, scope.concat([frame]), out); });
    return;
  }
  if (tag === "sc-if") {
    const m = (node.getAttribute("value") || "").match(WHOLE);
    if (m && lookup(scope, m[1])) for (const c of node.childNodes) draw(c, scope, out);
    return;
  }
  const el = document.createElementNS(node.namespaceURI, node.nodeName.includes(":") ? node.nodeName : tag);
  for (const a of node.attributes) setAttr(el, a.name, a.value, scope);
  for (const c of node.childNodes) draw(c, scope, el);
  out.appendChild(el);
}

/** The template drawn with these values, as a fragment ready to insert. */
export function renderTemplate(tpl, vals) {
  const frag = document.createDocumentFragment();
  for (const c of compile(tpl).childNodes) draw(c, [vals], frag);
  return frag;
}
