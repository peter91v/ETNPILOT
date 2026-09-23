import { setTimeout as delay } from "node:timers/promises";
import { ApprovalStateError } from "../core/approval-inbox.js";
import { escapeControlCharacters } from "../core/text-safety.js";

const COMMAND = /^\s*\/etnpilot\s+(approve|reject)\s+([0-9a-f-]{8,36})\s*(.*)$/im;

// Approvals from the place the work was requested, with an identity GitLab
// itself asserts: the note author is reported by the API, not typed by the
// person deciding. Decisions are still recorded in the durable inbox, so
// `etnpilot approval` and a GitLab comment are two doors into one room.
export function createGitLabApprovalHandler({
  inbox,
  client,
  project,
  issueIid,
  allowedApprovers = [],
  timeoutMs = 24 * 60 * 60_000,
  pollIntervalMs = 5_000,
  serviceInstanceId,
  signal,
  onPending = () => {},
  onResolved = () => {},
  onError = () => {},
} = {}) {
  if (!inbox) throw new TypeError("A GitLab approval handler requires the approval inbox.");
  if (!client || !project || !Number.isInteger(issueIid)) {
    throw new TypeError("A GitLab approval handler requires a client, project, and issue IID.");
  }
  if (!Array.isArray(allowedApprovers) || allowedApprovers.length === 0) {
    throw new TypeError("git.issueTrigger.approvals.allowedApprovers must name at least one GitLab user.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new TypeError("Approval pollIntervalMs must be at least 100.");
  }
  const approvers = new Set(allowedApprovers);

  return async (request, context) => {
    const pending = inbox.create(request, context, { timeoutMs, serviceInstanceId });
    await onPending(pending);
    const requestedAt = Date.parse(pending.createdAt);
    await client.addIssueNote(project, issueIid, requestNote(pending)).catch(onError);

    let record = pending;
    let aborted = false;
    try {
      while (record.status === "pending") {
        await delay(pollIntervalMs, undefined, { signal });
        // A decision may also have arrived through the CLI.
        record = inbox.get(pending.id);
        if (record.status !== "pending") break;
        const comment = await findDecision({ client, project, issueIid, approvers, id: pending.id, requestedAt })
          .catch((error) => (onError(error), undefined));
        if (!comment) continue;
        record = applyDecision(inbox, pending.id, comment);
      }
    } catch (error) {
      if (error.name !== "AbortError") throw error;
      aborted = true;
      record = rejectPending(inbox, pending.id, "Service is shutting down.");
    }

    await onResolved(record);
    await client.addIssueNote(project, issueIid, decisionNote(record)).catch(onError);
    if (aborted) {
      return {
        kind: "reject",
        reason: "Approval wait stopped because the service is shutting down.",
        approvalId: record.id,
        evidence: evidence(record),
      };
    }
    return record.status === "approved"
      ? { kind: "approve-once", approvalId: record.id, evidence: evidence(record) }
      : {
          kind: "reject",
          reason: record.status === "expired" ? "Approval request expired." : record.reason ?? "Rejected by the reviewer.",
          approvalId: record.id,
          evidence: evidence(record),
        };
  };
}

async function findDecision({ client, project, issueIid, approvers, id, requestedAt }) {
  const notes = await client.issueNotes(project, issueIid);
  for (const note of notes) {
    if (note.system === true) continue;
    // Identity comes from GitLab's own record of who wrote the note.
    const author = note.author?.username;
    if (!author || !approvers.has(author)) continue;
    if (Date.parse(note.created_at) < requestedAt) continue;
    const match = COMMAND.exec(String(note.body ?? ""));
    if (!match) continue;
    const [, verb, reference, rest] = match;
    if (!id.startsWith(reference.toLowerCase())) continue;
    return {
      decision: verb.toLowerCase() === "approve" ? "approved" : "rejected",
      actor: `gitlab:${author}`,
      noteId: note.id,
      reason: rest?.trim() ? escapeControlCharacters(rest.trim()).slice(0, 500) : undefined,
    };
  }
  return undefined;
}

function applyDecision(inbox, id, comment) {
  try {
    return inbox.decide(id, comment.decision, { actor: comment.actor, reason: comment.reason });
  } catch (error) {
    // The CLI may have decided the same request first; its record wins.
    if (!(error instanceof ApprovalStateError)) throw error;
    return inbox.get(id);
  }
}

function rejectPending(inbox, id, reason) {
  try {
    return inbox.decide(id, "rejected", { actor: "service", reason });
  } catch (error) {
    if (!(error instanceof ApprovalStateError)) throw error;
    return inbox.get(id);
  }
}

function requestNote(pending) {
  const details = pending.details ?? {};
  const lines = [
    `**ETNPilot needs approval** for a \`${pending.operationKind}\` operation in run \`${pending.runId ?? "unknown"}\`.`,
    "",
  ];
  if (details.command) lines.push("Command:", "```", details.command, "```");
  if (details.file) lines.push(`File: \`${details.file}\``);
  if (details.url) lines.push(`URL: ${details.url}`);
  if (details.tool) lines.push(`Tool: \`${details.tool}\``);
  if (details.truncated) lines.push("_The operation text was truncated; inspect it with `etnpilot approval show`._");
  lines.push(
    "",
    `Reply with \`/etnpilot approve ${pending.id}\` or \`/etnpilot reject ${pending.id} <reason>\`.`,
    `Expires ${pending.expiresAt}.`,
  );
  return lines.join("\n");
}

function decisionNote(record) {
  return `ETNPilot approval \`${record.id}\` is **${record.status}**`
    + `${record.decidedBy ? ` (by \`${record.decidedBy}\`)` : ""}`
    + `${record.reason ? `: ${escapeControlCharacters(record.reason)}` : "."}`;
}

function evidence(record) {
  return {
    operationKind: record.operationKind,
    details: record.details,
    status: record.status,
    decidedBy: record.decidedBy,
    decidedAt: record.decidedAt,
    source: "gitlab-note",
  };
}
