import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { loadProject } from "../content/load-project.js";
import { ApprovalPolicy } from "../core/approval-policy.js";
import { Harness } from "../core/harness.js";
import { JsonlReceiptStore } from "../core/receipt-store.js";
import { loadReceiptSigner } from "../core/receipt-signing.js";
import { runCheck } from "../checks/runner.js";
import { CodeGraph } from "../codegraph/codegraph.js";
import { git } from "../git/command.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabPublisher } from "../gitlab/publisher.js";
import { registerConfiguredProviders } from "../providers/register.js";
import { ProviderRouter } from "../providers/router.js";
import { PolicyEngine } from "../policy/engine.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { createSecretResolver } from "../secrets/resolver.js";

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
  metadata = {},
  secretResolver,
} = {}) {
  if (!input) throw new TypeError("A task prompt is required.");
  const repositoryRoot = resolve(root);
  const bootstrapConfig = await loadConfig(join(repositoryRoot, ".etnpilot", "etnpilot.yaml"), env);
  const secrets = secretResolver ?? createSecretResolver({ root: repositoryRoot, config: bootstrapConfig, env });
  const gitLabToken = await secrets.get("gitlab.apiToken", {
    fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
  });
  const useWorktree = worktree ?? (inPlace ? false : bootstrapConfig.workspace?.mode !== "in-place");
  const effectiveCleanupPolicy = cleanupPolicy ?? bootstrapConfig.workspace?.cleanup ?? "never";
  assertCleanupPolicy(effectiveCleanupPolicy);
  if (publish) assertPublishable(useWorktree, bootstrapConfig, gitLabToken);
  const receiptSigner = await loadReceiptSigner({
    root: repositoryRoot,
    config: bootstrapConfig,
    env,
    secretResolver: secrets,
  });
  const runId = createRunId();
  const branch = `etnpilot/run-${runId}`;
  const worktreeManager = new WorktreeManager(repositoryRoot);
  const workspace = useWorktree
    ? await worktreeManager.create({ name: `run-${runId}`, branch, startPoint: bootstrapConfig.git?.baseRef ?? "HEAD" })
    : { name: "in-place", branch: await currentBranch(repositoryRoot), path: repositoryRoot, managed: false };
  if (useWorktree) workspace.managed = true;

  const receiptPath = join(repositoryRoot, ".etnpilot", "state", "runs", `${runId}.jsonl`);
  const receiptStore = new JsonlReceiptStore(receiptPath, { signer: receiptSigner });
  const policy = new PolicyEngine(bootstrapConfig.policy);
  const harness = new Harness({
    approvalPolicy: new ApprovalPolicy(bootstrapConfig.approval, { policy }),
    approvalHandler,
    receiptStore,
    policy,
  });
  const { config } = await loadProject(harness, workspace.path, env);
  await registerConfiguredProviders(harness, config.providers, {
    workingDirectory: workspace.path,
    env,
    secretResolver: secrets,
    factories: providerFactories,
  });
  harness.setProviderRouter(new ProviderRouter(harness.providers, config.routing, { policy }));
  const workflow = normalizeWorkflow(config.workflow, agent ?? config.defaultAgent ?? "orchestrator");
  const engine = new WorkflowEngine({
    concurrency: workflow.concurrency,
    failFast: workflow.failFast,
    timeoutMs: workflow.timeoutMs,
    maxSteps: workflow.maxSteps,
    events: harness.events,
  });
  const publisher = publish ? createPublisher(config, gitLabToken, fetchImpl) : undefined;
  const codegraph = createCodegraph(repositoryRoot, config);
  let codegraphBefore;
  if (codegraph) {
    try {
      codegraphBefore = await codegraph.graph.indexDirectory(workspace.path);
      harness.instructions.push([
        "ETNPilot code intelligence is available through the embedded code graph.",
        `Database: ${codegraph.database}`,
        "Use dependency, dependent, symbol, and impact queries before broad edits.",
      ].join("\n"));
    } catch (error) {
      codegraph.graph.close();
      throw error;
    }
  }
  const startedAt = Date.now();
  let summary;
  try {
    summary = await engine.run(workflow.steps, async (step, execution) => {
      if (step.type === "agent") {
        return harness.run({
          agent: step.agent,
          input: composeAgentInput(input, execution.dependencyResults),
          metadata: { ...metadata, workflowRunId: runId, workflowStep: step.id, workspace: workspace.path },
        });
      }
      if (step.type === "check") {
        return runCheck(step, { cwd: workspace.path, signal: execution.signal, env });
      }
      throw new Error(`Unsupported workflow step type: '${step.type}'.`);
    }, { signal, context: { runId, workspace } });
  } catch (error) {
    summary = error.workflow ?? { status: "failed", error: error.message };
    const receiptHash = await receiptStore.append({
      type: "workflow",
      terminal: true,
      runId,
      status: "failed",
      durationMs: Date.now() - startedAt,
      workspace,
      summary,
    });
    codegraph?.graph.close();
    error.run = {
      runId,
      workspace,
      receiptPath,
      receiptHash,
      receiptProof: receiptSigner ? {
        algorithm: receiptSigner.algorithm,
        keyId: receiptSigner.keyId,
      } : undefined,
      summary,
    };
    throw error;
  }

  const gitEvidence = await collectGitEvidence(workspace.path);
  let codegraphEvidence;
  if (codegraph) {
    try {
      const update = await codegraph.graph.indexDirectory(workspace.path);
      const sourceChanges = gitEvidence.changedPaths.filter(isSourcePath);
      codegraphEvidence = {
        database: codegraph.database,
        before: codegraphBefore,
        after: update,
        impact: sourceChanges.length > 0
          ? codegraph.graph.impact(sourceChanges, { maxDepth: config.codegraph?.maxImpactDepth ?? 20 })
          : { changed: [], files: [], tests: [], maxDepth: config.codegraph?.maxImpactDepth ?? 20 },
      };
    } finally {
      codegraph.graph.close();
    }
  }
  const receiptHash = await receiptStore.append({
    type: "workflow",
    terminal: true,
    runId,
    status: summary.status,
    durationMs: Date.now() - startedAt,
    workspace,
    git: gitEvidence,
    codegraph: codegraphEvidence,
    summary,
  });
  let mergeRequest;
  if (publisher) {
    mergeRequest = await publisher.publish({
      cwd: workspace.path,
      branch,
      targetBranch: config.git?.targetBranch ?? "main",
      title: `ETNPilot: ${firstLine(input)}`,
      description: `Automated ETNPilot run \`${runId}\`. Review the attached evidence before merging.`,
      receipt: receiptHash,
      receiptProof: receiptSigner ? {
        algorithm: receiptSigner.algorithm,
        keyId: receiptSigner.keyId,
      } : undefined,
    });
  }
  const cleanup = await cleanupWorkspace({
    policy: effectiveCleanupPolicy,
    published: Boolean(mergeRequest),
    workspace,
    manager: worktreeManager,
  });
  return {
    runId,
    workspace,
    cleanup,
    receiptPath,
    receiptHash,
    receiptProof: receiptSigner ? {
      algorithm: receiptSigner.algorithm,
      keyId: receiptSigner.keyId,
    } : undefined,
    summary,
    git: gitEvidence,
    codegraph: codegraphEvidence,
    mergeRequest,
  };
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
  const [head, status, diff, changed, staged, untracked] = await Promise.all([
    git(["rev-parse", "HEAD"], { cwd }),
    git(["status", "--short"], { cwd }),
    git(["diff", "--stat"], { cwd }),
    git(["diff", "--name-only", "HEAD", "--"], { cwd }),
    git(["diff", "--cached", "--name-only", "--"], { cwd }),
    git(["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  const changedPaths = [...new Set(
    [changed.stdout, staged.stdout, untracked.stdout]
      .flatMap((value) => value.split("\n"))
      .filter(Boolean)
      .map((path) => path.replaceAll("\\", "/")),
  )].sort();
  return { head: head.stdout, status: status.stdout, diffStat: diff.stdout, changedPaths };
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

function assertPublishable(useWorktree, config, token) {
  if (!useWorktree) throw new Error("Publishing an in-place run is not allowed.");
  if (!config.git?.project) throw new Error("Publishing requires 'git.project' in .etnpilot/etnpilot.yaml.");
  if (!token) throw new Error("A GitLab API token is required for GitLab publishing.");
}

function createPublisher(config, token, fetchImpl) {
  return new GitLabPublisher({
    baseUrl: config.git?.baseUrl,
    project: config.git?.project,
    remote: config.git?.remote ?? "gitlab",
    token,
    fetchImpl,
  });
}

function createCodegraph(repositoryRoot, config) {
  if (config.codegraph?.enabled === false || config.codegraph?.autoIndex === false) return null;
  const database = resolve(repositoryRoot, config.codegraph?.database ?? ".etnpilot/state/codegraph.sqlite");
  return { database, graph: new CodeGraph(database) };
}

function isSourcePath(path) {
  return /\.(cjs|js|jsx|mjs|ts|tsx)$/i.test(path);
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
