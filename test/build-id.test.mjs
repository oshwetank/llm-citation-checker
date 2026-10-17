/*
 * build-id.test.mjs — the build compiled into the code matches the manifest.
 *
 * src/lib/build.js is how the panel detects a half-updated install (new
 * screens over an old background script — see that file's header). It only
 * works if it's bumped with every release; a stale BUILD would make every
 * healthy install look broken. This keeps the two from drifting apart, the
 * same way the version badge once drifted from manifest.json.
 */
import { readFileSync } from "node:fs";
import { BUILD } from "../src/lib/build.js";

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${detail}` : ""}`); }
};

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const bg = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const panel = readFileSync(new URL("../ui/panel.js", import.meta.url), "utf8");

console.log("\nbuild-id: the build in the code is the build in the manifest");
check("BUILD equals manifest.json's version", BUILD === manifest.version, `BUILD=${BUILD} manifest=${manifest.version}`);
check("the background imports it for itself", /import \{ BUILD \} from "\.\/lib\/build\.js"/.test(bg));
check("the background answers with it", /case "build-info"/.test(bg));
check("the panel imports it for itself", /import \{ BUILD \} from "\.\.\/src\/lib\/build\.js"/.test(panel));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
