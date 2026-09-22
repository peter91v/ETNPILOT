import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { definePlugin } from "../src/plugins/sdk.js";

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

test("plugins can register capabilities exactly once", async () => {
  const harness = new Harness();
  const plugin = definePlugin({
    apiVersion: 1,
    name: "example",
    version: "1.0.0",
    capabilities: ["prompt.register"],
    setup(context) {
      context.registerPrompt("review", "Review carefully.");
    },
  });
  await harness.use(plugin);
  assert.equal(harness.prompts.get("review"), "Review carefully.");
  await assert.rejects(() => harness.use(plugin), /already registered/);
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
});
