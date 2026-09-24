import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTelemetry,
  summarizeTelemetryFile,
  Telemetry,
  telemetryProviderAttributes,
} from "../src/observability/telemetry.js";

test("telemetry writes and exports OTLP JSON without request content", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-telemetry-"));
  const path = join(root, "telemetry.jsonl");
  const calls = [];
  let clock = 1_700_000_000_000;
  const telemetry = new Telemetry({
    file: path,
    serviceName: "test-service",
    environment: "test",
    now: () => clock += 5,
    otlp: { enabled: true, endpoint: "https://collector.example/v1/traces", headers: { authorization: "secret-header" } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response("{}", { status: 200 });
    },
    pricing: {
      currency: "USD",
      models: {
        "team-model": { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 1 },
      },
    },
  });
  const accounting = telemetry.recordProviderUsage({
    workflowRunId: "workflow-1",
    agentRunId: "agent-1",
    provider: "team-provider",
    model: "team-model",
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
  });
  assert.equal(accounting.estimatedCost, 0.0115);
  const span = telemetry.startSpan("gen_ai.invoke_agent", {
    kind: 3,
    attributes: {
      "gen_ai.operation.name": "chat",
      "etnpilot.workflow.run_id": "workflow-1",
      "etnpilot.provider.name": "team-provider",
      "private.prompt": undefined,
    },
  });
  await span.end({ attributes: telemetryProviderAttributes(accounting) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://collector.example/v1/traces");
  assert.equal(calls[0].options.headers.authorization, "secret-header");
  const payload = JSON.parse(calls[0].options.body);
  const exported = payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.match(exported.traceId, /^[a-f0-9]{32}$/);
  assert.match(exported.spanId, /^[a-f0-9]{16}$/);
  assert.equal(exported.kind, 3);
  assert.match(exported.startTimeUnixNano, /^\d+$/);
  assert.doesNotMatch(JSON.stringify(payload), /secret-header|private\.prompt/);
  assert.equal((await readFile(path, "utf8")).trim(), JSON.stringify(payload));

  const summary = await summarizeTelemetryFile(path, { workflowRunId: "workflow-1" });
  assert.equal(summary.spans, 1);
  assert.equal(summary.inputTokens, 1000);
  assert.equal(summary.outputTokens, 200);
  assert.equal(summary.estimatedCost, 0.0115);
  assert.equal(summary.currency, "USD");
});

test("usage accounting enforces cumulative workflow budgets", () => {
  const telemetry = new Telemetry({
    budgets: { maxInputTokensPerWorkflow: 100, maxProviderUnitsPerWorkflow: 1 },
  });
  assert.equal(telemetry.recordProviderUsage({
    workflowRunId: "run",
    usage: { inputTokens: 60, providerUnits: 0.5 },
  }).budgetExceeded, undefined);
  const second = telemetry.recordProviderUsage({
    workflowRunId: "run",
    usage: { inputTokens: 50, providerUnits: 0.6 },
  });
  assert.deepEqual(second.budgetExceeded.map((item) => item.metric), ["input_tokens", "provider_units"]);
  assert.equal(second.workflow.inputTokens, 110);
});

test("OTLP headers resolve through a named secret and exporter failures are redacted", async () => {
  const telemetry = await createTelemetry({
    config: { observability: {
      enabled: true,
      file: false,
      otlp: {
        enabled: true,
        endpoint: "https://collector.example/v1/traces",
        headersSecret: "observability.headers",
      },
    } },
    secretResolver: { get: async () => '{"authorization":"Bearer never-print"}' },
    fetchImpl: async () => new Response("sensitive response", { status: 503 }),
  });
  const span = telemetry.startSpan("failed-export");
  await span.end();
  const result = await telemetry.flush();
  assert.deepEqual(result.errors.map((error) => error.code), ["telemetry_export_failed"]);
  assert.doesNotMatch(JSON.stringify(result), /never-print|sensitive response/);
});

test("observability rejects unknown settings and invalid trace context", async () => {
  await assert.rejects(
    createTelemetry({ config: { observability: { enabled: true, typo: true } } }),
    /Unknown observability setting 'typo'/,
  );
  await assert.rejects(
    createTelemetry({ config: { observability: { enabled: true, pricing: { models: { model: { unknownRate: 1 } } } } } }),
    /Unknown pricing for 'model' setting 'unknownRate'/,
  );
  const telemetry = new Telemetry();
  assert.throws(() => telemetry.startSpan("invalid", { traceId: "ABC" }), /traceId/);
  assert.throws(() => telemetry.startSpan("invalid", { parentSpanId: "123" }), /parentSpanId/);
  assert.throws(() => telemetry.startSpan("invalid", { kind: 6 }), /Span kind/);
});

test("a cost that cannot be worked out names the model whose rate is missing", async () => {
  // Reported: 'ESTIMATED COST — not priced — set observability.pricing to see
  // it', after setting it. The rate is applied when the call happens, so it
  // never reaches a call already on disk, and the card repeated the same
  // sentence either way. Naming the model says which rate is missing; saying
  // the calls predate it says why setting one changed nothing.
  const directory = await mkdtemp(join(tmpdir(), "etnpilot-pricing-"));
  const path = join(directory, "telemetry.jsonl");
  const unpriced = new Telemetry({
    enabled: true,
    file: path,
    serviceName: "s",
    environment: "test",
    pricing: { currency: "USD", models: {} },
  });
  for (const model of ["gpt-5", "gpt-5", "claude-opus-5"]) {
    const accounting = unpriced.recordProviderUsage({
      workflowRunId: "w",
      provider: "p",
      model,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    await unpriced.startSpan("gen_ai.invoke_agent", { attributes: { "etnpilot.workflow.run_id": "w" } })
      .end({ attributes: telemetryProviderAttributes(accounting) });
  }
  await unpriced.flush();

  const before = await summarizeTelemetryFile(path);
  assert.equal(before.estimatedCost, undefined);
  assert.equal(before.unpricedInvocations, 3);
  // Most-used model first, so the rate worth setting is the one named first.
  assert.deepEqual(before.unpricedModels, [
    { model: "gpt-5", calls: 2 },
    { model: "claude-opus-5", calls: 1 },
  ]);

  // Now a rate exists, and one more call is made with it.
  const priced = new Telemetry({
    enabled: true,
    file: path,
    serviceName: "s",
    environment: "test",
    pricing: { currency: "USD", models: { "gpt-5": { inputPerMillion: 1, outputPerMillion: 2 } } },
  });
  const accounting = priced.recordProviderUsage({
    workflowRunId: "w",
    provider: "p",
    model: "gpt-5",
    usage: { inputTokens: 1000, outputTokens: 1000 },
  });
  await priced.startSpan("gen_ai.invoke_agent", { attributes: { "etnpilot.workflow.run_id": "w" } })
    .end({ attributes: telemetryProviderAttributes(accounting) });
  await priced.flush();

  const after = await summarizeTelemetryFile(path);
  assert.equal(after.pricedInvocations, 1);
  assert.equal(after.unpricedInvocations, 3);
  // The earlier gpt-5 calls are marked as predating the rate, rather than as
  // a rate still to be set.
  assert.deepEqual(after.unpricedModels, [
    { model: "gpt-5", calls: 2, pricedSince: true },
    { model: "claude-opus-5", calls: 1 },
  ]);
});

test("a rate reaches the dated snapshot a provider actually served", async () => {
  // OpenAI answers a request for 'gpt-5-mini' with 'gpt-5-mini-2025-08-07',
  // and the rate is keyed by what came back. Keying it by the name someone
  // configured would otherwise go stale the next time the provider rotates
  // its snapshot, and the card would read 'not priced' with no cause anyone
  // could see.
  const telemetry = new Telemetry({
    enabled: false,
    serviceName: "s",
    environment: "test",
    pricing: {
      currency: "USD",
      models: {
        "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
        "gpt-5-mini-2025-01-01": { inputPerMillion: 99, outputPerMillion: 99 },
      },
    },
  });

  const dated = telemetry.recordProviderUsage({
    workflowRunId: "w1",
    provider: "openai",
    model: "gpt-5-mini-2025-08-07",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(dated.estimatedCost, 0.25, "the undated rate applies to the snapshot");

  // An exact key still wins, so a snapshot that is priced differently can say so.
  const pinned = telemetry.recordProviderUsage({
    workflowRunId: "w2",
    provider: "openai",
    model: "gpt-5-mini-2025-01-01",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(pinned.estimatedCost, 99);

  // And the suffix is a shape, not a prefix: a different model keeps its own
  // answer rather than borrowing one.
  const other = telemetry.recordProviderUsage({
    workflowRunId: "w3",
    provider: "openai",
    model: "gpt-5-mini-high",
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
  });
  assert.equal(other.estimatedCost, undefined);
});
