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

test("an id with no row on the page stays unpriced instead of borrowing a neighbour's rate", () => {
  for (const id of ["gpt-5", "gpt-6", "gpt-5.6", "gpt-5.3-codex-spark", "daybreak"]) {
    assert.equal(knownPriceFor("openai-compatible", id), undefined, id);
  }
});

test("the model a real run used is priced, from the row the page lists as Luna", () => {
  const rate = knownPriceFor("openai-compatible", "gpt-6-luna");
  assert.equal(rate.inputPerMillion, 0.2);
  assert.equal(rate.cacheReadPerMillion, 0.02);
  assert.equal(rate.outputPerMillion, 1.2);
});

test("every priced row of the pasted page is there, Spark (no rates) is not", () => {
  const price = (id) => knownPriceFor("openai-compatible", id);
  assert.equal(price("gpt-6-astra").outputPerMillion, 50);
  assert.equal(price("gpt-5.6-sol").inputPerMillion, 4);
  assert.equal(price("gpt-6-terra").outputPerMillion, 12);
  assert.equal(price("daybreak-red").outputPerMillion, 75);
  assert.equal(price("gpt-rosalind-research").cacheReadPerMillion, 0.5);
  assert.equal(price("gpt-6-astra-law").inputPerMillion, 12.5);
  assert.equal(price("gpt-5.3-codex-spark"), undefined);
});

test("telemetry prices a model from the table when the configuration names no rate", async () => {
  const { Telemetry } = await import("../src/observability/telemetry.js");
  const usage = { inputTokens: 7034, outputTokens: 1510 };
  const auto = new Telemetry({ enabled: false }).recordProviderUsage({ workflowRunId: "w", provider: "openai", model: "gpt-6-luna", usage });
  // 7034 * 0.20 + 1510 * 1.20 per million
  assert.ok(Math.abs(auto.estimatedCost - (7034 * 0.2 + 1510 * 1.2) / 1e6) < 1e-12);
  assert.equal(auto.workflow.unpricedInvocations, 0);

  const unknown = new Telemetry({ enabled: false }).recordProviderUsage({ workflowRunId: "w", provider: "x", model: "mystery-1", usage });
  assert.equal(unknown.estimatedCost, undefined);

  // A rate the user wrote wins over the table.
  const own = new Telemetry({ enabled: false, pricing: { models: { "gpt-6-luna": { inputPerMillion: 1, outputPerMillion: 1 } } } })
    .recordProviderUsage({ workflowRunId: "w", provider: "openai", model: "gpt-6-luna", usage });
  assert.ok(Math.abs(own.estimatedCost - (7034 + 1510) / 1e6) < 1e-12);

  // The table is in USD: under another currency it does not apply.
  const eur = new Telemetry({ enabled: false, pricing: { currency: "EUR" } }).recordProviderUsage({ workflowRunId: "w", provider: "openai", model: "gpt-6-luna", usage });
  assert.equal(eur.estimatedCost, undefined);
});

test("a call recorded before any rate existed is priced from the table when read back", async () => {
  const { Telemetry, summarizeTelemetryFile, telemetryProviderAttributes } = await import("../src/observability/telemetry.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(await mkdtemp(join(tmpdir(), "etnpilot-retro-")), "t.jsonl");
  // Record as an older version would have: a rate-less telemetry whose table lookup is bypassed.
  const telemetry = new Telemetry({ enabled: true, file: path, serviceName: "s", environment: "t", pricing: { currency: "USD", models: {} } });
  const accounting = telemetry.recordProviderUsage({ workflowRunId: "w", provider: "openai", model: "gpt-6-luna", usage: { inputTokens: 1000, outputTokens: 1000 } });
  const { estimatedCost, currency, ...unpriced } = accounting;
  await telemetry.startSpan("gen_ai.invoke_agent", { attributes: { "etnpilot.workflow.run_id": "w" } })
    .end({ attributes: telemetryProviderAttributes(unpriced) });
  await telemetry.flush();
  const summary = await summarizeTelemetryFile(path);
  assert.ok(Math.abs(summary.estimatedCost - (1000 * 0.2 + 1000 * 1.2) / 1e6) < 1e-12);
  assert.equal(summary.unpricedInvocations, 0);
  assert.equal(summary.currency, "USD");
});

test("a sealed run that says 'not priced' is shown with the cost the table gives it, receipt untouched", async () => {
  const { Telemetry, telemetryProviderAttributes } = await import("../src/observability/telemetry.js");
  const { withCurrentPricing } = await import("../src/runtime/project-state.js");
  const { mkdtemp, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-shown-"));
  await mkdir(join(root, ".etnpilot", "state"), { recursive: true });
  const telemetry = new Telemetry({ enabled: true, file: join(root, ".etnpilot/state/telemetry.jsonl"), serviceName: "s", environment: "t", pricing: { currency: "USD", models: {} } });
  const accounting = telemetry.recordProviderUsage({ workflowRunId: "run-1", provider: "openai", model: "gpt-6-luna", usage: { inputTokens: 7034, outputTokens: 1510 } });
  const { estimatedCost, currency, ...unpriced } = accounting;
  await telemetry.startSpan("gen_ai.invoke_agent", { attributes: { "etnpilot.workflow.run_id": "run-1" } }).end({ attributes: telemetryProviderAttributes(unpriced) });
  await telemetry.flush();

  const sealed = { terminal: { runId: "run-1" }, outcome: { usage: { invocations: 1, unpricedInvocations: 1, inputTokens: 7034, outputTokens: 1510 } } };
  const shown = await withCurrentPricing(sealed, { root, config: {}, runId: "run-1" });
  assert.ok(Math.abs(shown.outcome.usage.estimatedCost - (7034 * 0.2 + 1510 * 1.2) / 1e6) < 1e-12);
  assert.equal(shown.outcome.usage.unpricedInvocations, 0);
  assert.equal(sealed.outcome.usage.estimatedCost, undefined);
});
