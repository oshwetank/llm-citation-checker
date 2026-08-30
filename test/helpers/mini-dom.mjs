/*
 * mini-dom.mjs — a tiny, dependency-free HTML parser for tests.
 *
 * This project ships zero runtime dependencies and there is no DOM in Node,
 * so testing anything that reads real captured markup (the DOM harvester,
 * domToMarkdown, citation extraction) previously meant hand-building node
 * trees — which quietly tests your own idea of the markup rather than the
 * markup itself. That is precisely the failure mode this codebase keeps
 * hitting: three separate Perplexity selectors were written against guessed
 * structure and matched nothing on the live page.
 *
 * So this parses the REAL captured HTML in test/fixtures/ into just enough
 * of a DOM for the harvester code to run against. Pulling in jsdom would
 * work too, but it is a very large dependency for a project whose whole
 * pitch is a small local extension, and it would be the only one.
 *
 * Supports what real captured answer markup actually contains: elements,
 * quoted attributes, text, comments, void elements, and the few entities
 * that show up. Deliberately NOT a spec-compliant parser — it is for
 * fixtures we control, and it throws rather than guessing on malformed
 * input so a bad fixture fails loudly instead of silently testing nothing.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

const decode = (s) =>
  String(s).replace(/&(#?\w+);/g, (m, e) => (ENTITIES[e] !== undefined ? ENTITIES[e] : m));

function makeEl(tagName, attrs) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs,
    childNodes: [],
    parentNode: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name);
    },
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1);
    },
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
    },
    get innerText() {
      return this.textContent;
    },
    querySelectorAll(sel) {
      const out = [];
      const match = matcherFor(sel);
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
  };
  return node;
}

// Selector support is intentionally narrow: comma lists of simple compound
// selectors (tag, .class, [attr], [attr="v"], [attr*="v"], [attr^="v"]).
// That covers every selector the harvester actually uses. Anything else
// throws, so an unsupported selector in a test is visible immediately
// instead of silently matching nothing (which would read as a passing test).
function matcherFor(selector) {
  const groups = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
  const compiled = groups.map((g) => {
    if (/[ >+~]/.test(g)) throw new Error(`mini-dom: combinators not supported: ${g}`);
    const tests = [];
    let rest = g;
    const tag = rest.match(/^[a-zA-Z][\w-]*/);
    if (tag) {
      const want = tag[0].toUpperCase();
      tests.push((el) => el.tagName === want);
      rest = rest.slice(tag[0].length);
    }
    const token = /\.([\w-]+)|\[([\w-]+)(?:([*^$~|]?=)"([^"]*)")?\]/g;
    let m;
    let consumed = 0;
    while ((m = token.exec(rest))) {
      consumed = token.lastIndex;
      if (m[1]) {
        const cls = m[1];
        tests.push((el) => (el.getAttribute("class") || "").split(/\s+/).includes(cls));
      } else {
        const name = m[2], op = m[3], val = m[4];
        if (!op) tests.push((el) => el.hasAttribute(name));
        else if (op === "=") tests.push((el) => el.getAttribute(name) === val);
        else if (op === "*=") tests.push((el) => (el.getAttribute(name) || "").includes(val));
        else if (op === "^=") tests.push((el) => (el.getAttribute(name) || "").startsWith(val));
        else if (op === "$=") tests.push((el) => (el.getAttribute(name) || "").endsWith(val));
        else throw new Error(`mini-dom: unsupported attribute operator ${op}`);
      }
    }
    if (consumed !== rest.length) throw new Error(`mini-dom: unsupported selector: ${g}`);
    return (el) => tests.every((t) => t(el));
  });
  return (el) => compiled.some((fn) => fn(el));
}

export function parseHTML(html) {
  const root = makeEl("root", {});
  const stack = [root];
  let i = 0;
  const src = String(html);

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      const text = src.slice(i);
      if (text.trim()) stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: decode(text) });
      break;
    }
    if (lt > i) {
      const text = src.slice(i, lt);
      if (text.trim()) stack[stack.length - 1].childNodes.push({ nodeType: 3, nodeValue: decode(text) });
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt === -1) throw new Error("mini-dom: unterminated tag");
    const raw = src.slice(lt + 1, gt).trim();

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toUpperCase();
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].tagName === name) { stack.length = d; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^([a-zA-Z][\w-]*)/);
    if (!nameMatch) throw new Error(`mini-dom: bad tag: ${raw.slice(0, 40)}`);
    const tagName = nameMatch[1];

    const attrs = {};
    const attrRe = /([:\w-]+)(?:\s*=\s*"([^"]*)")?/g;
    attrRe.lastIndex = nameMatch[1].length;
    let a;
    while ((a = attrRe.exec(body))) attrs[a[1]] = a[2] === undefined ? "" : decode(a[2]);

    const el = makeEl(tagName, attrs);
    el.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].childNodes.push(el);
    if (!selfClosing && !VOID.has(tagName.toLowerCase())) stack.push(el);
    i = gt + 1;
  }
  return root;
}
