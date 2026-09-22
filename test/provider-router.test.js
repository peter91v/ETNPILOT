import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { ProviderError, ProviderRouter } from "../src/providers/router.js";
import { PolicyEngine } from "../src/policy/engine.js";

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
