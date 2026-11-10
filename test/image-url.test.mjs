/*
 * image-url.test.mjs — recovering the original image behind a ChatGPT
 * thumbnail. Product images in the Analyze tab were reported as blank boxes;
 * when the images.openai.com thumbnail will not load, the panel falls back to
 * the image the thumbnail encodes. The URLs here come from a real captured
 * response (test/fixtures/chatgpt-phone-which.txt).
 */
import { readFileSync } from "node:fs";
import { originalImageUrl } from "../src/lib/image-url.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const raw = readFileSync(new URL("./fixtures/chatgpt-phone-which.txt", import.meta.url), "utf8");
const thumbs = [...new Set(raw.match(/https:\/\/images\.openai\.com\/thumbnails\/url\/[A-Za-z0-9_-]+/g))];

console.log("\noriginalImageUrl: real ChatGPT thumbnails");
check("fixture has thumbnails to decode", thumbs.length >= 3, thumbs.length);
for (const t of thumbs.slice(0, 5)) {
  const out = await originalImageUrl(t);
  check(`decodes to an https image URL (${t.slice(42, 52)}…)`,
    typeof out === "string" && /^https:\/\/encrypted-tbn\d\.gstatic\.com\/shopping\?q=tbn:/.test(out), out);
}

console.log("\noriginalImageUrl: anything else is null, never a throw");
for (const bad of [
  "https://example.com/zentra-lite.png",
  "https://images.openai.com/thumbnails/url/zz",
  "https://images.openai.com/thumbnails/url/abcdAAAAAAAAAAAAAAAA",
  "",
  null,
]) {
  check(`null for ${JSON.stringify(bad)}`, (await originalImageUrl(bad)) === null);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nALL PASSED\n");
process.exit(failures ? 1 : 0);
