/*
 * genui.js — ChatGPT's generative-UI answers, read as an answer (0.60.1).
 *
 * Since October 2026 some ChatGPT answers arrive as layout code rather than
 * markdown: `<box>`, `<row>`, `<AsyncImage query=…/>`, `<title size="lg">1.
 * <Entity category="product" value="…"/></title>`, `<text …>`, `<Cite
 * refs={["turn…search0"]}/>`, and forms (`<radio-group>`, `<checkbox>`,
 * `<button onClick={() => GenUI.issueNewTurn(…)}>`) whose state lines start
 * `{@body …}`. ChatGPT draws it as cards; the extension printed it as text
 * (reported on a "best camera phone under 40000" answer: the PDF report was
 * pages of tags, three phones became one product card, and no page counted
 * as cited because the citations were inside the tags).
 *
 * This turns the code back into the answer people saw:
 *   - markdown text: headings for the card titles, the price in bold, the
 *     bullets, each `<Cite>` as the inline cite marker the rest of the
 *     extension already reads (so citations are numbered and linked as for
 *     any other answer), and the form as the list of choices it offered;
 *   - the cards, in order: name, price, subtitle, the product ref when the
 *     card is tied to a shopping listing, the cited refs in it;
 *   - the follow-up form: its choices, checkboxes and button;
 *   - every cited ref.
 * Tags it doesn't know are dropped and their text kept, so a new component
 * reads as its words rather than as code.
 *
 * 0.60.2: the layout differs from answer to answer, so nothing is read by
 * position. A "best foldable phone" answer put the product in a bold
 * `<Entity>` line and the chipset in the large title, so 0.60.1 named the
 * cards "Snapdragon 8 Gen 5". A card's name is now the Entity it carries
 * (else its large title); its price is whatever reads as a price; its badge,
 * titles and notes are kept in their order as parts, so the answer view can
 * draw the card as ChatGPT did. Forms keep each group's label and the choice
 * ChatGPT had selected (`DIL.useState("…")`). The result also has `blocks`:
 * the answer in order as text, cards and forms.
 */
import { PRICE_RE as MONEY_RE } from "./money.js";

const PUA_OPEN = "", PUA_MID = "", PUA_CLOSE = "";
// An opening tag's attributes can hold JSX expressions with ">" in them
// (`onClick={() => …}`), so a tag ends at the first ">" outside braces.
const TAG_BODY = String.raw`(?:[^>{]|\{[^}]*\})*`;

/** True when the text is ChatGPT layout code rather than plain markdown. */
export function isGenUi(text) {
  return typeof text === "string" && /<(?:box|row|Entity|Cite|AsyncImage|radio-group)\b/.test(text);
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|\\{([^}]*)\\})`).exec(tag);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
};
const refsOf = (s) => (String(s || "").match(/turn\d+[a-z]+\d+/g) || []);
const plain = (s) => String(s || "")
  .replace(/<Entity\b[^>]*?value="([^"]*)"[^>]*\/>/g, "$1")
  .replace(/<Cite\b[^>]*\/>/g, "")
  .replace(/<[^>]+>/g, "")
  .replace(/\s+/g, " ")
  .trim();

// "Shop: X", "Sold by X", "Available at X", "Buy at X", "Store: X".
const STORE_RE = /^(?:Shop|Store|Seller|Sold by|Available (?:at|on|from)|Buy (?:at|on|from)|From)\s*:?\s+(.{2,60})$/i;
// A text that is nothing but a price ("₹23,999", "$1,299.00", "From €45").
function isOnlyPrice(t) {
  const m = PRICE_RE.exec(String(t || "").trim());
  return !!m && String(t).trim().replace(m[0], "").replace(/[\s.,*()–-]/g, "").length === 0;
}
// Any currency, before or after the number (money.js, 0.69.0).
const PRICE_RE = new RegExp(`(?:(?:Around|About|Approx\\.?|From|Starting at|Under|Only)\\s+)?(?:${MONEY_RE.source})`, "u");
const ROW_ITEM_RE = new RegExp(
  String.raw`<AsyncImage\b${TAG_BODY}\/>` +
  String.raw`|<badge\b(${TAG_BODY})>([\s\S]*?)<\/badge>` +
  String.raw`|<title\b(${TAG_BODY})>([\s\S]*?)<\/title>` +
  String.raw`|<text\b(${TAG_BODY})>([\s\S]*?)<\/text>` +
  String.raw`|<\/?(?:box|row|stack|col|column|card|group)\b${TAG_BODY}>` +
  String.raw`|<divider\b${TAG_BODY}\/?>`,
  "g"
);

// Inline tags inside a line of text: a Cite becomes the cite marker the rest
// of the extension reads, an Entity its own words, anything else its text.
function inline(s, cites) {
  return String(s || "")
    .replace(/<Cite\b[^>]*\/>/g, (t) => {
      const ids = refsOf(t);
      ids.forEach((id) => cites.add(id));
      return ids.length ? `${PUA_OPEN}cite${ids.map((id) => PUA_MID + id).join("")}${PUA_CLOSE}` : "";
    })
    .replace(/<Entity\b[^>]*?value="([^"]*)"[^>]*\/>/g, "$1")
    .replace(new RegExp(String.raw`<\/?[A-Za-z][\w-]*\b${TAG_BODY}\/?>`, "g"), "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// `{@body const [budget,setBudget] = DIL.useState("₹1,00,000–₹1,50,000")}`
function readDefaults(text) {
  const out = {};
  for (const m of text.matchAll(/const\s*\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*DIL\.useState\(\s*("(?:[^"\\]|\\.)*"|true|false|-?[\d.]+)/g)) {
    try { out[m[1]] = JSON.parse(m[2]); } catch (_) { /* leave it out */ }
  }
  return out;
}

function readForm(block, defaults) {
  const groups = [], checks = [];
  let label = null, button = "";
  const re = new RegExp(
    String.raw`<(text|title)\b${TAG_BODY}>([\s\S]*?)<\/\1>` +
    String.raw`|<radio-group\b(${TAG_BODY})>([\s\S]*?)<\/radio-group>` +
    String.raw`|<checkbox\b(${TAG_BODY})>([\s\S]*?)<\/checkbox>` +
    String.raw`|<button\b${TAG_BODY}>([\s\S]*?)<\/button>`,
    "g"
  );
  for (const m of block.matchAll(re)) {
    if (m[1]) { label = plain(m[2]) || label; continue; }
    if (m[4] !== undefined) {
      const opts = [...m[4].matchAll(new RegExp(String.raw`<radio\b(${TAG_BODY})>([\s\S]*?)<\/radio>`, "g"))]
        .map((r) => ({ value: attr(r[1], "value"), label: plain(r[2]) })).filter((o) => o.label);
      const v = attr(m[3], "value");
      const want = v != null && Object.prototype.hasOwnProperty.call(defaults, v.trim()) ? defaults[v.trim()] : v;
      const sel = opts.find((o) => o.value === want || o.label === want);
      groups.push({ label, options: opts.map((o) => o.label), selected: sel ? sel.label : null });
      label = null;
      continue;
    }
    if (m[6] !== undefined) {
      const c = attr(m[5], "checked");
      const on = c == null ? false : c === "true" || (Object.prototype.hasOwnProperty.call(defaults, c.trim()) ? !!defaults[c.trim()] : false);
      checks.push({ label: plain(m[6]), checked: on });
      continue;
    }
    if (m[7] !== undefined) button = plain(m[7]);
  }
  // A button whose label sits outside a closing tag (`<button …>Go` then the
  // box closes) still has words after its opening tag.
  if (!button) {
    const b = new RegExp(String.raw`<button\b${TAG_BODY}>\s*([^<\n]+)`).exec(block);
    if (b) button = plain(b[1]);
  }
  const send = (/issueNewTurn\(\s*"([^"]*)/.exec(block) || [])[1] || "";
  return { groups, checks, button, sends: send.trim() };
}

function formMarkdown(f) {
  const out = [];
  f.groups.forEach((g) => {
    if (g.label) out.push(`**${g.label}**`, "");
    g.options.forEach((o) => out.push(`- ${o === g.selected ? "●" : "○"} ${o}`));
    out.push("");
  });
  f.checks.forEach((c) => out.push(`- ${c.checked ? "☑" : "☐"} ${c.label}`));
  if (f.button) out.push("", `[${f.button}]`);
  return out.join("\n").trim();
}

function readCard(row, n, cites) {
  const items = [];
  let last = 0, image = false, imageQuery = "";
  const free = (s) => s.split("\n").forEach((l) => { if (l.trim()) items.push({ kind: "line", raw: l.trim() }); });
  for (const m of row.matchAll(ROW_ITEM_RE)) {
    free(row.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith("<AsyncImage")) { image = true; if (!imageQuery) imageQuery = attr(m[0], "query") || ""; }
    else if (m[2] !== undefined) items.push({ kind: "badge", raw: m[2], tone: attr(m[1], "color") });
    else if (m[4] !== undefined) items.push({ kind: "title", raw: m[4], size: attr(m[3], "size") || "md" });
    else if (m[6] !== undefined) items.push({ kind: "text", raw: m[6], size: attr(m[5], "size"), tone: attr(m[5], "color") || attr(m[5], "tone") });
  }
  free(row.slice(last));
  // The name: the Entity the card carries, wherever it sits; else the large
  // title, numbering and all.
  let nameAt = items.findIndex((it) => /<Entity\b/.test(it.raw));
  let name = "", ref = null;
  if (nameAt >= 0) {
    const e = /<Entity\b([^>]*)\/>/.exec(items[nameAt].raw);
    name = attr(e[1], "value") || plain(items[nameAt].raw);
    ref = refsOf(attr(e[1], "ref") || "")[0] || null;
    // No name came through (its binding wasn't sent): what is left is only a
    // number and asterisks. The card's own image caption names the product
    // ("boAt Nirvana 751 ANC headphones"), a better name than "2.".
    if (!/[\p{L}\p{N}]{2,}/u.test(String(name).replace(/^[\s*\d.)-]+/, ""))) {
      const cap = String(imageQuery || "").replace(/\b(?:wireless |bluetooth )?(?:headphones?|earbuds?|earphones?|photo|image|product)\b\s*$/i, "").trim();
      if (cap) name = cap; else return null;
    }
  } else {
    // A title that is only a price is the price, not the name (0.69.0: a
    // saree answer put "1. Pure Katan Silk…" in the medium title and
    // "₹23,999" in the large one, and every card was named by its price).
    const onlyPrice = (it) => isOnlyPrice(plain(it.raw));
    nameAt = items.findIndex((it) => it.kind === "title" && it.size === "lg" && !onlyPrice(it));
    if (nameAt < 0) nameAt = items.findIndex((it) => it.kind === "title" && !onlyPrice(it));
    if (nameAt < 0) return null;
    name = plain(items[nameAt].raw).replace(/^\d+\.\s*/, "");
  }
  const parts = items.map((it, i) => {
    if (i === nameAt) {
      const shown = it.kind === "title" ? plain(it.raw) : name;
      return { kind: "name", text: shown };
    }
    const text = inline(it.raw, cites).replace(/^\*\*(.*)\*\*$/, "$1");
    if (it.kind === "badge") return { kind: "badge", text, tone: it.tone || null };
    if (it.kind === "title") return { kind: "title", text, size: it.size };
    if (it.kind === "text") return { kind: "text", text, size: it.size || null, tone: it.tone || null };
    return { kind: "md", text: inline(it.raw, cites) };
  }).filter((p) => p.text);
  const priceIn = (p) => (PRICE_RE.exec(plain(p.text.replace(/[\s\S]*?/g, ""))) || [])[0];
  const mdTitle = parts.find((p) => p.kind === "title" && p.size === "md" && priceIn(p));
  const price = mdTitle ? plain(mdTitle.text) : (parts.map(priceIn).find(Boolean) || "");
  const badge = (parts.find((p) => p.kind === "badge") || {}).text || "";
  const headline = (parts.find((p) => p.kind === "title" && p !== mdTitle && !isOnlyPrice(plain(p.text))) || {}).text || "";
  // The store, where the card names one ("Shop: …", "Sold by …", "Available at …").
  const shopLine = parts.map((p) => plain(p.text)).map((t) => STORE_RE.exec(t)).find(Boolean);
  const merchant = shopLine ? shopLine[1].trim().replace(/[.;,]+$/, "") : null;
  const sub = parts.find((p) => p.kind === "text" && p.size === "sm");
  const bullets = parts.filter((p) => p.kind === "md" && /^[-*]\s+/.test(p.text)).map((p) => plain(p.text.replace(/^[-*]\s+/, "").replace(/[\s\S]*?/g, "")));
  const cardCites = [...row.matchAll(/<Cite\b[^>]*\/>/g)].flatMap((c) => refsOf(c[0]));
  return {
    card: { n, name: plain(name), ref, price, badge, headline: plain(headline), subtitle: sub ? plain(sub.text) : "", bullets, cites: [...new Set(cardCites)], image, merchant },
    block: { type: "card", n, name: plain(name), ref, price, badge, image, parts },
  };
}

function cardMarkdown(b) {
  const out = [];
  b.parts.forEach((p) => {
    if (p.kind === "badge") out.push(`*${p.text}*`, "");
    else if (p.kind === "name") out.push(`### ${p.text}`, "");
    else if (p.kind === "title") out.push(`**${p.text}**`, "");
    else if (p.kind === "text") out.push(p.text, "");
    else if (/^[-*]\s+/.test(p.text)) out.push(p.text);
    else out.push(p.text, "");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textMarkdown(text, cites) {
  return text
    .replace(/<Cite\b[^>]*\/>/g, (t) => {
      const ids = refsOf(t);
      ids.forEach((id) => cites.add(id));
      return ids.length ? `${PUA_OPEN}cite${ids.map((id) => PUA_MID + id).join("")}${PUA_CLOSE}` : "";
    })
    .replace(/<Entity\b[^>]*?value="([^"]*)"[^>]*\/>/g, "$1")
    .replace(/<AsyncImage\b[^>]*\/>/g, "")
    .replace(/<badge\b[^>]*>([\s\S]*?)<\/badge>/g, (_, t) => `\n*${t.trim()}*\n`)
    .replace(/<title\b[^>]*size="lg"[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n\n### ${t.trim()}\n`)
    .replace(/<title\b[^>]*size="md"[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n**${t.trim()}**\n`)
    .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n\n#### ${t.trim()}\n`)
    .replace(/<text\b[^>]*>([\s\S]*?)<\/text>/g, (_, t) => `\n${t.trim()}\n`)
    .replace(/<divider\b[^>]*\/?>/g, "\n")
    .replace(new RegExp(String.raw`<\/?[A-Za-z][\w-]*\b${TAG_BODY}>`, "g"), "\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} code  the answer text as streamed (layout code)
 * @returns {{ markdown: string, blocks: object[], cards: object[], followUp: object|null, cites: string[] }}
 */
export function readGenUi(code, { bindings = {} } = {}) {
  // Values the layout binds by name ("{turn1product0.displayed_price}",
  // also "{turn1product0?.merchant}"), filled in from the turn's bindings;
  // one with no value is dropped rather than shown as code.
  // An attribute bound to a value ("value={turn1product13.title}") is written
  // back as a quoted attribute (1.0.0). Left as bare text, "Boat Nirvana 751"
  // broke the tag's own reading and a card's name came out empty: the owner's
  // headphones answer had headings "### **2. **", "### **3. **", "### **4. **"
  // and the products stored under those names.
  const boundAttr = (whole, name, id, field) => {
    if (!/^turn\w*\d/.test(id)) return whole;
    const v = bindings[id] && bindings[id][field];
    return `${name}="${typeof v === "string" || typeof v === "number" ? String(v).replace(/"/g, "'") : ""}"`;
  };
  let text = String(code || "").replace(/\r\n/g, "\n").replace(/\b([A-Za-z]\w*)=\{\s*([A-Za-z_]\w*)\??\.([A-Za-z_]\w*)\s*\}/g, boundAttr).replace(/\{\s*([A-Za-z_]\w*)\??\.([A-Za-z_]\w*)\s*\}/g, (whole, id, field) => {
    if (!/^turn\w*\d/.test(id)) return whole;
    const v = bindings[id] && bindings[id][field];
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  });
  const cites = new Set();
  const defaults = readDefaults(text);
  const held = [];
  const hold = (b) => `\u0001${held.push(b) - 1}\u0001`;

  // 1. Forms, then the state lines that feed them.
  let followUp = null;
  const formRe = /<box\b[^>]*>\s*<radio-group\b[\s\S]*?<\/box>|<radio-group\b[\s\S]*?<\/radio-group>(?:[\s\S]*?<\/button>)?/g;
  text = text.replace(formRe, (block) => {
    const f = readForm(block, defaults);
    if (!followUp) followUp = { options: f.groups.flatMap((g) => g.options), checks: f.checks.map((c) => c.label), button: f.button, sends: f.sends, groups: f.groups };
    return hold({ type: "form", ...f });
  });
  text = text.replace(/^\s*\{@[^\n]*\}\s*$/gm, "");

  // 2. Cards: each <row> with a name in it.
  const cards = [];
  text = text.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (whole, row) => {
    const c = readCard(row, cards.length + 1, cites);
    if (!c) return whole;
    cards.push(c.card);
    return hold(c.block);
  });

  // 3. What's left is text, between the cards and forms.
  const blocks = [];
  text.split(/\u0001(\d+)\u0001/).forEach((piece, i) => {
    if (i % 2) { blocks.push(held[Number(piece)]); return; }
    const md = textMarkdown(piece, cites);
    if (md) blocks.push({ type: "md", text: md });
  });
  const markdown = blocks.map((b) => (b.type === "md" ? b.text : b.type === "card" ? cardMarkdown(b) : formMarkdown(b))).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return { markdown, blocks, cards, followUp, cites: [...cites] };
}
