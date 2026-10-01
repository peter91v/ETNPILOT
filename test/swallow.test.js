import assert from "node:assert/strict";
import test from "node:test";
import { swallow } from "../src/runtime/swallow.js";

test("swallowing carries on with the fallback and leaves a trace only when asked", async () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (text) => { written.push(String(text)); return true; };
  try {
    delete process.env.ETNPILOT_DEBUG;
    assert.deepEqual(await Promise.reject(new Error("quiet")).catch(swallow("here", () => ({ items: [] }))), { items: [] });
    assert.deepEqual(written, []);
    process.env.ETNPILOT_DEBUG = "1";
    assert.equal(await Promise.reject(Object.assign(new Error("loud"), { code: "EACCES" })).catch(swallow("reading x", undefined)), undefined);
    assert.match(written.join(""), /\[etnpilot debug\] reading x: EACCES: loud/);
  } finally {
    delete process.env.ETNPILOT_DEBUG;
    process.stderr.write = original;
  }
});
