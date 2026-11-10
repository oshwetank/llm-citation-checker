/*
 * The text inside Gemini's WebChannel traffic (src/lib/protoStrings.js, 0.62.2).
 * Run: node test/proto-strings.test.mjs
 *
 * Reported: Gemini isn't captured. Its answer moved onto a Google WebChannel
 * (geminiweb-pa.clients6.google.com/v1/processSession) carrying protobuf:
 * the owner's HAR shows the prompt going up as base64 protobuf in
 * "req0___data__". Made-up messages here, encoded in the same wire format:
 * the strings must come back out, nested ones included, and noise must not.
 */
import { protoStrings, formStrings, webChannelFrames, channelStrings } from "../src/lib/protoStrings.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail}`); }
};

// A tiny protobuf encoder for the test.
const enc = new TextEncoder();
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const str = (field, s) => { const b = enc.encode(s); return [...varint(field * 8 + 2), ...varint(b.length), ...b]; };
const msg = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const num = (field, n) => [...varint(field * 8), ...varint(n)];
const b64 = (bytes) => Buffer.from(Uint8Array.from(bytes)).toString("base64");

console.log("protobuf strings");
{
  const prompt = msg(2, [...num(1, 1), ...msg(9, str(1, "best camera phone under 30000"))]);
  check("a prompt nested two levels down comes out", JSON.stringify(protoStrings(Uint8Array.from(prompt))) === JSON.stringify(["best camera phone under 30000"]), JSON.stringify(protoStrings(Uint8Array.from(prompt))));
  const many = [...str(1, "cf41b0e0dd7d53e5"), ...num(2, 7), ...msg(3, [...str(1, "Zento Nova 8 is the pick."), ...str(2, "https://phonereview.example/nova-8")])];
  check("answer text and addresses, in order", JSON.stringify(protoStrings(Uint8Array.from(many))) === JSON.stringify(["cf41b0e0dd7d53e5", "Zento Nova 8 is the pick.", "https://phonereview.example/nova-8"]), JSON.stringify(protoStrings(Uint8Array.from(many))));
  check("binary that isn't text is left out", protoStrings(Uint8Array.from([...msg(1, [0xff, 0xfe, 0x00, 0x01, 0x02])])).length === 0);
  check("truncated bytes don't throw", Array.isArray(protoStrings(Uint8Array.from(str(1, "hello world").slice(0, 5)))));
}

console.log("a WebChannel upload");
{
  const body = `count=1&ofs=1&req0___data__=${encodeURIComponent(b64(msg(2, [...num(1, 1), ...msg(9, str(1, "best 5star ac for home"))])))}`;
  check("the prompt out of the form field", JSON.stringify(formStrings(body)) === JSON.stringify(["best 5star ac for home"]), JSON.stringify(formStrings(body)));
  check("an acknowledgement upload has none", formStrings(`count=1&ofs=2&req0___data__=${encodeURIComponent(b64([0x22, 0x02, 0x08, 0x01]))}`).length === 0);
}

console.log("the down-channel");
{
  const f1 = JSON.stringify([[3, [b64([...str(1, "Zento Nova 8 is the pick for low light."), ...str(4, "https://phonereview.example/nova-8")])]]]);
  const f2 = JSON.stringify([[4, ["noop"]]]);
  const text = `${f1.length}\n${f1}${f2.length}\n${f2}`;
  check("frames are split by their lengths", webChannelFrames(text).length === 2);
  const got = channelStrings(text);
  check("strings come out of the base64 protobuf inside", got.includes("Zento Nova 8 is the pick for low light.") && got.includes("https://phonereview.example/nova-8"), JSON.stringify(got));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
