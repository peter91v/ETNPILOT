import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyEngine } from "../src/policy/engine.js";
import { parseDiff } from "../src/runtime/receipt-views.js";

// A small seeded generator: the same seed gives the same cases, so a failure
// can be replayed. Not a replacement for a real fuzzer, but it exercises the
// parsers with input nobody wrote by hand.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const pick = (next, list) => list[Math.floor(next() * list.length)];

const PIECES = ["..", ".", "a", "src", ".env", "%2e%2e", "%2f", "\\", "//", "~", "\u0000", "é", " ", "*", "?", "[", "{", "node_modules", ".git"];

function path(next) {
  const parts = [];
  for (let index = 0, count = 1 + Math.floor(next() * 6); index < count; index += 1) parts.push(pick(next, PIECES));
  return (next() < 0.2 ? "/" : "") + parts.join(pick(next, ["/", "/", "\\"]));
}

test("policy: random paths never throw and never let a read outside the workspace through", () => {
  const policy = new PolicyEngine({
    operations: { default: "deny", rules: [{ id: "read", effect: "allow", kinds: ["read"], paths: ["**"] }] },
  });
  const context = { agent: "a", workspace: "/workspace/project" };
  const next = random(20261001);
  for (let index = 0; index < 2000; index += 1) {
    const fileName = path(next);
    let decision;
    assert.doesNotThrow(() => { decision = policy.evaluateOperation({ kind: "read", fileName }, context); }, fileName);
    assert.ok(["approve-once", "human-required", "reject"].includes(decision.kind), `${fileName}: ${decision.kind}`);
    const segments = fileName.split("/"); // on POSIX a backslash is an ordinary character
    if (decision.kind === "approve-once" && escapes(segments)) {
      assert.fail(`'${fileName}' climbs out of the workspace but was allowed`);
    }
  }
});

test("policy: glob patterns made of odd characters never throw", () => {
  const next = random(7);
  for (let index = 0; index < 500; index += 1) {
    const pattern = Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(next, [...PIECES, "**", "*"])).join("");
    const policy = new PolicyEngine({ operations: { rules: [{ id: "r", effect: "deny", kinds: ["read"], paths: [pattern] }] } });
    assert.doesNotThrow(() => policy.evaluateOperation({ kind: "read", fileName: path(next) }, { agent: "a", workspace: "/w" }), pattern);
  }
});

test("parseDiff: any text yields consistent counts and never throws", () => {
  const next = random(99);
  const LINES = ["diff --git a/x b/x", "@@ -1,2 +3,4 @@", "@@ nonsense", "+added", "-deleted", " context", "\\ No newline at end of file", "", "+", "-", "--- a/x", "+++ b/x", "\u0000", "@@ -0,0 +1 @@"];
  for (let index = 0; index < 500; index += 1) {
    const text = Array.from({ length: Math.floor(next() * 40) }, () => pick(next, LINES)).join(next() < 0.5 ? "\n" : "\r\n");
    const result = parseDiff(text);
    assert.ok(result.added >= 0 && result.deleted >= 0 && result.hunks >= 0);
    assert.ok(result.lines.filter((line) => line.type === "add").length <= result.added || result.cut);
  }
  assert.doesNotThrow(() => parseDiff(undefined));
  assert.doesNotThrow(() => parseDiff("x".repeat(1_000_000)));
});

// Walks the segments the way a filesystem would; true when it ever goes above the start.
function escapes(segments) {
  let depth = 0;
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    depth += segment === ".." ? -1 : 1;
    if (depth < 0) return true;
  }
  return false;
}
