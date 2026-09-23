import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { PolicyEngine } from "../src/policy/engine.js";

test("harness composes plugins, agents, providers, and subagents", async () => {
  const receipts = [];
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(),
    receiptStore: { append: async (receipt) => receipts.push(receipt) },
  });
  harness.registerProvider({
    name: "fake",
    async invoke(context) {
      if (context.agent.name === "parent") {
        const child = await context.spawn("child", "inspect");
        return { child: child.result.text };
      }
      return { text: `${context.agent.name}:${context.input}` };
    },
  });
  harness.registerAgent({ name: "child", provider: "fake", prompt: "Review." });
  harness.registerAgent({ name: "parent", provider: "fake", prompt: "Build.", subagents: ["child"] });

  const result = await harness.run({ agent: "parent", input: "implement" });

  assert.equal(result.status, "succeeded");
  assert.equal(result.result.child, "child:inspect");
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].parentRunId, result.runId);
});

test("harness refuses in-process plugins", async () => {
  const harness = new Harness();
  await assert.rejects(() => harness.use({}), /In-process plugins are disabled/);
});

test("harness routes human-required operations through the approval handler", async () => {
  const requests = [];
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(),
    approvalHandler: async (request) => {
      requests.push(request);
      return { kind: "approve-once" };
    },
  });
  harness.registerProvider({
    name: "fake",
    async invoke(context) {
      return context.approve({ kind: "write", fileName: "result.txt" });
    },
  });
  harness.registerAgent({ name: "writer", provider: "fake", prompt: "Write." });
  const receipt = await harness.run({ agent: "writer", input: "go" });
  assert.equal(receipt.result.kind, "approve-once");
  assert.equal(requests.length, 1);
  assert.equal(receipt.approvals.length, 1);
  assert.equal(receipt.approvals[0].operationKind, "write");
  assert.equal(receipt.approvals[0].decision, "approve-once");
});

test("harness enforces provider policy without a router", async () => {
  let invoked = false;
  const policy = new PolicyEngine({ providers: { default: "deny", rules: [] } });
  const harness = new Harness({ policy });
  harness.registerProvider({ name: "blocked", invoke: async () => { invoked = true; } });
  harness.registerAgent({ name: "worker", provider: "blocked", prompt: "Work." });

  await assert.rejects(() => harness.run({ agent: "worker", input: "go" }), /default policy/);
  assert.equal(invoked, false);
});

test("a failing event listener neither fails the run nor adds a second receipt", async () => {
  const receipts = [];
  const listenerErrors = [];
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(),
    receiptStore: { append: async (receipt) => receipts.push(receipt) },
  });
  harness.events.onListenerError = (error) => listenerErrors.push(error.message);
  harness.registerProvider({ name: "fake", invoke: async () => ({ text: "ok" }) });
  harness.registerAgent({ name: "worker", provider: "fake", prompt: "Work." });
  harness.events.on("run.completed", () => { throw new Error("observer failed"); });

  const receipt = await harness.run({ agent: "worker", input: "go" });

  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(receipts.map((entry) => entry.status), ["succeeded"]);
  assert.deepEqual(listenerErrors, ["observer failed"]);
});
