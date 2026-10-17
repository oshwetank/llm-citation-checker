/*
 * ChatGPT generative-UI answers (0.60.1).
 * Run: node test/chatgpt-genui.test.mjs
 *
 * Since October 2026 some ChatGPT answers stream as layout code (<row>,
 * <Entity>, <Cite>, <AsyncImage>, a follow-up form) and every text chunk is
 * sent twice: to the physical message and, with its "c" index, to the logical
 * answer. A real "best camera phone" answer came out with every chunk
 * doubled, no intro, the tags printed as text, 0 pages cited, 1 product of 3,
 * 1 image of 3, "Around"/"Triple"/"Edge" as brands and a News chip with no
 * news on screen. The fixture is made up (brands Zento, Kovo, Lumora) with
 * the same stream shapes.
 */
import { adapt } from "../src/adapters/chatgpt.js";
import { isGenUi, readGenUi } from "../src/lib/genui.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "chatgpt-genui-cards.txt");
const lines = readFileSync(FIX, "utf8").split(/\r?\n/);
const reqBody = (lines.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", "");
const raw = lines.filter((l) => !l.startsWith("# ")).join("\n");
const r = await adapt({ captureId: "genui", raw, reqBody, capturedAt: Date.now() });

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
}

const text = r.answerText || "";
console.log("answer text");
const intro = "If you want the best camera under";
check("the intro is there", text.includes(intro), JSON.stringify(text.slice(0, 120)));
check("the intro appears once", text.split(intro).length === 2);
check("each card title appears once", ["Zento Nova 8", "Kovo Edge 5 Pro", "Lumora Pix 3"].every((n) => text.split(`. ${n}`).length === 2), JSON.stringify(text.slice(0, 400)));
check("no layout code left", !/<\/?(?:row|box|title|text|Entity|Cite|AsyncImage|radio|checkbox|button|divider)\b/.test(text) && !/\{@body/.test(text), JSON.stringify(text.match(/<[^>]{0,40}>/)));
check("cards read as headings in order", /### 1\. Zento Nova 8[\s\S]*### 2\. Kovo Edge 5 Pro[\s\S]*### 3\. Lumora Pix 3/.test(text));
check("the follow-up form reads as its choices", text.includes("- ● Mostly photos") && text.includes("- ○ Mostly video") && text.includes("[Find my best camera phone]"));
check("cites become cite markers", /citeturn7search0/.test(text));

console.log("citations");
const cited = r.sources.filter((s) => s.outcome === "cited").map((s) => s.url).sort();
check("the two cited pages count as cited", JSON.stringify(cited) === JSON.stringify([
  "https://mobilelab.example/lumora-pix-3-review",
  "https://phonereview.example/best-camera-phones-30000",
]), JSON.stringify(cited));
check("a page read but not cited stays read", r.sources.some((s) => s.url === "https://mobilelab.example/kovo-edge-5-pro-review" && s.outcome === "fetched"));
check("no News chip: the news result wasn't cited", r.carousels && r.carousels.news === false, JSON.stringify(r.carousels));

console.log("products and images");
const names = r.products.map((p) => p.name);
check("all three cards are products, in the answer's order", JSON.stringify(names) === JSON.stringify(["Zento Nova 8", "Kovo Edge 5 Pro", "Lumora Pix 3"]), JSON.stringify(names));
const kovo = r.products.find((p) => p.name === "Kovo Edge 5 Pro") || {};
check("the card tied to a listing keeps the listing's store and rating", kovo.merchant === "Kovo Store + others" && kovo.rating === 4.4, JSON.stringify(kovo));
const zento = r.products.find((p) => p.name === "Zento Nova 8") || {};
check("a card without a listing keeps its price and says so", zento.price === "Around ₹27,999" && zento.listing === false && zento.renderAs === "answer-card", JSON.stringify(zento));
check("every card has its picture", r.products.every((p) => p.image));
const answerPics = (r.images || []).filter((i) => /static-rsc-4\/0a1b2c3d-/.test(i.url));
check("one picture per card, not every picture ChatGPT loaded", answerPics.length === 3, JSON.stringify((r.images || []).map((i) => i.url)));

console.log("brands");
const brandNames = (r.entities || r.brands || []).map((b) => b.text || b.name || b);
for (const bad of ["Around", "Triple", "Single", "Edge"]) check(`"${bad}" is not a brand`, !brandNames.includes(bad), JSON.stringify(brandNames));
check("Zento and Lumora are brands", brandNames.includes("Zento") && brandNames.includes("Lumora"), JSON.stringify(brandNames));

console.log("follow-up");
const fu = r.platformSpecific && r.platformSpecific.followUp;
check("the follow-up form's options are kept", fu && JSON.stringify(fu.options) === JSON.stringify(["Mostly photos", "Mostly video"]) && fu.button === "Find my best camera phone", JSON.stringify(fu));

// The second layout (0.60.2), from a "best foldable phone" answer: the product
// is a bold Entity line, the large title is a spec ("Snapdragon 8 Gen 5"), a
// badge sits on top, the price is in a grey note, and the form has two
// questions with ChatGPT's own defaults selected. 0.60.1 named every card
// after its spec, merged the two questions into one list and lost the
// defaults. Made-up fixture (Zento, Kovo, Lumora tablets), same shapes.
console.log("entity-line cards");
{
  const L = readFileSync(join(dirname(FIX), "chatgpt-genui-entity-cards.txt"), "utf8").split(/\r?\n/);
  const r2 = await adapt({
    captureId: "genui2",
    raw: L.filter((l) => !l.startsWith("# ")).join("\n"),
    reqBody: (L.find((l) => l.startsWith("# reqBody:")) || "").replace("# reqBody: ", ""),
    capturedAt: Date.now(),
  });
  const t2 = r2.answerText || "";
  const names2 = r2.products.map((p) => p.name);
  check("cards are named by their product, not their spec", JSON.stringify(names2) === JSON.stringify(["Zento Slate Pro", "Kovo Edge 5 Pro", "Lumora Tab 3"]), JSON.stringify(names2));
  check("the spec is the card's headline", r2.products[0].headline === "Octa X9 chip · 12GB RAM", JSON.stringify(r2.products[0]));
  check("the badge is kept", r2.products[0].badge === "Best for raw power" && r2.products[2].badge === "Best value");
  check("a price in a note is found", r2.products[0].price === "₹89,999", r2.products[0].price);
  check("each question keeps its own heading", /\*\*Which matters more\?\*\*\n\n- ○ Pen feel\n- ● Both equally/.test(t2), JSON.stringify(t2.slice(-220)));
  check("ChatGPT's selected choices are marked", t2.includes("- ● ₹50,000–₹1,00,000") && t2.includes("- ○ Under ₹50,000"));
  check("a cited news story is not a news carousel", r2.carousels && r2.carousels.news === false && r2.sources.some((s) => s.outcome === "cited" && /news/.test(s.url)), JSON.stringify(r2.carousels));
  check("no layout code left", !/<\/?(?:row|box|title|text|badge|Entity|Cite|AsyncImage|radio|button|divider)\b/.test(t2) && !/\{@body/.test(t2));
  const fu2 = r2.platformSpecific.followUp;
  check("the form's groups and button", fu2 && (fu2.groups || []).length === 2 && fu2.groups[1].selected === "Both equally" && fu2.button === "Find my tablet", JSON.stringify(fu2));
  const blocks = r2.platformSpecific.genUiBlocks || [];
  const kinds = blocks.map((b) => b.type).join(",");
  check("the answer is kept in order as text, cards and a form", kinds === "md,card,card,card,md,form", kinds);
  const c1 = blocks.find((b) => b.type === "card");
  check("a card block keeps its parts in order", c1 && c1.parts.map((p) => p.kind).join(",") === "badge,name,title,md,text", JSON.stringify(c1 && c1.parts));
  check("a card block carries its own picture", c1 && c1.image && /static-rsc-4\/0a1b2c3d-.*a001-1/.test(c1.image.url), JSON.stringify(c1 && c1.image));
}

console.log("genui.js");
check("plain markdown is not layout code", !isGenUi("**Best pick:** a phone. - one\n- two"));
const tiny = readGenUi('<title size="lg">1. <Entity value="Acme One"/></title>\n<button onClick={() => GenUI.issueNewTurn("go")}>Go</button>');
check("a button with an arrow function parses", !/onClick|=>|<\/?button/.test(tiny.markdown), JSON.stringify(tiny.markdown));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
