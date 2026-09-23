import assert from "node:assert/strict";
import { test } from "node:test";
import { latestPipeline, waitForPipeline } from "../src/gitlab/pipelines.js";
import { GitLabIssueTrigger } from "../src/gitlab/issue-trigger.js";

test("pipeline polling settles on a terminal state", async () => {
  const observed = [
    [{ id: 1, status: "running", ref: "etnpilot/run-1", web_url: "https://gitlab.invalid/p/1" }],
    [{ id: 1, status: "success", ref: "etnpilot/run-1", web_url: "https://gitlab.invalid/p/1" }],
  ];
  let call = 0;
  const result = await waitForPipeline({
    client: { pipelines: async () => observed[Math.min(call++, observed.length - 1)] },
    project: "group/project",
    ref: "etnpilot/run-1",
    pollIntervalMs: 100,
  });

  assert.equal(result.settled, true);
  assert.equal(result.status, "success");
  assert.equal(result.webUrl, "https://gitlab.invalid/p/1");
  assert.equal(latestPipeline([{ id: 1 }, { id: 9 }, { id: 4 }]).id, 9);
  assert.equal(latestPipeline([]), undefined);
});

test("pipeline polling gives up with an explicit reason", async () => {
  let clock = 0;
  const stillRunning = await waitForPipeline({
    client: { pipelines: async () => [{ id: 2, status: "running" }] },
    project: "group/project",
    ref: "main",
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => (clock += 60),
  });
  assert.deepEqual(stillRunning, { id: 2, status: "running", ref: undefined, sha: undefined, webUrl: undefined, updatedAt: undefined, settled: false, reason: "timeout" });

  clock = 0;
  const none = await waitForPipeline({
    client: { pipelines: async () => [] },
    project: "group/project",
    ref: "main",
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => (clock += 60),
  });
  assert.deepEqual(none, { settled: false, reason: "no-pipeline" });
});

test("a failed pipeline turns the issue commit status red", async () => {
  const statuses = [];
  const notes = [];
  const trigger = new GitLabIssueTrigger({
    root: process.cwd(),
    config: { git: { project: "group/project", targetBranch: "main", issueTrigger: {
      enabled: true, comment: true, awaitPipeline: true, publish: true, fetchBeforeRun: false,
    } } },
    client: {
      setCommitStatus: async (_project, sha, status) => statuses.push({ sha, ...status }),
      addIssueNote: async (_project, _iid, body) => notes.push(body),
      pipelines: async () => [{ id: 5, status: "failed", web_url: "https://gitlab.invalid/p/5" }],
    },
    run: async () => ({
      runId: "run-1",
      receiptHash: "receipt-1",
      workspace: { branch: "etnpilot/run-1" },
      mergeRequest: { web_url: "https://gitlab.invalid/mr/1" },
    }),
  });

  const result = await trigger.execute({
    object_attributes: { iid: 7, title: "t", url: "https://gitlab.invalid/i/7" },
    project: { default_branch: "main" },
  }, "delivery-1", { checkpoint: async () => {} });

  assert.equal(result.pipeline.status, "failed");
  assert.deepEqual(statuses.map((status) => status.state), ["running", "failed"]);
  assert.match(statuses[1].description, /pipeline failed/);
  assert.match(notes.at(-1), /Pipeline failed: https:\/\/gitlab\.invalid\/p\/5/);
});
