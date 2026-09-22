import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WORKFLOW_JOB_STATUSES = Object.freeze([
  "queued",
  "retry_scheduled",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
  "orphaned",
]);

const STATUS_SET = new Set([...WORKFLOW_JOB_STATUSES, "all"]);

export class WorkflowQueue {
  constructor(databasePath, { now = Date.now } = {}) {
    this.path = resolve(databasePath);
    this.now = now;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch (error) {
      if (error.code !== "ENOSYS") throw error;
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workflow_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        delivery_id TEXT UNIQUE,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflow_jobs_ready
        ON workflow_jobs(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS workflow_jobs_lease
        ON workflow_jobs(status, lease_expires_at);
    `);
  }

  enqueue({ kind, deliveryId, payload, metadata = {}, maxAttempts = 1, availableAt } = {}) {
    if (!kind || typeof kind !== "string") throw new TypeError("A workflow job kind is required.");
    if (!payload || typeof payload !== "object") throw new TypeError("A workflow job payload is required.");
    assertPositiveInteger(maxAttempts, "maxAttempts");
    const now = this.now();
    const id = randomUUID();
    const checkpoint = { phase: "accepted", at: new Date(now).toISOString() };
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO workflow_jobs(
        id, kind, delivery_id, status, payload_json, metadata_json, checkpoint_json,
        max_attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      kind,
      deliveryId ?? null,
      stringify(payload),
      stringify(metadata),
      stringify(checkpoint),
      maxAttempts,
      availableAt ?? now,
      now,
      now,
    );
    if (Number(result.changes) === 1) return { enqueued: true, job: this.get(id) };
    const existing = deliveryId
      ? this.database.prepare("SELECT * FROM workflow_jobs WHERE delivery_id = ?").get(deliveryId)
      : undefined;
    return { enqueued: false, job: existing ? fromRow(existing) : undefined };
  }

  get(id) {
    const row = this.database.prepare("SELECT * FROM workflow_jobs WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  getByDeliveryId(deliveryId) {
    const row = this.database.prepare("SELECT * FROM workflow_jobs WHERE delivery_id = ?").get(deliveryId);
    return row ? fromRow(row) : undefined;
  }

  list({ status = "all", limit = 100 } = {}) {
    if (!STATUS_SET.has(status)) throw new TypeError(`Unsupported workflow job status: '${status}'.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Workflow queue list limit must be 1..1000.");
    }
    const rows = status === "all"
      ? this.database.prepare("SELECT * FROM workflow_jobs ORDER BY created_at DESC LIMIT ?").all(limit)
      : this.database.prepare("SELECT * FROM workflow_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
    return rows.map(fromRow);
  }

  claim(workerId, { leaseMs = 30_000 } = {}) {
    if (!workerId) throw new TypeError("A worker ID is required.");
    assertPositiveInteger(leaseMs, "leaseMs");
    const now = this.now();
    return this.#transaction(() => {
      this.#recoverExpiredLeases(now);
      const row = this.database.prepare(`
        SELECT id FROM workflow_jobs
        WHERE status IN ('queued', 'retry_scheduled') AND available_at <= ?
        ORDER BY available_at, created_at
        LIMIT 1
      `).get(now);
      if (!row) return undefined;
      const claimed = this.database.prepare(`
        UPDATE workflow_jobs SET
          status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?,
          started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'retry_scheduled') AND available_at <= ?
      `).run(workerId, now + leaseMs, now, now, row.id, now);
      return Number(claimed.changes) === 1 ? this.get(row.id) : undefined;
    });
  }

  heartbeat(id, workerId, { leaseMs = 30_000 } = {}) {
    assertPositiveInteger(leaseMs, "leaseMs");
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE workflow_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(now + leaseMs, now, id, workerId);
    return Number(result.changes) === 1;
  }

  checkpoint(id, workerId, checkpoint) {
    const job = this.get(id);
    if (!job || job.status !== "running" || job.leaseOwner !== workerId) {
      throw new WorkflowQueueStateError(`Worker '${workerId}' no longer owns job '${id}'.`, { code: "lease_lost" });
    }
    const value = {
      ...job.checkpoint,
      ...checkpoint,
      at: new Date(this.now()).toISOString(),
    };
    const result = this.database.prepare(`
      UPDATE workflow_jobs SET checkpoint_json = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(stringify(value), this.now(), id, workerId);
    if (Number(result.changes) !== 1) {
      throw new WorkflowQueueStateError(`Worker '${workerId}' lost job '${id}' while checkpointing.`, {
        code: "lease_lost",
      });
    }
    return this.get(id);
  }

  complete(id, workerId, result) {
    return this.#finish(id, workerId, "succeeded", { result });
  }

  fail(id, workerId, error, { retryDelayMs = 0, safeToRetry = false } = {}) {
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError("retryDelayMs must be a non-negative integer.");
    }
    const job = this.get(id);
    this.#assertOwned(job, id, workerId);
    const canRetry = safeToRetry && job.attempts < job.maxAttempts;
    const now = this.now();
    const status = canRetry ? "retry_scheduled" : "failed";
    const updated = this.database.prepare(`
      UPDATE workflow_jobs SET status = ?, error_json = ?, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      status,
      stringify(summarizeError(error)),
      now + retryDelayMs,
      now,
      canRetry ? null : now,
      id,
      workerId,
    );
    if (Number(updated.changes) !== 1) {
      throw new WorkflowQueueStateError(`Worker '${workerId}' lost job '${id}' while recording failure.`, {
        code: "lease_lost",
      });
    }
    return this.get(id);
  }

  requestCancel(id, { actor = "cli", reason } = {}) {
    const job = this.get(id);
    if (!job) throw new WorkflowQueueStateError(`Unknown workflow job '${id}'.`, { code: "not_found" });
    if (["succeeded", "failed", "canceled", "orphaned"].includes(job.status)) {
      throw new WorkflowQueueStateError(`Workflow job '${id}' is already ${job.status}.`, { code: "terminal" });
    }
    const now = this.now();
    const error = { name: "Cancellation", message: reason ?? "Canceled by operator.", actor };
    const running = job.status === "running" || job.status === "cancel_requested";
    this.database.prepare(`
      UPDATE workflow_jobs SET status = ?, error_json = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('queued', 'retry_scheduled', 'running', 'cancel_requested')
    `).run(running ? "cancel_requested" : "canceled", stringify(error), now, running ? null : now, id);
    return this.get(id);
  }

  markCanceled(id, workerId) {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE workflow_jobs SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
        updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'cancel_requested' AND lease_owner = ?
    `).run(now, now, id, workerId);
    if (Number(result.changes) !== 1) {
      throw new WorkflowQueueStateError(`Workflow job '${id}' is not cancelable by worker '${workerId}'.`, {
        code: "lease_lost",
      });
    }
    return this.get(id);
  }

  abandon(id, workerId, reason = "Worker stopped before the job completed.") {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE workflow_jobs SET status = 'orphaned', error_json = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('running', 'cancel_requested') AND lease_owner = ?
    `).run(stringify({ name: "OrphanedJob", message: reason }), now, now, id, workerId);
    return Number(result.changes) === 1 ? this.get(id) : this.get(id);
  }

  resume(id, { force = false } = {}) {
    const job = this.get(id);
    if (!job) throw new WorkflowQueueStateError(`Unknown workflow job '${id}'.`, { code: "not_found" });
    if (!["failed", "canceled", "orphaned"].includes(job.status)) {
      throw new WorkflowQueueStateError(`Workflow job '${id}' cannot be resumed from ${job.status}.`, {
        code: "invalid_state",
      });
    }
    if (job.status === "orphaned" && !force) {
      throw new WorkflowQueueStateError(
        `Workflow job '${id}' may have produced side effects. Repeat with --force after inspection.`,
        { code: "force_required" },
      );
    }
    const now = this.now();
    this.database.prepare(`
      UPDATE workflow_jobs SET status = 'queued', attempts = 0, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, result_json = NULL, error_json = NULL,
        started_at = NULL, finished_at = NULL, updated_at = ?, checkpoint_json = ?
      WHERE id = ?
    `).run(now, now, stringify({ phase: "resumed", at: new Date(now).toISOString() }), id);
    return this.get(id);
  }

  counts() {
    return Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM workflow_jobs GROUP BY status
    `).all().map((row) => [row.status, Number(row.count)]));
  }

  close() {
    this.database.close();
  }

  #finish(id, workerId, status, { result }) {
    const job = this.get(id);
    this.#assertOwned(job, id, workerId);
    const now = this.now();
    const updated = this.database.prepare(`
      UPDATE workflow_jobs SET status = ?, result_json = ?, error_json = NULL,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(status, stringify(result), now, now, id, workerId);
    if (Number(updated.changes) !== 1) {
      throw new WorkflowQueueStateError(`Worker '${workerId}' lost job '${id}' while completing it.`, {
        code: "lease_lost",
      });
    }
    return this.get(id);
  }

  #assertOwned(job, id, workerId) {
    if (!job || job.status !== "running" || job.leaseOwner !== workerId) {
      throw new WorkflowQueueStateError(`Worker '${workerId}' no longer owns job '${id}'.`, { code: "lease_lost" });
    }
  }

  #recoverExpiredLeases(now) {
    const error = stringify({
      name: "OrphanedJob",
      message: "The worker lease expired during execution. Explicit operator review is required before replay.",
    });
    this.database.prepare(`
      UPDATE workflow_jobs SET status = 'orphaned', error_json = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ?, finished_at = ?
      WHERE status IN ('running', 'cancel_requested') AND lease_expires_at <= ?
    `).run(error, now, now, now);
  }

  #transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class WorkflowQueueStateError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "WorkflowQueueStateError";
    this.code = code;
  }
}

function fromRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    deliveryId: row.delivery_id ?? undefined,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    metadata: JSON.parse(row.metadata_json),
    checkpoint: JSON.parse(row.checkpoint_json),
    result: row.result_json === null ? undefined : JSON.parse(row.result_json),
    error: row.error_json === null ? undefined : JSON.parse(row.error_json),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at === null ? undefined : iso(row.lease_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: row.started_at === null ? undefined : iso(row.started_at),
    finishedAt: row.finished_at === null ? undefined : iso(row.finished_at),
  };
}

function summarizeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: "Workflow execution failed. Inspect server logs and the run receipt.",
    ...(error?.code ? { code: error.code } : {}),
  };
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

function iso(value) {
  return new Date(Number(value)).toISOString();
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
}
