import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalInbox, createInboxApprovalHandler } from "../src/core/approval-inbox.js";
import { createApprovalNotifier, normalizeNotifyConfig } from "../src/core/approval-notify.js";

const approval = {
  id: "abc",
  operationKind: "shell",
  agent: "builder",
  runId: "run-1",
  expiresAt: "2026-10-02T00:00:00.000Z",
  details: { command: "rm -rf build", fingerprint: "f" },
};

function recorder(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status };
  };
  return { calls, fetchImpl };
}

test("nothing configured, nothing sent", () => {
  assert.equal(createApprovalNotifier(undefined), undefined);
  assert.equal(createApprovalNotifier({}), undefined);
});

test("the address must be https, or http to this machine", () => {
  assert.throws(() => normalizeNotifyConfig({ url: "http://ntfy.example/x" }), /https/);
  assert.throws(() => normalizeNotifyConfig({ url: "not an address" }), /address/);
  assert.throws(() => normalizeNotifyConfig({ url: "https://ntfy.sh/x", format: "xml" }), /format/);
  assert.equal(normalizeNotifyConfig({ url: "http://127.0.0.1:8080/hook" }).host, "127.0.0.1");
});

test("the notification says that something waits, not what it is", async () => {
  const { calls, fetchImpl } = recorder();
  await createApprovalNotifier({ url: "https://hooks.example/a" }, { fetchImpl })(approval);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { event: "approval.pending", id: "abc", kind: "shell", agent: "builder", runId: "run-1", expiresAt: approval.expiresAt });
  assert.doesNotMatch(calls[0].init.body, /rm -rf/);
  assert.equal(calls[0].init.redirect, "error");
});

test("details are sent only when asked for", async () => {
  const { calls, fetchImpl } = recorder();
  await createApprovalNotifier({ url: "https://hooks.example/a", includeDetails: true }, { fetchImpl })(approval);
  assert.equal(JSON.parse(calls[0].init.body).details.command, "rm -rf build");
});

test("ntfy format is plain text with a title", async () => {
  const { calls, fetchImpl } = recorder();
  await createApprovalNotifier({ url: "https://ntfy.sh/topic", format: "ntfy" }, { fetchImpl })(approval);
  assert.equal(calls[0].init.headers.Title, "ETNPilot needs a decision");
  assert.match(calls[0].init.body, /shell by builder is waiting/);
  assert.match(calls[0].init.body, /etnpilot approval show abc/);
});

test("a failed delivery is reported without the address and never thrown", async () => {
  const errors = [];
  const failing = createApprovalNotifier({ url: "https://ntfy.sh/secret-topic" }, {
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
    onError: (error) => errors.push(error.message),
  });
  await failing(approval);
  const refused = createApprovalNotifier({ url: "https://ntfy.sh/secret-topic" }, { fetchImpl: recorder(500).fetchImpl, onError: (error) => errors.push(error.message) });
  await refused(approval);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /ntfy\.sh/);
  assert.match(errors[1], /500/);
  assert.equal(errors.some((message) => message.includes("secret-topic")), false);
});

test("the inbox handler announces a new request and still waits for the decision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "etnpilot-notify-"));
  const inbox = new ApprovalInbox(join(dir, "approvals.sqlite"));
  const { calls, fetchImpl } = recorder();
  const handler = createInboxApprovalHandler({
    inbox,
    pollIntervalMs: 10,
    notifier: createApprovalNotifier({ url: "https://hooks.example/a" }, { fetchImpl }),
  });
  const decision = handler({ kind: "shell", fullCommandText: "ls" }, { agent: "builder", runId: "r" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 1);
  const [pending] = inbox.list({ status: "pending" });
  assert.equal(JSON.parse(calls[0].init.body).id, pending.id);
  inbox.decide(pending.id, "approved", { actor: "test" });
  assert.equal((await decision).kind, "approve-once");
  inbox.close();
});
