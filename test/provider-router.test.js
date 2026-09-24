import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { ProviderError, ProviderRouter } from "../src/providers/router.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { Telemetry } from "../src/observability/telemetry.js";

test("router skips unavailable and incompatible providers", async () => {
  const harness = new Harness();
  harness.registerProvider({ name: "offline", capabilities: ["chat", "tools"], available: false, invoke: fail });
  harness.registerProvider({ name: "chat-only", capabilities: ["chat"], invoke: fail });
  harness.registerProvider({ name: "capable", capabilities: ["chat", "tools"], invoke: async () => ({ text: "ok" }) });
  const router = new ProviderRouter(harness.providers, {
    defaults: ["offline", "chat-only", "capable"],
    fallback: { maxAttempts: 1 },
  });
  const routed = await router.invoke({ agent: { name: "builder", requires: ["chat", "tools"] } });
  assert.equal(routed.provider, "capable");
  assert.deepEqual(routed.attempts.map(({ provider, status, reason }) => ({ provider, status, reason })), [
    { provider: "offline", status: "skipped", reason: "unavailable" },
    { provider: "chat-only", status: "skipped", reason: "capability-mismatch" },
    { provider: "capable", status: "succeeded", reason: undefined },
  ]);
});

test("router falls back only after an explicitly safe retryable failure", async () => {
  const harness = new Harness();
  harness.registerProvider({
    name: "primary",
    capabilities: ["chat"],
    invoke: async () => { throw new ProviderError("temporary", { retryable: true, safeToRetry: true }); },
  });
  harness.registerProvider({ name: "backup", capabilities: ["chat"], invoke: async () => ({ text: "backup" }) });
  const router = new ProviderRouter(harness.providers, { defaults: ["primary", "backup"] });
  const routed = await router.invoke({ agent: { name: "reviewer", requires: ["chat"] } });
  assert.equal(routed.provider, "backup");
  assert.deepEqual(routed.attempts.map((attempt) => attempt.status), ["failed", "succeeded"]);
});

test("agent-specific routing rules take precedence over manifest defaults", async () => {
  const harness = new Harness();
  harness.registerProvider({ name: "manifest", capabilities: ["chat"], invoke: fail });
  harness.registerProvider({ name: "review", capabilities: ["chat"], invoke: async () => ({ text: "review" }) });
  const router = new ProviderRouter(harness.providers, {
    rules: [{ agent: "reviewer", providers: ["review"], require: ["chat"] }],
  });
  const routed = await router.invoke({ agent: { name: "reviewer", provider: "manifest" } });
  assert.equal(routed.provider, "review");
});

test("router never replays an unsafe provider failure", async () => {
  const harness = new Harness();
  let backupCalls = 0;
  harness.registerProvider({
    name: "primary",
    capabilities: ["chat"],
    invoke: async () => { throw new ProviderError("prompt may have run", { retryable: true, safeToRetry: false }); },
  });
  harness.registerProvider({
    name: "backup",
    capabilities: ["chat"],
    invoke: async () => { backupCalls += 1; return { text: "backup" }; },
  });
  const router = new ProviderRouter(harness.providers, { defaults: ["primary", "backup"] });
  await assert.rejects(() => router.invoke({ agent: { name: "reviewer", requires: ["chat"] } }), /prompt may have run/);
  assert.equal(backupCalls, 0);
});

test("router skips providers denied by policy", async () => {
  const harness = new Harness();
  harness.registerProvider({ name: "blocked", capabilities: ["chat"], invoke: fail });
  harness.registerProvider({ name: "approved", capabilities: ["chat"], invoke: async () => ({ text: "ok" }) });
  const policy = new PolicyEngine({
    providers: {
      rules: [{ id: "approved-provider", effect: "allow", providers: ["approved"] }],
    },
  });
  const router = new ProviderRouter(harness.providers, { defaults: ["blocked", "approved"] }, { policy });
  const routed = await router.invoke({ agent: { name: "builder", requires: ["chat"] } });
  assert.equal(routed.provider, "approved");
  assert.deepEqual(routed.attempts[0], {
    provider: "blocked",
    status: "skipped",
    reason: "policy-denied",
    policy: { section: "providers", effect: "deny", default: true },
  });
});

test("router stops after a cumulative usage budget is exceeded", async () => {
  const harness = new Harness();
  harness.registerProvider({
    name: "metered",
    capabilities: ["chat"],
    invoke: async () => ({
      text: "done",
      model: "metered-model",
      usage: { inputTokens: 101, outputTokens: 1 },
    }),
  });
  const telemetry = new Telemetry({ budgets: { maxInputTokensPerWorkflow: 100 } });
  const router = new ProviderRouter(harness.providers, { defaults: ["metered"] });
  await assert.rejects(
    () => router.invoke({
      agent: { name: "builder", requires: ["chat"] },
      metadata: { workflowRunId: "workflow-budget" },
      runId: "agent-budget",
      telemetry,
    }),
    (error) => error instanceof ProviderError
      && error.code === "budget_exceeded"
      && error.providerAttempts[0].status === "succeeded",
  );
});

test("harness receipts record the provider selected by fallback", async () => {
  const receipts = [];
  const harness = new Harness({ receiptStore: { append: async (receipt) => receipts.push(receipt) } });
  harness.registerProvider({
    name: "primary",
    capabilities: ["chat"],
    invoke: async () => { throw new ProviderError("temporary", { retryable: true, safeToRetry: true }); },
  });
  harness.registerProvider({ name: "backup", capabilities: ["chat"], invoke: async () => ({ text: "done" }) });
  harness.registerAgent({
    name: "worker",
    provider: "primary",
    providers: ["primary", "backup"],
    requires: ["chat"],
    prompt: "Work.",
  });
  harness.setProviderRouter(new ProviderRouter(harness.providers));
  const receipt = await harness.run({ agent: "worker", input: "go" });
  assert.equal(receipt.provider, "backup");
  assert.equal(receipts[0].provider, "backup");
  assert.deepEqual(receipt.providerAttempts.map((attempt) => attempt.provider), ["primary", "backup"]);
});

async function fail() {
  throw new Error("must not be invoked");
}

test("the project's defaultProvider is part of the route, after the ones it lists", async () => {
  const harness = new Harness();
  harness.registerProvider({ name: "listed", capabilities: ["chat"], invoke: async () => ({ text: "listed" }) });
  harness.registerProvider({ name: "fallback", capabilities: ["chat"], invoke: async () => ({ text: "fallback" }) });

  // A project that only names a default has a route all the same.
  const plain = new ProviderRouter(harness.providers, {}, { defaultProvider: "fallback" });
  assert.equal((await plain.invoke({ agent: { name: "worker" } })).provider, "fallback");

  // And one that lists providers keeps that order, with the default last.
  const listed = new ProviderRouter(harness.providers, { defaults: ["listed"] }, { defaultProvider: "fallback" });
  const result = await listed.invoke({ agent: { name: "worker" } });
  assert.equal(result.provider, "listed");

  // A default that is not configured is skipped like any other candidate,
  // rather than ending the route.
  const missing = new ProviderRouter(harness.providers, { defaults: ["absent"] }, { defaultProvider: "fallback" });
  const recovered = await missing.invoke({ agent: { name: "worker" } });
  assert.equal(recovered.provider, "fallback");
  assert.deepEqual(recovered.attempts[0], { provider: "absent", status: "skipped", reason: "not-registered" });
});

test("a route that finds nothing says what it tried and what exists", async () => {
  const harness = new Harness();
  harness.registerProvider({ name: "configured", capabilities: ["chat"], invoke: async () => ({ text: "ok" }) });
  const router = new ProviderRouter(harness.providers, { defaults: ["absent"] }, { defaultProvider: "also-absent" });
  await assert.rejects(() => router.invoke({ agent: { name: "orchestrator", requires: ["chat"] } }), (error) => {
    assert.equal(error.code, "no_eligible_provider");
    assert.match(error.message, /agent 'orchestrator' with capabilities: chat/);
    // The candidates and why each was passed over.
    assert.match(error.message, /'absent' not configured under 'providers'/);
    assert.match(error.message, /Tried in order: 'absent', 'also-absent'/);
    // What there is instead, and which settings decide the route.
    assert.match(error.message, /Configured and ready: 'configured'/);
    assert.match(error.message, /routing\.defaults.*defaultProvider/);
    return true;
  });

  const empty = new ProviderRouter(new Harness().providers, {});
  await assert.rejects(() => empty.invoke({ agent: { name: "orchestrator" } }), (error) => {
    assert.match(error.message, /Tried in order: nothing/);
    assert.match(error.message, /No provider is configured under 'providers'/);
    return true;
  });
});

test("a provider that was tried and failed is named, with why", async () => {
  const harness = new Harness();
  harness.registerProvider({
    name: "flaky",
    capabilities: ["chat"],
    invoke: async () => {
      throw new ProviderError("Provider network request failed: connect ECONNREFUSED 127.0.0.1:45999", {
        code: "network_error",
        retryable: true,
        safeToRetry: true,
      });
    },
  });
  const router = new ProviderRouter(harness.providers, { defaults: ["absent", "flaky"] });
  await assert.rejects(() => router.invoke({ agent: { name: "worker", requires: ["chat"] } }), (error) => {
    // Without this the message reads 'no provider can satisfy' while the
    // truth is that one was reached and refused the connection.
    assert.match(error.message, /Tried and failed: 'flaky' \(network_error\) Provider network request failed: connect ECONNREFUSED/);
    assert.match(error.message, /'absent' not configured/);
    assert.equal(error.providerAttempts.find((attempt) => attempt.provider === "flaky").status, "failed");
    return true;
  });
});
