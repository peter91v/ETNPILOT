import assert from "node:assert/strict";
import { test } from "node:test";
import { knownPriceFor } from "../src/observability/known-pricing.js";

// Neither Anthropic nor OpenAI publishes prices through an API, so this table
// is the one place a number can come from without a live source — and it has
// to say so, not look like a measurement.

test("a known Anthropic rate carries where it came from and when", () => {
  const rate = knownPriceFor("anthropic", "claude-opus-5");
  assert.equal(rate.inputPerMillion, 5);
  assert.equal(rate.outputPerMillion, 25);
  assert.match(rate.source, /^https:\/\/www\.anthropic\.com/);
  assert.match(rate.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test("a dated snapshot prices the same as the undated name", () => {
  const dated = knownPriceFor("anthropic", "claude-opus-5-2026-09-01");
  const undated = knownPriceFor("anthropic", "claude-opus-5");
  assert.deepEqual(dated, undated);
});

test("openai has no entries — a guess is worse than none, so none is shipped", () => {
  assert.equal(knownPriceFor("openai-compatible", "gpt-5"), undefined);
  assert.equal(knownPriceFor("openai-compatible", "gpt-5-mini"), undefined);
});

test("a model this table was never updated for returns nothing, not a zero", () => {
  assert.equal(knownPriceFor("anthropic", "claude-nonexistent-9"), undefined);
});
