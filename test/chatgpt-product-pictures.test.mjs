/*
 * chatgpt-product-pictures.test.mjs — each product card shows its picture.
 *
 * The owner's "best phone in the world" answer (19 Nov 2026): five phones as
 * cards, five pictures under "Images shown", and every card an empty cart.
 * The products came from the answer's data bindings (no picture) and the
 * pictures from its image components, titled with each product's name.
 * The signed-out fixture has the same shape: 4 products, 4 pictures, and
 * none of the products had one.
 */
import { readFileSync } from "node:fs";
import { adapt } from "../src/adapters/chatgpt.js";
import { imageShowsProduct, pictureProducts } from "../src/lib/productImages.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

console.log("\nthe signed-out card answer (fixture)");
{
  const raw = readFileSync(new URL("./fixtures/chatgpt-signed-out-dil.txt", import.meta.url), "utf8");
  const r = await adapt({ captureId: "t", raw, reqBody: null, url: "https://chatgpt.com/unauth-mweb/conversation/updates", pageUrl: "https://chatgpt.com/", capturedAt: Date.now() });
  check("it has product cards and pictures", r.products.length >= 4 && r.images.length >= 4, `${r.products.length} products, ${r.images.length} images`);
  check("every card has its picture", r.products.every((p) => p.image), r.products.filter((p) => !p.image).map((p) => p.name).join(" | "));
  const ok = r.products.every((p) => { const im = r.images.find((x) => x.url === p.image); return im && imageShowsProduct(p.name, im.title); });
  check("each picture is the one titled with that card's name", ok);
  check("no picture used twice", new Set(r.products.map((p) => p.image)).size === r.products.length);
}

console.log("\nmatching a picture to a product");
check("the same product, a longer title", imageShowsProduct("Samsung Galaxy S26 Ultra", "Samsung Galaxy S26 Ultra 5G (Titanium Black, 256 GB)"));
check("the maker left out of the title", imageShowsProduct("Apple iPhone 18 Pro Max", "iPhone 18 Pro Max 256GB Cosmic Orange"));
check("written together or apart", imageShowsProduct("OnePlus 15", "OnePlus15 5G"));
check("not another model", !imageShowsProduct("OnePlus 15", "OnePlus 15 Pro"));
check("not another phone", !imageShowsProduct("Vivo X300 Ultra", "OPPO Find X10 Pro Max"));
check("a one-word name is not matched", !imageShowsProduct("Pixel", "Google Pixel 11 Pro"));

console.log("\npictureProducts");
{
  const products = [{ name: "Samsung Galaxy S26 Ultra", image: null }, { name: "Apple iPhone 18 Pro Max", image: null }, { name: "Kept", image: "https://a.example/k.jpg" }, { name: "Nothing Phone 4", image: null }];
  const images = [{ url: "https://img.example/2.jpg", title: "iPhone 18 Pro Max" }, { url: "https://img.example/1.jpg", title: "Samsung Galaxy S26 Ultra 5G" }];
  const out = pictureProducts(products, images);
  check("matched by name, not by order", out[0].image === "https://img.example/1.jpg" && out[1].image === "https://img.example/2.jpg", JSON.stringify(out.map((p) => p.image)));
  check("a card's own picture is kept", out[2].image === "https://a.example/k.jpg");
  check("no picture for a card none names", out[3].image === null);
  check("the input is not changed", products[0].image === null);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
