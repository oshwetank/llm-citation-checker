/*
 * deep.js — utilities for shape-based extraction.
 *
 * Adapters try known key-paths first, then fall back to these deep walks when a
 * path misses (because the provider reorganized its payload). Shape-based search
 * is what makes an adapter survive field-location drift between store updates.
 */

// Walk every node in a nested object/array, calling visit(value, key, parent).
export function walk(root, visit, seen = new Set()) {
  if (root === null || typeof root !== "object") return;
  if (seen.has(root)) return;
  seen.add(root);
  const entries = Array.isArray(root)
    ? root.map((v, i) => [i, v])
    : Object.entries(root);
  for (const [key, value] of entries) {
    visit(value, key, root);
    if (value && typeof value === "object") walk(value, visit, seen);
  }
}

// Collect every value whose key matches keyRe (optionally passing a value test).
export function collectByKey(root, keyRe, valueTest) {
  const out = [];
  walk(root, (value, key) => {
    if (typeof key === "string" && keyRe.test(key)) {
      if (!valueTest || valueTest(value)) out.push(value);
    }
  });
  return out;
}

// Collect every object node that satisfies predicate(obj).
export function collectObjects(root, predicate) {
  const out = [];
  walk(root, (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && predicate(value)) {
      out.push(value);
    }
  });
  return out;
}

// First defined value along any of the given dot-paths (key-path fast path).
export function firstPath(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const part of path.split(".")) {
      if (cur && typeof cur === "object" && part in cur) cur = cur[part];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined) return cur;
  }
  return undefined;
}

export function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\//i.test(v);
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}
