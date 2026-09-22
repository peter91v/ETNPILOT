import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { loadProject } from "../content/load-project.js";
import { ApprovalPolicy } from "../core/approval-policy.js";
import { Harness } from "../core/harness.js";
import { JsonlReceiptStore } from "../core/receipt-store.js";
import { runCheck } from "../checks/runner.js";
import { git } from "../git/command.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabPublisher } from "../gitlab/publisher.js";
import { registerConfiguredProviders } from "../providers/register.js";
import { WorkflowEngine } from "../workflow/engine.js";

export async function runProject({
  root = process.cwd(),
  input,
  agent,
  worktree,
  inPlace = false,
  cleanupPolicy,
  publish = false,
  env = process.env,
  providerFactories,
  fetchImpl,
  approvalHandler,
  signal,
} = {}) {
  if (!input) throw new TypeError("A task prompt is required.");
  const repositoryRoot = resolve(root);
  const bootstrapConfig = await loadConfig(join(repositoryRoot, ".etnpilot", "etnpilot.yaml"), env);
  const useWorktree = worktree ?? (inPlace ? false : bootstrapConfig.workspace?.mode !== "in-place");
  const effectiveCleanupPolicy = cleanupPolicy ?? bootstrapConfig.workspace?.cleanup ?? "never";
  assertCleanupPolicy(effectiveCleanupPolicy);
  const runId = createRunId();
  const branch = `etnpilot/run-${runId}`;
  const worktreeManager = new WorktreeManager(repositoryRoot);
  const workspace = useWorktree
    ? await worktreeManager.create({ name: `run-${runId}`, branch, startPoint: bootstrapConfig.git?.baseRef ?? "HEAD" })
    : { name: "in-place", branch: await currentBranch(repositoryRoot), path: repositoryRoot, managed: false };
  if (useWorktree) workspace.managed = true;

  const receiptPath = join(repositoryRoot, ".etnpilot", "state", "runs", `${runId}.jsonl`);
  const receiptStore = new JsonlReceiptStore(receiptPath);
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(bootstrapConfig.approval),
    approvalHandler,
    receiptStore,
  });
  const { config } = await loadProject(harness, workspace.path);
  registerConfiguredProviders(harness, config.providers, {
    workingDirectory: workspace.path,
    env,
    factories: providerFactories,
  });

  const workflow = normalizeWorkflow(config.workflow, agent ?? config.defaultAgent ?? "orchestrator");
  const engine = new WorkflowEngine({
    concurrency: workflow.concurrency,
    failFast: workflow.failFast,
    timeoutMs: workflow.timeoutMs,
    maxSteps: workflow.maxSteps,
    events: harness.events,
  });
  const startedAt = Date.now();
  let summary;
  try {
    summary = await engine.run(workflow.steps, async (step, execution) => {
      if (step.type === "agent") {
        return harness.run({
          agent: step.agent,
          input: composeAgentInput(input, execution.dependencyResults),
          metadata: { workflowRunId: runId, workflowStep: step.id, workspace: workspace.path },
        });
      }
      if (step.type === "check") {
        return runCheck(step, { cwd: workspace.path, signal: execution.signal, env });
      }
      throw new Error(`Unsupported workflow step type: '${step.type}'.`);
    }, { signal, context: { runId, workspace } });
  } catch (error) {
    summary = error.workflow ?? { status: "failed", error: error.message };
    await receiptStore.append({
      type: "workflow",
      runId,
      status: "failed",
      durationMs: Date.now() - startedAt,
      workspace,
      summary,
    });
    error.run = { runId, workspace, receiptPath, summary };
    throw error;
  }

  const gitEvidence = await collectGitEvidence(workspace.path);
  const receiptHash = await receiptStore.append({
    type: "workflow",
    runId,
    status: summary.status,
    durationMs: Date.now() - startedAt,
    workspace,
    git: gitEvidence,
    summary,
  });
  let mergeRequest;
  if (publish) {
    if (!useWorktree) throw new Error("Publishing an in-place run is not allowed.");
    const publisher = new GitLabPublisher({
      baseUrl: config.git?.baseUrl,
      project: config.git?.project,
      remote: config.git?.remote ?? "gitlab",
      token: env.ETNPILOT_GITLAB_TOKEN,
      fetchImpl,
    });
    mergeRequest = await publisher.publish({
      cwd: workspace.path,
      branch,
      targetBranch: config.git?.targetBranch ?? "main",
      title: `ETNPilot: ${firstLine(input)}`,
      description: `Automated ETNPilot run \`${runId}\`. Review the attached evidence before merging.`,
      receipt: receiptHash,
    });
  }
  const cleanup = await cleanupWorkspace({
    policy: effectiveCleanupPolicy,
    published: Boolean(mergeRequest),
    workspace,
    manager: worktreeManager,
  });
  return { runId, workspace, cleanup, receiptPath, receiptHash, summary, git: gitEvidence, mergeRequest };
}

function normalizeWorkflow(workflow = {}, defaultAgent) {
  const steps = workflow.steps?.length
    ? workflow.steps
    : [{ id: "agent", type: "agent", agent: defaultAgent }];
  return {
    concurrency: workflow.concurrency ?? 1,
    failFast: workflow.failFast ?? true,
    timeoutMs: workflow.timeoutMs ?? 30 * 60_000,
    maxSteps: workflow.maxSteps ?? 50,
    steps,
  };
}

function composeAgentInput(input, dependencies) {
  if (Object.keys(dependencies).length === 0) return String(input);
  const evidence = Object.entries(dependencies).map(([id, result]) => {
    const payload = result?.result ?? result;
    return `### ${id}\n${JSON.stringify(payload, null, 2)}`;
  }).join("\n\n");
  return `${input}\n\nDependency results:\n\n${evidence}`;
}

async function collectGitEvidence(cwd) {
  const [head, status, diff] = await Promise.all([
    git(["rev-parse", "HEAD"], { cwd }),
    git(["status", "--short"], { cwd }),
    git(["diff", "--stat"], { cwd }),
  ]);
  return { head: head.stdout, status: status.stdout, diffStat: diff.stdout };
}

async function currentBranch(cwd) {
  return (await git(["branch", "--show-current"], { cwd })).stdout;
}

function createRunId() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function firstLine(value) {
  return String(value).split("\n", 1)[0].slice(0, 72);
}

function assertCleanupPolicy(policy) {
  if (!["never", "on-success", "after-publish"].includes(policy)) {
    throw new Error(`Unsupported workspace cleanup policy: '${policy}'.`);
  }
}

async function cleanupWorkspace({ policy, published, workspace, manager }) {
  if (!workspace.managed) return { requested: false, removed: false, reason: "in-place-run" };
  const requested = policy === "on-success" || (policy === "after-publish" && published);
  if (!requested) return { requested: false, removed: false, reason: "retained-by-policy" };
  return { requested: true, ...await manager.removeIfClean(workspace.name) };
}
