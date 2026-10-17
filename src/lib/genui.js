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
 */

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

/**
 * @param {string} code  the answer text as streamed (layout code)
 * @returns {{ markdown: string, cards: object[], followUp: object|null, cites: string[] }}
 */
export function readGenUi(code) {
  let text = String(code || "").replace(/\r\n/g, "\n");
  const cites = new Set();

  // 1. The form: its choices, then the code is replaced by a plain list.
  let followUp = null;
  const formRe = /<box\b[^>]*>\s*<radio-group\b[\s\S]*?<\/box>|<radio-group\b[\s\S]*?<\/radio-group>(?:[\s\S]*?<\/button>)?/g;
  text = text.replace(formRe, (block) => {
    const options = [...block.matchAll(/<radio\b[^>]*>([\s\S]*?)<\/radio>/g)].map((m) => plain(m[1])).filter(Boolean);
    const checks = [...block.matchAll(/<checkbox\b([^>]*)>([\s\S]*?)<\/checkbox>/g)].map((m) => ({ label: plain(m[2]), checked: /checked=\{?(?:true|newOnly|[a-z]\w*)\}?/i.test(m[1]) }));
    const button = (new RegExp(String.raw`<button\b${TAG_BODY}>([\s\S]*?)<\/button>`).exec(block) || [])[1];
    const send = (/issueNewTurn\(\s*"([^"]*)/.exec(block) || [])[1] || "";
    if (!followUp) followUp = { options, checks: checks.map((c) => c.label), button: button ? plain(button) : "", sends: send.trim() };
    return "\n\n" + [
      ...options.map((o) => `- ○ ${o}`),
      ...checks.map((c) => `- ☐ ${c.label}`),
      button ? `\n[${plain(button)}]` : "",
    ].filter(Boolean).join("\n") + "\n\n";
  });
  // Form state lines: `{@body const [x,setX] = DIL.useState(…)}`.
  text = text.replace(/^\s*\{@[^\n]*\}\s*$/gm, "");

  // 2. The cards, read before the tags go: one per <row> that has a title.
  const cards = [];
  for (const m of text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = m[1];
    const titleTag = /<title\b[^>]*size="lg"[^>]*>([\s\S]*?)<\/title>/.exec(row) || /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(row);
    if (!titleTag) continue;
    const entity = /<Entity\b([^>]*)\/>/.exec(titleTag[1]);
    const name = entity ? (attr(entity[1], "value") || plain(titleTag[1])) : plain(titleTag[1]).replace(/^\d+\.\s*/, "");
    const ref = entity ? (refsOf(attr(entity[1], "ref") || "")[0] || null) : null;
    const md = /<title\b[^>]*size="md"[^>]*>([\s\S]*?)<\/title>/.exec(row);
    const price = md ? plain(md[1]) : "";
    const sub = /<text\b[^>]*size="sm"[^>]*>([\s\S]*?)<\/text>/.exec(row);
    const bullets = [...row.matchAll(/^\s*-\s+(.+)$/gm)].map((b) => plain(b[1]));
    const cardCites = [...row.matchAll(/<Cite\b[^>]*\/>/g)].flatMap((c) => refsOf(c[0]));
    cards.push({ n: cards.length + 1, name: plain(name), ref, price, subtitle: sub ? plain(sub[1]) : "", bullets, cites: [...new Set(cardCites)], image: /<AsyncImage\b/.test(row) });
  }

  // 3. The text, tag by tag.
  text = text
    .replace(/<Cite\b[^>]*\/>/g, (t) => {
      const ids = refsOf(t);
      ids.forEach((id) => cites.add(id));
      return ids.length ? `${PUA_OPEN}cite${ids.map((id) => PUA_MID + id).join("")}${PUA_CLOSE}` : "";
    })
    .replace(/<Entity\b[^>]*?value="([^"]*)"[^>]*\/>/g, "$1")
    .replace(/<AsyncImage\b[^>]*\/>/g, "")
    .replace(/<title\b[^>]*size="lg"[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n\n### ${t.trim()}\n`)
    .replace(/<title\b[^>]*size="md"[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n**${t.trim()}**\n`)
    .replace(/<title\b[^>]*>([\s\S]*?)<\/title>/g, (_, t) => `\n\n#### ${t.trim()}\n`)
    .replace(/<text\b[^>]*>([\s\S]*?)<\/text>/g, (_, t) => `\n${t.trim()}\n`)
    .replace(/<divider\b[^>]*\/?>/g, "\n")
    .replace(new RegExp(String.raw`<\/?[A-Za-z][\w-]*\b${TAG_BODY}>`, "g"), "\n");
  const markdown = text
    .split("\n").map((l) => l.trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, cards, followUp, cites: [...cites] };
}
