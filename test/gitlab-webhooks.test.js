import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitLabIssueTrigger } from "../src/gitlab/issue-trigger.js";
import { authenticateGitLabWebhook } from "../src/gitlab/webhook-auth.js";
import { createGitLabWebhookServer } from "../src/gitlab/webhook-server.js";
import { git } from "../src/git/command.js";

test("webhook authentication verifies signatures, timestamps, and legacy tokens", () => {
  const key = Buffer.from("test-signing-key");
  const signingSecret = `whsec_${key.toString("base64")}`;
  const rawBody = '{"object_kind":"issue"}';
  const timestamp = "1790060000";
  const messageId = "delivery-1";
  const signature = `v1,${createHmac("sha256", key).update(`${messageId}.${timestamp}.${rawBody}`).digest("base64")}`;
  const signed = authenticateGitLabWebhook({
    headers: { "webhook-id": messageId, "webhook-timestamp": timestamp, "webhook-signature": signature },
    rawBody,
    signingSecret,
    now: Number(timestamp) * 1000,
  });
  assert.equal(signed.authenticated, true);
  assert.equal(authenticateGitLabWebhook({
    headers: { "webhook-id": messageId, "webhook-timestamp": timestamp, "webhook-signature": signature },
    rawBody: `${rawBody} `,
    signingSecret,
    now: Number(timestamp) * 1000,
  }).authenticated, false);
  assert.equal(authenticateGitLabWebhook({
    headers: { "webhook-id": messageId, "webhook-timestamp": timestamp, "webhook-signature": signature },
    rawBody,
    signingSecret,
    now: (Number(timestamp) + 301) * 1000,
  }).reason, "timestamp-outside-tolerance");
  assert.equal(authenticateGitLabWebhook({
    headers: { "x-gitlab-token": "legacy-secret" }, rawBody, token: "legacy-secret",
  }).authenticated, true);
});

test("issue trigger filters project, labels, users, actions, and confidential issues", () => {
  const trigger = new GitLabIssueTrigger({
    root: ".",
    config: { git: { project: "group/project", issueTrigger: {
      enabled: true, labels: ["etnpilot"], actions: ["open"], allowedUsers: ["maintainer"],
    } } },
    client: {},
  });
  const payload = issuePayload();
  assert.equal(trigger.matches("Issue Hook", payload).matched, true);
  assert.equal(trigger.matches("Issue Hook", { ...payload, user: { username: "guest" } }).reason, "user-not-allowed");
  assert.equal(trigger.matches("Issue Hook", {
    ...payload, object_attributes: { ...payload.object_attributes, confidential: true },
  }).reason, "confidential-issue");
  assert.equal(trigger.matches("Issue Hook", { ...payload, labels: [] }).reason, "required-label-missing");
});

test("issue trigger runs the workflow and synchronizes commit status", async () => {
  const root = await createRepository("etnpilot-trigger-");
  const statuses = [];
  let seenApprovalHandler;
  const trigger = new GitLabIssueTrigger({
    root,
    config: { git: { project: "group/project", targetBranch: "main", issueTrigger: {
      enabled: true, labels: ["etnpilot"], actions: ["open"], syncStatus: true,
    } } },
    env: { ETNPILOT_GITLAB_TOKEN: "api-token" },
    client: {
      setCommitStatus: async (_project, sha, status) => statuses.push({ sha, ...status }),
      addIssueNote: async () => {},
    },
    run: async ({ input, publish, approvalHandler }) => {
      seenApprovalHandler = approvalHandler;
      return {
        runId: "run-1",
        receiptHash: "receipt-1",
        workspace: { branch: "etnpilot/run-1" },
        mergeRequest: undefined,
        input,
        publish,
      };
    },
  });
  const result = await trigger.execute(issuePayload(), "delivery-1", {
    jobId: "job-1",
    approvalHandler: async () => ({ kind: "approve-once" }),
    checkpoint: async () => {},
  });
  assert.equal(result.status, "succeeded");
  assert.equal(typeof seenApprovalHandler, "function");
  assert.deepEqual(statuses.map((status) => status.state), ["running", "success"]);
  assert.equal(statuses[0].name, "etnpilot/issue-7");
});

test("webhook server acknowledges quickly and deduplicates deliveries", async () => {
  const root = await createRepository("etnpilot-webhook-server-");
  await mkdir(join(root, ".etnpilot", "secrets"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "secrets", "webhook-token"), "hook-secret\n", { mode: 0o600 });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "secrets:",
    "  providers:",
    "    local: { type: file, root: .etnpilot/secrets }",
    "  values:",
    "    gitlab.webhookToken: { provider: local, key: webhook-token }",
    "git:",
    "  baseUrl: https://gitlab.example.invalid",
    "  project: group/project",
    "  webhook:",
    "    host: 127.0.0.1",
    "    port: 0",
    "  issueTrigger:",
    "    enabled: true",
    "    labels: [etnpilot]",
    "    actions: [open]",
    "    allowedUsers: [maintainer]",
    "    syncStatus: false",
    "    comment: false",
    "    publish: false",
    "",
  ].join("\n"));
  let runs = 0;
  let approvalDecision;
  const app = await createGitLabWebhookServer({
    root,
    env: {},
    run: async ({ approvalHandler }) => {
      runs += 1;
      approvalDecision = await approvalHandler(
        { kind: "write", fileName: "src/generated.js" },
        { runId: "run-1", agent: "builder" },
      );
      return { runId: "run-1", receiptHash: "receipt-1", workspace: { branch: "main" } };
    },
    onError: (error) => { throw error; },
  });
  try {
    const address = await app.listen({ port: 0 });
    const url = `http://127.0.0.1:${address.port}/webhooks/gitlab`;
    const request = () => fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-token": "hook-secret",
        "x-gitlab-event": "Issue Hook",
        "idempotency-key": "delivery-7",
      },
      body: JSON.stringify(issuePayload()),
    });
    const first = await request();
    const duplicate = await request();
    assert.equal(first.status, 202);
    const accepted = await first.json();
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    let pending;
    for (let attempt = 0; attempt < 20 && !pending; attempt += 1) {
      pending = app.approvalInbox.list()[0];
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(pending.workflowJobId, accepted.jobId);
    app.approvalInbox.decide(pending.id, "approved", { actor: "maintainer" });
    await app.drain();
    assert.equal(runs, 1);
    assert.equal(approvalDecision.kind, "approve-once");
    assert.equal(app.workflowQueue.getByDeliveryId("delivery-7").status, "succeeded");
  } finally {
    await app.close();
  }
});

function issuePayload() {
  return {
    object_kind: "issue",
    user: { username: "maintainer" },
    project: { path_with_namespace: "group/project", default_branch: "main" },
    labels: [{ title: "etnpilot" }],
    object_attributes: {
      iid: 7,
      action: "open",
      title: "Add health endpoint",
      description: "Implement a health endpoint with tests.",
      url: "https://gitlab.example.invalid/group/project/-/issues/7",
      confidential: false,
    },
  };
}

test("the issue trigger refuses to run without an explicit user allow-list", async () => {
  const root = await createRepository("etnpilot-webhook-users-");
  await mkdir(join(root, ".etnpilot", "secrets"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "secrets", "webhook-token"), "hook-secret\n", { mode: 0o600 });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "secrets:",
    "  providers:",
    "    local: { type: file, root: .etnpilot/secrets }",
    "  values:",
    "    gitlab.webhookToken: { provider: local, key: webhook-token }",
    "git:",
    "  baseUrl: https://gitlab.example.invalid",
    "  project: group/project",
    "  issueTrigger:",
    "    enabled: true",
    "    labels: [etnpilot]",
    "    syncStatus: false",
    "",
  ].join("\n"));

  await assert.rejects(
    () => createGitLabWebhookServer({ root, env: {}, run: async () => ({}) }),
    /allowedUsers must name at least one GitLab user/,
  );
});

test("the webhook server answers a local health probe without exposing events", async () => {
  const root = await createRepository("etnpilot-webhook-health-");
  await mkdir(join(root, ".etnpilot", "secrets"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "secrets", "webhook-token"), "hook-secret\n", { mode: 0o600 });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "secrets:",
    "  providers:",
    "    local: { type: file, root: .etnpilot/secrets }",
    "  values:",
    "    gitlab.webhookToken: { provider: local, key: webhook-token }",
    "git:",
    "  baseUrl: https://gitlab.example.invalid",
    "  project: group/project",
    "",
  ].join("\n"));

  const app = await createGitLabWebhookServer({ root, env: {}, run: async () => ({}) });
  try {
    const address = await app.listen({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.issueTrigger, false);
    assert.equal(typeof body.queue, "object");
  } finally {
    await app.close();
  }
});

async function createRepository(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await git(["init", "-b", "main"], { cwd: root });
  await git(["config", "user.email", "test@example.invalid"], { cwd: root });
  await git(["config", "user.name", "ETNPilot Test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# test\n");
  await git(["add", "."], { cwd: root });
  await git(["commit", "-m", "initial"], { cwd: root });
  return root;
}
