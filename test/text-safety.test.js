import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeControlCharacters, redactSecrets, sanitizeForDisplay } from "../src/core/text-safety.js";

test("approval text cannot hide itself with control characters", () => {
  const spoofed = "git push\r\u001b[2Krm -rf /\u0007";
  const escaped = escapeControlCharacters(spoofed);
  assert.equal(escaped, "git push\\r\\u{001b}[2Krm -rf /\\u{0007}");
  assert.doesNotMatch(escaped, /[\u0000-\u001f]/);
  assert.equal(escapeControlCharacters("plain --flag value"), "plain --flag value");
});

test("display sanitizing reports truncation instead of hiding it", () => {
  const short = sanitizeForDisplay("deploy --now", { maxLength: 64 });
  assert.deepEqual(short, { text: "deploy --now", truncated: false });
  const long = sanitizeForDisplay("x".repeat(100), { maxLength: 10 });
  assert.equal(long.text.length, 10);
  assert.equal(long.truncated, true);
  assert.throws(() => sanitizeForDisplay("value", { maxLength: 0 }), /positive integer/);
});

test("optional redaction masks credential-looking values only", () => {
  assert.equal(redactSecrets("API_TOKEN=abc deploy"), "API_TOKEN=[redacted] deploy");
  assert.equal(redactSecrets("curl https://user:pw@example.test/x"), "curl https://[redacted]@example.test/x");
  assert.equal(redactSecrets("npm test -- --watch"), "npm test -- --watch");
});
