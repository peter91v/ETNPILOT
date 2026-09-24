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

test("known OpenAI rates carry the cached-input discount, where the source separated it", () => {
  const rate = knownPriceFor("openai-compatible", "gpt-5.4");
  assert.equal(rate.inputPerMillion, 2.5);
  assert.equal(rate.cacheReadPerMillion, 0.25);
  assert.equal(rate.outputPerMillion, 15);
  assert.match(rate.source, /^https:\/\/platform\.openai\.com/);
  assert.equal(rate.asOf, "2026-09-24");
});

test("a dated OpenAI snapshot prices the same as the undated name", () => {
  assert.deepEqual(
    knownPriceFor("openai-compatible", "gpt-5.4-mini-2026-09-01"),
    knownPriceFor("openai-compatible", "gpt-5.4-mini"),
  );
});

test("a pricing-page display name with no confirmed API id is not guessed at", () => {
  // 'GPT-6 Astra', 'Daybreak Blue', etc. — this table has no entries for
  // them, on purpose: a marketing name is not the 'model' string the API
  // returns, and this table only prices ids it can stand behind.
  for (const guess of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "daybreak-blue", "daybreak-red"]) {
    assert.equal(knownPriceFor("openai-compatible", guess), undefined, guess);
  }
});
