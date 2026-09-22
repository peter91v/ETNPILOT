import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowEngine } from "../src/workflow/engine.js";

test("workflow engine orders dependencies and retries bounded failures", async () => {
  const attempts = new Map();
  const engine = new WorkflowEngine({ concurrency: 2, timeoutMs: 1_000 });
  const summary = await engine.run([
    { id: "plan", retries: 1 },
    { id: "build-a", needs: ["plan"] },
    { id: "build-b", needs: ["plan"] },
    { id: "review", needs: ["build-a", "build-b"] },
  ], async (step, context) => {
    const count = (attempts.get(step.id) ?? 0) + 1;
    attempts.set(step.id, count);
    if (step.id === "plan" && count === 1) throw new Error("temporary");
    if (step.id === "review") assert.deepEqual(Object.keys(context.dependencyResults).sort(), ["build-a", "build-b"]);
    return step.id;
  });
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.steps.plan.attempts, 2);
  assert.equal(summary.steps.review.status, "succeeded");
});

test("workflow rejects cycles and blocks dependents", async () => {
  const engine = new WorkflowEngine({ failFast: false });
  await assert.rejects(
    () => engine.run([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }], async () => {}),
    /dependency cycle/,
  );
  const summary = await engine.run([
    { id: "a" },
    { id: "b", needs: ["a"] },
  ], async (step) => {
    if (step.id === "a") throw new Error("failed");
  });
  assert.equal(summary.status, "failed");
  assert.equal(summary.steps.b.status, "blocked");
});

test("workflow enforces step timeout even when an operation ignores cancellation", async () => {
  const engine = new WorkflowEngine({ timeoutMs: 10 });
  await assert.rejects(
    () => engine.run([{ id: "slow" }], () => new Promise(() => {})),
    /timed out/,
  );
});
