import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { createGitLabApprovalHandler } from "../src/gitlab/approvals.js";

test("a GitLab comment approves only when an allowed user wrote it", async () => {
  const { inbox } = await createInbox();
  const notes = [];
  let posted = [];
  const client = {
    addIssueNote: async (_project, _iid, body) => posted.push(body),
    issueNotes: async () => notes,
  };
  const handler = createGitLabApprovalHandler({
    inbox,
    client,
    project: "group/project",
    issueIid: 7,
    allowedApprovers: ["maintainer"],
    pollIntervalMs: 100,
  });

  const decision = handler({ kind: "shell", fullCommandText: "npm test" }, { runId: "run-1", agent: "builder" });
  const pending = await waitFor(() => inbox.list()[0]);

  // An outsider's command is ignored, as is a maintainer's command for another id.
  notes.push({ id: 1, body: `/etnpilot approve ${pending.id}`, author: { username: "stranger" }, created_at: isoNow() });
  notes.push({ id: 2, body: "/etnpilot approve 00000000", author: { username: "maintainer" }, created_at: isoNow() });
  await delay(250);
  assert.equal(inbox.get(pending.id).status, "pending");

  notes.push({ id: 3, body: `/etnpilot approve ${pending.id.slice(0, 8)}`, author: { username: "maintainer" }, created_at: isoNow() });
  const result = await decision;

  assert.equal(result.kind, "approve-once");
  assert.equal(result.evidence.decidedBy, "gitlab:maintainer");
  assert.equal(result.evidence.source, "gitlab-note");
  assert.equal(inbox.get(pending.id).status, "approved");
  // The request and the outcome are both posted back to the issue.
  assert.match(posted[0], /needs approval.*shell/s);
  assert.match(posted[0], /\/etnpilot approve/);
  assert.match(posted.at(-1), /is \*\*approved\*\* \(by `gitlab:maintainer`\)/);
  inbox.close();
});

test("a GitLab rejection carries its reason and the CLI can decide first", async () => {
  const { inbox } = await createInbox();
  const notes = [];
  const client = { addIssueNote: async () => {}, issueNotes: async () => notes };
  const handler = createGitLabApprovalHandler({
    inbox,
    client,
    project: "group/project",
    issueIid: 7,
    allowedApprovers: ["maintainer"],
    pollIntervalMs: 100,
  });

  const rejected = handler({ kind: "write", fileName: "src/x.js" }, {});
  const pending = await waitFor(() => inbox.list()[0]);
  notes.push({
    id: 1,
    body: `/etnpilot reject ${pending.id} not this file\u0007`,
    author: { username: "maintainer" },
    created_at: isoNow(),
  });
  const rejection = await rejected;
  assert.equal(rejection.kind, "reject");
  assert.equal(rejection.reason, "not this file\\u{0007}");

  // A decision made through the CLI resolves the same request.
  const viaCli = handler({ kind: "write", fileName: "src/y.js" }, {});
  const second = await waitFor(() => inbox.list().find((entry) => entry.details.file === "src/y.js"));
  inbox.decide(second.id, "approved", { actor: "maintainer" });
  assert.equal((await viaCli).kind, "approve-once");
  inbox.close();
});

test("comment approvals require an explicit approver list", async () => {
  const { inbox } = await createInbox();
  assert.throws(
    () => createGitLabApprovalHandler({ inbox, client: {}, project: "g/p", issueIid: 1, allowedApprovers: [] }),
    /allowedApprovers must name at least one GitLab user/,
  );
  inbox.close();
});

function isoNow() {
  return new Date(Date.now() + 1000).toISOString();
}

async function waitFor(read) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for the approval record.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createInbox() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-gitlab-approvals-"));
  return { root, inbox: new ApprovalInbox(join(root, "approvals.sqlite")) };
}
