import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage } from "../src/runtime/usage-total.js";

test("usage is added up across the agents of a run", () => {
  let total;
  total = addUsage(total, { inputTokens: 100, outputTokens: 10, estimatedCost: 0.01, currency: "USD" });
  total = addUsage(total, { inputTokens: 50, outputTokens: 5, estimatedCost: 0.005, currency: "USD" });
  assert.equal(total.inputTokens, 150);
  assert.equal(total.outputTokens, 15);
  assert.ok(Math.abs(total.estimatedCost - 0.015) < 1e-9);
  assert.equal(total.agents, 2);
  assert.equal(total.unpriced, undefined);
});

test("an agent with no price makes the sum a floor, and nothing breaks without usage", () => {
  let total = addUsage(undefined, { inputTokens: 10, outputTokens: 1, estimatedCost: 0.1, currency: "USD" });
  total = addUsage(total, { inputTokens: 5, outputTokens: 1 });
  assert.equal(total.unpriced, true);
  assert.equal(addUsage(total, undefined), total);
  assert.equal(addUsage(undefined, undefined), undefined);
});
