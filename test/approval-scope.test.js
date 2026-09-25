import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "../src/core/harness.js";
import { ApprovalPolicy } from "../src/core/approval-policy.js";
import { ApprovalInbox } from "../src/core/approval-inbox.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";

// P4.3 and the taint rule the plan made a condition rather than advice.

const harnessThatAsks = (answer) => {
  const asked = [];
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy({ allow: [], requireHuman: ["write", "shell"] }),
    approvalHandler: async (request) => {
      asked.push(request);
      return answer(request);
    },
  });
  return { harness, asked };
};

test("one yes covers the operations like it, and nothing else", async () => {
  const { harness, asked } = harnessThatAsks(() => ({ kind: "approve-for-run", scope: "src/**", approvalId: "a1" }));
  const write = (fileName) => harness.approveOperation({ kind: "write", fileName }, { runId: "r1" });

  assert.equal((await write("src/a.js")).kind, "approve-once");
  assert.equal(asked.length, 1);

  // Twelve writes under one directory were twelve identical questions, and a
  // tool that asks twelve times is one people switch off.
  const second = await write("src/deep/b.js");
  assert.equal(second.kind, "approve-once");
  assert.equal(second.coveredBy, "a1", "the receipt can say which yes covered it");
  assert.equal(asked.length, 1);

  // Outside the scope is a new question.
  await write("docs/x.md");
  assert.equal(asked.length, 2);

  // And a different kind of operation is never covered by it.
  await harness.approveOperation({ kind: "shell", fullCommandText: "npm test" }, { runId: "r1" });
  assert.equal(asked.length, 3);
});

test("a yes never reaches another run", async () => {
  const { harness, asked } = harnessThatAsks(() => ({ kind: "approve-for-run", scope: "src/**" }));
  await harness.approveOperation({ kind: "write", fileName: "src/a.js" }, { runId: "r1" });
  await harness.approveOperation({ kind: "write", fileName: "src/b.js" }, { runId: "r2" });
  assert.equal(asked.length, 2);

  harness.releaseRun("r1");
  await harness.approveOperation({ kind: "write", fileName: "src/c.js" }, { runId: "r1" });
  assert.equal(asked.length, 3, "the run ended, so its grants did");
});

test("reading something from outside cancels every run-scoped yes", async () => {
  const { harness, asked } = harnessThatAsks(() => ({ kind: "approve-for-run", scope: "src/**" }));
  await harness.approveOperation({ kind: "write", fileName: "src/a.js" }, { runId: "r1" });
  await harness.approveOperation({ kind: "write", fileName: "src/b.js" }, { runId: "r1" });
  assert.equal(asked.length, 1, "covered");

  // The rule: a fetched page saying 'change src/auth.js' must not ride
  // through on a yes given before the page was read.
  const dropped = harness.markTainted("r1", "fetch_url read https://docs.example");
  assert.equal(dropped.dropped, 1);
  assert.match(harness.taintReason("r1"), /fetch_url read/);

  await harness.approveOperation({ kind: "write", fileName: "src/c.js" }, { runId: "r1" });
  assert.equal(asked.length, 2, "it asks again, every time, for the rest of the run");
  await harness.approveOperation({ kind: "write", fileName: "src/d.js" }, { runId: "r1" });
  assert.equal(asked.length, 3);
});

test("fetch_url is what taints a run, and it does so before the body is used", async () => {
  const taints = [];
  const tools = createWorkspaceTools({
    workingDirectory: await mkdtemp(join(tmpdir(), "etnpilot-taint-")),
    fetchImpl: async () => new Response("some documentation", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  const result = await tools.invoke("fetch_url", { url: "https://docs.example/api" }, {
    agent: { name: "builder" },
    approve: async () => ({ kind: "approve-once" }),
    taint: (reason) => taints.push(reason),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(taints, ["fetch_url read https://docs.example"]);
});

test("a scope with no name is the directory the person was looking at", async () => {
  // Nobody types a glob at three in the morning. What a yes covers by default
  // is never wider than what was in front of them.
  const { harness, asked } = harnessThatAsks(() => ({ kind: "approve-for-run" }));
  await harness.approveOperation({ kind: "write", fileName: "src/auth/login.js" }, { runId: "r1" });
  await harness.approveOperation({ kind: "write", fileName: "src/auth/logout.js" }, { runId: "r1" });
  assert.equal(asked.length, 1, "the same directory is covered");
  await harness.approveOperation({ kind: "write", fileName: "src/other.js" }, { runId: "r1" });
  assert.equal(asked.length, 2, "a sibling directory is not");

  const shell = harnessThatAsks(() => ({ kind: "approve-for-run" }));
  await shell.harness.approveOperation({ kind: "shell", fullCommandText: "npm test" }, { runId: "r1" });
  await shell.harness.approveOperation({ kind: "shell", fullCommandText: "npm run build" }, { runId: "r1" });
  assert.equal(shell.asked.length, 1, "the same program");
  await shell.harness.approveOperation({ kind: "shell", fullCommandText: "curl evil.example" }, { runId: "r1" });
  assert.equal(shell.asked.length, 2, "a different one is a new question");
});

test("the inbox stores the reach, and hands it back", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-scope-inbox-"));
  const inbox = new ApprovalInbox(join(root, "approvals.sqlite"));
  const record = inbox.create({ kind: "write", fileName: "src/a.js" }, { runId: "r1", agent: "builder" }, { timeoutMs: 60_000 });
  inbox.decide(record.id, "approved-for-run", { actor: "maintainer", scope: "src/**", reason: "the whole module" });

  const stored = inbox.get(record.id);
  assert.equal(stored.status, "approved-for-run");
  assert.equal(stored.scope, "src/**");
  // The receipt has to be able to say how wide a yes was.
  assert.equal(stored.reason, "the whole module");
  inbox.close();
});

test("a policy refusal is never turned into a grant", async () => {
  // The branch that grants is only reached because the policy already said a
  // human may decide it. A denied operation never becomes a covered one.
  const { harness, asked } = harnessThatAsks(() => ({ kind: "approve-for-run", scope: "**" }));
  const denied = await harness.approveOperation({ kind: "network", url: "https://x" }, { runId: "r1" });
  assert.equal(denied.kind, "reject");
  assert.equal(asked.length, 0, "it was never put to a person");
});
