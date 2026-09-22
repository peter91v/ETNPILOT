import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const DECISIONS = new Set(["approved", "rejected"]);
const STATUSES = new Set(["pending", "approved", "rejected", "expired", "all"]);

export class ApprovalInbox {
  constructor(databasePath, { now = Date.now } = {}) {
    this.path = resolve(databasePath);
    this.now = now;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        run_id TEXT,
        agent TEXT,
        operation_kind TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        reason TEXT,
        service_instance_id TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_status_created ON approvals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, created_at);
    `);
  }

  create(request, context = {}, { timeoutMs = 24 * 60 * 60_000, serviceInstanceId } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Approval timeoutMs must be positive.");
    const createdAt = this.now();
    const record = {
      id: randomUUID(),
      status: "pending",
      runId: context.runId,
      agent: context.agent,
      operationKind: request?.kind ?? "unknown",
      details: summarizeApprovalRequest(request),
      createdAt,
      expiresAt: createdAt + timeoutMs,
      serviceInstanceId,
    };
    this.database.prepare(`
      INSERT INTO approvals(
        id, status, run_id, agent, operation_kind, details_json,
        created_at, expires_at, service_instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.status,
      record.runId ?? null,
      record.agent ?? null,
      record.operationKind,
      JSON.stringify(record.details),
      record.createdAt,
      record.expiresAt,
      record.serviceInstanceId ?? null,
    );
    return present(record);
  }

  get(id) {
    this.expire();
    const row = this.database.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list({ status = "pending", limit = 100 } = {}) {
    if (!STATUSES.has(status)) throw new TypeError(`Unsupported approval status: '${status}'.`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Approval list limit must be 1..1000.");
    this.expire();
    const rows = status === "all"
      ? this.database.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit)
      : this.database.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
    return rows.map(fromRow);
  }

  decide(id, decision, { actor = "cli", reason } = {}) {
    if (!DECISIONS.has(decision)) throw new TypeError(`Unsupported approval decision: '${decision}'.`);
    const decidedAt = this.now();
    this.expire();
    const row = this.database.prepare("SELECT status FROM approvals WHERE id = ?").get(id);
    if (!row) throw new ApprovalStateError(`Unknown approval '${id}'.`, { code: "not_found" });
    if (row.status !== "pending") {
      throw new ApprovalStateError(`Approval '${id}' is already ${row.status}.`, { code: "already_decided" });
    }
    const result = this.database.prepare(`
      UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(decision, decidedAt, actor, reason ?? null, id);
    if (Number(result.changes) !== 1) {
      const current = this.database.prepare("SELECT status FROM approvals WHERE id = ?").get(id);
      throw new ApprovalStateError(`Approval '${id}' is already ${current?.status ?? "unknown"}.`, {
        code: "already_decided",
      });
    }
    return this.get(id);
  }

  expire() {
    const now = this.now();
    return Number(this.database.prepare(`
      UPDATE approvals SET status = 'expired', decided_at = ?
      WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now).changes);
  }

  close() {
    this.database.close();
  }
}

export function createInboxApprovalHandler({
  inbox,
  timeoutMs = 24 * 60 * 60_000,
  pollIntervalMs = 500,
  serviceInstanceId = randomUUID(),
  signal,
  onPending = () => {},
  onResolved = () => {},
} = {}) {
  if (!inbox) throw new TypeError("An approval inbox is required.");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new TypeError("Approval pollIntervalMs must be at least 10.");
  }
  return async (request, context) => {
    const pending = inbox.create(request, context, { timeoutMs, serviceInstanceId });
    await onPending(pending);
    let record;
    let aborted = false;
    try {
      while (true) {
        record = inbox.get(pending.id);
        if (record.status !== "pending") break;
        await delay(Math.min(pollIntervalMs, Math.max(1, Date.parse(record.expiresAt) - Date.now())), undefined, { signal });
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
      aborted = true;
      try {
        record = inbox.decide(pending.id, "rejected", { actor: "service", reason: "Service is shutting down." });
      } catch (decisionError) {
        if (!(decisionError instanceof ApprovalStateError)) throw decisionError;
        record = inbox.get(pending.id);
      }
    }
    await onResolved(record);
    if (aborted) {
      return {
        kind: "reject",
        reason: "Approval wait stopped because the service is shutting down.",
        approvalId: record.id,
        evidence: approvalEvidence(record),
      };
    }
    return record.status === "approved"
      ? { kind: "approve-once", approvalId: record.id, evidence: approvalEvidence(record) }
      : {
          kind: "reject",
          reason: record.status === "expired" ? "Approval request expired." : record.reason ?? "Rejected by the user.",
          approvalId: record.id,
          evidence: approvalEvidence(record),
        };
  };
}

export function summarizeApprovalRequest(request = {}) {
  const details = {};
  if (request.fileName) details.file = truncate(String(request.fileName), 500);
  if (request.fullCommandText) details.command = redactCommand(String(request.fullCommandText));
  if (request.toolName) details.tool = truncate(String(request.toolName), 200);
  if (request.url) details.origin = safeOrigin(request.url);
  details.fingerprint = createHash("sha256").update(JSON.stringify({
    kind: request?.kind ?? "unknown",
    ...details,
  })).digest("hex");
  return details;
}

export class ApprovalStateError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "ApprovalStateError";
    this.code = code;
  }
}

function redactCommand(command) {
  return truncate(command, 500)
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|AUTH)[A-Z0-9_]*)=\S+/gi, "$1=[redacted]")
    .replace(/(--?(?:token|secret|password|pass|api-key|authorization))(?:=|\s+)\S+/gi, "$1 [redacted]")
    .replace(/((?:Authorization|PRIVATE-TOKEN|JOB-TOKEN):\s*(?:Bearer\s+|Basic\s+)?)[^\s"']+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?\S+/gi, "$1?[redacted]");
}

function safeOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return "invalid-url";
  }
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function fromRow(row) {
  return present({
    id: row.id,
    status: row.status,
    runId: row.run_id ?? undefined,
    agent: row.agent ?? undefined,
    operationKind: row.operation_kind,
    details: JSON.parse(row.details_json),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at === null ? undefined : Number(row.decided_at),
    decidedBy: row.decided_by ?? undefined,
    reason: row.reason ?? undefined,
    serviceInstanceId: row.service_instance_id ?? undefined,
  });
}

function present(record) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    ...(record.decidedAt === undefined ? {} : { decidedAt: new Date(record.decidedAt).toISOString() }),
  };
}

function approvalEvidence(record) {
  return {
    operationKind: record.operationKind,
    details: record.details,
    status: record.status,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
  };
}
