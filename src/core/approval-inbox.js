import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { redactSecrets, sanitizeForDisplay } from "./text-safety.js";

const DECISIONS = new Set(["approved", "rejected"]);
const STATUSES = new Set(["pending", "approved", "rejected", "expired", "all"]);

export class ApprovalInbox {
  constructor(databasePath, { now = Date.now, redact = false, maxDetailLength = 8192 } = {}) {
    this.path = resolve(databasePath);
    this.now = now;
    // Full fidelity by default: an operator can only approve what they see.
    // Projects that would rather mask credential-looking text opt in.
    this.redact = redact === true;
    this.maxDetailLength = maxDetailLength;
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
    ensureColumn(this.database, "approvals", "workflow_job_id", "TEXT");
    ensureColumn(this.database, "approvals", "policy_json", "TEXT");
    this.database.exec("CREATE INDEX IF NOT EXISTS approvals_workflow_job ON approvals(workflow_job_id, created_at);");
  }

  create(request, context = {}, { timeoutMs = 24 * 60 * 60_000, serviceInstanceId } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Approval timeoutMs must be positive.");
    const createdAt = this.now();
    const record = {
      id: randomUUID(),
      status: "pending",
      runId: context.runId,
      workflowJobId: context.queueJobId,
      agent: context.agent,
      operationKind: request?.kind ?? "unknown",
      policy: context.policy,
      details: summarizeApprovalRequest(request, {
        redact: this.redact,
        maxLength: this.maxDetailLength,
      }),
      createdAt,
      expiresAt: createdAt + timeoutMs,
      serviceInstanceId,
    };
    this.database.prepare(`
      INSERT INTO approvals(
        id, status, run_id, workflow_job_id, agent, operation_kind, details_json,
        policy_json, created_at, expires_at, service_instance_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.status,
      record.runId ?? null,
      record.workflowJobId ?? null,
      record.agent ?? null,
      record.operationKind,
      JSON.stringify(record.details),
      record.policy ? JSON.stringify(record.policy) : null,
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

// A reviewer approves what they can read in full: the whole command and the
// whole URL, not an abbreviated summary. The fingerprint is taken over the
// original request, so display limits can never change what was identified.
export function summarizeApprovalRequest(request = {}, { redact = false, maxLength = 8192 } = {}) {
  const details = {};
  const present = (value, { allowNewlines = false } = {}) => {
    const sanitized = sanitizeForDisplay(redact ? redactSecrets(value) : value, { maxLength, allowNewlines });
    if (sanitized.truncated) details.truncated = true;
    return sanitized.text;
  };
  if (request.fileName) details.file = present(request.fileName);
  if (request.fullCommandText) details.command = present(request.fullCommandText);
  if (request.toolName) details.tool = present(request.toolName);
  if (request.toolArguments !== undefined) details.arguments = present(stringify(request.toolArguments));
  // What the change actually is. A write used to be described by its size,
  // which is not something a person can judge — see src/providers/text-diff.js.
  // The one field that is several lines by nature: escaping its newlines
  // turns a diff into one unreadable line, which is what a reviewer was
  // given before. Everything else in it is still escaped.
  if (request.diff) details.diff = present(request.diff, { allowNewlines: true });
  if (request.url) {
    details.url = present(request.url);
    details.origin = safeOrigin(request.url);
  }
  if (redact) details.redacted = true;
  details.fingerprint = createHash("sha256").update(JSON.stringify({
    kind: request?.kind ?? "unknown",
    fileName: request.fileName ?? null,
    command: request.fullCommandText ?? null,
    tool: request.toolName ?? null,
    arguments: request.toolArguments === undefined ? null : stringify(request.toolArguments),
    url: request.url ?? null,
    // The diff is part of what is being approved, so two writes to the same
    // path with different content are two different decisions.
    diff: request.diff ?? null,
  })).digest("hex");
  return details;
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
}

export class ApprovalStateError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "ApprovalStateError";
    this.code = code;
  }
}

function safeOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return "invalid-url";
  }
}

function fromRow(row) {
  return present({
    id: row.id,
    status: row.status,
    runId: row.run_id ?? undefined,
    workflowJobId: row.workflow_job_id ?? undefined,
    agent: row.agent ?? undefined,
    operationKind: row.operation_kind,
    details: JSON.parse(row.details_json),
    policy: row.policy_json ? JSON.parse(row.policy_json) : undefined,
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
    ...(record.policy ? { policy: record.policy } : {}),
    status: record.status,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
  };
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
