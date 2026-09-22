import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowQueue, WorkflowQueueStateError } from "../src/workflow/queue.js";
import { WorkflowQueueWorker } from "../src/workflow/queue-worker.js";

test("workflow queue deduplicates deliveries and atomically leases one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-atomic-"));
  const database = join(root, "queue.sqlite");
  const first = new WorkflowQueue(database);
  const second = new WorkflowQueue(database);
  try {
    const created = first.enqueue({ kind: "test", deliveryId: "delivery-1", payload: { task: "one" } });
    const duplicate = second.enqueue({ kind: "test", deliveryId: "delivery-1", payload: { task: "duplicate" } });
    assert.equal(created.enqueued, true);
    assert.equal(duplicate.enqueued, false);
    assert.equal(duplicate.job.id, created.job.id);

    const claims = [first.claim("worker-1"), second.claim("worker-2")].filter(Boolean);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].attempts, 1);
    assert.equal(claims[0].status, "running");
  } finally {
    first.close();
    second.close();
  }
});

test("expired active leases become orphaned and require forced resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-orphan-"));
  let now = 1_000;
  const queue = new WorkflowQueue(join(root, "queue.sqlite"), { now: () => now });
  try {
    const { job } = queue.enqueue({ kind: "test", payload: { task: "one" } });
    queue.claim("worker-1", { leaseMs: 100 });
    now = 1_101;
    assert.equal(queue.claim("worker-2", { leaseMs: 100 }), undefined);
    assert.equal(queue.get(job.id).status, "orphaned");
    assert.throws(
      () => queue.resume(job.id),
      (error) => error instanceof WorkflowQueueStateError && error.code === "force_required",
    );
    assert.equal(queue.resume(job.id, { force: true }).status, "queued");
    assert.equal(queue.claim("worker-2", { leaseMs: 100 }).id, job.id);
  } finally {
    queue.close();
  }
});

test("queue worker records checkpoints and completes a durable job", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-worker-"));
  const queue = new WorkflowQueue(join(root, "queue.sqlite"));
  const { job } = queue.enqueue({ kind: "test", payload: { task: "one" } });
  const worker = new WorkflowQueueWorker({
    queue,
    pollIntervalMs: 10,
    leaseMs: 150,
    execute: async (claimed, execution) => {
      assert.equal(claimed.id, job.id);
      execution.checkpoint({ phase: "executing" });
      return { ok: true };
    },
  }).start();
  try {
    await worker.waitForIdle({ timeoutMs: 2_000 });
    const completed = queue.get(job.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.checkpoint.phase, "executing");
    assert.deepEqual(completed.result, { ok: true });
  } finally {
    await worker.stop();
    queue.close();
  }
});

test("queued jobs survive a process-style close and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-restart-"));
  const database = join(root, "queue.sqlite");
  const first = new WorkflowQueue(database);
  const { job } = first.enqueue({ kind: "test", deliveryId: "restart-1", payload: { task: "resume" } });
  first.close();

  const reopened = new WorkflowQueue(database);
  const worker = new WorkflowQueueWorker({
    queue: reopened,
    pollIntervalMs: 10,
    leaseMs: 150,
    execute: async () => ({ resumed: true }),
  }).start();
  try {
    await worker.waitForIdle({ timeoutMs: 2_000 });
    assert.equal(reopened.get(job.id).status, "succeeded");
    assert.deepEqual(reopened.get(job.id).result, { resumed: true });
  } finally {
    await worker.stop();
    reopened.close();
  }
});

test("worker retries only errors explicitly marked safe to replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-retry-"));
  const queue = new WorkflowQueue(join(root, "queue.sqlite"));
  const safe = queue.enqueue({ kind: "test", payload: { task: "safe" }, maxAttempts: 2 }).job;
  const unsafe = queue.enqueue({ kind: "test", payload: { task: "unsafe" }, maxAttempts: 3 }).job;
  const attempts = new Map();
  const worker = new WorkflowQueueWorker({
    queue,
    pollIntervalMs: 10,
    leaseMs: 150,
    retryDelayMs: 0,
    execute: async (job) => {
      const attempt = (attempts.get(job.id) ?? 0) + 1;
      attempts.set(job.id, attempt);
      if (job.id === safe.id && attempt === 1) {
        const error = new Error("transient secret detail");
        error.safeToRetry = true;
        throw error;
      }
      if (job.id === unsafe.id) throw new Error("ambiguous secret detail");
      return { ok: true };
    },
  }).start();
  try {
    await worker.waitForIdle({ timeoutMs: 2_000 });
    assert.equal(queue.get(safe.id).status, "succeeded");
    assert.equal(queue.get(safe.id).attempts, 2);
    assert.equal(queue.get(unsafe.id).status, "failed");
    assert.equal(queue.get(unsafe.id).attempts, 1);
    assert.doesNotMatch(JSON.stringify(queue.get(unsafe.id).error), /secret detail/);
  } finally {
    await worker.stop();
    queue.close();
  }
});

test("cancel requests propagate to a running worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-cancel-"));
  const queue = new WorkflowQueue(join(root, "queue.sqlite"));
  const { job } = queue.enqueue({ kind: "test", payload: { task: "one" } });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const worker = new WorkflowQueueWorker({
    queue,
    pollIntervalMs: 10,
    leaseMs: 150,
    execute: async (_claimed, { signal }) => {
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  }).start();
  try {
    await running;
    assert.equal(queue.requestCancel(job.id, { actor: "test" }).status, "cancel_requested");
    await worker.waitForIdle({ timeoutMs: 2_000 });
    assert.equal(queue.get(job.id).status, "canceled");
  } finally {
    await worker.stop();
    queue.close();
  }
});
