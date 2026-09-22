import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  ApprovalInbox,
  ApprovalStateError,
  createInboxApprovalHandler,
} from "../src/core/approval-inbox.js";

test("approval inbox persists redacted operation summaries", async () => {
  const { inbox } = await createInbox();
  try {
    const approval = inbox.create({
      kind: "shell",
      fullCommandText: "API_TOKEN=secret curl -H 'Authorization: Bearer hidden' https://example.test/run?token=hidden",
    }, { runId: "run-1", agent: "builder" }, { timeoutMs: 60_000 });
    assert.equal(approval.status, "pending");
    assert.equal(approval.runId, "run-1");
    assert.match(approval.details.command, /API_TOKEN=\[redacted\]/);
    assert.match(approval.details.command, /Bearer \[redacted\]/);
    assert.match(approval.details.command, /\?\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(approval), /secret|hidden/);
    assert.equal(inbox.list()[0].id, approval.id);
  } finally {
    inbox.close();
  }
});

test("approval decisions are atomic across inbox instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-approval-atomic-"));
  const database = join(root, "approvals.sqlite");
  const first = new ApprovalInbox(database);
  const second = new ApprovalInbox(database);
  try {
    const approval = first.create({ kind: "write", fileName: "src/result.js" }, { runId: "run-2" });
    const decided = second.decide(approval.id, "approved", { actor: "reviewer" });
    assert.equal(decided.status, "approved");
    assert.equal(first.get(approval.id).decidedBy, "reviewer");
    assert.throws(
      () => first.decide(approval.id, "rejected"),
      (error) => error instanceof ApprovalStateError && error.code === "already_decided",
    );
  } finally {
    first.close();
    second.close();
  }
});

test("inbox approval handler waits for an external decision", async () => {
  const { inbox } = await createInbox();
  try {
    const handler = createInboxApprovalHandler({ inbox, timeoutMs: 1_000, pollIntervalMs: 10 });
    const resultPromise = handler({ kind: "write", fileName: "src/result.js" }, { runId: "run-3", agent: "builder" });
    let pending;
    for (let attempt = 0; attempt < 20 && !pending; attempt += 1) {
      pending = inbox.list()[0];
      if (!pending) await delay(5);
    }
    inbox.decide(pending.id, "approved", { actor: "maintainer", reason: "Reviewed" });
    const decision = await resultPromise;
    assert.equal(decision.kind, "approve-once");
    assert.equal(decision.approvalId, pending.id);
    assert.equal(decision.evidence.decidedBy, "maintainer");
  } finally {
    inbox.close();
  }
});

test("inbox approval handler rejects expired requests", async () => {
  const { inbox } = await createInbox();
  try {
    const handler = createInboxApprovalHandler({ inbox, timeoutMs: 20, pollIntervalMs: 10 });
    const decision = await handler({ kind: "network", url: "https://example.test/private?token=x" }, {
      runId: "run-4", agent: "builder",
    });
    assert.equal(decision.kind, "reject");
    assert.match(decision.reason, /expired/i);
    assert.equal(inbox.get(decision.approvalId).status, "expired");
  } finally {
    inbox.close();
  }
});

async function createInbox() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-approval-inbox-"));
  return { root, inbox: new ApprovalInbox(join(root, "approvals.sqlite")) };
}
