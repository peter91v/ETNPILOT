import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export class WorkflowQueueWorker {
  constructor({
    queue,
    execute,
    workerId = randomUUID(),
    pollIntervalMs = 500,
    leaseMs = 30_000,
    retryDelayMs = 5_000,
    onError = () => {},
  } = {}) {
    if (!queue) throw new TypeError("A workflow queue is required.");
    if (typeof execute !== "function") throw new TypeError("A workflow job executor is required.");
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
      throw new TypeError("pollIntervalMs must be at least 10.");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 100) throw new TypeError("leaseMs must be at least 100.");
    this.queue = queue;
    this.execute = execute;
    this.workerId = workerId;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.retryDelayMs = retryDelayMs;
    this.onError = onError;
    this.stopping = false;
    this.loopPromise = undefined;
    this.sleepController = undefined;
    this.activeController = undefined;
    this.activeJobId = undefined;
  }

  start() {
    if (!this.loopPromise) this.loopPromise = this.#loop();
    return this;
  }

  wake() {
    this.sleepController?.abort();
  }

  async waitForIdle({ timeoutMs = 30_000 } = {}) {
    const startedAt = Date.now();
    while (true) {
      const counts = this.queue.counts();
      const active = (counts.queued ?? 0) + (counts.retry_scheduled ?? 0)
        + (counts.running ?? 0) + (counts.cancel_requested ?? 0);
      if (active === 0) return counts;
      if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for the workflow queue to become idle.");
      this.wake();
      await delay(Math.min(this.pollIntervalMs, 50));
    }
  }

  async stop() {
    this.stopping = true;
    this.activeController?.abort(new Error("Workflow worker is shutting down."));
    this.wake();
    await this.loopPromise;
  }

  async #loop() {
    while (!this.stopping) {
      let job;
      try {
        job = this.queue.claim(this.workerId, { leaseMs: this.leaseMs });
      } catch (error) {
        this.#report(error);
      }
      if (job) {
        await this.#run(job);
        continue;
      }
      this.sleepController = new AbortController();
      try {
        await delay(this.pollIntervalMs, undefined, { signal: this.sleepController.signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      } finally {
        this.sleepController = undefined;
      }
    }
  }

  async #run(job) {
    const controller = new AbortController();
    this.activeController = controller;
    this.activeJobId = job.id;
    const heartbeatMs = Math.max(50, Math.floor(this.leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        if (!this.queue.heartbeat(job.id, this.workerId, { leaseMs: this.leaseMs })) {
          controller.abort(new Error("Workflow job was canceled or its lease was lost."));
        }
      } catch (error) {
        controller.abort(error);
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      const result = await this.execute(job, {
        jobId: job.id,
        signal: controller.signal,
        checkpoint: (value) => this.queue.checkpoint(job.id, this.workerId, value),
      });
      const current = this.queue.get(job.id);
      if (current?.status === "cancel_requested") this.queue.markCanceled(job.id, this.workerId);
      else this.queue.complete(job.id, this.workerId, result);
    } catch (error) {
      const current = this.queue.get(job.id);
      try {
        if (current?.status === "cancel_requested") {
          this.queue.markCanceled(job.id, this.workerId);
        } else if (this.stopping || controller.signal.aborted) {
          this.queue.abandon(job.id, this.workerId, "Worker stopped or lost its lease during execution.");
        } else {
          this.queue.fail(job.id, this.workerId, error, {
            retryDelayMs: this.retryDelayMs,
            safeToRetry: error?.safeToRetry === true,
          });
        }
      } catch (queueError) {
        this.#report(queueError);
      }
      if (!this.stopping && current?.status !== "cancel_requested") this.#report(error);
    } finally {
      clearInterval(heartbeat);
      this.activeController = undefined;
      this.activeJobId = undefined;
    }
  }

  #report(error) {
    try {
      this.onError(error);
    } catch {
      // Error observers must not terminate the durable worker loop.
    }
  }
}
