/*
 * deps.js — everything the handlers reach outside themselves, in one object
 * so the unit test (test/server-api.test.mjs) can swap each for a stub.
 */
import { promises as dns } from "node:dns";
import { randomInt, randomBytes, randomUUID } from "node:crypto";

export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  resolveMx: (domain) => dns.resolveMx(domain),
  env: process.env,
  now: () => Date.now(),
  randomInt,
  randomBytes,
  randomUUID,
};
