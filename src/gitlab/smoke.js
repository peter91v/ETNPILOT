import { randomUUID } from "node:crypto";
import { JsonlReceiptStore, verifyReceiptFile } from "../core/receipt-store.js";

// Explicitly opt-in, dedicated test project only. A smoke never merges.
export async function runGitLabSmoke({ client, project, receiptPath, confirmWrites = false, pipelineTimeoutMs = 60_000, pollIntervalMs = 5000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!confirmWrites) throw new Error("GitLab smoke writes require explicit confirmation for an isolated test project.");
  const metadata = await client.project(project);
  if (!/etnpilot-smoke/i.test(metadata.path ?? metadata.name ?? "") || metadata.archived) throw new Error("Use an unarchived dedicated project whose name contains etnpilot-smoke.");
  const branch = `etnpilot/smoke-${randomUUID()}`;
  const target = metadata.default_branch;
  if (!target) throw new Error("The smoke project needs a default branch.");
  const store = new JsonlReceiptStore(receiptPath);
  const operations = [];
  let created;
  let mr;
  let report;
  let failure;
  try {
    await client.createBranch(project, branch, target); created = true; operations.push("branch-created");
    const commit = await client.request("POST", `/projects/${encodeURIComponent(project)}/repository/commits`, {
      branch, commit_message: "ETNPilot isolated integration smoke",
      actions: [{ action: "create", file_path: `etnpilot-smoke-${randomUUID()}.md`, content: "Isolated ETNPilot integration smoke.\n" }],
    });
    operations.push("commit-created");
    mr = await client.createMergeRequest(project, { sourceBranch: branch, targetBranch: target, title: "ETNPilot integration smoke", description: "Opt-in test of the GitLab adapter. Closed and cleaned after inspection.", draft: true });
    operations.push("draft-mr-created");
    if (!mr.draft && !/^Draft:/i.test(mr.title ?? "")) throw new Error("GitLab did not create a Draft MR.");
    const approvals = await client.mergeRequestApprovals(project, mr.iid);
    if (!Number.isSafeInteger(pipelineTimeoutMs) || pipelineTimeoutMs < 0 || pipelineTimeoutMs > 120_000
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("Invalid pipeline observation limits.");
    let pipelines;
    const deadline = Date.now() + pipelineTimeoutMs;
    for (;;) {
      pipelines = await client.pipelines(project, branch);
      if (pipelines.some((pipeline) => ["success", "failed", "canceled", "skipped"].includes(pipeline.status)) || Date.now() >= deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    operations.push("approvals-read", "pipelines-read");
    report = { project: metadata.id, branch, mrIid: mr.iid, commit: commit.id,
      approvalsObserved: approvals !== undefined, pipelineStatuses: pipelines.map((pipeline) => pipeline.status),
      pipelineVerified: pipelines.some((pipeline) => pipeline.status === "success") };
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    if (mr) {
      try { await client.request("PUT", `/projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}`, { state_event: "close" }); operations.push("mr-closed"); }
      catch { cleanupErrors.push("mr-close-failed"); }
    }
    if (created) {
      try { await client.request("DELETE", `/projects/${encodeURIComponent(project)}/repository/branches/${encodeURIComponent(branch)}`); operations.push("branch-deleted"); }
      catch { cleanupErrors.push("branch-delete-failed"); }
    }
    await store.append({ terminal: true, type: "gitlab-smoke", runId: branch, status: failure || cleanupErrors.length ? "failed" : "succeeded", operations, cleanupErrors, ...(report ? { report } : {}) });
    if (cleanupErrors.length) throw new Error(`GitLab smoke cleanup failed: ${cleanupErrors.join(", ")}. Review the dedicated project.`);
  }
  const verification = await verifyReceiptFile(receiptPath, { requireTerminal: true });
  if (!verification.valid) throw new Error("GitLab smoke receipt did not verify.");
  if (failure) throw failure;
  return { ...report, receiptVerified: true, cleaned: true, receiptPath };
}
